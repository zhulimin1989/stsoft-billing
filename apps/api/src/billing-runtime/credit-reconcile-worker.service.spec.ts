import { ConfigService } from '@nestjs/config';
import { CreditService } from '../billing/credit.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { CreditReconcileWorkerService } from './credit-reconcile-worker.service';

function makeService(configValues: Record<string, unknown> = {}) {
  const prisma = {
    creditBalanceState: {
      findMany: jest.fn(),
    },
    grantRedemption: {
      findMany: jest.fn(),
    },
    idempotencyKey: {
      findMany: jest.fn().mockResolvedValue([]),
      update: jest.fn().mockResolvedValue({}),
    },
  } as unknown as jest.Mocked<
    Pick<PrismaService, 'creditBalanceState' | 'grantRedemption' | 'idempotencyKey'>
  >;

  const creditService = {
    reconcileUserCreditCache: jest.fn(),
    reconcileSubscriptionCache: jest.fn(),
    reconcileGrantPool: jest.fn(),
  } as unknown as jest.Mocked<
    Pick<
      CreditService,
      'reconcileUserCreditCache' | 'reconcileSubscriptionCache' | 'reconcileGrantPool'
    >
  >;

  const redis = {
    set: jest.fn().mockResolvedValue('OK'),
    eval: jest.fn().mockResolvedValue(1),
  } as unknown as jest.Mocked<Pick<RedisService, 'set' | 'eval'>>;

  const config = {
    get: jest.fn((key: string, fallback: unknown) => (
      Object.prototype.hasOwnProperty.call(configValues, key)
        ? configValues[key]
        : fallback
    )),
  } as unknown as jest.Mocked<Pick<ConfigService, 'get'>>;

  const service = new CreditReconcileWorkerService(
    prisma as PrismaService,
    creditService as unknown as CreditService,
    redis as unknown as RedisService,
    config as unknown as ConfigService,
  );

  return { service, prisma, creditService, redis, config };
}

