import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma, ProviderModelCostPolicy } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { usdNumber } from './money';
import { ModelPricingQuote, ModelPricingService } from './model-pricing.service';
import { OFF_PEAK_TIER_KEY } from './model-time-band';

export type ProviderCostPolicyWriteInput = {
  productId?: string | null;
  providerCode: string;
  providerLineId?: string | null;
  modelName: string;
  priceMultiplier?: string | number | null;
  inputCostUsdPerM?: string | number | null;
  cachedInputCostUsdPerM?: string | number | null;
  cacheWriteCostUsdPerM?: string | number | null;
  outputCostUsdPerM?: string | number | null;
  startsAt?: string | Date | null;
  endsAt?: string | Date | null;
  priority?: string | number | null;
  isActive?: boolean;
  description?: string | null;
};

export type ProviderCostPolicyListQuery = {
  productId?: string | null;
  providerCode?: string | null;
  providerLineId?: string | null;
  modelName?: string | null;
  effectiveAt?: string | Date | null;
  activeOnly?: boolean;
};

export type ProviderCostQuoteInput = {
  productId?: string | null;
  providerCode?: string | null;
  providerLineId?: string | null;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  base: ModelPricingQuote;
  effectiveAt?: Date | null;
};

export type ProviderCostQuoteResult = {
  policyId: string;
  providerCode: string;
  providerLineId: string | null;
  productId: string | null;
  priceMultiplier: Prisma.Decimal;
  inputCostUsdPerM: Prisma.Decimal;
  cachedInputCostUsdPerM: Prisma.Decimal;
  cacheWriteCostUsdPerM: Prisma.Decimal;
  outputCostUsdPerM: Prisma.Decimal;
  costUsd: Prisma.Decimal;
};

export type ProviderCostBackfillInput = {
  month?: string | null;
  startsAt?: string | Date | null;
  endsAt?: string | Date | null;
  limit?: string | number | null;
  dryRun?: string | boolean | null;
};

export type ProviderCostBackfillResult = {
  startsAt: string;
  endsAt: string;
  scanned: number;
  matched: number;
  updated: number;
  skipped: number;
  dryRun: boolean;
};

type NormalizedProviderCostPolicyInput = {
  productId: string | null;
  providerCode: string;
  providerLineId: string | null;
  modelName: string;
  priceMultiplier: Prisma.Decimal;
  inputCostUsdPerM: Prisma.Decimal | null;
  cachedInputCostUsdPerM: Prisma.Decimal | null;
  cacheWriteCostUsdPerM: Prisma.Decimal | null;
  outputCostUsdPerM: Prisma.Decimal | null;
  startsAt: Date;
  endsAt: Date | null;
  priority: number;
  isActive: boolean;
  description: string;
};

@Injectable()
export class ProviderCostPricingService {
  private readonly logger = new Logger(ProviderCostPricingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly modelPricing: ModelPricingService,
  ) {}

  async listPolicies(query: ProviderCostPolicyListQuery = {}) {
    const effectiveAt = this.toOptionalDate(query.effectiveAt, 'effectiveAt');
    const where: Prisma.ProviderModelCostPolicyWhereInput = {
      ...(query.productId?.trim() ? { productId: query.productId.trim() } : {}),
      ...(query.providerCode?.trim() ? { providerCode: query.providerCode.trim() } : {}),
      ...(query.providerLineId?.trim() ? { providerLineId: query.providerLineId.trim() } : {}),
      ...(query.modelName?.trim() ? { modelName: query.modelName.trim() } : {}),
      ...(query.activeOnly === false ? {} : { isActive: true }),
      ...(effectiveAt
        ? {
            startsAt: { lte: effectiveAt },
            OR: [{ endsAt: null }, { endsAt: { gt: effectiveAt } }],
          }
        : {}),
    };
    return this.prisma.providerModelCostPolicy.findMany({
      where,
      orderBy: [
        { providerCode: 'asc' },
        { modelName: 'asc' },
        { productId: 'asc' },
        { providerLineId: 'asc' },
        { startsAt: 'desc' },
        { createdAt: 'desc' },
      ],
      include: {
        product: { select: { id: true, name: true, slug: true } },
        providerLine: { select: { id: true, code: true, name: true, providerCode: true } },
      },
    });
  }

