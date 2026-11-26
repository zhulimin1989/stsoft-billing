/**
 * Load test for T-7 (idempotency) + T-8 (Redis+PG consistency) + T-9 (check-and-deduct RPC).
 *
 * Scenarios:
 *   1. Concurrent distinct-key deduct — no over-deduct, all persisted
 *   2. Concurrent SAME-key replay — exactly one deduct actually happens, others return cache
 *
 * Usage (from host running the admin API via Docker):
 *   BASE_URL=https://saas-test.codesphere.run \
 *   SYNC_TOKEN=xxx \
 *   EMAIL=testuser@test.com \
 *   PRODUCT_SLUG=raytone \
 *   ALLOW_REMOTE_LOAD_TEST=true \
 *   npx tsx scripts/load-test-deduct.ts
 *
 * Remote targets are blocked unless ALLOW_REMOTE_LOAD_TEST=true is set.
 * This keeps accidental load tests from hitting shared test/prod services.
 *
 * The script assumes the target user has an ACTIVE subscription with enough
 * credits for `CONCURRENCY * AMOUNT` units. For the test user we picked
 * (testuser@test.com on raytone/Free with 100k credits), concurrent=100
 * amount=10 is comfortably below the limit.
 */

import { randomUUID } from 'node:crypto';

const BASE_URL = requiredEnv('BASE_URL');
const SYNC_TOKEN = requiredEnv('SYNC_TOKEN');
const EMAIL = requiredEnv('EMAIL');
const PRODUCT_SLUG = requiredEnv('PRODUCT_SLUG');

const CONCURRENCY = parseInt(process.env.CONCURRENCY ?? '100', 10);
const AMOUNT = parseInt(process.env.AMOUNT ?? '10', 10);

assertSafeTarget(BASE_URL);

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) {
    console.error(`ERROR: ${name} is required for load-test-deduct.ts`);
    process.exit(1);
  }
  return value;
}

function assertSafeTarget(baseUrl: string): void {
  let parsed: URL;
  try {
    parsed = new URL(baseUrl);
  } catch {
    console.error(`ERROR: BASE_URL is not a valid URL: ${baseUrl}`);
    process.exit(1);
  }

  const host = parsed.hostname.toLowerCase();
  const isLocal =
    host === 'localhost' ||
    host === '127.0.0.1' ||
    host === '::1' ||
    host.endsWith('.localhost');
  if (!isLocal && process.env.ALLOW_REMOTE_LOAD_TEST !== 'true') {
    console.error(
      'ERROR: refusing remote load test target. Set ALLOW_REMOTE_LOAD_TEST=true to run intentionally.',
    );
    process.exit(1);
  }
}

interface DeductResult {
  success: boolean;
  quotaAfter?: number;
  bonusAfter?: number;
  totalAfter?: number;
  reason?: string;
}

interface RpcResponse {
  code: number;
  message: string;
  data: DeductResult & {
    allowed?: boolean;
  };
}

async function callCheckAndDeduct(idempotencyKey: string, amount = AMOUNT) {
  const res = await fetch(`${BASE_URL}/api/sync/check-and-deduct`, {
    method: 'POST',
    headers: {
      'Content-Type': 'application/json',
      'X-Sync-Token': SYNC_TOKEN,
    },
    body: JSON.stringify({
      email: EMAIL,
      productSlug: PRODUCT_SLUG,
      amount,
      source: 'load-test',
      idempotencyKey,
    }),
  });
  const text = await res.text();
  let parsed: RpcResponse | undefined;
  try {
    parsed = JSON.parse(text) as RpcResponse;
  } catch {
    // non-JSON response
  }
  return { httpStatus: res.status, body: parsed, raw: text };
}

async function getUserCredits(): Promise<{
  quota: number;
  bonus: number;
  total: number;
} | null> {
  const res = await fetch(
    `${BASE_URL}/api/sync/user-credits?email=${encodeURIComponent(EMAIL)}&productSlug=${encodeURIComponent(PRODUCT_SLUG)}`,
    {
      headers: { 'X-Sync-Token': SYNC_TOKEN },
    },
  );
  if (!res.ok) return null;
  const j = (await res.json()) as { data?: { quota: number; bonus: number; total: number } };
  return j.data ?? null;
}