describe('CreditReconcileWorkerService', () => {
  it('reconciles distinct users from authoritative balance states and grants', async () => {
    const { service, prisma, creditService } = makeService();

    (prisma.creditBalanceState.findMany as jest.Mock).mockResolvedValue([
      { userId: 'u1' },
      { userId: 'u2' },
    ]);
    (prisma.grantRedemption.findMany as jest.Mock).mockResolvedValue([
      { userId: 'u2' },
      { userId: 'u3' },
    ]);
    (creditService.reconcileUserCreditCache as jest.Mock).mockImplementation(async (userId: string) => ({
      userId,
      grant: { mismatched: userId === 'u3', fixed: userId === 'u3' },
      subscriptions: [
        { mismatched: userId === 'u2', fixed: userId === 'u2' },
      ],
      mismatched: userId === 'u2' || userId === 'u3',
      fixed: userId === 'u2' || userId === 'u3',
    }));

    const result = await service.runOnce('test', { concurrency: 2 });

    expect(prisma.creditBalanceState.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        distinct: ['userId'],
      }),
    );
    expect(prisma.grantRedemption.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          isExpired: false,
          isUsedUp: false,
          OR: expect.any(Array),
        }),
        distinct: ['userId'],
      }),
    );
    expect(creditService.reconcileUserCreditCache).toHaveBeenCalledTimes(3);
    expect(creditService.reconcileUserCreditCache).toHaveBeenNthCalledWith(1, 'u1', { fix: false });
    expect(creditService.reconcileUserCreditCache).toHaveBeenNthCalledWith(2, 'u2', { fix: false });
    expect(creditService.reconcileUserCreditCache).toHaveBeenNthCalledWith(3, 'u3', { fix: false });
    expect(result).toEqual(
      expect.objectContaining({
        skipped: false,
        scannedUsers: 3,
        mismatchedUsers: 2,
        fixedUsers: 2,
        failedUsers: 0,
        subscriptions: 3,
        subscriptionMismatches: 1,
        grantMismatches: 1,
      }),
    );
  });

  it('skips when another worker holds the Redis lock', async () => {
    const { service, prisma, creditService, redis } = makeService();
    (redis.set as jest.Mock).mockResolvedValue(null);

    const result = await service.runOnce('test');

    expect(result.skipped).toBe(true);
    expect(prisma.creditBalanceState.findMany).not.toHaveBeenCalled();
    expect(creditService.reconcileUserCreditCache).not.toHaveBeenCalled();
  });

  it('continues after a per-user reconcile failure', async () => {
    const { service, prisma, creditService } = makeService();
    (prisma.creditBalanceState.findMany as jest.Mock).mockResolvedValue([
      { userId: 'u1' },
      { userId: 'u2' },
    ]);
    (prisma.grantRedemption.findMany as jest.Mock).mockResolvedValue([]);
    (creditService.reconcileUserCreditCache as jest.Mock)
      .mockRejectedValueOnce(new Error('boom'))
      .mockResolvedValueOnce({
        userId: 'u2',
        grant: { mismatched: false, fixed: false },
        subscriptions: [],
        mismatched: false,
        fixed: false,
      });

    const result = await service.runOnce('test', { concurrency: 1, fix: true });

    expect(creditService.reconcileUserCreditCache).toHaveBeenCalledTimes(2);
    expect(result.failedUsers).toBe(1);
    expect(result.scannedUsers).toBe(2);
  });

  it('reconciles stale credit deduct intents and marks them failed after repair', async () => {
    const { service, prisma, creditService } = makeService();
    (prisma.creditBalanceState.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.grantRedemption.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.idempotencyKey.findMany as jest.Mock).mockResolvedValue([
      {
        key: 'credit:deduct:intent:intent-1',
        result: {
          userId: 'u1',
          subscriptionId: 'sub1',
          amount: 100,
          status: 'REDIS_DEBITED',
        },
      },
    ]);
    (creditService.reconcileSubscriptionCache as jest.Mock).mockResolvedValue({
      mismatched: true,
      fixed: true,
    });
    (creditService.reconcileGrantPool as jest.Mock).mockResolvedValue({
      mismatched: false,
      fixed: false,
    });

    const result = await service.runOnce('test', { concurrency: 1, fix: true });

    expect(creditService.reconcileSubscriptionCache).toHaveBeenCalledWith(
      'sub1',
      'u1',
      { fix: true },
    );
    expect(creditService.reconcileGrantPool).toHaveBeenCalledWith('u1', { fix: true });
    expect(prisma.idempotencyKey.update).toHaveBeenCalledWith({
      where: {
        key_scope: {
          key: 'credit:deduct:intent:intent-1',
          scope: 'credit:deduct:intent',
        },
      },
      data: {
        status: 'FAILED',
        result: expect.objectContaining({
          status: 'FAILED',
          reconcileReason: 'stale_credit_deduct_intent',
        }),
      },
    });
    expect(result.staleDeductIntents).toBe(1);
    expect(result.staleDeductIntentFailures).toBe(0);
  });

  it('does not mutate stale credit deduct intents during the default dry run', async () => {
    const { service, prisma, creditService } = makeService();
    (prisma.creditBalanceState.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.grantRedemption.findMany as jest.Mock).mockResolvedValue([]);
    (prisma.idempotencyKey.findMany as jest.Mock).mockResolvedValue([
      {
        key: 'credit:deduct:intent:intent-1',
        result: {
          userId: 'u1',
          subscriptionId: 'sub1',
          status: 'REDIS_DEBITED',
        },
      },
    ]);
    (creditService.reconcileSubscriptionCache as jest.Mock).mockResolvedValue({ mismatched: true, fixed: false });
    (creditService.reconcileGrantPool as jest.Mock).mockResolvedValue({ mismatched: false, fixed: false });

    const result = await service.runOnce('test', { concurrency: 1 });

    expect(creditService.reconcileSubscriptionCache).toHaveBeenCalledWith('sub1', 'u1', {
      fix: false,
    });
    expect(prisma.idempotencyKey.update).not.toHaveBeenCalled();
    expect(result.staleDeductIntents).toBe(1);
  });

  it('enables repair from BILLING_CREDIT_RECONCILE_FIX when opts.fix is omitted', async () => {
    const { service, prisma, creditService } = makeService({
      BILLING_CREDIT_RECONCILE_FIX: 'true',
    });
    (prisma.creditBalanceState.findMany as jest.Mock).mockResolvedValue([{ userId: 'u1' }]);
    (prisma.grantRedemption.findMany as jest.Mock).mockResolvedValue([]);
    (creditService.reconcileUserCreditCache as jest.Mock).mockResolvedValue({
      userId: 'u1',
      grant: { mismatched: false, fixed: false },
      subscriptions: [],
      mismatched: false,
      fixed: false,
    });

    await service.runOnce('test', { concurrency: 1 });

    expect(creditService.reconcileUserCreditCache).toHaveBeenCalledWith('u1', { fix: true });
  });

  it('does not throw when candidate scan fails', async () => {
    const { service, prisma, redis } = makeService();
    (prisma.creditBalanceState.findMany as jest.Mock).mockRejectedValue(new Error('db down'));

    const result = await service.runOnce('test');

    expect(result.skipped).toBe(false);
    expect(result.scannedUsers).toBe(0);
    expect(redis.eval).toHaveBeenCalled();
  });
});
