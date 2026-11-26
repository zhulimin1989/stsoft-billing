import { NotFoundException, Injectable, Logger } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { usdNumber } from './money';
import {
  modelPricingCacheKey,
  publicModelPricingCacheKey,
} from '../common/utils/redis-key.util';
import {
  OFF_PEAK_TIER_KEY,
  isTokenPricingUnit,
  parseBandScheduleSafely,
  resolveScheduleBand,
} from './model-time-band';

/**
 * 检测到历史遗留的 PAYG 绝对覆盖价。按量定价已改为仅支持倍率，
 * 此时不得按倍率伪造展示/计费价 —— 由上层捕获后降级为 LEGACY_OVERRIDE_DETECTED 告警态。
 */
export class LegacyPaygOverrideDetectedError extends Error {
  readonly code = 'LEGACY_OVERRIDE_DETECTED';

  constructor(readonly overrideField: string) {
    super(`检测到已废除的按量覆盖价字段：${overrideField}`);
    this.name = 'LegacyPaygOverrideDetectedError';
  }
}

export interface ModelPricingQuote {
  costUsd: Prisma.Decimal;
  pricingTierKey: string | null;
  inputPriceUsdPerM: Prisma.Decimal;
  cachedInputPriceUsdPerM: Prisma.Decimal | null;
  cacheWritePriceUsdPerM: Prisma.Decimal | null;
  outputPriceUsdPerM: Prisma.Decimal;
  lineItems?: ModelPricingLineItem[];
}

export type ModelPricingLineItem = {
  meter: 'image';
  quantity: number;
  unitPriceUsd: Prisma.Decimal;
  amountUsd: Prisma.Decimal;
};

export interface ModelPricingQuoteOptions {
  productId?: string | null;
  priceBasis?: 'LIST' | 'PRODUCT_EFFECTIVE';
  effectiveAt?: Date;
  imageCount?: number;
  /**
   * 时段价格档（OFF_PEAK）的判定时刻。**缺省 = 不参与时段档**（红线隔离机制：
   * 转售/供应商成本/LIST 基线等路径不传即物理上选不中 OFF_PEAK 档）。
   * 传入时 = 请求开始时刻（网关 start_time）或 deduct 入口冻结的 pricingAt。
   */
  bandAt?: Date;
}

type PricingSnapshot = {
  inputPricePerMToken: string | number | Prisma.Decimal;
  outputPricePerMToken: string | number | Prisma.Decimal;
  cachedInputPrice?: string | number | Prisma.Decimal | null;
  cacheWrite5minPrice?: string | number | Prisma.Decimal | null;
  cacheWrite1hPrice?: string | number | Prisma.Decimal | null;
  longContextThreshold?: number | null;
  longContextInputPrice?: string | number | Prisma.Decimal | null;
  longContextOutputPrice?: string | number | Prisma.Decimal | null;
  pricingUnit?: string | null;
  unitPriceUsd?: string | number | Prisma.Decimal | null;
  priceTiers?: PricingTierSnapshot[];
};

type ModelPricingRow = {
  id?: string;
  inputPricePerMToken: Prisma.Decimal;
  outputPricePerMToken: Prisma.Decimal;
  cachedInputPrice?: Prisma.Decimal | null;
  cacheWrite5minPrice?: Prisma.Decimal | null;
  cacheWrite1hPrice?: Prisma.Decimal | null;
  longContextThreshold?: number | null;
  longContextInputPrice?: Prisma.Decimal | null;
  longContextOutputPrice?: Prisma.Decimal | null;
  pricingUnit?: string | null;
  unitPriceUsd?: Prisma.Decimal | null;
};

export type PricingTierSnapshot = {
  tierKey: string;
  displayName?: string | null;
  minInputTokens: number;
  maxInputTokensExclusive?: number | null;
  inputPricePerMToken: string | number | Prisma.Decimal;
  outputPricePerMToken: string | number | Prisma.Decimal;
  cachedInputPrice?: string | number | Prisma.Decimal | null;
  cacheWritePrice?: string | number | Prisma.Decimal | null;
  bandSchedule?: unknown;
  currency?: string | null;
  rawCondition?: string | null;
  source?: string | null;
  priority?: number;
  isActive?: boolean;
};

