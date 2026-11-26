import type { PrismaClient } from '@prisma/client';
import {
  bonusDiffFor,
  bonusIdemKey,
  grantRedisKey,
  loadTargets,
  migrateEntitlement,
  migrateGrantRedemptions,
  quotaIdemKey,
  runMigration,
  MIGRATION_SOURCE_BONUS,
  MIGRATION_SOURCE_QUOTA,
  type MigrationDeps,
  type MigrationTarget,
} from './tokenplan-0729-x50-migration';

const TARGET: MigrationTarget = {
  entitlementId: 'ent-1',
  userId: 'user-1',
  tenantId: 'tenant-1',
  planId: 'plan-lite',
  planName: '睿动-Lite',
  monthlyCredits: 1_750_000,
  billingPeriod: 'monthly',
};

function makeDeps(opts?: {
  balances?: { quota: number; bonus: number; grant: number };
  existingTxKeys?: string[];
  grantRows?: Array<{ id: string; userId: string; amount: number; usedAmount: number }>;
  lateRows?: Array<{ id: string; userId: string; amount: number; usedAmount: number }>;
  grantUpdateCount?: number;
  /** resume 重放 count=0 后重读到的行值（发散判定）。 */
  grantRowNow?: { amount: number; usedAmount: number } | null;
  entitlements?: Array<{ id: string; userId: string; tenantId: string; planId: string; billingPeriod?: string }>;
  plans?: Array<{ id: string; name: string; monthlyCredits: number }>;
  resetQuotaError?: Error;
  addBonusError?: Error;
  /** 幂等键命中但语义不符的流水（conflict 场景）。 */
  conflictTx?: { type: string; source: string; subscriptionId?: string; userId?: string; creditsAmount?: number };
  /** 末次 QUOTA_GRANT 金额（cohort 判别）。 */
  lastQuotaGrant?: number | null;
  /** 切点 bonusAfter（--cutoff 回溯）。 */
  bonusAfterAtCutoff?: number | null;
}) {
  const balances = opts?.balances ?? { quota: 20_000, bonus: 300, grant: 0 };
  const existing = new Set(opts?.existingTxKeys ?? []);
  const calls = {
    resetQuota: [] as unknown[][],
    addBonus: [] as unknown[][],
    redisDel: [] as string[],
    grantUpdates: [] as unknown[],
  };
  const prisma = {
    creditTransaction: {
      findUnique: jest.fn(async ({ where }: { where: { idempotencyKey: string } }) => {
        if (!existing.has(where.idempotencyKey)) return null;
        if (opts?.conflictTx) return opts.conflictTx;
        return where.idempotencyKey.includes(':bonus:')
          ? {
              type: 'BONUS_PURCHASE',
              source: 'migration:tokenplan-0729-x50-bonus',
              subscriptionId: 'ent-1',
              userId: 'user-1',
              creditsAmount: 14_700,
            }
          : {
              type: 'QUOTA_GRANT',
              source: 'migration:tokenplan-0729-x50',
              subscriptionId: 'ent-1',
              userId: 'user-1',
              creditsAmount: 1_750_000,
            };
      }),
      findFirst: jest.fn(async ({ where }: { where: { type?: string; createdAt?: unknown; NOT?: { source?: string } } }) => {
        if (where.type === 'QUOTA_GRANT') {
          // P0-1 回归断言：cohort 查询必须排除迁移自身 source
          expect(where.NOT?.source).toBe('migration:tokenplan-0729-x50');
          const amt = opts?.lastQuotaGrant;
          return amt === null ? null : { creditsAmount: amt ?? 20_000 };
        }
        const b = opts?.bonusAfterAtCutoff;
        return b === null ? null : { bonusAfter: b ?? 300 };
      }),
    },
    codingPlanEntitlement: {
      findMany: jest.fn(async () =>
        (opts?.entitlements ?? []).map((e) => ({ billingPeriod: 'monthly', ...e })),
      ),
    },
    plan: {
      findMany: jest.fn(async () => opts?.plans ?? []),
    },
    grantRedemption: {
      // 第一次=扫描，第二次=迁移窗口新增行复扫（lateRows 注入）
      findMany: jest
        .fn()
        .mockImplementationOnce(async () => opts?.grantRows ?? [])
        .mockImplementation(async () => [...(opts?.grantRows ?? []), ...(opts?.lateRows ?? [])]),
      updateMany: jest.fn(async (args: unknown) => {
        calls.grantUpdates.push(args);
        return { count: opts?.grantUpdateCount ?? 1 };
      }),
      findUnique: jest.fn(async () => opts?.grantRowNow ?? null),
    },
    creditBalanceState: { findMany: jest.fn(async () => []) },
    creditGrantRule: { findMany: jest.fn(async () => []) },
  } as unknown as PrismaClient;
  const deps: MigrationDeps = {
    prisma,
    credit: {
      getAuthoritativeBalances: jest.fn(async () => ({ ...balances, total: balances.quota + balances.bonus + balances.grant })),
      resetQuota: jest.fn(async (...args: unknown[]) => {
        if (opts?.resetQuotaError) throw opts.resetQuotaError;
        calls.resetQuota.push(args);
      }),
      addBonus: jest.fn(async (...args: unknown[]) => {
        if (opts?.addBonusError) throw opts.addBonusError;
        calls.addBonus.push(args);
      }),
      reconcileGrantPool: jest.fn(async (userId: string) => {
        calls.redisDel.push(userId); // 复用同一记录槽：此处代表"逐用户对账"调用
        return { userId, expected: 0, redis: 0, mismatched: false, fixed: true };
      }),
    },
    log: jest.fn(),
  };
  return { deps, calls };
}

