import { Prisma } from '@prisma/client';
import { BillingService } from './billing.service';

/**
 * 降级水位的「必有进展」契约。
 *
 * settleBalanceDebtOnFundingInner 的降级判断在 while 循环开头。当前实现下它不会
 * 零进展:计时器 settleStartedAt 设在所有前置查询(account / snapshot /
 * unsequencedOpenDebt count)之后、循环之前,所以首次检查时 elapsed ≈ 0,
 * 而预算最小有效值是 1ms(传 0 会 fallback 成 25s)⇒ 第一批必然被处理。
 *
 * 这里钉的是**契约而非当前实现**:一旦 elapsed 在首次检查就已超预算
 * (比如有人把计时器上移到前置查询之前、或改了预算解析放开 0),
 * 没有 `stats.batches > 0` 守卫就会核销 0 行却把全额转入 pending,
 * 而 worker 每轮是「删 pending → 调本方法 → 又立刻降级 → 写回同额 pending」
 * ⇒ pending 永不减少、worker 无限空转。
 *
 * 为了让用例真的能抓住守卫被删(直接用小预算抓不住 —— mock 太快,elapsed 恒 ≈ 0),
 * 第一条用例直接接管 process.hrtime.bigint 制造「一进循环就已超预算」。
 */
const ACCOUNT = 'ba_ent_guard';
const ENTERPRISE = 'ENTERPRISE_CREDIT';
const BATCH = 200;

function makeHarness(rowsPerBatch = BATCH, perRowUsd = '0.01') {
  const service = Object.create(BillingService.prototype) as any;
  service.logger = { log: jest.fn(), warn: jest.fn(), error: jest.fn() };
  // 账本已对齐,走 RECONCILED_V2 分支(否则 ENTERPRISE_CREDIT 会直接抛)
  const db: any = {
    billingAccount: {
      findUniqueOrThrow: jest.fn(async () => ({
        type: 'enterprise',
        balanceGrantLedgerStatus: 'RECONCILED_V2',
        balanceGrantLedgerVersion: 2,
      })),
    },
    balanceConsumptionAllocation: { count: jest.fn(async () => 0) },
    balanceDebtSettlementPending: { create: jest.fn(async () => ({})) },
    // 核销收尾会尝试释放已还清的准入限制
    billingAccessRestriction: { findMany: jest.fn(async () => []) },
  };
  service.readReconciledBalanceLedgerSnapshot = jest.fn(async () => ({
    walletUsd: new Prisma.Decimal('-100'),
    activeGrantUsd: new Prisma.Decimal(0),
    openDebtUsd: new Prisma.Decimal('100'),
    pendingSettlementUsd: new Prisma.Decimal(0),
    invalidGrantCount: BigInt(0),
    dueGrantCount: BigInt(0),
    invalidDebtCount: BigInt(0),
    invalidSequenceCount: BigInt(0),
    unexpectedDebtCount: BigInt(0),
  }));
  service.assertReconciledBalanceLedgerSnapshot = jest.fn();
  let seq = 0;
  service.findNextBalanceDebtSettlementBatch = jest.fn(async () => ({
    cursorKey: 'bucket:1',
    allocations: Array.from({ length: rowsPerBatch }, () => {
      seq += 1;
      return {
        id: `a${seq}`,
        ledgerSequence: BigInt(seq),
        amountUsd: new Prisma.Decimal(perRowUsd),
        settledUsd: new Prisma.Decimal(0),
      };
    }),
  }));
  service.flushBalanceDebtSettlementBatch = jest.fn(async () => undefined);
  const stats = {
    batches: 0,
    allocationsScanned: 0,
    allocationsUpdated: 0,
    settlementRowsInserted: 0,
    pendingEnqueuedUsd: new Prisma.Decimal(0),
  };
  const params = {
    billingAccountId: ACCOUNT,
    allocationSource: ENTERPRISE,
    repaymentTransactionId: 'tx_recharge_guard',
    balanceGrantId: 'grant_guard',
    paidFillUsd: new Prisma.Decimal('100'),
    bonusFillUsd: new Prisma.Decimal(0),
    financialNow: new Date('2026-09-21T00:00:00.000Z'),
    occurredAt: new Date('2026-09-21T00:00:00.000Z'),
    trigger: 'FUNDING',
  };
  return { service, db, stats, params };
}

describe('settleBalanceDebtOnFundingInner — 降级水位的必有进展守卫', () => {
  const saved = process.env.BALANCE_DEBT_SETTLEMENT_SYNC_BUDGET_MS;
  afterEach(() => {
    if (saved === undefined) delete process.env.BALANCE_DEBT_SETTLEMENT_SYNC_BUDGET_MS;
    else process.env.BALANCE_DEBT_SETTLEMENT_SYNC_BUDGET_MS = saved;
  });

  it('★ 一进循环就已超预算,也必须先核销一批(守卫被删则此用例失败)', async () => {
    process.env.BALANCE_DEBT_SETTLEMENT_SYNC_BUDGET_MS = '1';
    const { service, db, stats, params } = makeHarness();
    // settleStartedAt 取第一个值,之后每次 settleElapsedMs() 都算出 1000ms ≥ 预算
    const real = process.hrtime.bigint;
    let n = 0;
    (process.hrtime as any).bigint = () => {
      n += 1;
      return n === 1 ? BigInt(0) : BigInt(1_000_000_000);
    };
    try {
      const settled = await service.settleBalanceDebtOnFundingInner(db, params, stats);
      // 有守卫:先完成一批(2 元)再把剩余 98 元入队
      expect(stats.batches).toBe(1);
      expect(settled.toFixed(2)).toBe('2.00');
      expect(stats.pendingEnqueuedUsd.toFixed(2)).toBe('98.00');
      // 入队额必须严格小于填洞总额 —— 等于就是零进展
      expect(stats.pendingEnqueuedUsd.lt(params.paidFillUsd)).toBe(true);
    } finally {
      (process.hrtime as any).bigint = real;
    }
  });

  it('预算充足时全部同步核销完,不产生 pending 行', async () => {
    process.env.BALANCE_DEBT_SETTLEMENT_SYNC_BUDGET_MS = '600000';
    const { service, db, stats, params } = makeHarness();
    const settled = await service.settleBalanceDebtOnFundingInner(db, params, stats);

    expect(settled.toFixed(2)).toBe('100.00');
    expect(stats.batches).toBe(50);                      // 100 / (200×0.01)
    expect(stats.pendingEnqueuedUsd.toFixed(2)).toBe('0.00');
    expect(db.balanceDebtSettlementPending.create).not.toHaveBeenCalled();
  });
});
