import { BadRequestException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { EnterpriseAccountService } from './enterprise-account.service';

/**
 * EnterpriseAccountService 单测：信用额度配置的幂等、校验与生效窗口边界。
 * 资金路径（spend/allocate）在 billing.service.spec.ts 覆盖，这里只测配置面。
 */

const ACCOUNT_ID = 'ba_ent_1';

function makeAccountRow(overrides: Record<string, unknown> = {}) {
  return {
    id: ACCOUNT_ID,
    type: 'enterprise',
    name: '瑞东科技',
    ownerUserId: 'u1',
    status: 'active',
    currency: 'CNY',
    enterpriseName: '瑞东科技',
    uscc: '91310000MA1FL0000X',
    verificationId: 'ver-1',
    verifiedAt: new Date('2026-07-01T00:00:00.000Z'),
    wallet: { balanceUsd: new Prisma.Decimal(0) },
    creditConfig: null,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makeCreditConfig(overrides: Record<string, unknown> = {}) {
  return {
    billingAccountId: ACCOUNT_ID,
    limitUsd: new Prisma.Decimal(100),
    status: 'ACTIVE',
    policyRevision: 0,
    policyEffectiveBoundaryAt: null,
    policyBoundaryComplete: false,
    termsDays: 30,
    effectiveAt: null,
    expiresAt: null,
    updatedBy: 'admin-1',
    note: null,
    createdAt: new Date('2026-07-01T00:00:00.000Z'),
    updatedAt: new Date('2026-07-01T00:00:00.000Z'),
    ...overrides,
  };
}

function makePrisma() {
  const prisma: any = {
    user: {
      findUnique: jest.fn(async () => ({
        id: 'u2',
        isActive: true,
        sourceUpdatedAt: null,
      })),
      findFirst: jest.fn(async () => null),
      upsert: jest.fn(async ({ create, update }: any) => ({ ...create, ...update })),
      update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
    },
    billingAccount: {
      findFirst: jest.fn(async () => makeAccountRow()),
      findMany: jest.fn(async () => []),
      count: jest.fn(async () => 0),
      update: jest.fn(async ({ where, data }: any) => ({ ...makeAccountRow(), ...data, id: where.id })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    billingAccountCreditConfig: {
      findUnique: jest.fn(async () => null),
      create: jest.fn(),
      update: jest.fn(),
    },
    billingAccountCreditEvent: {
      findUnique: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    tenant: {
      findUnique: jest.fn(async () => null),
      findFirst: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
      update: jest.fn(async () => ({})),
    },
    tenantMember: {
      upsert: jest.fn(async ({ create, update }: any) => ({
        id: 'tm-1',
        ...create,
        ...update,
      })),
    },
    accountWallet: {
      findUnique: jest.fn(async () => ({ balanceUsd: new Prisma.Decimal(0) })),
    },
    billingAccountMember: {
      findMany: jest.fn(async () => []),
      upsert: jest.fn(async ({ create, update }: any) => ({
        id: 'bam-1',
        ...create,
        ...update,
      })),
    },
    enterpriseFundingSnapshot: {
      findUnique: jest.fn(async () => null),
      findMany: jest.fn(async () => []),
      upsert: jest.fn(async ({ create }: { create: Record<string, unknown> }) => create),
    },
  };
  let creditConfigRow: any = null;
  let creditEventRow: any = null;
  prisma.billingAccountCreditConfig.create.mockImplementation(async ({ data }: any) => {
    creditConfigRow = { ...(creditConfigRow ?? {}), ...data };
    prisma.billingAccountCreditConfig.findUnique.mockImplementation(async () => creditConfigRow);
    return creditConfigRow;
  });
  prisma.billingAccountCreditConfig.update.mockImplementation(async ({ data }: any) => {
    creditConfigRow = { ...(creditConfigRow ?? {}), ...data };
    prisma.billingAccountCreditConfig.findUnique.mockImplementation(async () => creditConfigRow);
    return creditConfigRow;
  });
  prisma.billingAccountCreditEvent.create.mockImplementation(async ({ data }: any) => {
    creditEventRow = { id: 'evt-1', createdAt: new Date(), ...data };
    prisma.billingAccountCreditEvent.findUnique.mockImplementation(async ({ where }: any) => {
      if (where?.id && where.id !== creditEventRow.id) return null;
      if (where?.idempotencyKey && where.idempotencyKey !== creditEventRow.idempotencyKey) return null;
      return creditEventRow;
    });
    return creditEventRow;
  });
  prisma.billingAccountCreditEvent.updateMany.mockImplementation(async ({ where, data }: any) => {
    if (!creditEventRow || (where?.id && where.id !== creditEventRow.id)) return { count: 0 };
    creditEventRow = { ...creditEventRow, ...data };
    return { count: 1 };
  });
  prisma.$queryRaw = jest.fn(async (parts: TemplateStringsArray | unknown) => {
    const sql = Array.isArray(parts) ? parts.join(' ') : String(parts);
    if (sql.includes('clock_timestamp()') && sql.includes('policyClock')) {
      return [{
        policyClock: new Date(sql.includes("INTERVAL '1 millisecond'")
          ? '2026-08-06T12:00:00.001Z'
          : '2026-08-06T12:00:00.000Z'),
      }];
    }
    if (sql.includes('FROM "account_wallets"')) {
      return [{ balanceUsd: new Prisma.Decimal(0) }];
    }
    if (sql.includes('funding-snapshot-upsert')) {
      return [];
    }
    if (sql.includes('FROM "billing_accounts"')) {
      return [{ id: ACCOUNT_ID }];
    }
    if (sql.includes('FROM "tenants"')) {
      return [{ id: 'tenant-1' }];
    }
    return [];
  });
  prisma.$transaction = jest.fn(async (arg: any) => {
    if (typeof arg === 'function') return arg(prisma);
    return Promise.all(arg);
  });
  return prisma;
}

function rawSqlText(parts: unknown, ...values: unknown[]): string {
  if (parts && typeof parts === 'object' && 'strings' in parts) {
    const sql = parts as { strings: readonly string[]; values?: unknown[] };
    const nested = Array.isArray(sql.values) ? sql.values : values;
    return rawSqlText(sql.strings, ...nested);
  }
  if (Array.isArray(parts)) {
    return parts.reduce((text, chunk, index) => {
      const value = values[index];
      if (value && typeof value === 'object' && ('strings' in value || Array.isArray(value))) {
        return `${text}${chunk}${rawSqlText(value)}`;
      }
      return `${text}${chunk}`;
    }, '');
  }
  return String(parts);
}

function rawLockSql(prisma: any): string[] {
  return prisma.$queryRaw.mock.calls.map((args: unknown[]) => rawSqlText(args[0], ...args.slice(1)));
}

function expectWalletAccountLockOrder(prisma: any): void {
  const sql = rawLockSql(prisma);
  expect(sql[0]).toContain('FROM "account_wallets"');
  expect(sql[0]).toContain('FOR UPDATE');
  expect(sql[1]).toContain('FROM "billing_accounts"');
  expect(sql[1]).toContain('FOR UPDATE');
}

function makePublisherSync() {
  return { syncBillingAccountKeyBalances: jest.fn(async () => undefined) };
}

function makeBilling() {
  return {
    syncTenantBalanceCacheForCurrentBinding: jest.fn(async () => undefined),
    releasePolicyRestoredGatewayBalanceDebtRestrictions: jest.fn(async () => 0),
  };
}

function buildService() {
  const prisma = makePrisma();
  const publisherSync = makePublisherSync();
  const billing = makeBilling();
  const service = new EnterpriseAccountService(prisma, publisherSync as any, billing as any);
  return { service, prisma, publisherSync, billing };
}

describe('EnterpriseAccountService.getEnterpriseCredit — 生效窗口边界', () => {
  it.each([
    ['无配置 → activeLimit=0', null, 0],
    ['DISABLED → activeLimit=0', makeCreditConfig({ status: 'DISABLED' }), 0],
    ['SUSPENDED → activeLimit=0', makeCreditConfig({ status: 'SUSPENDED' }), 0],
    ['ACTIVE 无窗口 → activeLimit=limit', makeCreditConfig(), 10000],
    [
      'effectiveAt 在未来 → activeLimit=0',
      makeCreditConfig({ effectiveAt: new Date(Date.now() + 86400_000) }),
      0,
    ],
    [
      'expiresAt 已过期 → activeLimit=0',
      makeCreditConfig({ expiresAt: new Date(Date.now() - 1000) }),
      0,
    ],
    [
      '窗口内 → activeLimit=limit',
      makeCreditConfig({
        effectiveAt: new Date(Date.now() - 86400_000),
        expiresAt: new Date(Date.now() + 86400_000),
      }),
      10000,
    ],
  ])('%s', async (_name, creditConfig, expectedActiveCents) => {
    const { service, prisma } = buildService();
    prisma.billingAccount.findFirst.mockResolvedValue(makeAccountRow({ creditConfig }));

    const view = await service.getEnterpriseCredit(ACCOUNT_ID);

    expect(view.activeLimitCents).toBe(expectedActiveCents);
  });

  it('明确暴露尚未确认的 policy revision，管理端不得视为历史可用', async () => {
    const { service, prisma } = buildService();
    prisma.billingAccount.findFirst.mockResolvedValue(makeAccountRow({
      creditConfig: makeCreditConfig({
        policyRevision: 7,
        policyEffectiveBoundaryAt: null,
        policyBoundaryComplete: false,
      }),
    }));

    const view = await service.getEnterpriseCredit(ACCOUNT_ID);

    expect(view).toEqual(expect.objectContaining({
      policyRevision: 7,
      policyEffectiveBoundaryAt: null,
      policyBoundaryComplete: false,
    }));
  });

  it('权威已批准应收计入 usedCents，remaining=activeLimit-used，可用余额=max(0,余额)+remaining', async () => {
    const { service, prisma } = buildService();
    prisma.billingAccount.findFirst.mockResolvedValue(
      makeAccountRow({
        wallet: { balanceUsd: new Prisma.Decimal(-30) },
        creditConfig: makeCreditConfig(),
      }),
    );
    prisma.enterpriseFundingSnapshot.findMany.mockResolvedValue([{
      billingAccountId: ACCOUNT_ID,
      approvedReceivableUsd: new Prisma.Decimal(30),
      unapprovedDebtUsd: new Prisma.Decimal(0),
      classificationComplete: true,
    }]);

    const view = await service.getEnterpriseCredit(ACCOUNT_ID);

    expect(view.usedCents).toBe(3000);
    expect(view.remainingCents).toBe(7000);
    expect(view.accountBalanceCents).toBe(-3000);
    // max(0, -30) + 剩余信用 70 = 70，负余额不再冲减可用
    expect(view.accountAvailableBalanceCents).toBe(7000);
  });

  it('正余额计入账户可用余额：max(0, 余额) + 剩余信用', async () => {
    const { service, prisma } = buildService();
    prisma.billingAccount.findFirst.mockResolvedValue(
      makeAccountRow({
        wallet: { balanceUsd: new Prisma.Decimal('520.3326') },
        creditConfig: makeCreditConfig(),
      }),
    );
    prisma.enterpriseFundingSnapshot.findMany.mockResolvedValue([{
      billingAccountId: ACCOUNT_ID,
      approvedReceivableUsd: new Prisma.Decimal(0),
      unapprovedDebtUsd: new Prisma.Decimal(0),
      classificationComplete: true,
    }]);

    const view = await service.getEnterpriseCredit(ACCOUNT_ID);

    expect(view.accountBalanceCents).toBe(52033);
    expect(view.remainingCents).toBe(10000);
    expect(view.accountAvailableBalanceCents).toBe(62033);
  });

  it('SUSPENDED 时剩余信用按 0 计入可用：可用 = max(0, 余额)', async () => {
    const { service, prisma } = buildService();
    prisma.billingAccount.findFirst.mockResolvedValue(
      makeAccountRow({
        wallet: { balanceUsd: new Prisma.Decimal(5) },
        creditConfig: makeCreditConfig({ status: 'SUSPENDED', limitUsd: new Prisma.Decimal(10) }),
      }),
    );

    const view = await service.getEnterpriseCredit(ACCOUNT_ID);

    expect(view.remainingCents).toBe(0);
    expect(view.accountAvailableBalanceCents).toBe(500);
  });
});

describe('EnterpriseAccountService.updateEnterpriseCredit', () => {
  it('写入配置 + 审计事件，并触发 key-balance fanout', async () => {
    const { service, prisma, publisherSync, billing } = buildService();

    await service.updateEnterpriseCredit(ACCOUNT_ID, {
      limitCents: 10000,
      status: 'active',
      termsDays: 30,
      updatedBy: 'admin-1',
      reason: '首次授信',
    });

    expect(prisma.billingAccountCreditConfig.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          billingAccountId: ACCOUNT_ID,
          limitUsd: new Prisma.Decimal(100),
          status: 'ACTIVE',
          termsDays: 30,
          policyRevision: 1,
          policyBoundaryComplete: false,
        }),
      }),
    );
    expect(prisma.billingAccountCreditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          newLimitUsd: new Prisma.Decimal(100),
          newStatus: 'ACTIVE',
          reason: '首次授信',
          policyRevision: 1,
          policyDecisionAt: new Date('2026-08-06T12:00:00.000Z'),
          policyBoundaryComplete: false,
        }),
      }),
    );
    expect(prisma.billingAccountCreditEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ policyRevision: 1, policyBoundaryComplete: false }),
        data: expect.objectContaining({
          policyEffectiveBoundaryAt: new Date('2026-08-06T12:00:00.001Z'),
          policyBoundaryComplete: true,
        }),
      }),
    );
    // 3 个事务：配置+审计、提交边界确认，以及授信恢复后的解限。
    // 第 3 个是 2026-09-02 新增：解封判据此前只认「实付已核销」，与授信是否恢复无关，
    // 导致运营改回 ACTIVE 后客户仍然打不通（国内 prod 08-28 实测白断 4 小时）。
    expect(prisma.$transaction).toHaveBeenCalledTimes(3);
    expect(publisherSync.syncBillingAccountKeyBalances).toHaveBeenCalledWith(ACCOUNT_ID);
    // 必须在 fanout 之后才解封：先让网关知道额度回来了，再放行流量。
    expect(billing.releasePolicyRestoredGatewayBalanceDebtRestrictions)
      .toHaveBeenCalledWith(expect.anything(), ACCOUNT_ID);
    expect(publisherSync.syncBillingAccountKeyBalances.mock.invocationCallOrder[0])
      .toBeLessThan(
        billing.releasePolicyRestoredGatewayBalanceDebtRestrictions
          .mock.invocationCallOrder[0],
      );
  });

  it('Publisher 失败不吞错且不写 marker，同幂等请求可恢复 fanout', async () => {
    const { service, prisma, publisherSync } = buildService();
    const input = {
      limitCents: 10000,
      status: 'ACTIVE',
      termsDays: 30,
      idempotencyKey: 'idem-fanout-recovery',
    };
    publisherSync.syncBillingAccountKeyBalances.mockRejectedValueOnce(
      new Error('publisher enumeration interrupted'),
    );

    await expect(service.updateEnterpriseCredit(ACCOUNT_ID, input)).rejects.toThrow(
      'publisher enumeration interrupted',
    );
    expect(prisma.billingAccountCreditEvent.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ policyFanoutEnqueuedAt: expect.any(Date) }) }),
    );

    await expect(service.updateEnterpriseCredit(ACCOUNT_ID, input)).resolves.toBeDefined();

    expect(prisma.billingAccountCreditConfig.create).toHaveBeenCalledTimes(1);
    expect(prisma.billingAccountCreditEvent.create).toHaveBeenCalledTimes(1);
    expect(publisherSync.syncBillingAccountKeyBalances).toHaveBeenCalledTimes(2);
    expect(prisma.billingAccountCreditEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          policyRevision: 1,
          policyBoundaryComplete: true,
          policyFanoutEnqueuedAt: null,
        }),
        data: { policyFanoutEnqueuedAt: expect.any(Date) },
      }),
    );
  });

  it('幂等：idempotencyKey 已有事件 → 不再写配置，直接返回当前视图', async () => {
    const { service, prisma, publisherSync } = buildService();
    const input = {
      limitCents: 999999,
      idempotencyKey: 'idem-1',
    };
    prisma.billingAccountCreditEvent.findUnique.mockResolvedValue({
      id: 'evt-existing',
      billingAccountId: ACCOUNT_ID,
      policyRevision: 1,
      temporalSnapshotComplete: true,
      policyDecisionAt: new Date('2026-08-06T11:00:00.000Z'),
      policyEffectiveBoundaryAt: new Date('2026-08-06T11:00:00.001Z'),
      policyBoundaryComplete: true,
      policyFanoutEnqueuedAt: new Date('2026-08-06T11:00:01.000Z'),
      requestFingerprint: (service as any).creditMutationFingerprint(input),
    });

    await service.updateEnterpriseCredit(ACCOUNT_ID, input);

    expect(prisma.billingAccountCreditConfig.create).not.toHaveBeenCalled();
    expect(prisma.billingAccountCreditConfig.update).not.toHaveBeenCalled();
    expect(prisma.billingAccountCreditEvent.create).not.toHaveBeenCalled();
    expect(publisherSync.syncBillingAccountKeyBalances).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  it('相同 idempotencyKey 但归一化参数不同 → 409，不静默返回旧授信', async () => {
    const { service, prisma } = buildService();
    const original = { limitCents: 10000, status: 'ACTIVE', idempotencyKey: 'idem-conflict' };
    prisma.billingAccountCreditEvent.findUnique.mockResolvedValue({
      id: 'evt-existing',
      billingAccountId: ACCOUNT_ID,
      policyRevision: 1,
      requestFingerprint: (service as any).creditMutationFingerprint(original),
    });

    await expect(service.updateEnterpriseCredit(ACCOUNT_ID, {
      ...original,
      limitCents: 20000,
    })).rejects.toMatchObject({
      response: { code: 'enterprise_credit_idempotency_conflict' },
    });
    expect(prisma.billingAccountCreditConfig.create).not.toHaveBeenCalled();
    expect(prisma.billingAccountCreditConfig.update).not.toHaveBeenCalled();
  });

  it('fingerprint 用 typed omission，真实 __OMITTED__ 字符串不会与缺省字段碰撞', () => {
    const { service } = buildService();
    const omitted = (service as any).creditMutationFingerprint({ limitCents: 10000 });
    const literal = (service as any).creditMutationFingerprint({
      limitCents: 10000,
      note: '__OMITTED__',
    });

    expect(literal).not.toBe(omitted);
  });

  it('P2002 只有命中同账户同 fingerprint 的 durable event 才可按幂等重放', async () => {
    const { service, prisma } = buildService();
    const collision = { code: 'P2002', meta: { target: ['billing_account_id', 'policy_revision'] } };
    prisma.$transaction.mockRejectedValueOnce(collision);
    prisma.billingAccountCreditEvent.findUnique.mockResolvedValue(null);

    await expect(service.updateEnterpriseCredit(ACCOUNT_ID, {
      limitCents: 10000,
      idempotencyKey: 'idem-not-created',
    })).rejects.toBe(collision);
  });

  it('幂等重放会补齐同 revision 的 pending boundary 后再返回', async () => {
    const { service, prisma, publisherSync } = buildService();
    const input = { limitCents: 10000, idempotencyKey: 'idem-pending' };
    const pendingEvent = {
      id: 'evt-pending',
      billingAccountId: ACCOUNT_ID,
      policyRevision: 1,
      requestFingerprint: (service as any).creditMutationFingerprint(input),
      temporalSnapshotComplete: true,
      policyDecisionAt: new Date('2026-08-06T11:59:59.000Z'),
      policyEffectiveBoundaryAt: null,
      policyBoundaryComplete: false,
    };
    prisma.billingAccountCreditEvent.findUnique.mockResolvedValue(pendingEvent);
    prisma.billingAccountCreditEvent.updateMany.mockResolvedValue({ count: 1 });
    prisma.billingAccountCreditConfig.findUnique.mockResolvedValue(makeCreditConfig({
      policyRevision: 1,
      policyBoundaryComplete: false,
    }));

    await service.updateEnterpriseCredit(ACCOUNT_ID, input);

    expect(prisma.billingAccountCreditEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'evt-pending', policyRevision: 1 }),
        data: expect.objectContaining({ policyBoundaryComplete: true }),
      }),
    );
    expect(publisherSync.syncBillingAccountKeyBalances).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  it('P2002 幂等重放确认 durable event 后同样执行 account fanout', async () => {
    const { service, prisma, publisherSync } = buildService();
    const input = { limitCents: 10000, idempotencyKey: 'idem-p2002-replay' };
    const event = {
      id: 'evt-p2002-replay',
      billingAccountId: ACCOUNT_ID,
      policyRevision: 1,
      requestFingerprint: (service as any).creditMutationFingerprint(input),
      temporalSnapshotComplete: true,
      policyDecisionAt: new Date('2026-08-06T11:00:00.000Z'),
      policyEffectiveBoundaryAt: new Date('2026-08-06T11:00:00.001Z'),
      policyBoundaryComplete: true,
      policyFanoutEnqueuedAt: new Date('2026-08-06T11:00:01.000Z'),
    };
    prisma.$transaction.mockRejectedValueOnce({ code: 'P2002' });
    prisma.billingAccountCreditEvent.findUnique.mockResolvedValue(event);
    prisma.billingAccountCreditConfig.findUnique.mockResolvedValue(makeCreditConfig({
      policyRevision: 1,
      policyEffectiveBoundaryAt: event.policyEffectiveBoundaryAt,
      policyBoundaryComplete: true,
    }));

    await service.updateEnterpriseCredit(ACCOUNT_ID, input);

    expect(publisherSync.syncBillingAccountKeyBalances).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  it('rev2 已先确认 rev1 并推进配置时，rev1 原调用仍幂等成功且不得回写旧投影', async () => {
    const { service, prisma } = buildService();
    prisma.billingAccountCreditConfig.findUnique.mockResolvedValue(makeCreditConfig({
      policyRevision: 2,
      policyEffectiveBoundaryAt: null,
      policyBoundaryComplete: false,
    }));
    prisma.billingAccountCreditEvent.findUnique.mockResolvedValue({
      id: 'evt-rev1',
      billingAccountId: ACCOUNT_ID,
      policyRevision: 1,
      temporalSnapshotComplete: true,
      policyDecisionAt: new Date('2026-08-06T11:00:00.000Z'),
      policyEffectiveBoundaryAt: new Date('2026-08-06T11:00:01.000Z'),
      policyBoundaryComplete: true,
    });

    await expect((service as any).confirmCreditPolicyBoundary(
      ACCOUNT_ID,
      'evt-rev1',
      1,
    )).resolves.toBeUndefined();

    expect(prisma.billingAccountCreditConfig.update).not.toHaveBeenCalled();
    expect(prisma.billingAccountCreditEvent.updateMany).not.toHaveBeenCalled();
  });

  it('limitCents 负数 → BadRequest', async () => {
    const { service } = buildService();
    await expect(
      service.updateEnterpriseCredit(ACCOUNT_ID, { limitCents: -1 }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('status 非法 → BadRequest', async () => {
    const { service } = buildService();
    await expect(
      service.updateEnterpriseCredit(ACCOUNT_ID, { status: 'FROZEN' }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('expiresAt 早于 effectiveAt → BadRequest', async () => {
    const { service } = buildService();
    await expect(
      service.updateEnterpriseCredit(ACCOUNT_ID, {
        effectiveAt: '2026-08-01T00:00:00.000Z',
        expiresAt: '2026-07-01T00:00:00.000Z',
      }),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('非企业账户 → enterprise_account_not_found', async () => {
    const { service, prisma } = buildService();
    prisma.billingAccount.findFirst.mockResolvedValue(makeAccountRow({ type: 'personal' }));
    await expect(
      service.updateEnterpriseCredit(ACCOUNT_ID, { limitCents: 100 }),
    ).rejects.toMatchObject({ response: { code: 'enterprise_account_not_found' } });
  });
});

describe('EnterpriseAccountService.updateEnterpriseSnapshot — 欠款守卫', () => {
  it('钱包为负时禁止停用账户', async () => {
    const { service, prisma } = buildService();
    prisma.$queryRaw.mockResolvedValueOnce([{ balanceUsd: new Prisma.Decimal(-50) }]);

    await expect(
      service.updateEnterpriseSnapshot(ACCOUNT_ID, { status: 'suspended' }),
    ).rejects.toMatchObject({
      response: { code: 'enterprise_account_has_outstanding_credit' },
    });
    expect(prisma.billingAccount.update).not.toHaveBeenCalled();
  });

  it('欠款已结清后可以停用', async () => {
    const { service, prisma } = buildService();

    await service.updateEnterpriseSnapshot(ACCOUNT_ID, { status: 'suspended' });

    expect(prisma.billingAccount.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'suspended' }) }),
    );
  });

  it('改回 active 不检查欠款', async () => {
    const { service, prisma } = buildService();
    prisma.$queryRaw.mockResolvedValueOnce([{ balanceUsd: new Prisma.Decimal(-50) }]);

    await service.updateEnterpriseSnapshot(ACCOUNT_ID, { status: 'active' });

    // 欠款守卫只拦"停用"，不拦"改回 active"——本用例的原意保持不变。
    expect(prisma.billingAccount.update).toHaveBeenCalled();
    // 议题二批一：激活分支必须走带 quarantine 条件的原子更新（不能"先读后写"）。
    expect(prisma.billingAccount.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ provisioningQuarantinedAt: null }),
      }),
    );
  });

  it('已回收（quarantined）账户不得经 snapshot 改回 active，且整笔回滚', async () => {
    const { service, prisma } = buildService();
    prisma.$queryRaw.mockResolvedValueOnce([{ balanceUsd: new Prisma.Decimal(0) }]);
    // 条件更新影响 0 行 ⇒ 说明该账户已被回收。
    prisma.billingAccount.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(
      service.updateEnterpriseSnapshot(ACCOUNT_ID, { status: 'active', name: '顺带改名' }),
    ).rejects.toMatchObject({ response: expect.objectContaining({ code: 'enterprise_account_quarantined' }) });

    // 同事务 ⇒ 其它快照字段（name）也不得落库。
    expect(prisma.billingAccount.update).not.toHaveBeenCalled();
  });
});

describe('EnterpriseAccountService — 已发布账户生命周期锁序', () => {
  it.each([
    [
      'snapshot update',
      async (service: EnterpriseAccountService) => service.updateEnterpriseSnapshot(
        ACCOUNT_ID,
        { name: '新企业名' },
      ),
      'billingAccount.update',
    ],
    [
      'credit config update',
      async (service: EnterpriseAccountService) => service.updateEnterpriseCredit(
        ACCOUNT_ID,
        { limitCents: 10000, status: 'ACTIVE', termsDays: 30 },
      ),
      'billingAccountCreditConfig.create',
    ],
    [
      'owner member upsert',
      async (service: EnterpriseAccountService) => service.upsertOwnerMember(
        ACCOUNT_ID,
        { userId: 'u1' },
      ),
      'billingAccountMember.upsert',
    ],
  ])('%s 先锁 wallet 再锁 account，然后才写入', async (_name, invoke, writePath) => {
    const { service, prisma } = buildService();

    await invoke(service);

    expectWalletAccountLockOrder(prisma);
    const [group, method] = writePath.split('.');
    const writeMock = prisma[group][method];
    expect(prisma.$queryRaw.mock.invocationCallOrder[1])
      .toBeLessThan(writeMock.mock.invocationCallOrder[0]);
  });

  it.each([
    [
      'attach',
      null,
      async (service: EnterpriseAccountService) => service.attachTenant(
        ACCOUNT_ID,
        { tenantId: 'tenant-1' },
      ),
    ],
    [
      'detach',
      ACCOUNT_ID,
      async (service: EnterpriseAccountService) => service.detachTenantForRecovery(
        ACCOUNT_ID,
        'tenant-1',
        '恢复演练',
      ),
    ],
  ])('%s 按 wallet -> account -> tenant 锁序重验后更新', async (_name, binding, invoke) => {
    const { service, prisma, publisherSync, billing } = buildService();
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'tenant-1',
      billingAccountId: binding,
      ownerUserId: 'u1',
    });

    await invoke(service);

    const sql = rawLockSql(prisma);
    expectWalletAccountLockOrder(prisma);
    expect(sql[2]).toContain('FROM "tenants"');
    expect(sql[2]).toContain('FOR UPDATE');
    expect(prisma.$queryRaw.mock.invocationCallOrder[2])
      .toBeLessThan(prisma.tenant.update.mock.invocationCallOrder[0]);
    expect(billing.syncTenantBalanceCacheForCurrentBinding)
      .toHaveBeenCalledWith('tenant-1');
    expect(billing.syncTenantBalanceCacheForCurrentBinding.mock.invocationCallOrder[0])
      .toBeLessThan(publisherSync.syncBillingAccountKeyBalances.mock.invocationCallOrder[0]);
  });

  it.each([
    [
      'snapshot',
      async (service: EnterpriseAccountService) => service.updateEnterpriseSnapshot(
        ACCOUNT_ID,
        { status: 'suspended' },
      ),
    ],
    [
      'credit',
      async (service: EnterpriseAccountService) => service.updateEnterpriseCredit(
        ACCOUNT_ID,
        { limitCents: 10000 },
      ),
    ],
    [
      'owner member',
      async (service: EnterpriseAccountService) => service.upsertOwnerMember(
        ACCOUNT_ID,
        { userId: 'u2' },
      ),
    ],
    [
      'attach',
      async (service: EnterpriseAccountService) => service.attachTenant(
        ACCOUNT_ID,
        { tenantId: 'tenant-1' },
      ),
    ],
    [
      'detach',
      async (service: EnterpriseAccountService) => service.detachTenantForRecovery(
        ACCOUNT_ID,
        'tenant-1',
        '恢复演练',
      ),
    ],
  ])('%s 遇到缺 wallet 稳定 409 且无部分写', async (_name, invoke) => {
    const { service, prisma, publisherSync, billing } = buildService();
    prisma.$queryRaw.mockResolvedValueOnce([]);

    await expect(invoke(service)).rejects.toMatchObject({
      status: 409,
      response: {
        code: 'billing_account_not_provisioned',
        message: '账务账号尚未完成开户，请稍后重试',
      },
    });
    expect(prisma.billingAccount.update).not.toHaveBeenCalled();
    expect(prisma.billingAccountCreditConfig.create).not.toHaveBeenCalled();
    expect(prisma.billingAccountCreditConfig.update).not.toHaveBeenCalled();
    expect(prisma.billingAccountCreditEvent.create).not.toHaveBeenCalled();
    expect(prisma.billingAccountMember.upsert).not.toHaveBeenCalled();
    expect(prisma.tenant.update).not.toHaveBeenCalled();
    expect(billing.syncTenantBalanceCacheForCurrentBinding).not.toHaveBeenCalled();
    expect(publisherSync.syncBillingAccountKeyBalances).not.toHaveBeenCalled();
  });
});

describe('EnterpriseAccountService.transferEnterpriseOwner', () => {
  const request = {
    tenantId: 'tenant-1',
    previousOwnerUserId: 'u1',
    newOwner: {
      id: 'u2',
      email: 'new-owner@example.com',
      phone: '13800000002',
      nickname: '新管理员',
      isActive: true,
      sourceUpdatedAt: '2026-08-06T08:00:00.000Z',
    },
  };

  function prepareBoundTenant(prisma: any, overrides: Record<string, unknown> = {}) {
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'tenant-1',
      billingAccountId: ACCOUNT_ID,
      ownerUserId: 'u1',
      ...overrides,
    });
  }

  it('按 user -> wallet -> account -> tenant -> tenant members -> account members 锁序原子转移 owner', async () => {
    const { service, prisma } = buildService();
    prepareBoundTenant(prisma);

    await expect(service.transferEnterpriseOwner(ACCOUNT_ID, request)).resolves.toEqual({
      id: ACCOUNT_ID,
      tenantId: 'tenant-1',
      previousOwnerUserId: 'u1',
      ownerUserId: 'u2',
      transferred: true,
      idempotent: false,
    });

    const sql = rawLockSql(prisma);
    expect(sql[0]).toContain('FROM "account_wallets"');
    expect(sql[1]).toContain('FROM "billing_accounts"');
    expect(sql[2]).toContain('FROM "tenants"');
    expect(sql[3]).toContain('FROM "tenant_members"');
    expect(sql[4]).toContain('FROM "billing_account_members"');
    for (const statement of sql) expect(statement).toContain('FOR UPDATE');

    expect(prisma.billingAccount.update).toHaveBeenCalledWith({
      where: { id: ACCOUNT_ID },
      data: { ownerUserId: 'u2' },
    });
    expect(prisma.tenant.update).toHaveBeenCalledWith({
      where: { id: 'tenant-1' },
      data: { ownerUserId: 'u2' },
    });
    expect(prisma.tenantMember.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.tenantMember.upsert).toHaveBeenNthCalledWith(1, {
      where: { tenantId_userId: { tenantId: 'tenant-1', userId: 'u1' } },
      create: {
        tenantId: 'tenant-1',
        userId: 'u1',
        role: 'member',
        status: 'active',
      },
      update: { role: 'member', status: 'active' },
    });
    expect(prisma.tenantMember.upsert).toHaveBeenNthCalledWith(2, {
      where: { tenantId_userId: { tenantId: 'tenant-1', userId: 'u2' } },
      create: {
        tenantId: 'tenant-1',
        userId: 'u2',
        role: 'owner',
        status: 'active',
      },
      update: { role: 'owner', status: 'active' },
    });
    expect(prisma.billingAccountMember.upsert).toHaveBeenCalledTimes(2);
    expect(prisma.billingAccountMember.upsert).toHaveBeenNthCalledWith(1, {
      where: {
        billingAccountId_userId: { billingAccountId: ACCOUNT_ID, userId: 'u1' },
      },
      create: {
        billingAccountId: ACCOUNT_ID,
        userId: 'u1',
        role: 'member',
        status: 'active',
      },
      update: { role: 'member', status: 'active' },
    });
    expect(prisma.billingAccountMember.upsert).toHaveBeenNthCalledWith(2, {
      where: {
        billingAccountId_userId: { billingAccountId: ACCOUNT_ID, userId: 'u2' },
      },
      create: {
        billingAccountId: ACCOUNT_ID,
        userId: 'u2',
        role: 'owner',
        status: 'active',
      },
      update: { role: 'owner', status: 'active' },
    });
  });

  it('目标 billing user 镜像缺失时使用 user-api 快照安全补齐，再创建 owner memberships', async () => {
    const { service, prisma } = buildService();
    prepareBoundTenant(prisma);
    prisma.user.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ id: 'u2', isActive: true });

    await service.transferEnterpriseOwner(ACCOUNT_ID, request);

    expect(prisma.user.upsert).toHaveBeenCalledWith({
      where: { id: 'u2' },
      create: {
        id: 'u2',
        email: 'new-owner@example.com',
        phone: '13800000002',
        nickname: '新管理员',
        isActive: true,
        sourceUpdatedAt: new Date('2026-08-06T08:00:00.000Z'),
        mirroredAt: expect.any(Date),
      },
      update: { mirroredAt: expect.any(Date) },
    });
    expect(prisma.tenantMember.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ userId: 'u2', role: 'owner', status: 'active' }),
      }),
    );
    expect(prisma.billingAccountMember.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ userId: 'u2', role: 'owner', status: 'active' }),
      }),
    );
  });

  it('首次转移已提交后，携带旧 previous owner 的重试幂等成功', async () => {
    const { service, prisma } = buildService();
    prisma.billingAccount.findFirst.mockResolvedValue(makeAccountRow({ ownerUserId: 'u2' }));
    prepareBoundTenant(prisma, { ownerUserId: 'u2' });

    await expect(service.transferEnterpriseOwner(ACCOUNT_ID, request)).resolves.toEqual({
      id: ACCOUNT_ID,
      tenantId: 'tenant-1',
      previousOwnerUserId: 'u1',
      ownerUserId: 'u2',
      transferred: false,
      idempotent: true,
    });
    expect(prisma.billingAccount.update).not.toHaveBeenCalled();
    expect(prisma.tenant.update).not.toHaveBeenCalled();
    expect(prisma.tenantMember.upsert).not.toHaveBeenCalled();
    expect(prisma.billingAccountMember.upsert).not.toHaveBeenCalled();
  });

  it('已提交的重试不因目标用户后续失活而变成失败', async () => {
    const { service, prisma } = buildService();
    prisma.billingAccount.findFirst.mockResolvedValue(makeAccountRow({ ownerUserId: 'u2' }));
    prepareBoundTenant(prisma, { ownerUserId: 'u2' });
    prisma.user.findUnique
      .mockResolvedValueOnce({
        id: 'u2',
        isActive: false,
        sourceUpdatedAt: new Date('2026-08-07T08:00:00.000Z'),
      })
      .mockResolvedValueOnce({ id: 'u2', isActive: false });

    await expect(service.transferEnterpriseOwner(ACCOUNT_ID, request)).resolves.toMatchObject({
      transferred: false,
      idempotent: true,
      ownerUserId: 'u2',
    });
    expect(prisma.billingAccount.update).not.toHaveBeenCalled();
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it.each([
    ['account 已归其他人', 'u3', 'u1'],
    ['tenant 已归其他人', 'u1', 'u3'],
    ['仅 account 已指向目标（不完整状态）', 'u2', 'u1'],
    ['account/tenant 已同步归第三人', 'u3', 'u3'],
  ])('%s 时拒绝陈旧请求', async (_name, accountOwner, tenantOwner) => {
    const { service, prisma } = buildService();
    prisma.billingAccount.findFirst.mockResolvedValue(
      makeAccountRow({ ownerUserId: accountOwner }),
    );
    prepareBoundTenant(prisma, { ownerUserId: tenantOwner });

    await expect(service.transferEnterpriseOwner(ACCOUNT_ID, request)).rejects.toMatchObject({
      response: { code: 'enterprise_owner_transfer_conflict' },
    });
    expect(prisma.billingAccount.update).not.toHaveBeenCalled();
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('拒绝非 active 企业账户', async () => {
    const { service, prisma } = buildService();
    prisma.billingAccount.findFirst.mockResolvedValue(makeAccountRow({ status: 'suspended' }));
    prepareBoundTenant(prisma);

    await expect(service.transferEnterpriseOwner(ACCOUNT_ID, request)).rejects.toMatchObject({
      response: { code: 'enterprise_account_unusable' },
    });
    expect(prisma.tenant.findUnique).not.toHaveBeenCalled();
  });

  it('拒绝已删除或不存在的企业账户', async () => {
    const { service, prisma } = buildService();
    prisma.billingAccount.findFirst.mockResolvedValue(null);

    await expect(service.transferEnterpriseOwner(ACCOUNT_ID, request)).rejects.toMatchObject({
      response: { code: 'enterprise_account_not_found' },
    });
    expect(prisma.billingAccount.update).not.toHaveBeenCalled();
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('账户缺失 wallet 时稳定失败且不产生 owner 部分写入', async () => {
    const { service, prisma } = buildService();
    prisma.$queryRaw.mockResolvedValueOnce([]);

    await expect(service.transferEnterpriseOwner(ACCOUNT_ID, request)).rejects.toMatchObject({
      response: { code: 'billing_account_not_provisioned' },
    });
    expect(prisma.billingAccount.update).not.toHaveBeenCalled();
    expect(prisma.tenant.update).not.toHaveBeenCalled();
    expect(prisma.tenantMember.upsert).not.toHaveBeenCalled();
    expect(prisma.billingAccountMember.upsert).not.toHaveBeenCalled();
  });

  it('拒绝未绑定到该企业账户的 tenant', async () => {
    const { service, prisma } = buildService();
    prepareBoundTenant(prisma, { billingAccountId: 'ba-other' });

    await expect(service.transferEnterpriseOwner(ACCOUNT_ID, request)).rejects.toMatchObject({
      response: { code: 'enterprise_tenant_binding_mismatch' },
    });
    expect(prisma.billingAccount.update).not.toHaveBeenCalled();
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('新 owner 镜像不可用时拒绝首次转移', async () => {
    const { service, prisma } = buildService();
    prepareBoundTenant(prisma);
    prisma.user.findUnique
      .mockResolvedValueOnce({
        id: 'u2',
        isActive: false,
        sourceUpdatedAt: new Date('2026-08-07T08:00:00.000Z'),
      })
      .mockResolvedValueOnce({ id: 'u2', isActive: false });

    await expect(service.transferEnterpriseOwner(ACCOUNT_ID, request)).rejects.toMatchObject({
      response: { code: 'enterprise_new_owner_inactive' },
    });
    expectWalletAccountLockOrder(prisma);
    expect(prisma.billingAccount.update).not.toHaveBeenCalled();
  });
});

describe('EnterpriseAccountService — 锁后重验与 TOCTOU 防护', () => {
  it('在 wallet/account 锁后读取授信旧值，并写入同一快照的审计事件', async () => {
    const { service, prisma } = buildService();
    prisma.billingAccountCreditConfig.findUnique.mockResolvedValue(
      makeCreditConfig({ limitUsd: new Prisma.Decimal(250), termsDays: 60 }),
    );

    await service.updateEnterpriseCredit(ACCOUNT_ID, { status: 'SUSPENDED' });

    expectWalletAccountLockOrder(prisma);
    expect(prisma.$queryRaw.mock.invocationCallOrder[1])
      .toBeLessThan(prisma.billingAccountCreditConfig.findUnique.mock.invocationCallOrder[0]);
    expect(prisma.billingAccountCreditConfig.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { billingAccountId: ACCOUNT_ID },
        data: expect.objectContaining({
          limitUsd: new Prisma.Decimal(250),
          termsDays: 60,
          status: 'SUSPENDED',
        }),
      }),
    );
    expect(prisma.billingAccountCreditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          oldLimitUsd: new Prisma.Decimal(250),
          newLimitUsd: new Prisma.Decimal(250),
          oldTermsDays: 60,
          newTermsDays: 60,
          oldEffectiveAt: null,
          newEffectiveAt: null,
          temporalSnapshotComplete: true,
        }),
      }),
    );
  });

  it('attach 在获得 tenant 锁后发现已改绑，拒绝覆盖', async () => {
    const { service, prisma } = buildService();
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'tenant-1',
      billingAccountId: 'ba_ent_other',
      ownerUserId: 'u1',
    });

    await expect(service.attachTenant(ACCOUNT_ID, { tenantId: 'tenant-1' }))
      .rejects.toMatchObject({ response: { code: 'tenant_attach_conflict' } });
    expect(prisma.tenant.update).not.toHaveBeenCalled();
  });

  it('detach 在获得 tenant 锁后发现已改绑，幂等返回且不清空新绑定', async () => {
    const { service, prisma, billing } = buildService();
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'tenant-1',
      billingAccountId: 'ba_ent_other',
      ownerUserId: 'u1',
    });

    const result = await service.detachTenantForRecovery(
      ACCOUNT_ID,
      'tenant-1',
      '恢复演练',
    );

    expect(result.detached).toBe(false);
    expect(prisma.tenant.update).not.toHaveBeenCalled();
    expect(billing.syncTenantBalanceCacheForCurrentBinding)
      .toHaveBeenCalledWith('tenant-1');
  });

  it('attach/detach 在 tenant 锁后重验 owner，不修改归属错位的绑定', async () => {
    for (const operation of ['attach', 'detach'] as const) {
      const { service, prisma } = buildService();
      prisma.tenant.findUnique.mockResolvedValue({
        id: 'tenant-1',
        billingAccountId: operation === 'attach' ? null : ACCOUNT_ID,
        ownerUserId: 'u-other',
      });

      const request = operation === 'attach'
        ? service.attachTenant(ACCOUNT_ID, { tenantId: 'tenant-1' })
        : service.detachTenantForRecovery(ACCOUNT_ID, 'tenant-1', '恢复演练');
      await expect(request).rejects.toMatchObject({
        response: { code: 'enterprise_tenant_owner_mismatch' },
      });
      expect(prisma.tenant.update).not.toHaveBeenCalled();
    }
  });
});

