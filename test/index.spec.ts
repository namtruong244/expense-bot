import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import worker, {
  Env,
  SYSTEM_PROMPT,
  sendTelegram,
  downloadTelegramFileAsBase64,
  parseWithGemini,
  handleCommand,
  GeminiPayload,
  WebhookUpdate,
  formatAmount,
  formatCurrency,
  escapeHtml,
  percentBar,
  toLocalDate,
  formatDate,
  localMonth,
  localToday,
  buildTransactions,
  claimTelegramUpdate,
  handleCallbackQuery,
  getRecentExpenses,
  insertExpense,
  getTodayExpenses,
  getMonthExpensesByCategory,
  deleteExpenseById,
  getUnpaidCreditCardExpenses,
  payCreditCardExpenses,
  payAllCreditCardExpenses,
  ExpenseRow,
  fetchAvailableGeminiModels,
  syncAvailableGeminiModels,
  resolveGeminiModelSequence,
  getConfig,
  setConfig,
} from "../src/index";

interface ExecutedStatement {
  sql: string;
  bindings: unknown[];
}

interface MockD1Config {
  allResults?: Record<string, unknown>[];
  firstResult?: Record<string, unknown> | null;
  onExecute?: (stmt: ExecutedStatement) => void;
  /** Overrides for the metadata returned by run() (e.g. last_row_id, changes). */
  runMeta?: { last_row_id?: number; changes?: number };
}

function createMockD1(config: MockD1Config = {}): {
  db: D1Database;
  statements: ExecutedStatement[];
} {
  const statements: ExecutedStatement[] = [];
  const mockMeta = {
    duration: 0,
    size_after: 0,
    rows_read: 0,
    rows_written: 0,
    last_row_id: 0,
    changed_db: false,
    changes: 0,
  };

  const db: D1Database = {
    prepare(sql: string) {
      let currentBindings: unknown[] = [];
      const stmt: D1PreparedStatement = {
        bind(...values: unknown[]) {
          currentBindings = values;
          return stmt;
        },
        async first<T = unknown>(_colName?: string): Promise<T | null> {
          const executed = { sql, bindings: currentBindings };
          statements.push(executed);
          config.onExecute?.(executed);
          return (config.firstResult ?? null) as T | null;
        },
        async all<T = Record<string, unknown>>(): Promise<D1Result<T>> {
          const executed = { sql, bindings: currentBindings };
          statements.push(executed);
          config.onExecute?.(executed);
          return {
            results: (config.allResults ?? []) as T[],
            success: true,
            meta: mockMeta,
          };
        },
        async run<T = Record<string, unknown>>(): Promise<D1Result<T>> {
          const executed = { sql, bindings: currentBindings };
          statements.push(executed);
          config.onExecute?.(executed);
          return {
            results: [] as T[],
            success: true,
            meta: { ...mockMeta, ...config.runMeta },
          };
        },
        raw: (async () => {
          return [] as unknown as [string[], ...unknown[][]] & unknown[][];
        }) as D1PreparedStatement["raw"],
      };
      return stmt;
    },
    withSession() {
      return {
        prepare: db.prepare,
        batch: db.batch,
        getBookmark: () => null,
      } as unknown as D1DatabaseSession;
    },
    async dump(): Promise<ArrayBuffer> {
      return new ArrayBuffer(0);
    },
    async batch<T = unknown>(_statements: D1PreparedStatement[]): Promise<D1Result<T>[]> {
      return [];
    },
    async exec(_query: string): Promise<D1ExecResult> {
      return { count: 0, duration: 0 };
    },
  };

  return { db, statements };
}

