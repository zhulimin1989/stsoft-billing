import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PublisherSyncJobService } from './publisher-sync-job.service';
import { isProductionConfig } from '../common/runtime/is-production';
import { isBillingRuntime } from '../common/runtime/service-role';
import { publisherRetryWorkerTotal } from '../metrics/metrics.registry';

@Injectable()
export class PublisherSyncWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublisherSyncWorkerService.name);
  private interval: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly config: ConfigService,
    private readonly syncJobs: PublisherSyncJobService,
  ) {}

  onModuleInit(): void {
    const workerEnabledValue = this.config.get<string>('PUBLISHER_SYNC_WORKER_ENABLED');
    const workerEnabled = workerEnabledValue === 'true';
    const accountIdentityMigrationMode =
      this.config.get<string>('PUBLISHER_ACCOUNT_IDENTITY_MIGRATION_MODE') === 'true';
    if (accountIdentityMigrationMode) {
      if (this.config.get<string>('PUBLISHER_ENABLED') !== 'false') {
        throw new Error(
          'PUBLISHER_ENABLED=false is required in provider-account identity migration mode',
        );
      }
      if (workerEnabledValue !== 'false') {
        throw new Error(
          'PUBLISHER_SYNC_WORKER_ENABLED=false is required in provider-account identity migration mode',
        );
      }
      this.logger.warn(
        'Publisher delivery is disabled for the controlled provider-account identity migration window',
      );
      return;
    }
    if (!isBillingRuntime()) return;
    if (isProductionConfig(this.config)) {
      if (this.config.get<string>('PUBLISHER_ENABLED') !== 'true') {
        throw new Error('PUBLISHER_ENABLED=true is required by Billing in production');
      }
      if (!this.config.get<string>('PUBLISHER_BASE_URL')?.trim()) {
        throw new Error('PUBLISHER_BASE_URL is required by Billing in production');
      }
      const token = this.config.get<string>('PUBLISHER_BILLING_TOKEN')?.trim()
        || this.config.get<string>('PUBLISHER_TOKEN')?.trim();
      if (!token) {
        throw new Error('PUBLISHER_BILLING_TOKEN or PUBLISHER_TOKEN is required by Billing in production');
      }
      if (!workerEnabled) {
        throw new Error('PUBLISHER_SYNC_WORKER_ENABLED=true is required by Billing in production');
      }
    }
    if (!workerEnabled) return;
    const intervalMs = Number(this.config.get<string>('PUBLISHER_SYNC_WORKER_INTERVAL_MS') ?? 15_000);
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
        Number(this.config.get<string>('PUBLISHER_SYNC_WORKER_BATCH_SIZE') ?? 20),
      );
      if (result.processed > 0) {
        this.logger.log(
          `publisher sync retry processed=${result.processed} succeeded=${result.succeeded} failed=${result.failed}`,
        );
      }
    } catch (err) {
      publisherRetryWorkerTotal.labels('scan_failed').inc();
      this.logger.warn(
        `publisher sync retry scan failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      try {
        await this.syncJobs.refreshRetryBacklogMetrics();
      } catch (err) {
        // A metrics-only failure must not change retry processing semantics.
        this.logger.warn(
          `publisher retry metrics refresh failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      this.running = false;
    }
  }
}
