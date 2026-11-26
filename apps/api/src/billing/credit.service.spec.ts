import { Test } from '@nestjs/testing';
import { UsageThresholdService } from '../alert-events/usage-threshold.service';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherSyncService } from '../publisher/publisher-sync.service';
import { RedisService } from '../redis/redis.service';
import {
  CreditBalanceSnapshot,
  CreditBalanceStateService,
} from './credit-balance-state.service';
import { CreditService } from './credit.service';

function makeRedis() {
  return {
    eval: jest.fn(),
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    incrby: jest.fn().mockResolvedValue(0),
    decrby: jest.fn().mockResolvedValue(0),
    del: jest.fn().mockResolvedValue(1),
  };
}

function makePublisherSync() {
  return {
    syncTenantKeyBalances: jest.fn().mockResolvedValue(undefined),
    syncUserKeyBalances: jest.fn().mockResolvedValue(undefined),
  };
}

function makePrisma() {
  const prisma: any = {
    creditTransaction: {
      create: jest.fn().mockResolvedValue({}),
      findMany: jest.fn().mockResolvedValue([]),
      count: jest.fn().mockResolvedValue(0),
      aggregate: jest.fn().mockResolvedValue({ _sum: { creditsAmount: null } }),
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue(null),
    },
    creditBalanceState: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    grantRedemption: {
      findMany: jest.fn().mockResolvedValue([]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    subscriptionPeriod: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    codingPlanEntitlement: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    idempotencyKey: {
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
    },
    $executeRaw: jest.fn().mockResolvedValue(undefined),
    $queryRaw: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn(),
  };
  prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => fn(prisma));
  return prisma;
}

function makeBalanceState(prisma: ReturnType<typeof makePrisma>) {
  const states = new Map<string, CreditBalanceSnapshot>();

  const current = (subscriptionId: string, userId: string): CreditBalanceSnapshot =>
    states.get(subscriptionId) ?? {
      subscriptionId,
      userId,
      quota: 0,
      bonus: 0,
      version: 0n,
    };

  const api = {
    seed(subscriptionId: string, userId: string, quota: number, bonus: number, version = 0n) {
      states.set(subscriptionId, { subscriptionId, userId, quota, bonus, version });
    },
    snapshot(subscriptionId: string, userId: string) {
      return current(subscriptionId, userId);
    },
    get: jest.fn(async (subscriptionId: string, userId: string) => current(subscriptionId, userId)),
    getAuthoritative: jest.fn(async (subscriptionId: string, userId: string) =>
      current(subscriptionId, userId)),
    mutate: jest.fn(async (
      subscriptionId: string,
      userId: string,
      calculate: (value: CreditBalanceSnapshot) => { quota: number; bonus: number } | null,
      persist: (
        tx: typeof prisma,
        before: CreditBalanceSnapshot,
        after: CreditBalanceSnapshot,
      ) => Promise<unknown>,
    ) => {
      const before = current(subscriptionId, userId);
      const plan = calculate(before);
      if (!plan) return { changed: false, snapshot: before };
      const after = {
        subscriptionId,
        userId,
        quota: plan.quota,
        bonus: plan.bonus,
        version: before.version + 1n,
      };
      const value = await persist(prisma, before, after);
      states.set(subscriptionId, after);
      return { changed: true, snapshot: after, value };
    }),
    withLockedCurrent: jest.fn(async (
      subscriptionId: string,
      userId: string,
      persist: (tx: typeof prisma, value: CreditBalanceSnapshot) => Promise<unknown>,
    ) => {
      const snapshot = current(subscriptionId, userId);
      const value = await persist(prisma, snapshot);
      return { snapshot, value };
    }),
    reconcile: jest.fn(async (subscriptionId: string, userId: string) => ({
      expected: current(subscriptionId, userId),
      cached: current(subscriptionId, userId),
      mismatched: false,
      fixed: false,
    })),
  };
  return api;
}

async function buildCreditService(opts: {
  publisher?: ReturnType<typeof makePublisherSync>;
  threshold?: { check: jest.Mock };
} = {}) {
  const prisma = makePrisma();
  const redis = makeRedis();
  const balanceState = makeBalanceState(prisma);
  const providers: any[] = [
    CreditService,
    { provide: PrismaService, useValue: prisma },
    { provide: RedisService, useValue: redis },
    { provide: CreditBalanceStateService, useValue: balanceState },
  ];
  if (opts.publisher) {
    providers.push({ provide: PublisherSyncService, useValue: opts.publisher });
  }
  if (opts.threshold) {
    providers.push({ provide: UsageThresholdService, useValue: opts.threshold });
  }
  const module = await Test.createTestingModule({ providers }).compile();
  return {
    service: module.get(CreditService) as CreditService,
    prisma,
    redis,
    balanceState,
    publisher: opts.publisher,
  };
}

describe('CreditService balance reads and reconciliation', () => {
  it('returns only the user grant pool when subscriptionId is empty', async () => {
    const { service, prisma, redis } = await buildCreditService();
    prisma.grantRedemption.findMany.mockResolvedValue([{ amount: 30, usedAmount: 5 }]);

    const result = await service.getBalances('', 'u1');

    expect(result).toEqual({ quota: 0, bonus: 0, grant: 25, total: 25 });
    expect(redis.set).toHaveBeenCalledWith('credit:user:u1:grant', '25', 'NX');
  });

  it('combines the authoritative quota/bonus state with the grant pool', async () => {
    const { service, balanceState, redis } = await buildCreditService();
    balanceState.seed('s1', 'u1', 500, 100, 7n);
    redis.get.mockResolvedValueOnce('25');

    const result = await service.getBalances('s1', 'u1');

    expect(result).toEqual({ quota: 500, bonus: 100, grant: 25, total: 625 });
    expect(balanceState.get).toHaveBeenCalledWith('s1', 'u1');
  });

  it('reconciles quota/bonus through the versioned balance state service', async () => {
    const { service, balanceState } = await buildCreditService();
    balanceState.reconcile.mockResolvedValueOnce({
      expected: { subscriptionId: 's1', userId: 'u1', quota: 90, bonus: 10, version: 3n },
      cached: { subscriptionId: 's1', userId: 'u1', quota: 100, bonus: 10, version: 2n },
      mismatched: true,
      fixed: true,
    });

    const result = await service.reconcileSubscriptionCache('s1', 'u1');

    expect(result).toMatchObject({
      expected: { quota: 90, bonus: 10 },
      redis: { quota: 100, bonus: 10 },
      mismatched: true,
      fixed: true,
    });
  });

  it('enumerates authoritative balance states for a user during reconciliation', async () => {
    const { service, prisma, balanceState } = await buildCreditService();
    prisma.creditBalanceState.findMany.mockResolvedValue([
      { subscriptionId: 's1' },
      { subscriptionId: 's2' },
    ]);
    balanceState.seed('s1', 'u1', 10, 1);
    balanceState.seed('s2', 'u1', 20, 2);

    const result = await service.reconcileUserCreditCache('u1');

    expect(result.subscriptions).toHaveLength(2);
    expect(balanceState.reconcile).toHaveBeenCalledTimes(2);
  });
});

describe('CreditService quota and bonus mutations', () => {
  it('grantQuota replaces quota and preserves bonus in one versioned mutation', async () => {
    const publisher = makePublisherSync();
    const { service, prisma, balanceState } = await buildCreditService({ publisher });
    balanceState.seed('s1', 'u1', 20, 5, 4n);
    prisma.subscriptionPeriod.findUnique.mockResolvedValue({ tenantId: 't1', productId: 'p1' });

    await service.grantQuota('s1', 'u1', 100, 'monthly', { idempotencyKey: 'grant-1' });

    expect(balanceState.snapshot('s1', 'u1')).toMatchObject({ quota: 100, bonus: 5, version: 5n });
    expect(prisma.creditTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'QUOTA_GRANT',
        creditsAmount: 100,
        quotaAfter: 100,
        bonusAfter: 5,
        balanceVersion: 5n,
        idempotencyKey: 'grant-1',
      }),
    });
    expect(publisher.syncTenantKeyBalances).toHaveBeenCalledWith('t1');
  });

  it('grantQuota replay is a strict no-op and never restores a historical cache snapshot', async () => {
    const { service, prisma, redis, balanceState } = await buildCreditService();
    balanceState.seed('s1', 'u1', 20, 0, 8n);
    prisma.creditTransaction.findUnique.mockResolvedValue({
      subscriptionId: 's1',
      userId: 'u1',
      type: 'QUOTA_GRANT',
      creditsAmount: 100,
      source: 'monthly',
      quotaAfter: 100,
      bonusAfter: 0,
    });

    await service.grantQuota('s1', 'u1', 100, 'monthly', { idempotencyKey: 'grant-1' });

    expect(balanceState.snapshot('s1', 'u1')).toMatchObject({ quota: 20, version: 8n });
    expect(balanceState.mutate).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
    expect(redis.incrby).not.toHaveBeenCalled();
  });

  it('grantQuota handles a concurrent P2002 replay without changing state', async () => {
    const { service, prisma, balanceState, redis } = await buildCreditService();
    balanceState.seed('s1', 'u1', 20, 0, 8n);
    prisma.creditTransaction.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        subscriptionId: 's1',
        userId: 'u1',
        type: 'QUOTA_GRANT',
        creditsAmount: 100,
        source: 'monthly',
      });
    prisma.creditTransaction.create.mockRejectedValueOnce({ code: 'P2002' });

    await service.grantQuota('s1', 'u1', 100, 'monthly', { idempotencyKey: 'grant-1' });

    expect(balanceState.snapshot('s1', 'u1')).toMatchObject({ quota: 20, version: 8n });
    expect(redis.set).not.toHaveBeenCalled();
  });

  it('rejects reuse of a grant idempotency key for another balance operation', async () => {
    const { service, prisma } = await buildCreditService();
    prisma.creditTransaction.findUnique.mockResolvedValue({
      subscriptionId: 's1',
      userId: 'u1',
      type: 'BONUS_PURCHASE',
    });

    await expect(
      service.grantQuota('s1', 'u1', 100, 'monthly', { idempotencyKey: 'collision' }),
    ).rejects.toThrow('credit idempotency key collision');
  });

  it('resetQuota versions the final grant while preserving the intermediate reset audit row', async () => {
    const { service, prisma, balanceState } = await buildCreditService();
    balanceState.seed('s1', 'u1', 80, 30, 2n);

    await service.resetQuota('s1', 'u1', 200, 'renewal', { idempotencyKey: 'reset-1' });

    expect(balanceState.snapshot('s1', 'u1')).toMatchObject({ quota: 200, bonus: 30, version: 3n });
    expect(prisma.creditTransaction.create).toHaveBeenCalledTimes(2);
    expect(prisma.creditTransaction.create.mock.calls[0][0].data).toMatchObject({
      type: 'QUOTA_RESET',
      creditsAmount: -80,
      quotaAfter: 0,
      bonusAfter: 30,
    });
    expect(prisma.creditTransaction.create.mock.calls[0][0].data.balanceVersion).toBeUndefined();
    expect(prisma.creditTransaction.create.mock.calls[1][0].data).toMatchObject({
      type: 'QUOTA_GRANT',
      quotaAfter: 200,
      bonusAfter: 30,
      balanceVersion: 3n,
      idempotencyKey: 'reset-1',
    });
  });

  it('locks and revalidates an active self-operated entitlement before quota refresh', async () => {
    const { service, prisma, balanceState } = await buildCreditService();
    balanceState.seed('ent-1', 'u1', 80, 0, 2n);
    prisma.$queryRaw.mockResolvedValue([{
      status: 'ACTIVE',
      fulfillmentMode: 'platform_model_package',
    }]);

    await service.resetQuota('ent-1', 'u1', 200, 'monthly-refresh', {
      idempotencyKey: 'reset-ent-1',
      requireActiveCodingPlanEntitlement: true,
    });

    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.creditTransaction.create).toHaveBeenCalled();
  });

  it('rejects quota refresh after a self-operated entitlement enters REFUNDING', async () => {
    const { service, prisma, balanceState } = await buildCreditService();
    balanceState.seed('ent-1', 'u1', 80, 0, 2n);
    prisma.$queryRaw.mockResolvedValue([{
      status: 'REFUNDING',
      fulfillmentMode: 'platform_model_package',
    }]);

    await expect(
      service.resetQuota('ent-1', 'u1', 200, 'monthly-refresh', {
        idempotencyKey: 'reset-ent-1',
        requireActiveCodingPlanEntitlement: true,
      }),
    ).rejects.toThrow('requires ACTIVE self-operated entitlement');
    expect(prisma.creditTransaction.create).not.toHaveBeenCalled();
    expect(balanceState.snapshot('ent-1', 'u1')).toMatchObject({
      quota: 80,
      version: 2n,
    });
  });

  it('does not restore quota when the same reset is retried after later consumption', async () => {
    const { service, prisma, balanceState } = await buildCreditService();
    balanceState.seed('s1', 'u1', 80, 0, 1n);

    await service.resetQuota('s1', 'u1', 100, 'renewal', { idempotencyKey: 'reset-1' });
    balanceState.seed('s1', 'u1', 20, 0, 3n);
    prisma.creditTransaction.findUnique.mockResolvedValue({
      subscriptionId: 's1',
      userId: 'u1',
      type: 'QUOTA_GRANT',
      creditsAmount: 100,
      source: 'renewal',
    });

    await service.resetQuota('s1', 'u1', 100, 'renewal', { idempotencyKey: 'reset-1' });

    expect(balanceState.snapshot('s1', 'u1')).toMatchObject({ quota: 20, version: 3n });
    expect(balanceState.mutate).toHaveBeenCalledTimes(1);
  });

  it('addBonus increments bonus without changing quota', async () => {
    const { service, prisma, balanceState } = await buildCreditService();
    balanceState.seed('s1', 'u1', 300, 10, 1n);

    await service.addBonus('s1', 'u1', 50, 'booster', { idempotencyKey: 'bonus-1' });

    expect(balanceState.snapshot('s1', 'u1')).toMatchObject({ quota: 300, bonus: 60, version: 2n });
    expect(prisma.creditTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'BONUS_PURCHASE',
        balanceVersion: 2n,
        quotaAfter: 300,
        bonusAfter: 60,
      }),
    });
  });

  it('addBonus replay does not write state or cache', async () => {
    const { service, prisma, redis, balanceState } = await buildCreditService();
    balanceState.seed('s1', 'u1', 300, 20, 5n);
    prisma.creditTransaction.findUnique.mockResolvedValue({
      subscriptionId: 's1',
      userId: 'u1',
      type: 'BONUS_PURCHASE',
      creditsAmount: 80,
      source: 'booster',
      quotaAfter: 300,
      bonusAfter: 100,
    });

    await service.addBonus('s1', 'u1', 80, 'booster', { idempotencyKey: 'bonus-1' });

    expect(balanceState.snapshot('s1', 'u1')).toMatchObject({ bonus: 20, version: 5n });
    expect(balanceState.mutate).not.toHaveBeenCalled();
    expect(redis.set).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('refund increments the authoritative bonus state', async () => {
    const { service, prisma, balanceState } = await buildCreditService();
    balanceState.seed('s1', 'u1', 40, 5, 6n);

    await service.refund('s1', 'u1', 15, 'refund', { idempotencyKey: 'refund-1' });

    expect(balanceState.snapshot('s1', 'u1')).toMatchObject({ quota: 40, bonus: 20, version: 7n });
    expect(prisma.creditTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'REFUND',
        balanceVersion: 7n,
        idempotencyKey: 'refund-1',
      }),
    });
  });

  it('treats a repeated refund key as a strict no-op', async () => {
    const { service, prisma, balanceState } = await buildCreditService();
    balanceState.seed('s1', 'u1', 40, 5, 6n);

    await service.refund('s1', 'u1', 15, 'refund', { idempotencyKey: 'refund-1' });
    prisma.creditTransaction.findUnique.mockResolvedValue({
      subscriptionId: 's1',
      userId: 'u1',
      type: 'REFUND',
      creditsAmount: 15,
      source: 'refund',
    });

    await service.refund('s1', 'u1', 15, 'refund', { idempotencyKey: 'refund-1' });

    expect(balanceState.snapshot('s1', 'u1')).toMatchObject({ bonus: 20, version: 7n });
    expect(balanceState.mutate).toHaveBeenCalledTimes(1);
  });

  it('schedules publisher balance fanout after a refund', async () => {
    const publisher = makePublisherSync();
    const { service, prisma, balanceState } = await buildCreditService({ publisher });
    balanceState.seed('s1', 'u1', 40, 5, 1n);
    prisma.subscriptionPeriod.findUnique.mockResolvedValue({ tenantId: 'tenant-1', productId: 'p1' });

    await service.refund('s1', 'u1', 15, 'refund', { idempotencyKey: 'refund-1' });

    expect(publisher.syncTenantKeyBalances).toHaveBeenCalledWith('tenant-1');
  });

  it.each([
    ['grantQuota', () => buildCreditService().then(({ service }) =>
      service.grantQuota('', 'u1', 1, 'x', { idempotencyKey: 'x' }))],
    ['resetQuota', () => buildCreditService().then(({ service }) =>
      service.resetQuota('', 'u1', 1, 'x', { idempotencyKey: 'x' }))],
    ['addBonus', () => buildCreditService().then(({ service }) =>
      service.addBonus('', 'u1', 1, 'x', { idempotencyKey: 'x' }))],
    ['refund', () => buildCreditService().then(({ service }) =>
      service.refund('', 'u1', 1, 'x', { idempotencyKey: 'x' }))],
  ])('%s rejects an empty subscriptionId', async (_name, run) => {
    await expect(run()).rejects.toThrow('requires a valid subscriptionId');
  });
});

