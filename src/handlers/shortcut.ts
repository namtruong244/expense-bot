import { bearerToken, secretMatches } from "../auth";
import { DEFAULT_USER_ID } from "../constants";
import { stripHtml } from "../formatters";
import { friendlyParseError, MSG, savedText } from "../messages";
import { parseWithGemini } from "../services/gemini";
import { Env, GeminiPayload, WebhookUpdate } from "../types";
import { buildTransactions, saveTransactions } from "./record";

function reply(message: string, status = 200): Response {
  return new Response(message, { status });
}

/** Reads `user_id` as text: a string, or a finite number (some Shortcuts send the chat ID as a number). Null for anything else. */
function normalizeUserId(value: unknown): string | null {
  if (value === undefined || value === null) return "";
  if (typeof value === "string") return value.trim();
  if (typeof value === "number" && Number.isFinite(value)) return String(value);
  return null;
}

/**
 * Handles incoming webhook requests from Apple Shortcuts (iOS / macOS).
 * Replies are plain text; failures use a non-2xx status so the Shortcut can tell them apart.
 *
 * Expected payload:
 * {
 *   "source": "shortcut",
 *   "text": "Lunch 50k",
 *   "user_id": "optional_user_identifier",
 *   "payment_method": "optional: credit_card"
 * }
 *
 * When SHORTCUT_SECRET is set, requests must send `Authorization: Bearer <SHORTCUT_SECRET>`, and records
 * are stored under `user_id`, else SHORTCUT_USER_ID, else ADMIN_CHAT_ID, so they show up in the same
 * /today, /month and /debt reports as Telegram messages. Without a secret the endpoint is public: it only
 * writes to the separate DEFAULT_USER_ID ledger and rejects requests that name a `user_id`.
 */
export async function handleShortcut(
  update: WebhookUpdate,
  env: Env,
  headers: Headers = new Headers()
): Promise<Response> {
  const secret = (env.SHORTCUT_SECRET || "").trim();
  if (secret && !secretMatches(bearerToken(headers), secret)) {
    return reply("⛔ Sai hoặc thiếu mã bí mật của Shortcut.", 401);
  }
  const requestedUserId = normalizeUserId(update.user_id);
  if (requestedUserId === null) {
    return reply("⚠️ user_id phải là chuỗi hoặc số.", 400);
  }
  if (!secret && requestedUserId) {
    return reply("⛔ Cần đặt SHORTCUT_SECRET trên Worker để ghi vào sổ của một user_id.", 401);
  }

  if (!env.DB) {
    return reply("⚠️ Lỗi: chưa kết nối được cơ sở dữ liệu.", 500);
  }

  const text = (update.text || "").trim();
  if (!text) {
    return reply("⚠️ Bạn chưa nhập nội dung giao dịch.", 400);
  }

  try {
    const aiPayload: GeminiPayload = { contents: [{ parts: [{ text }] }] };
    const expense = await parseWithGemini(aiPayload, env.GEMINI_API_KEY, env.DB);

    if (expense.error) {
      console.error("Gemini parse error:", expense.error);
      const status =
        expense.error === "cannot_parse" || expense.error.startsWith("AI request rejected")
          ? 422
          : expense.error.startsWith("AI service")
            ? 503
            : 500; // includes "AI configuration error": the owner has to fix it
      return reply(`⚠️ ${stripHtml(friendlyParseError(expense.error))}`, status);
    }

    const transactions = buildTransactions(expense, update.payment_method === "credit_card");
    if (transactions.length === 0) {
      return reply(`⚠️ ${stripHtml(MSG.noAmount)}`, 422);
    }

    // Only a request that proved it knows the secret may write to the owner's ledger.
    const configuredOwner = (env.SHORTCUT_USER_ID || "").trim() || (env.ADMIN_CHAT_ID || "").trim();
    const userId = secret ? requestedUserId || configuredOwner || DEFAULT_USER_ID : DEFAULT_USER_ID;

    await saveTransactions(env.DB, userId, transactions);
    let replyText = transactions.map((tx) => savedText(tx, false)).join("\n\n");
    if (!secret && configuredOwner) {
      console.warn("Shortcut entries go to DEFAULT_USER_ID until SHORTCUT_SECRET is set.");
      replyText += "\n\nℹ️ Đã lưu vào sổ riêng của Shortcut. Đặt SHORTCUT_SECRET để ghi thẳng vào sổ Telegram của bạn.";
    }
    return reply(replyText);
  } catch (err: unknown) {
    console.error("Shortcut handler error:", err);
    return reply(`⚠️ ${stripHtml(MSG.genericError)}`, 500);
  }
}
