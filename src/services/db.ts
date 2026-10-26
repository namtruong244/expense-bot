import { CategorySummaryRow, ExpenseRow } from "../types";

/**
 * Inserts a new transaction record into the expenses table.
 *
 * @param db Cloudflare D1 database instance.
 * @param userId Unique user/chat identifier.
 * @param amount Transaction amount (positive for expense, negative for refund).
 * @param category Transaction category (e.g. "Food & Dining", "Shopping").
 * @param description Detailed description of the transaction.
 * @param paymentMethod "cash" or "credit_card".
 * @param isPaid Whether the transaction is settled (defaults to unpaid for credit cards).
 * @param createdAt Optional UTC timestamp ("YYYY-MM-DD HH:MM:SS") for back-dated transactions.
 * @returns The new row ID (0 if the driver did not report one).
 */
export async function insertExpense(
  db: D1Database,
  userId: string,
  amount: number,
  category: string,
  description: string,
  paymentMethod: string = "cash",
  isPaid?: number,
  createdAt?: string
): Promise<number> {
  const safeUserId = (userId || "").trim() || "unknown_user";
  const safeAmount = typeof amount === "number" && Number.isFinite(amount) ? amount : 0;
  const safeCategory = (category || "").trim() || "Other";
  const safeDescription = (description || "").trim() || "Transaction";
  const safeMethod = (paymentMethod || "").trim() || "cash";
  const safeIsPaid = isPaid !== undefined ? (isPaid ? 1 : 0) : (safeMethod === "credit_card" ? 0 : 1);

  const result = createdAt
    ? await db
        .prepare(
          "INSERT INTO expenses (user_id, amount, category, description, payment_method, is_paid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(safeUserId, safeAmount, safeCategory, safeDescription, safeMethod, safeIsPaid, createdAt)
        .run()
    : await db
        .prepare(
          "INSERT INTO expenses (user_id, amount, category, description, payment_method, is_paid) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .bind(safeUserId, safeAmount, safeCategory, safeDescription, safeMethod, safeIsPaid)
        .run();
  return result?.meta?.last_row_id ?? 0;
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
    SELECT id, amount, category, description, payment_method, is_paid
    FROM expenses
    WHERE user_id = ? AND date(created_at, '+7 hours') = date('now', '+7 hours')
    ORDER BY created_at DESC
  `;
  const result = await db.prepare(query).bind(safeUserId).all<ExpenseRow>();
  return Array.isArray(result?.results) ? result.results : [];
}

/**
 * Aggregates monthly expenses grouped by category for a specific user.
 * Aligned with the UTC+7 local calendar month; `month` ("YYYY-MM") selects another month.
 */
export async function getMonthExpensesByCategory(
  db: D1Database,
  userId: string,
  month?: string
): Promise<CategorySummaryRow[]> {
  const safeUserId = (userId || "").trim();
  const query = `
    SELECT category, SUM(amount) as total_cat, COUNT(id) as count
    FROM expenses
    WHERE user_id = ? AND strftime('%Y-%m', created_at, '+7 hours') = COALESCE(?, strftime('%Y-%m', 'now', '+7 hours'))
    GROUP BY category ORDER BY total_cat DESC
  `;
  const result = await db.prepare(query).bind(safeUserId, month ?? null).all<CategorySummaryRow>();
  return Array.isArray(result?.results) ? result.results : [];
}

/**
 * Aggregates the last 7 local calendar days (today included) grouped by category.
 */
export async function getWeekExpensesByCategory(db: D1Database, userId: string): Promise<CategorySummaryRow[]> {
  const safeUserId = (userId || "").trim();
  const query = `
    SELECT category, SUM(amount) as total_cat, COUNT(id) as count
    FROM expenses
    WHERE user_id = ? AND date(created_at, '+7 hours') >= date('now', '+7 hours', '-6 days')
    GROUP BY category ORDER BY total_cat DESC
  `;
  const result = await db.prepare(query).bind(safeUserId).all<CategorySummaryRow>();
  return Array.isArray(result?.results) ? result.results : [];
}

/**
 * Sums the credit card spending of a month and how much of it is still unpaid.
 */
export async function getMonthCreditCardTotals(
  db: D1Database,
  userId: string,
  month?: string
): Promise<{ card_total: number; unpaid_total: number }> {
  const safeUserId = (userId || "").trim();
  const query = `
    SELECT COALESCE(SUM(amount), 0) as card_total,
           COALESCE(SUM(CASE WHEN is_paid = 0 THEN amount ELSE 0 END), 0) as unpaid_total
    FROM expenses
    WHERE user_id = ? AND payment_method = 'credit_card'
      AND strftime('%Y-%m', created_at, '+7 hours') = COALESCE(?, strftime('%Y-%m', 'now', '+7 hours'))
  `;
  const row = await db
    .prepare(query)
    .bind(safeUserId, month ?? null)
    .first<{ card_total: number; unpaid_total: number }>();
  return { card_total: row?.card_total ?? 0, unpaid_total: row?.unpaid_total ?? 0 };
}

/**
 * Retrieves the most recent transactions of a user (newest first).
 */
export async function getRecentExpenses(db: D1Database, userId: string, limit = 10): Promise<ExpenseRow[]> {
  const safeUserId = (userId || "").trim();
  const safeLimit = Math.max(1, Math.min(50, Math.floor(limit) || 10));
  const query = `
    SELECT id, user_id, amount, category, description, payment_method, is_paid, created_at
    FROM expenses
    WHERE user_id = ?
    ORDER BY id DESC
    LIMIT ?
  `;
  const result = await db.prepare(query).bind(safeUserId, safeLimit).all<ExpenseRow>();
  return Array.isArray(result?.results) ? result.results : [];
}

/**
 * Retrieves one transaction, only if it belongs to the given user.
 */
export async function getExpenseById(db: D1Database, userId: string, id: number): Promise<ExpenseRow | null> {
  if (!Number.isInteger(id) || id <= 0) return null;
  const query = `
    SELECT id, user_id, amount, category, description, payment_method, is_paid, created_at
    FROM expenses WHERE id = ? AND user_id = ?
  `;
  return (await db.prepare(query).bind(id, (userId || "").trim()).first<ExpenseRow>()) ?? null;
}

/** Changes the category of a user's transaction. */
export async function updateExpenseCategory(
  db: D1Database,
  userId: string,
  id: number,
  category: string
): Promise<void> {
  await db
    .prepare("UPDATE expenses SET category = ? WHERE id = ? AND user_id = ?")
    .bind(category, id, (userId || "").trim())
    .run();
}

/** Switches a user's transaction between cash (settled) and credit card (unpaid debt). */
export async function updateExpensePayment(
  db: D1Database,
  userId: string,
  id: number,
  paymentMethod: "cash" | "credit_card"
): Promise<void> {
  const isPaid = paymentMethod === "credit_card" ? 0 : 1;
  await db
    .prepare("UPDATE expenses SET payment_method = ?, is_paid = ?, paid_at = NULL WHERE id = ? AND user_id = ?")
    .bind(paymentMethod, isPaid, id, (userId || "").trim())
    .run();
}

/**
 * Records a Telegram update_id as handled. Returns false when the same (or a newer) update was
 * already claimed, i.e. Telegram retried a webhook that is being or has been processed.
 * Atomic: the conditional upsert only changes the row when the stored ID is older.
 */
export async function claimTelegramUpdate(db: D1Database, updateId: number): Promise<boolean> {
  const result = await db
    .prepare(
      `INSERT INTO app_config (key, value, updated_at) VALUES ('telegram_last_update_id', ?, CURRENT_TIMESTAMP)
       ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP
       WHERE CAST(app_config.value AS INTEGER) < CAST(excluded.value AS INTEGER)`
    )
    .bind(String(updateId))
    .run();
  return (result?.meta?.changes ?? 1) > 0;
}

/**
 * Retrieves the latest transaction for a user (ordered by ID descending).
 */
export async function getLastExpense(
  db: D1Database,
  userId: string
): Promise<ExpenseRow | null> {
  const safeUserId = (userId || "").trim();
  const query =
    "SELECT id, user_id, amount, category, description, payment_method, is_paid, created_at FROM expenses WHERE user_id = ? ORDER BY id DESC LIMIT 1";
  return (await db.prepare(query).bind(safeUserId).first<ExpenseRow>()) ?? null;
}

/**
 * Deletes a transaction from the database by its primary key ID.
 * When `userId` is given, only that user's transaction can be deleted.
 *
 * @returns true if a row was deleted.
 */
export async function deleteExpenseById(
  db: D1Database,
  id: number,
  userId?: string
): Promise<boolean> {
  if (typeof id !== "number" || !Number.isFinite(id) || id <= 0) {
    return false;
  }
  const result = userId
    ? await db.prepare("DELETE FROM expenses WHERE id = ? AND user_id = ?").bind(id, userId.trim()).run()
    : await db.prepare("DELETE FROM expenses WHERE id = ?").bind(id).run();
  return (result?.meta?.changes ?? 1) > 0;
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

/**
 * Retrieves several configuration values by key in a single query.
 * Read failures are logged and treated as "not configured" so expense recording keeps working.
 */
export async function getConfigs(db: D1Database, keys: string[]): Promise<Record<string, string>> {
  if (keys.length === 0) return {};
  try {
    const placeholders = keys.map(() => "?").join(", ");
    const result = await db
      .prepare(`SELECT key, value FROM app_config WHERE key IN (${placeholders})`)
      .bind(...keys)
      .all<{ key: string; value: string }>();
    const out: Record<string, string> = {};
    for (const row of result?.results ?? []) {
      out[row.key] = row.value;
    }
    return out;
  } catch (err: unknown) {
    console.error("Failed to read config from D1:", err);
    return {};
  }
}

/**
 * Retrieves a configuration value by key from the app_config table.
 */
export async function getConfig(db: D1Database, key: string): Promise<string | null> {
  return (await getConfigs(db, [key]))[key] ?? null;
}

/**
 * Sets or updates a configuration value by key in the app_config table.
 * Throws on failure so callers never report a change that was not saved.
 * The table is created by schema.sql.
 */
export async function setConfig(db: D1Database, key: string, value: string): Promise<void> {
  await db
    .prepare(
      "INSERT INTO app_config (key, value, updated_at) VALUES (?, ?, CURRENT_TIMESTAMP) ON CONFLICT(key) DO UPDATE SET value = excluded.value, updated_at = CURRENT_TIMESTAMP"
    )
    .bind(key, value)
    .run();
}
