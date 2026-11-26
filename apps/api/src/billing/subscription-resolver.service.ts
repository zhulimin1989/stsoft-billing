import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';

export interface ResolvedSubscription {
  subscriptionId: string;
  entitlementKind?: 'subscription_period' | 'coding_plan_entitlement';
  codingPlanEntitlementId?: string | null;
  planId: string;
  productId: string;
  billingPeriod: string;
  fulfillmentMode?: string | null;
  providerEntitlementId?: string | null;
  providerLineId?: string | null;
  providerLineCode?: string | null;
  providerCode?: string | null;
  upstreamProductId?: string | null;
  plan: {
    id: string;
    name: string;
    monthlyCredits: number;
    usageMultiplier: number;
    rateLimitRpm: number;
    rateLimitTpm: number;
    maxContextWindow: number;
  };
}

export interface SubscriptionResolveOptions {
  tenantId?: string | null;
  codingPlanEntitlementId?: string | null;
}

@Injectable()
export class SubscriptionResolverService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async resolve(
    userId: string,
    productId: string,
    options: SubscriptionResolveOptions = {},
  ): Promise<ResolvedSubscription | null> {
    const entitlementId = options.codingPlanEntitlementId?.trim() || null;
    const productDelegate = (this.prisma as unknown as {
      product?: {
        findUnique: (args: {
          where: { id: string };
          select: { billingMode: true };
        }) => Promise<{ billingMode: string } | null>;
      };
    }).product;
    const product = productDelegate?.findUnique
      ? await productDelegate.findUnique({
          where: { id: productId },
          select: { billingMode: true },
        })
      : null;
    if (product?.billingMode === 'CODING_PLAN') {
      const tenantId = await this.resolveCodingPlanTenantId(userId, options.tenantId);
      const cacheKey = this.codingPlanCacheKey(productId, tenantId, entitlementId);
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        if (cached === 'none') return null;
        try { return JSON.parse(cached); } catch { /* fall through */ }
      }
      const result = await this.resolveCodingPlanEntitlement(productId, tenantId, entitlementId);
      await this.redis.set(cacheKey, result ? JSON.stringify(result) : 'none', 'EX', 600);
      if (result?.codingPlanEntitlementId) {
        await this.redis.sadd(
          this.codingPlanEntitlementSetKey(productId, tenantId),
          result.codingPlanEntitlementId,
        );
      }
      return result;
    }

    const tenantId = await this.resolveTenantId(userId, options.tenantId);
    const cacheKey = this.tenantCacheKey(productId, tenantId);
    const cached = await this.redis.get(cacheKey);
    if (cached) {
      if (cached === 'none') return null;
      try { return JSON.parse(cached); } catch { /* fall through */ }
    }

    const period = await this.prisma.subscriptionPeriod.findFirst({
      where: {
        tenantId,
        productId,
        status: 'ACTIVE',
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      include: {
        plan: {
          select: {
            id: true,
            name: true,
            monthlyCredits: true,
            usageMultiplier: true,
            rateLimitRpm: true,
            rateLimitTpm: true,
            maxContextWindow: true,
          },
        },
      },
      orderBy: [{ startedAt: 'desc' }, { createdAt: 'desc' }],
    });

    if (!period) {
      await this.redis.set(cacheKey, 'none', 'EX', 600);
      return null;
    }

    const result: ResolvedSubscription = {
      subscriptionId: period.id,
      entitlementKind: 'subscription_period',
      codingPlanEntitlementId: null,
      planId: period.planId,
      productId: period.productId,
      billingPeriod: period.billingPeriod,
      fulfillmentMode: null,
      plan: period.plan,
    };

    await this.redis.set(cacheKey, JSON.stringify(result), 'EX', 600);
    return result;
  }

  /**
   * First-receipt resolver for financial settlement anchors. It deliberately
   * bypasses Redis and uses the caller's transaction/DB clock so identity,
   * entitlement and pricing are read from one PostgreSQL snapshot.
   */
  async resolveAtReceipt(
    db: Prisma.TransactionClient,
    userId: string,
    productId: string,
    options: SubscriptionResolveOptions,
    receiptAt: Date,
  ): Promise<ResolvedSubscription | null> {
    const tenantId = options.tenantId?.trim();
    if (!tenantId) throw new BadRequestException('首次收件权益解析必须绑定 tenantId');
    const product = await db.product.findUnique({
      where: { id: productId },
      select: { billingMode: true },
    });
    if (!product) return null;
    const planSelect = {
      id: true,
      name: true,
      monthlyCredits: true,
      usageMultiplier: true,
      rateLimitRpm: true,
      rateLimitTpm: true,
      maxContextWindow: true,
    } as const;

    if (product.billingMode === 'CODING_PLAN') {
      const entitlementId = options.codingPlanEntitlementId?.trim() || null;
      const entitlement = await db.codingPlanEntitlement.findFirst({
        where: {
          ...(entitlementId ? { id: entitlementId } : {}),
          userId,
          tenantId,
          productId,
          status: 'ACTIVE',
          startedAt: { lte: receiptAt },
          OR: [{ expiresAt: null }, { expiresAt: { gt: receiptAt } }],
        },
        select: {
          id: true,
          planId: true,
          productId: true,
          billingPeriod: true,
          fulfillmentMode: true,
          providerEntitlementId: true,
          providerLineId: true,
          providerLineCode: true,
          providerCode: true,
          upstreamProductId: true,
        },
        orderBy: { createdAt: 'desc' },
      });
      if (!entitlement) return null;
      const plan = await db.plan.findUnique({
        where: { id: entitlement.planId },
        select: planSelect,
      });
      if (!plan) return null;
      return {
        subscriptionId: entitlement.id,
        entitlementKind: 'coding_plan_entitlement',
        codingPlanEntitlementId: entitlement.id,
        planId: entitlement.planId,
        productId: entitlement.productId,
        billingPeriod: entitlement.billingPeriod,
        fulfillmentMode: entitlement.fulfillmentMode,
        providerEntitlementId: entitlement.providerEntitlementId,
        providerLineId: entitlement.providerLineId,
        providerLineCode: entitlement.providerLineCode,
        providerCode: entitlement.providerCode,
        upstreamProductId: entitlement.upstreamProductId,
        plan,
      };
    }

    const period = await db.subscriptionPeriod.findFirst({
      where: {
        userId,
        tenantId,
        productId,
        status: 'ACTIVE',
        startedAt: { lte: receiptAt },
        OR: [{ expiresAt: null }, { expiresAt: { gt: receiptAt } }],
      },
      include: { plan: { select: planSelect } },
      orderBy: [{ startedAt: 'desc' }, { createdAt: 'desc' }],
    });
    if (!period) return null;
    return {
      subscriptionId: period.id,
      entitlementKind: 'subscription_period',
      codingPlanEntitlementId: null,
      planId: period.planId,
      productId: period.productId,
      billingPeriod: period.billingPeriod,
      fulfillmentMode: null,
      plan: period.plan,
    };
  }

  async invalidateCache(
    userId: string,
    productId: string,
    tenantId?: string | null,
    entitlementId?: string | null,
  ): Promise<void> {
    await this.redis.del(`sub:${userId}:${productId}`);
    if (tenantId) {
      await this.redis.del(this.tenantCacheKey(productId, tenantId));
      await this.invalidateCodingPlanCache(productId, tenantId, entitlementId);
      return;
    }
    await this.redis.del(`sub:user:${userId}:${productId}`);
    const personalTenantId = await this.resolvePersonalTenantId(userId).catch(() => null);
    if (personalTenantId) {
      await this.redis.del(this.tenantCacheKey(productId, personalTenantId));
      await this.invalidateCodingPlanCache(productId, personalTenantId, entitlementId);
    }
  }

  private async resolveCodingPlanEntitlement(
    productId: string,
    tenantId: string,
    entitlementId: string | null,
  ): Promise<ResolvedSubscription | null> {
    const planSelect = {
      id: true,
      name: true,
      monthlyCredits: true,
      usageMultiplier: true,
      rateLimitRpm: true,
      rateLimitTpm: true,
      maxContextWindow: true,
    };
    const activeWhere = {
      tenantId,
      productId,
      status: 'ACTIVE' as const,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    };
    const entitlement = await this.prisma.codingPlanEntitlement.findFirst({
      where: entitlementId ? { ...activeWhere, id: entitlementId } : activeWhere,
      select: {
        id: true,
        planId: true,
        productId: true,
        billingPeriod: true,
        fulfillmentMode: true,
        providerEntitlementId: true,
        providerLineId: true,
        providerLineCode: true,
        providerCode: true,
        upstreamProductId: true,
      },
      orderBy: { createdAt: 'desc' },
    });
    if (!entitlement) return null;
    const plan = await this.prisma.plan.findUnique({
      where: { id: entitlement.planId },
      select: planSelect,
    });
    if (!plan) return null;
    return {
      subscriptionId: entitlement.id,
      entitlementKind: 'coding_plan_entitlement',
      codingPlanEntitlementId: entitlement.id,
      planId: entitlement.planId,
      productId: entitlement.productId,
      billingPeriod: entitlement.billingPeriod,
      fulfillmentMode: entitlement.fulfillmentMode,
      providerEntitlementId: entitlement.providerEntitlementId,
      providerLineId: entitlement.providerLineId,
      providerLineCode: entitlement.providerLineCode,
      providerCode: entitlement.providerCode,
      upstreamProductId: entitlement.upstreamProductId,
      plan,
    };
  }

  private codingPlanCacheKey(productId: string, tenantId: string, entitlementId?: string | null): string {
    return entitlementId
      ? `sub:tenant:${tenantId}:${productId}:entitlement:${entitlementId}`
      : this.tenantCacheKey(productId, tenantId);
  }

  private codingPlanEntitlementSetKey(productId: string, tenantId: string): string {
    return `sub:tenant:${tenantId}:${productId}:entitlements`;
  }

  private async invalidateCodingPlanCache(
    productId: string,
    tenantId: string,
    entitlementId?: string | null,
  ): Promise<void> {
    const normalizedEntitlementId = entitlementId?.trim() || null;
    const setKey = this.codingPlanEntitlementSetKey(productId, tenantId);
    if (normalizedEntitlementId) {
      await this.redis.del(this.codingPlanCacheKey(productId, tenantId, normalizedEntitlementId));
      await this.redis.srem(setKey, normalizedEntitlementId).catch(() => undefined);
      return;
    }

    const entitlementIds = await this.redis.smembers(setKey).catch(() => []);
    if (entitlementIds.length > 0) {
      await this.redis.del(
        ...entitlementIds.map((id) => this.codingPlanCacheKey(productId, tenantId, id)),
      );
    }
    await this.redis.del(setKey);
  }

  private tenantCacheKey(productId: string, tenantId: string): string {
    return `sub:tenant:${tenantId}:${productId}`;
  }

  private async resolveTenantId(userId: string, tenantId?: string | null): Promise<string> {
    const explicitTenantId = tenantId?.trim();
    if (explicitTenantId) return explicitTenantId;

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { currentTenantId: true },
    });
    if (user?.currentTenantId) return user.currentTenantId;

    const personalTenant = await this.prisma.tenant.findFirst({
      where: {
        ownerUserId: userId,
        type: 'personal',
        status: 'active',
        deletedAt: null,
      },
      select: { id: true },
    });
    if (personalTenant) return personalTenant.id;

    const membership = await this.prisma.tenantMember.findFirst({
      where: {
        userId,
        status: 'active',
        tenant: { status: 'active', deletedAt: null },
      },
      select: { tenantId: true },
      orderBy: { joinedAt: 'asc' },
    });
    if (membership) return membership.tenantId;

    throw new BadRequestException('订阅解析必须绑定账号 tenantId');
  }

  private async resolveCodingPlanTenantId(userId: string, tenantId?: string | null): Promise<string> {
    const explicitTenantId = tenantId?.trim();
    if (explicitTenantId) return explicitTenantId;
    return this.resolvePersonalTenantId(userId);
  }

  private async resolvePersonalTenantId(userId: string): Promise<string> {
    const personalTenant = await this.prisma.tenant.findFirst({
      where: {
        ownerUserId: userId,
        type: 'personal',
        status: 'active',
        deletedAt: null,
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    if (personalTenant) return personalTenant.id;
    throw new BadRequestException('订阅解析必须绑定账号 tenantId');
  }
}
