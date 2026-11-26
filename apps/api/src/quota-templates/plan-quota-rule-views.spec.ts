import {
  findCreditMonotonicViolations,
  findCreditWindowConsistencyViolations,
  formatCreditWindowConsistencyError,
  isProviderResalePlan,
  isQuotaRuleEnforced,
  parseQuotaRuleSpecs,
  resolvePlanQuotaRuleViews,
  type PlanQuotaRuleBinding,
  type PlanQuotaRuleView,
} from './plan-quota-rule-views';

function binding(
  rules: unknown,
  overrides: Partial<NonNullable<PlanQuotaRuleBinding['template']>> = {},
): PlanQuotaRuleBinding {
  return {
    template: {
      rules: typeof rules === 'string' ? rules : JSON.stringify(rules),
      isActive: true,
      deletedAt: null,
      ...overrides,
    },
  };
}

const RULE_6H_REQ = {
  windowType: 'ROLLING',
  durationLabel: '6h',
  durationSec: 21600,
  metric: 'REQUESTS',
  limitValue: 600,
};
const RULE_6H_TOKENS = {
  windowType: 'ROLLING',
  durationLabel: '6h',
  durationSec: 21600,
  metric: 'TOTAL_TOKENS',
  limitValue: 2_000_000,
};
const RULE_7D_TOKENS = {
  windowType: 'ROLLING',
  durationLabel: '7d',
  durationSec: 604800,
  metric: 'TOTAL_TOKENS',
  limitValue: 10_000_000,
};
const RULE_5H_CREDITS = {
  windowType: 'ROLLING',
  durationLabel: '5h',
  durationSec: 18000,
  metric: 'CREDITS',
  limitValue: 60,
};
const RULE_7D_CREDITS = {
  windowType: 'ROLLING',
  durationLabel: '7d',
  durationSec: 604800,
  metric: 'CREDITS',
  limitValue: 400,
};

describe('parseQuotaRuleSpecs', () => {
  it('parses a JSON array', () => {
    expect(parseQuotaRuleSpecs(JSON.stringify([RULE_6H_REQ]))).toHaveLength(1);
  });

  it('returns empty and warns on broken JSON', () => {
    const warn = jest.fn();
    expect(parseQuotaRuleSpecs('{not-json', warn)).toEqual([]);
    expect(warn).toHaveBeenCalled();
  });

  it('returns empty for null/empty/non-array', () => {
    expect(parseQuotaRuleSpecs(null)).toEqual([]);
    expect(parseQuotaRuleSpecs('')).toEqual([]);
    expect(parseQuotaRuleSpecs('{"a":1}')).toEqual([]);
  });
});

describe('isQuotaRuleEnforced（quota-v2：ROLLING + {REQUESTS,CREDITS} + 任意正窗口；token 退役）', () => {
  it('enforces ROLLING REQUESTS/CREDITS at any window (5h/6h/7d)', () => {
    expect(isQuotaRuleEnforced(RULE_6H_REQ)).toBe(true);
    expect(isQuotaRuleEnforced(RULE_5H_CREDITS)).toBe(true);
    expect(isQuotaRuleEnforced(RULE_7D_CREDITS)).toBe(true);
    expect(isQuotaRuleEnforced({ ...RULE_6H_REQ, durationSec: 604800 })).toBe(true);
    expect(isQuotaRuleEnforced({ ...RULE_6H_REQ, durationSec: 60 })).toBe(true);
  });

  it('retires token metrics (INPUT/OUTPUT/TOTAL_TOKENS) — not enforced (防 token 上限推测)', () => {
    expect(isQuotaRuleEnforced(RULE_6H_TOKENS)).toBe(false);
    expect(isQuotaRuleEnforced(RULE_7D_TOKENS)).toBe(false);
    expect(isQuotaRuleEnforced({ ...RULE_6H_TOKENS, metric: 'INPUT_TOKENS' })).toBe(false);
  });

  it('does not enforce non-ROLLING / non-positive limit / non-positive window', () => {
    expect(isQuotaRuleEnforced({ ...RULE_6H_REQ, windowType: 'FIXED_PERIOD' })).toBe(false);
    expect(isQuotaRuleEnforced({ ...RULE_6H_REQ, limitValue: 0 })).toBe(false);
    expect(isQuotaRuleEnforced({ ...RULE_6H_REQ, limitValue: undefined })).toBe(false);
    expect(isQuotaRuleEnforced({ ...RULE_5H_CREDITS, durationSec: 0 })).toBe(false);
  });
});

