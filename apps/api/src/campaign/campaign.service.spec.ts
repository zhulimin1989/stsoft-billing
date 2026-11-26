import { CampaignService } from './campaign.service';
import { CampaignRepository } from './campaign.repository';
import { StripeCouponSyncService } from './stripe-coupon-sync.service';
import { PrismaService } from '../prisma/prisma.service';
import { BadRequestException, NotFoundException } from '@nestjs/common';

function makeRepo(): jest.Mocked<CampaignRepository> {
  return {
    create: jest.fn(),
    update: jest.fn(),
    replacePrices: jest.fn(),
    findById: jest.fn(),
    findAll: jest.fn(),
    delete: jest.fn(),
    countRedemptions: jest.fn().mockResolvedValue(0),
    sumSaved: jest.fn().mockResolvedValue(0),
    findCandidates: jest.fn().mockResolvedValue([]),
  } as any;
}

function makeStripe(): jest.Mocked<StripeCouponSyncService> {
  return {
    createAmountOffCoupon: jest.fn().mockResolvedValue('cpn_fake'),
    createDiscountCodeCoupon: jest.fn().mockResolvedValue('cpn_fake'),
    archiveCoupon: jest.fn().mockResolvedValue(undefined),
    archiveCouponsMap: jest.fn().mockResolvedValue(undefined),
    isConfigured: jest.fn().mockReturnValue(true), // 缺省：已配置 Stripe（保留既有 coupon-gate 语义）
  } as any;
}

function makePrisma(plan?: any): PrismaService {
  return {
    plan: {
      findUnique: jest.fn().mockResolvedValue(
        plan ?? {
          id: 'plan-1',
          name: 'Pro',
          monthlyPrice: 0,
          quarterlyPrice: 0,
          yearlyPrice: 0,
          prices: [
            { currency: 'usd', monthlyPrice: 1900, quarterlyPrice: 1700, yearlyPrice: 1500 },
          ],
        },
      ),
    },
  } as any;
}

