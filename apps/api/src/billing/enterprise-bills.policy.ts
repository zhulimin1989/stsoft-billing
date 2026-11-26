import { sumUsdToCents, usd, type DecimalLike } from './money';

export type BillStatus = '待核销' | '已核销';
export type BillAction = 'writeOff' | 'adjust' | 'extend' | 'compensateVoucher';
export type DisableReason =
  | '无操作权限'
  | '预付款账户无需核销'
  | '当月仅支持下载与补偿发券'
  | '无可核销金额'
  | '已付款为0不可补偿发券';

export type PolicyGate = {
  yearMonth: string;
  now: Date;
  prepaid: boolean;
  canManage: boolean;
  /** 待付款金额（分） */
  pendingCents: number;
  /** 列表口径已付款（分）；补偿发券门槛用 */
  paidCents: number;
};

export type PolicyResult = { ok: true } | { ok: false; message: string };

/** 与财务对账「API用量扣费」`mapFinanceApiUsageRows` 同源。 */
export const FINANCE_ALLOCATION_SOURCE_ENTERPRISE_CREDIT = 'ENTERPRISE_CREDIT';
export const FINANCE_ALLOCATION_SOURCE_NEGATIVE_BALANCE = 'NEGATIVE_BALANCE';

export type FinanceUsageAllocation = {
  source?: string | null;
  balanceGrantId?: string | null;
  amountUsd?: DecimalLike | null;
  recognizedRevenueUsd?: DecimalLike | null;
  bonusConsumedUsd?: DecimalLike | null;
  approvedCreditUsd?: DecimalLike | null;
  unapprovedDebtUsd?: DecimalLike | null;
  fundingClassificationComplete?: boolean | null;
};

export type FinanceUsageChannelInput = {
  customerChargeUsd?: DecimalLike | null;
  costUsd?: DecimalLike | null;
  customerChargePolicy?: string | null;
  customerCollectedUsd?: DecimalLike | null;
  customerApprovedReceivableUsd?: DecimalLike | null;
  customerUnapprovedDebtUsd?: DecimalLike | null;
  customerFundingClassificationComplete?: boolean | null;
  allocations?: FinanceUsageAllocation[];
};

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

/** 逾期作业写进授信事件的 reason，自动恢复据此识别人工暂停（ADR-0011）。 */
export const AUTO_SUSPEND_REASON = 'monthly_bill_overdue_auto_suspend';

export function yearMonthInBeijing(at: Date): string {
  const beijing = new Date(at.getTime() + BEIJING_OFFSET_MS);
  const year = beijing.getUTCFullYear();
  const month = String(beijing.getUTCMonth() + 1).padStart(2, '0');
  return `${year}-${month}`;
}

export function beijingMonthRange(yearMonth: string): { start: Date; endExclusive: Date } {
  const start = new Date(`${yearMonth}-01T00:00:00+08:00`);
  return { start, endExclusive: new Date(`${nextYearMonth(yearMonth)}-01T00:00:00+08:00`) };
}

/**
 * Billing 库约定：企业账单相关表的 `created_at` 是 `timestamp without time zone`，
 * 写入落的是 **UTC 墙钟**（Prisma `Date` / `clock_timestamp() AT TIME ZONE 'UTC'`），不是北京墙钟。
 *
 * 列表现算 / 下载汇总 raw SQL 与 Prisma `findMany`、`billing.repository` 对齐：
 * - 范围：`col >= ($bound AT TIME ZONE 'UTC')`
 * - 北京自然月：`to_char((col AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai'), 'YYYY-MM')`
 * 禁止把 UTC 墙钟直接 `AT TIME ZONE 'Asia/Shanghai'`，也禁止裸绑 timestamptz 比较。
 */
export function beijingStartOfToday(now: Date): Date {
  const beijing = new Date(now.getTime() + BEIJING_OFFSET_MS);
  const year = beijing.getUTCFullYear();
  const month = String(beijing.getUTCMonth() + 1).padStart(2, '0');
  const day = String(beijing.getUTCDate()).padStart(2, '0');
  return new Date(`${year}-${month}-${day}T00:00:00+08:00`);
}

