import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { isBillingRuntime } from '../common/runtime/service-role';
import { PaymentService } from '../payment/payment.service';

@Injectable()
export class ProviderRefundWorkerService
implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProviderRefundWorkerService.name);
  private interval: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly paymentService: PaymentService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (!isBillingRuntime()) {
      this.logger.log('Skip provider refund worker outside billing runtime');
      return;
    }
    if (!this.enabled()) {
      this.logger.log('Provider refund worker disabled');
      return;
    }
    const intervalMs = this.intervalMs();
    this.interval = setInterval(() => {
      void this.runOnce('interval').catch((err) => {
        this.logger.error(
          `Provider refund interval failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }, intervalMs);
    this.interval.unref?.();
    this.startupTimer = setTimeout(() => {
      void this.runOnce('startup').catch((err) => {
        this.logger.error(
          `Provider refund startup failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }, this.startupDelayMs());
    this.startupTimer.unref?.();
    this.logger.log(
      `scheduled provider refund worker intervalMs=${intervalMs}`,
    );
  }

  onModuleDestroy(): void {
    if (this.interval) clearInterval(this.interval);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.interval = null;
    this.startupTimer = null;
  }

  async runOnce(trigger = 'manual'): Promise<{
    skipped: boolean;
    tasks: number;
    completed: number;
    pending: number;
    failed: number;
    manualReview: number;
  }> {
    if (this.running) {
      return {
        skipped: true,
        tasks: 0,
        completed: 0,
        pending: 0,
        failed: 0,
        manualReview: 0,
      };
    }
    this.running = true;
    try {
      const result =
        await this.paymentService.runDueProviderRefundIntents(
          this.batchSize(),
        );
      if (result.tasks > 0) {
        this.logger.log(
          `provider refund done trigger=${trigger} tasks=${result.tasks} completed=${result.completed} pending=${result.pending} failed=${result.failed} manualReview=${result.manualReview}`,
        );
      }
      return { skipped: false, ...result };
    } finally {
      this.running = false;
    }
  }

  private enabled(): boolean {
    return this.config.get<string>(
      'PROVIDER_REFUND_WORKER_ENABLED',
    ) !== 'false';
  }

  private intervalMs(): number {
    const raw = Number(this.config.get<string>(
      'PROVIDER_REFUND_WORKER_INTERVAL_MS',
    ) ?? '60000');
    return Number.isFinite(raw) && raw >= 5000 ? raw : 60000;
  }

  private startupDelayMs(): number {
    const raw = Number(this.config.get<string>(
      'PROVIDER_REFUND_WORKER_STARTUP_DELAY_MS',
    ) ?? '10000');
    return Number.isFinite(raw) && raw >= 0 ? raw : 10000;
  }

  private batchSize(): number {
    const raw = Number(this.config.get<string>(
      'PROVIDER_REFUND_WORKER_BATCH_SIZE',
    ) ?? '50');
    return Number.isFinite(raw) && raw > 0
      ? Math.min(Math.floor(raw), 200)
      : 50;
  }
}
