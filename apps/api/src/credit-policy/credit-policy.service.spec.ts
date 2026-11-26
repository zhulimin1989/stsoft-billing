import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { CreditPolicyService } from './credit-policy.service';

function makePrisma() {
  return {
    creditPolicy: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    product: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
    userSegment: {
      findUnique: jest.fn(),
    },
    userSegmentMember: {
      findMany: jest.fn(),
    },
    user: {
      findMany: jest.fn(),
    },
    order: {
      findMany: jest.fn(),
    },
    $queryRaw: jest.fn(),
  };
}

function makeRedis() {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  };
}

async function buildService(
  prismaOverrides: Record<string, unknown> = {},
  redisOverrides: Record<string, unknown> = {},
) {
  const prisma = { ...makePrisma(), ...prismaOverrides } as any;
  const redis = { ...makeRedis(), ...redisOverrides } as any;

  const m = await Test.createTestingModule({
    providers: [
      CreditPolicyService,
      { provide: PrismaService, useValue: prisma },
      { provide: RedisService, useValue: redis },
    ],
  }).compile();

  return { service: m.get(CreditPolicyService) as CreditPolicyService, prisma, redis };
}

// ============================================================
// getGlobal
// ============================================================
describe('CreditPolicyService.getGlobal', () => {
  it('returns DB row when policy exists', async () => {
    const { service, prisma } = await buildService();
    const row = {
      id: 'cp1',
      productId: 'p1',
      scope: 'GLOBAL',
      segmentId: null,
      allowOverdraft: true,
      defaultCreditLimitCents: 5000,
      triggerAction: 'SUSPEND',
      recoveryCondition: 'ON_RECHARGE',
      recoveryDays: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    prisma.creditPolicy.findFirst.mockResolvedValue(row);

    const out = await service.getGlobal('p1');
    expect(out).toBe(row);
    expect(prisma.creditPolicy.findFirst).toHaveBeenCalledWith({
      where: { productId: 'p1', scope: 'GLOBAL', segmentId: null },
    });
  });

  it('returns default when no row exists', async () => {
    const { service, prisma } = await buildService();
    prisma.creditPolicy.findFirst.mockResolvedValue(null);

    const out: any = await service.getGlobal('p2');
    expect(out.isDefault).toBe(true);
    expect(out.allowOverdraft).toBe(false);
    expect(out.defaultCreditLimitCents).toBe(0);
    expect(out.triggerAction).toBe('SUSPEND');
    expect(out.recoveryCondition).toBe('ON_RECHARGE');
  });

  it('throws BadRequest on empty productId', async () => {
    const { service } = await buildService();
    await expect(service.getGlobal('')).rejects.toThrow(BadRequestException);
  });
});

// ============================================================
// upsertGlobal
// ============================================================
describe('CreditPolicyService.upsertGlobal', () => {
  it('creates new row when none exists for PAYG product', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findFirst.mockResolvedValue({ id: 'p1', billingMode: 'PAY_AS_YOU_GO' });
    prisma.creditPolicy.findFirst.mockResolvedValue(null);
    prisma.creditPolicy.create.mockResolvedValue({ id: 'new1' });

    const out = await service.upsertGlobal('p1', {
      allowOverdraft: true,
      defaultCreditLimitCents: 10000,
    });
    expect(out.id).toBe('new1');
    expect(prisma.creditPolicy.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        productId: 'p1',
        scope: 'GLOBAL',
        segmentId: null,
        allowOverdraft: true,
        defaultCreditLimitCents: 10000,
      }),
    });
  });

  it('updates existing row', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findFirst.mockResolvedValue({ id: 'p1', billingMode: 'PAY_AS_YOU_GO' });
    prisma.creditPolicy.findFirst.mockResolvedValue({ id: 'cp-existing' });
    prisma.creditPolicy.update.mockResolvedValue({ id: 'cp-existing', allowOverdraft: false });

    await service.upsertGlobal('p1', { allowOverdraft: false });

    expect(prisma.creditPolicy.update).toHaveBeenCalledWith({
      where: { id: 'cp-existing' },
      data: { allowOverdraft: false },
    });
    expect(prisma.creditPolicy.create).not.toHaveBeenCalled();
  });

  it('rejects non-PAYG products with BadRequest', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findFirst.mockResolvedValue({ id: 'p1', billingMode: 'SUBSCRIPTION' });

    await expect(
      service.upsertGlobal('p1', { allowOverdraft: true }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects when product not found with NotFound', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findFirst.mockResolvedValue(null);

    await expect(service.upsertGlobal('p404', {})).rejects.toThrow(NotFoundException);
  });

  // P2-C review fix(Minor #4): 非法 enum 值现在抛 BadRequest,不再 silent drop
  it('rejects invalid triggerAction with BadRequest', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findFirst.mockResolvedValue({ id: 'p1', billingMode: 'PAY_AS_YOU_GO' });
    prisma.creditPolicy.findFirst.mockResolvedValue(null);

    await expect(
      service.upsertGlobal('p1', { triggerAction: 'BOGUS' as any }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.creditPolicy.create).not.toHaveBeenCalled();
  });

  it('rejects invalid recoveryCondition with BadRequest', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findFirst.mockResolvedValue({ id: 'p1', billingMode: 'PAY_AS_YOU_GO' });
    prisma.creditPolicy.findFirst.mockResolvedValue(null);

    await expect(
      service.upsertGlobal('p1', { recoveryCondition: 'BOGUS' as any }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.creditPolicy.create).not.toHaveBeenCalled();
  });

  it('rejects negative defaultCreditLimitCents with BadRequest', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findFirst.mockResolvedValue({ id: 'p1', billingMode: 'PAY_AS_YOU_GO' });
    prisma.creditPolicy.findFirst.mockResolvedValue(null);

    await expect(
      service.upsertGlobal('p1', { defaultCreditLimitCents: -1 }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.creditPolicy.create).not.toHaveBeenCalled();
  });

  it('rejects negative recoveryDays with BadRequest', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findFirst.mockResolvedValue({ id: 'p1', billingMode: 'PAY_AS_YOU_GO' });
    prisma.creditPolicy.findFirst.mockResolvedValue(null);

    await expect(
      service.upsertGlobal('p1', { recoveryDays: -3 }),
    ).rejects.toThrow(BadRequestException);
    expect(prisma.creditPolicy.create).not.toHaveBeenCalled();
  });
});