/**
 * 导出明细 / 渠道拆分窗口的右开端点（北京时间）。
 * - 当月（未定格）：今天 00:00:00+08 → 含至昨天 23:59:59
 * - 已定格月：次月 1 日 00:00:00+08 → 含至该月最后一天 23:59:59
 */
export function exportUsageCutoff(input: {
  yearMonth: string;
  currentMonth: boolean;
  now: Date;
}): Date {
  if (input.currentMonth) {
    return beijingStartOfToday(input.now);
  }
  return beijingMonthRange(input.yearMonth).endExclusive;
}

/** 下载弹窗「明细截止…」展示用（北京时间，含秒）。 */
export function exportUsageCutoffInclusiveLabel(input: {
  yearMonth: string;
  currentMonth: boolean;
}): string {
  if (input.currentMonth) {
    return '昨天 23:59:59';
  }
  const [yearText, monthText] = input.yearMonth.split('-');
  const year = Number(yearText);
  const month = Number(monthText);
  if (!Number.isInteger(year) || !Number.isInteger(month) || month < 1 || month > 12) {
    return `${input.yearMonth} 月末 23:59:59`;
  }
  const lastDay = new Date(Date.UTC(year, month, 0)).getUTCDate();
  return `${input.yearMonth}-${String(lastDay).padStart(2, '0')} 23:59:59`;
}

export function isPrepaidCredit(input: {
  status: string;
  activeLimitCents: number;
  policyBoundaryComplete: boolean;
  policyRevision: number;
}): boolean {
  // 预付款 = 授信从未启用（无完整策略边界 / 从未修订）。一旦启用过，即使后来停用
  // 或暂停，欠款月仍属于应收账款流程，可继续账单核销/调整/延期。
  if (input.policyRevision === 0 || !input.policyBoundaryComplete) {
    return true;
  }
  return false;
}

export function listYearMonths(openedAt: Date, now: Date): string[] {
  const start = yearMonthInBeijing(openedAt);
  const end = yearMonthInBeijing(now);
  const months: string[] = [];
  let cursor = start;
  while (cursor <= end) {
    months.push(cursor);
    cursor = nextYearMonth(cursor);
  }
  return months.reverse();
}

export function isClosedBeijingMonth(yearMonth: string, now: Date): boolean {
  return yearMonth < yearMonthInBeijing(now);
}

export function defaultDueAt(yearMonth: string, termsDays: number): Date {
  const monthEndBeijing = beijingMonthEnd(yearMonth);
  return new Date(monthEndBeijing.getTime() + termsDays * DAY_MS);
}

export function remainingDays(dueAt: Date, now: Date): number {
  return Math.floor((dueAt.getTime() - now.getTime()) / DAY_MS);
}

/** 扣费金额 = 消耗金额 − 代金券扣费 */
export function chargeCents(input: { consumeCents: number; voucherCents: number }): number {
  return input.consumeCents - input.voucherCents;
}

/**
 * 应收金额 = 消耗 − 代金券抵扣 − 账户支付 + 调整 − 发券。
 * 账户支付取用量报表本金扣费；勾稽恒等式：应收 = 已付款 + 待付款。
 */
export function receivableCents(input: {
  consumeCents: number;
  voucherCents: number;
  accountPayCents?: number;
  adjustedCents: number;
  issuedVoucherCents: number;
}): number {
  return input.consumeCents
    - input.voucherCents
    - (input.accountPayCents ?? 0)
    + input.adjustedCents
    - input.issuedVoucherCents;
}

/**
 * 待付款 = 应收 − 已付款。允许为负（多收 / 调减超过已付）。
 */
export function pendingCents(input: {
  consumeCents: number;
  voucherCents: number;
  accountPayCents?: number;
  adjustedCents: number;
  paidCents: number;
  issuedVoucherCents?: number;
}): number {
  return receivableCents({
    consumeCents: input.consumeCents,
    voucherCents: input.voucherCents,
    accountPayCents: input.accountPayCents,
    adjustedCents: input.adjustedCents,
    issuedVoucherCents: input.issuedVoucherCents ?? 0,
  }) - input.paidCents;
}

