import { Prisma } from '@prisma/client';
import { BillingUserMirrorService } from './billing-user-mirror.service';
import { BillingWorkspaceMirrorService } from './billing-workspace-mirror.service';

function makePrisma(overrides: Record<string, unknown> = {}) {
  const prisma: any = {
    user: {
      findFirst: jest.fn().mockResolvedValue(null),
      findUnique: jest.fn().mockResolvedValue({
        email: 'burger@example.com',
        nickname: 'Burger',
        isActive: true,
        createdAt: new Date('2026-06-01T00:00:00.000Z'),
      }),
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    tenant: {
      findUnique: jest.fn().mockResolvedValue(null),
      upsert: jest.fn().mockResolvedValue({ id: 'tenant-1', billingAccountId: null }),
      update: jest.fn().mockResolvedValue({}),
    },
    tenantMember: {
      upsert: jest.fn().mockResolvedValue({}),
    },
    billingAccount: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    billingAccountMember: {
      findUnique: jest.fn().mockResolvedValue({ id: 'bam-owner', role: 'owner' }),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      upsert: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    accountWallet: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
      upsert: jest.fn().mockResolvedValue({}),
    },
    $queryRaw: jest.fn().mockResolvedValue([]),
    $transaction: jest.fn((fn: (tx: unknown) => Promise<unknown>) => fn(prisma)),
  };
  Object.assign(prisma, overrides);
  return prisma;
}

describe('BillingWorkspaceMirrorService', () => {
  it('uses the deployment currency when creating the atomic account aggregate', async () => {
    const prisma = makePrisma();
    const userMirror = new BillingUserMirrorService(prisma as any);
    const systemConfig = {
      getDeploymentConfig: jest.fn().mockResolvedValue({ region: 'domestic', currency: 'cny' }),
    };
    const service = new BillingWorkspaceMirrorService(
      prisma as any,
      userMirror,
      systemConfig as any,
    );

    await service.mirror({
      user: { id: 'user-1', email: 'burger@example.com' },
      tenant: {
        id: 'tenant-1', name: 'Burger', type: 'personal', status: 'active', ownerUserId: 'user-1',
      },
      membership: { userId: 'user-1', role: 'owner', status: 'active' },
    });

    expect(prisma.billingAccount.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ currency: 'CNY' }),
    }));
  });

  it('materializes a billing account and wallet when a workspace is mirrored', async () => {
    const prisma = makePrisma();
    const userMirror = new BillingUserMirrorService(prisma as any);
    const service = new BillingWorkspaceMirrorService(prisma as any, userMirror);

    const result = await service.mirror({
      user: {
        id: 'user-1',
        email: 'burger@example.com',
        nickname: 'Burger',
        isActive: true,
      },
      tenant: {
        id: 'tenant-1',
        name: 'Burger',
        slug: 'personal-user-1',
        type: 'personal',
        status: 'active',
        ownerUserId: 'user-1',
      },
      membership: {
        userId: 'user-1',
        role: 'owner',
        status: 'active',
      },
    });

    expect(result).toMatchObject({
      tenantId: 'tenant-1',
      billingAccountId: 'ba_personal_user-1',
    });
    const userMirrorCreate = prisma.user.upsert.mock.calls[0][0].create;
    expect(userMirrorCreate).not.toHaveProperty('password');
    expect(userMirrorCreate).not.toHaveProperty('role');
    expect(userMirrorCreate.mirroredAt).toBeInstanceOf(Date);
    expect(prisma.billingAccount.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        id: 'ba_personal_user-1',
        ownerUserId: 'user-1',
        status: 'active',
        balanceGrantLedgerStatus: 'RECONCILED_V2',
        balanceGrantLedgerVersion: 2,
        balanceGrantLedgerHash: 'EMPTY_V2',
        balanceGrantLedgerReconciledAt: expect.any(Date),
      }),
    }));
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: 'tenant-1' },
      data: { billingAccountId: 'ba_personal_user-1' },
    });
    expect(prisma.accountWallet.create).toHaveBeenCalledWith({
      data: {
        billingAccountId: 'ba_personal_user-1',
        balanceUsd: new Prisma.Decimal(0),
      },
    });
  });

  it('binds new personal/team tenants to the owner personal account even when an enterprise account exists', async () => {
    const prisma = makePrisma();
    const userMirror = new BillingUserMirrorService(prisma as any);
    const service = new BillingWorkspaceMirrorService(prisma as any, userMirror);

    const result = await service.mirror({
      user: { id: 'user-1', email: 'burger@example.com' },
      tenant: {
        id: 'tenant-new', name: 'new team', type: 'team', status: 'active', ownerUserId: 'user-1',
      },
      membership: { userId: 'user-1', role: 'owner', status: 'active' },
    });

    expect(result.billingAccountId).toBe('ba_personal_user-1');
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: 'tenant-new' },
      data: { billingAccountId: 'ba_personal_user-1' },
    });
    expect(prisma.billingAccount.findFirst).not.toHaveBeenCalled();
    expect(prisma.billingAccount.create).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ id: 'ba_personal_user-1' }),
    }));
  });

  it('locks an existing aggregate in advisory -> wallet -> account -> tenant -> member order', async () => {
    const prisma = makePrisma();
    prisma.billingAccount.findUnique.mockResolvedValue({
      id: 'ba_personal_user-1',
      type: 'personal',
      ownerUserId: 'user-1',
      currency: 'USD',
      deletedAt: null,
    });
    prisma.$queryRaw.mockImplementation(async (query: TemplateStringsArray) => {
      const sql = String(query);
      if (sql.includes('FROM "account_wallets"')) {
        return [{ billing_account_id: 'ba_personal_user-1' }];
      }
      return [];
    });
    const userMirror = new BillingUserMirrorService(prisma as any);
    const service = new BillingWorkspaceMirrorService(prisma as any, userMirror);

    await service.mirror({
      user: { id: 'user-1', email: 'burger@example.com' },
      tenant: {
        id: 'tenant-new', name: 'new team', type: 'team', status: 'active', ownerUserId: 'user-1',
      },
      membership: { userId: 'user-1', role: 'owner', status: 'active' },
    });

    const rawCalls = prisma.$queryRaw.mock.calls.map(
      ([query]: [TemplateStringsArray], index: number) => ({
        sql: String(query),
        order: prisma.$queryRaw.mock.invocationCallOrder[index],
      }),
    );
    const advisory = rawCalls.find(({ sql }: { sql: string }) => sql.includes('pg_advisory_xact_lock'))!;
    const wallet = rawCalls.find(({ sql }: { sql: string }) => sql.includes('FROM "account_wallets"'))!;
    const account = rawCalls.find(({ sql }: { sql: string }) => sql.includes('FROM "billing_accounts"'))!;
    expect(advisory.order).toBeLessThan(wallet.order);
    expect(wallet.order).toBeLessThan(account.order);
    expect(account.order).toBeLessThan(prisma.tenant.upsert.mock.invocationCallOrder[0]);
    expect(prisma.tenant.upsert.mock.invocationCallOrder[0]).toBeLessThan(
      prisma.billingAccountMember.update.mock.invocationCallOrder[0],
    );
    expect(prisma.accountWallet.create).not.toHaveBeenCalled();
    expect(prisma.billingAccountMember.create).not.toHaveBeenCalled();
    expect(prisma.billingAccount.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.not.objectContaining({ currency: expect.anything() }),
    }));
  });

  it('requires a drained migration instead of rewriting an existing account currency', async () => {
    const prisma = makePrisma();
    prisma.billingAccount.findUnique.mockResolvedValue({
      id: 'ba_personal_user-1',
      type: 'personal',
      ownerUserId: 'user-1',
      currency: 'CNY',
      deletedAt: null,
    });
    const userMirror = new BillingUserMirrorService(prisma as any);
    const service = new BillingWorkspaceMirrorService(prisma as any, userMirror);

    await expect(service.mirror({
      user: { id: 'user-1', email: 'burger@example.com' },
      tenant: {
        id: 'tenant-new', name: 'new team', type: 'team', status: 'active', ownerUserId: 'user-1',
      },
      membership: { userId: 'user-1', role: 'owner', status: 'active' },
    })).rejects.toMatchObject({
      status: 409,
      response: {
        code: 'billing_account_currency_migration_required',
      },
    });

    expect(prisma.billingAccount.update).not.toHaveBeenCalled();
    expect(prisma.tenant.upsert).not.toHaveBeenCalled();
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('fails closed instead of repairing an existing account whose wallet is missing', async () => {
    const prisma = makePrisma();
    prisma.billingAccount.findUnique.mockResolvedValue({
      id: 'ba_personal_user-1',
      type: 'personal',
      ownerUserId: 'user-1',
      currency: 'USD',
      deletedAt: null,
    });
    const userMirror = new BillingUserMirrorService(prisma as any);
    const service = new BillingWorkspaceMirrorService(prisma as any, userMirror);

    let caught: unknown;
    try {
      await service.mirror({
        user: { id: 'user-1', email: 'burger@example.com' },
        tenant: {
          id: 'tenant-new', name: 'new team', type: 'team', status: 'active', ownerUserId: 'user-1',
        },
        membership: { userId: 'user-1', role: 'owner', status: 'active' },
      });
    } catch (error) {
      caught = error;
    }

    expect(caught).toMatchObject({
      status: 409,
      response: { code: 'billing_account_not_provisioned' },
    });
    expect(prisma.tenant.upsert).not.toHaveBeenCalled();
    expect(prisma.accountWallet.create).not.toHaveBeenCalled();
    expect(prisma.accountWallet.upsert).not.toHaveBeenCalled();
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('keeps an existing billing account binding and does not recreate an existing wallet', async () => {
    const prisma = makePrisma({
      tenant: {
        findUnique: jest.fn().mockResolvedValue({ billingAccountId: 'ba_existing' }),
        upsert: jest.fn().mockResolvedValue({ id: 'tenant-1', billingAccountId: 'ba_existing' }),
        update: jest.fn().mockResolvedValue({}),
      },
      accountWallet: {
        findUnique: jest.fn().mockResolvedValue({ billingAccountId: 'ba_existing' }),
        upsert: jest.fn().mockResolvedValue({}),
      },
    });
    const userMirror = new BillingUserMirrorService(prisma as any);
    const service = new BillingWorkspaceMirrorService(prisma as any, userMirror);

    const result = await service.mirror({
      user: { id: 'user-1', email: 'burger@example.com' },
      tenant: {
        id: 'tenant-1', name: 'Burger', type: 'personal', status: 'active', ownerUserId: 'user-1',
      },
      membership: { userId: 'user-1', role: 'owner', status: 'active' },
    });

    expect(result).toMatchObject({ billingAccountId: 'ba_existing' });
    expect(prisma.tenant.update).not.toHaveBeenCalled();
    expect(prisma.accountWallet.upsert).not.toHaveBeenCalled();
  });

  it('clears billing current tenant when a workspace membership becomes inactive', async () => {
    const prisma = makePrisma();
    const userMirror = new BillingUserMirrorService(prisma as any);
    const service = new BillingWorkspaceMirrorService(prisma as any, userMirror);

    await service.mirror({
      user: { id: 'user-1', email: 'burger@example.com' },
      tenant: {
        id: 'tenant-1', name: 'Burger', type: 'team', status: 'active', ownerUserId: 'owner-1',
      },
      membership: { userId: 'user-1', role: 'member', status: 'inactive' },
    });

    expect(prisma.user.updateMany).toHaveBeenCalledWith({
      where: { id: 'user-1', currentTenantId: 'tenant-1' },
      data: { currentTenantId: null },
    });
  });

  it('rejects a membership snapshot for a different user', async () => {
    const prisma = makePrisma();
    const userMirror = new BillingUserMirrorService(prisma as any);
    const service = new BillingWorkspaceMirrorService(prisma as any, userMirror);

    await expect(service.mirror({
      user: { id: 'user-1', email: 'burger@example.com' },
      tenant: {
        id: 'tenant-1', name: 'Burger', type: 'team', status: 'active', ownerUserId: 'user-1',
      },
      membership: { userId: 'user-2', role: 'owner', status: 'active' },
    })).rejects.toThrow('membership.userId 与 user.id 不一致');

    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it.each(['admin', 'billing_admin'])('rejects legacy %s membership roles', async (role) => {
    const prisma = makePrisma();
    const userMirror = new BillingUserMirrorService(prisma as any);
    const service = new BillingWorkspaceMirrorService(prisma as any, userMirror);

    await expect(service.mirror({
      user: { id: 'user-1', email: 'burger@example.com' },
      tenant: {
        id: 'tenant-1', name: 'Burger', type: 'personal', status: 'active', ownerUserId: 'user-1',
      },
      membership: { userId: 'user-1', role, status: 'active' },
    })).rejects.toThrow('membership.role 仅支持 owner 或 member');

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.tenantMember.upsert).not.toHaveBeenCalled();
  });

  it('拒绝在 owner transfer 提交后到达的旧 enterprise owner 镜像', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw.mockImplementation(async (query: TemplateStringsArray) => (
      String(query).includes('FROM "tenants"') ? [{ id: 'tenant-enterprise' }] : []
    ));
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'tenant-enterprise',
      type: 'enterprise',
      billingAccountId: 'ba-enterprise',
      ownerUserId: 'new-owner',
    });
    const userMirror = new BillingUserMirrorService(prisma as any);
    const service = new BillingWorkspaceMirrorService(prisma as any, userMirror);

    await expect(service.mirror({
      user: { id: 'old-owner', email: 'old@example.com', isActive: true },
      tenant: {
        id: 'tenant-enterprise',
        name: 'Enterprise',
        type: 'enterprise',
        status: 'active',
        ownerUserId: 'old-owner',
      },
      membership: { userId: 'old-owner', role: 'owner', status: 'active' },
    })).rejects.toMatchObject({
      status: 409,
      response: {
        code: 'enterprise_tenant_projection_conflict',
        message: '企业工作区归属已变更，已停止陈旧镜像覆盖',
      },
    });

    const tenantLockCall = prisma.$queryRaw.mock.calls.findIndex(
      ([query]: [TemplateStringsArray]) => String(query).includes('FROM "tenants"'),
    );
    expect(tenantLockCall).toBeGreaterThanOrEqual(0);
    expect(String(prisma.$queryRaw.mock.calls[tenantLockCall][0])).toContain('FOR UPDATE');
    expect(prisma.user.upsert.mock.invocationCallOrder.at(-1))
      .toBeLessThan(prisma.$queryRaw.mock.invocationCallOrder[tenantLockCall]);
    expect(prisma.tenant.upsert).not.toHaveBeenCalled();
    expect(prisma.tenantMember.upsert).not.toHaveBeenCalled();
  });

  it('允许已绑定 enterprise tenant 的当前 owner 镜像保持原归属', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw.mockImplementation(async (query: TemplateStringsArray) => (
      String(query).includes('FROM "tenants"') ? [{ id: 'tenant-enterprise' }] : []
    ));
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'tenant-enterprise',
      type: 'enterprise',
      billingAccountId: 'ba-enterprise',
      ownerUserId: 'new-owner',
    });
    prisma.tenant.upsert.mockResolvedValue({
      id: 'tenant-enterprise',
      billingAccountId: 'ba-enterprise',
    });
    const userMirror = new BillingUserMirrorService(prisma as any);
    const service = new BillingWorkspaceMirrorService(prisma as any, userMirror);

    await expect(service.mirror({
      user: { id: 'new-owner', email: 'new@example.com', isActive: true },
      tenant: {
        id: 'tenant-enterprise',
        name: 'Enterprise',
        type: 'enterprise',
        status: 'active',
        ownerUserId: 'new-owner',
      },
      membership: { userId: 'new-owner', role: 'owner', status: 'active' },
    })).resolves.toMatchObject({
      tenantId: 'tenant-enterprise',
      billingAccountId: 'ba-enterprise',
      role: 'owner',
    });

    expect(prisma.tenant.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ ownerUserId: 'new-owner' }),
    }));
    expect(prisma.tenantMember.upsert).toHaveBeenCalledWith(expect.objectContaining({
      update: { role: 'owner', status: 'active' },
    }));
  });

  it('已绑定 enterprise tenant 的普通成员镜像只能写 member role', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw.mockImplementation(async (query: TemplateStringsArray) => (
      String(query).includes('FROM "tenants"') ? [{ id: 'tenant-enterprise' }] : []
    ));
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'tenant-enterprise',
      type: 'enterprise',
      billingAccountId: 'ba-enterprise',
      ownerUserId: 'new-owner',
    });
    prisma.tenant.upsert.mockResolvedValue({
      id: 'tenant-enterprise',
      billingAccountId: 'ba-enterprise',
    });
    const userMirror = new BillingUserMirrorService(prisma as any);
    const service = new BillingWorkspaceMirrorService(prisma as any, userMirror);

    await service.mirror({
      user: { id: 'old-owner', email: 'old@example.com', isActive: true },
      tenant: {
        id: 'tenant-enterprise',
        name: 'Enterprise',
        type: 'enterprise',
        status: 'active',
        ownerUserId: 'new-owner',
      },
      membership: { userId: 'old-owner', role: 'member', status: 'active' },
    });

    expect(prisma.tenantMember.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({ userId: 'old-owner', role: 'member' }),
      update: { role: 'member', status: 'active' },
    }));
  });

  it('不阻断未 attach 的 enterprise tenant 初始镜像', async () => {
    const prisma = makePrisma();
    prisma.$queryRaw.mockImplementation(async (query: TemplateStringsArray) => (
      String(query).includes('FROM "tenants"') ? [{ id: 'tenant-enterprise' }] : []
    ));
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'tenant-enterprise',
      type: 'enterprise',
      billingAccountId: null,
      ownerUserId: 'owner-1',
    });
    const userMirror = new BillingUserMirrorService(prisma as any);
    const service = new BillingWorkspaceMirrorService(prisma as any, userMirror);

    await expect(service.mirror({
      user: { id: 'owner-1', email: 'owner@example.com', isActive: true },
      tenant: {
        id: 'tenant-enterprise',
        name: 'Enterprise',
        type: 'enterprise',
        status: 'active',
        ownerUserId: 'owner-1',
      },
      membership: { userId: 'owner-1', role: 'owner', status: 'active' },
    })).resolves.toMatchObject({
      tenantId: 'tenant-enterprise',
      billingAccountId: null,
    });

    expect(prisma.tenant.upsert).toHaveBeenCalled();
    expect(prisma.tenantMember.upsert).toHaveBeenCalled();
    expect(prisma.billingAccount.create).not.toHaveBeenCalled();
    expect(prisma.accountWallet.create).not.toHaveBeenCalled();
  });

  it('rejects an enterprise snapshot without an explicit owner before creating any account', async () => {
    const prisma = makePrisma();
    const userMirror = new BillingUserMirrorService(prisma as any);
    const service = new BillingWorkspaceMirrorService(prisma as any, userMirror);

    await expect(service.mirror({
      user: { id: 'user-1', email: 'burger@example.com' },
      tenant: {
        id: 'tenant-enterprise', name: 'Enterprise', type: 'enterprise', status: 'active',
      },
      membership: { userId: 'user-1', role: 'owner', status: 'active' },
    })).rejects.toThrow('tenant.ownerUserId 是必填字段');

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.billingAccount.upsert).not.toHaveBeenCalled();
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('rejects an unknown tenant status instead of reviving the mirrored tenant', async () => {
    const prisma = makePrisma();
    const userMirror = new BillingUserMirrorService(prisma as any);
    const service = new BillingWorkspaceMirrorService(prisma as any, userMirror);

    await expect(service.mirror({
      user: { id: 'user-1', email: 'burger@example.com' },
      tenant: {
        id: 'tenant-1', name: 'Burger', type: 'personal', status: 'unknown', ownerUserId: 'user-1',
      },
      membership: { userId: 'user-1', role: 'owner', status: 'active' },
    })).rejects.toThrow('tenant.status 仅支持 active、suspended 或 deleted');

    expect(prisma.$transaction).not.toHaveBeenCalled();
    expect(prisma.tenant.upsert).not.toHaveBeenCalled();
  });

  it.each([
    ['owner', 'member-1', 'owner-1'],
    ['member', 'owner-1', 'owner-1'],
  ])(
    'rejects noncanonical role=%s for user=%s and owner=%s',
    async (role, userId, ownerUserId) => {
      const prisma = makePrisma();
      const userMirror = new BillingUserMirrorService(prisma as any);
      const service = new BillingWorkspaceMirrorService(prisma as any, userMirror);

      await expect(service.mirror({
        user: { id: userId, email: 'burger@example.com' },
        tenant: {
          id: 'tenant-1', name: 'Burger', type: 'team', status: 'active', ownerUserId,
        },
        membership: { userId, role, status: 'active' },
      })).rejects.toThrow('membership.role 与 tenant.ownerUserId 不一致');

      expect(prisma.$transaction).not.toHaveBeenCalled();
      expect(prisma.tenantMember.upsert).not.toHaveBeenCalled();
    },
  );
});