describe('CreditService purchase grant reversal', () => {
  it('reverses quota without consuming bonus or the global grant pool', async () => {
    const { service, prisma, redis, balanceState } = await buildCreditService();
    balanceState.seed('s1', 'u1', 100, 100);
    prisma.creditTransaction.findUnique.mockImplementation(
      async ({ where }: any) => {
        if (where.idempotencyKey === 'checkout:order-1') {
          return {
            subscriptionId: 's1',
            userId: 'u1',
            type: 'QUOTA_GRANT',
            creditsAmount: 100,
          };
        }
        return null;
      },
    );

    const result = await service.reverseGrantedCredits({
      subscriptionId: 's1',
      userId: 'u1',
      credits: 100,
      bucket: 'QUOTA',
      source: 'refund:order-1',
      originalGrantIdempotencyKey: 'checkout:order-1',
      reversalIdempotencyKey: 'refund:order-1:quota',
    });

    expect(result).toEqual({ success: true, quota: 0, bonus: 100 });
    expect(balanceState.snapshot('s1', 'u1')).toMatchObject({
      quota: 0,
      bonus: 100,
    });
    expect(redis.eval).not.toHaveBeenCalled();
    expect(prisma.creditTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        subscriptionId: 's1',
        userId: 'u1',
        type: 'REFUND',
        creditsAmount: -100,
        requestId: 'checkout:order-1',
        quotaAfter: 0,
        bonusAfter: 100,
        idempotencyKey: 'refund:order-1:quota',
      }),
    });
  });

  it('reverses bonus without consuming quota', async () => {
    const { service, prisma, balanceState } = await buildCreditService();
    balanceState.seed('s1', 'u1', 100, 80);
    prisma.creditTransaction.findUnique.mockImplementation(
      async ({ where }: any) => {
        if (where.idempotencyKey === 'booster:order-1') {
          return {
            subscriptionId: 's1',
            userId: 'u1',
            type: 'BONUS_PURCHASE',
            creditsAmount: 80,
          };
        }
        return null;
      },
    );

    await expect(service.reverseGrantedCredits({
      subscriptionId: 's1',
      userId: 'u1',
      credits: 80,
      bucket: 'BONUS',
      source: 'refund:order-1',
      originalGrantIdempotencyKey: 'booster:order-1',
      reversalIdempotencyKey: 'refund:order-1:bonus',
    })).resolves.toEqual({ success: true, quota: 100, bonus: 0 });
  });

  it('fails without mutating another bucket when the purchased bucket is insufficient', async () => {
    const { service, prisma, balanceState } = await buildCreditService();
    balanceState.seed('s1', 'u1', 500, 20);
    prisma.creditTransaction.findUnique.mockImplementation(
      async ({ where }: any) => {
        if (where.idempotencyKey === 'booster:order-1') {
          return {
            subscriptionId: 's1',
            userId: 'u1',
            type: 'BONUS_PURCHASE',
            creditsAmount: 100,
          };
        }
        return null;
      },
    );

    await expect(service.reverseGrantedCredits({
      subscriptionId: 's1',
      userId: 'u1',
      credits: 100,
      bucket: 'BONUS',
      source: 'refund:order-1',
      originalGrantIdempotencyKey: 'booster:order-1',
      reversalIdempotencyKey: 'refund:order-1:bonus',
    })).resolves.toEqual({ success: false, quota: 500, bonus: 20 });

    expect(prisma.creditTransaction.create).not.toHaveBeenCalled();
    expect(balanceState.snapshot('s1', 'u1')).toMatchObject({
      quota: 500,
      bonus: 20,
    });
  });
});

