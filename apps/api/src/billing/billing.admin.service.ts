import {
  Injectable,
  BadRequestException,
  ConflictException,
  InternalServerErrorException,
  HttpException,
  NotFoundException,
  Optional,
  Logger,
} from '@nestjs/common';
import { AdminRepository } from '../admin/admin.repository';
import { PrismaService } from '../prisma/prisma.service';
import { PaymentService } from '../payment/payment.service';
import { PaymentProviderRegistry } from '../payment/payment-provider-registry';
import { ProductSyncNotifier } from '../integration/product-sync-notifier';
import {
  BundleItemBillingType,
  BalanceTransactionAttributionSource,
  CodingPlanEntitlementStatus,
  CodingPlanFulfillmentMode,
  CreditTxType,
  InvoiceApplicationStatus,
  OrderStatus,
  PaymentCheckoutInitState,
  PayChannel,
  Prisma,
  ProductBillingMode,
  SubscriptionStatus,
  TransactionType,
} from '@prisma/client';
import { centsToUsd, sumUsdToCents as sumUsdValuesToCents, USD_SCALE, usd, usdNumber, usdString, usdToCents } from './money';
import { resolvePlatformCurrency, type PlatformRegion } from './platform-currency';
import { acquirePlanWriteLock, isSelfOpCodingPlan } from './plan-write-lock';
import {
  buildTokenTypeBreakdown,
  getRegularInputTokens,
} from './token-breakdown';
import {
  resolvePlanQuotaRuleViews,
  findCreditWindowConsistencyViolations,
  formatCreditWindowConsistencyError,
  isProviderResalePlan,
} from '../quota-templates/plan-quota-rule-views';
import { createHash } from 'crypto';
import {
  defaultPlanSalesStatus,
  loadProviderResalePlanSalesStatuses,
  type PlanSalesStatus,
  type PlanSalesStatusPlan,
} from './plan-sales-status';
import { SystemConfigService } from './system-config.service';
import { POSTGRES_UTC_FINANCIAL_CLOCK } from './balance-financial-clock';
import {
  PROVIDER_RESALE_ROUTE_LINE_IDENTITY_SELECT,
  validateProviderResaleRouteGroupAccountIdentity,
} from '../provider-account-identity/provider-account-identity.policy';
import {
  FinanceUserIdentityResolver,
  type FinanceUserSearchPlan,
} from './finance-user-identity.resolver';
import type { FinanceUserContact } from '../payment/user-purchase-verification.client';
import { AsyncLocalStorage } from 'async_hooks';
import { once } from 'events';
import { createReadStream, createWriteStream } from 'fs';
import { access, mkdir, rename, unlink } from 'fs/promises';
import { isAbsolute, join, relative, resolve } from 'path';
import { tmpdir } from 'os';
import {
  FinanceExportDiskCache,
  FinanceExportExternalSorter,
} from './finance-export-spill';
import {
  FinanceSqlPagedResult,
  FinanceSummarySqlAggregator,
  type FinanceSummarySqlFact,
  type FinanceSummarySqlRow,
} from './finance-summary-sql';
import { FinanceReportOverviewCacheService } from './finance-report-overview-cache.service';
import { financeApiUsageChannelUsd } from './enterprise-bills.policy';

const REVENUE_ORDER_STATUSES = [
  OrderStatus.PAID,
  OrderStatus.FULFILLING,
  OrderStatus.COMPLETED,
];
const TOKEN_PLAN_REVENUE_ORDER_STATUSES = [
  ...REVENUE_ORDER_STATUSES,
  OrderStatus.REFUNDING,
  OrderStatus.REFUNDED,
  OrderStatus.REFUND_FAILED,
  OrderStatus.REFUND_COMPENSATION_FAILED,
];
// 自营限量售卖「在途订单」口径（与 payment.service SALES_CAP_RESERVED_ORDER_STATUSES 同）。
const SALES_CAP_RESERVED_ORDER_STATUSES = [
  OrderStatus.PENDING,
  OrderStatus.PAID,
  OrderStatus.FULFILLING,
];
const PERSONAL_BILLING_ACCOUNT_ID_PREFIX = 'ba_personal_';
const DAY_MS = 24 * 60 * 60 * 1000;
const SHANGHAI_OFFSET_MS = 8 * 60 * 60 * 1000;
const FINANCE_REPORT_DETAIL_DEFAULT_PAGE_SIZE = 100;
const FINANCE_REPORT_DETAIL_MAX_PAGE_SIZE = 500;
const FINANCE_EXPORT_JOB_TTL_DAYS = 7;
const FINANCE_EXPORT_JOB_LIST_MAX_TAKE = 1000;
// Shared ceiling for every finance report export path, including streamed CSV jobs.
const FINANCE_EXPORT_MAX_ROWS = 1_000_000;
// Export workers can safely use larger internal pages than the interactive UI.
// Detail exports favor bounded memory, while grouped exports trade a larger
// source batch for substantially fewer enrichment and aggregation round trips.
const FINANCE_EXPORT_PAGE_SIZE = 2_000;
const FINANCE_EXPORT_GROUP_PAGE_SIZE = 5_000;
const FINANCE_EXPORT_SPILL_BUFFER_ROWS = 10_000;
const FINANCE_EXPORT_RUNNING_STALE_MS = 60 * 60 * 1000;
const FINANCE_EXPORT_HEARTBEAT_INTERVAL_MS = 30_000;
const FINANCE_RAW_USD = Symbol('financeRawUsd');
const FINANCE_RAW_MAJOR_UNIT_AMOUNTS = 'rawMajorUnitAmounts';
const FINANCE_EXPORT_MAJOR_UNIT_SUFFIX = '（主币种单位）';
const FINANCE_ACCOUNT_LABEL_SELECT = {
  type: true,
  enterpriseName: true,
  verificationId: true,
} as const;
const BALANCE_ALLOCATION_SOURCE_ENTERPRISE_CREDIT = 'ENTERPRISE_CREDIT';
const BALANCE_ALLOCATION_SOURCE_NEGATIVE_BALANCE = 'NEGATIVE_BALANCE';
const BALANCE_GRANT_LEDGER_STATUS_RECONCILED = 'RECONCILED_V2';
const BALANCE_GRANT_LEDGER_VERSION = 2;
const EMPTY_FINANCE_ALLOCATION_PROOF_IDS: ReadonlySet<string> = new Set<string>();

const FINANCE_REPORT_DETAIL_TABS = [
  'pureGiftAccountChanges',
  'pureGiftConsumptionDetails',
  'pureGiftConsumptionSummary',
  'buyGiftAccountChanges',
  'buyGiftAccountSummary',
  'buyGiftConsumptionDetails',
  'buyGiftConsumptionSummary',
  'buyGiftPaymentDetails',
  'buyGiftPaymentSummary',
  'enterpriseCreditConsumptionDetails',
  'enterpriseCreditConsumptionSummary',
  'enterpriseCreditSettlement',
  'tokenPlanRevenueSummary',
  'tokenPlanRevenueDetails',
  'tokenPlanRevenueNotes',
  'templateNotes',
  'summary',
  'orders',
  'payments',
  'balance',
  'balanceGrants',
  'balanceAllocations',
  'credits',
  'apiUsage',
  'supplier',
  'gaps',
] as const;

type FinanceReportDetailTab = typeof FINANCE_REPORT_DETAIL_TABS[number];
type FinanceReportBillingMode = ProductBillingMode;
type FinanceRevenueRecognitionMode = ProductBillingMode;
type FinanceExportJobStatus = 'PENDING' | 'RUNNING' | 'SUCCEEDED' | 'FAILED';

const FINANCE_REPORT_FILTER_FIELDS = [
  'user',
  'model',
  'workspace',
  'rechargeBatchNo',
  'rechargeOrderNo',
  'callTransactionNo',
  'channelTradeNo',
  'allocationId',
  'settlementId',
  'repaymentTransactionId',
  'orderId',
  'merchantOrderNo',
  'tradeNo',
  'transactionId',
  'usageId',
  'grantId',
  'requestId',
  'apiKey',
  'product',
  'plan',
] as const;

type FinanceReportFilterField = typeof FINANCE_REPORT_FILTER_FIELDS[number];
type FinanceReportFilter = {
  field: FinanceReportFilterField;
  value: string;
  userSearch?: FinanceUserSearchPlan;
};

type FinanceReportDetailParams = {
  month?: string;
  tab?: string;
  billingMode?: string;
  pageSize?: number;
  cursor?: string;
  filterField?: string;
  filterValue?: string;
  /** Internal export boundary. Public page requests leave this unset. */
  cutoffExclusive?: Date;
};

type ResolvedFinanceReportDetailParams = FinanceReportDetailParams & {
  pageSize: number;
  filter: FinanceReportFilter | null;
};

const FINANCE_REPORT_FILTER_FIELDS_BY_TAB = {
  pureGiftAccountChanges: ['user', 'workspace', 'product', 'rechargeBatchNo', 'rechargeOrderNo', 'grantId'],
  pureGiftConsumptionDetails: [
    'user',
    'model',
    'workspace',
    'product',
    'rechargeBatchNo',
    'callTransactionNo',
    'allocationId',
    'usageId',
    'grantId',
  ],
  pureGiftConsumptionSummary: ['user', 'model'],
  buyGiftAccountChanges: ['user', 'workspace', 'product', 'rechargeBatchNo', 'rechargeOrderNo', 'grantId'],
  buyGiftAccountSummary: ['user'],
  buyGiftConsumptionDetails: [
    'user',
    'model',
    'workspace',
    'product',
    'rechargeBatchNo',
    'callTransactionNo',
    'allocationId',
    'usageId',
    'grantId',
  ],
  buyGiftConsumptionSummary: ['user', 'model'],
  buyGiftPaymentDetails: [
    'user',
    'rechargeBatchNo',
    'rechargeOrderNo',
    'channelTradeNo',
    'grantId',
  ],
  buyGiftPaymentSummary: ['user'],
  enterpriseCreditConsumptionDetails: [
    'user',
    'model',
    'workspace',
    'product',
    'callTransactionNo',
    'allocationId',
    'usageId',
  ],
  enterpriseCreditConsumptionSummary: ['workspace', 'product'],
  enterpriseCreditSettlement: [
    'workspace',
    'allocationId',
    'settlementId',
    'repaymentTransactionId',
  ],
  tokenPlanRevenueSummary: ['product', 'plan'],
  tokenPlanRevenueDetails: ['user', 'workspace', 'product', 'plan', 'orderId'],
  tokenPlanRevenueNotes: [],
  templateNotes: [],
  summary: [],
  orders: ['user', 'workspace', 'product', 'plan', 'orderId', 'tradeNo'],
  payments: [
    'user',
    'workspace',
    'product',
    'plan',
    'orderId',
    'merchantOrderNo',
    'tradeNo',
  ],
  balance: [
    'user',
    'workspace',
    'product',
    'orderId',
    'transactionId',
    'usageId',
  ],
  balanceGrants: [
    'user',
    'workspace',
    'product',
    'rechargeBatchNo',
    'rechargeOrderNo',
    'grantId',
  ],
  balanceAllocations: [
    'user',
    'workspace',
    'product',
    'rechargeBatchNo',
    'rechargeOrderNo',
    'callTransactionNo',
    'allocationId',
    'transactionId',
    'usageId',
    'grantId',
  ],
  credits: ['user', 'model', 'workspace', 'transactionId', 'requestId'],
  apiUsage: ['user', 'model', 'workspace', 'product', 'usageId', 'requestId', 'apiKey'],
  supplier: [],
  gaps: [],
} as const satisfies Record<FinanceReportDetailTab, readonly FinanceReportFilterField[]>;

const FINANCE_REPORT_SUMMARY_TABS: ReadonlySet<FinanceReportDetailTab> = new Set([
  'pureGiftConsumptionSummary',
  'buyGiftAccountSummary',
  'buyGiftConsumptionSummary',
  'buyGiftPaymentSummary',
  'enterpriseCreditConsumptionSummary',
  'tokenPlanRevenueSummary',
  'summary',
]);

const FINANCE_BALANCE_LEDGER_REPORT_TABS: ReadonlySet<FinanceReportDetailTab> = new Set([
  'balanceGrants',
  'balanceAllocations',
  'pureGiftAccountChanges',
  'pureGiftConsumptionDetails',
  'pureGiftConsumptionSummary',
  'buyGiftAccountChanges',
  'buyGiftAccountSummary',
  'buyGiftConsumptionDetails',
  'buyGiftConsumptionSummary',
  'buyGiftPaymentDetails',
  'buyGiftPaymentSummary',
]);

const FINANCE_REPORT_SNAPSHOT_TIMEOUT_MS = 15_000;
const FINANCE_REPORT_SUMMARY_SNAPSHOT_TIMEOUT_MS = 60_000;
const FINANCE_REPORT_OVERVIEW_COMPUTATION_TIMEOUT_MS = 25_000;
const FINANCE_EXPORT_SNAPSHOT_TIMEOUT_MS = 60 * 60 * 1_000;

const FINANCE_CONSUMPTION_SUMMARY_CONFIG = {
  pureGiftConsumptionSummary: {
    detailTab: 'pureGiftConsumptionDetails',
    sumKeys: ['tokenUsage', 'actualSupplierChargeCents', 'estimatedSupplierChargeCents'],
  },
  buyGiftConsumptionSummary: {
    detailTab: 'buyGiftConsumptionDetails',
    sumKeys: [
      'tokenUsage',
      'consumeAmountCents',
      'consumeAmountPaidCents',
      'actualSupplierChargeCents',
      'estimatedSupplierChargeCents',
    ],
  },
} as const satisfies Partial<Record<FinanceReportDetailTab, {
  detailTab: FinanceReportDetailTab;
  sumKeys: readonly string[];
}>>;

type FinanceConsumptionSummaryTab = keyof typeof FINANCE_CONSUMPTION_SUMMARY_CONFIG;

const FINANCE_USER_CURRENCY_SUMMARY_CONFIG = {
  buyGiftAccountSummary: {
    detailTab: 'buyGiftAccountChanges',
    sumKeys: [
      'openingAvailableBalanceCents',
      'periodRechargeAmountCents',
      'periodRefundWriteOffAmountCents',
      'periodConsumeAmountCents',
      'periodExpireWriteOffAmountCents',
      'periodOtherChangeAmountCents',
      'closingAvailableBalanceCents',
      'cumulativeConsumeOrExpireAmountCents',
      'openingAvailableBalancePaidCents',
      'periodRechargePaidCents',
      'periodRefundWriteOffPaidCents',
      'periodConsumePaidCents',
      'periodExpireWriteOffPaidCents',
      'periodOtherChangePaidCents',
      'closingAvailableBalancePaidCents',
      'cumulativeConsumeOrExpirePaidCents',
      'periodCollectionAmountCents',
      'accumulatedCollectionAmountCents',
      'receivableAmountCents',
      'periodRefundPaymentAmountCents',
      'accumulatedRefundPaymentAmountCents',
      'periodInvoiceAmountCents',
      'accumulatedInvoiceAmountCents',
    ],
  },
  buyGiftPaymentSummary: {
    detailTab: 'buyGiftPaymentDetails',
    sumKeys: [
      'periodCollectionAmountCents',
      'accumulatedCollectionAmountCents',
      'receivableAmountCents',
      'periodRefundPaymentAmountCents',
      'accumulatedRefundPaymentAmountCents',
    ],
  },
} as const satisfies Partial<Record<FinanceReportDetailTab, {
  detailTab: FinanceReportDetailTab;
  sumKeys: readonly string[];
}>>;

type FinanceUserCurrencySummaryTab = keyof typeof FINANCE_USER_CURRENCY_SUMMARY_CONFIG;

const FINANCE_REPORT_BILLING_MODES = [
  ProductBillingMode.SUBSCRIPTION,
  ProductBillingMode.PAY_AS_YOU_GO,
  ProductBillingMode.CODING_PLAN,
] as const;

type FinanceExportColumn = {
  key: string;
  title: string;
};

const financeExportColumns = (columns: Array<[string, string]>): FinanceExportColumn[] =>
  columns.map(([key, title]) => ({ key, title }));

type FinanceRawUsdRow = Record<string, unknown> & {
  [FINANCE_RAW_USD]?: Record<string, Prisma.Decimal>;
  [FINANCE_RAW_MAJOR_UNIT_AMOUNTS]?: Record<string, string>;
};

type FinanceGroupedState = {
  row: Record<string, unknown>;
  rawUsd: Map<string, Prisma.Decimal>;
  rawUsdKeys: Set<string>;
};

type FinanceGroupedSpillRow = {
  key: string;
  row: Record<string, unknown>;
  rawUsd: Record<string, string>;
};

type FinanceEnterpriseCreditSummarySqlRow = {
  seq: bigint;
  id: string;
  tenantId: string;
  productId: string | null;
  callCount: bigint;
  amountUsd: string;
  recognizedRevenueUsd: string;
  settledUsd: string;
};

type FinanceExportWriteParams = {
  id: string;
  month: string;
  tab: FinanceReportDetailTab;
  billingMode?: string;
  asOf: Date;
  snapshot?: FinanceReportReadSnapshot;
  path: string;
  totalRows: number | null;
};

type FinanceReadClient = PrismaService | Prisma.TransactionClient;

type FinanceReportReadSnapshot = {
  db: Prisma.TransactionClient;
  asOf: Date;
  validatedConsumptionGrantIds: Set<string>;
};

const FINANCE_EXPORT_JOB_META_SELECT = {
  id: true,
  month: true,
  tab: true,
  billingMode: true,
  status: true,
  filename: true,
  contentType: true,
  rowCount: true,
  fileSizeBytes: true,
  fileSha256: true,
  processedRows: true,
  totalRows: true,
  asOf: true,
  heartbeatAt: true,
  errorCode: true,
  failedStage: true,
  errorMessage: true,
  requestedByAdminId: true,
  startedAt: true,
  finishedAt: true,
  expiresAt: true,
  createdAt: true,
  updatedAt: true,
} satisfies Prisma.FinanceExportJobSelect;

const FINANCE_EXPORT_HEADER_TITLES: Record<string, string> = {
  period: '账期',
  orderId: '订单ID',
  orderItemId: '订单项ID',
  transactionId: '流水ID',
  allocationId: '分摊ID',
  grantId: '批次ID',
  usageId: '用量ID',
  requestId: '请求ID',
  userId: '用户ID',
  userLabel: '用户',
  workspaceId: '工作区ID',
  workspaceName: '工作区',
  workspaceType: '工作区类型',
  productId: '产品ID',
  productName: '产品',
  planId: '套餐ID',
  planName: '套餐',
  billingMode: '计费模式',
  orderType: '订单类型',
  itemName: '项目',
  currency: '币种',
  channel: '渠道',
  tradeNo: '交易号',
  status: '状态',
  type: '类型',
  source: '来源',
  model: '模型',
  modelName: '模型',
  tokenType: 'Token 类型',
  tokens: 'Token',
  tokenUsage: 'Token',
  totalTokens: '总 Token',
  inputTokens: '输入 Token',
  cachedInputTokens: '缓存读 Token',
  cacheWriteInputTokens: '缓存写 Token',
  outputTokens: '输出 Token',
  unitPriceUsdPerM: '单价/百万',
  inputUnitPrice: '输入单价/百万',
  cacheReadUnitPrice: '缓存读单价/百万',
  cacheWriteUnitPrice: '缓存写单价/百万',
  outputUnitPrice: '输出单价/百万',
  userChargeUsd: '扣费金额',
  paymentDeductionUsd: '本金扣费',
  voucherDeductionUsd: '赠送扣费',
  roundingAdjustmentUsd: '计价舍入差额(已含在扣费金额)',
  chargeSource: '扣费来源',
  customerChargePolicy: '扣费策略',
  createdAt: '创建时间',
  paidAt: '支付时间',
  completedAt: '完成时间',
  refundedAt: '退款时间',
  refundReason: '退款原因',
  originalAmountCents: '原价金额',
  discountAmountCents: '优惠金额',
  amountCents: '订单金额',
  refundAmountCents: '退款金额',
  paidAmountCents: '实付金额',
  channelFeeCents: '渠道手续费',
  settlementNetCents: '结算净额',
  diffCents: '差异金额',
  balanceAfterCents: '变动后余额',
  openingBalanceCents: '期初余额',
  rechargeCents: '充值金额',
  balanceConsumeCents: '余额消费',
  adjustCents: '调整金额',
  closingBalanceCents: '期末余额',
  orderRevenueCents: '订单收入',
  supplierCostCents: '供应商成本',
  paymentFeeCents: '支付手续费',
  grossProfitCents: '毛利',
  invoiceableCents: '可开票金额',
  invoicedCents: '已开票金额',
  paidCents: '本金',
  bonusCents: '赠送',
  grantedCents: '发放金额',
  remainingCents: '剩余金额',
  consumedCents: '消耗金额',
  recognizedRevenueCents: '确认收入',
  bonusConsumedCents: '赠送消耗',
  grantPaidCents: '批次本金',
  grantBonusCents: '批次赠送',
  grantTotalCents: '批次总额',
  grantRemainingCents: '批次剩余',
  orderAmountCents: '订单金额',
  openingDeferredCents: '期初递延',
  newDeferredCents: '新增递延',
  serviceRecognizedRevenueCents: '服务期确认收入',
  refundAppliedToDeferredCents: '退款冲递延',
  refundRevenueReversalCents: '退款冲收入',
  closingDeferredCents: '期末递延',
  recognizedToDateCents: '累计确认收入',
  deferredVarianceCents: '递延校验差异',
  merchantOrderNo: '商户订单号',
  checkoutSessionId: 'Stripe Checkout Session ID',
  subscriptionId: 'Stripe Subscription ID',
  invoiceId: 'Stripe Invoice ID',
  paymentIntentId: 'Stripe PaymentIntent ID',
  chargeId: 'Stripe Charge ID',
  balanceTransactionId: 'Stripe Balance Transaction ID',
  payoutId: 'Stripe Payout ID',
  stripeAmountCents: 'Stripe实收金额',
  paymentStatus: '支付状态',
  stripeStatus: 'Stripe状态',
  stripeCustomerEmail: 'Stripe客户邮箱',
  stripeCreatedAt: 'Stripe交易时间',
  channelSettlementDate: '渠道结算日期',
  bankReceivedDate: '银行入账日期',
  webhookEventId: 'Webhook/通知ID',
  systemMatchStatus: '系统匹配状态',
  diffReason: '差异原因',
};

const FINANCE_PAYMENT_EXPORT_COLUMNS: FinanceExportColumn[] = [
  { key: 'period', title: '账期' },
  { key: 'channel', title: '支付渠道' },
  { key: 'merchantOrderNo', title: '商户订单号' },
  { key: 'tradeNo', title: '系统渠道交易号' },
  { key: 'checkoutSessionId', title: 'Stripe Checkout Session ID' },
  { key: 'subscriptionId', title: 'Stripe Subscription ID' },
  { key: 'invoiceId', title: 'Stripe Invoice ID' },
  { key: 'paymentIntentId', title: 'Stripe PaymentIntent ID' },
  { key: 'chargeId', title: 'Stripe Charge ID' },
  { key: 'balanceTransactionId', title: 'Stripe Balance Transaction ID' },
  { key: 'payoutId', title: 'Stripe Payout ID' },
  { key: 'userId', title: '用户ID' },
  { key: 'workspaceName', title: '工作区' },
  { key: 'workspaceId', title: '工作区ID' },
  { key: 'billingMode', title: '计费模式' },
  { key: 'orderType', title: '订单类型' },
  { key: 'paidAmountCents', title: '系统支付金额' },
  { key: 'stripeAmountCents', title: 'Stripe实收金额' },
  { key: 'channelFeeCents', title: '渠道手续费' },
  { key: 'settlementNetCents', title: '渠道结算净额' },
  { key: 'paymentStatus', title: '系统支付状态' },
  { key: 'stripeStatus', title: 'Stripe状态' },
  { key: 'stripeCustomerEmail', title: 'Stripe客户邮箱' },
  { key: 'paidAt', title: '支付完成时间' },
  { key: 'stripeCreatedAt', title: 'Stripe交易时间' },
  { key: 'channelSettlementDate', title: '渠道结算日期' },
  { key: 'bankReceivedDate', title: '银行入账日期' },
  { key: 'webhookEventId', title: 'Webhook/通知ID' },
  { key: 'systemMatchStatus', title: '系统匹配状态' },
  { key: 'diffCents', title: '差异金额' },
  { key: 'diffReason', title: '差异原因' },
];

const FINANCE_EXPORT_COLUMNS_BY_TAB: Partial<Record<FinanceReportDetailTab, FinanceExportColumn[]>> = {
  pureGiftAccountChanges: financeExportColumns([
    ['rechargeBatchNo', '充值批次号'],
    ['userLabel', '用户'],
    ['currency', '币种'],
    ['giftRechargeAmountCents', '充值金额-赠送'],
    ['rechargeOrderNo', '充值订单号'],
    ['rechargeCompletedAt', '充值完成时间'],
    ['expiresAt', '到期时间'],
    ['otherChangeAmountCents', '其他变动金额'],
    ['otherChangeType', '其他变动类型'],
    ['otherChangeAt', '其他变动时间'],
    ['availableAmountCents', '可消耗金额'],
    ['openingAvailableBalanceCents', '期初可消耗余额'],
    ['periodRechargeAmountCents', '本期充值金额'],
    ['periodConsumeAmountCents', '本期消耗金额(负值)'],
    ['periodExpireWriteOffAmountCents', '本期到期核销金额(负值)'],
    ['periodOtherChangeAmountCents', '本期其他变动金额'],
    ['closingAvailableBalanceCents', '期末可消耗余额'],
    ['cumulativeConsumeOrExpireAmountCents', '累计消耗或到期核销金额'],
  ]),
  pureGiftConsumptionDetails: financeExportColumns([
    ['callTransactionNo', '调用流水号'],
    ['callTime', '调用时间'],
    ['userLabel', '用户'],
    ['rechargeBatchNo', '充值批次号'],
    ['model', '模型'],
    ['callType', '调用类型'],
    ['tokenUsage', 'Token用量'],
    ['actualSupplierChargeUsd', '实际供应商收费'],
    ['supplierUnitPriceUsdPerM', '供应商单价'],
    ['supplierDiscount', '供应商折扣'],
    ['estimatedSupplierChargeUsd', '预计供应商收费'],
  ]),
  pureGiftConsumptionSummary: financeExportColumns([
    ['userLabel', '用户'],
    ['userId', '用户ID'],
    ['model', '模型'],
    ['tokenUsage', 'Token用量'],
    ['actualSupplierChargeCents', '实际供应商收费'],
    ['estimatedSupplierChargeCents', '预计供应商收费'],
  ]),
  buyGiftAccountChanges: financeExportColumns([
    ['rechargeBatchNo', '充值批次号'],
    ['userLabel', '用户'],
    ['currency', '币种'],
    ['paidRechargeAmountCents', '充值金额-实收'],
    ['bonusRechargeAmountCents', '充值金额-买赠'],
    ['rechargeOrderNo', '充值订单号'],
    ['rechargeCompletedAt', '充值完成时间'],
    ['rechargeDiscountRate', '充值折扣率'],
    ['refundWriteOffPaidCents', '退款核销金额-实收(负值)'],
    ['refundWriteOffBonusCents', '退款核销金额-买赠(负值)'],
    ['refundCompletedAt', '退款完成时间'],
    ['expiresAt', '到期时间'],
    ['otherChangeAmountCents', '其他变动金额'],
    ['otherChangeType', '其他变动类型'],
    ['otherChangeAt', '其他变动时间'],
    ['availableAmountCents', '可消耗金额'],
    ['openingAvailableBalanceCents', '期初可消耗余额'],
    ['periodRechargeAmountCents', '本期充值金额'],
    ['periodRefundWriteOffAmountCents', '本期退款核销金额(负值)'],
    ['periodConsumeAmountCents', '本期消耗金额(负值)'],
    ['periodExpireWriteOffAmountCents', '本期到期核销金额(负值)'],
    ['periodOtherChangeAmountCents', '本期其他变动金额'],
    ['closingAvailableBalanceCents', '期末可消耗余额'],
    ['cumulativeConsumeOrExpireAmountCents', '累计消耗或到期核销金额'],
    ['openingAvailableBalancePaidCents', '期初可消耗余额-实收'],
    ['periodRechargePaidCents', '本期充值金额-实收'],
    ['periodRefundWriteOffPaidCents', '本期退款核销金额-实收(负值)'],
    ['periodConsumePaidCents', '本期消耗金额-实收(负值)'],
    ['periodExpireWriteOffPaidCents', '本期到期核销金额-实收(负值)'],
    ['periodOtherChangePaidCents', '本期其他变动金额-实收'],
    ['closingAvailableBalancePaidCents', '期末可消耗余额-实收'],
    ['cumulativeConsumeOrExpirePaidCents', '累计消耗或到期核销金额-实收'],
    ['periodCollectionAmountCents', '本期收款金额'],
    ['accumulatedCollectionAmountCents', '累计收款金额'],
    ['receivableAmountCents', '待收金额'],
    ['periodRefundPaymentAmountCents', '本期退款支付金额(负值)'],
    ['accumulatedRefundPaymentAmountCents', '累计退款支付金额(负值)'],
    ['periodInvoiceAmountCents', '本期开票金额'],
    ['accumulatedInvoiceAmountCents', '累计开票金额'],
  ]),
  buyGiftAccountSummary: financeExportColumns([
    ['userLabel', '用户'],
    ['userId', '用户ID'],
    ['currency', '币种'],
    ['openingAvailableBalanceCents', '期初可消耗余额'],
    ['periodRechargeAmountCents', '本期充值金额'],
    ['periodRefundWriteOffAmountCents', '本期退款核销金额(负值)'],
    ['periodConsumeAmountCents', '本期消耗金额(负值)'],
    ['periodExpireWriteOffAmountCents', '本期到期核销金额(负值)'],
    ['periodOtherChangeAmountCents', '本期其他变动金额'],
    ['closingAvailableBalanceCents', '期末可消耗余额'],
    ['cumulativeConsumeOrExpireAmountCents', '累计消耗或到期核销金额'],
    ['openingAvailableBalancePaidCents', '期初可消耗余额-实收'],
    ['periodRechargePaidCents', '本期充值金额-实收'],
    ['periodRefundWriteOffPaidCents', '本期退款核销金额-实收(负值)'],
    ['periodConsumePaidCents', '本期消耗金额-实收(负值)'],
    ['periodExpireWriteOffPaidCents', '本期到期核销金额-实收(负值)'],
    ['periodOtherChangePaidCents', '本期其他变动金额-实收'],
    ['closingAvailableBalancePaidCents', '期末可消耗余额-实收'],
    ['cumulativeConsumeOrExpirePaidCents', '累计消耗或到期核销金额-实收'],
    ['periodCollectionAmountCents', '本期收款金额'],
    ['accumulatedCollectionAmountCents', '累计收款金额'],
    ['receivableAmountCents', '待收金额'],
    ['periodRefundPaymentAmountCents', '本期退款支付金额(负值)'],
    ['accumulatedRefundPaymentAmountCents', '累计退款支付金额(负值)'],
    ['periodInvoiceAmountCents', '本期开票金额'],
    ['accumulatedInvoiceAmountCents', '累计开票金额'],
  ]),
  buyGiftConsumptionDetails: financeExportColumns([
    ['callTransactionNo', '调用流水号'],
    ['callTime', '调用时间'],
    ['userLabel', '用户'],
    ['rechargeBatchNo', '充值批次号'],
    ['model', '模型'],
    ['callType', '调用类型'],
    ['userDiscount', '用户折扣'],
    ['unitPriceUsdPerM', '单价'],
    ['tokenUsage', 'Token用量'],
    ['consumeAmountUsd', '消耗金额'],
    ['rechargeDiscountRate', '充值折扣率'],
    ['consumeAmountPaidUsd', '消耗金额-实收'],
    ['noBalanceConsumptionCallType', '无余额消耗的调用类型'],
    ['actualSupplierChargeUsd', '实际供应商收费'],
    ['supplierUnitPriceUsdPerM', '供应商单价'],
    ['supplierDiscount', '供应商折扣'],
    ['estimatedSupplierChargeUsd', '预计供应商收费'],
  ]),
  buyGiftConsumptionSummary: financeExportColumns([
    ['userLabel', '用户'],
    ['userId', '用户ID'],
    ['model', '模型'],
    ['tokenUsage', 'Token用量'],
    ['consumeAmountCents', '消耗金额'],
    ['consumeAmountPaidCents', '消耗金额-实收'],
    ['actualSupplierChargeCents', '实际供应商收费'],
    ['estimatedSupplierChargeCents', '预计供应商收费'],
  ]),
  buyGiftPaymentDetails: financeExportColumns([
    ['rechargeOrderNo', '充值订单号'],
    ['userLabel', '用户'],
    ['currency', '币种'],
    ['paidRechargeAmountCents', '充值金额-实收'],
    ['periodCollectionAmountCents', '本期收款金额'],
    ['accumulatedCollectionAmountCents', '累计收款金额'],
    ['receivableAmountCents', '待收金额'],
    ['channelTradeNo', '收款渠道流水号'],
    ['refundWriteOffPaidCents', '退款核销金额-实收(负值)'],
    ['periodRefundPaymentAmountCents', '本期退款支付金额(负值)'],
    ['accumulatedRefundPaymentAmountCents', '累计退款支付金额(负值)'],
    ['refundChannelTradeNo', '退款渠道流水号'],
  ]),
  buyGiftPaymentSummary: financeExportColumns([
    ['userLabel', '用户'],
    ['userId', '用户ID'],
    ['currency', '币种'],
    ['periodCollectionAmountCents', '本期收款金额'],
    ['accumulatedCollectionAmountCents', '累计收款金额'],
    ['receivableAmountCents', '待收金额'],
    ['periodRefundPaymentAmountCents', '本期退款支付金额(负值)'],
    ['accumulatedRefundPaymentAmountCents', '累计退款支付金额(负值)'],
  ]),
  enterpriseCreditConsumptionDetails: financeExportColumns([
    ['allocationId', '消耗分摊ID'],
    ['callTime', '调用时间'],
    ['userLabel', '用户'],
    ['workspaceName', '企业工作区'],
    ['workspaceId', '工作区ID'],
    ['model', '模型'],
    ['consumedCents', '消耗金额'],
    ['recognizedRevenueCents', '实付确认收入'],
    ['settledCents', '已结算金额'],
    ['outstandingCents', '未结算金额'],
    ['settlementStatus', '结算状态'],
    ['settledAt', '结清时间'],
  ]),
  enterpriseCreditConsumptionSummary: financeExportColumns([
    ['workspaceName', '企业工作区'],
    ['workspaceId', '工作区ID'],
    ['workspaceType', '工作区类型'],
    ['productName', '产品'],
    ['allocationCount', '消耗分摊数'],
    ['consumedCents', '消耗金额'],
    ['recognizedRevenueCents', '实付确认收入'],
    ['settledCents', '已结算金额'],
    ['outstandingCents', '未结算金额'],
    ['settlementStatus', '结算状态'],
  ]),
  enterpriseCreditSettlement: financeExportColumns([
    ['settlementId', '结算记录ID'],
    ['settlementCreatedAt', '结算时间'],
    ['debtSource', '欠款来源'],
    ['workspaceName', '企业工作区'],
    ['workspaceId', '工作区ID'],
    ['allocationId', '消耗分摊ID'],
    ['trigger', '结算触发方式'],
    ['amountCents', '结算金额'],
    ['paidCents', '实付结算金额'],
    ['bonusCents', '赠金结算金额'],
    ['repaymentTransactionId', '还款流水ID'],
    ['repaymentTransactionDescription', '还款流水说明'],
  ]),
  tokenPlanRevenueSummary: financeExportColumns([
    ['period', '账期'],
    ['productName', '产品'],
    ['planName', '套餐'],
    ['fulfillmentMode', '履约模式'],
    ['currency', '币种'],
    ['orderCount', '订单数'],
    ['lineCount', '明细数'],
    ['orderAmountCents', '订单净额'],
    ['openingDeferredCents', '期初递延收入'],
    ['newDeferredCents', '本期新增递延'],
    ['serviceRecognizedRevenueCents', '服务期确认收入'],
    ['refundAppliedToDeferredCents', '退款冲递延'],
    ['refundRevenueReversalCents', '退款冲已确认收入'],
    ['recognizedRevenueCents', '本期净确认收入'],
    ['closingDeferredCents', '期末递延收入'],
    ['recognizedToDateCents', '累计确认收入'],
    ['refundAmountCents', '本期退款金额'],
    ['deferredVarianceCents', '递延校验差异'],
    ['settlementStatus', '状态'],
    ['notes', '备注'],
  ]),
  tokenPlanRevenueDetails: financeExportColumns([
    ['period', '账期'],
    ['orderId', '订单号'],
    ['orderItemId', '订单明细ID'],
    ['entitlementId', '权益ID'],
    ['providerEntitlementId', '上游权益ID'],
    ['userLabel', '用户'],
    ['workspaceName', '工作区'],
    ['workspaceId', '工作区ID'],
    ['productName', '产品'],
    ['planName', '套餐'],
    ['fulfillmentMode', '履约模式'],
    ['providerLineCode', '供应商线路'],
    ['providerCode', '供应商'],
    ['upstreamProductId', '上游产品ID'],
    ['currency', '币种'],
    ['orderAmountCents', '订单净额'],
    ['billingPeriod', '计费周期'],
    ['serviceStartAt', '服务开始'],
    ['serviceEndAt', '服务结束'],
    ['totalServiceDays', '总服务天数'],
    ['recognizedDaysInPeriod', '本期确认天数'],
    ['openingDeferredCents', '期初递延收入'],
    ['newDeferredCents', '本期新增递延'],
    ['serviceRecognizedRevenueCents', '服务期确认收入'],
    ['refundAppliedToDeferredCents', '退款冲递延'],
    ['refundRevenueReversalCents', '退款冲已确认收入'],
    ['recognizedRevenueCents', '本期净确认收入'],
    ['closingDeferredCents', '期末递延收入'],
    ['recognizedToDateCents', '累计确认收入'],
    ['refundAmountCents', '本期退款金额'],
    ['orderStatus', '订单状态'],
    ['entitlementStatus', '权益状态'],
    ['evidence', '证据来源'],
  ]),
  tokenPlanRevenueNotes: financeExportColumns([
    ['field', '字段'],
    ['status', '当前状态'],
    ['note', '口径说明'],
  ]),
  templateNotes: financeExportColumns([
    ['field', '字段'],
    ['status', '当前状态'],
    ['note', '说明'],
  ]),
  summary: financeExportColumns([
    ['period', '账期月份'],
    ['product', '产品'],
    ['billingMode', '计费模式'],
    ['currency', '币种'],
    ['openingBalanceCents', '期初余额'],
    ['rechargeCents', '本期充值'],
    ['balanceConsumeCents', '本期余额消费'],
    ['refundCents', '本期退款'],
    ['adjustCents', '手工调整'],
    ['closingBalanceCents', '期末余额'],
    ['orderRevenueCents', '订单收入'],
    ['quotaGrantedCredits', '套餐积分发放'],
    ['bonusGrantedCredits', '加油包积分发放'],
    ['creditConsumed', '积分消耗'],
    ['apiInputTokens', 'API输入Token'],
    ['apiCacheReadInputTokens', 'API缓存读取Token'],
    ['apiCacheWriteInputTokens', 'API缓存写入Token'],
    ['apiOutputTokens', 'API输出Token'],
    ['apiTotalTokens', 'API总Token'],
    ['supplierCostCents', '供应商成本'],
    ['paymentFeeCents', '支付手续费'],
    ['grossProfitCents', '毛利'],
    ['invoiceableCents', '可开票金额'],
    ['invoicedCents', '已开票金额'],
    ['settlementStatus', '结算状态'],
    ['varianceCheck', '差异检查'],
    ['notes', '备注'],
  ]),
  orders: financeExportColumns([
    ['period', '账期'],
    ['orderId', '订单号'],
    ['userLabel', '用户'],
    ['workspaceName', '工作区'],
    ['workspaceId', '工作区ID'],
    ['workspaceType', '工作区类型'],
    ['productName', '产品'],
    ['billingMode', '计费模式'],
    ['orderType', '订单类型'],
    ['itemName', '套餐/加油包'],
    ['originalAmountCents', '原价金额'],
    ['discountAmountCents', '折扣金额'],
    ['amountCents', '实收金额'],
    ['channel', '支付渠道'],
    ['tradeNo', '支付流水号'],
    ['status', '订单状态'],
    ['createdAt', '创建时间'],
    ['paidAt', '支付时间'],
    ['completedAt', '完成时间'],
    ['refundedAt', '退款时间'],
    ['refundAmountCents', '退款金额'],
    ['refundReason', '退款原因'],
    ['invoiceableCents', '可开票金额'],
    ['evidence', '审计证据'],
  ]),
  payments: FINANCE_PAYMENT_EXPORT_COLUMNS,
  balance: financeExportColumns([
    ['period', '账期'],
    ['transactionId', '余额流水ID'],
    ['userLabel', '用户'],
    ['workspaceName', '工作区'],
    ['workspaceId', '工作区ID'],
    ['productName', '产品'],
    ['billingMode', '计费模式'],
    ['type', '流水类型'],
    ['amountCents', '变动金额'],
    ['balanceAfterCents', '变动后余额'],
    ['orderId', '关联订单号'],
    ['usageId', '关联用量ID'],
    ['description', '描述'],
    ['createdAt', '发生时间'],
    ['debitSubjectHint', '借方科目建议'],
    ['creditSubjectHint', '贷方科目建议'],
    ['auditNote', '审计说明'],
  ]),
  balanceGrants: financeExportColumns([
    ['period', '账期'],
    ['grantId', '充值批次ID'],
    ['rechargeOrderId', '充值订单号'],
    ['userLabel', '用户'],
    ['workspaceName', '工作区'],
    ['workspaceId', '工作区ID'],
    ['productName', '产品'],
    ['billingMode', '计费模式'],
    ['source', '来源'],
    ['paidCents', '实付金额'],
    ['bonusCents', '赠额'],
    ['grantedCents', '总额度'],
    ['consumedCents', '已消耗'],
    ['remainingCents', '剩余额度'],
    ['discountRate', '折扣率'],
    ['validFrom', '生效时间'],
    ['expiresAt', '到期时间'],
    ['isExpired', '是否过期'],
    ['createdAt', '创建时间'],
    ['auditNote', '审计说明'],
  ]),
  balanceAllocations: financeExportColumns([
    ['period', '账期'],
    ['allocationId', '分摊ID'],
    ['transactionId', '余额流水ID'],
    ['usageId', '用量ID'],
    ['userLabel', '用户'],
    ['workspaceName', '工作区'],
    ['workspaceId', '工作区ID'],
    ['productName', '产品'],
    ['billingMode', '计费模式'],
    ['rechargeGrantId', '充值批次ID'],
    ['rechargeOrderId', '充值订单号'],
    ['consumedCents', '本次消耗'],
    ['recognizedRevenueCents', '确认收入'],
    ['bonusConsumedCents', '赠额消耗'],
    ['discountRate', '折扣率'],
    ['grantPaidCents', '批次实付'],
    ['grantBonusCents', '批次赠额'],
    ['grantTotalCents', '批次总额度'],
    ['grantRemainingCents', '批次剩余'],
    ['grantSource', '批次来源'],
    ['grantExpiresAt', '批次到期时间'],
    ['transactionDescription', '流水描述'],
    ['createdAt', '分摊时间'],
    ['auditNote', '审计说明'],
  ]),
  credits: financeExportColumns([
    ['period', '账期'],
    ['transactionId', '积分流水ID'],
    ['userLabel', '用户'],
    ['workspaceName', '工作区'],
    ['workspaceId', '工作区ID'],
    ['subscriptionId', '订阅ID'],
    ['productName', '产品'],
    ['billingMode', '计费模式'],
    ['planName', '套餐'],
    ['type', '流水类型'],
    ['creditsAmount', '变动积分'],
    ['quotaAfter', '套餐积分余额'],
    ['bonusAfter', '加油包积分余额'],
    ['source', '来源'],
    ['modelName', '模型'],
    ['tokenTypeBreakdown', 'Token 类型'],
    ['regularInputTokens', '普通输入Token'],
    ['inputTokens', '输入Token'],
    ['cachedInputTokens', '缓存读取Token'],
    ['cacheWriteInputTokens', '缓存写入Token'],
    ['outputTokens', '输出Token'],
    ['totalTokens', '总Token'],
    ['requestId', '请求ID'],
    ['createdAt', '发生时间'],
    ['orderId', '关联订单号'],
    ['auditNote', '审计说明'],
  ]),
  apiUsage: financeExportColumns([
    ['createdAt', '请求时间'],
    ['userLabel', '用户'],
    ['workspaceName', '工作区'],
    ['workspaceId', '工作区ID'],
    ['apiKeyPrefix', 'API Key'],
    ['model', '模型'],
    ['billingMode', '计费模式'],
    ['tokenType', 'type'],
    ['tokens', 'tokens'],
    ['unitPriceUsdPerM', 'price'],
    ['customerMultiplier', '折扣'],
    ['userChargeUsd', 'charge'],
    ['paymentDeductionUsd', '本金扣费'],
    ['voucherDeductionUsd', '赠送扣费'],
    ['creditDeductionUsd', '信用扣费'],
    ['debtDeductionUsd', '欠费'],
    ['chargeSource', '扣费来源'],
    ['usageId', '用量ID'],
    // CSV-only accounting detail follows the columns shown on the page.
    ['roundingAdjustmentUsd', '计价舍入差额(已含在 charge)'],
  ]),
  supplier: financeExportColumns([
    ['field', '供应商成本表必需字段'],
    ['status', '当前状态'],
    ['action', '建议动作'],
  ]),
  gaps: financeExportColumns([
    ['category', '类别'],
    ['field', '字段/表'],
    ['source', '当前系统来源'],
    ['availability', '当前可用性'],
    ['purpose', '用途'],
    ['action', '建议动作'],
  ]),
};

const FINANCE_EXPORT_MAJOR_UNIT_KEYS = new Set([
  'userChargeUsd',
  'roundingAdjustmentUsd',
  'paymentDeductionUsd',
  'voucherDeductionUsd',
  'creditDeductionUsd',
  'debtDeductionUsd',
  'consumeAmountUsd',
  'consumeAmountPaidUsd',
  'actualSupplierChargeUsd',
  'estimatedSupplierChargeUsd',
]);

type FinanceReportRowCursor = {
  version: 2;
  kind: 'row';
  scopeHash: string;
  createdAt: string;
  id: string;
  partOffset: number;
};

type FinanceReportStaticCursor = {
  version: 2;
  kind: 'static';
  scopeHash: string;
  offset: number;
};

type FinanceReportCursor = FinanceReportRowCursor | FinanceReportStaticCursor;

interface BundleSkuItemAdminInput {
  productId: string;
  planId?: string | null;
  boosterPackId?: string | null;
  billingType: 'SUBSCRIPTION' | 'ONE_TIME';
  name?: string;
  unitAmountCents: number;
  originalUnitAmountCents?: number | null;
  quantity?: number;
  recurringInterval?: 'month' | 'year' | null;
  validityDays?: number | null;
  sortOrder?: number;
}

interface BundleSkuAdminInput {
  code?: string;
  name?: string;
  description?: string;
  currency?: string;
  billingPeriod?: 'monthly' | 'quarterly' | 'yearly';
  amountCents?: number;
  originalAmountCents?: number | null;
  startAt?: string | Date | null;
  endAt?: string | Date | null;
  maxUsesPerUser?: number;
  maxUsesTotal?: number;
  isActive?: boolean;
  sortOrder?: number;
  items?: BundleSkuItemAdminInput[];
}

interface CodingPlanResalePlanAdminInput {
  id?: string | null;
  routeId?: string | null;
  routes?: CodingPlanResalePlanRouteAdminInput[];
  productId?: string | null;
  name?: string | null;
  description?: string | null;
  monthlyPrice?: number;
  quarterlyPrice?: number;
  yearlyPrice?: number;
  billingPeriod?: string | null;
  memberLimit?: number;
  badge?: string | null;
  trialDays?: number;
  validityDays?: number;
  isActive?: boolean;
  isLegacy?: boolean;
  salesLimit?: number;
  sortOrder?: number;
  currency?: string | null;
  providerLineId?: string | null;
  upstreamProductId?: string | null;
  routeEnabled?: boolean;
  routePriority?: number;
  routeMarket?: string | null;
  routeCurrency?: string | null;
  routeSalesChannel?: string | null;
  routeUserSegmentId?: string | null;
  routeStartAt?: string | Date | null;
  routeEndAt?: string | Date | null;
}

interface CodingPlanResalePlanRouteAdminInput {
  routeId?: string | null;
  providerLineId?: string | null;
  upstreamProductId?: string | null;
  routeEnabled?: boolean;
  routePriority?: number;
  routeMarket?: string | null;
  routeCurrency?: string | null;
  routeSalesChannel?: string | null;
  routeUserSegmentId?: string | null;
  routeStartAt?: string | Date | null;
  routeEndAt?: string | Date | null;
}

type NormalizedCodingPlanResalePlanRouteInput = {
  routeId: string | null;
  providerLineId: string;
  upstreamProductId: string;
  enabled: boolean;
  priority: number;
  market: string | null;
  currency: string | null;
  salesChannel: string | null;
  userSegmentId: string | null;
  startAt?: Date | null;
  endAt?: Date | null;
};

type FinanceEntityUser = {
  id?: string | null;
  email?: string | null;
  phone?: string | null;
  nickname?: string | null;
};

type FinanceEntityBillingAccount = {
  type?: string | null;
  enterpriseName?: string | null;
  verificationId?: string | null;
};

type FinanceEntityTenant = {
  id?: string | null;
  name?: string | null;
  slug?: string | null;
  type?: string | null;
  billingAccount?: FinanceEntityBillingAccount | null;
};

type FinanceEntityProduct = {
  id?: string | null;
  name?: string | null;
  slug?: string | null;
  billingMode?: ProductBillingMode | string | null;
};

type FinanceBalanceAttribution = {
  balanceGrantId?: string | null;
  billingMode: ProductBillingMode;
  source: BalanceTransactionAttributionSource;
};

type FinanceGrantRow = {
  id: string;
  userId: string;
  tenantId: string;
  billingAccountId?: string | null;
  orderId?: string | null;
  productId?: string | null;
  source: string;
  paidAmountUsd: Prisma.Decimal;
  bonusAmountUsd: Prisma.Decimal;
  grantedAmountUsd: Prisma.Decimal;
  remainingAmountUsd: Prisma.Decimal;
  remainingPaidAmountUsd?: Prisma.Decimal | null;
  remainingBonusAmountUsd?: Prisma.Decimal | null;
  discountRate: Prisma.Decimal;
  validFrom: Date;
  expiresAt?: Date | null;
  isExpired: boolean;
  createdAt: Date;
  user?: FinanceEntityUser | null;
  tenant?: FinanceEntityTenant | null;
  product?: FinanceEntityProduct | null;
  attribution?: FinanceBalanceAttribution | null;
  billingAccount?: {
    id: string;
    balanceGrantLedgerStatus: string;
    balanceGrantLedgerVersion: number;
    type?: string | null;
    enterpriseName?: string | null;
    verificationId?: string | null;
  } | null;
  order?: {
    id: string;
    amountCents: number;
    bonusCents: number;
    currency: string;
    status: OrderStatus;
    channel?: string | null;
    tradeNo?: string | null;
    paidAt?: Date | null;
    completedAt?: Date | null;
    refundedAt?: Date | null;
    refundAmountCents?: number | null;
  } | null;
  targetRefunds?: Array<{
    component: string;
    requestedAmountUsd: Prisma.Decimal;
    occurredAt: Date;
  }>;
  refundAllocations?: Array<{
    id: string;
    refundId: string;
    balanceGrantId: string;
    sequence: number;
    role: string;
    amountUsd: Prisma.Decimal;
    paidReductionUsd: Prisma.Decimal;
    bonusReductionUsd: Prisma.Decimal;
    refund: {
      id: string;
      billingAccountId: string;
      balanceGrantId: string;
      refundTransactionId: string;
      debtAllocationId?: string | null;
      component: string;
      occurredAt: Date;
      balanceGrant: {
        id: string;
        billingAccountId?: string | null;
      };
    };
  }>;
  debtSettlements?: Array<{
    id: string;
    billingAccountId: string;
    // legacy 结算行（balance_grant_id 为空）可能没有关联分摊，schema 允许 null。
    allocationId: string | null;
    repaymentTransactionId?: string | null;
    balanceGrantId?: string | null;
    legacyEffectiveBalanceGrantId?: string | null;
    debtSource: string;
    repairRunId?: string | null;
    trigger: string;
    amountUsd: Prisma.Decimal;
    paidUsd: Prisma.Decimal;
    bonusUsd: Prisma.Decimal;
    occurredAt: Date;
    allocation: {
      id: string;
      billingAccountId?: string | null;
      source?: string | null;
    } | null;
  }>;
  expiryAudit?: {
    balanceGrantId: string;
    billingAccountId: string;
    balanceTransactionId: string | null;
    nominalAmountUsd: Prisma.Decimal;
    nominalPaidUsd: Prisma.Decimal;
    nominalBonusUsd: Prisma.Decimal;
    walletDebitUsd: Prisma.Decimal;
    walletDebitPaidUsd: Prisma.Decimal;
    walletDebitBonusUsd: Prisma.Decimal;
    unbackedAmountUsd: Prisma.Decimal;
    unbackedPaidUsd: Prisma.Decimal;
    unbackedBonusUsd: Prisma.Decimal;
    createdAt: Date;
  } | null;
};

type FinanceAllocationRow = {
  id: string;
  userId: string;
  tenantId: string;
  billingAccountId?: string | null;
  productId?: string | null;
  balanceTransactionId: string;
  tokenUsageId?: string | null;
  balanceGrantId?: string | null;
  source?: string | null;
  amountUsd: Prisma.Decimal;
  recognizedRevenueUsd: Prisma.Decimal;
  bonusConsumedUsd: Prisma.Decimal;
  discountRate: Prisma.Decimal;
  settledUsd?: Prisma.Decimal;
  settledAt?: Date | null;
  createdAt: Date;
  user?: FinanceEntityUser | null;
  tenant?: FinanceEntityTenant | null;
  product?: FinanceEntityProduct | null;
  billingAccount?: FinanceEntityBillingAccount | null;
  balanceGrant?: FinanceGrantRow | null;
  balanceTransaction?: {
    id: string;
    orderId?: string | null;
    description?: string | null;
    createdAt: Date;
    attribution?: FinanceBalanceAttribution | null;
  } | null;
  tokenUsage?: {
    id: string;
    model: string;
    pricingTierKey?: string | null;
    promptTokens: number;
    cachedInputTokens?: number | null;
    cacheWriteInputTokens?: number | null;
    completionTokens: number;
    totalTokens: number;
    inputPriceUsdPerM: Prisma.Decimal;
    cachedInputPriceUsdPerM?: Prisma.Decimal | null;
    cacheWritePriceUsdPerM?: Prisma.Decimal | null;
    outputPriceUsdPerM: Prisma.Decimal;
    costUsd: Prisma.Decimal;
    providerCostEstimateUsd?: Prisma.Decimal | null;
    providerCostMultiplier?: Prisma.Decimal | null;
    providerInputCostUsdPerM?: Prisma.Decimal | null;
    providerCachedInputCostUsdPerM?: Prisma.Decimal | null;
    providerCacheWriteCostUsdPerM?: Prisma.Decimal | null;
    providerOutputCostUsdPerM?: Prisma.Decimal | null;
    createdAt: Date;
  } | null;
};

type FinanceEnterpriseAbsorbProofRow = {
  allocationId: string;
  balanceGrantId: string;
  allocationBillingAccountId: string;
};

type FinanceLegacySettlementProofRow = {
  settlementId: string;
  effectiveBalanceGrantId: string;
};

type FinanceGrantExpiryAllocationAggregateRow = {
  grantId: string;
  amountUsd: Prisma.Decimal;
  paidUsd: Prisma.Decimal;
  bonusUsd: Prisma.Decimal;
  beforeValidFromCount: bigint | number;
  atOrAfterExpiryCount: bigint | number;
};

type FinanceGrantExpiryAllocationComponents = {
  paidUsd: Prisma.Decimal;
  bonusUsd: Prisma.Decimal;
};

type FinanceEnterpriseCreditSettlementRow = {
  id: string;
  billingAccountId: string;
  allocationId: string;
  repaymentTransactionId?: string | null;
  debtSource: string;
  trigger: string;
  amountUsd: Prisma.Decimal;
  paidUsd: Prisma.Decimal;
  bonusUsd: Prisma.Decimal;
  occurredAt: Date;
  createdAt: Date;
  allocation: FinanceAllocationRow;
  repaymentTransaction?: {
    id: string;
    description: string;
    createdAt: Date;
  } | null;
};

type FinanceConsumptionTokenPart = {
  callType: 'input' | 'cache read' | 'cache write' | 'output';
  tokens: number;
  unitPriceUsdPerM: Prisma.Decimal | null;
  supplierUnitPriceUsdPerM: Prisma.Decimal | null;
  weight: Prisma.Decimal;
  supplierWeight: Prisma.Decimal;
};

type FinanceInvoiceAmount = {
  periodInvoiceAmountCents: number;
  accumulatedInvoiceAmountCents: number;
};

type FinanceStandardPrice = {
  inputPriceUsdPerM: Prisma.Decimal;
  cachedInputPriceUsdPerM: Prisma.Decimal | null;
  cacheWritePriceUsdPerM: Prisma.Decimal | null;
  outputPriceUsdPerM: Prisma.Decimal;
};

type FinanceBalanceTransactionRow = {
  id: string;
  type: string;
  amountUsd: Prisma.Decimal;
  orderId?: string | null;
  tokenUsageId?: string | null;
  description?: string | null;
  createdAt: Date;
};

type FinanceTokenPlanEntitlementRow = {
  id: string;
  orderId: string;
  billingPeriod: string;
  fulfillmentMode: string;
  status: string;
  startedAt: Date;
  expiresAt?: Date | null;
  providerEntitlementId?: string | null;
  providerLineCode?: string | null;
  providerCode?: string | null;
  upstreamProductId?: string | null;
};

type FinanceTokenPlanLine = {
  period: string;
  orderId: string;
  orderItemId: string | null;
  entitlementId: string | null;
  providerEntitlementId: string | null;
  userId: string;
  userLabel: string;
  workspaceId: string;
  workspaceName: string;
  workspaceType: string;
  productId: string | null;
  productName: string;
  planId: string | null;
  planName: string;
  fulfillmentMode: string;
  providerLineCode: string | null;
  providerCode: string | null;
  upstreamProductId: string | null;
  currency: string;
  orderAmountCents: number;
  billingPeriod: string;
  serviceStartAt: Date;
  serviceEndAt: Date;
  totalServiceDays: number;
  recognizedDaysInPeriod: number;
  openingDeferredCents: number;
  newDeferredCents: number;
  serviceRecognizedRevenueCents: number;
  refundAppliedToDeferredCents: number;
  refundRevenueReversalCents: number;
  recognizedRevenueCents: number;
  closingDeferredCents: number;
  recognizedToDateCents: number;
  refundAmountCents: number;
  orderStatus: OrderStatus;
  entitlementStatus: string;
  evidence: string;
};

type FinanceTokenPlanSummaryRow = {
  period: string;
  productId: string | null;
  productName: string;
  planId: string | null;
  planName: string;
  fulfillmentMode: string;
  currency: string;
  orderCount: number;
  lineCount: number;
  orderAmountCents: number;
  openingDeferredCents: number;
  newDeferredCents: number;
  serviceRecognizedRevenueCents: number;
  refundAppliedToDeferredCents: number;
  refundRevenueReversalCents: number;
  recognizedRevenueCents: number;
  closingDeferredCents: number;
  recognizedToDateCents: number;
  refundAmountCents: number;
  settlementStatus: string;
  notes: string;
  deferredVarianceCents: number;
};

@Injectable()
export class BillingAdminService {
  private readonly logger = new Logger(BillingAdminService.name);
  private readonly financeExportContext = new AsyncLocalStorage<{
    contacts: FinanceExportDiskCache<FinanceUserContact>;
  }>();

  constructor(
    private readonly repo: AdminRepository,
    private readonly prisma: PrismaService,
    private readonly paymentService: PaymentService,
    private readonly productSync: ProductSyncNotifier,
    private readonly systemConfig: SystemConfigService,
    @Optional() private readonly paymentProviderRegistry?: PaymentProviderRegistry,
    @Optional() private readonly financeUserIdentity?: FinanceUserIdentityResolver,
    @Optional() private readonly financeOverviewCache?: FinanceReportOverviewCacheService,
  ) {}

  async listOrders(
    page: number,
    pageSize: number,
    filters?: {
      status?: string;
      userId?: string;
      productId?: string;
      orderType?: string;
      channel?: string;
      search?: string;
    },
  ) {
    const skip = (page - 1) * pageSize;
    const [items, total] = await Promise.all([
      this.repo.findOrders(skip, pageSize, filters),
      this.repo.countOrders(filters),
    ]);
    const fulfillmentModes = items.length > 0
      ? await this.prisma.codingPlanEntitlement.findMany({
          where: { orderId: { in: items.map((item) => item.id) } },
          select: { orderId: true, fulfillmentMode: true },
        })
      : [];
    const fulfillmentModeByOrderId = new Map(
      fulfillmentModes.map((entitlement) => [
        entitlement.orderId,
        entitlement.fulfillmentMode,
      ]),
    );
    return {
      items: items.map((item) => {
        const codingPlanFulfillmentMode =
          fulfillmentModeByOrderId.get(item.id);
        return codingPlanFulfillmentMode
          ? { ...item, codingPlanFulfillmentMode }
          : item;
      }),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async listRecentOrdersForUser(userId: string, limit: number) {
    return this.prisma.order.findMany({
      where: { userId },
      orderBy: { createdAt: 'desc' },
      take: limit,
      select: {
        id: true,
        amountCents: true,
        status: true,
        createdAt: true,
      },
    });
  }

  async getOrderDetail(id: string) {
    const [order, codingPlanEntitlement] = await Promise.all([
      this.prisma.order.findUnique({
        where: { id },
        include: {
          user: {
            select: {
              id: true,
              email: true,
              nickname: true,
            },
          },
          plan: {
            select: {
              id: true,
              name: true,
            },
          },
          product: {
            select: {
              id: true,
              name: true,
              slug: true,
              billingMode: true,
              codingPlanFulfillmentMode: true,
            },
          },
          boosterPack: {
            select: {
              id: true,
              name: true,
            },
          },
          auditLogs: {
            orderBy: {
              createdAt: 'asc',
            },
          },
        },
      }),
      this.prisma.codingPlanEntitlement.findUnique({
        where: { orderId: id },
        select: { fulfillmentMode: true },
      }),
    ]);
    if (!order) throw new BadRequestException('订单不存在');
    return codingPlanEntitlement
      ? {
          ...order,
          codingPlanFulfillmentMode:
            codingPlanEntitlement.fulfillmentMode,
        }
      : order;
  }

  async adminCancelOrder(orderId: string, adminId: string, reason?: string) {
    await this.prisma.$transaction(async (tx) => {
      const result = await tx.order.updateMany({
        where: { id: orderId, status: OrderStatus.PENDING },
        data: {
          status: OrderStatus.CANCELLED,
          cancelledAt: new Date(),
          cancelReason: reason ?? null,
          checkoutInitState: PaymentCheckoutInitState.TERMINAL,
          checkoutLeaseId: null,
          checkoutLeaseExpiresAt: null,
          checkoutContextEncrypted: null,
          checkoutPayUrlEncrypted: null,
          checkoutPayUrlExpiresAt: null,
        },
      });

      if (result.count === 0) {
        const order = await tx.order.findUnique({ where: { id: orderId } });
        if (!order) throw new BadRequestException('订单不存在');
        throw new BadRequestException(`当前状态 ${order.status} 不允许取消，只能取消待支付的订单`);
      }

      await tx.orderAuditLog.create({
        data: {
          orderId,
          fromStatus: OrderStatus.PENDING,
          toStatus: OrderStatus.CANCELLED,
          operator: `admin:${adminId}`,
          detail: reason ?? '管理员取消订单',
        },
      });
    });
  }

  async retryFailedOrder(orderId: string, adminId: string) {
    const existing = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (existing?.status === OrderStatus.FULFILLING && existing.paidAt) {
      await this.prisma.orderAuditLog.create({
        data: {
          orderId,
          fromStatus: OrderStatus.FULFILLING,
          toStatus: OrderStatus.FULFILLING,
          operator: `admin:${adminId}`,
          detail: '管理员触发履约恢复',
        },
      });
      await this.paymentService.retryFulfill(orderId);
      return;
    }

    await this.prisma.$transaction(async (tx) => {
      const result = await tx.order.updateMany({
        where: { id: orderId, status: OrderStatus.FAILED, paidAt: { not: null } },
        data: {
          status: OrderStatus.PAID,
        },
      });

      if (result.count === 0) {
        const order = await tx.order.findUnique({ where: { id: orderId } });
        if (!order) throw new BadRequestException('订单不存在');
        if (order.status === OrderStatus.FAILED && !order.paidAt) {
          throw new BadRequestException('订单未支付，不能重试发放');
        }
        throw new BadRequestException(`当前状态 ${order.status} 不允许重试，只能重试失败的订单`);
      }

      await tx.orderAuditLog.create({
        data: {
          orderId,
          fromStatus: OrderStatus.FAILED,
          toStatus: OrderStatus.PAID,
          operator: `admin:${adminId}`,
          detail: '管理员触发重试发放',
        },
      });
    });

    await this.paymentService.retryFulfill(orderId);
  }

  async refundOrder(orderId: string, reason: string) {
    if (!orderId || !reason) throw new BadRequestException('orderId 和 reason 为必填');
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new BadRequestException('订单不存在');
    const refundableStatuses: OrderStatus[] = [
      OrderStatus.PAID,
      OrderStatus.PARTIALLY_FULFILLED_REQUIRES_COMPENSATION,
      OrderStatus.COMPLETED,
      OrderStatus.REFUND_FAILED,
      OrderStatus.REFUND_COMPENSATION_FAILED,
    ];
    if (!refundableStatuses.includes(order.status)) {
      throw new BadRequestException('只能退款已支付、已完成或待补偿的订单');
    }
    return this.paymentService.refundOrder(orderId, reason);
  }

  async listTransactions(page: number, pageSize: number, filters?: { userId?: string; productId?: string }) {
    const skip = (page - 1) * pageSize;
    const [items, total] = await Promise.all([
      this.repo.findTransactions(skip, pageSize, filters),
      this.repo.countTransactions(filters),
    ]);
    return {
      items: items.map((tx) => ({
        ...tx,
        amountCents: usdToCents(tx.type === 'CONSUME' ? usd(tx.amountUsd).abs() : tx.amountUsd),
        amountUsd: usdNumber(tx.type === 'CONSUME' ? usd(tx.amountUsd).abs() : tx.amountUsd),
        balanceAfterCents: usdToCents(tx.balanceAfterUsd),
        productName: tx.product?.name ?? null,
        usageId: tx.tokenUsageId ?? null,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async listSubscriptions(params: {
    page: number;
    pageSize: number;
    status?: string;
    expiringDays?: number;
    productId?: string;
    userId?: string;
  }) {
    const pageSize = Math.min(Math.max(params.pageSize || 20, 1), 100);
    const page = Math.max(params.page || 1, 1);
    const where: Prisma.SubscriptionPeriodWhereInput = {};

    if (params.status && ['ACTIVE', 'EXPIRED', 'CANCELLED'].includes(params.status)) {
      where.status = params.status as SubscriptionStatus;
    }
    if (params.productId) {
      where.productId = params.productId;
    }
    if (params.userId) {
      where.userId = params.userId;
    }
    if (params.expiringDays && params.expiringDays > 0) {
      const now = new Date();
      const end = new Date(now);
      end.setDate(end.getDate() + params.expiringDays);
      where.status = SubscriptionStatus.ACTIVE;
      where.expiresAt = { gte: now, lte: end };
    }

    const [items, total, active, expiringSoon, cancelled, expired] = await Promise.all([
      this.prisma.subscriptionPeriod.findMany({
        where,
        orderBy: { updatedAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          user: { select: { id: true, email: true, nickname: true } },
          tenant: { select: { id: true, name: true, type: true, status: true } },
          product: { select: { id: true, name: true, slug: true } },
          plan: {
            select: {
              id: true,
              name: true,
              monthlyPrice: true,
              quarterlyPrice: true,
              yearlyPrice: true,
              monthlyCredits: true,
            },
          },
        },
      }),
      this.prisma.subscriptionPeriod.count({ where }),
      this.prisma.subscriptionPeriod.count({
        where: {
          status: 'ACTIVE',
          ...(params.productId ? { productId: params.productId } : {}),
          ...(params.userId ? { userId: params.userId } : {}),
        },
      }),
      this.countExpiringSubscriptions(7, params.productId, params.userId),
      this.prisma.subscriptionPeriod.count({
        where: {
          status: 'CANCELLED',
          ...(params.productId ? { productId: params.productId } : {}),
          ...(params.userId ? { userId: params.userId } : {}),
        },
      }),
      this.prisma.subscriptionPeriod.count({
        where: {
          status: 'EXPIRED',
          ...(params.productId ? { productId: params.productId } : {}),
          ...(params.userId ? { userId: params.userId } : {}),
        },
      }),
    ]);

    return {
      items: items.map((item) => ({
        id: item.id,
        tenantId: item.tenantId,
        tenantName: item.tenant?.name ?? item.user.email,
        tenantType: item.tenant?.type ?? null,
        tenantStatus: item.tenant?.status ?? null,
        accountId: item.tenantId ?? item.userId,
        accountName: item.tenant?.name ?? item.user.email,
        userId: item.userId,
        userEmail: item.user.email,
        userNickname: item.user.nickname,
        productName: item.product.name,
        productSlug: item.product.slug,
        planId: item.planId,
        planName: item.plan.name,
        status: item.status,
        startedAt: item.startedAt.toISOString(),
        expiresAt: item.expiresAt?.toISOString() ?? null,
        updatedAt: item.updatedAt.toISOString(),
        monthlyPrice: item.plan.monthlyPrice,
        quarterlyPrice: item.plan.quarterlyPrice,
        yearlyPrice: item.plan.yearlyPrice,
        monthlyCredits: item.plan.monthlyCredits,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
      stats: {
        active,
        expiringSoon,
        cancelled,
        expired,
      },
    };
  }

  async listPaygAccounts(params: {
    page: number;
    pageSize: number;
    search?: string;
    email?: string;
    status?: string;
    productId?: string;
  }) {
    const pageSize = Math.min(Math.max(params.pageSize || 20, 1), 100);
    const page = Math.max(params.page || 1, 1);
    const search = params.search?.trim();
    const email = params.email?.trim();
    const keyWhere: Prisma.ApiKeyWhereInput = { deletedAt: null };
    if (params.productId) keyWhere.productId = params.productId;

    const [paygProducts, tenants, keys] = await Promise.all([
      this.prisma.product.findMany({
        where: {
          billingMode: 'PAY_AS_YOU_GO',
          isActive: true,
          deletedAt: null,
          ...(params.productId ? { id: params.productId } : {}),
        },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, name: true, slug: true, billingMode: true },
      }),
      this.prisma.tenant.findMany({
        where: { status: 'active', deletedAt: null },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          type: true,
          status: true,
          ownerUserId: true,
          billingAccountId: true,
          balanceAllowanceUsd: true,
          balanceAllowanceUsedUsd: true,
          createdAt: true,
          owner: { select: { id: true, email: true, nickname: true } },
        },
      }),
      this.prisma.apiKey.findMany({
        where: keyWhere,
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          name: true,
          prefix: true,
          tenantId: true,
          productId: true,
          isActive: true,
          createdAt: true,
          lastUsedAt: true,
          tenant: {
            select: {
              id: true,
              name: true,
              type: true,
              status: true,
              ownerUserId: true,
              billingAccountId: true,
              balanceAllowanceUsd: true,
              balanceAllowanceUsedUsd: true,
              createdAt: true,
              owner: { select: { id: true, email: true, nickname: true } },
            },
          },
          product: { select: { id: true, name: true, slug: true, billingMode: true } },
          user: { select: { id: true, email: true, nickname: true } },
        },
      }),
    ]);

    const visiblePaygProducts = params.productId
      ? paygProducts
      : paygProducts.filter((product) => !product.slug.toLowerCase().startsWith('e2e'));
    const accountProducts = visiblePaygProducts.length > 0 ? visiblePaygProducts : paygProducts;
    const defaultPaygProduct = accountProducts.find((product) => product.slug.toLowerCase() === 'payg')
      ?? accountProducts[0]
      ?? null;
    const paygProductById = new Map(paygProducts.map((product) => [product.id, product]));
    const paygKeys = keys.filter((key) =>
      Boolean(key.tenantId) && Boolean(key.tenant) && (!key.product || key.product.billingMode === 'PAY_AS_YOU_GO'),
    ) as Array<(typeof keys)[number] & { tenantId: string; tenant: NonNullable<(typeof keys)[number]['tenant']> }>;
    const ids = paygKeys.map((key) => key.id);
    const billingAccountIds = Array.from(new Set([
      ...tenants.map((tenant) => tenant.billingAccountId).filter((id): id is string => Boolean(id)),
      ...paygKeys.map((key) => key.tenant?.billingAccountId).filter((id): id is string => Boolean(id)),
    ]));
    const monthStart = new Date();
    monthStart.setDate(1);
    monthStart.setHours(0, 0, 0, 0);

    const [usageRows, wallets] = await Promise.all([
      ids.length
        ? this.prisma.tokenUsage.groupBy({
            by: ['apiKeyId'],
            where: {
              apiKeyId: { in: ids },
              createdAt: { gte: monthStart },
            },
            _count: { _all: true },
            _sum: { costUsd: true },
          })
        : [],
      billingAccountIds.length
        ? this.prisma.accountWallet.findMany({
            where: { billingAccountId: { in: billingAccountIds } },
            select: { billingAccountId: true, balanceUsd: true },
          })
        : [],
    ]);
    const usageMap = new Map(
      usageRows.map((row) => [
        row.apiKeyId,
        {
          monthlyCalls: row._count._all,
          monthlyCost: usdToCents(row._sum.costUsd ?? 0),
        },
      ]),
    );
    const walletMap = new Map(wallets.map((wallet) => [wallet.billingAccountId, wallet.balanceUsd]));

    type AccountProduct = (typeof paygProducts)[number] | null;
    type AccountTenant = (typeof tenants)[number];
    type AccountUser = { id: string; email: string | null; nickname: string | null };
    type AccountRow = {
      id: string;
      tenantId: string;
      tenantName: string;
      tenantType: string | null;
      tenantStatus: string | null;
      accountId: string;
      accountName: string;
      productId: string | null;
      productName: string;
      productSlug: string | null;
      userId: string;
      userEmail: string | null;
      userNickname: string | null;
      keyCount: number;
      activeKeyCount: number;
      monthlyCalls: number;
      monthlyCost: number;
      walletBalanceCents: number;
      createdAt: string;
      lastUsedAt: string | null;
      keys: Array<{
        id: string;
        name: string;
        prefix: string;
        isActive: boolean;
        lastUsedAt: string | null;
        monthlyCalls: number;
        monthlyCost: number;
      }>;
    };

    const accountBalanceCents = (tenant: {
      billingAccountId: string | null;
      balanceAllowanceUsd: Prisma.Decimal | null;
      balanceAllowanceUsedUsd: Prisma.Decimal;
    }) => {
      const accountBalanceUsd = usd(walletMap.get(tenant.billingAccountId ?? '') ?? 0);
      const allowanceUsd = tenant.balanceAllowanceUsd == null ? null : usd(tenant.balanceAllowanceUsd);
      const allowanceRemainingUsd = allowanceUsd === null
        ? null
        : allowanceUsd.minus(usd(tenant.balanceAllowanceUsedUsd ?? 0));
      const workspaceBalanceUsd = allowanceRemainingUsd === null
        ? accountBalanceUsd
        : accountBalanceUsd.lte(allowanceRemainingUsd)
          ? accountBalanceUsd
          : (allowanceRemainingUsd.gt(0) ? allowanceRemainingUsd : new Prisma.Decimal(0));
      return usdToCents(workspaceBalanceUsd);
    };

    const rowMap = new Map<string, AccountRow>();
    const ensureRow = (
      tenant: AccountTenant,
      product: AccountProduct,
      createdAt: Date,
      fallbackUser?: AccountUser,
    ) => {
      const productId = product?.id ?? null;
      const rowId = `${tenant.id}:${productId ?? 'default'}`;
      const existing = rowMap.get(rowId);
      if (existing) {
        const createdAtIso = createdAt.toISOString();
        if (createdAtIso < existing.createdAt) existing.createdAt = createdAtIso;
        return existing;
      }

      const owner = tenant.owner ?? fallbackUser ?? {
        id: tenant.ownerUserId,
        email: null,
        nickname: null,
      };
      const ownerEmail = owner.email ?? null;
      const accountName = tenant.name || ownerEmail || tenant.id;
      const row: AccountRow = {
        id: rowId,
        tenantId: tenant.id,
        tenantName: accountName,
        tenantType: tenant.type ?? null,
        tenantStatus: tenant.status ?? null,
        accountId: tenant.billingAccountId ?? `${PERSONAL_BILLING_ACCOUNT_ID_PREFIX}${tenant.ownerUserId}`,
        accountName,
        productId,
        productName: product?.name ?? '默认按量产品',
        productSlug: product?.slug ?? null,
        userId: owner.id,
        userEmail: ownerEmail,
        userNickname: owner.nickname ?? null,
        keyCount: 0,
        activeKeyCount: 0,
        monthlyCalls: 0,
        monthlyCost: 0,
        walletBalanceCents: accountBalanceCents(tenant),
        createdAt: createdAt.toISOString(),
        lastUsedAt: null,
        keys: [],
      };
      rowMap.set(rowId, row);
      return row;
    };

    for (const tenant of tenants) {
      for (const product of accountProducts) {
        ensureRow(tenant, product, tenant.createdAt);
      }
    }

    for (const key of paygKeys) {
      const product = key.product
        ? paygProductById.get(key.product.id) ?? key.product
        : defaultPaygProduct;
      if (params.productId && product?.id !== params.productId) continue;
      const row = ensureRow(key.tenant, product ?? null, key.createdAt, key.user);
      const keyUsage = usageMap.get(key.id);
      const monthlyCalls = keyUsage?.monthlyCalls ?? 0;
      const monthlyCost = keyUsage?.monthlyCost ?? 0;
      row.keyCount += 1;
      row.monthlyCalls += monthlyCalls;
      row.monthlyCost += monthlyCost;
      if (key.isActive) row.activeKeyCount += 1;
      if (key.lastUsedAt) {
        const lastUsedAt = key.lastUsedAt.toISOString();
        if (!row.lastUsedAt || lastUsedAt > row.lastUsedAt) row.lastUsedAt = lastUsedAt;
      }
      row.keys.push({
        id: key.id,
        name: key.name,
        prefix: key.prefix,
        isActive: key.isActive,
        lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
        monthlyCalls,
        monthlyCost,
      });
    }

    const normalizedSearch = search?.toLowerCase();
    const normalizedEmail = email?.toLowerCase();
    const rows = Array.from(rowMap.values()).filter((row) => {
      if (params.status === 'active' && row.activeKeyCount <= 0) return false;
      if (params.status === 'inactive' && row.activeKeyCount > 0) return false;
      if (normalizedEmail && !String(row.userEmail ?? '').toLowerCase().includes(normalizedEmail)) {
        return false;
      }
      if (!normalizedSearch) return true;
      const haystack = [
        row.accountName,
        row.tenantName,
        row.productName,
        row.productSlug ?? '',
        row.userEmail ?? '',
        row.userNickname ?? '',
        ...row.keys.flatMap((key) => [key.name, key.prefix]),
      ].join('\n').toLowerCase();
      return haystack.includes(normalizedSearch);
    }).sort((a, b) => {
      const left = a.lastUsedAt ?? a.createdAt;
      const right = b.lastUsedAt ?? b.createdAt;
      return right.localeCompare(left);
    });

    const total = rows.length;
    const pagedRows = rows.slice((page - 1) * pageSize, page * pageSize);
    return {
      items: pagedRows,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
      stats: {
        active: rows.filter((row) => row.activeKeyCount > 0).length,
        activeKeys: rows.reduce((sum, row) => sum + row.activeKeyCount, 0),
        monthlyCalls: rows.reduce((sum, row) => sum + row.monthlyCalls, 0),
        monthlyCost: rows.reduce((sum, row) => sum + row.monthlyCost, 0),
      },
    };
  }

  async getStats() {
    return this.repo.getStats();
  }

  async getRevenue(productId?: string) {
    return productId ? this.repo.getRevenue(productId) : this.repo.getRevenue();
  }

  async getRevenueOverview(days: number, productId?: string) {
    return productId ? this.repo.getRevenueOverview(days, productId) : this.repo.getRevenueOverview(days);
  }

  async getCachedFinanceReportOverview(
    month?: string,
    billingModeParam?: string,
    refresh = false,
  ) {
    const { monthKey } = this.resolveMonthRange(month);
    const billingMode = this.resolveFinanceReportBillingMode(billingModeParam);
    const compute = async () => {
      const startedAt = Date.now();
      try {
        return await this.withFinanceReportReadSnapshot(async (snapshot) => {
          const overview = await this.getFinanceReportOverview(
            monthKey,
            billingMode,
            snapshot.db,
          );
          return {
            ...overview,
            period: {
              ...overview.period,
              asOf: snapshot.asOf.toISOString(),
              timezone: 'Asia/Shanghai',
            },
          };
        }, this.financeOverviewCache?.computationTimeoutMs
          ?? FINANCE_REPORT_OVERVIEW_COMPUTATION_TIMEOUT_MS);
      } finally {
        this.logger.log(
          `finance overview computation finished month=${monthKey} billingMode=${billingMode ?? 'ALL'} durationMs=${Date.now() - startedAt}`,
        );
      }
    };

    if (!this.financeOverviewCache) return compute();
    return this.financeOverviewCache.getOrCompute(
      { month: monthKey, billingMode: billingMode ?? 'ALL' },
      compute,
      { refresh },
    );
  }

  async getFinanceReportOverview(
    month?: string,
    billingModeParam?: string,
    db: FinanceReadClient = this.prisma,
  ) {
    const { monthKey, start, end } = this.resolveMonthRange(month);
    const billingMode = this.resolveFinanceReportBillingMode(billingModeParam);
    const platformCurrencyCode = await this.getPlatformCurrencyCode(db);
    const balanceGrantWhere = this.financeBalanceGrantWhere(start, end, billingMode);
    const orderReportWhere = this.financeOrderReportWhere(start, end, billingMode);
    const paymentReportWhere = this.financePaymentReportWhere(start, end, billingMode);
    const revenueRecognitionMode = this.resolveFinanceRevenueRecognitionMode(billingMode);
    const balancePeriodWhere = this.withFinanceBalanceTransactionBillingMode(
      { createdAt: { gte: start, lt: end } },
      billingMode,
    );
    const tokenUsagePeriodWhere = {
      AND: [
        this.withFinanceProductBillingMode({ createdAt: { gte: start, lt: end } }, billingMode),
        this.financeVisibleTokenUsageWhere(),
      ],
    } satisfies Prisma.TokenUsageWhereInput;
    const creditPeriodWhere = this.withFinanceProductBillingMode({ createdAt: { gte: start, lt: end } }, billingMode);
    const balanceAllocationPeriodWhere = this.withFinanceBalanceAllocationBillingMode(
      { createdAt: { gte: start, lt: end } },
      billingMode,
    );
    const pureGiftGrantWhere = {
      AND: [balanceGrantWhere, this.financeGrantCategoryWhere('pureGiftAccountChanges')],
    } satisfies Prisma.BalanceGrantWhereInput;
    const buyGiftGrantWhere = {
      AND: [balanceGrantWhere, this.financeGrantCategoryWhere('buyGiftAccountChanges')],
    } satisfies Prisma.BalanceGrantWhereInput;
    const pureGiftAllocationWhere = {
      AND: [balanceAllocationPeriodWhere, this.financeAllocationCategoryWhere('pureGiftConsumptionDetails')],
    } satisfies Prisma.BalanceConsumptionAllocationWhereInput;
    const buyGiftAllocationWhere = {
      AND: [balanceAllocationPeriodWhere, this.financeAllocationCategoryWhere('buyGiftConsumptionDetails')],
    } satisfies Prisma.BalanceConsumptionAllocationWhereInput;
    const enterpriseCreditAllocationWhere = {
      AND: [balanceAllocationPeriodWhere, this.financeEnterpriseCreditAllocationWhere()],
    } satisfies Prisma.BalanceConsumptionAllocationWhereInput;
    const enterpriseCreditSettlementWhere = {
      occurredAt: { gte: start, lt: end },
      debtSource: {
        in: [
          BALANCE_ALLOCATION_SOURCE_ENTERPRISE_CREDIT,
          BALANCE_ALLOCATION_SOURCE_NEGATIVE_BALANCE,
        ],
      },
      allocation: {
        ...this.withFinanceBalanceAllocationBillingMode({}, billingMode),
      },
    } satisfies Prisma.EnterpriseCreditSettlementWhereInput;

    // Keep each batch below the default Prisma pool limit. At production-scale
    // cardinalities these queries retain their connections long enough that one
    // 26-way Promise.all can starve its own later queries and the runtime workers.
    const [
      openingBalance,
      closingBalance,
      balanceRecharge,
      balanceConsume,
    ] = await this.measureFinanceOverviewStage('balance_totals', monthKey, billingMode, () => Promise.all([
      db.balanceTransaction.aggregate({
        where: this.withFinanceBalanceTransactionBillingMode({ createdAt: { lt: start } }, billingMode),
        _sum: { amountUsd: true },
      }),
      db.balanceTransaction.aggregate({
        where: this.withFinanceBalanceTransactionBillingMode({ createdAt: { lt: end } }, billingMode),
        _sum: { amountUsd: true },
      }),
      db.balanceTransaction.aggregate({
        where: this.withFinanceBalanceTransactionBillingMode({ type: TransactionType.RECHARGE, createdAt: { gte: start, lt: end } }, billingMode),
        _sum: { amountUsd: true },
      }),
      db.balanceTransaction.aggregate({
        where: this.withFinanceBalanceTransactionBillingMode({ type: TransactionType.CONSUME, createdAt: { gte: start, lt: end } }, billingMode),
        _sum: { amountUsd: true },
      }),
    ]));
    const [
      balanceRefund,
      balanceAdjust,
      paidOrders,
      refundedOrders,
    ] = await this.measureFinanceOverviewStage('orders_and_adjustments', monthKey, billingMode, () => Promise.all([
      db.balanceTransaction.aggregate({
        where: this.withFinanceBalanceTransactionBillingMode({ type: TransactionType.REFUND, createdAt: { gte: start, lt: end } }, billingMode),
        _sum: { amountUsd: true },
      }),
      db.balanceTransaction.aggregate({
        where: this.withFinanceBalanceTransactionBillingMode({ type: TransactionType.ADJUST, createdAt: { gte: start, lt: end } }, billingMode),
        _sum: { amountUsd: true },
      }),
      db.order.aggregate({
        where: {
          AND: [
            this.financeOrderBillingModeWhere(billingMode),
          ],
          paidAt: { gte: start, lt: end },
          status: { in: [OrderStatus.PAID, OrderStatus.FULFILLING, OrderStatus.COMPLETED] },
        },
        _sum: { amountCents: true },
        _count: { id: true },
      }),
      db.order.aggregate({
        where: {
          AND: [
            this.financeOrderBillingModeWhere(billingMode),
          ],
          refundedAt: { gte: start, lt: end },
          status: {
            in: [
              OrderStatus.REFUNDING,
              OrderStatus.REFUNDED,
              OrderStatus.REFUND_FAILED,
              OrderStatus.REFUND_COMPENSATION_FAILED,
            ],
          },
        },
        _sum: { refundAmountCents: true },
        _count: { id: true },
      }),
    ]));
    const [
      creditGranted,
      creditBonus,
      creditConsumed,
      tokenUsageTotals,
    ] = await this.measureFinanceOverviewStage('credits_and_usage', monthKey, billingMode, () => Promise.all([
      db.creditTransaction.aggregate({
        where: this.withFinanceProductBillingMode({ type: CreditTxType.QUOTA_GRANT, createdAt: { gte: start, lt: end } }, billingMode),
        _sum: { creditsAmount: true },
      }),
      db.creditTransaction.aggregate({
        where: this.withFinanceProductBillingMode({ type: CreditTxType.BONUS_PURCHASE, createdAt: { gte: start, lt: end } }, billingMode),
        _sum: { creditsAmount: true },
      }),
      db.creditTransaction.aggregate({
        where: this.withFinanceProductBillingMode({ type: CreditTxType.CONSUME, createdAt: { gte: start, lt: end } }, billingMode),
        _sum: { creditsAmount: true },
      }),
      db.tokenUsage.aggregate({
        where: tokenUsagePeriodWhere,
        _sum: {
          promptTokens: true,
          cachedInputTokens: true,
          cacheWriteInputTokens: true,
          completionTokens: true,
          totalTokens: true,
          customerChargeUsd: true,
          costUsd: true,
        },
        _count: { id: true },
      }),
    ]));
    const [
      orderReportCount,
      paymentReportCount,
      balanceTransactionCount,
      creditTransactionCount,
    ] = await this.measureFinanceOverviewStage('primary_counts', monthKey, billingMode, () => Promise.all([
      db.order.count({ where: orderReportWhere }),
      db.order.count({ where: paymentReportWhere }),
      db.balanceTransaction.count({ where: balancePeriodWhere }),
      db.creditTransaction.count({ where: creditPeriodWhere }),
    ]));
    const [
      balanceGrantCount,
      balanceAllocationCount,
      pureGiftGrantCount,
    ] = await this.measureFinanceOverviewStage('grant_counts', monthKey, billingMode, () => Promise.all([
      db.balanceGrant.count({ where: balanceGrantWhere }),
      db.balanceConsumptionAllocation.count({
        where: balanceAllocationPeriodWhere,
      }),
      db.balanceGrant.count({ where: pureGiftGrantWhere }),
    ]));
    const apiUsageCount = tokenUsageTotals._count.id;
    const [
      buyGiftGrantCount,
      pureGiftAllocationCount,
      buyGiftAllocationCount,
      enterpriseCreditAllocationCount,
    ] = await this.measureFinanceOverviewStage('category_counts', monthKey, billingMode, () => Promise.all([
      db.balanceGrant.count({ where: buyGiftGrantWhere }),
      db.balanceConsumptionAllocation.count({ where: pureGiftAllocationWhere }),
      db.balanceConsumptionAllocation.count({ where: buyGiftAllocationWhere }),
      db.balanceConsumptionAllocation.count({ where: enterpriseCreditAllocationWhere }),
    ]));
    const enterpriseCreditSettlementCount = await this.measureFinanceOverviewStage(
      'enterprise_settlement_count',
      monthKey,
      billingMode,
      () => db.enterpriseCreditSettlement.count({ where: enterpriseCreditSettlementWhere }),
    );

    const tokenPlanRevenueSummary: FinanceTokenPlanSummaryRow[] = [];
    if (revenueRecognitionMode) {
      await this.measureFinanceOverviewStage(
        'token_plan_revenue',
        monthKey,
        billingMode,
        () => this.processTokenPlanRevenueSummary({
          monthKey,
          start,
          end,
          billingMode: revenueRecognitionMode,
          workDirectoryPrefix: join(tmpdir(), 'finance-revenue-overview-'),
        }, async (rows) => {
          tokenPlanRevenueSummary.push(...rows);
        }, db),
      );
    }
    const tokenPlanRevenueRecognition = {
      summary: tokenPlanRevenueSummary,
      details: [] as FinanceTokenPlanLine[],
      notes: revenueRecognitionMode ? this.getRevenueRecognitionNotes(revenueRecognitionMode) : [],
    };
    const orderRevenueCents = paidOrders._sum.amountCents ?? 0;
    const tokenPlanRecognizedRevenueCents = tokenPlanRevenueRecognition.summary.reduce(
      (sum, row) => sum + row.recognizedRevenueCents,
      0,
    );
    const tokenPlanClosingDeferredCents = tokenPlanRevenueRecognition.summary.reduce(
      (sum, row) => sum + row.closingDeferredCents,
      0,
    );
    const supplierCostCents = null;
    const paymentFeeCents = null;

    return {
      period: {
        month: monthKey,
        startDate: start.toISOString(),
        endDate: end.toISOString(),
      },
      metrics: {
        orderCount: paidOrders._count.id,
        refundedOrderCount: refundedOrders._count.id,
        tokenUsageCount: tokenUsageTotals._count.id,
        orderRevenueCents,
        rechargeCents: usdToCents(balanceRecharge._sum?.amountUsd ?? 0),
        balanceConsumeCents: Math.abs(usdToCents(balanceConsume._sum?.amountUsd ?? 0)),
        refundCents: Math.abs(usdToCents(balanceRefund._sum?.amountUsd ?? 0) + (refundedOrders._sum.refundAmountCents ?? 0)),
        apiChargeCents: usdToCents(tokenUsageTotals._sum.customerChargeUsd ?? tokenUsageTotals._sum.costUsd ?? 0),
        tokenPlanRecognizedRevenueCents,
        tokenPlanClosingDeferredCents,
        cacheReadInputTokens: tokenUsageTotals._sum.cachedInputTokens ?? 0,
        cacheWriteInputTokens: tokenUsageTotals._sum.cacheWriteInputTokens ?? 0,
        totalTokens: tokenUsageTotals._sum.totalTokens ?? 0,
      },
      monthlySummary: [
        {
          period: monthKey,
          product: '全部产品',
          billingMode: billingMode ?? 'MIXED',
          currency: platformCurrencyCode,
          openingBalanceCents: usdToCents(openingBalance._sum?.amountUsd ?? 0),
          rechargeCents: usdToCents(balanceRecharge._sum?.amountUsd ?? 0),
          balanceConsumeCents: Math.abs(usdToCents(balanceConsume._sum?.amountUsd ?? 0)),
          refundCents: Math.abs(usdToCents(balanceRefund._sum?.amountUsd ?? 0) + (refundedOrders._sum.refundAmountCents ?? 0)),
          adjustCents: usdToCents(balanceAdjust._sum?.amountUsd ?? 0),
          closingBalanceCents: usdToCents(closingBalance._sum?.amountUsd ?? 0),
          orderRevenueCents,
          quotaGrantedCredits: creditGranted._sum?.creditsAmount ?? 0,
          bonusGrantedCredits: creditBonus._sum?.creditsAmount ?? 0,
          creditConsumed: Math.abs(creditConsumed._sum?.creditsAmount ?? 0),
          apiInputTokens: tokenUsageTotals._sum.promptTokens ?? 0,
          apiCacheReadInputTokens: tokenUsageTotals._sum.cachedInputTokens ?? 0,
          apiCacheWriteInputTokens: tokenUsageTotals._sum.cacheWriteInputTokens ?? 0,
          apiOutputTokens: tokenUsageTotals._sum.completionTokens ?? 0,
          apiTotalTokens: tokenUsageTotals._sum.totalTokens ?? 0,
          supplierCostCents,
          paymentFeeCents,
          grossProfitCents: supplierCostCents == null || paymentFeeCents == null ? null : orderRevenueCents - supplierCostCents - paymentFeeCents,
          grossMargin: null,
          invoiceableCents: orderRevenueCents - (refundedOrders._sum.refundAmountCents ?? 0),
          invoicedCents: null,
          settlementStatus: '有数据缺口',
          varianceCheck: '余额可滚动校验；供应商成本/渠道手续费/发票字段待接入',
          notes: '按月聚合，明细按 Tab 分页加载。',
        },
      ],
      tokenPlanRevenueRecognition: {
        summary: tokenPlanRevenueRecognition.summary,
        details: [],
        notes: tokenPlanRevenueRecognition.notes,
      },
      financeTemplates: {
        pureGift: {
          accountChangeDetails: [],
          consumptionDetails: [],
          consumptionSummary: [],
        },
        buyGift: {
          accountChangeDetails: [],
          accountChangeSummary: [],
          consumptionDetails: [],
          consumptionSummary: [],
          paymentDetails: [],
          paymentSummary: [],
        },
        notes: this.getFinanceTemplateNotes(),
      },
      supplierCosts: this.getFinanceSupplierCosts(),
      fieldGaps: this.getFinanceReportFieldGaps(),
      detailCounts: {
        summary: 1,
        orders: orderReportCount,
        payments: paymentReportCount,
        balance: balanceTransactionCount,
        balanceGrants: balanceGrantCount,
        balanceAllocations: balanceAllocationCount,
        credits: creditTransactionCount,
        apiUsage: apiUsageCount,
        pureGiftAccountChanges: pureGiftGrantCount,
        pureGiftConsumptionDetails: pureGiftAllocationCount,
        pureGiftConsumptionSummary: null,
        buyGiftAccountChanges: buyGiftGrantCount,
        buyGiftAccountSummary: null,
        buyGiftConsumptionDetails: buyGiftAllocationCount,
        buyGiftConsumptionSummary: null,
        buyGiftPaymentDetails: buyGiftGrantCount,
        buyGiftPaymentSummary: null,
        enterpriseCreditConsumptionDetails: enterpriseCreditAllocationCount,
        enterpriseCreditConsumptionSummary: null,
        enterpriseCreditSettlement: enterpriseCreditSettlementCount,
        tokenPlanRevenueSummary: tokenPlanRevenueRecognition.summary.length,
        tokenPlanRevenueDetails: tokenPlanRevenueRecognition.summary.reduce(
          (sum, row) => sum + row.lineCount,
          0,
        ),
        tokenPlanRevenueNotes: tokenPlanRevenueRecognition.notes.length,
        templateNotes: this.getFinanceTemplateNotes().length,
        supplier: this.getFinanceSupplierCosts().requiredFields.length,
        gaps: this.getFinanceReportFieldGaps().length,
      },
      rowLimits: {
        maxRowsPerDetail: FINANCE_REPORT_DETAIL_MAX_PAGE_SIZE,
        note: '详情表按 Tab 分页加载；导出应走后台任务，避免一次性拉取全账期明细。',
      },
    };
  }

  private async measureFinanceOverviewStage<T>(
    stage: string,
    month: string,
    billingMode: FinanceReportBillingMode | undefined,
    operation: () => Promise<T>,
  ): Promise<T> {
    const startedAt = Date.now();
    try {
      const result = await operation();
      this.logger.log(
        `finance overview stage completed stage=${stage} month=${month} billingMode=${billingMode ?? 'ALL'} durationMs=${Date.now() - startedAt}`,
      );
      return result;
    } catch (error) {
      const errorName = error instanceof Error ? error.name : typeof error;
      const errorCode = error && typeof error === 'object' && 'code' in error
        ? String(error.code)
        : 'unknown';
      this.logger.error(
        `finance overview stage failed stage=${stage} month=${month} billingMode=${billingMode ?? 'ALL'} durationMs=${Date.now() - startedAt} errorName=${errorName} errorCode=${errorCode}`,
      );
      throw error;
    }
  }

  async getFinanceReportDetail(
    params: FinanceReportDetailParams,
    maxPageSize = FINANCE_REPORT_DETAIL_MAX_PAGE_SIZE,
    existingSnapshot?: FinanceReportReadSnapshot,
  ) {
    const requestedTab = this.resolveFinanceReportDetailTab(params.tab);
    const normalizedPageSize = this.normalizeFinanceReportPageSize(params.pageSize, maxPageSize);
    const filter = await this.resolveFinanceUserSearchFilter(this.resolveFinanceReportFilter(
      requestedTab,
      params.filterField,
      params.filterValue,
    ));
    const resolvedParams: ResolvedFinanceReportDetailParams = {
      ...params,
      pageSize: normalizedPageSize,
      filter,
    };
    if (FINANCE_BALANCE_LEDGER_REPORT_TABS.has(requestedTab)) {
      if (existingSnapshot) {
        return this.getBalanceLedgerFinanceReportDetail(
          resolvedParams,
          requestedTab,
          existingSnapshot,
        );
      }
      return this.withFinanceReportReadSnapshot(
        (snapshot) => this.getBalanceLedgerFinanceReportDetail(
          resolvedParams,
          requestedTab,
          snapshot,
        ),
        FINANCE_REPORT_SUMMARY_TABS.has(requestedTab)
          ? FINANCE_REPORT_SUMMARY_SNAPSHOT_TIMEOUT_MS
          : FINANCE_REPORT_SNAPSHOT_TIMEOUT_MS,
      );
    }

    const db: FinanceReadClient = existingSnapshot?.db ?? this.prisma;

    const monthRange = this.resolveMonthRange(params.month);
    const monthKey = monthRange.monthKey;
    const start = monthRange.start;
    const end = params.cutoffExclusive
      ? new Date(Math.min(monthRange.end.getTime(), params.cutoffExclusive.getTime()))
      : monthRange.end;
    const tab = requestedTab;
    const billingMode = this.resolveFinanceReportBillingMode(params.billingMode);
    const pageSize = resolvedParams.pageSize;
    const scopeHash = this.buildFinanceReportScopeHash({
      month: monthKey,
      tab,
      billingMode,
      pageSize,
      filter,
    });
    const cursor = this.decodeFinanceReportCursor(params.cursor, scopeHash);
    const period = {
      month: monthKey,
      startDate: start.toISOString(),
      endDate: end.toISOString(),
    };

    if (tab === 'summary') {
      const overview = await this.getFinanceReportOverview(monthKey, billingMode, db);
      return this.financeStaticDetailPage(
        period,
        tab,
        overview.monthlySummary,
        pageSize,
        cursor,
        scopeHash,
      );
    }
    if (tab === 'supplier') {
      const rows = this.getFinanceSupplierCosts().requiredFields.map((field, index) => ({
        id: String(index),
        field,
        status: '需接入',
        action: '建立供应商账单导入表，并保留原始账单文件与供应商账单号',
      }));
      return this.financeStaticDetailPage(period, tab, rows, pageSize, cursor, scopeHash);
    }
    if (tab === 'gaps') {
      return this.financeStaticDetailPage(
        period,
        tab,
        this.getFinanceReportFieldGaps(),
        pageSize,
        cursor,
        scopeHash,
      );
    }
    if (tab === 'templateNotes') {
      return this.financeStaticDetailPage(
        period,
        tab,
        this.getFinanceTemplateNotes(),
        pageSize,
        cursor,
        scopeHash,
      );
    }

    if (tab === 'tokenPlanRevenueSummary' || tab === 'tokenPlanRevenueDetails' || tab === 'tokenPlanRevenueNotes') {
      const revenueRecognitionMode = this.resolveFinanceRevenueRecognitionMode(billingMode);
      if (!revenueRecognitionMode) {
        return this.financeStaticDetailPage(period, tab, [], pageSize, cursor, scopeHash);
      }
      const tokenPlanOrders = await db.order.findMany({
        where: {
          AND: [
            this.financeTokenPlanOrderWhere(start, end, revenueRecognitionMode),
            this.financeOrderFilterWhere(filter),
          ],
        },
        orderBy: { createdAt: 'desc' },
        include: this.financeTokenPlanOrderInclude(),
      });
      await this.enrichFinanceRowsWithAuthoritativeContacts(tokenPlanOrders);
      const tokenPlanRevenueRecognition = await this.buildTokenPlanRevenueRecognition({
        monthKey,
        start,
        end,
        billingMode: revenueRecognitionMode,
        orders: tokenPlanOrders,
      }, db);
      const filteredTokenPlanDetails = tokenPlanRevenueRecognition.details.filter((row) => (
        this.financeTokenPlanLineMatchesFilter(row, filter)
      ));
      const rows = tab === 'tokenPlanRevenueSummary'
        ? this.summarizeTokenPlanRevenue(filteredTokenPlanDetails)
        : tab === 'tokenPlanRevenueDetails'
          ? filteredTokenPlanDetails
          : tokenPlanRevenueRecognition.notes;
      return this.financeStaticDetailPage(period, tab, rows, pageSize, cursor, scopeHash);
    }

    const region = await this.getFinanceReportRegion(db);

    if (tab === 'orders' || tab === 'payments') {
      const { rows, pageRows, hasMore } = await this.fetchFinanceOrderPage(
        {
          AND: [
            tab === 'payments'
              ? this.financePaymentReportWhere(start, end, billingMode)
              : this.financeOrderReportWhere(start, end, billingMode),
            this.financeOrderFilterWhere(filter),
          ],
        },
        pageSize,
        cursor,
        tab === 'payments',
        db,
      );
      const platformCurrencyCode = await this.getPlatformCurrencyCode(db);
      const items = tab === 'payments'
        ? this.mapFinancePaymentRows(monthKey, pageRows, platformCurrencyCode)
        : this.mapFinanceOrderRows(monthKey, pageRows, platformCurrencyCode, region);
      return this.financeCursorDetailPage(
        period,
        tab,
        items,
        pageSize,
        hasMore,
        rows,
        scopeHash,
      );
    }

    if (tab === 'balance') {
      const rows = await db.balanceTransaction.findMany({
        where: {
          AND: [
            this.withFinanceBalanceTransactionBillingMode(
              { createdAt: { gte: start, lt: end } },
              billingMode,
            ),
            this.financeBalanceTransactionFilterWhere(filter),
            this.financeCreatedAtCursorWhere(cursor),
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: pageSize + 1,
        include: {
          user: { select: { id: true, email: true, phone: true, nickname: true } },
          billingAccount: { select: FINANCE_ACCOUNT_LABEL_SELECT },
          tenant: { select: { id: true, name: true, slug: true, type: true, billingAccount: { select: FINANCE_ACCOUNT_LABEL_SELECT } } },
          product: { select: { id: true, name: true, slug: true, billingMode: true } },
          attribution: { select: { balanceGrantId: true, billingMode: true, source: true } },
        },
      });
      const pageRows = rows.slice(0, pageSize);
      await this.enrichFinanceRowsWithAuthoritativeContacts(pageRows);
      return this.financeCursorDetailPage(
        period,
        tab,
        this.mapFinanceBalanceRows(monthKey, pageRows, region),
        pageSize,
        rows.length > pageSize,
        rows,
        scopeHash,
      );
    }

    if (tab === 'credits') {
      const rows = await db.creditTransaction.findMany({
        where: {
          AND: [
            this.withFinanceProductBillingMode({ createdAt: { gte: start, lt: end } }, billingMode),
            this.financeCreditTransactionFilterWhere(filter),
            this.financeCreatedAtCursorWhere(cursor),
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: pageSize + 1,
        include: {
          user: { select: { id: true, email: true, phone: true, nickname: true } },
          tenant: { select: { id: true, name: true, slug: true, type: true, billingAccount: { select: FINANCE_ACCOUNT_LABEL_SELECT } } },
          product: { select: { id: true, name: true, slug: true, billingMode: true } },
        },
      });
      const pageRows = rows.slice(0, pageSize);
      await this.enrichFinanceRowsWithAuthoritativeContacts(pageRows);
      const subscriptionMap = await this.getSubscriptionMap(
        pageRows.map((tx) => tx.subscriptionId).filter((id): id is string => Boolean(id)),
        db,
      );
      return this.financeCursorDetailPage(
        period,
        tab,
        this.mapFinanceCreditRows(monthKey, pageRows, subscriptionMap, region),
        pageSize,
        rows.length > pageSize,
        rows,
        scopeHash,
      );
    }

    if (tab === 'apiUsage') {
      const page = await this.loadFinanceApiUsageVisiblePage({
        monthKey,
        start,
        end,
        billingMode,
        filter,
        cursor,
        pageSize,
        scopeHash,
        region,
        db,
      });
      return this.financeExplicitCursorDetailPage(
        period,
        tab,
        page.items,
        pageSize,
        page.nextCursor,
      );
    }

    if (tab === 'enterpriseCreditConsumptionSummary') {
      const rows = await this.buildEnterpriseCreditConsumptionSummary({
        monthKey,
        start,
        end,
        billingMode,
        filter,
        db,
      });
      return this.financeStaticDetailPage(period, tab, rows, pageSize, cursor, scopeHash);
    }

    if (tab === 'enterpriseCreditSettlement') {
      const rows = await db.enterpriseCreditSettlement.findMany({
        where: {
          AND: [
            {
              occurredAt: { gte: start, lt: end },
              debtSource: {
                in: [
                  BALANCE_ALLOCATION_SOURCE_ENTERPRISE_CREDIT,
                  BALANCE_ALLOCATION_SOURCE_NEGATIVE_BALANCE,
                ],
              },
              allocation: {
                ...this.withFinanceBalanceAllocationBillingMode({}, billingMode),
              },
            },
            this.financeEnterpriseCreditSettlementFilterWhere(filter),
            this.financeOccurredAtCursorWhere(cursor),
          ],
        },
        orderBy: [{ occurredAt: 'desc' }, { id: 'desc' }],
        take: pageSize + 1,
        include: {
          allocation: { include: this.financeBalanceAllocationInclude() },
          repaymentTransaction: { select: { id: true, description: true, createdAt: true } },
        },
      });
      const pageRows = rows.slice(0, pageSize);
      await this.enrichFinanceRowsWithAuthoritativeContacts(pageRows);
      return this.financeCursorDetailPage(
        period,
        tab,
        this.mapFinanceEnterpriseCreditSettlementRows(monthKey, pageRows as FinanceEnterpriseCreditSettlementRow[]),
        pageSize,
        rows.length > pageSize,
        rows.map((row) => ({ ...row, createdAt: row.occurredAt })),
        scopeHash,
      );
    }

    if (tab === 'enterpriseCreditConsumptionDetails') {
      const rows = await db.balanceConsumptionAllocation.findMany({
        where: {
          AND: [
            this.withFinanceBalanceAllocationBillingMode(
              { createdAt: { gte: start, lt: end } },
              billingMode,
            ),
            this.financeEnterpriseCreditAllocationWhere(),
            this.financeAllocationFilterWhere(filter),
            this.financeCreatedAtCursorWhere(cursor),
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: pageSize + 1,
        include: this.financeBalanceAllocationInclude(),
      });
      const pageRows = rows.slice(0, pageSize);
      await this.enrichFinanceRowsWithAuthoritativeContacts(pageRows);
      return this.financeCursorDetailPage(
        period,
        tab,
        this.mapFinanceEnterpriseCreditConsumptionRows(monthKey, pageRows as FinanceAllocationRow[], region),
        pageSize,
        rows.length > pageSize,
        rows,
        scopeHash,
      );
    }

    return this.financeStaticDetailPage(period, tab, [], pageSize, cursor, scopeHash);
  }

  private async withFinanceReportReadSnapshot<T>(
    operation: (snapshot: FinanceReportReadSnapshot) => Promise<T>,
    timeout: number,
  ): Promise<T> {
    return this.prisma.$transaction(async (db) => {
      await db.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const statementTimeoutMs = Math.max(1, timeout - 1_000);
      await db.$queryRaw(Prisma.sql`
        SELECT set_config('statement_timeout', ${String(statementTimeoutMs)}, true)
      `);
      const [clock] = await db.$queryRaw<Array<{ asOf: Date }>>(Prisma.sql`
        SELECT
          (transaction_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "asOf"
      `);
      if (!(clock?.asOf instanceof Date) || Number.isNaN(clock.asOf.getTime())) {
        throw new Error('BALANCE_FINANCIAL_CLOCK_UNAVAILABLE:finance_report_snapshot');
      }
      return operation({
        db,
        asOf: clock.asOf,
        validatedConsumptionGrantIds: new Set<string>(),
      });
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 5_000,
      timeout,
    });
  }

  private async withFinanceReportExportSnapshot<T>(
    operation: (snapshot: FinanceReportReadSnapshot) => Promise<T>,
    timeout: number,
  ): Promise<T> {
    const transactionOptions = {
      isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead,
      maxWait: 5_000,
      timeout,
    } as const;
    return this.prisma.$transaction(async (coordinator) => {
      await coordinator.$executeRawUnsafe('SET TRANSACTION READ ONLY');
      const statementTimeoutMs = Math.max(1, timeout - 1_000);
      await coordinator.$queryRaw(Prisma.sql`
        SELECT set_config('statement_timeout', ${String(statementTimeoutMs)}, true)
      `);
      const [clock] = await coordinator.$queryRaw<Array<{ asOf: Date }>>(Prisma.sql`
        SELECT
          (transaction_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3) AS "asOf"
      `);
      const [exported] = await coordinator.$queryRaw<Array<{ snapshotId: string }>>(Prisma.sql`
        SELECT pg_export_snapshot() AS "snapshotId"
      `);
      if (!(clock?.asOf instanceof Date) || Number.isNaN(clock.asOf.getTime())) {
        throw new Error('BALANCE_FINANCIAL_CLOCK_UNAVAILABLE:finance_report_export_snapshot');
      }
      const snapshotId = exported?.snapshotId;
      if (!snapshotId || !/^[0-9A-F-]+$/iu.test(snapshotId)) {
        throw new Error('BALANCE_FINANCIAL_SNAPSHOT_UNAVAILABLE:finance_report_export');
      }

      // PostgreSQL forbids CREATE TEMP TABLE in a READ ONLY transaction. Keep
      // the coordinator read-only and import its exact snapshot into a second
      // transaction whose only writes are ON COMMIT DROP temporary tables used
      // for bounded-memory aggregation. All business-table reads therefore see
      // the same immutable snapshot while no persistent row is mutated.
      return this.prisma.$transaction(async (db) => {
        await db.$executeRawUnsafe(`SET TRANSACTION SNAPSHOT '${snapshotId}'`);
        await db.$queryRaw(Prisma.sql`
          SELECT set_config('statement_timeout', ${String(statementTimeoutMs)}, true)
        `);
        return operation({
          db,
          asOf: clock.asOf,
          validatedConsumptionGrantIds: new Set<string>(),
        });
      }, transactionOptions);
    }, transactionOptions);
  }

  private createFinanceExportReadContext(asOf: Date): FinanceReportReadSnapshot {
    // A multi-minute export must not hold a Prisma interactive transaction open.
    // The job-level database timestamp remains frozen and every page uses stable
    // keyset cursors plus that same cutoff, while each query releases its
    // connection back to the pool as soon as the page has been read.
    return {
      db: this.prisma,
      asOf: new Date(asOf.getTime()),
      validatedConsumptionGrantIds: new Set<string>(),
    };
  }

  private async getBalanceLedgerFinanceReportDetail(
    params: ResolvedFinanceReportDetailParams,
    tab: FinanceReportDetailTab,
    snapshot: FinanceReportReadSnapshot,
  ) {
    const { monthKey, start, end } = this.resolveMonthRange(params.month, snapshot.asOf);
    const effectiveEnd = new Date(Math.min(end.getTime(), snapshot.asOf.getTime()));
    const billingMode = this.resolveFinanceReportBillingMode(params.billingMode);
    const pageSize = params.pageSize;
    const filter = params.filter;
    const scopeHash = this.buildFinanceReportScopeHash({
      month: monthKey,
      tab,
      billingMode,
      pageSize,
      filter,
    });
    const cursor = this.decodeFinanceReportCursor(params.cursor, scopeHash);
    const period = {
      month: monthKey,
      startDate: start.toISOString(),
      endDate: end.toISOString(),
      asOf: snapshot.asOf.toISOString(),
      cutoffExclusive: effectiveEnd.toISOString(),
      timezone: 'Asia/Shanghai',
    };
    if (effectiveEnd.getTime() <= start.getTime()) {
      return FINANCE_REPORT_SUMMARY_TABS.has(tab)
        ? this.financeStaticDetailPage(period, tab, [], pageSize, cursor, scopeHash)
        : this.financeCursorDetailPage(period, tab, [], pageSize, false, [], scopeHash);
    }

    if (tab === 'balanceGrants') {
      const grantPage = await this.loadFinanceBalanceGrantCursorPage({
        start,
        end: effectiveEnd,
        billingMode,
        tab,
        cursor,
        pageSize,
        filter,
      }, snapshot.db);
      return this.financeCursorDetailPage(
        period,
        tab,
        this.mapFinanceBalanceGrantRows(
          monthKey,
          grantPage.pageRows,
          await this.getFinanceReportRegion(snapshot.db),
        ),
        pageSize,
        grantPage.hasMore,
        grantPage.sourceRows,
        scopeHash,
      );
    }

    if (tab === 'balanceAllocations') {
      const sourceRows = await snapshot.db.balanceConsumptionAllocation.findMany({
        where: {
          AND: [
            this.withFinanceBalanceAllocationBillingMode(
              { createdAt: { gte: start, lt: effectiveEnd } },
              billingMode,
            ),
            this.financeAllocationFilterWhere(filter),
            this.financeCreatedAtCursorWhere(cursor),
          ],
        },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        take: pageSize + 1,
        include: this.financeBalanceAllocationInclude(),
      });
      const pageRows = sourceRows.slice(0, pageSize);
      await this.enrichFinanceRowsWithAuthoritativeContacts(pageRows);
      return this.financeCursorDetailPage(
        period,
        tab,
        this.mapFinanceBalanceAllocationRows(
          monthKey,
          pageRows as FinanceAllocationRow[],
          await this.getFinanceReportRegion(snapshot.db),
        ),
        pageSize,
        sourceRows.length > pageSize,
        sourceRows,
        scopeHash,
      );
    }

    if (tab === 'pureGiftConsumptionSummary' || tab === 'buyGiftConsumptionSummary') {
      const rows = await this.collectFinanceConsumptionSummaryRows({
        month: monthKey,
        tab,
        billingMode,
        start,
        end: effectiveEnd,
        filter,
      }, snapshot.db, snapshot.validatedConsumptionGrantIds);
      return this.financeStaticDetailPage(period, tab, rows, pageSize, cursor, scopeHash);
    }

    if (tab === 'buyGiftAccountSummary' || tab === 'buyGiftPaymentSummary') {
      const rows = await this.collectFinanceUserCurrencySummaryRows({
        month: monthKey,
        tab,
        billingMode,
        start,
        end: effectiveEnd,
        asOf: snapshot.asOf,
        platformCurrencyCode: await this.getPlatformCurrencyCode(snapshot.db),
        filter,
      }, snapshot.db);
      return this.financeStaticDetailPage(period, tab, rows, pageSize, cursor, scopeHash);
    }

    if (
      tab === 'pureGiftAccountChanges'
      || tab === 'buyGiftAccountChanges'
      || tab === 'buyGiftPaymentDetails'
    ) {
      const grantPage = await this.loadFinanceBalanceGrantCursorPage({
        start,
        end: effectiveEnd,
        billingMode,
        tab,
        cursor,
        pageSize,
        filter,
      }, snapshot.db);
      const templates = await this.buildFinanceTemplatesForGrants(
        monthKey,
        start,
        effectiveEnd,
        grantPage.pageRows,
        snapshot.db,
        snapshot.asOf,
        await this.getPlatformCurrencyCode(snapshot.db),
      );
      const items = tab === 'pureGiftAccountChanges'
        ? templates.pureGift.accountChangeDetails
        : tab === 'buyGiftAccountChanges'
          ? templates.buyGift.accountChangeDetails
          : templates.buyGift.paymentDetails;
      return this.financeCursorDetailPage(
        period,
        tab,
        items,
        pageSize,
        grantPage.hasMore,
        grantPage.sourceRows,
        scopeHash,
      );
    }

    if (tab === 'pureGiftConsumptionDetails' || tab === 'buyGiftConsumptionDetails') {
      const page = await this.loadFinanceGiftConsumptionPage({
        monthKey,
        start,
        end: effectiveEnd,
        billingMode,
        tab,
        cursor,
        pageSize,
        filter,
        scopeHash,
      }, snapshot.db, snapshot.validatedConsumptionGrantIds);
      return this.financeExplicitCursorDetailPage(
        period,
        tab,
        page.items,
        pageSize,
        page.nextCursor,
      );
    }

    return this.financeStaticDetailPage(period, tab, [], pageSize, cursor, scopeHash);
  }

  private async loadFinanceGiftConsumptionPage(
    params: {
      monthKey: string;
      start: Date;
      end: Date;
      billingMode?: FinanceReportBillingMode;
      tab: 'pureGiftConsumptionDetails' | 'buyGiftConsumptionDetails';
      cursor: FinanceReportCursor | null;
      pageSize: number;
      projection?: 'detail' | 'summary';
      filter?: FinanceReportFilter | null;
      scopeHash?: string;
    },
    db: FinanceReadClient,
    validatedGrantIds?: Set<string>,
  ): Promise<{
    sourceRows: Array<{ id: string; createdAt: Date }>;
    pageRows: FinanceAllocationRow[];
    items: Record<string, unknown>[];
    hasMore: boolean;
    nextCursor: string | null;
  }> {
    const resumePartOffset = params.projection === 'summary'
      ? 0
      : this.financeCursorPartOffset(params.cursor);
    const sourceRows = await db.balanceConsumptionAllocation.findMany({
      where: {
        AND: [
          this.withFinanceBalanceAllocationBillingMode(
            { createdAt: { gte: params.start, lt: params.end } },
            params.billingMode,
          ),
          this.financeAllocationCategoryWhere(params.tab),
          this.financeAllocationFilterWhere(params.filter ?? null),
          this.financeCreatedAtCursorWhere(params.cursor, resumePartOffset > 0),
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: params.pageSize + 1,
      include: this.financeGiftConsumptionAllocationInclude(),
    });
    const pageRows = sourceRows.slice(0, params.pageSize) as unknown as FinanceAllocationRow[];
    await this.enrichFinanceRowsWithAuthoritativeContacts(pageRows);
    const grants = pageRows.flatMap((allocation) => (
      allocation.balanceGrant ? [allocation.balanceGrant] : []
    ));
    const grantMap = new Map(grants.map((grant) => [grant.id, grant]));
    const provenEnterpriseAbsorbAllocationIds = await this.loadProvenEnterpriseAbsorbAllocationIds(
      pageRows,
      grantMap,
      db,
    );
    this.assertFinanceConsumptionAllocationFacts(
      params.tab,
      pageRows,
      provenEnterpriseAbsorbAllocationIds,
    );
    await this.assertFinanceConsumptionAllocationBudgets(
      grants,
      db,
      validatedGrantIds,
    );
    const region = await this.getFinanceReportRegion(db);

    if (params.projection === 'summary') {
      return {
        sourceRows,
        pageRows,
        items: pageRows.map((allocation) => (
          this.buildFinanceConsumptionSummaryFactRow(params.tab, allocation, region)
        )),
        hasMore: sourceRows.length > params.pageSize,
        nextCursor: sourceRows.length > params.pageSize
          ? this.encodeFinanceReportRowCursor(
            pageRows.at(-1),
            params.scopeHash ?? 'internal-consumption-summary',
          )
          : null,
      };
    }

    const standardPriceMap = params.tab === 'buyGiftConsumptionDetails'
      ? await this.loadFinanceStandardPriceMap(pageRows, db)
      : new Map<string, FinanceStandardPrice>();
    const items: Record<string, unknown>[] = [];
    let nextCursor: string | null = null;
    for (let allocationIndex = 0; allocationIndex < pageRows.length; allocationIndex += 1) {
      const allocation = pageRows[allocationIndex];
      const expandedRows = params.tab === 'pureGiftConsumptionDetails'
        ? this.buildPureGiftConsumptionRows(params.monthKey, allocation, region)
        : this.buildBuyGiftConsumptionRows(params.monthKey, allocation, standardPriceMap, region);
      const offset = allocationIndex === 0 ? resumePartOffset : 0;
      if (offset >= expandedRows.length) {
        throw new BadRequestException('无效的财务报表分页游标');
      }
      const availableRows = expandedRows.slice(offset);
      const remainingSlots = params.pageSize - items.length;
      items.push(...availableRows.slice(0, remainingSlots));
      const consumedFromAllocation = Math.min(availableRows.length, remainingSlots);
      if (items.length >= params.pageSize) {
        const nextPartOffset = offset + consumedFromAllocation;
        if (nextPartOffset < expandedRows.length) {
          nextCursor = this.encodeFinanceReportRowCursor(
            allocation,
            params.scopeHash ?? 'internal-consumption-detail',
            nextPartOffset,
          );
        } else if (allocationIndex + 1 < sourceRows.length) {
          nextCursor = this.encodeFinanceReportRowCursor(
            allocation,
            params.scopeHash ?? 'internal-consumption-detail',
          );
        }
        break;
      }
    }

    return {
      sourceRows,
      pageRows,
      items,
      hasMore: nextCursor !== null,
      nextCursor,
    };
  }

  private async loadFinanceApiUsageVisiblePage(params: {
    monthKey: string;
    start: Date;
    end: Date;
    billingMode?: FinanceReportBillingMode;
    filter: FinanceReportFilter | null;
    cursor: FinanceReportCursor | null;
    pageSize: number;
    scopeHash: string;
    region?: PlatformRegion;
    db?: FinanceReadClient;
  }): Promise<{
    items: Record<string, unknown>[];
    nextCursor: string | null;
  }> {
    const resumePartOffset = this.financeCursorPartOffset(params.cursor);
    const db = params.db ?? this.prisma;
    const sourceRows = await db.tokenUsage.findMany({
      where: {
        AND: [
          this.withFinanceProductBillingMode(
            { createdAt: { gte: params.start, lt: params.end } },
            params.billingMode,
          ),
          this.financeVisibleTokenUsageWhere(),
          this.financeTokenUsageFilterWhere(params.filter),
          this.financeCreatedAtCursorWhere(params.cursor, resumePartOffset > 0),
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: params.pageSize + 1,
      include: {
        tenant: { select: { id: true, name: true, slug: true, type: true, billingAccount: { select: FINANCE_ACCOUNT_LABEL_SELECT } } },
        apiKey: {
          select: {
            id: true,
            prefix: true,
            userId: true,
            user: { select: { id: true, email: true, phone: true, nickname: true } },
          },
        },
        product: { select: { id: true, name: true, slug: true, billingMode: true } },
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
    });
    const pageRows = sourceRows.slice(0, params.pageSize);
    await this.enrichFinanceRowsWithAuthoritativeContacts(pageRows);
    const mappedRows = this.mapFinanceApiUsageRows(
      params.monthKey,
      pageRows,
      params.region,
    );
    const items: Record<string, unknown>[] = [];
    let nextCursor: string | null = null;
    for (let usageIndex = 0; usageIndex < pageRows.length; usageIndex += 1) {
      const usage = pageRows[usageIndex];
      const expandedRows = this.buildFinanceApiUsageTokenRows([mappedRows[usageIndex]]);
      if (expandedRows.length === 0) continue;
      const offset = usageIndex === 0 ? resumePartOffset : 0;
      if (offset >= expandedRows.length) {
        throw new BadRequestException('无效的财务报表分页游标');
      }
      const availableRows = expandedRows.slice(offset);
      const remainingSlots = params.pageSize - items.length;
      items.push(...availableRows.slice(0, remainingSlots));
      const consumedFromUsage = Math.min(availableRows.length, remainingSlots);
      if (items.length >= params.pageSize) {
        const nextPartOffset = offset + consumedFromUsage;
        if (nextPartOffset < expandedRows.length) {
          nextCursor = this.encodeFinanceReportRowCursor(
            usage,
            params.scopeHash,
            nextPartOffset,
          );
        } else if (usageIndex + 1 < sourceRows.length) {
          nextCursor = this.encodeFinanceReportRowCursor(usage, params.scopeHash);
        }
        break;
      }
    }
    return { items, nextCursor };
  }

  private buildFinanceConsumptionSummaryFactRow(
    tab: 'pureGiftConsumptionDetails' | 'buyGiftConsumptionDetails',
    allocation: FinanceAllocationRow,
    region?: PlatformRegion,
  ): Record<string, unknown> {
    const parts = this.getConsumptionTokenParts(allocation.tokenUsage);
    const allocatedTokens = this.getAllocatedTokens(allocation);
    const tokenUsage = parts.length === 0
      ? allocatedTokens
      : this.allocateTokenCounts(parts, allocatedTokens)
        .reduce((total, value) => total + value, 0);
    let consumeAmountUsd = usd(allocation.amountUsd);
    let consumeAmountPaidUsd = usd(allocation.recognizedRevenueUsd);
    let supplierCostUsd = this.getAllocatedSupplierCostEstimate(allocation);
    if (parts.length > 0) {
      const totalWeight = this.sumUsd(parts, (part) => part.weight);
      consumeAmountUsd = this.sumUsd(
        parts,
        (part) => this.allocateUsdByWeight(allocation.amountUsd, part.weight, totalWeight),
      );
      consumeAmountPaidUsd = this.sumUsd(
        parts,
        (part) => this.allocateUsdByWeight(
          allocation.recognizedRevenueUsd,
          part.weight,
          totalWeight,
        ),
      );
      const totalSupplierWeight = this.sumUsd(parts, (part) => part.supplierWeight);
      const supplierParts = parts.map((part) => this.allocateNullableUsdByWeight(
        supplierCostUsd,
        part.supplierWeight,
        totalSupplierWeight,
      ));
      supplierCostUsd = supplierParts.some((value) => value == null)
        ? null
        : this.sumUsd(supplierParts as Prisma.Decimal[], (value) => value);
    }
    const row = {
      userId: allocation.userId,
      userLabel: this.formatUserLabel(
        allocation.user ?? allocation.balanceGrant?.user,
        allocation.userId,
        this.financeRowAccount(allocation) ?? this.financeRowAccount(allocation.balanceGrant ?? {}),
        region,
      ),
      model: allocation.tokenUsage?.model ?? '',
      tokenUsage,
      actualSupplierChargeCents: null,
      estimatedSupplierChargeCents: this.usdToNullableCents(supplierCostUsd),
      ...(tab === 'buyGiftConsumptionDetails'
        ? {
          consumeAmountCents: usdToCents(consumeAmountUsd),
          consumeAmountPaidCents: usdToCents(consumeAmountPaidUsd),
        }
        : {}),
    };
    return this.withFinanceRawUsd(row, {
      estimatedSupplierChargeCents: supplierCostUsd,
      ...(tab === 'buyGiftConsumptionDetails'
        ? {
          consumeAmountCents: consumeAmountUsd,
          consumeAmountPaidCents: consumeAmountPaidUsd,
        }
        : {}),
    });
  }

  private financeGiftConsumptionAllocationInclude() {
    return {
      user: { select: { id: true, email: true, phone: true, nickname: true } },
      billingAccount: { select: FINANCE_ACCOUNT_LABEL_SELECT },
      tenant: { select: { id: true, billingAccount: { select: FINANCE_ACCOUNT_LABEL_SELECT } } },
      balanceGrant: {
        select: {
          id: true,
          userId: true,
          tenantId: true,
          billingAccountId: true,
          paidAmountUsd: true,
          bonusAmountUsd: true,
          grantedAmountUsd: true,
          validFrom: true,
          expiresAt: true,
          user: { select: { id: true, email: true, phone: true, nickname: true } },
          billingAccount: {
            select: {
              id: true,
              balanceGrantLedgerStatus: true,
              balanceGrantLedgerVersion: true,
              ...FINANCE_ACCOUNT_LABEL_SELECT,
            },
          },
        },
      },
      balanceTransaction: {
        select: {
          id: true,
          orderId: true,
          description: true,
          createdAt: true,
        },
      },
      tokenUsage: {
        select: {
          id: true,
          model: true,
          pricingTierKey: true,
          promptTokens: true,
          cachedInputTokens: true,
          cacheWriteInputTokens: true,
          completionTokens: true,
          totalTokens: true,
          inputPriceUsdPerM: true,
          cachedInputPriceUsdPerM: true,
          cacheWritePriceUsdPerM: true,
          outputPriceUsdPerM: true,
          costUsd: true,
          providerCostEstimateUsd: true,
          providerCostMultiplier: true,
          providerInputCostUsdPerM: true,
          providerCachedInputCostUsdPerM: true,
          providerCacheWriteCostUsdPerM: true,
          providerOutputCostUsdPerM: true,
          createdAt: true,
        },
      },
    };
  }

  private financeConsumptionGrantProofSelect() {
    return {
      id: true,
      userId: true,
      tenantId: true,
      billingAccountId: true,
      paidAmountUsd: true,
      bonusAmountUsd: true,
      grantedAmountUsd: true,
      validFrom: true,
      expiresAt: true,
      isExpired: true,
      createdAt: true,
      billingAccount: {
        select: {
          id: true,
          balanceGrantLedgerStatus: true,
          balanceGrantLedgerVersion: true,
        },
      },
      refundAllocations: {
        select: {
          id: true,
          refundId: true,
          balanceGrantId: true,
          sequence: true,
          role: true,
          amountUsd: true,
          paidReductionUsd: true,
          bonusReductionUsd: true,
          refund: {
            select: {
              id: true,
              billingAccountId: true,
              balanceGrantId: true,
              refundTransactionId: true,
              debtAllocationId: true,
              component: true,
              occurredAt: true,
              balanceGrant: {
                select: {
                  id: true,
                  billingAccountId: true,
                },
              },
            },
          },
        },
      },
      debtSettlements: {
        select: {
          id: true,
          billingAccountId: true,
          allocationId: true,
          repaymentTransactionId: true,
          balanceGrantId: true,
          debtSource: true,
          repairRunId: true,
          trigger: true,
          amountUsd: true,
          paidUsd: true,
          bonusUsd: true,
          occurredAt: true,
          allocation: {
            select: {
              id: true,
              billingAccountId: true,
              source: true,
            },
          },
        },
      },
      expiryAudit: {
        select: {
          balanceGrantId: true,
          billingAccountId: true,
          balanceTransactionId: true,
          nominalAmountUsd: true,
          nominalPaidUsd: true,
          nominalBonusUsd: true,
          walletDebitUsd: true,
          walletDebitPaidUsd: true,
          walletDebitBonusUsd: true,
          unbackedAmountUsd: true,
          unbackedPaidUsd: true,
          unbackedBonusUsd: true,
          createdAt: true,
        },
      },
    };
  }

  private assertFinanceConsumptionAllocationFacts(
    tab: 'pureGiftConsumptionDetails' | 'buyGiftConsumptionDetails',
    allocations: FinanceAllocationRow[],
    provenEnterpriseAbsorbAllocationIds: ReadonlySet<string>,
  ): void {
    for (const allocation of allocations) {
      const grant = allocation.balanceGrant;
      if (!grant || allocation.balanceGrantId !== grant.id) {
        throw new Error(
          `BALANCE_LEDGER_RECONCILIATION_REQUIRED:${allocation.balanceGrantId ?? allocation.id}:consumption_grant_relation`,
        );
      }
      this.assertFinanceGrantLedgerReady(grant);
      this.assertFinanceGrantIssuanceComponents(grant);
      this.assertFinanceGrantMovementComponents(
        grant,
        [allocation],
        provenEnterpriseAbsorbAllocationIds,
        true,
      );
      const categoryMatches = tab === 'pureGiftConsumptionDetails'
        ? this.isPureGiftGrant(grant)
        : this.isBuyGiftGrant(grant);
      if (!categoryMatches) {
        this.throwFinanceLedgerReconciliationRequired(grant, 'consumption_grant_category');
      }
      if (
        allocation.createdAt.getTime() < grant.validFrom.getTime()
        || (
          grant.expiresAt instanceof Date
          && allocation.createdAt.getTime() >= grant.expiresAt.getTime()
        )
      ) {
        this.throwFinanceLedgerReconciliationRequired(grant, 'consumption_allocation_period');
      }
      if (
        (allocation.tokenUsageId == null) !== (allocation.tokenUsage == null)
        || (
          allocation.tokenUsageId != null
          && allocation.tokenUsage?.id !== allocation.tokenUsageId
        )
      ) {
        this.throwFinanceLedgerReconciliationRequired(grant, 'consumption_token_usage_relation');
      }
    }
  }

  private async assertFinanceConsumptionAllocationBudgets(
    grants: FinanceGrantRow[],
    db: FinanceReadClient,
    validatedGrantIds?: Set<string>,
  ): Promise<void> {
    const pageGrantMap = new Map(grants.map((grant) => [grant.id, grant]));
    const pendingGrants = Array.from(pageGrantMap.values()).filter(
      (grant) => !validatedGrantIds?.has(grant.id),
    );
    if (pendingGrants.length === 0) return;
    const grantIds = pendingGrants.map((grant) => grant.id);
    const [proofGrants, allocationSums, invalidFacts] = await Promise.all([
      db.balanceGrant.findMany({
        where: { id: { in: grantIds } },
        select: this.financeConsumptionGrantProofSelect(),
      }) as unknown as Promise<FinanceGrantRow[]>,
      db.balanceConsumptionAllocation.groupBy({
        by: ['balanceGrantId'],
        where: { balanceGrantId: { in: grantIds } },
        _sum: {
          amountUsd: true,
          recognizedRevenueUsd: true,
          bonusConsumedUsd: true,
        },
      }),
      db.$queryRaw<Array<{ invalid_fact_count: bigint | number }>>(Prisma.sql`
        SELECT COUNT(*)::bigint AS invalid_fact_count
        FROM balance_consumption_allocations allocation
        LEFT JOIN balance_grants grant_row ON grant_row.id = allocation.balance_grant_id
        WHERE allocation.balance_grant_id IN (${Prisma.join(grantIds)})
          AND (
            allocation.source <> 'BALANCE_GRANT'
            OR allocation.billing_account_id IS NULL
            OR grant_row.id IS NULL
            OR grant_row.billing_account_id IS NULL
            OR CASE
              WHEN grant_row.id IS NOT NULL
                AND grant_row.billing_account_id IS NOT NULL
                AND allocation.billing_account_id IS NOT NULL
                AND grant_row.billing_account_id IS DISTINCT FROM allocation.billing_account_id
              THEN NOT COALESCE(
                balance_allocation_has_enterprise_absorb_proof(
                  allocation.id,
                  grant_row.id,
                  allocation.billing_account_id
                ),
                FALSE
              )
              ELSE FALSE
            END
            OR allocation.amount_usd <= 0
            OR allocation.recognized_revenue_usd < 0
            OR allocation.bonus_consumed_usd < 0
            OR allocation.recognized_revenue_usd + allocation.bonus_consumed_usd
              <> allocation.amount_usd
            OR allocation.discount_rate IS DISTINCT FROM CASE
              WHEN allocation.amount_usd > 0 THEN ROUND(
                allocation.recognized_revenue_usd / allocation.amount_usd,
                12
              )
              ELSE 0
            END
            OR allocation.created_at < grant_row.valid_from
            OR (
              grant_row.expires_at IS NOT NULL
              AND allocation.created_at >= grant_row.expires_at
            )
          )
      `),
    ]);
    const grantMap = new Map(proofGrants.map((grant) => [grant.id, grant]));
    if (
      proofGrants.length !== grantIds.length
      || grantIds.some((grantId) => !grantMap.has(grantId))
    ) {
      this.throwFinanceLedgerReconciliationRequired(
        pendingGrants[0],
        'consumption_grant_proof_set',
      );
    }
    if (Number(invalidFacts[0]?.invalid_fact_count ?? 0) > 0) {
      this.throwFinanceLedgerReconciliationRequired(
        pendingGrants[0],
        'allocation_fact_set',
      );
    }

    const allocationSumsByGrantId = new Map(
      allocationSums.flatMap((row) => (
        row.balanceGrantId ? [[row.balanceGrantId, row] as const] : []
      )),
    );
    await this.attachProvenLegacyDebtSettlements(proofGrants, db);
    for (const grant of proofGrants) {
      // RECONCILED_V2 promotion proves the historical chronological replay,
      // while the database contract keeps later facts append-only and enforces
      // the canonical writer split. The report revalidates immutable row math
      // and complete reduction budgets without consulting mutable remainders.
      this.assertFinanceGrantLedgerReady(grant);
      this.assertFinanceGrantMovementComponents(grant, []);
      const {
        paidUsd: issuedPaidUsd,
        bonusUsd: issuedBonusUsd,
      } = this.assertFinanceGrantIssuanceComponents(grant);
      const allocationSum = allocationSumsByGrantId.get(grant.id);
      const allocationAmountUsd = this.financeGrantDecimal(
        grant,
        'allocation.total.amountUsd',
        allocationSum?._sum.amountUsd ?? usd(0),
      );
      let reducedPaidUsd = this.financeGrantDecimal(
        grant,
        'allocation.total.recognizedRevenueUsd',
        allocationSum?._sum.recognizedRevenueUsd ?? usd(0),
      );
      let reducedBonusUsd = this.financeGrantDecimal(
        grant,
        'allocation.total.bonusConsumedUsd',
        allocationSum?._sum.bonusConsumedUsd ?? usd(0),
      );
      if (
        allocationAmountUsd.lt(0)
        || reducedPaidUsd.lt(0)
        || reducedBonusUsd.lt(0)
        || !reducedPaidUsd.plus(reducedBonusUsd).eq(allocationAmountUsd)
      ) {
        this.throwFinanceLedgerReconciliationRequired(
          grant,
          'allocation_fact_set',
        );
      }
      for (const settlement of grant.debtSettlements ?? []) {
        if (settlement.trigger === 'REFUND_NETTING') continue;
        reducedPaidUsd = reducedPaidUsd.plus(settlement.paidUsd);
        reducedBonusUsd = reducedBonusUsd.plus(settlement.bonusUsd);
      }
      for (const allocation of grant.refundAllocations ?? []) {
        reducedPaidUsd = reducedPaidUsd.plus(allocation.paidReductionUsd);
        reducedBonusUsd = reducedBonusUsd.plus(allocation.bonusReductionUsd);
      }
      if (grant.expiryAudit) {
        const expiry = this.assertFinanceExpiryAuditComponents(
          grant,
          grant.expiryAudit,
        );
        reducedPaidUsd = reducedPaidUsd.plus(expiry.nominalPaidUsd);
        reducedBonusUsd = reducedBonusUsd.plus(expiry.nominalBonusUsd);
      }
      if (
        reducedPaidUsd.gt(issuedPaidUsd)
        || reducedBonusUsd.gt(issuedBonusUsd)
      ) {
        this.throwFinanceLedgerReconciliationRequired(
          grant,
          'immutable_reduction_budget',
        );
      }
    }

    for (const row of allocationSums) {
      if (!row.balanceGrantId) {
        this.throwFinanceLedgerReconciliationRequired(
          pendingGrants[0],
          'allocation_fact_set',
        );
      }
      const grant = grantMap.get(row.balanceGrantId);
      if (!grant) {
        this.throwFinanceLedgerReconciliationRequired(
          pendingGrants[0],
          'allocation_fact_set',
        );
      }
      // Every aggregate row must resolve to the immutable grant proof set.
      // The component and issuance budgets were checked above together with
      // settlements, refund reductions and expiry nominal components.
    }
    for (const grant of pendingGrants) validatedGrantIds?.add(grant.id);
  }

  async getFinanceDashboard(month?: string) {
    const { monthKey, start, end } = this.resolveMonthRange(month);
    const overview = await this.getFinanceReportOverview(monthKey);
    const [
      products,
      orders,
      tokenUsageByProduct,
      balanceByProduct,
      attributedBalanceByType,
      creditByProduct,
    ] = await Promise.all([
      this.prisma.product.findMany({
        where: { deletedAt: null },
        orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
        select: { id: true, name: true, slug: true, billingMode: true },
      }),
      this.prisma.order.findMany({
        where: {
          status: { in: TOKEN_PLAN_REVENUE_ORDER_STATUSES },
          OR: [
            { paidAt: { gte: start, lt: end } },
            { refundedAt: { gte: start, lt: end } },
          ],
        },
        select: {
          id: true,
          amountCents: true,
          refundAmountCents: true,
          paidAt: true,
          refundedAt: true,
          product: { select: { id: true, name: true, slug: true, billingMode: true } },
          plan: { select: { product: { select: { id: true, name: true, slug: true, billingMode: true } } } },
          boosterPack: { select: { product: { select: { id: true, name: true, slug: true, billingMode: true } } } },
          items: {
            select: {
              id: true,
              amountCents: true,
              product: { select: { id: true, name: true, slug: true, billingMode: true } },
              plan: { select: { product: { select: { id: true, name: true, slug: true, billingMode: true } } } },
              boosterPack: { select: { product: { select: { id: true, name: true, slug: true, billingMode: true } } } },
            },
          },
        },
      }),
      this.prisma.tokenUsage.groupBy({
        by: ['productId'],
        where: { createdAt: { gte: start, lt: end } },
        _count: { _all: true },
        _sum: {
          totalTokens: true,
          customerChargeUsd: true,
          costUsd: true,
        },
      }),
      this.prisma.balanceTransaction.groupBy({
        by: ['productId', 'type'],
        where: {
          createdAt: { gte: start, lt: end },
          attribution: { is: null },
        },
        _sum: { amountUsd: true },
      }),
      this.prisma.balanceTransaction.groupBy({
        by: ['type'],
        where: {
          createdAt: { gte: start, lt: end },
          attribution: {
            is: this.financeBalanceAttributionWhere(ProductBillingMode.PAY_AS_YOU_GO),
          },
        },
        _sum: { amountUsd: true },
      }),
      this.prisma.creditTransaction.groupBy({
        by: ['productId', 'type'],
        where: { createdAt: { gte: start, lt: end } },
        _sum: { creditsAmount: true },
      }),
    ]);

    const productsById = new Map(products.map((product) => [product.id, product]));
    const productRows = new Map<string, {
      productId: string | null;
      productName: string;
      productSlug: string | null;
      billingMode: string;
      orderRevenueCents: number;
      refundCents: number;
      netRevenueCents: number;
      apiChargeCents: number;
      usageCount: number;
      totalTokens: number;
      rechargeCents: number;
      balanceConsumeCents: number;
      creditGranted: number;
      creditConsumed: number;
    }>();

    const ensureProductRow = (
      product: {
        id?: string | null;
        name?: string | null;
        slug?: string | null;
        billingMode?: string | null;
      } | null,
      bucketKey?: string,
    ) => {
      const productId = product?.id ?? null;
      const key = bucketKey ?? productId ?? 'unknown';
      const existing = productRows.get(key);
      if (existing) return existing;
      const row = {
        productId,
        productName: product?.name ?? '未绑定产品',
        productSlug: product?.slug ?? null,
        billingMode: product?.billingMode ?? 'UNKNOWN',
        orderRevenueCents: 0,
        refundCents: 0,
        netRevenueCents: 0,
        apiChargeCents: 0,
        usageCount: 0,
        totalTokens: 0,
        rechargeCents: 0,
        balanceConsumeCents: 0,
        creditGranted: 0,
        creditConsumed: 0,
      };
      productRows.set(key, row);
      return row;
    };

    for (const product of products) ensureProductRow(product);

    for (const order of orders) {
      const lines = this.getFinanceDashboardOrderLines(order);
      for (const line of lines) {
        const row = ensureProductRow(line.product);
        if (order.paidAt && this.isWithinPeriod(order.paidAt, start, end)) {
          row.orderRevenueCents += line.amountCents;
        }
        if (order.refundedAt && this.isWithinPeriod(order.refundedAt, start, end)) {
          row.refundCents += line.refundCents;
        }
      }
    }

    for (const usage of tokenUsageByProduct) {
      const row = ensureProductRow(usage.productId ? productsById.get(usage.productId) ?? null : null);
      row.usageCount += usage._count._all;
      row.totalTokens += usage._sum.totalTokens ?? 0;
      row.apiChargeCents += usdToCents(usage._sum.customerChargeUsd ?? usage._sum.costUsd ?? 0);
    }

    for (const tx of balanceByProduct) {
      const row = ensureProductRow(tx.productId ? productsById.get(tx.productId) ?? null : null);
      const cents = usdToCents(tx._sum.amountUsd ?? 0);
      if (tx.type === 'RECHARGE') row.rechargeCents += cents;
      if (tx.type === 'CONSUME') row.balanceConsumeCents += Math.abs(cents);
    }

    for (const tx of attributedBalanceByType) {
      const row = ensureProductRow({
        billingMode: ProductBillingMode.PAY_AS_YOU_GO,
      }, 'unbound:PAY_AS_YOU_GO');
      const cents = usdToCents(tx._sum.amountUsd ?? 0);
      if (tx.type === 'RECHARGE') row.rechargeCents += cents;
      if (tx.type === 'CONSUME') row.balanceConsumeCents += Math.abs(cents);
    }

    for (const tx of creditByProduct) {
      const row = ensureProductRow(tx.productId ? productsById.get(tx.productId) ?? null : null);
      const amount = tx._sum.creditsAmount ?? 0;
      if (tx.type === 'QUOTA_GRANT' || tx.type === 'BONUS_PURCHASE' || tx.type === 'GRANT') {
        row.creditGranted += amount;
      }
      if (tx.type === 'CONSUME') row.creditConsumed += Math.abs(amount);
    }

    for (const row of productRows.values()) {
      row.netRevenueCents = row.orderRevenueCents - row.refundCents;
    }

    const byProduct = [...productRows.values()]
      .filter((row) =>
        row.orderRevenueCents !== 0 ||
        row.refundCents !== 0 ||
        row.apiChargeCents !== 0 ||
        row.usageCount !== 0 ||
        row.rechargeCents !== 0 ||
        row.balanceConsumeCents !== 0 ||
        row.creditGranted !== 0 ||
        row.creditConsumed !== 0,
      )
      .sort((a, b) => b.netRevenueCents - a.netRevenueCents || b.apiChargeCents - a.apiChargeCents);

    const byBillingMode = new Map<string, (typeof byProduct)[number] & { productCount: number }>();
    for (const row of byProduct) {
      const key = row.billingMode;
      const bucket = byBillingMode.get(key) ?? {
        productId: null,
        productName: key,
        productSlug: null,
        billingMode: key,
        productCount: 0,
        orderRevenueCents: 0,
        refundCents: 0,
        netRevenueCents: 0,
        apiChargeCents: 0,
        usageCount: 0,
        totalTokens: 0,
        rechargeCents: 0,
        balanceConsumeCents: 0,
        creditGranted: 0,
        creditConsumed: 0,
      };
      bucket.productCount += 1;
      bucket.orderRevenueCents += row.orderRevenueCents;
      bucket.refundCents += row.refundCents;
      bucket.netRevenueCents += row.netRevenueCents;
      bucket.apiChargeCents += row.apiChargeCents;
      bucket.usageCount += row.usageCount;
      bucket.totalTokens += row.totalTokens;
      bucket.rechargeCents += row.rechargeCents;
      bucket.balanceConsumeCents += row.balanceConsumeCents;
      bucket.creditGranted += row.creditGranted;
      bucket.creditConsumed += row.creditConsumed;
      byBillingMode.set(key, bucket);
    }

    return {
      period: {
        month: monthKey,
        startDate: start.toISOString(),
        endDate: end.toISOString(),
        timezone: 'Asia/Shanghai',
      },
      totals: overview.metrics,
      byBillingMode: [...byBillingMode.values()].sort((a, b) => b.netRevenueCents - a.netRevenueCents),
      byProduct,
      notes: [
        '订单收入按订单项优先拆分到产品；无订单项时按订单绑定产品/套餐兜底。',
        'API 扣费总览优先使用 token_usage.customerChargeUsd；没有该字段的历史数据才回退 costUsd。',
        '导出任务按后端分页扫全量，CSV 金额字段输出为元。',
      ],
    };
  }

  async createFinanceReportExportJob(params: {
    month?: string;
    tab?: string;
    billingMode?: string;
    requestedByAdminId?: string | null;
  }) {
    const { monthKey } = this.resolveMonthRange(params.month);
    const tab = this.resolveFinanceReportDetailTab(params.tab);
    const billingMode = this.resolveFinanceReportBillingMode(params.billingMode);
    const filename = this.buildFinanceExportFilename(monthKey, tab, billingMode);
    const job = await this.prisma.financeExportJob.create({
      data: {
        month: monthKey,
        tab,
        billingMode: billingMode ?? null,
        status: 'PENDING',
        filename,
        requestedByAdminId: params.requestedByAdminId ?? null,
        expiresAt: new Date(Date.now() + FINANCE_EXPORT_JOB_TTL_DAYS * DAY_MS),
      },
    });

    return this.serializeFinanceExportJob(job);
  }

  async processDueFinanceReportExportJobs(params: {
    batchSize?: number;
    minAgeMs?: number;
  } = {}) {
    const batchSize = Math.min(Math.max(Number(params.batchSize ?? 1), 1), 10);
    const minAgeMs = Math.max(Number(params.minAgeMs ?? 0), 0);
    const now = new Date();
    const staleBefore = new Date(now.getTime() - FINANCE_EXPORT_RUNNING_STALE_MS);
    const createdBefore = new Date(now.getTime() - minAgeMs);
    const jobs = await this.prisma.financeExportJob.findMany({
      where: {
        OR: [
          { status: 'PENDING', createdAt: { lte: createdBefore } },
          {
            status: 'RUNNING',
            OR: [
              { heartbeatAt: { lt: staleBefore } },
              { heartbeatAt: null, startedAt: { lt: staleBefore } },
            ],
          },
        ],
      },
      orderBy: [{ createdAt: 'asc' }],
      take: batchSize,
      select: { id: true },
    });

    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    for (const job of jobs) {
      const result = await this.processFinanceReportExportJob(job.id);
      if (!result) continue;
      processed += 1;
      if (result.status === 'SUCCEEDED') succeeded += 1;
      if (result.status === 'FAILED') failed += 1;
    }
    return { processed, succeeded, failed };
  }

  async cleanupExpiredFinanceReportExportJobs(params: {
    batchSize?: number;
    now?: Date;
  } = {}): Promise<{ cleaned: number; failed: number }> {
    const batchSize = Math.min(Math.max(Number(params.batchSize ?? 100), 1), 1000);
    const now = params.now ?? new Date();
    const legacyCreatedBefore = new Date(now.getTime() - FINANCE_EXPORT_JOB_TTL_DAYS * DAY_MS);
    const expiredWhere = {
      status: { in: ['SUCCEEDED', 'FAILED'] },
      OR: [
        { expiresAt: { lte: now } },
        { expiresAt: null, createdAt: { lte: legacyCreatedBefore } },
      ],
    };
    const jobs = await this.prisma.financeExportJob.findMany({
      where: expiredWhere,
      orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }],
      take: batchSize,
      select: { id: true, filePath: true },
    });

    let cleaned = 0;
    let failed = 0;
    for (const job of jobs) {
      try {
        if (job.filePath) {
          this.assertManagedFinanceExportPath(job.filePath);
          await this.removeFinanceExportFile(job.filePath);
        }
        const deleted = await this.prisma.financeExportJob.deleteMany({
          where: {
            id: job.id,
            ...expiredWhere,
          },
        });
        cleaned += deleted.count;
      } catch (error) {
        failed += 1;
        this.logger.warn(
          `finance export cleanup failed jobId=${job.id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }
    }
    return { cleaned, failed };
  }

  async listFinanceReportExportJobs(params: { take?: number } = {}) {
    const take = Math.min(Math.max(Number(params.take ?? 20), 1), FINANCE_EXPORT_JOB_LIST_MAX_TAKE);
    const jobs = await this.prisma.financeExportJob.findMany({
      orderBy: { createdAt: 'desc' },
      take,
      select: FINANCE_EXPORT_JOB_META_SELECT,
    });
    return { items: jobs.map((job) => this.serializeFinanceExportJob(job)) };
  }

  async getFinanceReportExportJob(id: string) {
    const job = await this.prisma.financeExportJob.findUnique({
      where: { id },
      select: FINANCE_EXPORT_JOB_META_SELECT,
    });
    if (!job) throw new BadRequestException('导出任务不存在');
    return this.serializeFinanceExportJob(job);
  }

  async downloadFinanceReportExportJob(id: string) {
    const job = await this.prisma.financeExportJob.findUnique({ where: { id } });
    if (!job) throw new BadRequestException('导出任务不存在');
    if (job.status !== 'SUCCEEDED' || (!job.filePath && !job.fileContent)) {
      throw new BadRequestException('导出任务尚未完成');
    }
    if (job.filePath) {
      try {
        await access(job.filePath);
      } catch {
        throw new InternalServerErrorException('导出文件不存在或已被清理');
      }
      return {
        id: job.id,
        filename: job.filename,
        contentType: job.contentType,
        contentLength: job.fileSizeBytes == null ? null : Number(job.fileSizeBytes),
        stream: createReadStream(job.filePath),
      };
    }
    return {
      id: job.id,
      filename: job.filename,
      contentType: job.contentType,
      content: job.fileContent,
    };
  }

  async getFinanceReports(month?: string) {
    const { monthKey, start, end } = this.resolveMonthRange(month);
    const platformCurrencyCode = await this.getPlatformCurrencyCode();
    const region = await this.getFinanceReportRegion();

    const [
      openingBalance,
      closingBalance,
      balanceRecharge,
      balanceConsume,
      balanceRefund,
      balanceAdjust,
      paidOrders,
      refundedOrders,
      creditGranted,
      creditBonus,
      creditConsumed,
      tokenUsageTotals,
      orders,
      balanceTransactions,
      creditTransactions,
      tokenUsages,
      balanceGrants,
      balanceConsumptionAllocations,
      tokenPlanOrders,
    ] = await Promise.all([
      this.prisma.balanceTransaction.aggregate({
        where: { createdAt: { lt: start } },
        _sum: { amountUsd: true },
      }),
      this.prisma.balanceTransaction.aggregate({
        where: { createdAt: { lt: end } },
        _sum: { amountUsd: true },
      }),
      this.prisma.balanceTransaction.aggregate({
        where: { type: 'RECHARGE', createdAt: { gte: start, lt: end } },
        _sum: { amountUsd: true },
      }),
      this.prisma.balanceTransaction.aggregate({
        where: { type: 'CONSUME', createdAt: { gte: start, lt: end } },
        _sum: { amountUsd: true },
      }),
      this.prisma.balanceTransaction.aggregate({
        where: { type: 'REFUND', createdAt: { gte: start, lt: end } },
        _sum: { amountUsd: true },
      }),
      this.prisma.balanceTransaction.aggregate({
        where: { type: 'ADJUST', createdAt: { gte: start, lt: end } },
        _sum: { amountUsd: true },
      }),
      this.prisma.order.aggregate({
        where: {
          paidAt: { gte: start, lt: end },
          status: { in: [OrderStatus.PAID, OrderStatus.FULFILLING, OrderStatus.COMPLETED] },
        },
        _sum: { amountCents: true },
        _count: { id: true },
      }),
      this.prisma.order.aggregate({
        where: {
          refundedAt: { gte: start, lt: end },
          status: {
            in: [
              OrderStatus.REFUNDING,
              OrderStatus.REFUNDED,
              OrderStatus.REFUND_FAILED,
              OrderStatus.REFUND_COMPENSATION_FAILED,
            ],
          },
        },
        _sum: { refundAmountCents: true },
        _count: { id: true },
      }),
      this.prisma.creditTransaction.aggregate({
        where: { type: 'QUOTA_GRANT', createdAt: { gte: start, lt: end } },
        _sum: { creditsAmount: true },
      }),
      this.prisma.creditTransaction.aggregate({
        where: { type: 'BONUS_PURCHASE', createdAt: { gte: start, lt: end } },
        _sum: { creditsAmount: true },
      }),
      this.prisma.creditTransaction.aggregate({
        where: { type: 'CONSUME', createdAt: { gte: start, lt: end } },
        _sum: { creditsAmount: true },
      }),
      this.prisma.tokenUsage.aggregate({
        where: {
          AND: [
            { createdAt: { gte: start, lt: end } },
            this.financeVisibleTokenUsageWhere(),
          ],
        },
        _sum: {
          promptTokens: true,
          cachedInputTokens: true,
          cacheWriteInputTokens: true,
          completionTokens: true,
          totalTokens: true,
          customerChargeUsd: true,
          costUsd: true,
        },
        _count: { id: true },
      }),
      this.prisma.order.findMany({
        where: {
          OR: [
            { createdAt: { gte: start, lt: end } },
            { paidAt: { gte: start, lt: end } },
            { completedAt: { gte: start, lt: end } },
            { refundedAt: { gte: start, lt: end } },
          ],
        },
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, email: true, phone: true, nickname: true } },
          billingAccount: { select: FINANCE_ACCOUNT_LABEL_SELECT },
          tenant: { select: { id: true, name: true, slug: true, type: true, billingAccount: { select: FINANCE_ACCOUNT_LABEL_SELECT } } },
          product: { select: { id: true, name: true, slug: true } },
          plan: { select: { id: true, name: true, product: { select: { id: true, name: true, slug: true } } } },
          boosterPack: { select: { id: true, name: true, product: { select: { id: true, name: true, slug: true } } } },
        },
      }),
      this.prisma.balanceTransaction.findMany({
        where: { createdAt: { gte: start, lt: end } },
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, email: true, phone: true, nickname: true } },
          billingAccount: { select: FINANCE_ACCOUNT_LABEL_SELECT },
          tenant: { select: { id: true, name: true, slug: true, type: true, billingAccount: { select: FINANCE_ACCOUNT_LABEL_SELECT } } },
          product: { select: { id: true, name: true, slug: true, billingMode: true } },
          attribution: { select: { balanceGrantId: true, billingMode: true, source: true } },
        },
      }),
      this.prisma.creditTransaction.findMany({
        where: { createdAt: { gte: start, lt: end } },
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, email: true, phone: true, nickname: true } },
          tenant: { select: { id: true, name: true, slug: true, type: true, billingAccount: { select: FINANCE_ACCOUNT_LABEL_SELECT } } },
          product: { select: { id: true, name: true, slug: true } },
        },
      }),
      this.prisma.tokenUsage.findMany({
        where: {
          AND: [
            { createdAt: { gte: start, lt: end } },
            this.financeVisibleTokenUsageWhere(),
          ],
        },
        orderBy: { createdAt: 'desc' },
        include: {
          tenant: { select: { id: true, name: true, slug: true, type: true, billingAccount: { select: FINANCE_ACCOUNT_LABEL_SELECT } } },
          apiKey: {
            select: {
              id: true,
              prefix: true,
              userId: true,
              user: { select: { id: true, email: true, phone: true, nickname: true } },
            },
          },
          product: { select: { id: true, name: true, slug: true, billingMode: true } },
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
      }),
      this.prisma.balanceGrant.findMany({
        where: this.financeBalanceGrantWhere(start, end),
        orderBy: { createdAt: 'desc' },
        include: this.financeBalanceGrantInclude(),
      }),
      this.prisma.balanceConsumptionAllocation.findMany({
        where: { createdAt: { gte: start, lt: end } },
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, email: true, phone: true, nickname: true } },
          billingAccount: { select: FINANCE_ACCOUNT_LABEL_SELECT },
          tenant: { select: { id: true, name: true, slug: true, type: true, billingAccount: { select: FINANCE_ACCOUNT_LABEL_SELECT } } },
          product: { select: { id: true, name: true, slug: true, billingMode: true } },
          balanceGrant: {
            include: this.financeBalanceGrantInclude(),
          },
          balanceTransaction: {
            select: {
              id: true,
              orderId: true,
              description: true,
              createdAt: true,
              attribution: { select: { balanceGrantId: true, billingMode: true, source: true } },
            },
          },
          tokenUsage: {
            select: {
              id: true,
              model: true,
              pricingTierKey: true,
              promptTokens: true,
              cachedInputTokens: true,
              cacheWriteInputTokens: true,
              completionTokens: true,
              totalTokens: true,
              inputPriceUsdPerM: true,
              cachedInputPriceUsdPerM: true,
              cacheWritePriceUsdPerM: true,
              outputPriceUsdPerM: true,
              costUsd: true,
              customerChargePolicy: true,
              customerChargeUsd: true,
              providerCostEstimateUsd: true,
              providerCostMultiplier: true,
              providerInputCostUsdPerM: true,
              providerCachedInputCostUsdPerM: true,
              providerCacheWriteCostUsdPerM: true,
              providerOutputCostUsdPerM: true,
              codingPlanEntitlementId: true,
              providerEntitlementId: true,
              createdAt: true,
            },
          },
        },
      }),
      this.prisma.order.findMany({
        where: {
          status: { in: TOKEN_PLAN_REVENUE_ORDER_STATUSES },
          OR: [
            { paidAt: { lt: end } },
            { completedAt: { lt: end } },
            { refundedAt: { gte: start, lt: end } },
          ],
          AND: [
            {
              OR: [
                { product: { billingMode: ProductBillingMode.CODING_PLAN } },
                { plan: { product: { billingMode: ProductBillingMode.CODING_PLAN } } },
                { items: { some: { product: { billingMode: ProductBillingMode.CODING_PLAN } } } },
                { items: { some: { plan: { product: { billingMode: ProductBillingMode.CODING_PLAN } } } } },
              ],
            },
          ],
        },
        orderBy: { createdAt: 'desc' },
        include: {
          user: { select: { id: true, email: true, phone: true, nickname: true } },
          billingAccount: { select: FINANCE_ACCOUNT_LABEL_SELECT },
          tenant: { select: { id: true, name: true, slug: true, type: true, billingAccount: { select: FINANCE_ACCOUNT_LABEL_SELECT } } },
          product: { select: { id: true, name: true, slug: true, billingMode: true, codingPlanFulfillmentMode: true } },
          plan: {
            select: {
              id: true,
              name: true,
              billingPeriod: true,
              validityDays: true,
              product: { select: { id: true, name: true, slug: true, billingMode: true, codingPlanFulfillmentMode: true } },
            },
          },
          items: {
            orderBy: { createdAt: 'asc' },
            include: {
              product: { select: { id: true, name: true, slug: true, billingMode: true, codingPlanFulfillmentMode: true } },
              plan: {
                select: {
                  id: true,
                  name: true,
                  billingPeriod: true,
                  validityDays: true,
                  product: { select: { id: true, name: true, slug: true, billingMode: true, codingPlanFulfillmentMode: true } },
                },
              },
            },
          },
        },
      }),
    ]);

    const tokenPlanRevenueRecognition = await this.buildTokenPlanRevenueRecognition({
      monthKey,
      start,
      end,
      billingMode: ProductBillingMode.CODING_PLAN,
      orders: tokenPlanOrders,
    });

    const subscriptionMap = await this.getSubscriptionMap(
      creditTransactions
        .map((tx) => tx.subscriptionId)
        .filter((id): id is string => Boolean(id)),
    );

    const orderRows = this.mapFinanceOrderRows(monthKey, orders, platformCurrencyCode, region);
    const paymentRows = this.mapFinancePaymentRows(monthKey, orders, platformCurrencyCode);
    const balanceRows = this.mapFinanceBalanceRows(monthKey, balanceTransactions, region);
    const creditRows = this.mapFinanceCreditRows(monthKey, creditTransactions, subscriptionMap, region);
    const apiUsageRows = this.mapFinanceApiUsageRows(monthKey, tokenUsages, region);
    const balanceGrantRows = this.mapFinanceBalanceGrantRows(monthKey, balanceGrants as FinanceGrantRow[], region);
    const balanceAllocationRows = this.mapFinanceBalanceAllocationRows(
      monthKey,
      balanceConsumptionAllocations as FinanceAllocationRow[],
      region,
    );

    const financeTemplates = await this.buildGiftFinanceTemplates({
      monthKey,
      start,
      end,
      platformCurrencyCode,
      balanceGrants: balanceGrants as FinanceGrantRow[],
      balanceConsumptionAllocations: balanceConsumptionAllocations as FinanceAllocationRow[],
      balanceTransactions: balanceTransactions as FinanceBalanceTransactionRow[],
    });

    const orderRevenueCents = paidOrders._sum.amountCents ?? 0;
    const tokenPlanRecognizedRevenueCents = tokenPlanRevenueRecognition.summary.reduce(
      (sum, row) => sum + row.recognizedRevenueCents,
      0,
    );
    const tokenPlanClosingDeferredCents = tokenPlanRevenueRecognition.summary.reduce(
      (sum, row) => sum + row.closingDeferredCents,
      0,
    );
    const supplierCostCents = null;
    const paymentFeeCents = null;

    return {
      period: {
        month: monthKey,
        startDate: start.toISOString(),
        endDate: end.toISOString(),
      },
      metrics: {
        orderCount: paidOrders._count.id,
        refundedOrderCount: refundedOrders._count.id,
        tokenUsageCount: tokenUsageTotals._count.id,
        orderRevenueCents,
        rechargeCents: usdToCents(balanceRecharge._sum.amountUsd ?? 0),
        balanceConsumeCents: Math.abs(usdToCents(balanceConsume._sum.amountUsd ?? 0)),
        refundCents: Math.abs(usdToCents(balanceRefund._sum.amountUsd ?? 0) + (refundedOrders._sum.refundAmountCents ?? 0)),
        apiChargeCents: usdToCents(tokenUsageTotals._sum.customerChargeUsd ?? tokenUsageTotals._sum.costUsd ?? 0),
        tokenPlanRecognizedRevenueCents,
        tokenPlanClosingDeferredCents,
        cacheReadInputTokens: tokenUsageTotals._sum.cachedInputTokens ?? 0,
        cacheWriteInputTokens: tokenUsageTotals._sum.cacheWriteInputTokens ?? 0,
        totalTokens: tokenUsageTotals._sum.totalTokens ?? 0,
      },
      monthlySummary: [
        {
          period: monthKey,
          product: '全部产品',
          billingMode: 'MIXED',
          currency: platformCurrencyCode,
          openingBalanceCents: usdToCents(openingBalance._sum.amountUsd ?? 0),
          rechargeCents: usdToCents(balanceRecharge._sum.amountUsd ?? 0),
          balanceConsumeCents: Math.abs(usdToCents(balanceConsume._sum.amountUsd ?? 0)),
          refundCents: Math.abs(usdToCents(balanceRefund._sum.amountUsd ?? 0) + (refundedOrders._sum.refundAmountCents ?? 0)),
          adjustCents: usdToCents(balanceAdjust._sum.amountUsd ?? 0),
          closingBalanceCents: usdToCents(closingBalance._sum.amountUsd ?? 0),
          orderRevenueCents,
          quotaGrantedCredits: creditGranted._sum.creditsAmount ?? 0,
          bonusGrantedCredits: creditBonus._sum.creditsAmount ?? 0,
          creditConsumed: Math.abs(creditConsumed._sum.creditsAmount ?? 0),
          apiInputTokens: tokenUsageTotals._sum.promptTokens ?? 0,
          apiCacheReadInputTokens: tokenUsageTotals._sum.cachedInputTokens ?? 0,
          apiCacheWriteInputTokens: tokenUsageTotals._sum.cacheWriteInputTokens ?? 0,
          apiOutputTokens: tokenUsageTotals._sum.completionTokens ?? 0,
          apiTotalTokens: tokenUsageTotals._sum.totalTokens ?? 0,
          supplierCostCents,
          paymentFeeCents,
          grossProfitCents: supplierCostCents == null || paymentFeeCents == null ? null : orderRevenueCents - supplierCostCents - paymentFeeCents,
          grossMargin: null,
          invoiceableCents: orderRevenueCents - (refundedOrders._sum.refundAmountCents ?? 0),
          invoicedCents: null,
          settlementStatus: '有数据缺口',
          varianceCheck: '余额可滚动校验；供应商成本/渠道手续费/发票字段待接入',
          notes: '按月聚合，明细见后续报表',
        },
      ],
      orderReports: orderRows,
      paymentReconciliation: paymentRows,
      balanceTransactions: balanceRows,
      balanceGrants: balanceGrantRows,
      balanceConsumptionAllocations: balanceAllocationRows,
      creditTransactions: creditRows,
      apiUsage: apiUsageRows,
      tokenPlanRevenueRecognition,
      financeTemplates,
      supplierCosts: this.getFinanceSupplierCosts(),
      fieldGaps: this.getFinanceReportFieldGaps(),
      rowLimits: {
        maxRowsPerDetail: null,
        note: '详情表返回当前账期全部明细，导出当前报表会包含全部已加载记录。',
      },
    };
  }

  private getFinanceDashboardOrderLines(order: any) {
    const items = Array.isArray(order.items) && order.items.length > 0 ? order.items : [order];
    const orderAmountCents = Math.max(1, Number(order.amountCents ?? 0));
    const refundTotalCents = Math.max(0, Number(order.refundAmountCents ?? 0));
    return items.map((item: any) => {
      const product = item.product ?? item.plan?.product ?? item.boosterPack?.product
        ?? order.product ?? order.plan?.product ?? order.boosterPack?.product ?? null;
      const amountCents = Math.max(0, Number(item.amountCents ?? order.amountCents ?? 0));
      return {
        product,
        amountCents,
        refundCents: Math.min(amountCents, Math.round((refundTotalCents * amountCents) / orderAmountCents)),
      };
    });
  }

  async processFinanceReportExportJob(id: string) {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - FINANCE_EXPORT_RUNNING_STALE_MS);
    let stage = 'CLAIM';
    let temporaryPath: string | null = null;
    let completedFilePath: string | null = null;
    let stopHeartbeat: (() => void) | null = null;
    const claimed = await this.prisma.financeExportJob.updateMany({
      where: {
        id,
        OR: [
          { status: 'PENDING' },
          {
            status: 'RUNNING',
            OR: [
              { heartbeatAt: { lt: staleBefore } },
              { heartbeatAt: null, startedAt: { lt: staleBefore } },
            ],
          },
        ],
      },
      data: {
        status: 'RUNNING',
        startedAt: now,
        finishedAt: null,
        heartbeatAt: now,
        processedRows: 0,
        rowCount: 0,
        filePath: null,
        fileSizeBytes: null,
        fileSha256: null,
        errorCode: null,
        errorMessage: null,
        failedStage: null,
      },
    });
    if (claimed.count !== 1) return null;
    stopHeartbeat = this.startFinanceExportHeartbeat(id);

    try {
      const job = await this.prisma.financeExportJob.findUnique({ where: { id } });
      if (!job) throw new BadRequestException('导出任务不存在');
      const exportDirectory = this.financeExportStorageDirectory();
      await mkdir(exportDirectory, { recursive: true });
      const finalPath = join(exportDirectory, `${job.id}-${job.filename}`);
      temporaryPath = `${finalPath}.tmp`;
      await this.removeFinanceExportFile(temporaryPath);

      stage = 'ESTABLISH_SNAPSHOT';
      const snapshotResult = await this.withFinanceReportExportSnapshot(async (snapshot) => {
        stage = 'ESTIMATE_ROWS';
        const totalRows = await this.estimateFinanceExportRows({
          month: job.month,
          tab: job.tab as FinanceReportDetailTab,
          billingMode: job.billingMode ?? undefined,
          asOf: snapshot.asOf,
        }, snapshot.db);
        if (totalRows != null) this.assertFinanceExportRowLimit(totalRows);
        await this.prisma.financeExportJob.update({
          where: { id },
          data: { asOf: snapshot.asOf, totalRows, heartbeatAt: new Date() },
        });

        stage = 'WRITE_CSV';
        const contactCache = new FinanceExportDiskCache<FinanceUserContact>(
          `${temporaryPath}.contacts-`,
        );
        try {
          const file = await this.financeExportContext.run(
            { contacts: contactCache },
            () => this.writeFinanceExportCsvFile({
              id: job.id,
              month: job.month,
              tab: job.tab as FinanceReportDetailTab,
              billingMode: job.billingMode ?? undefined,
              asOf: snapshot.asOf,
              snapshot,
              path: temporaryPath!,
              totalRows,
            }),
          );
          return { file, totalRows };
        } finally {
          await contactCache.dispose().catch(() => undefined);
        }
      }, FINANCE_EXPORT_SNAPSHOT_TIMEOUT_MS);
      const { file, totalRows } = snapshotResult;

      stage = 'FINALIZE_FILE';
      await this.removeFinanceExportFile(finalPath);
      await rename(temporaryPath, finalPath);
      temporaryPath = null;
      completedFilePath = finalPath;

      stage = 'PERSIST_RESULT';
      const nextJob = await this.prisma.financeExportJob.update({
        where: { id },
        data: {
          status: 'SUCCEEDED',
          rowCount: file.rowCount,
          processedRows: file.rowCount,
          totalRows: totalRows ?? file.rowCount,
          fileContent: null,
          filePath: finalPath,
          fileSizeBytes: BigInt(file.fileSizeBytes),
          fileSha256: file.sha256,
          heartbeatAt: new Date(),
          errorCode: null,
          errorMessage: null,
          failedStage: null,
          finishedAt: new Date(),
        },
      });
      completedFilePath = null;
      return this.serializeFinanceExportJob(nextJob);
    } catch (error) {
      if (temporaryPath) await this.removeFinanceExportFile(temporaryPath).catch(() => undefined);
      if (completedFilePath) await this.removeFinanceExportFile(completedFilePath).catch(() => undefined);
      const failure = this.classifyFinanceExportError(error);
      const failedJob = await this.prisma.financeExportJob.update({
        where: { id },
        data: {
          status: 'FAILED',
          errorCode: failure.code,
          errorMessage: failure.message,
          failedStage: stage,
          heartbeatAt: new Date(),
          finishedAt: new Date(),
        },
      }).catch(() => undefined);
      return failedJob ? this.serializeFinanceExportJob(failedJob) : null;
    } finally {
      stopHeartbeat?.();
    }
  }

  private async estimateFinanceExportRows(params: {
    month: string;
    tab: FinanceReportDetailTab;
    billingMode?: string;
    asOf: Date;
  }, db: FinanceReadClient = this.prisma): Promise<number | null> {
    if (params.tab !== 'balance') return null;
    const { start, end } = this.resolveMonthRange(params.month);
    const cutoffExclusive = new Date(Math.min(end.getTime(), params.asOf.getTime()));
    const billingMode = this.resolveFinanceReportBillingMode(params.billingMode);
    return db.balanceTransaction.count({
      where: this.withFinanceBalanceTransactionBillingMode(
        { createdAt: { gte: start, lt: cutoffExclusive } },
        billingMode,
      ),
    });
  }

  private async writeFinanceExportCsvFile(
    params: FinanceExportWriteParams,
  ): Promise<{ rowCount: number; fileSizeBytes: number; sha256: string }> {
    const columns = this.getFinanceExportColumns(params.tab, []);
    const header = columns
      .map((column) => this.escapeCsvCell(this.formatFinanceExportHeader(column)))
      .join(',');
    const output = createWriteStream(params.path, { flags: 'w', encoding: 'utf8' });
    const digest = createHash('sha256');
    let rowCount = 0;
    let fileSizeBytes = 0;
    let lastReportedRows = 0;
    let lastReportedAt = Date.now();

    const write = async (value: string): Promise<void> => {
      digest.update(value, 'utf8');
      fileSizeBytes += Buffer.byteLength(value, 'utf8');
      if (!output.write(value, 'utf8')) await once(output, 'drain');
    };
    const reportProgress = async (force = false): Promise<void> => {
      const now = Date.now();
      if (!force && rowCount - lastReportedRows < 10_000 && now - lastReportedAt < 5_000) return;
      await this.prisma.financeExportJob.updateMany({
        where: { id: params.id, status: 'RUNNING' },
        data: {
          processedRows: rowCount,
          heartbeatAt: new Date(now),
          ...(params.totalRows == null ? {} : { totalRows: params.totalRows }),
        },
      });
      lastReportedRows = rowCount;
      lastReportedAt = now;
    };
    const appendRows = async (rows: Record<string, unknown>[]): Promise<void> => {
      if (rows.length === 0) return;
      this.assertFinanceExportRowLimit(rowCount + rows.length);
      const lines = rows.map((row) => columns
        .map((column) => this.escapeCsvCell(this.formatFinanceExportValue(column.key, row[column.key], row)))
        .join(','));
      await write(`\n${lines.join('\n')}`);
      rowCount += rows.length;
      await reportProgress();
    };
    const writePages = async (
      loadPage: (cursor: string | undefined) => Promise<{
        rows: Record<string, unknown>[];
        pagination: { hasMore: boolean; nextCursor?: string | null };
      }>,
    ): Promise<void> => {
      let cursor: string | undefined;
      const seenCursors = new Set<string>();
      for (;;) {
        const page = await loadPage(cursor);
        await appendRows(page.rows);
        const nextCursor = this.resolveFinanceReportCollectionNextCursor(
          page.pagination,
          cursor,
          seenCursors,
        );
        if (nextCursor === null) break;
        cursor = nextCursor;
      }
    };

    try {
      await write(`\uFEFF${header}`);
      if (
        params.tab === 'tokenPlanRevenueSummary'
        || params.tab === 'tokenPlanRevenueDetails'
        || params.tab === 'tokenPlanRevenueNotes'
      ) {
        await this.writeTokenPlanRevenueExportRows(params, appendRows);
      } else if (
        params.tab === 'pureGiftConsumptionSummary'
        || params.tab === 'buyGiftConsumptionSummary'
        || params.tab === 'buyGiftAccountSummary'
        || params.tab === 'buyGiftPaymentSummary'
      ) {
        await this.writeGroupedFinanceExportRows(params, appendRows);
      } else if (params.tab === 'enterpriseCreditConsumptionSummary') {
        await this.writeEnterpriseCreditSummaryExportRows(params, appendRows);
      } else if (FINANCE_BALANCE_LEDGER_REPORT_TABS.has(params.tab)) {
        const context = params.snapshot ?? this.createFinanceExportReadContext(params.asOf);
        await this.prisma.financeExportJob.updateMany({
          where: { id: params.id, status: 'RUNNING' },
          data: { asOf: context.asOf, heartbeatAt: new Date() },
        });
        await writePages(async (cursor) => {
          const detail = await this.getBalanceLedgerFinanceReportDetail({
            month: params.month,
            tab: params.tab,
            billingMode: params.billingMode,
            pageSize: FINANCE_EXPORT_PAGE_SIZE,
            cursor,
            filter: null,
          }, params.tab, context);
          const page = {
            rows: detail.rows as Record<string, unknown>[],
            pagination: detail.pagination,
          };
          context.validatedConsumptionGrantIds.clear();
          return page;
        });
      } else {
        await writePages(async (cursor) => {
          const detailParams = {
            month: params.month,
            tab: params.tab,
            billingMode: params.billingMode,
            pageSize: FINANCE_EXPORT_PAGE_SIZE,
            cursor,
            cutoffExclusive: params.asOf,
          };
          const detail = params.snapshot
            ? await this.getFinanceReportDetail(
              detailParams,
              FINANCE_EXPORT_PAGE_SIZE,
              params.snapshot,
            )
            : await this.getFinanceReportDetail(detailParams, FINANCE_EXPORT_PAGE_SIZE);
          return {
            rows: detail.rows as Record<string, unknown>[],
            pagination: detail.pagination,
          };
        });
      }
      await reportProgress(true);
      const finished = once(output, 'finish');
      output.end();
      await finished;
      return {
        rowCount,
        fileSizeBytes,
        sha256: digest.digest('hex'),
      };
    } catch (error) {
      if (!output.closed) {
        await new Promise<void>((resolveClose) => {
          output.once('close', resolveClose);
          output.destroy();
        });
      }
      throw error;
    }
  }

  private async writeGroupedFinanceExportRows(
    params: FinanceExportWriteParams,
    appendRows: (rows: Record<string, unknown>[]) => Promise<void>,
  ): Promise<void> {
    const consumptionConfig = params.tab === 'pureGiftConsumptionSummary'
      || params.tab === 'buyGiftConsumptionSummary'
      ? FINANCE_CONSUMPTION_SUMMARY_CONFIG[params.tab]
      : null;
    const userCurrencyConfig = params.tab === 'buyGiftAccountSummary'
      || params.tab === 'buyGiftPaymentSummary'
      ? FINANCE_USER_CURRENCY_SUMMARY_CONFIG[params.tab]
      : null;
    if (!consumptionConfig && !userCurrencyConfig) {
      throw new InternalServerErrorException(`unsupported grouped finance export: ${params.tab}`);
    }
    if (params.snapshot) {
      await this.writeGroupedFinanceExportRowsSql(
        params,
        appendRows,
        consumptionConfig,
        userCurrencyConfig,
      );
      return;
    }
    const groupKeys = consumptionConfig
      ? ['userId', 'model'] as const
      : ['userId', 'currency'] as const;
    const carryKeys = ['userLabel'] as const;
    const sumKeys = consumptionConfig?.sumKeys ?? userCurrencyConfig!.sumKeys;
    const sorter = new FinanceExportExternalSorter<FinanceGroupedSpillRow>(
      `${params.path}.groups-`,
      (left, right) => left.key < right.key ? -1 : left.key > right.key ? 1 : 0,
      {
        bufferRows: FINANCE_EXPORT_SPILL_BUFFER_ROWS,
        mergeEqual: (left, right) => this.mergeFinanceGroupedSpillRows(left, right, sumKeys),
      },
    );

    try {
      const snapshot = params.snapshot ?? this.createFinanceExportReadContext(params.asOf);
      await this.prisma.financeExportJob.updateMany({
        where: { id: params.id, status: 'RUNNING' },
        data: { asOf: snapshot.asOf, heartbeatAt: new Date() },
      });
      const { monthKey, start, end } = this.resolveMonthRange(params.month, snapshot.asOf);
      const effectiveEnd = new Date(Math.min(end.getTime(), snapshot.asOf.getTime()));
      const billingMode = this.resolveFinanceReportBillingMode(params.billingMode);
      let cursorToken: string | undefined;
      let cursor: FinanceReportCursor | null = null;
      const seenCursors = new Set<string>();
      const platformCurrencyCode = userCurrencyConfig
        ? await this.getPlatformCurrencyCode(snapshot.db)
        : undefined;
      const region = userCurrencyConfig
        ? await this.getFinanceReportRegion(snapshot.db)
        : undefined;

      for (;;) {
        let rows: Record<string, unknown>[];
        let hasMore: boolean;
        let nextCursor: string | null | undefined;
        if (consumptionConfig) {
          const page = await this.loadFinanceGiftConsumptionPage({
            monthKey,
            start,
            end: effectiveEnd,
            billingMode,
            tab: consumptionConfig.detailTab,
            pageSize: FINANCE_EXPORT_GROUP_PAGE_SIZE,
            cursor,
            projection: 'summary',
            filter: null,
            scopeHash: 'internal-consumption-summary-export',
          }, snapshot.db, snapshot.validatedConsumptionGrantIds);
          rows = page.items;
          hasMore = page.hasMore;
          nextCursor = page.nextCursor ?? (page.hasMore
            ? this.encodeFinanceReportRowCursor(
              page.pageRows.at(-1),
              'internal-consumption-summary-export',
            )
            : null);
        } else {
          const grantPage = params.tab === 'buyGiftPaymentSummary'
            ? await this.loadFinanceBuyGiftPaymentGrantCursorPage({
              start,
              end: effectiveEnd,
              billingMode,
              pageSize: FINANCE_EXPORT_GROUP_PAGE_SIZE,
              cursor,
            }, snapshot.db)
            : await this.loadFinanceBalanceGrantCursorPage({
              start,
              end: effectiveEnd,
              billingMode,
              tab: userCurrencyConfig!.detailTab,
              pageSize: FINANCE_EXPORT_GROUP_PAGE_SIZE,
              cursor,
              filter: null,
            }, snapshot.db);
          if (params.tab === 'buyGiftPaymentSummary') {
            // Payment summary values depend only on immutable grant, order and
            // refund facts. Avoid replaying the balance allocation ledger,
            // expiry state and invoice state needed by the account summary.
            rows = this.buildBuyGiftPaymentSummaryRows(
              monthKey,
              start,
              effectiveEnd,
              grantPage.pageRows,
              platformCurrencyCode!,
              region,
            );
          } else {
            const templates = await this.buildFinanceTemplatesForGrants(
              monthKey,
              start,
              effectiveEnd,
              grantPage.pageRows,
              snapshot.db,
              snapshot.asOf,
              platformCurrencyCode,
              region,
            );
            rows = templates.buyGift.accountChangeSummary;
          }
          hasMore = grantPage.hasMore;
          nextCursor = grantPage.hasMore
            ? this.encodeFinanceReportRowCursor(
              grantPage.pageRows.at(-1),
              'internal-user-currency-summary-export',
            )
            : null;
        }
        await sorter.add(rows.map((row) => this.createFinanceGroupedSpillRow(
          row,
          groupKeys,
          sumKeys,
          carryKeys,
        )));
        snapshot.validatedConsumptionGrantIds.clear();
        const resolvedNextCursor = this.resolveFinanceReportCollectionNextCursor(
          { hasMore, nextCursor },
          cursorToken,
          seenCursors,
        );
        if (resolvedNextCursor === null) break;
        cursorToken = resolvedNextCursor;
        cursor = this.decodeFinanceReportCursor(
          resolvedNextCursor,
          consumptionConfig
            ? 'internal-consumption-summary-export'
            : 'internal-user-currency-summary-export',
        );
      }

      for await (const batch of sorter.batches(FINANCE_EXPORT_PAGE_SIZE)) {
        await appendRows(batch.map((row) => this.materializeFinanceGroupedSpillRow(row)));
      }
    } finally {
      await sorter.dispose();
    }
  }

  private async writeGroupedFinanceExportRowsSql(
    params: FinanceExportWriteParams,
    appendRows: (rows: Record<string, unknown>[]) => Promise<void>,
    consumptionConfig: typeof FINANCE_CONSUMPTION_SUMMARY_CONFIG[FinanceConsumptionSummaryTab] | null,
    userCurrencyConfig: typeof FINANCE_USER_CURRENCY_SUMMARY_CONFIG[FinanceUserCurrencySummaryTab] | null,
  ): Promise<void> {
    const snapshot = params.snapshot!;
    const groupKeys = consumptionConfig
      ? ['userId', 'model'] as const
      : ['userId', 'currency'] as const;
    const carryKeys = ['userLabel'] as const;
    const sumKeys = consumptionConfig?.sumKeys ?? userCurrencyConfig!.sumKeys;
    const rawUsdSumKeys = new Set(sumKeys.filter((key) => key !== 'tokenUsage'));
    const aggregator = new FinanceSummarySqlAggregator(snapshot.db, sumKeys);

    try {
      await this.prisma.financeExportJob.updateMany({
        where: { id: params.id, status: 'RUNNING' },
        data: { asOf: snapshot.asOf, heartbeatAt: new Date() },
      });
      const { monthKey, start, end } = this.resolveMonthRange(params.month, snapshot.asOf);
      const effectiveEnd = new Date(Math.min(end.getTime(), snapshot.asOf.getTime()));
      const billingMode = this.resolveFinanceReportBillingMode(params.billingMode);
      let cursorToken: string | undefined;
      let cursor: FinanceReportCursor | null = null;
      const seenCursors = new Set<string>();
      const platformCurrencyCode = userCurrencyConfig
        ? await this.getPlatformCurrencyCode(snapshot.db)
        : undefined;
      const region = userCurrencyConfig
        ? await this.getFinanceReportRegion(snapshot.db)
        : undefined;

      for (;;) {
        let rows: Record<string, unknown>[];
        let hasMore: boolean;
        let nextCursor: string | null | undefined;
        if (consumptionConfig) {
          const page = await this.loadFinanceGiftConsumptionPage({
            monthKey,
            start,
            end: effectiveEnd,
            billingMode,
            tab: consumptionConfig.detailTab,
            pageSize: FINANCE_EXPORT_GROUP_PAGE_SIZE,
            cursor,
            projection: 'summary',
            filter: null,
            scopeHash: 'internal-consumption-summary-export',
          }, snapshot.db, snapshot.validatedConsumptionGrantIds);
          rows = page.items;
          hasMore = page.hasMore;
          nextCursor = page.nextCursor ?? (page.hasMore
            ? this.encodeFinanceReportRowCursor(
              page.pageRows.at(-1),
              'internal-consumption-summary-export',
            )
            : null);
        } else {
          const grantPage = params.tab === 'buyGiftPaymentSummary'
            ? await this.loadFinanceBuyGiftPaymentGrantCursorPage({
              start,
              end: effectiveEnd,
              billingMode,
              pageSize: FINANCE_EXPORT_GROUP_PAGE_SIZE,
              cursor,
            }, snapshot.db)
            : await this.loadFinanceBalanceGrantCursorPage({
              start,
              end: effectiveEnd,
              billingMode,
              tab: userCurrencyConfig!.detailTab,
              pageSize: FINANCE_EXPORT_GROUP_PAGE_SIZE,
              cursor,
              filter: null,
            }, snapshot.db);
          if (params.tab === 'buyGiftPaymentSummary') {
            rows = this.buildBuyGiftPaymentSummaryRows(
              monthKey,
              start,
              effectiveEnd,
              grantPage.pageRows,
              platformCurrencyCode!,
              region,
            );
          } else {
            const templates = await this.buildFinanceTemplatesForGrants(
              monthKey,
              start,
              effectiveEnd,
              grantPage.pageRows,
              snapshot.db,
              snapshot.asOf,
              platformCurrencyCode,
              region,
            );
            rows = templates.buyGift.accountChangeSummary;
          }
          hasMore = grantPage.hasMore;
          nextCursor = grantPage.hasMore
            ? this.encodeFinanceReportRowCursor(
              grantPage.pageRows.at(-1),
              'internal-user-currency-summary-export',
            )
            : null;
        }
        await aggregator.add(rows.map((row) => this.createFinanceSummarySqlFact(
          row,
          groupKeys,
          sumKeys,
          carryKeys,
          rawUsdSumKeys,
        )));
        snapshot.validatedConsumptionGrantIds.clear();
        const resolvedNextCursor = this.resolveFinanceReportCollectionNextCursor(
          { hasMore, nextCursor },
          cursorToken,
          seenCursors,
        );
        if (resolvedNextCursor === null) break;
        cursorToken = resolvedNextCursor;
        cursor = this.decodeFinanceReportCursor(
          resolvedNextCursor,
          consumptionConfig
            ? 'internal-consumption-summary-export'
            : 'internal-user-currency-summary-export',
        );
      }

      this.assertFinanceExportRowLimit(await aggregator.count());
      for await (const batch of aggregator.batches(FINANCE_EXPORT_PAGE_SIZE)) {
        await appendRows(batch.map((row) => this.materializeFinanceSummarySqlRow(row, sumKeys)));
      }
    } finally {
      await aggregator.dispose();
    }
  }

  private async writeTokenPlanRevenueExportRows(
    params: FinanceExportWriteParams,
    appendRows: (rows: Record<string, unknown>[]) => Promise<void>,
  ): Promise<void> {
    const db: FinanceReadClient = params.snapshot?.db ?? this.prisma;
    const billingMode = this.resolveFinanceReportBillingMode(params.billingMode);
    const revenueRecognitionMode = this.resolveFinanceRevenueRecognitionMode(billingMode);
    if (!revenueRecognitionMode) return;
    if (params.tab === 'tokenPlanRevenueNotes') {
      await appendRows(this.getRevenueRecognitionNotes(revenueRecognitionMode));
      return;
    }

    const monthRange = this.resolveMonthRange(params.month, params.asOf);
    const scanParams = {
      monthKey: monthRange.monthKey,
      start: monthRange.start,
      end: new Date(Math.min(monthRange.end.getTime(), params.asOf.getTime())),
      billingMode: revenueRecognitionMode,
    };
    if (params.tab === 'tokenPlanRevenueSummary') {
      if (params.snapshot) {
        await this.processTokenPlanRevenueSummarySql(
          scanParams,
          async (rows) => appendRows(rows as unknown as Record<string, unknown>[]),
          params.snapshot.db,
        );
        return;
      }
      await this.processTokenPlanRevenueSummary({
        ...scanParams,
        workDirectoryPrefix: `${params.path}.revenue-summary-`,
      }, async (rows) => appendRows(rows as unknown as Record<string, unknown>[]), db);
      return;
    }

    const sorter = new FinanceExportExternalSorter<FinanceTokenPlanLine>(
      `${params.path}.revenue-details-`,
      (left, right) => this.compareFinanceTokenPlanRevenueLines(left, right),
      { bufferRows: FINANCE_EXPORT_SPILL_BUFFER_ROWS },
    );
    try {
      await this.scanFinanceTokenPlanRevenueLines(scanParams, async (rows) => {
        await sorter.add(rows);
      }, db);
      for await (const rows of sorter.batches(FINANCE_EXPORT_PAGE_SIZE)) {
        await appendRows(rows as unknown as Record<string, unknown>[]);
      }
    } finally {
      await sorter.dispose();
    }
  }

  private async writeEnterpriseCreditSummaryExportRows(
    params: FinanceExportWriteParams,
    appendRows: (rows: Record<string, unknown>[]) => Promise<void>,
  ): Promise<void> {
    if (params.snapshot) {
      await this.writeEnterpriseCreditSummaryExportRowsSql(params, appendRows);
      return;
    }
    const db: FinanceReadClient = this.prisma;
    const monthRange = this.resolveMonthRange(params.month, params.asOf);
    const monthKey = monthRange.monthKey;
    const start = monthRange.start;
    const end = new Date(Math.min(monthRange.end.getTime(), params.asOf.getTime()));
    const billingMode = this.resolveFinanceReportBillingMode(params.billingMode);
    const sorter = new FinanceExportExternalSorter<FinanceGroupedSpillRow>(
      `${params.path}.enterprise-credit-summary-`,
      (left, right) => left.key.localeCompare(right.key),
      { bufferRows: FINANCE_EXPORT_SPILL_BUFFER_ROWS },
    );
    let skip = 0;
    try {
      for (;;) {
        const groups = await db.balanceConsumptionAllocation.groupBy({
          by: ['tenantId', 'productId'],
          where: {
            AND: [
              this.withFinanceBalanceAllocationBillingMode(
                { createdAt: { gte: start, lt: end } },
                billingMode,
              ),
              this.financeEnterpriseCreditAllocationWhere(),
            ],
          },
          _count: { _all: true },
          _sum: {
            amountUsd: true,
            recognizedRevenueUsd: true,
            settledUsd: true,
          },
          orderBy: [
            { tenantId: 'asc' },
            { productId: 'asc' },
          ],
          skip,
          take: FINANCE_EXPORT_PAGE_SIZE,
        });
        const mappedRows = await this.mapEnterpriseCreditSummaryGroups(
          monthKey,
          groups,
          db,
        );
        await sorter.add(mappedRows.map((row) => this.createFinanceRawSpillRow(
          String(row.id),
          row,
        )));
        skip += groups.length;
        if (groups.length < FINANCE_EXPORT_PAGE_SIZE) break;
      }
      for await (const batch of sorter.batches(FINANCE_EXPORT_PAGE_SIZE)) {
        await appendRows(batch.map((row) => this.materializeFinanceGroupedSpillRow(row)));
      }
    } finally {
      await sorter.dispose();
    }
  }

  private async writeEnterpriseCreditSummaryExportRowsSql(
    params: FinanceExportWriteParams,
    appendRows: (rows: Record<string, unknown>[]) => Promise<void>,
  ): Promise<void> {
    const db = params.snapshot!.db;
    const monthRange = this.resolveMonthRange(params.month, params.asOf);
    const monthKey = monthRange.monthKey;
    const start = monthRange.start;
    const end = new Date(Math.min(monthRange.end.getTime(), params.asOf.getTime()));
    const billingMode = this.resolveFinanceReportBillingMode(params.billingMode);
    const billingModeSql = !billingMode
      ? Prisma.sql`TRUE`
      : billingMode !== ProductBillingMode.PAY_AS_YOU_GO
        ? Prisma.sql`product.billing_mode = ${billingMode}::"ProductBillingMode"`
        : Prisma.sql`(
          product.billing_mode = ${billingMode}::"ProductBillingMode"
          OR (
            allocation.product_id IS NULL
            AND transaction_attribution.billing_mode = ${billingMode}::"ProductBillingMode"
            AND transaction_attribution.source = ${BalanceTransactionAttributionSource.ADMIN_BALANCE_ADJUSTMENT}::"BalanceTransactionAttributionSource"
          )
        )`;
    const paged = new FinanceSqlPagedResult<FinanceEnterpriseCreditSummarySqlRow>(db);
    try {
      await paged.materialize(Prisma.sql`
        SELECT
          CONCAT(allocation.tenant_id, ':', COALESCE(allocation.product_id, 'none')) AS id,
          allocation.tenant_id AS "tenantId",
          allocation.product_id AS "productId",
          COUNT(*)::bigint AS "callCount",
          COALESCE(SUM(allocation.amount_usd), 0)::text AS "amountUsd",
          COALESCE(SUM(allocation.recognized_revenue_usd), 0)::text AS "recognizedRevenueUsd",
          COALESCE(SUM(allocation.settled_usd), 0)::text AS "settledUsd"
        FROM balance_consumption_allocations allocation
        LEFT JOIN products product ON product.id = allocation.product_id
        LEFT JOIN balance_transaction_attributions transaction_attribution
          ON transaction_attribution.transaction_id = allocation.balance_transaction_id
        WHERE allocation.created_at >= ${start}
          AND allocation.created_at < ${end}
          AND allocation.source = ${BALANCE_ALLOCATION_SOURCE_ENTERPRISE_CREDIT}
          AND allocation.balance_grant_id IS NULL
          AND ${billingModeSql}
        GROUP BY allocation.tenant_id, allocation.product_id
      `, ['id']);
      this.assertFinanceExportRowLimit(await paged.count());
      for await (const batch of paged.batches(FINANCE_EXPORT_PAGE_SIZE)) {
        const mappedRows = await this.mapEnterpriseCreditSummaryGroups(
          monthKey,
          batch.map((row) => ({
            tenantId: row.tenantId,
            productId: row.productId,
            _count: { _all: Number(row.callCount) },
            _sum: {
              amountUsd: usd(row.amountUsd),
              recognizedRevenueUsd: usd(row.recognizedRevenueUsd),
              settledUsd: usd(row.settledUsd),
            },
          })),
          db,
        );
        await appendRows(mappedRows);
      }
    } finally {
      await paged.dispose();
    }
  }

  private async processTokenPlanRevenueSummary(
    params: {
      monthKey: string;
      start: Date;
      end: Date;
      billingMode: FinanceRevenueRecognitionMode;
      workDirectoryPrefix: string;
    },
    appendRows: (rows: FinanceTokenPlanSummaryRow[]) => Promise<void>,
    db: FinanceReadClient = this.prisma,
  ): Promise<void> {
    const facts = new FinanceExportExternalSorter<FinanceTokenPlanLine>(
      `${params.workDirectoryPrefix}facts-`,
      (left, right) => this.compareFinanceTokenPlanRevenueSummaryFacts(left, right),
      { bufferRows: FINANCE_EXPORT_SPILL_BUFFER_ROWS },
    );
    const summaries = new FinanceExportExternalSorter<FinanceTokenPlanSummaryRow>(
      `${params.workDirectoryPrefix}rows-`,
      (left, right) => this.compareFinanceTokenPlanRevenueSummaries(left, right),
      { bufferRows: FINANCE_EXPORT_SPILL_BUFFER_ROWS },
    );
    try {
      await this.scanFinanceTokenPlanRevenueLines(params, async (rows) => {
        await facts.add(rows);
      }, db);

      let groupKey: string | null = null;
      let lastOrderId: string | null = null;
      let firstLine: FinanceTokenPlanLine | null = null;
      let summary: FinanceTokenPlanSummaryRow | null = null;
      const flushSummary = async () => {
        if (!summary || !firstLine) return;
        summary.productName = firstLine.productName;
        summary.planName = firstLine.planName;
        summary.deferredVarianceCents = summary.openingDeferredCents + summary.newDeferredCents
          - summary.serviceRecognizedRevenueCents
          - summary.refundAppliedToDeferredCents
          - summary.closingDeferredCents;
        await summaries.add([summary]);
      };

      for await (const batch of facts.batches(FINANCE_EXPORT_PAGE_SIZE)) {
        for (const row of batch) {
          const nextGroupKey = this.tokenPlanRevenueSummaryGroupKey(row);
          if (groupKey !== nextGroupKey) {
            await flushSummary();
            groupKey = nextGroupKey;
            lastOrderId = null;
            firstLine = row;
            summary = this.createTokenPlanRevenueSummaryRow(row);
          } else if (
            firstLine
            && this.compareFinanceTokenPlanRevenueLines(row, firstLine) < 0
          ) {
            firstLine = row;
          }
          if (lastOrderId !== row.orderId) {
            summary!.orderCount += 1;
            lastOrderId = row.orderId;
          }
          this.addTokenPlanRevenueSummaryLine(summary!, row);
        }
      }
      await flushSummary();
      for await (const batch of summaries.batches(FINANCE_EXPORT_PAGE_SIZE)) {
        await appendRows(batch);
      }
    } finally {
      await Promise.all([
        facts.dispose(),
        summaries.dispose(),
      ]);
    }
  }

  private async processTokenPlanRevenueSummarySql(
    params: {
      monthKey: string;
      start: Date;
      end: Date;
      billingMode: FinanceRevenueRecognitionMode;
    },
    appendRows: (rows: FinanceTokenPlanSummaryRow[]) => Promise<void>,
    db: Prisma.TransactionClient,
  ): Promise<void> {
    const sumKeys = [
      'orderAmountCents',
      'openingDeferredCents',
      'newDeferredCents',
      'serviceRecognizedRevenueCents',
      'refundAppliedToDeferredCents',
      'refundRevenueReversalCents',
      'recognizedRevenueCents',
      'closingDeferredCents',
      'recognizedToDateCents',
      'refundAmountCents',
    ] as const;
    const aggregator = new FinanceSummarySqlAggregator(db, sumKeys);
    try {
      await this.scanFinanceTokenPlanRevenueLines(params, async (rows) => {
        const facts: FinanceSummarySqlFact[] = rows.map((row) => ({
          groupKey: this.tokenPlanRevenueSummaryGroupKey(row),
          resultSortKey: JSON.stringify([
            row.productName,
            row.planName,
            row.productId ?? '',
            row.planId ?? '',
            row.currency,
            row.fulfillmentMode,
            row.period,
          ]),
          dimensionOrder: JSON.stringify([
            new Date(row.serviceStartAt).toISOString(),
            row.orderId,
            row.orderItemId ?? '',
            row.entitlementId ?? '',
            row.productId ?? '',
            row.planId ?? '',
          ]),
          dimensions: {
            period: row.period,
            productId: row.productId,
            productName: row.productName,
            planId: row.planId,
            planName: row.planName,
            fulfillmentMode: row.fulfillmentMode,
            currency: row.currency,
            settlementStatus: '派生口径',
            notes: '不含供应商成本、支付手续费和税费',
          },
          sums: Object.fromEntries(sumKeys.map((key) => [key, String(row[key])])),
          rawUsdKeys: [],
          distinctKey: row.orderId,
        }));
        await aggregator.add(facts);
      }, db);

      this.assertFinanceExportRowLimit(await aggregator.count());
      for await (const batch of aggregator.batches(FINANCE_EXPORT_PAGE_SIZE)) {
        await appendRows(batch.map((sqlRow) => {
          const sums = Object.fromEntries(sumKeys.map((key) => [
            key,
            Number(sqlRow.sums[key] ?? 0),
          ])) as Record<(typeof sumKeys)[number], number>;
          return {
            ...sqlRow.dimensions,
            orderCount: Number(sqlRow.distinctCount),
            lineCount: Number(sqlRow.rowCount),
            ...sums,
            deferredVarianceCents: sums.openingDeferredCents + sums.newDeferredCents
              - sums.serviceRecognizedRevenueCents
              - sums.refundAppliedToDeferredCents
              - sums.closingDeferredCents,
          } as FinanceTokenPlanSummaryRow;
        }));
      }
    } finally {
      await aggregator.dispose();
    }
  }

  private async scanFinanceTokenPlanRevenueLines(
    params: {
      monthKey: string;
      start: Date;
      end: Date;
      billingMode: FinanceRevenueRecognitionMode;
    },
    consume: (rows: FinanceTokenPlanLine[]) => Promise<void>,
    db: FinanceReadClient = this.prisma,
  ): Promise<void> {
    let cursor: FinanceReportCursor | null = null;
    for (;;) {
      const orders: any[] = await db.order.findMany({
        where: {
          AND: [
            this.financeTokenPlanOrderWhere(params.start, params.end, params.billingMode),
            this.financeCreatedAtCursorWhere(cursor),
          ],
        },
        take: FINANCE_EXPORT_PAGE_SIZE + 1,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        include: this.financeTokenPlanOrderInclude(),
      });
      const pageOrders: any[] = orders.slice(0, FINANCE_EXPORT_PAGE_SIZE);
      await this.enrichFinanceRowsWithAuthoritativeContacts(pageOrders);
      const recognition = await this.buildTokenPlanRevenueRecognition({
        ...params,
        orders: pageOrders,
      }, db);
      await consume(recognition.details);
      if (orders.length <= FINANCE_EXPORT_PAGE_SIZE) break;
      const lastOrder: any | undefined = pageOrders.at(-1);
      if (!lastOrder) break;
      cursor = {
        version: 2,
        kind: 'row',
        scopeHash: 'internal-token-plan-revenue-export',
        createdAt: lastOrder.createdAt.toISOString(),
        id: lastOrder.id,
        partOffset: 0,
      };
    }
  }

  private compareFinanceTokenPlanRevenueLines(
    left: FinanceTokenPlanLine,
    right: FinanceTokenPlanLine,
  ): number {
    const serviceDiff = new Date(left.serviceStartAt).getTime() - new Date(right.serviceStartAt).getTime();
    if (serviceDiff !== 0) return serviceDiff;
    return [
      left.orderId,
      left.orderItemId ?? '',
      left.entitlementId ?? '',
      left.productId ?? '',
      left.planId ?? '',
    ].join('\u0000').localeCompare([
      right.orderId,
      right.orderItemId ?? '',
      right.entitlementId ?? '',
      right.productId ?? '',
      right.planId ?? '',
    ].join('\u0000'));
  }

  private tokenPlanRevenueSummaryGroupKey(row: FinanceTokenPlanLine): string {
    return [
      row.period,
      row.currency,
      row.productId ?? '',
      row.planId ?? '',
      row.fulfillmentMode,
    ].join('|');
  }

  private compareFinanceTokenPlanRevenueSummaryFacts(
    left: FinanceTokenPlanLine,
    right: FinanceTokenPlanLine,
  ): number {
    const groupDiff = this.tokenPlanRevenueSummaryGroupKey(left)
      .localeCompare(this.tokenPlanRevenueSummaryGroupKey(right));
    if (groupDiff !== 0) return groupDiff;
    const orderDiff = left.orderId.localeCompare(right.orderId);
    if (orderDiff !== 0) return orderDiff;
    return this.compareFinanceTokenPlanRevenueLines(left, right);
  }

  private compareFinanceTokenPlanRevenueSummaries(
    left: FinanceTokenPlanSummaryRow,
    right: FinanceTokenPlanSummaryRow,
  ): number {
    return [
      left.productName,
      left.planName,
      left.productId ?? '',
      left.planId ?? '',
      left.currency,
      left.fulfillmentMode,
      left.period,
    ].join('\u0000').localeCompare([
      right.productName,
      right.planName,
      right.productId ?? '',
      right.planId ?? '',
      right.currency,
      right.fulfillmentMode,
      right.period,
    ].join('\u0000'));
  }

  private createTokenPlanRevenueSummaryRow(row: FinanceTokenPlanLine): FinanceTokenPlanSummaryRow {
    return {
      period: row.period,
      productId: row.productId,
      productName: row.productName,
      planId: row.planId,
      planName: row.planName,
      fulfillmentMode: row.fulfillmentMode,
      currency: row.currency,
      orderCount: 0,
      lineCount: 0,
      orderAmountCents: 0,
      openingDeferredCents: 0,
      newDeferredCents: 0,
      serviceRecognizedRevenueCents: 0,
      refundAppliedToDeferredCents: 0,
      refundRevenueReversalCents: 0,
      recognizedRevenueCents: 0,
      closingDeferredCents: 0,
      recognizedToDateCents: 0,
      refundAmountCents: 0,
      settlementStatus: '派生口径',
      notes: '不含供应商成本、支付手续费和税费',
      deferredVarianceCents: 0,
    };
  }

  private addTokenPlanRevenueSummaryLine(
    summary: FinanceTokenPlanSummaryRow,
    row: FinanceTokenPlanLine,
  ): void {
    summary.lineCount += 1;
    summary.orderAmountCents += row.orderAmountCents;
    summary.openingDeferredCents += row.openingDeferredCents;
    summary.newDeferredCents += row.newDeferredCents;
    summary.serviceRecognizedRevenueCents += row.serviceRecognizedRevenueCents;
    summary.refundAppliedToDeferredCents += row.refundAppliedToDeferredCents;
    summary.refundRevenueReversalCents += row.refundRevenueReversalCents;
    summary.recognizedRevenueCents += row.recognizedRevenueCents;
    summary.closingDeferredCents += row.closingDeferredCents;
    summary.recognizedToDateCents += row.recognizedToDateCents;
    summary.refundAmountCents += row.refundAmountCents;
  }

  private createFinanceGroupedSpillRow(
    sourceRow: Record<string, unknown>,
    groupKeys: readonly string[],
    sumKeys: readonly string[],
    carryKeys: readonly string[],
  ): FinanceGroupedSpillRow {
    const key = groupKeys.map((groupKey) => (
      groupKey === 'userId'
        ? this.requireFinanceSummaryUserId(sourceRow)
        : String(sourceRow[groupKey] ?? '')
    )).join('\u0000');
    const outputKeys = Array.from(new Set([...groupKeys, ...carryKeys]));
    const state: FinanceGroupedState = {
      row: Object.fromEntries(outputKeys.map((outputKey) => [outputKey, sourceRow[outputKey] ?? ''])),
      rawUsd: new Map<string, Prisma.Decimal>(),
      rawUsdKeys: new Set<string>(),
    };
    for (const sumKey of sumKeys) this.addFinanceGroupedValue(state, sumKey, sourceRow);
    return this.serializeFinanceGroupedState(key, state);
  }

  private createFinanceSummarySqlFact(
    sourceRow: Record<string, unknown>,
    groupKeys: readonly string[],
    sumKeys: readonly string[],
    carryKeys: readonly string[],
    rawUsdSumKeys: ReadonlySet<string>,
    options: {
      resultSortKey?: string;
      dimensionOrder?: string;
      distinctKey?: string | null;
    } = {},
  ): FinanceSummarySqlFact {
    const groupKeyParts = groupKeys.map((groupKeyPart) => (
      groupKeyPart === 'userId'
        ? this.requireFinanceSummaryUserId(sourceRow)
        : String(sourceRow[groupKeyPart] ?? '')
    ));
    const groupKey = JSON.stringify(groupKeyParts);
    const outputKeys = Array.from(new Set([...groupKeys, ...carryKeys]));
    const sums = Object.fromEntries(sumKeys.map((sumKey) => {
      const value = sourceRow[sumKey];
      if (value === null || value === undefined) return [sumKey, null];
      const rawUsd = this.getFinanceRawUsd(sourceRow, sumKey);
      if (rawUsd !== null) return [sumKey, rawUsd.toString()];
      if (rawUsdSumKeys.has(sumKey)) {
        return [sumKey, centsToUsd(Number(value ?? 0)).toString()];
      }
      return [sumKey, String(Number(value ?? 0))];
    }));
    return {
      groupKey,
      resultSortKey: options.resultSortKey ?? groupKey,
      dimensionOrder: options.dimensionOrder ?? groupKey,
      dimensions: Object.fromEntries(
        outputKeys.map((outputKey) => [outputKey, sourceRow[outputKey] ?? '']),
      ),
      sums,
      rawUsdKeys: Array.from(rawUsdSumKeys),
      distinctKey: options.distinctKey ?? null,
    };
  }

  private materializeFinanceSummarySqlRow(
    sqlRow: FinanceSummarySqlRow,
    sumKeys: readonly string[],
  ): Record<string, unknown> {
    const row: Record<string, unknown> = { ...sqlRow.dimensions };
    const rawUsd: Record<string, Prisma.Decimal> = {};
    for (const sumKey of sumKeys) {
      const value = sqlRow.sums[sumKey];
      if (value === null || value === undefined) {
        row[sumKey] = null;
        continue;
      }
      if (sqlRow.rawUsdKeys[sumKey]) {
        const decimal = usd(value);
        row[sumKey] = usdToCents(decimal);
        rawUsd[sumKey] = decimal;
      } else {
        row[sumKey] = Number(value);
      }
    }
    return this.withFinanceRawUsd(row, rawUsd);
  }

  private createFinanceRawSpillRow(
    key: string,
    row: Record<string, unknown>,
  ): FinanceGroupedSpillRow {
    const rawUsd = (row as FinanceRawUsdRow)[FINANCE_RAW_USD] ?? {};
    return {
      key,
      row: { ...row },
      rawUsd: Object.fromEntries(
        Object.entries(rawUsd).map(([sumKey, value]) => [sumKey, value.toString()]),
      ),
    };
  }

  private mergeFinanceGroupedSpillRows(
    left: FinanceGroupedSpillRow,
    right: FinanceGroupedSpillRow,
    sumKeys: readonly string[],
  ): FinanceGroupedSpillRow {
    const state = this.deserializeFinanceGroupedState(left);
    const sourceRow = this.materializeFinanceGroupedSpillRow(right);
    for (const sumKey of sumKeys) this.addFinanceGroupedValue(state, sumKey, sourceRow);
    return this.serializeFinanceGroupedState(left.key, state);
  }

  private serializeFinanceGroupedState(
    key: string,
    state: FinanceGroupedState,
  ): FinanceGroupedSpillRow {
    return {
      key,
      row: state.row,
      rawUsd: Object.fromEntries(
        Array.from(state.rawUsd.entries()).map(([sumKey, value]) => [sumKey, value.toString()]),
      ),
    };
  }

  private deserializeFinanceGroupedState(row: FinanceGroupedSpillRow): FinanceGroupedState {
    return {
      row: { ...row.row },
      rawUsd: new Map(
        Object.entries(row.rawUsd).map(([sumKey, value]) => [sumKey, usd(value)]),
      ),
      rawUsdKeys: new Set(Object.keys(row.rawUsd)),
    };
  }

  private materializeFinanceGroupedSpillRow(row: FinanceGroupedSpillRow): Record<string, unknown> {
    return this.withFinanceRawUsd(
      { ...row.row },
      Object.fromEntries(
        Object.entries(row.rawUsd).map(([sumKey, value]) => [sumKey, usd(value)]),
      ),
    );
  }

  private financeExportStorageDirectory(): string {
    const configured = process.env.FINANCE_EXPORT_STORAGE_DIR?.trim();
    if (configured) return resolve(configured);
    if (process.env.NODE_ENV === 'production' || process.env.APP_ENV === 'production') {
      throw new InternalServerErrorException(
        'FINANCE_EXPORT_STORAGE_DIR is required for production finance exports',
      );
    }
    return resolve(process.cwd(), 'var', 'finance-exports');
  }

  private financeExportHeartbeatIntervalMs(): number {
    const raw = Number(process.env.FINANCE_EXPORT_JOB_HEARTBEAT_INTERVAL_MS);
    return Number.isFinite(raw) && raw >= 1000
      ? Math.floor(raw)
      : FINANCE_EXPORT_HEARTBEAT_INTERVAL_MS;
  }

  private startFinanceExportHeartbeat(id: string): () => void {
    let updateInFlight = false;
    const timer = setInterval(() => {
      if (updateInFlight) return;
      updateInFlight = true;
      void this.prisma.financeExportJob.updateMany({
        where: { id, status: 'RUNNING' },
        data: { heartbeatAt: new Date() },
      }).catch((error) => {
        this.logger.warn(
          `finance export heartbeat failed jobId=${id}: ${error instanceof Error ? error.message : String(error)}`,
        );
      }).finally(() => {
        updateInFlight = false;
      });
    }, this.financeExportHeartbeatIntervalMs());
    timer.unref?.();
    return () => clearInterval(timer);
  }

  private assertManagedFinanceExportPath(path: string): void {
    const storageDirectory = this.financeExportStorageDirectory();
    const relativePath = relative(storageDirectory, resolve(path));
    if (
      relativePath === ''
      || relativePath.startsWith('..')
      || isAbsolute(relativePath)
    ) {
      throw new Error(`finance export path is outside managed storage: ${path}`);
    }
  }

  private async removeFinanceExportFile(path: string): Promise<void> {
    await unlink(path).catch((error: NodeJS.ErrnoException) => {
      if (error.code !== 'ENOENT') throw error;
    });
  }

  private classifyFinanceExportError(error: unknown): { code: string; message: string } {
    const message = error instanceof Error ? error.message : String(error);
    if (error instanceof HttpException) {
      const status = error.getStatus();
      const response = error.getResponse();
      const code = response && typeof response === 'object'
        && (typeof (response as Record<string, unknown>).code === 'string'
          || typeof (response as Record<string, unknown>).code === 'number')
        ? String((response as Record<string, unknown>).code)
        : status === 429
          ? 'RATE_LIMIT_EXCEEDED'
          : status >= 500
            ? 'UPSTREAM_ERROR'
            : 'VALIDATION_ERROR';
      const responseMessage = response && typeof response === 'object'
        && typeof (response as Record<string, unknown>).message === 'string'
        ? String((response as Record<string, unknown>).message)
        : message;
      return { code, message: responseMessage };
    }
    if ((error as NodeJS.ErrnoException)?.code === 'ENOSPC') {
      return { code: 'EXPORT_STORAGE_FULL', message: '导出存储空间不足' };
    }
    return { code: 'INTERNAL_ERROR', message };
  }

  async backfillStripePaymentLedgers(params: {
    month?: string;
    limit?: number;
    dryRun?: boolean;
  } = {}) {
    const { monthKey, start, end } = this.resolveMonthRange(params.month);
    const result = await this.paymentService.backfillStripePaymentLedgers({
      start,
      end,
      limit: params.limit,
      dryRun: params.dryRun,
    });
    return {
      month: monthKey,
      ...result,
    };
  }

  private async collectFinanceExportRows(params: {
    month: string;
    tab: string;
    billingMode?: string;
  }): Promise<Record<string, unknown>[]> {
    const tab = this.resolveFinanceReportDetailTab(params.tab);
    if (FINANCE_BALANCE_LEDGER_REPORT_TABS.has(tab)) {
      return this.withFinanceReportReadSnapshot(
        (snapshot) => this.collectBalanceLedgerFinanceExportRows(params, tab, snapshot),
        FINANCE_EXPORT_SNAPSHOT_TIMEOUT_MS,
      );
    }
    const rows: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    for (;;) {
      const detail = await this.getFinanceReportDetail({
        month: params.month,
        tab,
        billingMode: params.billingMode,
        pageSize: FINANCE_REPORT_DETAIL_MAX_PAGE_SIZE,
        cursor,
      });
      const detailRows = detail.rows as Record<string, unknown>[];
      rows.push(...detailRows);
      this.assertFinanceExportRowLimit(rows.length);
      const nextCursor = this.resolveFinanceReportCollectionNextCursor(
        detail.pagination,
        cursor,
        seenCursors,
      );
      if (nextCursor === null) break;
      cursor = nextCursor;
    }
    return rows;
  }

  private async collectBalanceLedgerFinanceExportRows(
    params: {
      month: string;
      tab: string;
      billingMode?: string;
    },
    tab: FinanceReportDetailTab,
    snapshot: FinanceReportReadSnapshot,
  ): Promise<Record<string, unknown>[]> {
    const rows: Record<string, unknown>[] = [];
    let cursor: string | undefined;
    const seenCursors = new Set<string>();
    for (;;) {
      const detail = await this.getBalanceLedgerFinanceReportDetail({
        month: params.month,
        tab,
        billingMode: params.billingMode,
        pageSize: FINANCE_REPORT_DETAIL_MAX_PAGE_SIZE,
        cursor,
        filter: null,
      }, tab, snapshot);
      const detailRows = detail.rows as Record<string, unknown>[];
      rows.push(...detailRows);
      this.assertFinanceExportRowLimit(rows.length);
      const nextCursor = this.resolveFinanceReportCollectionNextCursor(
        detail.pagination,
        cursor,
        seenCursors,
      );
      if (nextCursor === null) break;
      cursor = nextCursor;
    }
    return rows;
  }

  private async collectFinanceUserCurrencySummaryRows(params: {
    month: string;
    tab: FinanceUserCurrencySummaryTab;
    billingMode?: string;
    start?: Date;
    end?: Date;
    asOf?: Date;
    platformCurrencyCode?: string;
    filter?: FinanceReportFilter | null;
  }, db: FinanceReadClient = this.prisma): Promise<Record<string, unknown>[]> {
    const config = FINANCE_USER_CURRENCY_SUMMARY_CONFIG[params.tab];
    const monthRange = this.resolveMonthRange(params.month);
    const monthKey = monthRange.monthKey;
    const start = params.start ?? monthRange.start;
    const end = params.end ?? monthRange.end;
    const billingMode = this.resolveFinanceReportBillingMode(params.billingMode);
    const groups = new Map<string, FinanceGroupedState>();
    let cursorToken: string | undefined;
    let cursor: FinanceReportCursor | null = null;
    const seenCursors = new Set<string>();
    for (;;) {
      const grantPage = await this.loadFinanceBalanceGrantCursorPage({
        start,
        end,
        billingMode,
        tab: config.detailTab,
        pageSize: FINANCE_REPORT_DETAIL_MAX_PAGE_SIZE,
        cursor,
        filter: params.filter,
      }, db);
      const templates = await this.buildFinanceTemplatesForGrants(
        monthKey,
        start,
        end,
        grantPage.pageRows,
        db,
        params.asOf,
        params.platformCurrencyCode,
      );
      const summaryRows = params.tab === 'buyGiftAccountSummary'
        ? templates.buyGift.accountChangeSummary
        : templates.buyGift.paymentSummary;
      this.addFinanceGroupedRows(
        groups,
        summaryRows,
        ['userId', 'currency'],
        config.sumKeys,
        ['userLabel'],
      );
      const nextCursor = this.resolveFinanceReportCollectionNextCursor(
        {
          hasMore: grantPage.hasMore,
          nextCursor: grantPage.hasMore
            ? this.encodeFinanceReportRowCursor(
              grantPage.pageRows.at(-1),
              'internal-user-currency-summary',
            )
            : null,
        },
        cursorToken,
        seenCursors,
      );
      if (nextCursor === null) break;
      cursorToken = nextCursor;
      cursor = this.decodeFinanceReportCursor(nextCursor, 'internal-user-currency-summary');
    }
    return this.materializeFinanceGroupedRows(groups);
  }

  private async collectFinanceConsumptionSummaryRows(params: {
    month: string;
    tab: FinanceConsumptionSummaryTab;
    billingMode?: string;
    start?: Date;
    end?: Date;
    filter?: FinanceReportFilter | null;
  },
  db: FinanceReadClient = this.prisma,
  validatedGrantIds?: Set<string>,
  ): Promise<Record<string, unknown>[]> {
    const config = FINANCE_CONSUMPTION_SUMMARY_CONFIG[params.tab];
    const monthRange = this.resolveMonthRange(params.month);
    const start = params.start ?? monthRange.start;
    const end = params.end ?? monthRange.end;
    const billingMode = this.resolveFinanceReportBillingMode(params.billingMode);
    const groups = new Map<string, FinanceGroupedState>();
    let cursorToken: string | undefined;
    let cursor: FinanceReportCursor | null = null;
    const seenCursors = new Set<string>();
    for (;;) {
      const page = await this.loadFinanceGiftConsumptionPage({
        monthKey: monthRange.monthKey,
        start,
        end,
        billingMode,
        tab: config.detailTab,
        pageSize: FINANCE_REPORT_DETAIL_MAX_PAGE_SIZE,
        cursor,
        projection: 'summary',
        filter: params.filter,
        scopeHash: 'internal-consumption-summary',
      }, db, validatedGrantIds);
      const detailRows = page.items;
      this.addFinanceGroupedRows(
        groups,
        detailRows,
        ['userId', 'model'],
        config.sumKeys,
        ['userLabel'],
      );
      const nextCursor = this.resolveFinanceReportCollectionNextCursor(
        {
          hasMore: page.hasMore,
          nextCursor: page.hasMore
            ? page.nextCursor ?? this.encodeFinanceReportRowCursor(
              page.pageRows.at(-1),
              'internal-consumption-summary',
            )
            : null,
        },
        cursorToken,
        seenCursors,
      );
      if (nextCursor === null) break;
      cursorToken = nextCursor;
      cursor = this.decodeFinanceReportCursor(nextCursor, 'internal-consumption-summary');
    }
    return this.materializeFinanceGroupedRows(groups);
  }

  private assertFinanceExportRowLimit(rowCount: number): void {
    if (rowCount > FINANCE_EXPORT_MAX_ROWS) {
      throw new BadRequestException(
        `财务报表明细超过 ${FINANCE_EXPORT_MAX_ROWS} 行，请缩小账期或筛选范围`,
      );
    }
  }

  private resolveFinanceReportCollectionNextCursor(
    pagination: { hasMore: boolean; nextCursor?: string | null },
    currentCursor: string | undefined,
    seenCursors: Set<string>,
  ): string | null {
    if (!pagination.hasMore) return null;
    const nextCursor = pagination.nextCursor;
    if (!nextCursor) {
      throw new InternalServerErrorException(
        'FINANCE_REPORT_INTERNAL_CURSOR_INVALID:missing_next_cursor',
      );
    }
    if (nextCursor === currentCursor || seenCursors.has(nextCursor)) {
      throw new InternalServerErrorException(
        'FINANCE_REPORT_INTERNAL_CURSOR_INVALID:cursor_not_advancing',
      );
    }
    seenCursors.add(nextCursor);
    return nextCursor;
  }

  private buildFinanceExportCsv(tab: FinanceReportDetailTab, rows: Record<string, unknown>[]): string {
    const columns = this.getFinanceExportColumns(tab, rows);
    const header = columns.map((column) => this.escapeCsvCell(this.formatFinanceExportHeader(column))).join(',');
    const body = rows.map((row) =>
      columns.map((column) => this.escapeCsvCell(this.formatFinanceExportValue(column.key, row[column.key], row))).join(','),
    );
    return ['\uFEFF' + header, ...body].join('\n');
  }

  private formatFinanceExportHeader(column: FinanceExportColumn): string {
    if (!this.isFinanceExportMajorUnitKey(column.key)) return column.title;
    if (column.title.includes(FINANCE_EXPORT_MAJOR_UNIT_SUFFIX)) return column.title;
    return `${column.title}${FINANCE_EXPORT_MAJOR_UNIT_SUFFIX}`;
  }

  private getFinanceExportColumns(tab: FinanceReportDetailTab, rows: Record<string, unknown>[]): FinanceExportColumn[] {
    const configuredColumns = FINANCE_EXPORT_COLUMNS_BY_TAB[tab];
    if (configuredColumns) return configuredColumns;
    const keys = new Set<string>();
    for (const row of rows) {
      for (const key of Object.keys(row)) {
        if (key !== FINANCE_RAW_MAJOR_UNIT_AMOUNTS) keys.add(key);
      }
    }
    if (keys.size === 0) {
      ['period', 'billingMode', 'productName', 'orderId', 'usageId', 'amountCents', 'createdAt'].forEach((key) => keys.add(key));
    }
    return [...keys].map((key) => ({
      key,
      title: FINANCE_EXPORT_HEADER_TITLES[key] ?? key,
    }));
  }

  private buildFinanceApiUsageTokenRows(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    const tokenParts = [
      { type: 'input', tokensKey: 'regularInputTokens', priceKey: 'inputUnitPrice' },
      {
        type: 'cache read',
        tokensKey: 'cachedInputTokens',
        priceKey: 'cacheReadUnitPrice',
        fallbackPriceKey: 'inputUnitPrice',
      },
      {
        type: 'cache write',
        tokensKey: 'cacheWriteInputTokens',
        priceKey: 'cacheWriteUnitPrice',
        fallbackPriceKey: 'inputUnitPrice',
      },
      { type: 'output', tokensKey: 'outputTokens', priceKey: 'outputUnitPrice' },
    ];
    return rows.flatMap((row) => {
      const parts = tokenParts.flatMap((part) => {
        const tokens = Number(row[part.tokensKey] ?? 0);
        if (!Number.isFinite(tokens) || tokens <= 0) return [];
        const configuredUnitPrice = row[part.priceKey];
        const fallbackUnitPrice = part.fallbackPriceKey == null
          ? null
          : row[part.fallbackPriceKey];
        const unitPriceValue = configuredUnitPrice ?? fallbackUnitPrice;
        const unitPrice = unitPriceValue === null || unitPriceValue === undefined
          ? null
          : this.financePositiveDecimal(unitPriceValue);
        const priceBasis = unitPrice?.gt(0)
          ? usd(tokens).mul(unitPrice).div(1_000_000)
          : usd(0);
        return [{ ...part, tokens, unitPrice, priceBasis }];
      });
      if (parts.length === 0) {
        const totalTokens = Number(row.totalTokens ?? 0);
        const userChargeUsd = this.financePositiveDecimal(row.userChargeUsd);
        const paymentDeductionUsd = this.financePositiveDecimal(row.paymentDeductionUsd);
        const voucherDeductionUsd = this.financePositiveDecimal(row.voucherDeductionUsd);
        const creditDeductionUsd = this.financePositiveDecimal(row.creditDeductionUsd);
        const debtDeductionUsd = this.financePositiveDecimal(row.debtDeductionUsd);
        const supplierCost = this.financePositiveDecimal(
          this.getFinanceRawUsd(row, 'supplierCostCents') ?? row.supplierCostCents,
        );
        const hasFinancialMovement = userChargeUsd.gt(0)
          || paymentDeductionUsd.gt(0)
          || voucherDeductionUsd.gt(0)
          || creditDeductionUsd.gt(0)
          || debtDeductionUsd.gt(0)
          || supplierCost.gt(0);
        if ((!Number.isFinite(totalTokens) || totalTokens <= 0) && !hasFinancialMovement) {
          return [];
        }
        return [{
          ...row,
          rowId: `${row.usageId ?? row.id ?? 'usage'}-total`,
          tokenType: 'total',
          tokens: Number.isFinite(totalTokens) ? totalTokens : 0,
          unitPriceUsdPerM: totalTokens > 0
            ? userChargeUsd.mul(1_000_000).div(totalTokens).toDecimalPlaces(8).toNumber()
            : 0,
          userChargeUsd: userChargeUsd.toNumber(),
          paymentDeductionUsd: paymentDeductionUsd.toNumber(),
          voucherDeductionUsd: voucherDeductionUsd.toNumber(),
          creditDeductionUsd: creditDeductionUsd.toNumber(),
          debtDeductionUsd: debtDeductionUsd.toNumber(),
          roundingAdjustmentUsd: 0,
        }];
      }
      const rowChargeUsd = this.financePositiveDecimal(row.userChargeUsd);
      const paymentTotal = this.financePositiveDecimal(row.paymentDeductionUsd);
      const voucherTotal = this.financePositiveDecimal(row.voucherDeductionUsd);
      const creditTotal = this.financePositiveDecimal(row.creditDeductionUsd);
      const debtTotal = this.financePositiveDecimal(row.debtDeductionUsd);
      const priceBasisTotal = parts.reduce(
        (sum, part) => sum.plus(part.priceBasis),
        usd(0),
      );
      const tokenBasisTotal = parts.reduce(
        (sum, part) => sum.plus(part.tokens),
        usd(0),
      );
      const basisTotal = priceBasisTotal.gt(0) ? priceBasisTotal : tokenBasisTotal;
      let allocatedCharge = usd(0);
      let allocatedPayment = usd(0);
      let allocatedVoucher = usd(0);
      let allocatedCredit = usd(0);
      let allocatedDebt = usd(0);
      return parts.map((part, index) => {
        const isLast = index === parts.length - 1;
        const basis = priceBasisTotal.gt(0) ? part.priceBasis : usd(part.tokens);
        const userChargeUsd = this.prorateFinanceExportAmount(
          rowChargeUsd,
          basis,
          basisTotal,
          allocatedCharge,
          isLast,
        );
        allocatedCharge = this.roundFinanceExportAmount(allocatedCharge.plus(userChargeUsd));
        const hasSplit = paymentTotal.gt(0) || voucherTotal.gt(0) || creditTotal.gt(0) || debtTotal.gt(0);
        const paymentDeductionUsd = hasSplit
          ? this.prorateFinanceExportAmount(paymentTotal, userChargeUsd, rowChargeUsd, allocatedPayment, isLast)
          : userChargeUsd;
        const voucherDeductionUsd = hasSplit
          ? this.prorateFinanceExportAmount(voucherTotal, userChargeUsd, rowChargeUsd, allocatedVoucher, isLast)
          : usd(0);
        const creditDeductionUsd = this.prorateFinanceExportAmount(
          creditTotal,
          userChargeUsd,
          rowChargeUsd,
          allocatedCredit,
          isLast,
        );
        const debtDeductionUsd = this.prorateFinanceExportAmount(
          debtTotal,
          userChargeUsd,
          rowChargeUsd,
          allocatedDebt,
          isLast,
        );
        allocatedPayment = this.roundFinanceExportAmount(allocatedPayment.plus(paymentDeductionUsd));
        allocatedVoucher = this.roundFinanceExportAmount(allocatedVoucher.plus(voucherDeductionUsd));
        allocatedCredit = this.roundFinanceExportAmount(allocatedCredit.plus(creditDeductionUsd));
        allocatedDebt = this.roundFinanceExportAmount(allocatedDebt.plus(debtDeductionUsd));
        const effectiveUnitPriceUsdPerM = part.tokens > 0
          ? userChargeUsd
              .mul(1_000_000)
              .div(part.tokens)
              .toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP)
          : usd(0);
        const pricedChargeUsd = this.roundFinanceExportAmount(
          effectiveUnitPriceUsdPerM.mul(part.tokens).div(1_000_000),
        );
        const roundingAdjustmentUsd = this.roundFinanceExportAmount(
          userChargeUsd.minus(pricedChargeUsd),
        );
        return {
          ...row,
          rowId: `${row.usageId ?? row.id ?? 'usage'}-${part.type}`,
          tokenType: part.type,
          tokens: part.tokens,
          // Historical token_usage rows may contain the pre-customer-policy bucket price.
          // Export an 8-decimal realized price and expose its 12-decimal rounding tail
          // separately so price * tokens / 1M + adjustment equals the actual charge.
          unitPriceUsdPerM: effectiveUnitPriceUsdPerM.toNumber(),
          userChargeUsd: userChargeUsd.toNumber(),
          roundingAdjustmentUsd: roundingAdjustmentUsd.toNumber(),
          paymentDeductionUsd: paymentDeductionUsd.toNumber(),
          voucherDeductionUsd: voucherDeductionUsd.toNumber(),
          creditDeductionUsd: creditDeductionUsd.toNumber(),
          debtDeductionUsd: debtDeductionUsd.toNumber(),
        };
      });
    });
  }

  private prorateFinanceExportAmount(
    total: Prisma.Decimal,
    basis: Prisma.Decimal,
    basisTotal: Prisma.Decimal,
    allocatedBefore: Prisma.Decimal,
    isLast: boolean,
  ): Prisma.Decimal {
    const normalizedTotal = this.roundFinanceExportAmount(total);
    if (normalizedTotal.lte(0)) return usd(0);
    if (isLast) {
      return this.roundFinanceExportAmount(
        Prisma.Decimal.max(0, normalizedTotal.minus(allocatedBefore)),
      );
    }
    if (basisTotal.lte(0) || basis.lte(0)) return usd(0);
    return this.roundFinanceExportAmount(normalizedTotal.mul(basis).div(basisTotal));
  }

  private financePositiveDecimal(value: unknown): Prisma.Decimal {
    try {
      const decimal = usd(value == null ? 0 : String(value));
      return decimal.isFinite() && decimal.gt(0) ? decimal : usd(0);
    } catch {
      return usd(0);
    }
  }

  private financeCustomerMultiplier(usage: any): number | null {
    const snapshot = usage.gatewayBillingEvent?.settlementAnchor?.customerPricingSnapshot;
    if (snapshot == null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
    const value = (snapshot as Record<string, unknown>).customerMultiplier;
    if (typeof value !== 'string' && typeof value !== 'number') return null;
    try {
      const multiplier = new Prisma.Decimal(value);
      return multiplier.isFinite() && multiplier.gte(0) ? multiplier.toNumber() : null;
    } catch {
      return null;
    }
  }

  private financeApiUsageChargeSource(usage: any, creditDeductionUsd: Prisma.Decimal): string | null {
    if (creditDeductionUsd.gt(0)) return 'enterprise_credit_receivable';

    const policy = usage.customerChargePolicy ?? null;
    if (policy === 'legacy_cost_usd' || policy === 'usage_charge') return policy;

    const hasUnapprovedDebt = this.financePositiveDecimal(usage.customerUnapprovedDebtUsd).gt(0);
    switch (usage.product?.billingMode) {
      case ProductBillingMode.PAY_AS_YOU_GO:
        if (hasUnapprovedDebt) return 'debt_open';
        return this.financePositiveDecimal(usage.customerApprovedReceivableUsd).gt(0)
          ? 'enterprise_credit_receivable'
          : 'payg_balance';
      case ProductBillingMode.SUBSCRIPTION:
        return hasUnapprovedDebt ? 'debt_open' : 'subscription_credits';
      case ProductBillingMode.CODING_PLAN: {
        const snapshot = usage.gatewayBillingEvent?.settlementAnchor?.customerPricingSnapshot;
        const includedUpstream = policy === 'included_upstream'
          || (snapshot != null && typeof snapshot === 'object' && !Array.isArray(snapshot)
            && snapshot.includedUpstream === true);
        return includedUpstream ? 'included_upstream' : 'subscription_credits';
      }
      default:
        return policy;
    }
  }

  private roundFinanceExportAmount(value: Prisma.Decimal): Prisma.Decimal {
    return value.isFinite()
      ? value.toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP)
      : usd(0);
  }

  private formatFinanceExportValue(key: string, value: unknown, row?: Record<string, unknown>): string {
    if (value === null || value === undefined) return '';
    if (key === 'customerMultiplier') {
      const multiplier = Number(value);
      return value !== '' && Number.isFinite(multiplier) && multiplier >= 0
        ? multiplier.toFixed(2)
        : '';
    }
    if (this.isFinanceExportMinorUnitKey(key)) return this.formatCentsAsMajorUnit(value, row ? this.getFinanceRawUsd(row, key) : null);
    if (value instanceof Date) return this.formatShanghaiDateTime(value);
    if (key.endsWith('At') && (typeof value === 'string' || typeof value === 'number')) {
      const date = new Date(value);
      if (!Number.isNaN(date.getTime())) return this.formatShanghaiDateTime(date);
    }
    if (typeof value === 'object') {
      if ('toString' in value && value.constructor?.name === 'Decimal') return value.toString();
      return JSON.stringify(value);
    }
    return String(value);
  }

  private isFinanceExportMajorUnitKey(key: string): boolean {
    return this.isFinanceExportMinorUnitKey(key) || FINANCE_EXPORT_MAJOR_UNIT_KEYS.has(key);
  }

  private isFinanceExportMinorUnitKey(key: string): boolean {
    return key.endsWith('Cents');
  }

  private formatCentsAsMajorUnit(value: unknown, rawMajorUnit?: Prisma.Decimal | null): string {
    if (rawMajorUnit) return this.trimDecimalZeros(rawMajorUnit.toFixed(12));
    const cents = Number(value ?? 0);
    if (!Number.isFinite(cents)) return '';
    return this.trimDecimalZeros((cents / 100).toFixed(12));
  }

  private formatShanghaiDateTime(date: Date): string {
    const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
    const year = shifted.getUTCFullYear();
    const month = String(shifted.getUTCMonth() + 1).padStart(2, '0');
    const day = String(shifted.getUTCDate()).padStart(2, '0');
    const hour = String(shifted.getUTCHours()).padStart(2, '0');
    const minute = String(shifted.getUTCMinutes()).padStart(2, '0');
    const second = String(shifted.getUTCSeconds()).padStart(2, '0');
    return `${year}-${month}-${day} ${hour}:${minute}:${second}`;
  }

  private trimDecimalZeros(value: string): string {
    return value.replace(/(\.\d*?)0+$/u, '$1').replace(/\.$/u, '');
  }

  private escapeCsvCell(value: string): string {
    if (/[",\n\r]/u.test(value)) return `"${value.replace(/"/g, '""')}"`;
    return value;
  }

  private buildFinanceExportFilename(
    month: string,
    tab: FinanceReportDetailTab,
    billingMode?: FinanceReportBillingMode,
  ): string {
    const mode = billingMode ?? 'ALL';
    return `finance-${month}-${mode}-${tab}.csv`;
  }

  private serializeFinanceExportJob(job: {
    id: string;
    month: string;
    tab: string;
    billingMode?: string | null;
    status: string;
    filename: string;
    contentType: string;
    rowCount: number;
    fileSizeBytes?: bigint | null;
    fileSha256?: string | null;
    processedRows?: number;
    totalRows?: number | null;
    asOf?: Date | null;
    heartbeatAt?: Date | null;
    errorCode?: string | null;
    failedStage?: string | null;
    errorMessage?: string | null;
    requestedByAdminId?: string | null;
    startedAt?: Date | null;
    finishedAt?: Date | null;
    expiresAt?: Date | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: job.id,
      month: job.month,
      tab: job.tab,
      billingMode: job.billingMode,
      status: job.status as FinanceExportJobStatus,
      filename: job.filename,
      contentType: job.contentType,
      rowCount: job.rowCount,
      fileSizeBytes: job.fileSizeBytes == null ? null : Number(job.fileSizeBytes),
      fileSha256: job.fileSha256 ?? null,
      processedRows: job.processedRows ?? 0,
      totalRows: job.totalRows ?? null,
      asOf: job.asOf?.toISOString() ?? null,
      heartbeatAt: job.heartbeatAt?.toISOString() ?? null,
      errorCode: job.errorCode ?? null,
      failedStage: job.failedStage ?? null,
      errorMessage: job.errorMessage,
      requestedByAdminId: job.requestedByAdminId,
      startedAt: job.startedAt?.toISOString() ?? null,
      finishedAt: job.finishedAt?.toISOString() ?? null,
      expiresAt: job.expiresAt?.toISOString() ?? null,
      createdAt: job.createdAt.toISOString(),
      updatedAt: job.updatedAt.toISOString(),
    };
  }

  private async buildTokenPlanRevenueRecognition(params: {
    monthKey: string;
    start: Date;
    end: Date;
    billingMode: FinanceRevenueRecognitionMode;
    orders: Array<any>;
  }, db: FinanceReadClient = this.prisma) {
    const platformCurrencyCode = await this.getPlatformCurrencyCode(db);
    const region = await this.getFinanceReportRegion(db);
    const entitlementLookupIds = [
      ...new Set(
        params.orders.flatMap((order) => [
          order.id,
          ...(order.items ?? []).map((item: { id: string }) => item.id),
        ]),
      ),
    ];
    const entitlements = params.billingMode === ProductBillingMode.CODING_PLAN && entitlementLookupIds.length
      ? await db.codingPlanEntitlement.findMany({
          where: { orderId: { in: entitlementLookupIds } },
          select: {
            id: true,
            orderId: true,
            billingPeriod: true,
            fulfillmentMode: true,
            status: true,
            startedAt: true,
            expiresAt: true,
            providerEntitlementId: true,
            providerLineCode: true,
            providerCode: true,
            upstreamProductId: true,
          },
        })
      : [];
    const entitlementByOrderId = new Map(
      (entitlements as FinanceTokenPlanEntitlementRow[]).map((entitlement) => [entitlement.orderId, entitlement]),
    );

    const details = params.orders
      .flatMap((order) => this.buildTokenPlanRevenueLinesForOrder({
        monthKey: params.monthKey,
        start: params.start,
        end: params.end,
        billingMode: params.billingMode,
        order,
        entitlementByOrderId,
        platformCurrencyCode,
        region,
      }))
      .filter((row) => this.shouldIncludeTokenPlanRevenueLine(row))
      .sort((left, right) => this.compareFinanceTokenPlanRevenueLines(left, right));

    return {
      summary: this.summarizeTokenPlanRevenue(details),
      details,
      notes: this.getRevenueRecognitionNotes(params.billingMode),
    };
  }

  private getRevenueRecognitionNotes(billingMode: FinanceRevenueRecognitionMode) {
    const subject = billingMode === ProductBillingMode.SUBSCRIPTION ? '订阅' : 'CodingPlan';
    return [
        {
          field: 'recognizedRevenueCents',
          status: '已按服务期派生',
          note: '本期净确认收入=服务期直线确认收入-退款冲减已确认收入；供应商成本不在本表处理。',
        },
        {
          field: 'serviceStartAt/serviceEndAt',
          status: '已有兜底',
          note: `${subject} 优先使用权益服务期；缺失时使用订单完成/支付时间加套餐有效期。`,
        },
        {
          field: 'refundAppliedToDeferredCents',
          status: '保守口径',
          note: '退款优先冲未履约递延收入，超出部分进入退款冲减已确认收入。',
        },
      ];
  }

  private buildTokenPlanRevenueLinesForOrder(params: {
    monthKey: string;
    start: Date;
    end: Date;
    billingMode: FinanceRevenueRecognitionMode;
    order: any;
    entitlementByOrderId: Map<string, FinanceTokenPlanEntitlementRow>;
    platformCurrencyCode: string;
    region?: PlatformRegion;
  }): FinanceTokenPlanLine[] {
    const order = params.order;
    const codingItems = (order.items ?? []).filter((item: any) =>
      this.isRevenueRecognitionProduct(params.billingMode, item.product, item.plan),
    );
    if (codingItems.length > 0) {
      return codingItems.map((item: any) => this.buildTokenPlanRevenueLine({
        monthKey: params.monthKey,
        start: params.start,
        end: params.end,
        billingMode: params.billingMode,
        order,
        orderItem: item,
        entitlement: params.entitlementByOrderId.get(item.id) ?? params.entitlementByOrderId.get(order.id) ?? null,
        platformCurrencyCode: params.platformCurrencyCode,
        region: params.region,
      }));
    }
    if (!this.isRevenueRecognitionProduct(params.billingMode, order.product, order.plan)) return [];
    return [
      this.buildTokenPlanRevenueLine({
        monthKey: params.monthKey,
        start: params.start,
        end: params.end,
        billingMode: params.billingMode,
        order,
        orderItem: null,
        entitlement: params.entitlementByOrderId.get(order.id) ?? null,
        platformCurrencyCode: params.platformCurrencyCode,
        region: params.region,
      }),
    ];
  }

  private buildTokenPlanRevenueLine(params: {
    monthKey: string;
    start: Date;
    end: Date;
    billingMode: FinanceRevenueRecognitionMode;
    order: any;
    orderItem: any | null;
    entitlement: FinanceTokenPlanEntitlementRow | null;
    platformCurrencyCode: string;
    region?: PlatformRegion;
  }): FinanceTokenPlanLine {
    const { order, orderItem, entitlement } = params;
    const plan = orderItem?.plan ?? order.plan ?? null;
    const product = orderItem?.product ?? order.product ?? plan?.product ?? null;
    const billingPeriod = this.resolveTokenPlanBillingPeriod(order, orderItem, plan, entitlement);
    const serviceStartAt = this.resolveTokenPlanServiceStart(order, entitlement);
    const serviceEndAt = this.resolveTokenPlanServiceEnd(serviceStartAt, orderItem, plan, entitlement, billingPeriod);
    const totalServiceMs = Math.max(1, serviceEndAt.getTime() - serviceStartAt.getTime());
    const amountCents = this.resolveTokenPlanLineAmountCents(order, orderItem);
    const refundAmountCents = this.resolveTokenPlanLineRefundCents(order, amountCents);
    const refundAt = this.resolveTokenPlanRefundAt(order);
    const recognitionStopAt = refundAt && refundAt.getTime() < serviceEndAt.getTime()
      ? refundAt
      : serviceEndAt;
    const recognizedAtStart = this.recognizedCentsAt(amountCents, serviceStartAt, serviceEndAt, recognitionStopAt, params.start);
    const recognizedAtEnd = this.recognizedCentsAt(amountCents, serviceStartAt, serviceEndAt, recognitionStopAt, params.end);
    const serviceRecognizedRevenueCents = Math.max(0, recognizedAtEnd - recognizedAtStart);

    const refundRecognitionAt = refundAt
      ? this.recognizedCentsAt(amountCents, serviceStartAt, serviceEndAt, recognitionStopAt, refundAt)
      : 0;
    const deferredBeforeRefundCents = Math.max(0, amountCents - refundRecognitionAt);
    const refundAppliedToDeferredTotalCents = refundAt
      ? Math.min(refundAmountCents, deferredBeforeRefundCents)
      : 0;
    const refundRevenueReversalTotalCents = refundAt
      ? Math.max(0, refundAmountCents - refundAppliedToDeferredTotalCents)
      : 0;
    const refundBeforeStart = Boolean(refundAt && refundAt.getTime() < params.start.getTime());
    const refundBeforeEnd = Boolean(refundAt && refundAt.getTime() < params.end.getTime());
    const refundInPeriod = Boolean(refundAt && this.isWithinPeriod(refundAt, params.start, params.end));
    const deferredCreatedAt = this.resolveTokenPlanDeferredCreatedAt(order, serviceStartAt);

    const openingDeferredCents = deferredCreatedAt.getTime() < params.start.getTime()
      ? Math.max(0, amountCents - recognizedAtStart - (refundBeforeStart ? refundAppliedToDeferredTotalCents : 0))
      : 0;
    const newDeferredCents = this.isWithinPeriod(deferredCreatedAt, params.start, params.end) ? amountCents : 0;
    const refundAppliedToDeferredCents = refundInPeriod ? refundAppliedToDeferredTotalCents : 0;
    const refundRevenueReversalCents = refundInPeriod ? refundRevenueReversalTotalCents : 0;
    const closingDeferredCents = deferredCreatedAt.getTime() < params.end.getTime()
      ? Math.max(0, amountCents - recognizedAtEnd - (refundBeforeEnd ? refundAppliedToDeferredTotalCents : 0))
      : 0;
    const recognizedToDateCents = Math.max(
      0,
      recognizedAtEnd - (refundBeforeEnd ? refundRevenueReversalTotalCents : 0),
    );
    const recognizedRevenueCents = serviceRecognizedRevenueCents - refundRevenueReversalCents;

    return {
      period: params.monthKey,
      orderId: order.id,
      orderItemId: orderItem?.id ?? null,
      entitlementId: entitlement?.id ?? null,
      providerEntitlementId: entitlement?.providerEntitlementId ?? null,
      userId: order.userId,
      userLabel: this.formatUserLabel(
        order.user,
        order.userId,
        this.financeRowAccount(order),
        params.region,
      ),
      workspaceId: order.tenantId,
      workspaceName: order.tenant?.name ?? order.tenantId,
      workspaceType: order.tenant?.type ?? '',
      productId: product?.id ?? order.productId ?? orderItem?.productId ?? null,
      productName: product?.name ?? (params.billingMode === ProductBillingMode.SUBSCRIPTION ? '订阅产品' : 'CodingPlan'),
      planId: plan?.id ?? order.planId ?? orderItem?.planId ?? null,
      planName: plan?.name ?? orderItem?.name ?? '未绑定套餐',
      fulfillmentMode: entitlement?.fulfillmentMode ?? this.resolveTokenPlanFulfillmentMode(product, params.billingMode),
      providerLineCode: entitlement?.providerLineCode ?? null,
      providerCode: entitlement?.providerCode ?? null,
      upstreamProductId: entitlement?.upstreamProductId ?? null,
      currency: String(orderItem?.currency ?? order.currency ?? params.platformCurrencyCode).toUpperCase(),
      orderAmountCents: amountCents,
      billingPeriod,
      serviceStartAt,
      serviceEndAt,
      totalServiceDays: this.roundDayCount(totalServiceMs),
      recognizedDaysInPeriod: this.roundDayCount(
        this.overlapMs(params.start, params.end, serviceStartAt, recognitionStopAt),
      ),
      openingDeferredCents,
      newDeferredCents,
      serviceRecognizedRevenueCents,
      refundAppliedToDeferredCents,
      refundRevenueReversalCents,
      recognizedRevenueCents,
      closingDeferredCents,
      recognizedToDateCents,
      refundAmountCents: refundInPeriod ? refundAmountCents : 0,
      orderStatus: order.status,
      entitlementStatus: entitlement?.status ?? 'MISSING',
      evidence: entitlement
        ? 'orders + order_items + coding_plan_entitlements'
        : 'orders + order_items/plans fallback',
    };
  }

  private summarizeTokenPlanRevenue(details: FinanceTokenPlanLine[]) {
    const summary = new Map<string, {
      period: string;
      productId: string | null;
      productName: string;
      planId: string | null;
      planName: string;
      fulfillmentMode: string;
      currency: string;
      orderCount: number;
      lineCount: number;
      orderAmountCents: number;
      openingDeferredCents: number;
      newDeferredCents: number;
      serviceRecognizedRevenueCents: number;
      refundAppliedToDeferredCents: number;
      refundRevenueReversalCents: number;
      recognizedRevenueCents: number;
      closingDeferredCents: number;
      recognizedToDateCents: number;
      refundAmountCents: number;
      settlementStatus: string;
      notes: string;
    }>();
    const orderIdsByKey = new Map<string, Set<string>>();

    for (const row of details) {
      const key = [
        row.period,
        row.currency,
        row.productId ?? '',
        row.planId ?? '',
        row.fulfillmentMode,
      ].join('|');
      if (!summary.has(key)) {
        summary.set(key, {
          period: row.period,
          productId: row.productId,
          productName: row.productName,
          planId: row.planId,
          planName: row.planName,
          fulfillmentMode: row.fulfillmentMode,
          currency: row.currency,
          orderCount: 0,
          lineCount: 0,
          orderAmountCents: 0,
          openingDeferredCents: 0,
          newDeferredCents: 0,
          serviceRecognizedRevenueCents: 0,
          refundAppliedToDeferredCents: 0,
          refundRevenueReversalCents: 0,
          recognizedRevenueCents: 0,
          closingDeferredCents: 0,
          recognizedToDateCents: 0,
          refundAmountCents: 0,
          settlementStatus: '派生口径',
          notes: '不含供应商成本、支付手续费和税费',
        });
        orderIdsByKey.set(key, new Set());
      }
      const bucket = summary.get(key)!;
      orderIdsByKey.get(key)!.add(row.orderId);
      bucket.lineCount += 1;
      bucket.orderAmountCents += row.orderAmountCents;
      bucket.openingDeferredCents += row.openingDeferredCents;
      bucket.newDeferredCents += row.newDeferredCents;
      bucket.serviceRecognizedRevenueCents += row.serviceRecognizedRevenueCents;
      bucket.refundAppliedToDeferredCents += row.refundAppliedToDeferredCents;
      bucket.refundRevenueReversalCents += row.refundRevenueReversalCents;
      bucket.recognizedRevenueCents += row.recognizedRevenueCents;
      bucket.closingDeferredCents += row.closingDeferredCents;
      bucket.recognizedToDateCents += row.recognizedToDateCents;
      bucket.refundAmountCents += row.refundAmountCents;
    }

    return [...summary.entries()]
      .map(([key, row]) => ({
        ...row,
        orderCount: orderIdsByKey.get(key)?.size ?? 0,
        deferredVarianceCents: row.openingDeferredCents + row.newDeferredCents
          - row.serviceRecognizedRevenueCents
          - row.refundAppliedToDeferredCents
          - row.closingDeferredCents,
      }))
      .sort((a, b) => [
        a.productName,
        a.planName,
        a.productId ?? '',
        a.planId ?? '',
        a.currency,
        a.fulfillmentMode,
        a.period,
      ].join('\u0000').localeCompare([
        b.productName,
        b.planName,
        b.productId ?? '',
        b.planId ?? '',
        b.currency,
        b.fulfillmentMode,
        b.period,
      ].join('\u0000')));
  }

  private shouldIncludeTokenPlanRevenueLine(row: FinanceTokenPlanLine): boolean {
    return [
      row.openingDeferredCents,
      row.newDeferredCents,
      row.serviceRecognizedRevenueCents,
      row.refundAppliedToDeferredCents,
      row.refundRevenueReversalCents,
      row.closingDeferredCents,
    ].some((value) => value !== 0);
  }

  private isCodingPlanProduct(product?: { billingMode?: ProductBillingMode | string | null } | null, plan?: any): boolean {
    return product?.billingMode === ProductBillingMode.CODING_PLAN
      || plan?.product?.billingMode === ProductBillingMode.CODING_PLAN;
  }

  private isRevenueRecognitionProduct(
    billingMode: FinanceRevenueRecognitionMode,
    product?: { billingMode?: ProductBillingMode | string | null } | null,
    plan?: any,
  ): boolean {
    return product?.billingMode === billingMode || plan?.product?.billingMode === billingMode;
  }

  private resolveTokenPlanLineAmountCents(order: any, orderItem: any | null): number {
    if (orderItem) return Math.max(0, Number(orderItem.amountCents ?? 0));
    return Math.max(0, Number(order.amountCents ?? 0));
  }

  private resolveTokenPlanLineRefundCents(order: any, amountCents: number): number {
    const refundAmountCents = Number(order.refundAmountCents ?? 0);
    if (!Number.isFinite(refundAmountCents) || refundAmountCents <= 0) return 0;
    const orderAmountCents = Math.max(1, Number(order.amountCents ?? amountCents));
    return Math.min(amountCents, Math.round((refundAmountCents * amountCents) / orderAmountCents));
  }

  private resolveTokenPlanRefundAt(order: any): Date | null {
    if (!order.refundedAt || order.status === OrderStatus.REFUND_FAILED) return null;
    const refundAmountCents = Number(order.refundAmountCents ?? 0);
    return Number.isFinite(refundAmountCents) && refundAmountCents > 0 ? order.refundedAt : null;
  }

  private resolveTokenPlanDeferredCreatedAt(order: any, serviceStartAt: Date): Date {
    return order.paidAt ?? order.completedAt ?? serviceStartAt ?? order.createdAt;
  }

  private resolveTokenPlanServiceStart(order: any, entitlement: FinanceTokenPlanEntitlementRow | null): Date {
    return entitlement?.startedAt ?? order.completedAt ?? order.paidAt ?? order.createdAt;
  }

  private resolveTokenPlanServiceEnd(
    serviceStartAt: Date,
    orderItem: any | null,
    plan: any | null,
    entitlement: FinanceTokenPlanEntitlementRow | null,
    billingPeriod: string,
  ): Date {
    if (entitlement?.expiresAt && entitlement.expiresAt.getTime() > serviceStartAt.getTime()) {
      return entitlement.expiresAt;
    }
    const validityDays = Number(orderItem?.validityDays ?? 0) > 0
      ? Number(orderItem.validityDays)
      : Math.max(1, Number(plan?.validityDays ?? 30)) * this.billingPeriodMultiplier(billingPeriod);
    return new Date(serviceStartAt.getTime() + validityDays * DAY_MS);
  }

  private resolveTokenPlanBillingPeriod(
    order: any,
    orderItem: any | null,
    plan: any | null,
    entitlement: FinanceTokenPlanEntitlementRow | null,
  ): string {
    if (entitlement?.billingPeriod) return entitlement.billingPeriod;
    if (orderItem?.recurringInterval === 'year') return 'yearly';
    if (orderItem?.recurringInterval === 'month') return 'monthly';
    return order.billingPeriod ?? plan?.billingPeriod ?? 'monthly';
  }

  private resolveTokenPlanFulfillmentMode(
    product: any | null,
    billingMode: FinanceRevenueRecognitionMode = ProductBillingMode.CODING_PLAN,
  ): string {
    if (billingMode === ProductBillingMode.SUBSCRIPTION) return 'subscription';
    return product?.billingMode === ProductBillingMode.CODING_PLAN
      && product?.codingPlanFulfillmentMode === CodingPlanFulfillmentMode.provider_resale
      ? 'provider_resale'
      : 'platform_model_package';
  }

  private billingPeriodMultiplier(period: string | null | undefined): number {
    if (period === 'yearly') return 12;
    if (period === 'quarterly') return 3;
    return 1;
  }

  private recognizedCentsAt(
    amountCents: number,
    serviceStartAt: Date,
    serviceEndAt: Date,
    recognitionStopAt: Date,
    at: Date,
  ): number {
    const totalMs = Math.max(1, serviceEndAt.getTime() - serviceStartAt.getTime());
    const elapsedMs = this.overlapMs(serviceStartAt, recognitionStopAt, serviceStartAt, at);
    return Math.min(amountCents, Math.max(0, Math.round((amountCents * elapsedMs) / totalMs)));
  }

  private overlapMs(rangeStart: Date, rangeEnd: Date, serviceStart: Date, serviceEnd: Date): number {
    const startMs = Math.max(rangeStart.getTime(), serviceStart.getTime());
    const endMs = Math.min(rangeEnd.getTime(), serviceEnd.getTime());
    return Math.max(0, endMs - startMs);
  }

  private isWithinPeriod(date: Date, start: Date, end: Date): boolean {
    return date.getTime() >= start.getTime() && date.getTime() < end.getTime();
  }

  private roundDayCount(ms: number): number {
    return Math.round((ms / DAY_MS) * 10_000) / 10_000;
  }

  private resolveMonthRange(
    month?: string,
    fallbackAt: Date = new Date(),
  ): { monthKey: string; start: Date; end: Date } {
    const fallback = this.formatShanghaiMonthKey(fallbackAt);
    const normalized = month?.trim();
    if (
      normalized !== undefined
      && !/^(?:19|20|21)\d{2}-(?:0[1-9]|1[0-2])$/u.test(normalized)
    ) {
      throw new BadRequestException('month 必须是有效的 YYYY-MM 上海账期');
    }
    const monthKey = normalized ?? fallback;
    const [year, monthNo] = monthKey.split('-').map(Number);
    const start = this.shanghaiLocalMonthStartToUtc(year, monthNo - 1);
    const end = this.shanghaiLocalMonthStartToUtc(year, monthNo);
    return { monthKey, start, end };
  }

  private formatShanghaiMonthKey(date: Date): string {
    const shifted = new Date(date.getTime() + SHANGHAI_OFFSET_MS);
    return `${shifted.getUTCFullYear()}-${String(shifted.getUTCMonth() + 1).padStart(2, '0')}`;
  }

  private shanghaiLocalMonthStartToUtc(year: number, zeroBasedMonth: number): Date {
    return new Date(Date.UTC(year, zeroBasedMonth, 1, 0, 0, 0, 0) - SHANGHAI_OFFSET_MS);
  }

  private resolveFinanceReportBillingMode(value?: string | null): FinanceReportBillingMode | undefined {
    const normalized = value?.trim();
    if (!normalized || normalized === 'ALL') return undefined;
    if ((FINANCE_REPORT_BILLING_MODES as readonly string[]).includes(normalized)) {
      return normalized as FinanceReportBillingMode;
    }
    throw new BadRequestException('billingMode 必须是 SUBSCRIPTION / PAY_AS_YOU_GO / CODING_PLAN 之一');
  }

  private resolveFinanceRevenueRecognitionMode(
    billingMode?: FinanceReportBillingMode,
  ): FinanceRevenueRecognitionMode | null {
    if (billingMode === ProductBillingMode.PAY_AS_YOU_GO) return null;
    if (billingMode === ProductBillingMode.SUBSCRIPTION) return ProductBillingMode.SUBSCRIPTION;
    return ProductBillingMode.CODING_PLAN;
  }

  private resolveFinanceReportDetailTab(tab?: string): FinanceReportDetailTab {
    const normalized = (tab ?? 'summary').trim();
    if ((FINANCE_REPORT_DETAIL_TABS as readonly string[]).includes(normalized)) {
      return normalized as FinanceReportDetailTab;
    }
    throw new BadRequestException(`不支持的财务报表 Tab: ${normalized || '(empty)'}`);
  }

  private normalizeFinanceReportPageSize(
    pageSize?: number,
    maxPageSize = FINANCE_REPORT_DETAIL_MAX_PAGE_SIZE,
  ): number {
    const parsed = Number(pageSize ?? FINANCE_REPORT_DETAIL_DEFAULT_PAGE_SIZE);
    if (!Number.isInteger(parsed) || parsed <= 0 || parsed > maxPageSize) {
      throw new BadRequestException(`pageSize 必须是 1 到 ${maxPageSize} 的整数`);
    }
    return parsed;
  }

  private resolveFinanceReportFilter(
    tab: FinanceReportDetailTab,
    filterField?: string,
    filterValue?: string,
  ): FinanceReportFilter | null {
    const field = filterField?.trim();
    const value = filterValue?.trim();
    if (!field && !value) return null;
    if (!field || !value) {
      throw new BadRequestException('filterField 和 filterValue 必须同时提供');
    }
    if (!(FINANCE_REPORT_FILTER_FIELDS as readonly string[]).includes(field)) {
      throw new BadRequestException(`不支持的财务报表筛选字段: ${field}`);
    }
    const normalizedField = field as FinanceReportFilterField;
    if (!(FINANCE_REPORT_FILTER_FIELDS_BY_TAB[tab] as readonly string[]).includes(normalizedField)) {
      throw new BadRequestException(`财务报表 Tab ${tab} 不支持按 ${normalizedField} 筛选`);
    }
    if (value.length > 256) {
      throw new BadRequestException('filterValue 不能超过 256 个字符');
    }
    return { field: normalizedField, value };
  }

  private buildFinanceReportScopeHash(params: {
    month: string;
    tab: FinanceReportDetailTab;
    billingMode?: FinanceReportBillingMode;
    pageSize: number;
    filter: FinanceReportFilter | null;
  }): string {
    return createHash('sha256')
      .update(JSON.stringify({
        version: 2,
        month: params.month,
        tab: params.tab,
        billingMode: params.billingMode ?? null,
        pageSize: params.pageSize,
        filter: params.filter
          ? { field: params.filter.field, value: params.filter.value }
          : null,
      }))
      .digest('base64url')
      .slice(0, 24);
  }

  private decodeFinanceReportCursor(
    cursor: string | undefined,
    expectedScopeHash: string,
  ): FinanceReportCursor | null {
    const raw = cursor?.trim();
    if (!raw) return null;
    try {
      const json = Buffer.from(raw.replace(/-/g, '+').replace(/_/g, '/'), 'base64').toString('utf8');
      const parsed = JSON.parse(json) as Record<string, unknown>;
      if (
        parsed.version !== 2
        || parsed.scopeHash !== expectedScopeHash
        || (parsed.kind !== 'row' && parsed.kind !== 'static')
      ) {
        throw new Error('cursor scope mismatch');
      }
      if (parsed.kind === 'static') {
        const offset = Number(parsed.offset);
        if (!Number.isSafeInteger(offset) || offset < 0) throw new Error('invalid offset');
        return {
          version: 2,
          kind: 'static',
          scopeHash: expectedScopeHash,
          offset,
        };
      }
      if (typeof parsed.createdAt !== 'string' || typeof parsed.id !== 'string') {
        throw new Error('missing cursor fields');
      }
      const createdAt = new Date(parsed.createdAt);
      const partOffset = Number(parsed.partOffset ?? 0);
      if (
        Number.isNaN(createdAt.getTime())
        || !Number.isSafeInteger(partOffset)
        || partOffset < 0
      ) {
        throw new Error('invalid row cursor');
      }
      return {
        version: 2,
        kind: 'row',
        scopeHash: expectedScopeHash,
        createdAt: createdAt.toISOString(),
        id: parsed.id,
        partOffset,
      };
    } catch {
      throw new BadRequestException('无效的财务报表分页游标');
    }
  }

  private encodeFinanceReportRowCursor(
    row: { createdAt: Date; id: string } | null | undefined,
    scopeHash: string,
    partOffset = 0,
  ): string | null {
    if (!row) return null;
    return this.encodeFinanceReportCursorPayload({
      version: 2,
      kind: 'row',
      scopeHash,
      createdAt: row.createdAt.toISOString(),
      id: row.id,
      partOffset,
    });
  }

  private encodeFinanceReportStaticCursor(offset: number, scopeHash: string): string {
    return this.encodeFinanceReportCursorPayload({
      version: 2,
      kind: 'static',
      scopeHash,
      offset,
    });
  }

  private encodeFinanceReportCursorPayload(cursor: FinanceReportCursor): string {
    return Buffer
      .from(JSON.stringify(cursor))
      .toString('base64')
      .replace(/\+/g, '-')
      .replace(/\//g, '_')
      .replace(/=+$/g, '');
  }

  private financeCursorPartOffset(cursor: FinanceReportCursor | null): number {
    return cursor?.kind === 'row' ? cursor.partOffset : 0;
  }

  private financeCreatedAtCursorWhere(
    cursor: FinanceReportCursor | null,
    includeCurrent = false,
  ) {
    if (!cursor) return {};
    if (cursor.kind !== 'row') throw new BadRequestException('无效的财务报表分页游标');
    const createdAt = new Date(cursor.createdAt);
    return {
      OR: [
        { createdAt: { lt: createdAt } },
        { createdAt, id: { [includeCurrent ? 'lte' : 'lt']: cursor.id } },
      ],
    };
  }

  private financeOccurredAtCursorWhere(cursor: FinanceReportCursor | null) {
    if (!cursor) return {};
    if (cursor.kind !== 'row') throw new BadRequestException('无效的财务报表分页游标');
    const occurredAt = new Date(cursor.createdAt);
    return {
      OR: [
        { occurredAt: { lt: occurredAt } },
        { occurredAt, id: { lt: cursor.id } },
      ],
    };
  }

  private financeStaticDetailPage(
    period: { month: string; startDate: string; endDate: string },
    tab: FinanceReportDetailTab,
    rows: unknown[],
    pageSize: number,
    cursor: FinanceReportCursor | null,
    scopeHash: string,
  ) {
    if (cursor?.kind === 'row') throw new BadRequestException('无效的财务报表分页游标');
    const offset = cursor?.offset ?? 0;
    const pageRows = rows.slice(offset, offset + pageSize);
    const hasMore = offset + pageRows.length < rows.length;
    return {
      period,
      tab,
      rows: pageRows.map((row) => this.serializeFinanceDetailRow(
        row,
        !FINANCE_REPORT_SUMMARY_TABS.has(tab),
      )),
      pagination: {
        mode: 'cursor',
        pageSize,
        hasMore,
        nextCursor: hasMore
          ? this.encodeFinanceReportStaticCursor(offset + pageRows.length, scopeHash)
          : null,
        rowsReturned: pageRows.length,
        totalRows: rows.length,
      },
    };
  }

  private financeCursorDetailPage(
    period: { month: string; startDate: string; endDate: string },
    tab: FinanceReportDetailTab,
    rows: unknown[],
    pageSize: number,
    hasMore: boolean,
    sourceRows: Array<{ createdAt: Date; id: string }>,
    scopeHash: string,
  ) {
    const lastRow = sourceRows.slice(0, pageSize).at(-1) ?? null;
    const nextCursor = hasMore
      ? this.encodeFinanceReportRowCursor(lastRow, scopeHash)
      : null;
    return this.financeExplicitCursorDetailPage(period, tab, rows, pageSize, nextCursor);
  }

  private financeExplicitCursorDetailPage(
    period: { month: string; startDate: string; endDate: string },
    tab: FinanceReportDetailTab,
    rows: unknown[],
    pageSize: number,
    nextCursor: string | null,
  ) {
    return {
      period,
      tab,
      rows: rows.map((row) => this.serializeFinanceDetailRow(
        row,
        !FINANCE_REPORT_SUMMARY_TABS.has(tab),
      )),
      pagination: {
        mode: 'cursor',
        pageSize,
        hasMore: nextCursor !== null,
        nextCursor,
        rowsReturned: rows.length,
      },
    };
  }

  private financeInsensitiveContains(value: string) {
    return { contains: value, mode: 'insensitive' as const };
  }

  private async resolveFinanceUserSearchFilter(
    filter: FinanceReportFilter | null,
  ): Promise<FinanceReportFilter | null> {
    if (!filter || filter.field !== 'user') return filter;
    const userSearch = this.financeUserIdentity
      ? await this.financeUserIdentity.resolveSearch(filter.value)
      : {
          userIds: [filter.value],
          apiKeyIds: [],
          billingAccountIds: [],
          tenantIds: [],
        };
    return { ...filter, userSearch };
  }

  private financeUserSearchPlan(filter: FinanceReportFilter): FinanceUserSearchPlan {
    return filter.userSearch ?? {
      userIds: [filter.value],
      apiKeyIds: [],
      billingAccountIds: [],
      tenantIds: [],
    };
  }

  private financeDirectUserWhere(filter: FinanceReportFilter) {
    return { userId: { in: this.financeUserSearchPlan(filter).userIds } };
  }

  private financeWorkspaceWhere(value: string) {
    return {
      OR: [
        { tenantId: value },
        {
          tenant: {
            OR: [
              { name: this.financeInsensitiveContains(value) },
              { slug: this.financeInsensitiveContains(value) },
            ],
          },
        },
      ],
    };
  }

  private financeProductWhere(value: string) {
    return {
      OR: [
        { productId: value },
        {
          product: {
            OR: [
              { name: this.financeInsensitiveContains(value) },
              { slug: this.financeInsensitiveContains(value) },
            ],
          },
        },
      ],
    };
  }

  private financeOrderFilterWhere(
    filter: FinanceReportFilter | null,
  ): Prisma.OrderWhereInput {
    if (!filter) return {};
    const value = filter.value;
    switch (filter.field) {
      case 'user': {
        const orderUserSearch = this.financeUserSearchPlan(filter);
        return {
          OR: [
            this.financeDirectUserWhere(filter),
            { billingAccountId: { in: orderUserSearch.billingAccountIds } },
            { billingAccountId: null, tenantId: { in: orderUserSearch.tenantIds } },
          ],
        };
      }
      case 'workspace':
        return this.financeWorkspaceWhere(value);
      case 'product': {
        const productIdentity = {
          OR: [
            { id: value },
            { name: this.financeInsensitiveContains(value) },
            { slug: this.financeInsensitiveContains(value) },
          ],
        };
        return {
          OR: [
            { product: productIdentity },
            { plan: { product: productIdentity } },
            { boosterPack: { product: productIdentity } },
            { items: { some: { product: productIdentity } } },
            { items: { some: { plan: { product: productIdentity } } } },
            { items: { some: { boosterPack: { product: productIdentity } } } },
          ],
        };
      }
      case 'plan': {
        const planIdentity = {
          OR: [
            { id: value },
            { name: this.financeInsensitiveContains(value) },
          ],
        };
        return {
          OR: [
            { plan: planIdentity },
            { items: { some: { plan: planIdentity } } },
          ],
        };
      }
      case 'orderId':
      case 'merchantOrderNo':
      case 'rechargeOrderNo':
        return { id: value };
      case 'tradeNo':
      case 'channelTradeNo':
        return { tradeNo: value };
      default:
        return {};
    }
  }

  private financeBalanceTransactionFilterWhere(
    filter: FinanceReportFilter | null,
  ): Prisma.BalanceTransactionWhereInput {
    if (!filter) return {};
    switch (filter.field) {
      case 'user': {
        const balanceUserSearch = this.financeUserSearchPlan(filter);
        return {
          OR: [
            this.financeDirectUserWhere(filter),
            { billingAccountId: { in: balanceUserSearch.billingAccountIds } },
            { billingAccountId: null, tenantId: { in: balanceUserSearch.tenantIds } },
          ],
        };
      }
      case 'workspace':
        return this.financeWorkspaceWhere(filter.value);
      case 'product':
        return this.financeProductWhere(filter.value);
      case 'orderId':
        return { orderId: filter.value };
      case 'transactionId':
        return { id: filter.value };
      case 'usageId':
        return { tokenUsageId: filter.value };
      default:
        return {};
    }
  }

  private financeCreditTransactionFilterWhere(
    filter: FinanceReportFilter | null,
  ): Prisma.CreditTransactionWhereInput {
    if (!filter) return {};
    switch (filter.field) {
      case 'user': {
        const creditUserSearch = this.financeUserSearchPlan(filter);
        return {
          OR: [
            this.financeDirectUserWhere(filter),
            { tenantId: { in: creditUserSearch.tenantIds } },
          ],
        };
      }
      case 'workspace':
        return this.financeWorkspaceWhere(filter.value);
      case 'model':
        return { modelName: this.financeInsensitiveContains(filter.value) };
      case 'transactionId':
        return { id: filter.value };
      case 'requestId':
        return { requestId: filter.value };
      default:
        return {};
    }
  }

  private financeTokenUsageFilterWhere(
    filter: FinanceReportFilter | null,
  ): Prisma.TokenUsageWhereInput {
    if (!filter) return {};
    switch (filter.field) {
      case 'user': {
        const tokenUserSearch = this.financeUserSearchPlan(filter);
        return {
          OR: [
            { apiKeyId: { in: tokenUserSearch.apiKeyIds } },
            { tenantId: { in: tokenUserSearch.tenantIds } },
          ],
        };
      }
      case 'workspace':
        return this.financeWorkspaceWhere(filter.value);
      case 'product':
        return this.financeProductWhere(filter.value);
      case 'model':
        return { model: this.financeInsensitiveContains(filter.value) };
      case 'usageId':
        return { id: filter.value };
      case 'requestId':
        return { requestId: filter.value };
      case 'apiKey':
        return {
          apiKey: {
            OR: [
              { id: filter.value },
              { prefix: filter.value },
            ],
          },
        };
      default:
        return {};
    }
  }

  private financeVisibleTokenUsageWhere(): Prisma.TokenUsageWhereInput {
    return {
      OR: [
        { promptTokens: { gt: 0 } },
        { cachedInputTokens: { gt: 0 } },
        { cacheWriteInputTokens: { gt: 0 } },
        { completionTokens: { gt: 0 } },
        { totalTokens: { gt: 0 } },
        { customerChargeUsd: { gt: 0 } },
        { providerCostEstimateUsd: { gt: 0 } },
        { consumptionAllocations: { some: { amountUsd: { gt: 0 } } } },
        {
          customerChargePolicy: { in: ['usage_charge', 'legacy_cost_usd'] },
          costUsd: { not: 0 },
        },
      ],
    };
  }

  private financeBalanceGrantFilterWhere(
    filter: FinanceReportFilter | null,
  ): Prisma.BalanceGrantWhereInput {
    if (!filter) return {};
    switch (filter.field) {
      case 'user': {
        const grantUserSearch = this.financeUserSearchPlan(filter);
        return {
          OR: [
            this.financeDirectUserWhere(filter),
            { billingAccountId: { in: grantUserSearch.billingAccountIds } },
            { billingAccountId: null, tenantId: { in: grantUserSearch.tenantIds } },
          ],
        };
      }
      case 'workspace':
        return this.financeWorkspaceWhere(filter.value);
      case 'product':
        return this.financeProductWhere(filter.value);
      case 'rechargeBatchNo':
      case 'grantId':
        return { id: filter.value };
      case 'rechargeOrderNo':
        return { orderId: filter.value };
      case 'channelTradeNo':
        return { order: { tradeNo: filter.value } };
      default:
        return {};
    }
  }

  private financeAllocationFilterWhere(
    filter: FinanceReportFilter | null,
  ): Prisma.BalanceConsumptionAllocationWhereInput {
    if (!filter) return {};
    switch (filter.field) {
      case 'user': {
        const allocationUserSearch = this.financeUserSearchPlan(filter);
        return {
          OR: [
            this.financeDirectUserWhere(filter),
            { billingAccountId: { in: allocationUserSearch.billingAccountIds } },
            { billingAccountId: null, tenantId: { in: allocationUserSearch.tenantIds } },
          ],
        };
      }
      case 'workspace':
        return this.financeWorkspaceWhere(filter.value);
      case 'product':
        return this.financeProductWhere(filter.value);
      case 'model':
        return { tokenUsage: { model: this.financeInsensitiveContains(filter.value) } };
      case 'rechargeBatchNo':
      case 'grantId':
        return { balanceGrantId: filter.value };
      case 'rechargeOrderNo':
        return { balanceGrant: { orderId: filter.value } };
      case 'callTransactionNo':
        return {
          OR: [
            { tokenUsageId: filter.value },
            { balanceTransactionId: filter.value },
          ],
        };
      case 'allocationId':
        return { id: filter.value };
      case 'transactionId':
        return { balanceTransactionId: filter.value };
      case 'usageId':
        return { tokenUsageId: filter.value };
      default:
        return {};
    }
  }

  private financeEnterpriseCreditSettlementFilterWhere(
    filter: FinanceReportFilter | null,
  ): Prisma.EnterpriseCreditSettlementWhereInput {
    if (!filter) return {};
    switch (filter.field) {
      case 'workspace':
        return {
          allocation: this.financeWorkspaceWhere(filter.value),
        };
      case 'allocationId':
        return { allocationId: filter.value };
      case 'settlementId':
        return { id: filter.value };
      case 'repaymentTransactionId':
        return { repaymentTransactionId: filter.value };
      default:
        return {};
    }
  }

  private financeTokenPlanLineMatchesFilter(
    row: FinanceTokenPlanLine,
    filter: FinanceReportFilter | null,
  ): boolean {
    if (!filter) return true;
    const needle = filter.value.toLocaleLowerCase('en-US');
    if (filter.field === 'product') {
      return row.productId === filter.value
        || row.productName.toLocaleLowerCase('en-US').includes(needle);
    }
    if (filter.field === 'plan') {
      return row.planId === filter.value
        || row.planName.toLocaleLowerCase('en-US').includes(needle);
    }
    return true;
  }

  private financeOrderReportWhere(
    start: Date,
    end: Date,
    billingMode?: FinanceReportBillingMode,
  ): Prisma.OrderWhereInput {
    return {
      AND: [
        this.financeOrderBillingModeWhere(billingMode),
      ],
      OR: [
        { createdAt: { gte: start, lt: end } },
        { paidAt: { gte: start, lt: end } },
        { completedAt: { gte: start, lt: end } },
        { refundedAt: { gte: start, lt: end } },
      ],
    };
  }

  private financePaymentReportWhere(
    start: Date,
    end: Date,
    billingMode?: FinanceReportBillingMode,
  ): Prisma.OrderWhereInput {
    return {
      AND: [
        this.financeOrderReportWhere(start, end, billingMode),
        { channel: { not: null } },
        { NOT: { channel: PayChannel.BALANCE } },
      ],
    };
  }

  private async loadFinanceBalanceGrantCursorPage(params: {
    start: Date;
    end: Date;
    billingMode?: FinanceReportBillingMode;
    tab: FinanceReportDetailTab;
    cursor: FinanceReportCursor | null;
    pageSize: number;
    filter?: FinanceReportFilter | null;
  }, db: FinanceReadClient = this.prisma): Promise<{
    sourceRows: FinanceGrantRow[];
    pageRows: FinanceGrantRow[];
    hasMore: boolean;
  }> {
    const selectionStartedAt = Date.now();
    const pageKeys = await db.balanceGrant.findMany({
      where: {
        AND: [
          this.financeBalanceGrantWhere(params.start, params.end, params.billingMode),
          this.financeGrantCategoryWhere(params.tab),
          this.financeBalanceGrantFilterWhere(params.filter ?? null),
          this.financeCreatedAtCursorWhere(params.cursor),
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: params.pageSize + 1,
      select: { id: true, createdAt: true },
    });
    this.logger.log(
      `finance balance grant page selected tab=${params.tab} billingMode=${params.billingMode ?? 'ALL'} rows=${pageKeys.length} durationMs=${Date.now() - selectionStartedAt}`,
    );

    const selectedRows = pageKeys.length === 0
      ? []
      : await db.balanceGrant.findMany({
        where: { id: { in: pageKeys.map((row) => row.id) } },
        include: this.financeBalanceGrantInclude(),
      }) as FinanceGrantRow[];
    const selectedById = new Map(selectedRows.map((row) => [row.id, row]));
    const sourceRows = pageKeys
      .map((row) => selectedById.get(row.id))
      .filter((row): row is FinanceGrantRow => row !== undefined);
    await this.enrichFinanceRowsWithAuthoritativeContacts(
      sourceRows.slice(0, params.pageSize),
    );
    return {
      sourceRows,
      pageRows: sourceRows.slice(0, params.pageSize),
      hasMore: sourceRows.length > params.pageSize,
    };
  }

  private async loadFinanceBuyGiftPaymentGrantCursorPage(params: {
    start: Date;
    end: Date;
    billingMode?: FinanceReportBillingMode;
    cursor: FinanceReportCursor | null;
    pageSize: number;
  }, db: FinanceReadClient = this.prisma): Promise<{
    sourceRows: FinanceGrantRow[];
    pageRows: FinanceGrantRow[];
    hasMore: boolean;
  }> {
    const sourceRows = await db.balanceGrant.findMany({
      where: {
        AND: [
          this.financeBalanceGrantWhere(params.start, params.end, params.billingMode),
          this.financeGrantCategoryWhere('buyGiftPaymentDetails'),
          this.financeCreatedAtCursorWhere(params.cursor),
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: params.pageSize + 1,
      select: {
        id: true,
        userId: true,
        tenantId: true,
        billingAccountId: true,
        orderId: true,
        paidAmountUsd: true,
        createdAt: true,
        user: { select: { id: true, email: true, phone: true, nickname: true } },
        tenant: {
          select: {
            billingAccount: { select: FINANCE_ACCOUNT_LABEL_SELECT },
          },
        },
        billingAccount: { select: FINANCE_ACCOUNT_LABEL_SELECT },
        order: {
          select: {
            amountCents: true,
            currency: true,
            paidAt: true,
            refundedAt: true,
            refundAmountCents: true,
          },
        },
        targetRefunds: {
          select: {
            component: true,
            requestedAmountUsd: true,
            occurredAt: true,
          },
        },
      },
    }) as unknown as FinanceGrantRow[];
    const pageRows = sourceRows.slice(0, params.pageSize);
    await this.enrichFinanceRowsWithAuthoritativeContacts(pageRows);
    return {
      sourceRows,
      pageRows,
      hasMore: sourceRows.length > params.pageSize,
    };
  }

  private financeBalanceGrantWhere(
    start: Date,
    end: Date,
    billingMode?: FinanceReportBillingMode,
  ): Prisma.BalanceGrantWhereInput {
    return this.withFinanceBalanceGrantBillingMode({
      OR: [
        { expiresAt: { gte: start, lt: end } },
        { allocations: { some: { createdAt: { gte: start, lt: end } } } },
        { debtSettlements: { some: { occurredAt: { gte: start, lt: end } } } },
        { targetRefunds: { some: { occurredAt: { gte: start, lt: end } } } },
        {
          refundAllocations: {
            some: { refund: { occurredAt: { gte: start, lt: end } } },
          },
        },
        { expiryAudit: { is: { createdAt: { gte: start, lt: end } } } },
        // This also covers grants whose validFrom falls inside the period. Keep
        // one range branch so PostgreSQL does not plan the same rows twice.
        { validFrom: { lt: end } },
      ],
    }, billingMode);
  }

  private financeGrantCategoryWhere(
    tab: FinanceReportDetailTab,
  ): Prisma.BalanceGrantWhereInput {
    if (tab === 'pureGiftAccountChanges') {
      return {
        paidAmountUsd: { lte: new Prisma.Decimal(0) },
        grantedAmountUsd: { gt: new Prisma.Decimal(0) },
      };
    }
    if (
      tab === 'buyGiftAccountChanges' ||
      tab === 'buyGiftPaymentDetails'
    ) {
      return { paidAmountUsd: { gt: new Prisma.Decimal(0) } };
    }
    return {};
  }

  private financeAllocationCategoryWhere(
    tab: FinanceReportDetailTab,
  ): Prisma.BalanceConsumptionAllocationWhereInput {
    if (
      tab === 'pureGiftConsumptionDetails' ||
      tab === 'pureGiftConsumptionSummary'
    ) {
      return {
        balanceGrant: {
          is: {
            paidAmountUsd: { lte: new Prisma.Decimal(0) },
            grantedAmountUsd: { gt: new Prisma.Decimal(0) },
          },
        },
      };
    }
    if (
      tab === 'buyGiftConsumptionDetails' ||
      tab === 'buyGiftConsumptionSummary'
    ) {
      return {
        balanceGrant: {
          is: { paidAmountUsd: { gt: new Prisma.Decimal(0) } },
        },
      };
    }
    return {};
  }

  private financeEnterpriseCreditAllocationWhere(): Prisma.BalanceConsumptionAllocationWhereInput {
    // 企业信用由 source 明确标识，同时校验没有充值批次，避免把 NEGATIVE_BALANCE 等
    // 其他无批次分摊记录纳入企业信用报表。
    return {
      source: BALANCE_ALLOCATION_SOURCE_ENTERPRISE_CREDIT,
      balanceGrantId: null,
    };
  }

  private financeTokenPlanOrderWhere(
    start: Date,
    end: Date,
    billingMode: FinanceRevenueRecognitionMode = ProductBillingMode.CODING_PLAN,
  ): Prisma.OrderWhereInput {
    return {
      status: { in: TOKEN_PLAN_REVENUE_ORDER_STATUSES },
      OR: [
        { paidAt: { lt: end } },
        { completedAt: { lt: end } },
        { refundedAt: { gte: start, lt: end } },
      ],
      AND: [
        {
          OR: [
            { product: { billingMode } },
            { plan: { product: { billingMode } } },
            { items: { some: { product: { billingMode } } } },
            { items: { some: { plan: { product: { billingMode } } } } },
          ],
        },
      ],
    };
  }

  private financeOrderBillingModeWhere(billingMode?: FinanceReportBillingMode): Prisma.OrderWhereInput {
    if (!billingMode) return {};
    return {
      OR: [
        { product: { billingMode } },
        { plan: { product: { billingMode } } },
        { boosterPack: { product: { billingMode } } },
        { items: { some: { product: { billingMode } } } },
        { items: { some: { plan: { product: { billingMode } } } } },
        { items: { some: { boosterPack: { product: { billingMode } } } } },
      ],
    };
  }

  private withFinanceProductBillingMode<T extends object>(
    where: T,
    billingMode?: FinanceReportBillingMode,
  ): T {
    if (!billingMode) return where;
    return {
      AND: [
        where,
        { product: { billingMode } },
      ],
    } as T;
  }

  private withFinanceBalanceTransactionBillingMode(
    where: Prisma.BalanceTransactionWhereInput,
    billingMode: FinanceReportBillingMode | undefined,
  ): Prisma.BalanceTransactionWhereInput {
    if (!billingMode) return where;
    if (billingMode !== ProductBillingMode.PAY_AS_YOU_GO) {
      return { AND: [where, { product: { billingMode } }] };
    }

    return {
      AND: [
        where,
        {
          OR: [
            {
              product: { billingMode },
            },
            {
              productId: null,
              attribution: {
                is: this.financeBalanceAttributionWhere(billingMode),
              },
            },
          ],
        },
      ],
    };
  }

  private withFinanceBalanceGrantBillingMode(
    where: Prisma.BalanceGrantWhereInput,
    billingMode: FinanceReportBillingMode | undefined,
  ): Prisma.BalanceGrantWhereInput {
    if (!billingMode) return where;
    if (billingMode !== ProductBillingMode.PAY_AS_YOU_GO) {
      return { AND: [where, { product: { billingMode } }] };
    }
    return {
      AND: [
        where,
        {
          OR: [
            {
              product: { billingMode },
            },
            {
              productId: null,
              attribution: {
                is: this.financeBalanceAttributionWhere(billingMode),
              },
            },
          ],
        },
      ],
    };
  }

  private withFinanceBalanceAllocationBillingMode(
    where: Prisma.BalanceConsumptionAllocationWhereInput,
    billingMode: FinanceReportBillingMode | undefined,
  ): Prisma.BalanceConsumptionAllocationWhereInput {
    if (!billingMode) return where;
    if (billingMode !== ProductBillingMode.PAY_AS_YOU_GO) {
      return {
        AND: [
          where,
          {
            OR: [
              { product: { billingMode } },
              {
                productId: null,
                balanceTransaction: { attribution: { is: null } },
                balanceGrant: { is: { product: { billingMode } } },
              },
            ],
          },
        ],
      };
    }
    const attributionWhere = this.financeBalanceAttributionWhere(billingMode);
    return {
      AND: [
        where,
        {
          OR: [
            {
              product: { billingMode },
            },
            {
              productId: null,
              balanceTransaction: {
                attribution: { is: attributionWhere },
              },
            },
            {
              productId: null,
              balanceTransaction: { attribution: { is: null } },
              balanceGrant: {
                is: { product: { billingMode } },
              },
            },
            {
              productId: null,
              balanceTransaction: { attribution: { is: null } },
              balanceGrant: {
                is: {
                  productId: null,
                  attribution: { is: attributionWhere },
                },
              },
            },
          ],
        },
      ],
    };
  }

  private financeBalanceAttributionWhere(
    billingMode: FinanceReportBillingMode,
  ): Prisma.BalanceTransactionAttributionWhereInput {
    return {
      billingMode,
      source: BalanceTransactionAttributionSource.ADMIN_BALANCE_ADJUSTMENT,
    };
  }

  private financeOrderReportInclude() {
    return {
      user: { select: { id: true, email: true, phone: true, nickname: true } },
      billingAccount: { select: FINANCE_ACCOUNT_LABEL_SELECT },
      tenant: { select: { id: true, name: true, slug: true, type: true, billingAccount: { select: FINANCE_ACCOUNT_LABEL_SELECT } } },
      product: { select: { id: true, name: true, slug: true, billingMode: true } },
      plan: { select: { id: true, name: true, product: { select: { id: true, name: true, slug: true, billingMode: true } } } },
      boosterPack: { select: { id: true, name: true, product: { select: { id: true, name: true, slug: true, billingMode: true } } } },
      stripePaymentLedgers: {
        where: { transactionType: 'payment' },
        orderBy: [{ createdAt: 'desc' as const }],
        take: 1,
        select: {
          checkoutSessionId: true,
          subscriptionId: true,
          invoiceId: true,
          paymentIntentId: true,
          chargeId: true,
          balanceTransactionId: true,
          payoutId: true,
          stripeEventId: true,
          amountCents: true,
          feeCents: true,
          netCents: true,
          currency: true,
          stripeStatus: true,
          customerEmail: true,
          stripeCreatedAt: true,
          availableOn: true,
          bankReceivedDate: true,
        },
      },
    };
  }

  private financeTokenPlanOrderInclude() {
    return {
      user: { select: { id: true, email: true, phone: true, nickname: true } },
      billingAccount: { select: FINANCE_ACCOUNT_LABEL_SELECT },
      tenant: { select: { id: true, name: true, slug: true, type: true, billingAccount: { select: FINANCE_ACCOUNT_LABEL_SELECT } } },
      product: { select: { id: true, name: true, slug: true, billingMode: true, codingPlanFulfillmentMode: true } },
      plan: {
        select: {
          id: true,
          name: true,
          billingPeriod: true,
          validityDays: true,
          product: { select: { id: true, name: true, slug: true, billingMode: true, codingPlanFulfillmentMode: true } },
        },
      },
      items: {
        orderBy: { createdAt: 'asc' as const },
        include: {
          product: { select: { id: true, name: true, slug: true, billingMode: true, codingPlanFulfillmentMode: true } },
          plan: {
            select: {
              id: true,
              name: true,
              billingPeriod: true,
              validityDays: true,
              product: { select: { id: true, name: true, slug: true, billingMode: true, codingPlanFulfillmentMode: true } },
            },
          },
        },
      },
    };
  }

  private financeBalanceGrantInclude() {
    return {
      user: { select: { id: true, email: true, phone: true, nickname: true } },
      tenant: { select: { id: true, name: true, slug: true, type: true, billingAccount: { select: FINANCE_ACCOUNT_LABEL_SELECT } } },
      product: { select: { id: true, name: true, slug: true, billingMode: true } },
      attribution: { select: { balanceGrantId: true, billingMode: true, source: true } },
      billingAccount: {
        select: {
          id: true,
          balanceGrantLedgerStatus: true,
          balanceGrantLedgerVersion: true,
          ...FINANCE_ACCOUNT_LABEL_SELECT,
        },
      },
      order: {
        select: {
          id: true,
          amountCents: true,
          bonusCents: true,
          currency: true,
          status: true,
          channel: true,
          tradeNo: true,
          paidAt: true,
          completedAt: true,
          refundedAt: true,
          refundAmountCents: true,
        },
      },
      targetRefunds: {
        select: {
          component: true,
          requestedAmountUsd: true,
          occurredAt: true,
        },
      },
      refundAllocations: {
        select: {
          id: true,
          refundId: true,
          balanceGrantId: true,
          sequence: true,
          role: true,
          amountUsd: true,
          paidReductionUsd: true,
          bonusReductionUsd: true,
          refund: {
            select: {
              id: true,
              billingAccountId: true,
              balanceGrantId: true,
              refundTransactionId: true,
              debtAllocationId: true,
              component: true,
              occurredAt: true,
              balanceGrant: {
                select: {
                  id: true,
                  billingAccountId: true,
                },
              },
            },
          },
        },
      },
      debtSettlements: {
        select: {
          id: true,
          billingAccountId: true,
          allocationId: true,
          repaymentTransactionId: true,
          balanceGrantId: true,
          debtSource: true,
          repairRunId: true,
          trigger: true,
          amountUsd: true,
          paidUsd: true,
          bonusUsd: true,
          occurredAt: true,
          allocation: {
            select: {
              id: true,
              billingAccountId: true,
              source: true,
            },
          },
        },
      },
      expiryAudit: {
        select: {
          balanceGrantId: true,
          billingAccountId: true,
          balanceTransactionId: true,
          nominalAmountUsd: true,
          nominalPaidUsd: true,
          nominalBonusUsd: true,
          walletDebitUsd: true,
          walletDebitPaidUsd: true,
          walletDebitBonusUsd: true,
          unbackedAmountUsd: true,
          unbackedPaidUsd: true,
          unbackedBonusUsd: true,
          createdAt: true,
        },
      },
    };
  }

  private financeBalanceAllocationInclude() {
    return {
      user: { select: { id: true, email: true, phone: true, nickname: true } },
      billingAccount: { select: FINANCE_ACCOUNT_LABEL_SELECT },
      tenant: { select: { id: true, name: true, slug: true, type: true, billingAccount: { select: FINANCE_ACCOUNT_LABEL_SELECT } } },
      product: { select: { id: true, name: true, slug: true, billingMode: true } },
      balanceGrant: {
        include: this.financeBalanceGrantInclude(),
      },
      balanceTransaction: {
        select: {
          id: true,
          orderId: true,
          description: true,
          createdAt: true,
          attribution: { select: { balanceGrantId: true, billingMode: true, source: true } },
        },
      },
      tokenUsage: {
        select: {
          id: true,
          model: true,
          pricingTierKey: true,
          promptTokens: true,
          cachedInputTokens: true,
          cacheWriteInputTokens: true,
          completionTokens: true,
          totalTokens: true,
          inputPriceUsdPerM: true,
          cachedInputPriceUsdPerM: true,
          cacheWritePriceUsdPerM: true,
          outputPriceUsdPerM: true,
          costUsd: true,
          customerChargePolicy: true,
          customerChargeUsd: true,
          providerCostEstimateUsd: true,
          providerCostMultiplier: true,
          providerInputCostUsdPerM: true,
          providerCachedInputCostUsdPerM: true,
          providerCacheWriteCostUsdPerM: true,
          providerOutputCostUsdPerM: true,
          codingPlanEntitlementId: true,
          providerEntitlementId: true,
          createdAt: true,
        },
      },
    };
  }

  private async fetchFinanceOrderPage(
    where: Prisma.OrderWhereInput,
    pageSize: number,
    cursor: FinanceReportCursor | null,
    paymentsOnly: boolean,
    db: FinanceReadClient = this.prisma,
  ) {
    const rows = await db.order.findMany({
      where: {
        AND: [
          where,
          this.financeCreatedAtCursorWhere(cursor),
          ...(paymentsOnly ? [{ channel: { not: null } }, { NOT: { channel: PayChannel.BALANCE } }] : []),
        ],
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: pageSize + 1,
      include: this.financeOrderReportInclude(),
    });
    await this.enrichFinanceRowsWithAuthoritativeContacts(rows.slice(0, pageSize));
    return {
      rows,
      pageRows: rows.slice(0, pageSize),
      hasMore: rows.length > pageSize,
    };
  }

  private mapFinanceOrderRows(
    monthKey: string,
    orders: Array<any>,
    platformCurrencyCode: string,
    region?: PlatformRegion,
  ) {
    return orders.map((order) => {
      const product = order.product ?? order.plan?.product ?? order.boosterPack?.product ?? null;
      return {
        period: monthKey,
        orderId: order.id,
        userId: order.userId,
        userLabel: this.formatUserLabel(order.user, order.userId, this.financeRowAccount(order), region),
        workspaceId: order.tenantId,
        workspaceName: order.tenant?.name ?? order.tenantId,
        workspaceType: order.tenant?.type ?? '',
        productName: product?.name ?? '未绑定产品',
        billingMode: product?.billingMode ?? null,
        orderType: order.orderType,
        itemName: order.plan?.name ?? order.boosterPack?.name ?? '余额充值',
        originalAmountCents: order.originalAmountCents ?? order.amountCents,
        discountAmountCents: order.discountAmountCents ?? 0,
        amountCents: order.amountCents,
        currency: (order.currency ?? platformCurrencyCode).toUpperCase(),
        channel: order.channel,
        tradeNo: order.tradeNo,
        status: order.status,
        createdAt: order.createdAt,
        paidAt: order.paidAt,
        completedAt: order.completedAt,
        refundedAt: order.refundedAt,
        refundAmountCents: order.refundAmountCents ?? 0,
        refundReason: order.refundReason,
        invoiceableCents: order.status === OrderStatus.COMPLETED ? order.amountCents : 0,
        evidence: 'orders + order_audit_logs + payment webhook',
      };
    });
  }

  private mapFinancePaymentRows(
    monthKey: string,
    orders: Array<any>,
    platformCurrencyCode: string,
  ) {
    return orders
      .filter((order) => order.channel && order.channel !== PayChannel.BALANCE)
      .map((order) => {
        const product = order.product ?? order.plan?.product ?? order.boosterPack?.product ?? null;
        const stripeLedger = order.stripePaymentLedgers?.[0] ?? null;
        const match = this.resolveFinancePaymentMatch(order, stripeLedger);
        return {
          period: monthKey,
          channel: order.channel,
          merchantOrderNo: order.id,
          orderId: order.id,
          tradeNo: order.tradeNo,
          checkoutSessionId: stripeLedger?.checkoutSessionId ?? null,
          subscriptionId: stripeLedger?.subscriptionId ?? null,
          invoiceId: stripeLedger?.invoiceId ?? null,
          paymentIntentId: stripeLedger?.paymentIntentId ?? null,
          chargeId: stripeLedger?.chargeId ?? null,
          balanceTransactionId: stripeLedger?.balanceTransactionId ?? null,
          payoutId: stripeLedger?.payoutId ?? null,
          userId: order.userId,
          workspaceId: order.tenantId,
          workspaceName: order.tenant?.name ?? order.tenantId,
          workspaceType: order.tenant?.type ?? '',
          billingMode: product?.billingMode ?? null,
          orderType: order.orderType,
          paidAmountCents: order.amountCents,
          stripeAmountCents: stripeLedger?.amountCents ?? null,
          channelFeeCents: stripeLedger?.feeCents ?? null,
          settlementNetCents: stripeLedger?.netCents ?? null,
          currency: (stripeLedger?.currency ?? order.currency ?? platformCurrencyCode).toUpperCase(),
          paymentStatus: order.status,
          stripeStatus: stripeLedger?.stripeStatus ?? null,
          stripeCustomerEmail: stripeLedger?.customerEmail ?? null,
          paidAt: order.paidAt,
          stripeCreatedAt: stripeLedger?.stripeCreatedAt ?? null,
          channelSettlementDate: stripeLedger?.availableOn ?? null,
          bankReceivedDate: stripeLedger?.bankReceivedDate ?? null,
          webhookEventId: stripeLedger?.stripeEventId ?? order.tradeNo,
          systemMatchStatus: match.systemMatchStatus,
          diffCents: match.diffCents,
          diffReason: match.diffReason,
        };
      });
  }

  private resolveFinancePaymentMatch(order: any, stripeLedger: any): {
    systemMatchStatus: string;
    diffCents: number | null;
    diffReason: string;
  } {
    if (!order.tradeNo) {
      return {
        systemMatchStatus: '待匹配',
        diffCents: null,
        diffReason: '缺少支付渠道交易号或订单未支付',
      };
    }

    if (order.channel !== PayChannel.STRIPE) {
      return {
        systemMatchStatus: '已匹配',
        diffCents: null,
        diffReason: '',
      };
    }

    if (!stripeLedger) {
      return {
        systemMatchStatus: '待补Stripe流水',
        diffCents: null,
        diffReason: '系统订单已有Stripe交易号，但尚未写入Stripe对账流水',
      };
    }

    const stripeAmountCents = typeof stripeLedger.amountCents === 'number'
      ? stripeLedger.amountCents
      : null;
    const diffCents = stripeAmountCents == null
      ? null
      : stripeAmountCents - Number(order.amountCents ?? 0);
    if (diffCents !== null && diffCents !== 0) {
      return {
        systemMatchStatus: '金额不一致',
        diffCents,
        diffReason: '系统订单金额与Stripe实收金额不一致',
      };
    }

    if (stripeLedger.balanceTransactionId) {
      return {
        systemMatchStatus: '已匹配',
        diffCents,
        diffReason: '',
      };
    }

    if (stripeLedger.paymentIntentId || stripeLedger.chargeId) {
      return {
        systemMatchStatus: '待结算',
        diffCents,
        diffReason: '已匹配Stripe支付对象，尚未取得Balance Transaction/手续费净额',
      };
    }

    return {
      systemMatchStatus: '待匹配',
      diffCents,
      diffReason: 'Stripe流水缺少PaymentIntent或Charge',
    };
  }

  private mapFinanceBalanceRows(monthKey: string, balanceTransactions: Array<any>, region?: PlatformRegion) {
    return balanceTransactions.map((tx) => this.withFinanceRawUsd({
      period: monthKey,
      transactionId: tx.id,
      userId: tx.userId,
      userLabel: this.formatUserLabel(tx.user, tx.userId, this.financeRowAccount(tx), region),
      workspaceId: tx.tenantId,
        workspaceName: tx.tenant?.name ?? tx.tenantId,
        workspaceType: tx.tenant?.type ?? '',
        productName: tx.product?.name ?? '未绑定产品',
        billingMode: tx.product?.billingMode ?? tx.attribution?.billingMode ?? null,
        type: tx.type,
      amountCents: usdToCents(tx.amountUsd),
      balanceAfterCents: usdToCents(tx.balanceAfterUsd),
      orderId: tx.orderId,
      usageId: tx.tokenUsageId,
      description: tx.description,
      createdAt: tx.createdAt,
      debitSubjectHint: this.getDebitSubjectHint(tx.type),
      creditSubjectHint: this.getCreditSubjectHint(tx.type),
      auditNote: 'balance_transactions 可滚动校验期初+变动=期末',
    }, {
      amountCents: tx.amountUsd,
      balanceAfterCents: tx.balanceAfterUsd,
    }));
  }

  private mapFinanceCreditRows(
    monthKey: string,
    creditTransactions: Array<any>,
    subscriptionMap: Map<string, { product: { name: string } | null; plan: { name: string } | null }>,
    region?: PlatformRegion,
  ) {
    return creditTransactions.map((tx) => {
      const sub = tx.subscriptionId ? subscriptionMap.get(tx.subscriptionId) : undefined;
      const tokenBreakdown = {
        inputTokens: tx.inputTokens,
        cachedInputTokens: tx.cachedInputTokens,
        cacheWriteInputTokens: null,
        outputTokens: tx.outputTokens,
      };
      return {
        period: monthKey,
        transactionId: tx.id,
        userId: tx.userId,
        userLabel: this.formatUserLabel(tx.user, tx.userId, this.financeRowAccount(tx), region),
        workspaceId: tx.tenantId ?? '',
        workspaceName: tx.tenant?.name ?? tx.tenantId ?? '',
        workspaceType: tx.tenant?.type ?? '',
        subscriptionId: tx.subscriptionId,
        productName: tx.product?.name ?? sub?.product?.name ?? '未绑定产品',
        billingMode: tx.product?.billingMode ?? null,
        planName: sub?.plan?.name ?? '',
        type: tx.type,
        creditsAmount: tx.creditsAmount,
        quotaAfter: tx.quotaAfter,
        bonusAfter: tx.bonusAfter,
        source: tx.source,
        modelName: tx.modelName,
        tokenTypeBreakdown: buildTokenTypeBreakdown(tokenBreakdown),
        regularInputTokens: getRegularInputTokens(tokenBreakdown),
        inputTokens: tx.inputTokens,
        cachedInputTokens: tx.cachedInputTokens,
        cacheWriteInputTokens: null,
        outputTokens: tx.outputTokens,
        totalTokens: tx.totalTokens,
        requestId: tx.requestId,
        createdAt: tx.createdAt,
        orderId: this.extractOrderIdFromSource(tx.source),
        auditNote: 'credit_transactions 用于套餐/加油包履约证明',
      };
    });
  }

  private mapFinanceApiUsageRows(monthKey: string, tokenUsages: Array<any>, region?: PlatformRegion) {
    return tokenUsages.map((usage) => {
      const consumptionAllocations = usage.consumptionAllocations ?? [];
      const channels = financeApiUsageChannelUsd({
        customerChargeUsd: usage.customerChargeUsd,
        costUsd: usage.costUsd,
        customerChargePolicy: usage.customerChargePolicy,
        customerCollectedUsd: usage.customerCollectedUsd,
        customerApprovedReceivableUsd: usage.customerApprovedReceivableUsd,
        customerUnapprovedDebtUsd: usage.customerUnapprovedDebtUsd,
        customerFundingClassificationComplete: usage.customerFundingClassificationComplete,
        allocations: consumptionAllocations,
      });
      const customerChargeUsd = channels.customerChargeUsd;
      const paymentDeductionUsd = channels.paymentDeductionUsd;
      const voucherDeductionUsd = channels.voucherDeductionUsd;
      const creditDeductionUsd = channels.creditDeductionUsd;
      const debtDeductionUsd = channels.debtDeductionUsd;
      const supplierCostUsd = usage.providerCostEstimateUsd == null
        ? null
        : usd(usage.providerCostEstimateUsd);
      const supplierCostCents = supplierCostUsd == null
        ? null
        : usdToCents(supplierCostUsd);
      const userChargeCents = usdToCents(customerChargeUsd);
      const tokenBreakdown = {
        inputTokens: usage.promptTokens,
        cachedInputTokens: usage.cachedInputTokens,
        cacheWriteInputTokens: usage.cacheWriteInputTokens,
        outputTokens: usage.completionTokens,
      };
      const row = {
        period: monthKey,
        usageId: usage.id,
        requestId: usage.requestId ?? null,
        userId: usage.apiKey.userId,
        userLabel: this.formatUserLabel(
          usage.apiKey.user,
          usage.apiKey.userId,
          this.financeRowAccount(usage),
          region,
        ),
        workspaceId: usage.tenantId,
        workspaceName: usage.tenant?.name ?? usage.tenantId,
        workspaceType: usage.tenant?.type ?? '',
        productName: usage.product?.name ?? '未绑定产品',
        billingMode: usage.product?.billingMode ?? null,
        apiKeyId: usage.apiKeyId,
        apiKeyPrefix: usage.apiKey.prefix,
        model: usage.model,
        pricingTierKey: usage.pricingTierKey,
        tokenTypeBreakdown: buildTokenTypeBreakdown(tokenBreakdown),
        provider: null,
        channelId: null,
        regularInputTokens: getRegularInputTokens(tokenBreakdown),
        inputTokens: usage.promptTokens,
        cachedInputTokens: usage.cachedInputTokens,
        cacheWriteInputTokens: usage.cacheWriteInputTokens,
        outputTokens: usage.completionTokens,
        totalTokens: usage.totalTokens,
        inputUnitPrice: usdNumber(usage.inputPriceUsdPerM),
        cacheReadUnitPrice: usage.cachedInputPriceUsdPerM == null
          ? null
          : usdNumber(usage.cachedInputPriceUsdPerM),
        cacheWriteUnitPrice: usage.cacheWritePriceUsdPerM == null
          ? null
          : usdNumber(usage.cacheWritePriceUsdPerM),
        outputUnitPrice: usdNumber(usage.outputPriceUsdPerM),
        customerMultiplier: this.financeCustomerMultiplier(usage),
        userChargeUsd: usdNumber(customerChargeUsd),
        userChargeCents,
        paymentDeductionUsd: usdNumber(paymentDeductionUsd),
        voucherDeductionUsd: usdNumber(voucherDeductionUsd),
        creditDeductionUsd: usdNumber(creditDeductionUsd),
        debtDeductionUsd: usdNumber(debtDeductionUsd),
        // 行级分仅供该行展示。月勾稽必须 sumUsdToCents(各行 USD)，不能把这些分加总
        // （头文 9 月按条 2950，先加总再进分 2977）。
        paymentDeductionCents: usdToCents(paymentDeductionUsd),
        voucherDeductionCents: usdToCents(voucherDeductionUsd),
        creditDeductionCents: usdToCents(creditDeductionUsd),
        debtDeductionCents: usdToCents(debtDeductionUsd),
        chargeSource: this.financeApiUsageChargeSource(usage, creditDeductionUsd),
        supplierCostCents,
        grossProfitCents: supplierCostCents == null ? null : userChargeCents - supplierCostCents,
        codingPlanEntitlementId: usage.codingPlanEntitlementId,
        providerEntitlementId: usage.providerEntitlementId,
        createdAt: usage.createdAt,
        evidence: 'token_usage + API Key + upstream usage',
      };
      return this.withFinanceRawUsd(row, {
        userChargeCents: customerChargeUsd,
        paymentDeductionCents: paymentDeductionUsd,
        voucherDeductionCents: voucherDeductionUsd,
        creditDeductionCents: creditDeductionUsd,
        debtDeductionCents: debtDeductionUsd,
        supplierCostCents: supplierCostUsd,
        grossProfitCents: supplierCostUsd == null ? null : customerChargeUsd.minus(supplierCostUsd),
      });
    });
  }

  private mapFinanceBalanceGrantRows(monthKey: string, balanceGrants: Array<FinanceGrantRow>, region?: PlatformRegion) {
    return balanceGrants.map((grant) => {
      this.assertFinanceGrantLedgerReady(grant);
      this.getFinanceGrantRemainingComponents(grant);
      return this.withFinanceRawUsd({
      period: monthKey,
      grantId: grant.id,
      userId: grant.userId,
      userLabel: this.formatUserLabel(grant.user, grant.userId, this.financeRowAccount(grant), region),
      workspaceId: grant.tenantId,
      workspaceName: grant.tenant?.name ?? grant.tenantId,
      workspaceType: grant.tenant?.type ?? '',
      productName: grant.product?.name ?? '未绑定产品',
      billingMode: grant.product?.billingMode ?? grant.attribution?.billingMode ?? null,
      rechargeOrderId: grant.orderId,
      source: grant.source,
      paidCents: usdToCents(grant.paidAmountUsd),
      bonusCents: usdToCents(grant.bonusAmountUsd),
      grantedCents: usdToCents(grant.grantedAmountUsd),
      remainingCents: usdToCents(grant.remainingAmountUsd),
      consumedCents: usdToCents(grant.grantedAmountUsd.minus(grant.remainingAmountUsd)),
      discountRate: usdNumber(grant.discountRate),
      validFrom: grant.validFrom,
      expiresAt: grant.expiresAt,
      isExpired: grant.isExpired,
      issuedAt: this.financeGrantIssuedAt(grant),
      createdAt: grant.createdAt,
      auditNote: '充值实付与赠额同批次消耗；折扣率=实付/(实付+赠额)',
      }, {
        paidCents: grant.paidAmountUsd,
        bonusCents: grant.bonusAmountUsd,
        grantedCents: grant.grantedAmountUsd,
        remainingCents: grant.remainingAmountUsd,
        consumedCents: grant.grantedAmountUsd.minus(grant.remainingAmountUsd),
      });
    });
  }

  private mapFinanceBalanceAllocationRows(
    monthKey: string,
    balanceConsumptionAllocations: Array<FinanceAllocationRow>,
    region?: PlatformRegion,
  ) {
    return balanceConsumptionAllocations.map((allocation) => {
      if (allocation.balanceGrant) {
        this.assertFinanceGrantLedgerReady(allocation.balanceGrant);
        this.getFinanceGrantRemainingComponents(allocation.balanceGrant);
      }
      const transactionAttribution = allocation.balanceTransaction?.attribution;
      const product = allocation.product
        ?? (transactionAttribution ? null : allocation.balanceGrant?.product)
        ?? null;
      const billingMode = allocation.product?.billingMode
        ?? transactionAttribution?.billingMode
        ?? allocation.balanceGrant?.product?.billingMode
        ?? allocation.balanceGrant?.attribution?.billingMode
        ?? null;
      return this.withFinanceRawUsd({
      period: monthKey,
      allocationId: allocation.id,
      transactionId: allocation.balanceTransactionId,
      usageId: allocation.tokenUsageId,
      userId: allocation.userId,
      userLabel: this.formatUserLabel(
        allocation.user,
        allocation.userId,
        this.financeRowAccount(allocation) ?? this.financeRowAccount(allocation.balanceGrant ?? {}),
        region,
      ),
      workspaceId: allocation.tenantId,
      workspaceName: allocation.tenant?.name ?? allocation.tenantId,
      workspaceType: allocation.tenant?.type ?? '',
      productName: product?.name ?? '未绑定产品',
      billingMode,
      rechargeGrantId: allocation.balanceGrantId ?? '',
      rechargeOrderId: allocation.balanceGrant?.orderId ?? null,
      consumedCents: usdToCents(allocation.amountUsd),
      recognizedRevenueCents: usdToCents(allocation.recognizedRevenueUsd),
      bonusConsumedCents: usdToCents(allocation.bonusConsumedUsd),
      discountRate: usdNumber(allocation.discountRate),
      grantPaidCents: allocation.balanceGrant ? usdToCents(allocation.balanceGrant.paidAmountUsd) : 0,
      grantBonusCents: allocation.balanceGrant ? usdToCents(allocation.balanceGrant.bonusAmountUsd) : 0,
      grantTotalCents: allocation.balanceGrant ? usdToCents(allocation.balanceGrant.grantedAmountUsd) : 0,
      grantRemainingCents: allocation.balanceGrant ? usdToCents(allocation.balanceGrant.remainingAmountUsd) : 0,
      grantSource: allocation.balanceGrant?.source ?? allocation.source ?? 'ENTERPRISE_CREDIT',
      grantExpiresAt: allocation.balanceGrant?.expiresAt ?? null,
      transactionDescription: allocation.balanceTransaction?.description ?? '',
      createdAt: allocation.createdAt,
      auditNote: allocation.balanceGrant
        ? '消耗按充值批次 FIFO 分摊；确认收入=消耗金额*折扣率'
        : '企业信用消费分摊；消费金额计入用量，确认收入待账期结算',
      }, {
        consumedCents: allocation.amountUsd,
        recognizedRevenueCents: allocation.recognizedRevenueUsd,
        bonusConsumedCents: allocation.bonusConsumedUsd,
        grantPaidCents: allocation.balanceGrant?.paidAmountUsd,
        grantBonusCents: allocation.balanceGrant?.bonusAmountUsd,
        grantTotalCents: allocation.balanceGrant?.grantedAmountUsd,
        grantRemainingCents: allocation.balanceGrant?.remainingAmountUsd,
      });
    });
  }

  private mapFinanceEnterpriseCreditConsumptionRows(
    monthKey: string,
    allocations: FinanceAllocationRow[],
    region?: PlatformRegion,
  ) {
    return allocations.map((allocation) => {
      const consumedUsd = usd(allocation.amountUsd);
      const settledUsd = usd(allocation.settledUsd ?? 0);
      const outstandingUsd = this.maxUsd(usd(0), consumedUsd.minus(settledUsd));
      const row = {
        id: allocation.id,
        period: monthKey,
        allocationId: allocation.id,
        callTime: allocation.tokenUsage?.createdAt ?? allocation.createdAt,
        userId: allocation.userId,
        userLabel: this.formatUserLabel(
          allocation.user ?? allocation.balanceGrant?.user,
          allocation.userId,
          this.financeRowAccount(allocation) ?? this.financeRowAccount(allocation.balanceGrant ?? {}),
          region,
        ),
        workspaceId: allocation.tenantId,
        workspaceName: allocation.tenant?.name ?? allocation.tenantId,
        workspaceType: allocation.tenant?.type ?? '',
        productName: allocation.product?.name ?? '未绑定产品',
        model: allocation.tokenUsage?.model ?? '',
        callType: this.getAllocationCallType(allocation),
        tokenUsage: this.getAllocatedTokens(allocation),
        consumedCents: usdToCents(consumedUsd),
        recognizedRevenueCents: usdToCents(allocation.recognizedRevenueUsd),
        settledCents: usdToCents(settledUsd),
        outstandingCents: usdToCents(outstandingUsd),
        settlementStatus: outstandingUsd.lte(0)
          ? '已结清'
          : settledUsd.gt(0)
            ? '部分结算'
            : '待结算',
        settledAt: allocation.settledAt ?? null,
        source: allocation.source ?? BALANCE_ALLOCATION_SOURCE_ENTERPRISE_CREDIT,
      };
      return this.withFinanceRawUsd(row, {
        consumedCents: consumedUsd,
        recognizedRevenueCents: allocation.recognizedRevenueUsd,
        settledCents: settledUsd,
        outstandingCents: outstandingUsd,
      });
    });
  }

  private async buildEnterpriseCreditConsumptionSummary(params: {
    monthKey: string;
    start: Date;
    end: Date;
    billingMode?: FinanceReportBillingMode;
    filter?: FinanceReportFilter | null;
    db?: FinanceReadClient;
  }) {
    const db = params.db ?? this.prisma;
    const rows = await db.balanceConsumptionAllocation.groupBy({
      by: ['tenantId', 'productId'],
      where: {
        AND: [
          this.withFinanceBalanceAllocationBillingMode(
            { createdAt: { gte: params.start, lt: params.end } },
            params.billingMode,
          ),
          this.financeEnterpriseCreditAllocationWhere(),
          this.financeAllocationFilterWhere(params.filter ?? null),
        ],
      },
      _count: { _all: true },
      _sum: {
        amountUsd: true,
        recognizedRevenueUsd: true,
        settledUsd: true,
      },
    });
    return (await this.mapEnterpriseCreditSummaryGroups(
      params.monthKey,
      rows,
      db,
    )).sort((left, right) => String(left.id).localeCompare(String(right.id)));
  }

  private async mapEnterpriseCreditSummaryGroups(
    monthKey: string,
    rows: Array<{
      tenantId: string;
      productId: string | null;
      _count: { _all: number };
      _sum: {
        amountUsd: Prisma.Decimal | null;
        recognizedRevenueUsd: Prisma.Decimal | null;
        settledUsd: Prisma.Decimal | null;
      };
    }>,
    db: FinanceReadClient,
  ): Promise<Record<string, unknown>[]> {
    const tenantIds = Array.from(new Set(rows.map((row) => row.tenantId)));
    const productIds = Array.from(new Set(rows.map((row) => row.productId).filter((id): id is string => Boolean(id))));
    const [tenants, products] = await Promise.all([
      tenantIds.length > 0
        ? db.tenant.findMany({
          where: { id: { in: tenantIds } },
          select: { id: true, name: true, type: true },
        })
        : Promise.resolve([]),
      productIds.length > 0
        ? db.product.findMany({
          where: { id: { in: productIds } },
          select: { id: true, name: true },
        })
        : Promise.resolve([]),
    ]);
    const tenantMap = new Map(tenants.map((tenant) => [tenant.id, tenant]));
    const productMap = new Map(products.map((product) => [product.id, product]));

    return rows.map((row) => {
      const consumedUsd = usd(row._sum.amountUsd ?? 0);
      const recognizedRevenueUsd = usd(row._sum.recognizedRevenueUsd ?? 0);
      const settledUsd = usd(row._sum.settledUsd ?? 0);
      const outstandingUsd = this.maxUsd(usd(0), consumedUsd.minus(settledUsd));
      const tenant = tenantMap.get(row.tenantId);
      const product = row.productId ? productMap.get(row.productId) : undefined;
      const summaryRow = {
        id: `${row.tenantId}:${row.productId ?? 'none'}`,
        period: monthKey,
        workspaceId: row.tenantId,
        workspaceName: tenant?.name ?? row.tenantId,
        workspaceType: tenant?.type ?? '',
        productName: product?.name ?? '未绑定产品',
        allocationCount: row._count._all,
        consumedCents: usdToCents(consumedUsd),
        recognizedRevenueCents: usdToCents(recognizedRevenueUsd),
        settledCents: usdToCents(settledUsd),
        outstandingCents: usdToCents(outstandingUsd),
        settlementStatus: outstandingUsd.lte(0)
          ? '已结清'
          : settledUsd.gt(0)
            ? '部分结算'
            : '待结算',
      };
      return this.withFinanceRawUsd(summaryRow, {
        consumedCents: consumedUsd,
        recognizedRevenueCents: recognizedRevenueUsd,
        settledCents: settledUsd,
        outstandingCents: outstandingUsd,
      });
    });
  }

  private mapFinanceEnterpriseCreditSettlementRows(
    monthKey: string,
    settlements: FinanceEnterpriseCreditSettlementRow[],
  ) {
    return settlements.map((settlement) => this.withFinanceRawUsd({
      id: settlement.id,
      period: monthKey,
      settlementId: settlement.id,
      settlementCreatedAt: settlement.occurredAt,
      debtSource: settlement.debtSource,
      workspaceId: settlement.allocation.tenantId,
      workspaceName: settlement.allocation.tenant?.name ?? settlement.allocation.tenantId,
      allocationId: settlement.allocationId,
      trigger: settlement.trigger,
      amountCents: usdToCents(settlement.amountUsd),
      paidCents: usdToCents(settlement.paidUsd),
      bonusCents: usdToCents(settlement.bonusUsd),
      repaymentTransactionId: settlement.repaymentTransactionId ?? null,
      repaymentTransactionDescription: settlement.repaymentTransaction?.description ?? '',
    }, {
      amountCents: settlement.amountUsd,
      paidCents: settlement.paidUsd,
      bonusCents: settlement.bonusUsd,
    }));
  }

  private async buildFinanceTemplatesForGrants(
    monthKey: string,
    start: Date,
    end: Date,
    balanceGrants: FinanceGrantRow[],
    db: FinanceReadClient = this.prisma,
    asOf?: Date,
    platformCurrencyCode?: string,
    region?: PlatformRegion,
  ) {
    const grantIds = balanceGrants.map((grant) => grant.id);
    if (grantIds.length === 0) {
      return await this.buildGiftFinanceTemplates({
        monthKey,
        start,
        end,
        balanceGrants: [],
        balanceConsumptionAllocations: [],
        balanceTransactions: [],
        db,
        asOf,
        platformCurrencyCode,
        region,
      });
    }

    const allocationSums = await db.balanceConsumptionAllocation.groupBy({
      by: ['balanceGrantId'],
      where: {
        balanceGrantId: { in: grantIds },
        createdAt: { gte: start, lt: end },
      },
      _sum: {
        amountUsd: true,
        recognizedRevenueUsd: true,
        bonusConsumedUsd: true,
      },
    });
    const balanceTransactions = await this.fetchFinanceBalanceTransactionsForGrants(
      balanceGrants,
      start,
      end,
      db,
    );
    const grantById = new Map(balanceGrants.map((grant) => [grant.id, grant]));
    const allocationStubs = allocationSums.flatMap((row) => {
      if (!row.balanceGrantId) return [];
      const grant = grantById.get(row.balanceGrantId);
      if (!grant) return [];
      const amountUsd = usd(row._sum.amountUsd);
      const recognizedRevenueUsd = usd(row._sum.recognizedRevenueUsd);
      const bonusConsumedUsd = usd(row._sum.bonusConsumedUsd);
      return [{
        id: `aggregate:${row.balanceGrantId}`,
        userId: grant.userId,
        tenantId: grant.tenantId,
        productId: grant.productId,
        balanceTransactionId: '',
        tokenUsageId: null,
        balanceGrantId: row.balanceGrantId,
        billingAccountId: grant.billingAccountId,
        source: 'BALANCE_GRANT',
        amountUsd,
        recognizedRevenueUsd,
        bonusConsumedUsd,
        discountRate: this.financeAllocationDiscountRate(recognizedRevenueUsd, amountUsd),
        createdAt: start,
        user: grant.user,
        tenant: grant.tenant,
        product: grant.product,
        balanceGrant: grant,
        balanceTransaction: null,
        tokenUsage: null,
      } as FinanceAllocationRow];
    });

    return await this.buildGiftFinanceTemplates({
      monthKey,
      start,
      end,
      balanceGrants,
      balanceConsumptionAllocations: allocationStubs,
      balanceTransactions,
      db,
      asOf,
      platformCurrencyCode,
      region,
    });
  }

  private async fetchFinanceBalanceTransactionsForGrants(
    balanceGrants: FinanceGrantRow[],
    start: Date,
    end: Date,
    db: FinanceReadClient = this.prisma,
  ): Promise<FinanceBalanceTransactionRow[]> {
    const expiryTransactionIds = Array.from(new Set(balanceGrants.flatMap((grant) => (
      grant.expiryAudit?.balanceTransactionId
        ? [grant.expiryAudit.balanceTransactionId]
        : []
    ))));
    if (expiryTransactionIds.length === 0) return [];
    return db.balanceTransaction.findMany({
      where: {
        id: { in: expiryTransactionIds },
        createdAt: { gte: start, lt: end },
      },
      select: {
        id: true,
        type: true,
        amountUsd: true,
        orderId: true,
        tokenUsageId: true,
        description: true,
        createdAt: true,
      },
    });
  }

  private getFinanceTemplateNotes() {
    return [
      {
        field: '实际供应商收费',
        status: '当前系统缺失',
        note: 'TokenUsage 记录平台计费金额，未见供应商账单号、供应商实际扣费或上游结算金额。',
      },
      {
        field: '供应商折扣',
        status: '新用量可用',
        note: '命中供应商成本策略的新 TokenUsage 会记录 providerCostMultiplier；历史用量需回填后才可展示。',
      },
      {
        field: '其他变动类型',
        status: '部分可推断',
        note: '余额流水只有 RECHARGE/CONSUME/ADJUST/REFUND，财务细分类依赖 description 文本。',
      },
      {
        field: '批次历史余额',
        status: '部分可推断',
        note: 'BalanceGrant 有当前 remainingAmountUsd，历史期初/期末按当前批次余额和本期流水倒推；若补历史快照表会更严谨。',
      },
    ];
  }

  private getFinanceSupplierCosts() {
    return {
      rows: [],
      status: '未接入供应商账单导入',
      requiredFields: [
        '供应商账单号',
        '供应商',
        '供应商 API Key',
        '模型产品编码',
        '用量',
        '单价',
        '总消费金额',
        '抵扣金额',
        '应付金额',
        '结算状态',
        '原始账单文件',
      ],
    };
  }

  private async loadProvenEnterpriseAbsorbAllocationIds(
    allocations: FinanceAllocationRow[],
    grantMap: ReadonlyMap<string, FinanceGrantRow>,
    db: FinanceReadClient = this.prisma,
  ): Promise<ReadonlySet<string>> {
    const candidates = new Map<string, {
      balanceGrantId: string;
      allocationBillingAccountId: string;
    }>();
    for (const allocation of allocations) {
      if (!allocation.balanceGrantId || !allocation.billingAccountId) continue;
      const grant = grantMap.get(allocation.balanceGrantId);
      if (
        !grant?.billingAccountId
        || grant.billingAccountId === allocation.billingAccountId
      ) {
        continue;
      }
      candidates.set(allocation.id, {
        balanceGrantId: allocation.balanceGrantId,
        allocationBillingAccountId: allocation.billingAccountId,
      });
    }
    const candidateIds = [...candidates.keys()];
    if (candidateIds.length === 0) return new Set<string>();

    const rows = await db.$queryRaw<FinanceEnterpriseAbsorbProofRow[]>(Prisma.sql`
      SELECT
        allocation.id AS "allocationId",
        allocation.balance_grant_id AS "balanceGrantId",
        allocation.billing_account_id AS "allocationBillingAccountId"
      FROM balance_consumption_allocations allocation
      WHERE allocation.id IN (${Prisma.join(candidateIds)})
        AND allocation.balance_grant_id IS NOT NULL
        AND allocation.billing_account_id IS NOT NULL
        AND balance_allocation_has_enterprise_absorb_proof(
          allocation.id,
          allocation.balance_grant_id,
          allocation.billing_account_id
        )
    `);

    const provenIds = new Set<string>();
    for (const row of rows) {
      const candidate = candidates.get(row.allocationId);
      if (
        candidate
        && row.balanceGrantId === candidate.balanceGrantId
        && row.allocationBillingAccountId === candidate.allocationBillingAccountId
      ) {
        provenIds.add(row.allocationId);
      }
    }
    return provenIds;
  }

  private async attachProvenLegacyDebtSettlements(
    grants: FinanceGrantRow[],
    db: FinanceReadClient = this.prisma,
  ): Promise<void> {
    const grantsById = new Map(grants.map((grant) => [grant.id, grant]));
    const grantIds = [...grantsById.keys()];
    const billingAccountIds = [...new Set(grants.flatMap((grant) => (
      grant.billingAccountId ? [grant.billingAccountId] : []
    )))];
    if (grantIds.length === 0 || billingAccountIds.length === 0) return;

    // balance_grant_id did not exist in the legacy enterprise writer. Keep the
    // immutable row untouched and ask the database proof contract for the one
    // effective grant, if any. The account/grant filters keep this one batched
    // report query bounded; the proof itself fails closed on incomplete or
    // ambiguous historical evidence.
    const proofRows = await db.$queryRaw<FinanceLegacySettlementProofRow[]>(Prisma.sql`
      SELECT
        settlement.id AS "settlementId",
        proof."effectiveBalanceGrantId"
      FROM enterprise_credit_settlements settlement
      CROSS JOIN LATERAL (
        SELECT balance_legacy_settlement_effective_grant_id(settlement.id)
          AS "effectiveBalanceGrantId"
      ) proof
      JOIN balance_grants grant_row
        ON grant_row.id = proof."effectiveBalanceGrantId"
      WHERE settlement.balance_grant_id IS NULL
        AND settlement.billing_account_id IN (${Prisma.join(billingAccountIds)})
        AND grant_row.id IN (${Prisma.join(grantIds)})
        AND grant_row.billing_account_id = settlement.billing_account_id
    `);
    const effectiveGrantBySettlementId = new Map<string, string>();
    for (const row of proofRows) {
      if (
        typeof row?.settlementId !== 'string'
        || typeof row?.effectiveBalanceGrantId !== 'string'
        || !grantsById.has(row.effectiveBalanceGrantId)
      ) continue;
      const existing = effectiveGrantBySettlementId.get(row.settlementId);
      if (existing && existing !== row.effectiveBalanceGrantId) {
        this.throwFinanceLedgerReconciliationRequired(
          grantsById.get(existing)!,
          'legacy_settlement_proof_ambiguous',
        );
      }
      effectiveGrantBySettlementId.set(row.settlementId, row.effectiveBalanceGrantId);
    }
    const settlementIds = [...effectiveGrantBySettlementId.keys()];
    if (settlementIds.length === 0) return;

    const settlements = await db.enterpriseCreditSettlement.findMany({
      where: {
        id: { in: settlementIds },
        balanceGrantId: null,
      },
      select: {
        id: true,
        billingAccountId: true,
        allocationId: true,
        repaymentTransactionId: true,
        balanceGrantId: true,
        debtSource: true,
        repairRunId: true,
        trigger: true,
        amountUsd: true,
        paidUsd: true,
        bonusUsd: true,
        occurredAt: true,
        allocation: {
          select: {
            id: true,
            billingAccountId: true,
            source: true,
          },
        },
      },
    });
    const loadedSettlementIds = new Set(settlements.map((settlement) => settlement.id));
    for (const settlementId of settlementIds) {
      if (loadedSettlementIds.has(settlementId)) continue;
      const grantId = effectiveGrantBySettlementId.get(settlementId)!;
      this.throwFinanceLedgerReconciliationRequired(
        grantsById.get(grantId)!,
        'legacy_settlement_proof_stale',
      );
    }
    for (const settlement of settlements) {
      const effectiveGrantId = effectiveGrantBySettlementId.get(settlement.id);
      const grant = effectiveGrantId ? grantsById.get(effectiveGrantId) : null;
      if (!grant) continue;
      if ((grant.debtSettlements ?? []).some((candidate) => candidate.id === settlement.id)) {
        this.throwFinanceLedgerReconciliationRequired(grant, 'legacy_settlement_duplicate');
      }
      grant.debtSettlements = [
        ...(grant.debtSettlements ?? []),
        { ...settlement, legacyEffectiveBalanceGrantId: effectiveGrantId },
      ];
    }
  }

  private async buildGiftFinanceTemplates(params: {
    monthKey: string;
    start: Date;
    end: Date;
    asOf?: Date;
    db?: FinanceReadClient;
    platformCurrencyCode?: string;
    region?: PlatformRegion;
    balanceGrants: FinanceGrantRow[];
    balanceConsumptionAllocations: FinanceAllocationRow[];
    reconstructPeriodFromCompleteLedger?: boolean;
    balanceTransactions: FinanceBalanceTransactionRow[];
  }) {
    const db = params.db ?? this.prisma;
    const platformCurrencyCode = params.platformCurrencyCode
      ?? await this.getPlatformCurrencyCode(db);
    const region = params.region ?? await this.getFinanceReportRegion(db);
    const grantMap = new Map<string, FinanceGrantRow>();
    for (const grant of params.balanceGrants) grantMap.set(grant.id, grant);
    for (const allocation of params.balanceConsumptionAllocations) {
      if (allocation.balanceGrant) grantMap.set(allocation.balanceGrant.id, allocation.balanceGrant);
    }

    const grants = Array.from(grantMap.values());
    await this.attachProvenLegacyDebtSettlements(grants, db);
    const expiryObservationEnd = grants.length > 0
      ? params.asOf
        ? new Date(Math.min(params.end.getTime(), params.asOf.getTime()))
        : await this.resolveFinanceExpiryObservationEnd(params.end, db)
      : params.end;
    for (const grant of grants) {
      this.assertFinanceGrantLedgerReady(grant);
      this.getFinanceGrantRemainingComponents(grant);
    }
    const provenEnterpriseAbsorbAllocationIds = await this.loadProvenEnterpriseAbsorbAllocationIds(
      params.balanceConsumptionAllocations,
      grantMap,
      db,
    );
    const [
      historicalAllocationSums,
      reconstructionPeriodAllocationSums,
      futureAllocationSums,
      invalidAllocationFacts,
      expiryAllocationComponentsByGrantId,
    ] = grants.length === 0
      ? [
        [],
        undefined,
        [],
        [{ invalid_fact_count: BigInt(0) }],
        new Map<string, FinanceGrantExpiryAllocationComponents>(),
      ]
      : await Promise.all([
        db.balanceConsumptionAllocation.groupBy({
          by: ['balanceGrantId'],
          where: {
            balanceGrantId: { in: grants.map((grant) => grant.id) },
            createdAt: { lt: params.start },
          },
          _sum: {
            amountUsd: true,
            recognizedRevenueUsd: true,
            bonusConsumedUsd: true,
          },
        }),
        params.reconstructPeriodFromCompleteLedger
          ? db.balanceConsumptionAllocation.groupBy({
            by: ['balanceGrantId'],
            where: {
              balanceGrantId: { in: grants.map((grant) => grant.id) },
              createdAt: { gte: params.start, lt: params.end },
            },
            _sum: {
              amountUsd: true,
              recognizedRevenueUsd: true,
              bonusConsumedUsd: true,
            },
          })
          : Promise.resolve(undefined),
        db.balanceConsumptionAllocation.groupBy({
          by: ['balanceGrantId'],
          where: {
            balanceGrantId: { in: grants.map((grant) => grant.id) },
            createdAt: { gte: params.end },
          },
          _sum: {
            amountUsd: true,
            recognizedRevenueUsd: true,
            bonusConsumedUsd: true,
          },
        }),
        db.$queryRaw<Array<{ invalid_fact_count: bigint | number }>>(Prisma.sql`
          SELECT COUNT(*)::bigint AS invalid_fact_count
          FROM balance_consumption_allocations allocation
          LEFT JOIN balance_grants grant_row ON grant_row.id = allocation.balance_grant_id
          WHERE allocation.balance_grant_id IN (${Prisma.join(grants.map((grant) => grant.id))})
            AND (
              allocation.source <> 'BALANCE_GRANT'
              OR allocation.billing_account_id IS NULL
              OR grant_row.id IS NULL
              OR grant_row.billing_account_id IS NULL
              OR CASE
                WHEN grant_row.id IS NOT NULL
                  AND grant_row.billing_account_id IS NOT NULL
                  AND allocation.billing_account_id IS NOT NULL
                  AND grant_row.billing_account_id IS DISTINCT FROM allocation.billing_account_id
                THEN NOT COALESCE(
                  balance_allocation_has_enterprise_absorb_proof(
                    allocation.id,
                    grant_row.id,
                    allocation.billing_account_id
                  ),
                  FALSE
                )
                ELSE FALSE
              END
              OR allocation.amount_usd <= 0
              OR allocation.recognized_revenue_usd < 0
              OR allocation.bonus_consumed_usd < 0
              OR allocation.recognized_revenue_usd + allocation.bonus_consumed_usd <> allocation.amount_usd
              OR allocation.discount_rate IS DISTINCT FROM CASE
                WHEN allocation.amount_usd > 0 THEN ROUND(
                  allocation.recognized_revenue_usd / allocation.amount_usd,
                  12
                )
                ELSE 0
              END
              OR allocation.created_at < grant_row.valid_from
              OR (
                grant_row.expires_at IS NOT NULL
                AND allocation.created_at >= grant_row.expires_at
              )
            )
        `),
        this.loadFinanceGrantExpiryAllocationComponents(
          grants,
          params.end,
          expiryObservationEnd,
          db,
        ),
      ]);
    if (Number(invalidAllocationFacts[0]?.invalid_fact_count ?? 0) > 0) {
      this.throwFinanceLedgerReconciliationRequired(grants[0], 'allocation_fact_set');
    }
    const allocationStubs = (
      rows: typeof historicalAllocationSums,
      createdAt: Date,
      prefix: string,
    ) => rows.flatMap((row) => {
      if (!row.balanceGrantId) return [];
      const grant = grantMap.get(row.balanceGrantId);
      if (!grant) return [];
      const amountUsd = usd(row._sum.amountUsd);
      const recognizedRevenueUsd = usd(row._sum.recognizedRevenueUsd);
      const bonusConsumedUsd = usd(row._sum.bonusConsumedUsd);
      return [{
        id: `${prefix}:${row.balanceGrantId}`,
        userId: grant.userId,
        tenantId: grant.tenantId,
        productId: grant.productId,
        balanceTransactionId: '',
        tokenUsageId: null,
        balanceGrantId: row.balanceGrantId,
        billingAccountId: grant.billingAccountId,
        source: 'BALANCE_GRANT',
        amountUsd,
        recognizedRevenueUsd,
        bonusConsumedUsd,
        discountRate: this.financeAllocationDiscountRate(recognizedRevenueUsd, amountUsd),
        createdAt,
        balanceGrant: grant,
      } as FinanceAllocationRow];
    });
    const periodAllocationsForReconstruction = reconstructionPeriodAllocationSums === undefined
      ? params.balanceConsumptionAllocations
      : allocationStubs(
        reconstructionPeriodAllocationSums,
        params.start,
        'period-aggregate',
      );
    const balanceAllocationsForReconstruction = [
      ...allocationStubs(
        historicalAllocationSums,
        new Date(params.start.getTime() - 1),
        'historical-aggregate',
      ),
      ...periodAllocationsForReconstruction,
      ...allocationStubs(futureAllocationSums, params.end, 'future-aggregate'),
    ];
    const allocationsByGrant = new Map<string, FinanceAllocationRow[]>();
    for (const allocation of balanceAllocationsForReconstruction) {
      if (!allocation.balanceGrantId) continue;
      const list = allocationsByGrant.get(allocation.balanceGrantId) ?? [];
      list.push(allocation);
      allocationsByGrant.set(allocation.balanceGrantId, list);
    }

    const transactionsByGrant = this.groupBalanceTransactionsByGrant(params.balanceTransactions);
    const pureGrants = grants.filter((grant) => this.isPureGiftGrant(grant));
    const buyGrants = grants.filter((grant) => this.isBuyGiftGrant(grant));
    const periodAllocations = params.balanceConsumptionAllocations.filter((allocation) => (
      this.isDateInRange(allocation.createdAt, params.start, params.end)
    ));
    const buyGiftAllocations = periodAllocations
      .filter((allocation) => this.isBuyGiftGrant(allocation.balanceGrant));
    const buyGiftOrderIds = buyGrants
      .map((grant) => grant.orderId)
      .filter((orderId): orderId is string => Boolean(orderId));
    const [buyGiftInvoiceAmounts, standardPriceMap] = await Promise.all([
      this.loadFinanceInvoiceAmountsByOrder(buyGiftOrderIds, params.start, params.end, db),
      this.loadFinanceStandardPriceMap(buyGiftAllocations, db),
    ]);

    const pureGiftAccountChangeDetails = pureGrants
      .map((grant) => this.buildPureGiftAccountChangeRow(
        params.monthKey,
        grant,
        allocationsByGrant.get(grant.id) ?? [],
        transactionsByGrant.get(grant.id) ?? [],
        params.start,
        params.end,
        platformCurrencyCode,
        expiryObservationEnd,
        provenEnterpriseAbsorbAllocationIds,
        expiryAllocationComponentsByGrantId.get(grant.id),
        region,
      ))
      .filter((row) => this.hasTemplateRowMovement(row));

    const buyGiftAccountFactRows = buyGrants
      .map((grant) => this.buildBuyGiftAccountChangeRow(
        params.monthKey,
        grant,
        allocationsByGrant.get(grant.id) ?? [],
        transactionsByGrant.get(grant.id) ?? [],
        params.start,
        params.end,
        platformCurrencyCode,
        buyGiftInvoiceAmounts.get(grant.orderId ?? ''),
        expiryObservationEnd,
        provenEnterpriseAbsorbAllocationIds,
        expiryAllocationComponentsByGrantId.get(grant.id),
        region,
      ));
    const buyGiftAccountChangeDetails = buyGiftAccountFactRows
      .filter((row) => this.hasBuyGiftAccountDetailActivity(row));
    const buyGiftPaymentDetails = buyGiftAccountFactRows
      .filter((row) => this.hasBuyGiftPaymentDetailActivity(row))
      .filter((row) => row.rechargeOrderNo)
      .map((row) => this.buildBuyGiftPaymentRow(row));
    const buyGiftPaymentFactRows = buyGiftAccountFactRows
      .filter((row) => row.rechargeOrderNo)
      .map((row) => this.buildBuyGiftPaymentRow(row));

    const pureGiftConsumptionDetails = periodAllocations
      .filter((allocation) => this.isPureGiftGrant(allocation.balanceGrant))
      .flatMap((allocation) => this.buildPureGiftConsumptionRows(params.monthKey, allocation, region));

    const buyGiftConsumptionDetails = buyGiftAllocations
      .flatMap((allocation) => this.buildBuyGiftConsumptionRows(params.monthKey, allocation, standardPriceMap, region));

    return {
      pureGift: {
        accountChangeDetails: pureGiftAccountChangeDetails,
        consumptionDetails: pureGiftConsumptionDetails,
        consumptionSummary: this.groupConsumptionSummary(
          pureGiftConsumptionDetails,
          ['userId', 'model'],
          ['tokenUsage', 'actualSupplierChargeCents', 'estimatedSupplierChargeCents'],
          ['userLabel'],
        ),
      },
      buyGift: {
        accountChangeDetails: buyGiftAccountChangeDetails,
        accountChangeSummary: this.groupAccountSummary(buyGiftAccountFactRows),
        consumptionDetails: buyGiftConsumptionDetails,
        consumptionSummary: this.groupConsumptionSummary(
          buyGiftConsumptionDetails,
          ['userId', 'model'],
          [
            'tokenUsage',
            'consumeAmountCents',
            'consumeAmountPaidCents',
            'actualSupplierChargeCents',
            'estimatedSupplierChargeCents',
          ],
          ['userLabel'],
        ),
        paymentDetails: buyGiftPaymentDetails,
        paymentSummary: this.groupPaymentSummary(buyGiftPaymentFactRows),
      },
      notes: this.getFinanceTemplateNotes(),
    };
  }

  private buildPureGiftAccountChangeRow(
    period: string,
    grant: FinanceGrantRow,
    allocations: FinanceAllocationRow[],
    transactions: FinanceBalanceTransactionRow[],
    start: Date,
    end: Date,
    platformCurrencyCode: string,
    expiryObservationEnd: Date = end,
    provenEnterpriseAbsorbAllocationIds: ReadonlySet<string> = EMPTY_FINANCE_ALLOCATION_PROOF_IDS,
    expiryAllocationComponents?: FinanceGrantExpiryAllocationComponents,
    region?: PlatformRegion,
  ) {
    const changes = this.getGrantPeriodChanges(
      grant,
      allocations,
      transactions,
      start,
      end,
      expiryObservationEnd,
      provenEnterpriseAbsorbAllocationIds,
      expiryAllocationComponents,
    );
    const giftRechargeAmountUsd = usd(grant.bonusAmountUsd);
    const giftRechargeAmountCents = usdToCents(grant.bonusAmountUsd);
    const availableAmountUsd = giftRechargeAmountUsd.plus(changes.otherChangeUsd);
    const cumulativeConsumeOrExpireAmountUsd = this.maxUsd(
      usd(0),
      giftRechargeAmountUsd.minus(changes.closingBalanceUsd),
    );
    const row = {
      period,
      rechargeBatchNo: grant.id,
      userId: grant.userId,
      userLabel: this.formatUserLabel(grant.user, grant.userId, this.financeRowAccount(grant), region),
      currency: this.getGrantCurrency(grant, platformCurrencyCode),
      giftRechargeAmountCents,
      rechargeOrderNo: grant.orderId ?? '',
      rechargeCompletedAt: this.financeGrantIssuedAt(grant),
      expiresAt: grant.expiresAt ?? null,
      otherChangeAmountCents: changes.otherChangeCents,
      otherChangeType: changes.otherChangeType,
      otherChangeAt: changes.otherChangeAt,
      availableAmountCents: usdToCents(availableAmountUsd),
      openingAvailableBalanceCents: changes.openingBalanceCents,
      periodRechargeAmountCents: changes.periodRechargeCents,
      periodConsumeAmountCents: changes.periodConsumeCents,
      periodExpireWriteOffAmountCents: changes.periodExpireCents,
      periodOtherChangeAmountCents: changes.otherChangeCents,
      closingAvailableBalanceCents: changes.closingBalanceCents,
      cumulativeConsumeOrExpireAmountCents: usdToCents(cumulativeConsumeOrExpireAmountUsd),
      source: grant.source,
    };
    return this.withFinanceRawUsd(row, {
      giftRechargeAmountCents: giftRechargeAmountUsd,
      otherChangeAmountCents: changes.otherChangeUsd,
      availableAmountCents: availableAmountUsd,
      openingAvailableBalanceCents: changes.openingBalanceUsd,
      periodRechargeAmountCents: changes.periodRechargeUsd,
      periodConsumeAmountCents: changes.periodConsumeUsd,
      periodExpireWriteOffAmountCents: changes.periodExpireUsd,
      periodOtherChangeAmountCents: changes.otherChangeUsd,
      closingAvailableBalanceCents: changes.closingBalanceUsd,
      cumulativeConsumeOrExpireAmountCents: cumulativeConsumeOrExpireAmountUsd,
    });
  }

  private buildBuyGiftAccountChangeRow(
    period: string,
    grant: FinanceGrantRow,
    allocations: FinanceAllocationRow[],
    transactions: FinanceBalanceTransactionRow[],
    start: Date,
    end: Date,
    platformCurrencyCode: string,
    invoiceAmounts?: FinanceInvoiceAmount,
    expiryObservationEnd: Date = end,
    provenEnterpriseAbsorbAllocationIds: ReadonlySet<string> = EMPTY_FINANCE_ALLOCATION_PROOF_IDS,
    expiryAllocationComponents?: FinanceGrantExpiryAllocationComponents,
    region?: PlatformRegion,
  ) {
    const changes = this.getGrantPeriodChanges(
      grant,
      allocations,
      transactions,
      start,
      end,
      expiryObservationEnd,
      provenEnterpriseAbsorbAllocationIds,
      expiryAllocationComponents,
    );
    const paidRechargeAmountUsd = usd(grant.paidAmountUsd);
    const bonusRechargeAmountUsd = usd(grant.bonusAmountUsd);
    const totalRechargeAmountUsd = paidRechargeAmountUsd.plus(bonusRechargeAmountUsd);
    const paidRechargeAmountCents = usdToCents(grant.paidAmountUsd);
    const bonusRechargeAmountCents = usdToCents(grant.bonusAmountUsd);
    const refundPaidUsd = this.getRefundPaidUsd(grant, start, end);
    const refundBonusUsd = this.getRefundBonusUsd(grant, start, end);
    const refundPaidCents = usdToCents(refundPaidUsd);
    const refundBonusCents = usdToCents(refundBonusUsd);
    const discountRate = usdNumber(grant.discountRate);
    const openingPaidBalanceUsd = changes.openingPaidBalanceUsd;
    const closingPaidBalanceUsd = changes.closingPaidBalanceUsd;
    const periodExpirePaidUsd = changes.periodExpirePaidUsd;
    const periodOtherPaidUsd = changes.otherChangePaidUsd;
    const periodConsumePaidUsd = changes.periodConsumePaidUsd;
    const availableAmountUsd = totalRechargeAmountUsd
      .plus(refundPaidUsd)
      .plus(refundBonusUsd)
      .plus(changes.otherChangeUsd);
    const cumulativeConsumeOrExpireAmountUsd = this.maxUsd(
      usd(0),
      totalRechargeAmountUsd.minus(changes.closingBalanceUsd),
    );
    const cumulativeConsumeOrExpirePaidUsd = this.maxUsd(
      usd(0),
      paidRechargeAmountUsd.minus(closingPaidBalanceUsd),
    );
    const openingPaidBalanceCents = usdToCents(openingPaidBalanceUsd);
    const closingPaidBalanceCents = usdToCents(closingPaidBalanceUsd);
    const periodExpirePaidCents = usdToCents(periodExpirePaidUsd);
    const periodOtherPaidCents = usdToCents(periodOtherPaidUsd);
    const orderPaidInPeriod = this.isDateInRange(grant.order?.paidAt, start, end);
    const orderPaidBeforePeriodEnd = grant.order?.paidAt ? grant.order.paidAt.getTime() < end.getTime() : false;
    const orderRefundInPeriod = this.isDateInRange(grant.order?.refundedAt, start, end);
    const orderRefundBeforePeriodEnd = grant.order?.refundedAt ? grant.order.refundedAt.getTime() < end.getTime() : false;
    const periodCollectionAmountUsd = orderPaidInPeriod ? paidRechargeAmountUsd : usd(0);
    const accumulatedCollectionAmountUsd = orderPaidBeforePeriodEnd ? paidRechargeAmountUsd : usd(0);
    const receivableAmountUsd = paidRechargeAmountUsd.minus(accumulatedCollectionAmountUsd);
    // Batch write-off follows the immutable refund audit's occurredAt, while
    // payment cash-out follows the order/channel refundedAt.  They may land in
    // different accounting periods and must not reuse one period-filtered
    // amount, otherwise the write-off is double-counted or the cash-out lost.
    const periodRefundPaymentAmountUsd = orderRefundInPeriod
      ? this.getTotalRefundPaidUsd(grant)
      : usd(0);
    const accumulatedRefundPaymentAmountCents = orderRefundBeforePeriodEnd && grant.order?.refundAmountCents
      ? -Math.abs(Number(grant.order.refundAmountCents))
      : 0;
    const accumulatedRefundPaymentAmountUsd = centsToUsd(accumulatedRefundPaymentAmountCents);
    const periodInvoiceAmountCents = invoiceAmounts?.periodInvoiceAmountCents ?? 0;
    const accumulatedInvoiceAmountCents = invoiceAmounts?.accumulatedInvoiceAmountCents ?? 0;
    const periodInvoiceAmountUsd = centsToUsd(periodInvoiceAmountCents);
    const accumulatedInvoiceAmountUsd = centsToUsd(accumulatedInvoiceAmountCents);

    const row = {
      period,
      rechargeBatchNo: grant.id,
      userId: grant.userId,
      userLabel: this.formatUserLabel(grant.user, grant.userId, this.financeRowAccount(grant), region),
      currency: this.getGrantCurrency(grant, platformCurrencyCode),
      paidRechargeAmountCents,
      bonusRechargeAmountCents,
      rechargeOrderNo: grant.orderId ?? '',
      rechargeCompletedAt: this.financeGrantIssuedAt(grant),
      rechargeDiscountRate: discountRate,
      refundWriteOffPaidCents: refundPaidCents,
      refundWriteOffBonusCents: refundBonusCents,
      refundCompletedAt: this.isDateInRange(grant.order?.refundedAt, start, end) ? grant.order?.refundedAt : null,
      expiresAt: grant.expiresAt ?? null,
      otherChangeAmountCents: changes.otherChangeCents,
      otherChangeType: changes.otherChangeType,
      otherChangeAt: changes.otherChangeAt,
      availableAmountCents: usdToCents(availableAmountUsd),
      openingAvailableBalanceCents: changes.openingBalanceCents,
      periodRechargeAmountCents: changes.periodRechargeCents,
      periodRefundWriteOffAmountCents: changes.periodRefundCents,
      periodConsumeAmountCents: changes.periodConsumeCents,
      periodExpireWriteOffAmountCents: changes.periodExpireCents,
      periodOtherChangeAmountCents: changes.otherChangeCents,
      closingAvailableBalanceCents: changes.closingBalanceCents,
      cumulativeConsumeOrExpireAmountCents: usdToCents(cumulativeConsumeOrExpireAmountUsd),
      openingAvailableBalancePaidCents: openingPaidBalanceCents,
      periodRechargePaidCents: usdToCents(changes.periodRechargePaidUsd),
      periodRefundWriteOffPaidCents: usdToCents(changes.periodRefundPaidUsd),
      periodConsumePaidCents: usdToCents(periodConsumePaidUsd),
      periodExpireWriteOffPaidCents: periodExpirePaidCents,
      periodOtherChangePaidCents: periodOtherPaidCents,
      closingAvailableBalancePaidCents: closingPaidBalanceCents,
      cumulativeConsumeOrExpirePaidCents: usdToCents(cumulativeConsumeOrExpirePaidUsd),
      periodCollectionAmountCents: usdToCents(periodCollectionAmountUsd),
      accumulatedCollectionAmountCents: usdToCents(accumulatedCollectionAmountUsd),
      receivableAmountCents: usdToCents(receivableAmountUsd),
      periodRefundPaymentAmountCents: usdToCents(periodRefundPaymentAmountUsd),
      accumulatedRefundPaymentAmountCents,
      periodInvoiceAmountCents,
      accumulatedInvoiceAmountCents,
      source: grant.source,
      orderPaidAt: grant.order?.paidAt ?? null,
      orderPaidInPeriod,
      orderPaidBeforePeriodEnd,
      orderTradeNo: grant.order?.tradeNo ?? '',
      orderChannel: grant.order?.channel ?? '',
      orderStatus: grant.order?.status ?? '',
      orderRefundAmountCents: grant.order?.refundAmountCents ?? 0,
      orderRefundInPeriod,
      orderRefundBeforePeriodEnd,
    };
    return this.withFinanceRawUsd(row, {
      paidRechargeAmountCents: paidRechargeAmountUsd,
      bonusRechargeAmountCents: bonusRechargeAmountUsd,
      refundWriteOffPaidCents: refundPaidUsd,
      refundWriteOffBonusCents: refundBonusUsd,
      otherChangeAmountCents: changes.otherChangeUsd,
      availableAmountCents: availableAmountUsd,
      openingAvailableBalanceCents: changes.openingBalanceUsd,
      periodRechargeAmountCents: changes.periodRechargeUsd,
      periodRefundWriteOffAmountCents: changes.periodRefundUsd,
      periodConsumeAmountCents: changes.periodConsumeUsd,
      periodExpireWriteOffAmountCents: changes.periodExpireUsd,
      periodOtherChangeAmountCents: changes.otherChangeUsd,
      closingAvailableBalanceCents: changes.closingBalanceUsd,
      cumulativeConsumeOrExpireAmountCents: cumulativeConsumeOrExpireAmountUsd,
      openingAvailableBalancePaidCents: openingPaidBalanceUsd,
      periodRechargePaidCents: changes.periodRechargePaidUsd,
      periodRefundWriteOffPaidCents: changes.periodRefundPaidUsd,
      periodConsumePaidCents: periodConsumePaidUsd,
      periodExpireWriteOffPaidCents: periodExpirePaidUsd,
      periodOtherChangePaidCents: periodOtherPaidUsd,
      closingAvailableBalancePaidCents: closingPaidBalanceUsd,
      cumulativeConsumeOrExpirePaidCents: cumulativeConsumeOrExpirePaidUsd,
      periodCollectionAmountCents: periodCollectionAmountUsd,
      accumulatedCollectionAmountCents: accumulatedCollectionAmountUsd,
      receivableAmountCents: receivableAmountUsd,
      periodRefundPaymentAmountCents: periodRefundPaymentAmountUsd,
      accumulatedRefundPaymentAmountCents: accumulatedRefundPaymentAmountUsd,
      periodInvoiceAmountCents: periodInvoiceAmountUsd,
      accumulatedInvoiceAmountCents: accumulatedInvoiceAmountUsd,
    });
  }

  private buildPureGiftConsumptionRows(
    period: string,
    allocation: FinanceAllocationRow,
    region?: PlatformRegion,
  ): Record<string, unknown>[] {
    const usage = allocation.tokenUsage;
    const common = this.buildConsumptionCommonFields(period, allocation, region);
    const parts = this.getConsumptionTokenParts(usage);
    const allocatedSupplierCostUsd = this.getAllocatedSupplierCostEstimate(allocation);
    const supplierDiscount = this.getSupplierDiscount(usage);
    if (parts.length === 0) {
      const row = {
        ...common,
        callType: this.getAllocationCallType(allocation),
        tokenUsage: this.getAllocatedTokens(allocation),
        actualSupplierChargeUsd: null,
        actualSupplierChargeCents: null,
        supplierUnitPriceUsdPerM: this.getSupplierBlendedUnitPrice(usage),
        supplierDiscount,
        estimatedSupplierChargeUsd: this.formatNullableUsd(allocatedSupplierCostUsd),
        estimatedSupplierChargeCents: this.usdToNullableCents(allocatedSupplierCostUsd),
      };
      return [this.withFinanceRawUsd(row, {
        estimatedSupplierChargeCents: allocatedSupplierCostUsd,
      })];
    }

    const tokenCounts = this.allocateTokenCounts(parts, this.getAllocatedTokens(allocation));
    const totalSupplierWeight = this.sumUsd(parts, (part) => part.supplierWeight);
    return parts.map((part, index) => {
      const allocatedPartSupplierCostUsd = this.allocateNullableUsdByWeight(
        allocatedSupplierCostUsd,
        part.supplierWeight,
        totalSupplierWeight,
      );
      const row = {
        ...common,
        rowId: `${allocation.id}-${part.callType}`,
        callType: part.callType,
        tokenUsage: tokenCounts[index] ?? 0,
        actualSupplierChargeUsd: null,
        actualSupplierChargeCents: null,
        supplierUnitPriceUsdPerM: this.formatNullableUsd(part.supplierUnitPriceUsdPerM),
        supplierDiscount,
        estimatedSupplierChargeUsd: this.formatNullableUsd(allocatedPartSupplierCostUsd),
        estimatedSupplierChargeCents: this.usdToNullableCents(allocatedPartSupplierCostUsd),
      };
      return this.withFinanceRawUsd(row, {
        estimatedSupplierChargeCents: allocatedPartSupplierCostUsd,
      });
    });
  }

  private buildBuyGiftConsumptionRows(
    period: string,
    allocation: FinanceAllocationRow,
    standardPriceMap: Map<string, FinanceStandardPrice> = new Map(),
    region?: PlatformRegion,
  ): Record<string, unknown>[] {
    const usage = allocation.tokenUsage;
    const common = this.buildConsumptionCommonFields(period, allocation, region);
    const parts = this.getConsumptionTokenParts(usage);
    const allocatedSupplierCostUsd = this.getAllocatedSupplierCostEstimate(allocation);
    const supplierDiscount = this.getSupplierDiscount(usage);
    if (parts.length === 0) {
      const row = {
        ...common,
        callType: this.getAllocationCallType(allocation),
        userDiscount: this.getFinanceUserDiscount(
          usage,
          null,
          this.getBlendedUnitPriceDecimal(usage),
          standardPriceMap,
        ),
        unitPriceUsdPerM: this.getBlendedUnitPrice(usage),
        tokenUsage: this.getAllocatedTokens(allocation),
        consumeAmountUsd: usdString(allocation.amountUsd),
        consumeAmountCents: usdToCents(allocation.amountUsd),
        rechargeDiscountRate: usdNumber(allocation.discountRate),
        consumeAmountPaidUsd: usdString(allocation.recognizedRevenueUsd),
        consumeAmountPaidCents: usdToCents(allocation.recognizedRevenueUsd),
        noBalanceConsumptionCallType: '',
        actualSupplierChargeUsd: null,
        actualSupplierChargeCents: null,
        supplierUnitPriceUsdPerM: this.getSupplierBlendedUnitPrice(usage),
        supplierDiscount,
        estimatedSupplierChargeUsd: this.formatNullableUsd(allocatedSupplierCostUsd),
        estimatedSupplierChargeCents: this.usdToNullableCents(allocatedSupplierCostUsd),
      };
      return [this.withFinanceRawUsd(row, {
        consumeAmountCents: allocation.amountUsd,
        consumeAmountPaidCents: allocation.recognizedRevenueUsd,
        estimatedSupplierChargeCents: allocatedSupplierCostUsd,
      })];
    }

    const tokenCounts = this.allocateTokenCounts(parts, this.getAllocatedTokens(allocation));
    const totalWeight = this.sumUsd(parts, (part) => part.weight);
    const totalSupplierWeight = this.sumUsd(parts, (part) => part.supplierWeight);
    return parts.map((part, index) => {
      const consumeAmountUsd = this.allocateUsdByWeight(allocation.amountUsd, part.weight, totalWeight);
      const consumeAmountPaidUsd = this.allocateUsdByWeight(
        allocation.recognizedRevenueUsd,
        part.weight,
        totalWeight,
      );
      const unitPriceUsdPerM = this.formatNullableUsd(part.unitPriceUsdPerM);
      const allocatedPartSupplierCostUsd = this.allocateNullableUsdByWeight(
        allocatedSupplierCostUsd,
        part.supplierWeight,
        totalSupplierWeight,
      );
      const row = {
        ...common,
        rowId: `${allocation.id}-${part.callType}`,
        callType: part.callType,
        userDiscount: this.getFinanceUserDiscount(
          usage,
          part.callType,
          part.unitPriceUsdPerM,
          standardPriceMap,
        ),
        unitPriceUsdPerM,
        tokenUsage: tokenCounts[index] ?? 0,
        consumeAmountUsd: usdString(consumeAmountUsd),
        consumeAmountCents: usdToCents(consumeAmountUsd),
        rechargeDiscountRate: usdNumber(allocation.discountRate),
        consumeAmountPaidUsd: usdString(consumeAmountPaidUsd),
        consumeAmountPaidCents: usdToCents(consumeAmountPaidUsd),
        noBalanceConsumptionCallType: '',
        actualSupplierChargeUsd: null,
        actualSupplierChargeCents: null,
        supplierUnitPriceUsdPerM: this.formatNullableUsd(part.supplierUnitPriceUsdPerM),
        supplierDiscount,
        estimatedSupplierChargeUsd: this.formatNullableUsd(allocatedPartSupplierCostUsd),
        estimatedSupplierChargeCents: this.usdToNullableCents(allocatedPartSupplierCostUsd),
      };
      return this.withFinanceRawUsd(row, {
        consumeAmountCents: consumeAmountUsd,
        consumeAmountPaidCents: consumeAmountPaidUsd,
        estimatedSupplierChargeCents: allocatedPartSupplierCostUsd,
      });
    });
  }

  private buildBuyGiftPaymentRow(row: Record<string, unknown>) {
    const paidRechargeAmountCents = Number(row.paidRechargeAmountCents ?? 0);
    const paidRechargeAmountUsd = this.getFinanceRawUsd(row, 'paidRechargeAmountCents') ?? centsToUsd(paidRechargeAmountCents);
    const periodCollectionAmountCents = Number(row.periodCollectionAmountCents ?? 0);
    const periodCollectionAmountUsd = this.getFinanceRawUsd(row, 'periodCollectionAmountCents')
      ?? centsToUsd(periodCollectionAmountCents);
    const accumulatedCollectionAmountCents = Number(row.accumulatedCollectionAmountCents ?? 0);
    const accumulatedCollectionAmountUsd = this.getFinanceRawUsd(row, 'accumulatedCollectionAmountCents')
      ?? centsToUsd(accumulatedCollectionAmountCents);
    const receivableAmountCents = Number(row.receivableAmountCents ?? 0);
    const receivableAmountUsd = this.getFinanceRawUsd(row, 'receivableAmountCents')
      ?? centsToUsd(receivableAmountCents);
    const refundWriteOffPaidCents = Number(row.periodRefundWriteOffPaidCents ?? 0);
    const refundWriteOffPaidUsd = this.getFinanceRawUsd(row, 'periodRefundWriteOffPaidCents')
      ?? centsToUsd(refundWriteOffPaidCents);
    const periodRefundPaymentAmountCents = Number(row.periodRefundPaymentAmountCents ?? 0);
    const periodRefundPaymentAmountUsd = this.getFinanceRawUsd(row, 'periodRefundPaymentAmountCents')
      ?? centsToUsd(periodRefundPaymentAmountCents);
    const accumulatedRefundPaymentAmountCents = Number(row.accumulatedRefundPaymentAmountCents ?? 0);
    const accumulatedRefundPaymentAmountUsd = this.getFinanceRawUsd(row, 'accumulatedRefundPaymentAmountCents')
      ?? centsToUsd(accumulatedRefundPaymentAmountCents);

    const paymentRow = {
      period: row.period,
      rechargeOrderNo: row.rechargeOrderNo,
      userId: row.userId,
      userLabel: row.userLabel,
      currency: row.currency,
      paidRechargeAmountCents,
      periodCollectionAmountCents,
      accumulatedCollectionAmountCents,
      receivableAmountCents,
      channelTradeNo: row.orderTradeNo,
      refundWriteOffPaidCents,
      periodRefundPaymentAmountCents,
      accumulatedRefundPaymentAmountCents,
      refundChannelTradeNo: row.orderTradeNo,
      paymentChannel: row.orderChannel,
      paymentStatus: row.orderStatus,
    };
    return this.withFinanceRawUsd(paymentRow, {
      paidRechargeAmountCents: paidRechargeAmountUsd,
      periodCollectionAmountCents: periodCollectionAmountUsd,
      accumulatedCollectionAmountCents: accumulatedCollectionAmountUsd,
      receivableAmountCents: receivableAmountUsd,
      refundWriteOffPaidCents: refundWriteOffPaidUsd,
      periodRefundPaymentAmountCents: periodRefundPaymentAmountUsd,
      accumulatedRefundPaymentAmountCents: accumulatedRefundPaymentAmountUsd,
    });
  }

  private buildBuyGiftPaymentSummaryRows(
    period: string,
    start: Date,
    end: Date,
    grants: FinanceGrantRow[],
    platformCurrencyCode: string,
    region?: PlatformRegion,
  ): Record<string, unknown>[] {
    const facts = grants.flatMap((grant) => {
      if (!grant.orderId) return [];
      const paidRechargeAmountUsd = usd(grant.paidAmountUsd);
      const orderPaidInPeriod = this.isDateInRange(grant.order?.paidAt, start, end);
      const orderPaidBeforePeriodEnd = grant.order?.paidAt
        ? grant.order.paidAt.getTime() < end.getTime()
        : false;
      const orderRefundInPeriod = this.isDateInRange(grant.order?.refundedAt, start, end);
      const orderRefundBeforePeriodEnd = grant.order?.refundedAt
        ? grant.order.refundedAt.getTime() < end.getTime()
        : false;
      const periodCollectionAmountUsd = orderPaidInPeriod ? paidRechargeAmountUsd : usd(0);
      const accumulatedCollectionAmountUsd = orderPaidBeforePeriodEnd ? paidRechargeAmountUsd : usd(0);
      const receivableAmountUsd = paidRechargeAmountUsd.minus(accumulatedCollectionAmountUsd);
      const periodRefundPaymentAmountUsd = orderRefundInPeriod
        ? this.getTotalRefundPaidUsd(grant)
        : usd(0);
      const accumulatedRefundPaymentAmountCents = orderRefundBeforePeriodEnd
        && grant.order?.refundAmountCents
        ? -Math.abs(Number(grant.order.refundAmountCents))
        : 0;
      const accumulatedRefundPaymentAmountUsd = centsToUsd(
        accumulatedRefundPaymentAmountCents,
      );
      const row = {
        period,
        userId: grant.userId,
        userLabel: this.formatUserLabel(
          grant.user,
          grant.userId,
          this.financeRowAccount(grant),
          region,
        ),
        currency: this.getGrantCurrency(grant, platformCurrencyCode),
        periodCollectionAmountCents: usdToCents(periodCollectionAmountUsd),
        accumulatedCollectionAmountCents: usdToCents(accumulatedCollectionAmountUsd),
        receivableAmountCents: usdToCents(receivableAmountUsd),
        periodRefundPaymentAmountCents: usdToCents(periodRefundPaymentAmountUsd),
        accumulatedRefundPaymentAmountCents,
      };
      return [this.withFinanceRawUsd(row, {
        periodCollectionAmountCents: periodCollectionAmountUsd,
        accumulatedCollectionAmountCents: accumulatedCollectionAmountUsd,
        receivableAmountCents: receivableAmountUsd,
        periodRefundPaymentAmountCents: periodRefundPaymentAmountUsd,
        accumulatedRefundPaymentAmountCents: accumulatedRefundPaymentAmountUsd,
      })];
    });
    return this.groupPaymentSummary(facts);
  }

  private buildConsumptionCommonFields(
    period: string,
    allocation: FinanceAllocationRow,
    region?: PlatformRegion,
  ) {
    const usage = allocation.tokenUsage;
    return {
      period,
      callTransactionNo: allocation.tokenUsageId ?? allocation.balanceTransactionId,
      callTime: usage?.createdAt ?? allocation.createdAt,
      userId: allocation.userId,
      userLabel: this.formatUserLabel(
        allocation.user ?? allocation.balanceGrant?.user,
        allocation.userId,
        this.financeRowAccount(allocation) ?? this.financeRowAccount(allocation.balanceGrant ?? {}),
        region,
      ),
      rechargeBatchNo: allocation.balanceGrantId ?? '',
      model: usage?.model ?? '',
    };
  }

  private async loadFinanceInvoiceAmountsByOrder(
    orderIds: string[],
    start: Date,
    end: Date,
    db: FinanceReadClient = this.prisma,
  ): Promise<Map<string, FinanceInvoiceAmount>> {
    const uniqueOrderIds = Array.from(new Set(orderIds));
    const result = new Map<string, FinanceInvoiceAmount>();
    if (uniqueOrderIds.length === 0) return result;

    const rows = await db.invoiceApplicationItem.findMany({
      where: {
        orderId: { in: uniqueOrderIds },
        application: { status: InvoiceApplicationStatus.ISSUED },
      },
      select: {
        orderId: true,
        principalCents: true,
        application: {
          select: {
            issuedAt: true,
            issueDate: true,
            createdAt: true,
          },
        },
      },
    });

    for (const row of rows) {
      const invoiceDate = row.application.issuedAt ?? row.application.issueDate ?? row.application.createdAt;
      const timestamp = invoiceDate instanceof Date ? invoiceDate.getTime() : new Date(invoiceDate).getTime();
      if (!Number.isFinite(timestamp) || timestamp >= end.getTime()) continue;
      const current = result.get(row.orderId) ?? {
        periodInvoiceAmountCents: 0,
        accumulatedInvoiceAmountCents: 0,
      };
      const amountCents = Number(row.principalCents ?? 0);
      current.accumulatedInvoiceAmountCents += amountCents;
      if (timestamp >= start.getTime()) {
        current.periodInvoiceAmountCents += amountCents;
      }
      result.set(row.orderId, current);
    }

    return result;
  }

  private async loadFinanceStandardPriceMap(
    allocations: FinanceAllocationRow[],
    db: FinanceReadClient = this.prisma,
  ): Promise<Map<string, FinanceStandardPrice>> {
    const models = Array.from(new Set(
      allocations
        .map((allocation) => allocation.tokenUsage?.model)
        .filter((model): model is string => Boolean(model)),
    ));
    const result = new Map<string, FinanceStandardPrice>();
    if (models.length === 0) return result;

    const rows = await db.modelPricing.findMany({
      where: {
        modelName: { in: models },
        isActive: true,
      },
      select: {
        modelName: true,
        inputPricePerMToken: true,
        outputPricePerMToken: true,
        cachedInputPrice: true,
        cacheWrite5minPrice: true,
        cacheWrite1hPrice: true,
        longContextInputPrice: true,
        longContextOutputPrice: true,
        priceTiers: {
          where: { isActive: true },
          select: {
            tierKey: true,
            inputPricePerMToken: true,
            outputPricePerMToken: true,
            cachedInputPrice: true,
            cacheWritePrice: true,
          },
        },
      },
    });

    for (const row of rows) {
      result.set(this.financeStandardPriceKey(row.modelName), this.toFinanceStandardPrice(row.modelName, {
        inputPricePerMToken: row.inputPricePerMToken,
        outputPricePerMToken: row.outputPricePerMToken,
        cachedInputPrice: row.cachedInputPrice,
        cacheWritePrice: row.cacheWrite5minPrice ?? row.cacheWrite1hPrice,
      }));

      if (row.longContextInputPrice != null || row.longContextOutputPrice != null) {
        result.set(this.financeStandardPriceKey(row.modelName, 'long_context'), this.toFinanceStandardPrice(row.modelName, {
          inputPricePerMToken: row.longContextInputPrice ?? row.inputPricePerMToken,
          outputPricePerMToken: row.longContextOutputPrice ?? row.outputPricePerMToken,
          cachedInputPrice: row.cachedInputPrice,
          cacheWritePrice: row.cacheWrite5minPrice ?? row.cacheWrite1hPrice,
        }));
      }

      for (const tier of row.priceTiers ?? []) {
        result.set(this.financeStandardPriceKey(row.modelName, tier.tierKey), this.toFinanceStandardPrice(row.modelName, {
          inputPricePerMToken: tier.inputPricePerMToken,
          outputPricePerMToken: tier.outputPricePerMToken,
          cachedInputPrice: tier.cachedInputPrice,
          cacheWritePrice: tier.cacheWritePrice,
        }));
      }
    }

    return result;
  }

  private toFinanceStandardPrice(
    modelName: string,
    prices: {
      inputPricePerMToken: Prisma.Decimal | number | string;
      outputPricePerMToken: Prisma.Decimal | number | string;
      cachedInputPrice?: Prisma.Decimal | number | string | null;
      cacheWritePrice?: Prisma.Decimal | number | string | null;
    },
  ): FinanceStandardPrice {
    const inputPriceUsdPerM = usd(prices.inputPricePerMToken);
    return {
      inputPriceUsdPerM,
      cachedInputPriceUsdPerM: prices.cachedInputPrice == null
        ? this.deriveFinanceCachedInputStandardPrice(modelName, inputPriceUsdPerM)
        : usd(prices.cachedInputPrice),
      cacheWritePriceUsdPerM: prices.cacheWritePrice == null ? null : usd(prices.cacheWritePrice),
      outputPriceUsdPerM: usd(prices.outputPricePerMToken),
    };
  }

  private financeStandardPriceKey(model: string, pricingTierKey?: string | null): string {
    return `${model}\u0000${pricingTierKey ?? ''}`;
  }

  private getFinanceUserDiscount(
    usage: FinanceAllocationRow['tokenUsage'],
    callType: FinanceConsumptionTokenPart['callType'] | null,
    effectiveUnitPriceUsdPerM: Prisma.Decimal | number | string | null,
    standardPriceMap: Map<string, FinanceStandardPrice>,
  ): number | null {
    if (!usage || effectiveUnitPriceUsdPerM == null) return null;
    const standardPrice = this.getFinanceStandardPriceForUsage(usage, standardPriceMap);
    const standardUnitPrice = this.getFinanceStandardUnitPrice(usage, callType, standardPrice);
    if (!standardUnitPrice || standardUnitPrice.lte(0)) return null;
    return usd(effectiveUnitPriceUsdPerM)
      .div(standardUnitPrice)
      .toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP)
      .toNumber();
  }

  private getFinanceStandardPriceForUsage(
    usage: FinanceAllocationRow['tokenUsage'],
    standardPriceMap: Map<string, FinanceStandardPrice>,
  ): FinanceStandardPrice | null {
    if (!usage) return null;
    return standardPriceMap.get(this.financeStandardPriceKey(usage.model, usage.pricingTierKey))
      ?? standardPriceMap.get(this.financeStandardPriceKey(usage.model))
      ?? null;
  }

  private getFinanceStandardUnitPrice(
    usage: FinanceAllocationRow['tokenUsage'],
    callType: FinanceConsumptionTokenPart['callType'] | null,
    standardPrice: FinanceStandardPrice | null,
  ): Prisma.Decimal | null {
    if (!usage || !standardPrice) return null;
    if (callType === 'input') return standardPrice.inputPriceUsdPerM;
    if (callType === 'output') return standardPrice.outputPriceUsdPerM;
    if (callType === 'cache read') {
      return standardPrice.cachedInputPriceUsdPerM
        ?? this.getFinanceStandardBlendedUnitPrice(usage, standardPrice);
    }
    if (callType === 'cache write') {
      return standardPrice.cacheWritePriceUsdPerM
        ?? this.getFinanceStandardBlendedUnitPrice(usage, standardPrice);
    }
    return this.getFinanceStandardBlendedUnitPrice(usage, standardPrice);
  }

  private getFinanceStandardBlendedUnitPrice(
    usage: FinanceAllocationRow['tokenUsage'],
    standardPrice: FinanceStandardPrice,
  ): Prisma.Decimal | null {
    if (!usage) return null;
    const tokenBreakdown = {
      inputTokens: usage.promptTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteInputTokens: usage.cacheWriteInputTokens,
      outputTokens: usage.completionTokens,
    };
    const regularInputTokens = Math.max(0, getRegularInputTokens(tokenBreakdown));
    const cachedInputTokens = Math.max(0, usage.cachedInputTokens ?? 0);
    const cacheWriteInputTokens = Math.max(0, usage.cacheWriteInputTokens ?? 0);
    const outputTokens = Math.max(0, usage.completionTokens);
    const totalTokens = regularInputTokens + cachedInputTokens + cacheWriteInputTokens + outputTokens;
    if (totalTokens <= 0) return null;

    const cachedInputPrice = standardPrice.cachedInputPriceUsdPerM ?? standardPrice.inputPriceUsdPerM;
    const cacheWritePrice = standardPrice.cacheWritePriceUsdPerM ?? standardPrice.inputPriceUsdPerM;
    return usd(regularInputTokens)
      .mul(standardPrice.inputPriceUsdPerM)
      .plus(usd(cachedInputTokens).mul(cachedInputPrice))
      .plus(usd(cacheWriteInputTokens).mul(cacheWritePrice))
      .plus(usd(outputTokens).mul(standardPrice.outputPriceUsdPerM))
      .div(totalTokens)
      .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
  }

  private deriveFinanceCachedInputStandardPrice(
    modelName: string,
    inputPriceUsdPerM: Prisma.Decimal,
  ): Prisma.Decimal | null {
    if (modelName !== 'glm-5' && modelName !== 'glm-5-turbo') return null;
    return inputPriceUsdPerM
      .mul('0.2')
      .toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP);
  }

  private getConsumptionTokenParts(
    usage: FinanceAllocationRow['tokenUsage'],
  ): FinanceConsumptionTokenPart[] {
    if (!usage) return [];
    const tokenBreakdown = {
      inputTokens: usage.promptTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteInputTokens: usage.cacheWriteInputTokens,
      outputTokens: usage.completionTokens,
    };
    const fallbackUnitPrice = this.getBlendedUnitPriceDecimal(usage);
    const rawParts = [
      {
        callType: 'input' as const,
        tokens: getRegularInputTokens(tokenBreakdown),
        unitPriceUsdPerM: usage.inputPriceUsdPerM,
        supplierUnitPriceUsdPerM: usage.providerInputCostUsdPerM ?? null,
      },
      {
        callType: 'cache read' as const,
        tokens: usage.cachedInputTokens ?? 0,
        unitPriceUsdPerM: usage.cachedInputPriceUsdPerM ?? fallbackUnitPrice,
        supplierUnitPriceUsdPerM: usage.providerCachedInputCostUsdPerM ?? null,
      },
      {
        callType: 'cache write' as const,
        tokens: usage.cacheWriteInputTokens ?? 0,
        unitPriceUsdPerM: usage.cacheWritePriceUsdPerM ?? fallbackUnitPrice,
        supplierUnitPriceUsdPerM: usage.providerCacheWriteCostUsdPerM ?? null,
      },
      {
        callType: 'output' as const,
        tokens: usage.completionTokens,
        unitPriceUsdPerM: usage.outputPriceUsdPerM,
        supplierUnitPriceUsdPerM: usage.providerOutputCostUsdPerM ?? null,
      },
    ];

    return rawParts.flatMap((part) => {
      if (!Number.isFinite(part.tokens) || part.tokens <= 0) return [];
      const unitPriceUsdPerM = part.unitPriceUsdPerM == null ? fallbackUnitPrice : usd(part.unitPriceUsdPerM);
      const supplierUnitPriceUsdPerM = part.supplierUnitPriceUsdPerM == null
        ? null
        : usd(part.supplierUnitPriceUsdPerM);
      const priceWeight = unitPriceUsdPerM?.gt(0)
        ? usd(part.tokens).mul(unitPriceUsdPerM).div(1_000_000)
        : usd(0);
      const supplierWeight = supplierUnitPriceUsdPerM?.gt(0)
        ? usd(part.tokens).mul(supplierUnitPriceUsdPerM).div(1_000_000)
        : usd(0);
      return [{
        callType: part.callType,
        tokens: Math.floor(part.tokens),
        unitPriceUsdPerM,
        supplierUnitPriceUsdPerM,
        weight: priceWeight.gt(0) ? priceWeight : usd(part.tokens),
        supplierWeight,
      }];
    });
  }

  private allocateTokenCounts(parts: FinanceConsumptionTokenPart[], totalTokens: number): number[] {
    const sourceTotal = parts.reduce((sum, part) => sum + part.tokens, 0);
    if (sourceTotal <= 0 || totalTokens <= 0) return parts.map(() => 0);
    let remaining = totalTokens;
    return parts.map((part, index) => {
      if (index === parts.length - 1) return Math.max(0, remaining);
      const count = Math.max(0, Math.min(remaining, Math.round((totalTokens * part.tokens) / sourceTotal)));
      remaining -= count;
      return count;
    });
  }

  private allocateUsdByWeight(
    total: Prisma.Decimal,
    weight: Prisma.Decimal,
    totalWeight: Prisma.Decimal,
  ): Prisma.Decimal {
    if (totalWeight.lte(0)) return usd(0);
    return usd(total).mul(weight).div(totalWeight).toDecimalPlaces(12);
  }

  private allocateNullableUsdByWeight(
    total: Prisma.Decimal | null,
    weight: Prisma.Decimal,
    totalWeight: Prisma.Decimal,
  ): Prisma.Decimal | null {
    if (total == null) return null;
    const normalizedTotal = usd(total);
    if (normalizedTotal.eq(0)) return usd(0);
    if (totalWeight.lte(0)) return null;
    return normalizedTotal.mul(weight).div(totalWeight).toDecimalPlaces(12);
  }

  private getAllocatedSupplierCostEstimate(
    allocation: FinanceAllocationRow,
  ): Prisma.Decimal | null {
    const usage = allocation.tokenUsage;
    if (usage?.providerCostEstimateUsd == null) return null;
    const providerCost = usd(usage.providerCostEstimateUsd);
    const usageCost = usd(usage.costUsd).abs();
    if (usageCost.lte(0)) return providerCost;
    return providerCost.mul(usd(allocation.amountUsd).abs()).div(usageCost).toDecimalPlaces(12);
  }

  private getBlendedUnitPriceDecimal(
    usage: FinanceAllocationRow['tokenUsage'],
  ): Prisma.Decimal | null {
    if (!usage || usage.totalTokens <= 0) return null;
    return usd(usage.costUsd).mul(1_000_000).div(usage.totalTokens).toDecimalPlaces(12);
  }

  private formatNullableUsd(value: Prisma.Decimal | null): string | null {
    return value == null ? null : usdString(value);
  }

  private usdToNullableCents(value: Prisma.Decimal | null): number | null {
    return value == null ? null : usdToCents(value);
  }

  private assertFinanceGrantIssuanceComponents(grant: FinanceGrantRow): {
    paidUsd: Prisma.Decimal;
    bonusUsd: Prisma.Decimal;
    grantedUsd: Prisma.Decimal;
  } {
    const paidUsd = this.financeGrantDecimal(grant, 'paidAmountUsd', grant.paidAmountUsd);
    const bonusUsd = this.financeGrantDecimal(grant, 'bonusAmountUsd', grant.bonusAmountUsd);
    const grantedUsd = this.financeGrantDecimal(grant, 'grantedAmountUsd', grant.grantedAmountUsd);
    if (
      paidUsd.lt(0)
      || bonusUsd.lt(0)
      || grantedUsd.lt(0)
      || !paidUsd.plus(bonusUsd).eq(grantedUsd)
    ) {
      this.throwFinanceLedgerReconciliationRequired(grant, 'grant_components');
    }
    return { paidUsd, bonusUsd, grantedUsd };
  }

  private getFinanceGrantRemainingComponents(grant: FinanceGrantRow): {
    paidUsd: Prisma.Decimal;
    bonusUsd: Prisma.Decimal;
  } {
    const {
      paidUsd: paidGrantedUsd,
      bonusUsd: bonusGrantedUsd,
      grantedUsd,
    } = this.assertFinanceGrantIssuanceComponents(grant);
    const remainingUsd = this.financeGrantDecimal(grant, 'remainingAmountUsd', grant.remainingAmountUsd);
    if (
      remainingUsd.lt(0)
      || remainingUsd.gt(grantedUsd)
      || grant.remainingPaidAmountUsd == null
      || grant.remainingBonusAmountUsd == null
    ) {
      this.throwFinanceLedgerReconciliationRequired(grant, 'grant_components');
    }

    const paidUsd = this.financeGrantDecimal(
      grant,
      'remainingPaidAmountUsd',
      grant.remainingPaidAmountUsd,
    );
    const bonusUsd = this.financeGrantDecimal(
      grant,
      'remainingBonusAmountUsd',
      grant.remainingBonusAmountUsd,
    );
    if (
      paidUsd.lt(0)
      || bonusUsd.lt(0)
      || !paidUsd.plus(bonusUsd).eq(remainingUsd)
      || paidUsd.gt(paidGrantedUsd)
      || bonusUsd.gt(bonusGrantedUsd)
      || (grant.isExpired && !remainingUsd.eq(0))
    ) {
      this.throwFinanceLedgerReconciliationRequired(grant, 'remaining_components');
    }
    return { paidUsd, bonusUsd };
  }

  private financeGrantDecimal(
    grant: FinanceGrantRow,
    field: string,
    value: Prisma.Decimal | null | undefined,
  ): Prisma.Decimal {
    try {
      const amount = new Prisma.Decimal(value as Prisma.Decimal);
      if (!amount.isFinite()) throw new Error('non-finite');
      return amount;
    } catch {
      this.throwFinanceLedgerReconciliationRequired(grant, field);
    }
  }

  private financeAllocationDiscountRate(
    recognizedRevenueUsd: Prisma.Decimal,
    amountUsd: Prisma.Decimal,
  ): Prisma.Decimal {
    return amountUsd.gt(0)
      ? recognizedRevenueUsd
        .div(amountUsd)
        .toDecimalPlaces(USD_SCALE, Prisma.Decimal.ROUND_HALF_UP)
      : usd(0);
  }

  private throwFinanceLedgerReconciliationRequired(
    grant: FinanceGrantRow,
    reason: string,
  ): never {
    throw new Error(`BALANCE_LEDGER_RECONCILIATION_REQUIRED:${grant.id}:${reason}`);
  }

  private async resolveFinanceExpiryObservationEnd(
    periodEnd: Date,
    db: FinanceReadClient = this.prisma,
  ): Promise<Date> {
    const [clock] = await db.$queryRaw<Array<{ financialNow: Date }>>(Prisma.sql`
      SELECT ${POSTGRES_UTC_FINANCIAL_CLOCK} AS "financialNow"
    `);
    if (!clock?.financialNow || Number.isNaN(clock.financialNow.getTime())) {
      throw new Error('BALANCE_FINANCIAL_CLOCK_UNAVAILABLE:finance_report');
    }
    return new Date(Math.min(periodEnd.getTime(), clock.financialNow.getTime()));
  }

  private async loadFinanceGrantExpiryAllocationComponents(
    grants: FinanceGrantRow[],
    periodEnd: Date,
    expiryObservationEnd: Date,
    db: FinanceReadClient = this.prisma,
  ): Promise<ReadonlyMap<string, FinanceGrantExpiryAllocationComponents>> {
    const dueGrants = grants.filter((grant) => (
      grant.expiresAt instanceof Date
      && grant.expiresAt.getTime() < periodEnd.getTime()
      && grant.expiresAt.getTime() <= expiryObservationEnd.getTime()
    ));
    if (dueGrants.length === 0) return new Map();

    // Report pagination reconstructs month-level allocation stubs. Those
    // stubs preserve amounts but intentionally discard the original event
    // timestamps, so they cannot answer whether a zero-balance grant was
    // exhausted before its own expiry boundary. Load one bounded aggregate
    // per selected grant from the immutable allocation facts instead.
    const rows = await db.$queryRaw<FinanceGrantExpiryAllocationAggregateRow[]>(Prisma.sql`
      SELECT
        grant_row.id AS "grantId",
        COALESCE(
          SUM(allocation.amount_usd)
            FILTER (
              WHERE allocation.created_at >= grant_row.valid_from
                AND allocation.created_at < grant_row.expires_at
            ),
          0
        ) AS "amountUsd",
        COALESCE(
          SUM(allocation.recognized_revenue_usd)
            FILTER (
              WHERE allocation.created_at >= grant_row.valid_from
                AND allocation.created_at < grant_row.expires_at
            ),
          0
        ) AS "paidUsd",
        COALESCE(
          SUM(allocation.bonus_consumed_usd)
            FILTER (
              WHERE allocation.created_at >= grant_row.valid_from
                AND allocation.created_at < grant_row.expires_at
            ),
          0
        ) AS "bonusUsd",
        COUNT(allocation.id)
          FILTER (WHERE allocation.created_at < grant_row.valid_from)
          AS "beforeValidFromCount",
        COUNT(allocation.id)
          FILTER (WHERE allocation.created_at >= grant_row.expires_at)
          AS "atOrAfterExpiryCount"
      FROM balance_grants grant_row
      LEFT JOIN balance_consumption_allocations allocation
        ON allocation.balance_grant_id = grant_row.id
      WHERE grant_row.id IN (${Prisma.join(dueGrants.map((grant) => grant.id))})
      GROUP BY grant_row.id
    `);

    const dueGrantById = new Map(dueGrants.map((grant) => [grant.id, grant]));
    const componentsByGrantId = new Map<string, FinanceGrantExpiryAllocationComponents>();
    for (const row of rows) {
      const grant = dueGrantById.get(row.grantId);
      if (!grant || componentsByGrantId.has(row.grantId)) {
        this.throwFinanceLedgerReconciliationRequired(
          grant ?? dueGrants[0],
          'expiry_allocation_scope',
        );
      }
      const amountUsd = this.financeGrantDecimal(
        grant,
        'expiry_allocation.amountUsd',
        row.amountUsd,
      );
      const paidUsd = this.financeGrantDecimal(
        grant,
        'expiry_allocation.paidUsd',
        row.paidUsd,
      );
      const bonusUsd = this.financeGrantDecimal(
        grant,
        'expiry_allocation.bonusUsd',
        row.bonusUsd,
      );
      const beforeValidFromCount = Number(row.beforeValidFromCount);
      const atOrAfterExpiryCount = Number(row.atOrAfterExpiryCount);
      if (
        amountUsd.lt(0)
        || paidUsd.lt(0)
        || bonusUsd.lt(0)
        || !paidUsd.plus(bonusUsd).eq(amountUsd)
        || !Number.isSafeInteger(beforeValidFromCount)
        || beforeValidFromCount < 0
        || !Number.isSafeInteger(atOrAfterExpiryCount)
        || atOrAfterExpiryCount < 0
      ) {
        this.throwFinanceLedgerReconciliationRequired(grant, 'expiry_allocation_components');
      }
      if (beforeValidFromCount > 0) {
        this.throwFinanceLedgerReconciliationRequired(grant, 'allocation_before_valid_from');
      }
      if (atOrAfterExpiryCount > 0) {
        this.throwFinanceLedgerReconciliationRequired(grant, 'allocation_at_or_after_expiry');
      }
      componentsByGrantId.set(grant.id, { paidUsd, bonusUsd });
    }
    for (const grant of dueGrants) {
      if (!componentsByGrantId.has(grant.id)) {
        this.throwFinanceLedgerReconciliationRequired(grant, 'expiry_allocation_snapshot_missing');
      }
    }
    return componentsByGrantId;
  }

  private assertFinanceGrantLedgerReady(grant: FinanceGrantRow): void {
    if (
      !grant.billingAccountId
      || !grant.billingAccount
      || grant.billingAccount.id !== grant.billingAccountId
      || grant.billingAccount.balanceGrantLedgerStatus !== BALANCE_GRANT_LEDGER_STATUS_RECONCILED
      || grant.billingAccount.balanceGrantLedgerVersion !== BALANCE_GRANT_LEDGER_VERSION
    ) {
      this.throwFinanceLedgerReconciliationRequired(grant, 'account_marker');
    }
  }

  private financeGrantIssuedAt(grant: FinanceGrantRow): Date {
    return grant.validFrom;
  }

  private getGrantPeriodChanges(
    grant: FinanceGrantRow,
    allocations: FinanceAllocationRow[],
    transactions: FinanceBalanceTransactionRow[],
    start: Date,
    end: Date,
    expiryObservationEnd: Date = end,
    provenEnterpriseAbsorbAllocationIds: ReadonlySet<string> = EMPTY_FINANCE_ALLOCATION_PROOF_IDS,
    expiryAllocationComponents?: FinanceGrantExpiryAllocationComponents,
  ) {
    this.assertFinanceGrantLedgerReady(grant);
    this.getFinanceGrantRemainingComponents(grant);
    this.assertFinanceGrantMovementComponents(
      grant,
      allocations,
      provenEnterpriseAbsorbAllocationIds,
    );
    const expiresAt = grant.expiresAt instanceof Date ? grant.expiresAt : null;
    const expiryDueBeforeObservationEnd = expiresAt !== null
      && expiresAt.getTime() < end.getTime()
      && expiresAt.getTime() <= expiryObservationEnd.getTime();
    if (expiryDueBeforeObservationEnd && !expiryAllocationComponents) {
      this.throwFinanceLedgerReconciliationRequired(grant, 'expiry_allocation_snapshot_missing');
    }
    // The expiry writer intentionally discovers only grants with positive
    // remaining balance. A grant fully consumed before expiry therefore has no
    // financial expiry edge and does not carry a zero-value expiry audit. For
    // report entrypoints, expiryAllocationComponents comes from exact database
    // facts at this grant's own expiry boundary rather than month-level stubs.
    const componentsAtExpiry = expiryDueBeforeObservationEnd && expiresAt
      ? this.replayFinanceGrantComponents(
        grant,
        allocations,
        expiresAt,
        expiryAllocationComponents!,
      )
      : null;
    const hadBalanceAtExpiry = componentsAtExpiry !== null
      && componentsAtExpiry.paidUsd.plus(componentsAtExpiry.bonusUsd).gt(0);
    if (
      expiryDueBeforeObservationEnd
      && hadBalanceAtExpiry
      && (
        !grant.isExpired
        || !grant.expiryAudit
        || !(grant.expiryAudit.createdAt instanceof Date)
        || grant.expiryAudit.createdAt.getTime() >= end.getTime()
      )
    ) {
      this.throwFinanceLedgerReconciliationRequired(grant, 'expiry_due_unreconciled');
    }
    const grantIssuedInPeriod = this.isDateInRange(
      this.financeGrantIssuedAt(grant),
      start,
      end,
    );
    const periodRechargePaidUsd = grantIssuedInPeriod ? usd(grant.paidAmountUsd) : usd(0);
    const periodRechargeBonusUsd = grantIssuedInPeriod ? usd(grant.bonusAmountUsd) : usd(0);
    const periodRechargeUsd = periodRechargePaidUsd.plus(periodRechargeBonusUsd);

    const periodAllocations = allocations.filter((allocation) => (
      this.isDateInRange(allocation.createdAt, start, end)
    ));
    const allocationConsumePaidUsd = this.sumUsd(
      periodAllocations,
      (allocation) => allocation.recognizedRevenueUsd,
    );
    const allocationConsumeBonusUsd = this.sumUsd(
      periodAllocations,
      (allocation) => allocation.bonusConsumedUsd,
    );
    // Funding settlements linked to this grant are the part of a recharge or
    // voucher that immediately paid down an existing negative balance. They
    // reduce this grant just like consumption. REFUND_NETTING is excluded here
    // because its exact reduction is represented by refundAllocations below.
    const periodSettlements = (grant.debtSettlements ?? []).filter((settlement) => (
      settlement.trigger !== 'REFUND_NETTING'
      && this.isDateInRange(settlement.occurredAt, start, end)
    ));
    const settlementConsumePaidUsd = this.sumUsd(
      periodSettlements,
      (settlement) => settlement.paidUsd,
    );
    const settlementConsumeBonusUsd = this.sumUsd(
      periodSettlements,
      (settlement) => settlement.bonusUsd,
    );
    const periodConsumePaidUsd = allocationConsumePaidUsd
      .plus(settlementConsumePaidUsd)
      .neg();
    const periodConsumeBonusUsd = allocationConsumeBonusUsd
      .plus(settlementConsumeBonusUsd)
      .neg();
    const periodConsumeUsd = periodConsumePaidUsd.plus(periodConsumeBonusUsd);

    const periodRefundTargets = (grant.refundAllocations ?? []).filter((allocation) => (
      allocation.role === 'TARGET_UNUSED'
      && this.isDateInRange(allocation.refund.occurredAt, start, end)
    ));
    const periodRefundPaidReductionUsd = this.sumUsd(
      periodRefundTargets,
      (allocation) => allocation.paidReductionUsd,
    );
    const periodRefundBonusReductionUsd = this.sumUsd(
      periodRefundTargets,
      (allocation) => allocation.bonusReductionUsd,
    );
    const periodRefundPaidUsd = periodRefundPaidReductionUsd.gt(0)
      ? periodRefundPaidReductionUsd.neg()
      : usd(0);
    const periodRefundBonusUsd = periodRefundBonusReductionUsd.gt(0)
      ? periodRefundBonusReductionUsd.neg()
      : usd(0);
    const periodRefundUsd = periodRefundPaidUsd.plus(periodRefundBonusUsd);

    const expiryTransactions = transactions.filter((tx) => this.isExpiryTransactionForGrant(tx, grant.id));
    const expiryAudit = grant.expiryAudit ?? null;
    if ((grant.isExpired || expiryTransactions.length > 0) && !expiryAudit) {
      this.throwFinanceLedgerReconciliationRequired(grant, 'expiry_audit_missing');
    }
    if (expiryAudit) {
      this.assertFinanceExpiryAudit(grant, expiryAudit, expiryTransactions, start, end);
      if (
        expiryDueBeforeObservationEnd
        && componentsAtExpiry
        && (
          !usd(expiryAudit.nominalPaidUsd).eq(componentsAtExpiry.paidUsd)
          || !usd(expiryAudit.nominalBonusUsd).eq(componentsAtExpiry.bonusUsd)
        )
      ) {
        this.throwFinanceLedgerReconciliationRequired(grant, 'expiry_audit_replay_components');
      }
    }
    const expiryAuditInPeriod = expiryAudit
      && this.isDateInRange(expiryAudit.createdAt, start, end)
      ? expiryAudit
      : null;
    const periodExpireUsd = expiryAuditInPeriod
      ? usd(expiryAuditInPeriod.nominalAmountUsd).neg()
      : usd(0);
    const periodExpirePaidUsd = expiryAuditInPeriod
      ? usd(expiryAuditInPeriod.nominalPaidUsd).neg()
      : usd(0);
    const periodExpireBonusUsd = expiryAuditInPeriod
      ? usd(expiryAuditInPeriod.nominalBonusUsd).neg()
      : usd(0);

    const otherTransactions = transactions.filter((tx) => this.isOtherGrantTransaction(tx, grant.id));
    if (otherTransactions.length > 0) {
      this.throwFinanceLedgerReconciliationRequired(grant, 'unclassified_transaction_components');
    }
    const refundNetting = (grant.refundAllocations ?? []).filter((allocation) => (
        allocation.role === 'DEBT_NETTING'
        && this.isDateInRange(allocation.refund.occurredAt, start, end)
      ));
    const refundNettingPaidUsd = this.sumUsd(
      refundNetting,
      (allocation) => allocation.paidReductionUsd,
    ).neg();
    const refundNettingBonusUsd = this.sumUsd(
      refundNetting,
      (allocation) => allocation.bonusReductionUsd,
    ).neg();
    const otherChangePaidUsd = refundNettingPaidUsd;
    const otherChangeBonusUsd = refundNettingBonusUsd;
    const otherChangeUsd = otherChangePaidUsd.plus(otherChangeBonusUsd);

    const currentComponents = this.getFinanceGrantRemainingComponents(grant);
    const replayedCurrentComponents = this.replayFinanceGrantComponents(grant, allocations);
    if (
      !replayedCurrentComponents.paidUsd.eq(currentComponents.paidUsd)
      || !replayedCurrentComponents.bonusUsd.eq(currentComponents.bonusUsd)
    ) {
      this.throwFinanceLedgerReconciliationRequired(grant, 'current_components_postcondition');
    }
    const openingComponents = this.replayFinanceGrantComponents(grant, allocations, start);
    const closingComponents = this.replayFinanceGrantComponents(grant, allocations, end);
    const closingPaidBalanceUsd = closingComponents.paidUsd;
    const closingBonusBalanceUsd = closingComponents.bonusUsd;
    const closingBalanceUsd = closingPaidBalanceUsd.plus(closingBonusBalanceUsd);
    const openingPaidBalanceUsd = openingComponents.paidUsd;
    const openingBonusBalanceUsd = openingComponents.bonusUsd;
    if (
      !openingPaidBalanceUsd
        .plus(periodRechargePaidUsd)
        .plus(periodRefundPaidUsd)
        .plus(periodConsumePaidUsd)
        .plus(periodExpirePaidUsd)
        .plus(otherChangePaidUsd)
        .eq(closingPaidBalanceUsd)
      || !openingBonusBalanceUsd
        .plus(periodRechargeBonusUsd)
        .plus(periodRefundBonusUsd)
        .plus(periodConsumeBonusUsd)
        .plus(periodExpireBonusUsd)
        .plus(otherChangeBonusUsd)
        .eq(closingBonusBalanceUsd)
    ) {
      this.throwFinanceLedgerReconciliationRequired(grant, 'period_component_equation');
    }
    const openingBalanceUsd = openingPaidBalanceUsd.plus(openingBonusBalanceUsd);

    return {
      periodRechargeCents: usdToCents(periodRechargeUsd),
      periodConsumeCents: usdToCents(periodConsumeUsd),
      periodExpireCents: usdToCents(periodExpireUsd),
      periodRefundCents: usdToCents(periodRefundUsd),
      otherChangeCents: usdToCents(otherChangeUsd),
      openingBalanceCents: usdToCents(openingBalanceUsd),
      closingBalanceCents: usdToCents(closingBalanceUsd),
      periodRechargeUsd,
      periodRechargePaidUsd,
      periodRechargeBonusUsd,
      periodRefundUsd,
      periodRefundPaidUsd,
      periodRefundBonusUsd,
      periodConsumeUsd,
      periodConsumePaidUsd,
      periodConsumeBonusUsd,
      periodExpireUsd,
      periodExpirePaidUsd,
      periodExpireBonusUsd,
      otherChangeUsd,
      otherChangePaidUsd,
      otherChangeBonusUsd,
      openingBalanceUsd,
      openingPaidBalanceUsd,
      openingBonusBalanceUsd,
      closingBalanceUsd,
      closingPaidBalanceUsd,
      closingBonusBalanceUsd,
      otherChangeType: otherTransactions[0]?.type
        ?? (refundNetting.length > 0 ? 'REFUND_NETTING' : ''),
      otherChangeAt: otherTransactions[0]?.createdAt
        ?? refundNetting[0]?.refund.occurredAt
        ?? null,
    };
  }

  private assertFinanceGrantMovementComponents(
    grant: FinanceGrantRow,
    allocations: FinanceAllocationRow[],
    provenEnterpriseAbsorbAllocationIds: ReadonlySet<string> = EMPTY_FINANCE_ALLOCATION_PROOF_IDS,
    validateAllocationDiscountRate = false,
  ): void {
    for (const allocation of allocations) {
      const amountUsd = this.financeGrantDecimal(
        grant,
        `allocation.${allocation.id}.amountUsd`,
        allocation.amountUsd,
      );
      const paidUsd = this.financeGrantDecimal(
        grant,
        `allocation.${allocation.id}.recognizedRevenueUsd`,
        allocation.recognizedRevenueUsd,
      );
      const bonusUsd = this.financeGrantDecimal(
        grant,
        `allocation.${allocation.id}.bonusConsumedUsd`,
        allocation.bonusConsumedUsd,
      );
      const discountRate = this.financeGrantDecimal(
        grant,
        `allocation.${allocation.id}.discountRate`,
        allocation.discountRate,
      );
      const expectedDiscountRate = this.financeAllocationDiscountRate(paidUsd, amountUsd);
      if (
        allocation.balanceGrantId !== grant.id
        || (
          allocation.billingAccountId !== grant.billingAccountId
          && !provenEnterpriseAbsorbAllocationIds.has(allocation.id)
        )
        || allocation.source !== 'BALANCE_GRANT'
        || amountUsd.lte(0)
        || paidUsd.lt(0)
        || bonusUsd.lt(0)
        || !paidUsd.plus(bonusUsd).eq(amountUsd)
        || (validateAllocationDiscountRate && !discountRate.eq(expectedDiscountRate))
        || !(allocation.createdAt instanceof Date)
        || Number.isNaN(allocation.createdAt.getTime())
      ) {
        this.throwFinanceLedgerReconciliationRequired(grant, 'allocation_components');
      }
    }
    for (const settlement of grant.debtSettlements ?? []) {
      const amountUsd = this.financeGrantDecimal(
        grant,
        `settlement.${settlement.id}.amountUsd`,
        settlement.amountUsd,
      );
      const paidUsd = this.financeGrantDecimal(
        grant,
        `settlement.${settlement.id}.paidUsd`,
        settlement.paidUsd,
      );
      const bonusUsd = this.financeGrantDecimal(
        grant,
        `settlement.${settlement.id}.bonusUsd`,
        settlement.bonusUsd,
      );
      const effectiveBalanceGrantId = settlement.balanceGrantId
        ?? settlement.legacyEffectiveBalanceGrantId;
      const legacyEffectiveGrantShapeValid = settlement.balanceGrantId == null
        ? settlement.legacyEffectiveBalanceGrantId === grant.id
        : settlement.legacyEffectiveBalanceGrantId == null;
      if (
        !grant.billingAccountId
        || effectiveBalanceGrantId !== grant.id
        || !legacyEffectiveGrantShapeValid
        || settlement.billingAccountId !== grant.billingAccountId
        || !settlement.allocation
        || settlement.allocationId == null
        || settlement.allocation.id !== settlement.allocationId
        || settlement.allocation.billingAccountId !== grant.billingAccountId
        || settlement.allocation.source !== settlement.debtSource
        || (
          settlement.debtSource !== BALANCE_ALLOCATION_SOURCE_ENTERPRISE_CREDIT
          && settlement.debtSource !== BALANCE_ALLOCATION_SOURCE_NEGATIVE_BALANCE
        )
        || (
          settlement.trigger !== 'FUNDING'
          && settlement.trigger !== 'SWEEP'
          && settlement.trigger !== 'REFUND_NETTING'
          && settlement.trigger !== 'REPAIR'
        )
        || (
          settlement.trigger === 'REPAIR'
          && (
            settlement.debtSource !== BALANCE_ALLOCATION_SOURCE_NEGATIVE_BALANCE
            || !settlement.repairRunId
            || !settlement.repaymentTransactionId
          )
        )
        || (
          settlement.trigger !== 'REPAIR'
          && settlement.repairRunId != null
        )
        || (
          settlement.trigger === 'REFUND_NETTING'
          && !settlement.repaymentTransactionId
        )
        || amountUsd.lte(0)
        || paidUsd.lt(0)
        || bonusUsd.lt(0)
        || !paidUsd.plus(bonusUsd).eq(amountUsd)
        || !(settlement.occurredAt instanceof Date)
        || Number.isNaN(settlement.occurredAt.getTime())
      ) {
        this.throwFinanceLedgerReconciliationRequired(grant, 'settlement_components');
      }
    }
    for (const allocation of grant.refundAllocations ?? []) {
      const amountUsd = this.financeGrantDecimal(
        grant,
        `refundAllocation.${allocation.id}.amountUsd`,
        allocation.amountUsd,
      );
      const paidUsd = this.financeGrantDecimal(
        grant,
        `refundAllocation.${allocation.id}.paidReductionUsd`,
        allocation.paidReductionUsd,
      );
      const bonusUsd = this.financeGrantDecimal(
        grant,
        `refundAllocation.${allocation.id}.bonusReductionUsd`,
        allocation.bonusReductionUsd,
      );
      if (
        !grant.billingAccountId
        || allocation.balanceGrantId !== grant.id
        || allocation.refund.id !== allocation.refundId
        || allocation.refund.billingAccountId !== grant.billingAccountId
        || allocation.refund.balanceGrant.id !== allocation.refund.balanceGrantId
        || allocation.refund.balanceGrant.billingAccountId !== grant.billingAccountId
        || !allocation.refund.refundTransactionId
        || (allocation.refund.component !== 'PAID' && allocation.refund.component !== 'BONUS')
        || (allocation.role !== 'TARGET_UNUSED' && allocation.role !== 'DEBT_NETTING')
        || !Number.isInteger(allocation.sequence)
        || allocation.sequence <= 0
        || (allocation.role === 'DEBT_NETTING' && !allocation.refund.debtAllocationId)
        || (
          allocation.role === 'TARGET_UNUSED'
          && allocation.refund.balanceGrantId !== grant.id
        )
        || (
          allocation.role === 'TARGET_UNUSED'
          && allocation.refund.component === 'PAID'
          && !bonusUsd.eq(0)
        )
        || (
          allocation.role === 'TARGET_UNUSED'
          && allocation.refund.component === 'BONUS'
          && !paidUsd.eq(0)
        )
        || amountUsd.lte(0)
        || paidUsd.lt(0)
        || bonusUsd.lt(0)
        || !paidUsd.plus(bonusUsd).eq(amountUsd)
        || !(allocation.refund.occurredAt instanceof Date)
        || Number.isNaN(allocation.refund.occurredAt.getTime())
      ) {
        this.throwFinanceLedgerReconciliationRequired(grant, 'refund_components');
      }
    }
  }

  private replayFinanceGrantComponents(
    grant: FinanceGrantRow,
    allocations: FinanceAllocationRow[],
    before?: Date,
    allocationComponentsBeforeBoundary?: FinanceGrantExpiryAllocationComponents,
  ): { paidUsd: Prisma.Decimal; bonusUsd: Prisma.Decimal } {
    const issuedAt = this.financeGrantIssuedAt(grant);
    const issuedBeforeBoundary = !before || issuedAt.getTime() < before.getTime();
    let paidUsd = issuedBeforeBoundary ? usd(grant.paidAmountUsd) : usd(0);
    let bonusUsd = issuedBeforeBoundary ? usd(grant.bonusAmountUsd) : usd(0);
    const happenedBeforeBoundary = (occurredAt: Date) => (
      !before || occurredAt.getTime() < before.getTime()
    );

    if (allocationComponentsBeforeBoundary) {
      paidUsd = paidUsd.minus(allocationComponentsBeforeBoundary.paidUsd);
      bonusUsd = bonusUsd.minus(allocationComponentsBeforeBoundary.bonusUsd);
    } else {
      for (const allocation of allocations) {
        if (!happenedBeforeBoundary(allocation.createdAt)) continue;
        paidUsd = paidUsd.minus(allocation.recognizedRevenueUsd);
        bonusUsd = bonusUsd.minus(allocation.bonusConsumedUsd);
      }
    }
    for (const settlement of grant.debtSettlements ?? []) {
      if (settlement.trigger === 'REFUND_NETTING' || !happenedBeforeBoundary(settlement.occurredAt)) continue;
      paidUsd = paidUsd.minus(settlement.paidUsd);
      bonusUsd = bonusUsd.minus(settlement.bonusUsd);
    }
    for (const allocation of grant.refundAllocations ?? []) {
      if (!happenedBeforeBoundary(allocation.refund.occurredAt)) continue;
      paidUsd = paidUsd.minus(allocation.paidReductionUsd);
      bonusUsd = bonusUsd.minus(allocation.bonusReductionUsd);
    }
    if (grant.expiryAudit && happenedBeforeBoundary(grant.expiryAudit.createdAt)) {
      paidUsd = paidUsd.minus(grant.expiryAudit.nominalPaidUsd);
      bonusUsd = bonusUsd.minus(grant.expiryAudit.nominalBonusUsd);
    }
    if (
      paidUsd.lt(0)
      || bonusUsd.lt(0)
      || paidUsd.gt(usd(grant.paidAmountUsd))
      || bonusUsd.gt(usd(grant.bonusAmountUsd))
    ) {
      this.throwFinanceLedgerReconciliationRequired(grant, 'event_replay_components');
    }
    return { paidUsd, bonusUsd };
  }

  private assertFinanceExpiryAuditComponents(
    grant: FinanceGrantRow,
    audit: NonNullable<FinanceGrantRow['expiryAudit']>,
  ): {
    nominalUsd: Prisma.Decimal;
    nominalPaidUsd: Prisma.Decimal;
    nominalBonusUsd: Prisma.Decimal;
    walletDebitUsd: Prisma.Decimal;
  } {
    const nominalUsd = this.financeGrantDecimal(grant, 'expiry.nominalAmountUsd', audit.nominalAmountUsd);
    const nominalPaidUsd = this.financeGrantDecimal(grant, 'expiry.nominalPaidUsd', audit.nominalPaidUsd);
    const nominalBonusUsd = this.financeGrantDecimal(grant, 'expiry.nominalBonusUsd', audit.nominalBonusUsd);
    const walletDebitUsd = this.financeGrantDecimal(grant, 'expiry.walletDebitUsd', audit.walletDebitUsd);
    const walletDebitPaidUsd = this.financeGrantDecimal(grant, 'expiry.walletDebitPaidUsd', audit.walletDebitPaidUsd);
    const walletDebitBonusUsd = this.financeGrantDecimal(grant, 'expiry.walletDebitBonusUsd', audit.walletDebitBonusUsd);
    const unbackedUsd = this.financeGrantDecimal(grant, 'expiry.unbackedAmountUsd', audit.unbackedAmountUsd);
    const unbackedPaidUsd = this.financeGrantDecimal(grant, 'expiry.unbackedPaidUsd', audit.unbackedPaidUsd);
    const unbackedBonusUsd = this.financeGrantDecimal(grant, 'expiry.unbackedBonusUsd', audit.unbackedBonusUsd);
    const amounts = [
      nominalUsd,
      nominalPaidUsd,
      nominalBonusUsd,
      walletDebitUsd,
      walletDebitPaidUsd,
      walletDebitBonusUsd,
      unbackedUsd,
      unbackedPaidUsd,
      unbackedBonusUsd,
    ];
    if (
      audit.balanceGrantId !== grant.id
      || !grant.billingAccountId
      || audit.billingAccountId !== grant.billingAccountId
      || !grant.isExpired
      || !(grant.expiresAt instanceof Date)
      || !(audit.createdAt instanceof Date)
      || Number.isNaN(audit.createdAt.getTime())
      || audit.createdAt.getTime() < grant.expiresAt.getTime()
      || amounts.some((amount) => amount.lt(0))
      || !nominalPaidUsd.plus(nominalBonusUsd).eq(nominalUsd)
      || !walletDebitPaidUsd.plus(walletDebitBonusUsd).eq(walletDebitUsd)
      || !unbackedPaidUsd.plus(unbackedBonusUsd).eq(unbackedUsd)
      || !walletDebitUsd.plus(unbackedUsd).eq(nominalUsd)
      || !walletDebitPaidUsd.plus(unbackedPaidUsd).eq(nominalPaidUsd)
      || !walletDebitBonusUsd.plus(unbackedBonusUsd).eq(nominalBonusUsd)
      || nominalPaidUsd.gt(usd(grant.paidAmountUsd))
      || nominalBonusUsd.gt(usd(grant.bonusAmountUsd))
    ) {
      this.throwFinanceLedgerReconciliationRequired(grant, 'expiry_audit_components');
    }
    return {
      nominalUsd,
      nominalPaidUsd,
      nominalBonusUsd,
      walletDebitUsd,
    };
  }

  private assertFinanceExpiryAudit(
    grant: FinanceGrantRow,
    audit: NonNullable<FinanceGrantRow['expiryAudit']>,
    expiryTransactions: FinanceBalanceTransactionRow[],
    start: Date,
    end: Date,
  ): void {
    const { walletDebitUsd } = this.assertFinanceExpiryAuditComponents(grant, audit);
    const auditInPeriod = this.isDateInRange(audit.createdAt, start, end);
    if (walletDebitUsd.eq(0)) {
      if (audit.balanceTransactionId != null || expiryTransactions.length > 0) {
        this.throwFinanceLedgerReconciliationRequired(grant, 'expiry_transaction_link');
      }
      return;
    }
    if (!audit.balanceTransactionId) {
      this.throwFinanceLedgerReconciliationRequired(grant, 'expiry_transaction_link');
    }
    if (auditInPeriod) {
      if (
        expiryTransactions.length !== 1
        || expiryTransactions[0].id !== audit.balanceTransactionId
        || !usd(expiryTransactions[0].amountUsd).eq(walletDebitUsd.neg())
      ) {
        this.throwFinanceLedgerReconciliationRequired(grant, 'expiry_transaction_fact');
      }
    } else if (expiryTransactions.length > 0) {
      this.throwFinanceLedgerReconciliationRequired(grant, 'expiry_transaction_period');
    }
  }

  private groupBalanceTransactionsByGrant(transactions: FinanceBalanceTransactionRow[]) {
    const map = new Map<string, FinanceBalanceTransactionRow[]>();
    for (const tx of transactions) {
      const grantIds = this.extractGrantIdsFromBalanceTransaction(tx);
      for (const grantId of grantIds) {
        const list = map.get(grantId) ?? [];
        list.push(tx);
        map.set(grantId, list);
      }
    }
    return map;
  }

  private extractGrantIdsFromBalanceTransaction(tx: FinanceBalanceTransactionRow): string[] {
    const description = tx.description ?? '';
    const ids = new Set<string>();
    for (const pattern of [/voucher:([a-zA-Z0-9-]+)/g, /balance grant expired:([a-zA-Z0-9-]+)/g]) {
      let match = pattern.exec(description);
      while (match) {
        ids.add(match[1]);
        match = pattern.exec(description);
      }
    }
    return Array.from(ids);
  }

  private isPureGiftGrant(grant: FinanceGrantRow | null | undefined): grant is FinanceGrantRow {
    if (!grant) return false;
    return usd(grant.paidAmountUsd).lte(0) && usd(grant.grantedAmountUsd).gt(0);
  }

  private isBuyGiftGrant(grant: FinanceGrantRow | null | undefined): grant is FinanceGrantRow {
    if (!grant) return false;
    return usd(grant.paidAmountUsd).gt(0);
  }

  private isDateInRange(value: Date | string | null | undefined, start: Date, end: Date): boolean {
    if (!value) return false;
    const date = value instanceof Date ? value : new Date(value);
    return date.getTime() >= start.getTime() && date.getTime() < end.getTime();
  }

  private async enrichFinanceRowsWithAuthoritativeContacts(rows: readonly unknown[]): Promise<void> {
    if (!this.financeUserIdentity || rows.length === 0) return;
    const bindings: Array<{
      holder: Record<string, unknown>;
      userId: string;
    }> = [];
    const visited = new Set<Record<string, unknown>>();
    const visit = (value: unknown): void => {
      if (!value || typeof value !== 'object' || value instanceof Date) return;
      const holder = value as Record<string, unknown>;
      if (visited.has(holder)) return;
      visited.add(holder);
      if (typeof holder.userId === 'string' && holder.userId.trim()) {
        bindings.push({ holder, userId: holder.userId });
      }
      visit(holder.apiKey);
      visit(holder.balanceGrant);
      visit(holder.allocation);
    };
    rows.forEach(visit);
    if (bindings.length === 0) return;
    const requestedUserIds = [...new Set(bindings.map((binding) => binding.userId))];
    const exportContacts = this.financeExportContext.getStore()?.contacts;
    let contacts: Map<string, FinanceUserContact>;
    if (exportContacts) {
      const cached = await exportContacts.getMany(requestedUserIds);
      const missingUserIds = requestedUserIds.filter((userId) => !cached.has(userId));
      if (missingUserIds.length > 0) {
        const resolved = await this.financeUserIdentity.getContactsByIds(missingUserIds);
        const resolvedForCache = new Map<string, FinanceUserContact | null>();
        for (const userId of missingUserIds) {
          const contact = resolved.get(userId) ?? null;
          cached.set(userId, contact);
          resolvedForCache.set(userId, contact);
        }
        await exportContacts.setMany(resolvedForCache);
      }
      contacts = new Map(
        requestedUserIds.flatMap((userId) => {
          const contact = cached.get(userId);
          return contact ? [[userId, contact] as const] : [];
        }),
      );
    } else {
      contacts = await this.financeUserIdentity.getContactsByIds(requestedUserIds);
    }
    for (const binding of bindings) {
      const contact = contacts.get(binding.userId);
      if (!contact) continue;
      const current = binding.holder.user && typeof binding.holder.user === 'object'
        ? binding.holder.user as FinanceEntityUser
        : {};
      binding.holder.user = {
        ...current,
        id: contact.id,
        email: contact.email ?? current.email ?? null,
        phone: contact.phone ?? current.phone ?? null,
        nickname: contact.nickname ?? current.nickname ?? null,
      };
    }
  }

  private formatUserLabel(
    user: FinanceEntityUser | null | undefined,
    fallbackId: string,
    account?: FinanceEntityBillingAccount | null,
    region?: PlatformRegion,
  ): string {
    const previousLabel = user?.email ?? user?.phone ?? user?.nickname ?? fallbackId;
    if (region === 'overseas') return user?.email?.trim() ? user.email : previousLabel;
    if (region === 'domestic' && account?.type === 'enterprise') {
      return account.verificationId && account.enterpriseName?.trim()
        ? account.enterpriseName
        : previousLabel;
    }
    if (region === 'domestic' && account?.type === 'personal') {
      return user?.phone?.trim() ? user.phone : previousLabel;
    }
    return previousLabel;
  }

  private financeRowAccount(row: {
    billingAccount?: FinanceEntityBillingAccount | null;
    tenant?: FinanceEntityTenant | null;
  }): FinanceEntityBillingAccount | null | undefined {
    return row.billingAccount ?? row.tenant?.billingAccount;
  }

  private async getFinanceReportRegion(db?: FinanceReadClient): Promise<PlatformRegion | undefined> {
    const deploymentConfig = db
      ? await this.systemConfig.getDeploymentConfig(db)
      : await this.systemConfig.getDeploymentConfig();
    return deploymentConfig?.region;
  }

  private getGrantCurrency(grant: FinanceGrantRow, platformCurrencyCode: string): string {
    return (grant.order?.currency ?? platformCurrencyCode).toUpperCase();
  }

  private async getPlatformCurrencyCode(db?: FinanceReadClient): Promise<string> {
    const deploymentConfig = db
      ? await this.systemConfig.getDeploymentConfig(db)
      : await this.systemConfig.getDeploymentConfig();
    return resolvePlatformCurrency(undefined, deploymentConfig).currencyCode;
  }

  private getRefundPaidUsd(grant: FinanceGrantRow, start: Date, end: Date): Prisma.Decimal {
    const allAudited = (grant.targetRefunds ?? []).filter((refund) => refund.component === 'PAID');
    const audited = this.sumUsd(
      allAudited.filter((refund) => this.isDateInRange(refund.occurredAt, start, end)),
      (refund) => refund.requestedAmountUsd,
    );
    // Once this component has immutable audit facts, a period with no matching
    // rows is a proven zero. Never fall back to the mutable order.refundedAt in
    // a later month and count the same refund again.
    if (allAudited.length > 0) return audited.gt(0) ? audited.neg() : usd(0);
    if (!this.isDateInRange(grant.order?.refundedAt, start, end)) return usd(0);
    return this.getLegacyRefundPaidUsd(grant);
  }

  private getRefundBonusUsd(grant: FinanceGrantRow, start: Date, end: Date): Prisma.Decimal {
    const allAudited = (grant.targetRefunds ?? []).filter((refund) => refund.component === 'BONUS');
    const audited = this.sumUsd(
      allAudited.filter((refund) => this.isDateInRange(refund.occurredAt, start, end)),
      (refund) => refund.requestedAmountUsd,
    );
    if (allAudited.length > 0) return audited.gt(0) ? audited.neg() : usd(0);
    if (!this.isDateInRange(grant.order?.refundedAt, start, end)) return usd(0);
    const bonusUsd = usd(grant.bonusAmountUsd);
    const orderAmountCents = Math.max(1, grant.order?.amountCents ?? usdToCents(grant.paidAmountUsd));
    const refundAmountCents = Math.max(0, grant.order?.refundAmountCents ?? 0);
    const refundRatio = Prisma.Decimal.min(1, usd(refundAmountCents).div(orderAmountCents));
    return bonusUsd.mul(refundRatio).neg();
  }

  private getTotalRefundPaidUsd(grant: FinanceGrantRow): Prisma.Decimal {
    const allAudited = (grant.targetRefunds ?? []).filter((refund) => refund.component === 'PAID');
    if (allAudited.length > 0) {
      const audited = this.sumUsd(allAudited, (refund) => refund.requestedAmountUsd);
      return audited.gt(0) ? audited.neg() : usd(0);
    }
    return this.getLegacyRefundPaidUsd(grant);
  }

  private getLegacyRefundPaidUsd(grant: FinanceGrantRow): Prisma.Decimal {
    const paidUsd = usd(grant.paidAmountUsd);
    const orderAmountCents = Math.max(1, grant.order?.amountCents ?? usdToCents(paidUsd));
    const refundAmountCents = Math.max(0, grant.order?.refundAmountCents ?? 0);
    const refundRatio = Prisma.Decimal.min(1, usd(refundAmountCents).div(orderAmountCents));
    return paidUsd.mul(refundRatio).neg();
  }

  private isExpiryTransactionForGrant(tx: FinanceBalanceTransactionRow, grantId: string): boolean {
    return (tx.description ?? '').includes(`balance grant expired:${grantId}`);
  }

  private isOtherGrantTransaction(tx: FinanceBalanceTransactionRow, grantId: string): boolean {
    const description = tx.description ?? '';
    if (description.includes(`voucher:${grantId}`)) return false;
    if (description.includes(`balance grant expired:${grantId}`)) return false;
    if (description.includes('recharge-bonus')) return false;
    return description.includes(grantId);
  }

  private getAllocationCallType(allocation: FinanceAllocationRow): string {
    const usage = allocation.tokenUsage;
    if (!usage) return allocation.balanceTransaction?.description ?? 'API';
    return buildTokenTypeBreakdown({
      inputTokens: usage.promptTokens,
      cachedInputTokens: usage.cachedInputTokens,
      cacheWriteInputTokens: usage.cacheWriteInputTokens,
      outputTokens: usage.completionTokens,
    });
  }

  private getAllocatedTokens(allocation: FinanceAllocationRow): number {
    const usage = allocation.tokenUsage;
    if (!usage) return 0;
    const totalTokens = usage.totalTokens ?? 0;
    const usageCost = usd(usage.costUsd).abs();
    if (totalTokens <= 0 || usageCost.lte(0)) return totalTokens;
    return Math.round(totalTokens * usd(allocation.amountUsd).div(usageCost).toNumber());
  }

  private getBlendedUnitPrice(usage: FinanceAllocationRow['tokenUsage']): number | null {
    if (!usage || usage.totalTokens <= 0) return null;
    return usd(usage.costUsd).mul(1_000_000).div(usage.totalTokens).toDecimalPlaces(8).toNumber();
  }

  private getSupplierBlendedUnitPrice(usage: FinanceAllocationRow['tokenUsage']): string | null {
    if (usage?.providerCostEstimateUsd == null || usage.totalTokens <= 0) return null;
    return usdString(
      usd(usage.providerCostEstimateUsd)
        .mul(1_000_000)
        .div(usage.totalTokens)
        .toDecimalPlaces(12),
    );
  }

  private getSupplierDiscount(usage: FinanceAllocationRow['tokenUsage']): number | null {
    if (usage?.providerCostMultiplier == null) return null;
    return usdNumber(usage.providerCostMultiplier);
  }

  private hasTemplateRowMovement(row: Record<string, unknown>): boolean {
    const movementKeys = [
      'periodRechargeAmountCents',
      'periodRefundWriteOffAmountCents',
      'periodConsumeAmountCents',
      'periodExpireWriteOffAmountCents',
      'periodOtherChangeAmountCents',
      'closingAvailableBalanceCents',
    ];
    return movementKeys.some((key) => this.hasFinanceAmount(row, key));
  }

  private hasBuyGiftAccountDetailActivity(row: Record<string, unknown>): boolean {
    return this.hasTemplateRowMovement(row)
      || [
        'periodCollectionAmountCents',
        'periodRefundPaymentAmountCents',
        'periodInvoiceAmountCents',
      ].some((key) => this.hasFinanceAmount(row, key));
  }

  private hasBuyGiftPaymentDetailActivity(row: Record<string, unknown>): boolean {
    return this.hasTemplateRowMovement(row)
      || [
        'periodCollectionAmountCents',
        'periodRefundPaymentAmountCents',
      ].some((key) => this.hasFinanceAmount(row, key));
  }

  private hasFinanceAmount(row: Record<string, unknown>, key: string): boolean {
    const rawUsd = this.getFinanceRawUsd(row, key);
    return rawUsd !== null
      ? !rawUsd.eq(0)
      : Number(row[key] ?? 0) !== 0;
  }

  private maxUsd(a: Prisma.Decimal, b: Prisma.Decimal): Prisma.Decimal {
    return a.gte(b) ? a : b;
  }

  private withFinanceRawUsd<T extends Record<string, unknown>>(
    row: T,
    rawUsdByCentsKey: Record<string, Prisma.Decimal | number | string | null | undefined>,
  ): T {
    const rawUsd = {
      ...((row as FinanceRawUsdRow)[FINANCE_RAW_USD] ?? {}),
    };
    for (const [key, value] of Object.entries(rawUsdByCentsKey)) {
      if (value === null || value === undefined) continue;
      rawUsd[key] = usd(value);
    }
    if (Object.keys(rawUsd).length === 0) return row;
    Object.defineProperty(row, FINANCE_RAW_USD, {
      value: rawUsd,
      enumerable: false,
      configurable: true,
    });
    return row;
  }

  private serializeFinanceDetailRow(row: unknown, exposeRawAmounts: boolean): unknown {
    if (!exposeRawAmounts) return row;
    if (row === null || typeof row !== 'object' || Array.isArray(row)) return row;
    const financeRow = row as FinanceRawUsdRow;
    const rawUsd = financeRow[FINANCE_RAW_USD];
    if (!rawUsd || Object.keys(rawUsd).length === 0) return row;
    return this.withFinanceRawUsd({
      ...financeRow,
      [FINANCE_RAW_MAJOR_UNIT_AMOUNTS]: Object.fromEntries(
        Object.entries(rawUsd).map(([key, value]) => [
          key,
          this.trimDecimalZeros(value.toFixed(USD_SCALE)),
        ]),
      ),
    }, rawUsd);
  }

  private getFinanceRawUsd(row: Record<string, unknown>, centsKey: string): Prisma.Decimal | null {
    return (row as FinanceRawUsdRow)[FINANCE_RAW_USD]?.[centsKey] ?? null;
  }

  private addFinanceGroupedValue(
    state: FinanceGroupedState,
    sumKey: string,
    sourceRow: Record<string, unknown>,
  ) {
    const value = sourceRow[sumKey];
    if (value === null || value === undefined) {
      state.row[sumKey] ??= null;
      return;
    }

    const rawUsd = this.getFinanceRawUsd(sourceRow, sumKey);
    if (rawUsd !== null) {
      const previous = state.rawUsdKeys.has(sumKey)
        ? state.rawUsd.get(sumKey) ?? usd(0)
        : centsToUsd(Number(state.row[sumKey] ?? 0));
      const next = previous.plus(rawUsd);
      state.rawUsd.set(sumKey, next);
      state.rawUsdKeys.add(sumKey);
      state.row[sumKey] = usdToCents(next);
      return;
    }

    if (state.rawUsdKeys.has(sumKey)) {
      const next = (state.rawUsd.get(sumKey) ?? usd(0)).plus(centsToUsd(Number(value ?? 0)));
      state.rawUsd.set(sumKey, next);
      state.row[sumKey] = usdToCents(next);
      return;
    }

    state.row[sumKey] = Number(state.row[sumKey] ?? 0) + Number(value ?? 0);
  }

  private groupConsumptionSummary(
    rows: Record<string, unknown>[],
    groupKeys: readonly string[],
    sumKeys: readonly string[],
    carryKeys: readonly string[] = [],
  ): Record<string, unknown>[] {
    const groups = new Map<string, FinanceGroupedState>();
    this.addFinanceGroupedRows(groups, rows, groupKeys, sumKeys, carryKeys);
    return this.materializeFinanceGroupedRows(groups);
  }

  private addFinanceGroupedRows(
    groups: Map<string, FinanceGroupedState>,
    rows: Record<string, unknown>[],
    groupKeys: readonly string[],
    sumKeys: readonly string[],
    carryKeys: readonly string[] = [],
  ): void {
    for (const row of rows) {
      const key = groupKeys.map((groupKey) => (
        groupKey === 'userId'
          ? this.requireFinanceSummaryUserId(row)
          : String(row[groupKey] ?? '')
      )).join('\u0000');
      const outputKeys = Array.from(new Set([...groupKeys, ...carryKeys]));
      const current = groups.get(key) ?? {
        row: Object.fromEntries(outputKeys.map((outputKey) => [outputKey, row[outputKey] ?? ''])),
        rawUsd: new Map<string, Prisma.Decimal>(),
        rawUsdKeys: new Set<string>(),
      };
      for (const sumKey of sumKeys) {
        this.addFinanceGroupedValue(current, sumKey, row);
      }
      groups.set(key, current);
    }
  }

  private materializeFinanceGroupedRows(
    groups: Map<string, FinanceGroupedState>,
  ): Record<string, unknown>[] {
    return Array.from(groups.entries())
      .sort(([left], [right]) => left < right ? -1 : left > right ? 1 : 0)
      .map(([, state]) => this.withFinanceRawUsd(
        state.row,
        Object.fromEntries(state.rawUsd.entries()),
      ));
  }

  private groupAccountSummary(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    return this.groupRowsByUserAndCurrency(
      rows,
      FINANCE_USER_CURRENCY_SUMMARY_CONFIG.buyGiftAccountSummary.sumKeys,
    );
  }

  private groupPaymentSummary(rows: Record<string, unknown>[]): Record<string, unknown>[] {
    return this.groupRowsByUserAndCurrency(
      rows,
      FINANCE_USER_CURRENCY_SUMMARY_CONFIG.buyGiftPaymentSummary.sumKeys,
    );
  }

  private groupRowsByUserAndCurrency(
    rows: Record<string, unknown>[],
    sumKeys: readonly string[],
  ): Record<string, unknown>[] {
    const groups = new Map<string, FinanceGroupedState>();
    this.addFinanceGroupedRows(
      groups,
      rows,
      ['userId', 'currency'],
      sumKeys,
      ['userLabel'],
    );
    return this.materializeFinanceGroupedRows(groups);
  }

  private requireFinanceSummaryUserId(row: Record<string, unknown>): string {
    const userId = String(row.userId ?? '').trim();
    if (!userId) {
      throw new InternalServerErrorException('FINANCE_REPORT_SUMMARY_USER_ID_REQUIRED');
    }
    return userId;
  }

  private sumUsdToCents<T>(rows: T[], pick: (row: T) => Prisma.Decimal | number | string | null | undefined): number {
    return sumUsdValuesToCents(rows.map((row) => pick(row)));
  }

  private sumUsd<T>(rows: T[], pick: (row: T) => Prisma.Decimal | number | string | null | undefined): Prisma.Decimal {
    return rows.reduce((total, row) => total.plus(usd(pick(row))), usd(0));
  }

  private async getSubscriptionMap(
    subscriptionIds: string[],
    db: FinanceReadClient = this.prisma,
  ) {
    const uniq = Array.from(new Set(subscriptionIds));
    if (uniq.length === 0) return new Map<string, { id: string; product: { name: string } | null; plan: { name: string } | null }>();
    const rows = await db.subscriptionPeriod.findMany({
      where: { id: { in: uniq } },
      select: {
        id: true,
        product: { select: { name: true } },
        plan: { select: { name: true } },
      },
    });
    return new Map(rows.map((row) => [row.id, row]));
  }

  private extractOrderIdFromSource(source: string | null | undefined): string | null {
    if (!source) return null;
    const match = source.match(/order:([a-zA-Z0-9-]+)/);
    return match?.[1] ?? null;
  }

  private getDebitSubjectHint(type: string): string {
    switch (type) {
      case 'RECHARGE':
        return '银行/第三方支付在途';
      case 'CONSUME':
        return '预收款/递延收入';
      case 'REFUND':
        return '退款/收入冲减';
      case 'ADJUST':
        return '运营调整';
      default:
        return '';
    }
  }

  private getCreditSubjectHint(type: string): string {
    switch (type) {
      case 'RECHARGE':
        return '预收款';
      case 'CONSUME':
        return '主营业务收入';
      case 'REFUND':
        return '银行/第三方支付在途';
      case 'ADJUST':
        return '运营调整';
      default:
        return '';
    }
  }

  private getFinanceReportFieldGaps() {
    return [
      { category: '收入订单', field: 'Order', source: 'orders', availability: '已有', purpose: '收入确认、收款、退款、订单状态', action: '月度导出即可' },
      { category: '订单审计', field: 'OrderAuditLog', source: 'order_audit_logs', availability: '已有', purpose: '审计抽凭，证明状态流转', action: '随订单详情导出' },
      { category: '收款流水', field: 'tradeNo/channel/paidAt', source: 'orders + payment webhook', availability: '部分已有', purpose: '支付渠道对账', action: '补渠道手续费、结算日期、银行入账日期' },
      { category: '余额流水', field: 'BalanceTransaction', source: 'balance_transactions', availability: '已有', purpose: '预付余额滚动、充值/消费/退款', action: '已补 token_usage_id；后续可补 requestId/provider 成本对账' },
      { category: '充值批次', field: 'BalanceGrant', source: 'balance_grants', availability: '已有', purpose: '纯赠/买赠账户变动明细、批次到期和剩余额度', action: '纯赠按 paidAmountUsd=0/source=VOUCHER 识别；买赠按 paidAmountUsd>0 识别' },
      { category: '批次消耗', field: 'BalanceConsumptionAllocation', source: 'balance_consumption_allocations', availability: '已有', purpose: '按充值批次拆分 Token 消耗、实收确认收入和赠额消耗', action: '已用于纯赠/买赠消耗明细和汇总' },
      { category: 'TokenPlan收入', field: 'TokenPlan revenue recognition', source: 'orders + order_items + coding_plan_entitlements', availability: '派生可用', purpose: '按服务期确认 TokenPlan 收入和递延收入', action: '第一版作为月度派生报表；口径确认后可落收入确认快照表' },
      { category: '买赠退款', field: '退款对批次实收/赠额核销', source: 'orders.refundAmountCents + BalanceGrant', availability: '可推断但偏薄', purpose: '买赠账户变动中的退款核销金额-实收/买赠', action: '当前按订单退款比例拆分；建议后续记录批次级 refund allocation' },
      { category: '其他变动', field: '其他变动类型', source: 'balance_transactions.type + description', availability: '可推断但偏薄', purpose: '账户变动明细中的其他变动金额/类型/时间', action: '建议补财务专用 adjustment_reason 枚举，避免依赖 description 文本' },
      { category: '积分流水', field: 'CreditTransaction', source: 'credit_transactions', availability: '已有', purpose: '订阅履约、加油包履约、积分消耗', action: '购买类流水建议关联 orderId' },
      { category: 'API用量', field: 'TokenUsage', source: 'token_usage', availability: '已有', purpose: '按 API Key/模型/token 解释消费', action: '新用量已记录供应商成本策略快照；历史用量需回填 requestId/provider/channel/上游成本' },
      { category: '供应商成本', field: '实际供应商收费', source: '未见供应商账单导入表', availability: '需补', purpose: '纯赠/买赠当期消耗明细、消耗汇总中的实际成本', action: '建立供应商账单导入表或在 GatewayBillingEvent 中写入上游实际扣费' },
      { category: '供应商成本', field: '供应商折扣/预计成本', source: 'token_usage 供应商成本快照', availability: '新用量已有', purpose: '纯赠/买赠当期消耗明细和汇总中的预计供应商成本', action: '对历史 token_usage 按发生时间和 provider/model 回填成本策略快照' },
      { category: '供应商成本', field: 'Provider bill import', source: '外部账单', availability: '需补', purpose: '成本入账、毛利、供应商对账', action: '建立供应商账单导入表，保留原始账单号和文件' },
      { category: '发票', field: 'Invoice fields', source: '未见完整发票表', availability: '需补/可人工回填', purpose: '可开票金额、已开票金额', action: '后续接发票系统或加 invoice 表' },
    ];
  }

  async listPlans() {
    const plans = await this.repo.findPlans();
    return this.attachPlanSalesStatus(plans);
  }

  async getPlanById(id: string) {
    const plan = await this.repo.findPlanById(id);
    if (!plan) throw new BadRequestException('套餐不存在');
    const [withSalesStatus] = await this.attachPlanSalesStatus([plan]);
    // 限量售卖(自营)：附带当前已占份数（编辑器展示"当前已占 N 份"，设 cap 时不得低于此值）。
    // 与转售 salesStatus 并行——按 plan 归属互斥，自营 plan 的 salesLimit 为默认 0。
    let occupiedQuantity: number | null = null;
    if (plan.productId) {
      const product = await this.prisma.product.findUnique({
        where: { id: plan.productId },
        select: { billingMode: true, codingPlanFulfillmentMode: true },
      });
      if (
        product?.billingMode === ProductBillingMode.CODING_PLAN &&
        product?.codingPlanFulfillmentMode === CodingPlanFulfillmentMode.platform_model_package
      ) {
        occupiedQuantity = await this.countSelfOpPlanOccupied(this.prisma, plan.id);
      }
    }
    return { ...withSalesStatus, occupiedQuantity };
  }

  async listBundleSkus(filters?: { isActive?: boolean }) {
    const bundles = await this.prisma.bundleSku.findMany({
      where: filters?.isActive !== undefined ? { isActive: filters.isActive } : undefined,
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      include: this.bundleSkuInclude(),
    });
    return this.attachBundleUsage(bundles);
  }

  async getBundleSkuById(id: string) {
    const bundle = await this.prisma.bundleSku.findUnique({
      where: { id },
      include: this.bundleSkuInclude(),
    });
    if (!bundle) throw new BadRequestException('组合套餐不存在');
    const [withUsage] = await this.attachBundleUsage([bundle]);
    return withUsage;
  }

  async createBundleSku(input: BundleSkuAdminInput) {
    if (!input.code?.trim()) throw new BadRequestException('code 为必填');
    if (!input.name?.trim()) throw new BadRequestException('name 为必填');
    if (!input.items?.length) throw new BadRequestException('组合套餐至少需要配置商品明细');

    const prepared = await this.prepareBundleSkuPayload(input, { requireItems: true });
    const currency = input.currency ?? await this.getPlatformCurrencyCode();
    return this.prisma.bundleSku.create({
      data: {
        code: input.code.trim(),
        name: input.name.trim(),
        description: input.description ?? '',
        currency: currency.toLowerCase(),
        billingPeriod: input.billingPeriod ?? 'yearly',
        amountCents: prepared.bundle.amountCents!,
        originalAmountCents: prepared.bundle.originalAmountCents ?? null,
        startAt: prepared.bundle.startAt ?? null,
        endAt: prepared.bundle.endAt ?? null,
        maxUsesPerUser: input.maxUsesPerUser ?? 0,
        maxUsesTotal: input.maxUsesTotal ?? 0,
        isActive: input.isActive ?? true,
        sortOrder: input.sortOrder ?? 0,
        items: { create: prepared.items },
      },
      include: this.bundleSkuInclude(),
    });
  }

  async updateBundleSku(id: string, input: BundleSkuAdminInput) {
    const existing = await this.prisma.bundleSku.findUnique({
      where: { id },
      include: { items: true },
    });
    if (!existing) throw new BadRequestException('组合套餐不存在');

    const prepared = await this.prepareBundleSkuPayload(input, { requireItems: false });
    const data: Prisma.BundleSkuUpdateInput = {
      ...prepared.bundle,
    };
    if (input.code !== undefined) data.code = input.code.trim();
    if (input.name !== undefined) data.name = input.name.trim();
    if (input.description !== undefined) data.description = input.description;
    if (input.currency !== undefined) data.currency = input.currency.toLowerCase();
    if (input.billingPeriod !== undefined) data.billingPeriod = input.billingPeriod;
    if (input.maxUsesPerUser !== undefined) data.maxUsesPerUser = input.maxUsesPerUser;
    if (input.maxUsesTotal !== undefined) data.maxUsesTotal = input.maxUsesTotal;
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.sortOrder !== undefined) data.sortOrder = input.sortOrder;

    return this.prisma.$transaction(async (tx) => {
      if (input.items !== undefined) {
        await tx.bundleSkuItem.deleteMany({ where: { bundleSkuId: id } });
      }
      return tx.bundleSku.update({
        where: { id },
        data: {
          ...data,
          ...(input.items !== undefined ? { items: { create: prepared.items } } : {}),
        },
        include: this.bundleSkuInclude(),
      });
    });
  }

  async deleteBundleSku(id: string) {
    const existing = await this.prisma.bundleSku.findUnique({ where: { id } });
    if (!existing) throw new BadRequestException('组合套餐不存在');

    const orderCount = await this.prisma.order.count({ where: { bundleSkuId: id } });
    if (orderCount > 0) {
      await this.prisma.bundleSku.update({
        where: { id },
        data: { isActive: false },
      });
      return { deleted: false, disabled: true };
    }

    await this.prisma.bundleSku.delete({ where: { id } });
    return { deleted: true, disabled: false };
  }

  async createOrUpdatePlan(body: {
    id?: string;
    productId?: string | null;
    name: string;
    description?: string;
    planType?: string;
    monthlyPrice?: number;
    quarterlyPrice?: number;
    yearlyPrice?: number;
    billingPeriod?: string;
    monthlyCredits?: number;
    creditsRollover?: boolean;
    rolloverMaxMonths?: number;
    rateLimitRpm?: number;
    rateLimitTpm?: number;
    maxContextWindow?: number;
    overageEnabled?: boolean;
    usageMultiplier?: number;
    memberLimit?: number;
    minimumSeats?: number;
    maxSellableQuantity?: number | null;
    dataTraining?: string;
    supportTier?: string;
    ssoEnabled?: boolean;
    priorityAccess?: boolean;
    badge?: string | null;
    trialDays?: number;
    validityDays?: number;
    features?: unknown;
    isActive?: boolean;
    isLegacy?: boolean;
    salesLimit?: number;
    sortOrder?: number;
  }) {
    if (!body.name) throw new BadRequestException('name 为必填');
    const data = {
      productId: body.productId ?? null,
      name: body.name,
      description: body.description ?? '',
      planType: body.planType ?? 'individual',
      monthlyPrice: body.monthlyPrice ?? 0,
      quarterlyPrice: body.quarterlyPrice ?? 0,
      yearlyPrice: body.yearlyPrice ?? 0,
      billingPeriod: body.billingPeriod ?? 'monthly',
      monthlyCredits: body.monthlyCredits ?? 0,
      creditsRollover: body.creditsRollover ?? false,
      rolloverMaxMonths: body.rolloverMaxMonths ?? 0,
      rateLimitRpm: body.rateLimitRpm ?? 60,
      rateLimitTpm: body.rateLimitTpm ?? 100000,
      maxContextWindow: body.maxContextWindow ?? 200000,
      overageEnabled: body.overageEnabled ?? false,
      usageMultiplier: body.usageMultiplier ?? 1.0,
      memberLimit: body.memberLimit ?? 1,
      minimumSeats: body.minimumSeats ?? 1,
      maxSellableQuantity: this.normalizeMaxSellableQuantity(body.maxSellableQuantity),
      dataTraining: body.dataTraining ?? 'opt_out',
      supportTier: body.supportTier ?? 'community',
      ssoEnabled: body.ssoEnabled ?? false,
      priorityAccess: body.priorityAccess ?? false,
      badge: body.badge ?? null,
      trialDays: body.trialDays ?? 0,
      validityDays: body.validityDays ?? 30,
      features: typeof body.features === 'string' ? body.features : JSON.stringify(body.features ?? []),
      isActive: body.isActive ?? true,
      isLegacy: body.isLegacy ?? false,
      salesLimit: this.nonNegativeInteger(body.salesLimit, 'salesLimit', 0),
      sortOrder: body.sortOrder ?? 0,
    };
    // 配额一致性（me/quota-window-monthly-consistency.md）：改 monthlyCredits 时，校验该 plan
    // 已绑定的 CREDITS 滚动窗口不超新月度且单调。在 upsert 前校验，避免「持久化后再抛错」的不一致。
    // 新建 plan（无 id）此时无绑定规则，规则经 replacePlanRules 绑定时再校验。
    if (body.id) {
      await this.assertPlanQuotaConsistency(body.id, data.monthlyCredits, body.name);
    }
    // finding #13：自营 CodingPlan 的「激活」只能经 setPlanActive（原子校验绑定 + per-plan 锁）。
    // create/update 在**同一事务 + per-plan 锁**内按更新后有效 product/features 判自营，命中即强制草稿
    // （堵单请求 {id,isActive:true} 绕过，及并发"改成自营"的 stale 分类竞态，codex R3/R4/R5）。
    const plan = await this.prisma.$transaction(async (tx) => {
      if (body.id) await acquirePlanWriteLock(tx, body.id);
      await this.forceSelfOpDraftInLock(tx, body.id ?? null, data);
      // 限量售卖：改小 cap 兜底——自营 plan 若把 max_sellable_quantity 设到低于当前已占份数则拒绝
      // （防脏路径绕过；已上架自营不可编辑，正常改 cap 走下架→改→上架，setPlanActive 亦校验）。
      if (body.id && data.maxSellableQuantity != null) {
        await this.assertSalesCapNotBelowOccupied(tx, body.id, data.productId, data.maxSellableQuantity);
      }
      return body.id
        ? tx.plan.upsert({
            where: { id: body.id },
            update: data as Prisma.PlanUncheckedUpdateInput,
            create: { id: body.id, ...data },
          })
        : tx.plan.create({ data });
    });
    // 异步通知关联产品的 SaaS 后端
    this.notifyProductWebhook(plan.productId, 'plans_changed');
    return { message: body.id ? '更新成功' : '创建成功', data: plan };
  }

  /** 限量售卖：归一化最大可售份数——空/null=不限(null)；否则须为正整数(拒 0/负/非整，codex P2)。 */
  private normalizeMaxSellableQuantity(value: number | null | undefined): number | null {
    if (value === null || value === undefined) return null;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw new BadRequestException('最大可售份数必须为正整数，或留空表示不限量');
    }
    return value;
  }

  /**
   * 限量售卖「已占份数」= 去重(持该 plan ACTIVE 自营 entitlement 的 tenant ∪ 该 plan 有在途订单的 tenant)。
   * tx 内、per-plan 写锁下调用，供 setPlanActive / createOrUpdatePlan 改小校验复用；同下单闸口径。
   */
  private async countSelfOpPlanOccupied(tx: Prisma.TransactionClient, planId: string): Promise<number> {
    const [activeRows, reservedRows] = await Promise.all([
      tx.codingPlanEntitlement.findMany({
        where: {
          planId,
          status: {
            in: [
              CodingPlanEntitlementStatus.ACTIVE,
              CodingPlanEntitlementStatus.REFUNDING,
            ],
          },
          fulfillmentMode: CodingPlanFulfillmentMode.platform_model_package,
        },
        select: { tenantId: true },
      }),
      tx.order.findMany({
        where: { planId, status: { in: SALES_CAP_RESERVED_ORDER_STATUSES } },
        select: { tenantId: true },
      }),
    ]);
    const holders = new Set<string>();
    for (const r of activeRows) holders.add(r.tenantId);
    for (const r of reservedRows) holders.add(r.tenantId);
    return holders.size;
  }

  /** 仅自营 plan 校验 cap ≥ 当前已占份数（转售/普通不进）。 */
  private async assertSalesCapNotBelowOccupied(
    tx: Prisma.TransactionClient,
    planId: string,
    productId: string | null | undefined,
    maxSellableQuantity: number,
  ): Promise<void> {
    const product = productId
      ? await tx.product.findUnique({
          where: { id: productId },
          select: { billingMode: true, codingPlanFulfillmentMode: true },
        })
      : null;
    const selfOp =
      product?.billingMode === ProductBillingMode.CODING_PLAN &&
      product?.codingPlanFulfillmentMode === CodingPlanFulfillmentMode.platform_model_package;
    if (!selfOp) return;
    const occupied = await this.countSelfOpPlanOccupied(tx, planId);
    if (maxSellableQuantity < occupied) {
      throw new ConflictException(`最大可售份数不能小于当前已占份数（${occupied}）`);
    }
  }

  /**
   * finding #13：自营 CodingPlan 激活只能经 setPlanActive。在 per-plan 锁内，按「写入后有效」的
   * product/features/isActive 判定：若结果为自营且将 active → 把写入对象的 isActive 强制为 false。
   * writeData 是最终写库对象（create/update 的 data 或 patch 的 updateData）；就地改其 isActive。
   * 覆盖单请求绕过与"并发改成自营"的 stale 分类竞态（与 setPlanActive/replace/batch 同锁串行）。
   */
  private async forceSelfOpDraftInLock(
    tx: Prisma.TransactionClient,
    planId: string | null,
    writeData: Record<string, unknown>,
  ): Promise<void> {
    const current = planId
      ? await tx.plan.findUnique({
          where: { id: planId },
          select: { productId: true, features: true, isActive: true },
        })
      : null;
    const resultActive =
      writeData.isActive !== undefined ? writeData.isActive === true : current?.isActive === true;
    if (!resultActive) return;
    const resultProductId =
      writeData.productId !== undefined ? (writeData.productId as string | null) : current?.productId ?? null;
    const resultFeatures =
      writeData.features !== undefined ? (writeData.features as string) : current?.features ?? null;
    const product = resultProductId
      ? await tx.product.findUnique({
          where: { id: resultProductId },
          select: { billingMode: true, codingPlanFulfillmentMode: true },
        })
      : null;
    if (isSelfOpCodingPlan(product?.billingMode, product?.codingPlanFulfillmentMode, resultFeatures)) {
      writeData.isActive = false;
    }
  }

  async saveCodingPlanResalePlan(planId: string | null, body: CodingPlanResalePlanAdminInput) {
    const id = this.optionalTrimmedText(planId);
    const requestedId = this.optionalTrimmedText(body.id);
    const productId = this.requiredTrimmedText(body.productId, 'productId');
    const name = this.requiredTrimmedText(body.name, 'name');
    const description = this.optionalTrimmedText(body.description) ?? '';
    const monthlyPrice = this.nonNegativeInteger(body.monthlyPrice, 'monthlyPrice', 0);
    const quarterlyPrice = this.nonNegativeInteger(body.quarterlyPrice, 'quarterlyPrice', 0);
    const yearlyPrice = this.nonNegativeInteger(body.yearlyPrice, 'yearlyPrice', 0);
    const memberLimit = this.positiveInteger(body.memberLimit, 'memberLimit', 1);
    const trialDays = this.nonNegativeInteger(body.trialDays, 'trialDays', 0);
    const validityDays = this.positiveInteger(body.validityDays, 'validityDays', 30);
    const salesLimit = this.nonNegativeInteger(body.salesLimit, 'salesLimit', 0);
    const sortOrder = this.nonNegativeInteger(body.sortOrder, 'sortOrder', 0);
    const billingPeriod = this.optionalTrimmedText(body.billingPeriod) ?? 'monthly';
    const currency = this.normalizeCurrency(body.currency ?? await this.getPlatformCurrencyCode());
    const isActive = body.isActive !== false;
    const routeInputs = this.normalizeCodingPlanResalePlanRoutes(body);
    this.assertCodingPlanResaleRouteGroup(routeInputs);

    const result = await this.prisma.$transaction(async (tx) => {
      const [product, existingPlan] = await Promise.all([
        tx.product.findFirst({
          where: { id: productId, deletedAt: null },
          select: {
            id: true,
            slug: true,
            billingMode: true,
            codingPlanFulfillmentMode: true,
            isActive: true,
          },
        }),
        id
          ? tx.plan.findUnique({
              where: { id },
              select: { id: true, productId: true },
            })
          : Promise.resolve(null),
      ]);

      if (!product || product.billingMode !== ProductBillingMode.CODING_PLAN) {
        throw new BadRequestException('三方转售套餐必须绑定 CodingPlan 产品');
      }
      if (product.codingPlanFulfillmentMode !== CodingPlanFulfillmentMode.provider_resale) {
        throw new BadRequestException('三方转售套餐必须绑定 provider_resale 产品');
      }
      if (isActive && !product.isActive) {
        throw new BadRequestException('三方转售套餐上架前产品必须处于启用状态');
      }
      if (id && !existingPlan) {
        throw new BadRequestException('三方转售套餐不存在');
      }
      if (existingPlan && existingPlan.productId !== product.id) {
        throw new BadRequestException('三方转售套餐创建后不能切换所属产品');
      }
      await this.loadAndValidateCodingPlanResaleRouteTargets(tx, routeInputs, isActive);

      const planData = {
        productId: product.id,
        name,
        description,
        planType: 'coding_plan',
        monthlyPrice,
        quarterlyPrice,
        yearlyPrice,
        billingPeriod,
        monthlyCredits: 0,
        creditsRollover: false,
        rolloverMaxMonths: 0,
        rateLimitRpm: 0,
        rateLimitTpm: 0,
        maxContextWindow: 0,
        overageEnabled: false,
        usageMultiplier: 1,
        memberLimit,
        minimumSeats: 1,
        dataTraining: 'opt_out',
        supportTier: 'community',
        ssoEnabled: false,
        priorityAccess: false,
        badge: this.optionalTrimmedText(body.badge),
        trialDays,
        validityDays,
        features: '[]',
        isActive,
        isLegacy: body.isLegacy === true,
        salesLimit,
        sortOrder,
      };
      const plan = id
        ? await tx.plan.update({ where: { id }, data: planData })
        : await tx.plan.create({ data: { ...planData, ...(requestedId ? { id: requestedId } : {}) } });

      await Promise.all([
        tx.modelAccess.deleteMany({ where: { planId: plan.id } }),
        tx.modelRoutePolicy.deleteMany({ where: { planId: plan.id } }),
        tx.planQuotaRule.deleteMany({ where: { planId: plan.id } }),
      ]);

      await tx.planPrice.upsert({
        where: { planId_currency: { planId: plan.id, currency } },
        update: {
          monthlyPrice,
          quarterlyPrice,
          yearlyPrice,
          isActive,
        },
        create: {
          planId: plan.id,
          currency,
          monthlyPrice,
          quarterlyPrice,
          yearlyPrice,
          isActive,
        },
      });

      const routes = [];
      const explicitRoutesMode = Array.isArray(body.routes);
      const retainedRouteIds = new Set<string>();
      for (const input of routeInputs) {
        const routeData = this.codingPlanResaleRouteData(plan.id, input);
        let route;
        if (input.routeId) {
          const existingRoute = await tx.codingPlanResaleRoute.findUnique({
            where: { id: input.routeId },
            select: { id: true, planId: true },
          });
          if (!existingRoute || existingRoute.planId !== plan.id) {
            throw new BadRequestException('供应商转售映射不存在或不属于当前套餐');
          }
          route = await tx.codingPlanResaleRoute.update({ where: { id: input.routeId }, data: routeData });
        } else if (!explicitRoutesMode) {
          const existingRoutes = await tx.codingPlanResaleRoute.findMany({
            where: { planId: plan.id },
            select: { id: true },
            orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
          });
          if (existingRoutes.length > 1) {
            throw new BadRequestException('当前套餐存在多个转售映射，请指定 routes[]');
          }
          route = existingRoutes[0]
            ? await tx.codingPlanResaleRoute.update({ where: { id: existingRoutes[0].id }, data: routeData })
            : await tx.codingPlanResaleRoute.create({ data: routeData });
        } else {
          const existingRoute = await tx.codingPlanResaleRoute.findFirst({
            where: {
              planId: plan.id,
              providerLineId: input.providerLineId,
              upstreamProductId: input.upstreamProductId,
            },
            select: { id: true },
            orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }],
          });
          route = existingRoute
            ? await tx.codingPlanResaleRoute.update({ where: { id: existingRoute.id }, data: routeData })
            : await tx.codingPlanResaleRoute.create({ data: routeData });
        }
        retainedRouteIds.add(route.id);
        routes.push(route);
      }
      if (explicitRoutesMode) {
        await tx.codingPlanResaleRoute.deleteMany({
          where: {
            planId: plan.id,
            id: { notIn: Array.from(retainedRouteIds) },
          },
        });
      }

      return { plan, routes };
    });

    this.notifyProductWebhook(result.plan.productId, 'plans_changed');
    return {
      id: result.plan.id,
      plan: result.plan,
      route: result.routes[0] ?? null,
      routes: result.routes,
      fulfillmentMode: CodingPlanFulfillmentMode.provider_resale,
      productId: result.plan.productId,
    };
  }

  private normalizeCodingPlanResalePlanRoutes(
    body: CodingPlanResalePlanAdminInput,
  ): NormalizedCodingPlanResalePlanRouteInput[] {
    const rawRoutes = Array.isArray(body.routes) ? body.routes : [body];
    return rawRoutes.map((route, index) => {
      const source = route ?? {};
      const value = <K extends keyof CodingPlanResalePlanRouteAdminInput>(
        key: K,
      ): CodingPlanResalePlanRouteAdminInput[K] | undefined => (
        Object.prototype.hasOwnProperty.call(source, key)
          ? source[key]
          : body[key]
      );
      const routeStartAt = Object.prototype.hasOwnProperty.call(source, 'routeStartAt')
        || Object.prototype.hasOwnProperty.call(body, 'routeStartAt')
        ? this.parseOptionalDate(value('routeStartAt'), `routes[${index}].routeStartAt`)
        : undefined;
      const routeEndAt = Object.prototype.hasOwnProperty.call(source, 'routeEndAt')
        || Object.prototype.hasOwnProperty.call(body, 'routeEndAt')
        ? this.parseOptionalDate(value('routeEndAt'), `routes[${index}].routeEndAt`)
        : undefined;
      if (routeStartAt && routeEndAt && routeEndAt <= routeStartAt) {
        throw new BadRequestException(`routes[${index}].routeEndAt 必须晚于 routeStartAt`);
      }
      return {
        routeId: this.optionalTrimmedText(value('routeId')) ?? null,
        providerLineId: this.requiredTrimmedText(value('providerLineId'), `routes[${index}].providerLineId`),
        upstreamProductId: this.requiredTrimmedText(value('upstreamProductId'), `routes[${index}].upstreamProductId`),
        enabled: value('routeEnabled') !== false,
        priority: this.positiveInteger(value('routePriority'), `routes[${index}].routePriority`, 100),
        market: this.optionalTrimmedText(value('routeMarket')),
        currency: this.optionalNormalizedCurrency(value('routeCurrency')),
        salesChannel: this.optionalTrimmedText(value('routeSalesChannel')),
        userSegmentId: this.optionalTrimmedText(value('routeUserSegmentId')),
        startAt: routeStartAt,
        endAt: routeEndAt,
      };
    });
  }

  private assertCodingPlanResaleRouteGroup(routes: NormalizedCodingPlanResalePlanRouteInput[]): void {
    if (routes.length === 0) {
      throw new BadRequestException('三方转售套餐至少需要一条供应商线路');
    }
    const first = routes[0];
    const lineIds = new Set<string>();
    for (const route of routes) {
      if (lineIds.has(route.providerLineId)) {
        throw new BadRequestException('三方转售套餐不能重复绑定同一供应商线路');
      }
      lineIds.add(route.providerLineId);
      if (
        route.upstreamProductId !== first.upstreamProductId
        || route.priority !== first.priority
        || route.market !== first.market
        || route.currency !== first.currency
        || route.salesChannel !== first.salesChannel
        || route.userSegmentId !== first.userSegmentId
        || this.optionalDateMs(route.startAt) !== this.optionalDateMs(first.startAt)
        || this.optionalDateMs(route.endAt) !== this.optionalDateMs(first.endAt)
      ) {
        throw new BadRequestException(
          '三方转售套餐的多线路绑定必须共享上游产品、优先级、匹配维度和生效窗口',
        );
      }
    }
  }

  private async loadAndValidateCodingPlanResaleRouteTargets(
    tx: Prisma.TransactionClient,
    routes: NormalizedCodingPlanResalePlanRouteInput[],
    planActive: boolean,
  ): Promise<void> {
    let providerCode: string | null = null;
    let adapterType: string | null = null;
    const providerLines = [];
    for (const route of routes) {
      const [line, providerProduct] = await Promise.all([
        tx.codingPlanProviderLine.findUnique({
          where: { id: route.providerLineId },
          select: {
            ...PROVIDER_RESALE_ROUTE_LINE_IDENTITY_SELECT,
            providerCode: true,
            adapterType: true,
            salesEnabled: true,
            fulfillmentEnabled: true,
          },
        }),
        tx.codingPlanProviderProduct.findUnique({
          where: {
            providerLineId_upstreamProductId: {
              providerLineId: route.providerLineId,
              upstreamProductId: route.upstreamProductId,
            },
          },
          select: { id: true, status: true },
        }),
      ]);
      if (!line) {
        throw new BadRequestException('供应商线路不存在');
      }
      providerLines.push(line);
      if (!providerProduct) {
        throw new BadRequestException('上游产品必须来自所选供应商线路的同步目录');
      }
      if (providerCode === null) providerCode = line.providerCode;
      if (adapterType === null) adapterType = line.adapterType;
      if (line.providerCode !== providerCode || line.adapterType !== adapterType) {
        throw new BadRequestException('三方转售套餐的多线路绑定必须来自同一供应商和适配器');
      }
      if (planActive && route.enabled) {
        if (!line.salesEnabled || !line.fulfillmentEnabled) {
          throw new BadRequestException('上架三方转售套餐前供应商线路必须同时开启销售和履约');
        }
        if (String(providerProduct.status ?? '').toUpperCase() !== 'ACTIVE') {
          throw new BadRequestException('上架三方转售套餐前上游产品必须处于 ACTIVE 状态');
        }
      }
    }
    try {
      validateProviderResaleRouteGroupAccountIdentity(providerLines, {
        requireIdentity: planActive,
      });
    } catch (error) {
      throw new BadRequestException(error instanceof Error ? error.message : String(error));
    }
  }

  private codingPlanResaleRouteData(
    planId: string,
    input: NormalizedCodingPlanResalePlanRouteInput,
  ): Prisma.CodingPlanResaleRouteUncheckedCreateInput {
    const routeData: Prisma.CodingPlanResaleRouteUncheckedCreateInput = {
      planId,
      providerLineId: input.providerLineId,
      upstreamProductId: input.upstreamProductId,
      fulfillmentMethod: 'create_order',
      enabled: input.enabled,
      priority: input.priority,
      market: input.market,
      currency: input.currency,
      salesChannel: input.salesChannel,
      userSegmentId: input.userSegmentId,
    };
    if (input.startAt !== undefined) routeData.startAt = input.startAt;
    if (input.endAt !== undefined) routeData.endAt = input.endAt;
    return routeData;
  }

  private optionalDateMs(value: Date | null | undefined): number | null {
    return value instanceof Date ? value.getTime() : null;
  }

  /**
   * 配额一致性校验（me/quota-window-monthly-consistency.md，R1）：加载该 plan 当前 active 配额
   * 规则的**合并视图**，校验 CREDITS 滚动窗口 limitValue ≤ monthlyCredits 且短窗 ≤ 长窗。
   * 仅当存在 CREDITS 滚动规则时才可能命中——转售/无规则套餐天然跳过（零开销）。违规抛 400。
   */
  private async assertPlanQuotaConsistency(
    planId: string,
    monthlyCredits: number,
    planLabel?: string,
  ): Promise<void> {
    // 红线：仅自营(非转售) CODING_PLAN 校验；转售/PAYG/通用套餐零影响。
    const plan = await this.prisma.plan.findUnique({
      where: { id: planId },
      select: { features: true, product: { select: { billingMode: true } } },
    });
    if (
      !plan ||
      plan.product?.billingMode !== ProductBillingMode.CODING_PLAN ||
      isProviderResalePlan(plan.features)
    ) {
      return;
    }
    const bindings = await this.prisma.planQuotaRule.findMany({
      where: { planId, isActive: true },
      select: { template: { select: { rules: true, isActive: true, deletedAt: true } } },
    });
    if (bindings.length === 0) return;
    const views = resolvePlanQuotaRuleViews(bindings);
    const violations = findCreditWindowConsistencyViolations(monthlyCredits, views);
    if (violations.length > 0) {
      throw new BadRequestException(
        formatCreditWindowConsistencyError(violations, monthlyCredits, planLabel),
      );
    }
  }

  // ============================
  // 套餐多币种定价 (plan_prices)
  // ============================

  async listPlanPrices(planId: string) {
    // 校验 plan 存在
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new BadRequestException('套餐不存在');

    const prices = await this.prisma.planPrice.findMany({
      where: { planId },
      orderBy: { currency: 'asc' },
    });
    return {
      planId,
      // 顶层价保留作为 USD fallback/兼容信息
      legacyUsd: { monthlyPrice: plan.monthlyPrice, quarterlyPrice: plan.quarterlyPrice, yearlyPrice: plan.yearlyPrice },
      prices,
    };
  }

  async upsertPlanPrice(planId: string, body: {
    currency: string;
    monthlyPrice: number;
    quarterlyPrice: number;
    yearlyPrice: number;
    isActive?: boolean;
  }) {
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new BadRequestException('套餐不存在');

    if (!body.currency || body.currency.length !== 3) {
      throw new BadRequestException('currency 必须是 3 位 ISO 4217 代码');
    }
    if (!Number.isInteger(body.monthlyPrice) || body.monthlyPrice < 0) {
      throw new BadRequestException('monthlyPrice 必须是非负整数 cents');
    }
    if (!Number.isInteger(body.quarterlyPrice) || body.quarterlyPrice < 0) {
      throw new BadRequestException('quarterlyPrice 必须是非负整数 cents');
    }
    if (!Number.isInteger(body.yearlyPrice) || body.yearlyPrice < 0) {
      throw new BadRequestException('yearlyPrice 必须是非负整数 cents');
    }
    const currency = body.currency.toLowerCase();

    const price = await this.prisma.planPrice.upsert({
      where: { planId_currency: { planId, currency } },
      update: {
        monthlyPrice: body.monthlyPrice,
        quarterlyPrice: body.quarterlyPrice,
        yearlyPrice: body.yearlyPrice,
        isActive: body.isActive ?? true,
      },
      create: {
        planId,
        currency,
        monthlyPrice: body.monthlyPrice,
        quarterlyPrice: body.quarterlyPrice,
        yearlyPrice: body.yearlyPrice,
        isActive: body.isActive ?? true,
      },
    });
    // 通知产品 SaaS 套餐变更（价格是套餐一部分）
    this.notifyProductWebhook(plan.productId, 'plans_changed');
    return price;
  }

  async deletePlanPrice(planId: string, currency: string) {
    const plan = await this.prisma.plan.findUnique({ where: { id: planId } });
    if (!plan) throw new BadRequestException('套餐不存在');

    const lc = currency.toLowerCase();
    await this.prisma.planPrice.deleteMany({
      where: { planId, currency: lc },
    });
    this.notifyProductWebhook(plan.productId, 'plans_changed');
    return { deleted: true, planId, currency: lc };
  }

  async deletePlan(id: string) {
    const result = await this.prisma.$transaction(async (tx) => {
      const plan = await tx.plan.findFirst({
        where: { id, deletedAt: null },
        select: { id: true, productId: true },
      });
      if (!plan) throw new BadRequestException('套餐不存在');

      const [
        orderCount,
        orderItemCount,
        subscriptionCount,
        bundleItemCount,
        campaignCount,
        discountCodeCount,
        defaultProductCount,
        entitlementCount,
      ] = await Promise.all([
        tx.order.count({ where: { planId: id } }),
        tx.orderItem.count({ where: { planId: id } }),
        tx.subscriptionPeriod.count({ where: { planId: id } }),
        tx.bundleSkuItem.count({ where: { planId: id } }),
        tx.campaign.count({ where: { planId: id } }),
        tx.discountCode.count({ where: { planIdsJson: { contains: `"${id}"` } } }),
        tx.product.count({ where: { defaultPlanId: id, deletedAt: null } }),
        tx.tenantProductEntitlement.count({ where: { planId: id } }),
      ]);
      const referencedBy = [
        orderCount > 0 ? '订单' : null,
        orderItemCount > 0 ? '订单明细' : null,
        subscriptionCount > 0 ? '订阅' : null,
        bundleItemCount > 0 ? '组合套餐' : null,
        campaignCount > 0 ? '营销活动' : null,
        discountCodeCount > 0 ? '折扣码' : null,
        defaultProductCount > 0 ? '产品默认套餐' : null,
        entitlementCount > 0 ? '租户权益' : null,
      ].filter((label): label is string => Boolean(label));
      if (referencedBy.length > 0) {
        throw new BadRequestException(
          `套餐已有${referencedBy.join('、')}引用，不能删除；请改为下架或标记旧版。`,
        );
      }

      await tx.codingPlanResaleRoute.deleteMany({ where: { planId: id } });
      return tx.plan.update({
        where: { id },
        data: {
          deletedAt: new Date(),
          isActive: false,
          isLegacy: true,
        },
        select: { id: true, productId: true },
      });
    });
    this.notifyProductWebhook(result.productId, 'plans_changed');
    return { deleted: true, id };
  }

  async updatePlan(id: string, body: Record<string, unknown>) {
    const { id: _ignored, createdAt: _ca, updatedAt: _ua, ...raw } = body;
    const updateData: Record<string, unknown> = {};
    const directFields = [
      'productId',
      'name', 'description', 'planType', 'monthlyPrice', 'quarterlyPrice', 'yearlyPrice', 'billingPeriod',
      'monthlyCredits', 'creditsRollover', 'rolloverMaxMonths',
      'rateLimitRpm', 'rateLimitTpm', 'maxContextWindow',
      'overageEnabled', 'usageMultiplier',
      'memberLimit', 'minimumSeats',
      'dataTraining', 'supportTier', 'ssoEnabled', 'priorityAccess',
      'badge', 'trialDays', 'validityDays', 'isActive', 'isLegacy', 'sortOrder',
    ];
    for (const key of directFields) {
      if (raw[key] !== undefined) updateData[key] = raw[key];
    }
    if (raw.salesLimit !== undefined) {
      updateData.salesLimit = this.nonNegativeInteger(raw.salesLimit, 'salesLimit', 0);
    }
    if (raw.features !== undefined) {
      updateData.features = typeof raw.features === 'string' ? raw.features : JSON.stringify(raw.features);
    }
    // 配额一致性（me/quota-window-monthly-consistency.md）：仅当本次改 monthlyCredits 时校验
    // 已绑定的 CREDITS 滚动窗口不超新月度且单调（升级前置旁路，与 createOrUpdatePlan 同口径）。
    // 不动 monthlyCredits 的字段编辑（如改名）不触发，避免回溯阻断无关编辑。
    if (typeof updateData.monthlyCredits === 'number') {
      await this.assertPlanQuotaConsistency(
        id,
        updateData.monthlyCredits,
        typeof updateData.name === 'string' ? updateData.name : undefined,
      );
    }
    // finding #13：与 createOrUpdatePlan 同口径——tx + per-plan 锁内按写入后有效值判自营，
    // 命中即强制草稿（自营激活只经 setPlanActive）；堵直调改 isActive / 并发切自营的绕过。
    const updated = await this.prisma.$transaction(async (tx) => {
      await acquirePlanWriteLock(tx, id);
      await this.forceSelfOpDraftInLock(tx, id, updateData);
      return tx.plan.update({ where: { id }, data: updateData });
    });
    // 通知下游 SaaS 前端(codesphere-frontend-saas)套餐已变更,触发其重新拉取。
    // 漏调会导致 admin 改完套餐后下游缓存最长几分钟才感知。
    this.notifyProductWebhook(updated.productId, 'plans_changed');
    return updated;
  }

  /**
   * 上架/下架套餐 —— 从"随整包保存的字段"解耦出的独立窄写激活动作（finding #13 修复）。
   * 仅写 isActive（不整包 upsert，避免自营散字段被归 0 等副作用）。
   * 自营 CodingPlan(platform_model_package) 激活时：在**同一事务**内取 per-plan advisory 锁并
   * **权威复校验「≥1 启用模型 + ≥1 启用配额规则」**，不满足拒绝翻 active —— 关闭 publish 的
   * check-then-act 竞态（并发绑定写取同一锁互斥，见 planWriteLock）。转售/订阅不进校验分支。
   */
  async setPlanActive(planId: string, isActive: boolean) {
    const plan = await this.prisma.$transaction(async (tx) => {
      await acquirePlanWriteLock(tx, planId);
      const current = await tx.plan.findFirst({
        where: { id: planId, deletedAt: null },
        select: {
          id: true,
          productId: true,
          features: true,
          billingPeriod: true,
          monthlyPrice: true,
          quarterlyPrice: true,
          yearlyPrice: true,
          monthlyCredits: true,
          maxSellableQuantity: true,
          product: { select: { billingMode: true, codingPlanFulfillmentMode: true } },
        },
      });
      if (!current) throw new NotFoundException('套餐不存在');
      // 自营判定(全实现同口径,防转售误伤,codex)：billingMode=CODING_PLAN 且
      // 产品级非 provider_resale 且 plan 级 features 非转售。三重排除转售。
      const isSelfOp = isSelfOpCodingPlan(
        current.product?.billingMode,
        current.product?.codingPlanFulfillmentMode,
        current.features,
      );
      if (isActive && isSelfOp) {
        const [activeModels, activeRules] = await Promise.all([
          tx.modelAccess.count({ where: { planId, isActive: true } }),
          tx.planQuotaRule.count({
            where: { planId, isActive: true, template: { isActive: true, deletedAt: null } },
          }),
        ]);
        if (activeModels < 1) {
          throw new ConflictException('自营套餐上架前必须至少启用一个模型');
        }
        if (activeRules < 1) {
          throw new ConflictException('自营套餐上架前必须绑定至少一个启用的配额模板');
        }
        // 零值守卫：下单价按买家所选 billingPeriod 计（payment.service resolvePlanPeriodMonthlyEquivalentCents），
        // 该周期价为 0/缺失下单即抛「暂无价格」。故按 plan 配置的 billingPeriod 对应周期价校验（缺省/非法回退
        // monthly），而非「任一周期价>0」——防 billingPeriod=monthly & monthlyPrice=0 但 yearlyPrice>0 时放行 0 元月付套餐(codex P0)。
        const billingPeriod = ['monthly', 'quarterly', 'yearly'].includes(current.billingPeriod)
          ? current.billingPeriod
          : 'monthly';
        const priceForBillingPeriod =
          billingPeriod === 'yearly'
            ? current.yearlyPrice
            : billingPeriod === 'quarterly'
              ? current.quarterlyPrice
              : current.monthlyPrice;
        if (priceForBillingPeriod <= 0) {
          throw new ConflictException('自营套餐上架前必须设置大于 0 的售价');
        }
        if (current.monthlyCredits <= 0) {
          throw new ConflictException('自营套餐上架前月度积分必须大于 0');
        }
        // 限量售卖：上架时若已设 cap，校验 cap ≥ 当前已占份数（防把已超卖的值上架）。
        if (current.maxSellableQuantity != null) {
          const occupied = await this.countSelfOpPlanOccupied(tx, planId);
          if (current.maxSellableQuantity < occupied) {
            throw new ConflictException(`最大可售份数不能小于当前已占份数（${occupied}）`);
          }
        }
      }
      return tx.plan.update({ where: { id: planId }, data: { isActive } });
    });
    // 激活成功后才通知商城（下架同理触发前台重拉，隐藏已下架套餐）。
    this.notifyProductWebhook(plan.productId, 'plans_changed');
    return plan;
  }

  private bundleSkuInclude() {
    return {
      items: {
        orderBy: { sortOrder: 'asc' as const },
        include: {
          product: {
            select: {
              id: true,
              name: true,
              slug: true,
              billingMode: true,
              isActive: true,
            },
          },
          plan: {
            select: {
              id: true,
              name: true,
              productId: true,
              monthlyCredits: true,
              validityDays: true,
              isActive: true,
            },
          },
          boosterPack: {
            select: {
              id: true,
              name: true,
              productId: true,
              creditsAmount: true,
              expiryDays: true,
              isActive: true,
            },
          },
        },
      },
    };
  }

  private async attachBundleUsage<T extends { id: string }>(bundles: T[]) {
    if (bundles.length === 0) return bundles.map((bundle) => ({ ...bundle, usedCount: 0, revenueCents: 0 }));
    const ids = bundles.map((bundle) => bundle.id);
    const rows = await this.prisma.order.groupBy({
      by: ['bundleSkuId'],
      where: {
        bundleSkuId: { in: ids },
        status: { in: REVENUE_ORDER_STATUSES },
      },
      _count: { _all: true },
      _sum: { amountCents: true },
    });
    const usage = new Map(
      rows
        .filter((row) => row.bundleSkuId)
        .map((row) => [
          row.bundleSkuId!,
          {
            usedCount: row._count._all,
            revenueCents: row._sum.amountCents ?? 0,
          },
        ]),
    );
    return bundles.map((bundle) => ({
      ...bundle,
      usedCount: usage.get(bundle.id)?.usedCount ?? 0,
      revenueCents: usage.get(bundle.id)?.revenueCents ?? 0,
    }));
  }

  private async attachPlanSalesStatus<T extends PlanSalesStatusPlan>(plans: T[]) {
    if (plans.length === 0) {
      return plans.map((plan) => ({ ...plan, ...defaultPlanSalesStatus(plan) }));
    }
    let statuses: Map<string, PlanSalesStatus>;
    try {
      statuses = await loadProviderResalePlanSalesStatuses(this.prisma, plans);
    } catch (err) {
      this.logger.warn(`attachPlanSalesStatus failed: ${(err as Error).message}`);
      statuses = new Map(plans.map((plan) => [plan.id, defaultPlanSalesStatus(plan)]));
    }
    return plans.map((plan) => ({
      ...plan,
      ...(statuses.get(plan.id) ?? defaultPlanSalesStatus(plan)),
    }));
  }

  private async prepareBundleSkuPayload(
    input: BundleSkuAdminInput,
    options: { requireItems: boolean },
  ): Promise<{
    bundle: {
      amountCents?: number;
      originalAmountCents?: number | null;
      startAt?: Date | null;
      endAt?: Date | null;
    };
    items: Prisma.BundleSkuItemCreateWithoutBundleSkuInput[];
  }> {
    const bundle: {
      amountCents?: number;
      originalAmountCents?: number | null;
      startAt?: Date | null;
      endAt?: Date | null;
    } = {};
    const startAt = this.parseOptionalDate(input.startAt, 'startAt');
    const endAt = this.parseOptionalDate(input.endAt, 'endAt');

    if (startAt !== undefined) bundle.startAt = startAt;
    if (endAt !== undefined) bundle.endAt = endAt;
    if (startAt instanceof Date && endAt instanceof Date && startAt >= endAt) {
      throw new BadRequestException('开始时间必须早于结束时间');
    }

    if (input.amountCents !== undefined) bundle.amountCents = input.amountCents;
    if (input.originalAmountCents !== undefined) bundle.originalAmountCents = input.originalAmountCents;

    if (!input.items) {
      if (options.requireItems) throw new BadRequestException('组合套餐至少需要配置商品明细');
      return { bundle, items: [] };
    }

    const rawItems = input.items;
    if (rawItems.length < 2) throw new BadRequestException('组合套餐至少需要两个商品明细');
    const hasSubscription = rawItems.some((item) => item.billingType === 'SUBSCRIPTION');
    const hasOneTime = rawItems.some((item) => item.billingType === 'ONE_TIME');
    if (!hasSubscription || !hasOneTime) {
      throw new BadRequestException('组合套餐必须同时包含可续费项和一次性权益项');
    }

    const productIds = [...new Set(rawItems.map((item) => item.productId).filter(Boolean))];
    const planIds = [...new Set(rawItems.map((item) => item.planId).filter(Boolean) as string[])];
    const boosterPackIds = [...new Set(rawItems.map((item) => item.boosterPackId).filter(Boolean) as string[])];
    const [products, plans, boosterPacks] = await Promise.all([
      this.prisma.product.findMany({
        where: { id: { in: productIds }, deletedAt: null },
        select: { id: true, name: true },
      }),
      planIds.length
        ? this.prisma.plan.findMany({
            where: { id: { in: planIds } },
            select: { id: true, name: true, productId: true },
          })
        : Promise.resolve([]),
      boosterPackIds.length
        ? this.prisma.boosterPack.findMany({
            where: { id: { in: boosterPackIds }, deletedAt: null },
            select: { id: true, name: true, productId: true },
          })
        : Promise.resolve([]),
    ]);
    const productMap = new Map(products.map((product) => [product.id, product]));
    const planMap = new Map(plans.map((plan) => [plan.id, plan]));
    const boosterPackMap = new Map(boosterPacks.map((pack) => [pack.id, pack]));

    let amountTotal = 0;
    let originalTotal = 0;
    const items = rawItems.map((item, index) => {
      if (!productMap.has(item.productId)) {
        throw new BadRequestException(`第 ${index + 1} 个明细的产品不存在`);
      }
      const quantity = item.quantity ?? 1;
      if (!Number.isInteger(quantity) || quantity < 1) {
        throw new BadRequestException(`第 ${index + 1} 个明细的数量必须大于 0`);
      }
      if (!Number.isInteger(item.unitAmountCents) || item.unitAmountCents < 1) {
        throw new BadRequestException(`第 ${index + 1} 个明细的价格必须大于 0`);
      }
      const originalUnit = item.originalUnitAmountCents ?? item.unitAmountCents;
      if (!Number.isInteger(originalUnit) || originalUnit < item.unitAmountCents) {
        throw new BadRequestException(`第 ${index + 1} 个明细的原价不能低于活动价`);
      }

      let planId: string | null = item.planId ?? null;
      let boosterPackId: string | null = item.boosterPackId ?? null;
      let recurringInterval: 'month' | 'year' | null = null;

      if (item.billingType === 'SUBSCRIPTION') {
        if (!planId) throw new BadRequestException(`第 ${index + 1} 个订阅明细必须绑定套餐`);
        if (boosterPackId) throw new BadRequestException(`第 ${index + 1} 个订阅明细不能绑定加油包`);
        if (item.recurringInterval !== 'month' && item.recurringInterval !== 'year') {
          throw new BadRequestException(`第 ${index + 1} 个订阅明细必须配置续费周期`);
        }
        recurringInterval = item.recurringInterval;
      } else {
        const targetCount = [planId, boosterPackId].filter(Boolean).length;
        if (targetCount !== 1) {
          throw new BadRequestException(`第 ${index + 1} 个一次性明细必须且只能绑定一个套餐或加油包`);
        }
      }

      if (planId) {
        const plan = planMap.get(planId);
        if (!plan) throw new BadRequestException(`第 ${index + 1} 个明细的套餐不存在`);
        if (plan.productId && plan.productId !== item.productId) {
          throw new BadRequestException(`第 ${index + 1} 个明细的套餐不属于所选产品`);
        }
      }
      if (boosterPackId) {
        const pack = boosterPackMap.get(boosterPackId);
        if (!pack) throw new BadRequestException(`第 ${index + 1} 个明细的加油包不存在`);
        if (pack.productId && pack.productId !== item.productId) {
          throw new BadRequestException(`第 ${index + 1} 个明细的加油包不属于所选产品`);
        }
      }

      amountTotal += item.unitAmountCents * quantity;
      originalTotal += originalUnit * quantity;
      const name =
        item.name?.trim() ||
        (planId ? planMap.get(planId)?.name : undefined) ||
        (boosterPackId ? boosterPackMap.get(boosterPackId)?.name : undefined) ||
        productMap.get(item.productId)!.name;

      return {
        product: { connect: { id: item.productId } },
        plan: planId ? { connect: { id: planId } } : undefined,
        boosterPack: boosterPackId ? { connect: { id: boosterPackId } } : undefined,
        billingType: item.billingType as BundleItemBillingType,
        name,
        unitAmountCents: item.unitAmountCents,
        originalUnitAmountCents: originalUnit,
        quantity,
        recurringInterval,
        validityDays: item.validityDays ?? null,
        sortOrder: item.sortOrder ?? index,
      };
    });

    const amountCents = input.amountCents ?? amountTotal;
    if (amountCents !== amountTotal) {
      throw new BadRequestException('组合套餐总价必须等于明细活动价合计');
    }
    const originalAmountCents = input.originalAmountCents ?? originalTotal;
    if (originalAmountCents != null && originalAmountCents < amountCents) {
      throw new BadRequestException('组合套餐原价不能低于活动价');
    }
    bundle.amountCents = amountCents;
    bundle.originalAmountCents = originalAmountCents > amountCents ? originalAmountCents : null;

    return { bundle, items };
  }

  private parseOptionalDate(value: string | Date | null | undefined, field: string) {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException(`${field} 不是有效时间`);
    }
    return date;
  }

  private optionalTrimmedText(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    return text.length > 0 ? text : null;
  }

  private requiredTrimmedText(value: unknown, field: string): string {
    const text = this.optionalTrimmedText(value);
    if (!text) throw new BadRequestException(`${field} 为必填`);
    return text;
  }

  private nonNegativeInteger(value: unknown, field: string, defaultValue: number): number {
    if (value === undefined || value === null || value === '') return defaultValue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 0) {
      throw new BadRequestException(`${field} 必须是非负整数`);
    }
    return value;
  }

  private positiveInteger(value: unknown, field: string, defaultValue: number): number {
    if (value === undefined || value === null || value === '') return defaultValue;
    if (typeof value !== 'number' || !Number.isInteger(value) || value < 1) {
      throw new BadRequestException(`${field} 必须是大于 0 的整数`);
    }
    return value;
  }

  private normalizeCurrency(value: unknown): string {
    const currency = this.requiredTrimmedText(value, 'currency').toLowerCase();
    if (!/^[a-z]{3}$/.test(currency)) {
      throw new BadRequestException('currency 必须是 3 位 ISO 4217 代码');
    }
    return currency;
  }

  private optionalNormalizedCurrency(value: unknown): string | null {
    const currency = this.optionalTrimmedText(value);
    return currency ? this.normalizeCurrency(currency) : null;
  }

  private countExpiringSubscriptions(days: number, productId?: string, userId?: string) {
    const now = new Date();
    const end = new Date(now);
    end.setDate(end.getDate() + days);
    return this.prisma.subscriptionPeriod.count({
      where: {
        status: SubscriptionStatus.ACTIVE,
        ...(productId ? { productId } : {}),
        ...(userId ? { userId } : {}),
        expiresAt: { gte: now, lte: end },
      },
    });
  }

  private async notifyProductWebhook(productId: string | null | undefined, changeType: string) {
    if (!productId) return;
    try {
      const product = await this.repo.findProductById(productId);
      if (product?.slug) {
        this.productSync.notifyProductSaas(product.slug, changeType).catch(() => {});
      }
    } catch { /* non-critical */ }
  }
}
