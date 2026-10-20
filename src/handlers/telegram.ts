import { DEFAULT_CATEGORY, DEFAULT_DESCRIPTION } from "../constants";
import { formatCurrency } from "../formatters";
import { insertExpense } from "../services/db";
import { parseWithGemini } from "../services/gemini";
import { downloadTelegramFileAsBase64, sendTelegram } from "../services/telegram";
import { Env, GeminiPayload, WebhookUpdate } from "../types";
import { handleCommand } from "./commands";

/**
 * Handles incoming Telegram Bot webhook updates (messages, photos, commands).
 */
export async function handleTelegramWebhook(
  update: WebhookUpdate,
  env: Env
): Promise<void> {
  const message = update.message;
  if (!message || !message.chat) {
    return;
  }

  const chatId = message.chat.id;
  const text = message.text ? message.text.trim() : "";

  if (!env.DB) {
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, "⚠️ Error: Cloudflare D1 database is not connected.");
    return;
  }

  if (text.startsWith("/")) {
    await handleCommand(text, chatId, env);
    return;
  }

  try {
    let aiPayload: GeminiPayload | null = null;

    if (message.photo && message.photo.length > 0) {
      const photo = message.photo[message.photo.length - 1];
      try {
        const base64Image = await downloadTelegramFileAsBase64(photo.file_id, env.TELEGRAM_BOT_TOKEN);
        aiPayload = {
          contents: [
            {
              parts: [
                { text: message.caption || "Extract this receipt into expense/refund JSON." },
                { inline_data: { mime_type: "image/jpeg", data: base64Image } },
              ],
            },
          ],
        };
      } catch (photoErr: unknown) {
        console.error("Failed to download Telegram photo:", photoErr);
        await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, "⚠️ Failed to download receipt image. Please try sending it again.");
        return;
      }
    } else if (text) {
      aiPayload = {
        contents: [{ parts: [{ text }] }],
      };
    } else {
      return;
    }

    const expense = await parseWithGemini(aiPayload, env.GEMINI_API_KEY, env.DB);

    if (expense.error) {
      await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, `⚠️ Recognition error: ${expense.error}`);
      return;
    }

    if (!expense.amount || !Number.isFinite(expense.amount) || expense.amount <= 0) {
      await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, "⚠️ Could not identify transaction amount.");
      return;
    }

    const isRefund = expense.transaction_type === "refund" || expense.transaction_type === "hoan_tien";
    const isCreditCard = expense.payment_method === "credit_card";
    const paymentMethod = isCreditCard ? "credit_card" : "cash";
    const isPaid = isCreditCard ? 0 : 1;

    const finalAmount = isRefund ? -Math.abs(expense.amount) : Math.abs(expense.amount);
    let actionName = isRefund ? "🟢 Refund (Cost Reduction)" : "🔴 Expense";
    if (isCreditCard && !isRefund) {
      actionName = "💳 Credit Card Expense (Unpaid Debt)";
    }

    const category = (expense.category || "").trim() || DEFAULT_CATEGORY;
    const description = (expense.description || "").trim() || DEFAULT_DESCRIPTION;

    try {
      await insertExpense(env.DB, chatId.toString(), finalAmount, category, description, paymentMethod, isPaid);
    } catch (dbErr: unknown) {
      console.error("Failed to insert expense into D1:", dbErr);
      await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, "⚠️ Failed to save transaction to database. Please try again.");
      return;
    }

    const formatted = formatCurrency(finalAmount);
    const extraNote = isCreditCard && !isRefund ? "\n📌 Use /debt to view unpaid bills, or /pay to settle." : "";
    const reply =
      `✅ **Recorded ${actionName}:**\n` +
      `💰 Amount: ${formatted}\n` +
      `🏷 Category: ${category}\n` +
      `📝 Description: ${description}${extraNote}`;

    await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, reply);
  } catch (err: unknown) {
    console.error("Unhandled error in handleTelegramWebhook:", err);
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, "⚠️ An unexpected error occurred. Please try again later.");
  }
}
