import { Test } from '@nestjs/testing';
import {
  SubscriptionResolverService,
  ResolvedSubscription,
} from './subscription-resolver.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

// ============================================================
// Shared builder
// ============================================================

function makeRedis() {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    sadd: jest.fn().mockResolvedValue(1),
    smembers: jest.fn().mockResolvedValue([]),
    srem: jest.fn().mockResolvedValue(1),
  };
}

function makePrisma() {
  return {
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    tenant: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    tenantMember: {
      findFirst: jest.fn(async ({ where }: any) => ({ tenantId: `tenant-${where.userId}` })),
    },
    subscriptionPeriod: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
  };
}

async function buildService(prismaOverrides = {}, redisOverrides = {}) {
  const prisma = { ...makePrisma(), ...prismaOverrides };
  const redis = { ...makeRedis(), ...redisOverrides };

  const m = await Test.createTestingModule({
    providers: [
      SubscriptionResolverService,
      { provide: PrismaService, useValue: prisma },
      { provide: RedisService, useValue: redis },
    ],
  }).compile();

  return {
    service: m.get(SubscriptionResolverService) as SubscriptionResolverService,
    prisma,
    redis,
  };
}

function makePlan() {
  return {
    id: 'plan-1',
    name: 'Pro',
    monthlyCredits: 1000,
    usageMultiplier: 1.0,
    rateLimitRpm: 60,
    rateLimitTpm: 100000,
    maxContextWindow: 128000,
  };
}

function makePeriod(overrides: Record<string, unknown> = {}) {
  return {
    id: 'period-1',
    userId: 'user-1',
    productId: 'prod-1',
    planId: 'plan-1',
    status: 'ACTIVE',
    tenantId: 'tenant-user-1',
    expiresAt: null,
    plan: makePlan(),
    ...overrides,
  };
}

// ============================================================
// SubscriptionResolverService.resolve — cache miss path
// ============================================================

describe('SubscriptionResolverService.resolve — DB path', () => {
  it('returns null when no active subscription found in DB', async () => {
    const { service, prisma, redis } = await buildService();
    redis.get.mockResolvedValue(null);
    prisma.subscriptionPeriod.findFirst.mockResolvedValue(null);

    const r = await service.resolve('u1', 'prod-1');
    expect(r).toBeNull();
    // Should cache 'none' with EX 600
    expect(redis.set).toHaveBeenCalledWith('sub:tenant:tenant-u1:prod-1', 'none', 'EX', 600);
  });

  it('returns null and caches "none" when subscription is expired', async () => {
    const { service, redis, prisma } = await buildService();
    redis.get.mockResolvedValue(null);
    prisma.subscriptionPeriod.findFirst.mockResolvedValue(null);

    const r = await service.resolve('u1', 'prod-1');
    expect(r).toBeNull();
    expect(redis.set).toHaveBeenCalledWith('sub:tenant:tenant-u1:prod-1', 'none', 'EX', 600);
  });

  it('returns resolved subscription with plan details when DB has active sub', async () => {
    const { service, redis, prisma } = await buildService();
    redis.get.mockResolvedValue(null);
    prisma.subscriptionPeriod.findFirst.mockResolvedValue(makePeriod());

    const r = await service.resolve('user-1', 'prod-1');

    expect(r).not.toBeNull();
    expect(r!.subscriptionId).toBe('period-1');
    expect(r!.planId).toBe('plan-1');
    expect(r!.productId).toBe('prod-1');
    expect(r!.plan.name).toBe('Pro');
    expect(r!.plan.monthlyCredits).toBe(1000);
  });

  it('caches the resolved subscription as JSON with EX 600', async () => {
    const { service, redis, prisma } = await buildService();
    redis.get.mockResolvedValue(null);
    prisma.subscriptionPeriod.findFirst.mockResolvedValue(makePeriod());

    await service.resolve('user-1', 'prod-1');

    const cached = redis.set.mock.calls.find(
      (c: unknown[]) => c[0] === 'sub:tenant:tenant-user-1:prod-1',
    );
    expect(cached).toBeDefined();
    expect(cached![2]).toBe('EX');
    expect(cached![3]).toBe(600);
    const parsed = JSON.parse(cached![1] as string);
    expect(parsed.subscriptionId).toBe('period-1');
  });

  it('queries DB with resolved personal tenant scope when no tenant is requested', async () => {
    const { service, redis, prisma } = await buildService();
    redis.get.mockResolvedValue(null);
    prisma.tenant.findFirst.mockResolvedValue({ id: 'tenant-personal' });
    prisma.subscriptionPeriod.findFirst.mockResolvedValue(null);

    await service.resolve('user-42', 'product-99');

    expect(prisma.subscriptionPeriod.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          tenantId: 'tenant-personal',
          productId: 'product-99',
          status: 'ACTIVE',
        }),
      }),
    );
  });

  it('returns valid subscription even when expiresAt is in the future', async () => {
    const { service, redis, prisma } = await buildService();
    redis.get.mockResolvedValue(null);
    const futureDate = new Date(Date.now() + 365 * 24 * 60 * 60 * 1000);
    prisma.subscriptionPeriod.findFirst.mockResolvedValue(
      makePeriod({ expiresAt: futureDate }),
    );

    const r = await service.resolve('user-1', 'prod-1');
    expect(r).not.toBeNull();
    expect(r!.subscriptionId).toBe('period-1');
  });
});

