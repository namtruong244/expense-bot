import { CATEGORIES, CATEGORY_LABELS } from "./constants";
import { escapeHtml, formatAmount, formatDate, localToday, toLocalDate } from "./formatters";
import { ExpenseRow, InlineKeyboard } from "./types";

/** Command list registered with Telegram (shown in the "/" menu). */
export const BOT_COMMANDS: Array<{ command: string; description: string }> = [
  { command: "today", description: "Giao dịch hôm nay" },
  { command: "week", description: "Chi tiêu 7 ngày gần nhất" },
  { command: "month", description: "Báo cáo tháng này (/month prev: tháng trước)" },
  { command: "recent", description: "10 giao dịch gần nhất" },
  { command: "debt", description: "Các khoản thẻ tín dụng chưa trả" },
  { command: "pay", description: "Thanh toán thẻ tín dụng" },
  { command: "delete", description: "Xoá giao dịch" },
  { command: "help", description: "Hướng dẫn sử dụng" },
];

export const MSG = {
  start:
    "👋 <b>Chào bạn! Mình là bot quản lý chi tiêu.</b>\n\n" +
    "Chỉ cần nhắn tự nhiên, mình sẽ tự ghi lại:\n" +
    "• <code>Ăn phở 50k</code>\n" +
    "• <code>Cafe 30k, gửi xe 5k</code> (nhiều khoản trong một tin)\n" +
    "• <code>Hôm qua mua áo 300k quẹt thẻ</code>\n" +
    "• <code>Hoàn tiền Shopee 120k</code>\n" +
    "• Hoặc gửi ảnh hoá đơn 📸\n\n" +
    "Sau mỗi lần ghi, bạn có thể bấm nút để hoàn tác hoặc sửa danh mục.\n" +
    "Gõ /help để xem tất cả lệnh.",
  noToday: "📅 Hôm nay chưa có giao dịch nào.",
  noMonth: "📊 Tháng này chưa có giao dịch nào.",
  noMonthOther: "📊 Tháng đó không có giao dịch nào.",
  noWeek: "📊 7 ngày qua chưa có giao dịch nào.",
  noRecent: "Chưa có giao dịch nào.",
  noDelete: "Không có giao dịch nào để xoá.",
  noDebt: "💳 Không có khoản thẻ tín dụng nào chưa trả.",
  noDebtToPay: "💳 Không có khoản thẻ tín dụng nào cần thanh toán.",
  payUsage:
    "⚠️ Hãy cho mình biết số hiệu khoản cần trả, hoặc dùng <code>/pay all</code>.\nVí dụ: <code>/pay 5</code>, <code>/pay 5, 8</code> hoặc <code>/pay all</code>\nXem các khoản chưa trả bằng /debt",
  payInvalid: "⚠️ Số hiệu không hợp lệ. Ví dụ: <code>/pay 5</code>, <code>/pay 5, 8</code> hoặc <code>/pay all</code>",
  payNotFound: "⚠️ Không tìm thấy khoản thẻ tín dụng chưa trả nào khớp với số hiệu đã nhập.",
  deleteInvalid: "⚠️ Số hiệu không hợp lệ. Ví dụ: <code>/delete</code> hoặc <code>/delete 12</code>",
  deleteNotFound: "⚠️ Không tìm thấy giao dịch này.",
  unknownCommand: "🤔 Mình chưa có lệnh này. Gõ /help để xem các lệnh có sẵn.",
  unsupported: "🤔 Mình chỉ đọc được tin nhắn văn bản và ảnh hoá đơn. Hãy thử gõ, ví dụ: <code>Ăn trưa 50k</code>.",
  cannotParse:
    "🤔 Mình chưa hiểu đây là khoản chi nào. Hãy thử gõ như: <code>Ăn trưa 50k</code>, hoặc gửi ảnh hoá đơn.",
  noAmount: "🤔 Mình chưa xác định được số tiền. Hãy thử gõ lại kèm số tiền, ví dụ: <code>Cafe 40k</code>.",
  aiUnavailable: "⏳ Dịch vụ AI đang quá tải hoặc chưa sẵn sàng. Bạn thử lại sau ít phút nhé.",
  genericError: "⚠️ Có lỗi xảy ra, bạn thử lại sau nhé.",
  photoFailed: "⚠️ Mình không tải được ảnh hoá đơn. Bạn thử gửi lại nhé.",
  saveFailed: "⚠️ Không lưu được giao dịch. Bạn thử lại nhé.",
  dbMissing: "⚠️ Chưa kết nối được cơ sở dữ liệu.",
  adminOnly: "⛔ Chỉ quản trị viên bot mới được đổi model Gemini (cần đặt ADMIN_CHAT_ID là chat ID của bạn).",
  buttonExpired: "Giao dịch này không còn nữa.",
  cancelled: "Đã huỷ.",
} as const;

/** Maps a Gemini/parse error into a short message that is safe to show to users. */
export function friendlyParseError(error: string): string {
  if (error === "cannot_parse") return MSG.cannotParse;
  if (error.startsWith("AI service unavailable")) return MSG.aiUnavailable;
  return MSG.genericError;
}

/** Vietnamese label for a stored category. */
export function categoryLabel(category: string): string {
  return CATEGORY_LABELS[category] ?? category;
}