describe('resolvePlanQuotaRuleViews', () => {
  it('marks enforced when gate enabled: REQUESTS/CREDITS rolling enforced, token filtered out', () => {
    const views = resolvePlanQuotaRuleViews(
      [binding([RULE_6H_REQ, RULE_7D_CREDITS, RULE_7D_TOKENS])],
      undefined,
      { gateEnabled: true },
    );
    // token 维度退役：从视图中剔除（不出现在对外响应），仅留 REQUESTS/CREDITS
    expect(views).toHaveLength(2);
    expect(views.find((v) => v.metric === 'REQUESTS')).toMatchObject({
      enforced: true,
      durationLabel: '6h',
      limitValue: 600,
    });
    expect(views.find((v) => v.metric === 'CREDITS')).toMatchObject({ enforced: true });
    expect(views.find((v) => v.metric === 'TOTAL_TOKENS')).toBeUndefined();
  });

  it('gate disabled (default) → all enforced=false (展示+执行同退, §7)', () => {
    const views = resolvePlanQuotaRuleViews([binding([RULE_6H_REQ, RULE_7D_CREDITS])]);
    expect(views).toHaveLength(2);
    expect(views.every((v) => v.enforced === false)).toBe(true);
  });

  it('derives durationLabel when template omits it', () => {
    const views = resolvePlanQuotaRuleViews([
      binding([{ ...RULE_6H_REQ, durationLabel: undefined }]),
    ]);
    expect(views[0].durationLabel).toBe('6h');
    const dayViews = resolvePlanQuotaRuleViews([
      binding([{ ...RULE_7D_CREDITS, durationLabel: '' }]),
    ]);
    expect(dayViews[0].durationLabel).toBe('7d');
  });

  it('dedupes same (metric, windowType, durationSec) keeping the stricter limit', () => {
    const views = resolvePlanQuotaRuleViews([
      binding([RULE_7D_CREDITS]),
      binding([{ ...RULE_7D_CREDITS, limitValue: 200 }]),
    ]);
    expect(views).toHaveLength(1);
    expect(views[0].limitValue).toBe(200);
  });

  it('skips inactive and soft-deleted templates（与 billing 展示/执行同口径）', () => {
    const views = resolvePlanQuotaRuleViews([
      binding([RULE_6H_REQ], { isActive: false }),
      binding([RULE_6H_TOKENS], { deletedAt: new Date() }),
      { template: null },
    ]);
    expect(views).toEqual([]);
  });

  it('skips malformed rules and broken JSON without throwing', () => {
    const warn = jest.fn();
    const views = resolvePlanQuotaRuleViews(
      [
        binding('{broken'),
        binding([
          { windowType: 'ROLLING', durationSec: 21600, metric: 'NOT_A_METRIC', limitValue: 5 },
          { windowType: 'WEIRD', durationSec: 21600, metric: 'REQUESTS', limitValue: 5 },
          { windowType: 'ROLLING', durationSec: -1, metric: 'REQUESTS', limitValue: 5 },
          { windowType: 'ROLLING', durationSec: 21600, metric: 'REQUESTS', limitValue: 0 },
          RULE_6H_REQ,
        ]),
      ],
      warn,
    );
    expect(views).toHaveLength(1);
    expect(views[0]).toMatchObject({ metric: 'REQUESTS', limitValue: 600 });
    expect(warn).toHaveBeenCalled();
  });
});

describe('isProviderResalePlan', () => {
  it('detects provider_resale marker case-insensitively', () => {
    expect(isProviderResalePlan(JSON.stringify(['provider_resale:zhipu_overseas']))).toBe(true);
    expect(isProviderResalePlan(JSON.stringify(['Provider_Resale:zhipu_cn']))).toBe(true);
  });

  it('returns false for non-resale/empty/broken features', () => {
    expect(isProviderResalePlan(JSON.stringify(['priority_support']))).toBe(false);
    expect(isProviderResalePlan(null)).toBe(false);
    expect(isProviderResalePlan('{broken')).toBe(false);
  });
});