// ============================================================
// listSegments
// ============================================================
describe('CreditPolicyService.listSegments', () => {
  it('lists all SEGMENT scope rows desc by createdAt', async () => {
    const { service, prisma } = await buildService();
    prisma.creditPolicy.findMany.mockResolvedValue([{ id: 's1' }, { id: 's2' }]);

    const out = await service.listSegments('p1');
    expect(out).toHaveLength(2);
    expect(prisma.creditPolicy.findMany).toHaveBeenCalledWith({
      where: { productId: 'p1', scope: 'SEGMENT' },
      orderBy: { createdAt: 'desc' },
    });
  });
});

// ============================================================
// upsertSegment
// ============================================================
describe('CreditPolicyService.upsertSegment', () => {
  it('creates new SEGMENT row when none exists', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findFirst.mockResolvedValue({ id: 'p1', billingMode: 'PAY_AS_YOU_GO' });
    prisma.userSegment.findUnique.mockResolvedValue({ id: 'seg-vip' });
    prisma.creditPolicy.findFirst.mockResolvedValue(null);
    prisma.creditPolicy.create.mockResolvedValue({ id: 'new-seg' });

    const out = await service.upsertSegment({
      productId: 'p1',
      segmentId: 'seg-vip',
      data: { allowOverdraft: true, defaultCreditLimitCents: 50000 },
    });
    expect(out.id).toBe('new-seg');
    expect(prisma.creditPolicy.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        productId: 'p1',
        scope: 'SEGMENT',
        segmentId: 'seg-vip',
        allowOverdraft: true,
        defaultCreditLimitCents: 50000,
      }),
    });
  });

  it('rejects when segment does not exist', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findFirst.mockResolvedValue({ id: 'p1', billingMode: 'PAY_AS_YOU_GO' });
    prisma.userSegment.findUnique.mockResolvedValue(null);

    await expect(
      service.upsertSegment({ productId: 'p1', segmentId: 'no-seg', data: {} }),
    ).rejects.toThrow(NotFoundException);
  });

  it('rejects non-PAYG products', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findFirst.mockResolvedValue({ id: 'p1', billingMode: 'CODING_PLAN' });

    await expect(
      service.upsertSegment({ productId: 'p1', segmentId: 'seg-vip', data: {} }),
    ).rejects.toThrow(BadRequestException);
  });
});

