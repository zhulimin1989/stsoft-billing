import crypto from 'node:crypto';
import type { IHeaders } from 'kafkajs';
import {
  BILLING_USAGE_KAFKA_HMAC_SCHEME,
  verifyBillingUsageKafkaHmacV1,
} from './billing-usage-kafka-hmac';

const VECTOR_SECRET = '0123456789abcdef0123456789abcdef';
const VECTOR_KEY_ID = 'usage-test-a';
const VECTOR_TIMESTAMP = '1786752000';
const VECTOR_BODY = Buffer.from(
  '{"event_type":"usage","request_id":"req-hmac-vector-1","version":"v2"}',
  'utf8',
);
const VECTOR_PAYLOAD_SHA256 = 'df8a02852521ba2e5009aae6deb8e90bbecd4cfae5f6498860d1c3b13d90c913';
const VECTOR_SIGNATURE = '5722ba1a1cc13bb3d5935316dcf73aaff09ab953e8d689befc7ebcfb98c9a851';

function sign(
  secret: string,
  keyId: string,
  timestamp: string,
  body: Buffer,
): string {
  const payloadSha256 = crypto.createHash('sha256').update(body).digest('hex');
  return crypto
    .createHmac('sha256', secret)
    .update([
      BILLING_USAGE_KAFKA_HMAC_SCHEME,
      keyId,
      timestamp,
      payloadSha256,
    ].join('\n'))
    .digest('hex');
}

function headers(
  keyId = VECTOR_KEY_ID,
  timestamp = VECTOR_TIMESTAMP,
  signature = VECTOR_SIGNATURE,
): IHeaders {
  return {
    'x-billing-key-id': Buffer.from(keyId),
    'x-billing-timestamp': Buffer.from(timestamp),
    'x-billing-signature': Buffer.from(signature),
  };
}

describe('verifyBillingUsageKafkaHmacV1', () => {
  const keyring = new Map([[VECTOR_KEY_ID, VECTOR_SECRET]]);

  it('matches the shared Gateway/Billing fixed vector without a trailing newline', () => {
    expect(crypto.createHash('sha256').update(VECTOR_BODY).digest('hex'))
      .toBe(VECTOR_PAYLOAD_SHA256);
    expect(sign(VECTOR_SECRET, VECTOR_KEY_ID, VECTOR_TIMESTAMP, VECTOR_BODY))
      .toBe(VECTOR_SIGNATURE);
    expect(verifyBillingUsageKafkaHmacV1(headers(), VECTOR_BODY, keyring))
      .toEqual({ valid: true, outcome: 'valid' });
  });

  it('authenticates the exact message bytes rather than parsed JSON', () => {
    const reformatted = Buffer.from(
      '{ "event_type":"usage","request_id":"req-hmac-vector-1","version":"v2" }',
    );
    expect(verifyBillingUsageKafkaHmacV1(headers(), reformatted, keyring))
      .toEqual({ valid: false, outcome: 'invalid_signature' });
  });

  it('does not apply webhook freshness to an authentic durable record', () => {
    const timestamp = '1';
    const signature = sign(VECTOR_SECRET, VECTOR_KEY_ID, timestamp, VECTOR_BODY);
    expect(verifyBillingUsageKafkaHmacV1(
      headers(VECTOR_KEY_ID, timestamp, signature),
      VECTOR_BODY,
      keyring,
    )).toEqual({ valid: true, outcome: 'valid' });
  });

  it('accepts scalar string headers', () => {
    expect(verifyBillingUsageKafkaHmacV1({
      'x-billing-key-id': VECTOR_KEY_ID,
      'x-billing-timestamp': VECTOR_TIMESTAMP,
      'x-billing-signature': VECTOR_SIGNATURE,
    }, VECTOR_BODY, keyring)).toEqual({ valid: true, outcome: 'valid' });
  });

  it.each([
    [{}, 'missing_headers'],
    [{
      ...headers(),
      'x-billing-signature': [VECTOR_SIGNATURE],
    }, 'duplicate_header_values'],
    [{
      ...headers(),
      'X-Billing-Signature': VECTOR_SIGNATURE,
    }, 'conflicting_header_names'],
    [{
      'X-Billing-Key-Id': VECTOR_KEY_ID,
      'x-billing-timestamp': VECTOR_TIMESTAMP,
      'x-billing-signature': VECTOR_SIGNATURE,
    }, 'conflicting_header_names'],
  ] as Array<[IHeaders, string]>)('rejects ambiguous headers as %s', (input, outcome) => {
    expect(verifyBillingUsageKafkaHmacV1(input, VECTOR_BODY, keyring))
      .toEqual({ valid: false, outcome });
  });

  it.each(['0', '01', '+1', '-1', '1.0', ' 1'])('rejects non-canonical unix seconds %s', (timestamp) => {
    expect(verifyBillingUsageKafkaHmacV1(
      headers(VECTOR_KEY_ID, timestamp, VECTOR_SIGNATURE),
      VECTOR_BODY,
      keyring,
    )).toEqual({ valid: false, outcome: 'invalid_timestamp' });
  });

  it.each(['usage:key', 'usage key', '', 'a'.repeat(65)])('rejects an invalid key id %s', (keyId) => {
    expect(verifyBillingUsageKafkaHmacV1(
      headers(keyId),
      VECTOR_BODY,
      keyring,
    )).toEqual({ valid: false, outcome: 'invalid_key_id' });
  });

  it.each([
    VECTOR_SIGNATURE.toUpperCase(),
    `${VECTOR_SIGNATURE}zz`,
    VECTOR_SIGNATURE.slice(0, 62),
  ])('rejects a non-canonical signature %s', (signature) => {
    expect(verifyBillingUsageKafkaHmacV1(
      headers(VECTOR_KEY_ID, VECTOR_TIMESTAMP, signature),
      VECTOR_BODY,
      keyring,
    )).toEqual({ valid: false, outcome: 'invalid_signature_format' });
  });

  it('reports an unknown key without exposing the key id in the outcome', () => {
    expect(verifyBillingUsageKafkaHmacV1(
      headers('unknown-region-key'),
      VECTOR_BODY,
      keyring,
    )).toEqual({ valid: false, outcome: 'unknown_key_id' });
  });
});
