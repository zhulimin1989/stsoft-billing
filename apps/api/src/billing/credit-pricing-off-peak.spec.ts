/**
 * calculateCreditCostQuote 结构化积分报价测试（me/time-based-pricing.md v13.4 §5.4）。
 * 1. 全零用量短路：不进定价、不触发 ModelAccess 校验，返回 {0, null}；
 * 2. 兼容包装 calculateCreditCost 与新方法积分逐位相同；
 * 3. bandAt + cacheWriteInputTokens 透传到 calculateCostQuote（预览=结算对齐）；
 * 4. tierKey 与积分来自同一次定价调用（同快照）。
 */

import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { CreditPricingService } from './credit-pricing.service';
import { ModelPricingService } from './model-pricing.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

describe('CreditPricingService.calculateCreditCostQuote', () => {
  let service: CreditPricingService;
  let modelPricing: { calculateCostQuote: jest.Mock };
  let prisma: any;
  let redis: any;

  const OFF_PEAK_AT = new Date('2026-08-24T13:00:00+08:00');

  beforeEach(async () => {
    modelPricing = {
      calculateCostQuote: jest.fn().mockResolvedValue({
        costUsd: new Prisma.Decimal('0.018'),
        pricingTierKey: 'OFF_PEAK',
        inputPriceUsdPerM: new Prisma.Decimal('4.5'),
        cachedInputPriceUsdPerM: null,
        cacheWritePriceUsdPerM: null,
        outputPriceUsdPerM: new Prisma.Decimal('13.5'),
      }),
    };
    prisma = {
      modelAccess: {
        findUnique: jest.fn().mockResolvedValue({ isActive: true, creditMultiplier: 1 }),
      },
    };
    redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') };
    const moduleRef = await Test.createTestingModule({
      providers: [
        CreditPricingService,
        { provide: ModelPricingService, useValue: modelPricing },
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();
    service = moduleRef.get(CreditPricingService);
  });

  it('全零用量：短路返回 {0, null}，不进定价、不触发 ModelAccess 校验', async () => {
    const quote = await service.calculateCreditCostQuote('plan-1', 'deepseek-v4-pro', 0, 0, 1, 0, {
      requireModelAccess: true,
    });
    expect(quote).toEqual({ creditCost: 0, pricingTierKey: null });
    expect(modelPricing.calculateCostQuote).not.toHaveBeenCalled();
    expect(prisma.modelAccess.findUnique).not.toHaveBeenCalled();
  });

  it('兼容包装 calculateCreditCost：零用量短路返回 0；非零与新方法积分逐位相同', async () => {
    expect(await service.calculateCreditCost('plan-1', 'deepseek-v4-pro', 0, 0, 1)).toBe(0);
    expect(modelPricing.calculateCostQuote).not.toHaveBeenCalled();

    const legacy = await service.calculateCreditCost('plan-1', 'deepseek-v4-pro', 1000, 1000, 1);
    const structured = await service.calculateCreditCostQuote('plan-1', 'deepseek-v4-pro', 1000, 1000, 1);
    expect(legacy).toBe(structured.creditCost);
    // ceil(0.018 * 100 * 1 * 1) = 2
    expect(structured).toEqual({ creditCost: 2, pricingTierKey: 'OFF_PEAK' });
  });

  it('bandAt 与 cacheWriteInputTokens 透传到同一次 calculateCostQuote（同快照产出积分与 tierKey）', async () => {
    await service.calculateCreditCostQuote('plan-1', 'deepseek-v4-pro', 1000, 500, 1, 200, {
      bandAt: OFF_PEAK_AT,
      cacheWriteInputTokens: 300,
    });
    expect(modelPricing.calculateCostQuote).toHaveBeenCalledTimes(1);
    expect(modelPricing.calculateCostQuote).toHaveBeenCalledWith(
      'deepseek-v4-pro', 1000, 500, 200, 300,
      expect.objectContaining({ bandAt: OFF_PEAK_AT }),
    );
  });

  it('cacheWriteInputTokens 不传时保持 0（既有调用方行为逐位不变）', async () => {
    await service.calculateCreditCost('plan-1', 'deepseek-v4-pro', 1000, 500, 1, 200);
    expect(modelPricing.calculateCostQuote).toHaveBeenCalledWith(
      'deepseek-v4-pro', 1000, 500, 200, 0, expect.any(Object),
    );
    const options = modelPricing.calculateCostQuote.mock.calls[0][5];
    expect(options.bandAt).toBeUndefined();
  });
});
