import { randomUUID } from 'node:crypto';
import { Test, TestingModule } from '@nestjs/testing';
import { ConfigModule } from '@nestjs/config';
import {
  AlertEventCategory,
  AlertEventSeverity,
  BundleItemBillingType,
  CodingPlanEntitlementStatus,
  CreditTxType,
  OrderItemStatus,
  OrderStatus,
  OrderType,
  Prisma,
  ProductBillingMode,
  RefundCompensationTaskAction,
  RefundCompensationTaskStatus,
  SubscriptionStatus,
  TransactionType,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { BillingRepository } from '../billing/billing.repository';
import { BillingService } from '../billing/billing.service';
import { CreditService } from '../billing/credit.service';
import { CreditBalanceStateService } from '../billing/credit-balance-state.service';
import { SubscriptionLifecycleService } from '../billing/subscription-lifecycle.service';
import { SubscriptionResolverService } from '../billing/subscription-resolver.service';
import { RefundCompensationService, type RefundableOrder } from './refund-compensation.service';

/**
 * Mutating integration test: requires an isolated Postgres database.
 *
 * Run manually or in a dedicated CI job:
 *   TEST_INTEGRATION=1 pnpm --filter @ruidong/api test -- --runInBand --testPathPattern=refund-compensation-e2e.integration
 */
const maybeDescribe = process.env.TEST_INTEGRATION === '1' ? describe : describe.skip;

const RETRY_MARK_ERROR = 'injected succeeded-mark failure';

type TestSubject = {
  runId: string;
  userId: string;
  tenantId: string;
  billingAccountId: string;
  productId: string;
  planId: string;
};

type PublisherSyncFake = {
  calls: string[];
  syncedEntitlementIds: Set<string>;
  syncApiKeysByCodingPlanEntitlementId: jest.Mock<Promise<void>, [string]>;
};

class InMemoryRedis {
  private readonly values = new Map<string, string>();
  private readonly sets = new Map<string, Set<string>>();
  private readonly hashes = new Map<string, Map<string, string>>();

  async get(key: string): Promise<string | null> {
    return this.values.get(key) ?? null;
  }

  async set(key: string, value: string, ...args: unknown[]): Promise<'OK' | null> {
    if (args.map(String).some((arg) => arg.toUpperCase() === 'NX') && this.values.has(key)) {
      return null;
    }
    this.values.set(key, String(value));
    return 'OK';
  }

  async del(...keys: string[]): Promise<number> {
    let removed = 0;
    for (const key of keys) {
      if (this.values.delete(key)) removed += 1;
      if (this.sets.delete(key)) removed += 1;
      if (this.hashes.delete(key)) removed += 1;
    }
    return removed;
  }

  async incrby(key: string, amount: number | string): Promise<number> {
    const current = parseInt(this.values.get(key) ?? '0', 10) || 0;
    const next = current + Number(amount);
    this.values.set(key, String(next));
    return next;
  }

  async sadd(key: string, ...values: string[]): Promise<number> {
    const set = this.sets.get(key) ?? new Set<string>();
    let added = 0;
    for (const value of values) {
      if (!set.has(value)) added += 1;
      set.add(value);
    }
    this.sets.set(key, set);
    return added;
  }

  async srem(key: string, ...values: string[]): Promise<number> {
    const set = this.sets.get(key);
    if (!set) return 0;
    let removed = 0;
    for (const value of values) {
      if (set.delete(value)) removed += 1;
    }
    return removed;
  }

  async smembers(key: string): Promise<string[]> {
    return Array.from(this.sets.get(key) ?? []);
  }

  async hmget(key: string, ...fields: string[]): Promise<Array<string | null>> {
    const hash = this.hashes.get(key);
    return fields.map((field) => hash?.get(field) ?? null);
  }

  async eval(
    _script: string,
    numberOfKeys: number,
    ...args: string[]
  ): Promise<number | Array<number | string>> {
    const keys = args.slice(0, numberOfKeys);
    const argv = args.slice(numberOfKeys);

    if (numberOfKeys === 1 && argv.length === 1) {
      const current = parseInt(this.values.get(keys[0]) ?? '0', 10) || 0;
      if (current <= 0) return 0;
      const take = Math.min(current, Number(argv[0]));
      this.values.set(keys[0], String(current - take));
      return take;
    }

    if (numberOfKeys === 1 && argv.length === 3) {
      const incomingVersion = BigInt(argv[0]);
      const incomingQuota = Number(argv[1]);
      const incomingBonus = Number(argv[2]);
      const hash = this.hashes.get(keys[0]);
      if (!hash) {
        this.hashes.set(keys[0], new Map([
          ['version', argv[0]],
          ['quota', argv[1]],
          ['bonus', argv[2]],
        ]));
        return [1, argv[0], argv[1], argv[2]];
      }
      const currentVersion = BigInt(hash.get('version') ?? '-1');
      const currentQuota = Number(hash.get('quota'));
      const currentBonus = Number(hash.get('bonus'));
      if (incomingVersion > currentVersion) {
        hash.set('version', argv[0]);
        hash.set('quota', argv[1]);
        hash.set('bonus', argv[2]);
        return [1, argv[0], argv[1], argv[2]];
      }
      if (incomingVersion < currentVersion) {
        return [-1, currentVersion.toString(), currentQuota, currentBonus];
      }
      if (incomingQuota !== currentQuota || incomingBonus !== currentBonus) {
        return [-2, currentVersion.toString(), currentQuota, currentBonus];
      }
      return [0, currentVersion.toString(), currentQuota, currentBonus];
    }

    if (numberOfKeys === 2 && argv.length === 1) {
      const amount = Number(argv[0]);
      const quota = parseInt(this.values.get(keys[0]) ?? '0', 10) || 0;
      const bonus = parseInt(this.values.get(keys[1]) ?? '0', 10) || 0;
      if (quota + bonus < amount) {
        return [-1, quota, bonus];
      }
      const fromQuota = Math.min(quota, amount);
      const fromBonus = amount - fromQuota;
      this.values.set(keys[0], String(quota - fromQuota));
      this.values.set(keys[1], String(bonus - fromBonus));
      return [0, quota - fromQuota, bonus - fromBonus, fromQuota, fromBonus];
    }

    if (numberOfKeys === 2 && argv.length === 2) {
      const quota = (parseInt(this.values.get(keys[0]) ?? '0', 10) || 0) + Number(argv[0]);
      const bonus = (parseInt(this.values.get(keys[1]) ?? '0', 10) || 0) + Number(argv[1]);
      this.values.set(keys[0], String(quota));
      this.values.set(keys[1], String(bonus));
      return [quota, bonus];
    }

    throw new Error(`unsupported redis eval shape keys=${numberOfKeys} argv=${argv.length}`);
  }

  clear(): void {
    this.values.clear();
    this.sets.clear();
    this.hashes.clear();
  }
}

function delay(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

function makePublisherSyncFake(delayMs = 0): PublisherSyncFake {
  const fake: PublisherSyncFake = {
    calls: [],
    syncedEntitlementIds: new Set<string>(),
    syncApiKeysByCodingPlanEntitlementId: jest.fn(async (entitlementId: string) => {
      fake.calls.push(entitlementId);
      fake.syncedEntitlementIds.add(entitlementId);
      if (delayMs > 0) await delay(delayMs);
    }),
  };
  return fake;
}

function withFailingSucceededMark(
  prisma: PrismaService,
  action: RefundCompensationTaskAction,
): PrismaService {
  let failed = false;
  return new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop === 'refundCompensationTask') {
        const delegate = Reflect.get(target, prop, receiver);
        return new Proxy(delegate, {
          get(taskDelegate, taskProp, taskReceiver) {
            if (taskProp === 'updateMany') {
              return async (args: Prisma.RefundCompensationTaskUpdateManyArgs) => {
                const nextStatus = args.data?.status;
                if (
                  !failed
                  && nextStatus === RefundCompensationTaskStatus.SUCCEEDED
                  && args.where?.id
                ) {
                  const task = await target.refundCompensationTask.findUnique({
                    where: { id: String(args.where.id) },
                    select: { action: true },
                  });
                  if (task?.action === action) {
                    failed = true;
                    throw new Error(RETRY_MARK_ERROR);
                  }
                }
                return delegate.updateMany(args);
              };
            }
            const value = Reflect.get(taskDelegate, taskProp, taskReceiver);
            return typeof value === 'function' ? value.bind(taskDelegate) : value;
          },
        });
      }

      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as PrismaService;
}

maybeDescribe('Refund compensation E2E drills (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let redis: InMemoryRedis;
  let subjects: TestSubject[] = [];

  beforeAll(async () => {
    moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({
          isGlobal: true,
          envFilePath: ['.env.test', '.env'],
          ignoreEnvFile: false,
        }),
      ],
      providers: [PrismaService],
    }).compile();

    prisma = moduleRef.get(PrismaService);
    redis = new InMemoryRedis();
    await prisma.$connect();
  });

  afterEach(async () => {
    for (const subject of subjects.reverse()) {
      await cleanupSubject(prisma, subject);
    }
    subjects = [];
    redis.clear();
    jest.clearAllMocks();
  });

  afterAll(async () => {
    await prisma?.$disconnect().catch(() => undefined);
    await moduleRef?.close().catch(() => undefined);
  });

  it('claims the same due task only once when multiple billing-runtime workers run concurrently', async () => {
    const subject = await createSubject(prisma);
    subjects.push(subject);

    const orderId = `rce-order-${subject.runId}`;
    await createRefundableOrder(prisma, subject, orderId, OrderStatus.REFUNDING);
    await prisma.refundCompensationTask.create({
      data: {
        orderId,
        taskKey: `refund:${orderId}:notify`,
        action: RefundCompensationTaskAction.NOTIFY_CREDIT_CHANGED,
        sequence: 10,
        userId: subject.userId,
        tenantId: subject.tenantId,
        productId: subject.productId,
      },
    });

    const productSync = {
      notifyCreditChanged: jest.fn(async (_email: string, _slug: string) => {
        await delay(150);
      }),
    };
    const workers = Array.from({ length: 8 }, () => makeRefundService(prisma, redis, { productSync }));

    const runs = await Promise.all(
      workers.map((worker) => worker.runDueTasks({ batchSize: 10, trigger: 'worker' })),
    );

    expect(runs.reduce((sum, run) => sum + run.completed, 0)).toBe(1);
    expect(productSync.notifyCreditChanged).toHaveBeenCalledTimes(1);

    const task = await prisma.refundCompensationTask.findFirstOrThrow({
      where: { orderId },
    });
    expect(task.status).toBe(RefundCompensationTaskStatus.SUCCEEDED);
    expect(task.attempts).toBe(1);
    expect(task.lockedAt).toBeNull();
    expect(task.lockedBy).toBeNull();
  }, 30_000);

  it('recovers partial bundle compensation after CREDIT_DEDUCT succeeds but succeeded-mark fails', async () => {
    const subject = await createSubject(prisma);
    subjects.push(subject);
    const fixture = await createPartialBundleFixture(prisma, redis, subject);
    const order = await loadRefundableOrder(prisma, fixture.orderId);
    const publisherSync = makePublisherSyncFake();
    const productSync = {
      notifyCreditChanged: jest.fn(async (_email: string, _slug: string) => undefined),
    };
    const failingPrisma = withFailingSucceededMark(prisma, RefundCompensationTaskAction.CREDIT_DEDUCT);
    const service = makeRefundService(failingPrisma, redis, { publisherSync, productSync });

    const first = await service.prepareAndRun(order, 10000, { reason: 'bundle compensation drill' });

    expect(first.complete).toBe(false);
    expect(first.failed).toBe(1);
    expect(first.error).toBe(RETRY_MARK_ERROR);

    const creditTask = await prisma.refundCompensationTask.findFirstOrThrow({
      where: { orderId: fixture.orderId, action: RefundCompensationTaskAction.CREDIT_DEDUCT },
    });
    expect(creditTask).toMatchObject({
      status: RefundCompensationTaskStatus.FAILED,
      attempts: 1,
      lastError: RETRY_MARK_ERROR,
      completedAt: null,
    });

    const [firstCreditTransaction, firstReversalCount, originalGrant] = await Promise.all([
      prisma.creditTransaction.findUniqueOrThrow({
        where: { idempotencyKey: creditTask.taskKey },
      }),
      prisma.creditTransaction.count({
        where: {
          subscriptionId: fixture.subscriptionPeriodId,
          type: CreditTxType.REFUND,
          requestId: fixture.quotaGrantIdempotencyKey,
        },
      }),
      prisma.creditTransaction.findUniqueOrThrow({
        where: { idempotencyKey: fixture.quotaGrantIdempotencyKey },
      }),
    ]);
    expect(firstReversalCount).toBe(1);
    expect(firstCreditTransaction).toMatchObject({
      subscriptionId: fixture.subscriptionPeriodId,
      userId: subject.userId,
      tenantId: subject.tenantId,
      productId: subject.productId,
      type: CreditTxType.REFUND,
      creditsAmount: -300,
      source: fixture.refundSource,
      requestId: fixture.quotaGrantIdempotencyKey,
      idempotencyKey: creditTask.taskKey,
      quotaAfter: 0,
      bonusAfter: 0,
      balanceVersion: 1n,
    });
    expect(originalGrant).toMatchObject({
      subscriptionId: fixture.subscriptionPeriodId,
      userId: subject.userId,
      tenantId: subject.tenantId,
      productId: subject.productId,
      type: CreditTxType.QUOTA_GRANT,
      creditsAmount: 300,
      quotaAfter: 300,
      bonusAfter: 0,
      idempotencyKey: fixture.quotaGrantIdempotencyKey,
    });
    const firstBalanceState = await prisma.creditBalanceState.findUniqueOrThrow({
      where: { subscriptionId: fixture.subscriptionPeriodId },
    });
    expect(firstBalanceState).toMatchObject({ quota: 0, bonus: 0, version: 1n });

    const second = await service.runOrderTasks(fixture.orderId, {
      force: true,
      reason: 'manual retry after injected mark failure',
    });

    expect(second.complete).toBe(true);
    expect(second.failed).toBe(0);

    const [
      finalOrder,
      finalItem,
      tasks,
      finalCreditTransaction,
      finalReversalCount,
      finalBalanceState,
      period,
      entitlement,
    ] = await Promise.all([
      prisma.order.findUniqueOrThrow({ where: { id: fixture.orderId } }),
      prisma.orderItem.findUniqueOrThrow({ where: { id: fixture.fulfilledItemId } }),
      prisma.refundCompensationTask.findMany({ where: { orderId: fixture.orderId } }),
      prisma.creditTransaction.findUniqueOrThrow({
        where: { idempotencyKey: creditTask.taskKey },
      }),
      prisma.creditTransaction.count({
        where: {
          subscriptionId: fixture.subscriptionPeriodId,
          type: CreditTxType.REFUND,
          requestId: fixture.quotaGrantIdempotencyKey,
        },
      }),
      prisma.creditBalanceState.findUniqueOrThrow({
        where: { subscriptionId: fixture.subscriptionPeriodId },
      }),
      prisma.subscriptionPeriod.findUniqueOrThrow({ where: { id: fixture.subscriptionPeriodId } }),
      prisma.codingPlanEntitlement.findUniqueOrThrow({ where: { id: fixture.codingPlanEntitlementId } }),
    ]);

    expect(finalOrder.status).toBe(OrderStatus.REFUNDED);
    expect(finalItem.status).toBe(OrderItemStatus.COMPENSATED);
    expect(tasks.every((task) => task.status === RefundCompensationTaskStatus.SUCCEEDED)).toBe(true);
    const finalCreditTask = tasks.find(
      (task) => task.action === RefundCompensationTaskAction.CREDIT_DEDUCT,
    );
    expect(finalCreditTask).toMatchObject({
      id: creditTask.id,
      status: RefundCompensationTaskStatus.SUCCEEDED,
      attempts: 2,
      lastError: null,
    });
    expect(finalCreditTask?.completedAt).toBeInstanceOf(Date);
    expect(finalReversalCount).toBe(1);
    expect(finalCreditTransaction).toEqual(firstCreditTransaction);
    expect(finalBalanceState).toEqual(firstBalanceState);
    expect(period.status).toBe(SubscriptionStatus.CANCELLED);
    expect(entitlement.status).toBe(CodingPlanEntitlementStatus.CANCELLED);
    expect(publisherSync.syncedEntitlementIds).toEqual(new Set([fixture.codingPlanEntitlementId]));
    expect(productSync.notifyCreditChanged).toHaveBeenCalledTimes(1);
  }, 30_000);

  it('does not double-refund balance when REFUND_BALANCE succeeds but succeeded-mark fails', async () => {
    const subject = await createSubject(prisma, { reconciledBalanceLedger: true });
    // This drill creates immutable balance-ledger evidence. The integration
    // database is disposable, so deliberately retain this one random fixture
    // instead of weakening production append-only guards during cleanup.
    const orderId = `rce-refund-balance-${subject.runId}`;
    await createRefundableOrder(prisma, subject, orderId, OrderStatus.REFUND_COMPENSATION_FAILED);
    const fundedAt = new Date();
    await prisma.$transaction(async (db) => {
      await db.$executeRaw`
        SELECT set_config('billing.balance_financial_now', ${fundedAt.toISOString()}, TRUE)`;
      await db.accountWallet.update({
        where: { billingAccountId: subject.billingAccountId },
        data: { balanceUsd: new Prisma.Decimal('10') },
      });
      await db.balanceTransaction.create({
        data: {
          operationKey: `balance:recharge:${orderId}:paid`,
          userId: subject.userId,
          tenantId: subject.tenantId,
          billingAccountId: subject.billingAccountId,
          productId: subject.productId,
          type: TransactionType.RECHARGE,
          amountUsd: new Prisma.Decimal('10'),
          balanceAfterUsd: new Prisma.Decimal('10'),
          description: 'refund compensation idempotency fixture',
          orderId,
          createdAt: fundedAt,
        },
      });
      await db.balanceGrant.create({
        data: {
          userId: subject.userId,
          tenantId: subject.tenantId,
          billingAccountId: subject.billingAccountId,
          productId: subject.productId,
          source: 'RECHARGE',
          orderId,
          paidAmountUsd: new Prisma.Decimal('10'),
          bonusAmountUsd: new Prisma.Decimal(0),
          grantedAmountUsd: new Prisma.Decimal('10'),
          remainingAmountUsd: new Prisma.Decimal('10'),
          remainingPaidAmountUsd: new Prisma.Decimal('10'),
          remainingBonusAmountUsd: new Prisma.Decimal(0),
          discountRate: new Prisma.Decimal(1),
          validFrom: fundedAt,
          isExpired: false,
          createdAt: fundedAt,
        },
      });
    });
    const billing = makeBillingService(prisma, redis);
    const spent = await billing.deduct(
      subject.userId,
      new Prisma.Decimal(8),
      'refund spent-balance fixture',
      { tenantId: subject.tenantId, productId: subject.productId },
    );
    expect(spent.success).toBe(true);
    expect(spent.balanceUsd).toBe(2);
    await prisma.refundCompensationTask.create({
      data: {
        orderId,
        taskKey: `refund:${orderId}:recharge:principal`,
        action: RefundCompensationTaskAction.REFUND_BALANCE,
        sequence: 10,
        userId: subject.userId,
        tenantId: subject.tenantId,
        productId: subject.productId,
        amountCents: 500,
        payload: {
          description: `refund:recharge:order:${orderId}:principal`,
          billingAccountId: subject.billingAccountId,
          refundComponent: 'PAID',
        },
      },
    });

    const service = makeRefundService(
      withFailingSucceededMark(prisma, RefundCompensationTaskAction.REFUND_BALANCE),
      redis,
    );
    const first = await service.runOrderTasks(orderId, { force: true, reason: 'injected failure' });

    expect(first.complete).toBe(false);
    expect(first.failed).toBe(1);
    expect(first.error).toBe(RETRY_MARK_ERROR);

    const second = await service.runOrderTasks(orderId, { force: true, reason: 'manual retry' });
    expect(second.complete).toBe(true);

    const [wallet, refundTransactions, refundAudits, refundDebt] = await Promise.all([
      prisma.accountWallet.findUniqueOrThrow({ where: { billingAccountId: subject.billingAccountId } }),
      prisma.balanceTransaction.findMany({
        where: {
          orderId,
          type: TransactionType.REFUND,
          description: `refund:recharge:order:${orderId}:principal`,
        },
      }),
      prisma.balanceGrantRefund.findMany({
        where: { billingAccountId: subject.billingAccountId },
      }),
      prisma.balanceConsumptionAllocation.findMany({
        where: {
          billingAccountId: subject.billingAccountId,
          source: 'NEGATIVE_BALANCE',
        },
      }),
    ]);
    expect(wallet.balanceUsd.toFixed(12)).toBe('-3.000000000000');
    expect(refundTransactions).toHaveLength(1);
    expect(refundTransactions[0].amountUsd.toFixed(12)).toBe('-5.000000000000');
    expect(refundAudits).toHaveLength(1);
    expect(refundAudits[0].targetGrantReductionUsd.toFixed(12)).toBe('2.000000000000');
    expect(refundAudits[0].debtOpenedUsd.toFixed(12)).toBe('3.000000000000');
    expect(refundAudits[0].debtNettedUsd.toFixed(12)).toBe('0.000000000000');
    expect(refundAudits[0].openDebtUsd.toFixed(12)).toBe('3.000000000000');
    expect(refundDebt).toHaveLength(1);
    expect(refundDebt[0].balanceTransactionId).toBe(refundTransactions[0].id);
    expect(refundDebt[0].amountUsd.toFixed(12)).toBe('3.000000000000');
    expect(refundDebt[0].settledUsd.toFixed(12)).toBe('0.000000000000');

    await billing.adminRecharge(
      subject.userId,
      300,
      'settle immutable refund debt',
      subject.productId,
      {
        tenantId: subject.tenantId,
        idempotencyKey: `rce-settle-refund-debt-${subject.runId}`,
      },
    );
    const [settledWallet, settledDebt, immutableAudit, settlementGrant] = await Promise.all([
      prisma.accountWallet.findUniqueOrThrow({
        where: { billingAccountId: subject.billingAccountId },
      }),
      prisma.balanceConsumptionAllocation.findUniqueOrThrow({
        where: { id: refundDebt[0].id },
      }),
      prisma.balanceGrantRefund.findUniqueOrThrow({
        where: { id: refundAudits[0].id },
      }),
      prisma.balanceGrant.findFirstOrThrow({
        where: {
          billingAccountId: subject.billingAccountId,
          source: 'RECHARGE',
          orderId: null,
        },
        orderBy: { createdAt: 'desc' },
      }),
    ]);
    expect(settledWallet.balanceUsd.toFixed(12)).toBe('0.000000000000');
    expect(settledDebt.settledUsd.toFixed(12)).toBe('3.000000000000');
    expect(settledDebt.settledAt).not.toBeNull();
    expect(immutableAudit.debtNettedUsd.toFixed(12)).toBe('0.000000000000');
    expect(immutableAudit.openDebtUsd.toFixed(12)).toBe('3.000000000000');
    expect(settlementGrant.grantedAmountUsd.toFixed(12)).toBe('3.000000000000');
    expect(settlementGrant.remainingAmountUsd.toFixed(12)).toBe('0.000000000000');
  }, 30_000);

  it('keeps publisher sync logically idempotent when succeeded-mark fails after SYNC_PUBLISHER_KEYS', async () => {
    const subject = await createSubject(prisma);
    subjects.push(subject);
    const fixture = await createPartialBundleFixture(prisma, redis, subject);
    const order = await loadRefundableOrder(prisma, fixture.orderId);
    const publisherSync = makePublisherSyncFake();
    const service = makeRefundService(
      withFailingSucceededMark(prisma, RefundCompensationTaskAction.SYNC_PUBLISHER_KEYS),
      redis,
      { publisherSync },
    );

    const first = await service.prepareAndRun(order, 10000, { reason: 'publisher sync drill' });
    expect(first.complete).toBe(false);
    expect(first.failed).toBe(1);
    expect(first.error).toBe(RETRY_MARK_ERROR);
    expect(publisherSync.calls).toEqual([fixture.codingPlanEntitlementId]);

    const second = await service.runOrderTasks(fixture.orderId, {
      force: true,
      reason: 'manual publisher-sync retry',
    });

    expect(second.complete).toBe(true);
    expect(publisherSync.calls).toEqual([
      fixture.codingPlanEntitlementId,
      fixture.codingPlanEntitlementId,
    ]);
    expect(publisherSync.syncedEntitlementIds).toEqual(new Set([fixture.codingPlanEntitlementId]));
  }, 30_000);

  it('moves exhausted tasks to manual review and allows force retry to recover', async () => {
    const subject = await createSubject(prisma);
    subjects.push(subject);
    const orderId = `rce-manual-${subject.runId}`;
    const orderItemId = `rce-manual-item-${subject.runId}`;
    await createRefundableOrder(prisma, subject, orderId, OrderStatus.REFUND_COMPENSATION_FAILED);
    await prisma.orderItem.create({
      data: {
        id: orderItemId,
        orderId,
        productId: subject.productId,
        planId: subject.planId,
        billingType: BundleItemBillingType.SUBSCRIPTION,
        name: 'Manual review item',
        amountCents: 1000,
        status: OrderItemStatus.COMPENSATING,
      },
    });
    const task = await prisma.refundCompensationTask.create({
      data: {
        orderId,
        orderItemId,
        taskKey: `refund:${orderId}:manual-mark`,
        action: RefundCompensationTaskAction.MARK_ORDER_ITEM_TERMINAL,
        sequence: 10,
        userId: subject.userId,
        tenantId: subject.tenantId,
        productId: subject.productId,
        maxAttempts: 1,
        payload: { terminalStatus: 'INVALID_STATUS' },
      },
    });
    const service = makeRefundService(prisma, redis);

    const workerRun = await service.runDueTasks({ batchSize: 10, trigger: 'worker' });

    expect(workerRun.manualReview).toBe(1);
    const manualTask = await prisma.refundCompensationTask.findUniqueOrThrow({ where: { id: task.id } });
    const failedItem = await prisma.orderItem.findUniqueOrThrow({ where: { id: orderItemId } });
    expect(manualTask.status).toBe(RefundCompensationTaskStatus.MANUAL_REVIEW);
    expect(manualTask.attempts).toBe(1);
    expect(failedItem.status).toBe(OrderItemStatus.COMPENSATION_FAILED);
    const alert = await prisma.alertEvent.findFirstOrThrow({
      where: {
        category: AlertEventCategory.PAYMENT,
        severity: AlertEventSeverity.CRITICAL,
        sourceType: 'order',
        sourceId: orderId,
        title: '退款补偿进入人工处理',
      },
    });
    expect(JSON.parse(alert.context)).toEqual(expect.objectContaining({
      taskId: task.id,
      attempts: 1,
    }));

    await prisma.refundCompensationTask.update({
      where: { id: task.id },
      data: { payload: { terminalStatus: OrderItemStatus.COMPENSATED } },
    });

    const manualRetry = await service.runOrderTasks(orderId, {
      force: true,
      reason: 'manual review fixed payload',
    });

    expect(manualRetry.complete).toBe(true);
    const [recoveredTask, recoveredItem, finalOrder] = await Promise.all([
      prisma.refundCompensationTask.findUniqueOrThrow({ where: { id: task.id } }),
      prisma.orderItem.findUniqueOrThrow({ where: { id: orderItemId } }),
      prisma.order.findUniqueOrThrow({ where: { id: orderId } }),
    ]);
    expect(recoveredTask.status).toBe(RefundCompensationTaskStatus.SUCCEEDED);
    expect(recoveredItem.status).toBe(OrderItemStatus.COMPENSATED);
    expect(finalOrder.status).toBe(OrderStatus.REFUNDED);
  }, 30_000);
});

