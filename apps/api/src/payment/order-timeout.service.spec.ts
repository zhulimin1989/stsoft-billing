import { Test } from '@nestjs/testing';
import { OrderTimeoutService } from './order-timeout.service';
import { PrismaService } from '../prisma/prisma.service';
import { OrderStatus, PayChannel, PaymentCheckoutInitState } from '@prisma/client';

function makePrisma() {
  return {
    order: {
      findMany: jest.fn(),
    },
    $transaction: jest.fn(),
  };
}

async function buildService(prisma: ReturnType<typeof makePrisma>) {
  const m = await Test.createTestingModule({
    providers: [
      OrderTimeoutService,
      { provide: PrismaService, useValue: prisma },
    ],
  }).compile();
  return m.get(OrderTimeoutService) as OrderTimeoutService;
}

// Helper to call the private expirePendingOrders method
function callExpire(service: OrderTimeoutService): Promise<void> {
  return (service as any).expirePendingOrders();
}

describe('OrderTimeoutService', () => {
  describe('lifecycle', () => {
    it('onModuleInit starts interval (no throw)', async () => {
      const prisma = makePrisma();
      const service = await buildService(prisma);
      expect(() => service.onModuleInit()).not.toThrow();
      service.onModuleDestroy(); // cleanup
    });

    it('onModuleDestroy clears interval (no throw)', async () => {
      const prisma = makePrisma();
      const service = await buildService(prisma);
      service.onModuleInit();
      expect(() => service.onModuleDestroy()).not.toThrow();
    });

    it('onModuleDestroy is safe to call when no interval is running', async () => {
      const prisma = makePrisma();
      const service = await buildService(prisma);
      // Never called onModuleInit
      expect(() => service.onModuleDestroy()).not.toThrow();
    });

    it('onModuleDestroy is idempotent', async () => {
      const prisma = makePrisma();
      const service = await buildService(prisma);
      service.onModuleInit();
      service.onModuleDestroy();
      expect(() => service.onModuleDestroy()).not.toThrow();
    });
  });

  describe('expirePendingOrders', () => {
    it('expires pending orders using channel-specific windows — happy path', async () => {
      const prisma = makePrisma();
      prisma.order.findMany.mockResolvedValue([
        { id: 'order-1' },
        { id: 'order-2' },
      ]);
      // $transaction callback form
      prisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<any>) => {
        const tx = {
          order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
          orderAuditLog: { create: jest.fn().mockResolvedValue({}) },
        };
        return fn(tx);
      });

      const service = await buildService(prisma);
      await callExpire(service);

      expect(prisma.order.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where: expect.objectContaining({ status: OrderStatus.PENDING }),
          select: { id: true },
        }),
      );
      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    });

    it('queries with a 5 minute cutoff for local balance/null pending orders', async () => {
      const prisma = makePrisma();
      const before = Date.now() - 5 * 60 * 1000;
      prisma.order.findMany.mockResolvedValue([]);

      const service = await buildService(prisma);
      await callExpire(service);

      const callArg = prisma.order.findMany.mock.calls[0][0];
      const balanceWindow = callArg.where.OR.find(
        (item: any) => item.channel === PayChannel.BALANCE,
      );
      const cutoff: Date = balanceWindow.createdAt.lt;
      expect(cutoff).toBeInstanceOf(Date);
      const after = Date.now() - 5 * 60 * 1000;
      // cutoff should be between before and after (approximately 5 min ago)
      expect(cutoff.getTime()).toBeGreaterThanOrEqual(before - 1000);
      expect(cutoff.getTime()).toBeLessThanOrEqual(after + 1000);
    });

    it('skips audit log when updateMany returns count=0 (concurrent update)', async () => {
      const prisma = makePrisma();
      prisma.order.findMany.mockResolvedValue([{ id: 'order-concurrent' }]);
      const mockCreate = jest.fn().mockResolvedValue({});
      prisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<any>) => {
        const tx = {
          order: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) }, // 0 = no update
          orderAuditLog: { create: mockCreate },
        };
        return fn(tx);
      });

      const service = await buildService(prisma);
      await callExpire(service);

      expect(mockCreate).not.toHaveBeenCalled();
    });

    it('creates audit log when count=1 (update succeeded)', async () => {
      const prisma = makePrisma();
      prisma.order.findMany.mockResolvedValue([{ id: 'order-ok' }]);
      const mockCreate = jest.fn().mockResolvedValue({});
      prisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<any>) => {
        const tx = {
          order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
          orderAuditLog: { create: mockCreate },
        };
        return fn(tx);
      });

      const service = await buildService(prisma);
      await callExpire(service);

      expect(mockCreate).toHaveBeenCalledWith(
        expect.objectContaining({
          data: expect.objectContaining({
            orderId: 'order-ok',
            fromStatus: OrderStatus.PENDING,
            toStatus: OrderStatus.EXPIRED,
            operator: 'system',
          }),
        }),
      );
    });

    it('continues processing remaining orders when one transaction throws', async () => {
      const prisma = makePrisma();
      prisma.order.findMany.mockResolvedValue([
        { id: 'order-fail' },
        { id: 'order-ok' },
      ]);

      let callCount = 0;
      prisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<any>) => {
        callCount++;
        if (callCount === 1) {
          throw new Error('DB error on first order');
        }
        const tx = {
          order: { updateMany: jest.fn().mockResolvedValue({ count: 1 }) },
          orderAuditLog: { create: jest.fn().mockResolvedValue({}) },
        };
        return fn(tx);
      });

      const service = await buildService(prisma);
      await callExpire(service); // should NOT throw

      expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    });

    it('handles outer findMany failure without throwing', async () => {
      const prisma = makePrisma();
      prisma.order.findMany.mockRejectedValue(new Error('DB connection lost'));

      const service = await buildService(prisma);
      await expect(callExpire(service)).resolves.toBeUndefined();
    });

    it('returns early when no pending orders found', async () => {
      const prisma = makePrisma();
      prisma.order.findMany.mockResolvedValue([]);

      const service = await buildService(prisma);
      await callExpire(service);

      expect(prisma.$transaction).not.toHaveBeenCalled();
    });

    it('sets expiredAt on updated order record', async () => {
      const prisma = makePrisma();
      prisma.order.findMany.mockResolvedValue([{ id: 'order-exp' }]);

      let capturedData: any;
      prisma.$transaction.mockImplementation(async (fn: (tx: any) => Promise<any>) => {
        const mockUpdateMany = jest.fn().mockImplementation(async (args: any) => {
          capturedData = args;
          return { count: 1 };
        });
        const tx = {
          order: { updateMany: mockUpdateMany },
          orderAuditLog: { create: jest.fn().mockResolvedValue({}) },
        };
        return fn(tx);
      });

      const service = await buildService(prisma);
      await callExpire(service);

      expect(capturedData.data.status).toBe(OrderStatus.EXPIRED);
      expect(capturedData.data.expiredAt).toBeInstanceOf(Date);
      expect(capturedData.data).toMatchObject({
        checkoutInitState: PaymentCheckoutInitState.TERMINAL,
        checkoutLeaseId: null,
        checkoutLeaseExpiresAt: null,
        checkoutContextEncrypted: null,
        checkoutPayUrlEncrypted: null,
        checkoutPayUrlExpiresAt: null,
      });
    });
  });
});