/**
 * 列表已付款 = FUNDING（按被清偿消耗的消费日归月）+ 账单核销。
 * 账户支付不再计入已付款，单独列示。
 *
 * 预付款同样计入 FUNDING：无正式授信配置时仍可能产生 ENTERPRISE_CREDIT /
 * unapproved_debt，充值触发的 FUNDING 冲销必须进已付款，否则待付款会挂死
 * （PRD 0928；头文生产案）。`prepaid` 仍由调用方传入以保持签名稳定，不再清零 FUNDING。
 */
export function listPaidCents(input: {
  prepaid: boolean;
  fundingPaidCents: number;
  writeOffPaidCents: number;
}): number {
  void input.prepaid;
  return input.fundingPaidCents + input.writeOffPaidCents;
}

/**
 * 列表 / Excel / 财务「API用量扣费」资金渠道（USD）。
 * 信用只计授信额度内垫付；超授信 / 未分类透支进欠款，不进信用。
 */
export function financeApiUsageChannelUsd(input: FinanceUsageChannelInput): {
  customerChargeUsd: ReturnType<typeof usd>;
  paymentDeductionUsd: ReturnType<typeof usd>;
  voucherDeductionUsd: ReturnType<typeof usd>;
  creditDeductionUsd: ReturnType<typeof usd>;
  debtDeductionUsd: ReturnType<typeof usd>;
} {
  const allocations = input.allocations ?? [];
  const allocatedChargeUsd = sumFinanceUsd(allocations, (row) => row.amountUsd);
  const storedCustomerChargeUsd = usd(input.customerChargeUsd);
  const canFallbackToLegacyCost = !input.customerChargePolicy
    || input.customerChargePolicy === 'usage_charge'
    || input.customerChargePolicy === 'legacy_cost_usd';
  const fallbackChargeUsd = storedCustomerChargeUsd.gt(0)
    ? storedCustomerChargeUsd
    : canFallbackToLegacyCost
      ? usd(input.costUsd).abs()
      : usd(0);
  const customerChargeUsd = allocatedChargeUsd.gt(0) ? allocatedChargeUsd : fallbackChargeUsd;
  const enterpriseCreditAllocations = allocations.filter((allocation) => (
    allocation.source === FINANCE_ALLOCATION_SOURCE_ENTERPRISE_CREDIT
    && allocation.balanceGrantId == null
  ));
  const negativeBalanceAllocations = allocations.filter((allocation) => (
    allocation.source === FINANCE_ALLOCATION_SOURCE_NEGATIVE_BALANCE
    && allocation.balanceGrantId == null
  ));
  const debtFundingAllocations = [
    ...enterpriseCreditAllocations,
    ...negativeBalanceAllocations,
  ];
  const collectedAllocations = allocations.filter((allocation) => (
    !debtFundingAllocations.includes(allocation)
  ));
  const snapshotCollectedUsd = usd(input.customerCollectedUsd);
  const snapshotApprovedCreditUsd = usd(input.customerApprovedReceivableUsd);
  const snapshotUnapprovedDebtUsd = usd(input.customerUnapprovedDebtUsd);
  const useUsageFundingSnapshot = input.customerFundingClassificationComplete === true
    && snapshotCollectedUsd.plus(snapshotApprovedCreditUsd).plus(snapshotUnapprovedDebtUsd).eq(customerChargeUsd)
    && (allocatedChargeUsd.lte(0) || debtFundingAllocations.some(
      (allocation) => allocation.fundingClassificationComplete !== true,
    ));
  const paymentDeductionUsd = allocatedChargeUsd.gt(0)
    ? sumFinanceUsd(collectedAllocations, (allocation) => allocation.recognizedRevenueUsd)
    : useUsageFundingSnapshot
      ? snapshotCollectedUsd
      : customerChargeUsd;
  const voucherDeductionUsd = allocatedChargeUsd.gt(0)
    ? sumFinanceUsd(collectedAllocations, (allocation) => allocation.bonusConsumedUsd)
    : usd(0);
  const creditDeductionUsd = useUsageFundingSnapshot
    ? snapshotApprovedCreditUsd
    : sumFinanceUsd(enterpriseCreditAllocations, (allocation) => (
      allocation.fundingClassificationComplete === true
        ? allocation.approvedCreditUsd
        : usd(0)
    ));
  const debtDeductionUsd = useUsageFundingSnapshot
    ? snapshotUnapprovedDebtUsd
    : sumFinanceUsd(debtFundingAllocations, (allocation) => (
      allocation.fundingClassificationComplete === true
        ? allocation.unapprovedDebtUsd
        : allocation.amountUsd
    ));
  return {
    customerChargeUsd,
    paymentDeductionUsd,
    voucherDeductionUsd,
    creditDeductionUsd,
    debtDeductionUsd,
  };
}