describe('EnterpriseAccountService.listEnterpriseAccounts — offset 分页 + 过滤', () => {
  it('返回 {items,total,page,pageSize,totalPages}，并透传过滤条件', async () => {
    const { service, prisma } = buildService();
    prisma.billingAccount.count.mockResolvedValue(41);
    prisma.billingAccount.findMany.mockResolvedValue([makeAccountRow()]);

    const result = await service.listEnterpriseAccounts({
      page: 2,
      pageSize: 20,
      status: 'active',
      search: '瑞东',
    });

    expect(result.total).toBe(41);
    expect(result.page).toBe(2);
    expect(result.pageSize).toBe(20);
    expect(result.totalPages).toBe(3);
    expect(result.items).toHaveLength(1);
    expect(prisma.billingAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        skip: 20,
        take: 20,
        where: expect.objectContaining({
          type: 'enterprise',
          status: 'active',
          OR: expect.arrayContaining([
            expect.objectContaining({ enterpriseName: expect.anything() }),
          ]),
        }),
      }),
    );
  });

  it('page/pageSize 越界钳制：page<1→1，pageSize>200→200', async () => {
    const { service, prisma } = buildService();
    prisma.billingAccount.count.mockResolvedValue(0);
    prisma.billingAccount.findMany.mockResolvedValue([]);

    const result = await service.listEnterpriseAccounts({ page: 0, pageSize: 999 });

    expect(result.page).toBe(1);
    expect(result.pageSize).toBe(200);
    expect(prisma.billingAccount.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ skip: 0, take: 200 }),
    );
  });

  it('列表余额取该账户最新一条余额流水的变动后余额，不取钱包快照', async () => {
    const { service, prisma } = buildService();
    prisma.billingAccount.count.mockResolvedValue(1);
    prisma.billingAccount.findMany.mockResolvedValue([
      makeAccountRow({ wallet: { balanceUsd: new Prisma.Decimal('99') } }),
    ]);
    const fallback = prisma.$queryRaw.getMockImplementation();
    prisma.$queryRaw.mockImplementation(async (parts: unknown, ...values: unknown[]) => {
      const sql = rawSqlText(parts);
      if (sql.includes('latest-ledger-lateral')) {
        return [{
          billing_account_id: ACCOUNT_ID,
          balance_after_usd: new Prisma.Decimal('-0.14356789'),
        }];
      }
      return fallback ? fallback(parts, ...values) : [];
    });

    const result = await service.listEnterpriseAccounts({ page: 1, pageSize: 20 });

    expect(result.items[0]?.credit?.accountBalanceCents).toBe(9900);
    expect(result.items[0]?.ledgerBalanceAfterCents).toBe(-14);
    const sql = rawLockSql(prisma);
    expect(prisma.enterpriseFundingSnapshot.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.enterpriseFundingSnapshot.findMany).toHaveBeenCalledWith({
      where: { billingAccountId: { in: [ACCOUNT_ID] } },
    });
    expect(prisma.enterpriseFundingSnapshot.findUnique).not.toHaveBeenCalled();
    const ledgerSql = sql.find((text) => text.includes('latest-ledger-lateral'));
    const ledgerCalls = prisma.$queryRaw.mock.calls.filter((args: unknown[]) =>
      rawSqlText(args[0], ...args.slice(1)).includes('latest-ledger-lateral'),
    );
    expect(ledgerCalls).toHaveLength(1);
    expect(sql.some((text) => text.includes('funding-outstanding-remaining'))).toBe(false);
    expect(ledgerSql).toContain('LATERAL');
    expect(ledgerSql).toContain('LIMIT 1');
    expect(ledgerSql).toContain('ledger_sequence');
    expect(ledgerSql).toContain('"created_at" DESC');
    expect(ledgerSql).not.toContain('DISTINCT ON');
    expect(ledgerSql).not.toContain('"id" DESC');
    expect(ledgerSql).not.toMatch(/\bIN\s*\(/);
  });

  it('一页多户只打一条余额 SQL 和一次资金快照 findMany', async () => {
    const { service, prisma } = buildService();
    const secondId = 'ba_ent_2';
    prisma.billingAccount.count.mockResolvedValue(2);
    prisma.billingAccount.findMany.mockResolvedValue([
      makeAccountRow(),
      makeAccountRow({ id: secondId }),
    ]);
    prisma.enterpriseFundingSnapshot.findMany.mockResolvedValue([
      {
        billingAccountId: ACCOUNT_ID,
        approvedReceivableUsd: new Prisma.Decimal(1),
        unapprovedDebtUsd: new Prisma.Decimal(0),
        classificationComplete: true,
      },
      {
        billingAccountId: secondId,
        approvedReceivableUsd: new Prisma.Decimal(2),
        unapprovedDebtUsd: new Prisma.Decimal(0),
        classificationComplete: true,
      },
    ]);
    const fallback = prisma.$queryRaw.getMockImplementation();
    prisma.$queryRaw.mockImplementation(async (parts: unknown, ...values: unknown[]) => {
      const sql = rawSqlText(parts);
      if (sql.includes('latest-ledger-lateral')) {
        return [
          { billing_account_id: ACCOUNT_ID, balance_after_usd: new Prisma.Decimal('1') },
          { billing_account_id: secondId, balance_after_usd: new Prisma.Decimal('2') },
        ];
      }
      return fallback ? fallback(parts, ...values) : [];
    });

    const result = await service.listEnterpriseAccounts({ page: 1, pageSize: 20 });

    expect(result.items.map((row) => row.ledgerBalanceAfterCents)).toEqual([100, 200]);
    expect(prisma.enterpriseFundingSnapshot.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.enterpriseFundingSnapshot.findMany).toHaveBeenCalledWith({
      where: { billingAccountId: { in: [ACCOUNT_ID, secondId] } },
    });
    expect(prisma.enterpriseFundingSnapshot.findUnique).not.toHaveBeenCalled();
    const ledgerCalls = prisma.$queryRaw.mock.calls.filter((args: unknown[]) =>
      rawSqlText(args[0], ...args.slice(1)).includes('latest-ledger-lateral'),
    );
    expect(ledgerCalls).toHaveLength(1);
    const ledgerSql = rawSqlText(ledgerCalls[0][0], ...ledgerCalls[0].slice(1));
    expect(ledgerSql).toContain('LATERAL');
    expect(ledgerSql).toContain('LIMIT 1');
    expect(ledgerSql).not.toContain('DISTINCT ON');
  });
});

