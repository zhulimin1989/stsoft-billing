import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { CreditExpireService } from './credit-expire.service';

describe('CreditExpireService', () => {
  let service: CreditExpireService;
  let prisma: any;
  let redis: any;

  beforeEach(async () => {
    prisma = {
      creditTransaction: {
        create: jest.fn(),
        update: jest.fn(),
      },
      grantRedemption: {
        findMany: jest.fn(),
        update: jest.fn(),
      },
      $transaction: jest.fn(async (fn: any) => {
        return fn({
          creditTransaction: prisma.creditTransaction,
          grantRedemption: prisma.grantRedemption,
        });
      }),
    };
    redis = {
      decrby: jest.fn().mockResolvedValue(0),
      set: jest.fn().mockResolvedValue('OK'),
    };
    const m = await Test.createTestingModule({
      providers: [
        CreditExpireService,
        { provide: PrismaService, useValue: prisma },
        { provide: RedisService, useValue: redis },
      ],
    }).compile();
    service = m.get(CreditExpireService);
  });

  it('sweep: writes reverse EXPIRE rows + flips isExpired flags + decrby grant pool', async () => {
    prisma.grantRedemption.findMany.mockResolvedValue([
      {
        id: 'g1',
        ruleId: 'r1',
        userId: 'u1',
        amount: 100,
        usedAmount: 0,
        expiresAt: new Date('2026-04-26'),
        isExpired: false,
        isUsedUp: false,
        txId: 'tx1',
      },
      {
        id: 'g2',
        ruleId: 'r1',
        userId: 'u2',
        amount: 50,
        usedAmount: 0,
        expiresAt: new Date('2026-04-26'),
        isExpired: false,
        isUsedUp: false,
        txId: 'tx2',
      },
    ]);
    redis.decrby.mockResolvedValueOnce(0).mockResolvedValueOnce(0);

    const r = await service.sweep(new Date('2026-04-27'));
    expect(r.scanned).toBe(2);
    expect(r.expired).toBe(2);
    expect(r.totalReversed).toBe(150);

    expect(redis.decrby).toHaveBeenCalledWith('credit:user:u1:grant', 100);
    expect(redis.decrby).toHaveBeenCalledWith('credit:user:u2:grant', 50);
    expect(prisma.creditTransaction.create.mock.invocationCallOrder[0]).toBeLessThan(
      redis.decrby.mock.invocationCallOrder[0],
    );
    expect(prisma.creditTransaction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          type: 'EXPIRE',
          creditsAmount: -100,
          userId: 'u1',
          source: 'expire:tx1',
          grantRuleId: 'r1',
        }),
      }),
    );
    expect(prisma.creditTransaction.update).toHaveBeenCalledWith({
      where: { id: 'tx1' },
      data: { isExpired: true },
    });
    expect(prisma.grantRedemption.update).toHaveBeenCalledWith({
      where: { id: 'g1' },
      data: { isExpired: true },
    });
  });

  it('sweep: partial usedAmount only reverses remaining (amount - usedAmount)', async () => {
    prisma.grantRedemption.findMany.mockResolvedValue([
      {
        id: 'g1',
        ruleId: 'r1',
        userId: 'u1',
        amount: 300,
        usedAmount: 100,
        expiresAt: new Date('2026-04-26'),
        isExpired: false,
        isUsedUp: false,
        txId: 'tx1',
      },
    ]);
    redis.decrby.mockResolvedValueOnce(50);

    const r = await service.sweep(new Date('2026-04-27'));
    expect(r.expired).toBe(1);
    expect(r.totalReversed).toBe(200); // 300 - 100
    expect(redis.decrby).toHaveBeenCalledWith('credit:user:u1:grant', 200);
    const expireData = prisma.creditTransaction.create.mock.calls[0][0].data;
    expect(expireData.creditsAmount).toBe(-200);
  });

  it('sweep: isUsedUp rows are flipped without reverse or pool decrement', async () => {
    prisma.grantRedemption.findMany.mockResolvedValue([
      {
        id: 'g1',
        ruleId: 'r1',
        userId: 'u1',
        amount: 100,
        usedAmount: 100,
        expiresAt: new Date('2026-04-26'),
        isExpired: false,
        isUsedUp: true,
        txId: 'tx1',
      },
    ]);

    const r = await service.sweep(new Date('2026-04-27'));
    expect(r.expired).toBe(0);
    expect(r.totalReversed).toBe(0);
    expect(redis.decrby).not.toHaveBeenCalled();
    expect(prisma.creditTransaction.create).not.toHaveBeenCalled();
    expect(prisma.grantRedemption.update).toHaveBeenCalledWith({
      where: { id: 'g1' },
      data: { isExpired: true },
    });
  });

  it('sweep: pool went negative → reset to 0 and warn', async () => {
    prisma.grantRedemption.findMany.mockResolvedValue([
      {
        id: 'g1',
        ruleId: 'r1',
        userId: 'u1',
        amount: 100,
        usedAmount: 0,
        expiresAt: new Date('2026-04-26'),
        isExpired: false,
        isUsedUp: false,
        txId: 'tx1',
      },
    ]);
    redis.decrby.mockResolvedValueOnce(-30); // someone else drained

    const r = await service.sweep(new Date('2026-04-27'));
    expect(redis.set).toHaveBeenCalledWith('credit:user:u1:grant', '0');
    expect(r.expired).toBe(1); // still flips ledger
  });

  it('sweep: handles failures per-row without aborting batch', async () => {
    prisma.grantRedemption.findMany.mockResolvedValue([
      {
        id: 'g1',
        ruleId: 'r1',
        userId: 'u1',
        amount: 100,
        usedAmount: 0,
        expiresAt: new Date('2026-04-26'),
        isExpired: false,
        isUsedUp: false,
        txId: 'tx1',
      },
      {
        id: 'g2',
        ruleId: 'r1',
        userId: 'u2',
        amount: 50,
        usedAmount: 0,
        expiresAt: new Date('2026-04-26'),
        isExpired: false,
        isUsedUp: false,
        txId: 'tx2',
      },
    ]);
    prisma.$transaction
      .mockImplementationOnce(() => Promise.reject(new Error('PG down')))
      .mockImplementationOnce(async (fn: any) =>
        fn({
          creditTransaction: prisma.creditTransaction,
          grantRedemption: prisma.grantRedemption,
        }),
      );
    const r = await service.sweep(new Date('2026-04-27'));
    expect(r.scanned).toBe(2);
    expect(r.expired).toBe(1);
    expect(r.failed).toBe(1);
    expect(r.totalReversed).toBe(50);
  });

  it('sweep: zero-amount rows are flipped without reverse or pool decrement', async () => {
    prisma.grantRedemption.findMany.mockResolvedValue([
      {
        id: 'g1',
        ruleId: 'r1',
        userId: 'u1',
        amount: 0,
        usedAmount: 0,
        expiresAt: new Date('2026-04-26'),
        isExpired: false,
        isUsedUp: false,
        txId: 'tx1',
      },
    ]);
    const r = await service.sweep(new Date('2026-04-27'));
    expect(r.expired).toBe(0);
    expect(redis.decrby).not.toHaveBeenCalled();
    expect(prisma.creditTransaction.create).not.toHaveBeenCalled();
    expect(prisma.grantRedemption.update).toHaveBeenCalledWith({
      where: { id: 'g1' },
      data: { isExpired: true },
    });
  });

  it('sweep: empty input → no-op', async () => {
    prisma.grantRedemption.findMany.mockResolvedValue([]);
    const r = await service.sweep();
    expect(r.scanned).toBe(0);
    expect(r.expired).toBe(0);
    expect(redis.decrby).not.toHaveBeenCalled();
  });

  it('sweep: Redis decrby failure keeps PG expire committed for reconcile repair', async () => {
    prisma.grantRedemption.findMany.mockResolvedValue([
      {
        id: 'g1',
        ruleId: 'r1',
        userId: 'u1',
        amount: 100,
        usedAmount: 0,
        expiresAt: new Date('2026-04-26'),
        isExpired: false,
        isUsedUp: false,
        txId: 'tx1',
      },
    ]);
    redis.decrby.mockRejectedValueOnce(new Error('Redis down'));

    const r = await service.sweep(new Date('2026-04-27'));
    // PG remains the authoritative ledger; Redis repair is handled by reconcile worker.
    expect(r.expired).toBe(1);
    expect(r.failed).toBe(1);
    expect(prisma.creditTransaction.create).toHaveBeenCalled();
    expect(prisma.grantRedemption.update).toHaveBeenCalledWith({
      where: { id: 'g1' },
      data: { isExpired: true },
    });
  });

  it('sweep: isUsedUp rows still mark isExpired even if Redis would fail (no decrby called)', async () => {
    prisma.grantRedemption.findMany.mockResolvedValue([
      {
        id: 'g1',
        ruleId: 'r1',
        userId: 'u1',
        amount: 100,
        usedAmount: 100,
        expiresAt: new Date('2026-04-26'),
        isExpired: false,
        isUsedUp: true,
        txId: 'tx1',
      },
    ]);
    // decrby would throw, but it shouldn't be called for isUsedUp rows
    redis.decrby.mockRejectedValue(new Error('Redis down'));

    const r = await service.sweep(new Date('2026-04-27'));
    expect(r.expired).toBe(0); // not counted in expired (no reverse), but flagged
    expect(r.failed).toBe(0);
    expect(redis.decrby).not.toHaveBeenCalled();
    expect(prisma.grantRedemption.update).toHaveBeenCalledWith({
      where: { id: 'g1' },
      data: { isExpired: true },
    });
  });
});