describe('helpers', () => {
  it('bonusDiffFor：正余额补 ×49 差额，零/负不补', () => {
    expect(bonusDiffFor(300)).toBe(14_700);
    expect(bonusDiffFor(0)).toBe(0);
    expect(bonusDiffFor(-5)).toBe(0);
  });

  it('幂等键/缓存键格式稳定（重跑与对账依赖）', () => {
    expect(quotaIdemKey('e1')).toBe('migr:0729:x50:quota:e1');
    expect(bonusIdemKey('e1')).toBe('migr:0729:x50:bonus:e1');
    expect(grantRedisKey('u1')).toBe('credit:user:u1:grant');
  });
});

describe('migrateEntitlement', () => {
  it('dry-run：只读余额与幂等预检，不写任何东西', async () => {
    const { deps, calls } = makeDeps();
    const out = await migrateEntitlement(deps, TARGET, { execute: false, includeBonus: true });
    expect(out.quotaStatus).toBe('DRY_RUN');
    expect(out.bonusStatus).toBe('DRY_RUN');
    expect(out.before).toEqual({ quota: 20_000, bonus: 300, grant: 0 });
    expect(out.quotaTarget).toBe(1_750_000);
    expect(out.bonusDiff).toBe(14_700);
    expect(calls.resetQuota).toHaveLength(0);
    expect(calls.addBonus).toHaveLength(0);
  });

  it('execute：resetQuota 满额刷新到新 monthlyCredits + addBonus 补差额（源与幂等键正确）', async () => {
    const { deps, calls } = makeDeps();
    const out = await migrateEntitlement(deps, TARGET, { execute: true, includeBonus: true });
    expect(out.quotaStatus).toBe('MIGRATED');
    expect(out.bonusStatus).toBe('MIGRATED');
    expect(calls.resetQuota[0]).toEqual([
      'ent-1',
      'user-1',
      1_750_000,
      MIGRATION_SOURCE_QUOTA,
      { idempotencyKey: 'migr:0729:x50:quota:ent-1' },
    ]);
    expect(calls.addBonus[0]).toEqual([
      'ent-1',
      'user-1',
      14_700,
      MIGRATION_SOURCE_BONUS,
      { idempotencyKey: 'migr:0729:x50:bonus:ent-1' },
    ]);
  });

  it('execute：已有迁移流水（幂等预检命中）→ ALREADY_MIGRATED，不重复写', async () => {
    const { deps, calls } = makeDeps({
      existingTxKeys: ['migr:0729:x50:quota:ent-1', 'migr:0729:x50:bonus:ent-1'],
    });
    const out = await migrateEntitlement(deps, TARGET, { execute: true, includeBonus: true });
    expect(out.quotaStatus).toBe('ALREADY_MIGRATED');
    expect(out.bonusStatus).toBe('ALREADY_MIGRATED');
    expect(calls.resetQuota).toHaveLength(0);
    expect(calls.addBonus).toHaveLength(0);
  });

  it('execute：bonus=0 → SKIPPED_ZERO；未开 includeBonus → DISABLED', async () => {
    const { deps } = makeDeps({ balances: { quota: 5, bonus: 0, grant: 0 } });
    const out = await migrateEntitlement(deps, TARGET, { execute: true, includeBonus: true });
    expect(out.bonusStatus).toBe('SKIPPED_ZERO');
    const out2 = await migrateEntitlement(deps, TARGET, { execute: true, includeBonus: false });
    expect(out2.bonusStatus).toBe('DISABLED');
  });

  it('execute：resetQuota 抛错 → 本条 ERROR 带 message，不中断整体（由调用方继续下一条）', async () => {
    const { deps, calls } = makeDeps({ resetQuotaError: new Error('db down') });
    const out = await migrateEntitlement(deps, TARGET, { execute: true, includeBonus: true });
    expect(out.quotaStatus).toBe('ERROR');
    expect(out.error).toBe('db down');
    expect(calls.addBonus).toHaveLength(0); // quota 失败后不再动 bonus，留待重跑
  });

  it('cohort 冻结：末次 QUOTA_GRANT 已是新量级（变更后新购）→ ALREADY_NEW_SCALE，quota/bonus 全跳过防超发', async () => {
    const { deps, calls } = makeDeps({ lastQuotaGrant: 1_750_000, balances: { quota: 900_000, bonus: 500, grant: 0 } });
    const out = await migrateEntitlement(deps, TARGET, { execute: true, includeBonus: true });
    expect(out.quotaStatus).toBe('ALREADY_NEW_SCALE');
    expect(out.bonusStatus).toBe('ALREADY_NEW_SCALE');
    expect(calls.resetQuota).toHaveLength(0);
    expect(calls.addBonus).toHaveLength(0);
  });

  it('bonus 补偿基准=切点余额（--cutoff）：切点 400、现值 100（切点后按新价扣掉 300）→ 补 400×49', async () => {
    const { deps, calls } = makeDeps({
      balances: { quota: 20_000, bonus: 100, grant: 0 },
      bonusAfterAtCutoff: 400,
    });
    const out = await migrateEntitlement(deps, TARGET, {
      execute: true,
      includeBonus: true,
      cutoff: new Date('2026-07-29T10:00:00Z'),
    });
    expect(out.bonusAtCutoff).toBe(400);
    expect(out.bonusDiff).toBe(400 * 49);
    expect(calls.addBonus[0]?.[2]).toBe(19_600);
  });

  it('切点前无任何流水（cutoff 后才开的订阅但末次发放仍旧量级的极端态）→ 切点余额=0，bonus 不补', async () => {
    const { deps, calls } = makeDeps({ bonusAfterAtCutoff: null });
    const out = await migrateEntitlement(deps, TARGET, {
      execute: true,
      includeBonus: true,
      cutoff: new Date('2026-07-29T10:00:00Z'),
    });
    expect(out.bonusAtCutoff).toBe(0);
    expect(out.bonusStatus).toBe('SKIPPED_ZERO');
    expect(calls.addBonus).toHaveLength(0);
  });

  it('P0-1 回归：第一轮已 resetQuota（quotaDone），第二轮补跑 bonus → bonus 正常补发不被 ALREADY_NEW_SCALE 误跳', async () => {
    // 模拟：quota 迁移流水已存在；末次**业务** QUOTA_GRANT 仍是旧量级 20,000（迁移流水被 NOT source 排除）
    const { deps, calls } = makeDeps({ existingTxKeys: ['migr:0729:x50:quota:ent-1'] });
    const out = await migrateEntitlement(deps, TARGET, { execute: true, includeBonus: true });
    expect(out.quotaStatus).toBe('ALREADY_MIGRATED');
    expect(out.bonusStatus).toBe('MIGRATED'); // 关键：不是 ALREADY_NEW_SCALE
    expect(calls.addBonus).toHaveLength(1);
  });

  it('幂等键被非迁移流水占用 → IDEMPOTENCY_CONFLICT 标 ERROR；另一池独立继续（codex P1-4/P1-C）', async () => {
    const { deps, calls } = makeDeps({
      existingTxKeys: ['migr:0729:x50:quota:ent-1'],
      conflictTx: { type: 'CONSUME', source: 'gateway' },
    });
    const out = await migrateEntitlement(deps, TARGET, { execute: true, includeBonus: true });
    expect(out.quotaStatus).toBe('ERROR');
    expect(out.error).toContain('IDEMPOTENCY_CONFLICT');
    expect(calls.resetQuota).toHaveLength(0);
    // bonus 键未命中冲突 → 正常补发，不被 quota 冲突连坐
    expect(out.bonusStatus).toBe('MIGRATED');
    expect(calls.addBonus).toHaveLength(1);
  });

  it('同 type/source 但金额不符（配置又变过）→ conflict 而非 done（codex P1-C 全字段比对）', async () => {
    const { deps, calls } = makeDeps({
      existingTxKeys: ['migr:0729:x50:quota:ent-1'],
      conflictTx: {
        type: 'QUOTA_GRANT',
        source: 'migration:tokenplan-0729-x50',
        subscriptionId: 'ent-1',
        userId: 'user-1',
        creditsAmount: 999_999, // ≠ 当前 monthlyCredits 1,750,000
      },
    });
    const out = await migrateEntitlement(deps, TARGET, { execute: true, includeBonus: false });
    expect(out.quotaStatus).toBe('ERROR');
    expect(calls.resetQuota).toHaveLength(0);
  });

  it('bonus 差额溢出 PG Int → 该条 ERROR 不写库（codex P1-5）', async () => {
    const { deps, calls } = makeDeps({ balances: { quota: 1, bonus: 60_000_000, grant: 0 } });
    const out = await migrateEntitlement(deps, TARGET, { execute: true, includeBonus: true });
    expect(out.bonusStatus).toBe('ERROR');
    expect(out.error).toContain('Int 上限');
    expect(calls.addBonus).toHaveLength(0);
  });

  it('季付/年付 → regrantGap 标记（月度补发 cron 缺失 cohort，供另行补偿）', async () => {
    const { deps } = makeDeps();
    const out = await migrateEntitlement(
      deps,
      { ...TARGET, billingPeriod: 'quarterly' },
      { execute: false, includeBonus: false },
    );
    expect(out.regrantGap).toBe(true);
  });
});

