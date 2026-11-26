/**
 * CreditBalanceState legacy audit/backfill.
 *
 * Auto-apply requires all three sources to agree:
 *   1. deterministic replay of every quota/bonus ledger transition;
 *   2. the final legacy quota/bonus Redis snapshot;
 *   3. an existing V2 state, when present.
 *
 * Legacy CONSUME rows do not persist fromGrant. Any history that would require
 * grant allocation is deliberately quarantined instead of guessing; this also
 * prevents a duplicated cold-cache after snapshot from masquerading as grant use.
 */
import { Prisma, PrismaClient } from '@prisma/client';
import Redis from 'ioredis';
import {
  LegacyCreditBalanceTransaction,
  parseLegacyCreditBalanceCacheValue,
  replayLegacyCreditBalance,
} from '../src/billing/credit-balance-ledger-replay';

const BATCH_SIZE = 200;
const LEGACY_QUOTA_PREFIX = 'credits:quota:';
const LEGACY_BONUS_PREFIX = 'credits:bonus:';

type ScopeIdRow = { subscriptionId: string };

export type AuditCounters = {
  scanned: number;
  verified: number;
  inserted: number;
  existingVerified: number;
  empty: number;
  isolated: number;
  cacheMissing: number;
  cacheInvalid: number;
  cacheMismatch: number;
  replayRejected: number;
  ownerRejected: number;
  existingStateMismatch: number;
};

export function parseRequestedScopeIds(raw: string | undefined): string[] | null {
  if (raw === undefined) return null;
  if (raw.trim() === '') {
    throw new Error(
      'BILLING_CREDIT_BALANCE_BACKFILL_SCOPE_IDS was set but empty; refusing to fall back to a full scan',
    );
  }

  const values = raw.split(',').map((value) => value.trim());
  if (values.some((value) => value === '')) {
    throw new Error(
      'BILLING_CREDIT_BALANCE_BACKFILL_SCOPE_IDS contains an empty scope id',
    );
  }
  return [...new Set(values)].sort();
}

async function scanLegacyScopeIds(redis: Redis): Promise<Set<string>> {
  const ids = new Set<string>();
  for (const prefix of [LEGACY_QUOTA_PREFIX, LEGACY_BONUS_PREFIX]) {
    let cursor = '0';
    do {
      const [next, keys] = await redis.scan(
        cursor,
        'MATCH',
        `${prefix}*`,
        'COUNT',
        1000,
      );
      cursor = next;
      for (const key of keys) {
        const id = key.slice(prefix.length);
        if (id) ids.add(id);
      }
    } while (cursor !== '0');
  }
  return ids;
}

function isolate(
  counters: AuditCounters,
  subscriptionId: string,
  code: string,
  detail: string,
): void {
  counters.isolated += 1;
  console.warn(`[${code}] subscription=${subscriptionId} ${detail}`);
}

