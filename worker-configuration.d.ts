// Generated manually to bypass workerd EPIPE
interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  GEMINI_API_KEY: string;
}

declare namespace Cloudflare {
  interface Env {
    DB: D1Database;
    TELEGRAM_BOT_TOKEN: string;
    GEMINI_API_KEY: string;
  }
}
