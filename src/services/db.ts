import { CategorySummaryRow, ExpenseRow } from "../types";

/** A transaction to insert with {@link insertExpenses}. */
export interface ExpenseInsert {
  amount: number;
  category: string;
  description: string;
  paymentMethod?: string;
  isPaid?: number;
  createdAt?: string;
}

/** Columns of a full {@link ExpenseRow}. */
const EXPENSE_COLUMNS = "id, user_id, amount, category, description, payment_method, is_paid, created_at";

/** Matches a user's unpaid credit card bills; binds the user ID. */
const UNPAID_CARD_FILTER = "user_id = ? AND payment_method = 'credit_card' AND is_paid = 0";

/** IDs bound per statement when settling bills (D1 allows 100 bound parameters per query; one is the user ID). */
const SETTLE_CHUNK_SIZE = 90;

function prepareExpenseInsert(db: D1Database, userId: string, row: ExpenseInsert): D1PreparedStatement {
  const safeUserId = (userId || "").trim() || "unknown_user";
  const safeAmount = typeof row.amount === "number" && Number.isFinite(row.amount) ? row.amount : 0;
  const safeCategory = (row.category || "").trim() || "Other";
  const safeDescription = (row.description || "").trim() || "Transaction";
  const safeMethod = (row.paymentMethod || "").trim() || "cash";
  const safeIsPaid = row.isPaid !== undefined ? (row.isPaid ? 1 : 0) : (safeMethod === "credit_card" ? 0 : 1);

  return row.createdAt
    ? db
        .prepare(
          "INSERT INTO expenses (user_id, amount, category, description, payment_method, is_paid, created_at) VALUES (?, ?, ?, ?, ?, ?, ?)"
        )
        .bind(safeUserId, safeAmount, safeCategory, safeDescription, safeMethod, safeIsPaid, row.createdAt)
    : db
        .prepare(
          "INSERT INTO expenses (user_id, amount, category, description, payment_method, is_paid) VALUES (?, ?, ?, ?, ?, ?)"
        )
        .bind(safeUserId, safeAmount, safeCategory, safeDescription, safeMethod, safeIsPaid);
}

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
  const result = await prepareExpenseInsert(db, userId, {
    amount,
    category,
    description,
    paymentMethod,
    isPaid,
    createdAt,
  }).run();
  return result?.meta?.last_row_id ?? 0;
}

/**
 * Inserts several transactions in one D1 batch (a single SQL transaction): either all rows are
 * stored or none are, so a failed message can be resent without creating duplicates.
 *
 * @returns The new row IDs in input order (0 where the driver did not report one).
 */