describe('migrateGrantRedemptions', () => {
  const ROWS = [
    { id: 'g1', userId: 'user-1', amount: 100, usedAmount: 40 },
    { id: 'g2', userId: 'user-2', amount: 50, usedAmount: 0 },
  ];

  it('dry-run：只列出不 update；对账走 fix:false 只检不改', async () => {
    const { deps, calls } = makeDeps({ grantRows: ROWS });
    const out = await migrateGrantRedemptions(deps, ['user-1', 'user-2'], { execute: false });
    expect(out.rows.map((o) => o.status)).toEqual(['DRY_RUN', 'DRY_RUN']);
    expect(calls.grantUpdates).toHaveLength(0);
    expect(out.reconcile).toHaveLength(2);
    // fix:false（dry-run 不回写）
    expect((deps.credit.reconcileGrantPool as jest.Mock).mock.calls.every((c) => c[1]?.fix === false)).toBe(true);
  });

  it('execute：write-ahead journal 先于 updateMany（前值快照）+ ×50 + 全量 reconcile', async () => {
    const { deps, calls } = makeDeps({ grantRows: ROWS });
    const order: string[] = [];
    (deps.prisma.grantRedemption.updateMany as jest.Mock).mockImplementation(async (args: unknown) => {
      order.push('update');
      calls.grantUpdates.push(args);
      return { count: 1 };
    });
    const out = await migrateGrantRedemptions(deps, ['user-1', 'user-2'], {
      execute: true,
      onGrantWillMigrate: (r) => {
        order.push(`journal:${r.redemptionId}`);
        expect(r).toMatchObject({ amount: expect.any(Number), usedAmount: expect.any(Number) });
      },
    });
    expect(out.rows.map((o) => o.status)).toEqual(['MIGRATED', 'MIGRATED']);
    expect(order).toEqual(['journal:g1', 'update', 'journal:g2', 'update']); // P0-A：journal 恒在改库前
    expect(calls.grantUpdates[0]).toEqual({
      where: { id: 'g1', amount: 100, usedAmount: 40 },
      data: { amount: 5000, usedAmount: 2000 },
    });
    expect(calls.redisDel.sort()).toEqual(['user-1', 'user-2']);
    expect(out.reconcile.every((r) => r.status === 'OK')).toBe(true);
  });

  it('write-ahead journal 落盘抛错 → 致命中止（不吞、不标 ERROR 继续）——已改库无 journal 是唯一二次×50 态', async () => {
    const { deps, calls } = makeDeps({ grantRows: ROWS });
    await expect(
      migrateGrantRedemptions(deps, ['user-1'], {
        execute: true,
        onGrantWillMigrate: () => {
          throw new Error('ENOSPC');
        },
      }),
    ).rejects.toThrow('ENOSPC');
    expect(calls.grantUpdates).toHaveLength(0); // journal 失败前未动库
  });

  it('resume 重放：行仍为前值（journal 后崩溃）→ RESUME_APPLIED 补上；已×50 → SKIPPED_RESUME', async () => {
    const { deps, calls } = makeDeps({ grantRows: ROWS, grantRowNow: { amount: 2500, usedAmount: 0 } }); // g2=50/0 的×50 后值
    const um = deps.prisma.grantRedemption.updateMany as jest.Mock;
    um.mockImplementationOnce(async (args: unknown) => {
      calls.grantUpdates.push(args);
      return { count: 1 }; // g1 仍是前值 → 补上
    }).mockImplementationOnce(async () => ({ count: 0 })); // g2 已×50 → WHERE 不中
    const out = await migrateGrantRedemptions(deps, ['user-1', 'user-2'], {
      execute: true,
      onGrantWillMigrate: () => {},
      resumeGrantRows: new Map([
        ['g1', { amount: 100, usedAmount: 40 }],
        ['g2', { amount: 50, usedAmount: 0 }],
      ]),
    });
    expect(out.rows.find((o) => o.redemptionId === 'g1')?.status).toBe('RESUME_APPLIED');
    expect(out.rows.find((o) => o.redemptionId === 'g2')?.status).toBe('SKIPPED_RESUME');
    expect(calls.grantUpdates[0]).toEqual({
      where: { id: 'g1', amount: 100, usedAmount: 40 },
      data: { amount: 5000, usedAmount: 2000 },
    });
  });

  it('LATE_ROW：复扫发现迁移窗口内新增发放 → ERROR（发放/过期 worker 未停干净）', async () => {
    const { deps } = makeDeps({
      grantRows: [ROWS[0]],
      lateRows: [{ id: 'gLate', userId: 'user-1', amount: 10, usedAmount: 0 }],
    });
    const out = await migrateGrantRedemptions(deps, ['user-1'], { execute: true, onGrantWillMigrate: () => {} });
    const late = out.rows.find((o) => o.redemptionId === 'gLate');
    expect(late?.status).toBe('ERROR');
    expect(late?.error).toContain('LATE_ROW');
  });

  it('execute：乐观锁失配（count=0）→ RACE_SKIPPED；对账仍对全部目标用户跑（修复上轮残留）', async () => {
    const { deps, calls } = makeDeps({ grantRows: [ROWS[0]], grantUpdateCount: 0 });
    const out = await migrateGrantRedemptions(deps, ['user-1'], { execute: true, onGrantWillMigrate: () => {} });
    expect(out.rows[0].status).toBe('RACE_SKIPPED');
    expect(calls.redisDel).toEqual(['user-1']); // 全量对账，不再只对 touched
  });

  it('reconcile 抛错 → 该用户 ERROR（进 summary、CLI 非零退出），不被吞（codex P0-4）', async () => {
    const { deps } = makeDeps({ grantRows: [ROWS[0]] });
    (deps.credit.reconcileGrantPool as jest.Mock).mockRejectedValueOnce(new Error('redis down'));
    const out = await migrateGrantRedemptions(deps, ['user-1'], { execute: true, onGrantWillMigrate: () => {} });
    expect(out.reconcile[0]).toMatchObject({ userId: 'user-1', status: 'ERROR', error: 'redis down' });
  });

  it('×50 溢出 PG Int → 该行 ERROR 不写库（codex P1-5）', async () => {
    const { deps, calls } = makeDeps({
      grantRows: [{ id: 'gBig', userId: 'user-1', amount: 50_000_000, usedAmount: 0 }],
    });
    const out = await migrateGrantRedemptions(deps, ['user-1'], { execute: true, onGrantWillMigrate: () => {} });
    expect(out.rows[0].status).toBe('ERROR');
    expect(out.rows[0].error).toContain('Int 上限');
    expect(calls.grantUpdates).toHaveLength(0);
  });

  it('🔴 P0 回归·报告链式续跑：resume 行报告字段=journal 前值（非×50 后值），第二轮 resume 不再放大', async () => {
    // 第一轮已迁：行现值=×50 后（5000/2000），journal/上次报告前值=100/40
    const { deps } = makeDeps({
      grantRows: [{ id: 'g1', userId: 'user-1', amount: 5000, usedAmount: 2000 }],
      grantUpdateCount: 0, // WHERE 前值不中（行已×50）
      grantRowNow: { amount: 5000, usedAmount: 2000 },
    });
    const out = await migrateGrantRedemptions(deps, ['user-1'], {
      execute: true,
      onGrantWillMigrate: () => {},
      resumeGrantRows: new Map([['g1', { amount: 100, usedAmount: 40 }]]),
    });
    const row = out.rows[0];
    expect(row.status).toBe('SKIPPED_RESUME');
    // 关键断言：报告写回的是真实前值 100/40——用本报告做下一轮 resume，WHERE {amount:100} 对 5000 的行不可能命中
    expect(row.amountBefore).toBe(100);
    expect(row.usedBefore).toBe(40);
  });

  it('🔴 P1 回归·重放发散三态：count=0 且行值≠snapshot×50 → RESUME_DIVERGED ERROR（不静默漏迁）', async () => {
    const { deps } = makeDeps({
      grantRows: [{ id: 'g1', userId: 'user-1', amount: 130, usedAmount: 70 }], // RACE 后被并发改过的值
      grantUpdateCount: 0,
      grantRowNow: { amount: 130, usedAmount: 70 }, // ≠100×50/40×50
    });
    const out = await migrateGrantRedemptions(deps, ['user-1'], {
      execute: true,
      onGrantWillMigrate: () => {},
      resumeGrantRows: new Map([['g1', { amount: 100, usedAmount: 40 }]]),
    });
    expect(out.rows[0].status).toBe('ERROR');
    expect(out.rows[0].error).toContain('RESUME_DIVERGED');
  });

  it('execute 缺 onGrantWillMigrate → 直接拒绝（防绕过 write-ahead journal）', async () => {
    const { deps } = makeDeps({ grantRows: ROWS });
    await expect(migrateGrantRedemptions(deps, ['user-1'], { execute: true })).rejects.toThrow(
      'onGrantWillMigrate',
    );
  });

  it('bonus 幂等键同 type/source 但金额≠bonusDiff → conflict（cutoff 派生金额参与比对）', async () => {
    const { deps, calls } = makeDeps({
      existingTxKeys: ['migr:0729:x50:bonus:ent-1'],
      conflictTx: {
        type: 'BONUS_PURCHASE',
        source: 'migration:tokenplan-0729-x50-bonus',
        subscriptionId: 'ent-1',
        userId: 'user-1',
        creditsAmount: 1, // ≠ 期望 14,700
      },
    });
    const out = await migrateEntitlement(deps, TARGET, { execute: true, includeBonus: true });
    expect(out.bonusStatus).toBe('ERROR');
    expect(out.error).toContain('IDEMPOTENCY_CONFLICT(bonus)');
    expect(calls.addBonus).toHaveLength(0);
    // quota 不连坐
    expect(out.quotaStatus).toBe('MIGRATED');
  });

  it('dry-run + resume：不写库，命中 resume 的行标 SKIPPED_RESUME；dry-run 也跑 reconcile(fix:false) 暴露漂移', async () => {
    const { deps, calls } = makeDeps({ grantRows: ROWS });
    const journal = jest.fn();
    const out = await migrateGrantRedemptions(deps, ['user-1', 'user-2'], {
      execute: false,
      onGrantWillMigrate: journal,
      resumeGrantRows: new Map([['g1', { amount: 100, usedAmount: 40 }]]),
    });
    expect(journal).not.toHaveBeenCalled(); // dry-run 绝不写 journal
    expect(out.rows.find((o) => o.redemptionId === 'g1')?.status).toBe('SKIPPED_RESUME');
    expect(out.rows.find((o) => o.redemptionId === 'g2')?.status).toBe('DRY_RUN');
    expect(calls.grantUpdates).toHaveLength(0);
    expect(out.reconcile).toHaveLength(2); // fix:false 只检不改
  });
});