async function processBatch(
  prisma: PrismaClient,
  redis: Redis,
  subscriptionIds: string[],
  apply: boolean,
  maxTransactionsPerScope: number,
  counters: AuditCounters,
): Promise<void> {
  if (subscriptionIds.length === 0) return;
  counters.scanned += subscriptionIds.length;

  const [periods, entitlements, existingStates, cachedValues] = await Promise.all([
    prisma.subscriptionPeriod.findMany({
      where: { id: { in: subscriptionIds } },
      select: { id: true, userId: true },
    }),
    prisma.codingPlanEntitlement.findMany({
      where: { id: { in: subscriptionIds } },
      select: { id: true, userId: true },
    }),
    prisma.creditBalanceState.findMany({
      where: { subscriptionId: { in: subscriptionIds } },
      select: { subscriptionId: true, userId: true, quota: true, bonus: true, version: true },
    }),
    redis.mget(
      ...subscriptionIds.flatMap((id) => [
        `${LEGACY_QUOTA_PREFIX}${id}`,
        `${LEGACY_BONUS_PREFIX}${id}`,
      ]),
    ),
  ]);

  const periodOwner = new Map(periods.map((row) => [row.id, row.userId]));
  const entitlementOwner = new Map(entitlements.map((row) => [row.id, row.userId]));
  const stateByScope = new Map(existingStates.map((row) => [row.subscriptionId, row]));

  for (let index = 0; index < subscriptionIds.length; index += 1) {
    const subscriptionId = subscriptionIds[index];
    const state = stateByScope.get(subscriptionId);
    const periodUserId = periodOwner.get(subscriptionId);
    const entitlementUserId = entitlementOwner.get(subscriptionId);
    if (periodUserId && entitlementUserId) {
      counters.ownerRejected += 1;
      isolate(
        counters,
        subscriptionId,
        'SCOPE_KIND_CONFLICT',
        `periodOwner=${periodUserId} entitlementOwner=${entitlementUserId}`,
      );
      continue;
    }
    const ownerUserId = periodUserId ?? entitlementUserId;
    if (!ownerUserId) {
      counters.ownerRejected += 1;
      isolate(counters, subscriptionId, 'SCOPE_OWNER_MISSING', 'no subscription scope entity');
      continue;
    }

    const transactionCount = await prisma.creditTransaction.count({
      where: { subscriptionId },
    });
    if (transactionCount > maxTransactionsPerScope) {
      counters.replayRejected += 1;
      isolate(
        counters,
        subscriptionId,
        'HISTORY_TOO_LARGE',
        `transactions=${transactionCount} limit=${maxTransactionsPerScope}`,
      );
      continue;
    }
    const rows: LegacyCreditBalanceTransaction[] = await prisma.creditTransaction.findMany({
      where: { subscriptionId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        subscriptionId: true,
        userId: true,
        type: true,
        creditsAmount: true,
        source: true,
        quotaAfter: true,
        bonusAfter: true,
        createdAt: true,
      },
    });

    const quotaRaw = cachedValues[index * 2] ?? null;
    const bonusRaw = cachedValues[index * 2 + 1] ?? null;
    const bothCacheMissing = quotaRaw === null && bonusRaw === null;
    const quota = parseLegacyCreditBalanceCacheValue(quotaRaw);
    const bonus = parseLegacyCreditBalanceCacheValue(bonusRaw);

    if (rows.length === 0) {
      if (bothCacheMissing || (quota === 0 && bonus === 0)) {
        if (
          state
          && (state.userId !== ownerUserId || state.quota !== 0 || state.bonus !== 0)
        ) {
          counters.existingStateMismatch += 1;
          isolate(
            counters,
            subscriptionId,
            'EXISTING_STATE_MISMATCH',
            `owner=${state.userId}/${ownerUserId} state=${state.quota}/${state.bonus} expected=0/0`,
          );
        } else {
          counters.empty += 1;
        }
        continue;
      }
      counters.replayRejected += 1;
      isolate(
        counters,
        subscriptionId,
        'MISSING_OPENING_HISTORY',
        `redis=${quotaRaw ?? '<missing>'}/${bonusRaw ?? '<missing>'}`,
      );
      continue;
    }

    if (bothCacheMissing) {
      counters.cacheMissing += 1;
      isolate(counters, subscriptionId, 'CACHE_MISSING', 'legacy quota and bonus keys are absent');
      continue;
    }
    if (quota === null || bonus === null) {
      counters.cacheInvalid += 1;
      isolate(
        counters,
        subscriptionId,
        'CACHE_INVALID',
        `redis=${quotaRaw ?? '<missing>'}/${bonusRaw ?? '<missing>'}`,
      );
      continue;
    }

    const replay = replayLegacyCreditBalance(rows);
    if (!replay.ok) {
      counters.replayRejected += 1;
      isolate(
        counters,
        subscriptionId,
        `REPLAY_${replay.code}`,
        `${replay.message} tx=${replay.transactionIds.join(',')}`,
      );
      continue;
    }
    if (quota !== replay.quota || bonus !== replay.bonus) {
      counters.cacheMismatch += 1;
      isolate(
        counters,
        subscriptionId,
        'CACHE_REPLAY_MISMATCH',
        `replay=${replay.quota}/${replay.bonus} redis=${quota}/${bonus}`,
      );
      continue;
    }
    if (state) {
      if (
        state.userId !== ownerUserId
        || state.quota !== replay.quota
        || state.bonus !== replay.bonus
        || state.version < 0n
      ) {
        counters.existingStateMismatch += 1;
        isolate(
          counters,
          subscriptionId,
          'EXISTING_STATE_MISMATCH',
          `owner=${state.userId}/${ownerUserId} state=${state.quota}/${state.bonus}@${state.version.toString()} replay=${replay.quota}/${replay.bonus}`,
        );
        continue;
      }
      counters.existingVerified += 1;
      continue;
    }

    counters.verified += 1;
    if (!apply) continue;
    try {
      await prisma.creditBalanceState.create({
        data: {
          subscriptionId,
          userId: ownerUserId,
          quota: replay.quota,
          bonus: replay.bonus,
          version: 0n,
        },
      });
      counters.inserted += 1;
    } catch (err) {
      if (!(err instanceof Prisma.PrismaClientKnownRequestError) || err.code !== 'P2002') {
        throw err;
      }
      const concurrent = await prisma.creditBalanceState.findUnique({
        where: { subscriptionId },
        select: { userId: true, quota: true, bonus: true, version: true },
      });
      if (
        concurrent?.userId === ownerUserId
        && concurrent.quota === replay.quota
        && concurrent.bonus === replay.bonus
        && concurrent.version === 0n
      ) {
        counters.existingVerified += 1;
        continue;
      }
      counters.existingStateMismatch += 1;
      isolate(
        counters,
        subscriptionId,
        'CONCURRENT_STATE_MISMATCH',
        `state=${concurrent ? `${concurrent.userId}:${concurrent.quota}/${concurrent.bonus}@${concurrent.version.toString()}` : '<missing>'} replay=${ownerUserId}:${replay.quota}/${replay.bonus}@0`,
      );
    }
  }
}

