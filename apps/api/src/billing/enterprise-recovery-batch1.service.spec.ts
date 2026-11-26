import { Prisma } from '@prisma/client';
import { EnterpriseAccountService } from './enterprise-account.service';
import { EnterpriseRecoveryFanoutService } from './enterprise-recovery-fanout.service';

/**
 * 议题二批一：墓碑屏障 / 复合回收 / hazards 分页 / fanout worker 的单测。
 * 设计依据：me/payg-multiplier-verify-timeout-v2.md §2.2b。
 *
 * 说明：这些是 mock 级单测，覆盖**契约与分支**（屏障是否生效、分页是否漏行/重复、
 * lease CAS 是否挡住迟到 worker）。真实并发/死锁/整笔回滚需 PostgreSQL 集成测试，
 * 已列入设计稿的阻断验收清单，随集成环境补。
 */

const ACCOUNT_ID = 'acct-1';
const VERIFICATION_ID = 'ver-1';

type AnyFn = jest.Mock;

function buildEnterpriseService(overrides: {
  /** 回收时枚举到的账户行。 */
  recoverableAccounts?: Array<Record<string, unknown>>;
  /** 绑在该账户名下的 tenant 行（回收要全量 detach）。 */
  boundTenants?: Array<{ id: string }>;
  tombstoneRows?: unknown[];
  existingAccount?: Record<string, unknown> | null;
} = {}) {
  // 按 SQL 内容分派：锁 wallet / 锁 account / 查墓碑三类读走不同返回，
  // 否则单一返回值会让 lockExistingEnterpriseAccount 误判"钱包未开户"。
  const tx = {
    $queryRaw: jest.fn(async (q: any) => {
      // ⚠️ 分派必须在**去掉 JSON 转义之后**匹配：标签模板的第一个参数就是片段数组，
      // JSON.stringify 会把 SQL 里的双引号变成 \" ⇒ 用带引号的表名（如 'FROM "billing_accounts"'）
      // 去 includes 永远匹配不上。既有用例走不到那一支，所以这个 bug 一直潜伏着；
      // 回收路径的用例一加就暴露了（lockEnterpriseAccountForRecovery 永远拿不到账户行 ⇒ 静默跳过）。
      const sql = JSON.stringify(q?.strings ?? q ?? '').replace(/\\"/g, '"');
      if (sql.includes('account_wallets')) return [{ balanceUsd: new Prisma.Decimal(0) }];
      if (sql.includes('enterprise_provisioning_tombstones')) return overrides.tombstoneRows ?? [];
      if (sql.includes('FROM "billing_accounts"')) return [{ id: ACCOUNT_ID }];
      if (sql.includes('FROM "tenants"')) {
        return [{ id: overrides.boundTenants?.[0]?.id ?? 'tenant-1' }];
      }
      return [];
    }),
    $executeRaw: jest.fn(async () => 1),
    billingAccount: {
      findFirst: jest.fn(async () => overrides.existingAccount ?? null),
      findMany: jest.fn(async (): Promise<Array<Record<string, unknown>>> => overrides.recoverableAccounts ?? []),
      create: jest.fn(async ({ data }: any) => ({ id: ACCOUNT_ID, ...data })),
      update: jest.fn(async ({ where, data }: any) => ({ id: where.id, ...data })),
      updateMany: jest.fn(async () => ({ count: 1 })),
    },
    accountWallet: { create: jest.fn(async () => ({})) },
    enterpriseBillMonthSummary: { create: jest.fn(async () => ({})) },
    billingAccountMember: {
      create: jest.fn(async () => ({})),
      updateMany: jest.fn(async () => ({ count: 2 })),
    },
    tenant: {
      findMany: jest.fn(async () => overrides.boundTenants ?? []),
      // ⚠️ owner 故意与账户 owner 不一致 —— 转让只改了「当前那一个」tenant 的 owner 之后，
      // 其余 tenant 就是这个形态。回收路径必须容忍它，否则墓碑会被一起回滚。
      findUnique: jest.fn(async ({ where }: any) => ({
        id: where.id,
        billingAccountId: ACCOUNT_ID,
        ownerUserId: 'someone-else',
      })),
      update: jest.fn(async () => ({})),
    },
    apiKey: { findMany: jest.fn(async () => []) },
    enterpriseRecoveryFanoutJob: { createMany: jest.fn(async () => ({ count: 0 })), updateMany: jest.fn(async () => ({ count: 1 })), groupBy: jest.fn(async () => []) },
  };
  const prisma = {
    $transaction: jest.fn(async (cb: any) => (typeof cb === 'function' ? cb(tx) : cb)),
    $queryRaw: jest.fn(async () => []),
    billingAccount: { findFirst: jest.fn(async () => null), findMany: jest.fn(async () => []) },
  };
  const billing = { syncTenantBalanceCacheForCurrentBinding: jest.fn(async () => undefined) };
  const publisherSync = { syncBillingAccountKeyBalances: jest.fn(async () => undefined) };
  const systemConfig = { getDeploymentConfig: jest.fn(async () => ({})) };
  const config = { get: jest.fn(() => undefined) };

  const service = new EnterpriseAccountService(
    // ⚠️ 顺序必须与真实构造函数一致：(prisma, publisherSync, billing, config, systemConfig)。
    // 先前 billing 与 publisherSync 传反了，被 `as any` 掩盖 —— 目前没有用例走到那两个依赖
    // 所以没炸，属定时炸弹：将来任何一条用例断言这两者的调用都会得到误导性结果。
    prisma as any, publisherSync as any, billing as any, config as any, systemConfig as any,
  );
  return { service, prisma, tx };
}

describe('批一 P0：owner 不一致的 tenant 不得把整笔回收（含墓碑）拖走', () => {
  it('绑定 tenant 的 owner 与账户 owner 不一致 ⇒ 回收照常完成，墓碑必须落地', async () => {
    // 修复前：detachTenantCore 在回收路径上仍断言 owner 一致 ⇒ 抛 409 ⇒ voidProvisioning
    // 整个事务回滚 ⇒ **墓碑 INSERT 一起没了** ⇒ 屏障未建立、状态停在 VOIDING，
    // 每次「继续作废」都撞同一行，而迟到的 createEnterpriseAccount 仍能建号。
    const { service, tx } = buildEnterpriseService({
      boundTenants: [{ id: 'tenant-1' }],
      recoverableAccounts: [{ id: ACCOUNT_ID, ownerUserId: 'owner-1', status: 'active' }],
      existingAccount: {
        id: ACCOUNT_ID, type: 'enterprise', ownerUserId: 'owner-1',
        status: 'active', provisioningQuarantinedAt: null,
      },
    });

    await expect(service.voidProvisioning({
      verificationId: VERIFICATION_ID,
      reason: 'void_application:op-1',
    })).resolves.toBeDefined();

    // 墓碑必须真的写了（它是权威屏障，账户压根没建成时也必须落）。
    const tombstoneSql = tx.$executeRaw.mock.calls
      .map((call: any[]) => JSON.stringify(call[0]?.strings ?? call[0] ?? ''))
      .join(' | ');
    expect(tombstoneSql).toContain('enterprise_provisioning_tombstones');
    // 且这一行 tenant 确实被解绑了（不是被跳过）。
    expect(tx.tenant.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'tenant-1' },
      data: { billingAccountId: null },
    }));
  });
});