describe('CreditService deduct with PostgreSQL-authoritative quota/bonus', () => {
  it('deducts quota first, then bonus, and records the new version', async () => {
    const { service, prisma, balanceState, redis } = await buildCreditService();
    balanceState.seed('s1', 'u1', 100, 50, 10n);

    const result = await service.deduct('s1', 'u1', 120, 'llm');

    expect(result).toMatchObject({ success: true, quota: 0, bonus: 30, fromGrant: 0 });
    expect(balanceState.snapshot('s1', 'u1')).toMatchObject({ quota: 0, bonus: 30, version: 11n });
    expect(prisma.creditTransaction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        type: 'CONSUME',
        creditsAmount: -120,
        quotaAfter: 0,
        bonusAfter: 30,
        balanceVersion: 11n,
      }),
    });
    // quota/bonus no longer use Redis debit or compensation Lua.
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('schedules publisher balance fanout after an authoritative deduction', async () => {
    const publisher = makePublisherSync();
    const { service, prisma, balanceState } = await buildCreditService({ publisher });
    balanceState.seed('s1', 'u1', 100, 0, 1n);
    prisma.subscriptionPeriod.findUnique.mockResolvedValue({ tenantId: 'tenant-1', productId: 'p1' });

    await service.deduct('s1', 'u1', 10, 'llm');

    expect(publisher.syncTenantKeyBalances).toHaveBeenCalledWith('tenant-1');
  });

  it('does not mutate state or write a CONSUME row when balance is insufficient', async () => {
    const { service, prisma, balanceState } = await buildCreditService();
    balanceState.seed('s1', 'u1', 100, 50, 10n);

    const result = await service.deduct('s1', 'u1', 151, 'llm');

    expect(result).toMatchObject({ success: false, quota: 100, bonus: 50 });
    expect(balanceState.snapshot('s1', 'u1')).toMatchObject({ version: 10n });
    expect(prisma.creditTransaction.create).not.toHaveBeenCalled();
  });

  it('rolls back the state mutation when the DB transaction callback fails', async () => {
    const { service, prisma, balanceState, redis } = await buildCreditService();
    balanceState.seed('s1', 'u1', 100, 50, 3n);
    prisma.creditTransaction.create.mockRejectedValueOnce(new Error('PG down'));

    await expect(service.deduct('s1', 'u1', 20, 'llm')).rejects.toThrow('PG down');

    expect(balanceState.snapshot('s1', 'u1')).toMatchObject({ quota: 100, bonus: 50, version: 3n });
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('keeps token metadata and afterCreditTransaction inside the balance transaction', async () => {
    const { service, prisma, balanceState } = await buildCreditService();
    balanceState.seed('s1', 'u1', 100, 0, 1n);
    const callback = jest.fn().mockResolvedValue(undefined);

    await service.deduct(
      's1',
      'u1',
      25,
      'llm',
      'claude-sonnet',
      { inputTokens: 10, cachedInputTokens: 2, outputTokens: 5, totalTokens: 15, requestId: 'r1' },
      { afterCreditTransaction: callback },
    );

    expect(prisma.creditTransaction.create.mock.calls[0][0].data).toMatchObject({
      modelName: 'claude-sonnet',
      inputTokens: 10,
      cachedInputTokens: 2,
      outputTokens: 5,
      totalTokens: 15,
      requestId: 'r1',
    });
    expect(callback).toHaveBeenCalledWith(prisma, {
      quotaAfter: 75,
      bonusAfter: 0,
      grantAfter: 0,
      fromGrant: 0,
    });
  });

  it('returns the original idempotent result without touching current state', async () => {
    const { service, prisma, balanceState, redis } = await buildCreditService();
    balanceState.seed('s1', 'u1', 20, 0, 9n);
    prisma.creditTransaction.findUnique.mockResolvedValue({
      subscriptionId: 's1',
      userId: 'u1',
      type: 'CONSUME',
      creditsAmount: -20,
      source: 'llm',
      quotaAfter: 80,
      bonusAfter: 0,
    });

    const result = await service.deduct('s1', 'u1', 20, 'llm', undefined, undefined, {
      idempotencyKey: 'consume-1',
    });

    expect(result).toMatchObject({ success: true, quota: 80, bonus: 0 });
    expect(balanceState.mutate).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('records grant-only consumption without changing quota/bonus version', async () => {
    const { service, prisma, balanceState, redis } = await buildCreditService();
    balanceState.seed('s1', 'u1', 100, 50, 4n);
    jest.spyOn(service, 'getBalances').mockResolvedValue({
      quota: 100,
      bonus: 50,
      grant: 300,
      total: 450,
    });
    redis.eval.mockResolvedValueOnce(120);
    redis.get.mockResolvedValueOnce('180');
    prisma.grantRedemption.findMany.mockResolvedValue([
      { id: 'g1', amount: 300, usedAmount: 0 },
    ]);

    const result = await service.deduct('s1', 'u1', 120, 'llm');

    expect(result).toMatchObject({ success: true, quota: 100, bonus: 50, fromGrant: 120 });
    expect(balanceState.snapshot('s1', 'u1')).toMatchObject({ version: 4n });
    expect(balanceState.withLockedCurrent).toHaveBeenCalledTimes(1);
    expect(prisma.creditTransaction.create.mock.calls[0][0].data).toMatchObject({
      balanceVersion: 4n,
      quotaAfter: 100,
      bonusAfter: 50,
    });
  });

  it('combines a grant reservation with an authoritative quota deduction', async () => {
    const { service, prisma, balanceState, redis } = await buildCreditService();
    balanceState.seed('s1', 'u1', 100, 0, 4n);
    jest.spyOn(service, 'getBalances').mockResolvedValue({
      quota: 100,
      bonus: 0,
      grant: 50,
      total: 150,
    });
    redis.eval.mockResolvedValueOnce(50);
    redis.get.mockResolvedValueOnce('0');
    prisma.grantRedemption.findMany.mockResolvedValue([
      { id: 'g1', amount: 50, usedAmount: 0 },
    ]);

    const result = await service.deduct('s1', 'u1', 120, 'llm');

    expect(result).toMatchObject({ success: true, quota: 30, bonus: 0, fromGrant: 50 });
    expect(balanceState.snapshot('s1', 'u1')).toMatchObject({ version: 5n, quota: 30 });
  });

  it('returns a grant reservation when quota/bonus is insufficient', async () => {
    const { service, balanceState, redis } = await buildCreditService();
    balanceState.seed('s1', 'u1', 20, 0, 4n);
    jest.spyOn(service, 'getBalances').mockResolvedValue({
      quota: 20,
      bonus: 0,
      grant: 50,
      total: 70,
    });
    redis.eval.mockResolvedValueOnce(50);
    redis.get.mockResolvedValueOnce('0');
    redis.incrby.mockResolvedValueOnce(50);

    const result = await service.deduct('s1', 'u1', 120, 'llm');

    expect(result).toMatchObject({ success: false, quota: 20, bonus: 0, grant: 50 });
    expect(redis.incrby).toHaveBeenCalledWith('credit:user:u1:grant', 50);
    expect(balanceState.snapshot('s1', 'u1')).toMatchObject({ version: 4n });
  });

  it('compensates only the grant reservation when the authoritative transaction fails', async () => {
    const { service, prisma, balanceState, redis } = await buildCreditService();
    balanceState.seed('s1', 'u1', 100, 0, 4n);
    jest.spyOn(service, 'getBalances').mockResolvedValue({
      quota: 100,
      bonus: 0,
      grant: 50,
      total: 150,
    });
    redis.eval.mockResolvedValueOnce(50);
    redis.get.mockResolvedValueOnce('0');
    prisma.creditTransaction.create.mockRejectedValueOnce(new Error('PG down'));

    await expect(service.deduct('s1', 'u1', 120, 'llm')).rejects.toThrow('PG down');

    expect(redis.incrby).toHaveBeenCalledWith('credit:user:u1:grant', 50);
    expect(balanceState.snapshot('s1', 'u1')).toMatchObject({ quota: 100, version: 4n });
  });

  it('falls back to authoritative quota/bonus when grant reservation Lua fails', async () => {
    const { service, balanceState, redis } = await buildCreditService();
    balanceState.seed('s1', 'u1', 100, 0, 1n);
    jest.spyOn(service, 'getBalances').mockResolvedValue({
      quota: 100,
      bonus: 0,
      grant: 50,
      total: 150,
    });
    redis.eval.mockRejectedValueOnce(new Error('redis down'));

    const result = await service.deduct('s1', 'u1', 20, 'llm');

    expect(result).toMatchObject({ success: true, quota: 80, bonus: 0, fromGrant: 0 });
    expect(redis.incrby).not.toHaveBeenCalled();
  });

  it('marks the deduct intent for reconciliation when grant compensation fails', async () => {
    const { service, prisma, balanceState, redis } = await buildCreditService();
    balanceState.seed('s1', 'u1', 20, 0, 1n);
    jest.spyOn(service, 'getBalances').mockResolvedValue({
      quota: 20,
      bonus: 0,
      grant: 50,
      total: 70,
    });
    redis.eval.mockResolvedValueOnce(50);
    redis.get.mockResolvedValueOnce('0');
    redis.incrby.mockRejectedValueOnce(new Error('compensation failed'));

    const result = await service.deduct('s1', 'u1', 120, 'llm');

    expect(result.success).toBe(false);
    expect(prisma.idempotencyKey.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'RECONCILE_REQUIRED' }),
    }));
  });

  it('compensates a reserved grant before returning a concurrent P2002 replay', async () => {
    const { service, prisma, balanceState, redis } = await buildCreditService();
    balanceState.seed('s1', 'u1', 100, 0, 1n);
    jest.spyOn(service, 'getBalances').mockResolvedValue({
      quota: 100,
      bonus: 0,
      grant: 50,
      total: 150,
    });
    redis.eval.mockResolvedValueOnce(50);
    redis.get.mockResolvedValueOnce('0');
    redis.incrby.mockResolvedValueOnce(50);
    prisma.creditTransaction.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        subscriptionId: 's1',
        userId: 'u1',
        type: 'CONSUME',
        creditsAmount: -120,
        source: 'llm',
        quotaAfter: 30,
        bonusAfter: 0,
      });
    prisma.creditTransaction.create.mockRejectedValueOnce({ code: 'P2002' });

    const result = await service.deduct('s1', 'u1', 120, 'llm', undefined, undefined, {
      idempotencyKey: 'consume-1',
    });

    expect(result).toMatchObject({ success: true, quota: 30, bonus: 0 });
    expect(redis.incrby).toHaveBeenCalledWith('credit:user:u1:grant', 50);
    expect(balanceState.snapshot('s1', 'u1')).toMatchObject({ quota: 100, version: 1n });
  });

  it('rolls back authoritative state and compensates grant when the transaction hook fails', async () => {
    const { service, prisma, balanceState, redis } = await buildCreditService();
    balanceState.seed('s1', 'u1', 100, 0, 1n);
    jest.spyOn(service, 'getBalances').mockResolvedValue({
      quota: 100,
      bonus: 0,
      grant: 50,
      total: 150,
    });
    redis.eval.mockResolvedValueOnce(50);
    redis.get.mockResolvedValueOnce('0');
    redis.incrby.mockResolvedValueOnce(50);
    prisma.grantRedemption.findMany.mockResolvedValue([
      { id: 'g1', amount: 50, usedAmount: 0 },
    ]);
    const hook = jest.fn().mockRejectedValue(new Error('hook failed'));

    await expect(service.deduct(
      's1',
      'u1',
      120,
      'llm',
      undefined,
      undefined,
      { afterCreditTransaction: hook },
    )).rejects.toThrow('hook failed');

    expect(prisma.creditTransaction.create).toHaveBeenCalled();
    expect(redis.incrby).toHaveBeenCalledWith('credit:user:u1:grant', 50);
    expect(balanceState.snapshot('s1', 'u1')).toMatchObject({ quota: 100, version: 1n });
  });

  it('records REDIS_DEBITED then COMMITTED intent states for mixed grant consumption', async () => {
    const { service, prisma, balanceState, redis } = await buildCreditService();
    balanceState.seed('s1', 'u1', 100, 0, 1n);
    jest.spyOn(service, 'getBalances').mockResolvedValue({
      quota: 100,
      bonus: 0,
      grant: 50,
      total: 150,
    });
    redis.eval.mockResolvedValueOnce(50);
    redis.get.mockResolvedValueOnce('0');
    prisma.grantRedemption.findMany.mockResolvedValue([
      { id: 'g1', amount: 50, usedAmount: 0 },
    ]);

    await service.deduct('s1', 'u1', 120, 'llm');

    expect(prisma.idempotencyKey.update.mock.calls.map((call: any[]) => call[0].data.status))
      .toEqual(['REDIS_DEBITED', 'COMMITTED']);
    expect(prisma.idempotencyKey.update).toHaveBeenLastCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'COMMITTED',
        result: expect.objectContaining({
          fromGrant: 50,
          fromQuota: 70,
          quotaAfter: 30,
        }),
      }),
    }));
  });

  it('preserves empty subscription and non-positive amount behavior', async () => {
    const { service, balanceState } = await buildCreditService();
    balanceState.seed('s1', 'u1', 10, 5);

    await expect(service.deduct('', 'u1', 1, 'x')).resolves.toMatchObject({ success: false });
    await expect(service.deduct('s1', 'u1', 0, 'x')).resolves.toMatchObject({
      success: true,
      quota: 10,
      bonus: 5,
    });
  });
});