/**
 * 单次用量进分。行展示可用；月勾稽必须用 `financeApiUsageChannelsMonthCents`
 * （头文 9 月 487 行不足 0.5 分：按条加总 2950，先加总再进分 2977）。
 */
export function financeApiUsageChannelCents(input: FinanceUsageChannelInput): {
  accountPayCents: number;
  voucherDeductCents: number;
  creditPayCents: number;
  debtPayCents: number;
} {
  return financeApiUsageChannelsMonthCents([input]);
}

/** 列表 / 用量表月合计：各渠道先 SUM(USD) 再进分，与 SQL `ROUND(SUM(ABS(usd))*100)` 对齐。 */
export function financeApiUsageChannelsMonthCents(
  inputs: FinanceUsageChannelInput[],
): {
  accountPayCents: number;
  voucherDeductCents: number;
  creditPayCents: number;
  debtPayCents: number;
} {
  const channels = inputs.map((input) => financeApiUsageChannelUsd(input));
  return {
    accountPayCents: sumUsdToCents(channels.map((row) => row.paymentDeductionUsd)),
    voucherDeductCents: sumUsdToCents(channels.map((row) => row.voucherDeductionUsd)),
    creditPayCents: sumUsdToCents(channels.map((row) => row.creditDeductionUsd)),
    debtPayCents: sumUsdToCents(channels.map((row) => row.debtDeductionUsd)),
  };
}

function sumFinanceUsd<T>(
  rows: T[],
  pick: (row: T) => DecimalLike | null | undefined,
) {
  return rows.reduce((total, row) => total.plus(usd(pick(row))), usd(0));
}

export function billStatus(input: {
  consumeCents: number;
  voucherCents: number;
  adjustedCents: number;
  paidCents: number;
  issuedVoucherCents?: number;
}): BillStatus {
  const pending = pendingCents(input);
  if (input.paidCents === 0 && pending > 0) {
    return '待核销';
  }
  return '已核销';
}

export function disableReason(action: BillAction, gate: PolicyGate): DisableReason | null {
  if (!gate.canManage) {
    return '无操作权限';
  }
  // 预付款无待付款时无需核销；若有 DEBT_OPEN / 未批准欠款等造成的待付款，允许核销冲销
  if (gate.prepaid && action === 'writeOff' && gate.pendingCents <= 0) {
    return '预付款账户无需核销';
  }
  // 当月：核销 / 调整 / 延期禁用；补偿发券放开
  if (
    action !== 'compensateVoucher'
    && !isClosedBeijingMonth(gate.yearMonth, gate.now)
  ) {
    return '当月仅支持下载与补偿发券';
  }
  if (action === 'writeOff' && gate.pendingCents <= 0) {
    return '无可核销金额';
  }
  if (action === 'compensateVoucher' && gate.paidCents <= 0) {
    return '已付款为0不可补偿发券';
  }
  return null;
}