describe('批一 P1：ALERTED 的 fanout 作业必须能被「继续作废」自己复位（不留人工动作）', () => {
  it('入队之前先把该 verification 下的 ALERTED 行复位成可领取，且与回收同事务', async () => {
    // 机制：唯一键 verificationId:kind:resource + ALERTED 是保留行的终态 ⇒ 永久占位；
    // createMany skipDuplicates 跳过、worker 只 claim PENDING ⇒ 重放看起来成功、实际永不执行，
    // 只能有人进库改状态 —— 与「不留运维手工动作」冲突。
    const { service, tx } = buildEnterpriseService({
      boundTenants: [{ id: 'tenant-1' }],
      recoverableAccounts: [{ id: ACCOUNT_ID, ownerUserId: 'owner-1', status: 'active' }],
      existingAccount: {
        id: ACCOUNT_ID, type: 'enterprise', ownerUserId: 'owner-1',
        status: 'active', provisioningQuarantinedAt: null,
      },
    });

    await service.voidProvisioning({
      verificationId: VERIFICATION_ID,
      reason: 'void_application:op-1',
    });

    expect(tx.enterpriseRecoveryFanoutJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { verificationId: VERIFICATION_ID, status: 'ALERTED' },
        data: expect.objectContaining({ status: 'PENDING', attempts: 0, leaseToken: null }),
      }),
    );
    // 顺序：复位必须早于入队，否则新插的行会被 ALERTED 占位挡掉。
    expect(tx.enterpriseRecoveryFanoutJob.updateMany.mock.invocationCallOrder[0])
      .toBeLessThan(tx.enterpriseRecoveryFanoutJob.createMany.mock.invocationCallOrder[0]);
    // 只复位 ALERTED —— DONE 行代表该资源已收敛，重放时本就该被跳过。
    const resetCall = tx.enterpriseRecoveryFanoutJob.updateMany.mock.calls[0] as unknown[];
    expect((resetCall[0] as { where: { status: string } }).where.status).toBe('ALERTED');
  });
  it('本次一个可锁账户都没有（例如账户已被物删）⇒ **仍然**复位 ALERTED', async () => {
    // ⚠️ 复位若被包在 `if (fanout.length > 0)` 里，这种情形就会漏 ——
    // 而「账户已消失、只剩卡住的 fanout」恰恰是最需要重跑的那一种。
    const { service, tx } = buildEnterpriseService({ recoverableAccounts: [] });

    await service.voidProvisioning({
      verificationId: VERIFICATION_ID,
      reason: 'void_application:op-1',
    });

    expect(tx.enterpriseRecoveryFanoutJob.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { verificationId: VERIFICATION_ID, status: 'ALERTED' },
        data: expect.objectContaining({ status: 'PENDING', lockedAt: null }),
      }),
    );
    // 没有账户 ⇒ 不该入队任何新作业。
    expect(tx.enterpriseRecoveryFanoutJob.createMany).not.toHaveBeenCalled();
  });

});

