import { Injectable, Logger, OnModuleDestroy, OnModuleInit } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { isBillingRuntime } from '../common/runtime/service-role';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import {
  billingHistoryTableRows,
  billingHistoryHotAccountRows,
  billingUnsettledDebtRows,
  billingHistoryGrowthWatchDurationMs,
  billingOverdueUnmarkedGrants,
  billingWorkerGateBacklog,
  billingWorkerGateOldestAgeSeconds,
  enterprisePrepaidBalanceAmount,
  enterprisePrepaidBalanceSampleTimestampSeconds,
  enterprisePrepaidBalanceWatchSuccessTimestampSeconds,
  enterprisePrepaidConsumption7dAmount,
} from '../metrics/metrics.registry';

const LOCK_KEY = 'billing:history-growth-watch:lock';

/**
 * Fraction of the interval the lock is held for.
 *
 * The lock is deliberately NOT released when a sample finishes: it is a
 * fleet-wide rate limiter ("sample at most once per interval"), not a mutex
 * ("do not sample concurrently"). Releasing it on completion looks correct and
 * is not — verified on nprod 2026-08-31, where a released-on-completion lock let
 * both replicas sample the same tick 20s apart (190ms and 42ms), because each
 * pod's timer fires independently and the lock was free again within
 * milliseconds. At 12 KEDA replicas that is 12x the intended query load.
 *
 * Held slightly under one interval so timer drift cannot make the lock outlive
 * the next tick and starve sampling entirely.
 */
const LOCK_TTL_RATIO = 0.9;

/** Accounts named in the log line, ordered by row count. Not a Prometheus label. */
const TOP_N = 5;

/**
 * Per-event history tables with no cold/hot separation. Each row here is a
 * table whose size directly drives per-event settlement cost, because the
 * settlement path aggregates or scans the account's whole history in it.
 */
const WATCHED_TABLES = [
  {
    table: 'balance_consumption_allocations',
    // Read by readReconciledBalanceLedgerSnapshot's four per-account
    // aggregates, on both the reserveFunding and settleUsage paths.
    reason: 'ledger conservation aggregates',
  },
  {
    table: 'gateway_usage_funding_reservations',
    // The account-wide FOR UPDATE lock narrowed on 2026-08-28 reads this.
    reason: 'reservation account lock',
  },
  {
    table: 'gateway_usage_settlement_anchors',
    // The blockingReceipts anti-join scans this exhaustively when no blocker
    // exists, which is the normal case.
    reason: 'FIFO head anti-join',
  },
] as const;

export interface HistoryGrowthSample {
  trigger: string;
  skipped: boolean;
  durationMs: number;
  tables: Array<{
    table: string;
    totalRows: number;
    hotAccountId: string | null;
    hotAccountRows: number;
  }>;
  unsettledDebt: {
    /** Accounts with at least one unsettled ENTERPRISE_CREDIT allocation. */
    accounts: number;
    maxRows: number;
    maxAccountId: string | null;
    top: Array<{ billingAccountId: string; rows: number }>;
  } | null;
  overdueGrants: {
    /** Past expires_at but is_expired still false. */
    unmarked: number;
    /** Of those, the ones that still hold money — see sampleOverdueGrants(). */
    unmarkedWithBalance: number;
  } | null;
  workerGates: Array<{
    worker: string;
    status: string;
    rows: number;
    oldestAgeSeconds: number;
  }>;
  enterprisePrepaidBalances: Array<{
    billingAccountId: string;
    accountName: string;
    currency: string;
    balanceAmount: number;
    consumption7dAmount: number;
  }>;
}

/**
 * Periodically records how large the per-event history tables have grown, and
 * how many unsettled enterprise-credit debt rows the worst account carries.
 *
 * Why this exists rather than an ad-hoc query: three separate incidents on this
 * path were all driven by "cost proportional to one account's lifetime history"
 * (the reservation account lock, the FIFO anti-join, and the row-by-row debt
 * settlement that overran a 60s transaction budget). Each was found by hand,
 * after it hurt. The row counts that predict the next one were never collected,
 * so there is no way to see one coming — the debt-settlement ceiling in
 * particular is documented as "act when the worst account approaches 250k rows"
 * with nothing measuring that number.
 *
 * Design constraints, both learned from a prior worker on this codebase that
 * became the single largest source of slow queries:
 *
 *  - **One sample per interval, fleet-wide.** A Redis NX lock held for (most of)
 *    one interval and never released early. billing-api runs 2-12 replicas under
 *    KEDA, so an unguarded worker multiplies its own DB load by the replica
 *    count exactly when the cluster is already behind. Note this is a rate
 *    limiter, not a mutex — see LOCK_TTL_RATIO for why releasing on completion
 *    silently fails to achieve it.
 *  - **Its own cost is measured.** The sweep reports its duration, so if these
 *    aggregates ever become expensive that shows up here instead of having to
 *    be inferred from the slow log.
 *
 * Account identifiers go into the log line, never into a Prometheus label:
 * account count is unbounded and would blow up series cardinality. The gauges
 * carry only the maximum and the table name.
 */
