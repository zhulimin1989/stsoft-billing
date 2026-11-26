import { ForbiddenException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ModelPricingService } from './model-pricing.service';
import { creditMultiplierCacheKey } from '../common/utils/redis-key.util';

/**
 * 自营套餐未开放该模型（ModelAccess 缺失/停用）的确定性业务拒绝。带稳定 code 供：
 * ① 结算消费方判为「终结、不重试」并主动进 DLQ + 告警（不静默漏账）；② 审计/告警维度。
 * 继承 ForbiddenException 以保留原 403 语义。仅自营计价路径（requireModelAccess=true）抛出。
 */
export const MODEL_ACCESS_DENIED_CODE = 'MODEL_ACCESS_DENIED';
export class ModelAccessDeniedError extends ForbiddenException {
  readonly code = MODEL_ACCESS_DENIED_CODE;
  constructor(modelName: string) {
    super(`套餐未开放模型 "${modelName}"`);
  }
}

@Injectable()
export class CreditPricingService {
  private readonly logger = new Logger(CreditPricingService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly modelPricing: ModelPricingService,
  ) {}

  /**
   * 计算积分消耗（SaaS 预估扣费用）
   *
   * 公式：ceil(((inputTokens-cachedInputTokens) × inPriceUsdPerM
   *       + cachedInputTokens × cachedInputPriceUsdPerM
   *       + outputTokens × outPriceUsdPerM) / 1_000_000 × 100
   *       × creditMultiplier × usageMultiplier)
   * cachedInputPrice 未配置时，缓存命中 input 按普通 input 价兜底，避免免费漏扣。
   *
   * @throws NotFoundException 当 ModelPricing 找不到该模型
   */
  async calculateCreditCost(
    planId: string,
    modelName: string,
    inputTokens: number,
    outputTokens: number,
    usageMultiplier: number,
    cachedInputTokens = 0,
    options: {
      requireModelAccess?: boolean;
      imageCount?: number;
      cacheWriteInputTokens?: number;
      bandAt?: Date;
      /** 事件发生时刻；透传给 calculateCreditCostQuote 用于按当时的定价版本取价。 */
      effectiveAt?: Date;
    } = {},
  ): Promise<number> {
    // 兼容包装：保留既有"全零用量在定价与 ModelAccess 校验之前直接返回 0"的短路语义
    // （calculateCreditCostQuote 对全零同样短路，因此直接委托行为逐位不变）。
    const quote = await this.calculateCreditCostQuote(
      planId,
      modelName,
      inputTokens,
      outputTokens,
      usageMultiplier,
      cachedInputTokens,
      options,
    );
    return quote.creditCost;
  }

