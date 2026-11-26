import {
  Injectable,
  Logger,
  BadRequestException,
  NotFoundException,
} from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { CampaignRepository } from './campaign.repository';
import { StripeCouponSyncService } from './stripe-coupon-sync.service';
import { resolvePlanPeriodMonthlyEquivalentCents } from '../billing/plan-pricing.util';
import { CodingPlanFulfillmentMode } from '@prisma/client';
import type { BillingPeriod } from '@ruidong/shared';

type CampaignBillingPeriod = BillingPeriod | 'both' | 'all';

const PERIOD_MULTIPLIER: Record<BillingPeriod, number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

function selectPeriodMonthlyPrice(
  price: { monthlyPrice?: number; quarterlyPrice?: number; yearlyPrice?: number } | null | undefined,
  period: BillingPeriod,
): number | null {
  if (!price) return null;
  if (period === 'yearly') return price.yearlyPrice ?? null;
  if (period === 'quarterly') return price.quarterlyPrice ?? null;
  return price.monthlyPrice ?? null;
}

export interface CampaignPriceInput {
  currency: string;          // 'usd' | 'sgd' | ...
  monthlyPrice: number;      // cents，活动月付价
  quarterlyPrice?: number;   // cents，活动季付的月均价
  yearlyPrice: number;       // cents，活动年付的月均价
}

export interface CreateCampaignInput {
  productId?: string | null;
  planId: string;            // 本期强制 planId — 活动必须绑 plan
  name: string;
  description?: string;
  scope: 'all' | 'new_users' | 'old_users';
  firstTimeOnly?: boolean;
  billingPeriod: CampaignBillingPeriod;
  startAt: Date | string;
  endAt: Date | string;
  maxUsesPerUser?: number;
  maxUsesTotal?: number;
  priority?: number;
  prices: CampaignPriceInput[]; // 至少一个币种
}

export interface UpdateCampaignInput extends Partial<CreateCampaignInput> {
  isActive?: boolean;
}

/**
 * 解析折扣的结构化结果。
 * 算法：最终价 = min(原价, 命中活动价, 原价-码折扣)
 */
export interface CampaignHit {
  campaign: {
    id: string;
    name: string;
    scope: string;
    billingPeriod: string;
    stripeCouponId: string | null;
  };
  originalAmountCents: number;  // 对应 billingPeriod 的完整原价（年付已 ×12）
  campaignAmountCents: number;  // 活动价（年付已 ×12）
  amountSavedCents: number;
}

/** benefits 展示用：某 plan 某周期命中的活动定价（总价 + 月均；仅 Stripe Coupon 就绪的命中）。 */
export interface PlanPromotionHit {
  campaignId: string;
  campaignName: string;
  originalTotalCents: number;
  campaignTotalCents: number;
  originalMonthlyEquivCents: number;
  campaignMonthlyEquivCents: number;
}
/** planId → { period → 命中活动定价 }。 */
export type PlanPromotions = Record<string, Partial<Record<BillingPeriod, PlanPromotionHit>>>;

const PROMO_PERIODS: BillingPeriod[] = ['monthly', 'quarterly', 'yearly'];

@Injectable()
export class CampaignService {
  private readonly logger = new Logger(CampaignService.name);

  constructor(
    private readonly repo: CampaignRepository,
    private readonly prisma: PrismaService,
    private readonly stripeCouponSync: StripeCouponSyncService,
  ) {}

  // ================================================
  // CRUD（管理端调用）
  // ================================================

