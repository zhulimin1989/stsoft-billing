import { BadRequestException, Injectable, Optional } from '@nestjs/common';
import { BillingService } from './billing.service';
import { BoosterPackService } from './booster-pack.service';
import { resolvePlanPeriodMonthlyEquivalentCents } from './plan-pricing.util';
import { resolvePlatformCurrency } from './platform-currency';
import { ProductService } from './product.service';
import { SystemConfigService } from './system-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { parseModelConfigs } from '../channel/model-configs';

export type ProductPortalProductInput = {
  productId?: unknown;
  productSlug?: unknown;
};

export type ProductPortalProductRef = {
  id: string;
  slug: string;
  record: unknown;
};

@Injectable()
export class ProductPortalCatalogService {
  constructor(
    private readonly billingService: BillingService,
    private readonly productService: ProductService,
    private readonly boosterPackService: BoosterPackService,
    private readonly prisma: PrismaService,
    @Optional() private readonly systemConfig?: SystemConfigService,
  ) {}

  async resolveProduct(input: ProductPortalProductInput): Promise<ProductPortalProductRef> {
    const productId = this.optionalString(input.productId);
    const productSlug = this.optionalString(input.productSlug);
    if (!productId && !productSlug) {
      throw new BadRequestException('productId or productSlug is required');
    }

    const product = productId
      ? await this.productService.findById(productId)
      : await this.productService.findBySlug(productSlug!);
    if (!product) {
      throw new BadRequestException('产品不存在');
    }
    const record = product as Record<string, unknown>;
    if (productId && record.id !== productId) {
      throw new BadRequestException('产品不存在');
    }
    if (productSlug && String(record.slug).toLowerCase() !== productSlug.toLowerCase()) {
      throw new BadRequestException('产品不存在');
    }
    if (record.isActive === false) {
      throw new BadRequestException('产品未启用');
    }

    return {
      id: String(record.id),
      slug: String(record.slug),
      record: this.publicProduct(record),
    };
  }

  async getPlans(product: ProductPortalProductRef): Promise<unknown> {
    const plans = await this.billingService.getPlans(product.id);
    const platformConfig = await this.systemConfig?.getDeploymentConfig();
    const currency = resolvePlatformCurrency(undefined, platformConfig).currency;
    const prices = plans.length === 0
      ? []
      : await this.prisma.planPrice.findMany({
          where: {
            planId: { in: plans.map((plan) => plan.id) },
            currency,
            isActive: true,
          },
          select: {
            planId: true,
            monthlyPrice: true,
            quarterlyPrice: true,
            yearlyPrice: true,
          },
        });
    const priceByPlanId = new Map(prices.map((price) => [price.planId, price]));

    return plans.map((plan) => ({
      id: plan.id,
      productId: plan.productId,
      currency,
      name: plan.name,
      description: plan.description,
      planType: plan.planType,
      monthlyPrice: resolvePlanPeriodMonthlyEquivalentCents(
        'monthly',
        priceByPlanId.get(plan.id),
        plan,
        currency,
        currency,
      ),
      quarterlyPrice: resolvePlanPeriodMonthlyEquivalentCents(
        'quarterly',
        priceByPlanId.get(plan.id),
        plan,
        currency,
        currency,
      ),
      yearlyPrice: resolvePlanPeriodMonthlyEquivalentCents(
        'yearly',
        priceByPlanId.get(plan.id),
        plan,
        currency,
        currency,
      ),
      billingPeriod: plan.billingPeriod,
      monthlyCredits: plan.monthlyCredits,
      creditsRollover: plan.creditsRollover,
      rolloverMaxMonths: plan.rolloverMaxMonths,
      rateLimitRpm: plan.rateLimitRpm,
      rateLimitTpm: plan.rateLimitTpm,
      maxContextWindow: plan.maxContextWindow,
      ...(plan.quotaRules ? { quotaRules: plan.quotaRules } : {}),
      overageEnabled: plan.overageEnabled,
      usageMultiplier: plan.usageMultiplier,
      memberLimit: plan.memberLimit,
      minimumSeats: plan.minimumSeats,
      dataTraining: plan.dataTraining,
      supportTier: plan.supportTier,
      ssoEnabled: plan.ssoEnabled,
      priorityAccess: plan.priorityAccess,
      badge: plan.badge,
      trialDays: plan.trialDays,
      validityDays: plan.validityDays,
      features: plan.features,
      isActive: plan.isActive,
      isLegacy: plan.isLegacy,
      soldOut: plan.soldOut ?? false,
      sortOrder: plan.sortOrder,
      createdAt: plan.createdAt,
      updatedAt: plan.updatedAt,
    }));
  }

