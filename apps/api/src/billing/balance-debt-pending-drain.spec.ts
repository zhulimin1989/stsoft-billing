import { Prisma } from '@prisma/client';
import { BillingService } from './billing.service';

/**
 * settlePendingBalanceDebtOnce 的单测。
 *
 * 重点锁两件事:
 * 1) 「先删 pending 行、再走 settleBalanceDebtOnFunding」的顺序。顺序反了,
 *    既有的前置快照推导(finalDebt + remainingTotal)会把这条 pending 重复计一次,
 *    账户立刻被判成账本损坏并隔离 —— 这是整个异步化唯一的顺序性要求。
 * 2) pending 表不加外键,所以还款交易归属必须在这里重新校验;
 *    只信队列侧会把 settlement 挂到别的账户的还款上。
 */
const ACCOUNT = 'ba_ent_1';
const TX = 'tx_recharge_1';

function makeService(pendingRows: any[]) {
  const service = Object.create(BillingService.prototype) as any;
  const order: string[] = [];
  const db: any = {
    $queryRaw: jest.fn(async (strings: any) => {
      const sql = Array.isArray(strings) ? strings.join(' ') : String(strings);
      if (sql.includes('balance_debt_settlement_pending')) {
        order.push('select-pending');
        return pendingRows;
      }
      if (sql.includes('account_wallets')) return [{ balance_usd: new Prisma.Decimal(-100) }];
      return [];
    }),
    balanceTransaction: {
      findUnique: jest.fn(async () => ({
        billingAccountId: ACCOUNT,
        createdAt: new Date('2026-09-20T02:54:07.000Z'),
      })),
    },
    balanceDebtSettlementPending: {
      delete: jest.fn(async () => { order.push('delete-pending'); }),
    },
  };
  service.prisma = { $transaction: async (fn: any) => fn(db) };
  service.lockBalanceLedgerAndCaptureFinancialNow = jest.fn(async () => new Date());
  service.billingAccountNotProvisioned = () => new Error('NOT_PROVISIONED');
  service.settleBalanceDebtOnFunding = jest.fn(async () => {
    order.push('settle');
    return new Prisma.Decimal('1000');
  });
  return { service, db, order };
}

const pendingRow = {
  id: 'pending_1',
  billing_account_id: ACCOUNT,
  allocation_source: 'ENTERPRISE_CREDIT',
  repayment_transaction_id: TX,
  balance_grant_id: 'grant_1',
  remaining_paid_usd: new Prisma.Decimal('1000'),
  remaining_bonus_usd: new Prisma.Decimal('0'),
};

describe('settlePendingBalanceDebtOnce', () => {
  it('队列为空时不做任何事', async () => {
    const { service, order } = makeService([]);
    const res = await service.settlePendingBalanceDebtOnce();
    expect(res.picked).toBe(false);
    expect(order).toEqual(['select-pending']);
  });

  it('★ 先删 pending 行,再调 settleBalanceDebtOnFunding', async () => {
    const { service, order } = makeService([pendingRow]);
    const res = await service.settlePendingBalanceDebtOnce();
    expect(res.picked).toBe(true);
    expect(res.pendingId).toBe('pending_1');
    expect(order).toEqual(['select-pending', 'delete-pending', 'settle']);
  });

  it('把 pending 的剩余额度原样交给核销,并以 FUNDING 身份续做', async () => {
    const { service } = makeService([pendingRow]);
    await service.settlePendingBalanceDebtOnce();
    const args = service.settleBalanceDebtOnFunding.mock.calls[0][1];
    expect(args.paidFillUsd.toFixed(12)).toBe('1000.000000000000');
    expect(args.bonusFillUsd.toFixed(12)).toBe('0.000000000000');
    expect(args.repaymentTransactionId).toBe(TX);
    expect(args.balanceGrantId).toBe('grant_1');
    expect(args.trigger).toBe('FUNDING');
    // 守恒触发器要求 settlement.occurred_at 严格等于该还款交易的 created_at,
    // 所以这里必须取交易自己的时间,不能用 worker 的时钟。
    expect(args.occurredAt.toISOString()).toBe('2026-09-20T02:54:07.000Z');
  });

  it('★ 还款交易不属于该账户时拒绝核销', async () => {
    const { service, db, order } = makeService([pendingRow]);
    db.balanceTransaction.findUnique = jest.fn(async () => ({
      billingAccountId: 'ba_other',
      createdAt: new Date(),
    }));
    await expect(service.settlePendingBalanceDebtOnce())
      .rejects.toThrow(/BALANCE_DEBT_PENDING_TRANSACTION_MISMATCH/);
    expect(order).not.toContain('delete-pending');
    expect(order).not.toContain('settle');
  });

  it('还款交易不存在时同样拒绝', async () => {
    const { service, db } = makeService([pendingRow]);
    db.balanceTransaction.findUnique = jest.fn(async () => null);
    await expect(service.settlePendingBalanceDebtOnce())
      .rejects.toThrow(/BALANCE_DEBT_PENDING_TRANSACTION_MISMATCH/);
  });
});
