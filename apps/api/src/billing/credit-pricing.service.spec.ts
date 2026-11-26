import { ForbiddenException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { CreditPricingService } from './credit-pricing.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ModelPricingService } from './model-pricing.service';
import { creditMultiplierCacheKey } from '../common/utils/redis-key.util';

// ============================================================
// Shared builder
// ============================================================

function makeRedis() {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  };
}

function makePrisma() {
  return {
    modelAccess: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    modelPricing: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
  };
}

function makeModelPricing() {
  const getPricing = jest.fn().mockResolvedValue(null);
  const modelPricing = {
    getPricing,
    calculateCostQuote: jest.fn(async (
      _modelName: string,
      inputTokens: number,
      outputTokens: number,
      cachedInputTokens = 0,
    ): Promise<{ costUsd: Prisma.Decimal; pricingTierKey: null }> => {
      const pricing: any = await getPricing();
      if (!pricing) {
        throw new NotFoundException('模型 "unknown-model" 暂未开放 API 定价');
      }
      const safeInputTokens = Math.max(0, inputTokens);
      const safeOutputTokens = Math.max(0, outputTokens);
      const safeCachedInputTokens = Math.min(Math.max(0, cachedInputTokens), safeInputTokens);
      const nonCachedInputTokens = safeInputTokens - safeCachedInputTokens;
      const inputPrice = new Prisma.Decimal(pricing.inputPricePerMToken);
      const outputPrice = new Prisma.Decimal(pricing.outputPricePerMToken);
      const cachedInputPrice = new Prisma.Decimal(
        pricing.cachedInputPrice ?? pricing.inputPricePerMToken,
      );
      const costUsd = new Prisma.Decimal(nonCachedInputTokens)
        .mul(inputPrice)
        .plus(new Prisma.Decimal(safeCachedInputTokens).mul(cachedInputPrice))
        .plus(new Prisma.Decimal(safeOutputTokens).mul(outputPrice))
        .div(1_000_000);
      return { costUsd, pricingTierKey: null };
    }),
  };
  return modelPricing;
}

async function buildService(prismaOverrides = {}, redisOverrides = {}, pricingOverrides = {}) {
  const prisma = { ...makePrisma(), ...prismaOverrides };
  const redis = { ...makeRedis(), ...redisOverrides };
  const modelPricing = { ...makeModelPricing(), ...pricingOverrides };

  const m = await Test.createTestingModule({
    providers: [
      CreditPricingService,
      { provide: PrismaService, useValue: prisma },
      { provide: RedisService, useValue: redis },
      { provide: ModelPricingService, useValue: modelPricing },
    ],
  }).compile();

  return {
    service: m.get(CreditPricingService) as CreditPricingService,
    prisma,
    redis,
    modelPricing,
  };
}

// ============================================================
// CreditPricingService.calculateCreditCost — correct formula with ModelPricing
// ============================================================

