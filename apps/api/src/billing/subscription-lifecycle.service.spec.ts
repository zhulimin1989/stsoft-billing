import { Test } from '@nestjs/testing';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

function makePrisma() {
  const prisma: any = {
    subscriptionContract: {
      create: jest.fn(async ({ data }: any) => ({ id: 'contract-new', ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    subscriptionPeriod: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn(async ({ data }: any) => ({ id: 'period-new', ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    subscriptionEntitlement: {
      create: jest.fn(async ({ data }: any) => ({ id: 'entitlement-new', ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    codingPlanEntitlement: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(async ({ data }: any) => ({ id: 'coding-entitlement-new', ...data })),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
  };
  prisma.$executeRaw = jest.fn().mockResolvedValue(1);
  prisma.$transaction = jest.fn((fn: any) => fn(prisma));
  return prisma;
}

function makeRedis() {
  return {
    del: jest.fn().mockResolvedValue(1),
  };
}

async function buildService(prismaOverrides = {}, redisOverrides = {}) {
  const prisma = { ...makePrisma(), ...prismaOverrides };
  const redis = { ...makeRedis(), ...redisOverrides };
  const moduleRef = await Test.createTestingModule({
    providers: [
      SubscriptionLifecycleService,
      { provide: PrismaService, useValue: prisma },
      { provide: RedisService, useValue: redis },
    ],
  }).compile();
  return { service: moduleRef.get(SubscriptionLifecycleService), prisma, redis };
}

describe('SubscriptionLifecycleService', () => {
  it('activates a new contract, period, and entitlement after closing previous active period', async () => {
    const { service, prisma, redis } = await buildService();
    prisma.subscriptionPeriod.findMany.mockResolvedValueOnce([
      { id: 'period-old', contractId: 'contract-old', userId: 'u1', tenantId: 'tenant-1', productId: 'prod-1' },
    ]);
    const startedAt = new Date('2026-06-10T01:00:00.000Z');
    const expiresAt = new Date('2026-07-10T01:00:00.000Z');

    const result = await service.activate({
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba-1',
      productId: 'prod-1',
      planId: 'plan-1',
      billingPeriod: 'monthly',
      startedAt,
      expiresAt,
    });

    expect(result).toEqual({
      contractId: 'contract-new',
      periodId: 'period-new',
      entitlementId: 'entitlement-new',
    });
    expect(prisma.subscriptionEntitlement.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { periodId: { in: ['period-old'] }, status: 'ACTIVE' },
      data: expect.objectContaining({ status: 'EXPIRED', terminationReason: 'replaced_by_new_activation' }),
    }));
    expect(prisma.subscriptionContract.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ userId: 'u1', tenantId: 'tenant-1', billingAccountId: 'ba-1', productId: 'prod-1' }),
    }));
    expect(prisma.subscriptionPeriod.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ contractId: 'contract-new', planId: 'plan-1', expiresAt }),
    }));
    expect(prisma.subscriptionEntitlement.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ periodId: 'period-new', entitlementType: 'plan_access' }),
    }));
    expect(redis.del).toHaveBeenCalledWith('sub:tenant:tenant-1:prod-1');
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('replays a keyed activation without replacing the existing period', async () => {
    const { service, prisma } = await buildService();
    prisma.subscriptionPeriod.findUnique.mockResolvedValue({
      id: 'period-existing',
      contractId: 'contract-existing',
      userId: 'u1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      planId: 'plan-1',
      billingPeriod: 'monthly',
      entitlements: [{ id: 'entitlement-existing' }],
    });

    await expect(service.activate({
      userId: 'u1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      planId: 'plan-1',
      billingPeriod: 'monthly',
      startedAt: new Date(),
      expiresAt: null,
      activationIdempotencyKey: 'stripe-renewal:order-1:invoice:in-1:order',
    })).resolves.toEqual({
      contractId: 'contract-existing',
      periodId: 'period-existing',
      entitlementId: 'entitlement-existing',
    });

    expect(prisma.subscriptionContract.create).not.toHaveBeenCalled();
    expect(prisma.subscriptionPeriod.create).not.toHaveBeenCalled();
    expect(prisma.subscriptionEntitlement.updateMany).not.toHaveBeenCalled();
  });

  it('replays its own bundle activation before enforcing an empty active scope', async () => {
    const { service, prisma } = await buildService();
    prisma.subscriptionPeriod.findUnique.mockResolvedValue({
      id: 'period-existing',
      contractId: 'contract-existing',
      userId: 'u1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      planId: 'plan-1',
      billingPeriod: 'monthly',
      entitlements: [{ id: 'entitlement-existing' }],
    });
    prisma.subscriptionPeriod.findFirst.mockResolvedValue({
      id: 'period-existing',
    });

    await expect(service.activate({
      userId: 'u1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      planId: 'plan-1',
      billingPeriod: 'monthly',
      startedAt: new Date(),
      expiresAt: null,
      activationIdempotencyKey: 'bundle:order-1:item:item-1:activation',
      requireNoActiveSubscription: true,
    })).resolves.toEqual({
      contractId: 'contract-existing',
      periodId: 'period-existing',
      entitlementId: 'entitlement-existing',
    });

    expect(prisma.subscriptionPeriod.findFirst).not.toHaveBeenCalled();
    expect(prisma.subscriptionContract.create).not.toHaveBeenCalled();
  });

  it('rejects a new bundle activation when the product already has an active period', async () => {
    const { service, prisma } = await buildService();
    prisma.subscriptionPeriod.findFirst.mockResolvedValue({
      id: 'period-prior-purchase',
    });

    await expect(service.activate({
      userId: 'u1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      planId: 'plan-1',
      billingPeriod: 'monthly',
      startedAt: new Date(),
      expiresAt: null,
      activationIdempotencyKey: 'bundle:order-1:item:item-1:activation',
      requireNoActiveSubscription: true,
    })).rejects.toThrow(
      'Bundle subscription fulfillment requires an empty product entitlement scope',
    );

    expect(prisma.subscriptionContract.create).not.toHaveBeenCalled();
    expect(prisma.subscriptionPeriod.updateMany).not.toHaveBeenCalled();
  });

  it('atomically returns an existing active subscription without replacing it', async () => {
    const { service, prisma } = await buildService();
    prisma.subscriptionPeriod.findFirst.mockResolvedValue({
      id: 'period-paid',
      contractId: 'contract-paid',
      planId: 'plan-paid',
      provisionReceiptId: null,
      entitlements: [{ id: 'entitlement-paid' }],
    });

    await expect(service.activateIfAbsent({
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba-1',
      productId: 'prod-1',
      planId: 'plan-free',
      billingPeriod: 'monthly',
      startedAt: new Date(),
      expiresAt: null,
      provisionReceiptId: 'receipt-1',
    })).resolves.toEqual({
      contractId: 'contract-paid',
      periodId: 'period-paid',
      entitlementId: 'entitlement-paid',
      planId: 'plan-paid',
      provisionReceiptId: null,
      created: false,
    });

    expect(prisma.subscriptionContract.create).not.toHaveBeenCalled();
    expect(prisma.subscriptionPeriod.updateMany).not.toHaveBeenCalled();
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('links an absent subscription to the exact provision receipt', async () => {
    const { service, prisma } = await buildService();

    const result = await service.activateIfAbsent({
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba-1',
      productId: 'prod-1',
      planId: 'plan-free',
      billingPeriod: 'monthly',
      startedAt: new Date(),
      expiresAt: null,
      provisionReceiptId: 'receipt-1',
    });

    expect(result).toEqual(expect.objectContaining({
      periodId: 'period-new',
      provisionReceiptId: 'receipt-1',
      created: true,
    }));
    expect(prisma.subscriptionPeriod.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        provisionReceiptId: 'receipt-1',
      }),
    }));
  });

  it('does not renew or replace an existing paid self-operated Coding Plan entitlement', async () => {
    const { service, prisma } = await buildService();
    prisma.codingPlanEntitlement.findFirst.mockResolvedValue({
      id: 'coding-paid',
      orderId: 'paid-order-1',
      userId: 'u1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      planId: 'plan-paid',
      provisionReceiptId: null,
      fulfillmentMode: 'platform_model_package',
      status: 'ACTIVE',
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      startedAt: new Date('2026-01-01T00:00:00.000Z'),
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
    });

    await expect(service.activateCodingPlanIfAbsent({
      userId: 'u1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      planId: 'plan-free',
      startedAt: new Date(),
      expiresAt: null,
      provisionReceiptId: 'receipt-1',
    })).resolves.toEqual(expect.objectContaining({
      id: 'coding-paid',
      planId: 'plan-paid',
      provisionReceiptId: null,
      created: false,
    }));
    expect(prisma.codingPlanEntitlement.create).not.toHaveBeenCalled();
  });

  it('creates an independently idempotent self-operated Coding Plan entitlement', async () => {
    const { service, prisma } = await buildService();

    await expect(service.activateCodingPlanIfAbsent({
      userId: 'u1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      planId: 'plan-free',
      startedAt: new Date('2026-07-01T00:00:00.000Z'),
      expiresAt: new Date('2026-08-01T00:00:00.000Z'),
      provisionReceiptId: 'receipt-1',
    })).resolves.toEqual(expect.objectContaining({
      id: 'coding-entitlement-new',
      planId: 'plan-free',
      provisionReceiptId: 'receipt-1',
      created: true,
    }));
    expect(prisma.codingPlanEntitlement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'saas-provision:receipt-1',
        provisionReceiptId: 'receipt-1',
        fulfillmentMode: 'platform_model_package',
        status: 'ACTIVE',
      }),
    });
  });

  it('re-reads the authoritative Coding Plan entitlement under the paid activation lock', async () => {
    const { service, prisma } = await buildService();
    prisma.codingPlanEntitlement.findFirst.mockResolvedValue({
      id: 'coding-paid-replacement',
      orderId: 'paid-order-2',
      userId: 'u1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      planId: 'plan-paid',
      provisionReceiptId: null,
      fulfillmentMode: 'platform_model_package',
      status: 'ACTIVE',
      expiresAt: null,
      startedAt: new Date(),
      createdAt: new Date(),
    });
    const observed = await service.withCurrentActiveCodingPlanEntitlement(
      'tenant-1',
      'prod-1',
      async (current) => current,
    );

    expect(observed).toEqual(expect.objectContaining({
      id: 'coding-paid-replacement',
      planId: 'plan-paid',
      provisionReceiptId: null,
    }));
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('closes active period, entitlement, and contract for cancellation', async () => {
    const { service, prisma } = await buildService();
    prisma.subscriptionPeriod.findMany.mockResolvedValue([
      { id: 'period-1', contractId: 'contract-1', userId: 'u1', tenantId: 'tenant-1', productId: 'prod-1' },
    ]);

    const count = await service.closeActive({
      tenantId: 'tenant-1',
      productId: 'prod-1',
      planId: 'plan-1',
      status: 'CANCELLED',
      endedAt: new Date('2026-06-10T02:00:00.000Z'),
      terminationReason: 'order_refunded',
    });

    expect(count).toBe(1);
    expect(prisma.subscriptionPeriod.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: 'tenant-1', productId: 'prod-1', planId: 'plan-1', status: 'ACTIVE' }),
    }));
    expect(prisma.subscriptionPeriod.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'CANCELLED', terminationReason: 'order_refunded' }),
    }));
    expect(prisma.subscriptionContract.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ['contract-1'] }, status: 'ACTIVE' },
      data: expect.objectContaining({ status: 'CANCELLED' }),
    }));
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('closes only the period anchored by an activation idempotency key', async () => {
    const { service, prisma, redis } = await buildService();
    prisma.subscriptionPeriod.findUnique.mockResolvedValue({
      id: 'period-checkout',
      contractId: 'contract-checkout',
      userId: 'u1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      planId: 'plan-1',
      status: 'ACTIVE',
    });

    await expect(service.closeActivation({
      activationIdempotencyKey: 'checkout:order-1:activation',
      userId: 'u1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      planId: 'plan-1',
      endedAt: new Date('2026-06-10T02:00:00.000Z'),
      terminationReason: 'order_refunded',
    })).resolves.toBe(true);

    expect(prisma.subscriptionPeriod.updateMany).toHaveBeenCalledWith({
      where: { id: 'period-checkout', status: 'ACTIVE' },
      data: expect.objectContaining({
        status: 'CANCELLED',
        terminationReason: 'order_refunded',
      }),
    });
    expect(prisma.subscriptionContract.updateMany).toHaveBeenCalledWith({
      where: { id: 'contract-checkout', status: 'ACTIVE' },
      data: expect.objectContaining({ status: 'CANCELLED' }),
    });
    expect(redis.del).toHaveBeenCalledWith('sub:tenant:tenant-1:prod-1');
  });

  it('rejects an activation cancellation when its subject does not match', async () => {
    const { service, prisma } = await buildService();
    prisma.subscriptionPeriod.findUnique.mockResolvedValue({
      id: 'period-checkout',
      contractId: 'contract-checkout',
      userId: 'different-user',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      planId: 'plan-1',
      status: 'ACTIVE',
    });

    await expect(service.closeActivation({
      activationIdempotencyKey: 'checkout:order-1:activation',
      userId: 'u1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      planId: 'plan-1',
      endedAt: new Date(),
      terminationReason: 'order_refunded',
    })).rejects.toThrow('Subscription activation cancellation payload mismatch');
    expect(prisma.subscriptionPeriod.updateMany).not.toHaveBeenCalled();
  });

  it('closes the latest period in one checkout activation family', async () => {
    const { service, prisma, redis } = await buildService();
    const endedAt = new Date('2026-06-10T02:00:00.000Z');
    prisma.subscriptionPeriod.findFirst.mockResolvedValue({
      id: 'period-renewal',
      contractId: 'contract-renewal',
      status: 'ACTIVE',
    });

    await expect(service.closeActivationFamily({
      initialActivationIdempotencyKey: 'checkout:order-1:activation',
      renewalActivationIdempotencyPrefix: 'stripe-renewal:order-1:',
      userId: 'u1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      planId: 'plan-1',
      endedAt,
      terminationReason: 'stripe_subscription_canceled',
    })).resolves.toBe(true);

    expect(prisma.subscriptionPeriod.findFirst).toHaveBeenCalledWith({
      where: {
        userId: 'u1',
        tenantId: 'tenant-1',
        productId: 'prod-1',
        planId: 'plan-1',
        OR: [
          {
            activationIdempotencyKey: 'checkout:order-1:activation',
          },
          {
            activationIdempotencyKey: {
              startsWith: 'stripe-renewal:order-1:',
            },
          },
        ],
      },
      orderBy: [{ startedAt: 'desc' }, { createdAt: 'desc' }],
      select: {
        id: true,
        contractId: true,
        status: true,
      },
    });
    expect(prisma.subscriptionEntitlement.updateMany).toHaveBeenCalledWith({
      where: { periodId: 'period-renewal', status: 'ACTIVE' },
      data: {
        status: 'CANCELLED',
        endedAt,
        terminationReason: 'stripe_subscription_canceled',
      },
    });
    expect(prisma.subscriptionPeriod.updateMany).toHaveBeenCalledWith({
      where: { id: 'period-renewal', status: 'ACTIVE' },
      data: {
        status: 'CANCELLED',
        endedAt,
        terminationReason: 'stripe_subscription_canceled',
      },
    });
    expect(prisma.subscriptionContract.updateMany).toHaveBeenCalledWith({
      where: { id: 'contract-renewal', status: 'ACTIVE' },
      data: {
        status: 'CANCELLED',
        endedAt,
        terminationReason: 'stripe_subscription_canceled',
      },
    });
    expect(redis.del).toHaveBeenCalledWith('sub:tenant:tenant-1:prod-1');
    expect(prisma.$executeRaw).toHaveBeenCalledTimes(1);
  });

  it('treats an already closed activation family as an idempotent success', async () => {
    const { service, prisma } = await buildService();
    prisma.subscriptionPeriod.findFirst.mockResolvedValue({
      id: 'period-renewal',
      contractId: 'contract-renewal',
      status: 'CANCELLED',
    });

    await expect(service.closeActivationFamily({
      initialActivationIdempotencyKey: 'checkout:order-1:activation',
      renewalActivationIdempotencyPrefix: 'stripe-renewal:order-1:',
      userId: 'u1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      planId: 'plan-1',
      endedAt: new Date(),
      terminationReason: 'stripe_subscription_canceled',
    })).resolves.toBe(true);

    expect(prisma.subscriptionEntitlement.updateMany).not.toHaveBeenCalled();
    expect(prisma.subscriptionPeriod.updateMany).not.toHaveBeenCalled();
    expect(prisma.subscriptionContract.updateMany).not.toHaveBeenCalled();
  });

  it('returns false instead of broadly closing when an activation family is missing', async () => {
    const { service, prisma } = await buildService();
    prisma.subscriptionPeriod.findFirst.mockResolvedValue(null);

    await expect(service.closeActivationFamily({
      initialActivationIdempotencyKey: 'checkout:order-1:activation',
      renewalActivationIdempotencyPrefix: 'stripe-renewal:order-1:',
      userId: 'u1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      planId: 'plan-1',
      endedAt: new Date(),
      terminationReason: 'stripe_subscription_canceled',
    })).resolves.toBe(false);

    expect(prisma.subscriptionPeriod.findMany).not.toHaveBeenCalled();
    expect(prisma.subscriptionPeriod.updateMany).not.toHaveBeenCalled();
  });

  it('uses the same tenant/product advisory lock for activate, ensure, and explicit close', async () => {
    const { service, prisma } = await buildService();
    const input = {
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba-1',
      productId: 'prod-1',
      planId: 'plan-1',
      billingPeriod: 'monthly' as const,
      startedAt: new Date(),
      expiresAt: null,
    };

    await service.activate(input);
    await service.activateIfAbsent(input);
    await service.closeActive({
      tenantId: 'tenant-1',
      productId: 'prod-1',
      status: 'CANCELLED',
      endedAt: new Date(),
      terminationReason: 'test',
    });
    await service.closeActivationFamily({
      initialActivationIdempotencyKey: 'checkout:order-1:activation',
      renewalActivationIdempotencyPrefix: 'stripe-renewal:order-1:',
      userId: 'u1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      planId: 'plan-1',
      endedAt: new Date(),
      terminationReason: 'test',
    });

    expect(prisma.$executeRaw).toHaveBeenCalledTimes(4);
    const lockArguments = prisma.$executeRaw.mock.calls.map((call: unknown[]) => call.slice(1));
    expect(lockArguments[0]).toEqual(lockArguments[1]);
    expect(lockArguments[1]).toEqual(lockArguments[2]);
    expect(lockArguments[2]).toEqual(lockArguments[3]);
  });

  it('expires due active periods and leaves non-due periods untouched', async () => {
    const { service, prisma } = await buildService();
    prisma.subscriptionPeriod.findMany.mockResolvedValue([
      { id: 'period-due', contractId: 'contract-due', userId: 'u1', tenantId: 'tenant-1', productId: 'prod-1' },
    ]);
    const now = new Date('2026-06-10T03:00:00.000Z');

    const expired = await service.expireDue(now);

    expect(expired).toHaveLength(1);
    expect(prisma.subscriptionPeriod.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { status: 'ACTIVE', expiresAt: { lt: now, not: null } },
    }));
    expect(prisma.subscriptionEntitlement.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { periodId: { in: ['period-due'] }, status: 'ACTIVE' },
      data: expect.objectContaining({ status: 'EXPIRED', terminationReason: 'period_expired' }),
    }));
    expect(prisma.subscriptionContract.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: { in: ['contract-due'] }, status: 'ACTIVE' },
      data: expect.objectContaining({ status: 'EXPIRED' }),
    }));
  });
});
