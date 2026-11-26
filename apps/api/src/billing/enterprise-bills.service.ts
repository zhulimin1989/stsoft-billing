import { createHash } from 'crypto';
import {
  BadRequestException,
  HttpException,
  Injectable,
  InternalServerErrorException,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { usd, usdToCents, type DecimalLike } from './money';
import {
  beijingMonthRange,
  billStatus,
  chargeCents as computeChargeCents,
  defaultDueAt,
  disableReason,
  exportUsageCutoff,
  isClosedBeijingMonth,
  isPrepaidCredit,
  listPaidCents as computeListPaidCents,
  listYearMonths,
  normalizeAdjustReason,
  normalizeCompensateReason,
  pendingCents as computePendingCents,
  receivableCents as computeReceivableCents,
  remainingDays,
  validateAdjust,
  validateCompensateVoucher,
  validateExtend,
  validateWriteOff,
  yearMonthInBeijing,
  AUTO_SUSPEND_REASON,
} from './enterprise-bills.policy';
import { PassThrough } from 'node:stream';
import {
  UNATTRIBUTED_LEDGER_KEY,
  buildExportBucketsFromAggregateGroups,
  writeEnterpriseBillXlsx,
  type DetailLine,
  type EnterpriseBillXlsxSummary,
  type LedgerBreakdown,
  type LedgerMoneyBucket,
  type UsageRow,
} from './enterprise-bills-xlsx';
import {
  buildEnterpriseUsageAggregateQuery,
  type EnterpriseUsageAggregateRow,
} from './enterprise-bills-export-aggregate';
import type { EnterpriseBillWalletPort } from './enterprise-bills-wallet.port';
import { Prisma, PrismaClient } from '@prisma/client';
import { EnterpriseBillWalletAdapter } from './enterprise-bills-wallet.adapter';
import { PrismaService, createBillingAdvisoryLockClient } from '../prisma/prisma.service';

export type CloseHistoricalClosedMonthsResult = {
  skipped: boolean;
  yearMonth: string | null;
  yearMonths: string[];
  processed: number;
  hasMore: boolean;
  /** 指定单户时回传；全库跑则为 null */
  billingAccountId: string | null;
};

export type RefreshCurrentMonthSummariesResult = {
  skipped: boolean;
  yearMonth: string;
  processed: number;
  fundingProcessed: number;
  hasMore: boolean;
};

const CLOSE_MONTH_LOCK_NAME = 'enterprise-bill-month-summaries-close';
const REFRESH_MONTH_LOCK_NAME = 'enterprise-bill-month-summaries-refresh';

export type EnterpriseBillView = {
  yearMonth: string;
  currentMonth: boolean;
  requestCount: number;
  tokenTotal: number;
  consumeCents: number;
  /** 用量报表本金扣费 */
  accountPayCents: number;
  /** 用量报表赠送扣费 / 代金券抵扣 */
  voucherDeductCents: number;
  /** 用量报表信用扣费（授信额度内垫付） */
  creditPayCents: number;
  /** 用量报表欠费（超授信 / 未分类透支，消费当时来源） */
  debtPayCents: number;
  adjustedCents: number;
  /** 补偿发券累计（分） */
  issuedVoucherCents: number;
  receivableCents: number;
  paidCents: number;
  pendingCents: number;
  status: '待核销' | '已核销';
  termsDays: number | null;
  dueAt: string | null;
  /** 当月授信户的预计死线（未闭月冻结）；预付款为 false */
  dueProjected: boolean;
  originalDueAt: string | null;
  extended: boolean;
  remainingDays: number | null;
  prepaid: boolean;
  writeOffDisabledReason: string | null;
  adjustDisabledReason: string | null;
  extendDisabledReason: string | null;
  compensateDisabledReason: string | null;
};

/** 定格 / Excel / 写汇总仍要扣费金额；列表改暴露三渠道，不再隐藏券扣。 */
type EnterpriseBillPersistView = EnterpriseBillView & {
  voucherCents: number;
  chargeCents: number;
};

export type EnterpriseBillAccountSummary = {
  billingAccountId: string;
  earliestDueAt: string | null;
  /** earliestDueAt 是否来自当月预计死线 */
  earliestDueProjected: boolean;
  dueWarning: boolean;
  usedCents: number;
  prepaid: boolean;
};

export type EnterpriseBillOverdueDecision = {
  suspend: string[];
  restore: string[];
};

type CreditConfig = {
  status: string;
  limitUsd: DecimalLike | null;
  termsDays: number | null;
  effectiveAt: Date | null;
  expiresAt: Date | null;
  policyRevision: number;
  policyBoundaryComplete: boolean;
};

type AccountRow = {
  id: string;
  type: string;
  createdAt: Date;
  deletedAt: Date | null;
  enterpriseName: string | null;
  creditConfig: CreditConfig | null;
};

type DeadlineRow = {
  billingAccountId: string;
  yearMonth: string;
  termsDays: number;
  defaultDueAt: Date;
  frozenAt: Date;
  frozenConsumeCents: number | bigint | null;
  frozenVoucherCents: number | bigint | null;
  frozenChargeCents: number | bigint | null;
  frozenTokenTotal: number | bigint | null;
  frozenRequestCount: number | bigint | null;
  amountsFrozenAt: Date | null;
  pendingAtDeadline: boolean | null;
  pendingObservedAt: Date | null;
};

type SummaryRow = {
  billingAccountId: string;
  yearMonth: string;
  paidCents: number | bigint;
  pendingCents: number | bigint;
  adjustedCents: number | bigint;
  issuedVoucherCents: number | bigint;
  consumeCents: number | bigint;
  voucherCents?: number | bigint;
  chargeCents?: number | bigint;
  accountPayCents?: number | bigint;
  creditPayCents?: number | bigint;
  debtPayCents?: number | bigint;
  tokenTotal?: number | bigint;
  requestCount?: number | bigint;
  effectiveDueAt: Date | null;
  dueProjected: boolean;
};

type EventStatus = 'PENDING' | 'CONFIRMED' | 'FAILED';

/** 串行化写路径的落定结果：失败分支由调用方在事务提交后抛出，避免 FAILED 审计随回滚丢失。 */
type SerializedWriteResult =
  | { ok: true; view: EnterpriseBillPersistView; replayed?: boolean }
  | { ok: false; error: unknown };

type EventRow = {
  billingAccountId: string;
  yearMonth: string;
  type: string;
  amountCents: number | bigint;
  dueAt: Date | null;
  note: string | null;
  actorId: string | null;
  status: EventStatus;
  createdAt: Date;
};

type ListPaidCents = {
  cashCents: number;
  fundingCents: number;
  creditCents: number;
  debtCents: number;
  voucherCents: number;
};

function emptyListPaid(): ListPaidCents {
  return { cashCents: 0, fundingCents: 0, creditCents: 0, debtCents: 0, voucherCents: 0 };
}

type MonthAmounts = {
  consumeCents: number;
  voucherCents: number;
  chargeCents: number;
  accountPayCents: number;
  creditPayCents: number;
  debtPayCents: number;
  tokenTotal: number;
  requestCount: number;
};

type AssembledMonth = {
  yearMonth: string;
  currentMonth: boolean;
  prepaid: boolean;
  requestCount: number;
  tokenTotal: number;
  consumeCents: number;
  voucherCents: number;
  chargeCents: number;
  accountPayCents: number;
  creditPayCents: number;
  debtPayCents: number;
  adjustedCents: number;
  issuedVoucherCents: number;
  receivableCents: number;
  paidCents: number;
  pendingCents: number;
  status: '待核销' | '已核销';
  termsDays: number | null;
  dueAt: string | null;
  dueProjected: boolean;
  originalDueAt: string | null;
  extended: boolean;
  remainingDays: number | null;
  pendingAtDeadline: boolean | null;
  events: Array<Omit<EventRow, 'amountCents'> & { amountCents: number }>;
};

type BillsPrisma = {
  $queryRaw: <T>(query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => Promise<T>;
  $executeRaw: (query: TemplateStringsArray | Prisma.Sql, ...values: unknown[]) => Promise<unknown>;
  billingAccount: {
    findUnique: (args: unknown) => Promise<AccountRow | null>;
    findMany: (args: unknown) => Promise<AccountRow[]>;
  };
  billingAccountCreditEvent: {
    findFirst: (args: unknown) => Promise<{ reason: string | null } | null>;
    findMany: (args: unknown) => Promise<Array<{ billingAccountId: string; reason: string | null }>>;
  };
  tenant: {
    findMany: (args: unknown) => Promise<Array<{ id: string; billingAccountId?: string }>>;
  };
  balanceTransaction: {
    findMany: (args: unknown) => Promise<Array<{
      amountUsd: DecimalLike | null;
      createdAt: Date;
      tenantId?: string | null;
      tokenUsageId?: string | null;
      consumptionAllocations?: Array<{ bonusConsumedUsd: DecimalLike | null }>;
    }>>;
  };
  balanceConsumptionAllocation: {
    findMany: (args: unknown) => Promise<Array<{
      amountUsd?: DecimalLike | null;
      bonusConsumedUsd: DecimalLike | null;
      recognizedRevenueUsd?: DecimalLike | null;
      source?: string | null;
      balanceGrantId?: string | null;
      createdAt: Date;
      tenantId?: string | null;
      tokenUsageId?: string | null;
      tokenUsage?: { model: string } | null;
    }>>;
  };
  enterpriseCreditSettlement: {
    findMany: (args: unknown) => Promise<Array<{
      amountUsd: DecimalLike | null;
      allocation?: { createdAt: Date } | null;
    }>>;
  };
  tokenUsage: {
    findMany: (args: unknown) => Promise<Array<{
      createdAt: Date;
      tenantId?: string;
      model?: string;
      callType?: string | null;
      totalTokens: number;
      promptTokens?: number | null;
      cachedInputTokens?: number | null;
      cacheWriteInputTokens?: number | null;
      completionTokens?: number | null;
      unitPriceUsd?: DecimalLike | null;
      inputPriceUsdPerM?: DecimalLike | null;
      cachedInputPriceUsdPerM?: DecimalLike | null;
      cacheWritePriceUsdPerM?: DecimalLike | null;
      outputPriceUsdPerM?: DecimalLike | null;
      customerChargeUsd?: DecimalLike | null;
      costUsd?: DecimalLike | null;
      customerChargePolicy?: string | null;
      gatewayBillingEvent?: {
        settlementAnchor?: {
          customerPricingSnapshot?: unknown;
        } | null;
      } | null;
      consumptionAllocations?: Array<{
        balanceGrantId?: string | null;
        source?: string | null;
        amountUsd?: DecimalLike | null;
        recognizedRevenueUsd?: DecimalLike | null;
        bonusConsumedUsd?: DecimalLike | null;
        approvedCreditUsd?: DecimalLike | null;
        unapprovedDebtUsd?: DecimalLike | null;
      }>;
    }>>;
  };
  enterpriseBillDeadline: {
    findFirst: (args: unknown) => Promise<DeadlineRow | null>;
    findMany: (args: unknown) => Promise<DeadlineRow[]>;
    upsert: (args: unknown) => Promise<DeadlineRow>;
    update: (args: unknown) => Promise<DeadlineRow>;
    updateMany: (args: unknown) => Promise<{ count: number }>;
  };
  enterpriseBillEvent: {
    findUnique: (args: unknown) => Promise<(EventRow & { id: string }) | null>;
    findMany: (args: unknown) => Promise<EventRow[]>;
    create: (args: unknown) => Promise<EventRow & { id: string }>;
    update: (args: unknown) => Promise<EventRow & { id: string }>;
  };
  enterpriseBillMonthSummary: {
    findMany: (args: unknown) => Promise<SummaryRow[]>;
    findFirst: (args: unknown) => Promise<SummaryRow | null>;
    createMany: (args: unknown) => Promise<{ count: number }>;
    upsert: (args: unknown) => Promise<SummaryRow>;
  };
};

const ENTERPRISE_ACCOUNT_TYPE = 'enterprise';
const ALLOCATION_SOURCE_ENTERPRISE_CREDIT = 'ENTERPRISE_CREDIT';
const ALLOCATION_SOURCE_NEGATIVE_BALANCE = 'NEGATIVE_BALANCE';
const SETTLEMENT_TRIGGER_FUNDING = 'FUNDING';
/** 账单下载：按工作区等值翻页，禁止整月 IN findMany。 */
// 明细导出分页大小：单页越大，往返次数与 Prisma 关联查询次数越少（大客户单月百万行级）。
// 单页对象在折叠后即丢弃，峰值内存只与单页大小相关，不随整月增长。
export const USAGE_EXPORT_PAGE_SIZE = 8000;

@Injectable()
export class EnterpriseBillsService {
  private readonly logger = new Logger(EnterpriseBillsService.name);
  private readonly wallet: EnterpriseBillWalletPort | null;

  constructor(
    private readonly prisma: PrismaService,
    @Optional() walletAdapter?: EnterpriseBillWalletAdapter,
  ) {
    this.wallet = walletAdapter ?? null;
    this._db = this.prisma as unknown as BillsPrisma;
  }

  async listBills(
    accountId: string,
    options: { now: Date; canManage: boolean },
  ): Promise<EnterpriseBillView[]> {
    const assembled = await this.assembleAccount(accountId, options.now, {
      // 列表金额一律现算：消耗 / token 走 live；三渠道走 loadListPaidByMonth；不读 month_summaries。
      includeVoucher: false,
      includeUsage: true,
    });
    return assembled.bills.map((bill) => this.toView(bill, assembled.prepaid, options.canManage, options.now));
  }

  async summarizeAccounts(accountIds: string[], now: Date): Promise<EnterpriseBillAccountSummary[]> {
    const uniqueIds = [...new Set(accountIds.filter(Boolean))];
    if (uniqueIds.length === 0) {
      return [];
    }
    const [accountRows, summaryRows] = await Promise.all([
      this.db().billingAccount.findMany({
        where: { id: { in: uniqueIds } },
        include: { creditConfig: true },
      }),
      this.db().enterpriseBillMonthSummary.findMany({
        where: { billingAccountId: { in: uniqueIds } },
      }),
    ]);
    const accounts = accountRows.filter((row): row is AccountRow =>
      row != null
      && row.type === ENTERPRISE_ACCOUNT_TYPE
      && row.deletedAt == null
    );
    const accountById = new Map(accounts.map((row) => [row.id, row]));
    const currentMonth = yearMonthInBeijing(now);
    const currentByAccount = new Map<string, SummaryRow>();
    const pendingByAccount = new Map<string, SummaryRow[]>();
    for (const row of summaryRows) {
      if (row.yearMonth === currentMonth) {
        currentByAccount.set(row.billingAccountId, row);
        continue;
      }
      if (countOf(row.pendingCents) <= 0) {
        continue;
      }
      const list = pendingByAccount.get(row.billingAccountId) ?? [];
      list.push(row);
      pendingByAccount.set(row.billingAccountId, list);
    }
    const summaries: EnterpriseBillAccountSummary[] = [];
    for (const accountId of uniqueIds) {
      const account = accountById.get(accountId);
      if (!account) {
        continue;
      }
      const prepaid = isPrepaidFromConfig(account.creditConfig, now);
      const closedRows = pendingByAccount.get(accountId) ?? [];
      let earliestDueAt: Date | null = null;
      let earliestDueProjected = false;
      let dueWarning = false;
      let closedPendingCents = 0;
      for (const row of closedRows) {
        closedPendingCents += countOf(row.pendingCents);
        if (!row.effectiveDueAt) {
          continue;
        }
        if (!earliestDueAt || row.effectiveDueAt.getTime() < earliestDueAt.getTime()) {
          earliestDueAt = row.effectiveDueAt;
          earliestDueProjected = false;
        }
        if (remainingDays(row.effectiveDueAt, now) < 10) {
          dueWarning = true;
        }
      }

      const cached = currentByAccount.get(accountId);
      let currentPending = 0;
      let currentOpenCharge = 0;
      if (cached) {
        currentPending = countOf(cached.pendingCents);
        currentOpenCharge = Math.max(0, countOf(cached.chargeCents) - countOf(cached.pendingCents));
        if (currentPending > 0 && cached.effectiveDueAt) {
          if (!earliestDueAt || cached.effectiveDueAt.getTime() < earliestDueAt.getTime()) {
            earliestDueAt = cached.effectiveDueAt;
            earliestDueProjected = cached.dueProjected;
          }
          if (remainingDays(cached.effectiveDueAt, now) < 10) {
            dueWarning = true;
          }
        }
      }
      summaries.push({
        billingAccountId: accountId,
        earliestDueAt: earliestDueAt ? earliestDueAt.toISOString() : null,
        earliestDueProjected,
        dueWarning,
        usedCents: closedPendingCents + currentPending + currentOpenCharge,
        prepaid,
      });
    }
    return summaries;
  }

  /**
   * K8s / 手动：按户同步已闭月汇总到 listBills 现算口径。
   * 缺定格则补（frozen_* 只写一次）；已有定格不改；汇总一律按 listBills 重写（含 effectiveDueAt）。
   * 可选 billingAccountId 只跑一户。抢不到锁 → skipped + hasMore。
   */
  async closeHistoricalClosedMonths(
    now: Date = new Date(),
    options: { billingAccountId?: string } = {},
  ): Promise<CloseHistoricalClosedMonthsResult> {
    const empty: CloseHistoricalClosedMonthsResult = {
      skipped: false,
      yearMonth: null,
      yearMonths: [],
      processed: 0,
      hasMore: false,
      billingAccountId: options.billingAccountId ?? null,
    };
    const locked = await this.withSessionAdvisoryLock(
      CLOSE_MONTH_LOCK_NAME,
      () => this.drainClosedMonths(now, options, empty),
    );
    if (!locked.acquired) {
      return { ...empty, skipped: true, hasMore: true };
    }
    return locked.value;
  }

  private async drainClosedMonths(
    now: Date,
    options: { billingAccountId?: string },
    empty: CloseHistoricalClosedMonthsResult,
  ): Promise<CloseHistoricalClosedMonthsResult> {
    const accountFilter = options.billingAccountId
      ? { id: options.billingAccountId, type: ENTERPRISE_ACCOUNT_TYPE, deletedAt: null }
      : { type: ENTERPRISE_ACCOUNT_TYPE, deletedAt: null };
    const accounts = await this.db().billingAccount.findMany({
      where: accountFilter,
      include: { creditConfig: true },
      orderBy: { id: 'asc' },
    });
    if (accounts.length === 0) {
      return empty;
    }
    const yearMonths: string[] = [];
    let processed = 0;
    let lastAccountId: string | null = null;

    for (const account of accounts) {
      lastAccountId = account.id;
      const deadlines = await this.db().enterpriseBillDeadline.findMany({
        where: { billingAccountId: account.id },
      });
      const deadlineByMonth = new Map(deadlines.map((row) => [row.yearMonth, row]));
      for (const yearMonth of this.closedMonthsForAccount(account, now)) {
        const deadline = await this.ensureFrozenDeadline(
          account,
          yearMonth,
          now,
          deadlineByMonth.get(yearMonth) ?? null,
        );
        deadlineByMonth.set(yearMonth, deadline);
        await this.writeMonthSummaryFromListBills(account, yearMonth, now, deadline);
        if (!yearMonths.includes(yearMonth)) {
          yearMonths.push(yearMonth);
        }
        processed += 1;
      }
    }

    return {
      skipped: false,
      yearMonth: yearMonths[yearMonths.length - 1] ?? null,
      yearMonths,
      processed,
      hasMore: false,
      billingAccountId: options.billingAccountId ?? lastAccountId,
    };
  }

  /**
   * K8s 无参调度：刷新当前北京月汇总（含用量）和资金快照。
   * 用户 GET 只读这行，不扫 token_usage。
   * 互斥与 close 相同：session advisory lock 钉在 connection_limit=1 的连接上（无 BEGIN），
   * 活算仍走连接池；抢不到锁才 skipped + hasMore，等下一轮 Cron / 按钮。
   */
  async refreshCurrentMonthSummaries(
    now: Date = new Date(),
    refreshFunding?: () => Promise<number>,
  ): Promise<RefreshCurrentMonthSummariesResult> {
    const yearMonth = yearMonthInBeijing(now);
    const empty: RefreshCurrentMonthSummariesResult = {
      skipped: true,
      yearMonth,
      processed: 0,
      fundingProcessed: 0,
      hasMore: true,
    };
    const locked = await this.withSessionAdvisoryLock(
      REFRESH_MONTH_LOCK_NAME,
      () => this.refreshCurrentMonthLocked(now, yearMonth, refreshFunding),
    );
    if (!locked.acquired) {
      return empty;
    }
    return locked.value;
  }

  private async refreshCurrentMonthLocked(
    now: Date,
    yearMonth: string,
    refreshFunding?: () => Promise<number>,
  ): Promise<RefreshCurrentMonthSummariesResult> {
    const accounts = await this.db().billingAccount.findMany({
      where: { type: ENTERPRISE_ACCOUNT_TYPE, deletedAt: null },
      include: { creditConfig: true },
    });
    await this.ensureCurrentMonthPlaceholders(accounts.map((row) => row.id), yearMonth);
    for (const account of accounts) {
      const prepaid = isPrepaidFromConfig(account.creditConfig, now);
      const [amountsByMonth, listPaidByMonth, events] = await Promise.all([
        this.loadLiveAmountsByMonth(account.id, [yearMonth], undefined, { includeUsage: true }),
        this.loadListPaidByMonth(account.id, [yearMonth]),
        this.db().enterpriseBillEvent.findMany({
          where: { billingAccountId: account.id, yearMonth, status: 'CONFIRMED' },
        }),
      ]);
      const listPaid = listPaidByMonth.get(yearMonth) ?? emptyListPaid();
      const bill = this.assembleMonth({
        yearMonth,
        now,
        prepaid,
        amounts: withChannelAmounts(amountsByMonth.get(yearMonth) ?? emptyAmounts(), listPaid),
        deadline: null,
        events,
        termsDays: account.creditConfig?.termsDays ?? null,
        cashPaidCents: listPaid.cashCents,
        fundingPaidCents: listPaid.fundingCents,
      });
      await this.upsertMonthSummaryFromView(
        this.db(),
        account.id,
        yearMonth,
        this.toPersistView(bill, prepaid, true, now),
      );
    }
    const fundingProcessed = refreshFunding ? await refreshFunding() : 0;
    return {
      skipped: false,
      yearMonth,
      processed: accounts.length,
      fundingProcessed,
      hasMore: false,
    };
  }

  async writeOff(
    accountId: string,
    yearMonth: string,
    input: {
      amountCents: number;
      note?: string | null;
      actorId: string;
      canManage: boolean;
      now: Date;
      idempotencyKey?: string;
    },
  ): Promise<EnterpriseBillView> {
    const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
    const outcome = await this.runSerializedWrite<SerializedWriteResult>(accountId, async (db) => {
      const bill = await this.requireBill(accountId, yearMonth, input);
      const eventId = billEventId('write-off', accountId, yearMonth, idempotencyKey);
      const existing = await db.enterpriseBillEvent.findUnique({ where: { id: eventId } });
      if (existing?.status === 'CONFIRMED') {
        this.assertBillIdempotencyMatch(existing, {
          amountCents: input.amountCents,
          note: requireWriteOffNote(input.note),
        }, { accountId, yearMonth, kind: 'write-off' });
        return { ok: true, view: bill };
      }
      const result = validateWriteOff({
        yearMonth,
        now: input.now,
        prepaid: bill.prepaid,
        canManage: input.canManage,
        pendingCents: bill.pendingCents,
        paidCents: bill.paidCents,
        amountCents: input.amountCents,
      });
      if (!result.ok) {
        throw new BadRequestException(result.message);
      }
      // 只改账单行：已付款 ↑。不加减钱包余额（ADR-0019）。
      await db.enterpriseBillEvent.create({
        data: {
          id: eventId,
          billingAccountId: accountId,
          yearMonth,
          type: 'WRITE_OFF',
          amountCents: input.amountCents,
          note: requireWriteOffNote(input.note),
          actorId: input.actorId,
          status: 'CONFIRMED',
        },
      });
      const view = this.applyConfirmedEventToView(bill, { adjustedCents: 0, paidCents: input.amountCents }, input);
      await this.upsertMonthSummaryFromView(db, accountId, yearMonth, view);
      return { ok: true, view };
    });
    if (outcome.ok) {
      return this.toPublicBill(outcome.view);
    }
    throw outcome.error;
  }

  async adjust(
    accountId: string,
    yearMonth: string,
    input: {
      direction: 'increase' | 'decrease';
      amountCents: number;
      note?: string | null;
      actorId: string;
      canManage: boolean;
      now: Date;
      idempotencyKey?: string;
    },
  ): Promise<EnterpriseBillView> {
    const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
    const outcome = await this.runSerializedWrite<SerializedWriteResult>(accountId, async (db) => {
      const bill = await this.requireBill(accountId, yearMonth, input);
      const normalized = normalizeAdjustReason(input.note);
      if (!normalized.ok) {
        throw new BadRequestException(normalized.message);
      }
      const reason = normalized.reason;
      const signed = input.direction === 'increase' ? input.amountCents : -input.amountCents;
      const eventId = billEventId('adjust', accountId, yearMonth, idempotencyKey);
      const existing = await db.enterpriseBillEvent.findUnique({ where: { id: eventId } });
      if (existing?.status === 'CONFIRMED') {
        this.assertBillIdempotencyMatch(existing, {
          amountCents: signed,
          note: reason,
        }, { accountId, yearMonth, kind: 'adjust' });
        return { ok: true, view: bill };
      }
      const result = validateAdjust({
        yearMonth,
        now: input.now,
        prepaid: bill.prepaid,
        canManage: input.canManage,
        pendingCents: bill.pendingCents,
        consumeCents: bill.consumeCents,
        voucherCents: bill.voucherCents,
        adjustedCents: bill.adjustedCents,
        paidCents: bill.paidCents,
        issuedVoucherCents: bill.issuedVoucherCents,
        direction: input.direction,
        amountCents: input.amountCents,
        reason,
      });
      if (!result.ok) {
        throw new BadRequestException(result.message);
      }
      // 只改账单行：调整金额。不加减钱包余额（ADR-0019）。
      await db.enterpriseBillEvent.create({
        data: {
          id: eventId,
          billingAccountId: accountId,
          yearMonth,
          type: 'ADJUST',
          amountCents: signed,
          note: reason,
          actorId: input.actorId,
          status: 'CONFIRMED',
        },
      });
      const view = this.applyConfirmedEventToView(bill, { adjustedCents: signed, paidCents: 0 }, input);
      await this.upsertMonthSummaryFromView(db, accountId, yearMonth, view);
      return { ok: true, view };
    });
    if (outcome.ok) {
      return this.toPublicBill(outcome.view);
    }
    throw outcome.error;
  }

  async compensateVoucher(
    accountId: string,
    yearMonth: string,
    input: {
      amountCents: number;
      note?: string | null;
      productId: string;
      tenantId?: string | null;
      actorId: string;
      canManage: boolean;
      now: Date;
      /** 管理端幂等键；钱包与账单事件都按此键回放，禁止用 event.id */
      idempotencyKey?: string;
    },
  ): Promise<EnterpriseBillView> {
    const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
    const outcome = await this.runSerializedWrite<SerializedWriteResult>(accountId, async (db) => {
      const bill = await this.requireBill(accountId, yearMonth, input);
      const normalized = normalizeCompensateReason(input.note);
      if (!normalized.ok) {
        throw new BadRequestException(normalized.message);
      }
      const reason = normalized.reason;
      const eventId = billEventId('compensate', accountId, yearMonth, idempotencyKey);
      const existing = await db.enterpriseBillEvent.findUnique({ where: { id: eventId } });
      if (existing) {
        this.assertBillIdempotencyMatch(existing, {
          amountCents: input.amountCents,
          note: reason,
        }, { accountId, yearMonth, kind: 'compensate' });
        if (existing.status === 'CONFIRMED') {
          return { ok: true, view: bill };
        }
      }
      // 复用 FAILED/PENDING 时以事件行为准，不用本次 input 发券/写汇总。
      const amountCents = existing ? countOf(existing.amountCents) : input.amountCents;
      const note = existing ? (existing.note ?? reason) : reason;
      const result = validateCompensateVoucher({
        yearMonth,
        now: input.now,
        prepaid: bill.prepaid,
        canManage: input.canManage,
        pendingCents: bill.pendingCents,
        paidCents: bill.paidCents,
        amountCents,
        reason: note,
      });
      if (!result.ok) {
        throw new BadRequestException(result.message);
      }
      // 发券前置校验：避免事件落库后才发现发券端口不可用
      this.ensureWalletAvailable();
      // 事件先 PENDING；发券成功 → CONFIRMED，失败保留 FAILED。补偿发券不改钱包余额。
      const event = existing ?? await db.enterpriseBillEvent.create({
        data: {
          id: eventId,
          billingAccountId: accountId,
          yearMonth,
          type: 'COMPENSATE_VOUCHER',
          amountCents,
          note,
          actorId: input.actorId,
          status: 'PENDING',
        },
      });
      try {
        await this.applyVoucherIssue({
          billingAccountId: accountId,
          amountCents,
          reason: `企业账单补偿发券 ${yearMonth}: ${note}`,
          productId: input.productId,
          tenantId: input.tenantId,
          performedBy: input.actorId,
          idempotencyKey: `enterprise-bill-compensate:${idempotencyKey}`,
        });
      } catch (error) {
        await this.settleEventStatus('compensateVoucher', accountId, yearMonth, event.id, 'FAILED', db);
        this.logger.error(
          `compensateVoucher issue failed account=${accountId} month=${yearMonth} eventId=${event.id}`,
          error instanceof Error ? error.message : String(error),
        );
        return { ok: false, error };
      }
      await this.settleEventStatus('compensateVoucher', accountId, yearMonth, event.id, 'CONFIRMED', db);
      const view = this.applyConfirmedEventToView(
        bill,
        { adjustedCents: 0, paidCents: 0, issuedVoucherCents: amountCents },
        input,
      );
      await this.upsertMonthSummaryFromView(db, accountId, yearMonth, view);
      return { ok: true, view };
    });
    if (outcome.ok) {
      return this.toPublicBill(outcome.view);
    }
    throw outcome.error;
  }

  async extend(
    accountId: string,
    yearMonth: string,
    input: {
      newDueAt: Date;
      actorId: string;
      canManage: boolean;
      now: Date;
      idempotencyKey?: string;
    },
  ): Promise<EnterpriseBillView & { replayed: boolean }> {
    const idempotencyKey = requireIdempotencyKey(input.idempotencyKey);
    const outcome = await this.runSerializedWrite<SerializedWriteResult>(accountId, async (db) => {
      const bill = await this.requireBill(accountId, yearMonth, input);
      const eventId = billEventId('extend', accountId, yearMonth, idempotencyKey);
      const existing = await db.enterpriseBillEvent.findUnique({ where: { id: eventId } });
      if (existing?.status === 'CONFIRMED') {
        this.assertBillIdempotencyMatch(existing, {
          amountCents: 0,
          note: '',
          dueAt: input.newDueAt,
        }, { accountId, yearMonth, kind: 'extend' });
        return { ok: true, view: bill, replayed: true };
      }
      if (!bill.dueAt) {
        throw new BadRequestException('当前账单没有账期截止时间，无法延期');
      }
      const result = validateExtend({
        yearMonth,
        now: input.now,
        prepaid: bill.prepaid,
        canManage: input.canManage,
        pendingCents: bill.pendingCents,
        paidCents: bill.paidCents,
        currentDueAt: new Date(bill.dueAt),
        newDueAt: input.newDueAt,
      });
      if (!result.ok) {
        throw new BadRequestException(result.message);
      }
      // 只改账期事件与月汇总 due。不加减钱包余额（ADR-0019）。
      await db.enterpriseBillEvent.create({
        data: {
          id: eventId,
          billingAccountId: accountId,
          yearMonth,
          type: 'EXTEND',
          amountCents: 0,
          dueAt: input.newDueAt,
          actorId: input.actorId,
          status: 'CONFIRMED',
        },
      });
      const view = this.applyConfirmedEventToView(
        bill,
        { adjustedCents: 0, paidCents: 0, dueAt: input.newDueAt },
        input,
      );
      await this.upsertMonthSummaryFromView(db, accountId, yearMonth, view);
      if (input.newDueAt.getTime() > input.now.getTime()) {
        await db.enterpriseBillDeadline.updateMany({
          where: {
            billingAccountId: accountId,
            yearMonth,
            pendingAtDeadline: { not: null },
          },
          data: { pendingAtDeadline: null, pendingObservedAt: null },
        });
      }
      return { ok: true, view, replayed: false };
    });
    if (outcome.ok) {
      return { ...this.toPublicBill(outcome.view), replayed: outcome.replayed === true };
    }
    throw outcome.error;
  }

  /**
   * 返回的 stream 在方法 resolve 时还没有数据：账头校验完就立刻 resolve，
   * 让调用方能把 200 + Content-Disposition 提前发出去（浏览器据此立刻建下载条目），
   * 用量聚合与 xlsx 写入在后台任务里继续跑。
   */
  async download(
    accountId: string,
    yearMonth: string,
    options: { now: Date; exportedAt?: Date; signal?: AbortSignal },
  ): Promise<{ filename: string; stream: PassThrough }> {
    // 列表 assembleAccount 会扫全历史三渠道；下载只要当月账头，头发出去后再扫明细。
    const assembled = await this.assembleDownloadAccount(accountId, yearMonth, options.now);
    const bill = assembled.bill;
    const exportedAt = options.exportedAt ?? options.now;
    // 当月：截止昨天 23:59:59；已定格月：截止该月最后一天 23:59:59（不按 amountsFrozenAt）。
    const usageCutoff = exportUsageCutoff({
      yearMonth,
      currentMonth: bill.currentMonth,
      now: options.now,
    });
    const billView = this.toPersistView(bill, assembled.prepaid, true, options.now);
    const enterpriseName = assembled.account.enterpriseName?.trim() || assembled.account.id;
    const stream = new PassThrough({ highWaterMark: 64 * 1024 });
    const writing = (async () => {
      // 聚合必须留在后台任务里：一 awaited 就会把响应头压到聚合结束之后，
      // 浏览器在拿到 Content-Disposition 之前不会在下载记录里创建条目。
      const aggregated = this.usageRowScanExport()
        ? undefined
        : await this.loadExportAggregates(accountId, yearMonth, usageCutoff);
      // 汇总与明细出自同一次用量聚合：不再为汇总额外全扫一遍 token_usage。
      // 默认把「日×工作区×模型」聚合下推到 SQL（头文 9 月 115 万行 → 几十行）；
      // ENTERPRISE_BILL_EXPORT_ROW_SCAN=1 可切回逐行扫描做对照排查。
      await writeEnterpriseBillXlsx({
        yearMonth,
        currentMonth: bill.currentMonth,
        exportedAt,
        enterpriseName,
        prepaid: assembled.prepaid,
        bill: billView,
        events: bill.events,
        ...(aggregated
          ? { aggregated }
          : { usage: () => this.iterateUsagePages(accountId, yearMonth, usageCutoff, options.signal) }),
        ledger: { byTenant: [], byModel: [] },
        dest: stream,
      });
    })();
    writing.catch((error) => {
      if (!stream.destroyed) {
        stream.destroy(error instanceof Error ? error : new Error(String(error)));
      }
    });
    const safeName = enterpriseName.replace(/[\\/:*?"<>|]/g, '_').trim() || '企业账户';
    return {
      filename: `${yearMonth}-${safeName}-企业账单.xlsx`,
      stream,
    };
  }

  /**
   * 逾期判定走集合 SQL：闩锁两句 UPDATE、授信状态一句 SELECT。
   * 命中户名单交给 worker 再串行改授信；本方法不对 5000 户做有界并行。
   */
  async evaluateOverdue(now: Date): Promise<EnterpriseBillOverdueDecision> {
    const currentMonth = yearMonthInBeijing(now);
    await this.db().$queryRaw<Array<{ billing_account_id: string; year_month: string }>>`
      -- enterprise-bills overdue-latch-rearm
      UPDATE enterprise_bill_deadlines d
      SET pending_at_deadline = NULL,
          pending_observed_at = NULL
      FROM billing_accounts a
      JOIN billing_account_credit_configs c ON c.billing_account_id = a.id
      JOIN enterprise_bill_month_summaries s
        ON s.billing_account_id = d.billing_account_id
       AND s.year_month = d.year_month
      WHERE d.billing_account_id = a.id
        AND a.type = ${ENTERPRISE_ACCOUNT_TYPE}
        AND a.deleted_at IS NULL
        AND c.policy_revision > 0
        AND c.policy_boundary_complete = TRUE
        AND d.pending_at_deadline IS NOT NULL
        AND COALESCE(s.effective_due_at, d.default_due_at) >= ${now}
      RETURNING d.billing_account_id, d.year_month
    `;
    await this.db().$queryRaw<Array<{ billing_account_id: string; year_month: string }>>`
      -- enterprise-bills overdue-latch-observe
      UPDATE enterprise_bill_deadlines d
      SET pending_at_deadline = (s.paid_cents = 0 AND s.pending_cents > 0),
          pending_observed_at = ${now}
      FROM billing_accounts a
      JOIN billing_account_credit_configs c ON c.billing_account_id = a.id
      JOIN enterprise_bill_month_summaries s
        ON s.billing_account_id = d.billing_account_id
       AND s.year_month = d.year_month
      WHERE d.billing_account_id = a.id
        AND a.type = ${ENTERPRISE_ACCOUNT_TYPE}
        AND a.deleted_at IS NULL
        AND c.policy_revision > 0
        AND c.policy_boundary_complete = TRUE
        AND d.pending_at_deadline IS NULL
        AND d.year_month < ${currentMonth}
        AND COALESCE(s.effective_due_at, d.default_due_at) < ${now}
      RETURNING d.billing_account_id, d.year_month
    `;
    const rows = await this.db().$queryRaw<Array<{
      billing_account_id: string;
      credit_status: string;
      overdue: boolean;
    }>>`
      -- enterprise-bills overdue-credit-states
      SELECT a.id AS billing_account_id,
             c.status::text AS credit_status,
             EXISTS (
               SELECT 1
               FROM enterprise_bill_deadlines d
               JOIN enterprise_bill_month_summaries s
                 ON s.billing_account_id = d.billing_account_id
                AND s.year_month = d.year_month
               WHERE d.billing_account_id = a.id
                 AND d.year_month < ${currentMonth}
                 AND d.pending_at_deadline IS TRUE
                 AND COALESCE(s.effective_due_at, d.default_due_at) < ${now}
                 AND s.paid_cents = 0
                 AND s.pending_cents > 0
             ) AS overdue
      FROM billing_accounts a
      JOIN billing_account_credit_configs c ON c.billing_account_id = a.id
      WHERE a.type = ${ENTERPRISE_ACCOUNT_TYPE}
        AND a.deleted_at IS NULL
        AND c.policy_revision > 0
        AND c.policy_boundary_complete = TRUE
        AND c.status IN ('ACTIVE', 'SUSPENDED')
    `;
    const suspend: string[] = [];
    const restoreCandidates: string[] = [];
    for (const row of rows) {
      if (row.overdue) {
        if (row.credit_status === 'ACTIVE') {
          suspend.push(row.billing_account_id);
        }
        continue;
      }
      if (row.credit_status === 'SUSPENDED') {
        restoreCandidates.push(row.billing_account_id);
      }
    }
    if (restoreCandidates.length === 0) {
      return { suspend, restore: [] };
    }
    const latestEvents = await this.db().$queryRaw<Array<{
      billing_account_id: string;
      reason: string | null;
    }>>`
      -- enterprise-bills overdue-restore-reasons
      SELECT DISTINCT ON (e.billing_account_id)
        e.billing_account_id,
        e.reason
      FROM billing_account_credit_events e
      WHERE e.billing_account_id IN (${Prisma.join(restoreCandidates)})
      ORDER BY e.billing_account_id, e.created_at DESC, e.id DESC
    `;
    return {
      suspend,
      restore: latestEvents
        .filter((row) => row.reason === AUTO_SUSPEND_REASON)
        .map((row) => row.billing_account_id),
    };
  }

  private async requireBill(
    accountId: string,
    yearMonth: string,
    input: { now: Date; canManage: boolean },
  ): Promise<EnterpriseBillPersistView> {
    // 与 listBills 同一套现算，保证写操作回包与下一次列表一致。
    const assembled = await this.assembleAccount(accountId, input.now, {
      includeVoucher: false,
      includeUsage: true,
    });
    const bill = assembled.bills.find((row) => row.yearMonth === yearMonth);
    if (!bill) {
      throw new NotFoundException('企业账单不存在');
    }
    return this.toPersistView(bill, assembled.prepaid, input.canManage, input.now);
  }

  private ensureWalletAvailable(): void {
    if (!this.wallet) {
      throw new InternalServerErrorException('企业账单钱包入账未配置');
    }
  }

  /** 同 key 回放必须与首次指纹一致，否则 409（对齐授信 assertCreditIdempotencyMatch）。 */
  private assertBillIdempotencyMatch(
    existing: {
      id: string;
      amountCents: number | bigint;
      note: string | null;
      dueAt?: Date | string | null;
    },
    expected: { amountCents: number; note: string; dueAt?: Date },
    context: {
      accountId: string;
      yearMonth: string;
      kind: 'write-off' | 'adjust' | 'compensate' | 'extend';
    },
  ): void {
    if (billIdempotencyFingerprintMatches(existing, expected, context.kind)) {
      return;
    }
    this.logger.warn(
      `enterprise bill idempotency conflict account=${context.accountId} month=${context.yearMonth} kind=${context.kind} eventId=${existing.id}`,
    );
    throw new HttpException(
      {
        code: 'enterprise_bill_idempotency_conflict',
        message: '幂等键对应的账单参数不一致',
      },
      409,
    );
  }

  /** 补偿发券：经 wallet.issuePaygVoucher 发券资产，不改余额。 */
  private async applyVoucherIssue(input: {
    billingAccountId: string;
    amountCents: number;
    reason: string;
    productId: string;
    tenantId?: string | null;
    performedBy: string;
    idempotencyKey: string;
  }): Promise<void> {
    if (input.amountCents === 0) {
      return;
    }
    if (!this.wallet) {
      throw new InternalServerErrorException('企业账单钱包入账未配置');
    }
    await this.wallet.issuePaygVoucher({
      billingAccountId: input.billingAccountId,
      amountCents: input.amountCents,
      reason: input.reason,
      productId: input.productId,
      tenantId: input.tenantId,
      performedBy: input.performedBy,
      idempotencyKey: input.idempotencyKey,
    });
  }

  /**
   * 写路径账户级串行化：PG advisory 事务锁按 billingAccountId 互斥，
   * 消除「并发核销/调减各自读到同一 pending 快照、双双通过校验」的 TOCTOU 竞态。
   * 锁依附事务、提交即释放；临界区覆盖 校验 → create → 钱包 → settle，
   * 保证下一请求拿锁后读到的快照已包含上一请求的最终事件状态。
   * 注意：requireBill 仍走连接池（读语句发生在持锁之后，可见已提交结果）；
   * 事务含钱包往返，故放宽默认 5s 超时（见 WRITE_SERIALIZATION_TX_OPTIONS）。
   */
  private async runSerializedWrite<T>(accountId: string, fn: (db: BillsPrisma) => Promise<T>): Promise<T> {
    return this.prisma.$transaction(async (tx) => {
      // 双参版本带命名空间，避免与库内其他 advisory lock 撞键。
      // 必须用 $executeRaw：$queryRaw 会尝试反序列化 void 返回值并在 Prisma 6 上炸掉。
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext('enterprise-bills-write'), hashtext(${accountId}))`;
      return fn(tx as unknown as BillsPrisma);
    }, WRITE_SERIALIZATION_TX_OPTIONS);
  }

  /**
   * 事件状态收敛：钱包结果落定后把 PENDING 事件推进到 CONFIRMED / FAILED。
   * 更新失败时不抛出（仅告警）：事件悬置 PENDING 不参与账单数学，
   * 属安全中间态，等待对账收敛；抛出会诱导调用方重试造成双重入账。
   */
  private async settleEventStatus(
    op: string,
    accountId: string,
    yearMonth: string,
    eventId: string,
    status: Exclude<EventStatus, 'PENDING'>,
    db: BillsPrisma,
  ): Promise<void> {
    try {
      await db.enterpriseBillEvent.update({
        where: { id: eventId },
        data: { status },
      });
    } catch (error) {
      this.logger.error(
        `${op} event status settle failed -> ${status}`
          + ` account=${accountId} month=${yearMonth} eventId=${eventId}`,
        error instanceof Error ? error.message : String(error),
      );
    }
  }

  /**
   * 本地增量视图：以校验阶段加载的账单为基准，叠加本次已入账事件。
   * 与 assembleMonth 共用同一组纯函数（billStatus / pendingCents / disableReason），
   * 避免写路径二次全量组装（含冻结/观测写库）带来的失败窗口与行锁竞争。
   */
  private applyConfirmedEventToView(
    bill: EnterpriseBillPersistView,
    delta: { adjustedCents: number; paidCents: number; issuedVoucherCents?: number; dueAt?: Date },
    input: { now: Date; canManage: boolean },
  ): EnterpriseBillPersistView {
    const adjustedCents = bill.adjustedCents + delta.adjustedCents;
    const paidCents = bill.paidCents + delta.paidCents;
    const issuedVoucherCents = bill.issuedVoucherCents + (delta.issuedVoucherCents ?? 0);
    const dueAt = delta.dueAt ? delta.dueAt.toISOString() : bill.dueAt;
    const formulaInput = {
      consumeCents: bill.consumeCents,
      voucherCents: bill.voucherCents,
      accountPayCents: bill.accountPayCents,
      adjustedCents,
      paidCents,
      issuedVoucherCents,
    };
    const status = billStatus(formulaInput);
    const pendingCents = computePendingCents(formulaInput);
    const receivableCents = computeReceivableCents(formulaInput);
    const gate = {
      yearMonth: bill.yearMonth,
      now: input.now,
      prepaid: bill.prepaid,
      canManage: input.canManage,
      pendingCents,
      paidCents,
    };
    return {
      ...bill,
      adjustedCents,
      issuedVoucherCents,
      receivableCents,
      paidCents,
      status,
      pendingCents,
      dueAt,
      extended: delta.dueAt != null ? true : bill.extended,
      remainingDays: pendingCents > 0 && dueAt
        ? remainingDays(new Date(dueAt), input.now)
        : null,
      writeOffDisabledReason: disableReason('writeOff', gate),
      adjustDisabledReason: disableReason('adjust', gate),
      extendDisabledReason: disableReason('extend', gate),
      compensateDisabledReason: disableReason('compensateVoucher', gate),
    };
  }

  private async assembleAccount(
    accountId: string,
    now: Date,
    options: { includeVoucher?: boolean; includeUsage?: boolean } = {},
  ) {
    const account = await this.db().billingAccount.findUnique({
      where: { id: accountId },
      include: { creditConfig: true },
    });
    if (!account || account.type !== ENTERPRISE_ACCOUNT_TYPE || account.deletedAt) {
      throw new NotFoundException('企业账户不存在');
    }
    return this.assembleLoadedAccount(account, now, options);
  }

  private async assembleDownloadAccount(
    accountId: string,
    yearMonth: string,
    now: Date,
  ) {
    const account = await this.db().billingAccount.findUnique({
      where: { id: accountId },
      include: { creditConfig: true },
    });
    if (!account || account.type !== ENTERPRISE_ACCOUNT_TYPE || account.deletedAt) {
      throw new NotFoundException('企业账户不存在');
    }
    if (!listYearMonths(account.createdAt, now).includes(yearMonth)) {
      throw new NotFoundException('企业账单不存在');
    }
    const prepaid = isPrepaidFromConfig(account.creditConfig, now);
    const [deadline, summary, events] = await Promise.all([
      this.db().enterpriseBillDeadline.findFirst({
        where: { billingAccountId: account.id, yearMonth },
      }),
      this.db().enterpriseBillMonthSummary.findFirst({
        where: { billingAccountId: account.id, yearMonth },
      }),
      this.db().enterpriseBillEvent.findMany({
        where: { billingAccountId: account.id, yearMonth, status: 'CONFIRMED' },
      }),
    ]);
    const frozenClosed = isClosedBeijingMonth(yearMonth, now) && deadline?.amountsFrozenAt != null;
    let amounts: MonthAmounts;
    if (frozenClosed && deadline) {
      amounts = frozenAmountsOf(deadline);
    } else if (summary) {
      amounts = amountsFromSummary(summary, deadline);
    } else {
      amounts = (await this.loadLiveAmountsByMonth(account.id, [yearMonth], undefined, {
        includeUsage: false,
        includeVoucher: true,
      })).get(yearMonth) ?? emptyAmounts();
    }
    const bill = summary
      ? this.assembleClosedMonthFromSummary({
        yearMonth,
        now,
        prepaid,
        summary,
        deadline,
        events,
        termsDays: account.creditConfig?.termsDays ?? null,
        amounts,
        cashPaidCents: 0,
        fundingPaidCents: 0,
      })
      : this.assembleMonth({
        yearMonth,
        now,
        prepaid,
        amounts,
        deadline,
        events,
        termsDays: account.creditConfig?.termsDays ?? null,
        cashPaidCents: 0,
        fundingPaidCents: 0,
      });
    return { account, prepaid, bill };
  }

  private async assembleLoadedAccount(
    account: AccountRow,
    now: Date,
    options: { includeVoucher?: boolean; includeUsage?: boolean } = {},
  ) {
    const includeVoucher = options.includeVoucher ?? true;
    const includeUsage = options.includeUsage ?? false;
    const prepaid = isPrepaidFromConfig(account.creditConfig, now);
    const months = listYearMonths(account.createdAt, now);
    const [deadlines, summaries, events] = await Promise.all([
      this.db().enterpriseBillDeadline.findMany({
        where: { billingAccountId: account.id },
      }),
      // 列表金额不读汇总；仍加载供 observeDeadlines 逾期闩锁偏好（有行用汇总 pending 判定）。
      this.db().enterpriseBillMonthSummary.findMany({
        where: { billingAccountId: account.id },
        ...(includeVoucher ? {} : {
          select: {
            billingAccountId: true,
            yearMonth: true,
            paidCents: true,
            pendingCents: true,
            adjustedCents: true,
            issuedVoucherCents: true,
            consumeCents: true,
            voucherCents: true,
            accountPayCents: true,
            creditPayCents: true,
            // debtPayCents 列表现算，不读汇总
            tokenTotal: true,
            requestCount: true,
            effectiveDueAt: true,
            dueProjected: true,
          },
        }),
      }),
      this.db().enterpriseBillEvent.findMany({
        where: { billingAccountId: account.id, status: 'CONFIRMED' },
      }),
    ]);
    const deadlineByMonth = new Map<string, DeadlineRow>();
    for (const row of deadlines) deadlineByMonth.set(row.yearMonth, row);
    const summaryByMonth = new Map<string, SummaryRow>();
    for (const row of summaries) summaryByMonth.set(row.yearMonth, row);
    // 列表含已定格闭月都按 Excel 账单汇总现算，不读 deadline 定格快照。
    // 定格行仍留给 close 作业与逾期闩锁，不作为列表请求数 / Token / 消耗。
    const [liveAmounts, listPaidByMonth] = await Promise.all([
      this.loadLiveAmountsByMonth(account.id, months, undefined, {
        includeUsage,
        includeVoucher,
      }),
      this.loadListPaidByMonth(account.id, months),
    ]);
    const amountsByMonth = new Map<string, MonthAmounts>();
    for (const yearMonth of months) {
      const listPaid = listPaidByMonth.get(yearMonth);
      const amounts = liveAmounts.get(yearMonth) ?? emptyAmounts();
      amountsByMonth.set(yearMonth, withChannelAmounts(amounts, listPaid));
    }
    const eventsByMonth = new Map<string, EventRow[]>();
    for (const event of events) {
      const arr = eventsByMonth.get(event.yearMonth) ?? [];
      arr.push(event);
      eventsByMonth.set(event.yearMonth, arr);
    }
    await this.observeDeadlines(account.id, now, {
      prepaid,
      deadlines,
      eventsByMonth,
      amountsByMonth,
      listPaidByMonth,
      summaryByMonth,
    });
    const bills = months.map((yearMonth) => {
      const deadline = deadlineByMonth.get(yearMonth) ?? null;
      const monthEvents = eventsByMonth.get(yearMonth) ?? [];
      const listPaid = listPaidByMonth.get(yearMonth) ?? emptyListPaid();
      return this.assembleMonth({
        yearMonth,
        now,
        prepaid,
        amounts: amountsByMonth.get(yearMonth) ?? emptyAmounts(),
        deadline,
        events: monthEvents,
        termsDays: account.creditConfig?.termsDays ?? null,
        cashPaidCents: listPaid.cashCents,
        fundingPaidCents: listPaid.fundingCents,
      });
    });
    return { account, prepaid, bills };
  }

  private assembleClosedMonthFromSummary(input: {
    yearMonth: string;
    now: Date;
    prepaid: boolean;
    summary: SummaryRow;
    deadline: DeadlineRow | null;
    events: EventRow[];
    termsDays: number | null;
    amounts?: MonthAmounts;
    cashPaidCents?: number;
    fundingPaidCents?: number;
  }): AssembledMonth {
    return this.assembleMonth({
      yearMonth: input.yearMonth,
      now: input.now,
      prepaid: input.prepaid,
      amounts: input.amounts ?? amountsFromSummary(input.summary, input.deadline),
      deadline: input.deadline,
      events: input.events,
      termsDays: input.termsDays,
      cashPaidCents: input.cashPaidCents ?? 0,
      fundingPaidCents: input.fundingPaidCents ?? 0,
      adjustedCentsOverride: countOf(input.summary.adjustedCents),
      issuedVoucherCentsOverride: countOf(input.summary.issuedVoucherCents),
    });
  }

  private assembleMonth(input: {
    yearMonth: string;
    now: Date;
    prepaid: boolean;
    amounts: MonthAmounts;
    deadline: DeadlineRow | null;
    events: EventRow[];
    termsDays: number | null;
    cashPaidCents: number;
    fundingPaidCents: number;
    paidCentsOverride?: number;
    pendingCentsOverride?: number;
    adjustedCentsOverride?: number;
    issuedVoucherCentsOverride?: number;
    dueAtOverride?: Date | null;
  }): AssembledMonth {
    // 单次遍历同时提取 adjustedCents / writeOffPaid / issuedVoucher / extends
    let adjustedCents = 0;
    let writeOffPaidCents = 0;
    let issuedVoucherCents = 0;
    const extendEvents: EventRow[] = [];
    for (const event of input.events) {
      if (event.type === 'ADJUST') adjustedCents += countOf(event.amountCents);
      else if (event.type === 'WRITE_OFF') writeOffPaidCents += countOf(event.amountCents);
      else if (event.type === 'COMPENSATE_VOUCHER') issuedVoucherCents += countOf(event.amountCents);
      else if (event.type === 'EXTEND' && event.dueAt) extendEvents.push(event);
    }
    if (input.adjustedCentsOverride != null) adjustedCents = input.adjustedCentsOverride;
    if (input.issuedVoucherCentsOverride != null) issuedVoucherCents = input.issuedVoucherCentsOverride;
    extendEvents.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
    const latestExtend = extendEvents[extendEvents.length - 1] ?? null;
    const currentMonth = !isClosedBeijingMonth(input.yearMonth, input.now);
    const frozenDueAt = input.deadline?.defaultDueAt ?? null;
    const termsDaysForProjection = input.termsDays ?? 0;
    // 授信户当月：展示预计死线（月末+termsDays），不冻结、不参与逾期；预付款当月仍无死线。
    let dueAt: Date | null;
    let dueProjected = false;
    if (input.dueAtOverride !== undefined) {
      dueAt = input.dueAtOverride;
    } else if (currentMonth) {
      if (!input.prepaid) {
        dueAt = defaultDueAt(input.yearMonth, termsDaysForProjection);
        dueProjected = true;
      } else {
        dueAt = null;
      }
    } else {
      dueAt = latestExtend?.dueAt ?? frozenDueAt;
    }
    const paidCents = input.paidCentsOverride ?? computeListPaidCents({
      prepaid: input.prepaid,
      fundingPaidCents: input.fundingPaidCents,
      writeOffPaidCents,
    });
    const formulaInput = {
      consumeCents: input.amounts.consumeCents,
      voucherCents: input.amounts.voucherCents,
      accountPayCents: input.amounts.accountPayCents,
      adjustedCents,
      paidCents,
      issuedVoucherCents,
    };
    const status = billStatus(formulaInput);
    const pending = input.pendingCentsOverride ?? computePendingCents(formulaInput);
    const receivable = computeReceivableCents(formulaInput);
    return {
      yearMonth: input.yearMonth,
      currentMonth,
      prepaid: input.prepaid,
      requestCount: input.amounts.requestCount,
      tokenTotal: input.amounts.tokenTotal,
      consumeCents: input.amounts.consumeCents,
      voucherCents: input.amounts.voucherCents,
      chargeCents: input.amounts.chargeCents,
      accountPayCents: input.amounts.accountPayCents,
      creditPayCents: input.amounts.creditPayCents,
      debtPayCents: input.amounts.debtPayCents,
      adjustedCents,
      issuedVoucherCents,
      receivableCents: receivable,
      paidCents,
      pendingCents: pending,
      status,
      termsDays: input.deadline?.termsDays ?? (currentMonth ? input.termsDays : null),
      dueAt: dueAt ? dueAt.toISOString() : null,
      dueProjected,
      originalDueAt: frozenDueAt ? frozenDueAt.toISOString() : null,
      extended: Boolean(latestExtend),
      remainingDays: pending > 0 && dueAt ? remainingDays(dueAt, input.now) : null,
      pendingAtDeadline: input.deadline?.pendingAtDeadline ?? null,
      events: input.events.map((event) => ({ ...event, amountCents: countOf(event.amountCents) })),
    };
  }

  private toView(
    bill: AssembledMonth,
    prepaid: boolean,
    canManage: boolean,
    now: Date,
  ): EnterpriseBillView {
    const persist = this.toPersistView(bill, prepaid, canManage, now);
    return this.toPublicBill(persist);
  }

  private toPersistView(
    bill: AssembledMonth,
    prepaid: boolean,
    canManage: boolean,
    now: Date,
  ): EnterpriseBillPersistView {
    const gate = {
      yearMonth: bill.yearMonth,
      now,
      prepaid,
      canManage,
      pendingCents: bill.pendingCents,
      paidCents: bill.paidCents,
    };
    return {
      yearMonth: bill.yearMonth,
      currentMonth: bill.currentMonth,
      requestCount: bill.requestCount,
      tokenTotal: bill.tokenTotal,
      consumeCents: bill.consumeCents,
      accountPayCents: bill.accountPayCents,
      voucherDeductCents: bill.voucherCents,
      creditPayCents: bill.creditPayCents,
      debtPayCents: bill.debtPayCents,
      voucherCents: bill.voucherCents,
      chargeCents: bill.chargeCents,
      adjustedCents: bill.adjustedCents,
      issuedVoucherCents: bill.issuedVoucherCents,
      receivableCents: bill.receivableCents,
      paidCents: bill.paidCents,
      pendingCents: bill.pendingCents,
      status: bill.status,
      termsDays: bill.termsDays,
      dueAt: bill.dueAt,
      dueProjected: bill.dueProjected,
      originalDueAt: bill.originalDueAt,
      extended: bill.extended,
      remainingDays: bill.remainingDays,
      prepaid,
      writeOffDisabledReason: disableReason('writeOff', gate),
      adjustDisabledReason: disableReason('adjust', gate),
      extendDisabledReason: disableReason('extend', gate),
      compensateDisabledReason: disableReason('compensateVoucher', gate),
    };
  }

  private toPublicBill(view: EnterpriseBillPersistView): EnterpriseBillView {
    const { voucherCents: _voucherCents, chargeCents: _chargeCents, ...publicView } = view;
    return publicView;
  }

  private toSummary(
    assembled: { account: AccountRow; prepaid: boolean; bills: AssembledMonth[] },
    _now: Date,
  ): EnterpriseBillAccountSummary {
    const unpaid = assembled.bills.filter((bill) => bill.pendingCents > 0 && bill.dueAt);
    unpaid.sort((a, b) => (a.dueAt as string).localeCompare(b.dueAt as string));
    const earliestBill = unpaid[0] ?? null;
    const dueWarning = unpaid.some((bill) => (bill.remainingDays ?? Number.POSITIVE_INFINITY) < 10);
    const current = assembled.bills.find((bill) => bill.currentMonth);
    // 已用信用 = 当期未出账扣费 + Σ 各月待付款；
    // 当月 pending 已含扣费时不再把 charge 重复加一遍：用 Σ全部待付款 + 当月(扣费−待付款)的非负差额。
    const allPending = assembled.bills.reduce((sum, bill) => sum + bill.pendingCents, 0);
    const currentOpenCharge = Math.max(0, (current?.chargeCents ?? 0) - (current?.pendingCents ?? 0));
    return {
      billingAccountId: assembled.account.id,
      earliestDueAt: earliestBill?.dueAt ?? null,
      earliestDueProjected: Boolean(earliestBill?.dueProjected),
      dueWarning,
      usedCents: allPending + currentOpenCharge,
      prepaid: assembled.prepaid,
    };
  }

  private async freezeClosedMonths(
    account: AccountRow,
    months: string[],
    now: Date,
    liveAmounts: Map<string, MonthAmounts>,
    preloadedDeadlines: DeadlineRow[],
  ): Promise<void> {
    const termsDays = account.creditConfig?.termsDays ?? 0;
    // Map 查找替代循环内线性扫描
    const deadlineByMonth = new Map<string, DeadlineRow>();
    for (const d of preloadedDeadlines) deadlineByMonth.set(d.yearMonth, d);
    const ops: Promise<unknown>[] = [];
    // 收集需要回填金额的行，批量并行查询后统一更新
    const backfillNeeded: Array<{ yearMonth: string; frozenAt: Date }> = [];
    for (const yearMonth of months) {
      if (!isClosedBeijingMonth(yearMonth, now)) continue;
      const existing = deadlineByMonth.get(yearMonth) ?? null;
      if (!existing) {
        const amounts = liveAmounts.get(yearMonth) ?? emptyAmounts();
        ops.push(this.db().enterpriseBillDeadline.upsert({
          where: {
            billingAccountId_yearMonth: { billingAccountId: account.id, yearMonth },
          },
          create: {
            billingAccountId: account.id, yearMonth, termsDays,
            defaultDueAt: defaultDueAt(yearMonth, termsDays),
            frozenAt: now,
            frozenConsumeCents: amounts.consumeCents,
            frozenVoucherCents: amounts.voucherCents,
            frozenChargeCents: amounts.chargeCents,
            frozenTokenTotal: amounts.tokenTotal,
            frozenRequestCount: amounts.requestCount,
            amountsFrozenAt: now,
            pendingAtDeadline: null, pendingObservedAt: null,
          },
          update: {},
        }));
        continue;
      }
      if (existing.amountsFrozenAt == null) {
        backfillNeeded.push({ yearMonth, frozenAt: existing.frozenAt });
      }
    }
    // 批量并行回填：消除循环内串行 await
    if (backfillNeeded.length > 0) {
      const backfilled = await Promise.all(
        backfillNeeded.map(async ({ yearMonth, frozenAt }) => {
          const asOf = await this.loadLiveAmountsByMonth(account.id, [yearMonth], frozenAt);
          return { yearMonth, amounts: asOf.get(yearMonth) ?? emptyAmounts() };
        }),
      );
      for (const { yearMonth, amounts } of backfilled) {
        ops.push(this.db().enterpriseBillDeadline.update({
          where: {
            billingAccountId_yearMonth: { billingAccountId: account.id, yearMonth },
          },
          data: {
            frozenConsumeCents: amounts.consumeCents,
            frozenVoucherCents: amounts.voucherCents,
            frozenChargeCents: amounts.chargeCents,
            frozenTokenTotal: amounts.tokenTotal,
            frozenRequestCount: amounts.requestCount,
            amountsFrozenAt: deadlineByMonth.get(yearMonth)!.frozenAt,
          },
        }));
      }
    }
    if (ops.length > 0) {
      await Promise.all(ops);
    }
  }

  private resolveAmountsWithFreezeAndSpill(
    accountId: string,
    months: string[],
    now: Date,
    liveAmounts: Map<string, MonthAmounts>,
    deadlines: DeadlineRow[],
  ): Map<string, MonthAmounts> {
    const result = new Map<string, MonthAmounts>();
    const spill = emptyAmounts();
    const currentMonth = yearMonthInBeijing(now);
    // Map 查找替代循环内线性扫描
    const deadlineByMonth = new Map<string, DeadlineRow>();
    for (const d of deadlines) deadlineByMonth.set(d.yearMonth, d);
    for (const yearMonth of months) {
      const live = liveAmounts.get(yearMonth) ?? emptyAmounts();
      const deadline = deadlineByMonth.get(yearMonth) ?? null;
      const frozen = deadline?.amountsFrozenAt != null;
      if (frozen && isClosedBeijingMonth(yearMonth, now)) {
        const frozenAmounts: MonthAmounts = {
          consumeCents: countOf(deadline!.frozenConsumeCents),
          voucherCents: countOf(deadline!.frozenVoucherCents),
          chargeCents: deadline!.frozenChargeCents != null
            ? countOf(deadline!.frozenChargeCents)
            : computeChargeCents({
              consumeCents: countOf(deadline!.frozenConsumeCents),
              voucherCents: countOf(deadline!.frozenVoucherCents),
            }),
          accountPayCents: 0,
          creditPayCents: 0,
          debtPayCents: 0,
          tokenTotal: countOf(deadline!.frozenTokenTotal),
          requestCount: countOf(deadline!.frozenRequestCount),
        };
        // 迟到用量 = 现算 − 定格，spill 进当前未定格月
        const consumeDiff = live.consumeCents - frozenAmounts.consumeCents;
        const voucherDiff = live.voucherCents - frozenAmounts.voucherCents;
        const tokenDiff = live.tokenTotal - frozenAmounts.tokenTotal;
        const requestDiff = live.requestCount - frozenAmounts.requestCount;
        // 负差额意味着退款/冲正导致现算 < 定格，记录告警但不阻塞
        if (consumeDiff < 0 || voucherDiff < 0 || tokenDiff < 0 || requestDiff < 0) {
          this.logger.warn(
            `negative spill account=${accountId} month=${yearMonth}`
            + ` consume=${consumeDiff} voucher=${voucherDiff} token=${tokenDiff} request=${requestDiff}`,
          );
        }
        spill.consumeCents += Math.max(0, consumeDiff);
        spill.voucherCents += Math.max(0, voucherDiff);
        spill.tokenTotal += Math.max(0, tokenDiff);
        spill.requestCount += Math.max(0, requestDiff);
        result.set(yearMonth, frozenAmounts);
      } else {
        result.set(yearMonth, live);
      }
    }
    // chargeCents 在循环外统一计算，避免每轮迭代重复调用
    spill.chargeCents = computeChargeCents(spill);
    if (spill.consumeCents > 0 || spill.voucherCents > 0 || spill.tokenTotal > 0 || spill.requestCount > 0) {
      const current = result.get(currentMonth) ?? emptyAmounts();
      result.set(currentMonth, {
        consumeCents: current.consumeCents + spill.consumeCents,
        voucherCents: current.voucherCents + spill.voucherCents,
        chargeCents: computeChargeCents({
          consumeCents: current.consumeCents + spill.consumeCents,
          voucherCents: current.voucherCents + spill.voucherCents,
        }),
        accountPayCents: current.accountPayCents,
        creditPayCents: current.creditPayCents,
        debtPayCents: current.debtPayCents,
        tokenTotal: current.tokenTotal + spill.tokenTotal,
        requestCount: current.requestCount + spill.requestCount,
      });
    }
    return result;
  }

  private async observeDeadlines(
    accountId: string,
    now: Date,
    preloaded: {
      prepaid: boolean;
      deadlines: DeadlineRow[];
      eventsByMonth: Map<string, EventRow[]>;
      amountsByMonth: Map<string, MonthAmounts>;
      listPaidByMonth: Map<string, ListPaidCents>;
      summaryByMonth?: Map<string, SummaryRow>;
    },
  ): Promise<void> {
    const { prepaid, deadlines, eventsByMonth, amountsByMonth, listPaidByMonth, summaryByMonth } = preloaded;
    for (const deadline of deadlines) {
      const monthEvents = eventsByMonth.get(deadline.yearMonth) ?? [];
      // 单次遍历同时提取 adjustedCents / writeOffPaid / issued / extends
      let adjustedCents = 0;
      let writeOffPaidCents = 0;
      let issuedVoucherCents = 0;
      const extendEvents: EventRow[] = [];
      for (const event of monthEvents) {
        if (event.type === 'ADJUST') adjustedCents += countOf(event.amountCents);
        else if (event.type === 'WRITE_OFF') writeOffPaidCents += countOf(event.amountCents);
        else if (event.type === 'COMPENSATE_VOUCHER') issuedVoucherCents += countOf(event.amountCents);
        else if (event.type === 'EXTEND' && event.dueAt) extendEvents.push(event);
      }
      extendEvents.sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime());
      const latestExtend = extendEvents[extendEvents.length - 1] ?? null;
      const effectiveDueAt = latestExtend?.dueAt ?? deadline.defaultDueAt;
      if (effectiveDueAt.getTime() >= now.getTime()) {
        if (latestExtend && deadline.pendingAtDeadline != null) {
          // 原子条件更新：仅当 pendingAtDeadline 非空时才重置，防并发覆盖
          const res = await this.db().enterpriseBillDeadline.updateMany({
            where: {
              billingAccountId: accountId,
              yearMonth: deadline.yearMonth,
              pendingAtDeadline: { not: null },
            },
            data: { pendingAtDeadline: null, pendingObservedAt: null },
          });
          if (res.count > 0) {
            deadline.pendingAtDeadline = null;
            deadline.pendingObservedAt = null;
          }
        }
        continue;
      }
      if (deadline.pendingAtDeadline != null) {
        continue;
      }
      const summary = summaryByMonth?.get(deadline.yearMonth);
      const pendingAtDeadline = summary
        ? billStatus({
          consumeCents: countOf(summary.consumeCents),
          voucherCents: countOf(summary.voucherCents),
          adjustedCents: countOf(summary.adjustedCents),
          paidCents: countOf(summary.paidCents),
          issuedVoucherCents: countOf(summary.issuedVoucherCents),
        }) === '待核销'
        : billStatus({
          consumeCents: (amountsByMonth.get(deadline.yearMonth) ?? emptyAmounts()).consumeCents,
          voucherCents: (amountsByMonth.get(deadline.yearMonth) ?? emptyAmounts()).voucherCents,
          adjustedCents,
          paidCents: computeListPaidCents({
            prepaid,
            fundingPaidCents: (listPaidByMonth.get(deadline.yearMonth) ?? emptyListPaid()).fundingCents,
            writeOffPaidCents,
          }),
          issuedVoucherCents,
        }) === '待核销';
      // 原子条件更新：仅当 pendingAtDeadline 为空时才写入，防并发覆盖
      const res = await this.db().enterpriseBillDeadline.updateMany({
        where: {
          billingAccountId: accountId,
          yearMonth: deadline.yearMonth,
          pendingAtDeadline: null,
        },
        data: { pendingAtDeadline, pendingObservedAt: now },
      });
      if (res.count > 0) {
        deadline.pendingAtDeadline = pendingAtDeadline;
        deadline.pendingObservedAt = now;
      }
    }
  }

  private async loadListPaidByMonth(
    accountId: string,
    months: string[],
  ): Promise<Map<string, ListPaidCents>> {
    const byMonth = new Map<string, ListPaidCents>();
    for (const month of months) {
      byMonth.set(month, emptyListPaid());
    }
    if (months.length === 0) {
      return byMonth;
    }
    const start = beijingMonthRange(months[months.length - 1]!).start;
    const endExclusive = beijingMonthRange(months[0]!).endExclusive;
    const [channelRows, fundingRows] = await Promise.all([
      this.db().$queryRaw<Array<{
        yearMonth: string;
        accountPayCents: number | bigint;
        voucherDeductCents: number | bigint;
        creditPayCents: number | bigint;
        debtPayCents: number | bigint;
      }>>`
        -- enterprise-bills finance API用量扣费 channels (mapFinanceApiUsageRows)
        -- created_at 为 UTC 墙钟 timestamp；归月/范围与 Prisma findMany、billing.repository 双转换一致
        WITH usages AS (
          SELECT
            tu.id,
            to_char((tu.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai'), 'YYYY-MM') AS "yearMonth",
            tu.customer_charge_usd,
            tu.cost_usd,
            tu.customer_charge_policy,
            tu.customer_collected_usd,
            tu.customer_approved_receivable_usd,
            tu.customer_unapproved_debt_usd,
            tu.customer_funding_classification_complete
          FROM token_usage tu
          JOIN tenants t ON t.id = tu.tenant_id
          WHERE t.billing_account_id = ${accountId}
            AND tu.created_at >= (${start} AT TIME ZONE 'UTC')
            AND tu.created_at < (${endExclusive} AT TIME ZONE 'UTC')
            AND (
              COALESCE(tu.prompt_tokens, 0) > 0
              OR COALESCE(tu.cached_input_tokens, 0) > 0
              OR COALESCE(tu.cache_write_input_tokens, 0) > 0
              OR COALESCE(tu.completion_tokens, 0) > 0
              OR COALESCE(tu.total_tokens, 0) > 0
              OR tu.customer_charge_usd > 0
              OR COALESCE(tu.provider_cost_estimate_usd, 0) > 0
              OR EXISTS (
                SELECT 1 FROM balance_consumption_allocations vis
                WHERE vis.token_usage_id = tu.id AND vis.amount_usd > 0
              )
              OR (
                tu.customer_charge_policy IN ('usage_charge', 'legacy_cost_usd')
                AND tu.cost_usd <> 0
              )
            )
        ),
        allocs AS (
          SELECT
            bca.token_usage_id,
            COALESCE(SUM(bca.amount_usd), 0) AS allocated_charge,
            COALESCE(SUM(CASE
              WHEN NOT (
                (bca.source = ${ALLOCATION_SOURCE_ENTERPRISE_CREDIT} AND bca.balance_grant_id IS NULL)
                OR (bca.source = ${ALLOCATION_SOURCE_NEGATIVE_BALANCE} AND bca.balance_grant_id IS NULL)
              ) THEN bca.recognized_revenue_usd ELSE 0
            END), 0) AS collected_revenue,
            COALESCE(SUM(CASE
              WHEN NOT (
                (bca.source = ${ALLOCATION_SOURCE_ENTERPRISE_CREDIT} AND bca.balance_grant_id IS NULL)
                OR (bca.source = ${ALLOCATION_SOURCE_NEGATIVE_BALANCE} AND bca.balance_grant_id IS NULL)
              ) THEN bca.bonus_consumed_usd ELSE 0
            END), 0) AS collected_bonus,
            COALESCE(SUM(CASE
              WHEN bca.source = ${ALLOCATION_SOURCE_ENTERPRISE_CREDIT} AND bca.balance_grant_id IS NULL
                AND bca.funding_classification_complete
                THEN bca.approved_credit_usd
              ELSE 0
            END), 0) AS credit_amount,
            COALESCE(SUM(CASE
              WHEN bca.source IN (${ALLOCATION_SOURCE_ENTERPRISE_CREDIT}, ${ALLOCATION_SOURCE_NEGATIVE_BALANCE})
                AND bca.balance_grant_id IS NULL THEN
                CASE
                  WHEN bca.funding_classification_complete THEN bca.unapproved_debt_usd
                  ELSE bca.amount_usd
                END
              ELSE 0
            END), 0) AS debt_amount,
            BOOL_OR(
              (bca.source IN (${ALLOCATION_SOURCE_ENTERPRISE_CREDIT}, ${ALLOCATION_SOURCE_NEGATIVE_BALANCE})
                AND bca.balance_grant_id IS NULL)
              AND COALESCE(bca.funding_classification_complete, false) IS NOT TRUE
            ) AS has_unclassified_debt
          FROM balance_consumption_allocations bca
          JOIN usages u ON u.id = bca.token_usage_id
          GROUP BY bca.token_usage_id
        ),
        per_usage AS (
          SELECT
            u."yearMonth",
            CASE
              WHEN COALESCE(a.allocated_charge, 0) > 0 THEN COALESCE(a.allocated_charge, 0)
              WHEN u.customer_charge_usd > 0 THEN u.customer_charge_usd
              WHEN u.customer_charge_policy IS NULL
                OR u.customer_charge_policy IN ('usage_charge', 'legacy_cost_usd')
                THEN ABS(u.cost_usd)
              ELSE 0
            END AS customer_charge,
            COALESCE(a.allocated_charge, 0) AS allocated_charge,
            COALESCE(a.collected_revenue, 0) AS collected_revenue,
            COALESCE(a.collected_bonus, 0) AS collected_bonus,
            COALESCE(a.credit_amount, 0) AS credit_amount,
            COALESCE(a.debt_amount, 0) AS debt_amount,
            COALESCE(a.has_unclassified_debt, false) AS has_unclassified_debt,
            u.customer_collected_usd,
            u.customer_approved_receivable_usd,
            u.customer_unapproved_debt_usd,
            u.customer_funding_classification_complete
          FROM usages u
          LEFT JOIN allocs a ON a.token_usage_id = u.id
        )
        SELECT
          "yearMonth",
          -- 与消耗列一致：先 SUM(USD) 再 ROUND 到分，避免小额调用逐行取整把本金吃成 0
          COALESCE(ROUND(SUM(ABS(
            CASE
              WHEN allocated_charge > 0 THEN collected_revenue
              WHEN customer_funding_classification_complete
                AND (COALESCE(customer_collected_usd, 0)
                  + COALESCE(customer_approved_receivable_usd, 0)
                  + COALESCE(customer_unapproved_debt_usd, 0)) = customer_charge
                AND (allocated_charge <= 0 OR has_unclassified_debt)
                THEN customer_collected_usd
              ELSE customer_charge
            END
          )) * 100), 0)::bigint AS "accountPayCents",
          COALESCE(ROUND(SUM(ABS(
            CASE WHEN allocated_charge > 0 THEN collected_bonus ELSE 0 END
          )) * 100), 0)::bigint AS "voucherDeductCents",
          COALESCE(ROUND(SUM(ABS(
            CASE
              WHEN customer_funding_classification_complete
                AND (COALESCE(customer_collected_usd, 0)
                  + COALESCE(customer_approved_receivable_usd, 0)
                  + COALESCE(customer_unapproved_debt_usd, 0)) = customer_charge
                AND (allocated_charge <= 0 OR has_unclassified_debt)
                THEN customer_approved_receivable_usd
              ELSE credit_amount
            END
          )) * 100), 0)::bigint AS "creditPayCents",
          COALESCE(ROUND(SUM(ABS(
            CASE
              WHEN customer_funding_classification_complete
                AND (COALESCE(customer_collected_usd, 0)
                  + COALESCE(customer_approved_receivable_usd, 0)
                  + COALESCE(customer_unapproved_debt_usd, 0)) = customer_charge
                AND (allocated_charge <= 0 OR has_unclassified_debt)
                THEN customer_unapproved_debt_usd
              ELSE debt_amount
            END
          )) * 100), 0)::bigint AS "debtPayCents"
        FROM per_usage
        GROUP BY 1
      `,
      this.db().$queryRaw<Array<{ yearMonth: string; cents: number | bigint }>>`
        -- enterprise-bills list-paid-funding
        -- 与三渠道 / 消耗同口径：先 SUM(USD) 再 ROUND(*100)，禁止按条进分再加总（头文 9 月会少 0.27）
        SELECT to_char((a.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai'), 'YYYY-MM') AS "yearMonth",
               COALESCE(ROUND(SUM(ABS(s.amount_usd)) * 100), 0)::bigint AS cents
        FROM enterprise_credit_settlements s
        JOIN balance_consumption_allocations a ON a.id = s.allocation_id
        WHERE s.billing_account_id = ${accountId}
          AND s.trigger = ${SETTLEMENT_TRIGGER_FUNDING}
          AND a.created_at >= (${start} AT TIME ZONE 'UTC')
          AND a.created_at < (${endExclusive} AT TIME ZONE 'UTC')
        GROUP BY 1
      `,
    ]);
    for (const row of channelRows) {
      const bucket = byMonth.get(row.yearMonth);
      if (!bucket) continue;
      bucket.cashCents = Number(row.accountPayCents);
      bucket.voucherCents = Number(row.voucherDeductCents);
      bucket.creditCents = Number(row.creditPayCents);
      bucket.debtCents = Number(row.debtPayCents);
    }
    for (const row of fundingRows) {
      const bucket = byMonth.get(row.yearMonth);
      if (bucket) bucket.fundingCents = Number(row.cents);
    }
    return byMonth;
  }

  /**
   * 列表现算 / refresh / 定格回填：消耗·token·请求数对齐 Excel「账单汇总」口径
   * （export-summary：折后=消耗，用量=discounted>0 的分量 token，请求数=可见行行数）。
   * 可见行与财务对账「API用量扣费」同源：tokens 全 0、charge 为 0 且无分摊的归零调用不计入请求数。
   * created_at 为 UTC 墙钟 timestamp；边界用 AT TIME ZONE 'UTC'（见 beijingMonthRange 注释）。
   * 三渠道仍由 loadListPaidByMonth + withChannelAmounts 覆盖。
   */
  private async loadLiveAmountsByMonth(
    accountId: string,
    months: string[],
    asOfExclusive?: Date,
    options: { includeUsage?: boolean; includeVoucher?: boolean } = {},
  ): Promise<Map<string, MonthAmounts>> {
    const byMonth = new Map<string, MonthAmounts>();
    for (const month of months) {
      byMonth.set(month, emptyAmounts());
    }
    if (months.length === 0) {
      return byMonth;
    }
    const start = beijingMonthRange(months[months.length - 1]!).start;
    const monthEnd = beijingMonthRange(months[0]!).endExclusive;
    const endExclusive = asOfExclusive && asOfExclusive.getTime() < monthEnd.getTime()
      ? asOfExclusive
      : monthEnd;
    const includeUsage = options.includeUsage ?? true;
    const includeVoucher = options.includeVoucher ?? true;
    const rows = await this.db().$queryRaw<Array<{
      yearMonth: string;
      consumeCents: number | bigint;
      voucherCents: number | bigint;
      tokenTotal: number | bigint;
      requestCount: number | bigint;
    }>>`
      -- enterprise-bills live-export-usage (Excel 账单汇总口径; 与明细折叠同源，见 foldUsageForExport)
      WITH scoped AS (
        SELECT
          tu.id,
          to_char((tu.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai'), 'YYYY-MM') AS "yearMonth",
          tu.total_tokens,
          tu.prompt_tokens,
          tu.cached_input_tokens,
          tu.cache_write_input_tokens,
          tu.completion_tokens,
          tu.customer_charge_usd,
          tu.cost_usd,
          tu.customer_charge_policy
        FROM token_usage tu
        JOIN tenants t ON t.id = tu.tenant_id
        WHERE t.billing_account_id = ${accountId}
          AND tu.created_at >= (${start} AT TIME ZONE 'UTC')
          AND tu.created_at < (${endExclusive} AT TIME ZONE 'UTC')
          -- 请求数只计可见行，与财务对账「API用量扣费」同一口径：
          -- tokens 全 0、charge 为 0、无分摊的归零调用不计入，否则两处请求数会差出这批行。
          -- 该口径定义在财务对账的可见行谓词里，两处必须保持一致，改动时同步。
          AND (
            COALESCE(tu.prompt_tokens, 0) > 0
            OR COALESCE(tu.cached_input_tokens, 0) > 0
            OR COALESCE(tu.cache_write_input_tokens, 0) > 0
            OR COALESCE(tu.completion_tokens, 0) > 0
            OR COALESCE(tu.total_tokens, 0) > 0
            OR tu.customer_charge_usd > 0
            OR COALESCE(tu.provider_cost_estimate_usd, 0) > 0
            OR EXISTS (
              SELECT 1 FROM balance_consumption_allocations vis
              WHERE vis.token_usage_id = tu.id AND vis.amount_usd > 0
            )
            OR (
              tu.customer_charge_policy IN ('usage_charge', 'legacy_cost_usd')
              AND tu.cost_usd <> 0
            )
          )
      ),
      allocs AS (
        SELECT
          bca.token_usage_id,
          COALESCE(SUM(bca.amount_usd), 0) AS allocated_charge,
          COALESCE(SUM(bca.bonus_consumed_usd), 0) AS bonus
        FROM balance_consumption_allocations bca
        JOIN scoped s ON s.id = bca.token_usage_id
        GROUP BY bca.token_usage_id
      ),
      priced AS (
        SELECT
          s."yearMonth",
          GREATEST(COALESCE(s.prompt_tokens, 0), 0) AS prompt,
          GREATEST(COALESCE(s.cached_input_tokens, 0), 0) AS cache_read,
          GREATEST(COALESCE(s.cache_write_input_tokens, 0), 0) AS cache_write,
          GREATEST(COALESCE(s.completion_tokens, 0), 0) AS output,
          GREATEST(COALESCE(s.total_tokens, 0), 0) AS total_tokens,
          CASE
            WHEN COALESCE(a.allocated_charge, 0) > 0 THEN a.allocated_charge
            WHEN COALESCE(s.customer_charge_usd, 0) > 0 THEN s.customer_charge_usd
            WHEN s.customer_charge_policy IS NULL
              OR s.customer_charge_policy = 'usage_charge'
              OR s.customer_charge_policy = 'legacy_cost_usd'
              THEN ABS(COALESCE(s.cost_usd, 0))
            ELSE 0
          END AS discounted,
          COALESCE(a.bonus, 0) AS voucher
        FROM scoped s
        LEFT JOIN allocs a ON a.token_usage_id = s.id
      ),
      parts AS (
        SELECT
          "yearMonth",
          discounted,
          voucher,
          total_tokens,
          cache_read,
          cache_write,
          output,
          GREATEST(
            prompt
            - LEAST(cache_read, prompt)
            - LEAST(cache_write, GREATEST(prompt - LEAST(cache_read, prompt), 0)),
            0
          ) AS input_tokens
        FROM priced
      ),
      lined AS (
        SELECT
          "yearMonth",
          discounted,
          voucher,
          CASE
            WHEN input_tokens + cache_read + cache_write + output > 0
              THEN input_tokens + cache_read + cache_write + output
            ELSE total_tokens
          END AS part_tokens
        FROM parts
      )
      SELECT
        "yearMonth",
        -- 与 Excel 账单汇总一致：先 SUM(USD) 再 ROUND 到分，避免逐行取整累计偏差
        COALESCE(ROUND(SUM(ABS(discounted)) * 100), 0)::bigint AS "consumeCents",
        COALESCE(ROUND(SUM(ABS(voucher)) * 100), 0)::bigint AS "voucherCents",
        COALESCE(SUM(CASE WHEN discounted > 0 THEN part_tokens ELSE 0 END), 0)::bigint AS "tokenTotal",
        COUNT(*)::bigint AS "requestCount"
      FROM lined
      GROUP BY 1
    `;
    for (const row of rows) {
      const bucket = byMonth.get(row.yearMonth);
      if (!bucket) continue;
      bucket.consumeCents = Number(row.consumeCents);
      if (includeVoucher) {
        bucket.voucherCents = Number(row.voucherCents);
      }
      if (includeUsage) {
        bucket.tokenTotal = Number(row.tokenTotal);
        bucket.requestCount = Number(row.requestCount);
      }
    }

    for (const [yearMonth, bucket] of byMonth) {
      bucket.chargeCents = includeVoucher
        ? computeChargeCents({
          consumeCents: bucket.consumeCents,
          voucherCents: bucket.voucherCents,
        })
        : bucket.consumeCents;
      byMonth.set(yearMonth, bucket);
    }
    return byMonth;
  }

  /** 逐行扫描导出通道是否启用（默认关：走 SQL 聚合下推）。 */
  private usageRowScanExport(): boolean {
    return process.env.ENTERPRISE_BILL_EXPORT_ROW_SCAN === '1';
  }

  /**
   * 导出用用量聚合：把「自然日 × 工作区 × 模型」下推到 PostgreSQL，
   * 只回传几十~几百行，替代百万行 token_usage 的逐行拉取 + 反序列化。
   * 金额求和与分量 token 全在库里做，目录单价/目录价格的除法仍留给 Node（见 xlsx 侧注释）。
   *
   * 不走 `SET LOCAL work_mem` / 关 nestloop 这类会话调参：
   * UAT 实测反而更慢（73.7s vs 24.1s）——抬高 work_mem 会让百万级 per-row 分组
   * 从 GroupAggregate 换成 HashAggregate，临时文件从 783MB 涨到更多且耗时翻三倍。
   */
  private async loadExportAggregates(
    accountId: string,
    yearMonth: string,
    endExclusive: Date,
  ): Promise<{ lines: DetailLine[]; summary: EnterpriseBillXlsxSummary }> {
    const start = beijingMonthRange(yearMonth).start;
    const rows = await this.db().$queryRaw<EnterpriseUsageAggregateRow[]>(
      buildEnterpriseUsageAggregateQuery({ accountId, start, endExclusive }),
    );
    return buildExportBucketsFromAggregateGroups(rows);
  }

  private async *iterateUsagePages(
    accountId: string,
    yearMonth: string,
    endExclusive: Date,
    signal?: AbortSignal,
  ): AsyncGenerator<UsageRow[]> {
    const tenants = await this.db().tenant.findMany({
      where: { billingAccountId: accountId },
      select: { id: true },
    });
    if (tenants.length === 0) {
      return;
    }
    const start = beijingMonthRange(yearMonth).start;
    const dayWindows = beijingDayWindows(start, endExclusive);
    // 日在外、工作区在内：明细「自然日」严格递增，写出行可按日聚合后立即落盘，
    // 内存只保留当前一天，不随整月明细行数增长（大客户单月百万行会撑爆 2Gi）。
    for (const window of dayWindows) {
      for (const tenant of tenants) {
        let cursorId: string | undefined;
        for (;;) {
          if (signal?.aborted) {
            throw new Error('enterprise bill download aborted');
          }
          const page = await this.loadUsageDetailsPage(
            tenant.id,
            window.start,
            window.endExclusive,
            cursorId,
          );
          if (page.length === 0) {
            break;
          }
          yield page;
          if (page.length < USAGE_EXPORT_PAGE_SIZE) {
            break;
          }
          const lastId = page[page.length - 1]?.id;
          if (!lastId) {
            break;
          }
          cursorId = lastId;
        }
      }
    }
  }

  private async loadUsageDetailsPage(
    tenantId: string,
    start: Date,
    endExclusive: Date,
    cursorId?: string,
  ): Promise<Array<UsageRow & { id: string }>> {
    return this.db().tokenUsage.findMany({
      where: {
        tenantId,
        createdAt: { gte: start, lt: endExclusive },
      },
      take: USAGE_EXPORT_PAGE_SIZE,
      ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        createdAt: true,
        tenantId: true,
        model: true,
        callType: true,
        totalTokens: true,
        promptTokens: true,
        cachedInputTokens: true,
        cacheWriteInputTokens: true,
        completionTokens: true,
        unitPriceUsd: true,
        inputPriceUsdPerM: true,
        cachedInputPriceUsdPerM: true,
        cacheWritePriceUsdPerM: true,
        outputPriceUsdPerM: true,
        customerChargeUsd: true,
        costUsd: true,
        customerChargePolicy: true,
        customerCollectedUsd: true,
        customerApprovedReceivableUsd: true,
        customerUnapprovedDebtUsd: true,
        customerFundingClassificationComplete: true,
        gatewayBillingEvent: {
          select: {
            settlementAnchor: {
              select: { customerPricingSnapshot: true },
            },
          },
        },
        consumptionAllocations: {
          select: {
            balanceGrantId: true,
            source: true,
            amountUsd: true,
            recognizedRevenueUsd: true,
            bonusConsumedUsd: true,
            approvedCreditUsd: true,
            unapprovedDebtUsd: true,
            fundingClassificationComplete: true,
          },
        },
      },
    }) as Promise<Array<UsageRow & { id: string }>>;
  }

  /**
   * 导出用账务拆分：与用量明细同一 [月初, cutoff) 窗口。
   * - 账号消耗：CONSUME 按 tenant_id
   * - 账号券：allocation.bonus 按 tenant_id
   * - 模型：allocation 经 token_usage.model；无挂靠进「未归属」
   */
  private async loadLedgerBreakdown(
    accountId: string,
    yearMonth: string,
    endExclusive: Date,
  ): Promise<LedgerBreakdown> {
    const start = beijingMonthRange(yearMonth).start;
    const unattributed = UNATTRIBUTED_LEDGER_KEY;
    const [consumeRows, voucherRows, modelRows] = await Promise.all([
      this.db().$queryRaw<Array<{ key: string; cents: number | bigint }>>`
        -- enterprise-bills export-ledger-consume
        SELECT COALESCE(NULLIF(BTRIM(tenant_id), ''), ${unattributed}) AS key,
               COALESCE(SUM(ROUND(ABS(amount_usd) * 100)), 0)::bigint AS cents
        FROM balance_transactions
        WHERE billing_account_id = ${accountId}
          AND type = 'CONSUME'
          AND created_at >= (${start} AT TIME ZONE 'UTC')
          AND created_at < (${endExclusive} AT TIME ZONE 'UTC')
        GROUP BY 1
      `,
      this.db().$queryRaw<Array<{ key: string; cents: number | bigint }>>`
        -- enterprise-bills export-ledger-voucher
        SELECT COALESCE(NULLIF(BTRIM(tenant_id), ''), ${unattributed}) AS key,
               COALESCE(SUM(ROUND(ABS(bonus_consumed_usd) * 100)), 0)::bigint AS cents
        FROM balance_consumption_allocations
        WHERE billing_account_id = ${accountId}
          AND created_at >= (${start} AT TIME ZONE 'UTC')
          AND created_at < (${endExclusive} AT TIME ZONE 'UTC')
        GROUP BY 1
      `,
      this.db().$queryRaw<Array<{
        key: string;
        consumeCents: number | bigint;
        voucherCents: number | bigint;
      }>>`
        -- enterprise-bills export-ledger-model
        SELECT COALESCE(NULLIF(BTRIM(tu.model), ''), ${unattributed}) AS key,
               COALESCE(SUM(ROUND(ABS(a.amount_usd) * 100)), 0)::bigint AS "consumeCents",
               COALESCE(SUM(ROUND(ABS(a.bonus_consumed_usd) * 100)), 0)::bigint AS "voucherCents"
        FROM balance_consumption_allocations a
        LEFT JOIN token_usage tu ON tu.id = a.token_usage_id
        WHERE a.billing_account_id = ${accountId}
          AND a.created_at >= (${start} AT TIME ZONE 'UTC')
          AND a.created_at < (${endExclusive} AT TIME ZONE 'UTC')
        GROUP BY 1
      `,
    ]);

    const byTenant = new Map<string, LedgerMoneyBucket>();
    const bumpTenant = (rawKey: string, consumeCents: number, voucherCents: number) => {
      const key = rawKey.trim() || unattributed;
      const bucket = byTenant.get(key) ?? { key, consumeCents: 0, voucherCents: 0 };
      bucket.consumeCents += consumeCents;
      bucket.voucherCents += voucherCents;
      byTenant.set(key, bucket);
    };
    for (const row of consumeRows) {
      bumpTenant(row.key, Number(row.cents), 0);
    }
    for (const row of voucherRows) {
      bumpTenant(row.key, 0, Number(row.cents));
    }

    const byModel = modelRows.map((row) => ({
      key: row.key.trim() || unattributed,
      consumeCents: Number(row.consumeCents),
      voucherCents: Number(row.voucherCents),
    }));

    return {
      byTenant: [...byTenant.values()],
      byModel,
    };
  }

  private logLedgerAlignmentGaps(
    accountId: string,
    yearMonth: string,
    raw: LedgerBreakdown,
    bill: { consumeCents: number; voucherCents: number },
  ): void {
    const sumTenantConsume = raw.byTenant.reduce((sum, row) => sum + row.consumeCents, 0);
    const sumTenantVoucher = raw.byTenant.reduce((sum, row) => sum + row.voucherCents, 0);
    if (sumTenantConsume !== bill.consumeCents || sumTenantVoucher !== bill.voucherCents) {
      this.logger.warn(
        `enterprise bill export ledger gap account=${accountId} month=${yearMonth}`
          + ` billConsume=${bill.consumeCents} splitConsume=${sumTenantConsume}`
          + ` billVoucher=${bill.voucherCents} splitVoucher=${sumTenantVoucher}`,
      );
    }
  }

  private readonly _db: BillsPrisma;

  private db(): BillsPrisma {
    return this._db;
  }

  /** 账户开户以来全部已闭北京月（close 按 listBills 口径同步汇总）。 */
  private closedMonthsForAccount(account: AccountRow, now: Date): string[] {
    return listYearMonths(account.createdAt, now)
      .filter((yearMonth) => isClosedBeijingMonth(yearMonth, now))
      .sort();
  }

  /** 缺定格则补写；已定格不改 frozen_*。 */
  private async ensureFrozenDeadline(
    account: AccountRow,
    yearMonth: string,
    now: Date,
    existing: DeadlineRow | null,
  ): Promise<DeadlineRow> {
    if (existing?.amountsFrozenAt != null) {
      return existing;
    }
    const termsDays = account.creditConfig?.termsDays ?? 0;
    const freezeAmounts = (await this.loadLiveAmountsByMonth(account.id, [yearMonth], undefined, {
      includeUsage: true,
      includeVoucher: true,
    })).get(yearMonth) ?? emptyAmounts();
    return this.db().enterpriseBillDeadline.upsert({
      where: {
        billingAccountId_yearMonth: { billingAccountId: account.id, yearMonth },
      },
      create: {
        billingAccountId: account.id,
        yearMonth,
        termsDays,
        defaultDueAt: defaultDueAt(yearMonth, termsDays),
        frozenAt: existing?.frozenAt ?? now,
        frozenConsumeCents: freezeAmounts.consumeCents,
        frozenVoucherCents: freezeAmounts.voucherCents,
        frozenChargeCents: freezeAmounts.chargeCents,
        frozenTokenTotal: freezeAmounts.tokenTotal,
        frozenRequestCount: freezeAmounts.requestCount,
        amountsFrozenAt: now,
        pendingAtDeadline: existing?.pendingAtDeadline ?? null,
        pendingObservedAt: existing?.pendingObservedAt ?? null,
      },
      update: {
        frozenConsumeCents: freezeAmounts.consumeCents,
        frozenVoucherCents: freezeAmounts.voucherCents,
        frozenChargeCents: freezeAmounts.chargeCents,
        frozenTokenTotal: freezeAmounts.tokenTotal,
        frozenRequestCount: freezeAmounts.requestCount,
        amountsFrozenAt: existing?.frozenAt ?? now,
      },
    });
  }

  /** 与 listBills 同口径写月汇总（含 effectiveDueAt）；不改 deadline 定格。 */
  private async writeMonthSummaryFromListBills(
    account: AccountRow,
    yearMonth: string,
    now: Date,
    deadline: DeadlineRow | null,
  ): Promise<SummaryRow> {
    const termsDays = account.creditConfig?.termsDays ?? 0;
    const prepaid = isPrepaidFromConfig(account.creditConfig, now);
    const [liveAmounts, listPaidByMonth, events] = await Promise.all([
      this.loadLiveAmountsByMonth(account.id, [yearMonth], undefined, {
        includeUsage: true,
        includeVoucher: false,
      }),
      this.loadListPaidByMonth(account.id, [yearMonth]),
      this.db().enterpriseBillEvent.findMany({
        where: { billingAccountId: account.id, yearMonth, status: 'CONFIRMED' },
      }),
    ]);
    const listPaid = listPaidByMonth.get(yearMonth) ?? emptyListPaid();
    const amounts = withChannelAmounts(liveAmounts.get(yearMonth) ?? emptyAmounts(), listPaid);
    const bill = this.assembleMonth({
      yearMonth,
      now,
      prepaid,
      amounts,
      deadline,
      events,
      termsDays,
      cashPaidCents: listPaid.cashCents,
      fundingPaidCents: listPaid.fundingCents,
    });
    return this.upsertMonthSummaryFromView(
      this.db(),
      account.id,
      yearMonth,
      this.toPersistView(bill, prepaid, true, now),
    );
  }

  private async ensureCurrentMonthPlaceholders(
    accountIds: string[],
    yearMonth: string,
  ): Promise<void> {
    const uniqueIds = [...new Set(accountIds.filter(Boolean))];
    if (uniqueIds.length === 0) {
      return;
    }
    const existing = await this.db().enterpriseBillMonthSummary.findMany({
      where: { billingAccountId: { in: uniqueIds }, yearMonth },
      select: { billingAccountId: true },
    });
    const have = new Set(existing.map((row) => row.billingAccountId));
    const missing = uniqueIds.filter((id) => !have.has(id));
    if (missing.length === 0) {
      return;
    }
    await this.db().enterpriseBillMonthSummary.createMany({
      data: missing.map((billingAccountId) => emptyMonthSummaryCreate(billingAccountId, yearMonth)),
      skipDuplicates: true,
    });
  }

  private async upsertMonthSummaryFromView(
    db: BillsPrisma,
    accountId: string,
    yearMonth: string,
    view: EnterpriseBillPersistView,
  ): Promise<SummaryRow> {
    const row = {
      paidCents: view.paidCents,
      pendingCents: view.pendingCents,
      adjustedCents: view.adjustedCents,
      issuedVoucherCents: view.issuedVoucherCents,
      consumeCents: view.consumeCents,
      voucherCents: view.voucherCents,
      chargeCents: view.chargeCents,
      accountPayCents: view.accountPayCents,
      creditPayCents: view.creditPayCents,
      tokenTotal: view.tokenTotal,
      requestCount: view.requestCount,
      effectiveDueAt: view.dueAt ? new Date(view.dueAt) : null,
      dueProjected: view.dueProjected,
    };
    return db.enterpriseBillMonthSummary.upsert({
      where: { billingAccountId_yearMonth: { billingAccountId: accountId, yearMonth } },
      create: {
        billingAccountId: accountId,
        yearMonth,
        ...row,
      },
      update: row,
    });
  }

  /**
   * Session advisory lock on a dedicated connection_limit=1 client (no BEGIN).
   * Work continues on the pool; unlock/disconnect run in finally.
   * refresh / close 用不同 lockName，互不挡。
   * 真实 Prisma 禁止回退到主连接池：try/unlock 不在同一 session 会把锁钉死。
   * 单测 mock 没有 $connect，才锁在同一 mock 对象上。
   */
  private async withSessionAdvisoryLock<T>(
    lockName: string,
    fn: () => Promise<T>,
  ): Promise<{ acquired: false } | { acquired: true; value: T }> {
    const dedicated = this.createSessionLockClient();
    const lockDb = (dedicated ?? (this.hasPrismaSessionApi() ? null : this.db())) as BillsPrisma | null;
    if (!lockDb) {
      this.logger.error(`${lockName} advisory lock client unavailable; refusing pool fallback`);
      return { acquired: false };
    }
    try {
      if (dedicated) {
        await dedicated.$connect();
      }
      const acquired = await this.trySessionAdvisoryLock(lockDb, lockName);
      if (!acquired) {
        return { acquired: false };
      }
      try {
        return { acquired: true, value: await fn() };
      } finally {
        try {
          await this.releaseSessionAdvisoryLock(lockDb, lockName);
        } catch (error) {
          this.logger.error(
            `${lockName} advisory unlock failed`,
            error instanceof Error ? error.message : String(error),
          );
        }
      }
    } finally {
      if (dedicated) {
        await dedicated.$disconnect();
      }
    }
  }

  private hasPrismaSessionApi(): boolean {
    const prisma = this.prisma as Partial<PrismaClient>;
    return typeof prisma.$connect === 'function' && typeof prisma.$disconnect === 'function';
  }

  private createSessionLockClient(): PrismaClient | null {
    if (!this.hasPrismaSessionApi()) {
      return null;
    }
    return createBillingAdvisoryLockClient();
  }

  private async trySessionAdvisoryLock(db: BillsPrisma, lockName: string): Promise<boolean> {
    const rows = await db.$queryRaw<Array<{ acquired: boolean }>>`
      -- enterprise-bills session-lock
      SELECT pg_try_advisory_lock(hashtext(${lockName})) AS acquired
    `;
    return Boolean(rows[0]?.acquired);
  }

  private async releaseSessionAdvisoryLock(db: BillsPrisma, lockName: string): Promise<void> {
    await db.$queryRaw`
      -- enterprise-bills session-unlock
      SELECT pg_advisory_unlock(hashtext(${lockName}))
    `;
  }
}

function countOf(value: number | bigint | null | undefined): number {
  if (value == null) return 0;
  return Number(value);
}

function amountsFromSummary(summary: SummaryRow, deadline: DeadlineRow | null): MonthAmounts {
  return {
    consumeCents: countOf(summary.consumeCents),
    voucherCents: countOf(summary.voucherCents),
    chargeCents: countOf(summary.chargeCents),
    accountPayCents: countOf(summary.accountPayCents),
    creditPayCents: countOf(summary.creditPayCents),
    debtPayCents: countOf(summary.debtPayCents),
    tokenTotal: countOf(summary.tokenTotal ?? deadline?.frozenTokenTotal),
    requestCount: countOf(summary.requestCount ?? deadline?.frozenRequestCount),
  };
}

function frozenAmountsOf(deadline: DeadlineRow): MonthAmounts {
  const consumeCents = countOf(deadline.frozenConsumeCents);
  const voucherCents = countOf(deadline.frozenVoucherCents);
  return {
    consumeCents,
    voucherCents,
    chargeCents: deadline.frozenChargeCents != null
      ? countOf(deadline.frozenChargeCents)
      : computeChargeCents({ consumeCents, voucherCents }),
    accountPayCents: 0,
    creditPayCents: 0,
    debtPayCents: 0,
    tokenTotal: countOf(deadline.frozenTokenTotal),
    requestCount: countOf(deadline.frozenRequestCount),
  };
}

function beijingDayWindows(
  start: Date,
  endExclusive: Date,
): Array<{ start: Date; endExclusive: Date }> {
  const dayMs = 24 * 60 * 60 * 1000;
  const windows: Array<{ start: Date; endExclusive: Date }> = [];
  for (let cursor = start.getTime(); cursor < endExclusive.getTime(); cursor += dayMs) {
    windows.push({
      start: new Date(cursor),
      endExclusive: new Date(Math.min(cursor + dayMs, endExclusive.getTime())),
    });
  }
  return windows;
}

function withChannelAmounts(amounts: MonthAmounts, listPaid?: ListPaidCents): MonthAmounts {
  if (!listPaid) return amounts;
  return {
    ...amounts,
    voucherCents: listPaid.voucherCents,
    chargeCents: computeChargeCents({
      consumeCents: amounts.consumeCents,
      voucherCents: listPaid.voucherCents,
    }),
    accountPayCents: listPaid.cashCents,
    creditPayCents: listPaid.creditCents,
    debtPayCents: listPaid.debtCents,
  };
}

function emptyAmounts(): MonthAmounts {
  return {
    consumeCents: 0,
    voucherCents: 0,
    chargeCents: 0,
    accountPayCents: 0,
    creditPayCents: 0,
    debtPayCents: 0,
    tokenTotal: 0,
    requestCount: 0,
  };
}

function emptyMonthSummaryCreate(billingAccountId: string, yearMonth: string) {
  return {
    billingAccountId,
    yearMonth,
    paidCents: 0,
    pendingCents: 0,
    adjustedCents: 0,
    issuedVoucherCents: 0,
    consumeCents: 0,
    voucherCents: 0,
    chargeCents: 0,
    accountPayCents: 0,
    creditPayCents: 0,
    tokenTotal: 0,
    requestCount: 0,
    effectiveDueAt: null,
    dueProjected: false,
  };
}

function isCashOrGrantAllocation(row: {
  source?: string | null;
  balanceGrantId?: string | null;
}): boolean {
  return row.source !== ALLOCATION_SOURCE_ENTERPRISE_CREDIT || row.balanceGrantId != null;
}

function isPrepaidFromConfig(config: CreditConfig | null, now: Date): boolean {
  if (!config) {
    return true;
  }
  const inWindow = (!config.effectiveAt || config.effectiveAt.getTime() <= now.getTime())
    && (!config.expiresAt || config.expiresAt.getTime() > now.getTime());
  const activeLimitCents = config.status === 'ACTIVE' && inWindow ? Math.abs(usdToCents(config.limitUsd)) : 0;
  return isPrepaidCredit({
    status: config.status,
    activeLimitCents,
    policyBoundaryComplete: config.policyBoundaryComplete,
    policyRevision: config.policyRevision,
  });
}

function requireWriteOffNote(note: string | null | undefined): string {
  const text = note?.trim() ?? '';
  if (!text) {
    throw new BadRequestException('备注必填');
  }
  if (text.length > 100) {
    throw new BadRequestException('备注不能超过 100 字');
  }
  return text;
}

/** 串行化写路径事务：临界区包含钱包往返，放宽 Prisma 默认 5s 超时；等连接上限 10s。 */
const WRITE_SERIALIZATION_TX_OPTIONS = { maxWait: 10_000, timeout: 30_000 } as const;

function requireIdempotencyKey(value: string | undefined): string {
  const key = value?.trim() ?? '';
  if (!key) {
    throw new BadRequestException('idempotencyKey 不能为空');
  }
  return key;
}

function billIdempotencyFingerprintMatches(
  existing: {
    amountCents: number | bigint;
    note: string | null;
    dueAt?: Date | string | null;
  },
  expected: { amountCents: number; note: string; dueAt?: Date },
  kind: 'write-off' | 'adjust' | 'compensate' | 'extend',
): boolean {
  switch (kind) {
    case 'write-off':
    case 'adjust':
    case 'compensate':
      return countOf(existing.amountCents) === expected.amountCents
        && (existing.note ?? '') === expected.note;
    case 'extend': {
      const existingMs = dueAtMs(existing.dueAt);
      const expectedMs = dueAtMs(expected.dueAt);
      return existingMs !== null && expectedMs !== null && existingMs === expectedMs;
    }
    default: {
      const unexpected: never = kind;
      return unexpected;
    }
  }
}

function dueAtMs(value: Date | string | null | undefined): number | null {
  if (value == null) {
    return null;
  }
  const ms = value instanceof Date ? value.getTime() : Date.parse(value);
  return Number.isFinite(ms) ? ms : null;
}

function billEventId(
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
