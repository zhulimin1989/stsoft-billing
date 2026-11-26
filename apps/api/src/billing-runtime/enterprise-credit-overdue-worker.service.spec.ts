import { Prisma } from '@prisma/client';
import { ConfigService } from '@nestjs/config';
import { EnterpriseCreditOverdueWorkerService } from './enterprise-credit-overdue-worker.service';
import {
  billingDebtOpenOldestAgeSeconds,
  billingDebtOpenRestrictionsActive,
  enterpriseCreditEnforcementEarliestSeconds,
  enterpriseCreditOverdueAccounts,
  enterpriseCreditOverdueSuspendTotal,
} from '../metrics/metrics.registry';

const DAY_MS = 24 * 60 * 60 * 1000;
const ACCOUNT_ID = 'ba_ent_1';
const POLICY_CLOCK_MS = Date.parse('2026-08-06T12:00:00.000Z');

// Production makes the overdue decision against PostgreSQL clock_timestamp().
// Keep every due-date fixture relative to that mocked database clock, never the test runner clock.
function atPolicyClock(offsetMs = 0): Date {
  return new Date(POLICY_CLOCK_MS + offsetMs);
}

function makeConfigRow(overrides: Record<string, unknown> = {}) {
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
    ...overrides,
  };
}

function makePrisma() {
  const prisma: any = {
    balanceConsumptionAllocation: {
      findMany: jest.fn().mockResolvedValue([]),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    billingAccountCreditConfig: {
      findMany: jest.fn().mockResolvedValue([]),
      findUnique: jest.fn().mockResolvedValue(makeConfigRow()),
      update: jest.fn(),
    },
    billingAccountCreditEvent: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    alertEvent: {
      create: jest.fn().mockResolvedValue({ id: 'alert-1' }),
    },
    // 授信恢复解限：候选集来自关闸表，默认空 ⇒ 兜底那段不做任何事。
    billingAccessRestriction: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    __policyRecoveries: [] as Array<{
      id: string;
      billingAccountId: string;
      policyRevision: number;
    }>,
    __walletBalanceUsd: new Prisma.Decimal(-10),
  };
  let configRow: any = makeConfigRow();
  let eventRow: any = null;
  prisma.billingAccountCreditConfig.findUnique.mockImplementation(async () => configRow);
  prisma.billingAccountCreditConfig.update.mockImplementation(async ({ data }: any) => {
    configRow = { ...configRow, ...data };
    return configRow;
  });
  prisma.billingAccountCreditEvent.create.mockImplementation(async ({ data }: any) => {
    eventRow = { id: 'credit-event-1', ...data };
    return eventRow;
  });
  prisma.billingAccountCreditEvent.findUnique.mockImplementation(async () => eventRow);
  prisma.billingAccountCreditEvent.updateMany.mockImplementation(async ({ data }: any) => {
    if (!eventRow) return { count: 0 };
    eventRow = { ...eventRow, ...data };
    return { count: 1 };
  });
  prisma.__setConfigRow = (row: any) => {
    configRow = row;
  };
  prisma.__getConfigRow = () => configRow;
  prisma.__setEventRow = (row: any) => {
    eventRow = row;
  };
  prisma.__getEventRow = () => eventRow;
  prisma.$queryRaw = jest.fn(async (parts: TemplateStringsArray | unknown) => {
    const sql = Array.isArray(parts) ? parts.join(' ') : String(parts);
    if (
      sql.includes('FROM "billing_account_credit_events" event')
      && sql.includes('INNER JOIN "billing_account_credit_configs" config')
    ) {
      return prisma.__policyRecoveries;
    }
    if (sql.includes('clock_timestamp()') && sql.includes('policyClock')) {
      return [{
        policyClock: atPolicyClock(sql.includes("INTERVAL '1 millisecond'") ? 1 : 0),
      }];
    }
    if (sql.includes('FROM "account_wallets"')) {
      return [{ walletBalanceUsd: prisma.__walletBalanceUsd }];
    }
    if (sql.includes('FROM "billing_accounts"')) {
      return [{ id: ACCOUNT_ID }];
    }
    return [];
  });
  prisma.$transaction = jest.fn(async (fn: any) => fn(prisma));
  return prisma;
}

function makeRedis() {
  return {
    set: jest.fn().mockResolvedValue('OK'),
    eval: jest.fn().mockResolvedValue(1),
  };
}

function buildWorker(prismaOverrides: Record<string, unknown> = {}) {
  const prisma = makePrisma();
  Object.assign(prisma, prismaOverrides);
  const billing = {
    sweepEnterpriseCreditResidualSettlement: jest.fn().mockResolvedValue(0),
    releasePolicyRestoredGatewayBalanceDebtRestrictions: jest.fn().mockResolvedValue(0),
  };
  const publisherSync = {
    syncBillingAccountKeyBalances: jest.fn().mockResolvedValue(undefined),
  };
  const redis = makeRedis();
  const config = { get: jest.fn().mockReturnValue(undefined) } as unknown as ConfigService;
  const worker = new EnterpriseCreditOverdueWorkerService(
    prisma as any,
    billing as any,
    publisherSync as any,
    redis as any,
    config,
  );
  return { worker, prisma, billing, publisherSync, redis, config };
}

describe('EnterpriseCreditOverdueWorkerService', () => {
  it('suspends credit when oldest unsettled allocation exceeds termsDays', async () => {
    const { worker, prisma, publisherSync } = buildWorker();
    prisma.billingAccountCreditConfig.findMany.mockResolvedValue([
      { billingAccountId: ACCOUNT_ID, termsDays: 30, limitUsd: new Prisma.Decimal(100), expiresAt: null },
    ]);
    prisma.balanceConsumptionAllocation.findFirst.mockResolvedValue({
      createdAt: atPolicyClock(-31 * DAY_MS),
    });

    const result = await worker.runOnce('test');

    expect(result.suspended).toBe(1);
    expect(prisma.billingAccountCreditConfig.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { billingAccountId: ACCOUNT_ID },
        data: expect.objectContaining({
          status: 'SUSPENDED',
          policyRevision: 1,
          policyBoundaryComplete: false,
        }),
      }),
    );
    expect(prisma.billingAccountCreditEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          oldStatus: 'ACTIVE',
          newStatus: 'SUSPENDED',
          oldEffectiveAt: null,
          newEffectiveAt: null,
          temporalSnapshotComplete: true,
          policyRevision: 1,
          policyDecisionAt: atPolicyClock(),
          policyBoundaryComplete: false,
          reason: 'overdue_auto_suspend',
          actorId: 'system:credit-overdue',
        }),
      }),
    );
    expect(prisma.billingAccountCreditEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ policyRevision: 1, policyBoundaryComplete: false }),
        data: expect.objectContaining({ policyBoundaryComplete: true }),
      }),
    );
    expect(prisma.$transaction).toHaveBeenCalledTimes(2);
    const lockSql = prisma.$queryRaw.mock.calls.map(([parts]: [TemplateStringsArray | unknown]) => (
      Array.isArray(parts) ? parts.join(' ') : String(parts)
    )).filter((sql: string) => (
      sql.includes('FROM "account_wallets"') || sql.includes('FROM "billing_accounts"')
    ));
    expect(lockSql[0]).toContain('FROM "account_wallets"');
    expect(lockSql[1]).toContain('FROM "billing_accounts"');
    expect(publisherSync.syncBillingAccountKeyBalances).toHaveBeenCalledWith(ACCOUNT_ID);
  });

  it('does not report suspension complete or fanout when post-commit boundary confirmation fails', async () => {
    const { worker, prisma, publisherSync } = buildWorker();
    prisma.billingAccountCreditConfig.findMany.mockResolvedValue([
      { billingAccountId: ACCOUNT_ID, termsDays: 30, limitUsd: new Prisma.Decimal(100), expiresAt: null },
    ]);
    prisma.balanceConsumptionAllocation.findFirst.mockResolvedValue({
      createdAt: atPolicyClock(-31 * DAY_MS),
    });
    prisma.billingAccountCreditEvent.updateMany.mockResolvedValue({ count: 0 });

    const result = await worker.runOnce('confirm-failure');

    expect(result).toEqual(expect.objectContaining({ suspended: 0, failed: 1 }));
    expect(publisherSync.syncBillingAccountKeyBalances).not.toHaveBeenCalled();
  });

  it('does not suspend when debt is within terms', async () => {
    const { worker, prisma } = buildWorker();
    prisma.billingAccountCreditConfig.findMany.mockResolvedValue([
      { billingAccountId: ACCOUNT_ID, termsDays: 30, limitUsd: new Prisma.Decimal(100), expiresAt: null },
    ]);
    prisma.balanceConsumptionAllocation.findFirst.mockResolvedValue({
      createdAt: atPolicyClock(-5 * DAY_MS),
    });

    const result = await worker.runOnce('test');

    expect(result.suspended).toBe(0);
    expect(prisma.billingAccountCreditConfig.update).not.toHaveBeenCalled();
  });

  it('uses the allocation frozen due date instead of the current credit terms', async () => {
    const { worker, prisma } = buildWorker();
    prisma.billingAccountCreditConfig.findMany.mockResolvedValue([
      { billingAccountId: ACCOUNT_ID, termsDays: null, limitUsd: new Prisma.Decimal(100), expiresAt: null },
    ]);
    prisma.balanceConsumptionAllocation.findFirst.mockImplementation(({ where }: any) => (
      where.creditPolicySnapshotComplete === true
        ? Promise.resolve({
            createdAt: atPolicyClock(-8 * DAY_MS),
            creditTermsDays: 7,
            creditDueAt: atPolicyClock(-DAY_MS),
          })
        : Promise.resolve(null)
    ));

    const result = await worker.runOnce('test');

    expect(result.suspended).toBe(1);
    expect(prisma.billingAccountCreditConfig.update).toHaveBeenCalledWith(
      expect.objectContaining({ data: expect.objectContaining({ status: 'SUSPENDED' }) }),
    );
  });

  it('re-checks status inside the transaction and skips when no longer ACTIVE', async () => {
    const { worker, prisma } = buildWorker();
    prisma.billingAccountCreditConfig.findMany.mockResolvedValue([
      { billingAccountId: ACCOUNT_ID, termsDays: 30, limitUsd: new Prisma.Decimal(100), expiresAt: null },
    ]);
    prisma.balanceConsumptionAllocation.findFirst.mockResolvedValue({
      createdAt: atPolicyClock(-31 * DAY_MS),
    });
    // 管理端并发把状态改成了 DISABLED——事务内复核后不得覆盖。
    prisma.billingAccountCreditConfig.findUnique.mockResolvedValue(
      makeConfigRow({ status: 'DISABLED' }),
    );

    const result = await worker.runOnce('test');

    expect(result.suspended).toBe(0);
    expect(prisma.billingAccountCreditConfig.update).not.toHaveBeenCalled();
    expect(prisma.billingAccountCreditEvent.create).not.toHaveBeenCalled();
  });

  it('runs residual settlement sweep before overdue checks', async () => {
    const { worker, prisma, billing } = buildWorker();
    prisma.balanceConsumptionAllocation.findMany.mockResolvedValue([
      { billingAccountId: ACCOUNT_ID },
    ]);
    billing.sweepEnterpriseCreditResidualSettlement.mockResolvedValue(1234);

    const result = await worker.runOnce('test');

    expect(billing.sweepEnterpriseCreditResidualSettlement).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(result.residualSettledAccounts).toBe(1);
  });

  it('recovers the current admin policy boundary and durable fanout regardless of event reason', async () => {
    const { worker, prisma, publisherSync } = buildWorker();
    const event = {
      id: 'credit-event-admin-3',
      billingAccountId: ACCOUNT_ID,
      policyRevision: 3,
      temporalSnapshotComplete: true,
      policyDecisionAt: new Date('2026-08-06T11:59:59.000Z'),
      policyEffectiveBoundaryAt: null,
      policyBoundaryComplete: false,
      policyFanoutEnqueuedAt: null,
      reason: 'admin_credit_decrease',
    };
    prisma.__setConfigRow(makeConfigRow({
      policyRevision: 3,
      policyEffectiveBoundaryAt: null,
      policyBoundaryComplete: false,
    }));
    prisma.__setEventRow(event);
    prisma.__policyRecoveries = [{
      id: event.id,
      billingAccountId: ACCOUNT_ID,
      policyRevision: 3,
    }];

    const result = await worker.runOnce('policy-recovery');

    expect(result).toEqual(expect.objectContaining({ scanned: 1, failed: 0 }));
    expect(prisma.billingAccountCreditEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: event.id, policyRevision: 3 }),
        data: expect.objectContaining({ policyBoundaryComplete: true }),
      }),
    );
    expect(publisherSync.syncBillingAccountKeyBalances).toHaveBeenCalledWith(ACCOUNT_ID);
    expect(prisma.billingAccountCreditEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: event.id,
          policyRevision: 3,
          policyFanoutEnqueuedAt: null,
        }),
        data: { policyFanoutEnqueuedAt: expect.any(Date) },
      }),
    );
    const recoverySql = prisma.$queryRaw.mock.calls
      .map(([parts]: [TemplateStringsArray | unknown]) => (
        Array.isArray(parts) ? parts.join(' ') : String(parts)
      ))
      .find((sql: string) => sql.includes('INNER JOIN "billing_account_credit_configs" config'));
    expect(recoverySql).toContain('config."policy_revision" = event."policy_revision"');
  });

  it('does not back-project or fan out a revision that stopped being current after the scan', async () => {
    const { worker, prisma, publisherSync } = buildWorker();
    prisma.__setConfigRow(makeConfigRow({
      policyRevision: 4,
      policyEffectiveBoundaryAt: new Date('2026-08-06T12:00:02.000Z'),
      policyBoundaryComplete: true,
    }));
    prisma.__setEventRow({
      id: 'credit-event-old-3',
      billingAccountId: ACCOUNT_ID,
      policyRevision: 3,
      temporalSnapshotComplete: true,
      policyDecisionAt: new Date('2026-08-06T11:59:58.000Z'),
      policyEffectiveBoundaryAt: new Date('2026-08-06T11:59:59.000Z'),
      policyBoundaryComplete: true,
      policyFanoutEnqueuedAt: null,
    });
    prisma.__policyRecoveries = [{
      id: 'credit-event-old-3',
      billingAccountId: ACCOUNT_ID,
      policyRevision: 3,
    }];

    const result = await worker.runOnce('stale-after-scan');

    expect(result).toEqual(expect.objectContaining({ scanned: 1, failed: 0 }));
    expect(prisma.billingAccountCreditConfig.update).not.toHaveBeenCalled();
    expect(publisherSync.syncBillingAccountKeyBalances).not.toHaveBeenCalled();
  });

  it('re-reads the locked wallet and does not suspend an account repaid after prefilter', async () => {
    const { worker, prisma, publisherSync } = buildWorker();
    prisma.billingAccountCreditConfig.findMany.mockResolvedValue([
      { billingAccountId: ACCOUNT_ID },
    ]);
    prisma.__walletBalanceUsd = new Prisma.Decimal(0);
    prisma.balanceConsumptionAllocation.findFirst.mockResolvedValue({
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
    });

    const result = await worker.runOnce('wallet-repaid-after-prefilter');

    expect(result.suspended).toBe(0);
    expect(prisma.billingAccountCreditEvent.create).not.toHaveBeenCalled();
    expect(publisherSync.syncBillingAccountKeyBalances).not.toHaveBeenCalled();
  });

  it('re-reads current legacy terms under lock and skips when the due date was extended', async () => {
    const { worker, prisma } = buildWorker();
    prisma.billingAccountCreditConfig.findMany.mockResolvedValue([
      { billingAccountId: ACCOUNT_ID },
    ]);
    prisma.__setConfigRow(makeConfigRow({ termsDays: 60 }));
    prisma.balanceConsumptionAllocation.findFirst.mockImplementation(({ where }: any) => (
      where.creditPolicySnapshotComplete === false
        ? Promise.resolve({
            createdAt: new Date('2026-07-06T00:00:00.000Z'),
            creditTermsDays: null,
            creditDueAt: null,
          })
        : Promise.resolve(null)
    ));

    const result = await worker.runOnce('terms-extended-after-prefilter');

    expect(result.suspended).toBe(0);
    expect(prisma.billingAccountCreditEvent.create).not.toHaveBeenCalled();
  });

  it('re-reads allocations under lock and skips when the debt allocation was settled', async () => {
    const { worker, prisma } = buildWorker();
    prisma.billingAccountCreditConfig.findMany.mockResolvedValue([
      { billingAccountId: ACCOUNT_ID },
    ]);
    prisma.balanceConsumptionAllocation.findFirst.mockResolvedValue(null);

    const result = await worker.runOnce('allocation-settled-after-prefilter');

    expect(result.suspended).toBe(0);
    expect(prisma.billingAccountCreditEvent.create).not.toHaveBeenCalled();
  });

  it('leaves an unmarked event on Publisher failure and retries it on the next sweep', async () => {
    const { worker, prisma, publisherSync } = buildWorker();
    prisma.billingAccountCreditConfig.findMany.mockResolvedValue([
      { billingAccountId: ACCOUNT_ID },
    ]);
    prisma.balanceConsumptionAllocation.findFirst.mockResolvedValue({
      createdAt: new Date('2026-07-01T00:00:00.000Z'),
      creditTermsDays: 30,
      creditDueAt: null,
    });
    publisherSync.syncBillingAccountKeyBalances.mockRejectedValueOnce(
      new Error('publisher enumeration interrupted'),
    );

    const first = await worker.runOnce('publisher-failure');

    expect(first).toEqual(expect.objectContaining({ suspended: 0, failed: 1 }));
    expect(prisma.__getEventRow().policyBoundaryComplete).toBe(true);
    expect(prisma.__getEventRow().policyFanoutEnqueuedAt).toBeUndefined();

    prisma.billingAccountCreditConfig.findMany.mockResolvedValue([]);
    prisma.__policyRecoveries = [{
      id: prisma.__getEventRow().id,
      billingAccountId: ACCOUNT_ID,
      policyRevision: prisma.__getEventRow().policyRevision,
    }];
    const second = await worker.runOnce('publisher-recovery');

    expect(second).toEqual(expect.objectContaining({ scanned: 1, failed: 0 }));
    expect(publisherSync.syncBillingAccountKeyBalances).toHaveBeenCalledTimes(2);
    expect(prisma.__getEventRow().policyFanoutEnqueuedAt).toBeInstanceOf(Date);
  });

  it('defaults policy recovery to a 60 second SLO', () => {
    const { worker } = buildWorker();
    expect((worker as any).intervalMs()).toBe(60_000);
  });

  it('skips the sweep when the redis lock is held elsewhere', async () => {
    const { worker, prisma, redis } = buildWorker();
    redis.set.mockResolvedValue(null);

    const result = await worker.runOnce('test');

    expect(result.skipped).toBe(true);
    expect(prisma.billingAccountCreditConfig.findMany).not.toHaveBeenCalled();
  });

  // ---- 逾期护栏（2026-08-28 静默断服事故）----
  //
  // 事故形态：授信被自动挂起 → 43 秒后落一笔消费被判未批准欠款 → 3 秒后
  // debt_open 关闸 → 静默断服 6h32m。缺的是宽限期和「有人知道」。

  function overdueByOneDay(prisma: any): void {
    prisma.billingAccountCreditConfig.findMany.mockResolvedValue([
      { billingAccountId: ACCOUNT_ID, termsDays: 30, limitUsd: new Prisma.Decimal(100), expiresAt: null },
    ]);
    // 发生于 31 天前 + 账期 30 天 ⇒ 到期日正好是数据库时钟的 1 天前。
    prisma.balanceConsumptionAllocation.findFirst.mockResolvedValue({
      createdAt: atPolicyClock(-31 * DAY_MS),
    });
  }

  async function suspendOutcomeCount(outcome: string): Promise<number> {
    const metric = await enterpriseCreditOverdueSuspendTotal.get();
    return metric.values.find((value) => value.labels.outcome === outcome)?.value ?? 0;
  }

  it('keeps the pre-grace behaviour when no grace is configured', async () => {
    const { worker, prisma } = buildWorker();
    overdueByOneDay(prisma);

    const result = await worker.runOnce('test');

    // 默认 0：与这个变量存在之前逐位一致，上线不改变任何账户的命运。
    expect(result.suspended).toBe(1);
  });

  it('defers suspension while the overdue account is inside the grace window', async () => {
    const { worker, prisma, config, publisherSync } = buildWorker();
    overdueByOneDay(prisma);
    // 已逾期 1 天，宽限 72 小时 ⇒ 还不该断服。
    (config.get as jest.Mock).mockImplementation((key: string) =>
      key === 'ENTERPRISE_CREDIT_OVERDUE_GRACE_HOURS' ? '72' : undefined);
    const deferredBefore = await suspendOutcomeCount('deferred_by_grace');

    const result = await worker.runOnce('test');

    expect(result.suspended).toBe(0);
    expect(prisma.billingAccountCreditConfig.update).not.toHaveBeenCalled();
    expect(prisma.billingAccountCreditEvent.create).not.toHaveBeenCalled();
    // 宽限期内不得投影额度变化，否则网关会以为授信还在正常状态之外被动过。
    expect(publisherSync.syncBillingAccountKeyBalances).not.toHaveBeenCalled();
    // 催收窗口必须可观测 —— 否则宽限期只是把断服往后挪，没人知道。
    expect(await suspendOutcomeCount('deferred_by_grace')).toBe(deferredBefore + 1);
  });

  it('suspends once the grace window has also elapsed, recording both dates', async () => {
    const { worker, prisma, config } = buildWorker();
    overdueByOneDay(prisma);
    // 已逾期 1 天，宽限 12 小时 ⇒ 宽限也过了。
    (config.get as jest.Mock).mockImplementation((key: string) =>
      key === 'ENTERPRISE_CREDIT_OVERDUE_GRACE_HOURS' ? '12' : undefined);

    const result = await worker.runOnce('test');

    expect(result.suspended).toBe(1);
    const note: string = prisma.billingAccountCreditEvent.create.mock.calls[0][0].data.note;
    // 合同到期日与服务挂起日必须都在审计里，且必须是不同的时刻 ——
    // 只记一个会让客户和销售看到互相矛盾的日期。
    expect(note).toContain(atPolicyClock(-1 * DAY_MS).toISOString());
    expect(note).toContain(atPolicyClock(-1 * DAY_MS + 12 * 60 * 60 * 1000).toISOString());
  });

  it.each([['-5'], ['0'], ['abc'], ['']])(
    'falls back to no grace for the invalid value %p rather than widening it',
    async (raw) => {
      const { worker, prisma, config } = buildWorker();
      overdueByOneDay(prisma);
      (config.get as jest.Mock).mockImplementation((key: string) =>
        key === 'ENTERPRISE_CREDIT_OVERDUE_GRACE_HOURS' ? raw : undefined);

      const result = await worker.runOnce('test');

      // 关键：非法值绝不能被解释成「无限宽限」，那等于静默关掉逾期风控。
      expect(result.suspended).toBe(1);
    },
  );

  it('writes an alert_events row so a suspension is not silent', async () => {
    const { worker, prisma } = buildWorker();
    overdueByOneDay(prisma);

    await worker.runOnce('test');

    expect(prisma.alertEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          category: 'SYSTEM',
          severity: 'HIGH',
          sourceType: 'billing_account_credit_event',
          sourceId: 'credit-event-1',
        }),
      }),
    );
    const context = JSON.parse(prisma.alertEvent.create.mock.calls[0][0].data.context);
    expect(context).toEqual(expect.objectContaining({
      billingAccountId: ACCOUNT_ID,
      creditEventId: 'credit-event-1',
      graceHours: 0,
    }));
  });

  it('never lets a failed alert write undo a committed suspension', async () => {
    const { worker, prisma } = buildWorker();
    overdueByOneDay(prisma);
    prisma.alertEvent.create.mockRejectedValue(new Error('alert_events unavailable'));

    const result = await worker.runOnce('test');

    // 挂起已提交并 fanout 完成，告警是旁路 —— 写失败不该把一次成功的风控动作变成失败。
    expect(result.suspended).toBe(1);
    expect(result.failed).toBe(0);
  });

  it('publishes the customer-visible outage clock from ACTIVE debt_open restrictions', async () => {
    const { worker, prisma } = buildWorker();
    const oldest = new Date(Date.now() - 6 * 60 * 60 * 1000);
    const original = prisma.$queryRaw.getMockImplementation()!;
    prisma.$queryRaw.mockImplementation(async (parts: any, ...rest: any[]) => {
      const sql = Array.isArray(parts) ? parts.join(' ') : String(parts);
      if (sql.includes('FROM "billing_access_restrictions"')) {
        return [{ active: BigInt(3), oldest }];
      }
      return original(parts, ...rest);
    });

    await worker.runOnce('test');

    expect((await billingDebtOpenRestrictionsActive.get()).values[0].value).toBe(3);
    const age = (await billingDebtOpenOldestAgeSeconds.get()).values[0].value;
    expect(age).toBeGreaterThanOrEqual(6 * 60 * 60 - 5);
  });

  // ---- Q4：兜底解封的位置（挂起之后、观测之前）----
  it('never releases in the same sweep that just suspended the account', async () => {
    const { worker, prisma, billing } = buildWorker();
    overdueByOneDay(prisma);
    // 该账户同时是「本轮会被挂起」和「正被 debt_open 关闸」——
    // 如果兜底解封排在挂起之前，就会出现「刚挂起又被自己解封」的抖动。
    prisma.billingAccessRestriction.findMany.mockResolvedValue([
      { billingAccountId: ACCOUNT_ID },
    ]);

    const result = await worker.runOnce('test');

    expect(result.suspended).toBe(1);
    // 解封仍会被调用（幂等、判据全部重读），但顺序必须在挂起之后：
    // 挂起把 config 翻成 SUSPENDED，解封方法重读后自然不放行。
    const suspendOrder = prisma.billingAccountCreditConfig.update
      .mock.invocationCallOrder[0];
    const releaseOrder = billing.releasePolicyRestoredGatewayBalanceDebtRestrictions
      .mock.invocationCallOrder[0];
    expect(suspendOrder).toBeLessThan(releaseOrder);
  });

  // ---- Q3：兜底解封失败不得吞掉，必须计入 failed ----
  it('counts a failed fallback release instead of swallowing it', async () => {
    const { worker, prisma, billing } = buildWorker();
    prisma.billingAccountCreditConfig.findMany.mockResolvedValue([]);
    prisma.billingAccessRestriction.findMany.mockResolvedValue([
      { billingAccountId: ACCOUNT_ID },
    ]);
    billing.releasePolicyRestoredGatewayBalanceDebtRestrictions
      .mockRejectedValue(new Error('release exploded'));

    const result = await worker.runOnce('test');

    // 与管理端那个触发点刻意不同：那边是 best-effort（授信变更已提交，
    // 不该因解封失败而报错，靠 worker 重试）；worker 这边是最后一道，
    // 失败必须可见，否则客户会一直断服而没人知道。
    expect(result.failed).toBe(1);
    expect(result.policyRestoredReleases).toBe(0);
  });

  it('reports every overdue phase each sweep so a cleared alert stops firing', async () => {
    const { worker, prisma } = buildWorker();
    const original = prisma.$queryRaw.getMockImplementation()!;
    prisma.$queryRaw.mockImplementation(async (parts: any, ...rest: any[]) => {
      const sql = Array.isArray(parts) ? parts.join(' ') : String(parts);
      if (sql.includes('WITH acct AS')) {
        return [
          { dueAt: new Date(Date.now() - DAY_MS) },      // enforceable
          { dueAt: new Date(Date.now() + 0.5 * DAY_MS) }, // due_1d
          { dueAt: new Date(Date.now() + 2 * DAY_MS) },   // due_3d
          { dueAt: new Date(Date.now() + 5 * DAY_MS) },   // due_7d
          { dueAt: new Date(Date.now() + 60 * DAY_MS) },  // 不入档
          { dueAt: null },                                 // 无到期日，忽略
        ];
      }
      return original(parts, ...rest);
    });

    await worker.runOnce('test');

    const byPhase = (await enterpriseCreditOverdueAccounts.get()).values
      .reduce<Record<string, number>>((acc, v) => {
        acc[String(v.labels.phase)] = v.value;
        return acc;
      }, {});
    expect(byPhase).toEqual(
      expect.objectContaining({ enforceable: 1, due_1d: 1, due_3d: 1, due_7d: 1 }),
    );
    // 最近的那个已经过期一天 ⇒ 负值。
    expect((await enterpriseCreditEnforcementEarliestSeconds.get()).values[0].value)
      .toBeLessThan(0);
  });
});