  async createPolicyVersion(input: ProviderCostPolicyWriteInput): Promise<ProviderModelCostPolicy> {
    const normalized = await this.normalizeWriteInput(input);
    return this.prisma.$transaction(async (tx) => {
      const sameScopeWhere = this.sameScopeWhere(normalized);
      const duplicateStart = await tx.providerModelCostPolicy.findFirst({
        where: {
          ...sameScopeWhere,
          isActive: true,
          startsAt: normalized.startsAt,
        },
        select: { id: true },
      });
      if (duplicateStart) {
        throw new BadRequestException('同一供应商/产品/模型在该开始时间已存在成本策略');
      }

      const nextPolicy = await tx.providerModelCostPolicy.findFirst({
        where: {
          ...sameScopeWhere,
          isActive: true,
          startsAt: { gt: normalized.startsAt },
        },
        orderBy: { startsAt: 'asc' },
        select: { startsAt: true },
      });
      if (
        normalized.endsAt &&
        nextPolicy &&
        normalized.endsAt.getTime() > nextPolicy.startsAt.getTime()
      ) {
        throw new BadRequestException('结束时间不能覆盖同一作用域的下一条成本策略');
      }

      const endsAt = normalized.endsAt ?? nextPolicy?.startsAt ?? null;
      await tx.providerModelCostPolicy.updateMany({
        where: {
          ...sameScopeWhere,
          isActive: true,
          startsAt: { lt: normalized.startsAt },
          OR: [{ endsAt: null }, { endsAt: { gt: normalized.startsAt } }],
        },
        data: { endsAt: normalized.startsAt },
      });

      return tx.providerModelCostPolicy.create({
        data: {
          productId: normalized.productId,
          providerCode: normalized.providerCode,
          providerLineId: normalized.providerLineId,
          modelName: normalized.modelName,
          priceMultiplier: normalized.priceMultiplier,
          inputCostUsdPerM: normalized.inputCostUsdPerM,
          cachedInputCostUsdPerM: normalized.cachedInputCostUsdPerM,
          cacheWriteCostUsdPerM: normalized.cacheWriteCostUsdPerM,
          outputCostUsdPerM: normalized.outputCostUsdPerM,
          startsAt: normalized.startsAt,
          endsAt,
          priority: normalized.priority,
          isActive: normalized.isActive,
          description: normalized.description,
        },
      });
    });
  }

  async deactivatePolicy(id: string): Promise<ProviderModelCostPolicy> {
    const normalizedId = id?.trim();
    if (!normalizedId) throw new BadRequestException('id 必填');
    const existing = await this.prisma.providerModelCostPolicy.findUnique({
      where: { id: normalizedId },
    });
    if (!existing) throw new NotFoundException('供应商成本策略不存在');
    const now = new Date();
    return this.prisma.providerModelCostPolicy.update({
      where: { id: normalizedId },
      data: {
        isActive: false,
        ...(existing.endsAt == null || existing.endsAt.getTime() > now.getTime()
          ? { endsAt: now }
          : {}),
      },
    });
  }

  async deletePolicy(id: string): Promise<ProviderModelCostPolicy> {
    const normalizedId = id?.trim();
    if (!normalizedId) throw new BadRequestException('id 必填');

    return this.prisma.$transaction(async (tx) => {
      const existing = await tx.providerModelCostPolicy.findUnique({
        where: { id: normalizedId },
      });
      if (!existing) throw new NotFoundException('供应商成本策略不存在');

      const usageCount = await tx.tokenUsage.count({
        where: { providerCostPolicyId: normalizedId },
      });
      if (usageCount > 0) {
        throw new BadRequestException('成本策略已有用量记录引用，不能删除，请停用');
      }

      const previousPolicy = await tx.providerModelCostPolicy.findFirst({
        where: {
          ...this.sameScopeWhere(existing),
          id: { not: existing.id },
          isActive: true,
          startsAt: { lt: existing.startsAt },
          endsAt: existing.startsAt,
        },
        orderBy: { startsAt: 'desc' },
        select: { id: true },
      });
      if (previousPolicy) {
        await tx.providerModelCostPolicy.update({
          where: { id: previousPolicy.id },
          data: { endsAt: existing.endsAt },
        });
      }

      return tx.providerModelCostPolicy.delete({
        where: { id: normalizedId },
      });
    });
  }

