import { RollingQuotaGateService } from './rolling-quota-gate.service';

function make() {
  const prisma = {
    plan: { findUnique: jest.fn() },
    creditTransaction: { aggregate: jest.fn(), count: jest.fn() },
  };
  const redis = {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
  };
  const service = new RollingQuotaGateService(prisma as never, redis as never);
  return { service, prisma, redis };
}

const CREDITS_RULE = {
  metric: 'CREDITS',
  windowType: 'ROLLING',
  durationSec: 18000,
  durationLabel: '5h',
  limitValue: 60,
  enforced: true,
};
const REQUESTS_RULE = {
  metric: 'REQUESTS',
  windowType: 'ROLLING',
  durationSec: 18000,
  durationLabel: '5h',
  limitValue: 300,
  enforced: true,
};

describe('RollingQuotaGateService', () => {
  describe('evaluateExhaustion', () => {
    it('returns not exhausted when the plan has no enforced rules', async () => {
      const { service, redis, prisma } = make();
      redis.get.mockResolvedValue(JSON.stringify([]));

      const result = await service.evaluateExhaustion('sub-1', 'plan-1');

      expect(result.exhausted).toBe(false);
      expect(prisma.creditTransaction.aggregate).not.toHaveBeenCalled();
      expect(prisma.creditTransaction.count).not.toHaveBeenCalled();
    });

    it('flags exhausted when CREDITS consumption meets the limit', async () => {
      const { service, redis, prisma } = make();
      redis.get.mockResolvedValue(JSON.stringify([CREDITS_RULE]));
      // 消耗记录为负值，windowUsage 取绝对值；60 >= 60 → 耗尽
      prisma.creditTransaction.aggregate.mockResolvedValue({ _sum: { creditsAmount: -60 } });

      const result = await service.evaluateExhaustion('sub-1', 'plan-1');

      expect(result.exhausted).toBe(true);
    });

    it('returns not exhausted when REQUESTS count is below the limit', async () => {
      const { service, redis, prisma } = make();
      redis.get.mockResolvedValue(JSON.stringify([REQUESTS_RULE]));
      prisma.creditTransaction.count.mockResolvedValue(100);

      const result = await service.evaluateExhaustion('sub-1', 'plan-1');

      expect(result.exhausted).toBe(false);
      expect(prisma.creditTransaction.count).toHaveBeenCalled();
    });

    it('short-circuits when subscriptionId or planId is missing', async () => {
      const { service, redis } = make();
      const result = await service.evaluateExhaustion('', 'plan-1');
      expect(result.exhausted).toBe(false);
      expect(redis.get).not.toHaveBeenCalled();
    });
  });

  describe('loadEnforcedRollingRules', () => {
    it('returns cached rules without hitting the database', async () => {
      const { service, redis, prisma } = make();
      redis.get.mockResolvedValue(JSON.stringify([CREDITS_RULE]));

      const rules = await service.loadEnforcedRollingRules('plan-1');

      expect(rules).toHaveLength(1);
      expect(prisma.plan.findUnique).not.toHaveBeenCalled();
    });

    it('loads from DB, keeps only enforced rules, and caches the result', async () => {
      const { service, redis, prisma } = make();
      redis.get.mockResolvedValue(null);
      prisma.plan.findUnique.mockResolvedValue({
        quotaRules: [
          {
            template: {
              isActive: true,
              deletedAt: null,
              rules: JSON.stringify([
                { metric: 'CREDITS', windowType: 'ROLLING', durationSec: 18000, limitValue: 60 },
                // token 维度 → 视图剔除，不计入 enforced
                { metric: 'TOTAL_TOKENS', windowType: 'ROLLING', durationSec: 18000, limitValue: 1000 },
              ]),
            },
          },
        ],
      });

      const rules = await service.loadEnforcedRollingRules('plan-1');

      expect(rules).toHaveLength(1);
      expect(rules[0].metric).toBe('CREDITS');
      expect(rules[0].enforced).toBe(true);
      expect(redis.set).toHaveBeenCalledWith('cpq:rules:plan-1', expect.any(String), 'EX', 300);
    });
  });
});