@Injectable()
export class HistoryGrowthWatchService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(HistoryGrowthWatchService.name);

  private interval: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
  ) {}

  onModuleInit(): void {
    if (!isBillingRuntime()) {
      this.logger.log('Skip history growth watch outside billing runtime');
      return;
    }
    if (!this.enabled()) {
      this.logger.log('History growth watch disabled');
      return;
    }
    const intervalMs = this.intervalMs();
    this.interval = setInterval(() => {
      void this.runOnce('interval');
    }, intervalMs);
    this.interval.unref?.();
    this.logger.log(`History growth watch started intervalMs=${intervalMs}`);
  }

  onModuleDestroy(): void {
    if (this.interval) clearInterval(this.interval);
    this.interval = null;
  }

  async runOnce(trigger: string): Promise<HistoryGrowthSample> {
    const token = randomUUID();
    const startedAt = process.hrtime.bigint();
    const elapsedMs = (): number => Number(process.hrtime.bigint() - startedAt) / 1e6;
    if (!(await this.acquireLock(token))) {
      return {
        trigger, skipped: true, durationMs: 0, tables: [], unsettledDebt: null,
        overdueGrants: null, workerGates: [], enterprisePrepaidBalances: [],
      };
    }
    try {
      const tables: HistoryGrowthSample['tables'] = [];
      for (const watched of WATCHED_TABLES) {
        tables.push(await this.sampleTable(watched.table));
      }
      const unsettledDebt = await this.sampleUnsettledDebt();
      const overdueGrants = await this.sampleOverdueGrants();
      const workerGates = await this.sampleWorkerGates();
      const enterprisePrepaidBalances = await this.sampleEnterprisePrepaidBalances();
      const durationMs = elapsedMs();

      for (const t of tables) {
        billingHistoryTableRows.set({ table: t.table }, t.totalRows);
        billingHistoryHotAccountRows.set({ table: t.table }, t.hotAccountRows);
      }
      if (unsettledDebt) {
        billingUnsettledDebtRows.set({ source: 'ENTERPRISE_CREDIT' }, unsettledDebt.maxRows);
      }
      if (overdueGrants) {
        billingOverdueUnmarkedGrants.set({ scope: 'all' }, overdueGrants.unmarked);
        billingOverdueUnmarkedGrants.set(
          { scope: 'with_balance' },
          overdueGrants.unmarkedWithBalance,
        );
      }
      billingWorkerGateBacklog.reset();
      billingWorkerGateOldestAgeSeconds.reset();
      const oldestByWorker = new Map<string, number>();
      for (const gate of workerGates) {
        billingWorkerGateBacklog.set(
          { worker: gate.worker, status: gate.status },
          gate.rows,
        );
        oldestByWorker.set(
          gate.worker,
          Math.max(oldestByWorker.get(gate.worker) ?? 0, gate.oldestAgeSeconds),
        );
      }
      for (const [worker, oldestAgeSeconds] of oldestByWorker) {
        billingWorkerGateOldestAgeSeconds.set({ worker }, oldestAgeSeconds);
      }
      enterprisePrepaidBalanceAmount.reset();
      enterprisePrepaidConsumption7dAmount.reset();
      enterprisePrepaidBalanceSampleTimestampSeconds.reset();
      const sampledAtSeconds = Date.now() / 1000;
      for (const account of enterprisePrepaidBalances) {
        const labels = {
          billing_account_id: account.billingAccountId,
          account_name: account.accountName,
          currency: account.currency,
        };
        enterprisePrepaidBalanceAmount.set(labels, account.balanceAmount);
        enterprisePrepaidConsumption7dAmount.set(labels, account.consumption7dAmount);
        enterprisePrepaidBalanceSampleTimestampSeconds.set(labels, sampledAtSeconds);
      }
      enterprisePrepaidBalanceWatchSuccessTimestampSeconds.set(sampledAtSeconds);
      billingHistoryGrowthWatchDurationMs.set(durationMs);

      this.logger.log(
        `history growth watch trigger=${trigger} durationMs=${durationMs.toFixed(0)} `
        + tables
          .map((t) => `${t.table}=${t.totalRows}/hot=${t.hotAccountRows}@${t.hotAccountId ?? 'none'}`)
          .join(' ')
        + (unsettledDebt
          ? ` unsettledDebtAccounts=${unsettledDebt.accounts} `
            + `unsettledDebtMax=${unsettledDebt.maxRows}@${unsettledDebt.maxAccountId ?? 'none'} `
            + `top=[${unsettledDebt.top.map((r) => `${r.billingAccountId}:${r.rows}`).join(',')}]`
          : ' unsettledDebt=unavailable')
        + (overdueGrants
          ? ` overdueUnmarkedGrants=${overdueGrants.unmarked}`
            + ` overdueUnmarkedWithBalance=${overdueGrants.unmarkedWithBalance}`
          : ' overdueGrants=unavailable')
        + ` workerGates=[${workerGates.map((row) =>
          `${row.worker}/${row.status}:${row.rows}/oldest=${row.oldestAgeSeconds}s`
        ).join(',')}]`
        + ` enterprisePrepaidBalances=${enterprisePrepaidBalances.length}`,
      );
      return {
        trigger, skipped: false, durationMs, tables, unsettledDebt, overdueGrants,
        workerGates, enterprisePrepaidBalances,
      };
    } catch (err) {
      // Observability must never take the service down, and a failure here is
      // itself worth seeing — a sudden failure of these aggregates would most
      // likely mean the tables got large enough for them to time out.
      this.logger.error(
        `history growth watch failed trigger=${trigger} `
        + `durationMs=${elapsedMs().toFixed(0)} error=${(err as Error).message}`,
      );
      return {
        trigger, skipped: false, durationMs: elapsedMs(), tables: [], unsettledDebt: null,
        overdueGrants: null, workerGates: [], enterprisePrepaidBalances: [],
      };
    }
    // No release. The lock expires on its own after ~one interval; see
    // LOCK_TTL_RATIO. Releasing here — including on the failure path — would
    // hand the same tick to the next replica, and on failure that means every
    // replica in turn retrying a query that just failed.
  }

  /**
   * Total rows plus the single worst account, in one pass per table.
   *
   * `count(*)` over the whole table is deliberate: it is the number that says
   * whether the table is growing without bound, and the accompanying duration
   * gauge will show if it ever stops being cheap. The per-account maximum comes
   * from a grouped scan; both are approximate the moment they are read, which
   * is fine for a growth signal.
   */
  private async sampleTable(table: string): Promise<HistoryGrowthSample['tables'][number]> {
    // Table names come from the module-level WATCHED_TABLES literal, never from
    // input, so interpolating them is safe here. Prisma cannot parameterise an
    // identifier.
    const rows = await this.prisma.$queryRawUnsafe<Array<{
      total: bigint;
      hot_account_id: string | null;
      hot_rows: bigint;
    }>>(
      `SELECT
         (SELECT COUNT(*) FROM "${table}") AS "total",
         hot."billing_account_id" AS "hot_account_id",
         COALESCE(hot."rows", 0) AS "hot_rows"
       FROM (
         SELECT "billing_account_id", COUNT(*) AS "rows"
         FROM "${table}"
         GROUP BY "billing_account_id"
         ORDER BY COUNT(*) DESC
         LIMIT 1
       ) AS hot`,
    );
    const row = rows[0];
    return {
      table,
      totalRows: Number(row?.total ?? 0),
      hotAccountId: row?.hot_account_id ?? null,
      hotAccountRows: Number(row?.hot_rows ?? 0),
    };
  }

  /**
   * Unsettled ENTERPRISE_CREDIT allocations per account.
   *
   * The `source` filter is not optional: an earlier estimate of this number
   * omitted it, counted BALANCE_GRANT consumption rows too, and named the wrong
   * account as the worst case by an order of magnitude. Only
   * ENTERPRISE_CREDIT and NEGATIVE_BALANCE rows are settlement candidates.
   */
  private async sampleUnsettledDebt(): Promise<HistoryGrowthSample['unsettledDebt']> {
    const rows = await this.prisma.$queryRaw<Array<{
      billing_account_id: string;
      rows: bigint;
    }>>`
      SELECT "billing_account_id", COUNT(*) AS "rows"
      FROM "balance_consumption_allocations"
      WHERE "source" = 'ENTERPRISE_CREDIT'
        AND "settled_at" IS NULL
      GROUP BY "billing_account_id"
      ORDER BY COUNT(*) DESC
      LIMIT ${TOP_N}
    `;
    const accountsRow = await this.prisma.$queryRaw<Array<{ accounts: bigint }>>`
      SELECT COUNT(DISTINCT "billing_account_id") AS "accounts"
      FROM "balance_consumption_allocations"
      WHERE "source" = 'ENTERPRISE_CREDIT'
        AND "settled_at" IS NULL
    `;
    const top = rows.map((r) => ({
      billingAccountId: r.billing_account_id,
      rows: Number(r.rows),
    }));
    return {
      accounts: Number(accountsRow[0]?.accounts ?? 0),
      maxRows: top[0]?.rows ?? 0,
      maxAccountId: top[0]?.billingAccountId ?? null,
      top,
    };
  }

  /**
   * Balance grants past their expiry that the expiry worker has not marked.
   *
   * Why this is worth a gauge: BALANCE_GRANT_EXPIRY_WORKER_ENABLED is "false" in
   * cn prod, use1 prod, sh uat and nprod — originally as a Billing V2 / Ledger V2
   * migration gate. As of 2026-08-31 the cn prod gate condition is satisfied
   * (all 728 accounts RECONCILED_V2, zero LEGACY_DIRTY) yet the flag was never
   * reopened, so the sweep does not run there.
   *
   * That is currently harmless, and the second count is what says so: every
   * spend path filters on `is_expired = FALSE` AND `expires_at > now`, so a
   * stale flag cannot let an expired grant be spent. The sweep's other job —
   * debiting the wallet for grant balance that expires unspent — only matters
   * when an overdue grant still holds money. cn prod has 4 overdue-unmarked
   * grants and all 4 are drained to zero, so nothing is owed.
   *
   * `with_balance` going above zero is therefore the signal that the disabled
   * sweep has started to matter. Nothing was measuring it; it took a manual
   * query to find out. Now it does not.
   */
  private async sampleOverdueGrants(): Promise<HistoryGrowthSample['overdueGrants']> {
    // Naive timestamp columns store UTC while the server runs Asia/Shanghai, so
    // the comparison base must be pinned to UTC — `now()` alone silently
    // compares against a clock 8 hours ahead and matches nothing.
    const rows = await this.prisma.$queryRaw<Array<{
      unmarked: bigint;
      unmarked_with_balance: bigint;
    }>>`
      SELECT
        COUNT(*) AS "unmarked",
        COUNT(*) FILTER (WHERE "remaining_amount_usd" > 0) AS "unmarked_with_balance"
      FROM "balance_grants"
      WHERE "expires_at" IS NOT NULL
        AND "expires_at" <= (now() AT TIME ZONE 'UTC')
        AND NOT "is_expired"
    `;
    const row = rows[0];
    return {
      unmarked: Number(row?.unmarked ?? 0),
      unmarkedWithBalance: Number(row?.unmarked_with_balance ?? 0),
    };
  }

  private async sampleWorkerGates(): Promise<HistoryGrowthSample['workerGates']> {
    const rows = await this.prisma.$queryRaw<Array<{
      worker: string;
      status: string;
      rows: bigint;
      oldest_age_seconds: number;
    }>>`
      WITH worker_gate_rows AS (
        SELECT 'finance_export'::TEXT AS worker, status, created_at
        FROM finance_export_jobs
        WHERE status IN ('PENDING', 'RUNNING')
        UNION ALL
        SELECT 'refund_compensation', status::TEXT, created_at
        FROM refund_compensation_tasks
        WHERE status <> 'SUCCEEDED'
        UNION ALL
        SELECT 'provider_refund', status::TEXT, created_at
        FROM provider_refund_intents
        WHERE status <> 'COMPLETED'
        UNION ALL
        SELECT 'stripe_subscription_cancellation', status::TEXT, created_at
        FROM stripe_subscription_cancellation_tasks
        WHERE status <> 'SUCCEEDED'
      )
      SELECT
        worker,
        status,
        COUNT(*) AS rows,
        GREATEST(
          0,
          EXTRACT(EPOCH FROM ((now() AT TIME ZONE 'UTC') - MIN(created_at)))
        )::DOUBLE PRECISION AS oldest_age_seconds
      FROM worker_gate_rows
      GROUP BY worker, status
      ORDER BY worker, status
    `;
    return rows.map((row) => ({
      worker: row.worker,
      status: row.status,
      rows: Number(row.rows),
      oldestAgeSeconds: Math.floor(Number(row.oldest_age_seconds)),
    }));
  }

  /**
   * Active enterprise accounts which currently follow the prepaid path.
   *
   * Billing's authoritative current-policy rule treats a missing, DISABLED or
   * SUSPENDED credit config as prepaid. ACTIVE configs stay out of this signal
   * even when future-dated or expired: they remain commercially managed credit
   * accounts and have their own overdue/credit-policy monitoring.
   */
  private async sampleEnterprisePrepaidBalances(): Promise<
    HistoryGrowthSample['enterprisePrepaidBalances']
  > {
    const rows = await this.prisma.$queryRaw<Array<{
      billing_account_id: string;
      account_name: string;
      currency: string;
      balance_amount: Prisma.Decimal;
      consumption_7d_amount: Prisma.Decimal;
    }>>`
      WITH enterprise_prepaid_balances AS (
        SELECT
          account."id" AS billing_account_id,
          COALESCE(NULLIF(account."enterprise_name", ''), account."name") AS account_name,
          account."currency" AS currency,
          wallet."balance_usd" AS balance_amount
        FROM "billing_accounts" AS account
        JOIN "account_wallets" AS wallet
          ON wallet."billing_account_id" = account."id"
        LEFT JOIN "billing_account_credit_configs" AS credit
          ON credit."billing_account_id" = account."id"
        WHERE account."type" = 'enterprise'
          AND account."status" = 'active'
          AND account."deleted_at" IS NULL
          AND account."provisioning_quarantined_at" IS NULL
          AND (credit."billing_account_id" IS NULL OR credit."status" IN ('DISABLED', 'SUSPENDED'))
      )
      SELECT
        account.billing_account_id,
        account.account_name,
        account.currency,
        account.balance_amount,
        consumption.consumption_7d_amount
      FROM enterprise_prepaid_balances AS account
      LEFT JOIN LATERAL (
        SELECT COALESCE(-SUM(transaction."amount_usd"), 0) AS consumption_7d_amount
        FROM "balance_transactions" AS transaction
        WHERE transaction."billing_account_id" = account.billing_account_id
          AND transaction."type" = 'CONSUME'
          AND transaction."created_at" >= (now() AT TIME ZONE 'UTC') - INTERVAL '7 days'
      ) AS consumption ON TRUE
      ORDER BY account.billing_account_id
    `;
    return rows.map((row) => ({
      billingAccountId: row.billing_account_id,
      accountName: row.account_name,
      currency: row.currency,
      balanceAmount: Number(row.balance_amount),
      consumption7dAmount: Math.max(0, Number(row.consumption_7d_amount)),
    }));
  }

  private async acquireLock(token: string): Promise<boolean> {
    try {
      const ttlMs = Math.floor(this.intervalMs() * LOCK_TTL_RATIO);
      const ok = await this.redis.set(LOCK_KEY, token, 'PX', ttlMs, 'NX');
      return ok === 'OK';
    } catch (err) {
      // Redis unreachable means the rate limit cannot be enforced, so skip
      // rather than let every replica sample unguarded.
      this.logger.warn(`history growth watch lock acquire failed: ${(err as Error).message}`);
      return false;
    }
  }

  private enabled(): boolean {
    const raw = this.config.get<string>('BILLING_HISTORY_GROWTH_WATCH_ENABLED')
      ?? process.env.BILLING_HISTORY_GROWTH_WATCH_ENABLED;
    if (raw === undefined || raw === null || raw === '') return true;
    return !['false', '0', 'off', 'no'].includes(String(raw).toLowerCase());
  }

  private intervalMs(): number {
    const raw = Number(
      this.config.get<string>('BILLING_HISTORY_GROWTH_WATCH_INTERVAL_MS')
        ?? process.env.BILLING_HISTORY_GROWTH_WATCH_INTERVAL_MS,
    );
    // 10 minutes. These are growth signals measured in tens of thousands of
    // rows per day, so sampling faster buys nothing and only adds aggregate
    // scans to a database that is already the bottleneck on this path.
    if (!Number.isFinite(raw) || raw < 60_000) return 600_000;
    return Math.floor(raw);
  }
}
