import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { BillingService } from '../billing/billing.service';
import { GatewayRequestEventBillingService } from '../billing/gateway-request-event-billing.service';
import { isBillingRuntime } from '../common/runtime/service-role';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

const RELEASE_LOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export interface RetryWaitRecoveryResult {
  trigger: string;
  skipped: boolean;
  scanned: number;
  fundingReleased: number;
  eventsRecovered: number;
  manualAbsorptionRequired: number;
  failed: number;
}

/**
 * 冻结 RETRY_WAIT 事件的自愈 worker(2026-09-22 上海 UAT 402 事故)。
 *
 * RETRY_WAIT 没有任何重试驱动者:重投依赖消息重放,结算状态一旦落库就再没人碰它。
 * 而结算失败路径可能泄漏 ACTIVE funding reservation(队头阻塞 ⇒ 后续 funding 全部
 * QUEUE_PENDING),让事件永远等不到资金 —— 实测上海 UAT 两条事件冻结 39 天,
 * 账户级 settlement_retry_pending 限制因排空判据永不归零而持续拦住整个账户
 * (含同租户新建 key,全端点 402 连坐)。
 *
 * 每轮对超过宽限期的冻结事件做两步(各自幂等,顺序:先疏通队列再收口):
 *   1. 该 request 的 ACTIVE funding reservation 走正规释放入口
 *      (releaseGatewayBalanceFundingReservation:带 transition GUC 与锁序);
 *   2. recoverFrozenRetryWaitEvent:条件收口事件 FAILED/CLOSED 并释放限制
 *      (legacy requestId 键 + 主体候选键;投影由表触发器自动入队)。
 *
 * 判据用 updated_at 而非 created_at:正常缓慢重试中的事件会持续刷新 updated_at,
 * 只有真正冻结(宽限期默认 24h 无任何进展)的才收口。
 */