  async create(input: CreateCampaignInput) {
    this.validatePrices(input.prices);
    if (!input.planId) throw new BadRequestException('planId 必填');

    const plan = await this.prisma.plan.findUnique({
      where: { id: input.planId },
      include: { prices: true },
    });
    if (!plan) throw new NotFoundException('套餐不存在');

    // 1) 先创建 Campaign（stripe_coupon_ids 暂空）
    const created = await this.repo.create(
      {
        name: input.name,
        description: input.description ?? '',
        scope: input.scope,
        firstTimeOnly: input.firstTimeOnly ?? false,
        billingPeriod: input.billingPeriod,
        startAt: new Date(input.startAt),
        endAt: new Date(input.endAt),
        maxUsesPerUser: input.maxUsesPerUser ?? 1,
        maxUsesTotal: input.maxUsesTotal ?? 0,
        priority: input.priority ?? 0,
        isActive: true,
        plan: { connect: { id: input.planId } },
        ...(input.productId ? { product: { connect: { id: input.productId } } } : {}),
      },
      input.prices.map((p) => ({ ...p, currency: p.currency.toLowerCase() })),
    );

    // 2) 为每个 (currency, period) 创建 Stripe Coupon。失败抛错，让 controller 返回 500
    //    (由于已落库，上层需要用户手工删或我们做补偿——简单起见：失败直接禁用并 rethrow)
    try {
      const couponMap = await this.syncStripeCouponsForCampaign(created.id, plan, input);
      return await this.repo.update(created.id, {
        stripeCouponIdsJson: JSON.stringify(couponMap),
      });
    } catch (err) {
      this.logger.error(`Campaign ${created.id} Stripe Coupon 创建失败，禁用: ${err}`);
      await this.repo.update(created.id, { isActive: false });
      throw err;
    }
  }

  async update(id: string, input: UpdateCampaignInput) {
    const existing = await this.repo.findById(id);
    if (!existing) throw new NotFoundException('活动不存在');

    const priceChanged = input.prices && input.prices.length > 0;
    if (priceChanged) {
      this.validatePrices(input.prices!);
      await this.repo.replacePrices(
        id,
        input.prices!.map((p) => ({ ...p, currency: p.currency.toLowerCase() })),
      );
    }

    const data: any = {};
    if (input.name !== undefined) data.name = input.name;
    if (input.description !== undefined) data.description = input.description;
    if (input.scope !== undefined) data.scope = input.scope;
    if (input.firstTimeOnly !== undefined) data.firstTimeOnly = input.firstTimeOnly;
    if (input.billingPeriod !== undefined) data.billingPeriod = input.billingPeriod;
    if (input.startAt !== undefined) data.startAt = new Date(input.startAt);
    if (input.endAt !== undefined) data.endAt = new Date(input.endAt);
    if (input.maxUsesPerUser !== undefined) data.maxUsesPerUser = input.maxUsesPerUser;
    if (input.maxUsesTotal !== undefined) data.maxUsesTotal = input.maxUsesTotal;
    if (input.priority !== undefined) data.priority = input.priority;
    if (input.isActive !== undefined) data.isActive = input.isActive;

    // 价格变了 or billingPeriod 变了 → 必须重建 coupon（Stripe coupon 不可改金额）
    const needsCouponResync =
      priceChanged ||
      input.billingPeriod !== undefined ||
      (input.isActive === false && existing.stripeCouponIdsJson !== '{}');

    if (needsCouponResync) {
      const oldCouponMap = this.parseCouponMap(existing.stripeCouponIdsJson);
      await this.stripeCouponSync.archiveCouponsMap(oldCouponMap);
      data.stripeCouponIdsJson = '{}';
    }

    const updated = await this.repo.update(id, data);

    // 如果还在 active 状态，重新建 coupon
    if (needsCouponResync && updated.isActive) {
      const plan = await this.prisma.plan.findUnique({
        where: { id: updated.planId! },
        include: { prices: true },
      });
      if (!plan) throw new NotFoundException('套餐不存在');
      const merged: CreateCampaignInput = {
        planId: updated.planId!,
        name: updated.name,
        scope: updated.scope as any,
        billingPeriod: updated.billingPeriod as any,
        startAt: updated.startAt,
        endAt: updated.endAt,
        prices: (input.prices ?? (await this.repo.findById(id))!.prices) as any,
      };
      const couponMap = await this.syncStripeCouponsForCampaign(id, plan, merged);
      return this.repo.update(id, { stripeCouponIdsJson: JSON.stringify(couponMap) });
    }

    return updated;
  }

  async disable(id: string) {
    const existing = await this.repo.findById(id);
    if (!existing) throw new NotFoundException('活动不存在');
    const couponMap = this.parseCouponMap(existing.stripeCouponIdsJson);
    await this.stripeCouponSync.archiveCouponsMap(couponMap);
    return this.repo.update(id, {
      isActive: false,
      stripeCouponIdsJson: '{}',
    });
  }

  async findById(id: string) {
    const c = await this.repo.findById(id);
    if (!c) throw new NotFoundException('活动不存在');
    return c;
  }

  async findAll(filters: { planId?: string; productId?: string; isActive?: boolean }) {
    return this.repo.findAll(filters);
  }

