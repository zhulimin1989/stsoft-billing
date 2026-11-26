/**
 * ReferralsService unit tests (spec §10).
 *
 * Mock 策略:
 *   - PrismaService: jest mock(无真实 DB,模拟 Prisma 客户端)
 *   - RedisService: jest mock(默认 cache miss,fallthrough DB)
 *   - CreditGrantExecutor: jest mock grantToUserDirect
 */
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Test } from '@nestjs/testing';
import { Prisma } from '@prisma/client';
import { CreditGrantExecutor } from '../credit-grants/credit-grant-executor';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { ReferralsService } from './referrals.service';

function makePrisma() {
  return {
    referralProgram: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
    },
    referralCode: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
    },
    referralRedemption: {
      findFirst: jest.fn(),
      findMany: jest.fn(),
      findUnique: jest.fn(),
      count: jest.fn().mockResolvedValue(0),
      upsert: jest.fn(),
      update: jest.fn(),
      groupBy: jest.fn(),
    },
    referralClick: {
      upsert: jest.fn(),
      groupBy: jest.fn().mockResolvedValue([]),
    },
    creditGrantRule: {
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
      findUnique: jest.fn(),
    },
    user: {
      findMany: jest.fn(),
    },
    order: {
      findUnique: jest.fn(),
    },
    $transaction: jest.fn(async (fn: any) => {
      // 把 tx 简单转给同一个 prisma mock
      return fn(this as any);
    }),
  };
}

function makeRedis() {
  return {
    get: jest.fn().mockResolvedValue(null),
    set: jest.fn().mockResolvedValue('OK'),
  };
}

function makeExecutor() {
  return {
    grantToUserDirect: jest.fn().mockResolvedValue({}),
  };
}

async function buildService(
  prismaOverrides: Record<string, any> = {},
  redisOverrides: Record<string, any> = {},
  executorOverrides: Record<string, any> = {},
) {
  const prismaBase = makePrisma() as any;
  prismaBase.$transaction = jest.fn(async (fn: any) => fn(prismaBase));
  const prisma = { ...prismaBase, ...prismaOverrides } as any;
  const redis = { ...makeRedis(), ...redisOverrides } as any;
  const executor = { ...makeExecutor(), ...executorOverrides } as any;

  const m = await Test.createTestingModule({
    providers: [
      ReferralsService,
      { provide: PrismaService, useValue: prisma },
      { provide: RedisService, useValue: redis },
      { provide: CreditGrantExecutor, useValue: executor },
    ],
  }).compile();

  return {
    service: m.get(ReferralsService),
    prisma,
    redis,
    executor,
  };
}