type ModelPricingTierRow = {
  tierKey: string;
  displayName?: string | null;
  minInputTokens: number;
  maxInputTokensExclusive?: number | null;
  inputPricePerMToken: Prisma.Decimal;
  outputPricePerMToken: Prisma.Decimal;
  cachedInputPrice?: Prisma.Decimal | null;
  cacheWritePrice?: Prisma.Decimal | null;
  bandSchedule?: unknown;
  currency?: string | null;
  rawCondition?: string | null;
  source?: string | null;
  priority?: number;
  isActive?: boolean;
};

type SelectedPricingSnapshot = {
  pricingTierKey: string | null;
  inputPricePerMToken: string | number | Prisma.Decimal;
  outputPricePerMToken: string | number | Prisma.Decimal;
  cachedInputPrice?: string | number | Prisma.Decimal | null;
  cacheWritePrice?: string | number | Prisma.Decimal | null;
};

type PaygPolicySnapshot = {
  priceMultiplier: string | number | Prisma.Decimal;
  inputPricePerMToken?: string | number | Prisma.Decimal | null;
  cachedInputPrice?: string | number | Prisma.Decimal | null;
  cacheWritePrice?: string | number | Prisma.Decimal | null;
  outputPricePerMToken?: string | number | Prisma.Decimal | null;
};

type PaygPolicyRow = {
  priceMultiplier: Prisma.Decimal;
  inputPricePerMToken?: Prisma.Decimal | null;
  cachedInputPrice?: Prisma.Decimal | null;
  cacheWritePrice?: Prisma.Decimal | null;
  outputPricePerMToken?: Prisma.Decimal | null;
};

@Injectable()
export class ModelPricingService {
  private readonly logger = new Logger(ModelPricingService.name);
  private static readonly GLM_CACHE_READ_DISCOUNT = new Prisma.Decimal('0.2');

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  /**
   * `at` = 事件发生时刻，只有**结算重放**才传它。
   *
   * 传了 `at`：按结算取价窗口 `[startsAt, endsAt)` 取"当时有效的价"，且**刻意不看 `isActive`**
   * —— `isActive` 是数据面开关（publisher 按它剔网关目录），拿它筛历史价就等于"模型一下架，
   * 所有还没结算的历史事件立刻报不出价"，这正是 2026-09-07 国内 prod 把 9,622 笔积压事件
   * 推进 settlement_anchor_missing、连带封掉客户 Key 的原因。已下架行的窗口由
   * 20260907000100 迁移用 `updated_at` 封闭，所以不看 isActive 也不会把退役模型判成永久有效。
   *
   * 传了 `at` 时**绕过 Redis**：每个事件的 occurredAt 各不相同，缓存天然零命中；而把某一时刻的
   * 价写进 `modelpricing:v3:<sha256(modelName)>` 会污染"当前价"，且该键不可反解、无法按模型清理。
   *
   * 不传 `at` 就是"取当前价"，谓词与缓存行为都与改造前一致。
   */
  async getPricing(
    modelName: string,
    db?: Prisma.TransactionClient,
    at?: Date,
  ): Promise<PricingSnapshot | null> {
    const where = at
      ? {
        modelName,
        startsAt: { lte: at },
        OR: [{ endsAt: null }, { endsAt: { gt: at } }],
      }
      : { modelName, isActive: true };
    if (db) {
      const pricing = await db.modelPricing.findFirst({ where });
      if (!pricing) return null;
      const tiers = await this.loadPricingTiers(pricing.id, db);
      return this.toPricingSnapshot(pricing, tiers);
    }
    if (at) {
      const pricing = await this.prisma.modelPricing.findFirst({ where });
      if (!pricing) {
        this.logger.warn(
          `No pricing effective at ${at.toISOString()} for model "${modelName}", settlement cannot be quoted`,
        );
        return null;
      }
      const tiers = await this.loadPricingTiers(pricing.id);
      return this.toPricingSnapshot(pricing, tiers);
    }
    const cacheKey = modelPricingCacheKey(modelName);
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const pricing = await this.prisma.modelPricing.findFirst({ where });

    if (!pricing) {
      this.logger.warn(`No active pricing found for model "${modelName}", model not available for billing`);
      return null;
    }

    const tiers = await this.loadPricingTiers(pricing.id);
    const result = this.toPricingSnapshot(pricing, tiers);
    // NX：写侧失效后，晚到的旧读者不得覆盖新读者已回填的快照（配合写侧延迟二次 DEL 压缩竞态窗）
    await this.redis.set(cacheKey, JSON.stringify(result), 'EX', 3600, 'NX');
    return result;
  }

