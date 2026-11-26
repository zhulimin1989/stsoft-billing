import crypto from 'node:crypto';
import type { IHeaders } from 'kafkajs';

export const BILLING_USAGE_KAFKA_HMAC_SCHEME = 'gateway-usage-hmac-v1';

export const BILLING_USAGE_KAFKA_HMAC_HEADER_NAMES = [
  'x-billing-key-id',
  'x-billing-timestamp',
  'x-billing-signature',
] as const;

export type BillingUsageKafkaHmacMode = 'off' | 'shadow' | 'required';

export type BillingUsageKafkaHmacOutcome =
  | 'valid'
  | 'missing_headers'
  | 'conflicting_header_names'
  | 'duplicate_header_values'
  | 'invalid_header_value'
  | 'invalid_key_id'
  | 'invalid_timestamp'
  | 'invalid_signature_format'
  | 'unknown_key_id'
  | 'invalid_signature';

export type BillingUsageKafkaHmacVerification =
  | { valid: true; outcome: 'valid' }
  | {
      valid: false;
      outcome: Exclude<BillingUsageKafkaHmacOutcome, 'valid'>;
    };

type BillingUsageKafkaHmacHeaderName =
  typeof BILLING_USAGE_KAFKA_HMAC_HEADER_NAMES[number];

const HEADER_NAMES = new Set<string>(BILLING_USAGE_KAFKA_HMAC_HEADER_NAMES);
const KEY_ID = /^[A-Za-z0-9._-]{1,64}$/;
const UNIX_SECONDS = /^[1-9][0-9]*$/;
const LOWERCASE_SHA256 = /^[0-9a-f]{64}$/;

export function isBillingUsageKafkaHmacKeyId(value: string): boolean {
  return KEY_ID.test(value);
}

/**
 * Verifies the Billing/Gateway Kafka usage authentication envelope.
 *
 * This contract intentionally has no wall-clock freshness check: Kafka is a
 * durable log and an authentic record must survive an arbitrarily long
 * consumer outage. Financial replay safety remains the responsibility of the
 * durable request_id/evidence inbox.
 */
export function verifyBillingUsageKafkaHmacV1(
  headers: IHeaders | undefined,
  messageValue: Buffer,
  keyring: ReadonlyMap<string, string>,
): BillingUsageKafkaHmacVerification {
  const parsed = parseAuthenticationHeaders(headers);
  if (!parsed.valid) return parsed;

  const secret = keyring.get(parsed.keyId);
  if (!secret) {
    return { valid: false, outcome: 'unknown_key_id' };
  }

  const payloadSha256 = crypto
    .createHash('sha256')
    .update(messageValue)
    .digest('hex');
  const signingInput = [
    BILLING_USAGE_KAFKA_HMAC_SCHEME,
    parsed.keyId,
    parsed.timestamp,
    payloadSha256,
  ].join('\n');
  const expected = crypto
    .createHmac('sha256', secret)
    .update(signingInput, 'utf8')
    .digest();
  const actual = Buffer.from(parsed.signature, 'hex');

  return crypto.timingSafeEqual(expected, actual)
    ? { valid: true, outcome: 'valid' }
    : { valid: false, outcome: 'invalid_signature' };
}

type ParsedAuthenticationHeaders =
  | {
      valid: true;
      keyId: string;
      timestamp: string;
      signature: string;
    }
  | {
      valid: false;
      outcome: Exclude<BillingUsageKafkaHmacOutcome, 'valid'>;
    };

function parseAuthenticationHeaders(
  headers: IHeaders | undefined,
): ParsedAuthenticationHeaders {
  const candidates = new Map<string, Array<{ name: string; value: unknown }>>();
  for (const [name, value] of Object.entries(headers ?? {})) {
    const normalized = name.toLowerCase();
    if (!HEADER_NAMES.has(normalized)) continue;
    const values = candidates.get(normalized) ?? [];
    values.push({ name, value });
    candidates.set(normalized, values);
  }

  const values = new Map<BillingUsageKafkaHmacHeaderName, string>();
  for (const name of BILLING_USAGE_KAFKA_HMAC_HEADER_NAMES) {
    const matches = candidates.get(name) ?? [];
    if (matches.length === 0) {
      return { valid: false, outcome: 'missing_headers' };
    }
    if (matches.length !== 1 || matches[0]?.name !== name) {
      return { valid: false, outcome: 'conflicting_header_names' };
    }
    const raw = matches[0].value;
    if (Array.isArray(raw)) {
      return { valid: false, outcome: 'duplicate_header_values' };
    }
    if (!Buffer.isBuffer(raw) && typeof raw !== 'string') {
      return { valid: false, outcome: 'invalid_header_value' };
    }
    values.set(name, Buffer.isBuffer(raw) ? raw.toString('utf8') : raw);
  }

  const keyId = values.get('x-billing-key-id')!;
  const timestamp = values.get('x-billing-timestamp')!;
  const signature = values.get('x-billing-signature')!;
  if (!isBillingUsageKafkaHmacKeyId(keyId)) {
    return { valid: false, outcome: 'invalid_key_id' };
  }
  if (!UNIX_SECONDS.test(timestamp)) {
    return { valid: false, outcome: 'invalid_timestamp' };
  }
  if (!LOWERCASE_SHA256.test(signature)) {
    return { valid: false, outcome: 'invalid_signature_format' };
  }
  return { valid: true, keyId, timestamp, signature };
}
