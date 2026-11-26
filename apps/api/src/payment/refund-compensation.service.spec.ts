import {
  AlertEventCategory,
  AlertEventSeverity,
  CodingPlanEntitlementStatus,
  CodingPlanFulfillmentMode,
  OrderItemStatus,
  OrderStatus,
  OrderType as PrismaOrderType,
  PayChannel,
  Prisma,
  RefundCompensationTaskAction,
  RefundCompensationTaskStatus,
} from '@prisma/client';
import { RefundCompensationService, type RefundableOrder } from './refund-compensation.service';

type TaskRow = {
  id: string;
  orderId: string;
  orderItemId: string | null;
  taskKey: string;
  action: RefundCompensationTaskAction;
  status: RefundCompensationTaskStatus;
  sequence: number;
  userId: string;
  tenantId: string | null;
  productId: string | null;
  planId: string | null;
  amountCents: number | null;
  creditsAmount: number | null;
  payload: Prisma.JsonValue | null;
  attempts: number;
  maxAttempts: number;
  nextRunAt: Date;
  lockedAt: Date | null;
  lockedBy: string | null;
  lastError: string | null;
  completedAt: Date | null;
  createdAt: Date;
  updatedAt: Date;
};

function taskMatches(task: TaskRow, where: any): boolean {
  if (!where) return true;
  if (where.id !== undefined && task.id !== where.id) return false;
  if (where.orderId !== undefined && task.orderId !== where.orderId) return false;
  if (where.lockedBy !== undefined && task.lockedBy !== where.lockedBy) return false;
  if (
    where.updatedAt instanceof Date
    && task.updatedAt.getTime() !== where.updatedAt.getTime()
  ) {
    return false;
  }
  if (where.status !== undefined) {
    if (typeof where.status === 'string' && task.status !== where.status) return false;
    if (where.status.in && !where.status.in.includes(task.status)) return false;
  }
  if (where.nextRunAt?.lte && task.nextRunAt > where.nextRunAt.lte) return false;
  if (where.lockedAt?.lt) {
    if (!task.lockedAt || task.lockedAt >= where.lockedAt.lt) return false;
  }
  if (where.OR && !where.OR.some((branch: any) => taskMatches(task, branch))) return false;
  return true;
}

function applyTaskData(task: TaskRow, data: any): void {
  for (const [key, value] of Object.entries(data)) {
    if (value && typeof value === 'object' && 'increment' in value) {
      (task as any)[key] += (value as { increment: number }).increment;
    } else {
      (task as any)[key] = value;
    }
  }
  task.updatedAt = new Date();
}

function makeOrder(overrides: Partial<RefundableOrder> = {}): RefundableOrder {
  return {
    id: 'order-1',
    userId: 'user-1',
    tenantId: 'tenant-1',
    billingAccountId: null,
    orderType: PrismaOrderType.SUBSCRIPTION,
    bundleSkuId: null,
    productId: 'prod-1',
    planId: 'plan-1',
    boosterPackId: null,
    amountCents: 10000,
    originalAmountCents: 10000,
    discountAmountCents: null,
    currency: 'usd',
    billingPeriod: null,
    prorationCreditCents: null,
    rechargeTierId: null,
    bonusCents: null,
    status: OrderStatus.REFUNDING,
    channel: null,
    tradeNo: null,
    paymentProviderInstanceId: null,
    refundReason: null,
    refundAmountCents: null,
    paidAt: new Date('2026-01-01T00:00:00Z'),
    completedAt: null,
    expiredAt: null,
    cancelledAt: null,
    refundedAt: null,
    fulfillmentAttemptId: null,
    fulfillmentClaimedAt: null,
    idempotencyKey: null,
    idempotencyFingerprint: null,
    createdAt: new Date('2026-01-01T00:00:00Z'),
    updatedAt: new Date('2026-01-01T00:00:00Z'),
    plan: {
      id: 'plan-1',
      productId: 'prod-1',
      name: 'Pro',
      description: null,
      monthlyCredits: 500,
      features: null,
      monthlyPrice: 10000,
      yearlyPrice: 100000,
      isActive: true,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    } as any,
    boosterPack: null,
    items: [],
    ...overrides,
  } as RefundableOrder;
}

