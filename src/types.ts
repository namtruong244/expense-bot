/**
 * Environment bindings and secrets passed to the Worker.
 */
export interface Env {
  /** Cloudflare D1 Database storing expense records */
  DB: D1Database;
  /** Telegram Bot Token from BotFather */
  TELEGRAM_BOT_TOKEN: string;
  /** Google Gemini API key */
  GEMINI_API_KEY: string;
}

/** Transaction classification: regular expense or refund/cancellation */
export type TransactionType = "expense" | "refund" | "chi_tieu" | "hoan_tien";

/** Payment method used for the transaction */
export type PaymentMethod = "cash" | "credit_card";
/** Extracted transaction data returned by Gemini */
export interface ExpenseData {
  /** Transaction amount */
  amount?: number;
  /** Expense category (e.g., Food & Dining, Shopping, Transport, etc.) */
  category?: string;
  /** Detailed description of the transaction */
  description?: string;
  /** Transaction type: "expense" or "refund" */
  transaction_type?: string;
  /** Payment method: "cash" or "credit_card" */
  payment_method?: string;
  /** Error code or message if parsing fails */
  error?: string;
}

/** Telegram photo resolution item */
export interface TelegramPhotoSize {
  file_id: string;
  width?: number;
  height?: number;
  file_size?: number;
}

/** Telegram chat entity */
export interface TelegramChat {
  id: number;
  type?: string;
  title?: string;
  username?: string;
}

/** Telegram message entity from webhook payload */
export interface TelegramMessage {
  message_id?: number;
  chat?: TelegramChat;
  text?: string;
  caption?: string;
  photo?: TelegramPhotoSize[];
}

/**
 * Unified incoming webhook payload:
 * - Apple Shortcut: contains source: "shortcut", text, and optional user_id.
 * - Telegram Webhook: contains message object.
 */
export interface WebhookUpdate {
  source?: string;
  text?: string;
  user_id?: string;
  payment_method?: string;
  message?: TelegramMessage;
}

/** Part item for Gemini API content payload (text or base64 image) */
export interface GeminiPart {
  text?: string;
  inline_data?: {
    mime_type: string;
    data: string;
  };
}

/** Gemini content wrapper */
export interface GeminiContent {
  parts: GeminiPart[];
}

/** Complete Gemini generateContent request body */
export interface GeminiPayload {
  contents: GeminiContent[];
}

/** Response structure returned by Google Gemini API */
export interface GeminiApiResponse {
  candidates?: Array<{
    content?: {
      parts?: Array<{
        text?: string;
      }>;
    };
  }>;
  error?: {
    message?: string;
    code?: number;
  };
}

/** Model information item returned by Gemini v1beta/models endpoint */
export interface GeminiModelInfo {
  name: string;
  version?: string;
  displayName?: string;
  description?: string;
  supportedGenerationMethods?: string[];
}

/** Response returned by Google Gemini v1beta/models API */
export interface GeminiListModelsResponse {
  models?: GeminiModelInfo[];
}

/** Configuration key-value pair stored in app_config table */
export interface AppConfigRow {
  key: string;
  value: string;
  updated_at?: string;
}

/** Response structure for Telegram getFile API */
export interface TelegramGetFileResponse {
  ok?: boolean;
  result?: {
    file_id?: string;
    file_path?: string;
  };
}

/** Database row entity in the expenses table */
export interface ExpenseRow {
  id: number;
  user_id: string;
  amount: number;
  category: string;
  description: string;
  payment_method?: string;
  is_paid?: number;
  paid_at?: string;
  created_at?: string;
}

/** Aggregated category expense row */
export interface CategorySummaryRow {
  category: string;
  total_cat: number;
  count: number;
}