  async stats(id: string) {
    const uses = await this.repo.countRedemptions(id);
    const saved = await this.repo.sumSaved(id);
    return { uses, amountSavedCents: saved };
  }

  // ================================================
  // 运行时折扣匹配（PaymentService 调用）
  // ================================================

  /**
   * 返回用户当前命中的"最便宜"活动（已考虑 scope / firstTimeOnly / 限次）。
   * originalAmountCents 使用调用方传入的"用户实际要支付的整单原价"（年付已 ×12）。
   */
  async findBestActiveCampaign(params: {
    planId: string;
    currency: string;
    billingPeriod: BillingPeriod;
    userId: string;
    originalAmountCents: number;
    isNewUser: boolean;
    userHasPlanHistory: boolean;  // 是否曾经订阅过这个 plan（firstTimeOnly 用）
  }): Promise<CampaignHit | null> {
    const candidates = await this.repo.findCandidates({
      planId: params.planId,
      billingPeriod: params.billingPeriod,
      currency: params.currency,
    });

    let best: CampaignHit | null = null;

    for (const c of candidates) {
      if (!this.matchScope(c.scope, params.isNewUser)) continue;
      if (c.firstTimeOnly && params.userHasPlanHistory) continue;

      // 限次：maxUsesPerUser
      if (c.maxUsesPerUser > 0) {
        const used = await this.repo.countRedemptions(c.id, params.userId);
        if (used >= c.maxUsesPerUser) continue;
      }
      // 限次：maxUsesTotal
      if (c.maxUsesTotal > 0) {
        const totalUsed = await this.repo.countRedemptions(c.id);
        if (totalUsed >= c.maxUsesTotal) continue;
      }

      // 取该币种的活动价
      const price = c.prices?.[0];
      if (!price) continue;
      const monthly = selectPeriodMonthlyPrice(price, params.billingPeriod);
      if (monthly == null || monthly <= 0) continue;

      const campaignTotal = monthly * PERIOD_MULTIPLIER[params.billingPeriod];

      // 活动价必须比原价便宜
      if (campaignTotal >= params.originalAmountCents) continue;

      const couponMap = this.parseCouponMap(c.stripeCouponIdsJson);
      const stripeCouponId =
        couponMap[`${params.currency.toLowerCase()}:${params.billingPeriod}`] || null;

      const hit: CampaignHit = {
        campaign: {
          id: c.id,
          name: c.name,
          scope: c.scope,
          billingPeriod: c.billingPeriod,
          stripeCouponId,
        },
        originalAmountCents: params.originalAmountCents,
        campaignAmountCents: campaignTotal,
        amountSavedCents: params.originalAmountCents - campaignTotal,
      };

      if (!best || hit.campaignAmountCents < best.campaignAmountCents) {
        best = hit;
      }
    }

    return best;
  }

  /** 仅用于前端预览：不用 userId 精确匹配（用于 tiers 价格展示） */
  async previewActiveCampaigns(params: {
    planId: string;
    currency: string;
    billingPeriod: BillingPeriod;
    isNewUser: boolean;
  }): Promise<CampaignHit | null> {
    const candidates = await this.repo.findCandidates({
      planId: params.planId,
      billingPeriod: params.billingPeriod,
      currency: params.currency,
    });

    // 计算 plan 的原价作为对照
    const plan = await this.prisma.plan.findUnique({
      where: { id: params.planId },
      include: { prices: { where: { currency: params.currency.toLowerCase() } } },
    });
    if (!plan) return null;

    const basePrice = plan.prices?.[0];
    const monthly = selectPeriodMonthlyPrice(basePrice, params.billingPeriod);
    if (monthly == null || monthly <= 0) return null;
    const originalTotal = monthly * PERIOD_MULTIPLIER[params.billingPeriod];

    let best: CampaignHit | null = null;
    for (const c of candidates) {
      if (!this.matchScope(c.scope, params.isNewUser)) continue;
      const price = c.prices?.[0];
      if (!price) continue;
      const m = selectPeriodMonthlyPrice(price, params.billingPeriod);
      if (m == null || m <= 0) continue;
      const campaignTotal = m * PERIOD_MULTIPLIER[params.billingPeriod];
      if (campaignTotal >= originalTotal) continue;

      const couponMap = this.parseCouponMap(c.stripeCouponIdsJson);
      const hit: CampaignHit = {
        campaign: {
          id: c.id,
          name: c.name,
          scope: c.scope,
          billingPeriod: c.billingPeriod,
          stripeCouponId:
            couponMap[`${params.currency.toLowerCase()}:${params.billingPeriod}`] || null,
        },
        originalAmountCents: originalTotal,
        campaignAmountCents: campaignTotal,
        amountSavedCents: originalTotal - campaignTotal,
      };
      if (!best || hit.campaignAmountCents < best.campaignAmountCents) best = hit;
    }
    return best;
  }

