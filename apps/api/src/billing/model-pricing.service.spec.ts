/**
 * ModelPricingService unit tests
 * Target coverage: ≥ 90%
 * Covers: getPricing (cache hit / miss / null), calculateCost, listActive
 */

import { Test } from '@nestjs/testing';
import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { ModelPricingService } from './model-pricing.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import {
  modelPricingCacheKey,
  publicModelPricingCacheKey,
} from '../common/utils/redis-key.util';

describe('ModelPricingService', () => {
  let service: ModelPricingService;
  let prisma: jest.Mocked<Pick<PrismaService, 'modelPricing' | 'modelPricingTier' | 'paygModelPricingPolicy'>>;
  let redis: jest.Mocked<Pick<RedisService, 'get' | 'set'>>;

  beforeEach(async () => {
    prisma = {
      modelPricing: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
      } as any,
      modelPricingTier: {
        findMany: jest.fn().mockResolvedValue([]),
      } as any,
      paygModelPricingPolicy: {
        findFirst: jest.fn(),
      } as any,
    } as any;

    redis = {
      get: jest.fn(),
      set: jest.fn().mockResolvedValue('OK'),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        ModelPricingService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();

    service = moduleRef.get(ModelPricingService);
  });

  // ─── getPricing ───────────────────────────────────────────────────────────

  describe('getPricing', () => {
    it('returns cached result when Redis has data', async () => {
      const cached = JSON.stringify({
        inputPricePerMToken: 5,
        outputPricePerMToken: 15,
        cachedInputPrice: 2,
      });
      redis.get.mockResolvedValue(cached);

      const result = await service.getPricing('gpt-4o');

      expect(result).toEqual({ inputPricePerMToken: 5, outputPricePerMToken: 15, cachedInputPrice: 2 });
      expect((prisma.modelPricing as any).findFirst).not.toHaveBeenCalled();
    });

    it('queries DB on cache miss and caches result', async () => {
      redis.get.mockResolvedValue(null);
      (prisma.modelPricing as any).findFirst.mockResolvedValue({
        modelName: 'gpt-4o',
        inputPricePerMToken: 10,
        outputPricePerMToken: 30,
        cachedInputPrice: 4,
        isActive: true,
      });

      const result = await service.getPricing('gpt-4o');

      expect(result).toEqual({
        inputPricePerMToken: '10',
        outputPricePerMToken: '30',
        cachedInputPrice: '4',
        cacheWrite5minPrice: null,
        cacheWrite1hPrice: null,
      });
      expect(redis.set).toHaveBeenCalledWith(
        modelPricingCacheKey('gpt-4o'),
        JSON.stringify({
          inputPricePerMToken: '10',
          outputPricePerMToken: '30',
          cachedInputPrice: '4',
          cacheWrite5minPrice: null,
          cacheWrite1hPrice: null,
        }),
        'EX',
        3600,
        'NX',
      );
      expect((prisma.modelPricing as any).findFirst).toHaveBeenCalledWith({
        where: { modelName: 'gpt-4o', isActive: true },
      });
    });

    it('keeps configured image pricing facts in the cached snapshot', async () => {
      redis.get.mockResolvedValue(null);
      (prisma.modelPricing as any).findFirst.mockResolvedValue({
        id: 'pricing-cogview-4',
        modelName: 'cogview-4',
        inputPricePerMToken: new Prisma.Decimal(0),
        outputPricePerMToken: new Prisma.Decimal(0),
        cachedInputPrice: null,
        pricingUnit: 'image',
        unitPriceUsd: new Prisma.Decimal('0.06'),
        isActive: true,
      });

      const result = await service.getPricing('cogview-4');

      expect(result).toMatchObject({
        pricingUnit: 'image',
        unitPriceUsd: '0.06',
      });
      expect(redis.set).toHaveBeenCalledWith(
        modelPricingCacheKey('cogview-4'),
        expect.stringContaining('"pricingUnit":"image"'),
        'EX',
        3600,
        'NX',
      );
    });

    it('returns null when model not found in DB', async () => {
      redis.get.mockResolvedValue(null);
      (prisma.modelPricing as any).findFirst.mockResolvedValue(null);

      const result = await service.getPricing('unknown-model');

      expect(result).toBeNull();
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('uses correct cache key per model name', async () => {
      redis.get.mockResolvedValue(null);
      (prisma.modelPricing as any).findFirst.mockResolvedValue({
        modelName: 'claude-3-opus',
        inputPricePerMToken: 15,
        outputPricePerMToken: 75,
        cachedInputPrice: null,
        isActive: true,
      });

      await service.getPricing('claude-3-opus');

      expect(redis.get).toHaveBeenCalledWith(modelPricingCacheKey('claude-3-opus'));
    });

    it('hashes external model names in Redis cache keys', async () => {
      const modelName = 'custom/model\r\nwith-control';
      redis.get.mockResolvedValue(null);
      (prisma.modelPricing as any).findFirst.mockResolvedValue({
        modelName,
        inputPricePerMToken: 15,
        outputPricePerMToken: 75,
        cachedInputPrice: null,
        isActive: true,
      });

      await service.getPricing(modelName);

      const cacheKey = modelPricingCacheKey(modelName);
      expect(redis.get).toHaveBeenCalledWith(cacheKey);
      expect(redis.set.mock.calls[0]?.[0]).toBe(cacheKey);
      expect(cacheKey).not.toContain(modelName);
      expect(cacheKey).not.toContain('\r');
      expect(cacheKey).not.toContain('\n');
    });

    it('requires published pricing for API users', async () => {
      redis.get.mockResolvedValue(null);
      (prisma.modelPricing as any).findFirst.mockResolvedValue({
        modelName: 'gpt-4o',
        inputPricePerMToken: 10,
        outputPricePerMToken: 30,
        cachedInputPrice: null,
        isActive: true,
        isPublished: true,
      });

      await service.getPublicPricing('gpt-4o');

      expect(redis.get).toHaveBeenCalledWith(publicModelPricingCacheKey('gpt-4o'));
      expect((prisma.modelPricing as any).findFirst).toHaveBeenCalledWith({
        where: { modelName: 'gpt-4o', isActive: true, isPublished: true },
      });
    });
  });

  // ─── 结算取价窗口（2026-09-07 国内 prod 事故）─────────────────────────────
  //
  // 不变量：
  //   1. 传了事件时刻就按 [startsAt, endsAt) 取"当时的价"，且**不看 isActive** ——
  //      isActive 是数据面开关，拿它筛历史价就会让模型一下架、所有还没结算的历史事件
  //      立刻报不出价（9,622 笔被推进 settlement_anchor_missing 并封掉客户 Key 的根因）。
  //   2. 历史取价必须绕过 Redis：键是 sha256(modelName)、不可反解，把某一时刻的价写进去
  //      会污染"当前价"且无法按模型清理。
  //   3. 事件时刻落在窗口外仍然取不到价（退役模型不会因为不看 isActive 而变成永久有效）。

  describe('getPricing 的结算取价窗口', () => {
    const occurredAt = new Date('2026-09-07T05:31:24.000Z');

    it('传入事件时刻时按时间窗取价，且不要求 isActive', async () => {
      (prisma.modelPricing as any).findFirst.mockResolvedValue({
        id: 'pricing-retired',
        modelName: 'deepseek-v4-flash',
        inputPricePerMToken: 3,
        outputPricePerMToken: 9,
        cachedInputPrice: null,
        // 下架动作已把它置为 false 并封了窗口；历史事件仍须能重放
        isActive: false,
        startsAt: new Date('2026-07-06T03:31:17.000Z'),
        endsAt: new Date('2026-09-07T05:31:52.000Z'),
      });

      const result = await service.getPricing('deepseek-v4-flash', undefined, occurredAt);

      expect(result).toEqual({
        inputPricePerMToken: '3',
        outputPricePerMToken: '9',
        cachedInputPrice: null,
        cacheWrite5minPrice: null,
        cacheWrite1hPrice: null,
      });
      expect((prisma.modelPricing as any).findFirst).toHaveBeenCalledWith({
        where: {
          modelName: 'deepseek-v4-flash',
          startsAt: { lte: occurredAt },
          OR: [{ endsAt: null }, { endsAt: { gt: occurredAt } }],
        },
      });
    });

    it('历史取价既不读也不写 Redis', async () => {
      (prisma.modelPricing as any).findFirst.mockResolvedValue({
        id: 'pricing-retired',
        modelName: 'deepseek-v4-flash',
        inputPricePerMToken: 3,
        outputPricePerMToken: 9,
        isActive: false,
        startsAt: new Date('2026-07-06T03:31:17.000Z'),
        endsAt: new Date('2026-09-07T05:31:52.000Z'),
      });

      await service.getPricing('deepseek-v4-flash', undefined, occurredAt);

      expect(redis.get).not.toHaveBeenCalled();
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('事件时刻落在窗口之后取不到价', async () => {
      (prisma.modelPricing as any).findFirst.mockResolvedValue(null);

      const afterRetirement = new Date('2026-09-07T06:00:00.000Z');
      const result = await service.getPricing('deepseek-v4-flash', undefined, afterRetirement);

      expect(result).toBeNull();
      expect(redis.set).not.toHaveBeenCalled();
    });

    it('不传事件时刻时谓词与缓存行为保持原样', async () => {
      redis.get.mockResolvedValue(null);
      (prisma.modelPricing as any).findFirst.mockResolvedValue({
        modelName: 'gpt-4o',
        inputPricePerMToken: 10,
        outputPricePerMToken: 30,
        isActive: true,
      });

      await service.getPricing('gpt-4o');

      expect((prisma.modelPricing as any).findFirst).toHaveBeenCalledWith({
        where: { modelName: 'gpt-4o', isActive: true },
      });
      expect(redis.set).toHaveBeenCalled();
    });

    it('calculateCostQuote 把 options.effectiveAt 透传到基础价', async () => {
      (prisma.modelPricing as any).findFirst.mockResolvedValue({
        id: 'pricing-retired',
        modelName: 'deepseek-v4-flash',
        inputPricePerMToken: 3,
        outputPricePerMToken: 9,
        isActive: false,
        startsAt: new Date('2026-07-06T03:31:17.000Z'),
        endsAt: new Date('2026-09-07T05:31:52.000Z'),
      });

      const quote = await service.calculateCostQuote(
        'deepseek-v4-flash',
        1_000_000,
        0,
        0,
        0,
        { priceBasis: 'LIST', effectiveAt: occurredAt },
      );

      expect(quote.costUsd.toString()).toBe('3');
      expect((prisma.modelPricing as any).findFirst).toHaveBeenCalledWith({
        where: {
          modelName: 'deepseek-v4-flash',
          startsAt: { lte: occurredAt },
          OR: [{ endsAt: null }, { endsAt: { gt: occurredAt } }],
        },
      });
    });
  });

  // ─── calculateCost ────────────────────────────────────────────────────────

  describe('calculateCost', () => {
    it('quotes image pricing as quantity times configured unit price', async () => {
      redis.get.mockResolvedValue(JSON.stringify({
        inputPricePerMToken: 0,
        outputPricePerMToken: 0,
        pricingUnit: 'image',
        unitPriceUsd: '0.06',
      }));

      const quote = await service.calculateCostQuote(
        'cogview-4',
        0,
        0,
        0,
        0,
        { imageCount: 2 },
      );

      expect(quote.costUsd.toString()).toBe('0.12');
      expect(quote.cachedInputPriceUsdPerM).toBeNull();
      expect(quote.cacheWritePriceUsdPerM).toBeNull();
      expect(quote.lineItems).toEqual([
        {
          meter: 'image',
          quantity: 2,
          unitPriceUsd: new Prisma.Decimal('0.06'),
          amountUsd: new Prisma.Decimal('0.12'),
        },
      ]);
    });

    it('applies the PAYG generic multiplier only for PRODUCT_EFFECTIVE image quotes', async () => {
      redis.get.mockResolvedValue(JSON.stringify({
        inputPricePerMToken: 0,
        outputPricePerMToken: 0,
        pricingUnit: 'image',
        unitPriceUsd: '0.06',
      }));
      (prisma.paygModelPricingPolicy as any).findFirst.mockResolvedValue({
        priceMultiplier: new Prisma.Decimal('0.5'),
        inputPricePerMToken: null,
        cachedInputPrice: null,
        cacheWritePrice: null,
        outputPricePerMToken: null,
      });

      const productEffective = await service.calculateCostQuote(
        'cogview-4',
        0,
        0,
        0,
        0,
        { productId: 'prod-payg', priceBasis: 'PRODUCT_EFFECTIVE', imageCount: 1 },
      );
      const list = await service.calculateCostQuote(
        'cogview-4',
        0,
        0,
        0,
        0,
        { productId: 'prod-payg', priceBasis: 'LIST', imageCount: 1 },
      );

      expect(productEffective.lineItems?.[0]?.unitPriceUsd.toString()).toBe('0.03');
      expect(productEffective.costUsd.toString()).toBe('0.03');
      expect(list.lineItems?.[0]?.unitPriceUsd.toString()).toBe('0.06');
      expect(list.costUsd.toString()).toBe('0.06');
    });

    it('fails closed when image usage also carries tokens but pricing is token based', async () => {
      redis.get.mockResolvedValue(JSON.stringify({
        inputPricePerMToken: 10,
        outputPricePerMToken: 30,
        pricingUnit: 'token_1m',
        unitPriceUsd: '999',
      }));

      await expect(service.calculateCostQuote(
        'gpt-4o',
        1_000_000,
        500_000,
        0,
        0,
        { imageCount: 7 },
      )).rejects.toThrow(/pricingUnit=image/);
    });

    it('fails closed for image-only usage when the model is not configured per image', async () => {
      redis.get.mockResolvedValue(JSON.stringify({
        inputPricePerMToken: 10,
        outputPricePerMToken: 30,
        pricingUnit: 'token_1m',
        unitPriceUsd: null,
      }));

      await expect(service.calculateCostQuote(
        'cogview-4',
        0,
        0,
        0,
        0,
        { imageCount: 1 },
      )).rejects.toThrow(/pricingUnit=image/);
    });

    it('calculates cost correctly with known pricing', async () => {
      // 1M input tokens @ $10/M, 500K output @ $30/M => $25
      redis.get.mockResolvedValue(
        JSON.stringify({ inputPricePerMToken: 10, outputPricePerMToken: 30 }),
      );

      const cost = await service.calculateCost('gpt-4o', 1_000_000, 500_000);

      expect(cost.toString()).toBe('25');
    });

    it('keeps sub-cent costs without rounding up to one cent', async () => {
      // 1 token input + 1 token output @ $10/M = $0.00002
      redis.get.mockResolvedValue(
        JSON.stringify({ inputPricePerMToken: 10, outputPricePerMToken: 10 }),
      );

      const cost = await service.calculateCost('gpt-4o', 1, 1);

      expect(cost.toString()).toBe('0.00002');
    });

    it('does not round tiny per-request cost to a flat minimum', async () => {
      redis.get.mockResolvedValue(
        JSON.stringify({ inputPricePerMToken: 1, outputPricePerMToken: 1 }),
      );

      const cost = await service.calculateCost('deepseek-v4-pro', 143, 200);

      expect(cost.toString()).toBe('0.000343');
    });

    it('uses cached input price for cached prompt tokens', async () => {
      redis.get.mockResolvedValue(
        JSON.stringify({
          inputPricePerMToken: 1,
          outputPricePerMToken: 3,
          cachedInputPrice: 0.1,
        }),
      );

      const cost = await service.calculateCost('gpt-4o', 1_000_000, 500_000, 400_000);

      // 600K normal input * $1/M + 400K cached input * $0.1/M + 500K output * $3/M = $2.14
      expect(cost.toString()).toBe('2.14');
    });

    it('falls back to normal input price when cached input price is not configured', async () => {
      redis.get.mockResolvedValue(
        JSON.stringify({
          inputPricePerMToken: 1,
          outputPricePerMToken: 3,
          cachedInputPrice: null,
        }),
      );

      const cost = await service.calculateCost('model-without-cache-price', 1_000_000, 500_000, 400_000);

      expect(cost.toString()).toBe('2.5');
    });

    it('derives GLM cache-read price when cached input price is not configured', async () => {
      redis.get.mockResolvedValue(
        JSON.stringify({
          inputPricePerMToken: 0.95,
          outputPricePerMToken: 3.15,
          cachedInputPrice: null,
        }),
      );

      const quote = await service.calculateCostQuote('glm-5', 96_064, 252, 96_064);

      expect(quote.cachedInputPriceUsdPerM?.toString()).toBe('0.19');
      expect(quote.costUsd.toString()).toBe('0.01904596');
    });

    it('uses cache write price for cache creation tokens', async () => {
      redis.get.mockResolvedValue(
        JSON.stringify({
          inputPricePerMToken: 1,
          outputPricePerMToken: 3,
          cachedInputPrice: 0.1,
          cacheWrite5minPrice: 1.25,
        }),
      );

      const cost = await service.calculateCost('claude-sonnet', 1_000_000, 0, 0, 400_000);

      // 600K regular input * $1/M + 400K cache write * $1.25/M = $1.10
      expect(cost.toString()).toBe('1.1');
    });

    it('selects a configured pricing tier by input context length', async () => {
      redis.get.mockResolvedValue(null);
      (prisma.modelPricing as any).findFirst.mockResolvedValue({
        id: 'mp-glm-51',
        modelName: 'glm-5.1',
        inputPricePerMToken: new Prisma.Decimal('6'),
        outputPricePerMToken: new Prisma.Decimal('24'),
        cachedInputPrice: new Prisma.Decimal('1.3'),
        cacheWrite5minPrice: null,
        cacheWrite1hPrice: null,
        isActive: true,
      });
      (prisma.modelPricingTier as any).findMany.mockResolvedValue([
        {
          tierKey: 'short',
          displayName: '0-32K',
          minInputTokens: 0,
          maxInputTokensExclusive: 32_000,
          inputPricePerMToken: new Prisma.Decimal('6'),
          outputPricePerMToken: new Prisma.Decimal('24'),
          cachedInputPrice: new Prisma.Decimal('1.3'),
          cacheWritePrice: null,
          currency: 'USD',
          rawCondition: '输入长度 [0, 32)',
          source: 'official',
          priority: 0,
          isActive: true,
        },
        {
          tierKey: 'long',
          displayName: '32K+',
          minInputTokens: 32_000,
          maxInputTokensExclusive: null,
          inputPricePerMToken: new Prisma.Decimal('8'),
          outputPricePerMToken: new Prisma.Decimal('28'),
          cachedInputPrice: new Prisma.Decimal('2'),
          cacheWritePrice: null,
          currency: 'USD',
          rawCondition: '输入长度 [32+)',
          source: 'official',
          priority: 0,
          isActive: true,
        },
      ]);

      const quote = await service.calculateCostQuote('glm-5.1', 33_000, 1_000, 1_000);

      expect(quote.pricingTierKey).toBe('long');
      expect(quote.inputPriceUsdPerM.toString()).toBe('8');
      expect(quote.cachedInputPriceUsdPerM?.toString()).toBe('2');
      expect(quote.outputPriceUsdPerM.toString()).toBe('28');
      expect(quote.costUsd.toString()).toBe('0.286');
      expect((prisma.modelPricingTier as any).findMany).toHaveBeenCalledWith({
        where: { modelPricingId: 'mp-glm-51', isActive: true },
        orderBy: [{ priority: 'desc' }, { minInputTokens: 'desc' }],
      });
    });

    it('uses legacy long-context fields as a fallback when no explicit tiers exist', async () => {
      redis.get.mockResolvedValue(
        JSON.stringify({
          inputPricePerMToken: 5,
          outputPricePerMToken: 30,
          cachedInputPrice: 0.5,
          longContextThreshold: 32_000,
          longContextInputPrice: 10,
          longContextOutputPrice: 45,
        }),
      );

      const quote = await service.calculateCostQuote('gpt-frontier', 40_000, 1_000, 2_000);

      expect(quote.pricingTierKey).toBe('long_context');
      expect(quote.inputPriceUsdPerM.toString()).toBe('10');
      expect(quote.cachedInputPriceUsdPerM?.toString()).toBe('0.5');
      expect(quote.outputPriceUsdPerM.toString()).toBe('45');
      expect(quote.costUsd.toString()).toBe('0.426');
    });

    it('caps cached input tokens at prompt token count', async () => {
      redis.get.mockResolvedValue(
        JSON.stringify({
          inputPricePerMToken: 1,
          outputPricePerMToken: 3,
          cachedInputPrice: 0.1,
        }),
      );

      const cost = await service.calculateCost('gpt-4o', 1_000, 0, 2_000);

      expect(cost.toString()).toBe('0.0001');
    });

    it('returns 0 cost for 0 tokens', async () => {
      redis.get.mockResolvedValue(
        JSON.stringify({ inputPricePerMToken: 0.1, outputPricePerMToken: 0.3 }),
      );

      const cost = await service.calculateCost('gpt-4o', 0, 0);

      expect(cost.toString()).toBe('0');
    });

    it('freezes configured cache rates when cache quantities are zero', async () => {
      redis.get.mockResolvedValue(
        JSON.stringify({
          inputPricePerMToken: 1,
          outputPricePerMToken: 3,
          cachedInputPrice: 0.1,
          cacheWrite5minPrice: 0,
        }),
      );

      const quote = await service.calculateCostQuote('configured-cache-rates', 0, 0, 0, 0);

      expect(quote.costUsd.toString()).toBe('0');
      expect(quote.cachedInputPriceUsdPerM?.toString()).toBe('0.1');
      expect(quote.cacheWritePriceUsdPerM?.toString()).toBe('0');
    });

    it('freezes effective input fallback rates when cache quantities are zero', async () => {
      redis.get.mockResolvedValue(
        JSON.stringify({
          inputPricePerMToken: 2,
          outputPricePerMToken: 6,
          cachedInputPrice: null,
          cacheWrite5minPrice: null,
          cacheWrite1hPrice: null,
        }),
      );

      const quote = await service.calculateCostQuote('cache-rate-fallback', 1_000, 0, 0, 0);

      expect(quote.costUsd.toString()).toBe('0.002');
      expect(quote.cachedInputPriceUsdPerM?.toString()).toBe('2');
      expect(quote.cacheWritePriceUsdPerM?.toString()).toBe('2');
    });

    it('clamps negative token counts to 0', async () => {
      redis.get.mockResolvedValue(
        JSON.stringify({ inputPricePerMToken: 0.1, outputPricePerMToken: 0.3 }),
      );

      const cost = await service.calculateCost('gpt-4o', -100, 100_000);

      expect(cost.toString()).toBe('0.03');
    });

    it('throws NotFoundException if model has no pricing', async () => {
      redis.get.mockResolvedValue(null);
      (prisma.modelPricing as any).findFirst.mockResolvedValue(null);

      await expect(service.calculateCost('unknown-model', 100, 100)).rejects.toThrow(
        NotFoundException,
      );
    });

    it('throws NotFoundException with model name in message', async () => {
      redis.get.mockResolvedValue(null);
      (prisma.modelPricing as any).findFirst.mockResolvedValue(null);

      await expect(service.calculateCost('no-pricing', 100, 100)).rejects.toThrow(
        /no-pricing/,
      );
    });
  });

  describe('PAYG hardening matrix', () => {
    it('keeps different small requests at different exact USD costs', async () => {
      redis.get.mockResolvedValue(
        JSON.stringify({ inputPricePerMToken: 1, outputPricePerMToken: 5 }),
      );

      const costs = await Promise.all([
        service.calculateCost('glm-5', 18, 7),
        service.calculateCost('glm-5', 23, 17),
        service.calculateCost('glm-5', 150, 38),
      ]);

      expect(costs.map((c) => c.toString())).toEqual([
        '0.000053',
        '0.000108',
        '0.00034',
      ]);
      expect(new Set(costs.map((c) => c.toString())).size).toBe(3);
    });

    it('uses USD per 1M token prices without cents conversion', async () => {
      redis.get.mockResolvedValue(
        JSON.stringify({ inputPricePerMToken: 0.14, outputPricePerMToken: 0.28 }),
      );

      const cost = await service.calculateCost('deepseek-v4-flash', 1_000_000, 1_000_000);

      expect(cost.toString()).toBe('0.42');
    });

    it('charges cache-read tokens at cached-input price and regular input at input price', async () => {
      redis.get.mockResolvedValue(
        JSON.stringify({
          inputPricePerMToken: 5,
          outputPricePerMToken: 25,
          cachedInputPrice: 0.5,
        }),
      );

      const cost = await service.calculateCost('deepseek-v4-pro', 1_000_000, 100_000, 600_000);

      expect(cost.toString()).toBe('4.8');
    });

    it('charges cache-write tokens at cache-write price separate from cache-read tokens', async () => {
      redis.get.mockResolvedValue(
        JSON.stringify({
          inputPricePerMToken: 1,
          outputPricePerMToken: 5,
          cachedInputPrice: 0.1,
          cacheWrite5minPrice: 1.25,
        }),
      );

      const cost = await service.calculateCost('claude-sonnet', 1_000_000, 100_000, 400_000, 200_000);

      expect(cost.toString()).toBe('1.19');
    });

    it('falls back cache-write price to regular input price when no cache-write price exists', async () => {
      redis.get.mockResolvedValue(
        JSON.stringify({
          inputPricePerMToken: 2,
          outputPricePerMToken: 6,
          cachedInputPrice: 0.2,
        }),
      );

      const quote = await service.calculateCostQuote('cache-write-fallback', 1_000_000, 0, 300_000, 300_000);

      expect(quote.costUsd.toString()).toBe('1.46');
      expect(quote.cacheWritePriceUsdPerM?.toString()).toBe('2');
    });

    it('caps cache-read and cache-write buckets so input is never double-counted', async () => {
      redis.get.mockResolvedValue(
        JSON.stringify({
          inputPricePerMToken: 10,
          outputPricePerMToken: 0,
          cachedInputPrice: 1,
          cacheWrite5minPrice: 20,
        }),
      );

      const cost = await service.calculateCost('cap-model', 100, 0, 80, 80);

      expect(cost.toString()).toBe('0.00048');
    });

    it('keeps large-volume arithmetic exact at USD precision', async () => {
      redis.get.mockResolvedValue(
        JSON.stringify({
          inputPricePerMToken: 3.75,
          outputPricePerMToken: 15.5,
          cachedInputPrice: 0.3,
          cacheWrite1hPrice: 4.5,
        }),
      );

      const cost = await service.calculateCost('large-model', 12_345_678, 9_876_543, 2_000_000, 1_000_000);

      expect(cost.toString()).toBe('193.232709');
    });

    it('applies PAYG product multiplier only when product policy is active', async () => {
      redis.get.mockImplementation(async (key: string) => {
        if (key === modelPricingCacheKey('gpt-4o')) {
          return JSON.stringify({
            inputPricePerMToken: 10,
            outputPricePerMToken: 30,
            cachedInputPrice: 2,
          });
        }
        return null;
      });
      (prisma.paygModelPricingPolicy as any).findFirst.mockResolvedValue({
        priceMultiplier: new Prisma.Decimal('0.5'),
        inputPricePerMToken: null,
        cachedInputPrice: null,
        cacheWritePrice: null,
        outputPricePerMToken: null,
      });

      const quote = await service.calculateCostQuote(
        'gpt-4o',
        1_000_000,
        500_000,
        200_000,
        0,
        { productId: 'payg-prod' },
      );

      expect(quote.inputPriceUsdPerM.toString()).toBe('5');
      expect(quote.cachedInputPriceUsdPerM?.toString()).toBe('1');
      expect(quote.outputPriceUsdPerM.toString()).toBe('15');
      expect(quote.costUsd.toString()).toBe('11.7');
      expect((prisma.paygModelPricingPolicy as any).findFirst).toHaveBeenCalledWith({
        where: {
          productId: 'payg-prod',
          modelName: 'gpt-4o',
          isActive: true,
          startsAt: { lte: expect.any(Date) },
          OR: [
            { endsAt: null },
            { endsAt: { gt: expect.any(Date) } },
          ],
          product: { billingMode: 'PAY_AS_YOU_GO', isActive: true },
        },
        select: {
          priceMultiplier: true,
          inputPricePerMToken: true,
          cachedInputPrice: true,
          cacheWritePrice: true,
          outputPricePerMToken: true,
        },
        orderBy: [{ startsAt: 'desc' }, { createdAt: 'desc' }],
      });
    });

    it('keeps product context but skips PAYG policy when price basis is list pricing', async () => {
      redis.get.mockImplementation(async (key: string) => {
        if (key === modelPricingCacheKey('gpt-4o')) {
          return JSON.stringify({
            inputPricePerMToken: 10,
            outputPricePerMToken: 30,
            cachedInputPrice: 2,
          });
        }
        return null;
      });
      (prisma.paygModelPricingPolicy as any).findFirst.mockResolvedValue({
        priceMultiplier: new Prisma.Decimal('0.5'),
        inputPricePerMToken: null,
        cachedInputPrice: null,
        cacheWritePrice: null,
        outputPricePerMToken: null,
      });

      const quote = await service.calculateCostQuote(
        'gpt-4o',
        1_000_000,
        500_000,
        200_000,
        0,
        { productId: 'payg-prod', priceBasis: 'LIST' },
      );

      expect(quote.inputPriceUsdPerM.toString()).toBe('10');
      expect(quote.cachedInputPriceUsdPerM?.toString()).toBe('2');
      expect(quote.outputPriceUsdPerM.toString()).toBe('30');
      expect(quote.costUsd.toString()).toBe('23.4');
      expect((prisma.paygModelPricingPolicy as any).findFirst).not.toHaveBeenCalled();
    });

    it('历史遗留覆盖价：报价路径忠实重放冻结值（不抛错、不按倍率改价）', async () => {
      redis.get.mockImplementation(async (key: string) => {
        if (key === modelPricingCacheKey('custom-model')) {
          return JSON.stringify({
            inputPricePerMToken: 10,
            outputPricePerMToken: 30,
            cachedInputPrice: 2,
            cacheWrite5minPrice: 12,
          });
        }
        return null;
      });
      // 已结束的历史策略行仍带覆盖价：延迟到达/重放的旧事件必须拿到当时的价，
      // 否则会被推进人工隔离（settlement_anchor_missing）。fail-closed 在投影层，不在报价层。
      (prisma.paygModelPricingPolicy as any).findFirst.mockResolvedValue({
        priceMultiplier: new Prisma.Decimal('0.5'),
        inputPricePerMToken: new Prisma.Decimal('8'),
        cachedInputPrice: new Prisma.Decimal('0.8'),
        cacheWritePrice: new Prisma.Decimal('9'),
        outputPricePerMToken: new Prisma.Decimal('20'),
      });

      const quote = await service.calculateCostQuote(
        'custom-model',
        1_000_000,
        100_000,
        100_000,
        100_000,
        { productId: 'payg-prod' },
      );

      expect(quote.inputPriceUsdPerM.toString()).toBe('8');
      expect(quote.cachedInputPriceUsdPerM?.toString()).toBe('0.8');
      expect(quote.cacheWritePriceUsdPerM?.toString()).toBe('9');
      expect(quote.outputPriceUsdPerM.toString()).toBe('20');
    });
  });

  // ─── listActive ───────────────────────────────────────────────────────────

  describe('listActive', () => {
    it('returns active models ordered by name', async () => {
      const models = [
        { modelName: 'claude-3-opus', inputPricePerMToken: 15, outputPricePerMToken: 75 },
        { modelName: 'gpt-4o', inputPricePerMToken: 10, outputPricePerMToken: 30 },
      ];
      (prisma.modelPricing as any).findMany.mockResolvedValue(models);

      const result = await service.listActive();

      expect(result).toEqual([
        { modelName: 'claude-3-opus', inputPricePerMToken: 15, outputPricePerMToken: 75, cachedInputPrice: null },
        { modelName: 'gpt-4o', inputPricePerMToken: 10, outputPricePerMToken: 30, cachedInputPrice: null },
      ]);
      expect((prisma.modelPricing as any).findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isActive: true },
          orderBy: { modelName: 'asc' },
        }),
      );
    });

    it('returns public models ordered by name', async () => {
      const models = [
        {
          modelName: 'gpt-4o',
          modelId: 'GPT-4o 用户版',
          inputPricePerMToken: 10,
          outputPricePerMToken: 30,
        },
      ];
      (prisma.modelPricing as any).findMany.mockResolvedValue(models);

      const result = await service.listPublic();

      expect(result).toEqual([
        {
          modelName: 'gpt-4o',
          displayName: 'GPT-4o 用户版',
          inputPricePerMToken: 10,
          outputPricePerMToken: 30,
          cachedInputPrice: null,
        },
      ]);
      expect((prisma.modelPricing as any).findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: { isActive: true, isPublished: true },
          orderBy: { modelName: 'asc' },
          select: expect.objectContaining({ modelId: true }),
        }),
      );
    });

    it('returns empty array when no active models', async () => {
      (prisma.modelPricing as any).findMany.mockResolvedValue([]);

      const result = await service.listActive();

      expect(result).toEqual([]);
    });

    it('does not use Redis cache (always queries DB)', async () => {
      (prisma.modelPricing as any).findMany.mockResolvedValue([]);

      await service.listActive();

      expect(redis.get).not.toHaveBeenCalled();
    });
  });
});
