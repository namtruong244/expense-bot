export interface Env {
  DB: D1Database;
  TELEGRAM_BOT_TOKEN: string;
  GEMINI_API_KEY: string;
}

interface ExpenseData {
  amount?: number;
  category?: string;
  description?: string;
  error?: string;
}

const SYSTEM_PROMPT = `
Bạn là trợ lý tài chính cá nhân. Nhiệm vụ của bạn là bóc tách chi tiêu từ tin nhắn hoặc ảnh hóa đơn.
Trả về dữ liệu tuân thủ nghiêm ngặt theo JSON schema.
- amount: Tính theo VNĐ, chỉ ghi số (ví dụ: 45k -> 45000, 1tr -> 1000000).
- category: Chọn đúng 1 trong các mục: "Ăn uống", "Mua sắm", "Di chuyển", "Hóa đơn & Tiện ích", "Giải trí", "Sức khỏe", "Học tập", "Khác".
- Nếu không phải chi tiêu, trả về error: "cannot_parse".
`;

export default {
  async fetch(request: Request, env: Env): Promise<Response> {
    if (request.method !== "POST") return new Response("Bot is running!");

    try {
      const update: any = await request.json();
      const message = update.message;
      if (!message || !message.chat) return new Response("OK");

      const chatId = message.chat.id;
      const text = message.text ? message.text.trim() : "";

      // 1. Kiểm tra Binding DB
      if (!env.DB) {
        await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, "⚠️ Lỗi: Chưa liên kết Cloudflare D1 (env.DB).");
        return new Response("OK");
      }

      // 2. Lệnh thống kê / hệ thống
      if (text.startsWith("/")) {
        await handleCommand(text, chatId, env);
        return new Response("OK");
      }

      // 3. Chuẩn bị payload chuẩn (generateContent API)
      let aiPayload: any = null;

      if (message.photo) {
        const photo = message.photo[message.photo.length - 1];
        const base64Image = await downloadTelegramFileAsBase64(photo.file_id, env.TELEGRAM_BOT_TOKEN);

        aiPayload = {
          contents: [
            {
              parts: [
                { text: message.caption || "Bóc tách hóa đơn này thành JSON chi tiêu (amount, category, description)." },
                { inline_data: { mime_type: "image/jpeg", data: base64Image } }
              ]
            }
          ]
        };
      } else if (text) {
        aiPayload = {
          contents: [{ parts: [{ text }] }]
        };
      } else {
        return new Response("OK");
      }

      // 4. Gọi Gemini API (Fallback 3.8 -> 3.5)
      const expense = await parseWithGemini(aiPayload, env.GEMINI_API_KEY);

      if (expense.error) {
        await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, `⚠️ Lỗi nhận diện: ${expense.error}`);
        return new Response("OK");
      }

      if (!expense.amount) {
        await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, "⚠️ Không nhận diện được khoản chi. Ví dụ hợp lệ: `Bún bò 40k`");
        return new Response("OK");
      }

      // 5. Lưu Database
      await env.DB.prepare(
        "INSERT INTO expenses (user_id, amount, category, description) VALUES (?, ?, ?, ?)"
      )
        .bind(chatId.toString(), expense.amount, expense.category || "Khác", expense.description || "Chi tiêu")
        .run();

      const formatted = new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(expense.amount);
      const reply = `✅ **Đã ghi nhận:**\n` +
                    `💰 Số tiền: ${formatted}\n` +
                    `🏷 Danh mục: ${expense.category}\n` +
                    `📝 Nội dung: ${expense.description}`;

      await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, reply);

    } catch (err: any) {
      console.error("Worker error:", err);
    }

    return new Response("OK");
  }
};

// ======================= XỬ LÝ LỆNH TỔNG HỢP (Hỗ trợ UTC+7) =======================