  async getCatalog(product: ProductPortalProductRef): Promise<unknown> {
    const modelSurface = await this.getProductModelSurface(product);
    const [
      products,
      plans,
      boosterPacks,
      modelAccess,
      modelRoutePolicies,
    ] = await Promise.all([
      Promise.resolve(this.getProducts(product)),
      this.getPlans(product),
      this.getBoosterPacks(product),
      this.getModelAccessForVisibleModels(product, modelSurface.visibleModelNames),
      this.getModelRoutePoliciesForVisibleModels(product, modelSurface.visibleModelNames),
    ]);
    return {
      products,
      plans,
      boosterPacks,
      models: modelSurface.models,
      modelAccess,
      modelRoutePolicies,
      channels: modelSurface.channels,
    };
  }

  getProducts(product: ProductPortalProductRef): unknown {
    return [product.record];
  }

  async getBoosterPacks(product: ProductPortalProductRef): Promise<unknown> {
    const packs = await this.boosterPackService.findAll(true, product.id);
    return packs.map((pack) => ({
      id: pack.id,
      productId: pack.productId,
      name: pack.name,
      description: pack.description,
      creditsAmount: pack.creditsAmount,
      priceCents: pack.priceCents,
      expiryDays: pack.expiryDays,
      isActive: pack.isActive,
      sortOrder: pack.sortOrder,
    }));
  }

  async getModels(product: ProductPortalProductRef): Promise<{
    models: { id: string; displayName: string; provider: string; modelType?: string | null }[];
  }> {
    return (await this.getProductModelSurface(product)).models;
  }

  async getModelAccess(product: ProductPortalProductRef): Promise<unknown> {
    const surface = await this.getProductModelSurface(product);
    return this.getModelAccessForVisibleModels(product, surface.visibleModelNames);
  }

  private async getModelAccessForVisibleModels(
    product: ProductPortalProductRef,
    visibleModelNames: ReadonlySet<string>,
  ): Promise<unknown> {
    if (visibleModelNames.size === 0) {
      return { items: [] };
    }

    const plans = await this.prisma.plan.findMany({
      where: { productId: product.id, isActive: true, deletedAt: null },
      select: { id: true },
    });
    const planIds = plans.map((plan) => plan.id);
    if (planIds.length === 0) {
      return { items: [] };
    }

    const accesses = await this.prisma.modelAccess.findMany({
      where: {
        planId: { in: planIds },
        modelName: { in: Array.from(visibleModelNames) },
        isActive: true,
      },
    });
    return {
      items: accesses.map((access) => ({
        planId: access.planId,
        modelName: access.modelName,
        isActive: access.isActive,
        creditMultiplier: access.creditMultiplier,
      })),
    };
  }

  async getModelRoutePolicies(product: ProductPortalProductRef): Promise<unknown> {
    const surface = await this.getProductModelSurface(product);
    return this.getModelRoutePoliciesForVisibleModels(product, surface.visibleModelNames);
  }

