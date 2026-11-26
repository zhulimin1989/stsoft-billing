import { randomUUID } from 'node:crypto';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { Test, TestingModule } from '@nestjs/testing';
import { CreditTxType } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import {
  CreditBalanceStateService,
  creditBalanceCacheKey,
} from './credit-balance-state.service';
import { CreditService } from './credit.service';

/**
 * Mutating integration test: requires isolated PostgreSQL + Redis with all migrations applied.
 *
 * TEST_INTEGRATION=1 RUIDONG_SERVICE=billing \
 *   pnpm --filter @ruidong/api test -- --runInBand \
 *   --testPathPattern=credit-balance-consistency.integration
 */
const maybeDescribe = process.env.TEST_INTEGRATION === '1' ? describe : describe.skip;

function withLongTransactions(prisma: PrismaService): PrismaService {
  return new Proxy(prisma, {
    get(target, prop, receiver) {
      if (prop === '$transaction') {
        return (arg: unknown, options?: unknown) => {
          if (typeof arg === 'function') {
            return (target as any).$transaction(arg, {
              maxWait: 30_000,
              timeout: 30_000,
              ...((options && typeof options === 'object') ? options : {}),
            });
          }
          return (target as any).$transaction(arg, options);
        };
      }
      const value = Reflect.get(target, prop, receiver);
      return typeof value === 'function' ? value.bind(target) : value;
    },
  }) as PrismaService;
}

function deferred(): { promise: Promise<void>; resolve: () => void } {
  let resolve!: () => void;
  const promise = new Promise<void>((done) => { resolve = done; });
  return { promise, resolve };
}

