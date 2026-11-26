/**
 * SubscriptionExpiryService unit tests
 * Target coverage: ≥ 70%
 * Covers: checkExpiredSubscriptions (no expired / with expired / DB error),
 *         cache clearing logic
 */

import { Test } from '@nestjs/testing';
import { SubscriptionExpiryService } from './subscription-expiry.service';
import { RedisService } from '../redis/redis.service';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';

// Suppress the real setInterval / setTimeout launched in onModuleInit
jest.useFakeTimers();

describe('SubscriptionExpiryService', () => {
  let service: SubscriptionExpiryService;
  let lifecycle: jest.Mocked<Pick<SubscriptionLifecycleService, 'expireDue'>>;
  let redis: jest.Mocked<Pick<RedisService, 'del'>>;

  beforeEach(async () => {
    lifecycle = {
      expireDue: jest.fn(),
    };

    redis = {
      del: jest.fn().mockResolvedValue(3),
    };

    const moduleRef = await Test.createTestingModule({
      providers: [
        SubscriptionExpiryService,
        { provide: SubscriptionLifecycleService, useValue: lifecycle },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();

    service = moduleRef.get(SubscriptionExpiryService);

    // Reset mocks after module init (onModuleInit may have triggered something via fake timers)
    jest.clearAllMocks();
  });

  afterEach(() => {
    jest.clearAllTimers();
  });

  // ─── checkExpiredSubscriptions ────────────────────────────────────────────

  describe('checkExpiredSubscriptions', () => {
    it('does nothing when no subscriptions are expired', async () => {
      lifecycle.expireDue.mockResolvedValue([]);

      await service.checkExpiredSubscriptions();

      expect(lifecycle.expireDue).toHaveBeenCalledWith(expect.any(Date));
      expect(redis.del).not.toHaveBeenCalled();
    });

    it('delegates expired subscription status changes to lifecycle service', async () => {
      const expired = [
        { id: 'period-1', userId: 'user-1', tenantId: 'tenant-1', productId: 'prod-1' },
        { id: 'period-2', userId: 'user-2', tenantId: 'tenant-2', productId: 'prod-2' },
      ];
      lifecycle.expireDue.mockResolvedValue(expired);

      await service.checkExpiredSubscriptions();

      expect(lifecycle.expireDue).toHaveBeenCalledWith(expect.any(Date));
    });

    it('clears Redis caches for each expired subscription', async () => {
      const expired = [
        { id: 'period-abc', userId: 'u1', tenantId: 'tenant-1', productId: 'p1' },
      ];
      lifecycle.expireDue.mockResolvedValue(expired);

      await service.checkExpiredSubscriptions();

      expect(redis.del).toHaveBeenCalledWith(
        'sub:u1:p1',
        'credits:v2:{period-abc}',
        'credits:quota:period-abc',
        'credits:bonus:period-abc',
      );
    });

    it('clears the resolver, V2, and legacy credit cache keys per expired subscription', async () => {
      const expired = [
        { id: 'period-x', userId: 'user-x', tenantId: 'tenant-x', productId: 'prod-x' },
      ];
      lifecycle.expireDue.mockResolvedValue(expired);

      await service.checkExpiredSubscriptions();

      const delCall = (redis.del as jest.Mock).mock.calls[0];
      expect(delCall).toHaveLength(4);
      expect(delCall).toContain('sub:user-x:prod-x');
      expect(delCall).toContain('credits:v2:{period-x}');
      expect(delCall).toContain('credits:quota:period-x');
      expect(delCall).toContain('credits:bonus:period-x');
    });

    it('handles multiple expired subscriptions with separate cache clears', async () => {
      const expired = [
        { id: 'period-1', userId: 'u1', tenantId: 'tenant-1', productId: 'p1' },
        { id: 'period-2', userId: 'u2', tenantId: 'tenant-2', productId: 'p2' },
      ];
      lifecycle.expireDue.mockResolvedValue(expired);

      await service.checkExpiredSubscriptions();

      // redis.del called once per subscription
      expect(redis.del).toHaveBeenCalledTimes(2);
    });

    it('passes the current time into lifecycle expiry', async () => {
      lifecycle.expireDue.mockResolvedValue([]);

      await service.checkExpiredSubscriptions();

      expect(lifecycle.expireDue).toHaveBeenCalledWith(expect.any(Date));
    });

    it('does not throw when lifecycle query fails (catches error)', async () => {
      lifecycle.expireDue.mockRejectedValue(new Error('DB connection lost'));

      // Should not throw
      await expect(service.checkExpiredSubscriptions()).resolves.toBeUndefined();
    });

    it('continues processing remaining subscriptions if one cache clear fails', async () => {
      const expired = [
        { id: 'period-1', userId: 'u1', tenantId: 'tenant-1', productId: 'p1' },
        { id: 'period-2', userId: 'u2', tenantId: 'tenant-2', productId: 'p2' },
      ];
      lifecycle.expireDue.mockResolvedValue(expired);
      // First del fails, second should still be called
      (redis.del as jest.Mock)
        .mockRejectedValueOnce(new Error('Redis error'))
        .mockResolvedValueOnce(3);

      // Should not throw
      await expect(service.checkExpiredSubscriptions()).resolves.toBeUndefined();
      // Second subscription's cache should still be cleared
      expect(redis.del).toHaveBeenCalledTimes(2);
    });

  });

  // ─── onModuleInit ─────────────────────────────────────────────────────────

  describe('onModuleInit', () => {
    it('schedules periodic check (does not throw)', () => {
      // onModuleInit registers setInterval + setTimeout. With fake timers
      // we can verify those callbacks are eventually scheduled without
      // making the test flaky via real I/O.
      expect(() => service.onModuleInit()).not.toThrow();
    });

    it('runs checkExpiredSubscriptions after initial delay (30s)', async () => {
      lifecycle.expireDue.mockResolvedValue([]);

      service.onModuleInit();

      // Advance fake timers past the 30s initial delay
      jest.advanceTimersByTime(30_001);

      // Allow any pending microtasks / promises to flush
      await Promise.resolve();
      await Promise.resolve();

      expect(lifecycle.expireDue).toHaveBeenCalled();
    });
  });
});