  private async getModelRoutePoliciesForVisibleModels(
    product: ProductPortalProductRef,
    visibleModelNames: ReadonlySet<string>,
  ): Promise<unknown> {
    if (visibleModelNames.size === 0) {
      return { items: [] };
    }

    const plans = await this.prisma.plan.findMany({
      where: { productId: product.id, isActive: true, deletedAt: null },
      select: { id: true },
    });
    const planIds = plans.map((plan) => plan.id);
    if (planIds.length === 0) {
      return { items: [] };
    }

    const policies = await this.prisma.modelRoutePolicy.findMany({
      where: {
        planId: { in: planIds },
        primaryModel: { in: Array.from(visibleModelNames) },
        isActive: true,
      },
    });
    return {
      items: policies.map((policy) => ({
        planId: policy.planId,
        routeKey: policy.routeKey,
        primaryModel: policy.primaryModel,
        fallbackModels: this.parseJsonStringArray(policy.fallbackModels)
          .filter((modelName) => visibleModelNames.has(modelName)),
        isActive: policy.isActive,
      })),
    };
  }

  async getChannels(product: ProductPortalProductRef): Promise<unknown> {
    return (await this.getProductModelSurface(product)).channels;
  }

  private async getProductModelSurface(product: ProductPortalProductRef): Promise<{
    models: {
      models: { id: string; displayName: string; provider: string; modelType?: string | null }[];
    };
    channels: { items: unknown[] };
    visibleModelNames: ReadonlySet<string>;
  }> {
    const productChannels = await this.prisma.productChannel.findMany({
      where: {
        productId: product.id,
        status: 'active',
        deletedAt: null,
        channel: {
          isActive: true,
          status: 'active',
          deletedAt: null,
        },
      },
      orderBy: [
        { isDefault: 'desc' },
        { priority: 'asc' },
        { weight: 'desc' },
        { createdAt: 'asc' },
      ],
      select: {
        id: true,
        displayName: true,
        isDefault: true,
        allowedModels: true,
        deniedModels: true,
        channel: {
          select: {
            provider: true,
            models: true,
            modelConfigs: true,
            sdkType: true,
          },
        },
      },
    });

    const effectiveChannels = productChannels.map((productChannel) => {
      const allowedModels = this.parseJsonValueStringArray(productChannel.allowedModels);
      const deniedModels = new Set(this.parseJsonValueStringArray(productChannel.deniedModels));
      const physicalModels = this.parseChannelModelList(productChannel.channel.models);
      const configs = parseModelConfigs(productChannel.channel.modelConfigs);
      const sourceModels = allowedModels.length > 0 ? allowedModels : physicalModels;
      const models = Array.from(new Set(sourceModels))
        .filter((model) => physicalModels.includes(model))
        .filter((model) => !deniedModels.has(model))
        .filter((model) => configs?.[model]?.enabled !== false)
        .sort();
      return { productChannel, models };
    });

    const candidateNames = Array.from(
      new Set(effectiveChannels.flatMap(({ models }) => models)),
    );
    if (candidateNames.length === 0) {
      return {
        models: { models: [] },
        channels: { items: [] },
        visibleModelNames: new Set(),
      };
    }

    const isPayg = (product.record as { billingMode?: unknown }).billingMode === 'PAY_AS_YOU_GO';
    const now = new Date();
    const [pricings, paygAvailabilities] = await Promise.all([
      this.prisma.modelPricing.findMany({
        where: {
          modelName: { in: candidateNames },
          isActive: true,
          isPublished: true,
        },
        orderBy: [{ displayOrder: 'asc' }, { modelName: 'asc' }],
        select: {
          modelName: true,
          modelId: true,
          provider: true,
          modelType: true,
          contextLength: true,
          maxOutputTokens: true,
          defaultThinkingMode: true,
          defaultThinkingBudget: true,
        },
      }),
      isPayg
        ? this.prisma.productModelAvailability.findMany({
            where: {
              productId: product.id,
              modelName: { in: candidateNames },
              status: 'ACTIVE',
              apiEnabled: true,
              visible: true,
              AND: [
                { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
                { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
              ],
            },
            select: { modelName: true },
          })
        : Promise.resolve([]),
    ]);

    const pricingByName = new Map(pricings.map((pricing) => [pricing.modelName, pricing]));
    const paygModelNames = new Set(paygAvailabilities.map((row) => row.modelName));
    const visibleModelNames = new Set(
      candidateNames.filter((modelName) =>
        pricingByName.has(modelName) && (!isPayg || paygModelNames.has(modelName))),
    );

    const channels = effectiveChannels
      .map(({ productChannel, models }) => {
        const visibleModels = models.filter((modelName) => visibleModelNames.has(modelName));
        const modelsDict: Record<string, Record<string, unknown>> = {};
        for (const modelName of visibleModels) {
          const pricing = pricingByName.get(modelName);
          if (!pricing) continue;
          modelsDict[modelName] = this.publicModelCapabilities(pricing);
        }
        return {
          id: productChannel.id,
          name: productChannel.displayName || productChannel.channel.provider,
          provider: productChannel.channel.provider,
          runtime: 'gateway',
          models: modelsDict,
          sdkType: productChannel.channel.sdkType,
          isDefault: productChannel.isDefault,
        };
      })
      .filter((channel) => Object.keys(channel.models).length > 0);

    const orderedPricings = pricings.filter((pricing) => visibleModelNames.has(pricing.modelName));
    return {
      models: {
        models: orderedPricings.map((pricing) => ({
          id: pricing.modelName,
          displayName: pricing.modelId?.trim() || pricing.modelName,
          provider: pricing.provider || 'unknown',
          modelType: pricing.modelType ?? null,
        })),
      },
      channels: { items: channels },
      visibleModelNames,
    };
  }

  private publicModelCapabilities(pricing: {
    contextLength?: number | null;
    maxOutputTokens?: number | null;
    defaultThinkingMode?: string | null;
    defaultThinkingBudget?: number | null;
  }): Record<string, unknown> {
    const capabilities: Record<string, unknown> = {};
    if (typeof pricing.contextLength === 'number') {
      capabilities.context_window = pricing.contextLength;
    }
    if (typeof pricing.maxOutputTokens === 'number') {
      capabilities.max_output_tokens = pricing.maxOutputTokens;
    }
    if (pricing.defaultThinkingMode === 'enabled' || pricing.defaultThinkingMode === 'auto') {
      capabilities.supports_thinking = true;
    } else if (pricing.defaultThinkingMode === 'disabled') {
      capabilities.supports_thinking = false;
    }
    if (
      typeof pricing.defaultThinkingBudget === 'number'
      && pricing.defaultThinkingBudget > 0
    ) {
      capabilities.thinking_budget_tokens = pricing.defaultThinkingBudget;
      if (capabilities.supports_thinking !== false) {
        capabilities.supports_thinking = true;
      }
    }
    return capabilities;
  }

  private parseChannelModelList(rawModels: string | null | undefined): string[] {
    if (!rawModels) return [];
    try {
      const parsed = JSON.parse(rawModels);
      if (Array.isArray(parsed)) {
        return parsed.filter((model): model is string => typeof model === 'string' && model !== '*');
      }
      if (parsed && typeof parsed === 'object') {
        return Object.keys(parsed).filter((model) => model && model !== '*');
      }
    } catch {
      const model = rawModels.trim();
      return model && model !== '*' ? [model] : [];
    }
    return [];
  }

  private parseJsonStringArray(value: string | null): string[] {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed) ? parsed.filter((item): item is string => typeof item === 'string') : [];
    } catch {
      return [];
    }
  }

  private parseJsonValueStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is string => typeof item === 'string' && item.length > 0);
  }

  private publicProduct(product: Record<string, unknown>): Record<string, unknown> {
    return {
      id: product.id,
      slug: product.slug,
      name: product.name,
      description: product.description,
      icon: product.icon,
      billingMode: product.billingMode,
      codingPlanFulfillmentMode: product.codingPlanFulfillmentMode,
      fulfillmentMode: product.fulfillmentMode,
      defaultPlanId: product.defaultPlanId,
      isActive: product.isActive,
      sortOrder: product.sortOrder,
      createdAt: product.createdAt,
      updatedAt: product.updatedAt,
    };
  }

  private optionalString(value: unknown): string | undefined {
    if (typeof value !== 'string') return undefined;
    const trimmed = value.trim();
    return trimmed || undefined;
  }
}
