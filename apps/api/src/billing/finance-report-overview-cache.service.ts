import { Injectable, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { randomUUID } from 'crypto';
import { setTimeout as delay } from 'timers/promises';
import { RedisService } from '../redis/redis.service';

const DEFAULT_CACHE_TTL_SECONDS = 30;
const DEFAULT_COMPUTATION_TIMEOUT_MS = 25_000;
const DEFAULT_LOCK_GRACE_MS = 5_000;
const DEFAULT_WAIT_INTERVAL_MS = 125;
const CACHE_KEY_VERSION = 'v1';

type CacheEnvelope<T> = {
  storedAtMs: number;
  value: T;
};

type CacheLookup<T> = {
  storedAtMs: number;
  value: T;
};

export type FinanceOverviewCacheScope = {
  month: string;
  billingMode: string;
};

function positiveInteger(
  value: string | undefined,
  fallback: number,
  min: number,
  max: number,
): number {
  const parsed = Number.parseInt(value || '', 10);
  return Number.isFinite(parsed) && parsed >= min && parsed <= max
    ? parsed
    : fallback;
}

@Injectable()
export class FinanceReportOverviewCacheService {
  private readonly logger = new Logger(FinanceReportOverviewCacheService.name);
  private readonly cacheTtlSeconds: number;
  private readonly overviewComputationTimeoutMs: number;
  private readonly lockTtlMs: number;
  private readonly waitTimeoutMs: number;
  private readonly inFlight = new Map<string, Promise<unknown>>();

  constructor(
    config: ConfigService,
    @Optional() private readonly redis?: RedisService,
  ) {
    this.cacheTtlSeconds = positiveInteger(
      config.get<string>('FINANCE_REPORT_OVERVIEW_CACHE_TTL_SECONDS'),
      DEFAULT_CACHE_TTL_SECONDS,
      1,
      3_600,
    );
    this.overviewComputationTimeoutMs = positiveInteger(
      config.get<string>('FINANCE_REPORT_OVERVIEW_COMPUTATION_TIMEOUT_MS'),
      DEFAULT_COMPUTATION_TIMEOUT_MS,
      5_000,
      60_000,
    );
    this.lockTtlMs = this.overviewComputationTimeoutMs + DEFAULT_LOCK_GRACE_MS;
    this.waitTimeoutMs = this.overviewComputationTimeoutMs;
  }

  get computationTimeoutMs(): number {
    return this.overviewComputationTimeoutMs;
  }

  async getOrCompute<T>(
    scope: FinanceOverviewCacheScope,
    compute: () => Promise<T>,
    options: { refresh?: boolean } = {},
  ): Promise<T> {
    const cacheKey = this.cacheKey(scope);
    const baseline = await this.tryReadCache<T>(cacheKey);
    if (!options.refresh && baseline) return baseline.value;

    const existing = this.inFlight.get(cacheKey) as Promise<T> | undefined;
    if (existing) return existing;

    const operation = this.computeWithSharedLock(
      cacheKey,
      baseline?.storedAtMs ?? 0,
      compute,
    );
    this.inFlight.set(cacheKey, operation);
    try {
      return await operation;
    } finally {
      if (this.inFlight.get(cacheKey) === operation) {
        this.inFlight.delete(cacheKey);
      }
    }
  }

  private async computeWithSharedLock<T>(
    cacheKey: string,
    baselineStoredAtMs: number,
    compute: () => Promise<T>,
  ): Promise<T> {
    if (!this.redis) return compute();

    const lockKey = `${cacheKey}:lock`;
    const lockToken = randomUUID();
    let acquired = false;
    try {
      acquired = await this.redis.set(
        lockKey,
        lockToken,
        'PX',
        this.lockTtlMs,
        'NX',
      ) === 'OK';
    } catch (error) {
      this.logger.warn(`finance overview cache lock unavailable: ${this.errorMessage(error)}`);
      return compute();
    }

    if (!acquired) {
      const sharedResult = await this.waitForNewCacheValue<T>(cacheKey, baselineStoredAtMs);
      if (sharedResult) return sharedResult.value;
      this.logger.warn(`finance overview cache lock wait expired key=${cacheKey}`);
      return this.computeAndCache(cacheKey, compute);
    }

    try {
      return await this.computeAndCache(cacheKey, compute);
    } finally {
      await this.releaseLock(lockKey, lockToken);
    }
  }

  private async computeAndCache<T>(cacheKey: string, compute: () => Promise<T>): Promise<T> {
    const value = await compute();
    if (!this.redis) return value;

    const envelope: CacheEnvelope<T> = {
      storedAtMs: Date.now(),
      value,
    };
    try {
      await this.redis.set(
        cacheKey,
        JSON.stringify(envelope),
        'EX',
        this.cacheTtlSeconds,
      );
    } catch (error) {
      this.logger.warn(`finance overview cache write failed: ${this.errorMessage(error)}`);
    }
    return value;
  }

  private async waitForNewCacheValue<T>(
    cacheKey: string,
    baselineStoredAtMs: number,
  ): Promise<CacheLookup<T> | null> {
    const deadline = Date.now() + this.waitTimeoutMs;
    while (Date.now() < deadline) {
      await delay(DEFAULT_WAIT_INTERVAL_MS);
      const cached = await this.tryReadCache<T>(cacheKey);
      if (cached && cached.storedAtMs > baselineStoredAtMs) return cached;
    }
    return null;
  }

  private async tryReadCache<T>(cacheKey: string): Promise<CacheLookup<T> | null> {
    if (!this.redis) return null;
    let raw: string | null;
    try {
      raw = await this.redis.get(cacheKey);
    } catch (error) {
      this.logger.warn(`finance overview cache read failed: ${this.errorMessage(error)}`);
      return null;
    }
    if (!raw) return null;

    try {
      const parsed = JSON.parse(raw) as Partial<CacheEnvelope<T>>;
      if (!Number.isFinite(parsed.storedAtMs) || parsed.value === undefined) {
        throw new Error('invalid cache envelope');
      }
      return {
        storedAtMs: Number(parsed.storedAtMs),
        value: parsed.value,
      };
    } catch (error) {
      this.logger.warn(`finance overview cache payload ignored: ${this.errorMessage(error)}`);
      void this.redis.del(cacheKey).catch(() => undefined);
      return null;
    }
  }

  private async releaseLock(lockKey: string, lockToken: string): Promise<void> {
    if (!this.redis) return;
    try {
      await this.redis.eval(
        "if redis.call('get', KEYS[1]) == ARGV[1] then return redis.call('del', KEYS[1]) else return 0 end",
        1,
        lockKey,
        lockToken,
      );
    } catch (error) {
      this.logger.warn(`finance overview cache lock release failed: ${this.errorMessage(error)}`);
    }
  }

  private cacheKey(scope: FinanceOverviewCacheScope): string {
    return `finance-report:overview:${CACHE_KEY_VERSION}:${scope.month}:${scope.billingMode}`;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }
}