export function validateWriteOff(input: PolicyGate & { amountCents: number }): PolicyResult {
  const reason = disableReason('writeOff', input);
  if (reason) {
    return { ok: false, message: reason };
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return { ok: false, message: '核销金额必须大于 0' };
  }
  if (input.amountCents > input.pendingCents) {
    return { ok: false, message: '核销金额不可超过待付款金额' };
  }
  return { ok: true };
}

/** 调整原因必填；返回 trim 后的文案。 */
export function normalizeAdjustReason(
  note: string | null | undefined,
): { ok: true; reason: string } | { ok: false; message: string } {
  const text = note?.trim() ?? '';
  if (!text) {
    return { ok: false, message: '调整原因必填' };
  }
  if (text.length > 100) {
    return { ok: false, message: '调整原因不能超过 100 字' };
  }
  return { ok: true, reason: text };
}

export function validateAdjust(input: PolicyGate & {
  consumeCents: number;
  voucherCents: number;
  adjustedCents: number;
  paidCents: number;
  issuedVoucherCents?: number;
  direction: 'increase' | 'decrease';
  amountCents: number;
  reason?: string | null;
}): PolicyResult {
  const reason = disableReason('adjust', input);
  if (reason) {
    return { ok: false, message: reason };
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return { ok: false, message: '调整金额必须大于 0' };
  }
  const normalized = normalizeAdjustReason(input.reason);
  if (!normalized.ok) {
    return normalized;
  }
  // 调减使待付款为负时仍允许落库；列表按勾稽展示负数
  return { ok: true };
}

/** 补偿原因必填；返回 trim 后的文案。 */
export function normalizeCompensateReason(
  note: string | null | undefined,
): { ok: true; reason: string } | { ok: false; message: string } {
  const text = note?.trim() ?? '';
  if (!text) {
    return { ok: false, message: '补偿原因必填' };
  }
  if (text.length > 100) {
    return { ok: false, message: '补偿原因不能超过 100 字' };
  }
  return { ok: true, reason: text };
}

export function validateCompensateVoucher(input: PolicyGate & {
  amountCents: number;
  reason?: string | null;
}): PolicyResult {
  const reason = disableReason('compensateVoucher', input);
  if (reason) {
    return { ok: false, message: reason };
  }
  if (!Number.isInteger(input.amountCents) || input.amountCents <= 0) {
    return { ok: false, message: '补偿金额必须大于 0' };
  }
  if (input.amountCents > input.paidCents) {
    return { ok: false, message: '补偿金额不可超过已付款金额' };
  }
  const normalized = normalizeCompensateReason(input.reason);
  if (!normalized.ok) {
    return normalized;
  }
  return { ok: true };
}

export function validateExtend(input: PolicyGate & {
  currentDueAt: Date;
  newDueAt: Date;
}): PolicyResult {
  const reason = disableReason('extend', input);
  if (reason) {
    return { ok: false, message: reason };
  }
  if (!(input.newDueAt.getTime() > input.currentDueAt.getTime())) {
    return { ok: false, message: '延期后的账期截止时间必须晚于当前截止时间' };
  }
  return { ok: true };
}

export function shouldAutoSuspend(input: {
  status: BillStatus;
  dueAt: Date;
  now: Date;
  pendingAtDeadline: boolean;
}): boolean {
  if (input.status !== '待核销') {
    return false;
  }
  if (input.now.getTime() <= input.dueAt.getTime()) {
    return false;
  }
  return input.pendingAtDeadline;
}

export function nextYearMonth(yearMonth: string): string {
  const [year, month] = yearMonth.split('-').map(Number);
  if (month === 12) {
    return `${year + 1}-01`;
  }
  return `${year}-${String(month + 1).padStart(2, '0')}`;
}

export function previousYearMonth(yearMonth: string): string {
  const [year, month] = yearMonth.split('-').map(Number);
  if (month === 1) {
    return `${year - 1}-12`;
  }
  return `${year}-${String(month - 1).padStart(2, '0')}`;
}

function beijingMonthEnd(yearMonth: string): Date {
  const next = nextYearMonth(yearMonth);
  return new Date(new Date(`${next}-01T00:00:00+08:00`).getTime() - 1000);
}
