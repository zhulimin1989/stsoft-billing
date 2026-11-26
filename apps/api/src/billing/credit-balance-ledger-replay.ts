export type LegacyCreditBalanceTransaction = {
  id: string;
  subscriptionId: string | null;
  userId: string;
  type: string;
  creditsAmount: number;
  source: string;
  quotaAfter: number;
  bonusAfter: number;
  createdAt: Date;
};

export type CreditBalanceReplayIssueCode =
  | 'EMPTY_HISTORY'
  | 'MIXED_SCOPE'
  | 'INVALID_NUMBER'
  | 'UNKNOWN_TYPE'
  | 'RESET_PAIR_MISSING'
  | 'TOO_MANY_SAME_TIMESTAMP_EVENTS'
  | 'INVALID_TRANSITION'
  | 'GRANT_ALLOCATION_UNVERIFIABLE'
  | 'AMBIGUOUS_ORDER';

export type CreditBalanceReplayResult =
  | {
      ok: true;
      subscriptionId: string;
      quota: number;
      bonus: number;
      transactionCount: number;
    }
  | {
      ok: false;
      code: CreditBalanceReplayIssueCode;
      message: string;
      transactionIds: string[];
    };

type Balance = { quota: number; bonus: number };
type ReplayEvent =
  | { kind: 'single'; rows: [LegacyCreditBalanceTransaction] }
  | {
      kind: 'reset_pair';
      rows: [LegacyCreditBalanceTransaction, LegacyCreditBalanceTransaction];
    };

type ApplyFailure = {
  code: CreditBalanceReplayIssueCode;
  message: string;
  transactionIds: string[];
};

const MAX_SAME_TIMESTAMP_EVENTS = 8;

export function parseLegacyCreditBalanceCacheValue(value: string | null): number | null {
  if (value === null || !/^\d+$/.test(value)) return null;
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed >= 0 ? parsed : null;
}

const PG_INT_MIN = -2_147_483_648;

// quota 维度允许为负（R6 终态负额结算，欠额落 quota 池）；bonus 维度恒非负。
// 按维度拆分而非整体放宽——bonus 一旦出现负值仍应判为账目损坏。
function validQuotaNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value >= PG_INT_MIN;
}

function validBonusNumber(value: number): boolean {
  return Number.isSafeInteger(value) && value >= 0;
}

// 精确镜像 credit.service.deduct 的 mutate calculate：给定扣减前余额与从 quota+bonus
// 实扣的额度 remaining，返回扣后余额；不满足则 null。replay 用它反推「本行是否符合
// 扣减语义」，从而对正常正余额行逐字节等价、对跨零/清欠行天然吻合。
function expectedConsumeNext(current: Balance, remaining: number): Balance | null {
  const available = current.quota + current.bonus;
  if (available < remaining) {
    // 跨零结算：扣尽 quota+bonus、欠额落 quota 池为负。第二道闸=跨负前 available>0
    // 且 current.quota>=0（负债期不可再跨负——与 deduct 镜像，堵 bonus/refund 重开口子）。
    if (available <= 0 || current.quota < 0) return null;
    return { quota: available - remaining, bonus: 0 };
  }
  const fromQuota = Math.min(current.quota, remaining);
  const fromBonus = remaining - fromQuota;
  return { quota: current.quota - fromQuota, bonus: current.bonus - fromBonus };
}

function failure(
  code: CreditBalanceReplayIssueCode,
  message: string,
  rows: LegacyCreditBalanceTransaction[],
): ApplyFailure {
  return { code, message, transactionIds: rows.map((row) => row.id) };
}

function cloneBalance(value: Balance): Balance {
  return { quota: value.quota, bonus: value.bonus };
}

