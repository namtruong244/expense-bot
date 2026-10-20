import { TelegramGetFileResponse } from "../types";

/**
 * Sends a message to a Telegram chat via Telegram Bot API with Markdown parse mode.
 *
 * @param token Telegram Bot Token.
 * @param chatId Destination chat identifier.
 * @param text Formatted Markdown message body.
 */
export async function sendTelegram(
  token: string,
  chatId: number,
  text: string
): Promise<void> {
  if (!token || !token.trim() || !chatId || !text) {
    return;
  }

  try {
    const res = await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text, parse_mode: "Markdown" }),
    });

    if (!res.ok) {
      const errText = await res.text();
      // Fallback: If Markdown syntax parsing fails, retry with plain text
      if (res.status === 400 && errText.toLowerCase().includes("parse")) {
        await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ chat_id: chatId, text }),
        });
      }
    }
  } catch (err: unknown) {
    console.error("Failed to send Telegram message:", err);
  }
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
