import { CodingPlanMonthlyRefreshService } from './coding-plan-monthly-refresh.service';

const DAY = 24 * 60 * 60 * 1000;
const START = new Date('2026-01-01T00:00:00.000Z');

type Ent = {
  id: string;
  userId: string;
  planId: string;
  startedAt: Date;
  expiresAt: Date;
};

function build(opts: {
  enabled?: boolean;
  entitlements?: Ent[];
  plans?: Array<{ id: string; monthlyCredits: number; validityDays: number }>;
  appliedKeys?: string[]; // 已存在的 cpm:refresh:<ent>:<k> 幂等键（模拟已发期）
}) {
  const resetCalls: unknown[][] = [];
  const applied = new Set(opts.appliedKeys ?? []);
  const prisma: any = {
    codingPlanEntitlement: { findMany: jest.fn(async () => opts.entitlements ?? []) },
    plan: { findMany: jest.fn(async () => opts.plans ?? []) },
    creditTransaction: {
      findUnique: jest.fn(async ({ where }: { where: { idempotencyKey: string } }) =>
        applied.has(where.idempotencyKey) ? { id: where.idempotencyKey } : null),
    },
  };
  const credit: any = {
    resetQuota: jest.fn(async (...args: unknown[]) => {
      resetCalls.push(args);
    }),
  };
  const systemConfig: any = {
    getFresh: jest.fn(async () => (opts.enabled ? true : false)),
  };
  const svc = new CodingPlanMonthlyRefreshService(prisma, credit, systemConfig);
  return { svc, resetCalls, credit };
}

const monthlyPlan = { id: 'plan-lite', monthlyCredits: 35000, validityDays: 30 };
const ent = (over: Partial<Ent> = {}): Ent => ({
  id: 'ent-1',
  userId: 'u1',
  planId: 'plan-lite',
  startedAt: START,
  expiresAt: new Date(START.getTime() + 90 * DAY), // 季付：3 个月
  ...over,
});

