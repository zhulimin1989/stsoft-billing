import { Injectable } from '@nestjs/common';
import { PrismaService } from '../prisma/prisma.service';
import {
  OrderStatus,
  OrderType,
  PayChannel,
  PaymentCheckoutInitState,
} from '@prisma/client';

@Injectable()
export class PaymentRepository {
  constructor(private readonly prisma: PrismaService) {}

  async findPlanById(id: string) {
    return this.prisma.plan.findUnique({ where: { id } });
  }

  /**
   * 查询 plan + 指定币种 price。
   * 返回 plan 本身及 plan_prices(planId, currency) 记录（如不存在返回 null price）。
   */
  async findPlanWithPrice(id: string, currency: string) {
    const plan = await this.prisma.plan.findFirst({
      where: { id, deletedAt: null },
      include: {
        prices: {
          where: { currency: currency.toLowerCase(), isActive: true },
          take: 1,
        },
        product: {
          select: { id: true, slug: true, name: true, billingMode: true, codingPlanFulfillmentMode: true, isActive: true },
        },
      },
    });
    if (!plan) return null;
    return {
      plan,
      price: plan.prices?.[0] ?? null,
    };
  }

  async findBundleSkuForCheckout(id: string) {
    return this.prisma.bundleSku.findUnique({
      where: { id },
      include: {
        items: {
          orderBy: { sortOrder: 'asc' },
          include: {
            product: true,
            plan: true,
            boosterPack: true,
          },
        },
      },
    });
  }

  async createOrder(data: {
    userId: string;
    tenantId: string;
    billingAccountId: string;
    orderType?: OrderType;
    bundleSkuId?: string | null;
    productId?: string | null;
    planId?: string | null;
    boosterPackId?: string | null;
    amountCents: number;
    currency?: string;
    rechargeTierId?: string | null;
    bonusCents?: number;
    channel?: PayChannel | null;
    status?: OrderStatus;
    paidAt?: Date;
    tradeNo?: string | null;
    paymentProviderInstanceId?: string | null;
    idempotencyKey?: string | null;
    partnerIdempotencyKey?: string | null;
    idempotencyFingerprint?: string | null;
    campaignId?: string | null;
    discountCodeId?: string | null;
    originalAmountCents?: number | null;
    discountAmountCents?: number | null;
    billingPeriod?: string | null;
    prorationCreditCents?: number | null;
    prorationSourcePlanId?: string | null;
    prorationSourceEntitlementId?: string | null;
    prorationRemainingCredits?: number | null;
    prorationMonthlyCredits?: number | null;
    checkoutContextEncrypted?: string | null;
  }) {
    return this.prisma.order.create({ data });
  }

  async updateOrderStatus(id: string, data: { status: OrderStatus; tradeNo?: string; channel?: PayChannel; paidAt?: Date; refundedAt?: Date; refundReason?: string }) {
    return this.prisma.order.update({ where: { id }, data });
  }

  private productScopeWhere(productId?: string | null) {
    return productId
      ? {
          OR: [
            // 普通单产品订单没有 order_items，按订单自身 productId 授权。
            { productId, items: { none: {} } },
            // Bundle 只有在每个 item 都明确属于该产品时才可作为单产品订单暴露。
            // “任一 item 命中”会让单产品 Partner 读取/取消影响其他产品的整单。
            {
              items: {
                some: { productId },
                none: {
                  OR: [
                    { productId: null },
                    { productId: { not: productId } },
                  ],
                },
              },
            },
          ],
        }
      : {};
  }

  private tenantScopeWhere(tenantId?: string | null) {
    const normalized = tenantId?.trim();
    if (!normalized) throw new Error('tenantId is required for order queries');
    return { tenantId: normalized };
  }

  async findOrderByIdAndUser(
    orderId: string,
    userId: string,
    tenantId?: string | null,
    productId?: string | null,
  ) {
    return this.prisma.order.findFirst({
      where: {
        id: orderId,
        userId,
        ...this.tenantScopeWhere(tenantId),
        ...this.productScopeWhere(productId),
      },
    });
  }

