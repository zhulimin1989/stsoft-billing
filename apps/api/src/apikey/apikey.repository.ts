import { BadRequestException, ForbiddenException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { usdNumber } from '../billing/money';

type CreateApiKeyData = {
  userId: string;
  tenantId: string;
  productId?: string | null;
  codingPlanEntitlementId?: string | null;
  name: string;
  prefix: string;
  keyHash: string;
  allowedModels?: string | null;
  budgetUsd?: Prisma.Decimal | number | string | null;
};

type ProviderResaleEntitlementGuard = {
  entitlementId: string;
  exceptApiKeyId?: string;
};

/**
 * Legacy repository for the old billing-plane `/api/apikeys` module.
 *
 * Not used by the deployed `BillingRuntimeModule`. Keep new product and
 * entitlement-scoped key behavior in `codesphere-user`.
 */
@Injectable()
export class ApiKeyRepository {
  constructor(private readonly prisma: PrismaService) {}

  async countByTenant(tenantId: string, userId: string) {
    return this.prisma.apiKey.count({
      where: {
        tenantId,
        userId,
        deletedAt: null,
      },
    });
  }

  async create(data: CreateApiKeyData) {
    return this.prisma.apiKey.create({ data });
  }

  async createWithProviderResaleGuard(
    data: CreateApiKeyData,
    guard?: ProviderResaleEntitlementGuard | null,
  ) {
    if (!guard) return this.create(data);
    return this.prisma.$transaction(async (tx) => {
      await this.lockCodingPlanEntitlement(tx, guard.entitlementId);
      await this.assertNoActiveApiKeyForEntitlement(tx, guard.entitlementId, guard.exceptApiKeyId);
      return tx.apiKey.create({ data });
    });
  }

  async findActiveProductById(id: string) {
    return this.prisma.product.findFirst({
      where: { id, isActive: true, deletedAt: null },
      select: { id: true },
    });
  }

  async findActiveCodingPlanEntitlement(id: string) {
    return this.prisma.codingPlanEntitlement.findFirst({
      where: {
        id,
        status: 'ACTIVE',
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: {
        id: true,
        tenantId: true,
        productId: true,
        fulfillmentMode: true,
        providerEntitlement: {
          select: { id: true, status: true },
        },
      },
    });
  }

  async findByTenant(tenantId: string, userId: string) {
    return this.prisma.apiKey.findMany({
      where: {
        tenantId,
        userId,
        deletedAt: null,
      },
      include: { product: { select: { name: true } } },
      orderBy: { createdAt: 'desc' },
    });
  }

  async findByIdAndTenant(id: string, tenantId: string, userId: string) {
    return this.prisma.apiKey.findFirst({
      where: {
        id,
        tenantId,
        userId,
        deletedAt: null,
      },
    });
  }

  async findById(id: string) {
    return this.prisma.apiKey.findFirst({ where: { id, deletedAt: null } });
  }

  async deleteById(id: string) {
    // 软删除：TokenUsage 有外键引用，硬删除会报约束错误
    return this.prisma.apiKey.update({
      where: { id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  async updateIsActive(id: string, isActive: boolean) {
    return this.prisma.apiKey.update({ where: { id }, data: { isActive } });
  }

  async updateIsActiveWithProviderResaleGuard(
    id: string,
    isActive: boolean,
    guard?: ProviderResaleEntitlementGuard | null,
  ) {
    if (!guard) return this.updateIsActive(id, isActive);
    return this.prisma.$transaction(async (tx) => {
      await this.lockCodingPlanEntitlement(tx, guard.entitlementId);
      await this.assertNoActiveApiKeyForEntitlement(tx, guard.entitlementId, id);
      return tx.apiKey.update({ where: { id }, data: { isActive } });
    });
  }

  async findByKeyHash(keyHash: string) {
    return this.prisma.apiKey.findFirst({ where: { keyHash, deletedAt: null } });
  }

  async spendByKeyIds(apiKeyIds: string[]) {
    if (apiKeyIds.length === 0) return [];
    return this.prisma.tokenUsage.groupBy({
      by: ['apiKeyId'],
      where: {
        apiKeyId: { in: apiKeyIds },
      },
      _sum: { costUsd: true },
    });
  }

  async spendByKeyId(apiKeyId: string) {
    const result = await this.prisma.tokenUsage.aggregate({
      where: {
        apiKeyId,
      },
      _sum: { costUsd: true },
    });
    return usdNumber(result._sum.costUsd ?? 0);
  }

  async updateLastUsed(id: string) {
    return this.prisma.apiKey.update({
      where: { id },
      data: { lastUsedAt: new Date() },
    });
  }

  async resolveTenantId(
    userId: string,
    requestedTenantId?: string | null,
    allowedRoles?: string[],
  ): Promise<string> {
    const normalized = requestedTenantId?.trim();
    if (normalized) {
      const membership = await this.prisma.tenantMember.findFirst({
        where: {
          tenantId: normalized,
          userId,
          status: 'active',
          tenant: { status: 'active', deletedAt: null },
        },
        select: { tenantId: true, role: true },
      });
      if (!membership) {
        throw new ForbiddenException('无权访问该账号');
      }
      if (allowedRoles?.length && !allowedRoles.includes(membership.role)) {
        throw new ForbiddenException('无权管理该账号的 API Key');
      }
      return membership.tenantId;
    }

    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { currentTenantId: true },
    });
    if (user?.currentTenantId) {
      const membership = await this.prisma.tenantMember.findFirst({
        where: {
          userId,
          tenantId: user.currentTenantId,
          status: 'active',
          tenant: { status: 'active', deletedAt: null },
        },
        select: { tenantId: true, role: true },
      });
      if (membership && (!allowedRoles?.length || allowedRoles.includes(membership.role))) {
        return membership.tenantId;
      }
    }

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
        ...(allowedRoles?.length ? { role: { in: allowedRoles } } : {}),
      },
      select: { tenantId: true },
      orderBy: { joinedAt: 'asc' },
    });
    if (membership) return membership.tenantId;

    throw new BadRequestException('API Key 必须绑定账号 tenantId');
  }

  private async lockCodingPlanEntitlement(
    tx: Prisma.TransactionClient,
    entitlementId: string,
  ): Promise<void> {
    await tx.$queryRaw`SELECT id FROM coding_plan_entitlements WHERE id = ${entitlementId} FOR UPDATE`;
  }

  private async assertNoActiveApiKeyForEntitlement(
    tx: Prisma.TransactionClient,
    entitlementId: string,
    exceptApiKeyId?: string,
  ): Promise<void> {
    const existing = await tx.apiKey.findFirst({
      where: {
        codingPlanEntitlementId: entitlementId,
        isActive: true,
        deletedAt: null,
        ...(exceptApiKeyId ? { id: { not: exceptApiKeyId } } : {}),
      },
      select: { id: true },
    });
    if (existing) {
      throw new BadRequestException('CodingPlan 上游权益已绑定其它 active API Key');
    }
  }
}