  /**
   * benefits 展示用（已登录）：返回产品下各 plan × 各周期 命中的最优活动定价。
   * - 复用 findBestActiveCampaign（per-user：scope/firstTimeOnly/限次，与下单同口径）；
   * - 原价用 resolvePlanPeriodMonthlyEquivalentCents（plan_prices→Plan 回退，与下单同源）；
   * - **仅返回 Stripe Coupon 就绪（stripeCouponId 非空）的命中**——避免展示活动但 Stripe 下不了单；
   * - 不承诺等于最终应付价（下单还有 A/B/C 取最便宜 + 优惠码 + proration）。
   */
  async getPlanPromotions(params: {
    productId: string;
    currency: string;
    userId: string;
    platformCurrency: string;
  }): Promise<PlanPromotions> {
    const currency = params.currency.toLowerCase();

    // 自营护栏：仅自营 CODING_PLAN（platform_model_package）产品展示活动价；
    // 转售(provider_resale)/其他 billingMode 一律返回空，避免越权暴露活动名与价格。
    // 权威判定与 BillingService.getPlans 一致（product.billingMode + codingPlanFulfillmentMode）。
    const product = await this.prisma.product.findUnique({
      where: { id: params.productId },
      select: { billingMode: true, codingPlanFulfillmentMode: true },
    });
    if (
      !product ||
      product.billingMode !== 'CODING_PLAN' ||
      product.codingPlanFulfillmentMode === CodingPlanFulfillmentMode.provider_resale
    ) {
      return {};
    }

    const plans = await this.prisma.plan.findMany({
      where: { productId: params.productId, isActive: true, deletedAt: null },
      include: { prices: { where: { currency } } },
    });
    if (plans.length === 0) return {};

    // 新用户 = 无任何付费订阅历史（与下单 payment.service 同口径）
    const priorSub = await this.prisma.subscriptionPeriod.findFirst({
      where: { userId: params.userId, status: { in: ['ACTIVE', 'EXPIRED', 'CANCELLED'] } },
      select: { id: true },
    });
    const isNewUser = !priorSub;

    // Stripe 是否配置：未配置 = 该环境无 Stripe 结账路径，活动 coupon 既不会创建也不需要
    // （cny 仅微信/支付宝直减，按 campaignAmountCents 直扣），展示侧不应再要求 coupon 就绪。
    // 已配置时维持「仅展示 coupon 就绪命中」，避免 Stripe 渠道展示价≠结账价漂移。
    const couponRequired = this.stripeCouponSync.isConfigured();

    const result: PlanPromotions = {};
    for (const plan of plans) {
      const priorSamePlan = await this.prisma.subscriptionPeriod.findFirst({
        where: { userId: params.userId, planId: plan.id },
        select: { id: true },
      });
      const userHasPlanHistory = !!priorSamePlan;
      const planPrice = plan.prices?.[0] ?? null;

      const byPeriod: Partial<Record<BillingPeriod, PlanPromotionHit>> = {};
      for (const period of PROMO_PERIODS) {
        const monthlyEquiv = resolvePlanPeriodMonthlyEquivalentCents(
          period,
          planPrice,
          plan,
          currency,
          params.platformCurrency,
        );
        if (monthlyEquiv == null || monthlyEquiv <= 0) continue;
        const originalTotal = monthlyEquiv * PERIOD_MULTIPLIER[period];
        const hit = await this.findBestActiveCampaign({
          planId: plan.id,
          currency,
          billingPeriod: period,
          userId: params.userId,
          originalAmountCents: originalTotal,
          isNewUser,
          userHasPlanHistory,
        });
        if (!hit) continue;
        if (couponRequired && !hit.campaign.stripeCouponId) continue; // Stripe 环境才要求 coupon 就绪
        const months = PERIOD_MULTIPLIER[period];
        byPeriod[period] = {
          campaignId: hit.campaign.id,
          campaignName: hit.campaign.name,
          originalTotalCents: hit.originalAmountCents,
          campaignTotalCents: hit.campaignAmountCents,
          originalMonthlyEquivCents: Math.round(hit.originalAmountCents / months),
          campaignMonthlyEquivCents: Math.round(hit.campaignAmountCents / months),
        };
      }
      if (Object.keys(byPeriod).length > 0) result[plan.id] = byPeriod;
    }
    return result;
  }

