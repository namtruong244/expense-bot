/**
 * ============================================================================
 * EXPENSE BOT - CLOUDFLARE WORKER ENTRY POINT
 * ============================================================================
 *
 * Primary responsibilities:
 * - Route incoming HTTP POST webhooks from:
 *   1. Apple Shortcuts (iOS / macOS Siri Shortcuts)
 *   2. Telegram Bot Webhook (text messages, receipt photos, slash commands)
 * - Extract expense data via Google Gemini AI (Vision & Text).
 * - Store and query records in Cloudflare D1 database.
 */

import { handleShortcut } from "./handlers/shortcut";
import { handleTelegramWebhook } from "./handlers/telegram";
import { claimTelegramUpdate } from "./services/db";
import { Env, WebhookUpdate } from "./types";

export * from "./types";
export * from "./constants";
export * from "./formatters";
export * from "./messages";
export * from "./services/db";
export * from "./services/gemini";
export * from "./services/telegram";
export * from "./handlers/commands";
export * from "./handlers/callbacks";
export * from "./handlers/record";
export * from "./handlers/shortcut";
export * from "./handlers/telegram";

export default {
  /**
   * Main fetch handler for Cloudflare Worker requests.
   *
   * @param request Incoming HTTP request.
   * @param env Worker environment bindings and secrets.
   * @param ctx Execution context; Telegram updates are processed after replying so slow AI calls never time out the webhook.
   */
  async fetch(request: Request, env: Env, ctx?: ExecutionContext): Promise<Response> {
    if (!env) {
      return new Response("Error: Worker environment is unconfigured", { status: 500 });
    }

    if (request.method !== "POST") {
      return new Response("Bot is running!");
    }
    try {
      const rawUpdate: unknown = await request.json();
      const update = (rawUpdate && typeof rawUpdate === "object" ? rawUpdate : {}) as WebhookUpdate;

      if (update.source === "shortcut") {
        return await handleShortcut(update, env);
      }

      // Telegram re-sends an update it believes failed; skip ones already claimed.
      if (typeof update.update_id === "number" && env.DB) {
        const isNew = await claimTelegramUpdate(env.DB, update.update_id).catch((err: unknown) => {
          console.error("Failed to claim Telegram update:", err);
          return true;
        });
        if (!isNew) return new Response("OK");
      }

      const task = handleTelegramWebhook(update, env).catch((err: unknown) => {
        console.error("Worker error:", err);
      });
      if (ctx?.waitUntil) {
        ctx.waitUntil(task);
      } else {
        await task;
      }
    } catch (err: unknown) {
      console.error("Worker error:", err);
    }

    return new Response("OK");
  },
};
