import {
  LegacyCreditBalanceTransaction,
  parseLegacyCreditBalanceCacheValue,
  replayLegacyCreditBalance,
} from './credit-balance-ledger-replay';

const base = new Date('2026-01-01T00:00:00.000Z');

function row(
  id: string,
  type: string,
  creditsAmount: number,
  quotaAfter: number,
  bonusAfter: number,
  offsetMs: number,
  overrides: Partial<LegacyCreditBalanceTransaction> = {},
): LegacyCreditBalanceTransaction {
  return {
    id,
    subscriptionId: 'sub-1',
    userId: 'owner',
    type,
    creditsAmount,
    source: type.toLowerCase(),
    quotaAfter,
    bonusAfter,
    createdAt: new Date(base.getTime() + offsetMs),
    ...overrides,
  };
}

describe('replayLegacyCreditBalance', () => {
  it('accepts only exact non-negative safe-integer legacy cache values', () => {
    expect(parseLegacyCreditBalanceCacheValue('100')).toBe(100);
    expect(parseLegacyCreditBalanceCacheValue('01')).toBe(1);
    expect(parseLegacyCreditBalanceCacheValue(null)).toBeNull();
    expect(parseLegacyCreditBalanceCacheValue('-1')).toBeNull();
    expect(parseLegacyCreditBalanceCacheValue('1x')).toBeNull();
    expect(parseLegacyCreditBalanceCacheValue('9007199254740992')).toBeNull();
  });

  it('replays valid replacement, increment, consume, refund, and reset semantics', () => {
    const result = replayLegacyCreditBalance([
      row('grant-1', 'QUOTA_GRANT', 100, 100, 0, 1),
      row('bonus-1', 'BONUS_PURCHASE', 20, 100, 20, 2),
      row('consume-1', 'CONSUME', -110, 0, 10, 3),
      row('refund-1', 'REFUND', 5, 0, 15, 4),
      row('reset-random-high-id', 'QUOTA_RESET', 0, 0, 15, 5, {
        source: 'reset:renewal',
      }),
      row('grant-random-low-id', 'QUOTA_GRANT', 200, 200, 15, 5, {
        source: 'renewal',
      }),
    ]);

    expect(result).toEqual({
      ok: true,
      subscriptionId: 'sub-1',
      quota: 200,
      bonus: 15,
      transactionCount: 6,
    });
  });

  it('quarantines the duplicated cold-cache consume snapshot instead of verifying 90', () => {
    const result = replayLegacyCreditBalance([
      row('grant', 'QUOTA_GRANT', 100, 100, 0, 1),
      row('consume-a', 'CONSUME', -10, 90, 0, 2),
      row('consume-b', 'CONSUME', -10, 90, 0, 3),
    ]);

    expect(result).toMatchObject({
      ok: false,
      code: 'GRANT_ALLOCATION_UNVERIFIABLE',
      transactionIds: ['consume-b'],
    });
  });

  it('quarantines a replay-restored historical after snapshot', () => {
    const result = replayLegacyCreditBalance([
      row('grant', 'QUOTA_GRANT', 100, 100, 0, 1),
      row('consume-a', 'CONSUME', -80, 20, 0, 2),
      row('consume-after-replay', 'CONSUME', -10, 90, 0, 3),
    ]);

    expect(result).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
  });

  it('quarantines a recharge/consume history whose after snapshots cannot be serialized', () => {
    const result = replayLegacyCreditBalance([
      row('grant', 'QUOTA_GRANT', 100, 100, 0, 1),
      row('bonus', 'BONUS_PURCHASE', 50, 100, 50, 2),
      row('consume-stale', 'CONSUME', -30, 70, 0, 3),
    ]);

    expect(result).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
  });

  it('allows a tenant member actor because the balance scope owner is resolved separately', () => {
    const result = replayLegacyCreditBalance([
      row('grant', 'QUOTA_GRANT', 100, 100, 0, 1, { userId: 'owner' }),
      row('member-consume', 'CONSUME', -25, 75, 0, 2, { userId: 'member' }),
    ]);

    expect(result).toMatchObject({ ok: true, quota: 75, bonus: 0 });
  });

  it('does not guess legacy grant allocation from an unchanged quota/bonus snapshot', () => {
    const result = replayLegacyCreditBalance([
      row('grant', 'QUOTA_GRANT', 100, 100, 0, 1),
      row('grant-only-consume', 'CONSUME', -20, 100, 0, 2),
    ]);

    expect(result).toMatchObject({ ok: false, code: 'GRANT_ALLOCATION_UNVERIFIABLE' });
  });

  it('rejects an unpaired reset even when it is the latest row', () => {
    const result = replayLegacyCreditBalance([
      row('grant', 'QUOTA_GRANT', 100, 100, 0, 1),
      row('reset', 'QUOTA_RESET', -100, 0, 0, 2, { source: 'reset:renewal' }),
    ]);

    expect(result).toMatchObject({ ok: false, code: 'RESET_PAIR_MISSING' });
  });

  // ── R6 v5 负额结算重放 ─────────────────────────────────────────────────────
  it('replays a cross-zero CONSUME into negative quota (bonus drained to 0)', () => {
    const result = replayLegacyCreditBalance([
      row('grant', 'QUOTA_GRANT', 100, 100, 0, 1),
      row('bonus', 'BONUS_PURCHASE', 50, 100, 50, 2),
      row('cross', 'CONSUME', -200, -50, 0, 3), // 扣尽 150、欠额 -50 落 quota
    ]);

    expect(result).toMatchObject({ ok: true, quota: -50, bonus: 0 });
  });

  it('replays a net-settle QUOTA_GRANT additively over a negative quota', () => {
    const result = replayLegacyCreditBalance([
      row('grant', 'QUOTA_GRANT', 100, 100, 0, 1),
      row('bonus', 'BONUS_PURCHASE', 50, 100, 50, 2),
      row('cross', 'CONSUME', -200, -50, 0, 3),
      row('refresh', 'QUOTA_GRANT', 35000, 34_950, 0, 4), // additive：-50 + 35000
    ]);

    expect(result).toMatchObject({ ok: true, quota: 34_950, bonus: 0 });
  });

  it('replays a bonus-funded debt repayment during a later CONSUME', () => {
    const result = replayLegacyCreditBalance([
      row('grant', 'QUOTA_GRANT', 100, 100, 0, 1),
      row('bonus0', 'BONUS_PURCHASE', 50, 100, 50, 2),
      row('cross', 'CONSUME', -200, -50, 0, 3), // → {-50, 0}
      row('bonus1', 'BONUS_PURCHASE', 100, -50, 100, 4), // → {-50, 100}
      row('repay', 'CONSUME', -30, 0, 20, 5), // quota 由 -50 回补到 0，净扣 30
    ]);

    expect(result).toMatchObject({ ok: true, quota: 0, bonus: 20 });
  });

  it('rejects an illegal second cross-zero row (at-most-one crossing)', () => {
    const result = replayLegacyCreditBalance([
      row('grant', 'QUOTA_GRANT', 100, 100, 0, 1),
      row('bonus', 'BONUS_PURCHASE', 50, 100, 50, 2),
      row('cross', 'CONSUME', -200, -50, 0, 3), // → {-50, 0}
      row('second', 'CONSUME', -10, -60, 0, 4), // 从非正 available 再跨负=非法
    ]);

    expect(result).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
  });

  it('replays a forgive-mode reset_pair that clears a negative quota', () => {
    const result = replayLegacyCreditBalance([
      row('grant', 'QUOTA_GRANT', 100, 100, 0, 1),
      row('bonus', 'BONUS_PURCHASE', 50, 100, 50, 2),
      row('cross', 'CONSUME', -200, -50, 0, 3), // → {-50, 0}
      // forgive：同一时间戳 RESET(+50 → 0) + GRANT(35000)，source 配对键一致
      row('forgive-reset', 'QUOTA_RESET', 50, 0, 0, 4, { source: 'reset:renewal' }),
      row('forgive-grant', 'QUOTA_GRANT', 35000, 35000, 0, 4, { source: 'renewal' }),
    ]);

    expect(result).toMatchObject({ ok: true, quota: 35000, bonus: 0 });
  });

  it('rejects a bonus-funded re-crossing while already in debt (codex P1#2)', () => {
    const result = replayLegacyCreditBalance([
      row('grant', 'QUOTA_GRANT', 100, 100, 0, 1),
      row('bonus0', 'BONUS_PURCHASE', 50, 100, 50, 2),
      row('cross', 'CONSUME', -200, -50, 0, 3), // → {-50, 0}
      row('bonus1', 'BONUS_PURCHASE', 51, -50, 51, 4), // → {-50, 51}, available=1>0 但 quota<0
      row('recross', 'CONSUME', -100, -99, 0, 5), // 负债期再跨零=非法
    ]);

    expect(result).toMatchObject({ ok: false, code: 'INVALID_TRANSITION' });
  });

  it('rejects a negative bonusAfter as corrupt (bonus stays non-negative)', () => {
    const result = replayLegacyCreditBalance([
      row('grant', 'QUOTA_GRANT', 100, 100, 0, 1),
      row('bad', 'CONSUME', -10, 100, -10, 2),
    ]);

    expect(result).toMatchObject({ ok: false, code: 'INVALID_NUMBER' });
  });
});
