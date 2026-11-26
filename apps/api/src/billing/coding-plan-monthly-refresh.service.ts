import { Injectable, Logger, OnModuleInit, OnModuleDestroy } from '@nestjs/common';
import { CodingPlanFulfillmentMode, CodingPlanEntitlementStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { CreditService } from './credit.service';
import { SystemConfigService } from './system-config.service';
import { coerceGateBool } from './rolling-quota-gate-config.service';
import { isBillingRuntime } from '../common/runtime/service-role';
import {
  codingPlanMonthlyRefreshTotal,
  codingPlanMonthlyRefreshErrors,
} from '../metrics/metrics.registry';

/** SystemConfig key：月度补发（R3b）运行时 admin 开关（DB 支撑，默认关）。 */
export const CODING_PLAN_MONTHLY_REFRESH_CONFIG_KEY = 'coding_plan_monthly_refresh_enabled';

/** env 维度是否强制开启（供 admin 状态展示与守卫；与 SystemConfig 解耦）。 */
export function codingPlanMonthlyRefreshEnvForced(): boolean {
  const raw = process.env.BILLING_CODING_PLAN_MONTHLY_REFRESH_ENABLED;
  if (!raw) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

const DAY_MS = 24 * 60 * 60 * 1000;
// 每小时扫描一次即可：幂等键 cpm:refresh:<entId>:<k> 使重复/多副本运行成为 no-op，
// 小时级 tick 保证任何月边界在 ~1h 内被补上（远优于设计的 ~24h 上限），且对 pod 重启鲁棒。
const TICK_INTERVAL_MS = 60 * 60 * 1000;
// plan.validityDays 是「单月」服务单位（季/年付 = validityDays × periodMultiplier 落在 expiresAt）。
// 只有单月单位落在正常自然月区间才按均匀月轴推 k；否则（override/非标）保守跳过。
const MIN_MONTH_DAYS = 28;
const MAX_MONTH_DAYS = 31;

export type MonthlyRefreshSummary = {
  enabled: boolean;
  scanned: number;
  refreshed: number;
  skippedGuard: number;
  failed: number;
};

/**
 * R3b 月度补发：自营 TokenPlan 的季/年付与「同档续订复用 entitlement」都指望一个
 * 「在现有 entitlement 上按月 resetQuota」的 cron——本仓此前不存在（0730 根因 R3b）。
 * 本服务补上：每日扫描 ACTIVE 自营 entitlement，按 k=floor((now-startedAt)/月长) 幂等补发。
 *
 * resetQuota 默认 net 模式——同时清偿 R6 跨零欠额（负 quota 净发抵扣），是负额结算的
 * 「续订/月度」了结点。**未接通此 cron 前不得打开 R6 负额开关**（否则续订用户被 strand）。
 */
@Injectable()
export class CodingPlanMonthlyRefreshService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CodingPlanMonthlyRefreshService.name);
  private interval?: ReturnType<typeof setInterval>;
  private ticking = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly credit: CreditService,
    private readonly systemConfig: SystemConfigService,
  ) {}

  // 与 RollingQuotaGateConfigService 同构的「in-runtime 调度」：仅 billing runtime 起定时器
  // （billing-main → BillingRuntimeModule → BillingCoreModule 加载本 service）。不依赖 BullMQ
  // （billing runtime 未装 BullMQ）。多副本各自 tick，靠 resetQuota 幂等去重、不重复发。
  onModuleInit(): void {
    if (!isBillingRuntime()) return;
    void this.tick();
    this.interval = setInterval(() => void this.tick(), TICK_INTERVAL_MS);
  }

  onModuleDestroy(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = undefined;
    }
  }

  /** 防重入包装 runOnce（同一副本上一 tick 未结束时跳过），不抛。 */
  private async tick(): Promise<void> {
    if (this.ticking) return;
    this.ticking = true;
    try {
      const summary = await this.runOnce();
      if (summary.enabled && (summary.refreshed > 0 || summary.failed > 0)) {
        this.logger.log(
          `monthly-refresh tick: scanned=${summary.scanned} refreshed=${summary.refreshed} ` +
            `skippedGuard=${summary.skippedGuard} failed=${summary.failed}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `monthly-refresh tick failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.ticking = false;
    }
  }

  private async resolveEnabled(): Promise<boolean> {
    if (codingPlanMonthlyRefreshEnvForced()) return true;
    try {
      return coerceGateBool(await this.systemConfig.getFresh(CODING_PLAN_MONTHLY_REFRESH_CONFIG_KEY)) === true;
    } catch (err) {
      this.logger.warn(
        `monthly-refresh switch read failed, treating as disabled: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  /**
   * 单次扫描 + 补发。返回汇总，供 job 记日志/指标。now 由调用方注入（便于测试）。
   * 幂等键 cpm:refresh:<entId>:<k> 保证漏跑/重跑只补最新一期 k，不重复发。
   */
  async runOnce(now: Date = new Date()): Promise<MonthlyRefreshSummary> {
    const summary: MonthlyRefreshSummary = {
      enabled: false,
      scanned: 0,
      refreshed: 0,
      skippedGuard: 0,
      failed: 0,
    };
    if (!(await this.resolveEnabled())) return summary;
    summary.enabled = true;

    const entitlements = await this.prisma.codingPlanEntitlement.findMany({
      where: {
        fulfillmentMode: CodingPlanFulfillmentMode.platform_model_package,
        status: CodingPlanEntitlementStatus.ACTIVE,
        expiresAt: { not: null, gt: now },
      },
      select: { id: true, userId: true, planId: true, startedAt: true, expiresAt: true },
    });
    summary.scanned = entitlements.length;
    if (entitlements.length === 0) return summary;

    const planIds = Array.from(new Set(entitlements.map((e) => e.planId)));
    const plans = await this.prisma.plan.findMany({
      where: { id: { in: planIds } },
      select: { id: true, monthlyCredits: true, validityDays: true },
    });
    const planById = new Map(plans.map((p) => [p.id, p]));

    for (const ent of entitlements) {
      const plan = planById.get(ent.planId);
      if (!plan) {
        summary.skippedGuard += 1;
        this.logger.warn(`monthly-refresh skip: plan not found entitlement=${ent.id} plan=${ent.planId}`);
        continue;
      }
      // 守卫：单月单位必须落在 [28,31]；否则（validityDaysOverride / 非标扩展）月边界不确定 → 保守跳过并告警。
      const monthDays = plan.validityDays;
      if (monthDays < MIN_MONTH_DAYS || monthDays > MAX_MONTH_DAYS) {
        summary.skippedGuard += 1;
        this.logger.warn(
          `monthly-refresh skip(non_uniform_month): entitlement=${ent.id} plan=${ent.planId} validityDays=${monthDays}`,
        );
        continue;
      }
      if (plan.monthlyCredits <= 0) {
        summary.skippedGuard += 1;
        continue;
      }
      const startedMs = ent.startedAt?.getTime();
      const expiresMs = ent.expiresAt?.getTime();
      if (startedMs == null || expiresMs == null) {
        summary.skippedGuard += 1;
        continue;
      }
      const monthLenMs = monthDays * DAY_MS;
      // P1-b 守卫（codex）：entitlement 实际跨度必须是「单月」的整数倍（季/年付=validityDays×periodMultiplier
      // 落 expiresAt；续订按月长整数倍延长）。非整数倍=validityDaysOverride/非标扩展/购买后改 plan.validityDays
      // → 月边界不确定，保守跳过并告警（与 payment.service proration 的 non_uniform_span 守卫同口径）。
      // 合法跨度恒为月长的精确整数倍（provision 落 expiresAt=validityDays×periodMultiplier×dayMs，
      // 续订按同量延长；均为整数毫秒运算）。用毫秒余数判定（±1s 容差仅抵浮点/时钟噪声），
      // 精确堵住近整数 override（如 31天跨度/30天月单位）误放行——codex 复评建议收紧。
      const spanRemMs = (expiresMs - startedMs) % monthLenMs;
      if (spanRemMs > 1000 && spanRemMs < monthLenMs - 1000) {
        summary.skippedGuard += 1;
        this.logger.warn(
          `monthly-refresh skip(non_uniform_span): entitlement=${ent.id} span=${expiresMs - startedMs}ms monthLen=${monthLenMs}ms remainder=${spanRemMs}ms`,
        );
        continue;
      }

      const k = Math.floor((now.getTime() - startedMs) / monthLenMs);
      // k>=1（已跨过至少一个月边界）且第 k 个月边界仍在有效期内（未过期），才补发。
      if (k < 1 || startedMs + k * monthLenMs >= expiresMs) continue;

      // P1-a 稳态短路（codex）：最新期已发 → 无需补，直接跳过（避免每小时 tick 空转 resetQuota + 污染指标）。
      const latestApplied = await this.prisma.creditTransaction.findUnique({
        where: { idempotencyKey: `cpm:refresh:${ent.id}:${k}` },
        select: { id: true },
      });
      if (latestApplied) continue;

      // P1-a 漏期补齐（codex）：net 债务净发是 additive（每期 current+newQuota），逐期累加 ≠ 只补最新一期
      // （月额35000、quota=-50000：逐期 k1→-15000 / k2→+20000；只补 k2 只到 -15000，永久少发一月）。
      // 故按 j=1..k 升序幂等重放：已发的期由 resetQuota 内部幂等键命中跳过，缺的期按序 net 补上。
      let entFailed = false;
      for (let j = 1; j <= k; j += 1) {
        try {
          // subscriptionId == entitlementId（自营积分余额以 entitlement 为粒度）。
          await this.credit.resetQuota(ent.id, ent.userId, plan.monthlyCredits, 'coding-plan:monthly-refresh', {
            idempotencyKey: `cpm:refresh:${ent.id}:${j}`,
            negativeSettleMode: 'net',
            requireActiveCodingPlanEntitlement: true,
          });
        } catch (err) {
          entFailed = true;
          this.logger.error(
            `monthly-refresh failed entitlement=${ent.id} k=${j}: ${err instanceof Error ? err.message : String(err)}`,
          );
          break; // 升序守恒要求：某期失败即停，下次 tick 从该期继续（幂等）。
        }
      }
      if (entFailed) {
        summary.failed += 1;
        codingPlanMonthlyRefreshErrors.inc();
      } else {
        // 仅在实际补齐（latest 曾缺）时计数一次/entitlement，避免稳态每小时空转 inc（P2）。
        summary.refreshed += 1;
        codingPlanMonthlyRefreshTotal.inc();
      }
    }
    return summary;
  }
}