describe("Expense Bot Suite", () => {
  const originalFetch = globalThis.fetch;

  beforeEach(() => {
    vi.restoreAllMocks();
  });

  afterEach(() => {
    globalThis.fetch = originalFetch;
  });

  // ==========================================
  // 0. formatAmount & formatCurrency
  // ==========================================
  describe("formatters edge cases", () => {
    it("sanitizes NaN, Infinity, -Infinity safely to 0", () => {
      expect(formatAmount(NaN)).toBe("0 ₫");
      expect(formatAmount(Infinity)).toBe("0 ₫");
      expect(formatAmount(-Infinity)).toBe("0 ₫");
      expect(formatAmount(0)).toBe("0 ₫");
      expect(formatCurrency(NaN)).toBe("0 ₫");
    });

    it("formats amounts Vietnamese style and ignores the sign", () => {
      expect(formatAmount(45000)).toBe("45.000 ₫");
      expect(formatCurrency(-1234567)).toBe("1.234.567 ₫");
    });

    it("escapes HTML, builds bars and converts UTC timestamps to local dates", () => {
      expect(escapeHtml("a<b>&c")).toBe("a&lt;b&gt;&amp;c");
      expect(percentBar(40)).toBe("▓▓▓▓░░░░░░");
      expect(percentBar(150)).toBe("▓▓▓▓▓▓▓▓▓▓");
      expect(toLocalDate("2026-10-25 20:00:00")).toBe("2026-10-26");
      expect(formatDate("2026-10-26")).toBe("26/10/2026");
      expect(localMonth(-1, new Date("2026-01-15T00:00:00Z"))).toBe("2025-12");
    });
  });

  // ==========================================
  // 0.1 db service edge cases
  // ==========================================
  describe("db service edge cases", () => {
    it("insertExpense sanitizes empty userId, NaN amount, and empty category/description", async () => {
      const { db, statements } = createMockD1();
      await insertExpense(db, "   ", NaN, "   ", "   ");

      expect(statements).toHaveLength(1);
      expect(statements[0].bindings).toEqual(["unknown_user", 0, "Other", "Transaction", "cash", 1]);
    });

    it("deleteExpenseById ignores non-positive ID values", async () => {
      const { db, statements } = createMockD1();
      await deleteExpenseById(db, 0);
      await deleteExpenseById(db, -10);

      expect(statements).toHaveLength(0);
    });

    it("getTodayExpenses and getMonthExpensesByCategory handle null or undefined results safely", async () => {
      const db: D1Database = {
        prepare: () => ({
          bind: () => ({
            all: async () => ({ results: null as unknown as ExpenseRow[], success: true, meta: {} as D1Meta }),
            first: async () => null,
            run: async () => ({ success: true, meta: {} as D1Meta }),
            raw: async () => [],
          }),
        } as unknown as D1PreparedStatement),
        withSession: () => ({ prepare: () => ({} as D1PreparedStatement), batch: () => Promise.resolve([]), getBookmark: () => null }),
        dump: async () => new ArrayBuffer(0),
        batch: async () => [],
        exec: async () => ({ count: 0, duration: 0 }),
      };

      const today = await getTodayExpenses(db, "user_1");
      expect(today).toEqual([]);

      const month = await getMonthExpensesByCategory(db, "user_1");
      expect(month).toEqual([]);
    });

    it("getUnpaidCreditCardExpenses retrieves unpaid credit card expenses for user", async () => {
      const mockRows: ExpenseRow[] = [
        { id: 1, user_id: "user_1", amount: 100000, category: "Shopping", description: "Shoes", payment_method: "credit_card", is_paid: 0 },
      ];
      const { db, statements } = createMockD1({ allResults: mockRows as unknown as Record<string, unknown>[] });

      const unpaid = await getUnpaidCreditCardExpenses(db, "user_1");
      expect(unpaid).toHaveLength(1);
      expect(unpaid[0].id).toBe(1);
      expect(statements[0].sql).toContain("payment_method = 'credit_card' AND is_paid = 0");
      expect(statements[0].bindings).toEqual(["user_1"]);
    });

    it("payCreditCardExpenses returns empty array when given empty or invalid IDs", async () => {
      const { db, statements } = createMockD1();
      const paid = await payCreditCardExpenses(db, "user_1", [0, -5, NaN]);

      expect(paid).toEqual([]);
      expect(statements).toHaveLength(0);
    });

    it("payCreditCardExpenses marks matched bills as paid and updates paid_at", async () => {
      const mockRows: ExpenseRow[] = [
        { id: 5, user_id: "user_1", amount: 200000, category: "Dining", description: "Steak", payment_method: "credit_card", is_paid: 0 },
      ];
      const { db, statements } = createMockD1({ allResults: mockRows as unknown as Record<string, unknown>[] });

      const paid = await payCreditCardExpenses(db, "user_1", [5]);
      expect(paid).toHaveLength(1);
      expect(paid[0].id).toBe(5);

      const updateStmt = statements.find((s) => s.sql.includes("UPDATE expenses") && s.sql.includes("is_paid = 1"));
      expect(updateStmt).toBeDefined();
      expect(updateStmt?.bindings).toEqual(["user_1", 5]);
    });

    it("payAllCreditCardExpenses marks all unpaid bills as paid", async () => {
      const mockRows: ExpenseRow[] = [
        { id: 10, user_id: "user_1", amount: 50000, category: "Snacks", description: "Chips", payment_method: "credit_card", is_paid: 0 },
      ];
      const { db, statements } = createMockD1({ allResults: mockRows as unknown as Record<string, unknown>[] });

      const paid = await payAllCreditCardExpenses(db, "user_1");
      expect(paid).toHaveLength(1);
      expect(paid[0].id).toBe(10);

      const updateStmt = statements.find((s) => s.sql.includes("UPDATE expenses"));
      expect(updateStmt).toBeDefined();
      expect(updateStmt?.bindings).toEqual(["user_1"]);
    });
  });

  // ==========================================
  // 1. sendTelegram
  // ==========================================
  describe("sendTelegram()", () => {
    it("sends POST request to Telegram sendMessage API with HTML parse mode", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
      globalThis.fetch = fetchMock;

      await sendTelegram("fake_token_123", 987654321, "Hello!");

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];

      expect(calledUrl).toBe("https://api.telegram.org/botfake_token_123/sendMessage");
      expect(calledInit.method).toBe("POST");
      expect(calledInit.headers).toEqual({ "Content-Type": "application/json" });

      const parsedBody = JSON.parse(calledInit.body as string) as {
        chat_id: number;
        text: string;
        parse_mode: string;
      };
      expect(parsedBody).toEqual({
        chat_id: 987654321,
        text: "Hello!",
        parse_mode: "HTML",
      });
    });

    it("does not call fetch if token, chatId or text is missing or whitespace", async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;

      await sendTelegram("", 12345, "Hello");
      await sendTelegram("token", 0, "Hello");
      await sendTelegram("token", 12345, "");

      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("retries as plain text if Telegram returns 400 parse error", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: false, description: "Bad Request: can't parse entities" }), {
            status: 400,
          })
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));

      globalThis.fetch = fetchMock;

      await sendTelegram("bot_tok", 12345, "<b>Unmatched</b> &lt;tag");

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
      const body = JSON.parse(secondInit.body as string) as { parse_mode?: string };
      expect(body.parse_mode).toBeUndefined();
      expect((body as { text: string }).text).toBe("Unmatched <tag");
    });

    it("includes reply_markup when a keyboard is given", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
      globalThis.fetch = fetchMock;
      const kb = { inline_keyboard: [[{ text: "OK", callback_data: "cancel" }]] };

      await sendTelegram("tok", 1, "hi", kb);

      const body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as {
        reply_markup: unknown;
      };
      expect(body.reply_markup).toEqual(kb);
    });

    it("catches network error gracefully without throwing exception", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const fetchMock = vi.fn().mockRejectedValueOnce(new Error("Connection timeout"));
      globalThis.fetch = fetchMock;

      await expect(sendTelegram("bot_tok", 12345, "Hello")).resolves.not.toThrow();
    });
  });

  // ==========================================
  // 2. downloadTelegramFileAsBase64
  // ==========================================
  describe("downloadTelegramFileAsBase64()", () => {
    it("downloads file from Telegram CDN and converts to base64 successfully", async () => {
      const mockBinaryData = new TextEncoder().encode("Hello Image Bytes");

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ok: true,
              result: { file_id: "photo_123", file_path: "photos/file_0.jpg" },
            })
          )
        )
        .mockResolvedValueOnce(new Response(mockBinaryData));

      globalThis.fetch = fetchMock;

      const base64 = await downloadTelegramFileAsBase64("photo_123", "bot_token_xyz");

      expect(fetchMock).toHaveBeenCalledTimes(2);
      expect(fetchMock.mock.calls[0]?.[0]).toBe(
        "https://api.telegram.org/botbot_token_xyz/getFile?file_id=photo_123"
      );
      expect(fetchMock.mock.calls[1]?.[0]).toBe(
        "https://api.telegram.org/file/botbot_token_xyz/photos/file_0.jpg"
      );

      const expectedBase64 = Buffer.from("Hello Image Bytes").toString("base64");
      expect(base64).toBe(expectedBase64);
    });

    it("throws an error when Telegram getFile response is missing file_path", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            ok: false,
            result: {},
          })
        )
      );

      globalThis.fetch = fetchMock;

      await expect(
        downloadTelegramFileAsBase64("invalid_id", "bot_token_xyz")
      ).rejects.toThrow("Failed to get file path from Telegram");
    });

    it("throws error if fileId or token is missing or empty", async () => {
      await expect(downloadTelegramFileAsBase64("", "token")).rejects.toThrow("Missing fileId or token");
      await expect(downloadTelegramFileAsBase64("file_1", "")).rejects.toThrow("Missing fileId or token");
    });

    it("throws error if getFile API returns non-200 status", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(new Response("Not Found", { status: 404 }));
      globalThis.fetch = fetchMock;

      await expect(downloadTelegramFileAsBase64("file_1", "tok")).rejects.toThrow(
        "Failed to get file metadata: HTTP 404"
      );
    });

    it("throws error if CDN file download returns non-200 status", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              ok: true,
              result: { file_id: "photo_1", file_path: "photos/1.jpg" },
            })
          )
        )
        .mockResolvedValueOnce(new Response("Internal Server Error", { status: 500 }));

      globalThis.fetch = fetchMock;

      await expect(downloadTelegramFileAsBase64("photo_1", "tok")).rejects.toThrow(
        "Failed to download file from Telegram CDN: HTTP 500"
      );
    });
  });

  // ==========================================
  // 3. parseWithGemini
  // ==========================================
  describe("parseWithGemini()", () => {
    const dummyPayload: GeminiPayload = {
      contents: [{ parts: [{ text: "Coffee 45k" }] }],
    };

    it("returns error when GEMINI_API_KEY is empty", async () => {
      const result = await parseWithGemini(dummyPayload, "");
      expect(result).toEqual({ error: "Missing GEMINI_API_KEY" });
    });

    it("successfully parses valid response from gemini-3.1-flash", async () => {
      const mockData = {
        amount: 45000,
        category: "Food & Dining",
        description: "Coffee",
        transaction_type: "expense",
      };

      const fetchMock = vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: JSON.stringify(mockData) }],
                },
              },
            ],
          })
        )
      );

      globalThis.fetch = fetchMock;

      const result = await parseWithGemini(dummyPayload, "key_gemini");
      expect(result).toEqual(mockData);

      const [calledUrl, calledInit] = fetchMock.mock.calls[0] as [string, RequestInit];
      expect(calledUrl).toContain("models/gemini-3.1-flash:generateContent?key=key_gemini");
      expect(calledInit.method).toBe("POST");

      const body = JSON.parse(calledInit.body as string) as {
        system_instruction: { parts: Array<{ text: string }> };
      };
      expect(body.system_instruction.parts[0]?.text).toContain(SYSTEM_PROMPT);
      expect(body.system_instruction.parts[0]?.text).toContain(`Today's date (UTC+7) is ${localToday()}`);
    });

    it("cleans markdown code block (```json) from Gemini candidate text", async () => {
      const mockData = {
        amount: 120000,
        category: "Shopping",
        description: "T-shirt",
        transaction_type: "expense",
      };

      const fetchMock = vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: "```json\n" + JSON.stringify(mockData) + "\n```" }],
                },
              },
            ],
          })
        )
      );

      globalThis.fetch = fetchMock;

      const result = await parseWithGemini(dummyPayload, "key_gemini");
      expect(result).toEqual(mockData);
    });

    it("falls back to gemini-2.5-flash when gemini-3.1-flash returns 503 or 429", async () => {
      const mockData = {
        amount: 30000,
        category: "Transportation",
        description: "Gas",
        transaction_type: "expense",
      };

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: { message: "Model is overloaded" } }), {
            status: 503,
          })
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [{ text: JSON.stringify(mockData) }],
                  },
                },
              ],
            })
          )
        );

      globalThis.fetch = fetchMock;

      const result = await parseWithGemini(dummyPayload, "key_gemini");
      expect(result).toEqual(mockData);
      expect(fetchMock).toHaveBeenCalledTimes(2);

      const firstUrl = fetchMock.mock.calls[0]?.[0] as string;
      const secondUrl = fetchMock.mock.calls[1]?.[0] as string;
      expect(firstUrl).toContain("models/gemini-3.1-flash");
      expect(secondUrl).toContain("models/gemini-2.5-flash");
    });

    it("falls back to next model when first model returns payload with data.error", async () => {
      const mockData = {
        amount: 50000,
        category: "Food & Dining",
        description: "Lunch",
        transaction_type: "expense",
      };

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: { message: "Internal error" } }), {
            status: 200,
          })
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [{ text: JSON.stringify(mockData) }],
                  },
                },
              ],
            })
          )
        );

      globalThis.fetch = fetchMock;

      const result = await parseWithGemini(dummyPayload, "key_gemini");
      expect(result).toEqual(mockData);
    });

    it("returns 'AI service unavailable' error when all models fail", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: { message: "Quota exceeded" } }), {
            status: 429,
          })
        )
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ error: { message: "Service unavailable" } }), {
            status: 503,
          })
        );

      globalThis.fetch = fetchMock;

      const result = await parseWithGemini(dummyPayload, "key_gemini");
      expect(result).toEqual({ error: "AI service unavailable: Service unavailable" });
    });

    it("handles network exception / JSON parsing errors and falls back to next model", async () => {
      const mockData = {
        amount: 15000,
        category: "Other",
        description: "Parking",
        transaction_type: "expense",
      };

      const fetchMock = vi
        .fn()
        .mockRejectedValueOnce(new Error("Network connection dropped"))
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [{ text: JSON.stringify(mockData) }],
                  },
                },
              ],
            })
          )
        );

      globalThis.fetch = fetchMock;

      const result = await parseWithGemini(dummyPayload, "key_gemini");
      expect(result).toEqual(mockData);
    });

    it("returns error if apiKey is whitespace", async () => {
      const result = await parseWithGemini(dummyPayload, "   ");
      expect(result).toEqual({ error: "Missing GEMINI_API_KEY" });
    });

    it("returns error if payload contents is empty", async () => {
      const result = await parseWithGemini({ contents: [] }, "key_gemini");
      expect(result).toEqual({ error: "Invalid payload provided" });
    });

    it("normalizes string amount to positive number", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            candidates: [
              {
                content: {
                  parts: [{ text: JSON.stringify({ amount: "55000", category: "Food & Dining", description: "Snack" }) }],
                },
              },
            ],
          })
        )
      );
      globalThis.fetch = fetchMock;

      const result = await parseWithGemini(dummyPayload, "key_gemini");
      expect(result.amount).toBe(55000);
    });

    it("ignores candidate where parsed JSON is not an object and falls back", async () => {
      const mockData = {
        amount: 20000,
        category: "Other",
        description: "Valid",
        transaction_type: "expense",
      };

      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              candidates: [{ content: { parts: [{ text: "12345" }] } }],
            })
          )
        )
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              candidates: [{ content: { parts: [{ text: JSON.stringify(mockData) }] } }],
            })
          )
        );
      globalThis.fetch = fetchMock;

      const result = await parseWithGemini(dummyPayload, "key_gemini");
      expect(result).toEqual(mockData);
    });

    it("fetchAvailableGeminiModels returns empty array if apiKey is missing", async () => {
      const models = await fetchAvailableGeminiModels("");
      expect(models).toEqual([]);
    });

    it("fetchAvailableGeminiModels filters and sorts models", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            models: [
              { name: "models/embedding-001", supportedGenerationMethods: ["embedContent"] },
              { name: "models/gemini-1.5-flash", supportedGenerationMethods: ["generateContent"] },
              { name: "models/gemini-2.5-flash", supportedGenerationMethods: ["generateContent"] },
            ],
          })
        )
      );
      globalThis.fetch = fetchMock;

      const models = await fetchAvailableGeminiModels("key_gemini");
      expect(models).toContain("gemini-2.5-flash");
      expect(models).toContain("gemini-1.5-flash");
      expect(models).not.toContain("embedding-001");
    });

    it("fetchAvailableGeminiModels throws error on HTTP error status", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(new Response("Unauthorized", { status: 401 }));
      globalThis.fetch = fetchMock;

      await expect(fetchAvailableGeminiModels("invalid_key")).rejects.toThrow("Failed to fetch models from Google: HTTP 401");
    });

    it("syncAvailableGeminiModels syncs models and sets active model", async () => {
      const fetchMock = vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            models: [
              { name: "models/gemini-3.1-flash", supportedGenerationMethods: ["generateContent"] },
              { name: "models/gemini-3.5-flash", supportedGenerationMethods: ["generateContent"] },
            ],
          })
        )
      );
      globalThis.fetch = fetchMock;

      const { db } = createMockD1();
      const { activeModel, models } = await syncAvailableGeminiModels("key_gemini", db);

      expect(activeModel).toBe("gemini-3.5-flash");
      expect(models).toContain("gemini-3.1-flash");
    });

    it("fetchAvailableGeminiModels drops tts/image models and ranks base flash first", async () => {
      globalThis.fetch = vi.fn().mockResolvedValueOnce(
        new Response(
          JSON.stringify({
            models: ["gemini-2.5-flash-preview-tts", "gemini-2.5-flash-image", "gemini-2.5-flash-lite", "gemini-2.5-flash"].map(
              (name) => ({ name: `models/${name}`, supportedGenerationMethods: ["generateContent"] })
            ),
          })
        )
      );
      const models = await fetchAvailableGeminiModels("key_gemini");
      expect(models).toEqual(["gemini-2.5-flash", "gemini-2.5-flash-lite"]);
    });

    it("syncAvailableGeminiModels throws when no models are discovered", async () => {
      const { db } = createMockD1();
      await expect(syncAvailableGeminiModels("", db)).rejects.toThrow();
    });

    it("resolveGeminiModelSequence is capped and ignores the discovered cache", async () => {
      const { db } = createMockD1({
        allResults: [
          { key: "gemini_active_model", value: "gemini-2.0-flash" },
          { key: "gemini_discovered_models", value: JSON.stringify(["a", "b", "c", "d", "e"]) },
        ],
      });
      const seq = await resolveGeminiModelSequence(db);
      expect(seq).toEqual(["gemini-2.0-flash", "gemini-3.1-flash", "gemini-2.5-flash"]);
    });

    it("resolveGeminiModelSequence resolves active model from db", async () => {
      const { db } = createMockD1({ allResults: [{ key: "gemini_active_model", value: "gemini-2.5-flash" }] });

      const seq = await resolveGeminiModelSequence(db);
      expect(seq[0]).toBe("gemini-2.5-flash");
    });
  });

  // ==========================================
  // 4. Handler test helpers
  // ==========================================
  interface TelegramCall {
    method: string;
    body: Record<string, unknown>;
  }
  interface SentMessage {
    chat_id: number;
    text: string;
    reply_markup?: { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> };
  }

  const baseEnv = (db: D1Database, extra: Partial<Env> = {}): Env => ({
    DB: db,
    TELEGRAM_BOT_TOKEN: "tok",
    GEMINI_API_KEY: "gem",
    ...extra,
  });

  interface NetworkOptions {
    /** JSON returned (as the model's text) by Gemini generateContent. */
    gemini?: unknown;
    /** HTTP status for Gemini generateContent (default 200). */
    geminiStatus?: number;
    /** HTTP status for Telegram getFile (default 200). */
    getFileStatus?: number;
  }

  /** Routes fetches by URL so tests do not depend on call order. */
  function mockNetwork(opts: NetworkOptions = {}) {
    const fetchMock = vi.fn(async (input: string, _init?: RequestInit) => {
      const url = String(input);
      if (url.includes("generativelanguage") && url.includes(":generateContent")) {
        if (opts.geminiStatus && opts.geminiStatus !== 200) {
          return new Response(JSON.stringify({ error: { message: "busy" } }), { status: opts.geminiStatus });
        }
        return new Response(
          JSON.stringify({ candidates: [{ content: { parts: [{ text: JSON.stringify(opts.gemini ?? {}) }] } }] })
        );
      }
      if (url.includes("/getFile")) {
        return new Response(JSON.stringify({ ok: true, result: { file_path: "photos/r.jpg" } }), {
          status: opts.getFileStatus ?? 200,
        });
      }
      if (url.includes("/file/bot")) {
        return new Response(new Uint8Array([1, 2, 3]));
      }
      return new Response(JSON.stringify({ ok: true }));
    });
    globalThis.fetch = fetchMock as unknown as typeof fetch;
    return fetchMock;
  }

  function telegramCalls(fetchMock: ReturnType<typeof mockNetwork>): TelegramCall[] {
    const calls: TelegramCall[] = [];
    for (const [url, init] of fetchMock.mock.calls) {
      const match = /api\.telegram\.org\/bot[^/]+\/(\w+)$/.exec(String(url));
      if (match) calls.push({ method: match[1], body: JSON.parse(String(init?.body ?? "{}")) });
    }
    return calls;
  }

  const sentMessages = (fetchMock: ReturnType<typeof mockNetwork>): SentMessage[] =>
    telegramCalls(fetchMock)
      .filter((c) => c.method === "sendMessage")
      .map((c) => c.body as unknown as SentMessage);

  async function runCommand(cmd: string, db: D1Database, extra: Partial<Env> = {}, chatId = 1111) {
    const fm = mockNetwork();
    await handleCommand(cmd, chatId, baseEnv(db, extra));
    return { fm, messages: sentMessages(fm) };
  }

  const buttons = (m: SentMessage) => (m.reply_markup?.inline_keyboard ?? []).flat().map((b) => b.callback_data);

  const post = (update: unknown, env: Env, ctx?: ExecutionContext) =>
    worker.fetch(
      new Request("https://example.com", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify(update),
      }),
      env,
      ctx
    );

  const expenseItem = (overrides: Record<string, unknown> = {}) => ({
    amount: 35000,
    category: "Food & Dining",
    description: "Sandwich",
    transaction_type: "expense",
    payment_method: "cash",
    ...overrides,
  });

  const localDateOffset = (days: number) =>
    new Date(Date.now() + 7 * 3600_000 + days * 86_400_000).toISOString().slice(0, 10);

  // ==========================================
  // 4.1 record helpers & db additions
  // ==========================================
  describe("buildTransactions()", () => {
    it("accepts a flat object and the transactions array", () => {
      expect(buildTransactions(expenseItem())).toHaveLength(1);
      const many = buildTransactions({ transactions: [expenseItem(), expenseItem({ amount: 5000 })] });
      expect(many.map((t) => t.amount)).toEqual([35000, 5000]);
    });

    it("drops entries without a positive amount and caps the list at 10", () => {
      const items = [expenseItem({ amount: 0 }), expenseItem({ amount: undefined })];
      expect(buildTransactions({ transactions: items })).toHaveLength(0);
      const many = Array.from({ length: 15 }, () => expenseItem());
      expect(buildTransactions({ transactions: many })).toHaveLength(10);
    });

    it("signs refunds negatively and marks credit cards as unpaid", () => {
      const [refund] = buildTransactions(expenseItem({ transaction_type: "refund" }));
      expect(refund.amount).toBe(-35000);
      const [card] = buildTransactions(expenseItem({ payment_method: "credit_card" }));
      expect(card).toMatchObject({ paymentMethod: "credit_card", isPaid: false });
      const [forced] = buildTransactions(expenseItem(), true);
      expect(forced.paymentMethod).toBe("credit_card");
    });

    it("keeps only valid back-dates from the past year", () => {
      const yesterday = localDateOffset(-1);
      expect(buildTransactions(expenseItem({ date: yesterday }))[0].date).toBe(yesterday);
      expect(buildTransactions(expenseItem({ date: localToday() }))[0].date).toBeUndefined();
      expect(buildTransactions(expenseItem({ date: localDateOffset(2) }))[0].date).toBeUndefined();
      expect(buildTransactions(expenseItem({ date: localDateOffset(-400) }))[0].date).toBeUndefined();
      expect(buildTransactions(expenseItem({ date: "2026-02-31" }))[0].date).toBeUndefined();
      expect(buildTransactions(expenseItem({ date: "yesterday" }))[0].date).toBeUndefined();
    });
  });

  describe("db additions", () => {
    it("insertExpense returns the new row id and honors a back-dated created_at", async () => {
      const { db, statements } = createMockD1({ runMeta: { last_row_id: 77 } });
      const id = await insertExpense(db, "u1", 1000, "Other", "x", "cash", 1, "2026-10-01 05:00:00");
      expect(id).toBe(77);
      expect(statements[0].sql).toContain("created_at");
      expect(statements[0].bindings.at(-1)).toBe("2026-10-01 05:00:00");
    });

    it("claimTelegramUpdate reports whether the update was newly claimed", async () => {
      expect(await claimTelegramUpdate(createMockD1({ runMeta: { changes: 1 } }).db, 5)).toBe(true);
      expect(await claimTelegramUpdate(createMockD1({ runMeta: { changes: 0 } }).db, 5)).toBe(false);
    });

    it("getRecentExpenses clamps the limit", async () => {
      const { db, statements } = createMockD1();
      await getRecentExpenses(db, "u1", 9999);
      expect(statements[0].bindings).toEqual(["u1", 50]);
    });

    it("deleteExpenseById scopes to the user when given", async () => {
      const { db, statements } = createMockD1({ runMeta: { changes: 1 } });
      expect(await deleteExpenseById(db, 3, "u1")).toBe(true);
      expect(statements[0].bindings).toEqual([3, "u1"]);
    });
  });

  // ==========================================
  // 4.2 handleCommand
  // ==========================================
  describe("handleCommand()", () => {
    it("/start welcomes the user and registers the command menu", async () => {
      const { fm, messages } = await runCommand("/start", createMockD1().db);
      expect(messages[0].text).toContain("Chào bạn");
      const setCommands = telegramCalls(fm).find((c) => c.method === "setMyCommands");
      const names = (setCommands?.body.commands as Array<{ command: string }>).map((c) => c.command);
      expect(names).toEqual(expect.arrayContaining(["today", "month", "debt", "delete"]));
    });

    it("/help lists Vietnamese aliases and hides /model from non-admins", async () => {
      const user = await runCommand("/help", createMockD1().db, { ADMIN_CHAT_ID: "1" });
      expect(user.messages[0].text).toContain("/homnay");
      expect(user.messages[0].text).not.toContain("/model");
      const admin = await runCommand("/help", createMockD1().db, { ADMIN_CHAT_ID: "1111" });
      expect(admin.messages[0].text).toContain("/model");
    });

    it("replies to unknown commands and accepts the @botname suffix", async () => {
      const unknown = await runCommand("/abc", createMockD1().db);
      expect(unknown.messages[0].text).toContain("chưa có lệnh");
      const suffixed = await runCommand("/today@my_bot", createMockD1().db);
      expect(suffixed.messages[0].text).toContain("chưa có giao dịch");
    });

    it("/today lists transactions, escapes HTML and totals the net amount", async () => {
      const { db } = createMockD1({
        allResults: [
          { id: 1, amount: 45000, category: "Food & Dining", description: "Phở <bò>", payment_method: "cash" },
          { id: 2, amount: 20000, category: "Shopping", description: "Áo", payment_method: "credit_card" },
          { id: 3, amount: -10000, category: "Shopping", description: "Hoàn tiền", payment_method: "cash" },
        ],
      });
      const { messages } = await runCommand("/today", db);
      const text = messages[0].text;
      expect(text).toContain("45.000 ₫");
      expect(text).toContain("Ăn uống");
      expect(text).toContain("Phở &lt;bò&gt;");
      expect(text).toContain("💳");
      expect(text).toContain("🟢");
      expect(text).toContain("Tổng chi: 55.000 ₫");
    });

    it("/today shows a net surplus when refunds exceed expenses", async () => {
      const { db } = createMockD1({ allResults: [{ id: 1, amount: -50000, category: "Other", description: "Refund" }] });
      const { messages } = await runCommand("/homnay", db);
      expect(messages[0].text).toContain("Tiết kiệm ròng: 50.000 ₫");
    });

    it("/month reports category shares with bars and credit card totals", async () => {
      const { db, statements } = createMockD1({
        allResults: [
          { category: "Food & Dining", total_cat: 600000, count: 3 },
          { category: "Shopping", total_cat: 400000, count: 1 },
        ],
        firstResult: { card_total: 500000, unpaid_total: 200000 },
      });
      const { messages } = await runCommand("/month", db);
      const text = messages[0].text;
      expect(text).toContain("60%");
      expect(text).toContain("▓▓▓▓▓▓░░░░");
      expect(text).toContain("3 khoản");
      expect(text).toContain("Tổng chi thực tế: 1.000.000 ₫");
      expect(text).toContain("Quẹt thẻ: 500.000 ₫ (chưa trả: 200.000 ₫)");
      expect(statements[0].bindings).toEqual(["1111", null]);
    });

    it("/month prev queries the previous month; bad arguments are rejected", async () => {
      const { db, statements } = createMockD1({ allResults: [{ category: "Other", total_cat: 1000, count: 1 }] });
      const prev = await runCommand("/month prev", db);
      expect(statements[0].bindings).toEqual(["1111", localMonth(-1)]);
      expect(prev.messages[0].text).toContain(`${localMonth(-1).slice(5)}/${localMonth(-1).slice(0, 4)}`);

      const bad = await runCommand("/month 13-2026", createMockD1().db);
      expect(bad.messages[0].text).toContain("Tháng không hợp lệ");
    });

    it("/month and /week tell the user when nothing was recorded", async () => {
      expect((await runCommand("/month", createMockD1().db)).messages[0].text).toContain("Tháng này");
      expect((await runCommand("/month prev", createMockD1().db)).messages[0].text).toContain("Tháng đó");
      expect((await runCommand("/week", createMockD1().db)).messages[0].text).toContain("7 ngày qua");
    });

    it("/month shows a net surplus when refunds exceed spending", async () => {
      const { db } = createMockD1({ allResults: [{ category: "Shopping", total_cat: -30000, count: 1 }] });
      const { messages } = await runCommand("/month", db);
      expect(messages[0].text).toContain("Tiết kiệm ròng: 30.000 ₫");
      expect(messages[0].text).toContain("-30.000 ₫");
    });

    it("/week summarises the last 7 days", async () => {
      const { db } = createMockD1({ allResults: [{ category: "Transportation", total_cat: 80000, count: 4 }] });
      const { messages } = await runCommand("/week", db);
      expect(messages[0].text).toContain("7 ngày gần nhất");
      expect(messages[0].text).toContain("Di chuyển");
      expect(messages[0].text).toContain("100%");
    });

    it("/recent lists the latest transactions with IDs and local dates", async () => {
      const { db } = createMockD1({
        allResults: [
          { id: 7, amount: 30000, category: "Other", description: "Cafe", payment_method: "cash", created_at: "2026-10-25 03:00:00" },
        ],
      });
      const { messages } = await runCommand("/recent", db);
      expect(messages[0].text).toContain("#7");
      expect(messages[0].text).toContain("25/10");
      expect(messages[0].text).toContain("Cafe");
      expect((await runCommand("/recent", createMockD1().db)).messages[0].text).toContain("Chưa có giao dịch");
    });

    it("/delete asks for confirmation instead of deleting immediately", async () => {
      const { db, statements } = createMockD1({
        firstResult: { id: 5, amount: 45000, category: "Food & Dining", description: "Phở", payment_method: "cash" },
      });
      const { messages } = await runCommand("/delete", db);
      expect(messages[0].text).toContain("Xoá giao dịch này?");
      expect(messages[0].text).toContain("Phở");
      expect(buttons(messages[0])).toEqual(["del:5", "cancel"]);
      expect(statements.some((st) => st.sql.includes("DELETE"))).toBe(false);
    });

    it("/delete <id> targets a specific transaction and validates input", async () => {
      const row = { id: 12, amount: 1000, category: "Other", description: "x" };
      const found = await runCommand("/xoa 12", createMockD1({ firstResult: row }).db);
      expect(buttons(found.messages[0])).toEqual(["del:12", "cancel"]);

      expect((await runCommand("/delete abc", createMockD1().db)).messages[0].text).toContain("Số hiệu không hợp lệ");
      expect((await runCommand("/delete 99", createMockD1().db)).messages[0].text).toContain("Không tìm thấy");
      expect((await runCommand("/delete", createMockD1().db)).messages[0].text).toContain("Không có giao dịch");
    });

    it("/debt lists unpaid bills with pay buttons", async () => {
      const { db } = createMockD1({
        allResults: [
          { id: 5, amount: 100000, category: "Shopping", description: "Zara", created_at: "2026-10-20 03:00:00" },
          { id: 8, amount: 350000, category: "Food & Dining", description: "Dinner", created_at: "2026-10-21 03:00:00" },
        ],
      });
      const { messages } = await runCommand("/debt", db);
      expect(messages[0].text).toContain("#5");
      expect(messages[0].text).toContain("20/10/2026");
      expect(messages[0].text).toContain("Tổng nợ: 450.000 ₫");
      expect(buttons(messages[0])).toEqual(["pay:5", "pay:8", "payall"]);
    });

    it("/debt omits 'pay all' for a single bill and reports when there is no debt", async () => {
      const one = await runCommand("/nothe", createMockD1({ allResults: [{ id: 5, amount: 1000, description: "x" }] }).db);
      expect(buttons(one.messages[0])).toEqual(["pay:5"]);
      expect((await runCommand("/debt", createMockD1().db)).messages[0].text).toContain("Không có khoản thẻ");
    });

    it("/pay validates arguments", async () => {
      expect((await runCommand("/pay", createMockD1().db)).messages[0].text).toContain("/pay all");
      expect((await runCommand("/pay abc", createMockD1().db)).messages[0].text).toContain("Số hiệu không hợp lệ");
      expect((await runCommand("/pay 5", createMockD1().db)).messages[0].text).toContain("Không tìm thấy");
    });

    it("/pay <ids> settles bills and shows the remaining debt", async () => {
      const { db, statements } = createMockD1({
        allResults: [{ id: 5, amount: 100000, description: "Dinner" }],
      });
      const { messages } = await runCommand("/pay 5, 8", db);
      expect(messages[0].text).toContain("Đã ghi nhận thanh toán");
      expect(messages[0].text).toContain("#5: 100.000 ₫");
      expect(messages[0].text).toContain("Còn nợ");
      expect(statements.some((st) => st.sql.includes("UPDATE expenses"))).toBe(true);
    });

    it("/pay all asks for confirmation first", async () => {
      const { db, statements } = createMockD1({ allResults: [{ id: 5, amount: 100000, description: "Dinner" }] });
      const { messages } = await runCommand("/pay all", db);
      expect(messages[0].text).toContain("Trả hết");
      expect(messages[0].text).toContain("100.000 ₫");
      expect(buttons(messages[0])).toEqual(["payallok", "cancel"]);
      expect(statements.some((st) => st.sql.includes("UPDATE"))).toBe(false);

      expect((await runCommand("/pay all", createMockD1().db)).messages[0].text).toContain("Không có khoản thẻ");
    });

    it("/model shows the active model and options", async () => {
      const { messages } = await runCommand("/model", createMockD1().db);
      expect(messages[0].text).toContain("Cài đặt model Gemini AI");
      expect(messages[0].text).toContain("Model đang dùng:");
      expect(messages[0].text).toContain("/model auto");
    });

    it("/model auto synchronizes models from Google", async () => {
      const fetchMock = vi.fn(async (input: string, _init?: RequestInit) =>
        String(input).includes("/v1beta/models?key=")
          ? new Response(
              JSON.stringify({
                models: [
                  { name: "models/gemini-3.1-flash", supportedGenerationMethods: ["generateContent"] },
                  { name: "models/gemini-3.5-flash", supportedGenerationMethods: ["generateContent"] },
                ],
              })
            )
          : new Response(JSON.stringify({ ok: true }))
      );
      globalThis.fetch = fetchMock as unknown as typeof fetch;

      await handleCommand("/model auto", 7777, baseEnv(createMockD1().db, { ADMIN_CHAT_ID: "7777" }));
      const text = sentMessages(fetchMock as unknown as ReturnType<typeof mockNetwork>)[0].text;
      expect(text).toContain("Đã tự cập nhật model Gemini");
      expect(text).toContain("Model đang dùng:");
    });

    it("/model reset and /model <name> change the model for the admin", async () => {
      const env = { ADMIN_CHAT_ID: "7777" };
      const reset = await runCommand("/model reset", createMockD1().db, env, 7777);
      expect(reset.messages[0].text).toContain("gemini-3.1-flash");
      const named = await runCommand("/model gemini-3.5-flash", createMockD1().db, env, 7777);
      expect(named.messages[0].text).toContain("Đã đổi model Gemini sang: <b>gemini-3.5-flash</b>");
    });

    it("/model rejects non-admin chats and invalid names", async () => {
      const { db, statements } = createMockD1();
      const nonAdmin = await runCommand("/model gemini-2.5-pro", db, { ADMIN_CHAT_ID: "1" }, 7777);
      expect(nonAdmin.messages[0].text).toContain("Chỉ quản trị viên");
      const invalid = await runCommand("/model x#", db, { ADMIN_CHAT_ID: "1" }, 1);
      expect(invalid.messages[0].text).toContain("Tên model không hợp lệ");
      expect(statements).toHaveLength(0);
    });

    it("catches database exceptions and replies with a friendly error", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { db } = createMockD1({
        onExecute: () => {
          throw new Error("D1 down");
        },
      });
      const { messages } = await runCommand("/today", db);
      expect(messages[0].text).toContain("Có lỗi xảy ra");
      expect(messages[0].text).not.toContain("D1 down");
    });
  });

  // ==========================================
  // 4.3 Inline keyboard callbacks
  // ==========================================
  describe("handleCallbackQuery()", () => {
    const row = {
      id: 5,
      amount: 45000,
      category: "Food & Dining",
      description: "Phở",
      payment_method: "cash",
      is_paid: 1,
      created_at: "2020-01-01 03:00:00",
    };

    async function press(data: string, config: MockD1Config = { firstResult: row }) {
      const fm = mockNetwork();
      const mock = createMockD1(config);
      await handleCallbackQuery(
        { id: "cq1", data, message: { message_id: 50, chat: { id: 1111 } } },
        baseEnv(mock.db)
      );
      return { calls: telegramCalls(fm), statements: mock.statements };
    }

    const find = (calls: TelegramCall[], method: string) => calls.find((c) => c.method === method)?.body;

    it("del deletes the transaction and edits the message", async () => {
      const { calls, statements } = await press("del:5");
      const del = statements.find((st) => st.sql.includes("DELETE"));
      expect(del?.bindings).toEqual([5, "1111"]);
      expect(String(find(calls, "editMessageText")?.text)).toContain("Đã xoá");
      expect(find(calls, "answerCallbackQuery")?.callback_query_id).toBe("cq1");
    });

    it("explains when the transaction no longer exists", async () => {
      const { calls, statements } = await press("del:5", { firstResult: null });
      expect(statements.some((st) => st.sql.includes("DELETE"))).toBe(false);
      expect(String(find(calls, "answerCallbackQuery")?.text)).toContain("không còn");
    });

    it("cat opens the category picker and back restores the actions", async () => {
      const cat = await press("cat:5");
      const picker = (find(cat.calls, "editMessageReplyMarkup")?.reply_markup as SentMessage["reply_markup"])
        ?.inline_keyboard.flat();
      expect(picker).toHaveLength(9);
      expect(picker?.[1]).toMatchObject({ text: "Mua sắm", callback_data: "setcat:5:1" });

      const back = await press("back:5");
      const actions = (find(back.calls, "editMessageReplyMarkup")?.reply_markup as SentMessage["reply_markup"])
        ?.inline_keyboard.flat()
        .map((b) => b.callback_data);
      expect(actions).toContain("del:5");
    });

    it("setcat updates the category and refreshes the message", async () => {
      const { calls, statements } = await press("setcat:5:1");
      const upd = statements.find((st) => st.sql.includes("UPDATE expenses SET category"));
      expect(upd?.bindings).toEqual(["Shopping", 5, "1111"]);
      expect(String(find(calls, "editMessageText")?.text)).toContain("Mua sắm");
    });

    it("setcat ignores an out-of-range category", async () => {
      const { statements } = await press("setcat:5:99");
      expect(statements.some((st) => st.sql.includes("UPDATE"))).toBe(false);
    });

    it("card toggles between cash and credit card", async () => {
      const toCard = await press("card:5");
      const upd = toCard.statements.find((st) => st.sql.includes("payment_method = ?"));
      expect(upd?.bindings).toEqual(["credit_card", 0, 5, "1111"]);
      expect(String(find(toCard.calls, "editMessageText")?.text)).toContain("chưa trả");

      const toCash = await press("card:5", { firstResult: { ...row, payment_method: "credit_card", is_paid: 0 } });
      const upd2 = toCash.statements.find((st) => st.sql.includes("payment_method = ?"));
      expect(upd2?.bindings).toEqual(["cash", 1, 5, "1111"]);
    });

    it("pay settles one bill, payall asks, payallok settles all, cancel dismisses", async () => {
      const bills = { allResults: [{ id: 5, amount: 100000, description: "Dinner" }] };
      const pay = await press("pay:5", bills);
      expect(String(find(pay.calls, "sendMessage")?.text)).toContain("Đã ghi nhận thanh toán");

      const ask = await press("payall", bills);
      expect(String(find(ask.calls, "sendMessage")?.text)).toContain("Trả hết");

      const ok = await press("payallok", bills);
      expect(String(find(ok.calls, "editMessageText")?.text)).toContain("Đã ghi nhận thanh toán");

      const cancel = await press("cancel");
      expect(String(find(cancel.calls, "editMessageText")?.text)).toContain("Đã huỷ");
    });

    it("answers (and does nothing else) for malformed or message-less queries", async () => {
      const fm = mockNetwork();
      const env = baseEnv(createMockD1().db);
      await handleCallbackQuery({ id: "x", data: "del:5" }, env);
      await handleCallbackQuery({ id: "y", data: "weird", message: { message_id: 1, chat: { id: 1 } } }, env);
      expect(telegramCalls(fm).every((c) => c.method === "answerCallbackQuery")).toBe(true);
    });

    it("surfaces callback failures as a toast without throwing", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const { calls } = await press("del:5", {
        onExecute: () => {
          throw new Error("D1 down");
        },
      });
      expect(String(find(calls, "answerCallbackQuery")?.text)).toContain("Có lỗi xảy ra");
    });

    it("is routed from worker.fetch when a callback_query update arrives", async () => {
      const fm = mockNetwork();
      const { db } = createMockD1({ firstResult: row });
      const res = await post(
        { callback_query: { id: "cq9", data: "cat:5", message: { message_id: 3, chat: { id: 1111 } } } },
        baseEnv(db)
      );
      expect(await res.text()).toBe("OK");
      expect(telegramCalls(fm).map((c) => c.method)).toContain("editMessageReplyMarkup");
    });
  });

  // ==========================================
  // 5. worker.fetch
  // ==========================================
  describe("worker.fetch()", () => {
    it("returns 'Bot is running!' for non-POST HTTP methods", async () => {
      const env = baseEnv(createMockD1().db);
      for (const method of ["GET", "PUT"]) {
        const res = await worker.fetch(new Request("https://example.com/webhook", { method }), env);
        expect(await res.text()).toBe("Bot is running!");
      }
    });

    it("returns HTTP 500 when env parameter is missing or undefined", async () => {
      const res = await worker.fetch(new Request("https://example.com", { method: "POST" }), null as unknown as Env);
      expect(res.status).toBe(500);
      expect(await res.text()).toBe("Error: Worker environment is unconfigured");
    });

    // ------------------------------------------
    // Apple Shortcut Flow
    // ------------------------------------------
    describe("Apple Shortcut Flow", () => {
      const shortcut = (extra: Record<string, unknown> = {}) => ({ source: "shortcut", text: "Lunch 50k", ...extra });

      it("returns 500 if env.DB is not configured", async () => {
        const res = await post(shortcut(), { TELEGRAM_BOT_TOKEN: "t", GEMINI_API_KEY: "g" } as unknown as Env);
        expect(res.status).toBe(500);
        expect(await res.text()).toContain("cơ sở dữ liệu");
      });

      it("returns 400 for empty text", async () => {
        const fm = mockNetwork();
        const res = await post(shortcut({ text: "   " }), baseEnv(createMockD1().db));
        expect(res.status).toBe(400);
        expect(fm).not.toHaveBeenCalled();
      });

      it("returns friendly, non-2xx errors when parsing fails", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        mockNetwork({ gemini: { error: "cannot_parse", transactions: [] } });
        const res = await post(shortcut(), baseEnv(createMockD1().db));
        expect(res.status).toBe(422);
        const text = await res.text();
        expect(text).toContain("chưa hiểu");
        expect(text).not.toContain("cannot_parse");
        expect(text).not.toContain("<code>");

        mockNetwork({ geminiStatus: 503 });
        const busy = await post(shortcut(), baseEnv(createMockD1().db));
        expect(busy.status).toBe(503);
        expect(await busy.text()).toContain("quá tải");
      });

      it("returns 422 when no amount is found", async () => {
        mockNetwork({ gemini: { transactions: [expenseItem({ amount: 0 })] } });
        const res = await post(shortcut(), baseEnv(createMockD1().db));
        expect(res.status).toBe(422);
        expect(await res.text()).toContain("số tiền");
      });

      it("saves an expense under the default user with a plain-text reply", async () => {
        mockNetwork({ gemini: { transactions: [expenseItem({ amount: 45000, description: "Lunch" })] } });
        const { db, statements } = createMockD1();
        const res = await post(shortcut(), baseEnv(db));
        expect(res.status).toBe(200);
        const text = await res.text();
        expect(text).toContain("Đã ghi 🔴 Chi tiêu");
        expect(text).toContain("45.000 ₫");
        expect(text).not.toContain("<b>");
        const insert = statements.find((st) => st.sql.includes("INSERT INTO expenses"));
        expect(insert?.bindings).toEqual(["iphone_user", 45000, "Food & Dining", "Lunch", "cash", 1]);
      });

      it("stores under SHORTCUT_USER_ID, then ADMIN_CHAT_ID, unless user_id is sent", async () => {
        const userOf = async (extra: Partial<Env>, body: Record<string, unknown> = {}) => {
          mockNetwork({ gemini: { transactions: [expenseItem()] } });
          const { db, statements } = createMockD1();
          await post(shortcut(body), baseEnv(db, extra));
          return statements.find((st) => st.sql.includes("INSERT INTO expenses"))?.bindings[0];
        };
        expect(await userOf({ ADMIN_CHAT_ID: "7777" })).toBe("7777");
        expect(await userOf({ ADMIN_CHAT_ID: "7777", SHORTCUT_USER_ID: "8888" })).toBe("8888");
        expect(await userOf({ ADMIN_CHAT_ID: "7777", SHORTCUT_USER_ID: "8888" }, { user_id: "alice" })).toBe("alice");
      });

      it("saves refunds as negative amounts", async () => {
        mockNetwork({ gemini: { transactions: [expenseItem({ transaction_type: "refund", amount: 120000 })] } });
        const { db, statements } = createMockD1();
        const res = await post(shortcut(), baseEnv(db));
        expect(await res.text()).toContain("Hoàn tiền");
        const insert = statements.find((st) => st.sql.includes("INSERT INTO expenses"));
        expect(insert?.bindings[1]).toBe(-120000);
      });

      it("falls back to 'Other' and 'Transaction' when category/description are missing", async () => {
        mockNetwork({ gemini: { transactions: [{ amount: 1000, transaction_type: "expense" }] } });
        const { db, statements } = createMockD1();
        await post(shortcut(), baseEnv(db));
        const insert = statements.find((st) => st.sql.includes("INSERT INTO expenses"));
        expect(insert?.bindings.slice(2, 4)).toEqual(["Other", "Transaction"]);
      });

      it("records credit card spending as unpaid, from Gemini or the payload override", async () => {
        const run = async (item: Record<string, unknown>, body: Record<string, unknown> = {}) => {
          mockNetwork({ gemini: { transactions: [item] } });
          const { db, statements } = createMockD1();
          const res = await post(shortcut(body), baseEnv(db));
          const insert = statements.find((st) => st.sql.includes("INSERT INTO expenses"));
          return { text: await res.text(), bindings: insert?.bindings };
        };
        const viaAi = await run(expenseItem({ payment_method: "credit_card" }));
        expect(viaAi.bindings?.slice(4)).toEqual(["credit_card", 0]);
        expect(viaAi.text).toContain("/debt");
        const viaPayload = await run(expenseItem(), { payment_method: "credit_card" });
        expect(viaPayload.bindings?.slice(4)).toEqual(["credit_card", 0]);
      });

      it("records several transactions from one message", async () => {
        mockNetwork({
          gemini: { transactions: [expenseItem({ description: "Cafe", amount: 30000 }), expenseItem({ description: "Gửi xe", amount: 5000 })] },
        });
        const { db, statements } = createMockD1();
        const text = await (await post(shortcut(), baseEnv(db))).text();
        expect(statements.filter((st) => st.sql.includes("INSERT INTO expenses"))).toHaveLength(2);
        expect(text).toContain("Cafe");
        expect(text).toContain("Gửi xe");
      });

      it("returns HTTP 500 without leaking details if the insert fails", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        mockNetwork({ gemini: { transactions: [expenseItem()] } });
        const { db } = createMockD1({
          onExecute: (st) => {
            if (st.sql.includes("INSERT INTO expenses")) throw new Error("D1 exploded");
          },
        });
        const res = await post(shortcut(), baseEnv(db));
        expect(res.status).toBe(500);
        expect(await res.text()).not.toContain("D1 exploded");
      });
    });

    // ------------------------------------------
    // Telegram Webhook Flow
    // ------------------------------------------
    describe("Telegram Webhook Flow", () => {
      const textUpdate = (text = "Sandwich 35k", extra: Record<string, unknown> = {}) => ({
        message: { chat: { id: 998877 }, text },
        ...extra,
      });
      const inserts = (statements: ExecutedStatement[]) =>
        statements.filter((st) => st.sql.includes("INSERT INTO expenses"));

      it("ignores updates without a message or chat", async () => {
        const fm = mockNetwork();
        for (const update of [{}, { message: { text: "hi" } }]) {
          expect(await (await post(update, baseEnv(createMockD1().db))).text()).toBe("OK");
        }
        expect(fm).not.toHaveBeenCalled();
      });

      it("does not crash on an invalid JSON body", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const res = await worker.fetch(
          new Request("https://example.com", { method: "POST", body: "{not json" }),
          baseEnv(createMockD1().db)
        );
        expect(await res.text()).toBe("OK");
      });

      it("alerts the user if env.DB is not configured", async () => {
        const fm = mockNetwork();
        await post(textUpdate(), { TELEGRAM_BOT_TOKEN: "t", GEMINI_API_KEY: "g" } as unknown as Env);
        expect(sentMessages(fm)[0].text).toContain("cơ sở dữ liệu");
      });

      it("delegates slash commands to handleCommand", async () => {
        const fm = mockNetwork();
        await post(textUpdate("/help"), baseEnv(createMockD1().db));
        expect(sentMessages(fm)[0].text).toContain("Hướng dẫn sử dụng");
      });

      it("records a text expense, shows typing first and attaches action buttons", async () => {
        const fm = mockNetwork({ gemini: { transactions: [expenseItem()] } });
        const { db, statements } = createMockD1({ runMeta: { last_row_id: 42 } });

        const res = await post(textUpdate(), baseEnv(db));
        expect(await res.text()).toBe("OK");

        expect(inserts(statements)[0].bindings).toEqual(["998877", 35000, "Food & Dining", "Sandwich", "cash", 1]);
        const methods = telegramCalls(fm).map((c) => c.method);
        expect(methods[0]).toBe("sendChatAction");
        expect(telegramCalls(fm)[0].body.action).toBe("typing");

        const [reply] = sentMessages(fm);
        expect(reply.text).toContain("<b>Đã ghi 🔴 Chi tiêu</b>");
        expect(reply.text).toContain("35.000 ₫");
        expect(reply.text).toContain("Ăn uống");
        expect(buttons(reply)).toEqual(["del:42", "cat:42", "card:42"]);
      });

      it("omits buttons when the row id is unknown", async () => {
        const fm = mockNetwork({ gemini: { transactions: [expenseItem()] } });
        await post(textUpdate(), baseEnv(createMockD1().db));
        expect(sentMessages(fm)[0].reply_markup).toBeUndefined();
      });

      it("still understands the legacy flat Gemini object", async () => {
        const fm = mockNetwork({ gemini: expenseItem({ amount: 20000 }) });
        const { db, statements } = createMockD1();
        await post(textUpdate(), baseEnv(db));
        expect(inserts(statements)[0].bindings[1]).toBe(20000);
        expect(sentMessages(fm)[0].text).toContain("20.000 ₫");
      });

      it("records every transaction found in one message", async () => {
        const fm = mockNetwork({
          gemini: { transactions: [expenseItem({ description: "Cafe", amount: 30000 }), expenseItem({ description: "Gửi xe", amount: 5000 })] },
        });
        const { db, statements } = createMockD1({ runMeta: { last_row_id: 1 } });
        await post(textUpdate("Cafe 30k, gửi xe 5k"), baseEnv(db));
        expect(inserts(statements)).toHaveLength(2);
        expect(sentMessages(fm)).toHaveLength(2);
      });

      it("records refunds with a negative amount and no card toggle", async () => {
        const fm = mockNetwork({ gemini: { transactions: [expenseItem({ transaction_type: "refund", amount: 100000 })] } });
        const { db, statements } = createMockD1({ runMeta: { last_row_id: 9 } });
        await post(textUpdate("Hoàn Shopee 100k"), baseEnv(db));
        expect(inserts(statements)[0].bindings[1]).toBe(-100000);
        const [reply] = sentMessages(fm);
        expect(reply.text).toContain("Hoàn tiền");
        expect(buttons(reply)).toEqual(["del:9", "cat:9"]);
      });

      it("records credit card expenses as unpaid debt", async () => {
        const fm = mockNetwork({ gemini: { transactions: [expenseItem({ payment_method: "credit_card", amount: 300000 })] } });
        const { db, statements } = createMockD1({ runMeta: { last_row_id: 3 } });
        await post(textUpdate("Dinner 300k quẹt thẻ"), baseEnv(db));
        expect(inserts(statements)[0].bindings.slice(4)).toEqual(["credit_card", 0]);
        const [reply] = sentMessages(fm);
        expect(reply.text).toContain("chưa trả");
        expect(reply.text).toContain("/debt");
        expect(buttons(reply)).toContain("card:3");
      });

      it("back-dates a transaction mentioned for a past day, and ignores future dates", async () => {
        const yesterday = localDateOffset(-1);
        const fm = mockNetwork({ gemini: { transactions: [expenseItem({ date: yesterday })] } });
        const past = createMockD1();
        await post(textUpdate("Hôm qua ăn phở 35k"), baseEnv(past.db));
        const insert = inserts(past.statements)[0];
        expect(insert.sql).toContain("created_at");
        expect(insert.bindings.at(-1)).toBe(`${yesterday} 05:00:00`);
        expect(sentMessages(fm)[0].text).toContain("Ngày:");

        mockNetwork({ gemini: { transactions: [expenseItem({ date: localDateOffset(3) })] } });
        const future = createMockD1();
        await post(textUpdate(), baseEnv(future.db));
        expect(inserts(future.statements)[0].bindings).toHaveLength(6);
      });

      it("escapes user-controlled text in replies", async () => {
        const fm = mockNetwork({ gemini: { transactions: [expenseItem({ description: "<b>Grab_food</b> & *co*" })] } });
        await post(textUpdate(), baseEnv(createMockD1().db));
        expect(sentMessages(fm)[0].text).toContain("&lt;b&gt;Grab_food&lt;/b&gt; &amp; *co*");
      });

      it("shows friendly messages for unrecognized input, hiding raw error codes", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const fm = mockNetwork({ gemini: { error: "cannot_parse", transactions: [] } });
        await post(textUpdate("xin chào"), baseEnv(createMockD1().db));
        const text = sentMessages(fm)[0].text;
        expect(text).toContain("chưa hiểu");
        expect(text).not.toContain("cannot_parse");

        const busy = mockNetwork({ geminiStatus: 503 });
        await post(textUpdate(), baseEnv(createMockD1().db));
        expect(sentMessages(busy)[0].text).toContain("quá tải");
        expect(sentMessages(busy)[0].text).not.toContain("busy");
      });

      it("asks for the amount when Gemini finds none", async () => {
        const fm = mockNetwork({ gemini: { transactions: [expenseItem({ amount: 0 })] } });
        const { db, statements } = createMockD1();
        await post(textUpdate(), baseEnv(db));
        expect(sentMessages(fm)[0].text).toContain("số tiền");
        expect(inserts(statements)).toHaveLength(0);
      });

      it("processes a receipt photo (download -> Gemini Vision -> D1 -> reply)", async () => {
        const fm = mockNetwork({ gemini: { transactions: [expenseItem({ description: "Receipt" })] } });
        const { db, statements } = createMockD1();
        await post(
          { message: { chat: { id: 5 }, caption: "Highlands", photo: [{ file_id: "small" }, { file_id: "large" }] } },
          baseEnv(db)
        );

        const getFile = fm.mock.calls.find(([u]) => String(u).includes("getFile"))?.[0];
        expect(String(getFile)).toContain("file_id=large");
        const gemini = fm.mock.calls.find(([u]) => String(u).includes(":generateContent"));
        const parts = (JSON.parse(String(gemini?.[1]?.body)) as { contents: Array<{ parts: Array<Record<string, unknown>> }> })
          .contents[0].parts;
        expect(parts[0].text).toBe("Highlands");
        expect(parts[1].inline_data).toMatchObject({ mime_type: "image/jpeg" });
        expect(inserts(statements)).toHaveLength(1);
        expect(sentMessages(fm)[0].text).toContain("Receipt");
      });

      it("also accepts images sent as a file (document)", async () => {
        const fm = mockNetwork({ gemini: { transactions: [expenseItem()] } });
        await post(
          { message: { chat: { id: 5 }, document: { file_id: "doc1", mime_type: "image/png" } } },
          baseEnv(createMockD1().db)
        );
        const gemini = fm.mock.calls.find(([u]) => String(u).includes(":generateContent"));
        expect(String(gemini?.[1]?.body)).toContain('"mime_type":"image/png"');
        expect(sentMessages(fm)[0].text).toContain("Đã ghi");
      });

      it("tells the user when the photo cannot be downloaded", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const fm = mockNetwork({ getFileStatus: 500 });
        await post({ message: { chat: { id: 5 }, photo: [{ file_id: "p" }] } }, baseEnv(createMockD1().db));
        expect(sentMessages(fm)[0].text).toContain("không tải được ảnh");
      });

      it("replies to unsupported content (stickers, non-image files) instead of staying silent", async () => {
        const fm = mockNetwork();
        await post({ message: { chat: { id: 5 }, sticker: {} } }, baseEnv(createMockD1().db));
        await post(
          { message: { chat: { id: 5 }, document: { file_id: "d", mime_type: "application/pdf" } } },
          baseEnv(createMockD1().db)
        );
        const messages = sentMessages(fm);
        expect(messages).toHaveLength(2);
        expect(messages.every((m) => m.text.includes("văn bản và ảnh"))).toBe(true);
      });

      it("informs the user when the database insert fails", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const fm = mockNetwork({ gemini: { transactions: [expenseItem()] } });
        const { db } = createMockD1({
          onExecute: (st) => {
            if (st.sql.includes("INSERT INTO expenses")) throw new Error("D1 down");
          },
        });
        await post(textUpdate(), baseEnv(db));
        expect(sentMessages(fm)[0].text).toContain("Không lưu được");
      });

      it("skips an update_id that was already claimed (Telegram retry)", async () => {
        const fm = mockNetwork({ gemini: { transactions: [expenseItem()] } });
        const retry = createMockD1({ runMeta: { changes: 0 } });
        expect(await (await post(textUpdate("x", { update_id: 10 }), baseEnv(retry.db))).text()).toBe("OK");
        expect(fm).not.toHaveBeenCalled();
        expect(inserts(retry.statements)).toHaveLength(0);

        const fresh = createMockD1({ runMeta: { changes: 1 } });
        await post(textUpdate("x", { update_id: 11 }), baseEnv(fresh.db));
        expect(inserts(fresh.statements)).toHaveLength(1);
      });

      it("processes in ctx.waitUntil so the webhook returns without waiting", async () => {
        const fm = mockNetwork({ gemini: { transactions: [expenseItem()] } });
        const pending: Promise<unknown>[] = [];
        const ctx = { waitUntil: (p: Promise<unknown>) => void pending.push(p) } as unknown as ExecutionContext;

        const res = await post(textUpdate(), baseEnv(createMockD1().db), ctx);
        expect(await res.text()).toBe("OK");
        expect(pending).toHaveLength(1);
        await Promise.all(pending);
        expect(sentMessages(fm)).toHaveLength(1);
      });
    });
  });
});
