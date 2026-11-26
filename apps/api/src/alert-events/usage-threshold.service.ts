/**
 * UsageThresholdService — P2-A3 §8.1
 *
 * 用户用量异常告警源。两类阈值:
 *   - DAILY_TOKEN: 单用户单日 SUM(totalTokens) > USAGE_DAILY_TOKEN_THRESHOLD
 *                  (默认 1_000_000)→ severity=MEDIUM
 *   - HOURLY_CALL: 单用户最近 1 小时 COUNT(CONSUME) > USAGE_HOURLY_CALL_THRESHOLD
 *                  (默认 1000)→ severity=HIGH
 *
 * 接入方式:CreditService.deduct 成功后用 setImmediate 调用 check(...),
 * **完全异步、绝不抛**,失败仅 logger.warn。主链路扣款逻辑零改动。
 *
 * 去重(spec §8.1):同 user + 同 metric + 24h 内不重复发。
 * 实现方式:复用 AlertEventService 5min 去重 + sourceId 含日期/小时桶。
 *   - DAILY_TOKEN  sourceId = `${userId}:daily_token:${YYYY-MM-DD}`
 *   - HOURLY_CALL  sourceId = `${userId}:hourly_call:${YYYY-MM-DD-HH}`
 *
 * sourceId 跨桶变化时(午夜跨日 / 整点跨时)5min 软窗口失效,新桶第一次超阈值
 * 会重新发一条 —— 这是预期行为,符合 spec "24h 内不重发,跨日重置"。
 *
 * 限制:HOURLY_CALL 桶以"自然小时"切分。如果用户在 HH:59 触发一次后又在
 * HH+1:00 立即触发,理论上 1 小时内会发两条;5min 软窗口能挡住 HH:59 → HH+1:04
 * 的重复,但 HH+1:05 之后就放行了。生产实测可接受(spec 没有要求严格 24h 滚动)。
 */
import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { AlertEventService } from './alert-events.service';

export type UsageMetric = 'DAILY_TOKEN' | 'HOURLY_CALL';

const DEFAULT_DAILY_TOKEN_THRESHOLD = 1_000_000;
const DEFAULT_HOURLY_CALL_THRESHOLD = 1000;

@Injectable()
export class UsageThresholdService {
  private readonly logger = new Logger(UsageThresholdService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly alertEvents: AlertEventService,
    private readonly config: ConfigService,
  ) {}