  async getPublicPricing(modelName: string): Promise<PricingSnapshot | null> {
    const cacheKey = publicModelPricingCacheKey(modelName);
    const cached = await this.redis.get(cacheKey);
    if (cached) return JSON.parse(cached);

    const pricing = await this.prisma.modelPricing.findFirst({
      where: { modelName, isActive: true, isPublished: true },
    });

    if (!pricing) {
      this.logger.warn(`No published pricing found for model "${modelName}", model not available for API users`);
      return null;
    }

    const tiers = await this.loadPricingTiers(pricing.id);
    const result = this.toPricingSnapshot(pricing, tiers);
    // NX：写侧失效后，晚到的旧读者不得覆盖新读者已回填的快照（配合写侧延迟二次 DEL 压缩竞态窗）
    await this.redis.set(cacheKey, JSON.stringify(result), 'EX', 3600, 'NX');
    return result;
  }

  private async loadPricingTiers(
    modelPricingId?: string | null,
    db?: Prisma.TransactionClient,
  ): Promise<PricingTierSnapshot[]> {
    if (!modelPricingId) return [];
    const rows = await (db ?? this.prisma).modelPricingTier.findMany({
      where: { modelPricingId, isActive: true },
      orderBy: [{ priority: 'desc' }, { minInputTokens: 'desc' }],
    });
    return rows.map((tier) => this.toPricingTierSnapshot(tier));
  }

  private toPricingSnapshot(
    pricing: ModelPricingRow,
    priceTiers: PricingTierSnapshot[] = [],
  ): PricingSnapshot {
    const result: PricingSnapshot = {
      inputPricePerMToken: pricing.inputPricePerMToken.toString(),
      outputPricePerMToken: pricing.outputPricePerMToken.toString(),
      cachedInputPrice: pricing.cachedInputPrice?.toString() ?? null,
      cacheWrite5minPrice: pricing.cacheWrite5minPrice?.toString() ?? null,
      cacheWrite1hPrice: pricing.cacheWrite1hPrice?.toString() ?? null,
    };
    if (pricing.pricingUnit != null) {
      result.pricingUnit = pricing.pricingUnit;
    }
    if (pricing.unitPriceUsd != null) {
      result.unitPriceUsd = pricing.unitPriceUsd.toString();
    }
    if (pricing.longContextThreshold != null) {
      result.longContextThreshold = pricing.longContextThreshold;
      result.longContextInputPrice = pricing.longContextInputPrice?.toString() ?? null;
      result.longContextOutputPrice = pricing.longContextOutputPrice?.toString() ?? null;
    }
    if (priceTiers.length > 0) {
      result.priceTiers = priceTiers;
    }
    return result;
  }

  private toPricingTierSnapshot(tier: ModelPricingTierRow): PricingTierSnapshot {
    return {
      tierKey: tier.tierKey,
      displayName: tier.displayName ?? null,
      minInputTokens: tier.minInputTokens,
      maxInputTokensExclusive: tier.maxInputTokensExclusive ?? null,
      inputPricePerMToken: tier.inputPricePerMToken.toString(),
      outputPricePerMToken: tier.outputPricePerMToken.toString(),
      cachedInputPrice: tier.cachedInputPrice?.toString() ?? null,
      cacheWritePrice: tier.cacheWritePrice?.toString() ?? null,
      bandSchedule: tier.bandSchedule ?? null,
      currency: tier.currency ?? 'USD',
      rawCondition: tier.rawCondition ?? null,
      source: tier.source ?? null,
      priority: tier.priority ?? 0,
      isActive: tier.isActive ?? true,
    };
  }

