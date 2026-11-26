import { Injectable, Logger, OnApplicationBootstrap } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PublisherSyncService } from './publisher-sync.service';

@Injectable()
export class PublisherKeyBalanceBootstrapService implements OnApplicationBootstrap {
  private readonly logger = new Logger(PublisherKeyBalanceBootstrapService.name);
  private started = false;

  constructor(
    private readonly config: ConfigService,
    private readonly publisherSync: PublisherSyncService,
  ) {}

  onApplicationBootstrap(): void {
    if (!this.enabled()) return;
    if (this.config.get<string>('PUBLISHER_ENABLED') === 'false') {
      this.logger.log('publisher key-balance bootstrap skipped because PUBLISHER_ENABLED=false');
      return;
    }
    const delayMs = this.positiveInt('PUBLISHER_KEY_BALANCE_BOOTSTRAP_DELAY_MS', 2_000);
    const timer = setTimeout(() => {
      void this.run();
    }, delayMs);
    timer.unref?.();
  }

  async run(): Promise<void> {
    if (this.started) return;
    this.started = true;
    const limit = this.positiveInt('PUBLISHER_KEY_BALANCE_BOOTSTRAP_LIMIT', 5_000);
    try {
      const keyBalances = await this.publisherSync.syncAllKeyBalances(limit, {
        replayRunId: `key-balance-bootstrap-${Date.now()}`,
      });
      this.logger.log(`publisher key-balance bootstrap enqueued keyBalances=${keyBalances}`);
    } catch (err) {
      this.started = false;
      this.logger.warn(
        `publisher key-balance bootstrap failed: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private enabled(): boolean {
    const raw = this.config.get<string | boolean>('PUBLISHER_KEY_BALANCE_BOOTSTRAP_ON_START');
    if (raw === undefined || raw === null || raw === '') return false;
    if (typeof raw === 'boolean') return raw;
    return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
  }

  private positiveInt(key: string, fallback: number): number {
    const raw = this.config.get<string | number>(key);
    const parsed = Number(raw);
    return Number.isFinite(parsed) && parsed > 0 ? Math.floor(parsed) : fallback;
  }
}
