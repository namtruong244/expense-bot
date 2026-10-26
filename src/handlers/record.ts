import { DEFAULT_CATEGORY, DEFAULT_DESCRIPTION, MAX_TRANSACTIONS_PER_MESSAGE, TZ_OFFSET_HOURS } from "../constants";
import { localToday } from "../formatters";
import { SavedTransaction } from "../messages";
import { insertExpense } from "../services/db";
import { ExpenseData } from "../types";

/** A transaction ready to be stored. */
export interface NewTransaction extends SavedTransaction {
  /** Signed amount: negative for refunds. */
  amount: number;
}

/** Back-dated transactions older than this many days are ignored (treated as "now"). */
const MAX_BACKDATE_DAYS = 366;

/** Returns `date` if it is a valid past local date within range, else undefined (also for today). */
function validBackdate(date: unknown): string | undefined {
  if (typeof date !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(date)) return undefined;
  const parsed = new Date(`${date}T00:00:00Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) return undefined;

  const today = localToday();
  if (date >= today) return undefined;
  const ageDays = (Date.parse(`${today}T00:00:00Z`) - parsed.getTime()) / 86_400_000;
  return ageDays <= MAX_BACKDATE_DAYS ? date : undefined;
}

/** UTC timestamp for noon local time on `date`, so it lands on that calendar day in UTC+7. */
function backdateToTimestamp(date: string): string {
  const noonUtc = 12 - TZ_OFFSET_HOURS;
  return `${date} ${String(noonUtc).padStart(2, "0")}:00:00`;
}

/**
 * Turns Gemini output into storable transactions. Accepts both the `transactions` array and a
 * single flat object; drops entries without a positive amount.
 *
 * @param forceCreditCard Treat every transaction as paid by credit card (Shortcut `payment_method` override).
 */
export function buildTransactions(expense: ExpenseData, forceCreditCard = false): NewTransaction[] {
  const items = expense.transactions?.length ? expense.transactions : [expense];
  const result: NewTransaction[] = [];

  for (const item of items.slice(0, MAX_TRANSACTIONS_PER_MESSAGE)) {
    if (!item.amount || !Number.isFinite(item.amount) || item.amount <= 0) continue;

    const isRefund = item.transaction_type === "refund" || item.transaction_type === "hoan_tien";
    const isCard = forceCreditCard || item.payment_method === "credit_card";
    result.push({
      amount: isRefund ? -Math.abs(item.amount) : Math.abs(item.amount),
      category: (item.category || "").trim() || DEFAULT_CATEGORY,
      description: (item.description || "").trim() || DEFAULT_DESCRIPTION,
      paymentMethod: isCard ? "credit_card" : "cash",
      isPaid: !isCard,
      date: validBackdate(item.date),
    });
  }
  return result;
}

/** Stores a transaction and returns its row ID (0 if unknown). */
export async function saveTransaction(db: D1Database, userId: string, tx: NewTransaction): Promise<number> {
  return insertExpense(
    db,
    userId,
    tx.amount,
    tx.category,
    tx.description,
    tx.paymentMethod,
    tx.isPaid ? 1 : 0,
    tx.date ? backdateToTimestamp(tx.date) : undefined
  );
}