// ============================================================
// SubscriptionResolverService.resolve — cache hit path
// ============================================================

describe('SubscriptionResolverService.resolve — cache hit path', () => {
  it('returns null immediately when cache contains "none"', async () => {
    const { service, redis, prisma } = await buildService();
    redis.get.mockResolvedValue('none');

    const r = await service.resolve('u1', 'prod-1');
    expect(r).toBeNull();
    expect(prisma.subscriptionPeriod.findFirst).not.toHaveBeenCalled();
  });

  it('returns parsed ResolvedSubscription from cache without hitting DB', async () => {
    const { service, redis, prisma } = await buildService();
    const cached: ResolvedSubscription = {
      subscriptionId: 'sub-cached',
      planId: 'plan-cached',
      productId: 'prod-cached',
      billingPeriod: 'monthly',
      plan: {
        id: 'plan-cached',
        name: 'Cached Plan',
        monthlyCredits: 500,
        usageMultiplier: 1.5,
        rateLimitRpm: 30,
        rateLimitTpm: 50000,
        maxContextWindow: 64000,
      },
    };
    redis.get.mockResolvedValue(JSON.stringify(cached));

    const r = await service.resolve('u1', 'prod-1');
    expect(r).not.toBeNull();
    expect(r!.subscriptionId).toBe('sub-cached');
    expect(r!.plan.usageMultiplier).toBe(1.5);
    expect(prisma.subscriptionPeriod.findFirst).not.toHaveBeenCalled();
  });

  it('falls through to DB when cached value is invalid JSON', async () => {
    const { service, redis, prisma } = await buildService();
    redis.get.mockResolvedValue('{{invalid json}}');
    prisma.subscriptionPeriod.findFirst.mockResolvedValue(null);

    // Should not throw, should fall through to DB
    const r = await service.resolve('u1', 'prod-1');
    expect(r).toBeNull();
    expect(prisma.subscriptionPeriod.findFirst).toHaveBeenCalled();
  });
});

// ============================================================
// SubscriptionResolverService.resolve — multi-product isolation
// ============================================================

describe('SubscriptionResolverService.resolve — multi-product isolation', () => {
  it('uses different cache keys for different productIds', async () => {
    const { service, redis, prisma } = await buildService();
    redis.get.mockResolvedValue(null);
    prisma.subscriptionPeriod.findFirst.mockResolvedValue(null);

    await service.resolve('u1', 'prod-A');
    await service.resolve('u1', 'prod-B');

    const getCalls = redis.get.mock.calls.map((c: unknown[]) => c[0]);
    expect(getCalls).toContain('sub:tenant:tenant-u1:prod-A');
    expect(getCalls).toContain('sub:tenant:tenant-u1:prod-B');
    // Separate DB queries for each product
    expect(prisma.subscriptionPeriod.findFirst).toHaveBeenCalledTimes(2);
  });

  it('uses different cache keys for different userIds', async () => {
    const { service, redis, prisma } = await buildService();
    redis.get.mockResolvedValue(null);
    prisma.subscriptionPeriod.findFirst.mockResolvedValue(null);

    await service.resolve('user-A', 'prod-1');
    await service.resolve('user-B', 'prod-1');

    const getCalls = redis.get.mock.calls.map((c: unknown[]) => c[0]);
    expect(getCalls).toContain('sub:tenant:tenant-user-A:prod-1');
    expect(getCalls).toContain('sub:tenant:tenant-user-B:prod-1');
  });
});

// ============================================================
// SubscriptionResolverService.invalidateCache
// ============================================================