describe('EnterpriseAccountService.resolveFundingAnchor', () => {
  it('返回企业账户 owner 与首个 active tenant 作为资金流水锚点', async () => {
    const { service, prisma } = buildService();
    prisma.tenant.findFirst.mockResolvedValue({ id: 'tenant-1' });

    const result = await service.resolveFundingAnchor(ACCOUNT_ID);

    expect(result).toEqual({
      billingAccountId: ACCOUNT_ID,
      ownerUserId: 'u1',
      tenantId: 'tenant-1',
    });
    expect(prisma.tenant.findFirst).toHaveBeenCalledWith({
      where: {
        billingAccountId: ACCOUNT_ID,
        status: 'active',
        deletedAt: null,
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
  });

  it('未挂载有效 tenant 时拒绝充值锚点解析', async () => {
    const { service, prisma } = buildService();
    prisma.tenant.findFirst.mockResolvedValue(null);

    await expect(service.resolveFundingAnchor(ACCOUNT_ID)).rejects.toMatchObject({
      response: { code: 'enterprise_account_tenant_required' },
    });
  });

  it('非 active 企业账户拒绝充值锚点解析', async () => {
    const { service, prisma } = buildService();
    prisma.billingAccount.findFirst.mockResolvedValue(makeAccountRow({ status: 'suspended' }));

    await expect(service.resolveFundingAnchor(ACCOUNT_ID)).rejects.toMatchObject({
      response: { code: 'enterprise_account_unusable' },
    });
    expect(prisma.tenant.findFirst).not.toHaveBeenCalled();
  });
});

describe('EnterpriseAccountService.refreshFundingSnapshots', () => {
  it('一条 INSERT SELECT ON CONFLICT 回写全户快照，不按户 SUM allocation、不逐户 upsert', async () => {
    const { service, prisma } = buildService();
    const fallback = prisma.$queryRaw.getMockImplementation();
    prisma.$queryRaw.mockImplementation(async (parts: unknown, ...values: unknown[]) => {
      const sql = rawSqlText(parts);
      if (sql.includes('funding-snapshot-upsert')) {
        return [{ billing_account_id: 'ba-1' }, { billing_account_id: 'ba-2' }];
      }
      return fallback ? fallback(parts, ...values) : [];
    });

    const processed = await service.refreshFundingSnapshots();

    expect(processed).toBe(2);
    expect(prisma.billingAccount.findMany).not.toHaveBeenCalled();
    expect(prisma.enterpriseFundingSnapshot.upsert).not.toHaveBeenCalled();
    const sql = rawLockSql(prisma).find((text) => text.includes('funding-snapshot-upsert'));
    expect(sql).toBeDefined();
    expect(sql).toContain('INSERT INTO "enterprise_funding_snapshots"');
    expect(sql).toContain('ON CONFLICT');
    expect(sql).toContain('GROUP BY');
    expect(sql).toContain('ENTERPRISE_CREDIT');
    expect(sql).toContain('funding_classification_complete');
    expect(sql).toContain('approved_credit_usd');
    expect(sql).toContain('unapproved_debt_usd');
    expect(sql).toContain('LEFT JOIN');
    expect(sql).not.toContain('funding-outstanding-remaining');
    expect(sql).not.toContain('funding-outstanding-incomplete');
    expect(sql).not.toMatch(/\bIN\s*\(/);
    expect(rawLockSql(prisma).filter((text) => text.includes('funding-snapshot-upsert'))).toHaveLength(1);
  });

  it('指定账户时用 ANY 收口，不拼 IN 列表', async () => {
    const { service, prisma } = buildService();
    const fallback = prisma.$queryRaw.getMockImplementation();
    prisma.$queryRaw.mockImplementation(async (parts: unknown, ...values: unknown[]) => {
      const sql = rawSqlText(parts);
      if (sql.includes('funding-snapshot-upsert')) {
        return [{ billing_account_id: 'ba-1' }];
      }
      return fallback ? fallback(parts, ...values) : [];
    });

    const processed = await service.refreshFundingSnapshots(['ba-1', 'ba-1', '']);

    expect(processed).toBe(1);
    expect(prisma.enterpriseFundingSnapshot.upsert).not.toHaveBeenCalled();
    const sql = rawLockSql(prisma).find((text) => text.includes('funding-snapshot-upsert'));
    expect(sql).toContain('ANY');
    expect(sql).not.toMatch(/\bIN\s*\(/);
    const bound = prisma.$queryRaw.mock.calls.find((args: unknown[]) => (
      rawSqlText(args[0], ...args.slice(1)).includes('funding-snapshot-upsert')
    ));
    expect(JSON.stringify(bound)).toContain('ba-1');
  });

  it('空账户列表不写库', async () => {
    const { service, prisma } = buildService();

    const processed = await service.refreshFundingSnapshots(['', '']);

    expect(processed).toBe(0);
    expect(prisma.enterpriseFundingSnapshot.upsert).not.toHaveBeenCalled();
    expect(rawLockSql(prisma).some((text) => text.includes('funding-snapshot-upsert'))).toBe(false);
  });
});
