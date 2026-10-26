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
            meta: mockMeta,
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
      expect(formatAmount(NaN)).toBe("₫0");
      expect(formatAmount(Infinity)).toBe("₫0");
      expect(formatAmount(-Infinity)).toBe("₫0");
      expect(formatAmount(0)).toBe("₫0");
      expect(formatCurrency(NaN)).toBe("₫0");
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
    it("sends POST request to Telegram sendMessage API with Markdown parse mode", async () => {
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
        parse_mode: "Markdown",
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

    it("retries without Markdown parse mode if Telegram returns 400 parse error", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(JSON.stringify({ ok: false, description: "Bad Request: can't parse entities" }), {
            status: 400,
          })
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));

      globalThis.fetch = fetchMock;

      await sendTelegram("bot_tok", 12345, "Unmatched * asterisk");

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const secondInit = fetchMock.mock.calls[1]?.[1] as RequestInit;
      const body = JSON.parse(secondInit.body as string) as { parse_mode?: string };
      expect(body.parse_mode).toBeUndefined();
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
      expect(body.system_instruction.parts[0]?.text).toBe(SYSTEM_PROMPT);
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
  // 4. handleCommand
  // ==========================================
  describe("handleCommand()", () => {
    it("/start or /help: sends bot instructions message", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
      globalThis.fetch = fetchMock;

      const { db } = createMockD1();
      const env: Env = {
        DB: db,
        TELEGRAM_BOT_TOKEN: "tok_123",
        GEMINI_API_KEY: "gem_123",
      };

      await handleCommand("/start", 1111, env);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { text: string };
      expect(body.text).toContain("Available Commands:");
      expect(body.text).toContain("/today");
      expect(body.text).toContain("/month");
      expect(body.text).toContain("/delete");
    });

    it("/help: sends the same command guide as /start", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
      globalThis.fetch = fetchMock;

      const { db } = createMockD1();
      const env: Env = {
        DB: db,
        TELEGRAM_BOT_TOKEN: "tok_123",
        GEMINI_API_KEY: "gem_123",
      };

      await handleCommand("/help", 1112, env);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { text: string };
      expect(body.text).toContain("Available Commands:");
    });

    it("/today: notifies when no transactions are recorded today", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
      globalThis.fetch = fetchMock;

      const { db } = createMockD1({ allResults: [] });
      const env: Env = {
        DB: db,
        TELEGRAM_BOT_TOKEN: "tok_123",
        GEMINI_API_KEY: "gem_123",
      };

      await handleCommand("/today", 2222, env);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { text: string };
      expect(body.text).toBe("📅 No transactions recorded today.");
    });

    it("/today: calculates net total with 🔴 for expenses and 🟢 for refunds", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
      globalThis.fetch = fetchMock;

      const { db } = createMockD1({
        allResults: [
          { amount: 50000, category: "Food & Dining", description: "Lunch" },
          { amount: -20000, category: "Food & Dining", description: "Split bill refund" },
        ],
      });
      const env: Env = {
        DB: db,
        TELEGRAM_BOT_TOKEN: "tok_123",
        GEMINI_API_KEY: "gem_123",
      };

      await handleCommand("/today", 3333, env);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { text: string };

      expect(body.text).toContain("📅 **Today's Transactions:**");
      expect(body.text).toContain("🔴 **₫50,000** - Food & Dining: Lunch");
      expect(body.text).toContain("🟢 **₫20,000** - Food & Dining: Split bill refund");
      expect(body.text).toContain("🔴 Total Spent:");
      expect(body.text).toContain("30,000");
    });

    it("/today: displays '🟢 Net Surplus:' when refunds exceed expenses", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
      globalThis.fetch = fetchMock;

      const { db } = createMockD1({
        allResults: [{ amount: -150000, category: "Shopping", description: "Order Refund" }],
      });
      const env: Env = {
        DB: db,
        TELEGRAM_BOT_TOKEN: "tok_123",
        GEMINI_API_KEY: "gem_123",
      };

      await handleCommand("/today", 4444, env);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { text: string };
      expect(body.text).toContain("🟢 Net Surplus:");
      expect(body.text).toContain("150,000");
    });

    it("/month: notifies when no transactions are recorded this month", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
      globalThis.fetch = fetchMock;

      const { db } = createMockD1({ allResults: [] });
      const env: Env = {
        DB: db,
        TELEGRAM_BOT_TOKEN: "tok_123",
        GEMINI_API_KEY: "gem_123",
      };

      await handleCommand("/month", 5555, env);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { text: string };
      expect(body.text).toBe("📊 No transactions recorded this month.");
    });

    it("/month: groups by category and computes actual monthly spending", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
      globalThis.fetch = fetchMock;

      const { db } = createMockD1({
        allResults: [
          { category: "Food & Dining", total_cat: 350000, count: 5 },
          { category: "Transportation", total_cat: 100000, count: 2 },
          { category: "Shopping", total_cat: -50000, count: 1 },
        ],
      });
      const env: Env = {
        DB: db,
        TELEGRAM_BOT_TOKEN: "tok_123",
        GEMINI_API_KEY: "gem_123",
      };

      await handleCommand("/month", 6666, env);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { text: string };

      expect(body.text).toContain("📊 **Monthly Expense Report:**");
      expect(body.text).toContain("• **Food & Dining**: ₫350,000");
      expect(body.text).toContain("• **Transportation**: ₫100,000");
      expect(body.text).toContain("• **Shopping**: -₫50,000");
      expect(body.text).toContain("🔴 Actual Total Spent:");
      expect(body.text).toContain("400,000");
    });

    it("/month: displays '🟢 Net Surplus:' when monthly grand total is negative", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
      globalThis.fetch = fetchMock;

      const { db } = createMockD1({
        allResults: [{ category: "Shopping", total_cat: -200000, count: 1 }],
      });
      const env: Env = {
        DB: db,
        TELEGRAM_BOT_TOKEN: "tok_123",
        GEMINI_API_KEY: "gem_123",
      };

      await handleCommand("/month", 7777, env);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { text: string };
      expect(body.text).toContain("🟢 Net Surplus:");
    });

    it("/delete: notifies when no transaction is found to delete", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
      globalThis.fetch = fetchMock;

      const { db } = createMockD1({ firstResult: null });
      const env: Env = {
        DB: db,
        TELEGRAM_BOT_TOKEN: "tok_123",
        GEMINI_API_KEY: "gem_123",
      };

      await handleCommand("/delete", 8888, env);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { text: string };
      expect(body.text).toBe("No transactions found.");
    });

    it("/delete: removes the latest expense transaction from database", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
      globalThis.fetch = fetchMock;

      const { db, statements } = createMockD1({
        firstResult: { id: 99, amount: 45000, description: "Noodles" },
      });
      const env: Env = {
        DB: db,
        TELEGRAM_BOT_TOKEN: "tok_123",
        GEMINI_API_KEY: "gem_123",
      };

      await handleCommand("/delete", 9999, env);

      const deleteStmt = statements.find((s) => s.sql.includes("DELETE FROM expenses"));
      expect(deleteStmt).toBeDefined();
      expect(deleteStmt?.bindings).toEqual([99]);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { text: string };
      expect(body.text).toContain("🗑 Deleted expense: **₫45,000** (Noodles)");
    });

    it("/delete: removes the latest refund transaction and identifies as refund", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
      globalThis.fetch = fetchMock;

      const { db, statements } = createMockD1({
        firstResult: { id: 101, amount: -80000, description: "Store Refund" },
      });
      const env: Env = {
        DB: db,
        TELEGRAM_BOT_TOKEN: "tok_123",
        GEMINI_API_KEY: "gem_123",
      };

      await handleCommand("/delete", 10101, env);

      const deleteStmt = statements.find((s) => s.sql.includes("DELETE FROM expenses"));
      expect(deleteStmt).toBeDefined();
      expect(deleteStmt?.bindings).toEqual([101]);

      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { text: string };
      expect(body.text).toContain("🗑 Deleted refund: **₫80,000** (Store Refund)");
    });

    it("does nothing for unrecognized commands", async () => {
      const fetchMock = vi.fn();
      globalThis.fetch = fetchMock;

      const { db } = createMockD1();
      const env: Env = {
        DB: db,
        TELEGRAM_BOT_TOKEN: "tok_123",
        GEMINI_API_KEY: "gem_123",
      };

      await handleCommand("/unknown_command_xyz", 1234, env);
      expect(fetchMock).not.toHaveBeenCalled();
    });

    it("catches database exception and informs user with error message", async () => {
      vi.spyOn(console, "error").mockImplementation(() => {});
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
      globalThis.fetch = fetchMock;

      const errorDb: D1Database = {
        prepare: () => {
          throw new Error("D1 connection lost");
        },
        withSession: () => ({ prepare: () => ({} as D1PreparedStatement), batch: () => Promise.resolve([]), getBookmark: () => null }),
        dump: async () => new ArrayBuffer(0),
        batch: async () => [],
        exec: async () => ({ count: 0, duration: 0 }),
      };

      const env: Env = {
        DB: errorDb,
        TELEGRAM_BOT_TOKEN: "tok_123",
        GEMINI_API_KEY: "gem_123",
      };

      await handleCommand("/today", 9999, env);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { text: string };
      expect(body.text).toContain("An error occurred while processing your request");
    });

    it("/debt: notifies when no unpaid credit card bills exist", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
      globalThis.fetch = fetchMock;

      const { db } = createMockD1({ allResults: [] });
      const env: Env = {
        DB: db,
        TELEGRAM_BOT_TOKEN: "tok_123",
        GEMINI_API_KEY: "gem_123",
      };

      await handleCommand("/debt", 5555, env);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { text: string };
      expect(body.text).toContain("No unpaid credit card bills found");
    });

    it("/debt: lists unpaid credit card bills with total and instructions", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
      globalThis.fetch = fetchMock;

      const mockUnpaid: ExpenseRow[] = [
        { id: 12, user_id: "5555", amount: 450000, category: "Shopping", description: "Zara jacket", payment_method: "credit_card", is_paid: 0, created_at: "2026-10-15 10:00:00" },
        { id: 15, user_id: "5555", amount: 120000, category: "Food & Dining", description: "Dinner", payment_method: "credit_card", is_paid: 0, created_at: "2026-10-18 19:00:00" },
      ];

      const { db } = createMockD1({ allResults: mockUnpaid as unknown as Record<string, unknown>[] });
      const env: Env = {
        DB: db,
        TELEGRAM_BOT_TOKEN: "tok_123",
        GEMINI_API_KEY: "gem_123",
      };

      await handleCommand("/debt", 5555, env);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { text: string };
      expect(body.text).toContain("Unpaid Credit Card Bills:");
      expect(body.text).toContain("#12");
      expect(body.text).toContain("Zara jacket");
      expect(body.text).toContain("#15");
      expect(body.text).toContain("Total Unpaid Debt:");
      expect(body.text).toContain("570,000");
      expect(body.text).toContain("/pay <id>");
    });

    it("/pay: prompts user to specify bill IDs when no arguments are provided", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
      globalThis.fetch = fetchMock;

      const { db } = createMockD1();
      const env: Env = {
        DB: db,
        TELEGRAM_BOT_TOKEN: "tok_123",
        GEMINI_API_KEY: "gem_123",
      };

      await handleCommand("/pay", 5555, env);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { text: string };
      expect(body.text).toContain("Please specify bill ID(s) to pay");
    });

    it("/pay: prompts error when invalid bill ID format is supplied", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
      globalThis.fetch = fetchMock;

      const { db } = createMockD1();
      const env: Env = {
        DB: db,
        TELEGRAM_BOT_TOKEN: "tok_123",
        GEMINI_API_KEY: "gem_123",
      };

      await handleCommand("/pay abc, xyz", 5555, env);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { text: string };
      expect(body.text).toContain("Invalid bill ID(s)");
    });

    it("/pay: marks specific bills as paid and shows remaining debt", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
      globalThis.fetch = fetchMock;

      const paidRows: ExpenseRow[] = [
        { id: 12, user_id: "5555", amount: 450000, category: "Shopping", description: "Zara jacket", payment_method: "credit_card", is_paid: 0 },
      ];

      const { db } = createMockD1({ allResults: paidRows as unknown as Record<string, unknown>[] });
      const env: Env = {
        DB: db,
        TELEGRAM_BOT_TOKEN: "tok_123",
        GEMINI_API_KEY: "gem_123",
      };

      await handleCommand("/pay 12", 5555, env);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { text: string };
      expect(body.text).toContain("Credit Card Payment Recorded:");
      expect(body.text).toContain("Paid 1 bill(s) totaling **₫450,000**");
      expect(body.text).toContain("#12");
    });

    it("/pay: marks all bills as paid with /pay all", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
      globalThis.fetch = fetchMock;

      const allRows: ExpenseRow[] = [
        { id: 12, user_id: "5555", amount: 450000, category: "Shopping", description: "Zara jacket", payment_method: "credit_card", is_paid: 0 },
        { id: 15, user_id: "5555", amount: 120000, category: "Food & Dining", description: "Dinner", payment_method: "credit_card", is_paid: 0 },
      ];

      const { db } = createMockD1({ allResults: allRows as unknown as Record<string, unknown>[] });
      const env: Env = {
        DB: db,
        TELEGRAM_BOT_TOKEN: "tok_123",
        GEMINI_API_KEY: "gem_123",
      };

      await handleCommand("/pay all", 5555, env);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { text: string };
      expect(body.text).toContain("Paid 2 bill(s) totaling **₫570,000**");
    });

    it("/pay: notifies when /pay all is called with no unpaid bills", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
      globalThis.fetch = fetchMock;

      const { db } = createMockD1({ allResults: [] });
      const env: Env = {
        DB: db,
        TELEGRAM_BOT_TOKEN: "tok_123",
        GEMINI_API_KEY: "gem_123",
      };

      await handleCommand("/pay all", 5555, env);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { text: string };
      expect(body.text).toContain("No unpaid credit card bills to pay");
    });

    it("/pay: notifies when specified IDs do not match any unpaid bills", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
      globalThis.fetch = fetchMock;

      const { db } = createMockD1({ allResults: [] });
      const env: Env = {
        DB: db,
        TELEGRAM_BOT_TOKEN: "tok_123",
        GEMINI_API_KEY: "gem_123",
      };

      await handleCommand("/pay 999", 5555, env);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { text: string };
      expect(body.text).toContain("No matching unpaid credit card bills found");
    });

    it("/model: shows active model and available options", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
      globalThis.fetch = fetchMock;

      const { db } = createMockD1();
      const env: Env = {
        DB: db,
        TELEGRAM_BOT_TOKEN: "tok_123",
        GEMINI_API_KEY: "gem_123",
      };

      await handleCommand("/model", 7777, env);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { text: string };
      expect(body.text).toContain("Gemini AI Model Settings");
      expect(body.text).toContain("Active Model:");
      expect(body.text).toContain("/model <name>");
      expect(body.text).toContain("/model auto");
    });

    it("/model auto: synchronizes models from Google and sets active model", async () => {
      const fetchMock = vi
        .fn()
        .mockResolvedValueOnce(
          new Response(
            JSON.stringify({
              models: [
                { name: "models/gemini-3.1-flash", supportedGenerationMethods: ["generateContent"] },
                { name: "models/gemini-3.5-flash", supportedGenerationMethods: ["generateContent"] },
              ],
            })
          )
        )
        .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));

      globalThis.fetch = fetchMock;

      const { db } = createMockD1();
      const env: Env = {
        DB: db,
        TELEGRAM_BOT_TOKEN: "tok_123",
        GEMINI_API_KEY: "gem_123",
        ADMIN_CHAT_ID: "7777",
      };

      await handleCommand("/model auto", 7777, env);

      expect(fetchMock).toHaveBeenCalledTimes(2);
      const [, init] = fetchMock.mock.calls[1] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { text: string };
      expect(body.text).toContain("Gemini AI Auto-Updated");
      expect(body.text).toContain("Active model set to:");
    });

    it("/model reset: resets active model to default", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
      globalThis.fetch = fetchMock;

      const { db } = createMockD1();
      const env: Env = {
        DB: db,
        TELEGRAM_BOT_TOKEN: "tok_123",
        GEMINI_API_KEY: "gem_123",
        ADMIN_CHAT_ID: "7777",
      };

      await handleCommand("/model reset", 7777, env);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { text: string };
      expect(body.text).toContain("Reset Gemini model to default: **gemini-3.1-flash**");
    });

    it("/model <name>: switches active model to specified name", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
      globalThis.fetch = fetchMock;

      const { db } = createMockD1();
      const env: Env = {
        DB: db,
        TELEGRAM_BOT_TOKEN: "tok_123",
        GEMINI_API_KEY: "gem_123",
        ADMIN_CHAT_ID: "7777",
      };

      await handleCommand("/model gemini-3.5-flash", 7777, env);

      expect(fetchMock).toHaveBeenCalledTimes(1);
      const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
      const body = JSON.parse(init.body as string) as { text: string };
      expect(body.text).toContain("Active Gemini model changed to: **gemini-3.5-flash**");
    });

    it("/model <name>: rejects non-admin chats and invalid names", async () => {
      const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
      globalThis.fetch = fetchMock;

      const { db, statements } = createMockD1();
      const env: Env = { DB: db, TELEGRAM_BOT_TOKEN: "tok_123", GEMINI_API_KEY: "gem_123", ADMIN_CHAT_ID: "1" };

      await handleCommand("/model gemini-2.5-pro", 7777, env);
      let body = JSON.parse((fetchMock.mock.calls[0] as [string, RequestInit])[1].body as string) as { text: string };
      expect(body.text).toContain("Only the bot admin");

      await handleCommand("/model x#", 1, env);
      body = JSON.parse((fetchMock.mock.calls[1] as [string, RequestInit])[1].body as string) as { text: string };
      expect(body.text).toContain("Invalid model name");
      expect(statements).toHaveLength(0);
    });
  });

  // ==========================================
  // 5. worker.fetch
  // ==========================================
  describe("worker.fetch()", () => {
    it("returns 'Bot is running!' for non-POST HTTP methods (GET, PUT...)", async () => {
      const { db } = createMockD1();
      const env: Env = {
        DB: db,
        TELEGRAM_BOT_TOKEN: "tok_123",
        GEMINI_API_KEY: "gem_123",
      };

      const getReq = new Request("https://example.com/webhook", { method: "GET" });
      const getRes = await worker.fetch(getReq, env);
      expect(await getRes.text()).toBe("Bot is running!");

      const putReq = new Request("https://example.com/webhook", { method: "PUT" });
      const putRes = await worker.fetch(putReq, env);
      expect(await putRes.text()).toBe("Bot is running!");
    });

    // ------------------------------------------
    // Apple Shortcut Flow
    // ------------------------------------------
    describe("Apple Shortcut Flow", () => {
      it("returns error if env.DB is not configured", async () => {
        const envWithoutDb = {
          DB: null as unknown as D1Database,
          TELEGRAM_BOT_TOKEN: "tok_123",
          GEMINI_API_KEY: "gem_123",
        };

        const req = new Request("https://example.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: "shortcut", text: "Coffee $3" }),
        });

        const res = await worker.fetch(req, envWithoutDb);
        expect(await res.text()).toBe("Error: Database not configured");
      });

      it("returns error message if Gemini parsing fails", async () => {
        const fetchMock = vi.fn().mockImplementation(() =>
          Promise.resolve(
            new Response(JSON.stringify({ error: { message: "API key expired" } }), {
              status: 401,
            })
          )
        );
        globalThis.fetch = fetchMock;

        const { db } = createMockD1();
        const env: Env = {
          DB: db,
          TELEGRAM_BOT_TOKEN: "tok_123",
          GEMINI_API_KEY: "gem_invalid",
        };

        const req = new Request("https://example.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: "shortcut", text: "Coffee $3" }),
        });

        const res = await worker.fetch(req, env);
        const text = await res.text();
        expect(text).toContain("⚠️ Error: AI service unavailable: API key expired");
      });

      it("returns warning message if Gemini fails to identify amount", async () => {
        const fetchMock = vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [{ text: JSON.stringify({ description: "Nice weather" }) }],
                  },
                },
              ],
            })
          )
        );
        globalThis.fetch = fetchMock;

        const { db } = createMockD1();
        const env: Env = {
          DB: db,
          TELEGRAM_BOT_TOKEN: "tok_123",
          GEMINI_API_KEY: "gem_123",
        };

        const req = new Request("https://example.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: "shortcut", text: "Nice weather today" }),
        });

        const res = await worker.fetch(req, env);
        expect(await res.text()).toBe("⚠️ Could not identify transaction amount.");
      });

      it("saves regular expense with default user_id 'iphone_user'", async () => {
        const mockGeminiData = {
          amount: 60000,
          category: "Food & Dining",
          description: "Chicken Pho",
          transaction_type: "expense",
        };

        const fetchMock = vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [{ text: JSON.stringify(mockGeminiData) }],
                  },
                },
              ],
            })
          )
        );
        globalThis.fetch = fetchMock;

        const { db, statements } = createMockD1();
        const env: Env = {
          DB: db,
          TELEGRAM_BOT_TOKEN: "tok_123",
          GEMINI_API_KEY: "gem_123",
        };

        const req = new Request("https://example.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: "shortcut", text: "Chicken Pho 60k" }),
        });

        const res = await worker.fetch(req, env);
        const text = await res.text();

        expect(text).toContain("✅ Saved 🔴 Expense:");
        expect(text).toContain("60,000");
        expect(text).toContain("Food & Dining");
        expect(text).toContain("Chicken Pho");

        const insertStmt = statements.find((s) => s.sql.includes("INSERT INTO expenses"));
        expect(insertStmt).toBeDefined();
        expect(insertStmt?.bindings).toEqual([
          "iphone_user",
          60000,
          "Food & Dining",
          "Chicken Pho",
          "cash",
          1,
        ]);
      });

      it("saves refund with custom user_id and negative amount", async () => {
        const mockGeminiData = {
          amount: 250000,
          category: "Shopping",
          description: "Hoodie refund",
          transaction_type: "refund",
        };

        const fetchMock = vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [{ text: JSON.stringify(mockGeminiData) }],
                  },
                },
              ],
            })
          )
        );
        globalThis.fetch = fetchMock;

        const { db, statements } = createMockD1();
        const env: Env = {
          DB: db,
          TELEGRAM_BOT_TOKEN: "tok_123",
          GEMINI_API_KEY: "gem_123",
        };

        const req = new Request("https://example.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({
            source: "shortcut",
            text: "Hoodie refund 250k",
            user_id: "my_custom_user_id",
          }),
        });

        const res = await worker.fetch(req, env);
        const text = await res.text();

        expect(text).toContain("✅ Saved 🟢 Refund / Cancellation:");
        expect(text).toContain("250,000");

        const insertStmt = statements.find((s) => s.sql.includes("INSERT INTO expenses"));
        expect(insertStmt).toBeDefined();
        expect(insertStmt?.bindings).toEqual([
          "my_custom_user_id",
          -250000,
          "Shopping",
          "Hoodie refund",
          "cash",
          1,
        ]);
      });

      it("uses default values 'Other' and 'Transaction' when Gemini omits category or description", async () => {
        const mockGeminiData = {
          amount: 50000,
          transaction_type: "expense",
        };

        const fetchMock = vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [{ text: JSON.stringify(mockGeminiData) }],
                  },
                },
              ],
            })
          )
        );
        globalThis.fetch = fetchMock;

        const { db, statements } = createMockD1();
        const env: Env = {
          DB: db,
          TELEGRAM_BOT_TOKEN: "tok_123",
          GEMINI_API_KEY: "gem_123",
        };

        const req = new Request("https://example.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: "shortcut", text: "50k" }),
        });

        const res = await worker.fetch(req, env);
        const text = await res.text();

        expect(text).toContain("🏷 Category: Other");
        expect(text).toContain("📝 Description: Transaction");

        const insertStmt = statements.find((s) => s.sql.includes("INSERT INTO expenses"));
        expect(insertStmt?.bindings).toEqual([
          "iphone_user",
          50000,
          "Other",
          "Transaction",
          "cash",
          1,
        ]);
      });

      it("saves credit card expense with is_paid = 0 and informs about /debt command", async () => {
        const mockGeminiData = {
          amount: 300000,
          category: "Shopping",
          description: "Zara jacket",
          transaction_type: "expense",
          payment_method: "credit_card",
        };

        const fetchMock = vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [{ text: JSON.stringify(mockGeminiData) }],
                  },
                },
              ],
            })
          )
        );
        globalThis.fetch = fetchMock;

        const { db, statements } = createMockD1();
        const env: Env = {
          DB: db,
          TELEGRAM_BOT_TOKEN: "tok_123",
          GEMINI_API_KEY: "gem_123",
        };

        const req = new Request("https://example.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: "shortcut", text: "Zara jacket 300k credit card" }),
        });

        const res = await worker.fetch(req, env);
        const text = await res.text();

        expect(text).toContain("💳 Credit Card Expense (Unpaid Debt)");
        expect(text).toContain("300,000");
        expect(text).toContain("/debt");

        const insertStmt = statements.find((s) => s.sql.includes("INSERT INTO expenses"));
        expect(insertStmt?.bindings).toEqual([
          "iphone_user",
          300000,
          "Shopping",
          "Zara jacket",
          "credit_card",
          0,
        ]);
      });

      it("returns error response if text is empty or whitespace", async () => {
        const { db } = createMockD1();
        const env: Env = {
          DB: db,
          TELEGRAM_BOT_TOKEN: "tok_123",
          GEMINI_API_KEY: "gem_123",
        };

        const req = new Request("https://example.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: "shortcut", text: "   " }),
        });

        const res = await worker.fetch(req, env);
        expect(await res.text()).toBe("⚠️ Error: Empty transaction text provided.");
      });

      it("returns HTTP 500 if database insert throws an exception", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const fetchMock = vi.fn().mockResolvedValue(
          new Response(
            JSON.stringify({
              candidates: [
                {
                  content: {
                    parts: [{ text: JSON.stringify({ amount: 50000, category: "Food & Dining", description: "Snack" }) }],
                  },
                },
              ],
            })
          )
        );
        globalThis.fetch = fetchMock;

        const errorDb: D1Database = {
          prepare: () => {
            throw new Error("Disk full");
          },
          withSession: () => ({ prepare: () => ({} as D1PreparedStatement), batch: () => Promise.resolve([]), getBookmark: () => null }),
          dump: async () => new ArrayBuffer(0),
          batch: async () => [],
          exec: async () => ({ count: 0, duration: 0 }),
        };

        const env: Env = {
          DB: errorDb,
          TELEGRAM_BOT_TOKEN: "tok_123",
          GEMINI_API_KEY: "gem_123",
        };

        const req = new Request("https://example.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ source: "shortcut", text: "Snack 50k" }),
        });

        const res = await worker.fetch(req, env);
        expect(res.status).toBe(500);
        expect(await res.text()).toContain("⚠️ Error: Disk full");
      });
    });

    // ------------------------------------------
    // Telegram Webhook Flow
    // ------------------------------------------
    describe("Telegram Webhook Flow", () => {
      it("ignores updates without message or chat entity", async () => {
        const { db } = createMockD1();
        const env: Env = {
          DB: db,
          TELEGRAM_BOT_TOKEN: "tok_123",
          GEMINI_API_KEY: "gem_123",
        };

        const req = new Request("https://example.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify({ update_id: 12345 }),
        });

        const res = await worker.fetch(req, env);
        expect(await res.text()).toBe("OK");
      });

      it("sends Telegram alert if env.DB is not configured", async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
        globalThis.fetch = fetchMock;

        const envWithoutDb = {
          DB: null as unknown as D1Database,
          TELEGRAM_BOT_TOKEN: "tok_123",
          GEMINI_API_KEY: "gem_123",
        };

        const update: WebhookUpdate = {
          message: {
            chat: { id: 123456 },
            text: "Coffee 25k",
          },
        };

        const req = new Request("https://example.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(update),
        });

        const res = await worker.fetch(req, envWithoutDb);
        expect(await res.text()).toBe("OK");

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        const body = JSON.parse(init.body as string) as { text: string };
        expect(body.text).toContain("Cloudflare D1 database is not connected.");
      });

      it("delegates to handleCommand when message starts with slash /", async () => {
        const fetchMock = vi.fn().mockResolvedValue(new Response(JSON.stringify({ ok: true })));
        globalThis.fetch = fetchMock;

        const { db } = createMockD1();
        const env: Env = {
          DB: db,
          TELEGRAM_BOT_TOKEN: "tok_123",
          GEMINI_API_KEY: "gem_123",
        };

        const update: WebhookUpdate = {
          message: {
            chat: { id: 778899 },
            text: "/start",
          },
        };

        const req = new Request("https://example.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(update),
        });

        const res = await worker.fetch(req, env);
        expect(await res.text()).toBe("OK");

        expect(fetchMock).toHaveBeenCalledTimes(1);
        const [, init] = fetchMock.mock.calls[0] as [string, RequestInit];
        const body = JSON.parse(init.body as string) as { text: string };
        expect(body.text).toContain("Available Commands:");
      });

      it("processes receipt photo message successfully (download -> Gemini Vision -> D1 -> reply)", async () => {
        const mockBinaryData = new TextEncoder().encode("Mock Receipt Image");
        const mockExpense = {
          amount: 85000,
          category: "Food & Dining",
          description: "Highland Coffee Receipt",
          transaction_type: "expense",
        };

        const fetchMock = vi
          .fn()
          // 1. Telegram getFile
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify({
                ok: true,
                result: { file_id: "photo_highland", file_path: "photos/highland.jpg" },
              })
            )
          )
          // 2. Download file
          .mockResolvedValueOnce(new Response(mockBinaryData))
          // 3. Gemini API
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify({
                candidates: [
                  {
                    content: {
                      parts: [{ text: JSON.stringify(mockExpense) }],
                    },
                  },
                ],
              })
            )
          )
          // 4. Telegram sendMessage
          .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));

        globalThis.fetch = fetchMock;

        const { db, statements } = createMockD1();
        const env: Env = {
          DB: db,
          TELEGRAM_BOT_TOKEN: "tok_123",
          GEMINI_API_KEY: "gem_123",
        };

        const update: WebhookUpdate = {
          message: {
            chat: { id: 556677 },
            caption: "Morning coffee receipt",
            photo: [
              { file_id: "small_id", width: 100, height: 100 },
              { file_id: "photo_highland", width: 800, height: 800 },
            ],
          },
        };

        const req = new Request("https://example.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(update),
        });

        const res = await worker.fetch(req, env);
        expect(await res.text()).toBe("OK");

        expect(fetchMock).toHaveBeenCalledTimes(4);

        const insertStmt = statements.find((s) => s.sql.includes("INSERT INTO expenses"));
        expect(insertStmt).toBeDefined();
        expect(insertStmt?.bindings).toEqual([
          "556677",
          85000,
          "Food & Dining",
          "Highland Coffee Receipt",
          "cash",
          1,
        ]);

        const lastCall = fetchMock.mock.calls[3] as [string, RequestInit];
        expect(lastCall[0]).toBe("https://api.telegram.org/bottok_123/sendMessage");
        const replyBody = JSON.parse(lastCall[1].body as string) as {
          chat_id: number;
          text: string;
        };
        expect(replyBody.chat_id).toBe(556677);
        expect(replyBody.text).toContain("✅ **Recorded 🔴 Expense:**");
        expect(replyBody.text).toContain("85,000");
      });

      it("processes text message expense successfully", async () => {
        const mockExpense = {
          amount: 35000,
          category: "Food & Dining",
          description: "Sandwich",
          transaction_type: "expense",
        };

        const fetchMock = vi
          .fn()
          // 1. Gemini API
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify({
                candidates: [
                  {
                    content: {
                      parts: [{ text: JSON.stringify(mockExpense) }],
                    },
                  },
                ],
              })
            )
          )
          // 2. Telegram sendMessage
          .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));

        globalThis.fetch = fetchMock;

        const { db, statements } = createMockD1();
        const env: Env = {
          DB: db,
          TELEGRAM_BOT_TOKEN: "tok_123",
          GEMINI_API_KEY: "gem_123",
        };

        const update: WebhookUpdate = {
          message: {
            chat: { id: 998877 },
            text: "Sandwich 35k",
          },
        };

        const req = new Request("https://example.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(update),
        });

        const res = await worker.fetch(req, env);
        expect(await res.text()).toBe("OK");

        expect(fetchMock).toHaveBeenCalledTimes(2);

        const insertStmt = statements.find((s) => s.sql.includes("INSERT INTO expenses"));
        expect(insertStmt?.bindings).toEqual([
          "998877",
          35000,
          "Food & Dining",
          "Sandwich",
          "cash",
          1,
        ]);

        const telegramCall = fetchMock.mock.calls[1] as [string, RequestInit];
        const replyBody = JSON.parse(telegramCall[1].body as string) as { text: string };
        expect(replyBody.text).toContain("✅ **Recorded 🔴 Expense:**");
      });

      it("processes refund / cancellation text message successfully", async () => {
        const mockExpense = {
          amount: 120000,
          category: "Shopping",
          description: "Shopee order refund",
          transaction_type: "refund",
        };

        const fetchMock = vi
          .fn()
          // 1. Gemini API
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify({
                candidates: [
                  {
                    content: {
                      parts: [{ text: JSON.stringify(mockExpense) }],
                    },
                  },
                ],
              })
            )
          )
          // 2. Telegram sendMessage
          .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));

        globalThis.fetch = fetchMock;

        const { db, statements } = createMockD1();
        const env: Env = {
          DB: db,
          TELEGRAM_BOT_TOKEN: "tok_123",
          GEMINI_API_KEY: "gem_123",
        };

        const update: WebhookUpdate = {
          message: {
            chat: { id: 998877 },
            text: "Shopee refund 120k",
          },
        };

        const req = new Request("https://example.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(update),
        });

        const res = await worker.fetch(req, env);
        expect(await res.text()).toBe("OK");

        const insertStmt = statements.find((s) => s.sql.includes("INSERT INTO expenses"));
        expect(insertStmt?.bindings).toEqual([
          "998877",
          -120000,
          "Shopping",
          "Shopee order refund",
          "cash",
          1,
        ]);

        const telegramCall = fetchMock.mock.calls[1] as [string, RequestInit];
        const replyBody = JSON.parse(telegramCall[1].body as string) as { text: string };
        expect(replyBody.text).toContain("✅ **Recorded 🟢 Refund (Cost Reduction):**");
      });

      it("processes credit card expense text message with is_paid = 0 and informs about /debt command", async () => {
        const mockExpense = {
          amount: 500000,
          category: "Bills & Utilities",
          description: "Electricity bill",
          transaction_type: "expense",
          payment_method: "credit_card",
        };

        const fetchMock = vi
          .fn()
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify({
                candidates: [{ content: { parts: [{ text: JSON.stringify(mockExpense) }] } }],
              })
            )
          )
          .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));

        globalThis.fetch = fetchMock;

        const { db, statements } = createMockD1();
        const env: Env = {
          DB: db,
          TELEGRAM_BOT_TOKEN: "tok_123",
          GEMINI_API_KEY: "gem_123",
        };

        const update: WebhookUpdate = {
          message: {
            chat: { id: 998877 },
            text: "Electricity 500k credit card",
          },
        };

        const req = new Request("https://example.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(update),
        });

        const res = await worker.fetch(req, env);
        expect(await res.text()).toBe("OK");

        const insertStmt = statements.find((s) => s.sql.includes("INSERT INTO expenses"));
        expect(insertStmt?.bindings).toEqual([
          "998877",
          500000,
          "Bills & Utilities",
          "Electricity bill",
          "credit_card",
          0,
        ]);

        const telegramCall = fetchMock.mock.calls[1] as [string, RequestInit];
        const replyBody = JSON.parse(telegramCall[1].body as string) as { text: string };
        expect(replyBody.text).toContain("✅ **Recorded 💳 Credit Card Expense (Unpaid Debt):**");
        expect(replyBody.text).toContain("/debt");
      });

      it("sends warning notification when Gemini returns recognition error", async () => {
        const fetchMock = vi
          .fn()
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ error: { message: "Internal quota" } }), {
              status: 500,
            })
          )
          .mockResolvedValueOnce(
            new Response(JSON.stringify({ error: { message: "Internal quota 2" } }), {
              status: 500,
            })
          )
          .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));

        globalThis.fetch = fetchMock;

        const { db, statements } = createMockD1();
        const env: Env = {
          DB: db,
          TELEGRAM_BOT_TOKEN: "tok_123",
          GEMINI_API_KEY: "gem_123",
        };

        const update: WebhookUpdate = {
          message: {
            chat: { id: 112233 },
            text: "Some random text",
          },
        };

        const req = new Request("https://example.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(update),
        });

        const res = await worker.fetch(req, env);
        expect(await res.text()).toBe("OK");

        expect(statements.filter((s) => s.sql.includes("INSERT"))).toHaveLength(0);

        const lastCall = fetchMock.mock.calls[2] as [string, RequestInit];
        const replyBody = JSON.parse(lastCall[1].body as string) as { text: string };
        expect(replyBody.text).toContain("⚠️ Recognition error:");
      });

      it("sends warning notification when Gemini fails to identify amount", async () => {
        const fetchMock = vi
          .fn()
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify({
                candidates: [
                  {
                    content: {
                      parts: [{ text: JSON.stringify({ description: "Hello" }) }],
                    },
                  },
                ],
              })
            )
          )
          .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));

        globalThis.fetch = fetchMock;

        const { db, statements } = createMockD1();
        const env: Env = {
          DB: db,
          TELEGRAM_BOT_TOKEN: "tok_123",
          GEMINI_API_KEY: "gem_123",
        };

        const update: WebhookUpdate = {
          message: {
            chat: { id: 112233 },
            text: "Hello there",
          },
        };

        const req = new Request("https://example.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(update),
        });

        const res = await worker.fetch(req, env);
        expect(await res.text()).toBe("OK");

        expect(statements.filter((s) => s.sql.includes("INSERT"))).toHaveLength(0);

        const lastCall = fetchMock.mock.calls[1] as [string, RequestInit];
        const replyBody = JSON.parse(lastCall[1].body as string) as { text: string };
        expect(replyBody.text).toBe("⚠️ Could not identify transaction amount.");
      });

      it("ignores messages that contain neither text nor photo", async () => {
        const fetchMock = vi.fn();
        globalThis.fetch = fetchMock;

        const { db } = createMockD1();
        const env: Env = {
          DB: db,
          TELEGRAM_BOT_TOKEN: "tok_123",
          GEMINI_API_KEY: "gem_123",
        };

        const update: WebhookUpdate = {
          message: {
            chat: { id: 112233 },
          },
        };

        const req = new Request("https://example.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(update),
        });

        const res = await worker.fetch(req, env);
        expect(await res.text()).toBe("OK");
        expect(fetchMock).not.toHaveBeenCalled();
      });

      it("catches parsing exception and does not crash worker when JSON payload is invalid", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});

        const { db } = createMockD1();
        const env: Env = {
          DB: db,
          TELEGRAM_BOT_TOKEN: "tok_123",
          GEMINI_API_KEY: "gem_123",
        };

        const req = new Request("https://example.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: "invalid-json{{{{",
        });

        const res = await worker.fetch(req, env);
        expect(await res.text()).toBe("OK");
      });
    });

      it("informs user when photo download fails", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const fetchMock = vi
          .fn()
          .mockResolvedValueOnce(new Response("Not found", { status: 404 }))
          .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));

        globalThis.fetch = fetchMock;

        const { db } = createMockD1();
        const env: Env = {
          DB: db,
          TELEGRAM_BOT_TOKEN: "tok_123",
          GEMINI_API_KEY: "gem_123",
        };

        const update: WebhookUpdate = {
          message: {
            chat: { id: 777888 },
            photo: [{ file_id: "broken_photo", width: 100, height: 100 }],
          },
        };

        const req = new Request("https://example.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(update),
        });

        const res = await worker.fetch(req, env);
        expect(await res.text()).toBe("OK");

        expect(fetchMock).toHaveBeenCalledTimes(2);
        const secondCall = fetchMock.mock.calls[1] as [string, RequestInit];
        const body = JSON.parse(secondCall[1].body as string) as { text: string };
        expect(body.text).toContain("Failed to download receipt image");
      });

      it("informs user when database insert throws an error", async () => {
        vi.spyOn(console, "error").mockImplementation(() => {});
        const fetchMock = vi
          .fn()
          .mockResolvedValueOnce(
            new Response(
              JSON.stringify({
                candidates: [
                  { content: { parts: [{ text: JSON.stringify({ amount: 45000, category: "Food & Dining", description: "Pho" }) }] } },
                ],
              })
            )
          )
          .mockResolvedValueOnce(new Response(JSON.stringify({ ok: true })));

        globalThis.fetch = fetchMock;

        const errorDb: D1Database = {
          prepare: () => {
            throw new Error("D1 insert timeout");
          },
          withSession: () => ({ prepare: () => ({} as D1PreparedStatement), batch: () => Promise.resolve([]), getBookmark: () => null }),
          dump: async () => new ArrayBuffer(0),
          batch: async () => [],
          exec: async () => ({ count: 0, duration: 0 }),
        };

        const env: Env = {
          DB: errorDb,
          TELEGRAM_BOT_TOKEN: "tok_123",
          GEMINI_API_KEY: "gem_123",
        };

        const update: WebhookUpdate = {
          message: {
            chat: { id: 334455 },
            text: "Pho 45k",
          },
        };

        const req = new Request("https://example.com", {
          method: "POST",
          headers: { "Content-Type": "application/json" },
          body: JSON.stringify(update),
        });

        const res = await worker.fetch(req, env);
        expect(await res.text()).toBe("OK");

        const lastCall = fetchMock.mock.calls[1] as [string, RequestInit];
        const body = JSON.parse(lastCall[1].body as string) as { text: string };
        expect(body.text).toContain("Failed to save transaction to database");
      });

    it("returns HTTP 500 when env parameter is missing or undefined", async () => {
      const req = new Request("https://example.com", { method: "POST" });
      const res = await worker.fetch(req, null as unknown as Env);
      expect(res.status).toBe(500);
      expect(await res.text()).toBe("Error: Worker environment is unconfigured");
    });
  });
});
