import {
  MAX_IMAGE_BYTES,
  SUPPORTED_IMAGE_MIME_TYPES,
  TELEGRAM_DOWNLOAD_TIMEOUT_MS,
  TELEGRAM_PROCESSING_BUDGET_MS,
} from "../constants";
import { friendlyParseError, MSG, savedText, transactionKeyboard } from "../messages";
import { parseWithGemini } from "../services/gemini";
import { downloadTelegramFileAsBase64, FileTooLargeError, sendChatAction, sendTelegram } from "../services/telegram";
import { Env, GeminiPayload, TelegramMessage, WebhookUpdate } from "../types";
import { handleCallbackQuery } from "./callbacks";
import { handleCommand } from "./commands";
import { buildTransactions, saveTransactions } from "./record";

/**
 * Message fields holding user content the bot cannot read. Messages with none of these and no
 * text or image are service updates (joins, pins, title changes…) and are ignored silently.
 */
const UNREADABLE_CONTENT_FIELDS = [
  "sticker",
  "voice",
  "audio",
  "video",
  "video_note",
  "animation",
  "document",
  "location",
  "venue",
  "contact",
  "poll",
  "dice",
  "game",
  "invoice",
  "story",
  "paid_media",
  "giveaway",
  "checklist",
];

interface ImageAttachment {
  fileId: string;
  mimeType: string;
  fileSize?: number;
}

/** Returns the receipt image attached to a message (photo, or image sent as a file), if any. */
function getImageAttachment(message: TelegramMessage): ImageAttachment | null {
  if (message.photo && message.photo.length > 0) {
    const largest = message.photo[message.photo.length - 1];
    return { fileId: largest.file_id, mimeType: "image/jpeg", fileSize: largest.file_size };
  }
  // GIFs arrive as `animation` with a copy in `document`; they are not receipts.
  const doc = "animation" in message ? undefined : message.document;
  const mimeType = doc?.mime_type?.toLowerCase().replace(/^image\/jpg$/, "image/jpeg");
  if (doc && mimeType?.startsWith("image/")) {
    return { fileId: doc.file_id, mimeType, fileSize: doc.file_size };
  }
  return null;
}

/** Returns the message explaining why Gemini cannot read this image, or null if it can. */
function imageProblem(image: ImageAttachment): string | null {
  if (!SUPPORTED_IMAGE_MIME_TYPES.includes(image.mimeType)) return MSG.imageUnsupported;
  if (image.fileSize && image.fileSize > MAX_IMAGE_BYTES) return MSG.imageTooLarge;
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
  const isPrivate = message.chat.type === "private";
  // Everything below runs in ctx.waitUntil (30 s after the webhook is answered): share one budget
  // between the photo download and Gemini, leaving time to save and reply.
  const deadline = Date.now() + TELEGRAM_PROCESSING_BUDGET_MS;

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
      // Only answer people talking to the bot directly: in groups this would reply to every sticker,
      // and service updates (joins, pins…) carry no content at all.
      const hasUnreadableContent = UNREADABLE_CONTENT_FIELDS.some((field) => field in message);
      if (isPrivate && hasUnreadableContent) {
        await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, MSG.unsupported);
      }
      return;
    }

    const problem = image && imageProblem(image);
    if (problem) {
      // Same rule as above: groups do not get told about every file someone shares.
      if (isPrivate) await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, problem);
      return;
    }

    // Show "typing…" while the (slow) AI call runs.
    const typing = sendChatAction(env.TELEGRAM_BOT_TOKEN, chatId);

    let aiPayload: GeminiPayload;
    if (image) {
      try {
        const base64Image = await downloadTelegramFileAsBase64(
          image.fileId,
          env.TELEGRAM_BOT_TOKEN,
          Math.min(TELEGRAM_DOWNLOAD_TIMEOUT_MS, deadline - Date.now()),
          MAX_IMAGE_BYTES
        );
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
        await typing;
        if (photoErr instanceof FileTooLargeError) {
          // Telegram does not always report file_size up front; same rule as imageProblem: groups stay silent.
          if (isPrivate) await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, MSG.imageTooLarge);
          return;
        }
        console.error("Failed to download Telegram photo:", photoErr);
        await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, MSG.photoFailed);
        return;
      }
    } else {
      aiPayload = { contents: [{ parts: [{ text }] }] };
    }

    const [, expense] = await Promise.all([
      typing,
      parseWithGemini(aiPayload, env.GEMINI_API_KEY, env.DB, deadline - Date.now()),
    ]);

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

    let ids: number[];
    try {
      ids = await saveTransactions(env.DB, chatId.toString(), transactions);
    } catch (dbErr: unknown) {
      // The batch is one transaction, so nothing was stored and resending is safe.
      console.error("Failed to insert expenses into D1:", dbErr);
      await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, MSG.saveFailed);
      return;
    }
    for (const [i, tx] of transactions.entries()) {
      const id = ids[i] ?? 0;
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