export async function runCreditBalanceBackfill(
  prisma: PrismaClient,
  redis: Redis,
  options: {
    apply: boolean;
    allowFullApply: boolean;
    maxTransactionsPerScope: number;
    requestedScopeIds: string[] | null;
  },
): Promise<AuditCounters> {
  if (options.apply && options.requestedScopeIds === null && !options.allowFullApply) {
    throw new Error(
      'full APPLY requires BILLING_CREDIT_BALANCE_BACKFILL_ALLOW_FULL_APPLY=true; refusing an implicit full write',
    );
  }

  const counters: AuditCounters = {
    scanned: 0,
    verified: 0,
    inserted: 0,
    existingVerified: 0,
    empty: 0,
    isolated: 0,
    cacheMissing: 0,
    cacheInvalid: 0,
    cacheMismatch: 0,
    replayRejected: 0,
    ownerRejected: 0,
    existingStateMismatch: 0,
  };

  if (options.requestedScopeIds !== null) {
    for (let index = 0; index < options.requestedScopeIds.length; index += BATCH_SIZE) {
      await processBatch(
        prisma,
        redis,
        options.requestedScopeIds.slice(index, index + BATCH_SIZE),
        options.apply,
        options.maxTransactionsPerScope,
        counters,
      );
    }
    return counters;
  }

  const redisOnlyCandidates = await scanLegacyScopeIds(redis);
  let cursor = '';
  while (true) {
    const page = await prisma.$queryRaw<ScopeIdRow[]>`
      SELECT scope."subscriptionId"
      FROM (
        SELECT ct."subscription_id" AS "subscriptionId"
        FROM "credit_transactions" ct
        WHERE ct."subscription_id" IS NOT NULL
        UNION
        SELECT state."subscription_id" AS "subscriptionId"
        FROM "credit_balance_states" state
      ) scope
      WHERE scope."subscriptionId" > ${cursor}
      ORDER BY scope."subscriptionId" ASC
      LIMIT ${BATCH_SIZE}
    `;
    if (page.length === 0) break;
    const ids = page.map((row) => row.subscriptionId);
    await processBatch(
      prisma,
      redis,
      ids,
      options.apply,
      options.maxTransactionsPerScope,
      counters,
    );
    for (const id of ids) redisOnlyCandidates.delete(id);
    cursor = ids[ids.length - 1];
  }

  const remaining = [...redisOnlyCandidates].sort();
  for (let index = 0; index < remaining.length; index += BATCH_SIZE) {
    await processBatch(
      prisma,
      redis,
      remaining.slice(index, index + BATCH_SIZE),
      options.apply,
      options.maxTransactionsPerScope,
      counters,
    );
  }
  return counters;
}

