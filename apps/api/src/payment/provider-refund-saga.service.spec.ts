import {
  OrderStatus,
  OrderType,
  PayChannel,
  ProviderRefundIntentStatus,
} from '@prisma/client';
import { ProviderRefundSagaService } from './provider-refund-saga.service';

function makeIntent(overrides: Record<string, unknown> = {}) {
  const now = new Date('2026-07-24T00:00:00.000Z');
  return {
    id: 'intent-1',
    orderId: 'order-1',
    channel: PayChannel.WECHAT,
    tradeNo: 'wx-trade-1',
    requestNo: 'refund_order-1_9900',
    providerRefundId: null,
    amountCents: 9900,
    currency: 'USD',
    reason: 'refund',
    paymentProviderInstanceId: null,
    skipEntitlementCompensation: false,
    skipRechargeBalanceCompensation: false,
    preflightCompletedAt: now,
    status: ProviderRefundIntentStatus.PREPARED,
    providerStatus: null,
    providerAttemptedAt: null,
    providerConfirmedAt: null,
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

function makePrisma() {
  const refundCompensation = {
    claimUnusedSelfOperatedCodingPlanRefundHold: jest.fn().mockResolvedValue(undefined),
    releaseUnusedSelfOperatedCodingPlanRefundHold: jest.fn().mockResolvedValue(null),
    resyncReleasedSelfOperatedCodingPlanRefundHold: jest.fn().mockResolvedValue(undefined),
  };
  const intent = {
    findUnique: jest.fn(),
    findUniqueOrThrow: jest.fn(),
    findMany: jest.fn(),
    create: jest.fn(),
    updateMany: jest.fn(),
  };
  const tx = {
    order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
    orderAuditLog: { create: jest.fn().mockResolvedValue({}) },
    providerRefundIntent: {
      create: jest.fn().mockResolvedValue(makeIntent()),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    alertEvent: { create: jest.fn().mockResolvedValue({}) },
    balanceTransaction: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    balanceGrant: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
  return {
    providerRefundIntent: intent,
    $transaction: jest.fn(async (callback: (client: typeof tx) => unknown) =>
      callback(tx)),
    refundCompensation,
    tx,
  };
}

function makeService(prisma: ReturnType<typeof makePrisma>) {
  return new ProviderRefundSagaService(
    prisma as any,
    prisma.refundCompensation as any,
  );
}

function prepareInput() {
  return {
    orderId: 'order-1',
    fromStatus: OrderStatus.COMPLETED,
    orderType: OrderType.SUBSCRIPTION,
    channel: PayChannel.WECHAT,
    tradeNo: 'wx-trade-1',
    requestNo: 'refund_order-1_9900',
    amountCents: 9900,
    currency: 'usd',
    reason: 'refund',
    preflightCompletedAt: new Date('2026-07-24T00:00:00.000Z'),
  };
}

describe('ProviderRefundSagaService', () => {
  it('commits the order CAS and durable intent in one transaction', async () => {
    const prisma = makePrisma();
    const service = makeService(prisma);

    await service.claimOrderAndPrepare(prepareInput());

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.tx.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', status: OrderStatus.COMPLETED },
      data: expect.objectContaining({
        status: OrderStatus.REFUNDING,
        refundAmountCents: 9900,
      }),
    });
    expect(prisma.tx.providerRefundIntent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'order-1',
        requestNo: 'refund_order-1_9900',
        status: ProviderRefundIntentStatus.PREPARED,
      }),
    });
  });

  it('freezes an unused self-operated entitlement before creating the durable intent', async () => {
    const prisma = makePrisma();
    const service = makeService(prisma);
    const evidence = {
      orderId: 'order-1',
      entitlementId: 'entitlement-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'product-1',
      planId: 'plan-1',
      grantId: 'grant-1',
      grantIdempotencyKey: 'checkout:order-1',
      grantCredits: 1000,
      grantBalanceVersion: 1n,
    };

    await service.claimOrderAndPrepare({
      ...prepareInput(),
      selfOperatedCodingPlanRefund: evidence,
    });

    expect(
      prisma.refundCompensation
        .claimUnusedSelfOperatedCodingPlanRefundHold,
    ).toHaveBeenCalledWith(
      prisma.tx,
      'order-1',
      9900,
      evidence,
    );
    expect(
      prisma.refundCompensation
        .claimUnusedSelfOperatedCodingPlanRefundHold.mock.invocationCallOrder[0],
    ).toBeLessThan(
      prisma.tx.providerRefundIntent.create.mock.invocationCallOrder[0],
    );
  });

  it('rolls the transaction back when the durable intent cannot be created', async () => {
    const prisma = makePrisma();
    prisma.tx.providerRefundIntent.create.mockRejectedValue(
      new Error('intent insert failed'),
    );
    const service = makeService(prisma);

    await expect(
      service.claimOrderAndPrepare(prepareInput()),
    ).rejects.toThrow('intent insert failed');
    expect(prisma.tx.orderAuditLog.create).not.toHaveBeenCalled();
  });

  it('rolls back a recharge claim when no-effect evidence changes in the transaction', async () => {
    const prisma = makePrisma();
    prisma.tx.balanceTransaction.findFirst.mockResolvedValue({
      id: 'late-wallet-effect',
    });
    const service = makeService(prisma);

    await expect(
      service.claimOrderAndPrepare({
        ...prepareInput(),
        orderType: OrderType.RECHARGE,
        skipRechargeBalanceCompensation: true,
        requireNoRechargeWalletEffects: true,
      }),
    ).rejects.toThrow('recharge effects appeared during claim');
    expect(prisma.tx.providerRefundIntent.create).not.toHaveBeenCalled();
  });

  it('fences every claimed task with a unique lease', async () => {
    const prisma = makePrisma();
    const task = makeIntent();
    prisma.providerRefundIntent.findUnique.mockResolvedValue(task);
    prisma.providerRefundIntent.updateMany.mockResolvedValue({ count: 1 });
    prisma.providerRefundIntent.findUniqueOrThrow.mockResolvedValue({
      ...task,
      status: ProviderRefundIntentStatus.RUNNING,
      attempts: 1,
    });
    const service = makeService(prisma);

    const claimed = await service.claim(task.id);

    expect(claimed?.leaseId).toMatch(/^provider-refund:/);
    expect(prisma.providerRefundIntent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: task.id,
          status: ProviderRefundIntentStatus.PREPARED,
          updatedAt: task.updatedAt,
        }),
        data: expect.objectContaining({
          status: ProviderRefundIntentStatus.RUNNING,
          lockedBy: claimed?.leaseId,
        }),
      }),
    );
  });

  it('does not let a stale worker write after another lease reclaimed the task', async () => {
    const prisma = makePrisma();
    prisma.tx.providerRefundIntent.updateMany.mockResolvedValue({ count: 0 });
    const service = makeService(prisma);
    const task = makeIntent({
      status: ProviderRefundIntentStatus.RUNNING,
      attempts: 1,
      lockedBy: 'new-worker',
      lockedAt: new Date(),
    });

    await expect(
      service.recordProviderOutcome(
        {
          task: task as any,
          leaseId: 'stale-worker',
          previousStatus: ProviderRefundIntentStatus.PREPARED,
        },
        {
          state: 'SUCCEEDED',
          providerStatus: 'SUCCESS',
          refundId: 'wx-refund-1',
        },
      ),
    ).rejects.toThrow('provider refund lease lost');
  });

  it('keeps PROCESSING pending without provider confirmation', async () => {
    const prisma = makePrisma();
    prisma.tx.providerRefundIntent.updateMany.mockResolvedValue({ count: 1 });
    const service = makeService(prisma);
    const task = makeIntent({
      status: ProviderRefundIntentStatus.RUNNING,
      attempts: 1,
      lockedBy: 'lease-1',
      lockedAt: new Date(),
    });

    const status = await service.recordProviderOutcome(
      {
        task: task as any,
        leaseId: 'lease-1',
        previousStatus: ProviderRefundIntentStatus.PREPARED,
      },
      {
        state: 'PENDING',
        providerStatus: 'PROCESSING',
        refundId: 'wx-refund-1',
      },
    );

    expect(status).toBe(ProviderRefundIntentStatus.PENDING_PROVIDER);
    expect(prisma.tx.providerRefundIntent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: ProviderRefundIntentStatus.PENDING_PROVIDER,
          providerConfirmedAt: null,
        }),
      }),
    );
  });

  it('atomically records a terminal provider rejection with the order failure transition', async () => {
    const prisma = makePrisma();
    prisma.refundCompensation.releaseUnusedSelfOperatedCodingPlanRefundHold
      .mockResolvedValue('entitlement-1');
    const service = makeService(prisma);
    const task = makeIntent({
      status: ProviderRefundIntentStatus.RUNNING,
      attempts: 1,
      lockedBy: 'lease-1',
      lockedAt: new Date(),
    });

    const status = await service.recordProviderOutcome(
      {
        task: task as any,
        leaseId: 'lease-1',
        previousStatus: ProviderRefundIntentStatus.PREPARED,
      },
      {
        state: 'FAILED',
        providerStatus: 'CLOSED',
        error: 'provider rejected refund',
      },
    );

    expect(status).toBe(ProviderRefundIntentStatus.PROVIDER_FAILED);
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.tx.providerRefundIntent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: ProviderRefundIntentStatus.PROVIDER_FAILED,
        }),
      }),
    );
    expect(prisma.tx.order.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'order-1',
        status: OrderStatus.REFUNDING,
      },
      data: { status: OrderStatus.REFUND_FAILED },
    });
    expect(prisma.tx.orderAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'order-1',
        fromStatus: OrderStatus.REFUNDING,
        toStatus: OrderStatus.REFUND_FAILED,
      }),
    });
    expect(
      prisma.refundCompensation.releaseUnusedSelfOperatedCodingPlanRefundHold,
    ).toHaveBeenCalledWith(prisma.tx, 'order-1');
    expect(
      prisma.refundCompensation.resyncReleasedSelfOperatedCodingPlanRefundHold,
    ).toHaveBeenCalledWith('entitlement-1');
  });

  it('rolls back the terminal intent write when the order failure CAS is lost', async () => {
    const prisma = makePrisma();
    prisma.tx.order.updateMany.mockResolvedValue({ count: 0 });
    const service = makeService(prisma);
    const task = makeIntent({
      status: ProviderRefundIntentStatus.RUNNING,
      attempts: 1,
      lockedBy: 'lease-1',
      lockedAt: new Date(),
    });

    await expect(service.recordProviderOutcome(
      {
        task: task as any,
        leaseId: 'lease-1',
        previousStatus: ProviderRefundIntentStatus.PREPARED,
      },
      {
        state: 'FAILED',
        providerStatus: 'CLOSED',
      },
    )).rejects.toThrow('order transition conflict');
    expect(prisma.tx.orderAuditLog.create).not.toHaveBeenCalled();
  });

  it('persists a CRITICAL alert in the same transaction on manual review', async () => {
    const prisma = makePrisma();
    const service = makeService(prisma);
    const task = makeIntent({
      status: ProviderRefundIntentStatus.RUNNING,
      attempts: 12,
      lockedBy: 'lease-1',
      lockedAt: new Date(),
    });

    const status = await service.recordProviderOutcome(
      {
        task: task as any,
        leaseId: 'lease-1',
        previousStatus: ProviderRefundIntentStatus.PENDING_PROVIDER,
      },
      {
        state: 'UNKNOWN',
        providerStatus: 'REQUEST_OUTCOME_UNKNOWN',
        error: 'query timed out',
      },
    );

    expect(status).toBe(ProviderRefundIntentStatus.MANUAL_REVIEW);
    expect(prisma.tx.alertEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        category: 'PAYMENT',
        severity: 'CRITICAL',
        sourceType: 'order',
        sourceId: 'order-1',
      }),
    });
  });
});
