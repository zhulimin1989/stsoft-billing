import { Injectable, Logger, Optional } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { CreditTransaction, CreditTxType, PaginatedResult } from '@ruidong/shared';
import { CreditTransaction as PrismaCreditTransaction, Prisma } from '@prisma/client';
import {
  creditDeductTotal,
  creditNegativeDeductTotal,
  creditNegativeDeductDebtCredits,
  creditReconcileMismatchTotal,
  grantCompensateTotal,
} from '../metrics/metrics.registry';
import { UsageThresholdService } from '../alert-events/usage-threshold.service';
import { hasPrismaErrorCode } from '../common/utils/prisma-error.util';
import { PublisherSyncService } from '../publisher/publisher-sync.service';
import { CreditBalanceStateService } from './credit-balance-state.service';

/**
 * PR0-1 review fix: GRANT 池原子扣减。原实现 GET→DECRBY→负值检测→INCRBY 回滚
 * 有窗口期,并发扣款会少扣 / 漏扣。Lua 内部一次性完成"读取→裁剪→DECRBY",
 * 所以单纯的"返回多少"取决于池里实际有多少:
 *   KEYS[1] = grantKey(userId)
 *   ARGV[1] = 想扣的 amount (int, > 0)
 * 返回:实际扣了多少(int, 0 表示池为空 / 余额非正)。
 */
const DEDUCT_GRANT_POOL_LUA = `
local cur = tonumber(redis.call('GET', KEYS[1]) or '0')
if cur <= 0 then return 0 end
local want = tonumber(ARGV[1])
local take = cur
if want < cur then take = want end
redis.call('DECRBY', KEYS[1], take)
return take
`;

export const CREDIT_DEDUCT_INTENT_SCOPE = 'credit:deduct:intent';
const CREDIT_DEDUCT_INTENT_TTL_MS = 7 * 24 * 60 * 60 * 1000;

type CreditDeductIntentPayload = Record<string, string | number | boolean | null>;
type CreditDeductIntent = {
  key: string;
  payload: CreditDeductIntentPayload;
};

export type CreditDeductTransactionSnapshot = {
  quotaAfter: number;
  bonusAfter: number;
  grantAfter: number;
  fromGrant: number;
};

type CreditDeductOptions = {
  idempotencyKey?: string;
  beforeCreditTransaction?: (
    tx: Prisma.TransactionClient,
  ) => Promise<void>;
  afterCreditTransaction?: (
    tx: Prisma.TransactionClient,
    snapshot: CreditDeductTransactionSnapshot,
  ) => Promise<void>;
  // R6 终态负额结算：仅由服务端可信上下文（deductInternal trusted && env && 自营开关）透传。
  // true 时，已交付的末笔在 quota+bonus 不足以覆盖成本时跨零结算——扣尽两池、欠额落 quota 池为负；
  // 仍需 quota+bonus>0 作第二道闸（至多一笔跨负）。默认 false = 逐字节等价现状（不足即拒绝）。
  allowNegativeBalance?: boolean;
};

export type CreditGrantReversalInput = {
  subscriptionId: string;
  userId: string;
  credits: number;
  bucket: 'QUOTA' | 'BONUS';
  source: string;
  originalGrantIdempotencyKey: string;
  reversalIdempotencyKey: string;
};

type IdempotencyIntentDelegate = {
  create?: (args: {
    data: {
      key: string;
      scope: string;
      userId?: string;
      result: Prisma.InputJsonValue;
      status: string;
      expiresAt: Date;
    };
  }) => Promise<unknown>;
  update?: (args: {
    where: Prisma.IdempotencyKeyWhereUniqueInput;
    data: { status: string; result: Prisma.InputJsonValue };
  }) => Promise<unknown>;
};

@Injectable()
export class CreditService {
  private readonly logger = new Logger(CreditService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly balanceState: CreditBalanceStateService,
    // P2-A3 §8.1: deduct 成功后异步检查用量阈值。@Optional 是为了:
    //  - 既有大量 unit test(credit.service.spec.ts)直接 wire 此 service 不带 alert
    //    依赖,保留 Optional 让单测无需改造
    //  - 生产环境通过 BillingModule import AlertEventsModule 注入,见 billing.module.ts
    @Optional()
    private readonly usageThreshold?: UsageThresholdService,
    @Optional()
    private readonly publisherSync?: PublisherSyncService,
  ) {}

  async ensureBalanceStateForGatewayAnchor(
    tx: Prisma.TransactionClient,
    subscriptionId: string,
    actorUserId: string,
  ) {
    return this.balanceState.ensureLockedState(tx, subscriptionId, actorUserId);
  }

  private deductIntentWhere(key: string): Prisma.IdempotencyKeyWhereUniqueInput {
    return { key_scope: { key, scope: CREDIT_DEDUCT_INTENT_SCOPE } };
  }

  /**
   * PR0-1: GRANT 池 key。区别于 quota / bonus(以 subscriptionId 为粒度),
   * grant 池**永远以 userId 为粒度** —— 定时奖励规则面向用户而非订阅。
   */
  private grantKey(userId: string): string {
    if (!userId) throw new Error('grantKey requires non-empty userId');
    return `credit:user:${userId}:grant`;
  }

  /**
   * 构建 PG 查询条件。调用方需确保 subscriptionId 非空。
   */
  private txWhereClause(subscriptionId: string, userId: string) {
    return subscriptionId
      ? { subscriptionId }
      : { userId };
  }

  private async subscriptionContext(
    subscriptionId: string,
  ): Promise<{ tenantId?: string; productId?: string }> {
    if (!subscriptionId) return {};
    const delegates = (this.prisma as unknown as {
      subscriptionPeriod?: {
        findUnique?: (args: {
          where: { id: string };
          select: { tenantId: true; productId: true };
        }) => Promise<{ tenantId: string | null; productId: string | null } | null>;
      };
      codingPlanEntitlement?: {
        findUnique?: (args: {
          where: { id: string };
          select: { tenantId: true; productId: true };
        }) => Promise<{ tenantId: string | null; productId: string | null } | null>;
      };
    });
    const period = delegates.subscriptionPeriod?.findUnique
      ? await delegates.subscriptionPeriod.findUnique({
          where: { id: subscriptionId },
          select: { tenantId: true, productId: true },
        })
      : null;
    const entitlement = !period && delegates.codingPlanEntitlement?.findUnique
      ? await delegates.codingPlanEntitlement.findUnique({
          where: { id: subscriptionId },
          select: { tenantId: true, productId: true },
        })
      : null;
    const context = period ?? entitlement;
    return {
      ...(context?.tenantId ? { tenantId: context.tenantId } : {}),
      ...(context?.productId ? { productId: context.productId } : {}),
    };
  }

