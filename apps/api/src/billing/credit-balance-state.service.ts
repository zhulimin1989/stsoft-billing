import { Injectable, Logger } from '@nestjs/common';
import {
  CreditBalanceOutbox,
  CreditBalanceOutboxStatus,
  Prisma,
} from '@prisma/client';
import { randomUUID } from 'node:crypto';
import {
  creditBalanceCacheApplyTotal,
  creditBalanceOutboxTotal,
} from '../metrics/metrics.registry';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

const APPLY_BALANCE_CACHE_IF_NEWER_LUA = `
local current = redis.call('HMGET', KEYS[1], 'version', 'quota', 'bonus')
local incoming_quota = tonumber(ARGV[2])
local incoming_bonus = tonumber(ARGV[3])

if (current[1] == false or current[1] == nil)
  and (current[2] == false or current[2] == nil)
  and (current[3] == false or current[3] == nil) then
  redis.call('HSET', KEYS[1],
    'version', ARGV[1],
    'quota', ARGV[2],
    'bonus', ARGV[3])
  return {1, ARGV[1], ARGV[2], ARGV[3]}
end

if current[1] == false or current[1] == nil
  or current[2] == false or current[2] == nil
  or current[3] == false or current[3] == nil then
  return {-3, current[1] or '', current[2] or '', current[3] or ''}
end

local function compare_decimal(left, right)
  left = string.gsub(left, '^0+', '')
  right = string.gsub(right, '^0+', '')
  if left == '' then left = '0' end
  if right == '' then right = '0' end
  if string.len(left) < string.len(right) then return -1 end
  if string.len(left) > string.len(right) then return 1 end
  if left < right then return -1 end
  if left > right then return 1 end
  return 0
end

local current_quota = tonumber(current[2])
local current_bonus = tonumber(current[3])

-- quota 允许为负（R6 终态负额结算），bonus/version 仍恒非负。
if string.match(current[1], '^%d+$') == nil
  or string.match(current[2], '^%-?%d+$') == nil
  or string.match(current[3], '^%d+$') == nil
  or current_quota == nil
  or current_bonus == nil
  or current_quota > 2147483647
  or current_quota < -2147483648
  or current_bonus > 2147483647 then
  return {-3, current[1] or '', current[2] or '', current[3] or ''}
end

local version_order = compare_decimal(ARGV[1], current[1])
if version_order > 0 then
  redis.call('HSET', KEYS[1],
    'version', ARGV[1],
    'quota', ARGV[2],
    'bonus', ARGV[3])
  return {1, ARGV[1], ARGV[2], ARGV[3]}
end

if version_order < 0 then
  return {-1, current[1], current[2], current[3]}
end

if incoming_quota ~= current_quota or incoming_bonus ~= current_bonus then
  return {-2, current[1], current[2], current[3]}
end

return {0, current[1], current[2], current[3]}
`;

const OUTBOX_LOCK_STALE_MS = 60_000;
const POSTGRES_INT_MAX = 2_147_483_647;
const POSTGRES_INT_MIN = -2_147_483_648;

export type CreditBalanceSnapshot = {
  subscriptionId: string;
  userId: string;
  quota: number;
  bonus: number;
  version: bigint;
};

type CacheApplyResult = {
  outcome: 'applied' | 'equal' | 'stale' | 'conflict' | 'corrupt';
  snapshot: CreditBalanceSnapshot;
};

type MutationPlan = {
  quota: number;
  bonus: number;
};

type MutationResult<T> = {
  changed: boolean;
  snapshot: CreditBalanceSnapshot;
  value?: T;
};

export function creditBalanceCacheKey(subscriptionId: string): string {
  if (!subscriptionId) throw new Error('creditBalanceCacheKey requires subscriptionId');
  return `credits:v2:{${subscriptionId}}`;
}

