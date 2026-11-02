import { ExpenseData, GeminiApiResponse, GeminiListModelsResponse, GeminiPayload } from "../types";
import {
  CONFIG_KEY_ACTIVE_MODEL,
  CONFIG_KEY_DISCOVERED_MODELS,
  CONFIG_KEY_LAST_SYNCED,
  DEFAULT_GEMINI_MODEL,
  FALLBACK_GEMINI_MODEL,
  GEMINI_EXPENSE_SCHEMA,
  GEMINI_MODEL_NAME_PATTERN,
  GEMINI_TIMEOUT_MS,
  MAX_GEMINI_ATTEMPTS,
  SYSTEM_PROMPT,
} from "../constants";
import { localToday } from "../formatters";
import { getConfigs, setConfig } from "./db";

/** Model name fragments that are not usable for text/vision JSON extraction. */
const EXCLUDED_MODEL_PARTS = ["embedding", "aqa", "tts", "image", "live", "audio", "imagen", "veo", "robotics", "computer-use"];

/** Plain base model such as `gemini-3.1-flash` (no preview/lite/dated suffix). */
const BASE_FLASH_PATTERN = /^gemini-\d+(\.\d+)?-flash$/;

/**
 * Queries Google Gemini v1beta/models API to discover all currently supported text/vision generation models.
 * Filters out embedding or non-generation models and strips the "models/" prefix.
 */
