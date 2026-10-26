import { DEFAULT_USER_ID } from "../constants";
import { stripHtml } from "../formatters";
import { friendlyParseError, MSG, savedText } from "../messages";
import { parseWithGemini } from "../services/gemini";
import { Env, GeminiPayload, WebhookUpdate } from "../types";
import { buildTransactions, saveTransaction } from "./record";

function reply(message: string, status = 200): Response {
  return new Response(message, { status });
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
 * Without `user_id`, records are stored under SHORTCUT_USER_ID, then ADMIN_CHAT_ID, so they show up
 * in the same /today, /month and /debt reports as Telegram messages.
 */
export async function handleShortcut(
  update: WebhookUpdate,
  env: Env
): Promise<Response> {
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
      const status = expense.error === "cannot_parse" ? 422 : expense.error.startsWith("AI service") ? 503 : 500;
      return reply(`⚠️ ${stripHtml(friendlyParseError(expense.error))}`, status);
    }

    const transactions = buildTransactions(expense, update.payment_method === "credit_card");
    if (transactions.length === 0) {
      return reply(`⚠️ ${stripHtml(MSG.noAmount)}`, 422);
    }

    const userId =
      (update.user_id || "").trim() ||
      (env.SHORTCUT_USER_ID || "").trim() ||
      (env.ADMIN_CHAT_ID || "").trim() ||
      DEFAULT_USER_ID;

    const lines: string[] = [];
    for (const tx of transactions) {
      await saveTransaction(env.DB, userId, tx);
      lines.push(savedText(tx, false));
    }
    return reply(lines.join("\n\n"));
  } catch (err: unknown) {
    console.error("Shortcut handler error:", err);
    return reply(`⚠️ ${stripHtml(MSG.genericError)}`, 500);
  }
}