async function scenarioDistinctKeys() {
  console.log(`\n=== Scenario 1: ${CONCURRENCY} distinct-key concurrent deducts, amount=${AMOUNT} ===`);
  const before = await getUserCredits();
  console.log('balance before:', before);
  if (!before) {
    console.error('ERROR: cannot read balance, bailing out');
    process.exit(1);
  }

  const tasks = Array.from({ length: CONCURRENCY }, () => {
    const key = `load-distinct-${randomUUID()}`;
    return callCheckAndDeduct(key);
  });
  const t0 = Date.now();
  const results = await Promise.allSettled(tasks);
  const elapsedMs = Date.now() - t0;

  let allowed = 0;
  let insufficient = 0;
  let otherFailure = 0;
  const reasons = new Map<string, number>();

  for (const r of results) {
    if (r.status !== 'fulfilled') {
      otherFailure++;
      continue;
    }
    const body = r.value.body?.data;
    if (!body) {
      otherFailure++;
      continue;
    }
    if (body.allowed) allowed++;
    else if (body.reason === 'insufficient_balance') insufficient++;
    else otherFailure++;
    if (body.reason) reasons.set(body.reason, (reasons.get(body.reason) ?? 0) + 1);
  }

  const after = await getUserCredits();
  console.log('balance after:', after);
  console.log('results:', { allowed, insufficient, otherFailure, elapsedMs, reasons: Object.fromEntries(reasons) });

  const expectedConsumed = allowed * AMOUNT;
  const actualConsumed = (before.total - (after?.total ?? 0));
  const diff = actualConsumed - expectedConsumed;

  console.log({ expectedConsumed, actualConsumed, diff });
  const verdict = diff === 0 ? '✅ PASS — no over/under-deduct' : `❌ FAIL — drift ${diff}`;
  console.log('Scenario 1 verdict:', verdict);
  return diff === 0;
}

async function scenarioSameKeyReplay() {
  console.log(`\n=== Scenario 2: 20 concurrent calls with SAME idempotencyKey ===`);
  const before = await getUserCredits();
  console.log('balance before:', before);

  const key = `load-replay-${randomUUID()}`;
  const N = 20;
  const tasks = Array.from({ length: N }, () => callCheckAndDeduct(key));
  const t0 = Date.now();
  const results = await Promise.allSettled(tasks);
  const elapsedMs = Date.now() - t0;

  let allowed = 0;
  let firstTotalAfter: number | undefined;
  let allSameTotal = true;

  for (const r of results) {
    if (r.status !== 'fulfilled') continue;
    const d = r.value.body?.data;
    if (!d) continue;
    if (d.allowed) {
      allowed++;
      if (firstTotalAfter === undefined) {
        firstTotalAfter = d.totalAfter;
      } else if (d.totalAfter !== firstTotalAfter) {
        allSameTotal = false;
      }
    }
  }

  const after = await getUserCredits();
  console.log('balance after:', after);
  console.log({
    callCount: N,
    allowed,
    elapsedMs,
    allReturnedSameTotalAfter: allSameTotal,
  });

  const actualConsumed = before!.total - (after?.total ?? 0);
  const verdict =
    actualConsumed === AMOUNT && allSameTotal && allowed === N
      ? '✅ PASS — exactly one deduct, all replays returned cached result'
      : `❌ FAIL — consumed=${actualConsumed} (expected ${AMOUNT}), allSameTotal=${allSameTotal}, allowed=${allowed}/${N}`;
  console.log('Scenario 2 verdict:', verdict);
  return actualConsumed === AMOUNT && allSameTotal && allowed === N;
}

async function main() {
  console.log(`Target: ${BASE_URL}`);
  console.log(`User:   ${EMAIL} / ${PRODUCT_SLUG}`);

  const health = await fetch(`${BASE_URL}/api/health`).then(r => r.ok).catch(() => false);
  if (!health) {
    console.error(`ERROR: ${BASE_URL}/api/health is not responding`);
    process.exit(1);
  }

  const pass1 = await scenarioDistinctKeys();
  const pass2 = await scenarioSameKeyReplay();

  console.log('\n=== SUMMARY ===');
  console.log('Scenario 1 (distinct keys, no over-deduct):', pass1 ? '✅' : '❌');
  console.log('Scenario 2 (same key, replay returns cache):', pass2 ? '✅' : '❌');

  if (!(pass1 && pass2)) process.exit(2);
}

main().catch((e) => {
  console.error('unhandled error:', e);
  process.exit(3);
});
