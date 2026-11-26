/**
 * FunnelService — admin v2 业务漏斗(/admin/v2/funnel*)。
 *
 * 三个端点的纯只读聚合:
 *   - getOverallFunnel:    注册 → 激活(账务域活动) → 付费(任意 COMPLETED Order amountCents>0) → 续订(>=2 笔)
 *   - getSubscriptionFunnel: 注册 → 订阅(SubscriptionPeriod) → 付费订阅(SUBSCRIPTION COMPLETED amountCents>0) → 续订(>=2 笔)
 *   - getPaygFunnel:       注册 → 首充(RECHARGE COMPLETED amountCents>0) → 消费(BalanceTransaction CONSUME) → 复购(>=2 笔 amountCents>0)
 *
 * 时间窗口语义(cohort funnel):days 仅限定 step1 register —— 用户必须在窗口内注册才进入 cohort 分母。
 * 后续步骤不再过滤 createdAt,看这批 cohort 用户至今为止的状态。
 *
 * 详见 docs/superpowers/specs/2026-04-30-admin-v2-backend-p2-funnel-design.md
 *
 * 实现要点:
 *   - 每步用上一步的 userId 数组做 IN 过滤,严格不增
 *   - 30s Redis 短缓存,key 含 days+segmentId
 *   - segmentId 仅总漏斗支持,STATIC 走 UserSegmentMember,DYNAMIC / 不存在返空 funnel
 *   - **绝不写数据**,任何 Redis / Prisma 异常都 fall through 不阻断
 */
import { Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

const ALLOWED_DAYS = [7, 30, 90] as const;
type AllowedDays = (typeof ALLOWED_DAYS)[number];
const DEFAULT_DAYS: AllowedDays = 30;
const CACHE_TTL_SECONDS = 30;

export interface FunnelStep {
  key: string;
  label: string;
  value: number;
}

export interface FunnelData {
  steps: FunnelStep[];
  comparedTo?: { steps: Array<{ key: string; value: number }> };
}

export interface OverallFunnelOpts {
  days: number;
  segmentId?: string;
}

export interface PeriodFunnelOpts {
  days: number;
}

/**
 * Normalize the days query parameter:
 *   - Reject NaN / non-finite / not in {7,30,90}
 *   - Fallback to 30
 */
export function normalizeDays(raw: number | string | undefined): AllowedDays {
  if (raw === undefined || raw === null || raw === '') return DEFAULT_DAYS;
  const n = typeof raw === 'string' ? parseInt(raw, 10) : raw;
  if (!Number.isFinite(n)) return DEFAULT_DAYS;
  return (ALLOWED_DAYS as readonly number[]).includes(n)
    ? (n as AllowedDays)
    : DEFAULT_DAYS;
}

@Injectable()
export class FunnelService {
  private readonly logger = new Logger(FunnelService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  // ============================ 总漏斗 ============================

  /**
   * 总漏斗:注册 → 激活 → 付费 → 续订(>=2 笔 COMPLETED)
   *
   * segmentId 处理:
   *   - 未传:统计所有近 N 天注册用户
   *   - STATIC + 存在:limit 到 UserSegmentMember 中的 userId
   *   - DYNAMIC 或不存在:返回 4 步全 0 的空 funnel(graceful)
   */
  async getOverallFunnel(opts: OverallFunnelOpts): Promise<FunnelData> {
    const days = normalizeDays(opts.days);
    const segmentId = opts.segmentId?.trim() || undefined;

    const cacheKey = `funnel:overall:${days}:${segmentId ?? 'all'}`;
    const cached = await this.tryGetCache(cacheKey);
    if (cached) return cached;

    const data = await this.computeOverall(days, segmentId);
    await this.trySetCache(cacheKey, data);
    return data;
  }

  private async computeOverall(
    days: AllowedDays,
    segmentId: string | undefined,
  ): Promise<FunnelData> {
    // 段过滤:STATIC -> 拿 userIds 白名单;DYNAMIC / 不存在 -> 返空 funnel。
    let segmentMemberIds: Set<string> | null = null;
    if (segmentId) {
      const segment = await this.prisma.userSegment.findFirst({
        where: { id: segmentId, deletedAt: null },
        select: { id: true, ruleType: true },
      });
      // 不存在 / DYNAMIC -> 4 步全 0
      if (!segment || segment.ruleType !== 'STATIC') {
        return emptyFunnel(OVERALL_LABELS);
      }
      const members = await this.prisma.userSegmentMember.findMany({
        where: { segmentId: segment.id },
        select: { userId: true },
      });
      segmentMemberIds = new Set(members.map((m) => m.userId));
      if (segmentMemberIds.size === 0) {
        return emptyFunnel(OVERALL_LABELS);
      }
    }

    // step 1: register
    const since = sinceDate(days);
    const registered = await this.prisma.user.findMany({
      where: {
        createdAt: { gte: since },
        deletedAt: null,
        ...(segmentMemberIds
          ? { id: { in: Array.from(segmentMemberIds) } }
          : {}),
      },
      select: { id: true },
    });
    const registeredIds = registered.map((u) => u.id);

    // step 2: activated -> 上一步用户中存在 billing 可观测活动。
    const activatedIds = registeredIds.length
      ? await this.distinctUserIdsWithBillingActivity(registeredIds)
      : [];

    // step 3: paid -> 上一步用户中,EXISTS Order COMPLETED amountCents > 0
    const paidIds = activatedIds.length
      ? await this.distinctUserIdsWithOrder({
          userIds: activatedIds,
          status: 'COMPLETED',
          amountGtZero: true,
        })
      : [];

    // step 4: retained -> 上一步用户中,COMPLETED Order count >= 2
    const retainedIds = paidIds.length
      ? await this.userIdsWithOrderCountGte({
          userIds: paidIds,
          status: 'COMPLETED',
          minCount: 2,
        })
      : [];

    return {
      steps: [
        { key: 'register', label: OVERALL_LABELS.register, value: registeredIds.length },
        { key: 'activated', label: OVERALL_LABELS.activated, value: activatedIds.length },
        { key: 'paid', label: OVERALL_LABELS.paid, value: paidIds.length },
        { key: 'retained', label: OVERALL_LABELS.retained, value: retainedIds.length },
      ],
    };
  }

  // ============================ 订阅漏斗 ============================

  async getSubscriptionFunnel(opts: PeriodFunnelOpts): Promise<FunnelData> {
    const days = normalizeDays(opts.days);
    const cacheKey = `funnel:sub:${days}`;
    const cached = await this.tryGetCache(cacheKey);
    if (cached) return cached;

    const data = await this.computeSubscription(days);
    await this.trySetCache(cacheKey, data);
    return data;
  }

  private async computeSubscription(days: AllowedDays): Promise<FunnelData> {
    const since = sinceDate(days);

    // step 1: register
    const registeredIds = (
      await this.prisma.user.findMany({
        where: { createdAt: { gte: since }, deletedAt: null },
        select: { id: true },
      })
    ).map((u) => u.id);

    // step 2: subscribed -> EXISTS SubscriptionPeriod
    const subscribedIds = registeredIds.length
      ? (
          await this.prisma.subscriptionPeriod.findMany({
            where: { userId: { in: registeredIds } },
            select: { userId: true },
            distinct: ['userId'],
          })
        ).map((r) => r.userId)
      : [];

    // step 3: paid_subscription -> EXISTS Order SUBSCRIPTION COMPLETED amountCents>0
    // amountCents>0 排除 0 元订单(赠送/试用),与 overall paid 口径一致
    const paidSubIds = subscribedIds.length
      ? await this.distinctUserIdsWithOrder({
          userIds: subscribedIds,
          status: 'COMPLETED',
          orderType: 'SUBSCRIPTION',
          amountGtZero: true,
        })
      : [];

    // step 4: renewed -> SUBSCRIPTION COMPLETED amountCents>0 count >= 2
    const renewedIds = paidSubIds.length
      ? await this.userIdsWithOrderCountGte({
          userIds: paidSubIds,
          status: 'COMPLETED',
          orderType: 'SUBSCRIPTION',
          minCount: 2,
          amountGtZero: true,
        })
      : [];

    return {
      steps: [
        { key: 'register', label: SUBSCRIPTION_LABELS.register, value: registeredIds.length },
        { key: 'subscribed', label: SUBSCRIPTION_LABELS.subscribed, value: subscribedIds.length },
        { key: 'paid_subscription', label: SUBSCRIPTION_LABELS.paid_subscription, value: paidSubIds.length },
        { key: 'renewed', label: SUBSCRIPTION_LABELS.renewed, value: renewedIds.length },
      ],
    };
  }

  // ============================ 按量漏斗 ============================

  async getPaygFunnel(opts: PeriodFunnelOpts): Promise<FunnelData> {
    const days = normalizeDays(opts.days);
    const cacheKey = `funnel:payg:${days}`;
    const cached = await this.tryGetCache(cacheKey);
    if (cached) return cached;

    const data = await this.computePayg(days);
    await this.trySetCache(cacheKey, data);
    return data;
  }

  private async computePayg(days: AllowedDays): Promise<FunnelData> {
    const since = sinceDate(days);

    // step 1: register
    const registeredIds = (
      await this.prisma.user.findMany({
        where: { createdAt: { gte: since }, deletedAt: null },
        select: { id: true },
      })
    ).map((u) => u.id);

    // step 2: first_recharge -> EXISTS Order RECHARGE COMPLETED amountCents>0
    // amountCents>0 排除 0 元充值(赠送),与 overall paid 口径一致
    const firstRechargeIds = registeredIds.length
      ? await this.distinctUserIdsWithOrder({
          userIds: registeredIds,
          status: 'COMPLETED',
          orderType: 'RECHARGE',
          amountGtZero: true,
        })
      : [];

    // step 3: consumed -> EXISTS BalanceTransaction CONSUME
    const consumedIds = firstRechargeIds.length
      ? (
          await this.prisma.balanceTransaction.findMany({
            where: {
              userId: { in: firstRechargeIds },
              type: 'CONSUME',
            },
            select: { userId: true },
            distinct: ['userId'],
          })
        ).map((r) => r.userId)
      : [];

    // step 4: repurchased -> RECHARGE COMPLETED amountCents>0 count >= 2
    const repurchasedIds = consumedIds.length
      ? await this.userIdsWithOrderCountGte({
          userIds: consumedIds,
          status: 'COMPLETED',
          orderType: 'RECHARGE',
          minCount: 2,
          amountGtZero: true,
        })
      : [];

    return {
      steps: [
        { key: 'register', label: PAYG_LABELS.register, value: registeredIds.length },
        { key: 'first_recharge', label: PAYG_LABELS.first_recharge, value: firstRechargeIds.length },
        { key: 'consumed', label: PAYG_LABELS.consumed, value: consumedIds.length },
        { key: 'repurchased', label: PAYG_LABELS.repurchased, value: repurchasedIds.length },
      ],
    };
  }

  // ============================ helpers ============================

  /**
   * 查"上一步 userIds 中存在指定 Order 的用户"(去重 userId 列表)。
   *
   * 注:Prisma `distinct: ['userId']` 在 PostgreSQL 上翻成原生
   * `SELECT DISTINCT ON ("userId")`,不是应用层去重。10k 用户量级 OK。
   */
  private async distinctUserIdsWithOrder(opts: {
    userIds: string[];
    status: 'COMPLETED';
    orderType?: 'SUBSCRIPTION' | 'BOOSTER_PACK' | 'RECHARGE';
    amountGtZero?: boolean;
  }): Promise<string[]> {
    if (opts.userIds.length === 0) return [];
    const rows = await this.prisma.order.findMany({
      where: {
        userId: { in: opts.userIds },
        status: opts.status,
        ...(opts.orderType ? { orderType: opts.orderType } : {}),
        ...(opts.amountGtZero ? { amountCents: { gt: 0 } } : {}),
      },
      select: { userId: true },
      distinct: ['userId'],
    });
    return rows.map((r) => r.userId);
  }

  private async distinctUserIdsWithBillingActivity(userIds: string[]): Promise<string[]> {
    if (userIds.length === 0) return [];
    const rows = await this.prisma.$queryRaw<Array<{ user_id: string }>>(Prisma.sql`
      SELECT u."id" AS "user_id"
      FROM "users" u
      WHERE u."id" IN (${Prisma.join(userIds)})
        AND (
          EXISTS (
            SELECT 1
            FROM "api_keys" ak
            WHERE ak."user_id" = u."id"
              AND ak."deleted_at" IS NULL
              AND ak."last_used_at" IS NOT NULL
          )
          OR EXISTS (
            SELECT 1
            FROM "token_usage" tu
            JOIN "api_keys" ak ON ak."id" = tu."api_key_id"
            WHERE ak."user_id" = u."id"
          )
          OR EXISTS (
            SELECT 1
            FROM "orders" o
            WHERE o."user_id" = u."id"
              AND o."status" = 'COMPLETED'
              AND o."amount_cents" > 0
          )
          OR EXISTS (
            SELECT 1
            FROM "balance_transactions" bt
            WHERE bt."user_id" = u."id"
          )
          OR EXISTS (
            SELECT 1
            FROM "credit_transactions" ct
            WHERE ct."user_id" = u."id"
          )
        )
    `);
    return rows.map((row) => row.user_id);
  }

  /**
   * 查"上一步 userIds 中,Order COMPLETED count >= minCount 的用户"。
   * 用 groupBy + having 一次拿到结果。
   *
   * 注:Prisma `distinct` / `groupBy` 在 PostgreSQL 上翻成原生 SQL
   * (`SELECT DISTINCT ON` / `GROUP BY`),不是应用层去重。10k 用户量级 OK。
   */
  private async userIdsWithOrderCountGte(opts: {
    userIds: string[];
    status: 'COMPLETED';
    orderType?: 'SUBSCRIPTION' | 'BOOSTER_PACK' | 'RECHARGE';
    minCount: number;
    amountGtZero?: boolean;
  }): Promise<string[]> {
    if (opts.userIds.length === 0) return [];
    const grouped = await this.prisma.order.groupBy({
      by: ['userId'],
      where: {
        userId: { in: opts.userIds },
        status: opts.status,
        ...(opts.orderType ? { orderType: opts.orderType } : {}),
        ...(opts.amountGtZero ? { amountCents: { gt: 0 } } : {}),
      },
      _count: { _all: true },
      having: {
        userId: { _count: { gte: opts.minCount } },
      },
    });
    return grouped.map((g) => g.userId);
  }

  // ---------------------------- cache ----------------------------

  /**
   * Redis get + JSON.parse。
   *  - Redis throw(故障 / 超时)  → warn,返回 null,走 DB
   *  - JSON.parse throw(损坏)    → warn,返回 null,走 DB
   *  - 命中合法 JSON               → 返回 FunnelData
   */
  private async tryGetCache(cacheKey: string): Promise<FunnelData | null> {
    let raw: string | null;
    try {
      raw = await this.redis.get(cacheKey);
    } catch (err) {
      this.logger.warn(
        `funnel cache get failed key=${cacheKey}: ${(err as Error)?.message ?? err}`,
      );
      return null;
    }
    if (!raw) return null;
    try {
      return JSON.parse(raw) as FunnelData;
    } catch {
      this.logger.warn(`funnel cache corrupt JSON key=${cacheKey}, recomputing`);
      return null;
    }
  }

  /**
   * Redis set EX 30。失败仅 warn,不阻断 —— 反正下次再算。
   */
  private async trySetCache(cacheKey: string, data: FunnelData): Promise<void> {
    try {
      await this.redis.set(
        cacheKey,
        JSON.stringify(data),
        'EX',
        CACHE_TTL_SECONDS,
      );
    } catch (err) {
      this.logger.warn(
        `funnel cache set failed key=${cacheKey}: ${(err as Error)?.message ?? err}`,
      );
    }
  }
}

// ============================ 常量 / helpers ============================

const OVERALL_LABELS = {
  register: '注册',
  activated: '激活',
  paid: '付费',
  retained: '续订',
} as const;

const SUBSCRIPTION_LABELS = {
  register: '注册',
  subscribed: '订阅',
  paid_subscription: '付费订阅',
  renewed: '续订',
} as const;

const PAYG_LABELS = {
  register: '注册',
  first_recharge: '首充',
  consumed: '消费',
  repurchased: '复购',
} as const;

function sinceDate(days: number): Date {
  return new Date(Date.now() - days * 24 * 60 * 60 * 1000);
}

function emptyFunnel(labels: Record<string, string>): FunnelData {
  return {
    steps: Object.entries(labels).map(([key, label]) => ({
      key,
      label,
      value: 0,
    })),
  };
}
