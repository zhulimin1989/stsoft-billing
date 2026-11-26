import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { PrismaService } from '../prisma/prisma.service';
import { CreditGrantsService } from './credit-grants.service';

/**
 * Service tests use an in-memory Prisma stub. Focus on field validation,
 * cross-field invariants (cronExpr ↔ triggerType, expireDays ↔ N_DAYS,
 * notifyTemplate ↔ notifyType), and the date helper for expiresAt.
 */
describe('CreditGrantsService', () => {
  let service: CreditGrantsService;
  let prisma: any;

  const baseRule = (overrides: Record<string, unknown> = {}) => ({
    id: 'r1',
    name: 'daily 100',
    triggerType: 'DAILY_CRON',
    cronExpr: '0 0 * * *',
    segmentId: null,
    rewardType: 'CREDIT',
    rewardAmount: 100,
    productId: null,
    expirePolicy: 'PERMANENT',
    expireDays: null,
    perUserLimit: 1,
    globalDailyCap: null,
    isActive: true,
    startAt: null,
    endAt: null,
    notifyType: null,
    notifyTemplate: null,
    lastTriggeredAt: null,
    createdAt: new Date('2026-04-01'),
    updatedAt: new Date('2026-04-01'),
    deletedAt: null,
    ...overrides,
  });

  beforeEach(async () => {
    prisma = {
      creditGrantRule: {
        findFirst: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
      },
      grantRedemption: {
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
      },
      userSegment: {
        findFirst: jest.fn(),
      },
      userSegmentMember: {
        findMany: jest.fn(),
      },
      product: {
        findFirst: jest.fn().mockResolvedValue({ id: 'p1' }),
        findUnique: jest.fn().mockResolvedValue({ id: 'p1' }),
      },
      user: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const m = await Test.createTestingModule({
      providers: [
        CreditGrantsService,
        { provide: PrismaService, useValue: prisma },
      ],
    }).compile();
    service = m.get(CreditGrantsService);
  });

  // ---------- create validation ----------

  it('create: DAILY_CRON without cronExpr is rejected', async () => {
    await expect(
      service.create({
        name: 'r',
        triggerType: 'DAILY_CRON',
        rewardType: 'CREDIT',
        rewardAmount: 100,
        expirePolicy: 'PERMANENT',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('create: FIRST_LOGIN with cronExpr is rejected', async () => {
    await expect(
      service.create({
        name: 'r',
        triggerType: 'FIRST_LOGIN',
        cronExpr: '0 0 * * *',
        rewardType: 'CREDIT',
        rewardAmount: 100,
        expirePolicy: 'PERMANENT',
      }),
    ).rejects.toThrow(/cronExpr/);
  });

  it('create: N_DAYS without expireDays is rejected', async () => {
    await expect(
      service.create({
        name: 'r',
        triggerType: 'DAILY_CRON',
        cronExpr: '0 0 * * *',
        rewardType: 'CREDIT',
        rewardAmount: 100,
        expirePolicy: 'N_DAYS',
      }),
    ).rejects.toThrow(/expireDays/);
  });

  it('create: PERMANENT with expireDays is rejected', async () => {
    await expect(
      service.create({
        name: 'r',
        triggerType: 'DAILY_CRON',
        cronExpr: '0 0 * * *',
        rewardType: 'CREDIT',
        rewardAmount: 100,
        expirePolicy: 'PERMANENT',
        expireDays: 7,
      }),
    ).rejects.toThrow(/expireDays/);
  });

  it('create: rewardAmount must be positive', async () => {
    await expect(
      service.create({
        name: 'r',
        triggerType: 'DAILY_CRON',
        cronExpr: '0 0 * * *',
        rewardType: 'CREDIT',
        rewardAmount: 0,
        expirePolicy: 'PERMANENT',
      }),
    ).rejects.toThrow(/rewardAmount/);
  });

  it('create: BOOSTER_PACK rewardType is rejected until SKU binding exists', async () => {
    await expect(
      service.create({
        name: 'r',
        triggerType: 'DAILY_CRON',
        cronExpr: '0 0 * * *',
        rewardType: 'BOOSTER_PACK',
        rewardAmount: 100,
        expirePolicy: 'PERMANENT',
      }),
    ).rejects.toThrow(/BOOSTER_PACK/);
    expect(prisma.creditGrantRule.create).not.toHaveBeenCalled();
  });

  it('create: notifyType=EMAIL requires notifyTemplate', async () => {
    await expect(
      service.create({
        name: 'r',
        triggerType: 'DAILY_CRON',
        cronExpr: '0 0 * * *',
        rewardType: 'CREDIT',
        rewardAmount: 100,
        expirePolicy: 'PERMANENT',
        notifyType: 'EMAIL',
      }),
    ).rejects.toThrow(/notifyTemplate/);
  });

  it('create: endAt before startAt is rejected', async () => {
    await expect(
      service.create({
        name: 'r',
        triggerType: 'DAILY_CRON',
        cronExpr: '0 0 * * *',
        rewardType: 'CREDIT',
        rewardAmount: 100,
        expirePolicy: 'PERMANENT',
        startAt: '2026-04-10T00:00:00Z',
        endAt: '2026-04-09T00:00:00Z',
      }),
    ).rejects.toThrow(/startAt/);
  });

  it('create: invalid cronExpr is rejected', async () => {
    await expect(
      service.create({
        name: 'r',
        triggerType: 'DAILY_CRON',
        cronExpr: 'not-a-cron',
        rewardType: 'CREDIT',
        rewardAmount: 100,
        expirePolicy: 'PERMANENT',
      }),
    ).rejects.toThrow(/cronExpr/);
  });

  it('create: segmentId not found is rejected', async () => {
    prisma.userSegment.findFirst.mockResolvedValue(null);
    await expect(
      service.create({
        name: 'r',
        triggerType: 'DAILY_CRON',
        cronExpr: '0 0 * * *',
        segmentId: 'missing',
        rewardType: 'CREDIT',
        rewardAmount: 100,
        expirePolicy: 'PERMANENT',
      }),
    ).rejects.toThrow(/segmentId/);
  });

  it('create: happy path', async () => {
    prisma.creditGrantRule.create.mockResolvedValue(baseRule());
    const r = await service.create({
      name: 'daily 100',
      triggerType: 'DAILY_CRON',
      cronExpr: '0 0 * * *',
      rewardType: 'CREDIT',
      rewardAmount: 100,
      expirePolicy: 'PERMANENT',
    });
    expect(r.id).toBe('r1');
    expect(prisma.creditGrantRule.create).toHaveBeenCalled();
  });

  // ---------- update ----------

  it('update: switching triggerType to FIRST_LOGIN must clear cronExpr', async () => {
    prisma.creditGrantRule.findFirst.mockResolvedValue(baseRule());
    await expect(
      service.update('r1', {
        triggerType: 'FIRST_LOGIN',
        // cronExpr left as-is on existing row → merged still has it → reject
      }),
    ).rejects.toThrow(/cronExpr/);
  });

  it('update: not found throws', async () => {
    prisma.creditGrantRule.findFirst.mockResolvedValue(null);
    await expect(service.update('x', { name: 'y' })).rejects.toThrow(
      NotFoundException,
    );
  });

  it('update: switching to BOOSTER_PACK is rejected', async () => {
    prisma.creditGrantRule.findFirst.mockResolvedValue(baseRule());
    await expect(
      service.update('r1', { rewardType: 'BOOSTER_PACK' }),
    ).rejects.toThrow(/BOOSTER_PACK/);
    expect(prisma.creditGrantRule.update).not.toHaveBeenCalled();
  });

  // ---------- expiresAt helper ----------

  it('computeExpiresAt: PERMANENT → null', () => {
    expect(service.computeExpiresAt('PERMANENT', null)).toBeNull();
  });

  it('computeExpiresAt: SAME_DAY_END returns end of UTC day', () => {
    const now = new Date(Date.UTC(2026, 3, 27, 8, 0, 0));
    const end = service.computeExpiresAt('SAME_DAY_END', null, now);
    expect(end?.getUTCHours()).toBe(23);
    expect(end?.getUTCMinutes()).toBe(59);
    expect(end?.getUTCSeconds()).toBe(59);
  });

  it('computeExpiresAt: N_DAYS adds days', () => {
    const now = new Date(Date.UTC(2026, 3, 27, 8, 0, 0));
    const end = service.computeExpiresAt('N_DAYS', 7, now);
    expect(end?.getUTCDate()).toBe(4); // 27 Apr + 7 = 4 May
    expect(end?.getUTCMonth()).toBe(4);
  });

  it('computeExpiresAt: NEXT_RESET = first of next month UTC', () => {
    const now = new Date(Date.UTC(2026, 3, 27, 8, 0, 0));
    const end = service.computeExpiresAt('NEXT_RESET', null, now);
    expect(end?.getUTCDate()).toBe(1);
    expect(end?.getUTCMonth()).toBe(4); // May
    expect(end?.getUTCHours()).toBe(0);
  });

  // ---------- target user resolution ----------

  it('resolveTargetUserIds: no segment → all active users', async () => {
    prisma.user.findMany.mockResolvedValue([{ id: 'u1' }, { id: 'u2' }]);
    const ids = await service.resolveTargetUserIds(null);
    expect(ids).toEqual(['u1', 'u2']);
  });

  it('resolveTargetUserIds: STATIC segment → member rows', async () => {
    prisma.userSegment.findFirst.mockResolvedValue({
      id: 's1',
      ruleType: 'STATIC',
      ruleExpr: null,
    });
    prisma.userSegmentMember.findMany.mockResolvedValue([
      { userId: 'u1' },
      { userId: 'u3' },
    ]);
    const ids = await service.resolveTargetUserIds('s1');
    expect(ids).toEqual(['u1', 'u3']);
  });

  it('resolveTargetUserIds: deleted segment → empty', async () => {
    prisma.userSegment.findFirst.mockResolvedValue(null);
    const ids = await service.resolveTargetUserIds('s1');
    expect(ids).toEqual([]);
  });

  // ---------- list / preview / redemptions ----------

  it('list: paginates + filters', async () => {
    prisma.creditGrantRule.findMany.mockResolvedValue([baseRule()]);
    prisma.creditGrantRule.count.mockResolvedValue(1);
    const r = await service.list({
      page: 1,
      pageSize: 20,
      triggerType: 'DAILY_CRON',
      isActive: true,
    });
    expect(r.total).toBe(1);
    expect(prisma.creditGrantRule.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          deletedAt: null,
          triggerType: 'DAILY_CRON',
          isActive: true,
        }),
      }),
    );
  });

  // P2-D review fix Critical#1: hidden referral GrantRule 必须从 admin /grant-rules 列表过滤
  it('list: hidden __referral: rules are filtered out', async () => {
    prisma.creditGrantRule.findMany.mockResolvedValue([]);
    prisma.creditGrantRule.count.mockResolvedValue(0);
    await service.list({ page: 1, pageSize: 20 });
    const findManyArgs = prisma.creditGrantRule.findMany.mock.calls[0][0];
    expect(findManyArgs.where.name).toEqual({
      not: { startsWith: '__referral:' },
    });
    // count 用同样的 where
    const countArgs = prisma.creditGrantRule.count.mock.calls[0][0];
    expect(countArgs.where.name).toEqual({
      not: { startsWith: '__referral:' },
    });
  });

  it('list: search 与 hidden 过滤可同时生效', async () => {
    prisma.creditGrantRule.findMany.mockResolvedValue([]);
    prisma.creditGrantRule.count.mockResolvedValue(0);
    await service.list({ page: 1, pageSize: 20, search: 'daily' });
    const findManyArgs = prisma.creditGrantRule.findMany.mock.calls[0][0];
    expect(findManyArgs.where.name).toEqual({
      contains: 'daily',
      mode: 'insensitive',
      not: { startsWith: '__referral:' },
    });
  });

  it('preview: matchedCount + estimatedTotal', async () => {
    prisma.creditGrantRule.findFirst.mockResolvedValue(baseRule());
    prisma.user.findMany.mockResolvedValue([
      { id: 'u1' },
      { id: 'u2' },
      { id: 'u3' },
    ]);
    const r = await service.preview('r1');
    expect(r.matchedCount).toBe(3);
    expect(r.estimatedTotalAmount).toBe(300);
    expect(r.sampleUserIds).toHaveLength(3);
  });

  it('preview: globalDailyCap caps the count', async () => {
    prisma.creditGrantRule.findFirst.mockResolvedValue(
      baseRule({ globalDailyCap: 2 }),
    );
    prisma.user.findMany.mockResolvedValue([
      { id: 'u1' },
      { id: 'u2' },
      { id: 'u3' },
    ]);
    const r = await service.preview('r1');
    expect(r.matchedCount).toBe(2);
    expect(r.estimatedTotalAmount).toBe(200);
  });

  it('listRedemptions: returns paginated rows', async () => {
    prisma.creditGrantRule.findFirst.mockResolvedValue(baseRule());
    prisma.grantRedemption.findMany.mockResolvedValue([
      {
        id: 'g1',
        ruleId: 'r1',
        userId: 'u1',
        amount: 100,
        expiresAt: null,
        isExpired: false,
        isUsedUp: false,
        txId: 'tx1',
        createdAt: new Date(),
        user: { email: 'u@example.com', nickname: 'u' },
      },
    ]);
    prisma.grantRedemption.count.mockResolvedValue(1);
    const r = await service.listRedemptions('r1', 1, 20);
    expect(r.total).toBe(1);
    expect(r.items[0].userId).toBe('u1');
  });

  // ---------- soft delete ----------

  it('softDelete: sets deletedAt + isActive=false', async () => {
    prisma.creditGrantRule.findFirst.mockResolvedValue(baseRule());
    await service.softDelete('r1');
    expect(prisma.creditGrantRule.update).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          deletedAt: expect.any(Date),
          isActive: false,
        }),
      }),
    );
  });
});