  async backfillTokenUsageCosts(input: ProviderCostBackfillInput = {}): Promise<ProviderCostBackfillResult> {
    const { startsAt, endsAt } = this.normalizeBackfillRange(input);
    const limit = this.normalizeBackfillLimit(input.limit);
    const dryRun = this.normalizeBoolean(input.dryRun);
    const rows = await this.prisma.tokenUsage.findMany({
      where: {
        // ProviderModelCostPolicy is token-only. Image rows intentionally stay
        // unknown/null until P3 imports real provider bills.
        meter: 'token',
        createdAt: { gte: startsAt, lt: endsAt },
        OR: [
          { providerCostEstimateUsd: null },
          { providerCostPolicyId: null },
          { providerCostMultiplier: null },
        ],
        AND: [{
          OR: [
            { providerCode: { not: null } },
            { providerLineId: { not: null } },
          ],
        }],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: limit,
      select: {
        id: true,
        productId: true,
        providerCode: true,
        providerLineId: true,
        model: true,
        promptTokens: true,
        cachedInputTokens: true,
        cacheWriteInputTokens: true,
        completionTokens: true,
        inputPriceUsdPerM: true,
        cachedInputPriceUsdPerM: true,
        cacheWritePriceUsdPerM: true,
        outputPriceUsdPerM: true,
        costUsd: true,
        pricingTierKey: true,
        createdAt: true,
      },
    });

    let matched = 0;
    let updated = 0;
    for (const row of rows) {
      // 供应商成本红线：OFF_PEAK（时段档）行的行内四价是**空闲客户价**，不得当成本
      // base（倍率型/部分覆盖型成本策略会低估供应商成本）。改按该模型的 LIST 基价
      // （不传 bandAt）重算 base。
      // 2026-09-07 起这里是**精确重放**而不再是"当前价"近似：model_pricing 有了结算取价
      // 窗口（starts_at/ends_at），下面传的 effectiveAt=row.createdAt 会取到该行落账当时
      // 生效的那版基价；模型此后下架也不影响回补。
      // 仅 NotFoundException（该时刻无生效定价）fail-closed 跳过该行并 warn；
      // DB/基础设施异常照常上抛，不得被吞。
      let base: ProviderCostQuoteInput['base'] = {
        costUsd: row.costUsd,
        pricingTierKey: row.pricingTierKey,
        inputPriceUsdPerM: row.inputPriceUsdPerM,
        cachedInputPriceUsdPerM: row.cachedInputPriceUsdPerM,
        cacheWritePriceUsdPerM: row.cacheWritePriceUsdPerM,
        outputPriceUsdPerM: row.outputPriceUsdPerM,
      };
      if (row.pricingTierKey === OFF_PEAK_TIER_KEY) {
        try {
          base = await this.modelPricing.calculateCostQuote(
            row.model,
            row.promptTokens,
            row.completionTokens,
            row.cachedInputTokens ?? 0,
            row.cacheWriteInputTokens ?? 0,
            { priceBasis: 'LIST', effectiveAt: row.createdAt },
          );
        } catch (err) {
          if (err instanceof NotFoundException) {
            this.logger.warn(
              `provider cost backfill skipped OFF_PEAK row (list pricing unavailable) tokenUsageId=${row.id} model=${row.model}`,
            );
            continue;
          }
          throw err;
        }
      }
      const providerCost = await this.quote({
        productId: row.productId,
        providerCode: row.providerCode,
        providerLineId: row.providerLineId,
        modelName: row.model,
        inputTokens: row.promptTokens,
        outputTokens: row.completionTokens,
        cachedInputTokens: row.cachedInputTokens ?? 0,
        cacheWriteInputTokens: row.cacheWriteInputTokens ?? 0,
        base,
        effectiveAt: row.createdAt,
      });
      if (!providerCost) continue;
      matched += 1;
      if (dryRun) continue;
      await this.prisma.tokenUsage.update({
        where: { id: row.id },
        data: {
          providerCostEstimateUsd: providerCost.costUsd,
          providerCostPolicyId: providerCost.policyId,
          providerCostMultiplier: providerCost.priceMultiplier,
          providerInputCostUsdPerM: providerCost.inputCostUsdPerM,
          providerCachedInputCostUsdPerM: providerCost.cachedInputCostUsdPerM,
          providerCacheWriteCostUsdPerM: providerCost.cacheWriteCostUsdPerM,
          providerOutputCostUsdPerM: providerCost.outputCostUsdPerM,
        },
      });
      updated += 1;
    }

    return {
      startsAt: startsAt.toISOString(),
      endsAt: endsAt.toISOString(),
      scanned: rows.length,
      matched,
      updated,
      skipped: rows.length - matched,
      dryRun,
    };
  }

  async quote(
    input: ProviderCostQuoteInput,
    db?: Prisma.TransactionClient,
  ): Promise<ProviderCostQuoteResult | null> {
    const reader = db ?? this.prisma;
    const modelName = input.modelName?.trim();
    if (!modelName) return null;
    const providerLineId = input.providerLineId?.trim() || null;
    let providerCode = this.providerCodeOrNull(input.providerCode);
    if (!providerCode && providerLineId) {
      const line = await reader.codingPlanProviderLine.findUnique({
        where: { id: providerLineId },
        select: { providerCode: true },
      });
      providerCode = this.providerCodeOrNull(line?.providerCode);
    }
    if (!providerCode && !providerLineId) return null;

    const effectiveAt = input.effectiveAt ?? new Date();
    const policy = await this.resolvePolicy({
      productId: input.productId?.trim() || null,
      providerCode,
      providerLineId,
      modelName,
      effectiveAt,
    }, db);
    if (!policy) return null;

    const inputUnit = this.resolveUnitPrice(
      policy.inputCostUsdPerM,
      input.base.inputPriceUsdPerM,
      policy.priceMultiplier,
    );
    const cachedUnit = this.resolveUnitPrice(
      policy.cachedInputCostUsdPerM,
      input.base.cachedInputPriceUsdPerM ?? input.base.inputPriceUsdPerM,
      policy.priceMultiplier,
    );
    const cacheWriteUnit = this.resolveUnitPrice(
      policy.cacheWriteCostUsdPerM,
      input.base.cacheWritePriceUsdPerM ?? input.base.inputPriceUsdPerM,
      policy.priceMultiplier,
    );
    const outputUnit = this.resolveUnitPrice(
      policy.outputCostUsdPerM,
      input.base.outputPriceUsdPerM,
      policy.priceMultiplier,
    );

    const safeInputTokens = Math.max(0, Math.floor(Number(input.inputTokens) || 0));
    const safeOutputTokens = Math.max(0, Math.floor(Number(input.outputTokens) || 0));
    const safeCachedInputTokens = Math.min(
      Math.max(0, Math.floor(Number(input.cachedInputTokens) || 0)),
      safeInputTokens,
    );
    const remainingAfterCacheRead = safeInputTokens - safeCachedInputTokens;
    const safeCacheWriteInputTokens = Math.min(
      Math.max(0, Math.floor(Number(input.cacheWriteInputTokens) || 0)),
      remainingAfterCacheRead,
    );
    const nonCachedInputTokens = remainingAfterCacheRead - safeCacheWriteInputTokens;
    const costUsd = new Prisma.Decimal(nonCachedInputTokens)
      .mul(inputUnit)
      .plus(new Prisma.Decimal(safeCachedInputTokens).mul(cachedUnit))
      .plus(new Prisma.Decimal(safeCacheWriteInputTokens).mul(cacheWriteUnit))
      .plus(new Prisma.Decimal(safeOutputTokens).mul(outputUnit))
      .div(1_000_000)
      .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);

    return {
      policyId: policy.id,
      providerCode: policy.providerCode,
      providerLineId: policy.providerLineId,
      productId: policy.productId,
      priceMultiplier: policy.priceMultiplier,
      inputCostUsdPerM: inputUnit,
      cachedInputCostUsdPerM: cachedUnit,
      cacheWriteCostUsdPerM: cacheWriteUnit,
      outputCostUsdPerM: outputUnit,
      costUsd,
    };
  }

