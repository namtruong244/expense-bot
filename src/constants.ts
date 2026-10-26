/**
 * System Instruction for Google Gemini AI:
 * - Acts as a personal finance assistant.
 * - Extracts every transaction mentioned in the input (one message may contain several).
 * - Extracts amount as a positive numeric value.
 * - Categorizes transactions into one of the allowed categories.
 * - Detects refund/cancellation vs expense transactions.
 * - Extracts the transaction date when the user mentions one (the current date is appended per request).
 * - Returns error: "cannot_parse" if the input is not a financial transaction.
 */
export const SYSTEM_PROMPT = `
You are a personal finance assistant. Your task is to extract transaction data from user messages or receipt images.
Strictly return data adhering to the JSON schema. Put every transaction found in the "transactions" array (one item per purchase; "Coffee 30k, lunch 50k" -> 2 items).
- amount: Transaction amount, always a positive number (e.g., 45k -> 45000, 15.5 -> 15.5).
- category: Choose exactly 1 from: "Food & Dining", "Shopping", "Transportation", "Bills & Utilities", "Entertainment", "Health", "Education", "Other".
- description: Short description, written in the same language as the user's message.
- transaction_type: Return "refund" if the content indicates a refund, cashback, or order cancellation. Otherwise, default to "expense".
- payment_method: Return "credit_card" if the user mentions paying by credit card, visa, mastercard, card, credit, "quẹt thẻ", "thẻ tín dụng", "thẻ visa", "trả thẻ", "cà thẻ". Otherwise, default to "cash".
- date: Only when the user or receipt states a date ("yesterday", "hôm qua", "20/10", the receipt date), return it as YYYY-MM-DD. Otherwise omit it.
- If the content is not an expense or refund, return error: "cannot_parse" and an empty transactions array.
`;

/** Expense categories (stored in English; shown to users with CATEGORY_LABELS). */
export const CATEGORIES = [
  "Food & Dining",
  "Shopping",
  "Transportation",
  "Bills & Utilities",
  "Entertainment",
  "Health",
  "Education",
  "Other",
] as const;

/** Vietnamese display names for stored categories. */
export const CATEGORY_LABELS: Record<string, string> = {
  "Food & Dining": "Ăn uống",
  Shopping: "Mua sắm",
  Transportation: "Di chuyển",
  "Bills & Utilities": "Hoá đơn & tiện ích",
  Entertainment: "Giải trí",
  Health: "Sức khoẻ",
  Education: "Giáo dục",
  Other: "Khác",
};

/** Local timezone offset (UTC+7) used for calendar-day reporting. */
export const TZ_OFFSET_HOURS = 7;

/** Maximum number of transactions recorded from a single message. */
export const MAX_TRANSACTIONS_PER_MESSAGE = 10;

/**
 * Model priority sequence for Gemini requests (kept short: every entry is another network call on failure):
 * 1. Active model configured via /model (D1), if any.
 * 2. DEFAULT_GEMINI_MODEL: primary high-speed vision/text model.
 * 3. FALLBACK_GEMINI_MODEL: stable model used when the others are overloaded or unavailable.
 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.1-flash";
export const FALLBACK_GEMINI_MODEL = "gemini-2.5-flash";

/** Maximum number of models tried for a single request. */
export const MAX_GEMINI_ATTEMPTS = 3;

/** Valid Gemini model id (also guarantees it is safe to place in a URL path). */
export const GEMINI_MODEL_NAME_PATTERN = /^gemini-[a-z0-9][a-z0-9._-]{0,63}$/;

export const CONFIG_KEY_ACTIVE_MODEL = "gemini_active_model";
export const CONFIG_KEY_DISCOVERED_MODELS = "gemini_discovered_models";
export const CONFIG_KEY_LAST_SYNCED = "gemini_models_last_synced";

/** Default user ID when request is sent from Apple Shortcut without custom user_id */
export const DEFAULT_USER_ID = "iphone_user";

/** Default category when Gemini does not specify one */
export const DEFAULT_CATEGORY = "Other";

/** Default description when Gemini does not specify one */
export const DEFAULT_DESCRIPTION = "Transaction";

/** Default payment method when unspecified */
export const DEFAULT_PAYMENT_METHOD = "cash";

/**
 * Enforced JSON schema for Gemini structured output.
 */
const TRANSACTION_ITEM_SCHEMA = {
  type: "OBJECT",
  properties: {
    amount: { type: "NUMBER" },
    category: { type: "STRING" },
    description: { type: "STRING" },
    transaction_type: {
      type: "STRING",
      description: "Choose 'refund' for refunds or order cancellations. Choose 'expense' for regular purchases.",
    },
    payment_method: {
      type: "STRING",
      description: "Choose 'credit_card' if paid by credit card or card swipe. Otherwise 'cash'.",
    },
    date: {
      type: "STRING",
      description: "Transaction date as YYYY-MM-DD, only when the input states one.",
    },
  },
  required: ["amount", "category", "description", "transaction_type", "payment_method"],
} as const;

export const GEMINI_EXPENSE_SCHEMA = {
  type: "OBJECT",
  properties: {
    transactions: { type: "ARRAY", items: TRANSACTION_ITEM_SCHEMA },
    error: { type: "STRING" },
  },
} as const;