// ============================================================
// createProgram (spec §7.1)
// ============================================================
describe('ReferralsService.createProgram', () => {
  // 奖励逻辑暂未开放:createProgram 强制 trackingOnly=true(仅追踪),
  // 不创建 hidden GrantRule、不实际发奖(见 service 内注释)。
  it('forces tracking-only: persists trackingOnly=true, creates no GrantRule', async () => {
    const { service, prisma } = await buildService();
    prisma.referralProgram.create.mockResolvedValue({ id: 'p1' });

    await service.createProgram({
      name: '裂变活动 1',
      inviterReward: 100,
      inviteeReward: 50,
      rewardCondition: 'REGISTER',
    });

    expect(prisma.referralProgram.create).toHaveBeenCalledTimes(1);
    expect(prisma.referralProgram.create.mock.calls[0][0].data.trackingOnly).toBe(
      true,
    );
    // 仅追踪:不建 GrantRule,也不回填 grantRuleId
    expect(prisma.creditGrantRule.create).not.toHaveBeenCalled();
    expect(prisma.referralProgram.update).not.toHaveBeenCalled();
  });

  it('forces tracking-only even when caller passes trackingOnly=false', async () => {
    const { service, prisma } = await buildService();
    prisma.referralProgram.create.mockResolvedValue({ id: 'p2' });

    await service.createProgram({
      name: '试图关闭仅追踪',
      inviterReward: 1000,
      inviteeReward: 500,
      rewardCondition: 'FIRST_RECHARGE',
      productId: 'prod-1',
      trackingOnly: false,
    });

    expect(prisma.referralProgram.create.mock.calls[0][0].data.trackingOnly).toBe(
      true,
    );
    expect(prisma.creditGrantRule.create).not.toHaveBeenCalled();
  });

  it('rejects invalid name', async () => {
    const { service } = await buildService();
    await expect(
      service.createProgram({
        name: '',
        inviterReward: 100,
        inviteeReward: 50,
        rewardCondition: 'REGISTER',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('allows zero reward (tracking-only) but rejects negative reward', async () => {
    const { service, prisma } = await buildService();
    prisma.referralProgram.create.mockResolvedValue({ id: 'p3' });
    // 仅追踪下奖励下限放宽到 0 —— 0 合法
    await expect(
      service.createProgram({
        name: 'zero',
        inviterReward: 0,
        inviteeReward: 0,
        rewardCondition: 'REGISTER',
      }),
    ).resolves.toBeDefined();
    // 负数仍非法
    await expect(
      service.createProgram({
        name: 'neg',
        inviterReward: -1,
        inviteeReward: 0,
        rewardCondition: 'REGISTER',
      }),
    ).rejects.toThrow(BadRequestException);
  });

  it('rejects illegal rewardCondition', async () => {
    const { service } = await buildService();
    await expect(
      service.createProgram({
        name: 'x',
        inviterReward: 1,
        inviteeReward: 1,
        rewardCondition: 'NOPE' as any,
      }),
    ).rejects.toThrow(BadRequestException);
  });
});

// ============================================================
// updateProgram
// ============================================================
describe('ReferralsService.updateProgram', () => {
  // 奖励逻辑暂未开放:updateProgram 强制归正 trackingOnly=true,顺带修复历史
  // 遗留的 trackingOnly=false 程序,且不再同步/创建 GrantRule。
  it('forces trackingOnly=true and does not sync GrantRule (repairs legacy false program)', async () => {
    const { service, prisma } = await buildService();
    prisma.referralProgram.findFirst.mockResolvedValue({
      id: 'p1',
      name: 'old',
      inviterReward: 100,
      inviteeReward: 50,
      rewardCondition: 'REGISTER',
      productId: null,
      trackingOnly: false, // 历史遗留:曾开启发奖
      isActive: true,
      startAt: null,
      endAt: null,
      sameIpLimit: null,
      sameDeviceLimit: null,
      perUserInviteLimit: null,
      inviterGrantRuleId: 'rule-inviter',
      inviteeGrantRuleId: 'rule-invitee',
    });
    prisma.referralProgram.update.mockResolvedValue({});

    // 即便入参尝试关闭仅追踪,也应被强制归正为 true
    await service.updateProgram('p1', {
      inviterReward: 200,
      inviteeReward: 80,
      trackingOnly: false,
    });

    expect(prisma.referralProgram.update.mock.calls[0][0].data.trackingOnly).toBe(
      true,
    );
    // 仅追踪:不再同步 GrantRule
    expect(prisma.creditGrantRule.update).not.toHaveBeenCalled();
  });

  it('throws NotFoundException for missing program', async () => {
    const { service, prisma } = await buildService();
    prisma.referralProgram.findFirst.mockResolvedValue(null);
    await expect(
      service.updateProgram('nope', { inviterReward: 1 }),
    ).rejects.toThrow(NotFoundException);
  });
});

// ============================================================
// deleteProgram
// ============================================================
describe('ReferralsService.deleteProgram', () => {
  it('soft-deletes program and deactivates hidden GrantRules', async () => {
    const { service, prisma } = await buildService();
    prisma.referralProgram.findFirst.mockResolvedValue({
      id: 'p1',
      inviterGrantRuleId: 'r1',
      inviteeGrantRuleId: 'r2',
    });
    prisma.referralProgram.update.mockResolvedValue({});
    prisma.creditGrantRule.updateMany.mockResolvedValue({ count: 2 });

    await service.deleteProgram('p1');

    expect(prisma.referralProgram.update).toHaveBeenCalledWith({
      where: { id: 'p1' },
      data: expect.objectContaining({ deletedAt: expect.any(Date), isActive: false }),
    });
    expect(prisma.creditGrantRule.updateMany).toHaveBeenCalledWith({
      where: { id: { in: ['r1', 'r2'] } },
      data: { isActive: false },
    });
  });
});

// ============================================================
// getMyReferralCode (spec §7.1 lazy generation)
// ============================================================
describe('ReferralsService.getMyReferralCode', () => {
  it('returns existing code if already generated', async () => {
    const { service, prisma } = await buildService();
    prisma.referralProgram.findFirst.mockResolvedValue({ id: 'p1' });
    prisma.referralCode.findUnique.mockResolvedValue({
      code: 'ABCD1234',
      programId: 'p1',
    });

    const out = await service.getMyReferralCode('user-1');
    expect(out).toEqual({ code: 'ABCD1234', programId: 'p1' });
    expect(prisma.referralCode.create).not.toHaveBeenCalled();
  });

  it('lazy-generates 8-char BASE32 code on first call', async () => {
    const { service, prisma } = await buildService();
    prisma.referralProgram.findFirst.mockResolvedValue({ id: 'p1' });
    prisma.referralCode.findUnique.mockResolvedValue(null);
    prisma.referralCode.create.mockResolvedValue({
      code: 'XYZ12345',
      programId: 'p1',
    });

    const out = await service.getMyReferralCode('user-1');
    expect(out.code).toBe('XYZ12345');
    expect(prisma.referralCode.create).toHaveBeenCalledTimes(1);
  });

  it('retries on P2002 unique violation (code collision), succeeds on retry', async () => {
    const { service, prisma } = await buildService();
    prisma.referralProgram.findFirst.mockResolvedValue({ id: 'p1' });
    prisma.referralCode.findUnique
      .mockResolvedValueOnce(null) // initial check
      .mockResolvedValueOnce(null); // after P2002, no race winner
    const p2002 = new Prisma.PrismaClientKnownRequestError(
      'unique violation',
      { code: 'P2002', clientVersion: '6' } as any,
    );
    prisma.referralCode.create
      .mockRejectedValueOnce(p2002)
      .mockResolvedValueOnce({ code: 'GOOD2222', programId: 'p1' });

    const out = await service.getMyReferralCode('user-1');
    expect(out.code).toBe('GOOD2222');
    expect(prisma.referralCode.create).toHaveBeenCalledTimes(2);
  });

  it('throws NotFoundException when no active program', async () => {
    const { service, prisma } = await buildService();
    prisma.referralProgram.findFirst.mockResolvedValue(null);
    await expect(service.getMyReferralCode('user-1')).rejects.toThrow(
      NotFoundException,
    );
  });
});

// ============================================================
// attribute (spec §7.1 注册归因)
// ============================================================
describe('ReferralsService.attribute', () => {
  it('silently returns when referralCode is missing', async () => {
    const { service, prisma } = await buildService();
    await service.attribute({ inviteeUserId: 'u-new' });
    expect(prisma.referralRedemption.upsert).not.toHaveBeenCalled();
  });

  it('silently returns when code lookup fails (DB miss)', async () => {
    const { service, prisma } = await buildService();
    prisma.referralCode.findFirst.mockResolvedValue(null);
    await service.attribute({
      inviteeUserId: 'u-new',
      referralCode: 'BADCODE1',
    });
    expect(prisma.referralRedemption.upsert).not.toHaveBeenCalled();
  });

  it('rejects self-attribution', async () => {
    const { service, prisma } = await buildService();
    prisma.referralCode.findFirst.mockResolvedValue({
      programId: 'p1',
      inviterUserId: 'u-self',
      program: {
        id: 'p1',
        isActive: true,
        startAt: null,
        endAt: null,
        deletedAt: null,
      },
    });
    await service.attribute({
      inviteeUserId: 'u-self',
      referralCode: 'CODE1234',
    });
    expect(prisma.referralRedemption.upsert).not.toHaveBeenCalled();
  });

  it('writes redemption with rejectReason on SAME_IP_LIMIT', async () => {
    const { service, prisma } = await buildService();
    prisma.referralCode.findFirst.mockResolvedValue({
      programId: 'p1',
      inviterUserId: 'u-inviter',
      program: {
        id: 'p1',
        isActive: true,
        startAt: null,
        endAt: null,
        deletedAt: null,
      },
    });
    prisma.referralProgram.findFirst.mockResolvedValue({
      id: 'p1',
      isActive: true,
      sameIpLimit: 1,
      sameDeviceLimit: null,
      perUserInviteLimit: null,
      rewardCondition: 'REGISTER',
      inviterGrantRuleId: 'r1',
      inviteeGrantRuleId: 'r2',
      deletedAt: null,
    });
    prisma.referralRedemption.count.mockResolvedValueOnce(2); // already 2 same-IP redemptions
    prisma.referralCode.findUnique.mockResolvedValue({ id: 'code-1' });
    prisma.referralRedemption.upsert.mockResolvedValue({ id: 'red-1' });

    await service.attribute({
      inviteeUserId: 'u-new',
      referralCode: 'CODE1234',
      inviteeIp: '1.2.3.4',
    });

    expect(prisma.referralRedemption.upsert).toHaveBeenCalledTimes(1);
    const args = prisma.referralRedemption.upsert.mock.calls[0][0];
    expect(args.create.rejectReason).toBe('SAME_IP_LIMIT');
    // 命中防作弊 → 不调 grantExecutor
    const { executor } = (await buildService()) as any;
    expect(executor.grantToUserDirect).not.toHaveBeenCalled();
  });

  it('writes redemption with rejectReason on PER_USER_INVITE_LIMIT', async () => {
    const { service, prisma, executor } = await buildService();
    prisma.referralCode.findFirst.mockResolvedValue({
      programId: 'p1',
      inviterUserId: 'u-inviter',
      program: {
        id: 'p1',
        isActive: true,
        startAt: null,
        endAt: null,
        deletedAt: null,
      },
    });
    prisma.referralProgram.findFirst.mockResolvedValue({
      id: 'p1',
      isActive: true,
      sameIpLimit: null,
      sameDeviceLimit: null,
      perUserInviteLimit: 5,
      rewardCondition: 'REGISTER',
      inviterGrantRuleId: 'r1',
      inviteeGrantRuleId: 'r2',
      deletedAt: null,
    });
    prisma.referralRedemption.count.mockResolvedValueOnce(5); // already 5 invites
    prisma.referralCode.findUnique.mockResolvedValue({ id: 'code-1' });
    prisma.referralRedemption.upsert.mockResolvedValue({ id: 'red-1' });

    await service.attribute({
      inviteeUserId: 'u-new',
      referralCode: 'CODE1234',
    });

    const args = prisma.referralRedemption.upsert.mock.calls[0][0];
    expect(args.create.rejectReason).toBe('PER_USER_INVITE_LIMIT');
    expect(executor.grantToUserDirect).not.toHaveBeenCalled();
  });

  it('writes redemption with rejectReason on SAME_DEVICE_LIMIT', async () => {
    const { service, prisma } = await buildService();
    prisma.referralCode.findFirst.mockResolvedValue({
      programId: 'p1',
      inviterUserId: 'u-inviter',
      program: {
        id: 'p1',
        isActive: true,
        startAt: null,
        endAt: null,
        deletedAt: null,
      },
    });
    prisma.referralProgram.findFirst.mockResolvedValue({
      id: 'p1',
      isActive: true,
      sameIpLimit: null,
      sameDeviceLimit: 1,
      perUserInviteLimit: null,
      rewardCondition: 'REGISTER',
      inviterGrantRuleId: 'r1',
      inviteeGrantRuleId: 'r2',
      deletedAt: null,
    });
    prisma.referralRedemption.count.mockResolvedValueOnce(1);
    prisma.referralCode.findUnique.mockResolvedValue({ id: 'code-1' });
    prisma.referralRedemption.upsert.mockResolvedValue({ id: 'red-1' });

    await service.attribute({
      inviteeUserId: 'u-new',
      referralCode: 'CODE1234',
      deviceId: 'dev-X',
    });

    const args = prisma.referralRedemption.upsert.mock.calls[0][0];
    expect(args.create.rejectReason).toBe('SAME_DEVICE_LIMIT');
  });

  it('REGISTER condition: triggers grantToUserDirect for both inviter and invitee', async () => {
    const { service, prisma, executor } = await buildService();
    prisma.referralCode.findFirst.mockResolvedValue({
      programId: 'p1',
      inviterUserId: 'u-inviter',
      program: {
        id: 'p1',
        isActive: true,
        startAt: null,
        endAt: null,
        deletedAt: null,
      },
    });
    prisma.referralProgram.findFirst.mockResolvedValue({
      id: 'p1',
      isActive: true,
      sameIpLimit: null,
      sameDeviceLimit: null,
      perUserInviteLimit: null,
      rewardCondition: 'REGISTER',
      inviterGrantRuleId: 'r-inviter',
      inviteeGrantRuleId: 'r-invitee',
      deletedAt: null,
    });
    prisma.referralCode.findUnique.mockResolvedValue({ id: 'code-1' });
    prisma.referralRedemption.upsert.mockResolvedValue({ id: 'red-1' });
    prisma.referralRedemption.findUnique.mockResolvedValue({
      id: 'red-1',
      inviterGranted: false,
      inviteeGranted: false,
    });
    prisma.creditGrantRule.findUnique
      .mockResolvedValueOnce({ id: 'r-inviter', rewardAmount: 100 })
      .mockResolvedValueOnce({ id: 'r-invitee', rewardAmount: 50 });
    prisma.referralRedemption.update.mockResolvedValue({ id: 'red-1' });

    await service.attribute({
      inviteeUserId: 'u-new',
      referralCode: 'CODE1234',
    });

    expect(executor.grantToUserDirect).toHaveBeenCalledTimes(2);
    const inviterArgs = executor.grantToUserDirect.mock.calls[0];
    const inviteeArgs = executor.grantToUserDirect.mock.calls[1];
    expect(inviterArgs[1]).toBe('u-inviter');
    expect(inviteeArgs[1]).toBe('u-new');
    // P2-D review fix: 拆分 per-party 标记 + 兼容 rewardGranted=true
    const updateCalls = prisma.referralRedemption.update.mock.calls.map(
      (c: any[]) => c[0],
    );
    expect(updateCalls).toEqual(
      expect.arrayContaining([
        { where: { id: 'red-1' }, data: { inviterGranted: true } },
        { where: { id: 'red-1' }, data: { inviteeGranted: true } },
        { where: { id: 'red-1' }, data: { rewardGranted: true } },
      ]),
    );
  });

  it('FIRST_RECHARGE condition: writes redemption with triggeredAt=null, no immediate grant', async () => {
    const { service, prisma, executor } = await buildService();
    prisma.referralCode.findFirst.mockResolvedValue({
      programId: 'p1',
      inviterUserId: 'u-inviter',
      program: {
        id: 'p1',
        isActive: true,
        startAt: null,
        endAt: null,
        deletedAt: null,
      },
    });
    prisma.referralProgram.findFirst.mockResolvedValue({
      id: 'p1',
      isActive: true,
      rewardCondition: 'FIRST_RECHARGE',
      sameIpLimit: null,
      sameDeviceLimit: null,
      perUserInviteLimit: null,
      inviterGrantRuleId: 'r1',
      inviteeGrantRuleId: 'r2',
      deletedAt: null,
    });
    prisma.referralCode.findUnique.mockResolvedValue({ id: 'code-1' });
    prisma.referralRedemption.upsert.mockResolvedValue({ id: 'red-1' });

    await service.attribute({
      inviteeUserId: 'u-new',
      referralCode: 'CODE1234',
    });

    const args = prisma.referralRedemption.upsert.mock.calls[0][0];
    expect(args.create.triggeredAt).toBeNull();
    expect(executor.grantToUserDirect).not.toHaveBeenCalled();
  });

  it('swallows internal errors silently (red-line)', async () => {
    const { service, prisma } = await buildService();
    prisma.referralCode.findFirst.mockRejectedValue(new Error('DB down'));
    // 不抛
    await expect(
      service.attribute({ inviteeUserId: 'u', referralCode: 'CODE1234' }),
    ).resolves.toBeUndefined();
  });

  // P2-D review fix Critical#2: TOCTOU 二次复核
  it('TOCTOU double-check: 二次 count 命中 limit → 不发奖,标 RACE_REJECTED', async () => {
    const { service, prisma, executor } = await buildService();
    prisma.referralCode.findFirst.mockResolvedValue({
      programId: 'p1',
      inviterUserId: 'u-inviter',
      program: {
        id: 'p1',
        isActive: true,
        startAt: null,
        endAt: null,
        deletedAt: null,
      },
    });
    prisma.referralProgram.findFirst.mockResolvedValue({
      id: 'p1',
      isActive: true,
      sameIpLimit: 1,
      sameDeviceLimit: null,
      perUserInviteLimit: null,
      rewardCondition: 'REGISTER',
      inviterGrantRuleId: 'r-inviter',
      inviteeGrantRuleId: 'r-invitee',
      deletedAt: null,
    });
    // 第一次 anti-abuse count 全部返 0 → 通过;
    // 二次复核 count 返 limit → 命中 SAME_IP_LIMIT → 拒发奖。
    prisma.referralRedemption.count
      .mockResolvedValueOnce(0) // 1st checkAntiAbuse: sameIp
      .mockResolvedValueOnce(1); // 2nd checkAntiAbuse: sameIp now hits
    prisma.referralCode.findUnique.mockResolvedValue({ id: 'code-1' });
    prisma.referralRedemption.upsert.mockResolvedValue({ id: 'red-1' });
    prisma.referralRedemption.update.mockResolvedValue({});

    await service.attribute({
      inviteeUserId: 'u-new',
      referralCode: 'CODE1234',
      inviteeIp: '1.2.3.4',
    });

    // 二次拒绝 → 不调 grantToUserDirect
    expect(executor.grantToUserDirect).not.toHaveBeenCalled();
    // 标记 redemption.rejectReason 含 RACE_REJECTED
    const updateCalls = prisma.referralRedemption.update.mock.calls.map(
      (c: any[]) => c[0],
    );
    const raceCall = updateCalls.find((c: any) =>
      typeof c?.data?.rejectReason === 'string' &&
      c.data.rejectReason.startsWith('RACE_REJECTED'),
    );
    expect(raceCall).toBeTruthy();
    expect(raceCall.data.rejectReason).toBe('RACE_REJECTED:SAME_IP_LIMIT');
  });

  // P2-D review fix Important#2: invitee 失败重试只调 invitee
  it('per-party retry: 第二次 triggerRewards 只调 invitee.grantToUserDirect', async () => {
    const { service, prisma, executor } = await buildService();
    prisma.referralCode.findFirst.mockResolvedValue({
      programId: 'p1',
      inviterUserId: 'u-inviter',
      program: {
        id: 'p1',
        isActive: true,
        startAt: null,
        endAt: null,
        deletedAt: null,
      },
    });
    prisma.referralProgram.findFirst.mockResolvedValue({
      id: 'p1',
      isActive: true,
      sameIpLimit: null,
      sameDeviceLimit: null,
      perUserInviteLimit: null,
      rewardCondition: 'REGISTER',
      inviterGrantRuleId: 'r-inviter',
      inviteeGrantRuleId: 'r-invitee',
      deletedAt: null,
    });
    prisma.referralCode.findUnique.mockResolvedValue({ id: 'code-1' });
    prisma.referralRedemption.upsert.mockResolvedValue({ id: 'red-1' });
    // 模拟"上一次 inviter 已成功 invitee 失败"的重试场景:
    // findUnique 返回 inviterGranted=true, inviteeGranted=false
    prisma.referralRedemption.findUnique.mockResolvedValue({
      id: 'red-1',
      inviterGranted: true,
      inviteeGranted: false,
    });
    prisma.creditGrantRule.findUnique
      .mockResolvedValueOnce({ id: 'r-inviter' })
      .mockResolvedValueOnce({ id: 'r-invitee' });
    prisma.referralRedemption.update.mockResolvedValue({});

    await service.attribute({
      inviteeUserId: 'u-new',
      referralCode: 'CODE1234',
    });

    // 只重试 invitee 一边
    expect(executor.grantToUserDirect).toHaveBeenCalledTimes(1);
    const args = executor.grantToUserDirect.mock.calls[0];
    expect(args[1]).toBe('u-new'); // invitee
    // 标记 inviteeGranted=true
    const updateCalls = prisma.referralRedemption.update.mock.calls.map(
      (c: any[]) => c[0],
    );
    expect(updateCalls).toEqual(
      expect.arrayContaining([
        { where: { id: 'red-1' }, data: { inviteeGranted: true } },
      ]),
    );
  });
});

// ============================================================
// onOrderCompleted
// ============================================================
describe('ReferralsService.onOrderCompleted', () => {
  it('triggers RECHARGE redemption when condition matches', async () => {
    const { service, prisma, executor } = await buildService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'o1',
      userId: 'u-new',
      orderType: 'RECHARGE',
      status: 'COMPLETED',
    });
    prisma.referralRedemption.findMany.mockResolvedValue([
      {
        id: 'red-1',
        inviterUserId: 'u-inviter',
        inviteeUserId: 'u-new',
        program: {
          id: 'p1',
          isActive: true,
          deletedAt: null,
          rewardCondition: 'FIRST_RECHARGE',
          inviterGrantRuleId: 'r-inviter',
          inviteeGrantRuleId: 'r-invitee',
        },
      },
    ]);
    prisma.referralRedemption.update.mockResolvedValue({});
    prisma.creditGrantRule.findUnique
      .mockResolvedValueOnce({ id: 'r-inviter' })
      .mockResolvedValueOnce({ id: 'r-invitee' });

    await service.onOrderCompleted({ orderId: 'o1' });

    expect(executor.grantToUserDirect).toHaveBeenCalledTimes(2);
  });

  it('triggers SUBSCRIPTION redemption when condition matches', async () => {
    const { service, prisma, executor } = await buildService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'o2',
      userId: 'u-new',
      orderType: 'SUBSCRIPTION',
      status: 'COMPLETED',
    });
    prisma.referralRedemption.findMany.mockResolvedValue([
      {
        id: 'red-2',
        inviterUserId: 'u-inviter',
        inviteeUserId: 'u-new',
        program: {
          id: 'p2',
          isActive: true,
          deletedAt: null,
          rewardCondition: 'FIRST_SUBSCRIBE',
          inviterGrantRuleId: 'r-inviter',
          inviteeGrantRuleId: 'r-invitee',
        },
      },
    ]);
    prisma.referralRedemption.update.mockResolvedValue({});
    prisma.creditGrantRule.findUnique
      .mockResolvedValueOnce({ id: 'r-inviter' })
      .mockResolvedValueOnce({ id: 'r-invitee' });

    await service.onOrderCompleted({ orderId: 'o2' });

    expect(executor.grantToUserDirect).toHaveBeenCalledTimes(2);
  });

  it('skips when condition does not match (RECHARGE vs FIRST_SUBSCRIBE)', async () => {
    const { service, prisma, executor } = await buildService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'o1',
      userId: 'u-new',
      orderType: 'RECHARGE',
      status: 'COMPLETED',
    });
    prisma.referralRedemption.findMany.mockResolvedValue([
      {
        id: 'red-x',
        inviterUserId: 'u-inviter',
        inviteeUserId: 'u-new',
        program: {
          id: 'p3',
          isActive: true,
          deletedAt: null,
          rewardCondition: 'FIRST_SUBSCRIBE',
          inviterGrantRuleId: 'r1',
          inviteeGrantRuleId: 'r2',
        },
      },
    ]);

    await service.onOrderCompleted({ orderId: 'o1' });
    expect(executor.grantToUserDirect).not.toHaveBeenCalled();
  });

  it('swallows internal errors silently (red-line)', async () => {
    const { service, prisma } = await buildService();
    prisma.order.findUnique.mockRejectedValue(new Error('boom'));
    await expect(
      service.onOrderCompleted({ orderId: 'o1' }),
    ).resolves.toBeUndefined();
  });

  it('skips when order is not COMPLETED', async () => {
    const { service, prisma, executor } = await buildService();
    prisma.order.findUnique.mockResolvedValue({
      id: 'o1',
      userId: 'u-new',
      orderType: 'RECHARGE',
      status: 'PAID',
    });
    await service.onOrderCompleted({ orderId: 'o1' });
    expect(prisma.referralRedemption.findMany).not.toHaveBeenCalled();
    expect(executor.grantToUserDirect).not.toHaveBeenCalled();
  });
});

