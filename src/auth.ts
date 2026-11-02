const encoder = new TextEncoder();

/**
 * Compares a secret sent by a client with the configured one in constant time,
 * so response timing does not reveal how much of the secret was right.
 */
export function secretMatches(provided: string | null | undefined, expected: string): boolean {
  if (provided == null || !expected) return false;
  const a = encoder.encode(provided);
  const b = encoder.encode(expected);
  let diff = a.length ^ b.length;
  for (let i = 0; i < b.length; i++) {
    diff |= (a[i] ?? 0) ^ b[i];
  }
  return diff === 0;
}

let warnedNoWebhookSecret = false;

/**
 * True when the request carries Telegram's webhook secret, or when no secret is configured
 * (kept for existing deployments; anyone can then post fake updates, so a warning is logged).
 */
export function isTelegramRequestAuthorized(headers: Headers, secret?: string): boolean {
  const expected = (secret || "").trim();
  if (!expected) {
    if (!warnedNoWebhookSecret) {
      console.warn("TELEGRAM_WEBHOOK_SECRET is not set: webhook requests are not authenticated.");
      warnedNoWebhookSecret = true;
    }
    return true;
  }
  return secretMatches(headers.get("X-Telegram-Bot-Api-Secret-Token"), expected);
}

/** Reads a `Authorization: Bearer <token>` header. */
export function bearerToken(headers: Headers): string | null {
  const match = /^Bearer\s+(.+)$/i.exec(headers.get("Authorization") || "");
  return match ? match[1].trim() : null;
}
