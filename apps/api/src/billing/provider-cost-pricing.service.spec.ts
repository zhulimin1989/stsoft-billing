import { Prisma } from '@prisma/client';
import { ProviderCostPricingService } from './provider-cost-pricing.service';

describe('ProviderCostPricingService', () => {
  function buildService() {
    const prisma: any = {
      providerModelCostPolicy: {
        findMany: jest.fn(),
        findFirst: jest.fn(),
        create: jest.fn(),
        updateMany: jest.fn(),
        findUnique: jest.fn(),
        update: jest.fn(),
        delete: jest.fn(),
      },
      tokenUsage: {
        count: jest.fn(),
        findMany: jest.fn(),
        update: jest.fn(),
      },
      codingPlanProviderLine: {
        findUnique: jest.fn().mockResolvedValue({ providerCode: 'openai' }),
        findFirst: jest.fn().mockResolvedValue({ id: 'line-1' }),
      },
      product: {
        findFirst: jest.fn().mockResolvedValue({ id: 'prod-1' }),
      },
      modelPricing: {
        findFirst: jest.fn().mockResolvedValue({ id: 'model-1' }),
      },
      channel: {
        findFirst: jest.fn().mockResolvedValue({ id: 'channel-1' }),
      },
    };
    prisma.$transaction = jest.fn((callback: (tx: typeof prisma) => unknown) => callback(prisma));
    const modelPricing = { calculateCostQuote: jest.fn() };
    return { service: new ProviderCostPricingService(prisma, modelPricing as never), prisma, modelPricing };
  }

  function policy(overrides: Record<string, unknown> = {}) {
    return {
      id: 'policy-1',
      productId: null,
      providerCode: 'openai',
      providerLineId: null,
      modelName: 'gpt-test',
      priceMultiplier: new Prisma.Decimal('1'),
      inputCostUsdPerM: null,
      cachedInputCostUsdPerM: null,
      cacheWriteCostUsdPerM: null,
      outputCostUsdPerM: null,
      startsAt: new Date('2026-01-01T00:00:00Z'),
      endsAt: null,
      priority: 0,
      isActive: true,
      description: '',
      createdAt: new Date('2026-01-01T00:00:00Z'),
      updatedAt: new Date('2026-01-01T00:00:00Z'),
      ...overrides,
    };
  }

  it('quotes provider cost with the most specific active policy at the event time', async () => {
    const { service, prisma } = buildService();
    const effectiveAt = new Date('2026-03-01T00:00:00Z');
    prisma.providerModelCostPolicy.findMany.mockResolvedValue([
      policy({
        id: 'global-provider',
        priceMultiplier: new Prisma.Decimal('0.8'),
        startsAt: new Date('2026-01-01T00:00:00Z'),
      }),
      policy({
        id: 'line-product',
        productId: 'prod-1',
        providerLineId: 'line-1',
        priceMultiplier: new Prisma.Decimal('0.5'),
        startsAt: new Date('2026-02-01T00:00:00Z'),
      }),
    ]);

    const quote = await service.quote({
      productId: 'prod-1',
      providerCode: 'openai',
      providerLineId: 'line-1',
      modelName: 'gpt-test',
      inputTokens: 1_000_000,
      outputTokens: 500_000,
      cachedInputTokens: 200_000,
      cacheWriteInputTokens: 100_000,
      effectiveAt,
      base: {
        costUsd: new Prisma.Decimal('23.4'),
        pricingTierKey: null,
        inputPriceUsdPerM: new Prisma.Decimal('10'),
        cachedInputPriceUsdPerM: new Prisma.Decimal('2'),
        cacheWritePriceUsdPerM: new Prisma.Decimal('12'),
        outputPriceUsdPerM: new Prisma.Decimal('30'),
      },
    });

    expect(prisma.providerModelCostPolicy.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        modelName: 'gpt-test',
        isActive: true,
        startsAt: { lte: effectiveAt },
      }),
    }));
    expect(quote?.policyId).toBe('line-product');
    expect(quote?.inputCostUsdPerM.toString()).toBe('5');
    expect(quote?.cachedInputCostUsdPerM.toString()).toBe('1');
    expect(quote?.cacheWriteCostUsdPerM.toString()).toBe('6');
    expect(quote?.outputCostUsdPerM.toString()).toBe('15');
    expect(quote?.costUsd.toString()).toBe('11.8');
  });

  it('creates a temporal version and closes the previous open policy in the same scope', async () => {
    const { service, prisma } = buildService();
    const startsAt = '2026-02-01T00:00:00.000Z';
    const nextStartsAt = new Date('2026-04-01T00:00:00.000Z');
    prisma.providerModelCostPolicy.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ startsAt: nextStartsAt });
    prisma.providerModelCostPolicy.updateMany.mockResolvedValue({ count: 1 });
    prisma.providerModelCostPolicy.create.mockImplementation(async ({ data }: { data: unknown }) => ({
      id: 'new-policy',
      ...data as Record<string, unknown>,
    }));

    const created = await service.createPolicyVersion({
      productId: 'prod-1',
      providerCode: 'openai',
      providerLineId: 'line-1',
      modelName: 'gpt-test',
      priceMultiplier: 0.75,
      startsAt,
      description: 'spring discount',
    });

    expect(prisma.providerModelCostPolicy.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        productId: 'prod-1',
        providerCode: 'openai',
        providerLineId: 'line-1',
        modelName: 'gpt-test',
        startsAt: { lt: new Date(startsAt) },
      }),
      data: { endsAt: new Date(startsAt) },
    });
    expect(prisma.providerModelCostPolicy.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        productId: 'prod-1',
        providerCode: 'openai',
        providerLineId: 'line-1',
        modelName: 'gpt-test',
        priceMultiplier: new Prisma.Decimal('0.75'),
        startsAt: new Date(startsAt),
        endsAt: nextStartsAt,
        description: 'spring discount',
      }),
    });
    expect(created.id).toBe('new-policy');
  });

  it('deletes an unused policy and reconnects the previous policy interval', async () => {
    const { service, prisma } = buildService();
    const deleted = policy({
      id: 'policy-delete',
      startsAt: new Date('2026-03-01T00:00:00.000Z'),
      endsAt: new Date('2026-04-01T00:00:00.000Z'),
    });
    prisma.providerModelCostPolicy.findUnique.mockResolvedValue(deleted);
    prisma.tokenUsage.count.mockResolvedValue(0);
    prisma.providerModelCostPolicy.findFirst.mockResolvedValue({ id: 'policy-prev' });
    prisma.providerModelCostPolicy.delete.mockResolvedValue(deleted);

    await expect(service.deletePolicy('policy-delete')).resolves.toBe(deleted);

    expect(prisma.tokenUsage.count).toHaveBeenCalledWith({
      where: { providerCostPolicyId: 'policy-delete' },
    });
    expect(prisma.providerModelCostPolicy.findFirst).toHaveBeenCalledWith({
      where: expect.objectContaining({
        productId: deleted.productId,
        providerCode: deleted.providerCode,
        providerLineId: deleted.providerLineId,
        modelName: deleted.modelName,
        id: { not: deleted.id },
        isActive: true,
        startsAt: { lt: deleted.startsAt },
        endsAt: deleted.startsAt,
      }),
      orderBy: { startsAt: 'desc' },
      select: { id: true },
    });
    expect(prisma.providerModelCostPolicy.update).toHaveBeenCalledWith({
      where: { id: 'policy-prev' },
      data: { endsAt: deleted.endsAt },
    });
    expect(prisma.providerModelCostPolicy.delete).toHaveBeenCalledWith({
      where: { id: 'policy-delete' },
    });
  });

  it('rejects deleting a policy referenced by token usage', async () => {
    const { service, prisma } = buildService();
    prisma.providerModelCostPolicy.findUnique.mockResolvedValue(policy({ id: 'policy-used' }));
    prisma.tokenUsage.count.mockResolvedValue(1);

    await expect(service.deletePolicy('policy-used')).rejects.toThrow('成本策略已有用量记录引用，不能删除，请停用');
    expect(prisma.providerModelCostPolicy.delete).not.toHaveBeenCalled();
  });

  it('backfills token usage provider cost snapshots for a month', async () => {
    const { service, prisma } = buildService();
    prisma.tokenUsage.findMany.mockResolvedValue([{
      id: 'usage-1',
      productId: 'prod-1',
      providerCode: 'openai',
      providerLineId: null,
      model: 'gpt-test',
      promptTokens: 1000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      completionTokens: 500,
      inputPriceUsdPerM: new Prisma.Decimal('10'),
      cachedInputPriceUsdPerM: new Prisma.Decimal('2'),
      cacheWritePriceUsdPerM: new Prisma.Decimal('12'),
      outputPriceUsdPerM: new Prisma.Decimal('20'),
      costUsd: new Prisma.Decimal('0.02'),
      pricingTierKey: 'standard',
      createdAt: new Date('2026-05-10T00:00:00.000Z'),
    }]);
    prisma.providerModelCostPolicy.findMany.mockResolvedValue([
      policy({
        id: 'policy-usage',
        priceMultiplier: new Prisma.Decimal('0.5'),
        inputCostUsdPerM: new Prisma.Decimal('5'),
        outputCostUsdPerM: new Prisma.Decimal('10'),
      }),
    ]);
    prisma.tokenUsage.update.mockResolvedValue({});

    await expect(service.backfillTokenUsageCosts({ month: '2026-05' })).resolves.toEqual({
      startsAt: '2026-05-01T00:00:00.000Z',
      endsAt: '2026-06-01T00:00:00.000Z',
      scanned: 1,
      matched: 1,
      updated: 1,
      skipped: 0,
      dryRun: false,
    });
    expect(prisma.tokenUsage.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        meter: 'token',
        createdAt: {
          gte: new Date('2026-05-01T00:00:00.000Z'),
          lt: new Date('2026-06-01T00:00:00.000Z'),
        },
      }),
      take: 5000,
    }));
    expect(prisma.tokenUsage.update).toHaveBeenCalledWith({
      where: { id: 'usage-1' },
      data: expect.objectContaining({
        providerCostEstimateUsd: expect.any(Prisma.Decimal),
        providerCostPolicyId: 'policy-usage',
        providerCostMultiplier: new Prisma.Decimal('0.5'),
        providerInputCostUsdPerM: new Prisma.Decimal('5'),
        providerOutputCostUsdPerM: new Prisma.Decimal('10'),
      }),
    });
  });

  it('backfill 对 OFF_PEAK 行不使用行内空闲客户价：改按重算的 LIST 基价（不传 bandAt）', async () => {
    const { service, prisma, modelPricing } = buildService();
    prisma.tokenUsage.findMany.mockResolvedValue([{
      id: 'usage-offpeak',
      productId: 'prod-1',
      providerCode: 'openai',
      providerLineId: null,
      model: 'deepseek-v4-pro',
      promptTokens: 1_000_000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      completionTokens: 1_000_000,
      // 行内是空闲客户价（4.5/13.5）——若被当 base，倍率型成本策略会低估供应商成本
      inputPriceUsdPerM: new Prisma.Decimal('4.5'),
      cachedInputPriceUsdPerM: new Prisma.Decimal('0.06'),
      cacheWritePriceUsdPerM: new Prisma.Decimal('0.48'),
      outputPriceUsdPerM: new Prisma.Decimal('13.5'),
      costUsd: new Prisma.Decimal('18'),
      pricingTierKey: 'OFF_PEAK',
      createdAt: new Date('2026-05-10T00:00:00.000Z'),
    }]);
    // 重算出的高峰 LIST 基价（9/27）
    modelPricing.calculateCostQuote.mockResolvedValue({
      costUsd: new Prisma.Decimal('36'),
      pricingTierKey: null,
      inputPriceUsdPerM: new Prisma.Decimal('9'),
      cachedInputPriceUsdPerM: new Prisma.Decimal('0.3'),
      cacheWritePriceUsdPerM: new Prisma.Decimal('1.2'),
      outputPriceUsdPerM: new Prisma.Decimal('27'),
    });
    prisma.providerModelCostPolicy.findMany.mockResolvedValue([
      policy({ id: 'policy-mult', priceMultiplier: new Prisma.Decimal('0.5') }),
    ]);
    prisma.tokenUsage.update.mockResolvedValue({});

    const result = await service.backfillTokenUsageCosts({ month: '2026-05' });
    expect(result).toEqual(expect.objectContaining({ matched: 1, updated: 1, skipped: 0 }));
    // base 来自重算（LIST、不传 bandAt），而非行内空闲价
    expect(modelPricing.calculateCostQuote).toHaveBeenCalledWith(
      'deepseek-v4-pro', 1_000_000, 1_000_000, 0, 0,
      { priceBasis: 'LIST', effectiveAt: new Date('2026-05-10T00:00:00.000Z') },
    );
    const optionsArg = modelPricing.calculateCostQuote.mock.calls[0][5];
    expect(optionsArg.bandAt).toBeUndefined();
    // 倍率 0.5 × 高峰基价：input 4.5（=9×0.5），而不是空闲价 4.5×0.5=2.25
    expect(prisma.tokenUsage.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        providerInputCostUsdPerM: new Prisma.Decimal('4.5'),
        providerOutputCostUsdPerM: new Prisma.Decimal('13.5'),
      }),
    }));
  });

  it('backfill：OFF_PEAK 行重算 LIST 遇 NotFoundException（模型定价已删）→ skip+warn 且继续，skipped 计数正确', async () => {
    const { service, prisma, modelPricing } = buildService();
    const offPeakRow = (id: string, model: string) => ({
      id,
      productId: 'prod-1',
      providerCode: 'openai',
      providerLineId: null,
      model,
      promptTokens: 1000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      completionTokens: 500,
      inputPriceUsdPerM: new Prisma.Decimal('4.5'),
      cachedInputPriceUsdPerM: new Prisma.Decimal('0.06'),
      cacheWritePriceUsdPerM: new Prisma.Decimal('0.48'),
      outputPriceUsdPerM: new Prisma.Decimal('13.5'),
      costUsd: new Prisma.Decimal('0.01'),
      pricingTierKey: 'OFF_PEAK',
      createdAt: new Date('2026-05-10T00:00:00.000Z'),
    });
    prisma.tokenUsage.findMany.mockResolvedValue([
      offPeakRow('usage-deleted-model', 'deleted-model'),
      offPeakRow('usage-ok', 'alive-model'),
    ]);
    const { NotFoundException } = jest.requireActual('@nestjs/common');
    modelPricing.calculateCostQuote
      .mockRejectedValueOnce(new NotFoundException('gone'))
      .mockResolvedValueOnce({
        costUsd: new Prisma.Decimal('0.02'),
        pricingTierKey: null,
        inputPriceUsdPerM: new Prisma.Decimal('9'),
        cachedInputPriceUsdPerM: new Prisma.Decimal('0.3'),
        cacheWritePriceUsdPerM: new Prisma.Decimal('1.2'),
        outputPriceUsdPerM: new Prisma.Decimal('27'),
      });
    prisma.providerModelCostPolicy.findMany.mockResolvedValue([
      policy({ id: 'policy-mult', priceMultiplier: new Prisma.Decimal('0.5') }),
    ]);
    prisma.tokenUsage.update.mockResolvedValue({});

    const result = await service.backfillTokenUsageCosts({ month: '2026-05' });
    // 第一行 fail-closed 跳过，第二行继续处理
    expect(result).toEqual(expect.objectContaining({ scanned: 2, matched: 1, updated: 1, skipped: 1 }));
    expect(prisma.tokenUsage.update).toHaveBeenCalledTimes(1);
    expect(prisma.tokenUsage.update).toHaveBeenCalledWith(expect.objectContaining({ where: { id: 'usage-ok' } }));
  });

  it('backfill：OFF_PEAK 行重算遇基础设施异常（非 NotFound）→ 上抛不吞', async () => {
    const { service, prisma, modelPricing } = buildService();
    prisma.tokenUsage.findMany.mockResolvedValue([{
      id: 'usage-db-broken',
      productId: 'prod-1',
      providerCode: 'openai',
      providerLineId: null,
      model: 'deepseek-v4-pro',
      promptTokens: 1000,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      completionTokens: 500,
      inputPriceUsdPerM: new Prisma.Decimal('4.5'),
      cachedInputPriceUsdPerM: new Prisma.Decimal('0.06'),
      cacheWritePriceUsdPerM: new Prisma.Decimal('0.48'),
      outputPriceUsdPerM: new Prisma.Decimal('13.5'),
      costUsd: new Prisma.Decimal('0.01'),
      pricingTierKey: 'OFF_PEAK',
      createdAt: new Date('2026-05-10T00:00:00.000Z'),
    }]);
    modelPricing.calculateCostQuote.mockRejectedValue(new Error('db down'));

    await expect(service.backfillTokenUsageCosts({ month: '2026-05' })).rejects.toThrow('db down');
  });

  it('does not scan image-meter rows for token-only provider cost backfill', async () => {
    const { service, prisma } = buildService();
    prisma.tokenUsage.findMany.mockResolvedValue([]);

    await expect(service.backfillTokenUsageCosts({ month: '2026-05' })).resolves.toEqual(
      expect.objectContaining({ scanned: 0, matched: 0, updated: 0 }),
    );

    expect(prisma.tokenUsage.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ meter: 'token' }),
    }));
    expect(prisma.tokenUsage.update).not.toHaveBeenCalled();
  });
});
