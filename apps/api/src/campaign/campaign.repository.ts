import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { Prisma } from '@prisma/client';
import type { BillingPeriod } from '@ruidong/shared';

type CampaignPriceWrite = { currency: string; monthlyPrice: number; quarterlyPrice?: number; yearlyPrice: number };

function normalizePrices(prices: CampaignPriceWrite[]) {
  return prices.map((p) => ({
    ...p,
    quarterlyPrice: p.quarterlyPrice ?? p.monthlyPrice,
  }));
}

@Injectable()
export class CampaignRepository {
  constructor(private readonly prisma: PrismaService) {}

  async create(
    data: Prisma.CampaignCreateInput,
    prices: CampaignPriceWrite[],
  ) {
    return this.prisma.campaign.create({
      data: {
        ...data,
        prices: { create: normalizePrices(prices) },
      },
      include: { prices: true },
    });
  }

  async update(id: string, data: Prisma.CampaignUpdateInput) {
    return this.prisma.campaign.update({
      where: { id },
      data,
      include: { prices: true },
    });
  }

  /** 删除重建所有 campaign_prices（价格变了就批量替换）*/
  async replacePrices(
    campaignId: string,
    prices: CampaignPriceWrite[],
  ) {
    await this.prisma.campaignPrice.deleteMany({ where: { campaignId } });
    if (prices.length > 0) {
      await this.prisma.campaignPrice.createMany({
        data: normalizePrices(prices).map((p) => ({ campaignId, ...p })),
      });
    }
  }

  async findById(id: string) {
    return this.prisma.campaign.findUnique({
      where: { id },
      include: { prices: true, plan: true, product: true },
    });
  }

  async findAll(filters: { planId?: string; productId?: string; isActive?: boolean }) {
    return this.prisma.campaign.findMany({
      where: {
        ...(filters.planId ? { planId: filters.planId } : {}),
        ...(filters.productId ? { productId: filters.productId } : {}),
        ...(filters.isActive !== undefined ? { isActive: filters.isActive } : {}),
      },
      orderBy: [{ priority: 'desc' }, { createdAt: 'desc' }],
      include: { prices: true },
    });
  }

  async delete(id: string) {
    // 保留历史数据：硬删会打碎 campaign_redemptions。改用软禁用。
    return this.prisma.campaign.update({
      where: { id },
      data: { isActive: false },
    });
  }

  async countRedemptions(campaignId: string, userId?: string) {
    return this.prisma.campaignRedemption.count({
      where: {
        campaignId,
        ...(userId ? { userId } : {}),
      },
    });
  }

  async sumSaved(campaignId: string): Promise<number> {
    const agg = await this.prisma.campaignRedemption.aggregate({
      where: { campaignId },
      _sum: { amountSavedCents: true },
    });
    return agg._sum.amountSavedCents ?? 0;
  }

  /**
   * 找命中用户当前购买上下文的活动，按价格排序（最便宜的赢）。
   * 返回所有候选让 service 过滤更复杂的条件（首次限制、限次）。
   */
  async findCandidates(params: {
    planId: string;
    billingPeriod: BillingPeriod;
    currency: string;
    now?: Date;
  }) {
    const now = params.now ?? new Date();
    const periods =
      params.billingPeriod === 'quarterly'
        ? ['quarterly', 'all']
        : [params.billingPeriod, 'both', 'all'];
    return this.prisma.campaign.findMany({
      where: {
        planId: params.planId,
        isActive: true,
        startAt: { lte: now },
        endAt: { gte: now },
        billingPeriod: { in: periods },
      },
      include: {
        prices: { where: { currency: params.currency.toLowerCase() } },
      },
    });
  }
}
