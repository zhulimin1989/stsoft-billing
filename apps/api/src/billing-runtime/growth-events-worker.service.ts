import {
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { GrowthEventsService } from '../growth-events/growth-events.service';

@Injectable()
export class GrowthEventsWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(GrowthEventsWorkerService.name);
  private interval?: ReturnType<typeof setInterval>;
  private running = false;

  constructor(
    private readonly growthEvents: GrowthEventsService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (!this.enabled()) {
      this.logger.log('Growth events worker disabled');
      return;
    }
    const intervalMs = Math.max(
      this.positiveInt('GROWTH_EVENTS_WORKER_INTERVAL_MS', 30_000),
      5_000,
    );
    this.interval = setInterval(() => void this.tick(), intervalMs);
    this.interval.unref?.();
    setTimeout(() => void this.tick(), 2_000).unref?.();
  }

  onModuleDestroy(): void {
    if (this.interval) clearInterval(this.interval);
  }

  async tick(): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const reconciled = await this.growthEvents.reconcileRecentFacts();
      const delivery = await this.growthEvents.deliverPending();
      if (delivery.delivered > 0 || delivery.failed > 0) {
        this.logger.log(
          `Growth event delivery scanned=${delivery.scanned} delivered=${delivery.delivered} failed=${delivery.failed} usageFacts=${reconciled.usageScanned} orderFacts=${reconciled.ordersScanned}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `Growth events worker failed: ${err instanceof Error ? err.stack ?? err.message : String(err)}`,
      );
    } finally {
      this.running = false;
    }
  }

  private enabled(): boolean {
    const raw = this.config.get<string>('GROWTH_EVENTS_WORKER_ENABLED');
    if (raw === undefined || raw === '') {
      return this.config.get<string>('NODE_ENV') !== 'test';
    }
    return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
  }

  private positiveInt(key: string, fallback: number): number {
    const parsed = Number.parseInt(this.config.get<string>(key) ?? '', 10);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
  }
}
