import crypto from 'node:crypto';

export const MAX_HMAC_AGE_SECONDS = 300;

/**
 * HMAC-SHA256 signing for outbound webhooks.
 *
 * Signature string: hex(hmac_sha256(secret, "${timestamp}.${body}"))
 *
 * Downstream verification MUST check:
 *   1. timestamp within ±maxAge to prevent replay
 *   2. constant-time compare of signature
 */
export function signHmac(secret: string, timestamp: string, body: string): string {
  if (!secret) throw new Error('HMAC secret is required');
  const h = crypto.createHmac('sha256', secret);
  h.update(`${timestamp}.${body}`);
  return h.digest('hex');
}

/**
 * Verify a signature against secret, timestamp, and body.
 *
 * @param maxAgeSeconds age tolerance; default 300s (5 minutes)
 * @returns true if and only if: signature matches AND timestamp is fresh
 */
export function verifyHmac(
  secret: string,
  timestamp: string,
  body: string,
  signature: string,
  maxAgeSeconds = 300,
): boolean {
  if (!secret) return false;
  if (!timestamp || !signature) return false;

  const tsNum = parseInt(timestamp, 10);
  if (!Number.isFinite(tsNum) || tsNum <= 0) return false;

  const age = Math.abs(Date.now() / 1000 - tsNum);
  const effectiveMaxAge = normalizeMaxAge(maxAgeSeconds);
  if (age > effectiveMaxAge) return false;

  return verifyHmacSignature(secret, timestamp, body, signature);
}

/**
 * Verify only HMAC authenticity, without applying webhook-style wall-clock
 * freshness. Durable transports such as Kafka may legitimately redeliver a
 * signed record after an arbitrarily long consumer outage; replay safety is
 * provided by the broker offset and the consumer's durable idempotency inbox.
 */
export function verifyHmacSignature(
  secret: string,
  timestamp: string,
  body: string,
  signature: string,
): boolean {
  if (!secret || !timestamp || !signature) return false;

  const expected = signHmac(secret, timestamp, body);
  const a = Buffer.from(expected, 'hex');
  const b = Buffer.from(signature, 'hex');
  if (a.length !== b.length) return false;
  try {
    return crypto.timingSafeEqual(a, b);
  } catch {
    return false;
  }
}

function normalizeMaxAge(value: number): number {
  if (!Number.isFinite(value) || value <= 0) return 0;
  return Math.min(Math.floor(value), MAX_HMAC_AGE_SECONDS);
}

/**
 * Generate a unix-second timestamp string, suitable for `X-Webhook-Timestamp`.
 */
export function webhookTimestamp(): string {
  return Math.floor(Date.now() / 1000).toString();
}
