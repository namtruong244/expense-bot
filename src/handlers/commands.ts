import {
  CONFIG_KEY_ACTIVE_MODEL,
  DEFAULT_GEMINI_MODEL,
  FALLBACK_GEMINI_MODEL,
  GEMINI_MODEL_NAME_PATTERN,
} from "../constants";
import { escapeHtml, formatAmount, formatCurrency, formatDate, localMonth, percentBar, toLocalDate } from "../formatters";
import { BOT_COMMANDS, categoryLabel, describeRow, helpText, MSG } from "../messages";
import {
  deleteExpenseById,
  getConfigs,
  getExpenseById,
  getLastExpense,
  getMonthCreditCardTotals,
  getMonthExpensesByCategory,
  getRecentExpenses,
  getTodayExpenses,
  getUnpaidCreditCardExpenses,
  getWeekExpensesByCategory,
  payAllCreditCardExpenses,
  payCreditCardExpenses,
  setConfig,
} from "../services/db";
import { getDiscoveredModels, syncAvailableGeminiModels } from "../services/gemini";
import { sendTelegram, setTelegramCommands } from "../services/telegram";
import { CategorySummaryRow, Env, ExpenseRow, InlineKeyboard } from "../types";

const MAX_DEBT_BUTTONS = 8;

function safeAmount(value: unknown): number {
  return typeof value === "number" && Number.isFinite(value) ? value : 0;
}

/** Builds the keyboard asking the user to confirm deleting one transaction. */
export function deleteConfirmKeyboard(id: number): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: "🗑 Xoá", callback_data: `del:${id}` },
        { text: "Huỷ", callback_data: "cancel" },
      ],
    ],
  };
}

/** Builds the keyboard asking the user to confirm paying every unpaid credit card bill. */
export function payAllConfirmKeyboard(): InlineKeyboard {
  return {
    inline_keyboard: [
      [
        { text: "✅ Xác nhận trả hết", callback_data: "payallok" },
        { text: "Huỷ", callback_data: "cancel" },
      ],
    ],
  };
}

/**
 * Settles credit card bills and returns the confirmation text, or null if none matched.
 * `target` is a list of bill IDs, or "all".
 */
export async function payBills(db: D1Database, userId: string, target: number[] | "all"): Promise<string | null> {
  const paidRows: ExpenseRow[] =
    target === "all" ? await payAllCreditCardExpenses(db, userId) : await payCreditCardExpenses(db, userId, target);
  if (!paidRows.length) return null;

  const totalPaid = paidRows.reduce((sum, r) => sum + safeAmount(r.amount), 0);
  let msg = `✅ <b>Đã ghi nhận thanh toán thẻ tín dụng</b>\nĐã trả ${paidRows.length} khoản, tổng <b>${formatCurrency(totalPaid)}</b>:\n`;
  for (const r of paidRows) {
    msg += `• #${r.id}: ${formatAmount(r.amount)} - ${escapeHtml(r.description || "Transaction")}\n`;
  }

  const remaining = await getUnpaidCreditCardExpenses(db, userId);
  const remainingTotal = remaining.reduce((sum, r) => sum + safeAmount(r.amount), 0);
  msg += `\n💳 Còn nợ: <b>${formatCurrency(remainingTotal)}</b>`;
  return msg;
}

/** Category breakdown with share-of-spending bars, shared by /month and /week. */
function categoryReport(title: string, rows: CategorySummaryRow[]): { text: string; grandTotal: number } {
  const grandTotal = rows.reduce((sum, r) => sum + safeAmount(r.total_cat), 0);
  let text = `${title}\n\n`;

  for (const row of rows) {
    const totalCat = safeAmount(row.total_cat);
    const sign = totalCat < 0 ? "-" : "";
    const count = row.count ? ` · ${row.count} khoản` : "";
    text += `• <b>${escapeHtml(categoryLabel(row.category || "Other"))}</b>: ${sign}${formatAmount(totalCat)}${count}\n`;
    if (grandTotal > 0 && totalCat > 0) {
      const percent = (totalCat / grandTotal) * 100;
      text += `   ${percentBar(percent)} ${Math.round(percent)}%\n`;
    }
  }

  const totalLabel = grandTotal < 0 ? "🟢 Tiết kiệm ròng:" : "🔴 Tổng chi thực tế:";
  text += `\n━━━━━━━━━━━━━━━\n💰 <b>${totalLabel} ${formatCurrency(grandTotal)}</b>`;
  return { text, grandTotal };
}

