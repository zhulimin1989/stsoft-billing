import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { createHash } from 'node:crypto';
import {
  Prisma,
  Product,
  UsagePricingPolicy,
  UsagePricingPolicyScope,
  User,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { CreditPolicyService } from '../credit-policy/credit-policy.service';
import { BillingService } from './billing.service';
import { CreditPricingService } from './credit-pricing.service';
import { CreditService } from './credit.service';
import { ModelPricingService, type ModelPricingQuote } from './model-pricing.service';
import { ProviderCostPricingService } from './provider-cost-pricing.service';
import {
  SubscriptionResolverService,
  type ResolvedSubscription,
} from './subscription-resolver.service';
import { centsToUsd, usd, usdNumber, usdToCents } from './money';
import { PublisherSyncService } from '../publisher/publisher-sync.service';
import { billingUsageDeductLockKey } from '../common/utils/redis-key.util';
import { hasPrismaErrorCode } from '../common/utils/prisma-error.util';
import {
  resolvePlanQuotaRuleViews,
  rollingQuotaGateEnabled,
  selfopNegativeDeductEnabled,
  type PlanQuotaRuleView,
} from '../quota-templates/plan-quota-rule-views';
import {
  gatewayTenantMismatchTotal,
  publisherSettlementKeyBalanceSyncTotal,
} from '../metrics/metrics.registry';
import { normalizeCurrencyCode, resolvePlatformCurrency } from './platform-currency';
import { SystemConfigService } from './system-config.service';
import { OFF_PEAK_TIER_KEY, isTokenPricingUnit, parseBandScheduleSafely } from './model-time-band';
import { timed } from '../common/runtime/usage-stage-timings';

export type UsageBillingUnit = 'BALANCE' | 'CREDITS';

export type GatewayModelPricingSnapshot = {
  status: 'VERIFIED' | 'NOT_APPLICABLE' | 'UNAVAILABLE';
  reason?: string | null;
  costUsd?: string;
  pricingTierKey?: string | null;
  inputPriceUsdPerM?: string;
  cachedInputPriceUsdPerM?: string | null;
  cacheWritePriceUsdPerM?: string | null;
  outputPriceUsdPerM?: string;
  lineItems?: UsageBillingLineItem[];
};

export type GatewayCustomerPricingSnapshot = {
  unit: UsageBillingUnit;
  priceBasis: 'LIST' | 'PRODUCT_EFFECTIVE' | 'SUBSCRIPTION_CREDITS' | 'INCLUDED_UPSTREAM';
  basePricing: GatewayModelPricingSnapshot;
  tokenUsagePricing: GatewayModelPricingSnapshot;
  policy: PolicySnapshot;
  customerMultiplier: string;
  planUsageMultiplier: number | null;
  modelAccessMultiplier: string | null;
  effectiveCostUsd: string | null;
  baseCreditCost: number | null;
  creditCost: number | null;
  includedUpstream: boolean;
};

export type GatewayProviderCostSnapshot = {
  status: 'VERIFIED' | 'NOT_APPLICABLE' | 'UNAVAILABLE';
  reason: string | null;
  policyId: string | null;
  providerCode: string | null;
  providerLineId: string | null;
  productId: string | null;
  priceMultiplier: string | null;
  inputCostUsdPerM: string | null;
  cachedInputCostUsdPerM: string | null;
  cacheWriteCostUsdPerM: string | null;
  outputCostUsdPerM: string | null;
  costUsd: string | null;
};

export interface UsageQuoteInput {
  apiKeyId?: string;
  tenantId?: string;
  userId?: string;
  email?: string;
  productId?: string;
  productSlug?: string;
  modelName: string;
  inputTokens?: number;
  outputTokens?: number;
  cachedInputTokens?: number;
  cacheWriteInputTokens?: number;
  imageCount?: number;
  callType?: string;
  upstreamModel?: string;
  billingUnit?: UsageBillingUnit | 'AUTO';
  eventOccurredAt?: string | Date;
  providerCode?: string;
  providerLineId?: string;
}

type NormalizedUsageQuoteInput = Required<
  Pick<
    UsageQuoteInput,
    | 'modelName'
    | 'inputTokens'
    | 'outputTokens'
    | 'cachedInputTokens'
    | 'cacheWriteInputTokens'
    | 'imageCount'
  >
> & UsageQuoteInput;

type UsageTokenDimensions = Pick<
  NormalizedUsageQuoteInput,
  'inputTokens' | 'outputTokens' | 'cachedInputTokens' | 'cacheWriteInputTokens'
>;

type UsageCustomerDimensions = UsageTokenDimensions & Pick<
  NormalizedUsageQuoteInput,
  'imageCount'
>;

export const LATEST_GATEWAY_CUSTOMER_SETTLEMENT_POLICY_VERSION =
  'gateway-customer-settlement-v2' as const;

export type GatewayCustomerSettlementPolicyVersion =
  typeof LATEST_GATEWAY_CUSTOMER_SETTLEMENT_POLICY_VERSION;

type GatewayCustomerFinancialAuthority = {
  protocol: 'gateway-customer-financial-authority-v1';
  policyVersion: GatewayCustomerSettlementPolicyVersion;
  basis: NonNullable<UsageDeductInput['gatewayCustomerSettlement']>['basis'];
  billingUnit: UsageBillingUnit;
  terminalClass:
    | 'BALANCE_SETTLED'
    | 'BALANCE_DEBT_OPEN'
    | 'CREDITS_CHARGED'
    | 'CREDITS_ZERO'
    | 'CREDITS_INCLUDED'
    | 'CREDITS_DEBT_OPEN';
  fundingOutcome: string;
  customerAmountUnit: 'USD' | 'CREDITS';
  originalCustomerAmount: string;
  settledCustomerAmount: string;
  originalCustomerChargeUsd: string;
  settledCustomerChargeUsd: string;
  originalDimensions: NonNullable<
    UsageDeductInput['gatewayCustomerSettlement']
  >['originalDimensions'];
  settledDimensions: NonNullable<
    UsageDeductInput['gatewayCustomerSettlement']
  >['settledDimensions'];
  anchorHash: string;
  pricingHash: string;
  settlementFingerprint: string;
  tokenUsageId: string;
};

type TokenUsageFunding = 'SETTLED' | 'DEBT_OPEN' | 'ZERO_CREDITS' | {
  debtOpen: boolean;
  debtExposureUsd: Prisma.Decimal;
  collectedUsd: Prisma.Decimal;
  approvedCreditUsd: Prisma.Decimal;
  unapprovedDebtUsd: Prisma.Decimal;
};

export type UsageBillingLineItem = {
  meter: 'image';
  quantity: number;
  unitPriceUsd: string;
  amountUsd: string;
};

export interface UsageDeductInput extends UsageQuoteInput {
  source: string;
  idempotencyKey: string;
  requestId?: string;
  totalTokens?: number;
  recordTokenUsage?: boolean;
  /** Requested by the Gateway event mapper; ignored by ordinary deduct calls. */
  allowNegativeBalance?: boolean;
  /**
   * Immutable receipt annotation for a Gateway settlement whose customer
   * meters were derived independently from incomplete provider evidence.
   * The raw Gateway evidence remains append-only; this describes only the
   * customer-facing amount selected under the frozen tariff.
   */
  gatewayCustomerSettlement?: {
    policyVersion: GatewayCustomerSettlementPolicyVersion;
    basis:
      | 'NORMALIZED_EXACT'
      | 'CUSTOMER_PROTECTIVE_ZERO';
    /** Mutable provider evidence/reconciliation classification. */
    evidenceReason: string;
    /** Diagnostic protection classification; excluded from financial identity. */
    customerProtectionReason?: string;
    originalDimensions: {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      cacheWriteInputTokens: number;
      totalTokens: number;
      imageCount: number;
    };
    settledDimensions: {
      inputTokens: number;
      outputTokens: number;
      cachedInputTokens: number;
      cacheWriteInputTokens: number;
      totalTokens: number;
      imageCount: number;
    };
  };
}

export type GatewaySettlementAnchor = {
  requestId: string;
  apiKeyId: string;
  userId: string;
  tenantId: string;
  billingAccountId: string;
  productId: string;
  productSlug: string;
  billingUnit: UsageBillingUnit;
  /** Frozen ISO-4217 account currency; legacy rows may be unknown/null. */
  billingCurrency: string | null;
  codingPlanEntitlementId: string | null;
  subscriptionId: string | null;
  planId: string | null;
  occurredAt: Date;
  firstReceivedAt: Date;
  /** Frozen with the first receipt and bound into every permanent authority. */
  customerSettlementPolicyVersion: GatewayCustomerSettlementPolicyVersion;
  /** Present only after the BALANCE first-receipt anchor is committed. */
  firstReceiptSequence?: bigint | null;
  fundingReservationProtocol?: string | null;
  pricingHash: string;
  customerQuoteSnapshot: UsageQuoteResult;
  customerPricingSnapshot: GatewayCustomerPricingSnapshot;
  providerCostSnapshot: GatewayProviderCostSnapshot;
  anchorHash: string;
  entitlementSnapshot?: {
    entitlementKind?: 'subscription_period' | 'coding_plan_entitlement';
    billingPeriod: string;
    fulfillmentMode?: string | null;
    providerEntitlementId?: string | null;
    providerLineId?: string | null;
    providerLineCode?: string | null;
    providerCode?: string | null;
    upstreamProductId?: string | null;
  } | null;
  planSnapshot?: {
    id: string;
    name: string;
    monthlyCredits: number;
    usageMultiplier: number;
    rateLimitRpm: number;
    rateLimitTpm: number;
    maxContextWindow: number;
  } | null;
};

export type GatewaySettlementContext = {
  gatewayBillingEventId: string;
  expectedRevision: number;
  evidenceHash: string;
  anchor: GatewaySettlementAnchor;
  fundingReservationOverrideActionId?: string;
};

export type GatewayFrozenUsageValuation = {
  quote: UsageQuoteResult;
  customerChargeUsd: string;
  providerCostUsd: string | null;
};

export class GatewaySettlementAnchorConflictError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'GatewaySettlementAnchorConflictError';
  }
}

/**
 * The immutable settlement subject is valid, but this deployment cannot price
 * it until the account-currency migration has completed. This is mutable
 * operator configuration, not an invalid UsageEvent or an anchor conflict.
 * Kafka must therefore retain the source offset and retry the exact evidence
 * after the migration instead of committing a customer access restriction.
 */
export class GatewayBillingCurrencyMigrationRequiredError extends Error {
  readonly code: 'billing_account_currency_migration_required';
  readonly retryable: true;

  constructor(
    readonly accountCurrency: string,
    readonly deploymentCurrency: string,
    readonly billingAccountId?: string,
    readonly apiKeyId?: string,
  ) {
    super(
      `Gateway billing currency migration required: account=${accountCurrency} `
      + `deployment=${deploymentCurrency}`
      + (billingAccountId ? ` billingAccountId=${billingAccountId}` : '')
      + (apiKeyId ? ` apiKeyId=${apiKeyId}` : ''),
    );
    this.name = 'GatewayBillingCurrencyMigrationRequiredError';
    this.code = 'billing_account_currency_migration_required';
    this.retryable = true;
  }
}

export class GatewayBillingRevisionConflictError extends ConflictException {
  constructor(message = 'Gateway billing event revision 已变化，请刷新后重试') {
    super(message);
    this.name = 'GatewayBillingRevisionConflictError';
  }
}

type ResolvedContext = {
  user: User | null;
  product: Product;
  tenantId: string | null;
  billingAccountId?: string | null;
  billingAccountType?: string | null;
  billingAccountCurrency?: string | null;
  codingPlanEntitlementId?: string | null;
};

type PolicySnapshot = {
  id: string | null;
  scope: UsagePricingPolicyScope | 'ENTERPRISE' | 'DEFAULT';
  modelName: string | null;
  priceMultiplier: string;
  creditMultiplier: string | null;
  priority: number;
};

type GatewayBillingEventLookup = {
  gatewayBillingEvent?: {
    findUnique(args: {
      where: { requestId: string };
      select: { id: true };
    }): Promise<{ id: string } | null>;
  };
};

type BalanceQuote = {
  unit: 'BALANCE';
  userId: string | null;
  tenantId?: string | null;
  billingAccountId?: string | null;
  productId: string;
  productSlug: string;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  imageCount: number;
  callType?: string;
  upstreamModel?: string;
  pricingTierKey?: string | null;
  priceBasis: 'LIST' | 'PRODUCT_EFFECTIVE';
  customerPricing: {
    inputPriceUsdPerM: string;
    cachedInputPriceUsdPerM: string | null;
    cacheWritePriceUsdPerM: string | null;
    outputPriceUsdPerM: string;
  };
  baseCostUsd: string;
  effectiveCostUsd: string;
  amountCents: number;
  providerCode?: string | null;
  providerLineId?: string | null;
  lineItems?: UsageBillingLineItem[];
  policy: PolicySnapshot;
};

type CreditQuote = {
  unit: 'CREDITS';
  userId: string;
  tenantId?: string | null;
  billingAccountId?: string | null;
  productId: string;
  productSlug: string;
  modelName: string;
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  imageCount: number;
  callType?: string;
  upstreamModel?: string;
  pricingTierKey?: string | null;
  subscriptionId: string;
  entitlementKind?: 'subscription_period' | 'coding_plan_entitlement';
  codingPlanEntitlementId?: string | null;
  planId: string;
  fulfillmentMode?: string | null;
  providerEntitlementId?: string | null;
  providerLineId?: string | null;
  providerLineCode?: string | null;
  providerCode?: string | null;
  upstreamProductId?: string | null;
  baseCreditCost: number;
  creditCost: number;
  includedUpstream?: boolean;
  lineItems?: UsageBillingLineItem[];
  policy: PolicySnapshot;
};

export type UsageQuoteResult = BalanceQuote | CreditQuote;

export type UsageAuthorizeResult = {
  allowed: boolean;
  reason?: string;
  quote: UsageQuoteResult;
  balanceCents?: number;
  projectedBalanceCents?: number;
  creditLimitCents?: number;
  quotaCredits?: number;
  bonusCredits?: number;
  grantCredits?: number;
  totalCredits?: number;
  /** 滚动配额 gate 拒绝详情（reason='rolling_quota_exhausted' 时填充，供排查/展示）。 */
  quotaGate?: { metric: string; windowSec: number; limit: number; used: number };
};

export type UsagePolicyWriteInput = {
  productId: string;
  scope: UsagePricingPolicyScope;
  userId?: string | null;
  userEmail?: string | null;
  segmentId?: string | null;
  modelName?: string | null;
  priceMultiplier?: string | number;
  creditMultiplier?: string | number | null;
  priority?: number;
  description?: string;
  startsAt?: string | Date | null;
  endsAt?: string | Date | null;
  isActive?: boolean;
};

export type EnterpriseModelDiscountItemInput = {
  modelName: string;
  priceMultiplier?: string | number | null;
  isActive?: boolean;
  note?: string | null;
};

export type EnterpriseModelDiscountMatrixInput = {
  productId: string;
  items: EnterpriseModelDiscountItemInput[];
  updatedBy?: string | null;
};

export type PaygModelPricingVersionInput = {
  productId: string;
  modelName: string;
  priceMultiplier?: string | number | null;
  inputPricePerMToken?: string | number | null;
  cachedInputPrice?: string | number | null;
  cacheWritePrice?: string | number | null;
  outputPricePerMToken?: string | number | null;
  startsAt?: string | Date | null;
  endsAt?: string | Date | null;
  isActive?: boolean;
  description?: string | null;
};

type ProductModelAvailabilityStatus = 'ACTIVE' | 'SUSPENDED' | 'RETIRED';

type EnterpriseDiscountModelRow = {
  modelName: string;
  status: string;
  apiEnabled: boolean;
  visible: boolean;
  startsAt: Date | null;
  endsAt: Date | null;
  displayOrder: number;
  reason: string;
  modelPricing: {
    modelName: string;
    provider: string | null;
    isActive: boolean;
    inputPricePerMToken: Prisma.Decimal;
    cachedInputPrice: Prisma.Decimal | null;
    cacheWrite5minPrice: Prisma.Decimal | null;
    cacheWrite1hPrice: Prisma.Decimal | null;
    outputPricePerMToken: Prisma.Decimal;
    longContextThreshold: number | null;
    longContextInputPrice: Prisma.Decimal | null;
    longContextOutputPrice: Prisma.Decimal | null;
    priceTiers: Array<{
      tierKey: string;
      displayName: string | null;
      minInputTokens: number;
      maxInputTokensExclusive: number | null;
      inputPricePerMToken: Prisma.Decimal;
      outputPricePerMToken: Prisma.Decimal;
      cachedInputPrice: Prisma.Decimal | null;
      cacheWritePrice: Prisma.Decimal | null;
      currency: string;
      rawCondition: string | null;
      source: string | null;
      priority: number;
      isActive: boolean;
    }>;
  };
};

type EnterpriseDiscountRecord = {
  id: string;
  priceMultiplier: Prisma.Decimal;
  isActive: boolean;
  note: string;
  updatedBy: string | null;
  createdAt: Date;
  updatedAt: Date;
};

export type PaygProductModelWriteInput = {
  productId: string;
  modelNames?: string[];
  modelName?: string;
  status?: ProductModelAvailabilityStatus;
  apiEnabled?: boolean;
  visible?: boolean;
  startsAt?: string | Date | null;
  endsAt?: string | Date | null;
  displayOrder?: number | null;
  reason?: string | null;
};

export type PaygProductModelUpdateInput = Omit<Partial<PaygProductModelWriteInput>, 'productId' | 'modelNames' | 'modelName'>;

const USAGE_DEDUCT_LOCK_SECONDS = 60;
const USAGE_IDEMPOTENCY_TTL_MS = 30 * 86400 * 1000;
const USAGE_PENDING_IDEMPOTENCY_TTL_MS = 30 * 60 * 1000;
const ENTERPRISE_BILLING_ACCOUNT_TYPE = 'enterprise';

/**
 * Read a funding measure out of a settlement response, or null when the shape
 * is not a number this code may reason about.
 *
 * `Number()` is deliberately not used directly. It coerces `null`, `''`, `[]`
 * and `false` to 0 and `true` to 1, all of which pass `Number.isFinite`. The
 * zero cases happen to be harmless for the skip decision below (they make it
 * publish), but `true` would be read as a balance of 1 and suppress a publish
 * on a response shape this code does not actually understand. Only a real
 * number or a strictly numeric string is accepted; everything else is unknown,
 * and unknown must never satisfy a skip.
 */
