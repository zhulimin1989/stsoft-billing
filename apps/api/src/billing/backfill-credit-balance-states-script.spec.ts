import {
  parseRequestedScopeIds,
  runCreditBalanceBackfill,
} from '../../scripts/backfill-credit-balance-states';

describe('credit balance state backfill script', () => {
  describe('parseRequestedScopeIds', () => {
    it('uses full mode only when the allowlist variable is absent', () => {
      expect(parseRequestedScopeIds(undefined)).toBeNull();
      expect(() => parseRequestedScopeIds('')).toThrow('was set but empty');
      expect(() => parseRequestedScopeIds('scope-a,,scope-b')).toThrow('empty scope id');
    });

    it('normalizes, de-duplicates, and sorts the explicit allowlist', () => {
      expect(parseRequestedScopeIds(' scope-b,scope-a,scope-b ')).toEqual([
        'scope-a',
        'scope-b',
      ]);
    });
  });

  it('processes only explicitly requested scopes without a full database or Redis scan', async () => {
    const prisma = {
      subscriptionPeriod: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      codingPlanEntitlement: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'scope-target', userId: 'owner-target' },
        ]),
      },
      creditBalanceState: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({}),
      },
      creditTransaction: {
        count: jest.fn().mockResolvedValue(1),
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'grant-1',
            subscriptionId: 'scope-target',
            userId: 'owner-target',
            type: 'QUOTA_GRANT',
            creditsAmount: 330_000,
            source: 'plan:test',
            quotaAfter: 330_000,
            bonusAfter: 0,
            createdAt: new Date('2026-07-01T00:00:00.000Z'),
          },
        ]),
      },
      $queryRaw: jest.fn(),
    };
    const redis = {
      mget: jest.fn().mockResolvedValue(['330000', '0']),
      scan: jest.fn(),
    };

    const counters = await runCreditBalanceBackfill(prisma as never, redis as never, {
      apply: true,
      allowFullApply: false,
      maxTransactionsPerScope: 50_000,
      requestedScopeIds: ['scope-target'],
    });

    expect(counters).toMatchObject({
      scanned: 1,
      verified: 1,
      inserted: 1,
      isolated: 0,
    });
    expect(prisma.codingPlanEntitlement.findMany).toHaveBeenCalledWith({
      where: { id: { in: ['scope-target'] } },
      select: { id: true, userId: true },
    });
    expect(prisma.creditBalanceState.create).toHaveBeenCalledWith({
      data: {
        subscriptionId: 'scope-target',
        userId: 'owner-target',
        quota: 330_000,
        bonus: 0,
        version: 0n,
      },
    });
    expect(prisma.$queryRaw).not.toHaveBeenCalled();
    expect(redis.scan).not.toHaveBeenCalled();
  });

  it('keeps the default full dry-run path and requires separate authorization for full apply', async () => {
    const prisma = {
      subscriptionPeriod: {
        findMany: jest.fn().mockResolvedValue([
          { id: 'scope-full', userId: 'owner-full' },
        ]),
      },
      codingPlanEntitlement: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      creditBalanceState: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn(),
      },
      creditTransaction: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      $queryRaw: jest.fn()
        .mockResolvedValueOnce([{ subscriptionId: 'scope-full' }])
        .mockResolvedValueOnce([]),
    };
    const redis = {
      mget: jest.fn().mockResolvedValue([null, null]),
      scan: jest.fn().mockResolvedValue(['0', []]),
    };

    const counters = await runCreditBalanceBackfill(prisma as never, redis as never, {
      apply: false,
      allowFullApply: false,
      maxTransactionsPerScope: 50_000,
      requestedScopeIds: null,
    });

    expect(counters).toMatchObject({ scanned: 1, empty: 1, inserted: 0, isolated: 0 });
    expect(redis.scan).toHaveBeenCalledTimes(2);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);

    await expect(runCreditBalanceBackfill(prisma as never, redis as never, {
      apply: true,
      allowFullApply: false,
      maxTransactionsPerScope: 50_000,
      requestedScopeIds: null,
    })).rejects.toThrow('full APPLY requires');
    expect(prisma.creditBalanceState.create).not.toHaveBeenCalled();

    prisma.$queryRaw.mockReset().mockResolvedValue([]);
    redis.scan.mockClear();
    await expect(runCreditBalanceBackfill(prisma as never, redis as never, {
      apply: true,
      allowFullApply: true,
      maxTransactionsPerScope: 50_000,
      requestedScopeIds: null,
    })).resolves.toMatchObject({ scanned: 0, inserted: 0, isolated: 0 });
    expect(redis.scan).toHaveBeenCalledTimes(2);
  });
});
