/**
 * FunnelService 单元测试。
 *
 * 关注点:
 *   - 三种漏斗(Overall / Subscription / PayG)4 步聚合数正确,严格不增
 *   - segmentId 处理:STATIC -> 过滤;DYNAMIC -> 空;不存在 -> 空
 *   - 缓存命中路径(prisma 不被调)
 *   - 缓存损坏 JSON / Redis get throw -> fall through 重算
 *   - days 异常值 -> fallback 30
 */
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { FunnelService } from './funnel.service';

describe('FunnelService', () => {
  let service: FunnelService;
  let prisma: any;
  let redis: any;

  beforeEach(async () => {
    prisma = {
      user: {
        findMany: jest.fn(),
      },
      userSegment: {
        findFirst: jest.fn(),
      },
      userSegmentMember: {
        findMany: jest.fn(),
      },
      subscriptionPeriod: {
        findMany: jest.fn(),
      },
      order: {
        findMany: jest.fn(),
        groupBy: jest.fn(),
      },
      balanceTransaction: {
        findMany: jest.fn(),
      },
      $queryRaw: jest.fn(),
    };
    redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    };

    const m = await Test.createTestingModule({
      providers: [
        FunnelService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();
    service = m.get(FunnelService);
  });

  // ============================ Overall ============================

  describe('getOverallFunnel', () => {
    it('aggregates 4 steps with no segment, strictly non-increasing', async () => {
      // step1: 5 registered, 4 with billing-domain activity
      prisma.user.findMany.mockResolvedValueOnce([
        { id: 'u1' },
        { id: 'u2' },
        { id: 'u3' },
        { id: 'u4' },
        { id: 'u5' },
      ]);
      prisma.$queryRaw.mockResolvedValueOnce([
        { user_id: 'u1' },
        { user_id: 'u2' },
        { user_id: 'u3' },
        { user_id: 'u4' },
      ]);
      // step3: 3 paid (u1, u2, u3)
      prisma.order.findMany.mockResolvedValueOnce([
        { userId: 'u1' },
        { userId: 'u2' },
        { userId: 'u3' },
      ]);
      // step4: 2 retained (u1, u2)
      prisma.order.groupBy.mockResolvedValueOnce([
        { userId: 'u1', _count: { _all: 3 } },
        { userId: 'u2', _count: { _all: 2 } },
      ]);

      const out = await service.getOverallFunnel({ days: 30 });

      expect(out.steps.map((s) => s.value)).toEqual([5, 4, 3, 2]);
      expect(out.steps.map((s) => s.key)).toEqual([
        'register',
        'activated',
        'paid',
        'retained',
      ]);
      // strictly non-increasing
      const vals = out.steps.map((s) => s.value);
      for (let i = 1; i < vals.length; i++) {
        expect(vals[i]).toBeLessThanOrEqual(vals[i - 1]);
      }

      // step3 only queries activated userIds (u1..u4)
      const orderCall = prisma.order.findMany.mock.calls[0][0];
      expect(orderCall.where.userId.in).toEqual(['u1', 'u2', 'u3', 'u4']);
      expect(orderCall.where.status).toBe('COMPLETED');
      expect(orderCall.where.amountCents).toEqual({ gt: 0 });
      // step4 having count >= 2
      const groupCall = prisma.order.groupBy.mock.calls[0][0];
      expect(groupCall.having.userId._count).toEqual({ gte: 2 });
    });

    it('STATIC segment: filters to member userIds', async () => {
      prisma.userSegment.findFirst.mockResolvedValueOnce({
        id: 'seg1',
        ruleType: 'STATIC',
      });
      prisma.userSegmentMember.findMany.mockResolvedValueOnce([
        { userId: 'u1' },
        { userId: 'u2' },
      ]);
      prisma.user.findMany.mockResolvedValueOnce([
        { id: 'u1' },
        { id: 'u2' },
      ]);
      prisma.$queryRaw.mockResolvedValueOnce([{ user_id: 'u1' }]);
      prisma.order.findMany.mockResolvedValueOnce([]);
      prisma.order.groupBy.mockResolvedValueOnce([]);

      const out = await service.getOverallFunnel({ days: 30, segmentId: 'seg1' });

      expect(out.steps[0].value).toBe(2);
      expect(out.steps[1].value).toBe(1);
      expect(out.steps[2].value).toBe(0);
      expect(out.steps[3].value).toBe(0);

      // user.findMany was called with id IN [u1, u2]
      const userCall = prisma.user.findMany.mock.calls[0][0];
      expect(userCall.where.id.in.sort()).toEqual(['u1', 'u2']);
    });

    it('DYNAMIC segment returns empty funnel (4 zeroes)', async () => {
      prisma.userSegment.findFirst.mockResolvedValueOnce({
        id: 'seg2',
        ruleType: 'DYNAMIC',
      });

      const out = await service.getOverallFunnel({ days: 30, segmentId: 'seg2' });

      expect(out.steps).toHaveLength(4);
      expect(out.steps.every((s) => s.value === 0)).toBe(true);
      // user.findMany should NOT have been called
      expect(prisma.user.findMany).not.toHaveBeenCalled();
      expect(prisma.userSegmentMember.findMany).not.toHaveBeenCalled();
    });

    it('missing segment returns empty funnel (4 zeroes)', async () => {
      prisma.userSegment.findFirst.mockResolvedValueOnce(null);

      const out = await service.getOverallFunnel({ days: 30, segmentId: 'nope' });

      expect(out.steps).toHaveLength(4);
      expect(out.steps.every((s) => s.value === 0)).toBe(true);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });

    it('STATIC segment with zero members returns empty funnel without querying user', async () => {
      prisma.userSegment.findFirst.mockResolvedValueOnce({
        id: 'seg3',
        ruleType: 'STATIC',
      });
      prisma.userSegmentMember.findMany.mockResolvedValueOnce([]);

      const out = await service.getOverallFunnel({ days: 30, segmentId: 'seg3' });
      expect(out.steps.every((s) => s.value === 0)).toBe(true);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
    });
  });

  // ============================ Subscription ============================

  describe('getSubscriptionFunnel', () => {
    it('aggregates 4 subscription steps', async () => {
      prisma.user.findMany.mockResolvedValueOnce([
        { id: 'u1' },
        { id: 'u2' },
        { id: 'u3' },
      ]);
      // 2 subscribed
      prisma.subscriptionPeriod.findMany.mockResolvedValueOnce([
        { userId: 'u1' },
        { userId: 'u2' },
      ]);
      // 2 paid_subscription (also u1, u2)
      prisma.order.findMany.mockResolvedValueOnce([
        { userId: 'u1' },
        { userId: 'u2' },
      ]);
      // 1 renewed
      prisma.order.groupBy.mockResolvedValueOnce([
        { userId: 'u1', _count: { _all: 2 } },
      ]);

      const out = await service.getSubscriptionFunnel({ days: 30 });

      expect(out.steps.map((s) => s.value)).toEqual([3, 2, 2, 1]);
      expect(out.steps.map((s) => s.key)).toEqual([
        'register',
        'subscribed',
        'paid_subscription',
        'renewed',
      ]);

      // step3 filters orderType=SUBSCRIPTION + status=COMPLETED + amountCents>0
      const orderCall = prisma.order.findMany.mock.calls[0][0];
      expect(orderCall.where.orderType).toBe('SUBSCRIPTION');
      expect(orderCall.where.status).toBe('COMPLETED');
      expect(orderCall.where.amountCents).toEqual({ gt: 0 });
      // step4 same + amountCents>0
      const groupCall = prisma.order.groupBy.mock.calls[0][0];
      expect(groupCall.where.orderType).toBe('SUBSCRIPTION');
      expect(groupCall.where.amountCents).toEqual({ gt: 0 });
      expect(groupCall.having.userId._count).toEqual({ gte: 2 });
    });
  });

  // ============================ PayG ============================

  describe('getPaygFunnel', () => {
    it('aggregates 4 payg steps', async () => {
      prisma.user.findMany.mockResolvedValueOnce([
        { id: 'u1' },
        { id: 'u2' },
        { id: 'u3' },
        { id: 'u4' },
      ]);
      // 3 first_recharge
      prisma.order.findMany.mockResolvedValueOnce([
        { userId: 'u1' },
        { userId: 'u2' },
        { userId: 'u3' },
      ]);
      // 2 consumed
      prisma.balanceTransaction.findMany.mockResolvedValueOnce([
        { userId: 'u1' },
        { userId: 'u2' },
      ]);
      // 1 repurchased
      prisma.order.groupBy.mockResolvedValueOnce([
        { userId: 'u1', _count: { _all: 3 } },
      ]);

      const out = await service.getPaygFunnel({ days: 30 });

      expect(out.steps.map((s) => s.value)).toEqual([4, 3, 2, 1]);
      expect(out.steps.map((s) => s.key)).toEqual([
        'register',
        'first_recharge',
        'consumed',
        'repurchased',
      ]);

      // step2: orderType=RECHARGE + status=COMPLETED + amountCents>0
      const orderCall = prisma.order.findMany.mock.calls[0][0];
      expect(orderCall.where.orderType).toBe('RECHARGE');
      expect(orderCall.where.amountCents).toEqual({ gt: 0 });
      // step3: BalanceTransaction CONSUME
      const btCall = prisma.balanceTransaction.findMany.mock.calls[0][0];
      expect(btCall.where.type).toBe('CONSUME');
      // step4: groupBy RECHARGE having >= 2 + amountCents>0
      const groupCall = prisma.order.groupBy.mock.calls[0][0];
      expect(groupCall.where.orderType).toBe('RECHARGE');
      expect(groupCall.where.amountCents).toEqual({ gt: 0 });
      expect(groupCall.having.userId._count).toEqual({ gte: 2 });
    });
  });

  // ============================ cache ============================

  describe('cache', () => {
    it('cache hit: prisma not called, returns cached funnel', async () => {
      const cached = {
        steps: [
          { key: 'register', label: '注册', value: 100 },
          { key: 'activated', label: '激活', value: 80 },
          { key: 'paid', label: '付费', value: 50 },
          { key: 'retained', label: '续订', value: 20 },
        ],
      };
      redis.get.mockResolvedValueOnce(JSON.stringify(cached));

      const out = await service.getOverallFunnel({ days: 30 });

      expect(out).toEqual(cached);
      expect(prisma.user.findMany).not.toHaveBeenCalled();
      expect(prisma.order.findMany).not.toHaveBeenCalled();
      expect(prisma.order.groupBy).not.toHaveBeenCalled();
    });

    it('corrupt cache JSON: falls through, recomputes from DB', async () => {
      redis.get.mockResolvedValueOnce('{not valid json');
      // computeOverall path
      prisma.user.findMany.mockResolvedValueOnce([]);

      const out = await service.getOverallFunnel({ days: 30 });

      expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
      expect(out.steps.every((s) => s.value === 0)).toBe(true);
    });

    it('redis get throw: falls through to DB without throwing', async () => {
      redis.get.mockRejectedValueOnce(new Error('redis down'));
      prisma.user.findMany.mockResolvedValueOnce([]);

      const out = await service.getOverallFunnel({ days: 30 });

      expect(prisma.user.findMany).toHaveBeenCalledTimes(1);
      expect(out.steps).toHaveLength(4);
    });

    it('redis set throw: does not crash response', async () => {
      redis.get.mockResolvedValueOnce(null);
      redis.set.mockRejectedValueOnce(new Error('redis down'));
      prisma.user.findMany.mockResolvedValueOnce([]);

      const out = await service.getOverallFunnel({ days: 30 });
      expect(out.steps).toHaveLength(4);
    });

    it('uses correct cache key for each funnel type', async () => {
      redis.get.mockResolvedValue(null);
      prisma.user.findMany.mockResolvedValue([]);

      await service.getOverallFunnel({ days: 7 });
      await service.getOverallFunnel({ days: 30, segmentId: 'sX' });
      // segmentId branch needs UserSegment lookup
      prisma.userSegment.findFirst.mockResolvedValueOnce(null);

      await service.getSubscriptionFunnel({ days: 90 });
      await service.getPaygFunnel({ days: 7 });

      const keys = redis.get.mock.calls.map((c: any[]) => c[0]);
      expect(keys).toContain('funnel:overall:7:all');
      expect(keys).toContain('funnel:overall:30:sX');
      expect(keys).toContain('funnel:sub:90');
      expect(keys).toContain('funnel:payg:7');
    });
  });

  // ============================ days normalization ============================

  describe('days normalization', () => {
    it.each([
      [0, 30],
      [1000, 30],
      ['foo' as any, 30],
      [undefined as any, 30],
      [7, 7],
      [30, 30],
      [90, 90],
      [15, 30],
    ])('days=%p -> normalized %p', async (input, expected) => {
      redis.get.mockResolvedValueOnce(null);
      prisma.user.findMany.mockResolvedValueOnce([]);

      await service.getOverallFunnel({ days: input as number });

      // cache key should reflect normalized days
      const cacheKey = redis.get.mock.calls[0][0] as string;
      expect(cacheKey).toBe(`funnel:overall:${expected}:all`);
    });
  });
});