@Injectable()
export class RetryWaitRecoveryWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RetryWaitRecoveryWorkerService.name);
  private readonly lockKey = 'billing:retry-wait-recovery:lock';
  private interval: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly billing: BillingService,
    private readonly gatewayBilling: GatewayRequestEventBillingService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (!isBillingRuntime()) {
      this.logger.log('Skip retry-wait recovery worker outside billing runtime');
      return;
    }
    if (!this.enabled()) {
      this.logger.log('Retry-wait recovery worker disabled');
      return;
    }
    const intervalMs = this.intervalMs();
    this.interval = setInterval(() => {
      void this.runOnce('interval');
    }, intervalMs);
    this.interval.unref?.();
    this.logger.log(`scheduled retry-wait recovery worker intervalMs=${intervalMs}`);
  }

  onModuleDestroy(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async runOnce(trigger = 'manual'): Promise<RetryWaitRecoveryResult> {
    const result: RetryWaitRecoveryResult = {
      trigger,
      skipped: false,
      scanned: 0,
      fundingReleased: 0,
      eventsRecovered: 0,
      manualAbsorptionRequired: 0,
      failed: 0,
    };
    if (this.running) {
      result.skipped = true;
      return result;
    }
    const lockToken = randomUUID();
    const locked = await this.acquireLock(lockToken);
    if (!locked) {
      result.skipped = true;
      return result;
    }
    this.running = true;
    try {
      const staleBefore = new Date(Date.now() - this.graceHours() * 60 * 60 * 1000);
      const frozen = await this.prisma.gatewayBillingEvent.findMany({
        where: {
          status: 'RETRYABLE_FAILED',
          reconciliationStatus: 'RETRY_WAIT',
          updatedAt: { lt: staleBefore },
        },
        select: { id: true, requestId: true },
        orderBy: { updatedAt: 'asc' },
        take: this.batchSize(),
      });
      result.scanned = frozen.length;
      for (const event of frozen) {
        try {
          // 1) 疏通 funding 队列:泄漏的 ACTIVE reservation 走正规释放入口。
          //    只认本 request 自己的 reservation —— 别的请求卡队头不归本事件管,
          //    那类泄漏由各自的冻结事件在各自的收口轮次里处理。
          const reservation = await this.prisma.gatewayUsageFundingReservation.findFirst({
            where: { requestId: event.requestId, status: { in: ['ACTIVE', 'MANUAL_REVIEW'] } },
            select: { id: true },
          });
          if (reservation) {
            // ★ 带泄漏 ACTIVE reservation 的冻结事件不做自动收口:
            // reservation 的 RELEASED 有 DB 断言(assert_gateway_usage_funding_terminal),
            // 只认 non_financial:*(SKIPPED+NO_CHARGE receipt)或 financial_absorption:*
            // (人工吸收凭证)两种永久证明 —— 自动清理 reason 会被拒,而跳过释放只收口
            // 事件会留下永久队头(同账户后续 BALANCE 结算周期性冻结)。正确收口是人工
            // absorb(认亏吸收),它会把事件置 ABSORBED、reservation 带证明释放。
            this.logger.warn(
              'retry-wait recovery: manual absorption required '
              + `eventId=${event.id} requestId=${event.requestId} `
              + `reservationId=${reservation.id} (leaked ACTIVE reservation holds the funding queue head)`,
            );
            result.manualAbsorptionRequired += 1;
            continue;
          }
          // 2) 收口事件 + 释放限制(条件更新保证幂等;并发时另一轮先完成则放弃)。
          const outcome = await this.gatewayBilling.recoverFrozenRetryWaitEvent(event.id);
          if (outcome.recovered) {
            result.eventsRecovered += 1;
            this.logger.warn(
              'retry-wait recovery: frozen event closed '
              + `eventId=${event.id} requestId=${event.requestId} `
              + `fundingReleased=${reservation ? 1 : 0}`,
            );
          }
        } catch (err) {
          result.failed += 1;
          this.logger.error(
            `retry-wait recovery failed eventId=${event.id}: ${(err as Error).message}`,
          );
        }
      }
      if (result.scanned > 0 || result.failed > 0) {
        this.logger.log(
          `retry-wait recovery done trigger=${trigger} scanned=${result.scanned} `
          + `fundingReleased=${result.fundingReleased} `
          + `recovered=${result.eventsRecovered} `
          + `manualAbsorptionRequired=${result.manualAbsorptionRequired} `
          + `failed=${result.failed}`,
        );
      }
    } finally {
      await this.releaseLock(lockToken);
      this.running = false;
    }
    return result;
  }

  private async acquireLock(token: string): Promise<boolean> {
    try {
      const ok = await this.redis.set(this.lockKey, token, 'PX', 300_000, 'NX');
      return ok === 'OK';
    } catch {
      return false;
    }
  }

  private async releaseLock(token: string): Promise<void> {
    try {
      await this.redis.eval(RELEASE_LOCK_LUA, 1, this.lockKey, token);
    } catch {
      // 锁过期自清(300s);释放失败只影响下一轮多等一次。
    }
  }

  private enabled(): boolean {
    const raw = this.config.get<string>('BILLING_RETRY_WAIT_RECOVERY_ENABLED')
      ?? process.env.BILLING_RETRY_WAIT_RECOVERY_ENABLED;
    if (raw === undefined || raw === null || raw === '') return true;
    return !['false', '0', 'off', 'no'].includes(String(raw).toLowerCase());
  }

  private graceHours(): number {
    const raw = Number(
      this.config.get<string>('BILLING_RETRY_WAIT_RECOVERY_GRACE_HOURS')
        ?? process.env.BILLING_RETRY_WAIT_RECOVERY_GRACE_HOURS
        ?? 24,
    );
    return Number.isFinite(raw) && raw > 0 ? raw : 24;
  }

  private intervalMs(): number {
    const raw = Number(
      this.config.get<string>('BILLING_RETRY_WAIT_RECOVERY_INTERVAL_MS')
        ?? process.env.BILLING_RETRY_WAIT_RECOVERY_INTERVAL_MS
        ?? 300_000,
    );
    return Number.isFinite(raw) && raw >= 15_000 ? raw : 300_000;
  }

  private batchSize(): number {
    const raw = Number(
      this.config.get<string>('BILLING_RETRY_WAIT_RECOVERY_BATCH_SIZE')
        ?? process.env.BILLING_RETRY_WAIT_RECOVERY_BATCH_SIZE
        ?? 20,
    );
    return Number.isFinite(raw) && raw > 0 ? Math.min(raw, 100) : 20;
  }
}