  private monthStart(): Date {
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);
    return monthStart;
  }

  async getBillingCycleStart(subscriptionId: string, userId: string): Promise<Date | null> {
    if (!subscriptionId) return null;

    const latestQuotaGrant = await this.prisma.creditTransaction.findFirst({
      where: {
        ...this.txWhereClause(subscriptionId, userId),
        type: 'QUOTA_GRANT',
      },
      orderBy: { createdAt: 'desc' },
      select: { createdAt: true },
    });

    return latestQuotaGrant?.createdAt ?? null;
  }

  private async consumedSince(
    subscriptionId: string,
    userId: string,
    since: Date,
  ): Promise<number> {
    const consumed = await this.prisma.creditTransaction.aggregate({
      where: {
        ...this.txWhereClause(subscriptionId, userId),
        type: 'CONSUME',
        createdAt: { gte: since },
      },
      _sum: { creditsAmount: true },
    });
    return Math.abs(consumed._sum.creditsAmount ?? 0);
  }

  /**
   * 滚动窗口用量聚合（quota-v2 §4.2，订阅级共享池口径，不带 userId）：
   * - CREDITS：SUM(|creditsAmount|) of CONSUME since（= 积分消耗量）；
   * - REQUESTS：COUNT(*) of CONSUME since（每次 deduct 落一条 CONSUME 流水 = 一次计费请求）。
   * 复合索引 @@index([subscriptionId, type, createdAt]) 支撑 SUM/COUNT 热路径。
   */
  async windowUsage(
    subscriptionId: string,
    metric: 'REQUESTS' | 'CREDITS',
    since: Date,
  ): Promise<number> {
    if (!subscriptionId) return 0;
    const where = {
      subscriptionId,
      type: 'CONSUME' as const,
      createdAt: { gte: since },
    };
    if (metric === 'CREDITS') {
      const agg = await this.prisma.creditTransaction.aggregate({
        where,
        _sum: { creditsAmount: true },
      });
      return Math.abs(agg._sum.creditsAmount ?? 0);
    }
    return this.prisma.creditTransaction.count({ where });
  }

  private schedulePublisherKeyBalanceSync(userId: string, tenantId?: string | null): void {
    if (!this.publisherSync || !userId) return;
    const sync = tenantId
      ? this.publisherSync.syncTenantKeyBalances(tenantId)
      : this.publisherSync.syncUserKeyBalances(userId);
    sync.catch((err) => {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.warn(
        `publisher key-balance sync failed user=${userId} tenant=${tenantId ?? ''}: ${msg}`,
      );
    });
  }

  private async schedulePublisherKeyBalanceSyncForTransaction(tx?: {
    subscriptionId?: string | null;
    userId?: string | null;
  } | null): Promise<void> {
    if (!this.publisherSync) return;
    if (!tx?.userId) return;
    const context = tx.subscriptionId
      ? await this.subscriptionContext(tx.subscriptionId)
      : {};
    this.schedulePublisherKeyBalanceSync(tx.userId, context.tenantId);
  }

  private assertReplayMatches(
    tx: {
      subscriptionId?: string | null;
      userId?: string | null;
      type?: string | null;
      creditsAmount?: number | null;
      source?: string | null;
    },
    expected: {
      subscriptionId: string;
      userId: string;
      type: string;
      creditsAmount: number;
      source: string;
    },
  ): void {
    if (
      tx.subscriptionId !== expected.subscriptionId
      || tx.userId !== expected.userId
      || tx.type !== expected.type
      || tx.creditsAmount !== expected.creditsAmount
      || tx.source !== expected.source
    ) {
      throw new Error(
        `credit idempotency key collision expected=${expected.type}:${expected.subscriptionId}:${expected.userId}:${expected.creditsAmount}:${expected.source} actual=${tx.type ?? ''}:${tx.subscriptionId ?? ''}:${tx.userId ?? ''}:${tx.creditsAmount ?? ''}:${tx.source ?? ''}`,
      );
    }
  }

  private idempotencyIntentDelegate(): IdempotencyIntentDelegate | undefined {
    return (this.prisma as unknown as { idempotencyKey?: IdempotencyIntentDelegate })
      .idempotencyKey;
  }

  private async createDeductIntent(input: {
    subscriptionId: string;
    userId: string;
    amount: number;
    source: string;
    modelName?: string;
    requestId?: string;
  }): Promise<CreditDeductIntent | null> {
    const delegate = this.idempotencyIntentDelegate();
    if (!delegate?.create) return null;

    const now = new Date();
    const intent: CreditDeductIntent = {
      key: `${CREDIT_DEDUCT_INTENT_SCOPE}:${randomUUID()}`,
      payload: {
        kind: 'credit_deduct',
        status: 'PENDING',
        subscriptionId: input.subscriptionId,
        userId: input.userId,
        amount: input.amount,
        source: input.source,
        modelName: input.modelName ?? null,
        requestId: input.requestId ?? null,
        createdAt: now.toISOString(),
      },
    };
    await delegate.create({
      data: {
        key: intent.key,
        scope: CREDIT_DEDUCT_INTENT_SCOPE,
        userId: input.userId,
        status: 'PENDING',
        result: intent.payload as Prisma.InputJsonObject,
        expiresAt: new Date(now.getTime() + CREDIT_DEDUCT_INTENT_TTL_MS),
      },
    });
    return intent;
  }

  private async markDeductIntent(
    intent: CreditDeductIntent | null,
    status: 'REDIS_DEBITED' | 'COMMITTED' | 'FAILED' | 'RECONCILE_REQUIRED',
    patch: CreditDeductIntentPayload = {},
  ): Promise<void> {
    if (!intent) return;
    const delegate = this.idempotencyIntentDelegate();
    if (!delegate?.update) return;

    intent.payload = {
      ...intent.payload,
      ...patch,
      status,
      updatedAt: new Date().toISOString(),
    };

    try {
      await delegate.update({
        where: this.deductIntentWhere(intent.key),
        data: {
          status,
          result: intent.payload as Prisma.InputJsonObject,
        },
      });
    } catch (err) {
      this.logger.warn(
        `credit deduct intent update failed key=${intent.key} status=${status}: ${(err as Error).message}`,
      );
    }
  }

  private parseCachedInt(value: string | null | undefined): number | null {
    if (value === null || value === undefined || value === '') return null;
    const parsed = parseInt(String(value), 10);
    return Number.isFinite(parsed) ? parsed : null;
  }

  async reconcileSubscriptionCache(
    subscriptionId: string,
    userId: string,
    opts: { fix?: boolean } = {},
  ): Promise<{
    subscriptionId: string;
    userId: string;
    expected: { quota: number; bonus: number };
    redis: { quota: number | null; bonus: number | null };
    mismatched: boolean;
    fixed: boolean;
  }> {
    if (!subscriptionId) {
      throw new Error('reconcileSubscriptionCache requires a valid subscriptionId');
    }
    const result = await this.balanceState.reconcile(subscriptionId, userId, opts);
    const expected = {
      quota: result.expected.quota,
      bonus: result.expected.bonus,
    };
    const redis = {
      quota: result.cached?.quota ?? null,
      bonus: result.cached?.bonus ?? null,
    };
    if (result.mismatched) {
      creditReconcileMismatchTotal.labels('quota_bonus').inc();
    }
    return {
      subscriptionId,
      userId,
      expected,
      redis,
      mismatched: result.mismatched,
      fixed: result.fixed,
    };
  }

  async reconcileGrantPool(
    userId: string,
    opts: { fix?: boolean } = {},
  ): Promise<{
    userId: string;
    expected: number;
    redis: number | null;
    mismatched: boolean;
    fixed: boolean;
  }> {
    if (!userId) {
      throw new Error('reconcileGrantPool requires a valid userId');
    }
    const expected = await this.calculateGrantFromDB(userId);
    const redis = this.parseCachedInt(await this.redis.get(this.grantKey(userId)));
    const mismatched = redis !== expected;
    let fixed = false;
    if (mismatched) {
      creditReconcileMismatchTotal.labels('grant').inc();
      if (opts.fix !== false) {
        await this.redis.set(this.grantKey(userId), expected.toString());
        fixed = true;
      }
    }
    return { userId, expected, redis, mismatched, fixed };
  }

  async reconcileUserCreditCache(
    userId: string,
    opts: { fix?: boolean } = {},
  ): Promise<{
    userId: string;
    grant: Awaited<ReturnType<CreditService['reconcileGrantPool']>>;
    subscriptions: Array<Awaited<ReturnType<CreditService['reconcileSubscriptionCache']>>>;
    mismatched: boolean;
    fixed: boolean;
  }> {
    if (!userId) {
      throw new Error('reconcileUserCreditCache requires a valid userId');
    }
    const states = await this.prisma.creditBalanceState.findMany({
      where: { userId },
      select: { subscriptionId: true },
    });
    const [grant, ...subscriptionResults] = await Promise.all([
      this.reconcileGrantPool(userId, opts),
      ...states.map((state) =>
        this.reconcileSubscriptionCache(state.subscriptionId, userId, opts),
      ),
    ]);
    return {
      userId,
      grant,
      subscriptions: subscriptionResults,
      mismatched: grant.mismatched || subscriptionResults.some((item) => item.mismatched),
      fixed: grant.fixed || subscriptionResults.some((item) => item.fixed),
    };
  }

  // ============================
  // 积分余额查询
  // ============================

  async getBalances(
    subscriptionId: string,
    userId: string,
  ): Promise<{ quota: number; bonus: number; grant?: number; total: number }> {
    if (!subscriptionId) {
      // 即使没有订阅,grant 池仍可能存在(用户级)
      const grant = userId ? await this.getGrantBalance(userId) : 0;
      return { quota: 0, bonus: 0, grant, total: grant };
    }

    const [balance, grant] = await Promise.all([
      this.balanceState.get(subscriptionId, userId),
      userId ? this.getGrantBalance(userId) : Promise.resolve(0),
    ]);

    return {
      quota: balance.quota,
      bonus: balance.bonus,
      grant,
      total: balance.quota + balance.bonus + grant,
    };
  }

  async getAuthoritativeBalances(
    subscriptionId: string,
    userId: string,
  ): Promise<{ quota: number; bonus: number; grant: number; total: number }> {
    if (!subscriptionId) {
      const grant = userId ? await this.getGrantBalance(userId) : 0;
      return { quota: 0, bonus: 0, grant, total: grant };
    }
    const [balance, grant] = await Promise.all([
      this.balanceState.getAuthoritative(subscriptionId, userId),
      userId ? this.getGrantBalance(userId) : Promise.resolve(0),
    ]);
    return {
      quota: balance.quota,
      bonus: balance.bonus,
      grant,
      total: balance.quota + balance.bonus + grant,
    };
  }

  /**
   * PR0-1: 读取 grant 池余额。
   *
   * Review fix(冷启动重算):Redis 缺失时不再直接返回 0 —— 与 quota / bonus
   * 走相同的"缓存缺失 → 查 DB 重算 → 回填 Redis"模式,避免 Redis 重启或
   * 节点漂移后池被清空导致用户合法的 GRANT 余额被吞掉。
   *
   * 重算公式: SUM(amount - usedAmount) WHERE userId AND !isExpired AND !isUsedUp
   * 回填用 SETNX,避免与并发的 incrby/decrby 互相覆盖。
   *
   * Redis 故障时仍降级为 0(后续扣款落 bonus + quota,行为不退化)。
   */
  private async getGrantBalance(userId: string): Promise<number> {
    if (!userId) return 0;
    try {
      const v = await this.redis.get(this.grantKey(userId));
      if (v !== null && v !== undefined) {
        const n = parseInt(v, 10);
        return Number.isFinite(n) && n > 0 ? n : 0;
      }
      // 缓存缺失 → 重算
      return await this.recalculateGrantFromDB(userId);
    } catch (err) {
      this.logger.warn(`getGrantBalance failed user=${userId}: ${(err as Error).message}`);
      return 0;
    }
  }

  /**
   * PR0-1 review fix: 从 GrantRedemption 重算 grant 池余额,SETNX 回填 Redis。
   * 失败 / 异常时返回 0,不抛 —— 调用方走"池故障"降级。
   */
  private async recalculateGrantFromDB(userId: string): Promise<number> {
    try {
      const sum = await this.calculateGrantFromDB(userId);
      if (sum > 0) {
        // SETNX 防覆盖:只在 key 不存在时写,避免并发的扣款 / incrby 被回填覆盖。
        // ioredis: SET ... NX
        await this.redis.set(this.grantKey(userId), sum.toString(), 'NX').catch((err) => {
          this.logger.warn(
            `grant pool SETNX backfill failed user=${userId} sum=${sum}: ${(err as Error).message}`,
          );
        });
      }
      return sum;
    } catch (err) {
      this.logger.warn(
        `recalculateGrantFromDB failed user=${userId}: ${(err as Error).message}`,
      );
      return 0;
    }
  }

  private async calculateGrantFromDB(userId: string): Promise<number> {
    const grants = await this.prisma.grantRedemption.findMany({
      where: {
        userId,
        isExpired: false,
        isUsedUp: false,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { amount: true, usedAmount: true },
    });
    let sum = 0;
    for (const g of grants) {
      const remain = (g.amount ?? 0) - (g.usedAmount ?? 0);
      if (remain > 0) sum += remain;
    }
    return sum;
  }

  // ============================
  // 套餐月度积分发放
  // ============================

  async grantQuota(
    subscriptionId: string,
    userId: string,
    credits: number,
    source: string,
    opts: { idempotencyKey: string },
  ): Promise<void> {
    if (!subscriptionId) {
      throw new Error('grantQuota requires a valid subscriptionId');
    }
    if (!opts?.idempotencyKey) {
      throw new Error('grantQuota requires an idempotencyKey');
    }
    // R6 codex-review P1-c：migration 放宽了表级 quota>=0 CHECK（仅为承接扣减跨零的负 quota），
    // 但发放金额本身仍必须非负。补应用层守卫，恢复被放宽掉的防线——否则误配置
    // Plan.monthlyCredits<0 会经通用续费 grantQuota 在任意积分产品上静默写负 quota。
    if (!Number.isSafeInteger(credits) || credits < 0) {
      throw new Error(`grantQuota requires non-negative integer credits, got ${credits}`);
    }

    const existing = await this.prisma.creditTransaction.findUnique({
      where: { idempotencyKey: opts.idempotencyKey },
      select: {
        subscriptionId: true,
        userId: true,
        type: true,
        creditsAmount: true,
        source: true,
      },
    });
    if (existing) {
      this.assertReplayMatches(existing, {
        subscriptionId,
        userId,
        type: 'QUOTA_GRANT',
        creditsAmount: credits,
        source,
      });
      await this.schedulePublisherKeyBalanceSyncForTransaction(existing);
      this.logger.warn(`grantQuota 重放预检跳过 key=${opts.idempotencyKey}`);
      return;
    }

    const context = await this.subscriptionContext(subscriptionId);

    try {
      await this.balanceState.mutate(
        subscriptionId,
        userId,
        (current) => {
          // R6 §1.5 运行时断言：grantQuota 是 SET 语义（新 entitlement 零余额首发）。
          // current.quota<0 说明欠额未经净发就被 SET 抹掉——必为调用方 bug，快速失败。
          // 清欠须走 resetQuota 净发（additive），不得由 grantQuota 静默吞债。
          if (current.quota < 0) {
            throw new Error(
              `grantQuota refuses to SET over negative quota subscription=${subscriptionId} `
                + `quota=${current.quota}; settle debt via resetQuota net mode instead`,
            );
          }
          return { quota: credits, bonus: current.bonus };
        },
        async (tx, _current, next) => {
          await tx.creditTransaction.create({
            data: {
              userId,
              subscriptionId,
              ...context,
              type: 'QUOTA_GRANT',
              creditsAmount: credits,
              source,
              quotaAfter: next.quota,
              bonusAfter: next.bonus,
              balanceVersion: next.version,
              idempotencyKey: opts.idempotencyKey,
            },
          });
        },
      );
      this.schedulePublisherKeyBalanceSync(userId, context.tenantId);
    } catch (err: unknown) {
      if (hasPrismaErrorCode(err, 'P2002')) {
        const replay = await this.prisma.creditTransaction.findUnique({
          where: { idempotencyKey: opts.idempotencyKey },
          select: {
            subscriptionId: true,
            userId: true,
            type: true,
            creditsAmount: true,
            source: true,
          },
        });
        if (!replay) throw err;
        this.assertReplayMatches(replay, {
          subscriptionId,
          userId,
          type: 'QUOTA_GRANT',
          creditsAmount: credits,
          source,
        });
        await this.schedulePublisherKeyBalanceSyncForTransaction(replay);
        this.logger.warn(`grantQuota 重放跳过 key=${opts.idempotencyKey}`);
        return;
      }
      throw err;
    }
  }

  // ============================
  // 月度重置
  // ============================

  async resetQuota(
    subscriptionId: string,
    userId: string,
    newQuota: number,
    source: string,
    opts: {
      idempotencyKey: string;
      negativeSettleMode?: 'net' | 'forgive';
      requireActiveCodingPlanEntitlement?: boolean;
    },
  ): Promise<void> {
    if (!subscriptionId) {
      throw new Error('resetQuota requires a valid subscriptionId');
    }
    if (!opts?.idempotencyKey) {
      throw new Error('resetQuota requires an idempotencyKey');
    }
    // R6 codex-review P1-c：发放金额必须非负（负 quota 只能由扣减跨零产生，不能由发放写入）。
    if (!Number.isSafeInteger(newQuota) || newQuota < 0) {
      throw new Error(`resetQuota requires non-negative integer newQuota, got ${newQuota}`);
    }
    // R6 §二 清负语义。net（默认）=扣欠净发：欠额直接抵扣本次发放（additive），
    // 守恒且对账清晰；forgive=显式豁免：先把负额清到 0 再 SET 满额（体感更友好但白送欠额）。
    const negativeSettleMode = opts.negativeSettleMode ?? 'net';
    const replayExpectation = {
      subscriptionId,
      userId,
      type: 'QUOTA_GRANT',
      creditsAmount: newQuota,
      source,
    };
    const existing = await this.prisma.creditTransaction.findUnique({
      where: { idempotencyKey: opts.idempotencyKey },
      select: {
        subscriptionId: true,
        userId: true,
        type: true,
        creditsAmount: true,
        source: true,
      },
    });
    if (existing) {
      this.assertReplayMatches(existing, replayExpectation);
      await this.schedulePublisherKeyBalanceSyncForTransaction(existing);
      return;
    }
    const context = await this.subscriptionContext(subscriptionId);
    try {
      await this.balanceState.mutate(
        subscriptionId,
        userId,
        (current) =>
          current.quota < 0 && negativeSettleMode === 'net'
            // 净发：欠额抵扣本次发放（additive）。newQuota<|debt| 时结果仍为负（欠额缩小、余债结转）。
            ? { quota: current.quota + newQuota, bonus: current.bonus }
            // SET：正/零余额（既有语义），或 forgive 模式先豁免再置满。
            : { quota: newQuota, bonus: current.bonus },
        async (tx, current, next) => {
          if (opts.requireActiveCodingPlanEntitlement) {
            await this.assertActiveCodingPlanEntitlementForQuotaRefresh(
              tx,
              subscriptionId,
            );
          }
          if (current.quota > 0) {
            // 正余额清账行（既有语义）：清旧 quota 到 0，再由下方 GRANT 置满。
            await tx.creditTransaction.create({
              data: {
                userId,
                subscriptionId,
                ...context,
                type: 'QUOTA_RESET',
                creditsAmount: -current.quota,
                source: `reset:${source}`,
                quotaAfter: 0,
                bonusAfter: current.bonus,
              },
            });
          } else if (current.quota < 0 && negativeSettleMode === 'forgive') {
            // 显式豁免：把负额补回 0（+|debt|），再由下方 GRANT 置满。
            // source 沿用 `reset:${source}`（与正余额清账行同键），使 ledger-replay 的
            // reset_pair 配对成立（配对键=去 `reset:` 前缀后与 GRANT.source 相等）。
            await tx.creditTransaction.create({
              data: {
                userId,
                subscriptionId,
                ...context,
                type: 'QUOTA_RESET',
                creditsAmount: -current.quota,
                source: `reset:${source}`,
                quotaAfter: 0,
                bonusAfter: current.bonus,
              },
            });
          }
          // net 模式且 current.quota<0：不写清账行；GRANT 行 quotaAfter=next.quota=current.quota+newQuota，
          // 相对 prior(负) 天然 additive，与 ledger-replay 的 GRANT additive-when-negative 语义精确镜像。
          await tx.creditTransaction.create({
            data: {
              userId,
              subscriptionId,
              ...context,
              type: 'QUOTA_GRANT',
              creditsAmount: newQuota,
              source,
              quotaAfter: next.quota,
              bonusAfter: next.bonus,
              balanceVersion: next.version,
              idempotencyKey: opts.idempotencyKey,
            },
          });
        },
      );
      this.schedulePublisherKeyBalanceSync(userId, context.tenantId);
    } catch (err: unknown) {
      if (!hasPrismaErrorCode(err, 'P2002')) throw err;
      const replay = await this.prisma.creditTransaction.findUnique({
        where: { idempotencyKey: opts.idempotencyKey },
        select: {
          subscriptionId: true,
          userId: true,
          type: true,
          creditsAmount: true,
          source: true,
        },
      });
      if (!replay) throw err;
      this.assertReplayMatches(replay, replayExpectation);
      await this.schedulePublisherKeyBalanceSyncForTransaction(replay);
    }
  }

  private async assertActiveCodingPlanEntitlementForQuotaRefresh(
    tx: Prisma.TransactionClient,
    entitlementId: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<Array<{
      status: string;
      fulfillmentMode: string;
    }>>`
      SELECT
        "status"::text AS "status",
        "fulfillment_mode"::text AS "fulfillmentMode"
      FROM "coding_plan_entitlements"
      WHERE "id" = ${entitlementId}
      FOR UPDATE
    `;
    const entitlement = rows[0];
    if (
      rows.length !== 1
      || entitlement.fulfillmentMode !== 'platform_model_package'
      || entitlement.status !== 'ACTIVE'
    ) {
      throw new Error(
        `Coding Plan quota refresh requires ACTIVE self-operated entitlement: ${entitlementId}`,
      );
    }
  }

  // ============================
  // 加油包积分充入
  // ============================

  async addBonus(
    subscriptionId: string,
    userId: string,
    credits: number,
    source: string,
    opts: { idempotencyKey: string },
  ): Promise<void> {
    if (!subscriptionId) {
      throw new Error('addBonus requires a valid subscriptionId');
    }
    if (!opts?.idempotencyKey) {
      throw new Error('addBonus requires an idempotencyKey');
    }
    const existing = await this.prisma.creditTransaction.findUnique({
      where: { idempotencyKey: opts.idempotencyKey },
      select: {
        subscriptionId: true,
        userId: true,
        type: true,
        creditsAmount: true,
        source: true,
      },
    });
    if (existing) {
      this.assertReplayMatches(existing, {
        subscriptionId,
        userId,
        type: 'BONUS_PURCHASE',
        creditsAmount: credits,
        source,
      });
      await this.schedulePublisherKeyBalanceSyncForTransaction(existing);
      this.logger.warn(`addBonus 重放跳过 key=${opts.idempotencyKey}`);
      return;
    }
    const context = await this.subscriptionContext(subscriptionId);

    try {
      await this.balanceState.mutate(
        subscriptionId,
        userId,
        (current) => ({ quota: current.quota, bonus: current.bonus + credits }),
        async (tx, _current, next) => {
          await tx.creditTransaction.create({
            data: {
              userId,
              subscriptionId,
              ...context,
              type: 'BONUS_PURCHASE',
              creditsAmount: credits,
              source,
              quotaAfter: next.quota,
              bonusAfter: next.bonus,
              balanceVersion: next.version,
              idempotencyKey: opts.idempotencyKey,
            },
          });
        },
      );
      this.schedulePublisherKeyBalanceSync(userId, context.tenantId);
    } catch (err: unknown) {
      if (hasPrismaErrorCode(err, 'P2002')) {
        const replay = await this.prisma.creditTransaction.findUnique({
          where: { idempotencyKey: opts.idempotencyKey },
          select: {
            subscriptionId: true,
            userId: true,
            type: true,
            creditsAmount: true,
            source: true,
          },
        });
        if (!replay) throw err;
        this.assertReplayMatches(replay, {
          subscriptionId,
          userId,
          type: 'BONUS_PURCHASE',
          creditsAmount: credits,
          source,
        });
        await this.schedulePublisherKeyBalanceSyncForTransaction(replay);
        this.logger.warn(`addBonus 重放跳过 key=${opts.idempotencyKey}`);
        return;
      }
      throw err;
    }
  }

  /**
   * Refund compensation must reverse the bucket purchased by the original
   * immutable grant receipt. Normal deduct() intentionally spends global
   * grants, then quota, then bonus and is therefore unsafe for refunds.
   */
  async reverseGrantedCredits(
    input: CreditGrantReversalInput,
  ): Promise<{
    success: boolean;
    quota: number;
    bonus: number;
  }> {
    if (!input.subscriptionId) {
      throw new Error('credit grant reversal requires subscriptionId');
    }
    if (
      !Number.isSafeInteger(input.credits)
      || input.credits <= 0
      || !input.originalGrantIdempotencyKey
      || !input.reversalIdempotencyKey
    ) {
      throw new Error('credit grant reversal requires positive credits and immutable keys');
    }

    const expectedGrantType =
      input.bucket === 'QUOTA' ? 'QUOTA_GRANT' : 'BONUS_PURCHASE';
    const originalGrant = await this.prisma.creditTransaction.findUnique({
      where: { idempotencyKey: input.originalGrantIdempotencyKey },
      select: {
        subscriptionId: true,
        userId: true,
        type: true,
        creditsAmount: true,
      },
    });
    if (
      !originalGrant
      || originalGrant.subscriptionId !== input.subscriptionId
      || originalGrant.userId !== input.userId
      || originalGrant.type !== expectedGrantType
      || originalGrant.creditsAmount < input.credits
    ) {
      throw new Error(
        `CREDIT_GRANT_REVERSAL_RECEIPT_MISMATCH:${input.originalGrantIdempotencyKey}`,
      );
    }

    const existing = await this.prisma.creditTransaction.findUnique({
      where: { idempotencyKey: input.reversalIdempotencyKey },
      select: {
        subscriptionId: true,
        userId: true,
        type: true,
        creditsAmount: true,
        source: true,
        requestId: true,
        quotaAfter: true,
        bonusAfter: true,
      },
    });
    if (existing) {
      this.assertReplayMatches(existing, {
        subscriptionId: input.subscriptionId,
        userId: input.userId,
        type: 'REFUND',
        creditsAmount: -input.credits,
        source: input.source,
      });
      if (existing.requestId !== input.originalGrantIdempotencyKey) {
        throw new Error(
          `credit reversal idempotency key provenance mismatch: ${input.reversalIdempotencyKey}`,
        );
      }
      await this.schedulePublisherKeyBalanceSyncForTransaction(existing);
      return {
        success: true,
        quota: existing.quotaAfter,
        bonus: existing.bonusAfter,
      };
    }

    const context = await this.subscriptionContext(input.subscriptionId);
    try {
      const result = await this.balanceState.mutate(
        input.subscriptionId,
        input.userId,
        (current) => {
          if (input.bucket === 'QUOTA') {
            if (current.quota < input.credits) return null;
            return {
              quota: current.quota - input.credits,
              bonus: current.bonus,
            };
          }
          if (current.bonus < input.credits) return null;
          return {
            quota: current.quota,
            bonus: current.bonus - input.credits,
          };
        },
        async (tx, _current, next) => tx.creditTransaction.create({
          data: {
            userId: input.userId,
            subscriptionId: input.subscriptionId,
            ...context,
            type: 'REFUND',
            creditsAmount: -input.credits,
            source: input.source,
            requestId: input.originalGrantIdempotencyKey,
            quotaAfter: next.quota,
            bonusAfter: next.bonus,
            balanceVersion: next.version,
            idempotencyKey: input.reversalIdempotencyKey,
          },
        }),
      );
      if (!result.changed) {
        return {
          success: false,
          quota: result.snapshot.quota,
          bonus: result.snapshot.bonus,
        };
      }
      this.schedulePublisherKeyBalanceSync(input.userId, context.tenantId);
      return {
        success: true,
        quota: result.snapshot.quota,
        bonus: result.snapshot.bonus,
      };
    } catch (err) {
      if (!hasPrismaErrorCode(err, 'P2002')) throw err;
      const replay = await this.prisma.creditTransaction.findUnique({
        where: { idempotencyKey: input.reversalIdempotencyKey },
        select: {
          subscriptionId: true,
          userId: true,
          type: true,
          creditsAmount: true,
          source: true,
          requestId: true,
          quotaAfter: true,
          bonusAfter: true,
        },
      });
      if (!replay) throw err;
      this.assertReplayMatches(replay, {
        subscriptionId: input.subscriptionId,
        userId: input.userId,
        type: 'REFUND',
        creditsAmount: -input.credits,
        source: input.source,
      });
      if (replay.requestId !== input.originalGrantIdempotencyKey) {
        throw new Error(
          `credit reversal idempotency key provenance mismatch: ${input.reversalIdempotencyKey}`,
        );
      }
      await this.schedulePublisherKeyBalanceSyncForTransaction(replay);
      return {
        success: true,
        quota: replay.quotaAfter,
        bonus: replay.bonusAfter,
      };
    }
  }

  // ============================
  // 扣减积分（grant 预留后，由 PostgreSQL 原子扣 quota，再扣 bonus）
  // ============================

  async deduct(
    subscriptionId: string,
    userId: string,
    amount: number,
    source: string,
    /** 可选：记录消耗的模型名称 */
    modelName?: string,
    /** 可选：token 用量明细 */
    tokenDetail?: {
      inputTokens?: number;
      outputTokens?: number;
      totalTokens?: number;
      cachedInputTokens?: number;
      requestId?: string;
    },
    options: CreditDeductOptions = {},
  ): Promise<{ success: boolean; quota: number; bonus: number; grant?: number; fromGrant?: number }> {
    if (!subscriptionId) {
      return { success: false, quota: 0, bonus: 0 };
    }

    if (amount <= 0) {
      const balances = await this.getBalances(subscriptionId, userId);
      return { success: true, quota: balances.quota, bonus: balances.bonus, grant: balances.grant ?? 0 };
    }

    if (options.idempotencyKey) {
      const existing = await this.prisma.creditTransaction.findUnique({
        where: { idempotencyKey: options.idempotencyKey },
        select: {
          subscriptionId: true,
          userId: true,
          type: true,
          creditsAmount: true,
          source: true,
          quotaAfter: true,
          bonusAfter: true,
        },
      });
      if (existing) {
        this.assertReplayMatches(existing, {
          subscriptionId,
          userId,
          type: 'CONSUME',
          creditsAmount: -amount,
          source,
        });
        await this.schedulePublisherKeyBalanceSyncForTransaction(existing);
        return {
          success: true,
          quota: existing.quotaAfter,
          bonus: existing.bonusAfter,
          grant: 0,
        };
      }
    }

    // grant 奖励池继续使用现有 Redis reservation；quota/bonus 的最终授权和
    // 流水落库统一由 PostgreSQL 权威余额事务完成。
    const balancesBeforeDeduct = await this.getBalances(subscriptionId, userId);
    const context = await this.subscriptionContext(subscriptionId);
    const intent = await this.createDeductIntent({
      subscriptionId,
      userId,
      amount,
      source,
      modelName,
      requestId: tokenDetail?.requestId,
    });

    let fromGrant = 0;
    let grantAfter = 0;
    let remaining = amount;
    if (userId && (balancesBeforeDeduct.grant ?? 0) > 0) {
      const grantOutcome = await this.tryDeductGrantPool(userId, remaining);
      fromGrant = grantOutcome.fromGrant;
      grantAfter = grantOutcome.grantAfter;
      if (fromGrant > 0) {
        remaining -= fromGrant;
        await this.markDeductIntent(intent, 'REDIS_DEBITED', {
          fromGrant,
          grantAfter,
        });
      }
    }

    if (remaining === 0 && fromGrant > 0) {
      try {
        const recorded = await this.balanceState.withLockedCurrent(
          subscriptionId,
          userId,
          async (tx, current) => {
            if (options.beforeCreditTransaction) {
              await options.beforeCreditTransaction(tx);
            }
            await tx.creditTransaction.create({
              data: {
                userId,
                subscriptionId,
                ...context,
                type: 'CONSUME',
                creditsAmount: -amount,
                source,
                modelName: modelName || undefined,
                inputTokens: tokenDetail?.inputTokens,
                cachedInputTokens: tokenDetail?.cachedInputTokens,
                outputTokens: tokenDetail?.outputTokens,
                totalTokens: tokenDetail?.totalTokens,
                requestId: tokenDetail?.requestId,
                idempotencyKey: options.idempotencyKey,
                quotaAfter: current.quota,
                bonusAfter: current.bonus,
                balanceVersion: current.version,
              },
            });
            await this.consumeFromGrantsWithinTx(tx, userId, fromGrant);
            if (options.afterCreditTransaction) {
              await options.afterCreditTransaction(tx, {
                quotaAfter: current.quota,
                bonusAfter: current.bonus,
                grantAfter,
                fromGrant,
              });
            }
          },
        );
        await this.markDeductIntent(intent, 'COMMITTED', {
          fromGrant,
          fromQuota: 0,
          fromBonus: 0,
          quotaAfter: recorded.snapshot.quota,
          bonusAfter: recorded.snapshot.bonus,
          grantAfter,
        });
        creditDeductTotal.labels('ok').inc();
        this.scheduleUsageCheck(userId);
        this.schedulePublisherKeyBalanceSync(userId, context.tenantId);
        return {
          success: true,
          quota: recorded.snapshot.quota,
          bonus: recorded.snapshot.bonus,
          grant: grantAfter,
          fromGrant,
        };
      } catch (pgErr) {
        const compensated = await this.compensateGrantPool(userId, fromGrant, pgErr);
        await this.markDeductIntent(
          intent,
          compensated ? 'FAILED' : 'RECONCILE_REQUIRED',
          { failure: 'pg_error_grant_only' },
        );
        const replay = await this.resolveDeductReplay(
          pgErr,
          options.idempotencyKey,
          subscriptionId,
          userId,
          amount,
          source,
        );
        if (replay) return replay;
        throw pgErr;
      }
    }

    let crossedNegativeDebt = 0; // >0 表示本笔跨零结算，值=欠额绝对值
    try {
      const result = await this.balanceState.mutate(
        subscriptionId,
        userId,
        (current) => {
          const available = current.quota + current.bonus;
          if (available < remaining) {
            // 余额不足：默认拒绝（return null，逐字节等价现状）。
            // R6 负额许可下才可跨零结算，第二道闸=「至多一笔跨负」：
            //   ① available>0（仍有正资产可扣）
            //   ② current.quota>=0（尚未处于负债——负债期禁止再次跨负）
            // 缺 ② 会被 addBonus/refund 在负债期重开跨负口子导致欠额无限加深（codex P1#2）。
            // 负债期正常扣款（available>=remaining，bonus 覆盖）仍走下方正常分支、可回补 quota。
            if (!options.allowNegativeBalance || available <= 0 || current.quota < 0) return null;
            crossedNegativeDebt = remaining - available; // = -(available - remaining)
            return { quota: available - remaining, bonus: 0 };
          }
          const fromQuota = Math.min(current.quota, remaining);
          const fromBonus = remaining - fromQuota;
          return {
            quota: current.quota - fromQuota,
            bonus: current.bonus - fromBonus,
          };
        },
        async (tx, current, next) => {
          if (options.beforeCreditTransaction) {
            await options.beforeCreditTransaction(tx);
          }
          const fromQuota = current.quota - next.quota;
          const fromBonus = current.bonus - next.bonus;
          await tx.creditTransaction.create({
            data: {
              userId,
              subscriptionId,
              ...context,
              type: 'CONSUME',
              creditsAmount: -amount,
              source,
              modelName: modelName || undefined,
              inputTokens: tokenDetail?.inputTokens,
              cachedInputTokens: tokenDetail?.cachedInputTokens,
              outputTokens: tokenDetail?.outputTokens,
              totalTokens: tokenDetail?.totalTokens,
              requestId: tokenDetail?.requestId,
              idempotencyKey: options.idempotencyKey,
              quotaAfter: next.quota,
              bonusAfter: next.bonus,
              balanceVersion: next.version,
            },
          });
          if (fromGrant > 0) {
            await this.consumeFromGrantsWithinTx(tx, userId, fromGrant);
          }
          if (options.afterCreditTransaction) {
            await options.afterCreditTransaction(tx, {
              quotaAfter: next.quota,
              bonusAfter: next.bonus,
              grantAfter,
              fromGrant,
            });
          }
          return { fromQuota, fromBonus };
        },
      );

      if (!result.changed) {
        const compensated = fromGrant === 0
          || await this.compensateGrantPool(
            userId,
            fromGrant,
            new Error('insufficient quota/bonus after grant reservation'),
          );
        await this.markDeductIntent(
          intent,
          compensated ? 'FAILED' : 'RECONCILE_REQUIRED',
          {
            failure: 'insufficient_credits',
            fromGrant,
            quotaAfter: result.snapshot.quota,
            bonusAfter: result.snapshot.bonus,
            grantAfter,
          },
        );
        creditDeductTotal.labels('insufficient').inc();
        this.schedulePublisherKeyBalanceSync(userId, context.tenantId);
        return {
          success: false,
          quota: result.snapshot.quota,
          bonus: result.snapshot.bonus,
          grant: compensated ? grantAfter + fromGrant : grantAfter,
        };
      }

      await this.markDeductIntent(intent, 'COMMITTED', {
        fromGrant,
        fromQuota: result.value?.fromQuota ?? 0,
        fromBonus: result.value?.fromBonus ?? 0,
        quotaAfter: result.snapshot.quota,
        bonusAfter: result.snapshot.bonus,
        grantAfter,
      });
      creditDeductTotal.labels('ok').inc();
      if (crossedNegativeDebt > 0) {
        // R6 观测：本笔发生跨零结算（终态负额）。收敛信号=此计数与欠额随刷新 cron 回落。
        creditNegativeDeductTotal.inc();
        creditNegativeDeductDebtCredits.inc(crossedNegativeDebt);
        this.logger.warn(
          `selfop terminal negative settlement subscription=${subscriptionId} `
            + `debtCredits=${crossedNegativeDebt} quotaAfter=${result.snapshot.quota}`,
        );
      }
      this.scheduleUsageCheck(userId);
      this.schedulePublisherKeyBalanceSync(userId, context.tenantId);
      return {
        success: true,
        quota: result.snapshot.quota,
        bonus: result.snapshot.bonus,
        grant: grantAfter,
        fromGrant,
      };
    } catch (pgErr) {
      const compensated = fromGrant === 0
        || await this.compensateGrantPool(userId, fromGrant, pgErr);
      await this.markDeductIntent(
        intent,
        compensated ? 'FAILED' : 'RECONCILE_REQUIRED',
        { failure: 'pg_error_authoritative_balance' },
      );
      const replay = await this.resolveDeductReplay(
        pgErr,
        options.idempotencyKey,
        subscriptionId,
        userId,
        amount,
        source,
      );
      if (replay) return replay;
      throw pgErr;
    }
  }

  private async resolveDeductReplay(
    error: unknown,
    idempotencyKey: string | undefined,
    subscriptionId: string,
    userId: string,
    amount: number,
    source: string,
  ): Promise<{
    success: boolean;
    quota: number;
    bonus: number;
    grant: number;
  } | null> {
    if (!idempotencyKey || !hasPrismaErrorCode(error, 'P2002')) return null;
    const replay = await this.prisma.creditTransaction.findUnique({
      where: { idempotencyKey },
      select: {
        subscriptionId: true,
        userId: true,
        type: true,
        creditsAmount: true,
        source: true,
        quotaAfter: true,
        bonusAfter: true,
      },
    });
    if (!replay) return null;
    this.assertReplayMatches(replay, {
      subscriptionId,
      userId,
      type: 'CONSUME',
      creditsAmount: -amount,
      source,
    });
    return {
      success: true,
      quota: replay.quotaAfter,
      bonus: replay.bonusAfter,
      grant: 0,
    };
  }

  /**
   * P2-A3 §8.1:把用量阈值检查推到 setImmediate,deduct return 之后才跑。
   *
   * - 没注入 UsageThresholdService(单测 / 旧调用方)→ 直接 noop。
   * - setImmediate 内部还要再 try/catch:UsageThresholdService.check 自身已经
   *   全 swallow,这里加一层是双保险,保证 setImmediate 抛错不会变成
   *   "unhandled exception in async function" 把 process 拖崩。
   * - **不 await**:scheduleUsageCheck 是同步入口,调用方紧接着 return。
   */
  private scheduleUsageCheck(userId: string): void {
    if (!this.usageThreshold || !userId) return;
    const svc = this.usageThreshold;
    setImmediate(() => {
      svc.check(userId).catch((err) => {
        this.logger.warn(
          `usage threshold async check failed user=${userId}: ${(err as Error)?.message ?? err}`,
        );
      });
    });
  }

  /**
   * PR0-1: 尝试从 grant 池扣减 amount(取 min(grant_balance, amount))。
   *
   * Review fix(原子化):走 DEDUCT_GRANT_POOL_LUA,Redis 内一次性
   * 完成"读取 → 裁剪 → DECRBY",消除 GET→DECRBY 之间的并发窗口。
   * 不再需要 race rollback —— Lua 不会扣超。
   *
   * 不做 Lua 前置 GET 预检:调用方复用 getBalances 的 grant 快照判断是否
   * 需要尝试;若快照为正但池已被并发扣空,则由 Lua 内部返回 0。
   *
   * Lua 失败按"grant 池故障",返回 fromGrant=0,调用方降级走 bonus+quota。
   * 返回的 grantAfter 用 Lua 之后再 GET 一次取得(近似值;若失败则用
   * "扣减前余额 − take"兜底)。
   */
  private async tryDeductGrantPool(
    userId: string,
    amount: number,
  ): Promise<{ fromGrant: number; grantAfter: number }> {
    if (!userId || amount <= 0) return { fromGrant: 0, grantAfter: 0 };
    try {
      const raw = (await this.redis.eval(
        DEDUCT_GRANT_POOL_LUA,
        1,
        this.grantKey(userId),
        amount.toString(),
      )) as number | string | null;
      const take = typeof raw === 'number' ? raw : parseInt(String(raw ?? '0'), 10);
      if (!Number.isFinite(take) || take <= 0) {
        // Lua 内部认为池空(并发被别人扣完)或异常返回 0
        const grantAfter = await this.peekGrantPool(userId);
        return { fromGrant: 0, grantAfter };
      }
      // 扣后再 GET 一次取得近似的 grantAfter(比 DECRBY 返回更准,对监控更有意义)。
      const grantAfter = await this.peekGrantPool(userId);
      return { fromGrant: take, grantAfter };
    } catch (err) {
      // grant 池故障 → 降级
      this.logger.warn(
        `grant pool deduct skipped userId=${userId} amount=${amount}: ${(err as Error).message}`,
      );
      return { fromGrant: 0, grantAfter: 0 };
    }
  }

  /** 仅读 grant 池,异常或缺失返回 0(不触发重算,避免扣款热路径多查一次 DB)。 */
  private async peekGrantPool(userId: string): Promise<number> {
    try {
      const v = await this.redis.get(this.grantKey(userId));
      if (v === null || v === undefined) return 0;
      const n = parseInt(String(v), 10);
      return Number.isFinite(n) && n > 0 ? n : 0;
    } catch {
      return 0;
    }
  }

  /**
   * PR0-1: 失败补偿 —— 回滚 grant 池(INCRBY)。失败时记 error 级日志。
   *
   * Review fix(指标):每次补偿都打 grantCompensateTotal{result=ok|failed},
   * 以便通过 Prometheus 监控 grant 路径的失败率(对应 creditDeductTotal{compensated})。
   */
  private async compensateGrantPool(userId: string, amount: number, originalErr: unknown): Promise<boolean> {
    if (!userId || amount <= 0) return true;
    try {
      await this.redis.incrby(this.grantKey(userId), amount);
      grantCompensateTotal.labels('ok').inc();
      return true;
    } catch (err) {
      grantCompensateTotal.labels('failed').inc();
      this.logger.error(
        `GRANT POOL COMPENSATE FAILED user=${userId} amount=${amount}. Original: ${(originalErr as Error).message}. Redis: ${(err as Error).message}`,
      );
      return false;
    }
  }

  async consumeFromGrants(userId: string, amount: number): Promise<void> {
    if (!userId || amount <= 0) return;
    await this.prisma.$transaction(
      (tx) => this.consumeFromGrantsWithinTx(tx, userId, amount),
      { isolationLevel: Prisma.TransactionIsolationLevel.Serializable },
    );
  }

  /**
   * 扣款后联动 GrantRedemption。调用方必须在同一 PG 事务内同时写
   * CreditTransaction 和 usedAmount,否则 Redis grant 池成功扣减后,DB
   * usedAmount 失败会被后续对账误补回 Redis。
   */
  private async consumeFromGrantsWithinTx(
    tx: Prisma.TransactionClient,
    userId: string,
    amount: number,
  ): Promise<void> {
    if (!userId || amount <= 0) return;

    const now = new Date();
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`credit:grant:${userId}`}))`;

    const grants = await tx.grantRedemption.findMany({
      where: {
        userId,
        isExpired: false,
        isUsedUp: false,
        OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
      },
      orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }],
    });

    let remaining = amount;
    for (const g of grants) {
      if (remaining <= 0) break;
      const available = g.amount - g.usedAmount;
      if (available <= 0) continue;
      const take = Math.min(remaining, available);
      const newUsed = g.usedAmount + take;
      const updated = await tx.grantRedemption.updateMany({
        where: {
          id: g.id,
          isExpired: false,
          isUsedUp: false,
          usedAmount: { lte: g.amount - take },
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        data: {
          usedAmount: { increment: take },
          isUsedUp: newUsed >= g.amount,
        },
      });
      if (updated.count !== 1) {
        throw new Error(
          `Grant redemption concurrently consumed: id=${g.id} user=${userId} amount=${take}`,
        );
      }
      remaining -= take;
    }

    if (remaining > 0) {
      throw new Error(
        `Grant pool/DB inconsistency: pool decremented by ${amount} but DB only had ${amount - remaining} unused for user=${userId}`,
      );
    }
  }

  // ============================
  // 退款（回退到加油包池）
  // ============================

  async refund(
    subscriptionId: string,
    userId: string,
    credits: number,
    source: string,
    opts: { idempotencyKey: string },
  ): Promise<void> {
    if (!subscriptionId) {
      throw new Error('refund requires a valid subscriptionId');
    }
    if (!opts?.idempotencyKey) {
      throw new Error('refund requires an idempotencyKey');
    }
    const replayExpectation = {
      subscriptionId,
      userId,
      type: 'REFUND',
      creditsAmount: credits,
      source,
    };
    const existing = await this.prisma.creditTransaction.findUnique({
      where: { idempotencyKey: opts.idempotencyKey },
      select: {
        subscriptionId: true,
        userId: true,
        type: true,
        creditsAmount: true,
        source: true,
      },
    });
    if (existing) {
      this.assertReplayMatches(existing, replayExpectation);
      await this.schedulePublisherKeyBalanceSyncForTransaction(existing);
      return;
    }
    const context = await this.subscriptionContext(subscriptionId);
    try {
      await this.balanceState.mutate(
        subscriptionId,
        userId,
        (current) => ({ quota: current.quota, bonus: current.bonus + credits }),
        async (tx, _current, next) => {
          await tx.creditTransaction.create({
            data: {
              userId,
              subscriptionId,
              ...context,
              type: 'REFUND',
              creditsAmount: credits,
              source,
              quotaAfter: next.quota,
              bonusAfter: next.bonus,
              balanceVersion: next.version,
              idempotencyKey: opts.idempotencyKey,
            },
          });
        },
      );
      this.schedulePublisherKeyBalanceSync(userId, context.tenantId);
    } catch (err: unknown) {
      if (!hasPrismaErrorCode(err, 'P2002')) throw err;
      const replay = await this.prisma.creditTransaction.findUnique({
        where: { idempotencyKey: opts.idempotencyKey },
        select: {
          subscriptionId: true,
          userId: true,
          type: true,
          creditsAmount: true,
          source: true,
        },
      });
      if (!replay) throw err;
      this.assertReplayMatches(replay, replayExpectation);
      await this.schedulePublisherKeyBalanceSyncForTransaction(replay);
    }
  }

  // ============================
  // 积分汇总（兼容自然月消耗，并补充订阅周期消耗）
  // ============================

  async getSummary(subscriptionId: string, userId: string) {
    if (!subscriptionId) {
      const grant = userId ? await this.getGrantBalance(userId) : 0;
      return {
        quotaCredits: 0,
        bonusCredits: 0,
        grantCredits: grant,
        totalCredits: grant,
        usedThisMonth: 0,
        usedThisCycle: 0,
        billingCycleStart: null,
      };
    }

    const { quota, bonus, grant = 0, total } = await this.getBalances(subscriptionId, userId);

    const monthStart = this.monthStart();
    const [usedThisMonth, billingCycleStart] = await Promise.all([
      this.consumedSince(subscriptionId, userId, monthStart),
      this.getBillingCycleStart(subscriptionId, userId),
    ]);
    const usedThisCycle = billingCycleStart
      ? await this.consumedSince(subscriptionId, userId, billingCycleStart)
      : usedThisMonth;

    return {
      quotaCredits: quota,
      bonusCredits: bonus,
      grantCredits: grant,
      totalCredits: total,
      usedThisMonth,
      usedThisCycle,
      billingCycleStart: billingCycleStart?.toISOString() ?? null,
    };
  }

  // ============================
  // 积分流水查询（分页）
  // ============================

  async getTransactions(
    subscriptionId: string,
    userId: string,
    page: number,
    pageSize: number,
  ): Promise<PaginatedResult<CreditTransaction>> {
    if (!subscriptionId) {
      return { items: [], total: 0, page, pageSize, totalPages: 0 };
    }

    const whereClause = this.txWhereClause(subscriptionId, userId);
    const [rawItems, total] = await Promise.all([
      this.prisma.creditTransaction.findMany({
        where: whereClause,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.creditTransaction.count({ where: whereClause }),
    ]);
    return {
      items: rawItems.map((t) => this.toCreditTransaction(t)),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  // ============================
  // Prisma → shared 类型映射
  // ============================

  private toCreditTransaction(tx: PrismaCreditTransaction): CreditTransaction {
    return {
      id: tx.id,
      userId: tx.userId,
      tenantId: tx.tenantId ?? null,
      productId: tx.productId ?? null,
      subscriptionId: tx.subscriptionId ?? null,
      type: tx.type as CreditTxType,
      creditsAmount: tx.creditsAmount,
      source: tx.source,
      quotaAfter: tx.quotaAfter,
      bonusAfter: tx.bonusAfter,
      inputTokens: tx.inputTokens ?? undefined,
      cachedInputTokens: tx.cachedInputTokens ?? undefined,
      outputTokens: tx.outputTokens ?? undefined,
      totalTokens: tx.totalTokens ?? undefined,
      requestId: tx.requestId ?? undefined,
      createdAt: tx.createdAt.toISOString(),
    };
  }

}