export async function fetchAvailableGeminiModels(apiKey: string): Promise<string[]> {
  if (!apiKey || !apiKey.trim()) {
    return [];
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${encodeURIComponent(apiKey.trim())}`;
  const res = await fetch(url, { signal: AbortSignal.timeout(GEMINI_TIMEOUT_MS) });
  if (!res.ok) {
    throw new Error(`Failed to fetch models from Google: HTTP ${res.status}`);
  }

  const data = (await res.json()) as GeminiListModelsResponse;
  const list = data.models || [];

  const validModels = list
    .filter((m) => {
      const methods = m.supportedGenerationMethods || [];
      const isGenerate = methods.includes("generateContent");
      const name = m.name.toLowerCase();
      const isGemini = name.includes("gemini");
      const isUsable = !EXCLUDED_MODEL_PARTS.some((part) => name.includes(part));
      return isGenerate && isGemini && isUsable;
    })
    .map((m) => m.name.replace(/^models\//, ""))
    .sort((a, b) => {
      // Prioritize plain base flash models, then other flash models, then version number descending
      const aIsBase = BASE_FLASH_PATTERN.test(a) ? 1 : 0;
      const bIsBase = BASE_FLASH_PATTERN.test(b) ? 1 : 0;
      if (aIsBase !== bIsBase) return bIsBase - aIsBase;
      const aIsFlash = a.includes("flash") ? 1 : 0;
      const bIsFlash = b.includes("flash") ? 1 : 0;
      if (aIsFlash !== bIsFlash) return bIsFlash - aIsFlash;
      return b.localeCompare(a, undefined, { numeric: true });
    });

  return validModels;
}

/**
 * Returns the cached list of discovered models from D1 (empty if none/invalid).
 */
export async function getDiscoveredModels(db: D1Database): Promise<string[]> {
  const cfg = await getConfigs(db, [CONFIG_KEY_DISCOVERED_MODELS]);
  return parseDiscoveredModels(cfg[CONFIG_KEY_DISCOVERED_MODELS]);
}

function parseDiscoveredModels(raw: string | undefined): string[] {
  if (!raw) return [];
  try {
    const parsed: unknown = JSON.parse(raw);
    return Array.isArray(parsed) ? parsed.filter((m): m is string => typeof m === "string") : [];
  } catch {
    return [];
  }
}

/**
 * Synchronizes discovered models from Google Gemini API and stores them in D1 app_config.
 * With `selectNewest`, the active model is switched to the best discovered model; otherwise it
 * is only changed when the current one is unset or no longer available.
 * Throws if Google returns no compatible models.
 */
export async function syncAvailableGeminiModels(
  apiKey: string,
  db: D1Database,
  selectNewest = false
): Promise<{ activeModel: string; models: string[] }> {
  const models = await fetchAvailableGeminiModels(apiKey);
  if (models.length === 0) {
    throw new Error("Google returned no compatible Gemini models (check GEMINI_API_KEY).");
  }

  await setConfig(db, CONFIG_KEY_DISCOVERED_MODELS, JSON.stringify(models));
  await setConfig(db, CONFIG_KEY_LAST_SYNCED, new Date().toISOString());

  const cfg = await getConfigs(db, [CONFIG_KEY_ACTIVE_MODEL]);
  let activeModel = cfg[CONFIG_KEY_ACTIVE_MODEL];
  if (selectNewest || !activeModel || !models.includes(activeModel)) {
    activeModel = models[0];
    await setConfig(db, CONFIG_KEY_ACTIVE_MODEL, activeModel);
  }

  return { activeModel, models };
}

/**
 * Builds the model sequence for request execution (at most MAX_GEMINI_ATTEMPTS):
 * active configured model (if any), DEFAULT_GEMINI_MODEL, FALLBACK_GEMINI_MODEL.
 */
export async function resolveGeminiModelSequence(db?: D1Database): Promise<string[]> {
  const sequence: string[] = [];

  if (db) {
    const cfg = await getConfigs(db, [CONFIG_KEY_ACTIVE_MODEL]);
    const active = cfg[CONFIG_KEY_ACTIVE_MODEL];
    if (active && GEMINI_MODEL_NAME_PATTERN.test(active)) {
      sequence.push(active);
    }
  }

  sequence.push(DEFAULT_GEMINI_MODEL, FALLBACK_GEMINI_MODEL);

  return Array.from(new Set(sequence)).slice(0, MAX_GEMINI_ATTEMPTS);
}

/** Coerces `amount` to a positive finite number, or removes it when it is not numeric. */
function normalizeAmount(data: ExpenseData): void {
  if (data.amount === undefined) return;
  const num = Number(data.amount);
  if (Number.isFinite(num)) {
    data.amount = Math.abs(num);
  } else {
    delete data.amount;
  }
}

/**
 * Sends message text or image payload to Google Gemini API to parse financial transaction details.
 * Dynamically resolves model sequence and automatically falls back if primary models are busy or deprecated.
 * All attempts share one `timeoutMs` budget so the caller always gets an answer in time to reply.
 * Each attempt gets 60% of the time left (the last one gets all of it), so one hanging model cannot starve the fallbacks.
 * Errors start with "AI configuration error" for account problems (bad API key, billing, region): retrying never helps.
 * They start with "AI request rejected" when nothing failed for a transient reason and every model that answered
 * refused the input itself (HTTP 400 INVALID_ARGUMENT, e.g. an unreadable image), provided at least two answered
 * or the payload has an image (one model's refusal of a picture is enough; text needs a second opinion).
 * Anything else, including missing models, is "AI service unavailable".
 */
export async function parseWithGemini(
  payload: GeminiPayload,
  apiKey: string,
  db?: D1Database,
  timeoutMs: number = GEMINI_TIMEOUT_MS
): Promise<ExpenseData> {
  if (!apiKey || !apiKey.trim()) {
    return { error: "Missing GEMINI_API_KEY" };
  }
  if (!payload || !Array.isArray(payload.contents) || payload.contents.length === 0) {
    return { error: "Invalid payload provided" };
  }

  const deadline = Date.now() + timeoutMs;
  const modelSequence = await resolveGeminiModelSequence(db);
  let lastError = "";
  let rejectionError = "";
  let rejections = 0;
  // Models that answered at all (anything but 404), so a misconfigured model list is not blamed on the input.
  let answered = 0;
  // Busy, timed out, network error…: retrying later might work, so the input is not to blame.
  let transientFailure = false;
  const hasImage = payload.contents.some((c) => c.parts?.some((p) => "inline_data" in p));

  for (const [index, model] of modelSequence.entries()) {
    const remainingMs = deadline - Date.now();
    if (remainingMs <= 0) {
      lastError = `Timed out after ${timeoutMs} ms${lastError ? ` (${lastError})` : ""}`;
      transientFailure = true;
      break;
    }

    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${encodeURIComponent(apiKey.trim())}`;

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: {
            parts: [{ text: `${SYSTEM_PROMPT}\nToday's date (UTC+7) is ${localToday()}.` }],
          },
          generationConfig: {
            response_mime_type: "application/json",
            response_schema: GEMINI_EXPENSE_SCHEMA,
            temperature: 0.1,
          },
          ...payload,
        }),
        signal: AbortSignal.timeout(index < modelSequence.length - 1 ? Math.ceil(remainingMs * 0.6) : remainingMs),
      });

      const data = (await res.json().catch(() => ({}))) as GeminiApiResponse;
      if (res.status !== 404) answered++;

      const isAccountProblem =
        res.status === 400 &&
        (data.error?.status === "FAILED_PRECONDITION" || /api key/i.test(data.error?.message || ""));
      if (res.status === 401 || res.status === 403 || isAccountProblem) {
        // Credentials, billing or region problem: other models will fail the same way.
        return { error: `AI configuration error: ${data.error?.message || `Access denied (HTTP ${res.status})`}` };
      }

      if (res.status === 400) {
        // The input itself was refused (bad image, too large…); still try the other models in case
        // only the configured one dislikes the request.
        lastError = data.error?.message || "Bad request";
        if (data.error?.status === "INVALID_ARGUMENT") {
          rejectionError = lastError;
          rejections++;
        }
        continue;
      }

      if (res.status === 503 || res.status === 429) {
        lastError = data.error?.message || "Server busy";
        transientFailure = true;
        continue;
      }

      if (res.status === 404) {
        lastError = `Model ${model} not found`;
        continue;
      }

      if (!res.ok || data.error) {
        lastError = data.error?.message || `HTTP ${res.status}`;
        transientFailure = true;
        continue;
      }

      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) {
        transientFailure = true;
        continue;
      }

      const cleanJson = rawText.replace(/```json/g, "").replace(/```/g, "").trim();
      const parsed: unknown = JSON.parse(cleanJson);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        transientFailure = true;
        continue;
      }

      const expenseData = parsed as ExpenseData;
      normalizeAmount(expenseData);
      if (Array.isArray(expenseData.transactions)) {
        expenseData.transactions = expenseData.transactions.filter(
          (t): t is ExpenseData => !!t && typeof t === "object" && !Array.isArray(t)
        );
        expenseData.transactions.forEach(normalizeAmount);
      }
      return expenseData;
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
      transientFailure = true;
    }
  }

  if (!transientFailure && (answered >= 2 || (hasImage && answered >= 1)) && rejections === answered) {
    return { error: `AI request rejected: ${rejectionError}` };
  }
  return { error: `AI service unavailable: ${lastError}` };
}