export async function main(): Promise<void> {
  const billingDatabaseUrl = process.env.BILLING_DATABASE_URL?.trim();
  if (!billingDatabaseUrl) {
    throw new Error('BILLING_DATABASE_URL is required; refusing to use an ambiguous DATABASE_URL');
  }
  process.env.DATABASE_URL = billingDatabaseUrl;

  const apply = process.env.APPLY === 'true';
  if (apply && process.env.BILLING_CREDIT_BALANCE_BACKFILL_ASSUME_QUIESCED !== 'true') {
    throw new Error(
      'APPLY requires BILLING_CREDIT_BALANCE_BACKFILL_ASSUME_QUIESCED=true and paused credit mutations',
    );
  }

  const redisHost = process.env.REDIS_HOST?.trim();
  const redisPort = Number(process.env.REDIS_PORT);
  if (!redisHost) {
    throw new Error('REDIS_HOST is required; refusing to audit an implicit localhost Redis');
  }
  if (!Number.isInteger(redisPort) || redisPort <= 0 || redisPort > 65_535) {
    throw new Error('REDIS_PORT must be an integer between 1 and 65535');
  }
  const maxTransactionsPerScope = Number(
    process.env.BILLING_CREDIT_BALANCE_BACKFILL_MAX_TX_PER_SCOPE ?? '50000',
  );
  if (!Number.isInteger(maxTransactionsPerScope) || maxTransactionsPerScope < 1) {
    throw new Error('BILLING_CREDIT_BALANCE_BACKFILL_MAX_TX_PER_SCOPE must be a positive integer');
  }
  const requestedScopeIds = parseRequestedScopeIds(
    process.env.BILLING_CREDIT_BALANCE_BACKFILL_SCOPE_IDS,
  );

  const prisma = new PrismaClient();
  const redis = new Redis({
    host: redisHost,
    port: redisPort,
    password: process.env.REDIS_PASSWORD || undefined,
    tls: process.env.REDIS_TLS === 'true' ? {} : undefined,
    lazyConnect: true,
  });

  try {
    await redis.connect();
    const counters = await runCreditBalanceBackfill(prisma, redis, {
      apply,
      allowFullApply: process.env.BILLING_CREDIT_BALANCE_BACKFILL_ALLOW_FULL_APPLY === 'true',
      maxTransactionsPerScope,
      requestedScopeIds,
    });

    console.log(JSON.stringify({
      apply,
      mode: requestedScopeIds === null ? 'full' : 'targeted',
      requestedScopeCount: requestedScopeIds?.length ?? null,
      requestedScopeIds,
      ...counters,
    }, null, 2));
    if (counters.isolated > 0) process.exitCode = 2;
  } finally {
    await Promise.allSettled([prisma.$disconnect(), redis.quit()]);
  }
}

if (require.main === module) {
  main().catch((err) => {
    console.error(err);
    process.exitCode = 1;
  });
}
