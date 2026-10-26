import { TZ_OFFSET_HOURS } from "./constants";

/**
 * Shared Intl.NumberFormat instance (Vietnamese grouping: 45.000) to avoid per-request allocation.
 */
const numberFormatter = new Intl.NumberFormat("vi-VN", { maximumFractionDigits: 0 });

function sanitizeAmount(amount: unknown): number {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    return 0;
  }
  return Math.abs(amount);
}

/**
 * Formats a numeric amount in Vietnamese style with a trailing dong sign.
 * Sanitizes NaN / Infinity safely to 0 and always shows the absolute value
 * (callers show the sign through icons or labels).
 * Example: 45000 -> "45.000 ₫"
 */
export function formatAmount(amount: number): string {
  return `${numberFormatter.format(sanitizeAmount(amount))} ₫`;
}

/** Same output as {@link formatAmount}; kept as a separate name for call sites that format totals. */
export const formatCurrency = formatAmount;

/** Aliases for backwards compatibility */
export const formatVnd = formatAmount;
export const formatCurrencyVnd = formatAmount;

/** Escapes text for Telegram HTML parse mode. */
export function escapeHtml(text: string): string {
  return text.replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

/** Strips HTML tags/entities so a Telegram message can be shown as plain text. */
export function stripHtml(html: string): string {
  return html
    .replace(/<[^>]+>/g, "")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&amp;/g, "&");
}

/** Returns the current local (UTC+7) date as YYYY-MM-DD. */
export function localToday(now: Date = new Date()): string {
  return new Date(now.getTime() + TZ_OFFSET_HOURS * 3600_000).toISOString().slice(0, 10);
}

/** Converts a D1 UTC timestamp ("YYYY-MM-DD HH:MM:SS") to its local (UTC+7) YYYY-MM-DD date. */
export function toLocalDate(createdAt: string): string {
  const parsed = new Date(createdAt.replace(" ", "T") + "Z");
  if (Number.isNaN(parsed.getTime())) return createdAt.slice(0, 10);
  return localToday(parsed);
}

/** Formats YYYY-MM-DD as DD/MM/YYYY. */
export function formatDate(isoDate: string): string {
  const [y, m, d] = isoDate.split("-");
  return y && m && d ? `${d}/${m}/${y}` : isoDate;
}

/** Returns the local month (YYYY-MM) `offset` months away from now (0 = this month, -1 = last month). */
export function localMonth(offset = 0, now: Date = new Date()): string {
  const local = new Date(now.getTime() + TZ_OFFSET_HOURS * 3600_000);
  const d = new Date(Date.UTC(local.getUTCFullYear(), local.getUTCMonth() + offset, 1));
  return d.toISOString().slice(0, 7);
}

/** Text progress bar for a 0-100 percentage, e.g. "▓▓▓░░░░░░░". */
export function percentBar(percent: number, width = 10): string {
  const filled = Math.max(0, Math.min(width, Math.round((percent / 100) * width)));
  return "▓".repeat(filled) + "░".repeat(width - filled);
}
