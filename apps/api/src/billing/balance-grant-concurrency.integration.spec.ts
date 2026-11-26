import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule, ConfigService } from '@nestjs/config';
import {
  OrderStatus,
  OrderType,
  Prisma,
  PrismaClient,
  ProductBillingMode,
  TransactionType,
} from '@prisma/client';
import { BillingService } from './billing.service';
import { BillingRepository } from './billing.repository';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { BillingUserMirrorService } from '../billing-runtime/billing-user-mirror.service';
import { BillingWorkspaceMirrorService } from '../billing-runtime/billing-workspace-mirror.service';
import {
  ageFixturePastExpiry,
  lockFixtureLedgerAndCaptureFinancialNow,
} from './balance-financial-clock.integration-fixture';
import { BillingAdminService } from './billing.admin.service';
import { InvoiceSourceService } from '../invoice/invoice-source.service';

/**
 * Mutating integration test: requires an isolated Postgres database.
 *
 * Run manually or in a dedicated CI job:
 *   TEST_INTEGRATION=1 pnpm --filter @ruidong/api test -- --testPathPattern=balance-grant-concurrency.integration
 */
const maybeDescribe = process.env.TEST_INTEGRATION === '1' ? describe : describe.skip;

const INITIAL_USD = new Prisma.Decimal('10');
const DEDUCT_USD = new Prisma.Decimal('0.2');
const CONCURRENCY = 100;

type TestSubject = {
  userId: string;
  tenantId: string;
  billingAccountId: string;
  balanceGrantId: string;
};

function withLongInteractiveTransactions(prisma: PrismaService): PrismaService {
  return new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop === '$transaction') {
        return (arg: unknown, options?: unknown) => {
          if (typeof arg === 'function') {
            return (target as any).$transaction(arg, {
              maxWait: 30_000,
              timeout: 30_000,
              ...((options && typeof options === 'object') ? options : {}),
            });
          }
          return (target as any).$transaction(arg, options);
        };
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as PrismaService;
}

function withTransactionLocalTimeZone(
  prisma: PrismaService,
  timeZone: string,
): PrismaService {
  return new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop === '$transaction') {
        const transaction = Reflect.get(target, prop, receiver);
        if (typeof transaction !== 'function') {
          throw new Error('Prisma $transaction is unavailable');
        }
        return (arg: unknown, options?: unknown) => {
          if (typeof arg === 'function') {
            return Reflect.apply(transaction, target, [async (db: Prisma.TransactionClient) => {
              const [configured] = await db.$queryRaw<Array<{ timeZone: string }>>`
                SELECT set_config('TimeZone', ${timeZone}, TRUE) AS "timeZone"`;
              if (configured?.timeZone !== timeZone) {
                throw new Error(`failed to set transaction TimeZone=${timeZone}`);
              }
              return arg(db);
            }, options]);
          }
          return Reflect.apply(transaction, target, [arg, options]);
        };
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as PrismaService;
}

function sumDecimals<T>(rows: T[], pick: (row: T) => Prisma.Decimal | number | string | null | undefined) {
  return rows.reduce((sum, row) => sum.plus(new Prisma.Decimal(pick(row) ?? 0)), new Prisma.Decimal(0));
}

async function expectPostgresSqlState(
  operation: Promise<unknown>,
  sqlState: string,
): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  const errorRecord = caught && typeof caught === 'object'
    ? caught as Record<string, unknown>
    : {};
  const evidence = [
    caught instanceof Error ? caught.message : String(caught),
    String(errorRecord.code ?? ''),
    JSON.stringify(errorRecord.meta ?? null),
    JSON.stringify(errorRecord.cause ?? null),
  ].join('\n');
  expect(evidence).toContain(sqlState);
}

async function waitForWalletRowLockWaiters(
  observer: Pick<PrismaClient, '$queryRaw'>,
  minimumWaiters: number,
  timeoutMs = 10_000,
): Promise<void> {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const [row] = await observer.$queryRaw<Array<{ waiter_count: bigint }>>`
      SELECT COUNT(*)::BIGINT AS "waiter_count"
      FROM pg_stat_activity
      WHERE datname = current_database()
        AND pid <> pg_backend_pid()
        AND wait_event_type = 'Lock'
        AND query LIKE '%FROM "account_wallets"%'
        AND query LIKE '%FOR UPDATE%'
    `;
    if (Number(row?.waiter_count ?? 0) >= minimumWaiters) return;
    await new Promise((resolve) => setTimeout(resolve, 25));
  }
  throw new Error(`timed out waiting for ${minimumWaiters} account_wallets row-lock waiters`);
}

function createLockObserver(): PrismaClient {
  const databaseUrl = (
    process.env.BILLING_DATABASE_URL
    || process.env.DATABASE_URL
  )?.trim();
  if (!databaseUrl) {
    throw new Error('DATABASE_URL is required for the integration lock observer');
  }

  const observerUrl = new URL(databaseUrl);
  observerUrl.searchParams.set('connection_limit', '1');
  observerUrl.searchParams.set('pool_timeout', '10');
  return new PrismaClient({
    datasources: { db: { url: observerUrl.toString() } },
  });
}

async function assertIsolatedTestDatabase(
  prisma: Pick<PrismaClient, '$queryRaw'>,
): Promise<void> {
  const expectedDatabase = process.env.TEST_DATABASE_NAME?.trim();
  if (!expectedDatabase || !/(test|ci)/i.test(expectedDatabase)) {
    throw new Error('TEST_DATABASE_NAME must name an isolated test/ci database');
  }
  const [row] = await prisma.$queryRaw<Array<{ database_name: string }>>`
    SELECT current_database() AS "database_name"`;
  if (row?.database_name !== expectedDatabase) {
    throw new Error(
      `integration database mismatch expected=${expectedDatabase} actual=${row?.database_name ?? 'missing'}`,
    );
  }
}

async function expectExactLedgerInvariant(
  prisma: PrismaService,
  billingAccountId: string,
): Promise<void> {
  const [wallet, grants, debt] = await Promise.all([
    prisma.accountWallet.findUniqueOrThrow({ where: { billingAccountId } }),
    prisma.balanceGrant.findMany({
      where: { billingAccountId, isExpired: false },
      select: { remainingAmountUsd: true },
    }),
    prisma.balanceConsumptionAllocation.findMany({
      where: { billingAccountId, source: 'NEGATIVE_BALANCE' },
      select: { amountUsd: true, settledUsd: true },
    }),
  ]);
  const activeGrantUsd = sumDecimals(grants, (grant) => grant.remainingAmountUsd);
  const openDebtUsd = sumDecimals(
    debt,
    (allocation) => allocation.amountUsd.minus(allocation.settledUsd),
  );
  const expectedActiveUsd = Prisma.Decimal.max(wallet.balanceUsd, new Prisma.Decimal(0));
  const expectedDebtUsd = Prisma.Decimal.max(wallet.balanceUsd.neg(), new Prisma.Decimal(0));
  expect(activeGrantUsd.toFixed(12)).toBe(expectedActiveUsd.toFixed(12));
  expect(openDebtUsd.toFixed(12)).toBe(expectedDebtUsd.toFixed(12));
  expect(activeGrantUsd.minus(openDebtUsd).toFixed(12)).toBe(wallet.balanceUsd.toFixed(12));
}

async function sweepCutoffAfterGrantExpiry(
  prisma: PrismaService,
  balanceGrantId: string,
): Promise<Date> {
  const grant = await prisma.balanceGrant.findUniqueOrThrow({
    where: { id: balanceGrantId },
    select: { expiresAt: true },
  });
  if (!grant.expiresAt) {
    throw new Error(`due fixture has no expiry: ${balanceGrantId}`);
  }
  return new Date(grant.expiresAt.getTime() + 1);
}