  /**
   * 结构化积分报价：一次调用同时产出积分与选中的价格档（pricingTierKey）。
   * 内部只调一次 calculateCostQuote —— 积分与 tierKey 必然来自同一定价快照
   * （禁止调用方为拿 tierKey 再独立调一次定价：缓存失效/配置更新竞态下会取到不同快照）。
   *
   * 全零用量（input=output=imageCount=0）不进定价、不触发 ModelAccess 校验，
   * 返回 { creditCost: 0, pricingTierKey: null }（与"未计价"事实一致）。
   *
   * options.bandAt：时段价格档（OFF_PEAK）的判定时刻，由 strategy 统一冻结后传入。
   * options.cacheWriteInputTokens：与锚定结算（strategy :1193）对齐——四价时段档下
   * "同输入预览=结算"要求 cache-write 维度也一致（历史实现固定传 0）。
   */
  async calculateCreditCostQuote(
    planId: string,
    modelName: string,
    inputTokens: number,
    outputTokens: number,
    usageMultiplier: number,
    cachedInputTokens = 0,
    options: {
      requireModelAccess?: boolean;
      imageCount?: number;
      cacheWriteInputTokens?: number;
      bandAt?: Date;
      /**
       * 事件发生时刻，用于按结算取价窗口取"当时的基础价"。与 bandAt 是两回事：
       * bandAt 选的是周内 OFF_PEAK 时段档，effectiveAt 选的是定价版本。
       * 不传就按"当前价"取 —— 那样模型一下架，尚未结算的积分链路事件立刻报不出价，
       * 而余额链路（strategy 已传 effectiveAt）却仍能重放，两条链在价格切换点分叉。
       */
      effectiveAt?: Date;
    } = {},
  ): Promise<{ creditCost: number; pricingTierKey: string | null }> {
    const safeInputTokens = Math.max(0, inputTokens);
    const safeOutputTokens = Math.max(0, outputTokens);
    const safeCachedInputTokens = Math.min(Math.max(0, cachedInputTokens), safeInputTokens);
    const safeCacheWriteInputTokens = Math.min(
      Math.max(0, options.cacheWriteInputTokens ?? 0),
      safeInputTokens - safeCachedInputTokens,
    );
    const safeImageCount = Math.max(0, Math.floor(Number(options.imageCount) || 0));
    if (safeInputTokens === 0 && safeOutputTokens === 0 && safeImageCount === 0) {
      return { creditCost: 0, pricingTierKey: null };
    }

    // 1. 查定价并让 ModelPricingService 统一处理价格档、缓存价、长上下文 fallback。
    let pricingQuote: Awaited<ReturnType<ModelPricingService['calculateCostQuote']>>;
    try {
      pricingQuote = await this.modelPricing.calculateCostQuote(
        modelName,
        safeInputTokens,
        safeOutputTokens,
        safeCachedInputTokens,
        safeCacheWriteInputTokens,
        {
          ...(safeImageCount > 0 ? { imageCount: safeImageCount } : {}),
          ...(options.bandAt ? { bandAt: options.bandAt } : {}),
          ...(options.effectiveAt ? { effectiveAt: options.effectiveAt } : {}),
        },
      );
    } catch (err) {
      if (err instanceof NotFoundException) {
        // 业务数据缺失（模型未配定价），用 warn 级别避免淹没真正的系统错误
        this.logger.warn(
          `MODEL_PRICING_NOT_FOUND: planId=${planId} modelName=${modelName}`,
        );
      }
      throw err;
    }

    if (!pricingQuote) {
      this.logger.warn(
        `MODEL_PRICING_NOT_FOUND: planId=${planId} modelName=${modelName}`,
      );
      throw new NotFoundException(`模型 "${modelName}" 暂未开放计价`);
    }

    const creditCost = await this.calculateCreditCostFromUsd(
      planId,
      modelName,
      pricingQuote.costUsd,
      usageMultiplier,
      options.requireModelAccess === true,
    );
    return { creditCost, pricingTierKey: pricingQuote.pricingTierKey ?? null };
  }

  private async calculateCreditCostFromUsd(
    planId: string,
    modelName: string,
    costUsd: Prisma.Decimal,
    usageMultiplier: number,
    requireModelAccess: boolean,
  ): Promise<number> {
    // 2. 查 plan 级 creditMultiplier（有独立 Redis 缓存）
    const creditMultiplier = await this.getCreditMultiplier(
      planId,
      modelName,
      requireModelAccess,
    );

    // 3. 统一按底层 USD 金额换算积分；token 和 image 共享同一倍率链。
    const total = costUsd
      .mul(100)
      .mul(creditMultiplier)
      .mul(usageMultiplier);

    return total.ceil().toNumber();
  }

  private async getCreditMultiplier(
    planId: string,
    modelName: string,
    requireModelAccess: boolean,
  ): Promise<number> {
    const cacheKey = creditMultiplierCacheKey(planId, modelName);
    if (!requireModelAccess) {
      const cached = await this.redis.get(cacheKey);
      if (cached) return parseFloat(cached);
    }

    const access = await this.prisma.modelAccess.findUnique({
      where: { planId_modelName: { planId, modelName } },
    });
    if (requireModelAccess && (!access || access.isActive === false)) {
      throw new ModelAccessDeniedError(modelName);
    }
    // 兼容历史订阅产品：access 为 null 或已关闭时 fallback 到 1.0；
    // access.creditMultiplier = 0 是合法业务配置（该套餐对该模型免费），按 0 处理
    const multiplier = access?.isActive === false ? 1.0 : access?.creditMultiplier ?? 1.0;
    await this.redis.set(cacheKey, multiplier.toString(), 'EX', 3600);
    return multiplier;
  }
}