describe('loadTargets / runMigration', () => {
  const ENTS = [
    { id: 'ent-1', userId: 'user-1', tenantId: 't1', planId: 'plan-lite' },
    { id: 'ent-2', userId: 'user-2', tenantId: 't2', planId: 'plan-free' },
  ];

  it('loadTargets：monthlyCredits<=0 的套餐（免费档）不进目标', async () => {
    const { deps } = makeDeps({
      entitlements: ENTS,
      plans: [
        { id: 'plan-lite', name: '睿动-Lite', monthlyCredits: 1_750_000 },
        { id: 'plan-free', name: 'Free', monthlyCredits: 0 },
      ],
    });
    const targets = await loadTargets(deps.prisma, {});
    expect(targets).toHaveLength(1);
    expect(targets[0]).toMatchObject({ entitlementId: 'ent-1', monthlyCredits: 1_750_000 });
  });

  it('安全闸：execute 且目标套餐 monthlyCredits 低于阈值（配置未×50/连错环境）→ 拒绝执行', async () => {
    const { deps } = makeDeps({
      entitlements: [ENTS[0]],
      plans: [{ id: 'plan-lite', name: '睿动-Lite', monthlyCredits: 35_000 }], // 旧量级
    });
    await expect(
      runMigration(deps, { execute: true, includeBonus: false, includeGrant: false }),
    ).rejects.toThrow('安全闸拒绝执行');
  });

  it('includeBonus 未带 cutoff → 拒绝（补偿基准必须是切点余额）', async () => {
    const { deps } = makeDeps({
      entitlements: [ENTS[0]],
      plans: [{ id: 'plan-lite', name: '睿动-Lite', monthlyCredits: 1_750_000 }],
    });
    await expect(
      runMigration(deps, { execute: true, includeBonus: true, includeGrant: false }),
    ).rejects.toThrow('--cutoff');
  });

  it('安全闸：dry-run 不拦（用于上线前盘点旧配置现状）', async () => {
    const { deps } = makeDeps({
      entitlements: [ENTS[0]],
      plans: [{ id: 'plan-lite', name: '睿动-Lite', monthlyCredits: 35_000 }],
    });
    const report = await runMigration(deps, { execute: false, includeBonus: false, includeGrant: false });
    expect(report.mode).toBe('dry-run');
    expect(report.summary.targets).toBe(1);
  });

  it('安全闸不可被 NaN 绕过：min-monthly-credits 非法 → 拒绝（codex P1-5）', async () => {
    const { deps } = makeDeps({
      entitlements: [ENTS[0]],
      plans: [{ id: 'plan-lite', name: '睿动-Lite', monthlyCredits: 1_750_000 }],
    });
    await expect(
      runMigration(deps, { execute: true, includeBonus: false, includeGrant: false, minMonthlyCredits: Number('foo') }),
    ).rejects.toThrow('min-monthly-credits 非法');
  });

  it('目标为空 + execute → 拒绝（疑似连错环境/过滤写错）', async () => {
    const { deps } = makeDeps({ entitlements: [], plans: [] });
    await expect(
      runMigration(deps, { execute: true, includeBonus: false, includeGrant: false }),
    ).rejects.toThrow('目标为空');
  });

  it('runMigration execute：汇总正确 + 报告含只报不改项', async () => {
    const { deps } = makeDeps({
      entitlements: [ENTS[0]],
      plans: [{ id: 'plan-lite', name: '睿动-Lite', monthlyCredits: 1_750_000 }],
    });
    const report = await runMigration(deps, {
      execute: true,
      includeBonus: true,
      includeGrant: false,
      cutoff: new Date('2026-07-29T10:00:00Z'),
    });
    expect(report.summary).toMatchObject({
      targets: 1,
      quotaMigrated: 1,
      quotaErrors: 0,
      bonusMigrated: 1,
    });
    expect(report.mode).toBe('execute');
    expect(Array.isArray(report.inactiveResidues)).toBe(true);
    expect(Array.isArray(report.activeGrantRules)).toBe(true);
  });
});