describe('CreditService grant pool persistence', () => {
  it('consumes GrantRedemption rows in expiry order', async () => {
    const { service, prisma } = await buildCreditService();
    prisma.grantRedemption.findMany.mockResolvedValue([
      { id: 'g1', amount: 100, usedAmount: 20 },
      { id: 'g2', amount: 100, usedAmount: 0 },
    ]);

    await service.consumeFromGrants('u1', 120);

    expect(prisma.grantRedemption.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }] }),
    );
    expect(prisma.grantRedemption.updateMany).toHaveBeenCalledTimes(2);
  });

  it('throws when Redis reserved more grant than PostgreSQL can persist', async () => {
    const { service, prisma } = await buildCreditService();
    prisma.grantRedemption.findMany.mockResolvedValue([]);

    await expect(service.consumeFromGrants('u1', 10)).rejects.toThrow(
      'Grant pool/DB inconsistency',
    );
  });
});

describe('CreditService summaries, transactions, and async threshold checks', () => {
  it('returns summary balances and both usage windows', async () => {
    const { service, prisma, balanceState } = await buildCreditService();
    balanceState.seed('s1', 'u1', 100, 20);
    prisma.creditTransaction.aggregate
      .mockResolvedValueOnce({ _sum: { creditsAmount: -30 } })
      .mockResolvedValueOnce({ _sum: { creditsAmount: -50 } });
    prisma.creditTransaction.findFirst.mockResolvedValue({ createdAt: new Date('2026-07-01') });

    const result = await service.getSummary('s1', 'u1');

    expect(result).toMatchObject({
      quotaCredits: 100,
      bonusCredits: 20,
      totalCredits: 120,
      usedThisMonth: 30,
      usedThisCycle: 50,
    });
  });

  it('maps paginated transaction rows to the shared API shape', async () => {
    const { service, prisma } = await buildCreditService();
    prisma.creditTransaction.findMany.mockResolvedValue([{
      id: 'tx1',
      userId: 'u1',
      tenantId: null,
      productId: null,
      subscriptionId: 's1',
      type: 'CONSUME',
      creditsAmount: -10,
      source: 'llm',
      quotaAfter: 90,
      bonusAfter: 0,
      inputTokens: null,
      cachedInputTokens: null,
      outputTokens: null,
      totalTokens: null,
      requestId: null,
      createdAt: new Date('2026-07-11T00:00:00Z'),
    }]);
    prisma.creditTransaction.count.mockResolvedValue(1);

    const result = await service.getTransactions('s1', 'u1', 1, 20);

    expect(result.total).toBe(1);
    expect(result.items[0]).toMatchObject({ id: 'tx1', createdAt: '2026-07-11T00:00:00.000Z' });
  });

  it('schedules threshold checking only after a successful deduction', async () => {
    const threshold = { check: jest.fn().mockResolvedValue(undefined) };
    const { service, balanceState } = await buildCreditService({ threshold });
    balanceState.seed('s1', 'u1', 100, 0);

    await service.deduct('s1', 'u1', 10, 'llm');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(threshold.check).toHaveBeenCalledWith('u1');
  });

  it('does not schedule threshold checking after insufficient balance', async () => {
    const threshold = { check: jest.fn().mockResolvedValue(undefined) };
    const { service, balanceState } = await buildCreditService({ threshold });
    balanceState.seed('s1', 'u1', 1, 0);

    await service.deduct('s1', 'u1', 10, 'llm');
    await new Promise<void>((resolve) => setImmediate(resolve));

    expect(threshold.check).not.toHaveBeenCalled();
  });
});