describe('批一屏障：createEnterpriseAccount 必须在事务内先查墓碑', () => {
  it('命中墓碑 ⇒ 409 enterprise_provisioning_tombstoned，且**连账户都不创建**', async () => {
    const { service, tx } = buildEnterpriseService({ tombstoneRows: [{ verificationId: VERIFICATION_ID }] });

    await expect(
      service.createEnterpriseAccount({
        userId: 'u1', verificationId: VERIFICATION_ID, enterpriseName: '甲', uscc: 'X1',
      } as any),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'enterprise_provisioning_tombstoned' }),
    });

    // 零账户窗口的核心：拒绝必须发生在 create 之前，否则新账户会带 NULL quarantine 落库。
    expect(tx.billingAccount.create).not.toHaveBeenCalled();
    expect(tx.accountWallet.create).not.toHaveBeenCalled();
  });

  it('先取 verification 咨询锁再查墓碑（与 void 互斥序列化的前提）', async () => {
    const { service, tx } = buildEnterpriseService({ tombstoneRows: [{ verificationId: VERIFICATION_ID }] });
    await service.createEnterpriseAccount({
      userId: 'u1', verificationId: VERIFICATION_ID, enterpriseName: '甲', uscc: 'X1',
    } as any).catch(() => undefined);

    const lockCall = (tx.$executeRaw as AnyFn).mock.calls[0];
    expect(JSON.stringify(lockCall)).toContain('pg_advisory_xact_lock');
  });

  it('新开户在同一事务里插入当月账单空行', async () => {
    const { service, tx } = buildEnterpriseService({ tombstoneRows: [] });
    (tx.billingAccount.findFirst as AnyFn).mockResolvedValueOnce(null);

    await service.createEnterpriseAccount({
      userId: 'u1', verificationId: VERIFICATION_ID, enterpriseName: '甲', uscc: 'X1',
    } as any);

    expect(tx.enterpriseBillMonthSummary.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        billingAccountId: ACCOUNT_ID,
        yearMonth: expect.stringMatching(/^\d{4}-\d{2}$/),
        pendingCents: 0,
        consumeCents: 0,
        paidCents: 0,
      }),
    });
  });

  it('既有账户已 quarantined ⇒ 不再返回「幂等成功」，改 409', async () => {
    const { service } = buildEnterpriseService({
      tombstoneRows: [],
      existingAccount: {
        id: ACCOUNT_ID, ownerUserId: 'u1', status: 'suspended',
        provisioningQuarantinedAt: new Date(),
      },
    });
    await expect(
      service.createEnterpriseAccount({
        userId: 'u1', verificationId: VERIFICATION_ID, enterpriseName: '甲', uscc: 'X1',
      } as any),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'enterprise_account_quarantined' }),
    });
  });
});