function makeTaskRow(overrides: Partial<TaskRow> = {}): TaskRow {
  const now = new Date();
  return {
    id: 'task-1',
    orderId: 'order-1',
    orderItemId: null,
    taskKey: 'refund:order-1:test',
    action: RefundCompensationTaskAction.NOTIFY_CREDIT_CHANGED,
    status: RefundCompensationTaskStatus.PENDING,
    sequence: 10,
    userId: 'user-1',
    tenantId: 'tenant-1',
    productId: 'prod-1',
    planId: null,
    amountCents: null,
    creditsAmount: null,
    payload: null,
    attempts: 0,
    maxAttempts: 12,
    nextRunAt: now,
    lockedAt: null,
    lockedBy: null,
    lastError: null,
    completedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeHarness(orderOverrides: Partial<RefundableOrder> = {}) {
  const tasks: TaskRow[] = [];
  const order = makeOrder(orderOverrides);
  const orderById = new Map<string, any>([[order.id, order]]);
  const auditCreates = jest.fn().mockResolvedValue({});
  const alertCreates = jest.fn().mockResolvedValue({});

  const prisma: any = {
    refundCompensationTask: {
      findUnique: jest.fn(async ({ where }: any) => {
        return tasks.find((task) => task.taskKey === where.taskKey || task.id === where.id) ?? null;
      }),
      create: jest.fn(async ({ data }: any) => {
        const now = new Date();
        const task: TaskRow = {
          id: `task-${tasks.length + 1}`,
          orderId: data.orderId,
          orderItemId: data.orderItemId ?? null,
          taskKey: data.taskKey,
          action: data.action,
          status: data.status ?? RefundCompensationTaskStatus.PENDING,
          sequence: data.sequence ?? 0,
          userId: data.userId,
          tenantId: data.tenantId ?? null,
          productId: data.productId ?? null,
          planId: data.planId ?? null,
          amountCents: data.amountCents ?? null,
          creditsAmount: data.creditsAmount ?? null,
          payload: data.payload === Prisma.JsonNull ? null : data.payload ?? null,
          attempts: data.attempts ?? 0,
          maxAttempts: data.maxAttempts ?? 12,
          nextRunAt: data.nextRunAt ?? now,
          lockedAt: data.lockedAt ?? null,
          lockedBy: data.lockedBy ?? null,
          lastError: data.lastError ?? null,
          completedAt: data.completedAt ?? null,
          createdAt: now,
          updatedAt: now,
        };
        tasks.push(task);
        return task;
      }),
      findMany: jest.fn(async ({ where, orderBy, take, select }: any = {}) => {
        let rows = tasks.filter((task) => taskMatches(task, where));
        if (orderBy) {
          rows = [...rows].sort((a, b) => a.sequence - b.sequence || a.createdAt.getTime() - b.createdAt.getTime());
        }
        if (take) rows = rows.slice(0, take);
        if (select?.orderId) return rows.map((task) => ({ orderId: task.orderId }));
        return rows.map((task) => ({ ...task }));
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const matched = tasks.filter((task) => taskMatches(task, where));
        for (const task of matched) applyTaskData(task, data);
        return { count: matched.length };
      }),
      update: jest.fn(async ({ where, data }: any) => {
        const task = tasks.find((row) => row.id === where.id);
        if (!task) throw new Error(`task not found: ${where.id}`);
        applyTaskData(task, data);
        return task;
      }),
      count: jest.fn(async ({ where }: any) => tasks.filter((task) => taskMatches(task, where)).length),
    },
    stripeSubscriptionCancellationTask: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    stripePaymentLedger: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    order: {
      findUnique: jest.fn(async ({ where }: any) => {
        const row = orderById.get(where.id);
        return row ? { ...row } : null;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        const row = orderById.get(where.id);
        if (!row || row.status !== where.status) return { count: 0 };
        Object.assign(row, data);
        return { count: 1 };
      }),
    },
    orderAuditLog: { create: auditCreates },
    orderItem: {
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    alertEvent: { create: alertCreates },
    balanceGrant: { findUnique: jest.fn().mockResolvedValue(null) },
    balanceTransaction: { findMany: jest.fn().mockResolvedValue([]) },
    codingPlanEntitlement: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([{ id: 'ent-1' }]),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    codingPlanAutoRenewal: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    codingPlanRenewalCharge: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    codingPlanProviderEntitlement: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    subscriptionPeriod: {
      findFirst: jest.fn().mockResolvedValue({ id: 'sub-1', productId: 'prod-1', planId: 'plan-1' }),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    creditTransaction: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn(async ({ where }: any) => (
        where.idempotencyKey === `checkout:${order.id}`
          ? {
              subscriptionId: 'sub-1',
              userId: order.userId,
              productId: order.plan?.productId ?? order.productId,
              type: 'QUOTA_GRANT',
              creditsAmount: order.plan?.monthlyCredits ?? 0,
            }
          : null
      )),
    },
    creditBalanceState: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    apiKey: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    gatewayBillingEvent: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    gatewayUsageSettlementAnchor: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    tokenUsage: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    user: { findUnique: jest.fn().mockResolvedValue({ email: 'user@example.com' }) },
    product: {
      findFirst: jest.fn().mockResolvedValue({ slug: 'prod' }),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    $executeRaw: jest.fn().mockResolvedValue(1),
    $queryRaw: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn(async (cb: any) => cb({
      order: prisma.order,
      orderAuditLog: prisma.orderAuditLog,
      refundCompensationTask: prisma.refundCompensationTask,
      orderItem: prisma.orderItem,
      alertEvent: prisma.alertEvent,
    })),
  };

  const billingService = { refundBalance: jest.fn().mockResolvedValue({ id: 'balance-refund' }) };
  const creditService = {
    reverseGrantedCredits: jest.fn().mockResolvedValue({
      success: true,
      quota: 0,
      bonus: 0,
    }),
  };
  const subscriptionResolver = {
    resolve: jest.fn().mockResolvedValue({ subscriptionId: 'sub-1' }),
    invalidateCache: jest.fn().mockResolvedValue(undefined),
  };
  const subscriptionLifecycle = {
    closeActive: jest.fn().mockResolvedValue(1),
    closeActivation: jest.fn().mockResolvedValue(true),
    closeActivationFamily: jest.fn().mockResolvedValue(true),
  };
  const productSync = {
    notifyCreditChanged: jest.fn().mockResolvedValue(undefined),
  };
  const publisherSync = {
    syncApiKeysByCodingPlanEntitlementId: jest.fn().mockResolvedValue(undefined),
    syncApiKeysByCodingPlanEntitlementIdRequired:
      jest.fn().mockResolvedValue(undefined),
    establishCodingPlanRefundDrainRequired: jest.fn().mockResolvedValue({
      protocol_version: 1,
      drain_id: 'ent-1',
      key_count: 0,
      in_flight: 0,
      request_seen_key_count: 0,
      ready: true,
    }),
    releaseCodingPlanRefundDrain: jest.fn().mockResolvedValue(undefined),
  };
  const service = new RefundCompensationService(
    prisma,
    billingService as any,
    creditService as any,
    subscriptionResolver as any,
    subscriptionLifecycle as any,
    productSync as any,
    publisherSync as any,
  );

  return {
    service,
    tasks,
    order,
    prisma,
    billingService,
    creditService,
    subscriptionResolver,
    subscriptionLifecycle,
    productSync,
    publisherSync,
    alertCreates,
    auditCreates,
  };
}

function configureUnusedSelfOperatedCodingPlan(
  harness: ReturnType<typeof makeHarness>,
  status: CodingPlanEntitlementStatus = CodingPlanEntitlementStatus.ACTIVE,
) {
  const startedAt = new Date('2026-01-01T00:00:00.000Z');
  const grant = {
    id: 'grant-1',
    subscriptionId: 'ent-1',
    userId: harness.order.userId,
    productId: harness.order.productId,
    type: 'QUOTA_GRANT',
    creditsAmount: harness.order.plan!.monthlyCredits,
    balanceVersion: 1n,
    idempotencyKey: `checkout:${harness.order.id}`,
  };
  const entitlement = {
    id: 'ent-1',
    orderId: harness.order.id,
    userId: harness.order.userId,
    tenantId: harness.order.tenantId,
    productId: harness.order.productId,
    planId: harness.order.planId,
    fulfillmentMode: CodingPlanFulfillmentMode.platform_model_package,
    status,
    startedAt,
    expiresAt: new Date('2099-01-01T00:00:00.000Z'),
    lastError:
      status === CodingPlanEntitlementStatus.ACTIVE
        ? null
        : status === CodingPlanEntitlementStatus.REFUNDING
          ? `refund-pending:${harness.order.id}`
          : 'order_refunded',
    providerEntitlementId: null,
    providerLineId: null,
    providerLineCode: null,
    providerCode: null,
    upstreamProductId: null,
  };
  harness.prisma.codingPlanEntitlement.findUnique
    .mockResolvedValue(entitlement);
  harness.prisma.codingPlanEntitlement.findFirst.mockResolvedValue(null);
  harness.prisma.codingPlanAutoRenewal.findFirst.mockResolvedValue(null);
  harness.prisma.codingPlanRenewalCharge.findFirst.mockResolvedValue(null);
  harness.prisma.codingPlanProviderEntitlement.findUnique
    .mockResolvedValue(null);
  harness.prisma.creditTransaction.findUnique.mockResolvedValue(grant);
  harness.prisma.creditTransaction.findMany.mockResolvedValue([grant]);
  harness.prisma.creditBalanceState.findUnique.mockResolvedValue({
    userId: harness.order.userId,
    quota: grant.creditsAmount,
    bonus: 0,
    version: grant.balanceVersion,
  });
  harness.prisma.apiKey.findMany.mockResolvedValue([]);
  harness.prisma.gatewayBillingEvent.findFirst.mockResolvedValue(null);
  harness.prisma.gatewayUsageSettlementAnchor.findFirst
    .mockResolvedValue(null);
  harness.prisma.tokenUsage.findFirst.mockResolvedValue(null);
  return { entitlement, grant };
}

describe('RefundCompensationService', () => {
  describe('unused self-operated Coding Plan refunds', () => {
    it('accepts an independent first purchase with untouched quota and no usage', async () => {
      const harness = makeHarness();
      const { entitlement, grant } =
        configureUnusedSelfOperatedCodingPlan(harness);

      await expect(
        harness.service.preflightUnusedSelfOperatedCodingPlanRefund(
          harness.order,
          harness.order.amountCents,
        ),
      ).resolves.toEqual({
        orderId: harness.order.id,
        entitlementId: entitlement.id,
        userId: harness.order.userId,
        tenantId: harness.order.tenantId,
        productId: harness.order.productId,
        planId: harness.order.planId,
        grantId: grant.id,
        grantIdempotencyKey: grant.idempotencyKey,
        grantCredits: grant.creditsAmount,
        grantBalanceVersion: grant.balanceVersion,
      });
    });

    it('rejects partial refunds before reading entitlement evidence', async () => {
      const harness = makeHarness();
      configureUnusedSelfOperatedCodingPlan(harness);

      await expect(
        harness.service.preflightUnusedSelfOperatedCodingPlanRefund(
          harness.order,
          harness.order.amountCents - 1,
        ),
      ).rejects.toMatchObject({ code: 'PARTIAL_REFUND_UNSUPPORTED' });
      expect(
        harness.prisma.codingPlanEntitlement.findUnique,
      ).not.toHaveBeenCalled();
    });

    it('rejects provider-resale Coding Plans', async () => {
      const harness = makeHarness();
      const { entitlement } = configureUnusedSelfOperatedCodingPlan(harness);
      harness.prisma.codingPlanEntitlement.findUnique.mockResolvedValue({
        ...entitlement,
        fulfillmentMode: CodingPlanFulfillmentMode.provider_resale,
      });

      await expect(
        harness.service.preflightUnusedSelfOperatedCodingPlanRefund(
          harness.order,
          harness.order.amountCents,
        ),
      ).rejects.toMatchObject({ code: 'PROVIDER_RESALE_UNSUPPORTED' });
    });

    const usageCases: Array<[
      string,
      (
        harness: ReturnType<typeof makeHarness>,
        fixture: ReturnType<typeof configureUnusedSelfOperatedCodingPlan>,
      ) => void,
    ]> = [
      [
        'an additional credit ledger row',
        (harness, { grant }) => {
          harness.prisma.creditTransaction.findMany.mockResolvedValue([
            grant,
            {
              ...grant,
              id: 'consume-1',
              idempotencyKey: 'usage-1',
              type: 'CONSUME',
              creditsAmount: -1,
              balanceVersion: 2n,
            },
          ]);
        },
      ],
      [
        'a changed balance snapshot',
        (harness, { grant }) => {
          harness.prisma.creditBalanceState.findUnique.mockResolvedValue({
            userId: harness.order.userId,
            quota: grant.creditsAmount - 1,
            bonus: 0,
            version: 2n,
          });
        },
      ],
      [
        'a Gateway request event',
        (harness) => {
          harness.prisma.apiKey.findMany.mockResolvedValue([{ id: 'key-1' }]);
          harness.prisma.gatewayBillingEvent.findFirst
            .mockResolvedValue({ id: 'event-1' });
        },
      ],
      [
        'a Gateway settlement anchor',
        (harness) => {
          harness.prisma.gatewayUsageSettlementAnchor.findFirst
            .mockResolvedValue({ id: 'anchor-1' });
        },
      ],
      [
        'a token usage row',
        (harness) => {
          harness.prisma.tokenUsage.findFirst
            .mockResolvedValue({ id: 'usage-1' });
        },
      ],
    ];

    it.each(usageCases)('rejects when evidence contains %s', async (
      _label,
      mutate,
    ) => {
      const harness = makeHarness();
      const fixture = configureUnusedSelfOperatedCodingPlan(harness);
      mutate(harness, fixture);

      await expect(
        harness.service.preflightUnusedSelfOperatedCodingPlanRefund(
          harness.order,
          harness.order.amountCents,
        ),
      ).rejects.toMatchObject({ code: 'USAGE_DETECTED' });
    });

    it('allows API key history when no request or quota evidence exists', async () => {
      const harness = makeHarness();
      configureUnusedSelfOperatedCodingPlan(harness);
      harness.prisma.apiKey.findMany.mockResolvedValue([{ id: 'key-1' }]);

      await expect(
        harness.service.preflightUnusedSelfOperatedCodingPlanRefund(
          harness.order,
          harness.order.amountCents,
        ),
      ).resolves.toMatchObject({ entitlementId: 'ent-1' });
      expect(harness.prisma.gatewayBillingEvent.findFirst)
        .toHaveBeenCalledWith(expect.objectContaining({
          where: expect.objectContaining({
            apiKeyId: { in: ['key-1'] },
          }),
        }));
    });

    it('establishes a Gateway drain after closing Publisher key admission', async () => {
      const harness = makeHarness();

      await expect(
        harness.service.syncSelfOperatedCodingPlanRefundHoldRequired('ent-1'),
      ).resolves.toBeUndefined();

      expect(
        harness.publisherSync.syncApiKeysByCodingPlanEntitlementIdRequired,
      ).toHaveBeenCalledWith('ent-1');
      expect(
        harness.publisherSync.establishCodingPlanRefundDrainRequired,
      ).toHaveBeenCalledWith('ent-1');
    });

    it('rejects a refund when the Gateway drain reports request history', async () => {
      const harness = makeHarness();
      harness.publisherSync.establishCodingPlanRefundDrainRequired
        .mockResolvedValue({
          protocol_version: 1,
          drain_id: 'ent-1',
          key_count: 1,
          in_flight: 1,
          request_seen_key_count: 1,
          ready: false,
        });

      await expect(
        harness.service.syncSelfOperatedCodingPlanRefundHoldRequired('ent-1'),
      ).rejects.toMatchObject({ code: 'GATEWAY_REQUEST_HISTORY_PRESENT' });
    });

    it('queues drain release when a terminal provider failure restores the entitlement', async () => {
      const harness = makeHarness();

      await harness.service.resyncReleasedSelfOperatedCodingPlanRefundHold(
        'ent-1',
      );

      expect(
        harness.publisherSync.releaseCodingPlanRefundDrain,
      ).toHaveBeenCalledWith('ent-1');
    });

    it('anchors self-operated classification to the order entitlement', async () => {
      const harness = makeHarness();
      configureUnusedSelfOperatedCodingPlan(harness);
      harness.prisma.product.findUnique.mockResolvedValue({
        billingMode: 'CODING_PLAN',
        codingPlanFulfillmentMode: CodingPlanFulfillmentMode.provider_resale,
      });

      await expect(
        harness.service.preflightUnusedSelfOperatedCodingPlanRefund(
          harness.order,
          harness.order.amountCents,
        ),
      ).resolves.toMatchObject({ entitlementId: 'ent-1' });
      expect(harness.prisma.product.findUnique).not.toHaveBeenCalled();
    });

    const dependencyCases: Array<[
      string,
      string,
      (harness: ReturnType<typeof makeHarness>) => void,
    ]> = [
      [
        'a renewal entitlement audit',
        'RENEWED_ENTITLEMENT',
        (harness) => {
          harness.prisma.codingPlanEntitlement.findFirst
            .mockResolvedValue({ id: 'renewal-audit-1' });
        },
      ],
      [
        'an auto-renewal contract',
        'AUTO_RENEWAL_DEPENDENCY',
        (harness) => {
          harness.prisma.codingPlanAutoRenewal.findFirst
            .mockResolvedValue({ id: 'renewal-1' });
        },
      ],
      [
        'a renewal charge',
        'AUTO_RENEWAL_DEPENDENCY',
        (harness) => {
          harness.prisma.codingPlanRenewalCharge.findFirst
            .mockResolvedValue({ id: 'charge-1' });
        },
      ],
      [
        'an upstream provider entitlement',
        'PROVIDER_EFFECT_PRESENT',
        (harness) => {
          harness.prisma.codingPlanProviderEntitlement.findUnique
            .mockResolvedValue({ id: 'provider-entitlement-1' });
        },
      ],
    ];

    it.each(dependencyCases)('rejects when the order has %s', async (
      _label,
      code,
      mutate,
    ) => {
      const harness = makeHarness();
      configureUnusedSelfOperatedCodingPlan(harness);
      mutate(harness);

      await expect(
        harness.service.preflightUnusedSelfOperatedCodingPlanRefund(
          harness.order,
          harness.order.amountCents,
        ),
      ).rejects.toMatchObject({ code });
    });

    it('rejects switch or proration orders', async () => {
      const harness = makeHarness({
        prorationCreditCents: 100,
        prorationSourceEntitlementId: 'ent-old',
      });
      configureUnusedSelfOperatedCodingPlan(harness);

      await expect(
        harness.service.preflightUnusedSelfOperatedCodingPlanRefund(
          harness.order,
          harness.order.amountCents,
        ),
      ).rejects.toMatchObject({ code: 'SWITCH_ORDER_UNSUPPORTED' });
    });

    it('atomically moves an eligible entitlement into REFUNDING', async () => {
      const harness = makeHarness();
      const { entitlement, grant } =
        configureUnusedSelfOperatedCodingPlan(harness);
      harness.prisma.$queryRaw.mockResolvedValue([{ id: entitlement.id }]);

      await harness.service.claimUnusedSelfOperatedCodingPlanRefundHold(
        harness.prisma,
        harness.order.id,
        harness.order.amountCents,
        {
          orderId: harness.order.id,
          entitlementId: entitlement.id,
          userId: harness.order.userId,
          tenantId: harness.order.tenantId,
          productId: harness.order.productId!,
          planId: harness.order.planId!,
          grantId: grant.id,
          grantIdempotencyKey: grant.idempotencyKey,
          grantCredits: grant.creditsAmount,
          grantBalanceVersion: grant.balanceVersion,
        },
      );

      expect(harness.prisma.$executeRaw).toHaveBeenCalledTimes(1);
      expect(harness.prisma.codingPlanEntitlement.updateMany)
        .toHaveBeenCalledWith({
          where: expect.objectContaining({
            id: entitlement.id,
            orderId: harness.order.id,
            status: CodingPlanEntitlementStatus.ACTIVE,
          }),
          data: {
            status: CodingPlanEntitlementStatus.REFUNDING,
            lastError: `refund-pending:${harness.order.id}`,
          },
        });
    });

    it('restores a bound REFUNDING entitlement after a terminal provider failure', async () => {
      const harness = makeHarness();
      const { entitlement } = configureUnusedSelfOperatedCodingPlan(
        harness,
        CodingPlanEntitlementStatus.REFUNDING,
      );

      await expect(
        harness.service.releaseUnusedSelfOperatedCodingPlanRefundHold(
          harness.prisma,
          harness.order.id,
        ),
      ).resolves.toBe(entitlement.id);
      expect(harness.prisma.codingPlanEntitlement.updateMany)
        .toHaveBeenCalledWith({
          where: expect.objectContaining({
            id: entitlement.id,
            status: CodingPlanEntitlementStatus.REFUNDING,
            lastError: `refund-pending:${harness.order.id}`,
          }),
          data: {
            status: CodingPlanEntitlementStatus.ACTIVE,
            lastError: null,
          },
        });
    });

    it('creates only Coding Plan cancellation tasks for a held self-operated entitlement', async () => {
      const harness = makeHarness();
      configureUnusedSelfOperatedCodingPlan(
        harness,
        CodingPlanEntitlementStatus.REFUNDING,
      );

      const result = await harness.service.prepareAndRun(
        harness.order,
        harness.order.amountCents,
        { reason: 'unused Coding Plan refund' },
      );

      expect(result.complete).toBe(true);
      expect(harness.tasks.map((task) => task.action)).toEqual(
        expect.arrayContaining([
          RefundCompensationTaskAction.CREDIT_DEDUCT,
          RefundCompensationTaskAction.CANCEL_CODING_PLAN_ENTITLEMENT,
          RefundCompensationTaskAction.SYNC_PUBLISHER_KEYS,
        ]),
      );
      expect(harness.tasks.map((task) => task.action)).not.toContain(
        RefundCompensationTaskAction.CANCEL_SUBSCRIPTION,
      );
    });
  });

  it('carries the original recharge account into balance compensation', async () => {
    const harness = makeHarness({
      orderType: PrismaOrderType.RECHARGE,
      billingAccountId: 'ba-original',
      plan: null,
      planId: null,
      amountCents: 10000,
    });

    const result = await harness.service.prepareAndRun(harness.order, 10000, {
      reason: '充值退款',
    });

    expect(result.complete).toBe(true);
    expect(harness.tasks).toHaveLength(1);
    expect(harness.tasks[0].payload).toEqual({
      description: 'refund:recharge:order:order-1:principal',
      billingAccountId: 'ba-original',
      refundComponent: 'PAID',
    });
    expect(harness.billingService.refundBalance).toHaveBeenCalledWith(
      'user-1',
      10000,
      'refund:recharge:order:order-1:principal',
      'order-1',
      'prod-1',
      {
        tenantId: 'tenant-1',
        billingAccountId: 'ba-original',
        refundComponent: 'PAID',
        idempotencyKey: 'refund:order-1:recharge:principal',
      },
    );
  });

  it('ignores a negative expiry adjustment when proving recharge bonus evidence', async () => {
    const harness = makeHarness({
      orderType: PrismaOrderType.RECHARGE,
      billingAccountId: 'ba-original',
      plan: null,
      planId: null,
      amountCents: 10000,
      bonusCents: 300,
    });
    harness.prisma.balanceGrant.findUnique.mockResolvedValue({
      userId: 'user-1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba-original',
      productId: 'prod-1',
      source: 'RECHARGE',
      bonusAmountUsd: new Prisma.Decimal('3'),
    });
    const evidence = [
      {
        id: 'bonus-positive',
        userId: 'user-1',
        tenantId: 'tenant-1',
        billingAccountId: 'ba-original',
        productId: 'prod-1',
        description: 'recharge-bonus tier:promo',
        amountUsd: new Prisma.Decimal('3'),
      },
      {
        id: 'grant-expiry-negative',
        userId: 'user-1',
        tenantId: 'tenant-1',
        billingAccountId: 'ba-original',
        productId: 'prod-1',
        description: 'balance grant expired:grant-1',
        amountUsd: new Prisma.Decimal('-1'),
      },
    ];
    harness.prisma.balanceTransaction.findMany.mockImplementation(
      async ({ where }: any) => evidence.filter((transaction) => (
        where.amountUsd?.gt === undefined
        || transaction.amountUsd.gt(where.amountUsd.gt)
      )),
    );

    const result = await harness.service.prepareAndRun(harness.order, 10000, {
      reason: '充值退款',
    });

    expect(result.complete).toBe(true);
    expect(harness.prisma.balanceTransaction.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          orderId: 'order-1',
          type: 'ADJUST',
          amountUsd: { gt: 0 },
        },
      }),
    );
    expect(harness.tasks.map((task) => task.amountCents)).toEqual([10000, 300]);
    expect(harness.billingService.refundBalance).toHaveBeenCalledTimes(2);
  });

  it('still fails recharge bonus evidence closed for multiple positive originals', async () => {
    const harness = makeHarness({
      orderType: PrismaOrderType.RECHARGE,
      billingAccountId: 'ba-original',
      plan: null,
      planId: null,
      amountCents: 10000,
      bonusCents: 300,
    });
    harness.prisma.balanceGrant.findUnique.mockResolvedValue({
      userId: 'user-1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba-original',
      productId: 'prod-1',
      source: 'RECHARGE',
      bonusAmountUsd: new Prisma.Decimal('3'),
    });
    harness.prisma.balanceTransaction.findMany.mockResolvedValue([
      {
        id: 'bonus-positive-1',
        userId: 'user-1',
        tenantId: 'tenant-1',
        billingAccountId: 'ba-original',
        productId: 'prod-1',
        description: 'recharge-bonus',
        amountUsd: new Prisma.Decimal('1'),
      },
      {
        id: 'bonus-positive-2',
        userId: 'user-1',
        tenantId: 'tenant-1',
        billingAccountId: 'ba-original',
        productId: 'prod-1',
        description: 'recharge-bonus tier:promo',
        amountUsd: new Prisma.Decimal('2'),
      },
    ]);

    await expect(
      harness.service.prepareAndRun(harness.order, 10000, { reason: '充值退款' }),
    ).rejects.toThrow(
      'RECHARGE_BONUS_EVIDENCE_AMBIGUOUS:order-1:multiple_original_transactions',
    );
    expect(harness.tasks).toHaveLength(0);
    expect(harness.billingService.refundBalance).not.toHaveBeenCalled();
  });

  it('fails recharge bonus evidence closed when the grant and transaction total differ', async () => {
    const harness = makeHarness({
      orderType: PrismaOrderType.RECHARGE,
      billingAccountId: 'ba-original',
      plan: null,
      planId: null,
      amountCents: 10000,
      bonusCents: 300,
    });
    harness.prisma.balanceGrant.findUnique.mockResolvedValue({
      userId: 'user-1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba-original',
      productId: 'prod-1',
      source: 'RECHARGE',
      bonusAmountUsd: new Prisma.Decimal('3'),
    });
    harness.prisma.balanceTransaction.findMany.mockResolvedValue([
      {
        id: 'bonus-positive',
        userId: 'user-1',
        tenantId: 'tenant-1',
        billingAccountId: 'ba-original',
        productId: 'prod-1',
        description: 'recharge-bonus tier:promo',
        amountUsd: new Prisma.Decimal('2'),
      },
    ]);

    await expect(
      harness.service.prepareAndRun(harness.order, 10000, { reason: '充值退款' }),
    ).rejects.toThrow(
      'RECHARGE_BONUS_EVIDENCE_AMBIGUOUS:order-1:grant_transaction_total_mismatch',
    );
    expect(harness.tasks).toHaveLength(0);
    expect(harness.billingService.refundBalance).not.toHaveBeenCalled();
  });

  it('fails recharge bonus evidence closed when the order and transaction differ', async () => {
    const harness = makeHarness({
      orderType: PrismaOrderType.RECHARGE,
      billingAccountId: 'ba-original',
      plan: null,
      planId: null,
      amountCents: 10000,
      bonusCents: 300,
    });
    harness.prisma.balanceGrant.findUnique.mockResolvedValue({
      userId: 'user-1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba-original',
      productId: 'prod-1',
      source: 'RECHARGE',
      bonusAmountUsd: new Prisma.Decimal('2'),
    });
    harness.prisma.balanceTransaction.findMany.mockResolvedValue([
      {
        id: 'bonus-positive',
        userId: 'user-1',
        tenantId: 'tenant-1',
        billingAccountId: 'ba-original',
        productId: 'prod-1',
        description: 'recharge-bonus tier:promo',
        amountUsd: new Prisma.Decimal('2'),
      },
    ]);

    await expect(
      harness.service.prepareAndRun(harness.order, 10000, { reason: '充值退款' }),
    ).rejects.toThrow(
      'RECHARGE_BONUS_EVIDENCE_AMBIGUOUS:order-1:order_transaction_mismatch',
    );
    expect(harness.tasks).toHaveLength(0);
    expect(harness.billingService.refundBalance).not.toHaveBeenCalled();
  });

  it('channel-only recharge refund creates no balance task and completes the order', async () => {
    const harness = makeHarness({
      orderType: PrismaOrderType.RECHARGE,
      billingAccountId: null,
      plan: null,
      planId: null,
      amountCents: 10000,
    });

    const result = await harness.service.prepareAndRun(harness.order, 10000, {
      reason: '充值主体变化自动退款',
      skipRechargeBalanceCompensation: true,
    });

    expect(result.complete).toBe(true);
    expect(harness.tasks).toHaveLength(0);
    expect(harness.billingService.refundBalance).not.toHaveBeenCalled();
    expect(harness.order.status).toBe(OrderStatus.REFUNDED);
    expect(harness.auditCreates).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        fromStatus: OrderStatus.REFUNDING,
        toStatus: OrderStatus.REFUNDED,
      }),
    }));
  });

  it('restores the account from the original order for a legacy task without account payload', async () => {
    const harness = makeHarness({
      orderType: PrismaOrderType.RECHARGE,
      billingAccountId: 'ba-original',
      plan: null,
      planId: null,
      amountCents: 10000,
    });
    harness.billingService.refundBalance
      .mockRejectedValueOnce(new Error('temporary failure'))
      .mockResolvedValueOnce({ id: 'balance-refund' });

    const first = await harness.service.prepareAndRun(harness.order, 10000);
    expect(first.complete).toBe(false);
    harness.tasks[0].payload = {
      description: 'refund:recharge:order:order-1:principal',
      refundComponent: 'PAID',
    };

    const second = await harness.service.runOrderTasks('order-1', { force: true });

    expect(second.complete).toBe(true);
    expect(harness.billingService.refundBalance).toHaveBeenLastCalledWith(
      'user-1',
      10000,
      'refund:recharge:order:order-1:principal',
      'order-1',
      'prod-1',
      {
        tenantId: 'tenant-1',
        billingAccountId: 'ba-original',
        refundComponent: 'PAID',
        idempotencyKey: 'refund:order-1:recharge:principal',
      },
    );
  });

  it('fails a recharge balance task closed when its amount is not positive', async () => {
    const harness = makeHarness({
      orderType: PrismaOrderType.RECHARGE,
      billingAccountId: 'ba-original',
      plan: null,
      planId: null,
      amountCents: 10000,
    });
    harness.billingService.refundBalance.mockRejectedValueOnce(new Error('temporary failure'));
    const first = await harness.service.prepareAndRun(harness.order, 10000);
    expect(first.complete).toBe(false);
    harness.tasks[0].amountCents = 0;

    const second = await harness.service.runOrderTasks('order-1', { force: true });

    expect(second.complete).toBe(false);
    expect(second.error).toBe(
      'REFUND_BALANCE_COMPONENT_AMBIGUOUS:refund:order-1:recharge:principal:amount_invalid',
    );
    expect(harness.billingService.refundBalance).toHaveBeenCalledTimes(1);
  });

  it('fails a recharge balance task closed when an account payload is present but not a string', async () => {
    const harness = makeHarness({
      orderType: PrismaOrderType.RECHARGE,
      billingAccountId: 'ba-original',
      plan: null,
      planId: null,
      amountCents: 10000,
    });
    harness.billingService.refundBalance.mockRejectedValueOnce(new Error('temporary failure'));
    const first = await harness.service.prepareAndRun(harness.order, 10000);
    expect(first.complete).toBe(false);
    harness.tasks[0].payload = {
      description: 'refund:recharge:order:order-1:principal',
      billingAccountId: null,
      refundComponent: 'PAID',
    };

    const second = await harness.service.runOrderTasks('order-1', { force: true });

    expect(second.complete).toBe(false);
    expect(second.error).toBe(
      'REFUND_BALANCE_COMPONENT_AMBIGUOUS:refund:order-1:recharge:principal:billing_account_invalid',
    );
    expect(harness.billingService.refundBalance).toHaveBeenCalledTimes(1);
  });

  it('retries failed tasks without rerunning already succeeded credit deduction', async () => {
    const harness = makeHarness();
    harness.subscriptionLifecycle.closeActivation
      .mockRejectedValueOnce(new Error('close failed'))
      .mockResolvedValueOnce(true);

    const first = await harness.service.prepareAndRun(harness.order, 10000, { reason: '退款' });

    expect(first.complete).toBe(false);
    expect(first.failed).toBe(1);
    expect(harness.creditService.reverseGrantedCredits).toHaveBeenCalledTimes(1);
    expect(harness.creditService.reverseGrantedCredits).toHaveBeenCalledWith({
      subscriptionId: 'sub-1',
      userId: 'user-1',
      credits: 500,
      bucket: 'QUOTA',
      source: 'refund:Pro:order:order-1',
      originalGrantIdempotencyKey: 'checkout:order-1',
      reversalIdempotencyKey: 'refund:order-1:plan:credit',
    });

    harness.order.status = OrderStatus.REFUND_COMPENSATION_FAILED;
    const second = await harness.service.runOrderTasks('order-1', { force: true, reason: '补偿重试' });

    expect(second.complete).toBe(true);
    expect(harness.creditService.reverseGrantedCredits).toHaveBeenCalledTimes(1);
    expect(harness.subscriptionLifecycle.closeActivation).toHaveBeenCalledTimes(2);
    expect(harness.subscriptionLifecycle.closeActive).not.toHaveBeenCalled();
    expect(harness.order.status).toBe(OrderStatus.REFUNDED);
    expect(harness.auditCreates).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        fromStatus: OrderStatus.REFUND_COMPENSATION_FAILED,
        toStatus: OrderStatus.REFUNDED,
      }),
    }));
  });

  it('does not close a refund when the exact credit reversal is insufficient', async () => {
    const harness = makeHarness();
    harness.creditService.reverseGrantedCredits.mockResolvedValue({
      success: false,
      quota: 0,
      bonus: 0,
    });

    const result = await harness.service.prepareAndRun(
      harness.order,
      10000,
      { reason: '退款' },
    );

    expect(result.complete).toBe(false);
    expect(result.failed).toBe(1);
    expect(result.error).toBe(
      'REFUND_CREDIT_DEDUCT_INSUFFICIENT:refund:order-1:plan:credit:500',
    );
    expect(harness.order.status).toBe(OrderStatus.REFUNDING);
    expect(harness.subscriptionLifecycle.closeActivation).not.toHaveBeenCalled();
  });

  it('reverses the persisted checkout grant instead of mutable plan credits', async () => {
    const harness = makeHarness();
    harness.prisma.creditTransaction.findUnique.mockResolvedValue({
      subscriptionId: 'period-original',
      userId: 'user-1',
      productId: 'prod-1',
      type: 'QUOTA_GRANT',
      creditsAmount: 275,
    });

    await harness.service.prepareAndRun(
      harness.order,
      10000,
      { reason: '退款' },
    );

    expect(harness.creditService.reverseGrantedCredits).toHaveBeenCalledWith({
      subscriptionId: 'period-original',
      userId: 'user-1',
      credits: 275,
      bucket: 'QUOTA',
      source: 'refund:Pro:order:order-1',
      originalGrantIdempotencyKey: 'checkout:order-1',
      reversalIdempotencyKey: 'refund:order-1:plan:credit',
    });
  });

  it('fails closed when a completed checkout grant has no exact credit receipt', async () => {
    const harness = makeHarness();
    harness.prisma.creditTransaction.findUnique.mockResolvedValue(null);

    await expect(
      harness.service.prepareAndRun(
        harness.order,
        10000,
        { reason: '退款' },
      ),
    ).rejects.toThrow('REFUND_PLAN_CREDIT_EVIDENCE_MISSING:order-1');
    expect(harness.creditService.reverseGrantedCredits).not.toHaveBeenCalled();
    expect(harness.subscriptionLifecycle.closeActivation).not.toHaveBeenCalled();
  });

  it('skipEntitlementCompensation：只退渠道款，不生成 plan 权益补偿任务（不误扣旧套餐积分/不误关权益）', async () => {
    const harness = makeHarness(); // 默认 SUBSCRIPTION，plan Pro monthlyCredits 500
    const result = await harness.service.prepareAndRun(harness.order, 10000, {
      reason: '自营换档抵扣拒单自动退款',
      skipEntitlementCompensation: true,
    });

    expect(result.complete).toBe(true); // 无补偿任务 → 直接完成
    expect(harness.creditService.reverseGrantedCredits).not.toHaveBeenCalled(); // 关键：不误扣积分
    expect(harness.subscriptionLifecycle.closeActive).not.toHaveBeenCalled(); // 不误关订阅
    expect(harness.tasks.length).toBe(0);
  });

  it('allows skip-entitlement preflight only when no exact order effect exists', async () => {
    const harness = makeHarness();
    harness.prisma.subscriptionPeriod.findFirst.mockResolvedValue(null);

    await expect(
      harness.service.preflightOrderCompensation(
        harness.order,
        10000,
        { skipEntitlementCompensation: true },
      ),
    ).resolves.toBeUndefined();

    expect(harness.tasks).toHaveLength(0);
  });

  it.each([
    ['subscription period', 'subscriptionPeriod', { id: 'period-1' }],
    ['credit grant', 'creditTransaction', { id: 'credit-1' }],
    ['coding entitlement', 'codingPlanEntitlement', { id: 'coding-1' }],
    ['provider entitlement', 'codingPlanProviderEntitlement', { id: 'provider-1' }],
  ])('blocks skip-entitlement preflight when an exact %s exists', async (
    _label,
    model,
    effect,
  ) => {
    const harness = makeHarness();
    harness.prisma.subscriptionPeriod.findFirst.mockResolvedValue(null);
    if (model === 'subscriptionPeriod') {
      harness.prisma.subscriptionPeriod.findFirst.mockResolvedValue(effect);
    } else if (model === 'creditTransaction') {
      harness.prisma.creditTransaction.findFirst.mockResolvedValue(effect);
    } else {
      harness.prisma[model].findUnique.mockResolvedValue(effect);
    }

    await expect(
      harness.service.preflightOrderCompensation(
        harness.order,
        10000,
        { skipEntitlementCompensation: true },
      ),
    ).rejects.toThrow(
      'REFUND_SKIP_ENTITLEMENT_EFFECTS_PRESENT:order-1',
    );
    expect(harness.tasks).toHaveLength(0);
  });

  it('preflights a generic plan refund without mutating tasks or item state', async () => {
    const harness = makeHarness({
      channel: PayChannel.WECHAT,
    });
    harness.prisma.subscriptionPeriod.findUnique.mockResolvedValue({
      id: 'sub-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      planId: 'plan-1',
    });

    await harness.service.preflightOrderCompensation(
      harness.order,
      10000,
    );

    expect(harness.tasks).toHaveLength(0);
    expect(harness.prisma.orderItem.update).not.toHaveBeenCalled();
    expect(harness.prisma.refundCompensationTask.create)
      .not.toHaveBeenCalled();
  });

  it('fails generic plan preflight when the exact activation receipt is missing', async () => {
    const harness = makeHarness({
      channel: PayChannel.ALIPAY,
    });
    harness.prisma.subscriptionPeriod.findUnique
      .mockResolvedValue(null);

    await expect(
      harness.service.preflightOrderCompensation(
        harness.order,
        10000,
      ),
    ).rejects.toThrow(
      'REFUND_PLAN_ACTIVATION_EVIDENCE_MISSING:order-1',
    );

    expect(harness.prisma.refundCompensationTask.create)
      .not.toHaveBeenCalled();
  });

  it('maps an initial Stripe invoice to the exact checkout period and grant', async () => {
    const harness = makeHarness({
      channel: PayChannel.STRIPE,
      tradeNo: 'sub_exact',
      checkoutProviderReference: 'cs_exact',
    } as any);
    harness.prisma.subscriptionPeriod.findUnique
      .mockResolvedValue(null);
    harness.prisma.subscriptionPeriod.findFirst
      .mockResolvedValue({
        id: 'period-initial',
        activationIdempotencyKey:
          'checkout:order-1:activation',
      });
    harness.prisma.stripePaymentLedger.findFirst
      .mockResolvedValue({ id: 'ledger-1' });
    harness.prisma.creditTransaction.findUnique
      .mockResolvedValue({
        subscriptionId: 'period-initial',
        userId: 'user-1',
        productId: 'prod-1',
        type: 'QUOTA_GRANT',
        creditsAmount: 500,
      });

    await expect(
      harness.service.preflightStripeSubscriptionRefund(
        harness.order,
        'in_initial',
      ),
    ).resolves.toMatchObject({
      refundedActivationIdempotencyKey:
        'checkout:order-1:activation',
      refundedSubscriptionPeriodId: 'period-initial',
      originalGrantIdempotencyKey: 'checkout:order-1',
      skipEntitlementCompensation: false,
    });
  });

  it('rejects a Stripe invoice mapping when the grant belongs to another period', async () => {
    const harness = makeHarness({
      channel: PayChannel.STRIPE,
      tradeNo: 'sub_exact',
      checkoutProviderReference: 'cs_exact',
    } as any);
    harness.prisma.subscriptionPeriod.findUnique
      .mockResolvedValue(null);
    harness.prisma.subscriptionPeriod.findFirst
      .mockResolvedValue({
        id: 'period-initial',
        activationIdempotencyKey:
          'checkout:order-1:activation',
      });
    harness.prisma.stripePaymentLedger.findFirst
      .mockResolvedValue({ id: 'ledger-1' });
    harness.prisma.creditTransaction.findUnique
      .mockResolvedValue({
        subscriptionId: 'period-other',
        userId: 'user-1',
        productId: 'prod-1',
        type: 'QUOTA_GRANT',
        creditsAmount: 500,
      });

    await expect(
      harness.service.preflightStripeSubscriptionRefund(
        harness.order,
        'in_initial',
      ),
    ).rejects.toThrow(
      'REFUND_PLAN_CREDIT_EVIDENCE_MISSING:order-1',
    );
  });

  it('uses durable evidence for ambiguous bundle items and does not invent side effects', async () => {
    const itemA = {
      id: 'item-a',
      status: OrderItemStatus.FULFILLED,
      orderId: 'order-1',
      planId: 'plan-a',
      productId: 'prod-a',
      boosterPackId: null,
      name: 'Product A',
      amountCents: 8000,
      currency: 'usd',
      validityDays: null,
      plan: { id: 'plan-a', productId: 'prod-a', name: 'A Pro', monthlyCredits: 300 },
      boosterPack: null,
    } as any;
    const itemB = {
      id: 'item-b',
      status: OrderItemStatus.FAILED,
      orderId: 'order-1',
      planId: 'plan-b',
      productId: 'prod-b',
      boosterPackId: null,
      name: 'Product B',
      amountCents: 2000,
      currency: 'usd',
      validityDays: null,
      plan: { id: 'plan-b', productId: 'prod-b', name: 'B Pro', monthlyCredits: 100 },
      boosterPack: null,
    } as any;
    const itemC = {
      id: 'item-c',
      status: OrderItemStatus.PENDING,
      orderId: 'order-1',
      planId: 'plan-c',
      productId: 'prod-c',
      boosterPackId: null,
      name: 'Product C',
      amountCents: 0,
      currency: 'usd',
      validityDays: null,
      plan: { id: 'plan-c', productId: 'prod-c', name: 'C Access', monthlyCredits: 0 },
      boosterPack: null,
    } as any;
    const harness = makeHarness({
      orderType: PrismaOrderType.BUNDLE,
      status: OrderStatus.PARTIALLY_FULFILLED_REQUIRES_COMPENSATION,
      plan: null,
      planId: null,
      productId: null,
      amountCents: 10000,
      items: [itemA, itemB, itemC],
    });
    harness.prisma.creditTransaction.findUnique.mockImplementation(
      async ({ where }: any) => (
        where.idempotencyKey === 'bundle:order-1:item:item-a:quota'
          ? {
              subscriptionId: 'period-a',
              userId: 'user-1',
              productId: 'prod-a',
              type: 'QUOTA_GRANT',
              creditsAmount: 300,
            }
          : null
      ),
    );

    const result = await harness.service.prepareAndRun(harness.order, 10000, { reason: 'bundle refund' });

    expect(result.complete).toBe(true);
    const taskKeys = harness.tasks.map((task) => task.taskKey);
    expect(taskKeys.some((key) => key.includes('item:item-a'))).toBe(true);
    expect(taskKeys).toContain('refund:order-1:item:item-b:mark:COMPENSATED');
    expect(taskKeys).toContain('refund:order-1:item:item-c:mark:COMPENSATED');
    expect(taskKeys).not.toContain('refund:order-1:item:item-b:credit');
    expect(taskKeys).not.toContain('refund:order-1:item:item-b:cancel-subscription');
    expect(harness.prisma.orderItem.update).toHaveBeenCalledWith({
      where: { id: 'item-a' },
      data: { status: OrderItemStatus.COMPENSATING },
    });
    expect(harness.prisma.orderItem.updateMany).toHaveBeenCalledWith({
      where: { id: 'item-a', orderId: 'order-1' },
      data: { status: OrderItemStatus.COMPENSATED },
    });
    expect(harness.prisma.orderItem.update).toHaveBeenCalledWith({
      where: { id: 'item-b' },
      data: { status: OrderItemStatus.COMPENSATING },
    });
    expect(harness.prisma.orderItem.updateMany).toHaveBeenCalledWith({
      where: { id: 'item-b', orderId: 'order-1' },
      data: { status: OrderItemStatus.COMPENSATED },
    });
    expect(harness.prisma.orderItem.updateMany).toHaveBeenCalledWith({
      where: { id: 'item-c', orderId: 'order-1' },
      data: { status: OrderItemStatus.COMPENSATED },
    });
  });

  it('reverses only the exact durable effects of an ambiguous bundle plan item', async () => {
    const item = {
      id: 'item-ambiguous',
      status: OrderItemStatus.FAILED,
      orderId: 'order-1',
      planId: 'plan-a',
      productId: 'prod-a',
      boosterPackId: null,
      name: 'Product A',
      amountCents: 10000,
      currency: 'usd',
      validityDays: null,
      plan: { id: 'plan-a', productId: 'prod-a', name: 'A Pro', monthlyCredits: 300 },
      boosterPack: null,
    } as any;
    const harness = makeHarness({
      orderType: PrismaOrderType.BUNDLE,
      status: OrderStatus.PARTIALLY_FULFILLED_REQUIRES_COMPENSATION,
      plan: null,
      planId: null,
      productId: null,
      amountCents: 10000,
      items: [item],
    });
    harness.prisma.creditTransaction.findUnique.mockResolvedValue({
      subscriptionId: 'period-from-quota',
      userId: 'user-1',
      productId: 'prod-a',
      type: 'QUOTA_GRANT',
      creditsAmount: 300,
    });
    harness.prisma.subscriptionPeriod.findUnique.mockResolvedValue({
      id: 'period-from-activation',
    });

    const result = await harness.service.prepareAndRun(
      harness.order,
      10000,
      { reason: 'bundle terminal write failed' },
    );

    expect(result.complete).toBe(true);
    expect(harness.creditService.reverseGrantedCredits).toHaveBeenCalledWith({
      subscriptionId: 'period-from-quota',
      userId: 'user-1',
      credits: 300,
      bucket: 'QUOTA',
      source: 'refund:Product A:order:order-1',
      originalGrantIdempotencyKey:
        'bundle:order-1:item:item-ambiguous:quota',
      reversalIdempotencyKey:
        'refund:order-1:item:item-ambiguous:credit',
    });
    expect(harness.subscriptionLifecycle.closeActivation).toHaveBeenCalledWith({
      activationIdempotencyKey: 'bundle:order-1:item:item-ambiguous:activation',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-a',
      planId: 'plan-a',
      endedAt: expect.any(Date),
      terminationReason: 'order_refunded',
    });
    expect(harness.subscriptionLifecycle.closeActive).not.toHaveBeenCalled();
  });

  it('keeps manual-review tasks out of worker retry and allows force retry as recovery entry', async () => {
    const harness = makeHarness({
      status: OrderStatus.REFUND_COMPENSATION_FAILED,
      plan: null,
      planId: null,
      productId: null,
    });
    harness.tasks.push({
      id: 'task-manual',
      orderId: 'order-1',
      orderItemId: null,
      taskKey: 'refund:order-1:manual-notify',
      action: RefundCompensationTaskAction.NOTIFY_CREDIT_CHANGED,
      status: RefundCompensationTaskStatus.MANUAL_REVIEW,
      sequence: 10,
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      planId: null,
      amountCents: null,
      creditsAmount: null,
      payload: null,
      attempts: 12,
      maxAttempts: 12,
      nextRunAt: new Date('2026-01-01T00:00:00Z'),
      lockedAt: null,
      lockedBy: null,
      lastError: 'previous failure',
      completedAt: null,
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
    });

    const workerRun = await harness.service.runDueTasks({ batchSize: 10, trigger: 'worker' });
    expect(workerRun.orders).toBe(0);
    expect(harness.productSync.notifyCreditChanged).not.toHaveBeenCalled();

    const manualRun = await harness.service.runOrderTasks('order-1', { force: true, reason: '人工处理后重试' });

    expect(manualRun.complete).toBe(true);
    expect(harness.productSync.notifyCreditChanged).toHaveBeenCalledWith('user@example.com', 'prod');
    expect(harness.order.status).toBe(OrderStatus.REFUNDED);
    expect(harness.tasks[0].status).toBe(RefundCompensationTaskStatus.SUCCEEDED);
  });

  it('recovers a stale RUNNING task after a worker crashes', async () => {
    const harness = makeHarness({
      status: OrderStatus.REFUNDING,
      plan: null,
      planId: null,
    });
    const now = new Date();
    harness.tasks.push({
      id: 'task-stale-running',
      orderId: 'order-1',
      orderItemId: null,
      taskKey: 'refund:order-1:stale-invalidate',
      action: RefundCompensationTaskAction.INVALIDATE_SUBSCRIPTION_CACHE,
      status: RefundCompensationTaskStatus.RUNNING,
      sequence: 10,
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      planId: null,
      amountCents: null,
      creditsAmount: null,
      payload: null,
      attempts: 1,
      maxAttempts: 12,
      nextRunAt: new Date(now.getTime() + 60 * 60 * 1000),
      lockedAt: new Date(now.getTime() - 11 * 60 * 1000),
      lockedBy: 'crashed-worker',
      lastError: null,
      completedAt: null,
      createdAt: new Date(now.getTime() - 12 * 60 * 1000),
      updatedAt: new Date(now.getTime() - 11 * 60 * 1000),
    });

    const result = await harness.service.runDueTasks({ batchSize: 10 });

    expect(result).toEqual({
      orders: 1,
      completed: 1,
      failed: 0,
      manualReview: 0,
    });
    expect(harness.subscriptionResolver.invalidateCache).toHaveBeenCalledWith(
      'user-1',
      'prod-1',
      'tenant-1',
    );
    expect(harness.tasks[0].status).toBe(RefundCompensationTaskStatus.SUCCEEDED);
    expect(harness.order.status).toBe(OrderStatus.REFUNDED);
  });

  it('fences stale-worker success and failure writes after another lease reclaims the task', async () => {
    const harness = makeHarness();
    const current = makeTaskRow({
      id: 'task-reclaimed',
      orderItemId: 'item-1',
      status: RefundCompensationTaskStatus.RUNNING,
      attempts: 2,
      lockedAt: new Date(),
      lockedBy: 'refund-compensation:new-lease',
    });
    harness.tasks.push(current);
    const staleClaim = {
      task: {
        ...current,
        attempts: 1,
        lockedBy: 'refund-compensation:old-lease',
      },
      leaseId: 'refund-compensation:old-lease',
    };

    await expect(
      (harness.service as any).markTaskSucceeded(staleClaim),
    ).resolves.toBe(false);
    await expect(
      (harness.service as any).markTaskFailed(
        staleClaim,
        'old worker failed after reclaim',
      ),
    ).resolves.toBe(false);

    expect(harness.tasks[0]).toEqual(expect.objectContaining({
      status: RefundCompensationTaskStatus.RUNNING,
      attempts: 2,
      lockedBy: 'refund-compensation:new-lease',
    }));
    expect(harness.prisma.orderItem.updateMany).not.toHaveBeenCalled();
    expect(harness.alertCreates).not.toHaveBeenCalled();
  });

  it('claims each compensation task with a distinct random lease token', async () => {
    const harness = makeHarness();
    const first = makeTaskRow({
      id: 'task-random-lease-1',
      taskKey: 'refund:order-1:random-lease-1',
    });
    const second = makeTaskRow({
      id: 'task-random-lease-2',
      taskKey: 'refund:order-1:random-lease-2',
      sequence: 20,
    });
    harness.tasks.push(first, second);

    const firstClaim = await (harness.service as any).claimTask(
      { ...first },
      false,
    );
    const secondClaim = await (harness.service as any).claimTask(
      { ...second },
      false,
    );

    expect(firstClaim.leaseId).toMatch(
      /^refund-compensation:[0-9a-f-]{36}$/,
    );
    expect(secondClaim.leaseId).toMatch(
      /^refund-compensation:[0-9a-f-]{36}$/,
    );
    expect(firstClaim.leaseId).not.toBe(secondClaim.leaseId);
    expect(harness.tasks.map((task) => task.lockedBy)).toEqual([
      firstClaim.leaseId,
      secondClaim.leaseId,
    ]);
  });

  it('rolls back MANUAL_REVIEW and item failure when the CRITICAL alert cannot persist', async () => {
    const harness = makeHarness();
    const leaseId = 'refund-compensation:manual-review';
    const task = makeTaskRow({
      id: 'task-manual-atomic',
      orderItemId: 'item-manual',
      status: RefundCompensationTaskStatus.RUNNING,
      attempts: 1,
      maxAttempts: 1,
      lockedAt: new Date(),
      lockedBy: leaseId,
    });
    harness.tasks.push(task);
    const claimed = {
      task: { ...task },
      leaseId,
    };
    let itemStatus: OrderItemStatus = OrderItemStatus.COMPENSATING;
    harness.prisma.orderItem.updateMany.mockImplementation(
      async () => {
        itemStatus = OrderItemStatus.COMPENSATION_FAILED;
        return { count: 1 };
      },
    );
    harness.alertCreates.mockRejectedValueOnce(
      new Error('alert database unavailable'),
    );
    harness.prisma.$transaction.mockImplementation(async (callback: any) => {
      const tasksBefore = harness.tasks.map((row) => ({ ...row }));
      const itemStatusBefore = itemStatus;
      try {
        return await callback({
          refundCompensationTask: harness.prisma.refundCompensationTask,
          orderItem: harness.prisma.orderItem,
          alertEvent: harness.prisma.alertEvent,
        });
      } catch (err) {
        harness.tasks.splice(0, harness.tasks.length, ...tasksBefore);
        itemStatus = itemStatusBefore;
        throw err;
      }
    });

    await expect(
      (harness.service as any).markTaskFailed(
        claimed,
        'compensation failed',
      ),
    ).rejects.toThrow('alert database unavailable');
    expect(harness.tasks[0]).toEqual(expect.objectContaining({
      status: RefundCompensationTaskStatus.RUNNING,
      lockedBy: leaseId,
    }));
    expect(itemStatus).toBe(OrderItemStatus.COMPENSATING);

    await expect(
      (harness.service as any).markTaskFailed(
        claimed,
        'compensation failed',
      ),
    ).resolves.toBe(true);
    expect(harness.tasks[0]).toEqual(expect.objectContaining({
      status: RefundCompensationTaskStatus.MANUAL_REVIEW,
      lockedAt: null,
      lockedBy: null,
      lastError: 'compensation failed',
    }));
    expect(itemStatus).toBe(OrderItemStatus.COMPENSATION_FAILED);
    expect(harness.alertCreates).toHaveBeenLastCalledWith({
      data: expect.objectContaining({
        category: AlertEventCategory.PAYMENT,
        severity: AlertEventSeverity.CRITICAL,
        title: '退款补偿进入人工处理',
        sourceType: 'order',
        sourceId: 'order-1',
        userId: 'user-1',
        context: expect.stringContaining('"taskId":"task-manual-atomic"'),
      }),
    });
  });

  it('keeps the item terminal marker atomic with the fenced task success write', async () => {
    const harness = makeHarness();
    const leaseId = 'refund-compensation:item-terminal';
    const task = makeTaskRow({
      id: 'task-item-terminal',
      orderItemId: 'item-terminal',
      taskKey: 'refund:order-1:item:item-terminal:mark:REFUNDED',
      action: RefundCompensationTaskAction.MARK_ORDER_ITEM_TERMINAL,
      status: RefundCompensationTaskStatus.RUNNING,
      attempts: 1,
      lockedAt: new Date(),
      lockedBy: leaseId,
      payload: { terminalStatus: OrderItemStatus.REFUNDED },
    });
    harness.tasks.push(task);
    const claimed = { task: { ...task }, leaseId };
    harness.prisma.orderItem.updateMany.mockRejectedValueOnce(
      new Error('item database unavailable'),
    );
    harness.prisma.$transaction.mockImplementation(async (callback: any) => {
      const tasksBefore = harness.tasks.map((row) => ({ ...row }));
      try {
        return await callback({
          refundCompensationTask: harness.prisma.refundCompensationTask,
          orderItem: harness.prisma.orderItem,
        });
      } catch (err) {
        harness.tasks.splice(0, harness.tasks.length, ...tasksBefore);
        throw err;
      }
    });

    await expect(
      (harness.service as any).markTaskSucceeded(claimed),
    ).rejects.toThrow('item database unavailable');
    expect(harness.tasks[0]).toEqual(expect.objectContaining({
      status: RefundCompensationTaskStatus.RUNNING,
      lockedBy: leaseId,
    }));

    await expect(
      (harness.service as any).markTaskSucceeded(claimed),
    ).resolves.toBe(true);
    expect(harness.tasks[0]).toEqual(expect.objectContaining({
      status: RefundCompensationTaskStatus.SUCCEEDED,
      lockedAt: null,
      lockedBy: null,
    }));
    expect(harness.prisma.orderItem.updateMany).toHaveBeenLastCalledWith({
      where: { id: 'item-terminal', orderId: 'order-1' },
      data: { status: OrderItemStatus.REFUNDED },
    });
  });

  it('does not execute later compensation steps while the first open task has a live lease', async () => {
    const harness = makeHarness();
    const now = new Date();
    harness.tasks.push(
      makeTaskRow({
        id: 'task-first-running',
        taskKey: 'refund:order-1:first',
        status: RefundCompensationTaskStatus.RUNNING,
        sequence: 10,
        lockedAt: now,
        lockedBy: 'refund-compensation:first-worker',
      }),
      makeTaskRow({
        id: 'task-second-pending',
        taskKey: 'refund:order-1:second',
        status: RefundCompensationTaskStatus.PENDING,
        sequence: 20,
      }),
    );

    const result = await harness.service.runOrderTasks('order-1');

    expect(result.complete).toBe(false);
    expect(result.executed).toBe(0);
    expect(harness.productSync.notifyCreditChanged).not.toHaveBeenCalled();
    expect(harness.tasks[1].status).toBe(
      RefundCompensationTaskStatus.PENDING,
    );
  });
});
