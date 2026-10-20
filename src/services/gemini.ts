import { ExpenseData, GeminiApiResponse, GeminiPayload } from "../types";
import { GEMINI_EXPENSE_SCHEMA, GEMINI_MODELS, SYSTEM_PROMPT } from "../constants";

/**
 * Sends message text or image payload to Google Gemini API to parse financial transaction details.
 *
 * RESILIENCE STRATEGY:
 * 1. Pre-validation: Rejects early if API key is missing.
 * 2. Multi-model fallback:
 *    - Tries models in `GEMINI_MODELS` sequence (3.8 Flash primary -> 3.5 Flash fallback).
 *    - Automatically falls back on 503 (overloaded) or 429 (rate-limited) responses.
 * 3. Structured outputs: Enforces JSON schema through `generationConfig`.
 * 4. Markdown stripping: Cleans ```json code fence wrapper if present before parsing.
 * 5. Comprehensive error catching: Captures network or parsing exceptions and surfaces readable error.
 */
export async function parseWithGemini(
  payload: GeminiPayload,
  apiKey: string
): Promise<ExpenseData> {
  if (!apiKey || !apiKey.trim()) {
    return { error: "Missing GEMINI_API_KEY" };
  }
  if (!payload || !Array.isArray(payload.contents) || payload.contents.length === 0) {
    return { error: "Invalid payload provided" };
  }
  let lastError = "";

  for (const model of GEMINI_MODELS) {
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

      const data = (await res.json()) as GeminiApiResponse;

      if (res.status === 503 || res.status === 429) {
        lastError = data.error?.message || "Server busy";
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
