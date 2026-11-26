import { PaymentRepository } from './payment.repository';
import { PrismaService } from '../prisma/prisma.service';
import { OrderStatus, PaymentCheckoutInitState } from '@prisma/client';

describe('PaymentRepository product-scoped order access', () => {
  function buildRepository() {
    const prisma = {
      order: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
      },
    };
    return {
      prisma,
      repository: new PaymentRepository(prisma as unknown as PrismaService),
    };
  }

  const strictProductScope = {
    OR: [
      { productId: 'prod-a', items: { none: {} } },
      {
        items: {
          some: { productId: 'prod-a' },
          none: {
            OR: [
              { productId: null },
              { productId: { not: 'prod-a' } },
            ],
          },
        },
      },
    ],
  };

  it('requires every Bundle item to belong to the Partner product for detail/cancel lookup', async () => {
    const { prisma, repository } = buildRepository();

    await repository.findOrderByIdAndUser(
      'order-mixed',
      'user-1',
      'tenant-1',
      'prod-a',
    );

    expect(prisma.order.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'order-mixed',
        userId: 'user-1',
        tenantId: 'tenant-1',
        ...strictProductScope,
      },
    });
  });

  it('applies the same all-items product boundary to Partner order listings', async () => {
    const { prisma, repository } = buildRepository();

    await repository.findUserOrders(
      'user-1',
      0,
      20,
      undefined,
      undefined,
      'tenant-1',
      'prod-a',
    );

    expect(prisma.order.findMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        tenantId: 'tenant-1',
        ...strictProductScope,
      },
      orderBy: { createdAt: 'desc' },
      skip: 0,
      take: 20,
      include: { product: true, plan: true, boosterPack: true },
    });
  });

  it('uses the strict product boundary when looking up a legacy raw idempotency key', async () => {
    const { prisma, repository } = buildRepository();

    await repository.findLegacyIdempotentOrder(
      'legacy-raw-key',
      'user-1',
      'tenant-1',
      'prod-a',
    );

    expect(prisma.order.findFirst).toHaveBeenCalledWith({
      where: {
        idempotencyKey: 'legacy-raw-key',
        userId: 'user-1',
        tenantId: 'tenant-1',
        ...strictProductScope,
      },
    });
  });

  it('preserves unrestricted internal order lookup when no product scope is supplied', async () => {
    const { prisma, repository } = buildRepository();

    await repository.findOrderByIdAndUser(
      'order-1',
      'user-1',
      'tenant-1',
    );

    expect(prisma.order.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'order-1',
        userId: 'user-1',
        tenantId: 'tenant-1',
      },
    });
  });
});

describe('PaymentRepository checkout initialization lease', () => {
  function buildRepository() {
    const prisma = {
      order: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue({ id: 'order-1' }),
      },
    };
    return {
      prisma,
      repository: new PaymentRepository(prisma as unknown as PrismaService),
    };
  }

  it('claims only a not-started or expired initialization for a pending order', async () => {
    const { prisma, repository } = buildRepository();
    const now = new Date('2026-07-23T10:00:00.000Z');
    const leaseExpiresAt = new Date('2026-07-23T10:02:00.000Z');

    await expect(repository.claimCheckoutInitialization(
      'order-1',
      'lease-1',
      now,
      leaseExpiresAt,
    )).resolves.toBe(true);

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'order-1',
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
      data: expect.objectContaining({
        checkoutInitState: PaymentCheckoutInitState.INITIALIZING,
        checkoutLeaseId: 'lease-1',
        checkoutLeaseExpiresAt: leaseExpiresAt,
      }),
    });
  });

  it('atomically persists Stripe tradeNo and encrypted URL before marking checkout ready', async () => {
    const { prisma, repository } = buildRepository();
    const expiresAt = new Date('2026-07-24T10:00:00.000Z');

    await repository.completeCheckoutInitialization('order-1', 'lease-1', {
      checkoutPayUrlEncrypted: 'ciphertext-only',
      checkoutPayUrlExpiresAt: expiresAt,
      tradeNo: 'cs_1',
      paymentProviderInstanceId: 'stripe-instance-1',
    });

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'order-1',
        status: OrderStatus.PENDING,
        checkoutInitState: PaymentCheckoutInitState.INITIALIZING,
        checkoutLeaseId: 'lease-1',
      },
      data: {
        checkoutInitState: PaymentCheckoutInitState.READY,
        checkoutLeaseId: null,
        checkoutLeaseExpiresAt: null,
        checkoutPayUrlEncrypted: 'ciphertext-only',
        checkoutPayUrlExpiresAt: expiresAt,
        checkoutProviderReference: 'cs_1',
        tradeNo: 'cs_1',
        paymentProviderInstanceId: 'stripe-instance-1',
      },
    });
    expect(prisma.order.findUnique).toHaveBeenCalledWith({ where: { id: 'order-1' } });
  });

  it('durably marks an ambiguous provider result for reconciliation', async () => {
    const { prisma, repository } = buildRepository();

    await expect(
      repository.markCheckoutOutcomeUnknown('order-1', 'lease-1'),
    ).resolves.toBe(true);

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'order-1',
        status: OrderStatus.PENDING,
        checkoutInitState: PaymentCheckoutInitState.INITIALIZING,
        checkoutLeaseId: 'lease-1',
      },
      data: {
        checkoutInitState: PaymentCheckoutInitState.OUTCOME_UNKNOWN,
        checkoutLeaseId: null,
        checkoutLeaseExpiresAt: null,
        checkoutPayUrlEncrypted: null,
        checkoutPayUrlExpiresAt: null,
      },
    });
  });
});

describe('PaymentRepository legacy Partner idempotency migration', () => {
  it('adds the Partner namespace without replacing the rollback-readable raw key', async () => {
    const prisma = {
      order: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    };
    const repository = new PaymentRepository(prisma as unknown as PrismaService);

    await expect(repository.migrateLegacyIdempotencyKey(
      'order-1',
      'legacy-raw-key',
      'partner:prod-a:hash',
      'normalized-fingerprint',
    )).resolves.toBe(true);

    expect(prisma.order.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'order-1',
        idempotencyKey: 'legacy-raw-key',
      },
      data: {
        partnerIdempotencyKey: 'partner:prod-a:hash',
        idempotencyFingerprint: 'normalized-fingerprint',
      },
    });
  });
});
