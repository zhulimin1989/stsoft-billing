import {
  Injectable,
  NotFoundException,
  ForbiddenException,
  Optional,
  Logger,
  BadRequestException,
  ConflictException,
  HttpException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { RedisService } from '../redis/redis.service';
import { PrismaService } from '../prisma/prisma.service';
import {
  BillingRepository,
  type TokenUsagePeriodGranularity,
} from './billing.repository';
import { SelfOpProrationSourceInvalidError } from './coding-plan-errors';
import { CreditPolicyService } from '../credit-policy/credit-policy.service';
import { PublisherSyncService } from '../publisher/publisher-sync.service';
import { SubscriptionLifecycleService } from './subscription-lifecycle.service';
import {
  Plan,
  BalanceTransaction,
  CreditsSummary,
  TransactionType,
  type BillingPeriod,
  type CreditDetailItem,
  type CreditDetailsResult,
  type CreditDetailStatus,
  type PlanQuotaRuleView,
  type VoucherDetailItem,
} from '@ruidong/shared';
import {
  resolvePlanQuotaRuleViews,
  rollingQuotaGateEnabled,
} from '../quota-templates/plan-quota-rule-views';
import {
  CodingPlanEntitlementStatus,
  CodingPlanFulfillmentMode,
  CodingPlanEntitlement as PrismaCodingPlanEntitlement,
  OrderStatus,
  Prisma,
  Plan as PrismaPlan,
  BalanceGrant as PrismaBalanceGrant,
  BalanceTransaction as PrismaBalanceTransaction,
  GatewayUsageFundingReservation as PrismaGatewayUsageFundingReservation,
  GatewayUsageFundingReservationGrant as PrismaGatewayUsageFundingReservationGrant,
  BalanceTransactionAttributionSource,
  ProductBillingMode,
  TransactionType as PrismaTransactionType,
} from '@prisma/client';
import { createHash } from 'crypto';
import { centsToUsd, usd, usdNumber, usdString, usdToCents, type DecimalLike } from './money';
import {
  buildTokenTypeBreakdown,
  getRegularInputTokens,
} from './token-breakdown';
import { hasPrismaErrorCode } from '../common/utils/prisma-error.util';
import {
  defaultPlanSalesStatus,
  loadProviderResalePlanSalesStatuses,
  type PlanSalesStatus,
} from './plan-sales-status';
import { resolvePlatformCurrency } from './platform-currency';
import { SystemConfigService } from './system-config.service';
import { POSTGRES_UTC_FINANCIAL_CLOCK } from './balance-financial-clock';
import {
  billingFundingBlockerTotal,
  gatewayCreditPolicyWindowUnavailableTotal,
} from '../metrics/metrics.registry';
import { timed } from '../common/runtime/usage-stage-timings';

interface DeductOptions {
  tokenUsageId?: string;
  operationKey?: string;
  allowNegativeBalance?: boolean;
  /**
   * Completes settlement for usage that the trusted Gateway has already
   * delivered. This may cross the normal wallet, workspace allowance, or
   * enterprise credit floor so the whole request is recorded atomically.
   * Admission paths must never set this option.
   */
  allowTerminalSettlement?: boolean;
  /**
   * Admin bill-adjust debit may drive wallet negative (ADR-0015).
   * Admission / gateway paths must never set this.
   */
  allowWalletOverdraft?: boolean;
  /**
   * Business occurrence time used to freeze enterprise credit for a delayed,
   * trusted settlement. Ordinary admission/deduction must leave this unset and
   * continues to use the configuration locked at financial write time.
   */
  fundingPolicyAt?: Date;
  /**
   * Cross-clock proof for trusted Gateway settlement. gatewayStartAt is the
   * signed producer timestamp; firstReceivedAt is the immutable Billing DB
   * first-receipt clock. Billing applies its explicitly configured skew bound
   * and grants credit only when the whole resulting interval has one policy.
   */
  fundingPolicyOccurrence?: {
    gatewayStartAt: Date;
    firstReceivedAt: Date;
  };
  /** Immutable Gateway subject expected after wallet/account locks are held. */
  anchoredTenantId?: string;
  anchoredBillingAccountId?: string;
  /**
   * Internal-only subject frozen by an immutable Gateway anchor and funding
   * reservation. Delayed settlement must charge this original account even if
   * the member, key, owner, or tenant-to-account binding changed after T0.
   */
  frozenGatewaySubject?: {
    userId: string;
    tenantId: string;
    billingAccountId: string;
  };
  validateAnchoredSubject?: (
    db: Prisma.TransactionClient,
  ) => Promise<void>;
  /**
   * Permanent first-receipt BALANCE funding authority. Gateway settlement
   * must consume this reservation rather than reclassifying against the wallet
   * or credit policy visible at settlement time.
   */
  fundingReservation?: {
    requestId: string;
    anchorHash: string;
    gatewayBillingEventId: string;
    evidenceHash: string;
    reconciliationActionId?: string;
  };
  productId?: string | null;
  tenantId?: string | null;
  beforeBalanceTransaction?: (
    db: Prisma.TransactionClient,
    context: BalanceDeductFundingContext,
  ) => Promise<{ tokenUsageId?: string | null } | void>;
  afterBalanceTransaction?: (
    db: Prisma.TransactionClient,
    snapshot: WorkspaceBalanceSnapshot,
    context: BalanceDeductTransactionContext,
  ) => Promise<void>;
}

function canonicalGatewayFundingJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(canonicalGatewayFundingJson).join(',')}]`;
  }
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => (
      `${JSON.stringify(key)}:${canonicalGatewayFundingJson(item)}`
    ))
    .join(',')}}`;
}

interface BalanceDeductTransactionContext {
  /** Null only for a trusted, zero-priced Gateway terminal settlement. */
  balanceTransactionId: string | null;
  billingAccountId: string;
  tenantId: string;
  tokenUsageId?: string | null;
  debtOpen: boolean;
  debtExposureUsd: Prisma.Decimal;
  collectedUsd: Prisma.Decimal;
  approvedCreditUsd: Prisma.Decimal;
  unapprovedDebtUsd: Prisma.Decimal;
  fundingPolicy: FrozenEnterpriseFundingPolicy;
}

interface BalanceDeductFundingContext {
  debtOpen: boolean;
  debtExposureUsd: Prisma.Decimal;
  collectedUsd: Prisma.Decimal;
  approvedCreditUsd: Prisma.Decimal;
  unapprovedDebtUsd: Prisma.Decimal;
}

interface EnterpriseFundingOutstanding {
  approvedReceivableUsd: Prisma.Decimal;
  unapprovedDebtUsd: Prisma.Decimal;
  classificationComplete: boolean;
}

interface FrozenEnterpriseFundingPolicy {
  policyAt: Date;
  policyRevision: number | null;
  source: WorkspaceBalanceSnapshot['creditPolicySource'];
  reconstructible: boolean;
  limitUsd: Prisma.Decimal;
  status: string | null;
  termsDays: number | null;
  effectiveAt: Date | null;
  expiresAt: Date | null;
}

export interface GatewayBalanceFundingReservationInput {
  gatewayBillingEventId: string;
  requestId: string;
  billingAccountId: string;
  tenantId: string;
  userId: string;
  apiKeyId: string;
  billingCurrency: string;
  occurredAt: Date;
  firstReceivedAt: Date;
  firstReceiptSequence: bigint;
  anchorHash: string;
  reservedAmountUsd: DecimalLike;
}

export interface GatewayBalanceFundingReservationResult {
  id: string;
  requestId: string;
  billingAccountId: string;
  status: string;
  reviewReason: string | null;
  reservedAmountUsd: Prisma.Decimal;
  collectedUsd: Prisma.Decimal;
  approvedCreditUsd: Prisma.Decimal;
  unapprovedDebtUsd: Prisma.Decimal;
}

interface GatewayFundingGrantSlice {
  balanceGrantId: string;
  amountUsd: Prisma.Decimal;
  allocationOrder: number;
}

const RESOLVED_BILLING_SUBJECT = Symbol('resolved-billing-subject');

interface BillingSubjectOptions {
  tenantId?: string | null;
  billingAccountId?: string | null;
  // Legacy callers may still send this field, but authorization never trusts
  // a caller-supplied role. The resolved subject below is database-backed and
  // branded so it cannot be forged by a plain options object.
  tenantRole?: string | null;
  idempotencyKey?: string | null;
  requiredCompletedOrderId?: string | null;
  requireNoActiveSubscription?: boolean;
  refundComponent?: 'PAID' | 'BONUS';
}

interface BillingAccountSubjectRef {
  tenantId: string;
  billingAccountId: string;
}

export class RechargeBillingSubjectChangedError extends ConflictException {
  readonly code = 'RECHARGE_BILLING_SUBJECT_CHANGED';

  constructor() {
    super('充值订单账务主体已变化，已停止入账');
  }
}

export class GatewayFundingReservationActiveError extends ConflictException {
  readonly code = 'GATEWAY_FUNDING_RESERVATION_ACTIVE';

  constructor(readonly billingAccountId: string) {
    super('账户存在待结算 Gateway 资金预占，已暂停减少现金余额的操作');
  }
}

/**
 * A later BALANCE first receipt reached the financial writer before an older
 * Billing receipt had produced its immutable funding reservation. This is a
 * transient queue condition, not conflicting evidence and not a reason to
 * close the account for manual review. The first-receipt guard remains active
 * while Kafka retries the event.
 */
export class GatewayFundingReservationQueuePendingError extends Error {
  readonly code = 'GATEWAY_FUNDING_RESERVATION_QUEUE_PENDING';
  readonly retryable = true;
  readonly blockingSequence: string;

  constructor(
    readonly billingAccountId: string,
    readonly requestId: string,
    readonly blockingRequestId: string,
    blockingSequence: bigint,
  ) {
    const serializedBlockingSequence = blockingSequence.toString();
    super(
      `GATEWAY_FUNDING_RESERVATION_QUEUE_PENDING:${billingAccountId}:${requestId}:`
      + `${blockingRequestId}:${serializedBlockingSequence}`,
    );
    // Error properties are enumerable and KafkaJS includes the full error in
    // its structured log context. Keep database bigint values out of that JSON
    // boundary so a retryable queue condition cannot crash the consumer logger.
    this.blockingSequence = serializedBlockingSequence;
    this.name = 'GatewayFundingReservationQueuePendingError';
  }
}

export interface ResolvedBillingSubject extends BillingAccountSubjectRef {
  readonly [RESOLVED_BILLING_SUBJECT]: true;
  resolvedForUserId: string;
  tenantName: string;
  tenantType: string;
  tenantStatus: string;
  tenantOwnerUserId: string;
  membershipRole: string;
  membershipStatus: string;
  billingAccountType: string;
  billingAccountStatus: string;
  billingAccountOwnerUserId: string | null;
  billingAccountName: string;
  billingAccountMembershipRole: string | null;
  billingAccountMembershipStatus: string | null;
}

interface WorkspaceBalanceSnapshot {
  workspaceBalanceUsd: Prisma.Decimal;
  accountBalanceUsd: Prisma.Decimal;
  accountAvailableBalanceUsd: Prisma.Decimal;
  billingAccountType: string;
  currency: string;
  creditLimitUsd: Prisma.Decimal;
  creditUsedUsd: Prisma.Decimal;
  creditRemainingUsd: Prisma.Decimal;
  creditStatus: string | null;
  creditTermsDays: number | null;
  creditEffectiveAt: Date | null;
  creditExpiresAt: Date | null;
  creditPolicyAt: Date;
  creditPolicyEventId: string | null;
  creditPolicyRevision: number | null;
  creditPolicySource:
    | 'CURRENT_CONFIG'
    | 'EVENT_OLD_STATE'
    | 'EVENT_NEW_STATE'
    | 'NO_CONFIG'
    | 'CURRENT_PREPAID'
    | 'HISTORY_UNAVAILABLE'
    | 'NOT_APPLICABLE';
  creditPolicyReconstructible: boolean;
  /** Internal proof that the locked current config selects prepaid-only mode. */
  creditPolicyCurrentPrepaidProven: boolean;
  creditConfiguredLimitUsd: Prisma.Decimal;
  allowanceUsd: Prisma.Decimal | null;
  allowanceUsedUsd: Prisma.Decimal;
  allowanceRemainingUsd: Prisma.Decimal | null;
}

interface EnterpriseCreditPolicyConfig {
  limitUsd: DecimalLike;
  status: string;
  termsDays: number | null;
  effectiveAt: Date | null;
  expiresAt: Date | null;
}

interface EnterpriseCreditPolicyResolution {
  config: EnterpriseCreditPolicyConfig | null;
  policyAt: Date;
  policyEventId: string | null;
  policyRevision: number | null;
  source: WorkspaceBalanceSnapshot['creditPolicySource'];
  reconstructible: boolean;
  currentPrepaidProven?: boolean;
}

type GatewayCreditPolicyWindowFailureReason =
  | 'invalid_occurrence'
  | 'not_configured'
  | 'invalid'
  | 'fast_out_of_bounds'
  | 'empty_window'
  | 'invalid_window'
  | 'history_unavailable'
  | 'window_crosses_policy';

type EnterpriseCreditPolicyWindow =
  | {
      kind: 'BOUNDED';
      earliestAt: Date;
      latestAt: Date;
    }
  | {
      kind: 'UNAVAILABLE';
      policyAt: Date;
      reason: GatewayCreditPolicyWindowFailureReason;
    };

interface AnchoredBalanceProjection {
  bindingUnchanged: boolean;
  snapshot: WorkspaceBalanceSnapshot | null;
}

interface KeyBalanceFundingState {
  userId: string;
  tenantId: string;
  billingAccountId: string;
  hasBalance: boolean;
}

export interface WorkspaceBalanceReport {
  tenantId: string;
  balanceCents: number;
  balanceUsd: number;
  accountBalanceCents: number;
  accountBalanceUsd: number;
  accountAvailableBalanceCents: number;
  accountAvailableBalanceUsd: number;
  billingAccountType: string;
  currency: string;
  creditLimitCents: number;
  creditLimitUsd: number;
  creditUsedCents: number;
  creditUsedUsd: number;
  creditRemainingCents: number;
  creditRemainingUsd: number;
  creditStatus: string | null;
  creditTermsDays: number | null;
  creditEffectiveAt: string | null;
  creditExpiresAt: string | null;
  allowanceCents: number | null;
  allowanceUsd: number | null;
  allowanceUsedCents: number;
  allowanceUsedUsd: number;
  allowanceRemainingCents: number | null;
  allowanceRemainingUsd: number | null;
}

export interface BalanceGrantExpirySweepResult {
  scanned: number;
  expired: number;
  failed: number;
  totalExpiredUsd: number;
  totalWalletDebitedUsd: number;
  totalUnbackedUsd: number;
}

type ExpiredBalanceGrantResult = {
  outcome: 'EXPIRED';
  id: string;
  userId: string;
  tenantId: string;
  billingAccountId: string;
  nominalAmountUsd: Prisma.Decimal;
  walletDebitUsd: Prisma.Decimal;
  unbackedAmountUsd: Prisma.Decimal;
};

type BlockedBalanceGrantExpiryResult = {
  outcome: 'BLOCKED';
  id: string;
  userId: string;
  tenantId: string;
  billingAccountId: string;
  reason: string;
};

type BalanceGrantExpiryAttemptResult =
  | ExpiredBalanceGrantResult
  | BlockedBalanceGrantExpiryResult;

export class BalanceLedgerReconciliationRequiredError extends Error {
  constructor(
    readonly billingAccountId: string,
    readonly reason: string,
    readonly quarantineExistingLedger = true,
  ) {
    super(`BALANCE_LEDGER_RECONCILIATION_REQUIRED:${billingAccountId}:${reason}`);
    this.name = 'BalanceLedgerReconciliationRequiredError';
  }
}

/**
 * A delayed enterprise settlement cannot choose a funding policy until the
 * occurrence-time credit boundary is reconstructible. Callers may retry after
 * the pending policy boundary has been confirmed; treating this as zero credit
 * would create an irreversible, unapproved customer debt.
 */
export class EnterpriseCreditPolicyPendingError extends Error {
  readonly code = 'ENTERPRISE_CREDIT_POLICY_PENDING';
  readonly retryable = true;

  constructor(
    readonly billingAccountId: string,
    readonly policyAt: Date,
  ) {
    super(
      `ENTERPRISE_CREDIT_POLICY_PENDING:${billingAccountId}:${policyAt.toISOString()}`,
    );
    this.name = 'EnterpriseCreditPolicyPendingError';
  }
}

const BALANCE_GRANT_ALLOCATION_MAX_RETRIES = 5;
const GATEWAY_COLLECTED_FUNDING_PROTOCOL = 'NON_EXPIRING_GRANTS_V1';

interface RechargeWithBonusOptions extends BillingSubjectOptions {
  bonusDescription?: string;
}

interface IssueVoucherOptions extends BillingSubjectOptions {
  productId?: string | null;
  expiresAt?: Date | null;
  performedBy?: string | null;
  attribution?: BalanceTransactionAttributionInput;
}

interface BalanceTransactionAttributionInput {
  billingMode: ProductBillingMode;
  source: BalanceTransactionAttributionSource;
}

export interface VoucherIssueResult {
  transaction: BalanceTransaction;
  grant: {
    id: string;
    source: string;
    amountCents: number;
    remainingCents: number;
    paidAmountCents: number;
    bonusAmountCents: number;
    discountRate: number;
    productId: string | null;
    expiresAt: string | null;
  };
}

export const BALANCE_ADJUSTMENT_REASON_CODES = [
  'DISCOUNT_CORRECTION',
  'BILLING_CORRECTION',
  'SERVICE_COMPENSATION',
  'OTHER',
] as const;

export type BalanceAdjustmentReasonCode =
  typeof BALANCE_ADJUSTMENT_REASON_CODES[number];

export interface ClassifiedBalanceAdjustmentInput {
  amountCents: number;
  reasonCode: BalanceAdjustmentReasonCode;
  description: string;
  performedBy?: string | null;
  idempotencyKey: string;
  tenantId?: string | null;
  billingAccountId?: string | null;
  productId?: string | null;
  /** 企业账单调增等运营场景：余额不足时允许钱包为负（ADR-0015）。 */
  allowWalletOverdraft?: boolean;
}

export interface ClassifiedBalanceAdjustmentResult {
  direction: 'CREDIT' | 'DEBIT';
  reasonCode: BalanceAdjustmentReasonCode;
  amountCents: number;
  balanceAfterCents: number;
  transaction: BalanceTransaction;
}

export interface CodingPlanEntitlementView {
  id: string;
  orderId: string;
  userId: string;
  tenantId: string;
  productId: string;
  planId: string;
  providerEntitlementId: string | null;
  providerLineId: string | null;
  providerLineCode: string | null;
  providerCode: string | null;
  adapterType: string | null;
  upstreamProductId: string | null;
  fulfillmentMode: string;
  billingPeriod: string;
  status: string;
  startedAt: string;
  expiresAt: string | null;
  lastError: string | null;
  product: {
    id: string;
    name: string;
    slug: string;
    billingMode: string;
  } | null;
  plan: {
    id: string;
    name: string;
    description: string;
    monthlyPrice: number;
    quarterlyPrice: number;
    yearlyPrice: number;
    billingPeriod: string;
    monthlyCredits: number;
    rateLimitRpm: number;
    rateLimitTpm: number;
    maxContextWindow: number;
    features: string[];
  } | null;
  providerEntitlement: {
    id: string;
    provider: string;
    providerLineId: string;
    providerLineCode: string | null;
    providerCode: string | null;
    adapterType: string | null;
    upstreamProductId: string;
    upstreamApiKeyPrefix: string | null;
    status: string;
    productStartTime: string | null;
    productEndTime: string | null;
    activatedAt: string | null;
    lastError: string | null;
  } | null;
}

interface ResolveBillingSubjectOptions {
  requireBillingRole?: boolean;
  requireExplicitTenant?: boolean;
  /** Financial transactions must never bootstrap account/tenant/wallet rows. */
  requireProvisionedBillingAccount?: boolean;
}

type TokenUsageBillingAmountRow = {
  costUsd?: DecimalLike | null;
  balanceTransaction?: { amountUsd?: DecimalLike | null } | null;
  consumptionAllocations?: Array<{
    amountUsd?: DecimalLike | null;
    recognizedRevenueUsd?: DecimalLike | null;
    bonusConsumedUsd?: DecimalLike | null;
  }> | null;
};

function sumUsd<T>(items: T[], pick: (item: T) => DecimalLike | null | undefined): Prisma.Decimal {
  return items.reduce((total, item) => total.plus(usd(pick(item))), usd(0));
}

function getTokenUsageBillingAmounts(row: TokenUsageBillingAmountRow) {
  const allocations = row.consumptionAllocations ?? [];
  if (allocations.length > 0) {
    const costUsd = sumUsd(allocations, (allocation) => allocation.amountUsd);
    if (costUsd.gt(0)) {
      return {
        costUsd,
        paymentDeductionUsd: sumUsd(allocations, (allocation) => allocation.recognizedRevenueUsd),
        voucherDeductionUsd: sumUsd(allocations, (allocation) => allocation.bonusConsumedUsd),
      };
    }
  }

  const recordedCostUsd = usd(row.costUsd).abs();
  const linkedBalanceCostUsd = row.balanceTransaction?.amountUsd
    ? usd(row.balanceTransaction.amountUsd).abs()
    : recordedCostUsd;
  const costUsd = recordedCostUsd.gt(0) ? recordedCostUsd : linkedBalanceCostUsd;
  return {
    costUsd,
    paymentDeductionUsd: costUsd,
    voucherDeductionUsd: usd(0),
  };
}

export type CodingPlanUsageTrendRange = 'day' | 'last7Days' | 'last30Days';

export interface CodingPlanUsageTrendPoint {
  time: string;
  totalTokens: number;
  calls: number;
}

export interface CodingPlanUsageTrendSeries {
  model: string;
  totalTokens: number;
  calls: number;
  points: CodingPlanUsageTrendPoint[];
}

export interface CodingPlanUsageTrend {
  range: CodingPlanUsageTrendRange;
  bucket: 'hour' | 'day';
  timezone: 'Asia/Shanghai';
  startAt: string;
  endAt: string;
  updatedAt: string;
  buckets: string[];
  totalTokens: number;
  totalCalls: number;
  models: Array<{ model: string; totalTokens: number; calls: number }>;
  series: CodingPlanUsageTrendSeries[];
}

const TENANT_OWNER_ROLE = 'owner';
const RECHARGE_VALIDITY_DAYS = 365;
const BALANCE_GRANT_SOURCE_RECHARGE = 'RECHARGE';
const BALANCE_GRANT_SOURCE_VOUCHER = 'VOUCHER';
const PERSONAL_BILLING_ACCOUNT_ID_PREFIX = 'ba_personal_';
const ENTERPRISE_ACCOUNT_TYPE = 'enterprise';
const ENTERPRISE_CREDIT_STATUS_ACTIVE = 'ACTIVE';
const ENTERPRISE_CREDIT_STATUS_DISABLED = 'DISABLED';
const ENTERPRISE_CREDIT_STATUS_SUSPENDED = 'SUSPENDED';
const BALANCE_ALLOCATION_SOURCE_BALANCE_GRANT = 'BALANCE_GRANT';
const BALANCE_ALLOCATION_SOURCE_UNRECONCILED_GRANT = 'UNRECONCILED_GRANT';
const BALANCE_ALLOCATION_SOURCE_ENTERPRISE_CREDIT = 'ENTERPRISE_CREDIT';
const BALANCE_ALLOCATION_SOURCE_NEGATIVE_BALANCE = 'NEGATIVE_BALANCE';
const BALANCE_DEBT_SETTLEMENT_TRIGGER_FUNDING = 'FUNDING';
/**
 * 同步核销的预算水位:超过即把剩余额度转入 balance_debt_settlement_pending,
 * 由 worker 分批独立事务续做。
 *
 * 25s 的来历:admin-api 调 billing 的 HTTP 超时是 45s,而 60s 交互事务里
 * 前后置校验实测约占 10s。留足余量让「钱包已加钱」的事务在前端超时之前提交 ——
 * 否则会出现钱已入账但前端报失败,运营换一个幂等键重充 ⇒ 重复入账。
 * 逐行核销的物理成本约 1ms/行(3 个 BEFORE 行触发器 + settled_at 在 2 个索引里
 * 导致无法 HOT update),故 25s 约对应 2.4 万行。
 */
const BALANCE_DEBT_SETTLEMENT_SYNC_BUDGET_MS_DEFAULT = 25_000;

const balanceDebtSettlementSyncBudgetMs = (): number => {
  const raw = Number.parseInt(
    process.env.BALANCE_DEBT_SETTLEMENT_SYNC_BUDGET_MS ?? '',
    10,
  );
  return Number.isFinite(raw) && raw > 0
    ? raw
    : BALANCE_DEBT_SETTLEMENT_SYNC_BUDGET_MS_DEFAULT;
};
const BALANCE_DEBT_SETTLEMENT_BATCH = 200;
const ENTERPRISE_CREDIT_DAY_MS = 24 * 60 * 60 * 1000;
const BALANCE_GRANT_LEDGER_STATUS_DIRTY = 'LEGACY_DIRTY';
const BALANCE_GRANT_LEDGER_STATUS_RECONCILED = 'RECONCILED_V2';
const BALANCE_GRANT_LEDGER_VERSION = 2;
const ADMIN_RECHARGE_IDEMPOTENCY_SCOPE = 'admin:recharge';
const ADMIN_ADJUST_BALANCE_IDEMPOTENCY_SCOPE = 'admin:adjust-balance';
const ADMIN_ADJUST_ENTERPRISE_PAID_DEBT_OPERATION_PREFIX =
  'balance:admin-adjust:enterprise-paid-debt:';
const ADMIN_ISSUE_VOUCHER_IDEMPOTENCY_SCOPE = 'admin:issue-voucher';
const ADMIN_BILLING_DEBIT_IDEMPOTENCY_SCOPE = 'admin:billing-adjustment-debit';
const ADMIN_BILLING_DEBIT_OPERATION_PREFIX = 'balance:admin-billing-adjustment:debit:';
const MAX_CLASSIFIED_BALANCE_ADJUSTMENT_CENTS = 25_000 * 100;
const ADMIN_FUNDING_IDEMPOTENCY_TTL_MS = 30 * 24 * 60 * 60 * 1000;
const ADMIN_FUNDING_PENDING_IDEMPOTENCY_TTL_MS = 2 * 60 * 1000;
const ADMIN_FUNDING_IDEMPOTENCY_KEY_MAX_LENGTH = 160;
// One account's due grants are intentionally expired atomically. Give every
// financial entry point that may perform that work an explicit budget instead
// of Prisma's short interactive-transaction default.
const BALANCE_LEDGER_TRANSACTION_OPTIONS = { maxWait: 10_000, timeout: 60_000 } as const;

type AdminFundingIdempotencyScope =
  | typeof ADMIN_RECHARGE_IDEMPOTENCY_SCOPE
  | typeof ADMIN_ADJUST_BALANCE_IDEMPOTENCY_SCOPE
  | typeof ADMIN_ISSUE_VOUCHER_IDEMPOTENCY_SCOPE
  | typeof ADMIN_BILLING_DEBIT_IDEMPOTENCY_SCOPE;

interface AdminFundingRequestFingerprint {
  scope: AdminFundingIdempotencyScope;
  userId: string;
  tenantId: string;
  billingAccountId: string;
  amountUsd: string;
  productId: string | null;
  description: string;
  reason: string | null;
  expiresAt: string | null;
  performedBy: string | null;
}

interface AdminFundingIdempotencyEnvelope<T = unknown> {
  version: 2;
  status: 'PENDING' | 'COMMITTED';
  request: AdminFundingRequestFingerprint;
  response?: T;
}

type BalanceDebtAllocationSource =
  | typeof BALANCE_ALLOCATION_SOURCE_ENTERPRISE_CREDIT
  | typeof BALANCE_ALLOCATION_SOURCE_NEGATIVE_BALANCE;

/** 单行欠款核销的增量。分摊仍逐行算，只把写入按批合并。见 flushBalanceDebtSettlementBatch。 */
interface BalanceDebtAllocationWrite {
  id: string;
  applyUsd: Prisma.Decimal;
  applyPaidUsd: Prisma.Decimal;
  applyBonusUsd: Prisma.Decimal;
  /** 本行是否被结满 —— 决定 settled_at,必须与 guard 的双向条件一致 */
  markSettled: boolean;
}

/**
 * Row/batch counters for one settleBalanceDebtOnFunding call.
 *
 * Mutated by the inner method so the wrapper can log them on both the success
 * and the failure path — on failure the partial counts are the interesting part
 * (they say how far it got before the budget ran out).
 *
 * Counters only; nothing here influences settlement arithmetic.
 */
interface BalanceDebtSettlementStats {
  batches: number;
  /** Candidate rows fetched by the keyset cursor across all batches. */
  allocationsScanned: number;
  /** Rows given a settlement increment (subset of scanned). */
  allocationsUpdated: number;
  settlementRowsInserted: number;
  /** 因触及预算水位而转入 pending 队列的金额;0 表示本次全部同步核销完。 */
  pendingEnqueuedUsd: Prisma.Decimal;
}

interface ReconciledBalanceLedgerSnapshot {
  walletUsd: Prisma.Decimal;
  activeGrantUsd: Prisma.Decimal;
  openDebtUsd: Prisma.Decimal;
  /**
   * 已入账但尚未核销到 allocation 行的金额(balance_debt_settlement_pending 聚合)。
   * 账户级不变量由两项式扩为三项式:
   *   openDebtUsd - pendingSettlementUsd = max(0, -walletUsd)
   * pending 恒为 0 时退化为原两项式,故未降级过的账户行为逐字节不变。
   */
  pendingSettlementUsd: Prisma.Decimal;
  invalidGrantCount: bigint;
  dueGrantCount: bigint;
  invalidDebtCount: bigint;
  invalidSequenceCount: bigint;
  unexpectedDebtCount: bigint;
}

type BalanceGrantRefundComponent = 'PAID' | 'BONUS' | 'UNKNOWN';

@Injectable()
export class BillingService {
  private readonly logger = new Logger(BillingService.name);
  private readonly gatewayClockWindowWarnings = new Set<string>();

  constructor(
    private readonly billingRepository: BillingRepository,
    private readonly redis: RedisService,
    private readonly prisma: PrismaService,
    /**
     * P2-C: 信用额度策略 hook。@Optional 注入 —— 未 wire CreditPolicyModule
     * 的现有测试不破坏(deduct 退化为现状,即 Lua 严格 >=0)。
     *
     * 生产路径在 BillingModule imports CreditPolicyModule 后即可拿到实例。
     */
    @Optional() private readonly creditPolicy?: CreditPolicyService,
    @Optional() private readonly publisherSync?: PublisherSyncService,
    @Optional() private readonly subscriptionLifecycle?: SubscriptionLifecycleService,
    @Optional() private readonly systemConfig?: SystemConfigService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  private normalizeAdminFundingIdempotencyKey(key: string | null | undefined): string | null {
    const normalized = key?.trim();
    if (!normalized) return null;
    if (normalized.length > ADMIN_FUNDING_IDEMPOTENCY_KEY_MAX_LENGTH) {
      throw new BadRequestException('idempotencyKey 过长');
    }
    return normalized;
  }

  private adminFundingIdempotencyWhere(
    scope: AdminFundingIdempotencyScope,
    key: string,
  ): Prisma.IdempotencyKeyWhereUniqueInput {
    return { key_scope: { key, scope } };
  }

  private toAdminFundingIdempotencyResult(result: unknown): Prisma.InputJsonValue {
    return JSON.parse(JSON.stringify(result)) as Prisma.InputJsonValue;
  }

  private adminFundingFingerprintMatches(
    actual: unknown,
    expected: AdminFundingRequestFingerprint,
  ): boolean {
    if (!actual || typeof actual !== 'object' || Array.isArray(actual)) return false;
    const value = actual as Record<string, unknown>;
    return value.scope === expected.scope
      && value.userId === expected.userId
      && value.tenantId === expected.tenantId
      && value.billingAccountId === expected.billingAccountId
      && value.amountUsd === expected.amountUsd
      && (value.productId ?? null) === expected.productId
      && value.description === expected.description
      && (value.reason ?? null) === expected.reason
      && (value.expiresAt ?? null) === expected.expiresAt
      && (value.performedBy ?? null) === expected.performedBy;
  }

  private isAdminFundingIdempotencyEnvelope(
    value: unknown,
  ): value is AdminFundingIdempotencyEnvelope {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return false;
    const candidate = value as Record<string, unknown>;
    return candidate.version === 2
      && (candidate.status === 'PENDING' || candidate.status === 'COMMITTED')
      && !!candidate.request
      && typeof candidate.request === 'object'
      && !Array.isArray(candidate.request);
  }

  private adminFundingFingerprintConflict(): ConflictException {
    return new ConflictException('ADMIN_FUNDING_IDEMPOTENCY_FINGERPRINT_MISMATCH');
  }

  private async validateLegacyAdminFundingReplay(
    scope: AdminFundingIdempotencyScope,
    result: unknown,
    expected: AdminFundingRequestFingerprint,
  ): Promise<void> {
    if (!result || typeof result !== 'object' || Array.isArray(result)) {
      throw this.adminFundingFingerprintConflict();
    }
    const root = result as Record<string, unknown>;
    const transactionValue = scope === ADMIN_ISSUE_VOUCHER_IDEMPOTENCY_SCOPE
      ? root.transaction
      : root;
    if (!transactionValue || typeof transactionValue !== 'object' || Array.isArray(transactionValue)) {
      throw this.adminFundingFingerprintConflict();
    }
    const transactionResponse = transactionValue as Record<string, unknown>;
    const transactionId = transactionResponse.id;
    if (typeof transactionId !== 'string' || !transactionId) {
      throw this.adminFundingFingerprintConflict();
    }

    let expectedTransactionDescription = expected.description;
    let legacyVoucherGrantId: string | null = null;
    if (scope === ADMIN_ISSUE_VOUCHER_IDEMPOTENCY_SCOPE) {
      const grantValue = root.grant;
      if (!grantValue || typeof grantValue !== 'object' || Array.isArray(grantValue)) {
        throw this.adminFundingFingerprintConflict();
      }
      const grantResponse = grantValue as Record<string, unknown>;
      if (typeof grantResponse.id !== 'string' || !grantResponse.id) {
        throw this.adminFundingFingerprintConflict();
      }
      legacyVoucherGrantId = grantResponse.id;
      expectedTransactionDescription = [
        `voucher:${legacyVoucherGrantId}`,
        expected.performedBy ? `admin:${expected.performedBy}` : null,
        expected.reason,
      ].filter(Boolean).join(' ');
      if (
        grantResponse.source !== BALANCE_GRANT_SOURCE_VOUCHER
        || grantResponse.amountCents !== usdToCents(expected.amountUsd)
        || grantResponse.paidAmountCents !== 0
        || grantResponse.bonusAmountCents !== usdToCents(expected.amountUsd)
        || (grantResponse.productId ?? null) !== expected.productId
        || (grantResponse.expiresAt ?? null) !== expected.expiresAt
      ) {
        throw this.adminFundingFingerprintConflict();
      }
    }

    const expectedType = scope === ADMIN_RECHARGE_IDEMPOTENCY_SCOPE
      ? PrismaTransactionType.RECHARGE
      : scope === ADMIN_BILLING_DEBIT_IDEMPOTENCY_SCOPE
        ? PrismaTransactionType.CONSUME
        : PrismaTransactionType.ADJUST;
    if (
      transactionResponse.userId !== expected.userId
      || transactionResponse.tenantId !== expected.tenantId
      || (transactionResponse.productId ?? null) !== expected.productId
      || transactionResponse.type !== expectedType
      || transactionResponse.amountCents !== (
        scope === ADMIN_BILLING_DEBIT_IDEMPOTENCY_SCOPE
          ? Math.abs(usdToCents(expected.amountUsd))
          : usdToCents(expected.amountUsd)
      )
      || transactionResponse.description !== expectedTransactionDescription
    ) {
      throw this.adminFundingFingerprintConflict();
    }

    // Legacy raw responses do not contain billingAccountId.  Prove it from the
    // immutable transaction instead of guessing from the current tenant map.
    const transaction = await this.prisma.balanceTransaction.findUnique({
      where: { id: transactionId },
    });
    if (
      !transaction
      || !this.balanceTransactionMatchesReplayFingerprint(transaction, {
        userId: expected.userId,
        subject: {
          tenantId: expected.tenantId,
          billingAccountId: expected.billingAccountId,
        },
        type: expectedType,
        amountUsd: usd(expected.amountUsd),
        description: expectedTransactionDescription,
        productId: expected.productId,
      })
    ) {
      throw this.adminFundingFingerprintConflict();
    }

    if (legacyVoucherGrantId) {
      const grant = await this.prisma.balanceGrant.findUnique({
        where: { id: legacyVoucherGrantId },
      });
      if (
        !grant
        || grant.userId !== expected.userId
        || grant.tenantId !== expected.tenantId
        || grant.billingAccountId !== expected.billingAccountId
        || grant.source !== BALANCE_GRANT_SOURCE_VOUCHER
        || (grant.productId ?? null) !== expected.productId
        || !usd(grant.paidAmountUsd).eq(0)
        || !usd(grant.bonusAmountUsd).eq(expected.amountUsd)
        || !usd(grant.grantedAmountUsd).eq(expected.amountUsd)
        || (grant.expiresAt?.toISOString() ?? null) !== expected.expiresAt
      ) {
        throw this.adminFundingFingerprintConflict();
      }
    }
  }

  private async writePendingAdminFundingIdempotency(
    db: Prisma.TransactionClient,
    scope: AdminFundingIdempotencyScope,
    key: string,
    request: AdminFundingRequestFingerprint,
  ): Promise<void> {
    await db.idempotencyKey.create({
      data: {
        key,
        scope,
        userId: request.userId,
        result: this.toAdminFundingIdempotencyResult({
          version: 2,
          status: 'PENDING',
          request,
        } satisfies AdminFundingIdempotencyEnvelope),
        status: 'PENDING',
        expiresAt: new Date(Date.now() + ADMIN_FUNDING_PENDING_IDEMPOTENCY_TTL_MS),
      },
    });
  }

  private async commitAdminFundingIdempotency(
    db: Prisma.TransactionClient,
    scope: AdminFundingIdempotencyScope,
    key: string,
    request: AdminFundingRequestFingerprint,
    result: unknown,
  ): Promise<void> {
    await db.idempotencyKey.update({
      where: this.adminFundingIdempotencyWhere(scope, key),
      data: {
        userId: request.userId,
        result: this.toAdminFundingIdempotencyResult({
          version: 2,
          status: 'COMMITTED',
          request,
          response: result,
        } satisfies AdminFundingIdempotencyEnvelope),
        status: 'COMMITTED',
        expiresAt: new Date(Date.now() + ADMIN_FUNDING_IDEMPOTENCY_TTL_MS),
      },
    });
  }

  private async replayAdminFundingIdempotency<T>(
    scope: AdminFundingIdempotencyScope,
    key: string,
    expected: AdminFundingRequestFingerprint,
  ): Promise<T> {
    const row = await this.prisma.idempotencyKey.findUnique({
      where: this.adminFundingIdempotencyWhere(scope, key),
    });
    if (!row || row.userId !== expected.userId) {
      throw this.adminFundingFingerprintConflict();
    }
    if (this.isAdminFundingIdempotencyEnvelope(row.result)) {
      if (
        row.result.status !== row.status
        || !this.adminFundingFingerprintMatches(row.result.request, expected)
      ) {
        throw this.adminFundingFingerprintConflict();
      }
      if (row.status === 'COMMITTED') {
        if (!Object.prototype.hasOwnProperty.call(row.result, 'response')) {
          throw this.adminFundingFingerprintConflict();
        }
        this.logger.warn(`admin funding idempotency replay scope=${scope} key=${key}`);
        return row.result.response as T;
      }
    } else if (row.status === 'COMMITTED') {
      // Rolling compatibility for rows written before the v2 envelope.  A raw
      // response is accepted only after its visible fields and immutable DB
      // transaction/grant prove the full current request fingerprint.
      await this.validateLegacyAdminFundingReplay(scope, row.result, expected);
      this.logger.warn(`legacy admin funding idempotency replay scope=${scope} key=${key}`);
      return row.result as T;
    }
    if (row.status === 'PENDING' && row.expiresAt.getTime() <= Date.now()) {
      await this.prisma.idempotencyKey
        .delete({ where: this.adminFundingIdempotencyWhere(scope, key) })
        .catch((err) => {
          if (!hasPrismaErrorCode(err, 'P2025')) throw err;
        });
    }
    throw new ConflictException('操作正在处理中，请稍后刷新或重试');
  }

  // ============================
  // 套餐管理
  // ============================

  private toPlan(
    p: PrismaPlan,
    quotaRules?: PlanQuotaRuleView[],
    salesStatus?: PlanSalesStatus,
    selfOpSoldOut?: boolean,
  ): Plan {
    const resolvedSalesStatus = salesStatus ?? defaultPlanSalesStatus(p);
    return {
      ...(quotaRules && quotaRules.length > 0 ? { quotaRules } : {}),
      id: p.id,
      productId: p.productId,
      name: p.name,
      description: p.description,
      planType: p.planType,
      monthlyPrice: p.monthlyPrice,
      quarterlyPrice: p.quarterlyPrice,
      yearlyPrice: p.yearlyPrice,
      billingPeriod: p.billingPeriod,
      monthlyCredits: p.monthlyCredits,
      creditsRollover: p.creditsRollover,
      rolloverMaxMonths: p.rolloverMaxMonths,
      rateLimitRpm: p.rateLimitRpm,
      rateLimitTpm: p.rateLimitTpm,
      maxContextWindow: p.maxContextWindow,
      overageEnabled: p.overageEnabled,
      usageMultiplier: p.usageMultiplier,
      // availableModels 已迁移至 model_access 表，不再从 Plan 字段读取
      memberLimit: p.memberLimit,
      minimumSeats: p.minimumSeats,
      dataTraining: p.dataTraining,
      supportTier: p.supportTier,
      ssoEnabled: p.ssoEnabled,
      priorityAccess: p.priorityAccess,
      badge: p.badge,
      trialDays: p.trialDays,
      validityDays: p.validityDays,
      features: JSON.parse(p.features || '[]') as string[],
      isActive: p.isActive,
      isLegacy: p.isLegacy,
      salesLimit: resolvedSalesStatus.salesLimit,
      reservedSalesCount: resolvedSalesStatus.reservedSalesCount,
      remainingSales: resolvedSalesStatus.remainingSales,
      // 转售(salesStatus.soldOut) 或 自营限量(selfOpSoldOut) 任一售罄即 true；两特性并行、按 plan 归属互斥。
      soldOut: resolvedSalesStatus.soldOut || Boolean(selfOpSoldOut),
      sortOrder: p.sortOrder,
      createdAt: p.createdAt.toISOString(),
      updatedAt: p.updatedAt.toISOString(),
    };
  }

  async getPlans(productId?: string): Promise<Plan[]> {
    const plans = await this.billingRepository.findActivePlans(productId);
    // 转售上架数量(loadPlanSalesStatuses) 与 自营限量份数(computeSelfOpSoldOutPlanIds) 两特性并行计算。
    const [quotaRulesByPlanId, salesStatusByPlanId, selfOpSoldOutPlanIds] = await Promise.all([
      this.loadPlanQuotaRuleViews(plans),
      this.loadPlanSalesStatuses(plans),
      this.computeSelfOpSoldOutPlanIds(plans),
    ]);
    return plans.map((p: PrismaPlan) => this.toPlan(
      p,
      quotaRulesByPlanId.get(p.id),
      salesStatusByPlanId.get(p.id),
      selfOpSoldOutPlanIds.has(p.id),
    ));
  }

  /**
   * 限量售卖：批量算出「已售罄」的自营套餐 id 集合（仅对 maxSellableQuantity != null 的自营套餐）。
   * 已占份数 = 去重(持该 plan ACTIVE 自营 entitlement 的 tenant ∪ 该 plan 有在途订单的 tenant)。
   * 对外只输出售罄布尔，不返回份数/剩余（商业信息不外泄）。展示口径，非准入（准入以下单事务断言为准）。
   */
  private async computeSelfOpSoldOutPlanIds(plans: PrismaPlan[]): Promise<Set<string>> {
    const soldOut = new Set<string>();
    try {
      const capped = plans.filter(
        (p): p is PrismaPlan & { maxSellableQuantity: number } =>
          p.maxSellableQuantity != null && p.maxSellableQuantity > 0 && Boolean(p.productId),
      );
      if (capped.length === 0) return soldOut;
      const productIds = [...new Set(capped.map((p) => p.productId as string))];
      const products = await this.prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, billingMode: true, codingPlanFulfillmentMode: true },
      });
      const selfOpProductIds = new Set(
        products
          .filter(
            (p) =>
              p.billingMode === 'CODING_PLAN' &&
              p.codingPlanFulfillmentMode === CodingPlanFulfillmentMode.platform_model_package,
          )
          .map((p) => p.id),
      );
      const eligible = capped.filter((p) => selfOpProductIds.has(p.productId as string));
      if (eligible.length === 0) return soldOut;
      const eligibleIds = eligible.map((p) => p.id);
      const [activeRows, reservedRows] = await Promise.all([
        this.prisma.codingPlanEntitlement.findMany({
          where: {
            planId: { in: eligibleIds },
            status: CodingPlanEntitlementStatus.ACTIVE,
            fulfillmentMode: CodingPlanFulfillmentMode.platform_model_package,
          },
          select: { planId: true, tenantId: true },
        }),
        this.prisma.order.findMany({
          where: {
            planId: { in: eligibleIds },
            status: { in: [OrderStatus.PENDING, OrderStatus.PAID, OrderStatus.FULFILLING] },
          },
          select: { planId: true, tenantId: true },
        }),
      ]);
      const holdersByPlan = new Map<string, Set<string>>();
      const add = (planId: string | null, tenantId: string) => {
        if (!planId) return;
        let set = holdersByPlan.get(planId);
        if (!set) holdersByPlan.set(planId, (set = new Set<string>()));
        set.add(tenantId);
      };
      for (const r of activeRows) add(r.planId, r.tenantId);
      for (const r of reservedRows) add(r.planId, r.tenantId);
      for (const p of eligible) {
        if ((holdersByPlan.get(p.id)?.size ?? 0) >= p.maxSellableQuantity) soldOut.add(p.id);
      }
    } catch (err) {
      // 展示降级：售罄计算失败不阻断套餐列表（准入仍由下单事务兜底）。
      this.logger.warn(`computeSelfOpSoldOutPlanIds failed: ${(err as Error).message}`);
    }
    return soldOut;
  }

  /**
   * 批量解析自营 CodingPlan 套餐绑定的配额模板规则（展示用，口径与 publisher 下发一致）。
   * 仅自营 CODING_PLAN 套餐附带；转售套餐的权益来自上游，不展示本地配额模板。
   * 解析失败时降级为空（用户端回退散字段展示），不阻断套餐列表可用性。
   */
  private async loadPlanQuotaRuleViews(
    plans: PrismaPlan[],
  ): Promise<Map<string, PlanQuotaRuleView[]>> {
    const result = new Map<string, PlanQuotaRuleView[]>();
    // 注意不能用 planType 预过滤：planType 是历史套餐档位字段（individual/team/...），
    // 存量 CodingPlan 套餐未必是 'coding_plan'；CODING_PLAN 的权威判定是 product.billingMode
    try {
      const productIds = [
        ...new Set(plans.map((p) => p.productId).filter((id): id is string => Boolean(id))),
      ];
      if (productIds.length === 0) return result;
      const products = await this.prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, billingMode: true, codingPlanFulfillmentMode: true },
      });
      const codingProductIds = new Set(
        products
          .filter((p) =>
            p.billingMode === 'CODING_PLAN' &&
            p.codingPlanFulfillmentMode !== CodingPlanFulfillmentMode.provider_resale,
          )
          .map((p) => p.id),
      );
      const eligibleIds = plans
        .filter((p) => p.productId && codingProductIds.has(p.productId))
        .map((p) => p.id);
      if (eligibleIds.length === 0) return result;

      const bindings = await this.prisma.planQuotaRule.findMany({
        where: { planId: { in: eligibleIds }, isActive: true },
        select: {
          planId: true,
          template: { select: { rules: true, isActive: true, deletedAt: true } },
        },
      });
      const byPlanId = new Map<string, typeof bindings>();
      for (const binding of bindings) {
        const list = byPlanId.get(binding.planId) ?? [];
        list.push(binding);
        byPlanId.set(binding.planId, list);
      }
      const gateEnabled = rollingQuotaGateEnabled();
      for (const [planId, planBindings] of byPlanId) {
        const views = resolvePlanQuotaRuleViews(planBindings, (msg) => this.logger.warn(msg), {
          gateEnabled,
        });
        if (views.length > 0) result.set(planId, views);
      }
    } catch (err) {
      this.logger.warn(`loadPlanQuotaRuleViews failed: ${(err as Error).message}`);
    }
    return result;
  }

  async getPlanById(id: string): Promise<Plan> {
    const plan = await this.billingRepository.findPlanById(id);
    if (!plan || !plan.isActive) {
      throw new NotFoundException('套餐不存在');
    }
    const salesStatusByPlanId = await this.loadPlanSalesStatuses([plan]);
    return this.toPlan(plan, undefined, salesStatusByPlanId.get(plan.id));
  }

  private async loadPlanSalesStatuses(
    plans: PrismaPlan[],
  ): Promise<Map<string, PlanSalesStatus>> {
    try {
      return await loadProviderResalePlanSalesStatuses(this.prisma, plans);
    } catch (err) {
      this.logger.warn(`loadPlanSalesStatuses failed: ${(err as Error).message}`);
      return new Map(plans.map((plan) => [plan.id, defaultPlanSalesStatus(plan)]));
    }
  }

  async getActiveBundles(): Promise<unknown[]> {
    const now = new Date();
    const bundles = await this.prisma.bundleSku.findMany({
      where: {
        isActive: true,
        AND: [
          { OR: [{ startAt: null }, { startAt: { lte: now } }] },
          { OR: [{ endAt: null }, { endAt: { gte: now } }] },
        ],
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'desc' }],
      include: {
        items: {
          orderBy: { sortOrder: 'asc' },
          include: {
            product: {
              select: {
                id: true,
                name: true,
                slug: true,
                icon: true,
                billingMode: true,
              },
            },
            plan: { select: { id: true, name: true, monthlyCredits: true, validityDays: true, features: true } },
            boosterPack: { select: { id: true, name: true, creditsAmount: true, expiryDays: true } },
          },
        },
      },
    });
    return bundles.map((bundle) => ({
      id: bundle.id,
      code: bundle.code,
      name: bundle.name,
      description: bundle.description,
      currency: bundle.currency,
      billingPeriod: bundle.billingPeriod,
      amountCents: bundle.amountCents,
      originalAmountCents: bundle.originalAmountCents,
      startAt: bundle.startAt?.toISOString() ?? null,
      endAt: bundle.endAt?.toISOString() ?? null,
      items: bundle.items.map((item) => ({
        id: item.id,
        productId: item.productId,
        productName: item.product.name,
        productSlug: item.product.slug,
        productBillingMode: item.product.billingMode,
        planId: item.planId,
        boosterPackId: item.boosterPackId,
        billingType: item.billingType,
        name: item.name || item.plan?.name || item.boosterPack?.name || item.product.name,
        unitAmountCents: item.unitAmountCents,
        originalUnitAmountCents: item.originalUnitAmountCents,
        quantity: item.quantity,
        recurringInterval: item.recurringInterval,
        validityDays: item.validityDays,
        monthlyCredits: item.plan?.monthlyCredits ?? null,
        boosterCredits: item.boosterPack?.creditsAmount ?? null,
      })),
    }));
  }

  // ============================
  // 余额管理（Redis + PG 双写）
  // ============================

  private personalBillingAccountId(userId: string): string {
    return `${PERSONAL_BILLING_ACCOUNT_ID_PREFIX}${userId}`;
  }

  // enterprise tenant 无 account 时默认 fail-closed；仅显式配置 warn 时用于联调兜底。
  private enterpriseFallbackMode(): 'warn' | 'fail' {
    const raw = (process.env.BILLING_ENTERPRISE_FALLBACK_MODE || '').trim().toLowerCase();
    const nodeEnv = this.config?.get<string>('NODE_ENV')?.trim() || process.env.NODE_ENV?.trim();
    const appEnv = this.config?.get<string>('APP_ENV')?.trim() || process.env.APP_ENV?.trim();
    if (nodeEnv === 'production' || appEnv === 'production') {
      if (raw === 'warn') {
        this.logger.error(
          'BILLING_ENTERPRISE_FALLBACK_MODE=warn is ignored in production; enterprise billing remains fail-closed',
        );
      }
      return 'fail';
    }
    return raw === 'warn' ? 'warn' : 'fail';
  }

  private accountBalanceKey(billingAccountId: string): string {
    return `balance:account:${billingAccountId}`;
  }

  private legacyTenantBalanceKey(tenantId: string): string {
    return `balance:tenant:${tenantId}`;
  }

  private async writeBalanceCaches(
    subject: BillingAccountSubjectRef,
    workspaceBalanceUsd: Prisma.Decimal,
    accountBalanceUsd: Prisma.Decimal = workspaceBalanceUsd,
  ): Promise<void> {
    const workspaceValue = usdString(workspaceBalanceUsd);
    const accountValue = usdString(accountBalanceUsd);
    await Promise.all([
      this.redis.set(this.accountBalanceKey(subject.billingAccountId), accountValue),
      this.redis.set(this.legacyTenantBalanceKey(subject.tenantId), workspaceValue),
    ]);
  }

  async getBalanceUsd(userId: string, subject: BillingSubjectOptions = {}): Promise<Prisma.Decimal> {
    const billingSubject = await this.requireTenantSubject(userId, subject);
    const snapshot = await this.getWorkspaceBalanceSnapshot(userId, billingSubject);
    return snapshot.workspaceBalanceUsd;
  }

  async getBalance(userId: string, subject: BillingSubjectOptions = {}): Promise<number> {
    return usdToCents(await this.getBalanceUsd(userId, subject));
  }

  async getWorkspaceBalanceReport(tenantId: string): Promise<WorkspaceBalanceReport> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true, ownerUserId: true, billingAccountId: true },
      });
      if (!tenant) {
        throw new BadRequestException('账务所属工作区不存在');
      }
      const billingAccountId = tenant.billingAccountId
        ?? await this.provisionTenantBillingAccount(tenant.ownerUserId, tenant.id);
      const projection = await this.projectAnchoredBalanceCaches(tenant.ownerUserId, {
        tenantId: tenant.id,
        billingAccountId,
      });
      if (projection.snapshot) {
        return this.toWorkspaceBalanceReport(tenant.id, projection.snapshot);
      }
    }
    throw new ConflictException('账务主体绑定已变更，请重试');
  }

  async getBalanceReportForUser(
    userId: string,
    subject: BillingSubjectOptions = {},
  ): Promise<WorkspaceBalanceReport> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      const billingSubject = await this.requireTenantSubject(userId, subject);
      const projection = await this.projectAnchoredBalanceCaches(userId, billingSubject);
      if (projection.snapshot) {
        return this.toWorkspaceBalanceReport(billingSubject.tenantId, projection.snapshot);
      }
    }
    throw new ConflictException('账务主体绑定已变更，请重试');
  }

  async updateWorkspaceAllowance(
    tenantId: string,
    allowanceCents: number | null,
  ): Promise<WorkspaceBalanceReport> {
    // 0 / null /「不限制」同义：不写入数值上限，消费只受账户余额约束。
    const allowanceUsd = allowanceCents == null || allowanceCents === 0
      ? null
      : centsToUsd(allowanceCents);
    const preflightTenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, ownerUserId: true, billingAccountId: true },
    });
    if (!preflightTenant) {
      throw new BadRequestException('账务所属工作区不存在');
    }
    // Account lifecycle is committed before the management transaction. The
    // transaction below is deliberately existing-only and shares the same
    // wallet -> account -> tenant order as financial mutations.
    const provisionedBillingAccountId = preflightTenant.billingAccountId
      ?? await this.provisionTenantBillingAccount(preflightTenant.ownerUserId, tenantId);
    const subject = await this.prisma.$transaction(async (db) => {
      const walletRows = await db.$queryRaw<Array<{ billing_account_id: string }>>`
        SELECT "billing_account_id"
        FROM "account_wallets"
        WHERE "billing_account_id" = ${provisionedBillingAccountId}
        FOR UPDATE
      `;
      if (walletRows.length !== 1) {
        throw this.billingAccountNotProvisioned();
      }
      await db.$queryRaw`
        SELECT "id"
        FROM "billing_accounts"
        WHERE "id" = ${provisionedBillingAccountId}
        FOR UPDATE
      `;
      await db.$queryRaw`
        SELECT "id"
        FROM "tenants"
        WHERE "id" = ${tenantId}
        FOR UPDATE
      `;
      const tenant = await db.tenant.findUnique({
        where: { id: tenantId },
        select: { id: true, ownerUserId: true, billingAccountId: true },
      });
      if (!tenant) {
        throw new BadRequestException('账务所属工作区不存在');
      }
      const billingAccountId = tenant.billingAccountId;
      if (!billingAccountId || billingAccountId !== provisionedBillingAccountId) {
        throw new ConflictException('账务主体绑定已变更，请重试');
      }
      const beforeKeyBalanceFunding = await this.captureKeyBalanceFundingState(
        tenant.ownerUserId,
        { tenantId: tenant.id, billingAccountId },
        db,
      );
      await db.tenant.update({
        where: { id: tenant.id },
        data: { balanceAllowanceUsd: allowanceUsd },
      });
      return {
        userId: tenant.ownerUserId,
        tenantId: tenant.id,
        billingAccountId,
        beforeKeyBalanceFunding,
      };
    });

    const projection = await this.projectAnchoredBalanceCaches(subject.userId, subject);
    if (!projection.snapshot) {
      this.scheduleKeyBalanceSync(subject.userId, subject.tenantId, subject.billingAccountId);
      return this.getWorkspaceBalanceReport(subject.tenantId);
    }
    this.scheduleKeyBalanceSyncWhenFundingStateChanges(
      subject.beforeKeyBalanceFunding,
      projection.snapshot,
    );
    return this.toWorkspaceBalanceReport(subject.tenantId, projection.snapshot);
  }

  // Probe delegate. Called several times per settlement (deduct alone takes
  // three snapshots), so `count` in the stage line matters as much as the time.
  private async getWorkspaceBalanceSnapshot(
    userId: string,
    subject: BillingAccountSubjectRef,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
    financialNow: Date = new Date(),
    historicalCreditPolicyAt?: Date,
    historicalCreditPolicyWindow?: EnterpriseCreditPolicyWindow,
  ): Promise<WorkspaceBalanceSnapshot> {
    return timed('wsSnapshot', () => this.getWorkspaceBalanceSnapshotInner(
      userId,
      subject,
      db,
      financialNow,
      historicalCreditPolicyAt,
      historicalCreditPolicyWindow,
    ));
  }

  private async getWorkspaceBalanceSnapshotInner(
    userId: string,
    subject: BillingAccountSubjectRef,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
    financialNow: Date = new Date(),
    historicalCreditPolicyAt?: Date,
    historicalCreditPolicyWindow?: EnterpriseCreditPolicyWindow,
  ): Promise<WorkspaceBalanceSnapshot> {
    const wallet = await this.requireAccountWallet(db, subject);
    const [tenant, account] = await Promise.all([
      db.tenant.findUnique({
        where: { id: subject.tenantId },
        select: {
          balanceAllowanceUsd: true,
          balanceAllowanceUsedUsd: true,
        },
      }),
      db.billingAccount.findUnique({
        where: { id: subject.billingAccountId },
        select: {
          type: true,
          currency: true,
          creditConfig: {
            select: {
              limitUsd: true,
              status: true,
              termsDays: true,
              effectiveAt: true,
              expiresAt: true,
              policyRevision: true,
              policyEffectiveBoundaryAt: true,
              policyBoundaryComplete: true,
              createdAt: true,
              updatedAt: true,
            },
          },
        },
      }),
    ]);
    if (!account) {
      throw new BadRequestException('账务账户不存在');
    }
    if (!tenant) {
      throw new BadRequestException('账务所属工作区不存在');
    }

    const accountBalanceUsd = usd(wallet?.balanceUsd ?? 0);
    const creditPolicy = historicalCreditPolicyWindow
      ? await this.resolveEnterpriseCreditPolicyWindow(
          db,
          subject.billingAccountId,
          account.type,
          account.creditConfig,
          financialNow,
          historicalCreditPolicyWindow,
        )
      : await this.resolveEnterpriseCreditPolicy(
          db,
          subject.billingAccountId,
          account.type,
          account.creditConfig,
          financialNow,
          historicalCreditPolicyAt,
        );
    const creditLimitUsd = this.activeEnterpriseCreditLimitUsd(
      account.type,
      creditPolicy.config,
      creditPolicy.policyAt,
    );
    const creditUsedUsd = account.type === ENTERPRISE_ACCOUNT_TYPE && accountBalanceUsd.lt(0)
      ? this.minUsd(creditLimitUsd, accountBalanceUsd.abs())
      : new Prisma.Decimal(0);
    const creditRemainingUsd = this.maxUsd(new Prisma.Decimal(0), creditLimitUsd.minus(creditUsedUsd));
    const accountAvailableBalanceUsd = accountBalanceUsd.plus(creditLimitUsd);
    const allowanceUsd = tenant.balanceAllowanceUsd == null ? null : usd(tenant.balanceAllowanceUsd);
    const allowanceUsedUsd = usd(tenant.balanceAllowanceUsedUsd);
    const allowanceRemainingUsd = this.workspaceAllowanceRemainingUsd(allowanceUsd, allowanceUsedUsd);
    const workspaceBalanceUsd = allowanceRemainingUsd === null
      ? accountAvailableBalanceUsd
      : this.minUsd(accountAvailableBalanceUsd, allowanceRemainingUsd);

    return {
      workspaceBalanceUsd,
      accountBalanceUsd,
      accountAvailableBalanceUsd,
      billingAccountType: account.type,
      currency: account.currency,
      creditLimitUsd,
      creditUsedUsd,
      creditRemainingUsd,
      creditStatus: creditPolicy.config?.status ?? null,
      creditTermsDays: creditPolicy.config?.termsDays ?? null,
      creditEffectiveAt: creditPolicy.config?.effectiveAt ?? null,
      creditExpiresAt: creditPolicy.config?.expiresAt ?? null,
      creditPolicyAt: creditPolicy.policyAt,
      creditPolicyEventId: creditPolicy.policyEventId,
      creditPolicyRevision: creditPolicy.policyRevision,
      creditPolicySource: creditPolicy.source,
      creditPolicyReconstructible: creditPolicy.reconstructible,
      creditPolicyCurrentPrepaidProven:
        creditPolicy.currentPrepaidProven === true,
      creditConfiguredLimitUsd: creditPolicy.config
        ? this.maxUsd(usd(0), usd(creditPolicy.config.limitUsd))
        : usd(0),
      allowanceUsd,
      allowanceUsedUsd,
      allowanceRemainingUsd,
    };
  }

  /**
   * Resolve enterprise credit at the request's occurrence time using a
   * post-commit visibility boundary, never created_at/updated_at. Each policy
   * mutation has two database clocks: decisionAt (under aggregate locks in the
   * mutation transaction) and effectiveBoundaryAt (under the same locks in a
   * later transaction). The interval between them is deliberately unknown and
   * therefore receives zero credit. This is conservative, but it proves a
   * delayed request can never borrow credit that was not yet commit-visible.
   */
  private async resolveEnterpriseCreditPolicy(
    db: Prisma.TransactionClient | PrismaService,
    billingAccountId: string,
    accountType: string,
    currentConfig: (EnterpriseCreditPolicyConfig & {
      policyRevision: number;
      policyEffectiveBoundaryAt: Date | null;
      policyBoundaryComplete: boolean;
      createdAt: Date;
      updatedAt: Date;
    }) | null,
    financialNow: Date,
    historicalPolicyAt?: Date,
  ): Promise<EnterpriseCreditPolicyResolution> {
    if (accountType !== ENTERPRISE_ACCOUNT_TYPE) {
      return {
        config: null,
        policyAt: historicalPolicyAt ?? financialNow,
        policyEventId: null,
        policyRevision: null,
        source: 'NOT_APPLICABLE',
        reconstructible: true,
      };
    }
    if (!historicalPolicyAt) {
      return {
        config: currentConfig,
        policyAt: financialNow,
        policyEventId: null,
        policyRevision: currentConfig?.policyRevision ?? null,
        source: currentConfig ? 'CURRENT_CONFIG' : 'NO_CONFIG',
        reconstructible: true,
      };
    }

    // A revision without a confirmed second-transaction boundary makes the
    // current config unusable for historical settlement. A retry or the next
    // serialized mutation can safely finish that same revision first.
    const incompleteBoundary = await db.billingAccountCreditEvent.findFirst({
      where: {
        billingAccountId,
        policyRevision: { not: null },
        policyBoundaryComplete: false,
      },
      orderBy: [{ policyRevision: 'desc' }, { id: 'desc' }],
      select: { id: true },
    });
    if (incompleteBoundary) {
      return this.unavailableEnterpriseCreditPolicy(historicalPolicyAt);
    }

    // Even after confirmation, occurrence inside the decision/visibility gap
    // is not assigned either side of the policy change.
    const overlappingBoundary = await db.billingAccountCreditEvent.findFirst({
      where: {
        billingAccountId,
        policyBoundaryComplete: true,
        policyDecisionAt: { lte: historicalPolicyAt },
        policyEffectiveBoundaryAt: { gt: historicalPolicyAt },
      },
      select: { id: true },
    });
    if (overlappingBoundary) {
      return this.unavailableEnterpriseCreditPolicy(historicalPolicyAt);
    }

    const futureBoundary = await db.billingAccountCreditEvent.findFirst({
      where: {
        billingAccountId,
        policyBoundaryComplete: true,
        policyDecisionAt: { gt: historicalPolicyAt },
      },
      orderBy: [{ policyDecisionAt: 'asc' }, { policyRevision: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        policyRevision: true,
        oldLimitUsd: true,
        oldStatus: true,
        oldTermsDays: true,
        oldEffectiveAt: true,
        oldExpiresAt: true,
        temporalSnapshotComplete: true,
      },
    });
    if (futureBoundary) {
      if (!futureBoundary.temporalSnapshotComplete || futureBoundary.policyRevision === null) {
        return this.unavailableEnterpriseCreditPolicy(historicalPolicyAt);
      }
      // Revision 1 has no earlier trusted boundary. Its null old snapshot can
      // prove an initial grant did not exist; a non-null legacy state cannot
      // prove which older revision applied at an arbitrary occurrence time.
      if (futureBoundary.policyRevision === 1 && futureBoundary.oldStatus !== null) {
        return this.unavailableEnterpriseCreditPolicy(historicalPolicyAt);
      }
      if (futureBoundary.oldStatus === null) {
        if (
          futureBoundary.oldLimitUsd !== null
          || futureBoundary.oldTermsDays !== null
          || futureBoundary.oldEffectiveAt !== null
          || futureBoundary.oldExpiresAt !== null
        ) {
          return this.unavailableEnterpriseCreditPolicy(historicalPolicyAt);
        }
        return {
          config: null,
          policyAt: historicalPolicyAt,
          policyEventId: futureBoundary.id,
          policyRevision: 0,
          source: 'NO_CONFIG',
          reconstructible: true,
        };
      }
      if (futureBoundary.oldLimitUsd === null) {
        return this.unavailableEnterpriseCreditPolicy(historicalPolicyAt);
      }
      return {
        config: {
          limitUsd: futureBoundary.oldLimitUsd,
          status: futureBoundary.oldStatus,
          termsDays: futureBoundary.oldTermsDays,
          effectiveAt: futureBoundary.oldEffectiveAt,
          expiresAt: futureBoundary.oldExpiresAt,
        },
        policyAt: historicalPolicyAt,
        policyEventId: futureBoundary.id,
        policyRevision: futureBoundary.policyRevision - 1,
        source: 'EVENT_OLD_STATE',
        reconstructible: true,
      };
    }

    const latestBoundary = await db.billingAccountCreditEvent.findFirst({
      where: {
        billingAccountId,
        policyBoundaryComplete: true,
        policyEffectiveBoundaryAt: { lte: historicalPolicyAt },
      },
      orderBy: [{ policyRevision: 'desc' }, { id: 'desc' }],
      select: {
        id: true,
        policyRevision: true,
        policyEffectiveBoundaryAt: true,
        newLimitUsd: true,
        newStatus: true,
        newTermsDays: true,
        newEffectiveAt: true,
        newExpiresAt: true,
        temporalSnapshotComplete: true,
      },
    });
    if (latestBoundary) {
      if (
        !latestBoundary.temporalSnapshotComplete
        || latestBoundary.policyRevision === null
        || !currentConfig
        || currentConfig.policyRevision !== latestBoundary.policyRevision
        || !currentConfig.policyBoundaryComplete
        || !(currentConfig.policyEffectiveBoundaryAt instanceof Date)
        || !(latestBoundary.policyEffectiveBoundaryAt instanceof Date)
        || currentConfig.policyEffectiveBoundaryAt.getTime()
          !== latestBoundary.policyEffectiveBoundaryAt.getTime()
        || !usd(currentConfig.limitUsd).equals(usd(latestBoundary.newLimitUsd))
        || currentConfig.status !== latestBoundary.newStatus
        || currentConfig.termsDays !== latestBoundary.newTermsDays
        || !this.sameNullableDate(currentConfig.effectiveAt, latestBoundary.newEffectiveAt)
        || !this.sameNullableDate(currentConfig.expiresAt, latestBoundary.newExpiresAt)
      ) {
        return this.unavailableEnterpriseCreditPolicy(historicalPolicyAt);
      }
      return {
        config: {
          limitUsd: latestBoundary.newLimitUsd,
          status: latestBoundary.newStatus,
          termsDays: latestBoundary.newTermsDays,
          effectiveAt: latestBoundary.newEffectiveAt,
          expiresAt: latestBoundary.newExpiresAt,
        },
        policyAt: historicalPolicyAt,
        policyEventId: latestBoundary.id,
        policyRevision: latestBoundary.policyRevision,
        source: 'EVENT_NEW_STATE',
        reconstructible: true,
      };
    }

    if (!currentConfig) {
      return {
        config: null,
        policyAt: historicalPolicyAt,
        policyEventId: null,
        policyRevision: null,
        source: 'NO_CONFIG',
        reconstructible: true,
      };
    }
    // Revision 0 and any current row lacking a confirmed event are legacy,
    // unproven history. The delivered usage is still recorded as DEBT_OPEN.
    if (
      currentConfig.policyRevision <= 0
      || !(currentConfig.createdAt instanceof Date)
      || !(currentConfig.updatedAt instanceof Date)
    ) {
      return this.unavailableEnterpriseCreditPolicy(historicalPolicyAt);
    }
    return this.unavailableEnterpriseCreditPolicy(historicalPolicyAt);
  }

  private unavailableEnterpriseCreditPolicy(
    policyAt: Date,
  ): EnterpriseCreditPolicyResolution {
    return {
      config: null,
      policyAt,
      policyEventId: null,
      policyRevision: null,
      source: 'HISTORY_UNAVAILABLE',
      reconstructible: false,
    };
  }

  private async resolveEnterpriseCreditPolicyWindow(
    db: Prisma.TransactionClient | PrismaService,
    billingAccountId: string,
    accountType: string,
    currentConfig: (EnterpriseCreditPolicyConfig & {
      policyRevision: number;
      policyEffectiveBoundaryAt: Date | null;
      policyBoundaryComplete: boolean;
      createdAt: Date;
      updatedAt: Date;
    }) | null,
    financialNow: Date,
    window: EnterpriseCreditPolicyWindow,
  ): Promise<EnterpriseCreditPolicyResolution> {
    if (
      accountType === ENTERPRISE_ACCOUNT_TYPE
      && (
        currentConfig === null
        || currentConfig.status === ENTERPRISE_CREDIT_STATUS_DISABLED
        || currentConfig.status === ENTERPRISE_CREDIT_STATUS_SUSPENDED
      )
    ) {
      // The current locked configuration is the business authority for whether
      // this account may borrow at all. Missing, DISABLED or SUSPENDED means the
      // enterprise follows the same zero-credit prepaid path as a personal
      // account; historical events neither enable nor block current borrowing.
      return {
        config: null,
        policyAt: window.kind === 'BOUNDED' ? window.latestAt : window.policyAt,
        policyEventId: null,
        policyRevision: null,
        source: 'CURRENT_PREPAID',
        reconstructible: true,
        currentPrepaidProven: true,
      };
    }
    if (window.kind === 'UNAVAILABLE') {
      if (accountType !== ENTERPRISE_ACCOUNT_TYPE) {
        return this.resolveEnterpriseCreditPolicy(
          db,
          billingAccountId,
          accountType,
          currentConfig,
          financialNow,
          window.policyAt,
        );
      }
      return this.unavailableEnterpriseCreditPolicy(window.policyAt);
    }
    const { earliestAt, latestAt } = window;
    if (
      !(earliestAt instanceof Date)
      || !(latestAt instanceof Date)
      || Number.isNaN(earliestAt.getTime())
      || Number.isNaN(latestAt.getTime())
      || earliestAt.getTime() > latestAt.getTime()
    ) {
      this.recordGatewayCreditPolicyWindowUnavailable('invalid_window');
      return this.unavailableEnterpriseCreditPolicy(latestAt);
    }
    const earliest = await this.resolveEnterpriseCreditPolicy(
      db,
      billingAccountId,
      accountType,
      currentConfig,
      financialNow,
      earliestAt,
    );
    const latest = earliestAt.getTime() === latestAt.getTime()
      ? earliest
      : await this.resolveEnterpriseCreditPolicy(
          db,
          billingAccountId,
          accountType,
          currentConfig,
          financialNow,
          latestAt,
        );
    if (
      !earliest.reconstructible
      || !latest.reconstructible
    ) {
      this.recordGatewayCreditPolicyWindowUnavailable('history_unavailable');
      return this.unavailableEnterpriseCreditPolicy(latestAt);
    }
    if (
      earliest.policyRevision !== latest.policyRevision
      || !this.sameEnterpriseCreditPolicyConfig(earliest.config, latest.config)
    ) {
      this.recordGatewayCreditPolicyWindowUnavailable('window_crosses_policy');
      return this.unavailableEnterpriseCreditPolicy(latestAt);
    }
    if (latest.config) {
      const earliestLimit = this.activeEnterpriseCreditLimitUsd(
        accountType,
        latest.config,
        earliestAt,
      );
      const latestLimit = this.activeEnterpriseCreditLimitUsd(
        accountType,
        latest.config,
        latestAt,
      );
      // effectiveAt/expiresAt must not cross the possible occurrence window.
      // Zero at both ends remains a safe no-credit decision; a changing limit
      // means the request could have observed either policy and must fail shut.
      if (!earliestLimit.equals(latestLimit)) {
        this.recordGatewayCreditPolicyWindowUnavailable('window_crosses_policy');
        return this.unavailableEnterpriseCreditPolicy(latestAt);
      }
    }
    return {
      ...latest,
      // Freeze the latest possible occurrence so termsDays never creates an
      // earlier due date merely because the Gateway/Billing clocks are fuzzy.
      policyAt: latestAt,
    };
  }

  private sameEnterpriseCreditPolicyConfig(
    left: EnterpriseCreditPolicyConfig | null,
    right: EnterpriseCreditPolicyConfig | null,
  ): boolean {
    if (left === null || right === null) return left === right;
    return usd(left.limitUsd).equals(usd(right.limitUsd))
      && left.status === right.status
      && left.termsDays === right.termsDays
      && this.sameNullableDate(left.effectiveAt, right.effectiveAt)
      && this.sameNullableDate(left.expiresAt, right.expiresAt);
  }

  private isProvenCurrentPrepaidPolicy(
    snapshot: WorkspaceBalanceSnapshot,
  ): boolean {
    return snapshot.creditPolicyCurrentPrepaidProven
      && snapshot.creditPolicySource === 'CURRENT_PREPAID'
      && snapshot.creditPolicyReconstructible
      && snapshot.creditPolicyEventId === null
      && snapshot.creditPolicyRevision === null
      && snapshot.creditStatus === null
      && snapshot.creditTermsDays === null
      && snapshot.creditEffectiveAt === null
      && snapshot.creditExpiresAt === null
      && snapshot.creditConfiguredLimitUsd.eq(0)
      && snapshot.creditLimitUsd.eq(0)
      && snapshot.creditUsedUsd.eq(0)
      && snapshot.creditRemainingUsd.eq(0);
  }

  private resolveGatewayCreditPolicyWindow(occurrence: {
    gatewayStartAt: Date;
    firstReceivedAt: Date;
  }): EnterpriseCreditPolicyWindow {
    const unavailable = (
      reason: GatewayCreditPolicyWindowFailureReason,
      policyAt: Date,
    ): EnterpriseCreditPolicyWindow => {
      this.recordGatewayCreditPolicyWindowUnavailable(reason);
      return { kind: 'UNAVAILABLE', policyAt, reason };
    };
    const gatewayStartAt = occurrence.gatewayStartAt;
    const firstReceivedAt = occurrence.firstReceivedAt;
    const fallbackPolicyAt = firstReceivedAt instanceof Date
      && !Number.isNaN(firstReceivedAt.getTime())
      ? firstReceivedAt
      : new Date(0);
    if (
      !(gatewayStartAt instanceof Date)
      || !(firstReceivedAt instanceof Date)
      || Number.isNaN(gatewayStartAt.getTime())
      || Number.isNaN(firstReceivedAt.getTime())
    ) {
      return unavailable('invalid_occurrence', fallbackPolicyAt);
    }
    const rawSkew = this.config?.get<string | number>('BILLING_GATEWAY_CLOCK_MAX_SKEW_MS')
      ?? process.env.BILLING_GATEWAY_CLOCK_MAX_SKEW_MS;
    if (rawSkew === undefined || rawSkew === null || String(rawSkew).trim() === '') {
      return unavailable('not_configured', firstReceivedAt);
    }
    const maxSkewMs = Number(rawSkew);
    if (
      !Number.isFinite(maxSkewMs)
      || !Number.isSafeInteger(maxSkewMs)
      || maxSkewMs <= 0
    ) {
      return unavailable('invalid', firstReceivedAt);
    }
    const earliestMs = gatewayStartAt.getTime() - maxSkewMs;
    const latestMs = Math.min(
      gatewayStartAt.getTime() + maxSkewMs,
      firstReceivedAt.getTime(),
    );
    if (
      !Number.isFinite(earliestMs)
      || !Number.isFinite(latestMs)
      || earliestMs > latestMs
    ) {
      return unavailable(
        gatewayStartAt.getTime() - maxSkewMs > firstReceivedAt.getTime()
          ? 'fast_out_of_bounds'
          : 'empty_window',
        firstReceivedAt,
      );
    }
    return {
      kind: 'BOUNDED',
      earliestAt: new Date(earliestMs),
      latestAt: new Date(latestMs),
    };
  }

  private recordGatewayCreditPolicyWindowUnavailable(
    reason: GatewayCreditPolicyWindowFailureReason,
  ): void {
    gatewayCreditPolicyWindowUnavailableTotal.inc({ reason });
    if (!this.gatewayClockWindowWarnings.has(reason)) {
      this.gatewayClockWindowWarnings.add(reason);
      this.logger.warn(`enterprise_credit_clock_window_unavailable reason=${reason}`);
    }
  }

  private sameNullableDate(left: Date | null, right: Date | null): boolean {
    if (left === null || right === null) return left === right;
    return left.getTime() === right.getTime();
  }

  private activeEnterpriseCreditLimitUsd(
    accountType: string,
    config: {
      limitUsd: DecimalLike;
      status: string;
      termsDays?: number | null;
      effectiveAt?: Date | null;
      expiresAt?: Date | null;
    } | null | undefined,
    now = new Date(),
  ): Prisma.Decimal {
    if (accountType !== ENTERPRISE_ACCOUNT_TYPE || !config) {
      return new Prisma.Decimal(0);
    }
    if (config.status !== ENTERPRISE_CREDIT_STATUS_ACTIVE) {
      return new Prisma.Decimal(0);
    }
    // A line without a positive contractual term is not valid credit. Keep the
    // runtime fail-closed even though the database/API also reject new invalid
    // configurations, so mixed-version or manually-corrupted rows cannot create
    // an uncollectable receivable with no due date.
    if (config.termsDays === null || config.termsDays === undefined || config.termsDays <= 0) {
      return new Prisma.Decimal(0);
    }
    if (config.effectiveAt && config.effectiveAt.getTime() > now.getTime()) {
      return new Prisma.Decimal(0);
    }
    if (config.expiresAt && config.expiresAt.getTime() <= now.getTime()) {
      return new Prisma.Decimal(0);
    }
    const limitUsd = usd(config.limitUsd);
    return limitUsd.gt(0) ? limitUsd : new Prisma.Decimal(0);
  }

  /**
   * Serialize every Redis projection against wallet mutations and tenant
   * rebinds. Holding wallet -> tenant SHARE locks through the Redis write means
   * an older committed request can never overwrite a newer balance, and an old
   * account can never be published under a tenant after that tenant rebinds.
   */
  private async projectAnchoredBalanceCaches(
    userId: string,
    subject: BillingAccountSubjectRef,
  ): Promise<AnchoredBalanceProjection> {
    return this.prisma.$transaction(async (db) => {
      const walletRows = await db.$queryRaw<Array<{ balance_usd: Prisma.Decimal }>>`
        SELECT "balance_usd"
        FROM "account_wallets"
        WHERE "billing_account_id" = ${subject.billingAccountId}
        FOR SHARE`;
      if (walletRows.length !== 1) {
        throw this.billingAccountNotProvisioned();
      }
      const tenantRows = await db.$queryRaw<Array<{ billing_account_id: string | null }>>`
        SELECT "billing_account_id"
        FROM "tenants"
        WHERE "id" = ${subject.tenantId}
        FOR SHARE`;
      const bindingUnchanged = tenantRows.length === 1
        && tenantRows[0].billing_account_id === subject.billingAccountId;
      if (!bindingUnchanged) {
        // This projection belongs to an account the tenant no longer points at.
        // Keep its account cache fresh, but never mutate the tenant cache: a
        // projection for the newly committed binding may already have written
        // the correct value while both readers held compatible SHARE locks.
        // The binding writer is responsible for converging the tenant key after
        // commit via syncTenantBalanceCacheForCurrentBinding().
        await this.redis.set(
          this.accountBalanceKey(subject.billingAccountId),
          usdString(walletRows[0].balance_usd),
        );
        return { bindingUnchanged: false, snapshot: null };
      }

      const snapshot = await this.getWorkspaceBalanceSnapshot(userId, subject, db);
      await this.writeBalanceCaches(
        subject,
        snapshot.workspaceBalanceUsd,
        snapshot.accountBalanceUsd,
      );
      return { bindingUnchanged: true, snapshot };
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  /**
   * Converge the legacy tenant balance cache from the tenant's committed
   * binding. Binding writers call this only after their database transaction
   * commits.
   *
   * A bound tenant reuses projectAnchoredBalanceCaches(), whose wallet ->
   * tenant SHARE locks serialize the Redis write before a later rebind can
   * commit. An unbound tenant deletes the key while holding the tenant SHARE
   * lock. Together with stale projections being tenant-key no-ops, the last
   * committed binding mutation always leaves the tenant key at its current
   * account value (or absent after detach), regardless of completion order.
   */
  async syncTenantBalanceCacheForCurrentBinding(tenantId: string): Promise<void> {
    const normalizedTenantId = tenantId.trim();
    if (!normalizedTenantId) {
      throw new BadRequestException('账务所属工作区不能为空');
    }
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: normalizedTenantId },
      select: { id: true, ownerUserId: true, billingAccountId: true },
    });
    if (tenant?.billingAccountId) {
      await this.projectAnchoredBalanceCaches(tenant.ownerUserId, {
        tenantId: tenant.id,
        billingAccountId: tenant.billingAccountId,
      });
      return;
    }

    await this.prisma.$transaction(async (db) => {
      const bindingRows = await db.$queryRaw<Array<{ billing_account_id: string | null }>>`
        SELECT "billing_account_id"
        FROM "tenants"
        WHERE "id" = ${normalizedTenantId}
        FOR SHARE`;
      if (bindingRows.length === 0 || bindingRows[0].billing_account_id === null) {
        await this.redis.del(this.legacyTenantBalanceKey(normalizedTenantId));
      }
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  private keyBalanceHasFunding(balanceUsd: Prisma.Decimal): boolean {
    return usd(balanceUsd).gt(0);
  }

  private async captureKeyBalanceFundingState(
    userId: string,
    subject: BillingAccountSubjectRef,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<KeyBalanceFundingState> {
    const snapshot = await this.getWorkspaceBalanceSnapshot(userId, subject, db);
    return this.keyBalanceFundingStateFromBalance(userId, subject, snapshot.workspaceBalanceUsd);
  }

  private keyBalanceFundingStateFromBalance(
    userId: string,
    subject: BillingAccountSubjectRef,
    balanceUsd: Prisma.Decimal,
  ): KeyBalanceFundingState {
    return {
      userId,
      tenantId: subject.tenantId,
      billingAccountId: subject.billingAccountId,
      hasBalance: this.keyBalanceHasFunding(balanceUsd),
    };
  }

  private async refreshBalanceCachesAndSyncKeyBalancesOnFundingChange(
    userId: string,
    subject: BillingAccountSubjectRef,
    before: KeyBalanceFundingState,
  ): Promise<WorkspaceBalanceSnapshot | null> {
    const projection = await this.projectAnchoredBalanceCaches(userId, subject);
    if (projection.snapshot) {
      this.scheduleKeyBalanceSyncWhenFundingStateChanges(before, projection.snapshot);
    } else {
      this.scheduleKeyBalanceSync(userId, subject.tenantId, subject.billingAccountId);
    }
    return projection.snapshot;
  }

  /**
   * A committed funding/refund transaction may be replayed after the process
   * exited between the database commit and projection delivery.  In that case
   * funding-state comparison is no longer sufficient: the "before" snapshot
   * already contains the committed transaction.  Always enqueue account-level
   * fanout, even when refreshing Redis throws, so a replay can converge every
   * downstream balance projection.
   */
  private async refreshBalanceCachesAndForceKeyBalanceSync(
    userId: string,
    subject: BillingAccountSubjectRef,
  ): Promise<void> {
    try {
      await this.projectAnchoredBalanceCaches(userId, subject);
    } catch (err) {
      // Redis is a derived projection.  Once the financial transaction is
      // committed, a replay must return that committed result even when the
      // cache is unavailable; the account fanout below remains mandatory.
      this.logger.warn(
        `committed balance replay cache refresh failed user=${userId} `
        + `tenant=${subject.tenantId} account=${subject.billingAccountId}: `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
    } finally {
      this.scheduleKeyBalanceSync(userId, subject.tenantId, subject.billingAccountId);
    }
  }

  private scheduleKeyBalanceSyncWhenFundingStateChanges(
    before: KeyBalanceFundingState,
    after: WorkspaceBalanceSnapshot | Prisma.Decimal,
  ): void {
    const afterBalanceUsd = after instanceof Prisma.Decimal
      ? after
      : after.workspaceBalanceUsd;
    if (before.hasBalance === this.keyBalanceHasFunding(afterBalanceUsd)) return;
    this.scheduleKeyBalanceSync(before.userId, before.tenantId, before.billingAccountId);
  }

  private workspaceAllowanceRemainingUsd(
    allowanceUsd: Prisma.Decimal | null,
    allowanceUsedUsd: Prisma.Decimal,
  ): Prisma.Decimal | null {
    if (allowanceUsd === null) return null;
    const remaining = allowanceUsd.minus(allowanceUsedUsd);
    return remaining.gt(0) ? remaining : new Prisma.Decimal(0);
  }

  private minUsd(left: Prisma.Decimal, right: Prisma.Decimal): Prisma.Decimal {
    return left.lte(right) ? left : right;
  }

  private maxUsd(left: Prisma.Decimal, right: Prisma.Decimal): Prisma.Decimal {
    return left.gte(right) ? left : right;
  }

  private balanceTransactionMatchesReplayFingerprint(
    transaction: PrismaBalanceTransaction,
    expected: {
      userId: string;
      subject: BillingAccountSubjectRef;
      type: PrismaTransactionType;
      amountUsd: Prisma.Decimal;
      description: string;
      orderId?: string | null;
      productId?: string | null;
      operationKey?: string | null;
    },
  ): boolean {
    return transaction.userId === expected.userId
      && transaction.tenantId === expected.subject.tenantId
      && transaction.billingAccountId === expected.subject.billingAccountId
      && transaction.type === expected.type
      && usd(transaction.amountUsd).eq(expected.amountUsd)
      && transaction.description === expected.description
      && (transaction.orderId ?? null) === (expected.orderId ?? null)
      && (transaction.productId ?? null) === (expected.productId ?? null)
      // operation_key was added by the expand migration.  A NULL key is only
      // tolerated for a transaction found through the exact legacy fallback;
      // a different non-NULL key is always a conflicting request.
      && (
        expected.operationKey === undefined
        || transaction.operationKey === null
        || transaction.operationKey === expected.operationKey
      );
  }

  private balanceGrantMatchesFundingSubject(
    grant: PrismaBalanceGrant,
    expected: {
      userId: string;
      subject: BillingAccountSubjectRef;
      orderId: string;
      productId?: string | null;
    },
  ): boolean {
    return grant.userId === expected.userId
      && grant.tenantId === expected.subject.tenantId
      && grant.billingAccountId === expected.subject.billingAccountId
      && grant.orderId === expected.orderId
      && (grant.productId ?? null) === (expected.productId ?? null)
      && grant.source === BALANCE_GRANT_SOURCE_RECHARGE;
  }

  private async assertRechargeOrderFundingSubject(
    db: Prisma.TransactionClient,
    params: {
      orderId: string;
      userId: string;
      subject: BillingAccountSubjectRef;
      productId?: string | null;
    },
  ): Promise<void> {
    const order = await db.order.findFirst({
      where: {
        id: params.orderId,
        userId: params.userId,
        tenantId: params.subject.tenantId,
        billingAccountId: params.subject.billingAccountId,
        productId: params.productId ?? null,
      },
      select: { id: true },
    });
    if (!order) {
      throw new ConflictException(`BALANCE_RECHARGE_ORDER_SUBJECT_MISMATCH:${params.orderId}`);
    }
  }

  private async lockRechargeOrder(
    db: Prisma.TransactionClient,
    orderId: string,
  ): Promise<{
    userId: string;
    tenantId: string;
    billingAccountId: string | null;
    productId: string | null;
    orderType: string;
    status: OrderStatus;
  } | null> {
    await db.$queryRaw`
      SELECT "id"
      FROM "orders"
      WHERE "id" = ${orderId}
      FOR UPDATE
    `;
    return db.order.findUnique({
      where: { id: orderId },
      select: {
        userId: true,
        tenantId: true,
        billingAccountId: true,
        productId: true,
        orderType: true,
        status: true,
      },
    });
  }

  private assertRechargeOrderFulfillmentAnchor(
    order: {
      userId: string;
      tenantId: string;
      billingAccountId: string | null;
      productId: string | null;
      orderType: string;
      status: OrderStatus;
    } | null,
    userId: string,
    subject: BillingAccountSubjectRef,
    productId?: string | null,
  ): void {
    if (
      !order
      || order.orderType !== 'RECHARGE'
      || order.status !== OrderStatus.FULFILLING
      || order.userId !== userId
      || order.tenantId !== subject.tenantId
      || order.billingAccountId !== subject.billingAccountId
      || order.productId !== (productId ?? null)
    ) {
      throw new RechargeBillingSubjectChangedError();
    }
  }

  private isRechargeSubjectValidationError(
    err: unknown,
    options: RechargeWithBonusOptions,
  ): boolean {
    return Boolean(options.tenantId?.trim() && options.billingAccountId?.trim())
      && err instanceof HttpException;
  }

  private async assertRechargeBillingSubjectStillCurrent(
    db: Prisma.TransactionClient,
    userId: string,
    subject: BillingAccountSubjectRef,
  ): Promise<void> {
    try {
      const currentSubject = await this.lockProvisionedBillingSubjectMetadata(
        db,
        userId,
        subject,
      );
      this.assertBillingOwnerCapability(userId, currentSubject);
    } catch (err) {
      if (err instanceof HttpException) {
        throw new RechargeBillingSubjectChangedError();
      }
      throw err;
    }
  }

  /**
   * Continue the global financial lock order after wallet -> grants -> account.
   * The caller must already own that complete ledger lock bundle. Tenant and
   * membership rows are frozen only afterwards, then the database-backed
   * subject is resolved again without any lazy provisioning. This prevents a
   * rebind between preflight authorization and the first financial write.
   */
  private async lockProvisionedBillingSubjectMetadata(
    db: Prisma.TransactionClient,
    userId: string,
    subject: BillingAccountSubjectRef,
  ): Promise<ResolvedBillingSubject> {
    await db.$queryRaw`
      SELECT "id" FROM "tenants"
      WHERE "id" = ${subject.tenantId}
      FOR UPDATE
    `;
    await db.$queryRaw`
      SELECT "id" FROM "tenant_members"
      WHERE "tenant_id" = ${subject.tenantId}
        AND "user_id" = ${userId}
      FOR SHARE
    `;
    await db.$queryRaw`
      SELECT "id" FROM "billing_account_members"
      WHERE "billing_account_id" = ${subject.billingAccountId}
        AND "user_id" = ${userId}
      FOR SHARE
    `;
    return this.requireBillingAccountSubject(
      userId,
      {
        tenantId: subject.tenantId,
        billingAccountId: subject.billingAccountId,
      },
      db,
      { requireProvisionedBillingAccount: true },
    );
  }

  /**
   * Lock only the immutable financial target needed by a delivered Gateway
   * settlement. This deliberately does not re-authorize current membership or
   * require the tenant to remain bound to the same account: those mutable
   * relationships may legitimately change after the upstream cost occurred.
   * The caller must already have proved the anchor/reservation hashes and must
   * hold the original wallet -> grants -> account lock bundle.
   */
  private async lockFrozenGatewayBillingSubjectMetadata(
    _db: Prisma.TransactionClient,
    _userId: string,
    subject: BillingAccountSubjectRef,
  ): Promise<BillingAccountSubjectRef> {
    // wallet/grants/account were already locked by the caller. T0 anchor FKs
    // preserve user/tenant/key/product rows; re-reading mutable identity here
    // would only reintroduce the T0→T1 race this path is designed to avoid.
    return this.billingSubjectRef(subject);
  }

  private toWorkspaceBalanceReport(
    tenantId: string,
    snapshot: WorkspaceBalanceSnapshot,
  ): WorkspaceBalanceReport {
    return {
      tenantId,
      balanceCents: usdToCents(snapshot.workspaceBalanceUsd),
      balanceUsd: usdNumber(snapshot.workspaceBalanceUsd),
      accountBalanceCents: usdToCents(snapshot.accountBalanceUsd),
      accountBalanceUsd: usdNumber(snapshot.accountBalanceUsd),
      accountAvailableBalanceCents: usdToCents(snapshot.accountAvailableBalanceUsd),
      accountAvailableBalanceUsd: usdNumber(snapshot.accountAvailableBalanceUsd),
      billingAccountType: snapshot.billingAccountType,
      currency: snapshot.currency,
      creditLimitCents: usdToCents(snapshot.creditLimitUsd),
      creditLimitUsd: usdNumber(snapshot.creditLimitUsd),
      creditUsedCents: usdToCents(snapshot.creditUsedUsd),
      creditUsedUsd: usdNumber(snapshot.creditUsedUsd),
      creditRemainingCents: usdToCents(snapshot.creditRemainingUsd),
      creditRemainingUsd: usdNumber(snapshot.creditRemainingUsd),
      creditStatus: snapshot.creditStatus,
      creditTermsDays: snapshot.creditTermsDays,
      creditEffectiveAt: snapshot.creditEffectiveAt?.toISOString() ?? null,
      creditExpiresAt: snapshot.creditExpiresAt?.toISOString() ?? null,
      allowanceCents: snapshot.allowanceUsd === null ? null : usdToCents(snapshot.allowanceUsd),
      allowanceUsd: snapshot.allowanceUsd === null ? null : usdNumber(snapshot.allowanceUsd),
      allowanceUsedCents: usdToCents(snapshot.allowanceUsedUsd),
      allowanceUsedUsd: usdNumber(snapshot.allowanceUsedUsd),
      allowanceRemainingCents: snapshot.allowanceRemainingUsd === null
        ? null
        : usdToCents(snapshot.allowanceRemainingUsd),
      allowanceRemainingUsd: snapshot.allowanceRemainingUsd === null
        ? null
        : usdNumber(snapshot.allowanceRemainingUsd),
    };
  }

  async resolveSubjectForUser(
    userId: string,
    tenantId?: string | null,
    opts: ResolveBillingSubjectOptions = {},
  ): Promise<ResolvedBillingSubject> {
    const normalizedTenantId = tenantId?.trim();
    if (opts.requireExplicitTenant && !normalizedTenantId) {
      throw new BadRequestException('账务操作必须明确指定工作区 tenantId');
    }
    const resolvedTenantId = normalizedTenantId
      || await this.resolveRequiredTenantId(userId);
    if (!opts.requireProvisionedBillingAccount) {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: resolvedTenantId },
        select: { billingAccountId: true },
      });
      if (!tenant) {
        throw new BadRequestException('账务所属工作区不存在');
      }
      if (!tenant.billingAccountId) {
        await this.provisionTenantBillingAccount(userId, resolvedTenantId);
      }
    }
    return this.resolveSubjectForUserWithDb(
      this.prisma,
      userId,
      resolvedTenantId,
      { ...opts, requireProvisionedBillingAccount: true },
    );
  }

  /** Resolve a provisioned subject inside the caller's database snapshot. */
  async resolveSubjectForUserWithDb(
    db: Prisma.TransactionClient | PrismaService,
    userId: string,
    tenantId?: string | null,
    opts: ResolveBillingSubjectOptions = {},
  ): Promise<ResolvedBillingSubject> {
    const normalizedTenantId = tenantId?.trim();
    if (opts.requireExplicitTenant && !normalizedTenantId) {
      throw new BadRequestException('账务操作必须明确指定工作区 tenantId');
    }
    const subject = await this.requireBillingAccountSubject(
      userId,
      { tenantId: normalizedTenantId || await this.resolveRequiredTenantId(userId, {}, db) },
      db,
      opts,
    );
    if (opts.requireBillingRole) this.assertBillingOwnerCapability(userId, subject);
    return subject;
  }

  async resolveCodingPlanOwnerTenantId(
    userId: string,
    subject: BillingSubjectOptions = {},
    opts: ResolveBillingSubjectOptions = {},
  ): Promise<string> {
    const explicitTenantId = subject.tenantId?.trim();
    if (explicitTenantId) {
      const resolved = await this.resolveSubjectForUser(userId, explicitTenantId, opts);
      return resolved.tenantId;
    }
    return this.resolvePersonalTenantIdForUser(userId);
  }

  async resolvePersonalTenantIdForUser(userId: string): Promise<string> {
    const personalTenant = await this.prisma.tenant.findFirst({
      where: {
        ownerUserId: userId,
        type: 'personal',
        status: 'active',
        deletedAt: null,
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    if (personalTenant) return personalTenant.id;
    throw new BadRequestException('个人账号不存在，无法开通 TokenPlan');
  }

  private async resolveRequiredTenantId(
    userId: string,
    subject: BillingSubjectOptions = {},
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<string> {
    const explicitTenantId = subject.tenantId?.trim();
    if (explicitTenantId) return explicitTenantId;

    const user = await db.user.findUnique({
      where: { id: userId },
      select: { currentTenantId: true },
    });
    if (user?.currentTenantId) {
      const currentMembership = await db.tenantMember.findFirst({
        where: {
          userId,
          tenantId: user.currentTenantId,
          status: 'active',
          tenant: { status: 'active', deletedAt: null },
        },
        select: { tenantId: true },
      });
      if (currentMembership) return currentMembership.tenantId;
    }

    const personalTenant = await db.tenant.findFirst({
      where: {
        ownerUserId: userId,
        type: 'personal',
        status: 'active',
        deletedAt: null,
      },
      select: { id: true },
    });
    if (personalTenant) return personalTenant.id;

    const membership = await db.tenantMember.findFirst({
      where: {
        userId,
        status: 'active',
        tenant: { status: 'active', deletedAt: null },
      },
      select: { tenantId: true },
      orderBy: { joinedAt: 'asc' },
    });
    if (membership) return membership.tenantId;

    throw new BadRequestException('订阅和账务操作必须绑定账号 tenantId');
  }

  private async requireTenantSubject(
    userId: string,
    subject: BillingSubjectOptions = {},
  ): Promise<ResolvedBillingSubject> {
    const alreadyResolved = this.toResolvedBillingSubject(subject);
    if (alreadyResolved) {
      this.assertBillingSubjectIntegrity(userId, alreadyResolved);
      return alreadyResolved;
    }
    const tenantId = await this.resolveRequiredTenantId(userId, subject);
    // Explicitly anchored payment/refund calls must never change their subject
    // while validating it. Unanchored compatibility callers may run the
    // independent lifecycle first, then enter their financial transaction.
    if (!subject.billingAccountId?.trim()) {
      const tenant = await this.prisma.tenant.findUnique({
        where: { id: tenantId },
        select: { billingAccountId: true },
      });
      if (!tenant) {
        throw new BadRequestException('账务所属工作区不存在');
      }
      if (!tenant.billingAccountId) {
        await this.provisionTenantBillingAccount(userId, tenantId);
      }
    }
    return this.requireBillingAccountSubject(
      userId,
      { ...subject, tenantId },
      this.prisma,
      { requireProvisionedBillingAccount: true },
    );
  }

  private async requireBillingAccountSubject(
    userId: string,
    subject: BillingSubjectOptions = {},
    db: Prisma.TransactionClient | PrismaService = this.prisma,
    _opts: Pick<ResolveBillingSubjectOptions, 'requireProvisionedBillingAccount'> = {},
  ): Promise<ResolvedBillingSubject> {
    const resolvedSubject = this.toResolvedBillingSubject(subject);
    if (resolvedSubject) {
      this.assertBillingSubjectIntegrity(userId, resolvedSubject);
      return resolvedSubject;
    }

    const tenantId = await this.resolveRequiredTenantId(userId, subject, db);
    const tenant = await db.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        name: true,
        type: true,
        status: true,
        ownerUserId: true,
        billingAccountId: true,
        deletedAt: true,
      },
    });
    if (!tenant || tenant.deletedAt || tenant.status !== 'active') {
      throw new BadRequestException('账务所属工作区不存在或不可用');
    }

    const membership = await db.tenantMember.findFirst({
      where: { tenantId, userId },
      select: { role: true, status: true },
    });
    if (!membership || membership.status !== 'active') {
      throw new ForbiddenException('无权访问该团队账务');
    }

    if (!tenant.billingAccountId) {
      throw this.billingAccountNotProvisioned();
    }
    const billingAccountId = tenant.billingAccountId;
    const requestedBillingAccountId = subject.billingAccountId?.trim();
    if (requestedBillingAccountId && requestedBillingAccountId !== billingAccountId) {
      throw new ForbiddenException('无权访问该账务账号');
    }

    const billingAccount = await db.billingAccount.findUnique({
      where: { id: billingAccountId },
      select: {
        id: true,
        type: true,
        status: true,
        ownerUserId: true,
        name: true,
        deletedAt: true,
      },
    });
    if (!billingAccount || billingAccount.deletedAt) {
      throw new BadRequestException('账务账号不存在或不可用');
    }

    const billingAccountMembership = await db.billingAccountMember.findFirst({
      where: { billingAccountId, userId },
      select: { role: true, status: true },
    });

    const resolved = this.markResolvedBillingSubject({
      resolvedForUserId: userId,
      tenantId,
      tenantName: tenant.name,
      tenantType: tenant.type,
      tenantStatus: tenant.status,
      tenantOwnerUserId: tenant.ownerUserId,
      membershipRole: membership.role,
      membershipStatus: membership.status,
      billingAccountId,
      billingAccountType: billingAccount.type,
      billingAccountStatus: billingAccount.status,
      billingAccountOwnerUserId: billingAccount.ownerUserId,
      billingAccountName: billingAccount.name,
      billingAccountMembershipRole: billingAccountMembership?.role ?? null,
      billingAccountMembershipStatus: billingAccountMembership?.status ?? null,
    });
    this.assertBillingSubjectIntegrity(userId, resolved);
    return resolved;
  }

  private assertBillingSubjectIntegrity(
    userId: string,
    subject: ResolvedBillingSubject,
  ): void {
    const expectedAccountType = subject.tenantType === ENTERPRISE_ACCOUNT_TYPE
      ? ENTERPRISE_ACCOUNT_TYPE
      : 'personal';
    const isCanonicalOwner = subject.resolvedForUserId === subject.tenantOwnerUserId;
    const hasCanonicalTenantRole =
      (subject.membershipRole === TENANT_OWNER_ROLE) === isCanonicalOwner;
    const hasSupportedBillingAccountRole =
      subject.billingAccountMembershipRole === null
      || subject.billingAccountMembershipRole === TENANT_OWNER_ROLE
      || subject.billingAccountMembershipRole === 'member';
    const valid =
      subject.resolvedForUserId === userId
      && subject.tenantStatus === 'active'
      && subject.billingAccountStatus === 'active'
      && subject.membershipStatus === 'active'
      && (subject.membershipRole === TENANT_OWNER_ROLE || subject.membershipRole === 'member')
      && hasCanonicalTenantRole
      && hasSupportedBillingAccountRole
      && subject.billingAccountOwnerUserId !== null
      && subject.tenantOwnerUserId === subject.billingAccountOwnerUserId
      && subject.billingAccountType === expectedAccountType;
    if (!valid) {
      throw new ConflictException('账务主体配置不一致，已停止账务访问');
    }
  }

  private assertBillingOwnerCapability(
    userId: string,
    subject: ResolvedBillingSubject,
  ): void {
    this.assertBillingSubjectIntegrity(userId, subject);
    if (!this.hasBillingOwnerCapability(userId, subject)) {
      throw new ForbiddenException('无权访问该团队账务');
    }
  }

  private hasBillingOwnerCapability(
    userId: string,
    subject: ResolvedBillingSubject,
  ): boolean {
    return subject.membershipRole === TENANT_OWNER_ROLE
      && subject.tenantOwnerUserId === userId
      && subject.billingAccountOwnerUserId === userId
      && subject.billingAccountMembershipRole === TENANT_OWNER_ROLE
      && subject.billingAccountMembershipStatus === 'active';
  }

  /**
   * Complete personal-account lifecycle in its own committed transaction.
   *
   * The account id advisory lock serializes same-owner workspaces before any
   * tenant row is locked. If the account is new, account + owner membership +
   * wallet remain invisible until the tenant binding commits. If it already
   * exists, the wallet must already exist and is locked before account and
   * tenant rows; a missing wallet is corruption, never an invitation to repair
   * infrastructure from a financial request.
   */
  private async provisionTenantBillingAccount(
    userId: string,
    tenantId: string,
  ): Promise<string> {
    const preflight = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        id: true,
        type: true,
        ownerUserId: true,
        billingAccountId: true,
      },
    });
    if (!preflight) {
      throw new BadRequestException('账务所属工作区不存在');
    }
    if (preflight.billingAccountId) return preflight.billingAccountId;

    if (preflight.type === 'enterprise') {
      const mode = this.enterpriseFallbackMode();
      if (mode === 'fail') {
        throw new HttpException(
          {
            code: 'enterprise_fallback_forbidden',
            message: '企业工作区尚未开通企业账户，无法继续账务操作',
          },
          409,
        );
      }
      this.logger.warn(
        `enterprise tenant without billing account fell back to personal (mode=warn) tenant=${tenantId}`,
      );
    }

    const ownerUserId = preflight.ownerUserId || userId;
    const billingAccountId = this.personalBillingAccountId(ownerUserId);
    const currency = await this.platformCurrencyCode();

    return this.prisma.$transaction(async (db) => {
      await db.$queryRaw`
        SELECT pg_advisory_xact_lock(
          hashtextextended(${billingAccountId}, 0::BIGINT)
        )::TEXT AS "advisoryLock"
      `;

      // Re-read after advisory serialization. No tenant row lock is taken
      // until the wallet/account side of the global lock order is complete.
      const tenant = await db.tenant.findUnique({
        where: { id: tenantId },
        select: {
          id: true,
          name: true,
          type: true,
          status: true,
          ownerUserId: true,
          billingAccountId: true,
          deletedAt: true,
        },
      });
      if (!tenant || tenant.deletedAt || tenant.status !== 'active') {
        throw new BadRequestException('账务所属工作区不存在或不可用');
      }
      const membership = await db.tenantMember.findFirst({
        where: { tenantId, userId },
        select: { role: true, status: true },
      });
      if (!membership || membership.status !== 'active') {
        throw new ForbiddenException('无权访问该团队账务');
      }
      if (tenant.billingAccountId) return tenant.billingAccountId;
      if (tenant.ownerUserId !== ownerUserId || tenant.type !== preflight.type) {
        throw new ConflictException('账务主体配置已变更，请重试');
      }

      const owner = await db.user.findUnique({
        where: { id: ownerUserId },
        select: { email: true, nickname: true, isActive: true, createdAt: true },
      });
      const accountStatus = owner?.isActive === false ? 'suspended' : 'active';
      const existingAccount = await db.billingAccount.findUnique({
        where: { id: billingAccountId },
        select: { id: true, currency: true },
      });

      if (!existingAccount) {
        // A new account has no externally reachable tenant binding until this
        // transaction commits, so its rows may be created before tenant lock.
        await db.billingAccount.create({
          data: {
            id: billingAccountId,
            type: 'personal',
            name: owner?.nickname || owner?.email || tenant.name || 'Personal account',
            ownerUserId,
            status: accountStatus,
            currency,
            balanceGrantLedgerStatus: BALANCE_GRANT_LEDGER_STATUS_RECONCILED,
            balanceGrantLedgerVersion: BALANCE_GRANT_LEDGER_VERSION,
            balanceGrantLedgerHash: 'EMPTY_V2',
            balanceGrantLedgerReconciledAt: new Date(),
            createdAt: owner?.createdAt ?? new Date(),
          },
        });
        await db.accountWallet.create({
          data: { billingAccountId, balanceUsd: new Prisma.Decimal(0) },
        });
        await db.billingAccountMember.create({
          data: {
            id: `bam_personal_${ownerUserId}`,
            billingAccountId,
            userId: ownerUserId,
            role: 'owner',
            status: accountStatus === 'active' ? 'active' : 'inactive',
          },
        });
      } else {
        this.assertBillingAccountCurrencyMatches(existingAccount.currency, currency);
        const walletRows = await db.$queryRaw<Array<{ billing_account_id: string }>>`
          SELECT "billing_account_id"
          FROM "account_wallets"
          WHERE "billing_account_id" = ${billingAccountId}
          FOR UPDATE
        `;
        if (walletRows.length !== 1) {
          throw this.billingAccountNotProvisioned();
        }
        await db.$queryRaw`
          SELECT "id"
          FROM "billing_accounts"
          WHERE "id" = ${billingAccountId}
          FOR UPDATE
        `;
        const lockedAccount = await db.billingAccount.findUnique({
          where: { id: billingAccountId },
          select: {
            type: true,
            ownerUserId: true,
            status: true,
            currency: true,
            deletedAt: true,
          },
        });
        if (
          !lockedAccount
          || lockedAccount.deletedAt
          || lockedAccount.type !== 'personal'
          || lockedAccount.ownerUserId !== ownerUserId
        ) {
          throw new ConflictException('账务主体配置不一致，已停止账务访问');
        }
        this.assertBillingAccountCurrencyMatches(lockedAccount.currency, currency);
      }

      await db.$queryRaw`
        SELECT "id"
        FROM "tenants"
        WHERE "id" = ${tenantId}
        FOR UPDATE
      `;
      await db.$queryRaw`
        SELECT "id"
        FROM "tenant_members"
        WHERE "tenant_id" = ${tenantId}
          AND "user_id" = ${userId}
        FOR SHARE
      `;
      const accountMembershipRows = await db.$queryRaw<Array<{ id: string }>>`
        SELECT "id"
        FROM "billing_account_members"
        WHERE "billing_account_id" = ${billingAccountId}
          AND "user_id" = ${ownerUserId}
        FOR UPDATE
      `;

      const [lockedTenant, lockedMembership] = await Promise.all([
        db.tenant.findUnique({
          where: { id: tenantId },
          select: { ownerUserId: true, billingAccountId: true, status: true, deletedAt: true },
        }),
        db.tenantMember.findFirst({
          where: { tenantId, userId },
          select: { status: true },
        }),
      ]);
      if (
        !lockedTenant
        || lockedTenant.deletedAt
        || lockedTenant.status !== 'active'
        || lockedTenant.ownerUserId !== ownerUserId
        || !lockedMembership
        || lockedMembership.status !== 'active'
      ) {
        throw new ConflictException('账务主体配置已变更，请重试');
      }
      if (
        lockedTenant.billingAccountId
        && lockedTenant.billingAccountId !== billingAccountId
      ) {
        throw new ConflictException('账务主体绑定已变更，请重试');
      }

      if (existingAccount) {
        const ownerAccountMembership = accountMembershipRows.length === 1
          ? await db.billingAccountMember.findUnique({
            where: {
              billingAccountId_userId: { billingAccountId, userId: ownerUserId },
            },
            select: { role: true, status: true },
          })
          : null;
        const expectedMemberStatus = accountStatus === 'active' ? 'active' : 'inactive';
        if (
          !ownerAccountMembership
          || ownerAccountMembership.role !== 'owner'
          || ownerAccountMembership.status !== expectedMemberStatus
        ) {
          throw this.billingAccountNotProvisioned();
        }
      }
      if (!lockedTenant.billingAccountId) {
        await db.tenant.update({
          where: { id: tenantId },
          data: { billingAccountId },
        });
      }
      return billingAccountId;
    }, { maxWait: 10_000, timeout: 30_000 });
  }

  private async platformCurrencyCode(): Promise<string> {
    const platformConfig = await this.systemConfig?.getDeploymentConfig();
    return resolvePlatformCurrency(this.config, platformConfig).currencyCode;
  }

  private assertBillingAccountCurrencyMatches(
    persistedCurrency: string,
    deploymentCurrency: string,
  ): void {
    if (
      persistedCurrency.trim().toUpperCase()
      === deploymentCurrency.trim().toUpperCase()
    ) return;
    throw new ConflictException({
      code: 'billing_account_currency_migration_required',
      message: '账务账号币种与当前部署不一致，必须停写并排空待结算后执行专用币种迁移',
    });
  }

  private async requireAccountWallet(
    db: Prisma.TransactionClient | PrismaService,
    subject: BillingAccountSubjectRef,
  ) {
    const existingWallet = await db.accountWallet.findUnique({
      where: { billingAccountId: subject.billingAccountId },
      select: { billingAccountId: true, balanceUsd: true },
    });
    if (existingWallet) return existingWallet;
    throw this.billingAccountNotProvisioned();
  }

  private async incrementAccountWallet(
    db: Prisma.TransactionClient,
    _userId: string,
    subject: BillingAccountSubjectRef,
    amountUsd: Prisma.Decimal,
  ) {
    await this.requireAccountWallet(db, subject);
    return db.accountWallet.update({
      where: { billingAccountId: subject.billingAccountId },
      data: { balanceUsd: { increment: amountUsd } },
    });
  }

  private async consumeWorkspaceAllowance(
    db: Prisma.TransactionClient,
    subject: BillingAccountSubjectRef,
    amountUsd: Prisma.Decimal,
    allowNegativeBalance = false,
  ): Promise<boolean> {
    const limitPredicate = allowNegativeBalance
      ? Prisma.sql`TRUE`
      : Prisma.sql`"balance_allowance_usd" IS NULL
          OR "balance_allowance_used_usd" + ${amountUsd} <= "balance_allowance_usd"`;
    const updated = await db.$executeRaw`
      UPDATE "tenants"
      SET "balance_allowance_used_usd" = "balance_allowance_used_usd" + ${amountUsd}
      WHERE "id" = ${subject.tenantId}
        AND (${limitPredicate})
    `;
    return Number(updated) > 0;
  }

  private getRechargeExpiresAt(now = new Date()): Date {
    const expiresAt = new Date(now);
    expiresAt.setUTCDate(expiresAt.getUTCDate() + RECHARGE_VALIDITY_DAYS);
    return expiresAt;
  }

  /**
   * Capture the only clock allowed to timestamp or decide a wallet-serialized
   * financial mutation. Callers invoke this after acquiring the wallet row
   * lock, then pass the returned instant through every ledger/audit write.
   */
  private async captureFinancialNow(
    db: Prisma.TransactionClient,
    billingAccountId: string,
    context: string,
  ): Promise<Date> {
    const [clock] = await db.$queryRaw<Array<{ financialNow: Date }>>(Prisma.sql`
      WITH account_clock_floor AS (
        SELECT GREATEST(
          COALESCE(
            account."balance_grant_ledger_reconciled_at",
            '-infinity'::TIMESTAMP
          ),
          COALESCE((
            SELECT transaction_row."created_at"
            FROM "balance_transactions" transaction_row
            WHERE transaction_row."billing_account_id" = account."id"
              AND transaction_row."ledger_sequence" > 0
            ORDER BY transaction_row."created_at" DESC
            LIMIT 1
          ), '-infinity'::TIMESTAMP)
        )::TIMESTAMP(3) AS "financialFloor"
        FROM "billing_accounts" account
        WHERE account."id" = ${billingAccountId}
      ), observed AS (
        SELECT GREATEST(
          ${POSTGRES_UTC_FINANCIAL_CLOCK},
          "financialFloor"
        )::TIMESTAMP(3) AS "financialNow"
        FROM account_clock_floor
      )
      SELECT
        "financialNow",
        set_config(
          'billing.balance_financial_now',
          "financialNow"::TEXT,
          TRUE
        ) AS "financialNowSetting"
      FROM observed
    `);
    if (!clock?.financialNow || Number.isNaN(clock.financialNow.getTime())) {
      throw new Error(`BALANCE_FINANCIAL_CLOCK_UNAVAILABLE:${context}`);
    }
    return clock.financialNow;
  }

  /**
   * Complete the canonical wallet -> grants -> account lock order and only
   * then sample PostgreSQL's wall clock. The caller must already hold the
   * wallet row lock (normally through incrementAccountWallet or FOR UPDATE).
   */
  private async lockBalanceLedgerAndCaptureFinancialNow(
    db: Prisma.TransactionClient,
    billingAccountId: string,
    context: string,
  ): Promise<Date> {
    await db.$queryRaw`
      SELECT "id"
      FROM "balance_grants"
      WHERE "billing_account_id" = ${billingAccountId}
      ORDER BY "id" ASC
      FOR UPDATE`;
    await db.$queryRaw`
      SELECT "id"
      FROM "billing_accounts"
      WHERE "id" = ${billingAccountId}
      FOR UPDATE`;
    return this.captureFinancialNow(db, billingAccountId, context);
  }

  private async lockWalletLedgerAndCaptureFinancialNow(
    db: Prisma.TransactionClient,
    _userId: string,
    subject: BillingAccountSubjectRef,
    context: string,
  ): Promise<Date> {
    return this.lockProvisionedWalletLedgerAndCaptureFinancialNow(db, subject, context);
  }

  private billingAccountNotProvisioned(): ConflictException {
    return new ConflictException({
      code: 'billing_account_not_provisioned',
      message: '账务账号尚未完成开户，请稍后重试',
    });
  }

  /**
   * Financial primitives invoked from an existing outer transaction must not
   * create wallet infrastructure as a side effect. Provisioning owns account,
   * membership, tenant binding and wallet creation as one lifecycle boundary;
   * funding only locks an already provisioned wallet, then follows the same
   * grants -> account order as every other ledger mutation.
   */
  // Probe delegate. The name says one lock; it is four round trips (wallet, all
  // grants, account, financial clock) — see 03 doc 2.5.
  private async lockProvisionedWalletLedgerAndCaptureFinancialNow(
    db: Prisma.TransactionClient,
    subject: BillingAccountSubjectRef,
    context: string,
  ): Promise<Date> {
    return timed('walletLock', () => this
      .lockProvisionedWalletLedgerAndCaptureFinancialNowInner(db, subject, context));
  }

  private async lockProvisionedWalletLedgerAndCaptureFinancialNowInner(
    db: Prisma.TransactionClient,
    subject: BillingAccountSubjectRef,
    context: string,
  ): Promise<Date> {
    const walletRows = await db.$queryRaw<Array<{ balance_usd: Prisma.Decimal }>>`
      SELECT "balance_usd"
      FROM "account_wallets"
      WHERE "billing_account_id" = ${subject.billingAccountId}
      FOR UPDATE`;
    if (walletRows.length !== 1) {
      throw this.billingAccountNotProvisioned();
    }
    return this.lockBalanceLedgerAndCaptureFinancialNow(
      db,
      subject.billingAccountId,
      context,
    );
  }

  private getDiscountRate(paidAmountUsd: Prisma.Decimal, grantedAmountUsd: Prisma.Decimal): Prisma.Decimal {
    if (grantedAmountUsd.lte(0)) return new Prisma.Decimal(0);
    return paidAmountUsd.div(grantedAmountUsd).toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
  }

  /**
   * Split an exact grant debit without ever overdrawing either stored
   * component.  A twice-rounded proportional rate can otherwise exceed the
   * paid remainder by one or more 12-decimal units when amount is very close
   * to the total remainder.  Clamp the proportional result to the complete
   * feasible interval so paid + bonus remains exact and both remainders stay
   * non-negative.
   */
  private splitGrantDebitComponents(
    amountUsd: Prisma.Decimal,
    paidRemainingUsd: Prisma.Decimal,
    bonusRemainingUsd: Prisma.Decimal,
  ): { paidUsd: Prisma.Decimal; bonusUsd: Prisma.Decimal } {
    const totalRemainingUsd = paidRemainingUsd.plus(bonusRemainingUsd);
    if (
      amountUsd.lt(0)
      || amountUsd.gt(totalRemainingUsd)
      || paidRemainingUsd.lt(0)
      || bonusRemainingUsd.lt(0)
    ) {
      throw new Error('BALANCE_GRANT_COMPONENT_SPLIT_INVALID');
    }
    if (amountUsd.eq(totalRemainingUsd)) {
      return { paidUsd: paidRemainingUsd, bonusUsd: bonusRemainingUsd };
    }

    const proportionalPaidUsd = amountUsd
      .mul(this.getDiscountRate(paidRemainingUsd, totalRemainingUsd))
      .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
    const minimumPaidUsd = this.maxUsd(
      new Prisma.Decimal(0),
      amountUsd.minus(bonusRemainingUsd),
    );
    const maximumPaidUsd = this.minUsd(amountUsd, paidRemainingUsd);
    const paidUsd = this.minUsd(
      maximumPaidUsd,
      this.maxUsd(minimumPaidUsd, proportionalPaidUsd),
    );
    const bonusUsd = amountUsd.minus(paidUsd).toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
    if (
      paidUsd.lt(0)
      || bonusUsd.lt(0)
      || paidUsd.gt(paidRemainingUsd)
      || bonusUsd.gt(bonusRemainingUsd)
      || !paidUsd.plus(bonusUsd).eq(amountUsd)
    ) {
      throw new Error('BALANCE_GRANT_COMPONENT_SPLIT_INVALID');
    }
    return { paidUsd, bonusUsd };
  }

  private grantRemainingComponents(grant: PrismaBalanceGrant): {
    remainingUsd: Prisma.Decimal;
    paidRemainingUsd: Prisma.Decimal;
    bonusRemainingUsd: Prisma.Decimal;
    storedPaidRemainingUsd: Prisma.Decimal | null;
    storedBonusRemainingUsd: Prisma.Decimal | null;
    componentsPersisted: boolean;
  } {
    const remainingUsd = usd(grant.remainingAmountUsd);
    const storedPaid = (grant as PrismaBalanceGrant & {
      remainingPaidAmountUsd?: Prisma.Decimal | null;
      remainingBonusAmountUsd?: Prisma.Decimal | null;
    }).remainingPaidAmountUsd;
    const storedBonus = (grant as PrismaBalanceGrant & {
      remainingPaidAmountUsd?: Prisma.Decimal | null;
      remainingBonusAmountUsd?: Prisma.Decimal | null;
    }).remainingBonusAmountUsd;
    if (storedPaid != null && storedBonus != null) {
      const paidRemainingUsd = usd(storedPaid);
      const bonusRemainingUsd = usd(storedBonus);
      const grossPaidUsd = usd(grant.paidAmountUsd);
      const grossBonusUsd = usd(grant.bonusAmountUsd);
      const grantedUsd = usd(grant.grantedAmountUsd);
      if (
        paidRemainingUsd.gte(0)
        && bonusRemainingUsd.gte(0)
        && paidRemainingUsd.plus(bonusRemainingUsd).eq(remainingUsd)
        && paidRemainingUsd.lte(grossPaidUsd)
        && bonusRemainingUsd.lte(grossBonusUsd)
        && grossPaidUsd.plus(grossBonusUsd).eq(grantedUsd)
      ) {
        return {
          remainingUsd,
          paidRemainingUsd,
          bonusRemainingUsd,
          storedPaidRemainingUsd: paidRemainingUsd,
          storedBonusRemainingUsd: bonusRemainingUsd,
          componentsPersisted: true,
        };
      }
    }

    // Rolling-deploy/test-fixture fallback. This split is only used to keep a
    // legacy grant consumable; it is never considered sufficient proof for
    // automatic expiry. The account is marked DIRTY by the mutating caller.
    const fallbackRate = this.minUsd(
      new Prisma.Decimal(1),
      this.maxUsd(new Prisma.Decimal(0), usd(grant.discountRate)),
    );
    const paidRemainingUsd = remainingUsd
      .mul(fallbackRate)
      .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
    return {
      remainingUsd,
      paidRemainingUsd,
      bonusRemainingUsd: remainingUsd.minus(paidRemainingUsd),
      storedPaidRemainingUsd: storedPaid == null ? null : usd(storedPaid),
      storedBonusRemainingUsd: storedBonus == null ? null : usd(storedBonus),
      componentsPersisted: false,
    };
  }

  private async markBalanceGrantLedgerDirty(
    db: Prisma.TransactionClient | PrismaService,
    billingAccountId: string,
    reason: string,
  ): Promise<void> {
    await db.billingAccount.updateMany({
      where: {
        id: billingAccountId,
        balanceGrantLedgerStatus: BALANCE_GRANT_LEDGER_STATUS_RECONCILED,
      },
      data: {
        balanceGrantLedgerStatus: BALANCE_GRANT_LEDGER_STATUS_DIRTY,
        balanceGrantLedgerVersion: 0,
        balanceGrantLedgerHash: null,
        balanceGrantLedgerReconciledAt: null,
        balanceGrantLedgerDirtyReason: reason.slice(0, 500),
        balanceGrantLedgerThroughTransactionId: null,
      },
    });
  }

  /**
   * A pre-existing ledger proof failure is discovered inside the rejected
   * wallet transaction, so its in-transaction DIRTY marker rolls back with all
   * financial writes. The caller invokes this after rollback to preserve that
   * evidence via an independent compare-and-set. A proposed mutation's own
   * postcondition failure is not pre-existing evidence and must never demote a
   * healthy account into a weaker retry path.
   */
  async persistRejectedLedgerQuarantine(
    error: BalanceLedgerReconciliationRequiredError,
  ): Promise<void> {
    if (!error.quarantineExistingLedger) return;
    await this.markBalanceGrantLedgerDirty(
      this.prisma,
      error.billingAccountId,
      `financial mutation rejected:${error.reason}`,
    );
  }

  private async addBonusToRechargeBalanceGrant(
    db: Prisma.TransactionClient,
    params: {
      orderId?: string | null;
      userId: string;
      subject: ResolvedBillingSubject;
      productId?: string | null;
      bonusAmountUsd: Prisma.Decimal;
      financialNow: Date;
      // 可消费增量：余额欠款填坑后浮出水面的部分（默认等于 bonusAmountUsd）。
      consumableAmountUsd?: Prisma.Decimal;
    },
  ): Promise<string | null> {
    if (!params.orderId || params.bonusAmountUsd.lte(0)) return null;
    await db.$queryRaw`
      SELECT "id"
      FROM "balance_grants"
      WHERE "order_id" = ${params.orderId}
      FOR UPDATE`;
    const existing = await db.balanceGrant.findUnique({ where: { orderId: params.orderId } });
    if (!existing) throw new Error('BALANCE_GRANT_NOT_FOUND_FOR_BONUS');
    if (!this.balanceGrantMatchesFundingSubject(existing, {
      userId: params.userId,
      subject: params.subject,
      orderId: params.orderId,
      productId: params.productId,
    })) {
      throw new ConflictException('BALANCE_GRANT_SUBJECT_MISMATCH_FOR_BONUS');
    }
    if (
      existing.isExpired
      || (
        existing.expiresAt
        && existing.expiresAt.getTime() <= params.financialNow.getTime()
      )
    ) {
      throw new Error('BALANCE_GRANT_EXPIRED_FOR_BONUS');
    }

    const consumableUsd = this.maxUsd(
      new Prisma.Decimal(0),
      this.minUsd(params.consumableAmountUsd ?? params.bonusAmountUsd, params.bonusAmountUsd),
    );
    const components = this.grantRemainingComponents(existing);
    const bonusAmountUsd = existing.bonusAmountUsd.plus(params.bonusAmountUsd);
    const grantedAmountUsd = existing.grantedAmountUsd.plus(params.bonusAmountUsd);
    const remainingAmountUsd = components.remainingUsd.plus(consumableUsd);

    await db.balanceGrant.update({
      where: { id: existing.id },
      data: {
        bonusAmountUsd,
        grantedAmountUsd,
        remainingAmountUsd,
        ...(components.componentsPersisted
          ? {
              remainingPaidAmountUsd: components.paidRemainingUsd,
              remainingBonusAmountUsd: components.bonusRemainingUsd.plus(consumableUsd),
            }
          : {}),
        discountRate: this.getDiscountRate(existing.paidAmountUsd, grantedAmountUsd),
      },
    });
    if (!components.componentsPersisted) {
      await this.markBalanceGrantLedgerDirty(
        db,
        existing.billingAccountId ?? this.personalBillingAccountId(existing.userId),
        `bonus appended to unreconciled grant without guessing components:${existing.id}`,
      );
    }
    return existing.id;
  }

  private async applyBalanceGrantRefund(
    db: Prisma.TransactionClient,
    params: {
      orderId: string;
      refundAmountUsd: Prisma.Decimal;
      component: Exclude<BalanceGrantRefundComponent, 'UNKNOWN'>;
      operationKey: string;
      refundTransaction: PrismaBalanceTransaction;
      walletBalanceBeforeUsd: Prisma.Decimal;
      walletBalanceAfterUsd: Prisma.Decimal;
      effectiveAt: Date;
    },
  ): Promise<void> {
    const targetHint = await db.balanceGrant.findUnique({ where: { orderId: params.orderId } });
    if (!targetHint) throw new Error('BALANCE_REFUND_GRANT_NOT_FOUND');
    const billingAccountId = params.refundTransaction.billingAccountId;
    if (
      !billingAccountId
      || !this.balanceGrantMatchesFundingSubject(targetHint, {
        userId: params.refundTransaction.userId,
        subject: {
          tenantId: params.refundTransaction.tenantId,
          billingAccountId,
        },
        orderId: params.orderId,
        productId: params.refundTransaction.productId,
      })
    ) {
      throw new Error('BALANCE_REFUND_GRANT_ACCOUNT_MISMATCH');
    }

    // refundBalance 已通过钱包 update 持有 wallet 行锁。继续按统一顺序锁定
    // account 下所有 grant（包含 remaining=0 的目标批次）和账户 marker。
    await db.$queryRaw`
      SELECT "id"
      FROM "balance_grants"
      WHERE "billing_account_id" = ${billingAccountId}
      ORDER BY "id" ASC
      FOR UPDATE`;
    await db.$queryRaw`
      SELECT "id"
      FROM "billing_accounts"
      WHERE "id" = ${billingAccountId}
      FOR UPDATE`;

    const account = await db.billingAccount.findUniqueOrThrow({
      where: { id: billingAccountId },
      select: {
        type: true,
        balanceGrantLedgerStatus: true,
        balanceGrantLedgerVersion: true,
      },
    });
    if (
      account.balanceGrantLedgerStatus !== BALANCE_GRANT_LEDGER_STATUS_RECONCILED
      || account.balanceGrantLedgerVersion !== BALANCE_GRANT_LEDGER_VERSION
    ) {
      throw new Error('BALANCE_REFUND_LEDGER_NOT_RECONCILED');
    }

    const target = await db.balanceGrant.findUniqueOrThrow({ where: { id: targetHint.id } });
    if (target.isExpired) throw new Error('BALANCE_REFUND_EXPIRED_GRANT_REQUIRES_REVIEW');
    if (target.validFrom.getTime() > params.effectiveAt.getTime()) {
      throw new Error('BALANCE_REFUND_FUTURE_GRANT_REQUIRES_REVIEW');
    }
    const activeGrants = await db.balanceGrant.findMany({
      where: {
        billingAccountId,
        isExpired: false,
        remainingAmountUsd: { gt: new Prisma.Decimal(0) },
        validFrom: { lte: params.effectiveAt },
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: params.effectiveAt } },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    const activeComponents = new Map<string, ReturnType<BillingService['grantRemainingComponents']>>();
    for (const grant of activeGrants) {
      const components = this.grantRemainingComponents(grant);
      if (
        !components.componentsPersisted
        || !usd(grant.paidAmountUsd).plus(grant.bonusAmountUsd).eq(usd(grant.grantedAmountUsd))
        || components.paidRemainingUsd.gt(usd(grant.paidAmountUsd))
        || components.bonusRemainingUsd.gt(usd(grant.bonusAmountUsd))
      ) {
        throw new Error(`BALANCE_REFUND_UNPROVEN_GRANT_COMPONENTS:${grant.id}`);
      }
      activeComponents.set(grant.id, components);
    }
    const targetComponents = target.remainingAmountUsd.gt(0)
      ? activeComponents.get(target.id)
      : this.grantRemainingComponents(target);
    if (
      !targetComponents?.componentsPersisted
      || !usd(target.paidAmountUsd).plus(target.bonusAmountUsd).eq(usd(target.grantedAmountUsd))
      || targetComponents.paidRemainingUsd.gt(usd(target.paidAmountUsd))
      || targetComponents.bonusRemainingUsd.gt(usd(target.bonusAmountUsd))
    ) {
      throw new Error('BALANCE_REFUND_UNPROVEN_TARGET_COMPONENTS');
    }

    const activeGrantUsd = [...activeComponents.values()].reduce(
      (sum, components) => sum.plus(components.remainingUsd),
      new Prisma.Decimal(0),
    );
    const expectedActiveGrantUsd = this.maxUsd(
      new Prisma.Decimal(0),
      params.walletBalanceBeforeUsd,
    );
    if (!activeGrantUsd.eq(expectedActiveGrantUsd)) {
      throw new Error(
        `BALANCE_REFUND_PRECONDITION_GRANT_MISMATCH:${activeGrantUsd.toFixed(12)}:${
          expectedActiveGrantUsd.toFixed(12)
        }`,
      );
    }

    const debtSource: BalanceDebtAllocationSource = account.type === ENTERPRISE_ACCOUNT_TYPE
      ? BALANCE_ALLOCATION_SOURCE_ENTERPRISE_CREDIT
      : BALANCE_ALLOCATION_SOURCE_NEGATIVE_BALANCE;
    const [debtRow] = await db.$queryRaw<Array<{
      open_debt_usd: Prisma.Decimal;
      pending_settlement_usd: Prisma.Decimal;
      invalid_debt_count: bigint;
      invalid_sequence_count: bigint;
      unexpected_debt_count: bigint;
    }>>`
      SELECT
        COALESCE(SUM("amount_usd" - "settled_usd") FILTER (
          WHERE "source" = ${debtSource}
        ), 0) AS "open_debt_usd",
        COALESCE((
          SELECT SUM("remaining_paid_usd" + "remaining_bonus_usd")
          FROM "balance_debt_settlement_pending"
          WHERE "billing_account_id" = ${billingAccountId}
            AND "allocation_source" = ${debtSource}
        ), 0) AS "pending_settlement_usd",
        COUNT(*) FILTER (
          WHERE "amount_usd" <= 0 OR "settled_usd" < 0 OR "settled_usd" > "amount_usd"
        ) AS "invalid_debt_count",
        COUNT(*) FILTER (
          WHERE "ledger_sequence" IS NULL OR "ledger_sequence" = 0
        ) AS "invalid_sequence_count",
        COUNT(*) FILTER (WHERE "source" <> ${debtSource}) AS "unexpected_debt_count"
      FROM "balance_consumption_allocations"
      WHERE "billing_account_id" = ${billingAccountId}
        AND "source" IN (
          ${BALANCE_ALLOCATION_SOURCE_NEGATIVE_BALANCE},
          ${BALANCE_ALLOCATION_SOURCE_ENTERPRISE_CREDIT}
        )`;
    const openDebtBeforeUsd = usd(debtRow?.open_debt_usd ?? 0);
    // 已入账未核销的部分不算在「钱包应对应的欠款」里,否则一笔降级过的大额充值
    // 会让此后每次退款都在前置判定上失败。三项式见 ReconciledBalanceLedgerSnapshot。
    const pendingSettlementBeforeUsd = usd(debtRow?.pending_settlement_usd ?? 0);
    const expectedOpenDebtBeforeUsd = this.maxUsd(
      new Prisma.Decimal(0),
      params.walletBalanceBeforeUsd.neg(),
    );
    if (
      !openDebtBeforeUsd.minus(pendingSettlementBeforeUsd).eq(expectedOpenDebtBeforeUsd)
      || (debtRow?.invalid_debt_count ?? BigInt(0)) !== BigInt(0)
      || (debtRow?.invalid_sequence_count ?? BigInt(0)) !== BigInt(0)
      || (debtRow?.unexpected_debt_count ?? BigInt(0)) !== BigInt(0)
    ) {
      throw new Error(
        `BALANCE_REFUND_PRECONDITION_DEBT_MISMATCH:${openDebtBeforeUsd.toFixed(12)}:`
        + `pending=${pendingSettlementBeforeUsd.toFixed(12)}:${
          expectedOpenDebtBeforeUsd.toFixed(12)
        }`,
      );
    }

    const grossComponentUsd = params.component === 'PAID'
      ? usd(target.paidAmountUsd)
      : usd(target.bonusAmountUsd);
    const priorRefund = await db.balanceGrantRefund.aggregate({
      where: { balanceGrantId: target.id, component: params.component },
      _sum: { requestedAmountUsd: true },
    });
    const previouslyRefundedUsd = usd(priorRefund._sum.requestedAmountUsd ?? 0);
    if (previouslyRefundedUsd.plus(params.refundAmountUsd).gt(grossComponentUsd)) {
      throw new Error('BALANCE_REFUND_EXCEEDS_ORIGINAL_COMPONENT');
    }

    const targetComponentRemainingUsd = params.component === 'PAID'
      ? targetComponents.paidRemainingUsd
      : targetComponents.bonusRemainingUsd;
    const targetGrantReductionUsd = this.minUsd(
      params.refundAmountUsd,
      targetComponentRemainingUsd,
    );
    const targetPaidReductionUsd = params.component === 'PAID'
      ? targetGrantReductionUsd
      : new Prisma.Decimal(0);
    const targetBonusReductionUsd = params.component === 'BONUS'
      ? targetGrantReductionUsd
      : new Prisma.Decimal(0);
    if (targetGrantReductionUsd.gt(0)) {
      const updated = await db.balanceGrant.updateMany({
        where: {
          id: target.id,
          remainingAmountUsd: targetComponents.remainingUsd,
          remainingPaidAmountUsd: targetComponents.paidRemainingUsd,
          remainingBonusAmountUsd: targetComponents.bonusRemainingUsd,
          isExpired: false,
          validFrom: { lte: params.effectiveAt },
          OR: [
            { expiresAt: null },
            { expiresAt: { gt: params.effectiveAt } },
          ],
        },
        data: {
          remainingAmountUsd: targetComponents.remainingUsd.minus(targetGrantReductionUsd),
          remainingPaidAmountUsd: targetComponents.paidRemainingUsd.minus(targetPaidReductionUsd),
          remainingBonusAmountUsd: targetComponents.bonusRemainingUsd.minus(targetBonusReductionUsd),
        },
      });
      if (updated.count !== 1) throw new Error('BALANCE_GRANT_REFUND_CONFLICT');
    }
    const targetAfterReduction = {
      ...targetComponents,
      remainingUsd: targetComponents.remainingUsd.minus(targetGrantReductionUsd),
      paidRemainingUsd: targetComponents.paidRemainingUsd.minus(targetPaidReductionUsd),
      bonusRemainingUsd: targetComponents.bonusRemainingUsd.minus(targetBonusReductionUsd),
      storedPaidRemainingUsd: targetComponents.paidRemainingUsd.minus(targetPaidReductionUsd),
      storedBonusRemainingUsd: targetComponents.bonusRemainingUsd.minus(targetBonusReductionUsd),
    };
    if (activeComponents.has(target.id)) {
      activeComponents.set(target.id, targetAfterReduction);
    }

    const debtOpenedUsd = params.refundAmountUsd.minus(targetGrantReductionUsd);
    let debtAllocationId: string | null = null;
    if (debtOpenedUsd.gt(0)) {
      const allocation = await db.balanceConsumptionAllocation.create({
        data: {
          userId: params.refundTransaction.userId,
          tenantId: params.refundTransaction.tenantId,
          billingAccountId,
          ...(target.productId ? { productId: target.productId } : {}),
          balanceTransactionId: params.refundTransaction.id,
          balanceGrantId: null,
          source: debtSource,
          amountUsd: debtOpenedUsd,
          recognizedRevenueUsd: new Prisma.Decimal(0),
          bonusConsumedUsd: new Prisma.Decimal(0),
          discountRate: new Prisma.Decimal(0),
          createdAt: params.effectiveAt,
        },
      });
      this.assertDebtAllocationLedgerSequence(allocation);
      debtAllocationId = allocation.id;
    }

    const nettingRows: Array<{
      grantId: string;
      paidUsd: Prisma.Decimal;
      bonusUsd: Prisma.Decimal;
      amountUsd: Prisma.Decimal;
    }> = [];
    let debtRemainingUsd = debtOpenedUsd;
    // 目标批次可能同时包含本金与赠额。退完一种 component 后，另一种仍然是
    // 有效资金，也必须和其他批次一样参与退款欠款净额；否则 mixed grant 会
    // 同时留下正 grant 和 refund debt，破坏 canonical invariant。
    const nettingGrants = activeGrants
      .filter((grant) => activeComponents.get(grant.id)!.remainingUsd.gt(0))
      .sort((left, right) => {
        const leftExpiry = left.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
        const rightExpiry = right.expiresAt?.getTime() ?? Number.POSITIVE_INFINITY;
        return leftExpiry - rightExpiry
          || left.createdAt.getTime() - right.createdAt.getTime()
          || left.id.localeCompare(right.id);
      });
    for (const grant of nettingGrants) {
      if (debtRemainingUsd.lte(0)) break;
      const components = activeComponents.get(grant.id)!;
      const amountUsd = this.minUsd(debtRemainingUsd, components.remainingUsd);
      const { paidUsd, bonusUsd } = this.splitGrantDebitComponents(
        amountUsd,
        components.paidRemainingUsd,
        components.bonusRemainingUsd,
      );
      const updated = await db.balanceGrant.updateMany({
        where: {
          id: grant.id,
          remainingAmountUsd: components.remainingUsd,
          remainingPaidAmountUsd: components.paidRemainingUsd,
          remainingBonusAmountUsd: components.bonusRemainingUsd,
          isExpired: false,
          validFrom: { lte: params.effectiveAt },
          OR: [
            { expiresAt: null },
            { expiresAt: { gt: params.effectiveAt } },
          ],
        },
        data: {
          remainingAmountUsd: components.remainingUsd.minus(amountUsd),
          remainingPaidAmountUsd: components.paidRemainingUsd.minus(paidUsd),
          remainingBonusAmountUsd: components.bonusRemainingUsd.minus(bonusUsd),
        },
      });
      if (updated.count !== 1) throw new Error('BALANCE_GRANT_REFUND_NETTING_CONFLICT');
      if (!debtAllocationId) throw new Error('BALANCE_REFUND_DEBT_ALLOCATION_MISSING');
      const debtAfterUsd = debtRemainingUsd.minus(amountUsd);
      await db.balanceConsumptionAllocation.update({
        where: { id: debtAllocationId },
        data: {
          settledUsd: { increment: amountUsd },
          ...(paidUsd.gt(0) ? { recognizedRevenueUsd: { increment: paidUsd } } : {}),
          ...(bonusUsd.gt(0) ? { bonusConsumedUsd: { increment: bonusUsd } } : {}),
          ...(debtAfterUsd.eq(0) ? { settledAt: params.refundTransaction.createdAt } : {}),
        },
      });
      await db.enterpriseCreditSettlement.create({
        data: {
          billingAccountId,
          allocationId: debtAllocationId,
          repaymentTransactionId: params.refundTransaction.id,
          balanceGrantId: grant.id,
          debtSource,
          operationKey: `refund-netting:${params.refundTransaction.id}:${grant.id}:${params.component}`,
          trigger: 'REFUND_NETTING',
          amountUsd,
          paidUsd,
          bonusUsd,
          occurredAt: params.refundTransaction.createdAt,
          createdAt: params.effectiveAt,
        },
      });
      nettingRows.push({ grantId: grant.id, paidUsd, bonusUsd, amountUsd });
      debtRemainingUsd = debtAfterUsd;
    }

    const debtNettedUsd = debtOpenedUsd.minus(debtRemainingUsd);
    const refundAudit = await db.balanceGrantRefund.create({
      data: {
        billingAccountId,
        balanceGrantId: target.id,
        refundTransactionId: params.refundTransaction.id,
        debtAllocationId,
        operationKey: params.operationKey,
        component: params.component,
        requestedAmountUsd: params.refundAmountUsd,
        targetGrantReductionUsd,
        debtOpenedUsd,
        debtNettedUsd,
        openDebtUsd: debtRemainingUsd,
        recognizedRevenueReversalUsd: params.component === 'PAID'
          ? debtOpenedUsd
          : new Prisma.Decimal(0),
        bonusConsumedReversalUsd: params.component === 'BONUS'
          ? debtOpenedUsd
          : new Prisma.Decimal(0),
        occurredAt: params.refundTransaction.createdAt,
        createdAt: params.effectiveAt,
      },
    });
    let sequence = 0;
    if (targetGrantReductionUsd.gt(0)) {
      sequence += 1;
      await db.balanceGrantRefundAllocation.create({
        data: {
          refundId: refundAudit.id,
          balanceGrantId: target.id,
          sequence,
          role: 'TARGET_UNUSED',
          amountUsd: targetGrantReductionUsd,
          paidReductionUsd: targetPaidReductionUsd,
          bonusReductionUsd: targetBonusReductionUsd,
        },
      });
    }
    for (const netting of nettingRows) {
      sequence += 1;
      await db.balanceGrantRefundAllocation.create({
        data: {
          refundId: refundAudit.id,
          balanceGrantId: netting.grantId,
          sequence,
          role: 'DEBT_NETTING',
          amountUsd: netting.amountUsd,
          paidReductionUsd: netting.paidUsd,
          bonusReductionUsd: netting.bonusUsd,
        },
      });
    }

    const [postcondition] = await db.$queryRaw<Array<{
      active_grant_usd: Prisma.Decimal;
      open_debt_usd: Prisma.Decimal;
      pending_settlement_usd: Prisma.Decimal;
      invalid_component_count: bigint;
      invalid_sequence_count: bigint;
      unexpected_debt_count: bigint;
    }>>`
      SELECT
        COALESCE((
          SELECT SUM("remaining_amount_usd")
          FROM "balance_grants"
          WHERE "billing_account_id" = ${billingAccountId}
            AND "is_expired" = FALSE
            AND "valid_from" <= ${params.effectiveAt}
            AND ("expires_at" IS NULL OR "expires_at" > ${params.effectiveAt})
        ), 0) AS "active_grant_usd",
        COALESCE((
          SELECT SUM("amount_usd" - "settled_usd")
          FROM "balance_consumption_allocations"
          WHERE "billing_account_id" = ${billingAccountId}
            AND "source" = ${debtSource}
        ), 0) AS "open_debt_usd",
        COALESCE((
          SELECT SUM("remaining_paid_usd" + "remaining_bonus_usd")
          FROM "balance_debt_settlement_pending"
          WHERE "billing_account_id" = ${billingAccountId}
            AND "allocation_source" = ${debtSource}
        ), 0) AS "pending_settlement_usd",
        (
          SELECT COUNT(*)
          FROM "balance_grants"
          WHERE "billing_account_id" = ${billingAccountId}
            AND (
              "remaining_paid_amount_usd" IS NULL
              OR "remaining_bonus_amount_usd" IS NULL
              OR "remaining_paid_amount_usd" < 0
              OR "remaining_bonus_amount_usd" < 0
              OR "remaining_amount_usd" <> "remaining_paid_amount_usd" + "remaining_bonus_amount_usd"
              OR "paid_amount_usd" + "bonus_amount_usd" <> "granted_amount_usd"
              OR "granted_amount_usd" <= 0
              OR "discount_rate" IS DISTINCT FROM CASE
                WHEN "granted_amount_usd" > 0
                  THEN ROUND("paid_amount_usd" / "granted_amount_usd", 12)
                ELSE 0
              END
              OR "remaining_paid_amount_usd" > "paid_amount_usd"
              OR "remaining_bonus_amount_usd" > "bonus_amount_usd"
              OR "valid_from" > ${params.effectiveAt}
            )
        ) AS "invalid_component_count",
        (
          SELECT COUNT(*)
          FROM "balance_consumption_allocations"
          WHERE "billing_account_id" = ${billingAccountId}
            AND ("ledger_sequence" IS NULL OR "ledger_sequence" = 0)
        ) AS "invalid_sequence_count",
        (
          SELECT COUNT(*)
          FROM "balance_consumption_allocations"
          WHERE "billing_account_id" = ${billingAccountId}
            AND "source" IN (
              ${BALANCE_ALLOCATION_SOURCE_NEGATIVE_BALANCE},
              ${BALANCE_ALLOCATION_SOURCE_ENTERPRISE_CREDIT}
            )
            AND "source" <> ${debtSource}
        ) AS "unexpected_debt_count"`;
    const expectedGrantAfterUsd = this.maxUsd(
      new Prisma.Decimal(0),
      params.walletBalanceAfterUsd,
    );
    const expectedDebtAfterUsd = this.maxUsd(
      new Prisma.Decimal(0),
      params.walletBalanceAfterUsd.neg(),
    );
    if (
      !postcondition
      || !usd(postcondition.active_grant_usd).eq(expectedGrantAfterUsd)
      || !usd(postcondition.open_debt_usd)
        .minus(usd(postcondition.pending_settlement_usd ?? 0))
        .eq(expectedDebtAfterUsd)
      || postcondition.invalid_component_count !== BigInt(0)
      || (postcondition.invalid_sequence_count ?? BigInt(0)) !== BigInt(0)
      || (postcondition.unexpected_debt_count ?? BigInt(0)) !== BigInt(0)
    ) {
      throw new Error('BALANCE_REFUND_POSTCONDITION_FAILED');
    }
  }

  // Probe delegate.
  private async expireAccountBalanceGrants(
    db: Prisma.TransactionClient,
    subject: BillingAccountSubjectRef,
    financialNow: Date,
  ): Promise<void> {
    return timed('grantExpire', () => this
      .expireAccountBalanceGrantsInner(db, subject, financialNow));
  }

  private async expireAccountBalanceGrantsInner(
    db: Prisma.TransactionClient,
    subject: BillingAccountSubjectRef,
    financialNow: Date,
  ): Promise<void> {
    const account = await db.billingAccount.findUniqueOrThrow({
      where: { id: subject.billingAccountId },
      select: {
        type: true,
        balanceGrantLedgerStatus: true,
        balanceGrantLedgerVersion: true,
      },
    });
    if (
      account.balanceGrantLedgerStatus !== BALANCE_GRANT_LEDGER_STATUS_RECONCILED
      || account.balanceGrantLedgerVersion !== BALANCE_GRANT_LEDGER_VERSION
    ) {
      const dueGrantCount = await db.balanceGrant.count({
        where: {
          billingAccountId: subject.billingAccountId,
          isExpired: false,
          remainingAmountUsd: { gt: new Prisma.Decimal(0) },
          expiresAt: { lte: financialNow, not: null },
        },
      });
      if (dueGrantCount > 0) {
        // A DIRTY wallet may still include this expired money. Continuing into
        // UNRECONCILED_GRANT or negative-balance allocation would spend it.
        throw new BalanceLedgerReconciliationRequiredError(
          subject.billingAccountId,
          `unexpired positive grant is due at ${financialNow.toISOString()}`,
        );
      }
      return;
    }
    const results = await this.expireDueBalanceGrantsForAccountInTransaction(
      db,
      subject.billingAccountId,
      financialNow,
    );
    const blocked = results.find((result) => result.outcome === 'BLOCKED');
    if (blocked?.outcome === 'BLOCKED') {
      this.logger.error(
        `on-demand balance grant expiry blocked account=${blocked.billingAccountId} `
        + `grant=${blocked.id} reason=${blocked.reason}`,
      );
      throw new BalanceLedgerReconciliationRequiredError(
        blocked.billingAccountId,
        blocked.reason,
      );
    }
  }

  async sweepExpiredBalanceGrants(
    now = new Date(),
    limit = 100,
  ): Promise<BalanceGrantExpirySweepResult> {
    const take = Math.max(1, Math.min(1000, Math.trunc(limit)));
    const candidates = await this.prisma.balanceGrant.findMany({
      where: {
        isExpired: false,
        remainingAmountUsd: { gt: new Prisma.Decimal(0) },
        expiresAt: { lte: now, not: null },
        billingAccount: {
          is: { balanceGrantLedgerStatus: BALANCE_GRANT_LEDGER_STATUS_RECONCILED },
        },
      },
      orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
      take,
    });

    let expired = 0;
    let failed = 0;
    let totalExpiredUsd = new Prisma.Decimal(0);
    let totalWalletDebitedUsd = new Prisma.Decimal(0);
    let totalUnbackedUsd = new Prisma.Decimal(0);

    const accountCandidates = new Map<string, (typeof candidates)[number]>();
    for (const candidate of candidates) {
      const billingAccountId = candidate.billingAccountId
        ?? this.personalBillingAccountId(candidate.userId);
      if (!accountCandidates.has(billingAccountId)) {
        accountCandidates.set(billingAccountId, candidate);
      }
    }

    for (const [billingAccountId, candidate] of accountCandidates) {
      try {
        const subject = {
          tenantId: candidate.tenantId,
          billingAccountId,
        };
        const results = await this.runBalanceLedgerTransaction(
          'sweepExpiredBalanceGrants',
          `account=${billingAccountId}`,
          (db) => this.expireDueBalanceGrantsForAccountInTransaction(db, billingAccountId),
        );
        const blocked = results.find((result) => result.outcome === 'BLOCKED');
        if (blocked?.outcome === 'BLOCKED') {
          failed += 1;
          this.logger.error(
            `balance grant expiry quarantined grant=${blocked.id} account=${blocked.billingAccountId} `
            + `reason=${blocked.reason}`,
          );
          continue;
        }

        const expiredResults = results.filter(
          (result): result is ExpiredBalanceGrantResult => result.outcome === 'EXPIRED',
        );
        for (const result of expiredResults) {
          expired += 1;
          totalExpiredUsd = totalExpiredUsd.plus(result.nominalAmountUsd);
          totalWalletDebitedUsd = totalWalletDebitedUsd.plus(result.walletDebitUsd);
          totalUnbackedUsd = totalUnbackedUsd.plus(result.unbackedAmountUsd);
        }
        if (expiredResults.some((result) => result.walletDebitUsd.gt(0))) {
          await this.refreshAnchoredBalanceProjection(candidate.userId, subject);
        }
      } catch (err) {
        failed += 1;
        this.logger.error(
          `balance grant expiry failed account=${billingAccountId} candidate=${candidate.id}: ${
            err instanceof Error ? err.stack ?? err.message : String(err)
          }`,
        );
      }
    }

    return {
      scanned: candidates.length,
      expired,
      failed,
      totalExpiredUsd: usdNumber(totalExpiredUsd),
      totalWalletDebitedUsd: usdNumber(totalWalletDebitedUsd),
      totalUnbackedUsd: usdNumber(totalUnbackedUsd),
    };
  }

  /**
   * Release-B's canonical wallet guard excludes every grant already due at the
   * transaction's locked financial time. Expiring only the page candidate
   * would therefore leave the account non-canonical at COMMIT whenever a
   * second due grant exists. Lock the account ledger once, discover every due
   * grant after the locks, and expire the complete set in this one transaction.
   */
  /**
   * Expire every grant due for one account as a single financial mutation.
   *
   * The outer candidate page discovers accounts only. Once the ledger is
   * locked, Release-B's canonical invariant treats every grant due at the
   * locked financial time as inactive, so all of them must be cleared before
   * this transaction commits. Validation is account-wide and runs once; each
   * grant still receives its own immutable ADJUST edge and expiry audit.
   */
  private async expireDueBalanceGrantsForAccountInTransaction(
    db: Prisma.TransactionClient,
    billingAccountId: string,
    lockedFinancialNow?: Date,
  ): Promise<BalanceGrantExpiryAttemptResult[]> {
    // Global financial lock order: wallet -> all active grants -> account.
    // On-demand callers already own these locks; PostgreSQL row locks are
    // transaction-reentrant, so taking the same bundle here is safe.
    const walletLockRows = await db.$queryRaw<Array<{ balance_usd: Prisma.Decimal }>>`
      SELECT "balance_usd"
      FROM "account_wallets"
      WHERE "billing_account_id" = ${billingAccountId}
      FOR UPDATE`;
    await db.$queryRaw`
      SELECT "id"
      FROM "balance_grants"
      WHERE "billing_account_id" = ${billingAccountId}
      ORDER BY "id" ASC
      FOR UPDATE`;
    await db.$queryRaw`
      SELECT "id"
      FROM "billing_accounts"
      WHERE "id" = ${billingAccountId}
      FOR UPDATE`;

    const financialNow = lockedFinancialNow
      ?? await this.captureFinancialNow(
        db,
        billingAccountId,
        `balance-grant-expiry-account:${billingAccountId}`,
      );
    const [account, walletBefore, allGrants] = await Promise.all([
      db.billingAccount.findUniqueOrThrow({
        where: { id: billingAccountId },
        select: {
          type: true,
          balanceGrantLedgerStatus: true,
          balanceGrantLedgerVersion: true,
        },
      }),
      db.accountWallet.findUnique({ where: { billingAccountId } }),
      db.balanceGrant.findMany({
        where: { billingAccountId },
        orderBy: { id: 'asc' },
      }),
    ]);
    const activeGrants = allGrants.filter(
      (grant) => !grant.isExpired && usd(grant.remainingAmountUsd).gt(0),
    );
    const dueGrants = activeGrants
      .filter((grant) => (
        grant.expiresAt !== null
        && grant.expiresAt.getTime() <= financialNow.getTime()
      ))
      .sort((left, right) => (
        left.expiresAt!.getTime() - right.expiresAt!.getTime()
        || left.createdAt.getTime() - right.createdAt.getTime()
        || left.id.localeCompare(right.id)
      ));
    if (dueGrants.length === 0) return [];

    // V1 reservations freeze collected funding exclusively from non-expiring
    // grants. Due expiring grants are therefore never part of a frozen slice
    // and must keep expiring while evidence is pending; blocking them creates a
    // settlement/expiry cycle. Missing or older reservation evidence remains
    // fail-closed.
    await this.assertGatewayReservationsPermitGrantExpiry(db, billingAccountId);

    const blocked = async (reason: string): Promise<BalanceGrantExpiryAttemptResult[]> => {
      const grant = dueGrants[0];
      await this.markBalanceGrantLedgerDirty(db, billingAccountId, reason);
      return [{
        outcome: 'BLOCKED',
        id: grant.id,
        userId: grant.userId,
        tenantId: grant.tenantId,
        billingAccountId,
        reason,
      }];
    };
    if (
      account.balanceGrantLedgerStatus !== BALANCE_GRANT_LEDGER_STATUS_RECONCILED
      || account.balanceGrantLedgerVersion !== BALANCE_GRANT_LEDGER_VERSION
    ) {
      return blocked(
        `account status ${account.balanceGrantLedgerStatus} v${account.balanceGrantLedgerVersion}`,
      );
    }

    if (walletLockRows.length !== 1 || !walletBefore) {
      return blocked('account wallet is missing');
    }

    const allGrantComponents = allGrants.map((grant) => ({
      grant,
      components: this.grantRemainingComponents(grant),
    }));
    const invalidComponents = allGrantComponents.find(({ grant, components }) => (
      !components.componentsPersisted
      || usd(grant.paidAmountUsd).lt(0)
      || usd(grant.bonusAmountUsd).lt(0)
      || usd(grant.grantedAmountUsd).lte(0)
      || !usd(grant.paidAmountUsd).plus(grant.bonusAmountUsd).eq(usd(grant.grantedAmountUsd))
      || !usd(grant.discountRate).eq(this.getDiscountRate(
        usd(grant.paidAmountUsd),
        usd(grant.grantedAmountUsd),
      ))
      || components.paidRemainingUsd.gt(usd(grant.paidAmountUsd))
      || components.bonusRemainingUsd.gt(usd(grant.bonusAmountUsd))
      || grant.validFrom.getTime() > financialNow.getTime()
      || (grant.expiresAt !== null && grant.expiresAt.getTime() <= grant.validFrom.getTime())
      || (grant.isExpired && components.remainingUsd.gt(0))
    ));
    if (invalidComponents) {
      return blocked(`grant components are not proven:${invalidComponents.grant.id}`);
    }

    const grantComponents = allGrantComponents.filter(({ grant }) => (
      !grant.isExpired && usd(grant.remainingAmountUsd).gt(0)
    ));

    const totalActiveGrantUsd = grantComponents.reduce(
      (sum, row) => sum.plus(row.components.remainingUsd),
      new Prisma.Decimal(0),
    );
    const walletBalanceBeforeUsd = usd(walletBefore.balanceUsd);
    const walletPositiveUsd = this.maxUsd(new Prisma.Decimal(0), walletBalanceBeforeUsd);
    const ledgerDifferenceUsd = walletPositiveUsd.minus(totalActiveGrantUsd);
    if (!ledgerDifferenceUsd.eq(0)) {
      this.logger.error(
        `balance grant expiry blocked by unreconciled ledger account=${billingAccountId} `
        + `walletPositiveUsd=${walletPositiveUsd.toFixed()} `
        + `activeGrantUsd=${totalActiveGrantUsd.toFixed()} `
        + `differenceUsd=${ledgerDifferenceUsd.toFixed()}`,
      );
      return blocked(`wallet/grant mismatch ${ledgerDifferenceUsd.toFixed()}`);
    }

    const debtSource: BalanceDebtAllocationSource = account.type === ENTERPRISE_ACCOUNT_TYPE
      ? BALANCE_ALLOCATION_SOURCE_ENTERPRISE_CREDIT
      : BALANCE_ALLOCATION_SOURCE_NEGATIVE_BALANCE;
    const [debtState] = await db.$queryRaw<Array<{
      open_debt_usd: Prisma.Decimal;
      pending_settlement_usd: Prisma.Decimal;
      invalid_debt_count: bigint;
      invalid_sequence_count: bigint;
      unexpected_debt_count: bigint;
    }>>`
      SELECT
        COALESCE(SUM("amount_usd" - "settled_usd") FILTER (
          WHERE "source" = ${debtSource}
        ), 0) AS "open_debt_usd",
        COALESCE((
          SELECT SUM("remaining_paid_usd" + "remaining_bonus_usd")
          FROM "balance_debt_settlement_pending"
          WHERE "billing_account_id" = ${billingAccountId}
            AND "allocation_source" = ${debtSource}
        ), 0) AS "pending_settlement_usd",
        COUNT(*) FILTER (
          WHERE "amount_usd" <= 0 OR "settled_usd" < 0 OR "settled_usd" > "amount_usd"
        ) AS "invalid_debt_count",
        COUNT(*) FILTER (
          WHERE "ledger_sequence" IS NULL OR "ledger_sequence" = 0
        ) AS "invalid_sequence_count",
        COUNT(*) FILTER (WHERE "source" <> ${debtSource}) AS "unexpected_debt_count"
      FROM "balance_consumption_allocations"
      WHERE "billing_account_id" = ${billingAccountId}
        AND "source" IN (
          ${BALANCE_ALLOCATION_SOURCE_NEGATIVE_BALANCE},
          ${BALANCE_ALLOCATION_SOURCE_ENTERPRISE_CREDIT}
        )`;
    const openDebtUsd = usd(debtState?.open_debt_usd ?? 0);
    // 同 refund 前置:pending 不计入钱包应对应的欠款。这一处尤其关键 ——
    // expireAccountBalanceGrants 是 adminRecharge 的第一步,漏改会让第一笔
    // 降级充值之后的所有充值都在这里抛 wallet/debt mismatch。
    const pendingSettlementUsd = usd(debtState?.pending_settlement_usd ?? 0);
    const expectedOpenDebtUsd = this.maxUsd(new Prisma.Decimal(0), walletBalanceBeforeUsd.neg());
    if (
      !openDebtUsd.minus(pendingSettlementUsd).eq(expectedOpenDebtUsd)
      || (debtState?.invalid_debt_count ?? BigInt(0)) !== BigInt(0)
      || (debtState?.invalid_sequence_count ?? BigInt(0)) !== BigInt(0)
      || (debtState?.unexpected_debt_count ?? BigInt(0)) !== BigInt(0)
    ) {
      return blocked(
        `wallet/debt mismatch open=${openDebtUsd.toFixed()} expected=${expectedOpenDebtUsd.toFixed()}`,
      );
    }

    const componentsByGrantId = new Map(
      grantComponents.map(({ grant, components }) => [grant.id, components] as const),
    );
    const results: BalanceGrantExpiryAttemptResult[] = [];
    let walletBalanceBeforeGrantUsd = walletBalanceBeforeUsd;

    // The database guard requires a transaction-local V2 writer token. Set it
    // only after the complete account invariant has been proven under locks.
    await db.$executeRaw`SET LOCAL billing.balance_grant_expiry_writer = 'v2'`;

    for (const grant of dueGrants) {
      const components = componentsByGrantId.get(grant.id)!;
      const nominalAmountUsd = components.remainingUsd.toDecimalPlaces(
        12,
        Prisma.Decimal.ROUND_HALF_UP,
      );
      const updated = await db.balanceGrant.updateMany({
        where: {
          id: grant.id,
          isExpired: false,
          remainingAmountUsd: components.remainingUsd,
          remainingPaidAmountUsd: components.paidRemainingUsd,
          remainingBonusAmountUsd: components.bonusRemainingUsd,
          expiresAt: { lte: financialNow, not: null },
        },
        data: {
          remainingAmountUsd: new Prisma.Decimal(0),
          remainingPaidAmountUsd: new Prisma.Decimal(0),
          remainingBonusAmountUsd: new Prisma.Decimal(0),
          isExpired: true,
        },
      });
      if (updated.count !== 1) {
        throw new Error('BALANCE_GRANT_EXPIRY_GRANT_CONFLICT');
      }

      const walletUpdated = await db.accountWallet.updateMany({
        where: {
          billingAccountId,
          balanceUsd: { gte: nominalAmountUsd },
        },
        data: { balanceUsd: { decrement: nominalAmountUsd } },
      });
      if (walletUpdated.count !== 1) {
        throw new Error('BALANCE_GRANT_EXPIRY_WALLET_CONFLICT');
      }
      const walletBalanceAfterGrantUsd = walletBalanceBeforeGrantUsd.minus(nominalAmountUsd);
      const wallet = await db.accountWallet.findUniqueOrThrow({
        where: { billingAccountId },
      });
      if (!usd(wallet.balanceUsd).eq(walletBalanceAfterGrantUsd)) {
        throw new Error('BALANCE_GRANT_EXPIRY_WALLET_POSTCONDITION_FAILED');
      }

      const transaction = await db.balanceTransaction.create({
        data: {
          operationKey: `balance:grant-expiry:${grant.id}`,
          userId: grant.userId,
          tenantId: grant.tenantId,
          billingAccountId,
          type: PrismaTransactionType.ADJUST,
          amountUsd: nominalAmountUsd.neg(),
          balanceAfterUsd: wallet.balanceUsd,
          description: `balance grant expired:${grant.id}`,
          orderId: grant.orderId,
          ...(grant.productId ? { productId: grant.productId } : {}),
          createdAt: financialNow,
        },
      });
      await db.balanceGrantExpiry.create({
        data: {
          balanceGrantId: grant.id,
          billingAccountId,
          balanceTransactionId: transaction.id,
          nominalAmountUsd,
          nominalPaidUsd: components.paidRemainingUsd,
          nominalBonusUsd: components.bonusRemainingUsd,
          walletDebitUsd: nominalAmountUsd,
          walletDebitPaidUsd: components.paidRemainingUsd,
          walletDebitBonusUsd: components.bonusRemainingUsd,
          unbackedAmountUsd: new Prisma.Decimal(0),
          unbackedPaidUsd: new Prisma.Decimal(0),
          unbackedBonusUsd: new Prisma.Decimal(0),
          walletBalanceBeforeUsd: walletBalanceBeforeGrantUsd,
          walletBalanceAfterUsd: walletBalanceAfterGrantUsd,
          createdAt: financialNow,
        },
      });
      results.push({
        outcome: 'EXPIRED',
        id: grant.id,
        userId: grant.userId,
        tenantId: grant.tenantId,
        billingAccountId,
        nominalAmountUsd,
        walletDebitUsd: nominalAmountUsd,
        unbackedAmountUsd: new Prisma.Decimal(0),
      });
      walletBalanceBeforeGrantUsd = walletBalanceAfterGrantUsd;
    }

    await this.assertReconciledBalanceLedger(
      db,
      billingAccountId,
      financialNow,
      'balance grant expiry postcondition',
      false,
    );
    return results;
  }
  private async findConsumableBalanceGrants(
    db: Prisma.TransactionClient,
    billingAccountId: string,
    financialNow: Date,
    _productId?: string | null,
    options: {
      nonExpiringOnly?: boolean;
      createdAtLte?: Date;
    } = {},
  ): Promise<PrismaBalanceGrant[]> {
    // AccountWallet is an account-wide pool and the public recharge contract
    // allows the balance to fund all metered API/platform usage. productId on a
    // grant is attribution metadata, not a separate wallet. Filtering batches
    // here while debiting the global wallet can leave another product's grant
    // positive beside a negative wallet, violating wallet = grants - debt.
    const baseWhere = {
      billingAccountId,
      isExpired: false,
      validFrom: { lte: financialNow },
      remainingAmountUsd: { gt: new Prisma.Decimal(0) },
      ...(options.createdAtLte ? { createdAt: { lte: options.createdAtLte } } : {}),
    };
    const expiring = options.nonExpiringOnly ? [] : await db.balanceGrant.findMany({
      where: {
        ...baseWhere,
        // Expiry is never deferred, even for a DIRTY account. A due positive
        // grant has already caused expireAccountBalanceGrants to fail closed;
        // this predicate is a second authorization boundary against races.
        expiresAt: { gt: financialNow },
      },
      orderBy: [{ expiresAt: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    const nonExpiring = await db.balanceGrant.findMany({
      where: {
        ...baseWhere,
        expiresAt: null,
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
    });
    return [...expiring, ...nonExpiring];
  }

  private gatewayFundingGrantSlicePayload(
    slices: GatewayFundingGrantSlice[],
  ): Array<{
    balanceGrantId: string;
    amountUsd: string;
    allocationOrder: number;
  }> {
    return [...slices]
      .sort((left, right) => left.allocationOrder - right.allocationOrder)
      .map((slice) => ({
        balanceGrantId: slice.balanceGrantId,
        amountUsd: usd(slice.amountUsd).toFixed(12),
        allocationOrder: slice.allocationOrder,
      }));
  }

  private async assertGatewayFundingReservationGrantSlices(
    db: Prisma.TransactionClient,
    reservation: PrismaGatewayUsageFundingReservation,
  ): Promise<GatewayFundingGrantSlice[]> {
    const rows = await db.gatewayUsageFundingReservationGrant.findMany({
      where: { fundingReservationId: reservation.id },
      orderBy: { allocationOrder: 'asc' },
    });
    const slices = rows.map((row) => ({
      balanceGrantId: row.balanceGrantId,
      amountUsd: usd(row.amountUsd),
      allocationOrder: row.allocationOrder,
    }));
    const payload = reservation.canonicalPayload;
    const frozenPayload = payload
      && typeof payload === 'object'
      && !Array.isArray(payload)
      ? (payload as Record<string, unknown>).collectedGrantSlices
      : null;
    const canonicalSlices = this.gatewayFundingGrantSlicePayload(slices);
    const totalUsd = slices.reduce(
      (sum, slice) => sum.plus(slice.amountUsd),
      usd(0),
    ).toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
    if (
      !Array.isArray(frozenPayload)
      || canonicalGatewayFundingJson(frozenPayload)
        !== canonicalGatewayFundingJson(canonicalSlices)
      || !totalUsd.eq(usd(reservation.collectedUsd))
    ) {
      throw new ConflictException('Gateway funding reservation grant hold conflict');
    }
    return slices;
  }

  private async conservativeEnterpriseCreditUsedAtReceipt(
    db: Prisma.TransactionClient,
    billingAccountId: string,
    currentAccountBalanceUsd: Prisma.Decimal,
    currentCreditUsedUsd: Prisma.Decimal,
    creditLimitUsd: Prisma.Decimal,
    firstReceivedAt: Date,
  ): Promise<Prisma.Decimal> {
    if (creditLimitUsd.lte(0)) return usd(0);
    const laterTransactions = await db.balanceTransaction.aggregate({
      where: {
        billingAccountId,
        // Treat same-millisecond writes as post-receipt. Taking the maximum
        // with current credit use below makes either clock ambiguity
        // conservative: later funding cannot free frozen credit, while a later
        // debit cannot manufacture extra receipt-time capacity.
        createdAt: { gte: firstReceivedAt },
      },
      _sum: { amountUsd: true },
    });
    const reconstructedBalanceUsd = currentAccountBalanceUsd.minus(
      usd(laterTransactions._sum.amountUsd ?? 0),
    );
    const reconstructedCreditUsedUsd = this.minUsd(
      creditLimitUsd,
      this.maxUsd(usd(0), reconstructedBalanceUsd.neg()),
    );
    return this.minUsd(
      creditLimitUsd,
      this.maxUsd(currentCreditUsedUsd, reconstructedCreditUsedUsd),
    ).toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
  }

  private async allocateFromBalanceGrant(
    db: Prisma.TransactionClient,
    params: {
      grant: PrismaBalanceGrant;
      userId: string;
      tenantId: string;
      billingAccountId: string;
      productId?: string | null;
      balanceTransactionId: string;
      tokenUsageId?: string | null;
      amountUsd: Prisma.Decimal;
      financialNow: Date;
    },
  ): Promise<boolean> {
    const components = this.grantRemainingComponents(params.grant);
    if (!components.componentsPersisted) {
      const remainingAmountUsd = components.remainingUsd.minus(params.amountUsd);
      const updated = await db.balanceGrant.updateMany({
        where: {
          id: params.grant.id,
          billingAccountId: params.billingAccountId,
          isExpired: false,
          validFrom: { lte: params.financialNow },
          remainingAmountUsd: components.remainingUsd,
          remainingPaidAmountUsd: components.storedPaidRemainingUsd,
          remainingBonusAmountUsd: components.storedBonusRemainingUsd,
          OR: [
            { expiresAt: null },
            { expiresAt: { gt: params.financialNow } },
          ],
        },
        data: { remainingAmountUsd },
      });
      if (updated.count !== 1) return false;
      await this.markBalanceGrantLedgerDirty(
        db,
        params.billingAccountId,
        `unreconciled grant consumed without guessing components:${params.grant.id}`,
      );
      await db.balanceConsumptionAllocation.create({
        data: {
          userId: params.userId,
          tenantId: params.tenantId,
          billingAccountId: params.billingAccountId,
          ...(params.productId ? { productId: params.productId } : {}),
          balanceTransactionId: params.balanceTransactionId,
          tokenUsageId: params.tokenUsageId,
          balanceGrantId: params.grant.id,
          source: BALANCE_ALLOCATION_SOURCE_UNRECONCILED_GRANT,
          amountUsd: params.amountUsd,
          recognizedRevenueUsd: new Prisma.Decimal(0),
          bonusConsumedUsd: new Prisma.Decimal(0),
          discountRate: new Prisma.Decimal(0),
          approvedCreditUsd: new Prisma.Decimal(0),
          unapprovedDebtUsd: new Prisma.Decimal(0),
          fundingClassificationComplete: true,
          createdAt: params.financialNow,
        },
      });
      return true;
    }
    const {
      paidUsd: recognizedRevenueUsd,
      bonusUsd: bonusConsumedUsd,
    } = this.splitGrantDebitComponents(
      params.amountUsd,
      components.paidRemainingUsd,
      components.bonusRemainingUsd,
    );
    const discountRate = this.getDiscountRate(recognizedRevenueUsd, params.amountUsd);
    const remainingAmountUsd = components.remainingUsd.minus(params.amountUsd);
    const remainingPaidAmountUsd = components.paidRemainingUsd.minus(recognizedRevenueUsd);
    const remainingBonusAmountUsd = components.bonusRemainingUsd.minus(bonusConsumedUsd);

    const updated = await db.balanceGrant.updateMany({
      where: {
        id: params.grant.id,
        billingAccountId: params.billingAccountId,
        isExpired: false,
        validFrom: { lte: params.financialNow },
        remainingAmountUsd: components.remainingUsd,
        remainingPaidAmountUsd: components.storedPaidRemainingUsd,
        remainingBonusAmountUsd: components.storedBonusRemainingUsd,
        OR: [
          { expiresAt: null },
          { expiresAt: { gt: params.financialNow } },
        ],
      },
      data: {
        remainingAmountUsd,
        remainingPaidAmountUsd,
        remainingBonusAmountUsd,
      },
    });
    if (updated.count !== 1) {
      return false;
    }
    await db.balanceConsumptionAllocation.create({
      data: {
        userId: params.userId,
        tenantId: params.tenantId,
        billingAccountId: params.billingAccountId,
        ...(params.productId ? { productId: params.productId } : {}),
        balanceTransactionId: params.balanceTransactionId,
        tokenUsageId: params.tokenUsageId,
        balanceGrantId: params.grant.id,
        source: BALANCE_ALLOCATION_SOURCE_BALANCE_GRANT,
        amountUsd: params.amountUsd,
        recognizedRevenueUsd,
        bonusConsumedUsd,
        discountRate,
        approvedCreditUsd: new Prisma.Decimal(0),
        unapprovedDebtUsd: new Prisma.Decimal(0),
        fundingClassificationComplete: true,
        createdAt: params.financialNow,
      },
    });
    return true;
  }

  private async allocateEnterpriseCreditConsumption(
    db: Prisma.TransactionClient,
    params: {
      userId: string;
      tenantId: string;
      billingAccountId: string;
      productId?: string | null;
      balanceTransactionId: string;
      tokenUsageId?: string | null;
      amountUsd: Prisma.Decimal;
      approvedCreditUsd: Prisma.Decimal;
      unapprovedDebtUsd: Prisma.Decimal;
      financialNow: Date;
      enterpriseCreditPolicyAt?: Date;
      enterpriseCreditTermsDays?: number | null;
      enterpriseCreditPolicySnapshotComplete?: boolean;
    },
  ): Promise<void> {
    const amountUsd = params.amountUsd.toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
    if (amountUsd.lte(0)) return;
    const creditPolicySnapshotComplete = Boolean(
      params.enterpriseCreditPolicySnapshotComplete,
    );
    const creditPolicyAt = params.enterpriseCreditPolicyAt ?? params.financialNow;
    const approvedCreditUsd = params.approvedCreditUsd
      .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
    const unapprovedDebtUsd = params.unapprovedDebtUsd
      .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
    if (
      approvedCreditUsd.lt(0)
      || unapprovedDebtUsd.lt(0)
      || !approvedCreditUsd.plus(unapprovedDebtUsd).eq(amountUsd)
      || (approvedCreditUsd.gt(0) && unapprovedDebtUsd.gt(0))
    ) {
      throw new Error('ENTERPRISE_FUNDING_CLASSIFICATION_INVALID');
    }
    const creditTermsDays = approvedCreditUsd.gt(0)
      ? params.enterpriseCreditTermsDays ?? null
      : null;
    const creditDueAt = creditPolicySnapshotComplete
      && creditTermsDays !== null
      && creditTermsDays > 0
      ? new Date(creditPolicyAt.getTime() + creditTermsDays * ENTERPRISE_CREDIT_DAY_MS)
      : null;
    const allocation = await db.balanceConsumptionAllocation.create({
      data: {
        userId: params.userId,
        tenantId: params.tenantId,
        billingAccountId: params.billingAccountId,
        ...(params.productId ? { productId: params.productId } : {}),
        balanceTransactionId: params.balanceTransactionId,
        tokenUsageId: params.tokenUsageId,
        source: BALANCE_ALLOCATION_SOURCE_ENTERPRISE_CREDIT,
        amountUsd,
        recognizedRevenueUsd: new Prisma.Decimal(0),
        bonusConsumedUsd: new Prisma.Decimal(0),
        discountRate: new Prisma.Decimal(0),
        approvedCreditUsd,
        unapprovedDebtUsd,
        fundingClassificationComplete: true,
        creditPolicyAt,
        creditTermsDays,
        creditDueAt,
        creditPolicySnapshotComplete,
        createdAt: params.financialNow,
      },
    });
    this.assertDebtAllocationLedgerSequence(allocation);
  }

  private async allocateNegativeBalanceConsumption(
    db: Prisma.TransactionClient,
    params: {
      userId: string;
      tenantId: string;
      billingAccountId: string;
      productId?: string | null;
      balanceTransactionId: string;
      tokenUsageId?: string | null;
      amountUsd: Prisma.Decimal;
      financialNow: Date;
    },
  ): Promise<void> {
    const amountUsd = params.amountUsd.toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
    if (amountUsd.lte(0)) return;
    const allocation = await db.balanceConsumptionAllocation.create({
      data: {
        userId: params.userId,
        tenantId: params.tenantId,
        billingAccountId: params.billingAccountId,
        ...(params.productId ? { productId: params.productId } : {}),
        balanceTransactionId: params.balanceTransactionId,
        tokenUsageId: params.tokenUsageId,
        source: BALANCE_ALLOCATION_SOURCE_NEGATIVE_BALANCE,
        amountUsd,
        recognizedRevenueUsd: new Prisma.Decimal(0),
        bonusConsumedUsd: new Prisma.Decimal(0),
        discountRate: new Prisma.Decimal(0),
        approvedCreditUsd: new Prisma.Decimal(0),
        unapprovedDebtUsd: amountUsd,
        fundingClassificationComplete: true,
        createdAt: params.financialNow,
      },
    });
    this.assertDebtAllocationLedgerSequence(allocation);
  }

  private assertDebtAllocationLedgerSequence(
    allocation: { id: string; ledgerSequence?: bigint | null },
  ): void {
    if (
      allocation.ledgerSequence === null
      || allocation.ledgerSequence === undefined
      || allocation.ledgerSequence <= BigInt(0)
    ) {
      // 该异常发生在钱包事务内，必须让整笔消费/退款回滚，不能留下一个无法
      // 按真实钱包锁顺序核销的欠款事实。
      throw new Error(`BALANCE_DEBT_LEDGER_SEQUENCE_MISSING_ON_CREATE:${allocation.id}`);
    }
  }

  private async allocateBalanceConsumption(
    db: Prisma.TransactionClient,
    params: {
      userId: string;
      tenantId: string;
      billingAccountId: string;
      productId?: string | null;
      balanceTransactionId: string;
      tokenUsageId?: string | null;
      amountUsd: Prisma.Decimal;
      enterpriseApprovedCreditAmountUsd?: Prisma.Decimal;
      enterpriseUnapprovedDebtAmountUsd?: Prisma.Decimal;
      negativeBalanceAmountUsd?: Prisma.Decimal;
      financialNow: Date;
      gatewayFundingReservationId?: string;
      gatewayReservedGrantSlices?: GatewayFundingGrantSlice[];
      gatewayReservedCollectedAmountUsd?: Prisma.Decimal;
      gatewaySupplementalCollectedAmountUsd?: Prisma.Decimal;
      gatewaySupplementalFundingAt?: Date;
      enterpriseCreditPolicyAt?: Date;
      enterpriseCreditTermsDays?: number | null;
      enterpriseCreditPolicySnapshotComplete?: boolean;
    },
  ): Promise<void> {
    const enterpriseApprovedCreditAmountUsd = this.minUsd(
      params.amountUsd,
      this.maxUsd(
        new Prisma.Decimal(0),
        params.enterpriseApprovedCreditAmountUsd ?? new Prisma.Decimal(0),
      ),
    ).toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
    const enterpriseUnapprovedDebtAmountUsd = this.minUsd(
      params.amountUsd.minus(enterpriseApprovedCreditAmountUsd),
      this.maxUsd(
        new Prisma.Decimal(0),
        params.enterpriseUnapprovedDebtAmountUsd ?? new Prisma.Decimal(0),
      ),
    ).toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
    const negativeBalanceAmountUsd = this.minUsd(
      params.amountUsd
        .minus(enterpriseApprovedCreditAmountUsd)
        .minus(enterpriseUnapprovedDebtAmountUsd),
      this.maxUsd(
        new Prisma.Decimal(0),
        params.negativeBalanceAmountUsd ?? new Prisma.Decimal(0),
      ),
    ).toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
    const allocateNonGrantConsumption = async () => {
      await this.allocateEnterpriseCreditConsumption(db, {
        ...params,
        amountUsd: enterpriseApprovedCreditAmountUsd,
        approvedCreditUsd: enterpriseApprovedCreditAmountUsd,
        unapprovedDebtUsd: new Prisma.Decimal(0),
      });
      await this.allocateEnterpriseCreditConsumption(db, {
        ...params,
        amountUsd: enterpriseUnapprovedDebtAmountUsd,
        approvedCreditUsd: new Prisma.Decimal(0),
        unapprovedDebtUsd: enterpriseUnapprovedDebtAmountUsd,
      });
      await this.allocateNegativeBalanceConsumption(db, {
        ...params,
        amountUsd: negativeBalanceAmountUsd,
      });
    };
    const grantBackedAmountUsd = params.amountUsd
      .minus(enterpriseApprovedCreditAmountUsd)
      .minus(enterpriseUnapprovedDebtAmountUsd)
      .minus(negativeBalanceAmountUsd)
      .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
    if (grantBackedAmountUsd.lte(0)) {
      await allocateNonGrantConsumption();
      return;
    }
    const protectedGrantHolds = await db.gatewayUsageFundingReservationGrant.findMany({
      where: {
        ...(params.gatewayFundingReservationId
          ? { fundingReservationId: { not: params.gatewayFundingReservationId } }
          : {}),
        fundingReservation: {
          billingAccountId: params.billingAccountId,
          status: { in: ['ACTIVE', 'MANUAL_REVIEW'] },
        },
      },
      select: { balanceGrantId: true, amountUsd: true },
    });
    const protectedByGrantId = new Map<string, Prisma.Decimal>();
    for (const hold of protectedGrantHolds) {
      protectedByGrantId.set(
        hold.balanceGrantId,
        usd(protectedByGrantId.get(hold.balanceGrantId) ?? 0)
          .plus(hold.amountUsd)
          .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP),
      );
    }
    const allocateGrantSlice = async (
      amountUsd: Prisma.Decimal,
      eligibilityAt: Date,
      protectedByGrantId: ReadonlyMap<string, Prisma.Decimal> = new Map(),
    ): Promise<Prisma.Decimal> => {
      let remainingUsd = amountUsd;
      let sawGrantContention = false;
      for (let attempt = 0; attempt < BALANCE_GRANT_ALLOCATION_MAX_RETRIES; attempt += 1) {
        const grants = await this.findConsumableBalanceGrants(
          db,
          params.billingAccountId,
          eligibilityAt,
          params.productId,
        );
        let retryNeeded = false;
        for (const grant of grants) {
          if (remainingUsd.lte(0)) break;
          const protectedUsd = protectedByGrantId.get(grant.id) ?? usd(0);
          const allocatableUsd = this.maxUsd(
            usd(0),
            usd(grant.remainingAmountUsd).minus(protectedUsd),
          );
          if (allocatableUsd.lte(0)) continue;
          const allocationUsd = allocatableUsd.lt(remainingUsd)
            ? allocatableUsd
            : remainingUsd;
          const roundedAllocationUsd = allocationUsd.toDecimalPlaces(
            12,
            Prisma.Decimal.ROUND_HALF_UP,
          );
          if (roundedAllocationUsd.lte(0)) continue;
          const allocated = await this.allocateFromBalanceGrant(db, {
            ...params,
            grant,
            amountUsd: roundedAllocationUsd,
            financialNow: eligibilityAt,
          });
          if (!allocated) {
            sawGrantContention = true;
            retryNeeded = true;
            break;
          }
          remainingUsd = remainingUsd
            .minus(roundedAllocationUsd)
            .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
        }
        if (remainingUsd.lte(0) || !retryNeeded) break;
      }
      if (remainingUsd.gt(0) && sawGrantContention) {
        throw new Error('BALANCE_GRANT_ALLOCATION_CONFLICT');
      }
      return this.maxUsd(new Prisma.Decimal(0), remainingUsd);
    };

    const allocateReservedGrantSlices = async (
      amountUsd: Prisma.Decimal,
    ): Promise<void> => {
      if (amountUsd.lte(0)) return;
      if (
        !params.gatewayFundingReservationId
        || !params.gatewayReservedGrantSlices
      ) {
        throw new Error('GATEWAY_RESERVED_GRANT_SLICES_MISSING');
      }
      let remainingUsd = amountUsd;
      for (const slice of [...params.gatewayReservedGrantSlices]
        .sort((left, right) => left.allocationOrder - right.allocationOrder)) {
        if (remainingUsd.lte(0)) break;
        const allocationUsd = this.minUsd(
          slice.amountUsd,
          remainingUsd,
        ).toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
        if (allocationUsd.lte(0)) continue;
        const grant = await db.balanceGrant.findUnique({
          where: { id: slice.balanceGrantId },
        });
        if (
          !grant
          || grant.billingAccountId !== params.billingAccountId
          || grant.isExpired
          || grant.expiresAt !== null
          || grant.createdAt.getTime() > params.financialNow.getTime()
          || grant.validFrom.getTime() > params.financialNow.getTime()
          || usd(grant.remainingAmountUsd).lt(allocationUsd)
        ) {
          throw new Error('GATEWAY_RESERVED_GRANT_SLICE_CONFLICT');
        }
        const allocated = await this.allocateFromBalanceGrant(db, {
          ...params,
          grant,
          amountUsd: allocationUsd,
          financialNow: params.financialNow,
        });
        if (!allocated) {
          throw new Error('GATEWAY_RESERVED_GRANT_SLICE_CONFLICT');
        }
        remainingUsd = remainingUsd
          .minus(allocationUsd)
          .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
      }
      if (remainingUsd.gt(0)) {
        throw new Error('GATEWAY_RESERVED_GRANT_SLICE_CONFLICT');
      }
    };

    const reservedCollectedTargetUsd = params.gatewayReservedCollectedAmountUsd !== undefined
      ? this.minUsd(
          grantBackedAmountUsd,
          this.maxUsd(new Prisma.Decimal(0), params.gatewayReservedCollectedAmountUsd),
        )
      : new Prisma.Decimal(0);
    const supplementalCollectedTargetUsd = params.gatewaySupplementalCollectedAmountUsd
      ? this.minUsd(
          grantBackedAmountUsd.minus(reservedCollectedTargetUsd),
          this.maxUsd(new Prisma.Decimal(0), params.gatewaySupplementalCollectedAmountUsd),
        )
      : new Prisma.Decimal(0);
    const ordinaryCollectedTargetUsd = this.maxUsd(
      new Prisma.Decimal(0),
      grantBackedAmountUsd
        .minus(reservedCollectedTargetUsd)
        .minus(supplementalCollectedTargetUsd),
    );
    let unprovenGrantBackingUsd = new Prisma.Decimal(0);
    if (reservedCollectedTargetUsd.gt(0)) {
      await allocateReservedGrantSlices(reservedCollectedTargetUsd);
    }
    if (supplementalCollectedTargetUsd.gt(0)) {
      if (!params.gatewaySupplementalFundingAt) {
        throw new Error('GATEWAY_SUPPLEMENTAL_FUNDING_TIME_MISSING');
      }
      if (!params.gatewayFundingReservationId) {
        throw new Error('GATEWAY_FUNDING_RESERVATION_ID_MISSING');
      }
      const supplementalUnprovenUsd = await allocateGrantSlice(
        supplementalCollectedTargetUsd,
        params.gatewaySupplementalFundingAt,
        protectedByGrantId,
      );
      if (supplementalUnprovenUsd.gt(0)) {
        throw new Error('GATEWAY_SUPPLEMENTAL_GRANT_BACKING_MISSING');
      }
    }
    if (ordinaryCollectedTargetUsd.gt(0)) {
      unprovenGrantBackingUsd = unprovenGrantBackingUsd.plus(
        await allocateGrantSlice(
          ordinaryCollectedTargetUsd,
          params.financialNow,
          protectedByGrantId,
        ),
      );
    }

    if (unprovenGrantBackingUsd.lte(0)) {
      await allocateNonGrantConsumption();
      return;
    }

    // 钱包存在、但没有可证明的 grant 支撑时，不能凭空铸造一个 PAID 批次并
    // 确认收入。把差额放入 suspense allocation，保持钱包扣减事实，同时将
    // 收入归类留给对账修复。
    await db.balanceConsumptionAllocation.create({
      data: {
        userId: params.userId,
        tenantId: params.tenantId,
        billingAccountId: params.billingAccountId,
        ...(params.productId ? { productId: params.productId } : {}),
        balanceTransactionId: params.balanceTransactionId,
        tokenUsageId: params.tokenUsageId,
        source: BALANCE_ALLOCATION_SOURCE_UNRECONCILED_GRANT,
        amountUsd: unprovenGrantBackingUsd,
        recognizedRevenueUsd: new Prisma.Decimal(0),
        bonusConsumedUsd: new Prisma.Decimal(0),
        discountRate: new Prisma.Decimal(0),
        approvedCreditUsd: new Prisma.Decimal(0),
        unapprovedDebtUsd: new Prisma.Decimal(0),
        fundingClassificationComplete: true,
        createdAt: params.financialNow,
      },
    });
    await this.markBalanceGrantLedgerDirty(
      db,
      params.billingAccountId,
      `consumption exceeded provable grant backing:${params.balanceTransactionId}`,
    );
    await allocateNonGrantConsumption();
  }

  /**
   * 注资填坑金额：本次钱包增量中用于把负余额拉回 0 的部分（企业信用还款额）。
   * 由 incrementAccountWallet 的原子返回值反推增量前余额，无并发窗口。
   */
  private walletHoleFillUsd(
    balanceAfterUsd: Prisma.Decimal | DecimalLike,
    incrementUsd: Prisma.Decimal,
  ): Prisma.Decimal {
    if (incrementUsd.lte(0)) return new Prisma.Decimal(0);
    const after = usd(balanceAfterUsd);
    const before = after.minus(incrementUsd);
    if (before.gte(0)) return new Prisma.Decimal(0);
    return this.minUsd(incrementUsd, before.neg());
  }

  private async isEnterpriseBillingAccount(
    db: Prisma.TransactionClient | PrismaService,
    billingAccountId: string,
  ): Promise<boolean> {
    const account = await db.billingAccount.findUnique({
      where: { id: billingAccountId },
      select: { type: true },
    });
    return account?.type === ENTERPRISE_ACCOUNT_TYPE;
  }

  private async debtAllocationSourceForAccount(
    db: Prisma.TransactionClient,
    billingAccountId: string,
    fundingFillUsd: Prisma.Decimal,
  ): Promise<BalanceDebtAllocationSource | null> {
    if (fundingFillUsd.lte(0)) return null;
    return await this.isEnterpriseBillingAccount(db, billingAccountId)
      ? BALANCE_ALLOCATION_SOURCE_ENTERPRISE_CREDIT
      : BALANCE_ALLOCATION_SOURCE_NEGATIVE_BALANCE;
  }

  // Probe delegate. Prime suspect for the settleUsage cost: this reads four
  // unbounded per-account aggregates over balance_consumption_allocations
  // (700,421 rows for the hot account as of 2026-08-31) plus balance_grants.
  // Whether that is actually where the time goes is what the probe answers —
  // this file's history contains two cases of a plausible code-reading
  // attribution being falsified by measurement.
  private async readReconciledBalanceLedgerSnapshot(
    db: Prisma.TransactionClient,
    billingAccountId: string,
    allocationSource: BalanceDebtAllocationSource,
    financialNow: Date,
  ): Promise<ReconciledBalanceLedgerSnapshot> {
    return timed('ledSnapshot', () => this.readReconciledBalanceLedgerSnapshotInner(
      db,
      billingAccountId,
      allocationSource,
      financialNow,
    ));
  }

  private async readReconciledBalanceLedgerSnapshotInner(
    db: Prisma.TransactionClient,
    billingAccountId: string,
    allocationSource: BalanceDebtAllocationSource,
    financialNow: Date,
  ): Promise<ReconciledBalanceLedgerSnapshot> {
    const [row] = await db.$queryRaw<Array<{
      wallet_usd: Prisma.Decimal;
      active_grant_usd: Prisma.Decimal;
      open_debt_usd: Prisma.Decimal;
      pending_settlement_usd: Prisma.Decimal;
      invalid_grant_count: bigint;
      due_grant_count: bigint;
      invalid_debt_count: bigint;
      invalid_sequence_count: bigint;
      unexpected_debt_count: bigint;
    }>>`
      SELECT
        COALESCE((
          SELECT "balance_usd"
          FROM "account_wallets"
          WHERE "billing_account_id" = ${billingAccountId}
        ), 0) AS "wallet_usd",
        COALESCE((
          SELECT SUM("remaining_amount_usd")
          FROM "balance_grants"
          WHERE "billing_account_id" = ${billingAccountId}
            AND "is_expired" = FALSE
            AND "valid_from" <= ${financialNow}
            AND ("expires_at" IS NULL OR "expires_at" > ${financialNow})
        ), 0) AS "active_grant_usd",
        COALESCE((
          SELECT SUM("amount_usd" - "settled_usd")
          FROM "balance_consumption_allocations"
          WHERE "billing_account_id" = ${billingAccountId}
            AND "source" = ${allocationSource}
        ), 0) AS "open_debt_usd",
        COALESCE((
          SELECT SUM("remaining_paid_usd" + "remaining_bonus_usd")
          FROM "balance_debt_settlement_pending"
          WHERE "billing_account_id" = ${billingAccountId}
            AND "allocation_source" = ${allocationSource}
        ), 0) AS "pending_settlement_usd",
        (
          SELECT COUNT(*)
          FROM "balance_grants"
          WHERE "billing_account_id" = ${billingAccountId}
            AND (
              "remaining_amount_usd" < 0
              OR "remaining_paid_amount_usd" IS NULL
              OR "remaining_bonus_amount_usd" IS NULL
              OR "remaining_paid_amount_usd" < 0
              OR "remaining_bonus_amount_usd" < 0
              OR "remaining_amount_usd" <> "remaining_paid_amount_usd" + "remaining_bonus_amount_usd"
              OR "paid_amount_usd" + "bonus_amount_usd" <> "granted_amount_usd"
              OR "remaining_paid_amount_usd" > "paid_amount_usd"
              OR "remaining_bonus_amount_usd" > "bonus_amount_usd"
              OR "valid_from" > ${financialNow}
              OR ("is_expired" = TRUE AND "remaining_amount_usd" <> 0)
            )
        ) AS "invalid_grant_count",
        (
          SELECT COUNT(*)
          FROM "balance_grants"
          WHERE "billing_account_id" = ${billingAccountId}
            AND "is_expired" = FALSE
            AND "remaining_amount_usd" > 0
            AND "expires_at" IS NOT NULL
            AND "expires_at" <= ${financialNow}
        ) AS "due_grant_count",
        (
          SELECT COUNT(*)
          FROM "balance_consumption_allocations"
          WHERE "billing_account_id" = ${billingAccountId}
            AND "source" IN (
              ${BALANCE_ALLOCATION_SOURCE_NEGATIVE_BALANCE},
              ${BALANCE_ALLOCATION_SOURCE_ENTERPRISE_CREDIT}
            )
            AND (
              "amount_usd" <= 0
              OR "balance_grant_id" IS NOT NULL
              OR "discount_rate" <> 0
              OR "settled_usd" < 0
              OR "settled_usd" > "amount_usd"
              OR "recognized_revenue_usd" < 0
              OR "bonus_consumed_usd" < 0
              OR "recognized_revenue_usd" + "bonus_consumed_usd" <> "settled_usd"
              OR ("settled_usd" = "amount_usd")
                IS DISTINCT FROM ("settled_at" IS NOT NULL)
            )
        ) AS "invalid_debt_count",
        (
          SELECT COUNT(*)
          FROM "balance_consumption_allocations"
          WHERE "billing_account_id" = ${billingAccountId}
            AND "source" IN (
              ${BALANCE_ALLOCATION_SOURCE_NEGATIVE_BALANCE},
              ${BALANCE_ALLOCATION_SOURCE_ENTERPRISE_CREDIT}
            )
            AND ("ledger_sequence" IS NULL OR "ledger_sequence" = 0)
        ) AS "invalid_sequence_count",
        (
          SELECT COUNT(*)
          FROM "balance_consumption_allocations"
          WHERE "billing_account_id" = ${billingAccountId}
            AND "source" IN (
              ${BALANCE_ALLOCATION_SOURCE_NEGATIVE_BALANCE},
              ${BALANCE_ALLOCATION_SOURCE_ENTERPRISE_CREDIT}
            )
            AND "source" <> ${allocationSource}
        ) AS "unexpected_debt_count"`;
    if (!row) {
      throw new BalanceLedgerReconciliationRequiredError(
        billingAccountId,
        'canonical ledger snapshot unavailable',
        false,
      );
    }
    return {
      walletUsd: usd(row.wallet_usd),
      activeGrantUsd: usd(row.active_grant_usd),
      openDebtUsd: usd(row.open_debt_usd),
      pendingSettlementUsd: usd(row.pending_settlement_usd ?? 0),
      invalidGrantCount: row.invalid_grant_count ?? BigInt(0),
      dueGrantCount: row.due_grant_count ?? BigInt(0),
      invalidDebtCount: row.invalid_debt_count ?? BigInt(0),
      invalidSequenceCount: row.invalid_sequence_count ?? BigInt(0),
      unexpectedDebtCount: row.unexpected_debt_count ?? BigInt(0),
    };
  }

  // Probe delegate.
  private async reconciledBalanceLedgerContext(
    db: Prisma.TransactionClient,
    billingAccountId: string,
  ): Promise<{ reconciled: boolean; allocationSource: BalanceDebtAllocationSource }> {
    return timed('ledCtx', () => this
      .reconciledBalanceLedgerContextInner(db, billingAccountId));
  }

  private async reconciledBalanceLedgerContextInner(
    db: Prisma.TransactionClient,
    billingAccountId: string,
  ): Promise<{ reconciled: boolean; allocationSource: BalanceDebtAllocationSource }> {
    const account = await db.billingAccount.findUniqueOrThrow({
      where: { id: billingAccountId },
      select: {
        type: true,
        balanceGrantLedgerStatus: true,
        balanceGrantLedgerVersion: true,
      },
    });
    return {
      reconciled: (
        account.balanceGrantLedgerStatus === BALANCE_GRANT_LEDGER_STATUS_RECONCILED
        && account.balanceGrantLedgerVersion === BALANCE_GRANT_LEDGER_VERSION
      ),
      allocationSource: account.type === ENTERPRISE_ACCOUNT_TYPE
        ? BALANCE_ALLOCATION_SOURCE_ENTERPRISE_CREDIT
        : BALANCE_ALLOCATION_SOURCE_NEGATIVE_BALANCE,
    };
  }

  private assertReconciledBalanceLedgerSnapshot(
    billingAccountId: string,
    snapshot: ReconciledBalanceLedgerSnapshot,
    context: string,
    expectedOpenDebtUsd?: Prisma.Decimal,
    quarantineExistingLedger = true,
  ): void {
    const expectedGrantUsd = this.maxUsd(new Prisma.Decimal(0), snapshot.walletUsd);
    const expectedDebtUsd = expectedOpenDebtUsd
      ?? this.maxUsd(new Prisma.Decimal(0), snapshot.walletUsd.neg());
    if (
      !snapshot.activeGrantUsd.eq(expectedGrantUsd)
      || !snapshot.openDebtUsd.minus(snapshot.pendingSettlementUsd).eq(expectedDebtUsd)
      || snapshot.invalidGrantCount !== BigInt(0)
      || snapshot.dueGrantCount !== BigInt(0)
      || snapshot.invalidDebtCount !== BigInt(0)
      || snapshot.invalidSequenceCount !== BigInt(0)
      || snapshot.unexpectedDebtCount !== BigInt(0)
    ) {
      throw new BalanceLedgerReconciliationRequiredError(
        billingAccountId,
        `${context}:wallet=${snapshot.walletUsd.toFixed(12)}:`
        + `activeGrant=${snapshot.activeGrantUsd.toFixed(12)}:`
        + `openDebt=${snapshot.openDebtUsd.toFixed(12)}:`
        + `pendingSettlement=${snapshot.pendingSettlementUsd.toFixed(12)}:`
        + `invalidGrant=${snapshot.invalidGrantCount}:dueGrant=${snapshot.dueGrantCount}:`
        + `invalidDebt=${snapshot.invalidDebtCount}:invalidSequence=${snapshot.invalidSequenceCount}:`
        + `unexpectedDebt=${snapshot.unexpectedDebtCount}`,
        quarantineExistingLedger,
      );
    }
  }

  // Probe delegate. Called from ~20 sites including both hot-path stages
  // (reserveFunding and settleUsage), so `count` separates "one expensive call"
  // from "called many times". Its self time excludes ledCtx/ledSnapshot, which
  // are probed separately and nest inside it.
  private async assertReconciledBalanceLedger(
    db: Prisma.TransactionClient,
    billingAccountId: string,
    financialNow: Date,
    context: string,
    quarantineExistingLedger = true,
  ): Promise<void> {
    return timed('ledAssert', () => this.assertReconciledBalanceLedgerInner(
      db,
      billingAccountId,
      financialNow,
      context,
      quarantineExistingLedger,
    ));
  }

  private async assertReconciledBalanceLedgerInner(
    db: Prisma.TransactionClient,
    billingAccountId: string,
    financialNow: Date,
    context: string,
    quarantineExistingLedger = true,
  ): Promise<void> {
    const ledger = await this.reconciledBalanceLedgerContext(db, billingAccountId);
    if (!ledger.reconciled) return;
    const snapshot = await this.readReconciledBalanceLedgerSnapshot(
      db,
      billingAccountId,
      ledger.allocationSource,
      financialNow,
    );
    this.assertReconciledBalanceLedgerSnapshot(
      billingAccountId,
      snapshot,
      context,
      undefined,
      quarantineExistingLedger,
    );
  }

  /**
   * Enterprise terminal usage can cross the approved-credit boundary and is
   * therefore recorded as two immutable allocations: approved receivable
   * first, followed by unapproved debt. Repayment must clear the unapproved
   * exposure first; otherwise strict ledger FIFO would keep the account
   * fail-closed even after its wallet returns inside the approved credit line.
   *
   * Historical allocations deliberately have no funding classification. They
   * remain ahead of known approved receivables so an unknown legacy liability
   * is never silently treated as approved credit. FIFO is preserved within
   * every classification bucket.
   *
   * 分批用 keyset 游标而不是纯 settledAt IS NULL 过滤:候选索引是
   * (billing_account_id, ledger_sequence),没有游标时每批都要从该账户区间头部
   * 重新扫、靠 Filter 跳过本事务里刚核销掉的行,第 N 批要跳约 200N 行 ⇒
   * 总扫描量 O(K²/400)。国内 prod 实测单遍扫描 0.44µs/行,60 万行的账户
   * 光这一项就约 395 秒。游标把它降回 O(K)。
   *
   * 游标按桶各自维护(cursors 由调用方持有):桶之间 ledger_sequence 可能交错,
   * 共用一个游标会漏掉后续桶里序号更小的行。
   */
  private async findNextBalanceDebtSettlementBatch(
    db: Prisma.TransactionClient,
    billingAccountId: string,
    allocationSource: BalanceDebtAllocationSource,
    cursors?: Map<string, bigint>,
    exhausted?: Set<string>,
  ) {
    const baseWhere: Prisma.BalanceConsumptionAllocationWhereInput = {
      billingAccountId,
      source: allocationSource,
      settledAt: null,
    };
    const orderBy: Prisma.BalanceConsumptionAllocationOrderByWithRelationInput[] = [
      { ledgerSequence: 'asc' },
      { id: 'asc' },
    ];
    // 游标只做「跳过已处理段」的下界,不改变过滤语义:settledAt IS NULL 仍在,
    // 所以即便游标缺失(cursors 未传)行为也与原实现一致。
    const afterCursor = (key: string): Prisma.BalanceConsumptionAllocationWhereInput => {
      const seen = cursors?.get(key);
      return seen === undefined ? {} : { ledgerSequence: { gt: seen } };
    };

    if (allocationSource !== BALANCE_ALLOCATION_SOURCE_ENTERPRISE_CREDIT) {
      return {
        cursorKey: 'default',
        allocations: await db.balanceConsumptionAllocation.findMany({
          where: { ...baseWhere, ...afterCursor('default') },
          orderBy,
          take: BALANCE_DEBT_SETTLEMENT_BATCH,
        }),
      };
    }

    const priorityBuckets: Prisma.BalanceConsumptionAllocationWhereInput[] = [
      {
        fundingClassificationComplete: true,
        unapprovedDebtUsd: { gt: 0 },
      },
      {
        fundingClassificationComplete: false,
      },
      {
        fundingClassificationComplete: true,
        approvedCreditUsd: { gt: 0 },
      },
    ];
    for (const [index, bucket] of priorityBuckets.entries()) {
      const cursorKey = `bucket:${index}`;
      // 空桶不会再变回非空:核销只写 settled_usd / settled_at /
      // recognized_revenue_usd / bonus_consumed_usd,从不写
      // funding_classification_complete / unapproved_debt_usd / approved_credit_usd,
      // 而桶谓词只依赖后者加 settled_at IS NULL ⇒ 行只会离开候选集、不会进入。
      // 不跳过的代价是实打实的:国内 prod 实测 bucket0 恒空,但它没有游标可推进
      // (游标只在命中桶上前进),每批都要 Bitmap Heap Scan 掉 191,940 行、2.8 万个堆页、
      // 108ms 才能确认它是空的 —— 全额核销 1,466 批即白烧 158 秒。
      if (exhausted?.has(cursorKey)) continue;
      const allocations = await db.balanceConsumptionAllocation.findMany({
        where: { ...baseWhere, ...bucket, ...afterCursor(cursorKey) },
        orderBy,
        take: BALANCE_DEBT_SETTLEMENT_BATCH,
      });
      if (allocations.length > 0) {
        return { cursorKey, allocations };
      }
      exhausted?.add(cursorKey);
    }
    return { cursorKey: 'bucket:none', allocations: [] };
  }

  /**
   * 记住本批已处理到的 ledger_sequence，供下一批做 keyset 下界。
   * cursorKey 由批次查询原样给出，不做字段反推 —— 反推一旦与桶谓词不一致，
   * 游标就会记到错的桶上并漏行。
   */
  private advanceBalanceDebtSettlementCursor(
    cursors: Map<string, bigint>,
    cursorKey: string,
    allocations: Array<{ ledgerSequence: bigint | null }>,
  ): void {
    for (const allocation of allocations) {
      // RECONCILED_V2 下 ledgerSequence 不应为 NULL(核销前已有 unsequencedOpenDebt 前置校验)。
      // 真出现就不推进游标，退回全量过滤 —— 慢，但绝不漏行。
      if (allocation.ledgerSequence == null) continue;
      const seen = cursors.get(cursorKey);
      if (seen === undefined || allocation.ledgerSequence > seen) {
        cursors.set(cursorKey, allocation.ledgerSequence);
      }
    }
  }

  /**
   * Release only the debt restriction whose own BALANCE Gateway usage has a
   * complete, fully repaid unapproved-debt classification. Other restrictions
   * (including evidence conflicts) remain independent and active. Updating the
   * durable restriction in the funding transaction lets the existing database
   * outbox trigger project the release without a commit-before-publish gap.
   */
  private async releaseRepaidGatewayBalanceDebtRestrictions(
    db: Prisma.TransactionClient,
    billingAccountId: string,
    financialNow: Date,
  ): Promise<void> {
    const gatewayEventWhere: Prisma.GatewayBillingEventWhereInput = {
      status: 'DEBT_OPEN',
      billingUnit: 'BALANCE',
      evidenceVerdict: { not: 'CONFLICTED' },
      reconciliationStatus: { not: 'MANUAL_REVIEW' },
      tokenUsage: {
        is: {
          customerFundingClassificationComplete: true,
        },
      },
    };
    const candidates = await db.billingAccessRestriction.findMany({
      where: {
        billingAccountId,
        status: 'ACTIVE',
        reason: 'debt_open',
        gatewayBillingEvent: { is: gatewayEventWhere },
      },
      select: {
        id: true,
        gatewayBillingEvent: {
          select: {
            tokenUsage: {
              select: {
                consumptionAllocations: {
                  where: {
                    billingAccountId,
                    source: {
                      in: [
                        BALANCE_ALLOCATION_SOURCE_ENTERPRISE_CREDIT,
                        BALANCE_ALLOCATION_SOURCE_NEGATIVE_BALANCE,
                      ],
                    },
                  },
                  select: {
                    fundingClassificationComplete: true,
                    unapprovedDebtUsd: true,
                    settledUsd: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    const releasableIds = candidates.flatMap((restriction) => {
      const allocations = restriction.gatewayBillingEvent?.tokenUsage
        ?.consumptionAllocations ?? [];
      if (
        allocations.length === 0
        || allocations.some((allocation) => !allocation.fundingClassificationComplete)
      ) {
        return [];
      }
      const unapprovedAllocations = allocations.filter((allocation) => (
        usd(allocation.unapprovedDebtUsd).gt(0)
      ));
      if (
        unapprovedAllocations.length === 0
        || unapprovedAllocations.some((allocation) => (
          usd(allocation.settledUsd).lt(usd(allocation.unapprovedDebtUsd))
        ))
      ) {
        return [];
      }
      return [restriction.id];
    });
    if (releasableIds.length === 0) return;

    await db.billingAccessRestriction.updateMany({
      where: {
        id: { in: releasableIds },
        billingAccountId,
        status: 'ACTIVE',
        reason: 'debt_open',
        // Re-evaluate the event state atomically with the update so concurrent
        // evidence conflict/manual-review transitions remain fail-closed.
        gatewayBillingEvent: { is: gatewayEventWhere },
      },
      data: {
        status: 'RELEASED',
        releasedAt: financialNow,
        releasedBy: 'SYSTEM',
        releaseReason: 'balance_unapproved_debt_repaid',
      },
    });
  }

  /**
   * 授信恢复后解除 debt_open 关闸 —— 与「实付核销解限」是两条独立的路。
   *
   * 为什么要单独一条：releaseRepaidGatewayBalanceDebtRestrictions 的判据是
   * 「该笔未批准欠款已被实付资金核销」，与授信是否恢复无关。国内 prod
   * 2026-08-28 实测后果：运营 09:27 已把 config 改回 ACTIVE，客户仍然打不通，
   * 一直等到 13:21 那笔充值到账、桶优先级先核销掉那 0.29 才解封 —— 中间 4 小时
   * 是白断的。业务已明确（亚明总 2026-09-02）：授信恢复即恢复服务，
   * 不必等钱到账，即「能不能用」与「有没有还钱」解耦。
   *
   * 只改关闸，不动账：那些 allocation 仍是 unapproved_debt（留在核销桶序的 B1），
   * 下一笔还款照旧优先冲它们。本方法一个财务字段都不写。
   *
   * releaseReason 用新值 policy_restored，绝不复用 balance_unapproved_debt_repaid ——
   * 后者在审计上断言「已被实付核销」，这里并没有收到钱，续用等于谎报。
   *
   * 三道 fail-closed 守卫与实付核销那条**逐字相同**，一条都不放宽：
   * 事件仍须 DEBT_OPEN / billingUnit=BALANCE / evidenceVerdict≠CONFLICTED /
   * reconciliationStatus≠MANUAL_REVIEW / TokenUsage 分类完整；updateMany 再带一遍谓词做原子重校验。
   *
   * 额度覆盖判据（B）刻意自己算，不复用 getWorkspaceBalanceSnapshot 的
   * creditRemainingUsd —— 那个量是 max(0, limit − min(limit, |钱包负数|))，
   * 在欠款超过额度时恒为 0，看不出超了多少，拿它当「额度足以覆盖」的证明
   * 恰好在最该拦住的超额场景下 fail-open（codex 2026-09-02 复审指出，已实测确认）。
   * 而且它对 reservation / grant hold 零引用。这里必须把在途预占算进敞口，
   * 否则「额度刚好等于当前欠款」的账户会在解封后立刻被在途用量再次打穿。
   */
  async releasePolicyRestoredGatewayBalanceDebtRestrictions(
    db: Prisma.TransactionClient,
    billingAccountId: string,
  ): Promise<number> {
    // 锁序必须与所有其它资金变更一致：wallet → account → config。
    // overdue worker 的 lockCreditAggregate 与 enterprise-account 的
    // lockExistingEnterpriseAccount 都是这个顺序；若这里先读 config 再读 wallet，
    // 两条路会反向获取同一对行而死锁。所以钱包行的 FOR UPDATE 放在最前面,
    // 顺带把 B 条要用的余额一次拿到。
    const walletRows = await db.$queryRaw<Array<{ balance_usd: Prisma.Decimal }>>`
      SELECT "balance_usd" FROM "account_wallets"
      WHERE "billing_account_id" = ${billingAccountId}
      FOR UPDATE`;
    if (walletRows.length !== 1) return 0;
    // config 行再单独持锁 —— 与 confirmCreditPolicyBoundary 的写法对齐。
    // 严格说钱包锁已经够（全仓 11 处 config 写入点实测无一例外都先锁钱包），
    // 但那是个需要人工维护的前提；这一行让本方法不依赖它，属纵深防御。
    await db.$queryRaw`
      SELECT "billing_account_id"
      FROM "billing_account_credit_configs"
      WHERE "billing_account_id" = ${billingAccountId}
      FOR UPDATE`;
    // 审计时间戳一律取库内时钟并按毫秒截断，与 capturePolicyClock 同口径。
    // 刻意不做成入参：两个调用方手上只有应用时钟，暴露参数就等于邀请别人
    // 把 new Date() 写进 released_at —— 这个仓库到处都在强调不得从应用时钟
    // 推断写入顺序，审计字段更不该破例。
    const clockRows = await db.$queryRaw<Array<{ financialNow: Date }>>`
      SELECT date_trunc(
        'milliseconds',
        clock_timestamp() AT TIME ZONE 'UTC'
      )::TIMESTAMP(3) AS "financialNow"`;
    const financialNow = clockRows[0]?.financialNow;
    if (!(financialNow instanceof Date) || Number.isNaN(financialNow.getTime())) {
      throw new Error(
        `ENTERPRISE_CREDIT_POLICY_RESTORE_CLOCK_UNAVAILABLE:${billingAccountId}`,
      );
    }
    const account = await db.billingAccount.findUnique({
      where: { id: billingAccountId },
      select: { type: true, creditConfig: true },
    });
    if (!account || account.type !== ENTERPRISE_ACCOUNT_TYPE) return 0;
    const config = account.creditConfig;
    // A：授信必须当前有效。活额度函数已包含 status=ACTIVE、termsDays>0
    // 和 effectiveAt/expiresAt 有效窗口三项，零额度直接不放行。
    const creditLimitUsd = this.activeEnterpriseCreditLimitUsd(
      account.type,
      config,
      financialNow,
    );
    if (creditLimitUsd.lte(0)) return 0;
    // 提交边界未确认时不得解封：此时网关看到的额度可能还是旧的，
    // 放行会让客户在网关侧再撞一次拒绝。
    if (!config?.policyBoundaryComplete) return 0;
    // 当前 revision 的 Key 投影必须已经可靠入队，否则网关还不知道授信回来了。
    // 不是活锁风险：overdue worker 每轮都会补 fanout 并写 marker（第 2 段恢复逻辑），
    // 而本方法也由同一 worker 每轮兜底调用，所以补上后的下一轮就会放行。
    const currentEvent = await db.billingAccountCreditEvent.findUnique({
      where: {
        billingAccountId_policyRevision: {
          billingAccountId,
          policyRevision: config.policyRevision,
        },
      },
      select: { policyFanoutEnqueuedAt: true },
    });
    if (!currentEvent?.policyFanoutEnqueuedAt) return 0;

    // B：额度必须覆盖「当前钱包欠款 + 在途预占」。
    // 在途口径沿用既有的 ACTIVE/MANUAL_REVIEW 预占集合（本文件另外三处同款谓词），
    // 按 reserved − collected 取未落地部分，负数归零。钱包余额在方法开头已持锁读到。
    const walletDebtUsd = this.maxUsd(
      new Prisma.Decimal(0),
      usd(walletRows[0].balance_usd).neg(),
    );
    const liveReservations = await db.gatewayUsageFundingReservation.aggregate({
      where: {
        billingAccountId,
        status: { in: ['ACTIVE', 'MANUAL_REVIEW'] },
      },
      _sum: { reservedAmountUsd: true, collectedUsd: true },
    });
    const inFlightExposureUsd = this.maxUsd(
      new Prisma.Decimal(0),
      usd(liveReservations._sum.reservedAmountUsd ?? 0)
        .minus(usd(liveReservations._sum.collectedUsd ?? 0)),
    );
    if (creditLimitUsd.lt(walletDebtUsd.plus(inFlightExposureUsd))) return 0;

    // C/D/E：逐条关闸的判据。与实付核销那条唯一的差别是 E ——
    // 这里只放行 ENTERPRISE_CREDIT 欠款；NEGATIVE_BALANCE 是个人透支，
    // 企业额度不能覆盖它，混进来会把个人欠款也解封。
    const gatewayEventWhere: Prisma.GatewayBillingEventWhereInput = {
      status: 'DEBT_OPEN',
      billingUnit: 'BALANCE',
      evidenceVerdict: { not: 'CONFLICTED' },
      reconciliationStatus: { not: 'MANUAL_REVIEW' },
      tokenUsage: {
        is: { customerFundingClassificationComplete: true },
      },
    };
    const candidates = await db.billingAccessRestriction.findMany({
      where: {
        billingAccountId,
        status: 'ACTIVE',
        reason: 'debt_open',
        gatewayBillingEvent: { is: gatewayEventWhere },
      },
      select: {
        id: true,
        gatewayBillingEvent: {
          select: {
            tokenUsage: {
              select: {
                consumptionAllocations: {
                  where: { billingAccountId },
                  select: {
                    source: true,
                    fundingClassificationComplete: true,
                    unapprovedDebtUsd: true,
                  },
                },
              },
            },
          },
        },
      },
    });
    const releasableIds = candidates.flatMap((restriction) => {
      const allocations = restriction.gatewayBillingEvent?.tokenUsage
        ?.consumptionAllocations ?? [];
      const debtAllocations = allocations.filter((allocation) => (
        allocation.source === BALANCE_ALLOCATION_SOURCE_ENTERPRISE_CREDIT
        || allocation.source === BALANCE_ALLOCATION_SOURCE_NEGATIVE_BALANCE
      ));
      if (
        debtAllocations.length === 0
        || debtAllocations.some((allocation) => !allocation.fundingClassificationComplete)
      ) {
        return [];
      }
      // E：出现任何个人透支欠款就整条不放行,宁可不解封也不越权。
      if (
        debtAllocations.some((allocation) => (
          allocation.source === BALANCE_ALLOCATION_SOURCE_NEGATIVE_BALANCE
        ))
      ) {
        return [];
      }
      if (
        !debtAllocations.some((allocation) => usd(allocation.unapprovedDebtUsd).gt(0))
      ) {
        return [];
      }
      return [restriction.id];
    });
    if (releasableIds.length === 0) return 0;

    // F：与实付核销那条同款的原子重校验 —— 并发的 CONFLICTED/MANUAL_REVIEW
    // 迁移必须仍然 fail-closed。
    const released = await db.billingAccessRestriction.updateMany({
      where: {
        id: { in: releasableIds },
        billingAccountId,
        status: 'ACTIVE',
        reason: 'debt_open',
        gatewayBillingEvent: { is: gatewayEventWhere },
      },
      data: {
        status: 'RELEASED',
        releasedAt: financialNow,
        releasedBy: 'SYSTEM',
        releaseReason: 'enterprise_credit_policy_restored',
      },
    });
    if (released.count > 0) {
      this.logger.log(
        `enterprise credit policy restored release account=${billingAccountId} `
        + `released=${released.count} creditLimitUsd=${creditLimitUsd.toFixed(12)} `
        + `walletDebtUsd=${walletDebtUsd.toFixed(12)} `
        + `inFlightExposureUsd=${inFlightExposureUsd.toFixed(12)}`,
      );
    }
    return released.count;
  }

  /**
   * 余额欠款核销：注资（充值/管理员调整/代金券/赠送）填平负余额的部分，
   * 个人欠款按 FIFO；企业先冲未批准欠款，再处理历史未分类债务和账期应收，
   * 各分类内部按 FIFO 冲抵。
   *
   * 会计口径：
   * - 实付资金确认收入（recognizedRevenueUsd）；
   * - 赠金/代金券不确认收入，计入 bonusConsumedUsd；
   * - 每笔核销写 enterprise_credit_settlements（历史表名）并关联还款流水、
   *   消费分摊及被压缩可用额的充值批次；
   * - CLEAN 账户的填坑额必须被可追溯分摊精确核销；任何一分漂移都抛错，
   *   让外层钱包、批次、流水与 settlement 整体回滚。
   *
   * 必须在注资事务内调用：钱包行锁已由 increment 持有，与并发扣费天然互斥。
   */
  /**
   * 把一批欠款核销写入合并成 3 条语句(原本是每行 2 条)。
   *
   * 增量语义原样保留 —— SQL 里写 `settled_usd + v.apply_usd` 而不是在应用侧算好绝对值,
   * 这样与原先的 `{ increment: }` 完全等价,也不依赖读到的快照与行现值一致。
   *
   * 必须逐行满足 guard_balance_consumption_allocation_financial_rewrite 的放行条件:
   *   recognized_revenue_usd / bonus_consumed_usd / settled_usd 单调不减
   *   recognized_revenue_usd + bonus_consumed_usd = settled_usd
   *   settled_usd <= amount_usd
   *   settled_at 非空 ⟺ settled_usd = amount_usd
   * 由于 apply_paid + apply_bonus = apply_usd,三列同步增加即可保持恒等式;
   * 原代码在 apply 为 0 时省略该列的 increment,加 0 与不加数值上等价
   * (guard 用 IS DISTINCT FROM 判定,值不变就不算 rewrite)。
   */
  private async flushBalanceDebtSettlementBatch(
    db: Prisma.TransactionClient,
    financialNow: Date,
    settledAllocationIds: string[],
    allocationWrites: BalanceDebtAllocationWrite[],
    settlementRows: Prisma.EnterpriseCreditSettlementCreateManyInput[],
  ): Promise<void> {
    // openUsd <= 0 的行只补 settled_at。此时 amount - settled <= 0,而 guard 另有
    // settled_usd <= amount_usd,两者合起来即 settled_usd = amount_usd,满足双向条件。
    if (settledAllocationIds.length > 0) {
      const marked = await db.balanceConsumptionAllocation.updateMany({
        where: { id: { in: settledAllocationIds } },
        data: { settledAt: financialNow },
      });
      if (marked.count !== settledAllocationIds.length) {
        throw new Error(
          'BALANCE_DEBT_SETTLEMENT_MARK_ROWCOUNT_MISMATCH:'
          + `expected=${settledAllocationIds.length}:updated=${marked.count}`,
        );
      }
    }

    if (allocationWrites.length > 0) {
      // 数值一律以 12 位定点字符串传参再 ::numeric(20,12),避免走 JS 浮点。
      // 时间戳传 ISO 串再 ::timestamp(3):该列是 without time zone 且库里存 UTC,
      // Postgres 解析 ISO 时会忽略 Z,得到的正是 Prisma 写入的同一个裸 UTC 值。
      const values = Prisma.join(
        allocationWrites.map((write) => Prisma.sql`(
          ${write.id}::text,
          ${write.applyUsd.toFixed(12)}::numeric(20,12),
          ${write.applyPaidUsd.toFixed(12)}::numeric(20,12),
          ${write.applyBonusUsd.toFixed(12)}::numeric(20,12),
          ${write.markSettled}::boolean
        )`),
      );
      // 组合成单个 Prisma.Sql 再传入(而不是直接用标签模板),这样参数是扁平的、
      // 受影响行数可被如实校验,单测也不必去解析标签模板的内部结构。
      const query = Prisma.sql`
        UPDATE "balance_consumption_allocations" AS a
        SET "settled_usd" = a."settled_usd" + v.apply_usd,
            "recognized_revenue_usd" = a."recognized_revenue_usd" + v.apply_paid_usd,
            "bonus_consumed_usd" = a."bonus_consumed_usd" + v.apply_bonus_usd,
            "settled_at" = CASE
              WHEN v.mark_settled THEN ${financialNow.toISOString()}::timestamp(3)
              ELSE a."settled_at"
            END
        FROM (VALUES ${values})
          AS v(id, apply_usd, apply_paid_usd, apply_bonus_usd, mark_settled)
        WHERE a."id" = v.id
      `;
      const updated = await db.$executeRaw(query);
      // 注意这不是并发检测:并发 UPDATE 后该行仍按 id 匹配并计入。
      // 真正会导致对不上的是目标行被删除/不存在、VALUES 里出现重复 id,
      // 或将来新增了会静默跳过的 BEFORE 触发器(RETURN NULL)。
      // 任一情形都意味着候选集与实际行不再对应,继续走下去会让后置条件与账本
      // 对不上,直接让外层事务回滚。
      if (updated !== allocationWrites.length) {
        throw new Error(
          'BALANCE_DEBT_SETTLEMENT_BATCH_ROWCOUNT_MISMATCH:'
          + `expected=${allocationWrites.length}:updated=${updated}`,
        );
      }
    }

    if (settlementRows.length > 0) {
      await db.enterpriseCreditSettlement.createMany({ data: settlementRows });
    }
  }

  private async settleBalanceDebtOnFunding(
    db: Prisma.TransactionClient,
    params: {
      billingAccountId: string;
      allocationSource: BalanceDebtAllocationSource;
      repaymentTransactionId: string | null;
      balanceGrantId?: string | null;
      paidFillUsd: Prisma.Decimal;
      bonusFillUsd: Prisma.Decimal;
      financialNow: Date;
      // A composite funding operation can settle paid and bonus legs with
      // separate immutable repayment transactions. The first leg declares
      // how much fill the later leg must still settle.
      pendingFillAfterUsd?: Prisma.Decimal;
      // Business occurrence may intentionally predate the wallet mutation
      // (for example a replayed scheduled award). createdAt always remains
      // financialNow so write chronology is never inferred from application
      // or PostgreSQL transaction-start clocks.
      occurredAt?: Date;
      repairRunId?: string | null;
      operationKeyPrefix?: string;
      trigger?: string;
    },
  ): Promise<Prisma.Decimal> {
    // The stage-timing probe only records inside the Kafka consumer, which is
    // where runWithStageTimings() establishes a collector. Every other caller —
    // adjust(), issueVoucher(), creditBonus(), the residual sweep — reaches
    // this method over HTTP with no collector, so `debtSettle` is a plain
    // pass-through there and contributes nothing.
    //
    // That is precisely the path the 60s transaction budget overrun lives on,
    // so it gets its own log line rather than relying on the probe. Failures
    // were already observable (thrown error, persisted AlertEvent, order moved
    // to FAILED); what was missing is the *successful* case — how many rows a
    // real settlement touched and how close it ran to the budget. Without that
    // there is no way to confirm the 2026-08-28 batching actually moved the
    // worst case from hundreds of seconds into budget, only that it stopped
    // throwing.
    const startedAt = process.hrtime.bigint();
    const stats: BalanceDebtSettlementStats = {
      batches: 0,
      allocationsScanned: 0,
      allocationsUpdated: 0,
      settlementRowsInserted: 0,
      pendingEnqueuedUsd: new Prisma.Decimal(0),
    };
    const elapsedMs = (): number => Number(process.hrtime.bigint() - startedAt) / 1e6;
    try {
      const settled = await timed(
        'debtSettle',
        () => this.settleBalanceDebtOnFundingInner(db, params, stats),
      );
      // Only worth a line when it actually did work; a no-op early return
      // (nothing owed) would otherwise flood every deduct on every account.
      if (stats.allocationsScanned > 0) {
        this.logger.log(
          `balance debt settlement account=${params.billingAccountId} `
          + `source=${params.allocationSource} trigger=${params.trigger ?? 'unset'} `
          + `outcome=ok batches=${stats.batches} `
          + `scanned=${stats.allocationsScanned} updated=${stats.allocationsUpdated} `
          + `settlementRows=${stats.settlementRowsInserted} `
          + `pendingEnqueuedUsd=${stats.pendingEnqueuedUsd.toFixed(12)} `
          + `settledUsd=${settled.toFixed(12)} `
          + `paidFillUsd=${params.paidFillUsd.toFixed(12)} `
          + `bonusFillUsd=${params.bonusFillUsd.toFixed(12)} `
          + `durationMs=${elapsedMs().toFixed(0)} `
          // Share of BALANCE_LEDGER_TRANSACTION_OPTIONS.timeout consumed by this
          // method alone. The enclosing transaction does more than this, so a
          // figure well under 100% is not by itself proof of headroom — read it
          // with the outer line's transaction duration.
          + `budgetPct=${this.balanceDebtSettlementBudgetPct(elapsedMs())}`,
        );
      }
      return settled.plus(stats.pendingEnqueuedUsd);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `balance debt settlement account=${params.billingAccountId} `
        + `source=${params.allocationSource} trigger=${params.trigger ?? 'unset'} `
        + `outcome=error batches=${stats.batches} `
        + `scanned=${stats.allocationsScanned} updated=${stats.allocationsUpdated} `
        + `settlementRows=${stats.settlementRowsInserted} `
        + `durationMs=${elapsedMs().toFixed(0)} `
        + `budgetPct=${this.balanceDebtSettlementBudgetPct(elapsedMs())} `
        + `error=${message}`,
      );
      throw err;
    }
  }

  /**
   * Finds the earliest still-unreserved BALANCE receipt that must be funded
   * before this one, or nothing when this receipt is at the head of the queue.
   *
   * Two implementations, because the obvious one is O(the account's entire
   * anchor history) on its normal path:
   *
   * - `anchor` (the original): scans gateway_usage_settlement_anchors for the
   *   account and anti-joins against reservations. The anti-join has to prove
   *   "no earlier unreserved anchor exists", so when none does — the normal
   *   case for an account that is up to date — the LIMIT 1 cannot terminate
   *   early and the scan is exhaustive. Production EXPLAIN cost 72,452 against
   *   359,775 anchors for the hot account, and that number grows by one row per
   *   billed event forever.
   *
   * - `guard` (this change): the same question asked of the guard set instead.
   *   Every receipt that is committed but not yet reserved carries an ACTIVE
   *   `pending_usage_unreserved` restriction, created in the same transaction as
   *   the anchor. So "is there an earlier unreserved receipt" is answerable from
   *   the restrictions the account holds *right now* — 4 ACTIVE rows in the
   *   whole database as of 2026-09-01 — rather than from its lifetime history.
   *   Uses the existing (billing_account_id, status) index; no migration.
   *
   * Why not just switch: `guard` swaps the query's *input*, not a filter, so it
   * is only correct while the invariant "every unreserved eligible anchor has
   * exactly one ACTIVE pending_usage_unreserved guard" holds. That invariant was
   * audited from both directions on 2026-09-01 (guard side = 1, anchor side = 1)
   * but a two-sided point-in-time audit is not a proof over all time, and being
   * wrong here means a later receipt could take capital ahead of an earlier one.
   *
   * So the default is `compare`: run both, return the ORIGINAL result, and log
   * any divergence. That turns the review's "dual-read comparison" precondition
   * into a measurement on production traffic instead of a simulation, and the
   * switch to `guard` becomes a decision backed by an observed agreement rate.
   * Divergence is logged at error level with both sequences, because a single
   * mismatch invalidates the premise and must not scroll past.
   */
  private async resolveGatewayFundingBlocker(
    db: Prisma.TransactionClient,
    billingAccountId: string,
    firstReceiptSequence: bigint,
  ): Promise<Array<{ requestId: string; firstReceiptSequence: bigint }>> {
    const mode = this.gatewayFundingBlockerSource();
    if (mode === 'guard') {
      const fromGuards = await timed(
        'resvBlockingGuard',
        () => this.findGatewayFundingBlockerFromGuards(db, billingAccountId, firstReceiptSequence),
      );
      billingFundingBlockerTotal.inc({
        source: 'guard',
        outcome: fromGuards.length > 0 ? 'hit' : 'miss',
      });
      return fromGuards;
    }
    const fromAnchors = await timed(
      'resvBlockingScan',
      () => this.findGatewayFundingBlockerFromAnchors(db, billingAccountId, firstReceiptSequence),
    );
    // 计数独立于 stage-timing:后者按尝试次数计、行内不带 requestId/accountId、
    // 受日志保留期限制、且能否全量记录取决于 BILLING_USAGE_STAGE_TIMING_MIN_MS
    // (代码默认 250ms,四个环境目前都显式设为 0)。理由详见 metrics.registry 的注释。
    billingFundingBlockerTotal.inc({
      source: 'anchor',
      outcome: fromAnchors.length > 0 ? 'hit' : 'miss',
    });
    if (mode !== 'compare') return fromAnchors;

    // Comparison must never change the outcome or break the transaction: a
    // failure here is a diagnostics failure, not a funding failure.
    try {
      const fromGuards = await timed(
        'resvBlockingGuard',
        () => this.findGatewayFundingBlockerFromGuards(db, billingAccountId, firstReceiptSequence),
      );
      billingFundingBlockerTotal.inc({
        source: 'guard',
        outcome: fromGuards.length > 0 ? 'hit' : 'miss',
      });
      const left = fromAnchors[0]?.requestId ?? null;
      const right = fromGuards[0]?.requestId ?? null;
      // 只比 requestId 不足以放行 guard 模式:两条 SQL 都 LIMIT 1、调用方也只取 [0],
      // 所以集合差异当前不会被消费;但 sequence 未被比对,而 guard SQL **没有**约束
      // anchor.billing_account_id = 输入 account(只约束 guard.billing_account_id,
      // 且该列无外键/无不可变触发器)⇒ 账户错配时两边可能都返回"某一条"却不是同一条。
      // 因此这里连 sequence 一起比,让 diverge 能覆盖"同 requestId 不同 sequence"以外的错配。
      const leftSeq = fromAnchors[0]?.firstReceiptSequence?.toString() ?? null;
      const rightSeq = fromGuards[0]?.firstReceiptSequence?.toString() ?? null;
      if (left === right && leftSeq === rightSeq) {
        await timed('resvBlockingAgree', async () => undefined);
        billingFundingBlockerTotal.inc({ source: 'compare', outcome: 'agree' });
      } else {
        await timed('resvBlockingDiverge', async () => undefined);
        billingFundingBlockerTotal.inc({ source: 'compare', outcome: 'diverge' });
        this.logger.error(
          `gateway funding blocker sources diverged account=${billingAccountId} `
          + `receiptSequence=${firstReceiptSequence.toString()} `
          + `anchorSource=${left ?? 'none'}`
          + `@${leftSeq ?? '-'} `
          + `guardSource=${right ?? 'none'}`
          + `@${rightSeq ?? '-'} `
          + '— the guard-sourced query is NOT safe to enable while this occurs',
        );
      }
    } catch (err) {
      // 这条 catch 会让比对失败静默:返回值仍是 anchors,功能不受影响,
      // 但「diverge=0」因此不能单独作为放行判据 —— 必须同时确认 error 计数为 0。
      billingFundingBlockerTotal.inc({ source: 'compare', outcome: 'error' });
      this.logger.warn(
        `gateway funding blocker comparison failed account=${billingAccountId}: `
        + `${(err as Error).message}`,
      );
    }
    return fromAnchors;
  }

  /** 'anchor' | 'guard' | 'compare' (default). Unknown values fall back to compare. */
  private gatewayFundingBlockerSource(): 'anchor' | 'guard' | 'compare' {
    const raw = (
      this.config?.get<string>('BILLING_FUNDING_BLOCKER_SOURCE')
      ?? process.env.BILLING_FUNDING_BLOCKER_SOURCE
      ?? ''
    ).trim().toLowerCase();
    if (raw === 'anchor') return 'anchor';
    if (raw === 'guard') return 'guard';
    return 'compare';
  }

  /**
   * FIFO 队头判定:该账户是否存在更早、且尚未预留的 receipt。
   *
   * 入口是稀疏队列 `gateway_usage_unreserved_queue`,不再是 anchors 的全历史。
   * 原先对 reservations 做存在性反连接,而热点账户所有更早 anchor 都已预留 ⇒ 结果恒空
   * ⇒ `LIMIT 1` 无法提前终止 ⇒ 恒定全扫该账户全部历史 anchor(生产实测 p50 2,119ms,
   * 且随每笔计费事件线性增长)。只换查询形态无效:`NOT EXISTS` 改写 +7%、
   * `MATERIALIZED` CTE 为负收益 —— 必须让「未预留」这个状态本身可索引。
   *
   * 队列的不变量由 DB 触发器保证(migration 20260910000100),不依赖应用逻辑:
   *   queue 中存在 event ⟺ 入队条件成立 且 尚无 reservation
   * 因此 queue 成员资格与原 `NOT EXISTS` 等价;reservation 的 status 流转
   * (ACTIVE→CONSUMED/RELEASED)不触碰 queue,与原查询「不看 status、RELEASED 也算已预留」一致。
   *
   * 没有给 anchors 直接加物化列,是因为该表是 DB 强制 append-only:任何 UPDATE 抛 55000,
   * 且该异常会回滚整个 reservation 事务、卡死资金预留。
   *
   * `FOR UPDATE OF anchor` 保持不变:锁的仍是 anchor 行,queue 只读。
   * 这也决定了锁序不成环 —— 写侧(reservation 事务)删 queue 行、不等 queue 上的读锁。
   */
  /**
   * 队列版是否已获授权。授权由 migration 20260910000300 在**回填完成且不变量断言通过后**
   * 写入 gateway_usage_unreserved_queue_readiness,不受应用配置影响。
   *
   * 为什么必须有这道闸门:100 号提交后触发器即生效,但历史上符合入队条件的 anchor 要等
   * 200 号回填才进队。若新代码在这个窗口里就只从 queue 查 blocker,后到的 receipt 会查到空、
   * 成功预留,**越过更早的 receipt(FIFO false negative)**。「当前数据为 0 行」是巧合而非
   * 结构安全性,而本仓历史上出现过「新代码先于 schema」的部署缺口。
   * ★ `compare` 模式不能充当保护:它先返回队列版结果、guard 仅作诊断,diverge 时**仍返回队列版**。
   *
   * 只缓存 true:readiness 一旦置位就不会撤销,所以命中后零开销;未就绪时每次多一次单行表
   * 的存在性查询(主键、微秒级),换来的是窗口期一律走语义等价的旧查询。
   */
  private queueBlockerReady = false;

  private async isUnreservedQueueReady(db: Prisma.TransactionClient): Promise<boolean> {
    if (this.queueBlockerReady) return true;
    const rows = await db.$queryRaw<Array<{ ready: boolean }>>`
      SELECT true AS "ready" FROM "gateway_usage_unreserved_queue_readiness" LIMIT 1
    `;
    if (rows.length > 0) this.queueBlockerReady = true;
    return this.queueBlockerReady;
  }

  private async findGatewayFundingBlockerFromAnchors(
    db: Prisma.TransactionClient,
    billingAccountId: string,
    firstReceiptSequence: bigint,
  ): Promise<Array<{ requestId: string; firstReceiptSequence: bigint }>> {
    // 未获授权 ⇒ 走保留的旧查询(语义等价,只是慢)。这是 100/200/300 之间任何窗口的安全侧。
    if (!(await this.isUnreservedQueueReady(db))) {
      return this.findGatewayFundingBlockerByAnchorScan(db, billingAccountId, firstReceiptSequence);
    }
    return db.$queryRaw<Array<{ requestId: string; firstReceiptSequence: bigint }>>`
      SELECT
        anchor."request_id" AS "requestId",
        anchor."first_receipt_sequence" AS "firstReceiptSequence"
      FROM "gateway_usage_unreserved_queue" AS queue
      JOIN "gateway_usage_settlement_anchors" AS anchor
        ON anchor."gateway_billing_event_id" = queue."gateway_billing_event_id"
      JOIN "gateway_billing_events" AS blocking_event
        ON blocking_event."id" = queue."gateway_billing_event_id"
      WHERE queue."billing_account_id" = ${billingAccountId}
        AND queue."first_receipt_sequence" < ${firstReceiptSequence}
        -- anchor 侧重复校验账户/unit/protocol:queue 的这几列由触发器从 anchor 复制而来,
        -- 无外键、无不可变约束 ⇒ 出现脏数据时只信 queue 侧会把别账户的 anchor 当本账户
        -- 的 blocker(假阻塞),或漏掉真 blocker(FIFO 被越过、后来的收据抢先占资金)。
        -- 与 11.3 给 guard 版补 anchor 账户约束是同一个理由。
        -- 注:本注释内不能出现反引号 —— 这几条 SQL 是 tagged template literal,
        -- 反引号会就地终止模板字符串,后面的 SQL 会被当成 TypeScript 解析。
        AND anchor."billing_account_id" = ${billingAccountId}
        AND anchor."billing_unit" = 'BALANCE'
        AND anchor."funding_reservation_protocol" = 'V1'
        -- 双重保险:sequence 判定同时用 anchor 侧的真值再过一遍。
        -- queue 与 anchor 的 sequence 恒等已由 migration 20260910000300 的写入侧触发器
        -- 保证(INSERT 校验三列一致、UPDATE 拒绝),这一条是为了在触发器被禁用/绕过时
        -- 仍以 anchor 为准 —— queue.sequence 若被改大,更早的 blocker 会被过滤掉、FIFO 被越过。
        -- 走同一索引,额外成本可忽略。
        AND anchor."first_receipt_sequence" < ${firstReceiptSequence}
        AND NOT (
          blocking_event."status" = 'SKIPPED'
          OR (
            blocking_event."status" = 'ABSORBED'
            AND EXISTS (
              SELECT 1
              FROM "gateway_usage_settlement_receipts" AS receipt
              WHERE receipt."gateway_billing_event_id" = blocking_event."id"
                AND receipt."funding_outcome" = 'ABSORBED'
            )
          )
        )
      -- 必须按 queue 的列排序,才能走 queue 的
      -- (billing_account_id, first_receipt_sequence) 索引的有序性、让 LIMIT 1 立即终止。
      -- 换成 anchor 的同名列会丢掉索引有序性、退化成先算全部候选再排序。
      -- 两列取值恒等(触发器从 anchor 复制),故排序结果不变。
      ORDER BY queue."first_receipt_sequence" ASC
      LIMIT 1
      FOR UPDATE OF anchor
    `;
  }

  /**
   * 队列版获授权前的 fallback —— 即被队列版取代的那条原查询,逐字保留。
   *
   * 它慢(热点账户 p50 2,119ms、随计费事件线性增长),但语义是这条路径的基准:
   * 直接对 reservations 做存在性反连接,不依赖任何物化状态,因此在
   * 「触发器已生效、回填尚未完成」的窗口里是唯一安全的选择。
   * 队列版一旦获授权就不再走到这里,所以这段慢查询不会成为常态成本。
   *
   * ⚠️ 不要用 guard 版(findGatewayFundingBlockerFromGuards)充当这个 fallback:
   * 它换的是查询的输入而不是过滤条件,只在「每个未预留 eligible anchor 恰有一个 ACTIVE
   * pending_usage_unreserved 守卫」这个不变量成立时才正确,而该不变量只能观测、不能证明。
   */
  private async findGatewayFundingBlockerByAnchorScan(
    db: Prisma.TransactionClient,
    billingAccountId: string,
    firstReceiptSequence: bigint,
  ): Promise<Array<{ requestId: string; firstReceiptSequence: bigint }>> {
    return db.$queryRaw<Array<{ requestId: string; firstReceiptSequence: bigint }>>`
      SELECT
        anchor."request_id" AS "requestId",
        anchor."first_receipt_sequence" AS "firstReceiptSequence"
      FROM "gateway_usage_settlement_anchors" AS anchor
      JOIN "gateway_billing_events" AS blocking_event
        ON blocking_event."id" = anchor."gateway_billing_event_id"
      WHERE anchor."billing_account_id" = ${billingAccountId}
        AND anchor."billing_unit" = 'BALANCE'
        AND anchor."funding_reservation_protocol" = 'V1'
        AND anchor."first_receipt_sequence" < ${firstReceiptSequence}
        AND NOT EXISTS (
          SELECT 1
          FROM "gateway_usage_funding_reservations" AS reservation
          WHERE reservation."gateway_billing_event_id" = anchor."gateway_billing_event_id"
        )
        AND NOT (
          blocking_event."status" = 'SKIPPED'
          OR (
            blocking_event."status" = 'ABSORBED'
            AND EXISTS (
              SELECT 1
              FROM "gateway_usage_settlement_receipts" AS receipt
              WHERE receipt."gateway_billing_event_id" = blocking_event."id"
                AND receipt."funding_outcome" = 'ABSORBED'
            )
          )
        )
      ORDER BY anchor."first_receipt_sequence" ASC
      LIMIT 1
      FOR UPDATE OF anchor
    `;
  }

  /**
   * Same predicate, entered from the account's ACTIVE pending_usage_unreserved
   * guards. Every filter from the anchor-sourced version is kept verbatim — the
   * guard join replaces the account scan, it does not relax any condition.
   *
   * FOR UPDATE OF anchor only: locking the guard rows too would widen the lock
   * footprint of the funding transaction for no benefit, since the guard is
   * released inside the same transaction that creates the reservation.
   */
  private async findGatewayFundingBlockerFromGuards(
    db: Prisma.TransactionClient,
    billingAccountId: string,
    firstReceiptSequence: bigint,
  ): Promise<Array<{ requestId: string; firstReceiptSequence: bigint }>> {
    return db.$queryRaw<Array<{ requestId: string; firstReceiptSequence: bigint }>>`
      SELECT
        anchor."request_id" AS "requestId",
        anchor."first_receipt_sequence" AS "firstReceiptSequence"
      FROM "billing_access_restrictions" AS guard
      JOIN "gateway_usage_settlement_anchors" AS anchor
        ON anchor."gateway_billing_event_id" = guard."gateway_billing_event_id"
      JOIN "gateway_billing_events" AS blocking_event
        ON blocking_event."id" = anchor."gateway_billing_event_id"
      WHERE guard."billing_account_id" = ${billingAccountId}
        AND guard."status" = 'ACTIVE'
        AND guard."reason" = 'pending_usage_unreserved'
        -- ⚠️ 补上 anchor 侧的账户约束。原查询只约束 guard."billing_account_id",
        -- 而 billing_access_restrictions.billing_account_id 无外键、无不可变触发器
        -- ⇒ 一旦该列与 anchor 不一致(错误 guard / 人工修复 / 历史脏数据),
        -- 就可能把别账户的 anchor 当作本账户的 blocker(假阻塞),
        -- 或漏掉本账户的真 blocker(FIFO 被越过、后来的收据抢先占资金)。
        -- 加上它之后本查询不再依赖"两列一定相等"这个数据不变量。
        AND anchor."billing_account_id" = ${billingAccountId}
        AND anchor."billing_unit" = 'BALANCE'
        AND anchor."funding_reservation_protocol" = 'V1'
        AND anchor."first_receipt_sequence" < ${firstReceiptSequence}
        AND NOT EXISTS (
          SELECT 1
          FROM "gateway_usage_funding_reservations" AS reservation
          WHERE reservation."gateway_billing_event_id" = anchor."gateway_billing_event_id"
        )
        AND NOT (
          blocking_event."status" = 'SKIPPED'
          OR (
            blocking_event."status" = 'ABSORBED'
            AND EXISTS (
              SELECT 1
              FROM "gateway_usage_settlement_receipts" AS receipt
              WHERE receipt."gateway_billing_event_id" = blocking_event."id"
                AND receipt."funding_outcome" = 'ABSORBED'
            )
          )
        )
      ORDER BY anchor."first_receipt_sequence" ASC
      LIMIT 1
      FOR UPDATE OF anchor
    `;
  }

  private balanceDebtSettlementBudgetPct(ms: number): string {
    const budget = BALANCE_LEDGER_TRANSACTION_OPTIONS.timeout;
    if (!budget || budget <= 0) return 'unknown';
    return `${((ms / budget) * 100).toFixed(1)}`;
  }

  /**
   * Runs a balance-ledger transaction and reports how much of the 60s budget it
   * consumed, measured *around* `$transaction` rather than inside it.
   *
   * Why outside: the deferred CONSTRAINT triggers — including the per-row debt
   * conservation assertion that batching cannot remove — fire at COMMIT, after
   * the callback has already returned. Anything timed inside the callback
   * therefore cannot see them, and that unseen part is exactly the remaining
   * capacity risk on this path.
   *
   * `label` names the business operation, and `context` carries whatever
   * identifier makes the line traceable to a specific order or admin action.
   *
   * Frequency: hot per-event transactions (deduct, reservation) are deliberately
   * NOT routed here — they are already decomposed by stage timings, and logging
   * every one of them would add ~45 lines/minute for no new information. This
   * wrapper is for the rare, money-initiating operations, so `always` defaults
   * to true and cheap runs still emit one line. Set a threshold via
   * BALANCE_LEDGER_TX_LOG_MIN_MS if a caller ever becomes frequent.
   */
  private async runBalanceLedgerTransaction<T>(
    label: string,
    context: string,
    fn: (db: Prisma.TransactionClient) => Promise<T>,
  ): Promise<T> {
    const startedAt = process.hrtime.bigint();
    const elapsedMs = (): number => Number(process.hrtime.bigint() - startedAt) / 1e6;
    const threshold = Number.parseInt(
      process.env.BALANCE_LEDGER_TX_LOG_MIN_MS ?? '0',
      10,
    );
    try {
      const result = await this.prisma.$transaction(fn, BALANCE_LEDGER_TRANSACTION_OPTIONS);
      const ms = elapsedMs();
      if (!Number.isFinite(threshold) || ms >= threshold) {
        this.logger.log(
          `balance ledger tx label=${label} ${context} outcome=committed `
          + `durationMs=${ms.toFixed(0)} `
          + `budgetPct=${this.balanceDebtSettlementBudgetPct(ms)}`,
        );
      }
      return result;
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      const ms = elapsedMs();
      // A timeout and an ordinary rejection are different capacity signals, so
      // they are distinguished rather than both reported as rolled_back.
      const timedOut = /transaction .*(timeout|timed out)|P2028/i.test(message);
      this.logger.error(
        `balance ledger tx label=${label} ${context} `
        + `outcome=${timedOut ? 'timeout' : 'rolled_back'} `
        + `durationMs=${ms.toFixed(0)} `
        + `budgetPct=${this.balanceDebtSettlementBudgetPct(ms)} `
        + `error=${message}`,
      );
      throw err;
    }
  }

  // Batched writes + keyset cursor landed 2026-08-28 (04 doc P1/P2); the
  // per-row deferred conservation checks at COMMIT (P3) did not. Probed here
  // because this runs inside the consumer's settlement transaction too, not
  // only on the recharge path it was analysed on.
  private async settleBalanceDebtOnFundingInner(
    db: Prisma.TransactionClient,
    params: {
      billingAccountId: string;
      allocationSource: BalanceDebtAllocationSource;
      repaymentTransactionId: string | null;
      balanceGrantId?: string | null;
      paidFillUsd: Prisma.Decimal;
      bonusFillUsd: Prisma.Decimal;
      financialNow: Date;
      pendingFillAfterUsd?: Prisma.Decimal;
      occurredAt?: Date;
      repairRunId?: string | null;
      operationKeyPrefix?: string;
      trigger?: string;
    },
    stats: BalanceDebtSettlementStats,
  ): Promise<Prisma.Decimal> {
    const account = await db.billingAccount.findUniqueOrThrow({
      where: { id: params.billingAccountId },
      select: {
        type: true,
        balanceGrantLedgerStatus: true,
        balanceGrantLedgerVersion: true,
      },
    });
    const ledgerReconciled = (
      account.balanceGrantLedgerStatus === BALANCE_GRANT_LEDGER_STATUS_RECONCILED
      && account.balanceGrantLedgerVersion === BALANCE_GRANT_LEDGER_VERSION
    );
    const expectedAllocationSource: BalanceDebtAllocationSource = account.type === ENTERPRISE_ACCOUNT_TYPE
      ? BALANCE_ALLOCATION_SOURCE_ENTERPRISE_CREDIT
      : BALANCE_ALLOCATION_SOURCE_NEGATIVE_BALANCE;
    if (ledgerReconciled && params.allocationSource !== expectedAllocationSource) {
      throw new BalanceLedgerReconciliationRequiredError(
        params.billingAccountId,
        `funding settlement source ${params.allocationSource} does not match ${expectedAllocationSource}`,
        false,
      );
    }
    if (
      params.allocationSource === BALANCE_ALLOCATION_SOURCE_NEGATIVE_BALANCE
      && !ledgerReconciled
    ) {
      // 存量 DIRTY 账户仍按真实钱包压缩新 grant，但收入/赠额核销必须等待
      // chronological repair，避免新资金抢先核销本应由历史充值结清的旧债。
      this.logger.warn(
        `defer personal debt settlement for unreconciled account=${params.billingAccountId} `
        + `tx=${params.repaymentTransactionId ?? 'none'}`,
      );
      return new Prisma.Decimal(0);
    }
    if (
      params.allocationSource === BALANCE_ALLOCATION_SOURCE_ENTERPRISE_CREDIT
      && !ledgerReconciled
    ) {
      // 企业 repair 只能 VERIFY_EXISTING，不能事后补造收入 settlement。DIRTY
      // 期间哪怕当前 open debt 全是正序，入金也可能越过尚未证明的历史事实；
      // 让外层钱包事务整体回滚，repair 完成后再用原幂等键重试。
      throw new Error(
        `BALANCE_ENTERPRISE_LEDGER_RECONCILIATION_REQUIRED:${params.billingAccountId}`,
      );
    }
    let remainingPaid = this.maxUsd(new Prisma.Decimal(0), params.paidFillUsd)
      .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
    let remainingBonus = this.maxUsd(new Prisma.Decimal(0), params.bonusFillUsd)
      .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
    let remainingTotal = remainingPaid.plus(remainingBonus);
    if (remainingTotal.lte(0)) return new Prisma.Decimal(0);
    const pendingFillAfterUsd = this.maxUsd(
      new Prisma.Decimal(0),
      params.pendingFillAfterUsd ?? new Prisma.Decimal(0),
    ).toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
    if (ledgerReconciled) {
      const before = await this.readReconciledBalanceLedgerSnapshot(
        db,
        params.billingAccountId,
        params.allocationSource,
        params.financialNow,
      );
      const finalDebtUsd = this.maxUsd(new Prisma.Decimal(0), before.walletUsd.neg());
      this.assertReconciledBalanceLedgerSnapshot(
        params.billingAccountId,
        before,
        'funding settlement precondition',
        finalDebtUsd.plus(remainingTotal).plus(pendingFillAfterUsd),
        false,
      );
    }

    const unsequencedOpenDebt = await db.balanceConsumptionAllocation.count({
      where: {
        billingAccountId: params.billingAccountId,
        source: params.allocationSource,
        settledAt: null,
        ledgerSequence: null,
      },
    });
    if (unsequencedOpenDebt > 0) {
      const message = `unsequenced open debt account=${params.billingAccountId} `
        + `source=${params.allocationSource} count=${unsequencedOpenDebt}`;
      // RECONCILED_V2 出现 NULL 是账本破坏。失败并让外层事务回滚 wallet/grant，
      // 绝不以 createdAt 猜测 FIFO 或提交半套账。
      throw new Error(`BALANCE_DEBT_LEDGER_SEQUENCE_MISSING:${message}`);
    }

    let settledTotal = new Prisma.Decimal(0);
    const settlementCursors = new Map<string, bigint>();
    const exhaustedBuckets = new Set<string>();
    const settleStartedAt = process.hrtime.bigint();
    const settleElapsedMs = (): number => Number(process.hrtime.bigint() - settleStartedAt) / 1e6;
    const syncBudgetMs = balanceDebtSettlementSyncBudgetMs();
    const deferralTransactionId = params.repaymentTransactionId;
    // 降级资格刻意收窄到「真正会卡住的充值腿」:
    // - 必须有 repayment transaction:守恒触发器对 trigger='FUNDING' 的硬要求
    //   (repayment_transaction_id 非空、type ∈ RECHARGE/ADJUST、amount_usd > 0)。
    // - repair 不降级:它要与自身 run 原子完成,半套状态会让账本重建失去基准。
    // - SWEEP / REFUND_NETTING 不降级:守恒触发器要求 SWEEP 的
    //   repayment_transaction_id 与 balance_grant_id 必须为 NULL,worker 以 FUNDING
    //   身份续做会直接违反断言。
    // - 复合充值的前一腿不降级:pendingFillAfterUsd > 0 时两腿的前置推导相互耦合,
    //   前一腿转异步会让后一腿的 expected 与实际 openDebt 对不上。
    const deferrable = deferralTransactionId !== null
      && params.repairRunId == null
      && (params.trigger === undefined
        || params.trigger === BALANCE_DEBT_SETTLEMENT_TRIGGER_FUNDING)
      && pendingFillAfterUsd.lte(0);
    while (remainingTotal.gt(0)) {
      // stats.batches > 0:本轮至少完成一批才允许降级,保证每次调用必有进展。
      // 少了这个守卫,预算被耗尽在循环之前(前置的 account 查询 +
      // unsequencedOpenDebt count 就够慢时,或预算被配得很小)会让这里在第一批
      // 之前就把全额转入 pending、核销 0 行;而 worker 每轮是
      // 「删 pending → 调本方法 → 又立刻降级 → 写回同额 pending」
      // ⇒ pending 永不减少、worker 无限空转,欠款一行都清不掉。
      if (
        deferrable
        && deferralTransactionId
        && stats.batches > 0
        && settleElapsedMs() >= syncBudgetMs
      ) {
        // 剩余额度转入 pending,必须与本次钱包变更同事务 ——
        // 不变量 openDebt - pending = max(0,-wallet) 只有在同一提交里才是原子的。
        stats.pendingEnqueuedUsd = remainingTotal;
        await db.balanceDebtSettlementPending.create({
          data: {
            billingAccountId: params.billingAccountId,
            allocationSource: params.allocationSource,
            repaymentTransactionId: deferralTransactionId,
            balanceGrantId: params.balanceGrantId ?? null,
            remainingPaidUsd: remainingPaid,
            remainingBonusUsd: remainingBonus,
            occurredAt: params.occurredAt ?? params.financialNow,
          },
        });
        remainingPaid = new Prisma.Decimal(0);
        remainingBonus = new Prisma.Decimal(0);
        remainingTotal = new Prisma.Decimal(0);
        break;
      }
      const { cursorKey, allocations } = await this.findNextBalanceDebtSettlementBatch(
        db,
        params.billingAccountId,
        params.allocationSource,
        settlementCursors,
        exhaustedBuckets,
      );
      if (allocations.length === 0) break;
      stats.batches += 1;
      stats.allocationsScanned += allocations.length;
      // 先推进游标再处理:本批的行要么被核销、要么被标记 settledAt;
      // 若中途 remainingTotal 归零则外层 while 一并结束,剩下的行本次不再需要。
      this.advanceBalanceDebtSettlementCursor(settlementCursors, cursorKey, allocations);

      // 本批的写入先攒起来，批末一次性落库。逐行往返在大账户上是致命的：
      // 国内 prod 实测单次 Prisma 往返 0.7ms，欠款行数达 18 万 / 60 万，
      // 每行 2 次往返 ⇒ 252s / 839s，而事务预算只有 60s。
      // 分摊算术仍逐行、按桶优先级 + ledgerSequence FIFO 顺序计算，与逐行写入完全一致；
      // 合并的只是写入动作，每行的增量彼此独立，物理更新顺序不影响结果。
      const settledAllocationIds: string[] = [];
      const allocationWrites: BalanceDebtAllocationWrite[] = [];
      const settlementRows: Prisma.EnterpriseCreditSettlementCreateManyInput[] = [];

      for (const allocation of allocations) {
        if (remainingTotal.lte(0)) break;
        const openUsd = usd(allocation.amountUsd).minus(usd(allocation.settledUsd));
        if (openUsd.lte(0)) {
          settledAllocationIds.push(allocation.id);
          continue;
        }
        const applyUsd = this.minUsd(openUsd, remainingTotal)
          .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
        const applyPaidUsd = this.minUsd(applyUsd, remainingPaid);
        const applyBonusUsd = applyUsd.minus(applyPaidUsd);
        const operationPrefix = params.operationKeyPrefix
          ?? (params.repairRunId
            ? `repair:${params.repairRunId}:${params.repaymentTransactionId ?? 'no-tx'}:${
              usd(allocation.settledUsd).toFixed(12)
            }`
          : params.repaymentTransactionId
            ? `funding:${params.repaymentTransactionId}`
            : `sweep:${usd(allocation.settledUsd).toFixed(12)}`);
        allocationWrites.push({
          id: allocation.id,
          applyUsd,
          applyPaidUsd,
          applyBonusUsd,
          // guard_balance_consumption_allocation_financial_rewrite 要求
          // settled_at 非空 ⟺ settled_usd = amount_usd,所以这个判定必须与
          // 「本行是否被结满」严格一致,不能放宽。
          markSettled: openUsd.lte(applyUsd),
        });
        settlementRows.push({
          billingAccountId: params.billingAccountId,
          allocationId: allocation.id,
          repaymentTransactionId: params.repaymentTransactionId,
          balanceGrantId: params.balanceGrantId ?? null,
          debtSource: params.allocationSource,
          operationKey: `${operationPrefix}:${allocation.id}:${params.allocationSource}`,
          trigger: params.trigger ?? BALANCE_DEBT_SETTLEMENT_TRIGGER_FUNDING,
          amountUsd: applyUsd,
          paidUsd: applyPaidUsd,
          bonusUsd: applyBonusUsd,
          occurredAt: params.occurredAt ?? params.financialNow,
          createdAt: params.financialNow,
          repairRunId: params.repairRunId ?? null,
        });
        remainingPaid = remainingPaid.minus(applyPaidUsd);
        remainingBonus = remainingBonus.minus(applyBonusUsd);
        remainingTotal = remainingPaid.plus(remainingBonus);
        settledTotal = settledTotal.plus(applyUsd);
      }

      stats.allocationsUpdated += allocationWrites.length;
      stats.settlementRowsInserted += settlementRows.length;
      // 必须在批末落库:下一批的候选查询按 settledAt IS NULL 过滤,
      // 不落库会反复取到同一批行而死循环。
      await this.flushBalanceDebtSettlementBatch(
        db,
        params.financialNow,
        settledAllocationIds,
        allocationWrites,
        settlementRows,
      );
    }

    const expectedTotal = this.maxUsd(new Prisma.Decimal(0), params.paidFillUsd)
      .plus(this.maxUsd(new Prisma.Decimal(0), params.bonusFillUsd))
      .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
    // 降级后本次事务只核销了一部分,其余以 pending 行的形式承接 ——
    // 「填洞额必须全额有归属」这个后置条件不放松,只是归属可以是 pending。
    if (
      !settledTotal.plus(stats.pendingEnqueuedUsd).eq(expectedTotal)
      || remainingTotal.gt(0)
    ) {
      throw new Error(
        `BALANCE_DEBT_SETTLEMENT_POSTCONDITION_FAILED:${params.billingAccountId}:`
        + `${params.allocationSource}:expected=${expectedTotal.toFixed(12)}:`
        + `settled=${settledTotal.toFixed(12)}:`
        + `enqueued=${stats.pendingEnqueuedUsd.toFixed(12)}:`
        + `remaining=${remainingTotal.toFixed(12)}`,
      );
    }
    if (ledgerReconciled) {
      const after = await this.readReconciledBalanceLedgerSnapshot(
        db,
        params.billingAccountId,
        params.allocationSource,
        params.financialNow,
      );
      const finalDebtUsd = this.maxUsd(new Prisma.Decimal(0), after.walletUsd.neg());
      this.assertReconciledBalanceLedgerSnapshot(
        params.billingAccountId,
        after,
        'funding settlement postcondition',
        finalDebtUsd.plus(pendingFillAfterUsd),
        false,
      );
    }
    await this.releaseRepaidGatewayBalanceDebtRestrictions(
      db,
      params.billingAccountId,
      params.financialNow,
    );
    return settledTotal;
  }

  /**
   * 残留核销兜底（每日 sweep 调用）：钱包欠款已被未接入核销的路径填平
   * （历史存量、人工修数等），但 ENTERPRISE_CREDIT 分摊仍挂账未核销时，
   * 把「未核销总额 − 当前钱包欠款」的差额按 FIFO 核销掉（按实付口径确认收入）。
   * 钱包行 FOR UPDATE 锁保证与并发扣费/充值互斥。
   */
  async sweepEnterpriseCreditResidualSettlement(billingAccountId: string): Promise<number> {
    // ★ 2026-09-21 国内 prod 充值故障:这里曾是无 options 的裸 $transaction(Prisma 默认
    // timeout=5s)。该回调对欠款大账户跑 settleBalanceDebtOnFunding(实测 32.9s),
    // 事务 5s 即过期,后续 queryRaw 抛 Transaction already closed;过期事务回滚前仍持有
    // 钱包行锁,又把并发充值(adminRecharge)与 overdue worker 一起拖进超时回滚。
    // 预算必须与充值路径同源(settleBalanceDebtOnFunding 的内部预算水位按
    // BALANCE_LEDGER_TRANSACTION_OPTIONS.timeout 计算,触及即转 pending 队列)。
    const settled = await this.prisma.$transaction(async (db) => {
      const enterprise = await this.isEnterpriseBillingAccount(db, billingAccountId);
      if (!enterprise) return new Prisma.Decimal(0);
      const walletRows = await db.$queryRaw<Array<{ balance_usd: Prisma.Decimal }>>`
        SELECT "balance_usd" FROM "account_wallets" WHERE "billing_account_id" = ${billingAccountId} FOR UPDATE`;
      if (walletRows.length !== 1) {
        throw this.billingAccountNotProvisioned();
      }
      const financialNow = await this.lockBalanceLedgerAndCaptureFinancialNow(
        db,
        billingAccountId,
        `enterprise-residual-settlement:${billingAccountId}`,
      );
      const balanceUsd = usd(walletRows[0].balance_usd);
      const open = await db.balanceConsumptionAllocation.aggregate({
        where: {
          billingAccountId,
          source: BALANCE_ALLOCATION_SOURCE_ENTERPRISE_CREDIT,
          settledAt: null,
        },
        _sum: { amountUsd: true, settledUsd: true },
      });
      const outstandingUsd = usd(open._sum.amountUsd ?? 0).minus(usd(open._sum.settledUsd ?? 0));
      const trackedDebtUsd = balanceUsd.lt(0) ? balanceUsd.neg() : new Prisma.Decimal(0);
      const residualUsd = outstandingUsd.minus(trackedDebtUsd);
      if (residualUsd.lte(0)) return new Prisma.Decimal(0);
      // 2026-09-22:pending 队列未排空时本轮整体跳过。residualUsd 的推导
      // (outstanding - trackedDebt)没有扣 pending,而 settleBalanceDebtOnFunding
      // 的前置断言(openDebt - pending = expected)在 pending>0 时必不匹配 ——
      // 000300 之前这表现为每轮 sweep 报 BALANCE_LEDGER_RECONCILIATION_
      // REQUIRED error;数字其实平(openDebt-pending=-wallet),是 sweep 与
      // pending drain 的设计内互斥:排队的挂账正由 worker 消费,sweep 不得介入。
      const pendingSettlement = await db.balanceDebtSettlementPending.aggregate({
        where: { billingAccountId },
        _sum: { remainingPaidUsd: true, remainingBonusUsd: true },
      });
      const pendingUsd = usd(pendingSettlement._sum.remainingPaidUsd ?? 0)
        .plus(usd(pendingSettlement._sum.remainingBonusUsd ?? 0));
      if (pendingUsd.gt(0)) {
        this.logger.log(
          `enterprise credit residual sweep deferred account=${billingAccountId} `
          + `pendingSettlement=${pendingUsd.toFixed(12)} (drain in progress)`,
        );
        return new Prisma.Decimal(0);
      }
      return this.settleBalanceDebtOnFunding(db, {
        billingAccountId,
        allocationSource: BALANCE_ALLOCATION_SOURCE_ENTERPRISE_CREDIT,
        repaymentTransactionId: null,
        paidFillUsd: residualUsd,
        bonusFillUsd: new Prisma.Decimal(0),
        financialNow,
        trigger: 'SWEEP',
      });
    }, BALANCE_LEDGER_TRANSACTION_OPTIONS);
    return usdToCents(settled);
  }

  /**
   * 排空一条 pending 记录的一个预算窗口;worker 反复调用直到 picked=false。
   *
   * 实现刻意「先删 pending 行,再走既有的 settleBalanceDebtOnFunding」而不是
   * 另写一份核销循环:
   * - 删除后账户回到两项式基准(pending=0),既有前置推导
   *   finalDebt + remainingTotal 恰好等于此刻的 openDebt,断言无需任何特例;
   * - 该方法若再次触及预算水位,会把没做完的部分重新写成一条新的 pending 行
   *   ⇒ 天然递归,且核销逻辑永远只有一份(不会与同步路径漂移);
   * - operationKey 仍是 funding:<txId>:<allocationId>:<source>,与同步路径同构,
   *   重复投递由其 unique 约束幂等挡掉。
   *
   * 锁序与 sweepEnterpriseCreditResidualSettlement 一致(钱包行 FOR UPDATE 在前),
   * 避免与并发扣费/充值形成环。worker 不改 wallet,只把 openDebt 与 pending 等量下调,
   * 故与计费热路径不争夺钱包行以外的资源。
   */
  async settlePendingBalanceDebtOnce(): Promise<{
    picked: boolean;
    pendingId: string | null;
    billingAccountId: string | null;
    arrangedUsd: Prisma.Decimal;
  }> {
    // 事务 options 与 settleBalanceDebtOnFunding 的预算水位同源:裸 $transaction
    // 默认 5s 超时,而大账户一个预算窗口的核销远超 5s(2026-09-21 国内 prod 实测
    // 32.9s),drain worker 会在与 sweepEnterpriseCreditResidualSettlement 完全
    // 相同的位置炸 Transaction already closed。
    return this.prisma.$transaction(async (db) => {
      const [pending] = await db.$queryRaw<Array<{
        id: string;
        billing_account_id: string;
        allocation_source: string;
        repayment_transaction_id: string;
        balance_grant_id: string | null;
        remaining_paid_usd: Prisma.Decimal;
        remaining_bonus_usd: Prisma.Decimal;
      }>>`
        SELECT "id", "billing_account_id", "allocation_source",
               "repayment_transaction_id", "balance_grant_id",
               "remaining_paid_usd", "remaining_bonus_usd"
          FROM "balance_debt_settlement_pending"
         ORDER BY "created_at" ASC, "id" ASC
           FOR UPDATE SKIP LOCKED
         LIMIT 1`;
      if (!pending) {
        return {
          picked: false,
          pendingId: null,
          billingAccountId: null,
          arrangedUsd: new Prisma.Decimal(0),
        };
      }
      const walletRows = await db.$queryRaw<Array<{ balance_usd: Prisma.Decimal }>>`
        SELECT "balance_usd" FROM "account_wallets"
         WHERE "billing_account_id" = ${pending.billing_account_id} FOR UPDATE`;
      if (walletRows.length !== 1) {
        throw this.billingAccountNotProvisioned();
      }
      // pending 表刻意不加外键(同 gateway_usage_unreserved_queue 的权衡),
      // 所以这里必须重新校验还款交易的归属:只信队列侧会让 settlement 挂到
      // 别的账户的还款上,而守恒触发器要求 occurred_at 严格等于该交易的 created_at。
      const repayment = await db.balanceTransaction.findUnique({
        where: { id: pending.repayment_transaction_id },
        select: { billingAccountId: true, createdAt: true },
      });
      if (!repayment || repayment.billingAccountId !== pending.billing_account_id) {
        throw new Error(
          `BALANCE_DEBT_PENDING_TRANSACTION_MISMATCH:${pending.id}:`
          + `${pending.repayment_transaction_id}`,
        );
      }
      const financialNow = await this.lockBalanceLedgerAndCaptureFinancialNow(
        db,
        pending.billing_account_id,
        `balance-debt-pending-settlement:${pending.id}`,
      );
      await db.balanceDebtSettlementPending.delete({ where: { id: pending.id } });
      const arrangedUsd = await this.settleBalanceDebtOnFunding(db, {
        billingAccountId: pending.billing_account_id,
        allocationSource: pending.allocation_source as BalanceDebtAllocationSource,
        repaymentTransactionId: pending.repayment_transaction_id,
        balanceGrantId: pending.balance_grant_id,
        paidFillUsd: usd(pending.remaining_paid_usd),
        bonusFillUsd: usd(pending.remaining_bonus_usd),
        financialNow,
        occurredAt: repayment.createdAt,
        trigger: BALANCE_DEBT_SETTLEMENT_TRIGGER_FUNDING,
      });
      return {
        picked: true,
        pendingId: pending.id,
        billingAccountId: pending.billing_account_id,
        arrangedUsd,
      };
    }, BALANCE_LEDGER_TRANSACTION_OPTIONS);
  }

  private async loadRechargeWithBonusReplay(
    db: Prisma.TransactionClient | PrismaService,
    params: {
      userId: string;
      subject: BillingAccountSubjectRef;
      amountUsd: Prisma.Decimal;
      bonusUsd: Prisma.Decimal;
      description: string;
      bonusDescription: string;
      orderId: string;
      productId?: string | null;
    },
  ): Promise<{
    rechargeTx: PrismaBalanceTransaction;
    finalBalanceUsd: Prisma.Decimal;
  } | null> {
    const [grant, rechargeTx] = await Promise.all([
      db.balanceGrant.findUnique({ where: { orderId: params.orderId } }),
      db.balanceTransaction.findFirst({
        where: { orderId: params.orderId, type: PrismaTransactionType.RECHARGE },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    if (!grant && !rechargeTx) return null;

    const grantFingerprintMatches = grant !== null
      && this.balanceGrantMatchesFundingSubject(grant, params)
      && usd(grant.paidAmountUsd).eq(params.amountUsd)
      // bonusAmountUsd/grantedAmountUsd are cumulative: a later, legitimate
      // creditBonus mutates both.  The immutable bonus transaction below proves
      // this recharge's exact initial bonus; the grant only needs to contain it
      // and remain internally balanced.
      && usd(grant.bonusAmountUsd).gte(params.bonusUsd)
      && usd(grant.paidAmountUsd).plus(grant.bonusAmountUsd).eq(grant.grantedAmountUsd);
    if (
      !rechargeTx
      || !grantFingerprintMatches
      || !this.balanceTransactionMatchesReplayFingerprint(rechargeTx, {
        userId: params.userId,
        subject: params.subject,
        type: PrismaTransactionType.RECHARGE,
        amountUsd: params.amountUsd,
        description: params.description,
        orderId: params.orderId,
        productId: params.productId,
        operationKey: `balance:recharge:${params.orderId}:paid`,
      })
    ) {
      throw new ConflictException('BALANCE_RECHARGE_IDEMPOTENCY_FINGERPRINT_MISMATCH');
    }

    let finalBalanceUsd = rechargeTx.balanceAfterUsd;
    const initialBonusOperationKey = `balance:recharge:${params.orderId}:bonus`;
    const bonusCandidates = await db.balanceTransaction.findMany({
      where: {
        orderId: params.orderId,
        type: PrismaTransactionType.ADJUST,
        OR: [
          { operationKey: initialBonusOperationKey },
          // Expand/rolling compatibility. Only a positive legacy order-linked
          // ADJUST can be an initial bonus. A negative legacy expiry ADJUST may
          // carry the same orderId and must not make replay ambiguous.
          { operationKey: null, amountUsd: { gt: new Prisma.Decimal(0) } },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: 3,
    });
    const exactBonus = bonusCandidates.filter(
      (transaction) => transaction.operationKey === initialBonusOperationKey,
    );
    const legacyBonus = bonusCandidates.filter((transaction) => transaction.operationKey === null);
    const bonusTx = exactBonus.length === 1
      ? exactBonus[0]
      : exactBonus.length === 0 && legacyBonus.length === 1
        ? legacyBonus[0]
        : null;
    if (exactBonus.length > 1 || (exactBonus.length === 0 && legacyBonus.length > 1)) {
      throw new ConflictException('BALANCE_RECHARGE_IDEMPOTENCY_FINGERPRINT_MISMATCH');
    }
    if (bonusTx) {
      if (
        params.bonusUsd.lte(0)
        || !this.balanceTransactionMatchesReplayFingerprint(bonusTx, {
          userId: params.userId,
          subject: params.subject,
          type: PrismaTransactionType.ADJUST,
          amountUsd: params.bonusUsd,
          description: params.bonusDescription,
          orderId: params.orderId,
          productId: params.productId,
          operationKey: initialBonusOperationKey,
        })
      ) {
        throw new ConflictException('BALANCE_RECHARGE_IDEMPOTENCY_FINGERPRINT_MISMATCH');
      }
      finalBalanceUsd = bonusTx.balanceAfterUsd;
    } else if (params.bonusUsd.gt(0)) {
      throw new ConflictException('BALANCE_RECHARGE_IDEMPOTENCY_FINGERPRINT_MISMATCH');
    }

    return { rechargeTx, finalBalanceUsd };
  }

  async recharge(
    userId: string,
    amountCents: number,
    description: string,
    orderId?: string,
    productId?: string | null,
    subject: BillingSubjectOptions = {},
  ): Promise<BalanceTransaction> {
    return this.rechargeWithBonus(userId, amountCents, 0, description, orderId, productId, subject);
  }

  async rechargeWithBonus(
    userId: string,
    amountCents: number,
    bonusCents: number,
    description: string,
    orderId?: string,
    productId?: string | null,
    options: RechargeWithBonusOptions = {},
  ): Promise<BalanceTransaction> {
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      throw new BadRequestException('充值金额必须为正整数分值');
    }
    if (!Number.isSafeInteger(bonusCents) || bonusCents < 0) {
      throw new BadRequestException('充值赠额必须为非负整数分值');
    }
    const amountUsd = centsToUsd(amountCents);
    const bonusUsd = centsToUsd(bonusCents);
    const bonusDescription = options.bonusDescription ?? 'recharge-bonus';
    const anchoredSubject = options.tenantId?.trim() && options.billingAccountId?.trim()
      ? {
        tenantId: options.tenantId.trim(),
        billingAccountId: options.billingAccountId.trim(),
      }
      : null;

    // A completed order is immutable financial history. Replay it against the
    // order's explicit anchor before consulting the tenant's current binding,
    // otherwise a later tenant rebind could turn a harmless webhook retry into
    // a second funding attempt against a different account.
    if (orderId && anchoredSubject) {
      const replay = await this.loadRechargeWithBonusReplay(this.prisma, {
        userId,
        subject: anchoredSubject,
        amountUsd,
        bonusUsd,
        description,
        bonusDescription,
        orderId,
        productId,
      });
      if (replay) {
        await this.refreshAnchoredBalanceProjection(userId, anchoredSubject);
        return this.toBalanceTransaction(replay.rechargeTx);
      }
    }

    let billingSubject: ResolvedBillingSubject;
    try {
      billingSubject = await this.requireTenantSubject(userId, options);
    } catch (err) {
      if (this.isRechargeSubjectValidationError(err, options)) {
        throw new RechargeBillingSubjectChangedError();
      }
      throw err;
    }
    const beforeKeyBalanceFunding = await this.captureKeyBalanceFundingState(userId, billingSubject);
    let result: {
      rechargeTx: PrismaBalanceTransaction;
      finalBalanceUsd: Prisma.Decimal;
      replayed: boolean;
    };
    try {
      result = await this.runBalanceLedgerTransaction(
        'rechargeWithBonus',
        `order=${orderId} user=${userId}`,
        async (db) => {
        // Recharge and refund serialize on the same order row. If refund wins,
        // the order no longer has FULFILLING status and this first funding write
        // is rejected; if recharge wins, refund observes the complete wallet
        // effects after this transaction commits.
        const lockedOrder = orderId && anchoredSubject
          ? await this.lockRechargeOrder(db, orderId)
          : null;
        if (orderId) {
          if (!lockedOrder) {
            // Compatibility for non-payment/internal callers that predate the
            // explicit order anchor contract. Payment fulfillment always uses
            // the locked path above.
            await this.assertRechargeOrderFundingSubject(db, {
              orderId,
              userId,
              subject: billingSubject,
              productId,
            });
          }
          const replay = await this.loadRechargeWithBonusReplay(db, {
            userId,
            subject: billingSubject,
            amountUsd,
            bonusUsd,
            description,
            bonusDescription,
            orderId,
            productId,
          });
          if (replay) {
            return { ...replay, replayed: true };
          }
        }

        if (lockedOrder) {
          this.assertRechargeOrderFulfillmentAnchor(
            lockedOrder,
            userId,
            billingSubject,
            productId,
          );
        }

        const grantedAmountUsd = amountUsd.plus(bonusUsd);
        const financialNow = await this.lockWalletLedgerAndCaptureFinancialNow(
          db,
          userId,
          billingSubject,
          `recharge:${orderId ?? userId}`,
        );
        // Every financial path takes wallet -> grants(id ASC) -> account
        // before tenant metadata. Deduct updates the tenant allowance while
        // holding those same financial locks, so taking the tenant first here
        // would create a tenant <-> wallet deadlock cycle. Keep the anchored
        // subject's second validation inside this transaction, but freeze and
        // validate it only after the canonical financial lock bundle is held.
        if (options.billingAccountId?.trim()) {
          await this.assertRechargeBillingSubjectStillCurrent(db, userId, billingSubject);
        } else {
          // Legacy/internal callers are not order-anchored, but still must not
          // fund an account that the tenant stopped pointing at after preflight.
          billingSubject = await this.lockProvisionedBillingSubjectMetadata(
            db,
            userId,
            billingSubject,
          );
        }
        await this.expireAccountBalanceGrants(db, billingSubject, financialNow);
        await this.assertReconciledBalanceLedger(
          db,
          billingSubject.billingAccountId,
          financialNow,
          'recharge precondition',
        );
        if (!orderId) {
          const ledgerContext = await this.reconciledBalanceLedgerContext(
            db,
            billingSubject.billingAccountId,
          );
          if (ledgerContext.reconciled) {
            throw new BadRequestException('BALANCE_RECHARGE_REQUIRES_CLASSIFIED_FUNDING_LINK');
          }
        }
        const paidWallet = await this.incrementAccountWallet(db, userId, billingSubject, amountUsd);
        const rechargeTx = await db.balanceTransaction.create({
          data: {
            ...(orderId ? { operationKey: `balance:recharge:${orderId}:paid` } : {}),
            userId,
            tenantId: billingSubject.tenantId,
            billingAccountId: billingSubject.billingAccountId,
            type: PrismaTransactionType.RECHARGE,
            amountUsd,
            balanceAfterUsd: paidWallet.balanceUsd,
            description,
            orderId,
            ...(productId ? { productId } : {}),
            createdAt: financialNow,
          },
        });
        let finalBalanceUsd = paidWallet.balanceUsd;
        let rawBonusFillUsd = new Prisma.Decimal(0);
        let bonusTransactionId: string | null = null;
        let bonusTransactionOccurredAt: Date | null = null;
        if (bonusUsd.gt(0)) {
          const bonusWallet = await this.incrementAccountWallet(db, userId, billingSubject, bonusUsd);
          finalBalanceUsd = bonusWallet.balanceUsd;
          rawBonusFillUsd = this.walletHoleFillUsd(bonusWallet.balanceUsd, bonusUsd);
          const bonusTransaction = await db.balanceTransaction.create({
            data: {
              ...(orderId ? { operationKey: `balance:recharge:${orderId}:bonus` } : {}),
              userId,
              tenantId: billingSubject.tenantId,
              billingAccountId: billingSubject.billingAccountId,
              type: PrismaTransactionType.ADJUST,
              amountUsd: bonusUsd,
              balanceAfterUsd: bonusWallet.balanceUsd,
              description: bonusDescription,
              orderId,
              ...(productId ? { productId } : {}),
              createdAt: financialNow,
            },
          });
          bonusTransactionId = bonusTransaction.id;
          bonusTransactionOccurredAt = bonusTransaction.createdAt;
        }

        // 充值优先偿还已发生的余额欠款。个人 NEGATIVE_BALANCE 与企业信用使用
        // 同一核销原则：填坑部分不再铸造成新的可消费 grant。
        const rawPaidFillUsd = this.walletHoleFillUsd(paidWallet.balanceUsd, amountUsd);
        const paidFillUsd = rawPaidFillUsd;
        const bonusFillUsd = rawBonusFillUsd;
        const debtSource = await this.debtAllocationSourceForAccount(
          db,
          billingSubject.billingAccountId,
          paidFillUsd.plus(bonusFillUsd),
        );

        const remainingPaidAmountUsd = this.maxUsd(new Prisma.Decimal(0), amountUsd.minus(paidFillUsd));
        const remainingBonusAmountUsd = this.maxUsd(new Prisma.Decimal(0), bonusUsd.minus(bonusFillUsd));
        const consumableUsd = remainingPaidAmountUsd.plus(remainingBonusAmountUsd);
        let balanceGrantId: string | null = null;
        if (orderId && grantedAmountUsd.gt(0)) {
          const grant = await db.balanceGrant.create({
            data: {
              userId,
              tenantId: billingSubject.tenantId,
              billingAccountId: billingSubject.billingAccountId,
              orderId,
              ...(productId ? { productId } : {}),
              source: BALANCE_GRANT_SOURCE_RECHARGE,
              paidAmountUsd: amountUsd,
              bonusAmountUsd: bonusUsd,
              grantedAmountUsd,
              remainingAmountUsd: consumableUsd,
              remainingPaidAmountUsd,
              remainingBonusAmountUsd,
              discountRate: this.getDiscountRate(amountUsd, grantedAmountUsd),
              validFrom: financialNow,
              expiresAt: this.getRechargeExpiresAt(financialNow),
              createdAt: financialNow,
            },
          });
          balanceGrantId = grant.id;
        }
        if (debtSource && paidFillUsd.gt(0)) {
          await this.settleBalanceDebtOnFunding(db, {
            billingAccountId: billingSubject.billingAccountId,
            allocationSource: debtSource,
            repaymentTransactionId: rechargeTx.id,
            balanceGrantId,
            paidFillUsd,
            bonusFillUsd: new Prisma.Decimal(0),
            financialNow,
            pendingFillAfterUsd: bonusFillUsd,
            occurredAt: rechargeTx.createdAt,
          });
        }
        if (debtSource && bonusFillUsd.gt(0)) {
          await this.settleBalanceDebtOnFunding(db, {
            billingAccountId: billingSubject.billingAccountId,
            allocationSource: debtSource,
            repaymentTransactionId: bonusTransactionId,
            balanceGrantId,
            paidFillUsd: new Prisma.Decimal(0),
            bonusFillUsd,
            financialNow,
            occurredAt: bonusTransactionOccurredAt ?? undefined,
          });
        }
        await this.assertReconciledBalanceLedger(
          db,
          billingSubject.billingAccountId,
          financialNow,
          'recharge postcondition',
          false,
        );
        if (!balanceGrantId && consumableUsd.gt(0)) {
          await this.markBalanceGrantLedgerDirty(
            db,
            billingSubject.billingAccountId,
            'recharge created consumable wallet balance without an order-linked grant',
          );
        }
        return { rechargeTx, finalBalanceUsd, replayed: false };
      },
      );
    } catch (err) {
      if (err instanceof BalanceLedgerReconciliationRequiredError) {
        await this.persistRejectedLedgerQuarantine(err);
        throw err;
      }
      if (!orderId || !hasPrismaErrorCode(err, 'P2002')) {
        throw err;
      }
      const replay = await this.loadRechargeWithBonusReplay(this.prisma, {
        userId,
        subject: billingSubject,
        amountUsd,
        bonusUsd,
        description,
        bonusDescription,
        orderId,
        productId,
      });
      if (!replay) throw err;
      result = { ...replay, replayed: true };
    }
    try {
      if (options.billingAccountId?.trim()) {
        await this.refreshAnchoredBalanceProjection(userId, billingSubject);
      } else if (result.replayed) {
        await this.refreshBalanceCachesAndForceKeyBalanceSync(userId, billingSubject);
      } else {
        await this.refreshBalanceCachesAndSyncKeyBalancesOnFundingChange(
          userId,
          billingSubject,
          beforeKeyBalanceFunding,
        );
      }
    } catch (err) {
      this.logger.warn(
        `rechargeWithBonus cache refresh failed user=${userId} order=${orderId}: ${(err as Error).message}`,
      );
      if (!result.replayed && !options.billingAccountId?.trim()) {
        this.scheduleKeyBalanceSync(userId, billingSubject.tenantId, billingSubject.billingAccountId);
      }
    }

    return this.toBalanceTransaction(result.rechargeTx);
  }

  async adminRecharge(
    userId: string,
    amountCents: number,
    description: string,
    productId?: string | null,
    subject: BillingSubjectOptions = {},
  ): Promise<BalanceTransaction> {
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      throw new BadRequestException('充值金额必须为正整数分值');
    }
    const amountUsd = centsToUsd(amountCents);
    const tenantSubject = await this.requireTenantSubject(userId, subject);
    const beforeKeyBalanceFunding = await this.captureKeyBalanceFundingState(userId, tenantSubject);
    const idempotencyKey = this.normalizeAdminFundingIdempotencyKey(subject.idempotencyKey);
    const idempotencyRequest: AdminFundingRequestFingerprint = {
      scope: ADMIN_RECHARGE_IDEMPOTENCY_SCOPE,
      userId,
      tenantId: tenantSubject.tenantId,
      billingAccountId: tenantSubject.billingAccountId,
      amountUsd: usdString(amountUsd),
      productId: productId ?? null,
      description,
      reason: null,
      expiresAt: null,
      performedBy: null,
    };
    let result: BalanceTransaction;
    let replayed = false;
    try {
      result = await this.runBalanceLedgerTransaction(
        'adminRecharge',
        `user=${userId} idem=${idempotencyKey ?? "none"}`,
        async (db) => {
        if (idempotencyKey) {
          await this.writePendingAdminFundingIdempotency(
            db,
            ADMIN_RECHARGE_IDEMPOTENCY_SCOPE,
            idempotencyKey,
            idempotencyRequest,
          );
        }
        const financialNow = await this.lockWalletLedgerAndCaptureFinancialNow(
          db,
          userId,
          tenantSubject,
          `admin-recharge:${idempotencyKey ?? userId}`,
        );
        await this.lockProvisionedBillingSubjectMetadata(db, userId, tenantSubject);
        await this.expireAccountBalanceGrants(db, tenantSubject, financialNow);
        await this.assertReconciledBalanceLedger(
          db,
          tenantSubject.billingAccountId,
          financialNow,
          'admin recharge precondition',
        );
        const wallet = await this.incrementAccountWallet(db, userId, tenantSubject, amountUsd);
        const paidFillUsd = this.walletHoleFillUsd(wallet.balanceUsd, amountUsd);
        const debtSource = await this.debtAllocationSourceForAccount(
          db,
          tenantSubject.billingAccountId,
          paidFillUsd,
        );

        const remainingPaidAmountUsd = this.maxUsd(new Prisma.Decimal(0), amountUsd.minus(paidFillUsd));
        const grant = await db.balanceGrant.create({
          data: {
            userId,
            tenantId: tenantSubject.tenantId,
            billingAccountId: tenantSubject.billingAccountId,
            ...(productId ? { productId } : {}),
            source: BALANCE_GRANT_SOURCE_RECHARGE,
            paidAmountUsd: amountUsd,
            bonusAmountUsd: new Prisma.Decimal(0),
            grantedAmountUsd: amountUsd,
            remainingAmountUsd: remainingPaidAmountUsd,
            remainingPaidAmountUsd,
            remainingBonusAmountUsd: new Prisma.Decimal(0),
            discountRate: new Prisma.Decimal(1),
            validFrom: financialNow,
            expiresAt: this.getRechargeExpiresAt(financialNow),
            createdAt: financialNow,
          },
        });
        const tx = await db.balanceTransaction.create({
          data: {
            operationKey: `balance:admin-recharge:grant:${grant.id}`,
            userId,
            tenantId: tenantSubject.tenantId,
            billingAccountId: tenantSubject.billingAccountId,
            type: PrismaTransactionType.RECHARGE,
            amountUsd,
            balanceAfterUsd: wallet.balanceUsd,
            description,
            ...(productId ? { productId } : {}),
            createdAt: financialNow,
          },
        });
        if (debtSource && paidFillUsd.gt(0)) {
          await this.settleBalanceDebtOnFunding(db, {
            billingAccountId: tenantSubject.billingAccountId,
            allocationSource: debtSource,
            repaymentTransactionId: tx.id,
            balanceGrantId: grant.id,
            paidFillUsd,
            bonusFillUsd: new Prisma.Decimal(0),
            financialNow,
            occurredAt: tx.createdAt,
          });
        }
        await this.assertReconciledBalanceLedger(
          db,
          tenantSubject.billingAccountId,
          financialNow,
          'admin recharge postcondition',
          false,
        );

        const response = this.toBalanceTransaction(tx);
        if (idempotencyKey) {
          await this.commitAdminFundingIdempotency(
            db,
            ADMIN_RECHARGE_IDEMPOTENCY_SCOPE,
            idempotencyKey,
            idempotencyRequest,
            response,
          );
        }
        return response;
      },
      );
    } catch (err) {
      if (err instanceof BalanceLedgerReconciliationRequiredError) {
        await this.persistRejectedLedgerQuarantine(err);
        throw err;
      }
      if (!idempotencyKey || !hasPrismaErrorCode(err, 'P2002')) {
        throw err;
      }
      result = await this.replayAdminFundingIdempotency<BalanceTransaction>(
        ADMIN_RECHARGE_IDEMPOTENCY_SCOPE,
        idempotencyKey,
        idempotencyRequest,
      );
      replayed = true;
    }

    if (replayed) {
      await this.refreshBalanceCachesAndForceKeyBalanceSync(userId, tenantSubject);
    } else {
      await this.refreshBalanceCachesAndSyncKeyBalancesOnFundingChange(
        userId,
        tenantSubject,
        beforeKeyBalanceFunding,
      );
    }

    return result;
  }

  /**
   * Freeze BALANCE funding immediately after the immutable Gateway first
   * receipt commits. This is intentionally a separate transaction: the receipt
   * path never waits on a wallet lock, and every financial path keeps the
   * global wallet -> grants -> account -> credit config -> reservation order.
   */
  async reserveGatewayBalanceFunding(
    input: GatewayBalanceFundingReservationInput,
  ): Promise<GatewayBalanceFundingReservationResult> {
    const requestId = input.requestId.trim();
    const billingCurrency = input.billingCurrency.trim().toUpperCase();
    if (!requestId || !input.gatewayBillingEventId.trim() || !input.anchorHash.trim()) {
      throw new BadRequestException('Gateway funding reservation identity is incomplete');
    }
    if (!/^[A-Z]{3}$/.test(billingCurrency)) {
      throw new BadRequestException('Gateway funding reservation currency is invalid');
    }
    if (input.firstReceiptSequence <= 0n) {
      throw new BadRequestException('Gateway funding reservation receipt sequence is invalid');
    }
    const reservedAmountUsd = usd(input.reservedAmountUsd)
      .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
    if (reservedAmountUsd.lt(0)) {
      throw new BadRequestException('Gateway funding reservation amount cannot be negative');
    }
    const subject: BillingAccountSubjectRef = {
      tenantId: input.tenantId,
      billingAccountId: input.billingAccountId,
    };

    return this.prisma.$transaction(async (db) => {
      const financialNow = await this.lockProvisionedWalletLedgerAndCaptureFinancialNow(
        db,
        subject,
        `gateway-funding-reserve:${requestId}`,
      );
      const lockedSubject = await this.lockFrozenGatewayBillingSubjectMetadata(
        db,
        input.userId,
        subject,
      );
      const persistedAnchor = await db.gatewayUsageSettlementAnchor.findUnique({
        where: { gatewayBillingEventId: input.gatewayBillingEventId },
        select: {
          requestId: true,
          apiKeyId: true,
          userId: true,
          tenantId: true,
          billingAccountId: true,
          billingUnit: true,
          billingCurrency: true,
          occurredAt: true,
          firstReceivedAt: true,
          firstReceiptSequence: true,
          fundingReservationProtocol: true,
          anchorHash: true,
        },
      });
      if (
        !persistedAnchor
        || persistedAnchor.requestId !== requestId
        || persistedAnchor.apiKeyId !== input.apiKeyId
        || persistedAnchor.userId !== input.userId
        || persistedAnchor.tenantId !== input.tenantId
        || persistedAnchor.billingAccountId !== input.billingAccountId
        || persistedAnchor.billingUnit !== 'BALANCE'
        || persistedAnchor.billingCurrency !== billingCurrency
        || persistedAnchor.occurredAt.getTime() !== input.occurredAt.getTime()
        || persistedAnchor.firstReceivedAt.getTime() !== input.firstReceivedAt.getTime()
        || persistedAnchor.firstReceiptSequence !== input.firstReceiptSequence
        || persistedAnchor.fundingReservationProtocol !== 'V1'
        || persistedAnchor.anchorHash !== input.anchorHash
      ) {
        throw new ConflictException('Gateway funding reservation anchor binding conflict');
      }
      await db.$queryRaw`
        SELECT "billing_account_id"
        FROM "billing_account_credit_configs"
        WHERE "billing_account_id" = ${lockedSubject.billingAccountId}
        FOR UPDATE
      `;
      // Only unsettled reservations belong to the account's live capacity set:
      // the aggregate below and the INSERT trigger both filter to exactly these
      // two states, and CONSUMED/RELEASED are immutable terminal states that no
      // path revives. Locking them as well made this statement O(account
      // history) — and because the planner then preferred the global
      // reservation_sequence index with a per-row account filter, effectively
      // O(table). One hot account reached 241,498 rows, all CONSUMED, costing
      // ~800ms per event and degrading as the table grew.
      // Kept identical to lockActiveGatewayFundingReservations() below, which
      // has always carried this filter; the two must not drift apart.
      // Probed to close the loop on the 2026-08-28 narrowing: production
      // EXPLAIN predicted cost 76,492 -> 3.77, but that fix's measured effect
      // (+16% throughput) came in at a third of the prediction, so the residual
      // cost of this specific statement was never observed directly. It should
      // now read as single-digit ms; anything else means the narrowing did not
      // hold in practice.
      await timed('resvLockScope', () => db.$queryRaw`
        SELECT "id"
        FROM "gateway_usage_funding_reservations"
        WHERE "billing_account_id" = ${lockedSubject.billingAccountId}
          AND "status" IN ('ACTIVE', 'MANUAL_REVIEW')
        ORDER BY "reservation_sequence" ASC
        FOR UPDATE
      `);

      const existing = await db.gatewayUsageFundingReservation.findUnique({
        where: { requestId },
      });
      if (existing) {
        if (
          existing.gatewayBillingEventId !== input.gatewayBillingEventId
          || existing.billingAccountId !== input.billingAccountId
          || existing.tenantId !== input.tenantId
          || existing.userId !== input.userId
          || existing.apiKeyId !== input.apiKeyId
          || existing.billingCurrency !== billingCurrency
          || existing.collectedFundingProtocol !== GATEWAY_COLLECTED_FUNDING_PROTOCOL
          || existing.anchorHash !== input.anchorHash
          || existing.reservationSequence !== input.firstReceiptSequence
          || !usd(existing.reservedAmountUsd).eq(reservedAmountUsd)
          || existing.occurredAt.getTime() !== input.occurredAt.getTime()
          || existing.firstReceivedAt.getTime() !== input.firstReceivedAt.getTime()
        ) {
          throw new ConflictException('Gateway funding reservation replay conflicts with frozen fact');
        }
        await this.assertGatewayFundingReservationGrantSlices(db, existing);
        if (existing.status === 'ACTIVE') {
          // A committed ACTIVE reservation is the durable replacement for the
          // first-receipt provisional guard. Repair historical/in-flight
          // replays only after the frozen grant slices have been verified.
          await this.releaseGatewayPendingUnreservedGuardAfterFundingReserved(
            db,
            input.gatewayBillingEventId,
            input.billingAccountId,
            financialNow,
          );
        }
        return this.gatewayFundingReservationResult(existing);
      }

      // Capacity is consumed strictly in immutable Billing first-receipt
      // order. A later Kafka partition may reach this transaction first, but
      // it cannot guess around an older receipt whose reservation transaction
      // has not committed yet. Throwing here leaves the receipt's
      // pending_usage_unreserved guard active and makes the consumer retry.
      // Probed separately, and with the empty/non-empty cases under distinct
      // stage names, because the two cost wildly different amounts and only the
      // empty one is on the normal path.
      //
      // The anti-join has to prove "no earlier unreserved anchor exists". When
      // one exists the index scan stops at it; when none does — the normal case
      // for an account that is up to date — the LIMIT 1 cannot terminate early
      // and the scan is exhaustive over the account's whole anchor history
      // (352,998 rows for the hot account on 2026-08-31, production EXPLAIN
      // cost 72,452). Reporting both under one name would average the
      // pathological case away.
      //
      // This measurement is the precondition for deciding whether to re-source
      // the query from the ACTIVE pending_usage_unreserved guard set: that
      // change swaps the query's input rather than adding a filter, so it is
      // riskier than the 2026-08-28 lock narrowing and must not be justified by
      // an EXPLAIN cost alone. Reading cost as benefit is exactly how the
      // previous round's effect estimate came out 3x too high.
      const blockingReceipts = await this.resolveGatewayFundingBlocker(
        db,
        lockedSubject.billingAccountId,
        input.firstReceiptSequence,
      );
      const blockingReceipt = blockingReceipts[0];
      // Zero-duration marker stage: carries the hit/miss split into the same
      // log line as the timing, so `resvBlockingScan` can be read against the
      // outcome that produced it without joining another source.
      await timed(
        blockingReceipt ? 'resvBlockingHit' : 'resvBlockingMiss',
        async () => undefined,
      );
      if (blockingReceipt) {
        throw new GatewayFundingReservationQueuePendingError(
          lockedSubject.billingAccountId,
          requestId,
          blockingReceipt.requestId,
          blockingReceipt.firstReceiptSequence,
        );
      }

      const policyWindow = this.resolveGatewayCreditPolicyWindow({
        gatewayStartAt: input.occurredAt,
        firstReceivedAt: input.firstReceivedAt,
      });
      const snapshot = await this.getWorkspaceBalanceSnapshot(
        input.userId,
        lockedSubject,
        db,
        financialNow,
        undefined,
        policyWindow,
      );
      if (
        snapshot.billingAccountType === ENTERPRISE_ACCOUNT_TYPE
        && (
          !snapshot.creditPolicyReconstructible
          || (
            policyWindow.kind !== 'BOUNDED'
            && !this.isProvenCurrentPrepaidPolicy(snapshot)
          )
        )
      ) {
        throw new EnterpriseCreditPolicyPendingError(
          lockedSubject.billingAccountId,
          snapshot.creditPolicyAt,
        );
      }
      if (snapshot.currency.trim().toUpperCase() !== billingCurrency) {
        throw new ConflictException('Gateway funding reservation currency has drifted');
      }

      const priorFunding = await db.gatewayUsageFundingReservation.aggregate({
        where: {
          billingAccountId: lockedSubject.billingAccountId,
          status: { in: ['ACTIVE', 'MANUAL_REVIEW'] },
        },
        _sum: {
          reservedAmountUsd: true,
          collectedUsd: true,
          approvedCreditUsd: true,
        },
      });
      const priorReservedUsd = usd(priorFunding._sum.reservedAmountUsd ?? 0);
      const priorCollectedUsd = usd(priorFunding._sum.collectedUsd ?? 0);
      const priorApprovedUsd = usd(priorFunding._sum.approvedCreditUsd ?? 0);
      const eligibleGrants = await this.findConsumableBalanceGrants(
        db,
        lockedSubject.billingAccountId,
        input.firstReceivedAt,
        undefined,
        {
          nonExpiringOnly: true,
          createdAtLte: input.firstReceivedAt,
        },
      );
      const activeGrantHolds = await db.gatewayUsageFundingReservationGrant.findMany({
        where: {
          fundingReservation: {
            billingAccountId: lockedSubject.billingAccountId,
            status: { in: ['ACTIVE', 'MANUAL_REVIEW'] },
          },
        },
        select: { balanceGrantId: true, amountUsd: true },
      });
      const heldByGrantId = new Map<string, Prisma.Decimal>();
      for (const hold of activeGrantHolds) {
        heldByGrantId.set(
          hold.balanceGrantId,
          usd(heldByGrantId.get(hold.balanceGrantId) ?? 0)
            .plus(hold.amountUsd)
            .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP),
        );
      }
      const heldGrantTotalUsd = [...heldByGrantId.values()].reduce(
        (sum, amountUsd) => sum.plus(amountUsd),
        usd(0),
      ).toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
      if (!heldGrantTotalUsd.eq(priorCollectedUsd)) {
        throw new ConflictException('Gateway active funding grant holds are incomplete');
      }
      const grantCapacities = eligibleGrants.map((grant) => {
        const heldUsd = heldByGrantId.get(grant.id) ?? usd(0);
        const remainingUsd = usd(grant.remainingAmountUsd);
        if (heldUsd.gt(remainingUsd)) {
          throw new ConflictException('Gateway funding grant holds exceed grant balance');
        }
        return {
          grant,
          availableUsd: remainingUsd
            .minus(heldUsd)
            .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP),
        };
      });
      const provableGrantBalanceAtReceiptUsd = eligibleGrants.reduce(
        (sum, grant) => sum.plus(usd(grant.remainingAmountUsd)),
        usd(0),
      ).toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
      const creditUsedAtReceiptUsd = snapshot.billingAccountType === ENTERPRISE_ACCOUNT_TYPE
        ? await this.conservativeEnterpriseCreditUsedAtReceipt(
            db,
            lockedSubject.billingAccountId,
            snapshot.accountBalanceUsd,
            snapshot.creditUsedUsd,
            snapshot.creditLimitUsd,
            input.firstReceivedAt,
          )
        : usd(0);
      const workspaceAvailableUsd = this.maxUsd(
        usd(0),
        snapshot.workspaceBalanceUsd.minus(priorReservedUsd),
      );
      const cashAvailableUsd = this.maxUsd(
        usd(0),
        grantCapacities.reduce(
          (sum, row) => sum.plus(row.availableUsd),
          usd(0),
        ),
      );
      const approvedAvailableUsd = snapshot.billingAccountType === ENTERPRISE_ACCOUNT_TYPE
        ? this.maxUsd(
            usd(0),
            snapshot.creditLimitUsd
              .minus(creditUsedAtReceiptUsd)
              .minus(priorApprovedUsd),
          )
        : usd(0);
      const provableAvailableUsd = this.minUsd(
        workspaceAvailableUsd,
        cashAvailableUsd.plus(approvedAvailableUsd),
      );
      const collectedUsd = this.minUsd(
        reservedAmountUsd,
        this.minUsd(cashAvailableUsd, provableAvailableUsd),
      ).toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
      const approvedCreditUsd = this.minUsd(
        reservedAmountUsd.minus(collectedUsd),
        this.minUsd(
          approvedAvailableUsd,
          this.maxUsd(usd(0), provableAvailableUsd.minus(collectedUsd)),
        ),
      ).toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
      const unapprovedDebtUsd = reservedAmountUsd
        .minus(collectedUsd)
        .minus(approvedCreditUsd)
        .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
      const approvedCreditDueAt = approvedCreditUsd.gt(0)
        && snapshot.creditTermsDays !== null
        && snapshot.creditTermsDays > 0
        ? new Date(
            snapshot.creditPolicyAt.getTime()
            + snapshot.creditTermsDays * 24 * 60 * 60 * 1_000,
          )
        : null;
      const creditPolicyWindowStart = policyWindow.kind === 'BOUNDED'
        ? policyWindow.earliestAt
        : new Date(Math.min(input.occurredAt.getTime(), input.firstReceivedAt.getTime()));
      const collectedGrantSlices: GatewayFundingGrantSlice[] = [];
      let collectedGrantRemainingUsd = collectedUsd;
      for (const row of grantCapacities) {
        if (collectedGrantRemainingUsd.lte(0)) break;
        const amountUsd = this.minUsd(
          row.availableUsd,
          collectedGrantRemainingUsd,
        ).toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
        if (amountUsd.lte(0)) continue;
        collectedGrantSlices.push({
          balanceGrantId: row.grant.id,
          amountUsd,
          allocationOrder: collectedGrantSlices.length,
        });
        collectedGrantRemainingUsd = collectedGrantRemainingUsd
          .minus(amountUsd)
          .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
      }
      if (collectedGrantRemainingUsd.gt(0)) {
        throw new ConflictException('Gateway collected funding lacks grant-specific backing');
      }

      const canonicalPayload = {
        gatewayBillingEventId: input.gatewayBillingEventId,
        requestId,
        billingAccountId: input.billingAccountId,
        tenantId: input.tenantId,
        userId: input.userId,
        apiKeyId: input.apiKeyId,
        billingUnit: 'BALANCE',
        billingCurrency,
        collectedFundingProtocol: GATEWAY_COLLECTED_FUNDING_PROTOCOL,
        provableNonExpiringGrantBalanceAtReceiptUsd:
          provableGrantBalanceAtReceiptUsd.toFixed(12),
        conservativeCreditUsedAtReceiptUsd: creditUsedAtReceiptUsd.toFixed(12),
        occurredAt: input.occurredAt.toISOString(),
        firstReceivedAt: input.firstReceivedAt.toISOString(),
        firstReceiptSequence: input.firstReceiptSequence.toString(),
        reservedAmountUsd: reservedAmountUsd.toFixed(12),
        collectedUsd: collectedUsd.toFixed(12),
        collectedGrantSlices: this.gatewayFundingGrantSlicePayload(collectedGrantSlices),
        approvedCreditUsd: approvedCreditUsd.toFixed(12),
        unapprovedDebtUsd: unapprovedDebtUsd.toFixed(12),
        creditPolicyAt: snapshot.creditPolicyAt.toISOString(),
        creditPolicyWindowStart: creditPolicyWindowStart.toISOString(),
        creditPolicyEventId: snapshot.creditPolicyEventId,
        creditPolicyRevision: snapshot.creditPolicyRevision,
        creditPolicySource: snapshot.creditPolicySource,
        creditPolicyReconstructible: snapshot.creditPolicyReconstructible,
        creditConfiguredLimitUsd: snapshot.creditConfiguredLimitUsd.toFixed(12),
        creditLimitUsd: snapshot.creditLimitUsd.toFixed(12),
        creditTermsDays: snapshot.creditTermsDays,
        approvedCreditDueAt: approvedCreditDueAt?.toISOString() ?? null,
        creditStatus: snapshot.creditStatus,
        creditEffectiveAt: snapshot.creditEffectiveAt?.toISOString() ?? null,
        creditExpiresAt: snapshot.creditExpiresAt?.toISOString() ?? null,
        anchorHash: input.anchorHash,
      };
      const reservationHash = createHash('sha256')
        .update(canonicalGatewayFundingJson(canonicalPayload))
        .digest('hex');
      const reservation = await db.gatewayUsageFundingReservation.create({
        data: {
          gatewayBillingEventId: input.gatewayBillingEventId,
          requestId,
          billingAccountId: input.billingAccountId,
          tenantId: input.tenantId,
          userId: input.userId,
          apiKeyId: input.apiKeyId,
          billingCurrency,
          collectedFundingProtocol: GATEWAY_COLLECTED_FUNDING_PROTOCOL,
          occurredAt: input.occurredAt,
          firstReceivedAt: input.firstReceivedAt,
          reservationSequence: input.firstReceiptSequence,
          reservedAmountUsd,
          collectedUsd,
          approvedCreditUsd,
          unapprovedDebtUsd,
          creditPolicyAt: snapshot.creditPolicyAt,
          creditPolicyWindowStart,
          creditPolicyEventId: snapshot.creditPolicyEventId,
          creditPolicyRevision: snapshot.creditPolicyRevision,
          creditPolicySource: snapshot.creditPolicySource,
          creditPolicyReconstructible: snapshot.creditPolicyReconstructible,
          creditConfiguredLimitUsd: snapshot.creditConfiguredLimitUsd,
          creditLimitUsd: snapshot.creditLimitUsd,
          creditTermsDays: snapshot.creditTermsDays,
          approvedCreditDueAt,
          creditStatus: snapshot.creditStatus,
          creditEffectiveAt: snapshot.creditEffectiveAt,
          creditExpiresAt: snapshot.creditExpiresAt,
          anchorHash: input.anchorHash,
          reservationHash,
          canonicalPayload: JSON.parse(JSON.stringify(canonicalPayload)) as Prisma.InputJsonValue,
          status: 'ACTIVE',
          reviewReason: null,
          createdAt: financialNow,
        },
      });
      if (collectedGrantSlices.length > 0) {
        await db.gatewayUsageFundingReservationGrant.createMany({
          data: collectedGrantSlices.map((slice) => ({
            fundingReservationId: reservation.id,
            gatewayBillingEventId: reservation.gatewayBillingEventId,
            balanceGrantId: slice.balanceGrantId,
            amountUsd: slice.amountUsd,
            allocationOrder: slice.allocationOrder,
            createdAt: financialNow,
          })),
        });
      }
      // The ACTIVE reservation and every grant-specific hold are now durable
      // in this transaction, so they replace the first-receipt
      // pending_usage_unreserved provisional hold. Keeping the release in the
      // same transaction preserves continuous funding coverage: queue-pending,
      // any earlier failure, and a crash before commit leave the guard ACTIVE;
      // failure to release rolls the reservation and its grant slices back.
      await this.releaseGatewayPendingUnreservedGuardAfterFundingReserved(
        db,
        input.gatewayBillingEventId,
        input.billingAccountId,
        financialNow,
      );
      return this.gatewayFundingReservationResult(reservation);
    }, BALANCE_LEDGER_TRANSACTION_OPTIONS);
  }

  private async releaseGatewayPendingUnreservedGuardAfterFundingReserved(
    db: Prisma.TransactionClient,
    gatewayBillingEventId: string,
    billingAccountId: string,
    financialNow: Date,
  ): Promise<void> {
    await db.billingAccessRestriction.updateMany({
      where: {
        gatewayBillingEventId,
        billingAccountId,
        status: 'ACTIVE',
        reason: 'pending_usage_unreserved',
      },
      data: {
        status: 'RELEASED',
        releasedAt: financialNow,
        releasedBy: 'SYSTEM',
        releaseReason: 'gateway_funding_reserved',
      },
    });
  }

  async releaseGatewayBalanceFundingReservation(
    requestId: string,
    reason: string,
  ): Promise<void> {
    const candidate = await this.prisma.gatewayUsageFundingReservation.findUnique({
      where: { requestId },
      select: { billingAccountId: true, tenantId: true, userId: true },
    });
    if (!candidate) return;
    const subject: BillingAccountSubjectRef = {
      tenantId: candidate.tenantId,
      billingAccountId: candidate.billingAccountId,
    };
    await this.prisma.$transaction(async (db) => {
      const financialNow = await this.lockProvisionedWalletLedgerAndCaptureFinancialNow(
        db,
        subject,
        `gateway-funding-release:${requestId}`,
      );
      await db.$queryRaw`
        SELECT "billing_account_id" FROM "billing_account_credit_configs"
        WHERE "billing_account_id" = ${candidate.billingAccountId} FOR UPDATE
      `;
      await db.$queryRaw`
        SELECT "id" FROM "gateway_usage_funding_reservations"
        WHERE "request_id" = ${requestId} FOR UPDATE
      `;
      const locked = await db.gatewayUsageFundingReservation.findUniqueOrThrow({
        where: { requestId },
        select: { id: true, billingAccountId: true, tenantId: true, userId: true },
      });
      if (
        locked.billingAccountId !== candidate.billingAccountId
        || locked.tenantId !== candidate.tenantId
        || locked.userId !== candidate.userId
      ) {
        throw new ConflictException('Gateway funding reservation release subject conflict');
      }
      await db.$executeRaw`
        SELECT
          set_config(
            'ruidong.gateway_funding_transition_protocol',
            'release-v1',
            true
          ),
          set_config(
            'ruidong.gateway_funding_transition_reservation_id',
            ${locked.id},
            true
          )
      `;
      await db.gatewayUsageFundingReservation.updateMany({
        where: { requestId, status: { in: ['ACTIVE', 'MANUAL_REVIEW'] } },
        data: {
          status: 'RELEASED',
          authoritativeAmountUsd: null,
          consumedAt: null,
          releasedAt: financialNow,
          releaseReason: reason,
        },
      });
    }, BALANCE_LEDGER_TRANSACTION_OPTIONS);
  }

  private gatewayFundingReservationResult(row: {
    id: string;
    requestId: string;
    billingAccountId: string;
    status: string;
    reviewReason: string | null;
    reservedAmountUsd: Prisma.Decimal;
    collectedUsd: Prisma.Decimal;
    approvedCreditUsd: Prisma.Decimal;
    unapprovedDebtUsd: Prisma.Decimal;
  }): GatewayBalanceFundingReservationResult {
    return {
      id: row.id,
      requestId: row.requestId,
      billingAccountId: row.billingAccountId,
      status: row.status,
      reviewReason: row.reviewReason,
      reservedAmountUsd: usd(row.reservedAmountUsd),
      collectedUsd: usd(row.collectedUsd),
      approvedCreditUsd: usd(row.approvedCreditUsd),
      unapprovedDebtUsd: usd(row.unapprovedDebtUsd),
    };
  }

  /** Caller already owns wallet/grants/account; continue the global order. */
  private async lockActiveGatewayFundingReservations(
    db: Prisma.TransactionClient,
    billingAccountId: string,
  ): Promise<{
    reservedAmountUsd: Prisma.Decimal;
    collectedUsd: Prisma.Decimal;
    approvedCreditUsd: Prisma.Decimal;
  }> {
    await db.$queryRaw`
      SELECT "billing_account_id" FROM "billing_account_credit_configs"
      WHERE "billing_account_id" = ${billingAccountId} FOR UPDATE
    `;
    await db.$queryRaw`
      SELECT "id" FROM "gateway_usage_funding_reservations"
      WHERE "billing_account_id" = ${billingAccountId}
        AND "status" IN ('ACTIVE', 'MANUAL_REVIEW')
      ORDER BY "reservation_sequence" ASC
      FOR UPDATE
    `;
    const aggregate = await db.gatewayUsageFundingReservation.aggregate({
      where: {
        billingAccountId,
        status: { in: ['ACTIVE', 'MANUAL_REVIEW'] },
      },
      _sum: {
        reservedAmountUsd: true,
        collectedUsd: true,
        approvedCreditUsd: true,
      },
    });
    return {
      reservedAmountUsd: usd(aggregate._sum.reservedAmountUsd ?? 0),
      collectedUsd: usd(aggregate._sum.collectedUsd ?? 0),
      approvedCreditUsd: usd(aggregate._sum.approvedCreditUsd ?? 0),
    };
  }

  private async assertGatewayReservedCashNotSpent(
    db: Prisma.TransactionClient,
    billingAccountId: string,
  ): Promise<void> {
    const active = await this.lockActiveGatewayFundingReservations(db, billingAccountId);
    const unreservedGuard = await db.billingAccessRestriction.findFirst({
      where: {
        billingAccountId,
        status: 'ACTIVE',
        reason: 'pending_usage_unreserved',
      },
      select: { id: true },
    });
    if (active.reservedAmountUsd.gt(0) || unreservedGuard) {
      throw new GatewayFundingReservationActiveError(billingAccountId);
    }
  }

  private async assertGatewayReservationsPermitGrantExpiry(
    db: Prisma.TransactionClient,
    billingAccountId: string,
  ): Promise<void> {
    await this.lockActiveGatewayFundingReservations(db, billingAccountId);
    const unresolvedGuards = await db.$queryRaw<Array<{ id: string }>>`
      SELECT restriction."id"
      FROM "billing_access_restrictions" AS restriction
      LEFT JOIN "gateway_usage_funding_reservations" AS reservation
        ON reservation."gateway_billing_event_id" = restriction."gateway_billing_event_id"
      WHERE restriction."billing_account_id" = ${billingAccountId}
        AND restriction."status" = 'ACTIVE'
        AND restriction."reason" = 'pending_usage_unreserved'
        AND reservation."id" IS NULL
      ORDER BY restriction."created_at" ASC, restriction."id" ASC
      LIMIT 1
      FOR UPDATE OF restriction
    `;
    const unsafeReservation = await db.gatewayUsageFundingReservation.findFirst({
      where: {
        billingAccountId,
        status: { in: ['ACTIVE', 'MANUAL_REVIEW'] },
        NOT: { collectedFundingProtocol: GATEWAY_COLLECTED_FUNDING_PROTOCOL },
      },
      select: { id: true },
    });
    if (unresolvedGuards.length > 0 || unsafeReservation) {
      throw new GatewayFundingReservationActiveError(billingAccountId);
    }
  }

  private fundingFromGatewayReservation(
    reservation: PrismaGatewayUsageFundingReservation,
    authoritativeAmountUsd: Prisma.Decimal,
    supplementalCollectedCapacityUsd: Prisma.Decimal,
  ): {
    collectedUsd: Prisma.Decimal;
    frozenCollectedUsd: Prisma.Decimal;
    supplementalCollectedUsd: Prisma.Decimal;
    approvedCreditUsd: Prisma.Decimal;
    unapprovedDebtUsd: Prisma.Decimal;
  } {
    // Preserve the first-receipt collected slice, then consume settlement-time
    // unreserved funds (including T0 cash that was not frozen and is still
    // uncommitted at T2), then use only the credit line frozen by the request,
    // and finally classify the remainder as unapproved debt. Strict FIFO and
    // grant holds protect every later request; later credit is never borrowed.
    const frozenCollectedUsd = this.minUsd(
      authoritativeAmountUsd,
      usd(reservation.collectedUsd),
    ).toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
    const remainingAfterFrozenCashUsd = this.maxUsd(
      new Prisma.Decimal(0),
      authoritativeAmountUsd.minus(frozenCollectedUsd),
    );
    const supplementalCollectedUsd = this.minUsd(
      remainingAfterFrozenCashUsd,
      this.maxUsd(new Prisma.Decimal(0), supplementalCollectedCapacityUsd),
    ).toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
    const remainingAfterCashUsd = remainingAfterFrozenCashUsd
      .minus(supplementalCollectedUsd)
      .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
    const approvedCreditUsd = this.minUsd(
      remainingAfterCashUsd,
      usd(reservation.approvedCreditUsd),
    ).toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
    const collectedUsd = frozenCollectedUsd
      .plus(supplementalCollectedUsd)
      .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
    const unapprovedDebtUsd = remainingAfterCashUsd
      .minus(approvedCreditUsd)
      .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
    return {
      collectedUsd,
      frozenCollectedUsd,
      supplementalCollectedUsd,
      approvedCreditUsd,
      unapprovedDebtUsd,
    };
  }

  private frozenFundingPolicyFromReservation(
    reservation: PrismaGatewayUsageFundingReservation,
  ): FrozenEnterpriseFundingPolicy {
    return {
      policyAt: reservation.creditPolicyAt,
      policyRevision: reservation.creditPolicyRevision,
      source: reservation.creditPolicySource as WorkspaceBalanceSnapshot['creditPolicySource'],
      reconstructible: reservation.creditPolicyReconstructible,
      limitUsd: usd(reservation.creditLimitUsd),
      status: reservation.creditStatus,
      termsDays: reservation.creditTermsDays,
      effectiveAt: reservation.creditEffectiveAt,
      expiresAt: reservation.creditExpiresAt,
    };
  }

  async deduct(
    userId: string,
    amount: DecimalLike,
    description: string,
    options: DeductOptions = {},
  ): Promise<{ success: boolean; balance: number; balanceUsd: number }> {
    const frozenGatewaySubject = options.frozenGatewaySubject;
    if (
      frozenGatewaySubject
      && (
        !options.allowTerminalSettlement
        || !options.fundingReservation
        || frozenGatewaySubject.userId !== userId
        || frozenGatewaySubject.tenantId !== options.anchoredTenantId
        || frozenGatewaySubject.billingAccountId !== options.anchoredBillingAccountId
      )
    ) {
      throw new ConflictException('Gateway frozen billing subject authorization is incomplete');
    }
    const subject: BillingAccountSubjectRef = frozenGatewaySubject
      ? {
          tenantId: frozenGatewaySubject.tenantId,
          billingAccountId: frozenGatewaySubject.billingAccountId,
        }
      : await this.requireTenantSubject(userId, { tenantId: options.tenantId });
    const amountUsd = usd(amount).toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
    const currentSnapshot = await this.getWorkspaceBalanceSnapshot(userId, subject);
    // A zero-priced Gateway request can still carry delivered, authoritative
    // usage (for example an enterprise model discount with multiplier=0). It
    // must run the terminal callbacks so TokenUsage, the permanent receipt and
    // the funding-reservation transition commit as one unit. Ordinary zero or
    // negative deductions remain no-ops.
    const requiresZeroAmountGatewayTerminalProof = amountUsd.eq(0)
      && Boolean(
        frozenGatewaySubject
        && options.allowTerminalSettlement
        && options.fundingReservation
        && options.anchoredTenantId
        && options.anchoredBillingAccountId,
      );
    if (amountUsd.lt(0) || (amountUsd.eq(0) && !requiresZeroAmountGatewayTerminalProof)) {
      return {
        success: true,
        balance: usdToCents(currentSnapshot.workspaceBalanceUsd),
        balanceUsd: usdNumber(currentSnapshot.workspaceBalanceUsd),
      };
    }
    const currentBalanceUsd = currentSnapshot.workspaceBalanceUsd;
    const beforeKeyBalanceFunding = this.keyBalanceFundingStateFromBalance(userId, subject, currentBalanceUsd);
    let overdraftLimitUsd = new Prisma.Decimal(0);

    // 企业账户使用账户级信用额度，currentBalanceUsd 已经是「钱包余额 + 有效信用额度」
    // 再叠加 workspace allowance 后的可用余额。因此预检按 0 判定即可；真正的钱包
    // 负数上限会在事务内用最新信用配置再次校验。
    const allowPersonalNegativeBalance = Boolean(options.allowNegativeBalance)
      && currentSnapshot.billingAccountType !== ENTERPRISE_ACCOUNT_TYPE;
    const allowTerminalSettlement = Boolean(options.allowTerminalSettlement);
    const fundingPolicyWindow = allowTerminalSettlement && options.fundingPolicyOccurrence
      ? this.resolveGatewayCreditPolicyWindow(options.fundingPolicyOccurrence)
      : undefined;
    const allowPostDeliveryOverage = allowPersonalNegativeBalance || allowTerminalSettlement;
    if (!allowPostDeliveryOverage && currentSnapshot.billingAccountType === ENTERPRISE_ACCOUNT_TYPE) {
      if (currentBalanceUsd.minus(amountUsd).lt(0)) {
        return { success: false, balance: usdToCents(currentBalanceUsd), balanceUsd: usdNumber(currentBalanceUsd) };
      }
      const projectedAccountBalance = currentSnapshot.accountBalanceUsd.minus(amountUsd);
      if (projectedAccountBalance.lt(0) && currentSnapshot.creditLimitUsd.gt(0)) {
        this.logger.log(
          `enterprise_credit_used account=${subject.billingAccountId} tenant=${subject.tenantId} ` +
            `user=${userId} amountUsd=${amountUsd.toFixed()} ` +
            `accountBalanceUsd=${currentSnapshot.accountBalanceUsd.toFixed()} ` +
            `limitUsd=${currentSnapshot.creditLimitUsd.toFixed()} ` +
            `projectedAccountBalanceUsd=${projectedAccountBalance.toFixed()}`,
        );
      }
    }

    // P2-C: CreditPolicy hook —— 个人账户前置检查透支额度。
    //
    // 设计要点(spec §7.3):
    //   - resolvePolicyForUser 自带 60s Redis cache,主链路开销 < 2ms
    //   - @Optional 注入,policy 模块未加载时退化为现状(不允许透支)
    //   - 加载失败/抛错 → 走保守路径(不允许透支),不破坏 deduct
    //   - 不改 Lua,接受前置检查的悲观估计(并发两笔扣款最多多扣到 -limit-amount)
    //
    // 当 policy.allowOverdraft=true 且 limitCents>0 时,允许扣到 -limitCents;
    // 否则严格不允许透支(等价 Lua 现有 >=0 检查)。
    //
    if (
      !allowPostDeliveryOverage &&
      currentSnapshot.billingAccountType !== ENTERPRISE_ACCOUNT_TYPE &&
      this.creditPolicy
    ) {
      try {
        const policy = options.productId
          ? await this.creditPolicy.resolvePolicyForUser(userId, options.productId)
          : await this.creditPolicy.resolvePolicyForUser(userId);
        overdraftLimitUsd = policy.allowOverdraft ? centsToUsd(policy.creditLimitCents) : new Prisma.Decimal(0);
        if (currentBalanceUsd.minus(amountUsd).lt(overdraftLimitUsd.neg())) {
          return { success: false, balance: usdToCents(currentBalanceUsd), balanceUsd: usdNumber(currentBalanceUsd) };
        }
        // P2-C review fix(Important #2): 透支审计日志。
        // 实际放行透支(扣完后会负 但仍在 limit 内)的路径:运营出问题时
        // 必须能 grep 出"哪些用户/何时/扣了多少透支",否则无法回查。
        // 关键字 "credit_overdraft_used" 标准化用于日志筛选。
        const projectedBalance = currentBalanceUsd.minus(amountUsd);
        if (
          projectedBalance.lt(0) &&
          policy.allowOverdraft &&
          overdraftLimitUsd.gt(0)
        ) {
          this.logger.log(
            `credit_overdraft_used user=${userId} amountUsd=${amountUsd.toFixed()} ` +
              `currentBalanceUsd=${currentBalanceUsd.toFixed()} limitUsd=${overdraftLimitUsd.toFixed()} ` +
              `projectedBalanceUsd=${projectedBalance.toFixed()}`,
          );
        }
      } catch (err) {
        // resolvePolicyForUser 内部已 fallback,几乎不会抛;
        // 如果抛了 → 保守拒绝透支,防止配置故障导致大额透支。
        this.logger.warn(
          `deduct policy hook failed (user=${userId}): ${(err as Error)?.message ?? err}; falling back to strict no-overdraft.`,
        );
        if (currentBalanceUsd.minus(amountUsd).lt(0)) {
          return { success: false, balance: usdToCents(currentBalanceUsd), balanceUsd: usdNumber(currentBalanceUsd) };
        }
      }
    }

    let committed: {
      snapshot: WorkspaceBalanceSnapshot;
      subject: BillingAccountSubjectRef;
    } | null = null;
    try {
      // Probe on the transaction boundary itself. Everything inside it is
      // covered by nested probes, so this stage's SELF time is the part that
      // belongs to no inner step: BEGIN, COMMIT, and the deferred constraint
      // triggers that fire at COMMIT. That makes it the direct measurement of a
      // claim this investigation has now entertained twice without evidence —
      // once falsified at 0.8% of slow queries (2026-08-26), then re-suggested
      // by COMMIT reaching 67% of them (2026-08-31). Read `dedTxn` self time
      // against the enclosing stage, not the slow-log share.
      committed = await timed('dedTxn', () => this.prisma.$transaction(async (db) => {
        // 所有 wallet/grant/marker 写统一使用 wallet → grants → account 锁序。
        // 尤其 DIRTY 快路径也必须先持有 wallet，避免与历史 repair 交错：repair
        // 不能在快照后把账户标 CLEAN，而本扣费又在其后写入旧账本状态。
        const financialNow = await this.lockProvisionedWalletLedgerAndCaptureFinancialNow(
          db,
          subject,
          `balance-deduct:${subject.billingAccountId}`,
        );
        const lockedSubject = frozenGatewaySubject
          ? await this.lockFrozenGatewayBillingSubjectMetadata(
              db,
              userId,
              subject,
            )
          : await this.lockProvisionedBillingSubjectMetadata(
              db,
              userId,
              subject,
            );
        // 企业信用额度并发防护：扣费与管理端下调额度必须互斥，否则本事务会按
        // 旧额度放行、钱包负数超过新额度。先锁 credit config 行（个人账户无该行，
        // 锁空集无开销），保证下面快照读到的额度在提交前不会被并发修改。
        await db.$queryRaw`SELECT "billing_account_id" FROM "billing_account_credit_configs" WHERE "billing_account_id" = ${lockedSubject.billingAccountId} FOR UPDATE`;
        let lockedFundingReservation: PrismaGatewayUsageFundingReservation | null = null;
        let lockedFundingReservationGrantSlices: GatewayFundingGrantSlice[] = [];
        let activeFrozenCollectedUsd = new Prisma.Decimal(0);
        if (options.fundingReservation) {
          await db.$queryRaw`
            SELECT "id" FROM "gateway_usage_funding_reservations"
            WHERE "billing_account_id" = ${lockedSubject.billingAccountId}
              AND "status" IN ('ACTIVE', 'MANUAL_REVIEW')
            ORDER BY "reservation_sequence" ASC
            FOR UPDATE
          `;
          lockedFundingReservation = await db.gatewayUsageFundingReservation.findUnique({
            where: { requestId: options.fundingReservation.requestId },
          });
          if (!lockedFundingReservation) {
            throw new ConflictException('Gateway BALANCE settlement funding reservation is missing');
          }
          if (
            lockedFundingReservation.billingAccountId !== lockedSubject.billingAccountId
            || lockedFundingReservation.tenantId !== lockedSubject.tenantId
            || lockedFundingReservation.userId !== userId
            || lockedFundingReservation.anchorHash !== options.fundingReservation.anchorHash
            || lockedFundingReservation.billingUnit !== 'BALANCE'
            || createHash('sha256')
              .update(canonicalGatewayFundingJson(lockedFundingReservation.canonicalPayload))
              .digest('hex') !== lockedFundingReservation.reservationHash
          ) {
            throw new ConflictException('Gateway funding reservation binding/hash conflict');
          }
          lockedFundingReservationGrantSlices =
            await this.assertGatewayFundingReservationGrantSlices(
              db,
              lockedFundingReservation,
            );
          if (
            lockedFundingReservation.status === 'MANUAL_REVIEW'
            && !options.fundingReservation.reconciliationActionId
          ) {
            throw new ConflictException('Gateway funding reservation requires approved reconciliation');
          }
          if (
            lockedFundingReservation.status === 'MANUAL_REVIEW'
            && options.fundingReservation.reconciliationActionId
          ) {
            const approvedAction = await db.gatewayUsageReconciliationAction.findFirst({
              where: {
                id: options.fundingReservation.reconciliationActionId,
                gatewayBillingEventId: options.fundingReservation.gatewayBillingEventId,
                requestId: options.fundingReservation.requestId,
                action: 'RECONCILE_SETTLE',
              },
              select: { id: true, actorId: true, reason: true, metadata: true },
            });
            const approvalMetadata = approvedAction?.metadata
              && typeof approvedAction.metadata === 'object'
              && !Array.isArray(approvedAction.metadata)
              ? approvedAction.metadata as Record<string, unknown>
              : null;
            if (
              !approvedAction
              || !approvedAction.actorId?.trim()
              || !approvedAction.reason.trim()
              || approvalMetadata?.evidenceHash !== options.fundingReservation.evidenceHash
            ) {
              throw new ConflictException(
                'Gateway funding reservation override lacks permanent reconciliation approval',
              );
            }
          }
          if (!['ACTIVE', 'MANUAL_REVIEW'].includes(lockedFundingReservation.status)) {
            throw new ConflictException('Gateway funding reservation is no longer settleable');
          }
          const lowerUnsettled = await db.gatewayUsageFundingReservation.findFirst({
            where: {
              billingAccountId: lockedSubject.billingAccountId,
              status: { in: ['ACTIVE', 'MANUAL_REVIEW'] },
              reservationSequence: { lt: lockedFundingReservation.reservationSequence },
            },
            orderBy: { reservationSequence: 'asc' },
            select: { requestId: true, reservationSequence: true },
          });
          if (lowerUnsettled) {
            throw new GatewayFundingReservationQueuePendingError(
              lockedSubject.billingAccountId,
              lockedFundingReservation.requestId,
              lowerUnsettled.requestId,
              lowerUnsettled.reservationSequence,
            );
          }
          const activeFunding = await db.gatewayUsageFundingReservation.aggregate({
            where: {
              billingAccountId: lockedSubject.billingAccountId,
              status: { in: ['ACTIVE', 'MANUAL_REVIEW'] },
            },
            _sum: { collectedUsd: true },
          });
          activeFrozenCollectedUsd = usd(activeFunding._sum.collectedUsd ?? 0);
        } else if (options.allowTerminalSettlement) {
          // Historical QUARANTINED/RETRYABLE rows have no first-receipt funding
          // fact. Never manufacture one at retry time from today's wallet.
          throw new ConflictException('Gateway BALANCE terminal settlement requires first-receipt funding reservation');
        } else {
          await this.assertGatewayReservedCashNotSpent(
            db,
            lockedSubject.billingAccountId,
          );
        }
        if (
          (options.anchoredTenantId && lockedSubject.tenantId !== options.anchoredTenantId) ||
          (options.anchoredBillingAccountId && lockedSubject.billingAccountId !== options.anchoredBillingAccountId)
        ) {
          throw new ConflictException('Gateway settlement anchor 账务主体已漂移');
        }
        if (lockedFundingReservation) {
          const terminalLedger = await this.reconciledBalanceLedgerContext(
            db,
            lockedSubject.billingAccountId,
          );
          if (!terminalLedger.reconciled) {
            // An allocation row is not proof that a LEGACY_DIRTY grant was
            // actually reduced. Keep the immutable reservation active and let
            // the Gateway worker retry after the account is promoted to V2.
            throw new BalanceLedgerReconciliationRequiredError(
              lockedSubject.billingAccountId,
              'Gateway terminal settlement requires RECONCILED_V2 ledger',
            );
          }
        }
        if (options.validateAnchoredSubject) {
          await options.validateAnchoredSubject(db);
        }
        const fundingPolicySnapshot = await this.getWorkspaceBalanceSnapshot(
          userId,
          lockedSubject,
          db,
          financialNow,
          !lockedFundingReservation && options.allowTerminalSettlement && !fundingPolicyWindow
            ? options.fundingPolicyAt
            : undefined,
          lockedFundingReservation ? undefined : fundingPolicyWindow,
        );
        if (
          !lockedFundingReservation
          &&
          fundingPolicySnapshot.billingAccountType === ENTERPRISE_ACCOUNT_TYPE
          && !fundingPolicySnapshot.creditPolicyReconstructible
        ) {
          // No wallet, allowance, grant or transaction mutation may be chosen
          // from an unknown historical policy. The surrounding Gateway worker
          // can safely retry after the credit boundary confirmation completes.
          throw new EnterpriseCreditPolicyPendingError(
            lockedSubject.billingAccountId,
            fundingPolicySnapshot.creditPolicyAt,
          );
        }
        // Frozen V1 cash is backed only by non-expiring grants. Expire every
        // unrelated due grant before classifying supplemental settlement cash;
        // the reservation-aware expiry guard proves no frozen slice is touched.
        await this.expireAccountBalanceGrants(db, lockedSubject, financialNow);
        await this.assertReconciledBalanceLedger(
          db,
          lockedSubject.billingAccountId,
          financialNow,
          'deduct precondition',
        );
        // Grant expiry can change the wallet. Re-read balances after it, while
        // the already-validated credit policy remains serialized by its lock.
        const spendSnapshot = await this.getWorkspaceBalanceSnapshot(
          userId,
          lockedSubject,
          db,
          financialNow,
          !lockedFundingReservation && options.allowTerminalSettlement && !fundingPolicyWindow
            ? options.fundingPolicyAt
            : undefined,
          lockedFundingReservation ? undefined : fundingPolicyWindow,
        );
        if (!lockedFundingReservation && !spendSnapshot.creditPolicyReconstructible) {
          throw new EnterpriseCreditPolicyPendingError(
            lockedSubject.billingAccountId,
            spendSnapshot.creditPolicyAt,
          );
        }
        // The legacy negative-balance option remains deliberately personal-only.
        // A separate terminal-settlement option is reserved for trusted Gateway
        // events whose upstream response has already been delivered. In that
        // case rejecting the charge would lose financial evidence, so the whole
        // request is recorded before Publisher closes the Key.
        const allowLockedPersonalNegativeBalance = Boolean(options.allowNegativeBalance)
          && spendSnapshot.billingAccountType !== ENTERPRISE_ACCOUNT_TYPE;
        const allowLockedTerminalSettlement = Boolean(options.allowTerminalSettlement);
        const allowLockedWalletOverdraft = Boolean(options.allowWalletOverdraft);
        const allowLockedPostDeliveryOverage =
          allowLockedPersonalNegativeBalance
          || allowLockedTerminalSettlement
          || allowLockedWalletOverdraft;
        const transactionOverdraftLimitUsd = spendSnapshot.billingAccountType === ENTERPRISE_ACCOUNT_TYPE
          ? spendSnapshot.creditLimitUsd
          : overdraftLimitUsd;
        const projectedAvailableUsd = spendSnapshot.workspaceBalanceUsd.minus(amountUsd);
        const availableFloorUsd = spendSnapshot.billingAccountType === ENTERPRISE_ACCOUNT_TYPE
          ? new Prisma.Decimal(0)
          : transactionOverdraftLimitUsd.neg();
        if (!allowLockedPostDeliveryOverage && projectedAvailableUsd.lt(availableFloorUsd)) {
          throw new Error('BILLING_DEDUCT_REJECTED');
        }
        if (lockedFundingReservation && amountUsd.gt(0)) {
          // Mark the complete wallet mutation window so the database can route
          // only rows belonging to this immutable reservation to its bounded
          // Gateway canonical proof.
          await db.$executeRaw`
            SELECT set_config(
              'ruidong.gateway_consuming_reservation_id',
              ${lockedFundingReservation.id},
              true
            )
          `;
        }
        if (amountUsd.gt(0)) {
          const allowanceUpdated = await this.consumeWorkspaceAllowance(
            db,
            lockedSubject,
            amountUsd,
            allowLockedPostDeliveryOverage,
          );
          if (!allowanceUpdated) {
            throw new Error('BILLING_DEDUCT_REJECTED');
          }
          const updated = await db.accountWallet.updateMany({
            where: allowLockedPostDeliveryOverage
              ? { billingAccountId: lockedSubject.billingAccountId }
              : {
                  billingAccountId: lockedSubject.billingAccountId,
                  balanceUsd: { gte: amountUsd.minus(transactionOverdraftLimitUsd) },
                },
            data: { balanceUsd: { decrement: amountUsd } },
          });
          if (updated.count === 0) {
            throw new Error('BILLING_DEDUCT_REJECTED');
          }
        }
        const wallet = await db.accountWallet.findUniqueOrThrow({
          where: { billingAccountId: lockedSubject.billingAccountId },
        });
        // Funding is classified from the exact wallet transition protected by
        // the wallet lock. Cumulative negative balance must never be mistaken
        // for this request's funding: before = after + this charge.
        const walletBalanceAfterUsd = usd(wallet.balanceUsd);
        const walletBalanceBeforeUsd = walletBalanceAfterUsd.plus(amountUsd);
        if (
          allowLockedTerminalSettlement
          && spendSnapshot.billingAccountType === ENTERPRISE_ACCOUNT_TYPE
        ) {
          const accountAvailableAfterUsd = walletBalanceAfterUsd.plus(
            spendSnapshot.creditLimitUsd,
          );
          if (accountAvailableAfterUsd.lt(0)) {
            this.logger.warn(
              `enterprise_terminal_settlement account=${lockedSubject.billingAccountId} `
              + `tenant=${lockedSubject.tenantId} user=${userId} `
              + `amountUsd=${amountUsd.toFixed()} walletAfterUsd=${walletBalanceAfterUsd.toFixed()} `
              + `creditLimitUsd=${spendSnapshot.creditLimitUsd.toFixed()} `
              + `overageUsd=${accountAvailableAfterUsd.neg().toFixed()}`,
            );
          }
        }
        const negativeAt = (balanceUsd: Prisma.Decimal): Prisma.Decimal => this.maxUsd(
          new Prisma.Decimal(0),
          balanceUsd.neg(),
        );
        const negativeBeforeUsd = negativeAt(walletBalanceBeforeUsd);
        const negativeAfterUsd = negativeAt(walletBalanceAfterUsd);
        let approvedCreditUsd = new Prisma.Decimal(0);
        let unapprovedDebtUsd = new Prisma.Decimal(0);
        let negativeBalanceAmountUsd = new Prisma.Decimal(0);
        let collectedUsd: Prisma.Decimal;
        let frozenCollectedUsd = new Prisma.Decimal(0);
        let supplementalCollectedUsd = new Prisma.Decimal(0);
        if (lockedFundingReservation) {
          const postReceiptCashPoolUsd = this.maxUsd(
            new Prisma.Decimal(0),
            this.maxUsd(new Prisma.Decimal(0), walletBalanceBeforeUsd)
              .minus(activeFrozenCollectedUsd),
          );
          const supplementalCollectedCapacityUsd = this.maxUsd(
            new Prisma.Decimal(0),
            postReceiptCashPoolUsd,
          );
          const reservedFunding = this.fundingFromGatewayReservation(
            lockedFundingReservation,
            amountUsd,
            supplementalCollectedCapacityUsd,
          );
          collectedUsd = reservedFunding.collectedUsd;
          frozenCollectedUsd = reservedFunding.frozenCollectedUsd;
          supplementalCollectedUsd = reservedFunding.supplementalCollectedUsd;
          unapprovedDebtUsd = reservedFunding.unapprovedDebtUsd;
          if (spendSnapshot.billingAccountType === ENTERPRISE_ACCOUNT_TYPE) {
            approvedCreditUsd = reservedFunding.approvedCreditUsd;
          } else {
            if (reservedFunding.approvedCreditUsd.gt(0)) {
              throw new ConflictException('Personal Gateway reservation contains enterprise credit');
            }
            negativeBalanceAmountUsd = reservedFunding.unapprovedDebtUsd;
          }
        } else if (spendSnapshot.billingAccountType === ENTERPRISE_ACCOUNT_TYPE) {
          const approvedBeforeUsd = this.minUsd(
            spendSnapshot.creditLimitUsd,
            negativeBeforeUsd,
          );
          const approvedAfterUsd = this.minUsd(
            spendSnapshot.creditLimitUsd,
            negativeAfterUsd,
          );
          approvedCreditUsd = this.maxUsd(
            new Prisma.Decimal(0),
            approvedAfterUsd.minus(approvedBeforeUsd),
          ).toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
          const unapprovedBeforeUsd = this.maxUsd(
            new Prisma.Decimal(0),
            negativeBeforeUsd.minus(spendSnapshot.creditLimitUsd),
          );
          const unapprovedAfterUsd = this.maxUsd(
            new Prisma.Decimal(0),
            negativeAfterUsd.minus(spendSnapshot.creditLimitUsd),
          );
          unapprovedDebtUsd = this.maxUsd(
            new Prisma.Decimal(0),
            unapprovedAfterUsd.minus(unapprovedBeforeUsd),
          ).toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
          collectedUsd = amountUsd
            .minus(approvedCreditUsd)
            .minus(unapprovedDebtUsd)
            .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
        } else {
          negativeBalanceAmountUsd = this.maxUsd(
            new Prisma.Decimal(0),
            negativeAfterUsd.minus(negativeBeforeUsd),
          ).toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
          unapprovedDebtUsd = negativeBalanceAmountUsd;
          collectedUsd = amountUsd
            .minus(unapprovedDebtUsd)
            .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
        }
        if (collectedUsd.lt(0)) {
          throw new Error('BALANCE_FUNDING_CLASSIFICATION_INVALID');
        }
        const applicableFundingFloorUsd = spendSnapshot.billingAccountType === ENTERPRISE_ACCOUNT_TYPE
          ? spendSnapshot.creditLimitUsd.neg()
          : overdraftLimitUsd.neg();
        const debtExposureUsd = lockedFundingReservation
          ? unapprovedDebtUsd
          : this.maxUsd(
              new Prisma.Decimal(0),
              applicableFundingFloorUsd.minus(walletBalanceAfterUsd),
            );
        const debtOpen = unapprovedDebtUsd.gt(0) || debtExposureUsd.gt(0);
        const fundingPolicy = lockedFundingReservation
          ? this.frozenFundingPolicyFromReservation(lockedFundingReservation)
          : {
              policyAt: spendSnapshot.creditPolicyAt,
              policyRevision: spendSnapshot.creditPolicyRevision,
              source: spendSnapshot.creditPolicySource,
              reconstructible: spendSnapshot.creditPolicyReconstructible,
              limitUsd: spendSnapshot.creditLimitUsd,
              status: spendSnapshot.creditStatus,
              termsDays: spendSnapshot.creditTermsDays,
              effectiveAt: spendSnapshot.creditEffectiveAt,
              expiresAt: spendSnapshot.creditExpiresAt,
            };
        const beforeResult = options.beforeBalanceTransaction
          ? await options.beforeBalanceTransaction(db, {
              debtOpen,
              debtExposureUsd,
              collectedUsd,
              approvedCreditUsd,
              unapprovedDebtUsd,
            })
          : undefined;
        const tokenUsageId = beforeResult?.tokenUsageId ?? options.tokenUsageId;
        let balanceTransactionId: string | null = null;
        if (amountUsd.gt(0)) {
          const tx = await db.balanceTransaction.create({
            data: {
              ...(options.operationKey ? { operationKey: options.operationKey } : {}),
              userId,
              tenantId: lockedSubject.tenantId,
              billingAccountId: lockedSubject.billingAccountId,
              type: PrismaTransactionType.CONSUME,
              amountUsd: amountUsd.neg(),
              balanceAfterUsd: wallet.balanceUsd,
              description,
              ...(options.productId ? { productId: options.productId } : {}),
              tokenUsageId,
              createdAt: financialNow,
            },
          });
          balanceTransactionId = tx.id;
          await this.allocateBalanceConsumption(db, {
            userId,
            tenantId: lockedSubject.tenantId,
            billingAccountId: lockedSubject.billingAccountId,
            productId: options.productId,
            tokenUsageId,
            balanceTransactionId,
            amountUsd,
            enterpriseApprovedCreditAmountUsd: approvedCreditUsd,
            enterpriseUnapprovedDebtAmountUsd:
              spendSnapshot.billingAccountType === ENTERPRISE_ACCOUNT_TYPE
                ? unapprovedDebtUsd
                : new Prisma.Decimal(0),
            negativeBalanceAmountUsd,
            financialNow: lockedFundingReservation?.firstReceivedAt ?? financialNow,
            gatewayFundingReservationId: lockedFundingReservation?.id,
            gatewayReservedGrantSlices: lockedFundingReservation
              ? lockedFundingReservationGrantSlices
              : undefined,
            gatewayReservedCollectedAmountUsd: lockedFundingReservation
              ? frozenCollectedUsd
              : undefined,
            gatewaySupplementalCollectedAmountUsd: lockedFundingReservation
              ? supplementalCollectedUsd
              : undefined,
            gatewaySupplementalFundingAt: lockedFundingReservation
              ? financialNow
              : undefined,
            enterpriseCreditPolicyAt: fundingPolicy.policyAt,
            enterpriseCreditTermsDays: fundingPolicy.limitUsd.gt(0)
              ? fundingPolicy.termsDays
              : null,
            // Every written row carries a reconstructible policy decision.
            // HISTORY_UNAVAILABLE is retried before any financial mutation.
            enterpriseCreditPolicySnapshotComplete: true,
          });
        }
        if (lockedFundingReservation) {
          await db.$executeRaw`
            SELECT
              set_config(
                'ruidong.gateway_funding_transition_protocol',
                'consume-v1',
                true
              ),
              set_config(
                'ruidong.gateway_funding_transition_reservation_id',
                ${lockedFundingReservation.id},
                true
              )
          `;
          const consumed = await db.gatewayUsageFundingReservation.updateMany({
            where: {
              id: lockedFundingReservation.id,
              status: { in: ['ACTIVE', 'MANUAL_REVIEW'] },
            },
            data: {
              status: 'CONSUMED',
              authoritativeAmountUsd: amountUsd,
              consumedAt: financialNow,
              releasedAt: null,
              releaseReason: null,
            },
          });
          if (consumed.count !== 1) {
            throw new ConflictException('Gateway funding reservation state changed during settlement');
          }
        }
        await this.assertReconciledBalanceLedger(
          db,
          lockedSubject.billingAccountId,
          financialNow,
          'deduct postcondition',
          false,
        );
        const nextSnapshot = await this.getWorkspaceBalanceSnapshot(
          userId,
          lockedSubject,
          db,
          financialNow,
          !lockedFundingReservation && options.allowTerminalSettlement && !fundingPolicyWindow
            ? options.fundingPolicyAt
            : undefined,
          lockedFundingReservation ? undefined : fundingPolicyWindow,
        );
        if (options.afterBalanceTransaction) {
          await options.afterBalanceTransaction(db, nextSnapshot, {
            balanceTransactionId,
            billingAccountId: lockedSubject.billingAccountId,
            tenantId: lockedSubject.tenantId,
            tokenUsageId,
            debtOpen,
            debtExposureUsd,
            collectedUsd,
            approvedCreditUsd,
            unapprovedDebtUsd,
            fundingPolicy,
          });
        }
        return {
          snapshot: nextSnapshot,
          subject: this.billingSubjectRef(lockedSubject),
        };
      }, BALANCE_LEDGER_TRANSACTION_OPTIONS));
    } catch (err) {
      if (err instanceof BalanceLedgerReconciliationRequiredError) {
        await this.persistRejectedLedgerQuarantine(err);
        throw err;
      }
      const message = err instanceof Error ? err.message : String(err);
      if (message !== 'BILLING_DEDUCT_REJECTED') {
        throw err;
      }
    }

    if (committed === null) {
      const current = await this.getBalanceUsd(userId, subject);
      this.scheduleKeyBalanceSyncWhenFundingStateChanges(beforeKeyBalanceFunding, current);
      return { success: false, balance: usdToCents(current), balanceUsd: usdNumber(current) };
    }

    const { snapshot, subject: committedSubject } = committed;
    try {
      const projection = await this.projectAnchoredBalanceCaches(userId, committedSubject);
      if (projection.bindingUnchanged) {
        this.scheduleKeyBalanceSyncWhenFundingStateChanges(beforeKeyBalanceFunding, snapshot);
      } else {
        this.scheduleKeyBalanceSync(
          userId,
          committedSubject.tenantId,
          committedSubject.billingAccountId,
        );
      }
    } catch (err) {
      this.logger.warn(
        `deduct balance projection refresh failed user=${userId} `
        + `account=${committedSubject.billingAccountId}: `
        + `${err instanceof Error ? err.message : String(err)}`,
      );
      this.scheduleKeyBalanceSync(
        userId,
        committedSubject.tenantId,
        committedSubject.billingAccountId,
      );
    }
    return {
      success: true,
      balance: usdToCents(snapshot.workspaceBalanceUsd),
      balanceUsd: usdNumber(snapshot.workspaceBalanceUsd),
    };
  }

  async adjust(
    userId: string,
    amountCents: number,
    description: string,
    productId?: string | null,
    subject: BillingSubjectOptions = {},
  ): Promise<BalanceTransaction> {
    if (!Number.isSafeInteger(amountCents) || amountCents === 0) {
      throw new BadRequestException('调额金额必须为非零整数分值');
    }
    const amountUsd = centsToUsd(amountCents);
    const tenantSubject = await this.requireTenantSubject(userId, subject);
    const beforeKeyBalanceFunding = await this.captureKeyBalanceFundingState(userId, tenantSubject);
    const idempotencyKey = this.normalizeAdminFundingIdempotencyKey(subject.idempotencyKey);
    const idempotencyRequest: AdminFundingRequestFingerprint = {
      scope: ADMIN_ADJUST_BALANCE_IDEMPOTENCY_SCOPE,
      userId,
      tenantId: tenantSubject.tenantId,
      billingAccountId: tenantSubject.billingAccountId,
      amountUsd: usdString(amountUsd),
      productId: productId ?? null,
      description,
      reason: null,
      expiresAt: null,
      performedBy: null,
    };
    let result: BalanceTransaction;
    let replayed = false;
    try {
      result = await this.runBalanceLedgerTransaction(
        'adjust',
        `user=${userId} idem=${idempotencyKey ?? "none"}`,
        async (db) => {
        if (idempotencyKey) {
          await this.writePendingAdminFundingIdempotency(
            db,
            ADMIN_ADJUST_BALANCE_IDEMPOTENCY_SCOPE,
            idempotencyKey,
            idempotencyRequest,
          );
        }
        const financialNow = await this.lockWalletLedgerAndCaptureFinancialNow(
          db,
          userId,
          tenantSubject,
          `admin-adjust:${idempotencyKey ?? userId}`,
        );
        await this.lockProvisionedBillingSubjectMetadata(db, userId, tenantSubject);
        await this.expireAccountBalanceGrants(db, tenantSubject, financialNow);
        await this.assertReconciledBalanceLedger(
          db,
          tenantSubject.billingAccountId,
          financialNow,
          'admin adjustment precondition',
        );
        const ledgerContext = await this.reconciledBalanceLedgerContext(
          db,
          tenantSubject.billingAccountId,
        );
        const walletBefore = await db.accountWallet.findUniqueOrThrow({
          where: { billingAccountId: tenantSubject.billingAccountId },
          select: { balanceUsd: true },
        });
        const walletBeforeUsd = usd(walletBefore.balanceUsd);
        const isClassifiedEnterprisePaidDebtRequest = (
          ledgerContext.reconciled
          && ledgerContext.allocationSource === BALANCE_ALLOCATION_SOURCE_ENTERPRISE_CREDIT
          && idempotencyKey !== null
          && amountUsd.gt(0)
          && walletBeforeUsd.lt(0)
          && amountUsd.lte(walletBeforeUsd.neg())
        );
        if (
          ledgerContext.reconciled
          && !amountUsd.eq(0)
          && !isClassifiedEnterprisePaidDebtRequest
        ) {
          // A generic adjustment does not declare whether it is paid funding,
          // bonus, refund, or consumption.  Demoting a healthy account after
          // the rejected transaction would let an automatic retry bypass the
          // V2 invariant.  Keep CLEAN unchanged and require a classified
          // funding/refund/consumption primitive instead.
          throw new BadRequestException('BALANCE_ADJUSTMENT_REQUIRES_CLASSIFIED_LEDGER_PATH');
        }
        if (amountUsd.lt(0)) {
          await this.assertGatewayReservedCashNotSpent(
            db,
            tenantSubject.billingAccountId,
          );
        }
        const wallet = await this.incrementAccountWallet(db, userId, tenantSubject, amountUsd);
        const paidFillUsd = this.walletHoleFillUsd(wallet.balanceUsd, amountUsd);
        const isEnterprisePaidDebt = (
          paidFillUsd.gt(0)
          && paidFillUsd.eq(amountUsd)
          && usd(wallet.balanceUsd).lte(0)
          && ledgerContext.allocationSource === BALANCE_ALLOCATION_SOURCE_ENTERPRISE_CREDIT
        );
        // The admin endpoint requires an idempotency key.  Persist that key as
        // an immutable funding classification only when the entire adjustment
        // is a paid enterprise-debt repayment.  Generic/partial adjustments
        // intentionally remain unclassified and force ledger reconciliation.
        const paidDebtOperationKey = isEnterprisePaidDebt && idempotencyKey
          ? `${ADMIN_ADJUST_ENTERPRISE_PAID_DEBT_OPERATION_PREFIX}${idempotencyKey}`
          : null;
        const tx = await db.balanceTransaction.create({
          data: {
            ...(paidDebtOperationKey ? { operationKey: paidDebtOperationKey } : {}),
            userId,
            tenantId: tenantSubject.tenantId,
            billingAccountId: tenantSubject.billingAccountId,
            type: PrismaTransactionType.ADJUST,
            amountUsd,
            balanceAfterUsd: wallet.balanceUsd,
            description,
            ...(productId ? { productId } : {}),
            createdAt: financialNow,
          },
        });
        // 企业公对公转账场景：财务收款后由管理员在后台调增余额，等价于实付还款——
        // 填坑部分核销信用消费并确认收入（负向调整 fill=0，自动跳过）。
        let settledPaidDebtUsd = new Prisma.Decimal(0);
        if (
          paidFillUsd.gt(0)
          && (isEnterprisePaidDebt
            || await this.isEnterpriseBillingAccount(db, tenantSubject.billingAccountId))
        ) {
          settledPaidDebtUsd = await this.settleBalanceDebtOnFunding(db, {
            billingAccountId: tenantSubject.billingAccountId,
            allocationSource: BALANCE_ALLOCATION_SOURCE_ENTERPRISE_CREDIT,
            repaymentTransactionId: tx.id,
            paidFillUsd,
            bonusFillUsd: new Prisma.Decimal(0),
            financialNow,
            occurredAt: tx.createdAt,
          });
        }
        await this.assertReconciledBalanceLedger(
          db,
          tenantSubject.billingAccountId,
          financialNow,
          'admin adjustment postcondition',
          false,
        );
        const isExactClassifiedPaidDebt = (
          paidDebtOperationKey !== null
          && settledPaidDebtUsd.eq(amountUsd)
        );
        if (!amountUsd.eq(0) && !isExactClassifiedPaidDebt) {
          await this.markBalanceGrantLedgerDirty(
            db,
            tenantSubject.billingAccountId,
            `unclassified balance adjustment:${tx.id}`,
          );
        }
        const response = this.toBalanceTransaction(tx);
        if (idempotencyKey) {
          await this.commitAdminFundingIdempotency(
            db,
            ADMIN_ADJUST_BALANCE_IDEMPOTENCY_SCOPE,
            idempotencyKey,
            idempotencyRequest,
            response,
          );
        }
        return response;
      },
      );
    } catch (err) {
      if (err instanceof BalanceLedgerReconciliationRequiredError) {
        await this.persistRejectedLedgerQuarantine(err);
        throw err;
      }
      if (!idempotencyKey || !hasPrismaErrorCode(err, 'P2002')) {
        throw err;
      }
      result = await this.replayAdminFundingIdempotency<BalanceTransaction>(
        ADMIN_ADJUST_BALANCE_IDEMPOTENCY_SCOPE,
        idempotencyKey,
        idempotencyRequest,
      );
      replayed = true;
    }
    if (replayed) {
      await this.refreshBalanceCachesAndForceKeyBalanceSync(userId, tenantSubject);
    } else {
      await this.refreshBalanceCachesAndSyncKeyBalancesOnFundingChange(
        userId,
        tenantSubject,
        beforeKeyBalanceFunding,
      );
    }

    return result;
  }

  async applyClassifiedBalanceAdjustment(
    userId: string,
    input: ClassifiedBalanceAdjustmentInput,
  ): Promise<ClassifiedBalanceAdjustmentResult> {
    if (!Number.isSafeInteger(input.amountCents) || input.amountCents === 0) {
      throw new BadRequestException('调额金额必须为非零整数分值');
    }
    if (Math.abs(input.amountCents) > MAX_CLASSIFIED_BALANCE_ADJUSTMENT_CENTS) {
      throw new BadRequestException('单次调额不能超过 25,000.00');
    }
    if (!BALANCE_ADJUSTMENT_REASON_CODES.includes(input.reasonCode)) {
      throw new BadRequestException('调额原因类型无效');
    }
    const description = input.description?.trim();
    if (!description) {
      throw new BadRequestException('调额说明不能为空');
    }
    const idempotencyKey = this.normalizeAdminFundingIdempotencyKey(input.idempotencyKey);
    if (!idempotencyKey) {
      throw new BadRequestException('idempotencyKey 必填');
    }
    const performedBy = input.performedBy?.trim() || null;
    const subject = await this.requireTenantSubject(userId, {
      tenantId: input.tenantId,
      billingAccountId: input.billingAccountId,
    });
    const isEnterpriseAdjustment = subject.billingAccountType === ENTERPRISE_ACCOUNT_TYPE;
    const productId = isEnterpriseAdjustment ? null : input.productId?.trim() || null;
    const attribution = isEnterpriseAdjustment
      ? {
        billingMode: ProductBillingMode.PAY_AS_YOU_GO,
        source: BalanceTransactionAttributionSource.ADMIN_BALANCE_ADJUSTMENT,
      }
      : undefined;
    const reasonText = `billing-adjustment:${input.reasonCode} ${description}`;

    if (input.amountCents > 0) {
      const issued = await this.issueVoucher(userId, input.amountCents, reasonText, {
        tenantId: subject.tenantId,
        billingAccountId: subject.billingAccountId,
        productId,
        performedBy,
        idempotencyKey,
        attribution,
      });
      return {
        direction: 'CREDIT',
        reasonCode: input.reasonCode,
        amountCents: input.amountCents,
        balanceAfterCents: issued.transaction.balanceAfterCents,
        transaction: issued.transaction,
      };
    }

    const amountUsd = centsToUsd(Math.abs(input.amountCents));
    const transactionDescription = [
      `billing-adjustment:${input.reasonCode}`,
      performedBy ? `admin:${performedBy}` : null,
      description,
    ].filter(Boolean).join(' ');
    const idempotencyRequest: AdminFundingRequestFingerprint = {
      scope: ADMIN_BILLING_DEBIT_IDEMPOTENCY_SCOPE,
      userId,
      tenantId: subject.tenantId,
      billingAccountId: subject.billingAccountId,
      amountUsd: usdString(amountUsd.neg()),
      productId,
      description: transactionDescription,
      reason: input.reasonCode,
      expiresAt: null,
      performedBy,
    };
    const existing = await this.prisma.idempotencyKey.findUnique({
      where: this.adminFundingIdempotencyWhere(
        ADMIN_BILLING_DEBIT_IDEMPOTENCY_SCOPE,
        idempotencyKey,
      ),
      select: { key: true },
    });
    if (existing) {
      const replay = await this.replayAdminFundingIdempotency<ClassifiedBalanceAdjustmentResult>(
        ADMIN_BILLING_DEBIT_IDEMPOTENCY_SCOPE,
        idempotencyKey,
        idempotencyRequest,
      );
      await this.refreshBalanceCachesAndForceKeyBalanceSync(userId, subject);
      return replay;
    }

    let committedResult: ClassifiedBalanceAdjustmentResult | null = null;
    try {
      const deducted = await this.deduct(userId, amountUsd, transactionDescription, {
        tenantId: subject.tenantId,
        productId,
        operationKey: `${ADMIN_BILLING_DEBIT_OPERATION_PREFIX}${idempotencyKey}`,
        allowWalletOverdraft: Boolean(input.allowWalletOverdraft),
        beforeBalanceTransaction: async (db) => {
          await this.writePendingAdminFundingIdempotency(
            db,
            ADMIN_BILLING_DEBIT_IDEMPOTENCY_SCOPE,
            idempotencyKey,
            idempotencyRequest,
          );
        },
        afterBalanceTransaction: async (db, _snapshot, context) => {
          if (!context.balanceTransactionId) {
            throw new Error('ADMIN_BALANCE_DEBIT_TRANSACTION_MISSING');
          }
          const transaction = await db.balanceTransaction.findUniqueOrThrow({
            where: { id: context.balanceTransactionId },
          });
          committedResult = {
            direction: 'DEBIT',
            reasonCode: input.reasonCode,
            amountCents: input.amountCents,
            balanceAfterCents: usdToCents(transaction.balanceAfterUsd),
            transaction: this.toBalanceTransaction(transaction),
          };
          if (attribution) {
            await db.balanceTransactionAttribution.create({
              data: {
                transactionId: transaction.id,
                balanceGrantId: null,
                billingMode: attribution.billingMode,
                source: attribution.source,
              },
            });
          }
          await this.commitAdminFundingIdempotency(
            db,
            ADMIN_BILLING_DEBIT_IDEMPOTENCY_SCOPE,
            idempotencyKey,
            idempotencyRequest,
            committedResult,
          );
        },
      });
      if (!deducted.success) {
        throw new BadRequestException('可用余额或企业信用额度不足，无法执行扣减调额');
      }
    } catch (err) {
      if (!hasPrismaErrorCode(err, 'P2002')) throw err;
      const replay = await this.replayAdminFundingIdempotency<ClassifiedBalanceAdjustmentResult>(
        ADMIN_BILLING_DEBIT_IDEMPOTENCY_SCOPE,
        idempotencyKey,
        idempotencyRequest,
      );
      await this.refreshBalanceCachesAndForceKeyBalanceSync(userId, subject);
      return replay;
    }

    if (committedResult) return committedResult;
    return this.replayAdminFundingIdempotency<ClassifiedBalanceAdjustmentResult>(
      ADMIN_BILLING_DEBIT_IDEMPOTENCY_SCOPE,
      idempotencyKey,
      idempotencyRequest,
    );
  }

  async issueVoucher(
    userId: string,
    amountCents: number,
    reason: string,
    options: IssueVoucherOptions = {},
  ): Promise<VoucherIssueResult> {
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      throw new BadRequestException('代金券金额必须为正整数分值');
    }
    const reasonText = reason?.trim();
    if (!reasonText) {
      throw new BadRequestException('代金券发放原因不能为空');
    }
    if (options.expiresAt && Number.isNaN(options.expiresAt.getTime())) {
      throw new BadRequestException('代金券过期时间无效');
    }
    const amountUsd = centsToUsd(amountCents);
    const performedByText = options.performedBy?.trim() || null;
    const tenantSubject = await this.requireTenantSubject(userId, options);
    const beforeKeyBalanceFunding = await this.captureKeyBalanceFundingState(userId, tenantSubject);
    const idempotencyKey = this.normalizeAdminFundingIdempotencyKey(options.idempotencyKey);
    const idempotencyRequest: AdminFundingRequestFingerprint = {
      scope: ADMIN_ISSUE_VOUCHER_IDEMPOTENCY_SCOPE,
      userId,
      tenantId: tenantSubject.tenantId,
      billingAccountId: tenantSubject.billingAccountId,
      amountUsd: usdString(amountUsd),
      productId: options.productId ?? null,
      description: reasonText,
      reason: reasonText,
      expiresAt: options.expiresAt?.toISOString() ?? null,
      performedBy: performedByText,
    };
    let result: VoucherIssueResult;
    let replayed = false;
    try {
      result = await this.runBalanceLedgerTransaction(
        'issueVoucher',
        `user=${userId} idem=${idempotencyKey ?? "none"}`,
        async (db) => {
        if (idempotencyKey) {
          await this.writePendingAdminFundingIdempotency(
            db,
            ADMIN_ISSUE_VOUCHER_IDEMPOTENCY_SCOPE,
            idempotencyKey,
            idempotencyRequest,
          );
        }
        const financialNow = await this.lockWalletLedgerAndCaptureFinancialNow(
          db,
          userId,
          tenantSubject,
          `issue-voucher:${idempotencyKey ?? userId}`,
        );
        await this.lockProvisionedBillingSubjectMetadata(db, userId, tenantSubject);
        // Keep this after the idempotency claim: a replay of a legitimately
        // issued voucher must still return its committed response after the
        // voucher's expiry time has passed. A fresh expired request rolls the
        // PENDING claim back with the rest of this transaction. The same PG
        // financial clock governs both authorization and persisted facts.
        if (options.expiresAt && options.expiresAt.getTime() <= financialNow.getTime()) {
          throw new BadRequestException('代金券过期时间必须晚于当前时间');
        }
        await this.expireAccountBalanceGrants(db, tenantSubject, financialNow);
        await this.assertReconciledBalanceLedger(
          db,
          tenantSubject.billingAccountId,
          financialNow,
          'voucher precondition',
        );
        const wallet = await this.incrementAccountWallet(db, userId, tenantSubject, amountUsd);
        // 代金券用于填补任何余额欠款时都不确认收入，并且不能再次形成可用批次。
        const voucherFillUsd = this.walletHoleFillUsd(wallet.balanceUsd, amountUsd);
        const debtSource = await this.debtAllocationSourceForAccount(
          db,
          tenantSubject.billingAccountId,
          voucherFillUsd,
        );
        const remainingBonusAmountUsd = this.maxUsd(new Prisma.Decimal(0), amountUsd.minus(voucherFillUsd));
        const grant = await db.balanceGrant.create({
          data: {
            userId,
            tenantId: tenantSubject.tenantId,
            billingAccountId: tenantSubject.billingAccountId,
            ...(options.productId ? { productId: options.productId } : {}),
            source: BALANCE_GRANT_SOURCE_VOUCHER,
            paidAmountUsd: new Prisma.Decimal(0),
            bonusAmountUsd: amountUsd,
            grantedAmountUsd: amountUsd,
            remainingAmountUsd: remainingBonusAmountUsd,
            remainingPaidAmountUsd: new Prisma.Decimal(0),
            remainingBonusAmountUsd,
            discountRate: new Prisma.Decimal(0),
            validFrom: financialNow,
            expiresAt: options.expiresAt ?? null,
            createdAt: financialNow,
          },
        });
        const description = [
          `voucher:${grant.id}`,
          performedByText ? `admin:${performedByText}` : null,
          reasonText,
        ].filter(Boolean).join(' ');
        const transaction = await db.balanceTransaction.create({
          data: {
            userId,
            tenantId: tenantSubject.tenantId,
            billingAccountId: tenantSubject.billingAccountId,
            type: PrismaTransactionType.ADJUST,
            amountUsd,
            balanceAfterUsd: wallet.balanceUsd,
            description,
            ...(options.productId ? { productId: options.productId } : {}),
            createdAt: financialNow,
          },
        });
        if (options.attribution) {
          await db.balanceTransactionAttribution.create({
            data: {
              transactionId: transaction.id,
              balanceGrantId: grant.id,
              billingMode: options.attribution.billingMode,
              source: options.attribution.source,
            },
          });
        }
        if (debtSource && voucherFillUsd.gt(0)) {
          await this.settleBalanceDebtOnFunding(db, {
            billingAccountId: tenantSubject.billingAccountId,
            allocationSource: debtSource,
            repaymentTransactionId: transaction.id,
            balanceGrantId: grant.id,
            paidFillUsd: new Prisma.Decimal(0),
            bonusFillUsd: voucherFillUsd,
            financialNow,
            occurredAt: transaction.createdAt,
          });
        }
        await this.assertReconciledBalanceLedger(
          db,
          tenantSubject.billingAccountId,
          financialNow,
          'voucher postcondition',
          false,
        );
        const response: VoucherIssueResult = {
          transaction: this.toBalanceTransaction(transaction),
          grant: {
            id: grant.id,
            source: grant.source,
            amountCents: usdToCents(grant.grantedAmountUsd),
            remainingCents: usdToCents(grant.remainingAmountUsd),
            paidAmountCents: usdToCents(grant.paidAmountUsd),
            bonusAmountCents: usdToCents(grant.bonusAmountUsd),
            discountRate: usdNumber(grant.discountRate),
            productId: grant.productId ?? null,
            expiresAt: grant.expiresAt ? grant.expiresAt.toISOString() : null,
          },
        };
        if (idempotencyKey) {
          await this.commitAdminFundingIdempotency(
            db,
            ADMIN_ISSUE_VOUCHER_IDEMPOTENCY_SCOPE,
            idempotencyKey,
            idempotencyRequest,
            response,
          );
        }
        return response;
      },
      );
    } catch (err) {
      if (err instanceof BalanceLedgerReconciliationRequiredError) {
        await this.persistRejectedLedgerQuarantine(err);
        throw err;
      }
      if (!idempotencyKey || !hasPrismaErrorCode(err, 'P2002')) {
        throw err;
      }
      result = await this.replayAdminFundingIdempotency<VoucherIssueResult>(
        ADMIN_ISSUE_VOUCHER_IDEMPOTENCY_SCOPE,
        idempotencyKey,
        idempotencyRequest,
      );
      replayed = true;
    }

    if (replayed) {
      await this.refreshBalanceCachesAndForceKeyBalanceSync(userId, tenantSubject);
    } else {
      await this.refreshBalanceCachesAndSyncKeyBalancesOnFundingChange(
        userId,
        tenantSubject,
        beforeKeyBalanceFunding,
      );
    }

    return result;
  }

  /**
   * PR0-4: 充值赠送（recharge bonus）。
   *
   * 写入语义：BalanceTransaction.type 用 ADJUST（现有 enum 没有 RECHARGE_BONUS），
   * description 编码 `recharge-bonus tier:{tierId}` 用于追溯，orderId 链回原始充值订单。
   *
   * 与 recharge() 同样写入高精度 USD 钱包与流水。
   * 立即调用本方法补 bonus，两条 BalanceTransaction 在用户视角是连续的。
   *
   * operationKey 由数据库唯一约束兜底。唯一冲突会回滚同事务内的钱包、批次与
   * settlement 写入，再读取首个成功结果，因此并发重试不会重复赠送。
   */
  async creditBonus(
    userId: string,
    bonusCents: number,
    description: string,
    orderId?: string,
    opts?: { idempotencyKey?: string; productId?: string | null; tenantId?: string | null },
  ): Promise<BalanceTransaction> {
    if (!Number.isSafeInteger(bonusCents) || bonusCents <= 0) {
      throw new Error('bonusCents must be positive');
    }
    // Only an order-linked bonus is appended to a RECHARGE grant and therefore
    // participates in the immutable recharge funding fingerprint.  A no-order
    // operational ADJUST has no grant to classify and may retain its audited
    // operator-facing description.
    if (orderId && !/^recharge-bonus(?: tier:[^\s]+)?$/.test(description)) {
      throw new BadRequestException('充值赠送描述格式无效');
    }
    const amountUsd = centsToUsd(bonusCents);
    const suppliedIdempotencyKey = opts?.idempotencyKey?.trim();
    const operationKey = suppliedIdempotencyKey
      ? `balance:bonus:${userId}:${suppliedIdempotencyKey}`
      : orderId
        ? `balance:bonus:${userId}:${orderId}:${description}`
        : null;
    const subject = await this.requireTenantSubject(userId, { tenantId: opts?.tenantId });
    const validateReplay = async (transaction: PrismaBalanceTransaction): Promise<void> => {
      if (!usd(transaction.amountUsd).eq(amountUsd)) {
        throw new ConflictException('BALANCE_BONUS_IDEMPOTENCY_AMOUNT_MISMATCH');
      }
      if (!this.balanceTransactionMatchesReplayFingerprint(transaction, {
        userId,
        subject,
        type: PrismaTransactionType.ADJUST,
        amountUsd,
        description,
        orderId,
        productId: opts?.productId,
        operationKey,
      })) {
        throw new ConflictException('BALANCE_BONUS_IDEMPOTENCY_FINGERPRINT_MISMATCH');
      }
      if (!orderId) return;
      const grant = await this.prisma.balanceGrant.findUnique({ where: { orderId } });
      if (
        !grant
        || !this.balanceGrantMatchesFundingSubject(grant, {
          userId,
          subject,
          orderId,
          productId: opts?.productId,
        })
        // The recharge grant accumulates every later bonus.  This replay's
        // immutable ADJUST transaction proves the exact amount; the mutable
        // grant only needs to include it and retain its accounting invariant.
        || usd(grant.bonusAmountUsd).lt(amountUsd)
        || !usd(grant.paidAmountUsd).plus(grant.bonusAmountUsd).eq(grant.grantedAmountUsd)
      ) {
        throw new ConflictException('BALANCE_BONUS_IDEMPOTENCY_FINGERPRINT_MISMATCH');
      }
    };
    const convergeReplayProjection = async (): Promise<void> => {
      await this.refreshBalanceCachesAndForceKeyBalanceSync(userId, subject);
    };

    if (operationKey || orderId) {
      const existing = await this.prisma.balanceTransaction.findFirst({
        where: {
          OR: [
            ...(operationKey ? [{ operationKey }] : []),
            ...(orderId ? [{ orderId, type: PrismaTransactionType.ADJUST, description }] : []),
          ],
        },
      });
      if (existing) {
        await validateReplay(existing);
        await convergeReplayProjection();
        return this.toBalanceTransaction(existing);
      }
    }

    const beforeKeyBalanceFunding = await this.captureKeyBalanceFundingState(userId, subject);
    let tx: PrismaBalanceTransaction;
    try {
      tx = await this.runBalanceLedgerTransaction(
        'creditBonus',
        `user=${userId} order=${orderId ?? 'none'} idem=${opts?.idempotencyKey ?? 'none'}`,
        async (db) => {
        const financialNow = await this.lockWalletLedgerAndCaptureFinancialNow(
          db,
          userId,
          subject,
          `credit-bonus:${operationKey ?? orderId ?? userId}`,
        );
        await this.lockProvisionedBillingSubjectMetadata(db, userId, subject);
        await this.expireAccountBalanceGrants(db, subject, financialNow);
        await this.assertReconciledBalanceLedger(
          db,
          subject.billingAccountId,
          financialNow,
          'bonus precondition',
        );
        if (!orderId) {
          const ledgerContext = await this.reconciledBalanceLedgerContext(
            db,
            subject.billingAccountId,
          );
          if (ledgerContext.reconciled) {
            throw new BadRequestException('BALANCE_BONUS_REQUIRES_CLASSIFIED_FUNDING_LINK');
          }
        }
        const wallet = await this.incrementAccountWallet(db, userId, subject, amountUsd);
        const bonusTx = await db.balanceTransaction.create({
          data: {
            operationKey,
            userId,
            tenantId: subject.tenantId,
            billingAccountId: subject.billingAccountId,
            type: PrismaTransactionType.ADJUST,
            amountUsd,
            balanceAfterUsd: wallet.balanceUsd,
            description,
            orderId,
            ...(opts?.productId ? { productId: opts.productId } : {}),
            createdAt: financialNow,
          },
        });
        const bonusFillUsd = this.walletHoleFillUsd(wallet.balanceUsd, amountUsd);
        const debtSource = await this.debtAllocationSourceForAccount(
          db,
          subject.billingAccountId,
          bonusFillUsd,
        );
        const balanceGrantId = await this.addBonusToRechargeBalanceGrant(db, {
          orderId,
          userId,
          subject,
          productId: opts?.productId,
          bonusAmountUsd: amountUsd,
          financialNow,
          consumableAmountUsd: amountUsd.minus(bonusFillUsd),
        });
        if (debtSource && bonusFillUsd.gt(0)) {
          await this.settleBalanceDebtOnFunding(db, {
            billingAccountId: subject.billingAccountId,
            allocationSource: debtSource,
            repaymentTransactionId: bonusTx.id,
            balanceGrantId,
            paidFillUsd: new Prisma.Decimal(0),
            bonusFillUsd,
            financialNow,
            occurredAt: bonusTx.createdAt,
          });
        }
        await this.assertReconciledBalanceLedger(
          db,
          subject.billingAccountId,
          financialNow,
          'bonus postcondition',
          false,
        );
        if (!balanceGrantId && amountUsd.minus(bonusFillUsd).gt(0)) {
          await this.markBalanceGrantLedgerDirty(
            db,
            subject.billingAccountId,
            `bonus funding has no matching recharge grant:${bonusTx.id}`,
          );
        }
        return bonusTx;
      },
      );
    } catch (error) {
      if (error instanceof BalanceLedgerReconciliationRequiredError) {
        await this.persistRejectedLedgerQuarantine(error);
        throw error;
      }
      if (!operationKey || !hasPrismaErrorCode(error, 'P2002')) throw error;
      const existing = await this.prisma.balanceTransaction.findFirst({
        where: { operationKey },
      });
      if (!existing) throw error;
      await validateReplay(existing);
      await convergeReplayProjection();
      return this.toBalanceTransaction(existing);
    }
    await this.refreshBalanceCachesAndSyncKeyBalancesOnFundingChange(
      userId,
      subject,
      beforeKeyBalanceFunding,
    );

    return this.toBalanceTransaction(tx);
  }

  async refundBalance(
    userId: string,
    amountCents: number,
    description: string,
    orderId: string,
    productId?: string | null,
    subject: BillingSubjectOptions = {},
  ): Promise<BalanceTransaction> {
    if (!Number.isSafeInteger(amountCents) || amountCents <= 0) {
      throw new Error('amountCents must be positive');
    }
    const amountUsd = centsToUsd(amountCents).neg();
    const refundAmountUsd = amountUsd.abs();
    const refundComponent: BalanceGrantRefundComponent = subject.refundComponent ?? 'UNKNOWN';
    if (refundComponent === 'UNKNOWN') {
      throw new Error('BALANCE_REFUND_COMPONENT_REQUIRED');
    }
    const suppliedIdempotencyKey = subject.idempotencyKey?.trim();
    const operationKey = suppliedIdempotencyKey
      ? `balance:refund:${userId}:${suppliedIdempotencyKey}`
      : `balance:refund:${userId}:${orderId}:${description}`;
    const tenantSubject = await this.requireRechargeRefundSubject(
      userId,
      orderId,
      productId,
      subject,
    );
    const validateReplay = async (
      db: Prisma.TransactionClient | PrismaService,
      expectedSubject: BillingAccountSubjectRef,
      transaction: PrismaBalanceTransaction,
    ): Promise<void> => {
      if (!usd(transaction.amountUsd).eq(amountUsd)) {
        throw new ConflictException('BALANCE_REFUND_IDEMPOTENCY_AMOUNT_MISMATCH');
      }
      if (!this.balanceTransactionMatchesReplayFingerprint(transaction, {
        userId,
        subject: expectedSubject,
        type: PrismaTransactionType.REFUND,
        amountUsd,
        description,
        orderId,
        productId,
        operationKey,
      })) {
        throw new ConflictException('BALANCE_REFUND_IDEMPOTENCY_FINGERPRINT_MISMATCH');
      }
      const audit = await db.balanceGrantRefund.findUnique({
        where: { refundTransactionId: transaction.id },
      });
      // 兼容迁移前已经完成、尚无新 audit 的退款；新退款必须同时校验金额和
      // component，避免 principal/bonus 复用同一个幂等键。
      if (
        audit
        && (
          audit.component !== refundComponent
          || !usd(audit.requestedAmountUsd).eq(refundAmountUsd)
          || audit.operationKey !== operationKey
          // An audit row identifies a post-migration refund, so the immutable
          // transaction key must also be exact.  Only audit-less legacy rows
          // may use the semantic NULL-operation-key fallback.
          || transaction.operationKey !== operationKey
          || audit.refundTransactionId !== transaction.id
          || audit.billingAccountId !== expectedSubject.billingAccountId
        )
      ) {
        throw new ConflictException('BALANCE_REFUND_IDEMPOTENCY_FINGERPRINT_MISMATCH');
      }
      const grant = audit
        ? await db.balanceGrant.findUnique({ where: { id: audit.balanceGrantId } })
        : await db.balanceGrant.findUnique({ where: { orderId } });
      const legacyComponentGrossUsd = grant
        ? usd(refundComponent === 'PAID' ? grant.paidAmountUsd : grant.bonusAmountUsd)
        : new Prisma.Decimal(0);
      if (
        !grant
        || !this.balanceGrantMatchesFundingSubject(grant, {
          userId,
          subject: expectedSubject,
          orderId,
          productId,
        })
        || (!audit && legacyComponentGrossUsd.lt(refundAmountUsd))
      ) {
        throw new ConflictException('BALANCE_REFUND_IDEMPOTENCY_FINGERPRINT_MISMATCH');
      }
    };
    const convergeReplayProjection = async (): Promise<void> => {
      await this.refreshAnchoredBalanceProjection(userId, tenantSubject);
    };

    const existing = await this.prisma.balanceTransaction.findFirst({
      where: {
        OR: [
          { operationKey },
          { orderId, type: PrismaTransactionType.REFUND, description },
        ],
      },
    });
    if (existing) {
      await validateReplay(this.prisma, tenantSubject, existing);
      await convergeReplayProjection();
      return this.toBalanceTransaction(existing);
    }

    let refundTransaction: PrismaBalanceTransaction;
    try {
      refundTransaction = await this.runBalanceLedgerTransaction(
        'refundBalance',
        `order=${orderId} user=${userId}`,
        async (db) => {
        // Use the same leading order-row lock as recharge fulfillment. This
        // closes the race where a refund could claim an order before its wallet
        // effects were visible and then skip required balance compensation.
        await db.$queryRaw`
          SELECT "id" FROM "orders" WHERE "id" = ${orderId} FOR UPDATE
        `;
        const lockedSubject = await this.requireRechargeRefundSubject(
          userId,
          orderId,
          productId,
          subject,
          db,
        );
        const lockedExisting = await db.balanceTransaction.findFirst({
          where: {
            OR: [
              { operationKey },
              { orderId, type: PrismaTransactionType.REFUND, description },
            ],
          },
        });
        if (lockedExisting) {
          await validateReplay(db, lockedSubject, lockedExisting);
          return lockedExisting;
        }

        // Refund and on-demand expiry share one wallet/grant ledger. Lock the
        // wallet first, expire every due batch under that lock, and only then
        // apply the refund debit. Otherwise a due-but-not-yet-swept batch can
        // be used to net refund debt and make the outcome worker-order
        // dependent.
        const financialNow = await this.lockProvisionedWalletLedgerAndCaptureFinancialNow(
          db,
          lockedSubject,
          `balance-refund:${operationKey}`,
        );
        await this.expireAccountBalanceGrants(db, lockedSubject, financialNow);
        await this.assertReconciledBalanceLedger(
          db,
          lockedSubject.billingAccountId,
          financialNow,
          'refund precondition',
        );
        await this.assertGatewayReservedCashNotSpent(
          db,
          lockedSubject.billingAccountId,
        );
        const wallet = await this.incrementAccountWallet(db, userId, lockedSubject, amountUsd);
        const refundTx = await db.balanceTransaction.create({
          data: {
            operationKey,
            userId,
            tenantId: lockedSubject.tenantId,
            billingAccountId: lockedSubject.billingAccountId,
            type: PrismaTransactionType.REFUND,
            amountUsd,
            balanceAfterUsd: wallet.balanceUsd,
            description,
            orderId,
            ...(productId ? { productId } : {}),
            createdAt: financialNow,
          },
        });
        await this.applyBalanceGrantRefund(db, {
          orderId,
          refundAmountUsd,
          component: refundComponent,
          operationKey,
          refundTransaction: refundTx,
          walletBalanceBeforeUsd: usd(wallet.balanceUsd).plus(refundAmountUsd),
          walletBalanceAfterUsd: usd(wallet.balanceUsd),
          effectiveAt: financialNow,
        });
        await this.assertReconciledBalanceLedger(
          db,
          lockedSubject.billingAccountId,
          financialNow,
          'refund postcondition',
          false,
        );
        return refundTx;
      },
      );
    } catch (error) {
      if (error instanceof BalanceLedgerReconciliationRequiredError) {
        await this.persistRejectedLedgerQuarantine(error);
        throw error;
      }
      if (!hasPrismaErrorCode(error, 'P2002')) throw error;
      const replay = await this.prisma.balanceTransaction.findFirst({ where: { operationKey } });
      if (!replay) throw error;
      await validateReplay(this.prisma, tenantSubject, replay);
      await convergeReplayProjection();
      return this.toBalanceTransaction(replay);
    }
    await convergeReplayProjection();
    return this.toBalanceTransaction(refundTransaction);
  }

  private async requireRechargeRefundSubject(
    userId: string,
    orderId: string,
    productId: string | null | undefined,
    subject: BillingSubjectOptions,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<BillingAccountSubjectRef> {
    const tenantId = subject.tenantId?.trim();
    const billingAccountId = subject.billingAccountId?.trim();
    if (!tenantId || !billingAccountId) {
      throw new BadRequestException('充值退款必须明确指定原 tenantId 和 billingAccountId');
    }

    const [order, originalRecharge] = await Promise.all([
      db.order.findUnique({
        where: { id: orderId },
        select: {
          userId: true,
          tenantId: true,
          billingAccountId: true,
          productId: true,
          orderType: true,
        },
      }),
      db.balanceTransaction.findFirst({
        where: { orderId, type: PrismaTransactionType.RECHARGE },
        orderBy: { createdAt: 'asc' },
      }),
    ]);
    const anchoredSubject = { tenantId, billingAccountId };
    if (
      !order
      || order.orderType !== 'RECHARGE'
      || order.userId !== userId
      || order.tenantId !== tenantId
      || order.billingAccountId !== billingAccountId
      || order.productId !== (productId ?? null)
      || !originalRecharge
      || originalRecharge.userId !== userId
      || originalRecharge.tenantId !== tenantId
      || originalRecharge.billingAccountId !== billingAccountId
      || (originalRecharge.productId ?? null) !== (productId ?? null)
    ) {
      throw new ConflictException(`充值订单 ${orderId} 的退款主体锚点不一致`);
    }
    return anchoredSubject;
  }

  private async refreshAnchoredBalanceProjection(
    userId: string,
    subject: BillingAccountSubjectRef,
  ): Promise<void> {
    try {
      await this.projectAnchoredBalanceCaches(userId, subject);
    } catch (err) {
      this.logger.warn(
        `anchored balance projection refresh failed user=${userId} account=${subject.billingAccountId}: ${(err as Error).message}`,
      );
    } finally {
      this.scheduleKeyBalanceSync(userId, subject.tenantId, subject.billingAccountId);
    }
  }

  // ============================
  // 额度汇总
  // ============================

  private async enterpriseFundingOutstanding(
    billingAccountId: string,
  ): Promise<EnterpriseFundingOutstanding> {
    const rows = await this.prisma.$queryRaw<Array<{
      approved_receivable_usd: Prisma.Decimal;
      unapproved_debt_usd: Prisma.Decimal;
      incomplete_open_count: bigint;
    }>>`
      SELECT
        COALESCE(SUM(
          CASE
            WHEN "funding_classification_complete" AND "approved_credit_usd" > 0
              THEN "approved_credit_usd" - "settled_usd"
            ELSE 0
          END
        ), 0) AS "approved_receivable_usd",
        COALESCE(SUM(
          CASE
            WHEN "funding_classification_complete" AND "unapproved_debt_usd" > 0
              THEN "unapproved_debt_usd" - "settled_usd"
            ELSE 0
          END
        ), 0) AS "unapproved_debt_usd",
        COUNT(*) FILTER (
          WHERE NOT "funding_classification_complete" AND "settled_at" IS NULL
        ) AS "incomplete_open_count"
      FROM "balance_consumption_allocations"
      WHERE "billing_account_id" = ${billingAccountId}
        AND "source" = ${BALANCE_ALLOCATION_SOURCE_ENTERPRISE_CREDIT}
    `;
    const row = rows[0];
    return {
      approvedReceivableUsd: usd(row?.approved_receivable_usd ?? 0),
      unapprovedDebtUsd: usd(row?.unapproved_debt_usd ?? 0),
      classificationComplete: (row?.incomplete_open_count ?? BigInt(0)) === BigInt(0),
    };
  }

  async getCreditsSummary(
    userId: string,
    subject: BillingSubjectOptions = {},
  ): Promise<CreditsSummary> {
    const tenantSubject = await this.requireTenantSubject(userId, subject);
    const snapshot = await this.getWorkspaceBalanceSnapshot(userId, tenantSubject);

    const startOfMonth = new Date();
    startOfMonth.setDate(1);
    startOfMonth.setHours(0, 0, 0, 0);

    const repositorySubject = this.billingSubjectRef(tenantSubject);
    const [
      usedResult,
      grantedResult,
      grantTotalsResult,
      pendingFundingReservation,
      openDebtUsage,
      activeRestriction,
      enterpriseFunding,
    ] = await Promise.all([
      this.billingRepository.aggregateUsedThisMonth(userId, startOfMonth, repositorySubject),
      this.billingRepository.aggregateTotalGranted(userId, repositorySubject),
      this.billingRepository.aggregateBalanceGrantTotals(userId, repositorySubject),
      this.prisma.gatewayUsageFundingReservation.aggregate({
        where: {
          billingAccountId: tenantSubject.billingAccountId,
          status: { in: ['ACTIVE', 'MANUAL_REVIEW'] },
        },
        _count: { _all: true },
        _sum: { reservedAmountUsd: true },
      }),
      this.prisma.gatewayBillingEvent.aggregate({
        where: {
          billingAccountId: tenantSubject.billingAccountId,
          status: 'DEBT_OPEN',
          fundingOutcome: 'DEBT_OPEN',
          // BALANCE debt is already represented by the authoritative wallet
          // balance below. Only CREDITS debt needs a separate occurrence sum.
          billingUnit: 'CREDITS',
        },
        _sum: { pendingExposureUsd: true },
      }),
      this.prisma.billingAccessRestriction.findFirst({
        where: {
          billingAccountId: tenantSubject.billingAccountId,
          status: 'ACTIVE',
        },
        select: { reason: true },
      }),
      snapshot.billingAccountType === ENTERPRISE_ACCOUNT_TYPE
        ? this.enterpriseFundingOutstanding(tenantSubject.billingAccountId)
        : null,
    ]);

    const usedThisMonthUsd = usd(usedResult._sum.amountUsd ?? 0).abs();
    const totalGrantedUsd = usd(grantedResult._sum.amountUsd ?? 0);
    const totalRechargeUsd = usd(grantTotalsResult._sum.paidAmountUsd ?? 0);
    const totalBonusGrantedUsd = usd(grantTotalsResult._sum.bonusAmountUsd ?? 0);
    // This management summary reports durable wallet-backed reservations only.
    // Publisher additionally validates first-receipt provisional guards in one
    // database snapshot for request-time admission; duplicating that proof here
    // with independent reads would create a misleading handoff race. Provider
    // evidence OPEN cases remain internal audit state and are absent from both
    // customer funding projections.
    const pendingHoldUsd = usd(
      pendingFundingReservation._sum.reservedAmountUsd ?? 0,
    );
    const pendingExposureUsd = pendingHoldUsd;
    const pendingUsageCount = pendingFundingReservation._count._all;
    const ledgerDebtUsd = enterpriseFunding
      ? enterpriseFunding.unapprovedDebtUsd
      : this.maxUsd(usd(0), snapshot.accountAvailableBalanceUsd.neg());
    const openDebtUsd = usd(openDebtUsage._sum.pendingExposureUsd ?? 0).plus(ledgerDebtUsd);
    const availableAfterHoldUsd = this.maxUsd(
      usd(0),
      snapshot.accountAvailableBalanceUsd.minus(pendingHoldUsd),
    );
    // Keep the legacy workspace balance as an accounting projection: personal
    // accounts and enterprises without active credit must continue to expose
    // an actual negative balance. Admission still uses the non-negative
    // accountAvailableBalance fields above, while openDebt/creditPolicy makes
    // the fail-closed state explicit.
    const workspaceAfterHoldUsd = snapshot.workspaceBalanceUsd.minus(pendingHoldUsd);
    const debtRestricted = openDebtUsd.gt(0) || activeRestriction?.reason === 'debt_open';
    // Publisher has one narrow exception: a structurally valid
    // pending_usage_unreserved row is an exact provisional hold, not a hard
    // restriction. This management summary deliberately does not reproduce
    // that multi-table proof, so it reports any ACTIVE restriction as
    // RESTRICTED. The display status is conservative and is not used for
    // Gateway request admission.
    const accessRestricted = Boolean(activeRestriction);
    const accessStatus = accessRestricted ? 'RESTRICTED' : 'ACTIVE';
    const creditPolicy = debtRestricted
      ? { status: 'DEBT_OPEN', action: 'FAIL_CLOSED' }
      : accessRestricted
        ? { status: 'RESTRICTED', action: 'FAIL_CLOSED' }
        : { status: 'CLEAR', action: 'ALLOW' };
    const canViewFinancialDetails = this.hasBillingOwnerCapability(userId, tenantSubject);
    const reportedCreditUsedUsd = enterpriseFunding && canViewFinancialDetails
      ? this.maxUsd(snapshot.creditUsedUsd, enterpriseFunding.approvedReceivableUsd)
      : snapshot.creditUsedUsd;
    const reportedCreditRemainingUsd = this.maxUsd(
      usd(0),
      snapshot.creditLimitUsd.minus(reportedCreditUsedUsd),
    );
    return {
      subject: {
        tenantId: tenantSubject.tenantId,
        billingAccountId: tenantSubject.billingAccountId,
        accountType: tenantSubject.billingAccountType,
        accountName: tenantSubject.tenantType === ENTERPRISE_ACCOUNT_TYPE
          ? tenantSubject.billingAccountName
          : tenantSubject.tenantName,
        canRecharge: canViewFinancialDetails,
      },
      balanceCents: usdToCents(workspaceAfterHoldUsd),
      usedThisMonthCents: usdToCents(usedThisMonthUsd),
      totalGrantedCents: usdToCents(totalGrantedUsd),
      balanceUsd: usdNumber(workspaceAfterHoldUsd),
      balanceAmount: usdString(workspaceAfterHoldUsd),
      accountBalanceCents: usdToCents(snapshot.accountBalanceUsd),
      accountBalanceUsd: usdNumber(snapshot.accountBalanceUsd),
      accountBalanceAmount: usdString(snapshot.accountBalanceUsd),
      accountAvailableBalanceCents: usdToCents(availableAfterHoldUsd),
      accountAvailableBalanceUsd: usdNumber(availableAfterHoldUsd),
      accountAvailableBalanceAmount: usdString(availableAfterHoldUsd),
      billingAccountType: snapshot.billingAccountType,
      creditLimitCents: usdToCents(snapshot.creditLimitUsd),
      creditLimitUsd: usdNumber(snapshot.creditLimitUsd),
      creditLimitAmount: usdString(snapshot.creditLimitUsd),
      creditUsedCents: usdToCents(reportedCreditUsedUsd),
      creditUsedUsd: usdNumber(reportedCreditUsedUsd),
      creditUsedAmount: usdString(reportedCreditUsedUsd),
      creditRemainingCents: usdToCents(reportedCreditRemainingUsd),
      creditRemainingUsd: usdNumber(reportedCreditRemainingUsd),
      creditRemainingAmount: usdString(reportedCreditRemainingUsd),
      creditStatus: snapshot.creditStatus,
      creditTermsDays: snapshot.creditTermsDays,
      creditEffectiveAt: snapshot.creditEffectiveAt?.toISOString() ?? null,
      creditExpiresAt: snapshot.creditExpiresAt?.toISOString() ?? null,
      allowanceCents: snapshot.allowanceUsd === null ? null : usdToCents(snapshot.allowanceUsd),
      allowanceUsd: snapshot.allowanceUsd === null ? null : usdNumber(snapshot.allowanceUsd),
      allowanceUsedCents: usdToCents(snapshot.allowanceUsedUsd),
      allowanceUsedUsd: usdNumber(snapshot.allowanceUsedUsd),
      allowanceRemainingCents: snapshot.allowanceRemainingUsd === null
        ? null
        : usdToCents(snapshot.allowanceRemainingUsd),
      allowanceRemainingUsd: snapshot.allowanceRemainingUsd === null
        ? null
        : usdNumber(snapshot.allowanceRemainingUsd),
      ...(canViewFinancialDetails
        ? {
            ...(enterpriseFunding
              ? {
                  approvedReceivableOutstandingCents: usdToCents(
                    enterpriseFunding.approvedReceivableUsd,
                  ),
                  approvedReceivableOutstandingUsd: usdNumber(
                    enterpriseFunding.approvedReceivableUsd,
                  ),
                  approvedReceivableOutstandingAmount: usdString(
                    enterpriseFunding.approvedReceivableUsd,
                  ),
                  unapprovedDebtOutstandingCents: usdToCents(
                    enterpriseFunding.unapprovedDebtUsd,
                  ),
                  unapprovedDebtOutstandingUsd: usdNumber(
                    enterpriseFunding.unapprovedDebtUsd,
                  ),
                  unapprovedDebtOutstandingAmount: usdString(
                    enterpriseFunding.unapprovedDebtUsd,
                  ),
                  enterpriseFundingClassificationComplete:
                    enterpriseFunding.classificationComplete,
                }
              : {}),
            pendingUsageCount,
            pendingHoldCents: usdToCents(pendingHoldUsd),
            pendingHoldUsd: usdNumber(pendingHoldUsd),
            pendingHoldAmount: usdString(pendingHoldUsd),
            pendingExposureCents: usdToCents(pendingExposureUsd),
            pendingExposureUsd: usdNumber(pendingExposureUsd),
            pendingExposureAmount: usdString(pendingExposureUsd),
            openDebtCents: usdToCents(openDebtUsd),
            openDebtUsd: usdNumber(openDebtUsd),
            openDebtAmount: usdString(openDebtUsd),
          }
        : {}),
      accessStatus,
      creditPolicy,
      usedThisMonthUsd: usdNumber(usedThisMonthUsd),
      usedThisMonthAmount: usdString(usedThisMonthUsd),
      totalGrantedUsd: usdNumber(totalGrantedUsd),
      totalGrantedAmount: usdString(totalGrantedUsd),
      totalRechargeCents: usdToCents(totalRechargeUsd),
      totalRechargeUsd: usdNumber(totalRechargeUsd),
      totalRechargeAmount: usdString(totalRechargeUsd),
      totalBonusGrantedCents: usdToCents(totalBonusGrantedUsd),
      totalBonusGrantedUsd: usdNumber(totalBonusGrantedUsd),
      totalBonusGrantedAmount: usdString(totalBonusGrantedUsd),
    };
  }

  private toResolvedBillingSubject(subject: BillingSubjectOptions): ResolvedBillingSubject | null {
    return (subject as Partial<ResolvedBillingSubject>)[RESOLVED_BILLING_SUBJECT] === true
      ? subject as ResolvedBillingSubject
      : null;
  }

  private markResolvedBillingSubject(
    subject: Omit<ResolvedBillingSubject, typeof RESOLVED_BILLING_SUBJECT>,
  ): ResolvedBillingSubject {
    Object.defineProperty(subject, RESOLVED_BILLING_SUBJECT, {
      value: true,
      enumerable: false,
      configurable: false,
      writable: false,
    });
    return subject as ResolvedBillingSubject;
  }

  private billingSubjectRef(subject: BillingAccountSubjectRef): BillingAccountSubjectRef {
    return {
      tenantId: subject.tenantId,
      billingAccountId: subject.billingAccountId,
    };
  }

  // ============================
  // 流水查询
  // ============================

  async getTransactions(
    userId: string,
    page: number,
    pageSize: number,
    productId?: string,
    subject: BillingSubjectOptions = {},
  ): Promise<{
    items: BalanceTransaction[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const tenantSubject = await this.requireTenantSubject(userId, subject);
    const repositorySubject = this.billingSubjectRef(tenantSubject);
    const skip = (page - 1) * pageSize;
    const [items, total] = await Promise.all([
      productId
        ? this.billingRepository.findTransactions(userId, skip, pageSize, productId, repositorySubject)
        : this.billingRepository.findTransactions(userId, skip, pageSize, undefined, repositorySubject),
      productId
        ? this.billingRepository.countTransactions(userId, productId, repositorySubject)
        : this.billingRepository.countTransactions(userId, undefined, repositorySubject),
    ]);

    return {
      items: items.map((t: PrismaBalanceTransaction) => this.toBalanceTransaction(t)),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async getCreditDetails(
    userId: string,
    params: {
      creditPage: number;
      voucherPage: number;
      pageSize: number;
      productId?: string;
    },
    subject: BillingSubjectOptions = {},
  ): Promise<CreditDetailsResult> {
    const tenantSubject = await this.requireTenantSubject(userId, subject);
    const pageSize = Math.min(100, Math.max(1, Math.trunc(params.pageSize)));
    const creditPage = Math.max(1, Math.trunc(params.creditPage));
    const voucherPage = Math.max(1, Math.trunc(params.voucherPage));
    const ownerWhere: Prisma.BalanceGrantWhereInput = {
      OR: [
        { billingAccountId: tenantSubject.billingAccountId },
        { tenantId: tenantSubject.tenantId, billingAccountId: null },
      ],
    };
    const productWhere: Prisma.BalanceGrantWhereInput = params.productId
      ? { productId: params.productId }
      : {};
    const creditWhere: Prisma.BalanceGrantWhereInput = {
      ...productWhere,
      AND: [ownerWhere],
      source: BALANCE_GRANT_SOURCE_RECHARGE,
      paidAmountUsd: { gt: new Prisma.Decimal(0) },
    };
    const voucherWhere: Prisma.BalanceGrantWhereInput = {
      ...productWhere,
      AND: [
        ownerWhere,
        {
          OR: [
            { source: BALANCE_GRANT_SOURCE_VOUCHER },
            { source: BALANCE_GRANT_SOURCE_RECHARGE, bonusAmountUsd: { gt: new Prisma.Decimal(0) } },
          ],
        },
      ],
    };

    const [creditGrants, creditTotal, voucherGrants, voucherTotal] = await Promise.all([
      this.prisma.balanceGrant.findMany({
        where: creditWhere,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (creditPage - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.balanceGrant.count({ where: creditWhere }),
      this.prisma.balanceGrant.findMany({
        where: voucherWhere,
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        skip: (voucherPage - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.balanceGrant.count({ where: voucherWhere }),
    ]);

    return {
      credits: {
        items: creditGrants.map((grant) => this.toCreditDetailItem(grant)),
        total: creditTotal,
        page: creditPage,
        pageSize,
        totalPages: Math.ceil(creditTotal / pageSize),
      },
      vouchers: {
        items: voucherGrants.map((grant) => this.toVoucherDetailItem(grant)),
        total: voucherTotal,
        page: voucherPage,
        pageSize,
        totalPages: Math.ceil(voucherTotal / pageSize),
      },
    };
  }

  // ============================
  // 订阅管理
  // ============================

  // @deprecated Use SubscriptionResolverService.resolve() instead
  async getUserPlanId(userId: string): Promise<string | null> {
    const cacheKey = `subscription:${userId}`;
    const cached = await this.redis.get(cacheKey);
    if (cached) return cached === 'none' ? null : cached;

    const period = await this.prisma.subscriptionPeriod.findFirst({
      where: {
        userId,
        status: 'ACTIVE',
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { planId: true },
      orderBy: [{ startedAt: 'desc' }, { createdAt: 'desc' }],
    });

    if (!period) {
      await this.redis.set(cacheKey, 'none', 'EX', 600);
      return null;
    }

    await this.redis.set(cacheKey, period.planId, 'EX', 600);
    return period.planId;
  }

  /**
   * 自营套餐滚动窗口用量概览（fix3 §1）：周=最大日级(≥1d，通常 7d) CREDITS 滚动规则、
   * 5h=最小亚日(<1d) CREDITS 滚动规则。预算取规则 limitValue（与 gate enforced 无关，展示用户配置额度）。
   */
  private async buildCodingPlanUsageWindows(
    subscriptionId: string,
    quotaRules: PlanQuotaRuleView[],
    monthlyCredits: number,
    cycleStart: Date | null,
    cycleEnd: Date | null,
  ): Promise<
    | {
        month?: { usedCredits: number; budgetCredits: number; resetInSec: number | null };
        week?: { usedCredits: number; budgetCredits: number; resetInSec: number | null };
        fiveHour?: { usedCredits: number; budgetCredits: number; resetInSec: number | null };
      }
    | undefined
  > {
    const windows: {
      month?: { usedCredits: number; budgetCredits: number; resetInSec: number | null };
      week?: { usedCredits: number; budgetCredits: number; resetInSec: number | null };
      fiveHour?: { usedCredits: number; budgetCredits: number; resetInSec: number | null };
    } = {};
    // 月度累计池（fix3：第 3 卡「月度用量」）。非滚动窗口——CONSUME 自本周期起累计、预算=plan.monthlyCredits、
    // reset=套餐到期。与 week/5h 削峰窗口区别开。monthlyCredits<=0 或无周期起则不展示。
    if (monthlyCredits > 0 && cycleStart) {
      windows.month = await this.computeCycleCreditWindow(subscriptionId, cycleStart, monthlyCredits, cycleEnd);
    }
    const creditRolling = quotaRules.filter(
      (r) => r.metric === 'CREDITS' && r.windowType === 'ROLLING' && r.durationSec > 0,
    );
    const weekRule =
      creditRolling.find((r) => r.durationSec === 604800) ??
      [...creditRolling]
        .filter((r) => r.durationSec >= 86400)
        .sort((a, b) => b.durationSec - a.durationSec)[0];
    const fiveHourRule = [...creditRolling]
      .filter((r) => r.durationSec < 86400)
      .sort((a, b) => a.durationSec - b.durationSec)[0];
    if (weekRule) {
      windows.week = await this.computeRollingCreditWindow(subscriptionId, weekRule.durationSec, weekRule.limitValue);
    }
    if (fiveHourRule) {
      windows.fiveHour = await this.computeRollingCreditWindow(
        subscriptionId,
        fiveHourRule.durationSec,
        fiveHourRule.limitValue,
      );
    }
    return Object.keys(windows).length > 0 ? windows : undefined;
  }

  /**
   * 单个 CREDITS 滚动窗口：usedCredits=区间内 CONSUME 消耗求和绝对值（与 creditService.windowUsage 同源）；
   * resetInSec=窗口内最早一笔 CONSUME 出窗倒计时（max(0,(earliest+D)-now)），无消耗则 null。
   */
  private async computeRollingCreditWindow(
    subscriptionId: string,
    durationSec: number,
    budgetCredits: number,
  ): Promise<{ usedCredits: number; budgetCredits: number; resetInSec: number | null }> {
    const nowMs = Date.now();
    const since = new Date(nowMs - durationSec * 1000);
    const where = { subscriptionId, type: 'CONSUME' as const, createdAt: { gte: since } };
    const [agg, earliest] = await Promise.all([
      this.prisma.creditTransaction.aggregate({ where, _sum: { creditsAmount: true } }),
      this.prisma.creditTransaction.findFirst({
        where,
        orderBy: { createdAt: 'asc' },
        select: { createdAt: true },
      }),
    ]);
    const usedCredits = Math.abs(agg._sum.creditsAmount ?? 0);
    const resetInSec = earliest
      ? Math.max(0, Math.round((earliest.createdAt.getTime() + durationSec * 1000 - nowMs) / 1000))
      : null;
    return { usedCredits, budgetCredits, resetInSec };
  }

  /**
   * 月度累计池窗口（非滚动）：usedCredits=本周期(since→now) CONSUME 累计绝对值；
   * budgetCredits=plan.monthlyCredits；resetInSec=至套餐到期(resetAt)倒计时，无到期则 null。
   * 注意：与 computeRollingCreditWindow 不同——这是「计费周期累计」而非「滚动窗口」。加油包/赠送/结转
   * 会使「累计消耗 / monthlyCredits」≠「当前可用余额」，故此窗口表达的是**月度消耗强度**，非余额池剩余。
   */
  private async computeCycleCreditWindow(
    subscriptionId: string,
    since: Date,
    budgetCredits: number,
    resetAt: Date | null,
  ): Promise<{ usedCredits: number; budgetCredits: number; resetInSec: number | null }> {
    const nowMs = Date.now();
    const agg = await this.prisma.creditTransaction.aggregate({
      where: { subscriptionId, type: 'CONSUME' as const, createdAt: { gte: since } },
      _sum: { creditsAmount: true },
    });
    const usedCredits = Math.abs(agg._sum.creditsAmount ?? 0);
    const resetInSec = resetAt ? Math.max(0, Math.round((resetAt.getTime() - nowMs) / 1000)) : null;
    return { usedCredits, budgetCredits, resetInSec };
  }

  /**
   * 判定产品是否「自营 CodingPlan(platform_model_package)」。
   * 自营是 per-user 概念（me/self-op-subscription-workspace-independent.md）：其订阅/额度显示不应受当前工作区/角色影响，
   * 故控制器据此对自营查看**绕开当前工作区成员/账务角色 gate**（转售/SUBSCRIPTION 维持）。
   */
  async isSelfOperatedCodingPlanProduct(productIdOrSlug?: string, defaultSlug?: string): Promise<boolean> {
    const product = await this.resolveActiveProduct(productIdOrSlug, defaultSlug);
    return (
      !!product &&
      product.billingMode === 'CODING_PLAN' &&
      product.codingPlanFulfillmentMode === CodingPlanFulfillmentMode.platform_model_package
    );
  }

  /**
   * 自营 CodingPlan 的当前活跃 entitlement——**按 userId 查、忽略当前工作区**（供 credits 只读展示用）。
   * 返回 {selfOp, entitlementId}；非自营产品 selfOp=false；自营未订阅 entitlementId=null。
   * where 必含 userId → 无越权；多活跃(异常数据)取最新一条兜底。
   */
  async resolveSelfOpEntitlementId(
    userId: string,
    productIdOrSlug?: string,
    defaultSlug?: string,
  ): Promise<{ selfOp: boolean; entitlementId: string | null }> {
    const product = await this.resolveActiveProduct(productIdOrSlug, defaultSlug);
    if (
      !product ||
      product.billingMode !== 'CODING_PLAN' ||
      product.codingPlanFulfillmentMode !== CodingPlanFulfillmentMode.platform_model_package
    ) {
      return { selfOp: false, entitlementId: null };
    }
    const entitlement = await this.prisma.codingPlanEntitlement.findFirst({
      where: {
        userId,
        productId: product.id,
        status: 'ACTIVE',
        fulfillmentMode: CodingPlanFulfillmentMode.platform_model_package,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      orderBy: [{ startedAt: 'desc' }, { createdAt: 'desc' }],
      select: { id: true },
    });
    return { selfOp: true, entitlementId: entitlement?.id ?? null };
  }

  async getCurrentSubscriptionBySlug(
    userId: string,
    productId: string | undefined,
    defaultSlug: string,
    subject: BillingSubjectOptions = {},
  ): Promise<{
    productId: string | null;
    billingMode: string | null;
    fulfillmentMode?: CodingPlanFulfillmentMode | null;
    planId: string | null;
    planName: string;
    billingPeriod: string | null;
    // 自营 CodingPlan 的 entitlement 单一事实源（codingplan-all §4.2）：
    // 前端据此过滤/创建专属 Key、拉取套餐 credits；其余套餐不返回。
    codingPlanEntitlementId?: string | null;
    monthlyPrice: number;
    monthlyCredits: number;
    rateLimitRpm: number;
    rateLimitTpm: number;
    maxContextWindow: number;
    quotaRules?: PlanQuotaRuleView[];
    // 自营 CodingPlan 用量概览（codingplan-all-fix3 §1，仅自营返回）：
    // month=月度累计池(CONSUME 自周期起累计 / budget=monthlyCredits / reset=到期，非滚动窗口)；
    // week=7d / fiveHour=5h CREDITS 滚动窗口的 已用/预算/重置倒计时(秒，最早一笔出窗，无消耗 null)。
    usageWindows?: {
      month?: { usedCredits: number; budgetCredits: number; resetInSec: number | null };
      week?: { usedCredits: number; budgetCredits: number; resetInSec: number | null };
      fiveHour?: { usedCredits: number; budgetCredits: number; resetInSec: number | null };
    };
    features: string[];
    status: string;
    expiresAt: string | null;
  }> {
    const emptyData = {
      productId: null as string | null,
      billingMode: null as string | null,
      fulfillmentMode: null as CodingPlanFulfillmentMode | null,
      planId: null as string | null,
      planName: '未订阅',
      billingPeriod: null as string | null,
      monthlyPrice: 0,
      monthlyCredits: 0,
      rateLimitRpm: 0,
      rateLimitTpm: 0,
      maxContextWindow: 0,
      features: [] as string[],
      status: 'none',
      expiresAt: null as string | null,
    };

    const product = await this.resolveActiveProduct(productId, defaultSlug);
    if (!product) {
      return emptyData;
    }

    // 自营 CodingPlan(platform_model_package)是 per-user：按 userId 查活跃自营 entitlement，
    // 忽略当前工作区（切工作区/无成员也能显示自己的订阅，me/self-op-subscription-workspace-independent.md）。
    // 转售 CodingPlan / SUBSCRIPTION 仍按当前工作区 tenant 解析（不变）。
    const isSelfOpProduct =
      product.billingMode === 'CODING_PLAN' &&
      product.codingPlanFulfillmentMode === CodingPlanFulfillmentMode.platform_model_package;
    const tenantId = isSelfOpProduct ? null : await this.resolveRequiredTenantId(userId, subject);
    if (product.billingMode === 'CODING_PLAN') {
      const entitlement = await this.prisma.codingPlanEntitlement.findFirst({
        where: isSelfOpProduct
          ? {
              // where 必含 userId → 无越权；多活跃(跨自有 tenant 的异常数据)取最新一条兜底。
              userId,
              productId: product.id,
              status: 'ACTIVE',
              fulfillmentMode: CodingPlanFulfillmentMode.platform_model_package,
              OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            }
          : {
              tenantId: tenantId as string,
              productId: product.id,
              status: 'ACTIVE',
              OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
            },
        orderBy: [{ startedAt: 'desc' }, { createdAt: 'desc' }],
      });
      if (!entitlement) return emptyData;

      const plan = await this.prisma.plan.findUnique({
        where: { id: entitlement.planId },
        select: {
          id: true,
          name: true,
          monthlyPrice: true,
          monthlyCredits: true,
          rateLimitRpm: true,
          rateLimitTpm: true,
          maxContextWindow: true,
          features: true,
          quotaRules: {
            where: { isActive: true },
            select: {
              template: { select: { rules: true, isActive: true, deletedAt: true } },
            },
          },
        },
      });
      if (!plan) return emptyData;

      // 自营 CodingPlan 附配额模板规则视图；转售权益来自上游，不展示本地配额模板。
      const isSelfOperated = entitlement.fulfillmentMode !== CodingPlanFulfillmentMode.provider_resale;
      const quotaRules = isSelfOperated
        ? resolvePlanQuotaRuleViews(plan.quotaRules ?? [], (msg) => this.logger.warn(msg), {
            gateEnabled: rollingQuotaGateEnabled(),
          })
        : [];

      // 自营滚动窗口用量概览（fix3 §1）：周(最大日级 CREDITS 滚动窗口，通常 7d)、5h(最小亚日 CREDITS 滚动窗口)。
      // 预算取规则 limitValue（与 gate enforced 无关——展示用户配置的额度）；entitlement.id 即 creditTransaction 的 subscriptionId。
      const usageWindows = isSelfOperated
        ? await this.buildCodingPlanUsageWindows(
            entitlement.id,
            quotaRules,
            plan.monthlyCredits,
            entitlement.startedAt ?? null,
            entitlement.expiresAt ?? null,
          )
        : undefined;

      return {
        productId: product.id,
        billingMode: product.billingMode,
        fulfillmentMode: entitlement.fulfillmentMode,
        planId: plan.id,
        planName: plan.name,
        billingPeriod: entitlement.billingPeriod,
        codingPlanEntitlementId: entitlement.id,
        monthlyPrice: plan.monthlyPrice,
        monthlyCredits: plan.monthlyCredits,
        rateLimitRpm: plan.rateLimitRpm,
        rateLimitTpm: plan.rateLimitTpm,
        maxContextWindow: plan.maxContextWindow,
        ...(quotaRules.length > 0 ? { quotaRules } : {}),
        ...(usageWindows ? { usageWindows } : {}),
        features: this.parseFeatureList(plan.features),
        status: 'active',
        expiresAt: entitlement.expiresAt?.toISOString() ?? null,
      };
    }

    const period = await this.prisma.subscriptionPeriod.findFirst({
      where: {
        // 非 CODING_PLAN 路径：isSelfOpProduct 恒 false → tenantId 已由 resolveRequiredTenantId 解析为非空。
        tenantId: tenantId as string,
        productId: product.id,
        status: 'ACTIVE',
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      include: {
        plan: {
          select: {
            id: true,
            name: true,
            monthlyPrice: true,
            monthlyCredits: true,
            rateLimitRpm: true,
            rateLimitTpm: true,
            maxContextWindow: true,
            features: true,
          },
        },
      },
      orderBy: [{ startedAt: 'desc' }, { createdAt: 'desc' }],
    });

    if (!period) {
      return emptyData;
    }

    return {
      productId: product.id,
      billingMode: product.billingMode,
      fulfillmentMode: product.codingPlanFulfillmentMode ?? null,
      planId: period.plan.id,
      planName: period.plan.name,
      billingPeriod: period.billingPeriod,
      monthlyPrice: period.plan.monthlyPrice,
      monthlyCredits: period.plan.monthlyCredits,
      rateLimitRpm: period.plan.rateLimitRpm,
      rateLimitTpm: period.plan.rateLimitTpm,
      maxContextWindow: period.plan.maxContextWindow,
      features: this.parseFeatureList(period.plan.features),
      status: 'active',
      expiresAt: period.expiresAt?.toISOString() ?? null,
    };
  }

  async listCodingPlanEntitlements(
    userId: string,
    productId?: string,
    subject: BillingSubjectOptions = {},
  ): Promise<CodingPlanEntitlementView[]> {
    const product = productId ? await this.resolveActiveProduct(productId) : null;
    if (productId && (!product || product.billingMode !== 'CODING_PLAN')) return [];
    const tenantId = await this.resolveCodingPlanOwnerTenantId(userId, subject);

    const rows = await this.prisma.codingPlanEntitlement.findMany({
      where: {
        tenantId,
        ...(product ? { productId: product.id } : {}),
      },
      orderBy: [{ startedAt: 'desc' }, { createdAt: 'desc' }],
    });
    return this.hydrateCodingPlanEntitlements(rows);
  }

  async getCodingPlanEntitlementForUser(
    userId: string,
    entitlementId: string,
    subject: BillingSubjectOptions & { productId?: string | null } = {},
  ): Promise<CodingPlanEntitlementView | null> {
    const explicitTenantId = subject.tenantId?.trim();
    const memberships = await this.prisma.tenantMember.findMany({
      where: {
        userId,
        status: 'active',
        ...(explicitTenantId ? { tenantId: explicitTenantId } : {}),
        tenant: { status: 'active', deletedAt: null },
      },
      select: { tenantId: true },
    });
    if (memberships.length === 0) return null;

    const productId = subject.productId?.trim();
    const row = await this.prisma.codingPlanEntitlement.findFirst({
      where: {
        id: entitlementId,
        tenantId: { in: memberships.map((membership) => membership.tenantId) },
        ...(productId ? { productId } : {}),
      },
    });
    if (!row) return null;
    await this.resolveSubjectForUser(userId, row.tenantId);
    const [view] = await this.hydrateCodingPlanEntitlements([row]);
    return view ?? null;
  }

  async assertCodingPlanEntitlementAccess(
    userId: string,
    entitlementId: string,
    options: { productId?: string | null; requireActive?: boolean } & BillingSubjectOptions = {},
  ): Promise<CodingPlanEntitlementView> {
    const entitlement = await this.getCodingPlanEntitlementForUser(userId, entitlementId, options);
    if (!entitlement) throw new NotFoundException('CodingPlan 权益不存在');
    if (options.requireActive !== false) {
      const expired = entitlement.expiresAt ? new Date(entitlement.expiresAt) < new Date() : false;
      if (entitlement.status !== 'ACTIVE' || expired) {
        throw new BadRequestException('CodingPlan 权益不可用');
      }
    }
    return entitlement;
  }

  async getCodingPlanUsageTrend(
    userId: string,
    entitlementId: string,
    options: {
      productId?: string | null;
      range?: CodingPlanUsageTrendRange;
    } & BillingSubjectOptions = {},
  ): Promise<CodingPlanUsageTrend> {
    const entitlement = await this.assertCodingPlanEntitlementAccess(userId, entitlementId, {
      ...options,
      requireActive: false,
    });
    const range = this.normalizeCodingPlanUsageTrendRange(options.range);
    const { startAt, endAt, bucket } = this.codingPlanUsageTrendWindow(range);
    const buckets = this.buildCodingPlanUsageTrendBuckets(startAt, endAt, bucket);
    const bucketExpr = bucket === 'day'
      ? Prisma.sql`DATE_TRUNC('day', scoped."eventAt" + INTERVAL '8 hours')`
      : Prisma.sql`DATE_TRUNC('hour', scoped."eventAt" + INTERVAL '8 hours')`;
    const bucketFormat = bucket === 'day' ? 'YYYY-MM-DD' : 'YYYY-MM-DD HH24:00';

    const rows = await this.prisma.$queryRaw<Array<{
      time: string;
      model: string;
      calls: number | bigint;
      totalTokens: number | bigint;
    }>>(Prisma.sql`
      WITH scoped AS (
        SELECT
          COALESCE(gbe."occurred_at", tu."created_at") AS "eventAt",
          COALESCE(NULLIF(tu."model", ''), 'Unknown') AS "model",
          GREATEST(
            COALESCE(tu."total_tokens", 0),
            COALESCE(tu."prompt_tokens", 0) + COALESCE(tu."completion_tokens", 0)
          ) AS "totalTokens"
        FROM "token_usage" tu
        LEFT JOIN "gateway_billing_events" gbe ON gbe."id" = tu."gateway_billing_event_id"
        WHERE tu."coding_plan_entitlement_id" = ${entitlement.id}
          AND tu."tenant_id" = ${entitlement.tenantId}
          AND COALESCE(gbe."occurred_at", tu."created_at") >= ${startAt}
          AND COALESCE(gbe."occurred_at", tu."created_at") < ${endAt}
      )
      SELECT
        TO_CHAR(${bucketExpr}, ${bucketFormat}) AS "time",
        scoped."model" AS "model",
        COUNT(*)::bigint AS "calls",
        SUM(scoped."totalTokens")::bigint AS "totalTokens"
      FROM scoped
      GROUP BY ${bucketExpr}, scoped."model"
      ORDER BY ${bucketExpr} ASC, scoped."model" ASC
    `);

    const seriesByModel = new Map<string, CodingPlanUsageTrendSeries>();
    let totalTokens = 0;
    let totalCalls = 0;
    let updatedAtMs = 0;

    for (const row of rows) {
      const model = row.model || 'Unknown';
      const calls = Number(row.calls);
      const tokens = Number(row.totalTokens);
      totalTokens += tokens;
      totalCalls += calls;
      updatedAtMs = Date.now();
      const current = seriesByModel.get(model) ?? {
        model,
        totalTokens: 0,
        calls: 0,
        points: [],
      };
      current.totalTokens += tokens;
      current.calls += calls;
      current.points.push({
        time: row.time,
        totalTokens: tokens,
        calls,
      });
      seriesByModel.set(model, current);
    }

    const series = Array.from(seriesByModel.values())
      .map((item) => {
        const pointsByTime = new Map(item.points.map((point) => [point.time, point]));
        return {
          ...item,
          points: buckets.map((time) => pointsByTime.get(time) ?? { time, totalTokens: 0, calls: 0 }),
        };
      })
      .sort((a, b) => b.totalTokens - a.totalTokens);

    return {
      range,
      bucket,
      timezone: 'Asia/Shanghai',
      startAt: startAt.toISOString(),
      endAt: endAt.toISOString(),
      updatedAt: new Date(updatedAtMs || Date.now()).toISOString(),
      buckets,
      totalTokens,
      totalCalls,
      models: series.map(({ model, totalTokens: modelTokens, calls }) => ({
        model,
        totalTokens: modelTokens,
        calls,
      })),
      series,
    };
  }

  /**
   * F1b（fix3 §2，本期不含 carry-over）：自营 CodingPlan 单一活跃约束 + 同档续订延期 + 异档切换。
   * 仅用于 platform_model_package（自营）；provider_resale 仍走 createCodingPlanEntitlement（可并存多档）。
   *
   * 事务级 advisory lock(`coding-plan-active:{tenantId}:{productId}`) 串行化同账号并发激活；
   * DB partial unique index `uniq_active_self_coding_plan` 作最终兜底（双保险）。
   * 分支（均在同一事务、持锁内判定）：
   *  - 无现存 ACTIVE 自营 → 新建 ACTIVE（首履约发月度）；
   *  - 同档（planId 相同）→ 续订延期：延长现有 ACTIVE.expiresAt（累加购买时长），不新建 ACTIVE、
   *    不重复发月度（月度由 resetQuota cron 在现有 entitlement 上继续发），本订单落一条 CANCELLED 审计行；
   *  - 异档（planId 不同）→ 切换：先 cancel 旧（满足 partial unique 写序）再 insert 新 ACTIVE，
   *    旧 entitlement 下 ApiKey 同事务改绑新 entitlement（用户无感），发新档月度，
   *    返回 rebindFromEntitlementId 供调用方提交后做 publisher 重新镜像。
   *    **本期不做 carry-over**：旧池剩余积分不叠加到新档，随旧 entitlement 作废而搁置（调用方记 warn）。
   * 幂等：本 orderId 已有 ACTIVE 行（重放）→ 不重复发月度；续订重放 → 不重复延期。
   */
  async provisionSelfOperatedEntitlement(input: {
    orderId: string;
    userId: string;
    tenantId: string;
    productId: string;
    planId: string;
    billingPeriod?: BillingPeriod;
    validityDaysOverride?: number | null;
  }): Promise<{
    entitlement: PrismaCodingPlanEntitlement;
    action: 'created' | 'renewed' | 'switched' | 'noop';
    monthlyGrantNeeded: boolean;
    rebindFromEntitlementId: string | null;
  }> {
    const plan = await this.prisma.plan.findUnique({
      where: { id: input.planId },
      select: { validityDays: true },
    });
    if (!plan) throw new NotFoundException('套餐不存在');
    const period = input.billingPeriod ?? 'monthly';
    const periodMultiplier = period === 'quarterly' ? 3 : period === 'yearly' ? 12 : 1;
    const validityDays = input.validityDaysOverride ?? plan.validityDays * periodMultiplier;
    const addMs = validityDays > 0 ? validityDays * 24 * 60 * 60 * 1000 : 0;
    const newExpiresAt = addMs > 0 ? new Date(Date.now() + addMs) : null;
    const common = {
      userId: input.userId,
      tenantId: input.tenantId,
      productId: input.productId,
      planId: input.planId,
      billingPeriod: period,
      fulfillmentMode: CodingPlanFulfillmentMode.platform_model_package,
    };
    const lockKey = `coding-plan-active:${input.tenantId}:${input.productId}`;

    const now = new Date();

    return this.prisma.$transaction(async (tx) => {
      await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${lockKey}))`;

      // 收敛过期但 status 仍为 ACTIVE 的自营行 → EXPIRED（resetQuota/过期 cron 可能滞后）。
      // 既符合「未过期才算 current」业务口径，又释放 partial unique 槽位，避免新 ACTIVE 撞 uniq_active_self_coding_plan。
      await tx.codingPlanEntitlement.updateMany({
        where: {
          tenantId: input.tenantId,
          productId: input.productId,
          fulfillmentMode: CodingPlanFulfillmentMode.platform_model_package,
          status: CodingPlanEntitlementStatus.ACTIVE,
          expiresAt: { not: null, lte: now },
        },
        data: { status: CodingPlanEntitlementStatus.EXPIRED },
      });

      // 幂等短路：本订单已履约（首次已建/续/切并落行），重放一律 no-op——
      // 不重置 startedAt/expiresAt、不重复发月度、不重复改绑、也不让历史订单重放回滚当前档位。
      const existingForOrder = await tx.codingPlanEntitlement.findUnique({
        where: { orderId: input.orderId },
      });
      if (existingForOrder) {
        return {
          entitlement: existingForOrder,
          action: 'noop' as const,
          // created/switched 订单（仍 ACTIVE）重放：仍返回 true，让 grantQuota 用 quotaIdempotencyKey 自行去重——
          // 修复「provision 已提交但 grantQuota 前进程崩溃」导致首月额度永不补发；续订审计行/已被切走（非 ACTIVE）不发。
          monthlyGrantNeeded: existingForOrder.status === CodingPlanEntitlementStatus.ACTIVE,
          rebindFromEntitlementId: null,
        };
      }

      // 现存 ACTIVE/REFUNDING 自营（排除本订单；advisory lock 已串行化并发激活，故此处至多一条）
      const activeSelf = await tx.codingPlanEntitlement.findFirst({
        where: {
          tenantId: input.tenantId,
          productId: input.productId,
          status: {
            in: [
              CodingPlanEntitlementStatus.ACTIVE,
              CodingPlanEntitlementStatus.REFUNDING,
            ],
          },
          fulfillmentMode: CodingPlanFulfillmentMode.platform_model_package,
          NOT: { orderId: input.orderId },
          OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
        },
        orderBy: [{ startedAt: 'desc' }, { createdAt: 'desc' }],
      });
      if (activeSelf?.status === CodingPlanEntitlementStatus.REFUNDING) {
        throw new ConflictException(
          '当前自营套餐正在退款处理中，退款完成或失败前不能续费或换档',
        );
      }

      // 换档抵扣安全闸（codex P0）：携带 proration 的订单，其抵扣额是按「定价时的源 entitlement」剩余持有价值
      // 算出的。并发/重复下单，或「切走→再切回同档（planId 相同但已是另一份 entitlement）」等场景下，可能生成
      // 多张各自基于同一旧套餐抵扣的 PENDING 订单——第一张支付后旧 entitlement 已被切走/作废，其余订单若在此
      // 按续订/新建/对着新档履约，就会把同一份旧套餐剩余价值重复抵扣。故此处按「源 entitlement id」精确锚定：
      // 本订单必须真的从「定价所依据的那份 entitlement」异档切换而来（planId 相同不足以证明是同一份资产）。
      // 源 id 必填：携带抵扣却无源 id（历史/异常单）一律拒绝，不放行。
      // 幂等重放已在上方 existingForOrder 短路，不会走到这里，故不误伤重试。
      const prorationOrder = await tx.order.findUnique({
        where: { id: input.orderId },
        select: { prorationCreditCents: true, prorationSourceEntitlementId: true },
      });
      if ((prorationOrder?.prorationCreditCents ?? 0) > 0) {
        const sourceEntitlementId = prorationOrder?.prorationSourceEntitlementId ?? null;
        const validSwitchSource =
          !!sourceEntitlementId &&
          !!activeSelf &&
          activeSelf.id === sourceEntitlementId && // 精确同一性：当前 ACTIVE 必须就是定价所依据的那份 entitlement
          activeSelf.planId !== input.planId; // 且为异档切换（同档=续订，无源可弃）
        if (!validSwitchSource) {
          // 用独立异常类型：支付后履约命中时，编排层据此对已支付订单自动退款（永久性业务拒绝，非瞬时故障）。
          throw new SelfOpProrationSourceInvalidError();
        }
      }

      // ---- 无现存 ACTIVE：新建 ----
      if (!activeSelf) {
        const created = await tx.codingPlanEntitlement.create({
          data: { orderId: input.orderId, ...common, status: 'ACTIVE', expiresAt: newExpiresAt },
        });
        return {
          entitlement: created,
          action: 'created' as const,
          monthlyGrantNeeded: true,
          rebindFromEntitlementId: null,
        };
      }

      // ---- 同档：续订延期 ----
      if (activeSelf.planId === input.planId) {
        if (addMs > 0) {
          const base =
            activeSelf.expiresAt && activeSelf.expiresAt.getTime() > Date.now()
              ? activeSelf.expiresAt.getTime()
              : Date.now();
          await tx.codingPlanEntitlement.update({
            where: { id: activeSelf.id },
            data: { expiresAt: new Date(base + addMs) },
          });
        }
        // 本订单落审计行（CANCELLED：非 ACTIVE，不撞 partial unique；orderId 唯一 + 上方幂等短路保证仅建一次）
        await tx.codingPlanEntitlement.create({
          data: {
            orderId: input.orderId,
            ...common,
            status: 'CANCELLED',
            expiresAt: null,
            lastError: `renewal-of:${activeSelf.id}`,
          },
        });
        const refreshed = await tx.codingPlanEntitlement.findUnique({ where: { id: activeSelf.id } });
        return {
          entitlement: refreshed ?? activeSelf,
          action: 'renewed' as const,
          monthlyGrantNeeded: false,
          rebindFromEntitlementId: null,
        };
      }

      // ---- 异档：切换（先 cancel 旧，再 insert 新 ACTIVE，满足 partial unique 逐语句检查）----
      await tx.codingPlanEntitlement.update({
        where: { id: activeSelf.id },
        data: { status: 'CANCELLED', lastError: `switched-to-order:${input.orderId}` },
      });
      const switched = await tx.codingPlanEntitlement.create({
        data: { orderId: input.orderId, ...common, status: 'ACTIVE', expiresAt: newExpiresAt },
      });
      // 旧 entitlement 下 ApiKey 改绑新 entitlement（同事务，用户无感、key 不失效）
      await tx.apiKey.updateMany({
        where: { codingPlanEntitlementId: activeSelf.id },
        data: { codingPlanEntitlementId: switched.id },
      });
      return {
        entitlement: switched,
        action: 'switched' as const,
        monthlyGrantNeeded: true,
        rebindFromEntitlementId: activeSelf.id,
      };
    });
  }

  /** F1b 切换后（提交后调用）：把改绑到新 entitlement 的 ApiKey 重新镜像到网关（新绑定 + 余额）。 */
  async resyncCodingPlanEntitlementKeys(entitlementId: string): Promise<void> {
    if (!this.publisherSync || !entitlementId) return;
    // Item 3 硬化：异档切换后用 required(同步)重发 KeyMeta + key-balance——消除「升级后旧 key 仍报余额用尽」
    // 的异步传播窗口；syncApiKeyMetaById 内部会调 syncKeyBalanceById，对未耗尽的新档 key 重算 has_balance=true
    // 并 ZREM cpq:gated（主动解闸）。失败升级为 error（不静默吞）；不抛以免支付后履约回滚（cpq 调度兜底重扫）。
    await this.publisherSync.syncApiKeysByCodingPlanEntitlementIdRequired(entitlementId).catch((err) => {
      this.logger.error(
        `resyncCodingPlanEntitlementKeys(required) 失败 entitlement=${entitlementId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    });
  }

  async createCodingPlanEntitlement(input: {
    orderId: string;
    userId: string;
    tenantId: string;
    productId: string;
    planId: string;
    billingPeriod?: BillingPeriod;
    validityDaysOverride?: number | null;
    fulfillmentMode?: CodingPlanFulfillmentMode;
    status?: CodingPlanEntitlementStatus;
    providerLineId?: string | null;
    providerLineCode?: string | null;
    providerCode?: string | null;
    adapterType?: string | null;
    upstreamProductId?: string | null;
  }) {
    const plan = await this.prisma.plan.findUnique({
      where: { id: input.planId },
      select: { validityDays: true },
    });
    if (!plan) throw new NotFoundException('套餐不存在');
    const period = input.billingPeriod ?? 'monthly';
    const periodMultiplier = period === 'quarterly' ? 3 : period === 'yearly' ? 12 : 1;
    const validityDays = input.validityDaysOverride ?? (plan.validityDays * periodMultiplier);
    const expiresAt = validityDays > 0
      ? new Date(Date.now() + validityDays * 24 * 60 * 60 * 1000)
      : null;

    return this.prisma.codingPlanEntitlement.upsert({
      where: { orderId: input.orderId },
      update: {
        userId: input.userId,
        tenantId: input.tenantId,
        productId: input.productId,
        planId: input.planId,
        billingPeriod: period,
        providerLineId: input.providerLineId ?? undefined,
        providerLineCode: input.providerLineCode ?? undefined,
        providerCode: input.providerCode ?? undefined,
        adapterType: input.adapterType ?? undefined,
        upstreamProductId: input.upstreamProductId ?? undefined,
        fulfillmentMode: input.fulfillmentMode ?? 'platform_model_package',
        status: input.status ?? 'ACTIVE',
        startedAt: new Date(),
        expiresAt,
        lastError: null,
      },
      create: {
        orderId: input.orderId,
        userId: input.userId,
        tenantId: input.tenantId,
        productId: input.productId,
        planId: input.planId,
        billingPeriod: period,
        providerLineId: input.providerLineId ?? null,
        providerLineCode: input.providerLineCode ?? null,
        providerCode: input.providerCode ?? null,
        adapterType: input.adapterType ?? null,
        upstreamProductId: input.upstreamProductId ?? null,
        fulfillmentMode: input.fulfillmentMode ?? 'platform_model_package',
        status: input.status ?? 'ACTIVE',
        expiresAt,
      },
    });
  }

  async markCodingPlanEntitlementFailed(orderId: string, message: string): Promise<void> {
    await this.prisma.codingPlanEntitlement.updateMany({
      where: { orderId },
      data: { status: 'FAILED', lastError: message },
    });
  }

  async attachCodingPlanProviderEntitlement(orderId: string): Promise<void> {
    const providerEntitlement = await this.prisma.codingPlanProviderEntitlement.findUnique({
      where: { orderId },
      select: {
        id: true,
        status: true,
        productStartTime: true,
        productEndTime: true,
        providerLineId: true,
        providerLineCode: true,
        providerCode: true,
        adapterType: true,
        upstreamProductId: true,
        lastError: true,
      },
    });
    if (!providerEntitlement) return;
    await this.prisma.codingPlanEntitlement.updateMany({
      where: { orderId },
      data: {
        providerEntitlementId: providerEntitlement.id,
        providerLineId: providerEntitlement.providerLineId,
        providerLineCode: providerEntitlement.providerLineCode,
        providerCode: providerEntitlement.providerCode,
        adapterType: providerEntitlement.adapterType,
        upstreamProductId: providerEntitlement.upstreamProductId,
        status: providerEntitlement.status === 'ACTIVE' ? 'ACTIVE' : providerEntitlement.status,
        ...(providerEntitlement.productStartTime ? { startedAt: providerEntitlement.productStartTime } : {}),
        ...(providerEntitlement.productEndTime ? { expiresAt: providerEntitlement.productEndTime } : {}),
        lastError: providerEntitlement.lastError,
      },
    });
    if (this.publisherSync) {
      const customerEntitlement = await this.prisma.codingPlanEntitlement.findUnique({
        where: { orderId },
        select: { id: true },
      });
      if (customerEntitlement) {
        await this.publisherSync.syncOpsTopologyFreshRequired().catch((err) => {
          this.logger.warn(
            `publisher runtime topology sync failed after provider entitlement attach order=${orderId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
        await this.publisherSync.syncApiKeysByCodingPlanEntitlementId(customerEntitlement.id).catch((err) => {
          this.logger.warn(
            `publisher api key sync failed after provider entitlement attach order=${orderId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        });
      }
    }
  }

  private async resolveActiveProduct(productId?: string, defaultSlug?: string) {
    if (productId) {
      return this.prisma.product.findFirst({
        where: {
          isActive: true,
          deletedAt: null,
          OR: [
            { id: productId },
            { slug: { equals: productId, mode: 'insensitive' } },
          ],
        },
        select: { id: true, name: true, slug: true, billingMode: true, codingPlanFulfillmentMode: true },
      });
    }
    if (!defaultSlug) return null;
    return this.prisma.product.findFirst({
      where: {
        isActive: true,
        slug: { equals: defaultSlug, mode: 'insensitive' },
        deletedAt: null,
      },
      select: { id: true, name: true, slug: true, billingMode: true, codingPlanFulfillmentMode: true },
    });
  }

  private parseFeatureList(value: string | null | undefined): string[] {
    if (!value) return [];
    try {
      const parsed = JSON.parse(value);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string')
        : [];
    } catch {
      return [];
    }
  }

  private async hydrateCodingPlanEntitlements(
    rows: Array<{
      id: string;
      orderId: string;
      userId: string;
      tenantId: string;
      productId: string;
      planId: string;
      providerEntitlementId: string | null;
      providerLineId: string | null;
      providerLineCode: string | null;
      providerCode: string | null;
      adapterType: string | null;
      upstreamProductId: string | null;
      fulfillmentMode: string;
      billingPeriod: string;
      status: string;
      startedAt: Date;
      expiresAt: Date | null;
      lastError: string | null;
      createdAt: Date;
    }>,
  ): Promise<CodingPlanEntitlementView[]> {
    if (rows.length === 0) return [];
    const productIds = Array.from(new Set(rows.map((row) => row.productId)));
    const planIds = Array.from(new Set(rows.map((row) => row.planId)));
    const providerEntitlementIds = Array.from(
      new Set(rows.map((row) => row.providerEntitlementId).filter((id): id is string => Boolean(id))),
    );

    const [products, plans, providerEntitlements] = await Promise.all([
      this.prisma.product.findMany({
        where: { id: { in: productIds } },
        select: { id: true, name: true, slug: true, billingMode: true },
      }),
      this.prisma.plan.findMany({
        where: { id: { in: planIds } },
        select: {
          id: true,
          name: true,
          description: true,
          monthlyPrice: true,
          quarterlyPrice: true,
          yearlyPrice: true,
          billingPeriod: true,
          monthlyCredits: true,
          rateLimitRpm: true,
          rateLimitTpm: true,
          maxContextWindow: true,
          features: true,
        },
      }),
      providerEntitlementIds.length
        ? this.prisma.codingPlanProviderEntitlement.findMany({
            where: { id: { in: providerEntitlementIds } },
            select: {
              id: true,
              provider: true,
              providerLineId: true,
              providerLineCode: true,
              providerCode: true,
              adapterType: true,
              upstreamProductId: true,
              upstreamApiKeyPrefix: true,
              status: true,
              productStartTime: true,
              productEndTime: true,
              activatedAt: true,
              lastError: true,
            },
          })
        : Promise.resolve([]),
    ]);

    const productById = new Map(products.map((product) => [product.id, product]));
    const planById = new Map(plans.map((plan) => [plan.id, plan]));
    const providerById = new Map(providerEntitlements.map((provider) => [provider.id, provider]));

    return rows.map((row) => {
      const product = productById.get(row.productId);
      const plan = planById.get(row.planId);
      const provider = row.providerEntitlementId ? providerById.get(row.providerEntitlementId) : null;
      return {
        id: row.id,
        orderId: row.orderId,
        userId: row.userId,
        tenantId: row.tenantId,
        productId: row.productId,
        planId: row.planId,
        providerEntitlementId: row.providerEntitlementId,
        providerLineId: row.providerLineId,
        providerLineCode: row.providerLineCode,
        providerCode: row.providerCode,
        adapterType: row.adapterType,
        upstreamProductId: row.upstreamProductId,
        fulfillmentMode: row.fulfillmentMode,
        billingPeriod: row.billingPeriod,
        status: row.status,
        startedAt: row.startedAt.toISOString(),
        expiresAt: row.expiresAt?.toISOString() ?? null,
        lastError: row.lastError,
        product: product
          ? {
              id: product.id,
              name: product.name,
              slug: product.slug,
              billingMode: product.billingMode,
            }
          : null,
        plan: plan
          ? {
              id: plan.id,
              name: plan.name,
              description: plan.description,
              monthlyPrice: plan.monthlyPrice,
              quarterlyPrice: plan.quarterlyPrice,
              yearlyPrice: plan.yearlyPrice,
              billingPeriod: plan.billingPeriod,
              monthlyCredits: plan.monthlyCredits,
              rateLimitRpm: plan.rateLimitRpm,
              rateLimitTpm: plan.rateLimitTpm,
              maxContextWindow: plan.maxContextWindow,
              features: this.parseFeatureList(plan.features),
            }
          : null,
        providerEntitlement: provider
          ? {
              id: provider.id,
              provider: provider.provider,
              providerLineId: provider.providerLineId,
              providerLineCode: provider.providerLineCode,
              providerCode: provider.providerCode,
              adapterType: provider.adapterType,
              upstreamProductId: provider.upstreamProductId,
              upstreamApiKeyPrefix: provider.upstreamApiKeyPrefix,
              status: provider.status,
              productStartTime: provider.productStartTime?.toISOString() ?? null,
              productEndTime: provider.productEndTime?.toISOString() ?? null,
              activatedAt: provider.activatedAt?.toISOString() ?? null,
              lastError: provider.lastError,
            }
          : null,
      };
    });
  }

  async activateSubscription(
    userId: string,
    planId: string,
    productId: string,
    validityDaysOverride?: number,
    billingPeriod: BillingPeriod = 'monthly',
    subject: BillingSubjectOptions = {},
  ) {
    const plan = await this.prisma.plan.findUnique({
      where: { id: planId },
      select: { validityDays: true },
    });

    if (!plan) {
      throw new NotFoundException('套餐不存在');
    }

    const periodMultiplier = billingPeriod === 'quarterly' ? 3 : billingPeriod === 'yearly' ? 12 : 1;
    const validityDays = validityDaysOverride ?? (plan.validityDays * periodMultiplier);
    const expiresAt = validityDays > 0
      ? new Date(Date.now() + validityDays * 24 * 60 * 60 * 1000)
      : null;

    const tenantId = await this.resolveRequiredTenantId(userId, subject);
    const startedAt = new Date();
    const billingSubject = await this.requireTenantSubject(userId, { tenantId });
    const activated = await this.requireSubscriptionLifecycle().activate({
      userId,
      tenantId,
      billingAccountId: billingSubject.billingAccountId,
      productId,
      planId,
      billingPeriod,
      startedAt,
      expiresAt,
      activationIdempotencyKey: subject.idempotencyKey ?? null,
      requiredCompletedOrderId: subject.requiredCompletedOrderId ?? null,
      requireNoActiveSubscription: subject.requireNoActiveSubscription ?? false,
    });

    this.scheduleKeyBalanceSync(userId, billingSubject.tenantId, billingSubject.billingAccountId);
    return activated;
  }

  private requireSubscriptionLifecycle(): SubscriptionLifecycleService {
    if (!this.subscriptionLifecycle) {
      throw new Error('SubscriptionLifecycleService is required for subscription activation');
    }
    return this.subscriptionLifecycle;
  }

  private scheduleKeyBalanceSync(
    userId: string,
    tenantId?: string | null,
    billingAccountId?: string | null,
  ): void {
    if (!this.publisherSync || !userId) return;
    // §6.6:解析出 billingAccountId 时优先 account 级 fanout(企业账户下可能多 tenant),
    // 覆盖同一账户挂载的全部 tenant 的 key;否则回退 tenant/user 级 fanout。
    const normalizedAccountId = billingAccountId?.trim();
    const sync = normalizedAccountId
      ? this.publisherSync.syncBillingAccountKeyBalances(normalizedAccountId)
      : tenantId
        ? this.publisherSync.syncTenantKeyBalances(tenantId)
        : this.publisherSync.syncUserKeyBalances(userId);
    sync.catch((err) => {
      this.logger.warn(
        `publisher key-balance sync failed user=${userId} tenant=${tenantId ?? ''} account=${normalizedAccountId ?? ''}: ${(err as Error).message}`,
      );
    });
  }

  private buildTokenUsageDateFilter(
    startDate?: string,
    endDate?: string,
  ): { gte?: Date; lt?: Date } {
    const DEFAULT_WINDOW_DAYS = 90;
    const MAX_WINDOW_DAYS = 365;
    const dateFilter: { gte?: Date; lt?: Date } = {};

    if (startDate) {
      const start = new Date(startDate);
      if (!Number.isNaN(start.getTime())) dateFilter.gte = start;
    }
    if (!dateFilter.gte) {
      dateFilter.gte = new Date(Date.now() - DEFAULT_WINDOW_DAYS * 86_400_000);
    }

    if (endDate) {
      const end = new Date(endDate);
      if (!Number.isNaN(end.getTime())) {
        end.setDate(end.getDate() + 1);
        dateFilter.lt = end;
      }
    }

    if (dateFilter.gte && dateFilter.lt) {
      const spanMs = dateFilter.lt.getTime() - dateFilter.gte.getTime();
      if (spanMs > MAX_WINDOW_DAYS * 86_400_000) {
        dateFilter.gte = new Date(dateFilter.lt.getTime() - MAX_WINDOW_DAYS * 86_400_000);
      }
    } else if (dateFilter.gte && !dateFilter.lt) {
      const cutoffMax = new Date(Date.now() - MAX_WINDOW_DAYS * 86_400_000);
      if (dateFilter.gte < cutoffMax) dateFilter.gte = cutoffMax;
    }

    return dateFilter;
  }

  private async assertTokenUsageApiKeyAccess(
    userId: string,
    apiKeyId: string | undefined,
    subject: BillingSubjectOptions,
    productId?: string,
  ): Promise<void> {
    if (!apiKeyId) return;
    const tenantSubject = await this.requireTenantSubject(userId, subject);
    const apiKeyUserId = this.tokenUsageApiKeyUserId(userId, tenantSubject);
    const apiKey = await this.prisma.apiKey.findFirst({
      where: {
        id: apiKeyId,
        tenantId: tenantSubject.tenantId,
        ...(apiKeyUserId ? { userId: apiKeyUserId } : {}),
        ...(productId ? { productId } : {}),
      },
      select: { id: true },
    });
    if (!apiKey) throw new ForbiddenException('API Key 不属于当前 Workspace 或当前用户');
  }

  private normalizeCodingPlanUsageTrendRange(value: unknown): CodingPlanUsageTrendRange {
    return value === 'day' || value === 'last30Days' ? value : 'last7Days';
  }

  private codingPlanUsageTrendWindow(range: CodingPlanUsageTrendRange): {
    startAt: Date;
    endAt: Date;
    bucket: 'hour' | 'day';
  } {
    const endAt = new Date();
    if (range === 'day') {
      return { startAt: this.shanghaiDayStartUtc(endAt), endAt, bucket: 'hour' };
    }
    if (range === 'last30Days') {
      return { startAt: this.shanghaiDayStartUtc(endAt, -29), endAt, bucket: 'day' };
    }
    return { startAt: this.shanghaiDayStartUtc(endAt, -6), endAt, bucket: 'hour' };
  }

  private buildCodingPlanUsageTrendBuckets(startAt: Date, endAt: Date, bucket: 'hour' | 'day'): string[] {
    const stepMs = bucket === 'day' ? 24 * 60 * 60 * 1000 : 60 * 60 * 1000;
    const start = this.floorShanghaiBucketUtc(startAt, bucket).getTime();
    const end = this.floorShanghaiBucketUtc(endAt, bucket).getTime();
    const buckets: string[] = [];
    for (let cursor = start; cursor <= end; cursor += stepMs) {
      buckets.push(this.formatShanghaiBucket(new Date(cursor), bucket));
    }
    return buckets;
  }

  private shanghaiDayStartUtc(date: Date, dayOffset = 0): Date {
    const local = new Date(date.getTime() + 8 * 60 * 60 * 1000);
    return new Date(
      Date.UTC(local.getUTCFullYear(), local.getUTCMonth(), local.getUTCDate() + dayOffset) -
      8 * 60 * 60 * 1000,
    );
  }

  private floorShanghaiBucketUtc(date: Date, bucket: 'hour' | 'day'): Date {
    const local = new Date(date.getTime() + 8 * 60 * 60 * 1000);
    return new Date(
      Date.UTC(
        local.getUTCFullYear(),
        local.getUTCMonth(),
        local.getUTCDate(),
        bucket === 'hour' ? local.getUTCHours() : 0,
      ) - 8 * 60 * 60 * 1000,
    );
  }

  private formatShanghaiBucket(date: Date, bucket: 'hour' | 'day'): string {
    const local = new Date(date.getTime() + 8 * 60 * 60 * 1000);
    const year = local.getUTCFullYear();
    const month = String(local.getUTCMonth() + 1).padStart(2, '0');
    const day = String(local.getUTCDate()).padStart(2, '0');
    if (bucket === 'day') return `${year}-${month}-${day}`;
    const hour = String(local.getUTCHours()).padStart(2, '0');
    return `${year}-${month}-${day} ${hour}:00`;
  }

  private tokenUsageApiKeyUserId(
    userId: string,
    subject: ResolvedBillingSubject,
  ): string | undefined {
    this.assertBillingSubjectIntegrity(userId, subject);
    return subject.membershipRole === TENANT_OWNER_ROLE ? undefined : userId;
  }

  async getTokenUsage(
    userId: string,
    options: {
      startDate?: string;
      endDate?: string;
      apiKeyId?: string;
      productId?: string;
      model?: string;
      source?: 'api_key' | 'saas' | 'all';
      page: number;
      pageSize: number;
    },
    subject: BillingSubjectOptions = {},
  ): Promise<{
    items: Array<{
      id: string;
      source: 'api_key';
      apiKeyId: string | null;
      model: string | null;
      pricingTierKey?: string | null;
      promptTokens: number | null;
      cachedInputTokens?: number | null;
      cacheWriteInputTokens?: number | null;
      regularInputTokens?: number | null;
      completionTokens: number | null;
      totalTokens: number | null;
      tokenTypeBreakdown?: string | null;
      costCents: number | null;
      costUsd?: number | null;
      costAmount?: string | null;
      paymentDeductionUsd?: number | null;
      paymentDeductionAmount?: string | null;
      voucherDeductionUsd?: number | null;
      voucherDeductionAmount?: string | null;
      creditsAmount: number | null;
      createdAt: string;
      productId?: string | null;
    }>;
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const pageSize = Math.min(Math.max(options.pageSize, 1), 100);
    const page = Math.max(options.page, 1);
    const source = options.source ?? 'all';

    if (source === 'saas') {
      return { items: [], total: 0, page, pageSize, totalPages: 0 };
    }

    const tenantSubject = await this.requireTenantSubject(userId, subject);
    await this.assertTokenUsageApiKeyAccess(
      userId,
      options.apiKeyId,
      tenantSubject,
      options.productId,
    );
    const filters = {
      userId,
      tenantId: tenantSubject.tenantId,
      apiKeyUserId: this.tokenUsageApiKeyUserId(userId, tenantSubject),
      apiKeyId: options.apiKeyId,
      productId: options.productId,
      model: options.model,
      createdAt: this.buildTokenUsageDateFilter(options.startDate, options.endDate),
    };

    const [items, total] = await Promise.all([
      this.billingRepository.findTokenUsageItems(filters, page, pageSize),
      this.billingRepository.countTokenUsageItems(filters),
    ]);

    return {
      items: items.map((item) => {
        const billingAmounts = getTokenUsageBillingAmounts(item);
        const tokenBreakdown = {
          inputTokens: item.promptTokens,
          cachedInputTokens: item.cachedInputTokens,
          cacheWriteInputTokens: item.cacheWriteInputTokens,
          outputTokens: item.completionTokens,
        };
        return {
          id: item.id,
          source: 'api_key' as const,
          apiKeyId: item.apiKeyId,
          productId: item.productId,
          model: item.model,
          pricingTierKey: item.pricingTierKey,
          promptTokens: item.promptTokens,
          cachedInputTokens: item.cachedInputTokens,
          cacheWriteInputTokens: item.cacheWriteInputTokens,
          regularInputTokens: getRegularInputTokens(tokenBreakdown),
          completionTokens: item.completionTokens,
          totalTokens: item.totalTokens,
          tokenTypeBreakdown: buildTokenTypeBreakdown(tokenBreakdown),
          costCents: usdToCents(billingAmounts.costUsd),
          costUsd: usdNumber(billingAmounts.costUsd),
          costAmount: usdString(billingAmounts.costUsd),
          paymentDeductionUsd: usdNumber(billingAmounts.paymentDeductionUsd),
          paymentDeductionAmount: usdString(billingAmounts.paymentDeductionUsd),
          voucherDeductionUsd: usdNumber(billingAmounts.voucherDeductionUsd),
          voucherDeductionAmount: usdString(billingAmounts.voucherDeductionUsd),
          creditsAmount: null,
          createdAt: item.createdAt.toISOString(),
        };
      }),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async getTokenUsageSummary(
    userId: string,
    options: {
      startDate?: string;
      endDate?: string;
      apiKeyId?: string;
      productId?: string;
      model?: string;
      page: number;
      pageSize: number;
    },
    subject: BillingSubjectOptions = {},
  ): Promise<{
    items: Array<{
      date: string;
      apiKeyId: string;
      apiKeyName: string;
      apiKeyPrefix: string;
      model: string;
      calls: number;
      totalTokens: number;
      promptTokens: number;
      cachedInputTokens: number;
      cacheWriteInputTokens: number;
      completionTokens: number;
      costUsd: number;
      costAmount: string;
      paymentDeductionUsd: number;
      paymentDeductionAmount: string;
      voucherDeductionUsd: number;
      voucherDeductionAmount: string;
    }>;
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const pageSize = Math.min(Math.max(options.pageSize, 1), 100);
    const page = Math.max(options.page, 1);

    const tenantSubject = await this.requireTenantSubject(userId, subject);
    await this.assertTokenUsageApiKeyAccess(
      userId,
      options.apiKeyId,
      tenantSubject,
      options.productId,
    );
    const result = await this.billingRepository.aggregateTokenUsageSummary(
      {
        userId,
        tenantId: tenantSubject.tenantId,
        apiKeyUserId: this.tokenUsageApiKeyUserId(userId, tenantSubject),
        apiKeyId: options.apiKeyId,
        productId: options.productId,
        model: options.model,
        createdAt: this.buildTokenUsageDateFilter(options.startDate, options.endDate),
      },
      page,
      pageSize,
    );

    return {
      items: result.items.map((item) => ({
        ...item,
        costUsd: usdNumber(item.costUsd ?? 0),
        costAmount: usdString(item.costUsd ?? 0),
        paymentDeductionUsd: usdNumber(item.paymentDeductionUsd ?? 0),
        paymentDeductionAmount: usdString(item.paymentDeductionUsd ?? 0),
        voucherDeductionUsd: usdNumber(item.voucherDeductionUsd ?? 0),
        voucherDeductionAmount: usdString(item.voucherDeductionUsd ?? 0),
      })),
      total: result.total,
      page,
      pageSize,
      totalPages: Math.ceil(result.total / pageSize),
    };
  }

  async getTokenUsagePeriodSummary(
    userId: string,
    options: {
      startDate?: string;
      endDate?: string;
      apiKeyId?: string;
      productId?: string;
      model?: string;
      granularity: TokenUsagePeriodGranularity;
    },
    subject: BillingSubjectOptions = {},
  ): Promise<{
    granularity: TokenUsagePeriodGranularity;
    items: Array<{
      period: string;
      calls: number;
      totalTokens: number;
      costUsd: number;
      costAmount: string;
      paymentDeductionUsd: number;
      paymentDeductionAmount: string;
      voucherDeductionUsd: number;
      voucherDeductionAmount: string;
    }>;
  }> {
    const tenantSubject = await this.requireTenantSubject(userId, subject);
    await this.assertTokenUsageApiKeyAccess(
      userId,
      options.apiKeyId,
      tenantSubject,
      options.productId,
    );
    const items = await this.billingRepository.aggregateTokenUsagePeriodSummary(
      {
        userId,
        tenantId: tenantSubject.tenantId,
        apiKeyUserId: this.tokenUsageApiKeyUserId(userId, tenantSubject),
        apiKeyId: options.apiKeyId,
        productId: options.productId,
        model: options.model,
        createdAt: this.buildTokenUsageDateFilter(options.startDate, options.endDate),
      },
      options.granularity,
    );

    return {
      granularity: options.granularity,
      items: items.map((item) => ({
        ...item,
        costUsd: usdNumber(item.costUsd ?? 0),
        costAmount: usdString(item.costUsd ?? 0),
        paymentDeductionUsd: usdNumber(item.paymentDeductionUsd ?? 0),
        paymentDeductionAmount: usdString(item.paymentDeductionUsd ?? 0),
        voucherDeductionUsd: usdNumber(item.voucherDeductionUsd ?? 0),
        voucherDeductionAmount: usdString(item.voucherDeductionUsd ?? 0),
      })),
    };
  }

  // ============================
  // 日账单汇总（Task 1）
  // ============================

  async getDailySummary(
    userId: string,
    startDate: Date,
    endDate: Date,
    apiKeyId?: string,
    subject: BillingSubjectOptions = {},
    productId?: string,
  ): Promise<{
    date: string;
    balanceConsumptionCents: number;
    creditConsumption: number;
    tokenCount: number;
  }[]> {
    const tenantSubject = await this.requireTenantSubject(userId, subject);
    const repositorySubject = this.billingSubjectRef(tenantSubject);
    const apiKeyUserId = this.tokenUsageApiKeyUserId(userId, tenantSubject);
    // 如果指定了 apiKeyId，先验证归属再查 TokenUsage
    if (apiKeyId || apiKeyUserId) {
      await this.assertTokenUsageApiKeyAccess(userId, apiKeyId, tenantSubject, productId);
      const rows = await this.billingRepository.dailyActualUsageFunding({
        userId,
        tenantId: tenantSubject.tenantId,
        apiKeyUserId,
        apiKeyId,
        productId,
        createdAt: { gte: startDate, lt: endDate },
      });
      return rows.map((r) => ({
        date: (r.date instanceof Date ? r.date : new Date(r.date)).toISOString().slice(0, 10),
        balanceConsumptionCents: usdToCents(r.balanceConsumptionUsd),
        creditConsumption: r.creditConsumption,
        tokenCount: r.totalTokens,
      }));
    }

    const [balanceRows, creditRows] = await Promise.all([
      this.billingRepository.dailyBalanceConsumption(userId, startDate, endDate, repositorySubject, productId),
      this.billingRepository.dailyCreditConsumption(userId, startDate, endDate, repositorySubject, productId),
    ]);

    // 按日期合并
    const map = new Map<string, {
      balanceConsumptionCents: number;
      creditConsumption: number;
      tokenCount: number;
    }>();

    for (const r of balanceRows) {
      const key = (r.date instanceof Date ? r.date : new Date(r.date)).toISOString().slice(0, 10);
      const existing = map.get(key) || { balanceConsumptionCents: 0, creditConsumption: 0, tokenCount: 0 };
      existing.balanceConsumptionCents = usdToCents(r.totalUsd);
      map.set(key, existing);
    }

    for (const r of creditRows) {
      const key = (r.date instanceof Date ? r.date : new Date(r.date)).toISOString().slice(0, 10);
      const existing = map.get(key) || { balanceConsumptionCents: 0, creditConsumption: 0, tokenCount: 0 };
      existing.creditConsumption = r.totalCredits;
      existing.tokenCount = r.totalTokens;
      map.set(key, existing);
    }

    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([date, data]) => ({ date, ...data }));
  }

  // ============================
  // 月账单汇总（Task 2）
  // ============================

  async getMonthlySummary(
    userId: string,
    year: number,
    subject: BillingSubjectOptions = {},
    productId?: string,
  ): Promise<{
    month: string;
    balanceConsumeCents: number;
    balanceRechargeCents: number;
    creditConsume: number;
    creditGrant: number;
    creditBonus: number;
  }[]> {
    const tenantSubject = await this.requireTenantSubject(userId, subject);
    const repositorySubject = this.billingSubjectRef(tenantSubject);
    const yearStart = new Date(`${year}-01-01T00:00:00.000Z`);
    const yearEnd = new Date(`${year + 1}-01-01T00:00:00.000Z`);

    const [balanceRows, creditRows] = await Promise.all([
      this.billingRepository.monthlyBalanceSummary(userId, yearStart, yearEnd, repositorySubject, productId),
      this.billingRepository.monthlyCreditSummary(userId, yearStart, yearEnd, repositorySubject, productId),
    ]);

    const map = new Map<string, {
      balanceConsumeCents: number;
      balanceRechargeCents: number;
      creditConsume: number;
      creditGrant: number;
      creditBonus: number;
    }>();

    for (const r of balanceRows) {
      const key = (r.month instanceof Date ? r.month : new Date(r.month)).toISOString().slice(0, 7);
      map.set(key, {
        balanceConsumeCents: usdToCents(r.consumeUsd),
        balanceRechargeCents: usdToCents(r.rechargeUsd),
        creditConsume: 0,
        creditGrant: 0,
        creditBonus: 0,
      });
    }

    for (const r of creditRows) {
      const key = (r.month instanceof Date ? r.month : new Date(r.month)).toISOString().slice(0, 7);
      const existing = map.get(key) || {
        balanceConsumeCents: 0,
        balanceRechargeCents: 0,
        creditConsume: 0,
        creditGrant: 0,
        creditBonus: 0,
      };
      existing.creditConsume = r.consumeCredits;
      existing.creditGrant = r.grantCredits;
      existing.creditBonus = r.bonusCredits;
      map.set(key, existing);
    }

    return Array.from(map.entries())
      .sort(([a], [b]) => a.localeCompare(b))
      .map(([month, data]) => ({ month, ...data }));
  }

  // ============================
  // CSV 导出（Task 4）
  // ============================

  async exportCsv(
    userId: string,
    type: 'daily' | 'monthly' | 'transactions',
    startDate?: Date,
    endDate?: Date,
    year?: number,
    subject: BillingSubjectOptions = {},
  ): Promise<{ filename: string; csv: string }> {
    const tenantSubject = await this.requireTenantSubject(userId, subject);
    const currencyCode = await this.platformCurrencyCode();
    if (type === 'daily') {
      const start = startDate || new Date(new Date().setDate(new Date().getDate() - 30));
      const end = endDate || new Date();
      const rows = await this.getDailySummary(userId, start, end, undefined, tenantSubject);
      const header = `日期,余额消费(${currencyCode}),积分消费,Token数`;
      const lines = rows.map((r) =>
        `${r.date},${this.formatCentsAsMajorCurrency(r.balanceConsumptionCents)},${r.creditConsumption},${r.tokenCount}`,
      );
      return {
        filename: `billing-daily-${start.toISOString().slice(0, 10)}-${end.toISOString().slice(0, 10)}.csv`,
        csv: [header, ...lines].join('\n'),
      };
    }

    if (type === 'monthly') {
      const resolvedYear = year ?? (startDate ? startDate.getFullYear() : new Date().getFullYear());
      const rows = await this.getMonthlySummary(userId, resolvedYear, tenantSubject);
      const header = `月份,余额消费(${currencyCode}),余额充值(${currencyCode}),积分消费,积分发放,积分加油包`;
      const lines = rows.map((r) =>
        [
          r.month,
          this.formatCentsAsMajorCurrency(r.balanceConsumeCents),
          this.formatCentsAsMajorCurrency(r.balanceRechargeCents),
          r.creditConsume,
          r.creditGrant,
          r.creditBonus,
        ].join(','),
      );
      return {
        filename: `billing-monthly-${resolvedYear}.csv`,
        csv: [header, ...lines].join('\n'),
      };
    }

    // transactions
    const txRows = await this.billingRepository.findTransactions(
      userId,
      0,
      1000,
      undefined,
      this.billingSubjectRef(tenantSubject),
    );
    const header = `ID,类型,金额(${currencyCode}),余额(${currencyCode}),关联用量ID,描述,时间`;
    const lines = txRows.map((t) => {
      const amountUsd = t.type === 'CONSUME' ? usd(t.amountUsd).abs() : usd(t.amountUsd);
      return `${t.id},${t.type},${amountUsd},${t.balanceAfterUsd},${t.tokenUsageId ?? ''},"${t.description.replace(/"/g, '""')}",${t.createdAt.toISOString()}`;
    });
    return {
      filename: `billing-transactions-${new Date().toISOString().slice(0, 10)}.csv`,
      csv: [header, ...lines].join('\n'),
    };
  }

  private formatCentsAsMajorCurrency(cents: number): string {
    return centsToUsd(cents).toFixed(2);
  }

  private splitGrantRemaining(grant: PrismaBalanceGrant): {
    paidRemainingUsd: Prisma.Decimal;
    bonusRemainingUsd: Prisma.Decimal;
  } {
    const components = this.grantRemainingComponents(grant);
    if (components.remainingUsd.lte(0)) {
      return {
        paidRemainingUsd: new Prisma.Decimal(0),
        bonusRemainingUsd: new Prisma.Decimal(0),
      };
    }
    return {
      paidRemainingUsd: components.paidRemainingUsd,
      bonusRemainingUsd: components.bonusRemainingUsd,
    };
  }

  private creditDetailStatus(
    grant: PrismaBalanceGrant,
    remainingUsd: Prisma.Decimal,
    now = new Date(),
  ): CreditDetailStatus {
    if (grant.isExpired || (grant.expiresAt && grant.expiresAt.getTime() <= now.getTime())) {
      return 'EXPIRED';
    }
    if (remainingUsd.lte(0)) return 'USED_UP';
    return 'ACTIVE';
  }

  private toCreditDetailItem(grant: PrismaBalanceGrant): CreditDetailItem {
    const { paidRemainingUsd } = this.splitGrantRemaining(grant);
    return {
      id: `${grant.id}:credit`,
      grantId: grant.id,
      orderId: grant.orderId ?? null,
      productId: grant.productId ?? null,
      source: grant.source,
      amountCents: usdToCents(grant.paidAmountUsd),
      remainingCents: usdToCents(paidRemainingUsd),
      status: this.creditDetailStatus(grant, paidRemainingUsd),
      validFrom: grant.validFrom.toISOString(),
      expiresAt: grant.expiresAt ? grant.expiresAt.toISOString() : null,
      createdAt: grant.createdAt.toISOString(),
    };
  }

  private toVoucherDetailItem(grant: PrismaBalanceGrant): VoucherDetailItem {
    const { bonusRemainingUsd } = this.splitGrantRemaining(grant);
    const source = grant.source === BALANCE_GRANT_SOURCE_RECHARGE ? 'RECHARGE_BONUS' : grant.source;
    return {
      id: `${grant.id}:voucher`,
      grantId: grant.id,
      orderId: grant.orderId ?? null,
      productId: grant.productId ?? null,
      source,
      amountCents: usdToCents(grant.bonusAmountUsd),
      remainingCents: usdToCents(bonusRemainingUsd),
      status: this.creditDetailStatus(grant, bonusRemainingUsd),
      validFrom: grant.validFrom.toISOString(),
      expiresAt: grant.expiresAt ? grant.expiresAt.toISOString() : null,
      createdAt: grant.createdAt.toISOString(),
    };
  }

  private toBalanceTransaction(tx: {
    id: string;
    userId: string;
    tenantId?: string | null;
    productId?: string | null;
    type: string;
    amountUsd: Prisma.Decimal;
    balanceAfterUsd: Prisma.Decimal;
    description: string;
    tokenUsageId?: string | null;
    createdAt: Date;
  }): BalanceTransaction {
    const amountUsd = tx.type === 'CONSUME' ? usd(tx.amountUsd).abs() : usd(tx.amountUsd);
    return {
      id: tx.id,
      userId: tx.userId,
      tenantId: tx.tenantId ?? null,
      productId: tx.productId ?? null,
      type: tx.type as TransactionType,
      amountCents: usdToCents(amountUsd),
      balanceAfterCents: usdToCents(tx.balanceAfterUsd),
      amountUsd: usdNumber(amountUsd),
      balanceAfterUsd: usdNumber(tx.balanceAfterUsd),
      tokenUsageId: tx.tokenUsageId ?? undefined,
      description: tx.description,
      createdAt: tx.createdAt.toISOString(),
    };
  }
}