  private async resolvePolicy(input: {
    productId: string | null;
    providerCode: string | null;
    providerLineId: string | null;
    modelName: string;
    effectiveAt: Date;
  }, db?: Prisma.TransactionClient): Promise<ProviderModelCostPolicy | null> {
    const providerScopes: Prisma.ProviderModelCostPolicyWhereInput[] = [];
    if (input.providerLineId) providerScopes.push({ providerLineId: input.providerLineId });
    if (input.providerCode) providerScopes.push({ providerCode: input.providerCode });
    if (providerScopes.length === 0) return null;

    const productScope = input.productId
      ? [{ productId: input.productId }, { productId: null }]
      : [{ productId: null }];
    const candidates = await (db ?? this.prisma).providerModelCostPolicy.findMany({
      where: {
        modelName: input.modelName,
        isActive: true,
        startsAt: { lte: input.effectiveAt },
        AND: [
          { OR: productScope },
          { OR: [{ endsAt: null }, { endsAt: { gt: input.effectiveAt } }] },
          { OR: providerScopes },
        ],
      },
      orderBy: [
        { priority: 'desc' },
        { startsAt: 'desc' },
        { createdAt: 'desc' },
      ],
    });
    return candidates.sort((a, b) => this.policyScore(b, input) - this.policyScore(a, input))[0] ?? null;
  }