describe('SubscriptionResolverService.invalidateCache', () => {
  it('deletes the correct Redis key', async () => {
    const { service, redis } = await buildService();

    await service.invalidateCache('user-1', 'prod-1');

    expect(redis.del).toHaveBeenCalledWith('sub:user-1:prod-1');
    expect(redis.del).toHaveBeenCalledWith('sub:user:user-1:prod-1');
  });

  it('calls del with the correct composite key format', async () => {
    const { service, redis } = await buildService();

    await service.invalidateCache('user-xyz', 'prod-abc');

    expect(redis.del).toHaveBeenCalledWith('sub:user-xyz:prod-abc');
    expect(redis.del).toHaveBeenCalledWith('sub:user:user-xyz:prod-abc');
    expect(redis.del).toHaveBeenCalledTimes(2);
  });

  it('deletes an entitlement-specific coding plan cache key when entitlementId is provided', async () => {
    const { service, redis } = await buildService();

    await service.invalidateCache('user-1', 'prod-1', 'tenant-1', 'ent-1');

    expect(redis.del).toHaveBeenCalledWith('sub:tenant:tenant-1:prod-1');
    expect(redis.del).toHaveBeenCalledWith('sub:tenant:tenant-1:prod-1:entitlement:ent-1');
    expect(redis.srem).toHaveBeenCalledWith('sub:tenant:tenant-1:prod-1:entitlements', 'ent-1');
  });

  it('deletes known entitlement-specific coding plan cache keys on broad invalidation', async () => {
    const { service, redis } = await buildService(
      {},
      { smembers: jest.fn().mockResolvedValue(['ent-1', 'ent-2']) },
    );

    await service.invalidateCache('user-1', 'prod-1', 'tenant-1');

    expect(redis.smembers).toHaveBeenCalledWith('sub:tenant:tenant-1:prod-1:entitlements');
    expect(redis.del).toHaveBeenCalledWith(
      'sub:tenant:tenant-1:prod-1:entitlement:ent-1',
      'sub:tenant:tenant-1:prod-1:entitlement:ent-2',
    );
    expect(redis.del).toHaveBeenCalledWith('sub:tenant:tenant-1:prod-1:entitlements');
  });
});

describe('SubscriptionResolverService.resolve — coding plan cache registry', () => {
  it('registers resolved coding plan entitlement ids for later broad invalidation', async () => {
    const plan = makePlan();
    const { service, redis } = await buildService({
      product: {
        findUnique: jest.fn().mockResolvedValue({ billingMode: 'CODING_PLAN' }),
      },
      codingPlanEntitlement: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'ent-1',
          planId: 'plan-1',
          productId: 'prod-1',
          billingPeriod: 'month',
          fulfillmentMode: 'platform_model_package',
          providerEntitlementId: null,
        }),
      },
      plan: {
        findUnique: jest.fn().mockResolvedValue(plan),
      },
    });

    await service.resolve('user-1', 'prod-1', { tenantId: 'tenant-1', codingPlanEntitlementId: 'ent-1' });

    expect(redis.set).toHaveBeenCalledWith(
      'sub:tenant:tenant-1:prod-1:entitlement:ent-1',
      expect.any(String),
      'EX',
      600,
    );
    expect(redis.sadd).toHaveBeenCalledWith('sub:tenant:tenant-1:prod-1:entitlements', 'ent-1');
  });
});

// ============================================================
// SubscriptionResolverService — plan field mapping
// ============================================================

describe('SubscriptionResolverService — plan field mapping', () => {
  it('includes all required plan fields in resolved result', async () => {
    const { service, redis, prisma } = await buildService();
    redis.get.mockResolvedValue(null);
    const plan = {
      id: 'plan-full',
      name: 'Enterprise',
      monthlyCredits: 10000,
      usageMultiplier: 2.0,
      rateLimitRpm: 300,
      rateLimitTpm: 1000000,
      maxContextWindow: 200000,
    };
    prisma.subscriptionPeriod.findFirst.mockResolvedValue({
      id: 'period-full',
      userId: 'u1',
      productId: 'prod-1',
      planId: 'plan-full',
      status: 'ACTIVE',
      expiresAt: null,
      plan,
    });

    const r = await service.resolve('u1', 'prod-1');

    expect(r).not.toBeNull();
    expect(r!.plan.id).toBe('plan-full');
    expect(r!.plan.name).toBe('Enterprise');
    expect(r!.plan.monthlyCredits).toBe(10000);
    expect(r!.plan.usageMultiplier).toBe(2.0);
    expect(r!.plan.rateLimitRpm).toBe(300);
    expect(r!.plan.rateLimitTpm).toBe(1000000);
    expect(r!.plan.maxContextWindow).toBe(200000);
  });
});
