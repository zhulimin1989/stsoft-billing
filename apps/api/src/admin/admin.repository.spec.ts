import { OrderStatus } from '@prisma/client';
import { AdminRepository } from './admin.repository';

function buildRepository() {
  const prisma = {
    order: {
      count: jest.fn(),
      aggregate: jest.fn(),
      findMany: jest.fn(),
    },
    user: { count: jest.fn() },
    channel: { count: jest.fn() },
    apiKey: { count: jest.fn() },
    balanceTransaction: {
      aggregate: jest.fn().mockResolvedValue({ _sum: { amountUsd: 0 } }),
    },
  };
  return {
    prisma,
    repo: new AdminRepository(prisma as never),
  };
}

function order(overrides: Partial<{
  amountCents: number;
  paidAt: Date | null;
  completedAt: Date | null;
  createdAt: Date;
  productId: string | null;
  plan: { productId: string } | null;
  boosterPack: { productId: string } | null;
  items: Array<{
    amountCents: number;
    productId: string | null;
    plan: { productId: string } | null;
    boosterPack: { productId: string } | null;
  }>;
}> = {}) {
  return {
    amountCents: overrides.amountCents ?? 1000,
    paidAt: overrides.paidAt ?? new Date('2026-07-03T02:00:00.000Z'),
    completedAt: overrides.completedAt ?? null,
    createdAt: overrides.createdAt ?? new Date('2026-07-03T01:00:00.000Z'),
    productId: overrides.productId ?? 'product-a',
    plan: overrides.plan ?? null,
    boosterPack: overrides.boosterPack ?? null,
    items: overrides.items ?? [],
  };
}

describe('AdminRepository orders', () => {
  it('includes Coding Plan fulfillment mode in the order list projection', async () => {
    const { repo, prisma } = buildRepository();
    prisma.order.findMany.mockResolvedValue([]);

    await repo.findOrders(0, 20);

    expect(prisma.order.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: expect.objectContaining({
          product: {
            select: expect.objectContaining({
              billingMode: true,
              codingPlanFulfillmentMode: true,
            }),
          },
        }),
      }),
    );
  });
});

describe('AdminRepository revenue', () => {
  afterEach(() => {
    jest.useRealTimers();
  });

  it('calculates product revenue from paid orders and splits order items', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-04T03:00:00.000Z'));
    const { repo, prisma } = buildRepository();
    prisma.order.findMany
      .mockResolvedValueOnce([
        order({ amountCents: 1000, productId: 'product-a' }),
        order({
          productId: null,
          items: [
            { amountCents: 300, productId: 'product-a', plan: null, boosterPack: null },
            { amountCents: 700, productId: 'product-b', plan: null, boosterPack: null },
          ],
        }),
      ])
      .mockResolvedValueOnce([
        order({
          productId: null,
          items: [
            { amountCents: 300, productId: 'product-a', plan: null, boosterPack: null },
            { amountCents: 700, productId: 'product-b', plan: null, boosterPack: null },
          ],
        }),
      ]);

    const result = await repo.getRevenue('product-a');

    expect(result).toMatchObject({
      totalRevenueCents: 1300,
      totalRechargeCents: 1300,
      todayRevenueCents: 300,
      todayRechargeCents: 300,
      todayOrders: 1,
    });
    expect(prisma.order.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        AND: expect.arrayContaining([
          { status: { in: [OrderStatus.PAID, OrderStatus.FULFILLING, OrderStatus.COMPLETED] } },
          expect.objectContaining({
            OR: expect.arrayContaining([{ productId: 'product-a' }]),
          }),
        ]),
      }),
    }));
  });

  it('returns daily order revenue while keeping overview totals cumulative', async () => {
    jest.useFakeTimers();
    jest.setSystemTime(new Date('2026-07-04T10:00:00.000Z'));
    const { repo, prisma } = buildRepository();
    prisma.order.findMany
      .mockResolvedValueOnce([
        order({ amountCents: 500, paidAt: new Date('2026-07-02T18:00:00.000Z') }),
        order({ amountCents: 700, paidAt: new Date('2026-07-04T01:00:00.000Z') }),
      ])
      .mockResolvedValueOnce([
        order({ amountCents: 500, paidAt: new Date('2026-07-02T18:00:00.000Z') }),
        order({ amountCents: 700, paidAt: new Date('2026-07-04T01:00:00.000Z') }),
        order({ amountCents: 900, paidAt: new Date('2026-06-20T01:00:00.000Z') }),
      ]);

    const result = await repo.getRevenueOverview(3);

    expect(result.totalRevenueCents).toBe(2100);
    expect(result.totalRechargeCents).toBe(2100);
    expect(result.daily).toEqual([
      { date: '2026-07-02', recharge: 0, revenueCents: 0, consume: 0 },
      { date: '2026-07-03', recharge: 500, revenueCents: 500, consume: 0 },
      { date: '2026-07-04', recharge: 700, revenueCents: 700, consume: 0 },
    ]);
  });
});

describe('AdminRepository model pricing', () => {
  it('persists the display label in modelId without changing the modelName identity', async () => {
    const prisma: any = {
      modelPricing: {
        upsert: jest.fn().mockResolvedValue({ id: 'pricing-1', modelName: 'gpt-4o', pricingUnit: null }),
        findUnique: jest.fn().mockResolvedValue({
          id: 'pricing-1',
          modelName: 'gpt-4o',
          modelId: 'GPT-4o 用户版',
          priceTiers: [],
        }),
      },
      modelPricingTier: {
        deleteMany: jest.fn(),
        createMany: jest.fn(),
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    // upsertModelPricing 现走单事务 + advisory 锁（OFF_PEAK XOR 并发不变量）
    prisma.$transaction = jest.fn(async (cb: (tx: typeof prisma) => unknown) => cb(prisma));
    prisma.$executeRaw = jest.fn().mockResolvedValue(0);
    const repo = new AdminRepository(prisma as never);

    await repo.upsertModelPricing('gpt-4o', {
      modelId: 'GPT-4o 用户版',
      inputPricePerMToken: 2.5,
      outputPricePerMToken: 10,
      isActive: true,
    });

    expect(prisma.modelPricing.upsert).toHaveBeenCalledWith({
      where: { modelName: 'gpt-4o' },
      update: expect.objectContaining({
        modelId: 'GPT-4o 用户版',
      }),
      create: expect.objectContaining({
        modelName: 'gpt-4o',
        modelId: 'GPT-4o 用户版',
      }),
    });
  });
});
