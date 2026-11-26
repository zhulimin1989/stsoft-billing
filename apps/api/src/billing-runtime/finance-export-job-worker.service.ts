import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { BillingAdminService } from '../billing/billing.admin.service';
import { isBillingRuntime } from '../common/runtime/service-role';
import { RedisService } from '../redis/redis.service';

const LOCK_KEY = 'billing:finance-export-job-worker:lock';
const RELEASE_LOCK_LUA = `
if redis.call('get', KEYS[1]) == ARGV[1] then
  return redis.call('del', KEYS[1])
end
return 0
`;

@Injectable()
export class FinanceExportJobWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(FinanceExportJobWorkerService.name);
  private interval: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly billingAdmin: BillingAdminService,
    private readonly config: ConfigService,
    private readonly redis: RedisService,
  ) {}

  onModuleInit(): void {
    if (!isBillingRuntime()) {
      this.logger.log('Skip finance export worker outside billing runtime');
      return;
    }
    if (!this.enabled()) {
      this.logger.log('Finance export worker disabled');
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

    this.logger.log(`scheduled finance export worker intervalMs=${intervalMs}`);
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
    processed: number;
    succeeded: number;
    failed: number;
  }> {
    if (this.running) {
      return { skipped: true, processed: 0, succeeded: 0, failed: 0 };
    }

    this.running = true;
    const lockToken = randomUUID();
    if (!(await this.acquireLock(lockToken))) {
      this.running = false;
      return { skipped: true, processed: 0, succeeded: 0, failed: 0 };
    }

    try {
      try {
        const cleanup = await this.billingAdmin.cleanupExpiredFinanceReportExportJobs({
          batchSize: this.cleanupBatchSize(),
        });
        if (cleanup.cleaned > 0 || cleanup.failed > 0) {
          this.logger.log(
            `finance export cleanup done trigger=${trigger} cleaned=${cleanup.cleaned} failed=${cleanup.failed}`,
          );
        }
      } catch (error) {
        this.logger.warn(
          `finance export cleanup failed: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
      const result = await this.billingAdmin.processDueFinanceReportExportJobs({
        batchSize: this.batchSize(),
        minAgeMs: this.minAgeMs(),
      });
      if (result.processed > 0) {
        this.logger.log(
          `finance export jobs done trigger=${trigger} processed=${result.processed} succeeded=${result.succeeded} failed=${result.failed}`,
        );
      }
      return { skipped: false, ...result };
    } catch (error) {
      this.logger.warn(`finance export worker failed: ${error instanceof Error ? error.message : String(error)}`);
      return { skipped: false, processed: 0, succeeded: 0, failed: 0 };
    } finally {
      this.running = false;
      await this.releaseLock(lockToken);
    }
  }

  private async acquireLock(token: string): Promise<boolean> {
    try {
      const acquired = await this.redis.set(
        LOCK_KEY,
        token,
        'PX',
        this.lockTtlMs(),
        'NX',
      );
      return acquired === 'OK';
    } catch (error) {
      this.logger.warn(
        `finance export worker lock acquire failed: ${error instanceof Error ? error.message : String(error)}`,
      );
      return false;
    }
  }

  private async releaseLock(token: string): Promise<void> {
    try {
      await this.redis.eval(RELEASE_LOCK_LUA, 1, LOCK_KEY, token);
    } catch (error) {
      this.logger.warn(
        `finance export worker lock release failed: ${error instanceof Error ? error.message : String(error)}`,
      );
    }
  }

  private enabled(): boolean {
    return this.config.get<string>('FINANCE_EXPORT_JOB_WORKER_ENABLED') !== 'false';
  }

  private intervalMs(): number {
    const raw = Number(this.config.get<string>('FINANCE_EXPORT_JOB_WORKER_INTERVAL_MS') ?? '5000');
    return Number.isFinite(raw) && raw >= 1000 ? raw : 5000;
  }

  private startupDelayMs(): number {
    const raw = Number(this.config.get<string>('FINANCE_EXPORT_JOB_WORKER_STARTUP_DELAY_MS') ?? '5000');
    return Number.isFinite(raw) && raw >= 0 ? raw : 5000;
  }

  private minAgeMs(): number {
    const raw = Number(this.config.get<string>('FINANCE_EXPORT_JOB_MIN_AGE_MS') ?? '3000');
    return Number.isFinite(raw) && raw >= 0 ? raw : 3000;
  }

  private batchSize(): number {
    const raw = Number(this.config.get<string>('FINANCE_EXPORT_JOB_WORKER_BATCH_SIZE') ?? '1');
    return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 10) : 1;
  }

  private cleanupBatchSize(): number {
    const raw = Number(
      this.config.get<string>('FINANCE_EXPORT_JOB_CLEANUP_BATCH_SIZE') ?? '100',
    );
    return Number.isFinite(raw) && raw > 0 ? Math.min(Math.floor(raw), 1000) : 100;
  }

  private lockTtlMs(): number {
    const raw = Number(
      this.config.get<string>('FINANCE_EXPORT_JOB_WORKER_LOCK_TTL_MS') ?? '7200000',
    );
    return Number.isFinite(raw) && raw >= 60_000 ? Math.floor(raw) : 7_200_000;
  }
}
