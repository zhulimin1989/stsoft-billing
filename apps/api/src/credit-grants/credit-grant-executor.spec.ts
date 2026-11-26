import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { CreditGrantExecutor } from './credit-grant-executor';
import { CreditGrantsService } from './credit-grants.service';

describe('CreditGrantExecutor', () => {
  let executor: CreditGrantExecutor;
  let prisma: any;
  let service: any;
  let redis: any;

  const baseRule = (overrides: Record<string, unknown> = {}) => ({
    id: 'r1',
    name: 'daily 100',
    triggerType: 'DAILY_CRON',
    cronExpr: '0 0 * * *',
    segmentId: null,
    rewardType: 'CREDIT',
    rewardAmount: 100,
    productId: null,
    expirePolicy: 'PERMANENT',
    expireDays: null,
    perUserLimit: 1,
    globalDailyCap: null,
    isActive: true,
    startAt: null,
    endAt: null,
    notifyType: null,
    notifyTemplate: null,
    lastTriggeredAt: null,
    createdAt: new Date('2026-04-01'),
    updatedAt: new Date('2026-04-01'),
    deletedAt: null,
    ...overrides,
  });

  let redemptionRows: any[];

  beforeEach(async () => {
    redemptionRows = [];
    prisma = {
      $transaction: jest.fn(async (fn: any) => {
        // Pass a stub `db` with the same mocks so per-user calls go through.
        return fn({
          $executeRaw: jest.fn().mockResolvedValue(0),
          creditTransaction: {
            create: jest
              .fn()
              .mockImplementation(({ data }: any) =>
                Promise.resolve({ id: 'tx-' + data.userId, ...data }),
              ),
          },
          grantRedemption: {
            count: jest.fn().mockImplementation(({ where }: any) => {
              const count = redemptionRows.filter((row) => {
                if (where.ruleId && row.ruleId !== where.ruleId) return false;
                if (where.userId && row.userId !== where.userId) return false;
                if (where.createdAt?.gte && row.createdAt < where.createdAt.gte) return false;
                return true;
              }).length;
              return Promise.resolve(count);
            }),
            aggregate: jest.fn().mockImplementation(({ where }: any) => {
              const amount = redemptionRows
                .filter((row) => {
                  if (where.ruleId && row.ruleId !== where.ruleId) return false;
                  if (where.createdAt?.gte && row.createdAt < where.createdAt.gte) return false;
                  return true;
                })
                .reduce((sum, row) => sum + row.amount, 0);
              return Promise.resolve({ _sum: { amount } });
            }),
            create: jest
              .fn()
              .mockImplementation(({ data }: any) => {
                const row = {
                  id: 'g-' + data.userId,
                  createdAt: new Date(),
                  ...data,
                };
                redemptionRows.push(row);
                return Promise.resolve(row);
              }),
          },
        });
      }),
      grantRedemption: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      creditGrantRule: {
        update: jest.fn(),
        findMany: jest.fn(),
      },
    };
    service = {
      resolveTargetUserIds: jest.fn().mockResolvedValue(['u1', 'u2', 'u3']),
      computeExpiresAt: jest.fn().mockReturnValue(null),
    };
    redis = {
      incrby: jest.fn().mockResolvedValue(0),
      decrby: jest.fn().mockResolvedValue(0),
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
      eval: jest.fn().mockResolvedValue([0, 0]),
    };
    const m = await Test.createTestingModule({
      providers: [
        CreditGrantExecutor,
        { provide: PrismaService, useValue: prisma },
        { provide: CreditGrantsService, useValue: service },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();
    executor = m.get(CreditGrantExecutor);
  });

  it('executeRule: grants to all candidate users when no caps', async () => {
    const rule = baseRule();
    const r = await executor.executeRule(rule as any);
    expect(r.attemptedUsers).toBe(3);
    expect(r.granted).toBe(3);
    expect(r.totalAmount).toBe(300);
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(prisma.creditGrantRule.update).toHaveBeenCalled(); // markTriggered
  });

  it('executeRule: applies globalDailyCap as total AMOUNT (spec §7.3)', async () => {
    // 10 candidate users, rewardAmount=100, globalDailyCap=300
    // → cap allows exactly 3 grants (300 / 100), the rest skipped.
    service.resolveTargetUserIds.mockResolvedValueOnce([
      'u1',
      'u2',
      'u3',
      'u4',
      'u5',
      'u6',
      'u7',
      'u8',
      'u9',
      'u10',
    ]);
    const rule = baseRule({ rewardAmount: 100, globalDailyCap: 300 });
    const r = await executor.executeRule(rule as any);
    expect(r.attemptedUsers).toBe(10);
    expect(r.granted).toBe(3);
    expect(r.totalAmount).toBe(300);
    expect(r.skippedCap).toBe(7);
  });

  it('executeRule: globalDailyCap stops mid-loop without partial overspend', async () => {
    // rewardAmount=100, cap=250 → 100 + 100 = 200 OK, +100 = 300 > 250 stop.
    // So 2 grants, totalAmount=200, never exceeds cap.
    service.resolveTargetUserIds.mockResolvedValueOnce(['u1', 'u2', 'u3', 'u4']);
    const rule = baseRule({ rewardAmount: 100, globalDailyCap: 250 });
    const r = await executor.executeRule(rule as any);
    expect(r.granted).toBe(2);
    expect(r.totalAmount).toBe(200);
    expect(r.totalAmount).toBeLessThanOrEqual(250);
    expect(r.skippedCap).toBe(2);
  });

  it('executeRule: skips users who hit perUserLimit today', async () => {
    prisma.grantRedemption.findMany.mockResolvedValue([
      { userId: 'u1' }, // u1 already redeemed once today
    ]);
    const rule = baseRule(); // perUserLimit=1
    const r = await executor.executeRule(rule as any);
    expect(r.attemptedUsers).toBe(3);
    expect(r.granted).toBe(2); // u2, u3
    expect(r.skippedPerUserLimit).toBe(1);
  });

  it('executeRule: rechecks perUserLimit inside transaction after concurrent insert', async () => {
    service.resolveTargetUserIds.mockResolvedValueOnce(['u1']);
    prisma.grantRedemption.findMany.mockResolvedValueOnce([]);
    redemptionRows.push({
      id: 'g-existing',
      ruleId: 'r1',
      userId: 'u1',
      amount: 100,
      createdAt: new Date(),
    });

    const rule = baseRule({ perUserLimit: 1 });
    const r = await executor.executeRule(rule as any);

    expect(r.granted).toBe(0);
    expect(r.skippedPerUserLimit).toBe(1);
    expect(redis.incrby).not.toHaveBeenCalled();
  });

  it('executeRule: rechecks globalDailyCap inside transaction after concurrent grants', async () => {
    service.resolveTargetUserIds.mockResolvedValueOnce(['u1', 'u2']);
    redemptionRows.push(
      {
        id: 'g-existing-1',
        ruleId: 'r1',
        userId: 'other-1',
        amount: 100,
        createdAt: new Date(),
      },
      {
        id: 'g-existing-2',
        ruleId: 'r1',
        userId: 'other-2',
        amount: 150,
        createdAt: new Date(),
      },
    );

    const rule = baseRule({ rewardAmount: 100, globalDailyCap: 300 });
    const r = await executor.executeRule(rule as any);

    expect(r.granted).toBe(0);
    expect(r.skippedCap).toBe(2);
    expect(redis.incrby).not.toHaveBeenCalled();
  });

  it('executeRule: respects startAt window (not yet active)', async () => {
    const future = new Date(Date.now() + 7 * 86400_000);
    const rule = baseRule({ startAt: future });
    const r = await executor.executeRule(rule as any);
    expect(r.granted).toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('executeRule: respects endAt window (already passed)', async () => {
    const past = new Date(Date.now() - 86400_000);
    const rule = baseRule({ endAt: past });
    const r = await executor.executeRule(rule as any);
    expect(r.granted).toBe(0);
  });

  it('executeRule: inactive rule produces zero', async () => {
    const rule = baseRule({ isActive: false });
    const r = await executor.executeRule(rule as any);
    expect(r.granted).toBe(0);
  });

  it('executeRule: failed grants are counted', async () => {
    prisma.$transaction.mockRejectedValueOnce(new Error('PG down'));
    const rule = baseRule();
    const r = await executor.executeRule(rule as any);
    expect(r.failed).toBe(1);
    expect(r.granted).toBe(2);
  });

  it('executeAllByTrigger: iterates active rules', async () => {
    prisma.creditGrantRule.findMany.mockResolvedValue([
      baseRule({ id: 'r1' }),
      baseRule({ id: 'r2' }),
    ]);
    const results = await executor.executeAllByTrigger('DAILY_CRON');
    expect(results).toHaveLength(2);
    expect(results[0].granted).toBe(3);
  });

  it('executeRule: empty user pool short-circuits without writes', async () => {
    service.resolveTargetUserIds.mockResolvedValueOnce([]);
    const rule = baseRule();
    const r = await executor.executeRule(rule as any);
    expect(r.granted).toBe(0);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.creditGrantRule.update).toHaveBeenCalled(); // still mark triggered
  });

  // ============================================================
  // PR0-1: GRANT 池 Redis 集成
  // ============================================================

  it('grantToUser: incrby grant pool by rewardAmount per user (CREDIT)', async () => {
    const rule = baseRule({ rewardAmount: 100 });
    await executor.executeRule(rule as any);
    expect(redis.incrby).toHaveBeenCalledTimes(3);
    expect(redis.incrby).toHaveBeenCalledWith('credit:user:u1:grant', 100);
    expect(redis.incrby).toHaveBeenCalledWith('credit:user:u2:grant', 100);
    expect(redis.incrby).toHaveBeenCalledWith('credit:user:u3:grant', 100);
  });

  it('executeRule: rewardType=BALANCE fails closed before any financial write', async () => {
    const rule = baseRule({
      rewardType: 'BALANCE',
      productId: 'prod-1',
      rewardAmount: 1000,
    });
    const r = await executor.executeRule(rule as any);
    expect(r.granted).toBe(0);
    expect(r.failed).toBe(3);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(redis.incrby).not.toHaveBeenCalled();
  });

  it('grantToUserDirect: rewardType=BALANCE fails closed without opening an account', async () => {
    const rule = baseRule({
      rewardType: 'BALANCE',
      productId: 'prod-1',
      rewardAmount: 500,
    });
    await expect(executor.grantToUserDirect(rule as any, 'u1'))
      .rejects.toThrow('BALANCE reward rule r1 is deferred');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('executeRule: rewardType=BOOSTER_PACK fails fast instead of writing no-op redemptions', async () => {
    const rule = baseRule({ rewardType: 'BOOSTER_PACK', rewardAmount: 1 });
    const r = await executor.executeRule(rule as any);
    expect(r.granted).toBe(0);
    expect(r.failed).toBe(3);
    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(redis.incrby).not.toHaveBeenCalled();
  });

  it('grantToUser: Redis incrby failure does NOT roll back PG', async () => {
    redis.incrby.mockRejectedValue(new Error('Redis down'));
    const rule = baseRule();
    const r = await executor.executeRule(rule as any);
    // PG transaction still ran for all 3 users
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(r.granted).toBe(3);
  });

  it('grantToUser: zero/negative reward amount does not touch Redis', async () => {
    const rule = baseRule({ rewardAmount: 0 });
    await executor.executeRule(rule as any);
    expect(redis.incrby).not.toHaveBeenCalled();
  });
});
