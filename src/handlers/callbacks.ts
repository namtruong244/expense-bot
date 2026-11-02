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
import { confirmedPayAllMaxId, payAllPrompt, payBills, sendPayAllConfirm } from "./commands";

/**
 * Handles inline keyboard button presses. Callback data format:
 *   del:<id>            delete a transaction (undo / confirmed /delete)
 *   cat:<id>            open the category picker
 *   setcat:<id>:<index> set the category (index into CATEGORIES)
 *   back:<id>           close the category picker
 *   card:<id>           toggle cash <-> credit card (not for bills already paid)
 *   pay:<id>            pay one credit card bill
 *   payall              ask to confirm paying every bill (see /pay all)
 *   payallok:<maxId>:<count>:<total>  pay the bills the prompt showed
 *   cancel              dismiss a confirmation
 * Every query is scoped to the chat that pressed the button.
 */
export async function handleCallbackQuery(query: TelegramCallbackQuery, env: Env): Promise<void> {
  const token = env.TELEGRAM_BOT_TOKEN;
  const chatId = query.message?.chat?.id;
  const messageId = query.message?.message_id;
  const [action = "", ...args] = (query.data || "").split(":");
  const [rawId = "", rawArg = ""] = args;

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
      await sendPayAllConfirm(env.DB, token, chatId, userId);
      return;
    }

    if (action === "payallok") {
      await answerCallbackQuery(token, query.id);
      const unpaid = await getUnpaidCreditCardExpenses(env.DB, userId);
      if (!unpaid.length) {
        await editTelegramMessage(token, chatId, messageId, MSG.noDebtToPay);
        return;
      }
      const maxId = confirmedPayAllMaxId(unpaid, args);
      if (maxId === null) {
        // Bills changed since the prompt (or it predates this check): ask again with the current list.
        const prompt = payAllPrompt(unpaid);
        await editTelegramMessage(token, chatId, messageId, `${MSG.payAllChanged}\n\n${prompt.text}`, prompt.keyboard);
        return;
      }
      const text = await payBills(env.DB, userId, { upToId: maxId });
      await editTelegramMessage(token, chatId, messageId, text ?? MSG.noDebtToPay);
      return;
    }

    if (action === "pay") {
      await answerCallbackQuery(token, query.id);
      const text = await payBills(env.DB, userId, [id]);
      await sendTelegram(token, chatId, text ?? MSG.payNotFound);
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
        const changed = await updateExpensePayment(env.DB, userId, id, toCard ? "credit_card" : "cash");
        if (!changed) {
          const current = await getExpenseById(env.DB, userId, id);
          if (!current) {
            // Deleted since the button was pressed: nothing to switch, and the buttons are dead.
            await answerCallbackQuery(token, query.id, MSG.buttonExpired);
            await editTelegramKeyboard(token, chatId, messageId, { inline_keyboard: [] });
            return;
          }
          // Already paid by card (e.g. via /pay): switching it would erase the payment.
          await answerCallbackQuery(token, query.id, MSG.cardAlreadyPaid);
          await refreshTransactionMessage(env, chatId, messageId, current);
          return;
        }
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