describe('批一：verificationId 在既有账户上不可变', () => {
  it('改 verificationId ⇒ 409 enterprise_verification_id_immutable', async () => {
    const { service, prisma } = buildEnterpriseService();
    (prisma.billingAccount.findFirst as AnyFn).mockResolvedValueOnce({ verificationId: 'ver-old' });

    await expect(
      service.updateEnterpriseSnapshot(ACCOUNT_ID, { verificationId: 'ver-new' } as any),
    ).rejects.toMatchObject({
      response: expect.objectContaining({ code: 'enterprise_verification_id_immutable' }),
    });
  });

  it('值未变 ⇒ 幂等通过（不因不可变规则误拦重放）', async () => {
    const { service, prisma } = buildEnterpriseService({
      existingAccount: {
        id: ACCOUNT_ID, type: 'enterprise', ownerUserId: 'u1', status: 'active',
        provisioningQuarantinedAt: null,
      },
    });
    (prisma.billingAccount.findFirst as AnyFn).mockResolvedValueOnce({ verificationId: 'ver-same' });

    // 只断言"不因不可变规则被拦"：后续完整视图重查涉及大量无关 mock，
    // 为它铺 mock 会让测试变成 mock 的镜像，而不是契约的检验。
    const err = await service
      .updateEnterpriseSnapshot(ACCOUNT_ID, { verificationId: 'ver-same' } as any)
      .then(() => null)
      .catch((e) => e);
    expect(err?.response?.code).not.toBe('enterprise_verification_id_immutable');
  });
});

