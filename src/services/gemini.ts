import { ExpenseData, GeminiApiResponse, GeminiListModelsResponse, GeminiPayload } from "../types";
import {
  CONFIG_KEY_ACTIVE_MODEL,
  CONFIG_KEY_DISCOVERED_MODELS,
  CONFIG_KEY_LAST_SYNCED,
  DEFAULT_GEMINI_MODEL,
  FALLBACK_GEMINI_MODELS,
  GEMINI_MODELS,
  GEMINI_EXPENSE_SCHEMA,
  SYSTEM_PROMPT,
} from "../constants";
import { getConfig, setConfig } from "./db";

/**
 * Queries Google Gemini v1beta/models API to discover all currently supported text/vision generation models.
 * Filters out embedding or non-generation models and strips the "models/" prefix.
 */
export async function fetchAvailableGeminiModels(apiKey: string): Promise<string[]> {
  if (!apiKey || !apiKey.trim()) {
    return [];
  }

  const url = `https://generativelanguage.googleapis.com/v1beta/models?key=${apiKey.trim()}`;
  const res = await fetch(url);
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
      const isNotEmbedding = !name.includes("embedding") && !name.includes("aqa");
      return isGenerate && isGemini && isNotEmbedding;
    })
    .map((m) => m.name.replace(/^models\//, ""))
    .sort((a, b) => {
      // Prioritize flash models, then version number descending
      const aIsFlash = a.includes("flash") ? 1 : 0;
      const bIsFlash = b.includes("flash") ? 1 : 0;
      if (aIsFlash !== bIsFlash) return bIsFlash - aIsFlash;
      return b.localeCompare(a, undefined, { numeric: true });
    });

  return validModels;
}

/**
 * Synchronizes discovered models from Google Gemini API and stores them in D1 app_config.
 * Also ensures an active model is set.
 */
export async function syncAvailableGeminiModels(
  apiKey: string,
  db: D1Database
): Promise<{ activeModel: string; models: string[] }> {
  const discovered = await fetchAvailableGeminiModels(apiKey);
  const models = discovered.length > 0 ? discovered : [...FALLBACK_GEMINI_MODELS];

  await setConfig(db, CONFIG_KEY_DISCOVERED_MODELS, JSON.stringify(models));
  await setConfig(db, CONFIG_KEY_LAST_SYNCED, new Date().toISOString());

  let activeModel = await getConfig(db, CONFIG_KEY_ACTIVE_MODEL);
  if (!activeModel || !models.includes(activeModel)) {
    // Select the first recommended flash model or fallback default
    activeModel = models[0] || DEFAULT_GEMINI_MODEL;
    await setConfig(db, CONFIG_KEY_ACTIVE_MODEL, activeModel);
  }

  return { activeModel, models };
}

/**
 * Builds the prioritized model sequence for request execution:
 * 1. Active configured model (from D1 or DEFAULT_GEMINI_MODEL)
 * 2. Cached discovered models
 * 3. Fallback hardcoded models
 */
export async function resolveGeminiModelSequence(
  apiKey: string,
  db?: D1Database
): Promise<string[]> {
  const sequence: string[] = [];

  if (db) {
    const active = await getConfig(db, CONFIG_KEY_ACTIVE_MODEL);
    if (active) {
      sequence.push(active);
    }

    const cachedRaw = await getConfig(db, CONFIG_KEY_DISCOVERED_MODELS);
    if (cachedRaw) {
      try {
        const cached = JSON.parse(cachedRaw) as string[];
        if (Array.isArray(cached)) {
          sequence.push(...cached);
        }
      } catch {}
    }
  }

  sequence.push(DEFAULT_GEMINI_MODEL);
  sequence.push(...GEMINI_MODELS);

  // Return unique ordered models
  return Array.from(new Set(sequence));
}

/**
 * Sends message text or image payload to Google Gemini API to parse financial transaction details.
 * Dynamically resolves model sequence and automatically falls back if primary models are busy or deprecated.
 */
export async function parseWithGemini(
  payload: GeminiPayload,
  apiKey: string,
  db?: D1Database
): Promise<ExpenseData> {
  if (!apiKey || !apiKey.trim()) {
    return { error: "Missing GEMINI_API_KEY" };
  }
  if (!payload || !Array.isArray(payload.contents) || payload.contents.length === 0) {
    return { error: "Invalid payload provided" };
  }

  const modelSequence = await resolveGeminiModelSequence(apiKey, db);
  let lastError = "";

  for (const model of modelSequence) {
    try {
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          generationConfig: {
            response_mime_type: "application/json",
            response_schema: GEMINI_EXPENSE_SCHEMA,
            temperature: 0.1,
          },
          ...payload,
        }),
      });

      if (!res) {
        continue;
      }
      const data = (await res.json()) as GeminiApiResponse;

      if (res.status === 503 || res.status === 429) {
        lastError = data.error?.message || "Server busy";
        continue;
      }

      if (res.status === 404) {
        lastError = `Model ${model} not found`;
        continue;
      }

      if (!res.ok || data.error) {
        lastError = data.error?.message || "Unknown error";
        continue;
      }

      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) {
        continue;
      }

      const cleanJson = rawText.replace(/```json/g, "").replace(/```/g, "").trim();
      const parsed: unknown = JSON.parse(cleanJson);
      if (!parsed || typeof parsed !== "object" || Array.isArray(parsed)) {
        continue;
      }

      const expenseData = parsed as ExpenseData;
      if (expenseData.amount !== undefined) {
        const num = Number(expenseData.amount);
        if (Number.isFinite(num)) {
          expenseData.amount = Math.abs(num);
        } else {
          delete expenseData.amount;
        }
      }
      return expenseData;
    } catch (err: unknown) {
      lastError = err instanceof Error ? err.message : String(err);
    }
  }

  return { error: `AI service unavailable: ${lastError}` };
}
