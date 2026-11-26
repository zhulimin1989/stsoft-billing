import { createHash } from 'crypto';
import { BadRequestException } from '@nestjs/common';
import { EnterpriseBillsService, USAGE_EXPORT_PAGE_SIZE } from './enterprise-bills.service';
import { yearMonthInBeijing } from './enterprise-bills.policy';
import { usd, usdToCents } from './money';

const NOW = new Date('2026-09-08T04:00:00.000Z');

describe('EnterpriseBillsService', () => {
  it('lists every Beijing month from open date and tags the current month', async () => {
    const { service } = createService({
      consumeCentsByMonth: { '2026-08': 500, '2026-09': 280 },
    });

    const bills = await service.listBills('ba-1', { now: NOW, canManage: true });

    expect(bills.map((row) => row.yearMonth)).toEqual([
      '2026-09',
      '2026-08',
      '2026-07',
      '2026-06',
      '2026-05',
      '2026-04',
    ]);
    expect(bills[0]).toEqual(expect.objectContaining({
      yearMonth: '2026-09',
      currentMonth: true,
      status: '待核销',
      consumeCents: 280,
      writeOffDisabledReason: '当月仅支持下载与补偿发券',
    }));
    expect(bills[1]).toEqual(expect.objectContaining({
      yearMonth: '2026-08',
      currentMonth: false,
      status: '待核销',
      consumeCents: 500,
      writeOffDisabledReason: null,
    }));
    expect(bills[2]).toEqual(expect.objectContaining({
      yearMonth: '2026-07',
      status: '已核销',
      consumeCents: 0,
      remainingDays: null,
    }));
  });

  it('listBills live-sums Excel-summary consume/token and ignores month_summaries amounts', async () => {
    const { service, queryRawSql, summaries } = createService({
      consumeCentsByMonth: { '2026-08': 500, '2026-09': 280 },
    });
    summaries.push({
      billingAccountId: 'ba-1',
      yearMonth: '2026-08',
      paidCents: 0,
      pendingCents: 1,
      adjustedCents: 0,
      issuedVoucherCents: 0,
      consumeCents: 1,
      voucherCents: 0,
      chargeCents: 1,
      tokenTotal: 9,
      requestCount: 9,
      effectiveDueAt: null,
      dueProjected: false,
    });

    const bills = await service.listBills('ba-1', { now: NOW, canManage: true });
    const august = bills.find((row) => row.yearMonth === '2026-08');

    expect(august).toEqual(expect.objectContaining({
      // 与 Excel 账单汇总同口径：折后消耗 + 分量 token（mock 里用 amountUsd 派生）
      consumeCents: 500,
      tokenTotal: 5000,
      requestCount: 1,
    }));
    expect(queryRawSql.some((sql) => sql.includes('live-export-usage'))).toBe(true);
    expect(queryRawSql.some((sql) => sql.includes('AT TIME ZONE \'UTC\''))).toBe(true);
    // 不再扫账本 CONSUME 作为列表消耗
    expect(queryRawSql.some((sql) => sql.includes('live-consume'))).toBe(false);
  });

  it('listBills does not query or return voucher or charge columns', async () => {
    const { service, queryRawSql } = createService({
      consumeCentsByMonth: { '2026-08': 500, '2026-09': 280 },
    });

    const bills = await service.listBills('ba-1', { now: NOW, canManage: true });

    expect(queryRawSql.some((sql) => sql.includes('live-voucher'))).toBe(false);
    for (const bill of bills) {
      expect(bill).not.toHaveProperty('voucherCents');
      expect(bill).not.toHaveProperty('chargeCents');
    }
  });

  it('rejects write-off on the current month before any event is stored', async () => {
    const { service, events } = createService({
      consumeCentsByMonth: { '2026-09': 280 },
    });

    await expect(service.writeOff('ba-1', '2026-09', {
      amountCents: 100,
      note: '当月不可核销',
      actorId: 'admin-1',
      canManage: true,
      now: NOW,
      idempotencyKey: 'idem-bill-1',
    })).rejects.toThrow(BadRequestException);
    expect(events).toHaveLength(0);
  });

  it('rejects write-off without an idempotency key', async () => {
    const { service } = createService({
      consumeCentsByMonth: { '2026-08': 500 },
    });
    await expect(service.writeOff('ba-1', '2026-08', {
      amountCents: 100,
      note: '回款',
      actorId: 'admin-1',
      canManage: true,
      now: NOW,
    })).rejects.toThrow('idempotencyKey 不能为空');
  });

  it('rejects write-off without a note', async () => {
    const { service, events } = createService({
      consumeCentsByMonth: { '2026-08': 500 },
    });
    await expect(service.writeOff('ba-1', '2026-08', {
      amountCents: 100,
      note: '   ',
      actorId: 'admin-1',
      canManage: true,
      now: NOW,
      idempotencyKey: 'idem-bill-2',
    })).rejects.toThrow('备注必填');
    expect(events).toHaveLength(0);
  });

  it('accepts a closed-month write-off and folds it into 已核销', async () => {
    const { service, events } = createService({
      consumeCentsByMonth: { '2026-08': 500 },
    });

    await service.writeOff('ba-1', '2026-08', {
      amountCents: 200,
      note: '回款差异',
      actorId: 'admin-1',
      canManage: true,
      now: NOW,
      idempotencyKey: 'idem-bill-3',
    });
    const august = (await service.listBills('ba-1', { now: NOW, canManage: true }))
      .find((row) => row.yearMonth === '2026-08');

    expect(august).toEqual(expect.objectContaining({
      paidCents: 200,
      pendingCents: 300,
      status: '已核销',
    }));

    await service.writeOff('ba-1', '2026-08', {
      amountCents: 200,
      note: '回款差异',
      actorId: 'admin-1',
      canManage: true,
      now: NOW,
      idempotencyKey: 'idem-bill-3',
    });
    expect(events.filter((row) => row.type === 'WRITE_OFF')).toHaveLength(1);
    const replayed = (await service.listBills('ba-1', { now: NOW, canManage: true }))
      .find((row) => row.yearMonth === '2026-08');
    expect(replayed?.paidCents).toBe(200);
  });

  it('rejects write-off replay when the same key carries a different amount or note', async () => {
    const { service, events } = createService({
      consumeCentsByMonth: { '2026-08': 500 },
    });
    const first = {
      amountCents: 200,
      note: '回款差异',
      actorId: 'admin-1',
      canManage: true,
      now: NOW,
      idempotencyKey: 'idem-bill-3b',
    };
    await service.writeOff('ba-1', '2026-08', first);
    await expect(service.writeOff('ba-1', '2026-08', {
      ...first,
      amountCents: 300,
    })).rejects.toMatchObject({
      response: { code: 'enterprise_bill_idempotency_conflict' },
    });
    await expect(service.writeOff('ba-1', '2026-08', {
      ...first,
      note: '另一备注',
    })).rejects.toMatchObject({
      response: { code: 'enterprise_bill_idempotency_conflict' },
    });
    expect(events.filter((row) => row.type === 'WRITE_OFF')).toHaveLength(1);
    const august = (await service.listBills('ba-1', { now: NOW, canManage: true }))
      .find((row) => row.yearMonth === '2026-08');
    expect(august?.paidCents).toBe(200);
  });

  it('rejects adjust replay when the same key carries a different amount or note', async () => {
    const { service, events } = createService({
      consumeCentsByMonth: { '2026-08': 500 },
    });
    const first = {
      direction: 'decrease' as const,
      amountCents: 50,
      note: '客户确认差异',
      actorId: 'admin-1',
      canManage: true,
      now: NOW,
      idempotencyKey: 'idem-bill-5b',
    };
    await service.adjust('ba-1', '2026-08', first);
    await service.adjust('ba-1', '2026-08', first);
    expect(events.filter((row) => row.type === 'ADJUST')).toHaveLength(1);
    await expect(service.adjust('ba-1', '2026-08', {
      ...first,
      amountCents: 80,
    })).rejects.toMatchObject({
      response: { code: 'enterprise_bill_idempotency_conflict' },
    });
    await expect(service.adjust('ba-1', '2026-08', {
      ...first,
      direction: 'increase',
    })).rejects.toMatchObject({
      response: { code: 'enterprise_bill_idempotency_conflict' },
    });
    const august = (await service.listBills('ba-1', { now: NOW, canManage: true }))
      .find((row) => row.yearMonth === '2026-08');
    expect(august?.adjustedCents).toBe(-50);
  });

  it('lists closed months from the Excel live window, not the freeze snapshot', async () => {
    const { service, store, queryRawSql, tokenUsageFindManyCalls } = createService({
      consumeCentsByMonth: { '2026-08': 500 },
    });
    await closeAllHistorical(service);
    store.extraConsumeCentsByMonth['2026-08'] = 120;
    const after = (await service.listBills('ba-1', { now: NOW, canManage: true }));
    const august = after.find((row) => row.yearMonth === '2026-08');
    const september = after.find((row) => row.yearMonth === '2026-09');
    // 定格后落在该自然月内的用量仍进列表，与 Excel 账单汇总同一窗口
    expect(august?.consumeCents).toBe(620);
    expect(september?.consumeCents).toBe(0);
    expect(queryRawSql.some((sql) => sql.includes('live-export-usage'))).toBe(true);
    expect(tokenUsageFindManyCalls()).toBe(0);
  });

  it('does not move the wallet on write-off or adjust', async () => {
    const movements: Array<{ amountCents: number; description: string }> = [];
    const { service } = createService({
      consumeCentsByMonth: { '2026-08': 500 },
      wallet: {
        applyMovement: async (input) => {
          movements.push({ amountCents: input.amountCents, description: input.description });
        },
      },
    });

    await service.writeOff('ba-1', '2026-08', {
      amountCents: 100,
      note: '回款',
      actorId: 'admin-1',
      canManage: true,
      now: NOW,
      idempotencyKey: 'idem-bill-4',
    });
    await service.adjust('ba-1', '2026-08', {
      direction: 'decrease',
      amountCents: 50,
      note: '客户确认差异',
      actorId: 'admin-1',
      canManage: true,
      now: NOW,
      idempotencyKey: 'idem-bill-5',
    });
    await service.adjust('ba-1', '2026-08', {
      direction: 'increase',
      amountCents: 20,
      note: '补记差异',
      actorId: 'admin-1',
      canManage: true,
      now: NOW,
      idempotencyKey: 'idem-bill-6',
    });

    expect(movements).toEqual([]);
    const august = (await service.listBills('ba-1', { now: NOW, canManage: true }))
      .find((row) => row.yearMonth === '2026-08');
    expect(august).toEqual(expect.objectContaining({
      paidCents: 100,
      adjustedCents: -30,
      pendingCents: 370,
      receivableCents: 470,
      issuedVoucherCents: 0,
    }));
  });

  it('lets issued compensate voucher reduce receivable and pending', async () => {
    const vouchers: Array<{ amountCents: number; reason: string; idempotencyKey: string }> = [];
    const movements: Array<{ amountCents: number }> = [];
    const { service, events } = createService({
      consumeCentsByMonth: { '2026-08': 500 },
      wallet: {
        applyMovement: async (input) => {
          movements.push({ amountCents: input.amountCents });
        },
        issuePaygVoucher: async (input) => {
          vouchers.push({
            amountCents: input.amountCents,
            reason: input.reason,
            idempotencyKey: input.idempotencyKey,
          });
        },
      },
    });

    await service.writeOff('ba-1', '2026-08', {
      amountCents: 200,
      note: '回款',
      actorId: 'admin-1',
      canManage: true,
      now: NOW,
      idempotencyKey: 'idem-bill-7',
    });
    await service.compensateVoucher('ba-1', '2026-08', {
      amountCents: 100,
      note: '多收补偿',
      productId: 'prod-1',
      actorId: 'admin-1',
      canManage: true,
      now: NOW,
      idempotencyKey: 'idem-compensate-1',
    });

    expect(vouchers).toEqual([expect.objectContaining({
      amountCents: 100,
      idempotencyKey: 'enterprise-bill-compensate:idem-compensate-1',
    })]);
    expect(movements).toEqual([]);
    expect(events.filter((row) => row.type === 'COMPENSATE_VOUCHER')).toEqual([
      expect.objectContaining({ amountCents: 100, status: 'CONFIRMED' }),
    ]);
    const august = (await service.listBills('ba-1', { now: NOW, canManage: true }))
      .find((row) => row.yearMonth === '2026-08');
    expect(august).toEqual(expect.objectContaining({
      issuedVoucherCents: 100,
      // 应收 = 500 + 0 − 100；待付款 = max(0, 500 + 0 − 100 − 200)
      receivableCents: 400,
      pendingCents: 200,
      paidCents: 200,
    }));

    await service.compensateVoucher('ba-1', '2026-08', {
      amountCents: 100,
      note: '多收补偿',
      productId: 'prod-1',
      actorId: 'admin-1',
      canManage: true,
      now: NOW,
      idempotencyKey: 'idem-compensate-1',
    });
    expect(vouchers).toHaveLength(1);
    expect(events.filter((row) => row.type === 'COMPENSATE_VOUCHER')).toHaveLength(1);
    const replayed = (await service.listBills('ba-1', { now: NOW, canManage: true }))
      .find((row) => row.yearMonth === '2026-08');
    expect(replayed?.issuedVoucherCents).toBe(100);
  });

  it('rejects compensate replay when the same key carries a different amount or note', async () => {
    const vouchers: Array<{ amountCents: number }> = [];
    const { service, events } = createService({
      consumeCentsByMonth: { '2026-08': 500 },
      wallet: {
        applyMovement: async () => undefined,
        issuePaygVoucher: async (input: { amountCents: number }) => {
          vouchers.push({ amountCents: input.amountCents });
        },
      },
    });
    const first = {
      amountCents: 100,
      note: '多收补偿',
      productId: 'prod-1',
      actorId: 'admin-1',
      canManage: true,
      now: NOW,
      idempotencyKey: 'idem-compensate-1b',
    };
    await service.writeOff('ba-1', '2026-08', {
      amountCents: 200,
      note: '回款',
      actorId: 'admin-1',
      canManage: true,
      now: NOW,
      idempotencyKey: 'idem-bill-compensate-setup',
    });
    await service.compensateVoucher('ba-1', '2026-08', first);
    await expect(service.compensateVoucher('ba-1', '2026-08', {
      ...first,
      amountCents: 200,
    })).rejects.toMatchObject({
      response: { code: 'enterprise_bill_idempotency_conflict' },
    });
    await expect(service.compensateVoucher('ba-1', '2026-08', {
      ...first,
      note: '另一备注',
    })).rejects.toMatchObject({
      response: { code: 'enterprise_bill_idempotency_conflict' },
    });
    expect(events.filter((row) => row.type === 'COMPENSATE_VOUCHER')).toHaveLength(1);
    expect(vouchers).toHaveLength(1);
    const august = (await service.listBills('ba-1', { now: NOW, canManage: true }))
      .find((row) => row.yearMonth === '2026-08');
    expect(august?.issuedVoucherCents).toBe(100);
  });

  it('retries FAILED compensate using the event amount, not a later request amount', async () => {
    const vouchers: number[] = [];
    let failOnce = true;
    const { service, events } = createService({
      consumeCentsByMonth: { '2026-08': 500 },
      wallet: {
        applyMovement: async () => undefined,
        issuePaygVoucher: async (input: { amountCents: number }) => {
          if (failOnce) {
            failOnce = false;
            throw new Error('wallet down');
          }
          vouchers.push(input.amountCents);
        },
      },
    });
    const body = {
      amountCents: 100,
      note: '多收补偿',
      productId: 'prod-1',
      actorId: 'admin-1',
      canManage: true,
      now: NOW,
      idempotencyKey: 'idem-compensate-failed',
    };
    await service.writeOff('ba-1', '2026-08', {
      amountCents: 200,
      note: '回款',
      actorId: 'admin-1',
      canManage: true,
      now: NOW,
      idempotencyKey: 'idem-bill-failed-setup',
    });
    await expect(service.compensateVoucher('ba-1', '2026-08', body)).rejects.toThrow('wallet down');
    expect(events.filter((row) => row.type === 'COMPENSATE_VOUCHER')).toEqual([
      expect.objectContaining({ amountCents: 100, status: 'FAILED' }),
    ]);
    await service.compensateVoucher('ba-1', '2026-08', body);
    expect(vouchers).toEqual([100]);
    expect(events.filter((row) => row.type === 'COMPENSATE_VOUCHER')).toEqual([
      expect.objectContaining({ amountCents: 100, status: 'CONFIRMED' }),
    ]);
    const august = (await service.listBills('ba-1', { now: NOW, canManage: true }))
      .find((row) => row.yearMonth === '2026-08');
    expect(august?.issuedVoucherCents).toBe(100);
  });

  it('confirms PENDING compensate using the event amount for voucher and summary', async () => {
    const vouchers: number[] = [];
    const { service, events, summaries } = createService({
      consumeCentsByMonth: { '2026-08': 500 },
      wallet: {
        applyMovement: async () => undefined,
        issuePaygVoucher: async (input: { amountCents: number }) => {
          vouchers.push(input.amountCents);
        },
      },
    });
    await service.writeOff('ba-1', '2026-08', {
      amountCents: 200,
      note: '回款',
      actorId: 'admin-1',
      canManage: true,
      now: NOW,
      idempotencyKey: 'idem-bill-pending-setup',
    });
    events.push({
      id: specBillEventId('compensate', 'ba-1', '2026-08', 'idem-compensate-pending'),
      billingAccountId: 'ba-1',
      yearMonth: '2026-08',
      type: 'COMPENSATE_VOUCHER',
      amountCents: 100,
      note: '多收补偿',
      actorId: 'admin-1',
      status: 'PENDING',
      createdAt: NOW,
    });
    await service.compensateVoucher('ba-1', '2026-08', {
      amountCents: 100,
      note: '多收补偿',
      productId: 'prod-1',
      actorId: 'admin-1',
      canManage: true,
      now: NOW,
      idempotencyKey: 'idem-compensate-pending',
    });
    expect(vouchers).toEqual([100]);
    expect(events.filter((row) => row.type === 'COMPENSATE_VOUCHER')).toHaveLength(1);
    expect(events.find((row) => row.type === 'COMPENSATE_VOUCHER')?.status).toBe('CONFIRMED');
    const august = (await service.listBills('ba-1', { now: NOW, canManage: true }))
      .find((row) => row.yearMonth === '2026-08');
    expect(august?.issuedVoucherCents).toBe(100);
    expect(summaries.some((row) =>
      row.yearMonth === '2026-08' && Number(row.issuedVoucherCents) === 100,
    )).toBe(true);
  });

  it('sets list paidCents from FUNDING by consume-date month and write-off; account pay is separate', async () => {
    const { service } = createService({
      consumeCentsByMonth: { '2026-08': 500, '2026-09': 280 },
      allocations: [
        {
          billingAccountId: 'ba-1',
          source: 'BALANCE_GRANT',
          balanceGrantId: 'grant-1',
          recognizedRevenueUsd: 1,
          bonusConsumedUsd: 0,
          createdAt: new Date('2026-08-10T04:00:00.000Z'),
        },
        {
          billingAccountId: 'ba-1',
          source: 'ENTERPRISE_CREDIT',
          balanceGrantId: null,
          recognizedRevenueUsd: 4,
          bonusConsumedUsd: 0,
          amountUsd: 4,
          approvedCreditUsd: 4,
          unapprovedDebtUsd: 0,
          fundingClassificationComplete: true,
          createdAt: new Date('2026-08-12T04:00:00.000Z'),
        },
      ],
      settlements: [
        {
          billingAccountId: 'ba-1',
          trigger: 'FUNDING',
          amountUsd: 1.5,
          allocation: { createdAt: new Date('2026-08-20T04:00:00.000Z') },
          createdAt: new Date('2026-10-05T04:00:00.000Z'),
        },
        {
          billingAccountId: 'ba-1',
          trigger: 'FUNDING',
          amountUsd: 0.8,
          allocation: { createdAt: new Date('2026-09-02T04:00:00.000Z') },
          createdAt: new Date('2026-10-06T04:00:00.000Z'),
        },
      ],
    });

    await service.writeOff('ba-1', '2026-08', {
      amountCents: 50,
      note: '线下直收',
      actorId: 'admin-1',
      canManage: true,
      now: NOW,
      idempotencyKey: 'idem-bill-8',
    });
    const bills = await service.listBills('ba-1', { now: NOW, canManage: true });
    const august = bills.find((row) => row.yearMonth === '2026-08');
    const september = bills.find((row) => row.yearMonth === '2026-09');

    // ADR-0021：已付款 = FUNDING(150) + 核销(50)；账户支付(100)单独列，从应收扣减
    expect(august).toEqual(expect.objectContaining({
      accountPayCents: 100,
      creditPayCents: 400,
      debtPayCents: 0,
      paidCents: 200,
      pendingCents: 200,
    }));
    expect(september).toEqual(expect.objectContaining({
      paidCents: 80,
      pendingCents: 200,
    }));
  });

  it('sets prepaid list paidCents from FUNDING/write-off only; account pay is separate', async () => {
    const { service, store } = createService({
      consumeCentsByMonth: { '2026-08': 500, '2026-09': 280 },
      allocations: [
        {
          billingAccountId: 'ba-1',
          source: 'BALANCE_GRANT',
          balanceGrantId: 'grant-1',
          recognizedRevenueUsd: 5,
          bonusConsumedUsd: 0,
          createdAt: new Date('2026-08-10T04:00:00.000Z'),
        },
        {
          billingAccountId: 'ba-1',
          source: 'BALANCE_GRANT',
          balanceGrantId: 'grant-2',
          recognizedRevenueUsd: 2.8,
          bonusConsumedUsd: 0,
          createdAt: new Date('2026-09-10T04:00:00.000Z'),
        },
      ],
    });
    store.account.creditConfig = {
      status: 'DISABLED',
      limitUsd: 0,
      termsDays: 0,
      effectiveAt: new Date('2026-04-01T00:00:00.000Z'),
      expiresAt: null,
      policyRevision: 0,
      policyBoundaryComplete: false,
    };

    const bills = await service.listBills('ba-1', { now: NOW, canManage: true });
    const august = bills.find((row) => row.yearMonth === '2026-08');
    const september = bills.find((row) => row.yearMonth === '2026-09');
    expect(august).toEqual(expect.objectContaining({
      prepaid: true,
      paidCents: 0,
      accountPayCents: 500,
      pendingCents: 0,
      status: '已核销',
      writeOffDisabledReason: '预付款账户无需核销',
    }));
    expect(september).toEqual(expect.objectContaining({
      prepaid: true,
      paidCents: 0,
      accountPayCents: 280,
      pendingCents: 0,
      // 已付款为 0，补偿发券禁用（ADR-0021）
      compensateDisabledReason: '已付款为0不可补偿发券',
    }));
  });

  it('rounds FUNDING paidCents once after summing USD (not per settlement row)', async () => {
    // 3×0.005：按条 ROUND 得 1+1+1=3；先 SUM 再 ROUND 得 ROUND(1.5)=2（与三渠道口径一致）
    const { service } = createService({
      consumeCentsByMonth: { '2026-08': 2 },
      allocations: [
        {
          billingAccountId: 'ba-1',
          source: 'ENTERPRISE_CREDIT',
          balanceGrantId: null,
          recognizedRevenueUsd: 0.015,
          bonusConsumedUsd: 0,
          createdAt: new Date('2026-08-20T04:00:00.000Z'),
        },
      ],
      settlements: [0, 1, 2].map((i) => ({
        billingAccountId: 'ba-1',
        trigger: 'FUNDING',
        amountUsd: 0.005,
        allocation: { createdAt: new Date(`2026-08-2${i}T04:00:00.000Z`) },
        createdAt: new Date('2026-08-28T04:00:00.000Z'),
      })),
    });

    const august = (await service.listBills('ba-1', { now: NOW, canManage: true }))
      .find((row) => row.yearMonth === '2026-08');
    expect(august).toEqual(expect.objectContaining({
      paidCents: 2,
      pendingCents: 0,
    }));
  });

  it('rounds 欠款 once after summing USD (3×0.005 → 2, not 3)', async () => {
    const { service } = createService({
      consumeCentsByMonth: { '2026-08': 2 },
      allocations: [0, 1, 2].map((i) => ({
        billingAccountId: 'ba-1',
        source: 'ENTERPRISE_CREDIT',
        balanceGrantId: null,
        recognizedRevenueUsd: '0',
        bonusConsumedUsd: '0',
        amountUsd: '0.005',
        approvedCreditUsd: '0',
        unapprovedDebtUsd: '0.005',
        fundingClassificationComplete: true,
        createdAt: new Date(`2026-08-2${i}T04:00:00.000Z`),
      })),
    });

    const august = (await service.listBills('ba-1', { now: NOW, canManage: true }))
      .find((row) => row.yearMonth === '2026-08');
    expect(august).toEqual(expect.objectContaining({
      creditPayCents: 0,
      debtPayCents: 2,
    }));
  });

  it('counts FUNDING into prepaid list paidCents so unapproved-debt months clear pending (头文)', async () => {
    // 无正式授信配置 → prepaid；余额耗尽后 ENTERPRISE_CREDIT / unapproved_debt，
    // 充值 FUNDING 已冲销完毕时，已付款必须含 FUNDING，待付款应为 0（PRD 0928）。
    const { service, store } = createService({
      consumeCentsByMonth: { '2026-08': 19, '2026-09': 2977 },
      allocations: [
        {
          billingAccountId: 'ba-1',
          source: 'ENTERPRISE_CREDIT',
          balanceGrantId: null,
          recognizedRevenueUsd: '0.18524456',
          bonusConsumedUsd: '0',
          amountUsd: '0.18524456',
          approvedCreditUsd: '0',
          unapprovedDebtUsd: '0.18524456',
          fundingClassificationComplete: true,
          createdAt: new Date('2026-08-20T04:00:00.000Z'),
        },
        {
          billingAccountId: 'ba-1',
          source: 'ENTERPRISE_CREDIT',
          balanceGrantId: null,
          recognizedRevenueUsd: '29.76890614',
          bonusConsumedUsd: '0',
          amountUsd: '29.76890614',
          approvedCreditUsd: '0',
          unapprovedDebtUsd: '29.76890614',
          fundingClassificationComplete: true,
          createdAt: new Date('2026-09-15T04:00:00.000Z'),
        },
      ],
      settlements: [
        {
          billingAccountId: 'ba-1',
          trigger: 'FUNDING',
          amountUsd: '0.18524456',
          allocation: { createdAt: new Date('2026-08-20T04:00:00.000Z') },
          createdAt: new Date('2026-08-21T04:00:00.000Z'),
        },
        {
          billingAccountId: 'ba-1',
          trigger: 'FUNDING',
          amountUsd: '29.76890614',
          allocation: { createdAt: new Date('2026-09-15T04:00:00.000Z') },
          createdAt: new Date('2026-09-29T14:20:00.000Z'),
        },
      ],
    });
    // 与生产头文一致：无完整授信策略边界 → prepaid（缺 config 行时 isPrepaidFromConfig 同为 true）
    store.account.creditConfig = {
      status: 'DISABLED',
      limitUsd: 0,
      termsDays: 0,
      effectiveAt: new Date('2026-04-01T00:00:00.000Z'),
      expiresAt: null,
      policyRevision: 0,
      policyBoundaryComplete: false,
    };

    const bills = await service.listBills('ba-1', { now: NOW, canManage: true });
    const august = bills.find((row) => row.yearMonth === '2026-08');
    const september = bills.find((row) => row.yearMonth === '2026-09');

    expect(august).toEqual(expect.objectContaining({
      prepaid: true,
      creditPayCents: 0,
      debtPayCents: 19,
      accountPayCents: 0,
      paidCents: 19,
      pendingCents: 0,
      status: '已核销',
    }));
    expect(september).toEqual(expect.objectContaining({
      prepaid: true,
      creditPayCents: 0,
      debtPayCents: 2977,
      accountPayCents: 0,
      paidCents: 2977,
      pendingCents: 0,
      status: '已核销',
    }));
  });

  it('allows compensate on the current month when list paid is positive', async () => {
    const { service, store } = createService({
      consumeCentsByMonth: { '2026-09': 280 },
      settlements: [
        {
          billingAccountId: 'ba-1',
          trigger: 'FUNDING',
          amountUsd: 1.2,
          allocation: { createdAt: new Date('2026-09-02T04:00:00.000Z') },
          createdAt: new Date('2026-10-06T04:00:00.000Z'),
        },
      ],
    });
    // 授信户当月：已付款来自 FUNDING，补偿发券不因「当月仅支持下载与补偿发券」禁用
    store.account.creditConfig = {
      status: 'ACTIVE',
      limitUsd: 100,
      termsDays: 30,
      effectiveAt: new Date('2026-04-01T00:00:00.000Z'),
      expiresAt: null,
      policyRevision: 1,
      policyBoundaryComplete: true,
    };

    const current = (await service.listBills('ba-1', { now: NOW, canManage: true }))
      .find((row) => row.yearMonth === '2026-09');
    expect(current).toEqual(expect.objectContaining({
      currentMonth: true,
      writeOffDisabledReason: '当月仅支持下载与补偿发券',
      adjustDisabledReason: '当月仅支持下载与补偿发券',
      extendDisabledReason: '当月仅支持下载与补偿发券',
      compensateDisabledReason: null,
      paidCents: 120,
    }));
  });

  it('allows adjust decrease that leaves pending negative (ADR-0021)', async () => {
    const { service } = createService({
      consumeCentsByMonth: { '2026-08': 500 },
    });

    await service.adjust('ba-1', '2026-08', {
      direction: 'decrease',
      amountCents: 600,
      note: '客户确认差异超扣费',
      actorId: 'admin-1',
      canManage: true,
      now: NOW,
      idempotencyKey: 'idem-bill-9',
    });
    const august = (await service.listBills('ba-1', { now: NOW, canManage: true }))
      .find((row) => row.yearMonth === '2026-08');
    expect(august).toEqual(expect.objectContaining({
      adjustedCents: -600,
      pendingCents: -100,
      receivableCents: -100,
      status: '已核销',
    }));
  });

  it('rejects adjust without a reason', async () => {
    const { service } = createService({
      consumeCentsByMonth: { '2026-08': 500 },
    });
    await expect(service.adjust('ba-1', '2026-08', {
      direction: 'increase',
      amountCents: 10,
      note: '   ',
      actorId: 'admin-1',
      canManage: true,
      now: NOW,
      idempotencyKey: 'idem-bill-10',
    })).rejects.toThrow(BadRequestException);
  });

  it('confirms write-off without calling the wallet even if applyMovement would fail', async () => {
    const { service, events } = createService({
      consumeCentsByMonth: { '2026-08': 500 },
      wallet: {
        applyMovement: async () => {
          throw new Error('wallet down');
        },
      },
    });
    await service.writeOff('ba-1', '2026-08', {
      amountCents: 100,
      note: '回款',
      actorId: 'admin-1',
      canManage: true,
      now: NOW,
      idempotencyKey: 'idem-bill-11',
    });
    expect(events).toEqual([
      expect.objectContaining({ type: 'WRITE_OFF', status: 'CONFIRMED', amountCents: 100 }),
    ]);
    const august = (await service.listBills('ba-1', { now: NOW, canManage: true }))
      .find((row) => row.yearMonth === '2026-08');
    expect(august).toEqual(expect.objectContaining({ paidCents: 100, pendingCents: 400 }));
  });

  it('keeps PENDING events out of the bill math until the wallet settles', async () => {
    const { service, events } = createService({
      consumeCentsByMonth: { '2026-08': 500 },
    });
    // 模拟钱包结果未落定的悬置事件（如状态标记失败后的安全中间态）
    events.push({
      id: 'evt-pending',
      billingAccountId: 'ba-1',
      yearMonth: '2026-08',
      type: 'WRITE_OFF',
      amountCents: 200,
      dueAt: null,
      note: null,
      actorId: 'admin-1',
      status: 'PENDING',
      createdAt: NOW,
    });
    const august = (await service.listBills('ba-1', { now: NOW, canManage: true }))
      .find((row) => row.yearMonth === '2026-08');
    expect(august).toEqual(expect.objectContaining({ paidCents: 0, pendingCents: 500 }));
  });

  it('returns a locally assembled bill identical to the next list query', async () => {
    const { service } = createService({
      consumeCentsByMonth: { '2026-08': 500 },
    });
    const written = await service.writeOff('ba-1', '2026-08', {
      amountCents: 200,
      note: '回款',
      actorId: 'admin-1',
      canManage: true,
      now: NOW,
      idempotencyKey: 'idem-bill-12',
    });
    const listedAfterWrite = (await service.listBills('ba-1', { now: NOW, canManage: true }))
      .find((row) => row.yearMonth === '2026-08');
    expect(written).toEqual(listedAfterWrite);

    const adjusted = await service.adjust('ba-1', '2026-08', {
      direction: 'increase',
      amountCents: 50,
      note: '补记差异',
      actorId: 'admin-1',
      canManage: true,
      now: NOW,
      idempotencyKey: 'idem-bill-13',
    });
    const listedAfterAdjust = (await service.listBills('ba-1', { now: NOW, canManage: true }))
      .find((row) => row.yearMonth === '2026-08');
    expect(adjusted).toEqual(listedAfterAdjust);
  });

  it('serializes each write path behind the account-scoped advisory lock before creating events', async () => {
    const { service, txStats, writeLog } = createService({
      consumeCentsByMonth: { '2026-08': 500 },
      deadlines: [{
        billingAccountId: 'ba-1',
        yearMonth: '2026-08',
        termsDays: 30,
        defaultDueAt: new Date('2026-09-30T15:59:59.000Z'),
        frozenAt: new Date('2026-09-01T00:00:00.000Z'),
        pendingAtDeadline: null,
        pendingObservedAt: null,
      }],
    });

    await service.writeOff('ba-1', '2026-08', {
      amountCents: 100,
      note: '回款',
      actorId: 'admin-1',
      canManage: true,
      now: NOW,
      idempotencyKey: 'idem-bill-14',
    });
    await service.adjust('ba-1', '2026-08', {
      direction: 'decrease',
      amountCents: 50,
      note: '客户确认差异',
      actorId: 'admin-1',
      canManage: true,
      now: NOW,
      idempotencyKey: 'idem-bill-15',
    });
    await service.extend('ba-1', '2026-08', {
      newDueAt: new Date('2026-11-15T15:59:59.000Z'),
      actorId: 'admin-1',
      canManage: true,
      now: NOW,
      idempotencyKey: 'idem-extend-lock',
    });

    // 每个写请求：先取账户级锁，再落事件（校验快照与事件落定被串行化）
    expect(txStats.txCalls).toBe(3);
    expect(txStats.lockCalls).toBe(3);
    expect(writeLog).toEqual([
      'advisory-lock',
      'event-create',
      'advisory-lock',
      'event-create',
      'advisory-lock',
      'event-create',
    ]);
  });

  it('keeps a frozen deadline when credit terms later change', async () => {
    const { service, store } = createService({
      consumeCentsByMonth: { '2026-08': 500 },
    });

    await closeAllHistorical(service);
    store.account.creditConfig.termsDays = 7;
    const august = (await service.listBills('ba-1', { now: NOW, canManage: true }))
      .find((row) => row.yearMonth === '2026-08');

    expect(august?.dueAt).toBe('2026-09-30T15:59:59.000Z');
    expect(august?.termsDays).toBe(30);
  });

  it('summarizes earliest unpaid due date and AR used credit', async () => {
    const { service } = createService({
      consumeCentsByMonth: { '2026-08': 500, '2026-09': 280 },
    });
    await closeAllHistorical(service);

    const [summary] = await service.summarizeAccounts(['ba-1'], NOW);

    expect(summary.billingAccountId).toBe('ba-1');
    expect(summary.earliestDueAt).toBe('2026-09-30T15:59:59.000Z');
    expect(summary.dueWarning).toBe(false);
    expect(summary.usedCents).toBe(500);
    expect(summary.prepaid).toBe(false);
  });

  it('shows the frozen due date on closed months and the original due date once extended', async () => {
    const { service } = createService({
      consumeCentsByMonth: { '2026-08': 500 },
    });
    await closeAllHistorical(service);

    await service.extend('ba-1', '2026-08', {
      newDueAt: new Date('2026-11-15T15:59:59.000Z'),
      actorId: 'admin-1',
      canManage: true,
      now: NOW,
      idempotencyKey: 'idem-extend-frozen',
    });
    const august = (await service.listBills('ba-1', { now: NOW, canManage: true }))
      .find((row) => row.yearMonth === '2026-08');

    expect(august?.dueAt).toBe('2026-11-15T15:59:59.000Z');
    expect(august?.originalDueAt).toBe('2026-09-30T15:59:59.000Z');
    expect(august?.extended).toBe(true);
  });

  it('rejects extend without an idempotency key', async () => {
    const { service } = createService({
      consumeCentsByMonth: { '2026-08': 500 },
    });
    await closeAllHistorical(service);
    await expect(service.extend('ba-1', '2026-08', {
      newDueAt: new Date('2026-11-15T15:59:59.000Z'),
      actorId: 'admin-1',
      canManage: true,
      now: NOW,
    })).rejects.toThrow('idempotencyKey 不能为空');
  });

  it('replays a confirmed extend with the same key and dueAt instead of inserting again', async () => {
    const { service, events } = createService({
      consumeCentsByMonth: { '2026-08': 500 },
    });
    await closeAllHistorical(service);
    const first = {
      newDueAt: new Date('2026-11-15T15:59:59.000Z'),
      actorId: 'admin-1',
      canManage: true,
      now: NOW,
      idempotencyKey: 'idem-extend-1',
    };
    const created = await service.extend('ba-1', '2026-08', first);
    expect(created.replayed).toBe(false);
    const replayed = await service.extend('ba-1', '2026-08', first);
    expect(replayed.replayed).toBe(true);
    expect(replayed.dueAt).toBe('2026-11-15T15:59:59.000Z');
            expect(events.filter((row) => row.type === 'EXTEND')).toHaveLength(1);
    expect(events.find((row) => row.type === 'EXTEND')?.id).toBe(
      specBillEventId('extend', 'ba-1', '2026-08', 'idem-extend-1'),
    );
  });

  it('rejects extend replay when the same key carries a different dueAt', async () => {
    const { service, events } = createService({
      consumeCentsByMonth: { '2026-08': 500 },
    });
    await closeAllHistorical(service);
    const first = {
      newDueAt: new Date('2026-11-15T15:59:59.000Z'),
      actorId: 'admin-1',
      canManage: true,
      now: NOW,
      idempotencyKey: 'idem-extend-1b',
    };
    await service.extend('ba-1', '2026-08', first);
    await expect(service.extend('ba-1', '2026-08', {
      ...first,
      newDueAt: new Date('2026-12-15T15:59:59.000Z'),
    })).rejects.toMatchObject({
      response: { code: 'enterprise_bill_idempotency_conflict' },
    });
    expect(events.filter((row) => row.type === 'EXTEND')).toHaveLength(1);
    const august = (await service.listBills('ba-1', { now: NOW, canManage: true }))
      .find((row) => row.yearMonth === '2026-08');
    expect(august?.dueAt).toBe('2026-11-15T15:59:59.000Z');
  });

  it('evaluates overdue from set SQL rather than per-account fan-out', async () => {
    const {
      service,
      queryRawSql,
      deadlineFindManyWheres,
      summaryFindManyWheres,
      eventFindManyWheres,
    } = createService({
      consumeCentsByMonth: { '2026-06': 400 },
    });
    const overdueNow = new Date('2026-08-15T04:00:00.000Z');
    await closeAllHistorical(service, overdueNow);
    deadlineFindManyWheres.length = 0;
    summaryFindManyWheres.length = 0;
    eventFindManyWheres.length = 0;
    queryRawSql.length = 0;

    const decision = await service.evaluateOverdue(overdueNow);

    expect(decision.suspend).toEqual(['ba-1']);
    expect(deadlineFindManyWheres).toEqual([]);
    expect(summaryFindManyWheres).toEqual([]);
    expect(eventFindManyWheres).toEqual([]);
    expect(queryRawSql.some((sql) => sql.includes('overdue-latch-rearm'))).toBe(true);
    expect(queryRawSql.some((sql) => sql.includes('overdue-latch-observe'))).toBe(true);
    expect(queryRawSql.some((sql) => sql.includes('overdue-credit-states'))).toBe(true);
  });

  it('does not flag delayed-usage months for auto-suspend', async () => {
    const { service } = createService({
      consumeCentsByMonth: { '2026-06': 0 },
      overdueNow: new Date('2026-08-15T04:00:00.000Z'),
    });

    await closeAllHistorical(service, new Date('2026-07-15T04:00:00.000Z'));
    const first = await service.evaluateOverdue(new Date('2026-08-15T04:00:00.000Z'));
    expect(first.suspend).toEqual([]);

    const { service: later } = createService({
      consumeCentsByMonth: { '2026-06': 400 },
      deadlines: [{
        billingAccountId: 'ba-1',
        yearMonth: '2026-06',
        termsDays: 30,
        defaultDueAt: new Date('2026-07-30T15:59:59.000Z'),
        frozenAt: new Date('2026-07-01T00:00:00.000Z'),
        pendingAtDeadline: false,
        pendingObservedAt: new Date('2026-08-01T00:00:00.000Z'),
      }],
    });
    const second = await later.evaluateOverdue(new Date('2026-08-15T04:00:00.000Z'));
    expect(second.suspend).toEqual([]);
  });

  it('does not restore a manually suspended account even with no overdue bills', async () => {
    const { service, store, deadlines } = createService({
      consumeCentsByMonth: { '2026-06': 400 },
    });
    const overdueNow = new Date('2026-08-15T04:00:00.000Z');
    await closeAllHistorical(service, overdueNow);
    await service.evaluateOverdue(new Date('2026-08-01T00:00:00.000Z'));
    expect(deadlines.find((row) => row.yearMonth === '2026-06')?.pendingAtDeadline).toBe(true);
    const decision = await service.evaluateOverdue(overdueNow);
    expect(decision.suspend).toEqual(['ba-1']);

    // 人工暂停（最新授信事件不是 auto_suspend）→ 即使清账也不自动恢复。
    store.account.creditConfig.status = 'SUSPENDED';
    store.latestCreditEventReason = 'manual_risk_pause';
    await service.writeOff('ba-1', '2026-06', {
      amountCents: 400,
      note: '回款',
      actorId: 'admin-1',
      canManage: true,
      now: overdueNow,
      idempotencyKey: 'idem-bill-16',
    });
    const manual = await service.evaluateOverdue(overdueNow);
    expect(manual.restore).toEqual([]);

    // 逾期作业暂停（最新事件 reason = auto_suspend）→ 清账后恢复。
    store.latestCreditEventReason = 'monthly_bill_overdue_auto_suspend';
    const auto = await service.evaluateOverdue(overdueNow);
    expect(auto.restore).toEqual(['ba-1']);
  });

  it('restores suspended accounts once every overdue bill is written down to 待付款 ≤ 0', async () => {
    const { service, store, deadlines } = createService({
      consumeCentsByMonth: { '2026-06': 400 },
    });
    const overdueNow = new Date('2026-08-15T04:00:00.000Z');
    await closeAllHistorical(service, overdueNow);

    // Latch 待核销 at the deadline, then the overdue sweep suspends the credit.
    await service.evaluateOverdue(new Date('2026-08-01T00:00:00.000Z'));
    const latched = deadlines.find((row) => row.yearMonth === '2026-06');
    expect(latched?.pendingAtDeadline).toBe(true);
    const decision = await service.evaluateOverdue(overdueNow);
    expect(decision.suspend).toEqual(['ba-1']);
    store.account.creditConfig.status = 'SUSPENDED';
    store.latestCreditEventReason = 'monthly_bill_overdue_auto_suspend';

    // Still 待付款 > 0 → no restore.
    const stillOverdue = await service.evaluateOverdue(overdueNow);
    expect(stillOverdue.restore).toEqual([]);

    // Write the month down to 待付款 = 0 → restore.
    await service.writeOff('ba-1', '2026-06', {
      amountCents: 400,
      note: '回款',
      actorId: 'admin-1',
      canManage: true,
      now: overdueNow,
      idempotencyKey: 'idem-bill-17',
    });
    const cleared = await service.evaluateOverdue(overdueNow);
    expect(cleared.restore).toEqual(['ba-1']);
  });

  it('re-arms the deadline after an EXTEND and re-observes 待核销 at the new due date', async () => {
    const { service, deadlines } = createService({
      consumeCentsByMonth: { '2026-06': 400 },
    });
    deadlines.push({
      billingAccountId: 'ba-1',
      yearMonth: '2026-06',
      termsDays: 30,
      defaultDueAt: new Date('2026-07-30T15:59:59.000Z'),
      frozenAt: new Date('2026-07-01T00:00:00.000Z'),
      frozenConsumeCents: null,
      frozenVoucherCents: null,
      frozenChargeCents: null,
      frozenTokenTotal: null,
      frozenRequestCount: null,
      amountsFrozenAt: null,
      pendingAtDeadline: false,
      pendingObservedAt: new Date('2026-08-01T00:00:00.000Z'),
    });
    const beforeExtend = await service.evaluateOverdue(new Date('2026-08-15T04:00:00.000Z'));
    expect(beforeExtend.suspend).toEqual([]);

    await service.extend('ba-1', '2026-06', {
      newDueAt: new Date('2026-08-20T15:59:59.000Z'),
      actorId: 'admin-1',
      canManage: true,
      now: new Date('2026-08-15T04:00:00.000Z'),
      idempotencyKey: 'idem-extend-rearm',
    });
    const row = deadlines.find((item) => item.yearMonth === '2026-06');
    expect(row?.pendingAtDeadline).toBeNull();

    const afterNewDeadline = await service.evaluateOverdue(new Date('2026-08-25T04:00:00.000Z'));
    expect(afterNewDeadline.suspend).toEqual(['ba-1']);
  });

  it('projects 账期到期时间 for credit current month but keeps overdue sweep off', async () => {
    const { service } = createService({
      consumeCentsByMonth: { '2026-09': 280 },
    });

    const [summary] = await service.summarizeAccounts(['ba-1'], NOW);
    expect(summary.earliestDueAt).toBeNull();
    expect(summary.earliestDueProjected).toBe(false);
    expect(summary.dueWarning).toBe(false);

    const current = (await service.listBills('ba-1', { now: NOW, canManage: true }))
      .find((row) => row.yearMonth === '2026-09');
    expect(current?.dueAt).toBe('2026-10-30T15:59:59.000Z');
    expect(current?.dueProjected).toBe(true);
    expect(current?.remainingDays).toEqual(expect.any(Number));
    expect(current?.writeOffDisabledReason).toBe('当月仅支持下载与补偿发券');
    expect(current?.extendDisabledReason).toBe('当月仅支持下载与补偿发券');

    const overdue = await service.evaluateOverdue(NOW);
    expect(overdue.suspend).not.toContain('ba-1');
  });

  it('closes every historical closed month with listBills live amounts and rewrites on rerun', async () => {
    const { service, summaries } = createService({
      consumeCentsByMonth: { '2026-04': 100, '2026-08': 500 },
    });

    const first = await service.closeHistoricalClosedMonths(NOW);
    expect(first).toEqual(expect.objectContaining({
      skipped: false,
      yearMonth: '2026-08',
      yearMonths: ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08'],
      processed: 5,
      hasMore: false,
      billingAccountId: 'ba-1',
    }));
    const august = summaries.find((row) => row.yearMonth === '2026-08');
    expect(august).toEqual(expect.objectContaining({
      pendingCents: 500,
      consumeCents: 500,
      effectiveDueAt: expect.any(Date),
    }));
    expect(summaries.some((row) => row.yearMonth === '2026-09')).toBe(false);

    const listAugust = (await service.listBills('ba-1', { now: NOW, canManage: true }))
      .find((row) => row.yearMonth === '2026-08');
    expect(august?.pendingCents).toBe(listAugust?.pendingCents);
    expect((august?.effectiveDueAt as Date | null)?.toISOString()).toBe(listAugust?.dueAt);

    // 再次 close：已闭月仍按 listBills 现算重写（不再因「已有三者」跳过）
    const again = await service.closeHistoricalClosedMonths(NOW);
    expect(again).toEqual(expect.objectContaining({
      skipped: false,
      yearMonth: '2026-08',
      yearMonths: ['2026-04', '2026-05', '2026-06', '2026-07', '2026-08'],
      processed: 5,
      hasMore: false,
    }));
  });

  it('holds the close lock without a prisma transaction and loads one account months at a time', async () => {
    const { service, txStats, queryRawSql, deadlineFindManyWheres, summaryFindManyWheres } = createService({
      consumeCentsByMonth: { '2026-04': 100, '2026-08': 500 },
    });

    await service.closeHistoricalClosedMonths(NOW);

    expect(txStats.txCalls).toBe(0);
    expect(queryRawSql.some((sql) => sql.includes('pg_try_advisory_lock'))).toBe(true);
    expect(queryRawSql.some((sql) => sql.includes('pg_advisory_unlock'))).toBe(true);
    expect(queryRawSql.some((sql) => sql.includes('pg_try_advisory_xact_lock'))).toBe(false);
    expect(deadlineFindManyWheres).toEqual([{ billingAccountId: 'ba-1' }]);
    // close 按户只拉 deadline；汇总由 listBills 现算后 upsert
    expect(summaryFindManyWheres).toEqual([]);
  });

  it('close rewrites stale closed-month summary to listBills without changing freeze', async () => {
    const { service, summaries, deadlines } = createService({
      consumeCentsByMonth: { '2026-08': 500 },
    });
    await closeAllHistorical(service);
    const frozenAt = new Date('2026-09-01T00:00:00.000Z');
    const row = deadlines.find((item) => item.yearMonth === '2026-08');
    expect(row).toBeTruthy();
    row!.frozenConsumeCents = 0;
    row!.frozenVoucherCents = 0;
    row!.frozenChargeCents = 0;
    row!.amountsFrozenAt = frozenAt;
    const summary = summaries.find((item) => item.yearMonth === '2026-08');
    expect(summary).toBeTruthy();
    summary!.pendingCents = 0;
    summary!.consumeCents = 0;
    summary!.effectiveDueAt = null;

    const closed = await service.closeHistoricalClosedMonths(NOW, { billingAccountId: 'ba-1' });
    expect(closed.processed).toBeGreaterThan(0);
    expect(closed.billingAccountId).toBe('ba-1');
    expect(row!.frozenConsumeCents).toBe(0);
    expect(row!.amountsFrozenAt).toEqual(frozenAt);
    expect(summary).toEqual(expect.objectContaining({
      pendingCents: 500,
      consumeCents: 500,
      effectiveDueAt: expect.any(Date),
    }));
    const listAugust = (await service.listBills('ba-1', { now: NOW, canManage: true }))
      .find((item) => item.yearMonth === '2026-08');
    expect(summary!.pendingCents).toBe(listAugust?.pendingCents);
    const dueAt = summary!.effectiveDueAt as Date | null;
    expect(dueAt).toEqual(expect.any(Date));
    expect(dueAt!.toISOString()).toBe(listAugust?.dueAt);
    const [account] = await service.summarizeAccounts(['ba-1'], NOW);
    expect(account.earliestDueAt).toBe(dueAt!.toISOString());
  });

  it('updates the month summary when write-off confirms', async () => {
    const { service, summaries } = createService({
      consumeCentsByMonth: { '2026-08': 500 },
    });
    await closeAllHistorical(service);
    await service.writeOff('ba-1', '2026-08', {
      amountCents: 200,
      note: '回款差异',
      actorId: 'admin-1',
      canManage: true,
      now: NOW,
      idempotencyKey: 'idem-bill-18',
    });
    const august = summaries.find((row) => row.yearMonth === '2026-08');
    expect(august).toEqual(expect.objectContaining({
      paidCents: 200,
      pendingCents: 300,
    }));
  });

  it('does not project 账期到期时间 for prepaid current month', async () => {
    const { service, store } = createService({
      consumeCentsByMonth: { '2026-09': 280 },
    });
    store.account.creditConfig = {
      status: 'DISABLED',
      limitUsd: 0,
      termsDays: 0,
      effectiveAt: new Date('2026-04-01T00:00:00.000Z'),
      expiresAt: null,
      policyRevision: 0,
      policyBoundaryComplete: false,
    };

    const [summary] = await service.summarizeAccounts(['ba-1'], NOW);
    expect(summary.prepaid).toBe(true);
    expect(summary.earliestDueAt).toBeNull();
    expect(summary.earliestDueProjected).toBe(false);

    const current = (await service.listBills('ba-1', { now: NOW, canManage: true }))
      .find((row) => row.yearMonth === '2026-09');
    expect(current?.dueAt).toBeNull();
    expect(current?.dueProjected).toBe(false);
    expect(current?.remainingDays).toBeNull();
  });

  it('listBills and summarize keep consume above INT4 when Prisma returns bigint cents', async () => {
    const overInt4 = 3_000_000_000;
    const { service, summaries } = createService({
      consumeCentsByMonth: { '2026-09': overInt4 },
    });
    summaries.push({
      billingAccountId: 'ba-1',
      yearMonth: '2026-09',
      paidCents: 0n,
      pendingCents: BigInt(overInt4),
      adjustedCents: 0n,
      issuedVoucherCents: 0n,
      consumeCents: BigInt(overInt4),
      voucherCents: 0n,
      chargeCents: BigInt(overInt4),
      tokenTotal: 0n,
      requestCount: 0n,
      effectiveDueAt: null,
      dueProjected: true,
    });

    const [account] = await service.summarizeAccounts(['ba-1'], NOW);
    expect(account.usedCents).toBe(overInt4);

    const current = (await service.listBills('ba-1', { now: NOW, canManage: true }))
      .find((row) => row.yearMonth === '2026-09');
    expect(current?.consumeCents).toBe(overInt4);
    expect(current?.pendingCents).toBe(overInt4);
    expect(current).not.toHaveProperty('chargeCents');
  });

  it('aggregates live consume and list-paid as bigint not int4', async () => {
    const { service, queryRawSql } = createService({
      consumeCentsByMonth: { '2026-09': 280 },
    });

    await service.refreshCurrentMonthSummaries(NOW);

    const exportSql = queryRawSql.find((sql) => sql.includes('live-export-usage'));
    const channelSql = queryRawSql.find((sql) => sql.includes('mapFinanceApiUsageRows'));
    expect(exportSql).toMatch(/::bigint AS "consumeCents"/i);
    expect(channelSql).toMatch(/::bigint AS "accountPayCents"/i);
    expect(channelSql).toMatch(/::bigint AS "debtPayCents"/i);
    expect(exportSql).not.toMatch(/::int AS "consumeCents"/i);
    expect(channelSql).not.toMatch(/::int AS "accountPayCents"/i);
    // 三渠道与消耗同口径：先 SUM(USD) 再 ROUND 到分，禁止逐行 ROUND 再 SUM
    expect(channelSql).toMatch(/ROUND\(\s*SUM\(\s*ABS\(/i);
    expect(channelSql).not.toMatch(/SUM\(\s*ROUND\(\s*ABS\(/i);
  });

  it('list summarize reads snapshots only and does not live-sum a missing current month', async () => {
    const {
      service,
      queryRawSql,
      summaries,
      accountFindUniqueIds,
      summaryFindManyWheres,
      eventFindManyWheres,
    } = createService({
      consumeCentsByMonth: { '2026-09': 280 },
    });

    const [first] = await service.summarizeAccounts(['ba-1', 'ba-2', 'ba-1'], NOW);
    expect(first.usedCents).toBe(0);
    expect(first.earliestDueAt).toBeNull();
    expect(accountFindUniqueIds).toEqual(['ba-1', 'ba-2']);
    expect(summaryFindManyWheres).toEqual([{ billingAccountId: { in: ['ba-1', 'ba-2'] } }]);
    expect(eventFindManyWheres).toEqual([]);
    expect(queryRawSql.some((sql) => sql.includes('live-usage') || sql.includes('token_usage'))).toBe(false);
    expect(queryRawSql.some((sql) => sql.includes('live-consume'))).toBe(false);
    expect(summaries.some((row) => row.yearMonth === '2026-09')).toBe(false);

    summaries.push({
      billingAccountId: 'ba-1',
      yearMonth: '2026-09',
      paidCents: 0,
      pendingCents: 280,
      adjustedCents: 0,
      issuedVoucherCents: 0,
      consumeCents: 280,
      voucherCents: 0,
      chargeCents: 280,
      tokenTotal: 0,
      requestCount: 0,
      effectiveDueAt: new Date('2026-10-30T15:59:59.000Z'),
      dueProjected: true,
    });
    queryRawSql.length = 0;
    accountFindUniqueIds.length = 0;
    summaryFindManyWheres.length = 0;
    eventFindManyWheres.length = 0;
    const [second] = await service.summarizeAccounts(['ba-1'], NOW);
    expect(second.usedCents).toBe(280);
    expect(second.earliestDueAt).toBe('2026-10-30T15:59:59.000Z');
    expect(accountFindUniqueIds).toEqual(['ba-1']);
    expect(summaryFindManyWheres).toEqual([{ billingAccountId: { in: ['ba-1'] } }]);
    expect(eventFindManyWheres).toEqual([]);
    expect(queryRawSql.some((sql) => sql.includes('live-consume'))).toBe(false);
  });

  it('refreshCurrentMonthSummaries writes token totals with live-export-usage', async () => {
    const { service, summaries, queryRawSql } = createService({
      consumeCentsByMonth: { '2026-09': 280 },
    });

    const result = await service.refreshCurrentMonthSummaries(NOW);

    expect(result).toEqual({
      skipped: false,
      yearMonth: '2026-09',
      processed: 1,
      fundingProcessed: 0,
      hasMore: false,
    });
    expect(queryRawSql.some((sql) => sql.includes('live-export-usage'))).toBe(true);
    expect(summaries.some((row) =>
      row.yearMonth === '2026-09'
      && row.consumeCents === 280
      && Number(row.tokenTotal) === 2800
    )).toBe(true);
    expect(summaries.filter((row) => row.yearMonth === '2026-09')).toHaveLength(1);
  });

  it('holds the refresh lock without a prisma transaction and runs funding inside it', async () => {
    const { service, txStats, queryRawSql } = createService({
      consumeCentsByMonth: { '2026-09': 280 },
    });
    const refreshFunding = jest.fn(async () => 4);

    const result = await service.refreshCurrentMonthSummaries(NOW, refreshFunding);

    expect(result).toEqual({
      skipped: false,
      yearMonth: '2026-09',
      processed: 1,
      fundingProcessed: 4,
      hasMore: false,
    });
    expect(refreshFunding).toHaveBeenCalledTimes(1);
    expect(txStats.txCalls).toBe(0);
    expect(queryRawSql.some((sql) => sql.includes('pg_try_advisory_lock'))).toBe(true);
    expect(queryRawSql.some((sql) => sql.includes('pg_advisory_unlock'))).toBe(true);
    expect(queryRawSql.some((sql) => sql.includes('pg_try_advisory_xact_lock'))).toBe(false);
  });

  it('skips live-sum and funding when the refresh lock is held', async () => {
    const { service, summaries, queryRawSql } = createService({
      consumeCentsByMonth: { '2026-09': 280 },
      advisoryLockAcquired: false,
    });
    const refreshFunding = jest.fn(async () => 4);

    const result = await service.refreshCurrentMonthSummaries(NOW, refreshFunding);

    expect(result).toEqual({
      skipped: true,
      yearMonth: '2026-09',
      processed: 0,
      fundingProcessed: 0,
      hasMore: true,
    });
    expect(refreshFunding).not.toHaveBeenCalled();
    expect(queryRawSql.some((sql) => sql.includes('live-export-usage'))).toBe(false);
    expect(summaries.some((row) => row.yearMonth === '2026-09')).toBe(false);
  });

  it('download pushes 日×工作区×模型 aggregation into SQL instead of paging token_usage', async () => {
    const { service, queryRawSql, tokenUsageFindManyWheres } = createService({
      consumeCentsByMonth: { '2026-08': 500 },
    });

    const file = await service.download('ba-1', '2026-08', { now: NOW });
    const chunks: Buffer[] = [];
    for await (const chunk of file.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(file.filename).toContain('2026-08');
    expect(Buffer.concat(chunks).length).toBeGreaterThan(0);
    // 头文 9 月 115 万行：逐行分页是导出超时的主因，默认不再走 findMany。
    expect(tokenUsageFindManyWheres).toHaveLength(0);
    expect(queryRawSql.filter((sql) => sql.includes('usage-aggregate-pushdown'))).toHaveLength(1);
    // 汇总与明细同源：导出不再跑第二条 export-summary 全扫 SQL。
    expect(queryRawSql.some((sql) => sql.includes('export-summary'))).toBe(false);
    expect(queryRawSql.some((sql) => sql.includes('export-ledger-consume'))).toBe(false);
  });

  it('download resolves before the usage aggregation finishes so headers can flush early', async () => {
    let releaseAggregate!: () => void;
    const aggregateGate = new Promise<void>((resolve) => {
      releaseAggregate = resolve;
    });
    const { service } = createService({
      consumeCentsByMonth: { '2026-08': 500 },
      aggregateGate,
    });

    // 聚合还卡着，download() 必须已经把 stream 交回来；否则响应头只能等聚合结束，
    // 浏览器在这段时间里看不到任何下载条目。
    let guard: NodeJS.Timeout | undefined;
    const file = await Promise.race([
      service.download('ba-1', '2026-08', { now: NOW }),
      new Promise<never>((_resolve, reject) => {
        guard = setTimeout(() => reject(new Error('download blocked on aggregation')), 1000);
      }),
    ]);
    if (guard) clearTimeout(guard);
    expect(file.filename).toContain('2026-08');

    releaseAggregate();
    const chunks: Buffer[] = [];
    for await (const chunk of file.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).length).toBeGreaterThan(0);
  });

  it('download can fall back to the row scan with ENTERPRISE_BILL_EXPORT_ROW_SCAN=1', async () => {
    process.env.ENTERPRISE_BILL_EXPORT_ROW_SCAN = '1';
    try {
      const { service, queryRawSql, tokenUsageFindManyWheres } = createService({
        consumeCentsByMonth: { '2026-08': 500 },
      });
      const file = await service.download('ba-1', '2026-08', { now: NOW });
      const chunks: Buffer[] = [];
      for await (const chunk of file.stream) {
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
      }
      expect(Buffer.concat(chunks).length).toBeGreaterThan(0);
      expect(tokenUsageFindManyWheres.length).toBeGreaterThan(0);
      expect(queryRawSql.some((sql) => sql.includes('usage-aggregate-pushdown'))).toBe(false);
    } finally {
      delete process.env.ENTERPRISE_BILL_EXPORT_ROW_SCAN;
    }
  });

  it('download derives 汇总 from the same single usage pass instead of a second full scan', async () => {
    const { service, queryRawSql, tokenUsageFindManyWheres } = createService({
      consumeCentsByMonth: { '2026-08': 500 },
    });

    const file = await service.download('ba-1', '2026-08', { now: NOW });

    expect(file.filename).toContain('2026-08');
    expect(queryRawSql.some((sql) => sql.includes('mapFinanceApiUsageRows'))).toBe(false);

    const chunks: Buffer[] = [];
    for await (const chunk of file.stream) {
      chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    expect(Buffer.concat(chunks).length).toBeGreaterThan(0);
    // 头文 9 月级数据：一遍聚合同时出汇总与明细，避免逐行扫描与第二遍全表扫描。
    expect(queryRawSql.filter((sql) => sql.includes('usage-aggregate-pushdown'))).toHaveLength(1);
    expect(queryRawSql.some((sql) => sql.includes('export-summary'))).toBe(false);
    expect(tokenUsageFindManyWheres).toHaveLength(0);
  });
});

function createService(opts: {
  advisoryLockAcquired?: boolean;
  consumeCentsByMonth?: Record<string, number>;
  /** 卡住「日×工作区×模型」聚合 SQL，用于验证 download() 不会阻塞在聚合上。 */
  aggregateGate?: Promise<void>;
  allocations?: Array<{
    billingAccountId: string;
    source: string;
    balanceGrantId: string | null;
    recognizedRevenueUsd: number | string;
    bonusConsumedUsd: number | string;
    amountUsd?: number | string;
    approvedCreditUsd?: number | string;
    unapprovedDebtUsd?: number | string;
    fundingClassificationComplete?: boolean;
    createdAt: Date;
  }>;
  settlements?: Array<{
    billingAccountId: string;
    trigger: string;
    amountUsd: number | string;
    allocation: { createdAt: Date };
    createdAt: Date;
  }>;
  deadlines?: Array<{
    billingAccountId: string;
    yearMonth: string;
    termsDays: number;
    defaultDueAt: Date;
    frozenAt: Date;
    frozenConsumeCents?: number | null;
    frozenVoucherCents?: number | null;
    frozenChargeCents?: number | null;
    frozenTokenTotal?: number | null;
    frozenRequestCount?: number | null;
    amountsFrozenAt?: Date | null;
    pendingAtDeadline: boolean | null;
    pendingObservedAt: Date | null;
  }>;
  overdueNow?: Date;
  wallet?: {
    applyMovement: (input: {
      billingAccountId: string;
      amountCents: number;
      reasonCode: 'OTHER';
      description: string;
      performedBy: string;
      idempotencyKey: string;
    }) => Promise<void>;
    issuePaygVoucher?: (input: {
      billingAccountId: string;
      amountCents: number;
      reason: string;
      productId: string | null;
      tenantId?: string | null;
      performedBy: string;
      idempotencyKey: string;
    }) => Promise<void>;
  };
} = {}) {
  const events: Array<Record<string, unknown>> = [];
  const summaries: Array<{
    billingAccountId: string;
    yearMonth: string;
    paidCents: number | bigint;
    pendingCents: number | bigint;
    adjustedCents: number | bigint;
    issuedVoucherCents: number | bigint;
    consumeCents: number | bigint;
    voucherCents: number | bigint;
    chargeCents: number | bigint;
    tokenTotal?: number | bigint;
    requestCount?: number | bigint;
    effectiveDueAt: Date | null;
    dueProjected: boolean;
  }> = [];
  let tokenUsageFindManyCalls = 0;
  const tokenUsageFindManyWheres: Array<{
    tenantId?: unknown;
    take?: number;
    tenantIdHasIn: boolean;
  }> = [];
  const accountFindUniqueIds: string[] = [];
  const deadlineFindManyWheres: Array<{ billingAccountId?: unknown }> = [];
  const summaryFindManyWheres: Array<{ billingAccountId?: unknown }> = [];
  const eventFindManyWheres: Array<{ billingAccountId?: unknown }> = [];
  const deadlines = [...(opts.deadlines ?? [])].map((row) => ({
    ...row,
    frozenConsumeCents: row.frozenConsumeCents ?? null,
    frozenVoucherCents: row.frozenVoucherCents ?? null,
    frozenChargeCents: row.frozenChargeCents ?? null,
    frozenTokenTotal: row.frozenTokenTotal ?? null,
    frozenRequestCount: row.frozenRequestCount ?? null,
    amountsFrozenAt: row.amountsFrozenAt ?? null,
  }));
  const store = {
    latestCreditEventReason: null as string | null,
    extraConsumeCentsByMonth: {} as Record<string, number>,
    account: {
      id: 'ba-1',
      type: 'enterprise',
      createdAt: new Date('2026-04-04T07:20:31.000Z'),
      deletedAt: null,
      enterpriseName: '测试企业',
      creditConfig: {
        status: 'ACTIVE',
        limitUsd: 100,
        termsDays: 30,
        effectiveAt: new Date('2026-04-01T00:00:00.000Z'),
        expiresAt: null,
        policyRevision: 1,
        policyBoundaryComplete: true,
      },
    },
  };

  const consumeRows = () => {
    const base = Object.entries(opts.consumeCentsByMonth ?? {}).map(([yearMonth, cents]) => ({
      amountUsd: cents / -100,
      createdAt: new Date(`${yearMonth}-15T12:00:00+08:00`),
    }));
    const extra = Object.entries(store.extraConsumeCentsByMonth).map(([yearMonth, cents]) => ({
      amountUsd: cents / -100,
      // 闭月后才入账：时间戳落在闭月日历内，但晚于定格时刻
      createdAt: new Date(`${yearMonth}-28T23:00:00+08:00`),
    }));
    return [...base, ...extra];
  };

  const txStats = { txCalls: 0, lockCalls: 0 };
  const writeLog: string[] = [];
  const queryRawSql: string[] = [];

  const prisma = {
    // 事务语义的轻量模拟：回调收到同一 mock 作为 tx，记录写路径串行化调用顺序
    $executeRaw: async () => {
      txStats.lockCalls += 1;
      writeLog.push('advisory-lock');
      return 0;
    },
    $queryRaw: async (
      query: TemplateStringsArray | { sql: string; values?: unknown[] },
      ...templateValues: unknown[]
    ) => {
      const isSql = typeof (query as { sql?: unknown }).sql === 'string';
      const sql = isSql
        ? (query as { sql: string }).sql
        : Array.from(query as TemplateStringsArray).join(' ');
      const values = isSql
        ? ((query as { values?: unknown[] }).values ?? [])
        : templateValues;
      queryRawSql.push(sql);
      if (sql.includes('pg_try_advisory_xact_lock') || sql.includes('pg_try_advisory_lock')) {
        return [{ acquired: opts.advisoryLockAcquired !== false }];
      }
      if (sql.includes('pg_advisory_unlock')) {
        return [{ acquired: true }];
      }
      const nowAt = values.find((value) => value instanceof Date) as Date | undefined;
      const currentMonthArg = values.find((value) =>
        typeof value === 'string' && /^\d{4}-\d{2}$/.test(value)
      ) as string | undefined;
      const summaryOf = (row: (typeof deadlines)[number]) => summaries.find((item) =>
        item.billingAccountId === row.billingAccountId && item.yearMonth === row.yearMonth
      );
      const dueOf = (row: (typeof deadlines)[number]) =>
        summaryOf(row)?.effectiveDueAt ?? row.defaultDueAt;
      const creditEligible = store.account.creditConfig.policyRevision > 0
        && store.account.creditConfig.policyBoundaryComplete === true;
      if (sql.includes('overdue-latch-rearm')) {
        const changed: Array<{ billing_account_id: string; year_month: string }> = [];
        if (creditEligible && nowAt) {
          for (const row of deadlines) {
            if (row.pendingAtDeadline == null || !summaryOf(row) || dueOf(row) < nowAt) {
              continue;
            }
            row.pendingAtDeadline = null;
            row.pendingObservedAt = null;
            changed.push({ billing_account_id: row.billingAccountId, year_month: row.yearMonth });
          }
        }
        return changed;
      }
      if (sql.includes('overdue-latch-observe')) {
        const changed: Array<{ billing_account_id: string; year_month: string }> = [];
        if (creditEligible && nowAt && currentMonthArg) {
          for (const row of deadlines) {
            if (row.pendingAtDeadline != null || row.yearMonth >= currentMonthArg) {
              continue;
            }
            const summary = summaryOf(row);
            if (!summary || dueOf(row) >= nowAt) {
              continue;
            }
            row.pendingAtDeadline = Number(summary.paidCents) === 0 && Number(summary.pendingCents) > 0;
            row.pendingObservedAt = nowAt;
            changed.push({ billing_account_id: row.billingAccountId, year_month: row.yearMonth });
          }
        }
        return changed;
      }
      if (sql.includes('overdue-credit-states')) {
        const config = store.account.creditConfig;
        if (!creditEligible || (config.status !== 'ACTIVE' && config.status !== 'SUSPENDED')) {
          return [];
        }
        const overdue = Boolean(nowAt && currentMonthArg && deadlines.some((row) => {
          if (row.billingAccountId !== store.account.id || row.yearMonth >= currentMonthArg) {
            return false;
          }
          if (row.pendingAtDeadline !== true) {
            return false;
          }
          const summary = summaryOf(row);
          if (!summary || dueOf(row) >= nowAt) {
            return false;
          }
          return Number(summary.paidCents) === 0 && Number(summary.pendingCents) > 0;
        }));
        return [{
          billing_account_id: store.account.id,
          credit_status: config.status,
          overdue,
        }];
      }
      if (sql.includes('overdue-restore-reasons')) {
        return store.latestCreditEventReason
          ? [{ billing_account_id: store.account.id, reason: store.latestCreditEventReason }]
          : [];
      }
      const start = values.find((value) => value instanceof Date) as Date | undefined;
      const end = [...values].reverse().find((value) => value instanceof Date) as Date | undefined;
      const inRange = (at: Date) => (!start || at >= start) && (!end || at < end);
      if (sql.includes('usage-aggregate-pushdown')) {
        if (opts.aggregateGate) {
          await opts.aggregateGate;
        }
        // 聚合下推返回的「日×工作区×模型」桶，字段全部是 ::text。
        return [{
          day: '2026-08-05',
          tenant_id: 'tenant-1',
          model: 'demo',
          call_type: 'input',
          input_price: '2.4',
          cached_price: null,
          cache_write_price: null,
          output_price: '7.2',
          unit_price: '2.4',
          multiplier: null,
          input_tokens: '1000',
          cache_read_tokens: '0',
          cache_write_tokens: '0',
          output_tokens: '500',
          input_positive_tokens: '1000',
          cache_read_positive_tokens: '0',
          cache_write_positive_tokens: '0',
          output_positive_tokens: '500',
          fallback_tokens: '0',
          fallback_positive_tokens: '0',
          fallback_rows: '0',
          total_amount: '5',
          credit_amount: '0',
          debt_amount: '0',
          voucher_amount: '0',
          paid_amount: '5',
          pending_amount: '0',
          positive_discounted_amount: '5',
        }];
      }
      if (sql.includes('export-summary')) {
        return consumeRows()
          .filter((row) => inRange(row.createdAt))
          .map((row) => ({
            tenantId: 'tenant-1',
            model: 'demo',
            tokens: Math.abs(Math.round(row.amountUsd * -1000)),
            catalogUsd: Math.abs(row.amountUsd),
            discountedUsd: Math.abs(row.amountUsd),
            voucherUsd: 0,
          }));
      }
      if (sql.includes('export-ledger-consume')) {
        const buckets = new Map<string, number>();
        for (const row of consumeRows()) {
          if (!inRange(row.createdAt)) continue;
          buckets.set('tenant-1', (buckets.get('tenant-1') ?? 0) + Math.abs(Math.round(row.amountUsd * 100)));
        }
        return [...buckets.entries()].map(([key, cents]) => ({ key, cents }));
      }
      if (sql.includes('export-ledger-voucher')) {
        const buckets = new Map<string, number>();
        for (const row of opts.allocations ?? []) {
          if (!inRange(row.createdAt)) continue;
          buckets.set('tenant-1', (buckets.get('tenant-1') ?? 0) + Math.abs(usdToCents(row.bonusConsumedUsd)));
        }
        return [...buckets.entries()].map(([key, cents]) => ({ key, cents }));
      }
      if (sql.includes('export-ledger-model')) {
        let consumeCents = 0;
        let voucherCents = 0;
        for (const row of opts.allocations ?? []) {
          if (!inRange(row.createdAt)) continue;
          consumeCents += Math.abs(usdToCents(row.recognizedRevenueUsd));
          voucherCents += Math.abs(usdToCents(row.bonusConsumedUsd));
        }
        return consumeCents + voucherCents > 0
          ? [{ key: 'demo', consumeCents, voucherCents }]
          : [];
      }
      if (sql.includes('mapFinanceApiUsageRows')) {
        const buckets = new Map<string, {
          accountPayUsd: ReturnType<typeof usd>;
          voucherDeductUsd: ReturnType<typeof usd>;
          creditPayUsd: ReturnType<typeof usd>;
          debtPayUsd: ReturnType<typeof usd>;
        }>();
        for (const row of opts.allocations ?? []) {
          if (!inRange(row.createdAt)) continue;
          const yearMonth = yearMonthInBeijing(row.createdAt);
          const bucket = buckets.get(yearMonth) ?? {
            accountPayUsd: usd(0),
            voucherDeductUsd: usd(0),
            creditPayUsd: usd(0),
            debtPayUsd: usd(0),
          };
          const debtSource = row.source === 'ENTERPRISE_CREDIT' || row.source === 'NEGATIVE_BALANCE';
          if (debtSource && row.balanceGrantId == null) {
            if (row.fundingClassificationComplete === true) {
              bucket.creditPayUsd = bucket.creditPayUsd.plus(usd(row.approvedCreditUsd).abs());
              bucket.debtPayUsd = bucket.debtPayUsd.plus(usd(row.unapprovedDebtUsd).abs());
            } else {
              bucket.debtPayUsd = bucket.debtPayUsd.plus(
                usd(row.amountUsd ?? row.recognizedRevenueUsd).abs(),
              );
            }
          } else {
            bucket.accountPayUsd = bucket.accountPayUsd.plus(usd(row.recognizedRevenueUsd).abs());
            bucket.voucherDeductUsd = bucket.voucherDeductUsd.plus(usd(row.bonusConsumedUsd).abs());
          }
          buckets.set(yearMonth, bucket);
        }
        return [...buckets.entries()].map(([yearMonth, bucket]) => ({
          yearMonth,
          accountPayCents: usdToCents(bucket.accountPayUsd),
          voucherDeductCents: usdToCents(bucket.voucherDeductUsd),
          creditPayCents: usdToCents(bucket.creditPayUsd),
          debtPayCents: usdToCents(bucket.debtPayUsd),
        }));
      }
      if (sql.includes('live-export-usage')) {
        // Excel 账单汇总口径：消耗=折后分，token=用量，请求数=明细行
        const buckets = new Map<string, {
          consumeCents: number;
          voucherCents: number;
          tokenTotal: number;
          requestCount: number;
        }>();
        for (const row of consumeRows()) {
          if (!inRange(row.createdAt)) continue;
          const yearMonth = yearMonthInBeijing(row.createdAt);
          const bucket = buckets.get(yearMonth) ?? {
            consumeCents: 0,
            voucherCents: 0,
            tokenTotal: 0,
            requestCount: 0,
          };
          const consumeCents = Math.abs(Math.round(row.amountUsd * 100));
          bucket.consumeCents += consumeCents;
          bucket.tokenTotal += Math.abs(Math.round(row.amountUsd * -1000));
          bucket.requestCount += 1;
          buckets.set(yearMonth, bucket);
        }
        for (const row of opts.allocations ?? []) {
          if (!inRange(row.createdAt)) continue;
          const yearMonth = yearMonthInBeijing(row.createdAt);
          const bucket = buckets.get(yearMonth) ?? {
            consumeCents: 0,
            voucherCents: 0,
            tokenTotal: 0,
            requestCount: 0,
          };
          bucket.voucherCents += Math.abs(usdToCents(row.bonusConsumedUsd));
          buckets.set(yearMonth, bucket);
        }
        return [...buckets.entries()].map(([yearMonth, bucket]) => ({
          yearMonth,
          ...bucket,
        }));
      }
      if (sql.includes('live-consume') || sql.includes('balance_transactions')) {
        const buckets = new Map<string, number>();
        for (const row of consumeRows()) {
          if (!inRange(row.createdAt)) continue;
          const yearMonth = yearMonthInBeijing(row.createdAt);
          buckets.set(yearMonth, (buckets.get(yearMonth) ?? 0) + Math.abs(Math.round(row.amountUsd * 100)));
        }
        return [...buckets.entries()].map(([yearMonth, cents]) => ({
          billingAccountId: 'ba-1',
          yearMonth,
          cents,
        }));
      }
      if (sql.includes('live-voucher')) {
        const buckets = new Map<string, number>();
        for (const row of opts.allocations ?? []) {
          if (!inRange(row.createdAt)) continue;
          const yearMonth = yearMonthInBeijing(row.createdAt);
          buckets.set(yearMonth, (buckets.get(yearMonth) ?? 0) + Math.abs(usdToCents(row.bonusConsumedUsd)));
        }
        return [...buckets.entries()].map(([yearMonth, cents]) => ({
          billingAccountId: 'ba-1',
          yearMonth,
          cents,
        }));
      }
      if (sql.includes('live-usage')) {
        const buckets = new Map<string, { tokenTotal: number; requestCount: number }>();
        for (const row of consumeRows()) {
          if (!inRange(row.createdAt)) continue;
          const yearMonth = yearMonthInBeijing(row.createdAt);
          const bucket = buckets.get(yearMonth) ?? { tokenTotal: 0, requestCount: 0 };
          bucket.tokenTotal += Math.abs(Math.round(row.amountUsd * -1000));
          bucket.requestCount += 1;
          buckets.set(yearMonth, bucket);
        }
        return [...buckets.entries()].map(([yearMonth, bucket]) => ({
          billingAccountId: 'ba-1',
          tenantId: 'tenant-1',
          yearMonth,
          ...bucket,
        }));
      }
      if (sql.includes('list-paid-cash') || sql.includes('recognized_revenue_usd')) {
        const buckets = new Map<string, number>();
        for (const row of opts.allocations ?? []) {
          if (!inRange(row.createdAt)) continue;
          if (row.source === 'ENTERPRISE_CREDIT' && row.balanceGrantId == null) continue;
          const yearMonth = yearMonthInBeijing(row.createdAt);
          buckets.set(yearMonth, (buckets.get(yearMonth) ?? 0) + Math.abs(usdToCents(row.recognizedRevenueUsd)));
        }
        return [...buckets.entries()].map(([yearMonth, cents]) => ({
          billingAccountId: 'ba-1',
          yearMonth,
          cents,
        }));
      }
      if (sql.includes('list-paid-funding') || sql.includes('enterprise_credit_settlements')) {
        // 与 SQL ROUND(SUM(ABS(usd))*100) 对齐：先加总再进分
        const buckets = new Map<string, ReturnType<typeof usd>>();
        for (const row of opts.settlements ?? []) {
          const consumedAt = row.allocation?.createdAt;
          if (!consumedAt || row.trigger !== 'FUNDING') continue;
          const yearMonth = yearMonthInBeijing(consumedAt);
          buckets.set(
            yearMonth,
            (buckets.get(yearMonth) ?? usd(0)).plus(usd(row.amountUsd).abs()),
          );
        }
        return [...buckets.entries()].map(([yearMonth, usdTotal]) => ({
          billingAccountId: 'ba-1',
          yearMonth,
          cents: usdToCents(usdTotal),
        }));
      }
      return [];
    },
    $transaction: async (fn: (tx: unknown) => Promise<unknown>) => {
      txStats.txCalls += 1;
      return fn(prisma);
    },
    billingAccount: {
      findUnique: async ({ where }: { where: { id: string } }) => {
        accountFindUniqueIds.push(where.id);
        return where.id === store.account.id ? store.account : null;
      },
      findMany: async ({ where }: {
        where?: { id?: string | { in: string[] }; type?: string; deletedAt?: null };
      } = {}) => {
        const ids = typeof where?.id === 'string'
          ? [where.id]
          : where?.id && typeof where.id === 'object' && 'in' in where.id
            ? where.id.in
            : null;
        if (ids) {
          accountFindUniqueIds.push(...ids);
        }
        if (ids && !ids.includes(store.account.id)) {
          return [];
        }
        if (where?.type && where.type !== store.account.type) {
          return [];
        }
        return [store.account];
      },
    },
    billingAccountCreditEvent: {
      findFirst: async ({ where }: { where: { billingAccountId: string } }) => (
        where.billingAccountId === store.account.id && store.latestCreditEventReason
          ? { billingAccountId: store.account.id, reason: store.latestCreditEventReason }
          : null
      ),
      findMany: async ({ where }: { where: { billingAccountId: string | { in: string[] } } }) => {
        const ids = typeof where.billingAccountId === 'string'
          ? [where.billingAccountId]
          : where.billingAccountId.in;
        if (!store.latestCreditEventReason) {
          return [];
        }
        // 模拟 orderBy createdAt desc：每个账户仅返回一条（即最新）事件
        return ids
          .filter((id) => id === store.account.id)
          .map((id) => ({ billingAccountId: id, reason: store.latestCreditEventReason }));
      },
    },
    tenant: {
      findMany: async () => [{ id: 'tenant-1', billingAccountId: 'ba-1' }],
    },
    balanceTransaction: {
      findMany: async ({ where }: {
        where: { billingAccountId: string; createdAt: { gte: Date; lt: Date } };
      }) => consumeRows().filter((row) =>
        row.createdAt >= where.createdAt.gte && row.createdAt < where.createdAt.lt
      ),
    },
    balanceConsumptionAllocation: {
      findMany: async ({ where }: {
        where?: { billingAccountId?: string; createdAt?: { gte: Date; lt: Date } };
      } = {}) => (opts.allocations ?? []).filter((row) => {
        if (where?.billingAccountId && row.billingAccountId !== where.billingAccountId) {
          return false;
        }
        if (where?.createdAt) {
          if (row.createdAt < where.createdAt.gte) return false;
          if (row.createdAt >= where.createdAt.lt) return false;
        }
        return true;
      }),
    },
    enterpriseCreditSettlement: {
      findMany: async ({ where }: {
        where?: { billingAccountId?: string; trigger?: string };
      } = {}) => (opts.settlements ?? []).filter((row) => {
        if (where?.billingAccountId && row.billingAccountId !== where.billingAccountId) {
          return false;
        }
        if (where?.trigger && row.trigger !== where.trigger) {
          return false;
        }
        return true;
      }),
    },
    tokenUsage: {
      findMany: async ({ where, take }: {
        where: {
          tenantId?: string | { in: string[] };
          createdAt: { gte: Date; lt: Date };
        };
        take?: number;
      }) => {
        tokenUsageFindManyCalls += 1;
        tokenUsageFindManyWheres.push({
          tenantId: where.tenantId,
          take,
          tenantIdHasIn: typeof where.tenantId === 'object' && where.tenantId != null && 'in' in where.tenantId,
        });
        const tenantId = typeof where.tenantId === 'string' ? where.tenantId : null;
        if (tenantId && tenantId !== 'tenant-1') {
          return [];
        }
        const matched = consumeRows()
          .filter((row) => row.createdAt >= where.createdAt.gte && row.createdAt < where.createdAt.lt)
          .map((row, index) => ({
            id: `tu-${row.createdAt.toISOString()}-${index}`,
            createdAt: row.createdAt,
            tenantId: 'tenant-1',
            model: 'demo',
            totalTokens: Math.abs(Math.round(row.amountUsd * -1000)),
            customerChargeUsd: Math.abs(row.amountUsd),
          }));
        return take == null ? matched : matched.slice(0, take);
      },
      aggregate: async ({ where }: { where: { createdAt: { gte: Date; lt: Date } } }) => ({
        _sum: {
          totalTokens: consumeRows()
            .filter((row) => row.createdAt >= where.createdAt.gte && row.createdAt < where.createdAt.lt)
            .reduce((sum, row) => sum + Math.abs(Math.round(row.amountUsd * -1000)), 0),
        },
      }),
    },
    enterpriseBillDeadline: {
      findFirst: async ({ where }: { where: { billingAccountId?: string; yearMonth?: string } }) => (
        deadlines.find((row) =>
          (!where.billingAccountId || row.billingAccountId === where.billingAccountId)
          && (!where.yearMonth || row.yearMonth === where.yearMonth),
        ) ?? null
      ),
      findMany: async ({ where }: { where: { billingAccountId?: string | { in: string[] } } }) => {
        deadlineFindManyWheres.push({ billingAccountId: where.billingAccountId });
        const ids = typeof where.billingAccountId === 'string'
          ? [where.billingAccountId]
          : where.billingAccountId?.in ?? [];
        return deadlines.filter((row) => ids.includes(row.billingAccountId));
      },
      upsert: async ({ where, create, update }: {
        where: { billingAccountId_yearMonth: { billingAccountId: string; yearMonth: string } };
        create: (typeof deadlines)[number];
        update?: Partial<(typeof deadlines)[number]>;
      }) => {
        const existing = deadlines.find((row) =>
          row.billingAccountId === where.billingAccountId_yearMonth.billingAccountId
          && row.yearMonth === where.billingAccountId_yearMonth.yearMonth,
        );
        if (existing) {
          Object.assign(existing, update ?? {});
          return existing;
        }
        deadlines.push(create);
        return create;
      },
      update: async ({ where, data }: {
        where: { id?: string; billingAccountId_yearMonth?: { billingAccountId: string; yearMonth: string } };
        data: Partial<(typeof deadlines)[number]>;
      }) => {
        const row = deadlines.find((item) =>
          item.billingAccountId === (where.billingAccountId_yearMonth?.billingAccountId ?? 'ba-1')
          && item.yearMonth === where.billingAccountId_yearMonth?.yearMonth,
        );
        if (!row) return null;
        Object.assign(row, data);
        return row;
      },
      // 模拟条件更新语义：仅命中 where 条件的行被写入，返回 count 供调用方判定是否抢到
      updateMany: async ({ where, data }: {
        where: {
          billingAccountId?: string;
          yearMonth?: string;
          pendingAtDeadline?: boolean | null | { not: null };
        };
        data: Partial<(typeof deadlines)[number]>;
      }) => {
        const pendingFilter = where.pendingAtDeadline;
        const matches = deadlines.filter((row) => {
          if (where.billingAccountId && row.billingAccountId !== where.billingAccountId) return false;
          if (where.yearMonth && row.yearMonth !== where.yearMonth) return false;
          if (pendingFilter === null && row.pendingAtDeadline != null) return false;
          if (pendingFilter != null && typeof pendingFilter === 'object' && row.pendingAtDeadline == null) {
            return false;
          }
          return true;
        });
        for (const row of matches) {
          Object.assign(row, data);
        }
        return { count: matches.length };
      },
    },
    enterpriseBillEvent: {
      findUnique: async ({ where }: { where: { id: string } }) => (
        events.find((row) => row.id === where.id) ?? null
      ),
      findMany: async ({ where }: {
        where: {
          billingAccountId?: string | { in: string[] };
          yearMonth?: string;
          status?: string;
        };
      }) => {
        eventFindManyWheres.push({ billingAccountId: where.billingAccountId });
        const ids = typeof where.billingAccountId === 'string'
          ? [where.billingAccountId]
          : where.billingAccountId?.in ?? [];
        return events.filter((row) =>
          ids.includes(String(row.billingAccountId))
          && (!where.yearMonth || row.yearMonth === where.yearMonth)
          && (!where.status || row.status === where.status),
        );
      },
      create: async ({ data }: { data: Record<string, unknown> }) => {
        // 模拟 DB 默认值：未显式传 status 的事件视为已确认
        const row = { id: `evt-${events.length + 1}`, createdAt: NOW, status: 'CONFIRMED', ...data };
        events.push(row);
        writeLog.push('event-create');
        return row;
      },
      update: async ({ where, data }: {
        where: { id: string };
        data: Record<string, unknown>;
      }) => {
        const row = events.find((item) => item.id === where.id);
        if (!row) return null;
        Object.assign(row, data);
        return row;
      },
    },
    enterpriseBillMonthSummary: {
      findMany: async ({ where }: {
        where?: {
          billingAccountId?: string | { in: string[] };
          yearMonth?: string;
          pendingCents?: { gt: number };
        };
      } = {}) => {
        summaryFindManyWheres.push({ billingAccountId: where?.billingAccountId });
        const ids = typeof where?.billingAccountId === 'string'
          ? [where.billingAccountId]
          : where?.billingAccountId?.in ?? null;
        return summaries.filter((row) =>
          (!ids || ids.includes(row.billingAccountId))
          && (!where?.yearMonth || row.yearMonth === where.yearMonth)
          && (where?.pendingCents?.gt == null || row.pendingCents > where.pendingCents.gt),
        );
      },
      createMany: async ({ data }: {
        data: Array<(typeof summaries)[number] & { billingAccountId: string; yearMonth: string }>;
      }) => {
        let count = 0;
        for (const row of data) {
          const exists = summaries.some((item) =>
            item.billingAccountId === row.billingAccountId && item.yearMonth === row.yearMonth,
          );
          if (exists) {
            continue;
          }
          summaries.push({
            ...row,
            tokenTotal: row.tokenTotal ?? 0,
            requestCount: row.requestCount ?? 0,
            effectiveDueAt: row.effectiveDueAt ?? null,
            dueProjected: row.dueProjected ?? false,
          });
          count += 1;
        }
        return { count };
      },
      findFirst: async ({ where }: { where: { billingAccountId: string; yearMonth: string } }) => (
        summaries.find((row) =>
          row.billingAccountId === where.billingAccountId && row.yearMonth === where.yearMonth,
        ) ?? null
      ),
      upsert: async ({ where, create, update }: {
        where: { billingAccountId_yearMonth: { billingAccountId: string; yearMonth: string } };
        create: (typeof summaries)[number] & { billingAccountId: string; yearMonth: string };
        update: Partial<(typeof summaries)[number]>;
      }) => {
        const existing = summaries.find((row) =>
          row.billingAccountId === where.billingAccountId_yearMonth.billingAccountId
          && row.yearMonth === where.billingAccountId_yearMonth.yearMonth,
        );
        if (existing) {
          Object.assign(existing, update);
          return existing;
        }
        const row = { ...create };
        summaries.push(row);
        return row;
      },
    },
  };

  const wallet = opts.wallet ?? {
    applyMovement: async () => undefined,
    issuePaygVoucher: async () => undefined,
  };
  const service = new EnterpriseBillsService(prisma as never, {
    applyMovement: wallet.applyMovement,
    issuePaygVoucher: wallet.issuePaygVoucher ?? (async () => undefined),
  } as never);
  return {
    service,
    events,
    deadlines,
    summaries,
    store,
    txStats,
    writeLog,
    queryRawSql,
    tokenUsageFindManyCalls: () => tokenUsageFindManyCalls,
    tokenUsageFindManyWheres,
    accountFindUniqueIds,
    deadlineFindManyWheres,
    summaryFindManyWheres,
    eventFindManyWheres,
  };
}

function specBillEventId(
  kind: 'write-off' | 'adjust' | 'compensate' | 'extend',
  accountId: string,
  yearMonth: string,
  idempotencyKey: string,
): string {
  const digest = createHash('sha256')
    .update(`enterprise-bill-${kind}:${accountId}:${yearMonth}:${idempotencyKey}`)
    .digest();
  const bytes = Buffer.from(digest.subarray(0, 16));
  bytes[6] = (bytes[6] & 0x0f) | 0x50;
  bytes[8] = (bytes[8] & 0x3f) | 0x80;
  const hex = bytes.toString('hex');
  return `${hex.slice(0, 8)}-${hex.slice(8, 12)}-${hex.slice(12, 16)}-${hex.slice(16, 20)}-${hex.slice(20)}`;
}

async function closeAllHistorical(
  service: EnterpriseBillsService,
  now: Date = NOW,
): Promise<void> {
  for (let i = 0; i < 36; i += 1) {
    const result = await service.closeHistoricalClosedMonths(now);
    if (!result.hasMore) {
      return;
    }
  }
}