describe('CodingPlanMonthlyRefreshService.runOnce', () => {
  afterEach(() => {
    delete process.env.BILLING_CODING_PLAN_MONTHLY_REFRESH_ENABLED;
  });

  it('does nothing when the switch is off', async () => {
    const { svc, resetCalls } = build({ enabled: false, entitlements: [ent()], plans: [monthlyPlan] });
    const out = await svc.runOnce(new Date(START.getTime() + 35 * DAY));
    expect(out).toMatchObject({ enabled: false, refreshed: 0 });
    expect(resetCalls).toHaveLength(0);
  });

  it('refreshes month k=1 with the correct idempotency key and net mode', async () => {
    const { svc, resetCalls } = build({ enabled: true, entitlements: [ent()], plans: [monthlyPlan] });
    const out = await svc.runOnce(new Date(START.getTime() + 35 * DAY)); // 第 2 个月
    expect(out).toMatchObject({ enabled: true, scanned: 1, refreshed: 1, failed: 0 });
    expect(resetCalls[0]).toEqual([
      'ent-1',
      'u1',
      35000,
      'coding-plan:monthly-refresh',
      {
        idempotencyKey: 'cpm:refresh:ent-1:1',
        negativeSettleMode: 'net',
        requireActiveCodingPlanEntitlement: true,
      },
    ]);
  });

  it('does not refresh within the first month (k=0)', async () => {
    const { svc, resetCalls } = build({ enabled: true, entitlements: [ent()], plans: [monthlyPlan] });
    const out = await svc.runOnce(new Date(START.getTime() + 10 * DAY));
    expect(out.refreshed).toBe(0);
    expect(resetCalls).toHaveLength(0);
  });

  it('never refreshes a single-month plan (k boundary at/after expiry)', async () => {
    const { svc, resetCalls } = build({
      enabled: true,
      entitlements: [ent({ expiresAt: new Date(START.getTime() + 30 * DAY) })],
      plans: [monthlyPlan],
    });
    const out = await svc.runOnce(new Date(START.getTime() + 35 * DAY));
    expect(out.refreshed).toBe(0);
    expect(resetCalls).toHaveLength(0);
  });

  it('skips entitlements whose monthly unit is outside [28,31] days (guard)', async () => {
    const { svc, resetCalls } = build({
      enabled: true,
      entitlements: [ent()],
      plans: [{ id: 'plan-lite', monthlyCredits: 35000, validityDays: 90 }],
    });
    const out = await svc.runOnce(new Date(START.getTime() + 100 * DAY));
    expect(out).toMatchObject({ scanned: 1, refreshed: 0, skippedGuard: 1 });
    expect(resetCalls).toHaveLength(0);
  });

  it('catches up ALL missing periods 1..k in order (P1-a: net-debt additive is not fold-equivalent)', async () => {
    const { svc, resetCalls } = build({ enabled: true, entitlements: [ent()], plans: [monthlyPlan] });
    const out = await svc.runOnce(new Date(START.getTime() + 65 * DAY)); // 第 3 个月，k=2
    expect(out.refreshed).toBe(1);
    // 逐期升序补：j=1 再 j=2（负债净发 additive 必须逐期累加，不能只补最新一期）
    expect(resetCalls).toHaveLength(2);
    expect((resetCalls[0][4] as any).idempotencyKey).toBe('cpm:refresh:ent-1:1');
    expect((resetCalls[1][4] as any).idempotencyKey).toBe('cpm:refresh:ent-1:2');
    expect((resetCalls[0][4] as any).negativeSettleMode).toBe('net');
  });

  it('steady state: skips (no resetQuota) when the latest period was already applied (P2 no idle churn)', async () => {
    const { svc, resetCalls } = build({
      enabled: true,
      entitlements: [ent()],
      plans: [monthlyPlan],
      appliedKeys: ['cpm:refresh:ent-1:1'],
    });
    const out = await svc.runOnce(new Date(START.getTime() + 35 * DAY)); // k=1，已发
    expect(out.refreshed).toBe(0);
    expect(resetCalls).toHaveLength(0);
  });

  it('only replays the missing tail when earlier periods were already applied', async () => {
    const { svc, resetCalls } = build({
      enabled: true,
      entitlements: [ent()],
      plans: [monthlyPlan],
      appliedKeys: ['cpm:refresh:ent-1:1'], // k=1 已发，k=2 缺
    });
    const out = await svc.runOnce(new Date(START.getTime() + 65 * DAY)); // k=2
    expect(out.refreshed).toBe(1);
    // 仍从 j=1 升序重放（j=1 由 resetQuota 内部幂等命中跳过，j=2 真发）——此处 mock 记录两次调用
    expect(resetCalls.map((c) => (c[4] as any).idempotencyKey)).toEqual([
      'cpm:refresh:ent-1:1',
      'cpm:refresh:ent-1:2',
    ]);
  });

  it('skips when entitlement span is not an integer multiple of the month unit (P1-b non_uniform_span)', async () => {
    const { svc, resetCalls } = build({
      enabled: true,
      // 30 天月单位，但 entitlement 跨度 45 天（override/非标）→ 月边界不确定
      entitlements: [ent({ expiresAt: new Date(START.getTime() + 45 * DAY) })],
      plans: [monthlyPlan],
    });
    const out = await svc.runOnce(new Date(START.getTime() + 35 * DAY));
    expect(out).toMatchObject({ scanned: 1, refreshed: 0, skippedGuard: 1 });
    expect(resetCalls).toHaveLength(0);
  });

  it('skips a near-integer non-standard span (31d span on a 30d month unit)', async () => {
    const { svc, resetCalls } = build({
      enabled: true,
      entitlements: [ent({ expiresAt: new Date(START.getTime() + 31 * DAY) })], // 31/30≈1.033
      plans: [monthlyPlan],
    });
    const out = await svc.runOnce(new Date(START.getTime() + 20 * DAY));
    expect(out).toMatchObject({ scanned: 1, refreshed: 0, skippedGuard: 1 });
    expect(resetCalls).toHaveLength(0);
  });

  it('breaks on a mid-period failure and resumes from the failed period next tick', async () => {
    const { svc, credit } = build({ enabled: true, entitlements: [ent()], plans: [monthlyPlan] });
    // 第一次 tick：k=2，j=1 成功、j=2 抛错 → 中断、failed 计数、不误标 refreshed
    (credit.resetQuota as jest.Mock)
      .mockImplementationOnce(async () => undefined) // j=1 ok
      .mockImplementationOnce(async () => {
        throw new Error('transient');
      });
    const out1 = await svc.runOnce(new Date(START.getTime() + 65 * DAY));
    expect(out1).toMatchObject({ refreshed: 0, failed: 1 });
  });

  it('honors the env fallback switch', async () => {
    process.env.BILLING_CODING_PLAN_MONTHLY_REFRESH_ENABLED = 'true';
    const { svc, resetCalls } = build({ enabled: false, entitlements: [ent()], plans: [monthlyPlan] });
    const out = await svc.runOnce(new Date(START.getTime() + 35 * DAY));
    expect(out.enabled).toBe(true);
    expect(resetCalls).toHaveLength(1);
  });
});
