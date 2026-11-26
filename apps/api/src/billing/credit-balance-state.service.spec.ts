import { CreditBalanceOutboxStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import {
  CreditBalanceStateService,
  creditBalanceCacheKey,
} from './credit-balance-state.service';

function outboxRow(overrides: Record<string, unknown> = {}) {
  const now = new Date();
  return {
    id: 'outbox-1',
    subscriptionId: 's1',
    version: 2n,
    quota: 90,
    bonus: 5,
    status: CreditBalanceOutboxStatus.PENDING,
    attempts: 0,
    maxAttempts: 12,
    nextRunAt: now,
    lockedAt: null,
    lockedBy: null,
    lastError: null,
    processedAt: null,
    createdAt: now,
    updatedAt: now,
    ...overrides,
  };
}

function makeHarness(initial?: {
  subscriptionId: string;
  userId: string;
  quota: number;
  bonus: number;
  version: bigint;
}) {
  let state = initial ? { ...initial, createdAt: new Date(), updatedAt: new Date() } : null;
  const createdOutbox: any[] = [];
  const prisma: any = {
    creditBalanceState: {
      findUnique: jest.fn(async () => state),
      create: jest.fn(async ({ data }: any) => {
        state = { ...data, createdAt: new Date(), updatedAt: new Date() };
        return state;
      }),
      updateMany: jest.fn(async ({ where, data }: any) => {
        if (!state || state.subscriptionId !== where.subscriptionId || state.version !== where.version) {
          return { count: 0 };
        }
        state = { ...state, ...data, updatedAt: new Date() };
        return { count: 1 };
      }),
    },
    creditTransaction: {
      findFirst: jest.fn().mockResolvedValue(null),
    },
    subscriptionPeriod: {
      findUnique: jest.fn().mockResolvedValue({ userId: initial?.userId ?? 'u1' }),
    },
    codingPlanEntitlement: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    creditBalanceOutbox: {
      create: jest.fn(async ({ data }: any) => {
        const row = outboxRow({
          id: `outbox-${createdOutbox.length + 1}`,
          ...data,
        });
        createdOutbox.push(row);
        return row;
      }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
      findMany: jest.fn().mockResolvedValue([]),
    },
    $executeRaw: jest.fn().mockResolvedValue(undefined),
    $transaction: jest.fn(async (fn: (tx: any) => unknown) => fn(prisma)),
  };
  const redis: any = {
    hmget: jest.fn().mockResolvedValue([null, null, null]),
    mget: jest.fn().mockResolvedValue([null, null]),
    eval: jest.fn().mockResolvedValue([1, '0', '0', '0']),
  };
  const service = new CreditBalanceStateService(
    prisma as PrismaService,
    redis as RedisService,
  );
  return {
    service,
    prisma,
    redis,
    createdOutbox,
    state: () => state,
  };
}

describe('CreditBalanceStateService', () => {
  it('uses one Redis hash key for an atomic quota/bonus/version snapshot', () => {
    expect(creditBalanceCacheKey('sub-1')).toBe('credits:v2:{sub-1}');
  });

  it('returns a complete cached snapshot without reading PostgreSQL', async () => {
    const { service, prisma, redis } = makeHarness();
    redis.hmget.mockResolvedValueOnce(['7', '500', '20']);

    const result = await service.get('s1', 'u1');

    expect(result).toEqual({
      subscriptionId: 's1',
      userId: 'u1',
      version: 7n,
      quota: 500,
      bonus: 20,
    });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns the newer cache snapshot when a cold-fill candidate loses the CAS race', async () => {
    const { service, redis } = makeHarness({
      subscriptionId: 's1',
      userId: 'u1',
      quota: 100,
      bonus: 0,
      version: 1n,
    });
    redis.eval.mockResolvedValueOnce([-1, '2', '90', '0']);

    const result = await service.get('s1', 'u1');

    expect(result).toMatchObject({ version: 2n, quota: 90, bonus: 0 });
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining('version_order < 0'),
      1,
      'credits:v2:{s1}',
      '1',
      '100',
      '0',
    );
  });

  it('uses PostgreSQL for authoritative reads even when Redis contains an older balance', async () => {
    const { service, prisma, redis } = makeHarness({
      subscriptionId: 's1',
      userId: 'owner',
      quota: 40,
      bonus: 5,
      version: 3n,
    });
    redis.hmget.mockResolvedValueOnce(['2', '100', '5']);
    redis.eval.mockResolvedValueOnce([1, '3', '40', '5']);

    const result = await service.getAuthoritative('s1', 'member');

    expect(result).toMatchObject({ userId: 'owner', quota: 40, bonus: 5, version: 3n });
    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(redis.hmget).not.toHaveBeenCalled();
  });

  it('fails closed when an existing legacy subscription was not verified and backfilled', async () => {
    const { service, prisma } = makeHarness();
    prisma.creditTransaction.findFirst.mockResolvedValueOnce({
      userId: 'u1',
      quotaAfter: 80,
      bonusAfter: 10,
    });

    await expect(service.get('s1', 'u1')).rejects.toThrow(
      'run the verified balance-state backfill',
    );

    expect(prisma.creditTransaction.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { subscriptionId: 's1' },
      }),
    );
  });

  it('fails closed when an orphan QUOTA_RESET is the only legacy row', async () => {
    const { service, prisma } = makeHarness();
    prisma.creditTransaction.findFirst.mockResolvedValueOnce({ id: 'orphan-reset' });

    await expect(service.getAuthoritative('s1', 'u1')).rejects.toThrow(
      'run the verified balance-state backfill',
    );
    expect(prisma.creditBalanceState.create).not.toHaveBeenCalled();
  });

  it('initializes a genuinely new subscription at zero', async () => {
    const { service, prisma, redis, state } = makeHarness();
    prisma.subscriptionPeriod.findUnique.mockResolvedValueOnce({ userId: 'owner' });
    redis.eval.mockResolvedValueOnce([1, '0', '0', '0']);

    const result = await service.get('s1', 'member');

    expect(result).toMatchObject({ quota: 0, bonus: 0, version: 0n });
    expect(state()).toMatchObject({ subscriptionId: 's1', userId: 'owner' });
  });

  it('creates a clean missing state inside the caller transaction without nesting', async () => {
    const { service, prisma, state } = makeHarness();
    prisma.subscriptionPeriod.findUnique.mockResolvedValue({ userId: 'scope-owner' });

    const result = await service.ensureLockedState(prisma, 's1', 'tenant-member');

    expect(result).toMatchObject({
      subscriptionId: 's1',
      userId: 'scope-owner',
      quota: 0,
      bonus: 0,
      version: 0n,
    });
    expect(state()).toMatchObject({ subscriptionId: 's1', userId: 'scope-owner' });
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('fails a transaction-scoped ensure when legacy evidence was not backfilled', async () => {
    const { service, prisma } = makeHarness();
    prisma.creditTransaction.findFirst.mockResolvedValue({ id: 'legacy-consume' });

    await expect(
      service.ensureLockedState(prisma, 's1', 'tenant-member'),
    ).rejects.toThrow('run the verified balance-state backfill');

    expect(prisma.creditBalanceState.create).not.toHaveBeenCalled();
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('validates an existing state owner against the scope owner, not the request actor', async () => {
    const { service, prisma } = makeHarness({
      subscriptionId: 's1',
      userId: 'wrong-owner',
      quota: 100,
      bonus: 0,
      version: 1n,
    });
    prisma.subscriptionPeriod.findUnique.mockResolvedValue({ userId: 'scope-owner' });

    await expect(
      service.ensureLockedState(prisma, 's1', 'tenant-member'),
    ).rejects.toThrow(
      'credit balance state owner mismatch subscription=s1 stateOwner=wrong-owner scopeOwner=scope-owner',
    );
  });

  it('refuses to create a zero balance for an unknown random scope', async () => {
    const { service, prisma } = makeHarness();
    prisma.subscriptionPeriod.findUnique.mockResolvedValueOnce(null);
    prisma.codingPlanEntitlement.findUnique.mockResolvedValueOnce(null);

    await expect(service.getAuthoritative('missing', 'actor')).rejects.toThrow(
      'credit balance scope not found',
    );
  });

  it('fails closed for a Redis-only legacy scope instead of initializing it to zero', async () => {
    const { service, prisma, redis } = makeHarness();
    redis.mget.mockResolvedValueOnce(['75', '10']);

    await expect(service.getAuthoritative('s1', 'member')).rejects.toThrow(
      'legacy Redis scope',
    );
    expect(prisma.creditBalanceState.create).not.toHaveBeenCalled();
  });

  it('updates state, ledger callback, and outbox before publishing the cache snapshot', async () => {
    const { service, prisma, redis, createdOutbox, state } = makeHarness({
      subscriptionId: 's1',
      userId: 'u1',
      quota: 100,
      bonus: 5,
      version: 1n,
    });
    const persist = jest.fn().mockResolvedValue('persisted');
    redis.eval.mockResolvedValueOnce([1, '2', '90', '5']);

    const result = await service.mutate(
      's1',
      'u1',
      (current) => ({ quota: current.quota - 10, bonus: current.bonus }),
      persist,
    );

    expect(result).toMatchObject({ changed: true, value: 'persisted' });
    expect(result.snapshot).toMatchObject({ quota: 90, bonus: 5, version: 2n });
    expect(state()).toMatchObject({ quota: 90, bonus: 5, version: 2n });
    expect(persist).toHaveBeenCalledWith(
      prisma,
      expect.objectContaining({ version: 1n }),
      expect.objectContaining({ version: 2n }),
    );
    expect(createdOutbox).toHaveLength(1);
    expect(createdOutbox[0]).toMatchObject({ version: 2n, quota: 90, bonus: 5 });
    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('HSET'"),
      1,
      'credits:v2:{s1}',
      '2',
      '90',
      '5',
    );
  });

  it('does not update state or outbox when a mutation is rejected as insufficient', async () => {
    const { service, prisma, redis, createdOutbox, state } = makeHarness({
      subscriptionId: 's1',
      userId: 'u1',
      quota: 10,
      bonus: 0,
      version: 4n,
    });
    const persist = jest.fn();

    const result = await service.mutate('s1', 'u1', () => null, persist);

    expect(result).toMatchObject({ changed: false });
    expect(state()).toMatchObject({ quota: 10, version: 4n });
    expect(prisma.creditBalanceState.updateMany).not.toHaveBeenCalled();
    expect(createdOutbox).toHaveLength(0);
    expect(persist).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('marks an outbox event for manual review on equal-version different-balance conflict', async () => {
    const { service, prisma, redis } = makeHarness({
      subscriptionId: 's1',
      userId: 'u1',
      quota: 100,
      bonus: 0,
      version: 1n,
    });
    redis.eval.mockResolvedValueOnce([-2, '2', '999', '0']);

    await service.mutate(
      's1',
      'u1',
      (current) => ({ quota: current.quota - 10, bonus: current.bonus }),
      async () => undefined,
    );

    expect(prisma.creditBalanceOutbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'MANUAL_REVIEW' }),
      }),
    );
  });

  it('rejects a late writer cache delivery after a newer deduction has committed', async () => {
    const { service, redis, state } = makeHarness({
      subscriptionId: 's1',
      userId: 'u1',
      quota: 100,
      bonus: 0,
      version: 1n,
    });
    let signalFirstEval!: () => void;
    let releaseFirstEval!: () => void;
    const firstEvalStarted = new Promise<void>((resolve) => { signalFirstEval = resolve; });
    const firstEvalRelease = new Promise<void>((resolve) => { releaseFirstEval = resolve; });
    redis.eval
      .mockImplementationOnce(async () => {
        signalFirstEval();
        await firstEvalRelease;
        return [-1, '3', '120', '0'];
      })
      .mockResolvedValueOnce([1, '3', '120', '0']);

    const delayedGrant = service.mutate(
      's1',
      'u1',
      (current) => ({ quota: current.quota + 50, bonus: current.bonus }),
      async () => undefined,
    );
    await firstEvalStarted;

    await service.mutate(
      's1',
      'u1',
      (current) => ({ quota: current.quota - 30, bonus: current.bonus }),
      async () => undefined,
    );
    releaseFirstEval();
    await delayedGrant;

    expect(state()).toMatchObject({ quota: 120, bonus: 0, version: 3n });
    expect(redis.eval.mock.calls[0].slice(-3)).toEqual(['2', '150', '0']);
    expect(redis.eval.mock.calls[1].slice(-3)).toEqual(['3', '120', '0']);
  });

  it('keeps the scope owner while a tenant member mutates the shared balance', async () => {
    const { service, state } = makeHarness({
      subscriptionId: 's1',
      userId: 'owner',
      quota: 100,
      bonus: 0,
      version: 1n,
    });

    await service.mutate(
      's1',
      'member',
      () => ({ quota: 90, bonus: 0 }),
      async () => undefined,
    );

    expect(state()).toMatchObject({ userId: 'owner', quota: 90, version: 2n });
  });

  it('retries pending outbox events and accepts a cache that already has a newer version', async () => {
    const { service, prisma, redis } = makeHarness({
      subscriptionId: 's1',
      userId: 'u1',
      quota: 80,
      bonus: 5,
      version: 3n,
    });
    const row = outboxRow({ status: 'FAILED', attempts: 1 });
    prisma.creditBalanceOutbox.findMany.mockResolvedValueOnce([row]);
    redis.eval.mockResolvedValueOnce([-1, '3', '80', '5']);

    const result = await service.flushOutbox(10, 'worker-1');

    expect(result).toEqual({ scanned: 1, delivered: 1, failed: 0 });
    expect(prisma.creditBalanceOutbox.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'RUNNING',
          lockedBy: 'worker-1',
          attempts: { increment: 1 },
        }),
      }),
    );
    expect(prisma.creditBalanceOutbox.deleteMany).toHaveBeenCalledWith({
      where: {
        id: 'outbox-1',
        status: 'RUNNING',
        lockedBy: 'worker-1',
      },
    });
  });

  it('does not delete an outbox event when Redis version is ahead of PostgreSQL', async () => {
    const { service, prisma, redis } = makeHarness({
      subscriptionId: 's1',
      userId: 'u1',
      quota: 90,
      bonus: 5,
      version: 2n,
    });
    prisma.creditBalanceOutbox.findMany.mockResolvedValueOnce([
      outboxRow({ version: 1n, quota: 100, bonus: 5 }),
    ]);
    redis.eval.mockResolvedValueOnce([-1, '99', '999', '0']);

    const result = await service.flushOutbox(10, 'worker-1');

    expect(result).toEqual({ scanned: 1, delivered: 0, failed: 1 });
    expect(prisma.creditBalanceOutbox.deleteMany).not.toHaveBeenCalled();
    expect(prisma.creditBalanceOutbox.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'MANUAL_REVIEW',
          lastError: expect.stringContaining('cache_ahead_of_database'),
        }),
      }),
    );
  });

  it('keeps retrying transient delivery failures after the alert threshold', async () => {
    const { service, prisma, redis } = makeHarness();
    prisma.creditBalanceOutbox.findMany.mockResolvedValueOnce([
      outboxRow({ status: 'FAILED', attempts: 12, maxAttempts: 12 }),
    ]);
    redis.eval.mockRejectedValueOnce(new Error('redis unavailable'));

    const result = await service.flushOutbox(10, 'worker-1');

    expect(result).toEqual({ scanned: 1, delivered: 0, failed: 1 });
    expect(prisma.creditBalanceOutbox.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'FAILED' }),
      }),
    );
  });
});