/** Resolves the `/month` argument: nothing = this month, "prev" = last month, or YYYY-MM. */
function parseMonthArg(arg: string): string | null {
  if (!arg) return localMonth(0);
  if (["prev", "last", "truoc"].includes(arg)) return localMonth(-1);
  return /^\d{4}-(0[1-9]|1[0-2])$/.test(arg) ? arg : null;
}

/**
 * Handles incoming slash commands from Telegram users.
 *
 * @param command Command string starting with `/` (e.g. "/today", "/month", "/delete", "/help").
 * @param chatId Target Telegram chat ID.
 * @param env Environment containing D1 database binding and Telegram token.
 */
export async function handleCommand(command: string, chatId: number, env: Env): Promise<void> {
  const parts = command.trim().split(/\s+/);
  // Telegram appends the bot name in groups: "/today@my_bot"
  const cmd = parts[0].toLowerCase().split("@")[0];
  const arg = parts.slice(1).join(" ").trim().toLowerCase();
  const userId = chatId.toString();
  const token = env.TELEGRAM_BOT_TOKEN;
  const isAdmin = !!env.ADMIN_CHAT_ID && env.ADMIN_CHAT_ID.trim() === userId;

  try {
    switch (cmd) {
      case "/start": {
        await sendTelegram(token, chatId, MSG.start);
        await setTelegramCommands(token, BOT_COMMANDS);
        break;
      }
      case "/help":
      case "/trogiup": {
        await sendTelegram(token, chatId, helpText(isAdmin));
        break;
      }
      case "/today":
      case "/homnay": {
        const records = await getTodayExpenses(env.DB, userId);

        if (!records.length) {
          await sendTelegram(token, chatId, MSG.noToday);
          return;
        }

        let total = 0;
        let msg = "📅 <b>Giao dịch hôm nay</b>\n\n";

        for (const row of records) {
          const amount = safeAmount(row.amount);
          total += amount;
          const icon = amount < 0 ? "🟢" : row.payment_method === "credit_card" ? "💳" : "🔴";
          msg += `• ${icon} <b>${formatAmount(amount)}</b> - ${escapeHtml(categoryLabel(row.category || "Other"))}: ${escapeHtml(row.description || "Transaction")}\n`;
        }

        const totalPrefix = total < 0 ? "🟢 Tiết kiệm ròng:" : "🔴 Tổng chi:";
        msg += `\n👉 <b>${totalPrefix} ${formatCurrency(total)}</b>`;

        await sendTelegram(token, chatId, msg);
        break;
      }
      case "/week":
      case "/tuan": {
        const rows = await getWeekExpensesByCategory(env.DB, userId);
        if (!rows.length) {
          await sendTelegram(token, chatId, MSG.noWeek);
          return;
        }
        await sendTelegram(token, chatId, categoryReport("📊 <b>Chi tiêu 7 ngày gần nhất</b>", rows).text);
        break;
      }
      case "/month":
      case "/thismonth":
      case "/thangnay": {
        const month = parseMonthArg(arg);
        if (!month) {
          await sendTelegram(token, chatId, "⚠️ Tháng không hợp lệ. Ví dụ: <code>/month</code>, <code>/month prev</code> hoặc <code>/month 2026-09</code>");
          return;
        }
        const isCurrent = month === localMonth(0);
        const rows = await getMonthExpensesByCategory(env.DB, userId, isCurrent ? undefined : month);

        if (!rows.length) {
          await sendTelegram(token, chatId, isCurrent ? MSG.noMonth : MSG.noMonthOther);
          return;
        }

        const [y, m] = month.split("-");
        let { text } = categoryReport(`📊 <b>Báo cáo tháng ${m}/${y}</b>`, rows);
        const card = await getMonthCreditCardTotals(env.DB, userId, isCurrent ? undefined : month);
        if (card.card_total !== 0) {
          text += `\n💳 Quẹt thẻ: ${formatCurrency(card.card_total)}`;
          if (card.unpaid_total > 0) text += ` (chưa trả: ${formatCurrency(card.unpaid_total)})`;
        }
        await sendTelegram(token, chatId, text);
        break;
      }
      case "/recent":
      case "/gannhat": {
        const rows = await getRecentExpenses(env.DB, userId, 10);
        if (!rows.length) {
          await sendTelegram(token, chatId, MSG.noRecent);
          return;
        }
        let msg = "🕘 <b>Giao dịch gần nhất</b>\n\n";
        for (const row of rows) {
          const date = row.created_at ? formatDate(toLocalDate(row.created_at)).slice(0, 5) : "";
          msg += `<code>#${row.id}</code> ${date} ${describeRow(row)}\n`;
        }
        msg += "\n👉 Xoá một khoản: <code>/delete &lt;số hiệu&gt;</code>";
        await sendTelegram(token, chatId, msg);
        break;
      }
      case "/delete":
      case "/xoa": {
        let target: ExpenseRow | null;
        if (arg) {
          const id = Number(arg.replace(/^#/, ""));
          if (!Number.isInteger(id) || id <= 0) {
            await sendTelegram(token, chatId, MSG.deleteInvalid);
            return;
          }
          target = await getExpenseById(env.DB, userId, id);
          if (!target) {
            await sendTelegram(token, chatId, MSG.deleteNotFound);
            return;
          }
        } else {
          target = await getLastExpense(env.DB, userId);
          if (!target) {
            await sendTelegram(token, chatId, MSG.noDelete);
            return;
          }
        }

        await sendTelegram(
          token,
          chatId,
          `🗑 <b>Xoá giao dịch này?</b>\n#${target.id} ${describeRow(target)}`,
          deleteConfirmKeyboard(target.id)
        );
        break;
      }
      case "/debt":
      case "/credit":
      case "/nothe": {
        const unpaid = await getUnpaidCreditCardExpenses(env.DB, userId);

        if (!unpaid.length) {
          await sendTelegram(token, chatId, MSG.noDebt);
          return;
        }

        let totalDebt = 0;
        let msg = "💳 <b>Các khoản thẻ tín dụng chưa trả</b>\n\n";

        for (const bill of unpaid) {
          const amount = safeAmount(bill.amount);
          totalDebt += amount;
          const date = bill.created_at ? ` (${formatDate(toLocalDate(bill.created_at))})` : "";
          msg += `• <b>#${bill.id}</b> • ${formatAmount(amount)} - ${escapeHtml(categoryLabel(bill.category || "Other"))}: ${escapeHtml(bill.description || "Transaction")}${date}\n`;
        }

        msg += `\n━━━━━━━━━━━━━━━\n💳 <b>Tổng nợ: ${formatCurrency(totalDebt)}</b>\n\n`;
        msg += "👉 Bấm nút bên dưới để trả, hoặc gõ <code>/pay 5</code>, <code>/pay 5,8</code>, <code>/pay all</code>";

        const keyboard: InlineKeyboard = {
          inline_keyboard: unpaid.slice(0, MAX_DEBT_BUTTONS).map((bill) => [
            { text: `💳 Trả #${bill.id} · ${formatAmount(safeAmount(bill.amount))}`, callback_data: `pay:${bill.id}` },
          ]),
        };
        if (unpaid.length > 1) {
          keyboard.inline_keyboard.push([{ text: `✅ Trả hết (${unpaid.length} khoản)`, callback_data: "payall" }]);
        }
        await sendTelegram(token, chatId, msg, keyboard);
        break;
      }
      case "/pay":
      case "/trano":
      case "/paydebt": {
        if (!arg) {
          await sendTelegram(token, chatId, MSG.payUsage);
          return;
        }

        if (arg === "all") {
          const unpaid = await getUnpaidCreditCardExpenses(env.DB, userId);
          if (!unpaid.length) {
            await sendTelegram(token, chatId, MSG.noDebtToPay);
            return;
          }
          const total = unpaid.reduce((sum, r) => sum + safeAmount(r.amount), 0);
          await sendTelegram(
            token,
            chatId,
            `💳 Trả hết <b>${unpaid.length}</b> khoản, tổng <b>${formatCurrency(total)}</b>?`,
            payAllConfirmKeyboard()
          );
          return;
        }

        const ids = arg
          .split(/[\s,]+/)
          .map(Number)
          .filter((n) => Number.isInteger(n) && n > 0);
        if (ids.length === 0) {
          await sendTelegram(token, chatId, MSG.payInvalid);
          return;
        }

        const msg = await payBills(env.DB, userId, ids);
        await sendTelegram(token, chatId, msg ?? MSG.payNotFound);
        break;
      }
      case "/model":
      case "/gemini": {
        const rawArg = parts.slice(1).join(" ").trim();

        if (!rawArg) {
          const cfg = await getConfigs(env.DB, [CONFIG_KEY_ACTIVE_MODEL]);
          const activeModel = cfg[CONFIG_KEY_ACTIVE_MODEL] || DEFAULT_GEMINI_MODEL;
          const discovered = await getDiscoveredModels(env.DB);
          const models = discovered.length > 0 ? discovered : [DEFAULT_GEMINI_MODEL, FALLBACK_GEMINI_MODEL];

          let msg = "🤖 <b>Cài đặt model Gemini AI</b>\n\n";
          msg += `• Model đang dùng: <b>${escapeHtml(activeModel)}</b> ⭐\n\n`;
          msg += "📋 <b>Các model có sẵn:</b>\n";
          for (let i = 0; i < models.length; i++) {
            const m = models[i];
            const star = m === activeModel ? " (đang dùng ⭐)" : "";
            msg += `${i + 1}. <code>${escapeHtml(m)}</code>${star}\n`;
          }

          msg += "\n💡 <b>Tuỳ chọn:</b>\n";
          msg += "• <code>/model &lt;tên&gt;</code>: đổi model (ví dụ <code>/model gemini-3.5-flash</code>)\n";
          msg += "• <code>/model auto</code>: tự chọn model mới nhất\n";
          msg += "• <code>/model sync</code>: cập nhật danh sách từ Google\n";
          msg += "• <code>/model reset</code>: về model mặc định";

          await sendTelegram(token, chatId, msg);
          break;
        }

        if (!isAdmin) {
          await sendTelegram(token, chatId, MSG.adminOnly);
          break;
        }

        const lowerArg = rawArg.toLowerCase();

        if (lowerArg === "sync" || lowerArg === "auto") {
          let result;
          try {
            result = await syncAvailableGeminiModels(env.GEMINI_API_KEY, env.DB, lowerArg === "auto");
          } catch (err: unknown) {
            console.error("Gemini model sync failed:", err);
            const reason = err instanceof Error ? err.message : String(err);
            await sendTelegram(token, chatId, `⚠️ Không đồng bộ được danh sách model Gemini: ${escapeHtml(reason)}`);
            break;
          }
          const { activeModel, models } = result;

          let msg = lowerArg === "auto" ? "🔄 <b>Đã tự cập nhật model Gemini</b>\n" : "🔄 <b>Đã đồng bộ danh sách model Gemini</b>\n";
          msg += `Model đang dùng: <b>${escapeHtml(activeModel)}</b> ⭐\n\n`;
          msg += `Tìm thấy ${models.length} model tương thích:\n`;
          for (const m of models) {
            const star = m === activeModel ? " (đang dùng ⭐)" : "";
            msg += `• <code>${escapeHtml(m)}</code>${star}\n`;
          }
          msg += "\n👉 Đổi model bất cứ lúc nào: <code>/model &lt;tên&gt;</code>";

          await sendTelegram(token, chatId, msg);
          break;
        }

        if (lowerArg === "reset") {
          await setConfig(env.DB, CONFIG_KEY_ACTIVE_MODEL, DEFAULT_GEMINI_MODEL);
          await sendTelegram(token, chatId, `✅ Đã về model mặc định: <b>${DEFAULT_GEMINI_MODEL}</b>`);
          break;
        }

        const targetModel = rawArg.replace(/^models\//i, "").trim().toLowerCase();
        if (!GEMINI_MODEL_NAME_PATTERN.test(targetModel)) {
          await sendTelegram(
            token,
            chatId,
            `⚠️ Tên model không hợp lệ: <code>${escapeHtml(targetModel.slice(0, 64))}</code>. Gõ /model để xem các model có sẵn.`
          );
          break;
        }
        await setConfig(env.DB, CONFIG_KEY_ACTIVE_MODEL, targetModel);
        await sendTelegram(token, chatId, `✅ Đã đổi model Gemini sang: <b>${escapeHtml(targetModel)}</b>`);
        break;
      }
      default: {
        await sendTelegram(token, chatId, MSG.unknownCommand);
      }
    }
  } catch (err: unknown) {
    console.error(`Error executing command ${cmd}:`, err);
    await sendTelegram(token, chatId, MSG.genericError);
  }
}