function applySingle(
  current: Balance,
  row: LegacyCreditBalanceTransaction,
): { ok: true; balance: Balance } | { ok: false; issue: ApplyFailure } {
  if (
    !Number.isSafeInteger(row.creditsAmount)
    || !validQuotaNumber(row.quotaAfter)
    || !validBonusNumber(row.bonusAfter)
  ) {
    return {
      ok: false,
      issue: failure('INVALID_NUMBER', `invalid numeric value in transaction=${row.id}`, [row]),
    };
  }

  switch (row.type) {
    case 'QUOTA_GRANT': {
      // prior.quota<0（清欠净发）→ additive（quotaAfter=prior+credits）；否则 SET（既有语义）。
      // 与 credit.service.resetQuota 的 net 模式精确镜像。
      const expectedQuota = current.quota < 0
        ? current.quota + row.creditsAmount
        : row.creditsAmount;
      const valid = row.creditsAmount >= 0
        && row.quotaAfter === expectedQuota
        && row.bonusAfter === current.bonus;
      return valid
        ? { ok: true, balance: { quota: row.quotaAfter, bonus: row.bonusAfter } }
        : {
            ok: false,
            issue: failure(
              'INVALID_TRANSITION',
              `QUOTA_GRANT does not apply quota from ${current.quota}/${current.bonus} to ${row.quotaAfter}/${row.bonusAfter}`,
              [row],
            ),
          };
    }
    case 'BONUS_PURCHASE':
    case 'REFUND': {
      const valid = row.creditsAmount > 0
        && row.quotaAfter === current.quota
        && row.bonusAfter === current.bonus + row.creditsAmount;
      return valid
        ? { ok: true, balance: { quota: row.quotaAfter, bonus: row.bonusAfter } }
        : {
            ok: false,
            issue: failure(
              'INVALID_TRANSITION',
              `${row.type} does not add ${row.creditsAmount} to ${current.quota}/${current.bonus}`,
              [row],
            ),
          };
    }
    case 'CONSUME': {
      const amount = -row.creditsAmount;
      if (amount <= 0) {
        return {
          ok: false,
          issue: failure(
            'INVALID_TRANSITION',
            `CONSUME has non-positive amount transaction=${row.id}`,
            [row],
          ),
        };
      }
      const quotaSpent = current.quota - row.quotaAfter;
      const bonusSpent = current.bonus - row.bonusAfter;
      const quotaAndBonusSpent = quotaSpent + bonusSpent;
      if (quotaAndBonusSpent < 0) {
        // quota+bonus 净额在 CONSUME 后不可能增加（即便债务回补，回补量也来自 bonus，
        // 总扣减 remaining 恒非负）。<0 = 陈旧/损坏的 after 快照，必须隔离。
        return {
          ok: false,
          issue: failure(
            'INVALID_TRANSITION',
            `CONSUME increases quota+bonus total transaction=${row.id}`,
            [row],
          ),
        };
      }
      const derivedFromGrant = amount - quotaAndBonusSpent;
      if (derivedFromGrant < 0) {
        return {
          ok: false,
          issue: failure(
            'INVALID_TRANSITION',
            `CONSUME debits ${quotaAndBonusSpent} quota/bonus exceeding amount=${amount} transaction=${row.id}`,
            [row],
          ),
        };
      }
      if (derivedFromGrant > 0) {
        // Legacy CreditTransaction has no fromGrant column or redemption link. Treating
        // an unchanged/stale after snapshot as grant usage would hide the cold-cache race.
        // （既有守恒缺口：含 grant 的消耗不可验证；R6 未扩大也未修复此域。）
        return {
          ok: false,
          issue: failure(
            'GRANT_ALLOCATION_UNVERIFIABLE',
            `CONSUME requires ${derivedFromGrant} grant credits but legacy row has no allocation proof`,
            [row],
          ),
        };
      }
      // derivedFromGrant===0 ⇒ 从 quota+bonus 实扣 remaining=quotaAndBonusSpent。
      // 用与 deduct 一致的分配函数反推扣后余额，逐字节比对——对正常正余额行等价于旧
      // quota-first 校验，对跨零/清欠中途行天然吻合（含 prior.quota<0 的债务回补）。
      const expected = expectedConsumeNext(current, quotaAndBonusSpent);
      if (
        !expected
        || expected.quota !== row.quotaAfter
        || expected.bonus !== row.bonusAfter
      ) {
        return {
          ok: false,
          issue: failure(
            'INVALID_TRANSITION',
            `CONSUME violates quota-first / cross-zero allocation transaction=${row.id}`,
            [row],
          ),
        };
      }
      return { ok: true, balance: { quota: row.quotaAfter, bonus: row.bonusAfter } };
    }
    case 'GRANT':
    case 'EXPIRE':
      // The user-level grant pool is independent from subscription quota/bonus.
      return { ok: true, balance: cloneBalance(current) };
    case 'QUOTA_RESET':
      return {
        ok: false,
        issue: failure(
          'RESET_PAIR_MISSING',
          `QUOTA_RESET must be replayed with its same-transaction QUOTA_GRANT pair`,
          [row],
        ),
      };
    default:
      return {
        ok: false,
        issue: failure('UNKNOWN_TYPE', `unknown credit transaction type=${row.type}`, [row]),
      };
  }
}

function applyEvent(
  current: Balance,
  event: ReplayEvent,
): { ok: true; balance: Balance } | { ok: false; issue: ApplyFailure } {
  if (event.kind === 'single') return applySingle(current, event.rows[0]);

  const [reset, grant] = event.rows;
  const resetValid = reset.creditsAmount === -current.quota
    && reset.quotaAfter === 0
    && reset.bonusAfter === current.bonus;
  if (!resetValid) {
    return {
      ok: false,
      issue: failure(
        'INVALID_TRANSITION',
        `QUOTA_RESET does not clear ${current.quota}/${current.bonus}`,
        [reset, grant],
      ),
    };
  }
  return applySingle({ quota: 0, bonus: current.bonus }, grant);
}