  async findOrderStatusByIdAndUser(
    orderId: string,
    userId: string,
    tenantId?: string | null,
    productId?: string | null,
  ) {
    return this.prisma.order.findFirst({
      where: {
        id: orderId,
        userId,
        ...this.tenantScopeWhere(tenantId),
        ...this.productScopeWhere(productId),
      },
      select: { status: true, paidAt: true, cancelReason: true },
    });
  }

  async findOrderById(id: string) {
    return this.prisma.order.findUnique({
      where: { id },
      include: { product: true, plan: true, boosterPack: true },
    });
  }

  // finding: 自营 CodingPlan 订单是 per-user（实际落 personal tenant）——按 (orderId, userId) 授权、
  // 不加当前工作区 tenant 过滤。仅供自营分支使用（调用方须先确认自营），非自营维持 tenant 作用域查询。
  async findOrderStatusOwnedByUser(orderId: string, userId: string, productId?: string | null) {
    return this.prisma.order.findFirst({
      where: { id: orderId, userId, ...this.productScopeWhere(productId) },
      select: { status: true, paidAt: true, cancelReason: true },
    });
  }

  async findOrderOwnedByUser(orderId: string, userId: string, productId?: string | null) {
    return this.prisma.order.findFirst({
      where: { id: orderId, userId, ...this.productScopeWhere(productId) },
    });
  }

  /**
   * 判定订单是否自营 CodingPlan——product 或 plan.product 任一同时满足
   * `billingMode==='CODING_PLAN' && codingPlanFulfillmentMode==='platform_model_package'`（严格双条件，
   * 防脏数据里非 CODING_PLAN 产品带该 mode 被误放进 per-user 分支绕过工作区 gate，codex）。
   */
  async isSelfOpCodingPlanOrderOwnedByUser(orderId: string, userId: string): Promise<boolean> {
    const row = await this.prisma.order.findFirst({
      where: { id: orderId, userId },
      select: {
        product: { select: { billingMode: true, codingPlanFulfillmentMode: true } },
        plan: { select: { product: { select: { billingMode: true, codingPlanFulfillmentMode: true } } } },
      },
    });
    if (!row) return false;
    const isSelfOp = (p?: { billingMode: string; codingPlanFulfillmentMode: string | null } | null) =>
      p?.billingMode === 'CODING_PLAN' && p?.codingPlanFulfillmentMode === 'platform_model_package';
    return isSelfOp(row.product) || isSelfOp(row.plan?.product);
  }

  async findUserOrders(
    userId: string,
    skip: number,
    take: number,
    status?: string,
    orderType?: string,
    tenantId?: string | null,
    productId?: string | null,
  ) {
    return this.prisma.order.findMany({
      where: {
        userId,
        ...this.tenantScopeWhere(tenantId),
        ...(status ? { status: status as OrderStatus } : {}),
        ...(orderType ? { orderType: orderType as OrderType } : {}),
        ...this.productScopeWhere(productId),
      },
      orderBy: { createdAt: 'desc' },
      skip,
      take,
      include: { product: true, plan: true, boosterPack: true },
    });
  }

  async countUserOrders(
    userId: string,
    status?: string,
    orderType?: string,
    tenantId?: string | null,
    productId?: string | null,
  ) {
    return this.prisma.order.count({
      where: {
        userId,
        ...this.tenantScopeWhere(tenantId),
        ...(status ? { status: status as OrderStatus } : {}),
        ...(orderType ? { orderType: orderType as OrderType } : {}),
        ...this.productScopeWhere(productId),
      },
    });
  }

  async findLegacyIdempotentOrder(
    idempotencyKey: string,
    userId: string,
    tenantId: string,
    productId: string,
  ) {
    return this.prisma.order.findFirst({
      where: {
        idempotencyKey,
        userId,
        ...this.tenantScopeWhere(tenantId),
        ...this.productScopeWhere(productId),
      },
    });
  }

  async findPartnerIdempotentOrder(
    partnerIdempotencyKey: string,
    userId: string,
    productId: string,
  ) {
    return this.prisma.order.findFirst({
      where: {
        partnerIdempotencyKey,
        userId,
        ...this.productScopeWhere(productId),
      },
    });
  }