export function fundingMeasure(value: unknown): number | null {
  if (typeof value === 'number') return Number.isFinite(value) ? value : null;
  if (typeof value === 'string') {
    const trimmed = value.trim();
    if (trimmed === '') return null;
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : null;
  }
  return null;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

@Injectable()
export class UsageBillingStrategyService {
  private readonly logger = new Logger(UsageBillingStrategyService.name);
  private readonly idempotencyScope = 'billing:usage:deduct';

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly billingService: BillingService,
    private readonly creditService: CreditService,
    private readonly creditPricing: CreditPricingService,
    private readonly modelPricing: ModelPricingService,
    private readonly providerCostPricing: ProviderCostPricingService,
    private readonly subscriptionResolver: SubscriptionResolverService,
    private readonly creditPolicy: CreditPolicyService,
    @Optional() private readonly publisherSync?: PublisherSyncService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly systemConfig?: SystemConfigService,
  ) {}

  /**
   * Fail Kafka usage ingestion before a connection is opened when a locally
   * reachable Gateway key points at an account that this deployment cannot
   * settle.
   *
   * Reachability is intentionally rooted at active, mirrored, unexpired keys
   * and their active local tenant/account/product graph. Historical accounts
   * without a reachable key are outside the live ingestion boundary. Provider
   * resale keys remain in scope: they still create a local immutable anchor and
   * freeze billingCurrency before resolving their included-upstream policy.
   */
  async assertReachableGatewayBillingAccountCurrencies(): Promise<void> {
    const deploymentConfig = await this.systemConfig?.getDeploymentConfig();
    const deploymentCurrency = resolvePlatformCurrency(
      this.config,
      deploymentConfig,
    ).currencyCode;
    const mismatches = await this.prisma.$queryRaw<Array<{
      billingAccountId: string;
      accountCurrency: string;
      apiKeyId: string;
    }>>`
      SELECT
        ba."id" AS "billingAccountId",
        UPPER(BTRIM(ba."currency")) AS "accountCurrency",
        ak."id" AS "apiKeyId"
      FROM "api_keys" ak
      INNER JOIN "tenants" t
        ON t."id" = ak."tenant_id"
      INNER JOIN "billing_accounts" ba
        ON ba."id" = t."billing_account_id"
      INNER JOIN "products" p
        ON p."id" = ak."product_id"
      WHERE ak."deleted_at" IS NULL
        AND ak."is_active" IS TRUE
        AND ak."mirror_status" = 'ACTIVE'
        AND (ak."expires_at" IS NULL OR ak."expires_at" > clock_timestamp())
        AND t."deleted_at" IS NULL
        AND t."status" = 'active'
        AND ba."deleted_at" IS NULL
        AND ba."status" = 'active'
        AND p."deleted_at" IS NULL
        AND p."is_active" IS TRUE
        AND UPPER(BTRIM(ba."currency")) <> ${deploymentCurrency}
      ORDER BY ba."id", ak."id"
      LIMIT 1
    `;
    const mismatch = mismatches[0];
    if (!mismatch) return;
    throw new GatewayBillingCurrencyMigrationRequiredError(
      mismatch.accountCurrency,
      deploymentCurrency,
      mismatch.billingAccountId,
      mismatch.apiKeyId,
    );
  }

  async resolveGatewaySettlementAnchor(
    db: Prisma.TransactionClient,
    input: UsageDeductInput,
    firstReceivedAt: Date,
  ): Promise<GatewaySettlementAnchor> {
    const normalized = this.normalizeQuoteInput(input);
    const requestId = input.requestId?.trim();
    const apiKeyId = normalized.apiKeyId?.trim();
    const occurredAt = this.eventOccurredAtForSettlement(normalized);
    if (
      !requestId || !apiKeyId || !occurredAt ||
      !(firstReceivedAt instanceof Date) || Number.isNaN(firstReceivedAt.getTime())
    ) {
      throw new BadRequestException(
        'Gateway settlement anchor 需要 requestId、apiKeyId、eventOccurredAt 和 DB firstReceivedAt',
      );
    }
    const context = await this.resolveContext(normalized, db);
    const tenantId = this.effectiveTenantId(context);
    const userId = context.user?.id;
    const billingAccountId = context.billingAccountId?.trim();
    if (!userId || !billingAccountId) {
      throw new BadRequestException('Gateway settlement anchor 无法形成完整账务主体');
    }
    const accountCurrency = context.billingAccountCurrency?.trim();
    if (!accountCurrency || !/^[A-Za-z]{3}$/.test(accountCurrency)) {
      throw new BadRequestException('Gateway settlement anchor 无法冻结有效账务币种');
    }
    const billingCurrency = normalizeCurrencyCode(accountCurrency).toUpperCase();
    const deploymentConfig = await this.systemConfig?.getDeploymentConfig(db);
    const deploymentCurrency = resolvePlatformCurrency(
      this.config,
      deploymentConfig,
    ).currencyCode;
    if (billingCurrency !== deploymentCurrency) {
      throw new GatewayBillingCurrencyMigrationRequiredError(
        billingCurrency,
        deploymentCurrency,
        billingAccountId,
        apiKeyId,
      );
    }
    if (
      (normalized.userId?.trim() && normalized.userId.trim() !== userId) ||
      (normalized.tenantId?.trim() && normalized.tenantId.trim() !== tenantId) ||
      (normalized.productId?.trim() && normalized.productId.trim() !== context.product.id) ||
      (normalized.productSlug?.trim() && normalized.productSlug.trim() !== context.product.slug)
    ) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway UsageEvent 声明主体与首次收件时 API Key 绑定不一致',
      );
    }
    const billingUnit = this.resolveBillingUnit(
      normalized.billingUnit,
      context.product,
      context.codingPlanEntitlementId,
    );
    const resolved = billingUnit === 'CREDITS'
      ? await this.subscriptionResolver.resolveAtReceipt(
          db,
          userId,
          context.product.id,
          {
            tenantId,
            codingPlanEntitlementId: context.codingPlanEntitlementId,
          },
          firstReceivedAt,
        )
      : null;
    if (billingUnit === 'CREDITS' && !resolved) {
      throw new BadRequestException('Gateway settlement anchor 无法冻结有效权益');
    }
    if (billingUnit === 'CREDITS' && resolved) {
      await this.creditService.ensureBalanceStateForGatewayAnchor(
        db,
        resolved.subscriptionId,
        userId,
      );
    }
    const { quote, customerPricingSnapshot } = await this.calculateQuoteAtReceipt(
      normalized,
      context,
      resolved,
      billingUnit,
      db,
    );
    const providerCostSnapshot = await this.resolveProviderCostSnapshotAtReceipt(
      normalized,
      quote,
      customerPricingSnapshot,
      db,
    );
    const pricingCanonical = {
      customerQuoteSnapshot: quote,
      customerPricingSnapshot,
      providerCostSnapshot,
    };
    const pricingHash = createHash('sha256')
      .update(canonicalJson(pricingCanonical))
      .digest('hex');
    const customerSettlementPolicyVersion =
      LATEST_GATEWAY_CUSTOMER_SETTLEMENT_POLICY_VERSION;
    const canonical = {
      requestId,
      apiKeyId,
      userId,
      tenantId,
      billingAccountId,
      billingCurrency,
      productId: context.product.id,
      productSlug: context.product.slug,
      billingUnit,
      codingPlanEntitlementId: resolved?.codingPlanEntitlementId
        ?? context.codingPlanEntitlementId
        ?? null,
      subscriptionId: resolved?.subscriptionId ?? null,
      planId: resolved?.planId ?? null,
      occurredAt: occurredAt.toISOString(),
      firstReceivedAt: firstReceivedAt.toISOString(),
      customerSettlementPolicyVersion,
      pricingHash,
      ...pricingCanonical,
      entitlementSnapshot: resolved
        ? {
            entitlementKind: resolved.entitlementKind,
            billingPeriod: resolved.billingPeriod,
            fulfillmentMode: resolved.fulfillmentMode ?? null,
            providerEntitlementId: resolved.providerEntitlementId ?? null,
            providerLineId: resolved.providerLineId ?? null,
            providerLineCode: resolved.providerLineCode ?? null,
            providerCode: resolved.providerCode ?? null,
            upstreamProductId: resolved.upstreamProductId ?? null,
          }
        : null,
      planSnapshot: resolved ? resolved.plan : null,
    };
    const anchor: GatewaySettlementAnchor = {
      ...canonical,
      occurredAt,
      firstReceivedAt,
      anchorHash: createHash('sha256')
        .update(canonicalJson(canonical))
        .digest('hex'),
    };
    await this.assertGatewaySettlementAnchorBinding(db, anchor, false);
    return anchor;
  }

  async assertGatewaySettlementAnchorForReceipt(
    db: Prisma.TransactionClient,
    anchor: GatewaySettlementAnchor,
  ): Promise<void> {
    await this.assertGatewaySettlementAnchorBinding(db, anchor, true);
  }

  async reserveGatewayBalanceFunding(
    gatewayBillingEventId: string,
    anchor: GatewaySettlementAnchor,
  ) {
    const quote = anchor.customerQuoteSnapshot;
    if (quote.unit !== 'BALANCE') return null;
    if (!quote.userId || !anchor.billingAccountId) {
      throw new BadRequestException('Gateway BALANCE funding reservation subject is incomplete');
    }
    if (
      anchor.fundingReservationProtocol !== 'V1'
      || !anchor.firstReceiptSequence
      || anchor.firstReceiptSequence <= 0n
      || !anchor.billingCurrency
    ) {
      throw new BadRequestException(
        'Gateway BALANCE first receipt is not eligible for automatic funding reservation',
      );
    }
    return this.billingService.reserveGatewayBalanceFunding({
      gatewayBillingEventId,
      requestId: anchor.requestId,
      billingAccountId: anchor.billingAccountId,
      tenantId: anchor.tenantId,
      userId: quote.userId,
      apiKeyId: anchor.apiKeyId,
      billingCurrency: anchor.billingCurrency,
      occurredAt: anchor.occurredAt,
      firstReceivedAt: anchor.firstReceivedAt,
      firstReceiptSequence: anchor.firstReceiptSequence,
      anchorHash: anchor.anchorHash,
      reservedAmountUsd: quote.effectiveCostUsd,
    });
  }

  async releaseGatewayBalanceFunding(requestId: string, reason: string): Promise<void> {
    await this.billingService.releaseGatewayBalanceFundingReservation(requestId, reason);
  }

  async quote(
    input: UsageQuoteInput,
    settlementAnchor?: GatewaySettlementAnchor,
    pricingAt?: Date,
  ): Promise<UsageQuoteResult> {
    const normalized = this.normalizeQuoteInput(input);
    if (settlementAnchor) {
      this.assertSettlementInputMatchesAnchor(normalized, settlementAnchor);
      return this.frozenQuoteFromSettlementAnchor(normalized, settlementAnchor);
    }
    // 计价时刻优先级：锚点/入参的请求开始时刻 > deduct 入口冻结的 pricingAt > 本地 now。
    // 无锚点链路必须由 deductInternal 冻结同一个 pricingAt 贯穿（quote/积分/落账），
    // 否则跨峰谷边界时会出现"积分按第一档扣、落账按第二档写"的分叉。
    const effectiveAt = this.eventOccurredAtForSettlement(normalized) ?? pricingAt ?? new Date();
    const context = await this.resolveContext(normalized);
    const tenantId = this.effectiveTenantId(context);
    const unit = this.resolveBillingUnit(
      normalized.billingUnit,
      context.product,
      context.codingPlanEntitlementId,
    );
    const policy = await this.resolveUsagePolicy(
      context.product.id,
      normalized.modelName,
      context.user?.id ?? null,
      context.billingAccountId ?? null,
      context.billingAccountType ?? null,
      effectiveAt,
      unit,
    );

    if (unit === 'BALANCE') {
      const priceBasis = context.billingAccountType === ENTERPRISE_BILLING_ACCOUNT_TYPE
        && context.product.billingMode === 'PAY_AS_YOU_GO'
        ? 'LIST'
        : 'PRODUCT_EFFECTIVE';
      const baseQuote = await this.modelPricing.calculateCostQuote(
        normalized.modelName,
        normalized.inputTokens,
        normalized.outputTokens,
        normalized.cachedInputTokens,
        normalized.cacheWriteInputTokens,
        {
          productId: context.product.id,
          priceBasis,
          effectiveAt,
          bandAt: effectiveAt,
          ...(normalized.imageCount > 0 ? { imageCount: normalized.imageCount } : {}),
        },
      );
      const multiplier = new Prisma.Decimal(policy.priceMultiplier);
      const customerPricing = this.applyCustomerPriceMultiplier(
        baseQuote,
        multiplier,
        normalized.inputTokens,
        normalized.outputTokens,
        normalized.cachedInputTokens,
        normalized.cacheWriteInputTokens,
      );
      const effectiveCostUsd = customerPricing.costUsd;
      return {
        unit,
        userId: context.user?.id ?? null,
        tenantId,
        billingAccountId: context.billingAccountId ?? null,
        productId: context.product.id,
        productSlug: context.product.slug,
        modelName: normalized.modelName,
        inputTokens: normalized.inputTokens,
        outputTokens: normalized.outputTokens,
        cachedInputTokens: normalized.cachedInputTokens,
        cacheWriteInputTokens: normalized.cacheWriteInputTokens,
        imageCount: normalized.imageCount,
        callType: normalized.callType,
        upstreamModel: normalized.upstreamModel,
        pricingTierKey: baseQuote.pricingTierKey,
        priceBasis,
        customerPricing: {
          inputPriceUsdPerM: customerPricing.inputPriceUsdPerM.toString(),
          cachedInputPriceUsdPerM: customerPricing.cachedInputPriceUsdPerM?.toString() ?? null,
          cacheWritePriceUsdPerM: customerPricing.cacheWritePriceUsdPerM?.toString() ?? null,
          outputPriceUsdPerM: customerPricing.outputPriceUsdPerM.toString(),
        },
        baseCostUsd: baseQuote.costUsd.toString(),
        effectiveCostUsd: effectiveCostUsd.toString(),
        amountCents: usdToCents(effectiveCostUsd),
        providerCode: normalized.providerCode ?? null,
        providerLineId: normalized.providerLineId ?? null,
        ...(customerPricing.lineItems?.length
          ? { lineItems: this.toUsageBillingLineItems(customerPricing.lineItems) }
          : {}),
        policy,
      };
    }

    if (!context.user) {
      throw new BadRequestException('积分计费 quote 需要 userId 或 email');
    }
    const resolved = await this.subscriptionResolver.resolve(
      context.user.id,
      context.product.id,
      { tenantId, codingPlanEntitlementId: context.codingPlanEntitlementId },
    );
    if (!resolved) {
      throw new BadRequestException('用户没有该产品的有效订阅');
    }
    const includedUpstream = resolved.fulfillmentMode === 'provider_resale';
    const imagePricingQuote = normalized.imageCount > 0 && !includedUpstream
      ? await this.modelPricing.calculateCostQuote(
          normalized.modelName,
          normalized.inputTokens,
          normalized.outputTokens,
          normalized.cachedInputTokens,
          normalized.cacheWriteInputTokens,
          {
            priceBasis: 'LIST',
            effectiveAt,
            imageCount: normalized.imageCount,
          },
        )
      : null;
    // 结构化积分报价：一次调用同时拿积分与选中价格档（同一定价快照），
    // tierKey 用于落账审计（时段档命中时为 'OFF_PEAK'）。转售不计价。
    const creditPricingQuote = includedUpstream
      ? null
      : await this.creditPricing.calculateCreditCostQuote(
          resolved.planId,
          normalized.modelName,
          normalized.inputTokens,
          normalized.outputTokens,
          resolved.plan.usageMultiplier,
          normalized.cachedInputTokens,
          {
            requireModelAccess: context.product.billingMode === 'CODING_PLAN',
            cacheWriteInputTokens: normalized.cacheWriteInputTokens,
            bandAt: effectiveAt,
            // 与上面余额链路（:977）同一个口径：积分链路的基础价也按事件时刻取版本，
            // 否则模型下架后积分侧按"当前价"取价，与余额侧在价格切换点分叉。
            effectiveAt,
            ...(normalized.imageCount > 0 ? { imageCount: normalized.imageCount } : {}),
          },
        );
    const baseCreditCost = creditPricingQuote?.creditCost ?? 0;
    const creditMultiplier = new Prisma.Decimal(
      policy.creditMultiplier ?? policy.priceMultiplier,
    );
    const creditCost = Math.ceil(baseCreditCost * creditMultiplier.toNumber());
    return {
      unit,
      userId: context.user.id,
      tenantId,
      billingAccountId: context.billingAccountId ?? null,
      productId: context.product.id,
      productSlug: context.product.slug,
      modelName: normalized.modelName,
      inputTokens: normalized.inputTokens,
      outputTokens: normalized.outputTokens,
      cachedInputTokens: normalized.cachedInputTokens,
      cacheWriteInputTokens: normalized.cacheWriteInputTokens,
      imageCount: normalized.imageCount,
      callType: normalized.callType,
      upstreamModel: normalized.upstreamModel,
      pricingTierKey: creditPricingQuote?.pricingTierKey ?? null,
      subscriptionId: resolved.subscriptionId,
      entitlementKind: resolved.entitlementKind,
      codingPlanEntitlementId: resolved.codingPlanEntitlementId,
      planId: resolved.planId,
      fulfillmentMode: resolved.fulfillmentMode,
      providerEntitlementId: resolved.providerEntitlementId,
      providerLineId: resolved.providerLineId,
      providerLineCode: resolved.providerLineCode,
      providerCode: resolved.providerCode,
      upstreamProductId: resolved.upstreamProductId,
      baseCreditCost,
      creditCost: includedUpstream ? 0 : creditCost,
      includedUpstream: includedUpstream || undefined,
      ...(imagePricingQuote?.lineItems?.length
        ? { lineItems: this.toUsageBillingLineItems(imagePricingQuote.lineItems) }
        : {}),
      policy,
    };
  }

  /**
   * Values immutable correction evidence without mutating customer funds. The
   * usage dimensions come from the selected evidence while every monetary
   * rate, multiplier and entitlement comes from the first-receipt anchor.
   * Finance uses this for append-only platform-absorption receipts on requests
   * that were already settled before corrected provider evidence arrived.
   */
  async valueGatewayUsageAtFrozenPricing(
    input: UsageQuoteInput,
    settlementAnchor: GatewaySettlementAnchor,
  ): Promise<GatewayFrozenUsageValuation> {
    const normalized = this.normalizeQuoteInput(input);
    this.assertSettlementInputMatchesAnchor(normalized, settlementAnchor);
    const quote = this.frozenQuoteFromSettlementAnchor(normalized, settlementAnchor);
    const dimensions: UsageCustomerDimensions = {
      inputTokens: quote.inputTokens,
      outputTokens: quote.outputTokens,
      cachedInputTokens: quote.cachedInputTokens,
      cacheWriteInputTokens: quote.cacheWriteInputTokens,
      imageCount: quote.imageCount,
    };
    const dimensionsChanged = this.usageCustomerDimensionsChanged(
      settlementAnchor.customerQuoteSnapshot,
      dimensions,
    );
    const customerPricing = this.modelPricingFromGatewaySnapshot(
      settlementAnchor.customerPricingSnapshot.tokenUsagePricing,
      dimensionsChanged ? dimensions : undefined,
    );
    if (!customerPricing) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway frozen customer pricing 不可用于差额估值',
      );
    }
    const providerCost = this.providerCostFromGatewaySnapshot(
      settlementAnchor.providerCostSnapshot,
      dimensionsChanged ? dimensions : undefined,
    );
    const customerChargeUsd = quote.unit === 'CREDITS' && quote.includedUpstream === true
      ? new Prisma.Decimal(0)
      : quote.unit === 'BALANCE'
        ? usd(quote.effectiveCostUsd)
        : customerPricing.costUsd;
    return {
      quote,
      customerChargeUsd: customerChargeUsd.toString(),
      providerCostUsd: providerCost?.costUsd.toString() ?? null,
    };
  }

  private async calculateQuoteAtReceipt(
    normalized: NormalizedUsageQuoteInput,
    context: ResolvedContext,
    resolved: ResolvedSubscription | null,
    unit: UsageBillingUnit,
    db: Prisma.TransactionClient,
  ): Promise<{
    quote: UsageQuoteResult;
    customerPricingSnapshot: GatewayCustomerPricingSnapshot;
  }> {
    const effectiveAt = this.eventOccurredAtForSettlement(normalized);
    if (!effectiveAt) {
      throw new BadRequestException('Gateway settlement anchor 缺少 eventOccurredAt');
    }
    const tenantId = this.effectiveTenantId(context);
    const policy = await this.resolveUsagePolicy(
      context.product.id,
      normalized.modelName,
      context.user?.id ?? null,
      context.billingAccountId ?? null,
      context.billingAccountType ?? null,
      effectiveAt,
      unit,
      db,
    );

    if (unit === 'BALANCE') {
      const priceBasis = context.billingAccountType === ENTERPRISE_BILLING_ACCOUNT_TYPE
        && context.product.billingMode === 'PAY_AS_YOU_GO'
        ? 'LIST'
        : 'PRODUCT_EFFECTIVE';
      const baseQuote = await this.modelPricing.calculateCostQuote(
        normalized.modelName,
        normalized.inputTokens,
        normalized.outputTokens,
        normalized.cachedInputTokens,
        normalized.cacheWriteInputTokens,
        {
          productId: context.product.id,
          priceBasis,
          effectiveAt,
          bandAt: effectiveAt,
          ...(normalized.imageCount > 0 ? { imageCount: normalized.imageCount } : {}),
        },
        db,
      );
      const multiplier = new Prisma.Decimal(policy.priceMultiplier);
      const effectivePricing = this.applyCustomerPriceMultiplier(
        baseQuote,
        multiplier,
        normalized.inputTokens,
        normalized.outputTokens,
        normalized.cachedInputTokens,
        normalized.cacheWriteInputTokens,
      );
      const quote: BalanceQuote = {
        unit,
        userId: context.user?.id ?? null,
        tenantId,
        billingAccountId: context.billingAccountId ?? null,
        productId: context.product.id,
        productSlug: context.product.slug,
        modelName: normalized.modelName,
        inputTokens: normalized.inputTokens,
        outputTokens: normalized.outputTokens,
        cachedInputTokens: normalized.cachedInputTokens,
        cacheWriteInputTokens: normalized.cacheWriteInputTokens,
        imageCount: normalized.imageCount,
        callType: normalized.callType,
        upstreamModel: normalized.upstreamModel,
        pricingTierKey: baseQuote.pricingTierKey,
        priceBasis,
        customerPricing: {
          inputPriceUsdPerM: effectivePricing.inputPriceUsdPerM.toString(),
          cachedInputPriceUsdPerM: effectivePricing.cachedInputPriceUsdPerM?.toString() ?? null,
          cacheWritePriceUsdPerM: effectivePricing.cacheWritePriceUsdPerM?.toString() ?? null,
          outputPriceUsdPerM: effectivePricing.outputPriceUsdPerM.toString(),
        },
        baseCostUsd: baseQuote.costUsd.toString(),
        effectiveCostUsd: effectivePricing.costUsd.toString(),
        amountCents: usdToCents(effectivePricing.costUsd),
        providerCode: normalized.providerCode ?? null,
        providerLineId: normalized.providerLineId ?? null,
        ...(effectivePricing.lineItems?.length
          ? { lineItems: this.toUsageBillingLineItems(effectivePricing.lineItems) }
          : {}),
        policy,
      };
      return {
        quote,
        customerPricingSnapshot: {
          unit,
          priceBasis,
          basePricing: this.toGatewayModelPricingSnapshot(baseQuote),
          tokenUsagePricing: this.toGatewayModelPricingSnapshot(effectivePricing),
          policy,
          customerMultiplier: multiplier.toString(),
          planUsageMultiplier: null,
          modelAccessMultiplier: null,
          effectiveCostUsd: effectivePricing.costUsd.toString(),
          baseCreditCost: null,
          creditCost: null,
          includedUpstream: false,
        },
      };
    }

    if (!context.user || !resolved) {
      throw new BadRequestException('Gateway CREDITS settlement anchor 缺少冻结权益');
    }
    const includedUpstream = resolved.fulfillmentMode === 'provider_resale';
    let baseModelPricing: ModelPricingQuote | null = null;
    let modelAccessMultiplier: Prisma.Decimal | null = null;
    let baseCreditCost = 0;
    if (!includedUpstream) {
      baseModelPricing = await this.modelPricing.calculateCostQuote(
        normalized.modelName,
        normalized.inputTokens,
        normalized.outputTokens,
        normalized.cachedInputTokens,
        normalized.cacheWriteInputTokens,
        {
          bandAt: effectiveAt,
          // 锚定结算的 CREDITS 基价：effectiveAt 在本方法里是强制的
          // （eventOccurredAtForSettlement 缺失即 400），基础价必须按它取版本，
          // 不能退回"当前价"——否则模型下架会让这条链上的历史事件报不出价。
          effectiveAt,
          ...(normalized.imageCount > 0 ? { imageCount: normalized.imageCount } : {}),
        },
        db,
      );
      const requireModelAccess = context.product.billingMode === 'CODING_PLAN';
      const access = await db.modelAccess.findUnique({
        where: {
          planId_modelName: {
            planId: resolved.planId,
            modelName: normalized.modelName,
          },
        },
        select: { isActive: true, creditMultiplier: true },
      });
      if (requireModelAccess && (!access || access.isActive === false)) {
        throw new BadRequestException(`套餐未开放模型 "${normalized.modelName}"`);
      }
      modelAccessMultiplier = new Prisma.Decimal(
        access?.isActive === false ? 1 : access?.creditMultiplier ?? 1,
      );
      baseCreditCost = baseModelPricing.costUsd
        .mul(100)
        .mul(modelAccessMultiplier)
        .mul(resolved.plan.usageMultiplier)
        .ceil()
        .toNumber();
    }
    const customerMultiplier = new Prisma.Decimal(
      policy.creditMultiplier ?? policy.priceMultiplier,
    );
    const creditCost = includedUpstream
      ? 0
      : Math.ceil(baseCreditCost * customerMultiplier.toNumber());
    let tokenUsagePricing: GatewayModelPricingSnapshot;
    try {
      const pricing = await this.modelPricing.calculateCostQuote(
        normalized.modelName,
        normalized.inputTokens,
        normalized.outputTokens,
        normalized.cachedInputTokens,
        normalized.cacheWriteInputTokens,
        {
          productId: context.product.id,
          priceBasis: 'PRODUCT_EFFECTIVE',
          effectiveAt,
          // 转售（includedUpstream）红线：客户侧快照必须与开关前逐位一致，不进时段档
          ...(includedUpstream ? {} : { bandAt: effectiveAt }),
          ...(normalized.imageCount > 0 ? { imageCount: normalized.imageCount } : {}),
        },
        db,
      );
      tokenUsagePricing = this.toGatewayModelPricingSnapshot(pricing);
    } catch (err) {
      if (!includedUpstream || !(err instanceof NotFoundException)) throw err;
      tokenUsagePricing = {
        status: 'UNAVAILABLE',
        reason: 'included_upstream_customer_model_pricing_unavailable',
      };
    }
    const quote: CreditQuote = {
      unit,
      userId: context.user.id,
      tenantId,
      billingAccountId: context.billingAccountId ?? null,
      productId: context.product.id,
      productSlug: context.product.slug,
      modelName: normalized.modelName,
      inputTokens: normalized.inputTokens,
      outputTokens: normalized.outputTokens,
      cachedInputTokens: normalized.cachedInputTokens,
      cacheWriteInputTokens: normalized.cacheWriteInputTokens,
      imageCount: normalized.imageCount,
      callType: normalized.callType,
      upstreamModel: normalized.upstreamModel,
      pricingTierKey: baseModelPricing?.pricingTierKey ?? null,
      subscriptionId: resolved.subscriptionId,
      entitlementKind: resolved.entitlementKind,
      codingPlanEntitlementId: resolved.codingPlanEntitlementId,
      planId: resolved.planId,
      fulfillmentMode: resolved.fulfillmentMode,
      providerEntitlementId: resolved.providerEntitlementId,
      providerLineId: resolved.providerLineId,
      providerLineCode: resolved.providerLineCode,
      providerCode: resolved.providerCode,
      upstreamProductId: resolved.upstreamProductId,
      baseCreditCost,
      creditCost,
      includedUpstream: includedUpstream || undefined,
      ...(baseModelPricing?.lineItems?.length
        ? { lineItems: this.toUsageBillingLineItems(baseModelPricing.lineItems) }
        : {}),
      policy,
    };
    return {
      quote,
      customerPricingSnapshot: {
        unit,
        priceBasis: includedUpstream ? 'INCLUDED_UPSTREAM' : 'SUBSCRIPTION_CREDITS',
        basePricing: baseModelPricing
          ? this.toGatewayModelPricingSnapshot(baseModelPricing)
          : { status: 'NOT_APPLICABLE', reason: 'included_upstream' },
        tokenUsagePricing,
        policy,
        customerMultiplier: customerMultiplier.toString(),
        planUsageMultiplier: resolved.plan.usageMultiplier,
        modelAccessMultiplier: modelAccessMultiplier?.toString() ?? null,
        effectiveCostUsd: null,
        baseCreditCost,
        creditCost,
        includedUpstream,
      },
    };
  }

  private async resolveProviderCostSnapshotAtReceipt(
    normalized: UsageQuoteInput,
    quote: UsageQuoteResult,
    customerPricing: GatewayCustomerPricingSnapshot,
    db: Prisma.TransactionClient,
  ): Promise<GatewayProviderCostSnapshot> {
    if (quote.imageCount > 0) {
      return this.emptyProviderCostSnapshot('NOT_APPLICABLE', 'image_provider_cost_not_supported');
    }
    const providerCode = this.resolveProviderCodeForTokenUsage(
      {
        ...normalized,
        source: (normalized as UsageDeductInput).source ?? '',
      } as UsageDeductInput,
      quote,
    );
    const providerLineId = this.resolveProviderLineIdForTokenUsage(
      {
        ...normalized,
        source: (normalized as UsageDeductInput).source ?? '',
      } as UsageDeductInput,
      quote,
    );
    if (!providerCode && !providerLineId) {
      return this.emptyProviderCostSnapshot('NOT_APPLICABLE', 'provider_identity_unavailable');
    }
    let basePricing: ModelPricingQuote;
    try {
      // 供应商成本红线：所有新锚点**无条件重算**不传 bandAt 的 LIST 报价——
      // 不复用客户侧冻结快照（企业 PAYG 的 BALANCE 报价本身 priceBasis='LIST'，
      // 且 SUBSCRIPTION_CREDITS 的 basePricing 已携带时段档价；任何复用都会把
      // 空闲客户价当成本基线）。老锚点重放不进本函数，直接用已冻结 providerCostSnapshot。
      basePricing = await this.modelPricing.calculateCostQuote(
          quote.modelName,
          quote.inputTokens,
          quote.outputTokens,
          quote.cachedInputTokens,
          quote.cacheWriteInputTokens,
          {
            productId: quote.productId,
            priceBasis: 'LIST',
            effectiveAt: this.eventOccurredAtForSettlement(normalized) ?? undefined,
          },
          db,
        );
    } catch (err) {
      return this.emptyProviderCostSnapshot(
        'UNAVAILABLE',
        `provider_base_pricing_unavailable:${err instanceof Error ? err.message : String(err)}`,
      );
    }
    try {
      const providerCost = await this.providerCostPricing.quote({
        productId: quote.productId,
        providerCode,
        providerLineId,
        modelName: quote.modelName,
        inputTokens: quote.inputTokens,
        outputTokens: quote.outputTokens,
        cachedInputTokens: quote.cachedInputTokens,
        cacheWriteInputTokens: quote.cacheWriteInputTokens,
        base: basePricing,
        effectiveAt: this.eventOccurredAtForSettlement(normalized),
      }, db);
      if (!providerCost) {
        return this.emptyProviderCostSnapshot('UNAVAILABLE', 'provider_cost_policy_unavailable');
      }
      return {
        status: 'VERIFIED',
        reason: null,
        policyId: providerCost.policyId,
        providerCode: providerCost.providerCode,
        providerLineId: providerCost.providerLineId,
        productId: providerCost.productId,
        priceMultiplier: providerCost.priceMultiplier.toString(),
        inputCostUsdPerM: providerCost.inputCostUsdPerM.toString(),
        cachedInputCostUsdPerM: providerCost.cachedInputCostUsdPerM.toString(),
        cacheWriteCostUsdPerM: providerCost.cacheWriteCostUsdPerM.toString(),
        outputCostUsdPerM: providerCost.outputCostUsdPerM.toString(),
        costUsd: providerCost.costUsd.toString(),
      };
    } catch (err) {
      return this.emptyProviderCostSnapshot(
        'UNAVAILABLE',
        `provider_cost_resolution_failed:${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private frozenQuoteFromSettlementAnchor(
    normalized: UsageQuoteInput,
    anchor: GatewaySettlementAnchor,
  ): UsageQuoteResult {
    const pricingHash = createHash('sha256').update(canonicalJson({
      customerQuoteSnapshot: anchor.customerQuoteSnapshot,
      customerPricingSnapshot: anchor.customerPricingSnapshot,
      providerCostSnapshot: anchor.providerCostSnapshot,
    })).digest('hex');
    const quote = anchor.customerQuoteSnapshot;
    if (
      pricingHash !== anchor.pricingHash ||
      quote.unit !== anchor.billingUnit ||
      anchor.customerPricingSnapshot.unit !== anchor.billingUnit ||
      quote.userId !== anchor.userId ||
      quote.tenantId !== anchor.tenantId ||
      quote.billingAccountId !== anchor.billingAccountId ||
      quote.productId !== anchor.productId ||
      quote.productSlug !== anchor.productSlug ||
      quote.modelName !== normalized.modelName
    ) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway frozen pricing quote 与 anchor/input 不一致',
      );
    }
    this.assertFrozenImageLineItemsMatchOriginal(
      anchor.customerPricingSnapshot.basePricing,
      quote.imageCount,
    );
    this.assertFrozenImageLineItemsMatchOriginal(
      anchor.customerPricingSnapshot.tokenUsagePricing,
      quote.imageCount,
    );

    const dimensions: UsageCustomerDimensions = {
      inputTokens: normalized.inputTokens ?? 0,
      outputTokens: normalized.outputTokens ?? 0,
      cachedInputTokens: normalized.cachedInputTokens ?? 0,
      cacheWriteInputTokens: normalized.cacheWriteInputTokens ?? 0,
      imageCount: normalized.imageCount ?? 0,
    };
    if (!this.usageCustomerDimensionsChanged(quote, dimensions)) return quote;
    if (!Object.values(dimensions).every((value) => value === 0)) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway frozen customer quote only permits exact meters or protective zero',
      );
    }

    if (quote.unit === 'BALANCE') {
      const basePricing = this.zeroModelPricingFromGatewaySnapshot(
        anchor.customerPricingSnapshot.basePricing,
      );
      const customerPricing = this.zeroModelPricingFromGatewaySnapshot(
        anchor.customerPricingSnapshot.tokenUsagePricing,
      );
      if (!basePricing || !customerPricing || anchor.customerPricingSnapshot.includedUpstream) {
        throw new GatewaySettlementAnchorConflictError(
          'Gateway BALANCE frozen pricing 不可用',
        );
      }
      return {
        ...quote,
        ...dimensions,
        baseCostUsd: '0',
        effectiveCostUsd: '0',
        amountCents: 0,
        customerPricing: {
          inputPriceUsdPerM: customerPricing.inputPriceUsdPerM.toString(),
          cachedInputPriceUsdPerM:
            customerPricing.cachedInputPriceUsdPerM?.toString() ?? null,
          cacheWritePriceUsdPerM:
            customerPricing.cacheWritePriceUsdPerM?.toString() ?? null,
          outputPriceUsdPerM: customerPricing.outputPriceUsdPerM.toString(),
        },
        lineItems: customerPricing.lineItems?.length
          ? this.toUsageBillingLineItems(customerPricing.lineItems)
          : [],
      };
    }

    const includedUpstream = quote.includedUpstream === true;
    if (anchor.customerPricingSnapshot.includedUpstream !== includedUpstream) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway CREDITS frozen upstream 权益不一致',
      );
    }
    if (includedUpstream) {
      const basePricing = this.zeroModelPricingFromGatewaySnapshot(
        anchor.customerPricingSnapshot.basePricing,
      );
      return {
        ...quote,
        ...dimensions,
        baseCreditCost: 0,
        creditCost: 0,
        lineItems: basePricing?.lineItems?.length
          ? this.toUsageBillingLineItems(basePricing.lineItems)
          : [],
      };
    }

    const basePricing = this.zeroModelPricingFromGatewaySnapshot(
      anchor.customerPricingSnapshot.basePricing,
    );
    if (!basePricing) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway CREDITS frozen pricing 不可用',
      );
    }
    return {
      ...quote,
      ...dimensions,
      baseCreditCost: 0,
      creditCost: 0,
      lineItems: basePricing.lineItems?.length
        ? this.toUsageBillingLineItems(basePricing.lineItems)
        : [],
    };
  }

  private zeroModelPricingFromGatewaySnapshot(
    snapshot: GatewayModelPricingSnapshot,
  ): ModelPricingQuote | null {
    const pricing = this.modelPricingFromGatewaySnapshot(snapshot);
    if (!pricing) return null;
    return {
      ...pricing,
      costUsd: new Prisma.Decimal(0),
      ...(pricing.lineItems
        ? {
            lineItems: pricing.lineItems.map((lineItem) => ({
              ...lineItem,
              quantity: 0,
              amountUsd: new Prisma.Decimal(0),
            })),
          }
        : {}),
    };
  }

  private toGatewayModelPricingSnapshot(
    quote: ModelPricingQuote,
  ): GatewayModelPricingSnapshot {
    return {
      status: 'VERIFIED',
      reason: null,
      costUsd: quote.costUsd.toString(),
      pricingTierKey: quote.pricingTierKey,
      inputPriceUsdPerM: quote.inputPriceUsdPerM.toString(),
      cachedInputPriceUsdPerM: quote.cachedInputPriceUsdPerM?.toString() ?? null,
      cacheWritePriceUsdPerM: quote.cacheWritePriceUsdPerM?.toString() ?? null,
      outputPriceUsdPerM: quote.outputPriceUsdPerM.toString(),
      ...(quote.lineItems?.length ? { lineItems: this.toUsageBillingLineItems(quote.lineItems) } : {}),
    };
  }

  private modelPricingFromGatewaySnapshot(
    snapshot: GatewayModelPricingSnapshot,
    dimensions?: UsageCustomerDimensions,
  ): ModelPricingQuote | null {
    if (snapshot.status !== 'VERIFIED') return null;
    if (
      snapshot.costUsd == null || snapshot.inputPriceUsdPerM == null ||
      snapshot.outputPriceUsdPerM == null
    ) {
      throw new GatewaySettlementAnchorConflictError('Gateway frozen model pricing 缺少金额字段');
    }
    const inputPriceUsdPerM = usd(snapshot.inputPriceUsdPerM);
    const cachedInputPriceUsdPerM = snapshot.cachedInputPriceUsdPerM == null
      ? null
      : usd(snapshot.cachedInputPriceUsdPerM);
    const cacheWritePriceUsdPerM = snapshot.cacheWritePriceUsdPerM == null
      ? null
      : usd(snapshot.cacheWritePriceUsdPerM);
    const outputPriceUsdPerM = usd(snapshot.outputPriceUsdPerM);
    const lineItems = snapshot.lineItems?.length
      ? snapshot.lineItems.map((line) => ({
          meter: line.meter,
          quantity: line.quantity,
          unitPriceUsd: usd(line.unitPriceUsd),
          amountUsd: usd(line.amountUsd),
        }))
      : undefined;
    const repricedLineItems = dimensions && lineItems?.length
      ? lineItems.map((lineItem) => {
          if (lineItems.length !== 1 || lineItem.meter !== 'image') {
            throw new GatewaySettlementAnchorConflictError(
              'Gateway frozen line-item pricing contains unsupported meters',
            );
          }
          const amountUsd = lineItem.unitPriceUsd
            .mul(dimensions.imageCount)
            .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
          return {
            ...lineItem,
            quantity: dimensions.imageCount,
            amountUsd,
          };
        })
      : lineItems;
    const costUsd = dimensions && repricedLineItems?.length
      ? repricedLineItems.reduce(
          (sum, lineItem) => sum.plus(lineItem.amountUsd),
          new Prisma.Decimal(0),
        ).toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP)
      : dimensions
        ? this.costFromFrozenTokenRates(dimensions, {
          inputPriceUsdPerM,
          cachedInputPriceUsdPerM,
          cacheWritePriceUsdPerM,
          outputPriceUsdPerM,
        })
      : usd(snapshot.costUsd);
    return {
      costUsd,
      pricingTierKey: snapshot.pricingTierKey ?? null,
      inputPriceUsdPerM,
      cachedInputPriceUsdPerM,
      cacheWritePriceUsdPerM,
      outputPriceUsdPerM,
      ...(repricedLineItems ? { lineItems: repricedLineItems } : {}),
    };
  }

  private assertFrozenImageLineItemsMatchOriginal(
    snapshot: GatewayModelPricingSnapshot,
    originalImageCount: number,
  ): void {
    const lineItems = snapshot.lineItems ?? [];
    if (lineItems.length === 0) return;
    if (
      lineItems.length !== 1
      || lineItems[0]?.meter !== 'image'
      || lineItems[0].quantity !== originalImageCount
      || !Number.isSafeInteger(originalImageCount)
      || originalImageCount < 0
    ) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway frozen image line item does not match original quote quantity',
      );
    }
    try {
      const unitPriceUsd = usd(lineItems[0].unitPriceUsd);
      const amountUsd = usd(lineItems[0].amountUsd);
      const expectedAmountUsd = unitPriceUsd
        .mul(originalImageCount)
        .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
      if (unitPriceUsd.lt(0) || !amountUsd.equals(expectedAmountUsd)) {
        throw new GatewaySettlementAnchorConflictError(
          'Gateway frozen image line item amount is not reproducible',
        );
      }
    } catch (error) {
      if (error instanceof GatewaySettlementAnchorConflictError) throw error;
      throw new GatewaySettlementAnchorConflictError(
        'Gateway frozen image line item amount is invalid',
      );
    }
  }

  private usageTokenDimensionsChanged(
    original: UsageTokenDimensions,
    next: UsageTokenDimensions,
  ): boolean {
    return original.inputTokens !== next.inputTokens ||
      original.outputTokens !== next.outputTokens ||
      original.cachedInputTokens !== next.cachedInputTokens ||
      original.cacheWriteInputTokens !== next.cacheWriteInputTokens;
  }

  private usageCustomerDimensionsChanged(
    original: UsageCustomerDimensions,
    next: UsageCustomerDimensions,
  ): boolean {
    return this.usageTokenDimensionsChanged(original, next)
      || original.imageCount !== next.imageCount;
  }

  private costFromFrozenTokenRates(
    dimensions: UsageTokenDimensions,
    rates: Pick<
      ModelPricingQuote,
      | 'inputPriceUsdPerM'
      | 'cachedInputPriceUsdPerM'
      | 'cacheWritePriceUsdPerM'
      | 'outputPriceUsdPerM'
    >,
  ): Prisma.Decimal {
    const safeCachedInputTokens = Math.min(
      Math.max(0, dimensions.cachedInputTokens),
      dimensions.inputTokens,
    );
    const safeCacheWriteInputTokens = Math.min(
      Math.max(0, dimensions.cacheWriteInputTokens),
      dimensions.inputTokens - safeCachedInputTokens,
    );
    const regularInputTokens = dimensions.inputTokens
      - safeCachedInputTokens
      - safeCacheWriteInputTokens;
    return new Prisma.Decimal(regularInputTokens)
      .mul(rates.inputPriceUsdPerM)
      .plus(new Prisma.Decimal(safeCachedInputTokens).mul(
        rates.cachedInputPriceUsdPerM ?? rates.inputPriceUsdPerM,
      ))
      .plus(new Prisma.Decimal(safeCacheWriteInputTokens).mul(
        rates.cacheWritePriceUsdPerM ?? rates.inputPriceUsdPerM,
      ))
      .plus(new Prisma.Decimal(dimensions.outputTokens).mul(rates.outputPriceUsdPerM))
      .div(1_000_000)
      .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
  }

  private frozenNonNegativeMultiplier(
    value: Prisma.Decimal.Value,
    label: string,
  ): Prisma.Decimal {
    let multiplier: Prisma.Decimal;
    try {
      multiplier = new Prisma.Decimal(value);
    } catch {
      throw new GatewaySettlementAnchorConflictError(
        `Gateway frozen ${label} multiplier 无效`,
      );
    }
    if (!multiplier.isFinite() || multiplier.lt(0)) {
      throw new GatewaySettlementAnchorConflictError(
        `Gateway frozen ${label} multiplier 无效`,
      );
    }
    return multiplier;
  }

  private providerCostFromGatewaySnapshot(
    snapshot: GatewayProviderCostSnapshot,
    dimensions?: UsageTokenDimensions,
  ) {
    if (snapshot.status !== 'VERIFIED') return null;
    if (
      snapshot.policyId == null || snapshot.priceMultiplier == null ||
      snapshot.inputCostUsdPerM == null || snapshot.cachedInputCostUsdPerM == null ||
      snapshot.cacheWriteCostUsdPerM == null || snapshot.outputCostUsdPerM == null ||
      snapshot.costUsd == null
    ) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway frozen provider cost 缺少金额字段',
      );
    }
    const inputCostUsdPerM = usd(snapshot.inputCostUsdPerM);
    const cachedInputCostUsdPerM = usd(snapshot.cachedInputCostUsdPerM);
    const cacheWriteCostUsdPerM = usd(snapshot.cacheWriteCostUsdPerM);
    const outputCostUsdPerM = usd(snapshot.outputCostUsdPerM);
    return {
      policyId: snapshot.policyId,
      priceMultiplier: usd(snapshot.priceMultiplier),
      inputCostUsdPerM,
      cachedInputCostUsdPerM,
      cacheWriteCostUsdPerM,
      outputCostUsdPerM,
      costUsd: dimensions
        ? this.costFromFrozenTokenRates(dimensions, {
            inputPriceUsdPerM: inputCostUsdPerM,
            cachedInputPriceUsdPerM: cachedInputCostUsdPerM,
            cacheWritePriceUsdPerM: cacheWriteCostUsdPerM,
            outputPriceUsdPerM: outputCostUsdPerM,
          })
        : usd(snapshot.costUsd),
    };
  }

  private emptyProviderCostSnapshot(
    status: 'NOT_APPLICABLE' | 'UNAVAILABLE',
    reason: string,
  ): GatewayProviderCostSnapshot {
    return {
      status,
      reason,
      policyId: null,
      providerCode: null,
      providerLineId: null,
      productId: null,
      priceMultiplier: null,
      inputCostUsdPerM: null,
      cachedInputCostUsdPerM: null,
      cacheWriteCostUsdPerM: null,
      outputCostUsdPerM: null,
      costUsd: null,
    };
  }

  async authorize(
    input: UsageQuoteInput & { requestId?: string },
    settlementAnchor?: GatewaySettlementAnchor,
    pricingAt?: Date,
  ): Promise<UsageAuthorizeResult> {
    return timed('stlAuthorize', () => this.authorizeInner(input, settlementAnchor, pricingAt));
  }

  private async authorizeInner(
    input: UsageQuoteInput & { requestId?: string },
    settlementAnchor?: GatewaySettlementAnchor,
    pricingAt?: Date,
  ): Promise<UsageAuthorizeResult> {
    const quote = await this.quote(input, settlementAnchor, pricingAt);
    if (!quote.userId) {
      return { allowed: false, reason: 'user_required', quote };
    }

    if (quote.unit === 'BALANCE') {
      if (settlementAnchor) {
        // Admission already happened at T0. The immutable reservation, not a
        // T2 membership/key lookup or mutable balance report, governs this
        // delivered request's settlement.
        return { allowed: true, quote };
      }
      const balanceReport = await this.billingService.getBalanceReportForUser(quote.userId, {
        tenantId: quote.tenantId,
      });
      const pendingHoldUsd = quote.billingAccountId
        ? await this.pendingGatewayUsageHoldUsd(quote.billingAccountId, input.requestId)
        : new Prisma.Decimal(0);
      const balanceUsd = usd(balanceReport.balanceUsd).minus(pendingHoldUsd);
      const isEnterpriseAccount = balanceReport.billingAccountType === 'enterprise';
      const policy = isEnterpriseAccount
        ? null
        : await this.creditPolicy.resolvePolicyForUser(
            quote.userId,
            quote.productId,
          );
      const limitUsd = policy?.allowOverdraft
        ? centsToUsd(policy.creditLimitCents)
        : new Prisma.Decimal(0);
      const costUsd = usd(quote.effectiveCostUsd);
      const projected = balanceUsd.minus(costUsd);
      const allowed = projected.gte(limitUsd.neg());
      return {
        allowed,
        reason: allowed ? undefined : 'insufficient_balance',
        quote,
        balanceCents: usdToCents(balanceUsd),
        projectedBalanceCents: usdToCents(projected),
        creditLimitCents: isEnterpriseAccount
          ? balanceReport.creditLimitCents
          : policy?.allowOverdraft ? policy.creditLimitCents : 0,
      };
    }

    if (quote.includedUpstream) {
      return {
        allowed: true,
        quote,
        quotaCredits: 0,
        bonusCredits: 0,
        grantCredits: 0,
        totalCredits: 0,
      };
    }

    const balances = await this.creditService.getAuthoritativeBalances(
      quote.subscriptionId,
      quote.userId,
    );
    const creditFields = {
      quotaCredits: balances.quota,
      bonusCredits: balances.bonus,
      grantCredits: balances.grant ?? 0,
      totalCredits: balances.total,
    };
    if (balances.total < quote.creditCost) {
      return { allowed: false, reason: 'insufficient_credits', quote, ...creditFields };
    }
    if (settlementAnchor) {
      // Rolling quota is an admission control. Re-evaluating it at T2 against
      // a changed window or changed rules would erase an already-delivered T0
      // cost. The frozen entitlement/plan and authoritative balance still
      // govern whether this settles normally or through DEBT_OPEN above.
      return { allowed: true, quote, ...creditFields };
    }
    // A 前置（quota-v2 §4.3）：套餐积分充足后，再判滚动窗口配额（5h/7d…），任一超限即拒。
    const gate = await this.checkRollingQuotaGate(quote);
    if (!gate.allowed) {
      return {
        allowed: false,
        reason: 'rolling_quota_exhausted',
        quote,
        ...creditFields,
        quotaGate: gate.detail,
      };
    }
    return { allowed: true, quote, ...creditFields };
  }

  private async pendingGatewayUsageHoldUsd(
    billingAccountId: string,
    settlingRequestId?: string,
  ): Promise<Prisma.Decimal> {
    // This helper serves the explicit admin authorize/deduct path. Gateway
    // request admission uses Publisher's atomic reservation + provisional-guard
    // snapshot, and delivered Gateway settlement supplies an anchor and bypasses
    // mutable re-authorization above. Here only an immutable live reservation
    // reduces spendable balance; legacy parent-event pendingHoldUsd mixed
    // provider evidence review with customer funds and could freeze unrelated
    // requests indefinitely.
    const reservations = await this.prisma.gatewayUsageFundingReservation.aggregate({
      where: {
        billingAccountId,
        status: { in: ['ACTIVE', 'MANUAL_REVIEW'] },
        ...(settlingRequestId ? { requestId: { not: settlingRequestId } } : {}),
      },
      _sum: { reservedAmountUsd: true },
    });
    return usd(reservations._sum.reservedAmountUsd ?? 0);
  }

  /**
   * 滚动窗口配额 gate（quota-v2 §4.3，A 侧判定）：对该套餐全部 enforced 滚动规则循环判定，
   * REQUESTS 计 +1、CREDITS 计 +creditCost，任一「窗口已用量 + 本次增量 > 上限」即拒。
   * 订阅级共享池口径（windowUsage 按 subscriptionId 聚合）；总开关关闭时直接放行。
   *
   * 执行姿态（诚实点）：网关用 Kafka usage_events 结算（请求已服务后回传），billing 在 deduct
   * 消费事件时经 authorize 跑本 gate——超限即拒、本次不扣费（deduct 提前返回）。这是**结算时前置**，
   * 拦得住「计费」，拦不住「已服务的本次请求」。要让超限请求在网关层被**请求前**硬阻断，需 B 关闸：
   * 配额耗尽时翻转 key 的 gw:key_balance(has_balance=false) + 窗口滑动后解封调度——见 P1-C。
   * 超放上界 = 并发在途数 × 单请求成本（无原子预占，§4.3 明确接受）。
   */
  private async checkRollingQuotaGate(
    quote: {
      subscriptionId?: string | null;
      planId?: string | null;
      creditCost: number;
      fulfillmentMode?: string | null;
      entitlementKind?: string | null;
    },
  ): Promise<{ allowed: boolean; detail?: { metric: string; windowSec: number; limit: number; used: number } }> {
    if (!rollingQuotaGateEnabled()) return { allowed: true };
    // 显式自营守卫（双保险，与 B 闸/展示口径一致）：滚动 gate 仅对**自营 CodingPlan entitlement** 生效；
    // 转售(provider_resale，额度随上游)与通用 SUBSCRIPTION/PAYG 一律放行，不受本套餐滚动配额约束。
    if (quote.entitlementKind !== 'coding_plan_entitlement' || quote.fulfillmentMode === 'provider_resale') {
      return { allowed: true };
    }
    const subscriptionId = quote.subscriptionId ?? null;
    const planId = quote.planId ?? null;
    if (!subscriptionId || !planId) return { allowed: true };
    const rules = await this.loadEnforcedRollingRules(planId);
    if (rules.length === 0) return { allowed: true };
    const nowMs = Date.now();
    for (const rule of rules) {
      const since = new Date(nowMs - rule.durationSec * 1000);
      const used = await this.creditService.windowUsage(
        subscriptionId,
        rule.metric as 'REQUESTS' | 'CREDITS',
        since,
      );
      // me/rolling-quota-gate-predicate-fix.md：改「会超就拒(前瞻 used+increment>limit)」为「已达/超才拒(used>=limit)」。
      // 前瞻式会把 used 冻结在 limit 之下，使 B 闸(publisher evaluateExhaustion 的 used>=limit)永不触发 →
      // has_balance 永不翻 false → 网关不拦 → 超限后免费放行。改为 used>=limit 后，允许「最后一次/在途并发」
      // 把 used 推到/越过 limit（小额过冲，上界=结算延迟窗口内通过且未被 has_balance 拦的请求成本），
      // 计数器真正抵达阈值 → B 闸随即触发 → has_balance=false 下发 → 网关请求前拦。两闸口径统一为 used>=limit。
      // 仅自营分支（转售/PAYG/通用已在上方 410 提前放行，零影响）。
      if (used >= rule.limitValue) {
        return {
          allowed: false,
          detail: { metric: rule.metric, windowSec: rule.durationSec, limit: rule.limitValue, used },
        };
      }
    }
    return { allowed: true };
  }

  /** 读取套餐 enforced 滚动规则（5min 缓存，cpq:rules:{planId}）。仅在总开关开启时调用。 */
  private async loadEnforcedRollingRules(planId: string): Promise<PlanQuotaRuleView[]> {
    const cacheKey = `cpq:rules:${planId}`;
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) return JSON.parse(cached) as PlanQuotaRuleView[];
    } catch {
      /* 缓存读失败回源 DB */
    }
    const plan = await this.prisma.plan.findUnique({
      where: { id: planId },
      select: {
        quotaRules: {
          where: { isActive: true },
          select: {
            template: { select: { rules: true, isActive: true, deletedAt: true } },
          },
        },
      },
    });
    const views = resolvePlanQuotaRuleViews(
      plan?.quotaRules ?? [],
      (msg) => this.logger.warn(msg),
      { gateEnabled: true },
    ).filter((v) => v.enforced);
    try {
      await this.redis.set(cacheKey, JSON.stringify(views), 'EX', 300);
    } catch {
      /* 缓存写失败不影响判定 */
    }
    return views;
  }

  async deduct(input: UsageDeductInput): Promise<Record<string, unknown>> {
    return this.deductInternal(input, false);
  }

  /**
   * Settles a usage event after Gateway has delivered its upstream response.
   * Only GatewayRequestEventBillingService may use this path; ordinary usage
   * admission and admin deduction remain bounded by the available balance.
   */
  async settleDeliveredGatewayUsage(
    input: UsageDeductInput,
    settlementContext?: GatewaySettlementContext,
  ): Promise<Record<string, unknown>> {
    if (!this.eventOccurredAtForSettlement(input)) {
      throw new BadRequestException('已交付 Gateway 用量结算必须提供 eventOccurredAt');
    }
    if (!settlementContext) {
      throw new BadRequestException('已交付 Gateway 用量结算必须提供首次收件 settlement anchor');
    }
    this.assertSettlementInputMatchesAnchor(input, settlementContext.anchor);
    const canonicalInput = this.canonicalGatewayCustomerSettlementInput(
      input,
      settlementContext.anchor,
    );
    return this.deductInternal(canonicalInput, true, settlementContext);
  }

  /**
   * Sub-stage probes (2026-08-31). settleUsage measured 1411ms of a 2416ms
   * message on the hot partition — up from 728ms three days earlier, making it
   * the largest single stage, and RDS slow logs cannot attribute it: COMMIT >=1s
   * fires on only ~6% of hot-partition messages, so a 1411ms *median* has to be
   * built from sub-second statements below log_min_duration_statement.
   *
   * Probes are placed inside the shared callees rather than at each call site,
   * so one delegate covers every caller and the reserveFunding path gets
   * decomposed by the same change. Self-time accounting handles the nesting;
   * read every stage as selfMs/count, never as a share of total.
   */
  private async deductInternal(
    input: UsageDeductInput,
    trustedDeliveredGatewayUsage: boolean,
    settlementContext?: GatewaySettlementContext,
  ): Promise<Record<string, unknown>> {
    if (!input.idempotencyKey?.trim()) {
      throw new BadRequestException('idempotencyKey 必填');
    }
    if (!input.source?.trim()) {
      throw new BadRequestException('source 必填');
    }
    // 无锚点链路的计价时刻在**函数入口（首个 await 之前）冻结一次**并贯穿
    // quote/积分报价/落账——若在幂等锁等多次 IO 之后才取 now，请求进入函数后
    // 跨过峰谷边界会按边界后的档计价，不符合"调用入口时刻"口径。
    const pricingAt = this.eventOccurredAtForSettlement(input) ?? new Date();

    // This is debt recognition after a strictly verified upstream delivery,
    // not admission credit. Ordinary deduct() remains bounded by balance and
    // approved enterprise credit; only the dedicated Gateway settlement path
    // may book an overage and immediately close the account.
    const allowTerminalSettlement = trustedDeliveredGatewayUsage;
    const settlementFingerprint = settlementContext
      ? this.gatewaySettlementFingerprint(input, settlementContext)
      : null;
    if (settlementContext && settlementFingerprint) {
      const financialReplay = await this.findGatewayFinancialReceiptReplay(
        input,
        settlementContext,
        settlementFingerprint,
      );
      if (financialReplay) {
        await this.syncPublisherAfterUsageDeduct(input.apiKeyId, financialReplay, true);
        return financialReplay;
      }
      await this.assertGatewaySettlementFinancialTarget(
        this.prisma,
        settlementContext.anchor,
        false,
      );
    }
    const cached = await this.getCommittedIdempotency(input.idempotencyKey);
    if (cached) {
      if (settlementContext) {
        // A finite-TTL general idempotency row is not a financial proof. A
        // trusted Gateway replay may return only the permanent receipt.
        throw new GatewaySettlementAnchorConflictError(
          'Gateway settlement 缺少永久资金回执，已停止自动重放',
        );
      }
      await this.syncPublisherAfterUsageDeduct(
        input.apiKeyId,
        cached,
        allowTerminalSettlement,
      );
      return cached;
    }

    const lockKey = billingUsageDeductLockKey(input.idempotencyKey);
    const lock = await timed(
      'stlIdemLock',
      () => this.redis.set(lockKey, '1', 'EX', USAGE_DEDUCT_LOCK_SECONDS, 'NX'),
    );
    if (lock === null) {
      const replay = await this.waitForCommittedIdempotency(input.idempotencyKey);
      if (replay) {
        if (settlementContext && settlementFingerprint) {
          const permanentReplay = await this.findGatewayFinancialReceiptReplay(
            input,
            settlementContext,
            settlementFingerprint,
          );
          if (!permanentReplay) {
            throw new GatewaySettlementAnchorConflictError(
              'Gateway settlement 临时幂等结果缺少永久资金回执',
            );
          }
          await this.syncPublisherAfterUsageDeduct(input.apiKeyId, permanentReplay, true);
          return permanentReplay;
        }
        await this.syncPublisherAfterUsageDeduct(
          input.apiKeyId,
          replay,
          allowTerminalSettlement,
        );
        return replay;
      }
      return { success: false, allowed: false, reason: 'idempotency_in_progress' };
    }

    try {
      const auth = await this.authorize(input, settlementContext?.anchor, pricingAt);
      // 积分侧负额扣减仅保留给既有自营套餐灰度路径。其它已交付可信用量若
      // 积分不足，不篡改积分余额，而是持久化 TokenUsage/供应商成本并返回
      // DEBT_OPEN，由 Gateway 对账事件关闭对应账务主体。
      const quoteEntitlement = auth.quote as {
        entitlementKind?: string | null;
        fulfillmentMode?: string | null;
      };
      const allowNegativeCredits =
        allowTerminalSettlement
        && selfopNegativeDeductEnabled()
        && quoteEntitlement.entitlementKind === 'coding_plan_entitlement'
        && quoteEntitlement.fulfillmentMode === 'platform_model_package';
      if (
        trustedDeliveredGatewayUsage &&
        !auth.allowed &&
        auth.quote.unit === 'CREDITS' &&
        auth.reason === 'insufficient_credits' &&
        !allowNegativeCredits
      ) {
        if (!settlementContext || !settlementFingerprint) {
          throw new BadRequestException('Gateway CREDITS debt settlement 缺少永久回执上下文');
        }
        const debt = await this.recordDeliveredCreditsDebt(
          input,
          auth.quote,
          settlementContext,
          settlementFingerprint,
        );
        await this.syncPublisherAfterUsageDeduct(input.apiKeyId, debt, true);
        return debt;
      }
      if (!auth.allowed) {
        // 终态结算豁免：已交付的可信用量在「余额不足」时不在此拦截，继续走结算——
        // BALANCE 侧为既有行为；CREDITS 侧仅限 R6 负额许可成立时（insufficient_credits），
        // 真正的闸门在 credit.service.deduct 的 mutate 内（available>0 && quota>=0 锁下权威判定）。
        // rolling_quota_exhausted 等其它拒绝原因不豁免，照旧拦截。
        const terminalSettlementExempt =
          (allowTerminalSettlement &&
            auth.quote.unit === 'BALANCE' &&
            auth.reason === 'insufficient_balance') ||
          (allowNegativeCredits &&
            auth.quote.unit === 'CREDITS' &&
            auth.reason === 'insufficient_credits');
        if (!terminalSettlementExempt) {
          this.schedulePublisherKeyBalanceSync(input.apiKeyId);
          return {
            success: false,
            allowed: false,
            reason: auth.reason,
            quote: auth.quote,
          };
        }
      }

      if (!auth.allowed) {
        this.logger.warn(
          `delivered gateway usage continuing with terminal settlement key=${input.apiKeyId ?? ''} request=${input.requestId ?? ''}`,
        );
      }

      const idempotencyClaim = await this.beginPendingIdempotency(
        input.idempotencyKey,
        auth.quote.userId,
      );
      if (idempotencyClaim.replay) {
        if (settlementContext && settlementFingerprint) {
          const permanentReplay = await this.findGatewayFinancialReceiptReplay(
            input,
            settlementContext,
            settlementFingerprint,
          );
          if (!permanentReplay) {
            throw new GatewaySettlementAnchorConflictError(
              'Gateway settlement 临时幂等结果缺少永久资金回执',
            );
          }
          await this.syncPublisherAfterUsageDeduct(input.apiKeyId, permanentReplay, true);
          return permanentReplay;
        }
        await this.syncPublisherAfterUsageDeduct(
          input.apiKeyId,
          idempotencyClaim.replay,
          allowTerminalSettlement,
        );
        return idempotencyClaim.replay;
      }
      if (!idempotencyClaim.acquired) {
        return { success: false, allowed: false, reason: 'idempotency_in_progress' };
      }

      let response: Record<string, unknown>;
      if (auth.quote.unit === 'BALANCE') {
        const balanceQuote = auth.quote;
        const legacyFundingPolicyAt = allowTerminalSettlement && !settlementContext
          ? this.eventOccurredAtForSettlement(input) ?? undefined
          : undefined;
        let committedResponse: Record<string, unknown> | null = null;
        // The money movement. Its self time is the part of the balance path that
        // none of the inner probes (dedTxn, walletLock, ledAssert, …) covers.
        const result = await timed('stlDeduct', () => this.billingService.deduct(
          balanceQuote.userId!,
          balanceQuote.effectiveCostUsd,
          input.source,
          {
            ...(settlementContext
              ? {
                  operationKey: `gateway:ledger:${settlementContext.anchor.requestId}:${settlementContext.anchor.anchorHash}`,
                  anchoredTenantId: settlementContext.anchor.tenantId,
                  anchoredBillingAccountId: settlementContext.anchor.billingAccountId,
                  frozenGatewaySubject: {
                    userId: settlementContext.anchor.userId,
                    tenantId: settlementContext.anchor.tenantId,
                    billingAccountId: settlementContext.anchor.billingAccountId,
                  },
                  validateAnchoredSubject: (tx: Prisma.TransactionClient) =>
                    this.assertGatewaySettlementFinancialTarget(
                      tx,
                      settlementContext.anchor,
                      true,
                    ),
                  fundingReservation: {
                    requestId: settlementContext.anchor.requestId,
                    anchorHash: settlementContext.anchor.anchorHash,
                    gatewayBillingEventId: settlementContext.gatewayBillingEventId,
                    evidenceHash: settlementContext.evidenceHash,
                    reconciliationActionId:
                      settlementContext.fundingReservationOverrideActionId,
                  },
                }
              : {}),
            productId: balanceQuote.productId,
            tenantId: balanceQuote.tenantId,
            allowNegativeBalance: false,
            allowTerminalSettlement,
            ...(settlementContext
              ? {
                  fundingPolicyOccurrence: {
                    gatewayStartAt: settlementContext.anchor.occurredAt,
                    firstReceivedAt: settlementContext.anchor.firstReceivedAt,
                  },
                }
              : legacyFundingPolicyAt ? { fundingPolicyAt: legacyFundingPolicyAt } : {}),
            beforeBalanceTransaction: async (tx, funding) => {
              const tokenUsageId = await this.recordTokenUsageIfRequested(
                input,
                balanceQuote,
                tx,
                funding,
                settlementContext?.anchor,
                pricingAt,
              );
              return { tokenUsageId };
            },
            afterBalanceTransaction: async (tx, snapshot, context) => {
              const approvedCreditDueAt = context.approvedCreditUsd.gt(0)
                && context.fundingPolicy.termsDays !== null
                && context.fundingPolicy.termsDays > 0
                ? new Date(
                    context.fundingPolicy.policyAt.getTime()
                    + context.fundingPolicy.termsDays * 24 * 60 * 60 * 1_000,
                  )
                : null;
              const fundingOutcome = context.debtOpen
                ? 'DEBT_OPEN'
                : context.approvedCreditUsd.gt(0)
                  ? 'RECEIVABLE'
                  : 'COLLECTED';
              const committedQuote: BalanceQuote = {
                ...balanceQuote,
                tenantId: context.tenantId,
                billingAccountId: context.billingAccountId,
              };
              const baseResponse: Record<string, unknown> = {
                success: true,
                allowed: true,
                unit: balanceQuote.unit,
                // Publisher closure must follow the account that the wallet
                // transaction actually locked, not an earlier quote snapshot.
                quote: committedQuote,
                balanceCentsAfter: usdToCents(snapshot.workspaceBalanceUsd),
                balanceUsdAfter: usdNumber(snapshot.workspaceBalanceUsd),
                fundingOutcome,
                fundingBreakdown: {
                  collectedUsd: context.collectedUsd.toString(),
                  approvedCreditUsd: context.approvedCreditUsd.toString(),
                  unapprovedDebtUsd: context.unapprovedDebtUsd.toString(),
                  debtExposureUsd: context.debtExposureUsd.toString(),
                  approvedCreditTermsDays: context.approvedCreditUsd.gt(0)
                    ? context.fundingPolicy.termsDays
                    : null,
                  approvedCreditDueAt: approvedCreditDueAt?.toISOString() ?? null,
                },
                ...(allowTerminalSettlement ? { terminalSettlement: true } : {}),
                ...(allowTerminalSettlement && snapshot.billingAccountType === 'enterprise'
                  ? {
                      fundingPolicy: {
                        accountType: snapshot.billingAccountType,
                        policyAt: context.fundingPolicy.policyAt.toISOString(),
                        policyRevision: context.fundingPolicy.policyRevision,
                        source: context.fundingPolicy.source,
                        reconstructible: context.fundingPolicy.reconstructible,
                        limitUsd: context.fundingPolicy.limitUsd.toString(),
                        status: context.fundingPolicy.status,
                        configuredTermsDays: context.fundingPolicy.termsDays,
                        termsDays: context.fundingPolicy.limitUsd.gt(0)
                          ? context.fundingPolicy.termsDays
                          : null,
                        effectiveAt: context.fundingPolicy.effectiveAt?.toISOString() ?? null,
                        expiresAt: context.fundingPolicy.expiresAt?.toISOString() ?? null,
                      },
                    }
                  : {}),
                ...(context.debtOpen
                  ? {
                      debtOpen: true,
                      debtExposureUsd: context.debtExposureUsd.toString(),
                    }
                  : {}),
              };
              const tokenUsageId = context.tokenUsageId;
              committedResponse = tokenUsageId
                ? { ...baseResponse, tokenUsageId }
                : baseResponse;
              if (settlementContext && settlementFingerprint) {
                await this.persistGatewayFinancialReceipt(
                  tx,
                  input,
                  settlementContext,
                  settlementFingerprint,
                  committedResponse,
                  tokenUsageId,
                );
              }
              await this.commitIdempotency(
                input.idempotencyKey,
                balanceQuote.userId,
                committedResponse,
                tx,
              );
            },
          },
        ));
        if (!result.success) {
          const rejected = {
            success: false,
            allowed: false,
            reason: 'insufficient_balance',
            quote: balanceQuote,
            balanceCents: result.balance,
            balanceUsd: result.balanceUsd,
          };
          await this.commitIdempotency(input.idempotencyKey, balanceQuote.userId, rejected);
          this.schedulePublisherKeyBalanceSync(input.apiKeyId);
          return rejected;
        }
        response = {
          success: true,
          allowed: true,
          unit: balanceQuote.unit,
          quote: balanceQuote,
          balanceCentsAfter: result.balance,
          balanceUsdAfter: result.balanceUsd,
          ...(allowTerminalSettlement ? { terminalSettlement: true } : {}),
        };
        if (committedResponse) {
          response = committedResponse;
        } else {
          await this.commitIdempotency(input.idempotencyKey, balanceQuote.userId, response);
        }
      } else if (auth.quote.includedUpstream) {
        const responseBase: Record<string, unknown> = {
          success: true,
          allowed: true,
          unit: auth.quote.unit,
          quote: auth.quote,
          upstreamIncluded: true,
        };
        let committedResponse: Record<string, unknown> | null = null;
        await this.prisma.$transaction(async (tx) => {
          if (settlementContext) {
            await this.assertGatewaySettlementFinancialTarget(
              tx,
              settlementContext.anchor,
              true,
            );
          }
          const tokenUsageId = await this.recordTokenUsageIfRequested(
            input,
            auth.quote,
            tx,
            'SETTLED',
            settlementContext?.anchor,
            pricingAt,
          );
          committedResponse = tokenUsageId ? { ...responseBase, tokenUsageId } : responseBase;
          if (settlementContext && settlementFingerprint) {
            await this.persistGatewayFinancialReceipt(
              tx,
              input,
              settlementContext,
              settlementFingerprint,
              committedResponse,
              tokenUsageId,
            );
          }
          await this.commitIdempotency(
            input.idempotencyKey,
            auth.quote.userId,
            committedResponse,
            tx,
          );
        });
        response = committedResponse ?? responseBase;
      } else if (
        auth.quote.creditCost === 0
        && settlementContext
        && settlementFingerprint
      ) {
        // CreditService intentionally returns early for amount <= 0 and does
        // not execute its transaction callbacks. A Gateway settlement still
        // needs an atomic TokenUsage + permanent receipt so a crash before the
        // parent transition can replay from durable financial state. Persist
        // that zero-credit terminal directly without mutating credit balance.
        const creditMutationIdempotencyKey =
          `gateway:credits:${settlementContext.anchor.requestId}:${settlementContext.anchor.anchorHash}`;
        const responseBase: Record<string, unknown> = {
          success: true,
          allowed: true,
          unit: auth.quote.unit,
          quote: auth.quote,
          fundingOutcome: 'INCLUDED',
          reason: 'zero_priced_credits',
          quotaCreditsAfter: auth.quotaCredits ?? 0,
          bonusCreditsAfter: auth.bonusCredits ?? 0,
          grantCreditsAfter: auth.grantCredits ?? 0,
          totalCreditsAfter: auth.totalCredits ?? 0,
          zeroCreditCharge: {
            protocol: 'gateway-credits-zero-charge-v1',
            creditMutationIdempotencyKey,
          },
        };
        let committedResponse: Record<string, unknown> | null = null;
        await this.prisma.$transaction(async (tx) => {
          await this.assertGatewaySettlementFinancialTarget(
            tx,
            settlementContext.anchor,
            true,
          );
          const tokenUsageId = await this.recordTokenUsageIfRequested(
            input,
            auth.quote,
            tx,
            'ZERO_CREDITS',
            settlementContext.anchor,
            pricingAt,
          );
          if (!tokenUsageId) {
            throw new GatewaySettlementAnchorConflictError(
              'Gateway zero-credit settlement requires durable TokenUsage',
            );
          }
          committedResponse = { ...responseBase, tokenUsageId };
          await this.persistGatewayFinancialReceipt(
            tx,
            input,
            settlementContext,
            settlementFingerprint,
            committedResponse,
            tokenUsageId,
          );
          await this.commitIdempotency(
            input.idempotencyKey,
            auth.quote.userId,
            committedResponse,
            tx,
          );
        });
        response = committedResponse ?? responseBase;
      } else {
        let committedResponse: Record<string, unknown> | null = null;
        const result = await this.creditService.deduct(
          auth.quote.subscriptionId,
          auth.quote.userId,
          auth.quote.creditCost,
          input.source,
          auth.quote.modelName,
          {
            inputTokens: auth.quote.inputTokens,
            outputTokens: auth.quote.outputTokens,
            totalTokens: auth.quote.inputTokens + auth.quote.outputTokens,
            cachedInputTokens: auth.quote.cachedInputTokens,
            requestId: input.requestId,
          },
          {
            allowNegativeBalance: allowNegativeCredits,
            idempotencyKey: settlementContext
              ? `gateway:credits:${settlementContext.anchor.requestId}:${settlementContext.anchor.anchorHash}`
              : input.idempotencyKey,
            ...(settlementContext
              ? {
                  beforeCreditTransaction: (tx: Prisma.TransactionClient) =>
                    this.assertGatewaySettlementFinancialTarget(
                      tx,
                      settlementContext.anchor,
                      true,
                    ),
                }
              : {}),
            afterCreditTransaction: async (tx, snapshot) => {
              const baseResponse: Record<string, unknown> = {
                success: true,
                allowed: true,
                unit: auth.quote.unit,
                quote: auth.quote,
                quotaCreditsAfter: snapshot.quotaAfter,
                bonusCreditsAfter: snapshot.bonusAfter,
                grantCreditsAfter: snapshot.grantAfter,
                totalCreditsAfter: snapshot.quotaAfter + snapshot.bonusAfter + snapshot.grantAfter,
              };
              const tokenUsageId = await this.recordTokenUsageIfRequested(
                input,
                auth.quote,
                tx,
                'SETTLED',
                settlementContext?.anchor,
                pricingAt,
              );
              committedResponse = tokenUsageId
                ? { ...baseResponse, tokenUsageId }
                : baseResponse;
              if (settlementContext && settlementFingerprint) {
                await this.persistGatewayFinancialReceipt(
                  tx,
                  input,
                  settlementContext,
                  settlementFingerprint,
                  committedResponse,
                  tokenUsageId,
                );
              }
              await this.commitIdempotency(
                input.idempotencyKey,
                auth.quote.userId,
                committedResponse,
                tx,
              );
            },
          },
        );
        if (!result.success) {
          if (settlementContext && settlementFingerprint && allowTerminalSettlement) {
            const debt = await this.recordDeliveredCreditsDebt(
              input,
              auth.quote,
              settlementContext,
              settlementFingerprint,
              true,
            );
            await this.syncPublisherAfterUsageDeduct(input.apiKeyId, debt, true);
            return debt;
          }
          const rejected = {
            success: false,
            allowed: false,
            reason: 'insufficient_credits',
            quote: auth.quote,
            quotaCreditsAfter: result.quota,
            bonusCreditsAfter: result.bonus,
            grantCreditsAfter: result.grant ?? 0,
          };
          await this.commitIdempotency(input.idempotencyKey, auth.quote.userId, rejected);
          this.schedulePublisherKeyBalanceSync(input.apiKeyId);
          return rejected;
        }
        response = {
          success: true,
          allowed: true,
          unit: auth.quote.unit,
          quote: auth.quote,
          quotaCreditsAfter: result.quota,
          bonusCreditsAfter: result.bonus,
          grantCreditsAfter: result.grant ?? 0,
          totalCreditsAfter: result.quota + result.bonus + (result.grant ?? 0),
        };
        if (committedResponse) {
          response = committedResponse;
        } else {
          await this.commitIdempotency(input.idempotencyKey, auth.quote.userId, response);
        }
      }

      await this.syncPublisherAfterUsageDeduct(
        input.apiKeyId,
        response,
        allowTerminalSettlement,
      );
      return response;
    } catch (err) {
      await this.releasePendingIdempotency(input.idempotencyKey, err);
      throw err;
    } finally {
      await this.redis.del(lockKey).catch(() => {});
    }
  }

  async listPolicies(productId?: string): Promise<unknown[]> {
    return this.prisma.usagePricingPolicy.findMany({
      where: {
        ...(productId ? { productId } : {}),
        scope: { in: ['GLOBAL', 'SEGMENT', 'USER'] },
      },
      orderBy: [{ productId: 'asc' }, { priority: 'desc' }, { createdAt: 'desc' }],
      include: {
        user: { select: { id: true, email: true, nickname: true } },
        segment: { select: { id: true, name: true } },
      },
    });
  }

  async createPolicy(input: UsagePolicyWriteInput): Promise<UsagePricingPolicy> {
    const data = await this.buildPolicyData(input);
    return this.prisma.usagePricingPolicy.create({ data });
  }

  async updatePolicy(
    id: string,
    input: Partial<UsagePolicyWriteInput>,
  ): Promise<UsagePricingPolicy> {
    const existing = await this.prisma.usagePricingPolicy.findUnique({ where: { id } });
    if (!existing) throw new NotFoundException('用量计费策略不存在');
    const data = await this.buildPolicyData({
      productId: existing.productId,
      scope: existing.scope,
      userId: existing.userId,
      segmentId: existing.segmentId,
      modelName: existing.modelName,
      priceMultiplier: existing.priceMultiplier.toString(),
      creditMultiplier: existing.creditMultiplier?.toString() ?? null,
      priority: existing.priority,
      description: existing.description,
      startsAt: existing.startsAt,
      endsAt: existing.endsAt,
      isActive: existing.isActive,
      ...input,
    });
    return this.prisma.usagePricingPolicy.update({ where: { id }, data });
  }

  async deletePolicy(id: string): Promise<void> {
    await this.prisma.usagePricingPolicy.delete({ where: { id } });
  }

  async listPaygModelPricing(productId: string) {
    const product = await this.assertPaygProduct(productId);
    const now = new Date();
    const availabilities = await this.prisma.productModelAvailability.findMany({
      where: { productId, status: { not: 'RETIRED' } },
      orderBy: [{ displayOrder: 'asc' }, { modelName: 'asc' }],
      include: {
        modelPricing: {
          select: {
            modelName: true,
            modelId: true,
            provider: true,
            isActive: true,
            pricingUnit: true,
            inputPricePerMToken: true,
            cachedInputPrice: true,
            cacheWrite5minPrice: true,
            cacheWrite1hPrice: true,
            outputPricePerMToken: true,
            // 长上下文后备价（与企业折扣页同构）：页面要显示"未命中显式档"时适用的价。
            longContextThreshold: true,
            longContextInputPrice: true,
            longContextOutputPrice: true,
            priceTiers: {
              // 不再只取 OFF_PEAK：页面需要展示**全部**生效档位
              // （运营要看到请求会命中哪一档、该档基价与生效价各是多少）。
              where: { isActive: true },
              orderBy: [{ priority: 'asc' }, { minInputTokens: 'asc' }],
              select: {
                tierKey: true,
                displayName: true,
                minInputTokens: true,
                maxInputTokensExclusive: true,
                priority: true,
                inputPricePerMToken: true,
                cachedInputPrice: true,
                cacheWritePrice: true,
                outputPricePerMToken: true,
                bandSchedule: true,
              },
            },
          },
        },
      },
    });
    const modelNames = availabilities.map((row) => row.modelName);
    const policies = modelNames.length
      ? await this.prisma.paygModelPricingPolicy.findMany({
          where: { productId, modelName: { in: modelNames } },
          orderBy: [{ modelName: 'asc' }, { startsAt: 'desc' }, { createdAt: 'desc' }],
        })
      : [];

    const policiesByModel = new Map<string, typeof policies>();
    for (const policy of policies) {
      const group = policiesByModel.get(policy.modelName) ?? [];
      group.push(policy);
      policiesByModel.set(policy.modelName, group);
    }
    return {
      product,
      items: availabilities.map((availability) => {
        const model = availability.modelPricing;
        const modelPolicies = policiesByModel.get(availability.modelName) ?? [];
        const activePolicy = modelPolicies.find((policy) => (
          policy.isActive &&
          policy.startsAt.getTime() <= now.getTime() &&
          (policy.endsAt == null || policy.endsAt.getTime() > now.getTime())
        )) ?? null;
        const multiplier = activePolicy?.priceMultiplier ?? new Prisma.Decimal(1);
        const baseInput = model.inputPricePerMToken;
        const baseCacheRead = this.resolveBaseCacheReadPrice(
          model.modelName,
          model.cachedInputPrice,
          baseInput,
        );
        const baseCacheWrite = model.cacheWrite5minPrice ?? model.cacheWrite1hPrice ?? null;
        const baseOutput = model.outputPricePerMToken;
        const effectiveInput = this.resolveEffectivePaygPrice(
          baseInput,
          activePolicy?.inputPricePerMToken,
          multiplier,
        );
        const effectiveCacheRead = this.resolveEffectivePaygPrice(
          baseCacheRead ?? baseInput,
          activePolicy?.cachedInputPrice,
          multiplier,
        );
        const effectiveCacheWrite = this.resolveEffectivePaygPrice(
          baseCacheWrite ?? baseInput,
          activePolicy?.cacheWritePrice,
          multiplier,
        );
        const effectiveOutput = this.resolveEffectivePaygPrice(
          baseOutput,
          activePolicy?.outputPricePerMToken,
          multiplier,
        );
        // OFF_PEAK 时段档展示价（me/time-based-pricing.md v13.4）：与计费端**同一**
        // parseBandScheduleSafely 且四价完整才**成对下发**（否则成对 null）——历史脏数据
        // 不得出现"页面显示空闲价、实际按高峰价收费"。effective 与计费同规则：
        // PAYG 绝对覆盖价优先于档价，否则 档价×倍率 round8。
        // 档位列表现在含多档，OFF_PEAK 必须按 tierKey 取，不能再依赖下标 0。
        const offPeakTier = model.priceTiers?.find((t) => t.tierKey === OFF_PEAK_TIER_KEY) ?? null;
        const offPeakSchedule = offPeakTier
          && isTokenPricingUnit(model.pricingUnit)
          && offPeakTier.cachedInputPrice != null
          && offPeakTier.cacheWritePrice != null
          ? parseBandScheduleSafely(offPeakTier.bandSchedule)
          : null;
        const offPeakEffective = offPeakSchedule && offPeakTier
          ? {
              input: this.resolveEffectivePaygPrice(
                offPeakTier.inputPricePerMToken,
                activePolicy?.inputPricePerMToken,
                multiplier,
              ),
              cached: this.resolveEffectivePaygPrice(
                offPeakTier.cachedInputPrice as Prisma.Decimal,
                activePolicy?.cachedInputPrice,
                multiplier,
              ),
              cacheWrite: this.resolveEffectivePaygPrice(
                offPeakTier.cacheWritePrice as Prisma.Decimal,
                activePolicy?.cacheWritePrice,
                multiplier,
              ),
              output: this.resolveEffectivePaygPrice(
                offPeakTier.outputPricePerMToken,
                activePolicy?.outputPricePerMToken,
                multiplier,
              ),
            }
          : null;

        const snapshotPolicy = (policy: (typeof policies)[number]) => ({
          id: policy.id,
          priceMultiplier: usdNumber(policy.priceMultiplier),
          input: policy.inputPricePerMToken == null ? null : usdNumber(policy.inputPricePerMToken),
          cached: policy.cachedInputPrice == null ? null : usdNumber(policy.cachedInputPrice),
          cacheWrite: policy.cacheWritePrice == null ? null : usdNumber(policy.cacheWritePrice),
          output: policy.outputPricePerMToken == null ? null : usdNumber(policy.outputPricePerMToken),
          startsAt: policy.startsAt,
          endsAt: policy.endsAt,
          isActive: policy.isActive,
          description: policy.description,
          createdAt: policy.createdAt,
          updatedAt: policy.updatedAt,
        });

        // 按量定价只支持倍率：绝对覆盖价已废除。
        // fail-closed 就发生在**当前价格投影层**：若仍在生效的策略行带任一覆盖价，
        // 不返回任何 effective / offPeakEffective 价格，改带 reason=LEGACY_OVERRIDE_DETECTED，
        // 避免"页面显示倍率价、实际按覆盖价扣费"（设计稿 §1.5b）。历史 effectiveAt 计费仍忠实重放。
        const legacyOverrideFields = activePolicy
          ? (['inputPricePerMToken', 'cachedInputPrice', 'cacheWritePrice', 'outputPricePerMToken'] as const)
              .filter((field) => activePolicy[field] != null)
          : [];
        const hasLegacyOverride = legacyOverrideFields.length > 0;
        if (hasLegacyOverride) {
          this.logger.error(
            `LEGACY_OVERRIDE_DETECTED payg policy ${activePolicy?.id} model=${availability.modelName} fields=${legacyOverrideFields.join(',')}`,
          );
        }

        return {
          modelName: availability.modelName,
          displayName: model.modelId?.trim() || availability.modelName,
          provider: model.provider,
          modelActive: model.isActive,
          pricingReason: hasLegacyOverride ? 'LEGACY_OVERRIDE_DETECTED' : null,
          availability: {
            id: availability.id,
            status: availability.status,
            apiEnabled: availability.apiEnabled,
            visible: availability.visible,
            startsAt: availability.startsAt,
            endsAt: availability.endsAt,
            displayOrder: availability.displayOrder,
            reason: availability.reason,
            active: this.paygAvailabilityActive(availability, now) && model.isActive,
            createdAt: availability.createdAt,
            updatedAt: availability.updatedAt,
          },
          offPeakEffective: hasLegacyOverride ? null : offPeakEffective,
          offPeakSchedule,
          // ⚠️ 缺专属缓存价时回退到 input（与结算及配对的 effective 一致）。
          // 此前这里吐 null 而 effective 非空 ⇒ 前端 effectivePriceForDraft 见 base 为 null
          // 就把**正确的** effective 丢掉，页面显示「未配置」。
          // 这一块不整体换成 toPriceBuckets：顶层 effective 还要处理覆盖价优先级。
          base: {
            input: usdNumber(baseInput),
            cached: usdNumber(baseCacheRead ?? baseInput),
            cacheWrite: usdNumber(baseCacheWrite ?? baseInput),
            output: usdNumber(baseOutput),
          },
          baseInherited: {
            cached: baseCacheRead == null,
            cacheWrite: baseCacheWrite == null,
          },
          policy: activePolicy ? snapshotPolicy(activePolicy) : null,
          policies: modelPolicies.map(snapshotPolicy),
          // 与「企业模型专属折扣」页同构的分档展示数据：那边已验证可用，
          // 这里复用同一形状，前端就能用同一套渲染逻辑，不必各写一份。
          // ⚠️ 脏数据（仍带已废除的绝对覆盖价）时整组置 null——不得按倍率伪造与实际扣费不符的档价。
          tiers: hasLegacyOverride
            ? []
            // ⚠️ 只下发**结算真的会命中**的档（评审阻断项）：OFF_PEAK 的命中条件是
            // bandAt + isTokenPricingUnit + parseBandScheduleSafely 三者同时成立
            // （见 ModelPricingService.selectPricingForTokens）。脏/空 schedule 会被结算忽略、
            // 回落普通档，此时把它当可生效档展示就是「页面显示一个永不生效的价」。
            : (model.priceTiers ?? [])
              .filter((tier) => {
                if (tier.tierKey !== OFF_PEAK_TIER_KEY) return true;
                if (!isTokenPricingUnit(model.pricingUnit)) return false;
                return parseBandScheduleSafely(tier.bandSchedule) != null;
              })
              .map((tier) => ({
                tierKey: tier.tierKey,
                displayName: tier.displayName,
                minInputTokens: tier.minInputTokens,
                maxInputTokensExclusive: tier.maxInputTokensExclusive,
                priority: tier.priority,
                ...this.toPriceBuckets(
                  availability.modelName,
                  tier.inputPricePerMToken,
                  tier.outputPricePerMToken,
                  tier.cachedInputPrice,
                  tier.cacheWritePrice,
                  multiplier,
                ),
              })),
          fallbackPricing: hasLegacyOverride
            ? null
            : {
                longContext: model.longContextThreshold != null
                  && (model.longContextInputPrice != null || model.longContextOutputPrice != null)
                  ? this.toEnterpriseFallbackPrice(
                      availability.modelName,
                      model.longContextThreshold,
                      model.longContextInputPrice ?? baseInput,
                      model.longContextOutputPrice ?? baseOutput,
                      model.cachedInputPrice,
                      baseCacheWrite,
                      multiplier,
                    )
                  : null,
                default: this.toEnterpriseFallbackPrice(
                  availability.modelName,
                  null,
                  baseInput,
                  baseOutput,
                  model.cachedInputPrice,
                  baseCacheWrite,
                  multiplier,
                ),
              },
          effective: hasLegacyOverride
            ? null
            : {
                input: effectiveInput,
                cached: effectiveCacheRead,
                cacheWrite: effectiveCacheWrite,
                output: effectiveOutput,
              },
        };
      }),
    };
  }

  async listEnterpriseModelDiscounts(billingAccountId: string, productId: string) {
    const account = await this.assertEnterpriseBillingAccount(billingAccountId);
    const product = await this.assertPaygProduct(productId);
    const models = await this.listEnterpriseDiscountModels(product.id);
    const modelNames = models.map((row) => row.modelName);
    const discounts = modelNames.length
      ? await this.prisma.enterpriseModelDiscount.findMany({
          where: {
            billingAccountId: account.id,
            productId: product.id,
            modelName: { in: modelNames },
          },
        })
      : [];
    const discountByModel = new Map(discounts.map((row) => [row.modelName, row]));
    return {
      account,
      product,
      items: models.map((model) => this.toEnterpriseDiscountRow(
        model,
        discountByModel.get(model.modelName) ?? null,
      )),
    };
  }

  async upsertEnterpriseModelDiscounts(
    billingAccountId: string,
    input: EnterpriseModelDiscountMatrixInput,
  ) {
    const account = await this.assertEnterpriseBillingAccount(billingAccountId);
    const product = await this.assertPaygProduct(input.productId);
    const models = await this.listEnterpriseDiscountModels(product.id);
    if (models.length === 0) {
      throw new BadRequestException('该产品暂无可配置企业折扣的模型');
    }
    const modelNameSet = new Set(models.map((row) => row.modelName));
    const itemMap = new Map<string, EnterpriseModelDiscountItemInput>();
    for (const item of input.items ?? []) {
      const modelName = item.modelName?.trim();
      if (!modelName) throw new BadRequestException('modelName 必填');
      if (!modelNameSet.has(modelName)) {
        throw new BadRequestException(`模型 ${modelName} 不属于该产品或已退役`);
      }
      if (itemMap.has(modelName)) {
        throw new BadRequestException(`模型 ${modelName} 重复配置`);
      }
      itemMap.set(modelName, { ...item, modelName });
    }
    const missing = models
      .map((row) => row.modelName)
      .filter((modelName) => !itemMap.has(modelName));
    if (missing.length > 0) {
      throw new BadRequestException(`企业模型折扣必须覆盖该产品全部模型: ${missing.slice(0, 5).join(', ')}`);
    }

    const normalized = models.map((model) => {
      const item = itemMap.get(model.modelName);
      return {
        modelName: model.modelName,
        priceMultiplier: this.normalizeEnterpriseDiscountMultiplier(
          item?.priceMultiplier ?? 1,
        ),
        isActive: item?.isActive ?? true,
        note: item?.note?.trim() ?? '',
      };
    });

    await this.prisma.$transaction(async (tx) => {
      for (const item of normalized) {
        await tx.enterpriseModelDiscount.upsert({
          where: {
            billingAccountId_productId_modelName: {
              billingAccountId: account.id,
              productId: product.id,
              modelName: item.modelName,
            },
          },
          create: {
            billingAccountId: account.id,
            productId: product.id,
            modelName: item.modelName,
            priceMultiplier: item.priceMultiplier,
            isActive: item.isActive,
            note: item.note,
            updatedBy: input.updatedBy?.trim() || null,
          },
          update: {
            priceMultiplier: item.priceMultiplier,
            isActive: item.isActive,
            note: item.note,
            updatedBy: input.updatedBy?.trim() || null,
          },
        });
      }
    });

    return this.listEnterpriseModelDiscounts(account.id, product.id);
  }

  async listPaygModelCandidates(productId: string) {
    const product = await this.assertPaygProduct(productId);
    const [models, availabilities] = await Promise.all([
      this.prisma.modelPricing.findMany({
        where: { isActive: true },
        orderBy: [{ displayOrder: 'asc' }, { modelName: 'asc' }],
        select: {
          modelName: true,
          provider: true,
          displayOrder: true,
          inputPricePerMToken: true,
          cachedInputPrice: true,
          cacheWrite5minPrice: true,
          cacheWrite1hPrice: true,
          outputPricePerMToken: true,
        },
      }),
      this.prisma.productModelAvailability.findMany({
        where: { productId },
        select: { id: true, modelName: true, status: true },
      }),
    ]);
    const availabilityByModel = new Map(availabilities.map((row) => [row.modelName, row]));
    return {
      product,
      items: models
        .filter((model) => {
          const existing = availabilityByModel.get(model.modelName);
          return !existing || existing.status === 'RETIRED';
        })
        .map((model) => {
          const baseInput = model.inputPricePerMToken;
          const baseCacheRead = this.resolveBaseCacheReadPrice(
            model.modelName,
            model.cachedInputPrice,
            baseInput,
          );
          const baseCacheWrite = model.cacheWrite5minPrice ?? model.cacheWrite1hPrice ?? null;
          return {
            modelName: model.modelName,
            provider: model.provider,
            displayOrder: model.displayOrder,
            previouslyRemoved: availabilityByModel.get(model.modelName)?.status === 'RETIRED',
            base: {
              input: usdNumber(baseInput),
              cached: baseCacheRead == null ? null : usdNumber(baseCacheRead),
              cacheWrite: baseCacheWrite == null ? null : usdNumber(baseCacheWrite),
              output: usdNumber(model.outputPricePerMToken),
            },
          };
        }),
    };
  }

  async addPaygProductModels(input: PaygProductModelWriteInput) {
    const product = await this.assertPaygProduct(input.productId);
    const modelNames = this.normalizePaygModelNames([
      ...(input.modelNames ?? []),
      ...(input.modelName ? [input.modelName] : []),
    ]);
    if (modelNames.length === 0) throw new BadRequestException('modelNames 为必填');
    const startsAt = this.toOptionalDate(input.startsAt);
    const endsAt = this.toOptionalDate(input.endsAt);
    this.assertAvailabilityTimeWindow(startsAt, endsAt);
    const status = this.normalizeProductModelAvailabilityStatus(input.status ?? 'ACTIVE');
    const displayOrderOverride = input.displayOrder == null
      ? null
      : this.normalizeDisplayOrder(input.displayOrder);
    const models = await this.prisma.modelPricing.findMany({
      where: { modelName: { in: modelNames }, isActive: true },
      select: { modelName: true, displayOrder: true },
    });
    const found = new Set(models.map((model) => model.modelName));
    const missing = modelNames.filter((modelName) => !found.has(modelName));
    if (missing.length > 0) {
      throw new BadRequestException(`模型不存在或未启用: ${missing.join(', ')}`);
    }
    const modelsByName = new Map(models.map((model) => [model.modelName, model]));

    await this.prisma.$transaction(modelNames.map((modelName) => {
      const model = modelsByName.get(modelName)!;
      return this.prisma.productModelAvailability.upsert({
        where: { productId_modelName: { productId: product.id, modelName } },
        create: {
          productId: product.id,
          modelName,
          status,
          apiEnabled: input.apiEnabled ?? true,
          visible: input.visible ?? true,
          startsAt,
          endsAt,
          displayOrder: displayOrderOverride ?? model.displayOrder,
          reason: input.reason?.trim() ?? '',
        },
        update: {
          status,
          apiEnabled: input.apiEnabled ?? true,
          visible: input.visible ?? true,
          startsAt,
          endsAt,
          displayOrder: displayOrderOverride ?? model.displayOrder,
          reason: input.reason?.trim() ?? '',
        },
      });
    }));
    this.scheduleProductRuntimePolicySync(product.id);
    return this.listPaygModelPricing(product.id);
  }

  async updatePaygProductModelAvailability(id: string, input: PaygProductModelUpdateInput) {
    const normalizedId = id?.trim();
    if (!normalizedId) throw new BadRequestException('id 为必填');
    const existing = await this.prisma.productModelAvailability.findUnique({
      where: { id: normalizedId },
      select: {
        id: true,
        productId: true,
        startsAt: true,
        endsAt: true,
      },
    });
    if (!existing) throw new NotFoundException('产品模型授权不存在');
    const product = await this.assertPaygProduct(existing.productId);
    const data: Prisma.ProductModelAvailabilityUpdateInput = {};
    if (input.status !== undefined) {
      data.status = this.normalizeProductModelAvailabilityStatus(input.status);
    }
    if (input.apiEnabled !== undefined) data.apiEnabled = input.apiEnabled === true;
    if (input.visible !== undefined) data.visible = input.visible === true;
    if (input.startsAt !== undefined) data.startsAt = this.toOptionalDate(input.startsAt);
    if (input.endsAt !== undefined) data.endsAt = this.toOptionalDate(input.endsAt);
    if (input.displayOrder !== undefined) data.displayOrder = this.normalizeDisplayOrder(input.displayOrder);
    if (input.reason !== undefined) data.reason = input.reason?.trim() ?? '';
    const nextStartsAt = input.startsAt !== undefined ? (data.startsAt as Date | null) : existing.startsAt;
    const nextEndsAt = input.endsAt !== undefined ? (data.endsAt as Date | null) : existing.endsAt;
    this.assertAvailabilityTimeWindow(nextStartsAt, nextEndsAt);
    const updated = await this.prisma.productModelAvailability.update({
      where: { id: normalizedId },
      data,
    });
    this.scheduleProductRuntimePolicySync(product.id);
    return updated;
  }

  async retirePaygProductModelAvailability(id: string) {
    const normalizedId = id?.trim();
    if (!normalizedId) throw new BadRequestException('id 为必填');
    const existing = await this.prisma.productModelAvailability.findUnique({
      where: { id: normalizedId },
      select: { id: true, productId: true, endsAt: true },
    });
    if (!existing) throw new NotFoundException('产品模型授权不存在');
    const product = await this.assertPaygProduct(existing.productId);
    const now = new Date();
    const updated = await this.prisma.productModelAvailability.update({
      where: { id: normalizedId },
      data: {
        status: 'RETIRED',
        apiEnabled: false,
        visible: false,
        ...(existing.endsAt == null || existing.endsAt.getTime() > now.getTime() ? { endsAt: now } : {}),
      },
    });
    this.scheduleProductRuntimePolicySync(product.id);
    return updated;
  }

  private assertNoPaygOverridePrices(input: PaygModelPricingVersionInput) {
    const overrides: Array<[string, unknown]> = [
      ['inputPricePerMToken', input.inputPricePerMToken],
      ['cachedInputPrice', input.cachedInputPrice],
      ['cacheWritePrice', input.cacheWritePrice],
      ['outputPricePerMToken', input.outputPricePerMToken],
    ];
    const provided = overrides
      .filter(([, value]) => {
        if (value === undefined || value === null) return false;
        // 设计 §1.3：null/undefined/空白字符串均视为"未配置"
        if (typeof value === 'string' && value.trim() === '') return false;
        return true;
      })
      .map(([key]) => key);
    if (provided.length > 0) {
      throw new BadRequestException(
        `按量定价已改为仅支持倍率，不再接受绝对覆盖价：${provided.join(', ')}`,
      );
    }
  }

  async createPaygModelPricingVersion(input: PaygModelPricingVersionInput) {
    // 按量定价只支持倍率：绝对覆盖价已废除。入口即拒（先于任何 DB 查询），历史行只读展示。
    this.assertNoPaygOverridePrices(input);
    await this.assertPaygProduct(input.productId);
    const modelName = input.modelName?.trim();
    if (!modelName) throw new BadRequestException('modelName 为必填');
    const model = await this.prisma.modelPricing.findFirst({
      where: { modelName, isActive: true },
      select: { modelName: true },
    });
    if (!model) throw new BadRequestException('模型不存在或未启用');
    const startsAt = this.toOptionalDate(input.startsAt) ?? new Date();
    const endsAt = this.toOptionalDate(input.endsAt);
    if (endsAt && endsAt.getTime() <= startsAt.getTime()) {
      throw new BadRequestException('endsAt 必须晚于 startsAt');
    }

    const writeData = {
      priceMultiplier: this.normalizePaygMultiplier(input.priceMultiplier),
      inputPricePerMToken: null,
      cachedInputPrice: null,
      cacheWritePrice: null,
      outputPricePerMToken: null,
      isActive: input.isActive ?? true,
      description: input.description?.trim() ?? '',
    };

    return this.prisma.$transaction(async (tx) => {
      const duplicateStart = await tx.paygModelPricingPolicy.findFirst({
        where: {
          productId: input.productId,
          modelName,
          isActive: true,
          startsAt,
        },
        select: { id: true },
      });
      if (duplicateStart) {
        throw new BadRequestException('该模型在这个开始时间已存在按量价格版本');
      }

      const nextPolicy = await tx.paygModelPricingPolicy.findFirst({
        where: {
          productId: input.productId,
          modelName,
          isActive: true,
          startsAt: { gt: startsAt },
        },
        orderBy: { startsAt: 'asc' },
        select: { startsAt: true },
      });
      if (endsAt && nextPolicy && endsAt.getTime() > nextPolicy.startsAt.getTime()) {
        throw new BadRequestException('结束时间不能覆盖同一模型的下一条价格版本');
      }
      const effectiveEndsAt = endsAt ?? nextPolicy?.startsAt ?? null;

      await tx.paygModelPricingPolicy.updateMany({
        where: {
          productId: input.productId,
          modelName,
          isActive: true,
          startsAt: { lt: startsAt },
          OR: [{ endsAt: null }, { endsAt: { gt: startsAt } }],
        },
        data: { endsAt: startsAt },
      });

      return tx.paygModelPricingPolicy.create({
        data: {
          productId: input.productId,
          modelName,
          startsAt,
          endsAt: effectiveEndsAt,
          ...writeData,
        },
      });
    });
  }

  async deactivatePaygModelPricingPolicy(id: string) {
    const normalizedId = id?.trim();
    if (!normalizedId) throw new BadRequestException('id 为必填');
    const existing = await this.prisma.paygModelPricingPolicy.findUnique({
      where: { id: normalizedId },
    });
    if (!existing) throw new NotFoundException('按量价格版本不存在');
    const now = new Date();
    return this.prisma.paygModelPricingPolicy.update({
      where: { id: normalizedId },
      data: {
        isActive: false,
        ...(existing.endsAt == null || existing.endsAt.getTime() > now.getTime()
          ? { endsAt: now }
          : {}),
      },
    });
  }

  private normalizeQuoteInput(input: UsageQuoteInput): NormalizedUsageQuoteInput {
    if (!input.modelName?.trim()) {
      throw new BadRequestException('modelName 必填');
    }
    const eventOccurredAt = this.eventOccurredAtForSettlement(input);
    const inputTokens = this.safeToken(input.inputTokens);
    const cachedInputTokens = Math.min(
      this.safeToken(input.cachedInputTokens),
      inputTokens,
    );
    const cacheWriteInputTokens = Math.min(
      this.safeToken(input.cacheWriteInputTokens),
      inputTokens - cachedInputTokens,
    );
    return {
      ...input,
      modelName: input.modelName.trim(),
      inputTokens,
      outputTokens: this.safeToken(input.outputTokens),
      cachedInputTokens,
      cacheWriteInputTokens,
      imageCount: this.safeUsageQuantity(input.imageCount, 'imageCount'),
      ...(input.callType?.trim() ? { callType: input.callType.trim() } : {}),
      ...(input.upstreamModel?.trim() ? { upstreamModel: input.upstreamModel.trim() } : {}),
      ...(this.providerCodeOrNull(input.providerCode)
        ? { providerCode: this.providerCodeOrNull(input.providerCode)! }
        : {}),
      ...(input.providerLineId?.trim() ? { providerLineId: input.providerLineId.trim() } : {}),
      ...(eventOccurredAt ? { eventOccurredAt } : {}),
    };
  }

  private safeToken(value: unknown): number {
    if (value === undefined || value === null || value === '') return 0;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0) {
      throw new BadRequestException('token 数必须为 >= 0 的数字');
    }
    return Math.floor(n);
  }

  private safeUsageQuantity(value: unknown, field: string): number {
    if (value === undefined || value === null || value === '') return 0;
    const n = Number(value);
    if (!Number.isFinite(n) || n < 0 || !Number.isInteger(n)) {
      throw new BadRequestException(`${field} 必须为 >= 0 的整数`);
    }
    return n;
  }

  private async recordDeliveredCreditsDebt(
    input: UsageDeductInput,
    quote: CreditQuote,
    settlementContext: GatewaySettlementContext,
    settlementFingerprint: string,
    claimAlreadyAcquired = false,
  ): Promise<Record<string, unknown>> {
    if (!claimAlreadyAcquired) {
      const claim = await this.beginPendingIdempotency(input.idempotencyKey, quote.userId);
      if (claim.replay) {
        const permanentReplay = await this.findGatewayFinancialReceiptReplay(
          input,
          settlementContext,
          settlementFingerprint,
        );
        if (!permanentReplay) {
          throw new GatewaySettlementAnchorConflictError(
            'Gateway CREDITS debt 临时幂等结果缺少永久资金回执',
          );
        }
        return permanentReplay;
      }
      if (!claim.acquired) {
        return { success: false, allowed: false, reason: 'idempotency_in_progress' };
      }
    }

    const authoritativeDimensions = this.usageCustomerDimensionsChanged(
      settlementContext.anchor.customerQuoteSnapshot,
      quote,
    ) ? quote : undefined;
    const customerPricing = this.modelPricingFromGatewaySnapshot(
      settlementContext.anchor.customerPricingSnapshot.tokenUsagePricing,
      authoritativeDimensions,
    );
    if (!customerPricing) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway CREDITS debt 缺少冻结 customer pricing',
      );
    }
    const debtExposureUsd = customerPricing.costUsd;
    let response: Record<string, unknown> | null = null;
    try {
      await this.prisma.$transaction(async (tx) => {
        await this.assertGatewaySettlementFinancialTarget(
          tx,
          settlementContext.anchor,
          true,
        );
        const tokenUsageId = await this.recordTokenUsageIfRequested(
          input,
          quote,
          tx,
          'DEBT_OPEN',
          settlementContext.anchor,
        );
        response = {
          success: false,
          allowed: false,
          reason: 'insufficient_credits',
          quote,
          debtOpen: true,
          fundingOutcome: 'DEBT_OPEN',
          debtExposureUsd: debtExposureUsd.toString(),
          debtCredits: quote.creditCost,
          ...(tokenUsageId ? { tokenUsageId } : {}),
        };
        await this.persistGatewayFinancialReceipt(
          tx,
          input,
          settlementContext,
          settlementFingerprint,
          response,
          tokenUsageId,
        );
        await this.commitIdempotency(
          input.idempotencyKey,
          quote.userId,
          response,
          tx,
        );
      });
      return response ?? {
        success: false,
        allowed: false,
        reason: 'insufficient_credits',
        debtOpen: true,
        fundingOutcome: 'DEBT_OPEN',
        debtExposureUsd: debtExposureUsd.toString(),
      };
    } catch (err) {
      await this.releasePendingIdempotency(input.idempotencyKey, err);
      throw err;
    }
  }

  private async recordTokenUsageIfRequested(
    input: UsageDeductInput,
    quote: UsageQuoteResult,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
    funding: TokenUsageFunding = 'SETTLED',
    settlementAnchor?: GatewaySettlementAnchor,
    pricingAt?: Date,
  ): Promise<string | null> {
    return timed('stlTokenUsage', () => this.recordTokenUsageIfRequestedInner(input, quote, db, funding, settlementAnchor, pricingAt));
  }

  private async recordTokenUsageIfRequestedInner(
    input: UsageDeductInput,
    quote: UsageQuoteResult,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
    funding: TokenUsageFunding = 'SETTLED',
    settlementAnchor?: GatewaySettlementAnchor,
    pricingAt?: Date,
  ): Promise<string | null> {
    const apiKeyId = input.apiKeyId?.trim();
    if (!input.recordTokenUsage || !apiKeyId) return null;
    const tenantId = this.requireQuoteTenantId(quote);

    try {
      const eventOccurredAt = this.eventOccurredAtForSettlement(input);
      // 与 quote 同一冻结时刻（deductInternal 传入）；仅最后才回落本地 now
      const effectiveAt = eventOccurredAt ?? pricingAt ?? new Date();
      const includedUpstream = quote.unit === 'CREDITS' && quote.includedUpstream === true;
      if (settlementAnchor && settlementAnchor.billingUnit !== quote.unit) {
        throw new GatewaySettlementAnchorConflictError(
          'Gateway frozen TokenUsage pricing unit 与 quote 不一致',
        );
      }
      const authoritativeDimensions = settlementAnchor && this.usageCustomerDimensionsChanged(
        settlementAnchor.customerQuoteSnapshot,
        quote,
      ) ? quote : undefined;
      const pricing = settlementAnchor
        ? this.modelPricingFromGatewaySnapshot(
            settlementAnchor.customerPricingSnapshot.tokenUsagePricing,
            authoritativeDimensions,
          )
        : quote.unit === 'BALANCE'
          ? this.customerPricingFromBalanceQuote(quote)
          : await this.modelPricingQuoteForTokenUsage(
              quote,
              'PRODUCT_EFFECTIVE',
              effectiveAt,
              // 非锚定 CREDITS 记录价与积分同档（转售红线：不传即不进时段档）
              includedUpstream ? undefined : effectiveAt,
            );
      if (settlementAnchor && !pricing && !includedUpstream) {
        throw new GatewaySettlementAnchorConflictError(
          'Gateway frozen TokenUsage customer pricing 不可用',
        );
      }
      const tokenUsagePricing = pricing ?? this.zeroModelPricingQuote();
      const imageLineItem = tokenUsagePricing.lineItems?.find(
        (lineItem) => lineItem.meter === 'image',
      );
      const hasImageUsage = quote.imageCount > 0;
      // TODO(P3 provider bill import): ProviderModelCostPolicy is token-only and
      // cannot represent a per-image supplier charge without inventing token costs.
      const providerBasePricing = hasImageUsage
        ? null
        : settlementAnchor
          ? null
          : await this.modelPricingQuoteForTokenUsage(
            quote,
            'LIST',
            effectiveAt,
          );
      const totalTokens = Math.max(
        this.safeToken(input.totalTokens),
        quote.inputTokens + quote.outputTokens,
      );
      const zeroCreditFunding = funding === 'ZERO_CREDITS';
      const costUsd =
        zeroCreditFunding
          ? usd(0)
          : quote.unit === 'BALANCE'
          ? usd(quote.effectiveCostUsd)
          : includedUpstream
            ? usd(0)
            : tokenUsagePricing.costUsd;
      const balanceFunding = typeof funding === 'object' ? funding : null;
      const fundingOutcome = balanceFunding
        ? balanceFunding.debtOpen ? 'DEBT_OPEN' : 'SETTLED'
        : funding;
      const customerCollectedUsd = balanceFunding
        ? balanceFunding.collectedUsd
        : fundingOutcome === 'DEBT_OPEN'
          ? usd(0)
          : costUsd;
      const customerApprovedReceivableUsd = balanceFunding
        ? balanceFunding.approvedCreditUsd
        : usd(0);
      const customerUnapprovedDebtUsd = balanceFunding
        ? balanceFunding.unapprovedDebtUsd
        : fundingOutcome === 'DEBT_OPEN'
          ? costUsd
          : usd(0);
      if (!customerCollectedUsd
        .plus(customerApprovedReceivableUsd)
        .plus(customerUnapprovedDebtUsd)
        .equals(costUsd)) {
        throw new GatewaySettlementAnchorConflictError(
          'TokenUsage customer funding split 与 customer charge 不一致',
        );
      }
      const customerChargePolicy = quote.unit === 'BALANCE'
        ? 'payg_balance'
        : customerUnapprovedDebtUsd.gt(0)
          ? 'debt_open'
          : customerApprovedReceivableUsd.gt(0)
            ? 'enterprise_credit_receivable'
            : includedUpstream
              ? 'included_upstream'
              : 'subscription_credits';
      const codingPlanEntitlementId = quote.unit === 'CREDITS'
        ? quote.codingPlanEntitlementId ?? (
            quote.entitlementKind === 'coding_plan_entitlement' || includedUpstream
              ? quote.subscriptionId
              : null
          )
        : null;
      const providerCode = this.resolveProviderCodeForTokenUsage(input, quote);
      const providerLineId = this.resolveProviderLineIdForTokenUsage(input, quote);
      const providerLineCode = quote.unit === 'CREDITS' ? quote.providerLineCode ?? null : null;
      const frozenProviderCost = settlementAnchor?.providerCostSnapshot;
      const providerCostDimensions = input.gatewayCustomerSettlement
        ? {
            inputTokens: input.gatewayCustomerSettlement.originalDimensions.inputTokens,
            outputTokens: input.gatewayCustomerSettlement.originalDimensions.outputTokens,
            cachedInputTokens:
              input.gatewayCustomerSettlement.originalDimensions.cachedInputTokens,
            cacheWriteInputTokens:
              input.gatewayCustomerSettlement.originalDimensions.cacheWriteInputTokens,
          }
        : authoritativeDimensions;
      const providerCost = frozenProviderCost?.status === 'VERIFIED'
        ? this.providerCostFromGatewaySnapshot(
            frozenProviderCost,
            providerCostDimensions,
          )
        : providerBasePricing
          ? await this.providerCostPricing.quote({
            productId: quote.productId,
            providerCode,
            providerLineId,
            modelName: quote.modelName,
            inputTokens: quote.inputTokens,
            outputTokens: quote.outputTokens,
            cachedInputTokens: quote.cachedInputTokens,
            cacheWriteInputTokens: quote.cacheWriteInputTokens,
            base: providerBasePricing,
            effectiveAt,
          })
          : null;
      const providerCostEstimateUsd = providerCost?.costUsd
        ?? (!settlementAnchor && includedUpstream && providerBasePricing
          ? providerBasePricing.costUsd
          : null);
      const gatewayBillingEventId = await this.findGatewayBillingEventId(db, input.requestId);

      if (settlementAnchor && gatewayBillingEventId) {
        // PostgreSQL verifies this transaction-local marker in a BEFORE INSERT
        // trigger. It prevents an older Kafka consumer from writing a Gateway
        // TokenUsage without the V1 anchor/reservation protocol during rollout.
        await db.$executeRaw`
          SELECT set_config(
            'ruidong.gateway_settlement_protocol',
            'v1',
            true
          )
        `;
      }

      const tokenUsage = await db.tokenUsage.create({
        data: {
          apiKeyId,
          tenantId,
          productId: quote.productId,
          ...(providerLineId ? { providerLineId } : {}),
          ...(providerLineCode ? { providerLineCode } : {}),
          ...(providerCode ? { providerCode } : {}),
          ...(quote.unit === 'CREDITS' && codingPlanEntitlementId
            ? {
                codingPlanEntitlementId,
                ...(quote.providerEntitlementId
                  ? { providerEntitlementId: quote.providerEntitlementId }
                  : {}),
                ...(quote.upstreamProductId ? { upstreamProductId: quote.upstreamProductId } : {}),
              }
            : {}),
          ...(gatewayBillingEventId ? { gatewayBillingEventId } : {}),
          requestId: input.requestId?.trim() || undefined,
          model: quote.modelName,
          meter: hasImageUsage ? 'image' : 'token',
          ...(hasImageUsage
            ? {
                quantity: quote.imageCount,
                ...(imageLineItem ? { unitPriceUsd: imageLineItem.unitPriceUsd } : {}),
              }
            : {}),
          ...(input.callType?.trim() ? { callType: input.callType.trim() } : {}),
          ...(input.upstreamModel?.trim() ? { upstreamModel: input.upstreamModel.trim() } : {}),
          pricingTierKey: tokenUsagePricing.pricingTierKey,
          promptTokens: quote.inputTokens,
          ...(quote.cachedInputTokens > 0
            ? { cachedInputTokens: quote.cachedInputTokens }
            : {}),
          ...(quote.cacheWriteInputTokens > 0
            ? { cacheWriteInputTokens: quote.cacheWriteInputTokens }
            : {}),
          completionTokens: quote.outputTokens,
          totalTokens,
          inputPriceUsdPerM: tokenUsagePricing.inputPriceUsdPerM,
          cachedInputPriceUsdPerM: tokenUsagePricing.cachedInputPriceUsdPerM,
          ...(tokenUsagePricing.cacheWritePriceUsdPerM != null
            ? { cacheWritePriceUsdPerM: tokenUsagePricing.cacheWritePriceUsdPerM }
            : {}),
          outputPriceUsdPerM: tokenUsagePricing.outputPriceUsdPerM,
          costUsd,
          customerChargePolicy,
          // Gross charge remains revenue/receivable evidence even when part or
          // all of the request is unpaid. Funding is represented separately.
          customerChargeUsd: costUsd,
          customerCollectedUsd,
          customerApprovedReceivableUsd,
          customerUnapprovedDebtUsd,
          customerFundingClassificationComplete: true,
          ...(providerCostEstimateUsd != null ? { providerCostEstimateUsd } : {}),
          ...(providerCost
            ? {
                providerCostPolicyId: providerCost.policyId,
                providerCostMultiplier: providerCost.priceMultiplier,
                providerInputCostUsdPerM: providerCost.inputCostUsdPerM,
                providerCachedInputCostUsdPerM: providerCost.cachedInputCostUsdPerM,
                providerCacheWriteCostUsdPerM: providerCost.cacheWriteCostUsdPerM,
                providerOutputCostUsdPerM: providerCost.outputCostUsdPerM,
              }
            : {}),
          ...(eventOccurredAt ? { createdAt: eventOccurredAt } : {}),
        },
      });
      return tokenUsage.id;
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `token usage record failed key=${apiKeyId} request=${input.requestId ?? ''}: ${msg}`,
      );
      throw err;
    }
  }

  private async modelPricingQuoteForTokenUsage(
    quote: UsageQuoteResult,
    priceBasis: 'PRODUCT_EFFECTIVE' | 'LIST',
    effectiveAt: Date,
    bandAt?: Date,
  ): Promise<ModelPricingQuote | null> {
    try {
      return await this.modelPricing.calculateCostQuote(
        quote.modelName,
        quote.inputTokens,
        quote.outputTokens,
        quote.cachedInputTokens,
        quote.cacheWriteInputTokens,
        {
          productId: quote.productId,
          priceBasis,
          effectiveAt,
          // LIST（供应商成本基线）永不接收 bandAt；仅 PRODUCT_EFFECTIVE 客户记录价用
          ...(priceBasis === 'PRODUCT_EFFECTIVE' && bandAt ? { bandAt } : {}),
          ...(quote.imageCount > 0 ? { imageCount: quote.imageCount } : {}),
        },
      );
    } catch (err) {
      const includedUpstream = quote.unit === 'CREDITS' && quote.includedUpstream === true;
      if (includedUpstream && err instanceof NotFoundException) {
        this.logger.warn(
          `provider resale token usage pricing missing model=${quote.modelName} product=${quote.productId} basis=${priceBasis}; recording zero customer charge`,
        );
        return null;
      }
      throw err;
    }
  }

  private zeroModelPricingQuote(): ModelPricingQuote {
    const zero = usd(0);
    return {
      costUsd: zero,
      pricingTierKey: null,
      inputPriceUsdPerM: zero,
      cachedInputPriceUsdPerM: null,
      cacheWritePriceUsdPerM: null,
      outputPriceUsdPerM: zero,
    };
  }

  private applyCustomerPriceMultiplier(
    quote: ModelPricingQuote,
    multiplier: Prisma.Decimal,
    quoteInputTokens: number,
    quoteOutputTokens: number,
    cachedInputTokens: number,
    cacheWriteInputTokens: number,
  ): ModelPricingQuote {
    const scale = (price: Prisma.Decimal) => price
      .mul(multiplier)
      .toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP);
    const inputPriceUsdPerM = scale(quote.inputPriceUsdPerM);
    const cachedInputPriceUsdPerM = quote.cachedInputPriceUsdPerM != null
      ? scale(quote.cachedInputPriceUsdPerM)
      : cachedInputTokens > 0
        ? inputPriceUsdPerM
        : null;
    const cacheWritePriceUsdPerM = quote.cacheWritePriceUsdPerM != null
      ? scale(quote.cacheWritePriceUsdPerM)
      : cacheWriteInputTokens > 0
        ? inputPriceUsdPerM
        : null;
    const outputPriceUsdPerM = scale(quote.outputPriceUsdPerM);
    if (quote.lineItems?.length) {
      const lineItems = quote.lineItems.map((lineItem) => {
        const unitPriceUsd = scale(lineItem.unitPriceUsd);
        return {
          ...lineItem,
          unitPriceUsd,
          amountUsd: unitPriceUsd
            .mul(lineItem.quantity)
            .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP),
        };
      });
      const costUsd = lineItems.reduce(
        (sum, lineItem) => sum.plus(lineItem.amountUsd),
        new Prisma.Decimal(0),
      ).toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
      return {
        ...quote,
        costUsd,
        inputPriceUsdPerM,
        cachedInputPriceUsdPerM,
        cacheWritePriceUsdPerM,
        outputPriceUsdPerM,
        lineItems,
      };
    }
    const safeCachedInputTokens = Math.min(Math.max(0, cachedInputTokens), quoteInputTokens);
    const safeCacheWriteInputTokens = Math.min(
      Math.max(0, cacheWriteInputTokens),
      quoteInputTokens - safeCachedInputTokens,
    );
    const regularInputTokens = quoteInputTokens - safeCachedInputTokens - safeCacheWriteInputTokens;
    return {
      costUsd: new Prisma.Decimal(regularInputTokens)
        .mul(inputPriceUsdPerM)
        .plus(new Prisma.Decimal(safeCachedInputTokens).mul(
          cachedInputPriceUsdPerM ?? inputPriceUsdPerM,
        ))
        .plus(new Prisma.Decimal(safeCacheWriteInputTokens).mul(
          cacheWritePriceUsdPerM ?? inputPriceUsdPerM,
        ))
        .plus(new Prisma.Decimal(quoteOutputTokens).mul(outputPriceUsdPerM))
        .div(1_000_000)
        .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP),
      pricingTierKey: quote.pricingTierKey,
      inputPriceUsdPerM,
      cachedInputPriceUsdPerM,
      cacheWritePriceUsdPerM,
      outputPriceUsdPerM,
    };
  }

  private customerPricingFromBalanceQuote(quote: BalanceQuote): ModelPricingQuote {
    return {
      costUsd: usd(quote.effectiveCostUsd),
      pricingTierKey: quote.pricingTierKey ?? null,
      inputPriceUsdPerM: usd(quote.customerPricing.inputPriceUsdPerM),
      cachedInputPriceUsdPerM: quote.customerPricing.cachedInputPriceUsdPerM == null
        ? null
        : usd(quote.customerPricing.cachedInputPriceUsdPerM),
      cacheWritePriceUsdPerM: quote.customerPricing.cacheWritePriceUsdPerM == null
        ? null
        : usd(quote.customerPricing.cacheWritePriceUsdPerM),
      outputPriceUsdPerM: usd(quote.customerPricing.outputPriceUsdPerM),
      ...(quote.lineItems?.length
        ? {
            lineItems: quote.lineItems.map((lineItem) => ({
              meter: lineItem.meter,
              quantity: lineItem.quantity,
              unitPriceUsd: usd(lineItem.unitPriceUsd),
              amountUsd: usd(lineItem.amountUsd),
            })),
          }
        : {}),
    };
  }

  private toUsageBillingLineItems(
    lineItems: NonNullable<ModelPricingQuote['lineItems']>,
  ): UsageBillingLineItem[] {
    return lineItems.map((lineItem) => ({
      meter: lineItem.meter,
      quantity: lineItem.quantity,
      unitPriceUsd: lineItem.unitPriceUsd.toString(),
      amountUsd: lineItem.amountUsd.toString(),
    }));
  }

  private async findGatewayBillingEventId(
    db: Prisma.TransactionClient | PrismaService,
    requestId?: string,
  ): Promise<string | null> {
    const normalized = requestId?.trim();
    if (!normalized) return null;

    const delegate = (db as unknown as GatewayBillingEventLookup).gatewayBillingEvent;
    if (!delegate?.findUnique) return null;

    const event = await delegate.findUnique({
      where: { requestId: normalized },
      select: { id: true },
    });
    return event?.id ?? null;
  }

  private schedulePublisherKeyBalanceSync(apiKeyId?: string): void {
    const normalized = apiKeyId?.trim();
    if (!normalized || !this.publisherSync) return;
    this.publisherSync
      .syncKeyBalanceById(normalized, { deleteWhenMissing: false })
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`publisher key-balance sync failed for ${normalized}: ${msg}`);
      });
  }

  /**
   * True only when the settlement provably left the Gateway admission
   * projection where it already was: it succeeded and the funding measure it
   * reports is still strictly positive.
   *
   * Every branch that cannot prove that falls through to a publish. Rejections
   * publish exactly as they did before `syncPublisherAfterUsageDeduct` existed,
   * and an unrecognised funding shape is treated as "may have changed".
   *
   * has_balance also depends on key spend limits, the rolling quota gate and
   * pending exposure, none of which appear in this response. Those transitions
   * have their own publish paths (limit mutation, rolling-quota scheduler); the
   * settlement path never carried them, so skipping here cannot lose them.
   */
  private settlementProjectionUnchanged(response: Record<string, unknown>): boolean {
    if (this.config?.get<string>('BILLING_SETTLEMENT_PUBLISH_SKIP_UNCHANGED') === 'false') {
      return false;
    }
    if (response.success !== true) return false;
    const balanceUsdAfter = fundingMeasure(response.balanceUsdAfter);
    if (balanceUsdAfter !== null) return balanceUsdAfter > 0;
    const quotaCreditsAfter = fundingMeasure(response.quotaCreditsAfter);
    if (quotaCreditsAfter !== null) return quotaCreditsAfter > 0;
    return false;
  }

  private async syncPublisherAfterUsageDeduct(
    apiKeyId: string | undefined,
    response: Record<string, unknown>,
    allowTerminalSettlement: boolean,
  ): Promise<void> {
    return timed('stlPubSync', () => this.syncPublisherAfterUsageDeductInner(apiKeyId, response, allowTerminalSettlement));
  }

  private async syncPublisherAfterUsageDeductInner(
    apiKeyId: string | undefined,
    response: Record<string, unknown>,
    allowTerminalSettlement: boolean,
  ): Promise<void> {
    const normalized = apiKeyId?.trim();
    const balanceUsdAfter = Number(response.balanceUsdAfter);
    const terminalSettlementApplied = allowTerminalSettlement
      || response.terminalSettlement === true;
    const exhaustedByTerminalSettlement = terminalSettlementApplied
      && response.success === true
      && Number.isFinite(balanceUsdAfter)
      && balanceUsdAfter <= 0;
    if (!exhaustedByTerminalSettlement) {
      // The exhausted branch below is a required, deliberately repeated closure
      // (see the replayed-exhaustion spec: Publisher must be told again even
      // when nothing was deducted). This fall-through is not that contract --
      // it is the residue of the three rejection-path publishes that predate
      // `syncPublisherAfterUsageDeduct`, and c95db34 widened its reach to every
      // replay and delivered-credits-debt settlement.
      //
      // A settlement that leaves funding strictly positive cannot move the
      // has_balance projection, so the publish rewrites the identical value.
      // Production measured one distinct (has_balance, fingerprint) pair across
      // 50,526 writes on the busiest Key in a single day.
      //
      // Skipping here rather than inside the publisher is deliberate:
      // syncKeyBalanceByIdOnce pre-allocates decision_version before reading
      // the balance and the outbox row is the only thing that advances the
      // Redis CAS fence, so a skip underneath the fanout would leave the fence
      // behind. A skip before dispatch never allocates a version. Durability is
      // unaffected: a publish that fails is healed by the publisher_sync_jobs
      // retry queue, not by the next settlement republishing.
      if (this.settlementProjectionUnchanged(response)) {
        publisherSettlementKeyBalanceSyncTotal.labels('skipped_unchanged').inc();
        return;
      }
      publisherSettlementKeyBalanceSyncTotal.labels('published').inc();
      this.schedulePublisherKeyBalanceSync(normalized);
      return;
    }
    if (!this.publisherSync) {
      throw new Error('PublisherSyncService is required for delivered terminal settlement');
    }
    const quote = response.quote;
    const billingAccountId = quote && typeof quote === 'object'
      ? String((quote as Record<string, unknown>).billingAccountId ?? '').trim()
      : '';
    if (billingAccountId) {
      await this.publisherSync.syncBillingAccountKeyBalancesRequired(billingAccountId);
      return;
    }
    const tenantId = quote && typeof quote === 'object'
      ? String((quote as Record<string, unknown>).tenantId ?? '').trim()
      : '';
    if (tenantId) {
      await this.publisherSync.syncBillingAccountKeyBalancesByTenantIdRequired(tenantId);
      return;
    }
    if (!normalized) {
      throw new Error(
        'Delivered terminal settlement exhausted an account without a Publisher subject',
      );
    }
    await this.publisherSync.syncBillingAccountKeyBalancesByKeyIdRequired(normalized);
  }

  private scheduleProductRuntimePolicySync(productId?: string): void {
    const normalized = productId?.trim();
    if (!normalized || !this.publisherSync) return;
    this.publisherSync
      .syncRuntimeIntentAfterProductPolicyChangeDetailed(normalized)
      .catch((err) => {
        const msg = err instanceof Error ? err.message : String(err);
        this.logger.warn(`publisher product runtime sync failed for ${normalized}: ${msg}`);
      });
  }

  private async resolveContext(
    input: UsageQuoteInput,
    db?: Prisma.TransactionClient,
  ): Promise<ResolvedContext> {
    const apiKeyId = input.apiKeyId?.trim();
    if (apiKeyId) {
      return this.resolveContextByApiKey(input, apiKeyId, db);
    }
    if (db) {
      throw new BadRequestException('Gateway settlement anchor 必须绑定 API Key');
    }

    const [user, product] = await Promise.all([
      this.resolveUser(input),
      this.resolveProduct(input),
    ]);
    const tenantId = await this.resolveTenantForUser(input.tenantId, user, product);
    const billingAccount = tenantId ? await this.resolveTenantBillingAccount(tenantId) : null;
    return {
      user,
      product,
      tenantId,
      billingAccountId: billingAccount?.id ?? null,
      billingAccountType: billingAccount?.type ?? null,
      billingAccountCurrency: billingAccount?.currency ?? null,
    };
  }

  private subscriptionFromSettlementAnchor(
    anchor: GatewaySettlementAnchor,
  ): ResolvedSubscription | null {
    if (anchor.billingUnit !== 'CREDITS') return null;
    const entitlement = anchor.entitlementSnapshot;
    const plan = anchor.planSnapshot;
    if (!anchor.subscriptionId || !anchor.planId || !entitlement || !plan) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway CREDITS settlement anchor 缺少冻结权益快照',
      );
    }
    if (plan.id !== anchor.planId) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway settlement anchor 套餐快照不一致',
      );
    }
    return {
      subscriptionId: anchor.subscriptionId,
      entitlementKind: entitlement.entitlementKind,
      codingPlanEntitlementId: anchor.codingPlanEntitlementId,
      planId: anchor.planId,
      productId: anchor.productId,
      billingPeriod: entitlement.billingPeriod,
      fulfillmentMode: entitlement.fulfillmentMode,
      providerEntitlementId: entitlement.providerEntitlementId,
      providerLineId: entitlement.providerLineId,
      providerLineCode: entitlement.providerLineCode,
      providerCode: entitlement.providerCode,
      upstreamProductId: entitlement.upstreamProductId,
      plan,
    };
  }

  private canonicalGatewayCustomerSettlementInput(
    input: UsageDeductInput,
    anchor: GatewaySettlementAnchor,
  ): UsageDeductInput {
    const normalized = this.normalizeQuoteInput(input);
    const anchorPolicyVersion = anchor.customerSettlementPolicyVersion;
    if (anchorPolicyVersion !== LATEST_GATEWAY_CUSTOMER_SETTLEMENT_POLICY_VERSION) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway settlement anchor customer policy version 无效',
      );
    }
    const originalDimensions = this.gatewayCustomerDimensionsFromQuote(
      anchor.customerQuoteSnapshot,
    );
    const settledDimensions = this.gatewayCustomerDimensionsFromQuote(normalized);
    const settlement = input.gatewayCustomerSettlement ?? (
      Object.entries(originalDimensions).every(
        ([key, value]) => settledDimensions[key as keyof typeof settledDimensions] === value,
      )
        ? {
            policyVersion: anchorPolicyVersion,
            basis: 'NORMALIZED_EXACT' as const,
            evidenceReason: 'none',
            originalDimensions,
            settledDimensions,
          }
        : null
    );
    if (!settlement || settlement.policyVersion !== anchorPolicyVersion) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway settlement 缺少与 first-receipt anchor 一致的 customer policy annotation',
      );
    }
    if (
      settlement.basis !== 'NORMALIZED_EXACT'
      && settlement.basis !== 'CUSTOMER_PROTECTIVE_ZERO'
    ) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway settlement basis 与 first-receipt customer policy 不一致',
      );
    }
    this.assertGatewayCustomerDimensions(
      settlement.originalDimensions,
      originalDimensions,
      'original',
    );
    this.assertGatewayCustomerDimensions(
      settlement.settledDimensions,
      settledDimensions,
      'settled',
    );

    const isExact = settlement.basis === 'NORMALIZED_EXACT';
    if (isExact) {
      this.assertGatewayCustomerDimensions(
        originalDimensions,
        settledDimensions,
        'exact',
      );
    } else {
      if (!Object.values(settledDimensions).every((value) => value === 0)) {
        throw new GatewaySettlementAnchorConflictError(
          'Gateway customer-protective settlement must set every customer meter to zero',
        );
      }
      const settledQuote = this.frozenQuoteFromSettlementAnchor(normalized, anchor);
      const originalAmount = this.gatewayCustomerAmount(anchor.customerQuoteSnapshot);
      const settledAmount = this.gatewayCustomerAmount(settledQuote);
      if (
        originalAmount.unit !== settledAmount.unit
        || !settledAmount.value.isZero()
      ) {
        throw new GatewaySettlementAnchorConflictError(
          'Gateway customer-protective settlement must have a zero frozen charge',
        );
      }
    }

    return {
      ...input,
      inputTokens: settledDimensions.inputTokens,
      outputTokens: settledDimensions.outputTokens,
      cachedInputTokens: settledDimensions.cachedInputTokens,
      cacheWriteInputTokens: settledDimensions.cacheWriteInputTokens,
      totalTokens: settledDimensions.totalTokens,
      imageCount: settledDimensions.imageCount,
      recordTokenUsage: true,
      gatewayCustomerSettlement: settlement,
    };
  }

  private gatewayCustomerDimensionsFromQuote(
    quote: Pick<
      NormalizedUsageQuoteInput,
      | 'inputTokens'
      | 'outputTokens'
      | 'cachedInputTokens'
      | 'cacheWriteInputTokens'
      | 'imageCount'
    >,
  ): NonNullable<UsageDeductInput['gatewayCustomerSettlement']>['originalDimensions'] {
    const dimensions = {
      inputTokens: quote.inputTokens,
      outputTokens: quote.outputTokens,
      cachedInputTokens: quote.cachedInputTokens,
      cacheWriteInputTokens: quote.cacheWriteInputTokens,
      totalTokens: quote.inputTokens + quote.outputTokens,
      imageCount: quote.imageCount,
    };
    if (
      !Object.values(dimensions).every(
        (value) => Number.isSafeInteger(value) && value >= 0,
      )
      || dimensions.cachedInputTokens + dimensions.cacheWriteInputTokens
        > dimensions.inputTokens
    ) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway canonical customer dimensions are invalid',
      );
    }
    return dimensions;
  }

  private assertGatewayCustomerDimensions(
    actual: NonNullable<UsageDeductInput['gatewayCustomerSettlement']>['originalDimensions'],
    expected: NonNullable<UsageDeductInput['gatewayCustomerSettlement']>['originalDimensions'],
    label: string,
  ): void {
    const keys: Array<keyof typeof expected> = [
      'inputTokens',
      'outputTokens',
      'cachedInputTokens',
      'cacheWriteInputTokens',
      'totalTokens',
      'imageCount',
    ];
    if (keys.some((key) => actual[key] !== expected[key])) {
      throw new GatewaySettlementAnchorConflictError(
        `Gateway ${label} customer dimensions do not match financial authority`,
      );
    }
  }

  private gatewayCustomerAmount(quote: UsageQuoteResult): {
    unit: 'USD' | 'CREDITS';
    value: Prisma.Decimal;
    canonical: string;
  } {
    if (quote.unit === 'CREDITS') {
      if (!Number.isSafeInteger(quote.creditCost) || quote.creditCost < 0) {
        throw new GatewaySettlementAnchorConflictError(
          'Gateway canonical CREDITS amount is invalid',
        );
      }
      return {
        unit: 'CREDITS',
        value: new Prisma.Decimal(quote.creditCost),
        canonical: String(quote.creditCost),
      };
    }
    const value = new Prisma.Decimal(quote.effectiveCostUsd);
    if (!value.isFinite() || value.lt(0)) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway canonical BALANCE amount is invalid',
      );
    }
    const canonical = value
      .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP)
      .toFixed(12);
    return { unit: 'USD', value: new Prisma.Decimal(canonical), canonical };
  }

  private assertSettlementInputMatchesAnchor(
    input: UsageQuoteInput & { requestId?: string },
    anchor: GatewaySettlementAnchor,
  ): void {
    const occurredAt = this.eventOccurredAtForSettlement(input);
    const mismatched =
      input.requestId?.trim() !== anchor.requestId ||
      input.apiKeyId?.trim() !== anchor.apiKeyId ||
      (input.userId?.trim() && input.userId.trim() !== anchor.userId) ||
      (input.tenantId?.trim() && input.tenantId.trim() !== anchor.tenantId) ||
      (input.productId?.trim() && input.productId.trim() !== anchor.productId) ||
      (input.productSlug?.trim() && input.productSlug.trim() !== anchor.productSlug) ||
      !occurredAt || occurredAt.getTime() !== anchor.occurredAt.getTime();
    if (mismatched) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway settlement input 与首次收件锚点不一致',
      );
    }
  }

  /**
   * Validate only the immutable financial target for a request that was
   * already delivered. Key rotation, member removal, owner transfer, or a
   * later tenant/account rebind must not erase the original debt, and must
   * never redirect it to the replacement account. Mutable identity fields are
   * therefore intentionally not compared here; first receipt remains strict
   * through assertGatewaySettlementAnchorBinding().
   */
  private async assertGatewaySettlementFinancialTarget(
    db: Prisma.TransactionClient | PrismaService,
    anchor: GatewaySettlementAnchor,
    lockRows: boolean,
  ): Promise<void> {
    return timed('stlTargetAssert', () => this.assertGatewaySettlementFinancialTargetInner(db, anchor, lockRows));
  }

  private async assertGatewaySettlementFinancialTargetInner(
    db: Prisma.TransactionClient | PrismaService,
    anchor: GatewaySettlementAnchor,
    lockRows: boolean,
  ): Promise<void> {
    if (lockRows) {
      await db.$queryRaw`SELECT "billing_account_id" FROM "account_wallets" WHERE "billing_account_id" = ${anchor.billingAccountId} FOR SHARE`;
      await db.$queryRaw`SELECT "id" FROM "billing_accounts" WHERE "id" = ${anchor.billingAccountId} FOR SHARE`;
    }
    const [wallet, billingAccount] = await Promise.all([
      db.accountWallet.findUnique({
        where: { billingAccountId: anchor.billingAccountId },
        select: { billingAccountId: true },
      }),
      db.billingAccount.findUnique({
        where: { id: anchor.billingAccountId },
        select: { id: true, currency: true },
      }),
    ]);
    if (!wallet || !billingAccount) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway settlement 原始财务主体已缺失，必须人工处理',
      );
    }
    if (anchor.billingCurrency !== null) {
      // An accepted first receipt freezes the financial currency. Settlement
      // retries continue against that anchor even if deployment configuration
      // changes later; only drift of the original account itself is unsafe.
      const accountCurrency = normalizeCurrencyCode(
        billingAccount.currency,
      ).toUpperCase();
      if (
        !/^[A-Z]{3}$/.test(anchor.billingCurrency)
        || accountCurrency !== anchor.billingCurrency
      ) {
        throw new GatewaySettlementAnchorConflictError(
          'Gateway settlement anchor billing currency 已漂移',
        );
      }
    }
  }

  private async assertGatewaySettlementAnchorBinding(
    db: Prisma.TransactionClient | PrismaService,
    anchor: GatewaySettlementAnchor,
    lockRows: boolean,
  ): Promise<void> {
    if (lockRows) {
      await db.$queryRaw`SELECT "id" FROM "api_keys" WHERE "id" = ${anchor.apiKeyId} FOR SHARE`;
      await db.$queryRaw`SELECT "id" FROM "tenants" WHERE "id" = ${anchor.tenantId} FOR SHARE`;
      await db.$queryRaw`SELECT "id" FROM "products" WHERE "id" = ${anchor.productId} FOR SHARE`;
      if (anchor.codingPlanEntitlementId) {
        await db.$queryRaw`SELECT "id" FROM "coding_plan_entitlements" WHERE "id" = ${anchor.codingPlanEntitlementId} FOR SHARE`;
      } else if (anchor.subscriptionId) {
        await db.$queryRaw`SELECT "id" FROM "subscription_periods" WHERE "id" = ${anchor.subscriptionId} FOR SHARE`;
      }
    }
    const [key, tenant, product, billingAccount] = await Promise.all([
      db.apiKey.findUnique({
        where: { id: anchor.apiKeyId },
        select: {
          userId: true,
          tenantId: true,
          productId: true,
          codingPlanEntitlementId: true,
        },
      }),
      db.tenant.findUnique({
        where: { id: anchor.tenantId },
        select: { billingAccountId: true },
      }),
      db.product.findUnique({
        where: { id: anchor.productId },
        select: { slug: true },
      }),
      db.billingAccount.findUnique({
        where: { id: anchor.billingAccountId },
        select: { currency: true },
      }),
    ]);
    const keyProductMatches = key?.productId == null || key.productId === anchor.productId;
    if (
      !key || !tenant || !product || !billingAccount ||
      key.userId !== anchor.userId ||
      key.tenantId !== anchor.tenantId ||
      !keyProductMatches ||
      (key.codingPlanEntitlementId ?? null) !== anchor.codingPlanEntitlementId ||
      tenant.billingAccountId !== anchor.billingAccountId ||
      product.slug !== anchor.productSlug
    ) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway settlement anchor 检测到 API Key/租户/产品主体漂移',
      );
    }
    if (anchor.billingCurrency !== null) {
      const accountCurrency = normalizeCurrencyCode(
        billingAccount.currency,
      ).toUpperCase();
      const deploymentConfig = await this.systemConfig?.getDeploymentConfig(db);
      const deploymentCurrency = resolvePlatformCurrency(
        this.config,
        deploymentConfig,
      ).currencyCode;
      if (
        !/^[A-Z]{3}$/.test(anchor.billingCurrency)
        || accountCurrency !== anchor.billingCurrency
      ) {
        throw new GatewaySettlementAnchorConflictError(
          'Gateway settlement anchor billing currency 已漂移',
        );
      }
      if (deploymentCurrency !== anchor.billingCurrency) {
        throw new GatewayBillingCurrencyMigrationRequiredError(
          accountCurrency,
          deploymentCurrency,
          anchor.billingAccountId,
          anchor.apiKeyId,
        );
      }
    }
    if (anchor.billingUnit !== 'CREDITS') return;
    if (!anchor.subscriptionId || !anchor.planId) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway CREDITS settlement anchor 缺少 subscription/plan',
      );
    }
    if (anchor.codingPlanEntitlementId) {
      const entitlement = await db.codingPlanEntitlement.findUnique({
        where: { id: anchor.codingPlanEntitlementId },
        select: {
          id: true,
          userId: true,
          tenantId: true,
          productId: true,
          planId: true,
          status: true,
        },
      });
      if (
        !entitlement || entitlement.id !== anchor.subscriptionId ||
        entitlement.userId !== anchor.userId ||
        entitlement.tenantId !== anchor.tenantId ||
        entitlement.productId !== anchor.productId ||
        entitlement.planId !== anchor.planId ||
        (lockRows && entitlement.status !== 'ACTIVE')
      ) {
        throw new GatewaySettlementAnchorConflictError(
          'Gateway settlement anchor 检测到 Coding Plan 权益漂移',
        );
      }
      return;
    }
    const period = await db.subscriptionPeriod.findUnique({
      where: { id: anchor.subscriptionId },
      select: {
        id: true,
        userId: true,
        tenantId: true,
        billingAccountId: true,
        productId: true,
        planId: true,
      },
    });
    if (
      !period || period.userId !== anchor.userId ||
      period.tenantId !== anchor.tenantId ||
      (period.billingAccountId ?? anchor.billingAccountId) !== anchor.billingAccountId ||
      period.productId !== anchor.productId || period.planId !== anchor.planId
    ) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway settlement anchor 检测到订阅权益漂移',
      );
    }
  }

  private effectiveTenantId(context: ResolvedContext): string {
    const contextTenantId = context.tenantId?.trim();
    if (contextTenantId) return contextTenantId;
    throw new BadRequestException('用量计费必须绑定账号 tenantId');
  }

  private async resolveContextByApiKey(
    input: UsageQuoteInput,
    apiKeyId: string,
    db?: Prisma.TransactionClient,
  ): Promise<ResolvedContext> {
    const reader = db ?? this.prisma;
    const key = await reader.apiKey.findFirst({
      where: { id: apiKeyId },
      include: {
        user: true,
        product: true,
        tenant: {
          select: {
            billingAccountId: true,
            billingAccount: { select: { type: true, currency: true } },
          },
        },
      },
    });
    if (!key) {
      throw new NotFoundException('API Key 不存在或已删除');
    }
    const eventOccurredAt = this.eventOccurredAtForSettlement(input);
    const deletedAt = key.deletedAt;
    const isHistoricalDeletedKeyUsage = Boolean(
      deletedAt &&
        eventOccurredAt &&
        eventOccurredAt.getTime() < deletedAt.getTime(),
    );
    if (deletedAt && !isHistoricalDeletedKeyUsage) {
      throw new NotFoundException('API Key 不存在或已删除');
    }
    if (!isHistoricalDeletedKeyUsage) {
      if (!key.isActive) {
        throw new BadRequestException('API Key 已停用');
      }
      if (key.mirrorStatus !== 'ACTIVE') {
        throw new BadRequestException('API Key 尚未完成账务开通');
      }
    }
    if (db && !key.product) {
      throw new BadRequestException('api_key_product_unbound');
    }
    const product = key.product ?? await this.resolveProductForUnboundApiKey(input, apiKeyId);
    const tenantId = this.tenantIdForApiKey(
      key.tenantId,
      input.tenantId,
      apiKeyId,
    );
    return {
      user: key.user,
      product,
      tenantId,
      billingAccountId: key.tenant?.billingAccountId ?? null,
      billingAccountType: key.tenant?.billingAccount?.type ?? null,
      billingAccountCurrency: key.tenant?.billingAccount?.currency ?? null,
      codingPlanEntitlementId: key.codingPlanEntitlementId,
    };
  }

  private async resolveTenantBillingAccount(
    tenantId: string,
  ): Promise<{ id: string | null; type: string | null; currency: string | null } | null> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: {
        billingAccountId: true,
        billingAccount: { select: { type: true, currency: true } },
      },
    });
    if (!tenant) return null;
    return {
      id: tenant.billingAccountId ?? null,
      type: tenant.billingAccount?.type ?? null,
      currency: tenant.billingAccount?.currency ?? null,
    };
  }

  private eventOccurredAtForSettlement(input: UsageQuoteInput): Date | null {
    const value = input.eventOccurredAt;
    if (value === undefined || value === null || value === '') return null;
    const occurredAt = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(occurredAt.getTime())) {
      throw new BadRequestException('eventOccurredAt 必须是有效时间');
    }
    return occurredAt;
  }

  private tenantIdForApiKey(
    keyTenantId: string | null | undefined,
    eventTenantId: string | null | undefined,
    apiKeyId: string,
  ): string {
    const normalizedKeyTenantId = keyTenantId?.trim();
    if (normalizedKeyTenantId) return normalizedKeyTenantId;
    if (eventTenantId?.trim()) {
      this.logger.warn(
        `reject gateway tenantId for apiKey without tenant binding apiKeyId=${apiKeyId}`,
      );
    }
    throw new BadRequestException('API Key 必须绑定账号 tenantId');
  }

  private async resolveTenantForUser(
    requestedTenantId: string | null | undefined,
    user: User | null,
    product?: Product,
  ): Promise<string | null> {
    const tenantId = requestedTenantId?.trim();
    if (!tenantId) {
      if (!user) return null;
      if (product?.billingMode === 'CODING_PLAN') return this.resolvePersonalTenantId(user.id);
      return this.resolveRequiredTenantId(user.id);
    }

    if (!user) {
      gatewayTenantMismatchTotal.inc({ reason: 'non_api_key_tenant_without_user' });
      throw new BadRequestException('tenantId 需要匹配的 userId 或 email');
    }

    const membership = await this.prisma.tenantMember.findFirst({
      where: {
        tenantId,
        userId: user.id,
        status: 'active',
        tenant: {
          status: 'active',
          deletedAt: null,
        },
      },
      select: { id: true },
    });
    if (!membership) {
      gatewayTenantMismatchTotal.inc({ reason: 'non_api_key_tenant_membership_mismatch' });
      throw new BadRequestException('tenantId 与用户不匹配或团队不可用');
    }

    return tenantId;
  }

  private async resolveRequiredTenantId(userId: string): Promise<string> {
    const user = await this.prisma.user.findUnique({
      where: { id: userId },
      select: { currentTenantId: true },
    });
    if (user?.currentTenantId) {
      const membership = await this.prisma.tenantMember.findFirst({
        where: {
          userId,
          tenantId: user.currentTenantId,
          status: 'active',
          tenant: { status: 'active', deletedAt: null },
        },
        select: { tenantId: true },
      });
      if (membership) return membership.tenantId;
    }

    const personalTenant = await this.prisma.tenant.findFirst({
      where: {
        ownerUserId: userId,
        type: 'personal',
        status: 'active',
        deletedAt: null,
      },
      select: { id: true },
    });
    if (personalTenant) return personalTenant.id;

    const membership = await this.prisma.tenantMember.findFirst({
      where: {
        userId,
        status: 'active',
        tenant: { status: 'active', deletedAt: null },
      },
      select: { tenantId: true },
      orderBy: { joinedAt: 'asc' },
    });
    if (membership) return membership.tenantId;

    throw new BadRequestException('用量计费必须绑定账号 tenantId');
  }

  private async resolvePersonalTenantId(userId: string): Promise<string> {
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
    throw new BadRequestException('用量计费必须绑定账号 tenantId');
  }

  private requireQuoteTenantId(quote: UsageQuoteResult): string {
    const tenantId = quote.tenantId?.trim();
    if (!tenantId) {
      throw new BadRequestException('用量记录必须绑定账号 tenantId');
    }
    return tenantId;
  }

  private resolveProviderCodeForTokenUsage(
    input: UsageDeductInput,
    quote: UsageQuoteResult,
  ): string | null {
    return this.providerCodeOrNull(quote.providerCode)
      ?? this.providerCodeOrNull(input.providerCode)
      ?? this.providerCodeFromSource(input.source);
  }

  private resolveProviderLineIdForTokenUsage(
    input: UsageDeductInput,
    quote: UsageQuoteResult,
  ): string | null {
    if (quote.unit === 'CREDITS' && quote.providerLineId?.trim()) {
      return quote.providerLineId.trim();
    }
    return input.providerLineId?.trim() || null;
  }

  private providerCodeFromSource(source: string | null | undefined): string | null {
    const normalized = source?.trim();
    if (!normalized?.startsWith('gateway:')) return null;
    const parts = normalized.split(':');
    return this.providerCodeOrNull(parts[2]);
  }

  private providerCodeOrNull(value: string | null | undefined): string | null {
    const normalized = value?.trim();
    if (!normalized || normalized === 'unknown-provider') return null;
    return normalized;
  }

  private async resolveUser(input: UsageQuoteInput): Promise<User | null> {
    if (input.userId) {
      const user = await this.prisma.user.findUnique({ where: { id: input.userId } });
      if (!user) throw new NotFoundException('用户不存在');
      return user;
    }
    if (input.email) {
      const user = await this.prisma.user.findUnique({ where: { email: input.email } });
      if (!user) throw new NotFoundException('用户不存在');
      return user;
    }
    return null;
  }

  private async resolveProduct(input: UsageQuoteInput): Promise<Product> {
    if (input.productId) {
      const product = await this.prisma.product.findFirst({ where: { id: input.productId, deletedAt: null } });
      if (!product) throw new NotFoundException('产品不存在');
      return product;
    }
    if (input.productSlug) {
      const product = await this.prisma.product.findFirst({ where: { slug: input.productSlug, deletedAt: null } });
      if (!product) throw new NotFoundException('产品不存在');
      return product;
    }
    if (!this.allowDefaultPaygFallback()) {
      throw new BadRequestException('productId 或 productSlug 必填');
    }
    const payg = await this.prisma.product.findFirst({
      where: { slug: 'PAYG', deletedAt: null, isActive: true },
    });
    if (payg) return payg;
    throw new BadRequestException('productId 或 productSlug 必填');
  }

  private resolveBillingUnit(
    requested: UsageQuoteInput['billingUnit'],
    product: Product,
    codingPlanEntitlementId?: string | null,
  ): UsageBillingUnit {
    // 计费分界（codingplan-all §4.3）：CODING_PLAN 产品但未绑定 entitlement 的请求一律按余额计费，
    // 不得划入套餐积分池——即便显式请求 CREDITS。专属（绑 entitlement）key 才走套餐积分。
    // 注：非 key 入口（无 apiKeyId）也无 codingPlanEntitlementId，同样走 BALANCE，属有意决策
    // （资金方向偏保守，避免误扣套餐积分）；如需支持非 key 的套餐积分计费须在 resolveContext 补解析。
    if (
      product.billingMode === 'CODING_PLAN' &&
      !codingPlanEntitlementId?.trim()
    ) {
      return 'BALANCE';
    }
    if (requested === 'BALANCE' || requested === 'CREDITS') return requested;
    return product.billingMode === 'PAY_AS_YOU_GO' ? 'BALANCE' : 'CREDITS';
  }

  private async resolveUsagePolicy(
    productId: string,
    modelName: string,
    userId: string | null,
    billingAccountId: string | null,
    billingAccountType: string | null,
    effectiveAt: Date,
    unit: UsageBillingUnit,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<PolicySnapshot> {
    if (
      billingAccountId &&
      billingAccountType === ENTERPRISE_BILLING_ACCOUNT_TYPE
    ) {
      return this.resolveEnterpriseModelPolicy(
        billingAccountId,
        productId,
        modelName,
        db,
      );
    }

    const segmentIds = userId ? await this.findUserSegmentIds(userId, db) : [];
    const candidates = await db.usagePricingPolicy.findMany({
      where: {
        productId,
        isActive: true,
        OR: [
          { startsAt: null },
          { startsAt: { lte: effectiveAt } },
        ],
        AND: [
          {
            OR: [
              { endsAt: null },
              { endsAt: { gt: effectiveAt } },
            ],
          },
          {
            OR: [
              { scope: 'GLOBAL' },
              ...(userId ? [{ scope: 'USER' as const, userId }] : []),
              ...(segmentIds.length > 0
                ? [{ scope: 'SEGMENT' as const, segmentId: { in: segmentIds } }]
                : []),
            ],
          },
          {
            OR: [
              { modelName: null },
              { modelName },
            ],
          },
        ],
      },
    });

    const winner = candidates
      .filter((policy) => this.policyApplies(policy, userId, segmentIds, modelName))
      .sort((a, b) => this.comparePoliciesByEffectiveMultiplier(a, b, modelName, unit))[0];

    return winner ? this.toPolicySnapshot(winner) : this.defaultPolicy();
  }

  private async resolveEnterpriseModelPolicy(
    billingAccountId: string,
    productId: string,
    modelName: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<PolicySnapshot> {
    const discount = await db.enterpriseModelDiscount.findUnique({
      where: {
        billingAccountId_productId_modelName: {
          billingAccountId,
          productId,
          modelName,
        },
      },
    });
    if (!discount?.isActive) {
      return this.defaultPolicy();
    }
    return {
      id: discount.id,
      scope: 'ENTERPRISE',
      modelName: discount.modelName,
      priceMultiplier: discount.priceMultiplier.toString(),
      creditMultiplier: null,
      priority: 0,
    };
  }

  private async findUserSegmentIds(
    userId: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<string[]> {
    const memberships = await db.userSegmentMember.findMany({
      where: {
        userId,
        segment: { isActive: true, deletedAt: null },
      },
      select: { segmentId: true },
    });
    return memberships.map((m) => m.segmentId);
  }

  private policyApplies(
    policy: UsagePricingPolicy,
    userId: string | null,
    segmentIds: string[],
    modelName: string,
  ): boolean {
    if (policy.modelName && policy.modelName !== modelName) return false;
    if (policy.scope === 'GLOBAL') return true;
    if (policy.scope === 'USER') return !!userId && policy.userId === userId;
    return !!policy.segmentId && segmentIds.includes(policy.segmentId);
  }

  private policyScore(policy: UsagePricingPolicy, modelName: string): number {
    const scopeScore =
      policy.scope === 'USER'
        ? 400
        : policy.scope === 'SEGMENT'
          ? 200
          : 100;
    const modelScore = policy.modelName === modelName ? 50 : 0;
    const createdAtScore = Math.floor(policy.createdAt.getTime() / 1000) / 1_000_000_000;
    return scopeScore + modelScore + policy.priority + createdAtScore;
  }

  private comparePoliciesByEffectiveMultiplier(
    a: UsagePricingPolicy,
    b: UsagePricingPolicy,
    modelName: string,
    unit: UsageBillingUnit,
  ): number {
    const multiplierCompare = this.policyEffectiveMultiplier(a, unit)
      .comparedTo(this.policyEffectiveMultiplier(b, unit));
    if (multiplierCompare !== 0) return multiplierCompare;
    return this.policyScore(b, modelName) - this.policyScore(a, modelName);
  }

  private policyEffectiveMultiplier(
    policy: UsagePricingPolicy,
    unit: UsageBillingUnit,
  ): Prisma.Decimal {
    const raw = unit === 'CREDITS'
      ? policy.creditMultiplier ?? policy.priceMultiplier
      : policy.priceMultiplier;
    return new Prisma.Decimal(raw);
  }

  private toPolicySnapshot(policy: UsagePricingPolicy): PolicySnapshot {
    return {
      id: policy.id,
      scope: policy.scope,
      modelName: policy.modelName,
      priceMultiplier: policy.priceMultiplier.toString(),
      creditMultiplier: policy.creditMultiplier?.toString() ?? null,
      priority: policy.priority,
    };
  }

  private defaultPolicy(): PolicySnapshot {
    return {
      id: null,
      scope: 'DEFAULT',
      modelName: null,
      priceMultiplier: '1',
      creditMultiplier: null,
      priority: 0,
    };
  }

  private scopedIdempotencyWhere(key: string): Prisma.IdempotencyKeyWhereUniqueInput {
    return { key_scope: { key, scope: this.idempotencyScope } };
  }

  private gatewayFinancialReceiptKey(context: GatewaySettlementContext): string {
    return `gateway:financial:${context.anchor.requestId}:${context.anchor.anchorHash}`;
  }

  private gatewaySettlementFingerprint(
    input: UsageDeductInput,
    context: GatewaySettlementContext,
  ): string {
    const customerSettlement = input.gatewayCustomerSettlement
      ? {
          policyVersion: input.gatewayCustomerSettlement.policyVersion,
          basis: input.gatewayCustomerSettlement.basis,
          originalDimensions: input.gatewayCustomerSettlement.originalDimensions,
          settledDimensions: input.gatewayCustomerSettlement.settledDimensions,
        }
      : null;
    const payload = {
      requestId: context.anchor.requestId,
      anchorHash: context.anchor.anchorHash,
      pricingHash: context.anchor.pricingHash,
      evidenceHash: context.evidenceHash,
      source: input.source,
      modelName: input.modelName,
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      cachedInputTokens: input.cachedInputTokens ?? 0,
      cacheWriteInputTokens: input.cacheWriteInputTokens ?? 0,
      imageCount: input.imageCount ?? 0,
      totalTokens: input.totalTokens ?? 0,
      providerCode: input.providerCode ?? null,
      providerLineId: input.providerLineId ?? null,
      // evidenceReason is mutable internal reconciliation classification
      // (for example when a producer build is later authorized). Financial
      // replay identity binds only the frozen policy and charged dimensions.
      gatewayCustomerSettlement: customerSettlement,
    };
    return createHash('sha256').update(canonicalJson(payload)).digest('hex');
  }

  private async findGatewayFinancialReceiptReplay(
    input: UsageDeductInput,
    context: GatewaySettlementContext,
    settlementFingerprint: string,
  ): Promise<Record<string, unknown> | null> {
    return timed('stlReplayCheck', () => this.findGatewayFinancialReceiptReplayInner(input, context, settlementFingerprint));
  }

  private async findGatewayFinancialReceiptReplayInner(
    input: UsageDeductInput,
    context: GatewaySettlementContext,
    settlementFingerprint: string,
  ): Promise<Record<string, unknown> | null> {
    const receipt = await this.prisma.gatewayUsageSettlementReceipt.findUnique({
      where: { idempotencyKey: this.gatewayFinancialReceiptKey(context) },
      select: {
        gatewayBillingEventId: true,
        requestId: true,
        evidenceHash: true,
        anchorHash: true,
        pricingHash: true,
        settlementFingerprint: true,
        billingUnit: true,
        creditAmount: true,
        tokenUsageId: true,
        fundingOutcome: true,
        policyVersion: true,
        payload: true,
      },
    });
    if (!receipt) return null;
    if (
      receipt.policyVersion !== 'gateway-settlement-v2'
      && receipt.policyVersion !== 'gateway-settlement-v3-customer-authority'
    ) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway 永久资金回执 policy version 不受支持',
      );
    }
    if (
      receipt.gatewayBillingEventId !== context.gatewayBillingEventId ||
      receipt.requestId !== context.anchor.requestId ||
      receipt.evidenceHash !== context.evidenceHash ||
      receipt.anchorHash !== context.anchor.anchorHash ||
      receipt.pricingHash !== context.anchor.pricingHash ||
      receipt.billingUnit !== context.anchor.billingUnit
    ) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway 永久资金回执与 settlement anchor 不一致',
      );
    }
    const payload = receipt.payload;
    if (!payload || Array.isArray(payload) || typeof payload !== 'object') {
      throw new GatewaySettlementAnchorConflictError('Gateway 永久资金回执 payload 无效');
    }
    const billingResult = (payload as Record<string, unknown>).billingResult;
    if (!billingResult || Array.isArray(billingResult) || typeof billingResult !== 'object') {
      throw new GatewaySettlementAnchorConflictError('Gateway 永久资金回执缺少 billingResult');
    }
    if (receipt.policyVersion === 'gateway-settlement-v2') {
      // v2 receipts were fingerprinted from the pre-authority raw settlement
      // input. Reconstructing that input after deploy-time normalization or
      // cache clamping is not generally possible. Treat the already-committed
      // receipt as the immutable financial fact, but require its durable
      // column and payload copies to agree. v3 receipts below are instead
      // re-derived from the canonical customer authority.
      const legacyPayloadFingerprint = (payload as Record<string, unknown>)
        .settlementFingerprint;
      if (
        !receipt.tokenUsageId?.trim()
        || typeof receipt.settlementFingerprint !== 'string'
        || !/^[a-f0-9]{64}$/i.test(receipt.settlementFingerprint)
        || typeof legacyPayloadFingerprint !== 'string'
        || legacyPayloadFingerprint !== receipt.settlementFingerprint
        || (payload as Record<string, unknown>).anchorHash !== receipt.anchorHash
        || (payload as Record<string, unknown>).pricingHash !== receipt.pricingHash
      ) {
        throw new GatewaySettlementAnchorConflictError(
          'Gateway v2 永久资金回执 fingerprint 自身不一致',
        );
      }
    } else if (receipt.settlementFingerprint !== settlementFingerprint) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway v3 永久资金回执与 canonical settlement fingerprint 不一致',
      );
    }
    const expectedFundingOutcome = receipt.policyVersion === 'gateway-settlement-v2'
      ? this.gatewayLegacyV2FundingOutcome(billingResult as Record<string, unknown>)
      : this.gatewayFundingOutcome(billingResult as Record<string, unknown>);
    if (receipt.fundingOutcome !== expectedFundingOutcome) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway 永久资金回执 funding outcome 与 billingResult 不一致',
      );
    }
    if (receipt.creditAmount !== this.gatewayCreditAmount(
      billingResult as Record<string, unknown>,
    )) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway 永久资金回执 credit amount 与 billingResult 不一致',
      );
    }
    if (receipt.policyVersion === 'gateway-settlement-v3-customer-authority') {
      const storedAuthority = (payload as Record<string, unknown>)
        .customerFinancialAuthority;
      const expectedAuthority = this.gatewayCustomerFinancialAuthority(
        input,
        context,
        settlementFingerprint,
        billingResult as Record<string, unknown>,
        receipt.tokenUsageId,
      );
      if (canonicalJson(storedAuthority) !== canonicalJson(expectedAuthority)) {
        throw new GatewaySettlementAnchorConflictError(
          'Gateway 永久资金回执 customer financial authority 不一致',
        );
      }
    }
    return billingResult as Record<string, unknown>;
  }

  private async persistGatewayFinancialReceipt(
    db: Prisma.TransactionClient,
    input: UsageDeductInput,
    context: GatewaySettlementContext,
    settlementFingerprint: string,
    billingResult: Record<string, unknown>,
    tokenUsageId?: string | null,
  ): Promise<void> {
    return timed('stlReceipt', () => this.persistGatewayFinancialReceiptInner(db, input, context, settlementFingerprint, billingResult, tokenUsageId));
  }

  private async persistGatewayFinancialReceiptInner(
    db: Prisma.TransactionClient,
    input: UsageDeductInput,
    context: GatewaySettlementContext,
    settlementFingerprint: string,
    billingResult: Record<string, unknown>,
    tokenUsageId?: string | null,
  ): Promise<void> {
    await db.$queryRaw`SELECT "id" FROM "gateway_billing_events" WHERE "id" = ${context.gatewayBillingEventId} FOR UPDATE`;
    await db.$queryRaw`SELECT "id" FROM "gateway_usage_settlement_anchors" WHERE "gateway_billing_event_id" = ${context.gatewayBillingEventId} FOR SHARE`;
    await db.$queryRaw`SELECT "id" FROM "gateway_usage_evidences" WHERE "gateway_billing_event_id" = ${context.gatewayBillingEventId} AND "evidence_hash" = ${context.evidenceHash} FOR SHARE`;
    const [event, anchor, selectedEvidence] = await Promise.all([
      db.gatewayBillingEvent.findUnique({
        where: { id: context.gatewayBillingEventId },
        select: { requestId: true, revision: true },
      }),
      db.gatewayUsageSettlementAnchor.findUnique({
        where: { gatewayBillingEventId: context.gatewayBillingEventId },
        select: {
          requestId: true,
          anchorHash: true,
          pricingHash: true,
          billingCurrency: true,
        },
      }),
      db.gatewayUsageEvidence.findFirst({
        where: {
          gatewayBillingEventId: context.gatewayBillingEventId,
          evidenceHash: context.evidenceHash,
          source: 'GATEWAY_USAGE_EVENT',
        },
        select: { requestId: true, evidenceHash: true, rawEvidence: true },
      }),
    ]);
    if (
      !event || event.requestId !== context.anchor.requestId ||
      event.revision !== context.expectedRevision
    ) {
      throw new GatewayBillingRevisionConflictError();
    }
    if (
      !selectedEvidence ||
      selectedEvidence.requestId !== context.anchor.requestId ||
      selectedEvidence.evidenceHash !== context.evidenceHash
    ) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway settlement 所选权威证据不存在或哈希不一致',
      );
    }
    if (
      !anchor || anchor.requestId !== context.anchor.requestId ||
      anchor.anchorHash !== context.anchor.anchorHash ||
      anchor.pricingHash !== context.anchor.pricingHash ||
      anchor.billingCurrency !== context.anchor.billingCurrency
    ) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway settlement anchor 持久化记录不一致',
      );
    }
    await this.assertGatewaySettlementFinancialTarget(db, context.anchor, true);
    const fundingOutcome = this.gatewayFundingOutcome(billingResult);
    const amountUsd = this.gatewayEventSettlementAmountUsd(billingResult);
    const customerFinancialAuthority = this.gatewayCustomerFinancialAuthority(
      input,
      context,
      settlementFingerprint,
      billingResult,
      tokenUsageId,
    );
    await db.gatewayUsageSettlementReceipt.create({
      data: {
        gatewayBillingEventId: context.gatewayBillingEventId,
        requestId: context.anchor.requestId,
        settlementRevision: context.expectedRevision + 1,
        fundingOutcome,
        evidenceHash: context.evidenceHash,
        anchorHash: context.anchor.anchorHash,
        pricingHash: context.anchor.pricingHash,
        settlementFingerprint,
        billingUnit: context.anchor.billingUnit,
        billingCurrency: context.anchor.billingCurrency ?? undefined,
        creditAmount: this.gatewayCreditAmount(billingResult) ?? undefined,
        amountUsd,
        tokenUsageId: tokenUsageId ?? undefined,
        reason: typeof billingResult.reason === 'string' ? billingResult.reason : undefined,
        policyVersion: 'gateway-settlement-v3-customer-authority',
        idempotencyKey: this.gatewayFinancialReceiptKey(context),
        payload: {
          anchorHash: context.anchor.anchorHash,
          pricingHash: context.anchor.pricingHash,
          settlementFingerprint,
          gatewayCustomerSettlement: input.gatewayCustomerSettlement ?? null,
          customerFinancialAuthority,
          billingResult: billingResult as Prisma.InputJsonValue,
        },
      },
    });
  }

  private gatewayCustomerFinancialAuthority(
    input: UsageDeductInput,
    context: GatewaySettlementContext,
    settlementFingerprint: string,
    billingResult: Record<string, unknown>,
    tokenUsageId?: string | null,
  ): GatewayCustomerFinancialAuthority {
    const settlement = input.gatewayCustomerSettlement;
    const normalizedTokenUsageId = tokenUsageId?.trim();
    const rawQuote = billingResult.quote;
    if (
      !settlement
      || !normalizedTokenUsageId
      || !rawQuote
      || typeof rawQuote !== 'object'
      || Array.isArray(rawQuote)
    ) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway permanent receipt 缺少 canonical customer financial authority',
      );
    }
    const quote = rawQuote as UsageQuoteResult;
    if (quote.unit !== context.anchor.billingUnit) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway permanent receipt billing unit 与 anchor 不一致',
      );
    }
    const actualSettledDimensions = this.gatewayCustomerDimensionsFromQuote(quote);
    this.assertGatewayCustomerDimensions(
      settlement.settledDimensions,
      actualSettledDimensions,
      'receipt settled',
    );
    const originalAmount = this.gatewayCustomerAmount(
      context.anchor.customerQuoteSnapshot,
    );
    const settledAmount = this.gatewayCustomerAmount(quote);
    if (originalAmount.unit !== settledAmount.unit) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway permanent receipt customer amount unit drifted',
      );
    }
    const exact = settlement.basis === 'NORMALIZED_EXACT';
    if (
      (exact && !settledAmount.value.equals(originalAmount.value))
      || (!exact && !settledAmount.value.isZero())
    ) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway permanent receipt customer amount violates settlement basis',
      );
    }

    const fundingOutcome = this.gatewayFundingOutcome(billingResult);
    const terminalClass: GatewayCustomerFinancialAuthority['terminalClass'] =
      quote.unit === 'BALANCE'
        ? fundingOutcome === 'DEBT_OPEN'
          ? 'BALANCE_DEBT_OPEN'
          : 'BALANCE_SETTLED'
        : fundingOutcome === 'DEBT_OPEN'
          ? 'CREDITS_DEBT_OPEN'
          : quote.includedUpstream === true || billingResult.upstreamIncluded === true
            ? 'CREDITS_INCLUDED'
            : settledAmount.value.isZero()
              ? 'CREDITS_ZERO'
              : 'CREDITS_CHARGED';
    const originalCustomerChargeUsd = this.gatewayAnchorCustomerChargeUsd(
      context.anchor,
    );
    const settledCustomerChargeUsd = exact
      ? originalCustomerChargeUsd
      : new Prisma.Decimal(0);
    const canonicalCharge = (amount: Prisma.Decimal) => amount
      .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP)
      .toFixed(12);
    return {
      protocol: 'gateway-customer-financial-authority-v1' as const,
      policyVersion: settlement.policyVersion,
      basis: settlement.basis,
      billingUnit: quote.unit,
      terminalClass,
      fundingOutcome,
      customerAmountUnit: originalAmount.unit,
      originalCustomerAmount: originalAmount.canonical,
      settledCustomerAmount: settledAmount.canonical,
      originalCustomerChargeUsd: canonicalCharge(originalCustomerChargeUsd),
      settledCustomerChargeUsd: canonicalCharge(settledCustomerChargeUsd),
      originalDimensions: settlement.originalDimensions,
      settledDimensions: settlement.settledDimensions,
      anchorHash: context.anchor.anchorHash,
      pricingHash: context.anchor.pricingHash,
      settlementFingerprint,
      tokenUsageId: normalizedTokenUsageId,
    };
  }

  private gatewayAnchorCustomerChargeUsd(
    anchor: GatewaySettlementAnchor,
  ): Prisma.Decimal {
    const quote = anchor.customerQuoteSnapshot;
    if (quote.unit === 'BALANCE') {
      return this.gatewayCustomerAmount(quote).value;
    }
    if (
      quote.includedUpstream === true
      || quote.creditCost === 0
    ) {
      return new Prisma.Decimal(0);
    }
    const pricing = anchor.customerPricingSnapshot.tokenUsagePricing;
    if (pricing.status !== 'VERIFIED' || pricing.costUsd == null) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway CREDITS anchor 缺少 frozen customer charge USD',
      );
    }
    const amount = new Prisma.Decimal(pricing.costUsd);
    if (!amount.isFinite() || amount.lt(0)) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway CREDITS frozen customer charge USD 无效',
      );
    }
    return amount;
  }

  private gatewayFundingOutcome(result: Record<string, unknown>): string {
    const quote = result.quote && typeof result.quote === 'object' && !Array.isArray(result.quote)
      ? result.quote as Record<string, unknown>
      : {};
    if (result.debtOpen === true || result.fundingOutcome === 'DEBT_OPEN') return 'DEBT_OPEN';
    if (result.fundingOutcome === 'RECEIVABLE') return 'RECEIVABLE';
    if (result.fundingOutcome === 'INCLUDED' || quote.unit === 'CREDITS') return 'INCLUDED';
    return quote.includedUpstream === true ? 'INCLUDED' : 'COLLECTED';
  }

  private gatewayLegacyV2FundingOutcome(result: Record<string, unknown>): string {
    const quote = result.quote && typeof result.quote === 'object' && !Array.isArray(result.quote)
      ? result.quote as Record<string, unknown>
      : {};
    if (result.debtOpen === true || result.fundingOutcome === 'DEBT_OPEN') return 'DEBT_OPEN';
    if (result.fundingOutcome === 'RECEIVABLE') return 'RECEIVABLE';
    // This is the immutable v2 contract. Before customer financial authority
    // was introduced, ordinary CREDITS receipts were classified COLLECTED;
    // only provider-resale entitlements used INCLUDED.
    return quote.includedUpstream === true ? 'INCLUDED' : 'COLLECTED';
  }

  private gatewayCreditAmount(result: Record<string, unknown>): number | null {
    const quote = result.quote && typeof result.quote === 'object' && !Array.isArray(result.quote)
      ? result.quote as Record<string, unknown>
      : {};
    if (quote.unit !== 'CREDITS') return null;
    const creditAmount = Number(quote.creditCost);
    if (!Number.isInteger(creditAmount) || creditAmount < 0) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway CREDITS billingResult 缺少有效 creditCost',
      );
    }
    return creditAmount;
  }

  private gatewayEventSettlementAmountUsd(result: Record<string, unknown>): Prisma.Decimal {
    const quote = result.quote && typeof result.quote === 'object' && !Array.isArray(result.quote)
      ? result.quote as Record<string, unknown>
      : {};
    // The receipt records this request's charge, never the account's cumulative
    // post-transaction debt exposure.
    const candidates = [quote.effectiveCostUsd, quote.costUsd, result.amountUsd, result.costUsd];
    for (const candidate of candidates) {
      if (candidate === undefined || candidate === null || candidate === '') continue;
      try {
        const value = new Prisma.Decimal(candidate as Prisma.Decimal.Value);
        if (value.gte(0)) return value;
      } catch {
        // Continue to the next explicit event amount.
      }
    }
    const cents = Number(quote.amountCents ?? result.amountCents ?? 0);
    if (Number.isFinite(cents) && cents > 0) return new Prisma.Decimal(cents).div(100);
    const debt = result.debtExposureUsd;
    try {
      return debt == null ? new Prisma.Decimal(0) : new Prisma.Decimal(debt as Prisma.Decimal.Value);
    } catch {
      return new Prisma.Decimal(0);
    }
  }

  private async getCommittedIdempotency(
    key: string,
  ): Promise<Record<string, unknown> | null> {
    return timed('stlIdemRead', () => this.getCommittedIdempotencyInner(key));
  }

  private async getCommittedIdempotencyInner(
    key: string,
  ): Promise<Record<string, unknown> | null> {
    const row = await this.prisma.idempotencyKey.findUnique({
      where: this.scopedIdempotencyWhere(key),
    });
    if (!row) return null;
    if (row.status === 'COMMITTED') return row.result as Record<string, unknown>;
    if (row.status === 'PENDING' && row.expiresAt.getTime() <= Date.now()) {
      await this.prisma.idempotencyKey
        .delete({ where: this.scopedIdempotencyWhere(key) })
        .catch((err) => {
          if (!hasPrismaErrorCode(err, 'P2025')) throw err;
        });
    }
    return null;
  }

  private async releasePendingIdempotency(key: string, err: unknown): Promise<void> {
    try {
      await this.prisma.idempotencyKey.deleteMany({
        where: {
          key,
          scope: this.idempotencyScope,
          status: 'PENDING',
        },
      });
    } catch (cleanupErr) {
      const original = err instanceof Error ? err.message : String(err);
      const cleanup = cleanupErr instanceof Error ? cleanupErr.message : String(cleanupErr);
      this.logger.warn(
        `failed to release pending usage idempotency key=${key}: ${cleanup}; original=${original}`,
      );
    }
  }

  private async waitForCommittedIdempotency(
    key: string,
  ): Promise<Record<string, unknown> | null> {
    for (let i = 0; i < 10; i += 1) {
      await new Promise((resolve) => setTimeout(resolve, 200));
      const replay = await this.getCommittedIdempotency(key);
      if (replay) return replay;
    }
    return null;
  }

  private async beginPendingIdempotency(
    key: string,
    userId: string | null,
    reclaimAttempted = false,
  ): Promise<{ acquired: boolean; replay?: Record<string, unknown> }> {
    return timed('stlIdemBegin', () => this.beginPendingIdempotencyInner(key, userId, reclaimAttempted));
  }

  private async beginPendingIdempotencyInner(
    key: string,
    userId: string | null,
    reclaimAttempted = false,
  ): Promise<{ acquired: boolean; replay?: Record<string, unknown> }> {
    try {
      await this.prisma.idempotencyKey.create({
        data: {
          key,
          scope: this.idempotencyScope,
          userId,
          result: { status: 'PENDING' },
          status: 'PENDING',
          expiresAt: new Date(Date.now() + USAGE_PENDING_IDEMPOTENCY_TTL_MS),
        },
      });
      return { acquired: true };
    } catch (err) {
      if (!hasPrismaErrorCode(err, 'P2002')) throw err;
    }

    const row = await this.prisma.idempotencyKey.findUnique({
      where: this.scopedIdempotencyWhere(key),
    });
    if (!row) return { acquired: false };
    if (row.status === 'COMMITTED') {
      return { acquired: false, replay: row.result as Record<string, unknown> };
    }

    const isExpired = row.expiresAt.getTime() <= Date.now();
    if (isExpired && !reclaimAttempted) {
      await this.prisma.idempotencyKey
        .delete({ where: this.scopedIdempotencyWhere(key) })
        .catch((deleteErr) => {
          if (!hasPrismaErrorCode(deleteErr, 'P2025')) throw deleteErr;
        });
      return this.beginPendingIdempotency(key, userId, true);
    }

    return { acquired: false };
  }

  private async commitIdempotency(
    key: string,
    userId: string | null,
    result: Record<string, unknown>,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    return timed('stlIdemCommit', () => this.commitIdempotencyInner(key, userId, result, db));
  }

  private async commitIdempotencyInner(
    key: string,
    userId: string | null,
    result: Record<string, unknown>,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<void> {
    try {
      await db.idempotencyKey.upsert({
        where: this.scopedIdempotencyWhere(key),
        create: {
          key,
          scope: this.idempotencyScope,
          userId,
          result: result as Prisma.InputJsonValue,
          status: 'COMMITTED',
          expiresAt: new Date(Date.now() + USAGE_IDEMPOTENCY_TTL_MS),
        },
        update: {
          scope: this.idempotencyScope,
          userId,
          result: result as Prisma.InputJsonValue,
          status: 'COMMITTED',
          expiresAt: new Date(Date.now() + USAGE_IDEMPOTENCY_TTL_MS),
        },
      });
    } catch (err) {
      if (hasPrismaErrorCode(err, 'P2002')) {
        return;
      }
      throw err;
    }
  }

  private async buildPolicyData(input: UsagePolicyWriteInput): Promise<Prisma.UsagePricingPolicyUncheckedCreateInput> {
    if (!input.productId) throw new BadRequestException('productId 必填');
    const product = await this.prisma.product.findFirst({ where: { id: input.productId, deletedAt: null } });
    if (!product) throw new NotFoundException('产品不存在');
    if (!['GLOBAL', 'SEGMENT', 'USER'].includes(input.scope)) {
      throw new BadRequestException('scope 必须为 GLOBAL / SEGMENT / USER');
    }
    const resolvedUserId = await this.resolvePolicyUserId(input);
    if (input.scope === 'USER' && !resolvedUserId) {
      throw new BadRequestException('USER 策略必须提供 userId');
    }
    if (input.scope === 'SEGMENT' && !input.segmentId) {
      throw new BadRequestException('SEGMENT 策略必须提供 segmentId');
    }
    if (input.segmentId) {
      const segment = await this.prisma.userSegment.findUnique({ where: { id: input.segmentId } });
      if (!segment) throw new NotFoundException('用户分群不存在');
    }

    return {
      productId: input.productId,
      scope: input.scope,
      userId: input.scope === 'USER' ? resolvedUserId : null,
      segmentId: input.scope === 'SEGMENT' ? input.segmentId ?? null : null,
      modelName: input.modelName?.trim() || null,
      priceMultiplier: this.toMultiplier(input.priceMultiplier ?? 1, 'priceMultiplier'),
      creditMultiplier:
        input.creditMultiplier === undefined || input.creditMultiplier === null
          ? null
          : this.toMultiplier(input.creditMultiplier, 'creditMultiplier'),
      priority: Number.isFinite(Number(input.priority)) ? Math.floor(Number(input.priority)) : 0,
      description: input.description ?? '',
      startsAt: this.toOptionalDate(input.startsAt),
      endsAt: this.toOptionalDate(input.endsAt),
      isActive: input.isActive ?? true,
    };
  }

  private toMultiplier(value: string | number, field: string): Prisma.Decimal {
    const decimal = new Prisma.Decimal(value);
    if (decimal.lt(0)) {
      throw new BadRequestException(`${field} 必须 >= 0`);
    }
    return decimal.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
  }

  private async resolvePolicyUserId(input: UsagePolicyWriteInput): Promise<string | null> {
    const userId = input.userId?.trim();
    if (userId) {
      const user = await this.prisma.user.findUnique({ where: { id: userId } });
      if (!user) throw new NotFoundException('用户不存在');
      return user.id;
    }
    const email = input.userEmail?.trim();
    if (!email) return null;
    const user = await this.prisma.user.findUnique({ where: { email } });
    if (!user) throw new NotFoundException('用户不存在');
    return user.id;
  }

  private toOptionalDate(value: string | Date | null | undefined): Date | null {
    if (value === undefined || value === null || value === '') return null;
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) {
      throw new BadRequestException('日期格式不正确');
    }
    return date;
  }

  private async assertPaygProduct(productId?: string | null) {
    const id = productId?.trim();
    if (!id) throw new BadRequestException('productId 为必填');
    const product = await this.prisma.product.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        name: true,
        slug: true,
        billingMode: true,
        isActive: true,
      },
    });
    if (!product) throw new BadRequestException('产品不存在');
    if (product.billingMode !== 'PAY_AS_YOU_GO') {
      throw new BadRequestException(`按量定价仅适用于 PAY_AS_YOU_GO 产品(当前: ${product.billingMode})`);
    }
    return product;
  }

  private async assertEnterpriseBillingAccount(billingAccountId?: string | null) {
    const id = billingAccountId?.trim();
    if (!id) throw new BadRequestException('billingAccountId 为必填');
    const account = await this.prisma.billingAccount.findFirst({
      where: { id, deletedAt: null },
      select: {
        id: true,
        name: true,
        type: true,
        status: true,
        enterpriseName: true,
        ownerUserId: true,
      },
    });
    if (!account) throw new NotFoundException('企业账务账户不存在');
    if (account.type !== ENTERPRISE_BILLING_ACCOUNT_TYPE) {
      throw new BadRequestException('仅企业账务账户可配置企业模型折扣');
    }
    return account;
  }

  private async listEnterpriseDiscountModels(productId: string): Promise<EnterpriseDiscountModelRow[]> {
    return this.prisma.productModelAvailability.findMany({
      where: {
        productId,
        status: { not: 'RETIRED' },
      },
      orderBy: [{ displayOrder: 'asc' }, { modelName: 'asc' }],
      include: {
        modelPricing: {
          select: {
            modelName: true,
            provider: true,
            isActive: true,
            inputPricePerMToken: true,
            cachedInputPrice: true,
            cacheWrite5minPrice: true,
            cacheWrite1hPrice: true,
            outputPricePerMToken: true,
            longContextThreshold: true,
            longContextInputPrice: true,
            longContextOutputPrice: true,
            priceTiers: {
              where: { isActive: true },
              orderBy: [{ priority: 'desc' }, { minInputTokens: 'asc' }],
              select: {
                tierKey: true,
                displayName: true,
                minInputTokens: true,
                maxInputTokensExclusive: true,
                inputPricePerMToken: true,
                outputPricePerMToken: true,
                cachedInputPrice: true,
                cacheWritePrice: true,
                currency: true,
                rawCondition: true,
                source: true,
                priority: true,
                isActive: true,
              },
            },
          },
        },
      },
    });
  }

  private toEnterpriseDiscountRow(
    availability: EnterpriseDiscountModelRow,
    discount: EnterpriseDiscountRecord | null,
  ) {
    const model = availability.modelPricing;
    const multiplier = discount?.isActive === false
      ? new Prisma.Decimal(1)
      : discount?.priceMultiplier ?? new Prisma.Decimal(1);
    const baseInput = model.inputPricePerMToken;
    // 缓存读价的派生交给 toPriceBuckets（传原始配置值），这里不再自己算一遍。
    const baseCacheWrite = model.cacheWrite5minPrice ?? model.cacheWrite1hPrice ?? null;
    const baseOutput = model.outputPricePerMToken;
    return {
      modelName: availability.modelName,
      provider: model.provider,
      modelActive: model.isActive,
      availability: {
        status: availability.status,
        apiEnabled: availability.apiEnabled,
        visible: availability.visible,
        startsAt: availability.startsAt,
        endsAt: availability.endsAt,
        displayOrder: availability.displayOrder,
        reason: availability.reason,
        active: this.paygAvailabilityActive(availability, new Date()) && model.isActive,
      },
      // ⚠️ 顶层四桶是同一缺陷的第四份拷贝，统一走 toPriceBuckets。
      // 注意 baseCacheRead 已由 resolveBaseCacheReadPrice 算过，这里传**原始配置值**
      // 让 helper 自己算，避免双重派生。
      ...this.toPriceBuckets(
        model.modelName,
        baseInput,
        baseOutput,
        model.cachedInputPrice,
        baseCacheWrite,
        multiplier,
      ),
      discount: discount
        ? {
            id: discount.id,
            priceMultiplier: discount.priceMultiplier.toString(),
            isActive: discount.isActive,
            note: discount.note,
            updatedBy: discount.updatedBy,
            createdAt: discount.createdAt,
            updatedAt: discount.updatedAt,
          }
        : null,
      configured: Boolean(discount),
      priceMultiplier: multiplier.toString(),

      fallbackPricing: {
        // ModelPricingService selects explicit tiers first. These prices are only
        // used when no explicit tier covers the request's input-token count.
        longContext: model.longContextThreshold != null
          && (model.longContextInputPrice != null || model.longContextOutputPrice != null)
          ? this.toEnterpriseFallbackPrice(
              model.modelName,
              model.longContextThreshold,
              model.longContextInputPrice ?? baseInput,
              model.longContextOutputPrice ?? baseOutput,
              model.cachedInputPrice,
              baseCacheWrite,
              multiplier,
            )
          : null,
        default: this.toEnterpriseFallbackPrice(
          model.modelName,
          null,
          baseInput,
          baseOutput,
          model.cachedInputPrice,
          baseCacheWrite,
          multiplier,
        ),
      },
      // ⚠️ 这里此前是同一个缺陷的一份拷贝（另三处：按量定价页 tiers[]、
      // toEnterpriseFallbackPrice、本行顶层四桶）：缺专属缓存价时吐 null，而结算按 input 价扣。
      // 现在四处统一走 toPriceBuckets，回退规则只有一个落点。
      tiers: model.priceTiers.map((tier) => ({
        tierKey: tier.tierKey,
        displayName: tier.displayName,
        minInputTokens: tier.minInputTokens,
        maxInputTokensExclusive: tier.maxInputTokensExclusive,
        currency: tier.currency,
        rawCondition: tier.rawCondition,
        source: tier.source,
        priority: tier.priority,
        isActive: tier.isActive,
        ...this.toPriceBuckets(
          model.modelName,
          tier.inputPricePerMToken,
          tier.outputPricePerMToken,
          tier.cachedInputPrice,
          tier.cacheWritePrice,
          multiplier,
        ),
      })),
    };
  }

  /**
   * 价格四桶的 base + effective。**回退规则与结算侧同源，只在这里写一次。**
   *
   * ⚠️ 缺专属缓存价时必须回退到 input 价：结算侧就是这么扣的
   * （ModelPricingService: `effectiveCachedInputPrice = cachedInputPriceUsdPerM ?? inputPriceUsdPerM`，
   *  `effectiveCacheWritePrice` 同理）。此前三处各自吐 null ⇒ 页面显示「未配置」而实际按 input 扣费。
   *
   * 回退值写进 **base**（而非只改 effective 让前端配合）：旧前端 + 新 billing 也显示正确，
   * 不引入跨仓发版顺序依赖。
   *
   * `inherited` 仅供 UI 标注、不参与金额，语义严格是「该桶价格**就等于 input**」：
   * 所以 GLM 的缓存读（派生自 input×0.2）是 `false` —— 它有自己的价，只是不是显式配的。
   */
  private toPriceBuckets(
    modelName: string,
    inputPrice: Prisma.Decimal,
    outputPrice: Prisma.Decimal,
    configuredCacheReadPrice: Prisma.Decimal | null,
    cacheWritePrice: Prisma.Decimal | null,
    multiplier: Prisma.Decimal,
  ) {
    const cacheReadPrice = this.resolveBaseCacheReadPrice(
      modelName,
      configuredCacheReadPrice,
      inputPrice,
    );
    const cachedBase = cacheReadPrice ?? inputPrice;
    const cacheWriteBase = cacheWritePrice ?? inputPrice;
    return {
      inherited: {
        cached: cacheReadPrice == null,
        cacheWrite: cacheWritePrice == null,
      },
      base: {
        input: usdNumber(inputPrice),
        cached: usdNumber(cachedBase),
        cacheWrite: usdNumber(cacheWriteBase),
        output: usdNumber(outputPrice),
      },
      effective: {
        input: this.multiplyPrice(inputPrice, multiplier),
        cached: this.multiplyPrice(cachedBase, multiplier),
        cacheWrite: this.multiplyPrice(cacheWriteBase, multiplier),
        output: this.multiplyPrice(outputPrice, multiplier),
      },
    };
  }

  private toEnterpriseFallbackPrice(
    modelName: string,
    minInputTokens: number | null,
    inputPrice: Prisma.Decimal,
    outputPrice: Prisma.Decimal,
    configuredCacheReadPrice: Prisma.Decimal | null,
    cacheWritePrice: Prisma.Decimal | null,
    multiplier: Prisma.Decimal,
  ) {
    return {
      ...(minInputTokens == null ? {} : { minInputTokens }),
      ...this.toPriceBuckets(
        modelName,
        inputPrice,
        outputPrice,
        configuredCacheReadPrice,
        cacheWritePrice,
        multiplier,
      ),
    };
  }

  private multiplyPrice(value: Prisma.Decimal, multiplier: Prisma.Decimal): number {
    return usdNumber(value.mul(multiplier).toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP));
  }

  private normalizeEnterpriseDiscountMultiplier(value: string | number | null | undefined): Prisma.Decimal {
    const raw = value === undefined || value === null || value === '' ? 1 : Number(value);
    if (!Number.isFinite(raw) || raw <= 0 || raw > 1) {
      throw new BadRequestException('企业模型折扣倍率必须大于 0 且不超过 1');
    }
    return new Prisma.Decimal(raw).toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
  }

  private normalizePaygModelNames(values: string[]): string[] {
    return Array.from(new Set(values
      .map((value) => value?.trim())
      .filter((value): value is string => Boolean(value))));
  }

  private normalizeProductModelAvailabilityStatus(value: unknown): ProductModelAvailabilityStatus {
    const normalized = typeof value === 'string' ? value.trim().toUpperCase() : '';
    if (normalized === 'ACTIVE' || normalized === 'SUSPENDED' || normalized === 'RETIRED') {
      return normalized;
    }
    throw new BadRequestException('status 必须是 ACTIVE、SUSPENDED 或 RETIRED');
  }

  private normalizeDisplayOrder(value: number | null | undefined): number {
    if (value === undefined || value === null) return 0;
    const normalized = Number(value);
    if (!Number.isInteger(normalized) || normalized < -100000 || normalized > 100000) {
      throw new BadRequestException('displayOrder 必须是 -100000 到 100000 之间的整数');
    }
    return normalized;
  }

  private assertAvailabilityTimeWindow(startsAt: Date | null, endsAt: Date | null): void {
    if (startsAt && endsAt && endsAt.getTime() <= startsAt.getTime()) {
      throw new BadRequestException('endsAt 必须晚于 startsAt');
    }
  }

  private paygAvailabilityActive(
    availability: { status: string; apiEnabled: boolean; startsAt: Date | null; endsAt: Date | null },
    now: Date,
  ): boolean {
    return availability.status === 'ACTIVE'
      && availability.apiEnabled === true
      && (availability.startsAt == null || availability.startsAt.getTime() <= now.getTime())
      && (availability.endsAt == null || availability.endsAt.getTime() > now.getTime());
  }

  private async resolveProductForUnboundApiKey(
    input: UsageQuoteInput,
    apiKeyId: string,
  ): Promise<Product> {
    if (!this.allowDefaultPaygFallback()) {
      throw new BadRequestException('api_key_product_unbound');
    }
    this.logger.warn(`API Key missing product binding; using explicit fallback apiKeyId=${apiKeyId}`);
    return this.resolveProduct(input).catch((err) => {
      if (err instanceof BadRequestException) {
        throw new BadRequestException('api_key_product_unbound');
      }
      throw err;
    });
  }

  private allowDefaultPaygFallback(): boolean {
    return this.booleanConfig('BILLING_ALLOW_DEFAULT_PAYG_FALLBACK', false);
  }

  private booleanConfig(key: string, defaultValue: boolean): boolean {
    const raw = this.config?.get<string | boolean>(key);
    if (raw === undefined || raw === null || raw === '') return defaultValue;
    if (typeof raw === 'boolean') return raw;
    return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
  }

  private resolveBaseCacheReadPrice(
    modelName: string,
    configuredPrice: Prisma.Decimal | null,
    inputPrice: Prisma.Decimal,
  ): Prisma.Decimal | null {
    if (configuredPrice != null) return configuredPrice;
    if (modelName === 'glm-5' || modelName === 'glm-5-turbo') {
      return inputPrice.mul(new Prisma.Decimal('0.2')).toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP);
    }
    return null;
  }

  private resolveEffectivePaygPrice(
    basePrice: Prisma.Decimal,
    overridePrice: Prisma.Decimal | null | undefined,
    multiplier: Prisma.Decimal,
  ): number {
    const effective = overridePrice
      ?? basePrice.mul(multiplier).toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP);
    return usdNumber(effective);
  }

  /**
   * 倍率的严格解析。
   *
   * ⚠️ 不能用 `Number(value)`（评审阻断项）。实测这些都会**静默变成倍率 0 = 客户免费**：
   *   Number('   ') === 0、Number(false) === 0、Number([]) === 0；
   * 另有 Number('0x10') === 16（十六进制被接受）、'1e-9' 这类正数经 round4 变成 0.0000。
   * 0 本身是合法倍率（免费），所以**不能**靠 falsy 判定把它挡掉 —— 只能把非法**输入形态**挡在外面。
   */
  private normalizePaygMultiplier(value: unknown): Prisma.Decimal {
    // 未提供 = 不改价（1 倍）。注意空白字符串**不**算未提供：它是明确的错误输入。
    if (value === undefined || value === null) return new Prisma.Decimal(1);
    let raw: Prisma.Decimal;
    if (typeof value === 'number') {
      if (!Number.isFinite(value)) {
        throw new BadRequestException('priceMultiplier 必须是 0 到 100 之间的数字');
      }
      raw = new Prisma.Decimal(value);
    } else if (typeof value === 'string') {
      // 只接受十进制字面量：拒掉空白、十六进制、科学计数法、千分位、正负号堆叠。
      if (!/^[+-]?\d+(\.\d+)?$/.test(value.trim())) {
        throw new BadRequestException('priceMultiplier 必须是 0 到 100 之间的十进制数字');
      }
      raw = new Prisma.Decimal(value.trim());
    } else {
      // boolean / 数组 / 对象一律拒：Number(false) 与 Number([]) 都是 0。
      throw new BadRequestException('priceMultiplier 必须是 0 到 100 之间的数字');
    }
    if (raw.lessThan(0) || raw.greaterThan(100)) {
      throw new BadRequestException('priceMultiplier 必须是 0 到 100 之间的数字');
    }
    const rounded = raw.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP);
    // 正数被 round4 抹成 0 必须报错，不能静默变免费：运营写 0.00001 的意图绝不是「免费」。
    if (rounded.isZero() && !raw.isZero()) {
      throw new BadRequestException('priceMultiplier 最小精度为 4 位小数，请直接填 0 表示免费');
    }
    return rounded;
  }

  private normalizeNullableUsdPrice(value: unknown, field: string): Prisma.Decimal | null {
    if (value === undefined || value === null || value === '') return null;
    const raw = Number(value);
    if (!Number.isFinite(raw) || raw < 0) {
      throw new BadRequestException(`${field} 必须是非负数字`);
    }
    return new Prisma.Decimal(raw).toDecimalPlaces(8, Prisma.Decimal.ROUND_HALF_UP);
  }
}
