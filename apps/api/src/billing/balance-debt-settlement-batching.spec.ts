import { Prisma } from '@prisma/client';
import { BillingService } from './billing.service';

/**
 * 欠款核销的分批机制单测:keyset 游标 + 批量写入。
 *
 * billing.service.spec.ts 里的 findMany 桩无视 where,覆盖不到游标语义,
 * 所以这里直接对着两个私有方法测,重点是「不漏行」和「桶键不串」。
 */

const service = Object.create(BillingService.prototype) as any;
const ACCOUNT = 'ba_ent_1';
const ENTERPRISE = 'ENTERPRISE_CREDIT';
const PERSONAL = 'NEGATIVE_BALANCE';

/** 记录每次 findMany 的 where,并按桶返回预置数据 */
function makeDb(byBucket: Record<string, Array<{ id: string; ledgerSequence: bigint }>>) {
  const calls: any[] = [];
  const db: any = {
    balanceConsumptionAllocation: {
      findMany: jest.fn(async ({ where }: any) => {
        calls.push(where);
        const key = bucketKeyOf(where);
        const rows = byBucket[key] ?? [];
        const after = where.ledgerSequence?.gt;
        return after === undefined ? rows : rows.filter((r) => r.ledgerSequence > after);
      }),
    },
  };
  return { db, calls };
}

function bucketKeyOf(where: any): string {
  if (where.fundingClassificationComplete === false) return 'bucket:1';
  if (where.fundingClassificationComplete === true && where.unapprovedDebtUsd) return 'bucket:0';
  if (where.fundingClassificationComplete === true && where.approvedCreditUsd) return 'bucket:2';
  return 'default';
}

describe('findNextBalanceDebtSettlementBatch — keyset 游标', () => {
  it('无游标时不带 ledgerSequence 下界，与原实现一致', async () => {
    const { db, calls } = makeDb({ 'bucket:0': [{ id: 'a1', ledgerSequence: 5n }] });
    const res = await service.findNextBalanceDebtSettlementBatch(db, ACCOUNT, ENTERPRISE);
    expect(res.allocations.map((r: any) => r.id)).toEqual(['a1']);
    expect(calls[0].ledgerSequence).toBeUndefined();
    // settledAt IS NULL 过滤必须保留 —— 游标只是下界，不替代过滤
    expect(calls[0].settledAt).toBeNull();
  });

  it('★ 游标按桶各自生效，不会串到别的桶', async () => {
    const { db, calls } = makeDb({
      'bucket:0': [{ id: 'u1', ledgerSequence: 10n }],
      'bucket:1': [{ id: 'h1', ledgerSequence: 3n }],
    });
    const cursors = new Map<string, bigint>([['bucket:0', 10n]]);
    const res = await service.findNextBalanceDebtSettlementBatch(db, ACCOUNT, ENTERPRISE, cursors);
    // 桶0 被游标滤空 → 回落到桶1；桶1 的序号 3 小于桶0 的游标 10，也必须能取到
    expect(res.cursorKey).toBe('bucket:1');
    expect(res.allocations.map((r: any) => r.id)).toEqual(['h1']);
    expect(calls[0].ledgerSequence).toEqual({ gt: 10n });
    expect(calls[1].ledgerSequence).toBeUndefined();
  });

  it('返回实际使用的 cursorKey，调用方不需要反推桶', async () => {
    const { db } = makeDb({ 'bucket:2': [{ id: 'ap1', ledgerSequence: 7n }] });
    const res = await service.findNextBalanceDebtSettlementBatch(db, ACCOUNT, ENTERPRISE);
    expect(res.cursorKey).toBe('bucket:2');
  });

  it('个人负余额路径用单一 default 游标', async () => {
    const { db, calls } = makeDb({ default: [{ id: 'p1', ledgerSequence: 2n }] });
    const cursors = new Map<string, bigint>([['default', 1n]]);
    const res = await service.findNextBalanceDebtSettlementBatch(db, ACCOUNT, PERSONAL, cursors);
    expect(res.cursorKey).toBe('default');
    expect(calls[0].ledgerSequence).toEqual({ gt: 1n });
    expect(res.allocations.map((r: any) => r.id)).toEqual(['p1']);
  });

  it('三桶都被游标滤空时返回空批，外层据此结束循环', async () => {
    const { db } = makeDb({ 'bucket:1': [{ id: 'h1', ledgerSequence: 3n }] });
    const cursors = new Map<string, bigint>([['bucket:1', 99n]]);
    const res = await service.findNextBalanceDebtSettlementBatch(db, ACCOUNT, ENTERPRISE, cursors);
    expect(res.allocations).toEqual([]);
  });
});

