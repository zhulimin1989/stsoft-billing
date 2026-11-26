import {
  beijingMonthRange,
  billStatus,
  chargeCents,
  financeApiUsageChannelCents,
  financeApiUsageChannelsMonthCents,
  defaultDueAt,
  disableReason,
  exportUsageCutoff,
  exportUsageCutoffInclusiveLabel,
  isClosedBeijingMonth,
  isPrepaidCredit,
  listYearMonths,
  pendingCents,
  listPaidCents,
  remainingDays,
  receivableCents,
  shouldAutoSuspend,
  validateAdjust,
  validateCompensateVoucher,
  validateExtend,
  validateWriteOff,
  yearMonthInBeijing,
  previousYearMonth,
} from './enterprise-bills.policy';

describe('enterprise bills policy', () => {
  const now = new Date('2026-09-08T04:00:00.000Z'); // 北京时间 2026-09-08 12:00

  it('lists Beijing months from open date through the current month, newest first', () => {
    expect(listYearMonths(new Date('2026-04-04T07:20:31.000Z'), now)).toEqual([
      '2026-09',
      '2026-08',
      '2026-07',
      '2026-06',
      '2026-05',
      '2026-04',
    ]);
  });

  it('treats September as the current month and August as closed', () => {
    expect(yearMonthInBeijing(now)).toBe('2026-09');
    expect(isClosedBeijingMonth('2026-09', now)).toBe(false);
    expect(isClosedBeijingMonth('2026-08', now)).toBe(true);
  });

  it('steps a Beijing year-month backward for close-month selection', () => {
    expect(previousYearMonth('2026-10')).toBe('2026-09');
    expect(previousYearMonth('2026-01')).toBe('2025-12');
  });

  it('freezes the default deadline at month-end plus repayment days', () => {
    expect(defaultDueAt('2026-09', 30).toISOString()).toBe('2026-10-30T15:59:59.000Z');
  });

  it('computes receivable as consume − voucher − account pay + adjusted − issued voucher', () => {
    expect(chargeCents({ consumeCents: 5420, voucherCents: 200 })).toBe(5220);
    // 消耗 5420 − 券 200 − 账户支付 1800 + 调整 −1200 − 发券 500 = 1720
    expect(receivableCents({
      consumeCents: 5420,
      voucherCents: 200,
      accountPayCents: 1800,
      adjustedCents: -1200,
      issuedVoucherCents: 500,
    })).toBe(1720);
  });

  it('computes pending as receivable − paid and allows a negative remainder', () => {
    // 应收 1720 / 已付 2000 → 待付款 −280
    expect(pendingCents({
      consumeCents: 5420,
      voucherCents: 200,
      accountPayCents: 1800,
      adjustedCents: -1200,
      paidCents: 2000,
      issuedVoucherCents: 500,
    })).toBe(-280);
    expect(pendingCents({
      consumeCents: 500,
      voucherCents: 0,
      accountPayCents: 0,
      adjustedCents: -600,
      paidCents: 0,
      issuedVoucherCents: 0,
    })).toBe(-100);
  });

  it('keeps 应收 = 已付款 + 待付款', () => {
    const input = {
      consumeCents: 5420,
      voucherCents: 200,
      accountPayCents: 1800,
      adjustedCents: -1200,
      paidCents: 900,
      issuedVoucherCents: 500,
    };
    expect(receivableCents(input)).toBe(listPaidCents({
      prepaid: false,
      fundingPaidCents: 400,
      writeOffPaidCents: 500,
    }) + pendingCents({ ...input, paidCents: 900 }));
    expect(receivableCents(input)).toBe(900 + pendingCents(input));
  });

  it('takes bill channels from API用量扣费 collected revenue, bonus, and classified credit', () => {
    expect(financeApiUsageChannelCents({
      customerChargeUsd: 7,
      allocations: [
        {
          balanceGrantId: 'grant-1',
          source: 'BALANCE_GRANT',
          amountUsd: 4,
          recognizedRevenueUsd: 3,
          bonusConsumedUsd: 1,
        },
        {
          balanceGrantId: null,
          source: 'ENTERPRISE_CREDIT',
          amountUsd: 2,
          recognizedRevenueUsd: 1.83,
          bonusConsumedUsd: 0.17,
          approvedCreditUsd: 2,
          fundingClassificationComplete: true,
        },
        {
          balanceGrantId: null,
          source: 'ENTERPRISE_CREDIT',
          amountUsd: 1,
          recognizedRevenueUsd: 0,
          bonusConsumedUsd: 0,
          approvedCreditUsd: 0,
          unapprovedDebtUsd: 1,
          fundingClassificationComplete: true,
        },
      ],
    })).toEqual({
      accountPayCents: 300,
      voucherDeductCents: 100,
      creditPayCents: 200,
      debtPayCents: 100,
    });
  });

  it('keeps NEGATIVE_BALANCE out of 账户支付 / 代金券抵扣', () => {
    expect(financeApiUsageChannelCents({
      customerChargeUsd: 8,
      allocations: [
        {
          balanceGrantId: 'grant-1',
          source: 'BALANCE_GRANT',
          amountUsd: 4,
          recognizedRevenueUsd: 3,
          bonusConsumedUsd: 1,
        },
        {
          balanceGrantId: null,
          source: 'ENTERPRISE_CREDIT',
          amountUsd: 2,
          recognizedRevenueUsd: 1.83,
          bonusConsumedUsd: 0.17,
          approvedCreditUsd: 2,
          fundingClassificationComplete: true,
        },
        {
          balanceGrantId: null,
          source: 'ENTERPRISE_CREDIT',
          amountUsd: 1,
          recognizedRevenueUsd: 0,
          bonusConsumedUsd: 0,
          approvedCreditUsd: 0,
          unapprovedDebtUsd: 1,
          fundingClassificationComplete: true,
        },
        {
          balanceGrantId: null,
          source: 'NEGATIVE_BALANCE',
          amountUsd: 1,
          recognizedRevenueUsd: 0.75,
          bonusConsumedUsd: 0.25,
          approvedCreditUsd: 0,
          unapprovedDebtUsd: 1,
          fundingClassificationComplete: true,
        },
      ],
    })).toEqual({
      accountPayCents: 300,
      voucherDeductCents: 100,
      creditPayCents: 200,
      debtPayCents: 200,
    });
  });

  it('uses the usage funding snapshot when there are no allocations', () => {
    expect(financeApiUsageChannelCents({
      customerChargeUsd: 2,
      customerFundingClassificationComplete: true,
      customerCollectedUsd: 1,
      customerApprovedReceivableUsd: 0.5,
      customerUnapprovedDebtUsd: 0.5,
      allocations: [],
    })).toEqual({
      accountPayCents: 100,
      voucherDeductCents: 0,
      creditPayCents: 50,
      debtPayCents: 50,
    });
  });

  it('falls back to the full customer charge as 账户支付 when usage is unclassified', () => {
    expect(financeApiUsageChannelCents({
      customerChargeUsd: 2,
      customerChargePolicy: 'usage_charge',
      allocations: [],
    })).toEqual({
      accountPayCents: 200,
      voucherDeductCents: 0,
      creditPayCents: 0,
      debtPayCents: 0,
    });
  });

  it('puts unclassified ENTERPRISE_CREDIT amount into 欠款, not 信用支付', () => {
    expect(financeApiUsageChannelCents({
      customerChargeUsd: '29.76890614',
      allocations: [{
        balanceGrantId: null,
        source: 'ENTERPRISE_CREDIT',
        amountUsd: '29.76890614',
        recognizedRevenueUsd: 0,
        bonusConsumedUsd: 0,
        approvedCreditUsd: 0,
        unapprovedDebtUsd: 0,
        fundingClassificationComplete: false,
      }],
    })).toEqual({
      accountPayCents: 0,
      voucherDeductCents: 0,
      creditPayCents: 0,
      debtPayCents: 2977,
    });
  });

  it('keeps classified prepaid overdraft in 欠款 and leaves pending formula untouched', () => {
    expect(financeApiUsageChannelCents({
      customerChargeUsd: '29.76890614',
      allocations: [{
        balanceGrantId: null,
        source: 'ENTERPRISE_CREDIT',
        amountUsd: '29.76890614',
        recognizedRevenueUsd: 0,
        bonusConsumedUsd: 0,
        approvedCreditUsd: 0,
        unapprovedDebtUsd: '29.76890614',
        fundingClassificationComplete: true,
      }],
    })).toEqual({
      accountPayCents: 0,
      voucherDeductCents: 0,
      creditPayCents: 0,
      debtPayCents: 2977,
    });
    expect(pendingCents({
      consumeCents: 1004970,
      voucherCents: 0,
      accountPayCents: 1001993,
      adjustedCents: 0,
      paidCents: 2977,
      issuedVoucherCents: 0,
    })).toBe(0);
  });

  it('rounds month-level 欠款 once after summing USD (3×0.005 → 2, not 3)', () => {
    const usages = [0, 1, 2].map(() => ({
      customerChargeUsd: '0.005',
      allocations: [{
        balanceGrantId: null,
        source: 'ENTERPRISE_CREDIT',
        amountUsd: '0.005',
        recognizedRevenueUsd: 0,
        bonusConsumedUsd: 0,
        approvedCreditUsd: 0,
        unapprovedDebtUsd: '0.005',
        fundingClassificationComplete: true,
      }],
    }));
    expect(usages
      .map((usage) => financeApiUsageChannelCents(usage).debtPayCents)
      .reduce((total, cents) => total + cents, 0)).toBe(3);
    expect(financeApiUsageChannelsMonthCents(usages)).toEqual({
      accountPayCents: 0,
      voucherDeductCents: 0,
      creditPayCents: 0,
      debtPayCents: 2,
    });
  });

  it('sums list paid from FUNDING and write-off only', () => {
    expect(listPaidCents({
      prepaid: false,
      fundingPaidCents: 150,
      writeOffPaidCents: 50,
    })).toBe(200);
  });

  it('counts FUNDING on prepaid accounts (unapproved debt repay / PRD 0928)', () => {
    expect(listPaidCents({
      prepaid: true,
      fundingPaidCents: 150,
      writeOffPaidCents: 80,
    })).toBe(230);
    expect(listPaidCents({
      prepaid: true,
      fundingPaidCents: 2977,
      writeOffPaidCents: 0,
    })).toBe(2977);
    expect(listPaidCents({
      prepaid: true,
      fundingPaidCents: 0,
      writeOffPaidCents: 0,
    })).toBe(0);
  });

  it('marks 待核销 only when paid is zero and pending is positive', () => {
    expect(billStatus({
      consumeCents: 0, voucherCents: 0, adjustedCents: 0, paidCents: 0, issuedVoucherCents: 0,
    })).toBe('已核销');
    expect(billStatus({
      consumeCents: 280, voucherCents: 0, adjustedCents: 0, paidCents: 0, issuedVoucherCents: 0,
    })).toBe('待核销');
    // 部分回款：已付款 > 0 仍可能有待付款 → 已核销
    expect(billStatus({
      consumeCents: 5420, voucherCents: 0, adjustedCents: -1200, paidCents: 2000, issuedVoucherCents: 0,
    })).toBe('已核销');
  });

  it('counts remaining days from the frozen deadline', () => {
    expect(remainingDays(new Date('2026-10-30T15:59:59.000Z'), now)).toBe(52);
    expect(remainingDays(new Date('2026-09-12T15:59:59.000Z'), now)).toBe(4);
  });

  it('rejects write-off, adjust and extend on the current month but allows compensate voucher', () => {
    const current = {
      yearMonth: '2026-09',
      now,
      prepaid: false,
      canManage: true,
      pendingCents: 280,
      paidCents: 1000,
    };
    expect(disableReason('writeOff', current)).toBe('当月仅支持下载与补偿发券');
    expect(disableReason('adjust', current)).toBe('当月仅支持下载与补偿发券');
    expect(disableReason('extend', current)).toBe('当月仅支持下载与补偿发券');
    expect(disableReason('compensateVoucher', current)).toBeNull();
    expect(validateWriteOff({ ...current, amountCents: 100 }).ok).toBe(false);
  });

  it('uses permission, prepaid zero-pending, then no-receivable tooltips in that order', () => {
    expect(disableReason('writeOff', {
      yearMonth: '2026-08',
      now,
      prepaid: true,
      canManage: false,
      pendingCents: 200,
      paidCents: 0,
    })).toBe('无操作权限');
    // 预付款有待付款（如 DEBT_OPEN）时允许核销
    expect(disableReason('writeOff', {
      yearMonth: '2026-08',
      now,
      prepaid: true,
      canManage: true,
      pendingCents: 200,
      paidCents: 0,
    })).toBeNull();
    expect(validateWriteOff({
      yearMonth: '2026-08',
      now,
      prepaid: true,
      canManage: true,
      pendingCents: 2977,
      paidCents: 0,
      amountCents: 2977,
    }).ok).toBe(true);
    // 预付款无待付款：无需核销
    expect(disableReason('writeOff', {
      yearMonth: '2026-08',
      now,
      prepaid: true,
      canManage: true,
      pendingCents: 0,
      paidCents: 0,
    })).toBe('预付款账户无需核销');
    // 预付款仍可账单调整 / 补偿发券
    expect(disableReason('adjust', {
      yearMonth: '2026-08',
      now,
      prepaid: true,
      canManage: true,
      pendingCents: 0,
      paidCents: 500,
    })).toBeNull();
    expect(disableReason('writeOff', {
      yearMonth: '2026-08',
      now,
      prepaid: false,
      canManage: true,
      pendingCents: 0,
      paidCents: 0,
    })).toBe('无可核销金额');
  });

  it('still allows bill adjust on a closed zero-pending month', () => {
    expect(disableReason('adjust', {
      yearMonth: '2026-08',
      now,
      prepaid: false,
      canManage: true,
      pendingCents: 0,
      paidCents: 0,
    })).toBeNull();
  });

  it('allows a decrease that clamps pending at zero instead of rejecting', () => {
    expect(validateAdjust({
      yearMonth: '2026-08',
      now,
      prepaid: false,
      canManage: true,
      consumeCents: 500,
      voucherCents: 0,
      adjustedCents: 0,
      paidCents: 0,
      issuedVoucherCents: 0,
      pendingCents: 500,
      direction: 'decrease',
      amountCents: 600,
      reason: '客户确认差异',
    })).toEqual({ ok: true });
  });

  it('blocks compensate voucher when paid is zero or amount exceeds paid', () => {
    const closed = {
      yearMonth: '2026-08',
      now,
      prepaid: false,
      canManage: true,
      pendingCents: 0,
      paidCents: 0,
    };
    expect(disableReason('compensateVoucher', closed)).toBe('已付款为0不可补偿发券');
    expect(validateCompensateVoucher({
      ...closed,
      paidCents: 500,
      amountCents: 501,
      reason: '多收补偿',
    })).toEqual({ ok: false, message: '补偿金额不可超过已付款金额' });
    expect(validateCompensateVoucher({
      ...closed,
      paidCents: 500,
      amountCents: 200,
      reason: '多收补偿',
    })).toEqual({ ok: true });
  });

  it('requires adjust reason', () => {
    expect(validateAdjust({
      yearMonth: '2026-08',
      now,
      prepaid: false,
      canManage: true,
      consumeCents: 500,
      voucherCents: 0,
      adjustedCents: 0,
      paidCents: 0,
      issuedVoucherCents: 0,
      pendingCents: 500,
      direction: 'increase',
      amountCents: 100,
      reason: '  ',
    })).toEqual({ ok: false, message: '调整原因必填' });
  });

  it('accepts a closed-month write-off that does not exceed pending', () => {
    expect(validateWriteOff({
      yearMonth: '2026-08',
      now,
      prepaid: false,
      canManage: true,
      pendingCents: 200,
      paidCents: 0,
      amountCents: 200,
    })).toEqual({ ok: true });
  });

  it('rejects write-off above pending with 待付款 wording', () => {
    expect(validateWriteOff({
      yearMonth: '2026-08',
      now,
      prepaid: false,
      canManage: true,
      pendingCents: 200,
      paidCents: 0,
      amountCents: 201,
    })).toEqual({ ok: false, message: '核销金额不可超过待付款金额' });
  });

  it('requires the extended deadline to be later than the current one', () => {
    const currentDueAt = new Date('2026-09-30T15:59:59.000Z');
    expect(validateExtend({
      yearMonth: '2026-08',
      now,
      prepaid: false,
      canManage: true,
      pendingCents: 200,
      paidCents: 0,
      currentDueAt,
      newDueAt: new Date('2026-09-30T15:59:59.000Z'),
    }).ok).toBe(false);
    expect(validateExtend({
      yearMonth: '2026-08',
      now,
      prepaid: false,
      canManage: true,
      pendingCents: 200,
      paidCents: 0,
      currentDueAt,
      newDueAt: new Date('2026-10-15T15:59:59.000Z'),
    })).toEqual({ ok: true });
  });

  it('uses Beijing calendar month bounds, not UTC month bounds', () => {
    const range = beijingMonthRange('2026-09');
    expect(range.start.toISOString()).toBe('2026-08-31T16:00:00.000Z');
    expect(range.endExclusive.toISOString()).toBe('2026-09-30T16:00:00.000Z');
  });

  it('treats credit as prepaid unless the gated active limit is on', () => {
    expect(isPrepaidCredit({
      status: 'ACTIVE',
      activeLimitCents: 10_000,
      policyBoundaryComplete: true,
      policyRevision: 1,
    })).toBe(false);
    expect(isPrepaidCredit({
      status: 'DISABLED',
      activeLimitCents: 0,
      policyBoundaryComplete: false,
      policyRevision: 0,
    })).toBe(true);
  });

  it('keeps suspended credit on the AR flow once it was ever activated', () => {
    // 预付款 = 授信从未启用；SUSPENDED 账户曾经有授信，欠款月仍要走账单核销。
    expect(isPrepaidCredit({
      status: 'SUSPENDED',
      activeLimitCents: 0,
      policyBoundaryComplete: true,
      policyRevision: 3,
    })).toBe(false);
  });

  it('auto-suspends only 待核销 bills that were already overdue at the deadline', () => {
    expect(shouldAutoSuspend({
      status: '待核销',
      dueAt: new Date('2026-09-01T15:59:59.000Z'),
      now,
      pendingAtDeadline: true,
    })).toBe(true);
    expect(shouldAutoSuspend({
      status: '待核销',
      dueAt: new Date('2026-09-01T15:59:59.000Z'),
      now,
      pendingAtDeadline: false,
    })).toBe(false);
    expect(shouldAutoSuspend({
      status: '已核销',
      dueAt: new Date('2026-09-01T15:59:59.000Z'),
      now,
      pendingAtDeadline: true,
    })).toBe(false);
  });

  it('export cutoff is yesterday for current month and calendar month-end for frozen months', () => {
    expect(exportUsageCutoff({
      yearMonth: '2026-09',
      currentMonth: true,
      now,
    })).toEqual(new Date('2026-09-08T00:00:00+08:00'));
    expect(exportUsageCutoff({
      yearMonth: '2026-08',
      currentMonth: false,
      now,
    })).toEqual(new Date('2026-09-01T00:00:00+08:00'));
    expect(exportUsageCutoffInclusiveLabel({
      yearMonth: '2026-09',
      currentMonth: true,
    })).toBe('昨天 23:59:59');
    expect(exportUsageCutoffInclusiveLabel({
      yearMonth: '2026-08',
      currentMonth: false,
    })).toBe('2026-08-31 23:59:59');
  });
});
