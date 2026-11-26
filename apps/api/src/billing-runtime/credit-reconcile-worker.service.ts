import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { CREDIT_DEDUCT_INTENT_SCOPE, CreditService } from '../billing/credit.service';
import { isBillingRuntime } from '../common/runtime/service-role';
import { creditReconcileRunTotal } from '../metrics/metrics.registry';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

const RELEASE_LOCK_LUA = `
if redis.call('GET', KEYS[1]) == ARGV[1] then
  return redis.call('DEL', KEYS[1])
end
return 0
`;

export interface CreditReconcileSweepResult {
  trigger: string;
  skipped: boolean;
  scannedUsers: number;
  mismatchedUsers: number;
  fixedUsers: number;
  failedUsers: number;
  subscriptions: number;
  subscriptionMismatches: number;
  grantMismatches: number;
  staleDeductIntents: number;
  staleDeductIntentFailures: number;
}

@Injectable()
export class CreditReconcileWorkerService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(CreditReconcileWorkerService.name);
  private readonly lockKey = 'billing:credit-reconcile:lock';
  private interval: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    private readonly creditService: CreditService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (!isBillingRuntime()) {
      this.logger.log('Skip credit reconcile worker outside billing runtime');
      return;
    }
    if (!this.enabled()) {
      this.logger.log('Credit reconcile worker disabled');
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

    this.logger.log(`scheduled credit reconcile worker intervalMs=${intervalMs}`);
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

  async runOnce(
    trigger = 'manual',
    opts: { fix?: boolean; maxUsers?: number; concurrency?: number } = {},
  ): Promise<CreditReconcileSweepResult> {
    const empty = (): CreditReconcileSweepResult => ({
      trigger,
      skipped: false,
      scannedUsers: 0,
      mismatchedUsers: 0,
      fixedUsers: 0,
      failedUsers: 0,
      subscriptions: 0,
      subscriptionMismatches: 0,
      grantMismatches: 0,
      staleDeductIntents: 0,
      staleDeductIntentFailures: 0,
    });

    if (this.running) {
      creditReconcileRunTotal.labels('skipped').inc();
      return { ...empty(), skipped: true };
    }

    const token = randomUUID();
    const locked = await this.acquireLock(token);
    if (!locked) {
      creditReconcileRunTotal.labels('skipped').inc();
      return { ...empty(), skipped: true };
    }

    this.running = true;
    const result = empty();
    const fix = opts.fix ?? this.fixEnabled();
    try {
      const userIds = await this.findCandidateUserIds(opts.maxUsers ?? this.maxUsers());
      result.scannedUsers = userIds.length;

      await this.forEachLimited(userIds, opts.concurrency ?? this.concurrency(), async (userId) => {
        try {
          const userResult = await this.creditService.reconcileUserCreditCache(userId, {
            fix,
          });
          result.subscriptions += userResult.subscriptions.length;
          result.subscriptionMismatches += userResult.subscriptions.filter((s) => s.mismatched).length;
          if (userResult.grant.mismatched) {
            result.grantMismatches += 1;
          }
          if (userResult.mismatched) {
            result.mismatchedUsers += 1;
          }
          if (userResult.fixed) {
            result.fixedUsers += 1;
          }
        } catch (err) {
          result.failedUsers += 1;
          this.logger.error(
            `credit reconcile failed user=${userId}: ${
              err instanceof Error ? err.stack ?? err.message : String(err)
            }`,
          );
        }
      });

      const intentResult = await this.reconcileStaleDeductIntents({
        fix,
      });
      result.staleDeductIntents = intentResult.scanned;
      result.staleDeductIntentFailures = intentResult.failed;

      const hasFailures = result.failedUsers > 0 || result.staleDeductIntentFailures > 0;
      creditReconcileRunTotal.labels(hasFailures ? 'error' : 'ok').inc();
      this.logger.log(
        `credit reconcile done trigger=${trigger} fix=${fix} users=${result.scannedUsers} mismatched=${result.mismatchedUsers} fixed=${result.fixedUsers} failed=${result.failedUsers} staleIntents=${result.staleDeductIntents} staleIntentFailures=${result.staleDeductIntentFailures}`,
      );
      return result;
    } catch (err) {
      creditReconcileRunTotal.labels('error').inc();
      this.logger.error(
        `credit reconcile run failed trigger=${trigger}: ${
          err instanceof Error ? err.stack ?? err.message : String(err)
        }`,
      );
      return result;
    } finally {
      this.running = false;
      await this.releaseLock(token);
    }
  }

  private async reconcileStaleDeductIntents(opts: {
    fix: boolean;
  }): Promise<{ scanned: number; failed: number }> {
    const staleBefore = new Date(Date.now() - this.deductIntentStaleMs());
    const rows = await this.prisma.idempotencyKey.findMany({
      where: {
        scope: CREDIT_DEDUCT_INTENT_SCOPE,
        status: { in: ['PENDING', 'REDIS_DEBITED', 'RECONCILE_REQUIRED'] },
        createdAt: { lt: staleBefore },
      },
      orderBy: { createdAt: 'asc' },
      take: this.deductIntentMax(),
    });

    let failed = 0;
    for (const row of rows) {
      const payload = this.intentPayload(row.result);
      const userId = this.stringPayload(payload, 'userId');
      const subscriptionId = this.stringPayload(payload, 'subscriptionId');
      try {
        if (!userId || !subscriptionId) {
          throw new Error('stale credit deduct intent missing userId/subscriptionId');
        }
        await Promise.all([
          this.creditService.reconcileSubscriptionCache(subscriptionId, userId, { fix: opts.fix }),
          this.creditService.reconcileGrantPool(userId, { fix: opts.fix }),
        ]);
        if (opts.fix) {
          await this.prisma.idempotencyKey.update({
            where: {
              key_scope: {
                key: row.key,
                scope: CREDIT_DEDUCT_INTENT_SCOPE,
              },
            },
            data: {
              status: 'FAILED',
              result: {
                ...payload,
                status: 'FAILED',
                reconciledAt: new Date().toISOString(),
                reconcileReason: 'stale_credit_deduct_intent',
              } as Prisma.InputJsonObject,
            },
          });
        }
      } catch (err) {
        failed += 1;
        this.logger.error(
          `stale credit deduct intent reconcile failed key=${row.key}: ${
            err instanceof Error ? err.stack ?? err.message : String(err)
          }`,
        );
      }
    }

    return { scanned: rows.length, failed };
  }

  private intentPayload(value: Prisma.JsonValue): Record<string, Prisma.JsonValue> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as Record<string, Prisma.JsonValue>;
  }

  private stringPayload(payload: Record<string, Prisma.JsonValue>, key: string): string | null {
    const value = payload[key];
    return typeof value === 'string' && value.trim() ? value : null;
  }

  private async findCandidateUserIds(maxUsers: number): Promise<string[]> {
    const now = new Date();
    const activeGrantWhere: Prisma.GrantRedemptionWhereInput = {
      isExpired: false,
      isUsedUp: false,
      OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
    };

    const [balanceUsers, grantUsers] = await Promise.all([
      this.prisma.creditBalanceState.findMany({
        select: { userId: true },
        orderBy: { userId: 'asc' },
        distinct: ['userId'],
        take: maxUsers,
      }),
      this.prisma.grantRedemption.findMany({
        where: activeGrantWhere,
        select: { userId: true },
        distinct: ['userId'],
        orderBy: { userId: 'asc' },
        take: maxUsers,
      }),
    ]);

    const ids = new Set<string>();
    const total = Math.max(balanceUsers.length, grantUsers.length);
    for (let i = 0; i < total; i += 1) {
      const balanceUserId = balanceUsers[i]?.userId;
      if (balanceUserId) ids.add(balanceUserId);
      if (ids.size >= maxUsers) return [...ids];

      const grantUserId = grantUsers[i]?.userId;
      if (grantUserId) ids.add(grantUserId);
      if (ids.size >= maxUsers) return [...ids];
    }
    return [...ids];
  }

  private async acquireLock(token: string): Promise<boolean> {
    try {
      const result = await this.redis.set(this.lockKey, token, 'PX', this.lockMs(), 'NX');
      return result === 'OK';
    } catch (err) {
      this.logger.error(
        `credit reconcile lock failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  private async releaseLock(token: string): Promise<void> {
    try {
      await this.redis.eval(RELEASE_LOCK_LUA, 1, this.lockKey, token);
    } catch (err) {
      this.logger.warn(
        `credit reconcile lock release failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async forEachLimited<T>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<void>,
  ): Promise<void> {
    let index = 0;
    const workers = Array.from(
      { length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) },
      async () => {
        while (index < items.length) {
          const item = items[index++];
          await fn(item);
        }
      },
    );
    await Promise.all(workers);
  }

  private enabled(): boolean {
    return this.config.get<string>('BILLING_CREDIT_RECONCILE_ENABLED', 'true') !== 'false';
  }

  private fixEnabled(): boolean {
    return this.config.get<string>('BILLING_CREDIT_RECONCILE_FIX', 'false') === 'true';
  }

  private intervalMs(): number {
    return Math.max(
      60_000,
      this.numberConfig('BILLING_CREDIT_RECONCILE_INTERVAL_MS', 3_600_000),
    );
  }

  private startupDelayMs(): number {
    return Math.max(
      0,
      this.numberConfig('BILLING_CREDIT_RECONCILE_STARTUP_DELAY_MS', 60_000),
    );
  }

  private lockMs(): number {
    return Math.max(
      60_000,
      this.numberConfig('BILLING_CREDIT_RECONCILE_LOCK_MS', 55 * 60_000),
    );
  }

  private maxUsers(): number {
    return Math.max(1, this.numberConfig('BILLING_CREDIT_RECONCILE_MAX_USERS', 10_000));
  }

  private concurrency(): number {
    return Math.max(1, this.numberConfig('BILLING_CREDIT_RECONCILE_CONCURRENCY', 5));
  }

  private deductIntentStaleMs(): number {
    return Math.max(
      10_000,
      this.numberConfig('BILLING_CREDIT_DEDUCT_INTENT_STALE_MS', 60_000),
    );
  }

  private deductIntentMax(): number {
    return Math.max(1, this.numberConfig('BILLING_CREDIT_DEDUCT_INTENT_MAX', 500));
  }

  private numberConfig(key: string, fallback: number): number {
    const value = this.config.get<string | number>(key, fallback);
    const parsed = typeof value === 'number' ? value : Number.parseInt(String(value), 10);
    return Number.isFinite(parsed) ? parsed : fallback;
  }
}
