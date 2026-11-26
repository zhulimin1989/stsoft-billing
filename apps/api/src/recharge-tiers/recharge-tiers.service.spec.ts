import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RechargeTiersService } from './recharge-tiers.service';

/**
 * Service tests use an in-memory Prisma stub. Focus is on field validation,
 * the FIXED vs PERCENT bonusValue rules, time-window sanity, soft delete
 * (no tombstone — just deletedAt + filter), and clone semantics.
 */
describe('RechargeTiersService', () => {
  let service: RechargeTiersService;
  let prisma: any;

  beforeEach(async () => {
    prisma = makePrismaStub();
    const m = await Test.createTestingModule({
      providers: [
        RechargeTiersService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = m.get(RechargeTiersService);
    // Default: product exists for all create paths.
    prisma.product.findFirst.mockResolvedValue({ id: 'p1' });
  });

  const baseRow = (overrides: Record<string, unknown> = {}) => ({
    id: 't1',
    productId: 'p1',
    amountCents: 1000,
    bonusType: 'FIXED',
    bonusValue: 200,
    badge: null,
    sortOrder: 0,
    isActive: true,
    startAt: null,
    endAt: null,
    createdAt: new Date('2026-04-01'),
    updatedAt: new Date('2026-04-01'),
    deletedAt: null,
    ...overrides,
  });

  // ---------- create ----------

  it('create: FIXED bonus succeeds', async () => {
    prisma.rechargeTier.create.mockResolvedValueOnce(baseRow());
    prisma.rechargeTier.count.mockResolvedValueOnce(0);
    const r = await service.create({
      productId: 'p1',
      amountCents: 1000,
      bonusType: 'FIXED',
      bonusValue: 200,
    });
    expect(r.id).toBe('t1');
    expect(r.bonusType).toBe('FIXED');
    expect(r.bonusValue).toBe(200);
    expect(r.overlapWarning).toBeUndefined();
  });

  it('create: PERCENT bonus succeeds', async () => {
    prisma.rechargeTier.create.mockResolvedValueOnce(
      baseRow({ bonusType: 'PERCENT', bonusValue: 20 }),
    );
    prisma.rechargeTier.count.mockResolvedValueOnce(0);
    const r = await service.create({
      productId: 'p1',
      amountCents: 1000,
      bonusType: 'PERCENT',
      bonusValue: 20,
    });
    expect(r.bonusType).toBe('PERCENT');
    expect(r.bonusValue).toBe(20);
  });

  it('create: PERCENT bonusValue > 100 throws', async () => {
    await expect(
      service.create({
        productId: 'p1',
        amountCents: 1000,
        bonusType: 'PERCENT',
        bonusValue: 150,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: negative amountCents throws', async () => {
    await expect(
      service.create({
        productId: 'p1',
        amountCents: -100,
        bonusType: 'FIXED',
        bonusValue: 0,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: zero amountCents throws', async () => {
    await expect(
      service.create({
        productId: 'p1',
        amountCents: 0,
        bonusType: 'FIXED',
        bonusValue: 0,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: non-integer amountCents throws', async () => {
    await expect(
      service.create({
        productId: 'p1',
        amountCents: 100.5,
        bonusType: 'FIXED',
        bonusValue: 0,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: amountCents above MAX throws', async () => {
    await expect(
      service.create({
        productId: 'p1',
        amountCents: 1_000_000_000,
        bonusType: 'FIXED',
        bonusValue: 0,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: negative bonusValue throws', async () => {
    await expect(
      service.create({
        productId: 'p1',
        amountCents: 1000,
        bonusType: 'FIXED',
        bonusValue: -1,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: bonusValue=0 (no bonus) succeeds', async () => {
    prisma.rechargeTier.create.mockResolvedValueOnce(
      baseRow({ bonusValue: 0 }),
    );
    prisma.rechargeTier.count.mockResolvedValueOnce(0);
    const r = await service.create({
      productId: 'p1',
      amountCents: 1000,
      bonusType: 'FIXED',
      bonusValue: 0,
    });
    expect(r.bonusValue).toBe(0);
  });

  it('create: invalid bonusType throws', async () => {
    await expect(
      service.create({
        productId: 'p1',
        amountCents: 1000,
        bonusType: 'BOGUS' as any,
        bonusValue: 0,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: missing productId throws', async () => {
    await expect(
      service.create({
        productId: '',
        amountCents: 1000,
        bonusType: 'FIXED',
        bonusValue: 0,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: nonexistent productId throws', async () => {
    prisma.product.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.create({
        productId: 'ghost',
        amountCents: 1000,
        bonusType: 'FIXED',
        bonusValue: 0,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: badge longer than 32 chars throws', async () => {
    await expect(
      service.create({
        productId: 'p1',
        amountCents: 1000,
        bonusType: 'FIXED',
        bonusValue: 0,
        badge: 'x'.repeat(33),
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: time window with end <= start throws', async () => {
    const start = new Date('2026-05-01').toISOString();
    const end = new Date('2026-04-01').toISOString();
    await expect(
      service.create({
        productId: 'p1',
        amountCents: 1000,
        bonusType: 'FIXED',
        bonusValue: 0,
        startAt: start,
        endAt: end,
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('create: surfaces overlapWarning when other active same-amount tiers exist', async () => {
    prisma.rechargeTier.create.mockResolvedValueOnce(baseRow());
    prisma.rechargeTier.count.mockResolvedValueOnce(2);
    const r = await service.create({
      productId: 'p1',
      amountCents: 1000,
      bonusType: 'FIXED',
      bonusValue: 0,
    });
    expect(r.overlapWarning).toMatch(/2/);
  });

  // ---------- list / get ----------

  it('listPublicActive: returns active tiers with computed fixed and percent bonus', async () => {
    prisma.rechargeTier.findMany.mockResolvedValueOnce([
      baseRow({ id: 'fixed', amountCents: 1000, bonusType: 'FIXED', bonusValue: 200 }),
      baseRow({ id: 'percent', amountCents: 2000, bonusType: 'PERCENT', bonusValue: 10 }),
    ]);

    const result = await service.listPublicActive(' p1 ');

    expect(prisma.rechargeTier.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          productId: 'p1',
          isActive: true,
          deletedAt: null,
          AND: expect.any(Array),
        }),
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      }),
    );
    expect(result.items).toEqual([
      expect.objectContaining({ id: 'fixed', amountCents: 1000, bonusCents: 200 }),
      expect.objectContaining({ id: 'percent', amountCents: 2000, bonusCents: 200 }),
    ]);
  });

  it('listPaygProducts: returns active non-deleted PAYG products only', async () => {
    prisma.product.findMany.mockResolvedValueOnce([
      {
        id: 'p1',
        name: 'PAYG',
        slug: 'payg',
        billingMode: 'PAY_AS_YOU_GO',
        isActive: true,
      },
    ]);

    const result = await service.listPaygProducts();

    expect(result.items).toHaveLength(1);
    expect(prisma.product.findMany).toHaveBeenCalledWith({
      where: {
        billingMode: 'PAY_AS_YOU_GO',
        isActive: true,
        deletedAt: null,
      },
      orderBy: { sortOrder: 'asc' },
      select: {
        id: true,
        name: true,
        slug: true,
        billingMode: true,
        isActive: true,
      },
    });
  });

  it('list: applies productId + isActive filters and pagination', async () => {
    prisma.rechargeTier.findMany.mockResolvedValueOnce([]);
    prisma.rechargeTier.count.mockResolvedValueOnce(0);
    await service.list({
      page: 2,
      pageSize: 5,
      productId: 'p1',
      isActive: true,
    });
    const args = prisma.rechargeTier.findMany.mock.calls[0][0];
    expect(args.where.deletedAt).toBeNull();
    expect(args.where.productId).toBe('p1');
    expect(args.where.isActive).toBe(true);
    expect(args.skip).toBe(5);
    expect(args.take).toBe(5);
  });

  it('list: sorts by sortOrder asc then createdAt desc', async () => {
    prisma.rechargeTier.findMany.mockResolvedValueOnce([]);
    prisma.rechargeTier.count.mockResolvedValueOnce(0);
    await service.list({ page: 1, pageSize: 20 });
    const args = prisma.rechargeTier.findMany.mock.calls[0][0];
    expect(args.orderBy).toEqual([
      { sortOrder: 'asc' },
      { createdAt: 'desc' },
    ]);
  });

  it('getById: throws on not found', async () => {
    prisma.rechargeTier.findFirst.mockResolvedValueOnce(null);
    await expect(service.getById('missing')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // ---------- update ----------

  it('update: changing bonusType validates new value compatibility', async () => {
    // Existing PERCENT 50 → switch to FIXED: 50 cents is fine for FIXED, OK
    prisma.rechargeTier.findFirst.mockResolvedValueOnce(
      baseRow({ bonusType: 'PERCENT', bonusValue: 50 }),
    );
    prisma.rechargeTier.update.mockResolvedValueOnce(
      baseRow({ bonusType: 'FIXED', bonusValue: 50 }),
    );
    prisma.rechargeTier.count.mockResolvedValueOnce(0);
    const r = await service.update('t1', { bonusType: 'FIXED' });
    expect(r.bonusType).toBe('FIXED');
  });

  it('update: switching to PERCENT with existing value > 100 throws', async () => {
    prisma.rechargeTier.findFirst.mockResolvedValueOnce(
      baseRow({ bonusType: 'FIXED', bonusValue: 1000 }),
    );
    await expect(
      service.update('t1', { bonusType: 'PERCENT' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('update: 404 when row missing or soft-deleted', async () => {
    prisma.rechargeTier.findFirst.mockResolvedValueOnce(null);
    await expect(
      service.update('nope', { isActive: false }),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('update: applies partial fields', async () => {
    prisma.rechargeTier.findFirst.mockResolvedValueOnce(baseRow());
    prisma.rechargeTier.update.mockResolvedValueOnce(
      baseRow({ isActive: false, badge: 'hot' }),
    );
    prisma.rechargeTier.count.mockResolvedValueOnce(0);
    await service.update('t1', { isActive: false, badge: 'hot' });
    const args = prisma.rechargeTier.update.mock.calls[0][0];
    expect(args.data).toEqual({ isActive: false, badge: 'hot' });
  });

  it('update: setting startAt + endAt validates window', async () => {
    prisma.rechargeTier.findFirst.mockResolvedValueOnce(baseRow());
    await expect(
      service.update('t1', {
        startAt: '2026-06-01T00:00:00.000Z',
        endAt: '2026-05-01T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('update: clearing startAt with null is allowed', async () => {
    prisma.rechargeTier.findFirst.mockResolvedValueOnce(
      baseRow({
        startAt: new Date('2026-04-01'),
        endAt: new Date('2026-05-01'),
      }),
    );
    prisma.rechargeTier.update.mockResolvedValueOnce(baseRow());
    prisma.rechargeTier.count.mockResolvedValueOnce(0);
    await service.update('t1', { startAt: null });
    const args = prisma.rechargeTier.update.mock.calls[0][0];
    expect(args.data.startAt).toBeNull();
  });

  // ---------- soft delete ----------

  it('softDelete: sets deletedAt + isActive=false (no tombstone rename)', async () => {
    prisma.rechargeTier.findFirst.mockResolvedValueOnce(baseRow());
    prisma.rechargeTier.update.mockResolvedValueOnce({});
    await service.softDelete('t1');
    const args = prisma.rechargeTier.update.mock.calls[0][0];
    expect(args.data.deletedAt).toBeInstanceOf(Date);
    expect(args.data.isActive).toBe(false);
    // No name/badge mutation — table has no @unique field, no tombstone needed
    expect(args.data.badge).toBeUndefined();
  });

  it('softDelete: 404 when missing', async () => {
    prisma.rechargeTier.findFirst.mockResolvedValueOnce(null);
    await expect(service.softDelete('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  // ---------- clone ----------

  it('clone: copies all fields except id, sets badge="副本", clears window, isActive=false', async () => {
    prisma.rechargeTier.findFirst.mockResolvedValueOnce(
      baseRow({
        productId: 'p1',
        amountCents: 5000,
        bonusType: 'PERCENT',
        bonusValue: 30,
        badge: '最受欢迎',
        sortOrder: 5,
        isActive: true,
        startAt: new Date('2026-04-01'),
        endAt: new Date('2026-05-01'),
      }),
    );
    prisma.rechargeTier.create.mockResolvedValueOnce(
      baseRow({
        id: 't2',
        amountCents: 5000,
        bonusType: 'PERCENT',
        bonusValue: 30,
        badge: '副本',
        sortOrder: 5,
        isActive: false,
        startAt: null,
        endAt: null,
      }),
    );
    const r = await service.clone('t1');
    expect(r.id).toBe('t2');
    expect(r.badge).toBe('副本');
    expect(r.isActive).toBe(false);
    expect(r.startAt).toBeNull();
    expect(r.endAt).toBeNull();

    const args = prisma.rechargeTier.create.mock.calls[0][0];
    expect(args.data.product.connect.id).toBe('p1');
    expect(args.data.amountCents).toBe(5000);
    expect(args.data.bonusType).toBe('PERCENT');
    expect(args.data.bonusValue).toBe(30);
    expect(args.data.badge).toBe('副本');
    expect(args.data.sortOrder).toBe(5);
    expect(args.data.isActive).toBe(false);
    expect(args.data.startAt).toBeNull();
    expect(args.data.endAt).toBeNull();
  });

  it('clone: 404 when source missing', async () => {
    prisma.rechargeTier.findFirst.mockResolvedValueOnce(null);
    await expect(service.clone('nope')).rejects.toBeInstanceOf(
      NotFoundException,
    );
  });

  it('clone: retries with timestamp badge on P2002 (defensive)', async () => {
    prisma.rechargeTier.findFirst.mockResolvedValueOnce(baseRow());
    const p2002 = new Prisma.PrismaClientKnownRequestError(
      'unique violation',
      { code: 'P2002', clientVersion: 'x' } as any,
    );
    prisma.rechargeTier.create
      .mockRejectedValueOnce(p2002)
      .mockResolvedValueOnce(baseRow({ id: 't9', badge: '副本 1714000000000' }));
    const r = await service.clone('t1');
    expect(r.id).toBe('t9');
    expect(prisma.rechargeTier.create).toHaveBeenCalledTimes(2);
    const retryArgs = prisma.rechargeTier.create.mock.calls[1][0];
    expect(retryArgs.data.badge).toMatch(/^副本 \d+$/);
  });

  it('clone: rethrows non-P2002 errors without retry', async () => {
    prisma.rechargeTier.findFirst.mockResolvedValueOnce(baseRow());
    const boom = new Error('database is down');
    prisma.rechargeTier.create.mockRejectedValueOnce(boom);
    await expect(service.clone('t1')).rejects.toBe(boom);
    expect(prisma.rechargeTier.create).toHaveBeenCalledTimes(1);
  });
});

// ---------- prisma stub factory ----------
function makePrismaStub() {
  return {
    rechargeTier: {
      create: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      update: jest.fn(),
    },
    product: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
    },
  };
}