describe('advanceBalanceDebtSettlementCursor', () => {
  it('推进到本批最大 ledgerSequence', () => {
    const cursors = new Map<string, bigint>();
    service.advanceBalanceDebtSettlementCursor(cursors, 'bucket:1', [
      { ledgerSequence: 3n }, { ledgerSequence: 9n }, { ledgerSequence: 7n },
    ]);
    expect(cursors.get('bucket:1')).toBe(9n);
  });

  it('只前进不后退', () => {
    const cursors = new Map<string, bigint>([['bucket:1', 50n]]);
    service.advanceBalanceDebtSettlementCursor(cursors, 'bucket:1', [{ ledgerSequence: 9n }]);
    expect(cursors.get('bucket:1')).toBe(50n);
  });

  it('★ ledgerSequence 为 NULL 时不推进 —— 宁可慢也不能漏行', () => {
    const cursors = new Map<string, bigint>();
    service.advanceBalanceDebtSettlementCursor(cursors, 'bucket:1', [
      { ledgerSequence: null }, { ledgerSequence: undefined as any },
    ]);
    expect(cursors.has('bucket:1')).toBe(false);
  });

  it('不同桶键互不影响', () => {
    const cursors = new Map<string, bigint>();
    service.advanceBalanceDebtSettlementCursor(cursors, 'bucket:0', [{ ledgerSequence: 4n }]);
    service.advanceBalanceDebtSettlementCursor(cursors, 'bucket:2', [{ ledgerSequence: 11n }]);
    expect(cursors.get('bucket:0')).toBe(4n);
    expect(cursors.get('bucket:2')).toBe(11n);
  });
});

describe('flushBalanceDebtSettlementBatch — 批量写入', () => {
  const NOW = new Date('2026-08-28T10:00:00.000Z');

  function makeFlushDb(updatedRows?: number) {
    const db: any = {
      balanceConsumptionAllocation: {
        updateMany: jest.fn(async ({ where }: any) => ({ count: where.id.in.length })),
      },
      enterpriseCreditSettlement: { createMany: jest.fn(async () => ({ count: 0 })) },
      $executeRaw: jest.fn(async (query: any) => (
        updatedRows ?? Math.floor((query.values.length - 1) / 5)
      )),
    };
    return db;
  }

  const write = (id: string, apply: string, paid: string, bonus: string, markSettled: boolean) => ({
    id,
    applyUsd: new Prisma.Decimal(apply),
    applyPaidUsd: new Prisma.Decimal(paid),
    applyBonusUsd: new Prisma.Decimal(bonus),
    markSettled,
  });

  it('三类写入各自一条语句，参数按 12 位定点传递', async () => {
    const db = makeFlushDb();
    await service.flushBalanceDebtSettlementBatch(
      db, NOW, ['z1', 'z2'],
      [write('a1', '1.5', '1.5', '0', true), write('a2', '0.14', '0', '0.14', false)],
      [{ allocationId: 'a1' }, { allocationId: 'a2' }],
    );
    expect(db.balanceConsumptionAllocation.updateMany).toHaveBeenCalledTimes(1);
    expect(db.$executeRaw).toHaveBeenCalledTimes(1);
    expect(db.enterpriseCreditSettlement.createMany).toHaveBeenCalledTimes(1);

    const [query] = db.$executeRaw.mock.calls[0];
    // [financialNow, (id, apply, paid, bonus, markSettled) x 2]
    expect(query.values).toEqual([
      NOW.toISOString(),
      'a1', '1.500000000000', '1.500000000000', '0.000000000000', true,
      'a2', '0.140000000000', '0.000000000000', '0.140000000000', false,
    ]);
    // 增量语义:SQL 里必须是「原值 + 增量」，不是应用侧算好的绝对值
    expect(query.sql).toContain('a."settled_usd" + v.apply_usd');
    expect(query.sql).toContain('WHEN v.mark_settled THEN');
  });

  it('空批不发任何语句', async () => {
    const db = makeFlushDb();
    await service.flushBalanceDebtSettlementBatch(db, NOW, [], [], []);
    expect(db.balanceConsumptionAllocation.updateMany).not.toHaveBeenCalled();
    expect(db.$executeRaw).not.toHaveBeenCalled();
    expect(db.enterpriseCreditSettlement.createMany).not.toHaveBeenCalled();
  });

  it('★ 受影响行数不符立即抛错，让外层事务回滚', async () => {
    const db = makeFlushDb(1);
    await expect(service.flushBalanceDebtSettlementBatch(
      db, NOW, [], [write('a1', '1', '1', '0', true), write('a2', '2', '2', '0', true)], [],
    )).rejects.toThrow('BALANCE_DEBT_SETTLEMENT_BATCH_ROWCOUNT_MISMATCH:expected=2:updated=1');
  });

  it('★ 标记 settledAt 的行数不符同样抛错', async () => {
    const db = makeFlushDb();
    db.balanceConsumptionAllocation.updateMany = jest.fn(async () => ({ count: 1 }));
    await expect(service.flushBalanceDebtSettlementBatch(
      db, NOW, ['z1', 'z2'], [], [],
    )).rejects.toThrow('BALANCE_DEBT_SETTLEMENT_MARK_ROWCOUNT_MISMATCH:expected=2:updated=1');
  });
});

