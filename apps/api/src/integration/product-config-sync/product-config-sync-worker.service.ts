import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ProductConfigSyncService } from './product-config-sync.service';

@Injectable()
export class ProductConfigSyncWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(ProductConfigSyncWorkerService.name);
  private interval: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly syncJobs: ProductConfigSyncService,
  ) {}

  onModuleInit(): void {
    if (this.config.get<string>('PRODUCT_CONFIG_SYNC_WORKER_ENABLED') === 'false') return;
    const intervalMs = Number(this.config.get<string>('PRODUCT_CONFIG_SYNC_WORKER_INTERVAL_MS') ?? 15_000);
    this.interval = setInterval(() => {
      void this.tick();
    }, Math.max(5_000, intervalMs));
    this.interval.unref?.();
  }

  onModuleDestroy(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
  }

  private async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.syncJobs.processDue(
        Number(this.config.get<string>('PRODUCT_CONFIG_SYNC_WORKER_BATCH_SIZE') ?? 20),
      );
      if (result.processed > 0) {
        this.logger.log(
          `product config sync processed=${result.processed} succeeded=${result.succeeded} failed=${result.failed}`,
        );
      }
    } catch (err) {
      this.logger.warn(
        `product config sync scan failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.running = false;
    }
  }
}
