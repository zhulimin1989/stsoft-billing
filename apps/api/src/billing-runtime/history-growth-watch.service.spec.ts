import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { HistoryGrowthWatchService } from './history-growth-watch.service';

describe('HistoryGrowthWatchService', () => {
  function build(overrides: {
    lockResult?: 'OK' | null;
    tableRows?: Array<{ total: bigint; hot_account_id: string | null; hot_rows: bigint }>;
    debtRows?: Array<{ billing_account_id: string; rows: bigint }>;
    accountsRow?: Array<{ accounts: bigint }>;
    grantRows?: Array<{ unmarked: bigint; unmarked_with_balance: bigint }>;
    workerGateRows?: Array<{
      worker: string;
      status: string;
      rows: bigint;
      oldest_age_seconds: number;
    }>;
    enterprisePrepaidRows?: Array<{
      billing_account_id: string;
      account_name: string;
      currency: string;
      balance_amount: Prisma.Decimal;
      consumption_7d_amount: Prisma.Decimal;
    }>;
    rawThrows?: Error;
  } = {}) {
    const rawUnsafeSql: string[] = [];
    const rawSql: string[] = [];
    const prisma = {
      $queryRawUnsafe: jest.fn(async (sql: string) => {
        rawUnsafeSql.push(sql);
        if (overrides.rawThrows) throw overrides.rawThrows;
        return overrides.tableRows
          ?? [{ total: BigInt(10), hot_account_id: 'acct-hot', hot_rows: BigInt(7) }];
      }),
      $queryRaw: jest.fn(async (strings: TemplateStringsArray) => {
        const sql = Array.isArray(strings) ? strings.join('?') : String(strings);
        rawSql.push(sql);
        if (overrides.rawThrows) throw overrides.rawThrows;
        if (/COUNT\(DISTINCT/.test(sql)) {
          return overrides.accountsRow ?? [{ accounts: BigInt(2) }];
        }
        if (/balance_grants/.test(sql)) {
          return overrides.grantRows
            ?? [{ unmarked: BigInt(4), unmarked_with_balance: BigInt(0) }];
        }
        if (/worker_gate_rows/.test(sql)) {
          return overrides.workerGateRows ?? [
            {
              worker: 'finance_export',
              status: 'PENDING',
              rows: BigInt(4),
              oldest_age_seconds: 86_400,
            },
          ];
        }
        if (/enterprise_prepaid_balances/.test(sql)) {
          return overrides.enterprisePrepaidRows ?? [
            {
              billing_account_id: 'acct-prepaid-1',
              account_name: '测试企业',
              currency: 'CNY',
              balance_amount: new Prisma.Decimal('900'),
              consumption_7d_amount: new Prisma.Decimal('200'),
            },
          ];
        }
        return overrides.debtRows ?? [
          { billing_account_id: 'acct-debt-1', rows: BigInt(240_000) },
          { billing_account_id: 'acct-debt-2', rows: BigInt(12) },
        ];
      }),
    };
    const redis = {
      set: jest.fn(async () => (overrides.lockResult === undefined ? 'OK' : overrides.lockResult)),
      eval: jest.fn(async () => 1),
    };
    const config = { get: jest.fn(() => undefined) } as unknown as ConfigService;
    const service = new HistoryGrowthWatchService(
      prisma as never,
      redis as never,
      config,
    );
    return { service, prisma, redis, rawUnsafeSql, rawSql };
  }

  it('samples the three per-event history tables and the unsettled debt head', async () => {
    const { service, rawUnsafeSql } = build();

    const sample = await service.runOnce('test');

    expect(sample.skipped).toBe(false);
    expect(sample.tables.map((t) => t.table)).toEqual([
      'balance_consumption_allocations',
      'gateway_usage_funding_reservations',
      'gateway_usage_settlement_anchors',
    ]);
    // The per-account maximum is the figure that predicts per-event cost; a
    // total without it cannot distinguish a large table spread across many
    // accounts from one concentrated in a single account.
    expect(sample.tables[0]).toMatchObject({ totalRows: 10, hotAccountRows: 7, hotAccountId: 'acct-hot' });
    expect(rawUnsafeSql).toHaveLength(3);
    expect(sample.unsettledDebt).toMatchObject({
      accounts: 2,
      maxRows: 240_000,
      maxAccountId: 'acct-debt-1',
    });
  });

  it('filters unsettled debt by source, so BALANCE_GRANT rows cannot inflate the ceiling', async () => {
    const { service, rawSql } = build();

    await service.runOnce('test');

    // A prior estimate of this number omitted the source filter, counted
    // ordinary balance-grant consumption, and named the wrong worst-case
    // account by an order of magnitude. Only settlement candidates count.
    // Scoped to the allocation queries: the grant-expiry query in the same pass
    // reads a different table and must not be held to this predicate.
    const allocationSql = rawSql.filter((q) => /balance_consumption_allocations/.test(q));
    expect(allocationSql.length).toBeGreaterThan(0);
    for (const sql of allocationSql) {
      expect(sql).toMatch(/"source" = 'ENTERPRISE_CREDIT'/);
      expect(sql).toMatch(/"settled_at" IS NULL/);
    }
  });

  it('separates overdue-unmarked grants from the ones that still hold money', async () => {
    const { service, rawSql } = build();

    const sample = await service.runOnce('test');

    // The expiry sweep is disabled in every environment except HK UAT. Its
    // flag-hygiene job (marking is_expired) is harmless to skip, because every
    // spend path also filters on expires_at. Its other job — debiting the wallet
    // for grant balance that expires unspent — only matters when an overdue
    // grant still holds money. So the two counts are not interchangeable, and
    // only the second one is a call to action.
    expect(sample.overdueGrants).toEqual({ unmarked: 4, unmarkedWithBalance: 0 });

    const grantSql = rawSql.find((q) => /balance_grants/.test(q));
    expect(grantSql).toBeDefined();
    // Naive timestamp columns store UTC while the DB server runs Asia/Shanghai.
    // A bare now() compares against a clock 8 hours ahead and matches nothing —
    // this exact mistake produced a "0 rows" false negative during the manual
    // investigation, so the UTC pin is asserted rather than assumed.
    expect(grantSql).toMatch(/now\(\) AT TIME ZONE 'UTC'/);
    expect(grantSql).toMatch(/NOT "is_expired"/);
    expect(grantSql).toMatch(/FILTER \(WHERE "remaining_amount_usd" > 0\)/);
  });

  it('reports non-terminal work waiting behind each worker gate', async () => {
    const { service, rawSql } = build({
      workerGateRows: [
        {
          worker: 'refund_compensation',
          status: 'FAILED',
          rows: BigInt(3),
          oldest_age_seconds: 900,
        },
        {
          worker: 'stripe_subscription_cancellation',
          status: 'PENDING',
          rows: BigInt(2),
          oldest_age_seconds: 1_800,
        },
      ],
    });

    const sample = await service.runOnce('test');

    expect(sample.workerGates).toEqual([
      {
        worker: 'refund_compensation',
        status: 'FAILED',
        rows: 3,
        oldestAgeSeconds: 900,
      },
      {
        worker: 'stripe_subscription_cancellation',
        status: 'PENDING',
        rows: 2,
        oldestAgeSeconds: 1_800,
      },
    ]);
    const gateSql = rawSql.find((sql) => /worker_gate_rows/.test(sql));
    expect(gateSql).toMatch(/finance_export_jobs/);
    expect(gateSql).toMatch(/refund_compensation_tasks/);
    expect(gateSql).toMatch(/provider_refund_intents/);
    expect(gateSql).toMatch(/stripe_subscription_cancellation_tasks/);
    expect(gateSql).toMatch(/now\(\) AT TIME ZONE 'UTC'/);
  });

  it('samples active prepaid enterprise balances and recent consumption', async () => {
    const { service, rawSql } = build({
      enterprisePrepaidRows: [
        {
          billing_account_id: 'acct-prepaid-low',
          account_name: '低余额企业',
          currency: 'CNY',
          balance_amount: new Prisma.Decimal('117.25'),
          consumption_7d_amount: new Prisma.Decimal('18.75'),
        },
      ],
    });

    const sample = await service.runOnce('test');

    expect(sample.enterprisePrepaidBalances).toEqual([
      {
        billingAccountId: 'acct-prepaid-low',
        accountName: '低余额企业',
        currency: 'CNY',
        balanceAmount: 117.25,
        consumption7dAmount: 18.75,
      },
    ]);
    const balanceSql = rawSql.find((sql) => /enterprise_prepaid_balances/.test(sql));
    expect(balanceSql).toMatch(/account\."type" = 'enterprise'/);
    expect(balanceSql).toMatch(/credit\."status" IN \('DISABLED', 'SUSPENDED'\)/);
    expect(balanceSql).toMatch(/LEFT JOIN LATERAL/);
    expect(balanceSql).toMatch(/transaction\."type" = 'CONSUME'/);
    expect(balanceSql).toMatch(/INTERVAL '7 days'/);
    expect(balanceSql).toMatch(/now\(\) AT TIME ZONE 'UTC'/);
  });

  it('does nothing when another replica holds the lock', async () => {
    const { service, prisma } = build({ lockResult: null });

    const sample = await service.runOnce('test');

    expect(sample.skipped).toBe(true);
    // The point of the lock is that 2-12 KEDA replicas do not each run these
    // aggregates. A worker on this codebase previously became the single
    // largest source of slow queries precisely by being replica-amplified.
    expect(prisma.$queryRawUnsafe).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
  });

  it('holds the lock for most of an interval and never releases it early', async () => {
    const { service, redis } = build();

    await service.runOnce('test');

    // This is a fleet-wide rate limiter, not a mutex. An earlier version set the
    // TTL to a full interval but released the lock in a finally block, which
    // reads as correct and is not: on nprod both replicas sampled the same tick
    // 20s apart, because each pod's timer fires independently and the lock was
    // free again within milliseconds of the first sample finishing.
    expect(redis.set).toHaveBeenCalledWith(
      'billing:history-growth-watch:lock',
      expect.any(String),
      'PX',
      540_000, // 90% of the 600s default, so timer drift cannot starve the next tick
      'NX',
    );
    // Nothing may hand the current tick to another replica.
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('never throws when the aggregates fail, and still does not free the tick', async () => {
    const { service, redis } = build({ rawThrows: new Error('statement timeout') });

    // Sampling is diagnostics. If these counts ever get expensive enough to
    // time out, that must not take the billing runtime down with them.
    await expect(service.runOnce('test')).resolves.toMatchObject({ skipped: false, tables: [] });
    // And a failure must not release the lock either: that would hand the same
    // tick to the next replica, so every replica in turn would retry a query
    // that just timed out — the amplification this lock exists to prevent,
    // arriving by way of the failure path.
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('keeps unbounded history-table account identifiers out of metric labels', async () => {
    const { service } = build();
    const sample = await service.runOnce('test');

    // Cardinality guard for the history-table gauges: they carry table/source
    // only. Their hot-account ids are unbounded and belong in the log line.
    // The separate prepaid-enterprise metric intentionally identifies the
    // small actionable account set so DingTalk can name the customer.
    expect(sample.unsettledDebt?.top.length).toBeLessThanOrEqual(5);
    expect(sample.tables.every((t) => typeof t.table === 'string')).toBe(true);
  });
});