describe('findNextBalanceDebtSettlementBatch — 恒空桶只探一次', () => {
  it('★ 恒空的高优先级桶被标记 exhausted 后不再查询', async () => {
    // 国内 prod 实测(2026-09-20)就是这个形态:bucket0 恒空,而它没有游标可推进
    // (游标只在命中桶上前进)⇒ 不跳过就每批重新 Bitmap Heap Scan 掉 191,940 行、
    // 2.8 万个堆页、108ms 才能确认它是空的。全额核销 1,466 批即白烧 158 秒。
    const { db, calls } = makeDb({ 'bucket:1': [{ id: 'h1', ledgerSequence: 1n }] });
    const exhausted = new Set<string>();
    await service.findNextBalanceDebtSettlementBatch(
      db, ACCOUNT, ENTERPRISE, undefined, exhausted,
    );
    expect(exhausted.has('bucket:0')).toBe(true);
    const probedFirstPass = calls.length;
    await service.findNextBalanceDebtSettlementBatch(
      db, ACCOUNT, ENTERPRISE, undefined, exhausted,
    );
    expect(calls.slice(probedFirstPass).map(bucketKeyOf)).not.toContain('bucket:0');
  });

  it('命中的桶不标记 exhausted —— 它下一批还要继续取', async () => {
    const { db } = makeDb({ 'bucket:0': [{ id: 'u1', ledgerSequence: 1n }] });
    const exhausted = new Set<string>();
    await service.findNextBalanceDebtSettlementBatch(
      db, ACCOUNT, ENTERPRISE, undefined, exhausted,
    );
    expect(exhausted.size).toBe(0);
  });

  it('不传 exhausted 时行为与原实现完全一致', async () => {
    const { db, calls } = makeDb({ 'bucket:1': [{ id: 'h1', ledgerSequence: 1n }] });
    await service.findNextBalanceDebtSettlementBatch(db, ACCOUNT, ENTERPRISE);
    await service.findNextBalanceDebtSettlementBatch(db, ACCOUNT, ENTERPRISE);
    // 两遍都探了 bucket0 —— 保证这个优化是纯可选项,老调用方不受影响
    expect(calls.map(bucketKeyOf).filter((k) => k === 'bucket:0')).toHaveLength(2);
  });
});

describe('assertReconciledBalanceLedgerSnapshot — 三项式不变量', () => {
  const D = (v: string | number) => new Prisma.Decimal(v);
  const snapshot = (over: Record<string, any> = {}) => ({
    walletUsd: D(0),
    activeGrantUsd: D(0),
    openDebtUsd: D(0),
    pendingSettlementUsd: D(0),
    invalidGrantCount: BigInt(0),
    dueGrantCount: BigInt(0),
    invalidDebtCount: BigInt(0),
    invalidSequenceCount: BigInt(0),
    unexpectedDebtCount: BigInt(0),
    ...over,
  });

  it('pending 为 0 时退化为原两项式', () => {
    expect(() => service.assertReconciledBalanceLedgerSnapshot(
      ACCOUNT, snapshot({ walletUsd: D(-100), openDebtUsd: D(100) }), 'test',
    )).not.toThrow();
  });

  it('★ 已入账未核销的部分不计入钱包应对应的欠款', () => {
    // 充 1,000 后:钱包从 -26,176.89 变 -25,176.89,但 29.3 万行债务一行都还没核销,
    // 差额记在 pending 上。两项式会在这里误判成账本损坏并把账户隔离。
    expect(() => service.assertReconciledBalanceLedgerSnapshot(
      ACCOUNT,
      snapshot({
        walletUsd: D('-25176.89'),
        openDebtUsd: D('26176.89'),
        pendingSettlementUsd: D('1000'),
      }),
      'test',
    )).not.toThrow();
  });

  it('★ 充值超过欠款时 pending 吸收全部欠款,钱包转正', () => {
    expect(() => service.assertReconciledBalanceLedgerSnapshot(
      ACCOUNT,
      snapshot({
        walletUsd: D('3823.11'),
        activeGrantUsd: D('3823.11'),
        openDebtUsd: D('26176.89'),
        pendingSettlementUsd: D('26176.89'),
      }),
      'test',
    )).not.toThrow();
  });

  it('三项式对不上仍然抛错 —— 不是把断言放宽', () => {
    expect(() => service.assertReconciledBalanceLedgerSnapshot(
      ACCOUNT,
      snapshot({
        walletUsd: D('-25176.89'),
        openDebtUsd: D('26176.89'),
        pendingSettlementUsd: D('999'),
      }),
      'test',
    )).toThrow(/openDebt=26176\.890000000000:pendingSettlement=999\.000000000000/);
  });
});