async function handleCommand(command: string, chatId: number, env: Env) {
  const cmd = command.toLowerCase().split(" ")[0];

  switch (cmd) {
    case "/start":
    case "/trogiup": {
      await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, "🤖 **Lệnh hỗ trợ:**\n• Gửi chữ/ảnh để ghi chi tiêu\n• /homnay: Xem chi hôm nay\n• /thangnay: Tổng hợp tháng\n• /xoa: Xóa giao dịch cuối");
      break;
    }
    case "/homnay": {
      // Dùng date(..., '+7 hours') để chuẩn hóa giờ Việt Nam
      const query = `
        SELECT amount, category, description
        FROM expenses
        WHERE user_id = ? AND date(created_at, '+7 hours') = date('now', '+7 hours')
        ORDER BY created_at DESC
      `;
      const result = await env.DB.prepare(query).bind(chatId.toString()).all();
      const records = result.results as any[];

      if (!records.length) {
        await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, "📅 Hôm nay bạn chưa chi tiêu gì.");
        return;
      }

      let total = 0;
      let msg = "📅 **Chi tiêu hôm nay (VNĐ):**\n\n";
      for (const row of records) {
        total += row.amount;
        msg += `• **${new Intl.NumberFormat("vi-VN").format(row.amount)}đ** - ${row.category}: ${row.description}\n`;
      }
      msg += `\n👉 **Tổng:** ${new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(total)}`;
      await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, msg);
      break;
    }
    case "/thangnay": {
      const query = `
        SELECT category, SUM(amount) as total_cat, COUNT(id) as count
        FROM expenses
        WHERE user_id = ? AND strftime('%Y-%m', created_at, '+7 hours') = strftime('%Y-%m', 'now', '+7 hours')
        GROUP BY category ORDER BY total_cat DESC
      `;
      const result = await env.DB.prepare(query).bind(chatId.toString()).all();
      const rows = result.results as any[];

      if (!rows.length) {
        await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, "📊 Tháng này bạn chưa có khoản chi nào.");
        return;
      }

      let grandTotal = 0;
      let reportText = `📊 **Báo cáo tháng này:**\n\n`;
      for (const row of rows) {
        grandTotal += row.total_cat;
        reportText += `• **${row.category}**: ${new Intl.NumberFormat("vi-VN").format(row.total_cat)}đ\n`;
      }
      reportText += `\n💰 **Tổng chi:** ${new Intl.NumberFormat("vi-VN", { style: "currency", currency: "VND" }).format(grandTotal)}`;
      await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, reportText);
      break;
    }
    case "/xoa": {
      const last = await env.DB.prepare("SELECT id, amount, description FROM expenses WHERE user_id = ? ORDER BY id DESC LIMIT 1").bind(chatId.toString()).first();
      if (!last) return sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, "Không tìm thấy giao dịch.");
      await env.DB.prepare("DELETE FROM expenses WHERE id = ?").bind(last.id).run();
      await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, `🗑 Đã xóa khoản: **${new Intl.NumberFormat("vi-VN").format(last.amount as number)}đ** (${last.description})`);
      break;
    }
  }
}

// ======================= XỬ LÝ GEMINI VÀ ẢNH =======================

async function parseWithGemini(payload: any, apiKey: string): Promise<ExpenseData> {
  if (!apiKey) return { error: "Thiếu GEMINI_API_KEY" };

  // Dùng gemini-3.8-flash làm chính, tự động lùi về 3.5-flash nếu 3.8 quá tải
  const models = ["gemini-3.8-flash", "gemini-3.5-flash"];

  const expenseSchema = {
    type: "OBJECT",
    properties: {
      amount: { type: "NUMBER" },
      category: { type: "STRING" },
      description: { type: "STRING" },
      error: { type: "STRING" }
    },
    required: ["amount", "category", "description"]
  };

  let lastError = "";

  for (const model of models) {
    try {
      // Đảm bảo đang dùng endpoint chuẩn generateContent
      const url = `https://generativelanguage.googleapis.com/v1beta/models/${model}:generateContent?key=${apiKey}`;

      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          system_instruction: { parts: [{ text: SYSTEM_PROMPT }] },
          generationConfig: {
            response_mime_type: "application/json",
            response_schema: expenseSchema,
            temperature: 0.1
          },
          ...payload
        })
      });

      const data: any = await res.json();

      if (res.status === 503 || res.status === 429) {
        lastError = data.error?.message || "Server bận";
        continue;
      }

      if (!res.ok || data.error) {
        lastError = data.error?.message || "Lỗi không xác định";
        continue;
      }

      const rawText = data.candidates?.[0]?.content?.parts?.[0]?.text;
      if (!rawText) continue;

      const cleanJson = rawText.replace(/```json/g, "").replace(/```/g, "").trim();
      return JSON.parse(cleanJson);

    } catch (err: any) {
      lastError = err.message;
    }
  }

  return { error: `AI quá tải: ${lastError}` };
}

async function downloadTelegramFileAsBase64(fileId: string, token: string): Promise<string> {
  const metaRes = await fetch(`https://api.telegram.org/bot${token}/getFile?file_id=${fileId}`);
  const metaData: any = await metaRes.json();
  const filePath = metaData.result?.file_path;

  const fileRes = await fetch(`https://api.telegram.org/file/bot${token}/${filePath}`);
  const buffer = await fileRes.arrayBuffer();

  let binary = "";
  const bytes = new Uint8Array(buffer);
  for (let i = 0; i < bytes.byteLength; i++) {
    binary += String.fromCharCode(bytes[i]);
  }
  return btoa(binary);
}

async function sendTelegram(token: string, chatId: number, text: string) {
  await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify({ chat_id: chatId, text: text, parse_mode: "Markdown" })
  });
}