  // ================================================
  // 辅助
  // ================================================

  private matchScope(scope: string, isNewUser: boolean): boolean {
    if (scope === 'all') return true;
    if (scope === 'new_users') return isNewUser;
    if (scope === 'old_users') return !isNewUser;
    return false;
  }

  private validatePrices(prices: CampaignPriceInput[]) {
    if (!prices || prices.length === 0) {
      throw new BadRequestException('至少配置一个币种价格');
    }
    const seen = new Set<string>();
    for (const p of prices) {
      const cur = p.currency.toLowerCase();
      if (seen.has(cur)) {
        throw new BadRequestException(`币种 ${cur} 重复`);
      }
      seen.add(cur);
      if (p.monthlyPrice < 0 || (p.quarterlyPrice ?? p.monthlyPrice) < 0 || p.yearlyPrice < 0) {
        throw new BadRequestException('价格不能为负');
      }
    }
  }

  private parseCouponMap(json: string): Record<string, string> {
    try {
      const parsed = JSON.parse(json || '{}');
      return typeof parsed === 'object' && parsed ? parsed : {};
    } catch {
      return {};
    }
  }

  /**
   * 为每个 (currency, period) 创建 Stripe Coupon
   * period='both' → 创建 monthly + yearly 两套（兼容历史语义）
   * period='all' → 创建 monthly + quarterly + yearly 三套
   */
  private async syncStripeCouponsForCampaign(
    campaignId: string,
    plan: any,
    input: CreateCampaignInput,
  ): Promise<Record<string, string>> {
    // Stripe 未配置 = 该环境无 Stripe 结账路径（cny 仅微信/支付宝直减），活动 coupon 既不会创建也不需要。
    // 不短路会把「环境未启用 Stripe」误当成关键依赖故障抛 503，阻断 create/update（即便活动无正折扣、
    // 历史上靠 amountOff<=0 全跳过才侥幸创建成功）。与展示侧 couponRequired(isConfigured) 同口径。
    if (!this.stripeCouponSync.isConfigured()) {
      this.logger.warn(`Stripe 未配置，跳过 Campaign Coupon 同步: campaign=${campaignId}`);
      return {};
    }
    const result: Record<string, string> = {};
    const periods: BillingPeriod[] =
      input.billingPeriod === 'both'
        ? ['monthly', 'yearly']
        : input.billingPeriod === 'all'
          ? ['monthly', 'quarterly', 'yearly']
          : [input.billingPeriod as BillingPeriod];

    for (const p of input.prices) {
      const currency = p.currency.toLowerCase();
      const planPrice = plan.prices?.find((pp: any) => pp.currency === currency);

      for (const period of periods) {
        const originalMonthly =
          selectPeriodMonthlyPrice(planPrice, period) ??
          (currency === 'usd' ? selectPeriodMonthlyPrice(plan, period) ?? 0 : 0);
        const campaignMonthly = selectPeriodMonthlyPrice(p, period) ?? 0;

        const originalTotal = originalMonthly * PERIOD_MULTIPLIER[period];
        const campaignTotal = campaignMonthly * PERIOD_MULTIPLIER[period];
        const amountOff = originalTotal - campaignTotal;

        if (amountOff <= 0) {
          this.logger.warn(
            `活动价 >= 原价，跳过 coupon 创建: campaign=${campaignId} ${currency}:${period}`,
          );
          continue;
        }

        const couponId = await this.stripeCouponSync.createAmountOffCoupon({
          name: `${input.name} (${currency.toUpperCase()} ${period})`,
          amountOffCents: amountOff,
          currency,
          metadata: {
            campaignId,
            currency,
            period,
            planId: input.planId,
          },
        });
        result[`${currency}:${period}`] = couponId;
      }
    }
    return result;
  }
}
