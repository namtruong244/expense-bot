import { DEFAULT_CATEGORY, DEFAULT_DESCRIPTION, DEFAULT_USER_ID } from "../constants";
import { formatCurrency } from "../formatters";
import { insertExpense } from "../services/db";
import { parseWithGemini } from "../services/gemini";
import { Env, GeminiPayload, WebhookUpdate } from "../types";

/**
 * Handles incoming webhook requests from Apple Shortcuts (iOS / macOS).
 *
 * Expected payload:
 * {
 *   "source": "shortcut",
 *   "text": "Lunch 50k",
 *   "user_id": "optional_user_identifier"
 * }
 */
export async function handleShortcut(
  update: WebhookUpdate,
  env: Env
): Promise<Response> {
  if (!env.DB) {
    return new Response("Error: Database not configured");
  }

  const text = (update.text || "").trim();
  if (!text) {
    return new Response("⚠️ Error: Empty transaction text provided.");
  }

  try {
    const aiPayload: GeminiPayload = { contents: [{ parts: [{ text }] }] };
    const expense = await parseWithGemini(aiPayload, env.GEMINI_API_KEY);

    if (expense.error) {
      return new Response(`⚠️ Error: ${expense.error}`);
    }
    if (!expense.amount || !Number.isFinite(expense.amount) || expense.amount <= 0) {
      return new Response("⚠️ Could not identify transaction amount.");
    }

    const isRefund = expense.transaction_type === "refund" || expense.transaction_type === "hoan_tien";
    const isCreditCard = expense.payment_method === "credit_card" || update.payment_method === "credit_card";
    const paymentMethod = isCreditCard ? "credit_card" : "cash";
    const isPaid = isCreditCard ? 0 : 1;

    const finalAmount = isRefund ? -Math.abs(expense.amount) : Math.abs(expense.amount);
    let actionText = isRefund ? "🟢 Refund / Cancellation" : "🔴 Expense";
    if (isCreditCard && !isRefund) {
      actionText = "💳 Credit Card Expense (Unpaid Debt)";
    }

    const category = (expense.category || "").trim() || DEFAULT_CATEGORY;
    const description = (expense.description || "").trim() || DEFAULT_DESCRIPTION;
    const userId = (update.user_id || "").trim() || DEFAULT_USER_ID;

    await insertExpense(env.DB, userId, finalAmount, category, description, paymentMethod, isPaid);

    const formatted = formatCurrency(finalAmount);
    const extraNote = isCreditCard && !isRefund ? "\n📌 Use /debt to view unpaid bills, or /pay to settle." : "";
    return new Response(
      `✅ Saved ${actionText}:\n💰 Amount: ${formatted}\n🏷 Category: ${category}\n📝 Description: ${description}${extraNote}`
    );
  } catch (err: unknown) {
    console.error("Shortcut handler error:", err);
    const msg = err instanceof Error ? err.message : "Internal error";
    return new Response(`⚠️ Error: ${msg}`, { status: 500 });
  }
}
