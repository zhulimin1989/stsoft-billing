import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BillingService } from '../billing/billing.service';
import { isBillingRuntime } from '../common/runtime/service-role';

/**
 * 排空 balance_debt_settlement_pending:大额充值在事务预算内核销不完的部分,
 * 由这里分批续做,每批一个独立事务。
 *
 * 没有 Redis 锁是刻意的:取行用 FOR UPDATE SKIP LOCKED,多副本各拿不同 pending 行、
 * 互不等待,比抢一把全局锁并发度更高且无锁租约过期的问题。单副本内的重入由
 * `running` 挡掉。
 */
@Injectable()
export class BalanceDebtSettlementWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BalanceDebtSettlementWorkerService.name);
  private interval: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly billing: BillingService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (!isBillingRuntime() || !this.enabled()) return;
    this.interval = setInterval(() => {
      void this.runOnce();
    }, this.intervalMs());
    this.interval.unref?.();
    void this.runOnce();
  }

  onModuleDestroy(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  async runOnce(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      let passes = 0;
      let arrangedPasses = 0;
      // 每 tick 的处理轮数上限。一条 pending 没做完会重新入队,不设上限则本 tick
      // 会跟着同一笔充值一直跑到彻底核销完(实测最坏 29.3 万行 ≈ 5 分钟),
      // 期间这个 worker 对其它账户的 pending 完全无响应。
      const maxPasses = this.maxPasses();
      while (passes < maxPasses) {
        const result = await this.billing.settlePendingBalanceDebtOnce();
        passes += 1;
        if (!result.picked) break;
        arrangedPasses += 1;
        this.logger.log(
          'balance debt pending drained '
          + `pending=${result.pendingId} account=${result.billingAccountId} `
          + `arrangedUsd=${result.arrangedUsd.toFixed(12)}`,
        );
      }
      if (arrangedPasses >= maxPasses) {
        // 连续吃满上限说明还有存量,留给下一个 tick;这条是观测欠款是否在收敛的锚点。
        this.logger.warn(
          `balance debt pending still backlogged after ${maxPasses} passes`,
        );
      }
    } catch (err) {
      this.logger.error(
        'balance debt settlement worker failed: '
        + `${err instanceof Error ? err.stack ?? err.message : String(err)}`,
      );
    } finally {
      this.running = false;
    }
  }

  private enabled(): boolean {
    return this.config.get<string>('BILLING_DEBT_SETTLEMENT_WORKER_ENABLED', 'true') !== 'false';
  }

  private intervalMs(): number {
    return Math.max(
      1_000,
      this.numberConfig('BILLING_DEBT_SETTLEMENT_WORKER_INTERVAL_MS', 5_000),
    );
  }

  private maxPasses(): number {
    return Math.max(1, this.numberConfig('BILLING_DEBT_SETTLEMENT_WORKER_MAX_PASSES', 4));
  }

  private numberConfig(key: string, fallback: number): number {
    const value = this.config.get<string | number>(key, fallback);
    const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
}