  private policyScore(
    policy: ProviderModelCostPolicy,
    input: {
      productId: string | null;
      providerCode: string | null;
      providerLineId: string | null;
    },
  ): number {
    const lineScore = input.providerLineId && policy.providerLineId === input.providerLineId ? 400 : 0;
    const productScore = input.productId && policy.productId === input.productId ? 200 : 0;
    const providerScore = input.providerCode && policy.providerCode === input.providerCode ? 100 : 0;
    const startScore = Math.floor(policy.startsAt.getTime() / 1000) / 1_000_000_000;
    return lineScore + productScore + providerScore + policy.priority + startScore;
  }

  private async normalizeWriteInput(
    input: ProviderCostPolicyWriteInput,
  ): Promise<NormalizedProviderCostPolicyInput> {
    const providerCode = this.providerCodeOrNull(input.providerCode);
    if (!providerCode) throw new BadRequestException('providerCode 必填');
    const modelName = input.modelName?.trim();
    if (!modelName) throw new BadRequestException('modelName 必填');
    const productId = input.productId?.trim() || null;
    const providerLineId = input.providerLineId?.trim() || null;
    const startsAt = this.toOptionalDate(input.startsAt, 'startsAt') ?? new Date();
    const endsAt = this.toOptionalDate(input.endsAt, 'endsAt');
    if (endsAt && endsAt.getTime() <= startsAt.getTime()) {
      throw new BadRequestException('endsAt 必须晚于 startsAt');
    }

    await Promise.all([
      this.assertProduct(productId),
      this.assertModel(modelName),
      this.assertProviderScope(providerCode, providerLineId),
    ]);

    return {
      productId,
      providerCode,
      providerLineId,
      modelName,
      priceMultiplier: this.toMultiplier(input.priceMultiplier ?? 1, 'priceMultiplier'),
      inputCostUsdPerM: this.toNullableUsd(input.inputCostUsdPerM, 'inputCostUsdPerM'),
      cachedInputCostUsdPerM: this.toNullableUsd(input.cachedInputCostUsdPerM, 'cachedInputCostUsdPerM'),
      cacheWriteCostUsdPerM: this.toNullableUsd(input.cacheWriteCostUsdPerM, 'cacheWriteCostUsdPerM'),
      outputCostUsdPerM: this.toNullableUsd(input.outputCostUsdPerM, 'outputCostUsdPerM'),
      startsAt,
      endsAt,
      priority: this.toInteger(input.priority, 0),
      isActive: input.isActive ?? true,
      description: input.description?.trim() ?? '',
    };
  }

  private sameScopeWhere(
    input: Pick<NormalizedProviderCostPolicyInput, 'productId' | 'providerCode' | 'providerLineId' | 'modelName'>,
  ): Prisma.ProviderModelCostPolicyWhereInput {
    return {
      productId: input.productId,
      providerCode: input.providerCode,
      providerLineId: input.providerLineId,
      modelName: input.modelName,
    };
  }

