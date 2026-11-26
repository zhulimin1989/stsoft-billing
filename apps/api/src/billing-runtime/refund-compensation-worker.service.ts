import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isBillingRuntime } from '../common/runtime/service-role';
import { RefundCompensationService } from '../payment/refund-compensation.service';

@Injectable()
export class RefundCompensationWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(RefundCompensationWorkerService.name);
  private interval: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly refundCompensation: RefundCompensationService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (!isBillingRuntime()) {
      this.logger.log('Skip refund compensation worker outside billing runtime');
      return;
    }
    if (!this.enabled()) {
      this.logger.log('Refund compensation worker disabled');
      return;
    }

    const intervalMs = this.intervalMs();
    this.interval = setInterval(() => {
      void this.runOnce('interval');
    }, intervalMs);
    this.interval.unref?.();

    this.startupTimer = setTimeout(() => {
      void this.runOnce('startup');
    }, this.startupDelayMs());
    this.startupTimer.unref?.();

    this.logger.log(`scheduled refund compensation worker intervalMs=${intervalMs}`);
  }

  onModuleDestroy(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  async runOnce(trigger = 'manual'): Promise<{
    skipped: boolean;
    orders: number;
    completed: number;
    failed: number;
    manualReview: number;
  }> {
    if (this.running) {
      return { skipped: true, orders: 0, completed: 0, failed: 0, manualReview: 0 };
    }

    this.running = true;
    try {
      const result = await this.refundCompensation.runDueTasks({
        batchSize: this.batchSize(),
        trigger,
      });
      if (result.orders > 0) {
        this.logger.log(
          `refund compensation done trigger=${trigger} orders=${result.orders} completed=${result.completed} failed=${result.failed} manualReview=${result.manualReview}`,
        );
      }
      return { skipped: false, ...result };
    } catch (error) {
      // DB 闪断等瞬时错误不得打崩 billing 进程（void runOnce 的未捕获拒绝会让 Node 退出）。
      this.logger.error(
        `refund compensation worker failed trigger=${trigger}: ${error instanceof Error ? error.message : String(error)}`,
      );
      return { skipped: false, orders: 0, completed: 0, failed: 0, manualReview: 0 };
    } finally {
      this.running = false;
    }
  }

  private enabled(): boolean {
    return this.config.get<string>('REFUND_COMPENSATION_WORKER_ENABLED') !== 'false';
  }

  private intervalMs(): number {
    const raw = Number(this.config.get<string>('REFUND_COMPENSATION_WORKER_INTERVAL_MS') ?? '60000');
    return Number.isFinite(raw) && raw >= 5000 ? raw : 60000;
  }

  private startupDelayMs(): number {
    const raw = Number(this.config.get<string>('REFUND_COMPENSATION_WORKER_STARTUP_DELAY_MS') ?? '10000');
    return Number.isFinite(raw) && raw >= 0 ? raw : 10000;
  }

  private batchSize(): number {
    const raw = Number(this.config.get<string>('REFUND_COMPENSATION_WORKER_BATCH_SIZE') ?? '50');
    return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 200) : 50;
  }
}