  async calculateCost(
    model: string,
    promptTokens: number,
    completionTokens: number,
    cachedInputTokens = 0,
    cacheWriteInputTokens = 0,
    options: ModelPricingQuoteOptions = {},
  ): Promise<Prisma.Decimal> {
    const quote = await this.calculateCostQuote(
      model,
      promptTokens,
      completionTokens,
      cachedInputTokens,
      cacheWriteInputTokens,
      options,
    );
    return quote.costUsd;
  }

  async calculateCostQuote(
    model: string,
    promptTokens: number,
    completionTokens: number,
    cachedInputTokens = 0,
    cacheWriteInputTokens = 0,
    options: ModelPricingQuoteOptions = {},
    db?: Prisma.TransactionClient,
  ): Promise<ModelPricingQuote> {
    // options.effectiveAt 一路传到基础价：结算链路给的就是事件 occurredAt，
    // 以前它只喂给 getPaygPolicy（产品倍率选版），基础价却按"现在"取 ⇒ 模型一下架，
    // 尚未结算的历史事件全部报不出价。两层现在同一个口径。
    const pricing = await this.getPricing(model, db, options.effectiveAt);
    if (!pricing) {
      throw new NotFoundException(`模型 "${model}" 暂未开放 API 定价`);
    }
    const safePromptTokens = Math.max(0, promptTokens);
    const safeCompletionTokens = Math.max(0, completionTokens);
    const safeImageCount = Math.max(0, Math.floor(Number(options.imageCount) || 0));
    const priceBasis = options.priceBasis ?? 'PRODUCT_EFFECTIVE';
    const policy = options.productId && priceBasis === 'PRODUCT_EFFECTIVE'
      ? await this.getPaygPolicy(options.productId, model, options.effectiveAt, db)
      : null;
    // 覆盖价已废除：任一字段仍有值即留痕（含 image 等不走 applyPolicyPrice 的分支），
    // 便于运维清理；报价本身仍忠实重放（fail-closed 在当前价格投影层，见 applyPolicyPrice 注释）。
    this.warnOnLegacyPaygOverride(model, policy);

    if (pricing.pricingUnit === 'image') {
      if (safeImageCount <= 0) {
        throw new NotFoundException(`模型 "${model}" 图片计费缺少 image_count`);
      }
      if (pricing.unitPriceUsd == null) {
        throw new NotFoundException(`模型 "${model}" 缺少 pricingUnit=image 的 unitPriceUsd 配置`);
      }
      const configuredUnitPriceUsd = new Prisma.Decimal(pricing.unitPriceUsd);
      if (!configuredUnitPriceUsd.gt(0)) {
        throw new NotFoundException(`模型 "${model}" pricingUnit=image 需要正数 unitPriceUsd`);
      }
      const unitPriceUsd = configuredUnitPriceUsd
        .mul(policy?.priceMultiplier ?? 1)
        .toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP);
      const amountUsd = unitPriceUsd
        .mul(safeImageCount)
        .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
      const zero = new Prisma.Decimal(0);
      return {
        costUsd: amountUsd,
        pricingTierKey: null,
        inputPriceUsdPerM: zero,
        cachedInputPriceUsdPerM: null,
        cacheWritePriceUsdPerM: null,
        outputPriceUsdPerM: zero,
        lineItems: [{
          meter: 'image',
          quantity: safeImageCount,
          unitPriceUsd,
          amountUsd,
        }],
      };
    }

