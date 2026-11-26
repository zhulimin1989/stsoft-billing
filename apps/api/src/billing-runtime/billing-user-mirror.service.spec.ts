import { BillingUserMirrorService } from './billing-user-mirror.service';

function makePrisma(overrides: Record<string, unknown> = {}) {
  const prisma: any = {
    user: {
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    billingAccount: {
      findMany: jest.fn().mockResolvedValue([{ id: 'ba_personal_user-1' }]),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    billingAccountMember: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
  };
  Object.assign(prisma, overrides);
  return prisma;
}

/** 省掉每条用例里重复的 new。 */
function service0(prisma: unknown) {
  return new BillingUserMirrorService(prisma as never);
}

describe('BillingUserMirrorService', () => {
  it('用户被停用时也不得 suspend 企业账户（镜像两个方向都只碰个人账户）', async () => {
    // ⚠️ 上一版让收缩方向连坐企业账户，实测是负收益：`account.status` 不拦消费、只拦打款，
    // 且解封不恢复（单向陷门）。这条断言把「两个方向都只碰 personal」钉死。
    const prisma = makePrisma();
    prisma.billingAccount.findMany = jest.fn(async (args: any) => {
      const types: string[] = args?.where?.type?.in ?? [];
      return types.includes('enterprise') ? [{ id: 'ba_enterprise_user-1' }] : [];
    });

    await service0(prisma).mirrorUser({
      id: 'user-1',
      email: 'alice@example.com',
      nickname: 'Alice',
      isActive: false,
      sourceUpdatedAt: '2026-07-03T10:00:00.000Z',
    });

    expect(prisma.billingAccount.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ type: { in: ['personal'] } }),
    }));
    expect(prisma.billingAccount.updateMany).not.toHaveBeenCalled();
  });

  it('已回收的企业账户不得被用户镜像推回 active（回收结果必须可信）', async () => {
    // ⚠️ 不加 type 过滤的后果：企业开通被作废回收后账户是 suspended、owner 成员是 inactive，
    // 而 owner 之后**任何一次**带 isActive 的镜像（改个昵称就够）都会把它们推回 active/active
    // ⇒ 批一自己的验收断言被悄悄推翻，且 /reconcile 的 anyAccountActive 永久为 true、
    // /hazards 永久成单。
    const prisma = makePrisma();
    // 库里只有一个**企业**账户（已回收：suspended + quarantined）。
    // 放开方向的枚举只会带 type: { in: ['personal'] } ⇒ 企业账户查不到。
    prisma.billingAccount.findMany = jest.fn(async (args: any) => {
      const types: string[] = args?.where?.type?.in ?? [];
      return types.includes('enterprise') ? [{ id: 'ba_enterprise_user-1' }] : [];
    });

    await service0(prisma).mirrorUser({
      id: 'user-1',
      email: 'alice@example.com',
      nickname: 'Alice',
      isActive: true,
      sourceUpdatedAt: '2026-07-03T10:00:00.000Z',
    });

    // 枚举必须带 type=personal ⇒ 企业账户压根不在候选里 ⇒ 一个字都不写。
    expect(prisma.billingAccount.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ type: { in: ['personal'] } }),
    }));
    expect(prisma.billingAccount.updateMany).not.toHaveBeenCalled();
    expect(prisma.billingAccountMember.updateMany).not.toHaveBeenCalled();
  });

  it('mirrors inactive users and suspends owned billing accounts', async () => {
    const prisma = makePrisma();
    const service = new BillingUserMirrorService(prisma as any);

    await expect(service.mirrorUser({
      id: 'user-1',
      email: 'alice@example.com',
      nickname: 'Alice',
      isActive: false,
      sourceUpdatedAt: '2026-07-03T10:00:00.000Z',
    })).resolves.toEqual({
      id: 'user-1',
      skippedStale: false,
      sourceUpdatedAt: new Date('2026-07-03T10:00:00.000Z'),
    });

    expect(prisma.user.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'user-1' },
      create: expect.objectContaining({
        email: 'alice@example.com',
        isActive: false,
        sourceUpdatedAt: new Date('2026-07-03T10:00:00.000Z'),
      }),
      update: expect.objectContaining({
        email: 'alice@example.com',
        isActive: false,
        sourceUpdatedAt: new Date('2026-07-03T10:00:00.000Z'),
      }),
    }));
    // ⚠️ 两个方向都只碰个人账户（终审 P1 回退了「非对称」）：
    // 企业账户的状态归开通/回收编排独占，镜像不得插手 —— 详见 service 里的说明。
    expect(prisma.billingAccount.updateMany).toHaveBeenCalledWith({
      where: {
        id: { in: ['ba_personal_user-1'] },
        deletedAt: null,
        type: { in: ['personal'] },
        status: { not: 'suspended' },
      },
      data: { status: 'suspended' },
    });
    expect(prisma.billingAccountMember.updateMany).toHaveBeenCalledWith({
      where: {
        billingAccountId: { in: ['ba_personal_user-1'] },
        userId: 'user-1',
        role: 'owner',
        status: { not: 'inactive' },
      },
      data: { status: 'inactive' },
    });
  });

  it('does not let stale snapshots overwrite the billing user mirror', async () => {
    const prisma = makePrisma({
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-1',
          sourceUpdatedAt: new Date('2026-07-03T10:00:00.000Z'),
        }),
        findFirst: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
    });
    const service = new BillingUserMirrorService(prisma as any);

    await expect(service.mirrorUser({
      id: 'user-1',
      email: 'old@example.com',
      isActive: true,
      sourceUpdatedAt: '2026-07-03T09:59:59.000Z',
    })).resolves.toEqual({
      id: 'user-1',
      skippedStale: true,
      sourceUpdatedAt: new Date('2026-07-03T10:00:00.000Z'),
    });

    expect(prisma.user.upsert).not.toHaveBeenCalled();
    expect(prisma.billingAccount.updateMany).not.toHaveBeenCalled();
    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'user-1' },
      data: { mirroredAt: expect.any(Date) },
    });
  });

  it('rejects an invalid source timestamp instead of silently dropping ordering', async () => {
    const prisma = makePrisma();
    const service = new BillingUserMirrorService(prisma as any);

    await expect(service.mirrorUser({
      id: 'user-1',
      sourceUpdatedAt: 'not-a-date',
    })).rejects.toThrow('user.sourceUpdatedAt 必须是有效时间');

    expect(prisma.user.upsert).not.toHaveBeenCalled();
  });

  it('rejects a far-future source timestamp that could lock out later mirrors', async () => {
    const prisma = makePrisma();
    const service = new BillingUserMirrorService(prisma as any);

    await expect(service.mirrorUser({
      id: 'user-1',
      sourceUpdatedAt: new Date(Date.now() + 60 * 60 * 1000),
    })).rejects.toThrow('user.sourceUpdatedAt 不能超过当前时间 5 分钟');

    expect(prisma.user.upsert).not.toHaveBeenCalled();
  });
});
