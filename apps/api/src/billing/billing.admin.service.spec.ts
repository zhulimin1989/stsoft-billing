import { BadRequestException } from '@nestjs/common';
import { mkdtemp, readFile, readdir, rm, writeFile } from 'fs/promises';
import { tmpdir } from 'os';
import { join } from 'path';
import { BillingAdminService } from './billing.admin.service';
import {
  BalanceTransactionAttributionSource,
  CodingPlanFulfillmentMode,
  OrderStatus,
  Prisma,
  ProductBillingMode,
  TransactionType,
} from '@prisma/client';

// ---------------------------------------------------------------------------
// Mock factories
// ---------------------------------------------------------------------------

function makeRepo() {
  return {
    findOrders: jest.fn(),
    countOrders: jest.fn(),
    findTransactions: jest.fn(),
    countTransactions: jest.fn(),
    getStats: jest.fn(),
    getRevenue: jest.fn(),
    getRevenueOverview: jest.fn(),
    findPlans: jest.fn(),
    findPlanById: jest.fn(),
    upsertPlan: jest.fn(),
    updatePlan: jest.fn(),
    findProductById: jest.fn(),
  };
}

function makePrisma() {
  return {
    order: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      updateMany: jest.fn(),
      count: jest.fn(),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    orderAuditLog: {
      create: jest.fn(),
    },
    product: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn(),
    },
    plan: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      upsert: jest.fn(),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $executeRawUnsafe: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockImplementation((query: any) => {
      const sql = query?.strings?.join('') ?? '';
      if (sql.includes('pg_export_snapshot')) {
        return Promise.resolve([{ snapshotId: '00000003-0000001B-1' }]);
      }
      return Promise.resolve([
        { asOf: new Date('2026-08-15T00:00:00.000Z') },
      ]);
    }),
    planPrice: {
      upsert: jest.fn(),
    },
    codingPlanProviderLine: {
      findUnique: jest.fn(),
    },
    codingPlanProviderProduct: {
      findUnique: jest.fn(),
    },
    codingPlanEntitlement: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    codingPlanResaleRoute: {
      findUnique: jest.fn(),
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      deleteMany: jest.fn(),
    },
    modelAccess: {
      deleteMany: jest.fn(),
    },
    modelRoutePolicy: {
      deleteMany: jest.fn(),
    },
    planQuotaRule: {
      deleteMany: jest.fn(),
    },
    boosterPack: {
      findMany: jest.fn(),
    },
    bundleSku: {
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    bundleSkuItem: {
      deleteMany: jest.fn(),
      count: jest.fn(),
    },
    financeExportJob: {
      create: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      deleteMany: jest.fn(),
    },
    orderItem: {
      count: jest.fn(),
    },
    subscriptionPeriod: {
      count: jest.fn(),
    },
    campaign: {
      count: jest.fn(),
    },
    discountCode: {
      count: jest.fn(),
    },
    tenantProductEntitlement: {
      count: jest.fn(),
    },
    invoiceApplicationItem: {
      findMany: jest.fn(),
    },
    modelPricing: {
      findMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };
}

function makePaymentService() {
  return {
    refundOrder: jest.fn().mockResolvedValue({ refundId: 'ref-1' }),
    retryFulfill: jest.fn().mockResolvedValue(undefined),
  };
}

function makeProductSync() {
  return {
    notifyProductSaas: jest.fn().mockResolvedValue(undefined),
  };
}

function makePaymentProviderRegistry() {
  return {
    get: jest.fn(),
  };
}

function makeSystemConfigService(currency = 'usd', region = 'overseas') {
  return {
    getDeploymentConfig: jest.fn().mockResolvedValue({ currency, region }),
  };
}

function buildService(
  opts: {
    withRegistry?: boolean;
    prismaOverrides?: Partial<ReturnType<typeof makePrisma>>;
    repoOverrides?: Partial<ReturnType<typeof makeRepo>>;
    systemConfigOverrides?: Partial<ReturnType<typeof makeSystemConfigService>>;
    financeUserIdentityOverrides?: {
      resolveSearch?: jest.Mock;
      getContactsByIds?: jest.Mock;
    };
  } = {},
) {
  const repo = { ...makeRepo(), ...(opts.repoOverrides ?? {}) };
  const basePrisma = makePrisma();
  const prisma = { ...basePrisma, ...(opts.prismaOverrides ?? {}) };
  if (!prisma.$transaction.getMockImplementation()) {
    prisma.$transaction.mockImplementation((cb: (tx: any) => Promise<any>) => cb(prisma));
  }
  const payment = makePaymentService();
  const productSync = makeProductSync();
  const systemConfig = {
    ...makeSystemConfigService(),
    ...(opts.systemConfigOverrides ?? {}),
  };
  const registry = opts.withRegistry ? makePaymentProviderRegistry() : undefined;
  const financeUserIdentity = {
    resolveSearch: jest.fn(async (value: string) => ({
      userIds: [value],
      apiKeyIds: [],
      billingAccountIds: [],
      tenantIds: [],
    })),
    getContactsByIds: jest.fn().mockResolvedValue(new Map()),
    ...(opts.financeUserIdentityOverrides ?? {}),
  };

  const service = new BillingAdminService(
    repo as any,
    prisma as any,
    payment as any,
    productSync as any,
    systemConfig as any,
    registry as any,
    financeUserIdentity as any,
  );

  return {
    service,
    repo,
    prisma,
    payment,
    productSync,
    systemConfig,
    registry,
    financeUserIdentity,
  };
}

// Utility: make prisma.$transaction execute the callback with the same prisma mock
function withTransactionSupport(prisma: any) {
  prisma.$transaction.mockImplementation((cb: (tx: any) => Promise<any>) => cb(prisma));
}

function reconciledFinanceGrantAccount(id = 'billing-account-1') {
  return {
    billingAccountId: id,
    billingAccount: {
      id,
      balanceGrantLedgerStatus: 'RECONCILED_V2',
      balanceGrantLedgerVersion: 2,
    },
  };
}

function withDefaultFinanceGrantAccount(grant: any) {
  const defaultAccount = reconciledFinanceGrantAccount(
    Object.prototype.hasOwnProperty.call(grant, 'billingAccountId')
      ? grant.billingAccountId
      : `billing-account:${grant.tenantId ?? 'unknown'}`,
  );
  const normalizedGrant = { ...defaultAccount, ...grant };
  const billingAccountId = normalizedGrant.billingAccountId;
  const refundAllocations = (normalizedGrant.refundAllocations ?? []).map(
    (allocation: any, index: number) => {
      const id = Object.prototype.hasOwnProperty.call(allocation, 'id')
        ? allocation.id
        : `refund-allocation:${normalizedGrant.id}:${index + 1}`;
      const refundId = Object.prototype.hasOwnProperty.call(allocation, 'refundId')
        ? allocation.refundId
        : `refund:${normalizedGrant.id}:${index + 1}`;
      const relation = allocation.refund ?? {};
      const refund = {
        id: refundId,
        billingAccountId,
        balanceGrantId: normalizedGrant.id,
        refundTransactionId: `refund-transaction:${normalizedGrant.id}:${index + 1}`,
        debtAllocationId: allocation.role === 'DEBT_NETTING'
          ? `refund-debt:${normalizedGrant.id}:${index + 1}`
          : null,
        component: 'PAID',
        balanceGrant: {
          id: normalizedGrant.id,
          billingAccountId,
        },
        ...relation,
      };
      return {
        id,
        refundId,
        balanceGrantId: normalizedGrant.id,
        sequence: index + 1,
        ...allocation,
        refund,
      };
    },
  );
  const debtSettlements = (normalizedGrant.debtSettlements ?? []).map(
    (settlement: any, index: number) => {
      const id = Object.prototype.hasOwnProperty.call(settlement, 'id')
        ? settlement.id
        : `settlement:${normalizedGrant.id}:${index + 1}`;
      const allocationId = Object.prototype.hasOwnProperty.call(settlement, 'allocationId')
        ? settlement.allocationId
        : `debt-allocation:${normalizedGrant.id}:${index + 1}`;
      const debtSource = Object.prototype.hasOwnProperty.call(settlement, 'debtSource')
        ? settlement.debtSource
        : 'NEGATIVE_BALANCE';
      const relation = settlement.allocation ?? {};
      const allocation = {
        id: allocationId,
        billingAccountId,
        source: debtSource,
        ...relation,
      };
      return {
        id,
        billingAccountId,
        allocationId,
        repaymentTransactionId: `repayment:${normalizedGrant.id}:${index + 1}`,
        balanceGrantId: normalizedGrant.id,
        debtSource,
        ...settlement,
        allocation,
      };
    },
  );
  return { ...normalizedGrant, refundAllocations, debtSettlements };
}

function makeReconciledFinanceGrant(overrides: Record<string, unknown> = {}) {
  return {
    id: 'finance-grant-1',
    userId: 'user-1',
    tenantId: 'tenant-1',
    ...reconciledFinanceGrantAccount(),
    orderId: null,
    productId: 'prod-payg',
    source: 'RECHARGE',
    paidAmountUsd: new Prisma.Decimal(5),
    bonusAmountUsd: new Prisma.Decimal(0),
    grantedAmountUsd: new Prisma.Decimal(5),
    remainingAmountUsd: new Prisma.Decimal(5),
    remainingPaidAmountUsd: new Prisma.Decimal(5),
    remainingBonusAmountUsd: new Prisma.Decimal(0),
    discountRate: new Prisma.Decimal(1),
    validFrom: new Date('2026-04-01T00:00:00Z'),
    expiresAt: new Date('2027-04-01T00:00:00Z'),
    isExpired: false,
    createdAt: new Date('2026-04-01T00:00:00Z'),
    targetRefunds: [],
    refundAllocations: [],
    debtSettlements: [],
    expiryAudit: null,
    order: null,
    ...overrides,
  };
}

function makeFinanceReportPrisma(
  tokenUsageRows: any[] = [],
  overrides: {
    orders?: any[];
    codingPlanEntitlements?: any[];
    balanceTransactions?: any[];
    balanceGrants?: any[];
    balanceConsumptionAllocations?: any[];
    enterpriseCreditSettlements?: any[];
    tenants?: any[];
    products?: any[];
    invoiceApplicationItems?: any[];
    modelPricings?: any[];
  } = {},
) {
  const zero = new Prisma.Decimal(0);
  const balanceGrants = (overrides.balanceGrants ?? []).map(withDefaultFinanceGrantAccount);
  const balanceConsumptionAllocations = (overrides.balanceConsumptionAllocations ?? []).map((allocation) => {
    const balanceGrant = allocation.balanceGrant
      ? withDefaultFinanceGrantAccount(allocation.balanceGrant)
      : allocation.balanceGrant;
    return {
      source: balanceGrant ? 'BALANCE_GRANT' : allocation.source,
      billingAccountId: balanceGrant?.billingAccountId ?? allocation.billingAccountId,
      ...allocation,
      balanceGrant,
    };
  });
  for (const allocation of balanceConsumptionAllocations) {
    if (
      allocation.balanceGrant
      && !balanceGrants.some((grant) => grant.id === allocation.balanceGrant.id)
    ) {
      balanceGrants.push(allocation.balanceGrant);
    }
  }
  const aggregateResult = {
    _sum: {
      amountUsd: zero,
      amountCents: 0,
      refundAmountCents: 0,
      creditsAmount: 0,
      promptTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      costUsd: zero,
    },
    _count: { id: tokenUsageRows.length },
  };

  return {
    $queryRaw: jest.fn().mockImplementation((query: {
      strings?: readonly string[];
      values?: readonly unknown[];
    }) => {
      const sql = query?.strings?.join('') ?? '';
      if (sql.includes('transaction_timestamp()')) {
        return Promise.resolve([{ asOf: new Date('2026-08-15T00:00:00.000Z') }]);
      }
      if (sql.includes('clock_timestamp()')) {
        return Promise.resolve([{ financialNow: new Date('2026-07-16T00:00:00.000Z') }]);
      }
      if (sql.includes('atOrAfterExpiryCount')) {
        const scopedGrantIds = new Set(
          (query.values ?? []).filter((value): value is string => typeof value === 'string'),
        );
        return Promise.resolve(balanceGrants.flatMap((grant) => {
          if (!(grant.expiresAt instanceof Date)) return [];
          if (scopedGrantIds.size > 0 && !scopedGrantIds.has(grant.id)) return [];
          const grantAllocations = balanceConsumptionAllocations.filter((allocation) => (
            allocation.balanceGrantId === grant.id
          ));
          const beforeExpiry = grantAllocations.filter((allocation) => (
            allocation.createdAt instanceof Date
            && allocation.createdAt.getTime() >= grant.validFrom.getTime()
            && allocation.createdAt.getTime() < grant.expiresAt.getTime()
          ));
          const sum = (field: 'amountUsd' | 'recognizedRevenueUsd' | 'bonusConsumedUsd') => (
            beforeExpiry.reduce(
              (total, allocation) => total.plus(allocation[field] ?? zero),
              new Prisma.Decimal(0),
            )
          );
          return [{
            grantId: grant.id,
            amountUsd: sum('amountUsd'),
            paidUsd: sum('recognizedRevenueUsd'),
            bonusUsd: sum('bonusConsumedUsd'),
            beforeValidFromCount: BigInt(grantAllocations.filter((allocation) => (
              allocation.createdAt instanceof Date
              && allocation.createdAt.getTime() < grant.validFrom.getTime()
            )).length),
            atOrAfterExpiryCount: BigInt(grantAllocations.filter((allocation) => (
              allocation.createdAt instanceof Date
              && allocation.createdAt.getTime() >= grant.expiresAt.getTime()
            )).length),
          }];
        }));
      }
      return Promise.resolve([{ invalid_fact_count: BigInt(0) }]);
    }),
    balanceTransaction: {
      aggregate: jest.fn().mockResolvedValue(aggregateResult),
      count: jest.fn().mockResolvedValue(overrides.balanceTransactions?.length ?? 0),
      findMany: jest.fn().mockResolvedValue(overrides.balanceTransactions ?? []),
    },
    order: {
      aggregate: jest.fn().mockResolvedValue(aggregateResult),
      count: jest.fn().mockResolvedValue(overrides.orders?.length ?? 0),
      findMany: jest.fn()
        .mockResolvedValueOnce([])
        .mockResolvedValueOnce(overrides.orders ?? []),
    },
    creditTransaction: {
      aggregate: jest.fn().mockResolvedValue(aggregateResult),
      count: jest.fn().mockResolvedValue(0),
      findMany: jest.fn().mockResolvedValue([]),
    },
    tokenUsage: {
      aggregate: jest.fn().mockResolvedValue(aggregateResult),
      count: jest.fn().mockResolvedValue(tokenUsageRows.length),
      findMany: jest.fn().mockResolvedValue(tokenUsageRows),
    },
    balanceGrant: {
      count: jest.fn().mockResolvedValue(balanceGrants.length),
      findMany: jest.fn().mockImplementation((args?: {
        where?: { id?: { in?: string[] } };
      }) => {
        const ids = args?.where?.id?.in;
        return Promise.resolve(
          ids
            ? balanceGrants.filter((grant) => ids.includes(grant.id))
            : balanceGrants,
        );
      }),
    },
    balanceConsumptionAllocation: {
      count: jest.fn().mockResolvedValue(balanceConsumptionAllocations.length),
      findMany: jest.fn().mockResolvedValue(balanceConsumptionAllocations),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    enterpriseCreditSettlement: {
      count: jest.fn().mockResolvedValue(overrides.enterpriseCreditSettlements?.length ?? 0),
      findMany: jest.fn().mockResolvedValue(overrides.enterpriseCreditSettlements ?? []),
    },
    tenant: {
      findMany: jest.fn().mockResolvedValue(overrides.tenants ?? []),
    },
    product: {
      findMany: jest.fn().mockResolvedValue(overrides.products ?? []),
    },
    invoiceApplicationItem: {
      findMany: jest.fn().mockResolvedValue(overrides.invoiceApplicationItems ?? []),
    },
    modelPricing: {
      findMany: jest.fn().mockResolvedValue(overrides.modelPricings ?? []),
    },
    codingPlanEntitlement: {
      findMany: jest.fn().mockResolvedValue(overrides.codingPlanEntitlements ?? []),
    },
    subscriptionPeriod: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
}

function setFinanceSnapshotAsOf(financePrisma: any, asOf: Date): void {
  const fallback = financePrisma.$queryRaw.getMockImplementation();
  financePrisma.$queryRaw.mockImplementation((query: {
    strings?: readonly string[];
    values?: readonly unknown[];
  }) => {
    const sql = query?.strings?.join('') ?? '';
    if (sql.includes('transaction_timestamp()')) {
      return Promise.resolve([{ asOf }]);
    }
    return fallback?.(query);
  });
}

function makeFinanceExportJob(overrides: Record<string, unknown> = {}) {
  const now = new Date('2026-06-15T00:00:00Z');
  return {
    id: 'export-job-1',
    month: '2026-06',
    tab: 'orders',
    billingMode: null,
    status: 'PENDING',
    filename: 'finance-2026-06-ALL-orders.csv',
    contentType: 'text/csv; charset=utf-8',
    rowCount: 0,
    fileContent: null,
    filePath: null,
    fileSizeBytes: null,
    fileSha256: null,
    processedRows: 0,
    totalRows: null,
    asOf: null,
    heartbeatAt: null,
    errorCode: null,
    failedStage: null,
    errorMessage: null,
    requestedByAdminId: null,
    startedAt: null,
    finishedAt: null,
    expiresAt: new Date('2026-06-22T00:00:00Z'),
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeTokenPlanRevenueLine(overrides: Record<string, unknown> = {}) {
  return {
    period: '2026-05',
    orderId: 'order-1',
    orderItemId: 'item-1',
    entitlementId: null,
    providerEntitlementId: null,
    userId: 'user-1',
    userLabel: '13000000000',
    workspaceId: 'tenant-1',
    workspaceName: '个人工作区',
    workspaceType: 'PERSONAL',
    productId: 'product-1',
    productName: 'CodingPlan',
    planId: 'plan-1',
    planName: 'Pro',
    fulfillmentMode: 'SELF',
    providerLineCode: null,
    providerCode: null,
    upstreamProductId: null,
    currency: 'CNY',
    orderAmountCents: 1000,
    billingPeriod: 'MONTHLY',
    serviceStartAt: new Date('2026-05-01T00:00:00.000Z'),
    serviceEndAt: new Date('2026-06-01T00:00:00.000Z'),
    totalServiceDays: 31,
    recognizedDaysInPeriod: 31,
    openingDeferredCents: 0,
    newDeferredCents: 1000,
    serviceRecognizedRevenueCents: 1000,
    refundAppliedToDeferredCents: 0,
    refundRevenueReversalCents: 0,
    recognizedRevenueCents: 1000,
    closingDeferredCents: 0,
    recognizedToDateCents: 1000,
    refundAmountCents: 0,
    orderStatus: OrderStatus.COMPLETED,
    entitlementStatus: 'ACTIVE',
    evidence: 'test',
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// getFinanceReports
// ---------------------------------------------------------------------------

describe('BillingAdminService.getFinanceReports', () => {
  it('does not truncate API usage detail rows', async () => {
    const tokenUsage = {
      id: 'usage-1',
      apiKeyId: 'key-1',
      apiKey: {
        id: 'key-1',
        prefix: 'sk-test',
        userId: 'user-1',
        user: { id: 'user-1', email: 'user@example.com', phone: null, nickname: null },
      },
      product: null,
      model: 'gpt-test',
      promptTokens: 100,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 10,
      completionTokens: 50,
      totalTokens: 160,
      inputPriceUsdPerM: new Prisma.Decimal('1.25'),
      cachedInputPriceUsdPerM: new Prisma.Decimal('0.125'),
      cacheWritePriceUsdPerM: new Prisma.Decimal('1.5'),
      outputPriceUsdPerM: new Prisma.Decimal('10'),
      costUsd: new Prisma.Decimal('0.001'),
      createdAt: new Date('2026-05-10T00:00:00Z'),
    };
    const financePrisma = makeFinanceReportPrisma([tokenUsage]);
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    const result = await service.getFinanceReports('2026-05');

    expect(financePrisma.tokenUsage.findMany).toHaveBeenCalled();
    const tokenUsageQuery = financePrisma.tokenUsage.findMany.mock.calls[0][0];
    expect(tokenUsageQuery).not.toHaveProperty('take');
    expect(tokenUsageQuery.where.AND).toEqual(expect.arrayContaining([
      (service as any).financeVisibleTokenUsageWhere(),
    ]));
    expect(result.apiUsage).toHaveLength(1);
    expect(result.rowLimits.maxRowsPerDetail).toBeNull();
  });

  it('classifies enterprise credit by consumption source across settlement states', async () => {
    const tokenUsage = {
      id: 'usage-1',
      apiKeyId: 'key-1',
      tenantId: 'tenant-1',
      tenant: { id: 'tenant-1', name: '默认工作区', slug: 'default', type: 'personal' },
      apiKey: {
        id: 'key-1',
        prefix: 'sk-test',
        userId: 'user-1',
        user: { id: 'user-1', email: 'user@example.com', phone: null, nickname: null },
      },
      product: null,
      model: 'gpt-test',
      promptTokens: 600,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      completionTokens: 400,
      totalTokens: 1000,
      inputPriceUsdPerM: new Prisma.Decimal('1'),
      cachedInputPriceUsdPerM: null,
      cacheWritePriceUsdPerM: null,
      outputPriceUsdPerM: new Prisma.Decimal('2'),
      costUsd: new Prisma.Decimal('7'),
      customerChargePolicy: 'payg_balance',
      customerChargeUsd: new Prisma.Decimal('7'),
      providerCostEstimateUsd: null,
      codingPlanEntitlementId: null,
      providerEntitlementId: null,
      gatewayBillingEvent: {
        settlementAnchor: {
          customerPricingSnapshot: { customerMultiplier: '0.85' },
        },
      },
      createdAt: new Date('2026-05-10T00:00:00Z'),
      consumptionAllocations: [
        {
          balanceGrantId: 'grant-1',
          source: 'BALANCE_GRANT',
          amountUsd: new Prisma.Decimal('4'),
          recognizedRevenueUsd: new Prisma.Decimal('3'),
          bonusConsumedUsd: new Prisma.Decimal('1'),
        },
        {
          balanceGrantId: null,
          source: 'ENTERPRISE_CREDIT',
          amountUsd: new Prisma.Decimal('2'),
          recognizedRevenueUsd: new Prisma.Decimal('1.83'),
          bonusConsumedUsd: new Prisma.Decimal('0.17'),
          approvedCreditUsd: new Prisma.Decimal('2'),
          unapprovedDebtUsd: new Prisma.Decimal(0),
          fundingClassificationComplete: true,
        },
        {
          balanceGrantId: null,
          source: 'ENTERPRISE_CREDIT',
          amountUsd: new Prisma.Decimal('1'),
          recognizedRevenueUsd: new Prisma.Decimal(0),
          bonusConsumedUsd: new Prisma.Decimal(0),
          approvedCreditUsd: new Prisma.Decimal(0),
          unapprovedDebtUsd: new Prisma.Decimal('1'),
          fundingClassificationComplete: true,
        },
      ],
    };
    const financePrisma = makeFinanceReportPrisma([tokenUsage]);
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    const result = await service.getFinanceReports('2026-05');

    expect(result.apiUsage).toEqual([
      expect.objectContaining({
        usageId: 'usage-1',
        userChargeUsd: 7,
        paymentDeductionUsd: 3,
        voucherDeductionUsd: 1,
        creditDeductionUsd: 2,
        debtDeductionUsd: 1,
        customerMultiplier: 0.85,
        paymentDeductionCents: 300,
        voucherDeductionCents: 100,
        creditDeductionCents: 200,
        debtDeductionCents: 100,
        chargeSource: 'enterprise_credit_receivable',
      }),
    ]);
    const [row] = result.apiUsage;
    expect(new Prisma.Decimal(row.paymentDeductionUsd)
      .plus(row.voucherDeductionUsd)
      .plus(row.creditDeductionUsd)
      .plus(row.debtDeductionUsd)
      .eq(row.userChargeUsd)).toBe(true);
    for (const policy of [
      'payg_balance', 'debt_open', 'enterprise_credit_receivable',
      'included_upstream', 'subscription_credits',
    ]) {
      const [policyRow] = (service as any).mapFinanceApiUsageRows('2026-05', [{
        ...tokenUsage,
        customerChargePolicy: policy,
      }]);
      expect(policyRow.chargeSource).toBe('enterprise_credit_receivable');
      expect((service as any).buildFinanceApiUsageTokenRows([policyRow]))
        .toEqual(expect.arrayContaining([expect.objectContaining({ chargeSource: 'enterprise_credit_receivable' })]));
    }
    const [missingPolicyRow] = (service as any).mapFinanceApiUsageRows('2026-05', [{
      ...tokenUsage,
      customerChargePolicy: null,
    }]);
    expect(missingPolicyRow.chargeSource).toBe('enterprise_credit_receivable');

    const unsettledUsage = {
      ...tokenUsage,
      id: 'usage-unsettled-credit',
      promptTokens: 154_690,
      cachedInputTokens: 1_536,
      completionTokens: 184,
      totalTokens: 154_874,
      inputPriceUsdPerM: new Prisma.Decimal('8'),
      cachedInputPriceUsdPerM: new Prisma.Decimal('2'),
      outputPriceUsdPerM: new Prisma.Decimal('28'),
      costUsd: new Prisma.Decimal('1.233456'),
      customerChargeUsd: new Prisma.Decimal('1.233456'),
      consumptionAllocations: [{
        balanceGrantId: null,
        source: 'ENTERPRISE_CREDIT',
        amountUsd: new Prisma.Decimal('1.233456'),
        recognizedRevenueUsd: new Prisma.Decimal(0),
        bonusConsumedUsd: new Prisma.Decimal(0),
        approvedCreditUsd: new Prisma.Decimal('1.233456'),
        unapprovedDebtUsd: new Prisma.Decimal(0),
        fundingClassificationComplete: true,
      }],
    };
    const [unsettledRow] = (service as any).mapFinanceApiUsageRows('2026-05', [unsettledUsage]);
    expect(unsettledRow).toEqual(expect.objectContaining({
      userChargeUsd: 1.233456,
      paymentDeductionUsd: 0,
      voucherDeductionUsd: 0,
      creditDeductionUsd: 1.233456,
      debtDeductionUsd: 0,
      chargeSource: 'enterprise_credit_receivable',
    }));
    const tokenRows = (service as any).buildFinanceApiUsageTokenRows([unsettledRow]);
    expect(tokenRows).toEqual([
      expect.objectContaining({ tokenType: 'input', userChargeUsd: 1.225232, paymentDeductionUsd: 0, creditDeductionUsd: 1.225232 }),
      expect.objectContaining({ tokenType: 'cache read', userChargeUsd: 0.003072, paymentDeductionUsd: 0, creditDeductionUsd: 0.003072 }),
      expect.objectContaining({ tokenType: 'output', userChargeUsd: 0.005152, paymentDeductionUsd: 0, creditDeductionUsd: 0.005152 }),
    ]);

    const partiallySettledUsage = {
      ...unsettledUsage,
      consumptionAllocations: [{
        ...unsettledUsage.consumptionAllocations[0],
        recognizedRevenueUsd: new Prisma.Decimal('0.4'),
        bonusConsumedUsd: new Prisma.Decimal('0.2'),
      }],
    };
    const [partiallySettledRow] = (service as any).mapFinanceApiUsageRows('2026-05', [partiallySettledUsage]);
    expect(partiallySettledRow).toEqual(expect.objectContaining({
      paymentDeductionUsd: 0,
      voucherDeductionUsd: 0,
      creditDeductionUsd: 1.233456,
      debtDeductionUsd: 0,
      chargeSource: 'enterprise_credit_receivable',
    }));

    const negativeBalanceUsage = {
      ...tokenUsage,
      id: 'usage-with-negative-balance',
      costUsd: new Prisma.Decimal('8'),
      customerChargeUsd: new Prisma.Decimal('8'),
      consumptionAllocations: [
        ...tokenUsage.consumptionAllocations,
        {
          balanceGrantId: null,
          source: 'NEGATIVE_BALANCE',
          amountUsd: new Prisma.Decimal('1'),
          recognizedRevenueUsd: new Prisma.Decimal('0.75'),
          bonusConsumedUsd: new Prisma.Decimal('0.25'),
          approvedCreditUsd: new Prisma.Decimal(0),
          unapprovedDebtUsd: new Prisma.Decimal('1'),
          fundingClassificationComplete: true,
        },
      ],
    };
    const [negativeBalanceRow] = (service as any).mapFinanceApiUsageRows('2026-05', [negativeBalanceUsage]);
    expect(negativeBalanceRow).toEqual(expect.objectContaining({
      userChargeUsd: 8,
      paymentDeductionUsd: 3,
      voucherDeductionUsd: 1,
      creditDeductionUsd: 2,
      debtDeductionUsd: 2,
    }));

    const [snapshotRow] = (service as any).mapFinanceApiUsageRows('2026-05', [{
      ...tokenUsage,
      id: 'usage-without-allocations',
      customerChargeUsd: new Prisma.Decimal('2'),
      customerFundingClassificationComplete: true,
      customerCollectedUsd: new Prisma.Decimal('1'),
      customerApprovedReceivableUsd: new Prisma.Decimal('0.5'),
      customerUnapprovedDebtUsd: new Prisma.Decimal('0.5'),
      consumptionAllocations: [],
    }]);
    expect(snapshotRow).toEqual(expect.objectContaining({
      paymentDeductionUsd: 1,
      creditDeductionUsd: 0.5,
      debtDeductionUsd: 0.5,
    }));

    const [legacyRow] = (service as any).mapFinanceApiUsageRows('2026-05', [{
      ...unsettledUsage,
      customerFundingClassificationComplete: false,
      consumptionAllocations: [{
        ...unsettledUsage.consumptionAllocations[0],
        fundingClassificationComplete: false,
      }],
    }]);
    expect(legacyRow).toEqual(expect.objectContaining({
      creditDeductionUsd: 0,
      debtDeductionUsd: 1.233456,
      chargeSource: 'payg_balance',
    }));

    const csv = (service as any).buildFinanceExportCsv(
      'apiUsage',
      (service as any).buildFinanceApiUsageTokenRows([row]),
    );
    const [header, dataRow] = csv.replace(/^\uFEFF/u, '').split('\n');
    expect(dataRow.split(',')[header.split(',').indexOf('扣费来源')])
      .toBe('enterprise_credit_receivable');
  });

  it('resolves API usage charge source by credit, historical policy, then billing-mode funding', () => {
    const { service } = buildService();
    const cases = [
      { name: 'credit overrides PAYG debt', mode: ProductBillingMode.PAY_AS_YOU_GO, policy: 'debt_open', debt: '2', credit: '0.01', expected: 'enterprise_credit_receivable' },
      { name: 'credit overrides subscription debt', mode: ProductBillingMode.SUBSCRIPTION, policy: 'debt_open', debt: '2', credit: '0.01', expected: 'enterprise_credit_receivable' },
      { name: 'credit overrides included upstream', mode: ProductBillingMode.CODING_PLAN, policy: 'included_upstream', credit: '0.000000000001', expected: 'enterprise_credit_receivable' },
      { name: 'credit overrides historical policy', mode: null, policy: 'usage_charge', credit: '1', expected: 'enterprise_credit_receivable' },
      { name: 'PAYG debt takes precedence over receivable', mode: ProductBillingMode.PAY_AS_YOU_GO, policy: 'payg_balance', debt: '2', receivable: '1', expected: 'debt_open' },
      { name: 'PAYG approved receivable', mode: ProductBillingMode.PAY_AS_YOU_GO, policy: 'payg_balance', receivable: '1', expected: 'enterprise_credit_receivable' },
      { name: 'PAYG balance otherwise', mode: ProductBillingMode.PAY_AS_YOU_GO, policy: 'debt_open', expected: 'payg_balance' },
      { name: 'subscription debt', mode: ProductBillingMode.SUBSCRIPTION, policy: 'subscription_credits', debt: '1', expected: 'debt_open' },
      { name: 'subscription credits otherwise', mode: ProductBillingMode.SUBSCRIPTION, policy: 'debt_open', expected: 'subscription_credits' },
      { name: 'Coding Plan included policy', mode: ProductBillingMode.CODING_PLAN, policy: 'included_upstream', expected: 'included_upstream' },
      { name: 'Coding Plan included snapshot', mode: ProductBillingMode.CODING_PLAN, policy: 'subscription_credits', includedUpstream: true, expected: 'included_upstream' },
      { name: 'Coding Plan credits otherwise', mode: ProductBillingMode.CODING_PLAN, policy: 'subscription_credits', includedUpstream: false, expected: 'subscription_credits' },
      { name: 'legacy cost remains historical', mode: ProductBillingMode.PAY_AS_YOU_GO, policy: 'legacy_cost_usd', debt: '1', expected: 'legacy_cost_usd' },
      { name: 'usage charge remains historical', mode: ProductBillingMode.SUBSCRIPTION, policy: 'usage_charge', debt: '1', expected: 'usage_charge' },
      { name: 'unknown mode keeps stored policy', mode: null, policy: 'debt_open', expected: 'debt_open' },
      { name: 'missing mode and policy stay unknown', mode: null, policy: null, expected: null },
    ];

    for (const testCase of cases) {
      const usage = {
        product: testCase.mode == null ? null : { billingMode: testCase.mode },
        customerChargePolicy: testCase.policy,
        customerUnapprovedDebtUsd: new Prisma.Decimal(testCase.debt ?? '0'),
        customerApprovedReceivableUsd: new Prisma.Decimal(testCase.receivable ?? '0'),
        gatewayBillingEvent: { settlementAnchor: { customerPricingSnapshot: {
          includedUpstream: testCase.includedUpstream ?? false,
        } } },
      };
      const source = (service as any).financeApiUsageChargeSource(
        usage,
        new Prisma.Decimal(testCase.credit ?? '0'),
      );
      expect({ name: testCase.name, source })
        .toEqual({ name: testCase.name, source: testCase.expected });
    }
  });

  it('does not invent a customer multiplier when the frozen snapshot is missing or invalid', () => {
    const { service } = buildService();

    expect((service as any).financeCustomerMultiplier({})).toBeNull();
    expect((service as any).financeCustomerMultiplier({
      gatewayBillingEvent: {
        settlementAnchor: {
          customerPricingSnapshot: { customerMultiplier: 'invalid' },
        },
      },
    })).toBeNull();
    expect((service as any).financeCustomerMultiplier({
      gatewayBillingEvent: {
        settlementAnchor: {
          customerPricingSnapshot: { customerMultiplier: '-0.1' },
        },
      },
    })).toBeNull();
  });

  it('does not convert included upstream provider cost into user charge', async () => {
    const tokenUsage = {
      id: 'usage-included',
      apiKeyId: 'key-1',
      tenantId: 'tenant-1',
      tenant: { id: 'tenant-1', name: '默认工作区', slug: 'default', type: 'personal' },
      apiKey: {
        id: 'key-1',
        prefix: 'sk-test',
        userId: 'user-1',
        user: { id: 'user-1', email: 'user@example.com', phone: null, nickname: null },
      },
      product: { id: 'prod-cp', name: 'CodingPlan', slug: 'coding-plan', billingMode: ProductBillingMode.CODING_PLAN },
      model: 'gpt-test',
      promptTokens: 600,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      completionTokens: 400,
      totalTokens: 1000,
      inputPriceUsdPerM: new Prisma.Decimal('1'),
      cachedInputPriceUsdPerM: null,
      cacheWritePriceUsdPerM: null,
      outputPriceUsdPerM: new Prisma.Decimal('2'),
      costUsd: new Prisma.Decimal('7'),
      customerChargePolicy: 'included_upstream',
      customerChargeUsd: new Prisma.Decimal('0'),
      providerCostEstimateUsd: new Prisma.Decimal('7'),
      codingPlanEntitlementId: 'ent-1',
      providerEntitlementId: 'provider-ent-1',
      createdAt: new Date('2026-05-10T00:00:00Z'),
      consumptionAllocations: [],
    };
    const financePrisma = makeFinanceReportPrisma([tokenUsage]);
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    const result = await service.getFinanceReports('2026-05');

    expect(result.apiUsage).toEqual([
      expect.objectContaining({
        usageId: 'usage-included',
        userChargeUsd: 0,
        paymentDeductionUsd: 0,
        voucherDeductionUsd: 0,
        userChargeCents: 0,
        chargeSource: 'included_upstream',
      }),
    ]);
  });

  it('builds pure gift and buy gift template reports from balance grants and allocations', async () => {
    const user = { id: 'user-1', email: 'user@example.com', phone: '13800138000', nickname: null };
    const tenant = { id: 'tenant-1', name: '默认工作区', slug: 'default', type: 'personal' };
    const product = { id: 'prod-payg', name: '按量产品', slug: 'payg' };
    const pureGrant = {
      id: 'grant-voucher',
      billingAccountId: 'personal-account',
      billingAccount: {
        id: 'personal-account', type: 'personal',
        balanceGrantLedgerStatus: 'RECONCILED_V2', balanceGrantLedgerVersion: 2,
      },
      userId: 'user-1',
      tenantId: 'tenant-1',
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
      validFrom: new Date('2026-05-02T00:00:00Z'),
      expiresAt: new Date('2026-12-31T00:00:00Z'),
      isExpired: false,
      createdAt: new Date('2026-05-02T00:00:00Z'),
      user,
      tenant,
      product,
      order: null,
    };
    const buyGrant = {
      id: 'grant-recharge',
      billingAccountId: 'enterprise-account',
      billingAccount: {
        id: 'enterprise-account', type: 'enterprise',
        enterpriseName: '已认证企业有限公司', verificationId: 'verification-1',
        balanceGrantLedgerStatus: 'RECONCILED_V2', balanceGrantLedgerVersion: 2,
      },
      userId: 'user-1',
      tenantId: 'tenant-1',
      orderId: 'order-1',
      productId: 'prod-payg',
      source: 'RECHARGE',
      paidAmountUsd: new Prisma.Decimal(100),
      bonusAmountUsd: new Prisma.Decimal(20),
      grantedAmountUsd: new Prisma.Decimal(120),
      remainingAmountUsd: new Prisma.Decimal(113),
      remainingPaidAmountUsd: new Prisma.Decimal('94.166666666669'),
      remainingBonusAmountUsd: new Prisma.Decimal('18.833333333331'),
      discountRate: new Prisma.Decimal('0.833333333333'),
      validFrom: new Date('2026-05-03T00:00:00Z'),
      expiresAt: new Date('2027-05-03T00:00:00Z'),
      isExpired: false,
      createdAt: new Date('2026-05-03T00:00:00Z'),
      user,
      tenant,
      product,
      order: {
        id: 'order-1',
        amountCents: 10000,
        bonusCents: 2000,
        currency: 'usd',
        status: OrderStatus.COMPLETED,
        channel: 'STRIPE',
        tradeNo: 'pi_1',
        paidAt: new Date('2026-05-03T00:00:00Z'),
        completedAt: new Date('2026-05-03T00:00:00Z'),
        refundedAt: null,
        refundAmountCents: null,
      },
    };
    const usage = {
      id: 'usage-1',
      model: 'gpt-test',
      pricingTierKey: null,
      promptTokens: 600,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      completionTokens: 400,
      totalTokens: 1000,
      inputPriceUsdPerM: new Prisma.Decimal(1),
      cachedInputPriceUsdPerM: null,
      cacheWritePriceUsdPerM: null,
      outputPriceUsdPerM: new Prisma.Decimal(2),
      costUsd: new Prisma.Decimal(7),
      providerCostEstimateUsd: new Prisma.Decimal('0.7'),
      providerCostMultiplier: new Prisma.Decimal('0.8'),
      providerInputCostUsdPerM: new Prisma.Decimal(500),
      providerCachedInputCostUsdPerM: null,
      providerCacheWriteCostUsdPerM: null,
      providerOutputCostUsdPerM: new Prisma.Decimal(1000),
      createdAt: new Date('2026-05-10T00:00:00Z'),
    };
    const allocation = {
      id: 'allocation-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-payg',
      balanceTransactionId: 'bt-1',
      tokenUsageId: 'usage-1',
      balanceGrantId: 'grant-recharge',
      amountUsd: new Prisma.Decimal(7),
      recognizedRevenueUsd: new Prisma.Decimal('5.833333333331'),
      bonusConsumedUsd: new Prisma.Decimal('1.166666666669'),
      discountRate: new Prisma.Decimal('0.833333333333'),
      createdAt: new Date('2026-05-10T00:00:00Z'),
      user,
      tenant,
      product,
      balanceGrant: buyGrant,
      balanceTransaction: { id: 'bt-1', orderId: null, description: 'usage', createdAt: new Date('2026-05-10T00:00:00Z') },
      tokenUsage: usage,
    };
    const financePrisma = makeFinanceReportPrisma([], {
      balanceGrants: [pureGrant, buyGrant],
      balanceConsumptionAllocations: [allocation],
      invoiceApplicationItems: [
        {
          orderId: 'order-1',
          principalCents: 5000,
          application: {
            issuedAt: new Date('2026-05-15T00:00:00Z'),
            issueDate: null,
            createdAt: new Date('2026-05-15T00:00:00Z'),
          },
        },
        {
          orderId: 'order-1',
          principalCents: 1000,
          application: {
            issuedAt: new Date('2026-04-30T00:00:00Z'),
            issueDate: null,
            createdAt: new Date('2026-04-30T00:00:00Z'),
          },
        },
      ],
      modelPricings: [
        {
          modelName: 'gpt-test',
          inputPricePerMToken: new Prisma.Decimal(2),
          outputPricePerMToken: new Prisma.Decimal(4),
          cachedInputPrice: null,
          cacheWrite5minPrice: null,
          cacheWrite1hPrice: null,
          longContextInputPrice: null,
          longContextOutputPrice: null,
          priceTiers: [],
        },
      ],
    });
    const { service } = buildService({
      prismaOverrides: financePrisma as any,
      systemConfigOverrides: {
        getDeploymentConfig: jest.fn().mockResolvedValue({ currency: 'cny', region: 'domestic' }),
      },
    });

    const result = await service.getFinanceReports('2026-05');

    expect(result.monthlySummary).toEqual([
      expect.objectContaining({ currency: 'CNY' }),
    ]);

    expect(result.financeTemplates.pureGift.accountChangeDetails).toEqual([
      expect.objectContaining({
        rechargeBatchNo: 'grant-voucher',
        userLabel: '13800138000',
        currency: 'CNY',
        giftRechargeAmountCents: 1000,
      }),
    ]);
    expect(result.financeTemplates.buyGift.accountChangeDetails).toEqual([
      expect.objectContaining({
        rechargeBatchNo: 'grant-recharge',
        userLabel: '已认证企业有限公司',
        currency: 'USD',
        paidRechargeAmountCents: 10000,
        bonusRechargeAmountCents: 2000,
        periodCollectionAmountCents: 10000,
        accumulatedCollectionAmountCents: 10000,
        receivableAmountCents: 0,
        periodInvoiceAmountCents: 5000,
        accumulatedInvoiceAmountCents: 6000,
      }),
    ]);
    expect(result.financeTemplates.buyGift.consumptionDetails).toEqual([
      expect.objectContaining({
        callTransactionNo: 'usage-1',
        userLabel: '已认证企业有限公司',
        rechargeBatchNo: 'grant-recharge',
        callType: 'input',
        userDiscount: 0.5,
        tokenUsage: 600,
        consumeAmountUsd: '3.000000000000',
        consumeAmountCents: 300,
        consumeAmountPaidUsd: '2.499999999999',
        consumeAmountPaidCents: 250,
        supplierUnitPriceUsdPerM: '500.000000000000',
        supplierDiscount: 0.8,
        estimatedSupplierChargeUsd: '0.300000000000',
        estimatedSupplierChargeCents: 30,
      }),
      expect.objectContaining({
        callTransactionNo: 'usage-1',
        rechargeBatchNo: 'grant-recharge',
        callType: 'output',
        userDiscount: 0.5,
        tokenUsage: 400,
        consumeAmountUsd: '4.000000000000',
        consumeAmountCents: 400,
        consumeAmountPaidUsd: '3.333333333332',
        consumeAmountPaidCents: 333,
        supplierUnitPriceUsdPerM: '1000.000000000000',
        supplierDiscount: 0.8,
        estimatedSupplierChargeUsd: '0.400000000000',
        estimatedSupplierChargeCents: 40,
      }),
    ]);
    expect(result.financeTemplates.buyGift.consumptionSummary).toEqual([
      expect.objectContaining({
        tokenUsage: 1000,
        estimatedSupplierChargeCents: 70,
      }),
    ]);
  });

  it('summarizes finance template money from raw USD instead of rounded detail cents', async () => {
    const user = { id: 'user-1', email: 'user@example.com', phone: null, nickname: null };
    const tenant = { id: 'tenant-1', name: '默认工作区', slug: 'default', type: 'personal' };
    const product = { id: 'prod-payg', name: '按量产品', slug: 'payg' };
    const makeGrant = (id: string) => ({
      id,
      userId: 'user-1',
      tenantId: 'tenant-1',
      orderId: null,
      productId: 'prod-payg',
      source: 'RECHARGE',
      paidAmountUsd: new Prisma.Decimal('0.005'),
      bonusAmountUsd: new Prisma.Decimal(0),
      grantedAmountUsd: new Prisma.Decimal('0.005'),
      remainingAmountUsd: new Prisma.Decimal(0),
      remainingPaidAmountUsd: new Prisma.Decimal(0),
      remainingBonusAmountUsd: new Prisma.Decimal(0),
      discountRate: new Prisma.Decimal(1),
      validFrom: new Date('2026-05-03T00:00:00Z'),
      expiresAt: new Date('2027-05-03T00:00:00Z'),
      isExpired: false,
      createdAt: new Date('2026-05-03T00:00:00Z'),
      user,
      tenant,
      product,
      order: null,
    });
    const grants = [makeGrant('grant-1'), makeGrant('grant-2')];
    const allocations = grants.map((grant, index) => ({
      id: `allocation-${index + 1}`,
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-payg',
      balanceTransactionId: `bt-${index + 1}`,
      tokenUsageId: null,
      balanceGrantId: grant.id,
      amountUsd: new Prisma.Decimal('0.005'),
      recognizedRevenueUsd: new Prisma.Decimal('0.005'),
      bonusConsumedUsd: new Prisma.Decimal(0),
      discountRate: new Prisma.Decimal(1),
      createdAt: new Date('2026-05-10T00:00:00Z'),
      user,
      tenant,
      product,
      balanceGrant: grant,
      balanceTransaction: { id: `bt-${index + 1}`, orderId: null, description: 'usage', createdAt: new Date('2026-05-10T00:00:00Z') },
      tokenUsage: null,
    }));
    const financePrisma = makeFinanceReportPrisma([], {
      balanceGrants: grants,
      balanceConsumptionAllocations: allocations,
    });
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    const result = await service.getFinanceReports('2026-05');

    expect(result.financeTemplates.buyGift.accountChangeDetails).toEqual([
      expect.objectContaining({
        paidRechargeAmountCents: 1,
        periodRechargeAmountCents: 1,
        periodConsumeAmountCents: -1,
      }),
      expect.objectContaining({
        paidRechargeAmountCents: 1,
        periodRechargeAmountCents: 1,
        periodConsumeAmountCents: -1,
      }),
    ]);
    expect(result.financeTemplates.buyGift.accountChangeSummary).toEqual([
      expect.objectContaining({
        periodRechargeAmountCents: 1,
        periodConsumeAmountCents: -1,
        periodRechargePaidCents: 1,
        periodConsumePaidCents: -1,
      }),
    ]);
    expect(result.financeTemplates.buyGift.consumptionDetails).toEqual([
      expect.objectContaining({
        consumeAmountCents: 1,
        consumeAmountPaidCents: 1,
      }),
      expect.objectContaining({
        consumeAmountCents: 1,
        consumeAmountPaidCents: 1,
      }),
    ]);
    expect(result.financeTemplates.buyGift.consumptionSummary).toEqual([
      expect.objectContaining({
        consumeAmountCents: 1,
        consumeAmountPaidCents: 1,
      }),
    ]);
  });

  it('keeps re-registered phone histories separate across every user-level finance summary', async () => {
    const phone = '18501268480';
    type FinanceTestUser = {
      id: string;
      email: string | null;
      phone: string | null;
      nickname: string | null;
    };
    const oldUser: FinanceTestUser = {
      id: '46121dc9-bae6-41d2-a297-403d58e59b22',
      email: null,
      phone,
      nickname: '1111',
    };
    const currentUser: FinanceTestUser = {
      id: '01352d9f-864c-49a5-a406-5ba4b7d6516e',
      email: null,
      phone: null,
      nickname: phone,
    };
    const product = {
      id: 'prod-payg',
      name: '按量产品',
      slug: 'payg',
      billingMode: ProductBillingMode.PAY_AS_YOU_GO,
    };
    const issuedAt = new Date('2026-07-15T08:00:00.000Z');
    const makeGrant = (
      user: FinanceTestUser,
      paidAmount: string,
      consumedAmount: string,
    ) => {
      const paidAmountUsd = new Prisma.Decimal(paidAmount);
      const consumedAmountUsd = new Prisma.Decimal(consumedAmount);
      const remainingAmountUsd = paidAmountUsd.minus(consumedAmountUsd);
      const tenantId = `tenant-${user.id}`;
      const grantId = `grant-${user.id}`;
      return makeReconciledFinanceGrant({
        id: grantId,
        userId: user.id,
        tenantId,
        ...reconciledFinanceGrantAccount(`billing-account-${user.id}`),
        orderId: `order-${user.id}`,
        productId: product.id,
        paidAmountUsd,
        bonusAmountUsd: new Prisma.Decimal(0),
        grantedAmountUsd: paidAmountUsd,
        remainingAmountUsd,
        remainingPaidAmountUsd: remainingAmountUsd,
        remainingBonusAmountUsd: new Prisma.Decimal(0),
        discountRate: new Prisma.Decimal(1),
        validFrom: issuedAt,
        createdAt: issuedAt,
        expiresAt: new Date('2027-07-15T08:00:00.000Z'),
        user,
        tenant: { id: tenantId, name: '默认工作区', slug: tenantId, type: 'personal' },
        product,
        order: {
          id: `order-${user.id}`,
          amountCents: paidAmountUsd.mul(100).toNumber(),
          bonusCents: 0,
          currency: 'cny',
          status: OrderStatus.COMPLETED,
          channel: 'WECHAT',
          tradeNo: `trade-${user.id}`,
          paidAt: issuedAt,
          completedAt: issuedAt,
          refundedAt: null,
          refundAmountCents: null,
        },
      });
    };
    const oldGrant = makeGrant(oldUser, '20', '0.6900408');
    const currentGrant = makeGrant(currentUser, '112', '1.89944145');
    const makeAllocation = (
      grant: ReturnType<typeof makeReconciledFinanceGrant>,
      user: FinanceTestUser,
      amount: string,
    ) => ({
      id: `allocation-${user.id}`,
      userId: user.id,
      tenantId: grant.tenantId,
      productId: product.id,
      billingAccountId: grant.billingAccountId,
      balanceTransactionId: `transaction-${user.id}`,
      tokenUsageId: null,
      balanceGrantId: grant.id,
      source: 'BALANCE_GRANT',
      amountUsd: new Prisma.Decimal(amount),
      recognizedRevenueUsd: new Prisma.Decimal(amount),
      bonusConsumedUsd: new Prisma.Decimal(0),
      discountRate: new Prisma.Decimal(1),
      createdAt: new Date('2026-07-15T09:00:00.000Z'),
      user,
      tenant: {
        id: grant.tenantId,
        name: '默认工作区',
        slug: grant.tenantId,
        type: 'personal',
      },
      product,
      balanceGrant: grant,
      balanceTransaction: {
        id: `transaction-${user.id}`,
        orderId: null,
        description: 'API',
        createdAt: new Date('2026-07-15T09:00:00.000Z'),
      },
      tokenUsage: null,
    });
    const financePrisma = makeFinanceReportPrisma([], {
      balanceGrants: [oldGrant, currentGrant],
      balanceConsumptionAllocations: [
        makeAllocation(oldGrant, oldUser, '0.6900408'),
        makeAllocation(currentGrant, currentUser, '1.89944145'),
      ],
    });
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    const report = await service.getFinanceReports('2026-07');
    const byUserId = (rows: Record<string, unknown>[]) => new Map(
      rows.map((row) => [String(row.userId), row]),
    );
    const accountRows = byUserId(report.financeTemplates.buyGift.accountChangeSummary);
    const paymentRows = byUserId(report.financeTemplates.buyGift.paymentSummary);
    const consumptionRows = byUserId(report.financeTemplates.buyGift.consumptionSummary);

    expect(accountRows.size).toBe(2);
    expect(accountRows.get(currentUser.id)).toEqual(expect.objectContaining({
      userLabel: phone,
      accumulatedCollectionAmountCents: 11200,
      cumulativeConsumeOrExpireAmountCents: 190,
    }));
    expect(accountRows.get(oldUser.id)).toEqual(expect.objectContaining({
      userLabel: phone,
      accumulatedCollectionAmountCents: 2000,
      cumulativeConsumeOrExpireAmountCents: 69,
    }));
    expect(paymentRows.size).toBe(2);
    expect(paymentRows.get(currentUser.id)).toEqual(expect.objectContaining({
      accumulatedCollectionAmountCents: 11200,
    }));
    expect(paymentRows.get(oldUser.id)).toEqual(expect.objectContaining({
      accumulatedCollectionAmountCents: 2000,
    }));
    expect(consumptionRows.size).toBe(2);
    expect(consumptionRows.get(currentUser.id)).toEqual(expect.objectContaining({
      userLabel: phone,
      consumeAmountCents: 190,
      consumeAmountPaidCents: 190,
    }));
    expect(consumptionRows.get(oldUser.id)).toEqual(expect.objectContaining({
      userLabel: phone,
      consumeAmountCents: 69,
      consumeAmountPaidCents: 69,
    }));
    expect(Array.from(accountRows.values())).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ accumulatedCollectionAmountCents: 13200 }),
      expect.objectContaining({ cumulativeConsumeOrExpireAmountCents: 259 }),
    ]));
  });

  it('uses persisted paid/bonus remaining components after a paid-only mixed-grant refund', () => {
    const { service } = buildService();
    const occurredAt = new Date('2026-05-10T00:00:00Z');
    const grant = withDefaultFinanceGrantAccount({
      id: 'grant-mixed-refund',
      userId: 'user-1',
      tenantId: 'tenant-1',
      ...reconciledFinanceGrantAccount(),
      orderId: 'order-mixed-refund',
      productId: 'prod-payg',
      source: 'RECHARGE',
      paidAmountUsd: new Prisma.Decimal(5),
      bonusAmountUsd: new Prisma.Decimal(5),
      grantedAmountUsd: new Prisma.Decimal(10),
      remainingAmountUsd: new Prisma.Decimal(5),
      remainingPaidAmountUsd: new Prisma.Decimal(0),
      remainingBonusAmountUsd: new Prisma.Decimal(5),
      discountRate: new Prisma.Decimal('0.5'),
      validFrom: new Date('2026-04-01T00:00:00Z'),
      expiresAt: new Date('2027-04-01T00:00:00Z'),
      isExpired: false,
      createdAt: new Date('2026-04-01T00:00:00Z'),
      targetRefunds: [{
        component: 'PAID',
        requestedAmountUsd: new Prisma.Decimal(5),
        occurredAt,
      }],
      refundAllocations: [{
        role: 'TARGET_UNUSED',
        amountUsd: new Prisma.Decimal(5),
        paidReductionUsd: new Prisma.Decimal(5),
        bonusReductionUsd: new Prisma.Decimal(0),
        refund: { occurredAt },
      }],
      debtSettlements: [],
      expiryAudit: null,
      order: {
        id: 'order-mixed-refund',
        amountCents: 500,
        bonusCents: 500,
        currency: 'usd',
        status: OrderStatus.REFUNDED,
        refundedAt: occurredAt,
        refundAmountCents: 500,
      },
    });

    const row = (service as any).buildBuyGiftAccountChangeRow(
      '2026-05',
      grant,
      [],
      [],
      new Date('2026-05-01T00:00:00Z'),
      new Date('2026-06-01T00:00:00Z'),
      'USD',
    );

    expect(row).toEqual(expect.objectContaining({
      openingAvailableBalanceCents: 1000,
      openingAvailableBalancePaidCents: 500,
      periodRefundWriteOffAmountCents: -500,
      periodRefundWriteOffPaidCents: -500,
      closingAvailableBalanceCents: 500,
      closingAvailableBalancePaidCents: 0,
    }));
  });

  it('separates refund write-off period from payment cash-out without counting the audit twice', async () => {
    const financePrisma = makeFinanceReportPrisma();
    const { service } = buildService({ prismaOverrides: financePrisma as any });
    const auditedAt = new Date('2026-05-31T12:00:00Z');
    const channelRefundedAt = new Date('2026-06-01T12:00:00Z');
    const grant = withDefaultFinanceGrantAccount({
      id: 'grant-cross-period-refund',
      userId: 'user-1',
      tenantId: 'tenant-1',
      ...reconciledFinanceGrantAccount(),
      orderId: 'order-cross-period-refund',
      productId: 'prod-payg',
      source: 'RECHARGE',
      paidAmountUsd: new Prisma.Decimal(5),
      bonusAmountUsd: new Prisma.Decimal(0),
      grantedAmountUsd: new Prisma.Decimal(5),
      remainingAmountUsd: new Prisma.Decimal(0),
      remainingPaidAmountUsd: new Prisma.Decimal(0),
      remainingBonusAmountUsd: new Prisma.Decimal(0),
      discountRate: new Prisma.Decimal(1),
      validFrom: new Date('2026-04-01T00:00:00Z'),
      expiresAt: new Date('2027-04-01T00:00:00Z'),
      isExpired: false,
      createdAt: new Date('2026-04-01T00:00:00Z'),
      targetRefunds: [{
        component: 'PAID',
        requestedAmountUsd: new Prisma.Decimal(5),
        occurredAt: auditedAt,
      }],
      refundAllocations: [{
        role: 'TARGET_UNUSED',
        amountUsd: new Prisma.Decimal(5),
        paidReductionUsd: new Prisma.Decimal(5),
        bonusReductionUsd: new Prisma.Decimal(0),
        refund: { occurredAt: auditedAt },
      }],
      debtSettlements: [],
      expiryAudit: null,
      order: {
        id: 'order-cross-period-refund',
        amountCents: 500,
        bonusCents: 0,
        currency: 'usd',
        status: OrderStatus.REFUNDED,
        paidAt: new Date('2026-04-01T00:00:00Z'),
        completedAt: new Date('2026-04-01T00:00:00Z'),
        refundedAt: channelRefundedAt,
        refundAmountCents: 500,
      },
    });

    const may = (service as any).buildBuyGiftAccountChangeRow(
      '2026-05',
      grant,
      [],
      [],
      new Date('2026-05-01T00:00:00Z'),
      new Date('2026-06-01T00:00:00Z'),
      'USD',
    );
    const june = (service as any).buildBuyGiftAccountChangeRow(
      '2026-06',
      grant,
      [],
      [],
      new Date('2026-06-01T00:00:00Z'),
      new Date('2026-07-01T00:00:00Z'),
      'USD',
    );

    expect(may).toEqual(expect.objectContaining({
      periodRefundWriteOffAmountCents: -500,
      periodRefundWriteOffPaidCents: -500,
      periodRefundPaymentAmountCents: 0,
    }));
    expect(june).toEqual(expect.objectContaining({
      refundWriteOffPaidCents: 0,
      periodRefundWriteOffAmountCents: 0,
      periodRefundWriteOffPaidCents: 0,
      periodRefundPaymentAmountCents: -500,
    }));

    financePrisma.balanceGrant.findMany.mockResolvedValue([grant]);
    const loadReport = (month: string, tab: string) => service.getFinanceReportDetail({
      month,
      tab,
      billingMode: ProductBillingMode.PAY_AS_YOU_GO,
    });
    const exportReport = (month: string, tab: string) => (
      (service as any).collectFinanceExportRows({
        month,
        tab,
        billingMode: ProductBillingMode.PAY_AS_YOU_GO,
      })
    );

    const mayAccountSummary = await loadReport('2026-05', 'buyGiftAccountSummary');
    expect(mayAccountSummary.rows).toEqual([
      expect.objectContaining({
        periodRefundWriteOffAmountCents: -500,
        periodRefundPaymentAmountCents: 0,
      }),
    ]);

    const juneAccountDetail = await loadReport('2026-06', 'buyGiftAccountChanges');
    const junePaymentDetail = await loadReport('2026-06', 'buyGiftPaymentDetails');
    const juneAccountSummary = await loadReport('2026-06', 'buyGiftAccountSummary');
    const junePaymentSummary = await loadReport('2026-06', 'buyGiftPaymentSummary');
    for (const report of [
      juneAccountDetail,
      junePaymentDetail,
      juneAccountSummary,
      junePaymentSummary,
    ]) {
      expect(report.rows).toEqual([
        expect.objectContaining({ periodRefundPaymentAmountCents: -500 }),
      ]);
      expect(
        (service as any)
          .getFinanceRawUsd(
            report.rows[0] as Record<string, unknown>,
            'periodRefundPaymentAmountCents',
          )
          .toString(),
      ).toBe('-5');
    }

    const juneAccountDetailExport = await exportReport('2026-06', 'buyGiftAccountChanges');
    const junePaymentDetailExport = await exportReport('2026-06', 'buyGiftPaymentDetails');
    const juneAccountSummaryExport = await exportReport('2026-06', 'buyGiftAccountSummary');
    const junePaymentSummaryExport = await exportReport('2026-06', 'buyGiftPaymentSummary');
    expect(juneAccountDetailExport).toEqual(juneAccountDetail.rows);
    expect(junePaymentDetailExport).toEqual(junePaymentDetail.rows);
    expect(juneAccountSummaryExport).toEqual(juneAccountSummary.rows);
    expect(junePaymentSummaryExport).toEqual(junePaymentSummary.rows);

    const julyAccountDetail = await loadReport('2026-07', 'buyGiftAccountChanges');
    const julyPaymentDetail = await loadReport('2026-07', 'buyGiftPaymentDetails');
    expect(julyAccountDetail.rows).toEqual([]);
    expect(julyPaymentDetail.rows).toEqual([]);
    const julyAccountSummary = await loadReport('2026-07', 'buyGiftAccountSummary');
    const julyPaymentSummary = await loadReport('2026-07', 'buyGiftPaymentSummary');
    for (const report of [julyAccountSummary, julyPaymentSummary]) {
      expect(report.rows).toEqual([
        expect.objectContaining({
          periodRefundPaymentAmountCents: 0,
          accumulatedRefundPaymentAmountCents: -500,
        }),
      ]);
    }
    expect(await exportReport('2026-07', 'buyGiftAccountSummary')).toEqual(
      julyAccountSummary.rows,
    );
    expect(await exportReport('2026-07', 'buyGiftPaymentSummary')).toEqual(
      julyPaymentSummary.rows,
    );
  });

  it('records recharge debt settlement as exact period consumption and preserves the batch equation', () => {
    const { service } = buildService();
    const occurredAt = new Date('2026-05-10T00:00:00Z');
    const grant = withDefaultFinanceGrantAccount({
      id: 'grant-negative-fill',
      userId: 'user-1',
      tenantId: 'tenant-1',
      ...reconciledFinanceGrantAccount(),
      orderId: 'order-negative-fill',
      productId: 'prod-payg',
      source: 'RECHARGE',
      paidAmountUsd: new Prisma.Decimal(5),
      bonusAmountUsd: new Prisma.Decimal(0),
      grantedAmountUsd: new Prisma.Decimal(5),
      remainingAmountUsd: new Prisma.Decimal('4.86'),
      remainingPaidAmountUsd: new Prisma.Decimal('4.86'),
      remainingBonusAmountUsd: new Prisma.Decimal(0),
      discountRate: new Prisma.Decimal(1),
      validFrom: occurredAt,
      expiresAt: new Date('2027-05-10T00:00:00Z'),
      isExpired: false,
      createdAt: occurredAt,
      targetRefunds: [],
      refundAllocations: [],
      debtSettlements: [{
        trigger: 'FUNDING',
        amountUsd: new Prisma.Decimal('0.14'),
        paidUsd: new Prisma.Decimal('0.14'),
        bonusUsd: new Prisma.Decimal(0),
        occurredAt,
      }],
      expiryAudit: null,
      order: {
        id: 'order-negative-fill',
        amountCents: 500,
        bonusCents: 0,
        currency: 'usd',
        status: OrderStatus.COMPLETED,
        paidAt: occurredAt,
        completedAt: occurredAt,
        refundedAt: null,
        refundAmountCents: null,
      },
    });

    const row = (service as any).buildBuyGiftAccountChangeRow(
      '2026-05',
      grant,
      [],
      [],
      new Date('2026-05-01T00:00:00Z'),
      new Date('2026-06-01T00:00:00Z'),
      'USD',
    );

    expect(row).toEqual(expect.objectContaining({
      openingAvailableBalanceCents: 0,
      periodRechargeAmountCents: 500,
      periodConsumeAmountCents: -14,
      closingAvailableBalanceCents: 486,
      openingAvailableBalancePaidCents: 0,
      periodRechargePaidCents: 500,
      periodConsumePaidCents: -14,
      closingAvailableBalancePaidCents: 486,
    }));
    expect(
      row.openingAvailableBalanceCents
      + row.periodRechargeAmountCents
      + row.periodRefundWriteOffAmountCents
      + row.periodConsumeAmountCents
      + row.periodExpireWriteOffAmountCents
      + row.periodOtherChangeAmountCents,
    ).toBe(row.closingAvailableBalanceCents);
  });

  it('uses the expiry audit component split instead of the original discount rate', () => {
    const { service } = buildService();
    const expiredAt = new Date('2026-05-10T00:00:00Z');
    const grant = {
      id: 'grant-expired-components',
      userId: 'user-1',
      tenantId: 'tenant-1',
      ...reconciledFinanceGrantAccount(),
      orderId: 'order-expired-components',
      productId: 'prod-payg',
      source: 'RECHARGE',
      paidAmountUsd: new Prisma.Decimal(2),
      bonusAmountUsd: new Prisma.Decimal(3),
      grantedAmountUsd: new Prisma.Decimal(5),
      remainingAmountUsd: new Prisma.Decimal(0),
      remainingPaidAmountUsd: new Prisma.Decimal(0),
      remainingBonusAmountUsd: new Prisma.Decimal(0),
      discountRate: new Prisma.Decimal('0.4'),
      validFrom: new Date('2026-04-01T00:00:00Z'),
      expiresAt: expiredAt,
      isExpired: true,
      createdAt: new Date('2026-04-01T00:00:00Z'),
      targetRefunds: [],
      refundAllocations: [],
      debtSettlements: [],
      expiryAudit: {
        balanceGrantId: 'grant-expired-components',
        billingAccountId: 'billing-account-1',
        balanceTransactionId: 'expiry-tx-1',
        nominalAmountUsd: new Prisma.Decimal(3),
        nominalPaidUsd: new Prisma.Decimal(1),
        nominalBonusUsd: new Prisma.Decimal(2),
        walletDebitUsd: new Prisma.Decimal(3),
        walletDebitPaidUsd: new Prisma.Decimal(1),
        walletDebitBonusUsd: new Prisma.Decimal(2),
        unbackedAmountUsd: new Prisma.Decimal(0),
        unbackedPaidUsd: new Prisma.Decimal(0),
        unbackedBonusUsd: new Prisma.Decimal(0),
        createdAt: expiredAt,
      },
      order: null,
    };
    const allocations = [{
      id: 'pre-expiry-consumption',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-payg',
      balanceTransactionId: 'consume-before-expiry',
      balanceGrantId: 'grant-expired-components',
      billingAccountId: 'billing-account-1',
      source: 'BALANCE_GRANT',
      amountUsd: new Prisma.Decimal(2),
      recognizedRevenueUsd: new Prisma.Decimal(1),
      bonusConsumedUsd: new Prisma.Decimal(1),
      discountRate: new Prisma.Decimal('0.5'),
      createdAt: new Date('2026-04-10T00:00:00Z'),
    }];
    const transactions = [{
      id: 'expiry-tx-1',
      type: TransactionType.ADJUST,
      amountUsd: new Prisma.Decimal(-3),
      description: 'balance grant expired:grant-expired-components',
      createdAt: expiredAt,
    }];
    const start = new Date('2026-05-01T00:00:00Z');
    const end = new Date('2026-06-01T00:00:00Z');

    const row = (service as any).buildBuyGiftAccountChangeRow(
      '2026-05',
      grant,
      allocations,
      transactions,
      start,
      end,
      'USD',
      undefined,
      end,
      new Set(),
      { paidUsd: new Prisma.Decimal(1), bonusUsd: new Prisma.Decimal(1) },
    );

    expect(row).toEqual(expect.objectContaining({
      openingAvailableBalanceCents: 300,
      openingAvailableBalancePaidCents: 100,
      periodExpireWriteOffAmountCents: -300,
      periodExpireWriteOffPaidCents: -100,
      closingAvailableBalanceCents: 0,
      closingAvailableBalancePaidCents: 0,
    }));

    expect(() => (service as any).buildBuyGiftAccountChangeRow(
      '2026-05',
      grant,
      allocations,
      transactions,
      start,
      end,
      'USD',
      undefined,
      end,
      new Set(),
      { paidUsd: new Prisma.Decimal('0.5'), bonusUsd: new Prisma.Decimal('1.5') },
    )).toThrow(
      'BALANCE_LEDGER_RECONCILIATION_REQUIRED:grant-expired-components:expiry_audit_replay_components',
    );
  });

  it('fails closed when a period contains an unclassified grant transaction without component facts', () => {
    const { service } = buildService();
    const grant = makeReconciledFinanceGrant();

    expect(() => (service as any).buildBuyGiftAccountChangeRow(
      '2026-05',
      grant,
      [],
      [{
        id: 'legacy-adjust-1',
        type: TransactionType.ADJUST,
        amountUsd: new Prisma.Decimal(-1),
        description: 'legacy adjust for finance-grant-1',
        createdAt: new Date('2026-05-10T00:00:00Z'),
      }],
      new Date('2026-05-01T00:00:00Z'),
      new Date('2026-06-01T00:00:00Z'),
      'USD',
    )).toThrow('BALANCE_LEDGER_RECONCILIATION_REQUIRED:finance-grant-1:unclassified_transaction_components');
  });

  it('fails closed when a linked allocation component split does not equal its amount', () => {
    const { service } = buildService();
    const grant = makeReconciledFinanceGrant({
      remainingAmountUsd: new Prisma.Decimal(4),
      remainingPaidAmountUsd: new Prisma.Decimal(4),
    });

    expect(() => (service as any).buildBuyGiftAccountChangeRow(
      '2026-05',
      grant,
      [{
        id: 'polluted-allocation',
        userId: 'member-user',
        tenantId: 'member-workspace',
        billingAccountId: 'billing-account-1',
        productId: 'prod-payg',
        balanceTransactionId: 'consume-1',
        balanceGrantId: 'finance-grant-1',
        source: 'BALANCE_GRANT',
        amountUsd: new Prisma.Decimal(2),
        recognizedRevenueUsd: new Prisma.Decimal(1),
        bonusConsumedUsd: new Prisma.Decimal(0),
        discountRate: new Prisma.Decimal(1),
        createdAt: new Date('2026-05-10T00:00:00Z'),
      }],
      [],
      new Date('2026-05-01T00:00:00Z'),
      new Date('2026-06-01T00:00:00Z'),
      'USD',
    )).toThrow('BALANCE_LEDGER_RECONCILIATION_REQUIRED:finance-grant-1:allocation_components');
  });

  it('does not let enterprise absorb proof bypass allocation component checks', () => {
    const { service } = buildService();
    const grant = makeReconciledFinanceGrant({
      remainingAmountUsd: new Prisma.Decimal(4),
      remainingPaidAmountUsd: new Prisma.Decimal(4),
    });
    const end = new Date('2026-06-01T00:00:00Z');

    expect(() => (service as any).buildBuyGiftAccountChangeRow(
      '2026-05',
      grant,
      [{
        id: 'proof-covered-but-polluted',
        userId: 'member-user',
        tenantId: 'member-workspace',
        billingAccountId: 'absorbed-personal-account',
        productId: 'prod-payg',
        balanceTransactionId: 'consume-1',
        balanceGrantId: 'finance-grant-1',
        source: 'BALANCE_GRANT',
        amountUsd: new Prisma.Decimal(2),
        recognizedRevenueUsd: new Prisma.Decimal(1),
        bonusConsumedUsd: new Prisma.Decimal(0),
        discountRate: new Prisma.Decimal(1),
        createdAt: new Date('2026-05-10T00:00:00Z'),
      }],
      [],
      new Date('2026-05-01T00:00:00Z'),
      end,
      'USD',
      undefined,
      end,
      new Set(['proof-covered-but-polluted']),
    )).toThrow('BALANCE_LEDGER_RECONCILIATION_REQUIRED:finance-grant-1:allocation_components');
  });

  it('fails closed instead of estimating invalid closing paid and bonus components', () => {
    const { service } = buildService();
    const grant = makeReconciledFinanceGrant({
      remainingAmountUsd: new Prisma.Decimal(4),
      remainingPaidAmountUsd: new Prisma.Decimal(3),
      remainingBonusAmountUsd: null,
    });

    expect(() => (service as any).buildBuyGiftAccountChangeRow(
      '2026-05',
      grant,
      [],
      [],
      new Date('2026-05-01T00:00:00Z'),
      new Date('2026-06-01T00:00:00Z'),
      'USD',
    )).toThrow('BALANCE_LEDGER_RECONCILIATION_REQUIRED:finance-grant-1:grant_components');
  });

  it('fails closed when an expired grant has no immutable expiry audit', () => {
    const { service } = buildService();
    const grant = makeReconciledFinanceGrant({
      isExpired: true,
      remainingAmountUsd: new Prisma.Decimal(0),
      remainingPaidAmountUsd: new Prisma.Decimal(0),
      remainingBonusAmountUsd: new Prisma.Decimal(0),
      expiresAt: new Date('2026-05-10T00:00:00Z'),
    });

    expect(() => (service as any).buildBuyGiftAccountChangeRow(
      '2026-05',
      grant,
      [],
      [],
      new Date('2026-05-01T00:00:00Z'),
      new Date('2026-06-01T00:00:00Z'),
      'USD',
      undefined,
      new Date('2026-06-01T00:00:00Z'),
      new Set(),
      { paidUsd: new Prisma.Decimal(0), bonusUsd: new Prisma.Decimal(0) },
    )).toThrow('BALANCE_LEDGER_RECONCILIATION_REQUIRED:finance-grant-1:expiry_due_unreconciled');
  });

  it('rejects a DIRTY account at the finance entrypoint even when grant components are valid', async () => {
    const dirtyGrant = makeReconciledFinanceGrant({
      billingAccount: {
        id: 'billing-account-1',
        balanceGrantLedgerStatus: 'LEGACY_DIRTY',
        balanceGrantLedgerVersion: 0,
      },
    });
    const financePrisma = makeFinanceReportPrisma([], { balanceGrants: [dirtyGrant] });
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    await expect(service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'buyGiftAccountChanges',
      pageSize: 10,
    })).rejects.toThrow('BALANCE_LEDGER_RECONCILIATION_REQUIRED:finance-grant-1:account_marker');
  });

  it('builds TokenPlan monthly revenue recognition with straight-line deferral and refund treatment', async () => {
    const user = { id: 'user-1', email: 'user@example.com', phone: null, nickname: null };
    const tenant = { id: 'tenant-1', name: '默认工作区', slug: 'default', type: 'personal' };
    const product = {
      id: 'prod-coding',
      name: 'TokenPlan',
      slug: 'token-plan',
      billingMode: ProductBillingMode.CODING_PLAN,
    };
    const plan = {
      id: 'plan-token',
      name: 'TokenPlan Pro',
      billingPeriod: 'monthly',
      validityDays: 30,
      product,
    };
    const newOrder = {
      id: 'order-new',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-coding',
      planId: 'plan-token',
      amountCents: 3000,
      refundAmountCents: null,
      currency: 'usd',
      billingPeriod: 'monthly',
      status: OrderStatus.COMPLETED,
      paidAt: new Date('2026-05-16T00:00:00Z'),
      completedAt: new Date('2026-05-16T00:00:00Z'),
      refundedAt: null,
      createdAt: new Date('2026-05-16T00:00:00Z'),
      user,
      tenant,
      product,
      plan,
      items: [],
    };
    const refundedOrder = {
      id: 'order-refund',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-coding',
      planId: 'plan-token',
      amountCents: 9100,
      refundAmountCents: 5000,
      currency: 'usd',
      billingPeriod: 'monthly',
      status: OrderStatus.REFUNDED,
      paidAt: new Date('2026-04-01T00:00:00Z'),
      completedAt: new Date('2026-04-01T00:00:00Z'),
      refundedAt: new Date('2026-05-16T00:00:00Z'),
      createdAt: new Date('2026-04-01T00:00:00Z'),
      user,
      tenant,
      product,
      plan,
      items: [],
    };
    const financePrisma = makeFinanceReportPrisma([], {
      orders: [newOrder, refundedOrder],
      codingPlanEntitlements: [
        {
          id: 'ent-new',
          orderId: 'order-new',
          billingPeriod: 'monthly',
          fulfillmentMode: 'provider_resale',
          status: 'ACTIVE',
          startedAt: new Date('2026-05-16T00:00:00Z'),
          expiresAt: new Date('2026-06-15T00:00:00Z'),
          providerEntitlementId: 'provider-ent-new',
          providerLineCode: 'zhipu-overseas',
          providerCode: 'zhipu',
          upstreamProductId: 'upstream-pro',
        },
        {
          id: 'ent-refund',
          orderId: 'order-refund',
          billingPeriod: 'monthly',
          fulfillmentMode: 'provider_resale',
          status: 'CANCELLED',
          startedAt: new Date('2026-04-01T00:00:00Z'),
          expiresAt: new Date('2026-07-01T00:00:00Z'),
          providerEntitlementId: 'provider-ent-refund',
          providerLineCode: 'zhipu-overseas',
          providerCode: 'zhipu',
          upstreamProductId: 'upstream-pro',
        },
      ],
    });
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    const result = await service.getFinanceReports('2026-05');

    const details = result.tokenPlanRevenueRecognition.details;
    expect(details).toHaveLength(2);
    expect(details.find((row: any) => row.orderId === 'order-new')).toEqual(expect.objectContaining({
      newDeferredCents: 3000,
      serviceRecognizedRevenueCents: 1567,
      refundAppliedToDeferredCents: 0,
      refundRevenueReversalCents: 0,
      recognizedRevenueCents: 1567,
      closingDeferredCents: 1433,
    }));
    expect(details.find((row: any) => row.orderId === 'order-refund')).toEqual(expect.objectContaining({
      openingDeferredCents: 6133,
      serviceRecognizedRevenueCents: 1533,
      refundAppliedToDeferredCents: 4600,
      refundRevenueReversalCents: 400,
      recognizedRevenueCents: 1133,
      closingDeferredCents: 0,
    }));
    expect(result.tokenPlanRevenueRecognition.summary).toEqual([
      expect.objectContaining({
        orderCount: 2,
        orderAmountCents: 12100,
        openingDeferredCents: 6133,
        newDeferredCents: 3000,
        serviceRecognizedRevenueCents: 3100,
        refundAppliedToDeferredCents: 4600,
        refundRevenueReversalCents: 400,
        recognizedRevenueCents: 2700,
        closingDeferredCents: 1433,
        deferredVarianceCents: 0,
      }),
    ]);
    expect(result.metrics.tokenPlanRecognizedRevenueCents).toBe(2700);
    expect(result.metrics.tokenPlanClosingDeferredCents).toBe(1433);
  });
});

describe('BillingAdminService finance grant transaction lookup', () => {
  it('loads only the expiry transactions linked by the structured grant audit', async () => {
    const { service } = buildService();
    const findMany = jest.fn().mockResolvedValue([{ id: 'expiry-tx-1' }]);
    const start = new Date('2026-09-01T00:00:00.000Z');
    const end = new Date('2026-10-01T00:00:00.000Z');

    const result = await (service as any).fetchFinanceBalanceTransactionsForGrants(
      [
        { id: 'grant-1', expiryAudit: { balanceTransactionId: 'expiry-tx-1' } },
        { id: 'grant-2', expiryAudit: { balanceTransactionId: 'expiry-tx-1' } },
        { id: 'grant-3', expiryAudit: null },
      ],
      start,
      end,
      { balanceTransaction: { findMany } },
    );

    expect(result).toEqual([{ id: 'expiry-tx-1' }]);
    expect(findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: { in: ['expiry-tx-1'] },
        createdAt: { gte: start, lt: end },
      },
    }));
    expect(findMany.mock.calls[0][0].where).not.toHaveProperty('OR');
    expect(JSON.stringify(findMany.mock.calls[0][0])).not.toContain('descriptionFilters');
  });

  it('skips the transaction table when none of the grants has an expiry transaction link', async () => {
    const { service } = buildService();
    const findMany = jest.fn();

    await expect((service as any).fetchFinanceBalanceTransactionsForGrants(
      [{ id: 'grant-1', expiryAudit: null }],
      new Date('2026-09-01T00:00:00.000Z'),
      new Date('2026-10-01T00:00:00.000Z'),
      { balanceTransaction: { findMany } },
    )).resolves.toEqual([]);
    expect(findMany).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getFinanceReportOverview / getFinanceReportDetail
// ---------------------------------------------------------------------------
describe('BillingAdminService paginated finance reports', () => {
  it('uses authoritative User contacts before rendering page and CSV user labels', async () => {
    const createdAt = new Date('2026-05-10T00:00:00.000Z');
    const personalOrder = {
      id: 'personal-order',
      userId: 'personal-user',
      tenantId: 'personal-tenant',
      createdAt,
      amountCents: 100,
      currency: 'CNY',
      user: { id: 'personal-user', email: null, phone: null, nickname: '错误的人名' },
      billingAccount: { type: 'personal' },
    };
    const { service, prisma } = buildService({
      systemConfigOverrides: {
        getDeploymentConfig: jest.fn().mockResolvedValue({ currency: 'cny', region: 'domestic' }),
      },
      financeUserIdentityOverrides: {
        getContactsByIds: jest.fn().mockResolvedValue(new Map([[
          'personal-user',
          { id: 'personal-user', phone: '13800138000', email: null, nickname: '错误的人名' },
        ]])),
      },
    });
    prisma.order.findMany.mockResolvedValue([personalOrder]);

    const report = await service.getFinanceReportDetail({ month: '2026-05', tab: 'orders' });
    expect(report.rows[0]).toEqual(expect.objectContaining({ userLabel: '13800138000' }));
    expect((service as any).buildFinanceExportCsv('orders', report.rows))
      .toContain('13800138000');

    const overseasPrisma = makeFinanceReportPrisma([], { orders: [{
      ...personalOrder,
      id: 'overseas-order',
      userId: 'overseas-user',
      user: { id: 'overseas-user', email: null, phone: null, nickname: 'Wrong Name' },
    }] });
    const { service: overseasService } = buildService({
      prismaOverrides: overseasPrisma as any,
      systemConfigOverrides: {
        getDeploymentConfig: jest.fn().mockResolvedValue({ currency: 'usd', region: 'overseas' }),
      },
      financeUserIdentityOverrides: {
        getContactsByIds: jest.fn().mockResolvedValue(new Map([[
          'overseas-user',
          { id: 'overseas-user', phone: null, email: 'global@example.com', nickname: 'Wrong Name' },
        ]])),
      },
    });
    overseasPrisma.order.findMany.mockReset().mockResolvedValue([{
      ...personalOrder,
      id: 'overseas-order',
      userId: 'overseas-user',
      user: { id: 'overseas-user', email: null, phone: null, nickname: 'Wrong Name' },
    }]);

    const overseasReport = await overseasService.getFinanceReportDetail({
      month: '2026-05',
      tab: 'orders',
    });
    expect(overseasReport.rows[0]).toEqual(expect.objectContaining({
      userLabel: 'global@example.com',
    }));
  });

  it('uses authoritative contacts in credits and API usage instead of a mirrored nickname', async () => {
    const createdAt = new Date('2026-05-10T00:00:00.000Z');
    const creditPrisma = makeFinanceReportPrisma();
    creditPrisma.creditTransaction.findMany.mockResolvedValue([{
      id: 'credit-1',
      userId: 'personal-user',
      tenantId: 'personal-tenant',
      productId: null,
      subscriptionId: null,
      type: 'CONSUME',
      creditsAmount: -1,
      source: 'chat:test',
      modelName: 'test-model',
      inputTokens: 1,
      cachedInputTokens: 0,
      outputTokens: 1,
      totalTokens: 2,
      requestId: 'request-1',
      quotaAfter: 9,
      bonusAfter: 0,
      createdAt,
      user: { id: 'personal-user', email: null, phone: null, nickname: '错误的人名' },
      tenant: {
        id: 'personal-tenant',
        name: '个人工作区',
        type: 'personal',
        billingAccount: { type: 'personal' },
      },
      product: null,
    }]);
    const { service: creditService } = buildService({
      prismaOverrides: creditPrisma as any,
      systemConfigOverrides: {
        getDeploymentConfig: jest.fn().mockResolvedValue({ currency: 'cny', region: 'domestic' }),
      },
      financeUserIdentityOverrides: {
        getContactsByIds: jest.fn().mockResolvedValue(new Map([[
          'personal-user',
          { id: 'personal-user', phone: '13800138000', email: null, nickname: '错误的人名' },
        ]])),
      },
    });
    const credits = await creditService.getFinanceReportDetail({ month: '2026-05', tab: 'credits' });
    expect(credits.rows[0]).toEqual(expect.objectContaining({ userLabel: '13800138000' }));

    const usage = {
      id: 'usage-1',
      apiKeyId: 'key-1',
      tenantId: 'tenant-1',
      tenant: { id: 'tenant-1', name: 'Workspace', type: 'personal' },
      apiKey: {
        id: 'key-1',
        prefix: 'sk-test',
        userId: 'overseas-user',
        user: { id: 'overseas-user', email: null, phone: null, nickname: 'Wrong Name' },
      },
      product: null,
      model: 'test-model',
      pricingTierKey: 'default',
      promptTokens: 1,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      completionTokens: 1,
      totalTokens: 2,
      inputPriceUsdPerM: new Prisma.Decimal(1),
      cachedInputPriceUsdPerM: new Prisma.Decimal(1),
      cacheWriteInputPriceUsdPerM: new Prisma.Decimal(1),
      outputPriceUsdPerM: new Prisma.Decimal(1),
      costUsd: new Prisma.Decimal('0.000002'),
      customerChargePolicy: 'usage_charge',
      customerChargeUsd: new Prisma.Decimal('0.000002'),
      providerCostEstimateUsd: null,
      codingPlanEntitlementId: null,
      providerEntitlementId: null,
      gatewayBillingEvent: null,
      consumptionAllocations: [],
      createdAt,
    };
    const usagePrisma = makeFinanceReportPrisma([usage]);
    const { service: usageService } = buildService({
      prismaOverrides: usagePrisma as any,
      systemConfigOverrides: {
        getDeploymentConfig: jest.fn().mockResolvedValue({ currency: 'usd', region: 'overseas' }),
      },
      financeUserIdentityOverrides: {
        getContactsByIds: jest.fn().mockResolvedValue(new Map([[
          'overseas-user',
          { id: 'overseas-user', phone: null, email: 'global@example.com', nickname: 'Wrong Name' },
        ]])),
      },
    });
    const apiUsage = await usageService.getFinanceReportDetail({ month: '2026-05', tab: 'apiUsage' });
    expect(apiUsage.rows[0]).toEqual(expect.objectContaining({ userLabel: 'global@example.com' }));
  });

  it('uses account type for domestic user labels in both report rows and CSV', async () => {
    const { service, prisma } = buildService({
      systemConfigOverrides: {
        getDeploymentConfig: jest.fn().mockResolvedValue({ currency: 'cny', region: 'domestic' }),
      },
    });
    const createdAt = new Date('2026-05-10T00:00:00.000Z');
    const contact = { email: 'owner@example.com', phone: '13800138000', nickname: 'Owner' };
    prisma.order.findMany.mockResolvedValue([
      {
        id: 'personal-order', userId: 'personal-user', tenantId: 'personal-tenant',
        createdAt, amountCents: 100, currency: 'CNY', user: contact,
        billingAccount: { type: 'personal' },
      },
      {
        id: 'enterprise-order', userId: 'enterprise-member', tenantId: 'enterprise-tenant',
        createdAt, amountCents: 200, currency: 'CNY', user: contact,
        billingAccount: {
          type: 'enterprise', enterpriseName: '已认证企业有限公司',
          verificationId: 'verification-1', verifiedAt: null,
        },
        tenant: { billingAccount: { type: 'personal' } },
      },
      {
        id: 'unverified-order', userId: 'unverified-user', tenantId: 'unverified-tenant',
        createdAt, amountCents: 300, currency: 'CNY', user: contact,
        billingAccount: { type: 'enterprise', enterpriseName: '待认证企业', verificationId: null, verifiedAt: null },
      },
    ]);

    const result = await service.getFinanceReportDetail({ month: '2026-05', tab: 'orders' });
    expect(result.rows.map((row: any) => row.userLabel)).toEqual([
      '13800138000', '已认证企业有限公司', 'owner@example.com',
    ]);
    const csv = (service as any).buildFinanceExportCsv('orders', result.rows);
    expect(csv).toContain('13800138000');
    expect(csv).toContain('已认证企业有限公司');
    expect(csv).toContain('owner@example.com');
    expect(prisma.order.findMany).toHaveBeenCalledWith(expect.objectContaining({
      include: expect.objectContaining({
        billingAccount: { select: expect.objectContaining({ type: true, enterpriseName: true }) },
      }),
    }));
  });

  it('uses email for overseas accounts and keeps the previous fallback if email is missing', async () => {
    const { service, prisma } = buildService();
    const createdAt = new Date('2026-05-10T00:00:00.000Z');
    prisma.order.findMany.mockResolvedValue([
      {
        id: 'overseas-enterprise', userId: 'user-1', tenantId: 'tenant-1',
        createdAt, amountCents: 100, currency: 'USD',
        user: { email: 'global@example.com', phone: '13800138000' },
        billingAccount: {
          type: 'enterprise', enterpriseName: '已认证企业有限公司',
          verificationId: 'verification-1', verifiedAt: createdAt,
        },
      },
      {
        id: 'overseas-without-email', userId: 'user-2', tenantId: 'tenant-2',
        createdAt, amountCents: 200, currency: 'USD',
        user: { email: null, phone: '13900139000' },
        billingAccount: { type: 'personal' },
      },
    ]);

    const result = await service.getFinanceReportDetail({ month: '2026-05', tab: 'orders' });
    expect(result.rows.map((row: any) => row.userLabel)).toEqual([
      'global@example.com', '13900139000',
    ]);
  });

  it.each([
    '2026-00',
    '2026-13',
    '2026-1',
    '26-01',
    '2026/01',
    '',
  ])('rejects invalid Shanghai accounting month %p', async (month) => {
    const { service } = buildService();

    await expect(service.getFinanceReportDetail({
      month,
      tab: 'supplier',
    })).rejects.toThrow('month 必须是有效的 YYYY-MM 上海账期');
  });

  it('validates structured filter pairs and per-tab whitelists before querying', async () => {
    const financePrisma = makeFinanceReportPrisma();
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    await expect(service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'apiUsage',
      filterField: 'model',
    })).rejects.toThrow('filterField 和 filterValue 必须同时提供');
    await expect(service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'apiUsage',
      filterValue: 'gpt',
    })).rejects.toThrow('filterField 和 filterValue 必须同时提供');
    await expect(service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'apiUsage',
      filterField: 'unknown',
      filterValue: 'value',
    })).rejects.toThrow('不支持的财务报表筛选字段');
    await expect(service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'credits',
      filterField: 'orderId',
      filterValue: 'order-1',
    })).rejects.toThrow('财务报表 Tab credits 不支持按 orderId 筛选');
    await expect(service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'credits',
      filterField: 'product',
      filterValue: 'legacy-product',
    })).rejects.toThrow('财务报表 Tab credits 不支持按 product 筛选');

    expect(financePrisma.tokenUsage.findMany).not.toHaveBeenCalled();
  });

  it('keeps the backend page-size contract at any integer from 1 through 500', async () => {
    const { service } = buildService();

    await expect(service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'supplier',
      pageSize: 17,
    })).resolves.toEqual(expect.objectContaining({
      pagination: expect.objectContaining({ pageSize: 17 }),
    }));
    await expect(service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'supplier',
      pageSize: 501,
    })).rejects.toThrow('pageSize 必须是 1 到 500 的整数');
    expect((service as any).normalizeFinanceReportPageSize(2_000, 2_000)).toBe(2_000);
    expect((service as any).normalizeFinanceReportPageSize(5_000, 5_000)).toBe(5_000);
  });

  it('paginates static report rows and binds cursors to the complete query scope', async () => {
    const { service } = buildService();

    const firstPage = await service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'supplier',
      pageSize: 1,
    });
    expect(firstPage.rows).toHaveLength(1);
    expect(firstPage.pagination).toEqual(expect.objectContaining({
      mode: 'cursor',
      pageSize: 1,
      rowsReturned: 1,
      hasMore: true,
      nextCursor: expect.any(String),
    }));

    const secondPage = await service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'supplier',
      pageSize: 1,
      cursor: firstPage.pagination.nextCursor!,
    });
    expect(secondPage.rows).toHaveLength(1);
    expect(secondPage.rows[0]).not.toEqual(firstPage.rows[0]);

    await expect(service.getFinanceReportDetail({
      month: '2026-06',
      tab: 'supplier',
      pageSize: 1,
      cursor: firstPage.pagination.nextCursor!,
    })).rejects.toThrow('无效的财务报表分页游标');
    await expect(service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'supplier',
      pageSize: 2,
      cursor: firstPage.pagination.nextCursor!,
    })).rejects.toThrow('无效的财务报表分页游标');
  });

  it('pushes model filters into consumption facts before building a summary', async () => {
    const financePrisma = makeFinanceReportPrisma();
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    const result = await service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'pureGiftConsumptionSummary',
      filterField: 'model',
      filterValue: 'GPT-4',
    });

    expect(result.rows).toEqual([]);
    const allocationWhere = financePrisma.balanceConsumptionAllocation.findMany.mock.calls[0][0]
      .where.AND as unknown[];
    expect(allocationWhere).toEqual(expect.arrayContaining([
      {
        tokenUsage: {
          model: {
            contains: 'GPT-4',
            mode: 'insensitive',
          },
        },
      },
    ]));
  });

  it('uses semantic user/workspace filters and includes workspace slug matching', async () => {
    const financePrisma = makeFinanceReportPrisma();
    const { service, financeUserIdentity } = buildService({
      prismaOverrides: financePrisma as any,
      financeUserIdentityOverrides: {
        resolveSearch: jest.fn().mockResolvedValue({
          userIds: ['authority-user'],
          apiKeyIds: ['api-key-authority-user'],
          billingAccountIds: [],
          tenantIds: [],
        }),
      },
    });

    await service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'apiUsage',
      filterField: 'user',
      filterValue: 'user@example.com',
    });
    await service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'apiUsage',
      filterField: 'workspace',
      filterValue: 'global-team',
    });

    const userWhere = financePrisma.tokenUsage.findMany.mock.calls[0][0].where.AND as unknown[];
    expect(userWhere).toEqual(expect.arrayContaining([
      {
        OR: [
          { apiKeyId: { in: ['api-key-authority-user'] } },
          { tenantId: { in: [] } },
        ],
      },
    ]));
    expect(financeUserIdentity.resolveSearch).toHaveBeenCalledWith('user@example.com');
    const workspaceWhere = financePrisma.tokenUsage.findMany.mock.calls[1][0].where.AND as unknown[];
    expect(workspaceWhere).toEqual(expect.arrayContaining([
      {
        OR: [
          { tenantId: 'global-team' },
          {
            tenant: {
              OR: [
                { name: { contains: 'global-team', mode: 'insensitive' } },
                { slug: { contains: 'global-team', mode: 'insensitive' } },
              ],
            },
          },
        ],
      },
    ]));
  });

  it('searches a phone through the existing billing user fields and an authenticated enterprise name', async () => {
    const financePrisma = makeFinanceReportPrisma();
    const { service } = buildService({
      prismaOverrides: financePrisma as any,
      financeUserIdentityOverrides: {
        resolveSearch: jest.fn(async (value: string) => value === '13800138000'
          ? {
              userIds: ['phone-owner'],
              apiKeyIds: ['phone-api-key'],
              billingAccountIds: [],
              tenantIds: [],
            }
          : {
              userIds: ['认证企业'],
              apiKeyIds: [],
              billingAccountIds: ['enterprise-account'],
              tenantIds: ['enterprise-tenant'],
            }),
      },
    });

    await service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'apiUsage',
      filterField: 'user',
      filterValue: '13800138000',
    });
    const phoneWhere = financePrisma.tokenUsage.findMany.mock.calls[0][0].where.AND;
    expect(phoneWhere).toEqual(expect.arrayContaining([
      {
        OR: [
          { apiKeyId: { in: ['phone-api-key'] } },
          { tenantId: { in: [] } },
        ],
      },
    ]));

    await service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'apiUsage',
      filterField: 'user',
      filterValue: '认证企业',
    });
    const enterpriseWhere = financePrisma.tokenUsage.findMany.mock.calls[1][0].where.AND;
    expect(enterpriseWhere).toEqual(expect.arrayContaining([
      {
        OR: [
          { apiKeyId: { in: [] } },
          { tenantId: { in: ['enterprise-tenant'] } },
        ],
      },
    ]));
  });

  it('matches an order by its displayed account before the tenant fallback', async () => {
    const financePrisma = makeFinanceReportPrisma();
    const { service } = buildService({
      prismaOverrides: financePrisma as any,
      financeUserIdentityOverrides: {
        resolveSearch: jest.fn().mockResolvedValue({
          userIds: ['认证企业'],
          apiKeyIds: [],
          billingAccountIds: ['enterprise-account'],
          tenantIds: ['enterprise-tenant'],
        }),
      },
    });

    await service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'orders',
      filterField: 'user',
      filterValue: '认证企业',
    });
    const orderWhere = financePrisma.order.findMany.mock.calls.at(-1)?.[0].where;
    expect(orderWhere.AND[0].AND[1]).toEqual(expect.objectContaining({
      OR: expect.arrayContaining([
        { billingAccountId: { in: ['enterprise-account'] } },
        { billingAccountId: null, tenantId: { in: ['enterprise-tenant'] } },
      ]),
    }));
  });

  it('serializes exact ledger decimals for detail display without changing cents compatibility fields', async () => {
    const transaction = {
      id: 'tx-exact-detail',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: null,
      type: 'CONSUME',
      amountUsd: new Prisma.Decimal('-0.005'),
      balanceAfterUsd: new Prisma.Decimal('-0.14356789'),
      orderId: null,
      tokenUsageId: 'usage-1',
      description: 'exact detail precision',
      createdAt: new Date('2026-05-20T00:00:00Z'),
      user: { id: 'user-1', email: 'user@example.com' },
      tenant: { id: 'tenant-1', name: 'default', type: 'PERSONAL' },
      product: null,
    };
    const financePrisma = makeFinanceReportPrisma([], {
      balanceTransactions: [transaction],
    });
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    const result = await service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'balance',
      pageSize: 100,
    });

    expect(result.rows).toEqual([
      expect.objectContaining({
        amountCents: -1,
        balanceAfterCents: -14,
        rawMajorUnitAmounts: {
          amountCents: '-0.005',
          balanceAfterCents: '-0.14356789',
        },
      }),
    ]);
  });

  it.each([
    {
      type: TransactionType.ADJUST,
      description: 'account credit adjustment',
    },
    {
      type: TransactionType.CONSUME,
      description: 'account debit adjustment',
    },
  ])('uses structured attribution for an account-level $type adjustment', async ({
    type,
    description,
  }) => {
    const transaction = {
      id: `account-adjustment-${type.toLowerCase()}`,
      userId: 'enterprise-owner-1',
      tenantId: 'enterprise-tenant-1',
      billingAccountId: 'enterprise-account-1',
      productId: null,
      type,
      amountUsd: new Prisma.Decimal(type === TransactionType.ADJUST ? '1' : '-1'),
      balanceAfterUsd: new Prisma.Decimal('9'),
      orderId: null,
      tokenUsageId: null,
      description,
      createdAt: new Date('2026-05-20T00:00:00Z'),
      user: { id: 'enterprise-owner-1', email: 'owner@example.com' },
      tenant: { id: 'enterprise-tenant-1', name: 'Enterprise workspace', type: 'enterprise' },
      product: null,
      attribution: {
        balanceGrantId: type === TransactionType.ADJUST ? 'grant-1' : null,
        billingMode: ProductBillingMode.PAY_AS_YOU_GO,
        source: BalanceTransactionAttributionSource.ADMIN_BALANCE_ADJUSTMENT,
      },
    };
    const financePrisma = makeFinanceReportPrisma([], {
      balanceTransactions: [transaction],
    });
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    const result = await service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'balance',
      billingMode: ProductBillingMode.PAY_AS_YOU_GO,
    });

    expect(result.rows).toEqual([
      expect.objectContaining({
        transactionId: transaction.id,
        type,
        productName: '未绑定产品',
        billingMode: ProductBillingMode.PAY_AS_YOU_GO,
      }),
    ]);
    const query = financePrisma.balanceTransaction.findMany.mock.calls[0][0];
    expect(query.include.attribution).toEqual({
      select: { balanceGrantId: true, billingMode: true, source: true },
    });
    expect(query.where.AND[0]).toEqual({
      AND: [
        { createdAt: {
          gte: new Date('2026-04-30T16:00:00.000Z'),
          lt: new Date('2026-05-31T16:00:00.000Z'),
        } },
        {
          OR: [
            { product: { billingMode: ProductBillingMode.PAY_AS_YOU_GO } },
            {
              productId: null,
              attribution: {
                is: {
                  billingMode: ProductBillingMode.PAY_AS_YOU_GO,
                  source: BalanceTransactionAttributionSource.ADMIN_BALANCE_ADJUSTMENT,
                },
              },
            },
          ],
        },
      ],
    });
  });

  it.each([
    ProductBillingMode.SUBSCRIPTION,
    ProductBillingMode.CODING_PLAN,
  ])('keeps %s balance transactions product-backed', async (billingMode) => {
    const financePrisma = makeFinanceReportPrisma();
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    await service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'balance',
      billingMode,
    });

    const modeWhere = financePrisma.balanceTransaction.findMany.mock.calls[0][0].where.AND[0];
    expect(modeWhere).toEqual({
      AND: [
        { createdAt: {
          gte: new Date('2026-04-30T16:00:00.000Z'),
          lt: new Date('2026-05-31T16:00:00.000Z'),
        } },
        { product: { billingMode } },
      ],
    });
  });

  it('does not infer a billing mode without a product or attribution', () => {
    const { service } = buildService();

    const [row] = (service as any).mapFinanceBalanceRows('2026-05', [{
      id: 'unattributed-balance-row',
      userId: 'user-1',
      tenantId: 'tenant-1',
      billingAccountId: 'account-1',
      productId: null,
      type: TransactionType.ADJUST,
      amountUsd: new Prisma.Decimal(1),
      balanceAfterUsd: new Prisma.Decimal(1),
      orderId: null,
      tokenUsageId: null,
      description: 'unclassified account change',
      createdAt: new Date('2026-05-20T00:00:00Z'),
      product: null,
      attribution: null,
    }]);

    expect(row).toEqual(expect.objectContaining({
      productName: '未绑定产品',
      billingMode: null,
    }));
  });

  it('prefers a concrete transaction product over sidecar attribution', () => {
    const { service } = buildService();

    const [row] = (service as any).mapFinanceBalanceRows('2026-05', [{
      id: 'product-backed-balance-row',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'product-subscription',
      type: TransactionType.ADJUST,
      amountUsd: new Prisma.Decimal(1),
      balanceAfterUsd: new Prisma.Decimal(1),
      orderId: null,
      tokenUsageId: null,
      description: 'product-backed change',
      createdAt: new Date('2026-05-20T00:00:00Z'),
      product: {
        name: 'Subscription',
        billingMode: ProductBillingMode.SUBSCRIPTION,
      },
      attribution: {
        billingMode: ProductBillingMode.PAY_AS_YOU_GO,
        source: BalanceTransactionAttributionSource.ADMIN_BALANCE_ADJUSTMENT,
      },
    }]);

    expect(row).toEqual(expect.objectContaining({
      productName: 'Subscription',
      billingMode: ProductBillingMode.SUBSCRIPTION,
    }));
  });

  it('prefers a grant product and otherwise falls back to its attribution', () => {
    const { service } = buildService();
    const attribution = {
      balanceGrantId: 'grant-attributed',
      billingMode: ProductBillingMode.PAY_AS_YOU_GO,
      source: BalanceTransactionAttributionSource.ADMIN_BALANCE_ADJUSTMENT,
    };
    const productGrant = makeReconciledFinanceGrant({
      id: 'grant-product',
      product: {
        name: 'Subscription',
        billingMode: ProductBillingMode.SUBSCRIPTION,
      },
      attribution,
    });
    const attributedGrant = makeReconciledFinanceGrant({
      id: 'grant-attributed',
      productId: null,
      product: null,
      source: 'VOUCHER',
      paidAmountUsd: new Prisma.Decimal(0),
      bonusAmountUsd: new Prisma.Decimal(5),
      remainingPaidAmountUsd: new Prisma.Decimal(0),
      remainingBonusAmountUsd: new Prisma.Decimal(5),
      discountRate: new Prisma.Decimal(0),
      attribution,
    });

    const rows = (service as any).mapFinanceBalanceGrantRows(
      '2026-05',
      [productGrant, attributedGrant],
    );

    expect(rows.map((row: any) => row.billingMode)).toEqual([
      ProductBillingMode.SUBSCRIPTION,
      ProductBillingMode.PAY_AS_YOU_GO,
    ]);
    expect((service as any).withFinanceBalanceGrantBillingMode(
      {},
      ProductBillingMode.PAY_AS_YOU_GO,
    )).toEqual({
      AND: [
        {},
        {
          OR: [
            { product: { billingMode: ProductBillingMode.PAY_AS_YOU_GO } },
            {
              productId: null,
              attribution: {
                is: {
                  billingMode: ProductBillingMode.PAY_AS_YOU_GO,
                  source: BalanceTransactionAttributionSource.ADMIN_BALANCE_ADJUSTMENT,
                },
              },
            },
          ],
        },
      ],
    });
  });

  it('uses allocation product, transaction attribution, grant product, then grant attribution', () => {
    const { service } = buildService();
    const attribution = {
      balanceGrantId: null,
      billingMode: ProductBillingMode.PAY_AS_YOU_GO,
      source: BalanceTransactionAttributionSource.ADMIN_BALANCE_ADJUSTMENT,
    };
    const grantProduct = makeReconciledFinanceGrant({
      productId: 'product-coding',
      product: {
        name: 'Coding plan',
        billingMode: ProductBillingMode.CODING_PLAN,
      },
      attribution: { ...attribution, balanceGrantId: 'finance-grant-1' },
    });
    const grantAttribution = makeReconciledFinanceGrant({
      id: 'grant-attribution-only',
      productId: null,
      product: null,
      attribution: { ...attribution, balanceGrantId: 'grant-attribution-only' },
    });
    const baseAllocation = {
      userId: 'user-1',
      tenantId: 'tenant-1',
      billingAccountId: 'billing-account-1',
      balanceTransactionId: 'transaction-1',
      tokenUsageId: null,
      source: 'BALANCE_GRANT',
      amountUsd: new Prisma.Decimal(1),
      recognizedRevenueUsd: new Prisma.Decimal(1),
      bonusConsumedUsd: new Prisma.Decimal(0),
      discountRate: new Prisma.Decimal(1),
      createdAt: new Date('2026-05-20T00:00:00Z'),
      balanceTransaction: {
        id: 'transaction-1',
        orderId: null,
        description: 'consume',
        createdAt: new Date('2026-05-20T00:00:00Z'),
        attribution: null,
      },
    };
    const allocations = [
      {
        ...baseAllocation,
        id: 'allocation-product',
        productId: 'product-subscription',
        product: {
          name: 'Subscription',
          billingMode: ProductBillingMode.SUBSCRIPTION,
        },
        balanceGrantId: grantProduct.id,
        balanceGrant: grantProduct,
        balanceTransaction: {
          ...baseAllocation.balanceTransaction,
          attribution,
        },
      },
      {
        ...baseAllocation,
        id: 'transaction-attribution',
        productId: null,
        product: null,
        balanceGrantId: grantProduct.id,
        balanceGrant: grantProduct,
        balanceTransaction: {
          ...baseAllocation.balanceTransaction,
          attribution,
        },
      },
      {
        ...baseAllocation,
        id: 'grant-product',
        productId: null,
        product: null,
        balanceGrantId: grantProduct.id,
        balanceGrant: grantProduct,
      },
      {
        ...baseAllocation,
        id: 'grant-attribution',
        productId: null,
        product: null,
        balanceGrantId: grantAttribution.id,
        balanceGrant: grantAttribution,
      },
    ];

    const rows = (service as any).mapFinanceBalanceAllocationRows('2026-05', allocations);

    expect(rows.map((row: any) => row.billingMode)).toEqual([
      ProductBillingMode.SUBSCRIPTION,
      ProductBillingMode.PAY_AS_YOU_GO,
      ProductBillingMode.CODING_PLAN,
      ProductBillingMode.PAY_AS_YOU_GO,
    ]);
    const where = (service as any).withFinanceBalanceAllocationBillingMode(
      {},
      ProductBillingMode.PAY_AS_YOU_GO,
    );
    expect(where.AND[1].OR).toEqual([
      { product: { billingMode: ProductBillingMode.PAY_AS_YOU_GO } },
      {
        productId: null,
        balanceTransaction: { attribution: { is: {
          billingMode: ProductBillingMode.PAY_AS_YOU_GO,
          source: BalanceTransactionAttributionSource.ADMIN_BALANCE_ADJUSTMENT,
        } } },
      },
      {
        productId: null,
        balanceTransaction: { attribution: { is: null } },
        balanceGrant: { is: { product: { billingMode: ProductBillingMode.PAY_AS_YOU_GO } } },
      },
      {
        productId: null,
        balanceTransaction: { attribution: { is: null } },
        balanceGrant: { is: {
          productId: null,
          attribution: { is: {
            billingMode: ProductBillingMode.PAY_AS_YOU_GO,
            source: BalanceTransactionAttributionSource.ADMIN_BALANCE_ADJUSTMENT,
          } },
        } },
      },
    ]);
    expect((service as any).withFinanceBalanceAllocationBillingMode(
      {},
      ProductBillingMode.CODING_PLAN,
    )).toEqual({
      AND: [
        {},
        {
          OR: [
            { product: { billingMode: ProductBillingMode.CODING_PLAN } },
            {
              productId: null,
              balanceTransaction: { attribution: { is: null } },
              balanceGrant: {
                is: { product: { billingMode: ProductBillingMode.CODING_PLAN } },
              },
            },
          ],
        },
      ],
    });
  });

  it('builds overview without loading monthly detail tables', async () => {
    const tokenUsage = {
      id: 'usage-1',
      createdAt: new Date('2026-05-10T00:00:00Z'),
    };
    const financePrisma = makeFinanceReportPrisma([tokenUsage], {
      balanceTransactions: [{ id: 'tx-1' }],
      balanceConsumptionAllocations: [{ id: 'allocation-1' }],
    });
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    const result = await service.getFinanceReportOverview('2026-05');

    expect(financePrisma.tokenUsage.findMany).not.toHaveBeenCalled();
    const tokenUsageWhere = financePrisma.tokenUsage.aggregate.mock.calls[0][0].where;
    expect(tokenUsageWhere.AND[0].createdAt.gte.toISOString()).toBe('2026-04-30T16:00:00.000Z');
    expect(tokenUsageWhere.AND[0].createdAt.lt.toISOString()).toBe('2026-05-31T16:00:00.000Z');
    expect(tokenUsageWhere.AND[1]).toEqual(expect.objectContaining({
      OR: expect.arrayContaining([
        { totalTokens: { gt: 0 } },
        { customerChargeUsd: { gt: 0 } },
        { providerCostEstimateUsd: { gt: 0 } },
        { consumptionAllocations: { some: { amountUsd: { gt: 0 } } } },
        {
          customerChargePolicy: { in: ['usage_charge', 'legacy_cost_usd'] },
          costUsd: { not: 0 },
        },
      ]),
    }));
    expect(financePrisma.balanceTransaction.findMany).not.toHaveBeenCalled();
    expect(financePrisma.balanceConsumptionAllocation.findMany).not.toHaveBeenCalled();
    expect(financePrisma.tokenUsage.count).not.toHaveBeenCalled();
    expect(result.detailCounts.apiUsage).toBe(1);
    expect(result.rowLimits.maxRowsPerDetail).toBe(500);
  });

  it('keeps overview aggregate concurrency within the Prisma pool budget', async () => {
    const financePrisma = makeFinanceReportPrisma();
    let activeQueries = 0;
    let maxActiveQueries = 0;
    const queryMocks = [
      financePrisma.balanceTransaction.aggregate,
      financePrisma.balanceTransaction.count,
      financePrisma.order.aggregate,
      financePrisma.order.count,
      financePrisma.creditTransaction.aggregate,
      financePrisma.creditTransaction.count,
      financePrisma.tokenUsage.aggregate,
      financePrisma.tokenUsage.count,
      financePrisma.balanceGrant.count,
      financePrisma.balanceConsumptionAllocation.count,
      financePrisma.enterpriseCreditSettlement.count,
    ];
    for (const queryMock of queryMocks) {
      const implementation = queryMock.getMockImplementation()!;
      queryMock.mockImplementation(async (...args: unknown[]) => {
        activeQueries += 1;
        maxActiveQueries = Math.max(maxActiveQueries, activeQueries);
        await new Promise((resolveDelay) => setTimeout(resolveDelay, 5));
        try {
          return await implementation(...args);
        } finally {
          activeQueries -= 1;
        }
      });
    }
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    await service.getFinanceReportOverview('2026-05');

    expect(maxActiveQueries).toBeGreaterThan(1);
    expect(maxActiveQueries).toBeLessThanOrEqual(4);
  });

  it('uses structured attribution only for PAYG overview queries', async () => {
    const financePrisma = makeFinanceReportPrisma();
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    await service.getFinanceReportOverview('2026-05', ProductBillingMode.PAY_AS_YOU_GO);

    const balanceOverviewQueries = [
      ...financePrisma.balanceTransaction.aggregate.mock.calls,
      ...financePrisma.balanceTransaction.count.mock.calls,
    ];
    expect(balanceOverviewQueries).toHaveLength(7);
    for (const [query] of balanceOverviewQueries) {
      const serializedWhere = JSON.stringify(query.where);
      expect(serializedWhere).toContain(`\"billingMode\":\"${ProductBillingMode.PAY_AS_YOU_GO}\"`);
      expect(serializedWhere).toContain('attribution');
      expect(serializedWhere).toContain('ADMIN_BALANCE_ADJUSTMENT');
      expect(serializedWhere).not.toContain('description');
      expect(serializedWhere).not.toContain('operationKey');
      expect(serializedWhere).not.toContain('billingAccount');
    }
  });

  it.each([
    ProductBillingMode.SUBSCRIPTION,
    ProductBillingMode.CODING_PLAN,
  ])('keeps %s overview balance queries product-only', async (billingMode) => {
    const financePrisma = makeFinanceReportPrisma();
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    await service.getFinanceReportOverview('2026-05', billingMode);

    const balanceOverviewQueries = [
      ...financePrisma.balanceTransaction.aggregate.mock.calls,
      ...financePrisma.balanceTransaction.count.mock.calls,
    ];
    expect(balanceOverviewQueries).toHaveLength(7);
    for (const [query] of balanceOverviewQueries) {
      const serializedWhere = JSON.stringify(query.where);
      expect(serializedWhere).toContain(`\"billingMode\":\"${billingMode}\"`);
      expect(serializedWhere).not.toContain('attribution');
    }
  });

  it('keeps attributed unbound PAYG balance activity separate from UNKNOWN', async () => {
    const balanceGroupBy = jest.fn()
      .mockResolvedValueOnce([{
        productId: null,
        type: TransactionType.CONSUME,
        _sum: { amountUsd: new Prisma.Decimal('-1') },
      }])
      .mockResolvedValueOnce([{
        type: TransactionType.CONSUME,
        _sum: { amountUsd: new Prisma.Decimal('-2') },
      }]);
    const { service } = buildService({
      prismaOverrides: {
        product: { findMany: jest.fn().mockResolvedValue([]) },
        order: { findMany: jest.fn().mockResolvedValue([]) },
        tokenUsage: { groupBy: jest.fn().mockResolvedValue([]) },
        balanceTransaction: { groupBy: balanceGroupBy },
        creditTransaction: { groupBy: jest.fn().mockResolvedValue([]) },
      } as any,
    });
    jest.spyOn(service, 'getFinanceReportOverview').mockResolvedValue({
      metrics: {},
    } as never);

    const result = await service.getFinanceDashboard('2026-05');

    expect(result.byProduct).toEqual(expect.arrayContaining([
      expect.objectContaining({
        productId: null,
        productName: '未绑定产品',
        productSlug: null,
        billingMode: 'UNKNOWN',
        balanceConsumeCents: 100,
      }),
      expect.objectContaining({
        productId: null,
        productName: '未绑定产品',
        productSlug: null,
        billingMode: ProductBillingMode.PAY_AS_YOU_GO,
        balanceConsumeCents: 200,
      }),
    ]));
    expect(balanceGroupBy.mock.calls[0][0].where.attribution).toEqual({ is: null });
    expect(balanceGroupBy.mock.calls[1][0].where.attribution).toEqual({
      is: {
        billingMode: ProductBillingMode.PAY_AS_YOU_GO,
        source: BalanceTransactionAttributionSource.ADMIN_BALANCE_ADJUSTMENT,
      },
    });
    expect(result.byBillingMode.map((row: any) => row.billingMode)).toEqual(
      expect.arrayContaining(['UNKNOWN', ProductBillingMode.PAY_AS_YOU_GO]),
    );
  });

  it('uses actual customer charge instead of upstream cost in overview API charge', async () => {
    const financePrisma = makeFinanceReportPrisma([]);
    financePrisma.tokenUsage.aggregate.mockResolvedValue({
      _sum: {
        promptTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        completionTokens: 0,
        totalTokens: 0,
        customerChargeUsd: new Prisma.Decimal(0),
        costUsd: new Prisma.Decimal('8.88'),
      },
      _count: { id: 1 },
    });
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    const result = await service.getFinanceReportOverview('2026-05');

    expect(result.metrics.apiChargeCents).toBe(0);
  });

  it('exports cents fields as major currency units in CSV', () => {
    const { service } = buildService();

    const csv = (service as any).buildFinanceExportCsv('orders', [
      { period: '2026-05', orderId: 'order-1', amountCents: 12345, createdAt: new Date('2026-05-01T00:00:00Z') },
    ]);

    expect(csv).toContain('实收金额（主币种单位）');
    expect(csv).toContain('123.45');
    expect(csv).not.toContain(',12345,');
    expect(csv).toContain('2026-05-01 08:00:00');
  });

  it('exports payment reconciliation amounts as major currency units in CSV', () => {
    const { service } = buildService();

    const csv = (service as any).buildFinanceExportCsv('payments', [
      {
        period: '2026-05',
        channel: 'STRIPE',
        merchantOrderNo: 'order-1',
        paidAmountCents: 12345,
        stripeAmountCents: 12340,
        channelFeeCents: 40,
        settlementNetCents: 12300,
        diffCents: -5,
        currency: 'USD',
      },
    ]);

    const header = csv.replace(/^\uFEFF/u, '').split('\n')[0];

    expect(header).toContain('系统支付金额（主币种单位）');
    expect(header).toContain('Stripe实收金额（主币种单位）');
    expect(header).toContain('差异金额（主币种单位）');
    expect(header.split(',')).not.toContain('工作区类型');
    expect(header.split(',')).not.toContain('币种');
    expect(csv).toContain('123.45');
    expect(csv).toContain('123.4');
    expect(csv).toContain('-0.05');
    expect(csv).not.toContain(',12345,');
    expect(csv).not.toContain(',12340,');
  });

  it('exports finance CSV columns using the same visible fields as report pages', () => {
    const { service } = buildService();

    const csv = (service as any).buildFinanceExportCsv('buyGiftAccountChanges', [
      {
        rechargeBatchNo: 'grant-1',
        userLabel: 'user@example.com',
        currency: 'USD',
        paidRechargeAmountCents: 12300,
        bonusRechargeAmountCents: 2300,
        source: 'VOUCHER',
        orderPaidInPeriod: true,
        orderTradeNo: 'internal-trade-no',
      },
    ]);
    const [header, row] = csv.replace(/^\uFEFF/u, '').split('\n');

    expect(header).toContain('充值批次号,用户,币种,充值金额-实收（主币种单位）,充值金额-买赠（主币种单位）');
    expect(header).toContain('本期收款金额（主币种单位）');
    expect(header).toContain('本期开票金额（主币种单位）');
    expect(header).not.toContain('source');
    expect(header).not.toContain('orderPaidInPeriod');
    expect(header).not.toContain('orderTradeNo');
    expect(row).toContain('grant-1,user@example.com,USD,123,23');
    expect(row).not.toContain('VOUCHER');
    expect(row).not.toContain('internal-trade-no');
  });

  it('fails consumption facts closed when an allocation discount rate disagrees with its components', async () => {
    const grant = makeReconciledFinanceGrant({
      id: 'grant-allocation-rate-mismatch',
      paidAmountUsd: new Prisma.Decimal('0.5'),
      bonusAmountUsd: new Prisma.Decimal('0.5'),
      grantedAmountUsd: new Prisma.Decimal(1),
    });
    const allocation = {
      id: 'allocation-rate-mismatch',
      userId: grant.userId,
      tenantId: grant.tenantId,
      productId: grant.productId,
      billingAccountId: grant.billingAccountId,
      balanceTransactionId: 'transaction-rate-mismatch',
      tokenUsageId: null,
      balanceGrantId: grant.id,
      source: 'BALANCE_GRANT',
      amountUsd: new Prisma.Decimal('0.5'),
      recognizedRevenueUsd: new Prisma.Decimal('0.25'),
      bonusConsumedUsd: new Prisma.Decimal('0.25'),
      discountRate: new Prisma.Decimal(1),
      createdAt: new Date('2026-05-10T00:00:00.000Z'),
      user: {
        id: grant.userId,
        email: 'user@example.com',
        phone: null,
        nickname: null,
      },
      balanceGrant: grant,
      balanceTransaction: {
        id: 'transaction-rate-mismatch',
        orderId: null,
        description: null,
        createdAt: new Date('2026-05-10T00:00:00.000Z'),
      },
      tokenUsage: null,
    };
    const financePrisma = makeFinanceReportPrisma([], {
      balanceConsumptionAllocations: [allocation],
    });
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    await expect(service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'buyGiftConsumptionDetails',
      pageSize: 10,
    })).rejects.toThrow(
      `BALANCE_LEDGER_RECONCILIATION_REQUIRED:${grant.id}:allocation_components`,
    );
  });

  it('checks the allocation discount equation across the complete grant history', async () => {
    const grant = makeReconciledFinanceGrant({
      id: 'grant-history-rate-proof',
      paidAmountUsd: new Prisma.Decimal(1),
      bonusAmountUsd: new Prisma.Decimal(0),
      grantedAmountUsd: new Prisma.Decimal(1),
    });
    const allocation = {
      id: 'allocation-history-rate-proof',
      userId: grant.userId,
      tenantId: grant.tenantId,
      productId: grant.productId,
      billingAccountId: grant.billingAccountId,
      balanceTransactionId: 'transaction-history-rate-proof',
      tokenUsageId: null,
      balanceGrantId: grant.id,
      source: 'BALANCE_GRANT',
      amountUsd: new Prisma.Decimal('0.5'),
      recognizedRevenueUsd: new Prisma.Decimal('0.5'),
      bonusConsumedUsd: new Prisma.Decimal(0),
      discountRate: new Prisma.Decimal(1),
      createdAt: new Date('2026-05-10T00:00:00.000Z'),
      user: {
        id: grant.userId,
        email: 'user@example.com',
        phone: null,
        nickname: null,
      },
      balanceGrant: grant,
      balanceTransaction: {
        id: 'transaction-history-rate-proof',
        orderId: null,
        description: null,
        createdAt: new Date('2026-05-10T00:00:00.000Z'),
      },
      tokenUsage: null,
    };
    const financePrisma = makeFinanceReportPrisma([], {
      balanceConsumptionAllocations: [allocation],
    });
    const fallbackQueryRaw = financePrisma.$queryRaw.getMockImplementation();
    financePrisma.$queryRaw.mockImplementation((query: {
      strings?: readonly string[];
      values?: readonly unknown[];
    }) => {
      const sql = query?.strings?.join('') ?? '';
      if (sql.includes('invalid_fact_count')) {
        return Promise.resolve([{ invalid_fact_count: BigInt(1) }]);
      }
      return fallbackQueryRaw?.(query);
    });
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    await expect(service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'buyGiftConsumptionDetails',
      pageSize: 10,
    })).rejects.toThrow(
      `BALANCE_LEDGER_RECONCILIATION_REQUIRED:${grant.id}:allocation_fact_set`,
    );
    const proofCall = financePrisma.$queryRaw.mock.calls.find(([query]: any[]) => (
      query?.strings?.join('').includes('invalid_fact_count')
    ));
    expect(proofCall?.[0].strings.join('')).toContain(
      'allocation.discount_rate IS DISTINCT FROM CASE',
    );
  });

  it.each([
    'pureGiftConsumptionSummary',
    'buyGiftAccountSummary',
    'buyGiftConsumptionSummary',
    'buyGiftPaymentSummary',
  ])('exports immutable userId in %s for same-label account reconciliation', (tab) => {
    const { service } = buildService();

    const csv = (service as any).buildFinanceExportCsv(tab, [{
      userLabel: '18501268480',
      userId: '01352d9f-864c-49a5-a406-5ba4b7d6516e',
      currency: 'CNY',
      model: 'gpt-test',
    }]);
    const [header, row] = csv.replace(/^\uFEFF/u, '').split('\n');

    expect(header).toContain('用户,用户ID');
    expect(row).toContain('18501268480,01352d9f-864c-49a5-a406-5ba4b7d6516e');
  });

  it('exports realized API usage unit prices for historical pre-customer-policy snapshots', () => {
    const { service } = buildService();

    const rows = (service as any).buildFinanceApiUsageTokenRows([{
      usageId: 'usage-enterprise-legacy',
      regularInputTokens: 190,
      cachedInputTokens: 13_632,
      cacheWriteInputTokens: 0,
      outputTokens: 124,
      inputUnitPrice: 4,
      cacheReadUnitPrice: 0.96,
      cacheWriteUnitPrice: null,
      outputUnitPrice: 17.6,
      userChargeUsd: 0.00801456,
      paymentDeductionUsd: 0.00801456,
      voucherDeductionUsd: 0,
    }]);

    expect(rows).toEqual([
      expect.objectContaining({
        tokenType: 'input',
        tokens: 190,
        unitPriceUsdPerM: 2,
        userChargeUsd: 0.00038,
        roundingAdjustmentUsd: 0,
      }),
      expect.objectContaining({
        tokenType: 'cache read',
        tokens: 13_632,
        unitPriceUsdPerM: 0.48,
        userChargeUsd: 0.00654336,
        roundingAdjustmentUsd: 0,
      }),
      expect.objectContaining({
        tokenType: 'output',
        tokens: 124,
        unitPriceUsdPerM: 8.8,
        userChargeUsd: 0.0010912,
        roundingAdjustmentUsd: 0,
      }),
    ]);
    expect(rows.reduce((sum: number, row: any) => sum + row.userChargeUsd, 0))
      .toBe(0.00801456);
    for (const row of rows) {
      expect(new Prisma.Decimal(row.unitPriceUsdPerM)
        .mul(row.tokens)
        .div(1_000_000)
        .toDecimalPlaces(12)
        .plus(row.roundingAdjustmentUsd)
        .eq(row.userChargeUsd)).toBe(true);
    }
  });

  it('exports 8-decimal realized prices and isolates any exact charge tail', () => {
    const { service } = buildService();

    const [row] = (service as any).buildFinanceApiUsageTokenRows([{
      usageId: 'usage-realized-rounding',
      regularInputTokens: 3_000_000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      inputUnitPrice: 7,
      outputUnitPrice: 20,
      userChargeUsd: 1,
      paymentDeductionUsd: 1,
      voucherDeductionUsd: 0,
    }]);

    expect(row.unitPriceUsdPerM).toBe(0.33333333);
    expect(row.userChargeUsd).toBe(1);
    expect(row.roundingAdjustmentUsd).toBe(0.00000001);
    expect(new Prisma.Decimal(row.unitPriceUsdPerM)
      .mul(row.tokens)
      .div(1_000_000)
      .toDecimalPlaces(12)
      .plus(row.roundingAdjustmentUsd)
      .eq(row.userChargeUsd)).toBe(true);
  });

  it('prorates credit and debt across token rows while preserving their exact totals', () => {
    const { service } = buildService();

    const rows = (service as any).buildFinanceApiUsageTokenRows([{
      usageId: 'usage-enterprise-credit',
      regularInputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 1_000_000,
      inputUnitPrice: 1,
      outputUnitPrice: 1,
      userChargeUsd: 2,
      paymentDeductionUsd: 0.8,
      voucherDeductionUsd: 0.4,
      creditDeductionUsd: 0.4,
      debtDeductionUsd: 0.4,
    }]);

    expect(rows).toEqual([
      expect.objectContaining({
        tokenType: 'input',
        paymentDeductionUsd: 0.4,
        voucherDeductionUsd: 0.2,
        creditDeductionUsd: 0.2,
        debtDeductionUsd: 0.2,
      }),
      expect.objectContaining({
        tokenType: 'output',
        paymentDeductionUsd: 0.4,
        voucherDeductionUsd: 0.2,
        creditDeductionUsd: 0.2,
        debtDeductionUsd: 0.2,
      }),
    ]);
    expect(rows.reduce((sum: Prisma.Decimal, row: any) => (
      sum.plus(row.creditDeductionUsd)
    ), new Prisma.Decimal(0)).eq('0.4')).toBe(true);
    expect(rows.reduce((sum: Prisma.Decimal, row: any) => (
      sum.plus(row.debtDeductionUsd)
    ), new Prisma.Decimal(0)).eq('0.4')).toBe(true);
    expect(rows.reduce((sum: Prisma.Decimal, row: any) => (
      sum
        .plus(row.paymentDeductionUsd)
        .plus(row.voucherDeductionUsd)
        .plus(row.creditDeductionUsd)
        .plus(row.debtDeductionUsd)
    ), new Prisma.Decimal(0)).eq('2')).toBe(true);
  });

  it('does not repeat an entirely credit-funded charge as principal in token rows', () => {
    const { service } = buildService();

    const rows = (service as any).buildFinanceApiUsageTokenRows([{
      usageId: 'usage-credit-only',
      regularInputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 1_000_000,
      inputUnitPrice: 1,
      outputUnitPrice: 1,
      userChargeUsd: 2,
      paymentDeductionUsd: 0,
      voucherDeductionUsd: 0,
      creditDeductionUsd: 2,
    }]);

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toEqual(expect.objectContaining({
        userChargeUsd: 1,
        paymentDeductionUsd: 0,
        voucherDeductionUsd: 0,
        creditDeductionUsd: 1,
      }));
    }
  });

  it('does not repeat an entirely debt-funded charge as principal in token rows', () => {
    const { service } = buildService();

    const rows = (service as any).buildFinanceApiUsageTokenRows([{
      usageId: 'usage-debt-only',
      regularInputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 1_000_000,
      inputUnitPrice: 1,
      outputUnitPrice: 1,
      userChargeUsd: 2,
      paymentDeductionUsd: 0,
      voucherDeductionUsd: 0,
      creditDeductionUsd: 0,
      debtDeductionUsd: 2,
    }]);

    expect(rows).toHaveLength(2);
    for (const row of rows) {
      expect(row).toEqual(expect.objectContaining({
        userChargeUsd: 1,
        paymentDeductionUsd: 0,
        creditDeductionUsd: 0,
        debtDeductionUsd: 1,
      }));
    }
  });

  it('omits protective-zero API usage rows without tokens or financial movement', () => {
    const { service } = buildService();

    const rows = (service as any).buildFinanceApiUsageTokenRows([{
      usageId: 'usage-protective-zero',
      regularInputTokens: 0,
      cachedInputTokens: null,
      cacheWriteInputTokens: null,
      outputTokens: 0,
      totalTokens: 0,
      inputUnitPrice: 1,
      outputUnitPrice: 1,
      userChargeUsd: 0,
      paymentDeductionUsd: 0,
      voucherDeductionUsd: 0,
      supplierCostCents: null,
    }]);

    expect(rows).toEqual([]);
  });

  it('keeps zero-token API usage rows when a non-token financial movement exists', () => {
    const { service } = buildService();

    const rows = (service as any).buildFinanceApiUsageTokenRows([{
      usageId: 'usage-non-token-charge',
      regularInputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      inputUnitPrice: 0,
      outputUnitPrice: 0,
      userChargeUsd: 0.25,
      paymentDeductionUsd: 0.25,
      voucherDeductionUsd: 0,
      supplierCostCents: 10,
    }]);

    expect(rows).toEqual([
      expect.objectContaining({
        rowId: 'usage-non-token-charge-total',
        tokenType: 'total',
        tokens: 0,
        userChargeUsd: 0.25,
        paymentDeductionUsd: 0.25,
      }),
    ]);
  });

  it('keeps sub-cent supplier cost movement without manufacturing a customer charge', () => {
    const { service } = buildService();
    const [mappedRow] = (service as any).mapFinanceApiUsageRows('2026-05', [{
      id: 'usage-supplier-cost-only',
      apiKeyId: 'key-1',
      tenantId: 'tenant-1',
      tenant: { id: 'tenant-1', name: 'Workspace', type: 'personal' },
      apiKey: {
        id: 'key-1',
        prefix: 'sk-test',
        userId: 'user-1',
        user: { id: 'user-1', email: 'user@example.com' },
      },
      product: null,
      model: 'gpt-test',
      promptTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      inputPriceUsdPerM: 0,
      outputPriceUsdPerM: 0,
      costUsd: 0,
      customerChargePolicy: 'included_upstream',
      customerChargeUsd: 0,
      providerCostEstimateUsd: '0.001',
      consumptionAllocations: [],
      createdAt: new Date('2026-05-10T00:00:00Z'),
    }]);

    expect((service as any).buildFinanceApiUsageTokenRows([mappedRow])).toEqual([
      expect.objectContaining({
        usageId: 'usage-supplier-cost-only',
        tokenType: 'total',
        tokens: 0,
        userChargeUsd: 0,
        supplierCostCents: 0,
      }),
    ]);
  });

  it('exports API usage discount, credit and debt in page column order', () => {
    const { service } = buildService();
    const rows = (service as any).buildFinanceApiUsageTokenRows([{
      usageId: 'usage-with-credit',
      regularInputTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      outputTokens: 1_000_000,
      inputUnitPrice: 1,
      outputUnitPrice: 1,
      userChargeUsd: 2,
      paymentDeductionUsd: 0.8,
      voucherDeductionUsd: 0.4,
      creditDeductionUsd: 0.4,
      debtDeductionUsd: 0.4,
      customerMultiplier: 0.85,
      chargeSource: 'payg_balance',
    }]);
    const csv = (service as any).buildFinanceExportCsv('apiUsage', rows);
    const [header, ...dataRows] = csv.replace(/^\uFEFF/u, '').split('\n');
    const columns = header.split(',');

    expect(columns.slice(columns.indexOf('price'), columns.indexOf('charge（主币种单位）') + 1))
      .toEqual(['price', '折扣', 'charge（主币种单位）']);
    expect(columns.slice(columns.indexOf('赠送扣费（主币种单位）'), columns.indexOf('扣费来源') + 1))
      .toEqual(['赠送扣费（主币种单位）', '信用扣费（主币种单位）', '欠费（主币种单位）', '扣费来源']);
    expect(columns.at(-1)).toMatch(/^计价舍入差额/);
    expect(dataRows).toHaveLength(2);
    for (const row of dataRows) {
      const cells = row.split(',');
      expect(cells[columns.indexOf('折扣')]).toBe('0.85');
      expect(cells[columns.indexOf('信用扣费（主币种单位）')]).toBe('0.2');
      expect(cells[columns.indexOf('扣费来源')]).toBe('payg_balance');
      expect(cells[columns.indexOf('欠费（主币种单位）')]).toBe('0.2');
    }
  });

  it('uses the input price as the historical cache bucket fallback', () => {
    const { service } = buildService();

    const rows = (service as any).buildFinanceApiUsageTokenRows([{
      usageId: 'usage-cache-fallback',
      regularInputTokens: 0,
      cachedInputTokens: 60,
      cacheWriteInputTokens: 40,
      outputTokens: 0,
      inputUnitPrice: 4,
      cacheReadUnitPrice: null,
      cacheWriteUnitPrice: null,
      outputUnitPrice: 8,
      userChargeUsd: 0.0004,
      paymentDeductionUsd: 0.0004,
      voucherDeductionUsd: 0,
    }]);

    expect(rows).toEqual([
      expect.objectContaining({
        tokenType: 'cache read',
        unitPriceUsdPerM: 4,
        userChargeUsd: 0.00024,
      }),
      expect.objectContaining({
        tokenType: 'cache write',
        unitPriceUsdPerM: 4,
        userChargeUsd: 0.00016,
      }),
    ]);
  });

  it('loads API usage detail with cursor page size plus one', async () => {
    const makeTokenUsage = (id: string, createdAt: Date) => ({
      id,
      apiKeyId: 'key-1',
      tenantId: 'tenant-1',
      tenant: { id: 'tenant-1', name: '默认工作区', slug: 'default', type: 'personal' },
      apiKey: {
        id: 'key-1',
        prefix: 'sk-test',
        userId: 'user-1',
        user: { id: 'user-1', email: 'user@example.com', phone: null, nickname: null },
      },
      product: null,
      model: 'gpt-test',
      pricingTierKey: 'default',
      promptTokens: 100,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 10,
      completionTokens: 50,
      totalTokens: 180,
      inputPriceUsdPerM: new Prisma.Decimal('1'),
      cachedInputPriceUsdPerM: new Prisma.Decimal('0.1'),
      cacheWritePriceUsdPerM: new Prisma.Decimal('1.5'),
      outputPriceUsdPerM: new Prisma.Decimal('2'),
      costUsd: new Prisma.Decimal('0.001'),
      customerChargePolicy: 'payg_balance',
      customerChargeUsd: new Prisma.Decimal('0.001'),
      providerCostEstimateUsd: null,
      codingPlanEntitlementId: null,
      providerEntitlementId: null,
      gatewayBillingEvent: {
        settlementAnchor: {
          customerPricingSnapshot: { customerMultiplier: '1' },
        },
      },
      createdAt,
      consumptionAllocations: [],
    });
    const financePrisma = makeFinanceReportPrisma([
      makeTokenUsage('usage-2', new Date('2026-05-11T00:00:00Z')),
      makeTokenUsage('usage-1', new Date('2026-05-10T00:00:00Z')),
    ]);
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    const result = await service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'apiUsage',
      pageSize: 1,
    });

    expect(financePrisma.tokenUsage.findMany).toHaveBeenCalledWith(expect.objectContaining({
      take: 2,
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      include: expect.objectContaining({
        gatewayBillingEvent: {
          select: {
            settlementAnchor: {
              select: { customerPricingSnapshot: true },
            },
          },
        },
      }),
    }));
    expect(financePrisma.tokenUsage.findMany.mock.calls[0][0].where.AND).toEqual(
      expect.arrayContaining([(service as any).financeVisibleTokenUsageWhere()]),
    );
    expect(result.rows).toEqual([
      expect.objectContaining({ usageId: 'usage-2', customerMultiplier: 1 }),
    ]);
    expect(result.pagination).toEqual(expect.objectContaining({
      mode: 'cursor',
      pageSize: 1,
      hasMore: true,
    }));
    expect(result.pagination.nextCursor).toEqual(expect.any(String));
  });

  it('uses the same credit-first charge source in API detail and CSV export', async () => {
    const usage = {
      id: 'usage-credit-source',
      apiKeyId: 'key-1',
      tenantId: 'tenant-1',
      tenant: { id: 'tenant-1', name: 'Workspace', type: 'personal' },
      apiKey: {
        id: 'key-1',
        prefix: 'sk-test',
        userId: 'user-1',
        user: { id: 'user-1', email: 'user@example.com', phone: null, nickname: null },
      },
      product: { id: 'prod-payg', name: 'PAYG', slug: 'payg', billingMode: ProductBillingMode.PAY_AS_YOU_GO },
      model: 'gpt-test',
      promptTokens: 100,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      completionTokens: 0,
      totalTokens: 100,
      inputPriceUsdPerM: new Prisma.Decimal('1'),
      outputPriceUsdPerM: new Prisma.Decimal('1'),
      costUsd: new Prisma.Decimal('1'),
      customerChargePolicy: 'payg_balance',
      customerChargeUsd: new Prisma.Decimal('1'),
      customerApprovedReceivableUsd: new Prisma.Decimal('1'),
      customerUnapprovedDebtUsd: new Prisma.Decimal('0'),
      providerCostEstimateUsd: null,
      createdAt: new Date('2026-05-10T00:00:00Z'),
      consumptionAllocations: [{
        balanceGrantId: null,
        source: 'ENTERPRISE_CREDIT',
        amountUsd: new Prisma.Decimal('1'),
        recognizedRevenueUsd: new Prisma.Decimal('1'),
        bonusConsumedUsd: new Prisma.Decimal('0'),
      }],
    };
    const financePrisma = makeFinanceReportPrisma([usage]);
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    const detail = await service.getFinanceReportDetail({ month: '2026-05', tab: 'apiUsage', pageSize: 20 });
    expect(detail.rows).toEqual([
      expect.objectContaining({ usageId: usage.id, chargeSource: 'enterprise_credit_receivable' }),
    ]);
    expect(financePrisma.tokenUsage.findMany.mock.calls[0][0].include.product.select.billingMode).toBe(true);

    const exportRows = await (service as any).collectFinanceExportRows({ month: '2026-05', tab: 'apiUsage' });
    expect(exportRows).toEqual(detail.rows);
    const csv = (service as any).buildFinanceExportCsv('apiUsage', exportRows);
    const [header, dataRow] = csv.replace(/^\uFEFF/u, '').split('\n');
    expect(dataRow.split(',')[header.split(',').indexOf('扣费来源')])
      .toBe('enterprise_credit_receivable');
  });

  it('paginates API token parts as visible rows without loss, duplication, or export re-expansion', async () => {
    const usage = {
      id: 'usage-visible-parts',
      requestId: 'request-visible-parts',
      apiKeyId: 'key-visible-parts',
      tenantId: 'tenant-1',
      tenant: { id: 'tenant-1', name: '默认工作区', slug: 'default', type: 'personal' },
      apiKey: {
        id: 'key-visible-parts',
        prefix: 'sk-visible',
        userId: 'user-1',
        user: { id: 'user-1', email: 'user@example.com', phone: null, nickname: null },
      },
      product: null,
      model: 'gpt-visible',
      pricingTierKey: 'default',
      promptTokens: 100,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 10,
      completionTokens: 50,
      totalTokens: 180,
      inputPriceUsdPerM: new Prisma.Decimal('1'),
      cachedInputPriceUsdPerM: new Prisma.Decimal('0.1'),
      cacheWritePriceUsdPerM: new Prisma.Decimal('1.5'),
      outputPriceUsdPerM: new Prisma.Decimal('2'),
      costUsd: new Prisma.Decimal('0.001'),
      customerChargePolicy: 'payg_balance',
      customerChargeUsd: new Prisma.Decimal('0.001'),
      providerCostEstimateUsd: null,
      codingPlanEntitlementId: null,
      providerEntitlementId: null,
      createdAt: new Date('2026-05-11T00:00:00Z'),
      consumptionAllocations: [],
    };
    const financePrisma = makeFinanceReportPrisma([usage]);
    const { service } = buildService({ prismaOverrides: financePrisma as any });
    const tokenTypes: string[] = [];
    let cursor: string | undefined;

    for (let index = 0; index < 4; index += 1) {
      const page = await service.getFinanceReportDetail({
        month: '2026-05',
        tab: 'apiUsage',
        pageSize: 1,
        cursor,
      });
      expect(page.rows).toHaveLength(1);
      expect(page.rows[0]).toEqual(expect.objectContaining({
        usageId: usage.id,
        requestId: usage.requestId,
      }));
      tokenTypes.push(String((page.rows[0] as Record<string, unknown>).tokenType));
      cursor = page.pagination.nextCursor ?? undefined;
      expect(page.pagination.hasMore).toBe(index < 3);
    }

    expect(tokenTypes).toEqual(['input', 'cache read', 'cache write', 'output']);
    expect(new Set(tokenTypes).size).toBe(4);
    expect(cursor).toBeUndefined();

    const firstPage = await service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'apiUsage',
      pageSize: 1,
    });
    await expect(service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'apiUsage',
      pageSize: 1,
      cursor: firstPage.pagination.nextCursor!,
      filterField: 'model',
      filterValue: 'gpt-visible',
    })).rejects.toThrow('无效的财务报表分页游标');

    const exported = await (service as any).collectFinanceExportRows({
      month: '2026-05',
      tab: 'apiUsage',
    });
    expect(exported).toHaveLength(4);
    expect(exported.map((row: Record<string, unknown>) => row.tokenType)).toEqual(tokenTypes);
  });

  it('matches API-key prefixes exactly and exposes exact request IDs in detail rows', async () => {
    const financePrisma = makeFinanceReportPrisma();
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    await service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'apiUsage',
      filterField: 'apiKey',
      filterValue: 'sk-exact',
    });

    const where = financePrisma.tokenUsage.findMany.mock.calls[0][0].where.AND as unknown[];
    expect(where).toEqual(expect.arrayContaining([
      {
        apiKey: {
          OR: [
            { id: 'sk-exact' },
            { prefix: 'sk-exact' },
          ],
        },
      },
    ]));
  });

  it('paginates gift-consumption token parts as visible rows without loss or duplication', async () => {
    const user = {
      id: 'user-visible-gift',
      email: 'gift@example.com',
      phone: null,
      nickname: null,
    };
    const tenant = {
      id: 'tenant-visible-gift',
      name: 'Gift workspace',
      slug: 'gift-workspace',
      type: 'PERSONAL',
    };
    const product = {
      id: 'product-visible-gift',
      name: 'PAYG',
      slug: 'payg',
      billingMode: ProductBillingMode.PAY_AS_YOU_GO,
    };
    const grant = makeReconciledFinanceGrant({
      id: 'grant-visible-gift',
      userId: user.id,
      tenantId: tenant.id,
      productId: product.id,
      paidAmountUsd: new Prisma.Decimal(0),
      bonusAmountUsd: new Prisma.Decimal(1),
      grantedAmountUsd: new Prisma.Decimal(1),
      remainingAmountUsd: new Prisma.Decimal(0),
      remainingPaidAmountUsd: new Prisma.Decimal(0),
      remainingBonusAmountUsd: new Prisma.Decimal(0),
      user,
      tenant,
      product,
    });
    const createdAt = new Date('2026-05-11T00:00:00Z');
    const allocation = {
      id: 'allocation-visible-gift',
      userId: user.id,
      tenantId: tenant.id,
      productId: product.id,
      billingAccountId: grant.billingAccountId,
      balanceTransactionId: 'transaction-visible-gift',
      tokenUsageId: 'usage-visible-gift',
      balanceGrantId: grant.id,
      source: 'BALANCE_GRANT',
      amountUsd: new Prisma.Decimal(1),
      recognizedRevenueUsd: new Prisma.Decimal(0),
      bonusConsumedUsd: new Prisma.Decimal(1),
      discountRate: new Prisma.Decimal(0),
      createdAt,
      user,
      tenant,
      product,
      balanceGrant: grant,
      balanceTransaction: {
        id: 'transaction-visible-gift',
        orderId: null,
        description: 'gift usage',
        createdAt,
      },
      tokenUsage: {
        id: 'usage-visible-gift',
        model: 'gpt-visible-gift',
        pricingTierKey: 'default',
        promptTokens: 100,
        cachedInputTokens: 20,
        cacheWriteInputTokens: 10,
        completionTokens: 50,
        totalTokens: 180,
        inputPriceUsdPerM: new Prisma.Decimal('1'),
        cachedInputPriceUsdPerM: new Prisma.Decimal('0.1'),
        cacheWritePriceUsdPerM: new Prisma.Decimal('1.5'),
        outputPriceUsdPerM: new Prisma.Decimal('2'),
        costUsd: new Prisma.Decimal(1),
        providerCostEstimateUsd: null,
        providerCostMultiplier: null,
        providerInputCostUsdPerM: null,
        providerCachedInputCostUsdPerM: null,
        providerCacheWriteCostUsdPerM: null,
        providerOutputCostUsdPerM: null,
        createdAt,
      },
    };
    const financePrisma = makeFinanceReportPrisma([], {
      balanceConsumptionAllocations: [allocation],
    });
    const { service } = buildService({ prismaOverrides: financePrisma as any });
    jest.spyOn(service as any, 'assertFinanceConsumptionAllocationFacts')
      .mockReturnValue(undefined);
    jest.spyOn(service as any, 'assertFinanceConsumptionAllocationBudgets')
      .mockResolvedValue(undefined);

    const callTypes: string[] = [];
    const rowIds: string[] = [];
    let cursor: string | undefined;
    for (let index = 0; index < 4; index += 1) {
      const page = await service.getFinanceReportDetail({
        month: '2026-05',
        tab: 'pureGiftConsumptionDetails',
        pageSize: 1,
        cursor,
      });
      expect(page.rows).toHaveLength(1);
      const row = page.rows[0] as Record<string, unknown>;
      callTypes.push(String(row.callType));
      rowIds.push(String(row.rowId));
      cursor = page.pagination.nextCursor ?? undefined;
      expect(page.pagination.hasMore).toBe(index < 3);
    }

    expect(callTypes).toEqual(['input', 'cache read', 'cache write', 'output']);
    expect(new Set(rowIds).size).toBe(4);
    expect(cursor).toBeUndefined();
    const resumedWhere = financePrisma.balanceConsumptionAllocation.findMany.mock.calls[1][0]
      .where.AND as unknown[];
    expect(resumedWhere).toEqual(expect.arrayContaining([
      {
        OR: [
          { createdAt: { lt: createdAt } },
          { createdAt, id: { lte: allocation.id } },
        ],
      },
    ]));
  });

  it('pushes gift and enterprise credit classification into the paginated query', async () => {
    const financePrisma = makeFinanceReportPrisma();
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    await service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'buyGiftAccountChanges',
      pageSize: 10,
    });
    await service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'pureGiftConsumptionDetails',
      pageSize: 10,
    });
    await service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'enterpriseCreditConsumptionDetails',
      pageSize: 10,
    });

    const grantWhere = financePrisma.balanceGrant.findMany.mock.calls[0][0].where.AND as any[];
    expect(grantWhere).toEqual(expect.arrayContaining([
      expect.objectContaining({
        paidAmountUsd: { gt: expect.any(Prisma.Decimal) },
      }),
    ]));

    const allocationWhere = financePrisma.balanceConsumptionAllocation.findMany.mock.calls[0][0].where.AND as any[];
    expect(allocationWhere).toEqual(expect.arrayContaining([
      expect.objectContaining({
        balanceGrant: {
          is: {
            paidAmountUsd: { lte: expect.any(Prisma.Decimal) },
            grantedAmountUsd: { gt: expect.any(Prisma.Decimal) },
          },
        },
      }),
    ]));

    const enterpriseAllocationWhere = financePrisma.balanceConsumptionAllocation.findMany.mock.calls[1][0].where.AND as any[];
    expect(enterpriseAllocationWhere).toEqual(expect.arrayContaining([
      {
        source: 'ENTERPRISE_CREDIT',
        balanceGrantId: null,
      },
    ]));
  });

  it('reads balance-ledger reports in one read-only repeatable-read snapshot and exposes database asOf', async () => {
    const financePrisma = makeFinanceReportPrisma();
    const { service, prisma } = buildService({ prismaOverrides: financePrisma as any });

    const result = await service.getFinanceReportDetail({
      month: '2026-08',
      tab: 'pureGiftConsumptionDetails',
      pageSize: 10,
    });

    expect(prisma.$transaction).toHaveBeenCalledWith(
      expect.any(Function),
      {
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        maxWait: 5_000,
        timeout: 15_000,
      },
    );
    expect(prisma.$executeRawUnsafe).toHaveBeenCalledWith('SET TRANSACTION READ ONLY');
    expect(financePrisma.$queryRaw.mock.calls.some(([query]: any[]) => (
      query?.strings?.join('').includes("set_config('statement_timeout'")
      && query?.values?.includes('14000')
    ))).toBe(true);
    expect(result.period).toEqual({
      month: '2026-08',
      startDate: '2026-07-31T16:00:00.000Z',
      endDate: '2026-08-31T16:00:00.000Z',
      asOf: '2026-08-15T00:00:00.000Z',
      cutoffExclusive: '2026-08-15T00:00:00.000Z',
      timezone: 'Asia/Shanghai',
    });

    const allocationQuery = financePrisma.balanceConsumptionAllocation.findMany.mock.calls[0][0];
    expect(allocationQuery.where.AND).toEqual(expect.arrayContaining([
      expect.objectContaining({
        createdAt: {
          gte: new Date('2026-07-31T16:00:00.000Z'),
          lt: new Date('2026-08-15T00:00:00.000Z'),
        },
      }),
    ]));
    expect(allocationQuery.include.balanceGrant.select).toEqual(expect.objectContaining({
      id: true,
      paidAmountUsd: true,
      bonusAmountUsd: true,
      grantedAmountUsd: true,
      validFrom: true,
      expiresAt: true,
    }));
    expect(allocationQuery.include.balanceGrant.select).not.toEqual(expect.objectContaining({
      remainingAmountUsd: expect.anything(),
      remainingPaidAmountUsd: expect.anything(),
      remainingBonusAmountUsd: expect.anything(),
      refundAllocations: expect.anything(),
      debtSettlements: expect.anything(),
      expiryAudit: expect.anything(),
    }));
    expect(financePrisma.balanceConsumptionAllocation.groupBy).not.toHaveBeenCalled();
  });

  it('imports one read-only repeatable-read snapshot into the temporary-table export transaction', async () => {
    const coordinator = makePrisma();
    const worker = makePrisma();
    coordinator.$queryRaw.mockImplementation((query: any) => {
      const sql = query?.strings?.join('') ?? '';
      if (sql.includes('transaction_timestamp')) {
        return Promise.resolve([{ asOf: new Date('2026-08-15T00:00:00.000Z') }]);
      }
      if (sql.includes('pg_export_snapshot')) {
        return Promise.resolve([{ snapshotId: '00000003-0000001B-1' }]);
      }
      return Promise.resolve([]);
    });
    worker.$queryRaw.mockResolvedValue([]);
    const transaction = jest.fn()
      .mockImplementationOnce((operation: (tx: any) => Promise<unknown>) => operation(coordinator))
      .mockImplementationOnce((operation: (tx: any) => Promise<unknown>) => operation(worker));
    const { service } = buildService({
      prismaOverrides: { $transaction: transaction } as any,
    });

    const result = await (service as any).withFinanceReportExportSnapshot(
      async (snapshot: any) => ({ db: snapshot.db, asOf: snapshot.asOf }),
      60 * 60 * 1_000,
    );

    expect(result).toEqual({
      db: worker,
      asOf: new Date('2026-08-15T00:00:00.000Z'),
    });
    expect(transaction).toHaveBeenCalledTimes(2);
    expect(transaction).toHaveBeenNthCalledWith(1, expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 5_000,
      timeout: 60 * 60 * 1_000,
    });
    expect(transaction).toHaveBeenNthCalledWith(2, expect.any(Function), {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 5_000,
      timeout: 60 * 60 * 1_000,
    });
    expect(coordinator.$executeRawUnsafe).toHaveBeenCalledWith('SET TRANSACTION READ ONLY');
    expect(worker.$executeRawUnsafe).toHaveBeenCalledWith(
      "SET TRANSACTION SNAPSHOT '00000003-0000001B-1'",
    );
  });

  it('keeps every consumption-summary page on the transaction client instead of leaking to the root client', async () => {
    const rootFinancePrisma = makeFinanceReportPrisma();
    const transactionFinancePrisma = makeFinanceReportPrisma();
    (transactionFinancePrisma as any).$executeRawUnsafe = jest.fn().mockResolvedValue(1);
    rootFinancePrisma.balanceConsumptionAllocation.findMany.mockRejectedValue(
      new Error('root finance client leaked into snapshot'),
    );
    const transaction = jest.fn(async (
      operation: (tx: any) => Promise<unknown>,
      _options?: unknown,
    ) => (
      operation(transactionFinancePrisma)
    ));
    const { service, systemConfig } = buildService({
      prismaOverrides: {
        ...rootFinancePrisma,
        $transaction: transaction,
      } as any,
    });

    await expect(service.getFinanceReportDetail({
      month: '2026-08',
      tab: 'buyGiftConsumptionSummary',
      pageSize: 10,
    })).resolves.toEqual(expect.objectContaining({
      rows: [],
      period: expect.objectContaining({
        asOf: '2026-08-15T00:00:00.000Z',
      }),
    }));

    await expect(service.getFinanceReportDetail({
      month: '2026-08',
      tab: 'buyGiftAccountSummary',
      pageSize: 10,
    })).resolves.toEqual(expect.objectContaining({
      rows: [],
    }));

    expect(transactionFinancePrisma.balanceConsumptionAllocation.findMany).toHaveBeenCalledTimes(1);
    expect(transactionFinancePrisma.balanceGrant.findMany).toHaveBeenCalledTimes(1);
    expect(rootFinancePrisma.balanceConsumptionAllocation.findMany).not.toHaveBeenCalled();
    expect(rootFinancePrisma.balanceGrant.findMany).not.toHaveBeenCalled();
    expect(transaction).toHaveBeenCalledTimes(2);
    for (const [, options] of transaction.mock.calls) {
      expect(options).toEqual(expect.objectContaining({
        isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
        timeout: 60_000,
      }));
    }
    expect((transactionFinancePrisma as any).$executeRawUnsafe)
      .toHaveBeenCalledTimes(2);
    expect(systemConfig.getDeploymentConfig)
      .toHaveBeenCalledWith(transactionFinancePrisma);
  });

  it('derives the default accounting month from database asOf instead of the application clock', async () => {
    const financePrisma = makeFinanceReportPrisma();
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    const result = await service.getFinanceReportDetail({
      tab: 'pureGiftConsumptionDetails',
      pageSize: 10,
    });

    expect(result.period).toEqual(expect.objectContaining({
      month: '2026-08',
      startDate: '2026-07-31T16:00:00.000Z',
      endDate: '2026-08-31T16:00:00.000Z',
      asOf: '2026-08-15T00:00:00.000Z',
    }));
  });

  it('returns an empty cursor page for a future accounting month without replaying current grants', async () => {
    const financePrisma = makeFinanceReportPrisma([], {
      balanceGrants: [makeReconciledFinanceGrant()],
    });
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    const result = await service.getFinanceReportDetail({
      month: '2026-09',
      tab: 'buyGiftAccountChanges',
      pageSize: 10,
    });

    expect(result.rows).toEqual([]);
    expect(result.pagination).toEqual({
      mode: 'cursor',
      pageSize: 10,
      hasMore: false,
      nextCursor: null,
      rowsReturned: 0,
    });
    expect(financePrisma.balanceGrant.findMany).not.toHaveBeenCalled();
  });

  it.each([
    {
      scenario: 'an account outside the reconciled V2 marker',
      grantOverrides: {
        billingAccount: {
          id: 'billing-account-1',
          balanceGrantLedgerStatus: 'LEGACY_DIRTY',
          balanceGrantLedgerVersion: 1,
        },
      },
      reason: 'account_marker',
    },
    {
      scenario: 'issuance components that do not equal the granted amount',
      grantOverrides: {
        grantedAmountUsd: new Prisma.Decimal(6),
      },
      reason: 'grant_components',
    },
  ])('fails consumption facts closed for $scenario', async ({ grantOverrides, reason }) => {
    const grant = makeReconciledFinanceGrant(grantOverrides);
    const allocation = {
      id: 'allocation-invalid-proof',
      userId: grant.userId,
      tenantId: grant.tenantId,
      productId: grant.productId,
      billingAccountId: grant.billingAccountId,
      balanceTransactionId: 'transaction-invalid-proof',
      tokenUsageId: null,
      balanceGrantId: grant.id,
      source: 'BALANCE_GRANT',
      amountUsd: new Prisma.Decimal(1),
      recognizedRevenueUsd: new Prisma.Decimal(1),
      bonusConsumedUsd: new Prisma.Decimal(0),
      discountRate: new Prisma.Decimal(1),
      createdAt: new Date('2026-05-10T00:00:00.000Z'),
      user: { id: grant.userId, email: 'user@example.com', phone: null, nickname: null },
      balanceGrant: grant,
      balanceTransaction: {
        id: 'transaction-invalid-proof',
        orderId: null,
        description: null,
        createdAt: new Date('2026-05-10T00:00:00.000Z'),
      },
      tokenUsage: null,
    };
    const financePrisma = makeFinanceReportPrisma([], {
      balanceConsumptionAllocations: [allocation],
    });
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    await expect(service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'buyGiftConsumptionDetails',
      pageSize: 10,
    })).rejects.toThrow(
      `BALANCE_LEDGER_RECONCILIATION_REQUIRED:${grant.id}:${reason}`,
    );
  });

  it.each([
    {
      scenario: 'a paid-only grant whose consumption is mislabeled as bonus',
      components: [
        { amount: '1', paid: '0', bonus: '1' },
      ],
    },
    {
      scenario: 'off-page allocations whose cumulative paid amount exceeds issuance',
      components: [
        { amount: '1', paid: '1', bonus: '0' },
        { amount: '1', paid: '1', bonus: '0' },
      ],
    },
  ])('fails consumption facts closed for $scenario', async ({ components }) => {
    const grant = makeReconciledFinanceGrant({
      id: 'grant-allocation-budget',
      paidAmountUsd: new Prisma.Decimal(1),
      bonusAmountUsd: new Prisma.Decimal(0),
      grantedAmountUsd: new Prisma.Decimal(1),
      remainingAmountUsd: new Prisma.Decimal(0),
      remainingPaidAmountUsd: new Prisma.Decimal(0),
      remainingBonusAmountUsd: new Prisma.Decimal(0),
    });
    const allocations = components.map((component, index) => ({
      id: `allocation-budget-${index + 1}`,
      userId: grant.userId,
      tenantId: grant.tenantId,
      productId: grant.productId,
      billingAccountId: grant.billingAccountId,
      balanceTransactionId: `transaction-budget-${index + 1}`,
      tokenUsageId: null,
      balanceGrantId: grant.id,
      source: 'BALANCE_GRANT',
      amountUsd: new Prisma.Decimal(component.amount),
      recognizedRevenueUsd: new Prisma.Decimal(component.paid),
      bonusConsumedUsd: new Prisma.Decimal(component.bonus),
      discountRate: new Prisma.Decimal(component.paid)
        .div(component.amount)
        .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP),
      createdAt: new Date(`2026-05-${20 - index}T00:00:00.000Z`),
      user: { id: grant.userId, email: 'user@example.com', phone: null, nickname: null },
      balanceGrant: grant,
      balanceTransaction: {
        id: `transaction-budget-${index + 1}`,
        orderId: null,
        description: null,
        createdAt: new Date(`2026-05-${20 - index}T00:00:00.000Z`),
      },
      tokenUsage: null,
    }));
    const financePrisma = makeFinanceReportPrisma([], {
      balanceConsumptionAllocations: allocations,
    });
    financePrisma.balanceConsumptionAllocation.groupBy.mockResolvedValue([{
      balanceGrantId: grant.id,
      _sum: {
        amountUsd: allocations.reduce(
          (total, allocation) => total.plus(allocation.amountUsd),
          new Prisma.Decimal(0),
        ),
        recognizedRevenueUsd: allocations.reduce(
          (total, allocation) => total.plus(allocation.recognizedRevenueUsd),
          new Prisma.Decimal(0),
        ),
        bonusConsumedUsd: allocations.reduce(
          (total, allocation) => total.plus(allocation.bonusConsumedUsd),
          new Prisma.Decimal(0),
        ),
      },
    }]);
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    await expect(service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'buyGiftConsumptionDetails',
      pageSize: 1,
    })).rejects.toThrow(
      `BALANCE_LEDGER_RECONCILIATION_REQUIRED:${grant.id}:immutable_reduction_budget`,
    );
  });

  it('fails consumption facts closed when funding settlement plus allocations exceed issuance', async () => {
    const grant = makeReconciledFinanceGrant({
      id: 'grant-cross-event-budget',
      paidAmountUsd: new Prisma.Decimal(1),
      bonusAmountUsd: new Prisma.Decimal(0),
      grantedAmountUsd: new Prisma.Decimal(1),
      remainingAmountUsd: new Prisma.Decimal(0),
      remainingPaidAmountUsd: new Prisma.Decimal(0),
      remainingBonusAmountUsd: new Prisma.Decimal(0),
      debtSettlements: [{
        id: 'settlement-cross-event-budget',
        trigger: 'FUNDING',
        debtSource: 'NEGATIVE_BALANCE',
        amountUsd: new Prisma.Decimal('0.5'),
        paidUsd: new Prisma.Decimal('0.5'),
        bonusUsd: new Prisma.Decimal(0),
        occurredAt: new Date('2026-05-01T00:00:00.000Z'),
      }],
    });
    const allocation = {
      id: 'allocation-cross-event-budget',
      userId: grant.userId,
      tenantId: grant.tenantId,
      productId: grant.productId,
      billingAccountId: grant.billingAccountId,
      balanceTransactionId: 'transaction-cross-event-budget',
      tokenUsageId: null,
      balanceGrantId: grant.id,
      source: 'BALANCE_GRANT',
      amountUsd: new Prisma.Decimal('0.75'),
      recognizedRevenueUsd: new Prisma.Decimal('0.75'),
      bonusConsumedUsd: new Prisma.Decimal(0),
      discountRate: new Prisma.Decimal(1),
      createdAt: new Date('2026-05-10T00:00:00.000Z'),
      user: {
        id: grant.userId,
        email: 'user@example.com',
        phone: null,
        nickname: null,
      },
      balanceGrant: grant,
      balanceTransaction: {
        id: 'transaction-cross-event-budget',
        orderId: null,
        description: null,
        createdAt: new Date('2026-05-10T00:00:00.000Z'),
      },
      tokenUsage: null,
    };
    const financePrisma = makeFinanceReportPrisma([], {
      balanceConsumptionAllocations: [allocation],
    });
    financePrisma.balanceConsumptionAllocation.groupBy.mockResolvedValue([{
      balanceGrantId: grant.id,
      _sum: {
        amountUsd: allocation.amountUsd,
        recognizedRevenueUsd: allocation.recognizedRevenueUsd,
        bonusConsumedUsd: allocation.bonusConsumedUsd,
      },
    }]);
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    await expect(service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'buyGiftConsumptionDetails',
      pageSize: 10,
    })).rejects.toThrow(
      `BALANCE_LEDGER_RECONCILIATION_REQUIRED:${grant.id}:immutable_reduction_budget`,
    );
  });

  it.each([
    {
      scenario: 'buy-gift paid components',
      tab: 'buyGiftConsumptionDetails',
      paidAmountUsd: '10',
      bonusAmountUsd: '0',
      remainingPaidAmountUsd: '7',
      remainingBonusAmountUsd: '0',
      recognizedRevenueUsd: ['1', '2'],
      bonusConsumedUsd: ['0', '0'],
      expectedConsumeAmountCents: [100, 200],
    },
    {
      scenario: 'pure-gift bonus components',
      tab: 'pureGiftConsumptionDetails',
      paidAmountUsd: '0',
      bonusAmountUsd: '10',
      remainingPaidAmountUsd: '0',
      remainingBonusAmountUsd: '7',
      recognizedRevenueUsd: ['0', '0'],
      bonusConsumedUsd: ['1', '2'],
      expectedConsumeAmountCents: null,
    },
  ])('reads paginated $scenario from immutable allocation facts without current-balance replay', async ({
    tab,
    paidAmountUsd,
    bonusAmountUsd,
    remainingPaidAmountUsd,
    remainingBonusAmountUsd,
    recognizedRevenueUsd,
    bonusConsumedUsd,
    expectedConsumeAmountCents,
  }) => {
    const user = { id: 'user-1', email: 'user@example.com' };
    const tenant = { id: 'tenant-1', name: 'default' };
    const product = {
      id: 'prod-payg',
      name: 'PAYG',
      billingMode: ProductBillingMode.PAY_AS_YOU_GO,
    };
    const grant = makeReconciledFinanceGrant({
      id: 'grant-with-off-page-consumption',
      paidAmountUsd: new Prisma.Decimal(paidAmountUsd),
      bonusAmountUsd: new Prisma.Decimal(bonusAmountUsd),
      grantedAmountUsd: new Prisma.Decimal(10),
      remainingAmountUsd: new Prisma.Decimal(7),
      remainingPaidAmountUsd: new Prisma.Decimal(remainingPaidAmountUsd),
      remainingBonusAmountUsd: new Prisma.Decimal(remainingBonusAmountUsd),
      user,
      tenant,
      product,
    });
    const allocation = (
      id: string,
      balanceTransactionId: string,
      amountUsd: Prisma.Decimal,
      recognizedRevenue: Prisma.Decimal,
      bonusConsumed: Prisma.Decimal,
      createdAt: Date,
    ) => ({
      id,
      userId: grant.userId,
      tenantId: grant.tenantId,
      productId: grant.productId,
      billingAccountId: grant.billingAccountId,
      balanceTransactionId,
      tokenUsageId: null,
      balanceGrantId: grant.id,
      source: 'BALANCE_GRANT',
      amountUsd,
      recognizedRevenueUsd: recognizedRevenue,
      bonusConsumedUsd: bonusConsumed,
      discountRate: amountUsd.gt(0)
        ? recognizedRevenue.div(amountUsd)
          .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP)
        : new Prisma.Decimal(0),
      createdAt,
      user,
      tenant,
      product,
      balanceGrant: grant,
      balanceTransaction: {
        id: balanceTransactionId,
        orderId: null,
        description: 'usage',
        createdAt,
      },
      tokenUsage: null,
    });
    const pageAllocation = allocation(
      'allocation-on-page',
      'transaction-on-page',
      new Prisma.Decimal(1),
      new Prisma.Decimal(recognizedRevenueUsd[0]),
      new Prisma.Decimal(bonusConsumedUsd[0]),
      new Date('2026-05-20T00:00:00Z'),
    );
    const offPageAllocation = allocation(
      'allocation-off-page',
      'transaction-off-page',
      new Prisma.Decimal(2),
      new Prisma.Decimal(recognizedRevenueUsd[1]),
      new Prisma.Decimal(bonusConsumedUsd[1]),
      new Date('2026-05-19T00:00:00Z'),
    );
    const financePrisma = makeFinanceReportPrisma([], {
      balanceConsumptionAllocations: [pageAllocation, offPageAllocation],
    });
    financePrisma.balanceConsumptionAllocation.findMany
      .mockResolvedValueOnce([pageAllocation, offPageAllocation])
      .mockResolvedValueOnce([offPageAllocation]);
    financePrisma.balanceConsumptionAllocation.groupBy.mockImplementation(({ where }: any) => (
      where.createdAt?.gte && where.createdAt?.lt
        ? Promise.resolve([{
          balanceGrantId: grant.id,
          _sum: {
            amountUsd: new Prisma.Decimal(3),
            recognizedRevenueUsd: new Prisma.Decimal(recognizedRevenueUsd[0])
              .plus(recognizedRevenueUsd[1]),
            bonusConsumedUsd: new Prisma.Decimal(bonusConsumedUsd[0])
              .plus(bonusConsumedUsd[1]),
          },
        }])
        : Promise.resolve([])
    ));
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    const firstPage = await service.getFinanceReportDetail({
      month: '2026-05',
      tab,
      pageSize: 1,
    });

    expect(firstPage.rows).toHaveLength(1);
    if (expectedConsumeAmountCents) {
      expect(firstPage.rows).toEqual([
        expect.objectContaining({ consumeAmountCents: expectedConsumeAmountCents[0] }),
      ]);
    }
    expect(firstPage.rows[0]).toEqual(expect.objectContaining({
      callTransactionNo: 'transaction-on-page',
      rechargeBatchNo: grant.id,
    }));
    expect(firstPage.pagination).toEqual(expect.objectContaining({
      mode: 'cursor',
      pageSize: 1,
      hasMore: true,
      nextCursor: expect.any(String),
    }));

    const secondPage = await service.getFinanceReportDetail({
      month: '2026-05',
      tab,
      pageSize: 1,
      cursor: firstPage.pagination.nextCursor!,
    });

    expect(secondPage.rows).toHaveLength(1);
    if (expectedConsumeAmountCents) {
      expect(secondPage.rows).toEqual([
        expect.objectContaining({ consumeAmountCents: expectedConsumeAmountCents[1] }),
      ]);
    }
    expect(secondPage.rows[0]).toEqual(expect.objectContaining({
      callTransactionNo: 'transaction-off-page',
      rechargeBatchNo: grant.id,
    }));
    expect(secondPage.pagination).toEqual(expect.objectContaining({
      mode: 'cursor',
      pageSize: 1,
      hasMore: false,
      nextCursor: null,
    }));
    expect(financePrisma.balanceConsumptionAllocation.groupBy).toHaveBeenCalledTimes(2);
    for (const [query] of financePrisma.balanceConsumptionAllocation.groupBy.mock.calls) {
      expect(query).toEqual(expect.objectContaining({
        where: {
          balanceGrantId: { in: [grant.id] },
        },
      }));
      expect(query.where.createdAt).toBeUndefined();
    }
  });

  it.each([
    { scenario: 'supplier component prices exist', includeSupplierPrices: true },
    { scenario: 'supplier component prices are unavailable', includeSupplierPrices: false },
  ])('keeps the optimized consumption summary equal to detail totals when $scenario', ({
    includeSupplierPrices,
  }) => {
    const { service } = buildService();
    const allocation = {
      id: 'allocation-summary-equivalence',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'product-1',
      billingAccountId: 'billing-account-1',
      balanceTransactionId: 'transaction-summary-equivalence',
      tokenUsageId: 'usage-summary-equivalence',
      balanceGrantId: 'grant-summary-equivalence',
      source: 'BALANCE_GRANT',
      amountUsd: new Prisma.Decimal('0.00090123456789'),
      recognizedRevenueUsd: new Prisma.Decimal('0.00090123456789'),
      bonusConsumedUsd: new Prisma.Decimal(0),
      discountRate: new Prisma.Decimal(1),
      createdAt: new Date('2026-05-20T00:00:00.000Z'),
      user: { id: 'user-1', email: 'user@example.com', phone: null, nickname: null },
      balanceGrant: {
        id: 'grant-summary-equivalence',
        user: { id: 'user-1', email: 'user@example.com', phone: null, nickname: null },
      },
      balanceTransaction: null,
      tokenUsage: {
        id: 'usage-summary-equivalence',
        model: 'gpt-summary-equivalence',
        pricingTierKey: 'default',
        promptTokens: 100,
        cachedInputTokens: 20,
        cacheWriteInputTokens: 10,
        completionTokens: 50,
        totalTokens: 180,
        inputPriceUsdPerM: new Prisma.Decimal(1),
        cachedInputPriceUsdPerM: new Prisma.Decimal('0.1'),
        cacheWritePriceUsdPerM: new Prisma.Decimal('1.5'),
        outputPriceUsdPerM: new Prisma.Decimal(2),
        costUsd: new Prisma.Decimal('0.0018'),
        providerCostEstimateUsd: new Prisma.Decimal('0.0009'),
        providerCostMultiplier: new Prisma.Decimal(1),
        providerInputCostUsdPerM: includeSupplierPrices ? new Prisma.Decimal('0.8') : null,
        providerCachedInputCostUsdPerM: includeSupplierPrices ? new Prisma.Decimal('0.08') : null,
        providerCacheWriteCostUsdPerM: includeSupplierPrices ? new Prisma.Decimal('1.2') : null,
        providerOutputCostUsdPerM: includeSupplierPrices ? new Prisma.Decimal('1.6') : null,
        createdAt: new Date('2026-05-20T00:00:00.000Z'),
      },
    };

    const detailRows = (service as any).buildBuyGiftConsumptionRows(
      '2026-05',
      allocation,
      new Map(),
    ) as Record<string, unknown>[];
    const summaryRow = (service as any).buildFinanceConsumptionSummaryFactRow(
      'buyGiftConsumptionDetails',
      allocation,
    ) as Record<string, unknown>;
    const detailRawTotal = (key: string) => detailRows.reduce(
      (total, row) => total.plus(
        (service as any).getFinanceRawUsd(row, key) ?? new Prisma.Decimal(0),
      ),
      new Prisma.Decimal(0),
    );

    expect(summaryRow.tokenUsage).toBe(
      detailRows.reduce((total, row) => total + Number(row.tokenUsage ?? 0), 0),
    );
    expect((service as any).getFinanceRawUsd(summaryRow, 'consumeAmountCents').eq(
      detailRawTotal('consumeAmountCents'),
    )).toBe(true);
    expect((service as any).getFinanceRawUsd(summaryRow, 'consumeAmountPaidCents').eq(
      detailRawTotal('consumeAmountPaidCents'),
    )).toBe(true);
    if (includeSupplierPrices) {
      expect((service as any).getFinanceRawUsd(
        summaryRow,
        'estimatedSupplierChargeCents',
      ).eq(detailRawTotal('estimatedSupplierChargeCents'))).toBe(true);
    } else {
      expect(summaryRow.estimatedSupplierChargeCents).toBeNull();
      expect((service as any).getFinanceRawUsd(
        summaryRow,
        'estimatedSupplierChargeCents',
      )).toBeNull();
      expect(detailRows.every((row) => row.estimatedSupplierChargeCents === null)).toBe(true);
    }
  });

  it.each([
    ['pureGiftConsumptionSummary', 'pureGiftConsumptionDetails', 'estimatedSupplierChargeCents'],
    ['buyGiftConsumptionSummary', 'buyGiftConsumptionDetails', 'consumeAmountCents'],
  ])('builds static %s by merging raw immutable facts across 500-row cursor pages for online and export', async (
    summaryTab,
    detailTab,
    rawAmountKey,
  ) => {
    const { service } = buildService();
    const detailRow = (
      userId: string,
      userLabel: string,
      model: string,
      rawAmount: string,
    ): Record<string, unknown> => {
      const row: Record<string, unknown> = {
        userId,
        userLabel,
        model,
        tokenUsage: 1,
        actualSupplierChargeCents: null,
        estimatedSupplierChargeCents: rawAmountKey === 'estimatedSupplierChargeCents' ? 1 : null,
        consumeAmountCents: rawAmountKey === 'consumeAmountCents' ? 1 : undefined,
        consumeAmountPaidCents: rawAmountKey === 'consumeAmountCents' ? 1 : undefined,
      };
      const rawAmounts: Record<string, Prisma.Decimal> = {
        [rawAmountKey]: new Prisma.Decimal(rawAmount),
      };
      if (rawAmountKey === 'consumeAmountCents') {
        rawAmounts.consumeAmountPaidCents = new Prisma.Decimal(rawAmount);
      }
      (service as any).withFinanceRawUsd(row, rawAmounts);
      return row;
    };
    const detailPage = (cursor: any) => {
      const rows = cursor === null
        ? [detailRow('user-1', '18501268480', 'gpt-test', '0.005')]
        : [
          detailRow('user-1', 'changed-label@example.com', 'gpt-test', '0.005'),
          detailRow('user-2', '18501268480', 'gpt-test', '0.02'),
        ];
      const pageRows = [{
        id: cursor === null ? 'allocation-page-1' : 'allocation-page-2',
        createdAt: cursor === null
          ? new Date('2026-05-20T00:00:00.000Z')
          : new Date('2026-05-19T00:00:00.000Z'),
      }];
      return {
        sourceRows: pageRows,
        pageRows,
        items: rows,
        hasMore: cursor === null,
      };
    };
    const detailSpy = jest.spyOn(service as any, 'loadFinanceGiftConsumptionPage')
      .mockImplementation(async (params: any): Promise<any> => detailPage(params.cursor));

    const online = await service.getFinanceReportDetail({
      month: '2026-05',
      tab: summaryTab,
      billingMode: ProductBillingMode.PAY_AS_YOU_GO,
      pageSize: 7,
    });
    const exported = await (service as any).collectFinanceExportRows({
      month: '2026-05',
      tab: summaryTab,
      billingMode: ProductBillingMode.PAY_AS_YOU_GO,
    });

    expect(online.pagination).toEqual({
      mode: 'cursor',
      pageSize: 7,
      hasMore: false,
      nextCursor: null,
      rowsReturned: 2,
      totalRows: 2,
    });
    expect(online.rows).toEqual([
      expect.objectContaining({
        userId: 'user-1',
        userLabel: '18501268480',
        model: 'gpt-test',
        tokenUsage: 2,
        [rawAmountKey]: 1,
      }),
      expect.objectContaining({
        userId: 'user-2',
        userLabel: '18501268480',
        model: 'gpt-test',
        tokenUsage: 1,
        [rawAmountKey]: 2,
      }),
    ]);
    expect(exported).toEqual(online.rows);
    expect((service as any).getFinanceRawUsd(online.rows[0], rawAmountKey).toString()).toBe('0.01');
    if (summaryTab === 'buyGiftConsumptionSummary') {
      expect(online.rows).toEqual([
        expect.objectContaining({ consumeAmountPaidCents: 1 }),
        expect.objectContaining({ consumeAmountPaidCents: 2 }),
      ]);
      expect(
        (service as any).getFinanceRawUsd(online.rows[0], 'consumeAmountPaidCents').toString(),
      ).toBe('0.01');
    }
    const detailCalls = detailSpy.mock.calls.map(([params]) => params as any);
    expect(detailCalls).toHaveLength(4);
    expect(detailCalls.map((params) => params.pageSize)).toEqual([500, 500, 500, 500]);
    expect(detailCalls.map((params) => params.projection)).toEqual([
      'summary',
      'summary',
      'summary',
      'summary',
    ]);
    expect(detailCalls.map((params) => params.billingMode)).toEqual([
      ProductBillingMode.PAY_AS_YOU_GO,
      ProductBillingMode.PAY_AS_YOU_GO,
      ProductBillingMode.PAY_AS_YOU_GO,
      ProductBillingMode.PAY_AS_YOU_GO,
    ]);
    expect(detailCalls.map((params) => params.cursor?.id ?? null)).toEqual([
      null,
      'allocation-page-1',
      null,
      'allocation-page-1',
    ]);
  });

  it.each([
    ['buyGiftAccountSummary', 'buyGiftAccountChanges'],
    ['buyGiftPaymentSummary', 'buyGiftPaymentDetails'],
  ])('builds static %s across all fact pages and separates identical labels by userId', async (
    summaryTab,
    detailTab,
  ) => {
    const { service } = buildService();
    const summaryRow = (
      userId: string,
      userLabel: string,
      rawAmount: string,
    ): Record<string, unknown> => {
      const amountCents = new Prisma.Decimal(rawAmount).mul(100).toDecimalPlaces(0).toNumber();
      const row: Record<string, unknown> = {
        userId,
        userLabel,
        currency: 'CNY',
        periodRechargeAmountCents: amountCents,
        periodCollectionAmountCents: amountCents,
        accumulatedCollectionAmountCents: amountCents,
      };
      (service as any).withFinanceRawUsd(row, {
        periodRechargeAmountCents: new Prisma.Decimal(rawAmount),
        periodCollectionAmountCents: new Prisma.Decimal(rawAmount),
        accumulatedCollectionAmountCents: new Prisma.Decimal(rawAmount),
      });
      return row;
    };
    const firstGrantPage = Array.from({ length: 500 }, (_, index) => ({
      id: `grant-page-${index + 1}`,
      createdAt: new Date(Date.parse('2026-07-02T00:00:00.000Z') - index),
    }));
    const secondGrantPage = [{
      id: 'grant-page-501',
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    }];
    const loadFactPageSpy = jest.spyOn(service as any, 'loadFinanceBalanceGrantCursorPage')
      .mockImplementation(async ({ cursor }: any) => {
        const pageRows = cursor === null ? firstGrantPage : secondGrantPage;
        return {
          sourceRows: cursor === null ? [...pageRows, secondGrantPage[0]] : pageRows,
          pageRows,
          hasMore: cursor === null,
        };
      });
    jest.spyOn(service as any, 'buildFinanceTemplatesForGrants')
      .mockImplementation(async (_month: string, _start: Date, _end: Date, grants: any[]) => {
        const rows = grants[0]?.id === 'grant-page-1'
          ? [summaryRow('01352d9f-864c-49a5-a406-5ba4b7d6516e', '18501268480', '100.005')]
          : [
            summaryRow('01352d9f-864c-49a5-a406-5ba4b7d6516e', 'changed-label', '11.995'),
            summaryRow('46121dc9-bae6-41d2-a297-403d58e59b22', '18501268480', '20'),
          ];
        return {
          buyGift: {
            accountChangeSummary: rows,
            paymentSummary: rows,
          },
        };
      });

    const online = await service.getFinanceReportDetail({
      month: '2026-07',
      tab: summaryTab,
      billingMode: ProductBillingMode.PAY_AS_YOU_GO,
      pageSize: 7,
    });
    const exported = await (service as any).collectFinanceExportRows({
      month: '2026-07',
      tab: summaryTab,
      billingMode: ProductBillingMode.PAY_AS_YOU_GO,
    });

    expect(online.pagination).toEqual({
      mode: 'cursor',
      pageSize: 7,
      hasMore: false,
      nextCursor: null,
      rowsReturned: 2,
      totalRows: 2,
    });
    expect(online.rows).toEqual([
      expect.objectContaining({
        userId: '01352d9f-864c-49a5-a406-5ba4b7d6516e',
        userLabel: '18501268480',
        currency: 'CNY',
        accumulatedCollectionAmountCents: 11200,
      }),
      expect.objectContaining({
        userId: '46121dc9-bae6-41d2-a297-403d58e59b22',
        userLabel: '18501268480',
        currency: 'CNY',
        accumulatedCollectionAmountCents: 2000,
      }),
    ]);
    if (summaryTab === 'buyGiftAccountSummary') {
      expect(online.rows[0]).toEqual(expect.objectContaining({ periodRechargeAmountCents: 11200 }));
      expect(online.rows[1]).toEqual(expect.objectContaining({ periodRechargeAmountCents: 2000 }));
    }
    expect(exported).toEqual(online.rows);
    expect(
      (service as any).getFinanceRawUsd(online.rows[0], 'accumulatedCollectionAmountCents').toString(),
    ).toBe('112');
    expect(loadFactPageSpy).toHaveBeenCalledTimes(4);
    expect(loadFactPageSpy.mock.calls.map(([params]) => (params as any).pageSize)).toEqual([
      500,
      500,
      500,
      500,
    ]);
    expect(loadFactPageSpy.mock.calls.map(([params]) => (params as any).tab)).toEqual([
      detailTab,
      detailTab,
      detailTab,
      detailTab,
    ]);
    expect(loadFactPageSpy.mock.calls.map(([params]) => (params as any).cursor?.id ?? null)).toEqual([
      null,
      'grant-page-500',
      null,
      'grant-page-500',
    ]);
  });

  it('keeps an invoiced exhausted grant in invoice-month detail and all later cumulative summaries', async () => {
    const user = {
      id: 'user-invoice-regression',
      email: null,
      phone: '13811567108',
      nickname: null,
    };
    const tenant = {
      id: 'tenant-invoice-regression',
      name: '默认工作区',
      slug: 'invoice-regression',
      type: 'personal',
    };
    const product = {
      id: 'prod-payg',
      name: '按量产品',
      slug: 'payg',
      billingMode: ProductBillingMode.PAY_AS_YOU_GO,
    };
    const makePaidGrant = (params: {
      id: string;
      orderId: string;
      paidAmount: string;
      remainingAmount: string;
      createdAt: Date;
    }) => makeReconciledFinanceGrant({
      id: params.id,
      userId: user.id,
      tenantId: tenant.id,
      ...reconciledFinanceGrantAccount('billing-account-invoice-regression'),
      orderId: params.orderId,
      productId: product.id,
      paidAmountUsd: new Prisma.Decimal(params.paidAmount),
      bonusAmountUsd: new Prisma.Decimal(0),
      grantedAmountUsd: new Prisma.Decimal(params.paidAmount),
      remainingAmountUsd: new Prisma.Decimal(params.remainingAmount),
      remainingPaidAmountUsd: new Prisma.Decimal(params.remainingAmount),
      remainingBonusAmountUsd: new Prisma.Decimal(0),
      validFrom: params.createdAt,
      createdAt: params.createdAt,
      expiresAt: new Date('2027-06-30T00:00:00.000Z'),
      user,
      tenant,
      product,
      order: {
        id: params.orderId,
        amountCents: new Prisma.Decimal(params.paidAmount).mul(100).toNumber(),
        bonusCents: 0,
        currency: 'cny',
        status: OrderStatus.COMPLETED,
        channel: 'WECHAT',
        tradeNo: `trade-${params.orderId}`,
        paidAt: params.createdAt,
        completedAt: params.createdAt,
        refundedAt: null,
        refundAmountCents: null,
      },
    });
    const activeGrant = makePaidGrant({
      id: 'grant-active',
      orderId: 'order-active',
      paidAmount: '45',
      remainingAmount: '27.38930397',
      createdAt: new Date('2026-06-10T00:00:00.000Z'),
    });
    const exhaustedGrant = makePaidGrant({
      id: 'grant-exhausted',
      orderId: 'order-exhausted',
      paidAmount: '5',
      remainingAmount: '0',
      createdAt: new Date('2026-06-12T00:00:00.000Z'),
    });
    const ledgerAllocations = [
      {
        balanceGrantId: activeGrant.id,
        createdAt: new Date('2026-06-15T00:00:00.000Z'),
        amountUsd: new Prisma.Decimal('16.91467433'),
        recognizedRevenueUsd: new Prisma.Decimal('16.91467433'),
        bonusConsumedUsd: new Prisma.Decimal(0),
      },
      {
        balanceGrantId: activeGrant.id,
        createdAt: new Date('2026-07-10T00:00:00.000Z'),
        amountUsd: new Prisma.Decimal('0.69602170'),
        recognizedRevenueUsd: new Prisma.Decimal('0.69602170'),
        bonusConsumedUsd: new Prisma.Decimal(0),
      },
      {
        balanceGrantId: exhaustedGrant.id,
        createdAt: new Date('2026-06-20T00:00:00.000Z'),
        amountUsd: new Prisma.Decimal(5),
        recognizedRevenueUsd: new Prisma.Decimal(5),
        bonusConsumedUsd: new Prisma.Decimal(0),
      },
    ];
    const issuedApplication = {
      issuedAt: new Date('2026-07-18T10:27:18.000Z'),
      issueDate: null,
      createdAt: new Date('2026-07-18T10:27:18.000Z'),
    };
    const financePrisma = makeFinanceReportPrisma([], {
      balanceGrants: [activeGrant, exhaustedGrant],
      invoiceApplicationItems: [
        {
          orderId: activeGrant.orderId,
          principalCents: 1252,
          application: issuedApplication,
        },
        {
          orderId: exhaustedGrant.orderId,
          principalCents: 354,
          application: issuedApplication,
        },
      ],
    });
    financePrisma.balanceConsumptionAllocation.groupBy.mockImplementation(({ where }: any) => {
      const grantIds = new Set<string>(where.balanceGrantId?.in ?? []);
      const createdAt = where.createdAt ?? {};
      const matching = ledgerAllocations.filter((allocation) => (
        grantIds.has(allocation.balanceGrantId)
        && (!createdAt.gte || allocation.createdAt.getTime() >= createdAt.gte.getTime())
        && (!createdAt.lt || allocation.createdAt.getTime() < createdAt.lt.getTime())
      ));
      const grouped = new Map<string, {
        amountUsd: Prisma.Decimal;
        recognizedRevenueUsd: Prisma.Decimal;
        bonusConsumedUsd: Prisma.Decimal;
      }>();
      for (const allocation of matching) {
        const sum = grouped.get(allocation.balanceGrantId) ?? {
          amountUsd: new Prisma.Decimal(0),
          recognizedRevenueUsd: new Prisma.Decimal(0),
          bonusConsumedUsd: new Prisma.Decimal(0),
        };
        sum.amountUsd = sum.amountUsd.plus(allocation.amountUsd);
        sum.recognizedRevenueUsd = sum.recognizedRevenueUsd.plus(allocation.recognizedRevenueUsd);
        sum.bonusConsumedUsd = sum.bonusConsumedUsd.plus(allocation.bonusConsumedUsd);
        grouped.set(allocation.balanceGrantId, sum);
      }
      return Promise.resolve(Array.from(grouped.entries()).map(([balanceGrantId, sum]) => ({
        balanceGrantId,
        _sum: sum,
      })));
    });
    const { service } = buildService({
      prismaOverrides: financePrisma as any,
      systemConfigOverrides: {
        getDeploymentConfig: jest.fn().mockResolvedValue({ currency: 'cny', region: 'domestic' }),
      },
    });

    const julyDetail = await service.getFinanceReportDetail({
      month: '2026-07',
      tab: 'buyGiftAccountChanges',
      billingMode: ProductBillingMode.PAY_AS_YOU_GO,
      pageSize: 500,
    });
    const julyExhaustedRow = (julyDetail.rows as Record<string, unknown>[])
      .find((row) => row.rechargeBatchNo === exhaustedGrant.id);

    expect(julyDetail.rows).toHaveLength(2);
    expect(julyExhaustedRow).toEqual(expect.objectContaining({
      rechargeBatchNo: exhaustedGrant.id,
      openingAvailableBalanceCents: 0,
      periodRechargeAmountCents: 0,
      periodRefundWriteOffAmountCents: 0,
      periodExpireWriteOffAmountCents: 0,
      closingAvailableBalanceCents: 0,
      cumulativeConsumeOrExpireAmountCents: 500,
      accumulatedCollectionAmountCents: 500,
      periodInvoiceAmountCents: 354,
      accumulatedInvoiceAmountCents: 354,
    }));
    for (const movementKey of [
      'periodRechargeAmountCents',
      'periodRefundWriteOffAmountCents',
      'periodConsumeAmountCents',
      'periodExpireWriteOffAmountCents',
      'periodOtherChangeAmountCents',
      'closingAvailableBalanceCents',
    ]) {
      expect(Math.abs(Number(julyExhaustedRow?.[movementKey] ?? 0))).toBe(0);
    }

    const julySummary = await service.getFinanceReportDetail({
      month: '2026-07',
      tab: 'buyGiftAccountSummary',
      billingMode: ProductBillingMode.PAY_AS_YOU_GO,
      pageSize: 7,
    });
    const julySummaryRow = julySummary.rows[0] as Record<string, unknown>;

    expect(julySummary.rows).toEqual([
      expect.objectContaining({
        userId: user.id,
        currency: 'CNY',
        periodCollectionAmountCents: 0,
        accumulatedCollectionAmountCents: 5000,
        cumulativeConsumeOrExpireAmountCents: 2261,
        periodInvoiceAmountCents: 1606,
        accumulatedInvoiceAmountCents: 1606,
      }),
    ]);
    expect(
      (service as any)
        .getFinanceRawUsd(julySummaryRow, 'cumulativeConsumeOrExpireAmountCents')
        .toString(),
    ).toBe('22.61069603');

    const julyPaymentSummary = await service.getFinanceReportDetail({
      month: '2026-07',
      tab: 'buyGiftPaymentSummary',
      billingMode: ProductBillingMode.PAY_AS_YOU_GO,
    });
    expect(julyPaymentSummary.rows).toEqual([
      expect.objectContaining({
        userId: user.id,
        currency: 'CNY',
        periodCollectionAmountCents: 0,
        accumulatedCollectionAmountCents: 5000,
      }),
    ]);

    const julyDetailExport = await (service as any).collectFinanceExportRows({
      month: '2026-07',
      tab: 'buyGiftAccountChanges',
      billingMode: ProductBillingMode.PAY_AS_YOU_GO,
    });
    const julySummaryExport = await (service as any).collectFinanceExportRows({
      month: '2026-07',
      tab: 'buyGiftAccountSummary',
      billingMode: ProductBillingMode.PAY_AS_YOU_GO,
    });

    expect(julyDetailExport.map((row: Record<string, unknown>) => row.rechargeBatchNo)).toEqual(
      expect.arrayContaining([activeGrant.id, exhaustedGrant.id]),
    );
    expect(julySummaryExport).toEqual(julySummary.rows);
    const csv = (service as any).buildFinanceExportCsv(
      'buyGiftAccountSummary',
      julySummaryExport,
    );
    const [csvHeader, csvData] = csv.replace(/^\uFEFF/u, '').split('\n');
    const headerCells = csvHeader.split(',');
    const dataCells = csvData.split(',');
    const csvValue = (header: string) => dataCells[headerCells.indexOf(header)];
    expect(csvValue('本期开票金额（主币种单位）')).toBe('16.06');
    expect(csvValue('累计开票金额（主币种单位）')).toBe('16.06');
    expect(csvValue('累计收款金额（主币种单位）')).toBe('50');
    expect(csvValue('累计消耗或到期核销金额（主币种单位）')).toBe('22.61069603');

    const augustDetail = await service.getFinanceReportDetail({
      month: '2026-08',
      tab: 'buyGiftAccountChanges',
      billingMode: ProductBillingMode.PAY_AS_YOU_GO,
    });
    expect((augustDetail.rows as Record<string, unknown>[])
      .map((row) => row.rechargeBatchNo)).toEqual([activeGrant.id]);

    const augustSummary = await service.getFinanceReportDetail({
      month: '2026-08',
      tab: 'buyGiftAccountSummary',
      billingMode: ProductBillingMode.PAY_AS_YOU_GO,
    });
    expect(augustSummary.rows).toEqual([
      expect.objectContaining({
        userId: user.id,
        currency: 'CNY',
        accumulatedCollectionAmountCents: 5000,
        cumulativeConsumeOrExpireAmountCents: 2261,
        periodInvoiceAmountCents: 0,
        accumulatedInvoiceAmountCents: 1606,
      }),
    ]);
    const augustSummaryExport = await (service as any).collectFinanceExportRows({
      month: '2026-08',
      tab: 'buyGiftAccountSummary',
      billingMode: ProductBillingMode.PAY_AS_YOU_GO,
    });
    expect(augustSummaryExport).toEqual(augustSummary.rows);
    expect(financePrisma.invoiceApplicationItem.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          orderId: { in: expect.arrayContaining([activeGrant.orderId, exhaustedGrant.orderId]) },
          application: { status: 'ISSUED' },
        },
      }),
    );
  });

  it('keeps consumption facts queryable during current-balance drift while account reports still fail closed', async () => {
    const grant = makeReconciledFinanceGrant({
      id: 'grant-with-real-component-drift',
      paidAmountUsd: new Prisma.Decimal(10),
      grantedAmountUsd: new Prisma.Decimal(10),
      remainingAmountUsd: new Prisma.Decimal(6),
      remainingPaidAmountUsd: new Prisma.Decimal(6),
    });
    const pageAllocation = {
      id: 'allocation-on-drift-page',
      userId: grant.userId,
      tenantId: grant.tenantId,
      productId: grant.productId,
      billingAccountId: grant.billingAccountId,
      balanceTransactionId: 'transaction-on-drift-page',
      tokenUsageId: null,
      balanceGrantId: grant.id,
      source: 'BALANCE_GRANT',
      amountUsd: new Prisma.Decimal(1),
      recognizedRevenueUsd: new Prisma.Decimal(1),
      bonusConsumedUsd: new Prisma.Decimal(0),
      discountRate: new Prisma.Decimal(1),
      createdAt: new Date('2026-05-20T00:00:00Z'),
      balanceGrant: grant,
      balanceTransaction: null,
      tokenUsage: null,
    };
    const financePrisma = makeFinanceReportPrisma([], {
      balanceGrants: [grant],
      balanceConsumptionAllocations: [pageAllocation],
    });
    financePrisma.balanceConsumptionAllocation.groupBy.mockImplementation(({ where }: any) => (
      where.createdAt?.gte && where.createdAt?.lt
        ? Promise.resolve([{
          balanceGrantId: grant.id,
          _sum: {
            amountUsd: new Prisma.Decimal(3),
            recognizedRevenueUsd: new Prisma.Decimal(3),
            bonusConsumedUsd: new Prisma.Decimal(0),
          },
        }])
        : Promise.resolve([])
    ));
    const { service } = buildService({ prismaOverrides: financePrisma as any });
    const standardPriceSpy = jest.spyOn(service as any, 'loadFinanceStandardPriceMap');
    const detailProjectionSpy = jest.spyOn(service as any, 'buildBuyGiftConsumptionRows');

    const consumption = await service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'buyGiftConsumptionSummary',
      pageSize: 1,
    });
    expect(consumption.rows).toEqual([
      expect.objectContaining({
        userId: grant.userId,
        consumeAmountCents: 100,
        consumeAmountPaidCents: 100,
      }),
    ]);
    expect(financePrisma.balanceConsumptionAllocation.groupBy).toHaveBeenCalledTimes(1);
    expect(financePrisma.balanceConsumptionAllocation.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          balanceGrantId: { in: [grant.id] },
        },
      }),
    );
    expect(standardPriceSpy).not.toHaveBeenCalled();
    expect(detailProjectionSpy).not.toHaveBeenCalled();

    await expect(service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'buyGiftAccountChanges',
      pageSize: 1,
    })).rejects.toThrow(
      `BALANCE_LEDGER_RECONCILIATION_REQUIRED:${grant.id}:current_components_postcondition`,
    );
  });

  it('enforces the shared finance export row limit at the exact boundary', () => {
    const { service } = buildService();

    expect(() => (service as any).assertFinanceExportRowLimit(1_000_000)).not.toThrow();
    expect(() => (service as any).assertFinanceExportRowLimit(1_000_001)).toThrow(
      '财务报表明细超过 1000000 行，请缩小账期或筛选范围',
    );
  });

  it('applies the shared row limit before writing a streamed export page', async () => {
    const { service } = buildService();
    const exportDirectory = await mkdtemp(join(tmpdir(), 'finance-export-limit-'));
    const filePath = join(exportDirectory, 'limited.csv');
    const limitSpy = jest.spyOn(service as any, 'assertFinanceExportRowLimit')
      .mockImplementation((rowCount: number) => {
        if (rowCount > 0) throw new BadRequestException('stream row limit reached');
      });
    const detailSpy = jest.spyOn(service, 'getFinanceReportDetail').mockResolvedValue({
      rows: [{ orderId: 'order-1' }],
      pagination: { hasMore: false, nextCursor: null },
    } as any);

    try {
      await expect((service as any).writeFinanceExportCsvFile({
        id: 'job-limit',
        month: '2026-05',
        tab: 'orders',
        asOf: new Date('2026-06-01T00:00:00.000Z'),
        path: filePath,
        totalRows: null,
      })).rejects.toThrow('stream row limit reached');
      expect(limitSpy).toHaveBeenCalledWith(1);
      expect(detailSpy).toHaveBeenCalledWith(expect.objectContaining({
        pageSize: 2_000,
      }), 2_000);
    } finally {
      await rm(exportDirectory, { recursive: true, force: true });
    }
  });

  it('streams balance-ledger export pages without holding one interactive transaction', async () => {
    const { service, prisma } = buildService();
    const exportDirectory = await mkdtemp(join(tmpdir(), 'finance-export-ledger-pages-'));
    const filePath = join(exportDirectory, 'balance-grants.csv');
    const asOf = new Date('2026-06-01T00:00:00.000Z');
    const transactionSnapshotSpy = jest.spyOn(service as any, 'withFinanceReportReadSnapshot');
    const detailSpy = jest.spyOn(service as any, 'getBalanceLedgerFinanceReportDetail')
      .mockResolvedValueOnce({
        rows: [{ grantId: 'grant-2' }],
        pagination: { hasMore: true, nextCursor: 'cursor-2' },
      })
      .mockResolvedValueOnce({
        rows: [{ grantId: 'grant-1' }],
        pagination: { hasMore: false, nextCursor: null },
      });

    try {
      const result = await (service as any).writeFinanceExportCsvFile({
        id: 'job-ledger-pages',
        month: '2026-05',
        tab: 'balanceGrants',
        asOf,
        path: filePath,
        totalRows: null,
      });

      expect(result.rowCount).toBe(2);
      expect(transactionSnapshotSpy).not.toHaveBeenCalled();
      expect(detailSpy).toHaveBeenCalledTimes(2);
      for (const call of detailSpy.mock.calls) {
        expect(call[0]).toEqual(expect.objectContaining({ pageSize: 2_000 }));
        const context = call[2] as { db: unknown; asOf: Date };
        expect(context.db).toBe(prisma);
        expect(context.asOf).toEqual(asOf);
      }
    } finally {
      await rm(exportDirectory, { recursive: true, force: true });
    }
  });

  it('exports revenue-recognition notes without loading any orders', async () => {
    const { service, prisma } = buildService();
    const batches: Record<string, unknown>[][] = [];

    await (service as any).writeTokenPlanRevenueExportRows({
      id: 'job-notes',
      month: '2026-05',
      tab: 'tokenPlanRevenueNotes',
      billingMode: ProductBillingMode.CODING_PLAN,
      asOf: new Date('2026-06-01T00:00:00.000Z'),
      path: join(tmpdir(), 'finance-revenue-notes.csv'),
      totalRows: null,
    }, async (rows: Record<string, unknown>[]) => {
      batches.push(rows);
    });

    expect(batches.flat()).toHaveLength(3);
    expect(prisma.order.findMany).not.toHaveBeenCalled();
  });

  it('keeps revenue summary values and ordering while aggregating paged facts on disk', async () => {
    const { service } = buildService();
    const lines = [
      makeTokenPlanRevenueLine({
        orderId: 'order-2',
        orderItemId: 'item-2',
        productId: 'product-2',
        productName: 'Beta',
        planId: 'plan-2',
        planName: 'Monthly',
        serviceStartAt: new Date('2026-05-03T00:00:00.000Z'),
        orderAmountCents: 2000,
        newDeferredCents: 2000,
        serviceRecognizedRevenueCents: 1200,
        recognizedRevenueCents: 1200,
        closingDeferredCents: 800,
        recognizedToDateCents: 1200,
      }),
      makeTokenPlanRevenueLine({
        orderId: 'order-1',
        orderItemId: 'item-1-b',
        serviceStartAt: new Date('2026-05-02T00:00:00.000Z'),
        orderAmountCents: 500,
        newDeferredCents: 500,
        serviceRecognizedRevenueCents: 400,
        recognizedRevenueCents: 400,
        closingDeferredCents: 100,
        recognizedToDateCents: 400,
      }),
      makeTokenPlanRevenueLine({
        orderId: 'order-1',
        orderItemId: 'item-1-a',
        serviceStartAt: new Date('2026-05-01T00:00:00.000Z'),
      }),
    ];
    jest.spyOn(service as any, 'scanFinanceTokenPlanRevenueLines')
      .mockImplementation(async (_params: unknown, consume: (rows: any[]) => Promise<void>) => {
        await consume([lines[0], lines[1]]);
        await consume([lines[2]]);
      });
    const expected = (service as any).summarizeTokenPlanRevenue(
      [...lines].sort((left, right) => (
        (service as any).compareFinanceTokenPlanRevenueLines(left, right)
      )),
    );
    const actual: Record<string, unknown>[] = [];

    await (service as any).processTokenPlanRevenueSummary({
      monthKey: '2026-05',
      start: new Date('2026-04-30T16:00:00.000Z'),
      end: new Date('2026-05-31T16:00:00.000Z'),
      billingMode: ProductBillingMode.CODING_PLAN,
      workDirectoryPrefix: join(tmpdir(), 'finance-revenue-summary-test-'),
    }, async (rows: Record<string, unknown>[]) => {
      actual.push(...rows);
    });

    expect(actual).toEqual(expected);
    expect(actual).toEqual([
      expect.objectContaining({ productName: 'Beta', orderCount: 1, lineCount: 1 }),
      expect.objectContaining({ productName: 'CodingPlan', orderCount: 1, lineCount: 2 }),
    ]);
  });

  it('globally sorts revenue details that arrive from different source pages', async () => {
    const { service } = buildService();
    const batches: Record<string, unknown>[][] = [];
    jest.spyOn(service as any, 'scanFinanceTokenPlanRevenueLines')
      .mockImplementation(async (_params: unknown, consume: (rows: any[]) => Promise<void>) => {
        await consume([makeTokenPlanRevenueLine({
          orderId: 'order-late',
          serviceStartAt: new Date('2026-05-20T00:00:00.000Z'),
        })]);
        await consume([makeTokenPlanRevenueLine({
          orderId: 'order-early',
          serviceStartAt: new Date('2026-05-01T00:00:00.000Z'),
        })]);
      });

    await (service as any).writeTokenPlanRevenueExportRows({
      id: 'job-details',
      month: '2026-05',
      tab: 'tokenPlanRevenueDetails',
      billingMode: ProductBillingMode.CODING_PLAN,
      asOf: new Date('2026-06-01T00:00:00.000Z'),
      path: join(tmpdir(), 'finance-revenue-details.csv'),
      totalRows: null,
    }, async (rows: Record<string, unknown>[]) => {
      batches.push(rows);
    });

    expect(batches.flat().map((row) => row.orderId)).toEqual([
      'order-early',
      'order-late',
    ]);
  });

  it('merges paged gift-consumption summaries without losing raw USD precision', async () => {
    const { service } = buildService();
    const asOf = new Date('2026-06-01T00:00:00.000Z');
    const transactionSnapshotSpy = jest.spyOn(service as any, 'withFinanceReportReadSnapshot');
    const cursor = (service as any).encodeFinanceReportRowCursor({
      id: 'allocation-2',
      createdAt: new Date('2026-05-20T00:00:00.000Z'),
    }, 'internal-consumption-summary-export');
    const first = (service as any).withFinanceRawUsd({
      userId: 'user-1',
      userLabel: '13000000000',
      model: 'glm-5',
      tokenUsage: 2,
      actualSupplierChargeCents: 1,
      estimatedSupplierChargeCents: 1,
    }, {
      actualSupplierChargeCents: new Prisma.Decimal('0.005'),
      estimatedSupplierChargeCents: new Prisma.Decimal('0.006'),
    });
    const second = (service as any).withFinanceRawUsd({
      userId: 'user-1',
      userLabel: '13000000000',
      model: 'glm-5',
      tokenUsage: 3,
      actualSupplierChargeCents: 1,
      estimatedSupplierChargeCents: 1,
    }, {
      actualSupplierChargeCents: new Prisma.Decimal('0.006'),
      estimatedSupplierChargeCents: new Prisma.Decimal('0.007'),
    });
    const detailSpy = jest.spyOn(service as any, 'loadFinanceGiftConsumptionPage')
      .mockResolvedValueOnce({
        items: [first],
        pageRows: [{ id: 'allocation-2', createdAt: new Date('2026-05-20T00:00:00.000Z') }],
        hasMore: true,
        nextCursor: cursor,
      })
      .mockResolvedValueOnce({
        items: [second],
        pageRows: [{ id: 'allocation-1', createdAt: new Date('2026-05-10T00:00:00.000Z') }],
        hasMore: false,
        nextCursor: null,
      });
    const rows: Record<string, unknown>[] = [];
    const limitSpy = jest.spyOn(service as any, 'assertFinanceExportRowLimit');

    await (service as any).writeGroupedFinanceExportRows({
      id: 'job-consumption-summary',
      month: '2026-05',
      tab: 'pureGiftConsumptionSummary',
      asOf,
      path: join(tmpdir(), 'finance-consumption-summary.csv'),
      totalRows: null,
    }, async (batch: Record<string, unknown>[]) => {
      rows.push(...batch);
      (service as any).assertFinanceExportRowLimit(rows.length);
    });

    expect(rows).toEqual([
      expect.objectContaining({
        userId: 'user-1',
        model: 'glm-5',
        tokenUsage: 5,
      }),
    ]);
    expect((service as any).getFinanceRawUsd(rows[0], 'actualSupplierChargeCents').toString())
      .toBe('0.011');
    expect((service as any).getFinanceRawUsd(rows[0], 'estimatedSupplierChargeCents').toString())
      .toBe('0.013');
    expect(transactionSnapshotSpy).not.toHaveBeenCalled();
    expect(limitSpy).toHaveBeenCalledTimes(1);
    expect(limitSpy).toHaveBeenCalledWith(1);
    expect(limitSpy).not.toHaveBeenCalledWith(2);
    expect(detailSpy).toHaveBeenCalledWith(expect.objectContaining({
      pageSize: 5_000,
    }), expect.anything(), expect.any(Set));
  });

  it('uses larger source pages for grouped account exports', async () => {
    const { service, prisma } = buildService();
    const loadPageSpy = jest.spyOn(service as any, 'loadFinanceBalanceGrantCursorPage')
      .mockResolvedValue({ sourceRows: [], pageRows: [], hasMore: false });
    jest.spyOn(service as any, 'getPlatformCurrencyCode').mockResolvedValue('CNY');
    jest.spyOn(service as any, 'buildFinanceTemplatesForGrants').mockResolvedValue({
      buyGift: { accountChangeSummary: [], paymentSummary: [] },
    });

    await (service as any).writeGroupedFinanceExportRows({
      id: 'job-account-summary-page-size',
      month: '2026-05',
      tab: 'buyGiftAccountSummary',
      asOf: new Date('2026-06-01T00:00:00.000Z'),
      path: join(tmpdir(), 'finance-account-summary-page-size.csv'),
      totalRows: null,
    }, jest.fn());

    expect(loadPageSpy).toHaveBeenCalledWith(expect.objectContaining({
      pageSize: 5_000,
    }), prisma);
  });

  it('builds payment summaries from payment facts without replaying the balance ledger', async () => {
    const { service, prisma } = buildService();
    const grant = makeReconciledFinanceGrant({
      user: { id: 'user-1', phone: '13000000000', email: 'user@example.com' },
      orderId: 'order-1',
      paidAmountUsd: new Prisma.Decimal('5'),
      grantedAmountUsd: new Prisma.Decimal('5'),
      order: {
        id: 'order-1',
        amountCents: 500,
        bonusCents: 0,
        currency: 'CNY',
        status: OrderStatus.REFUNDED,
        channel: 'ALIPAY',
        tradeNo: 'trade-1',
        paidAt: new Date('2026-05-01T00:00:00.000Z'),
        completedAt: new Date('2026-05-01T00:00:00.000Z'),
        refundedAt: new Date('2026-05-10T00:00:00.000Z'),
        refundAmountCents: 100,
      },
      targetRefunds: [{
        component: 'PAID',
        requestedAmountUsd: new Prisma.Decimal('1'),
        occurredAt: new Date('2026-05-10T00:00:00.000Z'),
      }],
    });
    const loadPageSpy = jest.spyOn(service as any, 'loadFinanceBuyGiftPaymentGrantCursorPage')
      .mockResolvedValue({ sourceRows: [grant], pageRows: [grant], hasMore: false });
    jest.spyOn(service as any, 'getPlatformCurrencyCode').mockResolvedValue('CNY');
    jest.spyOn(service as any, 'getFinanceReportRegion').mockResolvedValue('domestic');
    const templatesSpy = jest.spyOn(service as any, 'buildFinanceTemplatesForGrants');
    const rows: Record<string, unknown>[] = [];

    await (service as any).writeGroupedFinanceExportRows({
      id: 'job-payment-summary-fast-path',
      month: '2026-05',
      tab: 'buyGiftPaymentSummary',
      asOf: new Date('2026-06-01T00:00:00.000Z'),
      path: join(tmpdir(), 'finance-payment-summary-fast-path.csv'),
      totalRows: null,
    }, async (batch: Record<string, unknown>[]) => {
      rows.push(...batch);
    });

    expect(loadPageSpy).toHaveBeenCalledWith(expect.objectContaining({
      pageSize: 5_000,
    }), prisma);
    expect(templatesSpy).not.toHaveBeenCalled();
    expect(rows).toEqual([expect.objectContaining({
      userId: 'user-1',
      userLabel: 'user@example.com',
      currency: 'CNY',
      periodCollectionAmountCents: 500,
      accumulatedCollectionAmountCents: 500,
      receivableAmountCents: 0,
      periodRefundPaymentAmountCents: -100,
      accumulatedRefundPaymentAmountCents: -100,
    })]);
    expect((service as any).getFinanceRawUsd(rows[0], 'periodRefundPaymentAmountCents').toString())
      .toBe('-1');
  });

  it('pages enterprise-credit groups and preserves raw monetary values through disk sorting', async () => {
    const firstPage = Array.from({ length: 2_000 }, (_, index) => ({
      tenantId: index === 1_999 ? 'tenant-b' : `tenant-${String(index).padStart(4, '0')}`,
      productId: null,
      _count: { _all: index === 1_999 ? 2 : 1 },
      _sum: {
        amountUsd: new Prisma.Decimal(index === 1_999 ? '1.005' : '1'),
        recognizedRevenueUsd: new Prisma.Decimal(index === 1_999 ? '1.005' : '1'),
        settledUsd: new Prisma.Decimal(index === 1_999 ? '0.005' : '0'),
      },
    }));
    const groupBy = jest.fn()
      .mockResolvedValueOnce(firstPage)
      .mockResolvedValueOnce([]);
    const { service } = buildService({
      prismaOverrides: {
        balanceConsumptionAllocation: { groupBy },
        tenant: {
          findMany: jest.fn().mockResolvedValue([{ id: 'tenant-b', name: 'B', type: 'ENTERPRISE' }]),
        },
        product: {
          ...makePrisma().product,
          findMany: jest.fn().mockResolvedValue([]),
        },
      } as any,
    });
    const rows: Record<string, unknown>[] = [];

    await (service as any).writeEnterpriseCreditSummaryExportRows({
      id: 'job-enterprise',
      month: '2026-05',
      tab: 'enterpriseCreditConsumptionSummary',
      asOf: new Date('2026-06-01T00:00:00.000Z'),
      path: join(tmpdir(), 'finance-enterprise-summary.csv'),
      totalRows: null,
    }, async (batch: Record<string, unknown>[]) => {
      rows.push(...batch);
    });

    expect(groupBy).toHaveBeenNthCalledWith(1, expect.objectContaining({
      skip: 0,
      take: 2_000,
      orderBy: [{ tenantId: 'asc' }, { productId: 'asc' }],
    }));
    expect(groupBy).toHaveBeenNthCalledWith(2, expect.objectContaining({ skip: 2_000 }));
    const target = rows.find((row) => row.id === 'tenant-b:none')!;
    expect((service as any).getFinanceRawUsd(target, 'consumedCents').toString()).toBe('1.005');
    expect((service as any).getFinanceRawUsd(target, 'settledCents').toString()).toBe('0.005');
  });

  it.each([
    {
      collector: 'summary',
      failureMode: 'a missing next cursor',
      nextCursors: [null],
      expectedError: 'FINANCE_REPORT_INTERNAL_CURSOR_INVALID:missing_next_cursor',
    },
    {
      collector: 'export',
      failureMode: 'a cursor equal to the current cursor',
      nextCursors: ['cursor-a', 'cursor-a'],
      expectedError: 'FINANCE_REPORT_INTERNAL_CURSOR_INVALID:cursor_not_advancing',
    },
    {
      collector: 'summary',
      failureMode: 'a cursor seen on an earlier page',
      nextCursors: ['cursor-a', 'cursor-b', 'cursor-a'],
      expectedError: 'FINANCE_REPORT_INTERNAL_CURSOR_INVALID:cursor_not_advancing',
    },
  ])('fails $collector collection closed on $failureMode', async ({
    collector,
    nextCursors,
    expectedError,
  }) => {
    const { service } = buildService();
    let pageIndex = 0;
    const detailSpy = collector === 'summary'
      ? jest.spyOn(service as any, 'loadFinanceGiftConsumptionPage')
        .mockImplementation(async (): Promise<any> => {
          const nextCursor = nextCursors[pageIndex++];
          const pageRows = nextCursor === null
            ? []
            : [{
              id: nextCursor,
              createdAt: new Date('2026-05-20T00:00:00.000Z'),
            }];
          return {
            sourceRows: pageRows,
            pageRows,
            items: [],
            hasMore: true,
          };
        })
      : jest.spyOn(service, 'getFinanceReportDetail')
        .mockImplementation(async (params: any): Promise<any> => ({
          period: {
            month: '2026-05',
            startDate: '2026-04-30T16:00:00.000Z',
            endDate: '2026-05-31T16:00:00.000Z',
          },
          tab: params.tab,
          rows: [],
          pagination: {
            mode: 'cursor',
            pageSize: 500,
            hasMore: true,
            nextCursor: nextCursors[pageIndex++],
            rowsReturned: 0,
          },
        }));

    const collection = collector === 'summary'
      ? (service as any).collectFinanceConsumptionSummaryRows({
        month: '2026-05',
        tab: 'buyGiftConsumptionSummary',
      })
      : (service as any).collectFinanceExportRows({
        month: '2026-05',
        tab: 'orders',
      });

    await expect(collection).rejects.toThrow(expectedError);
    expect(detailSpy).toHaveBeenCalledTimes(nextCursors.length);
  });

  it('selects and displays an old grant that refund-netted to zero in the period', async () => {
    const occurredAt = new Date('2026-05-10T00:00:00Z');
    const zeroedGrant = {
      id: 'grant-zeroed-in-period',
      userId: 'user-1',
      tenantId: 'tenant-1',
      orderId: 'order-zeroed-in-period',
      productId: 'prod-payg',
      source: 'RECHARGE',
      paidAmountUsd: new Prisma.Decimal(1),
      bonusAmountUsd: new Prisma.Decimal(0),
      grantedAmountUsd: new Prisma.Decimal(1),
      remainingAmountUsd: new Prisma.Decimal(0),
      remainingPaidAmountUsd: new Prisma.Decimal(0),
      remainingBonusAmountUsd: new Prisma.Decimal(0),
      discountRate: new Prisma.Decimal(1),
      validFrom: new Date('2026-04-01T00:00:00Z'),
      expiresAt: new Date('2027-04-01T00:00:00Z'),
      isExpired: false,
      createdAt: new Date('2026-04-01T00:00:00Z'),
      user: { id: 'user-1', email: 'user@example.com' },
      tenant: { id: 'tenant-1', name: 'default' },
      product: { id: 'prod-payg', name: 'PAYG', billingMode: ProductBillingMode.PAY_AS_YOU_GO },
      order: null,
      targetRefunds: [],
      refundAllocations: [{
        role: 'DEBT_NETTING',
        amountUsd: new Prisma.Decimal(1),
        paidReductionUsd: new Prisma.Decimal(1),
        bonusReductionUsd: new Prisma.Decimal(0),
        refund: { occurredAt },
      }],
      debtSettlements: [{
        trigger: 'REFUND_NETTING',
        amountUsd: new Prisma.Decimal(1),
        paidUsd: new Prisma.Decimal(1),
        bonusUsd: new Prisma.Decimal(0),
        occurredAt,
      }],
      expiryAudit: null,
    };
    const financePrisma = makeFinanceReportPrisma([], { balanceGrants: [zeroedGrant] });
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    const result = await service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'buyGiftAccountChanges',
      pageSize: 10,
    });

    const activityWhere = financePrisma.balanceGrant.findMany.mock.calls[0][0].where.AND[0].OR;
    expect(activityWhere).toEqual(expect.arrayContaining([
      expect.objectContaining({ allocations: { some: expect.any(Object) } }),
      expect.objectContaining({ debtSettlements: { some: expect.any(Object) } }),
      expect.objectContaining({ targetRefunds: { some: expect.any(Object) } }),
      expect.objectContaining({ refundAllocations: { some: expect.any(Object) } }),
      expect.objectContaining({ expiryAudit: { is: expect.any(Object) } }),
    ]));
    expect(result.rows).toEqual([
      expect.objectContaining({
        rechargeBatchNo: 'grant-zeroed-in-period',
        openingAvailableBalanceCents: 100,
        periodOtherChangeAmountCents: -100,
        closingAvailableBalanceCents: 0,
      }),
    ]);
  });

  it('replays a later consumption so an old zero-current grant still has its historical closing balance', async () => {
    const grant = makeReconciledFinanceGrant({
      id: 'grant-consumed-next-month',
      validFrom: new Date('2025-12-01T00:00:00Z'),
      createdAt: new Date('2025-12-01T00:00:00Z'),
      remainingAmountUsd: new Prisma.Decimal(0),
      remainingPaidAmountUsd: new Prisma.Decimal(0),
      remainingBonusAmountUsd: new Prisma.Decimal(0),
    });
    const financePrisma = makeFinanceReportPrisma([], { balanceGrants: [grant] });
    financePrisma.balanceConsumptionAllocation.groupBy
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([{
        balanceGrantId: grant.id,
        _sum: {
          amountUsd: new Prisma.Decimal(5),
          recognizedRevenueUsd: new Prisma.Decimal(5),
          bonusConsumedUsd: new Prisma.Decimal(0),
        },
      }]);
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    const january = await service.getFinanceReportDetail({
      month: '2026-01',
      tab: 'buyGiftAccountChanges',
      pageSize: 10,
    });

    expect(january.rows).toEqual([expect.objectContaining({
      rechargeBatchNo: 'grant-consumed-next-month',
      openingAvailableBalanceCents: 500,
      periodRechargeAmountCents: 0,
      closingAvailableBalanceCents: 500,
    })]);
    const candidateWhere = financePrisma.balanceGrant.findMany.mock.calls[0][0].where.AND[0];
    expect(JSON.stringify(candidateWhere)).not.toContain('remainingAmountUsd');
    expect(candidateWhere.OR).toEqual(expect.arrayContaining([
      expect.objectContaining({
        validFrom: { lt: new Date('2026-01-31T16:00:00.000Z') },
      }),
    ]));
  });

  it('fails closed before aggregate replay when any historical allocation fact is polluted', async () => {
    const grant = makeReconciledFinanceGrant({
      id: 'grant-with-offsetting-pollution',
      validFrom: new Date('2025-12-01T00:00:00Z'),
      createdAt: new Date('2025-12-01T00:00:00Z'),
    });
    const financePrisma = makeFinanceReportPrisma([], { balanceGrants: [grant] });
    financePrisma.$queryRaw.mockImplementation((query: { strings?: readonly string[] }) => {
      const sql = query?.strings?.join('') ?? '';
      if (sql.includes('transaction_timestamp()')) {
        return Promise.resolve([{ asOf: new Date('2026-08-15T00:00:00.000Z') }]);
      }
      if (sql.includes('clock_timestamp()')) {
        return Promise.resolve([{ financialNow: new Date('2026-07-16T00:00:00.000Z') }]);
      }
      return Promise.resolve([{ invalid_fact_count: BigInt(1) }]);
    });
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    await expect(service.getFinanceReportDetail({
      month: '2026-01',
      tab: 'buyGiftAccountChanges',
      pageSize: 10,
    })).rejects.toThrow(
      'BALANCE_LEDGER_RECONCILIATION_REQUIRED:grant-with-offsetting-pollution:allocation_fact_set',
    );

    const invalidFactCall = financePrisma.$queryRaw.mock.calls.find(([query]: any[]) => (
      query?.strings?.join('').includes('invalid_fact_count')
    ));
    const sql = invalidFactCall?.[0] as { strings: string[] };
    const rendered = sql.strings.join('');
    expect(rendered).toContain("allocation.source <> 'BALANCE_GRANT'");
    expect(rendered).toContain('allocation.recognized_revenue_usd + allocation.bonus_consumed_usd <> allocation.amount_usd');
    expect(rendered).toContain('grant_row.billing_account_id IS DISTINCT FROM allocation.billing_account_id');
  });

  it('accepts a cross-account grant allocation only when the enterprise absorb proof covers it', async () => {
    const grantAccountId = 'billing-account-enterprise-target';
    const allocationAccountId = 'billing-account-personal-source';
    const grant = makeReconciledFinanceGrant({
      id: 'grant-enterprise-absorb-proof',
      ...reconciledFinanceGrantAccount(grantAccountId),
      paidAmountUsd: new Prisma.Decimal(1),
      grantedAmountUsd: new Prisma.Decimal(1),
      remainingAmountUsd: new Prisma.Decimal(0),
      remainingPaidAmountUsd: new Prisma.Decimal(0),
      validFrom: new Date('2026-05-01T00:00:00Z'),
      createdAt: new Date('2026-05-01T00:00:00Z'),
    });
    const allocation = {
      id: 'allocation-enterprise-absorb-proof',
      userId: grant.userId,
      tenantId: grant.tenantId,
      productId: grant.productId,
      billingAccountId: allocationAccountId,
      balanceTransactionId: 'consume-enterprise-absorb-proof',
      tokenUsageId: null,
      balanceGrantId: grant.id,
      source: 'BALANCE_GRANT',
      amountUsd: new Prisma.Decimal(1),
      recognizedRevenueUsd: new Prisma.Decimal(1),
      bonusConsumedUsd: new Prisma.Decimal(0),
      discountRate: new Prisma.Decimal(1),
      createdAt: new Date('2026-05-10T00:00:00Z'),
      balanceGrant: grant,
      balanceTransaction: null,
      tokenUsage: null,
    };
    const financePrisma = makeFinanceReportPrisma([], {
      balanceGrants: [grant],
      balanceConsumptionAllocations: [allocation],
    });
    financePrisma.$queryRaw.mockImplementation((query: { strings?: readonly string[] }) => {
      const sql = query?.strings?.join('') ?? '';
      if (sql.includes('clock_timestamp()')) {
        return Promise.resolve([{ financialNow: new Date('2026-07-16T00:00:00.000Z') }]);
      }
      if (sql.includes('invalid_fact_count')) {
        return Promise.resolve([{ invalid_fact_count: BigInt(0) }]);
      }
      if (sql.includes('balance_allocation_has_enterprise_absorb_proof')) {
        return Promise.resolve([{
          allocationId: allocation.id,
          balanceGrantId: grant.id,
          allocationBillingAccountId: allocationAccountId,
        }]);
      }
      return Promise.resolve([]);
    });
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    const report = await service.getFinanceReports('2026-05');

    expect(report.financeTemplates.buyGift.accountChangeDetails).toEqual([
      expect.objectContaining({ rechargeBatchNo: grant.id }),
    ]);
    const proofCalls = financePrisma.$queryRaw.mock.calls.filter(([query]: any[]) => {
      const sql = query?.strings?.join('') ?? '';
      return sql.includes('balance_allocation_has_enterprise_absorb_proof')
        && !sql.includes('invalid_fact_count');
    });
    expect(proofCalls).toHaveLength(1);
    const invalidFactCall = financePrisma.$queryRaw.mock.calls.find(([query]: any[]) => (
      query?.strings?.join('').includes('invalid_fact_count')
    ));
    expect(invalidFactCall?.[0].strings.join('')).toContain(
      'balance_allocation_has_enterprise_absorb_proof',
    );
  });

  it('still rejects a cross-account grant allocation when enterprise absorb proof is absent', async () => {
    const grantAccountId = 'billing-account-enterprise-target';
    const allocationAccountId = 'billing-account-personal-source';
    const grant = makeReconciledFinanceGrant({
      id: 'grant-enterprise-absorb-unproven',
      ...reconciledFinanceGrantAccount(grantAccountId),
      paidAmountUsd: new Prisma.Decimal(1),
      grantedAmountUsd: new Prisma.Decimal(1),
      remainingAmountUsd: new Prisma.Decimal(0),
      remainingPaidAmountUsd: new Prisma.Decimal(0),
      validFrom: new Date('2026-05-01T00:00:00Z'),
      createdAt: new Date('2026-05-01T00:00:00Z'),
    });
    const allocation = {
      id: 'allocation-enterprise-absorb-unproven',
      userId: grant.userId,
      tenantId: grant.tenantId,
      productId: grant.productId,
      billingAccountId: allocationAccountId,
      balanceTransactionId: 'consume-enterprise-absorb-unproven',
      tokenUsageId: null,
      balanceGrantId: grant.id,
      source: 'BALANCE_GRANT',
      amountUsd: new Prisma.Decimal(1),
      recognizedRevenueUsd: new Prisma.Decimal(1),
      bonusConsumedUsd: new Prisma.Decimal(0),
      discountRate: new Prisma.Decimal(1),
      createdAt: new Date('2026-05-10T00:00:00Z'),
      balanceGrant: grant,
      balanceTransaction: null,
      tokenUsage: null,
    };
    const financePrisma = makeFinanceReportPrisma([], {
      balanceGrants: [grant],
      balanceConsumptionAllocations: [allocation],
    });
    financePrisma.$queryRaw.mockImplementation((query: { strings?: readonly string[] }) => {
      const sql = query?.strings?.join('') ?? '';
      if (sql.includes('clock_timestamp()')) {
        return Promise.resolve([{ financialNow: new Date('2026-07-16T00:00:00.000Z') }]);
      }
      if (sql.includes('invalid_fact_count')) {
        return Promise.resolve([{ invalid_fact_count: BigInt(0) }]);
      }
      return Promise.resolve([]);
    });
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    await expect(service.getFinanceReports('2026-05')).rejects.toThrow(
      `BALANCE_LEDGER_RECONCILIATION_REQUIRED:${grant.id}:allocation_components`,
    );
  });

  it('fails closed when a debt settlement belongs to another billing account', async () => {
    const occurredAt = new Date('2026-01-10T00:00:00Z');
    const grant = makeReconciledFinanceGrant({
      id: 'grant-with-foreign-settlement',
      validFrom: new Date('2025-12-01T00:00:00Z'),
      createdAt: new Date('2025-12-01T00:00:00Z'),
      remainingAmountUsd: new Prisma.Decimal(4),
      remainingPaidAmountUsd: new Prisma.Decimal(4),
      debtSettlements: [{
        trigger: 'FUNDING',
        amountUsd: new Prisma.Decimal(1),
        paidUsd: new Prisma.Decimal(1),
        bonusUsd: new Prisma.Decimal(0),
        occurredAt,
        allocation: {
          billingAccountId: 'billing-account-foreign',
        },
      }],
    });
    const financePrisma = makeFinanceReportPrisma([], { balanceGrants: [grant] });
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    await expect(service.getFinanceReportDetail({
      month: '2026-01',
      tab: 'buyGiftAccountChanges',
      pageSize: 10,
    })).rejects.toThrow(
      'BALANCE_LEDGER_RECONCILIATION_REQUIRED:grant-with-foreign-settlement:settlement_components',
    );

    const include = financePrisma.balanceGrant.findMany.mock.calls[1][0].include;
    expect(include.debtSettlements.select).toEqual(expect.objectContaining({
      id: true,
      billingAccountId: true,
      allocationId: true,
      balanceGrantId: true,
      debtSource: true,
      repairRunId: true,
      allocation: expect.any(Object),
    }));
  });

  it('accepts an audited personal REPAIR settlement in finance grant replay', async () => {
    const occurredAt = new Date('2026-01-10T00:00:00Z');
    const grant = makeReconciledFinanceGrant({
      id: 'grant-with-personal-repair-settlement',
      validFrom: new Date('2025-12-01T00:00:00Z'),
      createdAt: new Date('2025-12-01T00:00:00Z'),
      remainingAmountUsd: new Prisma.Decimal(4),
      remainingPaidAmountUsd: new Prisma.Decimal(4),
      debtSettlements: [{
        trigger: 'REPAIR',
        repairRunId: 'repair-run-1',
        debtSource: 'NEGATIVE_BALANCE',
        repaymentTransactionId: 'repair-funding-transaction-1',
        amountUsd: new Prisma.Decimal(1),
        paidUsd: new Prisma.Decimal(1),
        bonusUsd: new Prisma.Decimal(0),
        occurredAt,
      }],
    });
    const financePrisma = makeFinanceReportPrisma([], { balanceGrants: [grant] });
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    const report = await service.getFinanceReportDetail({
      month: '2026-01',
      tab: 'buyGiftAccountChanges',
      pageSize: 10,
    });

    expect(report.rows).toEqual([
      expect.objectContaining({
        rechargeBatchNo: 'grant-with-personal-repair-settlement',
        closingAvailableBalanceCents: 400,
      }),
    ]);
  });

  it('batch-attaches a strictly proven legacy NULL settlement to finance grant replay', async () => {
    const occurredAt = new Date('2026-01-10T00:00:00Z');
    const grant = makeReconciledFinanceGrant({
      id: 'grant-with-proven-legacy-settlement',
      validFrom: new Date('2025-12-01T00:00:00Z'),
      createdAt: new Date('2025-12-01T00:00:00Z'),
      remainingAmountUsd: new Prisma.Decimal(4),
      remainingPaidAmountUsd: new Prisma.Decimal(4),
    });
    const settlement = {
      id: 'legacy-null-settlement-proven',
      billingAccountId: grant.billingAccountId,
      allocationId: 'legacy-enterprise-allocation-proven',
      repaymentTransactionId: 'legacy-enterprise-repayment-proven',
      balanceGrantId: null,
      debtSource: 'ENTERPRISE_CREDIT',
      repairRunId: null,
      trigger: 'FUNDING',
      amountUsd: new Prisma.Decimal(1),
      paidUsd: new Prisma.Decimal(1),
      bonusUsd: new Prisma.Decimal(0),
      occurredAt,
      allocation: {
        id: 'legacy-enterprise-allocation-proven',
        billingAccountId: grant.billingAccountId,
        source: 'ENTERPRISE_CREDIT',
      },
    };
    const financePrisma = makeFinanceReportPrisma([], {
      balanceGrants: [grant],
      enterpriseCreditSettlements: [settlement],
    });
    financePrisma.$queryRaw.mockImplementation((query: { strings?: readonly string[] }) => {
      const sql = query?.strings?.join('') ?? '';
      if (sql.includes('transaction_timestamp()')) {
        return Promise.resolve([{ asOf: new Date('2026-08-15T00:00:00.000Z') }]);
      }
      if (sql.includes('balance_legacy_settlement_effective_grant_id')) {
        return Promise.resolve([{
          settlementId: settlement.id,
          effectiveBalanceGrantId: grant.id,
        }]);
      }
      if (sql.includes('clock_timestamp()')) {
        return Promise.resolve([{ financialNow: new Date('2026-07-16T00:00:00.000Z') }]);
      }
      if (sql.includes('invalid_fact_count')) {
        return Promise.resolve([{ invalid_fact_count: BigInt(0) }]);
      }
      return Promise.resolve([]);
    });
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    const report = await service.getFinanceReportDetail({
      month: '2026-01',
      tab: 'buyGiftAccountChanges',
      pageSize: 10,
    });

    expect(report.rows).toEqual([
      expect.objectContaining({
        rechargeBatchNo: grant.id,
        periodConsumeAmountCents: -100,
        closingAvailableBalanceCents: 400,
      }),
    ]);
    const proofQueries = financePrisma.$queryRaw.mock.calls.filter(([query]: any[]) => (
      query?.strings?.join('').includes('balance_legacy_settlement_effective_grant_id')
    ));
    expect(proofQueries).toHaveLength(1);
    expect(financePrisma.enterpriseCreditSettlement.findMany).toHaveBeenCalledTimes(1);
  });

  it('does not attribute an unproven legacy NULL settlement in finance grant replay', async () => {
    const grant = makeReconciledFinanceGrant({
      id: 'grant-with-unproven-legacy-settlement',
      validFrom: new Date('2025-12-01T00:00:00Z'),
      createdAt: new Date('2025-12-01T00:00:00Z'),
      remainingAmountUsd: new Prisma.Decimal(4),
      remainingPaidAmountUsd: new Prisma.Decimal(4),
    });
    const financePrisma = makeFinanceReportPrisma([], { balanceGrants: [grant] });
    financePrisma.$queryRaw.mockImplementation((query: { strings?: readonly string[] }) => {
      const sql = query?.strings?.join('') ?? '';
      if (sql.includes('transaction_timestamp()')) {
        return Promise.resolve([{ asOf: new Date('2026-08-15T00:00:00.000Z') }]);
      }
      if (sql.includes('balance_legacy_settlement_effective_grant_id')) {
        return Promise.resolve([]);
      }
      if (sql.includes('clock_timestamp()')) {
        return Promise.resolve([{ financialNow: new Date('2026-07-16T00:00:00.000Z') }]);
      }
      if (sql.includes('invalid_fact_count')) {
        return Promise.resolve([{ invalid_fact_count: BigInt(0) }]);
      }
      return Promise.resolve([]);
    });
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    await expect(service.getFinanceReportDetail({
      month: '2026-01',
      tab: 'buyGiftAccountChanges',
      pageSize: 10,
    })).rejects.toThrow(
      `BALANCE_LEDGER_RECONCILIATION_REQUIRED:${grant.id}:current_components_postcondition`,
    );
    expect(financePrisma.enterpriseCreditSettlement.findMany).not.toHaveBeenCalled();
  });

  it.each([
    ['missing repair run', { repairRunId: null }],
    ['enterprise debt source', { debtSource: 'ENTERPRISE_CREDIT' }],
    ['missing repayment transaction', { repaymentTransactionId: null }],
    ['repair id on online funding', { trigger: 'FUNDING' }],
  ])('fails closed for malformed REPAIR settlement: %s', async (_label, mutation) => {
    const occurredAt = new Date('2026-01-10T00:00:00Z');
    const grant = makeReconciledFinanceGrant({
      id: 'grant-with-malformed-repair-settlement',
      validFrom: new Date('2025-12-01T00:00:00Z'),
      createdAt: new Date('2025-12-01T00:00:00Z'),
      remainingAmountUsd: new Prisma.Decimal(4),
      remainingPaidAmountUsd: new Prisma.Decimal(4),
      debtSettlements: [{
        trigger: 'REPAIR',
        repairRunId: 'repair-run-1',
        debtSource: 'NEGATIVE_BALANCE',
        repaymentTransactionId: 'repair-funding-transaction-1',
        amountUsd: new Prisma.Decimal(1),
        paidUsd: new Prisma.Decimal(1),
        bonusUsd: new Prisma.Decimal(0),
        occurredAt,
        ...mutation,
      }],
    });
    const financePrisma = makeFinanceReportPrisma([], { balanceGrants: [grant] });
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    await expect(service.getFinanceReportDetail({
      month: '2026-01',
      tab: 'buyGiftAccountChanges',
      pageSize: 10,
    })).rejects.toThrow(
      'BALANCE_LEDGER_RECONCILIATION_REQUIRED:grant-with-malformed-repair-settlement:settlement_components',
    );
  });

  it('fails closed when a refund-netting target grant belongs to another billing account', async () => {
    const occurredAt = new Date('2026-01-10T00:00:00Z');
    const grant = makeReconciledFinanceGrant({
      id: 'grant-with-foreign-refund',
      validFrom: new Date('2025-12-01T00:00:00Z'),
      createdAt: new Date('2025-12-01T00:00:00Z'),
      remainingAmountUsd: new Prisma.Decimal(4),
      remainingPaidAmountUsd: new Prisma.Decimal(4),
      refundAllocations: [{
        role: 'DEBT_NETTING',
        amountUsd: new Prisma.Decimal(1),
        paidReductionUsd: new Prisma.Decimal(1),
        bonusReductionUsd: new Prisma.Decimal(0),
        refund: {
          balanceGrantId: 'grant-foreign-target',
          balanceGrant: {
            id: 'grant-foreign-target',
            billingAccountId: 'billing-account-foreign',
          },
          occurredAt,
        },
      }],
    });
    const financePrisma = makeFinanceReportPrisma([], { balanceGrants: [grant] });
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    await expect(service.getFinanceReportDetail({
      month: '2026-01',
      tab: 'buyGiftAccountChanges',
      pageSize: 10,
    })).rejects.toThrow(
      'BALANCE_LEDGER_RECONCILIATION_REQUIRED:grant-with-foreign-refund:refund_components',
    );

    const include = financePrisma.balanceGrant.findMany.mock.calls[1][0].include;
    expect(include.refundAllocations.select).toEqual(expect.objectContaining({
      id: true,
      refundId: true,
      balanceGrantId: true,
      sequence: true,
      refund: expect.any(Object),
    }));
  });

  it('does not require an expiry audit for a current-month grant that expires after financialNow', async () => {
    const notYetDueGrant = makeReconciledFinanceGrant({
      id: 'grant-expiry-later-this-month',
      validFrom: new Date('2026-06-01T00:00:00Z'),
      createdAt: new Date('2026-06-01T00:00:00Z'),
      expiresAt: new Date('2026-07-20T00:00:00Z'),
      isExpired: false,
      expiryAudit: null,
    });
    const financePrisma = makeFinanceReportPrisma([], { balanceGrants: [notYetDueGrant] });
    setFinanceSnapshotAsOf(
      financePrisma,
      new Date('2026-07-16T00:00:00.000Z'),
    );
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    const report = await service.getFinanceReportDetail({
      month: '2026-07',
      tab: 'buyGiftAccountChanges',
      pageSize: 10,
    });

    expect(report.rows).toEqual([
      expect.objectContaining({
        rechargeBatchNo: 'grant-expiry-later-this-month',
        closingAvailableBalanceCents: 500,
      }),
    ]);
    const snapshotQueries = financePrisma.$queryRaw.mock.calls.filter(([query]: any[]) => (
      query?.strings?.join('').includes('transaction_timestamp()')
    ));
    expect(snapshotQueries).toHaveLength(1);
    expect(financePrisma.$queryRaw.mock.calls.some(([query]: any[]) => (
      query?.strings?.join('').includes('clock_timestamp()')
    ))).toBe(false);
  });

  it('uses the historical period end when a due grant has no expiry audit', async () => {
    const unsweptGrant = makeReconciledFinanceGrant({
      id: 'grant-expiry-unswept',
      validFrom: new Date('2025-12-01T00:00:00Z'),
      createdAt: new Date('2025-12-01T00:00:00Z'),
      expiresAt: new Date('2026-01-15T00:00:00Z'),
      isExpired: false,
      expiryAudit: null,
    });
    const financePrisma = makeFinanceReportPrisma([], { balanceGrants: [unsweptGrant] });
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    await expect(service.getFinanceReportDetail({
      month: '2026-01',
      tab: 'buyGiftAccountChanges',
      pageSize: 10,
    })).rejects.toThrow(
      'BALANCE_LEDGER_RECONCILIATION_REQUIRED:grant-expiry-unswept:expiry_due_unreconciled',
    );
    const snapshotQueries = financePrisma.$queryRaw.mock.calls.filter(([query]: any[]) => (
      query?.strings?.join('').includes('transaction_timestamp()')
    ));
    expect(snapshotQueries).toHaveLength(1);
    expect(financePrisma.$queryRaw.mock.calls.some(([query]: any[]) => (
      query?.strings?.join('').includes('clock_timestamp()')
    ))).toBe(false);
  });

  it('allows a pure gift fully consumed before expiry through the public detail entrypoint in a later month', async () => {
    const grant = makeReconciledFinanceGrant({
      id: 'pure-gift-consumed-before-expiry',
      source: 'VOUCHER',
      paidAmountUsd: new Prisma.Decimal(0),
      bonusAmountUsd: new Prisma.Decimal(5),
      grantedAmountUsd: new Prisma.Decimal(5),
      remainingAmountUsd: new Prisma.Decimal(0),
      remainingPaidAmountUsd: new Prisma.Decimal(0),
      remainingBonusAmountUsd: new Prisma.Decimal(0),
      validFrom: new Date('2026-05-01T00:00:00Z'),
      createdAt: new Date('2026-05-01T00:00:00Z'),
      expiresAt: new Date('2026-05-10T00:00:00Z'),
      isExpired: false,
      expiryAudit: null,
    });
    const allocation = {
      id: 'pure-gift-allocation-before-expiry',
      billingAccountId: grant.billingAccountId,
      balanceGrantId: grant.id,
      amountUsd: new Prisma.Decimal(5),
      recognizedRevenueUsd: new Prisma.Decimal(0),
      bonusConsumedUsd: new Prisma.Decimal(5),
      createdAt: new Date('2026-05-09T00:00:00Z'),
    };
    const aggregate = [{
      balanceGrantId: grant.id,
      _sum: {
        amountUsd: new Prisma.Decimal(5),
        recognizedRevenueUsd: new Prisma.Decimal(0),
        bonusConsumedUsd: new Prisma.Decimal(5),
      },
    }];
    const financePrisma = makeFinanceReportPrisma([], {
      balanceGrants: [grant],
      balanceConsumptionAllocations: [allocation],
    });
    financePrisma.balanceConsumptionAllocation.groupBy
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce(aggregate)
      .mockResolvedValueOnce([]);
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    const result = await service.getFinanceReportDetail({
      month: '2026-06',
      tab: 'pureGiftAccountChanges',
      pageSize: 10,
    });

    expect(result.rows).toEqual([]);
    expect(financePrisma.balanceConsumptionAllocation.groupBy).toHaveBeenCalledTimes(3);
    expect(financePrisma.balanceConsumptionAllocation.groupBy.mock.calls[1][0].where.createdAt)
      .toEqual({ lt: new Date('2026-05-31T16:00:00.000Z') });
  });

  it('fails closed at the public detail entrypoint for a zero-current gift consumed at expiry', async () => {
    const grant = makeReconciledFinanceGrant({
      id: 'pure-gift-consumed-at-expiry',
      source: 'VOUCHER',
      paidAmountUsd: new Prisma.Decimal(0),
      bonusAmountUsd: new Prisma.Decimal(5),
      grantedAmountUsd: new Prisma.Decimal(5),
      remainingAmountUsd: new Prisma.Decimal(0),
      remainingPaidAmountUsd: new Prisma.Decimal(0),
      remainingBonusAmountUsd: new Prisma.Decimal(0),
      validFrom: new Date('2026-05-01T00:00:00Z'),
      createdAt: new Date('2026-05-01T00:00:00Z'),
      expiresAt: new Date('2026-05-10T00:00:00Z'),
      isExpired: false,
      expiryAudit: null,
    });
    const allocation = {
      id: 'pure-gift-allocation-at-expiry',
      billingAccountId: grant.billingAccountId,
      balanceGrantId: grant.id,
      amountUsd: new Prisma.Decimal(5),
      recognizedRevenueUsd: new Prisma.Decimal(0),
      bonusConsumedUsd: new Prisma.Decimal(5),
      createdAt: new Date('2026-05-10T00:00:00Z'),
    };
    const aggregate = [{
      balanceGrantId: grant.id,
      _sum: {
        amountUsd: new Prisma.Decimal(5),
        recognizedRevenueUsd: new Prisma.Decimal(0),
        bonusConsumedUsd: new Prisma.Decimal(5),
      },
    }];
    const financePrisma = makeFinanceReportPrisma([], {
      balanceGrants: [grant],
      balanceConsumptionAllocations: [allocation],
    });
    financePrisma.balanceConsumptionAllocation.groupBy
      .mockResolvedValueOnce(aggregate)
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([]);
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    await expect(service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'pureGiftAccountChanges',
      pageSize: 10,
    })).rejects.toThrow(
      `BALANCE_LEDGER_RECONCILIATION_REQUIRED:${grant.id}:allocation_at_or_after_expiry`,
    );
    expect(financePrisma.balanceConsumptionAllocation.groupBy).toHaveBeenCalledTimes(3);
    expect(financePrisma.balanceConsumptionAllocation.groupBy.mock.calls[0][0].where.createdAt)
      .toEqual({
        gte: new Date('2026-04-30T16:00:00.000Z'),
        lt: new Date('2026-05-31T16:00:00.000Z'),
      });
  });

  it('rejects an allocation fact dated before its grant becomes valid', async () => {
    const grant = makeReconciledFinanceGrant({
      id: 'pure-gift-consumed-before-valid-from',
      source: 'VOUCHER',
      paidAmountUsd: new Prisma.Decimal(0),
      bonusAmountUsd: new Prisma.Decimal(5),
      grantedAmountUsd: new Prisma.Decimal(5),
      remainingAmountUsd: new Prisma.Decimal(0),
      remainingPaidAmountUsd: new Prisma.Decimal(0),
      remainingBonusAmountUsd: new Prisma.Decimal(0),
      validFrom: new Date('2026-05-05T00:00:00Z'),
      createdAt: new Date('2026-05-05T00:00:00Z'),
      expiresAt: new Date('2026-05-10T00:00:00Z'),
      isExpired: false,
      expiryAudit: null,
    });
    const financePrisma = makeFinanceReportPrisma([], {
      balanceGrants: [grant],
      balanceConsumptionAllocations: [{
        id: 'pure-gift-allocation-before-valid-from',
        billingAccountId: grant.billingAccountId,
        balanceGrantId: grant.id,
        amountUsd: new Prisma.Decimal(5),
        recognizedRevenueUsd: new Prisma.Decimal(0),
        bonusConsumedUsd: new Prisma.Decimal(5),
        createdAt: new Date('2026-05-04T00:00:00Z'),
      }],
    });
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    await expect((service as any).loadFinanceGrantExpiryAllocationComponents(
      [grant],
      new Date('2026-06-01T00:00:00Z'),
      new Date('2026-06-01T00:00:00Z'),
    )).rejects.toThrow(
      `BALANCE_LEDGER_RECONCILIATION_REQUIRED:${grant.id}:allocation_before_valid_from`,
    );
  });

  it('derives aggregate allocation discount rate from rounded persisted components', async () => {
    const grant = makeReconciledFinanceGrant({
      id: 'grant-rounded-aggregate-rate',
      paidAmountUsd: new Prisma.Decimal(1),
      bonusAmountUsd: new Prisma.Decimal('0.2'),
      grantedAmountUsd: new Prisma.Decimal('1.2'),
      discountRate: new Prisma.Decimal('0.833333333333'),
    });
    const financePrisma = makeFinanceReportPrisma([], { balanceGrants: [grant] });
    financePrisma.balanceConsumptionAllocation.groupBy.mockResolvedValueOnce([{
      balanceGrantId: grant.id,
      _sum: {
        amountUsd: new Prisma.Decimal('0.02'),
        recognizedRevenueUsd: new Prisma.Decimal('0.016666666666'),
        bonusConsumedUsd: new Prisma.Decimal('0.003333333334'),
      },
    }]);
    const { service } = buildService({ prismaOverrides: financePrisma as any });
    const buildTemplates = jest.spyOn(service as any, 'buildGiftFinanceTemplates')
      .mockResolvedValue({});

    await (service as any).buildFinanceTemplatesForGrants(
      '2026-05',
      new Date('2026-04-30T16:00:00.000Z'),
      new Date('2026-05-31T16:00:00.000Z'),
      [grant],
      financePrisma,
    );

    const templateParams = buildTemplates.mock.calls[0][0] as any;
    const aggregateAllocation = templateParams.balanceConsumptionAllocations[0];
    expect(aggregateAllocation.discountRate.toFixed(12)).toBe('0.833333333300');
    expect(aggregateAllocation.discountRate.eq(grant.discountRate)).toBe(false);
  });


  it('uses persisted allocation bonus consumption in paginated batch movements', async () => {
    const grant = {
      id: 'grant-persisted-allocation-split',
      userId: 'user-1',
      tenantId: 'tenant-1',
      orderId: null,
      productId: 'prod-payg',
      source: 'RECHARGE',
      paidAmountUsd: new Prisma.Decimal(5),
      bonusAmountUsd: new Prisma.Decimal(5),
      grantedAmountUsd: new Prisma.Decimal(10),
      remainingAmountUsd: new Prisma.Decimal(5),
      remainingPaidAmountUsd: new Prisma.Decimal(2),
      remainingBonusAmountUsd: new Prisma.Decimal(3),
      discountRate: new Prisma.Decimal('0.5'),
      validFrom: new Date('2026-04-01T00:00:00Z'),
      expiresAt: new Date('2027-04-01T00:00:00Z'),
      isExpired: false,
      createdAt: new Date('2026-04-01T00:00:00Z'),
      user: { id: 'user-1', email: 'user@example.com' },
      tenant: { id: 'tenant-1', name: 'default' },
      product: { id: 'prod-payg', name: 'PAYG', billingMode: ProductBillingMode.PAY_AS_YOU_GO },
      order: null,
      targetRefunds: [],
      refundAllocations: [],
      debtSettlements: [],
      expiryAudit: null,
    };
    const financePrisma = makeFinanceReportPrisma([], { balanceGrants: [grant] });
    financePrisma.balanceConsumptionAllocation.groupBy
      .mockResolvedValueOnce([{
        balanceGrantId: grant.id,
        _sum: {
          amountUsd: new Prisma.Decimal('1.25'),
          recognizedRevenueUsd: new Prisma.Decimal(1),
          bonusConsumedUsd: new Prisma.Decimal('0.25'),
        },
      }])
      .mockResolvedValueOnce([{
        balanceGrantId: grant.id,
        _sum: {
          amountUsd: new Prisma.Decimal('3.75'),
          recognizedRevenueUsd: new Prisma.Decimal(2),
          bonusConsumedUsd: new Prisma.Decimal('1.75'),
        },
      }])
      .mockResolvedValueOnce([]);
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    const result = await service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'buyGiftAccountChanges',
      pageSize: 10,
    });

    expect(financePrisma.balanceConsumptionAllocation.groupBy).toHaveBeenCalledWith(
      expect.objectContaining({
        _sum: expect.objectContaining({ bonusConsumedUsd: true }),
      }),
    );
    expect(result.rows).toEqual([
      expect.objectContaining({
        openingAvailableBalanceCents: 625,
        openingAvailableBalancePaidCents: 300,
        periodConsumeAmountCents: -125,
        periodConsumePaidCents: -100,
        closingAvailableBalanceCents: 500,
        closingAvailableBalancePaidCents: 200,
      }),
    ]);
  });

  it('builds enterprise credit consumption, summary, and settlement reports', async () => {
    const tenant = { id: 'tenant-enterprise', name: '企业工作区', type: 'enterprise' };
    const product = { id: 'prod-payg', name: '按量产品' };
    const allocation = {
      id: 'allocation-enterprise',
      userId: 'user-enterprise',
      tenantId: tenant.id,
      productId: product.id,
      balanceTransactionId: 'transaction-enterprise',
      tokenUsageId: null,
      balanceGrantId: null,
      source: 'ENTERPRISE_CREDIT',
      amountUsd: new Prisma.Decimal('12.34'),
      recognizedRevenueUsd: new Prisma.Decimal('4.56'),
      bonusConsumedUsd: new Prisma.Decimal('0'),
      discountRate: new Prisma.Decimal('1'),
      settledUsd: new Prisma.Decimal('5.00'),
      settledAt: null,
      createdAt: new Date('2026-05-10T00:00:00Z'),
      user: { id: 'user-enterprise', email: 'enterprise@example.com', phone: null, nickname: null },
      tenant,
      product: { ...product, billingMode: ProductBillingMode.PAY_AS_YOU_GO },
      balanceGrant: null,
      balanceTransaction: { id: 'transaction-enterprise', orderId: null, description: 'enterprise credit usage', createdAt: new Date('2026-05-10T00:00:00Z') },
      tokenUsage: null,
    };
    const settlement = {
      id: 'settlement-enterprise',
      billingAccountId: 'account-enterprise',
      allocationId: allocation.id,
      repaymentTransactionId: 'transaction-repayment',
      trigger: 'FUNDING',
      amountUsd: new Prisma.Decimal('5.00'),
      paidUsd: new Prisma.Decimal('5.00'),
      bonusUsd: new Prisma.Decimal('0'),
      createdAt: new Date('2026-05-20T00:00:00Z'),
      allocation,
      repaymentTransaction: {
        id: 'transaction-repayment',
        description: '企业账户充值还款',
        createdAt: new Date('2026-05-20T00:00:00Z'),
      },
    };
    const financePrisma = makeFinanceReportPrisma([], {
      balanceConsumptionAllocations: [allocation],
      enterpriseCreditSettlements: [settlement],
      tenants: [tenant],
      products: [product],
    });
    financePrisma.balanceConsumptionAllocation.groupBy.mockResolvedValue([
      {
        tenantId: tenant.id,
        productId: product.id,
        _count: { _all: 1 },
        _sum: {
          amountUsd: new Prisma.Decimal('12.34'),
          recognizedRevenueUsd: new Prisma.Decimal('4.56'),
          settledUsd: new Prisma.Decimal('5.00'),
        },
      },
    ]);
    const { service } = buildService({ prismaOverrides: financePrisma as any });

    const detail = await service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'enterpriseCreditConsumptionDetails',
      pageSize: 10,
    });
    expect(detail.rows).toEqual([
      expect.objectContaining({
        allocationId: allocation.id,
        consumedCents: 1234,
        recognizedRevenueCents: 456,
        settledCents: 500,
        outstandingCents: 734,
        settlementStatus: '部分结算',
      }),
    ]);

    const summary = await service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'enterpriseCreditConsumptionSummary',
    });
    expect(summary.pagination).toEqual(expect.objectContaining({
      mode: 'cursor',
      totalRows: 1,
    }));
    expect(summary.rows).toEqual([
      expect.objectContaining({
        workspaceName: tenant.name,
        allocationCount: 1,
        consumedCents: 1234,
        settledCents: 500,
        outstandingCents: 734,
      }),
    ]);

    const settlementDetail = await service.getFinanceReportDetail({
      month: '2026-05',
      tab: 'enterpriseCreditSettlement',
      pageSize: 10,
    });
    expect(settlementDetail.rows).toEqual([
      expect.objectContaining({
        settlementId: settlement.id,
        amountCents: 500,
        paidCents: 500,
        repaymentTransactionDescription: '企业账户充值还款',
      }),
    ]);
  });

  it('creates finance export jobs without processing them in the request path', async () => {
    const job = makeFinanceExportJob();
    const { service, prisma } = buildService();
    prisma.financeExportJob.create.mockResolvedValue(job);
    const processSpy = jest.spyOn(service, 'processFinanceReportExportJob');

    const result = await service.createFinanceReportExportJob({
      month: '2026-06',
      tab: 'orders',
      billingMode: 'CODING_PLAN',
      requestedByAdminId: 'admin-1',
    });

    expect(prisma.financeExportJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        month: '2026-06',
        tab: 'orders',
        billingMode: ProductBillingMode.CODING_PLAN,
        status: 'PENDING',
        requestedByAdminId: 'admin-1',
      }),
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).not.toHaveBeenCalled();
    expect(processSpy).not.toHaveBeenCalled();
    expect(result).toEqual(expect.objectContaining({
      id: 'export-job-1',
      status: 'PENDING',
      filename: 'finance-2026-06-ALL-orders.csv',
    }));
  });

  it('creates a distinct export job for every request with the same report scope', async () => {
    const first = makeFinanceExportJob({ id: 'export-job-1' });
    const second = makeFinanceExportJob({ id: 'export-job-2' });
    const { service, prisma } = buildService();
    prisma.financeExportJob.create
      .mockResolvedValueOnce(first)
      .mockResolvedValueOnce(second);

    const params = {
      month: '2026-06',
      tab: 'orders',
      billingMode: 'CODING_PLAN',
      requestedByAdminId: 'admin-1',
    };
    const firstResult = await service.createFinanceReportExportJob(params);
    const secondResult = await service.createFinanceReportExportJob(params);

    expect(prisma.financeExportJob.create).toHaveBeenCalledTimes(2);
    expect(prisma.financeExportJob.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        month: '2026-06',
        tab: 'orders',
        billingMode: ProductBillingMode.CODING_PLAN,
        status: 'PENDING',
        requestedByAdminId: 'admin-1',
      }),
    });
    expect(prisma.financeExportJob.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        month: '2026-06',
        tab: 'orders',
        billingMode: ProductBillingMode.CODING_PLAN,
        status: 'PENDING',
        requestedByAdminId: 'admin-1',
      }),
    });
    expect(firstResult).toEqual(expect.objectContaining({ id: 'export-job-1' }));
    expect(secondResult).toEqual(expect.objectContaining({ id: 'export-job-2' }));
  });

  it('lists finance export jobs without loading CSV content', async () => {
    const { service, prisma } = buildService();
    prisma.financeExportJob.findMany.mockResolvedValue([
      makeFinanceExportJob({ id: 'job-1', fileContent: 'large,csv,content' }),
    ]);

    const result = await service.listFinanceReportExportJobs({ take: 1000 });

    const select = prisma.financeExportJob.findMany.mock.calls[0]?.[0]?.select as Record<string, unknown>;
    expect(prisma.financeExportJob.findMany).toHaveBeenCalledWith(expect.objectContaining({
      orderBy: { createdAt: 'desc' },
      take: 1000,
      select: expect.objectContaining({
        id: true,
        filename: true,
        status: true,
      }),
    }));
    expect(select.fileContent).toBeUndefined();
    expect(result.items).toEqual([
      expect.objectContaining({ id: 'job-1', filename: 'finance-2026-06-ALL-orders.csv' }),
    ]);
    expect(result.items[0]).not.toHaveProperty('fileContent');
  });

  it('gets finance export job metadata without loading CSV content', async () => {
    const { service, prisma } = buildService();
    prisma.financeExportJob.findUnique.mockResolvedValue(
      makeFinanceExportJob({ id: 'job-1', status: 'SUCCEEDED', fileContent: 'large,csv,content' }),
    );

    const result = await service.getFinanceReportExportJob('job-1');

    const select = prisma.financeExportJob.findUnique.mock.calls[0]?.[0]?.select as Record<string, unknown>;
    expect(prisma.financeExportJob.findUnique).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'job-1' },
      select: expect.objectContaining({
        id: true,
        filename: true,
        status: true,
      }),
    }));
    expect(select.fileContent).toBeUndefined();
    expect(result).toEqual(expect.objectContaining({ id: 'job-1', status: 'SUCCEEDED' }));
    expect(result).not.toHaveProperty('fileContent');
  });

  it('downloads a completed filesystem export as a stream', async () => {
    const { service, prisma } = buildService();
    const exportDirectory = await mkdtemp(join(tmpdir(), 'finance-export-download-'));
    const filePath = join(exportDirectory, 'finance.csv');
    const csv = '\uFEFF账期,流水ID\n2026-06,tx-1';
    await writeFile(filePath, csv, 'utf8');
    prisma.financeExportJob.findUnique.mockResolvedValue(makeFinanceExportJob({
      id: 'job-stream',
      status: 'SUCCEEDED',
      filePath,
      fileSizeBytes: BigInt(Buffer.byteLength(csv)),
      fileContent: null,
    }));

    try {
      const result = await service.downloadFinanceReportExportJob('job-stream');
      const chunks: Buffer[] = [];
      for await (const chunk of result.stream!) chunks.push(Buffer.from(chunk));

      expect(result).toEqual(expect.objectContaining({
        filename: 'finance-2026-06-ALL-orders.csv',
        contentType: 'text/csv; charset=utf-8',
        contentLength: Buffer.byteLength(csv),
      }));
      expect(Buffer.concat(chunks).toString('utf8')).toBe(csv);
    } finally {
      await rm(exportDirectory, { recursive: true, force: true });
    }
  });

  it('processes due finance export jobs through the worker entrypoint', async () => {
    const { service, prisma } = buildService();
    prisma.financeExportJob.findMany.mockResolvedValue([{ id: 'job-1' }, { id: 'job-2' }]);
    const processSpy = jest.spyOn(service, 'processFinanceReportExportJob')
      .mockResolvedValueOnce(makeFinanceExportJob({ id: 'job-1', status: 'SUCCEEDED' }) as any)
      .mockResolvedValueOnce(null);

    const result = await service.processDueFinanceReportExportJobs({ batchSize: 5, minAgeMs: 3000 });

    expect(prisma.financeExportJob.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        OR: [
          { status: 'PENDING', createdAt: { lte: expect.any(Date) } },
          {
            status: 'RUNNING',
            OR: [
              { heartbeatAt: { lt: expect.any(Date) } },
              { heartbeatAt: null, startedAt: { lt: expect.any(Date) } },
            ],
          },
        ],
      },
      orderBy: [{ createdAt: 'asc' }],
      take: 5,
      select: { id: true },
    }));
    expect(processSpy).toHaveBeenCalledTimes(2);
    expect(result).toEqual({ processed: 1, succeeded: 1, failed: 0 });
  });

  it('removes expired completed export files and their job rows', async () => {
    const { service, prisma } = buildService();
    const exportDirectory = await mkdtemp(join(tmpdir(), 'finance-export-cleanup-'));
    const filePath = join(exportDirectory, 'expired.csv');
    const originalStorageDirectory = process.env.FINANCE_EXPORT_STORAGE_DIR;
    process.env.FINANCE_EXPORT_STORAGE_DIR = exportDirectory;
    await writeFile(filePath, 'expired', 'utf8');
    prisma.financeExportJob.findMany.mockResolvedValue([
      { id: 'expired-success', filePath },
      { id: 'expired-failure', filePath: null },
    ]);
    prisma.financeExportJob.deleteMany.mockResolvedValue({ count: 1 });
    const now = new Date('2026-06-30T00:00:00Z');

    try {
      await expect(service.cleanupExpiredFinanceReportExportJobs({
        batchSize: 50,
        now,
      })).resolves.toEqual({ cleaned: 2, failed: 0 });

      expect(await readdir(exportDirectory)).toEqual([]);
      expect(prisma.financeExportJob.findMany).toHaveBeenCalledWith({
        where: {
          status: { in: ['SUCCEEDED', 'FAILED'] },
          OR: [
            { expiresAt: { lte: now } },
            {
              expiresAt: null,
              createdAt: { lte: new Date('2026-06-23T00:00:00.000Z') },
            },
          ],
        },
        orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }],
        take: 50,
        select: { id: true, filePath: true },
      });
      expect(prisma.financeExportJob.deleteMany).toHaveBeenCalledTimes(2);
    } finally {
      if (originalStorageDirectory === undefined) delete process.env.FINANCE_EXPORT_STORAGE_DIR;
      else process.env.FINANCE_EXPORT_STORAGE_DIR = originalStorageDirectory;
      await rm(exportDirectory, { recursive: true, force: true });
    }
  });

  it('does not delete an expired job file outside the managed export directory', async () => {
    const { service, prisma } = buildService();
    const exportDirectory = await mkdtemp(join(tmpdir(), 'finance-export-managed-'));
    const outsideDirectory = await mkdtemp(join(tmpdir(), 'finance-export-outside-'));
    const outsidePath = join(outsideDirectory, 'keep.csv');
    const originalStorageDirectory = process.env.FINANCE_EXPORT_STORAGE_DIR;
    process.env.FINANCE_EXPORT_STORAGE_DIR = exportDirectory;
    await writeFile(outsidePath, 'keep', 'utf8');
    prisma.financeExportJob.findMany.mockResolvedValue([
      { id: 'outside-job', filePath: outsidePath },
    ]);

    try {
      await expect(service.cleanupExpiredFinanceReportExportJobs()).resolves.toEqual({
        cleaned: 0,
        failed: 1,
      });
      expect(await readFile(outsidePath, 'utf8')).toBe('keep');
      expect(prisma.financeExportJob.deleteMany).not.toHaveBeenCalled();
    } finally {
      if (originalStorageDirectory === undefined) delete process.env.FINANCE_EXPORT_STORAGE_DIR;
      else process.env.FINANCE_EXPORT_STORAGE_DIR = originalStorageDirectory;
      await rm(exportDirectory, { recursive: true, force: true });
      await rm(outsideDirectory, { recursive: true, force: true });
    }
  });

  it('updates the heartbeat while a long export computes before writing rows', async () => {
    jest.useFakeTimers();
    const { service, prisma } = buildService();
    const originalInterval = process.env.FINANCE_EXPORT_JOB_HEARTBEAT_INTERVAL_MS;
    process.env.FINANCE_EXPORT_JOB_HEARTBEAT_INTERVAL_MS = '1000';
    prisma.financeExportJob.updateMany.mockResolvedValue({ count: 1 });
    let stopHeartbeat: (() => void) | undefined;

    try {
      stopHeartbeat = (service as any).startFinanceExportHeartbeat('job-heartbeat');
      await jest.advanceTimersByTimeAsync(1000);

      expect(prisma.financeExportJob.updateMany).toHaveBeenCalledWith({
        where: { id: 'job-heartbeat', status: 'RUNNING' },
        data: { heartbeatAt: expect.any(Date) },
      });
    } finally {
      stopHeartbeat?.();
      if (originalInterval === undefined) delete process.env.FINANCE_EXPORT_JOB_HEARTBEAT_INTERVAL_MS;
      else process.env.FINANCE_EXPORT_JOB_HEARTBEAT_INTERVAL_MS = originalInterval;
      jest.useRealTimers();
    }
  });

  it('claims finance export jobs before running the heavy export', async () => {
    const { service, prisma } = buildService();
    prisma.financeExportJob.updateMany.mockResolvedValue({ count: 0 });
    const writeSpy = jest.spyOn(service as any, 'writeFinanceExportCsvFile');

    await expect(service.processFinanceReportExportJob('job-1')).resolves.toBeNull();

    expect(prisma.financeExportJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        id: 'job-1',
        OR: [
          { status: 'PENDING' },
          {
            status: 'RUNNING',
            OR: [
              { heartbeatAt: { lt: expect.any(Date) } },
              { heartbeatAt: null, startedAt: { lt: expect.any(Date) } },
            ],
          },
        ],
      },
      data: expect.objectContaining({ status: 'RUNNING', errorMessage: null }),
    }));
    expect(writeSpy).not.toHaveBeenCalled();
  });

  it('writes a regenerated export to one CSV file and persists its file metadata', async () => {
    const { service, prisma } = buildService();
    const running = makeFinanceExportJob({ id: 'job-2', status: 'RUNNING' });
    const csv = '\uFEFForderId\norder-2';
    const exportDirectory = await mkdtemp(join(tmpdir(), 'finance-export-test-'));
    const originalStorageDirectory = process.env.FINANCE_EXPORT_STORAGE_DIR;
    process.env.FINANCE_EXPORT_STORAGE_DIR = exportDirectory;
    prisma.financeExportJob.updateMany.mockResolvedValue({ count: 1 });
    prisma.financeExportJob.findUnique.mockResolvedValue(running);
    prisma.financeExportJob.update.mockResolvedValue({
      ...running,
      status: 'SUCCEEDED',
      rowCount: 1,
      processedRows: 1,
      totalRows: 1,
      filePath: join(exportDirectory, `${running.id}-${running.filename}`),
      fileSizeBytes: BigInt(Buffer.byteLength(csv)),
      fileSha256: 'sha256',
      errorMessage: null,
      finishedAt: new Date('2026-06-15T00:01:00Z'),
    });
    const writeSpy = jest.spyOn(service as any, 'writeFinanceExportCsvFile')
      .mockImplementation(async (params: { path: string }) => {
        await writeFile(params.path, csv, 'utf8');
        return { rowCount: 1, fileSizeBytes: Buffer.byteLength(csv), sha256: 'sha256' };
      });

    try {
      const result = await service.processFinanceReportExportJob(running.id);
      const finalPath = join(exportDirectory, `${running.id}-${running.filename}`);

      expect(writeSpy).toHaveBeenCalledWith(expect.objectContaining({
        id: running.id,
        month: running.month,
        tab: running.tab,
        path: `${finalPath}.tmp`,
      }));
      expect(await readdir(exportDirectory)).toEqual([`${running.id}-${running.filename}`]);
      expect(await readFile(finalPath, 'utf8')).toBe(csv);
      expect(prisma.financeExportJob.update).toHaveBeenCalledWith(expect.objectContaining({
        where: { id: running.id },
        data: expect.objectContaining({
          status: 'SUCCEEDED',
          rowCount: 1,
          processedRows: 1,
          totalRows: 1,
          fileContent: null,
          filePath: finalPath,
          fileSizeBytes: BigInt(Buffer.byteLength(csv)),
          fileSha256: 'sha256',
        }),
      }));
      expect(result).toEqual(expect.objectContaining({
        status: 'SUCCEEDED',
        rowCount: 1,
        fileSizeBytes: Buffer.byteLength(csv),
      }));
    } finally {
      if (originalStorageDirectory === undefined) delete process.env.FINANCE_EXPORT_STORAGE_DIR;
      else process.env.FINANCE_EXPORT_STORAGE_DIR = originalStorageDirectory;
      await rm(exportDirectory, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// listOrders
// ---------------------------------------------------------------------------
describe('BillingAdminService.listOrders', () => {
  it('returns paginated orders', async () => {
    const { service, repo } = buildService();
    repo.findOrders.mockResolvedValue([{ id: 'o1' }]);
    repo.countOrders.mockResolvedValue(1);

    const result = await service.listOrders(1, 10);

    expect(result.items).toEqual([{ id: 'o1' }]);
    expect(result.total).toBe(1);
    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(10);
    expect(result.totalPages).toBe(1);
    expect(repo.findOrders).toHaveBeenCalledWith(0, 10, undefined);
  });

  it('passes filters to repo', async () => {
    const { service, repo } = buildService();
    repo.findOrders.mockResolvedValue([]);
    repo.countOrders.mockResolvedValue(0);

    await service.listOrders(2, 5, { status: 'PAID' });

    expect(repo.findOrders).toHaveBeenCalledWith(5, 5, { status: 'PAID' });
    expect(repo.countOrders).toHaveBeenCalledWith({ status: 'PAID' });
  });

  it('projects the order-bound Coding Plan fulfillment mode', async () => {
    const { service, repo, prisma } = buildService();
    repo.findOrders.mockResolvedValue([{
      id: 'o1',
      product: {
        billingMode: ProductBillingMode.CODING_PLAN,
        codingPlanFulfillmentMode:
          CodingPlanFulfillmentMode.platform_model_package,
      },
    }]);
    repo.countOrders.mockResolvedValue(1);
    prisma.codingPlanEntitlement.findMany.mockResolvedValue([{
      orderId: 'o1',
      fulfillmentMode: CodingPlanFulfillmentMode.provider_resale,
    }]);

    const result = await service.listOrders(1, 10);

    expect(result.items[0]).toMatchObject({
      id: 'o1',
      codingPlanFulfillmentMode:
        CodingPlanFulfillmentMode.provider_resale,
    });
  });

  it('calculates totalPages correctly with multi-page result', async () => {
    const { service, repo } = buildService();
    repo.findOrders.mockResolvedValue([]);
    repo.countOrders.mockResolvedValue(25);

    const result = await service.listOrders(1, 10);

    expect(result.totalPages).toBe(3);
  });
});

describe('BillingAdminService.listRecentOrdersForUser', () => {
  it('returns recent user orders with the limited admin projection', async () => {
    const { service, prisma } = buildService();
    prisma.order.findMany.mockResolvedValue([{ id: 'o1' }]);

    const result = await service.listRecentOrdersForUser('user-1', 5);

    expect(result).toEqual([{ id: 'o1' }]);
    expect(prisma.order.findMany).toHaveBeenCalledWith({
      where: { userId: 'user-1' },
      orderBy: { createdAt: 'desc' },
      take: 5,
      select: {
        id: true,
        amountCents: true,
        status: true,
        createdAt: true,
      },
    });
  });
});

// ---------------------------------------------------------------------------
// getOrderDetail
// ---------------------------------------------------------------------------
describe('BillingAdminService.getOrderDetail', () => {
  it('returns order with related entities', async () => {
    const { service, prisma } = buildService();
    const order = { id: 'o1', user: { id: 'u1', email: 'a@b.com', nickname: 'A' }, plan: { id: 'p1', name: 'Pro' }, boosterPack: null, auditLogs: [] };
    prisma.order.findUnique.mockResolvedValue(order);

    const result = await service.getOrderDetail('o1');

    expect(result).toEqual(order);
    expect(prisma.order.findUnique).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'o1' },
        include: expect.objectContaining({
          product: {
            select: expect.objectContaining({
              codingPlanFulfillmentMode: true,
            }),
          },
        }),
      }),
    );
  });

  it('throws BadRequestException when order not found', async () => {
    const { service, prisma } = buildService();
    prisma.order.findUnique.mockResolvedValue(null);

    await expect(service.getOrderDetail('bad')).rejects.toThrow(BadRequestException);
  });

  it('projects the order-bound fulfillment mode in order details', async () => {
    const { service, prisma } = buildService();
    prisma.order.findUnique.mockResolvedValue({ id: 'o1' });
    prisma.codingPlanEntitlement.findUnique.mockResolvedValue({
      fulfillmentMode: CodingPlanFulfillmentMode.platform_model_package,
    });

    await expect(service.getOrderDetail('o1')).resolves.toEqual({
      id: 'o1',
      codingPlanFulfillmentMode:
        CodingPlanFulfillmentMode.platform_model_package,
    });
  });
});

// ---------------------------------------------------------------------------
// adminCancelOrder
// ---------------------------------------------------------------------------
describe('BillingAdminService.adminCancelOrder', () => {
  it('cancels a PENDING order and writes audit log', async () => {
    const { service, prisma } = buildService();
    withTransactionSupport(prisma);
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    prisma.orderAuditLog.create.mockResolvedValue({});

    await service.adminCancelOrder('o1', 'admin-1', 'test reason');

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'o1', status: OrderStatus.PENDING },
      data: expect.objectContaining({ status: OrderStatus.CANCELLED }),
    });
    expect(prisma.orderAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'o1',
        fromStatus: OrderStatus.PENDING,
        toStatus: OrderStatus.CANCELLED,
        operator: 'admin:admin-1',
        detail: 'test reason',
      }),
    });
  });

  it('uses default detail when reason is not provided', async () => {
    const { service, prisma } = buildService();
    withTransactionSupport(prisma);
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    prisma.orderAuditLog.create.mockResolvedValue({});

    await service.adminCancelOrder('o1', 'admin-1');

    expect(prisma.orderAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ detail: '管理员取消订单' }),
    });
  });

  it('throws BadRequestException when order does not exist', async () => {
    const { service, prisma } = buildService();
    withTransactionSupport(prisma);
    prisma.order.updateMany.mockResolvedValue({ count: 0 });
    prisma.order.findUnique.mockResolvedValue(null);

    await expect(service.adminCancelOrder('bad', 'admin-1')).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequestException with status info when order is not PENDING', async () => {
    const { service, prisma } = buildService();
    withTransactionSupport(prisma);
    prisma.order.updateMany.mockResolvedValue({ count: 0 });
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', status: 'PAID' });

    await expect(service.adminCancelOrder('o1', 'admin-1')).rejects.toThrow(BadRequestException);
  });
});

// ---------------------------------------------------------------------------
// retryFailedOrder
// ---------------------------------------------------------------------------
describe('BillingAdminService.retryFailedOrder', () => {
  it('retries FAILED order and calls paymentService.retryFulfill', async () => {
    const { service, prisma, payment } = buildService();
    withTransactionSupport(prisma);
    prisma.order.updateMany.mockResolvedValue({ count: 1 });
    prisma.orderAuditLog.create.mockResolvedValue({});

    await service.retryFailedOrder('o1', 'admin-1');

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'o1', status: OrderStatus.FAILED, paidAt: { not: null } },
      data: { status: OrderStatus.PAID },
    });
    expect(prisma.orderAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fromStatus: OrderStatus.FAILED,
        toStatus: OrderStatus.PAID,
        operator: 'admin:admin-1',
      }),
    });
    expect(payment.retryFulfill).toHaveBeenCalledWith('o1');
  });

  it('throws BadRequestException when order does not exist', async () => {
    const { service, prisma } = buildService();
    withTransactionSupport(prisma);
    prisma.order.updateMany.mockResolvedValue({ count: 0 });
    prisma.order.findUnique.mockResolvedValue(null);

    await expect(service.retryFailedOrder('bad', 'admin-1')).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequestException with status when order is not FAILED', async () => {
    const { service, prisma } = buildService();
    withTransactionSupport(prisma);
    prisma.order.updateMany.mockResolvedValue({ count: 0 });
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', status: 'PAID' });

    await expect(service.retryFailedOrder('o1', 'admin-1')).rejects.toThrow(BadRequestException);
  });
});

// ---------------------------------------------------------------------------
// refundOrder
// ---------------------------------------------------------------------------
describe('BillingAdminService.refundOrder', () => {
  it('refunds a PAID order', async () => {
    const { service, prisma, payment } = buildService();
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', status: OrderStatus.PAID });
    payment.refundOrder.mockResolvedValue({ refundId: 'ref-1' });

    const result = await service.refundOrder('o1', 'customer request');

    expect(payment.refundOrder).toHaveBeenCalledWith('o1', 'customer request');
    expect(result).toEqual({ refundId: 'ref-1' });
  });

  it('refunds a COMPLETED order', async () => {
    const { service, prisma, payment } = buildService();
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', status: OrderStatus.COMPLETED });
    payment.refundOrder.mockResolvedValue({ refundId: 'ref-2' });

    await service.refundOrder('o1', 'refund request');

    expect(payment.refundOrder).toHaveBeenCalledWith('o1', 'refund request');
  });

  it('throws when orderId is missing', async () => {
    const { service } = buildService();
    await expect(service.refundOrder('', 'reason')).rejects.toThrow(BadRequestException);
  });

  it('throws when reason is missing', async () => {
    const { service } = buildService();
    await expect(service.refundOrder('o1', '')).rejects.toThrow(BadRequestException);
  });

  it('throws when order not found', async () => {
    const { service, prisma } = buildService();
    prisma.order.findUnique.mockResolvedValue(null);

    await expect(service.refundOrder('bad', 'reason')).rejects.toThrow(BadRequestException);
  });

  it('throws when order is in PENDING status', async () => {
    const { service, prisma } = buildService();
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', status: OrderStatus.PENDING });

    await expect(service.refundOrder('o1', 'reason')).rejects.toThrow(BadRequestException);
  });

  it('throws when order is CANCELLED', async () => {
    const { service, prisma } = buildService();
    prisma.order.findUnique.mockResolvedValue({ id: 'o1', status: OrderStatus.CANCELLED });

    await expect(service.refundOrder('o1', 'reason')).rejects.toThrow(BadRequestException);
  });
});

// ---------------------------------------------------------------------------
// listTransactions
// ---------------------------------------------------------------------------
describe('BillingAdminService.listTransactions', () => {
  it('returns paginated transactions', async () => {
    const { service, repo } = buildService();
    repo.findTransactions.mockResolvedValue([
      {
        id: 'tx-1',
        type: 'RECHARGE',
        amountUsd: new Prisma.Decimal('1.23'),
        balanceAfterUsd: new Prisma.Decimal('4.56'),
        tokenUsageId: 'usage-1',
      },
    ]);
    repo.countTransactions.mockResolvedValue(1);

    const result = await service.listTransactions(1, 20);

    expect(result.items[0]).toEqual(expect.objectContaining({
      id: 'tx-1',
      amountCents: 123,
      balanceAfterCents: 456,
      usageId: 'usage-1',
      tokenUsageId: 'usage-1',
    }));
    expect(result.total).toBe(1);
    expect(repo.findTransactions).toHaveBeenCalledWith(0, 20, undefined);
  });

  it('returns CONSUME transaction amounts as positive spend values', async () => {
    const { service, repo } = buildService();
    repo.findTransactions.mockResolvedValue([
      {
        id: 'tx-consume',
        type: 'CONSUME',
        amountUsd: new Prisma.Decimal('-1.23'),
        balanceAfterUsd: new Prisma.Decimal('8.77'),
        tokenUsageId: null,
      },
    ]);
    repo.countTransactions.mockResolvedValue(1);

    const result = await service.listTransactions(1, 20);

    expect(result.items[0]).toEqual(expect.objectContaining({
      id: 'tx-consume',
      amountCents: 123,
      amountUsd: 1.23,
      balanceAfterCents: 877,
    }));
  });
});

// ---------------------------------------------------------------------------
// listPaygAccounts
// ---------------------------------------------------------------------------
describe('BillingAdminService.listPaygAccounts', () => {
  it('lists PAYG tenant accounts before any API key exists', async () => {
    const product = {
      id: 'prod-payg',
      name: 'PAYG',
      slug: 'PAYG',
      billingMode: 'PAY_AS_YOU_GO',
    };
    const tenant = {
      id: 'tenant-1',
      name: 'Burger',
      type: 'personal',
      status: 'active',
      ownerUserId: 'user-1',
      billingAccountId: 'ba_personal_user-1',
      balanceAllowanceUsd: null,
      balanceAllowanceUsedUsd: new Prisma.Decimal(0),
      createdAt: new Date('2026-06-01T00:00:00Z'),
      owner: {
        id: 'user-1',
        email: 'burger@example.com',
        nickname: 'Burger',
      },
    };
    const prismaOverrides = {
      product: {
        findMany: jest.fn().mockResolvedValue([product]),
      },
      tenant: {
        findMany: jest.fn().mockResolvedValue([tenant]),
      },
      apiKey: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      tokenUsage: {
        groupBy: jest.fn(),
      },
      accountWallet: {
        findMany: jest.fn().mockResolvedValue([
          { billingAccountId: 'ba_personal_user-1', balanceUsd: new Prisma.Decimal('5') },
        ]),
      },
    };
    const { service, prisma } = buildService({ prismaOverrides: prismaOverrides as any });

    const result = await service.listPaygAccounts({ page: 1, pageSize: 50 });

    expect(result.items).toMatchObject([
      {
        tenantId: 'tenant-1',
        accountName: 'Burger',
        productId: 'prod-payg',
        productSlug: 'PAYG',
        userEmail: 'burger@example.com',
        keyCount: 0,
        activeKeyCount: 0,
        monthlyCalls: 0,
        monthlyCost: 0,
        walletBalanceCents: 500,
        keys: [],
      },
    ]);
    expect(result.total).toBe(1);
    expect(result.stats.active).toBe(0);
    expect(prismaOverrides.tokenUsage.groupBy).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// getStats / getRevenue / getRevenueOverview
// ---------------------------------------------------------------------------
describe('BillingAdminService — stats & revenue', () => {
  it('getStats delegates to repo', async () => {
    const { service, repo } = buildService();
    repo.getStats.mockResolvedValue({ users: 10 });
    const result = await service.getStats();
    expect(result).toEqual({ users: 10 });
  });

  it('getRevenue delegates to repo', async () => {
    const { service, repo } = buildService();
    repo.getRevenue.mockResolvedValue({ totalRevenue: 50000 });
    const result = await service.getRevenue();
    expect(result).toEqual({ totalRevenue: 50000 });
  });

  it('getRevenueOverview delegates to repo with days param', async () => {
    const { service, repo } = buildService();
    repo.getRevenueOverview.mockResolvedValue([{ date: '2025-01', total: 1000 }]);
    const result = await service.getRevenueOverview(30);
    expect(result).toEqual([{ date: '2025-01', total: 1000 }]);
    expect(repo.getRevenueOverview).toHaveBeenCalledWith(30);
  });
});

// ---------------------------------------------------------------------------
// listPlans / getPlanById
// ---------------------------------------------------------------------------
describe('BillingAdminService — plans', () => {
  it('listPlans delegates to repo', async () => {
    const { service, repo } = buildService();
    repo.findPlans.mockResolvedValue([{ id: 'free' }]);
    const result = await service.listPlans();
    expect(result).toEqual([{
      id: 'free',
      salesLimit: 0,
      reservedSalesCount: 0,
      remainingSales: null,
      soldOut: false,
    }]);
  });

  it('getPlanById returns plan when found', async () => {
    const { service, repo } = buildService();
    repo.findPlanById.mockResolvedValue({ id: 'pro', name: 'Pro' });
    const result = await service.getPlanById('pro');
    // 转售 salesStatus 默认 + 自营 occupiedQuantity(无 productId→null)
    expect(result).toEqual({
      id: 'pro',
      name: 'Pro',
      salesLimit: 0,
      reservedSalesCount: 0,
      remainingSales: null,
      soldOut: false,
      occupiedQuantity: null,
    });
  });

  it('getPlanById throws BadRequestException when not found', async () => {
    const { service, repo } = buildService();
    repo.findPlanById.mockResolvedValue(null);
    await expect(service.getPlanById('missing')).rejects.toThrow(BadRequestException);
  });
});

// ---------------------------------------------------------------------------
// createOrUpdatePlan
// ---------------------------------------------------------------------------
describe('BillingAdminService.createOrUpdatePlan', () => {
  // finding #13：create/update 改为 $transaction + per-plan 锁内写（tx.plan.create/upsert）。
  it('creates a new plan and notifies webhook', async () => {
    const { service, prisma, productSync } = buildService();
    withTransactionSupport(prisma);
    const planData = { id: 'plan-1', name: 'Starter', productId: 'prod-1' };
    prisma.plan.create.mockResolvedValue(planData);
    productSync.notifyProductSaas.mockResolvedValue(undefined);

    const result = await service.createOrUpdatePlan({ name: 'Starter', monthlyCredits: 500 });

    expect(prisma.plan.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ name: 'Starter', monthlyCredits: 500 }),
    });
    expect(result.message).toBe('创建成功');
    expect(result.data).toEqual(planData);
  });

  it('updates existing plan and returns update message', async () => {
    const { service, prisma } = buildService();
    withTransactionSupport(prisma);
    prisma.plan.upsert.mockResolvedValue({ id: 'plan-1', name: 'Updated', productId: null });

    const result = await service.createOrUpdatePlan({ id: 'plan-1', name: 'Updated' });

    expect(prisma.plan.upsert).toHaveBeenCalledWith(
      expect.objectContaining({ where: { id: 'plan-1' } }),
    );
    expect(result.message).toBe('更新成功');
  });

  it('throws BadRequestException when name is empty', async () => {
    const { service } = buildService();
    await expect(service.createOrUpdatePlan({ name: '' })).rejects.toThrow(BadRequestException);
  });

  it('stringifies features array to JSON', async () => {
    const { service, prisma } = buildService();
    withTransactionSupport(prisma);
    prisma.plan.create.mockResolvedValue({ id: 'p1', productId: null, name: 'X' });

    await service.createOrUpdatePlan({ name: 'X', features: ['f1', 'f2'] });

    expect(prisma.plan.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ features: '["f1","f2"]' }),
    });
  });

  it('preserves string features as-is', async () => {
    const { service, prisma } = buildService();
    withTransactionSupport(prisma);
    prisma.plan.create.mockResolvedValue({ id: 'p1', productId: null, name: 'X' });

    await service.createOrUpdatePlan({ name: 'X', features: '["custom"]' });

    expect(prisma.plan.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ features: '["custom"]' }),
    });
  });

  it('applies correct defaults for unset fields', async () => {
    const { service, prisma } = buildService();
    withTransactionSupport(prisma);
    prisma.plan.create.mockResolvedValue({ id: 'p1', productId: null, name: 'X' });

    await service.createOrUpdatePlan({ name: 'X' });

    const callArg = prisma.plan.create.mock.calls[0][0].data;
    expect(callArg.rateLimitRpm).toBe(60);
    expect(callArg.rateLimitTpm).toBe(100000);
    expect(callArg.maxContextWindow).toBe(200000);
    expect(callArg.isActive).toBe(true);
    expect(callArg.isLegacy).toBe(false);
    expect(callArg.sortOrder).toBe(0);
    expect(callArg.validityDays).toBe(30);
  });

  it('persists validityDays when saving a plan', async () => {
    const { service, prisma } = buildService();
    withTransactionSupport(prisma);
    prisma.plan.create.mockResolvedValue({ id: 'p1', productId: null, name: 'X' });

    await service.createOrUpdatePlan({ name: 'X', validityDays: 45 });

    expect(prisma.plan.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ validityDays: 45 }),
    });
  });

  it('自营 CodingPlan 整包保存强制草稿(isActive=false),激活只走 setPlanActive', async () => {
    const { service, prisma } = buildService();
    withTransactionSupport(prisma);
    prisma.product.findUnique.mockResolvedValue({
      billingMode: 'CODING_PLAN',
      codingPlanFulfillmentMode: 'platform_model_package',
    });
    prisma.plan.create.mockResolvedValue({ id: 'p1', productId: 'prod-cp', name: 'CP' });

    await service.createOrUpdatePlan({ name: 'CP', productId: 'prod-cp', isActive: true });

    expect(prisma.plan.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ isActive: false }),
    });
  });
});

// ---------------------------------------------------------------------------
// setPlanActive — 自营上架零值守卫（价格/月度积分）
// ---------------------------------------------------------------------------
describe('BillingAdminService.setPlanActive 自营上架零值守卫', () => {
  function primeSelfOp(
    prisma: ReturnType<typeof makePrisma>,
    planOverrides: Record<string, unknown> = {},
  ) {
    withTransactionSupport(prisma);
    (prisma.modelAccess as any).count = jest.fn().mockResolvedValue(1);
    (prisma.planQuotaRule as any).count = jest.fn().mockResolvedValue(1);
    // 限量售卖 occupied 计数默认空（0 已占）；用例可覆盖。
    (prisma as any).codingPlanEntitlement = { findMany: jest.fn().mockResolvedValue([]) };
    (prisma.order as any).findMany = jest.fn().mockResolvedValue([]);
    prisma.plan.findFirst.mockResolvedValue({
      id: 'plan-cp',
      productId: 'prod-cp',
      features: '[]',
      billingPeriod: 'monthly',
      monthlyPrice: 9900,
      quarterlyPrice: 0,
      yearlyPrice: 0,
      monthlyCredits: 3000,
      product: { billingMode: 'CODING_PLAN', codingPlanFulfillmentMode: 'platform_model_package' },
      ...planOverrides,
    });
    prisma.plan.update.mockResolvedValue({ id: 'plan-cp', productId: 'prod-cp', isActive: true });
  }

  it('自营 billingPeriod 周期价为 0 → 拒绝上架', async () => {
    const { service, prisma } = buildService();
    primeSelfOp(prisma, { monthlyPrice: 0, yearlyPrice: 19900 }); // 月付周期但月价 0（年价>0 不放行）
    await expect(service.setPlanActive('plan-cp', true)).rejects.toThrow('必须设置大于 0 的售价');
    expect(prisma.plan.update).not.toHaveBeenCalled();
  });

  it('自营 月度积分为 0 → 拒绝上架', async () => {
    const { service, prisma } = buildService();
    primeSelfOp(prisma, { monthlyCredits: 0 });
    await expect(service.setPlanActive('plan-cp', true)).rejects.toThrow('月度积分必须大于 0');
    expect(prisma.plan.update).not.toHaveBeenCalled();
  });

  it('自营 价格与月度积分均>0 → 允许上架', async () => {
    const { service, prisma } = buildService();
    primeSelfOp(prisma);
    await service.setPlanActive('plan-cp', true);
    expect(prisma.plan.update).toHaveBeenCalledWith({
      where: { id: 'plan-cp' },
      data: { isActive: true },
    });
  });

  it('自营 按 billingPeriod=yearly 校验年价', async () => {
    const { service, prisma } = buildService();
    primeSelfOp(prisma, { billingPeriod: 'yearly', monthlyPrice: 0, yearlyPrice: 99900 });
    await service.setPlanActive('plan-cp', true);
    expect(prisma.plan.update).toHaveBeenCalled();
  });

  it('自营 限量：cap ≥ 已占份数 → 允许上架', async () => {
    const { service, prisma } = buildService();
    primeSelfOp(prisma, { maxSellableQuantity: 5 });
    // 2 个不同 tenant 持 ACTIVE + 1 个在途(去重后 2)，cap=5 ≥ 2 → 通过
    (prisma as any).codingPlanEntitlement.findMany.mockResolvedValue([
      { tenantId: 't1' }, { tenantId: 't2' },
    ]);
    (prisma.order as any).findMany.mockResolvedValue([{ tenantId: 't1' }]);
    await service.setPlanActive('plan-cp', true);
    expect(prisma.plan.update).toHaveBeenCalled();
  });

  it('自营 限量：cap < 已占份数 → 拒绝上架', async () => {
    const { service, prisma } = buildService();
    primeSelfOp(prisma, { maxSellableQuantity: 1 });
    (prisma as any).codingPlanEntitlement.findMany.mockResolvedValue([
      { tenantId: 't1' }, { tenantId: 't2' },
    ]);
    (prisma.order as any).findMany.mockResolvedValue([]);
    await expect(service.setPlanActive('plan-cp', true)).rejects.toThrow('不能小于当前已占份数');
    expect(prisma.plan.update).not.toHaveBeenCalled();
  });

  it('转售套餐不进零值守卫（价格/积分为 0 仍可上架）', async () => {
    const { service, prisma } = buildService();
    primeSelfOp(prisma, {
      monthlyPrice: 0,
      monthlyCredits: 0,
      product: { billingMode: 'CODING_PLAN', codingPlanFulfillmentMode: 'provider_resale' },
    });
    await service.setPlanActive('plan-cp', true);
    expect(prisma.plan.update).toHaveBeenCalledWith({
      where: { id: 'plan-cp' },
      data: { isActive: true },
    });
  });

  it('转售套餐完全不进自营守卫（0 模型/0 配额模板/0 价/0 积分仍可上架，codex 红线）', async () => {
    const { service, prisma } = buildService();
    primeSelfOp(prisma, {
      monthlyPrice: 0,
      monthlyCredits: 0,
      product: { billingMode: 'CODING_PLAN', codingPlanFulfillmentMode: 'provider_resale' },
    });
    (prisma.modelAccess as any).count = jest.fn().mockResolvedValue(0);
    (prisma.planQuotaRule as any).count = jest.fn().mockResolvedValue(0);
    await service.setPlanActive('plan-cp', true);
    expect(prisma.plan.update).toHaveBeenCalledWith({
      where: { id: 'plan-cp' },
      data: { isActive: true },
    });
  });

  it('非 CodingPlan 通用 SUBSCRIPTION 套餐不受自营价格/积分/模型守卫影响', async () => {
    const { service, prisma } = buildService();
    primeSelfOp(prisma, {
      monthlyPrice: 0,
      monthlyCredits: 0,
      product: { billingMode: 'SUBSCRIPTION', codingPlanFulfillmentMode: null },
    });
    (prisma.modelAccess as any).count = jest.fn().mockResolvedValue(0);
    (prisma.planQuotaRule as any).count = jest.fn().mockResolvedValue(0);
    await service.setPlanActive('plan-cp', true);
    expect(prisma.plan.update).toHaveBeenCalledWith({
      where: { id: 'plan-cp' },
      data: { isActive: true },
    });
  });

  it('下架(isActive=false)不校验零值', async () => {
    const { service, prisma } = buildService();
    primeSelfOp(prisma, { monthlyPrice: 0, monthlyCredits: 0 });
    await service.setPlanActive('plan-cp', false);
    expect(prisma.plan.update).toHaveBeenCalledWith({
      where: { id: 'plan-cp' },
      data: { isActive: false },
    });
  });
});

// ---------------------------------------------------------------------------
// saveCodingPlanResalePlan
// ---------------------------------------------------------------------------
describe('BillingAdminService.saveCodingPlanResalePlan', () => {
  function mockResaleTargets(prisma: ReturnType<typeof makePrisma>) {
    prisma.product.findFirst.mockResolvedValue({
      id: 'product-resale',
      slug: 'coding-resale',
      billingMode: ProductBillingMode.CODING_PLAN,
      codingPlanFulfillmentMode: CodingPlanFulfillmentMode.provider_resale,
      isActive: true,
    });
    prisma.codingPlanProviderLine.findUnique.mockResolvedValue({
      id: 'line-1',
      code: 'zhipu-primary',
      providerCode: 'zhipu',
      providerAccountIdentityId: 'identity-zhipu-main',
      adapterType: 'zhipu_partner',
      salesEnabled: true,
      fulfillmentEnabled: true,
    });
    prisma.codingPlanProviderProduct.findUnique.mockResolvedValue({
      id: 'provider-product-1',
      status: 'ACTIVE',
    });
  }

  it('creates plan, price and resale route in one transaction', async () => {
    const { service, prisma } = buildService({
      systemConfigOverrides: {
        getDeploymentConfig: jest.fn().mockResolvedValue({ currency: 'cny', region: 'domestic' }),
      },
    });
    withTransactionSupport(prisma);
    mockResaleTargets(prisma);
    prisma.plan.create.mockResolvedValue({
      id: 'plan-resale',
      productId: 'product-resale',
      name: 'Vendor Pro',
    });
    prisma.codingPlanResaleRoute.findMany.mockResolvedValue([]);
    prisma.codingPlanResaleRoute.create.mockResolvedValue({
      id: 'route-1',
      planId: 'plan-resale',
      providerLineId: 'line-1',
      upstreamProductId: 'upstream-pro',
      enabled: true,
      priority: 100,
    });

    const result = await service.saveCodingPlanResalePlan(null, {
      productId: 'product-resale',
      name: 'Vendor Pro',
      monthlyPrice: 19900,
      quarterlyPrice: 17900,
      yearlyPrice: 15900,
      providerLineId: 'line-1',
      upstreamProductId: 'upstream-pro',
      isActive: true,
      salesLimit: 3,
      routeMarket: 'global',
      routeCurrency: 'USD',
      routeSalesChannel: 'web',
      routeUserSegmentId: 'seg-vip',
      routeStartAt: '2026-01-01T00:00:00.000Z',
      routeEndAt: '2026-12-31T00:00:00.000Z',
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.plan.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        productId: 'product-resale',
        name: 'Vendor Pro',
        planType: 'coding_plan',
        features: '[]',
        monthlyCredits: 0,
        rateLimitRpm: 0,
        rateLimitTpm: 0,
        maxContextWindow: 0,
        salesLimit: 3,
      }),
    });
    expect(prisma.modelAccess.deleteMany).toHaveBeenCalledWith({ where: { planId: 'plan-resale' } });
    expect(prisma.modelRoutePolicy.deleteMany).toHaveBeenCalledWith({ where: { planId: 'plan-resale' } });
    expect(prisma.planQuotaRule.deleteMany).toHaveBeenCalledWith({ where: { planId: 'plan-resale' } });
    expect(prisma.planPrice.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { planId_currency: { planId: 'plan-resale', currency: 'cny' } },
      create: expect.objectContaining({ monthlyPrice: 19900, isActive: true }),
    }));
    expect(prisma.codingPlanResaleRoute.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        planId: 'plan-resale',
        providerLineId: 'line-1',
        upstreamProductId: 'upstream-pro',
        enabled: true,
        market: 'global',
        currency: 'usd',
        salesChannel: 'web',
        userSegmentId: 'seg-vip',
        startAt: new Date('2026-01-01T00:00:00.000Z'),
        endAt: new Date('2026-12-31T00:00:00.000Z'),
      }),
    });
    expect(result).toMatchObject({
      id: 'plan-resale',
      productId: 'product-resale',
      fulfillmentMode: CodingPlanFulfillmentMode.provider_resale,
    });
  });

  it('creates a provider-resale plan with multiple shared upstream line routes', async () => {
    const { service, prisma } = buildService();
    withTransactionSupport(prisma);
    prisma.product.findFirst.mockResolvedValue({
      id: 'product-resale',
      slug: 'coding-resale',
      billingMode: ProductBillingMode.CODING_PLAN,
      codingPlanFulfillmentMode: CodingPlanFulfillmentMode.provider_resale,
      isActive: true,
    });
    prisma.codingPlanProviderLine.findUnique.mockImplementation(({ where }: any) => Promise.resolve({
      id: where.id,
      code: where.id,
      providerCode: 'zhipu',
      providerAccountIdentityId: 'identity-zhipu-main',
      adapterType: 'zhipu_partner',
      salesEnabled: true,
      fulfillmentEnabled: true,
    }));
    prisma.codingPlanProviderProduct.findUnique.mockImplementation(({ where }: any) => Promise.resolve({
      id: `provider-product-${where.providerLineId_upstreamProductId.providerLineId}`,
      status: 'ACTIVE',
    }));
    prisma.plan.create.mockResolvedValue({
      id: 'plan-resale',
      productId: 'product-resale',
      name: 'GLM Coding Plan',
    });
    prisma.codingPlanResaleRoute.findFirst.mockResolvedValue(null);
    prisma.codingPlanResaleRoute.create.mockImplementation(({ data }: any) => Promise.resolve({
      id: `route-${data.providerLineId}`,
      ...data,
    }));

    const result = await service.saveCodingPlanResalePlan(null, {
      productId: 'product-resale',
      name: 'GLM Coding Plan',
      currency: 'usd',
      monthlyPrice: 19900,
      routes: [
        {
          providerLineId: 'line-zhipu-anthropic',
          upstreamProductId: 'glm-coding-pro',
          routePriority: 100,
        },
        {
          providerLineId: 'line-zhipu-openai',
          upstreamProductId: 'glm-coding-pro',
          routePriority: 100,
        },
      ],
    });

    expect(prisma.codingPlanResaleRoute.create).toHaveBeenCalledTimes(2);
    expect(prisma.codingPlanResaleRoute.create).toHaveBeenNthCalledWith(1, {
      data: expect.objectContaining({
        planId: 'plan-resale',
        providerLineId: 'line-zhipu-anthropic',
        upstreamProductId: 'glm-coding-pro',
        priority: 100,
      }),
    });
    expect(prisma.codingPlanResaleRoute.create).toHaveBeenNthCalledWith(2, {
      data: expect.objectContaining({
        planId: 'plan-resale',
        providerLineId: 'line-zhipu-openai',
        upstreamProductId: 'glm-coding-pro',
        priority: 100,
      }),
    });
    expect(prisma.codingPlanResaleRoute.deleteMany).toHaveBeenCalledWith({
      where: {
        planId: 'plan-resale',
        id: { notIn: ['route-line-zhipu-anthropic', 'route-line-zhipu-openai'] },
      },
    });
    expect(result.routes).toHaveLength(2);
  });

  it('rejects an active multi-line resale group backed by different provider accounts', async () => {
    const { service, prisma } = buildService();
    withTransactionSupport(prisma);
    prisma.product.findFirst.mockResolvedValue({
      id: 'product-resale',
      slug: 'coding-resale',
      billingMode: ProductBillingMode.CODING_PLAN,
      codingPlanFulfillmentMode: CodingPlanFulfillmentMode.provider_resale,
      isActive: true,
    });
    prisma.codingPlanProviderLine.findUnique.mockImplementation(({ where }: any) => Promise.resolve({
      id: where.id,
      code: where.id,
      providerCode: 'zhipu',
      providerAccountIdentityId: where.id === 'line-primary'
        ? 'identity-zhipu-primary'
        : 'identity-zhipu-secondary',
      adapterType: 'zhipu_partner',
      salesEnabled: true,
      fulfillmentEnabled: true,
    }));
    prisma.codingPlanProviderProduct.findUnique.mockResolvedValue({
      id: 'provider-product',
      status: 'ACTIVE',
    });

    await expect(service.saveCodingPlanResalePlan(null, {
      productId: 'product-resale',
      name: 'Invalid multi-account plan',
      routes: [
        { providerLineId: 'line-primary', upstreamProductId: 'glm-coding-pro' },
        { providerLineId: 'line-runtime', upstreamProductId: 'glm-coding-pro' },
      ],
      isActive: true,
    })).rejects.toThrow('必须共享同一供应商账户身份');
    expect(prisma.plan.create).not.toHaveBeenCalled();
    expect(prisma.codingPlanResaleRoute.create).not.toHaveBeenCalled();
  });

  it('rejects an active resale plan whose primary line has no provider account identity', async () => {
    const { service, prisma } = buildService();
    withTransactionSupport(prisma);
    mockResaleTargets(prisma);
    prisma.codingPlanProviderLine.findUnique.mockResolvedValue({
      id: 'line-1',
      code: 'zhipu-primary',
      providerCode: 'zhipu',
      providerAccountIdentityId: null,
      adapterType: 'zhipu_partner',
      salesEnabled: true,
      fulfillmentEnabled: true,
    });

    await expect(service.saveCodingPlanResalePlan(null, {
      productId: 'product-resale',
      name: 'Unbound active plan',
      providerLineId: 'line-1',
      upstreamProductId: 'glm-coding-pro',
      isActive: true,
    })).rejects.toThrow('主线路未绑定供应商账户身份');
    expect(prisma.plan.create).not.toHaveBeenCalled();
  });

  it('rejects products that are not provider_resale CodingPlan products', async () => {
    const { service, prisma } = buildService();
    withTransactionSupport(prisma);
    prisma.product.findFirst.mockResolvedValue({
      id: 'product-self',
      billingMode: ProductBillingMode.CODING_PLAN,
      codingPlanFulfillmentMode: CodingPlanFulfillmentMode.platform_model_package,
      isActive: true,
    });
    prisma.codingPlanProviderLine.findUnique.mockResolvedValue({
      id: 'line-1',
      salesEnabled: true,
      fulfillmentEnabled: true,
    });
    prisma.codingPlanProviderProduct.findUnique.mockResolvedValue({
      id: 'provider-product-1',
      status: 'ACTIVE',
    });

    await expect(service.saveCodingPlanResalePlan(null, {
      productId: 'product-self',
      name: 'Vendor Pro',
      currency: 'usd',
      providerLineId: 'line-1',
      upstreamProductId: 'upstream-pro',
    })).rejects.toThrow('三方转售套餐必须绑定 provider_resale 产品');
    expect(prisma.plan.create).not.toHaveBeenCalled();
  });

  it('rejects resale route windows with endAt before startAt', async () => {
    const { service } = buildService();

    await expect(service.saveCodingPlanResalePlan(null, {
      productId: 'product-resale',
      name: 'Vendor Pro',
      currency: 'usd',
      providerLineId: 'line-1',
      upstreamProductId: 'upstream-pro',
      routeStartAt: '2026-12-31T00:00:00.000Z',
      routeEndAt: '2026-01-01T00:00:00.000Z',
    })).rejects.toThrow('routeEndAt 必须晚于 routeStartAt');
  });

  it('rejects ambiguous route updates when routeId is omitted', async () => {
    const { service, prisma } = buildService();
    withTransactionSupport(prisma);
    mockResaleTargets(prisma);
    prisma.plan.findUnique.mockResolvedValue({ id: 'plan-resale', productId: 'product-resale' });
    prisma.plan.update.mockResolvedValue({
      id: 'plan-resale',
      productId: 'product-resale',
      name: 'Vendor Pro',
    });
    prisma.codingPlanResaleRoute.findMany.mockResolvedValue([{ id: 'route-1' }, { id: 'route-2' }]);

    await expect(service.saveCodingPlanResalePlan('plan-resale', {
      productId: 'product-resale',
      name: 'Vendor Pro',
      currency: 'usd',
      providerLineId: 'line-1',
      upstreamProductId: 'upstream-pro',
    })).rejects.toThrow('当前套餐存在多个转售映射');
    expect(prisma.codingPlanResaleRoute.update).not.toHaveBeenCalled();
    expect(prisma.codingPlanResaleRoute.create).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// updatePlan
// ---------------------------------------------------------------------------
describe('BillingAdminService.updatePlan', () => {
  // finding #13：updatePlan 改为 $transaction + per-plan 锁内 tx.plan.update。
  it('updates allowed fields and filters out id/createdAt/updatedAt', async () => {
    const { service, prisma } = buildService();
    withTransactionSupport(prisma);
    prisma.plan.update.mockResolvedValue({ id: 'plan-1', name: 'New Name' });

    const result = await service.updatePlan('plan-1', {
      id: 'plan-1',
      name: 'New Name',
      createdAt: '2025-01-01',
      updatedAt: '2025-01-02',
      isActive: false,
      validityDays: 45,
      salesLimit: 12,
    });

    const callArg = prisma.plan.update.mock.calls[0][0].data;
    expect(callArg.id).toBeUndefined();
    expect(callArg.createdAt).toBeUndefined();
    expect(callArg.updatedAt).toBeUndefined();
    expect(callArg.name).toBe('New Name');
    expect(callArg.isActive).toBe(false);
    expect(callArg.validityDays).toBe(45);
    expect(callArg.salesLimit).toBe(12);
    expect(result).toEqual({ id: 'plan-1', name: 'New Name' });
  });

  it('stringifies features object', async () => {
    const { service, prisma } = buildService();
    withTransactionSupport(prisma);
    prisma.plan.update.mockResolvedValue({ id: 'p1' });

    await service.updatePlan('plan-1', { features: ['a', 'b'] });

    const callArg = prisma.plan.update.mock.calls[0][0].data;
    expect(callArg.features).toBe('["a","b"]');
  });

  it('preserves features string value', async () => {
    const { service, prisma } = buildService();
    withTransactionSupport(prisma);
    prisma.plan.update.mockResolvedValue({ id: 'p1' });

    await service.updatePlan('plan-1', { features: '["existing"]' });

    const callArg = prisma.plan.update.mock.calls[0][0].data;
    expect(callArg.features).toBe('["existing"]');
  });

  it('ignores fields not in the allowed list', async () => {
    const { service, prisma } = buildService();
    withTransactionSupport(prisma);
    prisma.plan.update.mockResolvedValue({ id: 'p1' });

    await service.updatePlan('plan-1', { dangerousField: 'DROP TABLE plans;' } as any);

    const callArg = prisma.plan.update.mock.calls[0][0].data;
    expect(callArg.dangerousField).toBeUndefined();
  });

  it('自营 CodingPlan 经 updatePlan 直写 isActive:true 被强制草稿(激活只走 setPlanActive)', async () => {
    const { service, prisma } = buildService();
    withTransactionSupport(prisma);
    prisma.plan.findUnique.mockResolvedValue({ productId: 'prod-cp', features: '[]', isActive: false });
    prisma.product.findUnique.mockResolvedValue({
      billingMode: 'CODING_PLAN',
      codingPlanFulfillmentMode: 'platform_model_package',
    });
    prisma.plan.update.mockResolvedValue({ id: 'plan-1' });

    await service.updatePlan('plan-1', { isActive: true });

    const callArg = prisma.plan.update.mock.calls[0][0].data;
    expect(callArg.isActive).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// deletePlan
// ---------------------------------------------------------------------------
describe('BillingAdminService.deletePlan', () => {
  const mockPlanReferenceCounts = (
    prisma: ReturnType<typeof makePrisma>,
    counts: Partial<{
      order: number;
      orderItem: number;
      subscription: number;
      bundleItem: number;
      campaign: number;
      discountCode: number;
      defaultProduct: number;
      entitlement: number;
    }> = {},
  ) => {
    prisma.order.count.mockResolvedValue(counts.order ?? 0);
    prisma.orderItem.count.mockResolvedValue(counts.orderItem ?? 0);
    prisma.subscriptionPeriod.count.mockResolvedValue(counts.subscription ?? 0);
    prisma.bundleSkuItem.count.mockResolvedValue(counts.bundleItem ?? 0);
    prisma.campaign.count.mockResolvedValue(counts.campaign ?? 0);
    prisma.discountCode.count.mockResolvedValue(counts.discountCode ?? 0);
    prisma.product.count.mockResolvedValue(counts.defaultProduct ?? 0);
    prisma.tenantProductEntitlement.count.mockResolvedValue(counts.entitlement ?? 0);
  };

  it('soft deletes an unreferenced plan', async () => {
    const { service, prisma } = buildService();
    withTransactionSupport(prisma);
    prisma.plan.findFirst.mockResolvedValue({ id: 'plan-1', productId: 'prod-1' });
    prisma.plan.update.mockResolvedValue({ id: 'plan-1', productId: 'prod-1' });
    prisma.codingPlanResaleRoute.deleteMany.mockResolvedValue({ count: 2 });
    mockPlanReferenceCounts(prisma);

    const result = await service.deletePlan('plan-1');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.plan.findFirst).toHaveBeenCalledWith({
      where: { id: 'plan-1', deletedAt: null },
      select: { id: true, productId: true },
    });
    expect(prisma.order.count).toHaveBeenCalledWith({ where: { planId: 'plan-1' } });
    expect(prisma.subscriptionPeriod.count).toHaveBeenCalledWith({ where: { planId: 'plan-1' } });
    expect(prisma.product.count).toHaveBeenCalledWith({
      where: { defaultPlanId: 'plan-1', deletedAt: null },
    });
    expect(prisma.discountCode.count).toHaveBeenCalledWith({
      where: { planIdsJson: { contains: '"plan-1"' } },
    });
    expect(prisma.codingPlanResaleRoute.deleteMany).toHaveBeenCalledWith({
      where: { planId: 'plan-1' },
    });
    expect(prisma.plan.update).toHaveBeenCalledWith({
      where: { id: 'plan-1' },
      data: {
        deletedAt: expect.any(Date),
        isActive: false,
        isLegacy: true,
      },
      select: { id: true, productId: true },
    });
    expect(result).toEqual({ deleted: true, id: 'plan-1' });
  });

  it('blocks deletion when the plan has business references', async () => {
    const { service, prisma } = buildService();
    withTransactionSupport(prisma);
    prisma.plan.findFirst.mockResolvedValue({ id: 'plan-1', productId: 'prod-1' });
    mockPlanReferenceCounts(prisma, { order: 1, subscription: 1 });

    await expect(service.deletePlan('plan-1')).rejects.toThrow(BadRequestException);
    expect(prisma.codingPlanResaleRoute.deleteMany).not.toHaveBeenCalled();
    expect(prisma.plan.update).not.toHaveBeenCalled();
  });

  it('throws when plan does not exist', async () => {
    const { service, prisma } = buildService();
    withTransactionSupport(prisma);
    prisma.plan.findFirst.mockResolvedValue(null);

    await expect(service.deletePlan('missing')).rejects.toThrow(BadRequestException);
    expect(prisma.order.count).not.toHaveBeenCalled();
    expect(prisma.codingPlanResaleRoute.deleteMany).not.toHaveBeenCalled();
    expect(prisma.plan.update).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// notifyProductWebhook (via createOrUpdatePlan)
// ---------------------------------------------------------------------------
describe('BillingAdminService — webhook notification', () => {
  it('does not throw when product is not found in webhook notification', async () => {
    const { service, repo, prisma, productSync } = buildService();
    withTransactionSupport(prisma);
    prisma.plan.create.mockResolvedValue({ id: 'p1', name: 'X', productId: 'prod-1' });
    repo.findProductById.mockResolvedValue(null);

    await expect(service.createOrUpdatePlan({ name: 'X' })).resolves.toBeDefined();
    // Fire-and-forget; no error should propagate
    expect(productSync.notifyProductSaas).not.toHaveBeenCalled();
  });

  it('does not throw when productId is null', async () => {
    const { service, prisma } = buildService();
    withTransactionSupport(prisma);
    prisma.plan.create.mockResolvedValue({ id: 'p1', name: 'X', productId: null });

    await expect(service.createOrUpdatePlan({ name: 'X' })).resolves.toBeDefined();
  });
});

// ---------------------------------------------------------------------------
// Bundle SKU CRUD
// ---------------------------------------------------------------------------
describe('BillingAdminService — bundle SKUs', () => {
  it('creates a mixed bundle SKU with computed totals and nested items', async () => {
    const { service, prisma } = buildService({
      systemConfigOverrides: {
        getDeploymentConfig: jest.fn().mockResolvedValue({ currency: 'cny', region: 'domestic' }),
      },
      prismaOverrides: {
        product: {
          findMany: jest.fn().mockResolvedValue([{ id: 'prod-1', name: 'Product' }]),
        } as any,
        plan: {
          findMany: jest.fn().mockResolvedValue([{ id: 'plan-1', name: 'Plan', productId: 'prod-1' }]),
        } as any,
        boosterPack: {
          findMany: jest.fn().mockResolvedValue([{ id: 'pack-1', name: 'Pack', productId: 'prod-1' }]),
        } as any,
        bundleSku: {
          create: jest.fn().mockResolvedValue({ id: 'bundle-1' }),
        } as any,
      },
    });

    const result = await service.createBundleSku({
      code: 'bundle-blackfriday',
      name: 'Black Friday Bundle',
      items: [
        {
          productId: 'prod-1',
          planId: 'plan-1',
          billingType: 'SUBSCRIPTION',
          recurringInterval: 'year',
          unitAmountCents: 5000,
          originalUnitAmountCents: 12000,
        },
        {
          productId: 'prod-1',
          boosterPackId: 'pack-1',
          billingType: 'ONE_TIME',
          unitAmountCents: 2000,
          originalUnitAmountCents: 3000,
        },
      ],
    });

    expect(result).toEqual({ id: 'bundle-1' });
    expect(prisma.bundleSku.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          code: 'bundle-blackfriday',
          amountCents: 7000,
          originalAmountCents: 15000,
          currency: 'cny',
          items: expect.objectContaining({
            create: expect.arrayContaining([
              expect.objectContaining({ billingType: 'SUBSCRIPTION', unitAmountCents: 5000 }),
              expect.objectContaining({ billingType: 'ONE_TIME', unitAmountCents: 2000 }),
            ]),
          }),
        }),
      }),
    );
  });

  it('soft disables bundle SKU when orders already exist', async () => {
    const { service, prisma } = buildService({
      prismaOverrides: {
        bundleSku: {
          findUnique: jest.fn().mockResolvedValue({ id: 'bundle-1' }),
          update: jest.fn().mockResolvedValue({ id: 'bundle-1', isActive: false }),
          delete: jest.fn(),
        } as any,
        order: {
          count: jest.fn().mockResolvedValue(1),
        } as any,
      },
    });

    const result = await service.deleteBundleSku('bundle-1');

    expect(result).toEqual({ deleted: false, disabled: true });
    expect(prisma.bundleSku.update).toHaveBeenCalledWith({
      where: { id: 'bundle-1' },
      data: { isActive: false },
    });
    expect(prisma.bundleSku.delete).not.toHaveBeenCalled();
  });
});