maybeDescribe('BillingService BalanceGrant concurrency (integration)', () => {
  let moduleRef: TestingModule;
  let service: BillingService;
  let adminService: BillingAdminService;
  let prisma: PrismaService;
  let lockObserver: PrismaClient;
  let subject: TestSubject | null = null;

  beforeAll(async () => {
    let realPrisma: PrismaService | undefined;
    const redis = {
      set: jest.fn().mockResolvedValue('OK'),
      get: jest.fn().mockResolvedValue(null),
      del: jest.fn().mockResolvedValue(1),
    };

    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          envFilePath: ['.env.test', '.env'],
          ignoreEnvFile: false,
        }),
      ],
      providers: [
        BillingService,
        {
          provide: PrismaService,
          inject: [ConfigService],
          useFactory: (config: ConfigService) => {
            realPrisma = new PrismaService(config);
            return withLongInteractiveTransactions(realPrisma);
          },
        },
        { provide: RedisService, useValue: redis },
        BillingRepository,
      ],
    }).compile();

    if (!realPrisma) throw new Error('PrismaService failed to initialize');
    prisma = realPrisma;
    lockObserver = createLockObserver();
    service = moduleRef.get(BillingService);
    adminService = new BillingAdminService(
      {} as any,
      prisma,
      {} as any,
      {} as any,
      { getDeploymentConfig: jest.fn(async () => ({ region: 'domestic', currency: 'CNY' })) } as any,
    );
    await Promise.all([prisma.$connect(), lockObserver.$connect()]);
    await assertIsolatedTestDatabase(prisma);
    await assertIsolatedTestDatabase(lockObserver);
  });

  afterEach(async () => {
    if (!subject) return;
    await cleanupSubject(prisma, subject);
    subject = null;
  });

  afterAll(async () => {
    await lockObserver?.$disconnect().catch(() => undefined);
    await prisma?.$disconnect().catch(() => undefined);
    await moduleRef?.close().catch(() => undefined);
  });

  it('does not overdraw one BalanceGrant under 100 concurrent 0.2 USD deductions', async () => {
    const concurrentInitialUsd = DEDUCT_USD.mul(CONCURRENCY);
    subject = await createSubject(prisma, service, concurrentInitialUsd);

    const results = await Promise.allSettled(
      Array.from({ length: CONCURRENCY }, (_, index) =>
        service.deduct(subject!.userId, DEDUCT_USD, `grant-concurrency-${index}`, {
          tenantId: subject!.tenantId,
        }),
      ),
    );

    const rejected = results.filter((result) => result.status === 'rejected');
    const fulfilled = results.filter(
      (result): result is PromiseFulfilledResult<{ success: boolean; balance: number; balanceUsd: number }> =>
        result.status === 'fulfilled',
    );
    const successCount = fulfilled.filter((result) => result.value.success).length;
    const rejectedByBalance = fulfilled.filter((result) => !result.value.success).length;

    expect(rejected).toHaveLength(0);
    expect(successCount).toBe(CONCURRENCY);
    expect(rejectedByBalance).toBe(0);

    const [wallet, grants, allocations, transactions] = await Promise.all([
      prisma.accountWallet.findUniqueOrThrow({
        where: { billingAccountId: subject.billingAccountId },
      }),
      prisma.balanceGrant.findMany({
        where: { billingAccountId: subject.billingAccountId },
        orderBy: { createdAt: 'asc' },
      }),
      prisma.balanceConsumptionAllocation.findMany({
        where: { billingAccountId: subject.billingAccountId },
      }),
      prisma.balanceTransaction.findMany({
        where: {
          billingAccountId: subject.billingAccountId,
          type: TransactionType.CONSUME,
        },
      }),
    ]);

    expect(grants).toHaveLength(1);
    expect(grants[0].id).toBe(subject.balanceGrantId);
    expect(grants[0].remainingAmountUsd.gte(0)).toBe(true);

    const allocatedUsd = sumDecimals(allocations, (allocation) => allocation.amountUsd);
    const consumedTxUsd = sumDecimals(transactions, (transaction) => transaction.amountUsd.abs());
    const walletConsumedUsd = concurrentInitialUsd.minus(wallet.balanceUsd);

    expect(allocations).toHaveLength(successCount);
    expect(transactions).toHaveLength(successCount);
    expect(allocatedUsd.lte(concurrentInitialUsd)).toBe(true);
    expect(grants[0].remainingAmountUsd.toFixed(12)).toBe('0.000000000000');
    expect(allocatedUsd.toFixed(12)).toBe(concurrentInitialUsd.toFixed(12));
    expect(consumedTxUsd.toFixed(12)).toBe(allocatedUsd.toFixed(12));
    expect(walletConsumedUsd.toFixed(12)).toBe(allocatedUsd.toFixed(12));
    expect(wallet.balanceUsd.toFixed(12)).toBe('0.000000000000');

    const sequencedAllocations = [...allocations].sort((left, right) => {
      if (left.ledgerSequence === null || right.ledgerSequence === null) return 0;
      return left.ledgerSequence < right.ledgerSequence ? -1 : 1;
    });
    expect(sequencedAllocations.every((allocation) => allocation.ledgerSequence !== null)).toBe(true);
    expect(new Set(sequencedAllocations.map((allocation) => allocation.ledgerSequence!.toString())).size)
      .toBe(successCount);
    const transactionById = new Map(transactions.map((transaction) => [transaction.id, transaction]));
    for (const [index, allocation] of sequencedAllocations.entries()) {
      const transaction = transactionById.get(allocation.balanceTransactionId);
      expect(transaction).toBeDefined();
      expect(transaction!.balanceAfterUsd.toFixed(12)).toBe(
        concurrentInitialUsd.minus(DEDUCT_USD.mul(index + 1)).toFixed(12),
      );
    }
    const sequencedTransactions = [...transactions].sort((left, right) => {
      if (left.ledgerSequence === null || right.ledgerSequence === null) return 0;
      return left.ledgerSequence < right.ledgerSequence ? -1 : 1;
    });
    expect(sequencedTransactions.every((transaction) => transaction.ledgerSequence !== null))
      .toBe(true);
    let previousCreatedAt = Number.NEGATIVE_INFINITY;
    for (const transaction of sequencedTransactions) {
      expect(transaction.createdAt.getTime()).toBeGreaterThanOrEqual(previousCreatedAt);
      previousCreatedAt = transaction.createdAt.getTime();
    }
  }, 60_000);

  it('keeps finance consumption pages on one read-only repeatable-read snapshot', async () => {
    const productId = `bgc-finance-snapshot-product-${randomUUID()}`;
    await prisma.product.create({
      data: {
        id: productId,
        name: 'Finance snapshot integration product',
        slug: productId,
        billingMode: ProductBillingMode.SUBSCRIPTION,
      },
    });
    subject = await createSubject(
      prisma,
      service,
      INITIAL_USD,
      false,
      [],
      null,
      productId,
    );
    for (const description of [
      'finance-snapshot-initial-first',
      'finance-snapshot-initial-second',
    ]) {
      const deduction = await service.deduct(
        subject.userId,
        DEDUCT_USD,
        description,
        { tenantId: subject.tenantId, productId },
      );
      expect(deduction.success).toBe(true);
    }

    const initialAllocations = await prisma.balanceConsumptionAllocation.findMany({
      where: {
        billingAccountId: subject.billingAccountId,
        balanceTransaction: {
          description: {
            in: [
              'finance-snapshot-initial-first',
              'finance-snapshot-initial-second',
            ],
          },
        },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
    });
    expect(initialAllocations).toHaveLength(2);
    const expectedInitialIds = initialAllocations.map((allocation) => allocation.id);
    const reportStart = new Date(
      Math.min(...initialAllocations.map((allocation) => allocation.createdAt.getTime())),
    );
    const reportEnd = new Date(Date.now() + 60_000);
    const adminInternals = adminService as any;
    let committedAllocation: {
      id: string;
      balanceTransactionId: string;
      createdAt: Date;
    } | null = null;

    const snapshotEvidence = await adminInternals.withFinanceReportReadSnapshot(
      async (snapshot: { db: Prisma.TransactionClient; asOf: Date }) => {
        const [settings] = await snapshot.db.$queryRaw<Array<{
          isolationLevel: string;
          readOnly: string;
        }>>`
          SELECT
            current_setting('transaction_isolation') AS "isolationLevel",
            current_setting('transaction_read_only') AS "readOnly"
        `;
        expect(settings).toEqual({
          isolationLevel: 'repeatable read',
          readOnly: 'on',
        });

        const cursorScope = 'integration-snapshot';
        const readPage = (cursorToken: string | null) =>
          adminInternals.loadFinanceGiftConsumptionPage({
            monthKey: 'integration-snapshot',
            start: reportStart,
            end: reportEnd,
            tab: 'buyGiftConsumptionDetails',
            billingMode: ProductBillingMode.SUBSCRIPTION,
            cursor: cursorToken
              ? adminInternals.decodeFinanceReportCursor(cursorToken, cursorScope)
              : null,
            pageSize: 1,
            scopeHash: cursorScope,
          }, snapshot.db);

        const firstPage = await readPage(null);
        expect(firstPage.pageRows.map((row: { id: string }) => row.id)).toEqual([
          expectedInitialIds[0],
        ]);
        expect(firstPage.hasMore).toBe(true);

        const concurrentDeduction = await service.deduct(
          subject!.userId,
          DEDUCT_USD,
          'finance-snapshot-concurrent-commit',
          { tenantId: subject!.tenantId, productId },
        );
        expect(concurrentDeduction.success).toBe(true);
        committedAllocation = await prisma.balanceConsumptionAllocation.findFirstOrThrow({
          where: {
            billingAccountId: subject!.billingAccountId,
            balanceTransaction: {
              description: 'finance-snapshot-concurrent-commit',
            },
          },
          select: {
            id: true,
            balanceTransactionId: true,
            createdAt: true,
          },
        });
        expect(committedAllocation.createdAt.getTime()).toBeLessThan(reportEnd.getTime());

        const repeatedFirstPage = await readPage(null);
        expect(repeatedFirstPage.sourceRows.map((row: { id: string }) => row.id))
          .toEqual(firstPage.sourceRows.map((row: { id: string }) => row.id));
        expect(repeatedFirstPage.sourceRows.map((row: { id: string }) => row.id))
          .not.toContain(committedAllocation.id);

        expect(firstPage.nextCursor).toEqual(expect.any(String));
        const secondPage = await readPage(firstPage.nextCursor);
        expect(secondPage.pageRows.map((row: { id: string }) => row.id)).toEqual([
          expectedInitialIds[1],
        ]);
        expect(secondPage.hasMore).toBe(false);

        return {
          asOf: snapshot.asOf,
          allocationIds: [
            ...firstPage.pageRows,
            ...secondPage.pageRows,
          ].map((row: { id: string }) => row.id),
        };
      },
      15_000,
    ) as {
      asOf: Date;
      allocationIds: string[];
    };

    expect(snapshotEvidence.allocationIds).toEqual(expectedInitialIds);
    expect(committedAllocation).not.toBeNull();

    // The public endpoint opens a new database snapshot. Give its exclusive
    // request-time cutoff a distinct millisecond from the committed writer.
    await new Promise((resolve) => setTimeout(resolve, 5));
    const freshReport = await adminService.getFinanceReportDetail({
      tab: 'buyGiftConsumptionDetails',
      billingMode: ProductBillingMode.SUBSCRIPTION,
      pageSize: 500,
    }) as unknown as {
      period: { asOf: string };
      rows: Array<{ callTransactionNo?: string }>;
    };
    expect(new Date(freshReport.period.asOf).getTime())
      .toBeGreaterThanOrEqual(snapshotEvidence.asOf.getTime());
    expect(freshReport.rows.some((row) => (
      row.callTransactionNo === committedAllocation!.balanceTransactionId
    ))).toBe(true);
  }, 30_000);

  it('rejects a clean-account grant-only remainder rewrite and rolls it back', async () => {
    subject = await createSubject(prisma, service, INITIAL_USD);
    const grantBefore = await prisma.balanceGrant.findUniqueOrThrow({
      where: { id: subject.balanceGrantId },
    });

    await expectPostgresSqlState(prisma.$transaction(async (db) => {
      await lockFixtureLedgerAndCaptureFinancialNow(db, subject!.billingAccountId);
      await db.balanceGrant.update({
        where: { id: subject!.balanceGrantId },
        data: {
          remainingAmountUsd: INITIAL_USD.minus(1),
          remainingPaidAmountUsd: INITIAL_USD.minus(1),
          remainingBonusAmountUsd: new Prisma.Decimal(0),
        },
      });
      await db.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    }), '23514');

    const grantAfter = await prisma.balanceGrant.findUniqueOrThrow({
      where: { id: subject.balanceGrantId },
    });
    expect(grantAfter.remainingAmountUsd.toFixed(12))
      .toBe(grantBefore.remainingAmountUsd.toFixed(12));
    expect(grantAfter.remainingPaidAmountUsd?.toFixed(12))
      .toBe(grantBefore.remainingPaidAmountUsd?.toFixed(12));
    expect(grantAfter.remainingBonusAmountUsd?.toFixed(12))
      .toBe(grantBefore.remainingBonusAmountUsd?.toFixed(12));
    await expectExactLedgerInvariant(prisma, subject.billingAccountId);
  });

  it('rejects a clean-account CONSUME bundle with no allocation and rolls every write back', async () => {
    subject = await createSubject(prisma, service, INITIAL_USD);
    const [walletBefore, grantBefore, transactionCountBefore, allocationCountBefore] =
      await Promise.all([
        prisma.accountWallet.findUniqueOrThrow({
          where: { billingAccountId: subject.billingAccountId },
        }),
        prisma.balanceGrant.findUniqueOrThrow({
          where: { id: subject.balanceGrantId },
        }),
        prisma.balanceTransaction.count({
          where: { billingAccountId: subject.billingAccountId },
        }),
        prisma.balanceConsumptionAllocation.count({
          where: { billingAccountId: subject.billingAccountId },
        }),
      ]);

    await expectPostgresSqlState(prisma.$transaction(async (db) => {
      const occurredAt = await lockFixtureLedgerAndCaptureFinancialNow(
        db,
        subject!.billingAccountId,
      );
      const wallet = await db.accountWallet.update({
        where: { billingAccountId: subject!.billingAccountId },
        data: { balanceUsd: { decrement: new Prisma.Decimal(1) } },
      });
      await db.balanceGrant.update({
        where: { id: subject!.balanceGrantId },
        data: {
          remainingAmountUsd: INITIAL_USD.minus(1),
          remainingPaidAmountUsd: INITIAL_USD.minus(1),
          remainingBonusAmountUsd: new Prisma.Decimal(0),
        },
      });
      await db.balanceTransaction.create({
        data: {
          operationKey: `bgc-missing-allocation-${randomUUID()}`,
          userId: subject!.userId,
          tenantId: subject!.tenantId,
          billingAccountId: subject!.billingAccountId,
          type: TransactionType.CONSUME,
          amountUsd: new Prisma.Decimal(-1),
          balanceAfterUsd: wallet.balanceUsd,
          description: 'missing allocation must roll back',
          createdAt: occurredAt,
        },
      });
      await db.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    }), '23514');

    const [walletAfter, grantAfter, transactionCountAfter, allocationCountAfter] =
      await Promise.all([
        prisma.accountWallet.findUniqueOrThrow({
          where: { billingAccountId: subject.billingAccountId },
        }),
        prisma.balanceGrant.findUniqueOrThrow({
          where: { id: subject.balanceGrantId },
        }),
        prisma.balanceTransaction.count({
          where: { billingAccountId: subject.billingAccountId },
        }),
        prisma.balanceConsumptionAllocation.count({
          where: { billingAccountId: subject.billingAccountId },
        }),
      ]);
    expect(walletAfter.balanceUsd.toFixed(12)).toBe(walletBefore.balanceUsd.toFixed(12));
    expect(grantAfter.remainingAmountUsd.toFixed(12))
      .toBe(grantBefore.remainingAmountUsd.toFixed(12));
    expect(grantAfter.remainingPaidAmountUsd?.toFixed(12))
      .toBe(grantBefore.remainingPaidAmountUsd?.toFixed(12));
    expect(transactionCountAfter).toBe(transactionCountBefore);
    expect(allocationCountAfter).toBe(allocationCountBefore);
    await expectExactLedgerInvariant(prisma, subject.billingAccountId);
  });

  it('rejects a LEGACY_DIRTY allocation that references another clean account transaction and grant', async () => {
    subject = await createSubject(prisma, service, INITIAL_USD);
    const deduction = await service.deduct(
      subject.userId,
      DEDUCT_USD,
      'cross-account-allocation-source',
      { tenantId: subject.tenantId },
    );
    expect(deduction.success).toBe(true);

    const cleanAllocation = await prisma.balanceConsumptionAllocation.findFirstOrThrow({
      where: {
        billingAccountId: subject.billingAccountId,
        source: 'BALANCE_GRANT',
      },
      orderBy: { ledgerSequence: 'desc' },
    });
    if (!cleanAllocation.balanceGrantId) {
      throw new Error('clean allocation fixture has no balance grant');
    }
    const [cleanTransaction, cleanGrant] = await Promise.all([
      prisma.balanceTransaction.findUniqueOrThrow({
        where: { id: cleanAllocation.balanceTransactionId },
      }),
      prisma.balanceGrant.findUniqueOrThrow({
        where: { id: cleanAllocation.balanceGrantId },
      }),
    ]);
    expect(cleanTransaction.billingAccountId).toBe(subject.billingAccountId);
    expect(cleanGrant.billingAccountId).toBe(subject.billingAccountId);

    const dirtyAccountId = `bgc-dirty-allocation-account-${randomUUID()}`;
    await prisma.billingAccount.create({
      data: {
        id: dirtyAccountId,
        type: 'personal',
        name: 'Dirty cross-account allocation fixture',
        ownerUserId: subject.userId,
        status: 'active',
        currency: 'USD',
        balanceGrantLedgerStatus: 'LEGACY_DIRTY',
        balanceGrantLedgerVersion: 0,
        balanceGrantLedgerDirtyReason: 'cross-account-allocation-fixture',
      },
    });
    await prisma.accountWallet.create({
      data: {
        billingAccountId: dirtyAccountId,
        balanceUsd: new Prisma.Decimal(0),
      },
    });

    const dirtyAllocationCountBefore = await prisma.balanceConsumptionAllocation.count({
      where: { billingAccountId: dirtyAccountId },
    });
    await expectPostgresSqlState(prisma.balanceConsumptionAllocation.create({
      data: {
        id: `bgc-cross-account-allocation-${randomUUID()}`,
        userId: cleanAllocation.userId,
        tenantId: cleanAllocation.tenantId,
        billingAccountId: dirtyAccountId,
        productId: cleanAllocation.productId,
        balanceTransactionId: cleanAllocation.balanceTransactionId,
        tokenUsageId: cleanAllocation.tokenUsageId,
        balanceGrantId: cleanAllocation.balanceGrantId,
        source: cleanAllocation.source,
        amountUsd: cleanAllocation.amountUsd,
        recognizedRevenueUsd: cleanAllocation.recognizedRevenueUsd,
        bonusConsumedUsd: cleanAllocation.bonusConsumedUsd,
        discountRate: cleanAllocation.discountRate,
        settledUsd: cleanAllocation.settledUsd,
        settledAt: cleanAllocation.settledAt,
      },
    }), '23514');

    expect(await prisma.balanceConsumptionAllocation.count({
      where: { billingAccountId: dirtyAccountId },
    })).toBe(dirtyAllocationCountBefore);
    expect((await prisma.billingAccount.findUniqueOrThrow({
      where: { id: dirtyAccountId },
    })).balanceGrantLedgerStatus).toBe('LEGACY_DIRTY');
    await expectExactLedgerInvariant(prisma, subject.billingAccountId);
  });

  it('rejects deleting the wallet row of a clean account', async () => {
    subject = await createSubject(prisma, service, INITIAL_USD);

    await expectPostgresSqlState(prisma.accountWallet.delete({
      where: { billingAccountId: subject.billingAccountId },
    }), '23514');

    const wallet = await prisma.accountWallet.findUniqueOrThrow({
      where: { billingAccountId: subject.billingAccountId },
    });
    expect(wallet.balanceUsd.toFixed(12)).toBe(INITIAL_USD.toFixed(12));
    await expectExactLedgerInvariant(prisma, subject.billingAccountId);
  });

  it('rejects moving a wallet primary key to another account', async () => {
    subject = await createSubject(prisma, service, INITIAL_USD);
    const targetAccountId = `bgc-wallet-move-target-${randomUUID()}`;
    await prisma.billingAccount.create({
      data: {
        id: targetAccountId,
        type: 'personal',
        name: 'Wallet move target',
        ownerUserId: subject.userId,
        status: 'active',
        currency: 'USD',
        balanceGrantLedgerStatus: 'RECONCILED_V2',
        balanceGrantLedgerVersion: 2,
        balanceGrantLedgerHash: 'EMPTY_V2',
        balanceGrantLedgerReconciledAt: new Date(),
      },
    });

    await expectPostgresSqlState(prisma.$executeRaw`
      UPDATE "account_wallets"
      SET "billing_account_id" = ${targetAccountId}
      WHERE "billing_account_id" = ${subject.billingAccountId}
    `, '23514');

    expect(await prisma.accountWallet.findUnique({
      where: { billingAccountId: targetAccountId },
    })).toBeNull();
    expect((await prisma.accountWallet.findUniqueOrThrow({
      where: { billingAccountId: subject.billingAccountId },
    })).balanceUsd.toFixed(12)).toBe(INITIAL_USD.toFixed(12));
    await expectExactLedgerInvariant(prisma, subject.billingAccountId);
  });

  it('rejects changing the debt-source identity of a clean billing account', async () => {
    subject = await createSubject(prisma, service, INITIAL_USD);

    await expectPostgresSqlState(prisma.billingAccount.update({
      where: { id: subject.billingAccountId },
      data: { type: 'enterprise' },
    }), '23514');

    expect((await prisma.billingAccount.findUniqueOrThrow({
      where: { id: subject.billingAccountId },
    })).type).toBe('personal');
    await expectExactLedgerInvariant(prisma, subject.billingAccountId);
  });

  it('allows a no-op account currency write but rejects an actual currency change', async () => {
    subject = await createSubject(prisma, service, INITIAL_USD);

    await expect(prisma.billingAccount.update({
      where: { id: subject.billingAccountId },
      data: { currency: 'USD' },
    })).resolves.toMatchObject({ currency: 'USD' });

    await expectPostgresSqlState(prisma.billingAccount.update({
      where: { id: subject.billingAccountId },
      data: { currency: 'CNY' },
    }), '55000');

    expect((await prisma.billingAccount.findUniqueOrThrow({
      where: { id: subject.billingAccountId },
    })).currency).toBe('USD');
    await expectExactLedgerInvariant(prisma, subject.billingAccountId);
  });

  it('rejects an equal-value transfer between clean grants', async () => {
    subject = await createSubject(prisma, service, INITIAL_USD);
    await service.adminRecharge(
      subject.userId,
      500,
      'second grant for conservation proof',
      undefined,
      {
        tenantId: subject.tenantId,
        idempotencyKey: `bgc-second-grant-${randomUUID()}`,
      },
    );
    const deduction = await service.deduct(
      subject.userId,
      new Prisma.Decimal(1),
      'grant conservation headroom',
      { tenantId: subject.tenantId },
    );
    expect(deduction.success).toBe(true);
    const consumedAllocation = await prisma.balanceConsumptionAllocation.findFirstOrThrow({
      where: {
        billingAccountId: subject.billingAccountId,
        source: 'BALANCE_GRANT',
        balanceTransaction: { description: 'grant conservation headroom' },
      },
    });
    if (!consumedAllocation.balanceGrantId) {
      throw new Error('grant conservation fixture has no consumed grant');
    }
    const otherGrant = await prisma.balanceGrant.findFirstOrThrow({
      where: {
        billingAccountId: subject.billingAccountId,
        id: { not: consumedAllocation.balanceGrantId },
      },
    });
    const [consumedBefore, otherBefore] = await Promise.all([
      prisma.balanceGrant.findUniqueOrThrow({
        where: { id: consumedAllocation.balanceGrantId },
      }),
      prisma.balanceGrant.findUniqueOrThrow({ where: { id: otherGrant.id } }),
    ]);

    await expectPostgresSqlState(prisma.$transaction(async (db) => {
      await lockFixtureLedgerAndCaptureFinancialNow(db, subject!.billingAccountId);
      await db.balanceGrant.update({
        where: { id: consumedAllocation.balanceGrantId! },
        data: {
          remainingAmountUsd: { increment: new Prisma.Decimal(1) },
          remainingPaidAmountUsd: { increment: new Prisma.Decimal(1) },
        },
      });
      await db.balanceGrant.update({
        where: { id: otherGrant.id },
        data: {
          remainingAmountUsd: { decrement: new Prisma.Decimal(1) },
          remainingPaidAmountUsd: { decrement: new Prisma.Decimal(1) },
        },
      });
      await db.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    }), '23514');

    const [consumedAfter, otherAfter] = await Promise.all([
      prisma.balanceGrant.findUniqueOrThrow({
        where: { id: consumedAllocation.balanceGrantId! },
      }),
      prisma.balanceGrant.findUniqueOrThrow({ where: { id: otherGrant.id } }),
    ]);
    expect(consumedAfter.remainingAmountUsd.toFixed(12))
      .toBe(consumedBefore.remainingAmountUsd.toFixed(12));
    expect(otherAfter.remainingAmountUsd.toFixed(12))
      .toBe(otherBefore.remainingAmountUsd.toFixed(12));
    await expectExactLedgerInvariant(prisma, subject.billingAccountId);
  }, 30_000);

  it('overwrites an explicitly forged allocation sequence with a database sequence', async () => {
    subject = await createSubject(prisma, service, INITIAL_USD);
    const allocationId = `bgc-forged-sequence-${randomUUID()}`;
    await prisma.$transaction(async (db) => {
      const financialNow = await lockFixtureLedgerAndCaptureFinancialNow(
        db,
        subject!.billingAccountId,
      );
      const wallet = await db.accountWallet.update({
        where: { billingAccountId: subject!.billingAccountId },
        data: { balanceUsd: { decrement: new Prisma.Decimal(1) } },
      });
      await db.balanceGrant.update({
        where: { id: subject!.balanceGrantId },
        data: {
          remainingAmountUsd: { decrement: new Prisma.Decimal(1) },
          remainingPaidAmountUsd: { decrement: new Prisma.Decimal(1) },
        },
      });
      const transaction = await db.balanceTransaction.create({
        data: {
          operationKey: `bgc-forged-sequence-tx-${randomUUID()}`,
          userId: subject!.userId,
          tenantId: subject!.tenantId,
          billingAccountId: subject!.billingAccountId,
          type: TransactionType.CONSUME,
          amountUsd: new Prisma.Decimal(-1),
          balanceAfterUsd: wallet.balanceUsd,
          description: 'database owns allocation sequence',
          createdAt: financialNow,
        },
      });
      await db.balanceConsumptionAllocation.create({
        data: {
          id: allocationId,
          userId: subject!.userId,
          tenantId: subject!.tenantId,
          billingAccountId: subject!.billingAccountId,
          balanceTransactionId: transaction.id,
          balanceGrantId: subject!.balanceGrantId,
          source: 'BALANCE_GRANT',
          amountUsd: new Prisma.Decimal(1),
          recognizedRevenueUsd: new Prisma.Decimal(1),
          bonusConsumedUsd: new Prisma.Decimal(0),
          discountRate: new Prisma.Decimal(1),
          ledgerSequence: BigInt(-999),
          createdAt: financialNow,
        },
      });
    });

    const allocation = await prisma.balanceConsumptionAllocation.findUniqueOrThrow({
      where: { id: allocationId },
    });
    expect(allocation.ledgerSequence).not.toBeNull();
    expect(allocation.ledgerSequence! > BigInt(0)).toBe(true);
    expect(allocation.ledgerSequence).not.toBe(BigInt(-999));
    await expectExactLedgerInvariant(prisma, subject.billingAccountId);
  });

  it('rejects a refund that omits its immutable grant-reduction allocation', async () => {
    subject = await createSubject(prisma, service, INITIAL_USD);
    const orderId = `bgc-invalid-refund-order-${randomUUID()}`;
    await createPaidRechargeOrder(prisma, subject, orderId, 500);
    await prisma.order.update({
      where: { id: orderId },
      data: { status: OrderStatus.FULFILLING },
    });
    await service.rechargeWithBonus(
      subject.userId,
      500,
      0,
      'invalid refund audit fixture',
      orderId,
      undefined,
      {
        tenantId: subject.tenantId,
        billingAccountId: subject.billingAccountId,
      },
    );
    const targetGrant = await prisma.balanceGrant.findUniqueOrThrow({
      where: { orderId },
    });
    const before = await Promise.all([
      prisma.accountWallet.findUniqueOrThrow({
        where: { billingAccountId: subject.billingAccountId },
      }),
      prisma.balanceGrant.findUniqueOrThrow({ where: { id: targetGrant.id } }),
      prisma.balanceTransaction.count({
        where: { billingAccountId: subject.billingAccountId },
      }),
      prisma.balanceGrantRefund.count({
        where: { billingAccountId: subject.billingAccountId },
      }),
    ]);

    await expectPostgresSqlState(prisma.$transaction(async (db) => {
      const financialNow = await lockFixtureLedgerAndCaptureFinancialNow(
        db,
        subject!.billingAccountId,
      );
      const wallet = await db.accountWallet.update({
        where: { billingAccountId: subject!.billingAccountId },
        data: { balanceUsd: { decrement: new Prisma.Decimal(1) } },
      });
      await db.balanceGrant.update({
        where: { id: targetGrant.id },
        data: {
          remainingAmountUsd: { decrement: new Prisma.Decimal(1) },
          remainingPaidAmountUsd: { decrement: new Prisma.Decimal(1) },
        },
      });
      const operationKey = `balance:refund:${subject!.userId}:${randomUUID()}`;
      const refundTransaction = await db.balanceTransaction.create({
        data: {
          operationKey,
          userId: subject!.userId,
          tenantId: subject!.tenantId,
          billingAccountId: subject!.billingAccountId,
          type: TransactionType.REFUND,
          amountUsd: new Prisma.Decimal(-1),
          balanceAfterUsd: wallet.balanceUsd,
          description: 'refund missing immutable allocation',
          orderId,
          createdAt: financialNow,
        },
      });
      await db.balanceGrantRefund.create({
        data: {
          billingAccountId: subject!.billingAccountId,
          balanceGrantId: targetGrant.id,
          refundTransactionId: refundTransaction.id,
          operationKey,
          component: 'PAID',
          requestedAmountUsd: new Prisma.Decimal(1),
          targetGrantReductionUsd: new Prisma.Decimal(1),
          debtOpenedUsd: new Prisma.Decimal(0),
          debtNettedUsd: new Prisma.Decimal(0),
          openDebtUsd: new Prisma.Decimal(0),
          recognizedRevenueReversalUsd: new Prisma.Decimal(0),
          bonusConsumedReversalUsd: new Prisma.Decimal(0),
          occurredAt: financialNow,
          createdAt: financialNow,
        },
      });
      await db.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    }), '23514');

    const after = await Promise.all([
      prisma.accountWallet.findUniqueOrThrow({
        where: { billingAccountId: subject.billingAccountId },
      }),
      prisma.balanceGrant.findUniqueOrThrow({ where: { id: targetGrant.id } }),
      prisma.balanceTransaction.count({
        where: { billingAccountId: subject.billingAccountId },
      }),
      prisma.balanceGrantRefund.count({
        where: { billingAccountId: subject.billingAccountId },
      }),
    ]);
    expect(after[0].balanceUsd.toFixed(12)).toBe(before[0].balanceUsd.toFixed(12));
    expect(after[1].remainingAmountUsd.toFixed(12))
      .toBe(before[1].remainingAmountUsd.toFixed(12));
    expect(after[2]).toBe(before[2]);
    expect(after[3]).toBe(before[3]);
    await expectExactLedgerInvariant(prisma, subject.billingAccountId);
  });

  it('keeps dirty legacy consumption on UNRECONCILED_GRANT without opening it to clean accounts', async () => {
    subject = await createSubject(prisma, service, INITIAL_USD);
    await prisma.$transaction(async (db) => {
      await db.billingAccount.update({
        where: { id: subject!.billingAccountId },
        data: {
          balanceGrantLedgerStatus: 'LEGACY_DIRTY',
          balanceGrantLedgerVersion: 0,
          balanceGrantLedgerHash: null,
          balanceGrantLedgerReconciledAt: null,
          balanceGrantLedgerDirtyReason: 'dirty consumption bridge fixture',
          balanceGrantLedgerThroughTransactionId: null,
        },
      });
      await db.balanceGrant.update({
        where: { id: subject!.balanceGrantId },
        data: {
          remainingPaidAmountUsd: null,
          remainingBonusAmountUsd: null,
        },
      });
    });

    const result = await service.deduct(
      subject.userId,
      new Prisma.Decimal(1),
      'dirty bridge consumption',
      { tenantId: subject.tenantId },
    );
    expect(result.success).toBe(true);
    const allocation = await prisma.balanceConsumptionAllocation.findFirstOrThrow({
      where: {
        billingAccountId: subject.billingAccountId,
        balanceTransaction: { description: 'dirty bridge consumption' },
      },
    });
    expect(allocation.source).toBe('UNRECONCILED_GRANT');
    expect(allocation.balanceGrantId).toBe(subject.balanceGrantId);
    expect((await prisma.billingAccount.findUniqueOrThrow({
      where: { id: subject.billingAccountId },
    })).balanceGrantLedgerStatus).toBe('LEGACY_DIRTY');
  });

  it('uses a future online ledger tail as the next locked financial-clock floor', async () => {
    subject = await createSubject(prisma, service);
    const futureFloor = new Date(Date.now() + 60_000);
    const balanceGrantId = `bgc-future-floor-${randomUUID()}`;
    const amountUsd = new Prisma.Decimal(1);

    await prisma.$transaction(async (db) => {
      const wallet = await db.accountWallet.update({
        where: { billingAccountId: subject!.billingAccountId },
        data: { balanceUsd: { increment: amountUsd } },
        select: { balanceUsd: true },
      });
      await db.$executeRaw`
        SELECT set_config('billing.balance_financial_now', ${futureFloor.toISOString()}, TRUE)`;
      await db.balanceTransaction.create({
        data: {
          operationKey: `balance:admin-recharge:grant:${balanceGrantId}`,
          userId: subject!.userId,
          tenantId: subject!.tenantId,
          billingAccountId: subject!.billingAccountId,
          type: TransactionType.RECHARGE,
          amountUsd,
          balanceAfterUsd: wallet.balanceUsd,
          description: 'future online clock floor fixture',
          createdAt: futureFloor,
        },
      });
      await db.balanceGrant.create({
        data: {
          id: balanceGrantId,
          userId: subject!.userId,
          tenantId: subject!.tenantId,
          billingAccountId: subject!.billingAccountId,
          source: 'RECHARGE',
          paidAmountUsd: amountUsd,
          bonusAmountUsd: new Prisma.Decimal(0),
          grantedAmountUsd: amountUsd,
          remainingAmountUsd: amountUsd,
          remainingPaidAmountUsd: amountUsd,
          remainingBonusAmountUsd: new Prisma.Decimal(0),
          discountRate: new Prisma.Decimal(1),
          validFrom: futureFloor,
          expiresAt: null,
          isExpired: false,
          createdAt: futureFloor,
        },
      });
    });

    const result = await service.deduct(
      subject.userId,
      DEDUCT_USD,
      'future-online-clock-floor-followup',
      { tenantId: subject.tenantId },
    );
    expect(result.success).toBe(true);
    const followup = await prisma.balanceTransaction.findFirstOrThrow({
      where: {
        billingAccountId: subject.billingAccountId,
        description: 'future-online-clock-floor-followup',
      },
    });
    expect(followup.createdAt.getTime()).toBeGreaterThanOrEqual(futureFloor.getTime());
  });

  it('keeps enterprise admin-recharge timestamps in UTC under a non-UTC database session', async () => {
    const id = randomUUID();
    const userId = `bgc-timezone-user-${id}`;
    const tenantId = `bgc-timezone-tenant-${id}`;
    const billingAccountId = `bgc-timezone-account-${id}`;
    const startedAt = Date.now();
    const zonedPrisma = withTransactionLocalTimeZone(
      moduleRef.get(PrismaService),
      'Asia/Shanghai',
    );
    const zonedService = new BillingService(
      new BillingRepository(zonedPrisma),
      moduleRef.get(RedisService),
      zonedPrisma,
    );

    const account = await zonedPrisma.$transaction(async (db) => {
      await db.user.create({
        data: {
          id: userId,
          email: `${userId}@example.test`,
          nickname: 'Financial Clock Timezone User',
        },
      });
      const createdAccount = await db.billingAccount.create({
        data: {
          id: billingAccountId,
          type: 'enterprise',
          name: 'Financial clock timezone enterprise',
          ownerUserId: userId,
          status: 'active',
          currency: 'USD',
          balanceGrantLedgerStatus: 'RECONCILED_V2',
          balanceGrantLedgerVersion: 2,
          balanceGrantLedgerHash: 'EMPTY_V2',
          balanceGrantLedgerReconciledAt: new Date(0),
        },
        select: { balanceGrantLedgerReconciledAt: true },
      });
      await db.tenant.create({
        data: {
          id: tenantId,
          name: 'Financial clock timezone tenant',
          type: 'enterprise',
          status: 'active',
          ownerUserId: userId,
          billingAccountId,
          balanceAllowanceUsedUsd: new Prisma.Decimal(0),
        },
      });
      await db.user.update({
        where: { id: userId },
        data: { currentTenantId: tenantId },
      });
      await db.tenantMember.create({
        data: {
          id: `bgc-timezone-tm-${id}`,
          tenantId,
          userId,
          role: 'owner',
          status: 'active',
        },
      });
      await db.billingAccountMember.create({
        data: {
          id: `bgc-timezone-bam-${id}`,
          billingAccountId,
          userId,
          role: 'owner',
          status: 'active',
        },
      });
      await db.accountWallet.create({
        data: {
          billingAccountId,
          balanceUsd: new Prisma.Decimal(0),
        },
      });
      return createdAccount;
    });

    const returned = await zonedService.adminRecharge(
      userId,
      50,
      'non-UTC session enterprise funding',
      undefined,
      {
        tenantId,
        idempotencyKey: `bgc-timezone-funding-${id}`,
      },
    );
    const finishedAt = Date.now();
    const persisted = await prisma.balanceTransaction.findUniqueOrThrow({
      where: { id: returned.id },
    });
    const grantOperationPrefix = 'balance:admin-recharge:grant:';
    expect(persisted.operationKey?.startsWith(grantOperationPrefix)).toBe(true);
    const grant = await prisma.balanceGrant.findUniqueOrThrow({
      where: { id: persisted.operationKey!.slice(grantOperationPrefix.length) },
    });
    const details = await zonedService.getCreditDetails(userId, {
      creditPage: 1,
      voucherPage: 1,
      pageSize: 20,
    }, { tenantId });
    const detail = details.credits.items.find((item) => item.grantId === grant.id);

    expect(account.balanceGrantLedgerReconciledAt).not.toBeNull();
    expect(returned.createdAt).toBe(persisted.createdAt.toISOString());
    expect(grant.createdAt.toISOString()).toBe(persisted.createdAt.toISOString());
    expect(grant.validFrom.toISOString()).toBe(persisted.createdAt.toISOString());
    expect(detail?.createdAt).toBe(persisted.createdAt.toISOString());
    for (const observedAt of [
      account.balanceGrantLedgerReconciledAt!,
      persisted.createdAt,
      grant.createdAt,
      grant.validFrom,
    ]) {
      expect(observedAt.getTime()).toBeGreaterThanOrEqual(startedAt - 1_000);
      expect(observedAt.getTime()).toBeLessThanOrEqual(finishedAt + 1_000);
    }

    subject = {
      userId,
      tenantId,
      billingAccountId,
      balanceGrantId: grant.id,
    };
  });

  it('fails expiry closed unless both the account marker and transaction-local writer are V2', async () => {
    subject = await createSubject(prisma, service, INITIAL_USD, true);
    const transactionCountBefore = await prisma.balanceTransaction.count({
      where: { billingAccountId: subject.billingAccountId },
    });

    // A clean marker alone is insufficient: an old worker cannot opt into the
    // new exact expiry path, and every earlier write in its transaction rolls
    // back with the trigger error.
    await expectPostgresSqlState(prisma.$transaction(async (db) => {
      await db.accountWallet.update({
        where: { billingAccountId: subject!.billingAccountId },
        data: { balanceUsd: { decrement: new Prisma.Decimal(1) } },
      });
      await db.balanceTransaction.create({
        data: {
          operationKey: `bgc-old-expiry-${randomUUID()}`,
          userId: subject!.userId,
          tenantId: subject!.tenantId,
          billingAccountId: subject!.billingAccountId,
          type: TransactionType.ADJUST,
          amountUsd: new Prisma.Decimal(-1),
          balanceAfterUsd: INITIAL_USD.minus(1),
          description: 'old expiry writer must roll back',
        },
      });
      await db.balanceGrant.update({
        where: { id: subject!.balanceGrantId },
        data: {
          remainingAmountUsd: new Prisma.Decimal(0),
          remainingPaidAmountUsd: new Prisma.Decimal(0),
          remainingBonusAmountUsd: new Prisma.Decimal(0),
          isExpired: true,
        },
      });
      await db.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    }), '23514');

    let [wallet, grant, transactionCount] = await Promise.all([
      prisma.accountWallet.findUniqueOrThrow({
        where: { billingAccountId: subject.billingAccountId },
      }),
      prisma.balanceGrant.findUniqueOrThrow({ where: { id: subject.balanceGrantId } }),
      prisma.balanceTransaction.count({
        where: { billingAccountId: subject.billingAccountId },
      }),
    ]);
    expect(wallet.balanceUsd.toFixed(12)).toBe(INITIAL_USD.toFixed(12));
    expect(grant.isExpired).toBe(false);
    expect(transactionCount).toBe(transactionCountBefore);

    // A caller with the V2 token and a structurally complete expiry bundle
    // still cannot smuggle an issuance rewrite through the first FALSE -> TRUE
    // transition. The audit is built from the legitimate OLD remainder while
    // the UPDATE tries to manufacture a different gross/source snapshot.
    await expectPostgresSqlState(prisma.$transaction(async (db) => {
      await db.$executeRaw`SET LOCAL billing.balance_grant_expiry_writer = 'v2'`;
      const occurredAt = await lockFixtureLedgerAndCaptureFinancialNow(
        db,
        subject!.billingAccountId,
      );
      await db.accountWallet.update({
        where: { billingAccountId: subject!.billingAccountId },
        data: { balanceUsd: { decrement: INITIAL_USD } },
      });
      const expiryTransaction = await db.balanceTransaction.create({
        data: {
          operationKey: `balance:grant-expiry:${subject!.balanceGrantId}`,
          userId: subject!.userId,
          tenantId: subject!.tenantId,
          billingAccountId: subject!.billingAccountId,
          type: TransactionType.ADJUST,
          amountUsd: INITIAL_USD.neg(),
          balanceAfterUsd: new Prisma.Decimal(0),
          description: `balance grant expired:${subject!.balanceGrantId}`,
          createdAt: occurredAt,
        },
      });
      await db.balanceGrantExpiry.create({
        data: {
          balanceGrantId: subject!.balanceGrantId,
          billingAccountId: subject!.billingAccountId,
          balanceTransactionId: expiryTransaction.id,
          nominalAmountUsd: INITIAL_USD,
          nominalPaidUsd: INITIAL_USD,
          nominalBonusUsd: new Prisma.Decimal(0),
          walletDebitUsd: INITIAL_USD,
          walletDebitPaidUsd: INITIAL_USD,
          walletDebitBonusUsd: new Prisma.Decimal(0),
          unbackedAmountUsd: new Prisma.Decimal(0),
          unbackedPaidUsd: new Prisma.Decimal(0),
          unbackedBonusUsd: new Prisma.Decimal(0),
          walletBalanceBeforeUsd: INITIAL_USD,
          walletBalanceAfterUsd: new Prisma.Decimal(0),
          createdAt: occurredAt,
        },
      });
      await db.balanceGrant.update({
        where: { id: subject!.balanceGrantId },
        data: {
          source: 'VOUCHER',
          paidAmountUsd: INITIAL_USD.plus(1),
          grantedAmountUsd: INITIAL_USD.plus(1),
          remainingAmountUsd: new Prisma.Decimal(0),
          remainingPaidAmountUsd: new Prisma.Decimal(0),
          remainingBonusAmountUsd: new Prisma.Decimal(0),
          isExpired: true,
        },
      });
      await db.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    }), '23514');

    [wallet, grant, transactionCount] = await Promise.all([
      prisma.accountWallet.findUniqueOrThrow({
        where: { billingAccountId: subject.billingAccountId },
      }),
      prisma.balanceGrant.findUniqueOrThrow({ where: { id: subject.balanceGrantId } }),
      prisma.balanceTransaction.count({
        where: { billingAccountId: subject.billingAccountId },
      }),
    ]);
    expect(wallet.balanceUsd.toFixed(12)).toBe(INITIAL_USD.toFixed(12));
    expect(grant.source).toBe('RECHARGE');
    expect(grant.paidAmountUsd.toFixed(12)).toBe(INITIAL_USD.toFixed(12));
    expect(grant.isExpired).toBe(false);
    expect(transactionCount).toBe(transactionCountBefore);

    // The token only identifies the V2 code path. It is not accounting proof:
    // atomically zeroing the grant without the wallet debit, ADJUST transaction
    // and expiry audit must still fail at deferred COMMIT and roll back.
    await expectPostgresSqlState(prisma.$transaction(async (db) => {
      await db.$executeRaw`SET LOCAL billing.balance_grant_expiry_writer = 'v2'`;
      await lockFixtureLedgerAndCaptureFinancialNow(db, subject!.billingAccountId);
      await db.balanceGrant.update({
        where: { id: subject!.balanceGrantId },
        data: {
          remainingAmountUsd: new Prisma.Decimal(0),
          remainingPaidAmountUsd: new Prisma.Decimal(0),
          remainingBonusAmountUsd: new Prisma.Decimal(0),
          isExpired: true,
        },
      });
      await db.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    }), '23514');

    grant = await prisma.balanceGrant.findUniqueOrThrow({ where: { id: subject.balanceGrantId } });
    expect(grant.isExpired).toBe(false);
    expect(grant.remainingAmountUsd.toFixed(12)).toBe(INITIAL_USD.toFixed(12));

    // SET LOCAL must not leak out of the failed V2 transaction. A new
    // transaction without the writer token is rejected again with the same
    // database SQLSTATE.
    await expectPostgresSqlState(
      prisma.$transaction(async (db) => {
        await db.balanceGrant.update({
          where: { id: subject!.balanceGrantId },
          data: { isExpired: true },
        });
        await db.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      }),
      '23514',
    );

    await prisma.billingAccount.update({
      where: { id: subject.billingAccountId },
      data: {
        balanceGrantLedgerStatus: 'LEGACY_DIRTY',
        balanceGrantLedgerVersion: 0,
        balanceGrantLedgerHash: null,
        balanceGrantLedgerReconciledAt: null,
        balanceGrantLedgerDirtyReason: 'integration-test-dirty-marker',
      },
    });

    // The token is not a bypass: a dirty account must still fail, with the
    // wallet mutation in the same transaction rolled back.
    await expectPostgresSqlState(prisma.$transaction(async (db) => {
      await db.$executeRaw`SET LOCAL billing.balance_grant_expiry_writer = 'v2'`;
      await lockFixtureLedgerAndCaptureFinancialNow(db, subject!.billingAccountId);
      await db.accountWallet.update({
        where: { billingAccountId: subject!.billingAccountId },
        data: { balanceUsd: { decrement: new Prisma.Decimal(1) } },
      });
      await db.balanceTransaction.create({
        data: {
          operationKey: `bgc-dirty-expiry-${randomUUID()}`,
          userId: subject!.userId,
          tenantId: subject!.tenantId,
          billingAccountId: subject!.billingAccountId,
          type: TransactionType.ADJUST,
          amountUsd: new Prisma.Decimal(-1),
          balanceAfterUsd: INITIAL_USD.minus(1),
          description: 'dirty expiry writer must roll back',
        },
      });
      await db.balanceGrant.update({
        where: { id: subject!.balanceGrantId },
        data: {
          remainingAmountUsd: new Prisma.Decimal(0),
          remainingPaidAmountUsd: new Prisma.Decimal(0),
          remainingBonusAmountUsd: new Prisma.Decimal(0),
          isExpired: true,
        },
      });
    }), '23514');

    [wallet, grant, transactionCount] = await Promise.all([
      prisma.accountWallet.findUniqueOrThrow({
        where: { billingAccountId: subject.billingAccountId },
      }),
      prisma.balanceGrant.findUniqueOrThrow({ where: { id: subject.balanceGrantId } }),
      prisma.balanceTransaction.count({
        where: { billingAccountId: subject.billingAccountId },
      }),
    ]);
    expect(wallet.balanceUsd.toFixed(12)).toBe(INITIAL_USD.toFixed(12));
    expect(grant.isExpired).toBe(false);
    expect(transactionCount).toBe(transactionCountBefore);
  });

  it('keeps the exact reported +1.00 -1.34 +5.00 -4.66 +5.00 -5.14 ledger sequence', async () => {
    subject = await createSubject(prisma, service, new Prisma.Decimal('1'));

    const firstUse = await service.deduct(
      subject.userId,
      new Prisma.Decimal('1.34'),
      'reported-sequence-first-use',
      { tenantId: subject.tenantId, allowNegativeBalance: true },
    );
    expect(firstUse).toMatchObject({ success: true, balance: -34, balanceUsd: -0.34 });

    const secondRechargeOrderId = `bgc-order-${randomUUID()}`;
    await createPaidRechargeOrder(prisma, subject, secondRechargeOrderId, 500);
    await service.rechargeWithBonus(
      subject.userId,
      500,
      0,
      'reported-sequence-second-recharge',
      secondRechargeOrderId,
      undefined,
      { tenantId: subject.tenantId },
    );

    let [wallet, grants, debt, settlements] = await Promise.all([
      prisma.accountWallet.findUniqueOrThrow({
        where: { billingAccountId: subject.billingAccountId },
      }),
      prisma.balanceGrant.findMany({
        where: { billingAccountId: subject.billingAccountId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      prisma.balanceConsumptionAllocation.findMany({
        where: {
          billingAccountId: subject.billingAccountId,
          source: 'NEGATIVE_BALANCE',
        },
      }),
      prisma.enterpriseCreditSettlement.findMany({
        where: {
          billingAccountId: subject.billingAccountId,
          debtSource: 'NEGATIVE_BALANCE',
        },
      }),
    ]);

    expect(wallet.balanceUsd.toFixed(12)).toBe('4.660000000000');
    expect(grants).toHaveLength(2);
    expect(grants[0].remainingAmountUsd.toFixed(12)).toBe('0.000000000000');
    expect(grants[1].grantedAmountUsd.toFixed(12)).toBe('5.000000000000');
    expect(grants[1].remainingAmountUsd.toFixed(12)).toBe('4.660000000000');
    expect(grants[1].remainingPaidAmountUsd?.toFixed(12)).toBe('4.660000000000');
    expect(debt).toHaveLength(1);
    expect(debt[0].amountUsd.toFixed(12)).toBe('0.340000000000');
    expect(debt[0].settledUsd.toFixed(12)).toBe('0.340000000000');
    expect(debt[0].recognizedRevenueUsd.toFixed(12)).toBe('0.340000000000');
    expect(settlements).toHaveLength(1);
    expect(settlements[0].paidUsd.toFixed(12)).toBe('0.340000000000');
    expect(settlements[0].bonusUsd.toFixed(12)).toBe('0.000000000000');

    const secondUse = await service.deduct(
      subject.userId,
      new Prisma.Decimal('4.66'),
      'reported-sequence-second-use',
      { tenantId: subject.tenantId, allowNegativeBalance: true },
    );
    expect(secondUse).toMatchObject({ success: true, balance: 0, balanceUsd: 0 });

    const thirdRechargeOrderId = `bgc-order-${randomUUID()}`;
    await createPaidRechargeOrder(prisma, subject, thirdRechargeOrderId, 500);
    await service.rechargeWithBonus(
      subject.userId,
      500,
      0,
      'reported-sequence-third-recharge',
      thirdRechargeOrderId,
      undefined,
      { tenantId: subject.tenantId },
    );
    const thirdUse = await service.deduct(
      subject.userId,
      new Prisma.Decimal('5.14'),
      'reported-sequence-third-use',
      { tenantId: subject.tenantId, allowNegativeBalance: true },
    );
    expect(thirdUse).toMatchObject({ success: true, balance: -14, balanceUsd: -0.14 });

    let consumeAllocations: Array<{ amountUsd: Prisma.Decimal }>;
    [wallet, grants, debt, consumeAllocations] = await Promise.all([
      prisma.accountWallet.findUniqueOrThrow({
        where: { billingAccountId: subject.billingAccountId },
      }),
      prisma.balanceGrant.findMany({
        where: { billingAccountId: subject.billingAccountId },
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      }),
      prisma.balanceConsumptionAllocation.findMany({
        where: {
          billingAccountId: subject.billingAccountId,
          source: 'NEGATIVE_BALANCE',
        },
        orderBy: [{ ledgerSequence: 'asc' }, { id: 'asc' }],
      }),
      prisma.balanceConsumptionAllocation.findMany({
        where: { billingAccountId: subject.billingAccountId },
      }),
    ]);

    const activeGrantUsd = sumDecimals(
      grants.filter((grant) => !grant.isExpired),
      (grant) => grant.remainingAmountUsd,
    );
    const openDebtUsd = sumDecimals(
      debt,
      (allocation) => allocation.amountUsd.minus(allocation.settledUsd),
    );
    const totalRechargeUsd = sumDecimals(grants, (grant) => grant.grantedAmountUsd);
    const totalConsumedUsd = sumDecimals(
      consumeAllocations,
      (allocation) => allocation.amountUsd,
    );
    expect(wallet.balanceUsd.toFixed(12)).toBe('-0.140000000000');
    expect(grants).toHaveLength(3);
    expect(grants.map((grant) => grant.remainingAmountUsd.toFixed(12))).toEqual([
      '0.000000000000',
      '0.000000000000',
      '0.000000000000',
    ]);
    expect(totalRechargeUsd.toFixed(12)).toBe('11.000000000000');
    expect(totalConsumedUsd.toFixed(12)).toBe('11.140000000000');
    expect(debt).toHaveLength(2);
    expect(debt[0].amountUsd.toFixed(12)).toBe('0.340000000000');
    expect(debt[0].settledUsd.toFixed(12)).toBe('0.340000000000');
    expect(debt[1].amountUsd.toFixed(12)).toBe('0.140000000000');
    expect(debt[1].settledUsd.toFixed(12)).toBe('0.000000000000');
    expect(activeGrantUsd.toFixed(12)).toBe('0.000000000000');
    expect(openDebtUsd.toFixed(12)).toBe('0.140000000000');
    expect(activeGrantUsd.minus(openDebtUsd).toFixed(12)).toBe(
      wallet.balanceUsd.toFixed(12),
    );

    const [summary, details] = await Promise.all([
      service.getCreditsSummary(subject.userId, { tenantId: subject.tenantId }),
      service.getCreditDetails(subject.userId, {
        creditPage: 1,
        voucherPage: 1,
        pageSize: 20,
      }, { tenantId: subject.tenantId }),
    ]);
    expect(summary.balanceCents).toBe(-14);
    expect(summary.balanceAmount).toBe('-0.140000000000');
    expect(summary.totalRechargeCents).toBe(1100);
    expect(details.credits.total).toBe(3);
    expect(details.credits.items).toHaveLength(3);
    expect(details.credits.items.every((item) => item.remainingCents === 0)).toBe(true);
    expect(details.credits.items.every((item) => item.status === 'USED_UP')).toBe(true);
  });

  it('includes paid negative-balance settlements exactly once in recharge invoice principal', async () => {
    subject = await createSubject(prisma, service, new Prisma.Decimal('1'));
    const periodStart = new Date(Date.now() - 24 * 60 * 60 * 1000);
    const invoiceablePaidAt = new Date(Date.now() - 48 * 60 * 60 * 1000);

    await service.deduct(
      subject.userId,
      new Prisma.Decimal('1.6'),
      'invoice-settlement-first-use',
      { tenantId: subject.tenantId, allowNegativeBalance: true },
    );
    await service.deduct(
      subject.userId,
      new Prisma.Decimal('1.4'),
      'invoice-settlement-second-use',
      { tenantId: subject.tenantId, allowNegativeBalance: true },
    );

    // One paid dollar settles two debt allocations; the bonus settles the
    // remainder but must never become invoiceable principal.
    const mixedSettlementOrderId = `bgc-invoice-mixed-${randomUUID()}`;
    await createPaidRechargeOrder(
      prisma,
      subject,
      mixedSettlementOrderId,
      100,
      { currency: 'cny', bonusCents: 50, paidAt: invoiceablePaidAt },
    );
    await service.rechargeWithBonus(
      subject.userId,
      100,
      50,
      'invoice-settlement-mixed-recharge',
      mixedSettlementOrderId,
      undefined,
      { tenantId: subject.tenantId },
    );

    // The next paid dollar is split between the old debt and a later direct
    // BALANCE_GRANT allocation. The invoice reader must union both facts once.
    const splitConsumptionOrderId = `bgc-invoice-split-${randomUUID()}`;
    await createPaidRechargeOrder(
      prisma,
      subject,
      splitConsumptionOrderId,
      100,
      { currency: 'cny', paidAt: invoiceablePaidAt },
    );
    await service.rechargeWithBonus(
      subject.userId,
      100,
      0,
      'invoice-settlement-split-recharge',
      splitConsumptionOrderId,
      undefined,
      { tenantId: subject.tenantId },
    );
    await service.deduct(
      subject.userId,
      new Prisma.Decimal('0.5'),
      'invoice-settlement-direct-use',
      { tenantId: subject.tenantId, allowNegativeBalance: true },
    );

    // Refund a fully consumed grant while another grant is active. The refund
    // debt is netted against that grant, but REFUND_NETTING is not new paid use.
    const refundNettingOrderId = `bgc-invoice-refund-netting-${randomUUID()}`;
    await createPaidRechargeOrder(
      prisma,
      subject,
      refundNettingOrderId,
      50,
      { currency: 'cny', paidAt: invoiceablePaidAt },
    );
    await service.rechargeWithBonus(
      subject.userId,
      50,
      0,
      'invoice-settlement-refund-netting-recharge',
      refundNettingOrderId,
      undefined,
      { tenantId: subject.tenantId },
    );
    await service.refundBalance(
      subject.userId,
      50,
      'invoice-settlement-refund',
      splitConsumptionOrderId,
      undefined,
      {
        tenantId: subject.tenantId,
        billingAccountId: subject.billingAccountId,
        refundComponent: 'PAID',
        idempotencyKey: `bgc-invoice-refund-${randomUUID()}`,
      },
    );

    const settlements = await prisma.enterpriseCreditSettlement.findMany({
      where: {
        billingAccountId: subject.billingAccountId,
        balanceGrant: {
          orderId: {
            in: [
              mixedSettlementOrderId,
              splitConsumptionOrderId,
              refundNettingOrderId,
            ],
          },
        },
      },
      select: {
        trigger: true,
        paidUsd: true,
        bonusUsd: true,
        balanceGrant: { select: { orderId: true } },
      },
    });
    const mixedSettlements = settlements.filter(
      (row) => row.balanceGrant?.orderId === mixedSettlementOrderId,
    );
    expect(mixedSettlements.filter((row) => row.trigger === 'FUNDING')).toHaveLength(3);
    expect(sumDecimals(mixedSettlements, (row) => row.paidUsd).toFixed(12)).toBe(
      '1.000000000000',
    );
    expect(sumDecimals(mixedSettlements, (row) => row.bonusUsd).toFixed(12)).toBe(
      '0.500000000000',
    );

    const splitSettlements = settlements.filter(
      (row) => row.balanceGrant?.orderId === splitConsumptionOrderId,
    );
    expect(splitSettlements).toHaveLength(1);
    expect(splitSettlements[0].trigger).toBe('FUNDING');
    expect(splitSettlements[0].paidUsd.toFixed(12)).toBe('0.500000000000');

    const refundNettingSettlements = settlements.filter(
      (row) => row.balanceGrant?.orderId === refundNettingOrderId,
    );
    expect(refundNettingSettlements).toHaveLength(1);
    expect(refundNettingSettlements[0].trigger).toBe('REFUND_NETTING');
    expect(refundNettingSettlements[0].paidUsd.toFixed(12)).toBe('0.500000000000');

    const invoiceSource = new InvoiceSourceService(prisma);
    const periodRows = await invoiceSource.listDomesticPeriodRows({
      userId: subject.userId,
      tenantId: subject.tenantId,
      billingAccountId: subject.billingAccountId,
      start: periodStart,
      end: new Date(Date.now() + 24 * 60 * 60 * 1000),
    });
    const rowsByOrder = new Map(periodRows.map((row) => [row.orderId, row]));
    expect(rowsByOrder.get(mixedSettlementOrderId)).toMatchObject({
      totalBaseCents: 100,
      periodConsumedPrincipalCents: 100,
      totalConsumedPrincipalCents: 100,
      recordCount: 2,
    });
    expect(rowsByOrder.get(splitConsumptionOrderId)).toMatchObject({
      totalBaseCents: 100,
      periodConsumedPrincipalCents: 100,
      totalConsumedPrincipalCents: 100,
      recordCount: 2,
    });
    expect(rowsByOrder.has(refundNettingOrderId)).toBe(false);

    const invoiceOrders = await invoiceSource.findOrdersByIds({
      userId: subject.userId,
      tenantId: subject.tenantId,
      orderIds: [
        mixedSettlementOrderId,
        splitConsumptionOrderId,
        refundNettingOrderId,
      ],
    });
    const bases = await invoiceSource.computeBasesForOrders(invoiceOrders);
    expect(bases.get(mixedSettlementOrderId)).toEqual({
      baseCents: 100,
      consumedPrincipalCents: 100,
    });
    expect(bases.get(splitConsumptionOrderId)).toEqual({
      baseCents: 100,
      consumedPrincipalCents: 100,
    });
    expect(bases.get(refundNettingOrderId)).toEqual({
      baseCents: 50,
      consumedPrincipalCents: 0,
    });
  }, 30_000);

  it('accepts a strictly proven delayed legacy enterprise settlement at deferred COMMIT', async () => {
    const fixture = await createLegacyEnterpriseSettlementFixture(prisma);

    await prisma.$transaction(async (db) => {
      expect(await writeLegacyEnterpriseSettlement(
        db,
        fixture,
        `legacy:${fixture.settlementId}`,
      )).toBe(true);
      // Deliberately do not force constraints here: transaction COMMIT must
      // execute both initially-deferred conservation triggers successfully.
    });

    const allocation = await prisma.balanceConsumptionAllocation.findUniqueOrThrow({
      where: { id: fixture.allocationId },
    });
    expect(allocation.settledUsd.toFixed(12)).toBe('1.000000000000');
    expect(await prisma.enterpriseCreditSettlement.count({
      where: { id: fixture.settlementId },
    })).toBe(1);
  });

  it('accepts a strictly proven delayed legacy enterprise settlement when constraints are immediate', async () => {
    const fixture = await createLegacyEnterpriseSettlementFixture(prisma);

    await prisma.$transaction(async (db) => {
      expect(await writeLegacyEnterpriseSettlement(
        db,
        fixture,
        `legacy:${fixture.settlementId}`,
      )).toBe(true);
      await db.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    });

    const allocation = await prisma.balanceConsumptionAllocation.findUniqueOrThrow({
      where: { id: fixture.allocationId },
    });
    expect(allocation.settledUsd.toFixed(12)).toBe('1.000000000000');
    expect(await prisma.enterpriseCreditSettlement.count({
      where: { id: fixture.settlementId },
    })).toBe(1);
  });

  it('rolls back a delayed enterprise settlement when the strict legacy proof is incomplete', async () => {
    const fixture = await createLegacyEnterpriseSettlementFixture(prisma);

    await expectPostgresSqlState(prisma.$transaction(async (db) => {
      expect(await writeLegacyEnterpriseSettlement(
        db,
        fixture,
        `unproven-legacy:${fixture.settlementId}`,
      )).toBe(false);
      await db.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
    }), '23514');

    const allocation = await prisma.balanceConsumptionAllocation.findUniqueOrThrow({
      where: { id: fixture.allocationId },
    });
    expect(allocation.settledUsd.toFixed(12)).toBe('0.000000000000');
    expect(await prisma.enterpriseCreditSettlement.count({
      where: { id: fixture.settlementId },
    })).toBe(0);
  });

  it('expires one due grant exactly once when two sweep workers race', async () => {
    const now = new Date();
    // Earlier adversarial cases intentionally retain their append-only fixtures
    // in this disposable database. Drain those candidates before measuring the
    // exact result of this account's two-worker race.
    await service.sweepExpiredBalanceGrants(now, 1000);
    subject = await createSubject(
      prisma,
      service,
      INITIAL_USD,
      true,
    );
    const raceNow = await sweepCutoffAfterGrantExpiry(prisma, subject.balanceGrantId);

    const results = await Promise.all([
      service.sweepExpiredBalanceGrants(raceNow, 10),
      service.sweepExpiredBalanceGrants(raceNow, 10),
    ]);

    expect(results.reduce((sum, result) => sum + result.expired, 0)).toBe(1);
    expect(await prisma.balanceGrantExpiry.count({
      where: { billingAccountId: subject.billingAccountId },
    })).toBe(1);
    expect(await prisma.balanceTransaction.count({
      where: {
        billingAccountId: subject.billingAccountId,
        operationKey: `balance:grant-expiry:${subject.balanceGrantId}`,
      },
    })).toBe(1);
    await expectExactLedgerInvariant(prisma, subject.billingAccountId);
  }, 30_000);

  it('expires every due grant for one account atomically even when the page limit is one', async () => {
    await service.sweepExpiredBalanceGrants(new Date(), 1000);
    subject = await createSubject(
      prisma,
      service,
      new Prisma.Decimal(3),
      true,
      [new Prisma.Decimal(2)],
    );
    const now = await sweepCutoffAfterGrantExpiry(prisma, subject.balanceGrantId);

    const result = await service.sweepExpiredBalanceGrants(now, 1);
    const [wallet, grants, audits, adjustments] = await Promise.all([
      prisma.accountWallet.findUniqueOrThrow({
        where: { billingAccountId: subject.billingAccountId },
      }),
      prisma.balanceGrant.findMany({
        where: { billingAccountId: subject.billingAccountId },
        orderBy: { id: 'asc' },
      }),
      prisma.balanceGrantExpiry.findMany({
        where: { billingAccountId: subject.billingAccountId },
      }),
      prisma.balanceTransaction.findMany({
        where: {
          billingAccountId: subject.billingAccountId,
          operationKey: { startsWith: 'balance:grant-expiry:' },
        },
      }),
    ]);

    expect(result.scanned).toBe(1);
    expect(result.expired).toBe(2);
    expect(result.failed).toBe(0);
    expect(result.totalExpiredUsd).toBe(5);
    expect(wallet.balanceUsd.toFixed(12)).toBe('0.000000000000');
    expect(grants).toHaveLength(2);
    expect(grants.every((grant) => grant.isExpired && grant.remainingAmountUsd.eq(0))).toBe(true);
    expect(audits).toHaveLength(2);
    expect(adjustments).toHaveLength(2);
    expect(new Set(audits.map((audit) => audit.balanceGrantId)).size).toBe(2);
    expect(new Set(adjustments.map((transaction) => transaction.operationKey)).size).toBe(2);
    await expectExactLedgerInvariant(prisma, subject.billingAccountId);
  }, 30_000);

  it('does not duplicate either due grant when two account-level sweep workers race', async () => {
    await service.sweepExpiredBalanceGrants(new Date(), 1000);
    subject = await createSubject(
      prisma,
      service,
      new Prisma.Decimal(3),
      true,
      [new Prisma.Decimal(2)],
    );
    const now = await sweepCutoffAfterGrantExpiry(prisma, subject.balanceGrantId);

    const results = await Promise.all([
      service.sweepExpiredBalanceGrants(now, 1),
      service.sweepExpiredBalanceGrants(now, 1),
    ]);

    expect(results.reduce((sum, result) => sum + result.expired, 0)).toBe(2);
    expect(await prisma.balanceGrantExpiry.count({
      where: { billingAccountId: subject.billingAccountId },
    })).toBe(2);
    expect(await prisma.balanceTransaction.count({
      where: {
        billingAccountId: subject.billingAccountId,
        operationKey: { startsWith: 'balance:grant-expiry:' },
      },
    })).toBe(2);
    await expectExactLedgerInvariant(prisma, subject.billingAccountId);
  }, 30_000);

  it('expires all due grants while preserving a future grant and its wallet backing', async () => {
    await service.sweepExpiredBalanceGrants(new Date(), 1000);
    subject = await createSubject(
      prisma,
      service,
      new Prisma.Decimal(3),
      true,
      [new Prisma.Decimal(2)],
      new Prisma.Decimal(5),
    );
    const now = await sweepCutoffAfterGrantExpiry(prisma, subject.balanceGrantId);

    const result = await service.sweepExpiredBalanceGrants(now, 1);
    const [wallet, grants] = await Promise.all([
      prisma.accountWallet.findUniqueOrThrow({
        where: { billingAccountId: subject.billingAccountId },
      }),
      prisma.balanceGrant.findMany({
        where: { billingAccountId: subject.billingAccountId },
        orderBy: [{ expiresAt: 'asc' }, { id: 'asc' }],
      }),
    ]);

    expect(result.expired).toBe(2);
    expect(wallet.balanceUsd.toFixed(12)).toBe('5.000000000000');
    expect(grants).toHaveLength(3);
    expect(grants.slice(0, 2).every((grant) => grant.isExpired && grant.remainingAmountUsd.eq(0)))
      .toBe(true);
    expect(grants[2].isExpired).toBe(false);
    expect(grants[2].remainingAmountUsd.toFixed(12)).toBe('5.000000000000');
    await expectExactLedgerInvariant(prisma, subject.billingAccountId);
  }, 30_000);

  it('uses one locked financial time for on-demand expiry followed by consumption', async () => {
    subject = await createSubject(prisma, service, INITIAL_USD, true);

    const deduction = await service.deduct(
      subject.userId,
      DEDUCT_USD,
      'on-demand-expiry-clock',
      { tenantId: subject.tenantId, allowNegativeBalance: true },
    );
    expect(deduction.success).toBe(true);
    const transactions = await prisma.balanceTransaction.findMany({
      where: {
        billingAccountId: subject.billingAccountId,
        OR: [
          { operationKey: `balance:grant-expiry:${subject.balanceGrantId}` },
          { description: 'on-demand-expiry-clock' },
        ],
      },
      orderBy: { ledgerSequence: 'asc' },
    });

    expect(transactions).toHaveLength(2);
    expect(transactions[0].operationKey).toBe(`balance:grant-expiry:${subject.balanceGrantId}`);
    expect(transactions[1].description).toBe('on-demand-expiry-clock');
    expect(transactions[0].createdAt).toEqual(transactions[1].createdAt);
    expect(transactions[0].ledgerSequence! < transactions[1].ledgerSequence!).toBe(true);
    await expectExactLedgerInvariant(prisma, subject.billingAccountId);
  }, 30_000);

  it('preserves the exact ledger when due-grant expiry races a negative-enabled deduction', async () => {
    subject = await createSubject(
      prisma,
      service,
      INITIAL_USD,
      true,
    );
    const raceNow = await sweepCutoffAfterGrantExpiry(prisma, subject.balanceGrantId);

    const [expiry, deduction] = await Promise.allSettled([
      service.sweepExpiredBalanceGrants(raceNow, 10),
      service.deduct(
        subject.userId,
        new Prisma.Decimal('0.2'),
        'expiry-deduction-race',
        { tenantId: subject.tenantId, allowNegativeBalance: true },
      ),
    ]);

    expect(expiry.status).toBe('fulfilled');
    expect(deduction.status).toBe('fulfilled');
    if (deduction.status === 'fulfilled') expect(deduction.value.success).toBe(true);
    expect(await prisma.balanceGrantExpiry.count({
      where: { billingAccountId: subject.billingAccountId },
    })).toBe(1);
    await expectExactLedgerInvariant(prisma, subject.billingAccountId);
  }, 30_000);

  it('preserves the exact ledger when due-grant expiry races a recharge', async () => {
    subject = await createSubject(
      prisma,
      service,
      INITIAL_USD,
      true,
    );
    const raceNow = await sweepCutoffAfterGrantExpiry(prisma, subject.balanceGrantId);
    const rechargeOrderId = `bgc-race-order-${randomUUID()}`;
    await createPaidRechargeOrder(prisma, subject, rechargeOrderId, 500);

    const [expiry, recharge] = await Promise.allSettled([
      service.sweepExpiredBalanceGrants(raceNow, 10),
      service.rechargeWithBonus(
        subject.userId,
        500,
        0,
        'expiry-recharge-race',
        rechargeOrderId,
        undefined,
        { tenantId: subject.tenantId },
      ),
    ]);

    expect(expiry.status).toBe('fulfilled');
    expect(recharge.status).toBe('fulfilled');
    expect(await prisma.balanceGrantExpiry.count({
      where: { billingAccountId: subject.billingAccountId },
    })).toBe(1);
    await expectExactLedgerInvariant(prisma, subject.billingAccountId);
  }, 30_000);

  it('does not deadlock anchored recharge against deduct tenant allowance accounting', async () => {
    subject = await createSubject(prisma, service, INITIAL_USD);
    const rechargeOrderId = `bgc-lock-order-${randomUUID()}`;
    await prisma.order.create({
      data: {
        id: rechargeOrderId,
        userId: subject.userId,
        tenantId: subject.tenantId,
        billingAccountId: subject.billingAccountId,
        orderType: OrderType.RECHARGE,
        amountCents: 500,
        currency: 'usd',
        status: OrderStatus.FULFILLING,
        paidAt: new Date(),
      },
    });

    let signalWalletLocked!: () => void;
    let releaseWallet!: () => void;
    const walletLocked = new Promise<void>((resolve) => {
      signalWalletLocked = resolve;
    });
    const walletRelease = new Promise<void>((resolve) => {
      releaseWallet = resolve;
    });
    const blocker = prisma.$transaction(async (db) => {
      await db.$queryRaw`
        SELECT "balance_usd"
        FROM "account_wallets"
        WHERE "billing_account_id" = ${subject!.billingAccountId}
        FOR UPDATE
      `;
      signalWalletLocked();
      await walletRelease;
    }, { maxWait: 30_000, timeout: 30_000 });

    await walletLocked;
    let deduct: Promise<{ success: boolean; balance: number; balanceUsd: number }> | undefined;
    let recharge: Promise<unknown> | undefined;
    let orchestrationError: unknown;
    try {
      // Queue deduct on the wallet first. With the former reverse ordering,
      // recharge then owned tenant and queued behind deduct on wallet; once
      // this blocker released, deduct waited back on tenant and PostgreSQL
      // aborted one financial transaction with 40P01.
      deduct = service.deduct(subject.userId, new Prisma.Decimal(1), 'lock-order-deduct', {
        tenantId: subject.tenantId,
      });
      await waitForWalletRowLockWaiters(lockObserver, 1);
      recharge = service.rechargeWithBonus(
        subject.userId,
        500,
        0,
        'lock-order-recharge',
        rechargeOrderId,
        undefined,
        {
          tenantId: subject.tenantId,
          billingAccountId: subject.billingAccountId,
        },
      );
      await waitForWalletRowLockWaiters(lockObserver, 2);
    } catch (error) {
      orchestrationError = error;
    } finally {
      releaseWallet();
    }

    const [blockerResult, deductResult, rechargeResult] = await Promise.allSettled([
      blocker,
      deduct ?? Promise.reject(orchestrationError),
      recharge ?? Promise.reject(orchestrationError),
    ]);
    if (orchestrationError) throw orchestrationError;

    expect(blockerResult.status).toBe('fulfilled');
    expect(deductResult.status).toBe('fulfilled');
    expect(rechargeResult.status).toBe('fulfilled');
    if (deductResult.status === 'fulfilled') {
      expect(deductResult.value.success).toBe(true);
    }
    const failures = [deductResult, rechargeResult]
      .filter((result): result is PromiseRejectedResult => result.status === 'rejected')
      .map((result) => String(result.reason));
    expect(failures.join('\n')).not.toContain('40P01');

    const wallet = await prisma.accountWallet.findUniqueOrThrow({
      where: { billingAccountId: subject.billingAccountId },
    });
    expect(wallet.balanceUsd.toFixed(12)).toBe('14.000000000000');
    await expectExactLedgerInvariant(prisma, subject.billingAccountId);
  }, 30_000);

  it('rejects a queued deduction when account detach commits before its locked subject recheck', async () => {
    subject = await createSubject(prisma, service, INITIAL_USD);
    const id = randomUUID();
    const reboundAccountId = `bgc-rebound-account-${id}`;
    await prisma.billingAccount.create({
      data: {
        id: reboundAccountId,
        type: 'personal',
        name: 'Rebound personal account',
        ownerUserId: subject.userId,
        status: 'active',
        currency: 'USD',
        balanceGrantLedgerStatus: 'RECONCILED_V2',
        balanceGrantLedgerVersion: 2,
        balanceGrantLedgerHash: 'EMPTY_V2',
        balanceGrantLedgerReconciledAt: new Date(),
      },
    });
    await prisma.billingAccountMember.create({
      data: {
        id: `bgc-rebound-member-${id}`,
        billingAccountId: reboundAccountId,
        userId: subject.userId,
        role: 'owner',
        status: 'active',
      },
    });
    await prisma.accountWallet.create({
      data: { billingAccountId: reboundAccountId, balanceUsd: new Prisma.Decimal(0) },
    });

    const [walletBefore, grantsBefore, allowanceBefore, transactionsBefore, allocationsBefore] =
      await Promise.all([
        prisma.accountWallet.findUniqueOrThrow({
          where: { billingAccountId: subject.billingAccountId },
        }),
        prisma.balanceGrant.findMany({
          where: { billingAccountId: subject.billingAccountId },
          orderBy: { id: 'asc' },
        }),
        prisma.tenant.findUniqueOrThrow({
          where: { id: subject.tenantId },
          select: { balanceAllowanceUsedUsd: true },
        }),
        prisma.balanceTransaction.count({
          where: { billingAccountId: subject.billingAccountId },
        }),
        prisma.balanceConsumptionAllocation.count({
          where: { billingAccountId: subject.billingAccountId },
        }),
      ]);

    let signalLifecycleLocked!: () => void;
    let releaseLifecycle!: () => void;
    const lifecycleLocked = new Promise<void>((resolve) => {
      signalLifecycleLocked = resolve;
    });
    const lifecycleRelease = new Promise<void>((resolve) => {
      releaseLifecycle = resolve;
    });
    const lifecycle = prisma.$transaction(async (db) => {
      await db.$queryRaw`
        SELECT "balance_usd" FROM "account_wallets"
        WHERE "billing_account_id" = ${subject!.billingAccountId}
        FOR UPDATE`;
      await db.$queryRaw`
        SELECT "id" FROM "balance_grants"
        WHERE "billing_account_id" = ${subject!.billingAccountId}
        ORDER BY "id" ASC
        FOR UPDATE`;
      await db.$queryRaw`
        SELECT "id" FROM "billing_accounts"
        WHERE "id" = ${subject!.billingAccountId}
        FOR UPDATE`;
      await db.$queryRaw`
        SELECT "id" FROM "tenants"
        WHERE "id" = ${subject!.tenantId}
        FOR UPDATE`;
      signalLifecycleLocked();
      await lifecycleRelease;
      await db.tenant.update({
        where: { id: subject!.tenantId },
        data: { billingAccountId: reboundAccountId },
      });
    }, { maxWait: 30_000, timeout: 30_000 });

    await lifecycleLocked;
    const deduction = service.deduct(
      subject.userId,
      DEDUCT_USD,
      'detach-wins-deduction',
      { tenantId: subject.tenantId, allowNegativeBalance: true },
    );
    await waitForWalletRowLockWaiters(lockObserver, 1);
    releaseLifecycle();
    const [lifecycleResult, deductionResult] = await Promise.allSettled([lifecycle, deduction]);

    expect(lifecycleResult.status).toBe('fulfilled');
    expect(deductionResult.status).toBe('rejected');
    if (deductionResult.status === 'rejected') {
      expect(String(deductionResult.reason)).toContain('无权访问该账务账号');
      expect(String(deductionResult.reason)).not.toContain('40P01');
    }
    const [walletAfter, grantsAfter, allowanceAfter, transactionsAfter, allocationsAfter] =
      await Promise.all([
        prisma.accountWallet.findUniqueOrThrow({
          where: { billingAccountId: subject.billingAccountId },
        }),
        prisma.balanceGrant.findMany({
          where: { billingAccountId: subject.billingAccountId },
          orderBy: { id: 'asc' },
        }),
        prisma.tenant.findUniqueOrThrow({
          where: { id: subject.tenantId },
          select: { balanceAllowanceUsedUsd: true, billingAccountId: true },
        }),
        prisma.balanceTransaction.count({
          where: { billingAccountId: subject.billingAccountId },
        }),
        prisma.balanceConsumptionAllocation.count({
          where: { billingAccountId: subject.billingAccountId },
        }),
      ]);

    expect(allowanceAfter.billingAccountId).toBe(reboundAccountId);
    expect(walletAfter.balanceUsd.toFixed(12)).toBe(walletBefore.balanceUsd.toFixed(12));
    expect(grantsAfter.map((grant) => grant.remainingAmountUsd.toFixed(12))).toEqual(
      grantsBefore.map((grant) => grant.remainingAmountUsd.toFixed(12)),
    );
    expect(allowanceAfter.balanceAllowanceUsedUsd.toFixed(12))
      .toBe(allowanceBefore.balanceAllowanceUsedUsd.toFixed(12));
    expect(transactionsAfter).toBe(transactionsBefore);
    expect(allocationsAfter).toBe(allocationsBefore);
    await expectExactLedgerInvariant(prisma, subject.billingAccountId);
  }, 30_000);


  it('fails closed on pre-existing account aggregates with a missing wallet and leaves no partial writes', async () => {
    const id = randomUUID();
    const userId = `bgc-incomplete-user-${id}`;
    const tenantId = `bgc-incomplete-tenant-${id}`;
    const billingAccountId = `ba_personal_${userId}`;
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@example.test`,
        nickname: 'Incomplete aggregate user',
      },
    });
    await prisma.tenant.create({
      data: {
        id: tenantId,
        name: 'Incomplete aggregate tenant',
        type: 'personal',
        status: 'active',
        ownerUserId: userId,
      },
    });
    await prisma.user.update({
      where: { id: userId },
      data: { currentTenantId: tenantId },
    });
    await prisma.tenantMember.create({
      data: {
        id: `bgc-incomplete-tm-${id}`,
        tenantId,
        userId,
        role: 'owner',
        status: 'active',
      },
    });
    await prisma.billingAccount.create({
      data: {
        id: billingAccountId,
        type: 'personal',
        name: 'Incomplete personal account',
        ownerUserId: userId,
        status: 'active',
        currency: 'USD',
        balanceGrantLedgerStatus: 'RECONCILED_V2',
        balanceGrantLedgerVersion: 2,
        balanceGrantLedgerHash: 'EMPTY_V2',
        balanceGrantLedgerReconciledAt: new Date(),
      },
    });
    await prisma.billingAccountMember.create({
      data: {
        id: `bgc-incomplete-bam-${id}`,
        billingAccountId,
        userId,
        role: 'owner',
        status: 'active',
      },
    });

    let provisioningError: unknown;
    try {
      await service.resolveSubjectForUser(userId, tenantId);
    } catch (error) {
      provisioningError = error;
    }
    expect(provisioningError).toMatchObject({
      status: 409,
      response: { code: 'billing_account_not_provisioned' },
    });
    expect((await prisma.tenant.findUniqueOrThrow({ where: { id: tenantId } })).billingAccountId)
      .toBeNull();
    expect(await prisma.accountWallet.findUnique({ where: { billingAccountId } })).toBeNull();
    expect(await prisma.balanceGrant.count({ where: { billingAccountId } })).toBe(0);
    expect(await prisma.balanceTransaction.count({ where: { billingAccountId } })).toBe(0);

    const mirrorTenantId = `bgc-incomplete-mirror-tenant-${id}`;
    const workspaceMirror = new BillingWorkspaceMirrorService(
      prisma,
      new BillingUserMirrorService(prisma),
    );
    let mirrorError: unknown;
    try {
      await workspaceMirror.mirror({
        user: {
          id: userId,
          email: `${userId}@example.test`,
          nickname: 'Incomplete aggregate user',
        },
        tenant: {
          id: mirrorTenantId,
          name: 'Incomplete mirror tenant',
          type: 'team',
          status: 'active',
          ownerUserId: userId,
        },
        membership: {
          userId,
          role: 'owner',
          status: 'active',
        },
      });
    } catch (error) {
      mirrorError = error;
    }
    expect(mirrorError).toMatchObject({
      status: 409,
      response: { code: 'billing_account_not_provisioned' },
    });
    expect(await prisma.tenant.findUnique({ where: { id: mirrorTenantId } })).toBeNull();
    expect(await prisma.accountWallet.findUnique({ where: { billingAccountId } })).toBeNull();

    const enterpriseAccountId = `bgc-incomplete-enterprise-${id}`;
    await prisma.billingAccount.create({
      data: {
        id: enterpriseAccountId,
        type: 'enterprise',
        name: 'Incomplete enterprise account',
        ownerUserId: userId,
        status: 'active',
        currency: 'USD',
        balanceGrantLedgerStatus: 'RECONCILED_V2',
        balanceGrantLedgerVersion: 2,
        balanceGrantLedgerHash: 'EMPTY_V2',
        balanceGrantLedgerReconciledAt: new Date(),
      },
    });
    let sweepError: unknown;
    try {
      await service.sweepEnterpriseCreditResidualSettlement(enterpriseAccountId);
    } catch (error) {
      sweepError = error;
    }
    expect(sweepError).toMatchObject({
      status: 409,
      response: { code: 'billing_account_not_provisioned' },
    });
    expect(await prisma.enterpriseCreditSettlement.count({
      where: { billingAccountId: enterpriseAccountId },
    })).toBe(0);
  }, 30_000);
});

async function createPaidRechargeOrder(
  prisma: PrismaService,
  subject: TestSubject,
  orderId: string,
  amountCents: number,
  options: {
    bonusCents?: number;
    currency?: string;
    paidAt?: Date;
  } = {},
): Promise<void> {
  await prisma.order.create({
    data: {
      id: orderId,
      userId: subject.userId,
      tenantId: subject.tenantId,
      billingAccountId: subject.billingAccountId,
      orderType: OrderType.RECHARGE,
      amountCents,
      bonusCents: options.bonusCents ?? 0,
      currency: options.currency ?? 'usd',
      status: OrderStatus.PAID,
      paidAt: options.paidAt ?? new Date(),
    },
  });
}

type LegacyEnterpriseSettlementFixture = {
  billingAccountId: string;
  allocationId: string;
  fundingTransactionId: string;
  settlementId: string;
  settlementAt: Date;
};

async function createLegacyEnterpriseSettlementFixture(
  prisma: PrismaService,
): Promise<LegacyEnterpriseSettlementFixture> {
  const id = randomUUID();
  const userId = `bgc-legacy-enterprise-user-${id}`;
  const tenantId = `bgc-legacy-enterprise-tenant-${id}`;
  const billingAccountId = `bgc-legacy-enterprise-account-${id}`;
  const orderId = `bgc-legacy-enterprise-order-${id}`;
  const grantId = `bgc-legacy-enterprise-grant-${id}`;
  const consumeTransactionId = `bgc-legacy-enterprise-consume-${id}`;
  const fundingTransactionId = `bgc-legacy-enterprise-funding-${id}`;
  const allocationId = `bgc-legacy-enterprise-allocation-${id}`;
  const settlementId = `bgc-legacy-enterprise-settlement-${id}`;
  const baseTime = Date.now() - 60_000;
  const orderCreatedAt = new Date(baseTime);
  const paidAt = new Date(baseTime + 100);
  const consumptionAt = new Date(baseTime + 200);
  const fundingAt = new Date(baseTime + 300);
  const settlementAt = new Date(baseTime + 500);
  const grantCreatedAt = new Date(baseTime + 600);
  const completedAt = new Date(baseTime + 700);

  await prisma.user.create({
    data: {
      id: userId,
      email: `${userId}@example.test`,
      nickname: 'Legacy enterprise settlement fixture',
    },
  });
  await prisma.billingAccount.create({
    data: {
      id: billingAccountId,
      type: 'enterprise',
      name: 'Legacy enterprise settlement fixture',
      ownerUserId: userId,
      status: 'active',
      currency: 'USD',
      balanceGrantLedgerStatus: 'LEGACY_DIRTY',
      balanceGrantLedgerVersion: 0,
    },
  });
  await prisma.tenant.create({
    data: {
      id: tenantId,
      name: 'Legacy enterprise settlement tenant',
      type: 'team',
      status: 'active',
      ownerUserId: userId,
      billingAccountId,
      balanceAllowanceUsedUsd: new Prisma.Decimal(0),
    },
  });
  await prisma.accountWallet.create({
    data: { billingAccountId, balanceUsd: new Prisma.Decimal(0) },
  });
  await prisma.order.create({
    data: {
      id: orderId,
      userId,
      tenantId,
      billingAccountId,
      orderType: OrderType.RECHARGE,
      amountCents: 500,
      bonusCents: 0,
      currency: 'usd',
      status: OrderStatus.COMPLETED,
      paidAt,
      completedAt,
      createdAt: orderCreatedAt,
    },
  });

  await prisma.$transaction(async (db) => {
    await db.accountWallet.update({
      where: { billingAccountId },
      data: { balanceUsd: new Prisma.Decimal(-1) },
    });
    await db.balanceTransaction.create({
      data: {
        id: consumeTransactionId,
        operationKey: `balance:legacy-enterprise-consume:${id}`,
        userId,
        tenantId,
        billingAccountId,
        type: TransactionType.CONSUME,
        amountUsd: new Prisma.Decimal(-1),
        balanceAfterUsd: new Prisma.Decimal(-1),
        description: 'legacy enterprise debt fixture',
        createdAt: consumptionAt,
      },
    });
    await db.balanceConsumptionAllocation.create({
      data: {
        id: allocationId,
        userId,
        tenantId,
        billingAccountId,
        balanceTransactionId: consumeTransactionId,
        balanceGrantId: null,
        source: 'ENTERPRISE_CREDIT',
        amountUsd: new Prisma.Decimal(1),
        recognizedRevenueUsd: new Prisma.Decimal(0),
        bonusConsumedUsd: new Prisma.Decimal(0),
        discountRate: new Prisma.Decimal(0),
        settledUsd: new Prisma.Decimal(0),
        settledAt: null,
        createdAt: consumptionAt,
      },
    });
    await db.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
  });

  await prisma.$transaction(async (db) => {
    await db.accountWallet.update({
      where: { billingAccountId },
      data: { balanceUsd: new Prisma.Decimal(4) },
    });
    await db.balanceTransaction.create({
      data: {
        id: fundingTransactionId,
        operationKey: null,
        userId,
        tenantId,
        billingAccountId,
        type: TransactionType.RECHARGE,
        amountUsd: new Prisma.Decimal(5),
        balanceAfterUsd: new Prisma.Decimal(4),
        description: 'retired enterprise recharge writer',
        orderId,
        createdAt: fundingAt,
      },
    });
    await db.balanceGrant.create({
      data: {
        id: grantId,
        userId,
        tenantId,
        billingAccountId,
        orderId,
        source: 'RECHARGE',
        paidAmountUsd: new Prisma.Decimal(5),
        bonusAmountUsd: new Prisma.Decimal(0),
        grantedAmountUsd: new Prisma.Decimal(5),
        remainingAmountUsd: new Prisma.Decimal(4),
        remainingPaidAmountUsd: new Prisma.Decimal(4),
        remainingBonusAmountUsd: new Prisma.Decimal(0),
        discountRate: new Prisma.Decimal(1),
        validFrom: settlementAt,
        expiresAt: null,
        isExpired: false,
        createdAt: grantCreatedAt,
      },
    });
    await db.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
  });

  return {
    billingAccountId,
    allocationId,
    fundingTransactionId,
    settlementId,
    settlementAt,
  };
}

async function writeLegacyEnterpriseSettlement(
  db: Prisma.TransactionClient,
  fixture: LegacyEnterpriseSettlementFixture,
  operationKey: string,
): Promise<boolean> {
  await db.balanceConsumptionAllocation.update({
    where: { id: fixture.allocationId },
    data: {
      recognizedRevenueUsd: new Prisma.Decimal(1),
      settledUsd: new Prisma.Decimal(1),
      settledAt: fixture.settlementAt,
    },
  });
  await db.enterpriseCreditSettlement.create({
    data: {
      id: fixture.settlementId,
      billingAccountId: fixture.billingAccountId,
      allocationId: fixture.allocationId,
      repaymentTransactionId: fixture.fundingTransactionId,
      balanceGrantId: null,
      debtSource: 'ENTERPRISE_CREDIT',
      repairRunId: null,
      operationKey,
      trigger: 'FUNDING',
      amountUsd: new Prisma.Decimal(1),
      paidUsd: new Prisma.Decimal(1),
      bonusUsd: new Prisma.Decimal(0),
      occurredAt: fixture.settlementAt,
      createdAt: fixture.settlementAt,
    },
  });

  const [proof] = await db.$queryRaw<Array<{ proven: boolean }>>`
    SELECT "balance_legacy_enterprise_settlement_timing_is_proven"(
      ${fixture.settlementId}
    ) AS "proven"`;
  return proof?.proven ?? false;
}

async function createSubject(
  prisma: PrismaService,
  service: BillingService,
  initialUsd: Prisma.Decimal = INITIAL_USD,
  expireBeforeReturn = false,
  additionalDueUsd: Prisma.Decimal[] = [],
  futureUsd: Prisma.Decimal | null = null,
  fundingProductId: string | null = null,
): Promise<TestSubject> {
  const id = randomUUID();
  const userId = `bgc-user-${id}`;
  const tenantId = `bgc-tenant-${id}`;
  const billingAccountId = `bgc-account-${id}`;
  const billingAccountMemberId = `bgc-bam-${id}`;
  const tenantMemberId = `bgc-tm-${id}`;

  await prisma.user.create({
    data: {
      id: userId,
      email: `${userId}@example.test`,
      nickname: 'BalanceGrant Concurrency User',
    },
  });
  await prisma.billingAccount.create({
    data: {
      id: billingAccountId,
      type: 'personal',
      name: 'BalanceGrant concurrency account',
      ownerUserId: userId,
      status: 'active',
      currency: 'USD',
      balanceGrantLedgerStatus: 'RECONCILED_V2',
      balanceGrantLedgerVersion: 2,
      balanceGrantLedgerHash: 'EMPTY_V2',
      balanceGrantLedgerReconciledAt: new Date(),
    },
  });
  await prisma.tenant.create({
    data: {
      id: tenantId,
      name: 'BalanceGrant concurrency tenant',
      type: 'personal',
      status: 'active',
      ownerUserId: userId,
      billingAccountId,
      balanceAllowanceUsedUsd: new Prisma.Decimal(0),
    },
  });
  await prisma.user.update({
    where: { id: userId },
    data: { currentTenantId: tenantId },
  });
  await prisma.tenantMember.create({
    data: {
      id: tenantMemberId,
      tenantId,
      userId,
      role: 'owner',
      status: 'active',
    },
  });
  await prisma.billingAccountMember.create({
    data: {
      id: billingAccountMemberId,
      billingAccountId,
      userId,
      role: 'owner',
      status: 'active',
    },
  });
  await prisma.accountWallet.create({
    data: {
      billingAccountId,
      balanceUsd: new Prisma.Decimal(0),
    },
  });

  if (expireBeforeReturn) {
    const balanceGrantId = `bgc-grant-${id}`;
    await prisma.$transaction(async (db) => {
      const financialNow = await lockFixtureLedgerAndCaptureFinancialNow(
        db,
        billingAccountId,
      );
      const dueExpiresAt = new Date(financialNow.getTime() + 50);
      const grants = [initialUsd, ...additionalDueUsd].map((amountUsd, index) => ({
        id: index === 0 ? balanceGrantId : `bgc-grant-${id}-due-${index}`,
        amountUsd,
        expiresAt: dueExpiresAt,
      }));
      if (futureUsd?.gt(0)) {
        grants.push({
          id: `bgc-grant-${id}-future`,
          amountUsd: futureUsd,
          expiresAt: new Date(financialNow.getTime() + 60_000),
        });
      }

      for (const grant of grants) {
        const wallet = await db.accountWallet.update({
          where: { billingAccountId },
          data: { balanceUsd: { increment: grant.amountUsd } },
        });
        await db.balanceGrant.create({
          data: {
            id: grant.id,
            userId,
            tenantId,
            billingAccountId,
            source: 'RECHARGE',
            paidAmountUsd: grant.amountUsd,
            bonusAmountUsd: new Prisma.Decimal(0),
            grantedAmountUsd: grant.amountUsd,
            remainingAmountUsd: grant.amountUsd,
            remainingPaidAmountUsd: grant.amountUsd,
            remainingBonusAmountUsd: new Prisma.Decimal(0),
            discountRate: new Prisma.Decimal(1),
            validFrom: financialNow,
            expiresAt: grant.expiresAt,
            isExpired: false,
            createdAt: financialNow,
          },
        });
        await db.balanceTransaction.create({
          data: {
            operationKey: `balance:admin-recharge:grant:${grant.id}`,
            userId,
            tenantId,
            billingAccountId,
            type: TransactionType.RECHARGE,
            amountUsd: grant.amountUsd,
            balanceAfterUsd: wallet.balanceUsd,
            description: 'balance-grant concurrency expiry fixture',
            createdAt: financialNow,
          },
        });
      }
      // Every due grant is valid at the immutable write clock; PostgreSQL's
      // wall clock advances only after the complete canonical bundle exists.
      await ageFixturePastExpiry(db, dueExpiresAt);
    });
    return { userId, tenantId, billingAccountId, balanceGrantId };
  }

  await service.adminRecharge(
    userId,
    initialUsd.mul(100).toNumber(),
    'balance-grant concurrency initial funding',
    fundingProductId,
    {
      tenantId,
      idempotencyKey: `bgc-initial-funding-${id}`,
    },
  );
  const fundedGrant = await prisma.balanceGrant.findFirstOrThrow({
    where: { billingAccountId },
    orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    select: { id: true },
  });

  return { userId, tenantId, billingAccountId, balanceGrantId: fundedGrant.id };
}

async function cleanupSubject(prisma: PrismaService, subject: TestSubject): Promise<void> {
  // The suite is hard-gated to a disposable isolated database. Financial rows
  // are append-only by design, so keep each random-UUID fixture for database
  // teardown instead of weakening production triggers during test cleanup.
  void prisma;
  void subject;
}
