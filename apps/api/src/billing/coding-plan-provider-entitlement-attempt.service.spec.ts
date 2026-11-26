import { CodingPlanProviderEntitlementStatus } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import {
  CodingPlanProviderEntitlementAttemptService,
  ProviderEntitlementReservation,
} from './coding-plan-provider-entitlement-attempt.service';

const RESERVATION: ProviderEntitlementReservation = {
  orderId: 'order-1',
  subscriptionId: 'subscription-1',
  userId: 'user-1',
  tenantId: 'tenant-1',
  productId: 'product-1',
  planId: 'plan-1',
  provider: 'zhipu',
  providerLineId: 'line-1',
  providerLineCode: 'zhipu-cn',
  providerCode: 'zhipu',
  providerAccountIdentityId: 'identity-1',
  adapterType: 'zhipu_partner',
  upstreamProductId: 'upstream-product-1',
  partnerUserId: 'partner-user-1',
  partnerOrderNo: 'partner-order-1',
};

function buildService() {
  const prisma = {
    $transaction: jest.fn(),
    codingPlanProviderEntitlement: {
      findUnique: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: 'provider-entitlement-1' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    codingPlanEntitlement: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  prisma.$transaction.mockImplementation(
    async (callback: (tx: typeof prisma) => unknown) => callback(prisma),
  );
  return {
    service: new CodingPlanProviderEntitlementAttemptService(
      prisma as unknown as PrismaService,
    ),
    prisma,
  };
}

describe('CodingPlanProviderEntitlementAttemptService', () => {
  it('persists a tokenized PENDING lease before returning the initial claim', async () => {
    const { service, prisma } = buildService();
    prisma.codingPlanProviderEntitlement.findUnique.mockResolvedValue(null);

    await expect(service.claimForOrder(RESERVATION)).resolves.toEqual({
      status: 'claimed',
      providerEntitlementId: 'provider-entitlement-1',
      attemptId: expect.any(String),
    });

    expect(prisma.codingPlanProviderEntitlement.create).toHaveBeenCalledWith({
      data: {
        ...RESERVATION,
        status: CodingPlanProviderEntitlementStatus.PENDING,
        fulfillmentAttemptId: expect.any(String),
        fulfillmentClaimedAt: expect.any(Date),
      },
      select: { id: true },
    });
  });

  it('does not reclaim a non-stale PENDING attempt after an insert race', async () => {
    const { service, prisma } = buildService();
    const pending = {
      id: 'provider-entitlement-1',
      status: CodingPlanProviderEntitlementStatus.PENDING,
      fulfillmentAttemptId: 'attempt-winner',
      fulfillmentClaimedAt: new Date(),
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    prisma.codingPlanProviderEntitlement.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(pending);
    prisma.codingPlanProviderEntitlement.create.mockRejectedValueOnce({ code: 'P2002' });

    await expect(service.claimForOrder(RESERVATION)).resolves.toEqual({
      status: 'busy',
      providerEntitlementId: 'provider-entitlement-1',
    });

    expect(prisma.codingPlanProviderEntitlement.updateMany).not.toHaveBeenCalled();
  });

  it('reclaims a stale PENDING lease with a token CAS', async () => {
    const { service, prisma } = buildService();
    prisma.codingPlanProviderEntitlement.findUnique.mockResolvedValue({
      id: 'provider-entitlement-1',
      status: CodingPlanProviderEntitlementStatus.PENDING,
      fulfillmentAttemptId: 'attempt-old',
      fulfillmentClaimedAt: new Date(Date.now() - 11 * 60 * 1000),
      createdAt: new Date(Date.now() - 20 * 60 * 1000),
      updatedAt: new Date(Date.now() - 11 * 60 * 1000),
    });

    await expect(service.claimForOrder(RESERVATION)).resolves.toEqual({
      status: 'claimed',
      providerEntitlementId: 'provider-entitlement-1',
      attemptId: expect.any(String),
    });

    expect(prisma.codingPlanProviderEntitlement.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'provider-entitlement-1',
        status: CodingPlanProviderEntitlementStatus.PENDING,
        fulfillmentAttemptId: 'attempt-old',
        fulfillmentClaimedAt: expect.any(Date),
      },
      data: expect.objectContaining({
        fulfillmentAttemptId: expect.any(String),
        fulfillmentClaimedAt: expect.any(Date),
      }),
    });
  });

  it('requires the attempt token when activating credentials', async () => {
    const { service, prisma } = buildService();
    prisma.codingPlanProviderEntitlement.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.activateIfCurrent(
      'provider-entitlement-1',
      'attempt-old',
      {
        upstreamOrderId: 'upstream-order-old',
        upstreamApiKeyEncrypted: 'encrypted-old-key',
        upstreamApiKeyPrefix: 'old-key',
        upstreamSecretKeyEncrypted: 'encrypted-old-secret',
        upstreamSecretKeyPrefix: 'old-secret',
        credentialFormat: 'apiKey.secretKey',
        productStartTime: null,
        productEndTime: null,
        responseSnapshot: {},
        activatedAt: new Date(),
      },
    )).resolves.toBe(false);

    expect(prisma.codingPlanProviderEntitlement.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'provider-entitlement-1',
        status: CodingPlanProviderEntitlementStatus.PENDING,
        fulfillmentAttemptId: 'attempt-old',
      },
      data: expect.objectContaining({
        upstreamOrderId: 'upstream-order-old',
        status: CodingPlanProviderEntitlementStatus.ACTIVE,
        fulfillmentAttemptId: null,
        fulfillmentClaimedAt: null,
      }),
    });
  });

  it('projects the customer route only while the attempt still owns the preflight lease', async () => {
    const { service, prisma } = buildService();

    await expect(service.prepareForUpstreamIfCurrent(
      'provider-entitlement-1',
      'attempt-current',
      {
        subscriptionId: 'subscription-1',
        providerLineId: 'line-1',
        providerLineCode: 'zhipu-cn',
        providerCode: 'zhipu',
        adapterType: 'zhipu_partner',
        upstreamProductId: 'upstream-product-1',
      },
    )).resolves.toBe(true);

    expect(prisma.codingPlanProviderEntitlement.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'provider-entitlement-1',
        status: CodingPlanProviderEntitlementStatus.PENDING,
        fulfillmentAttemptId: 'attempt-current',
      },
      data: { fulfillmentClaimedAt: expect.any(Date) },
    });
    expect(prisma.codingPlanEntitlement.updateMany).toHaveBeenCalledWith({
      where: { id: 'subscription-1' },
      data: {
        providerLineId: 'line-1',
        providerLineCode: 'zhipu-cn',
        providerCode: 'zhipu',
        adapterType: 'zhipu_partner',
        upstreamProductId: 'upstream-product-1',
      },
    });
  });

  it('does not project the customer route after the preflight CAS loses', async () => {
    const { service, prisma } = buildService();
    prisma.codingPlanProviderEntitlement.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.prepareForUpstreamIfCurrent(
      'provider-entitlement-1',
      'attempt-old',
      {
        subscriptionId: 'subscription-1',
        providerLineId: 'line-old',
        providerLineCode: 'old-line',
        providerCode: 'zhipu',
        adapterType: 'zhipu_partner',
        upstreamProductId: 'upstream-product-old',
      },
    )).resolves.toBe(false);

    expect(prisma.codingPlanEntitlement.updateMany).not.toHaveBeenCalled();
  });

  it('requires the attempt token when recording failure', async () => {
    const { service, prisma } = buildService();
    prisma.codingPlanProviderEntitlement.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.failIfCurrent(
      'provider-entitlement-1',
      'attempt-old',
      'old attempt failed',
    )).resolves.toBe(false);

    expect(prisma.codingPlanProviderEntitlement.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'provider-entitlement-1',
        status: CodingPlanProviderEntitlementStatus.PENDING,
        fulfillmentAttemptId: 'attempt-old',
      },
      data: {
        status: CodingPlanProviderEntitlementStatus.FAILED,
        fulfillmentAttemptId: null,
        fulfillmentClaimedAt: null,
        lastError: 'old attempt failed',
      },
    });
  });
});