function makeRefundService(
  prismaForRefund: PrismaService,
  redis: InMemoryRedis,
  opts: {
    productSync?: { notifyCreditChanged: jest.Mock<Promise<void>, [string, string]> };
    publisherSync?: PublisherSyncFake;
  } = {},
): RefundCompensationService {
  const lifecycle = new SubscriptionLifecycleService(prismaForRefund, redis as any);
  const resolver = new SubscriptionResolverService(prismaForRefund, redis as any);
  const billing = makeBillingService(prismaForRefund, redis, lifecycle);
  const balanceState = new CreditBalanceStateService(prismaForRefund, redis as any);
  const credit = new CreditService(prismaForRefund, redis as any, balanceState);
  return new RefundCompensationService(
    prismaForRefund,
    billing,
    credit,
    resolver,
    lifecycle,
    opts.productSync as any,
    opts.publisherSync as any,
  );
}

function makeBillingService(
  prismaForBilling: PrismaService,
  redis: InMemoryRedis,
  lifecycle = new SubscriptionLifecycleService(prismaForBilling, redis as any),
): BillingService {
  return new BillingService(
    new BillingRepository(prismaForBilling),
    redis as any,
    prismaForBilling,
    undefined,
    undefined,
    lifecycle,
  );
}

async function createSubject(
  prisma: PrismaService,
  options: { reconciledBalanceLedger?: boolean } = {},
): Promise<TestSubject> {
  const runId = randomUUID();
  const userId = `rce-user-${runId}`;
  const tenantId = `rce-tenant-${runId}`;
  const billingAccountId = `rce-account-${runId}`;
  const productId = `rce-product-${runId}`;
  const planId = `rce-plan-${runId}`;

  await prisma.user.create({
    data: {
      id: userId,
      email: `${userId}@example.test`,
      nickname: 'Refund Compensation E2E User',
    },
  });
  await prisma.billingAccount.create({
    data: {
      id: billingAccountId,
      type: 'personal',
      name: 'Refund Compensation E2E Account',
      ownerUserId: userId,
      status: 'active',
      currency: 'USD',
      ...(options.reconciledBalanceLedger
        ? {
          balanceGrantLedgerStatus: 'RECONCILED_V2',
          balanceGrantLedgerVersion: 2,
          balanceGrantLedgerHash: 'EMPTY_V2',
          balanceGrantLedgerReconciledAt: new Date(),
        }
        : {}),
    },
  });
  await prisma.tenant.create({
    data: {
      id: tenantId,
      name: 'Refund Compensation E2E Tenant',
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
      id: `rce-tm-${runId}`,
      tenantId,
      userId,
      role: 'owner',
      status: 'active',
    },
  });
  await prisma.billingAccountMember.create({
    data: {
      id: `rce-bam-${runId}`,
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
  await prisma.product.create({
    data: {
      id: productId,
      name: 'Refund Compensation E2E Product',
      slug: `rce-product-${runId}`,
      description: 'integration test product',
      billingMode: ProductBillingMode.SUBSCRIPTION,
      isActive: true,
    },
  });
  await prisma.plan.create({
    data: {
      id: planId,
      productId,
      name: 'Refund Compensation E2E Plan',
      description: 'integration test plan',
      monthlyPrice: 10000,
      yearlyPrice: 100000,
      monthlyCredits: 300,
      validityDays: 30,
      isActive: true,
    },
  });

  return { runId, userId, tenantId, billingAccountId, productId, planId };
}

async function createRefundableOrder(
  prisma: PrismaService,
  subject: TestSubject,
  orderId: string,
  status: OrderStatus,
): Promise<void> {
  await prisma.order.create({
    data: {
      id: orderId,
      userId: subject.userId,
      tenantId: subject.tenantId,
      billingAccountId: subject.billingAccountId,
      orderType: OrderType.RECHARGE,
      productId: subject.productId,
      amountCents: 10000,
      currency: 'usd',
      status,
      paidAt: new Date(),
    },
  });
}

async function createPartialBundleFixture(
  prisma: PrismaService,
  redis: InMemoryRedis,
  subject: TestSubject,
): Promise<{
  orderId: string;
  fulfilledItemId: string;
  failedItemId: string;
  subscriptionPeriodId: string;
  codingPlanEntitlementId: string;
  quotaGrantIdempotencyKey: string;
  refundSource: string;
}> {
  const orderId = `rce-bundle-${subject.runId}`;
  const fulfilledItemId = `rce-bundle-item-ok-${subject.runId}`;
  const failedItemId = `rce-bundle-item-failed-${subject.runId}`;
  const lifecycle = new SubscriptionLifecycleService(prisma, redis as any);
  const activated = await lifecycle.activate({
    userId: subject.userId,
    tenantId: subject.tenantId,
    billingAccountId: subject.billingAccountId,
    productId: subject.productId,
    planId: subject.planId,
    billingPeriod: 'monthly',
    startedAt: new Date(),
    expiresAt: null,
    activationIdempotencyKey:
      `bundle:${orderId}:item:${fulfilledItemId}:activation`,
  });
  const quotaGrantIdempotencyKey =
    `bundle:${orderId}:item:${fulfilledItemId}:quota`;
  await prisma.creditTransaction.create({
    data: {
      userId: subject.userId,
      tenantId: subject.tenantId,
      productId: subject.productId,
      subscriptionId: activated.periodId,
      type: CreditTxType.QUOTA_GRANT,
      creditsAmount: 300,
      source: 'integration-test-quota-grant',
      quotaAfter: 300,
      bonusAfter: 0,
      idempotencyKey: quotaGrantIdempotencyKey,
    },
  });
  await prisma.creditBalanceState.create({
    data: {
      subscriptionId: activated.periodId,
      userId: subject.userId,
      quota: 300,
      bonus: 0,
      version: 0n,
    },
  });

  await prisma.order.create({
    data: {
      id: orderId,
      userId: subject.userId,
      tenantId: subject.tenantId,
      billingAccountId: subject.billingAccountId,
      orderType: OrderType.BUNDLE,
      amountCents: 10000,
      currency: 'usd',
      status: OrderStatus.PARTIALLY_FULFILLED_REQUIRES_COMPENSATION,
      paidAt: new Date(),
    },
  });
  await prisma.orderItem.createMany({
    data: [
      {
        id: fulfilledItemId,
        orderId,
        productId: subject.productId,
        planId: subject.planId,
        billingType: BundleItemBillingType.SUBSCRIPTION,
        name: 'Fulfilled bundle item',
        amountCents: 8000,
        status: OrderItemStatus.FULFILLED,
        fulfilledAt: new Date(),
      },
      {
        id: failedItemId,
        orderId,
        productId: subject.productId,
        planId: subject.planId,
        billingType: BundleItemBillingType.SUBSCRIPTION,
        name: 'Failed bundle item',
        amountCents: 2000,
        status: OrderItemStatus.FAILED,
      },
    ],
  });

  const codingPlanEntitlementId = `rce-coding-ent-${subject.runId}`;
  await prisma.codingPlanEntitlement.create({
    data: {
      id: codingPlanEntitlementId,
      orderId: fulfilledItemId,
      userId: subject.userId,
      tenantId: subject.tenantId,
      productId: subject.productId,
      planId: subject.planId,
      status: CodingPlanEntitlementStatus.ACTIVE,
      fulfillmentMode: 'platform_model_package',
    },
  });

  return {
    orderId,
    fulfilledItemId,
    failedItemId,
    subscriptionPeriodId: activated.periodId,
    codingPlanEntitlementId,
    quotaGrantIdempotencyKey,
    refundSource: `refund:Fulfilled bundle item:order:${orderId}`,
  };
}

async function loadRefundableOrder(prisma: PrismaService, orderId: string): Promise<RefundableOrder> {
  return prisma.order.findUniqueOrThrow({
    where: { id: orderId },
    include: {
      plan: true,
      boosterPack: true,
      items: {
        include: { plan: true, boosterPack: true },
        orderBy: { createdAt: 'asc' },
      },
    },
  });
}

async function cleanupSubject(prisma: PrismaService, subject: TestSubject): Promise<void> {
  const orderIds = await prisma.order.findMany({
    where: { userId: subject.userId },
    select: { id: true },
  });
  await prisma.refundCompensationTask.deleteMany({
    where: { userId: subject.userId },
  });
  await prisma.alertEvent.deleteMany({
    where: {
      OR: [
        { userId: subject.userId },
        { sourceId: { in: orderIds.map((order) => order.id) } },
      ],
    },
  });
  await prisma.orderAuditLog.deleteMany({
    where: { orderId: { in: orderIds.map((order) => order.id) } },
  });
  await prisma.orderItem.deleteMany({
    where: { orderId: { in: orderIds.map((order) => order.id) } },
  });
  await prisma.codingPlanEntitlement.deleteMany({
    where: { userId: subject.userId },
  });
  await prisma.codingPlanProviderEntitlement.deleteMany({
    where: { userId: subject.userId },
  });
  await prisma.creditBalanceOutbox.deleteMany({
    where: { balanceState: { userId: subject.userId } },
  });
  await prisma.creditBalanceState.deleteMany({
    where: { userId: subject.userId },
  });
  await prisma.creditTransaction.deleteMany({
    where: { userId: subject.userId },
  });
  await prisma.subscriptionEntitlement.deleteMany({
    where: { userId: subject.userId },
  });
  await prisma.subscriptionPeriod.deleteMany({
    where: { userId: subject.userId },
  });
  await prisma.subscriptionContract.deleteMany({
    where: { userId: subject.userId },
  });
  await prisma.userSubscription.deleteMany({
    where: { userId: subject.userId },
  });
  await prisma.balanceConsumptionAllocation.deleteMany({
    where: { billingAccountId: subject.billingAccountId },
  });
  await prisma.balanceTransaction.deleteMany({
    where: { userId: subject.userId },
  });
  await prisma.balanceGrant.deleteMany({
    where: { userId: subject.userId },
  });
  await prisma.order.deleteMany({
    where: { userId: subject.userId },
  });
  await prisma.idempotencyKey.deleteMany({
    where: { userId: subject.userId },
  }).catch(() => undefined);
  await prisma.accountWallet.deleteMany({
    where: { billingAccountId: subject.billingAccountId },
  });
  await prisma.tenantMember.deleteMany({
    where: { tenantId: subject.tenantId },
  });
  await prisma.billingAccountMember.deleteMany({
    where: { billingAccountId: subject.billingAccountId },
  });
  await prisma.user.updateMany({
    where: { id: subject.userId },
    data: { currentTenantId: null },
  });
  await prisma.tenant.deleteMany({
    where: { id: subject.tenantId },
  });
  await prisma.plan.deleteMany({
    where: { id: subject.planId },
  });
  await prisma.product.deleteMany({
    where: { id: subject.productId },
  });
  await prisma.billingAccount.deleteMany({
    where: { id: subject.billingAccountId },
  });
  await prisma.user.deleteMany({
    where: { id: subject.userId },
  });
}