  async migrateLegacyIdempotencyKey(
    orderId: string,
    legacyKey: string,
    namespacedKey: string,
    normalizedFingerprint: string,
  ): Promise<boolean> {
    const result = await this.prisma.order.updateMany({
      where: {
        id: orderId,
        idempotencyKey: legacyKey,
      },
      data: {
        partnerIdempotencyKey: namespacedKey,
        idempotencyFingerprint: normalizedFingerprint,
      },
    });
    return result.count === 1;
  }

  async claimCheckoutInitialization(
    orderId: string,
    leaseId: string,
    now: Date,
    leaseExpiresAt: Date,
  ): Promise<boolean> {
    const result = await this.prisma.order.updateMany({
      where: {
        id: orderId,
        status: OrderStatus.PENDING,
        OR: [
          { checkoutInitState: PaymentCheckoutInitState.NOT_STARTED },
          { checkoutInitState: PaymentCheckoutInitState.OUTCOME_UNKNOWN },
          {
            checkoutInitState: PaymentCheckoutInitState.INITIALIZING,
            checkoutLeaseExpiresAt: { lte: now },
          },
        ],
      },
      data: {
        checkoutInitState: PaymentCheckoutInitState.INITIALIZING,
        checkoutLeaseId: leaseId,
        checkoutLeaseExpiresAt: leaseExpiresAt,
        checkoutPayUrlEncrypted: null,
        checkoutPayUrlExpiresAt: null,
      },
    });
    return result.count === 1;
  }

  async completeCheckoutInitialization(
    orderId: string,
    leaseId: string,
    data: {
      checkoutPayUrlEncrypted: string;
      checkoutPayUrlExpiresAt: Date;
      tradeNo?: string | null;
      paymentProviderInstanceId?: string | null;
    },
  ) {
    const result = await this.prisma.order.updateMany({
      where: {
        id: orderId,
        status: OrderStatus.PENDING,
        checkoutInitState: PaymentCheckoutInitState.INITIALIZING,
        checkoutLeaseId: leaseId,
      },
      data: {
        checkoutInitState: PaymentCheckoutInitState.READY,
        checkoutLeaseId: null,
        checkoutLeaseExpiresAt: null,
        checkoutPayUrlEncrypted: data.checkoutPayUrlEncrypted,
        checkoutPayUrlExpiresAt: data.checkoutPayUrlExpiresAt,
        checkoutProviderReference: data.tradeNo ?? null,
        ...(data.tradeNo ? { tradeNo: data.tradeNo } : {}),
        ...(data.paymentProviderInstanceId
          ? { paymentProviderInstanceId: data.paymentProviderInstanceId }
          : {}),
      },
    });
    if (result.count !== 1) return null;
    return this.prisma.order.findUnique({ where: { id: orderId } });
  }

  async releaseCheckoutInitialization(orderId: string, leaseId: string): Promise<boolean> {
    const result = await this.prisma.order.updateMany({
      where: {
        id: orderId,
        status: OrderStatus.PENDING,
        checkoutInitState: PaymentCheckoutInitState.INITIALIZING,
        checkoutLeaseId: leaseId,
      },
      data: {
        checkoutInitState: PaymentCheckoutInitState.NOT_STARTED,
        checkoutLeaseId: null,
        checkoutLeaseExpiresAt: null,
      },
    });
    return result.count === 1;
  }

  async markCheckoutOutcomeUnknown(orderId: string, leaseId: string): Promise<boolean> {
    const result = await this.prisma.order.updateMany({
      where: {
        id: orderId,
        status: OrderStatus.PENDING,
        checkoutInitState: PaymentCheckoutInitState.INITIALIZING,
        checkoutLeaseId: leaseId,
      },
      data: {
        checkoutInitState: PaymentCheckoutInitState.OUTCOME_UNKNOWN,
        checkoutLeaseId: null,
        checkoutLeaseExpiresAt: null,
        checkoutPayUrlEncrypted: null,
        checkoutPayUrlExpiresAt: null,
      },
    });
    return result.count === 1;
  }
}
