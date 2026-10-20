/**
 * System Instruction for Google Gemini AI:
 * - Acts as a personal finance assistant.
 * - Extracts amount as a positive numeric value.
 * - Categorizes transactions into one of the allowed categories.
 * - Detects refund/cancellation vs expense transactions.
 * - Returns error: "cannot_parse" if the input is not a financial transaction.
 */
export const SYSTEM_PROMPT = `
You are a personal finance assistant. Your task is to extract transaction data from user messages or receipt images.
Strictly return data adhering to the JSON schema.
- amount: Transaction amount, always a positive number (e.g., 45k -> 45000, 15.5 -> 15.5).
- category: Choose exactly 1 from: "Food & Dining", "Shopping", "Transportation", "Bills & Utilities", "Entertainment", "Health", "Education", "Other".
- transaction_type: Return "refund" if the content indicates a refund, cashback, or order cancellation. Otherwise, default to "expense".
- payment_method: Return "credit_card" if the user mentions paying by credit card, visa, mastercard, card, credit, "quẹt thẻ", "thẻ tín dụng", "thẻ visa", "trả thẻ", "cà thẻ". Otherwise, default to "cash".
- If the content is not an expense or refund, return error: "cannot_parse".
`;

/**
 * Model priority sequence for Gemini requests:
 * 1. gemini-3.8-flash: Primary high-speed vision/text model.
 * 2. gemini-3.5-flash: Automatic fallback model when primary is overloaded (503/429).
 */
export const DEFAULT_GEMINI_MODEL = "gemini-3.8-flash";
export const GEMINI_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash"] as const;
export const FALLBACK_GEMINI_MODELS = ["gemini-3.8-flash", "gemini-3.5-flash", "gemini-2.5-flash", "gemini-1.5-flash"] as const;

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
export const GEMINI_EXPENSE_SCHEMA = {
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
    error: { type: "STRING" },
  },
  required: ["amount", "category", "description", "transaction_type", "payment_method"],
} as const;
