/**
 * OFF_PEAK 时段价格档选档测试（me/time-based-pricing.md v13.4）。
 * 核心不变量：
 * 1. 不传 bandAt 的调用永远选不中 OFF_PEAK 档（红线隔离：转售/供应商成本/LIST 基线）；
 * 2. 峰时传 bandAt 也不命中（且 OFF_PEAK 从普通档集合永久排除，不会被 min=0 区间兜住）；
 * 3. 谷时命中 → 四价全取档内绝对价，pricingTierKey='OFF_PEAK'；
 * 4. band_schedule 脏数据 fail-safe：不选档，按普通价计。
 */

import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { ModelPricingService } from './model-pricing.service';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

const DEEPSEEK_WINDOWS = [
  { days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' },
  { days: [1, 2, 3, 4, 5], start: '14:00', end: '18:00' },
];

// 2026-08-24 是周一：10:00 北京=峰，13:00 北京=谷
const PEAK_AT = new Date('2026-08-24T10:00:00+08:00');
const OFF_PEAK_AT = new Date('2026-08-24T13:00:00+08:00');

function offPeakTierRow(overrides: Record<string, unknown> = {}) {
  return {
    tierKey: 'OFF_PEAK',
    displayName: '空闲时段价',
    minInputTokens: 0,
    maxInputTokensExclusive: null,
    inputPricePerMToken: new Prisma.Decimal('4.5'),
    outputPricePerMToken: new Prisma.Decimal('13.5'),
    cachedInputPrice: new Prisma.Decimal('0.06'),
    cacheWritePrice: new Prisma.Decimal('0.48'),
    bandSchedule: DEEPSEEK_WINDOWS,
    currency: 'USD',
    rawCondition: null,
    source: null,
    priority: 0,
    isActive: true,
    ...overrides,
  };
}

describe('ModelPricingService OFF_PEAK tier selection', () => {
  let service: ModelPricingService;
  let prisma: any;
  let redis: any;

  function setupModel(tiers: unknown[], pricingUnit: string | null = null) {
    prisma.modelPricing.findFirst.mockResolvedValue({
      id: 'mp-1',
      modelName: 'deepseek-v4-pro',
      inputPricePerMToken: new Prisma.Decimal('9'),
      outputPricePerMToken: new Prisma.Decimal('27'),
      cachedInputPrice: new Prisma.Decimal('0.3'),
      cacheWrite5minPrice: new Prisma.Decimal('1.2'),
      cacheWrite1hPrice: null,
      pricingUnit,
      isActive: true,
    });
    prisma.modelPricingTier.findMany.mockResolvedValue(tiers);
  }

  beforeEach(async () => {
    prisma = {
      modelPricing: { findFirst: jest.fn(), findMany: jest.fn() },
      modelPricingTier: { findMany: jest.fn().mockResolvedValue([]) },
      paygModelPricingPolicy: { findFirst: jest.fn().mockResolvedValue(null) },
    };
    redis = { get: jest.fn().mockResolvedValue(null), set: jest.fn().mockResolvedValue('OK') };
    const moduleRef = await Test.createTestingModule({
      providers: [
        ModelPricingService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();
    service = moduleRef.get(ModelPricingService);
  });

  it('谷时传 bandAt：命中 OFF_PEAK 档，四价=档内绝对价、tierKey=OFF_PEAK', async () => {
    setupModel([offPeakTierRow()]);
    const quote = await service.calculateCostQuote(
      'deepseek-v4-pro', 1_000_000, 1_000_000, 0, 0, { bandAt: OFF_PEAK_AT },
    );
    expect(quote.pricingTierKey).toBe('OFF_PEAK');
    expect(quote.inputPriceUsdPerM.toString()).toBe('4.5');
    expect(quote.outputPriceUsdPerM.toString()).toBe('13.5');
    expect(quote.costUsd.toString()).toBe('18'); // 4.5 + 13.5
  });

  it('峰时传 bandAt：不命中 OFF_PEAK，走基价（tierKey=null），不被 min=0 区间兜住', async () => {
    setupModel([offPeakTierRow()]);
    const quote = await service.calculateCostQuote(
      'deepseek-v4-pro', 1_000_000, 1_000_000, 0, 0, { bandAt: PEAK_AT },
    );
    expect(quote.pricingTierKey).toBeNull();
    expect(quote.inputPriceUsdPerM.toString()).toBe('9');
    expect(quote.costUsd.toString()).toBe('36');
  });

  it('不传 bandAt（红线隔离）：谷时时刻也永远选不中 OFF_PEAK', async () => {
    setupModel([offPeakTierRow()]);
    const quote = await service.calculateCostQuote('deepseek-v4-pro', 1_000_000, 1_000_000, 0, 0, {});
    expect(quote.pricingTierKey).toBeNull();
    expect(quote.inputPriceUsdPerM.toString()).toBe('9');
  });

  it('LIST 基线（供应商成本口径，不传 bandAt）谷时仍为高峰价', async () => {
    setupModel([offPeakTierRow()]);
    const quote = await service.calculateCostQuote(
      'deepseek-v4-pro', 1_000_000, 1_000_000, 0, 0,
      { priceBasis: 'LIST', effectiveAt: OFF_PEAK_AT },
    );
    expect(quote.pricingTierKey).toBeNull();
    expect(quote.inputPriceUsdPerM.toString()).toBe('9');
  });

  it('谷时缓存维度也取档内绝对价（cached=0.06 / cacheWrite=0.48，无派生乘法）', async () => {
    setupModel([offPeakTierRow()]);
    const quote = await service.calculateCostQuote(
      'deepseek-v4-pro', 1_000_000, 0, 400_000, 100_000, { bandAt: OFF_PEAK_AT },
    );
    expect(quote.cachedInputPriceUsdPerM?.toString()).toBe('0.06');
    expect(quote.cacheWritePriceUsdPerM?.toString()).toBe('0.48');
  });

  it.each([
    ['band_schedule 缺失', offPeakTierRow({ bandSchedule: null })],
    ['band_schedule 空数组（防全天 OFF_PEAK）', offPeakTierRow({ bandSchedule: [] })],
    ['band_schedule 脏结构', offPeakTierRow({ bandSchedule: { bad: true } })],
  ])('fail-safe：%s → 不选档，按普通价计', async (_label, tier) => {
    setupModel([tier]);
    const quote = await service.calculateCostQuote(
      'deepseek-v4-pro', 1_000_000, 1_000_000, 0, 0, { bandAt: OFF_PEAK_AT },
    );
    expect(quote.pricingTierKey).toBeNull();
    expect(quote.inputPriceUsdPerM.toString()).toBe('9');
  });

  it('非 token 计价（pricingUnit=video_second 走 token 公式的遗留形态）不进时段档', async () => {
    setupModel([offPeakTierRow()], 'video_second');
    const quote = await service.calculateCostQuote(
      'deepseek-v4-pro', 1_000_000, 1_000_000, 0, 0, { bandAt: OFF_PEAK_AT },
    );
    expect(quote.pricingTierKey).toBeNull();
  });

  it('普通上下文档模型行为逐位不变（无 OFF_PEAK 档时传 bandAt 无效果）', async () => {
    const contextTier = {
      tierKey: 'long_context',
      displayName: null,
      minInputTokens: 200_000,
      maxInputTokensExclusive: null,
      inputPricePerMToken: new Prisma.Decimal('2.5'),
      outputPricePerMToken: new Prisma.Decimal('15'),
      cachedInputPrice: null,
      cacheWritePrice: null,
      bandSchedule: null,
      currency: 'USD',
      rawCondition: null,
      source: null,
      priority: 0,
      isActive: true,
    };
    setupModel([contextTier]);
    const withBand = await service.calculateCostQuote(
      'deepseek-v4-pro', 300_000, 1000, 0, 0, { bandAt: OFF_PEAK_AT },
    );
    const withoutBand = await service.calculateCostQuote(
      'deepseek-v4-pro', 300_000, 1000, 0, 0, {},
    );
    expect(withBand.pricingTierKey).toBe('long_context');
    expect(withBand.costUsd.toString()).toBe(withoutBand.costUsd.toString());
  });
});
