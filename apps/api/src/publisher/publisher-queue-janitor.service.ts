import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { isBillingRuntime } from '../common/runtime/service-role';
import { PrismaService } from '../prisma/prisma.service';
import {
  publisherQueueJanitorBacklog,
  publisherQueueJanitorDeletedTotal,
  publisherQueueJanitorTotal,
} from '../metrics/metrics.registry';

/**
 * Statuses that can never be picked up again.
 *
 * `PENDING` and `FAILED` are what the retry worker claims, `PROCESSING` may be
 * a live or recoverable lease, `ACCEPTED` is a required dispatch still awaiting
 * its receipt, and `DISABLED` is the durable evidence that a publish was
 * dropped while Publisher delivery was switched off -- none of them are
 * retention candidates.
 */
const PUBLISHER_SYNC_JOB_TERMINAL_STATUSES = [
  'SUCCEEDED',
  'SUPERSEDED',
  'DEDICATED_KEY_META_V1_RETIRED',
] as const;

/** The projection outbox only ever retires rows as SUCCEEDED. */
const RESTRICTION_PROJECTION_TERMINAL_STATUSES = ['SUCCEEDED'] as const;

type JanitorTable = 'publisher_sync_jobs' | 'billing_restriction_projection_intents';

export type PublisherQueueJanitorSweepResult = {
  trigger: string;
  skipped: boolean;
  deleted: Record<JanitorTable, number>;
};

/**
 * Bounded retention for the two Publisher-side queue tables.
 *
 * Both are append-only in practice: every row reaches a terminal status and
 * nothing ever removed it, so `publisher_sync_jobs` reached 1.68M rows / 1.29GB
 * overseas and 824k rows / 611MB domestically -- inside the billing transaction
 * database, not an events store. The projection outbox grows at two rows per
 * guarded request, so it needs the same bound even though it is small today.
 *
 * Deletes are batched, capped per sweep, and serialised across replicas by a
 * transaction-scoped advisory lock. The cap is deliberate: a janitor that can
 * only ever remove a bounded number of rows per sweep cannot turn a
 * misconfigured retention window into an unbounded production delete.
 */
