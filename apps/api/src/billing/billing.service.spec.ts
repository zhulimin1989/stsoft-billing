import { Test } from '@nestjs/testing';
import { HttpException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import {
  BalanceTransactionAttributionSource,
  CodingPlanFulfillmentMode,
  Prisma,
  ProductBillingMode,
} from '@prisma/client';
import { createStageTimings, runWithStageTimings } from '../common/runtime/usage-stage-timings';
import { billingFundingBlockerTotal } from '../metrics/metrics.registry';
import {
  BalanceLedgerReconciliationRequiredError,
  BillingService,
  EnterpriseCreditPolicyPendingError,
  GatewayFundingReservationQueuePendingError,
  RechargeBillingSubjectChangedError,
} from './billing.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { BillingRepository } from './billing.repository';
import { SubscriptionResolverService } from './subscription-resolver.service';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';
import { CreditPolicyService } from '../credit-policy/credit-policy.service';
import { PublisherSyncService } from '../publisher/publisher-sync.service';
import { SystemConfigService } from './system-config.service';
import { TransactionType } from '@ruidong/shared';
import { createHash } from 'crypto';

function makeBillingRepo() {
  return {
    findActivePlans: jest.fn(),
    findPlanById: jest.fn(),
    aggregateBalance: jest.fn(),
    createTransaction: jest.fn(),
    findTransactions: jest.fn(),
    countTransactions: jest.fn(),
    aggregateUsedThisMonth: jest.fn(),
    aggregateTotalGranted: jest.fn(),
    aggregateBalanceGrantTotals: jest.fn(),
    dailyActualUsageFunding: jest.fn(),
    dailyBalanceConsumption: jest.fn(),
    dailyCreditConsumption: jest.fn(),
    monthlyBalanceSummary: jest.fn(),
    monthlyCreditSummary: jest.fn(),
    findTokenUsageItems: jest.fn(),
    countTokenUsageItems: jest.fn(),
    aggregateTokenUsageSummary: jest.fn(),
    aggregateTokenUsagePeriodSummary: jest.fn(),
  };
}

function makeRedis() {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    incrby: jest.fn(),
    del: jest.fn(),
    call: jest.fn(),
  };
}

function makePublisherSync() {
  return {
    syncBillingAccountKeyBalances: jest.fn().mockResolvedValue(undefined),
    syncTenantKeyBalances: jest.fn().mockResolvedValue(undefined),
    syncUserKeyBalances: jest.fn().mockResolvedValue(undefined),
  };
}

describe('GatewayFundingReservationQueuePendingError', () => {
  it('preserves an arbitrary database sequence as JSON-safe decimal text', () => {
    const sequence = 9_007_199_254_740_993n;
    const error = new GatewayFundingReservationQueuePendingError(
      'billing-account-1',
      'request-later',
      'request-blocking',
      sequence,
    );

    expect(error.blockingSequence).toBe('9007199254740993');
    expect(error.message).toContain('request-blocking:9007199254740993');
    expect(() => JSON.stringify({ error })).not.toThrow();
    expect(JSON.parse(JSON.stringify({ error }))).toEqual({
      error: expect.objectContaining({
        code: 'GATEWAY_FUNDING_RESERVATION_QUEUE_PENDING',
        retryable: true,
        blockingSequence: '9007199254740993',
      }),
    });
  });
});

function makePrisma() {
  const walletBalances = new Map<string, Prisma.Decimal>();
  const openDebtBalances = new Map<string, Prisma.Decimal>();
  const accountId = 'ba_personal_u1';
  const walletKey = (id: string) => {
    if (id.startsWith('ba_')) return id;
    if (id === 'u1' || id === 'tenant-1') return accountId;
    return id;
  };
  walletBalances.set(accountId, new Prisma.Decimal(0));
  // 一条结算记录对未结欠款的影响。create 与 createMany 必须共用，否则
  // 批量路径会漏掉这个副作用，后续断言看到的 open debt 就不对了。
  const settleOpenDebt = (row: any) => {
    const current = openDebtBalances.get(walletKey(row.billingAccountId)) ?? new Prisma.Decimal(0);
    openDebtBalances.set(
      walletKey(row.billingAccountId),
      Prisma.Decimal.max(new Prisma.Decimal(0), current.minus(row.amountUsd)),
    );
  };
  const prisma: any = {
    /**
     * 把欠款核销的批量 UPDATE 解回逐行视图，供断言使用。
     * 参数布局 [financialNow, (id, apply, paid, bonus, markSettled) x N]，
     * 与 flushBalanceDebtSettlementBatch 一致；多批会按调用顺序拼接。
     */
    __debtSettlementWrites: () => {
      const rows: Array<{
        id: string;
        applyUsd: Prisma.Decimal;
        applyPaidUsd: Prisma.Decimal;
        applyBonusUsd: Prisma.Decimal;
        markSettled: boolean;
      }> = [];
      for (const [query] of prisma.$executeRaw.mock.calls) {
        const text: string = typeof query?.sql === 'string' ? query.sql : '';
        if (!text.includes('apply_usd') || !Array.isArray(query?.values)) continue;
        const values = query.values.slice(1);
        for (let i = 0; i + 4 < values.length; i += 5) {
          rows.push({
            id: values[i],
            applyUsd: new Prisma.Decimal(values[i + 1]),
            applyPaidUsd: new Prisma.Decimal(values[i + 2]),
            applyBonusUsd: new Prisma.Decimal(values[i + 3]),
            markSettled: values[i + 4],
          });
        }
      }
      return rows;
    },
    __setWalletBalance: (accountId: string, balanceUsd: string | number | Prisma.Decimal) => {
      const balance = new Prisma.Decimal(balanceUsd);
      walletBalances.set(walletKey(accountId), balance);
      walletBalances.set(accountId, balance);
      walletBalances.set('tenant-1', balance);
      openDebtBalances.set(
        walletKey(accountId),
        balance.lt(0) ? balance.neg() : new Prisma.Decimal(0),
      );
    },
    __deleteWallet: (billingAccountId: string) => {
      walletBalances.delete(walletKey(billingAccountId));
    },
    product: { findUnique: jest.fn(), findFirst: jest.fn(), findMany: jest.fn().mockResolvedValue([]) },
    order: {
      groupBy: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn(async ({ where }: any) => ({ id: where.id })),
      findUnique: jest.fn(),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ currentTenantId: 'tenant-1' }) },
    tenant: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'tenant-1',
        name: 'Personal workspace',
        type: 'personal',
        status: 'active',
        ownerUserId: 'u1',
        billingAccountId: accountId,
        deletedAt: null,
        balanceAllowanceUsd: null,
        balanceAllowanceUsedUsd: new Prisma.Decimal(0),
      }),
      findFirst: jest.fn().mockResolvedValue({ id: 'tenant-1' }),
      update: jest.fn(async ({ data }: any) => ({
        id: 'tenant-1',
        name: 'Personal workspace',
        type: 'personal',
        ownerUserId: 'u1',
        billingAccountId: accountId,
        balanceAllowanceUsd: data?.balanceAllowanceUsd ?? null,
        balanceAllowanceUsedUsd: new Prisma.Decimal(0),
      })),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    tenantMember: {
      findFirst: jest.fn().mockResolvedValue({
        id: 'tm1',
        tenantId: 'tenant-1',
        role: 'owner',
        status: 'active',
      }),
      findMany: jest.fn().mockResolvedValue([{ tenantId: 'tenant-1' }]),
    },
    userSubscription: { findFirst: jest.fn(), create: jest.fn(), update: jest.fn(), updateMany: jest.fn(), upsert: jest.fn() },
    subscriptionContract: {
      create: jest.fn(async ({ data }: any) => ({
        id: `contract-${prisma.subscriptionContract.create.mock.calls.length}`,
        ...data,
      })),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    subscriptionPeriod: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => ({
        id: `period-${prisma.subscriptionPeriod.create.mock.calls.length}`,
        ...data,
      })),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    subscriptionEntitlement: {
      create: jest.fn(async ({ data }: any) => ({
        id: `entitlement-${prisma.subscriptionEntitlement.create.mock.calls.length}`,
        ...data,
      })),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    plan: { findUnique: jest.fn() },
    creditTransaction: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { creditsAmount: 0 } }),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    idempotencyKey: {
      create: jest.fn(async ({ data }: any) => ({
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
        ...data,
      })),
      update: jest.fn(async ({ data }: any) => data),
      findUnique: jest.fn().mockResolvedValue(null),
      delete: jest.fn().mockResolvedValue({}),
      deleteMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    apiKey: { findFirst: jest.fn() },
    gatewayBillingEvent: {
      aggregate: jest.fn().mockImplementation(async ({ where }: any) => (
        where?.status === 'QUARANTINED'
          ? {
              _count: { _all: 0 },
              _sum: { pendingHoldUsd: null, pendingExposureUsd: null },
            }
          : { _sum: { pendingExposureUsd: null } }
      )),
    },
    gatewayUsageSettlementAnchor: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    gatewayUsageFundingReservation: {
      findUnique: jest.fn().mockResolvedValue(null),
      findUniqueOrThrow: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(null),
      aggregate: jest.fn().mockResolvedValue({
        _count: { _all: 0 },
        _sum: {
          reservedAmountUsd: null,
          collectedUsd: null,
          approvedCreditUsd: null,
        },
      }),
      create: jest.fn(async ({ data }: any) => ({ id: 'reservation-1', ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    gatewayUsageFundingReservationGrant: {
      findMany: jest.fn().mockResolvedValue([]),
      createMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    billingAccessRestriction: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    billingAccountCreditEvent: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    billingAccount: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn(async ({ where }: any) => ({
        id: where.id,
        type: 'personal',
        status: 'active',
        ownerUserId: 'u1',
        name: 'Personal account',
        currency: 'USD',
        deletedAt: null,
        balanceGrantLedgerStatus: 'RECONCILED_V2',
        balanceGrantLedgerVersion: 2,
        creditConfig: null,
      })),
      findUniqueOrThrow: jest.fn(async ({ where }: any) => {
        const account = await prisma.billingAccount.findUnique({ where });
        if (!account) throw new Error(`billing account not found: ${where.id}`);
        return {
          balanceGrantLedgerStatus: 'RECONCILED_V2',
          balanceGrantLedgerVersion: 2,
          ...account,
        };
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      create: jest.fn(async ({ data }: any) => data),
      update: jest.fn(async ({ data }: any) => data),
      upsert: jest.fn(async ({ where, create }: any) => ({
        id: where.id,
        type: create?.type ?? 'personal',
        name: create?.name ?? 'Personal account',
        ownerUserId: create?.ownerUserId ?? 'u1',
        status: create?.status ?? 'active',
        currency: create?.currency ?? 'USD',
      })),
    },
    billingAccountMember: {
      findFirst: jest.fn().mockResolvedValue({ role: 'owner', status: 'active' }),
      findUnique: jest.fn().mockResolvedValue({ role: 'owner', status: 'active' }),
      create: jest.fn(async ({ data }: any) => data),
      update: jest.fn(async ({ data }: any) => data),
      upsert: jest.fn(async ({ where, create, update }: any) => ({
        id: create?.id ?? `bam-${where.billingAccountId_userId.billingAccountId}`,
        billingAccountId: where.billingAccountId_userId.billingAccountId,
        userId: where.billingAccountId_userId.userId,
        role: update?.role ?? create?.role ?? 'owner',
        status: update?.status ?? create?.status ?? 'active',
      })),
    },
    accountWallet: {
      create: jest.fn(async ({ data }: any) => {
        const balance = new Prisma.Decimal(data.balanceUsd ?? 0);
        walletBalances.set(walletKey(data.billingAccountId), balance);
        return { ...data, balanceUsd: balance };
      }),
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const billingAccountId = where.billingAccountId;
        let balance = walletBalances.get(walletKey(billingAccountId));
        if (balance == null) {
          balance = new Prisma.Decimal(create.balanceUsd ?? 0);
        } else if (update?.balanceUsd?.increment !== undefined) {
          balance = balance.plus(update.balanceUsd.increment);
        } else if (update?.balanceUsd?.decrement !== undefined) {
          balance = balance.minus(update.balanceUsd.decrement);
        }
        walletBalances.set(walletKey(billingAccountId), balance);
        return { billingAccountId, balanceUsd: balance };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const billingAccountId = where.billingAccountId;
        const balance = walletBalances.get(walletKey(billingAccountId)) ?? new Prisma.Decimal(0);
        let next = balance;
        if (data.balanceUsd?.increment !== undefined) {
          next = next.plus(data.balanceUsd.increment);
        } else if (data.balanceUsd?.decrement !== undefined) {
          next = next.minus(data.balanceUsd.decrement);
        }
        walletBalances.set(walletKey(billingAccountId), next);
        return { billingAccountId, balanceUsd: next };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const billingAccountId = where.billingAccountId;
        const balance = walletBalances.get(walletKey(billingAccountId)) ?? new Prisma.Decimal(0);
        const min = where.balanceUsd?.gte;
        if (min !== undefined && balance.lt(new Prisma.Decimal(min))) {
          return { count: 0 };
        }
        let next = balance;
        if (data.balanceUsd?.decrement !== undefined) {
          next = next.minus(data.balanceUsd.decrement);
        } else if (data.balanceUsd?.increment !== undefined) {
          next = next.plus(data.balanceUsd.increment);
        }
        walletBalances.set(walletKey(billingAccountId), next);
        return { count: 1 };
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        const balance = walletBalances.get(walletKey(where.billingAccountId));
        return balance == null ? null : { billingAccountId: where.billingAccountId, balanceUsd: balance };
      }),
      findUniqueOrThrow: jest.fn(async ({ where }: any) => ({
        billingAccountId: where.billingAccountId,
        balanceUsd: walletBalances.get(walletKey(where.billingAccountId)) ?? new Prisma.Decimal(0),
      })),
    },
    userWallet: {
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const userId = where.userId;
        let balance = walletBalances.get(userId);
        if (balance == null) {
          balance = new Prisma.Decimal(create.balanceUsd ?? 0);
        } else if (update?.balanceUsd?.increment !== undefined) {
          balance = balance.plus(update.balanceUsd.increment);
        } else if (update?.balanceUsd?.decrement !== undefined) {
          balance = balance.minus(update.balanceUsd.decrement);
        }
        walletBalances.set(userId, balance);
        return { userId, balanceUsd: balance };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const userId = where.userId;
        const balance = walletBalances.get(userId) ?? new Prisma.Decimal(0);
        const min = where.balanceUsd?.gte;
        if (min !== undefined && balance.lt(new Prisma.Decimal(min))) {
          return { count: 0 };
        }
        let next = balance;
        if (data.balanceUsd?.decrement !== undefined) {
          next = next.minus(data.balanceUsd.decrement);
        } else if (data.balanceUsd?.increment !== undefined) {
          next = next.plus(data.balanceUsd.increment);
        }
        walletBalances.set(userId, next);
        return { count: 1 };
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        const balance = walletBalances.get(where.userId);
        return balance == null ? null : { userId: where.userId, balanceUsd: balance };
      }),
      findUniqueOrThrow: jest.fn(async ({ where }: any) => ({
        userId: where.userId,
        balanceUsd: walletBalances.get(where.userId) ?? new Prisma.Decimal(0),
      })),
    },
    tenantWallet: {
      upsert: jest.fn(async ({ where, create, update }: any) => {
        const tenantId = where.tenantId;
        let balance = walletBalances.get(tenantId);
        if (balance == null) {
          balance = new Prisma.Decimal(create.balanceUsd ?? 0);
        } else if (update?.balanceUsd?.increment !== undefined) {
          balance = balance.plus(update.balanceUsd.increment);
        } else if (update?.balanceUsd?.decrement !== undefined) {
          balance = balance.minus(update.balanceUsd.decrement);
        }
        walletBalances.set(tenantId, balance);
        return { tenantId, balanceUsd: balance };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const tenantId = where.tenantId;
        const balance = walletBalances.get(tenantId) ?? new Prisma.Decimal(0);
        let next = balance;
        if (data.balanceUsd?.increment !== undefined) {
          next = next.plus(data.balanceUsd.increment);
        } else if (data.balanceUsd?.decrement !== undefined) {
          next = next.minus(data.balanceUsd.decrement);
        }
        walletBalances.set(tenantId, next);
        return { tenantId, balanceUsd: next };
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const tenantId = where.tenantId;
        const balance = walletBalances.get(tenantId) ?? new Prisma.Decimal(0);
        const min = where.balanceUsd?.gte;
        if (min !== undefined && balance.lt(new Prisma.Decimal(min))) {
          return { count: 0 };
        }
        let next = balance;
        if (data.balanceUsd?.decrement !== undefined) {
          next = next.minus(data.balanceUsd.decrement);
        } else if (data.balanceUsd?.increment !== undefined) {
          next = next.plus(data.balanceUsd.increment);
        }
        walletBalances.set(tenantId, next);
        return { count: 1 };
      }),
      findUnique: jest.fn(async ({ where }: any) => {
        const balance = walletBalances.get(where.tenantId);
        return balance == null ? null : { tenantId: where.tenantId, balanceUsd: balance };
      }),
      findUniqueOrThrow: jest.fn(async ({ where }: any) => ({
        tenantId: where.tenantId,
        balanceUsd: walletBalances.get(where.tenantId) ?? new Prisma.Decimal(0),
      })),
    },
    balanceTransaction: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { amountUsd: null } }),
      create: jest.fn(async ({ data }: any) => ({
        id: `tx-${data.userId}-${prisma.balanceTransaction.create.mock.calls.length}`,
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
        ...data,
      })),
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    balanceTransactionAttribution: {
      create: jest.fn(async ({ data }: any) => ({
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
        ...data,
      })),
    },
    balanceGrant: {
      findUnique: jest.fn().mockResolvedValue(null),
      findUniqueOrThrow: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn(async ({ data }: any) => ({
        id: `grant-${prisma.balanceGrant.create.mock.calls.length}`,
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
        updatedAt: new Date('2025-01-01T00:00:00.000Z'),
        ...data,
      })),
      update: jest.fn(async ({ data }: any) => data),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    balanceDebtSettlementPending: {
      delete: jest.fn().mockResolvedValue({ id: 'pending-1' }),
      aggregate: jest.fn().mockResolvedValue({
        _sum: { remainingPaidUsd: null, remainingBonusUsd: null },
      }),
    },
    balanceConsumptionAllocation: {
      aggregate: jest.fn().mockResolvedValue({
        _sum: { amountUsd: null, settledUsd: null },
      }),      create: jest.fn(async ({ data }: any) => {
        if (data.source === 'NEGATIVE_BALANCE' || data.source === 'ENTERPRISE_CREDIT') {
          const current = openDebtBalances.get(walletKey(data.billingAccountId)) ?? new Prisma.Decimal(0);
          openDebtBalances.set(walletKey(data.billingAccountId), current.plus(data.amountUsd));
        }
        return {
          id: `alloc-${prisma.balanceConsumptionAllocation.create.mock.calls.length}`,
          ledgerSequence: BigInt(prisma.balanceConsumptionAllocation.create.mock.calls.length),
          createdAt: new Date('2025-01-01T00:00:00.000Z'),
          ...data,
        };
      }),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
      // 欠款核销里 openUsd <= 0 的行只补 settled_at，走批量 updateMany
      updateMany: jest.fn(async ({ where }: any) => ({
        count: Array.isArray(where?.id?.in) ? where.id.in.length : 1,
      })),
    },
    enterpriseCreditSettlement: {
      create: jest.fn(async ({ data }: any) => {
        settleOpenDebt(data);
        return {
          id: `settle-${prisma.enterpriseCreditSettlement.create.mock.calls.length}`,
          createdAt: new Date('2025-01-01T00:00:00.000Z'),
          ...data,
        };
      }),
      // 欠款核销改为按批写入；副作用必须与 create 逐条一致
      createMany: jest.fn(async ({ data }: any) => {
        const rows = Array.isArray(data) ? data : [data];
        for (const row of rows) settleOpenDebt(row);
        return { count: rows.length };
      }),
    },
    balanceGrantExpiry: {
      create: jest.fn(async ({ data }: any) => ({
        id: `expiry-${prisma.balanceGrantExpiry.create.mock.calls.length}`,
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
        ...data,
      })),
    },
    balanceGrantRefund: {
      findUnique: jest.fn().mockResolvedValue(null),
      aggregate: jest.fn().mockResolvedValue({ _sum: { requestedAmountUsd: null } }),
      create: jest.fn(async ({ data }: any) => ({
        id: `refund-audit-${prisma.balanceGrantRefund.create.mock.calls.length}`,
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
        ...data,
      })),
    },
    balanceGrantRefundAllocation: {
      create: jest.fn(async ({ data }: any) => ({
        id: `refund-allocation-${prisma.balanceGrantRefundAllocation.create.mock.calls.length}`,
        ...data,
      })),
    },
  };
  // 默认返回 1(advisory lock 等只关心「跑过了」)。欠款核销的批量 UPDATE 例外:
  // 生产代码会校验受影响行数(flushBalanceDebtSettlementBatch),这里必须如实返回。
  // 参数布局为 [financialNow, (id, apply, paid, bonus, markSettled) x N]。
  prisma.$executeRaw = jest.fn(async (query: any) => {
    const text: string = typeof query?.sql === 'string'
      ? query.sql
      : String(query?.strings?.join('') ?? '');
    if (text.includes('apply_usd') && Array.isArray(query?.values)) {
      return Math.max(0, Math.floor((query.values.length - 1) / 5));
    }
    return 1;
  });
  // 队列版授权闸门的开关。默认已就绪;个别用例通过 prisma.__setUnreservedQueueReady(false)
  // 模拟「migration 100/200 已跑、300 尚未完成」的部署窗口。
  let unreservedQueueReady = true;
  prisma.__setUnreservedQueueReady = (ready: boolean) => { unreservedQueueReady = ready; };
  const defaultQueryRaw = async (
    query: TemplateStringsArray | { strings?: readonly string[]; values?: readonly unknown[] },
    ...values: unknown[]
  ) => {
    const composedQuery = query as { strings?: readonly string[]; values?: readonly unknown[] };
    const sql = String(query);
    const composedSql = composedQuery.strings?.join('') ?? '';
    // 队列版 FIFO 队头查询的授权闸门(migration 20260910000300 写入)。
    // 默认返回「已就绪」,让绝大多数用例验证队列版路径;
    // 「未就绪必须回落旧查询」由专门的用例覆盖 —— 它把这个分支 mock 成空。
    if (sql.includes('FROM "gateway_usage_unreserved_queue_readiness"')) {
      return unreservedQueueReady ? [{ ready: true }] : [];
    }
    if (sql.includes('FROM "account_wallets"') && sql.includes('FOR UPDATE')) {
      const requestedAccountId = typeof values[0] === 'string' ? values[0] : accountId;
      const balanceUsd = walletBalances.get(walletKey(requestedAccountId));
      return balanceUsd === undefined ? [] : [{ balance_usd: balanceUsd }];
    }
    if (sql.includes('FROM "account_wallets"') && sql.includes('FOR SHARE')) {
      const requestedAccountId = typeof values[0] === 'string' ? values[0] : accountId;
      const balanceUsd = walletBalances.get(walletKey(requestedAccountId));
      return balanceUsd === undefined ? [] : [{ balance_usd: balanceUsd }];
    }
    if (sql.includes('FROM "tenants"') && sql.includes('FOR SHARE')) {
      const requestedTenantId = typeof values[0] === 'string' ? values[0] : 'tenant-1';
      const tenant = await prisma.tenant.findUnique({ where: { id: requestedTenantId } });
      return tenant ? [{ billing_account_id: tenant.billingAccountId ?? null }] : [];
    }
    if (sql.includes('FROM "billing_account_members"') && sql.includes('FOR UPDATE')) {
      return [{ id: 'bam-personal-u1' }];
    }
    if (
      (sql.includes('clock_timestamp()') && sql.includes('financialNow'))
      || (composedSql.includes('clock_timestamp()') && composedSql.includes('financialNow'))
    ) {
      return [{ financialNow: new Date('2026-07-16T00:00:00.000Z') }];
    }
    if (sql.includes('AS "wallet_usd"') && sql.includes('AS "active_grant_usd"')) {
      const requestedAccountId = typeof values[0] === 'string' ? values[0] : accountId;
      const walletUsd = walletBalances.get(walletKey(requestedAccountId)) ?? new Prisma.Decimal(0);
      const openDebtUsd = openDebtBalances.get(walletKey(requestedAccountId))
        ?? (walletUsd.lt(0) ? walletUsd.neg() : new Prisma.Decimal(0));
      return [{
        wallet_usd: walletUsd,
        active_grant_usd: walletUsd.gt(0) ? walletUsd : new Prisma.Decimal(0),
        open_debt_usd: openDebtUsd,
        invalid_grant_count: 0n,
        due_grant_count: 0n,
        invalid_debt_count: 0n,
        invalid_sequence_count: 0n,
        unexpected_debt_count: 0n,
      }];
    }
    return [];
  };
  prisma.__defaultQueryRaw = defaultQueryRaw;
  prisma.$queryRaw = jest.fn(defaultQueryRaw);
  prisma.$transaction = jest.fn((fn: any) => fn(prisma));
  return prisma;
}

function configureEnterpriseBillingSubject(
  prisma: any,
  creditConfig: Record<string, unknown> | null,
): void {
  prisma.tenant.findUnique.mockResolvedValue({
    id: 'tenant-1',
    name: 'Enterprise workspace',
    type: 'enterprise',
    status: 'active',
    ownerUserId: 'u1',
    billingAccountId: 'ba_personal_u1',
    deletedAt: null,
    balanceAllowanceUsd: null,
    balanceAllowanceUsedUsd: new Prisma.Decimal(0),
  });
  prisma.billingAccount.findUnique.mockResolvedValue({
    id: 'ba_personal_u1',
    type: 'enterprise',
    status: 'active',
    ownerUserId: 'u1',
    name: 'Enterprise account',
    deletedAt: null,
    currency: 'USD',
    balanceGrantLedgerStatus: 'RECONCILED_V2',
    balanceGrantLedgerVersion: 2,
    creditConfig,
  });
}

function mockEnterpriseCreditBoundaries(
  prisma: any,
  boundaries: {
    incomplete?: Record<string, unknown> | null;
    overlap?: Record<string, unknown> | null;
    future?: Record<string, unknown> | null;
    latest?: Record<string, unknown> | null;
  },
): void {
  prisma.billingAccountCreditEvent.findFirst.mockImplementation(({ where }: any) => {
    if (where?.policyBoundaryComplete === false) {
      return Promise.resolve(boundaries.incomplete ?? null);
    }
    if (where?.policyDecisionAt?.lte && where?.policyEffectiveBoundaryAt?.gt) {
      return Promise.resolve(boundaries.overlap ?? null);
    }
    if (where?.policyDecisionAt?.gt) {
      return Promise.resolve(boundaries.future ?? null);
    }
    if (where?.policyEffectiveBoundaryAt?.lte) {
      return Promise.resolve(boundaries.latest ?? null);
    }
    return Promise.resolve(null);
  });
}

function canonicalTestJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalTestJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, entry]) => `${JSON.stringify(key)}:${canonicalTestJson(entry)}`)
    .join(',')}}`;
}

function gatewayReservationInput(
  prisma: any,
  options: {
    amountUsd: Prisma.Decimal.Value;
    requestId?: string;
    occurredAt?: Date;
    firstReceivedAt?: Date;
    firstReceiptSequence?: bigint;
  },
) {
  const requestId = options.requestId ?? 'req-enterprise-funding-1';
  const occurredAt = options.occurredAt ?? new Date('2026-07-05T00:00:00.000Z');
  const firstReceivedAt = options.firstReceivedAt ?? occurredAt;
  const input = {
    gatewayBillingEventId: `event-${requestId}`,
    requestId,
    billingAccountId: 'ba_personal_u1',
    tenantId: 'tenant-1',
    userId: 'u1',
    apiKeyId: 'key-enterprise-1',
    billingCurrency: 'USD',
    occurredAt,
    firstReceivedAt,
    firstReceiptSequence: options.firstReceiptSequence ?? 1n,
    anchorHash: `anchor-${requestId}`,
    reservedAmountUsd: new Prisma.Decimal(options.amountUsd),
  };
  prisma.gatewayUsageSettlementAnchor.findUnique.mockResolvedValue({
    requestId: input.requestId,
    apiKeyId: input.apiKeyId,
    userId: input.userId,
    tenantId: input.tenantId,
    billingAccountId: input.billingAccountId,
    billingUnit: 'BALANCE',
    billingCurrency: input.billingCurrency,
    occurredAt: input.occurredAt,
    firstReceivedAt: input.firstReceivedAt,
    firstReceiptSequence: input.firstReceiptSequence,
    fundingReservationProtocol: 'V1',
    anchorHash: input.anchorHash,
  });
  return input;
}

function installCreatedGatewayReservationForSettlement(
  prisma: any,
  input: ReturnType<typeof gatewayReservationInput>,
) {
  const created = prisma.gatewayUsageFundingReservation.create.mock.calls.at(-1)?.[0]?.data;
  if (!created) throw new Error('test Gateway funding reservation was not created');
  const row = { id: 'reservation-1', billingUnit: 'BALANCE', ...created };
  prisma.gatewayUsageFundingReservation.findUnique.mockImplementation(
    async ({ where }: any) => (where.requestId === input.requestId ? row : null),
  );
  prisma.gatewayUsageFundingReservation.aggregate.mockResolvedValue({
    _sum: {
      reservedAmountUsd: row.reservedAmountUsd,
      collectedUsd: row.collectedUsd,
      approvedCreditUsd: row.approvedCreditUsd,
    },
  });
  return {
    row,
    deductOptions: {
      allowTerminalSettlement: true,
      fundingReservation: {
        requestId: input.requestId,
        anchorHash: input.anchorHash,
        gatewayBillingEventId: input.gatewayBillingEventId,
        evidenceHash: `evidence-${input.requestId}`,
      },
    },
  };
}

function installFrozenGatewayReservationForSettlement(
  prisma: any,
  options: {
    amountUsd: Prisma.Decimal.Value;
    approvedCreditUsd: Prisma.Decimal.Value;
    unapprovedDebtUsd: Prisma.Decimal.Value;
    creditLimitUsd: Prisma.Decimal.Value;
    creditTermsDays: number | null;
    requestId?: string;
  },
) {
  const input = gatewayReservationInput(prisma, {
    amountUsd: options.amountUsd,
    requestId: options.requestId,
  });
  const canonicalPayload = { collectedGrantSlices: [] };
  const row = {
    id: 'reservation-frozen-1',
    gatewayBillingEventId: input.gatewayBillingEventId,
    requestId: input.requestId,
    billingAccountId: input.billingAccountId,
    tenantId: input.tenantId,
    userId: input.userId,
    apiKeyId: input.apiKeyId,
    billingCurrency: input.billingCurrency,
    billingUnit: 'BALANCE',
    collectedFundingProtocol: 'NON_EXPIRING_GRANTS_V1',
    occurredAt: input.occurredAt,
    firstReceivedAt: input.firstReceivedAt,
    reservationSequence: input.firstReceiptSequence,
    reservedAmountUsd: new Prisma.Decimal(options.amountUsd),
    collectedUsd: new Prisma.Decimal(0),
    approvedCreditUsd: new Prisma.Decimal(options.approvedCreditUsd),
    unapprovedDebtUsd: new Prisma.Decimal(options.unapprovedDebtUsd),
    creditPolicyAt: input.occurredAt,
    creditPolicyRevision: 1,
    creditPolicySource: 'EVENT_NEW_STATE',
    creditPolicyReconstructible: true,
    creditLimitUsd: new Prisma.Decimal(options.creditLimitUsd),
    creditTermsDays: options.creditTermsDays,
    approvedCreditDueAt: options.creditTermsDays
      ? new Date(input.occurredAt.getTime() + options.creditTermsDays * 86_400_000)
      : null,
    creditStatus: new Prisma.Decimal(options.creditLimitUsd).gt(0) ? 'ACTIVE' : null,
    creditEffectiveAt: null,
    creditExpiresAt: null,
    anchorHash: input.anchorHash,
    reservationHash: createHash('sha256')
      .update(canonicalTestJson(canonicalPayload))
      .digest('hex'),
    canonicalPayload,
    status: 'ACTIVE',
    reviewReason: null,
  };
  prisma.gatewayUsageFundingReservation.findUnique.mockResolvedValue(row);
  prisma.gatewayUsageFundingReservation.aggregate.mockResolvedValue({
    _sum: {
      reservedAmountUsd: row.reservedAmountUsd,
      collectedUsd: row.collectedUsd,
      approvedCreditUsd: row.approvedCreditUsd,
    },
  });
  return {
    row,
    deductOptions: {
      allowTerminalSettlement: true,
      fundingReservation: {
        requestId: input.requestId,
        anchorHash: input.anchorHash,
        gatewayBillingEventId: input.gatewayBillingEventId,
        evidenceHash: `evidence-${input.requestId}`,
      },
    },
  };
}

function configureBillingMemberSubject(
  prisma: any,
  currentUserId = 'u1',
  ownerUserId = 'owner-1',
): void {
  prisma.tenant.findUnique.mockResolvedValue({
    id: 'tenant-1',
    name: 'Team workspace',
    type: 'team',
    status: 'active',
    ownerUserId,
    billingAccountId: 'ba_personal_u1',
    deletedAt: null,
    balanceAllowanceUsd: null,
    balanceAllowanceUsedUsd: new Prisma.Decimal(0),
  });
  prisma.tenantMember.findFirst.mockResolvedValue({
    id: `tm-${currentUserId}`,
    role: 'member',
    status: 'active',
  });
  prisma.billingAccount.findUnique.mockResolvedValue({
    id: 'ba_personal_u1',
    type: 'personal',
    status: 'active',
    ownerUserId,
    name: 'Owner personal account',
    deletedAt: null,
    currency: 'USD',
    balanceGrantLedgerStatus: 'RECONCILED_V2',
    balanceGrantLedgerVersion: 2,
    creditConfig: null,
  });
  prisma.billingAccountMember.findFirst.mockResolvedValue({
    role: 'member',
    status: 'active',
  });
}

function configureRechargeRefundAnchor(
  prisma: any,
  options: {
    orderId?: string;
    userId?: string;
    tenantId?: string;
    billingAccountId?: string;
    productId?: string | null;
    existingRefund?: Record<string, unknown> | null;
  } = {},
): void {
  const orderId = options.orderId ?? 'order-1';
  const userId = options.userId ?? 'u1';
  const tenantId = options.tenantId ?? 'tenant-1';
  const billingAccountId = options.billingAccountId ?? 'ba_personal_u1';
  const productId = options.productId ?? null;
  const originalRecharge = {
    id: `tx-recharge-${orderId}`,
    userId,
    tenantId,
    billingAccountId,
    productId,
    type: 'RECHARGE',
    amountUsd: new Prisma.Decimal('100'),
    balanceAfterUsd: new Prisma.Decimal('100'),
    description: `recharge:${orderId}`,
    orderId,
    createdAt: new Date('2025-01-01T00:00:00.000Z'),
  };
  prisma.order.findUnique.mockResolvedValue({
    userId,
    tenantId,
    billingAccountId,
    productId,
    orderType: 'RECHARGE',
  });
  prisma.balanceTransaction.findFirst.mockImplementation(({ where }: any) => {
    if (where?.type === 'RECHARGE') return Promise.resolve(originalRecharge);
    if (where?.type === 'REFUND') return Promise.resolve(options.existingRefund ?? null);
    if (where?.OR) {
      const wantsRefund = where.OR.some((entry: any) => entry?.type === 'REFUND');
      if (wantsRefund) return Promise.resolve(options.existingRefund ?? null);
    }
    return Promise.resolve(null);
  });
}

function mockRefundLedgerQueries(
  prisma: any,
  openDebtBeforeUsd: Prisma.Decimal.Value,
  postcondition: {
    activeGrantUsd: Prisma.Decimal.Value;
    openDebtUsd: Prisma.Decimal.Value;
  },
): void {
  prisma.$queryRaw.mockImplementation(async (
    query: TemplateStringsArray,
    ...values: unknown[]
  ) => {
    const sql = String(query);
    if (
      sql.includes('AS "open_debt_usd"')
      && sql.includes('AS "invalid_debt_count"')
      && !sql.includes('AS "active_grant_usd"')
    ) {
      return [{
        open_debt_usd: new Prisma.Decimal(openDebtBeforeUsd),
        invalid_debt_count: BigInt(0),
        invalid_sequence_count: BigInt(0),
        unexpected_debt_count: BigInt(0),
      }];
    }
    if (
      sql.includes('AS "active_grant_usd"')
      && sql.includes('AS "invalid_component_count"')
      && !sql.includes('AS "wallet_usd"')
    ) {
      return [{
        active_grant_usd: new Prisma.Decimal(postcondition.activeGrantUsd),
        open_debt_usd: new Prisma.Decimal(postcondition.openDebtUsd),
        invalid_component_count: BigInt(0),
        invalid_sequence_count: BigInt(0),
        unexpected_debt_count: BigInt(0),
      }];
    }
    return prisma.__defaultQueryRaw(query, ...values);
  });
}

async function buildService(
  prismaOverrides = {},
  redisOverrides = {},
  repoOverrides = {},
  creditPolicy?: { resolvePolicyForUser: jest.Mock },
  publisherOverrides?: Partial<ReturnType<typeof makePublisherSync>>,
  deploymentCurrency = 'usd',
  gatewayClockMaxSkewMs?: string | number,
) {
  const prisma = { ...makePrisma(), ...prismaOverrides };
  const redis = { ...makeRedis(), ...redisOverrides };
  const repo = { ...makeBillingRepo(), ...repoOverrides };
  const publisher = publisherOverrides
    ? { ...makePublisherSync(), ...publisherOverrides }
    : undefined;
  repo.aggregateBalance.mockImplementation((_userId: string, subject: { tenantId?: string; billingAccountId?: string }) =>
    prisma.accountWallet.findUnique({
      where: { billingAccountId: subject?.billingAccountId ?? 'ba_personal_u1' },
    }),
  );

  const providers: any[] = [
      BillingService,
      SubscriptionLifecycleService,
      { provide: PrismaService, useValue: prisma },
    { provide: RedisService, useValue: redis },
    { provide: BillingRepository, useValue: repo },
    { provide: SubscriptionResolverService, useValue: { resolve: jest.fn(), invalidateCache: jest.fn() } },
    {
      provide: SystemConfigService,
      useValue: {
        getDeploymentConfig: jest.fn().mockResolvedValue({
          region: deploymentCurrency === 'cny' ? 'domestic' : 'overseas',
          currency: deploymentCurrency,
        }),
      },
    },
  ];
  // Only wire CreditPolicyService when explicitly requested — leaves the rest of the
  // existing suite running with @Optional() injection (i.e. policy hook absent).
  if (creditPolicy) {
    providers.push({ provide: CreditPolicyService, useValue: creditPolicy });
  }
  if (publisher) {
    providers.push({ provide: PublisherSyncService, useValue: publisher });
  }
  if (gatewayClockMaxSkewMs !== undefined) {
    providers.push({
      provide: ConfigService,
      useValue: {
        get: jest.fn((key: string) => (
          key === 'BILLING_GATEWAY_CLOCK_MAX_SKEW_MS'
            ? gatewayClockMaxSkewMs
            : undefined
        )),
      },
    });
  }

  const m = await Test.createTestingModule({
    providers,
  }).compile();

  return { service: m.get(BillingService) as BillingService, prisma, redis, repo, publisher };
}

async function withMissingGatewayClockMaxSkew<T>(run: () => Promise<T>): Promise<T> {
  const previous = process.env.BILLING_GATEWAY_CLOCK_MAX_SKEW_MS;
  delete process.env.BILLING_GATEWAY_CLOCK_MAX_SKEW_MS;
  try {
    return await run();
  } finally {
    if (previous === undefined) {
      delete process.env.BILLING_GATEWAY_CLOCK_MAX_SKEW_MS;
    } else {
      process.env.BILLING_GATEWAY_CLOCK_MAX_SKEW_MS = previous;
    }
  }
}

describe('BillingService.resolveSubjectForUser', () => {
  it('returns current tenant subject when tenantId is empty', async () => {
    const { service, prisma } = await buildService();

    await expect(service.resolveSubjectForUser('u1')).resolves.toEqual({
      resolvedForUserId: 'u1',
      tenantId: 'tenant-1',
      tenantName: 'Personal workspace',
      tenantType: 'personal',
      tenantStatus: 'active',
      tenantOwnerUserId: 'u1',
      membershipRole: 'owner',
      membershipStatus: 'active',
      billingAccountId: 'ba_personal_u1',
      billingAccountType: 'personal',
      billingAccountStatus: 'active',
      billingAccountOwnerUserId: 'u1',
      billingAccountName: 'Personal account',
      billingAccountMembershipRole: 'owner',
      billingAccountMembershipStatus: 'active',
    });
    expect(prisma.tenantMember.findFirst).toHaveBeenCalled();
  });

  it('allows active tenant members when no billing role is required', async () => {
    const { service, prisma } = await buildService();
    configureBillingMemberSubject(prisma);

    await expect(service.resolveSubjectForUser('u1', 'tenant-1')).resolves.toEqual({
      resolvedForUserId: 'u1',
      tenantId: 'tenant-1',
      tenantName: 'Team workspace',
      tenantType: 'team',
      tenantStatus: 'active',
      tenantOwnerUserId: 'owner-1',
      membershipRole: 'member',
      membershipStatus: 'active',
      billingAccountId: 'ba_personal_u1',
      billingAccountType: 'personal',
      billingAccountStatus: 'active',
      billingAccountOwnerUserId: 'owner-1',
      billingAccountName: 'Owner personal account',
      billingAccountMembershipRole: 'member',
      billingAccountMembershipStatus: 'active',
    });
  });

  it('rejects a member for tenant billing writes', async () => {
    const { service, prisma } = await buildService();
    configureBillingMemberSubject(prisma);

    await expect(
      service.resolveSubjectForUser('u1', 'tenant-1', { requireBillingRole: true }),
    ).rejects.toThrow('无权访问该团队账务');
  });

  it.each(['admin', 'billing_admin'])('rejects legacy raw %s roles', async (role) => {
    const { service, prisma } = await buildService();
    prisma.tenantMember.findFirst.mockResolvedValue({ id: 'tm1', role, status: 'active' });

    await expect(
      service.resolveSubjectForUser('u1', 'tenant-1'),
    ).rejects.toThrow('账务主体配置不一致');
  });

  it('rejects a raw owner role when the requester is not the canonical tenant owner', async () => {
    const { service, prisma } = await buildService();
    configureBillingMemberSubject(prisma);
    prisma.tenantMember.findFirst.mockResolvedValue({
      id: 'tm-u1',
      role: 'owner',
      status: 'active',
    });

    await expect(service.resolveSubjectForUser('u1', 'tenant-1'))
      .rejects.toThrow('账务主体配置不一致');
  });

  it('allows an enterprise owner only when the tenant and billing owner chain agrees', async () => {
    const { service, prisma } = await buildService();
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'tenant-ent-1',
      name: 'Enterprise workspace',
      type: 'enterprise',
      status: 'active',
      ownerUserId: 'u1',
      billingAccountId: 'ba-ent-1',
      deletedAt: null,
    });
    prisma.billingAccount.findUnique.mockResolvedValue({
      id: 'ba-ent-1',
      type: 'enterprise',
      status: 'active',
      ownerUserId: 'u1',
      name: 'Enterprise account',
      deletedAt: null,
    });

    await expect(
      service.resolveSubjectForUser('u1', 'tenant-ent-1', { requireBillingRole: true }),
    ).resolves.toEqual(expect.objectContaining({
      tenantId: 'tenant-ent-1',
      billingAccountId: 'ba-ent-1',
      membershipRole: 'owner',
      billingAccountType: 'enterprise',
    }));
  });

  it('rejects an owner when the billing account owner does not match', async () => {
    const { service, prisma } = await buildService();
    prisma.billingAccount.findUnique.mockResolvedValue({
      id: 'ba_personal_u1',
      type: 'personal',
      status: 'active',
      ownerUserId: 'another-user',
      name: 'Mismatched account',
      deletedAt: null,
    });
    await expect(service.resolveSubjectForUser('u1', 'tenant-1', { requireBillingRole: true }))
      .rejects.toThrow('账务主体配置不一致');
  });

  it('rejects an enterprise tenant bound to a personal account even for read access', async () => {
    const { service, prisma } = await buildService();
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'tenant-ent-1',
      name: 'Enterprise workspace',
      type: 'enterprise',
      status: 'active',
      ownerUserId: 'u1',
      billingAccountId: 'ba-personal-wrong',
      deletedAt: null,
    });
    prisma.billingAccount.findUnique.mockResolvedValue({
      id: 'ba-personal-wrong',
      type: 'personal',
      status: 'active',
      ownerUserId: 'u1',
      name: 'Wrong personal account',
      deletedAt: null,
    });

    await expect(service.resolveSubjectForUser('u1', 'tenant-ent-1'))
      .rejects.toThrow('账务主体配置不一致');
  });

  it('rejects an owner without an active billing-account owner membership', async () => {
    const { service, prisma } = await buildService();
    prisma.billingAccountMember.findFirst.mockResolvedValue({ role: 'member', status: 'active' });
    await expect(service.resolveSubjectForUser('u1', 'tenant-1', { requireBillingRole: true }))
      .rejects.toThrow('无权访问该团队账务');
  });

  it('rejects missing tenant when explicit tenant context is required', async () => {
    const { service, prisma } = await buildService();
    await expect(service.resolveSubjectForUser('u1', undefined, { requireExplicitTenant: true }))
      .rejects.toThrow('账务操作必须明确指定工作区 tenantId');
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
  });

  it('rejects missing tenant membership', async () => {
    const { service, prisma } = await buildService();
    prisma.tenantMember.findFirst.mockResolvedValue(null);

    await expect(service.resolveSubjectForUser('u1', 'tenant-1')).rejects.toThrow(
      '无权访问该团队账务',
    );
  });

  it('atomically creates a personal account aggregate with the deployment currency', async () => {
    const { service, prisma } = await buildService(
      {}, {}, {}, undefined, undefined, 'cny',
    );
    let bound = false;
    prisma.tenant.findUnique.mockImplementation(async () => ({
      id: 'tenant-1',
      name: 'Personal workspace',
      type: 'personal',
      status: 'active',
      ownerUserId: 'u1',
      billingAccountId: bound ? 'ba_personal_u1' : null,
      deletedAt: null,
    }));
    prisma.tenant.update.mockImplementation(async ({ data }: any) => {
      if (data.billingAccountId) bound = true;
      return { id: 'tenant-1', ...data };
    });
    prisma.user.findUnique.mockResolvedValue({
      email: 'u1@example.com',
      nickname: 'U1',
      isActive: true,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    let accountCreated = false;
    prisma.billingAccount.findUnique.mockImplementation(async () => accountCreated ? {
      id: 'ba_personal_u1',
      type: 'personal',
      status: 'active',
      ownerUserId: 'u1',
      name: 'U1',
      deletedAt: null,
    } : null);
    prisma.billingAccount.create.mockImplementation(async ({ data }: any) => {
      accountCreated = true;
      return data;
    });

    await service.resolveSubjectForUser('u1', 'tenant-1');

    expect(prisma.billingAccount.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ currency: 'CNY' }),
    }));
    expect(prisma.accountWallet.create).toHaveBeenCalledWith({
      data: {
        billingAccountId: 'ba_personal_u1',
        balanceUsd: new Prisma.Decimal(0),
      },
    });
    expect(prisma.billingAccountMember.create).toHaveBeenCalled();
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: 'tenant-1' },
      data: { billingAccountId: 'ba_personal_u1' },
    });
  });

  it('fails closed without binding or repairing when an existing account has no wallet', async () => {
    const { service, prisma } = await buildService();
    prisma.__deleteWallet('ba_personal_u1');
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'tenant-1',
      name: 'Unbound personal workspace',
      type: 'personal',
      status: 'active',
      ownerUserId: 'u1',
      billingAccountId: null,
      deletedAt: null,
    });

    let caught: unknown;
    try {
      await service.resolveSubjectForUser('u1', 'tenant-1');
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      status: 409,
      response: { code: 'billing_account_not_provisioned' },
    });
    expect(prisma.accountWallet.create).not.toHaveBeenCalled();
    expect(prisma.accountWallet.upsert).not.toHaveBeenCalled();
    expect(prisma.billingAccountMember.upsert).not.toHaveBeenCalled();
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('binds an existing personal account without rewriting its ledger currency', async () => {
    const { service, prisma } = await buildService();
    let bound = false;
    prisma.tenant.findUnique.mockImplementation(async () => ({
      id: 'tenant-1',
      name: 'Personal workspace',
      type: 'personal',
      status: 'active',
      ownerUserId: 'u1',
      billingAccountId: bound ? 'ba_personal_u1' : null,
      deletedAt: null,
    }));
    prisma.tenant.update.mockImplementation(async ({ data }: any) => {
      if (data.billingAccountId) bound = true;
      return { id: 'tenant-1', ...data };
    });

    await service.resolveSubjectForUser('u1', 'tenant-1');

    expect(prisma.billingAccount.update).not.toHaveBeenCalled();
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: 'tenant-1' },
      data: { billingAccountId: 'ba_personal_u1' },
    });
  });

  it('requires a drained migration instead of mutating an existing account currency', async () => {
    const { service, prisma } = await buildService(
      {}, {}, {}, undefined, undefined, 'cny',
    );
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'tenant-1',
      name: 'Personal workspace',
      type: 'personal',
      status: 'active',
      ownerUserId: 'u1',
      billingAccountId: null,
      deletedAt: null,
    });

    await expect(service.resolveSubjectForUser('u1', 'tenant-1')).rejects.toMatchObject({
      status: 409,
      response: {
        code: 'billing_account_currency_migration_required',
      },
    });

    expect(prisma.billingAccount.update).not.toHaveBeenCalled();
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('keeps enterprise fallback fail-closed in production even when warn is configured', async () => {
    const previousNodeEnv = process.env.NODE_ENV;
    const previousFallbackMode = process.env.BILLING_ENTERPRISE_FALLBACK_MODE;
    process.env.NODE_ENV = 'production';
    process.env.BILLING_ENTERPRISE_FALLBACK_MODE = 'warn';
    try {
      const { service, prisma } = await buildService();
      prisma.tenant.findUnique.mockResolvedValue({
        id: 'tenant-ent-unbound',
        name: 'Unbound enterprise',
        type: 'enterprise',
        status: 'active',
        ownerUserId: 'u1',
        billingAccountId: null,
        deletedAt: null,
      });

      await expect(service.resolveSubjectForUser('u1', 'tenant-ent-unbound'))
        .rejects.toThrow('企业工作区尚未开通企业账户');
      expect(prisma.billingAccount.upsert).not.toHaveBeenCalled();
      expect(prisma.tenant.update).not.toHaveBeenCalled();
    } finally {
      if (previousNodeEnv === undefined) delete process.env.NODE_ENV;
      else process.env.NODE_ENV = previousNodeEnv;
      if (previousFallbackMode === undefined) {
        delete process.env.BILLING_ENTERPRISE_FALLBACK_MODE;
      } else {
        process.env.BILLING_ENTERPRISE_FALLBACK_MODE = previousFallbackMode;
      }
    }
  });
});

describe('BillingService.getCurrentSubscriptionBySlug', () => {
  let service: BillingService;
  let prisma: any;

  const emptyData = {
    productId: null,
    billingMode: null,
    fulfillmentMode: null,
    planId: null,
    planName: '未订阅',
    billingPeriod: null,
    monthlyPrice: 0,
    monthlyCredits: 0,
    rateLimitRpm: 0,
    rateLimitTpm: 0,
    maxContextWindow: 0,
    features: [],
    status: 'none',
    expiresAt: null,
  };

  beforeEach(async () => {
    const ctx = await buildService();
    service = ctx.service;
    prisma = ctx.prisma;
  });

  it('returns empty when product slug not found', async () => {
    prisma.product.findFirst.mockResolvedValue(null);
    const r = await service.getCurrentSubscriptionBySlug('u1', undefined, 'chat-default');
    expect(r).toEqual(emptyData);
  });

  it('resolves product by slug when productId not given', async () => {
    prisma.product.findFirst.mockResolvedValue({
      id: 'p1',
      name: 'Chat',
      slug: 'chat-default',
      billingMode: 'SUBSCRIPTION',
    });
    prisma.subscriptionPeriod.findFirst.mockResolvedValue({
      id: 'period-1',
      expiresAt: null,
      plan: {
        id: 'free',
        name: 'Free',
        monthlyPrice: 0,
        monthlyCredits: 100,
        rateLimitRpm: 10,
        rateLimitTpm: 10000,
        maxContextWindow: 8192,
        features: '["feature1"]',
      },
    });

    const r = await service.getCurrentSubscriptionBySlug('u1', undefined, 'chat-default');

    expect(prisma.product.findFirst).toHaveBeenCalledWith({
      where: {
        slug: { equals: 'chat-default', mode: 'insensitive' },
        deletedAt: null,
        isActive: true,
      },
      select: { id: true, name: true, slug: true, billingMode: true, codingPlanFulfillmentMode: true },
    });
    expect(r.planId).toBe('free');
    expect(r.planName).toBe('Free');
    expect(r.status).toBe('active');
    expect(r.features).toEqual(['feature1']);
  });

  it('uses given productId directly when provided', async () => {
    prisma.product.findFirst.mockResolvedValue({
      id: 'p2',
      name: 'Chat',
      slug: 'chat-default',
      billingMode: 'SUBSCRIPTION',
    });
    prisma.subscriptionPeriod.findFirst.mockResolvedValue({
      id: 'period-1',
      expiresAt: new Date('2026-12-31'),
      plan: {
        id: 'pro',
        name: 'Pro',
        monthlyPrice: 999,
        monthlyCredits: 1000,
        rateLimitRpm: 60,
        rateLimitTpm: 100000,
        maxContextWindow: 128000,
        features: '[]',
      },
    });

    const r = await service.getCurrentSubscriptionBySlug('u1', 'p2', 'chat-default');

    expect(prisma.product.findFirst).toHaveBeenCalledWith({
      where: {
        isActive: true,
        deletedAt: null,
        OR: [
          { id: 'p2' },
          { slug: { equals: 'p2', mode: 'insensitive' } },
        ],
      },
      select: { id: true, name: true, slug: true, billingMode: true, codingPlanFulfillmentMode: true },
    });
    expect(prisma.product.findUnique).not.toHaveBeenCalled();
    expect(r.planId).toBe('pro');
    expect(r.status).toBe('active');
    expect(r.expiresAt).toBe(new Date('2026-12-31').toISOString());
  });

  it('returns empty with status=none when user has no active sub', async () => {
    prisma.product.findFirst.mockResolvedValue({ id: 'p1' });
    prisma.subscriptionPeriod.findFirst.mockResolvedValue(null);

    const r = await service.getCurrentSubscriptionBySlug('u1', undefined, 'chat-default');

    expect(r).toEqual(emptyData);
  });

  it('parses null features as empty array in active subscription', async () => {
    prisma.product.findFirst.mockResolvedValue({ id: 'p1' });
    prisma.subscriptionPeriod.findFirst.mockResolvedValue({
      id: 'period-1',
      expiresAt: null,
      plan: {
        id: 'p-x',
        name: 'Custom',
        monthlyPrice: 100,
        monthlyCredits: 500,
        rateLimitRpm: 30,
        rateLimitTpm: 50000,
        maxContextWindow: 32768,
        features: null, // test the || '[]' branch
      },
    });

    const r = await service.getCurrentSubscriptionBySlug('u1', 'p1', 'default');
    expect(r.features).toEqual([]);
  });

  it('returns empty with status=expired when sub is expired', async () => {
    prisma.product.findFirst.mockResolvedValue({ id: 'p1' });
    prisma.subscriptionPeriod.findFirst.mockResolvedValue(null);

    const r = await service.getCurrentSubscriptionBySlug('u1', undefined, 'chat-default');

    expect(r.status).toBe('none');
    expect(r.planId).toBeNull();
  });
});

// ============================================================
// BillingService.getPlans / getPlanById
// ============================================================
describe('BillingService.getPlans / getPlanById', () => {
  it('getPlans returns mapped plan array', async () => {
    const { service, repo } = await buildService();
    repo.findActivePlans.mockResolvedValue([
      {
        id: 'free', productId: 'p1', name: 'Free', description: 'free tier',
        planType: 'MONTHLY', monthlyPrice: 0, yearlyPrice: 0, billingPeriod: 'MONTHLY',
        monthlyCredits: 100, creditsRollover: false, rolloverMaxMonths: 0,
        rateLimitRpm: 10, rateLimitTpm: 1000, maxContextWindow: 4096,
        overageEnabled: false, usageMultiplier: 1, memberLimit: 1, minimumSeats: 1,
        dataTraining: false, supportTier: 'none', ssoEnabled: false, priorityAccess: false,
        badge: null, trialDays: 0, features: '[]', isActive: true, isLegacy: false,
        sortOrder: 1, createdAt: new Date('2025-01-01'), updatedAt: new Date('2025-01-01'),
      },
    ]);
    const plans = await service.getPlans();
    expect(plans).toHaveLength(1);
    expect(plans[0].id).toBe('free');
    expect(plans[0].features).toEqual([]);
  });

  it('getPlans marks limited provider resale plans as sold out', async () => {
    const { service, repo, prisma } = await buildService();
    repo.findActivePlans.mockResolvedValue([
      {
        id: 'resale-pro', productId: 'prod-resale', name: 'Resale Pro', description: '',
        planType: 'coding_plan', monthlyPrice: 9900, yearlyPrice: 9900, billingPeriod: 'monthly',
        monthlyCredits: 0, creditsRollover: false, rolloverMaxMonths: 0,
        rateLimitRpm: 0, rateLimitTpm: 0, maxContextWindow: 0,
        overageEnabled: false, usageMultiplier: 1, memberLimit: 1, minimumSeats: 1,
        dataTraining: false, supportTier: 'none', ssoEnabled: false, priorityAccess: false,
        badge: null, trialDays: 0, features: '[]', isActive: true, isLegacy: false,
        salesLimit: 2, sortOrder: 1, createdAt: new Date('2025-01-01'), updatedAt: new Date('2025-01-01'),
      },
    ]);
    prisma.product.findMany.mockResolvedValue([
      {
        id: 'prod-resale',
        billingMode: ProductBillingMode.CODING_PLAN,
        codingPlanFulfillmentMode: CodingPlanFulfillmentMode.provider_resale,
      },
    ]);
    prisma.order.groupBy.mockResolvedValue([
      { planId: 'resale-pro', _count: { _all: 2 } },
    ]);

    const plans = await service.getPlans();

    expect(plans[0]).toMatchObject({
      salesLimit: 2,
      reservedSalesCount: 2,
      remainingSales: 0,
      soldOut: true,
    });
  });

  it('getPlanById returns plan when found and active', async () => {
    const { service, repo } = await buildService();
    repo.findPlanById.mockResolvedValue({
      id: 'pro', productId: 'p1', name: 'Pro', description: 'pro tier',
      planType: 'MONTHLY', monthlyPrice: 999, yearlyPrice: 0, billingPeriod: 'MONTHLY',
      monthlyCredits: 1000, creditsRollover: false, rolloverMaxMonths: 0,
      rateLimitRpm: 60, rateLimitTpm: 100000, maxContextWindow: 128000,
      overageEnabled: false, usageMultiplier: 1, memberLimit: 5, minimumSeats: 1,
      dataTraining: false, supportTier: 'email', ssoEnabled: false, priorityAccess: false,
      badge: null, trialDays: 0, features: '["feature1"]', isActive: true, isLegacy: false,
      sortOrder: 2, createdAt: new Date('2025-01-01'), updatedAt: new Date('2025-01-01'),
    });
    const plan = await service.getPlanById('pro');
    expect(plan.id).toBe('pro');
    expect(plan.features).toEqual(['feature1']);
  });

  it('getPlanById throws NotFoundException when plan not found', async () => {
    const { service, repo } = await buildService();
    repo.findPlanById.mockResolvedValue(null);
    await expect(service.getPlanById('missing')).rejects.toThrow(NotFoundException);
  });

  it('getPlanById throws NotFoundException when plan is inactive', async () => {
    const { service, repo } = await buildService();
    repo.findPlanById.mockResolvedValue({
      id: 'legacy', isActive: false, name: 'Legacy',
      description: '', planType: 'MONTHLY', monthlyPrice: 0, yearlyPrice: 0,
      billingPeriod: 'MONTHLY', monthlyCredits: 0, creditsRollover: false,
      rolloverMaxMonths: 0, rateLimitRpm: 0, rateLimitTpm: 0, maxContextWindow: 0,
      overageEnabled: false, usageMultiplier: 1, memberLimit: 0, minimumSeats: 1,
      dataTraining: false, supportTier: 'none', ssoEnabled: false, priorityAccess: false,
      badge: null, trialDays: 0, features: '[]', isLegacy: true, sortOrder: 99,
      productId: 'p1', createdAt: new Date(), updatedAt: new Date(),
    });
    await expect(service.getPlanById('legacy')).rejects.toThrow(NotFoundException);
  });
});

// ============================================================
// 自营 CodingPlan 配额模板规则视图（quotaRules）下发到读接口
// 设计：me/plan-quota-display-from-template.md（codesphere-admin 仓）
// ============================================================
describe('BillingService quotaRules（自营 CodingPlan 展示走配额模板）', () => {
  const TEMPLATE_RULES = JSON.stringify([
    { windowType: 'ROLLING', durationLabel: '6h', durationSec: 21600, metric: 'REQUESTS', limitValue: 600 },
    { windowType: 'ROLLING', durationLabel: '7d', durationSec: 604800, metric: 'CREDITS', limitValue: 9000 },
    // token 维度规则：quota-v2 退役，对外视图剔除（不计入 quotaRules）
    { windowType: 'ROLLING', durationLabel: '6h', durationSec: 21600, metric: 'TOTAL_TOKENS', limitValue: 9_000_000 },
  ]);

  // quota-v2 §7：enforced 由总开关 BILLING_ROLLING_QUOTA_GATE_ENABLED 门控（默认关，展示+执行同退）。
  // 展示口径测试在开关开启下断言 enforced 翻转。
  const prevGateFlag = process.env.BILLING_ROLLING_QUOTA_GATE_ENABLED;
  beforeAll(() => {
    process.env.BILLING_ROLLING_QUOTA_GATE_ENABLED = 'true';
  });
  afterAll(() => {
    if (prevGateFlag === undefined) delete process.env.BILLING_ROLLING_QUOTA_GATE_ENABLED;
    else process.env.BILLING_ROLLING_QUOTA_GATE_ENABLED = prevGateFlag;
  });

  function codingPlanRow(overrides: Record<string, unknown> = {}) {
    return {
      id: 'cp-lite', productId: 'prod-cp', name: 'Lite', description: '',
      // 真实存量 CodingPlan 套餐的 planType 可能是历史缺省 'individual'：
      // 判定 CODING_PLAN 的唯一依据必须是 product.billingMode
      planType: 'individual', monthlyPrice: 700, yearlyPrice: 0, billingPeriod: 'monthly',
      monthlyCredits: 500, creditsRollover: false, rolloverMaxMonths: 0,
      rateLimitRpm: 0, rateLimitTpm: 0, maxContextWindow: 0,
      overageEnabled: false, usageMultiplier: 1, memberLimit: 1, minimumSeats: 1,
      dataTraining: 'opt_out', supportTier: 'community', ssoEnabled: false, priorityAccess: false,
      badge: null, trialDays: 0, features: '[]', isActive: true, isLegacy: false,
      sortOrder: 1, createdAt: new Date('2026-01-01'), updatedAt: new Date('2026-01-01'),
      ...overrides,
    };
  }

  it('getPlans attaches enforced-flagged quotaRules to self-operated coding plans', async () => {
    const planQuotaRule = {
      findMany: jest.fn().mockResolvedValue([
        {
          planId: 'cp-lite',
          template: { rules: TEMPLATE_RULES, isActive: true, deletedAt: null },
        },
      ]),
    };
    const { service, repo, prisma } = await buildService({ planQuotaRule });
    prisma.product.findMany = jest.fn().mockResolvedValue([
      { id: 'prod-cp', billingMode: 'CODING_PLAN', codingPlanFulfillmentMode: 'platform_model_package' },
    ]);
    repo.findActivePlans.mockResolvedValue([codingPlanRow()]);

    const plans = await service.getPlans('prod-cp');
    // token 维度规则被剔除：仅 6h REQUESTS + 7d CREDITS（gate 开 → 均 enforced）
    expect(plans[0].quotaRules).toHaveLength(2);
    const sixHour = plans[0].quotaRules!.find((r) => r.metric === 'REQUESTS');
    expect(sixHour).toMatchObject({ durationSec: 21600, limitValue: 600, enforced: true });
    const sevenDay = plans[0].quotaRules!.find((r) => r.metric === 'CREDITS');
    expect(sevenDay).toMatchObject({ durationSec: 604800, enforced: true });
    expect(plans[0].quotaRules!.some((r) => r.metric === 'TOTAL_TOKENS')).toBe(false);
  });

  it('getPlans skips resale coding plans and non-coding products（转售护栏）', async () => {
    const planQuotaRule = { findMany: jest.fn().mockResolvedValue([]) };
    const { service, repo, prisma } = await buildService({ planQuotaRule });
    prisma.product.findMany = jest.fn().mockResolvedValue([
      { id: 'prod-cp', billingMode: 'CODING_PLAN', codingPlanFulfillmentMode: 'provider_resale' },
    ]);
    repo.findActivePlans.mockResolvedValue([
      codingPlanRow({ id: 'cp-resale', features: '[]' }),
    ]);

    const plans = await service.getPlans('prod-cp');
    expect(plans[0].quotaRules).toBeUndefined();
    expect(planQuotaRule.findMany).not.toHaveBeenCalled();
  });

  it('getPlans marks self-op plan soldOut when occupied tenants reach cap（去重 tenant，仅暴露布尔不含份数）', async () => {
    const planQuotaRule = { findMany: jest.fn().mockResolvedValue([]) };
    const { service, repo, prisma } = await buildService({
      planQuotaRule,
      codingPlanEntitlement: { findMany: jest.fn().mockResolvedValue([{ planId: 'cp-lite', tenantId: 't1' }]) },
      order: { findMany: jest.fn().mockResolvedValue([{ planId: 'cp-lite', tenantId: 't2' }]) },
    });
    prisma.product.findMany = jest.fn().mockResolvedValue([
      { id: 'prod-cp', billingMode: 'CODING_PLAN', codingPlanFulfillmentMode: 'platform_model_package' },
    ]);
    repo.findActivePlans.mockResolvedValue([codingPlanRow({ maxSellableQuantity: 2 })]);

    const plans = await service.getPlans('prod-cp');
    // t1(ACTIVE) + t2(在途) 去重=2 ≥ cap 2 → 售罄
    expect(plans[0].soldOut).toBe(true);
    // 不外泄份数/上限
    expect((plans[0] as unknown as Record<string, unknown>).maxSellableQuantity).toBeUndefined();
  });

  it('getPlans not soldOut below cap; 同 tenant 续订+在途去重只算一份', async () => {
    const planQuotaRule = { findMany: jest.fn().mockResolvedValue([]) };
    const { service, repo, prisma } = await buildService({
      planQuotaRule,
      codingPlanEntitlement: { findMany: jest.fn().mockResolvedValue([{ planId: 'cp-lite', tenantId: 't1' }]) },
      order: { findMany: jest.fn().mockResolvedValue([{ planId: 'cp-lite', tenantId: 't1' }]) },
    });
    prisma.product.findMany = jest.fn().mockResolvedValue([
      { id: 'prod-cp', billingMode: 'CODING_PLAN', codingPlanFulfillmentMode: 'platform_model_package' },
    ]);
    repo.findActivePlans.mockResolvedValue([codingPlanRow({ maxSellableQuantity: 2 })]);

    const plans = await service.getPlans('prod-cp');
    expect(plans[0].soldOut).toBe(false); // 去重后 1 < cap 2
  });

  it('getPlans 转售套餐不计售罄（只自营）', async () => {
    const planQuotaRule = { findMany: jest.fn().mockResolvedValue([]) };
    const { service, repo, prisma } = await buildService({
      planQuotaRule,
      codingPlanEntitlement: { findMany: jest.fn().mockResolvedValue([{ planId: 'cp-lite', tenantId: 't1' }, { planId: 'cp-lite', tenantId: 't2' }]) },
      order: { findMany: jest.fn().mockResolvedValue([]) },
    });
    prisma.product.findMany = jest.fn().mockResolvedValue([
      { id: 'prod-cp', billingMode: 'CODING_PLAN', codingPlanFulfillmentMode: 'provider_resale' },
    ]);
    repo.findActivePlans.mockResolvedValue([codingPlanRow({ maxSellableQuantity: 1 })]);

    const plans = await service.getPlans('prod-cp');
    expect(plans[0].soldOut).toBe(false); // 转售不进自营售罄计算(salesLimit=0 亦不售罄)
  });

  it('getPlans degrades gracefully when quota rule loading fails（不阻断套餐列表）', async () => {
    const { service, repo, prisma } = await buildService();
    prisma.product.findMany = jest.fn().mockRejectedValue(new Error('db down'));
    repo.findActivePlans.mockResolvedValue([codingPlanRow()]);

    const plans = await service.getPlans('prod-cp');
    expect(plans).toHaveLength(1);
    expect(plans[0].quotaRules).toBeUndefined();
  });

  it('getCurrentSubscriptionBySlug attaches quotaRules on the CODING_PLAN branch', async () => {
    const codingPlanEntitlement = {
      findFirst: jest.fn().mockResolvedValue({
        id: 'ent-lite',
        planId: 'cp-lite',
        fulfillmentMode: 'platform_model_package',
        expiresAt: new Date('2026-12-31'),
      }),
    };
    const { service, prisma } = await buildService({ codingPlanEntitlement });
    prisma.product.findFirst.mockResolvedValue({
      id: 'prod-cp', name: 'CodingPlan', slug: 'coding-plan', billingMode: 'CODING_PLAN',
    });
    prisma.plan.findUnique.mockResolvedValue({
      id: 'cp-lite', name: 'Lite', monthlyPrice: 700, monthlyCredits: 500,
      rateLimitRpm: 0, rateLimitTpm: 0, maxContextWindow: 0, features: '[]',
      quotaRules: [
        { template: { rules: TEMPLATE_RULES, isActive: true, deletedAt: null } },
      ],
    });

    const r = await service.getCurrentSubscriptionBySlug('u1', 'prod-cp', 'chat-default');
    expect(r.status).toBe('active');
    // entitlement 单一事实源（§4.2）：前端据此过滤/创建专属 Key、拉取套餐 credits
    expect(r.codingPlanEntitlementId).toBe('ent-lite');
    // token 维度剔除：仅 6h REQUESTS + 7d CREDITS，gate 开 → 两条均 enforced
    expect(r.quotaRules).toHaveLength(2);
    expect(r.quotaRules!.filter((rule) => rule.enforced)).toHaveLength(2);
    expect(r.quotaRules!.some((rule) => rule.metric === 'TOTAL_TOKENS')).toBe(false);
    // usageWindows（fix3 §1）：TEMPLATE_RULES 含 7d CREDITS(604800,9000) → week 窗口（默认 mock 无消耗）；
    // 无亚日 CREDITS 滚动规则 → 无 fiveHour。
    expect(r.usageWindows?.week).toEqual({ usedCredits: 0, budgetCredits: 9000, resetInSec: null });
    expect(r.usageWindows?.fiveHour).toBeUndefined();
  });

  it('getCurrentSubscriptionBySlug builds usageWindows used/budget/resetInSec from CREDITS rolling rules', async () => {
    const codingPlanEntitlement = {
      findFirst: jest.fn().mockResolvedValue({
        id: 'ent-lite', planId: 'cp-lite', fulfillmentMode: 'platform_model_package',
        startedAt: new Date('2026-06-01'),
        expiresAt: new Date('2026-12-31'),
      }),
    };
    const RULES = JSON.stringify([
      { windowType: 'ROLLING', durationLabel: '5h', durationSec: 18000, metric: 'CREDITS', limitValue: 240 },
      { windowType: 'ROLLING', durationLabel: '7d', durationSec: 604800, metric: 'CREDITS', limitValue: 1600 },
    ]);
    const { service, prisma } = await buildService({ codingPlanEntitlement });
    prisma.product.findFirst.mockResolvedValue({
      id: 'prod-cp', name: 'CodingPlan', slug: 'coding-plan', billingMode: 'CODING_PLAN',
    });
    prisma.plan.findUnique.mockResolvedValue({
      id: 'cp-lite', name: 'Lite', monthlyPrice: 700, monthlyCredits: 1600,
      rateLimitRpm: 0, rateLimitTpm: 0, maxContextWindow: 0, features: '[]',
      quotaRules: [{ template: { rules: RULES, isActive: true, deletedAt: null } }],
    });
    const now = Date.now();
    // CONSUME 求和 -496（用量取绝对值 496）；窗口内最早一笔在 46h 前。
    prisma.creditTransaction.aggregate.mockResolvedValue({ _sum: { creditsAmount: -496 } });
    prisma.creditTransaction.findFirst.mockResolvedValue({ createdAt: new Date(now - 46 * 3600 * 1000) });

    const r = await service.getCurrentSubscriptionBySlug('u1', 'prod-cp', 'chat-default');
    expect(r.usageWindows?.week?.usedCredits).toBe(496);
    expect(r.usageWindows?.week?.budgetCredits).toBe(1600);
    // 7d(168h) 窗口最早消耗 46h 前 → 约 122h 后出窗（重置倒计时）。
    expect(r.usageWindows?.week?.resetInSec).toBeGreaterThan(121 * 3600);
    expect(r.usageWindows?.week?.resetInSec).toBeLessThanOrEqual(122 * 3600);
    expect(r.usageWindows?.fiveHour?.budgetCredits).toBe(240);
    // 月度累计池（fix3 §1 第 3 卡）：CONSUME 自周期起累计=496、预算=monthlyCredits=1600、reset=至到期(>0)。
    expect(r.usageWindows?.month?.usedCredits).toBe(496);
    expect(r.usageWindows?.month?.budgetCredits).toBe(1600);
    expect(r.usageWindows?.month?.resetInSec).toBeGreaterThan(0);
  });

  it('getCurrentSubscriptionBySlug omits quotaRules for resale coding plans', async () => {
    const codingPlanEntitlement = {
      findFirst: jest.fn().mockResolvedValue({
        id: 'ent-resale',
        planId: 'cp-resale',
        fulfillmentMode: 'provider_resale',
        expiresAt: null,
      }),
    };
    const { service, prisma } = await buildService({ codingPlanEntitlement });
    prisma.product.findFirst.mockResolvedValue({
      id: 'prod-cp', name: 'CodingPlan', slug: 'coding-plan', billingMode: 'CODING_PLAN',
    });
    prisma.plan.findUnique.mockResolvedValue({
      id: 'cp-resale', name: 'Resale', monthlyPrice: 700, monthlyCredits: 0,
      rateLimitRpm: 60, rateLimitTpm: 100000, maxContextWindow: 200000,
      features: '[]',
      quotaRules: [
        { template: { rules: TEMPLATE_RULES, isActive: true, deletedAt: null } },
      ],
    });

    const r = await service.getCurrentSubscriptionBySlug('u1', 'prod-cp', 'chat-default');
    expect(r.status).toBe('active');
    expect(r.quotaRules).toBeUndefined();
    expect(r.rateLimitRpm).toBe(60);
  });

  it('getCurrentSubscriptionBySlug keeps SUBSCRIPTION branch unchanged (no quotaRules)', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findFirst.mockResolvedValue({
      id: 'p1', name: 'Chat', slug: 'chat-default', billingMode: 'SUBSCRIPTION',
    });
    prisma.subscriptionPeriod.findFirst.mockResolvedValue({
      id: 's1', expiresAt: null,
      plan: {
        id: 'pro', name: 'Pro', monthlyPrice: 999, monthlyCredits: 1000,
        rateLimitRpm: 60, rateLimitTpm: 100000, maxContextWindow: 128000, features: '[]',
      },
    });

    const r = await service.getCurrentSubscriptionBySlug('u1', undefined, 'chat-default');
    expect(r.status).toBe('active');
    expect(r.quotaRules).toBeUndefined();
  });

  // me/self-op-subscription-workspace-independent.md：自营(platform_model_package)per-user——
  // 按 userId 查 entitlement、忽略当前工作区，且不解析当前 tenant（切工作区/无成员仍显示）。
  it('getCurrentSubscriptionBySlug queries self-op CODING_PLAN by userId and bypasses current-tenant resolution', async () => {
    const codingPlanEntitlement = {
      findFirst: jest.fn().mockResolvedValue({
        id: 'ent-selfop', planId: 'cp-lite', fulfillmentMode: 'platform_model_package',
        expiresAt: new Date('2026-12-31'),
      }),
    };
    const { service, prisma } = await buildService({ codingPlanEntitlement });
    // 模拟当前工作区无成员/无个人 tenant：旧实现会在 resolveRequiredTenantId 抛 403；自营路径应绕开。
    prisma.tenantMember.findFirst.mockResolvedValue(null);
    prisma.tenant.findFirst.mockResolvedValue(null);
    prisma.product.findFirst.mockResolvedValue({
      id: 'prod-cp', name: 'CodingPlan', slug: 'coding-plan',
      billingMode: 'CODING_PLAN', codingPlanFulfillmentMode: 'platform_model_package',
    });
    prisma.plan.findUnique.mockResolvedValue({
      id: 'cp-lite', name: 'Lite', monthlyPrice: 700, monthlyCredits: 500,
      rateLimitRpm: 0, rateLimitTpm: 0, maxContextWindow: 0, features: '[]',
      quotaRules: [{ template: { rules: TEMPLATE_RULES, isActive: true, deletedAt: null } }],
    });

    const r = await service.getCurrentSubscriptionBySlug('u1', 'prod-cp', 'chat-default');

    expect(r.status).toBe('active');
    expect(r.codingPlanEntitlementId).toBe('ent-selfop');
    // where 按 userId（含 platform_model_package 过滤），且不含 tenantId。
    const where = codingPlanEntitlement.findFirst.mock.calls[0][0].where;
    expect(where.userId).toBe('u1');
    expect(where.fulfillmentMode).toBe('platform_model_package');
    expect(where.tenantId).toBeUndefined();
  });

  it('getCurrentSubscriptionBySlug keeps resale CODING_PLAN on the tenant branch (where by tenantId, not userId)', async () => {
    const codingPlanEntitlement = {
      findFirst: jest.fn().mockResolvedValue({
        id: 'ent-resale', planId: 'cp-resale', fulfillmentMode: 'provider_resale', expiresAt: null,
      }),
    };
    const { service, prisma } = await buildService({ codingPlanEntitlement });
    prisma.product.findFirst.mockResolvedValue({
      id: 'prod-cp', name: 'CodingPlan', slug: 'coding-plan',
      billingMode: 'CODING_PLAN', codingPlanFulfillmentMode: 'provider_resale',
    });
    prisma.plan.findUnique.mockResolvedValue({
      id: 'cp-resale', name: 'Resale', monthlyPrice: 700, monthlyCredits: 0,
      rateLimitRpm: 60, rateLimitTpm: 100000, maxContextWindow: 200000, features: '[]',
      quotaRules: [{ template: { rules: TEMPLATE_RULES, isActive: true, deletedAt: null } }],
    });

    const r = await service.getCurrentSubscriptionBySlug('u1', 'prod-cp', 'chat-default');

    expect(r.status).toBe('active');
    const where = codingPlanEntitlement.findFirst.mock.calls[0][0].where;
    expect(where.tenantId).toBe('tenant-1');
    expect(where.userId).toBeUndefined();
  });
});

// ============================================================
// BillingService self-op resolvers (workspace-independent)
// me/self-op-subscription-workspace-independent.md
// ============================================================
describe('BillingService.isSelfOperatedCodingPlanProduct / resolveSelfOpEntitlementId', () => {
  it('isSelfOperatedCodingPlanProduct: true only for platform_model_package CODING_PLAN', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findFirst.mockResolvedValueOnce({
      id: 'p', billingMode: 'CODING_PLAN', codingPlanFulfillmentMode: 'platform_model_package',
    });
    await expect(service.isSelfOperatedCodingPlanProduct('p')).resolves.toBe(true);

    prisma.product.findFirst.mockResolvedValueOnce({
      id: 'p', billingMode: 'CODING_PLAN', codingPlanFulfillmentMode: 'provider_resale',
    });
    await expect(service.isSelfOperatedCodingPlanProduct('p')).resolves.toBe(false);

    prisma.product.findFirst.mockResolvedValueOnce({
      id: 'p', billingMode: 'SUBSCRIPTION', codingPlanFulfillmentMode: null,
    });
    await expect(service.isSelfOperatedCodingPlanProduct('p')).resolves.toBe(false);

    prisma.product.findFirst.mockResolvedValueOnce(null);
    await expect(service.isSelfOperatedCodingPlanProduct('missing')).resolves.toBe(false);
  });

  it('resolveSelfOpEntitlementId: returns entitlement id by userId for self-op; null when none', async () => {
    const codingPlanEntitlement = { findFirst: jest.fn().mockResolvedValue({ id: 'ent-x' }) };
    const { service, prisma } = await buildService({ codingPlanEntitlement });
    prisma.product.findFirst.mockResolvedValue({
      id: 'prod-cp', billingMode: 'CODING_PLAN', codingPlanFulfillmentMode: 'platform_model_package',
    });

    const found = await service.resolveSelfOpEntitlementId('u1', 'prod-cp');
    expect(found).toEqual({ selfOp: true, entitlementId: 'ent-x' });
    const where = codingPlanEntitlement.findFirst.mock.calls[0][0].where;
    expect(where.userId).toBe('u1');
    expect(where.fulfillmentMode).toBe('platform_model_package');

    codingPlanEntitlement.findFirst.mockResolvedValueOnce(null);
    await expect(service.resolveSelfOpEntitlementId('u1', 'prod-cp')).resolves.toEqual({
      selfOp: true, entitlementId: null,
    });
  });

  it('resolveSelfOpEntitlementId: selfOp=false for resale / SUBSCRIPTION / missing (no entitlement query)', async () => {
    const codingPlanEntitlement = { findFirst: jest.fn() };
    const { service, prisma } = await buildService({ codingPlanEntitlement });

    prisma.product.findFirst.mockResolvedValueOnce({
      id: 'p', billingMode: 'CODING_PLAN', codingPlanFulfillmentMode: 'provider_resale',
    });
    await expect(service.resolveSelfOpEntitlementId('u1', 'p')).resolves.toEqual({
      selfOp: false, entitlementId: null,
    });

    prisma.product.findFirst.mockResolvedValueOnce({
      id: 'p', billingMode: 'SUBSCRIPTION', codingPlanFulfillmentMode: null,
    });
    await expect(service.resolveSelfOpEntitlementId('u1', 'p')).resolves.toEqual({
      selfOp: false, entitlementId: null,
    });

    prisma.product.findFirst.mockResolvedValueOnce(null);
    await expect(service.resolveSelfOpEntitlementId('u1', 'missing')).resolves.toEqual({
      selfOp: false, entitlementId: null,
    });

    expect(codingPlanEntitlement.findFirst).not.toHaveBeenCalled();
  });
});

// ============================================================
// BillingService.getBalance
// ============================================================
describe('BillingService.getBalance', () => {
  it('uses the database snapshot instead of a potentially stale Redis balance', async () => {
    const { service, redis, prisma } = await buildService();
    redis.get.mockResolvedValue('50');
    prisma.__setWalletBalance('tenant-1', 30);

    const balance = await service.getBalance('u1');

    expect(balance).toBe(3000);
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('computes balance from PG without writing cache on a read path', async () => {
    const { service, redis, prisma } = await buildService();
    redis.get.mockResolvedValue(null);
    prisma.__setWalletBalance('tenant-1', 30);

    const balance = await service.getBalance('u1');

    expect(balance).toBe(3000);
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('returns 0 when PG aggregation has no transactions', async () => {
    const { service, redis } = await buildService();
    redis.get.mockResolvedValue(null);

    const balance = await service.getBalance('u1');
    expect(balance).toBe(0);
  });
});

describe('BillingService tenant balance cache binding convergence', () => {
  function statefulRedis() {
    const values = new Map<string, string>();
    return {
      values,
      set: jest.fn(async (key: string, value: string) => {
        values.set(key, value);
        return 'OK';
      }),
      del: jest.fn(async (key: string) => (values.delete(key) ? 1 : 0)),
    };
  }

  it('keeps the current binding value when a stale account projection completes last', async () => {
    const state = statefulRedis();
    const { service, prisma } = await buildService({}, {
      set: state.set,
      del: state.del,
    });
    prisma.__setWalletBalance('ba-current', 25);
    prisma.__setWalletBalance('ba-old', 90);
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'tenant-1',
      name: 'Rebound workspace',
      type: 'team',
      status: 'active',
      ownerUserId: 'u1',
      billingAccountId: 'ba-current',
      deletedAt: null,
      balanceAllowanceUsd: null,
      balanceAllowanceUsedUsd: new Prisma.Decimal(0),
    });
    prisma.billingAccount.findUnique.mockImplementation(async ({ where }: any) => ({
      id: where.id,
      type: 'personal',
      status: 'active',
      ownerUserId: 'u1',
      name: 'Account',
      deletedAt: null,
      creditConfig: null,
    }));

    await service.syncTenantBalanceCacheForCurrentBinding('tenant-1');
    await (service as any).projectAnchoredBalanceCaches('u1', {
      tenantId: 'tenant-1',
      billingAccountId: 'ba-old',
    });

    expect(state.values.get('balance:tenant:tenant-1')).toBe('25.000000000000');
    expect(state.values.get('balance:account:ba-old')).toBe('90.000000000000');
    expect(state.del).not.toHaveBeenCalledWith('balance:tenant:tenant-1');
  });

  it('does not delete a newly rebound tenant key when attach commits between pre-read and lock', async () => {
    const state = statefulRedis();
    state.values.set('balance:tenant:tenant-1', '25.000000000000');
    const { service, prisma } = await buildService({}, {
      set: state.set,
      del: state.del,
    });
    let tenantRead = 0;
    prisma.tenant.findUnique.mockImplementation(async () => {
      tenantRead += 1;
      return {
        id: 'tenant-1',
        ownerUserId: 'u1',
        billingAccountId: tenantRead === 1 ? null : 'ba-current',
      };
    });

    await service.syncTenantBalanceCacheForCurrentBinding('tenant-1');

    expect(state.values.get('balance:tenant:tenant-1')).toBe('25.000000000000');
    expect(state.del).not.toHaveBeenCalled();
  });

  it('deletes the tenant key while the committed binding remains detached', async () => {
    const state = statefulRedis();
    state.values.set('balance:tenant:tenant-1', '25.000000000000');
    const { service, prisma } = await buildService({}, {
      set: state.set,
      del: state.del,
    });
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'tenant-1',
      ownerUserId: 'u1',
      billingAccountId: null,
    });

    await service.syncTenantBalanceCacheForCurrentBinding('tenant-1');

    expect(state.values.has('balance:tenant:tenant-1')).toBe(false);
    expect(state.del).toHaveBeenCalledWith('balance:tenant:tenant-1');
  });
});

// ============================================================
// BillingService.recharge
// ============================================================
describe('BillingService.recharge', () => {
  type RechargeBonusCandidateQuery = {
    where: {
      OR: Array<{
        operationKey: string | null;
        amountUsd?: { gt: Prisma.Decimal };
      }>;
    };
  };

  function rechargeReplayGrant(overrides: Record<string, any> = {}) {
    return {
      id: 'grant-replay',
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      orderId: 'order-replay',
      productId: 'prod-1',
      source: 'RECHARGE',
      paidAmountUsd: new Prisma.Decimal(10),
      bonusAmountUsd: new Prisma.Decimal(0),
      grantedAmountUsd: new Prisma.Decimal(10),
      ...overrides,
    };
  }

  function rechargeReplayTransaction(overrides: Record<string, any> = {}) {
    return {
      id: 'tx-recharge-replay',
      operationKey: null,
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      type: 'RECHARGE',
      amountUsd: new Prisma.Decimal(10),
      balanceAfterUsd: new Prisma.Decimal(10),
      description: '充值',
      orderId: 'order-replay',
      productId: 'prod-1',
      createdAt: new Date('2026-07-15T00:00:00.000Z'),
      ...overrides,
    };
  }

  it('increments wallet balance and records PG transaction', async () => {
    const { service, redis, prisma } = await buildService();
    prisma.__setWalletBalance('u1', 30);

    const result = await service.recharge('u1', 2000, '充值', 'order-1');

    expect(redis.set).toHaveBeenCalledWith('balance:tenant:tenant-1', '50.000000000000');
    expect(prisma.balanceTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'u1',
          type: 'RECHARGE',
          amountUsd: new Prisma.Decimal('20'),
          balanceAfterUsd: new Prisma.Decimal('50'),
          description: '充值',
          orderId: 'order-1',
        }),
      }),
    );
    expect(result.type).toBe('RECHARGE');
    expect(result.amountCents).toBe(2000);
    expect(result.balanceAfterCents).toBe(5000);
  });

  it.each([
    ['zero paid amount', 0, 0, '充值金额必须为正整数分值'],
    ['negative paid amount', -1, 0, '充值金额必须为正整数分值'],
    ['fractional paid amount', 100.5, 0, '充值金额必须为正整数分值'],
    ['unsafe paid amount', Number.MAX_SAFE_INTEGER + 1, 0, '充值金额必须为正整数分值'],
    ['negative bonus', 100, -1, '充值赠额必须为非负整数分值'],
    ['fractional bonus', 100, 0.5, '充值赠额必须为非负整数分值'],
    ['unsafe bonus', 100, Number.MAX_SAFE_INTEGER + 1, '充值赠额必须为非负整数分值'],
  ])('rejects %s before any financial write', async (_label, amountCents, bonusCents, message) => {
    const { service, prisma } = await buildService();

    await expect(service.rechargeWithBonus(
      'u1',
      amountCents as number,
      bonusCents as number,
      'invalid recharge',
    )).rejects.toThrow(message as string);

    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
    expect(prisma.balanceGrant.create).not.toHaveBeenCalled();
  });

  it('fans out key-balance only when recharge restores workspace funding', async () => {
    const { service, publisher, prisma, redis } = await buildService({}, {}, {}, undefined, {});
    prisma.__setWalletBalance('u1', 0);

    await service.recharge('u1', 1000, '充值', 'order-restore');

    expect(publisher?.syncBillingAccountKeyBalances).toHaveBeenCalledWith('ba_personal_u1');
    const latestRedisSetOrder = Math.max(...redis.set.mock.invocationCallOrder);
    expect(publisher?.syncBillingAccountKeyBalances.mock.invocationCallOrder[0])
      .toBeGreaterThan(latestRedisSetOrder);
  });

  it('does not fan out key-balance when recharge keeps workspace funded', async () => {
    const { service, publisher, prisma } = await buildService({}, {}, {}, undefined, {});
    prisma.__setWalletBalance('u1', 30);

    await service.recharge('u1', 1000, '充值', 'order-funded');

    expect(publisher?.syncBillingAccountKeyBalances).not.toHaveBeenCalled();
    expect(publisher?.syncTenantKeyBalances).not.toHaveBeenCalled();
    expect(publisher?.syncUserKeyBalances).not.toHaveBeenCalled();
  });

  it('legacy DIRTY recharge without orderId preserves the legacy transaction shape', async () => {
    const { service, prisma } = await buildService();
    prisma.billingAccount.findUnique.mockResolvedValue({
      id: 'ba_personal_u1',
      type: 'personal',
      status: 'active',
      ownerUserId: 'u1',
      name: 'Personal account',
      deletedAt: null,
      balanceGrantLedgerStatus: 'LEGACY_DIRTY',
      balanceGrantLedgerVersion: 0,
      creditConfig: null,
    });

    await service.recharge('u1', 1000, '充值');

    const createArg = prisma.balanceTransaction.create.mock.calls[0][0].data;
    expect(createArg.orderId).toBeUndefined();
  });

  it('rejects every retry of a no-order recharge on CLEAN without demoting the account', async () => {
    const { service, prisma } = await buildService();

    await expect(service.recharge('u1', 1000, '未分类充值')).rejects.toThrow(
      'BALANCE_RECHARGE_REQUIRES_CLASSIFIED_FUNDING_LINK',
    );
    await expect(service.recharge('u1', 1000, '未分类充值')).rejects.toThrow(
      'BALANCE_RECHARGE_REQUIRES_CLASSIFIED_FUNDING_LINK',
    );

    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
    expect(prisma.billingAccount.updateMany).not.toHaveBeenCalled();
  });

  it('rolls back a proposed recharge proof failure without demoting the CLEAN account', async () => {
    const { service, prisma } = await buildService();
    jest.spyOn(
      service as unknown as {
        assertReconciledBalanceLedger: (
          db: unknown,
          billingAccountId: string,
          financialNow: Date,
          context: string,
          quarantineExistingLedger?: boolean,
        ) => Promise<void>;
      },
      'assertReconciledBalanceLedger',
    ).mockImplementation(async (
      _db,
      billingAccountId,
      _financialNow,
      context,
      quarantineExistingLedger = true,
    ) => {
      if (context === 'recharge postcondition') {
        throw new BalanceLedgerReconciliationRequiredError(
          billingAccountId,
          'recharge postcondition rejected proposed mutation',
          quarantineExistingLedger,
        );
      }
    });

    await expect(service.recharge(
      'u1',
      1000,
      '充值',
      'order-postcondition-proof-failure',
    )).rejects.toThrow(
      'BALANCE_LEDGER_RECONCILIATION_REQUIRED:ba_personal_u1:'
      + 'recharge postcondition rejected proposed mutation',
    );

    expect(prisma.billingAccount.updateMany).not.toHaveBeenCalled();
  });

  it('creates recharge grant after wallet increment (remaining depends on hole-fill)', async () => {
    const { service, prisma } = await buildService();

    await service.rechargeWithBonus('u1', 2000, 500, '充值', 'order-claim');

    expect(prisma.balanceGrant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderId: 'order-claim',
          paidAmountUsd: new Prisma.Decimal('20'),
          bonusAmountUsd: new Prisma.Decimal('5'),
          grantedAmountUsd: new Prisma.Decimal('25'),
          remainingAmountUsd: new Prisma.Decimal('25'),
        }),
      }),
    );
    // 企业信用还款核销后 grant remaining = 浮出水面的部分，因此 grant 必须在钱包
    // 递增之后创建；orderId 幂等由入口 findUnique + P2002 捕获保证，与创建顺序无关。
    expect(prisma.balanceGrant.create.mock.invocationCallOrder[0]).toBeGreaterThan(
      prisma.accountWallet.update.mock.invocationCallOrder[0],
    );
  });

  it('rejects first recharge issuance when the order is not owned by the funding subject', async () => {
    const { service, prisma } = await buildService();
    prisma.order.findFirst.mockResolvedValueOnce(null);

    await expect(service.rechargeWithBonus(
      'u1',
      2000,
      500,
      '充值',
      'foreign-order',
      'prod-1',
    )).rejects.toThrow('BALANCE_RECHARGE_ORDER_SUBJECT_MISMATCH');

    expect(prisma.order.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'foreign-order',
        userId: 'u1',
        tenantId: 'tenant-1',
        billingAccountId: 'ba_personal_u1',
        productId: 'prod-1',
      },
      select: { id: true },
    });
    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(prisma.balanceGrant.create).not.toHaveBeenCalled();
  });

  it('does not increment wallet again when recharge grant already exists', async () => {
    const existingTx = {
      id: 'tx-existing',
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      operationKey: null,
      type: 'RECHARGE',
      amountUsd: new Prisma.Decimal('20'),
      balanceAfterUsd: new Prisma.Decimal('50'),
      description: '充值',
      orderId: 'order-existing',
      productId: null,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    };
    const existingBonusTx = {
      ...existingTx,
      id: 'tx-existing-bonus',
      type: 'ADJUST',
      amountUsd: new Prisma.Decimal('5'),
      balanceAfterUsd: new Prisma.Decimal('55'),
      description: 'recharge-bonus',
    };
    const { service, prisma } = await buildService();
    prisma.balanceGrant.findUnique.mockResolvedValue({
      id: 'grant-existing',
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      orderId: 'order-existing',
      productId: null,
      source: 'RECHARGE',
      paidAmountUsd: new Prisma.Decimal('20'),
      bonusAmountUsd: new Prisma.Decimal('5'),
      grantedAmountUsd: new Prisma.Decimal('25'),
    });
    prisma.balanceTransaction.findFirst.mockResolvedValueOnce(existingTx);
    prisma.balanceTransaction.findMany.mockResolvedValueOnce([existingBonusTx]);

    const result = await service.rechargeWithBonus('u1', 2000, 500, '充值', 'order-existing');

    expect(result.id).toBe('tx-existing');
    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
    expect(prisma.balanceGrant.create).not.toHaveBeenCalled();
  });

  it('rejects an order replay that resolves to another tenant and billing account', async () => {
    const { service, prisma, redis } = await buildService();
    prisma.balanceGrant.findUnique.mockResolvedValue(rechargeReplayGrant({
      tenantId: 'tenant-other',
      billingAccountId: 'ba-other',
    }));
    prisma.balanceTransaction.findFirst.mockResolvedValue(rechargeReplayTransaction({
      tenantId: 'tenant-other',
      billingAccountId: 'ba-other',
    }));

    await expect(service.rechargeWithBonus(
      'u1',
      1000,
      0,
      '充值',
      'order-replay',
      'prod-1',
    )).rejects.toThrow('BALANCE_RECHARGE_IDEMPOTENCY_FINGERPRINT_MISMATCH');

    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'amount',
      requestAmountCents: 2000,
      requestProductId: 'prod-1',
    },
    {
      name: 'product',
      requestAmountCents: 1000,
      requestProductId: 'prod-2',
    },
  ])('rejects an order replay with a conflicting $name fingerprint', async ({
    requestAmountCents,
    requestProductId,
  }) => {
    const { service, prisma } = await buildService();
    prisma.balanceGrant.findUnique.mockResolvedValue(rechargeReplayGrant());
    prisma.balanceTransaction.findFirst.mockResolvedValue(rechargeReplayTransaction());

    await expect(service.rechargeWithBonus(
      'u1',
      requestAmountCents,
      0,
      '充值',
      'order-replay',
      requestProductId,
    )).rejects.toThrow('BALANCE_RECHARGE_IDEMPOTENCY_FINGERPRINT_MISMATCH');

    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(prisma.balanceGrant.create).not.toHaveBeenCalled();
  });

  it('replays a committed recharge and still fans out account balance when cache refresh fails', async () => {
    const { service, prisma, redis, publisher } = await buildService(
      {},
      {},
      {},
      undefined,
      {},
    );
    prisma.__setWalletBalance('u1', 10);
    prisma.balanceGrant.findUnique.mockResolvedValue(rechargeReplayGrant());
    prisma.balanceTransaction.findFirst.mockResolvedValue(rechargeReplayTransaction());
    redis.set.mockRejectedValueOnce(new Error('cache unavailable'));

    await expect(service.recharge(
      'u1',
      1000,
      '充值',
      'order-replay',
      'prod-1',
    )).resolves.toEqual(expect.objectContaining({ id: 'tx-recharge-replay' }));

    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
    expect(publisher?.syncBillingAccountKeyBalances).toHaveBeenCalledWith('ba_personal_u1');
  });

  it('replays the original recharge after a later bonus increased the mutable grant totals', async () => {
    const { service, prisma } = await buildService();
    prisma.balanceGrant.findUnique.mockResolvedValue(rechargeReplayGrant({
      bonusAmountUsd: new Prisma.Decimal(7),
      grantedAmountUsd: new Prisma.Decimal(17),
    }));
    prisma.balanceTransaction.findFirst.mockResolvedValueOnce(rechargeReplayTransaction());
    prisma.balanceTransaction.findMany.mockResolvedValueOnce([
      rechargeReplayTransaction({
        id: 'tx-initial-recharge-bonus',
        operationKey: 'balance:recharge:order-replay:bonus',
        type: 'ADJUST',
        amountUsd: new Prisma.Decimal(5),
        balanceAfterUsd: new Prisma.Decimal(15),
        description: 'recharge-bonus',
      }),
    ]);

    await expect(service.rechargeWithBonus(
      'u1',
      1000,
      500,
      '充值',
      'order-replay',
      'prod-1',
    )).resolves.toEqual(expect.objectContaining({ id: 'tx-recharge-replay' }));

    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
  });

  it('ignores a same-order legacy negative expiry ADJUST when replaying without bonus', async () => {
    const { service, prisma } = await buildService();
    prisma.balanceGrant.findUnique.mockResolvedValue(rechargeReplayGrant());
    prisma.balanceTransaction.findFirst.mockResolvedValueOnce(rechargeReplayTransaction());
    const legacyExpiry = rechargeReplayTransaction({
      id: 'tx-legacy-expiry-no-bonus',
      operationKey: null,
      type: 'ADJUST',
      amountUsd: new Prisma.Decimal(-10),
      balanceAfterUsd: new Prisma.Decimal(0),
      description: 'balance grant expired:grant-replay',
    });
    prisma.balanceTransaction.findMany.mockImplementationOnce(async ({
      where,
    }: RechargeBonusCandidateQuery) => {
      const legacyBranch = where.OR.find((candidate) => candidate.operationKey === null);
      expect(legacyBranch).toEqual({
        operationKey: null,
        amountUsd: { gt: new Prisma.Decimal(0) },
      });
      const positiveThreshold = legacyBranch?.amountUsd?.gt;
      if (!positiveThreshold) throw new Error('positive legacy bonus filter is missing');
      return [legacyExpiry].filter((transaction) =>
        transaction.amountUsd.gt(positiveThreshold),
      );
    });

    await expect(service.rechargeWithBonus(
      'u1', 1000, 0, '充值', 'order-replay', 'prod-1',
    )).resolves.toEqual(expect.objectContaining({ id: 'tx-recharge-replay' }));

    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
  });

  it('ignores a same-order legacy negative expiry ADJUST beside the original legacy bonus', async () => {
    const { service, prisma } = await buildService();
    prisma.balanceGrant.findUnique.mockResolvedValue(rechargeReplayGrant({
      bonusAmountUsd: new Prisma.Decimal(2),
      grantedAmountUsd: new Prisma.Decimal(12),
    }));
    prisma.balanceTransaction.findFirst.mockResolvedValueOnce(rechargeReplayTransaction());
    const legacyBonus = rechargeReplayTransaction({
      id: 'tx-legacy-initial-bonus',
      operationKey: null,
      type: 'ADJUST',
      amountUsd: new Prisma.Decimal(2),
      balanceAfterUsd: new Prisma.Decimal(12),
      description: 'recharge-bonus',
    });
    const legacyExpiry = rechargeReplayTransaction({
      id: 'tx-legacy-expiry-after-bonus',
      operationKey: null,
      type: 'ADJUST',
      amountUsd: new Prisma.Decimal(-12),
      balanceAfterUsd: new Prisma.Decimal(0),
      description: 'balance grant expired:grant-replay',
    });
    prisma.balanceTransaction.findMany.mockImplementationOnce(async ({
      where,
    }: RechargeBonusCandidateQuery) => {
      const legacyBranch = where.OR.find((candidate) => candidate.operationKey === null);
      expect(legacyBranch).toEqual({
        operationKey: null,
        amountUsd: { gt: new Prisma.Decimal(0) },
      });
      const positiveThreshold = legacyBranch?.amountUsd?.gt;
      if (!positiveThreshold) throw new Error('positive legacy bonus filter is missing');
      return [legacyBonus, legacyExpiry].filter((transaction) =>
        transaction.amountUsd.gt(positiveThreshold),
      );
    });

    await expect(service.rechargeWithBonus(
      'u1', 1000, 200, '充值', 'order-replay', 'prod-1',
    )).resolves.toEqual(expect.objectContaining({ id: 'tx-recharge-replay' }));

    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
  });

  it('rejects replay when multiple positive legacy bonus candidates exist without an exact operation key', async () => {
    const { service, prisma } = await buildService();
    prisma.balanceGrant.findUnique.mockResolvedValue(rechargeReplayGrant({
      bonusAmountUsd: new Prisma.Decimal(2),
      grantedAmountUsd: new Prisma.Decimal(12),
    }));
    prisma.balanceTransaction.findFirst.mockResolvedValueOnce(rechargeReplayTransaction());
    prisma.balanceTransaction.findMany.mockResolvedValueOnce([
      rechargeReplayTransaction({
        id: 'tx-legacy-initial-bonus-one',
        operationKey: null,
        type: 'ADJUST',
        amountUsd: new Prisma.Decimal(2),
        balanceAfterUsd: new Prisma.Decimal(12),
        description: 'recharge-bonus',
      }),
      rechargeReplayTransaction({
        id: 'tx-legacy-initial-bonus-two',
        operationKey: null,
        type: 'ADJUST',
        amountUsd: new Prisma.Decimal(3),
        balanceAfterUsd: new Prisma.Decimal(15),
        description: 'recharge-bonus',
      }),
    ]);

    await expect(service.rechargeWithBonus(
      'u1', 1000, 200, '充值', 'order-replay', 'prod-1',
    )).rejects.toThrow('BALANCE_RECHARGE_IDEMPOTENCY_FINGERPRINT_MISMATCH');

    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(prisma.balanceGrant.create).not.toHaveBeenCalled();
    expect(prisma.balanceGrant.update).not.toHaveBeenCalled();
    expect(prisma.balanceGrant.updateMany).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
  });

  it('rejects replaying a recharge that originally had bonus with bonus changed to zero', async () => {
    const { service, prisma } = await buildService();
    prisma.balanceGrant.findUnique.mockResolvedValue(rechargeReplayGrant({
      bonusAmountUsd: new Prisma.Decimal(2),
      grantedAmountUsd: new Prisma.Decimal(12),
    }));
    prisma.balanceTransaction.findFirst.mockResolvedValueOnce(rechargeReplayTransaction());
    prisma.balanceTransaction.findMany.mockResolvedValueOnce([
      rechargeReplayTransaction({
        id: 'tx-initial-bonus-two',
        operationKey: 'balance:recharge:order-replay:bonus',
        type: 'ADJUST',
        amountUsd: new Prisma.Decimal(2),
        balanceAfterUsd: new Prisma.Decimal(12),
        description: 'recharge-bonus',
      }),
    ]);

    await expect(service.rechargeWithBonus(
      'u1', 1000, 0, '充值', 'order-replay', 'prod-1',
    )).rejects.toThrow('BALANCE_RECHARGE_IDEMPOTENCY_FINGERPRINT_MISMATCH');
  });

  it('rejects replaying a zero-bonus recharge with a newly requested initial bonus', async () => {
    const { service, prisma } = await buildService();
    // Mutable totals may already include a later legitimate bonus; the missing
    // immutable initial-bonus operation is what makes this request conflict.
    prisma.balanceGrant.findUnique.mockResolvedValue(rechargeReplayGrant({
      bonusAmountUsd: new Prisma.Decimal(2),
      grantedAmountUsd: new Prisma.Decimal(12),
    }));
    prisma.balanceTransaction.findFirst.mockResolvedValueOnce(rechargeReplayTransaction());
    prisma.balanceTransaction.findMany.mockResolvedValueOnce([]);

    await expect(service.rechargeWithBonus(
      'u1', 1000, 200, '充值', 'order-replay', 'prod-1',
    )).rejects.toThrow('BALANCE_RECHARGE_IDEMPOTENCY_FINGERPRINT_MISMATCH');
  });

  it('replays an original zero-bonus recharge after a separately keyed later bonus', async () => {
    const { service, prisma } = await buildService();
    prisma.balanceGrant.findUnique.mockResolvedValue(rechargeReplayGrant({
      bonusAmountUsd: new Prisma.Decimal(2),
      grantedAmountUsd: new Prisma.Decimal(12),
    }));
    prisma.balanceTransaction.findFirst.mockResolvedValueOnce(rechargeReplayTransaction());
    // The production query intentionally excludes the later
    // balance:bonus:* operation, so there is no initial-bonus candidate.
    prisma.balanceTransaction.findMany.mockResolvedValueOnce([]);

    await expect(service.rechargeWithBonus(
      'u1', 1000, 0, '充值', 'order-replay', 'prod-1',
    )).resolves.toEqual(expect.objectContaining({ id: 'tx-recharge-replay' }));

    expect(prisma.balanceTransaction.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        OR: [
          { operationKey: 'balance:recharge:order-replay:bonus' },
          { operationKey: null, amountUsd: { gt: new Prisma.Decimal(0) } },
        ],
      }),
    }));
  });

  it('does not mistake a separately idempotent delayed bonus for the original recharge bonus', async () => {
    const { service, prisma } = await buildService();
    prisma.balanceGrant.findUnique.mockResolvedValue(rechargeReplayGrant({
      bonusAmountUsd: new Prisma.Decimal(5),
      grantedAmountUsd: new Prisma.Decimal(15),
    }));
    prisma.balanceTransaction.findFirst.mockResolvedValueOnce(rechargeReplayTransaction());
    prisma.balanceTransaction.findMany.mockResolvedValueOnce([
      rechargeReplayTransaction({
        id: 'tx-delayed-bonus',
        operationKey: 'balance:bonus:u1:bonus:order-replay',
        type: 'ADJUST',
        amountUsd: new Prisma.Decimal(5),
        balanceAfterUsd: new Prisma.Decimal(15),
        description: 'recharge-bonus',
      }),
    ]);

    await expect(service.rechargeWithBonus(
      'u1',
      1000,
      500,
      '充值',
      'order-replay',
      'prod-1',
    )).rejects.toThrow('BALANCE_RECHARGE_IDEMPOTENCY_FINGERPRINT_MISMATCH');

    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
  });

  it('does not fund the order account when the tenant binding drifts before the transaction', async () => {
    const { service, prisma } = await buildService();
    prisma.order.findUnique.mockResolvedValue({
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      productId: null,
      orderType: 'RECHARGE',
      status: 'FULFILLING',
    });
    let subjectReadCount = 0;
    prisma.tenant.findUnique.mockImplementation(({ select }: any) => {
      if (select?.ownerUserId) {
        subjectReadCount += 1;
        return Promise.resolve({
          id: 'tenant-1',
          name: 'Personal workspace',
          type: 'personal',
          status: 'active',
          ownerUserId: 'u1',
          billingAccountId: subjectReadCount === 1
            ? 'ba_personal_u1'
            : 'ba_personal_other',
          deletedAt: null,
        });
      }
      return Promise.resolve({
        id: 'tenant-1',
        billingAccountId: 'ba_personal_u1',
        balanceAllowanceUsd: null,
        balanceAllowanceUsedUsd: new Prisma.Decimal(0),
      });
    });

    await expect(service.rechargeWithBonus(
      'u1',
      2000,
      0,
      '充值',
      'order-drift',
      undefined,
      { tenantId: 'tenant-1', billingAccountId: 'ba_personal_u1' },
    )).rejects.toBeInstanceOf(RechargeBillingSubjectChangedError);

    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
    expect(prisma.balanceGrant.create).not.toHaveBeenCalled();
  });

  it('locks the recharge order before wallet writes and requires the anchored FULFILLING state', async () => {
    const { service, prisma } = await buildService();
    prisma.order.findUnique.mockResolvedValue({
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      productId: null,
      orderType: 'RECHARGE',
      status: 'FULFILLING',
    });

    await service.rechargeWithBonus(
      'u1',
      2000,
      0,
      '充值',
      'order-locked',
      undefined,
      { tenantId: 'tenant-1', billingAccountId: 'ba_personal_u1' },
    );

    expect(prisma.order.findUnique).toHaveBeenCalledWith({
      where: { id: 'order-locked' },
      select: {
        userId: true,
        tenantId: true,
        billingAccountId: true,
        productId: true,
        orderType: true,
        status: true,
      },
    });
    expect(prisma.order.findUnique.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.accountWallet.update.mock.invocationCallOrder[0],
    );
  });

  it('locks anchored recharge in wallet -> grants -> account -> tenant order', async () => {
    const { service, prisma } = await buildService();
    prisma.order.findUnique.mockResolvedValue({
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      productId: null,
      orderType: 'RECHARGE',
      status: 'FULFILLING',
    });

    await service.rechargeWithBonus(
      'u1',
      2000,
      0,
      '充值',
      'order-canonical-lock-order',
      undefined,
      { tenantId: 'tenant-1', billingAccountId: 'ba_personal_u1' },
    );

    const lockCalls = prisma.$queryRaw.mock.calls.map(
      ([query]: [TemplateStringsArray], index: number) => ({
        sql: String(query),
        invocationOrder: prisma.$queryRaw.mock.invocationCallOrder[index],
      }),
    );
    const lockOrder = (table: string, mode: 'FOR UPDATE' | 'FOR SHARE' = 'FOR UPDATE') => {
      const call = lockCalls.find(({ sql }: { sql: string }) => (
        sql.includes(`FROM "${table}"`) && sql.includes(mode)
      ));
      expect(call).toBeDefined();
      return call!.invocationOrder;
    };

    const walletLock = lockOrder('account_wallets');
    const grantLock = lockOrder('balance_grants');
    const accountLock = lockOrder('billing_accounts');
    const tenantLock = lockOrder('tenants');
    const tenantMemberLock = lockOrder('tenant_members', 'FOR SHARE');
    const accountMemberLock = lockOrder('billing_account_members', 'FOR SHARE');

    expect(walletLock).toBeLessThan(grantLock);
    expect(grantLock).toBeLessThan(accountLock);
    expect(accountLock).toBeLessThan(tenantLock);
    expect(tenantLock).toBeLessThan(tenantMemberLock);
    expect(tenantMemberLock).toBeLessThan(accountMemberLock);
    expect(accountMemberLock).toBeLessThan(
      prisma.accountWallet.update.mock.invocationCallOrder[0],
    );
  });

  it('revalidates an unanchored recharge after ledger locks and rejects a concurrent rebind', async () => {
    const { service, prisma } = await buildService();
    let tenantReads = 0;
    prisma.tenant.findUnique.mockImplementation(async () => {
      tenantReads += 1;
      return {
        id: 'tenant-1',
        name: 'Personal workspace',
        type: 'personal',
        status: 'active',
        ownerUserId: 'u1',
        billingAccountId: tenantReads >= 4 ? 'ba_personal_rebound' : 'ba_personal_u1',
        deletedAt: null,
        balanceAllowanceUsd: null,
        balanceAllowanceUsedUsd: new Prisma.Decimal(0),
      };
    });

    await expect(service.rechargeWithBonus(
      'u1',
      2000,
      0,
      'legacy recharge',
      undefined,
      undefined,
      { tenantId: 'tenant-1' },
    )).rejects.toThrow('无权访问该账务账号');

    expect(tenantReads).toBeGreaterThanOrEqual(4);
    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(prisma.balanceGrant.create).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
  });

  it('fails closed before financial writes when a bound account wallet is missing', async () => {
    const { service, prisma } = await buildService();
    prisma.__deleteWallet('ba_personal_u1');

    let caught: unknown;
    try {
      await service.rechargeWithBonus(
        'u1',
        2000,
        0,
        'wallet missing',
        undefined,
        undefined,
        { tenantId: 'tenant-1' },
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      status: 409,
      response: { code: 'billing_account_not_provisioned' },
    });
    expect(prisma.accountWallet.create).not.toHaveBeenCalled();
    expect(prisma.accountWallet.upsert).not.toHaveBeenCalled();
    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(prisma.balanceGrant.create).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
  });

  it('rejects a recharge after refund has claimed the order row', async () => {
    const { service, prisma } = await buildService();
    prisma.order.findUnique.mockResolvedValue({
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      productId: null,
      orderType: 'RECHARGE',
      status: 'REFUNDING',
    });

    await expect(service.rechargeWithBonus(
      'u1',
      2000,
      0,
      '充值',
      'order-refunding',
      undefined,
      { tenantId: 'tenant-1', billingAccountId: 'ba_personal_u1' },
    )).rejects.toBeInstanceOf(RechargeBillingSubjectChangedError);

    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
    expect(prisma.balanceGrant.create).not.toHaveBeenCalled();
  });

  it('does not classify a transient database failure as deterministic subject drift', async () => {
    const { service, prisma } = await buildService();
    prisma.tenant.findUnique.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(service.rechargeWithBonus(
      'u1',
      2000,
      0,
      '充值',
      'order-db-error',
      undefined,
      { tenantId: 'tenant-1', billingAccountId: 'ba_personal_u1' },
    )).rejects.toThrow('database unavailable');
  });
});

// ============================================================
// BillingService.refundBalance
// ============================================================
describe('BillingService.refundBalance', () => {
  function refundReplayTransaction(overrides: Record<string, any> = {}) {
    return {
      id: 'tx-refund-replay',
      operationKey: 'balance:refund:u1:order-refund-replay:refund-replay',
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      type: 'REFUND',
      amountUsd: new Prisma.Decimal(-10),
      balanceAfterUsd: new Prisma.Decimal(90),
      description: 'refund-replay',
      orderId: 'order-refund-replay',
      productId: 'prod-1',
      createdAt: new Date('2026-07-15T00:00:00.000Z'),
      ...overrides,
    };
  }

  function refundReplayGrant(overrides: Record<string, any> = {}) {
    return {
      id: 'grant-refund-replay',
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      orderId: 'order-refund-replay',
      productId: 'prod-1',
      source: 'RECHARGE',
      paidAmountUsd: new Prisma.Decimal(10),
      bonusAmountUsd: new Prisma.Decimal(0),
      grantedAmountUsd: new Prisma.Decimal(10),
      ...overrides,
    };
  }

  it('recovers the matching recharge BalanceGrant remaining amount when refunding wallet balance', async () => {
    const { service, prisma, redis } = await buildService();
    configureRechargeRefundAnchor(prisma, { productId: 'prod-payg' });
    prisma.__setWalletBalance('u1', 25);
    const grant = {
      id: 'grant-1',
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      orderId: 'order-1',
      productId: 'prod-payg',
      source: 'RECHARGE',
      paidAmountUsd: new Prisma.Decimal('25'),
      bonusAmountUsd: new Prisma.Decimal('0'),
      grantedAmountUsd: new Prisma.Decimal('25'),
      remainingAmountUsd: new Prisma.Decimal('25'),
      remainingPaidAmountUsd: new Prisma.Decimal('25'),
      remainingBonusAmountUsd: new Prisma.Decimal('0'),
      discountRate: new Prisma.Decimal('1'),
      validFrom: new Date('2025-01-01T00:00:00.000Z'),
      expiresAt: new Date('2027-01-01T00:00:00.000Z'),
      isExpired: false,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      updatedAt: new Date('2025-01-01T00:00:00.000Z'),
    };
    prisma.balanceGrant.findUnique.mockResolvedValueOnce(grant);
    prisma.balanceGrant.findUniqueOrThrow.mockResolvedValueOnce(grant);
    prisma.balanceGrant.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([grant]);
    mockRefundLedgerQueries(prisma, 0, { activeGrantUsd: 15, openDebtUsd: 0 });

    const result = await service.refundBalance(
      'u1',
      1000,
      'refund:recharge:order:order-1:principal',
      'order-1',
      'prod-payg',
      {
        tenantId: 'tenant-1',
        billingAccountId: 'ba_personal_u1',
        refundComponent: 'PAID',
      },
    );

    expect(prisma.balanceTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'REFUND',
          amountUsd: new Prisma.Decimal('-10'),
          balanceAfterUsd: new Prisma.Decimal('15'),
          orderId: 'order-1',
          productId: 'prod-payg',
        }),
      }),
    );
    expect(prisma.balanceGrant.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'grant-1',
        remainingAmountUsd: new Prisma.Decimal('25'),
        remainingPaidAmountUsd: new Prisma.Decimal('25'),
        remainingBonusAmountUsd: new Prisma.Decimal('0'),
        isExpired: false,
        validFrom: { lte: new Date('2026-07-16T00:00:00.000Z') },
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: new Date('2026-07-16T00:00:00.000Z') } },
        ],
      },
      data: {
        remainingAmountUsd: new Prisma.Decimal('15'),
        remainingPaidAmountUsd: new Prisma.Decimal('15'),
        remainingBonusAmountUsd: new Prisma.Decimal('0'),
      },
    });
    expect(prisma.balanceGrantRefund.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        component: 'PAID',
        requestedAmountUsd: new Prisma.Decimal(10),
        targetGrantReductionUsd: new Prisma.Decimal(10),
        debtOpenedUsd: new Prisma.Decimal(0),
        openDebtUsd: new Prisma.Decimal(0),
      }),
    });
    expect(redis.set).toHaveBeenCalledWith('balance:tenant:tenant-1', '15.000000000000');
    expect(result.type).toBe('REFUND');
  });

  it('refunds the original account after the tenant has been rebound', async () => {
    const { service, prisma, redis } = await buildService();
    configureRechargeRefundAnchor(prisma, { billingAccountId: 'ba-original' });
    prisma.__setWalletBalance('ba-original', 100);
    const grant = {
      id: 'grant-original',
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba-original',
      orderId: 'order-1',
      productId: null,
      source: 'RECHARGE',
      paidAmountUsd: new Prisma.Decimal(100),
      bonusAmountUsd: new Prisma.Decimal(0),
      grantedAmountUsd: new Prisma.Decimal(100),
      remainingAmountUsd: new Prisma.Decimal(100),
      remainingPaidAmountUsd: new Prisma.Decimal(100),
      remainingBonusAmountUsd: new Prisma.Decimal(0),
      discountRate: new Prisma.Decimal(1),
      validFrom: new Date('2025-01-01T00:00:00.000Z'),
      expiresAt: null,
      isExpired: false,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      updatedAt: new Date('2025-01-01T00:00:00.000Z'),
    };
    prisma.balanceGrant.findUnique.mockResolvedValueOnce(grant);
    prisma.balanceGrant.findUniqueOrThrow.mockResolvedValueOnce(grant);
    prisma.balanceGrant.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([grant]);
    mockRefundLedgerQueries(prisma, 0, { activeGrantUsd: 90, openDebtUsd: 0 });
    prisma.tenant.findUnique.mockResolvedValue({ billingAccountId: 'ba-current' });

    await service.refundBalance(
      'u1',
      1000,
      'refund:recharge:order:order-1:principal',
      'order-1',
      undefined,
      {
        tenantId: 'tenant-1',
        billingAccountId: 'ba-original',
        refundComponent: 'PAID',
      },
    );

    expect(prisma.accountWallet.update).toHaveBeenCalledWith({
      where: { billingAccountId: 'ba-original' },
      data: { balanceUsd: { increment: new Prisma.Decimal('-10') } },
    });
    expect(redis.set).toHaveBeenCalledWith(
      'balance:account:ba-original',
      '90.000000000000',
    );
    expect(redis.set).not.toHaveBeenCalledWith(
      'balance:tenant:tenant-1',
      expect.anything(),
    );
    expect(redis.del).not.toHaveBeenCalledWith('balance:tenant:tenant-1');
  });

  it.each([
    [{ userId: 'other-user' }, 'user'],
    [{ tenantId: 'tenant-other' }, 'tenant'],
    [{ billingAccountId: 'ba-other' }, 'account'],
    [{ amountUsd: new Prisma.Decimal('-11') }, 'amount'],
  ])('rejects an existing refund with a mismatched %s fingerprint', async (overrides, _label) => {
    const { service, prisma } = await buildService();
    const existingRefund = {
      id: 'tx-refund-mismatch',
      operationKey: 'balance:refund:u1:order-1:refund:recharge:order:order-1:principal',
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      type: 'REFUND',
      amountUsd: new Prisma.Decimal('-10'),
      balanceAfterUsd: new Prisma.Decimal('90'),
      description: 'refund:recharge:order:order-1:principal',
      orderId: 'order-1',
      productId: null,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      ...overrides,
    };
    configureRechargeRefundAnchor(prisma, { existingRefund });

    await expect(service.refundBalance(
      'u1',
      1000,
      'refund:recharge:order:order-1:principal',
      'order-1',
      undefined,
      {
        tenantId: 'tenant-1',
        billingAccountId: 'ba_personal_u1',
        refundComponent: 'PAID',
      },
    )).rejects.toThrow(/BALANCE_REFUND_IDEMPOTENCY_(AMOUNT|FINGERPRINT)_MISMATCH/);

    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
  });

  it('does not refund again but reconverges cache and key projection when the transaction exists', async () => {
    const { service, prisma, redis, publisher } = await buildService(
      {},
      {},
      {},
      undefined,
      {},
    );
    prisma.__setWalletBalance('u1', 90);
    const existingRefund = {
      id: 'tx-refund-existing',
      operationKey: 'balance:refund:u1:order-1:refund:recharge:order:order-1:principal',
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      type: 'REFUND',
      amountUsd: new Prisma.Decimal('-10'),
      balanceAfterUsd: new Prisma.Decimal('90'),
      description: 'refund:recharge:order:order-1:principal',
      orderId: 'order-1',
      productId: null,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    };
    configureRechargeRefundAnchor(prisma, { existingRefund });
    prisma.balanceGrant.findUnique.mockResolvedValueOnce({
      id: 'grant-order-1',
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      orderId: 'order-1',
      productId: null,
      source: 'RECHARGE',
      paidAmountUsd: new Prisma.Decimal('100'),
      bonusAmountUsd: new Prisma.Decimal(0),
    });

    const result = await service.refundBalance(
      'u1',
      1000,
      'refund:recharge:order:order-1:principal',
      'order-1',
      undefined,
      {
        tenantId: 'tenant-1',
        billingAccountId: 'ba_personal_u1',
        refundComponent: 'PAID',
      },
    );

    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(prisma.balanceGrant.findUnique).toHaveBeenCalledWith({ where: { orderId: 'order-1' } });
    expect(prisma.balanceGrant.updateMany).not.toHaveBeenCalled();
    expect(redis.set).toHaveBeenCalledWith('balance:tenant:tenant-1', '90.000000000000');
    expect(publisher?.syncBillingAccountKeyBalances).toHaveBeenCalledWith('ba_personal_u1');
    expect(result.id).toBe('tx-refund-existing');
  });

  it('rejects a committed refund replay when the product fingerprint changes', async () => {
    const { service, prisma, redis } = await buildService();
    configureRechargeRefundAnchor(prisma, {
      orderId: 'order-refund-replay',
      productId: 'prod-2',
      existingRefund: refundReplayTransaction(),
    });

    await expect(service.refundBalance(
      'u1',
      1000,
      'refund-replay',
      'order-refund-replay',
      'prod-2',
      {
        tenantId: 'tenant-1',
        billingAccountId: 'ba_personal_u1',
        refundComponent: 'PAID',
      },
    )).rejects.toThrow('BALANCE_REFUND_IDEMPOTENCY_FINGERPRINT_MISMATCH');

    expect(prisma.balanceGrantRefund.findUnique).not.toHaveBeenCalled();
    expect(prisma.balanceGrant.findUnique).not.toHaveBeenCalled();
    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('replays a committed refund and fans out account balance even when cache refresh fails', async () => {
    const { service, prisma, redis, publisher } = await buildService(
      {},
      {},
      {},
      undefined,
      {},
    );
    prisma.__setWalletBalance('u1', 90);
    configureRechargeRefundAnchor(prisma, {
      orderId: 'order-refund-replay',
      productId: 'prod-1',
      existingRefund: refundReplayTransaction(),
    });
    prisma.balanceGrant.findUnique.mockResolvedValue(refundReplayGrant());
    redis.set.mockRejectedValueOnce(new Error('cache unavailable'));

    await expect(service.refundBalance(
      'u1',
      1000,
      'refund-replay',
      'order-refund-replay',
      'prod-1',
      {
        tenantId: 'tenant-1',
        billingAccountId: 'ba_personal_u1',
        refundComponent: 'PAID',
      },
    )).resolves.toEqual(expect.objectContaining({ id: 'tx-refund-replay' }));

    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
    expect(publisher?.syncBillingAccountKeyBalances).toHaveBeenCalledWith('ba_personal_u1');
  });

  it('allows an audit-less legacy refund replay whose transaction operation key is null', async () => {
    const { service, prisma } = await buildService();
    configureRechargeRefundAnchor(prisma, {
      orderId: 'order-refund-replay',
      productId: 'prod-1',
      existingRefund: refundReplayTransaction({ operationKey: null }),
    });
    prisma.balanceGrant.findUnique.mockResolvedValue(refundReplayGrant());

    await expect(service.refundBalance(
      'u1',
      1000,
      'refund-replay',
      'order-refund-replay',
      'prod-1',
      {
        tenantId: 'tenant-1',
        billingAccountId: 'ba_personal_u1',
        refundComponent: 'PAID',
      },
    )).resolves.toEqual(expect.objectContaining({ id: 'tx-refund-replay' }));

    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
  });

  it('requires an exact transaction operation key when a refund audit exists', async () => {
    const { service, prisma } = await buildService();
    configureRechargeRefundAnchor(prisma, {
      orderId: 'order-refund-replay',
      productId: 'prod-1',
      existingRefund: refundReplayTransaction({ operationKey: null }),
    });
    prisma.balanceGrantRefund.findUnique.mockResolvedValue({
      balanceGrantId: 'grant-refund-replay',
      billingAccountId: 'ba_personal_u1',
      refundTransactionId: 'tx-refund-replay',
      operationKey: 'balance:refund:u1:order-refund-replay:refund-replay',
      component: 'PAID',
      requestedAmountUsd: new Prisma.Decimal(10),
    });

    await expect(service.refundBalance(
      'u1',
      1000,
      'refund-replay',
      'order-refund-replay',
      'prod-1',
      {
        tenantId: 'tenant-1',
        billingAccountId: 'ba_personal_u1',
        refundComponent: 'PAID',
      },
    )).rejects.toThrow('BALANCE_REFUND_IDEMPOTENCY_FINGERPRINT_MISMATCH');

    expect(prisma.balanceGrant.findUnique).not.toHaveBeenCalled();
    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
  });

  it('persists an expiry mismatch marker after the rejected refund transaction rolls back', async () => {
    const { service, prisma } = await buildService();
    configureRechargeRefundAnchor(prisma, { orderId: 'order-expiry-mismatch' });
    jest.spyOn(
      service as unknown as {
        expireAccountBalanceGrants: (...args: unknown[]) => Promise<unknown>;
      },
      'expireAccountBalanceGrants',
    ).mockRejectedValue(new BalanceLedgerReconciliationRequiredError(
      'ba_personal_u1',
      'wallet/grant mismatch 0.010000000000',
    ));

    await expect(service.refundBalance(
      'u1',
      100,
      'refund blocked by due grant mismatch',
      'order-expiry-mismatch',
      undefined,
      {
        tenantId: 'tenant-1',
        billingAccountId: 'ba_personal_u1',
        refundComponent: 'PAID',
      },
    )).rejects.toThrow(
      'BALANCE_LEDGER_RECONCILIATION_REQUIRED:ba_personal_u1:'
      + 'wallet/grant mismatch 0.010000000000',
    );

    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
    expect(prisma.billingAccount.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'ba_personal_u1',
        balanceGrantLedgerStatus: 'RECONCILED_V2',
      },
      data: expect.objectContaining({
        balanceGrantLedgerStatus: 'LEGACY_DIRTY',
        balanceGrantLedgerVersion: 0,
        balanceGrantLedgerDirtyReason:
          'financial mutation rejected:wallet/grant mismatch 0.010000000000',
      }),
    });
  });

  it('opens an auditable NEGATIVE_BALANCE debt when a refund exceeds unused paid balance', async () => {
    const { service, prisma } = await buildService();
    configureRechargeRefundAnchor(prisma, { orderId: 'order-2' });
    prisma.__setWalletBalance('u1', 5);
    const grant = {
      id: 'grant-remaining-small',
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      orderId: 'order-2',
      productId: null,
      source: 'RECHARGE',
      paidAmountUsd: new Prisma.Decimal('10'),
      bonusAmountUsd: new Prisma.Decimal('0'),
      grantedAmountUsd: new Prisma.Decimal('10'),
      remainingAmountUsd: new Prisma.Decimal('5'),
      remainingPaidAmountUsd: new Prisma.Decimal('5'),
      remainingBonusAmountUsd: new Prisma.Decimal('0'),
      discountRate: new Prisma.Decimal('1'),
      validFrom: new Date('2025-01-01T00:00:00.000Z'),
      expiresAt: new Date('2027-01-01T00:00:00.000Z'),
      isExpired: false,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      updatedAt: new Date('2025-01-01T00:00:00.000Z'),
    };
    prisma.balanceGrant.findUnique.mockResolvedValueOnce(grant);
    prisma.balanceGrant.findUniqueOrThrow.mockResolvedValueOnce(grant);
    prisma.balanceGrant.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([grant]);
    mockRefundLedgerQueries(prisma, 0, { activeGrantUsd: 0, openDebtUsd: 5 });

    await service.refundBalance(
      'u1',
      1000,
      'refund:recharge:order:order-2:principal',
      'order-2',
      undefined,
      {
        tenantId: 'tenant-1',
        billingAccountId: 'ba_personal_u1',
        refundComponent: 'PAID',
      },
    );

    expect(prisma.balanceGrant.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'grant-remaining-small',
        remainingAmountUsd: new Prisma.Decimal('5'),
        remainingPaidAmountUsd: new Prisma.Decimal('5'),
        remainingBonusAmountUsd: new Prisma.Decimal('0'),
        isExpired: false,
        validFrom: { lte: new Date('2026-07-16T00:00:00.000Z') },
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: new Date('2026-07-16T00:00:00.000Z') } },
        ],
      },
      data: {
        remainingAmountUsd: new Prisma.Decimal('0'),
        remainingPaidAmountUsd: new Prisma.Decimal('0'),
        remainingBonusAmountUsd: new Prisma.Decimal('0'),
      },
    });
    expect(prisma.balanceConsumptionAllocation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        source: 'NEGATIVE_BALANCE',
        amountUsd: new Prisma.Decimal(5),
        recognizedRevenueUsd: new Prisma.Decimal(0),
        bonusConsumedUsd: new Prisma.Decimal(0),
      }),
    });
    expect(prisma.balanceGrantRefund.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        component: 'PAID',
        requestedAmountUsd: new Prisma.Decimal(10),
        targetGrantReductionUsd: new Prisma.Decimal(5),
        debtOpenedUsd: new Prisma.Decimal(5),
        debtNettedUsd: new Prisma.Decimal(0),
        openDebtUsd: new Prisma.Decimal(5),
        recognizedRevenueReversalUsd: new Prisma.Decimal(5),
      }),
    });
    expect(prisma.billingAccount.updateMany).not.toHaveBeenCalled();
  });

  it('nets consumed refund debt against other grants and leaves only the wallet-backed open debt', async () => {
    const { service, prisma } = await buildService();
    configureRechargeRefundAnchor(prisma, { orderId: 'order-target' });
    prisma.__setWalletBalance('u1', 8);
    const base = {
      userId: 'u1', tenantId: 'tenant-1', billingAccountId: 'ba_personal_u1',
      productId: null, source: 'RECHARGE', bonusAmountUsd: new Prisma.Decimal(0),
      remainingBonusAmountUsd: new Prisma.Decimal(0), discountRate: new Prisma.Decimal(1),
      validFrom: new Date('2025-01-01T00:00:00.000Z'), expiresAt: null,
      isExpired: false, updatedAt: new Date('2025-01-01T00:00:00.000Z'),
    };
    const target = {
      ...base,
      id: 'grant-target', orderId: 'order-target',
      paidAmountUsd: new Prisma.Decimal(10), grantedAmountUsd: new Prisma.Decimal(10),
      remainingAmountUsd: new Prisma.Decimal(3), remainingPaidAmountUsd: new Prisma.Decimal(3),
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    };
    const other = {
      ...base,
      id: 'grant-other', orderId: 'order-other',
      paidAmountUsd: new Prisma.Decimal(5), grantedAmountUsd: new Prisma.Decimal(5),
      remainingAmountUsd: new Prisma.Decimal(5), remainingPaidAmountUsd: new Prisma.Decimal(5),
      createdAt: new Date('2025-01-02T00:00:00.000Z'),
    };
    prisma.balanceGrant.findUnique.mockResolvedValueOnce(target);
    prisma.balanceGrant.findUniqueOrThrow.mockResolvedValueOnce(target);
    prisma.balanceGrant.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([target, other]);
    mockRefundLedgerQueries(prisma, 0, { activeGrantUsd: 0, openDebtUsd: 2 });

    await service.refundBalance(
      'u1',
      1000,
      'refund:recharge:order:order-target:principal',
      'order-target',
      undefined,
      {
        tenantId: 'tenant-1',
        billingAccountId: 'ba_personal_u1',
        refundComponent: 'PAID',
        idempotencyKey: 'refund-task-principal',
      },
    );

    expect(prisma.balanceGrant.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({ id: 'grant-target' }),
      data: expect.objectContaining({ remainingAmountUsd: new Prisma.Decimal(0) }),
    }));
    expect(prisma.balanceGrant.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({ id: 'grant-other' }),
      data: expect.objectContaining({
        remainingAmountUsd: new Prisma.Decimal(0),
        remainingPaidAmountUsd: new Prisma.Decimal(0),
      }),
    }));
    expect(prisma.enterpriseCreditSettlement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        debtSource: 'NEGATIVE_BALANCE',
        trigger: 'REFUND_NETTING',
        balanceGrantId: 'grant-other',
        amountUsd: new Prisma.Decimal(5),
        paidUsd: new Prisma.Decimal(5),
      }),
    });
    expect(prisma.balanceGrantRefund.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        operationKey: 'balance:refund:u1:refund-task-principal',
        requestedAmountUsd: new Prisma.Decimal(10),
        targetGrantReductionUsd: new Prisma.Decimal(3),
        debtOpenedUsd: new Prisma.Decimal(7),
        debtNettedUsd: new Prisma.Decimal(5),
        openDebtUsd: new Prisma.Decimal(2),
        recognizedRevenueReversalUsd: new Prisma.Decimal(7),
      }),
    });
    expect(prisma.balanceGrantRefundAllocation.create).toHaveBeenCalledTimes(2);
  });

  it('uses the target mixed grant bonus to net debt created by a full principal refund', async () => {
    const { service, prisma } = await buildService();
    configureRechargeRefundAnchor(prisma, { orderId: 'order-mixed-target' });
    prisma.__setWalletBalance('u1', 6);
    const target = {
      id: 'grant-mixed-target',
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      orderId: 'order-mixed-target',
      productId: null,
      source: 'RECHARGE',
      paidAmountUsd: new Prisma.Decimal(10),
      bonusAmountUsd: new Prisma.Decimal(2),
      grantedAmountUsd: new Prisma.Decimal(12),
      remainingAmountUsd: new Prisma.Decimal(6),
      remainingPaidAmountUsd: new Prisma.Decimal(4),
      remainingBonusAmountUsd: new Prisma.Decimal(2),
      discountRate: new Prisma.Decimal('0.833333333333'),
      validFrom: new Date('2025-01-01T00:00:00.000Z'),
      expiresAt: null,
      isExpired: false,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      updatedAt: new Date('2025-01-01T00:00:00.000Z'),
    };
    prisma.balanceGrant.findUnique.mockResolvedValueOnce(target);
    prisma.balanceGrant.findUniqueOrThrow.mockResolvedValueOnce(target);
    prisma.balanceGrant.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([target]);
    mockRefundLedgerQueries(prisma, 0, { activeGrantUsd: 0, openDebtUsd: 4 });

    await service.refundBalance(
      'u1',
      1000,
      'refund:recharge:order:order-mixed-target:principal',
      'order-mixed-target',
      undefined,
      {
        tenantId: 'tenant-1',
        billingAccountId: 'ba_personal_u1',
        refundComponent: 'PAID',
      },
    );

    expect(prisma.balanceGrant.updateMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: expect.objectContaining({
        id: target.id,
        remainingPaidAmountUsd: new Prisma.Decimal(4),
        remainingBonusAmountUsd: new Prisma.Decimal(2),
      }),
      data: {
        remainingAmountUsd: new Prisma.Decimal(2),
        remainingPaidAmountUsd: new Prisma.Decimal(0),
        remainingBonusAmountUsd: new Prisma.Decimal(2),
      },
    }));
    expect(prisma.balanceGrant.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({
        id: target.id,
        remainingAmountUsd: new Prisma.Decimal(2),
      }),
      data: {
        remainingAmountUsd: new Prisma.Decimal(0),
        remainingPaidAmountUsd: new Prisma.Decimal(0),
        remainingBonusAmountUsd: new Prisma.Decimal(0),
      },
    }));
    expect(prisma.enterpriseCreditSettlement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        balanceGrantId: target.id,
        debtSource: 'NEGATIVE_BALANCE',
        trigger: 'REFUND_NETTING',
        amountUsd: new Prisma.Decimal(2),
        paidUsd: new Prisma.Decimal(0),
        bonusUsd: new Prisma.Decimal(2),
      }),
    });
    expect(prisma.balanceGrantRefund.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        requestedAmountUsd: new Prisma.Decimal(10),
        targetGrantReductionUsd: new Prisma.Decimal(4),
        debtOpenedUsd: new Prisma.Decimal(6),
        debtNettedUsd: new Prisma.Decimal(2),
        openDebtUsd: new Prisma.Decimal(4),
        recognizedRevenueReversalUsd: new Prisma.Decimal(6),
      }),
    });
    expect(prisma.balanceGrantRefundAllocation.create).toHaveBeenCalledTimes(2);
  });
});

describe('BillingService exact grant component splitting', () => {
  it('clamps twice-rounded proportional debits to both component remainders', async () => {
    const { service } = await buildService();
    const split = (
      service as unknown as {
        splitGrantDebitComponents: (
          amountUsd: Prisma.Decimal,
          paidRemainingUsd: Prisma.Decimal,
          bonusRemainingUsd: Prisma.Decimal,
        ) => { paidUsd: Prisma.Decimal; bonusUsd: Prisma.Decimal };
      }
    ).splitGrantDebitComponents.bind(service);
    const amountUsd = new Prisma.Decimal('5.999999999999');

    const paidUpperBound = split(
      amountUsd,
      new Prisma.Decimal(1),
      new Prisma.Decimal(5),
    );
    expect(paidUpperBound.paidUsd.toFixed(12)).toBe('1.000000000000');
    expect(paidUpperBound.bonusUsd.toFixed(12)).toBe('4.999999999999');
    expect(paidUpperBound.paidUsd.plus(paidUpperBound.bonusUsd).eq(amountUsd)).toBe(true);

    const bonusUpperBound = split(
      amountUsd,
      new Prisma.Decimal(5),
      new Prisma.Decimal(1),
    );
    expect(bonusUpperBound.paidUsd.toFixed(12)).toBe('4.999999999999');
    expect(bonusUpperBound.bonusUsd.toFixed(12)).toBe('1.000000000000');
    expect(bonusUpperBound.paidUsd.plus(bonusUpperBound.bonusUsd).eq(amountUsd)).toBe(true);
  });
});

describe('BillingService Gateway grant-specific funding holds', () => {
  it('keeps B historical grant backing while A consumes later supplemental funding', async () => {
    const { service, prisma } = await buildService();
    const receiptAt = new Date('2026-07-01T00:00:00.000Z');
    const laterFundingAt = new Date('2026-07-02T00:00:00.000Z');
    const settlementAt = new Date('2026-07-03T00:00:00.000Z');
    const grants = new Map<string, any>([
      ['grant-g0', {
        id: 'grant-g0',
        userId: 'u1',
        tenantId: 'tenant-1',
        billingAccountId: 'ba_personal_u1',
        orderId: 'order-g0',
        productId: null,
        source: 'RECHARGE',
        paidAmountUsd: new Prisma.Decimal(10),
        bonusAmountUsd: new Prisma.Decimal(0),
        grantedAmountUsd: new Prisma.Decimal(10),
        remainingAmountUsd: new Prisma.Decimal(10),
        remainingPaidAmountUsd: new Prisma.Decimal(10),
        remainingBonusAmountUsd: new Prisma.Decimal(0),
        discountRate: new Prisma.Decimal(1),
        validFrom: receiptAt,
        expiresAt: null,
        isExpired: false,
        createdAt: receiptAt,
        updatedAt: receiptAt,
      }],
      ['grant-g1', {
        id: 'grant-g1',
        userId: 'u1',
        tenantId: 'tenant-1',
        billingAccountId: 'ba_personal_u1',
        orderId: 'order-g1',
        productId: null,
        source: 'RECHARGE',
        paidAmountUsd: new Prisma.Decimal(10),
        bonusAmountUsd: new Prisma.Decimal(0),
        grantedAmountUsd: new Prisma.Decimal(10),
        remainingAmountUsd: new Prisma.Decimal(10),
        remainingPaidAmountUsd: new Prisma.Decimal(10),
        remainingBonusAmountUsd: new Prisma.Decimal(0),
        discountRate: new Prisma.Decimal(1),
        validFrom: laterFundingAt,
        expiresAt: null,
        isExpired: false,
        createdAt: laterFundingAt,
        updatedAt: laterFundingAt,
      }],
    ]);
    prisma.balanceGrant.findUnique.mockImplementation(async ({ where }: any) => {
      const grant = grants.get(where.id);
      return grant ? { ...grant } : null;
    });
    prisma.balanceGrant.findMany.mockImplementation(async ({ where }: any) => {
      if (where.expiresAt !== null) return [];
      return [...grants.values()]
        .filter((grant) => (
          !grant.isExpired
          && grant.validFrom.getTime() <= settlementAt.getTime()
          && grant.remainingAmountUsd.gt(0)
        ))
        .map((grant) => ({ ...grant }));
    });
    prisma.balanceGrant.updateMany.mockImplementation(async ({ where, data }: any) => {
      const grant = grants.get(where.id);
      if (!grant || !grant.remainingAmountUsd.eq(where.remainingAmountUsd)) {
        return { count: 0 };
      }
      Object.assign(grant, data);
      return { count: 1 };
    });
    prisma.gatewayUsageFundingReservationGrant.findMany.mockResolvedValue([{
      balanceGrantId: 'grant-g0',
      amountUsd: new Prisma.Decimal(5),
    }]);

    const allocate = (
      service as unknown as {
        allocateBalanceConsumption: (
          db: typeof prisma,
          params: Record<string, unknown>,
        ) => Promise<void>;
      }
    ).allocateBalanceConsumption.bind(service);
    await allocate(prisma, {
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      balanceTransactionId: 'tx-a',
      amountUsd: new Prisma.Decimal(15),
      financialNow: receiptAt,
      gatewayFundingReservationId: 'reservation-a',
      gatewayReservedGrantSlices: [{
        balanceGrantId: 'grant-g0',
        amountUsd: new Prisma.Decimal(5),
        allocationOrder: 0,
      }],
      gatewayReservedCollectedAmountUsd: new Prisma.Decimal(5),
      gatewaySupplementalCollectedAmountUsd: new Prisma.Decimal(10),
      gatewaySupplementalFundingAt: settlementAt,
      enterpriseApprovedCreditAmountUsd: new Prisma.Decimal(0),
      enterpriseUnapprovedDebtAmountUsd: new Prisma.Decimal(0),
      negativeBalanceAmountUsd: new Prisma.Decimal(0),
    });

    expect(grants.get('grant-g0').remainingAmountUsd.toFixed(12))
      .toBe('5.000000000000');
    expect(grants.get('grant-g1').remainingAmountUsd.toFixed(12))
      .toBe('0.000000000000');
    expect(prisma.balanceConsumptionAllocation.create.mock.calls
      .map((call: any[]) => ({
        tx: call[0].data.balanceTransactionId,
        grant: call[0].data.balanceGrantId,
        amount: call[0].data.amountUsd.toFixed(12),
      }))).toEqual([
      { tx: 'tx-a', grant: 'grant-g0', amount: '5.000000000000' },
      { tx: 'tx-a', grant: 'grant-g1', amount: '10.000000000000' },
    ]);

    prisma.gatewayUsageFundingReservationGrant.findMany.mockResolvedValue([]);
    await allocate(prisma, {
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      balanceTransactionId: 'tx-b',
      amountUsd: new Prisma.Decimal(5),
      financialNow: receiptAt,
      gatewayFundingReservationId: 'reservation-b',
      gatewayReservedGrantSlices: [{
        balanceGrantId: 'grant-g0',
        amountUsd: new Prisma.Decimal(5),
        allocationOrder: 0,
      }],
      gatewayReservedCollectedAmountUsd: new Prisma.Decimal(5),
      gatewaySupplementalCollectedAmountUsd: new Prisma.Decimal(0),
      gatewaySupplementalFundingAt: settlementAt,
      enterpriseApprovedCreditAmountUsd: new Prisma.Decimal(0),
      enterpriseUnapprovedDebtAmountUsd: new Prisma.Decimal(0),
      negativeBalanceAmountUsd: new Prisma.Decimal(0),
    });
    expect(grants.get('grant-g0').remainingAmountUsd.toFixed(12))
      .toBe('0.000000000000');
    expect(prisma.balanceConsumptionAllocation.create).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        balanceTransactionId: 'tx-b',
        balanceGrantId: 'grant-g0',
        amountUsd: new Prisma.Decimal(5),
      }),
    });
  });

  it('allocates ordinary cash from an unheld grant before touching a held grant', async () => {
    const { service, prisma } = await buildService();
    const now = new Date('2026-07-03T00:00:00.000Z');
    const makeGrant = (id: string) => ({
      id,
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      orderId: `order-${id}`,
      productId: null,
      source: 'RECHARGE',
      paidAmountUsd: new Prisma.Decimal(10),
      bonusAmountUsd: new Prisma.Decimal(0),
      grantedAmountUsd: new Prisma.Decimal(10),
      remainingAmountUsd: new Prisma.Decimal(10),
      remainingPaidAmountUsd: new Prisma.Decimal(10),
      remainingBonusAmountUsd: new Prisma.Decimal(0),
      discountRate: new Prisma.Decimal(1),
      validFrom: new Date('2026-07-01T00:00:00.000Z'),
      expiresAt: null,
      isExpired: false,
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    });
    const grants = new Map<string, any>([
      ['grant-held', makeGrant('grant-held')],
      ['grant-free', makeGrant('grant-free')],
    ]);
    prisma.gatewayUsageFundingReservationGrant.findMany.mockResolvedValue([{
      balanceGrantId: 'grant-held',
      amountUsd: new Prisma.Decimal(10),
    }]);
    prisma.balanceGrant.findMany.mockImplementation(async ({ where }: any) => (
      where.expiresAt === null ? [...grants.values()].map((grant) => ({ ...grant })) : []
    ));
    prisma.balanceGrant.updateMany.mockImplementation(async ({ where, data }: any) => {
      const grant = grants.get(where.id);
      if (!grant || !grant.remainingAmountUsd.eq(where.remainingAmountUsd)) return { count: 0 };
      Object.assign(grant, data);
      return { count: 1 };
    });
    const allocate = (service as any).allocateBalanceConsumption.bind(service);

    await allocate(prisma, {
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      balanceTransactionId: 'tx-ordinary',
      amountUsd: new Prisma.Decimal(5),
      financialNow: now,
    });

    expect(grants.get('grant-held').remainingAmountUsd.toFixed(12))
      .toBe('10.000000000000');
    expect(grants.get('grant-free').remainingAmountUsd.toFixed(12))
      .toBe('5.000000000000');
    expect(prisma.balanceConsumptionAllocation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ balanceGrantId: 'grant-free' }),
    });
  });
});

// ============================================================
// BillingService.applyClassifiedBalanceAdjustment
// ============================================================
describe('BillingService.applyClassifiedBalanceAdjustment', () => {
  const subject = {
    tenantId: 'tenant-1',
    billingAccountId: 'ba_enterprise_1',
    billingAccountType: 'enterprise',
  };

  it('implements a positive adjustment through a bonus-only voucher grant', async () => {
    const { service, prisma } = await buildService();
    jest.spyOn(service as any, 'requireTenantSubject').mockResolvedValue(subject);
    const transaction = {
      id: 'tx-credit-1',
      userId: 'u1',
      tenantId: 'tenant-1',
      productId: null,
      type: TransactionType.ADJUST,
      amountCents: 1250,
      balanceAfterCents: 3250,
      amountUsd: 12.5,
      balanceAfterUsd: 32.5,
      description: 'voucher:grant-1 billing-adjustment:DISCOUNT_CORRECTION August correction',
      createdAt: '2026-08-05T00:00:00.000Z',
    };
    const issueVoucher = jest.spyOn(service, 'issueVoucher').mockResolvedValue({
      transaction,
      grant: {} as never,
    });

    const result = await service.applyClassifiedBalanceAdjustment('u1', {
      amountCents: 1250,
      reasonCode: 'DISCOUNT_CORRECTION',
      description: ' August correction ',
      performedBy: 'admin-1',
      idempotencyKey: 'adjustment-key-1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_enterprise_1',
      productId: 'product-must-be-ignored',
    });

    expect(prisma.product.findFirst).not.toHaveBeenCalled();
    expect(issueVoucher).toHaveBeenCalledWith(
      'u1',
      1250,
      'billing-adjustment:DISCOUNT_CORRECTION August correction',
      {
        tenantId: 'tenant-1',
        billingAccountId: 'ba_enterprise_1',
        productId: null,
        performedBy: 'admin-1',
        idempotencyKey: 'adjustment-key-1',
        attribution: {
          billingMode: ProductBillingMode.PAY_AS_YOU_GO,
          source: BalanceTransactionAttributionSource.ADMIN_BALANCE_ADJUSTMENT,
        },
      },
    );
    expect(result).toEqual({
      direction: 'CREDIT',
      reasonCode: 'DISCOUNT_CORRECTION',
      amountCents: 1250,
      balanceAfterCents: 3250,
      transaction,
    });
  });

  it('implements a negative adjustment through the reconciled consume path', async () => {
    const { service, prisma } = await buildService();
    jest.spyOn(service as any, 'requireTenantSubject').mockResolvedValue(subject);
    prisma.idempotencyKey.findUnique.mockResolvedValue(null);
    jest.spyOn(service as any, 'writePendingAdminFundingIdempotency').mockResolvedValue(undefined);
    jest.spyOn(service as any, 'commitAdminFundingIdempotency').mockResolvedValue(undefined);
    const db = {
      balanceTransaction: {
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'tx-debit-1',
          userId: 'u1',
          tenantId: 'tenant-1',
          productId: null,
          type: 'CONSUME',
          amountUsd: new Prisma.Decimal(-5),
          balanceAfterUsd: new Prisma.Decimal(15),
          description: 'billing-adjustment:BILLING_CORRECTION admin:admin-1 duplicate usage',
          tokenUsageId: null,
          createdAt: new Date('2026-08-05T00:00:00.000Z'),
        }),
      },
      balanceTransactionAttribution: {
        create: jest.fn().mockResolvedValue({}),
      },
    };
    const deduct = jest.spyOn(service, 'deduct').mockImplementation(async (_userId, amount, description, options) => {
      if (!options) throw new Error('expected classified adjustment options');
      expect((amount as Prisma.Decimal).toFixed()).toBe('5');
      expect(description).toBe(
        'billing-adjustment:BILLING_CORRECTION admin:admin-1 duplicate usage',
      );
      expect(options.operationKey).toBe(
        'balance:admin-billing-adjustment:debit:adjustment-key-2',
      );
      expect(options.productId).toBeNull();
      await options.beforeBalanceTransaction?.(db as never, {
        debtOpen: false,
        debtExposureUsd: new Prisma.Decimal(0),
        collectedUsd: new Prisma.Decimal(5),
        approvedCreditUsd: new Prisma.Decimal(0),
        unapprovedDebtUsd: new Prisma.Decimal(0),
      });
      await options.afterBalanceTransaction?.(
        db as never,
        { workspaceBalanceUsd: new Prisma.Decimal(15) } as never,
        {
          balanceTransactionId: 'tx-debit-1',
          billingAccountId: 'ba_enterprise_1',
          tenantId: 'tenant-1',
          debtOpen: false,
          debtExposureUsd: new Prisma.Decimal(0),
          collectedUsd: new Prisma.Decimal(5),
          approvedCreditUsd: new Prisma.Decimal(0),
          unapprovedDebtUsd: new Prisma.Decimal(0),
          fundingPolicy: {
            policyAt: new Date('2026-08-05T00:00:00.000Z'),
            policyRevision: null,
            source: 'NOT_APPLICABLE',
            reconstructible: true,
            limitUsd: new Prisma.Decimal(0),
            status: null,
            termsDays: null,
            effectiveAt: null,
            expiresAt: null,
          },
        },
      );
      return { success: true, balance: 1500, balanceUsd: 15 };
    });

    const result = await service.applyClassifiedBalanceAdjustment('u1', {
      amountCents: -500,
      reasonCode: 'BILLING_CORRECTION',
      description: 'duplicate usage',
      performedBy: 'admin-1',
      idempotencyKey: 'adjustment-key-2',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_enterprise_1',
      productId: 'product-must-be-ignored',
    });

    expect(prisma.product.findFirst).not.toHaveBeenCalled();
    expect(db.balanceTransactionAttribution.create).toHaveBeenCalledWith({
      data: {
        transactionId: 'tx-debit-1',
        balanceGrantId: null,
        billingMode: ProductBillingMode.PAY_AS_YOU_GO,
        source: BalanceTransactionAttributionSource.ADMIN_BALANCE_ADJUSTMENT,
      },
    });
    expect(deduct).toHaveBeenCalledTimes(1);
    expect(result).toMatchObject({
      direction: 'DEBIT',
      reasonCode: 'BILLING_CORRECTION',
      amountCents: -500,
      balanceAfterCents: 1500,
      transaction: { id: 'tx-debit-1', type: 'CONSUME', amountCents: 500 },
    });
  });

  it('keeps personal classified adjustment product semantics unchanged', async () => {
    const { service, prisma } = await buildService();
    jest.spyOn(service as any, 'requireTenantSubject').mockResolvedValue({
      ...subject,
      billingAccountId: 'ba_personal_u1',
      billingAccountType: 'personal',
    });
    const transaction = {
      id: 'tx-personal-credit',
      userId: 'u1',
      tenantId: 'tenant-1',
      productId: null,
      type: TransactionType.ADJUST,
      amountCents: 100,
      balanceAfterCents: 100,
      amountUsd: 1,
      balanceAfterUsd: 1,
      description: 'voucher:grant-personal billing-adjustment:OTHER personal correction',
      createdAt: '2026-08-05T00:00:00.000Z',
    };
    const issueVoucher = jest.spyOn(service, 'issueVoucher').mockResolvedValue({
      transaction,
      grant: {} as never,
    });

    await expect(service.applyClassifiedBalanceAdjustment('u1', {
      amountCents: 100,
      reasonCode: 'OTHER',
      description: 'personal correction',
      idempotencyKey: 'personal-adjustment-key',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      productId: 'prod-personal',
    })).resolves.toEqual(expect.objectContaining({ direction: 'CREDIT' }));

    expect(prisma.product.findFirst).not.toHaveBeenCalled();
    expect(issueVoucher).toHaveBeenCalledWith(
      'u1',
      100,
      'billing-adjustment:OTHER personal correction',
      {
        tenantId: 'tenant-1',
        billingAccountId: 'ba_personal_u1',
        productId: 'prod-personal',
        performedBy: null,
        idempotencyKey: 'personal-adjustment-key',
        attribution: undefined,
      },
    );
  });

  it('rejects zero and unclassified adjustments before touching a wallet', async () => {
    const { service } = await buildService();
    const resolveSubject = jest.spyOn(service as any, 'requireTenantSubject');

    await expect(service.applyClassifiedBalanceAdjustment('u1', {
      amountCents: 0,
      reasonCode: 'OTHER',
      description: 'invalid',
      idempotencyKey: 'adjustment-key-3',
    })).rejects.toThrow('非零整数分值');
    await expect(service.applyClassifiedBalanceAdjustment('u1', {
      amountCents: 100,
      reasonCode: 'INVALID' as never,
      description: 'invalid',
      idempotencyKey: 'adjustment-key-4',
    })).rejects.toThrow('调额原因类型无效');
    await expect(service.applyClassifiedBalanceAdjustment('u1', {
      amountCents: 2_500_001,
      reasonCode: 'OTHER',
      description: 'too large',
      idempotencyKey: 'adjustment-key-5',
    })).rejects.toThrow('25,000.00');
    expect(resolveSubject).not.toHaveBeenCalled();
  });
});

// BillingService.issueVoucher
// ============================================================
describe('BillingService.issueVoucher', () => {
  function committedVoucherIdempotencyRow(reason = '客服补偿') {
    const response = {
      transaction: {
        id: 'tx-voucher-v2-replay',
        userId: 'u1',
        tenantId: 'tenant-1',
        productId: null,
        type: 'ADJUST',
        amountCents: 1500,
        balanceAfterCents: 3500,
        amountUsd: 15,
        balanceAfterUsd: 35,
        description: 'voucher:grant-voucher-v2-replay 客服补偿',
        createdAt: '2026-07-15T00:00:00.000Z',
      },
      grant: {
        id: 'grant-voucher-v2-replay',
        source: 'VOUCHER',
        amountCents: 1500,
        remainingCents: 1500,
        paidAmountCents: 0,
        bonusAmountCents: 1500,
        discountRate: 0,
        productId: null,
        expiresAt: null,
      },
    };
    return {
      response,
      row: {
        key: 'voucher-key-v2',
        scope: 'admin:issue-voucher',
        userId: 'u1',
        status: 'COMMITTED',
        result: {
          version: 2,
          status: 'COMMITTED',
          request: {
            scope: 'admin:issue-voucher',
            userId: 'u1',
            tenantId: 'tenant-1',
            billingAccountId: 'ba_personal_u1',
            amountUsd: '15.000000000000',
            productId: null,
            description: reason,
            reason,
            expiresAt: null,
            performedBy: null,
          },
          response,
        },
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      },
    };
  }

  it('creates a bonus-only balance grant and adjustment transaction', async () => {
    const { service, redis, prisma } = await buildService();
    const expiresAt = new Date('2030-01-01T00:00:00.000Z');
    prisma.__setWalletBalance('u1', 20);

    const result = await service.issueVoucher('u1', 1500, '客服补偿', {
      tenantId: 'tenant-1',
      productId: 'prod-payg',
      expiresAt,
      performedBy: 'admin-1',
    });

    expect(prisma.balanceGrant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'u1',
          tenantId: 'tenant-1',
          billingAccountId: 'ba_personal_u1',
          productId: 'prod-payg',
          source: 'VOUCHER',
          paidAmountUsd: new Prisma.Decimal(0),
          bonusAmountUsd: new Prisma.Decimal(15),
          grantedAmountUsd: new Prisma.Decimal(15),
          remainingAmountUsd: new Prisma.Decimal(15),
          discountRate: new Prisma.Decimal(0),
          expiresAt,
        }),
      }),
    );
    expect(prisma.balanceTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'u1',
          tenantId: 'tenant-1',
          billingAccountId: 'ba_personal_u1',
          productId: 'prod-payg',
          type: 'ADJUST',
          amountUsd: new Prisma.Decimal(15),
          balanceAfterUsd: new Prisma.Decimal(35),
          description: expect.stringContaining('admin:admin-1 客服补偿'),
        }),
      }),
    );
    expect(redis.set).toHaveBeenCalledWith('balance:tenant:tenant-1', '35.000000000000');
    expect(result.grant).toEqual(expect.objectContaining({
      amountCents: 1500,
      remainingCents: 1500,
      paidAmountCents: 0,
      bonusAmountCents: 1500,
      discountRate: 0,
      productId: 'prod-payg',
      expiresAt: expiresAt.toISOString(),
    }));
    expect(result.transaction.amountCents).toBe(1500);
    expect(result.transaction.balanceAfterCents).toBe(3500);
  });

  it('writes enterprise adjustment attribution in the voucher transaction', async () => {
    const { service, prisma } = await buildService();
    jest.spyOn(service as any, 'requireTenantSubject').mockResolvedValue({
      tenantId: 'tenant-1',
      billingAccountId: 'ba_enterprise_1',
      billingAccountType: 'enterprise',
    });
    jest.spyOn(service as any, 'lockProvisionedBillingSubjectMetadata')
      .mockResolvedValue(undefined);
    prisma.__setWalletBalance('ba_enterprise_1', 20);

    const result = await service.issueVoucher('u1', 1500, 'classified adjustment', {
      tenantId: 'tenant-1',
      billingAccountId: 'ba_enterprise_1',
      idempotencyKey: 'enterprise-adjustment-key',
      attribution: {
        billingMode: ProductBillingMode.PAY_AS_YOU_GO,
        source: BalanceTransactionAttributionSource.ADMIN_BALANCE_ADJUSTMENT,
      },
    });

    expect(prisma.balanceGrant.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.not.objectContaining({ productId: expect.anything() }),
    }));
    expect(prisma.balanceTransaction.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.not.objectContaining({ productId: expect.anything() }),
    }));
    expect(prisma.balanceTransactionAttribution.create).toHaveBeenCalledWith({
      data: {
        transactionId: result.transaction.id,
        balanceGrantId: result.grant.id,
        billingMode: ProductBillingMode.PAY_AS_YOU_GO,
        source: BalanceTransactionAttributionSource.ADMIN_BALANCE_ADJUSTMENT,
      },
    });
    expect(prisma.balanceTransaction.create.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.balanceTransactionAttribution.create.mock.invocationCallOrder[0],
    );
    expect(prisma.balanceTransactionAttribution.create.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.idempotencyKey.update.mock.invocationCallOrder[0],
    );
  });

  it('rejects non-positive voucher amounts', async () => {
    const { service, prisma } = await buildService();

    await expect(service.issueVoucher('u1', 0, 'bad')).rejects.toThrow('代金券金额');
    expect(prisma.balanceGrant.create).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
  });

  it('persists admin voucher idempotency around the funding transaction', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('u1', 20);

    const result = await service.issueVoucher('u1', 1500, '客服补偿', {
      tenantId: 'tenant-1',
      idempotencyKey: 'voucher-key-1',
    });

    expect(prisma.idempotencyKey.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        key: 'voucher-key-1',
        scope: 'admin:issue-voucher',
        userId: 'u1',
        status: 'PENDING',
        result: {
          version: 2,
          status: 'PENDING',
          request: {
            scope: 'admin:issue-voucher',
            userId: 'u1',
            tenantId: 'tenant-1',
            billingAccountId: 'ba_personal_u1',
            amountUsd: '15.000000000000',
            productId: null,
            description: '客服补偿',
            reason: '客服补偿',
            expiresAt: null,
            performedBy: null,
          },
        },
        expiresAt: expect.any(Date),
      }),
    });
    expect(prisma.idempotencyKey.create.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.accountWallet.update.mock.invocationCallOrder[0],
    );
    expect(prisma.idempotencyKey.update).toHaveBeenCalledWith({
      where: {
        key_scope: {
          key: 'voucher-key-1',
          scope: 'admin:issue-voucher',
        },
      },
      data: expect.objectContaining({
        userId: 'u1',
        status: 'COMMITTED',
        result: expect.objectContaining({
          version: 2,
          status: 'COMMITTED',
          request: expect.objectContaining({
            billingAccountId: 'ba_personal_u1',
            amountUsd: '15.000000000000',
          }),
          response: expect.objectContaining({
            transaction: expect.objectContaining({ id: result.transaction.id }),
            grant: expect.objectContaining({ id: result.grant.id }),
          }),
        }),
        expiresAt: expect.any(Date),
      }),
    });
  });

  it('replays a committed admin voucher response without funding again', async () => {
    const { service, prisma } = await buildService();
    const replay = {
      transaction: {
        id: 'tx-replay',
        userId: 'u1',
        tenantId: 'tenant-1',
        productId: null,
        type: 'ADJUST',
        amountCents: 1500,
        balanceAfterCents: 3500,
        amountUsd: 15,
        balanceAfterUsd: 35,
        description: 'voucher:grant-replay 客服补偿',
        createdAt: '2025-01-01T00:00:00.000Z',
      },
      grant: {
        id: 'grant-replay',
        source: 'VOUCHER',
        amountCents: 1500,
        remainingCents: 1500,
        paidAmountCents: 0,
        bonusAmountCents: 1500,
        discountRate: 0,
        productId: null,
        expiresAt: null,
      },
    };
    prisma.idempotencyKey.create.mockRejectedValueOnce({ code: 'P2002' });
    prisma.idempotencyKey.findUnique.mockResolvedValueOnce({
      key: 'voucher-key-1',
      scope: 'admin:issue-voucher',
      userId: 'u1',
      status: 'COMMITTED',
      result: replay,
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
    });
    prisma.balanceTransaction.findUnique.mockResolvedValueOnce({
      id: 'tx-replay',
      operationKey: null,
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      type: 'ADJUST',
      amountUsd: new Prisma.Decimal(15),
      balanceAfterUsd: new Prisma.Decimal(35),
      description: 'voucher:grant-replay 客服补偿',
      orderId: null,
      productId: null,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
    });
    prisma.balanceGrant.findUnique.mockResolvedValueOnce({
      id: 'grant-replay',
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      source: 'VOUCHER',
      productId: null,
      paidAmountUsd: new Prisma.Decimal(0),
      bonusAmountUsd: new Prisma.Decimal(15),
      grantedAmountUsd: new Prisma.Decimal(15),
      expiresAt: null,
    });

    const result = await service.issueVoucher('u1', 1500, '客服补偿', {
      tenantId: 'tenant-1',
      idempotencyKey: 'voucher-key-1',
    });

    expect(result).toEqual(replay);
    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(prisma.balanceGrant.create).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
  });

  it('rejects reuse of a voucher idempotency key with a different reason', async () => {
    const { service, prisma, redis } = await buildService();
    const { row } = committedVoucherIdempotencyRow('客服补偿');
    prisma.idempotencyKey.create.mockRejectedValueOnce({ code: 'P2002' });
    prisma.idempotencyKey.findUnique.mockResolvedValueOnce(row);

    await expect(service.issueVoucher('u1', 1500, '营销赠送', {
      tenantId: 'tenant-1',
      idempotencyKey: 'voucher-key-v2',
    })).rejects.toThrow('ADMIN_FUNDING_IDEMPOTENCY_FINGERPRINT_MISMATCH');

    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(prisma.balanceGrant.create).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('returns a committed voucher and fans out even when cache refresh fails', async () => {
    const { service, prisma, redis, publisher } = await buildService(
      {},
      {},
      {},
      undefined,
      {},
    );
    const { row, response } = committedVoucherIdempotencyRow();
    prisma.idempotencyKey.create.mockRejectedValueOnce({ code: 'P2002' });
    prisma.idempotencyKey.findUnique.mockResolvedValueOnce(row);
    redis.set.mockRejectedValueOnce(new Error('cache unavailable'));

    await expect(service.issueVoucher('u1', 1500, '客服补偿', {
      tenantId: 'tenant-1',
      idempotencyKey: 'voucher-key-v2',
    })).resolves.toEqual(response);

    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(publisher?.syncBillingAccountKeyBalances).toHaveBeenCalledWith('ba_personal_u1');
  });
});

// ============================================================
// BillingService.sweepExpiredBalanceGrants
// ============================================================
describe('BillingService.sweepExpiredBalanceGrants', () => {
  it('writes an expiry adjustment and clears the remaining grant balance', async () => {
    const { service, prisma } = await buildService();
    const now = new Date('2026-06-05T00:00:00.000Z');
    const lockedFinancialNow = new Date('2026-07-16T00:00:00.000Z');
    const grant = {
      id: 'grant-expired',
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      orderId: null,
      productId: 'prod-payg',
      source: 'VOUCHER',
      paidAmountUsd: new Prisma.Decimal(0),
      bonusAmountUsd: new Prisma.Decimal(10),
      grantedAmountUsd: new Prisma.Decimal(10),
      remainingAmountUsd: new Prisma.Decimal(10),
      remainingPaidAmountUsd: new Prisma.Decimal(0),
      remainingBonusAmountUsd: new Prisma.Decimal(10),
      discountRate: new Prisma.Decimal(0),
      validFrom: new Date('2026-06-01T00:00:00.000Z'),
      expiresAt: now,
      isExpired: false,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    };
    const liveGrant = {
      ...grant,
      id: 'grant-live',
      paidAmountUsd: new Prisma.Decimal(15),
      bonusAmountUsd: new Prisma.Decimal(0),
      grantedAmountUsd: new Prisma.Decimal(15),
      remainingAmountUsd: new Prisma.Decimal(15),
      remainingPaidAmountUsd: new Prisma.Decimal(15),
      remainingBonusAmountUsd: new Prisma.Decimal(0),
      discountRate: new Prisma.Decimal(1),
      expiresAt: new Date('2027-06-05T00:00:00.000Z'),
    };
    prisma.balanceGrant.findUnique.mockResolvedValue(grant);
    prisma.balanceGrant.findMany
      .mockResolvedValueOnce([grant])
      .mockResolvedValueOnce([grant, liveGrant]);
    prisma.__setWalletBalance('ba_personal_u1', 25);

    const result = await service.sweepExpiredBalanceGrants(now, 10);

    expect(prisma.balanceGrant.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        isExpired: false,
        expiresAt: { lte: now, not: null },
      }),
    }));
    expect(prisma.balanceGrant.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'grant-expired',
        isExpired: false,
        remainingAmountUsd: new Prisma.Decimal(10),
        remainingPaidAmountUsd: new Prisma.Decimal(0),
        remainingBonusAmountUsd: new Prisma.Decimal(10),
        expiresAt: { lte: lockedFinancialNow, not: null },
      }),
      data: {
        remainingAmountUsd: new Prisma.Decimal(0),
        remainingPaidAmountUsd: new Prisma.Decimal(0),
        remainingBonusAmountUsd: new Prisma.Decimal(0),
        isExpired: true,
      },
    }));
    expect(prisma.$executeRaw.mock.calls.some(([sql]: [TemplateStringsArray]) => (
      Array.from(sql).join('').includes("SET LOCAL billing.balance_grant_expiry_writer = 'v2'")
    ))).toBe(true);
    expect(prisma.balanceTransaction.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        userId: 'u1',
        tenantId: 'tenant-1',
        billingAccountId: 'ba_personal_u1',
        productId: 'prod-payg',
        type: 'ADJUST',
        amountUsd: new Prisma.Decimal(-10),
        balanceAfterUsd: new Prisma.Decimal(15),
        description: 'balance grant expired:grant-expired',
      }),
    }));
    expect(prisma.balanceGrantExpiry.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        balanceGrantId: 'grant-expired',
        billingAccountId: 'ba_personal_u1',
        nominalAmountUsd: new Prisma.Decimal(10),
        nominalPaidUsd: new Prisma.Decimal(0),
        nominalBonusUsd: new Prisma.Decimal(10),
        walletDebitUsd: new Prisma.Decimal(10),
        unbackedAmountUsd: new Prisma.Decimal(0),
        walletBalanceBeforeUsd: new Prisma.Decimal(25),
        walletBalanceAfterUsd: new Prisma.Decimal(15),
      }),
    });
    expect(result).toEqual({
      scanned: 1,
      expired: 1,
      failed: 0,
      totalExpiredUsd: 10,
      totalWalletDebitedUsd: 10,
      totalUnbackedUsd: 0,
    });
  });

  it('does not double-write when another worker already claimed the grant', async () => {
    const { service, prisma } = await buildService();
    const now = new Date('2026-06-05T00:00:00.000Z');
    const claimedGrant = {
      id: 'grant-expired',
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      orderId: null,
      productId: null,
      source: 'VOUCHER',
      paidAmountUsd: new Prisma.Decimal(0),
      bonusAmountUsd: new Prisma.Decimal(10),
      grantedAmountUsd: new Prisma.Decimal(10),
      remainingAmountUsd: new Prisma.Decimal(10),
      remainingPaidAmountUsd: new Prisma.Decimal(0),
      remainingBonusAmountUsd: new Prisma.Decimal(10),
      discountRate: new Prisma.Decimal(0),
      validFrom: new Date('2026-06-01T00:00:00.000Z'),
      expiresAt: now,
      isExpired: false,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    };
    prisma.balanceGrant.findUnique.mockResolvedValue(claimedGrant);
    prisma.balanceGrant.findMany
      .mockResolvedValueOnce([claimedGrant])
      // The transaction re-read no longer sees it as active: another worker won.
      .mockResolvedValueOnce([]);

    const result = await service.sweepExpiredBalanceGrants(now, 10);

    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
    expect(result).toEqual({
      scanned: 1,
      expired: 0,
      failed: 0,
      totalExpiredUsd: 0,
      totalWalletDebitedUsd: 0,
      totalUnbackedUsd: 0,
    });
  });

  it('quarantines even a one-millionth wallet/grant mismatch instead of partially expiring', async () => {
    const { service, prisma } = await buildService();
    const now = new Date('2026-06-05T00:00:00.000Z');
    const grant = {
      id: 'grant-mismatch',
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      orderId: null,
      productId: null,
      source: 'VOUCHER',
      paidAmountUsd: new Prisma.Decimal(0),
      bonusAmountUsd: new Prisma.Decimal(10),
      grantedAmountUsd: new Prisma.Decimal(10),
      remainingAmountUsd: new Prisma.Decimal(10),
      remainingPaidAmountUsd: new Prisma.Decimal(0),
      remainingBonusAmountUsd: new Prisma.Decimal(10),
      discountRate: new Prisma.Decimal(0),
      validFrom: new Date('2026-06-01T00:00:00.000Z'),
      expiresAt: now,
      isExpired: false,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    };
    prisma.balanceGrant.findUnique.mockResolvedValue(grant);
    prisma.balanceGrant.findMany
      .mockResolvedValueOnce([grant])
      .mockResolvedValueOnce([grant]);
    prisma.__setWalletBalance('ba_personal_u1', new Prisma.Decimal('9.999999'));

    const result = await service.sweepExpiredBalanceGrants(now, 10);

    expect(prisma.balanceGrant.updateMany).not.toHaveBeenCalled();
    expect(prisma.accountWallet.updateMany).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
    expect(prisma.balanceGrantExpiry.create).not.toHaveBeenCalled();
    expect(prisma.billingAccount.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'ba_personal_u1' }),
      data: expect.objectContaining({
        balanceGrantLedgerStatus: 'LEGACY_DIRTY',
      }),
    }));
    expect(result).toEqual({
      scanned: 1,
      expired: 0,
      failed: 1,
      totalExpiredUsd: 0,
      totalWalletDebitedUsd: 0,
      totalUnbackedUsd: 0,
    });
  });
});

// ============================================================
// BillingService.getCreditDetails
// ============================================================
describe('BillingService.getCreditDetails', () => {
  function balanceGrant(overrides: Record<string, any>) {
    return {
      id: 'grant-1',
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      orderId: null,
      productId: null,
      source: 'RECHARGE',
      paidAmountUsd: new Prisma.Decimal(0),
      bonusAmountUsd: new Prisma.Decimal(0),
      grantedAmountUsd: new Prisma.Decimal(0),
      remainingAmountUsd: new Prisma.Decimal(0),
      discountRate: new Prisma.Decimal(1),
      validFrom: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: new Date('2027-01-01T00:00:00.000Z'),
      isExpired: false,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      ...overrides,
    };
  }

  it('splits recharge principal from recharge bonus and voucher grants', async () => {
    const { service, prisma } = await buildService();
    const rechargeGrant = balanceGrant({
      id: 'grant-recharge',
      orderId: 'order-1',
      paidAmountUsd: new Prisma.Decimal(100),
      bonusAmountUsd: new Prisma.Decimal(5),
      grantedAmountUsd: new Prisma.Decimal(105),
      remainingAmountUsd: new Prisma.Decimal(52.5),
      discountRate: new Prisma.Decimal('0.952380952381'),
    });
    const voucherGrant = balanceGrant({
      id: 'grant-voucher',
      source: 'VOUCHER',
      paidAmountUsd: new Prisma.Decimal(0),
      bonusAmountUsd: new Prisma.Decimal(15),
      grantedAmountUsd: new Prisma.Decimal(15),
      remainingAmountUsd: new Prisma.Decimal(15),
      discountRate: new Prisma.Decimal(0),
    });
    prisma.balanceGrant.findMany
      .mockResolvedValueOnce([rechargeGrant])
      .mockResolvedValueOnce([rechargeGrant, voucherGrant]);
    prisma.balanceGrant.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);

    const result = await service.getCreditDetails(
      'u1',
      { creditPage: 1, voucherPage: 1, pageSize: 20 },
      { tenantId: 'tenant-1' },
    );

    expect(result.credits.items).toEqual([
      expect.objectContaining({
        id: 'grant-recharge:credit',
        grantId: 'grant-recharge',
        orderId: 'order-1',
        source: 'RECHARGE',
        amountCents: 10000,
        remainingCents: 5000,
        status: 'ACTIVE',
      }),
    ]);
    expect(result.vouchers.items).toEqual([
      expect.objectContaining({
        id: 'grant-recharge:voucher',
        grantId: 'grant-recharge',
        source: 'RECHARGE_BONUS',
        amountCents: 500,
        remainingCents: 250,
        status: 'ACTIVE',
      }),
      expect.objectContaining({
        id: 'grant-voucher:voucher',
        grantId: 'grant-voucher',
        source: 'VOUCHER',
        amountCents: 1500,
        remainingCents: 1500,
        status: 'ACTIVE',
      }),
    ]);
    expect(result.credits.total).toBe(1);
    expect(result.vouchers.total).toBe(2);
  });

  it('queries only recharge grants for credit purchase details', async () => {
    const { service, prisma } = await buildService();
    const ownerWhere = {
      OR: [
        { billingAccountId: 'ba_personal_u1' },
        { tenantId: 'tenant-1', billingAccountId: null },
      ],
    };

    await service.getCreditDetails(
      'u1',
      { creditPage: 1, voucherPage: 1, pageSize: 20 },
      { tenantId: 'tenant-1' },
    );

    expect(prisma.balanceGrant.findMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({
        AND: [ownerWhere],
        source: 'RECHARGE',
        paidAmountUsd: { gt: new Prisma.Decimal(0) },
      }),
    );
    expect(prisma.balanceGrant.count.mock.calls[0][0].where).toEqual(
      expect.objectContaining({
        AND: [ownerWhere],
        source: 'RECHARGE',
        paidAmountUsd: { gt: new Prisma.Decimal(0) },
      }),
    );
    expect(prisma.balanceGrant.findMany.mock.calls[1][0].where).toEqual(
      expect.objectContaining({
        AND: [
          ownerWhere,
          {
            OR: [
              { source: 'VOUCHER' },
              { source: 'RECHARGE', bonusAmountUsd: { gt: new Prisma.Decimal(0) } },
            ],
          },
        ],
      }),
    );
  });
});

describe('BillingService.getTokenUsageSummary', () => {
  it('returns token bucket totals used by the usage token composition chart', async () => {
    const { service, prisma, repo } = await buildService();
    configureBillingMemberSubject(prisma);
    repo.aggregateTokenUsageSummary.mockResolvedValue({
      items: [
        {
          date: '2026-06-03',
          apiKeyId: 'key-1',
          apiKeyName: 'Primary key',
          apiKeyPrefix: 'sk-abc',
          model: 'claude-opus-4-7',
          calls: 2,
          totalTokens: 420,
          promptTokens: 260,
          cachedInputTokens: 40,
          cacheWriteInputTokens: 30,
          completionTokens: 160,
          costUsd: new Prisma.Decimal('0.42'),
          paymentDeductionUsd: new Prisma.Decimal('0.40'),
          voucherDeductionUsd: new Prisma.Decimal('0.02'),
        },
      ],
      total: 1,
    });

    const result = await service.getTokenUsageSummary(
      'u1',
      { page: 1, pageSize: 20 },
      { tenantId: 'tenant-1' },
    );

    expect(result.items[0]).toMatchObject({
      promptTokens: 260,
      cachedInputTokens: 40,
      cacheWriteInputTokens: 30,
      completionTokens: 160,
      costUsd: 0.42,
      paymentDeductionUsd: 0.4,
      voucherDeductionUsd: 0.02,
    });
    expect(repo.aggregateTokenUsageSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        apiKeyUserId: 'u1',
      }),
      1,
      20,
    );
  });

  it('does not apply per-user token usage filters for the canonical tenant owner', async () => {
    const { service, repo } = await buildService();
    repo.aggregateTokenUsageSummary.mockResolvedValue({ items: [], total: 0 });

    await service.getTokenUsageSummary(
      'u1',
      { page: 1, pageSize: 20 },
      { tenantId: 'tenant-1' },
    );

    expect(repo.aggregateTokenUsageSummary).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        apiKeyUserId: undefined,
      }),
      1,
      20,
    );
  });

  it('rejects a noncanonical raw owner before removing the per-user token filter', async () => {
    const { service, prisma, repo } = await buildService();
    configureBillingMemberSubject(prisma);
    prisma.tenantMember.findFirst.mockResolvedValue({
      id: 'tm-u1',
      role: 'owner',
      status: 'active',
    });
    repo.aggregateTokenUsageSummary.mockResolvedValue({ items: [], total: 0 });

    await expect(service.getTokenUsageSummary(
      'u1',
      { page: 1, pageSize: 20 },
      { tenantId: 'tenant-1' },
    )).rejects.toThrow('账务主体配置不一致');

    expect(repo.aggregateTokenUsageSummary).not.toHaveBeenCalled();
  });
});

describe('BillingService.getTokenUsagePeriodSummary', () => {
  it('returns exact monthly amounts without client-side detail pagination', async () => {
    const { service, prisma, repo } = await buildService();
    configureBillingMemberSubject(prisma);
    repo.aggregateTokenUsagePeriodSummary.mockResolvedValue([{
      period: '2026-06',
      calls: 2,
      totalTokens: 420,
      costUsd: new Prisma.Decimal('0.42'),
      paymentDeductionUsd: new Prisma.Decimal('0.40'),
      voucherDeductionUsd: new Prisma.Decimal('0.02'),
    }]);

    const result = await service.getTokenUsagePeriodSummary(
      'u1',
      { granularity: 'month', startDate: '2026-06-01', endDate: '2026-06-30' },
      { tenantId: 'tenant-1' },
    );

    expect(result).toEqual({
      granularity: 'month',
      items: [expect.objectContaining({
        period: '2026-06',
        costUsd: 0.42,
        costAmount: '0.420000000000',
        paymentDeductionAmount: '0.400000000000',
        voucherDeductionAmount: '0.020000000000',
      })],
    });
    expect(repo.aggregateTokenUsagePeriodSummary).toHaveBeenCalledWith(
      expect.objectContaining({ tenantId: 'tenant-1', apiKeyUserId: 'u1' }),
      'month',
    );
  });
});

describe('BillingService.getTokenUsage', () => {
  it('checks member apiKeyId access against the current user', async () => {
    const { service, prisma, repo } = await buildService();
    configureBillingMemberSubject(prisma);
    prisma.apiKey.findFirst.mockResolvedValue({ id: 'key-1' });
    repo.findTokenUsageItems.mockResolvedValue([]);
    repo.countTokenUsageItems.mockResolvedValue(0);

    await service.getTokenUsage(
      'u1',
      { apiKeyId: 'key-1', page: 1, pageSize: 20 },
      {
        tenantId: 'tenant-1',
        billingAccountId: 'ba_personal_u1',
      },
    );

    expect(prisma.apiKey.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'key-1',
        tenantId: 'tenant-1',
        userId: 'u1',
      }),
    }));
    expect(repo.findTokenUsageItems).toHaveBeenCalledWith(
      expect.objectContaining({
        tenantId: 'tenant-1',
        apiKeyUserId: 'u1',
        apiKeyId: 'key-1',
      }),
      1,
      20,
    );
  });
});

describe('BillingService.reserveGatewayBalanceFunding guard release', () => {
  const guardReleaseExpectation = (
    gatewayBillingEventId: string,
    billingAccountId = 'ba_personal_u1',
  ) => ({
    where: {
      gatewayBillingEventId,
      billingAccountId,
      status: 'ACTIVE',
      reason: 'pending_usage_unreserved',
    },
    data: {
      status: 'RELEASED',
      releasedAt: new Date('2026-07-16T00:00:00.000Z'),
      releasedBy: 'SYSTEM',
      releaseReason: 'gateway_funding_reserved',
    },
  });

  it('releases the first-receipt guard only after the reservation and grant holds are durable', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('ba_personal_u1', 10);
    prisma.balanceGrant.findMany.mockResolvedValue([{
      id: 'grant-guard-release',
      remainingAmountUsd: new Prisma.Decimal(10),
    }]);
    const input = gatewayReservationInput(prisma, {
      amountUsd: 5,
      requestId: 'req-guard-release-after-holds',
    });

    await expect(service.reserveGatewayBalanceFunding(input)).resolves.toEqual(
      expect.objectContaining({
        requestId: input.requestId,
        status: 'ACTIVE',
        reservedAmountUsd: new Prisma.Decimal(5),
        collectedUsd: new Prisma.Decimal(5),
      }),
    );

    expect(prisma.billingAccessRestriction.updateMany).toHaveBeenCalledWith(
      guardReleaseExpectation(input.gatewayBillingEventId),
    );
    const reservationOrder = prisma.gatewayUsageFundingReservation.create.mock.invocationCallOrder[0];
    const grantHoldsOrder = prisma.gatewayUsageFundingReservationGrant.createMany.mock.invocationCallOrder[0];
    const guardReleaseOrder = prisma.billingAccessRestriction.updateMany.mock.invocationCallOrder[0];
    expect(reservationOrder).toBeLessThan(grantHoldsOrder);
    expect(grantHoldsOrder).toBeLessThan(guardReleaseOrder);
  });

  it('repairs an ACTIVE reservation replay only after validating its frozen grant slices', async () => {
    const { service, prisma } = await buildService();
    const input = gatewayReservationInput(prisma, {
      amountUsd: 0,
      requestId: 'req-guard-release-replay',
    });
    prisma.gatewayUsageFundingReservation.findUnique.mockResolvedValue({
      id: 'reservation-replay',
      gatewayBillingEventId: input.gatewayBillingEventId,
      requestId: input.requestId,
      billingAccountId: input.billingAccountId,
      tenantId: input.tenantId,
      userId: input.userId,
      apiKeyId: input.apiKeyId,
      billingCurrency: input.billingCurrency,
      collectedFundingProtocol: 'NON_EXPIRING_GRANTS_V1',
      occurredAt: input.occurredAt,
      firstReceivedAt: input.firstReceivedAt,
      reservationSequence: input.firstReceiptSequence,
      reservedAmountUsd: new Prisma.Decimal(0),
      collectedUsd: new Prisma.Decimal(0),
      approvedCreditUsd: new Prisma.Decimal(0),
      unapprovedDebtUsd: new Prisma.Decimal(0),
      anchorHash: input.anchorHash,
      canonicalPayload: { collectedGrantSlices: [] },
      status: 'ACTIVE',
      reviewReason: null,
    });

    await expect(service.reserveGatewayBalanceFunding(input)).resolves.toEqual(
      expect.objectContaining({ id: 'reservation-replay', status: 'ACTIVE' }),
    );

    expect(prisma.gatewayUsageFundingReservation.create).not.toHaveBeenCalled();
    expect(prisma.billingAccessRestriction.updateMany).toHaveBeenCalledWith(
      guardReleaseExpectation(input.gatewayBillingEventId),
    );
    expect(prisma.gatewayUsageFundingReservationGrant.findMany.mock.invocationCallOrder[0])
      .toBeLessThan(prisma.billingAccessRestriction.updateMany.mock.invocationCallOrder[0]);
  });

  it('releases the guard for a durable zero-amount reservation without manufacturing grant holds', async () => {
    const { service, prisma } = await buildService();
    const input = gatewayReservationInput(prisma, {
      amountUsd: 0,
      requestId: 'req-zero-reservation-guard-release',
    });

    await expect(service.reserveGatewayBalanceFunding(input)).resolves.toEqual(
      expect.objectContaining({
        requestId: input.requestId,
        reservedAmountUsd: new Prisma.Decimal(0),
        collectedUsd: new Prisma.Decimal(0),
        approvedCreditUsd: new Prisma.Decimal(0),
        unapprovedDebtUsd: new Prisma.Decimal(0),
      }),
    );

    expect(prisma.gatewayUsageFundingReservationGrant.createMany).not.toHaveBeenCalled();
    expect(prisma.billingAccessRestriction.updateMany).toHaveBeenCalledWith(
      guardReleaseExpectation(input.gatewayBillingEventId),
    );
    expect(prisma.gatewayUsageFundingReservation.create.mock.invocationCallOrder[0])
      .toBeLessThan(prisma.billingAccessRestriction.updateMany.mock.invocationCallOrder[0]);
  });

  it('leaves the guard ACTIVE when an earlier receipt keeps the funding queue pending', async () => {
    const { service, prisma } = await buildService();
    const input = gatewayReservationInput(prisma, {
      amountUsd: 0,
      requestId: 'req-guard-release-queue-pending',
      firstReceiptSequence: 2n,
    });
    prisma.$queryRaw.mockImplementation(async (query: unknown, ...values: unknown[]) => {
      const sql = Array.isArray(query) ? query.join('') : String(query);
      // blocker 查询的入口已从 anchors 全表改为稀疏队列 gateway_usage_unreserved_queue
      // (anchors 现在只是 JOIN 进来取 request_id/sequence)。这里匹配 FROM 子句而不是
      // 表名子串,避免又一次被「表还在,只是不再是入口」骗过去 —— 那会让这条
      // 「真有更早未预留 receipt 时必须阻塞」的用例静默变成空跑。
      if (sql.includes('FROM "gateway_usage_unreserved_queue" AS queue')) {
        return [{ requestId: 'req-earlier-unreserved', firstReceiptSequence: 1n }];
      }
      return prisma.__defaultQueryRaw(query, ...values);
    });

    await expect(service.reserveGatewayBalanceFunding(input))
      .rejects.toBeInstanceOf(GatewayFundingReservationQueuePendingError);

    expect(prisma.gatewayUsageFundingReservation.create).not.toHaveBeenCalled();
    expect(prisma.billingAccessRestriction.updateMany).not.toHaveBeenCalled();
  });

  it('does not release the guard when grant-hold persistence fails', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('ba_personal_u1', 10);
    prisma.balanceGrant.findMany.mockResolvedValue([{
      id: 'grant-guard-write-failure',
      remainingAmountUsd: new Prisma.Decimal(10),
    }]);
    prisma.gatewayUsageFundingReservationGrant.createMany
      .mockRejectedValueOnce(new Error('grant hold write failed'));
    const input = gatewayReservationInput(prisma, {
      amountUsd: 5,
      requestId: 'req-guard-release-grant-failure',
    });

    await expect(service.reserveGatewayBalanceFunding(input))
      .rejects.toThrow('grant hold write failed');

    expect(prisma.gatewayUsageFundingReservation.create).toHaveBeenCalled();
    expect(prisma.billingAccessRestriction.updateMany).not.toHaveBeenCalled();
  });

  it('fails the reservation transaction when the atomic guard release cannot commit', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('ba_personal_u1', 10);
    prisma.balanceGrant.findMany.mockResolvedValue([{
      id: 'grant-guard-release-failure',
      remainingAmountUsd: new Prisma.Decimal(10),
    }]);
    prisma.billingAccessRestriction.updateMany
      .mockRejectedValueOnce(new Error('guard release write failed'));
    const input = gatewayReservationInput(prisma, {
      amountUsd: 5,
      requestId: 'req-guard-release-write-failure',
    });

    await expect(service.reserveGatewayBalanceFunding(input))
      .rejects.toThrow('guard release write failed');

    expect(prisma.gatewayUsageFundingReservation.create).toHaveBeenCalled();
    expect(prisma.gatewayUsageFundingReservationGrant.createMany).toHaveBeenCalled();
    expect(prisma.billingAccessRestriction.updateMany).toHaveBeenCalledWith(
      guardReleaseExpectation(input.gatewayBillingEventId),
    );
    expect(prisma.gatewayUsageFundingReservationGrant.createMany.mock.invocationCallOrder[0])
      .toBeLessThan(prisma.billingAccessRestriction.updateMany.mock.invocationCallOrder[0]);
  });
});

describe('BillingService.reserveGatewayBalanceFunding reservation lock scope', () => {
  // The account reservation lock must cover only the live capacity set. Locking
  // terminal rows too made the statement O(account history): one hot account
  // reached 241,498 rows (all CONSUMED) at ~800ms per event, and the cost grew
  // with the table. These tests pin the filter, the lock order it sits in, and
  // the fact that it cannot drift from lockActiveGatewayFundingReservations().
  const reservationLockSql = (prisma: any): string[] => prisma.$queryRaw.mock.calls
    .map(([query]: [TemplateStringsArray]) => String(query))
    .filter((sql: string) => (
      sql.includes('FROM "gateway_usage_funding_reservations"')
      && sql.includes('FOR UPDATE')
      && sql.includes('billing_account_id')
      // FIFO 队头判定也满足上面三条(它的 NOT EXISTS 子查询同样 FROM 这张表,
      // 外层又带 FOR UPDATE OF anchor),但它不是预留锁语句。两类语句的稳定分界
      // 是 anchors 表:队头判定必然查它,预留锁必然不查。
      && !sql.includes('gateway_usage_settlement_anchors')
    ));

  it('locks only ACTIVE and MANUAL_REVIEW reservations, never the terminal history', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('ba_personal_u1', 10);
    prisma.balanceGrant.findMany.mockResolvedValue([{
      id: 'grant-lock-scope',
      remainingAmountUsd: new Prisma.Decimal(10),
    }]);

    await service.reserveGatewayBalanceFunding(gatewayReservationInput(prisma, {
      amountUsd: 5,
      requestId: 'req-reservation-lock-scope',
    }));

    const locks = reservationLockSql(prisma);
    expect(locks.length).toBeGreaterThan(0);
    for (const sql of locks) {
      // Must filter to the live set...
      expect(sql).toContain("\"status\" IN ('ACTIVE', 'MANUAL_REVIEW')");
      // ...and must not express it as a negation: RELEASED is just as immutable
      // and terminal as CONSUMED, so `<> 'CONSUMED'` would let absorb/no-charge
      // history keep growing the lock set.
      expect(sql).not.toMatch(/status"?\s*(<>|!=)/);
      // Ordered acquisition is what keeps the account lock order deadlock-free.
      expect(sql).toContain('ORDER BY "reservation_sequence" ASC');
    }
  });

  it('measures the ledger transaction around $transaction, not inside it', async () => {
    const { service, prisma } = await buildService();
    // The deferred CONSTRAINT triggers — including the per-row debt
    // conservation assertion that batching cannot remove — fire at COMMIT,
    // after the callback returns. A timer inside the callback is blind to them,
    // and that blind spot is the remaining capacity risk on this path: a 60s
    // budget overrun that presented as a silent 502 with the money already
    // taken. So the wrapper has to observe the settled promise, both when it
    // resolves and when it rejects.
    let settledBeforeWrapperSaw = false;
    const original = prisma.$transaction;
    prisma.$transaction = jest.fn(async (
      fn: (db: unknown) => Promise<unknown>,
      opts: Record<string, unknown>,
    ) => {
      try {
        return await original.call(prisma, fn, opts);
      } finally {
        // Stands in for COMMIT-time work. Whatever the wrapper reports must
        // include time spent here, which is only possible if it awaits.
        await new Promise((resolve) => setTimeout(resolve, 12));
        settledBeforeWrapperSaw = true;
      }
    });

    // Rejection is the interesting direction: a timeout must still be reported
    // with its duration, not swallowed or reported as a plain rollback.
    await expect(service.creditBonus('u1', 100, 'ops adjust')).rejects.toThrow();

    expect(settledBeforeWrapperSaw).toBe(true);
    // Budget accounting must come from the shared constant, not a literal, so
    // raising the transaction timeout cannot silently make every reading look
    // healthier than it is.
    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      expect.objectContaining({ timeout: 60_000 }),
    );
  });

  describe('gateway funding blocker source', () => {
    // The guard-sourced query answers the same question from a set of 4 ACTIVE
    // rows instead of the account's 359,775-row anchor history. It is only
    // correct while "every unreserved eligible anchor carries exactly one ACTIVE
    // pending_usage_unreserved guard" holds, and that was audited at a point in
    // time, not proven for all time. So the default must run both and trust the
    // original — these tests pin that default, because silently shipping
    // `guard` would move real money out of FIFO order if the invariant ever
    // slips.
    const blockerSql = (prisma: any): string[] => prisma.$queryRaw.mock.calls
      .map(([q]: [TemplateStringsArray]) => String(q))
      .filter((sql: string) => sql.includes('first_receipt_sequence" ASC')
        && sql.includes('FOR UPDATE OF anchor'));

    async function reserveWith(env: string | undefined) {
      const previous = process.env.BILLING_FUNDING_BLOCKER_SOURCE;
      if (env === undefined) delete process.env.BILLING_FUNDING_BLOCKER_SOURCE;
      else process.env.BILLING_FUNDING_BLOCKER_SOURCE = env;
      try {
        const stages = createStageTimings();
        const { service, prisma } = await buildService();
        prisma.__setWalletBalance('ba_personal_u1', 10);
        prisma.balanceGrant.findMany.mockResolvedValue([{
          id: 'grant-blocker-source',
          remainingAmountUsd: new Prisma.Decimal(10),
        }]);
        await runWithStageTimings(stages, () => service.reserveGatewayBalanceFunding(
          gatewayReservationInput(prisma, {
            amountUsd: 5,
            requestId: `req-blocker-${env ?? 'default'}`,
          }),
        ));
        return { stages, prisma, sql: blockerSql(prisma) };
      } finally {
        if (previous === undefined) delete process.env.BILLING_FUNDING_BLOCKER_SOURCE;
        else process.env.BILLING_FUNDING_BLOCKER_SOURCE = previous;
      }
    }

    it('defaults to running both sources and reporting the original', async () => {
      const { stages, sql } = await reserveWith(undefined);

      // Both must run...
      expect(stages.resvBlockingScan?.count ?? 0).toBeGreaterThan(0);
      expect(stages.resvBlockingGuard?.count ?? 0).toBeGreaterThan(0);
      // ...and the comparison outcome must be recorded, so the agreement rate is
      // observable in production rather than assumed.
      const agree = stages.resvBlockingAgree?.count ?? 0;
      const diverge = stages.resvBlockingDiverge?.count ?? 0;
      expect(agree + diverge).toBeGreaterThan(0);
      expect(sql.length).toBe(2);
      // The two queries must differ only in their entry point.
      const guardSql = sql.find((q) => q.includes('billing_access_restrictions'));
      const anchorSql = sql.find((q) => !q.includes('billing_access_restrictions'));
      expect(guardSql).toBeDefined();
      expect(anchorSql).toBeDefined();
      for (const q of sql) {
        // Every predicate of the original is retained by both. The guard join
        // replaces the account scan; it must not relax a single condition.
        expect(q).toMatch(/"billing_unit" = 'BALANCE'/);
        expect(q).toMatch(/"funding_reservation_protocol" = 'V1'/);
        expect(q).toMatch(/'SKIPPED'/);
        expect(q).toMatch(/"funding_outcome" = 'ABSORBED'/);
        expect(q).toMatch(/LIMIT 1/);
      }
      expect(guardSql).toMatch(/"status" = 'ACTIVE'/);
      expect(guardSql).toMatch(/"reason" = 'pending_usage_unreserved'/);
      // 「没有 reservation」在 guard 版仍是对 reservations 的存在性取反;
      // anchor 版已改成读稀疏队列(见下一条测试),所以这两条只对 guard 版成立。
      expect(guardSql).toMatch(/NOT EXISTS/);
      expect(guardSql).toMatch(/FROM "gateway_usage_funding_reservations" AS reservation/);
    });

    it('runs only the anchor source when explicitly pinned', async () => {
      const { stages, sql } = await reserveWith('anchor');
      expect(stages.resvBlockingScan?.count ?? 0).toBeGreaterThan(0);
      expect(stages.resvBlockingGuard?.count ?? 0).toBe(0);
      expect(sql.length).toBe(1);
      expect(sql[0]).not.toContain('billing_access_restrictions');
    });

    it('runs only the guard source when explicitly switched', async () => {
      const { stages, sql } = await reserveWith('guard');
      expect(stages.resvBlockingGuard?.count ?? 0).toBeGreaterThan(0);
      // The expensive scan must be gone entirely — that is the whole point.
      expect(stages.resvBlockingScan?.count ?? 0).toBe(0);
      expect(sql.length).toBe(1);
      expect(sql[0]).toContain('billing_access_restrictions');
    });

    it('treats an unrecognised value as compare, never as guard', async () => {
      // Fail safe: a typo in the ConfigMap must not silently enable the
      // unproven source on a money path.
      const { stages } = await reserveWith('gaurd');
      expect(stages.resvBlockingScan?.count ?? 0).toBeGreaterThan(0);
      expect(stages.resvBlockingGuard?.count ?? 0).toBeGreaterThan(0);
    });

    it('constrains the anchor account on the guard-sourced query too', async () => {
      // The guard query entered from guard."billing_account_id" only. That column
      // has no foreign key and no immutability trigger, so a wrong/hand-repaired
      // row could join an anchor belonging to a DIFFERENT account — either
      // inventing a blocker or hiding the real one (FIFO bypassed, a later
      // receipt takes capital first). Asking for the account on BOTH sides
      // removes the dependency on those two columns always agreeing.
      const { sql } = await reserveWith('guard');
      const guardSql = sql.find((s: string) => s.includes('billing_access_restrictions'));
      expect(guardSql).toBeDefined();
      expect(guardSql).toContain('guard."billing_account_id" =');
      expect(guardSql).toContain('anchor."billing_account_id" =');
    });

    it('falls back to the anchor scan while the queue readiness gate is not granted', async () => {
      // ★ 这条守的是一个会造成资金错序的部署窗口:
      // migration 100 提交后入队/出队触发器即生效,但历史上符合入队条件的 anchor 要等
      // 200 号回填、并经 300 号断言后才算可信。若新代码在这个窗口里就只查 queue,
      // 后到的 receipt 会查到空、成功预留,**越过更早的 receipt(FIFO false negative)**。
      // 「当前生产数据为 0 行」是巧合而非结构安全性,而本仓出现过「新代码先于 schema」的缺口。
      // 也不能拿 guard 版当 fallback —— 它换的是查询输入,依赖一个只能观测不能证明的不变量。
      // 更要紧的是 compare 模式**不能**充当保护:它先返回队列版结果、guard 仅作诊断,
      // 两者 diverge 时仍返回队列版。所以闸门必须在这里、由 migration 写入的标记控制。
      const { service, prisma } = await buildService();
      prisma.__setUnreservedQueueReady(false);
      const input = gatewayReservationInput(prisma, {
        amountUsd: 0,
        requestId: 'req-queue-readiness-not-granted',
        firstReceiptSequence: 2n,
      });

      await service.reserveGatewayBalanceFunding(input);

      const blockerSql: string[] = prisma.$queryRaw.mock.calls
        .map((call: any[]) => String(call[0]?.strings?.join('') ?? call[0]))
        .filter((sql: string) => sql.includes('FOR UPDATE OF anchor'));
      expect(blockerSql.length).toBeGreaterThan(0);
      const anchorSourced = blockerSql.filter((sql) => !sql.includes('billing_access_restrictions'));
      expect(anchorSourced.length).toBeGreaterThan(0);
      for (const sql of anchorSourced) {
        // 未获授权时必须是旧语义:直接对 reservations 做存在性反连接,不碰 queue。
        expect(sql).toContain('FROM "gateway_usage_settlement_anchors" AS anchor');
        expect(sql).toContain('FROM "gateway_usage_funding_reservations" AS reservation');
        expect(sql).toContain('NOT EXISTS');
        expect(sql).not.toContain('gateway_usage_unreserved_queue');
      }
    });

    it('enters from the sparse unreserved queue, never by scanning anchor history', async () => {
      // 这条钉的是**入口形态**,不是速度。三次尝试的教训:
      //   LEFT JOIN + IS NULL → Parallel Hash Right Join,溢出磁盘(16 batches/~15MB temp),
      //                         LIMIT 1 完全失效(两边都要读完);
      //   NOT EXISTS         → Nested Loop Anti Join,无 Sort 无溢出,但结果恒空时
      //                         仍要逐行走完该账户全部历史 anchor(1493ms vs 1609ms,+7%);
      //   MATERIALIZED CTE   → 负收益(2077ms vs 1729ms),planner 仍从 anchor 侧驱动。
      // ⇒ 只要「未预留」不可索引,任何查询形态都要扫全历史。现在它由稀疏队列表承载,
      //   队列成员资格由 DB 触发器维护(migration 20260910000100)。
      // 若这条测试失败,通常意味着有人把入口改回了 anchors 全表 —— 那会让热点账户的
      // 单笔用量处理重新回到秒级,并使积压永久净增长。
      const { sql } = await reserveWith('anchor');
      expect(sql.length).toBe(1);
      const anchorSql = sql[0];
      expect(anchorSql).toContain('FROM "gateway_usage_unreserved_queue" AS queue');
      // 不得再对 reservations 做存在性反连接 —— 那正是恒定全扫的来源。
      expect(anchorSql).not.toContain('FROM "gateway_usage_funding_reservations" AS reservation');
      expect(anchorSql).not.toContain('LEFT JOIN "gateway_usage_funding_reservations"');
      // 必须按 queue 的列排序,否则丢掉队列索引的有序性、LIMIT 1 无法立即终止。
      expect(anchorSql).toContain('ORDER BY queue."first_receipt_sequence" ASC');
      // 账户约束必须两侧都在:只信 queue 侧会在脏数据下误判 FIFO 队头(见 11.3)。
      expect(anchorSql).toContain('queue."billing_account_id" =');
      expect(anchorSql).toContain('anchor."billing_account_id" =');
      // 锁的对象不变,仍是 anchor 行。
      expect(anchorSql).toContain('FOR UPDATE OF anchor');
    });

    it('counts blocker outcomes outside the stage-timing threshold', async () => {
      // The counter exists because stage-timing logs cannot carry this decision:
      // they count attempts (Kafka retries included), carry no requestId/accountId,
      // expire with log retention, and only record every message while
      // BILLING_USAGE_STAGE_TIMING_MIN_MS stays 0 (its code default is 250ms).
      // On 2026-09-03 "Hit=0 across 4450 samples" was nearly used to justify
      // enabling `guard`; the real defect there was that all 4450 agreements were
      // null === null — an empty-set match proves nothing about the blocked case.
      const { prisma } = await reserveWith(undefined);
      expect(prisma).toBeDefined();
      const metric = await billingFundingBlockerTotal.get();
      const seen = metric.values.map((v) => `${v.labels.source}/${v.labels.outcome}`);
      expect(seen).toContain('anchor/miss');
      expect(seen.some((s) => s.startsWith('compare/'))).toBe(true);
    });
  });

  it('probes the reservation lock and the FIFO anti-join under distinct stage names', async () => {
    const stages = createStageTimings();
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('ba_personal_u1', 10);
    prisma.balanceGrant.findMany.mockResolvedValue([{
      id: 'grant-probe',
      remainingAmountUsd: new Prisma.Decimal(10),
    }]);

    await runWithStageTimings(stages, () => service.reserveGatewayBalanceFunding(
      gatewayReservationInput(prisma, { amountUsd: 5, requestId: 'req-reservation-probe' }),
    ));

    // The narrowed account lock: its residual cost was predicted by EXPLAIN but
    // never observed, and the fix landed at a third of its predicted effect.
    expect(stages.resvLockScope?.count ?? 0).toBeGreaterThan(0);
    // The anti-join, which is the remaining O(account history) cost in this
    // transaction and the thing a re-sourcing change would be judged against.
    expect(stages.resvBlockingScan?.count ?? 0).toBeGreaterThan(0);
    // Hit and miss are separate stages on purpose: the empty result is the
    // normal case and the expensive one (LIMIT 1 cannot terminate early when it
    // has to prove no earlier unreserved anchor exists), so averaging the two
    // together would hide exactly the cost being measured. This fixture has no
    // blocking receipt, so the miss stage is the one that must fire.
    expect(stages.resvBlockingMiss?.count ?? 0).toBeGreaterThan(0);
    expect(stages.resvBlockingHit?.count ?? 0).toBe(0);
  });

  it('keeps the reservation lock last in the wallet → grants → account → credit config → reservation order', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('ba_personal_u1', 10);
    prisma.balanceGrant.findMany.mockResolvedValue([{
      id: 'grant-lock-order',
      remainingAmountUsd: new Prisma.Decimal(10),
    }]);

    await service.reserveGatewayBalanceFunding(gatewayReservationInput(prisma, {
      amountUsd: 5,
      requestId: 'req-reservation-lock-order',
    }));

    const calls = prisma.$queryRaw.mock.calls.map(
      ([query]: [TemplateStringsArray], index: number) => ({
        sql: String(query),
        order: prisma.$queryRaw.mock.invocationCallOrder[index],
      }),
    );
    const firstOrder = (table: string) => {
      const call = calls.find(({ sql }: { sql: string }) => (
        sql.includes(`FROM "${table}"`) && sql.includes('FOR UPDATE')
      ));
      expect(call).toBeDefined();
      return call!.order;
    };

    // The wallet lock is the real per-account mutex; it is taken well before the
    // reservation lock, which is why narrowing the reservation lock cannot
    // introduce a reserve-vs-reserve race on the same account.
    expect(firstOrder('account_wallets'))
      .toBeLessThan(firstOrder('gateway_usage_funding_reservations'));
    expect(firstOrder('billing_account_credit_configs'))
      .toBeLessThan(firstOrder('gateway_usage_funding_reservations'));
  });

  it('aggregates capacity over exactly the states it locked', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('ba_personal_u1', 10);
    prisma.balanceGrant.findMany.mockResolvedValue([{
      id: 'grant-lock-aggregate',
      remainingAmountUsd: new Prisma.Decimal(10),
    }]);

    await service.reserveGatewayBalanceFunding(gatewayReservationInput(prisma, {
      amountUsd: 5,
      requestId: 'req-reservation-lock-aggregate',
    }));

    // If the aggregate ever widened past the locked set, the narrowed lock would
    // stop protecting its own inputs — that is the invariant to fail loudly on.
    const aggregateStates = prisma.gatewayUsageFundingReservation.aggregate.mock.calls
      .map(([args]: [any]) => args?.where?.status?.in)
      .filter(Boolean);
    for (const states of aggregateStates) {
      expect([...states].sort()).toEqual(['ACTIVE', 'MANUAL_REVIEW']);
    }
  });
});

// ============================================================
// BillingService.deduct
// ============================================================
describe('BillingService.deduct', () => {
  it('returns success=true and new balance when wallet update succeeds', async () => {
    const { service, redis, prisma } = await buildService();
    redis.get.mockResolvedValue(null);
    prisma.__setWalletBalance('u1', 50);

    const result = await service.deduct('u1', new Prisma.Decimal('20'), 'API用量');

    expect(result.success).toBe(true);
    expect(result.balance).toBe(3000);
    expect(redis.call).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'u1',
          type: 'CONSUME',
          amountUsd: new Prisma.Decimal('-20'),
          balanceAfterUsd: new Prisma.Decimal('30'),
        }),
      }),
    );
  });

  it('does not fan out tenant key balances after deduct while workspace remains funded', async () => {
    const { service, publisher, prisma } = await buildService({}, {}, {}, undefined, {});
    prisma.__setWalletBalance('u1', 50);

    const result = await service.deduct('u1', new Prisma.Decimal('20'), 'API用量');

    expect(result.success).toBe(true);
    expect(result.balanceUsd).toBe(30);
    expect(publisher?.syncBillingAccountKeyBalances).not.toHaveBeenCalled();
    expect(publisher?.syncTenantKeyBalances).not.toHaveBeenCalled();
    expect(publisher?.syncUserKeyBalances).not.toHaveBeenCalled();
  });

  it('fans out tenant key balances when deduct depletes workspace funding', async () => {
    const { service, publisher, prisma, redis } = await buildService({}, {}, {}, undefined, {});
    prisma.__setWalletBalance('u1', 20);

    const result = await service.deduct('u1', new Prisma.Decimal('20'), 'API用量');

    expect(result.success).toBe(true);
    expect(result.balanceUsd).toBe(0);
    expect(publisher?.syncBillingAccountKeyBalances).toHaveBeenCalledWith('ba_personal_u1');
    const latestRedisSetOrder = Math.max(...redis.set.mock.invocationCallOrder);
    expect(publisher?.syncBillingAccountKeyBalances.mock.invocationCallOrder[0])
      .toBeGreaterThan(latestRedisSetOrder);
  });

  it('links consume transaction to token usage when tokenUsageId is provided', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('u1', 50);

    await service.deduct('u1', new Prisma.Decimal('20'), 'API用量', {
      tokenUsageId: 'usage-1',
    });

    expect(prisma.balanceTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'CONSUME',
          tokenUsageId: 'usage-1',
        }),
      }),
    );
  });

  it('allows post-usage API charge to drive balance negative and keep the usage link', async () => {
    const { service, prisma, redis } = await buildService();
    prisma.__setWalletBalance('u1', '0.0001');

    const result = await service.deduct('u1', new Prisma.Decimal('0.0025'), 'API用量', {
      tokenUsageId: 'usage-over-balance',
      allowNegativeBalance: true,
    });

    expect(result.success).toBe(true);
    expect(result.balanceUsd).toBe(-0.0024);
    expect(redis.set).toHaveBeenCalledWith('balance:tenant:tenant-1', '-0.002400000000');
    expect(prisma.balanceTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          amountUsd: new Prisma.Decimal('-0.0025'),
          balanceAfterUsd: new Prisma.Decimal('-0.0024'),
          tokenUsageId: 'usage-over-balance',
        }),
      }),
    );
  });

  it('separates the final over-balance portion into NEGATIVE_BALANCE instead of MIGRATION_OPENING', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('u1', '0.03');
    const grant = {
      id: 'grant-last-funded',
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      productId: null,
      orderId: 'order-last-funded',
      source: 'RECHARGE',
      paidAmountUsd: new Prisma.Decimal('0.03'),
      bonusAmountUsd: new Prisma.Decimal(0),
      grantedAmountUsd: new Prisma.Decimal('0.03'),
      remainingAmountUsd: new Prisma.Decimal('0.03'),
      remainingPaidAmountUsd: new Prisma.Decimal('0.03'),
      remainingBonusAmountUsd: new Prisma.Decimal(0),
      discountRate: new Prisma.Decimal(1),
      validFrom: new Date('2025-01-01T00:00:00.000Z'),
      expiresAt: null,
      isExpired: false,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      updatedAt: new Date('2025-01-01T00:00:00.000Z'),
    };
    prisma.balanceGrant.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([grant])
      .mockResolvedValueOnce([]);
    prisma.balanceGrant.updateMany.mockResolvedValueOnce({ count: 1 });
    const funding = jest.fn();

    const result = await service.deduct('u1', new Prisma.Decimal('0.05'), 'post-usage-over-balance', {
      tokenUsageId: 'usage-cross-zero',
      allowNegativeBalance: true,
      beforeBalanceTransaction: async (_db, context) => funding(context),
    });

    expect(result.success).toBe(true);
    expect(result.balanceUsd).toBe(-0.02);
    expect(funding).toHaveBeenCalledWith(expect.objectContaining({
      collectedUsd: new Prisma.Decimal('0.03'),
      approvedCreditUsd: new Prisma.Decimal(0),
      unapprovedDebtUsd: new Prisma.Decimal('0.02'),
    }));
    expect(prisma.balanceGrant.create).not.toHaveBeenCalled();
    expect(prisma.balanceConsumptionAllocation.create).toHaveBeenCalledTimes(2);
    expect(prisma.balanceConsumptionAllocation.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          balanceGrantId: 'grant-last-funded',
          source: 'BALANCE_GRANT',
          amountUsd: new Prisma.Decimal('0.03'),
          recognizedRevenueUsd: new Prisma.Decimal('0.03'),
        }),
      }),
    );
    expect(prisma.balanceConsumptionAllocation.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          source: 'NEGATIVE_BALANCE',
          amountUsd: new Prisma.Decimal('0.02'),
          tokenUsageId: 'usage-cross-zero',
          recognizedRevenueUsd: new Prisma.Decimal(0),
          bonusConsumedUsd: new Prisma.Decimal(0),
          discountRate: new Prisma.Decimal(0),
          approvedCreditUsd: new Prisma.Decimal(0),
          unapprovedDebtUsd: new Prisma.Decimal('0.02'),
          fundingClassificationComplete: true,
        }),
      }),
    );
  });

  it('treats productId as grant attribution and preserves the account-wide wallet invariant', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('u1', '5');
    const grant = {
      id: 'grant-product-a',
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      productId: 'product-a',
      orderId: 'order-product-a',
      source: 'RECHARGE',
      paidAmountUsd: new Prisma.Decimal('5'),
      bonusAmountUsd: new Prisma.Decimal(0),
      grantedAmountUsd: new Prisma.Decimal('5'),
      remainingAmountUsd: new Prisma.Decimal('5'),
      remainingPaidAmountUsd: new Prisma.Decimal('5'),
      remainingBonusAmountUsd: new Prisma.Decimal(0),
      discountRate: new Prisma.Decimal(1),
      validFrom: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: new Date('2027-01-01T00:00:00.000Z'),
      isExpired: false,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    prisma.balanceGrant.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([grant])
      .mockResolvedValueOnce([]);
    prisma.balanceGrant.updateMany.mockResolvedValueOnce({ count: 1 });

    const result = await service.deduct('u1', new Prisma.Decimal('5.14'), 'cross-product usage', {
      productId: 'product-b',
      tokenUsageId: 'usage-product-b',
      allowNegativeBalance: true,
    });

    expect(result).toEqual({ success: true, balance: -14, balanceUsd: -0.14 });
    expect(prisma.balanceGrant.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ id: 'grant-product-a' }),
      data: expect.objectContaining({
        remainingAmountUsd: new Prisma.Decimal(0),
        remainingPaidAmountUsd: new Prisma.Decimal(0),
      }),
    }));
    expect(prisma.balanceConsumptionAllocation.create).toHaveBeenCalledTimes(2);
    expect(prisma.balanceConsumptionAllocation.create).toHaveBeenNthCalledWith(
      1,
      expect.objectContaining({
        data: expect.objectContaining({
          productId: 'product-b',
          balanceGrantId: 'grant-product-a',
          source: 'BALANCE_GRANT',
          amountUsd: new Prisma.Decimal(5),
        }),
      }),
    );
    expect(prisma.balanceConsumptionAllocation.create).toHaveBeenNthCalledWith(
      2,
      expect.objectContaining({
        data: expect.objectContaining({
          productId: 'product-b',
          source: 'NEGATIVE_BALANCE',
          amountUsd: new Prisma.Decimal('0.14'),
        }),
      }),
    );
    expect(prisma.balanceConsumptionAllocation.create).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ source: 'UNRECONCILED_GRANT' }),
      }),
    );
  });

  it('records an already-negative post-usage charge without creating a migration grant', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('u1', '-0.15345968');

    const result = await service.deduct('u1', new Prisma.Decimal('0.4381184'), 'post-usage-negative', {
      tokenUsageId: 'usage-already-negative',
      allowNegativeBalance: true,
    });

    expect(result.success).toBe(true);
    expect(result.balanceUsd).toBe(-0.59157808);
    expect(prisma.balanceGrant.create).not.toHaveBeenCalled();
    expect(prisma.balanceConsumptionAllocation.create).toHaveBeenCalledTimes(1);
    expect(prisma.balanceConsumptionAllocation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: 'NEGATIVE_BALANCE',
          amountUsd: new Prisma.Decimal('0.4381184'),
          tokenUsageId: 'usage-already-negative',
          recognizedRevenueUsd: new Prisma.Decimal(0),
          approvedCreditUsd: new Prisma.Decimal(0),
          unapprovedDebtUsd: new Prisma.Decimal('0.4381184'),
          fundingClassificationComplete: true,
        }),
      }),
    );
  });

  it('rolls back new debt when the database does not assign a ledger sequence', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('u1', '-0.15');
    prisma.balanceConsumptionAllocation.create.mockResolvedValueOnce({
      id: 'alloc-without-ledger-sequence',
      ledgerSequence: null,
    });

    await expect(service.deduct(
      'u1',
      new Prisma.Decimal('0.44'),
      'post-usage-sequence-proof',
      { tokenUsageId: 'usage-sequence-proof', allowNegativeBalance: true },
    )).rejects.toThrow('BALANCE_DEBT_LEDGER_SEQUENCE_MISSING_ON_CREATE');
  });

  it('keeps a non-due DIRTY grant consumable without minting a migration grant', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('u1', 5);
    prisma.billingAccount.findUniqueOrThrow.mockResolvedValue({
      id: 'ba_personal_u1',
      type: 'personal',
      status: 'active',
      balanceGrantLedgerStatus: 'LEGACY_DIRTY',
      balanceGrantLedgerVersion: 0,
      creditConfig: null,
    });
    const deferredGrant = {
      id: 'grant-dirty-not-due',
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      productId: null,
      orderId: 'order-old',
      source: 'RECHARGE',
      paidAmountUsd: new Prisma.Decimal(5),
      bonusAmountUsd: new Prisma.Decimal(0),
      grantedAmountUsd: new Prisma.Decimal(5),
      remainingAmountUsd: new Prisma.Decimal(5),
      remainingPaidAmountUsd: new Prisma.Decimal(5),
      remainingBonusAmountUsd: new Prisma.Decimal(0),
      discountRate: new Prisma.Decimal(1),
      validFrom: new Date('2024-01-01T00:00:00.000Z'),
      expiresAt: new Date('2027-01-01T00:00:00.000Z'),
      isExpired: false,
      createdAt: new Date('2024-01-01T00:00:00.000Z'),
      updatedAt: new Date('2024-01-01T00:00:00.000Z'),
    };
    prisma.balanceGrant.findMany
      .mockResolvedValueOnce([deferredGrant])
      .mockResolvedValueOnce([]);

    const result = await service.deduct('u1', new Prisma.Decimal(2), 'deferred-expiry-spend');

    expect(result).toEqual({ success: true, balance: 300, balanceUsd: 3 });
    expect(prisma.balanceGrantExpiry.create).not.toHaveBeenCalled();
    expect(prisma.balanceGrant.create).not.toHaveBeenCalled();
    expect(prisma.balanceGrant.updateMany.mock.calls[0][0].where).toEqual(
      expect.objectContaining({
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: new Date('2026-07-16T00:00:00.000Z') } },
        ],
      }),
    );
    expect(prisma.balanceConsumptionAllocation.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        balanceGrantId: deferredGrant.id,
        source: 'BALANCE_GRANT',
        amountUsd: new Prisma.Decimal(2),
      }),
    });
  });

  it('fails a DIRTY account closed when a positive grant is already due', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('u1', 5);
    prisma.billingAccount.findUniqueOrThrow.mockResolvedValue({
      id: 'ba_personal_u1',
      type: 'personal',
      status: 'active',
      balanceGrantLedgerStatus: 'LEGACY_DIRTY',
      balanceGrantLedgerVersion: 0,
      creditConfig: null,
    });
    prisma.balanceGrant.count.mockResolvedValueOnce(1);

    await expect(service.deduct(
      'u1',
      new Prisma.Decimal(2),
      'dirty-due-grant-must-not-spend',
    )).rejects.toThrow(
      'BALANCE_LEDGER_RECONCILIATION_REQUIRED:ba_personal_u1:'
      + 'unexpired positive grant is due at 2026-07-16T00:00:00.000Z',
    );

    expect(prisma.accountWallet.updateMany).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
    expect(prisma.balanceConsumptionAllocation.create).not.toHaveBeenCalled();
  });

  it('allows enterprise account spending up to configured credit and records credit allocation', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('ba_personal_u1', 0);
    configureEnterpriseBillingSubject(prisma, {
        limitUsd: new Prisma.Decimal(100),
        status: 'ACTIVE',
        termsDays: 30,
        effectiveAt: null,
        expiresAt: null,
    });

    const result = await service.deduct('u1', new Prisma.Decimal(20), 'enterprise API usage');

    expect(result).toEqual({ success: true, balance: 8000, balanceUsd: 80 });
    expect(prisma.balanceTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          amountUsd: new Prisma.Decimal(-20),
          balanceAfterUsd: new Prisma.Decimal(-20),
        }),
      }),
    );
    expect(prisma.balanceConsumptionAllocation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: 'ENTERPRISE_CREDIT',
          amountUsd: new Prisma.Decimal(20),
          approvedCreditUsd: new Prisma.Decimal(20),
          unapprovedDebtUsd: new Prisma.Decimal(0),
          fundingClassificationComplete: true,
          recognizedRevenueUsd: new Prisma.Decimal(0),
          bonusConsumedUsd: new Prisma.Decimal(0),
        }),
      }),
    );
    expect(prisma.balanceGrant.create).not.toHaveBeenCalled();
  });

  it('rejects enterprise spending beyond configured credit', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('ba_personal_u1', 0);
    configureEnterpriseBillingSubject(prisma, {
        limitUsd: new Prisma.Decimal(10),
        status: 'ACTIVE',
        termsDays: 30,
        effectiveAt: null,
        expiresAt: null,
    });

    const result = await service.deduct('u1', new Prisma.Decimal(20), 'enterprise overuse');

    expect(result).toEqual({ success: false, balance: 1000, balanceUsd: 10 });
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
    expect(prisma.balanceConsumptionAllocation.create).not.toHaveBeenCalled();
  });

  it('does not let the personal negative-balance option bypass enterprise credit', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('ba_personal_u1', 0);
    configureEnterpriseBillingSubject(prisma, {
      limitUsd: new Prisma.Decimal(10),
      status: 'ACTIVE',
      termsDays: 30,
      effectiveAt: null,
      expiresAt: null,
    });

    const result = await service.deduct('u1', new Prisma.Decimal(20), 'enterprise overuse', {
      allowNegativeBalance: true,
    });

    expect(result).toEqual({ success: false, balance: 1000, balanceUsd: 10 });
    expect(prisma.accountWallet.updateMany).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
  });

  it('fully records trusted delivered enterprise usage that crosses the credit floor', async () => {
    const { service, prisma, publisher } = await buildService(
      {},
      {},
      {},
      undefined,
      {},
    );
    prisma.__setWalletBalance('ba_personal_u1', '-0.9884351');
    configureEnterpriseBillingSubject(prisma, {
      limitUsd: new Prisma.Decimal(1),
      status: 'ACTIVE',
      termsDays: 30,
      effectiveAt: null,
      expiresAt: null,
    });
    const frozenFunding = installFrozenGatewayReservationForSettlement(prisma, {
      amountUsd: '0.044376',
      approvedCreditUsd: '0.0115649',
      unapprovedDebtUsd: '0.0328111',
      creditLimitUsd: 1,
      creditTermsDays: 30,
      requestId: 'req-enterprise-terminal-overage',
    });

    const result = await service.deduct(
      'u1',
      new Prisma.Decimal('0.044376'),
      'delivered enterprise API usage',
      {
        tokenUsageId: 'usage-enterprise-terminal-overage',
        ...frozenFunding.deductOptions,
      },
    );

    expect(result).toEqual({
      success: true,
      balance: -3,
      balanceUsd: -0.0328111,
    });
    expect(prisma.accountWallet.updateMany).toHaveBeenCalledWith({
      where: { billingAccountId: 'ba_personal_u1' },
      data: { balanceUsd: { decrement: new Prisma.Decimal('0.044376') } },
    });
    expect(prisma.balanceTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'CONSUME',
          amountUsd: new Prisma.Decimal('-0.044376'),
          balanceAfterUsd: new Prisma.Decimal('-1.0328111'),
          tokenUsageId: 'usage-enterprise-terminal-overage',
        }),
      }),
    );
    expect(prisma.balanceConsumptionAllocation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: 'ENTERPRISE_CREDIT',
          amountUsd: new Prisma.Decimal('0.0115649'),
          approvedCreditUsd: new Prisma.Decimal('0.0115649'),
          unapprovedDebtUsd: new Prisma.Decimal(0),
          fundingClassificationComplete: true,
          recognizedRevenueUsd: new Prisma.Decimal(0),
          bonusConsumedUsd: new Prisma.Decimal(0),
          tokenUsageId: 'usage-enterprise-terminal-overage',
        }),
      }),
    );
    expect(prisma.balanceConsumptionAllocation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: 'ENTERPRISE_CREDIT',
          amountUsd: new Prisma.Decimal('0.0328111'),
          approvedCreditUsd: new Prisma.Decimal(0),
          unapprovedDebtUsd: new Prisma.Decimal('0.0328111'),
          fundingClassificationComplete: true,
          creditTermsDays: null,
          creditDueAt: null,
          tokenUsageId: 'usage-enterprise-terminal-overage',
        }),
      }),
    );
    expect(publisher?.syncBillingAccountKeyBalances).toHaveBeenCalledWith('ba_personal_u1');
  });

  it('atomically records trusted zero-priced Gateway usage instead of bypassing terminal proof', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('ba_personal_u1', 25);
    configureEnterpriseBillingSubject(prisma, {
      limitUsd: new Prisma.Decimal(100),
      status: 'ACTIVE',
      termsDays: 30,
      effectiveAt: null,
      expiresAt: null,
    });
    const frozenFunding = installFrozenGatewayReservationForSettlement(prisma, {
      amountUsd: 0,
      approvedCreditUsd: 0,
      unapprovedDebtUsd: 0,
      creditLimitUsd: 100,
      creditTermsDays: 30,
      requestId: 'req-enterprise-zero-price',
    });
    const beforeBalanceTransaction = jest.fn(async () => ({
      tokenUsageId: 'usage-enterprise-zero-price',
    }));
    const afterBalanceTransaction = jest.fn();

    const result = await service.deduct(
      'u1',
      new Prisma.Decimal(0),
      'zero-priced delivered enterprise API usage',
      {
        ...frozenFunding.deductOptions,
        anchoredTenantId: 'tenant-1',
        anchoredBillingAccountId: 'ba_personal_u1',
        frozenGatewaySubject: {
          userId: 'u1',
          tenantId: 'tenant-1',
          billingAccountId: 'ba_personal_u1',
        },
        beforeBalanceTransaction,
        afterBalanceTransaction,
      },
    );

    expect(result).toEqual({ success: true, balance: 12500, balanceUsd: 125 });
    expect(prisma.$transaction).toHaveBeenCalled();
    expect(beforeBalanceTransaction).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({
        debtOpen: false,
        collectedUsd: new Prisma.Decimal(0),
        approvedCreditUsd: new Prisma.Decimal(0),
        unapprovedDebtUsd: new Prisma.Decimal(0),
      }),
    );
    expect(prisma.accountWallet.updateMany).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
    expect(prisma.balanceConsumptionAllocation.create).not.toHaveBeenCalled();
    expect(prisma.gatewayUsageFundingReservation.updateMany).toHaveBeenCalledWith({
      where: {
        id: frozenFunding.row.id,
        status: { in: ['ACTIVE', 'MANUAL_REVIEW'] },
      },
      data: {
        status: 'CONSUMED',
        authoritativeAmountUsd: new Prisma.Decimal(0),
        consumedAt: expect.any(Date),
        releasedAt: null,
        releaseReason: null,
      },
    });
    expect(afterBalanceTransaction).toHaveBeenCalledWith(
      prisma,
      expect.any(Object),
      expect.objectContaining({
        balanceTransactionId: null,
        tokenUsageId: 'usage-enterprise-zero-price',
        collectedUsd: new Prisma.Decimal(0),
        approvedCreditUsd: new Prisma.Decimal(0),
        unapprovedDebtUsd: new Prisma.Decimal(0),
      }),
    );
  });

  it('splits one terminal charge at the enterprise credit boundary using wallet before and after', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('ba_personal_u1', -90);
    configureEnterpriseBillingSubject(prisma, {
      limitUsd: new Prisma.Decimal(100),
      status: 'ACTIVE',
      termsDays: 30,
      effectiveAt: null,
      expiresAt: null,
    });
    const frozenFunding = installFrozenGatewayReservationForSettlement(prisma, {
      amountUsd: 20,
      approvedCreditUsd: 10,
      unapprovedDebtUsd: 10,
      creditLimitUsd: 100,
      creditTermsDays: 30,
      requestId: 'req-enterprise-credit-boundary',
    });
    const funding = jest.fn();

    const result = await service.deduct(
      'u1',
      new Prisma.Decimal(20),
      'enterprise credit boundary crossing',
      {
        ...frozenFunding.deductOptions,
        beforeBalanceTransaction: async (_db, context) => funding(context),
      },
    );

    expect(result).toEqual({ success: true, balance: -1000, balanceUsd: -10 });
    expect(funding).toHaveBeenCalledWith(expect.objectContaining({
      debtOpen: true,
      debtExposureUsd: new Prisma.Decimal(10),
      collectedUsd: new Prisma.Decimal(0),
      approvedCreditUsd: new Prisma.Decimal(10),
      unapprovedDebtUsd: new Prisma.Decimal(10),
    }));
    expect(prisma.balanceConsumptionAllocation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: 'ENTERPRISE_CREDIT',
          amountUsd: new Prisma.Decimal(10),
          approvedCreditUsd: new Prisma.Decimal(10),
          unapprovedDebtUsd: new Prisma.Decimal(0),
          fundingClassificationComplete: true,
          creditTermsDays: 30,
          creditDueAt: expect.any(Date),
        }),
      }),
    );
    expect(prisma.balanceConsumptionAllocation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: 'ENTERPRISE_CREDIT',
          amountUsd: new Prisma.Decimal(10),
          approvedCreditUsd: new Prisma.Decimal(0),
          unapprovedDebtUsd: new Prisma.Decimal(10),
          fundingClassificationComplete: true,
          creditTermsDays: null,
          creditDueAt: null,
        }),
      }),
    );
  });

  it('treats a zero-limit enterprise account like a personal account without terms', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('ba_personal_u1', 0);
    configureEnterpriseBillingSubject(prisma, {
      limitUsd: new Prisma.Decimal(0),
      status: 'ACTIVE',
      termsDays: 30,
      effectiveAt: null,
      expiresAt: null,
    });
    const frozenFunding = installFrozenGatewayReservationForSettlement(prisma, {
      amountUsd: 20,
      approvedCreditUsd: 0,
      unapprovedDebtUsd: 20,
      creditLimitUsd: 0,
      creditTermsDays: null,
      requestId: 'req-enterprise-no-credit',
    });
    const funding = jest.fn();

    const result = await service.deduct(
      'u1',
      new Prisma.Decimal(20),
      'enterprise without credit',
      {
        ...frozenFunding.deductOptions,
        beforeBalanceTransaction: async (_db, context) => funding(context),
      },
    );

    expect(result).toEqual({ success: true, balance: -2000, balanceUsd: -20 });
    expect(funding).toHaveBeenCalledWith(expect.objectContaining({
      debtOpen: true,
      debtExposureUsd: new Prisma.Decimal(20),
      collectedUsd: new Prisma.Decimal(0),
      approvedCreditUsd: new Prisma.Decimal(0),
      unapprovedDebtUsd: new Prisma.Decimal(20),
    }));
    expect(prisma.balanceConsumptionAllocation.create).toHaveBeenCalledTimes(1);
    expect(prisma.balanceConsumptionAllocation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: 'ENTERPRISE_CREDIT',
          amountUsd: new Prisma.Decimal(20),
          approvedCreditUsd: new Prisma.Decimal(0),
          unapprovedDebtUsd: new Prisma.Decimal(20),
          fundingClassificationComplete: true,
          creditTermsDays: null,
          creditDueAt: null,
        }),
      }),
    );
  });

  it('fails closed when the Gateway clock bound is missing or invalid', async () => {
    const previous = process.env.BILLING_GATEWAY_CLOCK_MAX_SKEW_MS;
    delete process.env.BILLING_GATEWAY_CLOCK_MAX_SKEW_MS;
    try {
      const missing = await buildService();
      expect((missing.service as any).resolveGatewayCreditPolicyWindow({
        gatewayStartAt: new Date('2026-07-01T00:00:00.000Z'),
        firstReceivedAt: new Date('2026-07-01T00:00:01.000Z'),
      })).toEqual(expect.objectContaining({ kind: 'UNAVAILABLE', reason: 'not_configured' }));

      const invalid = await buildService({}, {}, {}, undefined, undefined, 'usd', 'not-a-number');
      expect((invalid.service as any).resolveGatewayCreditPolicyWindow({
        gatewayStartAt: new Date('2026-07-01T00:00:00.000Z'),
        firstReceivedAt: new Date('2026-07-01T00:00:01.000Z'),
      })).toEqual(expect.objectContaining({ kind: 'UNAVAILABLE', reason: 'invalid' }));

      const zero = await buildService({}, {}, {}, undefined, undefined, 'usd', 0);
      expect((zero.service as any).resolveGatewayCreditPolicyWindow({
        gatewayStartAt: new Date('2026-07-01T00:00:00.000Z'),
        firstReceivedAt: new Date('2026-07-01T00:00:01.000Z'),
      })).toEqual(expect.objectContaining({ kind: 'UNAVAILABLE', reason: 'invalid' }));
    } finally {
      if (previous === undefined) {
        delete process.env.BILLING_GATEWAY_CLOCK_MAX_SKEW_MS;
      } else {
        process.env.BILLING_GATEWAY_CLOCK_MAX_SKEW_MS = previous;
      }
    }
  });

  it('reserves prepaid funds when the current enterprise credit config is absent and the Gateway clock bound is missing', async () => {
    await withMissingGatewayClockMaxSkew(async () => {
      const { service, prisma } = await buildService();
      prisma.__setWalletBalance('ba_personal_u1', 25);
      configureEnterpriseBillingSubject(prisma, null);
      prisma.balanceGrant.findMany.mockResolvedValue([{
        id: 'grant-enterprise-prepaid',
        remainingAmountUsd: new Prisma.Decimal(25),
      }]);

      const input = gatewayReservationInput(prisma, {
        amountUsd: 20,
        requestId: 'req-enterprise-prepaid-no-credit-history',
        occurredAt: new Date('2026-07-01T00:00:00.000Z'),
        firstReceivedAt: new Date('2026-07-01T00:00:01.000Z'),
      });
      const reservation = await service.reserveGatewayBalanceFunding(input);

      expect(reservation).toEqual(expect.objectContaining({
        collectedUsd: new Prisma.Decimal(20),
        approvedCreditUsd: new Prisma.Decimal(0),
        unapprovedDebtUsd: new Prisma.Decimal(0),
      }));
      expect(prisma.billingAccountCreditEvent.findFirst).not.toHaveBeenCalled();
      const accountLockCallIndex = prisma.$queryRaw.mock.calls.findIndex(([query]: any[]) => {
        const sql = Array.isArray(query) ? query.join('') : String(query);
        return sql.includes('FROM "billing_accounts"') && sql.includes('FOR UPDATE');
      });
      expect(accountLockCallIndex).toBeGreaterThanOrEqual(0);
      expect(prisma.$queryRaw.mock.invocationCallOrder[accountLockCallIndex]).toBeLessThan(
        prisma.billingAccount.findUnique.mock.invocationCallOrder.at(-1),
      );
      expect(prisma.gatewayUsageFundingReservation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          creditPolicyEventId: null,
          creditPolicyRevision: null,
          creditPolicySource: 'CURRENT_PREPAID',
          creditPolicyReconstructible: true,
          creditConfiguredLimitUsd: new Prisma.Decimal(0),
          creditLimitUsd: new Prisma.Decimal(0),
          creditTermsDays: null,
          approvedCreditDueAt: null,
          collectedUsd: new Prisma.Decimal(20),
          approvedCreditUsd: new Prisma.Decimal(0),
          unapprovedDebtUsd: new Prisma.Decimal(0),
        }),
      });
      expect(prisma.gatewayUsageFundingReservationGrant.createMany).toHaveBeenCalledWith({
        data: [{
          fundingReservationId: 'reservation-1',
          gatewayBillingEventId: input.gatewayBillingEventId,
          balanceGrantId: 'grant-enterprise-prepaid',
          amountUsd: new Prisma.Decimal(20),
          allocationOrder: 0,
          createdAt: new Date('2026-07-16T00:00:00.000Z'),
        }],
      });
    });
  });

  it('uses prepaid funding when the current enterprise credit config is disabled', async () => {
    await withMissingGatewayClockMaxSkew(async () => {
      const { service, prisma } = await buildService();
      prisma.__setWalletBalance('ba_personal_u1', 25);
      configureEnterpriseBillingSubject(prisma, {
        limitUsd: new Prisma.Decimal(0),
        status: 'DISABLED',
        policyRevision: 1,
        policyEffectiveBoundaryAt: new Date('2026-06-01T00:00:00.000Z'),
        policyBoundaryComplete: true,
        termsDays: null,
        effectiveAt: null,
        expiresAt: null,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        updatedAt: new Date('2026-06-01T00:00:00.000Z'),
      });
      prisma.balanceGrant.findMany.mockResolvedValue([{
        id: 'grant-enterprise-disabled-credit',
        remainingAmountUsd: new Prisma.Decimal(25),
      }]);

      const reservation = await service.reserveGatewayBalanceFunding(gatewayReservationInput(prisma, {
        amountUsd: 20,
        requestId: 'req-enterprise-disabled-credit-prepaid',
      }));

      expect(reservation).toEqual(expect.objectContaining({
        collectedUsd: new Prisma.Decimal(20),
        approvedCreditUsd: new Prisma.Decimal(0),
        unapprovedDebtUsd: new Prisma.Decimal(0),
      }));
      expect(prisma.gatewayUsageFundingReservation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          creditPolicySource: 'CURRENT_PREPAID',
          creditPolicyEventId: null,
          creditPolicyRevision: null,
          creditConfiguredLimitUsd: new Prisma.Decimal(0),
          creditLimitUsd: new Prisma.Decimal(0),
          creditTermsDays: null,
          approvedCreditDueAt: null,
        }),
      });
    });
  });

  it('ignores credit history when the current enterprise credit config is absent', async () => {
    await withMissingGatewayClockMaxSkew(async () => {
      const { service, prisma } = await buildService();
      prisma.__setWalletBalance('ba_personal_u1', 25);
      configureEnterpriseBillingSubject(prisma, null);
      prisma.billingAccountCreditEvent.findFirst.mockResolvedValue({
        id: 'legacy-credit-event-without-revision',
        policyRevision: null,
      });
      prisma.balanceGrant.findMany.mockResolvedValue([{
        id: 'grant-enterprise-history-ignored',
        remainingAmountUsd: new Prisma.Decimal(25),
      }]);

      const reservation = await service.reserveGatewayBalanceFunding(gatewayReservationInput(prisma, {
        amountUsd: 20,
        requestId: 'req-enterprise-credit-history-ignored',
      }));

      expect(reservation).toEqual(expect.objectContaining({
        collectedUsd: new Prisma.Decimal(20),
        approvedCreditUsd: new Prisma.Decimal(0),
        unapprovedDebtUsd: new Prisma.Decimal(0),
      }));
      expect(prisma.billingAccountCreditEvent.findFirst).not.toHaveBeenCalled();
      expect(prisma.gatewayUsageFundingReservation.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          creditPolicySource: 'CURRENT_PREPAID',
          creditPolicyEventId: null,
          creditPolicyRevision: null,
          creditConfiguredLimitUsd: new Prisma.Decimal(0),
          creditLimitUsd: new Prisma.Decimal(0),
        }),
      });
    });
  });

  it('keeps a currently active enterprise credit config fail-closed without a Gateway clock bound', async () => {
    await withMissingGatewayClockMaxSkew(async () => {
      const { service, prisma } = await buildService();
      prisma.__setWalletBalance('ba_personal_u1', 25);
      configureEnterpriseBillingSubject(prisma, {
        limitUsd: new Prisma.Decimal(100),
        status: 'ACTIVE',
        policyRevision: 1,
        policyEffectiveBoundaryAt: new Date('2026-06-01T00:00:00.000Z'),
        policyBoundaryComplete: true,
        termsDays: 30,
        effectiveAt: null,
        expiresAt: null,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
        updatedAt: new Date('2026-06-01T00:00:00.000Z'),
      });

      await expect(service.reserveGatewayBalanceFunding(gatewayReservationInput(prisma, {
        amountUsd: 20,
        requestId: 'req-enterprise-active-credit-unbounded-clock',
      }))).rejects.toBeInstanceOf(EnterpriseCreditPolicyPendingError);

      expect(prisma.gatewayUsageFundingReservation.create).not.toHaveBeenCalled();
      expect(prisma.gatewayUsageFundingReservationGrant.createMany).not.toHaveBeenCalled();
    });
  });

  it('keeps a long-running or delayed-delivery request bounded by the signed start clock', async () => {
    const { service } = await buildService({}, {}, {}, undefined, undefined, 'usd', 1_000);

    expect((service as any).resolveGatewayCreditPolicyWindow({
      gatewayStartAt: new Date('2026-07-01T00:00:00.000Z'),
      firstReceivedAt: new Date('2026-07-01T01:00:00.000Z'),
    })).toEqual({
      kind: 'BOUNDED',
      earliestAt: new Date('2026-06-30T23:59:59.000Z'),
      latestAt: new Date('2026-07-01T00:00:01.000Z'),
    });
  });

  it('fails closed only when the Gateway fast-clock bound makes the receipt window empty', async () => {
    const { service } = await buildService({}, {}, {}, undefined, undefined, 'usd', 1_000);

    expect((service as any).resolveGatewayCreditPolicyWindow({
      gatewayStartAt: new Date('2026-07-01T00:00:10.000Z'),
      firstReceivedAt: new Date('2026-07-01T00:00:00.000Z'),
    })).toEqual(expect.objectContaining({
      kind: 'UNAVAILABLE',
      reason: 'fast_out_of_bounds',
    }));
  });

  it('uses credit only when the whole clock window has one revision and freezes dueAt at its upper bound', async () => {
    const { service, prisma } = await buildService(
      {},
      {},
      {},
      undefined,
      undefined,
      'usd',
      1_000,
    );
    const gatewayStartAt = new Date('2026-07-05T00:00:00.000Z');
    const firstReceivedAt = new Date('2026-07-05T01:00:00.000Z');
    const boundaryAt = new Date('2026-06-01T00:00:00.000Z');
    prisma.__setWalletBalance('ba_personal_u1', 0);
    configureEnterpriseBillingSubject(prisma, {
      limitUsd: new Prisma.Decimal(100),
      status: 'ACTIVE',
      policyRevision: 1,
      policyEffectiveBoundaryAt: boundaryAt,
      policyBoundaryComplete: true,
      termsDays: 10,
      effectiveAt: null,
      expiresAt: null,
      createdAt: boundaryAt,
      updatedAt: boundaryAt,
    });
    mockEnterpriseCreditBoundaries(prisma, {
      latest: {
        policyRevision: 1,
        policyEffectiveBoundaryAt: boundaryAt,
        newLimitUsd: new Prisma.Decimal(100),
        newStatus: 'ACTIVE',
        newTermsDays: 10,
        newEffectiveAt: null,
        newExpiresAt: null,
        temporalSnapshotComplete: true,
      },
    });

    const reservationInput = gatewayReservationInput(prisma, {
      amountUsd: 20,
      requestId: 'req-bounded-credit-window',
      occurredAt: gatewayStartAt,
      firstReceivedAt,
    });
    const reservation = await service.reserveGatewayBalanceFunding(reservationInput);
    const frozenFunding = installCreatedGatewayReservationForSettlement(
      prisma,
      reservationInput,
    );
    const result = await service.deduct(
      'u1',
      new Prisma.Decimal(20),
      'bounded occurrence window',
      {
        ...frozenFunding.deductOptions,
      },
    );

    expect(reservation).toEqual(expect.objectContaining({
      approvedCreditUsd: new Prisma.Decimal(20),
      unapprovedDebtUsd: new Prisma.Decimal(0),
    }));
    expect(frozenFunding.row).toEqual(expect.objectContaining({
      creditPolicyAt: new Date('2026-07-05T00:00:01.000Z'),
      approvedCreditDueAt: new Date('2026-07-15T00:00:01.000Z'),
    }));
    expect(result).toEqual({ success: true, balance: 8000, balanceUsd: 80 });
    expect(prisma.balanceConsumptionAllocation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          creditPolicyAt: new Date('2026-07-05T00:00:01.000Z'),
          creditTermsDays: 10,
          creditDueAt: new Date('2026-07-15T00:00:01.000Z'),
          creditPolicySnapshotComplete: true,
        }),
      }),
    );
  });

  it('fails closed when the possible clock interval crosses a policy revision', async () => {
    const { service, prisma } = await buildService(
      {},
      {},
      {},
      undefined,
      undefined,
      'usd',
      1_000,
    );
    const gatewayStartAt = new Date('2026-07-05T00:00:00.000Z');
    const decisionAt = new Date('2026-07-04T23:59:59.500Z');
    const boundaryAt = new Date('2026-07-05T00:00:00.500Z');
    prisma.__setWalletBalance('ba_personal_u1', 0);
    configureEnterpriseBillingSubject(prisma, {
      limitUsd: new Prisma.Decimal(200),
      status: 'ACTIVE',
      policyRevision: 2,
      policyEffectiveBoundaryAt: boundaryAt,
      policyBoundaryComplete: true,
      termsDays: 20,
      effectiveAt: null,
      expiresAt: null,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      updatedAt: boundaryAt,
    });
    const future = {
      policyRevision: 2,
      oldLimitUsd: new Prisma.Decimal(100),
      oldStatus: 'ACTIVE',
      oldTermsDays: 10,
      oldEffectiveAt: null,
      oldExpiresAt: null,
      temporalSnapshotComplete: true,
    };
    const latest = {
      policyRevision: 2,
      policyEffectiveBoundaryAt: boundaryAt,
      newLimitUsd: new Prisma.Decimal(200),
      newStatus: 'ACTIVE',
      newTermsDays: 20,
      newEffectiveAt: null,
      newExpiresAt: null,
      temporalSnapshotComplete: true,
    };
    prisma.billingAccountCreditEvent.findFirst.mockImplementation(({ where }: any) => {
      if (where?.policyBoundaryComplete === false) return Promise.resolve(null);
      if (where?.policyDecisionAt?.lte && where?.policyEffectiveBoundaryAt?.gt) {
        return Promise.resolve(null);
      }
      if (where?.policyDecisionAt?.gt) {
        return Promise.resolve(
          where.policyDecisionAt.gt.getTime() < decisionAt.getTime() ? future : null,
        );
      }
      if (where?.policyEffectiveBoundaryAt?.lte) {
        return Promise.resolve(
          where.policyEffectiveBoundaryAt.lte.getTime() >= boundaryAt.getTime() ? latest : null,
        );
      }
      return Promise.resolve(null);
    });
    const reservationInput = gatewayReservationInput(prisma, {
      amountUsd: 20,
      requestId: 'req-crossing-credit-window',
      occurredAt: gatewayStartAt,
      firstReceivedAt: new Date('2026-07-05T01:00:00.000Z'),
    });
    await expect(service.reserveGatewayBalanceFunding(reservationInput))
      .rejects.toBeInstanceOf(EnterpriseCreditPolicyPendingError);

    expect(prisma.accountWallet.updateMany).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
    expect(prisma.balanceConsumptionAllocation.create).not.toHaveBeenCalled();
    expect(prisma.gatewayUsageFundingReservation.create).not.toHaveBeenCalled();
  });

  it('does not fund delayed terminal usage with enterprise credit granted after occurrence', async () => {
    const { service, prisma } = await buildService(
      {},
      {},
      {},
      undefined,
      undefined,
      'usd',
      1_000,
    );
    const occurredAt = new Date('2026-07-01T00:00:00.000Z');
    prisma.__setWalletBalance('ba_personal_u1', 0);
    configureEnterpriseBillingSubject(prisma, {
      limitUsd: new Prisma.Decimal(100),
      status: 'ACTIVE',
      policyRevision: 1,
      policyEffectiveBoundaryAt: new Date('2026-07-10T00:00:01.000Z'),
      policyBoundaryComplete: true,
      termsDays: 30,
      effectiveAt: new Date('2026-07-10T00:00:00.000Z'),
      expiresAt: null,
      createdAt: new Date('2026-07-10T00:00:00.000Z'),
      updatedAt: new Date('2026-07-10T00:00:00.000Z'),
    });
    mockEnterpriseCreditBoundaries(prisma, {
      future: {
        policyRevision: 1,
        oldLimitUsd: null,
        oldStatus: null,
        oldTermsDays: null,
        oldEffectiveAt: null,
        oldExpiresAt: null,
        temporalSnapshotComplete: true,
      },
    });
    const funding = jest.fn();
    const settled = jest.fn();
    const reservationInput = gatewayReservationInput(prisma, {
      amountUsd: 20,
      requestId: 'req-before-credit-grant',
      occurredAt,
      firstReceivedAt: occurredAt,
    });
    const reservation = await service.reserveGatewayBalanceFunding(reservationInput);
    const frozenFunding = installCreatedGatewayReservationForSettlement(
      prisma,
      reservationInput,
    );

    const result = await service.deduct(
      'u1',
      new Prisma.Decimal(20),
      'delayed usage before credit grant',
      {
        ...frozenFunding.deductOptions,
        beforeBalanceTransaction: async (_db, context) => {
          funding(context);
        },
        afterBalanceTransaction: async (_db, _snapshot, context) => {
          settled(context.fundingPolicy);
        },
      },
    );

    expect(reservation).toEqual(expect.objectContaining({
      approvedCreditUsd: new Prisma.Decimal(0),
      unapprovedDebtUsd: new Prisma.Decimal(20),
    }));
    expect(result).toEqual({ success: true, balance: 8000, balanceUsd: 80 });
    expect(funding).toHaveBeenCalledWith(expect.objectContaining({
      debtOpen: true,
      debtExposureUsd: new Prisma.Decimal(20),
      collectedUsd: new Prisma.Decimal(0),
      approvedCreditUsd: new Prisma.Decimal(0),
      unapprovedDebtUsd: new Prisma.Decimal(20),
    }));
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({
      limitUsd: new Prisma.Decimal(0),
      termsDays: null,
      policyAt: occurredAt,
      source: 'NO_CONFIG',
      reconstructible: true,
    }));
    expect(prisma.balanceConsumptionAllocation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: 'ENTERPRISE_CREDIT',
          amountUsd: new Prisma.Decimal(20),
          approvedCreditUsd: new Prisma.Decimal(0),
          unapprovedDebtUsd: new Prisma.Decimal(20),
          fundingClassificationComplete: true,
          creditPolicyAt: occurredAt,
          creditTermsDays: null,
          creditDueAt: null,
          creditPolicySnapshotComplete: true,
        }),
      }),
    );
  });

  it('uses the current suspension as zero-credit prepaid despite earlier active history', async () => {
    const { service, prisma } = await buildService(
      {},
      {},
      {},
      undefined,
      undefined,
      'usd',
      1_000,
    );
    const occurredAt = new Date('2026-07-01T00:00:00.000Z');
    const oldEffectiveAt = new Date('2026-06-01T00:00:00.000Z');
    const oldExpiresAt = new Date('2026-08-01T00:00:00.000Z');
    prisma.__setWalletBalance('ba_personal_u1', 0);
    configureEnterpriseBillingSubject(prisma, {
      limitUsd: new Prisma.Decimal(100),
      status: 'SUSPENDED',
      policyRevision: 2,
      policyEffectiveBoundaryAt: new Date('2026-07-10T00:00:01.000Z'),
      policyBoundaryComplete: true,
      termsDays: 7,
      effectiveAt: oldEffectiveAt,
      expiresAt: oldExpiresAt,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      updatedAt: new Date('2026-07-10T00:00:00.000Z'),
    });
    mockEnterpriseCreditBoundaries(prisma, {
      future: {
        policyRevision: 2,
        oldLimitUsd: new Prisma.Decimal(100),
        oldStatus: 'ACTIVE',
        oldTermsDays: 30,
        oldEffectiveAt,
        oldExpiresAt,
        temporalSnapshotComplete: true,
      },
    });
    const funding = jest.fn();
    const settled = jest.fn();
    const reservationInput = gatewayReservationInput(prisma, {
      amountUsd: 20,
      requestId: 'req-before-credit-suspension',
      occurredAt,
      firstReceivedAt: occurredAt,
    });
    const reservation = await service.reserveGatewayBalanceFunding(reservationInput);
    const frozenFunding = installCreatedGatewayReservationForSettlement(
      prisma,
      reservationInput,
    );

    const result = await service.deduct(
      'u1',
      new Prisma.Decimal(20),
      'delayed usage before suspension',
      {
        ...frozenFunding.deductOptions,
        beforeBalanceTransaction: async (_db, context) => {
          funding(context);
        },
        afterBalanceTransaction: async (_db, _snapshot, context) => {
          settled(context.fundingPolicy);
        },
      },
    );

    expect(reservation).toEqual(expect.objectContaining({
      approvedCreditUsd: new Prisma.Decimal(0),
      unapprovedDebtUsd: new Prisma.Decimal(20),
    }));
    expect(result).toEqual({ success: true, balance: -2000, balanceUsd: -20 });
    expect(funding).toHaveBeenCalledWith(expect.objectContaining({
      debtOpen: true,
      debtExposureUsd: new Prisma.Decimal(20),
      collectedUsd: new Prisma.Decimal(0),
      approvedCreditUsd: new Prisma.Decimal(0),
      unapprovedDebtUsd: new Prisma.Decimal(20),
    }));
    expect(settled).toHaveBeenCalledWith(expect.objectContaining({
      limitUsd: new Prisma.Decimal(0),
      status: null,
      termsDays: null,
      effectiveAt: null,
      expiresAt: null,
      policyAt: occurredAt,
      source: 'CURRENT_PREPAID',
      reconstructible: true,
    }));
    expect(prisma.billingAccountCreditEvent.findFirst).not.toHaveBeenCalled();
    expect(prisma.balanceConsumptionAllocation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: 'ENTERPRISE_CREDIT',
          amountUsd: new Prisma.Decimal(20),
          approvedCreditUsd: new Prisma.Decimal(0),
          unapprovedDebtUsd: new Prisma.Decimal(20),
          fundingClassificationComplete: true,
          creditPolicyAt: occurredAt,
          creditTermsDays: null,
          creditDueAt: null,
          creditPolicySnapshotComplete: true,
        }),
      }),
    );
  });

  it('fails closed inside the decision-to-confirmed visibility gap', async () => {
    const { service, prisma } = await buildService(
      {},
      {},
      {},
      undefined,
      undefined,
      'usd',
      1_000,
    );
    const occurredAt = new Date('2026-07-10T00:00:00.500Z');
    prisma.__setWalletBalance('ba_personal_u1', 0);
    configureEnterpriseBillingSubject(prisma, {
      limitUsd: new Prisma.Decimal(100),
      status: 'ACTIVE',
      policyRevision: 1,
      policyEffectiveBoundaryAt: new Date('2026-07-10T00:00:01.000Z'),
      policyBoundaryComplete: true,
      termsDays: 30,
      effectiveAt: null,
      expiresAt: null,
      createdAt: new Date('2026-07-10T00:00:00.000Z'),
      updatedAt: new Date('2026-07-10T00:00:00.000Z'),
    });
    mockEnterpriseCreditBoundaries(prisma, {
      overlap: { id: 'evt-gap-rev1' },
    });
    const reservationInput = gatewayReservationInput(prisma, {
      amountUsd: 20,
      requestId: 'req-credit-visibility-gap',
      occurredAt,
      firstReceivedAt: occurredAt,
    });
    await expect(service.reserveGatewayBalanceFunding(reservationInput))
      .rejects.toBeInstanceOf(EnterpriseCreditPolicyPendingError);

    expect(prisma.accountWallet.updateMany).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
    expect(prisma.balanceConsumptionAllocation.create).not.toHaveBeenCalled();
    expect(prisma.gatewayUsageFundingReservation.create).not.toHaveBeenCalled();
  });

  it('honors credit that was unexpired at occurrence even when settlement runs after expiry', async () => {
    const { service, prisma } = await buildService(
      {},
      {},
      {},
      undefined,
      undefined,
      'usd',
      1_000,
    );
    const occurredAt = new Date('2026-07-05T00:00:00.000Z');
    prisma.__setWalletBalance('ba_personal_u1', 0);
    configureEnterpriseBillingSubject(prisma, {
      limitUsd: new Prisma.Decimal(100),
      status: 'ACTIVE',
      policyRevision: 1,
      policyEffectiveBoundaryAt: new Date('2026-06-01T00:00:00.000Z'),
      policyBoundaryComplete: true,
      termsDays: 10,
      effectiveAt: new Date('2026-06-01T00:00:00.000Z'),
      expiresAt: new Date('2026-07-10T00:00:00.000Z'),
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      updatedAt: new Date('2026-06-01T00:00:00.000Z'),
    });
    mockEnterpriseCreditBoundaries(prisma, {
      latest: {
        policyRevision: 1,
        policyEffectiveBoundaryAt: new Date('2026-06-01T00:00:00.000Z'),
        newLimitUsd: new Prisma.Decimal(100),
        newStatus: 'ACTIVE',
        newTermsDays: 10,
        newEffectiveAt: new Date('2026-06-01T00:00:00.000Z'),
        newExpiresAt: new Date('2026-07-10T00:00:00.000Z'),
        temporalSnapshotComplete: true,
      },
    });

    const reservationInput = gatewayReservationInput(prisma, {
      amountUsd: 20,
      requestId: 'req-before-credit-expiry',
      occurredAt,
      firstReceivedAt: occurredAt,
    });
    const reservation = await service.reserveGatewayBalanceFunding(reservationInput);
    const frozenFunding = installCreatedGatewayReservationForSettlement(
      prisma,
      reservationInput,
    );
    const result = await service.deduct(
      'u1',
      new Prisma.Decimal(20),
      'delayed usage settled after credit expiry',
      {
        ...frozenFunding.deductOptions,
      },
    );

    expect(reservation).toEqual(expect.objectContaining({
      approvedCreditUsd: new Prisma.Decimal(20),
      unapprovedDebtUsd: new Prisma.Decimal(0),
    }));
    expect(result).toEqual({ success: true, balance: -2000, balanceUsd: -20 });
    expect(prisma.balanceConsumptionAllocation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: 'ENTERPRISE_CREDIT',
          creditPolicyAt: occurredAt,
          creditTermsDays: 10,
          creditDueAt: new Date('2026-07-15T00:00:00.000Z'),
        }),
      }),
    );
  });

  it('fails closed when a delayed settlement crosses an incomplete legacy credit event', async () => {
    const { service, prisma } = await buildService(
      {},
      {},
      {},
      undefined,
      undefined,
      'usd',
      1_000,
    );
    const occurredAt = new Date('2026-07-01T00:00:00.000Z');
    prisma.__setWalletBalance('ba_personal_u1', 0);
    configureEnterpriseBillingSubject(prisma, {
      limitUsd: new Prisma.Decimal(100),
      status: 'ACTIVE',
      policyRevision: 1,
      policyEffectiveBoundaryAt: null,
      policyBoundaryComplete: false,
      termsDays: 30,
      effectiveAt: null,
      expiresAt: null,
      createdAt: new Date('2026-06-01T00:00:00.000Z'),
      updatedAt: new Date('2026-07-10T00:00:00.000Z'),
    });
    mockEnterpriseCreditBoundaries(prisma, {
      incomplete: { id: 'legacy-incomplete' },
    });
    const reservationInput = gatewayReservationInput(prisma, {
      amountUsd: 20,
      requestId: 'req-incomplete-credit-history',
      occurredAt,
      firstReceivedAt: occurredAt,
    });
    await expect(service.reserveGatewayBalanceFunding(reservationInput))
      .rejects.toBeInstanceOf(EnterpriseCreditPolicyPendingError);

    expect(prisma.accountWallet.updateMany).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
    expect(prisma.balanceConsumptionAllocation.create).not.toHaveBeenCalled();
    expect(prisma.gatewayUsageFundingReservation.create).not.toHaveBeenCalled();
  });

  it('uses the locked financial clock when enterprise credit expires between preflight and ledger time', async () => {
    jest.useFakeTimers().setSystemTime(new Date('2026-07-15T00:00:00.000Z'));
    try {
      const { service, prisma } = await buildService();
      prisma.__setWalletBalance('ba_personal_u1', 0);
      configureEnterpriseBillingSubject(prisma, {
        limitUsd: new Prisma.Decimal(10),
        status: 'ACTIVE',
        termsDays: 30,
        effectiveAt: null,
        expiresAt: new Date('2026-07-15T12:00:00.000Z'),
      });

      const result = await service.deduct('u1', new Prisma.Decimal(5), 'expired-at-ledger-time');

      expect(result).toEqual({ success: false, balance: 1000, balanceUsd: 10 });
      expect(prisma.accountWallet.updateMany).not.toHaveBeenCalled();
      expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('locks credit config row and splits allocation by post-decrement wallet balance', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('ba_personal_u1', 5);
    configureEnterpriseBillingSubject(prisma, {
        limitUsd: new Prisma.Decimal(100),
        status: 'ACTIVE',
        termsDays: 30,
        effectiveAt: null,
        expiresAt: null,
    });

    const result = await service.deduct('u1', new Prisma.Decimal(20), 'enterprise partial credit');

    expect(result.success).toBe(true);
    // 事务内必须先对 credit config 行加 FOR UPDATE 锁（并发下调额度防护）。
    expect(prisma.$queryRaw).toHaveBeenCalled();
    // 钱包 5 → -15：余额出资 5，信用出资 15（按扣减后余额计算，而非快照余额）。
    expect(prisma.balanceConsumptionAllocation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: 'ENTERPRISE_CREDIT',
          amountUsd: new Prisma.Decimal(15),
          approvedCreditUsd: new Prisma.Decimal(15),
          unapprovedDebtUsd: new Prisma.Decimal(0),
          fundingClassificationComplete: true,
        }),
      }),
    );
    expect(prisma.balanceGrant.create).not.toHaveBeenCalled();
    expect(prisma.balanceConsumptionAllocation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: 'UNRECONCILED_GRANT',
          amountUsd: new Prisma.Decimal(5),
          recognizedRevenueUsd: new Prisma.Decimal(0),
          approvedCreditUsd: new Prisma.Decimal(0),
          unapprovedDebtUsd: new Prisma.Decimal(0),
          fundingClassificationComplete: true,
        }),
      }),
    );
  });

  it('settles enterprise credit FIFO on recharge and shrinks grant remaining by hole-fill', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('ba_personal_u1', -30);
    configureEnterpriseBillingSubject(prisma, {
        limitUsd: new Prisma.Decimal(100),
        status: 'ACTIVE',
        termsDays: 30,
        effectiveAt: null,
        expiresAt: null,
    });
    prisma.balanceConsumptionAllocation.findMany.mockResolvedValueOnce([
      { id: 'alloc-old', amountUsd: new Prisma.Decimal(20), settledUsd: new Prisma.Decimal(0) },
      { id: 'alloc-new', amountUsd: new Prisma.Decimal(10), settledUsd: new Prisma.Decimal(0) },
    ]);

    await service.rechargeWithBonus('u1', 5000, 0, '企业还款充值', 'order-repay');

    expect(prisma.balanceConsumptionAllocation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        orderBy: [{ ledgerSequence: 'asc' }, { id: 'asc' }],
      }),
    );
    // FIFO 全额核销两笔信用消费，实付确认收入。
    expect(prisma.__debtSettlementWrites()).toEqual([
      {
        id: 'alloc-old',
        applyUsd: new Prisma.Decimal(20),
        applyPaidUsd: new Prisma.Decimal(20),
        applyBonusUsd: new Prisma.Decimal(0),
        markSettled: true,
      },
      {
        id: 'alloc-new',
        applyUsd: new Prisma.Decimal(10),
        applyPaidUsd: new Prisma.Decimal(10),
        applyBonusUsd: new Prisma.Decimal(0),
        markSettled: true,
      },
    ]);
    expect(prisma.enterpriseCreditSettlement.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          allocationId: 'alloc-old',
          trigger: 'FUNDING',
          amountUsd: new Prisma.Decimal(20),
          paidUsd: new Prisma.Decimal(20),
          bonusUsd: new Prisma.Decimal(0),
        }),
      ]),
    });
    expect(prisma.enterpriseCreditSettlement.createMany.mock.calls
      .reduce((n: number, [arg]: any[]) => n + arg.data.length, 0)).toBe(2);
    // 充值 50，其中 30 用于还款填坑 → grant 可消费余额只剩 20。
    expect(prisma.balanceGrant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderId: 'order-repay',
          grantedAmountUsd: new Prisma.Decimal(50),
          remainingAmountUsd: new Prisma.Decimal(20),
        }),
      }),
    );
  });

  it('repays unapproved enterprise debt before approved credit and releases its BALANCE restriction', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('ba_personal_u1', -90);
    configureEnterpriseBillingSubject(prisma, {
      limitUsd: new Prisma.Decimal(100),
      status: 'ACTIVE',
      termsDays: 30,
      effectiveAt: null,
      expiresAt: null,
    });
    const frozenFunding = installFrozenGatewayReservationForSettlement(prisma, {
      amountUsd: 20,
      approvedCreditUsd: 10,
      unapprovedDebtUsd: 10,
      creditLimitUsd: 100,
      creditTermsDays: 30,
      requestId: 'req-enterprise-repayment-boundary',
    });

    await service.deduct(
      'u1',
      new Prisma.Decimal(20),
      'enterprise credit boundary crossing',
      {
        tokenUsageId: 'usage-boundary-debt',
        ...frozenFunding.deductOptions,
      },
    );

    const allocationCreates = prisma.balanceConsumptionAllocation.create.mock.calls
      .map(([call]: any[]) => call.data);
    const approvedCreate = allocationCreates.find((allocation: any) => (
      new Prisma.Decimal(allocation.approvedCreditUsd).eq(10)
    ));
    const unapprovedCreate = allocationCreates.find((allocation: any) => (
      new Prisma.Decimal(allocation.unapprovedDebtUsd).eq(10)
    ));
    expect(approvedCreate).toEqual(expect.objectContaining({
      amountUsd: new Prisma.Decimal(10),
      fundingClassificationComplete: true,
    }));
    expect(unapprovedCreate).toEqual(expect.objectContaining({
      amountUsd: new Prisma.Decimal(10),
      fundingClassificationComplete: true,
    }));

    prisma.balanceConsumptionAllocation.findMany.mockReset();
    const approvedAllocation = {
      id: 'alloc-approved-boundary',
      amountUsd: new Prisma.Decimal(10),
      settledUsd: new Prisma.Decimal(0),
      approvedCreditUsd: new Prisma.Decimal(10),
      unapprovedDebtUsd: new Prisma.Decimal(0),
      fundingClassificationComplete: true,
    };
    const unapprovedAllocation = {
      id: 'alloc-unapproved-boundary',
      amountUsd: new Prisma.Decimal(10),
      settledUsd: new Prisma.Decimal(0),
      approvedCreditUsd: new Prisma.Decimal(0),
      unapprovedDebtUsd: new Prisma.Decimal(10),
      fundingClassificationComplete: true,
    };
    prisma.balanceConsumptionAllocation.findMany.mockImplementation(
      async ({ where }: { where: Record<string, unknown> }) => {
        if ('unapprovedDebtUsd' in where) return [unapprovedAllocation];
        if ('approvedCreditUsd' in where) return [approvedAllocation];
        return [];
      },
    );
    prisma.balanceConsumptionAllocation.update.mockClear();
    prisma.enterpriseCreditSettlement.create.mockClear();
    prisma.$queryRaw.mockClear();
    const ledgerInvariantAssertion = jest.spyOn(
      service as any,
      'assertReconciledBalanceLedgerSnapshot',
    );
    prisma.billingAccessRestriction.findMany.mockResolvedValueOnce([{
      id: 'restriction-boundary-debt',
      gatewayBillingEvent: {
        tokenUsage: {
          consumptionAllocations: [
            {
              fundingClassificationComplete: true,
              unapprovedDebtUsd: new Prisma.Decimal(0),
              settledUsd: new Prisma.Decimal(0),
            },
            {
              fundingClassificationComplete: true,
              unapprovedDebtUsd: new Prisma.Decimal(10),
              settledUsd: new Prisma.Decimal(10),
            },
          ],
        },
      },
    }]);
    prisma.billingAccessRestriction.updateMany.mockClear();

    await service.rechargeWithBonus('u1', 1000, 0, '超额欠款还款', 'order-boundary-repay');

    expect(prisma.balanceConsumptionAllocation.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          source: 'ENTERPRISE_CREDIT',
          fundingClassificationComplete: true,
          unapprovedDebtUsd: { gt: 0 },
        }),
        orderBy: [{ ledgerSequence: 'asc' }, { id: 'asc' }],
      }),
    );
    expect(prisma.__debtSettlementWrites()).toEqual([
      {
        id: 'alloc-unapproved-boundary',
        applyUsd: new Prisma.Decimal(10),
        applyPaidUsd: new Prisma.Decimal(10),
        applyBonusUsd: new Prisma.Decimal(0),
        markSettled: true,
      },
    ]);
    expect(prisma.billingAccessRestriction.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: { in: ['restriction-boundary-debt'] },
        billingAccountId: 'ba_personal_u1',
        status: 'ACTIVE',
        reason: 'debt_open',
        gatewayBillingEvent: {
          is: expect.objectContaining({
            status: 'DEBT_OPEN',
            billingUnit: 'BALANCE',
          }),
        },
      }),
      data: {
        status: 'RELEASED',
        releasedAt: new Date('2026-07-16T00:00:00.000Z'),
        releasedBy: 'SYSTEM',
        releaseReason: 'balance_unapproved_debt_repaid',
      },
    });
    const settlementPostconditionIndex = ledgerInvariantAssertion.mock.calls.findIndex(
      (call: any[]) => call[2] === 'funding settlement postcondition',
    );
    expect(settlementPostconditionIndex).toBeGreaterThanOrEqual(0);
    expect(prisma.billingAccessRestriction.findMany.mock.invocationCallOrder[0])
      .toBeGreaterThan(
        ledgerInvariantAssertion.mock.invocationCallOrder[settlementPostconditionIndex],
      );
  });

  it('keeps a BALANCE debt restriction active while its unapproved allocation is partially unpaid', async () => {
    const { service, prisma } = await buildService();
    prisma.billingAccessRestriction.findMany.mockResolvedValueOnce([{
      id: 'restriction-partial-debt',
      gatewayBillingEvent: {
        tokenUsage: {
          consumptionAllocations: [{
            fundingClassificationComplete: true,
            unapprovedDebtUsd: new Prisma.Decimal(10),
            settledUsd: new Prisma.Decimal(4),
          }],
        },
      },
    }]);

    await (service as any).releaseRepaidGatewayBalanceDebtRestrictions(
      prisma,
      'ba_personal_u1',
      new Date('2026-07-16T00:00:00.000Z'),
    );

    expect(prisma.billingAccessRestriction.updateMany).not.toHaveBeenCalled();
  });

  it('does not select CREDITS debt restrictions for BALANCE repayment release', async () => {
    const { service, prisma } = await buildService();

    await (service as any).releaseRepaidGatewayBalanceDebtRestrictions(
      prisma,
      'ba_personal_u1',
      new Date('2026-07-16T00:00:00.000Z'),
    );

    expect(prisma.billingAccessRestriction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          gatewayBillingEvent: {
            is: expect.objectContaining({ billingUnit: 'BALANCE' }),
          },
        }),
      }),
    );
    expect(prisma.billingAccessRestriction.updateMany).not.toHaveBeenCalled();
  });

  it('keeps a debt restriction active when any linked debt allocation has incomplete funding classification', async () => {
    const { service, prisma } = await buildService();
    prisma.billingAccessRestriction.findMany.mockResolvedValueOnce([{
      id: 'restriction-incomplete-classification',
      gatewayBillingEvent: {
        tokenUsage: {
          consumptionAllocations: [
            {
              fundingClassificationComplete: true,
              unapprovedDebtUsd: new Prisma.Decimal(10),
              settledUsd: new Prisma.Decimal(10),
            },
            {
              fundingClassificationComplete: false,
              unapprovedDebtUsd: new Prisma.Decimal(0),
              settledUsd: new Prisma.Decimal(5),
            },
          ],
        },
      },
    }]);

    await (service as any).releaseRepaidGatewayBalanceDebtRestrictions(
      prisma,
      'ba_personal_u1',
      new Date('2026-07-16T00:00:00.000Z'),
    );

    expect(prisma.billingAccessRestriction.updateMany).not.toHaveBeenCalled();
  });

  it('does not select evidence-conflicted Gateway events for debt restriction release', async () => {
    const { service, prisma } = await buildService();

    await (service as any).releaseRepaidGatewayBalanceDebtRestrictions(
      prisma,
      'ba_personal_u1',
      new Date('2026-07-16T00:00:00.000Z'),
    );

    const eventFilter = prisma.billingAccessRestriction.findMany.mock.calls[0][0]
      .where.gatewayBillingEvent.is;
    expect(eventFilter).toEqual(expect.objectContaining({
      evidenceVerdict: { not: 'CONFLICTED' },
      reconciliationStatus: { not: 'MANUAL_REVIEW' },
    }));
    expect(prisma.billingAccessRestriction.updateMany).not.toHaveBeenCalled();
  });

  it('fails enterprise funding atomically when an open legacy debt has no ledger sequence', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('ba_personal_u1', -30);
    configureEnterpriseBillingSubject(prisma, null);
    prisma.balanceConsumptionAllocation.count.mockResolvedValueOnce(1);

    await expect(
      service.rechargeWithBonus('u1', 5000, 0, '企业历史欠款入金', 'order-unsequenced'),
    ).rejects.toThrow('BALANCE_DEBT_LEDGER_SEQUENCE_MISSING');

    expect(prisma.balanceConsumptionAllocation.findMany).not.toHaveBeenCalled();
    expect(prisma.balanceConsumptionAllocation.update).not.toHaveBeenCalled();
    expect(prisma.enterpriseCreditSettlement.create).not.toHaveBeenCalled();
  });

  it('fails all LEGACY_DIRTY enterprise funding even when every open debt is sequenced', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('ba_personal_u1', -30);
    configureEnterpriseBillingSubject(prisma, null);
    prisma.billingAccount.findUniqueOrThrow.mockResolvedValue({
      id: 'ba_personal_u1',
      type: 'enterprise',
      status: 'active',
      balanceGrantLedgerStatus: 'LEGACY_DIRTY',
      balanceGrantLedgerVersion: 0,
      creditConfig: null,
    });

    await expect(
      service.rechargeWithBonus('u1', 5000, 0, '企业脏账禁止入金', 'order-dirty-unsequenced'),
    ).rejects.toThrow('BALANCE_ENTERPRISE_LEDGER_RECONCILIATION_REQUIRED');

    expect(prisma.balanceConsumptionAllocation.count).not.toHaveBeenCalled();
    expect(prisma.enterpriseCreditSettlement.create).not.toHaveBeenCalled();
  });

  it('settles partially (no settledAt) when repayment does not cover the oldest allocation', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('ba_personal_u1', -40);
    configureEnterpriseBillingSubject(prisma, null);
    prisma.balanceConsumptionAllocation.findMany.mockResolvedValueOnce([
      { id: 'alloc-big', amountUsd: new Prisma.Decimal(50), settledUsd: new Prisma.Decimal(0) },
    ]);

    // 管理员公对公收款后代充值（正向调整）。
    await service.adjust('u1', 4000, '公对公转账入账', undefined, {
      idempotencyKey: 'enterprise-paid-debt-40',
    });

    // 只还了 40 / 欠 50 ⇒ 未结满,markSettled=false(settled_at 必须保持 NULL)
    expect(prisma.__debtSettlementWrites()).toEqual([
      {
        id: 'alloc-big',
        applyUsd: new Prisma.Decimal(40),
        applyPaidUsd: new Prisma.Decimal(40),
        applyBonusUsd: new Prisma.Decimal(0),
        markSettled: false,
      },
    ]);
    expect(prisma.enterpriseCreditSettlement.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          allocationId: 'alloc-big',
          amountUsd: new Prisma.Decimal(40),
          paidUsd: new Prisma.Decimal(40),
        }),
      ]),
    });
    expect(prisma.balanceTransaction.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        operationKey:
          'balance:admin-adjust:enterprise-paid-debt:enterprise-paid-debt-40',
      }),
    }));
    expect(prisma.billingAccount.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a crossing-zero enterprise adjustment without demoting the clean ledger', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('ba_personal_u1', -10);
    configureEnterpriseBillingSubject(prisma, null);
    prisma.balanceConsumptionAllocation.findMany.mockResolvedValueOnce([
      { id: 'alloc-cross-zero', amountUsd: new Prisma.Decimal(10), settledUsd: new Prisma.Decimal(0) },
    ]);

    await expect(service.adjust('u1', 2000, '公对公转账与额外调额', undefined, {
      idempotencyKey: 'enterprise-cross-zero-20',
    })).rejects.toThrow('BALANCE_ADJUSTMENT_REQUIRES_CLASSIFIED_LEDGER_PATH');

    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
    expect(prisma.enterpriseCreditSettlement.create).not.toHaveBeenCalled();
    expect(prisma.billingAccount.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a debt-filling enterprise adjustment without an idempotency classification', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('ba_personal_u1', -10);
    configureEnterpriseBillingSubject(prisma, null);
    prisma.balanceConsumptionAllocation.findMany.mockResolvedValueOnce([
      { id: 'alloc-no-key', amountUsd: new Prisma.Decimal(10), settledUsd: new Prisma.Decimal(0) },
    ]);

    await expect(service.adjust('u1', 1000, '无幂等分类的企业还款')).rejects.toThrow(
      'BALANCE_ADJUSTMENT_REQUIRES_CLASSIFIED_LEDGER_PATH',
    );

    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
    expect(prisma.enterpriseCreditSettlement.create).not.toHaveBeenCalled();
    expect(prisma.billingAccount.updateMany).not.toHaveBeenCalled();
  });

  it('rejects classified enterprise funding when debt cannot be settled exactly', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('ba_personal_u1', -10);
    configureEnterpriseBillingSubject(prisma, null);
    prisma.balanceConsumptionAllocation.findMany.mockResolvedValueOnce([]);

    await expect(service.adjust('u1', 1000, '企业还款分摊漂移', undefined, {
      idempotencyKey: 'enterprise-settlement-drift-10',
    })).rejects.toThrow('BALANCE_DEBT_SETTLEMENT_POSTCONDITION_FAILED');

    expect(prisma.balanceTransaction.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        operationKey:
          'balance:admin-adjust:enterprise-paid-debt:enterprise-settlement-drift-10',
      }),
    }));
    expect(prisma.billingAccount.updateMany).not.toHaveBeenCalled();
  });

  it('voucher fills enterprise debt without revenue recognition and shrinks voucher remaining', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('ba_personal_u1', -20);
    configureEnterpriseBillingSubject(prisma, null);
    prisma.balanceConsumptionAllocation.findMany.mockResolvedValueOnce([
      { id: 'alloc-v', amountUsd: new Prisma.Decimal(20), settledUsd: new Prisma.Decimal(0) },
    ]);

    await service.issueVoucher('u1', 3000, '企业代金券');

    // 赠金冲抵欠款不确认收入 ⇒ applyPaidUsd 为 0,全部落在 applyBonusUsd
    expect(prisma.__debtSettlementWrites()).toEqual([
      {
        id: 'alloc-v',
        applyUsd: new Prisma.Decimal(20),
        applyPaidUsd: new Prisma.Decimal(0),
        applyBonusUsd: new Prisma.Decimal(20),
        markSettled: true,
      },
    ]);
    expect(prisma.enterpriseCreditSettlement.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          paidUsd: new Prisma.Decimal(0),
          bonusUsd: new Prisma.Decimal(20),
        }),
      ]),
    });
    // 代金券 30，其中 20 填坑 → 可消费余额 10。
    expect(prisma.balanceGrant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          grantedAmountUsd: new Prisma.Decimal(30),
          remainingAmountUsd: new Prisma.Decimal(10),
        }),
      }),
    );
  });

  it('settles personal negative-balance debt and only mints the net consumable recharge amount', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('ba_personal_u1', -10);
    prisma.balanceConsumptionAllocation.findMany.mockResolvedValueOnce([{
      id: 'alloc-personal-negative',
      amountUsd: new Prisma.Decimal(10),
      settledUsd: new Prisma.Decimal(0),
      createdAt: new Date('2026-07-15T00:00:00.000Z'),
    }]);

    await service.rechargeWithBonus('u1', 2000, 0, '个人充值', 'order-personal');

    expect(prisma.__debtSettlementWrites()).toEqual([
      {
        id: 'alloc-personal-negative',
        applyUsd: new Prisma.Decimal(10),
        applyPaidUsd: new Prisma.Decimal(10),
        applyBonusUsd: new Prisma.Decimal(0),
        markSettled: true,
      },
    ]);
    expect(prisma.enterpriseCreditSettlement.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          allocationId: 'alloc-personal-negative',
          debtSource: 'NEGATIVE_BALANCE',
          amountUsd: new Prisma.Decimal(10),
          paidUsd: new Prisma.Decimal(10),
          bonusUsd: new Prisma.Decimal(0),
        }),
      ]),
    });
    expect(prisma.balanceGrant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          paidAmountUsd: new Prisma.Decimal(20),
          grantedAmountUsd: new Prisma.Decimal(20),
          remainingAmountUsd: new Prisma.Decimal(10),
          remainingPaidAmountUsd: new Prisma.Decimal(10),
          remainingBonusAmountUsd: new Prisma.Decimal(0),
        }),
      }),
    );
  });

  it('regression: wallet -0.14 plus a 5.00 recharge mints only 4.86 and settles NEGATIVE_BALANCE', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('ba_personal_u1', '-0.14');
    prisma.balanceConsumptionAllocation.findMany.mockResolvedValueOnce([{
      id: 'alloc-negative-014',
      amountUsd: new Prisma.Decimal('0.14'),
      settledUsd: new Prisma.Decimal(0),
      createdAt: new Date('2026-07-15T15:20:00.000Z'),
    }]);

    const result = await service.rechargeWithBonus(
      'u1',
      500,
      0,
      '截图场景充值',
      'order-screenshot-5',
    );

    expect(result.balanceAfterCents).toBe(486);
    expect(prisma.balanceGrant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          orderId: 'order-screenshot-5',
          paidAmountUsd: new Prisma.Decimal('5'),
          grantedAmountUsd: new Prisma.Decimal('5'),
          remainingAmountUsd: new Prisma.Decimal('4.86'),
          remainingPaidAmountUsd: new Prisma.Decimal('4.86'),
          remainingBonusAmountUsd: new Prisma.Decimal(0),
        }),
      }),
    );
    // 12 位定点字符串往返后必须仍是精确的 0.14,不能被浮点污染
    expect(prisma.__debtSettlementWrites()).toEqual([
      {
        id: 'alloc-negative-014',
        applyUsd: new Prisma.Decimal('0.14'),
        applyPaidUsd: new Prisma.Decimal('0.14'),
        applyBonusUsd: new Prisma.Decimal(0),
        markSettled: true,
      },
    ]);
    expect(prisma.enterpriseCreditSettlement.createMany).toHaveBeenCalledWith({
      data: expect.arrayContaining([
        expect.objectContaining({
          allocationId: 'alloc-negative-014',
          debtSource: 'NEGATIVE_BALANCE',
          amountUsd: new Prisma.Decimal('0.14'),
          paidUsd: new Prisma.Decimal('0.14'),
          bonusUsd: new Prisma.Decimal(0),
        }),
      ]),
    });
    expect(prisma.billingAccount.updateMany).not.toHaveBeenCalled();
  });

  it('compresses new funding but defers historical debt settlement on a LEGACY_DIRTY account', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('ba_personal_u1', '-0.14');
    prisma.billingAccount.findUniqueOrThrow.mockResolvedValue({
      id: 'ba_personal_u1',
      type: 'personal',
      status: 'active',
      balanceGrantLedgerStatus: 'LEGACY_DIRTY',
      balanceGrantLedgerVersion: 0,
      creditConfig: null,
    });

    const result = await service.rechargeWithBonus(
      'u1',
      500,
      0,
      '滚动发布期间充值',
      'order-dirty-screenshot-5',
    );

    expect(result.balanceAfterCents).toBe(486);
    expect(prisma.balanceGrant.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        remainingAmountUsd: new Prisma.Decimal('4.86'),
        remainingPaidAmountUsd: new Prisma.Decimal('4.86'),
        remainingBonusAmountUsd: new Prisma.Decimal(0),
      }),
    }));
    expect(prisma.balanceConsumptionAllocation.findMany).not.toHaveBeenCalled();
    expect(prisma.balanceConsumptionAllocation.update).not.toHaveBeenCalled();
    expect(prisma.enterpriseCreditSettlement.create).not.toHaveBeenCalled();
    expect(prisma.billingAccount.updateMany).not.toHaveBeenCalled();
  });

  it('rejects funding when even one 12-decimal unit cannot be tied to debt', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('ba_personal_u1', '-0.000000000001');
    prisma.balanceConsumptionAllocation.findMany.mockResolvedValueOnce([]);

    await expect(
      service.rechargeWithBonus('u1', 500, 0, '精度边界充值', 'order-drift-12dp'),
    ).rejects.toThrow('BALANCE_DEBT_SETTLEMENT_POSTCONDITION_FAILED');

    expect(prisma.balanceGrant.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        remainingAmountUsd: new Prisma.Decimal('4.999999999999'),
        remainingPaidAmountUsd: new Prisma.Decimal('4.999999999999'),
      }),
    }));
    expect(prisma.billingAccount.updateMany).not.toHaveBeenCalled();
  });

  it.each([
    'recharge',
    'admin-recharge',
    'voucher',
    'bonus',
  ])('fails %s atomically when a CLEAN wallet hole has no matching debt fact', async (entry) => {
    const { service, prisma, redis } = await buildService();
    prisma.__setWalletBalance('ba_personal_u1', '-1');
    prisma.balanceConsumptionAllocation.findMany.mockResolvedValue([]);
    if (entry === 'bonus') {
      prisma.balanceGrant.findUnique.mockResolvedValue({
        id: 'missing-debt-bonus-grant',
        userId: 'u1',
        tenantId: 'tenant-1',
        billingAccountId: 'ba_personal_u1',
        orderId: 'missing-debt-bonus-order',
        productId: null,
        source: 'RECHARGE',
        paidAmountUsd: new Prisma.Decimal(1),
        bonusAmountUsd: new Prisma.Decimal(0),
        grantedAmountUsd: new Prisma.Decimal(1),
        remainingAmountUsd: new Prisma.Decimal(1),
        remainingPaidAmountUsd: new Prisma.Decimal(1),
        remainingBonusAmountUsd: new Prisma.Decimal(0),
        discountRate: new Prisma.Decimal(1),
        validFrom: new Date('2026-07-15T00:00:00.000Z'),
        expiresAt: new Date('2027-07-15T00:00:00.000Z'),
        isExpired: false,
        createdAt: new Date('2026-07-15T00:00:00.000Z'),
      });
    }

    const call = entry === 'recharge'
      ? service.rechargeWithBonus('u1', 100, 0, '充值', 'missing-debt-order')
      : entry === 'admin-recharge'
        ? service.adminRecharge('u1', 100, '线下充值')
        : entry === 'voucher'
          ? service.issueVoucher('u1', 100, '补偿')
          : service.creditBonus(
            'u1',
            100,
            'recharge-bonus',
            'missing-debt-bonus-order',
          );

    await expect(call).rejects.toThrow('BALANCE_DEBT_SETTLEMENT_POSTCONDITION_FAILED');
    expect(prisma.billingAccount.updateMany).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('treats zero or negative deduct amount as a no-op and returns current balance', async () => {
    const { service, redis, prisma } = await buildService();
    redis.get.mockResolvedValue('12.34');
    prisma.__setWalletBalance('u1', '12.34');

    const zero = await service.deduct('u1', new Prisma.Decimal('0'), 'zero');
    const negative = await service.deduct('u1', new Prisma.Decimal('-1'), 'negative');

    expect(zero).toEqual({ success: true, balance: 1234, balanceUsd: 12.34 });
    expect(negative).toEqual({ success: true, balance: 1234, balanceUsd: 12.34 });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
  });

  it('returns success=false when wallet has insufficient funds', async () => {
    const { service, redis, repo, prisma } = await buildService();
    redis.get.mockResolvedValue(null);
    prisma.__setWalletBalance('u1', 5);

    const result = await service.deduct('u1', new Prisma.Decimal('20'), 'overuse');

    expect(result.success).toBe(false);
    expect(repo.createTransaction).not.toHaveBeenCalled();
    expect(result.balance).toBe(500);
  });

  it('insufficient funds returns the current cached balance', async () => {
    const { service, repo, prisma } = await buildService();
    prisma.__setWalletBalance('u1', 3);

    const result = await service.deduct('u1', new Prisma.Decimal('50'), 'big deduct');

    expect(result.balance).toBe(300);
    expect(repo.createTransaction).not.toHaveBeenCalled();
  });

  it('negative amount stored in PG transaction', async () => {
    const { service, redis, prisma } = await buildService();
    redis.get.mockResolvedValue(null);
    prisma.__setWalletBalance('u1', 100);

    await service.deduct('u1', new Prisma.Decimal('30'), 'deduct');

    const arg = prisma.balanceTransaction.create.mock.calls[0][0].data;
    expect(arg.amountUsd.toString()).toBe('-30');
  });

  it('allocates grant consumption only after a conditional remaining-balance update succeeds', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('u1', 20);
    const grant = {
      id: 'grant-1',
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      productId: null,
      orderId: 'order-1',
      source: 'RECHARGE',
      paidAmountUsd: new Prisma.Decimal(10),
      bonusAmountUsd: new Prisma.Decimal(0),
      grantedAmountUsd: new Prisma.Decimal(10),
      remainingAmountUsd: new Prisma.Decimal(10),
      remainingPaidAmountUsd: new Prisma.Decimal(10),
      remainingBonusAmountUsd: new Prisma.Decimal(0),
      discountRate: new Prisma.Decimal(1),
      validFrom: new Date('2025-01-01T00:00:00.000Z'),
      expiresAt: null,
      isExpired: false,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      updatedAt: new Date('2025-01-01T00:00:00.000Z'),
    };
    prisma.balanceGrant.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([grant])
      .mockResolvedValueOnce([]);
    prisma.balanceGrant.updateMany.mockResolvedValueOnce({ count: 1 });

    const result = await service.deduct('u1', new Prisma.Decimal(5), 'API用量');

    expect(result.success).toBe(true);
    expect(prisma.balanceGrant.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: 'grant-1',
          billingAccountId: 'ba_personal_u1',
          isExpired: false,
          remainingAmountUsd: new Prisma.Decimal(10),
          remainingPaidAmountUsd: new Prisma.Decimal(10),
          remainingBonusAmountUsd: new Prisma.Decimal(0),
          OR: [
            { expiresAt: null },
            { expiresAt: { gt: expect.any(Date) } },
          ],
        }),
        data: {
          remainingAmountUsd: new Prisma.Decimal(5),
          remainingPaidAmountUsd: new Prisma.Decimal(5),
          remainingBonusAmountUsd: new Prisma.Decimal(0),
        },
      }),
    );
    expect(prisma.balanceConsumptionAllocation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          balanceGrantId: 'grant-1',
          amountUsd: new Prisma.Decimal(5),
          recognizedRevenueUsd: new Prisma.Decimal(5),
          bonusConsumedUsd: new Prisma.Decimal(0),
        }),
      }),
    );
  });

  it('re-queries grants when a conditional grant decrement loses a race', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('u1', 20);
    const staleGrant = {
      id: 'grant-race',
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      productId: null,
      orderId: 'order-race',
      source: 'RECHARGE',
      paidAmountUsd: new Prisma.Decimal(10),
      bonusAmountUsd: new Prisma.Decimal(0),
      grantedAmountUsd: new Prisma.Decimal(10),
      remainingAmountUsd: new Prisma.Decimal(10),
      discountRate: new Prisma.Decimal(1),
      validFrom: new Date('2025-01-01T00:00:00.000Z'),
      expiresAt: null,
      isExpired: false,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      updatedAt: new Date('2025-01-01T00:00:00.000Z'),
    };
    const refreshedGrant = {
      ...staleGrant,
      remainingAmountUsd: new Prisma.Decimal(7),
    };
    const laterGrant = {
      ...staleGrant,
      id: 'grant-later',
      orderId: 'order-later',
      createdAt: new Date('2025-01-02T00:00:00.000Z'),
      updatedAt: new Date('2025-01-02T00:00:00.000Z'),
    };
    prisma.balanceGrant.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([staleGrant, laterGrant])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([refreshedGrant])
      .mockResolvedValueOnce([]);
    prisma.balanceGrant.updateMany
      .mockResolvedValueOnce({ count: 0 })
      .mockResolvedValueOnce({ count: 1 });

    const result = await service.deduct('u1', new Prisma.Decimal(5), 'API用量');

    expect(result.success).toBe(true);
    expect(prisma.balanceGrant.updateMany).toHaveBeenCalledTimes(2);
    expect(prisma.balanceConsumptionAllocation.create).toHaveBeenCalledTimes(1);
    expect(prisma.balanceConsumptionAllocation.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          balanceGrantId: 'grant-race',
          amountUsd: new Prisma.Decimal(5),
        }),
      }),
    );
    expect(prisma.balanceGrant.create).not.toHaveBeenCalled();
  });

  it('rolls back the deduct path instead of writing allocation when grant contention never resolves', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('u1', 20);
    const grant = {
      id: 'grant-hot',
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      productId: null,
      orderId: 'order-hot',
      source: 'RECHARGE',
      paidAmountUsd: new Prisma.Decimal(10),
      bonusAmountUsd: new Prisma.Decimal(0),
      grantedAmountUsd: new Prisma.Decimal(10),
      remainingAmountUsd: new Prisma.Decimal(10),
      discountRate: new Prisma.Decimal(1),
      validFrom: new Date('2025-01-01T00:00:00.000Z'),
      expiresAt: null,
      isExpired: false,
      createdAt: new Date('2025-01-01T00:00:00.000Z'),
      updatedAt: new Date('2025-01-01T00:00:00.000Z'),
    };
    let findManyCalls = 0;
    prisma.balanceGrant.findMany.mockImplementation(async () => {
      findManyCalls += 1;
      if (findManyCalls === 1) return [];
      return findManyCalls % 2 === 0 ? [grant] : [];
    });
    prisma.balanceGrant.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.deduct('u1', new Prisma.Decimal(5), 'API用量')).rejects.toThrow(
      'BALANCE_GRANT_ALLOCATION_CONFLICT',
    );

    expect(prisma.balanceGrant.updateMany).toHaveBeenCalledTimes(5);
    expect(prisma.balanceConsumptionAllocation.create).not.toHaveBeenCalled();
    expect(prisma.balanceGrant.create).not.toHaveBeenCalled();
  });
});

// ============================================================
// BillingService.adjust
// ============================================================
describe('BillingService.adjust', () => {
  function useLegacyDirtyAccount(prisma: any): void {
    prisma.billingAccount.findUnique.mockResolvedValue({
      id: 'ba_personal_u1',
      type: 'personal',
      status: 'active',
      ownerUserId: 'u1',
      name: 'Personal account',
      deletedAt: null,
      balanceGrantLedgerStatus: 'LEGACY_DIRTY',
      balanceGrantLedgerVersion: 0,
      creditConfig: null,
    });
  }

  function committedAdjustIdempotencyRow(amountUsd = '10.000000000000') {
    const response = {
      id: 'tx-adjust-replay',
      userId: 'u1',
      tenantId: 'tenant-1',
      productId: null,
      type: 'ADJUST',
      amountCents: 1000,
      balanceAfterCents: 3500,
      amountUsd: 10,
      balanceAfterUsd: 35,
      description: '补贴',
      createdAt: '2026-07-15T00:00:00.000Z',
    };
    return {
      response,
      row: {
        key: 'adjust-key-1',
        scope: 'admin:adjust-balance',
        userId: 'u1',
        status: 'COMMITTED',
        result: {
          version: 2,
          status: 'COMMITTED',
          request: {
            scope: 'admin:adjust-balance',
            userId: 'u1',
            tenantId: 'tenant-1',
            billingAccountId: 'ba_personal_u1',
            amountUsd,
            productId: null,
            description: '补贴',
            reason: null,
            expiresAt: null,
            performedBy: null,
          },
          response,
        },
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      },
    };
  }

  it('adjusts balance (positive) and records PG transaction', async () => {
    const { service, redis, prisma } = await buildService();
    useLegacyDirtyAccount(prisma);
    prisma.__setWalletBalance('u1', 50);

    const result = await service.adjust('u1', 1000, '补贴');

    expect(redis.set).toHaveBeenCalledWith('balance:tenant:tenant-1', '60.000000000000');
    expect(prisma.balanceTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'ADJUST',
          amountUsd: new Prisma.Decimal('10'),
        }),
      }),
    );
    expect(result.type).toBe('ADJUST');
  });

  it('adjusts balance (negative) for downward correction', async () => {
    const { service, prisma } = await buildService();
    useLegacyDirtyAccount(prisma);
    prisma.__setWalletBalance('u1', 25);

    const result = await service.adjust('u1', -500, '扣减');
    expect(result.amountCents).toBe(-500);
    expect(result.balanceAfterCents).toBe(2000);
  });

  it('rejects every retry of an unclassified clean adjustment without demoting the account', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('u1', 0);

    await expect(service.adjust('u1', 1000, '未分类补贴')).rejects.toThrow(
      'BALANCE_ADJUSTMENT_REQUIRES_CLASSIFIED_LEDGER_PATH',
    );
    await expect(service.adjust('u1', 1000, '未分类补贴')).rejects.toThrow(
      'BALANCE_ADJUSTMENT_REQUIRES_CLASSIFIED_LEDGER_PATH',
    );

    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
    expect(prisma.billingAccount.updateMany).not.toHaveBeenCalled();
  });

  it('persists admin balance adjustment idempotency', async () => {
    const { service, prisma } = await buildService();
    useLegacyDirtyAccount(prisma);
    prisma.__setWalletBalance('u1', 25);

    const result = await service.adjust('u1', 1000, '补贴', undefined, {
      tenantId: 'tenant-1',
      idempotencyKey: 'adjust-key-1',
    });

    expect(prisma.idempotencyKey.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        key: 'adjust-key-1',
        scope: 'admin:adjust-balance',
        status: 'PENDING',
        result: expect.objectContaining({
          version: 2,
          status: 'PENDING',
          request: expect.objectContaining({
            userId: 'u1',
            tenantId: 'tenant-1',
            billingAccountId: 'ba_personal_u1',
            amountUsd: '10.000000000000',
            productId: null,
            description: '补贴',
          }),
        }),
      }),
    });
    expect(prisma.idempotencyKey.update).toHaveBeenCalledWith({
      where: {
        key_scope: {
          key: 'adjust-key-1',
          scope: 'admin:adjust-balance',
        },
      },
      data: expect.objectContaining({
        status: 'COMMITTED',
        result: expect.objectContaining({
          version: 2,
          status: 'COMMITTED',
          response: expect.objectContaining({ id: result.id }),
        }),
      }),
    });
  });

  it('rejects reuse of an admin adjustment idempotency key with a different amount', async () => {
    const { service, prisma, redis } = await buildService();
    const { row } = committedAdjustIdempotencyRow();
    prisma.idempotencyKey.create.mockRejectedValueOnce({ code: 'P2002' });
    prisma.idempotencyKey.findUnique.mockResolvedValueOnce(row);

    await expect(service.adjust('u1', 2000, '补贴', undefined, {
      tenantId: 'tenant-1',
      idempotencyKey: 'adjust-key-1',
    })).rejects.toThrow('ADMIN_FUNDING_IDEMPOTENCY_FINGERPRINT_MISMATCH');

    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('returns a committed admin adjustment and fans out even when cache refresh fails', async () => {
    const { service, prisma, redis, publisher } = await buildService(
      {},
      {},
      {},
      undefined,
      {},
    );
    const { row, response } = committedAdjustIdempotencyRow();
    prisma.idempotencyKey.create.mockRejectedValueOnce({ code: 'P2002' });
    prisma.idempotencyKey.findUnique.mockResolvedValueOnce(row);
    redis.set.mockRejectedValueOnce(new Error('cache unavailable'));

    await expect(service.adjust('u1', 1000, '补贴', undefined, {
      tenantId: 'tenant-1',
      idempotencyKey: 'adjust-key-1',
    })).resolves.toEqual(response);

    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(publisher?.syncBillingAccountKeyBalances).toHaveBeenCalledWith('ba_personal_u1');
  });
});

// ============================================================
// BillingService.adminRecharge
// ============================================================
describe('BillingService.adminRecharge', () => {
  function committedAdminRechargeIdempotencyRow(billingAccountId = 'ba_personal_u1') {
    const response = {
      id: 'tx-admin-recharge-replay',
      userId: 'u1',
      tenantId: 'tenant-1',
      productId: 'prod-payg-1',
      type: 'RECHARGE',
      amountCents: 4000,
      balanceAfterCents: 6500,
      amountUsd: 40,
      balanceAfterUsd: 65,
      description: '线下转账入账',
      createdAt: '2026-07-15T00:00:00.000Z',
    };
    return {
      response,
      row: {
        key: 'recharge-key-1',
        scope: 'admin:recharge',
        userId: 'u1',
        status: 'COMMITTED',
        result: {
          version: 2,
          status: 'COMMITTED',
          request: {
            scope: 'admin:recharge',
            userId: 'u1',
            tenantId: 'tenant-1',
            billingAccountId,
            amountUsd: '40.000000000000',
            productId: 'prod-payg-1',
            description: '线下转账入账',
            reason: null,
            expiresAt: null,
            performedBy: null,
          },
          response,
        },
        expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      },
    };
  }

  it('records admin enterprise recharge as RECHARGE and creates a balance grant', async () => {
    const { service, prisma } = await buildService();
    prisma.__setWalletBalance('u1', 25);

    const result = await service.adminRecharge('u1', 4000, '线下转账入账', 'prod-payg-1', {
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      idempotencyKey: 'recharge-key-1',
    });

    expect(result.type).toBe('RECHARGE');
    expect(prisma.balanceTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          operationKey: expect.stringMatching(/^balance:admin-recharge:grant:grant-/),
          type: 'RECHARGE',
          amountUsd: new Prisma.Decimal('40'),
          productId: 'prod-payg-1',
          description: '线下转账入账',
        }),
      }),
    );
    expect(prisma.balanceGrant.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          source: 'RECHARGE',
          paidAmountUsd: new Prisma.Decimal('40'),
          bonusAmountUsd: new Prisma.Decimal(0),
          grantedAmountUsd: new Prisma.Decimal('40'),
          remainingAmountUsd: new Prisma.Decimal('40'),
          productId: 'prod-payg-1',
        }),
      }),
    );
    expect(prisma.idempotencyKey.update).toHaveBeenCalledWith({
      where: {
        key_scope: {
          key: 'recharge-key-1',
          scope: 'admin:recharge',
        },
      },
      data: expect.objectContaining({
        status: 'COMMITTED',
        result: expect.objectContaining({
          version: 2,
          status: 'COMMITTED',
          request: expect.objectContaining({
            userId: 'u1',
            tenantId: 'tenant-1',
            billingAccountId: 'ba_personal_u1',
            amountUsd: '40.000000000000',
            productId: 'prod-payg-1',
            description: '线下转账入账',
          }),
          response: expect.objectContaining({ id: result.id }),
        }),
      }),
    });
  });

  it('rejects an admin recharge replay whose envelope belongs to another account', async () => {
    const { service, prisma, redis } = await buildService();
    const { row } = committedAdminRechargeIdempotencyRow('ba-other');
    prisma.idempotencyKey.create.mockRejectedValueOnce({ code: 'P2002' });
    prisma.idempotencyKey.findUnique.mockResolvedValueOnce(row);

    await expect(service.adminRecharge('u1', 4000, '线下转账入账', 'prod-payg-1', {
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      idempotencyKey: 'recharge-key-1',
    })).rejects.toThrow('ADMIN_FUNDING_IDEMPOTENCY_FINGERPRINT_MISMATCH');

    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(prisma.balanceGrant.create).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('returns a committed admin recharge and fans out even when cache refresh fails', async () => {
    const { service, prisma, redis, publisher } = await buildService(
      {},
      {},
      {},
      undefined,
      {},
    );
    const { row, response } = committedAdminRechargeIdempotencyRow();
    prisma.idempotencyKey.create.mockRejectedValueOnce({ code: 'P2002' });
    prisma.idempotencyKey.findUnique.mockResolvedValueOnce(row);
    redis.set.mockRejectedValueOnce(new Error('cache unavailable'));

    await expect(service.adminRecharge('u1', 4000, '线下转账入账', 'prod-payg-1', {
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      idempotencyKey: 'recharge-key-1',
    })).resolves.toEqual(response);

    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(publisher?.syncBillingAccountKeyBalances).toHaveBeenCalledWith('ba_personal_u1');
  });
});

// ============================================================
// BillingService.creditBonus (PR0-4)
// ============================================================
describe('BillingService.creditBonus', () => {
  function rechargeGrant(overrides: Record<string, any> = {}) {
    return {
      id: 'grant-order-1',
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      orderId: 'order-1',
      productId: null,
      source: 'RECHARGE',
      paidAmountUsd: new Prisma.Decimal(100),
      bonusAmountUsd: new Prisma.Decimal(0),
      grantedAmountUsd: new Prisma.Decimal(100),
      remainingAmountUsd: new Prisma.Decimal(100),
      remainingPaidAmountUsd: new Prisma.Decimal(100),
      remainingBonusAmountUsd: new Prisma.Decimal(0),
      discountRate: new Prisma.Decimal(1),
      validFrom: new Date('2026-01-01T00:00:00.000Z'),
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      isExpired: false,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      ...overrides,
    };
  }

  function bonusReplayTransaction(overrides: Record<string, any> = {}) {
    return {
      id: 'tx-bonus-replay',
      operationKey: 'balance:bonus:u1:bonus:order-1',
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      type: 'ADJUST',
      amountUsd: new Prisma.Decimal(10),
      balanceAfterUsd: new Prisma.Decimal(110),
      description: 'recharge-bonus tier:tier-1',
      orderId: 'order-1',
      productId: null,
      createdAt: new Date('2026-07-15T00:00:00.000Z'),
      ...overrides,
    };
  }

  it('writes ADJUST row with bonus amount, links orderId, encodes tier in description', async () => {
    const { service, redis, prisma } = await buildService();
    prisma.__setWalletBalance('u1', 100);
    prisma.balanceGrant.findUnique.mockResolvedValue(rechargeGrant());

    const result = await service.creditBonus('u1', 1000, 'recharge-bonus tier:tier-1', 'order-1');

    expect(redis.set).toHaveBeenCalledWith('balance:tenant:tenant-1', '110.000000000000');
    expect(prisma.balanceTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'ADJUST',
          amountUsd: new Prisma.Decimal('10'),
          balanceAfterUsd: new Prisma.Decimal('110'),
          description: 'recharge-bonus tier:tier-1',
          orderId: 'order-1',
        }),
      }),
    );
    expect(result.type).toBe('ADJUST');
    expect(result.amountCents).toBe(1000);
    expect(prisma.balanceGrant.update).toHaveBeenCalledWith({
      where: { id: 'grant-order-1' },
      data: expect.objectContaining({
        bonusAmountUsd: new Prisma.Decimal(10),
        grantedAmountUsd: new Prisma.Decimal(110),
        remainingAmountUsd: new Prisma.Decimal(110),
        remainingPaidAmountUsd: new Prisma.Decimal(100),
        remainingBonusAmountUsd: new Prisma.Decimal(10),
      }),
    });
  });

  it.each([
    ['billing account', { billingAccountId: 'ba-other' }, undefined],
    ['tenant', { tenantId: 'tenant-other' }, undefined],
    ['product', { productId: 'prod-other' }, 'prod-1'],
  ])('rejects a bonus when orderId resolves to another %s grant', async (
    _label,
    grantOverrides,
    requestProductId,
  ) => {
    const { service, prisma, redis } = await buildService();
    prisma.balanceGrant.findUnique.mockResolvedValue(rechargeGrant(grantOverrides));

    await expect(service.creditBonus(
      'u1',
      1000,
      'recharge-bonus tier:tier-1',
      'order-1',
      { idempotencyKey: `cross-${_label}`, productId: requestProductId },
    )).rejects.toThrow('BALANCE_GRANT_SUBJECT_MISMATCH_FOR_BONUS');

    expect(prisma.balanceGrant.update).not.toHaveBeenCalled();
    expect(prisma.enterpriseCreditSettlement.create).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('throws when bonusCents is not positive', async () => {
    const { service } = await buildService();
    await expect(service.creditBonus('u1', 0, 'desc')).rejects.toThrow();
    await expect(service.creditBonus('u1', -100, 'desc')).rejects.toThrow();
  });

  // PR0-4 review fix(Important #1): 幂等保护
  it('idempotent: returns existing tx when (orderId, ADJUST, description) already present, does NOT incrby/insert again', async () => {
    const { service, redis, prisma } = await buildService();
    const existingTx = {
      id: 'tx-existing',
      operationKey: 'balance:bonus:u1:bonus:order-1',
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      type: 'ADJUST',
      amountUsd: new Prisma.Decimal('10'),
      balanceAfterUsd: new Prisma.Decimal('110'),
      description: 'recharge-bonus tier:tier-1',
      orderId: 'order-1',
      productId: null,
      createdAt: new Date('2025-01-01'),
    };
    prisma.balanceTransaction.findFirst.mockResolvedValue(existingTx);
    prisma.balanceGrant.findUnique.mockResolvedValue(rechargeGrant({
      bonusAmountUsd: new Prisma.Decimal(10),
      grantedAmountUsd: new Prisma.Decimal(110),
      remainingAmountUsd: new Prisma.Decimal(110),
      remainingBonusAmountUsd: new Prisma.Decimal(10),
    }));

    const result = await service.creditBonus(
      'u1',
      1000,
      'recharge-bonus tier:tier-1',
      'order-1',
      { idempotencyKey: 'bonus:order-1' },
    );

    expect(prisma.balanceTransaction.findFirst).toHaveBeenCalledWith({
      where: {
        OR: [
          { operationKey: 'balance:bonus:u1:bonus:order-1' },
          {
            orderId: 'order-1',
            type: 'ADJUST',
            description: 'recharge-bonus tier:tier-1',
          },
        ],
      },
    });
    expect(redis.incrby).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
    expect(result.id).toBe('tx-existing');
    expect(result.amountCents).toBe(1000);
  });

  it('rejects a bonus replay when the same idempotency key carries a different amount', async () => {
    const { service, prisma, redis } = await buildService();
    prisma.balanceTransaction.findFirst.mockResolvedValue(bonusReplayTransaction({
      amountUsd: new Prisma.Decimal(9),
    }));

    await expect(service.creditBonus(
      'u1',
      1000,
      'recharge-bonus tier:tier-1',
      'order-1',
      { idempotencyKey: 'bonus:order-1' },
    )).rejects.toThrow('BALANCE_BONUS_IDEMPOTENCY_AMOUNT_MISMATCH');

    expect(prisma.balanceGrant.findUnique).not.toHaveBeenCalled();
    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('rejects a bonus replay when the product fingerprint changes', async () => {
    const { service, prisma } = await buildService();
    prisma.balanceTransaction.findFirst.mockResolvedValue(bonusReplayTransaction({
      productId: 'prod-1',
    }));

    await expect(service.creditBonus(
      'u1',
      1000,
      'recharge-bonus tier:tier-1',
      'order-1',
      { idempotencyKey: 'bonus:order-1', productId: 'prod-2' },
    )).rejects.toThrow('BALANCE_BONUS_IDEMPOTENCY_FINGERPRINT_MISMATCH');

    expect(prisma.balanceGrant.findUnique).not.toHaveBeenCalled();
    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
  });

  it('replays a committed bonus and fans out account balance even when cache refresh fails', async () => {
    const { service, prisma, redis, publisher } = await buildService(
      {},
      {},
      {},
      undefined,
      {},
    );
    prisma.__setWalletBalance('u1', 110);
    prisma.balanceTransaction.findFirst.mockResolvedValue(bonusReplayTransaction());
    prisma.balanceGrant.findUnique.mockResolvedValue(rechargeGrant({
      bonusAmountUsd: new Prisma.Decimal(10),
      grantedAmountUsd: new Prisma.Decimal(110),
      remainingAmountUsd: new Prisma.Decimal(110),
      remainingBonusAmountUsd: new Prisma.Decimal(10),
    }));
    redis.set.mockRejectedValueOnce(new Error('cache unavailable'));

    await expect(service.creditBonus(
      'u1',
      1000,
      'recharge-bonus tier:tier-1',
      'order-1',
      { idempotencyKey: 'bonus:order-1' },
    )).resolves.toEqual(expect.objectContaining({ id: 'tx-bonus-replay' }));

    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
    expect(publisher?.syncBillingAccountKeyBalances).toHaveBeenCalledWith('ba_personal_u1');
  });

  it('replays a bonus after later bonuses increased the mutable grant totals', async () => {
    const { service, prisma } = await buildService();
    prisma.balanceTransaction.findFirst.mockResolvedValue(bonusReplayTransaction());
    prisma.balanceGrant.findUnique.mockResolvedValue(rechargeGrant({
      bonusAmountUsd: new Prisma.Decimal(15),
      grantedAmountUsd: new Prisma.Decimal(115),
      remainingAmountUsd: new Prisma.Decimal(115),
      remainingBonusAmountUsd: new Prisma.Decimal(15),
    }));

    await expect(service.creditBonus(
      'u1',
      1000,
      'recharge-bonus tier:tier-1',
      'order-1',
      { idempotencyKey: 'bonus:order-1' },
    )).resolves.toEqual(expect.objectContaining({ id: 'tx-bonus-replay' }));

    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
  });

  it('allows a semantic replay of a legacy bonus transaction whose operation key is null', async () => {
    const { service, prisma } = await buildService();
    prisma.balanceTransaction.findFirst.mockResolvedValue(bonusReplayTransaction({
      operationKey: null,
    }));
    prisma.balanceGrant.findUnique.mockResolvedValue(rechargeGrant({
      bonusAmountUsd: new Prisma.Decimal(10),
      grantedAmountUsd: new Prisma.Decimal(110),
      remainingAmountUsd: new Prisma.Decimal(110),
      remainingBonusAmountUsd: new Prisma.Decimal(10),
    }));

    await expect(service.creditBonus(
      'u1',
      1000,
      'recharge-bonus tier:tier-1',
      'order-1',
      { idempotencyKey: 'bonus:order-1' },
    )).resolves.toEqual(expect.objectContaining({ id: 'tx-bonus-replay' }));

    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
  });

  it('two consecutive calls with same orderId+description → only one DB row', async () => {
    const { service, prisma } = await buildService();
    prisma.balanceGrant.findUnique
      .mockResolvedValueOnce(rechargeGrant())
      .mockResolvedValueOnce(rechargeGrant({
        bonusAmountUsd: new Prisma.Decimal(10),
        grantedAmountUsd: new Prisma.Decimal(110),
        remainingAmountUsd: new Prisma.Decimal(110),
        remainingBonusAmountUsd: new Prisma.Decimal(10),
      }));

    // 第一次：findFirst 返回 null（无重复）
    prisma.balanceTransaction.findFirst.mockResolvedValueOnce(null);

    const r1 = await service.creditBonus(
      'u1', 1000, 'recharge-bonus tier:tier-1', 'order-1',
      { idempotencyKey: 'bonus:order-1' },
    );

    // 第二次：findFirst 返回上一次写入的 tx（模拟 DB 状态）
    const firstTx = prisma.balanceTransaction.create.mock.results[0].value instanceof Promise
      ? await prisma.balanceTransaction.create.mock.results[0].value
      : prisma.balanceTransaction.create.mock.results[0].value;
    prisma.balanceTransaction.findFirst.mockResolvedValueOnce(firstTx);

    const r2 = await service.creditBonus(
      'u1', 1000, 'recharge-bonus tier:tier-1', 'order-1',
      { idempotencyKey: 'bonus:order-1' },
    );

    expect(prisma.balanceTransaction.create).toHaveBeenCalledTimes(1); // 仅第一次插入
    expect(r1.id).toBe(firstTx.id);
    expect(r2.id).toBe(firstTx.id); // 第二次返回原 tx
  });

  it('aborts the whole delayed-bonus transaction when the recharge grant has already expired', async () => {
    const { service, prisma, redis } = await buildService();
    prisma.__setWalletBalance('u1', 100);
    prisma.balanceGrant.findUnique.mockResolvedValue(rechargeGrant({
      expiresAt: new Date('2026-01-02T00:00:00.000Z'),
      isExpired: false,
    }));
    let committed = false;
    prisma.$transaction.mockImplementationOnce(async (work: any) => {
      const before = await prisma.accountWallet.findUniqueOrThrow({
        where: { billingAccountId: 'ba_personal_u1' },
      });
      try {
        const value = await work(prisma);
        committed = true;
        return value;
      } catch (error) {
        // The unit-test Prisma double is not transactional; restore its wallet
        // snapshot so the assertion models PostgreSQL rollback semantics.
        prisma.__setWalletBalance('ba_personal_u1', before.balanceUsd);
        throw error;
      }
    });

    await expect(service.creditBonus(
      'u1',
      1000,
      'recharge-bonus tier:tier-delayed',
      'order-1',
      { idempotencyKey: 'bonus:order-1' },
    )).rejects.toThrow('BALANCE_GRANT_EXPIRED_FOR_BONUS');

    const wallet = await prisma.accountWallet.findUniqueOrThrow({
      where: { billingAccountId: 'ba_personal_u1' },
    });
    expect(committed).toBe(false);
    expect(wallet.balanceUsd).toEqual(new Prisma.Decimal(100));
    expect(prisma.balanceGrant.update).not.toHaveBeenCalled();
    expect(prisma.enterpriseCreditSettlement.create).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('legacy DIRTY bonus without orderId preserves the manual-ops path', async () => {
    const { service, prisma } = await buildService();
    prisma.billingAccount.findUnique.mockResolvedValue({
      id: 'ba_personal_u1',
      type: 'personal',
      status: 'active',
      ownerUserId: 'u1',
      name: 'Personal account',
      deletedAt: null,
      balanceGrantLedgerStatus: 'LEGACY_DIRTY',
      balanceGrantLedgerVersion: 0,
      creditConfig: null,
    });

    await service.creditBonus('u1', 500, '运营补发');

    expect(prisma.balanceTransaction.findFirst).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).toHaveBeenCalled();
  });

  it('rejects every no-order bonus retry on CLEAN without demoting the account', async () => {
    const { service, prisma } = await buildService();

    await expect(service.creditBonus('u1', 500, '运营补发')).rejects.toThrow(
      'BALANCE_BONUS_REQUIRES_CLASSIFIED_FUNDING_LINK',
    );
    await expect(service.creditBonus('u1', 500, '运营补发')).rejects.toThrow(
      'BALANCE_BONUS_REQUIRES_CLASSIFIED_FUNDING_LINK',
    );

    expect(prisma.accountWallet.update).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
    expect(prisma.billingAccount.updateMany).not.toHaveBeenCalled();
  });
});

// ============================================================
// BillingService.activateSubscription
// ============================================================
describe('BillingService.activateSubscription', () => {
  it('creates a new active subscription period and closes the previous active period', async () => {
    const { service, prisma, redis } = await buildService();
    prisma.plan.findUnique.mockResolvedValue({ validityDays: 30 });
    prisma.subscriptionPeriod.findMany.mockResolvedValueOnce([
      { id: 'period-old', contractId: 'contract-old', userId: 'u1', tenantId: 'tenant-1', productId: 'prod-1' },
    ]);
    redis.del.mockResolvedValue(1);

    await service.activateSubscription('u1', 'plan-pro', 'prod-1', undefined, 'monthly', { tenantId: 'tenant-1' });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.subscriptionEntitlement.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          periodId: { in: ['period-old'] },
          status: 'ACTIVE',
        },
        data: expect.objectContaining({
          status: 'EXPIRED',
          endedAt: expect.any(Date),
          terminationReason: 'replaced_by_new_activation',
        }),
      }),
    );
    expect(prisma.subscriptionPeriod.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: ['period-old'] },
          status: 'ACTIVE',
        },
        data: expect.objectContaining({
          status: 'EXPIRED',
          endedAt: expect.any(Date),
          terminationReason: 'replaced_by_new_activation',
        }),
      }),
    );
    expect(prisma.subscriptionContract.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          id: { in: ['contract-old'] },
          status: 'ACTIVE',
        },
        data: expect.objectContaining({
          status: 'EXPIRED',
          endedAt: expect.any(Date),
          terminationReason: 'replaced_by_new_activation',
        }),
      }),
    );
    expect(prisma.subscriptionContract.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'u1',
          tenantId: 'tenant-1',
          billingAccountId: 'ba_personal_u1',
          productId: 'prod-1',
          status: 'ACTIVE',
          startedAt: expect.any(Date),
        }),
      }),
    );
    expect(prisma.subscriptionPeriod.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'u1',
          tenantId: 'tenant-1',
          billingAccountId: 'ba_personal_u1',
          productId: 'prod-1',
          planId: 'plan-pro',
          billingPeriod: 'monthly',
          status: 'ACTIVE',
          startedAt: expect.any(Date),
        }),
      }),
    );
    expect(prisma.subscriptionEntitlement.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          userId: 'u1',
          tenantId: 'tenant-1',
          billingAccountId: 'ba_personal_u1',
          productId: 'prod-1',
          planId: 'plan-pro',
          entitlementType: 'plan_access',
          status: 'ACTIVE',
          startedAt: expect.any(Date),
        }),
      }),
    );
    expect(prisma.userSubscription.upsert).not.toHaveBeenCalled();
    expect(prisma.userSubscription.findFirst).not.toHaveBeenCalled();
    expect(prisma.userSubscription.update).not.toHaveBeenCalled();
    expect(redis.del).toHaveBeenCalledWith('subscription:u1');
    expect(redis.del).toHaveBeenCalledWith('subscription:tenant-1');
  });

  it('new active period carries fresh startedAt and new expiresAt on plan change', async () => {
    const { service, prisma, redis } = await buildService();
    prisma.plan.findUnique.mockResolvedValue({ validityDays: 30 });
    redis.del.mockResolvedValue(1);

    await service.activateSubscription('u1', 'plan-pro', 'prod-1', undefined, 'monthly', { tenantId: 'tenant-1' });

    const createArg = prisma.subscriptionPeriod.create.mock.calls[0][0].data;
    expect(createArg.planId).toBe('plan-pro');
    expect(createArg.status).toBe('ACTIVE');
    expect(createArg.startedAt).toBeInstanceOf(Date);
    expect(createArg.expiresAt).toBeInstanceOf(Date);
  });

  it('sets expiresAt when plan has validityDays > 0', async () => {
    const { service, prisma, redis } = await buildService();
    prisma.plan.findUnique.mockResolvedValue({ validityDays: 365 });
    redis.del.mockResolvedValue(1);

    await service.activateSubscription('u1', 'plan-annual', 'prod-1', undefined, 'monthly', { tenantId: 'tenant-1' });

    const createArg = prisma.subscriptionPeriod.create.mock.calls[0][0].data;
    expect(createArg.expiresAt).toBeInstanceOf(Date);
    // Should be roughly 365 days from now
    const diff = createArg.expiresAt.getTime() - Date.now();
    expect(diff).toBeGreaterThan(364 * 24 * 60 * 60 * 1000);
  });

  it('sets expiresAt=null when validityDays is 0', async () => {
    const { service, prisma, redis } = await buildService();
    prisma.plan.findUnique.mockResolvedValue({ validityDays: 0 });
    redis.del.mockResolvedValue(1);

    await service.activateSubscription('u1', 'plan-unlimited', 'prod-1', undefined, 'monthly', { tenantId: 'tenant-1' });

    const createArg = prisma.subscriptionPeriod.create.mock.calls[0][0].data;
    expect(createArg.expiresAt).toBeNull();
  });

  it('throws NotFoundException when plan does not exist', async () => {
    const { service, prisma } = await buildService();
    prisma.plan.findUnique.mockResolvedValue(null);

    await expect(
      service.activateSubscription('u1', 'no-such-plan', 'prod-1'),
    ).rejects.toThrow(NotFoundException);
    expect(prisma.userSubscription.upsert).not.toHaveBeenCalled();
    expect(prisma.userSubscription.create).not.toHaveBeenCalled();
    expect(prisma.subscriptionPeriod.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('clears subscription cache after activation', async () => {
    const { service, prisma, redis } = await buildService();
    prisma.plan.findUnique.mockResolvedValue({ validityDays: 30 });
    redis.del.mockResolvedValue(1);

    await service.activateSubscription('u1', 'plan-x', 'prod-1', undefined, 'monthly', { tenantId: 'tenant-1' });

    expect(redis.del).toHaveBeenCalledWith('subscription:u1');
    expect(redis.del).toHaveBeenCalledWith('subscription:tenant-1');
  });

  // Regression: activation must not mutate the previous period in place.
  // The database partial unique index allows one ACTIVE row per tenant/product
  // while preserving replaced periods as history.
  it('issues a close-and-create transaction per activation under concurrent invocations', async () => {
    const { service, prisma, redis } = await buildService();
    prisma.plan.findUnique.mockResolvedValue({ validityDays: 30 });
    redis.del.mockResolvedValue(1);

    await Promise.all([
      service.activateSubscription('u1', 'plan-pro', 'prod-1', undefined, 'monthly', { tenantId: 'tenant-1' }),
      service.activateSubscription('u1', 'plan-pro', 'prod-1', undefined, 'monthly', { tenantId: 'tenant-1' }),
      service.activateSubscription('u1', 'plan-pro', 'prod-1', undefined, 'monthly', { tenantId: 'tenant-1' }),
    ]);

    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(prisma.subscriptionPeriod.findMany).toHaveBeenCalledTimes(3);
    expect(prisma.subscriptionPeriod.create).toHaveBeenCalledTimes(3);
    expect(prisma.subscriptionEntitlement.create).toHaveBeenCalledTimes(3);
    expect(prisma.userSubscription.upsert).not.toHaveBeenCalled();
  });
});

// ============================================================
// BillingService.getUserPlanId
// ============================================================
describe('BillingService.getUserPlanId', () => {
  it('returns planId from Redis cache when cached (not none)', async () => {
    const { service, redis } = await buildService();
    redis.get.mockResolvedValue('plan-pro');

    const planId = await service.getUserPlanId('u1');
    expect(planId).toBe('plan-pro');
  });

  it('returns null when Redis cache is "none"', async () => {
    const { service, redis } = await buildService();
    redis.get.mockResolvedValue('none');

    const planId = await service.getUserPlanId('u1');
    expect(planId).toBeNull();
  });

  it('queries DB when not cached — valid active sub returns planId', async () => {
    const { service, redis, prisma } = await buildService();
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    prisma.subscriptionPeriod.findFirst.mockResolvedValue({
      planId: 'plan-abc',
    });

    const planId = await service.getUserPlanId('u1');
    expect(planId).toBe('plan-abc');
    expect(redis.set).toHaveBeenCalledWith('subscription:u1', 'plan-abc', 'EX', 600);
  });

  it('returns null and caches "none" when no active sub found', async () => {
    const { service, redis, prisma } = await buildService();
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    prisma.subscriptionPeriod.findFirst.mockResolvedValue(null);

    const planId = await service.getUserPlanId('u1');
    expect(planId).toBeNull();
    expect(redis.set).toHaveBeenCalledWith('subscription:u1', 'none', 'EX', 600);
  });

  it('returns null and caches "none" when sub is expired', async () => {
    const { service, redis, prisma } = await buildService();
    redis.get.mockResolvedValue(null);
    redis.set.mockResolvedValue('OK');
    prisma.subscriptionPeriod.findFirst.mockResolvedValue(null);

    const planId = await service.getUserPlanId('u1');
    expect(planId).toBeNull();
    expect(redis.set).toHaveBeenCalledWith('subscription:u1', 'none', 'EX', 600);
  });
});

// ============================================================
// BillingService.getCreditsSummary
// ============================================================
describe('BillingService.getCreditsSummary', () => {
  it('returns summary with balance, used, and granted', async () => {
    const { service, redis, repo, prisma } = await buildService();
    redis.get.mockResolvedValue('100'); // balance cached
    prisma.__setWalletBalance('u1', 100);
    repo.aggregateUsedThisMonth.mockResolvedValue({ _sum: { amountUsd: new Prisma.Decimal('-30') } });
    repo.aggregateTotalGranted.mockResolvedValue({ _sum: { amountUsd: new Prisma.Decimal('150') } });
    repo.aggregateBalanceGrantTotals.mockResolvedValue({
      _sum: {
        paidAmountUsd: new Prisma.Decimal('120'),
        bonusAmountUsd: new Prisma.Decimal('30'),
      },
    });

    const summary = await service.getCreditsSummary('u1');
    expect(summary.balanceCents).toBe(10000);
    expect(summary.usedThisMonthCents).toBe(3000); // absolute value
    expect(summary.totalGrantedCents).toBe(15000);
    expect(summary.totalRechargeCents).toBe(12000);
    expect(summary.totalRechargeAmount).toBe('120.000000000000');
    expect(summary.totalBonusGrantedCents).toBe(3000);
    expect(summary.totalBonusGrantedAmount).toBe('30.000000000000');
    expect(summary.allowanceCents).toBeNull();
  });

  it('exposes workspace allowance fields on the credits summary', async () => {
    const { service, prisma, repo } = await buildService();
    prisma.__setWalletBalance('u1', 100);
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'tenant-1',
      name: 'Team',
      type: 'personal',
      status: 'active',
      ownerUserId: 'u1',
      billingAccountId: 'ba_personal_u1',
      deletedAt: null,
      balanceAllowanceUsd: new Prisma.Decimal('50'),
      balanceAllowanceUsedUsd: new Prisma.Decimal('10'),
    });
    repo.aggregateUsedThisMonth.mockResolvedValue({ _sum: { amountUsd: null } });
    repo.aggregateTotalGranted.mockResolvedValue({ _sum: { amountUsd: null } });
    repo.aggregateBalanceGrantTotals.mockResolvedValue({
      _sum: { paidAmountUsd: null, bonusAmountUsd: null },
    });

    const summary = await service.getCreditsSummary('u1', { tenantId: 'tenant-1' });

    expect(summary.allowanceCents).toBe(5000);
    expect(summary.allowanceUsedCents).toBe(1000);
    expect(summary.allowanceRemainingCents).toBe(4000);
  });

  it('returns 0 for used/granted when no transactions', async () => {
    const { service, redis, repo } = await buildService();
    redis.get.mockResolvedValue('0');
    repo.aggregateUsedThisMonth.mockResolvedValue({ _sum: { amountUsd: null } });
    repo.aggregateTotalGranted.mockResolvedValue({ _sum: { amountUsd: null } });
    repo.aggregateBalanceGrantTotals.mockResolvedValue({
      _sum: {
        paidAmountUsd: null,
        bonusAmountUsd: null,
      },
    });

    const summary = await service.getCreditsSummary('u1');
    expect(summary.usedThisMonthCents).toBe(0);
    expect(summary.totalGrantedCents).toBe(0);
    expect(summary.totalRechargeCents).toBe(0);
    expect(summary.totalBonusGrantedCents).toBe(0);
  });

  it('reuses resolved billing subject and avoids redundant wallet upserts', async () => {
    const { service, repo, prisma, redis } = await buildService();
    prisma.__setWalletBalance('u1', 100);
    repo.aggregateUsedThisMonth.mockResolvedValue({ _sum: { amountUsd: new Prisma.Decimal('-30') } });
    repo.aggregateTotalGranted.mockResolvedValue({ _sum: { amountUsd: new Prisma.Decimal('150') } });
    repo.aggregateBalanceGrantTotals.mockResolvedValue({
      _sum: {
        paidAmountUsd: new Prisma.Decimal('120'),
        bonusAmountUsd: new Prisma.Decimal('30'),
      },
    });

    const summary = await service.getCreditsSummary('u1', {
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
    });

    expect(summary.balanceCents).toBe(10000);
    expect(prisma.accountWallet.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.accountWallet.upsert).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    expect(repo.aggregateBalanceGrantTotals).toHaveBeenCalledWith('u1', {
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
    });
  });

  it('reports that a readonly workspace member cannot recharge the shared account', async () => {
    const { service, prisma, repo } = await buildService();
    configureBillingMemberSubject(prisma);
    prisma.__setWalletBalance('ba_personal_u1', 25);
    repo.aggregateUsedThisMonth.mockResolvedValue({ _sum: { amountUsd: null } });
    repo.aggregateTotalGranted.mockResolvedValue({ _sum: { amountUsd: null } });
    repo.aggregateBalanceGrantTotals.mockResolvedValue({
      _sum: { paidAmountUsd: null, bonusAmountUsd: null },
    });

    const summary = await service.getCreditsSummary('u1', { tenantId: 'tenant-1' });

    expect(summary.subject).toEqual({
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
      accountType: 'personal',
      accountName: 'Team workspace',
      canRecharge: false,
    });
  });

  it('subtracts only live funding reservations and ignores evidence OPEN events', async () => {
    const { service, prisma, repo } = await buildService();
    prisma.__setWalletBalance('u1', 10);
    prisma.gatewayUsageFundingReservation.aggregate.mockResolvedValue({
      _count: { _all: 2 },
      _sum: { reservedAmountUsd: new Prisma.Decimal('3') },
    });
    prisma.gatewayBillingEvent.aggregate.mockResolvedValue({
      _sum: { pendingExposureUsd: null },
    });
    repo.aggregateUsedThisMonth.mockResolvedValue({ _sum: { amountUsd: null } });
    repo.aggregateTotalGranted.mockResolvedValue({ _sum: { amountUsd: null } });
    repo.aggregateBalanceGrantTotals.mockResolvedValue({
      _sum: { paidAmountUsd: null, bonusAmountUsd: null },
    });

    const summary = await service.getCreditsSummary('u1');

    expect(summary).toMatchObject({
      balanceCents: 700,
      accountBalanceCents: 1000,
      accountAvailableBalanceCents: 700,
      pendingUsageCount: 2,
      pendingHoldCents: 300,
      pendingExposureCents: 300,
      accessStatus: 'ACTIVE',
      creditPolicy: { status: 'CLEAR', action: 'ALLOW' },
    });
    expect(prisma.gatewayBillingEvent.aggregate).not.toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ status: 'QUARANTINED' }),
      }),
    );
  });

  it('omits pending and debt amounts for a member without billing-owner capability', async () => {
    const { service, prisma, repo } = await buildService();
    configureBillingMemberSubject(prisma);
    prisma.__setWalletBalance('ba_personal_u1', 10);
    prisma.gatewayUsageFundingReservation.aggregate.mockResolvedValue({
      _count: { _all: 1 },
      _sum: { reservedAmountUsd: new Prisma.Decimal('1') },
    });
    prisma.gatewayBillingEvent.aggregate.mockResolvedValue({
      _sum: { pendingExposureUsd: new Prisma.Decimal('3') },
    });
    prisma.billingAccessRestriction.findFirst.mockResolvedValue({ reason: 'debt_open' });
    repo.aggregateUsedThisMonth.mockResolvedValue({ _sum: { amountUsd: null } });
    repo.aggregateTotalGranted.mockResolvedValue({ _sum: { amountUsd: null } });
    repo.aggregateBalanceGrantTotals.mockResolvedValue({
      _sum: { paidAmountUsd: null, bonusAmountUsd: null },
    });

    const summary = await service.getCreditsSummary('u1', { tenantId: 'tenant-1' });

    expect(summary.subject.canRecharge).toBe(false);
    expect(summary).toMatchObject({
      accessStatus: 'RESTRICTED',
      creditPolicy: { status: 'DEBT_OPEN', action: 'FAIL_CLOSED' },
    });
    expect(summary).not.toHaveProperty('pendingUsageCount');
    expect(summary).not.toHaveProperty('pendingHoldCents');
    expect(summary).not.toHaveProperty('pendingExposureCents');
    expect(summary).not.toHaveProperty('openDebtCents');
  });

  it('does not leak owner-only frozen receivables through member creditUsed fields', async () => {
    const { service, prisma, repo } = await buildService();
    configureBillingMemberSubject(prisma);
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'tenant-1',
      name: 'Enterprise workspace',
      type: 'enterprise',
      status: 'active',
      ownerUserId: 'owner-1',
      billingAccountId: 'ba_personal_u1',
      deletedAt: null,
      balanceAllowanceUsd: null,
      balanceAllowanceUsedUsd: new Prisma.Decimal(0),
    });
    prisma.billingAccount.findUnique.mockResolvedValue({
      id: 'ba_personal_u1',
      type: 'enterprise',
      status: 'active',
      ownerUserId: 'owner-1',
      name: 'Enterprise account',
      deletedAt: null,
      currency: 'USD',
      balanceGrantLedgerStatus: 'RECONCILED_V2',
      balanceGrantLedgerVersion: 2,
      creditConfig: {
        limitUsd: new Prisma.Decimal(100),
        status: 'SUSPENDED',
        termsDays: 30,
        effectiveAt: new Date('2026-01-01T00:00:00.000Z'),
        expiresAt: new Date('2026-02-01T00:00:00.000Z'),
        policyRevision: 1,
        policyEffectiveBoundaryAt: new Date('2026-01-01T00:00:00.000Z'),
        policyBoundaryComplete: true,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    });
    prisma.__setWalletBalance('ba_personal_u1', 10);
    prisma.$queryRaw.mockImplementation(async (query: TemplateStringsArray, ...values: unknown[]) => {
      if (String(query).includes('approved_receivable_usd')) {
        return [{
          approved_receivable_usd: new Prisma.Decimal(7),
          unapproved_debt_usd: new Prisma.Decimal(0),
          incomplete_open_count: BigInt(0),
        }];
      }
      return prisma.__defaultQueryRaw(query, ...values);
    });
    repo.aggregateUsedThisMonth.mockResolvedValue({ _sum: { amountUsd: null } });
    repo.aggregateTotalGranted.mockResolvedValue({ _sum: { amountUsd: null } });
    repo.aggregateBalanceGrantTotals.mockResolvedValue({
      _sum: { paidAmountUsd: null, bonusAmountUsd: null },
    });

    const summary = await service.getCreditsSummary('u1', { tenantId: 'tenant-1' });

    expect(summary.subject.canRecharge).toBe(false);
    expect(summary.creditStatus).toBe('SUSPENDED');
    expect(summary.creditUsedUsd).toBe(0);
    expect(summary.creditUsedAmount).toBe('0.000000000000');
    expect(summary).not.toHaveProperty('enterpriseFunding');
  });

  it('reports authoritative unpaid usage as restricted open debt', async () => {
    const { service, prisma, repo } = await buildService();
    prisma.__setWalletBalance('u1', 10);
    prisma.gatewayBillingEvent.aggregate.mockImplementation(async ({ where }: any) => (
      where.status === 'QUARANTINED'
        ? {
            _count: { _all: 0 },
            _sum: { pendingHoldUsd: null, pendingExposureUsd: null },
          }
        : { _sum: { pendingExposureUsd: new Prisma.Decimal('2.5') } }
    ));
    prisma.billingAccessRestriction.findFirst.mockResolvedValue({ reason: 'debt_open' });
    repo.aggregateUsedThisMonth.mockResolvedValue({ _sum: { amountUsd: null } });
    repo.aggregateTotalGranted.mockResolvedValue({ _sum: { amountUsd: null } });
    repo.aggregateBalanceGrantTotals.mockResolvedValue({
      _sum: { paidAmountUsd: null, bonusAmountUsd: null },
    });

    const summary = await service.getCreditsSummary('u1');

    expect(summary).toMatchObject({
      openDebtCents: 250,
      accessStatus: 'RESTRICTED',
      creditPolicy: { status: 'DEBT_OPEN', action: 'FAIL_CLOSED' },
    });
  });

  it('reports every active Billing restriction as fail-closed without exposing its reason', async () => {
    const { service, prisma, repo } = await buildService();
    prisma.__setWalletBalance('u1', 10);
    prisma.gatewayBillingEvent.aggregate.mockImplementation(async ({ where }: any) => (
      where.status === 'QUARANTINED'
        ? {
            _count: { _all: 0 },
            _sum: { pendingHoldUsd: null, pendingExposureUsd: null },
          }
        : { _sum: { pendingExposureUsd: null } }
    ));
    prisma.billingAccessRestriction.findFirst.mockResolvedValue({
      reason: 'evidence_conflict',
    });
    repo.aggregateUsedThisMonth.mockResolvedValue({ _sum: { amountUsd: null } });
    repo.aggregateTotalGranted.mockResolvedValue({ _sum: { amountUsd: null } });
    repo.aggregateBalanceGrantTotals.mockResolvedValue({
      _sum: { paidAmountUsd: null, bonusAmountUsd: null },
    });

    const summary = await service.getCreditsSummary('u1');

    expect(summary).toMatchObject({
      accessStatus: 'RESTRICTED',
      creditPolicy: { status: 'RESTRICTED', action: 'FAIL_CLOSED' },
    });
    expect(summary.creditPolicy).not.toHaveProperty('reason');
  });

  it('does not double count BALANCE debt already represented by the wallet ledger', async () => {
    const { service, prisma, repo } = await buildService();
    prisma.__setWalletBalance('u1', -2.5);
    prisma.gatewayBillingEvent.aggregate.mockImplementation(async ({ where }: any) => (
      where.status === 'QUARANTINED'
        ? {
            _count: { _all: 0 },
            _sum: { pendingHoldUsd: null, pendingExposureUsd: null },
          }
        : {
            // The summary query asks only for CREDITS debt. The corresponding
            // BALANCE event exposure is intentionally excluded here.
            _sum: { pendingExposureUsd: null },
          }
    ));
    repo.aggregateUsedThisMonth.mockResolvedValue({ _sum: { amountUsd: null } });
    repo.aggregateTotalGranted.mockResolvedValue({ _sum: { amountUsd: null } });
    repo.aggregateBalanceGrantTotals.mockResolvedValue({
      _sum: { paidAmountUsd: null, bonusAmountUsd: null },
    });

    const summary = await service.getCreditsSummary('u1');

    expect(summary.balanceCents).toBe(-250);
    expect(summary.balanceAmount).toBe('-2.500000000000');
    expect(summary.accountAvailableBalanceCents).toBe(0);
    expect(summary.openDebtCents).toBe(250);
    expect(summary.creditPolicy).toEqual({ status: 'DEBT_OPEN', action: 'FAIL_CLOSED' });
    expect(prisma.gatewayBillingEvent.aggregate).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ billingUnit: 'CREDITS' }),
      }),
    );
  });
});

// ============================================================
// BillingService.getTransactions
// ============================================================
describe('BillingService.getTransactions', () => {
  it('returns paginated transaction list', async () => {
    const { service, repo } = await buildService();
    const tx1 = {
      id: 'tx-1', userId: 'u1', type: 'RECHARGE',
      amountUsd: new Prisma.Decimal('10'), balanceAfterUsd: new Prisma.Decimal('10'),
      description: 'top-up', createdAt: new Date('2025-01-01'),
    };
    repo.findTransactions.mockResolvedValue([tx1]);
    repo.countTransactions.mockResolvedValue(10);

    const result = await service.getTransactions('u1', 1, 5);

    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(10);
    expect(result.totalPages).toBe(2);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(5);
    expect(repo.findTransactions).toHaveBeenCalledWith('u1', 0, 5, undefined, {
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
    });
  });

  it('returns CONSUME transaction amounts as positive spend values', async () => {
    const { service, repo } = await buildService();
    repo.findTransactions.mockResolvedValue([
      {
        id: 'tx-consume',
        userId: 'u1',
        type: 'CONSUME',
        amountUsd: new Prisma.Decimal('-1.23'),
        balanceAfterUsd: new Prisma.Decimal('8.77'),
        description: 'api call',
        createdAt: new Date('2025-01-01'),
      },
    ]);
    repo.countTransactions.mockResolvedValue(1);

    const result = await service.getTransactions('u1', 1, 5);

    expect(result.items[0].amountCents).toBe(123);
    expect(result.items[0].amountUsd).toBe(1.23);
  });
});

// ============================================================
// BillingService.getDailySummary
// ============================================================
describe('BillingService.getDailySummary', () => {
  const start = new Date('2025-01-01');
  const end = new Date('2025-01-31');

  it('returns merged daily data without apiKeyId', async () => {
    const { service, repo } = await buildService();
    repo.dailyBalanceConsumption.mockResolvedValue([
      { date: new Date('2025-01-10'), totalUsd: new Prisma.Decimal('5') },
    ]);
    repo.dailyCreditConsumption.mockResolvedValue([
      { date: new Date('2025-01-10'), totalCredits: 100, totalTokens: 5000 },
    ]);

    const rows = await service.getDailySummary('u1', start, end);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      date: '2025-01-10',
      balanceConsumptionCents: 500,
      creditConsumption: 100,
      tokenCount: 5000,
    });
  });

  it('merges dates from both balance and credit rows', async () => {
    const { service, repo } = await buildService();
    repo.dailyBalanceConsumption.mockResolvedValue([
      { date: new Date('2025-01-10'), totalUsd: new Prisma.Decimal('2') },
      { date: new Date('2025-01-11'), totalUsd: new Prisma.Decimal('3') },
    ]);
    repo.dailyCreditConsumption.mockResolvedValue([
      { date: new Date('2025-01-11'), totalCredits: 50, totalTokens: 1000 },
      { date: new Date('2025-01-12'), totalCredits: 80, totalTokens: 2000 },
    ]);

    const rows = await service.getDailySummary('u1', start, end);

    expect(rows).toHaveLength(3);
    const sorted = rows.sort((a, b) => a.date.localeCompare(b.date));
    expect(sorted[0].date).toBe('2025-01-10');
    expect(sorted[1].date).toBe('2025-01-11');
    expect(sorted[2].date).toBe('2025-01-12');
    expect(sorted[1].balanceConsumptionCents).toBe(300);
    expect(sorted[1].creditConsumption).toBe(50);
  });

  it('returns token usage rows when apiKeyId provided and key belongs to user', async () => {
    const { service, repo, prisma } = await buildService();
    prisma.apiKey.findFirst.mockResolvedValue({ id: 'ak-1' });
    repo.dailyActualUsageFunding.mockResolvedValue([
      {
        date: new Date('2025-01-15'),
        balanceConsumptionUsd: new Prisma.Decimal('0.75'),
        creditConsumption: 125,
        totalTokens: 3000,
      },
    ]);

    const rows = await service.getDailySummary('u1', start, end, 'ak-1');

    expect(rows).toHaveLength(1);
    expect(rows[0].tokenCount).toBe(3000);
    expect(rows[0].balanceConsumptionCents).toBe(75);
    expect(rows[0].creditConsumption).toBe(125);
  });

  it('requires an explicitly filtered API key to belong to the requested product', async () => {
    const { service, repo, prisma } = await buildService();
    prisma.apiKey.findFirst.mockResolvedValue({ id: 'ak-1' });
    repo.dailyActualUsageFunding.mockResolvedValue([]);

    await service.getDailySummary(
      'u1',
      start,
      end,
      'ak-1',
      { tenantId: 'tenant-1' },
      'prod-1',
    );

    expect(prisma.apiKey.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'ak-1',
        tenantId: 'tenant-1',
        productId: 'prod-1',
      }),
      select: { id: true },
    });
  });

  it('uses actual funding ledgers for a team member even without an explicit API key', async () => {
    const tenant = {
      findUnique: jest.fn().mockResolvedValue({
        id: 'tenant-1',
        name: 'Team workspace',
        type: 'team',
        status: 'active',
        ownerUserId: 'owner-1',
        billingAccountId: 'ba-team-1',
        deletedAt: null,
      }),
    };
    const tenantMember = {
      findFirst: jest.fn().mockResolvedValue({
        tenantId: 'tenant-1',
        role: 'member',
        status: 'active',
      }),
      findMany: jest.fn().mockResolvedValue([{ tenantId: 'tenant-1' }]),
    };
    const billingAccount = {
      findUnique: jest.fn().mockResolvedValue({
        id: 'ba-team-1',
        type: 'personal',
        status: 'active',
        ownerUserId: 'owner-1',
        name: 'Team account',
        deletedAt: null,
      }),
    };
    const billingAccountMember = {
      findFirst: jest.fn().mockResolvedValue({
        role: 'member',
        status: 'active',
      }),
    };
    const { service, repo } = await buildService({
      tenant,
      tenantMember,
      billingAccount,
      billingAccountMember,
    });
    repo.dailyActualUsageFunding.mockResolvedValue([]);

    await service.getDailySummary(
      'u1',
      start,
      end,
      undefined,
      { tenantId: 'tenant-1' },
      'prod-1',
    );

    expect(repo.dailyActualUsageFunding).toHaveBeenCalledWith({
      userId: 'u1',
      tenantId: 'tenant-1',
      apiKeyUserId: 'u1',
      apiKeyId: undefined,
      productId: 'prod-1',
      createdAt: { gte: start, lt: end },
    });
    expect(repo.dailyBalanceConsumption).not.toHaveBeenCalled();
    expect(repo.dailyCreditConsumption).not.toHaveBeenCalled();
  });

  it('throws ForbiddenException when apiKey does not belong to user', async () => {
    const { service, prisma } = await buildService();
    prisma.apiKey.findFirst.mockResolvedValue(null);

    const { ForbiddenException } = await import('@nestjs/common');
    await expect(
      service.getDailySummary('u1', start, end, 'other-key'),
    ).rejects.toThrow(ForbiddenException);
  });

  it('returns empty array when no data in range', async () => {
    const { service, repo } = await buildService();
    repo.dailyBalanceConsumption.mockResolvedValue([]);
    repo.dailyCreditConsumption.mockResolvedValue([]);

    const rows = await service.getDailySummary('u1', start, end);
    expect(rows).toEqual([]);
  });

  it('passes tenant subject to daily balance and credit queries', async () => {
    const { service, repo } = await buildService();
    repo.dailyBalanceConsumption.mockResolvedValue([]);
    repo.dailyCreditConsumption.mockResolvedValue([]);

    await service.getDailySummary('u1', start, end, undefined, { tenantId: 'tenant-1' });

    expect(repo.dailyBalanceConsumption).toHaveBeenCalledWith('u1', start, end, {
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
    }, undefined);
    expect(repo.dailyCreditConsumption).toHaveBeenCalledWith('u1', start, end, {
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_u1',
    }, undefined);
  });

  it('passes product scope to daily balance and credit queries', async () => {
    const { service, repo } = await buildService();
    repo.dailyBalanceConsumption.mockResolvedValue([]);
    repo.dailyCreditConsumption.mockResolvedValue([]);

    await service.getDailySummary('u1', start, end, undefined, { tenantId: 'tenant-1' }, 'prod-1');

    expect(repo.dailyBalanceConsumption).toHaveBeenCalledWith(
      'u1',
      start,
      end,
      { tenantId: 'tenant-1', billingAccountId: 'ba_personal_u1' },
      'prod-1',
    );
    expect(repo.dailyCreditConsumption).toHaveBeenCalledWith(
      'u1',
      start,
      end,
      { tenantId: 'tenant-1', billingAccountId: 'ba_personal_u1' },
      'prod-1',
    );
  });
});

// ============================================================
// BillingService.getMonthlySummary
// ============================================================
describe('BillingService.getMonthlySummary', () => {
  it('returns merged monthly balance and credit data', async () => {
    const { service, repo } = await buildService();
    repo.monthlyBalanceSummary.mockResolvedValue([
      { month: new Date('2025-01-01'), consumeUsd: new Prisma.Decimal('10'), rechargeUsd: new Prisma.Decimal('50') },
    ]);
    repo.monthlyCreditSummary.mockResolvedValue([
      { month: new Date('2025-01-01'), consumeCredits: 200, grantCredits: 1000, bonusCredits: 50 },
    ]);

    const rows = await service.getMonthlySummary('u1', 2025);

    expect(rows).toHaveLength(1);
    expect(rows[0]).toEqual({
      month: '2025-01',
      balanceConsumeCents: 1000,
      balanceRechargeCents: 5000,
      creditConsume: 200,
      creditGrant: 1000,
      creditBonus: 50,
    });
  });

  it('returns rows sorted by month ascending', async () => {
    const { service, repo } = await buildService();
    repo.monthlyBalanceSummary.mockResolvedValue([
      { month: new Date('2025-03-01'), consumeUsd: new Prisma.Decimal('1'), rechargeUsd: new Prisma.Decimal('0') },
      { month: new Date('2025-01-01'), consumeUsd: new Prisma.Decimal('2'), rechargeUsd: new Prisma.Decimal('0') },
    ]);
    repo.monthlyCreditSummary.mockResolvedValue([]);

    const rows = await service.getMonthlySummary('u1', 2025);
    expect(rows[0].month).toBe('2025-01');
    expect(rows[1].month).toBe('2025-03');
  });

  it('returns empty when no data', async () => {
    const { service, repo } = await buildService();
    repo.monthlyBalanceSummary.mockResolvedValue([]);
    repo.monthlyCreditSummary.mockResolvedValue([]);

    const rows = await service.getMonthlySummary('u1', 2025);
    expect(rows).toEqual([]);
  });

  it('calls repository with correct year start/end range', async () => {
    const { service, repo } = await buildService();
    repo.monthlyBalanceSummary.mockResolvedValue([]);
    repo.monthlyCreditSummary.mockResolvedValue([]);

    await service.getMonthlySummary('u1', 2025);

    expect(repo.monthlyBalanceSummary).toHaveBeenCalledWith(
      'u1',
      new Date('2025-01-01T00:00:00.000Z'),
      new Date('2026-01-01T00:00:00.000Z'),
      { tenantId: 'tenant-1', billingAccountId: 'ba_personal_u1' },
      undefined,
    );
  });

  it('passes tenant subject to monthly balance and credit queries', async () => {
    const { service, repo } = await buildService();
    repo.monthlyBalanceSummary.mockResolvedValue([]);
    repo.monthlyCreditSummary.mockResolvedValue([]);

    await service.getMonthlySummary('u1', 2025, { tenantId: 'tenant-1' });

    expect(repo.monthlyBalanceSummary).toHaveBeenCalledWith(
      'u1',
      new Date('2025-01-01T00:00:00.000Z'),
      new Date('2026-01-01T00:00:00.000Z'),
      { tenantId: 'tenant-1', billingAccountId: 'ba_personal_u1' },
      undefined,
    );
    expect(repo.monthlyCreditSummary).toHaveBeenCalledWith(
      'u1',
      new Date('2025-01-01T00:00:00.000Z'),
      new Date('2026-01-01T00:00:00.000Z'),
      { tenantId: 'tenant-1', billingAccountId: 'ba_personal_u1' },
      undefined,
    );
  });

  it('passes product scope to monthly balance and credit queries', async () => {
    const { service, repo } = await buildService();
    repo.monthlyBalanceSummary.mockResolvedValue([]);
    repo.monthlyCreditSummary.mockResolvedValue([]);

    await service.getMonthlySummary('u1', 2025, { tenantId: 'tenant-1' }, 'prod-1');

    expect(repo.monthlyBalanceSummary).toHaveBeenCalledWith(
      'u1',
      new Date('2025-01-01T00:00:00.000Z'),
      new Date('2026-01-01T00:00:00.000Z'),
      { tenantId: 'tenant-1', billingAccountId: 'ba_personal_u1' },
      'prod-1',
    );
    expect(repo.monthlyCreditSummary).toHaveBeenCalledWith(
      'u1',
      new Date('2025-01-01T00:00:00.000Z'),
      new Date('2026-01-01T00:00:00.000Z'),
      { tenantId: 'tenant-1', billingAccountId: 'ba_personal_u1' },
      'prod-1',
    );
  });
});

// ============================================================
// BillingService.exportCsv
// ============================================================
describe('BillingService.exportCsv', () => {
  it('uses the deployment currency code in CSV headers', async () => {
    const { service, repo } = await buildService(
      {}, {}, {}, undefined, undefined, 'cny',
    );
    repo.dailyBalanceConsumption.mockResolvedValue([]);
    repo.dailyCreditConsumption.mockResolvedValue([]);

    const result = await service.exportCsv(
      'u1',
      'daily',
      new Date('2025-01-01'),
      new Date('2025-01-31'),
    );

    expect(result.csv).toContain('日期,余额消费(CNY),积分消费,Token数');
  });

  it('exports daily CSV with correct header and filename', async () => {
    const { service, repo } = await buildService();
    repo.dailyBalanceConsumption.mockResolvedValue([
      { date: new Date('2025-01-10'), totalUsd: new Prisma.Decimal('5') },
    ]);
    repo.dailyCreditConsumption.mockResolvedValue([
      { date: new Date('2025-01-10'), totalCredits: 100, totalTokens: 5000 },
    ]);

    const start = new Date('2025-01-01');
    const end = new Date('2025-01-31');
    const result = await service.exportCsv('u1', 'daily', start, end);

    expect(result.csv).toContain('日期,余额消费(USD),积分消费,Token数');
    expect(result.csv).toContain('2025-01-10,5.00,100,5000');
    expect(result.filename).toContain('billing-daily');
  });

  it('exports monthly CSV with correct header', async () => {
    const { service, repo } = await buildService();
    repo.monthlyBalanceSummary.mockResolvedValue([
      { month: new Date('2025-01-01'), consumeUsd: new Prisma.Decimal('10'), rechargeUsd: new Prisma.Decimal('50') },
    ]);
    repo.monthlyCreditSummary.mockResolvedValue([
      { month: new Date('2025-01-01'), consumeCredits: 200, grantCredits: 800, bonusCredits: 50 },
    ]);

    const result = await service.exportCsv('u1', 'monthly', undefined, undefined, 2025);

    expect(result.csv).toContain('月份,余额消费(USD),余额充值(USD),积分消费,积分发放,积分加油包');
    expect(result.csv).toContain('2025-01,10.00,50.00,200,800,50');
    expect(result.filename).toBe('billing-monthly-2025.csv');
  });

  it('exports transactions CSV with correct header', async () => {
    const { service, repo } = await buildService();
    repo.findTransactions.mockResolvedValue([
      {
        id: 'tx-1', type: 'RECHARGE', amountUsd: new Prisma.Decimal('10'),
        balanceAfterUsd: new Prisma.Decimal('10'), description: 'top-up',
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
      },
    ]);

    const result = await service.exportCsv('u1', 'transactions');

    expect(result.csv).toContain('ID,类型,金额(USD),余额(USD),关联用量ID,描述,时间');
    expect(result.csv).toContain('tx-1,RECHARGE,10,10,,"top-up"');
    expect(result.filename).toContain('billing-transactions');
  });

  it('exports CONSUME transaction amount as positive spend', async () => {
    const { service, repo } = await buildService();
    repo.findTransactions.mockResolvedValue([
      {
        id: 'tx-consume', type: 'CONSUME', amountUsd: new Prisma.Decimal('-1.23'),
        balanceAfterUsd: new Prisma.Decimal('8.77'), description: 'api call',
        createdAt: new Date('2025-01-01T00:00:00.000Z'),
      },
    ]);

    const result = await service.exportCsv('u1', 'transactions');

    expect(result.csv).toContain('tx-consume,CONSUME,1.23,8.77,,"api call"');
  });

  it('escapes double quotes in transaction descriptions', async () => {
    const { service, repo } = await buildService();
    repo.findTransactions.mockResolvedValue([
      {
        id: 'tx-2', type: 'RECHARGE', amountUsd: new Prisma.Decimal('1'),
        balanceAfterUsd: new Prisma.Decimal('1'), description: 'He said "hello"',
        createdAt: new Date(),
      },
    ]);

    const result = await service.exportCsv('u1', 'transactions');
    expect(result.csv).toContain('He said ""hello""');
  });

  it('resolves year from startDate for monthly export when year not provided', async () => {
    const { service, repo } = await buildService();
    repo.monthlyBalanceSummary.mockResolvedValue([]);
    repo.monthlyCreditSummary.mockResolvedValue([]);

    const startDate = new Date('2024-06-01');
    await service.exportCsv('u1', 'monthly', startDate, undefined, undefined);

    expect(repo.monthlyBalanceSummary).toHaveBeenCalledWith(
      'u1',
      new Date('2024-01-01T00:00:00.000Z'),
      new Date('2025-01-01T00:00:00.000Z'),
      { tenantId: 'tenant-1', billingAccountId: 'ba_personal_u1' },
      undefined,
    );
  });

  it('uses current year when neither year nor startDate provided for monthly', async () => {
    const { service, repo } = await buildService();
    repo.monthlyBalanceSummary.mockResolvedValue([]);
    repo.monthlyCreditSummary.mockResolvedValue([]);

    await service.exportCsv('u1', 'monthly');

    const currentYear = new Date().getFullYear();
    expect(repo.monthlyBalanceSummary).toHaveBeenCalledWith(
      'u1',
      new Date(`${currentYear}-01-01T00:00:00.000Z`),
      new Date(`${currentYear + 1}-01-01T00:00:00.000Z`),
      { tenantId: 'tenant-1', billingAccountId: 'ba_personal_u1' },
      undefined,
    );
  });

  it('uses default 30-day range for daily export when startDate/endDate not provided', async () => {
    const { service, repo } = await buildService();
    repo.dailyBalanceConsumption.mockResolvedValue([]);
    repo.dailyCreditConsumption.mockResolvedValue([]);

    await service.exportCsv('u1', 'daily');

    expect(repo.dailyBalanceConsumption).toHaveBeenCalled();
    // Just verify it was called — dates are dynamic
    const [, startArg] = repo.dailyBalanceConsumption.mock.calls[0];
    expect(startArg).toBeInstanceOf(Date);
  });
});

// ============================================================
// Additional branch coverage: string date handling in getDailySummary
// ============================================================
describe('BillingService.getDailySummary — string date rows', () => {
  it('handles string date in balanceRows (non-Date instance)', async () => {
    const { service, repo } = await buildService();
    repo.dailyBalanceConsumption.mockResolvedValue([
      { date: '2025-01-20', totalUsd: new Prisma.Decimal('8') }, // string date
    ]);
    repo.dailyCreditConsumption.mockResolvedValue([]);

    const rows = await service.getDailySummary('u1', new Date('2025-01-01'), new Date('2025-01-31'));
    expect(rows).toHaveLength(1);
    expect(rows[0].date).toBe('2025-01-20');
    expect(rows[0].balanceConsumptionCents).toBe(800);
  });

  it('handles string date in creditRows (non-Date instance)', async () => {
    const { service, repo } = await buildService();
    repo.dailyBalanceConsumption.mockResolvedValue([]);
    repo.dailyCreditConsumption.mockResolvedValue([
      { date: '2025-01-22', totalCredits: 50, totalTokens: 2500 }, // string date
    ]);

    const rows = await service.getDailySummary('u1', new Date('2025-01-01'), new Date('2025-01-31'));
    expect(rows[0].date).toBe('2025-01-22');
    expect(rows[0].creditConsumption).toBe(50);
  });

  it('handles string date in apiKey token usage rows', async () => {
    const { service, repo, prisma } = await buildService();
    prisma.apiKey.findFirst.mockResolvedValue({ id: 'ak-1' });
    repo.dailyActualUsageFunding.mockResolvedValue([
      {
        date: '2025-01-15',
        balanceConsumptionUsd: new Prisma.Decimal('1.5'),
        creditConsumption: 0,
        totalTokens: 7500,
      }, // string date
    ]);

    const rows = await service.getDailySummary('u1', new Date('2025-01-01'), new Date('2025-01-31'), 'ak-1');
    expect(rows[0].date).toBe('2025-01-15');
  });
});

describe('BillingService.assertCodingPlanEntitlementAccess scope privacy', () => {
  it('returns the same 404 for an entitlement outside the requested product', async () => {
    const codingPlanEntitlement = {
      findFirst: jest.fn().mockResolvedValue(null),
    };
    const { service } = await buildService({ codingPlanEntitlement });

    await expect(service.assertCodingPlanEntitlementAccess('u1', 'ent-other-product', {
      productId: 'prod-1',
      tenantId: 'tenant-1',
    })).rejects.toBeInstanceOf(NotFoundException);

    expect(codingPlanEntitlement.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'ent-other-product',
        tenantId: { in: ['tenant-1'] },
        productId: 'prod-1',
      },
    });
  });

  it('returns 404 without querying an entitlement when the actor has no matching subject', async () => {
    const codingPlanEntitlement = {
      findFirst: jest.fn(),
    };
    const tenantMember = {
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
    };
    const { service } = await buildService({ codingPlanEntitlement, tenantMember });

    await expect(service.assertCodingPlanEntitlementAccess('u1', 'ent-other-tenant', {
      productId: 'prod-1',
      tenantId: 'tenant-2',
    })).rejects.toBeInstanceOf(NotFoundException);

    expect(codingPlanEntitlement.findFirst).not.toHaveBeenCalled();
  });
});

// ============================================================
// Additional branch coverage: string month in getMonthlySummary
// ============================================================
describe('BillingService.getMonthlySummary — string month rows', () => {
  it('handles string month in balanceRows', async () => {
    const { service, repo } = await buildService();
    repo.monthlyBalanceSummary.mockResolvedValue([
      { month: '2025-03-01T00:00:00.000Z', consumeUsd: new Prisma.Decimal('1'), rechargeUsd: new Prisma.Decimal('2') },
    ]);
    repo.monthlyCreditSummary.mockResolvedValue([]);

    const rows = await service.getMonthlySummary('u1', 2025);
    expect(rows[0].month).toBe('2025-03');
  });

  it('handles string month in creditRows', async () => {
    const { service, repo } = await buildService();
    repo.monthlyBalanceSummary.mockResolvedValue([]);
    repo.monthlyCreditSummary.mockResolvedValue([
      { month: '2025-06-01T00:00:00.000Z', consumeCredits: 300, grantCredits: 1000, bonusCredits: 100 },
    ]);

    const rows = await service.getMonthlySummary('u1', 2025);
    expect(rows[0].month).toBe('2025-06');
    expect(rows[0].creditConsume).toBe(300);
  });

  it('merges credit data into existing balance month entry', async () => {
    const { service, repo } = await buildService();
    repo.monthlyBalanceSummary.mockResolvedValue([
      { month: new Date('2025-02-01'), consumeUsd: new Prisma.Decimal('5'), rechargeUsd: new Prisma.Decimal('20') },
    ]);
    repo.monthlyCreditSummary.mockResolvedValue([
      { month: new Date('2025-02-01'), consumeCredits: 100, grantCredits: 500, bonusCredits: 0 },
    ]);

    const rows = await service.getMonthlySummary('u1', 2025);
    expect(rows).toHaveLength(1);
    expect(rows[0].balanceConsumeCents).toBe(500);
    expect(rows[0].creditConsume).toBe(100);
  });
});

// ============================================================
// toPlan: features null/empty fallback (line 59)
// ============================================================
describe('BillingService.toPlan — features fallback', () => {
  it('toPlan parses null features as empty array via getPlans', async () => {
    const { service, repo } = await buildService();
    repo.findActivePlans.mockResolvedValue([
      {
        id: 'p1', productId: 'px', name: 'Free', description: '',
        planType: 'MONTHLY', monthlyPrice: 0, yearlyPrice: 0, billingPeriod: 'MONTHLY',
        monthlyCredits: 0, creditsRollover: false, rolloverMaxMonths: 0,
        rateLimitRpm: 0, rateLimitTpm: 0, maxContextWindow: 0,
        overageEnabled: false, usageMultiplier: 1, memberLimit: 1, minimumSeats: 1,
        dataTraining: false, supportTier: 'none', ssoEnabled: false, priorityAccess: false,
        badge: null, trialDays: 0,
        features: null, // test the || '[]' branch
        isActive: true, isLegacy: false, sortOrder: 1,
        createdAt: new Date(), updatedAt: new Date(),
      },
    ]);
    const plans = await service.getPlans();
    expect(plans[0].features).toEqual([]);
  });
});

// ============================================================
// P2-C: BillingService.deduct hook (CreditPolicy gating)
// ============================================================
describe('BillingService.sweepEnterpriseCreditResidualSettlement', () => {
  it('fails closed when the account aggregate has no wallet', async () => {
    const { service, prisma } = await buildService();
    configureEnterpriseBillingSubject(prisma, {
      limitUsd: new Prisma.Decimal(100),
      status: 'active',
      termsDays: 30,
      effectiveAt: null,
      expiresAt: null,
    });
    prisma.__deleteWallet('ba_personal_u1');

    let caught: unknown;
    try {
      await service.sweepEnterpriseCreditResidualSettlement('ba_personal_u1');
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      status: 409,
      response: { code: 'billing_account_not_provisioned' },
    });
    expect(prisma.balanceConsumptionAllocation.aggregate).not.toHaveBeenCalled();
    expect(prisma.enterpriseCreditSettlement.create).not.toHaveBeenCalled();
  });

  // 【2026-09-21 国内 prod 充值事故回归】核销触达路径的事务必须带 60s 预算:
  // 裸 $transaction 默认 5s,大账户欠款核销一个窗口实测 32.9s —— 事务 5s 过期后
  // 抛 Transaction already closed,过期事务回滚前持有的钱包行锁把并发充值一起
  // 拖进超时回滚(adminRecharge rolled_back → 客户侧 500)。
  it('runs the settlement sweep inside a 60s-budgeted transaction, not the 5s default', async () => {
    const { service, prisma } = await buildService();
    configureEnterpriseBillingSubject(prisma, {
      limitUsd: new Prisma.Decimal(100),
      status: 'active',
      termsDays: 30,
      effectiveAt: null,
      expiresAt: null,
    });

    await service.sweepEnterpriseCreditResidualSettlement('ba_personal_u1');

    const options = (prisma.$transaction as jest.Mock).mock.calls
      .map((call) => call[1])
      .find((opt: unknown) => typeof opt === 'object' && opt !== null);
    expect(options).toBeDefined();
    expect((options as { timeout?: number }).timeout).toBeGreaterThanOrEqual(60_000);
  });

  it('drains pending settlement rows inside the same 60s-budgeted transaction', async () => {
    const { service, prisma } = await buildService();
    (prisma.$queryRaw as jest.Mock).mockImplementationOnce(jest.fn().mockResolvedValue([{
      id: 'pending-1',
      billing_account_id: 'ba_personal_u1',
      allocation_source: 'ENTERPRISE_CREDIT',
      repayment_transaction_id: 'repay-1',
      balance_grant_id: null,
      remaining_paid_usd: new Prisma.Decimal('1'),
      remaining_bonus_usd: new Prisma.Decimal('0'),
    }]));
    prisma.balanceTransaction.findUnique.mockResolvedValue({
      billingAccountId: 'ba_personal_u1',
      createdAt: new Date('2026-09-21T10:00:00Z'),
    });

    // 本用例只钉事务预算:mock 环境没有负余额欠款,核销本身会被守恒断言拒绝
    // (BALANCE_LEDGER_RECONCILIATION_REQUIRED),这与预算无关 —— 断言只看
    // $transaction 是否带着 60s options 打开过。
    await expect(service.settlePendingBalanceDebtOnce()).rejects.toThrow(
      /BALANCE_LEDGER_RECONCILIATION_REQUIRED/,
    );

    const options = (prisma.$transaction as jest.Mock).mock.calls
      .map((call) => call[1])
      .find((opt: unknown) => typeof opt === 'object' && opt !== null);
    expect(options).toBeDefined();
    expect((options as { timeout?: number }).timeout).toBeGreaterThanOrEqual(60_000);
  });
});


describe('BillingService.sweepEnterpriseCreditResidualSettlement — pending 互斥', () => {
  // 【2026-09-22 回归】pending 队列未排空时 sweep 必须安静跳过,不得进入
  // settleBalanceDebtOnFunding 的前置断言 —— residualUsd 的推导没扣 pending,
  // pending>0 时前置必不匹配,修前表现为每轮 sweep 报
  // BALANCE_LEDGER_RECONCILIATION_REQUIRED error(数字其实平)。
  it('pending>0 时本轮跳过且不触发核销', async () => {
    const { service, prisma } = await buildService();
    configureEnterpriseBillingSubject(prisma, {
      limitUsd: new Prisma.Decimal(100),
      status: 'active',
      termsDays: 30,
      effectiveAt: null,
      expiresAt: null,
    });
    // 钱包 -1(有 tracked debt),挂账 5 ⇒ residual=4>0;pending=2 在排空
    const rawMock = prisma.$queryRaw as jest.Mock;
    const origRaw = rawMock.getMockImplementation();
    rawMock.mockImplementation(async (parts: TemplateStringsArray | unknown[], ...values: unknown[]) => {
      const sql = Array.isArray(parts) ? parts.join(' ') : String(parts);
      if (sql.includes('FROM "account_wallets"')) {
        return [{ balance_usd: new Prisma.Decimal(-1) }];
      }
      return origRaw ? origRaw(parts, ...values) : undefined;
    });
    prisma.balanceConsumptionAllocation.aggregate.mockResolvedValue({
      _sum: { amountUsd: new Prisma.Decimal(5), settledUsd: new Prisma.Decimal(0) },
    });
    prisma.balanceDebtSettlementPending.aggregate.mockResolvedValue({
      _sum: { remainingPaidUsd: new Prisma.Decimal(2), remainingBonusUsd: new Prisma.Decimal(0) },
    });

    const settled = await service.sweepEnterpriseCreditResidualSettlement('ba_personal_u1');

    expect(settled).toBe(0);
    expect(prisma.enterpriseCreditSettlement.create).not.toHaveBeenCalled();
  });

  it('pending=0 时照常进入核销(不误伤正常路径)', async () => {
    const { service, prisma } = await buildService();
    configureEnterpriseBillingSubject(prisma, {
      limitUsd: new Prisma.Decimal(100),
      status: 'active',
      termsDays: 30,
      effectiveAt: null,
      expiresAt: null,
    });
    const rawMock2 = prisma.$queryRaw as jest.Mock;
    const origRaw2 = rawMock2.getMockImplementation();
    rawMock2.mockImplementation(async (parts: TemplateStringsArray | unknown[], ...values: unknown[]) => {
      const sql = Array.isArray(parts) ? parts.join(' ') : String(parts);
      if (sql.includes('FROM "account_wallets"')) {
        return [{ balance_usd: new Prisma.Decimal(-1) }];
      }
      return origRaw2 ? origRaw2(parts, ...values) : undefined;
    });
    prisma.balanceConsumptionAllocation.aggregate.mockResolvedValue({
      _sum: { amountUsd: new Prisma.Decimal(5), settledUsd: new Prisma.Decimal(0) },
    });
    prisma.balanceDebtSettlementPending.aggregate.mockResolvedValue({
      _sum: { remainingPaidUsd: null, remainingBonusUsd: null },
    });

    // residual=4>0 且 pending=0 ⇒ 不得被新逻辑短路:必须真正进入 settleBalanceDebtOnFunding。
    // 以其前置断言抛错为证(mock 环境的 snapshot 复合查询读不到同一份钱包数,
    // 前置必炸 —— 炸的是 precondition 而非静默返回 0,即证明未被跳过)。
    await expect(service.sweepEnterpriseCreditResidualSettlement('ba_personal_u1'))
      .rejects.toThrow(/funding settlement precondition/);
  });
});

describe('BillingService.deduct — CreditPolicy hook', () => {
  it('Optional injection: deduct works as before when CreditPolicyService NOT wired (退化为现状)', async () => {
    const { service, redis, prisma } = await buildService();
    redis.get.mockResolvedValue(null);
    prisma.__setWalletBalance('u1', 50);

    const result = await service.deduct('u1', new Prisma.Decimal('20'), 'no policy');

    expect(result.success).toBe(true);
    expect(result.balance).toBe(3000);
    expect(redis.call).not.toHaveBeenCalled();
  });

  it('allowOverdraft=false → policy hook treats limit as 0; rejects pre-Lua when balance-amount < 0', async () => {
    const policy = { resolvePolicyForUser: jest.fn().mockResolvedValue({ allowOverdraft: false, creditLimitCents: 0 }) };
    const { service, redis, repo, prisma } = await buildService({}, {}, {}, policy);
    redis.get.mockResolvedValue(null);
    prisma.__setWalletBalance('u1', 5);

    const result = await service.deduct('u1', new Prisma.Decimal('20'), 'overuse');

    expect(result.success).toBe(false);
    expect(result.balance).toBe(500);
    expect(redis.call).not.toHaveBeenCalled();
    expect(repo.createTransaction).not.toHaveBeenCalled();
  });

  it('allowOverdraft=true creditLimit=10000 → permits balance going to -10000 (前置 hook 通过)', async () => {
    const policy = { resolvePolicyForUser: jest.fn().mockResolvedValue({ allowOverdraft: true, creditLimitCents: 10000 }) };
    const { service, redis, prisma } = await buildService({}, {}, {}, policy);
    redis.get.mockResolvedValue(null);
    prisma.__setWalletBalance('u1', 5);

    // 500 - 2000 = -1500;policy limit=10000 → -1500 >= -10000 → 前置 hook 放行
    const result = await service.deduct('u1', new Prisma.Decimal('20'), 'overdraft within limit');

    expect(result.success).toBe(true);
    expect(result.balance).toBe(-1500);
    expect(redis.call).not.toHaveBeenCalled();
    expect(policy.resolvePolicyForUser).toHaveBeenCalledWith('u1');
  });

  // P2-C review fix(Important #2): 透支放行必须留审计日志,关键字 credit_overdraft_used
  it('logs credit_overdraft_used when overdraft is permitted (审计)', async () => {
    const policy = { resolvePolicyForUser: jest.fn().mockResolvedValue({ allowOverdraft: true, creditLimitCents: 10000 }) };
    const { service, redis, prisma } = await buildService({}, {}, {}, policy);
    redis.get.mockResolvedValue(null);
    prisma.__setWalletBalance('u1', 5);

    // 拦截 Logger.prototype.log
    const logSpy = jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);

    await service.deduct('u1', new Prisma.Decimal('20'), 'overdraft audit');

    const logged = logSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(logged).toContain('credit_overdraft_used');
    expect(logged).toContain('user=u1');
    expect(logged).toContain('amountUsd=20');
    expect(logged).toContain('currentBalanceUsd=5');
    expect(logged).toContain('limitUsd=100');
    expect(logged).toContain('projectedBalanceUsd=-15');

    logSpy.mockRestore();
  });

  it('does NOT log credit_overdraft_used when balance stays >= 0 after deduct', async () => {
    const policy = { resolvePolicyForUser: jest.fn().mockResolvedValue({ allowOverdraft: true, creditLimitCents: 10000 }) };
    const { service, redis, prisma } = await buildService({}, {}, {}, policy);
    redis.get.mockResolvedValue(null);
    prisma.__setWalletBalance('u1', 50);

    const logSpy = jest.spyOn((service as any).logger, 'log').mockImplementation(() => undefined);

    await service.deduct('u1', new Prisma.Decimal('20'), 'no overdraft');

    const logged = logSpy.mock.calls.map((c) => c[0] as string).join('\n');
    expect(logged).not.toContain('credit_overdraft_used');

    logSpy.mockRestore();
  });

  it('allowOverdraft=true creditLimit=10000 → rejects when would exceed limit', async () => {
    const policy = { resolvePolicyForUser: jest.fn().mockResolvedValue({ allowOverdraft: true, creditLimitCents: 10000 }) };
    const { service, redis, repo, prisma } = await buildService({}, {}, {}, policy);
    redis.get.mockResolvedValue(null);
    prisma.__setWalletBalance('u1', 1);

    // 100 - 20000 = -19900,超过 -10000 → reject
    const result = await service.deduct('u1', new Prisma.Decimal('200'), 'too much');

    expect(result.success).toBe(false);
    expect(result.balance).toBe(100);
    expect(redis.call).not.toHaveBeenCalled();
    expect(repo.createTransaction).not.toHaveBeenCalled();
  });

  it('policy hook throws → falls back to strict no-overdraft (defensive)', async () => {
    const policy = { resolvePolicyForUser: jest.fn().mockRejectedValue(new Error('boom')) };
    const { service, redis, repo, prisma } = await buildService({}, {}, {}, policy);
    redis.get.mockResolvedValue(null);
    prisma.__setWalletBalance('u1', 5);

    // 500 - 2000 = -1500 < 0 → strict reject
    const result = await service.deduct('u1', new Prisma.Decimal('20'), 'fallback strict');

    expect(result.success).toBe(false);
    expect(redis.call).not.toHaveBeenCalled();
    expect(repo.createTransaction).not.toHaveBeenCalled();
  });

  it('policy hook throws but balance sufficient → still continues to Lua', async () => {
    const policy = { resolvePolicyForUser: jest.fn().mockRejectedValue(new Error('boom')) };
    const { service, redis, prisma } = await buildService({}, {}, {}, policy);
    redis.get.mockResolvedValue(null);
    prisma.__setWalletBalance('u1', 50);

    const result = await service.deduct('u1', new Prisma.Decimal('20'), 'fallback ok');

    expect(result.success).toBe(true);
    expect(result.balance).toBe(3000);
  });

  it('policy hook throws non-Error (string) → warn message uses fallback string', async () => {
    // 覆盖 catch 内 `(err as Error)?.message ?? err` 的 ?? err 分支:
    // 当 throw 的不是 Error 实例时 (.?.message 为 undefined),走 `err` 兜底
    const policy = { resolvePolicyForUser: jest.fn().mockRejectedValue('plain string error') };
    const { service, redis, prisma } = await buildService({}, {}, {}, policy);
    redis.get.mockResolvedValue(null);
    prisma.__setWalletBalance('u1', 5);

    const result = await service.deduct('u1', new Prisma.Decimal('20'), 'string err fallback');
    // 余额不足 + hook 失败 → 严格拒绝
    expect(result.success).toBe(false);
  });

  it('policy returns conservative {allowOverdraft:false, creditLimitCents:0} → equivalent to strict mode', async () => {
    const policy = { resolvePolicyForUser: jest.fn().mockResolvedValue({ allowOverdraft: false, creditLimitCents: 0 }) };
    const { service, redis, prisma } = await buildService({}, {}, {}, policy);
    redis.get.mockResolvedValue(null);
    prisma.__setWalletBalance('u1', 50);

    // 5000 - 2000 = 3000 > 0 → 前置 hook 通过 → Lua 也通过
    const result = await service.deduct('u1', new Prisma.Decimal('20'), 'within balance');
    expect(result.success).toBe(true);
  });
});

// ============================================================
// BillingService.provisionSelfOperatedEntitlement (F1b 单一活跃 + 续订 + 切换)
// ============================================================

describe('BillingService.provisionSelfOperatedEntitlement', () => {
  async function setupCpe(over: {
    existingForOrder?: any;
    activeSelf?: any;
    createReturn?: any;
    refreshReturn?: any;
    prorationOrder?: any; // 本订单 proration 字段（换档抵扣安全闸读取）；默认无抵扣 → 不触发闸
  }) {
    const cpe = {
      findUnique: jest.fn(),
      findFirst: jest.fn().mockResolvedValue(over.activeSelf ?? null),
      create: jest.fn().mockResolvedValue(over.createReturn ?? { id: 'ent-new', status: 'ACTIVE' }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }), // expired-ACTIVE → EXPIRED 收敛
    };
    // findUnique: 1st = existingForOrder(by orderId); 后续(续订 refresh by id) = refreshReturn
    cpe.findUnique
      .mockResolvedValueOnce(over.existingForOrder ?? null)
      .mockResolvedValue(over.refreshReturn ?? over.activeSelf ?? null);
    const apiKey = { updateMany: jest.fn().mockResolvedValue({ count: 0 }) };
    const ctx = await buildService({
      plan: { findUnique: jest.fn().mockResolvedValue({ validityDays: 30 }) },
      codingPlanEntitlement: cpe,
      order: { findUnique: jest.fn().mockResolvedValue(over.prorationOrder ?? null) },
      apiKey,
    });
    // makePrisma 的 $transaction 闭包指向其内部 prisma（无 codingPlanEntitlement 委托）；
    // 重绑到合并后的 prisma，使事务回调里 tx === 含 cpe/apiKey 的对象。
    ctx.prisma.$transaction = jest.fn((fn: any) => fn(ctx.prisma));
    return { ...ctx, cpe, apiKey };
  }

  const baseInput = {
    orderId: 'order-1',
    userId: 'u1',
    tenantId: 't1',
    productId: 'prod-cp',
    planId: 'plan-lite',
    billingPeriod: 'monthly' as const,
  };

  it('creates a new ACTIVE entitlement when none exists, and grants monthly', async () => {
    const { service, prisma, cpe, apiKey } = await setupCpe({
      activeSelf: null,
      createReturn: { id: 'ent-new', status: 'ACTIVE' },
    });

    const r = await service.provisionSelfOperatedEntitlement(baseInput);

    expect(r.action).toBe('created');
    expect(r.monthlyGrantNeeded).toBe(true);
    expect(r.rebindFromEntitlementId).toBeNull();
    expect(prisma.$executeRaw).toHaveBeenCalled(); // advisory lock
    expect(cpe.updateMany).toHaveBeenCalled(); // expired-ACTIVE 收敛
    expect(cpe.create).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ orderId: 'order-1', status: 'ACTIVE' }) }),
    );
    expect(apiKey.updateMany).not.toHaveBeenCalled();
  });

  it('renews (extends expiresAt, no new monthly grant) when an active same-tier plan exists', async () => {
    const future = new Date(Date.now() + 10 * 24 * 3600 * 1000);
    const activeSelf = { id: 'ent-old', planId: 'plan-lite', expiresAt: future, status: 'ACTIVE' };
    const { service, cpe, apiKey } = await setupCpe({
      activeSelf,
      existingForOrder: null,
      refreshReturn: { ...activeSelf, expiresAt: new Date(future.getTime() + 30 * 24 * 3600 * 1000) },
    });

    const r = await service.provisionSelfOperatedEntitlement(baseInput); // same planId

    expect(r.action).toBe('renewed');
    expect(r.monthlyGrantNeeded).toBe(false);
    expect(r.rebindFromEntitlementId).toBeNull();
    expect(cpe.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ent-old' },
        data: expect.objectContaining({ expiresAt: expect.any(Date) }),
      }),
    );
    // 本订单审计行（CANCELLED，不撞 partial unique）
    expect(cpe.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'CANCELLED', lastError: 'renewal-of:ent-old' }),
      }),
    );
    expect(apiKey.updateMany).not.toHaveBeenCalled();
  });

  it('rejects a new purchase while the current entitlement is REFUNDING', async () => {
    const activeSelf = {
      id: 'ent-refunding',
      planId: 'plan-lite',
      expiresAt: new Date(Date.now() + 10 * 24 * 3600 * 1000),
      status: 'REFUNDING',
    };
    const { service, cpe, apiKey } = await setupCpe({
      activeSelf,
      existingForOrder: null,
    });

    await expect(
      service.provisionSelfOperatedEntitlement(baseInput),
    ).rejects.toThrow('正在退款处理中');
    expect(cpe.update).not.toHaveBeenCalled();
    expect(cpe.create).not.toHaveBeenCalled();
    expect(apiKey.updateMany).not.toHaveBeenCalled();
  });

  it('short-circuits as no-op on renewal-audit replay (CANCELLED row) — no re-extend/grant/rebind', async () => {
    const { service, cpe, apiKey } = await setupCpe({
      existingForOrder: { id: 'ent-old', status: 'CANCELLED' }, // 本订单已落行（续订审计行）
    });

    const r = await service.provisionSelfOperatedEntitlement(baseInput);

    expect(r.action).toBe('noop');
    expect(r.monthlyGrantNeeded).toBe(false); // 非 ACTIVE → 不发月度
    expect(r.rebindFromEntitlementId).toBeNull();
    expect(cpe.update).not.toHaveBeenCalled();
    expect(cpe.create).not.toHaveBeenCalled();
    expect(cpe.findFirst).not.toHaveBeenCalled(); // 短路在 activeSelf 查询之前
    expect(apiKey.updateMany).not.toHaveBeenCalled();
  });

  it('switches (cancel old → new ACTIVE → rebind keys) on cross-tier purchase', async () => {
    const activeSelf = {
      id: 'ent-old',
      planId: 'plan-lite',
      expiresAt: new Date(Date.now() + 5 * 86400000),
      status: 'ACTIVE',
    };
    const { service, cpe, apiKey } = await setupCpe({
      activeSelf,
      existingForOrder: null,
      createReturn: { id: 'ent-pro', status: 'ACTIVE' },
    });

    const r = await service.provisionSelfOperatedEntitlement({ ...baseInput, planId: 'plan-pro' }); // different tier

    expect(r.action).toBe('switched');
    expect(r.monthlyGrantNeeded).toBe(true);
    expect(r.rebindFromEntitlementId).toBe('ent-old');
    // cancel old BEFORE create new (write order for partial unique)
    expect(cpe.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'ent-old' },
        data: expect.objectContaining({ status: 'CANCELLED' }),
      }),
    );
    // rebind old keys to the new entitlement
    expect(apiKey.updateMany).toHaveBeenCalledWith({
      where: { codingPlanEntitlementId: 'ent-old' },
      data: { codingPlanEntitlementId: 'ent-pro' },
    });
  });

  it('created-order replay with ACTIVE row → noop, but still lets grantQuota dedup (crash-recovery)', async () => {
    const { service, cpe } = await setupCpe({
      existingForOrder: { id: 'ent-new', status: 'ACTIVE' },
    });

    const r = await service.provisionSelfOperatedEntitlement(baseInput);

    expect(r.action).toBe('noop');
    // ACTIVE 订单重放：仍返回 true，由 grantQuota 的 quotaIdempotencyKey 去重——
    // 修复 provision 已提交但 grant 前崩溃导致首月额度永不补发。
    expect(r.monthlyGrantNeeded).toBe(true);
    expect(cpe.create).not.toHaveBeenCalled();
  });

  // ---- 换档抵扣安全闸（codex P0：并发/重复下单下同一旧套餐剩余价值被重复抵扣）----
  // 按「源 entitlement id」精确锚定（非 planId）：planId 相同不足以证明是同一份资产（切走再切回同档）。
  it('携带 proration 且当前 ACTIVE 就是定价源 entitlement → 放行异档切换', async () => {
    const activeSelf = {
      id: 'ent-old',
      planId: 'plan-lite',
      expiresAt: new Date(Date.now() + 5 * 86400000),
      status: 'ACTIVE',
    };
    const { service, cpe } = await setupCpe({
      activeSelf,
      existingForOrder: null,
      createReturn: { id: 'ent-pro', status: 'ACTIVE' },
      prorationOrder: { prorationCreditCents: 5000, prorationSourceEntitlementId: 'ent-old' },
    });

    const r = await service.provisionSelfOperatedEntitlement({ ...baseInput, planId: 'plan-pro' });

    expect(r.action).toBe('switched');
    expect(cpe.create).toHaveBeenCalled();
  });

  it('携带 proration 但源 entitlement 已被切走（当前 ACTIVE.id ≠ 定价源 id）→ 拒绝履约（防重复抵扣）', async () => {
    // 并发场景：另一张订单已把 ent-old 切成 ent-pro；本订单仍按 ent-old 抵扣 → 来源失效。
    const activeSelf = {
      id: 'ent-pro',
      planId: 'plan-pro',
      expiresAt: new Date(Date.now() + 5 * 86400000),
      status: 'ACTIVE',
    };
    const { service, cpe } = await setupCpe({
      activeSelf,
      existingForOrder: null,
      prorationOrder: { prorationCreditCents: 5000, prorationSourceEntitlementId: 'ent-old' },
    });

    await expect(
      service.provisionSelfOperatedEntitlement({ ...baseInput, planId: 'plan-max' }),
    ).rejects.toThrow('换档抵扣来源已失效');
    expect(cpe.create).not.toHaveBeenCalled(); // 事务内抛错，无任何履约写入
  });

  it('切走→再切回同档：planId 相同但已是另一份 entitlement（id 不同）→ 拒绝（planId 相同不足证同一性）', async () => {
    // 定价源 ent-old(plan-lite) 已被切走；用户又切回 plan-lite 生成新 ent-relite(id 不同)。
    // 旧订单再支付：当前 ACTIVE.planId 与源一致(plan-lite)，但 id 不同 → 必须拒绝。
    const activeSelf = {
      id: 'ent-relite',
      planId: 'plan-lite',
      expiresAt: new Date(Date.now() + 5 * 86400000),
      status: 'ACTIVE',
    };
    const { service, cpe } = await setupCpe({
      activeSelf,
      existingForOrder: null,
      prorationOrder: { prorationCreditCents: 5000, prorationSourceEntitlementId: 'ent-old' },
    });

    await expect(
      service.provisionSelfOperatedEntitlement({ ...baseInput, planId: 'plan-pro' }),
    ).rejects.toThrow('换档抵扣来源已失效');
    expect(cpe.create).not.toHaveBeenCalled();
  });

  it('携带 proration 但当前 ACTIVE.id === 源、planId === 目标档（解析为续订）→ 拒绝（无源可弃，防双抵）', async () => {
    const activeSelf = {
      id: 'ent-pro',
      planId: 'plan-pro',
      expiresAt: new Date(Date.now() + 5 * 86400000),
      status: 'ACTIVE',
    };
    const { service, cpe } = await setupCpe({
      activeSelf,
      existingForOrder: null,
      prorationOrder: { prorationCreditCents: 5000, prorationSourceEntitlementId: 'ent-pro' }, // id 匹配
    });

    await expect(
      service.provisionSelfOperatedEntitlement({ ...baseInput, planId: 'plan-pro' }), // 同档 → 续订
    ).rejects.toThrow('换档抵扣来源已失效');
    expect(cpe.update).not.toHaveBeenCalled();
  });

  it('携带 proration 但源 entitlement id 缺失（历史/异常单）→ 拒绝（源 id 必填，不放行）', async () => {
    const activeSelf = {
      id: 'ent-old',
      planId: 'plan-lite',
      expiresAt: new Date(Date.now() + 5 * 86400000),
      status: 'ACTIVE',
    };
    const { service, cpe } = await setupCpe({
      activeSelf,
      existingForOrder: null,
      prorationOrder: { prorationCreditCents: 5000, prorationSourceEntitlementId: null },
    });

    await expect(
      service.provisionSelfOperatedEntitlement({ ...baseInput, planId: 'plan-pro' }),
    ).rejects.toThrow('换档抵扣来源已失效');
    expect(cpe.create).not.toHaveBeenCalled();
  });

  it('携带 proration 但当前无 ACTIVE 自营（源已到期释放）→ 拒绝（无源可抵）', async () => {
    const { service, cpe } = await setupCpe({
      activeSelf: null,
      existingForOrder: null,
      prorationOrder: { prorationCreditCents: 5000, prorationSourceEntitlementId: 'ent-old' },
    });

    await expect(
      service.provisionSelfOperatedEntitlement({ ...baseInput, planId: 'plan-pro' }),
    ).rejects.toThrow('换档抵扣来源已失效');
    expect(cpe.create).not.toHaveBeenCalled();
  });

  it('无 proration 的普通订单不受安全闸影响（prorationCreditCents 缺省）', async () => {
    const activeSelf = {
      id: 'ent-old',
      planId: 'plan-lite',
      expiresAt: new Date(Date.now() + 5 * 86400000),
      status: 'ACTIVE',
    };
    const { service } = await setupCpe({
      activeSelf,
      existingForOrder: null,
      createReturn: { id: 'ent-pro', status: 'ACTIVE' },
      // prorationOrder 缺省 → order.findUnique 返回 null → 闸跳过
    });

    const r = await service.provisionSelfOperatedEntitlement({ ...baseInput, planId: 'plan-pro' });
    expect(r.action).toBe('switched');
  });
});