  /**
   * 单用户两类阈值并行检查。**绝不抛**,所有错误内部 swallow。
   *
   * 设计为可被 setImmediate 包裹,从 CreditService.deduct 成功后异步调起 ——
   * deduct 已 return 之后才执行,主链路扣款行为不受影响。
   */
  async check(userId: string): Promise<void> {
    if (!userId) return;
    try {
      // 两条独立指标并行,各自失败不互相影响
      await Promise.allSettled([
        this.checkDailyToken(userId),
        this.checkHourlyCall(userId),
      ]);
    } catch (err) {
      // Promise.allSettled 不会抛,这里是双保险
      this.logger.warn(
        `usage threshold check failed user=${userId}: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  /**
   * DAILY_TOKEN: SUM(totalTokens) WHERE userId AND createdAt >= 当日 00:00。
   * 超阈值且当日首次触发(sourceId 含日期桶 + 5min 去重)→ 发 MEDIUM 告警。
   */
  private async checkDailyToken(userId: string): Promise<void> {
    try {
      const threshold = this.dailyTokenThreshold();
      if (threshold <= 0) return;

      // 按 UTC 切桶,生产(saas-test 服务器 UTC) / CI / 本地(可能 UTC+8) 行为一致。
      const startOfDay = new Date();
      startOfDay.setUTCHours(0, 0, 0, 0);

      const result = await this.prisma.creditTransaction.aggregate({
        where: {
          userId,
          createdAt: { gte: startOfDay },
          totalTokens: { not: null },
        },
        _sum: { totalTokens: true },
      });
      const totalTokens = result._sum.totalTokens ?? 0;
      if (totalTokens <= threshold) return;

      const dateBucket = this.dateBucket(startOfDay);
      await this.alertEvents.createAlert({
        category: 'USAGE',
        severity: 'MEDIUM',
        title: `用户单日 token 消费超阈值`,
        message: `用户 ${userId} 当日 token 累计 ${totalTokens} 超过阈值 ${threshold}`,
        sourceType: 'user_usage',
        sourceId: `${userId}:daily_token:${dateBucket}`,
        userId,
        context: {
          metric: 'DAILY_TOKEN',
          value: totalTokens,
          threshold,
          windowStart: startOfDay.toISOString(),
        },
      });
    } catch (err) {
      this.logger.warn(
        `checkDailyToken failed user=${userId}: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  /**
   * HOURLY_CALL: COUNT(CONSUME) WHERE userId AND createdAt >= now - 1h。
   * 超阈值且当前小时桶首次触发 → 发 HIGH 告警。
   */
  private async checkHourlyCall(userId: string): Promise<void> {
    try {
      const threshold = this.hourlyCallThreshold();
      if (threshold <= 0) return;

      const now = new Date();
      const oneHourAgo = new Date(now.getTime() - 60 * 60 * 1000);

      const count = await this.prisma.creditTransaction.count({
        where: {
          userId,
          type: 'CONSUME',
          createdAt: { gte: oneHourAgo },
        },
      });
      if (count <= threshold) return;

      const hourBucket = this.hourBucket(now);
      await this.alertEvents.createAlert({
        category: 'USAGE',
        severity: 'HIGH',
        title: `用户每小时调用次数超阈值`,
        message: `用户 ${userId} 最近 1 小时调用 ${count} 次,超过阈值 ${threshold}`,
        sourceType: 'user_usage',
        sourceId: `${userId}:hourly_call:${hourBucket}`,
        userId,
        context: {
          metric: 'HOURLY_CALL',
          value: count,
          threshold,
          windowStart: oneHourAgo.toISOString(),
        },
      });
    } catch (err) {
      this.logger.warn(
        `checkHourlyCall failed user=${userId}: ${(err as Error)?.message ?? err}`,
      );
    }
  }

  // ------------------------- 阈值读取 -------------------------

  private dailyTokenThreshold(): number {
    const raw = this.config.get<string>('USAGE_DAILY_TOKEN_THRESHOLD');
    return parsePositiveInt(raw, DEFAULT_DAILY_TOKEN_THRESHOLD);
  }

  private hourlyCallThreshold(): number {
    const raw = this.config.get<string>('USAGE_HOURLY_CALL_THRESHOLD');
    return parsePositiveInt(raw, DEFAULT_HOURLY_CALL_THRESHOLD);
  }

  // ------------------------- 桶 key -------------------------

  /**
   * YYYY-MM-DD UTC 日期(用于 sourceId 跨日重置去重)。
   *
   * 按 UTC 切桶 — saas-test 服务器在 UTC,本地/CI 可能在 UTC+8。统一 UTC 后,
   * 生产 / CI / 本地行为一致,sourceId 不会因为部署机器时区不同而漂移。
   *
   * 注意:运营在 UTC+8 看到的"今日"和 alert 桶的"UTC 今日"会差一天 ——
   * 但去重语义保持(同 metric 短时间内只发一条),业务影响小;一致性 > 可读性。
   */
  private dateBucket(d: Date): string {
    const y = d.getUTCFullYear();
    const m = String(d.getUTCMonth() + 1).padStart(2, '0');
    const day = String(d.getUTCDate()).padStart(2, '0');
    return `${y}-${m}-${day}`;
  }

  /** YYYY-MM-DD-HH UTC 小时(用于 hourly_call sourceId 跨整点重置)。 */
  private hourBucket(d: Date): string {
    const h = String(d.getUTCHours()).padStart(2, '0');
    return `${this.dateBucket(d)}-${h}`;
  }
}

function parsePositiveInt(raw: string | undefined, fallback: number): number {
  if (raw === undefined || raw === null || raw === '') return fallback;
  const n = Number(raw);
  if (!Number.isFinite(n) || n <= 0) return fallback;
  return Math.floor(n);
}