maybeDescribe('Credit balance V2 concurrency (integration)', () => {
  let moduleRef: TestingModule;
  let prisma: PrismaService;
  let redis: RedisService;
  let credit: CreditService;
  let balanceState: CreditBalanceStateService;
  const createdUsers = new Set<string>();
  const createdSubscriptions = new Set<string>();

  beforeAll(async () => {
    let realPrisma: PrismaService | undefined;
    moduleRef = await Test.createTestingModule({
      imports: [ConfigModule.forRoot({ isGlobal: true, envFilePath: ['.env.test', '.env'] })],
      providers: [
        CreditService,
        CreditBalanceStateService,
        RedisService,
        {
          provide: PrismaService,
          inject: [ConfigService],
          useFactory: (config: ConfigService) => {
            realPrisma = new PrismaService(config);
            return withLongTransactions(realPrisma);
          },
        },
      ],
    }).compile();
    if (!realPrisma) throw new Error('PrismaService failed to initialize');
    prisma = realPrisma;
    redis = moduleRef.get(RedisService);
    credit = moduleRef.get(CreditService);
    balanceState = moduleRef.get(CreditBalanceStateService);
    await Promise.all([prisma.$connect(), redis.ping()]);
  });

  afterEach(async () => {
    for (const subscriptionId of createdSubscriptions) {
      await redis.del(
        creditBalanceCacheKey(subscriptionId),
        `credits:quota:${subscriptionId}`,
        `credits:bonus:${subscriptionId}`,
      );
    }
    const userIds = [...createdUsers];
    if (userIds.length > 0) {
      await prisma.creditBalanceOutbox.deleteMany({
        where: { balanceState: { userId: { in: userIds } } },
      });
      await prisma.creditBalanceState.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.creditTransaction.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.idempotencyKey.deleteMany({ where: { userId: { in: userIds } } });
      await prisma.user.deleteMany({ where: { id: { in: userIds } } });
    }
    createdUsers.clear();
    createdSubscriptions.clear();
  });

  afterAll(async () => {
    await moduleRef?.close().catch(() => undefined);
  });

  async function createBalance(quota: number, bonus = 0, version = 0n) {
    const suffix = randomUUID();
    const userId = `cbv2-user-${suffix}`;
    const subscriptionId = `cbv2-sub-${suffix}`;
    await prisma.user.create({
      data: {
        id: userId,
        email: `${userId}@example.test`,
        nickname: 'Credit V2 integration',
      },
    });
    createdUsers.add(userId);
    await prisma.creditBalanceState.create({
      data: { subscriptionId, userId, quota, bonus, version },
    });
    createdSubscriptions.add(subscriptionId);
    return { userId, subscriptionId };
  }

  it('serializes 101 concurrent deductions without overdrawing 100 credits', async () => {
    const subject = await createBalance(100);

    const results = await Promise.all(
      Array.from({ length: 101 }, (_, index) =>
        credit.deduct(subject.subscriptionId, subject.userId, 1, `concurrent-${index}`)),
    );

    expect(results.filter((result) => result.success)).toHaveLength(100);
    expect(results.filter((result) => !result.success)).toHaveLength(1);
    const [state, transactions, cache] = await Promise.all([
      prisma.creditBalanceState.findUniqueOrThrow({
        where: { subscriptionId: subject.subscriptionId },
      }),
      prisma.creditTransaction.findMany({
        where: { subscriptionId: subject.subscriptionId, type: CreditTxType.CONSUME },
        orderBy: { balanceVersion: 'asc' },
      }),
      redis.hmget(creditBalanceCacheKey(subject.subscriptionId), 'version', 'quota', 'bonus'),
    ]);
    expect(state).toMatchObject({ quota: 0, bonus: 0, version: 100n });
    expect(transactions).toHaveLength(100);
    expect(new Set(transactions.map((tx) => tx.balanceVersion?.toString())).size).toBe(100);
    expect(cache).toEqual(['100', '0', '0']);
  }, 60_000);

  it('rejects a delayed older bonus cache projection after a newer deduction projection', async () => {
    const subject = await createBalance(100);
    const firstProjectionStarted = deferred();
    const releaseFirstProjection = deferred();
    const originalEval = redis.eval.bind(redis) as (...args: any[]) => Promise<unknown>;
    let projectionCalls = 0;
    const evalSpy = jest.spyOn(redis, 'eval').mockImplementation((async (...args: any[]) => {
      if (String(args[0]).includes("HMGET") && projectionCalls++ === 0) {
        firstProjectionStarted.resolve();
        await releaseFirstProjection.promise;
      }
      return originalEval(...args);
    }) as never);

    try {
      const bonusPromise = credit.addBonus(
        subject.subscriptionId,
        subject.userId,
        50,
        'concurrent-bonus',
        {
        idempotencyKey: `bonus:${subject.subscriptionId}`,
        },
      );
      await firstProjectionStarted.promise;
      const deductResult = await credit.deduct(
        subject.subscriptionId,
        subject.userId,
        30,
        'concurrent-deduct',
      );
      expect(deductResult.success).toBe(true);
      releaseFirstProjection.resolve();
      await bonusPromise;
    } finally {
      releaseFirstProjection.resolve();
      evalSpy.mockRestore();
    }

    const state = await prisma.creditBalanceState.findUniqueOrThrow({
      where: { subscriptionId: subject.subscriptionId },
    });
    const cache = await redis.hmget(
      creditBalanceCacheKey(subject.subscriptionId),
      'version',
      'quota',
      'bonus',
    );
    expect(state.quota + state.bonus).toBe(120);
    expect(state.version).toBe(2n);
    expect(cache).toEqual(['2', state.quota.toString(), state.bonus.toString()]);
  }, 30_000);

  it('does not let a cold-fill snapshot overwrite a deduction committed while CAS is paused', async () => {
    const subject = await createBalance(100, 0, 1n);
    await redis.del(creditBalanceCacheKey(subject.subscriptionId));
    const coldFillStarted = deferred();
    const releaseColdFill = deferred();
    const originalEval = redis.eval.bind(redis) as (...args: any[]) => Promise<unknown>;
    let projectionCalls = 0;
    const evalSpy = jest.spyOn(redis, 'eval').mockImplementation((async (...args: any[]) => {
      if (String(args[0]).includes('HMGET') && projectionCalls++ === 0) {
        coldFillStarted.resolve();
        await releaseColdFill.promise;
      }
      return originalEval(...args);
    }) as never);

    try {
      const coldRead = credit.getBalances(subject.subscriptionId, subject.userId);
      await coldFillStarted.promise;
      const deduction = await credit.deduct(subject.subscriptionId, subject.userId, 10, 'cold-race');
      expect(deduction.success).toBe(true);
      releaseColdFill.resolve();
      await coldRead;
    } finally {
      releaseColdFill.resolve();
      evalSpy.mockRestore();
    }

    const state = await prisma.creditBalanceState.findUniqueOrThrow({
      where: { subscriptionId: subject.subscriptionId },
    });
    // Inline delivery may still be racing when Promise.all resolves only if another worker claimed it;
    // an explicit read performs the same safe CAS backfill and returns the final cache snapshot.
    await credit.getBalances(subject.subscriptionId, subject.userId);
    const cache = await redis.hmget(
      creditBalanceCacheKey(subject.subscriptionId),
      'version',
      'quota',
      'bonus',
    );
    expect(state).toMatchObject({ quota: 90, bonus: 0, version: 2n });
    expect(cache).toEqual(['2', '90', '0']);
  }, 30_000);

  it.each(['grant', 'bonus'] as const)(
    'serializes concurrent first %s requests with the same idempotency key',
    async (kind) => {
      const subject = await createBalance(0);
      const key = `${kind}:${subject.subscriptionId}`;
      const operation = kind === 'grant'
        ? () => credit.grantQuota(subject.subscriptionId, subject.userId, 50, kind, {
            idempotencyKey: key,
          })
        : () => credit.addBonus(subject.subscriptionId, subject.userId, 50, kind, {
            idempotencyKey: key,
          });

      await Promise.all([operation(), operation()]);

      const [state, transactions, outbox] = await Promise.all([
        prisma.creditBalanceState.findUniqueOrThrow({
          where: { subscriptionId: subject.subscriptionId },
        }),
        prisma.creditTransaction.findMany({
          where: { subscriptionId: subject.subscriptionId },
        }),
        prisma.creditBalanceOutbox.count({
          where: { subscriptionId: subject.subscriptionId },
        }),
      ]);
      expect(state.version).toBe(1n);
      expect(state.quota + state.bonus).toBe(50);
      expect(transactions).toHaveLength(1);
      expect(transactions[0].balanceVersion).toBe(1n);
      expect(outbox).toBe(0);
    },
    30_000,
  );

  it('recovers a committed mutation through the outbox after Redis projection fails', async () => {
    const subject = await createBalance(0);
    const evalSpy = jest.spyOn(redis, 'eval').mockRejectedValueOnce(new Error('redis unavailable'));

    await credit.addBonus(subject.subscriptionId, subject.userId, 25, 'outbox-recovery', {
      idempotencyKey: `bonus:${subject.subscriptionId}`,
    });
    evalSpy.mockRestore();

    const failed = await prisma.creditBalanceOutbox.findFirstOrThrow({
      where: { subscriptionId: subject.subscriptionId },
    });
    expect(failed.status).toBe('FAILED');
    await prisma.creditBalanceOutbox.update({
      where: { id: failed.id },
      data: { nextRunAt: new Date(0) },
    });
    const flushed = await balanceState.flushOutbox(10, 'integration-worker');

    expect(flushed).toEqual({ scanned: 1, delivered: 1, failed: 0 });
    expect(await redis.hmget(
      creditBalanceCacheKey(subject.subscriptionId),
      'version',
      'quota',
      'bonus',
    )).toEqual(['1', '0', '25']);
    expect(await prisma.creditBalanceOutbox.count({
      where: { subscriptionId: subject.subscriptionId },
    })).toBe(0);
  }, 30_000);

  it('keeps a historical grant replay as a no-op after consumption', async () => {
    const subject = await createBalance(0);
    const key = `grant:${subject.subscriptionId}`;
    await credit.grantQuota(subject.subscriptionId, subject.userId, 100, 'monthly', {
      idempotencyKey: key,
    });
    await credit.deduct(subject.subscriptionId, subject.userId, 80, 'usage');

    await Promise.all(
      Array.from({ length: 20 }, () =>
        credit.grantQuota(subject.subscriptionId, subject.userId, 100, 'monthly', {
          idempotencyKey: key,
        })),
    );

    const [state, grants, cache] = await Promise.all([
      prisma.creditBalanceState.findUniqueOrThrow({
        where: { subscriptionId: subject.subscriptionId },
      }),
      prisma.creditTransaction.count({
        where: { subscriptionId: subject.subscriptionId, type: CreditTxType.QUOTA_GRANT },
      }),
      redis.hmget(creditBalanceCacheKey(subject.subscriptionId), 'version', 'quota', 'bonus'),
    ]);
    expect(state).toMatchObject({ quota: 20, bonus: 0, version: 2n });
    expect(grants).toBe(1);
    expect(cache).toEqual(['2', '20', '0']);
  }, 30_000);

  it('keeps the subscription owner while a tenant member consumes the shared pool', async () => {
    const subject = await createBalance(100);
    const memberId = `cbv2-member-${randomUUID()}`;
    await prisma.user.create({
      data: {
        id: memberId,
        email: `${memberId}@example.test`,
        nickname: 'Credit V2 member',
      },
    });
    createdUsers.add(memberId);

    const result = await credit.deduct(subject.subscriptionId, memberId, 25, 'member-usage');

    expect(result).toMatchObject({ success: true, quota: 75, bonus: 0 });
    const [state, transaction] = await Promise.all([
      prisma.creditBalanceState.findUniqueOrThrow({
        where: { subscriptionId: subject.subscriptionId },
      }),
      prisma.creditTransaction.findFirstOrThrow({
        where: { subscriptionId: subject.subscriptionId, type: CreditTxType.CONSUME },
      }),
    ]);
    expect(state).toMatchObject({ userId: subject.userId, quota: 75, version: 1n });
    expect(transaction.userId).toBe(memberId);
  }, 30_000);
});