    if (safeImageCount > 0) {
      throw new NotFoundException(
        `模型 "${model}" 的图片用量需要 pricingUnit=image 定价配置`,
      );
    }
    const safeCachedInputTokens = Math.min(Math.max(0, cachedInputTokens), safePromptTokens);
    const remainingAfterCacheRead = safePromptTokens - safeCachedInputTokens;
    const safeCacheWriteInputTokens = Math.min(
      Math.max(0, cacheWriteInputTokens),
      remainingAfterCacheRead,
    );
    const nonCachedInputTokens = remainingAfterCacheRead - safeCacheWriteInputTokens;
    const selectedPricing = this.selectPricingForTokens(pricing, safePromptTokens, options.bandAt);
    const baseInputPriceUsdPerM = new Prisma.Decimal(selectedPricing.inputPricePerMToken);
    const configuredCachedInputPriceUsdPerM = selectedPricing.cachedInputPrice == null
      ? null
      : new Prisma.Decimal(selectedPricing.cachedInputPrice);
    const baseCacheWritePriceUsdPerM = selectedPricing.cacheWritePrice == null
      ? null
      : new Prisma.Decimal(selectedPricing.cacheWritePrice);
    const baseOutputPriceUsdPerM = new Prisma.Decimal(selectedPricing.outputPricePerMToken);
    const baseCachedInputPriceUsdPerM = configuredCachedInputPriceUsdPerM
      ?? this.deriveCachedInputPrice(model, baseInputPriceUsdPerM);
    const inputPriceUsdPerM = this.applyPolicyPrice(
      baseInputPriceUsdPerM,
      policy,
      'inputPricePerMToken',
    );
    const outputPriceUsdPerM = this.applyPolicyPrice(
      baseOutputPriceUsdPerM,
      policy,
      'outputPricePerMToken',
    );
    const cachedInputPriceUsdPerM =
      baseCachedInputPriceUsdPerM == null && policy?.cachedInputPrice == null
        ? null
        : this.applyPolicyPrice(
          baseCachedInputPriceUsdPerM ?? baseInputPriceUsdPerM,
          policy,
          'cachedInputPrice',
        );
    const cacheWritePriceUsdPerM =
      baseCacheWritePriceUsdPerM == null && policy?.cacheWritePrice == null
        ? null
        : this.applyPolicyPrice(
          baseCacheWritePriceUsdPerM ?? baseInputPriceUsdPerM,
          policy,
          'cacheWritePrice',
        );
    const effectiveCachedInputPrice = cachedInputPriceUsdPerM ?? inputPriceUsdPerM;
    const effectiveCacheWritePrice = cacheWritePriceUsdPerM ?? inputPriceUsdPerM;
    const costUsd = new Prisma.Decimal(nonCachedInputTokens)
      .mul(inputPriceUsdPerM)
      .plus(new Prisma.Decimal(safeCachedInputTokens).mul(effectiveCachedInputPrice))
      .plus(new Prisma.Decimal(safeCacheWriteInputTokens).mul(effectiveCacheWritePrice))
      .plus(new Prisma.Decimal(safeCompletionTokens).mul(outputPriceUsdPerM))
      .div(1_000_000)
      .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);

    return {
      costUsd,
      pricingTierKey: selectedPricing.pricingTierKey,
      inputPriceUsdPerM,
      cachedInputPriceUsdPerM: effectiveCachedInputPrice,
      cacheWritePriceUsdPerM: effectiveCacheWritePrice,
      outputPriceUsdPerM,
    };
  }

  private selectPricingForTokens(
    pricing: PricingSnapshot,
    inputTokens: number,
    bandAt?: Date,
  ): SelectedPricingSnapshot {
    const tiers = pricing.priceTiers ?? [];
    // OFF_PEAK 时段档：必须先提取并从普通档集合中**永久排除**——它的 min=0/无上限
    // 区间否则会让峰时与不传 bandAt 的调用（转售/供应商成本/LIST 基线）也命中它。
    const offPeakTier = tiers.find((tier) => tier.tierKey === OFF_PEAK_TIER_KEY && tier.isActive !== false);
    if (offPeakTier && bandAt && isTokenPricingUnit(pricing.pricingUnit)) {
      // 读侧 fail-safe：缺失/[]/days:[]/非法结构 → null（不选时段档，按普通价计）。
      const schedule = parseBandScheduleSafely(offPeakTier.bandSchedule);
      if (!schedule) {
        this.logger.warn(
          `OFF_PEAK tier has invalid band_schedule, falling back to base pricing (modelPricingTier=${offPeakTier.tierKey})`,
        );
      } else if (resolveScheduleBand(bandAt, schedule) === 'OFF_PEAK') {
        return {
          pricingTierKey: OFF_PEAK_TIER_KEY,
          inputPricePerMToken: offPeakTier.inputPricePerMToken,
          outputPricePerMToken: offPeakTier.outputPricePerMToken,
          cachedInputPrice: offPeakTier.cachedInputPrice ?? null,
          cacheWritePrice: offPeakTier.cacheWritePrice ?? null,
        };
      }
    }
    const tier = this.selectExplicitTier(
      tiers.filter((candidate) => candidate.tierKey !== OFF_PEAK_TIER_KEY),
      inputTokens,
    );
    if (tier) {
      return {
        pricingTierKey: tier.tierKey,
        inputPricePerMToken: tier.inputPricePerMToken,
        outputPricePerMToken: tier.outputPricePerMToken,
        cachedInputPrice: tier.cachedInputPrice ?? null,
        cacheWritePrice: tier.cacheWritePrice ?? null,
      };
    }

    if (
      pricing.longContextThreshold != null
      && inputTokens >= pricing.longContextThreshold
      && (
        pricing.longContextInputPrice != null
        || pricing.longContextOutputPrice != null
      )
    ) {
      return {
        pricingTierKey: 'long_context',
        inputPricePerMToken: pricing.longContextInputPrice ?? pricing.inputPricePerMToken,
        outputPricePerMToken: pricing.longContextOutputPrice ?? pricing.outputPricePerMToken,
        cachedInputPrice: pricing.cachedInputPrice ?? null,
        cacheWritePrice: pricing.cacheWrite5minPrice ?? pricing.cacheWrite1hPrice ?? null,
      };
    }

    return {
      pricingTierKey: null,
      inputPricePerMToken: pricing.inputPricePerMToken,
      outputPricePerMToken: pricing.outputPricePerMToken,
      cachedInputPrice: pricing.cachedInputPrice ?? null,
      cacheWritePrice: pricing.cacheWrite5minPrice ?? pricing.cacheWrite1hPrice ?? null,
    };
  }

  private selectExplicitTier(
    tiers: PricingTierSnapshot[],
    inputTokens: number,
  ): PricingTierSnapshot | null {
    const matches = tiers.filter((tier) => {
      if (tier.isActive === false) return false;
      const min = Number(tier.minInputTokens ?? 0);
      const max = tier.maxInputTokensExclusive == null
        ? null
        : Number(tier.maxInputTokensExclusive);
      return inputTokens >= min && (max == null || inputTokens < max);
    });
    if (matches.length === 0) return null;
    matches.sort((a, b) => {
      const priorityDiff = Number(b.priority ?? 0) - Number(a.priority ?? 0);
      if (priorityDiff !== 0) return priorityDiff;
      return Number(b.minInputTokens ?? 0) - Number(a.minInputTokens ?? 0);
    });
    return matches[0] ?? null;
  }

  private async getPaygPolicy(
    productId: string,
    modelName: string,
    effectiveAt = new Date(),
    db?: Prisma.TransactionClient,
  ): Promise<PaygPolicySnapshot | null> {
    const policy = await (db ?? this.prisma).paygModelPricingPolicy.findFirst({
      where: {
        productId,
        modelName,
        isActive: true,
        startsAt: { lte: effectiveAt },
        OR: [
          { endsAt: null },
          { endsAt: { gt: effectiveAt } },
        ],
        product: {
          billingMode: 'PAY_AS_YOU_GO',
          isActive: true,
        },
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
    return policy ? this.toPaygPolicySnapshot(policy) : null;
  }

  private toPaygPolicySnapshot(policy: PaygPolicyRow): PaygPolicySnapshot {
    return {
      priceMultiplier: policy.priceMultiplier.toString(),
      inputPricePerMToken: policy.inputPricePerMToken?.toString() ?? null,
      cachedInputPrice: policy.cachedInputPrice?.toString() ?? null,
      cacheWritePrice: policy.cacheWritePrice?.toString() ?? null,
      outputPricePerMToken: policy.outputPricePerMToken?.toString() ?? null,
    };
  }

  /**
   * 按量定价只支持倍率：绝对覆盖价已废除（写侧已拒绝新写入）。
   *
   * 这里**不抛错**：`getPaygPolicy` 是按事件 `effectiveAt` 取策略的，延迟到达/重放的历史事件
   * 可能命中"当时有效、如今已结束"的历史覆盖价行——对这类事件必须**忠实重放当时的冻结语义**，
   * 否则会把历史请求推进人工隔离（`settlement_anchor_missing`）。
   * fail-closed 发生在**当前价格投影层**（`listPaygModelPricing` 的 activePolicy 投影）：
   * 那里检出仍在生效的脏覆盖价 ⇒ 不返回任何价格、`reason=LEGACY_OVERRIDE_DETECTED`（见设计稿 §1.5b）。
   */
  /** 覆盖价机制已废除：命中历史遗留值时统一留痕（每次报价最多一条），不改变报价结果。 */
  private warnOnLegacyPaygOverride(model: string, policy: PaygPolicySnapshot | null) {
    if (!policy) return;
    const fields = (
      ['inputPricePerMToken', 'cachedInputPrice', 'cacheWritePrice', 'outputPricePerMToken'] as const
    ).filter((field) => policy[field] != null);
    if (fields.length === 0) return;
    this.logger.warn(
      `PAYG legacy override price still present model=${model} fields=${fields.join(',')}; replaying frozen historical values`,
    );
  }

  private applyPolicyPrice(
    basePrice: Prisma.Decimal,
    policy: PaygPolicySnapshot | null,
    overrideKey: Exclude<keyof PaygPolicySnapshot, 'priceMultiplier'>,
  ): Prisma.Decimal {
    const override = policy?.[overrideKey];
    if (override != null) {
      return new Prisma.Decimal(override);
    }
    const multiplier = policy == null
      ? new Prisma.Decimal(1)
      : new Prisma.Decimal(policy.priceMultiplier ?? 1);
    return basePrice
      .mul(multiplier)
      .toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP);
  }

  private deriveCachedInputPrice(
    model: string,
    inputPriceUsdPerM: Prisma.Decimal,
  ): Prisma.Decimal | null {
    if (!this.usesGlmCacheReadDiscount(model)) {
      return null;
    }
    return inputPriceUsdPerM
      .mul(ModelPricingService.GLM_CACHE_READ_DISCOUNT)
      .toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP);
  }

  private usesGlmCacheReadDiscount(model: string): boolean {
    return model === 'glm-5' || model === 'glm-5-turbo';
  }

  async listActive(): Promise<
    Array<{
      modelName: string;
      inputPricePerMToken: number;
      outputPricePerMToken: number;
      cachedInputPrice?: number | null;
    }>
  > {
    const rows = await this.prisma.modelPricing.findMany({
      where: { isActive: true },
      orderBy: { modelName: 'asc' },
      select: {
        modelName: true,
        inputPricePerMToken: true,
        outputPricePerMToken: true,
        cachedInputPrice: true,
      },
    });
    return rows.map((row) => ({
      modelName: row.modelName,
      inputPricePerMToken: usdNumber(row.inputPricePerMToken),
      outputPricePerMToken: usdNumber(row.outputPricePerMToken),
      cachedInputPrice: row.cachedInputPrice == null ? null : usdNumber(row.cachedInputPrice),
    }));
  }

  async listPublic(): Promise<
    Array<{
      modelName: string;
      displayName: string;
      inputPricePerMToken: number;
      outputPricePerMToken: number;
      cachedInputPrice?: number | null;
    }>
  > {
    const rows = await this.prisma.modelPricing.findMany({
      where: { isActive: true, isPublished: true },
      orderBy: { modelName: 'asc' },
      select: {
        modelName: true,
        modelId: true,
        inputPricePerMToken: true,
        outputPricePerMToken: true,
        cachedInputPrice: true,
      },
    });
    return rows.map((row) => ({
      modelName: row.modelName,
      displayName: row.modelId?.trim() || row.modelName,
      inputPricePerMToken: usdNumber(row.inputPricePerMToken),
      outputPricePerMToken: usdNumber(row.outputPricePerMToken),
      cachedInputPrice: row.cachedInputPrice == null ? null : usdNumber(row.cachedInputPrice),
    }));
  }
}