// ============================================================
// resolvePolicyForUser
// ============================================================
describe('CreditPolicyService.resolvePolicyForUser', () => {
  it('returns conservative fallback when productId is undefined', async () => {
    const { service, redis } = await buildService();
    const out = await service.resolvePolicyForUser('u1');
    expect(out).toEqual({ allowOverdraft: false, creditLimitCents: 0 });
    expect(redis.get).not.toHaveBeenCalled();
  });

  it('returns cached value on Redis hit', async () => {
    const cachedPolicy = { allowOverdraft: true, creditLimitCents: 5000 };
    const { service, prisma } = await buildService(
      {},
      { get: jest.fn().mockResolvedValue(JSON.stringify(cachedPolicy)) },
    );
    const out = await service.resolvePolicyForUser('u1', 'p1');
    expect(out).toEqual(cachedPolicy);
    expect(prisma.userSegmentMember.findMany).not.toHaveBeenCalled();
  });

  it('SEGMENT match wins over GLOBAL', async () => {
    const { service, prisma } = await buildService();
    prisma.userSegmentMember.findMany.mockResolvedValue([{ segmentId: 'seg-vip' }]);
    prisma.creditPolicy.findMany.mockResolvedValue([
      {
        id: 'cp-global',
        scope: 'GLOBAL',
        segmentId: null,
        allowOverdraft: false,
        defaultCreditLimitCents: 0,
      },
      {
        id: 'cp-seg',
        scope: 'SEGMENT',
        segmentId: 'seg-vip',
        allowOverdraft: true,
        defaultCreditLimitCents: 99999,
      },
    ]);

    const out = await service.resolvePolicyForUser('u1', 'p1');
    expect(out).toEqual({ allowOverdraft: true, creditLimitCents: 99999 });
  });

  it('falls back to GLOBAL when no SEGMENT matches', async () => {
    const { service, prisma } = await buildService();
    prisma.userSegmentMember.findMany.mockResolvedValue([]);
    prisma.creditPolicy.findMany.mockResolvedValue([
      {
        id: 'cp-global',
        scope: 'GLOBAL',
        segmentId: null,
        allowOverdraft: true,
        defaultCreditLimitCents: 1000,
      },
    ]);

    const out = await service.resolvePolicyForUser('u1', 'p1');
    expect(out).toEqual({ allowOverdraft: true, creditLimitCents: 1000 });
  });

  it('returns conservative fallback when no policy at all', async () => {
    const { service, prisma } = await buildService();
    prisma.userSegmentMember.findMany.mockResolvedValue([]);
    prisma.creditPolicy.findMany.mockResolvedValue([]);

    const out = await service.resolvePolicyForUser('u1', 'p1');
    expect(out).toEqual({ allowOverdraft: false, creditLimitCents: 0 });
  });

  it('writes Redis cache on PG resolve', async () => {
    const { service, prisma, redis } = await buildService();
    prisma.userSegmentMember.findMany.mockResolvedValue([]);
    prisma.creditPolicy.findMany.mockResolvedValue([
      {
        scope: 'GLOBAL',
        segmentId: null,
        allowOverdraft: true,
        defaultCreditLimitCents: 100,
      },
    ]);

    await service.resolvePolicyForUser('u1', 'p1');
    expect(redis.set).toHaveBeenCalledWith(
      'policy:user:u1:p1',
      JSON.stringify({ allowOverdraft: true, creditLimitCents: 100 }),
      'EX',
      60,
    );
  });

  it('falls back to PG path on Redis get failure', async () => {
    const { service, prisma } = await buildService(
      {},
      { get: jest.fn().mockRejectedValue(new Error('redis down')) },
    );
    prisma.userSegmentMember.findMany.mockResolvedValue([]);
    prisma.creditPolicy.findMany.mockResolvedValue([
      {
        scope: 'GLOBAL',
        segmentId: null,
        allowOverdraft: true,
        defaultCreditLimitCents: 200,
      },
    ]);

    const out = await service.resolvePolicyForUser('u1', 'p1');
    expect(out).toEqual({ allowOverdraft: true, creditLimitCents: 200 });
  });

  it('returns conservative fallback when PG fails', async () => {
    const { service, prisma } = await buildService();
    prisma.userSegmentMember.findMany.mockRejectedValue(new Error('pg down'));

    const out = await service.resolvePolicyForUser('u1', 'p1');
    expect(out).toEqual({ allowOverdraft: false, creditLimitCents: 0 });
  });

  it('treats allowOverdraft=false policy as creditLimit=0 even if defaultCreditLimitCents>0', async () => {
    const { service, prisma } = await buildService();
    prisma.userSegmentMember.findMany.mockResolvedValue([]);
    prisma.creditPolicy.findMany.mockResolvedValue([
      {
        scope: 'GLOBAL',
        segmentId: null,
        allowOverdraft: false,
        defaultCreditLimitCents: 9999, // ignored because allowOverdraft=false
      },
    ]);

    const out = await service.resolvePolicyForUser('u1', 'p1');
    expect(out).toEqual({ allowOverdraft: false, creditLimitCents: 0 });
  });

  it('ignores corrupt JSON in cache and falls back to PG', async () => {
    const { service, prisma } = await buildService(
      {},
      { get: jest.fn().mockResolvedValue('not-json') },
    );
    prisma.userSegmentMember.findMany.mockResolvedValue([]);
    prisma.creditPolicy.findMany.mockResolvedValue([]);

    const out = await service.resolvePolicyForUser('u1', 'p1');
    expect(out).toEqual({ allowOverdraft: false, creditLimitCents: 0 });
    expect(prisma.userSegmentMember.findMany).toHaveBeenCalled();
  });
});