describe('CampaignService - findBestActiveCampaign', () => {
  it('取最便宜的活动价', async () => {
    const repo = makeRepo();
    repo.findCandidates.mockResolvedValue([
      {
        id: 'c1',
        name: 'A',
        scope: 'all',
        firstTimeOnly: false,
        billingPeriod: 'monthly',
        maxUsesPerUser: 0,
        maxUsesTotal: 0,
        stripeCouponIdsJson: JSON.stringify({ 'usd:monthly': 'cpn_a' }),
        prices: [{ currency: 'usd', monthlyPrice: 1500, yearlyPrice: 1200 }],
      },
      {
        id: 'c2',
        name: 'B',
        scope: 'all',
        firstTimeOnly: false,
        billingPeriod: 'monthly',
        maxUsesPerUser: 0,
        maxUsesTotal: 0,
        stripeCouponIdsJson: JSON.stringify({ 'usd:monthly': 'cpn_b' }),
        prices: [{ currency: 'usd', monthlyPrice: 1000, yearlyPrice: 800 }],
      },
    ] as any);

    const svc = new CampaignService(repo, makePrisma(), makeStripe());
    const hit = await svc.findBestActiveCampaign({
      planId: 'plan-1',
      currency: 'usd',
      billingPeriod: 'monthly',
      userId: 'u1',
      originalAmountCents: 1900,
      isNewUser: true,
      userHasPlanHistory: false,
    });
    expect(hit?.campaign.id).toBe('c2');
    expect(hit?.campaignAmountCents).toBe(1000);
    expect(hit?.amountSavedCents).toBe(900);
  });

  it('scope new_users: 老用户不命中', async () => {
    const repo = makeRepo();
    repo.findCandidates.mockResolvedValue([
      {
        id: 'c1',
        name: 'Newbie',
        scope: 'new_users',
        firstTimeOnly: false,
        billingPeriod: 'monthly',
        maxUsesPerUser: 0,
        maxUsesTotal: 0,
        stripeCouponIdsJson: '{}',
        prices: [{ currency: 'usd', monthlyPrice: 500, yearlyPrice: 400 }],
      },
    ] as any);
    const svc = new CampaignService(repo, makePrisma(), makeStripe());
    const hit = await svc.findBestActiveCampaign({
      planId: 'plan-1',
      currency: 'usd',
      billingPeriod: 'monthly',
      userId: 'u1',
      originalAmountCents: 1900,
      isNewUser: false,
      userHasPlanHistory: true,
    });
    expect(hit).toBeNull();
  });

  it('firstTimeOnly: 已买过同 plan 的用户不命中', async () => {
    const repo = makeRepo();
    repo.findCandidates.mockResolvedValue([
      {
        id: 'c1',
        name: 'First',
        scope: 'all',
        firstTimeOnly: true,
        billingPeriod: 'monthly',
        maxUsesPerUser: 0,
        maxUsesTotal: 0,
        stripeCouponIdsJson: '{}',
        prices: [{ currency: 'usd', monthlyPrice: 900, yearlyPrice: 800 }],
      },
    ] as any);
    const svc = new CampaignService(repo, makePrisma(), makeStripe());
    const hit = await svc.findBestActiveCampaign({
      planId: 'plan-1',
      currency: 'usd',
      billingPeriod: 'monthly',
      userId: 'u1',
      originalAmountCents: 1900,
      isNewUser: false,
      userHasPlanHistory: true,
    });
    expect(hit).toBeNull();
  });

  it('maxUsesPerUser 达上限不命中', async () => {
    const repo = makeRepo();
    repo.findCandidates.mockResolvedValue([
      {
        id: 'c1',
        name: 'Limited',
        scope: 'all',
        firstTimeOnly: false,
        billingPeriod: 'monthly',
        maxUsesPerUser: 1,
        maxUsesTotal: 0,
        stripeCouponIdsJson: '{}',
        prices: [{ currency: 'usd', monthlyPrice: 900, yearlyPrice: 800 }],
      },
    ] as any);
    repo.countRedemptions.mockResolvedValue(1);
    const svc = new CampaignService(repo, makePrisma(), makeStripe());
    const hit = await svc.findBestActiveCampaign({
      planId: 'plan-1',
      currency: 'usd',
      billingPeriod: 'monthly',
      userId: 'u1',
      originalAmountCents: 1900,
      isNewUser: true,
      userHasPlanHistory: false,
    });
    expect(hit).toBeNull();
  });

  it('年付活动价 × 12 转整单', async () => {
    const repo = makeRepo();
    repo.findCandidates.mockResolvedValue([
      {
        id: 'c1',
        name: 'Yearly',
        scope: 'all',
        firstTimeOnly: false,
        billingPeriod: 'yearly',
        maxUsesPerUser: 0,
        maxUsesTotal: 0,
        stripeCouponIdsJson: JSON.stringify({ 'usd:yearly': 'cpn_y' }),
        prices: [{ currency: 'usd', monthlyPrice: 0, yearlyPrice: 1000 }],
      },
    ] as any);
    const svc = new CampaignService(repo, makePrisma(), makeStripe());
    const hit = await svc.findBestActiveCampaign({
      planId: 'plan-1',
      currency: 'usd',
      billingPeriod: 'yearly',
      userId: 'u1',
      originalAmountCents: 18000, // 1500 × 12
      isNewUser: true,
      userHasPlanHistory: false,
    });
    expect(hit?.campaignAmountCents).toBe(12000); // 1000 × 12
    expect(hit?.campaign.stripeCouponId).toBe('cpn_y');
  });

  it('季付活动价 × 3 转整单', async () => {
    const repo = makeRepo();
    repo.findCandidates.mockResolvedValue([
      {
        id: 'c1',
        name: 'Quarterly',
        scope: 'all',
        firstTimeOnly: false,
        billingPeriod: 'quarterly',
        maxUsesPerUser: 0,
        maxUsesTotal: 0,
        stripeCouponIdsJson: JSON.stringify({ 'usd:quarterly': 'cpn_q' }),
        prices: [{ currency: 'usd', monthlyPrice: 0, quarterlyPrice: 1200, yearlyPrice: 0 }],
      },
    ] as any);
    const svc = new CampaignService(repo, makePrisma(), makeStripe());
    const hit = await svc.findBestActiveCampaign({
      planId: 'plan-1',
      currency: 'usd',
      billingPeriod: 'quarterly',
      userId: 'u1',
      originalAmountCents: 5100,
      isNewUser: true,
      userHasPlanHistory: false,
    });
    expect(hit?.campaignAmountCents).toBe(3600);
    expect(hit?.campaign.stripeCouponId).toBe('cpn_q');
  });
});