@Injectable()
export class CreditBalanceStateService {
  private readonly logger = new Logger(CreditBalanceStateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async get(subscriptionId: string, userId: string): Promise<CreditBalanceSnapshot> {
    if (!subscriptionId) {
      throw new Error('CreditBalanceStateService.get requires subscriptionId');
    }

    try {
      const cached = await this.readCache(subscriptionId, userId);
      if (cached) return cached;
    } catch (err) {
      this.logger.warn(
        `credit balance cache read failed subscription=${subscriptionId}: ${this.errorMessage(err)}`,
      );
    }

    const state = await this.prisma.$transaction(
      (tx) => this.loadOrCreateLockedState(tx, subscriptionId, userId),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );

    try {
      const applied = await this.applyCacheIfNewer(state);
      if (applied.outcome === 'conflict' || applied.outcome === 'corrupt') {
        throw new Error(
          `credit balance cache invariant violation subscription=${subscriptionId} outcome=${applied.outcome}`,
        );
      }
      return applied.snapshot;
    } catch (err) {
      this.logger.warn(
        `credit balance cache backfill failed subscription=${subscriptionId}: ${this.errorMessage(err)}`,
      );
      return state;
    }
  }

  /**
   * 资金/权益决策必须直接读取 PostgreSQL 权威状态。Redis 投影允许短暂落后，
   * 因而只能用于展示类 eventual read，不能用于抵扣定价或请求授权。
   */
  async getAuthoritative(
    subscriptionId: string,
    actorUserId: string,
  ): Promise<CreditBalanceSnapshot> {
    if (!subscriptionId) {
      throw new Error('CreditBalanceStateService.getAuthoritative requires subscriptionId');
    }
    const state = await this.prisma.$transaction(
      (tx) => this.loadOrCreateLockedState(tx, subscriptionId, actorUserId),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );

    try {
      const applied = await this.applyCacheIfNewer(state);
      if (applied.outcome === 'stale' || applied.outcome === 'conflict' || applied.outcome === 'corrupt') {
        this.logger.error(
          `credit balance authoritative read found invalid cache subscription=${subscriptionId} dbVersion=${state.version.toString()} cacheVersion=${applied.snapshot.version.toString()} outcome=${applied.outcome}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `credit balance authoritative cache projection failed subscription=${subscriptionId}: ${this.errorMessage(err)}`,
      );
    }
    return state;
  }

  /**
   * Ensure the authoritative balance row inside an existing financial
   * transaction. This deliberately does not open a nested root transaction or
   * publish Redis: callers use it as a foreign-key/identity precondition before
   * writing another immutable ledger row in the same commit.
   */
  async ensureLockedState(
    tx: Prisma.TransactionClient,
    subscriptionId: string,
    actorUserId: string,
  ): Promise<CreditBalanceSnapshot> {
    if (!subscriptionId) {
      throw new Error('CreditBalanceStateService.ensureLockedState requires subscriptionId');
    }
    const state = await this.loadOrCreateLockedState(tx, subscriptionId, actorUserId);
    const scopeOwnerUserId = await this.resolveScopeOwner(
      tx,
      subscriptionId,
      actorUserId,
    );
    // actorUserId may be a tenant member. Ownership is therefore compared to
    // the frozen subscription/entitlement scope, never to the request actor.
    if (state.userId !== scopeOwnerUserId) {
      throw new Error(
        `credit balance state owner mismatch subscription=${subscriptionId} stateOwner=${state.userId} scopeOwner=${scopeOwnerUserId}`,
      );
    }
    return state;
  }

  async mutate<T>(
    subscriptionId: string,
    userId: string,
    calculate: (current: CreditBalanceSnapshot) => MutationPlan | null,
    persist: (
      tx: Prisma.TransactionClient,
      current: CreditBalanceSnapshot,
      next: CreditBalanceSnapshot,
    ) => Promise<T>,
  ): Promise<MutationResult<T>> {
    if (!subscriptionId) {
      throw new Error('CreditBalanceStateService.mutate requires subscriptionId');
    }

    const result = await this.prisma.$transaction(async (tx) => {
      const current = await this.loadOrCreateLockedState(tx, subscriptionId, userId);
      const plan = calculate(current);
      if (!plan) {
        return { changed: false, snapshot: current } satisfies MutationResult<T>;
      }
      this.assertBalances(plan.quota, plan.bonus);

      const next: CreditBalanceSnapshot = {
        subscriptionId,
        // state.userId 是余额作用域 owner；调用参数 userId 是本次交易 actor。
        // 租户共享订阅允许二者不同，不能在 mutation 时转移 owner。
        userId: current.userId,
        quota: plan.quota,
        bonus: plan.bonus,
        version: current.version + 1n,
      };

      const updated = await tx.creditBalanceState.updateMany({
        where: {
          subscriptionId,
          userId: current.userId,
          version: current.version,
        },
        data: {
          quota: next.quota,
          bonus: next.bonus,
          version: next.version,
        },
      });
      if (updated.count !== 1) {
        throw new Error(
          `credit balance optimistic update failed subscription=${subscriptionId} version=${current.version.toString()}`,
        );
      }

      const value = await persist(tx, current, next);
      const outbox = await tx.creditBalanceOutbox.create({
        data: {
          subscriptionId,
          version: next.version,
          quota: next.quota,
          bonus: next.bonus,
        },
      });

      return {
        changed: true,
        snapshot: next,
        value,
        outbox,
      };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });

    if ('outbox' in result && result.outbox) {
      await this.deliverOutbox(result.outbox);
    }
    return result;
  }

  async withLockedCurrent<T>(
    subscriptionId: string,
    userId: string,
    persist: (
      tx: Prisma.TransactionClient,
      current: CreditBalanceSnapshot,
    ) => Promise<T>,
  ): Promise<{ snapshot: CreditBalanceSnapshot; value: T }> {
    return this.prisma.$transaction(async (tx) => {
      const current = await this.loadOrCreateLockedState(tx, subscriptionId, userId);
      const value = await persist(tx, current);
      return { snapshot: current, value };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted });
  }

  async reconcile(
    subscriptionId: string,
    userId: string,
    opts: { fix?: boolean } = {},
  ): Promise<{
    expected: CreditBalanceSnapshot;
    cached: CreditBalanceSnapshot | null;
    mismatched: boolean;
    fixed: boolean;
  }> {
    const expected = await this.prisma.$transaction(
      (tx) => this.loadOrCreateLockedState(tx, subscriptionId, userId),
      { isolationLevel: Prisma.TransactionIsolationLevel.ReadCommitted },
    );
    let cached: CreditBalanceSnapshot | null = null;
    try {
      cached = await this.readCache(subscriptionId, userId);
    } catch (err) {
      this.logger.warn(
        `credit balance reconcile cache read failed subscription=${subscriptionId}: ${this.errorMessage(err)}`,
      );
    }
    const mismatched = !cached
      || cached.version !== expected.version
      || cached.quota !== expected.quota
      || cached.bonus !== expected.bonus;
    if (!mismatched || opts.fix === false) {
      return { expected, cached, mismatched, fixed: false };
    }

    try {
      const applied = await this.applyCacheIfNewer(expected);
      const fixed = applied.outcome === 'applied' || applied.outcome === 'equal';
      return { expected, cached, mismatched, fixed };
    } catch (err) {
      this.logger.error(
        `credit balance reconcile failed subscription=${subscriptionId}: ${this.errorMessage(err)}`,
      );
      return { expected, cached, mismatched, fixed: false };
    }
  }

  async flushOutbox(limit = 100, workerId: string = randomUUID()): Promise<{
    scanned: number;
    delivered: number;
    failed: number;
  }> {
    const queryNow = new Date();
    const queryStaleBefore = new Date(queryNow.getTime() - OUTBOX_LOCK_STALE_MS);
    const rows = await this.prisma.creditBalanceOutbox.findMany({
      where: {
        OR: [
          {
            status: { in: ['PENDING', 'FAILED'] },
            nextRunAt: { lte: queryNow },
          },
          {
            status: 'RUNNING',
            lockedAt: { lt: queryStaleBefore },
          },
        ],
      },
      orderBy: [{ nextRunAt: 'asc' }, { createdAt: 'asc' }],
      take: Math.max(1, limit),
    });

    let delivered = 0;
    let failed = 0;
    for (const row of rows) {
      const claimedAt = new Date();
      const staleBefore = new Date(claimedAt.getTime() - OUTBOX_LOCK_STALE_MS);
      const claimed = await this.prisma.creditBalanceOutbox.updateMany({
        where: {
          id: row.id,
          OR: [
            {
              status: { in: ['PENDING', 'FAILED'] },
              nextRunAt: { lte: claimedAt },
            },
            {
              status: 'RUNNING',
              lockedAt: { lt: staleBefore },
            },
          ],
        },
        data: {
          status: 'RUNNING',
          lockedAt: claimedAt,
          lockedBy: workerId,
          attempts: { increment: 1 },
        },
      });
      if (claimed.count !== 1) continue;

      const ok = await this.deliverClaimedOutbox({
        ...row,
        status: 'RUNNING',
        lockedAt: claimedAt,
        lockedBy: workerId,
        attempts: row.attempts + 1,
      });
      if (ok) delivered += 1;
      else failed += 1;
    }

    return { scanned: rows.length, delivered, failed };
  }

  private async loadOrCreateLockedState(
    tx: Prisma.TransactionClient,
    subscriptionId: string,
    actorUserId: string,
  ): Promise<CreditBalanceSnapshot> {
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`credit:balance:${subscriptionId}`}))`;

    let state = await tx.creditBalanceState.findUnique({
      where: { subscriptionId },
    });
    if (!state) {
      // 这里只判断是否存在任何 legacy 历史。即使只残留孤立 QUOTA_RESET，
      // 也必须由 backfill 隔离，不能把它误当成全新作用域并初始化为 0。
      const latest = await tx.creditTransaction.findFirst({
        where: { subscriptionId },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
      if (latest) {
        throw new Error(
          `credit balance state missing for legacy subscription=${subscriptionId}; run the verified balance-state backfill before enabling V2`,
        );
      }
      const [legacyQuotaRaw, legacyBonusRaw] = await this.redis.mget(
        `credits:quota:${subscriptionId}`,
        `credits:bonus:${subscriptionId}`,
      );
      if (legacyQuotaRaw !== null || legacyBonusRaw !== null) {
        let verifiedEmpty = false;
        try {
          verifiedEmpty = legacyQuotaRaw !== null
            && legacyBonusRaw !== null
            && this.parseCacheInteger(legacyQuotaRaw, 'legacy_quota') === 0
            && this.parseCacheInteger(legacyBonusRaw, 'legacy_bonus') === 0;
        } catch {
          verifiedEmpty = false;
        }
        if (!verifiedEmpty) {
          throw new Error(
            `credit balance state missing for legacy Redis scope subscription=${subscriptionId}; run the verified balance-state backfill before enabling V2`,
          );
        }
      }
      const ownerUserId = await this.resolveScopeOwner(tx, subscriptionId, actorUserId);
      state = await tx.creditBalanceState.create({
        data: {
          subscriptionId,
          userId: ownerUserId,
          quota: 0,
          bonus: 0,
          version: 0n,
        },
      });
    }
    this.assertBalances(state.quota, state.bonus);
    return {
      subscriptionId: state.subscriptionId,
      userId: state.userId,
      quota: state.quota,
      bonus: state.bonus,
      version: state.version,
    };
  }

  private async resolveScopeOwner(
    tx: Prisma.TransactionClient,
    subscriptionId: string,
    actorUserId: string,
  ): Promise<string> {
    const [period, entitlement] = await Promise.all([
      tx.subscriptionPeriod.findUnique({
        where: { id: subscriptionId },
        select: { userId: true },
      }),
      tx.codingPlanEntitlement.findUnique({
        where: { id: subscriptionId },
        select: { userId: true },
      }),
    ]);
    if (period && entitlement) {
      throw new Error(
        `credit balance scope kind conflict subscription=${subscriptionId} periodOwner=${period.userId} entitlementOwner=${entitlement.userId}`,
      );
    }
    const ownerUserId = period?.userId ?? entitlement?.userId;
    if (!ownerUserId) {
      throw new Error(
        `credit balance scope not found subscription=${subscriptionId} actor=${actorUserId}`,
      );
    }
    return ownerUserId;
  }

  private async readCache(
    subscriptionId: string,
    userId: string,
  ): Promise<CreditBalanceSnapshot | null> {
    const [versionRaw, quotaRaw, bonusRaw] = await this.redis.hmget(
      creditBalanceCacheKey(subscriptionId),
      'version',
      'quota',
      'bonus',
    );
    if (versionRaw === null && quotaRaw === null && bonusRaw === null) return null;
    if (versionRaw === null || quotaRaw === null || bonusRaw === null) {
      throw new Error(`partial credit balance cache subscription=${subscriptionId}`);
    }
    const snapshot = {
      subscriptionId,
      userId,
      version: this.parseCacheVersion(versionRaw),
      quota: this.parseCacheInteger(quotaRaw, 'quota'),
      bonus: this.parseCacheInteger(bonusRaw, 'bonus'),
    };
    this.assertBalances(snapshot.quota, snapshot.bonus);
    if (snapshot.version < 0n) {
      throw new Error(`negative credit balance cache version subscription=${subscriptionId}`);
    }
    return snapshot;
  }

  private async applyCacheIfNewer(
    incoming: CreditBalanceSnapshot,
  ): Promise<CacheApplyResult> {
    const raw = await this.redis.eval(
      APPLY_BALANCE_CACHE_IF_NEWER_LUA,
      1,
      creditBalanceCacheKey(incoming.subscriptionId),
      incoming.version.toString(),
      incoming.quota.toString(),
      incoming.bonus.toString(),
    );
    if (!Array.isArray(raw) || raw.length < 4) {
      throw new Error(`invalid credit balance cache CAS response: ${String(raw)}`);
    }
    const code = Number(raw[0]);
    const outcome = code === 1
      ? 'applied'
      : code === 0
        ? 'equal'
        : code === -1
          ? 'stale'
          : code === -2
            ? 'conflict'
            : 'corrupt';
    creditBalanceCacheApplyTotal.labels(outcome).inc();

    if (outcome === 'corrupt') {
      this.logger.error(
        `CREDIT BALANCE CACHE INVARIANT VIOLATION subscription=${incoming.subscriptionId} incomingVersion=${incoming.version.toString()} cached=${raw.slice(1, 4).map(String).join('/')} outcome=corrupt`,
      );
      return { outcome, snapshot: incoming };
    }

    let snapshot: CreditBalanceSnapshot;
    try {
      snapshot = {
        subscriptionId: incoming.subscriptionId,
        userId: incoming.userId,
        version: this.parseCacheVersion(String(raw[1])),
        quota: this.parseCacheInteger(String(raw[2]), 'quota'),
        bonus: this.parseCacheInteger(String(raw[3]), 'bonus'),
      };
      this.assertBalances(snapshot.quota, snapshot.bonus);
      if (snapshot.version < 0n) {
        throw new Error('negative credit balance cache version');
      }
    } catch (err) {
      throw new Error(`invalid credit balance cache snapshot: ${this.errorMessage(err)}`);
    }

    if (outcome === 'conflict') {
      this.logger.error(
        `CREDIT BALANCE CACHE INVARIANT VIOLATION subscription=${incoming.subscriptionId} incomingVersion=${incoming.version.toString()} cachedVersion=${snapshot.version.toString()} outcome=${outcome}`,
      );
    }
    return { outcome, snapshot };
  }

  private async deliverOutbox(row: CreditBalanceOutbox): Promise<void> {
    try {
      const claimToken = `inline:${randomUUID()}`;
      const claimedAt = new Date();
      const claimed = await this.prisma.creditBalanceOutbox.updateMany({
        where: {
          id: row.id,
          status: { in: ['PENDING', 'FAILED'] },
        },
        data: {
          status: 'RUNNING',
          lockedAt: claimedAt,
          lockedBy: claimToken,
          attempts: { increment: 1 },
        },
      });
      if (claimed.count !== 1) return;
      await this.deliverClaimedOutbox({
        ...row,
        status: 'RUNNING',
        attempts: row.attempts + 1,
        lockedAt: claimedAt,
        lockedBy: claimToken,
      });
    } catch (err) {
      this.logger.warn(
        `credit balance inline outbox delivery failed id=${row.id}: ${this.errorMessage(err)}`,
      );
    }
  }

  private async deliverClaimedOutbox(row: CreditBalanceOutbox): Promise<boolean> {
    const snapshot: CreditBalanceSnapshot = {
      subscriptionId: row.subscriptionId,
      userId: '',
      quota: row.quota,
      bonus: row.bonus,
      version: row.version,
    };
    try {
      const result = await this.applyCacheIfNewer(snapshot);
      if (result.outcome === 'conflict' || result.outcome === 'corrupt') {
        await this.finishOutbox(row, 'MANUAL_REVIEW', `cache_${result.outcome}`);
        creditBalanceOutboxTotal.labels('manual_review').inc();
        return false;
      }
      if (result.outcome === 'stale') {
        const authoritative = await this.prisma.creditBalanceState.findUnique({
          where: { subscriptionId: row.subscriptionId },
          select: { version: true, quota: true, bonus: true },
        });
        const cacheAheadOfDatabase = !authoritative
          || authoritative.version < result.snapshot.version
          || (
            authoritative.version === result.snapshot.version
            && (
              authoritative.quota !== result.snapshot.quota
              || authoritative.bonus !== result.snapshot.bonus
            )
          );
        if (cacheAheadOfDatabase) {
          await this.finishOutbox(
            row,
            'MANUAL_REVIEW',
            `cache_ahead_of_database cached=${result.snapshot.version.toString()}:${result.snapshot.quota}/${result.snapshot.bonus} db=${authoritative ? `${authoritative.version.toString()}:${authoritative.quota}/${authoritative.bonus}` : '<missing>'}`,
          );
          creditBalanceOutboxTotal.labels('manual_review').inc();
          return false;
        }
      }
      const deleted = await this.prisma.creditBalanceOutbox.deleteMany({
        where: {
          id: row.id,
          status: 'RUNNING',
          lockedBy: row.lockedBy,
        },
      });
      if (deleted.count !== 1) {
        throw new Error(`credit balance outbox completion fence lost id=${row.id}`);
      }
      creditBalanceOutboxTotal.labels('succeeded').inc();
      return true;
    } catch (err) {
      if (row.attempts === row.maxAttempts) {
        this.logger.error(
          `credit balance outbox reached alert threshold id=${row.id} subscription=${row.subscriptionId} attempts=${row.attempts}; retries will continue`,
        );
      }
      await this.finishOutbox(
        row,
        'FAILED',
        this.errorMessage(err),
      );
      creditBalanceOutboxTotal.labels('failed').inc();
      return false;
    }
  }

  private async finishOutbox(
    row: CreditBalanceOutbox,
    status: CreditBalanceOutboxStatus,
    error?: string,
  ): Promise<void> {
    const now = new Date();
    const retryDelayMs = Math.min(60_000, 250 * 2 ** Math.min(row.attempts, 8));
    await this.prisma.creditBalanceOutbox.updateMany({
      where: {
        id: row.id,
        status: 'RUNNING',
        lockedBy: row.lockedBy,
      },
      data: {
        status,
        processedAt: status === 'SUCCEEDED' ? now : null,
        nextRunAt: status === 'FAILED' ? new Date(now.getTime() + retryDelayMs) : now,
        lockedAt: null,
        lockedBy: null,
        lastError: error?.slice(0, 2000) ?? null,
      },
    });
  }

  // quota 允许为负（R6 终态负额结算，欠额落 quota 池）；bonus 恒非负。
  private assertBalances(quota: number, bonus: number): void {
    if (
      !Number.isSafeInteger(quota)
      || !Number.isSafeInteger(bonus)
      || quota < POSTGRES_INT_MIN
      || bonus < 0
      || quota > POSTGRES_INT_MAX
      || bonus > POSTGRES_INT_MAX
    ) {
      throw new Error(`invalid credit balance quota=${quota} bonus=${bonus}`);
    }
  }

  // 解析放宽为可选负号（quota 位可能为负）；bonus 的非负策略由 assertBalances + DB CHECK 兜底。
  private parseCacheInteger(value: string, field: string): number {
    if (!/^-?\d+$/.test(value)) {
      throw new Error(`invalid credit balance cache ${field}=${value}`);
    }
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed)) {
      throw new Error(`invalid credit balance cache ${field}=${value}`);
    }
    return parsed;
  }

  private parseCacheVersion(value: string): bigint {
    if (!/^\d+$/.test(value)) {
      throw new Error(`invalid credit balance cache version=${value}`);
    }
    return BigInt(value);
  }

  private errorMessage(err: unknown): string {
    return err instanceof Error ? err.message : String(err);
  }
}
