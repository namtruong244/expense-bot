import { friendlyParseError, MSG, savedText, transactionKeyboard } from "../messages";
import { parseWithGemini } from "../services/gemini";
import { downloadTelegramFileAsBase64, sendChatAction, sendTelegram } from "../services/telegram";
import { Env, GeminiPayload, TelegramMessage, WebhookUpdate } from "../types";
import { handleCallbackQuery } from "./callbacks";
import { handleCommand } from "./commands";
import { buildTransactions, saveTransaction } from "./record";

/** Returns the receipt image attached to a message (photo, or image sent as a file), if any. */
function getImageAttachment(message: TelegramMessage): { fileId: string; mimeType: string } | null {
  if (message.photo && message.photo.length > 0) {
    return { fileId: message.photo[message.photo.length - 1].file_id, mimeType: "image/jpeg" };
  }
  const doc = message.document;
  if (doc && doc.mime_type?.startsWith("image/")) {
    return { fileId: doc.file_id, mimeType: doc.mime_type };
  }
  return null;
}

/**
 * Handles incoming Telegram Bot webhook updates (messages, photos, commands, button presses).
 */
export async function handleTelegramWebhook(
  update: WebhookUpdate,
  env: Env
): Promise<void> {
  if (update.callback_query) {
    await handleCallbackQuery(update.callback_query, env);
    return;
  }

  const message = update.message;
  if (!message || !message.chat) {
    return;
  }

  const chatId = message.chat.id;
  const text = message.text ? message.text.trim() : "";

  if (!env.DB) {
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, MSG.dbMissing);
    return;
  }

  if (text.startsWith("/")) {
    await handleCommand(text, chatId, env);
    return;
  }

  try {
    const image = getImageAttachment(message);
    if (!image && !text) {
      await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, MSG.unsupported);
      return;
    }

    // Show "typing…" while the (slow) AI call runs.
    const typing = sendChatAction(env.TELEGRAM_BOT_TOKEN, chatId);

    let aiPayload: GeminiPayload;
    if (image) {
      try {
        const base64Image = await downloadTelegramFileAsBase64(image.fileId, env.TELEGRAM_BOT_TOKEN);
        aiPayload = {
          contents: [
            {
              parts: [
                { text: message.caption || "Extract this receipt into expense/refund JSON." },
                { inline_data: { mime_type: image.mimeType, data: base64Image } },
              ],
            },
          ],
        };
      } catch (photoErr: unknown) {
        console.error("Failed to download Telegram photo:", photoErr);
        await typing;
        await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, MSG.photoFailed);
        return;
      }
    } else {
      aiPayload = { contents: [{ parts: [{ text }] }] };
    }

    const [, expense] = await Promise.all([typing, parseWithGemini(aiPayload, env.GEMINI_API_KEY, env.DB)]);

    if (expense.error) {
      console.error("Gemini parse error:", expense.error);
      await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, friendlyParseError(expense.error));
      return;
    }

    const transactions = buildTransactions(expense);
    if (transactions.length === 0) {
      await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, MSG.noAmount);
      return;
    }

    for (const tx of transactions) {
      let id: number;
      try {
        id = await saveTransaction(env.DB, chatId.toString(), tx);
      } catch (dbErr: unknown) {
        console.error("Failed to insert expense into D1:", dbErr);
        await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, MSG.saveFailed);
        return;
      }
      await sendTelegram(
        env.TELEGRAM_BOT_TOKEN,
        chatId,
        savedText(tx, true),
        id > 0 ? transactionKeyboard(id, tx) : undefined
      );
    }
  } catch (err: unknown) {
    console.error("Unhandled error in handleTelegramWebhook:", err);
    await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, MSG.genericError);
  }
}