describe('批一 fanout worker：lease 所有权 CAS', () => {
  function buildWorker(jobRow: Record<string, unknown> | null, casCount = 1) {
    const job = {
      findFirst: jest.fn(async () => jobRow),
      updateMany: jest.fn(async () => ({ count: casCount })),
    };
    const prisma = { enterpriseRecoveryFanoutJob: job };
    const publisherSync = {
      syncKeyBalanceByIdRequired: jest.fn(async () => undefined),
      syncBillingAccountKeyBalancesRequired: jest.fn(async () => undefined),
    };
    const billing = { syncTenantBalanceCacheForCurrentBinding: jest.fn(async () => undefined) };
    const config = { get: jest.fn(() => undefined) };
    const svc = new EnterpriseRecoveryFanoutService(
      prisma as any, publisherSync as any, billing as any, config as any,
    );
    return { svc, job, publisherSync };
  }

  const baseJob = {
    id: 'job-1', kind: 'KEY_BY_ID', accountId: null, tenantId: null,
    apiKeyId: 'key-1', attempts: 0, maxAttempts: 8,
  };

  it('被解绑 tenant 的 key 走 by-keyId 的 Required 原语（不是按 account 重算）', async () => {
    const { svc, publisherSync } = buildWorker(baseJob);
    await svc.drain(1);
    // account 版按「当前仍绑该账户的 tenant」查 key，detach 提交后查不到那些 key。
    expect(publisherSync.syncKeyBalanceByIdRequired).toHaveBeenCalledWith(
      'key-1', { deleteWhenMissing: true },
    );
    expect(publisherSync.syncBillingAccountKeyBalancesRequired).not.toHaveBeenCalled();
  });

  it('claim CAS 0 行（被抢先）⇒ 本轮不执行任何副作用', async () => {
    const { svc, publisherSync } = buildWorker(baseJob, 0);
    const r = await svc.drain(1);
    expect(publisherSync.syncKeyBalanceByIdRequired).not.toHaveBeenCalled();
    expect(r.processed).toBe(0);
  });

  it('终态写回带 lease_token 条件（迟到 worker 不得覆盖接管者）', async () => {
    const { svc, job } = buildWorker(baseJob);
    await svc.drain(1);
    const doneCall = (job.updateMany as AnyFn).mock.calls.at(-1)?.[0];
    expect(doneCall.where).toMatchObject({ id: 'job-1' });
    expect(doneCall.where.leaseToken).toBeTruthy();
    expect(doneCall.data.status).toBe('DONE');
  });

  it('达 max_attempts ⇒ ALERTED（不可再被 claim）', async () => {
    const { svc, job, publisherSync } = buildWorker({ ...baseJob, attempts: 7, maxAttempts: 8 });
    (publisherSync.syncKeyBalanceByIdRequired as AnyFn).mockRejectedValueOnce(new Error('publisher down'));
    await svc.drain(1);
    const failCall = (job.updateMany as AnyFn).mock.calls.at(-1)?.[0];
    expect(failCall.data.status).toBe('ALERTED');
    // claim 的 where 只取 status:'PENDING' ⇒ ALERTED 天然不可领取。
  });
});
describe('批一 P3：卡住的 fanout 必须从 /hazards 露出来（否则运营看不见）', () => {
  it('ALERTED 行按 kind 聚合出现在 stalledFanout 里', async () => {
    // ⚠️ ALERTED 的唯一出口是「再点一次继续作废」，而运营看不到 fanout 表。
    // 不从 hazards 露出来，就等于要求运营凭直觉知道该再点一次 —— 那是口口相传的手册。
    const prisma: any = {
      billingAccount: {
        findMany: jest.fn()
          .mockResolvedValueOnce([{
            id: ACCOUNT_ID, verificationId: VERIFICATION_ID, status: 'suspended',
            deletedAt: null, provisioningQuarantinedAt: new Date(),
            wallet: { balanceUsd: { toString: () => '0' } },
            tenants: [], members: [],
          }])
          .mockResolvedValueOnce([{ id: ACCOUNT_ID, verificationId: VERIFICATION_ID }]),
      },
      $queryRaw: jest.fn(async () => [{ verificationId: VERIFICATION_ID }]),
      enterpriseRecoveryFanoutJob: {
        groupBy: jest.fn(async () => [
          { verificationId: VERIFICATION_ID, kind: 'TENANT_CACHE', _count: { _all: 2 } },
          { verificationId: VERIFICATION_ID, kind: 'ACCOUNT', _count: { _all: 1 } },
        ]),
      },
    };
    const service = new EnterpriseAccountService(
      prisma as never, {} as never, {} as never,
      { get: () => undefined } as never, undefined as never,
    );

    const out = await service.listProvisioningHazards({ cursor: null }) as {
      items: Array<{ verificationId: string | null; stalledFanout: Array<{ kind: string; count: number }> }>;
    };

    expect(out.items).toHaveLength(1);
    // 按 kind 排序，保证 state_fingerprint 稳定。
    expect(out.items[0].stalledFanout).toEqual([
      { kind: 'ACCOUNT', count: 1 },
      { kind: 'TENANT_CACHE', count: 2 },
    ]);
  });

  it('没有 ALERTED 行时 stalledFanout 为空数组（不要给巡检制造假信号）', async () => {
    const prisma: any = {
      billingAccount: {
        findMany: jest.fn()
          .mockResolvedValueOnce([{
            id: ACCOUNT_ID, verificationId: VERIFICATION_ID, status: 'active',
            deletedAt: null, provisioningQuarantinedAt: null,
            wallet: null, tenants: [], members: [],
          }])
          .mockResolvedValueOnce([{ id: ACCOUNT_ID, verificationId: VERIFICATION_ID }]),
      },
      $queryRaw: jest.fn(async () => []),
      enterpriseRecoveryFanoutJob: { groupBy: jest.fn(async () => []) },
    };
    const service = new EnterpriseAccountService(
      prisma as never, {} as never, {} as never,
      { get: () => undefined } as never, undefined as never,
    );
    const out = await service.listProvisioningHazards({ cursor: null }) as {
      items: Array<{ stalledFanout: unknown[] }>;
    };
    expect(out.items[0].stalledFanout).toEqual([]);
  });
});