@Injectable()
export class PublisherQueueJanitorService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(PublisherQueueJanitorService.name);
  private interval: NodeJS.Timeout | null = null;
  private running = false;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  onModuleInit(): void {
    if (!isBillingRuntime()) return;
    if (!this.enabled()) {
      this.logger.warn('publisher queue janitor disabled; queue tables will grow unbounded');
      return;
    }
    this.interval = setInterval(() => {
      void this.runOnce('interval').catch((err) => {
        this.logger.warn(
          `publisher queue janitor sweep failed: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, this.intervalMs());
    this.interval.unref?.();
  }

  onModuleDestroy(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  async runOnce(trigger = 'manual'): Promise<PublisherQueueJanitorSweepResult> {
    const result: PublisherQueueJanitorSweepResult = {
      trigger,
      skipped: false,
      deleted: {
        publisher_sync_jobs: 0,
        billing_restriction_projection_intents: 0,
      },
    };
    if (this.running) {
      result.skipped = true;
      return result;
    }
    this.running = true;
    try {
      result.deleted.publisher_sync_jobs = await this.sweepTable(
        'publisher_sync_jobs',
        this.jobRetentionDays(),
        PUBLISHER_SYNC_JOB_TERMINAL_STATUSES as unknown as string[],
      );
      result.deleted.billing_restriction_projection_intents = await this.sweepTable(
        'billing_restriction_projection_intents',
        this.intentRetentionDays(),
        RESTRICTION_PROJECTION_TERMINAL_STATUSES as unknown as string[],
      );
      const total = result.deleted.publisher_sync_jobs
        + result.deleted.billing_restriction_projection_intents;
      if (total > 0) {
        this.logger.log(
          `publisher queue janitor removed jobs=${result.deleted.publisher_sync_jobs} `
          + `intents=${result.deleted.billing_restriction_projection_intents}`,
        );
      }
      publisherQueueJanitorTotal.labels('swept').inc();
      return result;
    } catch (err) {
      publisherQueueJanitorTotal.labels('failed').inc();
      throw err;
    } finally {
      try {
        await this.refreshBacklogMetrics();
      } catch (err) {
        // A metrics-only failure must not mask a completed sweep.
        this.logger.warn(
          `publisher queue janitor backlog refresh failed: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      this.running = false;
    }
  }

  /**
   * Delete in bounded batches, each inside its own transaction so a long sweep
   * never holds one. `pg_try_advisory_xact_lock` makes a second replica end its
   * sweep instead of queueing behind this one.
   */
  private async sweepTable(
    table: JanitorTable,
    retentionDays: number,
    terminalStatuses: string[],
  ): Promise<number> {
    const cutoff = new Date(Date.now() - retentionDays * 24 * 60 * 60 * 1000);
    const batchSize = this.batchSize();
    const maxBatches = this.maxBatches();
    let deleted = 0;

    for (let batch = 0; batch < maxBatches; batch += 1) {
      const removed = await this.prisma.$transaction(async (tx) => {
        const [lock] = await tx.$queryRaw<Array<{ acquired: boolean }>>`
          SELECT pg_try_advisory_xact_lock(hashtext(${`publisher-queue-janitor:${table}`}))
            AS "acquired"
        `;
        if (!lock?.acquired) return -1;
        return tx.$executeRaw(
          Prisma.sql`
            DELETE FROM ${Prisma.raw(`"${table}"`)}
            WHERE "id" IN (
              SELECT "id" FROM ${Prisma.raw(`"${table}"`)}
              WHERE "status" = ANY(${terminalStatuses})
                AND "created_at" < ${cutoff}
              ORDER BY "created_at"
              LIMIT ${batchSize}
            )
          `,
        );
      });

      if (removed < 0) {
        this.logger.debug?.(`publisher queue janitor skipped ${table}; another replica holds it`);
        return deleted;
      }
      deleted += removed;
      publisherQueueJanitorDeletedTotal.labels(table).inc(removed);
      if (removed < batchSize) return deleted;
    }

    // Hitting the cap is normal on the first sweeps after deployment; it is
    // logged so a permanently capped sweep is visible instead of looking done.
    this.logger.warn(
      `publisher queue janitor hit the per-sweep cap for ${table} `
      + `(${maxBatches} x ${batchSize}); more rows remain eligible`,
    );
    return deleted;
  }

  private async refreshBacklogMetrics(): Promise<void> {
    const jobCutoff = new Date(Date.now() - this.jobRetentionDays() * 24 * 60 * 60 * 1000);
    const intentCutoff = new Date(Date.now() - this.intentRetentionDays() * 24 * 60 * 60 * 1000);
    const [jobs, intents] = await Promise.all([
      this.prisma.publisherSyncJob.count({
        where: {
          status: { in: PUBLISHER_SYNC_JOB_TERMINAL_STATUSES as unknown as string[] },
          createdAt: { lt: jobCutoff },
        },
      }),
      this.prisma.billingRestrictionProjectionIntent.count({
        where: {
          status: { in: RESTRICTION_PROJECTION_TERMINAL_STATUSES as unknown as string[] },
          createdAt: { lt: intentCutoff },
        },
      }),
    ]);
    publisherQueueJanitorBacklog.labels('publisher_sync_jobs').set(jobs);
    publisherQueueJanitorBacklog.labels('billing_restriction_projection_intents').set(intents);
  }

  private enabled(): boolean {
    return this.bool('PUBLISHER_QUEUE_JANITOR_ENABLED', true);
  }

  private intervalMs(): number {
    return this.positiveInt('PUBLISHER_QUEUE_JANITOR_INTERVAL_MS', 3_600_000, 300_000);
  }

  private batchSize(): number {
    return this.positiveInt('PUBLISHER_QUEUE_JANITOR_BATCH_SIZE', 5_000, 100);
  }

  private maxBatches(): number {
    return this.positiveInt('PUBLISHER_QUEUE_JANITOR_MAX_BATCHES', 20, 1);
  }

  private jobRetentionDays(): number {
    return this.positiveInt('PUBLISHER_SYNC_JOB_RETENTION_DAYS', 14, 1);
  }

  private intentRetentionDays(): number {
    return this.positiveInt('BILLING_RESTRICTION_PROJECTION_INTENT_RETENTION_DAYS', 14, 1);
  }

  private positiveInt(key: string, fallback: number, minimum: number): number {
    const raw = this.config?.get<string>(key);
    const parsed = Number.parseInt(raw ?? '', 10);
    return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
  }

  private bool(key: string, fallback: boolean): boolean {
    const raw = this.config?.get<string>(key);
    if (raw == null || raw.trim() === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
  }
}