function buildEventsForTimestamp(
  rows: LegacyCreditBalanceTransaction[],
): { ok: true; events: ReplayEvent[] } | { ok: false; issue: ApplyFailure } {
  const grants = rows.filter((row) => row.type === 'QUOTA_GRANT');
  const pairedGrantIds = new Set<string>();
  const events: ReplayEvent[] = [];

  for (const reset of rows.filter((row) => row.type === 'QUOTA_RESET')) {
    const expectedSource = reset.source.startsWith('reset:')
      ? reset.source.slice('reset:'.length)
      : null;
    const matches = expectedSource === null
      ? []
      : grants.filter((grant) =>
          !pairedGrantIds.has(grant.id)
          && grant.subscriptionId === reset.subscriptionId
          && grant.source === expectedSource);
    if (matches.length !== 1) {
      return {
        ok: false,
        issue: failure(
          'RESET_PAIR_MISSING',
          `QUOTA_RESET has ${matches.length} matching QUOTA_GRANT rows at the same timestamp`,
          [reset, ...matches],
        ),
      };
    }
    pairedGrantIds.add(matches[0].id);
    events.push({ kind: 'reset_pair', rows: [reset, matches[0]] });
  }

  for (const row of rows) {
    if (row.type === 'QUOTA_RESET' || pairedGrantIds.has(row.id)) continue;
    events.push({ kind: 'single', rows: [row] });
  }
  if (events.length > MAX_SAME_TIMESTAMP_EVENTS) {
    return {
      ok: false,
      issue: failure(
        'TOO_MANY_SAME_TIMESTAMP_EVENTS',
        `timestamp group has ${events.length} logical events; maximum is ${MAX_SAME_TIMESTAMP_EVENTS}`,
        rows,
      ),
    };
  }
  return { ok: true, events };
}

function replayTimestampGroup(
  initial: Balance,
  events: ReplayEvent[],
): { ok: true; balance: Balance } | { ok: false; issue: ApplyFailure } {
  const outcomes = new Map<string, Balance>();
  const failures: ApplyFailure[] = [];

  const visit = (balance: Balance, remaining: ReplayEvent[]): void => {
    if (remaining.length === 0) {
      outcomes.set(`${balance.quota}:${balance.bonus}`, balance);
      return;
    }
    for (let index = 0; index < remaining.length; index += 1) {
      const applied = applyEvent(balance, remaining[index]);
      if (!applied.ok) {
        failures.push(applied.issue);
        continue;
      }
      visit(
        applied.balance,
        [...remaining.slice(0, index), ...remaining.slice(index + 1)],
      );
    }
  };

  visit(initial, events);
  if (outcomes.size === 1) {
    return { ok: true, balance: [...outcomes.values()][0] };
  }
  if (outcomes.size > 1) {
    return {
      ok: false,
      issue: failure(
        'AMBIGUOUS_ORDER',
        `same-timestamp events have ${outcomes.size} valid final balances`,
        events.flatMap((event) => event.rows),
      ),
    };
  }
  return {
    ok: false,
    issue: failures.find((item) => item.code === 'GRANT_ALLOCATION_UNVERIFIABLE')
      ?? failures[0]
      ?? failure('INVALID_TRANSITION', 'timestamp group has no valid order', []),
  };
}

export function replayLegacyCreditBalance(
  inputRows: LegacyCreditBalanceTransaction[],
): CreditBalanceReplayResult {
  const rows = inputRows.filter((row) => row.type !== 'GRANT' && row.type !== 'EXPIRE');
  if (rows.length === 0) {
    return {
      ok: false,
      code: 'EMPTY_HISTORY',
      message: 'no subscription quota/bonus transactions',
      transactionIds: [],
    };
  }
  const subscriptionIds = new Set(rows.map((row) => row.subscriptionId).filter(Boolean));
  if (subscriptionIds.size !== 1 || rows.some((row) => !row.subscriptionId)) {
    return {
      ok: false,
      code: 'MIXED_SCOPE',
      message: 'replay input must contain exactly one non-empty subscriptionId',
      transactionIds: rows.map((row) => row.id),
    };
  }

  const groups = new Map<number, LegacyCreditBalanceTransaction[]>();
  for (const row of rows) {
    const timestamp = row.createdAt.getTime();
    if (!Number.isFinite(timestamp)) {
      return {
        ok: false,
        code: 'INVALID_NUMBER',
        message: `invalid createdAt transaction=${row.id}`,
        transactionIds: [row.id],
      };
    }
    const group = groups.get(timestamp) ?? [];
    group.push(row);
    groups.set(timestamp, group);
  }

  let balance: Balance = { quota: 0, bonus: 0 };
  for (const timestamp of [...groups.keys()].sort((left, right) => left - right)) {
    const built = buildEventsForTimestamp(groups.get(timestamp)!);
    if (!built.ok) return { ok: false, ...built.issue };
    const replayed = replayTimestampGroup(balance, built.events);
    if (!replayed.ok) return { ok: false, ...replayed.issue };
    balance = replayed.balance;
  }

  return {
    ok: true,
    subscriptionId: [...subscriptionIds][0]!,
    quota: balance.quota,
    bonus: balance.bonus,
    transactionCount: rows.length,
  };
}