export async function insertExpenses(db: D1Database, userId: string, rows: ExpenseInsert[]): Promise<number[]> {
  if (rows.length === 0) return [];
  const results = await db.batch(rows.map((row) => prepareExpenseInsert(db, userId, row)));
  return rows.map((_, i) => results[i]?.meta?.last_row_id ?? 0);
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
    SELECT ${EXPENSE_COLUMNS}
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
    SELECT ${EXPENSE_COLUMNS}
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

/**
 * Switches a user's transaction between cash (settled) and credit card (unpaid debt).
 * Credit card bills that were already paid are left alone, so the payment record is never lost.
 *
 * @returns true if the row was changed.
 */
export async function updateExpensePayment(
  db: D1Database,
  userId: string,
  id: number,
  paymentMethod: "cash" | "credit_card"
): Promise<boolean> {
  const isPaid = paymentMethod === "credit_card" ? 0 : 1;
  const result = await db
    .prepare(
      `UPDATE expenses SET payment_method = ?, is_paid = ?, paid_at = NULL
       WHERE id = ? AND user_id = ?
         AND NOT (COALESCE(payment_method, 'cash') = 'credit_card' AND COALESCE(is_paid, 1) <> 0)`
    )
    .bind(paymentMethod, isPaid, id, (userId || "").trim())
    .run();
  return (result?.meta?.changes ?? 1) > 0;
}

/**
 * Records a Telegram update_id as handled. Returns false when this exact update was already
 * claimed, i.e. Telegram retried a webhook that is being or has been processed.
 * Each ID is stored on its own, so updates delivered out of order (parallel connections) or with
 * a lower ID (Telegram restarts the sequence after a quiet week) are still processed.
 * A stored ID older than six days counts as new again (its row is refreshed in the same statement): retries
 * come within hours, while a restarted sequence can reuse an old ID, and this holds whether or not the row has
 * been pruned yet. Pruning is only storage hygiene: every 100th update ID deletes rows older than six days
 * (cheap thanks to the received_at index; sampled so the synchronous path before the 200 reply is usually a
 * single write). The claim is one batch, i.e. one round trip.
 * Databases that predate the table keep de-duplicating without a manual migration: on "no such table" it is
 * created (with its index) and the claim retried once. Other errors propagate.
 */
export async function claimTelegramUpdate(db: D1Database, updateId: number): Promise<boolean> {
  const claim = async (): Promise<boolean> => {
    const statements = [
      db
        .prepare(
          `INSERT INTO telegram_updates (update_id) VALUES (?)
           ON CONFLICT(update_id) DO UPDATE SET received_at = CURRENT_TIMESTAMP
           WHERE telegram_updates.received_at < datetime('now', '-6 days')`
        )
        .bind(updateId),
    ];
    if (updateId % 100 === 0) {
      statements.unshift(db.prepare("DELETE FROM telegram_updates WHERE received_at < datetime('now', '-6 days')"));
    }
    const results = await db.batch(statements);
    return (results[statements.length - 1]?.meta?.changes ?? 1) > 0;
  };

  try {
    return await claim();
  } catch (err: unknown) {
    if (!/no such table/i.test(err instanceof Error ? err.message : String(err))) throw err;
    await db.batch([
      db.prepare(
        "CREATE TABLE IF NOT EXISTS telegram_updates (update_id INTEGER PRIMARY KEY, received_at DATETIME DEFAULT CURRENT_TIMESTAMP)"
      ),
      db.prepare("CREATE INDEX IF NOT EXISTS idx_telegram_updates_received ON telegram_updates (received_at)"),
    ]);
    return claim();
  }
}

/**
 * Retrieves the latest transaction for a user (ordered by ID descending).
 */
export async function getLastExpense(
  db: D1Database,
  userId: string
): Promise<ExpenseRow | null> {
  const safeUserId = (userId || "").trim();
  const query = `SELECT ${EXPENSE_COLUMNS} FROM expenses WHERE user_id = ? ORDER BY id DESC LIMIT 1`;
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
    SELECT ${EXPENSE_COLUMNS}
    FROM expenses
    WHERE ${UNPAID_CARD_FILTER}
    ORDER BY id ASC
  `;
  const result = await db.prepare(query).bind(safeUserId).all<ExpenseRow>();
  return Array.isArray(result?.results) ? result.results : [];
}

/**
 * Marks the given credit card transactions as paid (debt settlement) and returns the rows it settled, in ID order.
 * Bills that are already paid or not the user's are skipped. Selects and updates in one batch (one transaction), so
 * the returned rows are exactly the ones this call settled, even when the same bill is paid twice at once. IDs are
 * bound in chunks to respect D1's parameter limit, so any number fits; callers validate and limit user input.
 */
export async function payCreditCardExpenses(
  db: D1Database,
  userId: string,
  ids: number[]
): Promise<ExpenseRow[]> {
  const safeUserId = (userId || "").trim();
  const sortedIds = ids.filter((id) => Number.isInteger(id) && id > 0).sort((a, b) => a - b);
  if (sortedIds.length === 0) return [];

  const statements: D1PreparedStatement[] = [];
  for (let i = 0; i < sortedIds.length; i += SETTLE_CHUNK_SIZE) {
    const chunk = sortedIds.slice(i, i + SETTLE_CHUNK_SIZE);
    const where = `${UNPAID_CARD_FILTER} AND id IN (${chunk.map(() => "?").join(", ")})`;
    statements.push(
      db.prepare(`SELECT ${EXPENSE_COLUMNS} FROM expenses WHERE ${where} ORDER BY id ASC`).bind(safeUserId, ...chunk),
      db.prepare(`UPDATE expenses SET is_paid = 1, paid_at = CURRENT_TIMESTAMP WHERE ${where}`).bind(safeUserId, ...chunk)
    );
  }

  const results = await db.batch<ExpenseRow>(statements);
  // Even positions are the SELECTs; the chunks ascend, so the rows stay in ID order.
  return results.flatMap((result, i) => (i % 2 === 0 && Array.isArray(result?.results) ? result.results : []));
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