// ============================================================
// listRedemptions
// ============================================================
describe('ReferralsService.listRedemptions', () => {
  it.each([
    { triggered: true, triggeredAt: { not: null } },
    { triggered: false, triggeredAt: null },
  ])(
    'filters paginated records when triggered=$triggered',
    async ({ triggered, triggeredAt }) => {
      const { service, prisma } = await buildService();
      prisma.referralRedemption.findMany.mockResolvedValue([]);
      prisma.referralRedemption.count.mockResolvedValue(0);

      await service.listRedemptions({
        programId: 'p1',
        triggered,
        page: 2,
        pageSize: 20,
      });

      const where = { programId: 'p1', triggeredAt };
      expect(prisma.referralRedemption.findMany).toHaveBeenCalledWith(
        expect.objectContaining({
          where,
          orderBy: triggered
            ? { triggeredAt: 'desc' }
            : { createdAt: 'desc' },
          skip: 20,
          take: 20,
        }),
      );
      expect(prisma.referralRedemption.count).toHaveBeenCalledWith({ where });
    },
  );
});

// ============================================================
// leaderboard
// ============================================================
describe('ReferralsService.leaderboard', () => {
  it('aggregates inviteCount and rewardTotal correctly', async () => {
    const { service, prisma } = await buildService();
    prisma.referralRedemption.groupBy.mockResolvedValue([
      { inviterUserId: 'u-A', programId: 'p1', _count: { _all: 3 } },
      { inviterUserId: 'u-B', programId: 'p1', _count: { _all: 1 } },
    ]);
    prisma.referralProgram.findMany.mockResolvedValue([
      { id: 'p1', inviterReward: 100 },
    ]);
    prisma.user.findMany.mockResolvedValue([
      { id: 'u-A', email: 'a@x' },
      { id: 'u-B', email: 'b@x' },
    ]);

    const out = await service.leaderboard({});
    expect(out.items).toHaveLength(2);
    expect(out.items[0].userId).toBe('u-A'); // 排第一
    expect(out.items[0].inviteCount).toBe(3);
    expect(out.items[0].rewardTotal).toBe(300);
    expect(out.items[1].userId).toBe('u-B');
    expect(out.items[1].rewardTotal).toBe(100);
  });

  it('returns empty when no data', async () => {
    const { service, prisma } = await buildService();
    prisma.referralRedemption.groupBy.mockResolvedValue([]);
    const out = await service.leaderboard({});
    expect(out.items).toEqual([]);
  });
});

