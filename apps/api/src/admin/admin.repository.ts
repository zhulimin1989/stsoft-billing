import { BadRequestException, Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import { OrderStatus, PayChannel, OrderType, Prisma } from '@prisma/client';
import { usdToCents } from '../billing/money';
import { assertNoUnsettledGatewayEvents } from '../billing/model-retirement-preflight';

const REVENUE_ORDER_STATUSES = [
  OrderStatus.PAID,
  OrderStatus.FULFILLING,
  OrderStatus.COMPLETED,
];

const REVENUE_ORDER_SELECT = {
  amountCents: true,
  paidAt: true,
  completedAt: true,
  createdAt: true,
  productId: true,
  plan: { select: { productId: true } },
  boosterPack: { select: { productId: true } },
  items: {
    select: {
      amountCents: true,
      productId: true,
      plan: { select: { productId: true } },
      boosterPack: { select: { productId: true } },
    },
  },
} satisfies Prisma.OrderSelect;

type RevenueOrderRow = Prisma.OrderGetPayload<{ select: typeof REVENUE_ORDER_SELECT }>;

@Injectable()
export class AdminRepository {
  constructor(private readonly prisma: PrismaService) {}

  // ============================
  // 订单
  // ============================

  async findOrders(skip: number, take: number, filters?: {
    status?: string;
    userId?: string;
    productId?: string;
    orderType?: string;
    channel?: string;
    search?: string;
  }) {
    const where: Prisma.OrderWhereInput = {};
    if (filters?.status) where.status = filters.status as OrderStatus;
    if (filters?.userId) where.userId = filters.userId;
    if (filters?.productId) where.productId = filters.productId;
    if (filters?.orderType) where.orderType = filters.orderType as OrderType;
    if (filters?.channel) where.channel = filters.channel as PayChannel;
    if (filters?.search) {
      where.OR = [
        { id: { contains: filters.search, mode: 'insensitive' } },
        { tradeNo: { contains: filters.search, mode: 'insensitive' } },
        { user: { email: { contains: filters.search, mode: 'insensitive' } } },
      ];
    }
    return this.prisma.order.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: {
        user: { select: { email: true, nickname: true } },
        product: {
          select: {
            id: true,
            name: true,
            slug: true,
            billingMode: true,
            codingPlanFulfillmentMode: true,
          },
        },
        plan: { select: { name: true } },
        boosterPack: { select: { name: true } },
      },
    });
  }

  async countOrders(filters?: {
    status?: string;
    userId?: string;
    productId?: string;
    orderType?: string;
    channel?: string;
    search?: string;
  }) {
    const where: Prisma.OrderWhereInput = {};
    if (filters?.status) where.status = filters.status as OrderStatus;
    if (filters?.userId) where.userId = filters.userId;
    if (filters?.productId) where.productId = filters.productId;
    if (filters?.orderType) where.orderType = filters.orderType as OrderType;
    if (filters?.channel) where.channel = filters.channel as PayChannel;
    if (filters?.search) {
      where.OR = [
        { id: { contains: filters.search, mode: 'insensitive' } },
        { tradeNo: { contains: filters.search, mode: 'insensitive' } },
        { user: { email: { contains: filters.search, mode: 'insensitive' } } },
      ];
    }
    return this.prisma.order.count({ where });
  }

  // ============================
  // 统计 & 收入
  // ============================

  async getStats() {
    const [userCount, orderCount, paidOrderCount, totalRevenue, channelCount, activeKeyCount] =
      await Promise.all([
        this.prisma.user.count(),
        this.prisma.order.count(),
        this.prisma.order.count({ where: { status: 'PAID' } }),
        this.prisma.order.aggregate({ where: { status: 'PAID' }, _sum: { amountCents: true } }),
        this.prisma.channel.count(),
        this.prisma.apiKey.count({ where: { isActive: true } }),
      ]);

    return {
      userCount,
      orderCount,
      paidOrderCount,
      totalRevenueCents: totalRevenue._sum.amountCents ?? 0,
      channelCount,
      activeKeyCount,
    };
  }

  async getRevenue(productId?: string) {
    const todayStart = this.startOfShanghaiDay(new Date());
    const tomorrowStart = this.addDays(todayStart, 1);
    const [totalOrders, totalConsume, todayOrders] = await Promise.all([
      this.findRevenueOrders({ productId }),
      this.prisma.balanceTransaction.aggregate({
        where: { type: 'CONSUME', ...(productId ? { productId } : {}) },
        _sum: { amountUsd: true },
      }),
      this.findRevenueOrders({ productId, start: todayStart, end: tomorrowStart }),
    ]);
    const totalRevenueCents = this.sumRevenueOrders(totalOrders, productId);
    const todayRevenueCents = this.sumRevenueOrders(todayOrders, productId);

    return {
      totalRevenueCents,
      totalRechargeCents: totalRevenueCents,
      totalConsumeCents: Math.abs(usdToCents(totalConsume._sum.amountUsd ?? 0)),
      todayRevenueCents,
      todayRechargeCents: todayRevenueCents,
      todayOrders: todayOrders.length,
    };
  }

  async getRevenueOverview(days: number, productId?: string) {
    const safeDays = Number.isFinite(days) && days > 0 ? Math.floor(days) : 7;
    const todayStart = this.startOfShanghaiDay(new Date());
    const since = this.addDays(todayStart, -(safeDays - 1));
    const [orders, totalOrders] = await Promise.all([
      this.findRevenueOrders({ productId, start: since }),
      this.findRevenueOrders({ productId }),
    ]);
    const revenueByDay = new Map<string, number>();

    for (const order of orders) {
      const paidAt = this.revenueOrderPaidAt(order);
      if (!paidAt) continue;
      const key = this.shanghaiDayKey(paidAt);
      revenueByDay.set(key, (revenueByDay.get(key) ?? 0) + this.sumRevenueOrder(order, productId));
    }

    const dailyRevenue: Array<{ date: string; recharge: number; revenueCents: number; consume: number }> = [];
    for (let cursor = new Date(since); cursor <= todayStart; cursor = this.addDays(cursor, 1)) {
      const date = this.shanghaiDayKey(cursor);
      const revenueCents = revenueByDay.get(date) ?? 0;
      dailyRevenue.push({ date, recharge: revenueCents, revenueCents, consume: 0 });
    }

    return {
      daily: dailyRevenue,
      totalRevenueCents: this.sumRevenueOrders(totalOrders, productId),
      totalRechargeCents: this.sumRevenueOrders(totalOrders, productId),
    };
  }

  private findRevenueOrders(params: { productId?: string; start?: Date; end?: Date }) {
    return this.prisma.order.findMany({
      where: this.revenueOrderWhere(params),
      select: REVENUE_ORDER_SELECT,
    });
  }

  private revenueOrderWhere(params: { productId?: string; start?: Date; end?: Date }): Prisma.OrderWhereInput {
    const and: Prisma.OrderWhereInput[] = [
      { status: { in: REVENUE_ORDER_STATUSES } },
      { paidAt: { not: null } },
    ];
    if (params.start || params.end) {
      and.push({
        paidAt: {
          ...(params.start ? { gte: params.start } : {}),
          ...(params.end ? { lt: params.end } : {}),
        },
      });
    }
    if (params.productId) and.push(this.revenueOrderProductWhere(params.productId));
    return { AND: and };
  }

  private revenueOrderProductWhere(productId: string): Prisma.OrderWhereInput {
    return {
      OR: [
        { productId },
        { plan: { productId } },
        { boosterPack: { productId } },
        { items: { some: { productId } } },
        { items: { some: { plan: { productId } } } },
        { items: { some: { boosterPack: { productId } } } },
      ],
    };
  }

  private sumRevenueOrders(orders: RevenueOrderRow[], productId?: string): number {
    return orders.reduce((sum, order) => sum + this.sumRevenueOrder(order, productId), 0);
  }

  private sumRevenueOrder(order: RevenueOrderRow, productId?: string): number {
    const items = order.items ?? [];
    if (items.length > 0) {
      return items.reduce((sum, item) => {
        const itemProductId = item.productId ?? item.plan?.productId ?? item.boosterPack?.productId ?? null;
        if (productId && itemProductId !== productId) return sum;
        return sum + item.amountCents;
      }, 0);
    }

    const orderProductId = order.productId ?? order.plan?.productId ?? order.boosterPack?.productId ?? null;
    if (productId && orderProductId !== productId) return 0;
    return order.amountCents;
  }

  private revenueOrderPaidAt(order: RevenueOrderRow): Date | null {
    return order.paidAt ?? order.completedAt ?? order.createdAt ?? null;
  }

  private startOfShanghaiDay(value: Date): Date {
    const shifted = new Date(value.getTime() + 8 * 60 * 60 * 1000);
    return new Date(Date.UTC(shifted.getUTCFullYear(), shifted.getUTCMonth(), shifted.getUTCDate()) - 8 * 60 * 60 * 1000);
  }

  private addDays(value: Date, days: number): Date {
    const date = new Date(value);
    date.setUTCDate(date.getUTCDate() + days);
    return date;
  }

  private shanghaiDayKey(value: Date): string {
    const shifted = new Date(value.getTime() + 8 * 60 * 60 * 1000);
    const year = shifted.getUTCFullYear();
    const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const day = String(shifted.getUTCDate()).padStart(2, '0');
    return `${year}-${month}-${day}`;
  }

  // ============================
  // 交易流水
  // ============================

  async findTransactions(skip: number, take: number, filters?: { userId?: string; productId?: string }) {
    const where: Prisma.BalanceTransactionWhereInput = {};
    if (filters?.userId) where.userId = filters.userId;
    if (filters?.productId) where.productId = filters.productId;
    return this.prisma.balanceTransaction.findMany({
      where: Object.keys(where).length > 0 ? where : undefined,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: {
        user: { select: { email: true, nickname: true } },
        product: { select: { id: true, name: true, slug: true, billingMode: true } },
      },
    });
  }

  async countTransactions(filters?: { userId?: string; productId?: string }) {
    const where: Prisma.BalanceTransactionWhereInput = {};
    if (filters?.userId) where.userId = filters.userId;
    if (filters?.productId) where.productId = filters.productId;
    return this.prisma.balanceTransaction.count({
      where: Object.keys(where).length > 0 ? where : undefined,
    });
  }

  // ============================
  // 审计日志
  // ============================

  async findAuditLogs(skip: number, take: number, filters?: { action?: string; resource?: string }) {
    const where: any = {};
    if (filters?.action) where.action = { contains: filters.action, mode: 'insensitive' };
    if (filters?.resource) where.resource = { contains: filters.resource, mode: 'insensitive' };
    return this.prisma.auditLog.findMany({
      where,
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    });
  }

  async countAuditLogs(filters?: { action?: string; resource?: string }) {
    const where: any = {};
    if (filters?.action) where.action = { contains: filters.action, mode: 'insensitive' };
    if (filters?.resource) where.resource = { contains: filters.resource, mode: 'insensitive' };
    return this.prisma.auditLog.count({ where });
  }

  // ============================
  // 套餐
  // ============================

  async findPlans() {
    return this.prisma.plan.findMany({
      where: { deletedAt: null },
      orderBy: [{ productId: 'asc' }, { sortOrder: 'asc' }],
      include: {
        product: { select: { id: true, name: true, slug: true } },
      },
    });
  }

  async upsertPlan(id: string | undefined, data: Prisma.PlanUncheckedCreateInput) {
    if (id) {
      return this.prisma.plan.upsert({
        where: { id },
        update: data as Prisma.PlanUncheckedUpdateInput,
        create: { id, ...data },
      });
    }
    return this.prisma.plan.create({ data });
  }

  async findPlanById(id: string) {
    return this.prisma.plan.findFirst({
      where: { id, deletedAt: null },
      include: {
        modelAccess: true,
        modelRoutePolicies: true,
        product: { select: { id: true, name: true, slug: true } },
      },
    });
  }

  async updatePlan(id: string, data: Prisma.PlanUncheckedUpdateInput) {
    return this.prisma.plan.update({ where: { id }, data });
  }

  // ============================
  // 会话（API Key 活跃度）
  // ============================

  async findRecentActiveSessions(skip: number, take: number) {
    return this.prisma.apiKey.findMany({
      where: { lastUsedAt: { not: null } },
      orderBy: { lastUsedAt: 'desc' },
      take,
      skip,
      include: { user: { select: { id: true, email: true, nickname: true } } },
    });
  }

  async countActiveSessions() {
    return this.prisma.apiKey.count({ where: { lastUsedAt: { not: null } } });
  }

  // ============================
  // 监控 & 告警
  // ============================

  async findChannelsForHealth() {
    return this.prisma.channel.findMany({ orderBy: { priority: 'asc' } });
  }

  async findAlerts() {
    return this.prisma.alert.findMany({ orderBy: { createdAt: 'desc' } });
  }

  async createAlert(data: Prisma.AlertCreateInput) {
    return this.prisma.alert.create({ data });
  }

  async updateAlert(id: string, data: Prisma.AlertUpdateInput) {
    return this.prisma.alert.update({ where: { id }, data });
  }

  async deleteAlert(id: string) {
    return this.prisma.alert.delete({ where: { id } });
  }

  // ============================
  // 公告
  // ============================

  async findAnnouncements(skip: number, take: number) {
    return this.prisma.announcement.findMany({
      orderBy: { createdAt: 'desc' },
      skip,
      take,
    });
  }

  async countAnnouncements() {
    return this.prisma.announcement.count();
  }

  async createAnnouncement(data: Prisma.AnnouncementCreateInput) {
    return this.prisma.announcement.create({ data });
  }

  async findAnnouncementById(id: string) {
    return this.prisma.announcement.findUnique({ where: { id } });
  }

  async updateAnnouncement(id: string, data: Prisma.AnnouncementUpdateInput) {
    return this.prisma.announcement.update({ where: { id }, data });
  }

  async deleteAnnouncement(id: string) {
    return this.prisma.announcement.delete({ where: { id } });
  }

  // ============================
  // 功能开关
  // ============================

  async findFeatureFlags() {
    return this.prisma.featureFlag.findMany({ orderBy: { key: 'asc' } });
  }

  async upsertFeatureFlag(key: string, data: { value: boolean; description: string; scope: string; scopeValue: string | null }) {
    return this.prisma.featureFlag.upsert({
      where: { key },
      update: data,
      create: { key, ...data },
    });
  }

  // ============================
  // 系统提示
  // ============================

  async findSystemPrompts() {
    return this.prisma.systemPrompt.findMany({ orderBy: { key: 'asc' } });
  }

  async findSystemPromptById(id: string) {
    return this.prisma.systemPrompt.findUnique({ where: { id } });
  }

  async findSystemPromptByKey(key: string) {
    return this.prisma.systemPrompt.findUnique({ where: { key } });
  }

  async upsertSystemPrompt(key: string, data: Prisma.SystemPromptUpdateInput, createData: Prisma.SystemPromptCreateInput) {
    return this.prisma.systemPrompt.upsert({
      where: { key },
      update: data,
      create: createData,
    });
  }

  // ============================
  // 系统配置
  // ============================

  async findSystemConfigs() {
    return this.prisma.systemConfig.findMany({ orderBy: { key: 'asc' } });
  }

  async upsertSystemConfig(key: string, value: string) {
    return this.prisma.systemConfig.upsert({
      where: { key },
      update: { value },
      create: { key, value },
    });
  }

  // ============================
  // 模型定价
  // ============================

  async findModelPricing() {
    return this.prisma.modelPricing.findMany({
      orderBy: { modelName: 'asc' },
      include: {
        priceTiers: {
          orderBy: [{ priority: 'desc' }, { minInputTokens: 'asc' }],
        },
      },
    });
  }

  async findModelPricingByName(modelName: string) {
    return this.prisma.modelPricing.findUnique({ where: { modelName } });
  }

  async upsertModelPricing(
    modelName: string,
    data: {
      inputPricePerMToken: number;
      outputPricePerMToken: number;
      isActive: boolean;
      // v2 catalog fields (PR4) — all optional; when undefined, do not touch the column.
      provider?: string | null;
      modelId?: string | null;
      description?: string | null;
      inputModalities?: string | null;
      outputModalities?: string | null;
      contextLength?: number | null;
      maxOutputTokens?: number | null;
      providerLogo?: string | null;
      isPublished?: boolean;
      displayOrder?: number;
      releaseAt?: Date | null;
      tags?: string | null;
      supportedFeatures?: string | null;
      modelType?: string | null;
      pricingUnit?: string | null;
      unitPriceUsd?: number | null;
      pricingMetadata?: Record<string, unknown> | null;
      cachedInputPrice?: number | null;
      batchDiscount?: number | null;
      // v3 fields (2026-05-02) — full pricing dimensions
      cacheWrite5minPrice?: number | null;
      cacheWrite1hPrice?: number | null;
      minCacheTokens?: number | null;
      longContextThreshold?: number | null;
      longContextInputPrice?: number | null;
      longContextOutputPrice?: number | null;
      audioInputPrice?: number | null;
      imageInputPrice?: number | null;
      imageOutputPrice?: number | null;
      reasoningOutputPrice?: number | null;
      fastModeMultiplier?: number | null;
      regionResidencyMultiplier?: number | null;
      offPeakDiscountPct?: number | null;
      batchInputDiscount?: number | null;
      batchOutputDiscount?: number | null;
      pricingSource?: string | null;
      pricingSyncedAt?: Date | null;
      pricingFrozen?: boolean;
      // v4 — 调用层默认值（不是定价）
      defaultThinkingMode?: string | null;
      defaultThinkingBudget?: number | null;
      priceTiers?: Array<{
        tierKey: string;
        displayName?: string | null;
        minInputTokens: number;
        maxInputTokensExclusive?: number | null;
        inputPricePerMToken: number;
        outputPricePerMToken: number;
        cachedInputPrice?: number | null;
        cacheWritePrice?: number | null;
        bandSchedule?: unknown;
        currency?: string | null;
        rawCondition?: string | null;
        source?: string | null;
        priority?: number;
        isActive?: boolean;
      }>;
    },
  ) {
    // Build update/create payloads — only set v2/v3 fields that the caller
    // explicitly passed, so we don't clobber existing values with undefined.
    const optionalFields: Record<string, unknown> = {};
    const optionalKeys = [
      // v2
      'provider', 'modelId', 'description', 'inputModalities', 'outputModalities',
      'contextLength', 'maxOutputTokens', 'providerLogo', 'isPublished',
      'displayOrder', 'releaseAt', 'tags', 'supportedFeatures',
      'modelType', 'pricingUnit', 'unitPriceUsd', 'pricingMetadata',
      'cachedInputPrice', 'batchDiscount',
      // v3
      'cacheWrite5minPrice', 'cacheWrite1hPrice', 'minCacheTokens',
      'longContextThreshold', 'longContextInputPrice', 'longContextOutputPrice',
      'audioInputPrice', 'imageInputPrice', 'imageOutputPrice',
      'reasoningOutputPrice',
      'fastModeMultiplier', 'regionResidencyMultiplier', 'offPeakDiscountPct',
      'batchInputDiscount', 'batchOutputDiscount',
      'pricingSource', 'pricingSyncedAt', 'pricingFrozen',
      // v4 调用层默认值
      'defaultThinkingMode', 'defaultThinkingBudget',
    ] as const;
    for (const key of optionalKeys) {
      if ((data as Record<string, unknown>)[key] !== undefined) {
        const value = (data as Record<string, unknown>)[key];
        optionalFields[key] = key === 'pricingMetadata' && value === null
          ? Prisma.DbNull
          : value;
      }
    }
    const base = {
      inputPricePerMToken: data.inputPricePerMToken,
      outputPricePerMToken: data.outputPricePerMToken,
      isActive: data.isActive,
    };
    // 单一交互式事务 + 按 modelName 的 advisory 锁：原三步（upsert 行 / deleteMany /
    // createMany tiers）非事务，并发保存可各自过校验后留下 OFF_PEAK 与上下文档共存
    // （XOR 破坏）。advisory 锁兜住"新建模型无父行可锁"的并发；锁内以**最终态**
    // （本次传入值 ∪ 现值）复核 OFF_PEAK 约束——省略 priceTiers 的部分更新只读现档
    // 校验、不删除重建。
    await this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${'model_pricing:' + modelName}))`;
      // 下架闸门：只有本次会把模型置为 inactive 时才校验。必须在**锁内**——否则两个并发
      // 请求各自查到"没有未结算事件"再各自写 false，闸门等于不存在。
      if (data.isActive === false) {
        await assertNoUnsettledGatewayEvents(tx, [modelName]);
      }
      const row = await tx.modelPricing.upsert({
        where: { modelName },
        update: { ...base, ...optionalFields },
        create: { modelName, ...base, ...optionalFields },
      });
      // 结算取价窗口与 isActive 同步维护（见 schema 里 startsAt/endsAt 的注释）：
      // 下架时封窗口，让积压中的历史事件仍能按 occurredAt 取到当时的价；
      // 复架时重开窗口 —— 运营重新启用该模型就意味着它的价重新可用（P0 抢修就是这个动作）。
      if (row.isActive === false && row.endsAt === null) {
        await tx.modelPricing.update({ where: { id: row.id }, data: { endsAt: new Date() } });
      } else if (row.isActive === true && row.endsAt !== null) {
        await tx.modelPricing.update({ where: { id: row.id }, data: { endsAt: null } });
      }
      const finalTiers = data.priceTiers !== undefined
        ? data.priceTiers
        : (await tx.modelPricingTier.findMany({
            where: { modelPricingId: row.id },
            select: { tierKey: true, isActive: true, bandSchedule: true },
          })).map((tier) => ({ tierKey: tier.tierKey, isActive: tier.isActive, bandSchedule: tier.bandSchedule }));
      const offPeakTiers = finalTiers.filter((tier) => tier.tierKey === 'OFF_PEAK');
      if (offPeakTiers.length > 0) {
        const finalPricingUnit = row.pricingUnit ?? null;
        if (finalPricingUnit != null && finalPricingUnit !== 'token_1m') {
          throw new BadRequestException(
            `非 token 计价模型（pricingUnit=${finalPricingUnit}）不可配置 OFF_PEAK 时段档`,
          );
        }
        if (finalTiers.length > 1) {
          throw new BadRequestException('OFF_PEAK 时段档必须是该模型唯一的价格档（与上下文分档二选一）');
        }
      }
      if (data.priceTiers !== undefined) {
        await tx.modelPricingTier.deleteMany({
          where: { modelPricingId: row.id },
        });
        if (data.priceTiers.length > 0) {
          await tx.modelPricingTier.createMany({
            data: data.priceTiers.map((tier) => ({
              modelPricingId: row.id,
              tierKey: tier.tierKey,
              displayName: tier.displayName ?? null,
              minInputTokens: tier.minInputTokens,
              maxInputTokensExclusive: tier.maxInputTokensExclusive ?? null,
              inputPricePerMToken: tier.inputPricePerMToken,
              outputPricePerMToken: tier.outputPricePerMToken,
              cachedInputPrice: tier.cachedInputPrice ?? null,
              cacheWritePrice: tier.cacheWritePrice ?? null,
              bandSchedule: tier.bandSchedule == null
                ? Prisma.DbNull
                : (tier.bandSchedule as Prisma.InputJsonValue),
              currency: tier.currency ?? 'USD',
              rawCondition: tier.rawCondition ?? null,
              source: tier.source ?? null,
              priority: tier.priority ?? 0,
              isActive: tier.isActive ?? true,
            })),
          });
        }
      }
    });
    return this.prisma.modelPricing.findUnique({
      where: { modelName },
      include: {
        priceTiers: {
          orderBy: [{ priority: 'desc' }, { minInputTokens: 'asc' }],
        },
      },
    });
  }

  async createModelPricing(modelName: string, data: Partial<{
    provider: string | null;
    modelType: string | null;
    pricingUnit: string | null;
    unitPriceUsd: number | null;
    pricingMetadata: Record<string, unknown> | null;
    inputModalities: string | null;
    outputModalities: string | null;
    supportedFeatures: string | null;
    isPublished: boolean;
  }> = {}) {
    const { pricingMetadata, ...rest } = data;
    const createData: Prisma.ModelPricingCreateInput = {
      modelName,
      ...rest,
      ...(pricingMetadata !== undefined
        ? { pricingMetadata: pricingMetadata === null ? Prisma.DbNull : pricingMetadata as Prisma.InputJsonObject }
        : {}),
    };
    return this.prisma.modelPricing.create({
      data: createData,
    });
  }

  /**
   * 批量禁用不在指定 keep 集合内的 active ModelPricing 条目。
   * 用于 deactivateOrphanModelPricing —— 清理 Channel 表不再覆盖的历史定价。
   */
  async deactivateModelPricingNotIn(keepModelNames: string[]) {
    // where 只命中 isActive=true 的行（窗口本来就是开着的），所以这里可以无条件封窗口。
    // 不封的话，取价谓词（不看 isActive）会把这些退役模型当成永久有效。
    return this.prisma.modelPricing.updateMany({
      where: {
        isActive: true,
        modelName: { notIn: keepModelNames },
      },
      data: { isActive: false, endsAt: new Date() },
    });
  }

  /**
   * 批量将所有 isActive=true 但 isPublished=false 的模型上架。
   * 用于历史数据初始化(早期录入时未勾选上架)。
   */
  async publishAllActiveModelPricing() {
    return this.prisma.modelPricing.updateMany({
      where: { isActive: true, isPublished: false },
      data: { isPublished: true },
    });
  }

  /** 物理删除一个 ModelPricing 行（按 modelName）。调用方负责前置引用检查。 */
  async deleteModelPricingByName(modelName: string) {
    return this.prisma.modelPricing.delete({ where: { modelName } });
  }

  /**
   * 查询所有引用该 modelName 的 ModelAccess 行。返回带 plan 名称的精简列表，
   * 给删除前的"引用阻塞"检查用 — 出错信息能告诉运营具体哪个套餐还在用。
   */
  async findModelAccessReferences(
    modelName: string,
  ): Promise<Array<{ planId: string; planName: string | null }>> {
    const rows = await this.prisma.modelAccess.findMany({
      where: { modelName, isActive: true },
      select: {
        planId: true,
        plan: { select: { name: true } },
      },
    });
    return rows.map((r) => ({ planId: r.planId, planName: r.plan?.name ?? null }));
  }

  async findActiveModelPricingNotIn(keepModelNames: string[]) {
    return this.prisma.modelPricing.findMany({
      where: {
        isActive: true,
        modelName: { notIn: keepModelNames },
      },
      select: { modelName: true },
    });
  }

  async findActiveModelAccessNames() {
    const rows = await this.prisma.modelAccess.findMany({
      where: {
        isActive: true,
        plan: { is: { isActive: true } },
      },
      select: { modelName: true },
      distinct: ['modelName'],
    });
    return rows.map((r) => r.modelName);
  }

  // ============================
  // 模型访问矩阵
  // ============================

  async findModelAccess() {
    return this.prisma.modelAccess.findMany({
      include: { plan: { select: { name: true } } },
      orderBy: [{ planId: 'asc' }, { modelName: 'asc' }],
    });
  }

  async upsertModelAccess(planId: string, modelName: string, data: { isActive: boolean; creditMultiplier?: number }) {
    return this.prisma.modelAccess.upsert({
      where: { planId_modelName: { planId, modelName } },
      update: data,
      create: { planId, modelName, ...data },
    });
  }

  async findModelRoutePolicies() {
    return this.prisma.modelRoutePolicy.findMany({
      include: { plan: { select: { name: true } } },
      orderBy: [{ planId: 'asc' }, { routeKey: 'asc' }],
    });
  }

  async upsertModelRoutePolicy(
    planId: string,
    routeKey: string,
    data: { primaryModel?: string | null; fallbackModels?: string; isActive?: boolean },
  ) {
    return this.prisma.modelRoutePolicy.upsert({
      where: { planId_routeKey: { planId, routeKey } },
      update: data,
      create: { planId, routeKey, ...data },
    });
  }

  // ============================
  // 同步辅助
  // ============================

  async findProductById(id: string) {
    return this.prisma.product.findFirst({ where: { id, deletedAt: null } });
  }

  async findPlansByIds(ids: string[]) {
    return this.prisma.plan.findMany({ where: { id: { in: ids } }, select: { id: true, productId: true } });
  }
}
