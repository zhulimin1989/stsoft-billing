import { ConflictException, Injectable } from '@nestjs/common';
import {
  CodingPlanEntitlementStatus,
  CodingPlanFulfillmentMode,
  Prisma,
  SubscriptionStatus,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import type { BillingPeriod } from '@ruidong/shared';

export interface ActivateSubscriptionInput {
  userId: string;
  tenantId: string;
  billingAccountId?: string | null;
  productId: string;
  planId: string;
  billingPeriod: BillingPeriod;
  startedAt: Date;
  expiresAt: Date | null;
  provisionReceiptId?: string | null;
  activationIdempotencyKey?: string | null;
  requiredCompletedOrderId?: string | null;
  requireNoActiveSubscription?: boolean;
}

export interface ActivatedSubscriptionPeriod {
  contractId: string;
  periodId: string;
  entitlementId: string;
}

export interface EnsuredSubscriptionPeriod extends ActivatedSubscriptionPeriod {
  planId: string;
  provisionReceiptId: string | null;
  created: boolean;
}

export interface EnsuredCodingPlanEntitlement {
  id: string;
  userId: string;
  tenantId: string;
  productId: string;
  planId: string;
  provisionReceiptId: string | null;
  status: CodingPlanEntitlementStatus;
  expiresAt: Date | null;
  created: boolean;
}

export interface ActivateCodingPlanIfAbsentInput {
  userId: string;
  tenantId: string;
  productId: string;
  planId: string;
  startedAt: Date;
  expiresAt: Date | null;
  provisionReceiptId: string;
}

export interface CurrentSubscriptionPeriod {
  periodId: string;
  contractId: string;
  userId: string;
  tenantId: string;
  productId: string;
  planId: string;
  provisionReceiptId: string | null;
  expiresAt: Date | null;
}

export interface CloseSubscriptionInput {
  tenantId: string;
  productId?: string;
  planId?: string;
  status: Extract<SubscriptionStatus, 'EXPIRED' | 'CANCELLED'>;
  endedAt: Date;
  terminationReason: string;
}

export interface CloseSubscriptionActivationInput {
  activationIdempotencyKey: string;
  userId: string;
  tenantId: string;
  productId: string;
  planId: string;
  endedAt: Date;
  terminationReason: string;
}

export interface CloseSubscriptionActivationFamilyInput {
  initialActivationIdempotencyKey: string;
  renewalActivationIdempotencyPrefix: string;
  userId: string;
  tenantId: string;
  productId: string;
  planId: string;
  endedAt: Date;
  terminationReason: string;
}

@Injectable()
export class SubscriptionLifecycleService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  async activate(input: ActivateSubscriptionInput): Promise<ActivatedSubscriptionPeriod> {
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockActivationScope(tx, input.tenantId, input.productId);
      if (input.requiredCompletedOrderId) {
        const payableOrder = await tx.order.findFirst({
          where: {
            id: input.requiredCompletedOrderId,
            tenantId: input.tenantId,
            status: 'COMPLETED',
            providerSubscriptionEndedAt: null,
          },
          select: { id: true },
        });
        if (!payableOrder) {
          throw new ConflictException('Subscription renewal order is no longer payable');
        }
      }
      if (input.activationIdempotencyKey) {
        const existing = await tx.subscriptionPeriod.findUnique({
          where: { activationIdempotencyKey: input.activationIdempotencyKey },
          select: {
            id: true,
            contractId: true,
            userId: true,
            tenantId: true,
            productId: true,
            planId: true,
            billingPeriod: true,
            entitlements: {
              where: { entitlementType: 'plan_access' },
              select: { id: true },
              take: 1,
            },
          },
        });
        if (existing) {
          if (
            existing.userId !== input.userId
            || existing.tenantId !== input.tenantId
            || existing.productId !== input.productId
            || existing.planId !== input.planId
            || existing.billingPeriod !== input.billingPeriod
            || !existing.entitlements[0]?.id
          ) {
            throw new ConflictException('Subscription activation idempotency key payload mismatch');
          }
          return {
            contractId: existing.contractId,
            periodId: existing.id,
            entitlementId: existing.entitlements[0].id,
          };
        }
      }
      if (input.requireNoActiveSubscription) {
        const active = await tx.subscriptionPeriod.findFirst({
          where: {
            tenantId: input.tenantId,
            productId: input.productId,
            status: 'ACTIVE',
            OR: [{ expiresAt: null }, { expiresAt: { gt: input.startedAt } }],
          },
          select: { id: true },
        });
        if (active) {
          throw new ConflictException(
            'Bundle subscription fulfillment requires an empty product entitlement scope',
          );
        }
      }
      return this.activateInTransaction(tx, input);
    });
    await this.invalidateCaches(input.userId, input.tenantId, input.productId);
    return result;
  }

  /**
   * Provisioning must never replace an active paid subscription. This method
   * shares the exact tenant/product advisory lock used by normal activation,
   * then atomically returns the winner or creates the requested period.
   */
  async activateIfAbsent(input: ActivateSubscriptionInput): Promise<EnsuredSubscriptionPeriod> {
    const result = await this.prisma.$transaction(async (tx) => {
      await this.lockActivationScope(tx, input.tenantId, input.productId);
      const existing = await tx.subscriptionPeriod.findFirst({
        where: {
          tenantId: input.tenantId,
          productId: input.productId,
          status: 'ACTIVE',
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: {
          id: true,
          contractId: true,
          planId: true,
          provisionReceiptId: true,
          entitlements: {
            where: {
              entitlementType: 'plan_access',
              status: 'ACTIVE',
            },
            select: { id: true },
            take: 1,
          },
        },
        orderBy: [{ startedAt: 'desc' }, { createdAt: 'desc' }],
      });
      if (existing) {
        const entitlementId = existing.entitlements[0]?.id;
        if (!entitlementId) {
          throw new ConflictException('Active subscription entitlement is missing');
        }
        return {
          contractId: existing.contractId,
          periodId: existing.id,
          entitlementId,
          planId: existing.planId,
          provisionReceiptId: existing.provisionReceiptId,
          created: false,
        };
      }

      const created = await this.activateInTransaction(tx, input);
      return {
        ...created,
        planId: input.planId,
        provisionReceiptId: input.provisionReceiptId ?? null,
        created: true,
      };
    });
    await this.invalidateCaches(input.userId, input.tenantId, input.productId);
    return result;
  }

  async closeActivation(
    input: CloseSubscriptionActivationInput,
  ): Promise<boolean> {
    const closed = await this.prisma.$transaction(async (tx) => {
      await this.lockActivationScope(tx, input.tenantId, input.productId);
      const period = await tx.subscriptionPeriod.findUnique({
        where: { activationIdempotencyKey: input.activationIdempotencyKey },
        select: {
          id: true,
          contractId: true,
          userId: true,
          tenantId: true,
          productId: true,
          planId: true,
          status: true,
        },
      });
      if (!period) return false;
      if (
        period.userId !== input.userId
        || period.tenantId !== input.tenantId
        || period.productId !== input.productId
        || period.planId !== input.planId
      ) {
        throw new ConflictException('Subscription activation cancellation payload mismatch');
      }
      if (period.status !== 'ACTIVE') return true;

      await tx.subscriptionEntitlement.updateMany({
        where: { periodId: period.id, status: 'ACTIVE' },
        data: {
          status: 'CANCELLED',
          endedAt: input.endedAt,
          terminationReason: input.terminationReason,
        },
      });
      await tx.subscriptionPeriod.updateMany({
        where: { id: period.id, status: 'ACTIVE' },
        data: {
          status: 'CANCELLED',
          endedAt: input.endedAt,
          terminationReason: input.terminationReason,
        },
      });
      await tx.subscriptionContract.updateMany({
        where: { id: period.contractId, status: 'ACTIVE' },
        data: {
          status: 'CANCELLED',
          endedAt: input.endedAt,
          terminationReason: input.terminationReason,
        },
      });
      return true;
    });
    await this.invalidateCaches(input.userId, input.tenantId, input.productId);
    return closed;
  }

  /**
   * Close only an activation issued by one checkout order, including its
   * subsequent Stripe renewal periods. Lookup and closure share the same
   * tenant/product advisory lock as activation, so a concurrent invoice
   * renewal cannot escape a subscription.deleted event.
   */
  async closeActivationFamily(
    input: CloseSubscriptionActivationFamilyInput,
  ): Promise<boolean> {
    const closed = await this.prisma.$transaction(async (tx) => {
      await this.lockActivationScope(tx, input.tenantId, input.productId);
      const period = await tx.subscriptionPeriod.findFirst({
        where: {
          userId: input.userId,
          tenantId: input.tenantId,
          productId: input.productId,
          planId: input.planId,
          OR: [
            {
              activationIdempotencyKey:
                input.initialActivationIdempotencyKey,
            },
            {
              activationIdempotencyKey: {
                startsWith: input.renewalActivationIdempotencyPrefix,
              },
            },
          ],
        },
        orderBy: [{ startedAt: 'desc' }, { createdAt: 'desc' }],
        select: {
          id: true,
          contractId: true,
          status: true,
        },
      });
      if (!period) return false;
      if (period.status !== 'ACTIVE') return true;

      await tx.subscriptionEntitlement.updateMany({
        where: { periodId: period.id, status: 'ACTIVE' },
        data: {
          status: 'CANCELLED',
          endedAt: input.endedAt,
          terminationReason: input.terminationReason,
        },
      });
      await tx.subscriptionPeriod.updateMany({
        where: { id: period.id, status: 'ACTIVE' },
        data: {
          status: 'CANCELLED',
          endedAt: input.endedAt,
          terminationReason: input.terminationReason,
        },
      });
      await tx.subscriptionContract.updateMany({
        where: { id: period.contractId, status: 'ACTIVE' },
        data: {
          status: 'CANCELLED',
          endedAt: input.endedAt,
          terminationReason: input.terminationReason,
        },
      });
      return true;
    });
    await this.invalidateCaches(input.userId, input.tenantId, input.productId);
    return closed;
  }

  /**
   * Establishes the linearization point for the provision response. The
   * callback runs while the same tenant/product advisory lock used by paid
   * activation is held, so quota issuance and receipt completion cannot race
   * a paid replacement after the final active-period read.
   */
  async withCurrentActivePeriod<T>(
    tenantId: string,
    productId: string,
    callback: (period: CurrentSubscriptionPeriod) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockActivationScope(tx, tenantId, productId);
      const current = await tx.subscriptionPeriod.findFirst({
        where: {
          tenantId,
          productId,
          status: 'ACTIVE',
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        select: {
          id: true,
          contractId: true,
          userId: true,
          tenantId: true,
          productId: true,
          planId: true,
          provisionReceiptId: true,
          expiresAt: true,
        },
        orderBy: [{ startedAt: 'desc' }, { createdAt: 'desc' }],
      });
      if (!current) {
        throw new ConflictException('Provision 完成前未找到有效的 active subscription');
      }
      return callback({
        periodId: current.id,
        contractId: current.contractId,
        userId: current.userId,
        tenantId: current.tenantId,
        productId: current.productId,
        planId: current.planId,
        provisionReceiptId: current.provisionReceiptId,
        expiresAt: current.expiresAt,
      });
    }, {
      maxWait: 10_000,
      timeout: 60_000,
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  }

  /**
   * Provision-only self-operated Coding Plan activation. It shares the exact
   * advisory lock and partial-unique scope used by paid fulfillment, but never
   * renews, switches, cancels, or overwrites an existing paid entitlement.
   */
  async activateCodingPlanIfAbsent(
    input: ActivateCodingPlanIfAbsentInput,
  ): Promise<EnsuredCodingPlanEntitlement> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockCodingPlanScope(tx, input.tenantId, input.productId);
      const now = new Date();
      await tx.codingPlanEntitlement.updateMany({
        where: {
          tenantId: input.tenantId,
          productId: input.productId,
          fulfillmentMode: CodingPlanFulfillmentMode.platform_model_package,
          status: CodingPlanEntitlementStatus.ACTIVE,
          expiresAt: { not: null, lte: now },
        },
        data: { status: CodingPlanEntitlementStatus.EXPIRED },
      });
      const receiptOwned = await tx.codingPlanEntitlement.findUnique({
        where: { provisionReceiptId: input.provisionReceiptId },
        select: { id: true },
      });

      const existing = await tx.codingPlanEntitlement.findFirst({
        where: {
          tenantId: input.tenantId,
          productId: input.productId,
          fulfillmentMode: CodingPlanFulfillmentMode.platform_model_package,
          status: CodingPlanEntitlementStatus.ACTIVE,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        orderBy: [{ startedAt: 'desc' }, { createdAt: 'desc' }],
      });
      if (existing) {
        return {
          id: existing.id,
          userId: existing.userId,
          tenantId: existing.tenantId,
          productId: existing.productId,
          planId: existing.planId,
          provisionReceiptId: existing.provisionReceiptId,
          status: existing.status,
          expiresAt: existing.expiresAt,
          created: false,
        };
      }
      if (receiptOwned) {
        throw new ConflictException(
          '该幂等请求原先创建的 Coding Plan entitlement 已失效；请使用新的 idempotencyKey',
        );
      }

      const created = await tx.codingPlanEntitlement.create({
        data: {
          orderId: `saas-provision:${input.provisionReceiptId}`,
          provisionReceiptId: input.provisionReceiptId,
          userId: input.userId,
          tenantId: input.tenantId,
          productId: input.productId,
          planId: input.planId,
          fulfillmentMode: CodingPlanFulfillmentMode.platform_model_package,
          billingPeriod: 'monthly',
          status: CodingPlanEntitlementStatus.ACTIVE,
          startedAt: input.startedAt,
          expiresAt: input.expiresAt,
        },
      });
      return {
        id: created.id,
        userId: created.userId,
        tenantId: created.tenantId,
        productId: created.productId,
        planId: created.planId,
        provisionReceiptId: created.provisionReceiptId,
        status: created.status,
        expiresAt: created.expiresAt,
        created: true,
      };
    }, {
      maxWait: 10_000,
      timeout: 30_000,
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  }

  async withCurrentActiveCodingPlanEntitlement<T>(
    tenantId: string,
    productId: string,
    callback: (entitlement: EnsuredCodingPlanEntitlement) => Promise<T>,
  ): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockCodingPlanScope(tx, tenantId, productId);
      const now = new Date();
      await tx.codingPlanEntitlement.updateMany({
        where: {
          tenantId,
          productId,
          fulfillmentMode: CodingPlanFulfillmentMode.platform_model_package,
          status: CodingPlanEntitlementStatus.ACTIVE,
          expiresAt: { not: null, lte: now },
        },
        data: { status: CodingPlanEntitlementStatus.EXPIRED },
      });
      const current = await tx.codingPlanEntitlement.findFirst({
        where: {
          tenantId,
          productId,
          fulfillmentMode: CodingPlanFulfillmentMode.platform_model_package,
          status: CodingPlanEntitlementStatus.ACTIVE,
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        orderBy: [{ startedAt: 'desc' }, { createdAt: 'desc' }],
      });
      if (!current) {
        throw new ConflictException(
          'Provision 完成前未找到有效的自营 Coding Plan entitlement',
        );
      }
      return callback({
        id: current.id,
        userId: current.userId,
        tenantId: current.tenantId,
        productId: current.productId,
        planId: current.planId,
        provisionReceiptId: current.provisionReceiptId,
        status: current.status,
        expiresAt: current.expiresAt,
        created: false,
      });
    }, {
      maxWait: 10_000,
      timeout: 60_000,
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  }

  async closeActive(input: CloseSubscriptionInput): Promise<number> {
    const closed = await this.prisma.$transaction(async (tx) => {
      if (input.productId) {
        await this.lockActivationScope(tx, input.tenantId, input.productId);
      }
      return this.closeActiveInTransaction(tx, input);
    });
    for (const row of closed) {
      await this.invalidateCaches(row.userId, row.tenantId, row.productId);
    }
    return closed.length;
  }

  async expireDue(now = new Date()): Promise<Array<{ id: string; userId: string; tenantId: string; productId: string }>> {
    const expired = await this.prisma.$transaction(async (tx) => {
      const due = await tx.subscriptionPeriod.findMany({
        where: {
          status: 'ACTIVE',
          expiresAt: { lt: now, not: null },
        },
        select: { id: true, contractId: true, userId: true, tenantId: true, productId: true },
      });
      if (due.length === 0) return [];

      const ids = due.map((period) => period.id);
      await tx.subscriptionEntitlement.updateMany({
        where: { periodId: { in: ids }, status: 'ACTIVE' },
        data: {
          status: 'EXPIRED',
          endedAt: now,
          terminationReason: 'period_expired',
        },
      });
      await tx.subscriptionPeriod.updateMany({
        where: { id: { in: ids }, status: 'ACTIVE' },
        data: {
          status: 'EXPIRED',
          endedAt: now,
          terminationReason: 'period_expired',
        },
      });
      await tx.subscriptionContract.updateMany({
        where: {
          id: { in: due.map((period) => period.contractId) },
          status: 'ACTIVE',
        },
        data: {
          status: 'EXPIRED',
          endedAt: now,
          terminationReason: 'period_expired',
        },
      });
      return due;
    });

    for (const row of expired) {
      await this.invalidateCaches(row.userId, row.tenantId, row.productId);
    }
    return expired;
  }

  private async activateInTransaction(
    tx: Prisma.TransactionClient,
    input: ActivateSubscriptionInput,
  ): Promise<ActivatedSubscriptionPeriod> {
    await this.closeActiveInTransaction(tx, {
      tenantId: input.tenantId,
      productId: input.productId,
      status: 'EXPIRED',
      endedAt: input.startedAt,
      terminationReason: 'replaced_by_new_activation',
    });

    const contract = await tx.subscriptionContract.create({
      data: {
        userId: input.userId,
        tenantId: input.tenantId,
        billingAccountId: input.billingAccountId ?? null,
        productId: input.productId,
        status: 'ACTIVE',
        startedAt: input.startedAt,
      },
      select: { id: true },
    });

    const period = await tx.subscriptionPeriod.create({
      data: {
        contractId: contract.id,
        provisionReceiptId: input.provisionReceiptId ?? null,
        activationIdempotencyKey: input.activationIdempotencyKey ?? null,
        userId: input.userId,
        tenantId: input.tenantId,
        billingAccountId: input.billingAccountId ?? null,
        productId: input.productId,
        planId: input.planId,
        billingPeriod: input.billingPeriod,
        sequence: 1,
        status: 'ACTIVE',
        startedAt: input.startedAt,
        expiresAt: input.expiresAt,
      },
      select: { id: true },
    });

    const entitlement = await tx.subscriptionEntitlement.create({
      data: {
        contractId: contract.id,
        periodId: period.id,
        userId: input.userId,
        tenantId: input.tenantId,
        billingAccountId: input.billingAccountId ?? null,
        productId: input.productId,
        planId: input.planId,
        entitlementType: 'plan_access',
        source: 'subscription_period',
        status: 'ACTIVE',
        startedAt: input.startedAt,
        expiresAt: input.expiresAt,
      },
      select: { id: true },
    });

    return {
      contractId: contract.id,
      periodId: period.id,
      entitlementId: entitlement.id,
    };
  }

  private async lockActivationScope(
    tx: Prisma.TransactionClient,
    tenantId: string,
    productId: string,
  ): Promise<void> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`subscription-lifecycle:${tenantId}:${productId}`}, 0::BIGINT)
      )
    `;
  }

  private async lockCodingPlanScope(
    tx: Prisma.TransactionClient,
    tenantId: string,
    productId: string,
  ): Promise<void> {
    const lockKey = `coding-plan-active:${tenantId}:${productId}`;
    // BillingService.provisionSelfOperatedEntitlement uses hashtext and the
    // same key. Keep this byte-for-byte compatible with paid fulfillment.
    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;
  }

  private async closeActiveInTransaction(
    tx: Prisma.TransactionClient,
    input: CloseSubscriptionInput,
  ): Promise<Array<{ userId: string; tenantId: string; productId: string }>> {
    const activePeriods = await tx.subscriptionPeriod.findMany({
      where: {
        tenantId: input.tenantId,
        ...(input.productId ? { productId: input.productId } : {}),
        ...(input.planId ? { planId: input.planId } : {}),
        status: 'ACTIVE',
      },
      select: { id: true, contractId: true, userId: true, tenantId: true, productId: true },
    });
    if (activePeriods.length === 0) return [];

    const periodIds = activePeriods.map((period) => period.id);
    const contractIds = activePeriods.map((period) => period.contractId);
    await tx.subscriptionEntitlement.updateMany({
      where: { periodId: { in: periodIds }, status: 'ACTIVE' },
      data: {
        status: input.status,
        endedAt: input.endedAt,
        terminationReason: input.terminationReason,
      },
    });
    await tx.subscriptionPeriod.updateMany({
      where: { id: { in: periodIds }, status: 'ACTIVE' },
      data: {
        status: input.status,
        endedAt: input.endedAt,
        terminationReason: input.terminationReason,
      },
    });
    await tx.subscriptionContract.updateMany({
      where: { id: { in: contractIds }, status: 'ACTIVE' },
      data: {
        status: input.status,
        endedAt: input.endedAt,
        terminationReason: input.terminationReason,
      },
    });
    return activePeriods.map(({ userId, tenantId, productId }) => ({ userId, tenantId, productId }));
  }

  private async invalidateCaches(userId: string, tenantId: string, productId: string): Promise<void> {
    await this.redis.del(`subscription:${userId}`);
    await this.redis.del(`subscription:${tenantId}`);
    await this.redis.del(`sub:${userId}:${productId}`);
    await this.redis.del(`sub:user:${userId}:${productId}`);
    await this.redis.del(`sub:tenant:${tenantId}:${productId}`);
  }
}