// ============================================================
// summary
// ============================================================
describe('ReferralsService.summary', () => {
  it('aggregates totals / conversion / reward + perProgram (granted-only)', async () => {
    const { service, prisma } = await buildService();
    prisma.referralRedemption.count.mockResolvedValue(10); // 兑换总行数
    prisma.referralRedemption.groupBy.mockImplementation(({ by }: any) => {
      const key = Array.isArray(by) ? by[0] : by;
      if (key === 'programId') {
        return Promise.resolve([
          { programId: 'p1', _count: { _all: 6 } },
          { programId: 'p2', _count: { _all: 2 } },
        ]);
      }
      if (key === 'inviterUserId') {
        return Promise.resolve([
          { inviterUserId: 'u-A' },
          { inviterUserId: 'u-B' },
          { inviterUserId: 'u-C' },
        ]);
      }
      if (key === 'inviteeUserId') {
        return Promise.resolve([
          { inviteeUserId: 'i1' },
          { inviteeUserId: 'i2' },
          { inviteeUserId: 'i3' },
          { inviteeUserId: 'i4' },
          { inviteeUserId: 'i5' },
        ]);
      }
      return Promise.resolve([]);
    });
    prisma.referralProgram.findMany.mockResolvedValue([
      { id: 'p1', inviterReward: 100, inviteeReward: 50 },
      { id: 'p2', inviterReward: 10, inviteeReward: 5 },
    ]);

    const out = await service.summary({});
    expect(out.totalInviters).toBe(3);
    expect(out.totalInvitees).toBe(5);
    expect(out.totalRedemptions).toBe(8); // 6 + 2
    expect(out.totalAttempts).toBe(10);
    expect(out.conversionRate).toBeCloseTo(0.8);
    // (100+50)*6 + (10+5)*2 = 900 + 30
    expect(out.totalRewardIssued).toBe(930);
    expect(out.perProgram.p1.redemptionCount).toBe(6);
    expect(out.perProgram.p2.redemptionCount).toBe(2);
  });

  it('returns zeros when no data (no divide-by-zero)', async () => {
    const { service, prisma } = await buildService();
    prisma.referralRedemption.count.mockResolvedValue(0);
    prisma.referralRedemption.groupBy.mockResolvedValue([]);

    const out = await service.summary({});
    expect(out.totalInviters).toBe(0);
    expect(out.totalInvitees).toBe(0);
    expect(out.totalRedemptions).toBe(0);
    expect(out.totalAttempts).toBe(0);
    expect(out.conversionRate).toBe(0);
    expect(out.totalRewardIssued).toBe(0);
    expect(out.perProgram).toEqual({});
  });
});

