import { Injectable } from '@nestjs/common';
import { CodingPlanProviderEntitlementStatus, Prisma } from '@prisma/client';
import { randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

const PROVIDER_FULFILLMENT_LEASE_MS = 10 * 60 * 1000;

export type ProviderEntitlementReservation = {
  orderId: string;
  subscriptionId: string | null;
  userId: string;
  tenantId: string;
  productId: string;
  planId: string;
  provider: string;
  providerLineId: string;
  providerLineCode: string;
  providerCode: string;
  providerAccountIdentityId: string;
  adapterType: string;
  upstreamProductId: string;
  partnerUserId: string;
  partnerOrderNo: string;
};

export type ProviderEntitlementLineBinding = Pick<
  ProviderEntitlementReservation,
  | 'provider'
  | 'providerLineId'
  | 'providerLineCode'
  | 'providerCode'
  | 'providerAccountIdentityId'
  | 'adapterType'
>;

export type ProviderEntitlementActivation = {
  upstreamOrderId: string | null;
  upstreamApiKeyEncrypted: string | null;
  upstreamApiKeyPrefix: string | null;
  upstreamSecretKeyEncrypted: string | null;
  upstreamSecretKeyPrefix: string | null;
  credentialFormat: string;
  productStartTime: Date | null;
  productEndTime: Date | null;
  responseSnapshot: Prisma.InputJsonObject;
  activatedAt: Date;
};

export type ProviderEntitlementCustomerSnapshot = {
  subscriptionId: string | null;
  providerLineId: string;
  providerLineCode: string;
  providerCode: string;
  adapterType: string;
  upstreamProductId: string;
};

export type ProviderEntitlementAttemptClaim =
  | { status: 'claimed'; providerEntitlementId: string; attemptId: string }
  | { status: 'active'; providerEntitlementId: string }
  | { status: 'busy'; providerEntitlementId: string }
  | { status: 'ineligible'; providerEntitlementId: string; entitlementStatus: CodingPlanProviderEntitlementStatus };

type ClaimEvidence = {
  id: string;
  status: CodingPlanProviderEntitlementStatus;
  fulfillmentAttemptId: string | null;
  fulfillmentClaimedAt: Date | null;
  updatedAt: Date;
};

/**
 * Database authority for provider-order attempt ownership.
 *
 * Provider createOrder is an external side effect and cannot participate in a
 * SQL transaction. This service therefore persists a tokenized PENDING lease
 * before the call and requires the same token for both ACTIVE and FAILED
 * settlement. A stale attempt may finish, but it can never overwrite a newer
 * attempt's state or credentials.
 */
@Injectable()
export class CodingPlanProviderEntitlementAttemptService {
  constructor(private readonly prisma: PrismaService) {}

  async claimForOrder(
    reservation: ProviderEntitlementReservation,
  ): Promise<ProviderEntitlementAttemptClaim> {
    const existing = await this.findByOrderId(reservation.orderId);
    if (existing) return this.claimExistingRow(existing, reservation);

    const attemptId = randomUUID();
    const claimedAt = new Date();
    try {
      const created = await this.prisma.codingPlanProviderEntitlement.create({
        data: {
          ...reservation,
          status: CodingPlanProviderEntitlementStatus.PENDING,
          fulfillmentAttemptId: attemptId,
          fulfillmentClaimedAt: claimedAt,
        },
        select: { id: true },
      });
      return {
        status: 'claimed',
        providerEntitlementId: created.id,
        attemptId,
      };
    } catch (error) {
      if (!this.isUniqueConstraintViolation(error)) throw error;
      const raced = await this.findByOrderId(reservation.orderId);
      if (!raced) throw error;
      return this.claimExistingRow(raced, reservation);
    }
  }

  async claimById(
    id: string,
    binding: ProviderEntitlementLineBinding,
  ): Promise<ProviderEntitlementAttemptClaim | null> {
    const existing = await this.findById(id);
    if (!existing) return null;
    return this.claimExistingRow(existing, binding);
  }

  async activateIfCurrent(
    id: string,
    attemptId: string,
    activation: ProviderEntitlementActivation,
  ): Promise<boolean> {
    const updated = await this.prisma.codingPlanProviderEntitlement.updateMany({
      where: {
        id,
        status: CodingPlanProviderEntitlementStatus.PENDING,
        fulfillmentAttemptId: attemptId,
      },
      data: {
        ...activation,
        status: CodingPlanProviderEntitlementStatus.ACTIVE,
        fulfillmentAttemptId: null,
        fulfillmentClaimedAt: null,
        lastError: null,
      },
    });
    return updated.count === 1;
  }

  /**
   * Final database preflight immediately before createOrder. Refreshing the
   * lease and projecting the customer route happen under the same row lock,
   * so an attempt that already lost ownership cannot publish a competing
   * route snapshot or call upstream.
   */
  async prepareForUpstreamIfCurrent(
    id: string,
    attemptId: string,
    customerSnapshot?: ProviderEntitlementCustomerSnapshot,
  ): Promise<boolean> {
    return this.prisma.$transaction(async (tx) => {
      const refreshed = await tx.codingPlanProviderEntitlement.updateMany({
        where: {
          id,
          status: CodingPlanProviderEntitlementStatus.PENDING,
          fulfillmentAttemptId: attemptId,
        },
        data: { fulfillmentClaimedAt: new Date() },
      });
      if (refreshed.count !== 1) return false;

      if (customerSnapshot?.subscriptionId) {
        await tx.codingPlanEntitlement.updateMany({
          where: { id: customerSnapshot.subscriptionId },
          data: {
            providerLineId: customerSnapshot.providerLineId,
            providerLineCode: customerSnapshot.providerLineCode,
            providerCode: customerSnapshot.providerCode,
            adapterType: customerSnapshot.adapterType,
            upstreamProductId: customerSnapshot.upstreamProductId,
          },
        });
      }
      return true;
    });
  }

  async failIfCurrent(id: string, attemptId: string, message: string): Promise<boolean> {
    const updated = await this.prisma.codingPlanProviderEntitlement.updateMany({
      where: {
        id,
        status: CodingPlanProviderEntitlementStatus.PENDING,
        fulfillmentAttemptId: attemptId,
      },
      data: {
        status: CodingPlanProviderEntitlementStatus.FAILED,
        fulfillmentAttemptId: null,
        fulfillmentClaimedAt: null,
        lastError: message,
      },
    });
    return updated.count === 1;
  }

  async currentStatus(id: string): Promise<CodingPlanProviderEntitlementStatus | null> {
    const current = await this.prisma.codingPlanProviderEntitlement.findUnique({
      where: { id },
      select: { status: true },
    });
    return current?.status ?? null;
  }

  private async claimExistingRow(
    existing: ClaimEvidence,
    reservation: ProviderEntitlementReservation | ProviderEntitlementLineBinding,
  ): Promise<ProviderEntitlementAttemptClaim> {
    if (existing.status === CodingPlanProviderEntitlementStatus.ACTIVE) {
      return { status: 'active', providerEntitlementId: existing.id };
    }
    if (
      existing.status === CodingPlanProviderEntitlementStatus.PENDING
      && !this.isStale(existing)
    ) {
      return { status: 'busy', providerEntitlementId: existing.id };
    }
    if (
      existing.status !== CodingPlanProviderEntitlementStatus.PENDING
      && existing.status !== CodingPlanProviderEntitlementStatus.FAILED
    ) {
      return {
        status: 'ineligible',
        providerEntitlementId: existing.id,
        entitlementStatus: existing.status,
      };
    }

    const attemptId = randomUUID();
    const claimedAt = new Date();
    const claimed = await this.prisma.codingPlanProviderEntitlement.updateMany({
      where: {
        id: existing.id,
        status: existing.status,
        fulfillmentAttemptId: existing.fulfillmentAttemptId,
        fulfillmentClaimedAt: existing.fulfillmentClaimedAt,
      },
      data: {
        ...reservation,
        status: CodingPlanProviderEntitlementStatus.PENDING,
        fulfillmentAttemptId: attemptId,
        fulfillmentClaimedAt: claimedAt,
        lastError: null,
      },
    });
    if (claimed.count !== 1) {
      const current = await this.findById(existing.id);
      if (!current) {
        return {
          status: 'ineligible',
          providerEntitlementId: existing.id,
          entitlementStatus: existing.status,
        };
      }
      if (current.status === CodingPlanProviderEntitlementStatus.ACTIVE) {
        return { status: 'active', providerEntitlementId: current.id };
      }
      if (current.status === CodingPlanProviderEntitlementStatus.PENDING) {
        return { status: 'busy', providerEntitlementId: current.id };
      }
      return {
        status: 'ineligible',
        providerEntitlementId: current.id,
        entitlementStatus: current.status,
      };
    }
    return {
      status: 'claimed',
      providerEntitlementId: existing.id,
      attemptId,
    };
  }

  private isStale(existing: ClaimEvidence): boolean {
    const startedAt = existing.fulfillmentClaimedAt ?? existing.updatedAt;
    return Date.now() - startedAt.getTime() >= PROVIDER_FULFILLMENT_LEASE_MS;
  }

  private findByOrderId(orderId: string): Promise<ClaimEvidence | null> {
    return this.prisma.codingPlanProviderEntitlement.findUnique({
      where: { orderId },
      select: {
        id: true,
        status: true,
        fulfillmentAttemptId: true,
        fulfillmentClaimedAt: true,
        updatedAt: true,
      },
    });
  }

  private findById(id: string): Promise<ClaimEvidence | null> {
    return this.prisma.codingPlanProviderEntitlement.findUnique({
      where: { id },
      select: {
        id: true,
        status: true,
        fulfillmentAttemptId: true,
        fulfillmentClaimedAt: true,
        updatedAt: true,
      },
    });
  }

  private isUniqueConstraintViolation(error: unknown): boolean {
    return Boolean(
      error
      && typeof error === 'object'
      && 'code' in error
      && (error as { code?: unknown }).code === 'P2002',
    );
  }
}
