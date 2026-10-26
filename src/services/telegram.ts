import { stripHtml } from "../formatters";
import { InlineKeyboard, TelegramGetFileResponse } from "../types";

const API_BASE = "https://api.telegram.org";

/**
 * Calls a Telegram Bot API method with a JSON body. Never throws: network errors are logged.
 * Returns the HTTP response (or null on network failure) so callers can inspect failures.
 */
async function callTelegram(token: string, method: string, body: Record<string, unknown>): Promise<Response | null> {
  try {
    return await fetch(`${API_BASE}/bot${token}/${method}`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
    });
  } catch (err: unknown) {
    console.error(`Telegram ${method} failed:`, err);
    return null;
  }
}

/** True when Telegram rejected the request because the HTML could not be parsed. */
async function isParseError(res: Response | null): Promise<boolean> {
  if (!res || res.ok || res.status !== 400) return false;
  const errText = await res.text();
  return errText.toLowerCase().includes("parse");
}

/**
 * Sends a message to a Telegram chat via Telegram Bot API with HTML parse mode.
 * Dynamic content must be escaped with `escapeHtml` by the caller.
 *
 * @param token Telegram Bot Token.
 * @param chatId Destination chat identifier.
 * @param text HTML formatted message body.
 * @param replyMarkup Optional inline keyboard shown under the message.
 */
export async function sendTelegram(
  token: string,
  chatId: number,
  text: string,
  replyMarkup?: InlineKeyboard
): Promise<void> {
  if (!token || !token.trim() || !chatId || !text) {
    return;
  }

  const res = await callTelegram(token, "sendMessage", {
    chat_id: chatId,
    text,
    parse_mode: "HTML",
    ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
  });

  // Fallback: if HTML parsing fails, retry as plain text so the user still gets the message
  if (await isParseError(res)) {
    await callTelegram(token, "sendMessage", {
      chat_id: chatId,
      text: stripHtml(text),
      ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
    });
  }
}

/**
 * Replaces the text (and keyboard) of an existing bot message, e.g. after a button press.
 * Omitting `replyMarkup` removes the keyboard.
 */
export async function editTelegramMessage(
  token: string,
  chatId: number,
  messageId: number,
  text: string,
  replyMarkup?: InlineKeyboard
): Promise<void> {
  if (!token || !chatId || !messageId || !text) return;

  const markup = replyMarkup ?? { inline_keyboard: [] };
  const res = await callTelegram(token, "editMessageText", {
    chat_id: chatId,
    message_id: messageId,
    text,
    parse_mode: "HTML",
    reply_markup: markup,
  });

  if (await isParseError(res)) {
    await callTelegram(token, "editMessageText", {
      chat_id: chatId,
      message_id: messageId,
      text: stripHtml(text),
      reply_markup: markup,
    });
  }
}

/** Replaces only the inline keyboard of an existing message. */
export async function editTelegramKeyboard(
  token: string,
  chatId: number,
  messageId: number,
  replyMarkup: InlineKeyboard
): Promise<void> {
  if (!token || !chatId || !messageId) return;
  await callTelegram(token, "editMessageReplyMarkup", {
    chat_id: chatId,
    message_id: messageId,
    reply_markup: replyMarkup,
  });
}

/** Acknowledges a button press (stops the client spinner) with an optional toast text. */
export async function answerCallbackQuery(token: string, callbackQueryId: string, text?: string): Promise<void> {
  if (!token || !callbackQueryId) return;
  await callTelegram(token, "answerCallbackQuery", {
    callback_query_id: callbackQueryId,
    ...(text ? { text } : {}),
  });
}

/** Shows the "typing…" indicator so the user knows the bot is working. */
export async function sendChatAction(token: string, chatId: number, action = "typing"): Promise<void> {
  if (!token || !chatId) return;
  await callTelegram(token, "sendChatAction", { chat_id: chatId, action });
}

/** Registers the command list shown in Telegram's "/" menu. */
export async function setTelegramCommands(
  token: string,
  commands: Array<{ command: string; description: string }>
): Promise<void> {
  if (!token) return;
  await callTelegram(token, "setMyCommands", { commands });
}

/**
 * Downloads a photo attachment from Telegram CDN and converts it to a Base64 string for Gemini Vision.
 *
 * Two-step workflow:
 * 1. Calls `getFile` endpoint to resolve `file_path`.
 * 2. Fetches binary array buffer from file endpoint and converts bytes to Base64 via `btoa`.
 *
 * @param fileId Telegram file identifier.
 * @param token Telegram Bot Token.
 * @returns Base64 encoded string of the image.
 */
export async function downloadTelegramFileAsBase64(
  fileId: string,
  token: string
): Promise<string> {
  if (!fileId || !token) {
    throw new Error("Missing fileId or token");
  }

  const metaRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  if (!metaRes.ok) {
    throw new Error(`Failed to get file metadata: HTTP ${metaRes.status}`);
  }

  const metaData = (await metaRes.json()) as TelegramGetFileResponse;
  const filePath = metaData.result?.file_path;

  if (!filePath) {
    throw new Error("Failed to get file path from Telegram");
  }

  const fileRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  if (!fileRes.ok) {
    throw new Error(`Failed to download file from Telegram CDN: HTTP ${fileRes.status}`);
  }

  const buffer = await fileRes.arrayBuffer();
  const bytes = new Uint8Array(buffer);

  let binary = "";
  const chunkSize = 8192;
  for (let i = 0; i < bytes.length; i += chunkSize) {
    binary += String.fromCharCode(...bytes.subarray(i, i + chunkSize));
  }

  return btoa(binary);
}