describe('findCreditWindowConsistencyViolations', () => {
  const SEC_5H = 18000;
  const SEC_7D = 604800;
  function creditView(durationSec: number, limitValue: number): PlanQuotaRuleView {
    return {
      metric: 'CREDITS',
      windowType: 'ROLLING',
      durationSec,
      durationLabel: durationSec % 86400 === 0 ? `${durationSec / 86400}d` : `${durationSec / 3600}h`,
      limitValue,
      enforced: false,
    };
  }

  it('flags a CREDITS window exceeding monthlyCredits', () => {
    const v = findCreditWindowConsistencyViolations(1000, [creditView(SEC_5H, 1500)]);
    expect(v).toHaveLength(1);
    expect(v[0].reason).toBe('exceeds_monthly');
    expect(v[0].limitValue).toBe(1500);
  });

  it('passes when windows are within monthly and monotonic', () => {
    const v = findCreditWindowConsistencyViolations(2000, [
      creditView(SEC_5H, 800),
      creditView(SEC_7D, 1500),
    ]);
    expect(v).toHaveLength(0);
  });

  it('flags non-monotonic windows (shorter window > longer window)', () => {
    const v = findCreditWindowConsistencyViolations(5000, [
      creditView(SEC_5H, 1500),
      creditView(SEC_7D, 1000),
    ]);
    expect(v.some((x) => x.reason === 'non_monotonic')).toBe(true);
  });

  it('reproduces the testlimit case: monthly 1000, 5h/7d both 1500 → two exceeds_monthly', () => {
    const v = findCreditWindowConsistencyViolations(1000, [
      creditView(SEC_5H, 1500),
      creditView(SEC_7D, 1500),
    ]);
    expect(v.filter((x) => x.reason === 'exceeds_monthly')).toHaveLength(2);
  });

  it('emits exceeds_monthly before non_monotonic when both occur (order locked)', () => {
    // 5h=1500>monthly1000 (超月) 且 5h(1500)>7d(800) (非单调) → 两类都出，顺序：封顶在前、单调在后。
    const v = findCreditWindowConsistencyViolations(1000, [
      creditView(SEC_5H, 1500),
      creditView(SEC_7D, 800),
    ]);
    const reasons = v.map((x) => x.reason);
    expect(reasons).toContain('exceeds_monthly');
    expect(reasons).toContain('non_monotonic');
    expect(reasons.indexOf('exceeds_monthly')).toBeLessThan(reasons.indexOf('non_monotonic'));
  });

  it('returns no violations when monthlyCredits <= 0 (non-self-op: skip entirely, incl. monotonic)', () => {
    // monthly<=0 = 无正向积分池（转售/PAYG/通用 monthly=0），整段跳过，避免误伤非自营套餐。
    expect(findCreditWindowConsistencyViolations(0, [creditView(SEC_5H, 1500)])).toHaveLength(0);
    expect(
      findCreditWindowConsistencyViolations(0, [creditView(SEC_5H, 1500), creditView(SEC_7D, 1000)]),
    ).toHaveLength(0);
    expect(findCreditWindowConsistencyViolations(-5, [creditView(SEC_5H, 1500)])).toHaveLength(0);
  });

  it('ignores non-CREDITS / non-ROLLING rules', () => {
    const requestsWindow: PlanQuotaRuleView = {
      metric: 'REQUESTS',
      windowType: 'ROLLING',
      durationSec: SEC_5H,
      durationLabel: '5h',
      limitValue: 999999,
      enforced: false,
    };
    expect(findCreditWindowConsistencyViolations(1000, [requestsWindow])).toHaveLength(0);
  });

  it('formats a readable Chinese error mentioning the plan and rule', () => {
    const v = findCreditWindowConsistencyViolations(1000, [creditView(SEC_5H, 1500)]);
    const msg = formatCreditWindowConsistencyError(v, 1000, 'testlimit');
    expect(msg).toContain('testlimit');
    expect(msg).toContain('1500');
    expect(msg).toContain('1000');
  });
});

describe('findCreditMonotonicViolations (monthly-independent, for in-template check)', () => {
  const SEC_5H = 18000;
  const SEC_7D = 604800;
  function creditView(durationSec: number, limitValue: number): PlanQuotaRuleView {
    return {
      metric: 'CREDITS',
      windowType: 'ROLLING',
      durationSec,
      durationLabel: durationSec % 86400 === 0 ? `${durationSec / 86400}d` : `${durationSec / 3600}h`,
      limitValue,
      enforced: false,
    };
  }

  it('flags short-window > long-window regardless of any monthly value (t4 case: 5h=5000 > 7d=500)', () => {
    const v = findCreditMonotonicViolations([creditView(SEC_5H, 5000), creditView(SEC_7D, 500)]);
    expect(v).toHaveLength(1);
    expect(v[0].reason).toBe('non_monotonic');
    expect(v[0].limitValue).toBe(5000);
    expect(v[0].comparedLimitValue).toBe(500);
  });

  it('passes monotonic (5h <= 7d) and single-window templates', () => {
    expect(findCreditMonotonicViolations([creditView(SEC_5H, 500), creditView(SEC_7D, 5000)])).toHaveLength(0);
    expect(findCreditMonotonicViolations([creditView(SEC_5H, 500)])).toHaveLength(0);
    expect(findCreditMonotonicViolations([])).toHaveLength(0);
  });
});
