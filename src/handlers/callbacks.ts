import { CATEGORIES } from "../constants";
import {
  categoryKeyboard,
  categoryLabel,
  describeRow,
  MSG,
  rowToSaved,
  savedText,
  transactionKeyboard,
} from "../messages";
import { formatCurrency } from "../formatters";
import {
  deleteExpenseById,
  getExpenseById,
  getUnpaidCreditCardExpenses,
  updateExpenseCategory,
  updateExpensePayment,
} from "../services/db";
import {
  answerCallbackQuery,
  editTelegramKeyboard,
  editTelegramMessage,
  sendTelegram,
} from "../services/telegram";
import { Env, ExpenseRow, TelegramCallbackQuery } from "../types";
import { payAllConfirmKeyboard, payBills } from "./commands";

/**
 * Handles inline keyboard button presses. Callback data format:
 *   del:<id>            delete a transaction (undo / confirmed /delete)
 *   cat:<id>            open the category picker
 *   setcat:<id>:<index> set the category (index into CATEGORIES)
 *   back:<id>           close the category picker
 *   card:<id>           toggle cash <-> credit card
 *   pay:<id>            pay one credit card bill
 *   payall              ask to confirm paying every bill (see /pay all)
 *   payallok            pay every bill
 *   cancel              dismiss a confirmation
 * Every query is scoped to the chat that pressed the button.
 */
export async function handleCallbackQuery(query: TelegramCallbackQuery, env: Env): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  const [action = "", rawId = "", rawArg = ""] = (query.data || "").split(":");

  if (!chatId || !messageId || !env.DB) {
    await answerCallbackQuery(token, query.id);
    return;
  }

  const userId = chatId.toString();
  const id = Number(rawId);

  try {
    if (action === "cancel") {
      await answerCallbackQuery(token, query.id, MSG.cancelled);
      await editTelegramMessage(token, chatId, messageId, MSG.cancelled);
      return;
    }

    if (action === "payall") {
      await answerCallbackQuery(token, query.id);
      const unpaid = await getUnpaidCreditCardExpenses(env.DB, userId);
      if (!unpaid.length) {
        await sendTelegram(token, chatId, MSG.noDebtToPay);
        return;
      }
      const total = unpaid.reduce((sum, r) => sum + (Number.isFinite(r.amount) ? r.amount : 0), 0);
      await sendTelegram(
        token,
        chatId,
        `💳 Trả hết <b>${unpaid.length}</b> khoản, tổng <b>${formatCurrency(total)}</b>?`,
        payAllConfirmKeyboard()
      );
      return;
    }

    if (action === "payallok" || action === "pay") {
      await answerCallbackQuery(token, query.id);
      const text = await payBills(env.DB, userId, action === "pay" ? [id] : "all");
      if (action === "payallok") {
        await editTelegramMessage(token, chatId, messageId, text ?? MSG.noDebtToPay);
      } else {
        await sendTelegram(token, chatId, text ?? MSG.payNotFound);
      }
      return;
    }

    if (!Number.isInteger(id) || id <= 0) {
      await answerCallbackQuery(token, query.id);
      return;
    }

    const row = await getExpenseById(env.DB, userId, id);
    if (!row) {
      await answerCallbackQuery(token, query.id, MSG.buttonExpired);
      await editTelegramKeyboard(token, chatId, messageId, { inline_keyboard: [] });
      return;
    }

    switch (action) {
      case "del": {
        await deleteExpenseById(env.DB, id, userId);
        await answerCallbackQuery(token, query.id, "Đã xoá");
        await editTelegramMessage(token, chatId, messageId, `↩️ <b>Đã xoá</b>\n${describeRow(row)}`);
        return;
      }
      case "cat": {
        await answerCallbackQuery(token, query.id);
        await editTelegramKeyboard(token, chatId, messageId, categoryKeyboard(id));
        return;
      }
      case "back": {
        await answerCallbackQuery(token, query.id);
        await editTelegramKeyboard(token, chatId, messageId, transactionKeyboard(id, rowToSaved(row)));
        return;
      }
      case "setcat": {
        const category = CATEGORIES[Number(rawArg)];
        if (!category) {
          await answerCallbackQuery(token, query.id);
          return;
        }
        await updateExpenseCategory(env.DB, userId, id, category);
        await answerCallbackQuery(token, query.id, `Đã đổi sang ${categoryLabel(category)}`);
        await refreshTransactionMessage(env, chatId, messageId, { ...row, category });
        return;
      }
      case "card": {
        const toCard = row.payment_method !== "credit_card";
        await updateExpensePayment(env.DB, userId, id, toCard ? "credit_card" : "cash");
        await answerCallbackQuery(token, query.id, toCard ? "Đã chuyển sang thẻ tín dụng" : "Đã chuyển sang tiền mặt");
        await refreshTransactionMessage(env, chatId, messageId, {
          ...row,
          payment_method: toCard ? "credit_card" : "cash",
          is_paid: toCard ? 0 : 1,
        });
        return;
      }
      default:
        await answerCallbackQuery(token, query.id);
    }
  } catch (err: unknown) {
    console.error(`Error handling callback ${query.data}:`, err);
    await answerCallbackQuery(token, query.id, MSG.genericError.replace(/^⚠️ /, ""));
  }
}

/** Re-renders a transaction's confirmation message and keyboard from its updated row. */
async function refreshTransactionMessage(env: Env, chatId: number, messageId: number, row: ExpenseRow): Promise<void> {
  const saved = rowToSaved(row);
  await editTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, messageId, savedText(saved, true), transactionKeyboard(row.id, saved));
}