describe('CreditPricingService.calculateCreditCost — correct formula with ModelPricing', () => {
  it('reproduces production bug case: kimi-k2.5 20159/110 tokens × 5x plan → ~7 credits', async () => {
    const { service, redis, prisma, modelPricing } = await buildService();
    redis.get.mockResolvedValue(null);
    prisma.modelAccess.findUnique.mockResolvedValue({ creditMultiplier: 1.0 });
    modelPricing.getPricing.mockResolvedValue({
      inputPricePerMToken: 0.6,
      outputPricePerMToken: 3,
    });

    const cost = await service.calculateCreditCost(
      'plan-max', 'kimi-k2.5', 20159, 110, 5.0,
    );

    // ceil((20159 * 60 + 110 * 300) / 1_000_000 * 1.0 * 5) = ceil(6.2142) = 7
    expect(cost).toBe(7);
  });

  it('input/output 定价不对称时分别计算', async () => {
    const { service, redis, prisma, modelPricing } = await buildService();
    redis.get.mockResolvedValue(null);
    prisma.modelAccess.findUnique.mockResolvedValue({ creditMultiplier: 1.0 });
    modelPricing.getPricing.mockResolvedValue({
      inputPricePerMToken: 1,
      outputPricePerMToken: 10,
    });

    // in=1M (100 积分), out=1M (1000 积分), × 1.0 × 1.0 = 1100
    const cost = await service.calculateCreditCost(
      'plan-1', 'asymmetric-model', 1_000_000, 1_000_000, 1.0,
    );
    expect(cost).toBe(1100);
  });

  it('cached input tokens use cached price when configured', async () => {
    const { service, redis, prisma, modelPricing } = await buildService();
    redis.get.mockResolvedValue(null);
    prisma.modelAccess.findUnique.mockResolvedValue({ creditMultiplier: 1.0 });
    modelPricing.getPricing.mockResolvedValue({
      inputPricePerMToken: 1,
      outputPricePerMToken: 10,
      cachedInputPrice: 0.2,
    });

    // input=1M, cached=600K, output=100K:
    // non-cached input 400K*100/M=40, cached 600K*20/M=12, output 100K*1000/M=100.
    const cost = await service.calculateCreditCost(
      'plan-1', 'glm-5.1', 1_000_000, 100_000, 1.0, 600_000,
    );

    expect(cost).toBe(152);
  });

  it('cached input tokens fall back to input price when cached price is missing', async () => {
    const { service, redis, prisma, modelPricing } = await buildService();
    redis.get.mockResolvedValue(null);
    prisma.modelAccess.findUnique.mockResolvedValue({ creditMultiplier: 1.0 });
    modelPricing.getPricing.mockResolvedValue({
      inputPricePerMToken: 1,
      outputPricePerMToken: 10,
      cachedInputPrice: null,
    });

    const cost = await service.calculateCreditCost(
      'plan-1', 'glm-5.1', 1_000_000, 100_000, 1.0, 600_000,
    );

    expect(cost).toBe(200);
  });

  it('creditMultiplier × usageMultiplier 同时生效', async () => {
    const { service, redis, prisma, modelPricing } = await buildService();
    redis.get.mockResolvedValue(null);
    prisma.modelAccess.findUnique.mockResolvedValue({ creditMultiplier: 2.0 });
    modelPricing.getPricing.mockResolvedValue({
      inputPricePerMToken: 10,
      outputPricePerMToken: 30,
    });

    // in=1000 → 1 积分, out=1000 → 3 积分, 合 4, × creditMultiplier=2 × usage=1.5 = 12
    const cost = await service.calculateCreditCost(
      'plan-pro', 'gpt-x', 1000, 1000, 1.5,
    );
    expect(cost).toBe(12);
  });

  it('calculates Decimal pricing snapshots without floating point drift', async () => {
    const { service, redis, prisma, modelPricing } = await buildService();
    redis.get.mockResolvedValue(null);
    prisma.modelAccess.findUnique.mockResolvedValue({ creditMultiplier: 1.0 });
    modelPricing.getPricing.mockResolvedValue({
      inputPricePerMToken: new Prisma.Decimal('0.1'),
      outputPricePerMToken: new Prisma.Decimal('0.2'),
      cachedInputPrice: new Prisma.Decimal('0.03'),
    });

    const cost = await service.calculateCreditCost(
      'plan-1',
      'decimal-model',
      1_000_000,
      1_000_000,
      1.0,
      500_000,
    );

    // non-cached input=500K*0.1, cached input=500K*0.03, output=1M*0.2, then ×100 credits/USD.
    expect(cost).toBe(27);
  });

  it('hashes plan/model Redis cache keys', async () => {
    const { service, redis, prisma, modelPricing } = await buildService();
    redis.get.mockResolvedValue(null);
    prisma.modelAccess.findUnique.mockResolvedValue({ creditMultiplier: 1.0 });
    modelPricing.getPricing.mockResolvedValue({
      inputPricePerMToken: 1,
      outputPricePerMToken: 1,
    });
    const planId = 'plan\r\nx';
    const modelName = 'model/with:delimiters\r\ny';

    await service.calculateCreditCost(planId, modelName, 1000, 1000, 1.0);

    const cacheKey = creditMultiplierCacheKey(planId, modelName);
    expect(redis.get).toHaveBeenCalledWith(cacheKey);
    expect(redis.set).toHaveBeenCalledWith(cacheKey, '1', 'EX', 3600);
    expect(cacheKey).not.toContain('\r');
    expect(cacheKey).not.toContain('\n');
    expect(cacheKey).not.toContain(modelName);
  });

  it('ModelPricing 查不到时抛 MODEL_PRICING_NOT_FOUND（禁止静默 fallback）', async () => {
    const { service, redis, prisma, modelPricing } = await buildService();
    redis.get.mockResolvedValue(null);
    prisma.modelAccess.findUnique.mockResolvedValue({ creditMultiplier: 1.0 });
    modelPricing.getPricing.mockResolvedValue(null);

    await expect(
      service.calculateCreditCost('plan-1', 'unknown-model', 100, 100, 1.0),
    ).rejects.toThrow(/MODEL_PRICING_NOT_FOUND|暂未开放/);
    await expect(
      service.calculateCreditCost('plan-1', 'unknown-model', 100, 100, 1.0),
    ).rejects.toBeInstanceOf(NotFoundException);
  });

  it('零 tokens 返回 0', async () => {
    const { service, redis, prisma, modelPricing } = await buildService();
    redis.get.mockResolvedValue(null);
    prisma.modelAccess.findUnique.mockResolvedValue({ creditMultiplier: 1.0 });
    modelPricing.getPricing.mockResolvedValue({
      inputPricePerMToken: 0.6,
      outputPricePerMToken: 3,
    });

    const cost = await service.calculateCreditCost('plan-1', 'm', 0, 0, 5.0);
    expect(cost).toBe(0);
    // 允许实现在 0 tokens 时短路，不强制调用 modelPricing；只要结果为 0 即可。
    // Task 3 若选择走完整路径，pricing.getPricing 会被调用一次；若短路则跳过。
  });

  it('converts configured per-image USD cost into credits without fabricating tokens', async () => {
    const calculateCostQuote = jest.fn().mockResolvedValue({
      costUsd: new Prisma.Decimal('0.12'),
      pricingTierKey: null,
      inputPriceUsdPerM: new Prisma.Decimal(0),
      cachedInputPriceUsdPerM: null,
      cacheWritePriceUsdPerM: null,
      outputPriceUsdPerM: new Prisma.Decimal(0),
      lineItems: [{
        meter: 'image',
        quantity: 2,
        unitPriceUsd: new Prisma.Decimal('0.06'),
        amountUsd: new Prisma.Decimal('0.12'),
      }],
    });
    const { service, prisma } = await buildService(
      {},
      {},
      { calculateCostQuote },
    );
    prisma.modelAccess.findUnique.mockResolvedValue({ creditMultiplier: 1.5 });

    const cost = await service.calculateCreditCost(
      'plan-image',
      'cogview-4',
      0,
      0,
      2,
      0,
      { imageCount: 2 },
    );

    // $0.12 × 100 credits/USD × 1.5 model multiplier × 2 plan usage multiplier.
    expect(cost).toBe(36);
    expect(calculateCostQuote).toHaveBeenCalledWith(
      'cogview-4',
      0,
      0,
      0,
      0,
      { imageCount: 2 },
    );
  });

  it('小数结果向上取整', async () => {
    const { service, redis, prisma, modelPricing } = await buildService();
    redis.get.mockResolvedValue(null);
    prisma.modelAccess.findUnique.mockResolvedValue({ creditMultiplier: 1.0 });
    modelPricing.getPricing.mockResolvedValue({
      inputPricePerMToken: 0.01,
      outputPricePerMToken: 0.01,
    });

    // in=100 → 0.0001 积分, out=100 → 0.0001 积分, 合 0.0002, × 1 × 1 = 0.0002, ceil=1
    const cost = await service.calculateCreditCost('plan-1', 'm', 100, 100, 1.0);
    expect(cost).toBe(1);
  });

  it('requireModelAccess=true: rejects missing plan model access', async () => {
    const { service, redis, prisma, modelPricing } = await buildService();
    redis.get.mockResolvedValue('0.1');
    prisma.modelAccess.findUnique.mockResolvedValue(null);
    modelPricing.getPricing.mockResolvedValue({
      inputPricePerMToken: 1,
      outputPricePerMToken: 1,
    });

    await expect(
      service.calculateCreditCost('plan-1', 'not-enabled', 100, 100, 1.0, 0, {
        requireModelAccess: true,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
    expect(prisma.modelAccess.findUnique).toHaveBeenCalled();
  });

  it('requireModelAccess=true: rejects inactive plan model access', async () => {
    const { service, redis, prisma, modelPricing } = await buildService();
    redis.get.mockResolvedValue(null);
    prisma.modelAccess.findUnique.mockResolvedValue({
      creditMultiplier: 0.5,
      isActive: false,
    });
    modelPricing.getPricing.mockResolvedValue({
      inputPricePerMToken: 1,
      outputPricePerMToken: 1,
    });

    await expect(
      service.calculateCreditCost('plan-1', 'disabled-model', 100, 100, 1.0, 0, {
        requireModelAccess: true,
      }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  });

  it('requireModelAccess=true: uses active ModelAccess multiplier', async () => {
    const { service, redis, prisma, modelPricing } = await buildService();
    redis.get.mockResolvedValue(null);
    prisma.modelAccess.findUnique.mockResolvedValue({
      creditMultiplier: 2,
      isActive: true,
    });
    modelPricing.getPricing.mockResolvedValue({
      inputPricePerMToken: 10,
      outputPricePerMToken: 30,
    });

    const cost = await service.calculateCreditCost('plan-1', 'enabled-model', 1000, 1000, 1.5, 0, {
      requireModelAccess: true,
    });

    expect(cost).toBe(12);
  });
});
