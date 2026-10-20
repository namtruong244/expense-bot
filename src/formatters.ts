/**
 * Shared Intl.NumberFormat instances to avoid per-request memory allocation in hot loops.
 */
const numberFormatter = new Intl.NumberFormat("en-US");

const currencyFormatter = new Intl.NumberFormat("en-US", {
  style: "currency",
  currency: "VND",
  maximumFractionDigits: 0,
});

function sanitizeAmount(amount: unknown): number {
  if (typeof amount !== "number" || !Number.isFinite(amount)) {
    return 0;
  }
  return Math.abs(amount);
}

/**
 * Formats a numeric amount with standard thousand separators.
 * Sanitizes NaN / Infinity safely to 0.
 * Example: 45000 -> "₫45,000"
 */
export function formatAmount(amount: number): string {
  return `₫${numberFormatter.format(sanitizeAmount(amount))}`;
}

/**
 * Formats a currency amount according to en-US locale.
 * Sanitizes NaN / Infinity safely to 0.
 * Example: 45000 -> "₫45,000"
 */
export function formatCurrency(amount: number): string {
  return currencyFormatter.format(sanitizeAmount(amount));
}

/** Aliases for backwards compatibility */
export const formatVnd = formatAmount;
export const formatCurrencyVnd = formatCurrency;