/** Full command guide. `/model` is only listed for the admin. */
export function helpText(isAdmin: boolean): string {
  let text =
    "🤖 <b>Hướng dẫn sử dụng</b>\n\n" +
    "<b>Ghi chi tiêu</b> — nhắn tự nhiên hoặc gửi ảnh hoá đơn:\n" +
    "• <code>Cafe 40k</code>\n" +
    "• <code>Ăn trưa 50k, grab 30k</code> (nhiều khoản)\n" +
    "• <code>Hôm qua mua sách 120k</code> (ghi lùi ngày)\n" +
    "• <code>Mua giày 800k quẹt thẻ</code> (thẻ tín dụng)\n" +
    "• <code>Hoàn tiền Shopee 100k</code>\n\n" +
    "<b>Xem báo cáo</b>\n" +
    "/today (/homnay) — giao dịch hôm nay\n" +
    "/week — 7 ngày gần nhất\n" +
    "/month (/thangnay) — tháng này; <code>/month prev</code> — tháng trước\n" +
    "/recent — 10 giao dịch gần nhất\n\n" +
    "<b>Thẻ tín dụng</b>\n" +
    "/debt (/nothe) — các khoản chưa trả\n" +
    "/pay (/trano) <code>&lt;số hiệu&gt;</code> — thanh toán; <code>/pay all</code> — trả hết\n\n" +
    "<b>Sửa / xoá</b>\n" +
    "/delete (/xoa) — xoá giao dịch mới nhất; <code>/delete 12</code> — xoá khoản số 12\n";
  if (isAdmin) {
    text += "\n<b>Quản trị</b>\n/model (/gemini) — xem hoặc đổi model Gemini AI";
  }
  return text.trimEnd();
}

/** A recorded (or stored) transaction as shown to the user. */
export interface SavedTransaction {
  /** Signed amount: negative for refunds. */
  amount: number;
  category: string;
  description: string;
  paymentMethod: string;
  isPaid: boolean;
  /** Local date (YYYY-MM-DD), only set for back-dated transactions. */
  date?: string;
}

/**
 * Confirmation text for a saved transaction.
 * `html: true` for Telegram, `false` for plain-text clients such as Apple Shortcuts.
 */
export function savedText(tx: SavedTransaction, html: boolean): string {
  const isRefund = tx.amount < 0;
  const isCard = tx.paymentMethod === "credit_card";
  let action = "🔴 Chi tiêu";
  if (isRefund) action = "🟢 Hoàn tiền / huỷ đơn";
  else if (isCard) action = tx.isPaid ? "💳 Chi tiêu thẻ tín dụng (đã trả)" : "💳 Chi tiêu thẻ tín dụng (chưa trả)";

  const esc = html ? escapeHtml : (v: string) => v;
  const bold = (v: string) => (html ? `<b>${esc(v)}</b>` : v);

  let text =
    `✅ ${html ? "<b>" : ""}Đã ghi ${action}${html ? "</b>" : ""}\n` +
    `💰 Số tiền: ${bold(formatAmount(tx.amount))}\n` +
    `🏷 Danh mục: ${esc(categoryLabel(tx.category))}\n` +
    `📝 Mô tả: ${esc(tx.description)}`;
  if (tx.date) text += `\n📅 Ngày: ${formatDate(tx.date)}`;
  if (isCard && !isRefund && !tx.isPaid) {
    text += "\n📌 Gõ /debt để xem các khoản chưa trả, hoặc /pay để thanh toán.";
  }
  return text;
}

/** Buttons shown under a saved transaction: undo, change category, toggle credit card. */
export function transactionKeyboard(id: number, tx: SavedTransaction): InlineKeyboard {
  const rows = [
    [
      { text: "↩️ Hoàn tác", callback_data: `del:${id}` },
      { text: "🏷 Đổi danh mục", callback_data: `cat:${id}` },
    ],
  ];
  if (tx.amount >= 0) {
    const isCard = tx.paymentMethod === "credit_card";
    rows.push([
      isCard
        ? { text: "💵 Chuyển thành tiền mặt", callback_data: `card:${id}` }
        : { text: "💳 Đánh dấu quẹt thẻ", callback_data: `card:${id}` },
    ]);
  }
  return { inline_keyboard: rows };
}

/** Category picker (two per row) plus a back button. */
export function categoryKeyboard(id: number): InlineKeyboard {
  const rows = [];
  for (let i = 0; i < CATEGORIES.length; i += 2) {
    rows.push(
      CATEGORIES.slice(i, i + 2).map((c, j) => ({
        text: categoryLabel(c),
        callback_data: `setcat:${id}:${i + j}`,
      }))
    );
  }
  rows.push([{ text: "◀️ Quay lại", callback_data: `back:${id}` }]);
  return { inline_keyboard: rows };
}

/** One-line summary of a stored transaction, e.g. "🔴 45.000 ₫ · Ăn uống · Phở bò" (HTML-safe). */
export function describeRow(row: ExpenseRow): string {
  const amount = typeof row.amount === "number" && Number.isFinite(row.amount) ? row.amount : 0;
  const icon = amount < 0 ? "🟢" : row.payment_method === "credit_card" ? "💳" : "🔴";
  return `${icon} <b>${formatAmount(amount)}</b> · ${escapeHtml(categoryLabel(row.category || "Other"))} · ${escapeHtml(row.description || "Transaction")}`;
}

/** Converts a stored row into the shape used by {@link savedText} (date only when not today). */
export function rowToSaved(row: ExpenseRow): SavedTransaction {
  const date = row.created_at ? toLocalDate(row.created_at) : undefined;
  return {
    amount: row.amount,
    category: row.category,
    description: row.description || "Transaction",
    paymentMethod: row.payment_method || "cash",
    isPaid: row.is_paid !== 0,
    date: date && date !== localToday() ? date : undefined,
  };
}
