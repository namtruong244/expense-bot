import { CategorySummaryRow, ExpenseRow } from "../types";

/**
 * Inserts a new transaction record into the expenses table.
 *
 * @param db Cloudflare D1 database instance.
 * @param userId Unique user/chat identifier.
 * @param amount Transaction amount (positive for expense, negative for refund).
 * @param category Transaction category (e.g. "Food & Dining", "Shopping").
 * @param description Detailed description of the transaction.
 */
export async function insertExpense(
  db: D1Database,
  userId: string,
  amount: number,
  category: string,
  description: string,
  paymentMethod: string = "cash",
  isPaid?: number
): Promise<void> {
  const safeUserId = (userId || "").trim() || "unknown_user";
  const safeAmount = typeof amount === "number" && Number.isFinite(amount) ? amount : 0;
  const safeCategory = (category || "").trim() || "Other";
  const safeDescription = (description || "").trim() || "Transaction";
  const safeMethod = (paymentMethod || "").trim() || "cash";
  const safeIsPaid = isPaid !== undefined ? (isPaid ? 1 : 0) : (safeMethod === "credit_card" ? 0 : 1);

  await db
    .prepare(
      "INSERT INTO expenses (user_id, amount, category, description, payment_method, is_paid) VALUES (?, ?, ?, ?, ?, ?)"
    )
    .bind(safeUserId, safeAmount, safeCategory, safeDescription, safeMethod, safeIsPaid)
    .run();
}

/**
 * Retrieves all transactions recorded today for a specific user.
 *
 * TIMEZONE NOTE:
 * Cloudflare D1 stores `created_at` in UTC. We use `+7 hours` offset to align
 * queries with local user calendar day (UTC+7).
 */
export async function getTodayExpenses(
  db: D1Database,
  userId: string
): Promise<ExpenseRow[]> {
  const safeUserId = (userId || "").trim();
  const query = `
    SELECT amount, category, description
    FROM expenses
    WHERE user_id = ? AND date(created_at, '+7 hours') = date('now', '+7 hours')
    ORDER BY created_at DESC
  `;
  const result = await db.prepare(query).bind(safeUserId).all<ExpenseRow>();
  return Array.isArray(result?.results) ? result.results : [];
}

/**
 * Aggregates monthly expenses grouped by category for a specific user.
 * Aligned with UTC+7 local calendar month.
 */
export async function getMonthExpensesByCategory(
  db: D1Database,
  userId: string
): Promise<CategorySummaryRow[]> {
  const safeUserId = (userId || "").trim();
  const query = `
    SELECT category, SUM(amount) as total_cat, COUNT(id) as count
    FROM expenses
    WHERE user_id = ? AND strftime('%Y-%m', created_at, '+7 hours') = strftime('%Y-%m', 'now', '+7 hours')
    GROUP BY category ORDER BY total_cat DESC
  `;
  const result = await db.prepare(query).bind(safeUserId).all<CategorySummaryRow>();
  return Array.isArray(result?.results) ? result.results : [];
}

/**
 * Retrieves the latest transaction for a user (ordered by ID descending).
 */
export async function getLastExpense(
  db: D1Database,
  userId: string
): Promise<ExpenseRow | null> {
  const safeUserId = (userId || "").trim();
  const query = "SELECT id, amount, description FROM expenses WHERE user_id = ? ORDER BY id DESC LIMIT 1";
  return (await db.prepare(query).bind(safeUserId).first<ExpenseRow>()) ?? null;
}

/**
 * Deletes a transaction from the database by its primary key ID.
 */
export async function deleteExpenseById(
  db: D1Database,
  id: number
): Promise<void> {
  if (typeof id !== "number" || !Number.isFinite(id) || id <= 0) {
    return;
  }
  await db.prepare("DELETE FROM expenses WHERE id = ?").bind(id).run();
}

/**
 * Retrieves all unpaid credit card transactions for a specific user.
 */
export async function getUnpaidCreditCardExpenses(
  db: D1Database,
  userId: string
): Promise<ExpenseRow[]> {
  const safeUserId = (userId || "").trim();
  const query = `
    SELECT id, user_id, amount, category, description, payment_method, is_paid, created_at
    FROM expenses
    WHERE user_id = ? AND payment_method = 'credit_card' AND is_paid = 0
    ORDER BY id ASC
  `;
  const result = await db.prepare(query).bind(safeUserId).all<ExpenseRow>();
  return Array.isArray(result?.results) ? result.results : [];
}

/**
 * Marks specified credit card transactions as paid (debt settlement).
 * Returns the list of rows that were successfully settled.
 */
export async function payCreditCardExpenses(
  db: D1Database,
  userId: string,
  ids: number[]
): Promise<ExpenseRow[]> {
  const safeUserId = (userId || "").trim();
  const validIds = ids.filter((id) => typeof id === "number" && Number.isInteger(id) && id > 0);
  if (validIds.length === 0) {
    return [];
  }

  const placeholders = validIds.map(() => "?").join(", ");
  const selectQuery = `
    SELECT id, user_id, amount, category, description, payment_method, is_paid, created_at
    FROM expenses
    WHERE user_id = ? AND payment_method = 'credit_card' AND is_paid = 0 AND id IN (${placeholders})
    ORDER BY id ASC
  `;
  const result = await db.prepare(selectQuery).bind(safeUserId, ...validIds).all<ExpenseRow>();
  const toPayRows = Array.isArray(result?.results) ? result.results : [];

  if (toPayRows.length > 0) {
    const updateIds = toPayRows.map((r) => r.id);
    const updatePlaceholders = updateIds.map(() => "?").join(", ");
    const updateQuery = `
      UPDATE expenses
      SET is_paid = 1, paid_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND id IN (${updatePlaceholders})
    `;
    await db.prepare(updateQuery).bind(safeUserId, ...updateIds).run();
  }

  return toPayRows;
}

/**
 * Marks all unpaid credit card transactions as paid for a user.
 * Returns the list of all rows that were settled.
 */
export async function payAllCreditCardExpenses(
  db: D1Database,
  userId: string
): Promise<ExpenseRow[]> {
  const safeUserId = (userId || "").trim();
  const selectQuery = `
    SELECT id, user_id, amount, category, description, payment_method, is_paid, created_at
    FROM expenses
    WHERE user_id = ? AND payment_method = 'credit_card' AND is_paid = 0
    ORDER BY id ASC
  `;
  const result = await db.prepare(selectQuery).bind(safeUserId).all<ExpenseRow>();
  const toPayRows = Array.isArray(result?.results) ? result.results : [];

  if (toPayRows.length > 0) {
    const updateQuery = `
      UPDATE expenses
      SET is_paid = 1, paid_at = CURRENT_TIMESTAMP
      WHERE user_id = ? AND payment_method = 'credit_card' AND is_paid = 0
    `;
    await db.prepare(updateQuery).bind(safeUserId).run();
  }

  return toPayRows;
}
