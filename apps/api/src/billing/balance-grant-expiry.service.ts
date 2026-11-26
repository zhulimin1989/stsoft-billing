import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { BillingService } from './billing.service';
import { isBillingRuntime } from '../common/runtime/service-role';

const BUSINESS_TIMEZONE_OFFSET_MINUTES = 8 * 60;
const DEFAULT_DAILY_RUN_MINUTE_OF_DAY = 5; // 00:05 in the business timezone.
const ONE_DAY_MS = 24 * 60 * 60 * 1000;
const ONE_MINUTE_MS = 60 * 1000;

@Injectable()
export class BalanceGrantExpiryService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BalanceGrantExpiryService.name);
  private interval: NodeJS.Timeout | null = null;
  private dailyTimer: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly billing: BillingService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (!isBillingRuntime()) {
      this.logger.log('Skip balance grant expiry worker outside billing runtime');
      return;
    }
    if (this.config.get<string>('BALANCE_GRANT_EXPIRY_WORKER_ENABLED') === 'false') {
      this.logger.log('Balance grant expiry worker disabled');
      return;
    }

    const intervalMs = this.positiveInt('BALANCE_GRANT_EXPIRY_INTERVAL_MS', 0);
    if (intervalMs > 0) {
      this.interval = setInterval(() => {
        void this.runOnce('interval');
      }, intervalMs);
      this.interval.unref?.();
      this.logger.log(`scheduled balance grant expiry worker intervalMs=${intervalMs}`);
    } else {
      this.scheduleNextDailyRun();
    }

    this.startupTimer = setTimeout(() => {
      void this.runOnce('startup');
    }, this.positiveInt('BALANCE_GRANT_EXPIRY_STARTUP_DELAY_MS', 30_000));
    this.startupTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.interval) {
      clearInterval(this.interval);
      this.interval = null;
    }
    if (this.dailyTimer) {
      clearTimeout(this.dailyTimer);
      this.dailyTimer = null;
    }
    if (this.startupTimer) {
      clearTimeout(this.startupTimer);
      this.startupTimer = null;
    }
  }

  async runOnce(trigger = 'manual'): Promise<void> {
    if (this.running) return;
    this.running = true;
    try {
      const result = await this.billing.sweepExpiredBalanceGrants(
        new Date(),
        this.positiveInt('BALANCE_GRANT_EXPIRY_BATCH_SIZE', 200),
      );
      if (result.scanned > 0 || result.failed > 0) {
        this.logger.log(
          `balance grant expiry done trigger=${trigger} scanned=${result.scanned} expired=${result.expired} `
          + `failed=${result.failed} nominalUsd=${result.totalExpiredUsd} `
          + `walletDebitUsd=${result.totalWalletDebitedUsd} unbackedUsd=${result.totalUnbackedUsd}`,
        );
      }
    } catch (err) {
      this.logger.error(
        `balance grant expiry run failed trigger=${trigger}: ${
          err instanceof Error ? err.stack ?? err.message : String(err)
        }`,
      );
    } finally {
      this.running = false;
    }
  }

  delayUntilNextDailyRun(now = new Date()): number {
    const runMinuteOfDay = this.dailyRunMinuteOfDay();
    const businessNowMs = now.getTime() + BUSINESS_TIMEZONE_OFFSET_MINUTES * ONE_MINUTE_MS;
    const businessDayStartMs = Math.floor(businessNowMs / ONE_DAY_MS) * ONE_DAY_MS;
    let businessRunAtMs = businessDayStartMs + runMinuteOfDay * ONE_MINUTE_MS;
    if (businessRunAtMs <= businessNowMs) {
      businessRunAtMs += ONE_DAY_MS;
    }
    return Math.max(1, businessRunAtMs - businessNowMs);
  }

  private scheduleNextDailyRun(): void {
    const now = new Date();
    const delayMs = this.delayUntilNextDailyRun(now);
    const nextRunAt = new Date(now.getTime() + delayMs);
    this.dailyTimer = setTimeout(() => {
      void this.runOnce('daily').finally(() => this.scheduleNextDailyRun());
    }, delayMs);
    this.dailyTimer.unref?.();
    this.logger.log(`scheduled balance grant expiry worker daily nextRunAt=${nextRunAt.toISOString()}`);
  }

  private dailyRunMinuteOfDay(): number {
    const hour = this.boundedInt(
      'BALANCE_GRANT_EXPIRY_DAILY_HOUR',
      Math.floor(DEFAULT_DAILY_RUN_MINUTE_OF_DAY / 60),
      0,
      23,
    );
    const minute = this.boundedInt(
      'BALANCE_GRANT_EXPIRY_DAILY_MINUTE',
      DEFAULT_DAILY_RUN_MINUTE_OF_DAY % 60,
      0,
      59,
    );
    return hour * 60 + minute;
  }

  private positiveInt(name: string, fallback: number): number {
    const value = Number(this.config.get<string>(name));
    return Number.isFinite(value) && value > 0 ? Math.trunc(value) : fallback;
  }

  private boundedInt(name: string, fallback: number, min: number, max: number): number {
    const value = Number(this.config.get<string>(name));
    if (!Number.isFinite(value)) return fallback;
    const intValue = Math.trunc(value);
    if (intValue < min || intValue > max) return fallback;
    return intValue;
  }
}