describe('CampaignService - create 校验', () => {
  it('缺 planId 抛 BadRequest', async () => {
    const svc = new CampaignService(makeRepo(), makePrisma(), makeStripe());
    await expect(
      svc.create({
        planId: '',
        name: 'X',
        scope: 'all',
        billingPeriod: 'monthly',
        startAt: new Date(),
        endAt: new Date(),
        prices: [{ currency: 'usd', monthlyPrice: 100, yearlyPrice: 100 }],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('空 prices 抛 BadRequest', async () => {
    const svc = new CampaignService(makeRepo(), makePrisma(), makeStripe());
    await expect(
      svc.create({
        planId: 'plan-1',
        name: 'X',
        scope: 'all',
        billingPeriod: 'monthly',
        startAt: new Date(),
        endAt: new Date(),
        prices: [],
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('Stripe Coupon 创建失败 → 禁用并 rethrow', async () => {
    const repo = makeRepo();
    repo.create.mockResolvedValue({ id: 'c1' } as any);
    const stripe = makeStripe();
    stripe.createAmountOffCoupon.mockRejectedValue(new Error('Stripe down'));

    const svc = new CampaignService(repo, makePrisma(), stripe);
    await expect(
      svc.create({
        planId: 'plan-1',
        name: 'X',
        scope: 'all',
        billingPeriod: 'monthly',
        startAt: new Date(),
        endAt: new Date(),
        prices: [{ currency: 'usd', monthlyPrice: 500, yearlyPrice: 400 }],
      }),
    ).rejects.toThrow('Stripe down');
    expect(repo.update).toHaveBeenCalledWith('c1', { isActive: false });
  });
});

describe('CampaignService - Stripe 未配置环境（cny 直减/无 Stripe 结账）', () => {
  it('create 跳过 coupon 创建、不抛 503、活动正常保存（couponMap 空）', async () => {
    const repo = makeRepo();
    repo.create.mockResolvedValue({ id: 'c1' } as any);
    repo.update.mockResolvedValue({ id: 'c1', isActive: true } as any);
    const stripe = makeStripe();
    (stripe.isConfigured as jest.Mock).mockReturnValue(false);

    const svc = new CampaignService(repo, makePrisma(), stripe);
    await expect(
      svc.create({
        planId: 'plan-1',
        name: 'X',
        scope: 'all',
        billingPeriod: 'monthly',
        startAt: new Date(),
        endAt: new Date(),
        prices: [{ currency: 'usd', monthlyPrice: 500, yearlyPrice: 400 }],
      }),
    ).resolves.toBeDefined();
    expect(stripe.createAmountOffCoupon).not.toHaveBeenCalled();
    expect(repo.update).toHaveBeenCalledWith('c1', { stripeCouponIdsJson: JSON.stringify({}) });
  });

  it('改 billingPeriod 的 update 跳过 coupon 重建、不抛 503', async () => {
    const repo = makeRepo();
    repo.findById.mockResolvedValue({
      id: 'c1',
      planId: 'plan-1',
      name: 'X',
      scope: 'all',
      billingPeriod: 'all',
      isActive: true,
      stripeCouponIdsJson: '{}',
      startAt: new Date(),
      endAt: new Date(),
      prices: [{ currency: 'usd', monthlyPrice: 500, quarterlyPrice: 450, yearlyPrice: 400 }],
    } as any);
    repo.update.mockResolvedValue({ id: 'c1', planId: 'plan-1', isActive: true, billingPeriod: 'monthly' } as any);
    const stripe = makeStripe();
    (stripe.isConfigured as jest.Mock).mockReturnValue(false);

    const svc = new CampaignService(repo, makePrisma(), stripe);
    await expect(svc.update('c1', { billingPeriod: 'monthly' })).resolves.toBeDefined();
    expect(stripe.createAmountOffCoupon).not.toHaveBeenCalled();
  });
});

describe('CampaignService - getPlanPromotions', () => {
  function makePromoPrisma(productOverride?: any): PrismaService {
    return {
      product: {
        findUnique: jest.fn().mockResolvedValue(
          productOverride ?? {
            billingMode: 'CODING_PLAN',
            codingPlanFulfillmentMode: 'platform_model_package', // 自营
          },
        ),
      },
      plan: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'plan-lite',
            name: 'Coding-Lite',
            monthlyPrice: 0,
            quarterlyPrice: 0,
            yearlyPrice: 0,
            prices: [{ currency: 'cny', monthlyPrice: 3900, quarterlyPrice: 3900, yearlyPrice: 3900 }],
          },
        ]),
      },
      subscriptionPeriod: { findFirst: jest.fn().mockResolvedValue(null) }, // 新用户、无 plan 历史
    } as any;
  }

  function liteCampaign(stripeReady: boolean) {
    return {
      id: 'c1',
      name: '9.9活动',
      scope: 'all',
      firstTimeOnly: false,
      billingPeriod: 'all',
      maxUsesPerUser: 0,
      maxUsesTotal: 0,
      stripeCouponIdsJson: stripeReady
        ? JSON.stringify({ 'cny:monthly': 'cpn_m', 'cny:quarterly': 'cpn_q', 'cny:yearly': 'cpn_y' })
        : '{}',
      prices: [{ currency: 'cny', monthlyPrice: 990, quarterlyPrice: 990, yearlyPrice: 990 }],
    };
  }

  it('returns per-period campaign pricing (total + monthly-equiv)', async () => {
    const repo = makeRepo();
    repo.findCandidates.mockResolvedValue([liteCampaign(true)] as any);
    const svc = new CampaignService(repo, makePromoPrisma(), makeStripe());
    const promos = await svc.getPlanPromotions({
      productId: 'prod-self',
      currency: 'cny',
      userId: 'u1',
      platformCurrency: 'cny',
    });
    expect(promos['plan-lite']?.monthly).toMatchObject({
      campaignId: 'c1',
      campaignName: '9.9活动',
      originalTotalCents: 3900,
      campaignTotalCents: 990,
      originalMonthlyEquivCents: 3900,
      campaignMonthlyEquivCents: 990,
    });
    // 季付：原价月均 3900 → 总价 11700；活动月均 990 → 总价 2970；月均仍 990
    expect(promos['plan-lite']?.quarterly).toMatchObject({
      originalTotalCents: 11700,
      campaignTotalCents: 2970,
      originalMonthlyEquivCents: 3900,
      campaignMonthlyEquivCents: 990,
    });
  });

  it('hides hits whose Stripe Coupon is not ready', async () => {
    const repo = makeRepo();
    repo.findCandidates.mockResolvedValue([liteCampaign(false)] as any);
    const svc = new CampaignService(repo, makePromoPrisma(), makeStripe());
    const promos = await svc.getPlanPromotions({
      productId: 'prod-self',
      currency: 'cny',
      userId: 'u1',
      platformCurrency: 'cny',
    });
    expect(promos['plan-lite']).toBeUndefined();
  });

  it('excludes a plan when campaign price >= original (no discount)', async () => {
    const repo = makeRepo();
    repo.findCandidates.mockResolvedValue([
      { ...liteCampaign(true), prices: [{ currency: 'cny', monthlyPrice: 5000, quarterlyPrice: 5000, yearlyPrice: 5000 }] },
    ] as any);
    const svc = new CampaignService(repo, makePromoPrisma(), makeStripe());
    const promos = await svc.getPlanPromotions({
      productId: 'prod-self',
      currency: 'cny',
      userId: 'u1',
      platformCurrency: 'cny',
    });
    expect(promos['plan-lite']).toBeUndefined();
  });

  it('shows coupon-less campaign when Stripe is NOT configured (cny 微信/支付宝直减)', async () => {
    const repo = makeRepo();
    repo.findCandidates.mockResolvedValue([liteCampaign(false)] as any); // 活动无 coupon
    const stripe = makeStripe();
    (stripe.isConfigured as jest.Mock).mockReturnValue(false); // 该环境未配置 Stripe
    const svc = new CampaignService(repo, makePromoPrisma(), stripe);
    const promos = await svc.getPlanPromotions({
      productId: 'prod-self',
      currency: 'cny',
      userId: 'u1',
      platformCurrency: 'cny',
    });
    // 无 Stripe → 不要求 coupon，命中即展示（与微信/支付宝直减实付价一致）
    expect(promos['plan-lite']?.monthly).toMatchObject({
      originalTotalCents: 3900,
      campaignTotalCents: 990,
    });
  });

  it('returns {} for a resale (provider_resale) product — 自营护栏', async () => {
    const repo = makeRepo();
    repo.findCandidates.mockResolvedValue([liteCampaign(true)] as any);
    const prisma = makePromoPrisma({
      billingMode: 'CODING_PLAN',
      codingPlanFulfillmentMode: 'provider_resale',
    });
    const svc = new CampaignService(repo, prisma, makeStripe());
    const promos = await svc.getPlanPromotions({
      productId: 'prod-resale',
      currency: 'cny',
      userId: 'u1',
      platformCurrency: 'cny',
    });
    expect(promos).toEqual({});
    expect((prisma.plan.findMany as jest.Mock)).not.toHaveBeenCalled(); // 护栏短路，未查 plan
  });

  it('returns {} for a non-CODING_PLAN product', async () => {
    const repo = makeRepo();
    const prisma = makePromoPrisma({ billingMode: 'SUBSCRIPTION', codingPlanFulfillmentMode: null });
    const svc = new CampaignService(repo, prisma, makeStripe());
    const promos = await svc.getPlanPromotions({
      productId: 'prod-sub',
      currency: 'cny',
      userId: 'u1',
      platformCurrency: 'cny',
    });
    expect(promos).toEqual({});
  });
});
