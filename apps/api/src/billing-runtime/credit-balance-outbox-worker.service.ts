import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CreditBalanceStateService } from '../billing/credit-balance-state.service';
import { isBillingRuntime } from '../common/runtime/service-role';

@Injectable()
export class CreditBalanceOutboxWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CreditBalanceOutboxWorkerService.name);
  private interval: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly balanceState: CreditBalanceStateService,
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
      const result = await this.balanceState.flushOutbox(this.batchSize());
      if (result.failed > 0) {
        this.logger.warn(
          `credit balance outbox delivery incomplete scanned=${result.scanned} delivered=${result.delivered} failed=${result.failed}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `credit balance outbox worker failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
      );
    } finally {
      this.running = false;
    }
  }

  private enabled(): boolean {
    return this.config.get<string>('BILLING_CREDIT_BALANCE_OUTBOX_ENABLED', 'true') !== 'false';
  }

  private intervalMs(): number {
    return Math.max(
      250,
      this.numberConfig('BILLING_CREDIT_BALANCE_OUTBOX_INTERVAL_MS', 1_000),
    );
  }

  private batchSize(): number {
    return Math.max(1, this.numberConfig('BILLING_CREDIT_BALANCE_OUTBOX_BATCH_SIZE', 100));
  }

  private numberConfig(key: string, fallback: number): number {
    const value = this.config.get<string | number>(key, fallback);
    const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
}