// ============================================================
// listOverdueUsers
// ============================================================
describe('CreditPolicyService.listOverdueUsers', () => {
  it('returns empty when no overdue rows', async () => {
    const { service, prisma } = await buildService();
    prisma.$queryRaw.mockResolvedValue([]);

    const out = await service.listOverdueUsers({ page: 1, pageSize: 20 });
    expect(out.items).toEqual([]);
    expect(out.total).toBe(0);
  });

  it('paginates and enriches with email + creditLimit + overdueDays', async () => {
    const firstOverdueAt = new Date(Date.now() - 5 * 86400 * 1000); // 5 天前
    const { service, prisma, redis } = await buildService();
    prisma.$queryRaw.mockResolvedValue([
      {
        user_id: 'u1',
        balance_after_usd: -5,
        description: '用量扣费',
        created_at: new Date(),
        first_overdue_at: firstOverdueAt,
      },
    ]);
    prisma.user.findMany.mockResolvedValue([{ id: 'u1', email: 'u1@x.com' }]);
    // policy lookup (resolvePolicyForUser productId=undefined → fallback)
    redis.get.mockResolvedValue(null);

    const out = await service.listOverdueUsers({ page: 1, pageSize: 20 });
    expect(out.items).toHaveLength(1);
    expect(out.items[0].userId).toBe('u1');
    expect(out.items[0].email).toBe('u1@x.com');
    expect(out.items[0].balanceCents).toBe(-500);
    expect(out.items[0].overdueDays).toBe(5);
    expect(out.items[0].reason).toBe('用量扣费');
    expect(out.items[0].creditLimitCents).toBe(0); // no productId → fallback
  });

  it('converts Decimal overdue balances to cents without floating drift', async () => {
    const { service, prisma, redis } = await buildService();
    prisma.$queryRaw.mockResolvedValue([
      {
        user_id: 'u1',
        balance_after_usd: new Prisma.Decimal('-1.005'),
        description: '用量扣费',
        created_at: new Date(),
        first_overdue_at: new Date(),
      },
    ]);
    prisma.user.findMany.mockResolvedValue([{ id: 'u1', email: 'u1@x.com' }]);
    redis.get.mockResolvedValue(null);

    const out = await service.listOverdueUsers({ page: 1, pageSize: 20 });

    expect(out.items[0].balanceCents).toBe(-101);
  });

  it('respects pagination', async () => {
    const { service, prisma } = await buildService();
    const rows = Array.from({ length: 25 }, (_, i) => ({
      user_id: `u${i}`,
      balance_after_usd: (-100 - i) / 100,
      description: '',
      created_at: new Date(),
      first_overdue_at: new Date(),
    }));
    prisma.$queryRaw.mockResolvedValue(rows);
    prisma.user.findMany.mockResolvedValue(
      rows.slice(20, 25).map((r) => ({ id: r.user_id, email: '' })),
    );

    const out = await service.listOverdueUsers({ page: 2, pageSize: 20 });
    expect(out.total).toBe(25);
    expect(out.items).toHaveLength(5);
    expect(out.page).toBe(2);
  });

  it('filters by productId via Order link', async () => {
    const { service, prisma } = await buildService();
    prisma.$queryRaw.mockResolvedValue([
      {
        user_id: 'u1',
        balance_after_usd: -5,
        description: '',
        created_at: new Date(),
        first_overdue_at: new Date(),
      },
      {
        user_id: 'u2',
        balance_after_usd: -3,
        description: '',
        created_at: new Date(),
        first_overdue_at: new Date(),
      },
    ]);
    // 只有 u1 持有 productId=p1 的订单
    prisma.order.findMany.mockResolvedValue([{ userId: 'u1' }]);
    prisma.user.findMany.mockResolvedValue([{ id: 'u1', email: 'u1@x.com' }]);

    const out = await service.listOverdueUsers({ productId: 'p1', page: 1, pageSize: 20 });
    expect(out.items).toHaveLength(1);
    expect(out.items[0].userId).toBe('u1');
    expect(out.total).toBe(1);
  });
});