  private async assertProduct(productId: string | null): Promise<void> {
    if (!productId) return;
    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: { id: true },
    });
    if (!product) throw new NotFoundException('产品不存在');
  }

  private async assertModel(modelName: string): Promise<void> {
    const model = await this.prisma.modelPricing.findFirst({
      where: { modelName, isActive: true },
      select: { id: true },
    });
    if (!model) throw new BadRequestException('模型不存在或未启用');
  }

  private async assertProviderScope(providerCode: string, providerLineId: string | null): Promise<void> {
    if (providerLineId) {
      const line = await this.prisma.codingPlanProviderLine.findUnique({
        where: { id: providerLineId },
        select: { providerCode: true },
      });
      if (!line) throw new NotFoundException('供应商线路不存在');
      if (line.providerCode !== providerCode) {
        throw new BadRequestException('providerLineId 与 providerCode 不匹配');
      }
      return;
    }

    const [line, channel, model] = await Promise.all([
      this.prisma.codingPlanProviderLine.findFirst({
        where: { providerCode },
        select: { id: true },
      }),
      this.prisma.channel.findFirst({
        where: { provider: providerCode, deletedAt: null },
        select: { id: true },
      }),
      this.prisma.modelPricing.findFirst({
        where: { provider: providerCode, isActive: true },
        select: { id: true },
      }),
    ]);
    if (!line && !channel && !model) {
      throw new BadRequestException('providerCode 不存在，请先在渠道或供应商线路中维护');
    }
  }

  private providerCodeOrNull(value: string | null | undefined): string | null {
    const normalized = value?.trim();
    if (!normalized || normalized === 'unknown-provider') return null;
    return normalized;
  }

  private normalizeBackfillRange(input: ProviderCostBackfillInput): { startsAt: Date; endsAt: Date } {
    if (input.month?.trim()) {
      const month = input.month.trim();
      if (!/^\d{4}-\d{2}$/.test(month)) throw new BadRequestException('month 必须是 YYYY-MM');
      const [year, monthNo] = month.split('-').map(Number);
      const startsAt = new Date(Date.UTC(year, monthNo - 1, 1, 0, 0, 0, 0));
      const endsAt = new Date(Date.UTC(year, monthNo, 1, 0, 0, 0, 0));
      return { startsAt, endsAt };
    }
    const startsAt = this.toOptionalDate(input.startsAt, 'startsAt');
    const endsAt = this.toOptionalDate(input.endsAt, 'endsAt');
    if (!startsAt || !endsAt) throw new BadRequestException('month 或 startsAt/endsAt 必填');
    if (startsAt.getTime() >= endsAt.getTime()) throw new BadRequestException('startsAt 必须早于 endsAt');
    return { startsAt, endsAt };
  }

  private normalizeBackfillLimit(value: string | number | null | undefined): number {
    const parsed = Number(value ?? 5000);
    if (!Number.isFinite(parsed) || parsed <= 0) throw new BadRequestException('limit 必须大于 0');
    return Math.min(10_000, Math.floor(parsed));
  }

  private normalizeBoolean(value: string | boolean | null | undefined): boolean {
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'string') return false;
    const normalized = value.trim().toLowerCase();
    return normalized === 'true' || normalized === '1' || normalized === 'yes';
  }

  private resolveUnitPrice(
    overridePrice: Prisma.Decimal | null,
    basePrice: Prisma.Decimal,
    multiplier: Prisma.Decimal,
  ): Prisma.Decimal {
    if (overridePrice != null) return overridePrice;
    return basePrice.mul(multiplier).toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP);
  }

  private toMultiplier(value: string | number | null | undefined, field: string): Prisma.Decimal {
    const raw = value === undefined || value === null || value === '' ? 1 : value;
    const decimal = new Prisma.Decimal(raw);
    if (decimal.lt(0) || decimal.gt(100)) {
      throw new BadRequestException(`${field} 必须是 0 到 100 之间的数字`);
    }
    return decimal.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
  }

  private toNullableUsd(value: string | number | null | undefined, field: string): Prisma.Decimal | null {
    if (value === undefined || value === null || value === '') return null;
    const decimal = new Prisma.Decimal(value);
    if (decimal.lt(0)) throw new BadRequestException(`${field} 必须是非负数字`);
    return decimal.toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP);
  }

  private toOptionalDate(value: string | Date | null | undefined, field: string): Date | null {
    if (value === undefined || value === null || value === '') return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`${field} 必须是有效时间`);
    }
    return date;
  }

  private toInteger(value: string | number | null | undefined, fallback: number): number {
    if (value === undefined || value === null || value === '') return fallback;
    const raw = Number(value);
    if (!Number.isFinite(raw)) return fallback;
    return Math.floor(raw);
  }

  toPublicQuoteSnapshot(quote: ProviderCostQuoteResult | null) {
    if (!quote) return null;
    return {
      policyId: quote.policyId,
      providerCode: quote.providerCode,
      providerLineId: quote.providerLineId,
      productId: quote.productId,
      priceMultiplier: usdNumber(quote.priceMultiplier),
      inputCostUsdPerM: usdNumber(quote.inputCostUsdPerM),
      cachedInputCostUsdPerM: usdNumber(quote.cachedInputCostUsdPerM),
      cacheWriteCostUsdPerM: usdNumber(quote.cacheWriteCostUsdPerM),
      outputCostUsdPerM: usdNumber(quote.outputCostUsdPerM),
      costUsd: usdNumber(quote.costUsd),
    };
  }
}