describe('CreditService R6 negative-balance terminal settlement', () => {
  it('crosses zero into negative quota when allowNegativeBalance is set (bonus drained to 0)', async () => {
    const { service, prisma, balanceState } = await buildCreditService();
    balanceState.seed('s1', 'u1', 100, 50, 4n); // available=150 < cost 200

    const result = await service.deduct('s1', 'u1', 200, 'llm', undefined, undefined, {
      allowNegativeBalance: true,
    });

    expect(result).toMatchObject({ success: true, quota: -50, bonus: 0 });
    expect(balanceState.snapshot('s1', 'u1')).toMatchObject({ quota: -50, bonus: 0, version: 5n });
    const consume = prisma.creditTransaction.create.mock.calls
      .map((c: any[]) => c[0].data)
      .find((d: any) => d.type === 'CONSUME');
    expect(consume).toMatchObject({ creditsAmount: -200, quotaAfter: -50, bonusAfter: 0 });
  });

  it('still rejects (no cross-zero) when allowNegativeBalance is absent — switch-off equivalence', async () => {
    const { service, prisma, balanceState } = await buildCreditService();
    balanceState.seed('s1', 'u1', 100, 50, 4n);

    const result = await service.deduct('s1', 'u1', 200, 'llm');

    expect(result).toMatchObject({ success: false, quota: 100, bonus: 50 });
    expect(balanceState.snapshot('s1', 'u1')).toMatchObject({ quota: 100, bonus: 50, version: 4n });
    expect(prisma.creditTransaction.create).not.toHaveBeenCalled();
  });

  it('refuses a second crossing once available<=0 (at-most-one-crossing second gate)', async () => {
    const { service, prisma, balanceState } = await buildCreditService();
    balanceState.seed('s1', 'u1', -50, 0, 6n); // already in debt

    const result = await service.deduct('s1', 'u1', 10, 'llm', undefined, undefined, {
      allowNegativeBalance: true,
    });

    expect(result).toMatchObject({ success: false });
    expect(balanceState.snapshot('s1', 'u1')).toMatchObject({ quota: -50, version: 6n });
    expect(prisma.creditTransaction.create).not.toHaveBeenCalled();
  });

  it('refuses to re-cross zero after a bonus top-up while already in debt (codex P1#2)', async () => {
    const { service, prisma, balanceState } = await buildCreditService();
    balanceState.seed('s1', 'u1', -50, 51, 7n); // 负债期被充了 bonus：available=1>0 但 quota<0

    const result = await service.deduct('s1', 'u1', 100, 'llm', undefined, undefined, {
      allowNegativeBalance: true,
    });

    expect(result).toMatchObject({ success: false });
    expect(balanceState.snapshot('s1', 'u1')).toMatchObject({ quota: -50, bonus: 51, version: 7n });
    expect(prisma.creditTransaction.create).not.toHaveBeenCalled();
  });

  it('still repays quota debt from bonus on a fully-covered deduct (normal branch unaffected)', async () => {
    const { service, balanceState } = await buildCreditService();
    balanceState.seed('s1', 'u1', -50, 100, 3n); // available=50 >= cost 30 → 正常分支

    const result = await service.deduct('s1', 'u1', 30, 'llm', undefined, undefined, {
      allowNegativeBalance: true,
    });

    // quota 由 -50 回补到 0，bonus 承担净扣：守恒 total 50→20
    expect(result).toMatchObject({ success: true, quota: 0, bonus: 20 });
  });

  it('resetQuota net mode settles debt additively as a single GRANT row (no reset row)', async () => {
    const { service, prisma, balanceState } = await buildCreditService();
    balanceState.seed('s1', 'u1', -50, 0, 2n);

    await service.resetQuota('s1', 'u1', 35000, 'renewal', { idempotencyKey: 'reset-net' });

    expect(balanceState.snapshot('s1', 'u1')).toMatchObject({ quota: 34_950, bonus: 0, version: 3n });
    expect(prisma.creditTransaction.create).toHaveBeenCalledTimes(1);
    expect(prisma.creditTransaction.create.mock.calls[0][0].data).toMatchObject({
      type: 'QUOTA_GRANT',
      creditsAmount: 35000,
      quotaAfter: 34_950,
      idempotencyKey: 'reset-net',
    });
  });

  it('resetQuota net mode keeps residual debt when newQuota < debt', async () => {
    const { service, balanceState } = await buildCreditService();
    balanceState.seed('s1', 'u1', -50000, 0, 1n);

    await service.resetQuota('s1', 'u1', 35000, 'renewal', { idempotencyKey: 'reset-net2' });

    expect(balanceState.snapshot('s1', 'u1')).toMatchObject({ quota: -15000, bonus: 0 });
  });

  it('resetQuota forgive mode clears debt to 0 then sets full quota (reset+grant pair)', async () => {
    const { service, prisma, balanceState } = await buildCreditService();
    balanceState.seed('s1', 'u1', -50, 0, 2n);

    await service.resetQuota('s1', 'u1', 35000, 'renewal', {
      idempotencyKey: 'reset-forgive',
      negativeSettleMode: 'forgive',
    });

    expect(balanceState.snapshot('s1', 'u1')).toMatchObject({ quota: 35000, bonus: 0 });
    expect(prisma.creditTransaction.create).toHaveBeenCalledTimes(2);
    expect(prisma.creditTransaction.create.mock.calls[0][0].data).toMatchObject({
      type: 'QUOTA_RESET',
      creditsAmount: 50,
      source: 'reset:renewal',
      quotaAfter: 0,
    });
    expect(prisma.creditTransaction.create.mock.calls[1][0].data).toMatchObject({
      type: 'QUOTA_GRANT',
      creditsAmount: 35000,
      quotaAfter: 35000,
    });
  });

  it('grantQuota refuses to SET over a negative quota (must settle via resetQuota)', async () => {
    const { service, balanceState } = await buildCreditService();
    balanceState.seed('s1', 'u1', -50, 0, 1n);

    await expect(
      service.grantQuota('s1', 'u1', 100, 'monthly', { idempotencyKey: 'grant-neg' }),
    ).rejects.toThrow(/negative quota/);
    expect(balanceState.snapshot('s1', 'u1')).toMatchObject({ quota: -50 });
  });
});
