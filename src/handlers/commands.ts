import { formatAmount, formatCurrency } from "../formatters";
import {
  deleteExpenseById,
  getConfig,
  getLastExpense,
  getMonthExpensesByCategory,
  getTodayExpenses,
  getUnpaidCreditCardExpenses,
  payAllCreditCardExpenses,
  payCreditCardExpenses,
  setConfig,
} from "../services/db";
import { syncAvailableGeminiModels } from "../services/gemini";
import { sendTelegram } from "../services/telegram";
import { Env, ExpenseRow } from "../types";
import {
  CONFIG_KEY_ACTIVE_MODEL,
  CONFIG_KEY_DISCOVERED_MODELS,
  DEFAULT_GEMINI_MODEL,
  FALLBACK_GEMINI_MODELS,
} from "../constants";

/**
 * Handles incoming slash commands from Telegram users.
 *
 * @param command Command string starting with `/` (e.g. "/today", "/month", "/delete", "/help").
 * @param chatId Target Telegram chat ID.
 * @param env Environment containing D1 database binding and Telegram token.
 */
export async function handleCommand(command: string, chatId: number, env: Env): Promise<void> {
  const cmd = command.toLowerCase().split(" ")[0];

  try {
    switch (cmd) {
      case "/start":
      case "/help":
      case "/trogiup": {
        await sendTelegram(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          "🤖 **Available Commands:**\n• Send text or receipt photo to record an expense (e.g., Coffee 40k)\n• Credit card purchase (e.g., Dinner 300k credit card)\n• Refund/Cancellation (e.g., Refund Shopee 100k)\n• /today: View today's transactions\n• /month: Monthly breakdown\n• /debt: View unpaid credit card bills\n• /pay <id>: Settle credit card bills\n• /model: View or update Gemini AI model\n• /delete: Delete the last transaction"
        );
        break;
      }
      case "/today":
      case "/homnay": {
        const records = await getTodayExpenses(env.DB, chatId.toString());

        if (!records.length) {
          await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, "📅 No transactions recorded today.");
          return;
        }

        let total = 0;
        let msg = "📅 **Today's Transactions:**\n\n";

        for (const row of records) {
          const amount = typeof row.amount === "number" && Number.isFinite(row.amount) ? row.amount : 0;
          total += amount;
          const icon = amount < 0 ? "🟢" : "🔴";
          msg += `• ${icon} **${formatAmount(amount)}** - ${row.category || "Other"}: ${row.description || "Transaction"}\n`;
        }

        const totalPrefix = total < 0 ? "🟢 Net Surplus:" : "🔴 Total Spent:";
        msg += `\n👉 **${totalPrefix} ${formatCurrency(total)}**`;

        await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, msg);
        break;
      }
      case "/month":
      case "/thismonth":
      case "/thangnay": {
        const rows = await getMonthExpensesByCategory(env.DB, chatId.toString());

        if (!rows.length) {
          await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, "📊 No transactions recorded this month.");
          return;
        }

        let grandTotal = 0;
        let reportText = "📊 **Monthly Expense Report:**\n\n";

        for (const row of rows) {
          const totalCat = typeof row.total_cat === "number" && Number.isFinite(row.total_cat) ? row.total_cat : 0;
          grandTotal += totalCat;
          const sign = totalCat < 0 ? "-" : "";
          reportText += `• **${row.category || "Other"}**: ${sign}${formatAmount(totalCat)}\n`;
        }

        const totalPrefix = grandTotal < 0 ? "🟢 Net Surplus:" : "🔴 Actual Total Spent:";
        reportText += `\n━━━━━━━━━━━━━━━\n💰 **${totalPrefix} ${formatCurrency(grandTotal)}**`;

        await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, reportText);
        break;
      }
      case "/delete":
      case "/xoa": {
        const last = await getLastExpense(env.DB, chatId.toString());
        if (!last) {
          await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, "No transactions found.");
          return;
        }

        await deleteExpenseById(env.DB, last.id);
        const amount = typeof last.amount === "number" && Number.isFinite(last.amount) ? last.amount : 0;
        const action = amount < 0 ? "refund" : "expense";
        const desc = last.description || "Transaction";
        await sendTelegram(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          `🗑 Deleted ${action}: **${formatAmount(amount)}** (${desc})`
        );
        break;
      }
      case "/debt":
      case "/credit":
      case "/nothe": {
        const unpaid = await getUnpaidCreditCardExpenses(env.DB, chatId.toString());

        if (!unpaid.length) {
          await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, "💳 No unpaid credit card bills found.");
          return;
        }

        let totalDebt = 0;
        let msg = "💳 **Unpaid Credit Card Bills:**\n\n";

        for (const bill of unpaid) {
          const amount = typeof bill.amount === "number" && Number.isFinite(bill.amount) ? bill.amount : 0;
          totalDebt += amount;
          const date = bill.created_at ? bill.created_at.split(" ")[0] : "";
          const datePart = date ? ` (${date})` : "";
          msg += `• **#${bill.id}** • ${formatAmount(amount)} - ${bill.category || "Other"}: ${bill.description || "Transaction"}${datePart}\n`;
        }

        msg += `\n━━━━━━━━━━━━━━━\n💳 **Total Unpaid Debt: ${formatCurrency(totalDebt)}**\n\n`;
        msg += `👉 Settle bills: \`/pay <id>\` (e.g., \`/pay 5\` or \`/pay 5,8\` or \`/pay all\`)`;

        await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, msg);
        break;
      }
      case "/pay":
      case "/trano":
      case "/paydebt": {
        const parts = command.trim().split(/\s+/);
        const arg = parts.slice(1).join(" ").trim().toLowerCase();

        if (!arg) {
          await sendTelegram(
            env.TELEGRAM_BOT_TOKEN,
            chatId,
            "⚠️ Please specify bill ID(s) to pay, or use `/pay all`.\nExample: `/pay 5` or `/pay 5, 8` or `/pay all`\nView unpaid bills with /debt"
          );
          return;
        }

        let paidRows: ExpenseRow[] = [];
        if (arg === "all") {
          paidRows = await payAllCreditCardExpenses(env.DB, chatId.toString());
          if (!paidRows.length) {
            await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, "💳 No unpaid credit card bills to pay.");
            return;
          }
        } else {
          const ids = arg
            .split(/[\s,]+/)
            .map(Number)
            .filter((n) => Number.isInteger(n) && n > 0);

          if (ids.length === 0) {
            await sendTelegram(
              env.TELEGRAM_BOT_TOKEN,
              chatId,
              "⚠️ Invalid bill ID(s). Example: `/pay 5` or `/pay 5, 8` or `/pay all`"
            );
            return;
          }

          paidRows = await payCreditCardExpenses(env.DB, chatId.toString(), ids);
          if (!paidRows.length) {
            await sendTelegram(
              env.TELEGRAM_BOT_TOKEN,
              chatId,
              "⚠️ No matching unpaid credit card bills found for the specified ID(s)."
            );
            return;
          }
        }

        const totalPaid = paidRows.reduce((sum, r) => sum + (Number.isFinite(r.amount) ? r.amount : 0), 0);
        let msg = `✅ **Credit Card Payment Recorded:**\nPaid ${paidRows.length} bill(s) totaling **${formatCurrency(totalPaid)}**:\n`;
        for (const r of paidRows) {
          msg += `• #${r.id}: ${formatAmount(r.amount)} - ${r.description || "Transaction"}\n`;
        }

        const remainingUnpaid = await getUnpaidCreditCardExpenses(env.DB, chatId.toString());
        const remainingTotal = remainingUnpaid.reduce((sum, r) => sum + (Number.isFinite(r.amount) ? r.amount : 0), 0);
        msg += `\n💳 Remaining Unpaid Debt: **${formatCurrency(remainingTotal)}**`;

        await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, msg);
        break;
      }
      case "/model":
      case "/gemini": {
        const parts = command.trim().split(/\s+/);
        const arg = parts.slice(1).join(" ").trim();

        if (!arg) {
          const activeModel = (await getConfig(env.DB, CONFIG_KEY_ACTIVE_MODEL)) || DEFAULT_GEMINI_MODEL;
          const cachedRaw = await getConfig(env.DB, CONFIG_KEY_DISCOVERED_MODELS);
          let models: string[] = [...FALLBACK_GEMINI_MODELS];
          if (cachedRaw) {
            try {
              const parsed = JSON.parse(cachedRaw) as string[];
              if (Array.isArray(parsed) && parsed.length > 0) {
                models = parsed;
              }
            } catch {}
          }

          let msg = "🤖 **Gemini AI Model Settings:**\n\n";
          msg += `• Active Model: **${activeModel}** ⭐\n\n`;
          msg += "📋 **Available Models:**\n";
          for (let i = 0; i < models.length; i++) {
            const m = models[i];
            const star = m === activeModel ? " (Active ⭐)" : "";
            msg += `${i + 1}. \`${m}\`${star}\n`;
          }

          msg += "\n💡 **Options:**\n";
          msg += "• `/model <name>`: Switch to model (e.g. `/model gemini-3.5-flash`)\n";
          msg += "• `/model auto`: Auto-detect & switch to newest model\n";
          msg += "• `/model sync`: Refresh models list from Google\n";
          msg += "• `/model reset`: Reset to default model";

          await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, msg);
          break;
        }

        const lowerArg = arg.toLowerCase();

        if (lowerArg === "sync" || lowerArg === "auto") {
          const { activeModel, models } = await syncAvailableGeminiModels(env.GEMINI_API_KEY, env.DB);

          let msg = lowerArg === "auto" ? "🔄 **Gemini AI Auto-Updated:**\n" : "🔄 **Gemini Models Synchronized:**\n";
          msg += `Active model set to: **${activeModel}** ⭐\n\n`;
          msg += `Discovered ${models.length} compatible model(s):\n`;
          for (const m of models) {
            const star = m === activeModel ? " (Active ⭐)" : "";
            msg += `• \`${m}\`${star}\n`;
          }
          msg += "\n👉 Switch model anytime with: `/model <name>`";

          await sendTelegram(env.TELEGRAM_BOT_TOKEN, chatId, msg);
          break;
        }

        if (lowerArg === "reset") {
          await setConfig(env.DB, CONFIG_KEY_ACTIVE_MODEL, DEFAULT_GEMINI_MODEL);
          await sendTelegram(
            env.TELEGRAM_BOT_TOKEN,
            chatId,
            `✅ Reset Gemini model to default: **${DEFAULT_GEMINI_MODEL}**`
          );
          break;
        }

        const targetModel = arg.replace(/^models\//i, "").trim();
        await setConfig(env.DB, CONFIG_KEY_ACTIVE_MODEL, targetModel);
        await sendTelegram(
          env.TELEGRAM_BOT_TOKEN,
          chatId,
          `✅ Active Gemini model changed to: **${targetModel}**`
        );
        break;
      }
    }
  } catch (err: unknown) {
    console.error(`Error executing command ${cmd}:`, err);
    await sendTelegram(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      "⚠️ An error occurred while processing your request. Please try again later."
    );
  }
}
