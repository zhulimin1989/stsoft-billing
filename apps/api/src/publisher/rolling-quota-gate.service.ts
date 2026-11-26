import { Injectable, Logger } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import {
  resolvePlanQuotaRuleViews,
  type PlanQuotaRuleView,
} from '../quota-templates/plan-quota-rule-views';

const RULES_CACHE_PREFIX = 'cpq:rules:';
const RULES_CACHE_TTL_SEC = 300;
/** 已被滚动配额关闸的 key → 下次重判时间(ms epoch) 的有序集合，供解封调度轮询。 */
export const ROLLING_QUOTA_GATED_ZSET = 'cpq:gated';
/**
 * 关闸后重判间隔：滚动窗口何时释放容量取决于「窗口内最早一笔消耗出窗」，无法精确预测，
 * 故采用固定节奏重判（解封精度 = 该间隔；5h/7d 窗口下完全可接受），由调度按 score 轮询。
 */
const RECHECK_INTERVAL_MS = 60_000;

export interface RollingQuotaExhaustion {
  exhausted: boolean;
  /** 建议下次重判时间(ms epoch)，写入 cpq:gated 的 score。 */
  recheckAtMs: number;
}

/**
 * 滚动配额「稳态」判定 + 规则缓存（quota-v2 / P1-C B 关闸侧）。
 *
 * 与 A 侧 gate（usage-billing-strategy.checkRollingQuotaGate）的关系：
 * - A 侧：deduct→authorize 时判「本次请求是否会超限（used + increment > limit）」，超则拒、不扣费；
 * - B 侧（本服务）：判「当前是否已超限（used >= limit）」，供 publisher-sync 翻转 gw:key_balance
 *   让网关在请求前硬阻断；两侧共用 cpq:rules:{planId} 缓存与 resolvePlanQuotaRuleViews 口径。
 *
 * windowUsage 直接走 prisma（镜像 credit.service.windowUsage），刻意不注入 CreditService——
 * 否则 publisher.module → CreditService(billing) → PublisherSyncService 形成 DI 环。
 */
@Injectable()
export class RollingQuotaGateService {
  private readonly logger = new Logger(RollingQuotaGateService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /** 读取套餐 enforced 滚动规则（5min 缓存 cpq:rules:{planId}，与 A 侧同键同口径）。 */
  async loadEnforcedRollingRules(planId: string): Promise<PlanQuotaRuleView[]> {
    const cacheKey = `${RULES_CACHE_PREFIX}${planId}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) return JSON.parse(cached) as PlanQuotaRuleView[];
    } catch {
      /* 缓存读失败回源 DB */
    }
    const plan = await this.prisma.plan.findUnique({
      where: { id: planId },
      select: {
        quotaRules: {
          where: { isActive: true },
          select: { template: { select: { rules: true, isActive: true, deletedAt: true } } },
        },
      },
    });
    const views = resolvePlanQuotaRuleViews(
      plan?.quotaRules ?? [],
      (msg) => this.logger.warn(msg),
      { gateEnabled: true },
    ).filter((v) => v.enforced);
    try {
      await this.redis.set(cacheKey, JSON.stringify(views), 'EX', RULES_CACHE_TTL_SEC);
    } catch {
      /* 缓存写失败不影响判定 */
    }
    return views;
  }

  /** 失效某套餐规则缓存（模板/规则变更后调用，避免关闸用旧规则；缓存本身亦有 5min TTL 兜底）。 */
  async invalidateRulesCache(planId: string): Promise<void> {
    await this.redis.del(`${RULES_CACHE_PREFIX}${planId}`).catch(() => undefined);
  }

  /**
   * 稳态判定该订阅是否已耗尽任一 enforced 滚动配额（used >= limit）。
   * 任一规则已超即视为耗尽（应关闸）。
   */
  async evaluateExhaustion(subscriptionId: string, planId: string): Promise<RollingQuotaExhaustion> {
    const recheckAtMs = Date.now() + RECHECK_INTERVAL_MS;
    if (!subscriptionId || !planId) return { exhausted: false, recheckAtMs };
    const rules = await this.loadEnforcedRollingRules(planId);
    if (rules.length === 0) return { exhausted: false, recheckAtMs };
    const nowMs = Date.now();
    for (const rule of rules) {
      const since = new Date(nowMs - rule.durationSec * 1000);
      const used = await this.windowUsage(
        subscriptionId,
        rule.metric as 'REQUESTS' | 'CREDITS',
        since,
      );
      if (used >= rule.limitValue) {
        return { exhausted: true, recheckAtMs };
      }
    }
    return { exhausted: false, recheckAtMs };
  }

  /** 镜像 credit.service.windowUsage：CREDITS=消耗额求和绝对值 / REQUESTS=消耗笔数。 */
  private async windowUsage(
    subscriptionId: string,
    metric: 'REQUESTS' | 'CREDITS',
    since: Date,
  ): Promise<number> {
    const where = { subscriptionId, type: 'CONSUME' as const, createdAt: { gte: since } };
    if (metric === 'CREDITS') {
      const agg = await this.prisma.creditTransaction.aggregate({
        where,
        _sum: { creditsAmount: true },
      });
      return Math.abs(agg._sum.creditsAmount ?? 0);
    }
    return this.prisma.creditTransaction.count({ where });
  }
}