// ============================================================
// cache (lookupReferralCodeCached)
// ============================================================
describe('ReferralsService cache behavior', () => {
  it('hits Redis cache when valid JSON present', async () => {
    const { service, prisma, redis } = await buildService();
    redis.get.mockResolvedValue(
      JSON.stringify({
        programId: 'p1',
        inviterUserId: 'u-inviter',
        programIsActive: true,
        programStartAt: null,
        programEndAt: null,
        programDeletedAt: null,
      }),
    );
    prisma.referralProgram.findFirst.mockResolvedValue({
      id: 'p1',
      isActive: true,
      sameIpLimit: null,
      sameDeviceLimit: null,
      perUserInviteLimit: null,
      rewardCondition: 'REGISTER',
      inviterGrantRuleId: 'r1',
      inviteeGrantRuleId: 'r2',
      deletedAt: null,
    });
    prisma.referralCode.findUnique.mockResolvedValue({ id: 'code-1' });
    prisma.referralRedemption.upsert.mockResolvedValue({ id: 'red-1' });
    prisma.creditGrantRule.findUnique.mockResolvedValue({});

    await service.attribute({
      inviteeUserId: 'u-new',
      referralCode: 'CODE1234',
    });

    // cache hit → 不查 referralCode.findFirst
    expect(prisma.referralCode.findFirst).not.toHaveBeenCalled();
  });

  it('falls through to DB when cache is corrupt', async () => {
    const { service, prisma, redis } = await buildService();
    redis.get.mockResolvedValue('not-valid-json{{');
    prisma.referralCode.findFirst.mockResolvedValue(null); // → silent miss
    await service.attribute({
      inviteeUserId: 'u-new',
      referralCode: 'CODE1234',
    });
    expect(prisma.referralCode.findFirst).toHaveBeenCalled();
  });

  it('falls through when Redis throws', async () => {
    const { service, prisma, redis } = await buildService();
    redis.get.mockRejectedValue(new Error('redis down'));
    prisma.referralCode.findFirst.mockResolvedValue(null);
    await service.attribute({
      inviteeUserId: 'u-new',
      referralCode: 'CODE1234',
    });
    expect(prisma.referralCode.findFirst).toHaveBeenCalled();
  });
});
