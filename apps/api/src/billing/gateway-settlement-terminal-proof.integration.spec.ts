import { createHash, randomUUID } from 'node:crypto';
import { Prisma, PrismaClient, ProductBillingMode, TransactionType } from '@prisma/client';
import { BillingRepository } from './billing.repository';
import { BillingService } from './billing.service';
import { GatewayRequestEventBillingService } from './gateway-request-event-billing.service';
import { ModelPricingService } from './model-pricing.service';
import { ProviderCostPricingService } from './provider-cost-pricing.service';
import {
  type GatewayCustomerPricingSnapshot,
  type GatewayProviderCostSnapshot,
  type GatewaySettlementAnchor,
  type GatewaySettlementContext,
  type UsageDeductInput,
  UsageBillingStrategyService,
} from './usage-billing-strategy.service';

/**
 * Mutating PostgreSQL integration test. Run only against an isolated database:
 *
 * TEST_INTEGRATION=1 TEST_DATABASE_NAME=billing_protocol_test \
 * DATABASE_URL=postgresql://.../billing_protocol_test \
 * pnpm --filter @ruidong/api test -- --runInBand \
 *   --runTestsByPath src/billing/gateway-settlement-terminal-proof.integration.spec.ts
 */
const maybeDescribe = process.env.TEST_INTEGRATION === '1' ? describe : describe.skip;

async function expectPostgresFailure(
  operation: Promise<unknown>,
  expectedMessage: string,
): Promise<void> {
  let caught: unknown;
  try {
    await operation;
  } catch (error) {
    caught = error;
  }
  expect(caught).toBeDefined();
  const errorRecord = caught && typeof caught === 'object'
    ? caught as Record<string, unknown>
    : {};
  const evidence = [
    caught instanceof Error ? caught.message : String(caught),
    String(errorRecord.code ?? ''),
    JSON.stringify(errorRecord.meta ?? null),
    JSON.stringify(errorRecord.cause ?? null),
  ].join('\n');
  expect(evidence).toContain(expectedMessage);
}

function promiseGate(): {
  wait: Promise<void>;
  open: () => void;
} {
  let open = (): void => undefined;
  const wait = new Promise<void>((resolve) => {
    open = resolve;
  });
  return { wait, open };
}

type BaseFixture = {
  suffix: string;
  userId: string;
  billingAccountId: string;
  tenantId: string;
  productId: string;
  productSlug: string;
  apiKeyId: string;
  balanceGrantId: string;
  accountType: 'personal' | 'enterprise';
  ledgerMode: 'clean' | 'dirty';
};

type ReservationFixture = {
  requestId: string;
  gatewayBillingEventId: string;
  evidenceHash: string;
  anchorHash: string;
  pricingHash: string;
  reservationId: string;
  reservationHash: string;
  reservedAmountUsd: Prisma.Decimal;
  occurredAt: Date;
  firstReceivedAt: Date;
};

type CreditsFixture = {
  requestId: string;
  gatewayBillingEventId: string;
  evidenceHash: string;
  anchorHash: string;
  pricingHash: string;
  subscriptionId: string;
  planId: string;
  creditCost: number;
  customerChargeUsd: Prisma.Decimal;
  includedUpstream: boolean;
  originalDimensions: CustomerDimensions;
  occurredAt: Date;
  firstReceivedAt: Date;
};

type JsonObject = Record<string, unknown>;

type CustomerDimensions = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  totalTokens: number;
  imageCount: number;
};

const CUSTOMER_SETTLEMENT_POLICY_VERSION = 'gateway-customer-settlement-v2' as const;
type CustomerSettlementPolicyVersion = typeof CUSTOMER_SETTLEMENT_POLICY_VERSION;
type CustomerSettlementWriterPolicyVersion = CustomerSettlementPolicyVersion
  | 'gateway-customer-settlement-v1';

const VERIFIED_PRODUCER_BUILD_SHA =
  '0123456789abcdef0123456789abcdef01234567';
const UNAUTHORIZED_PRODUCER_BUILD_SHA = 'f'.repeat(40);

type CreditPolicyFixture = {
  eventId: string;
  revision: number;
  limitUsd: Prisma.Decimal;
  status: string;
  termsDays: number;
  effectiveAt: Date | null;
  expiresAt: Date | null;
  decisionAt: Date;
  boundaryAt: Date | null;
};

type ReservationFundingOptions = {
  collectedUsd?: Prisma.Decimal.Value;
  approvedCreditUsd?: Prisma.Decimal.Value;
  unapprovedDebtUsd?: Prisma.Decimal.Value;
  occurredAt?: Date;
  firstReceivedAt?: Date;
  creditPolicyAt?: Date;
  creditPolicyWindowStart?: Date;
  creditPolicyEventId?: string | null;
  creditPolicyRevision?: number | null;
  creditTermsDays?: number | null;
  approvedCreditDueAt?: Date | null;
  creditLimitUsd?: Prisma.Decimal.Value;
  creditConfiguredLimitUsd?: Prisma.Decimal.Value;
  creditPolicySource?: string;
  creditStatus?: string | null;
  creditEffectiveAt?: Date | null;
  creditExpiresAt?: Date | null;
  rawEvidence?: JsonObject;
  canonicalServiceProof?: boolean;
  producerBuildAuthorizationEventId?: string | null;
  producerBuildAuthorizationRevision?: number | null;
  producerBuildAuthorityHash?: string | null;
  customerQuoteSnapshot?: JsonObject;
  customerPricingSnapshot?: JsonObject;
  providerCostSnapshot?: JsonObject;
  customerSettlementPolicyVersion?: CustomerSettlementWriterPolicyVersion | null;
  reservationCanonicalPayload?: JsonObject;
};

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as JsonObject;
  return `{${Object.entries(object)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

const ZERO_BILLABLE_DIMENSIONS = {
  prompt_tokens: 0,
  completion_tokens: 0,
  total_tokens: 0,
  cache_read_tokens: 0,
  cache_write_tokens: 0,
  image_count: 0,
};

function quotaExceededEvidence(): JsonObject {
  return {
    status: 'failure',
    status_code: 429,
    upstream_started: false,
    response_started: false,
    quota_settlement: 'rollback',
    producer_build_sha: VERIFIED_PRODUCER_BUILD_SHA,
    ...ZERO_BILLABLE_DIMENSIONS,
    token_extras: {
      cached_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    error: {
      stage: 'auth',
      type: 'quota_exceeded',
      code: 'QUOTA_EXCEEDED',
    },
  };
}

function authoritativeZeroUsageEvidence(
  overrides: JsonObject = {},
): JsonObject {
  return {
    status: 'success',
    status_code: 200,
    provider: 'zhipu',
    resolved_api_type: 'anthropic_messages',
    token_source: 'provider',
    stream_end_reason: 'normal_end',
    provider_reconciliation_required: false,
    producer_build_sha: VERIFIED_PRODUCER_BUILD_SHA,
    provider_usage_hash:
      'sha256:aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
    provider_account_ref: 'provider-account-terminal-proof',
    upstream_request_id: 'upstream-terminal-proof',
    ...ZERO_BILLABLE_DIMENSIONS,
    token_extras: {
      cached_tokens: 0,
      cache_creation_input_tokens: 0,
    },
    usage_evidence: {
      source: 'provider_terminal',
      status: 'complete',
      protocol: 'anthropic_sse',
      terminal_frame_seen: true,
      dimensions_present: [
        'input_tokens',
        'output_tokens',
        'cache_read_input_tokens',
        'cache_creation_input_tokens',
        'image_count',
      ],
    },
    ...overrides,
  };
}

function withoutEvidenceField(
  evidence: JsonObject,
  field: string,
): JsonObject {
  const result = { ...evidence };
  delete result[field];
  return result;
}

function withoutUsageEvidenceField(
  evidence: JsonObject,
  field: string,
): JsonObject {
  const result = { ...evidence };
  const usageEvidence = result.usage_evidence;
  if (!usageEvidence || typeof usageEvidence !== 'object' || Array.isArray(usageEvidence)) {
    throw new Error('usage_evidence fixture must be an object');
  }
  const nextUsageEvidence = { ...usageEvidence as JsonObject };
  delete nextUsageEvidence[field];
  result.usage_evidence = nextUsageEvidence;
  return result;
}

function authoritativeZeroUsageEvidenceWithProtocol(
  protocol: unknown,
  dimensionsPresent: string[] = [
    'input_tokens',
    'output_tokens',
    'cache_read_input_tokens',
    'cache_creation_input_tokens',
    'image_count',
  ],
): JsonObject {
  return authoritativeZeroUsageEvidence({
    usage_evidence: {
      source: 'provider_terminal',
      status: 'complete',
      protocol,
      terminal_frame_seen: true,
      dimensions_present: dimensionsPresent,
    },
  });
}

async function createBaseFixture(
  prisma: PrismaClient,
  label: string,
  options: {
    accountType?: 'personal' | 'enterprise';
    ledgerMode?: 'clean' | 'dirty';
    openingBalanceUsd?: Prisma.Decimal.Value;
  } = {},
): Promise<BaseFixture> {
  const suffix = `${label}-${randomUUID()}`;
  const accountType = options.accountType ?? 'personal';
  const ledgerMode = options.ledgerMode ?? 'clean';
  const openingBalanceUsd = new Prisma.Decimal(options.openingBalanceUsd ?? 0);
  const base: BaseFixture = {
    suffix,
    userId: `protocol-user-${suffix}`,
    billingAccountId: `protocol-account-${suffix}`,
    tenantId: `protocol-tenant-${suffix}`,
    productId: `protocol-product-${suffix}`,
    productSlug: `protocol-product-${suffix}`,
    apiKeyId: `protocol-key-${suffix}`,
    balanceGrantId: `protocol-grant-${suffix}`,
    accountType,
    ledgerMode,
  };
  const reconciledAt = new Date(Date.now() - 60_000);

  await prisma.$transaction(async (tx) => {
    await tx.user.create({ data: { id: base.userId } });
    await tx.billingAccount.create({
      data: {
        id: base.billingAccountId,
        type: accountType,
        name: `Gateway ${label} terminal proof`,
        ownerUserId: base.userId,
        status: 'active',
        currency: 'USD',
        ...(ledgerMode === 'clean'
          ? {
              balanceGrantLedgerStatus: 'RECONCILED_V2',
              balanceGrantLedgerVersion: 2,
              balanceGrantLedgerHash: 'EMPTY_V2',
              balanceGrantLedgerReconciledAt: reconciledAt,
            }
          : {}),
      },
    });
    await tx.accountWallet.create({
      data: {
        billingAccountId: base.billingAccountId,
        balanceUsd: new Prisma.Decimal(0),
      },
    });
    await tx.tenant.create({
      data: {
        id: base.tenantId,
        type: accountType,
        name: `Gateway ${label} terminal proof`,
        ownerUserId: base.userId,
        billingAccountId: base.billingAccountId,
        status: 'active',
        balanceAllowanceUsedUsd: new Prisma.Decimal(0),
      },
    });
    await tx.product.create({
      data: {
        id: base.productId,
        name: `Gateway ${label} terminal proof`,
        slug: base.productSlug,
        billingMode: ProductBillingMode.PAY_AS_YOU_GO,
      },
    });
    await tx.apiKey.create({
      data: {
        id: base.apiKeyId,
        userId: base.userId,
        tenantId: base.tenantId,
        productId: base.productId,
        name: `Gateway ${label} terminal proof`,
        prefix: `sk-${suffix.slice(0, 12)}`,
        keyHash: `protocol-key-hash-${suffix}`,
      },
    });
  });

  if (openingBalanceUsd.gt(0)) {
    const financialNow = new Date(Date.now() - 30_000);
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "billing_account_id" FROM "account_wallets"
        WHERE "billing_account_id" = ${base.billingAccountId} FOR UPDATE
      `;
      await tx.$executeRaw`
        SELECT set_config('billing.balance_financial_now', ${financialNow.toISOString()}, true)
      `;
      await tx.accountWallet.update({
        where: { billingAccountId: base.billingAccountId },
        data: { balanceUsd: openingBalanceUsd },
      });
      await tx.balanceTransaction.create({
        data: {
          id: `protocol-opening-tx-${suffix}`,
          operationKey: `balance:admin-recharge:grant:${base.balanceGrantId}`,
          userId: base.userId,
          tenantId: base.tenantId,
          billingAccountId: base.billingAccountId,
          type: TransactionType.RECHARGE,
          amountUsd: openingBalanceUsd,
          balanceAfterUsd: openingBalanceUsd,
          description: `Gateway ${label} opening funding`,
          productId: base.productId,
          createdAt: financialNow,
        },
      });
      await tx.balanceGrant.create({
        data: {
          id: base.balanceGrantId,
          userId: base.userId,
          tenantId: base.tenantId,
          billingAccountId: base.billingAccountId,
          productId: base.productId,
          source: 'RECHARGE',
          paidAmountUsd: openingBalanceUsd,
          bonusAmountUsd: new Prisma.Decimal(0),
          grantedAmountUsd: openingBalanceUsd,
          remainingAmountUsd: openingBalanceUsd,
          remainingPaidAmountUsd: openingBalanceUsd,
          remainingBonusAmountUsd: new Prisma.Decimal(0),
          discountRate: new Prisma.Decimal(1),
          validFrom: financialNow,
          createdAt: financialNow,
        },
      });
    });
  }

  return base;
}

async function createCreditPolicy(
  prisma: PrismaClient,
  base: BaseFixture,
  label: string,
  options: {
    limitUsd?: Prisma.Decimal.Value;
    status?: string;
    termsDays?: number;
    effectiveAt?: Date | null;
    expiresAt?: Date | null;
    decisionAt: Date;
    boundaryAt?: Date | null;
    confirmed?: boolean;
  },
): Promise<CreditPolicyFixture> {
  if (base.accountType !== 'enterprise') {
    throw new Error('credit policy fixture requires enterprise account');
  }
  const eventId = `protocol-credit-event-${label}-${base.suffix}`;
  const limitUsd = new Prisma.Decimal(options.limitUsd ?? 5);
  const status = options.status ?? 'ACTIVE';
  const termsDays = options.termsDays ?? 30;
  const effectiveAt = options.effectiveAt ?? null;
  const expiresAt = options.expiresAt ?? null;
  const confirmed = options.confirmed ?? true;
  const boundaryAt = confirmed ? (options.boundaryAt ?? options.decisionAt) : null;

  await prisma.$transaction(async (tx) => {
    await tx.billingAccountCreditConfig.create({
      data: {
        billingAccountId: base.billingAccountId,
        limitUsd,
        status,
        termsDays,
        effectiveAt,
        expiresAt,
        policyRevision: 1,
        policyEffectiveBoundaryAt: null,
        policyBoundaryComplete: false,
        updatedBy: `finance-${base.suffix}`,
      },
    });
    await tx.billingAccountCreditEvent.create({
      data: {
        id: eventId,
        billingAccountId: base.billingAccountId,
        oldLimitUsd: null,
        newLimitUsd: limitUsd,
        oldStatus: null,
        newStatus: status,
        oldTermsDays: null,
        newTermsDays: termsDays,
        oldEffectiveAt: null,
        newEffectiveAt: effectiveAt,
        oldExpiresAt: null,
        newExpiresAt: expiresAt,
        temporalSnapshotComplete: true,
        policyRevision: 1,
        policyDecisionAt: options.decisionAt,
        policyEffectiveBoundaryAt: null,
        policyBoundaryComplete: false,
        requestFingerprint: `protocol-credit-fingerprint-${label}-${base.suffix}`,
        actorId: `finance-${base.suffix}`,
        reason: `Gateway ${label} credit policy`,
        idempotencyKey: `protocol-credit-policy-${label}-${base.suffix}`,
      },
    });
  });

  // The production protocol first commits the pending policy revision, then
  // confirms its database visibility boundary in a second transaction.
  if (confirmed && boundaryAt) {
    await prisma.$transaction(async (tx) => {
      await tx.billingAccountCreditConfig.update({
        where: { billingAccountId: base.billingAccountId },
        data: {
          policyEffectiveBoundaryAt: boundaryAt,
          policyBoundaryComplete: true,
        },
      });
      await tx.billingAccountCreditEvent.update({
        where: { id: eventId },
        data: {
          policyEffectiveBoundaryAt: boundaryAt,
          policyBoundaryComplete: true,
        },
      });
    });
  }

  return {
    eventId,
    revision: 1,
    limitUsd,
    status,
    termsDays,
    effectiveAt,
    expiresAt,
    decisionAt: options.decisionAt,
    boundaryAt,
  };
}

async function createReservationFixture(
  tx: Prisma.TransactionClient,
  base: BaseFixture,
  label: string,
  withCompleteHold = true,
  amountUsd: Prisma.Decimal.Value = 1,
  funding: ReservationFundingOptions = {},
): Promise<ReservationFixture> {
  const requestId = `protocol-${label}-request-${base.suffix}`;
  const gatewayBillingEventId = `protocol-${label}-event-${base.suffix}`;
  let evidenceHash = `protocol-${label}-evidence-hash-${base.suffix}`;
  let anchorHash = `protocol-${label}-anchor-hash-${base.suffix}`;
  let pricingHash = `protocol-${label}-pricing-hash-${base.suffix}`;
  const reservationId = `protocol-${label}-reservation-${base.suffix}`;
  const reservationCanonicalPayload = funding.reservationCanonicalPayload ?? {};
  const reservationHash = funding.reservationCanonicalPayload
    ? canonicalSha256(reservationCanonicalPayload)
    : `protocol-${label}-reservation-hash-${base.suffix}`;
  const [sequence] = await tx.$queryRaw<Array<{
    value: bigint;
    databaseNow: Date;
  }>>`
    SELECT
      nextval('"gateway_usage_first_receipt_sequence_seq"')::BIGINT AS value,
      date_trunc(
        'milliseconds',
        clock_timestamp() AT TIME ZONE 'UTC'
      ) AS "databaseNow"
  `;
  if (!sequence?.value) throw new Error('missing Gateway first-receipt sequence');
  const firstReceivedAt = funding.firstReceivedAt ?? sequence.databaseNow;
  const occurredAt = funding.occurredAt
    ?? new Date(firstReceivedAt.getTime() - 5_000);

  const rawEvidence: JsonObject = {
    producer_build_sha: VERIFIED_PRODUCER_BUILD_SHA,
    ...(funding.rawEvidence ?? {}),
    request_id: typeof funding.rawEvidence?.request_id === 'string'
      ? funding.rawEvidence.request_id
      : requestId,
  };
  const customerQuoteSnapshot: JsonObject = funding.customerQuoteSnapshot ?? {};
  const customerPricingSnapshot: JsonObject = funding.customerPricingSnapshot ?? {};
  const providerCostSnapshot: JsonObject = funding.providerCostSnapshot ?? {};
  const customerSettlementPolicyVersion =
    funding.customerSettlementPolicyVersion === undefined
      ? CUSTOMER_SETTLEMENT_POLICY_VERSION
      : funding.customerSettlementPolicyVersion;
  let anchorCanonicalPayload: JsonObject = customerSettlementPolicyVersion === null
    ? {}
    : { customerSettlementPolicyVersion };
  if (funding.canonicalServiceProof) {
    evidenceHash = canonicalSha256(rawEvidence);
    pricingHash = canonicalSha256({
      customerQuoteSnapshot,
      customerPricingSnapshot,
      providerCostSnapshot,
    });
    anchorCanonicalPayload = {
      requestId,
      apiKeyId: base.apiKeyId,
      userId: base.userId,
      tenantId: base.tenantId,
      billingAccountId: base.billingAccountId,
      productId: base.productId,
      productSlug: base.productSlug,
      billingUnit: 'BALANCE',
      billingCurrency: 'USD',
      codingPlanEntitlementId: null,
      subscriptionId: null,
      planId: null,
      occurredAt: occurredAt.toISOString(),
      firstReceivedAt: firstReceivedAt.toISOString(),
      ...(customerSettlementPolicyVersion === null
        ? {}
        : { customerSettlementPolicyVersion }),
      pricingHash,
      customerQuoteSnapshot,
      customerPricingSnapshot,
      providerCostSnapshot,
      entitlementSnapshot: null,
      planSnapshot: null,
    };
    anchorHash = canonicalSha256(anchorCanonicalPayload);
  }
  const usageEvidence = rawEvidence.usage_evidence;
  const usageEvidenceRecord = usageEvidence && typeof usageEvidence === 'object'
    && !Array.isArray(usageEvidence)
    ? usageEvidence as JsonObject
    : {};
  await tx.gatewayBillingEvent.create({
    data: {
      id: gatewayBillingEventId,
      requestId,
      status: 'RECEIVED',
      rawEvent: rawEvidence as Prisma.InputJsonValue,
      evidenceHash,
    },
  });
  await tx.gatewayUsageEvidence.create({
    data: {
      id: `protocol-${label}-evidence-${base.suffix}`,
      gatewayBillingEventId,
      requestId,
      source: 'GATEWAY_USAGE_EVENT',
      tokenSource: typeof rawEvidence.token_source === 'string'
        ? rawEvidence.token_source
        : null,
      producerBuildSha: typeof rawEvidence.producer_build_sha === 'string'
        ? rawEvidence.producer_build_sha
        : null,
      providerUsageHash: typeof rawEvidence.provider_usage_hash === 'string'
        ? rawEvidence.provider_usage_hash
        : null,
      providerAccountRef: typeof rawEvidence.provider_account_ref === 'string'
        ? rawEvidence.provider_account_ref
        : null,
      streamEndReason: typeof rawEvidence.stream_end_reason === 'string'
        ? rawEvidence.stream_end_reason
        : null,
      upstreamRequestId: typeof rawEvidence.upstream_request_id === 'string'
        ? rawEvidence.upstream_request_id
        : null,
      producerBuildAuthorizationEventId:
        funding.producerBuildAuthorizationEventId ?? null,
      producerBuildAuthorizationRevision:
        funding.producerBuildAuthorizationRevision ?? null,
      producerBuildAuthorityHash: funding.producerBuildAuthorityHash ?? null,
      usageEvidenceSource: typeof usageEvidenceRecord.source === 'string'
        ? usageEvidenceRecord.source
        : null,
      usageEvidenceStatus: typeof usageEvidenceRecord.status === 'string'
        ? usageEvidenceRecord.status
        : null,
      usageEvidenceProtocol: typeof usageEvidenceRecord.protocol === 'string'
        ? usageEvidenceRecord.protocol
        : null,
      terminalFrameSeen: typeof usageEvidenceRecord.terminal_frame_seen === 'boolean'
        ? usageEvidenceRecord.terminal_frame_seen
        : null,
      providerReconciliationRequired:
        typeof rawEvidence.provider_reconciliation_required === 'boolean'
          ? rawEvidence.provider_reconciliation_required
          : null,
      evidenceHash,
      evidenceRevision: 1,
      rawEvidence: rawEvidence as Prisma.InputJsonValue,
      observedAt: firstReceivedAt,
    },
  });
  await tx.gatewayUsageSettlementAnchor.create({
    data: {
      id: `protocol-${label}-anchor-${base.suffix}`,
      gatewayBillingEventId,
      requestId,
      apiKeyId: base.apiKeyId,
      userId: base.userId,
      tenantId: base.tenantId,
      billingAccountId: base.billingAccountId,
      productId: base.productId,
      productSlug: base.productSlug,
      billingUnit: 'BALANCE',
      billingCurrency: 'USD',
      occurredAt,
      firstReceivedAt,
      firstReceiptSequence: sequence.value,
      fundingReservationProtocol: 'V1',
      pricingHash,
      customerQuoteSnapshot: customerQuoteSnapshot as Prisma.InputJsonValue,
      customerPricingSnapshot: customerPricingSnapshot as Prisma.InputJsonValue,
      providerCostSnapshot: providerCostSnapshot as Prisma.InputJsonValue,
      anchorHash,
      canonicalPayload: anchorCanonicalPayload as Prisma.InputJsonValue,
    },
  });
  const reservationAmountUsd = new Prisma.Decimal(amountUsd);
  const collectedUsd = new Prisma.Decimal(funding.collectedUsd ?? reservationAmountUsd);
  const approvedCreditUsd = new Prisma.Decimal(funding.approvedCreditUsd ?? 0);
  const unapprovedDebtUsd = new Prisma.Decimal(funding.unapprovedDebtUsd ?? 0);
  const creditPolicyAt = funding.creditPolicyAt ?? firstReceivedAt;
  const creditPolicyWindowStart = funding.creditPolicyWindowStart ?? occurredAt;
  const creditTermsDays = funding.creditTermsDays ?? null;
  const approvedCreditDueAt = funding.approvedCreditDueAt ?? null;
  await tx.gatewayUsageFundingReservation.create({
    data: {
      id: reservationId,
      gatewayBillingEventId,
      requestId,
      billingAccountId: base.billingAccountId,
      tenantId: base.tenantId,
      userId: base.userId,
      apiKeyId: base.apiKeyId,
      billingCurrency: 'USD',
      collectedFundingProtocol: 'NON_EXPIRING_GRANTS_V1',
      occurredAt,
      firstReceivedAt,
      reservationSequence: sequence.value,
      reservedAmountUsd: reservationAmountUsd,
      collectedUsd,
      approvedCreditUsd,
      unapprovedDebtUsd,
      creditPolicyAt,
      creditPolicyWindowStart,
      creditPolicyEventId: funding.creditPolicyEventId ?? null,
      creditPolicyRevision: funding.creditPolicyRevision ?? null,
      creditTermsDays,
      approvedCreditDueAt,
      creditPolicySource: funding.creditPolicySource
        ?? (base.accountType === 'enterprise' ? 'NO_CONFIG' : 'NOT_APPLICABLE'),
      creditPolicyReconstructible: true,
      creditLimitUsd: new Prisma.Decimal(funding.creditLimitUsd ?? 0),
      creditConfiguredLimitUsd: new Prisma.Decimal(
        funding.creditConfiguredLimitUsd ?? funding.creditLimitUsd ?? 0,
      ),
      creditStatus: funding.creditStatus ?? null,
      creditEffectiveAt: funding.creditEffectiveAt ?? null,
      creditExpiresAt: funding.creditExpiresAt ?? null,
      anchorHash,
      reservationHash,
      canonicalPayload: reservationCanonicalPayload as Prisma.InputJsonValue,
    },
  });
  if (withCompleteHold && collectedUsd.gt(0)) {
    await tx.gatewayUsageFundingReservationGrant.create({
      data: {
        id: `protocol-${label}-hold-${base.suffix}`,
        fundingReservationId: reservationId,
        gatewayBillingEventId,
        balanceGrantId: base.balanceGrantId,
        amountUsd: collectedUsd,
        allocationOrder: 0,
      },
    });
  }
  return {
    requestId,
    gatewayBillingEventId,
    evidenceHash,
    anchorHash,
    pricingHash,
    reservationId,
    reservationHash,
    reservedAmountUsd: reservationAmountUsd,
    occurredAt,
    firstReceivedAt,
  };
}

async function createCreditsFixture(
  tx: Prisma.TransactionClient,
  base: BaseFixture,
  label: string,
  producerBuildSha: string,
  creditCost = 1,
  options: {
    includedUpstream?: boolean;
    customerChargeUsd?: Prisma.Decimal.Value;
    dimensions?: Partial<CustomerDimensions>;
    customerSettlementPolicyVersion?: CustomerSettlementPolicyVersion;
  } = {},
): Promise<CreditsFixture> {
  const requestId = `protocol-${label}-credits-request-${base.suffix}`;
  const gatewayBillingEventId = `protocol-${label}-credits-event-${base.suffix}`;
  const evidenceHash = `protocol-${label}-credits-evidence-hash-${base.suffix}`;
  const anchorHash = `protocol-${label}-credits-anchor-hash-${base.suffix}`;
  const pricingHash = `protocol-${label}-credits-pricing-hash-${base.suffix}`;
  const subscriptionId = `protocol-${label}-credits-subscription-${base.suffix}`;
  const planId = `protocol-${label}-credits-plan-${base.suffix}`;
  const [clock] = await tx.$queryRaw<Array<{ databaseNow: Date }>>`
    SELECT date_trunc(
      'milliseconds',
      clock_timestamp() AT TIME ZONE 'UTC'
    ) AS "databaseNow"
  `;
  if (!clock) throw new Error('missing database first-receipt clock');
  const firstReceivedAt = clock.databaseNow;
  const occurredAt = new Date(firstReceivedAt.getTime() - 5_000);
  const rawEvidence: JsonObject = {
    request_id: requestId,
    producer_build_sha: producerBuildSha,
  };
  const includedUpstream = options.includedUpstream ?? false;
  const customerSettlementPolicyVersion = options.customerSettlementPolicyVersion
    ?? CUSTOMER_SETTLEMENT_POLICY_VERSION;
  const originalDimensions: CustomerDimensions = {
    inputTokens: 100,
    outputTokens: 10,
    cachedInputTokens: 0,
    cacheWriteInputTokens: 0,
    totalTokens: 110,
    imageCount: 0,
    ...options.dimensions,
  };
  const customerChargeUsd = new Prisma.Decimal(
    includedUpstream || creditCost === 0
      ? 0
      : options.customerChargeUsd ?? '0.110000000000',
  );

  await tx.plan.create({
    data: {
      id: planId,
      productId: base.productId,
      name: `Gateway ${label} credits terminal proof`,
      monthlyCredits: 10,
    },
  });
  await tx.creditBalanceState.create({
    data: {
      subscriptionId,
      userId: base.userId,
      quota: 10,
      bonus: 0,
      version: 0n,
    },
  });

  await tx.gatewayBillingEvent.create({
    data: {
      id: gatewayBillingEventId,
      requestId,
      status: 'RECEIVED',
      apiKeyId: base.apiKeyId,
      tenantId: base.tenantId,
      billingAccountId: base.billingAccountId,
      userId: base.userId,
      productId: base.productId,
      productSlug: base.productSlug,
      modelName: 'glm-5.2',
      inputTokens: originalDimensions.inputTokens,
      outputTokens: originalDimensions.outputTokens,
      cachedInputTokens: originalDimensions.cachedInputTokens,
      cacheWriteInputTokens: originalDimensions.cacheWriteInputTokens,
      totalTokens: originalDimensions.totalTokens,
      billingUnit: 'CREDITS',
      rawEvent: rawEvidence as Prisma.InputJsonValue,
      evidenceHash,
    },
  });
  await tx.gatewayUsageEvidence.create({
    data: {
      id: `protocol-${label}-credits-evidence-${base.suffix}`,
      gatewayBillingEventId,
      requestId,
      source: 'GATEWAY_USAGE_EVENT',
      producerBuildSha,
      evidenceHash,
      evidenceRevision: 1,
      rawEvidence: rawEvidence as Prisma.InputJsonValue,
      observedAt: firstReceivedAt,
    },
  });
  await tx.gatewayUsageSettlementAnchor.create({
    data: {
      id: `protocol-${label}-credits-anchor-${base.suffix}`,
      gatewayBillingEventId,
      requestId,
      apiKeyId: base.apiKeyId,
      userId: base.userId,
      tenantId: base.tenantId,
      billingAccountId: base.billingAccountId,
      productId: base.productId,
      productSlug: base.productSlug,
      billingUnit: 'CREDITS',
      billingCurrency: 'USD',
      subscriptionId,
      planId,
      occurredAt,
      firstReceivedAt,
      firstReceiptSequence: null,
      fundingReservationProtocol: null,
      pricingHash,
      customerQuoteSnapshot: {
        unit: 'CREDITS',
        userId: base.userId,
        tenantId: base.tenantId,
        billingAccountId: base.billingAccountId,
        productId: base.productId,
        productSlug: base.productSlug,
        modelName: 'glm-5.2',
        ...originalDimensions,
        baseCreditCost: creditCost,
        creditCost,
        includedUpstream,
        subscriptionId,
        planId,
        policy: {
          id: null,
          scope: 'DEFAULT',
          modelName: null,
          priceMultiplier: '1',
          creditMultiplier: null,
          priority: 0,
        },
      },
      customerPricingSnapshot: {
        unit: 'CREDITS',
        creditCost,
        includedUpstream,
        priceBasis: includedUpstream ? 'INCLUDED_UPSTREAM' : 'SUBSCRIPTION_CREDITS',
        tokenUsagePricing: {
          status: 'VERIFIED',
          costUsd: customerChargeUsd.toFixed(12),
          pricingTierKey: 'gateway-terminal-proof',
          inputPriceUsdPerM: '1000',
          cachedInputPriceUsdPerM: '1000',
          cacheWritePriceUsdPerM: '1000',
          outputPriceUsdPerM: '1000',
        },
      },
      providerCostSnapshot: {},
      anchorHash,
      canonicalPayload: { customerSettlementPolicyVersion },
    },
  });
  return {
    requestId,
    gatewayBillingEventId,
    evidenceHash,
    anchorHash,
    pricingHash,
    subscriptionId,
    planId,
    creditCost,
    customerChargeUsd,
    includedUpstream,
    originalDimensions,
    occurredAt,
    firstReceivedAt,
  };
}

type CreditsTerminalMode = 'CHARGED' | 'ZERO' | 'INCLUDED' | 'DEBT_OPEN';

type CreditsSettlementOptions = {
  mode?: CreditsTerminalMode;
  basis?: 'NORMALIZED_EXACT' | 'CUSTOMER_PROTECTIVE_ZERO';
  settledDimensions?: CustomerDimensions;
  customerSettlementPolicyVersion?: CustomerSettlementWriterPolicyVersion;
};

async function settleCreditsFixture(
  tx: Prisma.TransactionClient,
  base: BaseFixture,
  fixture: CreditsFixture,
  label: string,
  options: CreditsSettlementOptions = {},
): Promise<string> {
  const tokenUsageId = `protocol-${label}-credits-usage-${base.suffix}`;
  const mode = options.mode ?? (fixture.includedUpstream
    ? 'INCLUDED'
    : fixture.creditCost === 0 ? 'ZERO' : 'CHARGED');
  const basis = options.basis ?? 'NORMALIZED_EXACT';
  const customerSettlementPolicyVersion =
    options.customerSettlementPolicyVersion
    ?? CUSTOMER_SETTLEMENT_POLICY_VERSION;
  const settledDimensions = options.settledDimensions ?? (
    basis === 'CUSTOMER_PROTECTIVE_ZERO'
      ? {
          inputTokens: 0,
          outputTokens: 0,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          totalTokens: 0,
          imageCount: 0,
        }
      : fixture.originalDimensions
  );
  const settledCreditCost = mode === 'ZERO' ? 0 : fixture.creditCost;
  const settledChargeUsd = mode === 'ZERO' || mode === 'INCLUDED'
    ? new Prisma.Decimal(0)
    : fixture.customerChargeUsd;
  const settlementFingerprint =
    `protocol-${label}-credits-fingerprint-${base.suffix}`;
  const creditMutationIdempotencyKey =
    `gateway:credits:${fixture.requestId}:${fixture.anchorHash}`;
  const financialReceiptIdempotencyKey =
    `gateway:financial:${fixture.requestId}:${fixture.anchorHash}`;
  const fundingOutcome = mode === 'DEBT_OPEN' ? 'DEBT_OPEN' : 'INCLUDED';
  const terminalClass = mode === 'CHARGED'
    ? 'CREDITS_CHARGED'
    : mode === 'ZERO'
      ? 'CREDITS_ZERO'
      : mode === 'INCLUDED'
        ? 'CREDITS_INCLUDED'
        : 'CREDITS_DEBT_OPEN';
  const quote = {
    unit: 'CREDITS',
    userId: base.userId,
    tenantId: base.tenantId,
    billingAccountId: base.billingAccountId,
    productId: base.productId,
    productSlug: base.productSlug,
    modelName: 'glm-5.2',
    ...settledDimensions,
    subscriptionId: fixture.subscriptionId,
    planId: fixture.planId,
    baseCreditCost: settledCreditCost,
    creditCost: settledCreditCost,
    includedUpstream: mode === 'INCLUDED',
    policy: {
      id: null,
      scope: 'DEFAULT',
      modelName: null,
      priceMultiplier: '1',
      creditMultiplier: null,
      priority: 0,
    },
  };
  const billingResult: JsonObject = {
    success: mode !== 'DEBT_OPEN',
    allowed: mode !== 'DEBT_OPEN',
    unit: 'CREDITS',
    fundingOutcome,
    quote,
    ...(mode === 'INCLUDED' ? { upstreamIncluded: true } : {}),
    ...(mode === 'ZERO' ? {
      reason: 'zero_priced_credits',
      zeroCreditCharge: {
        protocol: 'gateway-credits-zero-charge-v1',
        creditMutationIdempotencyKey,
      },
    } : {}),
    ...(mode === 'DEBT_OPEN' ? {
      reason: 'insufficient_credits',
      debtOpen: true,
      debtCredits: settledCreditCost,
      debtExposureUsd: settledChargeUsd.toFixed(12),
    } : {}),
    tokenUsageId,
  };
  const customerFinancialAuthority = {
    protocol: 'gateway-customer-financial-authority-v1',
    policyVersion: customerSettlementPolicyVersion,
    basis,
    billingUnit: 'CREDITS',
    terminalClass,
    fundingOutcome,
    customerAmountUnit: 'CREDITS',
    originalCustomerAmount: String(fixture.creditCost),
    settledCustomerAmount: String(settledCreditCost),
    originalCustomerChargeUsd: fixture.customerChargeUsd.toFixed(12),
    settledCustomerChargeUsd: settledChargeUsd.toFixed(12),
    originalDimensions: fixture.originalDimensions,
    settledDimensions,
    anchorHash: fixture.anchorHash,
    pricingHash: fixture.pricingHash,
    settlementFingerprint,
    tokenUsageId,
  };
  await tx.$executeRaw`
    SELECT set_config('ruidong.gateway_settlement_protocol', 'v1', true)
  `;
  await tx.tokenUsage.create({
    data: {
      id: tokenUsageId,
      apiKeyId: base.apiKeyId,
      tenantId: base.tenantId,
      productId: base.productId,
      gatewayBillingEventId: fixture.gatewayBillingEventId,
      requestId: fixture.requestId,
      model: 'glm-5.2',
      meter: settledDimensions.imageCount > 0 ? 'image' : 'token',
      ...(settledDimensions.imageCount > 0
        ? { quantity: settledDimensions.imageCount, unitPriceUsd: new Prisma.Decimal(0) }
        : {}),
      promptTokens: settledDimensions.inputTokens,
      ...(settledDimensions.cachedInputTokens > 0
        ? { cachedInputTokens: settledDimensions.cachedInputTokens }
        : {}),
      ...(settledDimensions.cacheWriteInputTokens > 0
        ? { cacheWriteInputTokens: settledDimensions.cacheWriteInputTokens }
        : {}),
      completionTokens: settledDimensions.outputTokens,
      totalTokens: settledDimensions.totalTokens,
      inputPriceUsdPerM: new Prisma.Decimal(0),
      outputPriceUsdPerM: new Prisma.Decimal(0),
      costUsd: settledChargeUsd,
      customerChargePolicy: mode === 'INCLUDED'
        ? 'included_upstream'
        : mode === 'DEBT_OPEN'
          ? 'debt_open'
          : 'subscription_credits',
      customerChargeUsd: settledChargeUsd,
      customerCollectedUsd: mode === 'CHARGED' ? settledChargeUsd : new Prisma.Decimal(0),
      customerApprovedReceivableUsd: new Prisma.Decimal(0),
      customerUnapprovedDebtUsd:
        mode === 'DEBT_OPEN' ? settledChargeUsd : new Prisma.Decimal(0),
      customerFundingClassificationComplete: true,
    },
  });
  if (mode === 'CHARGED') {
    await tx.creditTransaction.create({
      data: {
        id: `protocol-${label}-credits-transaction-${base.suffix}`,
        userId: base.userId,
        tenantId: base.tenantId,
        productId: base.productId,
        subscriptionId: fixture.subscriptionId,
        type: 'CONSUME',
        creditsAmount: -settledCreditCost,
        source: 'gateway-terminal-proof',
        modelName: 'glm-5.2',
        inputTokens: settledDimensions.inputTokens,
        cachedInputTokens: settledDimensions.cachedInputTokens,
        outputTokens: settledDimensions.outputTokens,
        totalTokens: settledDimensions.totalTokens,
        requestId: fixture.requestId,
        quotaAfter: Math.max(0, 10 - settledCreditCost),
        bonusAfter: 0,
        balanceVersion: 1n,
        idempotencyKey: creditMutationIdempotencyKey,
      },
    });
  }
  await tx.gatewayUsageSettlementReceipt.create({
    data: {
      id: `protocol-${label}-credits-receipt-${base.suffix}`,
      gatewayBillingEventId: fixture.gatewayBillingEventId,
      requestId: fixture.requestId,
      settlementRevision: 1,
      fundingOutcome,
      evidenceHash: fixture.evidenceHash,
      anchorHash: fixture.anchorHash,
      pricingHash: fixture.pricingHash,
      settlementFingerprint,
      billingUnit: 'CREDITS',
      billingCurrency: 'USD',
      creditAmount: settledCreditCost,
      amountUsd: mode === 'DEBT_OPEN' ? settledChargeUsd : new Prisma.Decimal(0),
      tokenUsageId,
      ...(mode === 'ZERO' ? { reason: 'zero_priced_credits' } : {}),
      ...(mode === 'DEBT_OPEN' ? { reason: 'insufficient_credits' } : {}),
      policyVersion: 'gateway-settlement-v3-customer-authority',
      idempotencyKey: financialReceiptIdempotencyKey,
      payload: {
        anchorHash: fixture.anchorHash,
        pricingHash: fixture.pricingHash,
        settlementFingerprint,
        customerFinancialAuthority,
        billingResult,
      } as Prisma.InputJsonValue,
    },
  });
  return tokenUsageId;
}

async function settleZeroCreditsFixture(
  tx: Prisma.TransactionClient,
  base: BaseFixture,
  fixture: CreditsFixture,
  label: string,
  options: Omit<CreditsSettlementOptions, 'mode'> = {},
): Promise<string> {
  return settleCreditsFixture(tx, base, fixture, label, {
    mode: 'ZERO',
    basis: fixture.creditCost === 0
      ? 'NORMALIZED_EXACT'
      : 'CUSTOMER_PROTECTIVE_ZERO',
    ...options,
  });
}

type UsageFunding = {
  chargeUsd: Prisma.Decimal.Value;
  collectedUsd: Prisma.Decimal.Value;
  approvedUsd: Prisma.Decimal.Value;
  unapprovedUsd: Prisma.Decimal.Value;
};

async function createUsageForTerminalProof(
  tx: Prisma.TransactionClient,
  base: BaseFixture,
  reservation: ReservationFixture,
  label: string,
  funding: UsageFunding,
): Promise<string> {
  const tokenUsageId = `protocol-${label}-usage-${base.suffix}`;
  await tx.$executeRaw`
    SELECT set_config('ruidong.gateway_settlement_protocol', 'v1', true)
  `;
  await tx.tokenUsage.create({
    data: {
      id: tokenUsageId,
      apiKeyId: base.apiKeyId,
      tenantId: base.tenantId,
      productId: base.productId,
      gatewayBillingEventId: reservation.gatewayBillingEventId,
      requestId: reservation.requestId,
      model: 'glm-5.2',
      promptTokens: 100,
      completionTokens: 10,
      totalTokens: 110,
      inputPriceUsdPerM: new Prisma.Decimal(1_000),
      outputPriceUsdPerM: new Prisma.Decimal(1_000),
      costUsd: new Prisma.Decimal(funding.chargeUsd),
      customerChargePolicy: 'payg_balance',
      customerChargeUsd: new Prisma.Decimal(funding.chargeUsd),
      customerCollectedUsd: new Prisma.Decimal(funding.collectedUsd),
      customerApprovedReceivableUsd: new Prisma.Decimal(funding.approvedUsd),
      customerUnapprovedDebtUsd: new Prisma.Decimal(funding.unapprovedUsd),
      customerFundingClassificationComplete: true,
    },
  });
  return tokenUsageId;
}

async function transitionReservation(
  tx: Prisma.TransactionClient,
  reservationId: string,
  protocol: 'consume-v1' | 'manual-review-v1' | 'release-v1',
  data: Prisma.GatewayUsageFundingReservationUpdateInput,
): Promise<void> {
  await tx.$executeRaw`
    SELECT
      set_config('ruidong.gateway_funding_transition_protocol', ${protocol}, true),
      set_config('ruidong.gateway_funding_transition_reservation_id', ${reservationId}, true)
  `;
  await tx.gatewayUsageFundingReservation.update({ where: { id: reservationId }, data });
}

async function assertTerminalProof(
  tx: Prisma.TransactionClient,
  reservationId: string,
): Promise<void> {
  await tx.$queryRaw`
    SELECT assert_gateway_usage_funding_terminal(${reservationId})::TEXT AS "proof"
  `;
}

type FinancialProofOptions = {
  funding: UsageFunding;
  receiptEvidenceHash?: string;
  fundingOutcome?: 'COLLECTED' | 'RECEIVABLE' | 'DEBT_OPEN';
  receiptPolicyVersion?: 'gateway-settlement-v2'
    | 'gateway-settlement-v3-customer-authority';
  receiptIdempotencyKey?: string;
  receiptPayload?: Prisma.InputJsonValue;
  allocationSource?: string;
  allocationBalanceGrantId?: string | null;
  allocationApprovedUsd?: Prisma.Decimal.Value;
  allocationUnapprovedUsd?: Prisma.Decimal.Value;
  creditPolicyAt?: Date | null;
  creditTermsDays?: number | null;
  creditDueAt?: Date | null;
  creditPolicySnapshotComplete?: boolean;
};

async function createFinancialProofRows(
  tx: Prisma.TransactionClient,
  base: BaseFixture,
  reservation: ReservationFixture,
  label: string,
  options: FinancialProofOptions,
): Promise<string> {
  const financialNow = new Date();
  await tx.$queryRaw`
    SELECT "billing_account_id" FROM "account_wallets"
    WHERE "billing_account_id" = ${base.billingAccountId} FOR UPDATE
  `;
  await tx.$queryRaw`
    SELECT "id" FROM "balance_grants"
    WHERE "billing_account_id" = ${base.billingAccountId}
    ORDER BY "created_at", "id" FOR UPDATE
  `;
  await tx.$executeRaw`
    SELECT
      set_config('billing.balance_financial_now', ${financialNow.toISOString()}, true),
      set_config('ruidong.gateway_consuming_reservation_id', ${reservation.reservationId}, true)
  `;
  const tokenUsageId = await createUsageForTerminalProof(
    tx,
    base,
    reservation,
    label,
    options.funding,
  );
  const balanceTransactionId = `protocol-${label}-tx-${base.suffix}`;
  const wallet = await tx.accountWallet.findUniqueOrThrow({
    where: { billingAccountId: base.billingAccountId },
    select: { balanceUsd: true },
  });
  const balanceAfterUsd = new Prisma.Decimal(wallet.balanceUsd)
    .minus(options.funding.chargeUsd);
  await tx.accountWallet.update({
    where: { billingAccountId: base.billingAccountId },
    data: { balanceUsd: balanceAfterUsd },
  });
  const collectedUsd = new Prisma.Decimal(options.funding.collectedUsd);
  if (collectedUsd.gt(0)) {
    const grant = await tx.balanceGrant.findUniqueOrThrow({
      where: { id: base.balanceGrantId },
      select: {
        remainingAmountUsd: true,
        remainingPaidAmountUsd: true,
      },
    });
    await tx.balanceGrant.update({
      where: { id: base.balanceGrantId },
      data: {
        remainingAmountUsd: new Prisma.Decimal(grant.remainingAmountUsd).minus(collectedUsd),
        remainingPaidAmountUsd:
          new Prisma.Decimal(grant.remainingPaidAmountUsd ?? 0).minus(collectedUsd),
      },
    });
  }
  await tx.balanceTransaction.create({
    data: {
      id: balanceTransactionId,
      operationKey: `gateway:${reservation.requestId}:${label}`,
      userId: base.userId,
      tenantId: base.tenantId,
      billingAccountId: base.billingAccountId,
      type: TransactionType.CONSUME,
      amountUsd: new Prisma.Decimal(options.funding.chargeUsd).neg(),
      balanceAfterUsd,
      description: `Gateway terminal proof ${label}`,
      productId: base.productId,
      tokenUsageId,
      createdAt: financialNow,
    },
  });
  await tx.balanceConsumptionAllocation.create({
    data: {
      id: `protocol-${label}-allocation-${base.suffix}`,
      userId: base.userId,
      tenantId: base.tenantId,
      billingAccountId: base.billingAccountId,
      productId: base.productId,
      balanceTransactionId,
      tokenUsageId,
      balanceGrantId: options.allocationBalanceGrantId === undefined
        ? base.balanceGrantId
        : options.allocationBalanceGrantId,
      source: options.allocationSource ?? 'BALANCE_GRANT',
      amountUsd: new Prisma.Decimal(options.funding.chargeUsd),
      recognizedRevenueUsd: collectedUsd,
      bonusConsumedUsd: new Prisma.Decimal(0),
      discountRate: collectedUsd.gt(0) ? new Prisma.Decimal(1) : new Prisma.Decimal(0),
      approvedCreditUsd: new Prisma.Decimal(options.allocationApprovedUsd ?? 0),
      unapprovedDebtUsd: new Prisma.Decimal(options.allocationUnapprovedUsd ?? 0),
      fundingClassificationComplete: true,
      creditPolicyAt: options.creditPolicyAt,
      creditTermsDays: options.creditTermsDays,
      creditDueAt: options.creditDueAt,
      creditPolicySnapshotComplete: options.creditPolicySnapshotComplete ?? false,
      createdAt: financialNow,
    },
  });
  await transitionReservation(tx, reservation.reservationId, 'consume-v1', {
    status: 'CONSUMED',
    authoritativeAmountUsd: new Prisma.Decimal(options.funding.chargeUsd),
    consumedAt: financialNow,
  });
  await tx.gatewayUsageSettlementReceipt.create({
    data: {
      id: `protocol-${label}-receipt-${base.suffix}`,
      gatewayBillingEventId: reservation.gatewayBillingEventId,
      requestId: reservation.requestId,
      settlementRevision: 1,
      fundingOutcome: options.fundingOutcome ?? 'COLLECTED',
      evidenceHash: options.receiptEvidenceHash ?? reservation.evidenceHash,
      anchorHash: reservation.anchorHash,
      pricingHash: reservation.pricingHash,
      settlementFingerprint: `protocol-${label}-fingerprint-${base.suffix}`,
      billingUnit: 'BALANCE',
      billingCurrency: 'USD',
      amountUsd: new Prisma.Decimal(options.funding.chargeUsd),
      tokenUsageId,
      policyVersion: options.receiptPolicyVersion ?? 'gateway-settlement-v2',
      idempotencyKey: options.receiptIdempotencyKey
        ?? `gateway:financial:${reservation.requestId}:${label}`,
      payload: options.receiptPayload ?? {},
    },
  });
  return tokenUsageId;
}

type AbsorbProofOptions = {
  amountUsd?: Prisma.Decimal.Value;
  billingCurrency?: string;
  evidenceHash?: string;
  anchorHash?: string;
  pricingHash?: string;
  settlementFingerprint?: string;
  eventReason?: string;
  actionReason?: string;
  receiptReason?: string;
  actionActorId?: string | null;
  receiptActorId?: string | null;
  expectedRevision?: number;
  resultingRevision?: number;
  settlementRevision?: number;
  metadataOverrides?: JsonObject;
  payloadOverrides?: JsonObject;
  pendingExposureUsd?: Prisma.Decimal.Value;
  includeTokenUsage?: boolean;
  bindManualReceiptToUsage?: boolean;
  includeV2Receipt?: boolean;
};

async function createAbsorbProofRows(
  tx: Prisma.TransactionClient,
  base: BaseFixture,
  reservation: ReservationFixture,
  label: string,
  options: AbsorbProofOptions,
): Promise<void> {
  const actorId = `finance-${base.suffix}`;
  const idempotencyKey = `absorb-${label}-${base.suffix}`;
  const eventReason = options.eventReason ?? 'approved platform absorption';
  const evidenceHash = options.evidenceHash ?? reservation.evidenceHash;
  const anchorHash = options.anchorHash ?? reservation.anchorHash;
  const pricingHash = options.pricingHash ?? reservation.pricingHash;
  const billingCurrency = options.billingCurrency ?? 'USD';
  const approvedAbsorptionUsd = reservation.reservedAmountUsd.toFixed(12);
  const settlementFingerprint = options.settlementFingerprint
    ?? `protocol-absorb-${label}-fingerprint-${base.suffix}`;
  const metadata = {
    protocol: 'gateway-absorb-v2',
    fundingReservationId: reservation.reservationId,
    reservationHash: reservation.reservationHash,
    anchorHash,
    pricingHash,
    evidenceHash,
    billingCurrency,
    approvedAbsorptionUsd,
    settlementFingerprint,
    ...options.metadataOverrides,
  };
  const payload = {
    ...metadata,
    customerDeductionUsd: '0',
    ...options.payloadOverrides,
  };
  let tokenUsageId: string | null = null;
  if (options.includeTokenUsage) {
    tokenUsageId = await createUsageForTerminalProof(
      tx,
      base,
      reservation,
      `absorb-${label}`,
      { chargeUsd: 0, collectedUsd: 0, approvedUsd: 0, unapprovedUsd: 0 },
    );
  }
  await tx.gatewayBillingEvent.update({
    where: { id: reservation.gatewayBillingEventId },
    data: {
      status: 'ABSORBED',
      reason: eventReason,
      reconciliationStatus: 'CLOSED',
      fundingOutcome: 'ABSORBED',
      // Deliberately not authoritative. The terminal proof must bind the
      // immutable reservation amount, even if this mutable projection differs.
      pendingExposureUsd: new Prisma.Decimal(
        options.pendingExposureUsd ?? reservation.reservedAmountUsd.times(7),
      ),
      pendingHoldUsd: new Prisma.Decimal(0),
      revision: { increment: 1 },
    },
  });
  await tx.gatewayUsageReconciliationAction.create({
    data: {
      gatewayBillingEventId: reservation.gatewayBillingEventId,
      requestId: reservation.requestId,
      action: 'ABSORB',
      expectedRevision: options.expectedRevision ?? 0,
      resultingRevision: options.resultingRevision ?? 1,
      reason: options.actionReason ?? eventReason,
      actorId: options.actionActorId === undefined ? actorId : options.actionActorId,
      idempotencyKey,
      metadata: metadata as Prisma.InputJsonValue,
    },
  });
  await tx.gatewayUsageSettlementReceipt.create({
    data: {
      id: `protocol-absorb-${label}-receipt-${base.suffix}`,
      gatewayBillingEventId: reservation.gatewayBillingEventId,
      requestId: reservation.requestId,
      settlementRevision: options.settlementRevision ?? 1,
      fundingOutcome: 'ABSORBED',
      evidenceHash,
      anchorHash,
      pricingHash,
      settlementFingerprint,
      billingUnit: 'BALANCE',
      billingCurrency,
      amountUsd: new Prisma.Decimal(options.amountUsd ?? reservation.reservedAmountUsd),
      tokenUsageId: options.bindManualReceiptToUsage ? tokenUsageId : null,
      reason: options.receiptReason ?? eventReason,
      policyVersion: 'manual-finance-v2',
      actorId: options.receiptActorId === undefined ? actorId : options.receiptActorId,
      idempotencyKey: `receipt:${idempotencyKey}`,
      payload: payload as Prisma.InputJsonValue,
    },
  });
  if (options.includeV2Receipt && tokenUsageId) {
    await tx.gatewayUsageSettlementReceipt.create({
      data: {
        id: `protocol-absorb-${label}-v2-receipt-${base.suffix}`,
        gatewayBillingEventId: reservation.gatewayBillingEventId,
        requestId: reservation.requestId,
        settlementRevision: 2,
        fundingOutcome: 'COLLECTED',
        evidenceHash: reservation.evidenceHash,
        anchorHash: reservation.anchorHash,
        pricingHash: reservation.pricingHash,
        settlementFingerprint: `protocol-absorb-${label}-v2-${base.suffix}`,
        billingUnit: 'BALANCE',
        billingCurrency: 'USD',
        amountUsd: new Prisma.Decimal(0),
        tokenUsageId,
        policyVersion: 'gateway-settlement-v2',
        idempotencyKey: `gateway:financial:${reservation.requestId}:${label}`,
        payload: {},
      },
    });
  }
  await transitionReservation(tx, reservation.reservationId, 'release-v1', {
    status: 'RELEASED',
    releasedAt: new Date(),
    releaseReason: `financial_absorption:${idempotencyKey}`,
  });
}

async function createNoChargeProofRows(
  tx: Prisma.TransactionClient,
  reservation: ReservationFixture,
  label: string,
  reason: string,
): Promise<void> {
  const settlementFingerprint =
    `protocol-no-charge-${label}-fingerprint-${reservation.reservationId}`;
  await tx.gatewayBillingEvent.update({
    where: { id: reservation.gatewayBillingEventId },
    data: {
      status: 'SKIPPED',
      reason,
      reconciliationStatus: 'CLOSED',
      fundingOutcome: 'NO_CHARGE',
      pendingExposureUsd: new Prisma.Decimal(0),
      pendingHoldUsd: new Prisma.Decimal(0),
      revision: { increment: 1 },
    },
  });
  await tx.gatewayUsageSettlementReceipt.create({
    data: {
      id: `protocol-no-charge-${label}-receipt-${reservation.reservationId}`,
      gatewayBillingEventId: reservation.gatewayBillingEventId,
      requestId: reservation.requestId,
      settlementRevision: 1,
      fundingOutcome: 'NO_CHARGE',
      evidenceHash: reservation.evidenceHash,
      anchorHash: reservation.anchorHash,
      pricingHash: reservation.pricingHash,
      settlementFingerprint,
      billingUnit: 'BALANCE',
      billingCurrency: 'USD',
      amountUsd: new Prisma.Decimal(0),
      reason,
      policyVersion: 'gateway-no-charge-v1',
      idempotencyKey: `gateway:no-charge:${reservation.requestId}:${reservation.anchorHash}`,
      payload: {
        customerDeductionUsd: '0',
        evidenceHash: reservation.evidenceHash,
        anchorHash: reservation.anchorHash,
        pricingHash: reservation.pricingHash,
        settlementFingerprint,
        reason,
      },
    },
  });
  await transitionReservation(tx, reservation.reservationId, 'release-v1', {
    status: 'RELEASED',
    releasedAt: new Date(),
    releaseReason: `non_financial:${reason}`,
  });
}

async function reserveExistingServiceAnchor(
  prisma: PrismaClient,
  base: BaseFixture,
  gatewayBillingEventId: string,
  anchor: Record<string, any>,
) {
  const existing = await prisma.gatewayUsageFundingReservation.findUnique({
    where: { requestId: anchor.requestId },
  });
  if (existing) return existing;
  const reservedAmountUsd = new Prisma.Decimal(
    anchor.customerQuoteSnapshot.effectiveCostUsd,
  );
  return prisma.$transaction(async (tx) => {
    const reservation = await tx.gatewayUsageFundingReservation.create({
      data: {
        id: `protocol-service-reservation-${base.suffix}`,
        gatewayBillingEventId,
        requestId: anchor.requestId,
        billingAccountId: base.billingAccountId,
        tenantId: base.tenantId,
        userId: base.userId,
        apiKeyId: base.apiKeyId,
        billingUnit: 'BALANCE',
        billingCurrency: 'USD',
        collectedFundingProtocol: 'NON_EXPIRING_GRANTS_V1',
        occurredAt: anchor.occurredAt,
        firstReceivedAt: anchor.firstReceivedAt,
        reservationSequence: anchor.firstReceiptSequence,
        reservedAmountUsd,
        collectedUsd: reservedAmountUsd,
        approvedCreditUsd: new Prisma.Decimal(0),
        unapprovedDebtUsd: new Prisma.Decimal(0),
        creditPolicyAt: anchor.occurredAt,
        creditPolicyWindowStart: anchor.occurredAt,
        creditPolicyEventId: null,
        creditPolicyRevision: null,
        creditPolicySource: 'NOT_APPLICABLE',
        creditPolicyReconstructible: true,
        creditConfiguredLimitUsd: new Prisma.Decimal(0),
        creditLimitUsd: new Prisma.Decimal(0),
        creditTermsDays: null,
        approvedCreditDueAt: null,
        creditStatus: null,
        creditEffectiveAt: null,
        creditExpiresAt: null,
        anchorHash: anchor.anchorHash,
        reservationHash: `protocol-service-reservation-hash-${base.suffix}`,
        canonicalPayload: {},
      },
    });
    await tx.gatewayUsageFundingReservationGrant.create({
      data: {
        id: `protocol-service-hold-${base.suffix}`,
        fundingReservationId: reservation.id,
        gatewayBillingEventId,
        balanceGrantId: base.balanceGrantId,
        amountUsd: reservedAmountUsd,
        allocationOrder: 0,
      },
    });
    return reservation;
  });
}

function eventNewCreditFunding(
  policy: CreditPolicyFixture,
  times: {
    windowStart: Date;
    occurredAt: Date;
    policyAt: Date;
    firstReceivedAt: Date;
  },
  approvedCreditUsd: Prisma.Decimal.Value = 1,
): ReservationFundingOptions {
  return {
    collectedUsd: 0,
    approvedCreditUsd,
    unapprovedDebtUsd: 0,
    occurredAt: times.occurredAt,
    firstReceivedAt: times.firstReceivedAt,
    creditPolicyWindowStart: times.windowStart,
    creditPolicyAt: times.policyAt,
    creditPolicyEventId: policy.eventId,
    creditPolicyRevision: policy.revision,
    creditPolicySource: 'EVENT_NEW_STATE',
    creditLimitUsd: policy.limitUsd,
    creditConfiguredLimitUsd: policy.limitUsd,
    creditTermsDays: policy.termsDays,
    approvedCreditDueAt: new Date(
      times.policyAt.getTime() + policy.termsDays * 24 * 60 * 60 * 1_000,
    ),
    creditStatus: policy.status,
    creditEffectiveAt: policy.effectiveAt,
    creditExpiresAt: policy.expiresAt,
  };
}

async function ensureEvidenceContractMode(
  prisma: PrismaClient,
  mode: 'SHADOW' | 'ENFORCE',
  ticket: string,
): Promise<void> {
  const [rollout] = await prisma.$queryRaw<Array<{ mode: string }>>`
    SELECT current_gateway_usage_evidence_contract_mode() AS mode
  `;
  if (!rollout) throw new Error('missing Gateway evidence rollout control');
  if (rollout.mode !== mode) {
    await prisma.$queryRaw`
      SELECT transition_gateway_usage_evidence_contract_mode(
        ${mode},
        ${ticket},
        'test-release-approver',
        'test-finance-approver'
      )
    `;
  }
}

maybeDescribe('Gateway settlement terminal PostgreSQL proof (integration)', () => {
  const prisma = new PrismaClient();

  beforeAll(async () => {
    const expectedDatabase = process.env.TEST_DATABASE_NAME?.trim();
    if (!expectedDatabase || !/(test|ci)/i.test(expectedDatabase)) {
      throw new Error('TEST_DATABASE_NAME must name an isolated test/ci database');
    }
    const [row] = await prisma.$queryRaw<Array<{ databaseName: string }>>`
      SELECT current_database() AS "databaseName"
    `;
    if (row?.databaseName !== expectedDatabase) {
      throw new Error(
        `integration database mismatch expected=${expectedDatabase} actual=${row?.databaseName}`,
      );
    }

    const currentAuthority = await prisma.$queryRaw<
      Array<{ producerBuildSha: string }>
    >`
      SELECT producer_build_sha AS "producerBuildSha"
      FROM current_gateway_producer_build_authorizations()
      WHERE producer_build_sha = ${VERIFIED_PRODUCER_BUILD_SHA}
    `;
    if (currentAuthority.length === 0) {
      await prisma.$queryRaw`
        SELECT append_gateway_producer_build_authorization(
          ${VERIFIED_PRODUCER_BUILD_SHA},
          'AUTHORIZED',
          'TEST-GATEWAY-BUILD-AUTHORITY',
          'test-finance-approver',
          'test-platform-approver'
        )
      `;
    }

    await ensureEvidenceContractMode(
      prisma,
      'ENFORCE',
      'TEST-SETUP-GATEWAY-EVIDENCE-ENFORCE',
    );
  });

  afterEach(async () => {
    await ensureEvidenceContractMode(
      prisma,
      'ENFORCE',
      'TEST-RESTORE-GATEWAY-EVIDENCE-ENFORCE',
    );
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('fails both startup/terminal Release-B proof when phase or any exact strict trigger drifts', async () => {
    await expect(prisma.$queryRaw`
      SELECT assert_gateway_balance_ledger_v2_contract()::TEXT AS "proof"
    `).resolves.toBeDefined();

    await expectPostgresFailure(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'ALTER TABLE "balance_ledger_rollout_control" DISABLE TRIGGER USER',
        );
        await tx.$executeRawUnsafe(
          'ALTER TABLE "balance_ledger_rollout_control" DROP CONSTRAINT "balance_ledger_rollout_control_phase_check"',
        );
        await tx.$executeRawUnsafe(
          'UPDATE "balance_ledger_rollout_control" SET "phase" = \'EXPANDED\' WHERE "id" = 1',
        );
        await tx.$queryRaw`
          SELECT assert_gateway_balance_ledger_v2_contract()::TEXT AS "proof"
        `;
      }),
      'gateway settlement requires Release-B V2_CONTRACT phase',
    );

    await expectPostgresFailure(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'ALTER TABLE "balance_grants" DISABLE TRIGGER "balance_grants_expiry_reconciled_v2_guard"',
        );
        await tx.$queryRaw`
          SELECT assert_gateway_balance_ledger_v2_contract()::TEXT AS "proof"
        `;
      }),
      'gateway settlement Release-B trigger contract failed',
    );

    await expectPostgresFailure(
      prisma.$transaction(async (tx) => {
        await tx.$executeRawUnsafe(
          'DROP TRIGGER "balance_grants_expiry_reconciled_v2_guard" ON "balance_grants"',
        );
        await tx.$queryRaw`
          SELECT assert_gateway_balance_ledger_v2_contract()::TEXT AS "proof"
        `;
      }),
      'gateway settlement Release-B trigger contract failed',
    );

    await expect(prisma.$queryRaw`
      SELECT assert_gateway_balance_ledger_v2_contract()::TEXT AS "proof"
    `).resolves.toBeDefined();
  }, 30_000);

  it('allows build authority changes only through the immutable two-approver append protocol', async () => {
    const [authority] = await prisma.$queryRaw<Array<{
      id: string;
      revision: number;
      decision: string;
      authorityHash: string;
    }>>`
      SELECT
        id,
        revision,
        decision,
        authority_hash AS "authorityHash"
      FROM "gateway_producer_build_authorization_events"
      WHERE producer_build_sha = ${VERIFIED_PRODUCER_BUILD_SHA}
      ORDER BY revision DESC
      LIMIT 1
    `;
    expect(authority).toMatchObject({ revision: 1, decision: 'AUTHORIZED' });
    expect(authority?.authorityHash).toMatch(/^[0-9a-f]{64}$/);

    await expectPostgresFailure(
      prisma.$executeRaw`
        INSERT INTO "gateway_producer_build_authorization_events" (
          "id", "producer_build_sha", "revision", "decision",
          "effective_at", "change_ticket", "approver_one", "approver_two",
          "previous_authority_hash", "authority_hash", "created_at"
        ) VALUES (
          ${randomUUID()}, ${UNAUTHORIZED_PRODUCER_BUILD_SHA}, 1, 'AUTHORIZED',
          clock_timestamp() AT TIME ZONE 'UTC', 'FORGED-TICKET',
          'forged-one', 'forged-two', NULL, ${'0'.repeat(64)},
          clock_timestamp() AT TIME ZONE 'UTC'
        )
      `,
      'gateway producer build authorization requires controlled append function',
    );

    await expectPostgresFailure(
      prisma.$executeRaw`
        UPDATE "gateway_producer_build_authorization_events"
        SET "change_ticket" = 'MUTATED'
        WHERE "id" = ${authority?.id}
      `,
      'gateway producer build authorization events are append-only',
    );

    await expectPostgresFailure(
      prisma.$queryRaw`
        SELECT append_gateway_producer_build_authorization(
          ${VERIFIED_PRODUCER_BUILD_SHA},
          'REVOKED',
          'TEST-SAME-APPROVER',
          'same-approver',
          'same-approver'
        )
      `,
      'requires ticket and two distinct approvers',
    );
  }, 30_000);

  it('keeps READ COMMITTED proof but decouples customer settlement from SHADOW/ENFORCE build authority', async () => {
    await ensureEvidenceContractMode(
      prisma,
      'SHADOW',
      'TEST-ENABLE-GATEWAY-EVIDENCE-SHADOW',
    );
    const [initialMode] = await prisma.$queryRaw<Array<{ mode: string }>>`
      SELECT current_gateway_usage_evidence_contract_mode() AS mode
    `;
    expect(initialMode).toEqual({ mode: 'SHADOW' });

    const base = await createBaseFixture(
      prisma,
      'evidence-shadow-candidate',
      { openingBalanceUsd: 5 },
    );
    const candidateBalance = await prisma.$transaction((tx) =>
      createReservationFixture(tx, base, 'shadow-candidate-balance', true, 1, {
        rawEvidence: { producer_build_sha: UNAUTHORIZED_PRODUCER_BUILD_SHA },
      }));
    const candidateCredits = await prisma.$transaction((tx) =>
      createCreditsFixture(
        tx,
        base,
        'shadow-candidate',
        UNAUTHORIZED_PRODUCER_BUILD_SHA,
      ));
    await expectPostgresFailure(
      prisma.$transaction(async (tx) => {
        await createFinancialProofRows(
          tx,
          base,
          candidateBalance,
          'shadow-candidate-repeatable-read',
          {
            funding: {
              chargeUsd: 1,
              collectedUsd: 1,
              approvedUsd: 0,
              unapprovedUsd: 0,
            },
          },
        );
        await assertTerminalProof(tx, candidateBalance.reservationId);
      }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead }),
      'gateway financial terminal requires READ COMMITTED isolation',
    );
    await expectPostgresFailure(
      prisma.$transaction(
        (tx) => settleCreditsFixture(
          tx,
          base,
          candidateCredits,
          'shadow-candidate-repeatable-read',
        ),
        { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
      ),
      'gateway financial terminal requires READ COMMITTED isolation',
    );

    await prisma.$transaction(async (tx) => {
      await createFinancialProofRows(tx, base, candidateBalance, 'shadow-candidate', {
        funding: {
          chargeUsd: 1,
          collectedUsd: 1,
          approvedUsd: 0,
          unapprovedUsd: 0,
        },
      });
      await assertTerminalProof(tx, candidateBalance.reservationId);
    });
    await prisma.$transaction((tx) =>
      settleCreditsFixture(tx, base, candidateCredits, 'shadow-candidate'));

    await ensureEvidenceContractMode(
      prisma,
      'ENFORCE',
      'TEST-ENABLE-GATEWAY-EVIDENCE-ENFORCEMENT',
    );
    const [enforcedMode] = await prisma.$queryRaw<Array<{ mode: string }>>`
      SELECT current_gateway_usage_evidence_contract_mode() AS mode
    `;
    expect(enforcedMode).toEqual({ mode: 'ENFORCE' });

    const enforceBalance = await prisma.$transaction((tx) =>
      createReservationFixture(tx, base, 'enforce-unauthorized-balance', true, 1, {
        rawEvidence: { producer_build_sha: UNAUTHORIZED_PRODUCER_BUILD_SHA },
      }));
    const enforceCredits = await prisma.$transaction((tx) =>
      createCreditsFixture(
        tx,
        base,
        'enforce-unauthorized',
        UNAUTHORIZED_PRODUCER_BUILD_SHA,
      ));
    const enforceNoCharge = await prisma.$transaction((tx) =>
      createReservationFixture(tx, base, 'enforce-unauthorized-no-charge', true, 1, {
        rawEvidence: {
          ...quotaExceededEvidence(),
          producer_build_sha: UNAUTHORIZED_PRODUCER_BUILD_SHA,
        },
      }));

    await prisma.$transaction(async (tx) => {
      await createFinancialProofRows(tx, base, enforceBalance, 'enforce-unauthorized', {
        funding: {
          chargeUsd: 1,
          collectedUsd: 1,
          approvedUsd: 0,
          unapprovedUsd: 0,
        },
      });
      await assertTerminalProof(tx, enforceBalance.reservationId);
    });
    await prisma.$transaction((tx) =>
      settleCreditsFixture(tx, base, enforceCredits, 'enforce-unauthorized'));
    await prisma.$transaction(async (tx) => {
      await createNoChargeProofRows(
        tx,
        enforceNoCharge,
        'enforce-unauthorized-no-charge',
        'quota_exceeded',
      );
      await assertTerminalProof(tx, enforceNoCharge.reservationId);
    });

    expect(await prisma.gatewayUsageFundingReservation.findMany({
      where: {
        id: {
          in: [enforceBalance.reservationId, enforceNoCharge.reservationId],
        },
      },
      orderBy: { id: 'asc' },
      select: { status: true },
    })).toEqual(expect.arrayContaining([
      { status: 'CONSUMED' },
      { status: 'RELEASED' },
    ]));
    expect(await prisma.tokenUsage.count({
      where: {
        gatewayBillingEventId: {
          in: [enforceBalance.gatewayBillingEventId, enforceCredits.gatewayBillingEventId],
        },
      },
    })).toBe(2);
  }, 60_000);

  it('keeps revoked build authority as audit state while all customer terminals commit', async () => {
    await ensureEvidenceContractMode(
      prisma,
      'ENFORCE',
      'TEST-REQUIRE-GATEWAY-EVIDENCE-ENFORCEMENT',
    );
    const [rolloutMode] = await prisma.$queryRaw<Array<{ mode: string }>>`
      SELECT current_gateway_usage_evidence_contract_mode() AS mode
    `;
    expect(rolloutMode).toEqual({ mode: 'ENFORCE' });

    const producerBuildSha = createHash('sha1')
      .update(`gateway-build-rotation-${randomUUID()}`)
      .digest('hex');
    await prisma.$queryRaw`
      SELECT append_gateway_producer_build_authorization(
        ${producerBuildSha},
        'AUTHORIZED',
        'TEST-AUTHORIZE-ROTATING-BUILD',
        'test-platform-approver',
        'test-finance-approver'
      )
    `;
    const base = await createBaseFixture(
      prisma,
      'build-authority-rotation',
      { openingBalanceUsd: 5 },
    );
    const oldBalance = await prisma.$transaction((tx) =>
      createReservationFixture(tx, base, 'authority-old-balance', true, 1, {
        rawEvidence: { producer_build_sha: producerBuildSha },
      }));
    const oldCredits = await prisma.$transaction((tx) =>
      createCreditsFixture(tx, base, 'authority-old', producerBuildSha));
    const oldNoCharge = await prisma.$transaction((tx) =>
      createReservationFixture(tx, base, 'authority-old-no-charge', true, 1, {
        rawEvidence: {
          ...quotaExceededEvidence(),
          producer_build_sha: producerBuildSha,
        },
      }));

    const oldEvidence = await prisma.gatewayUsageEvidence.findMany({
      where: {
        gatewayBillingEventId: {
          in: [
            oldBalance.gatewayBillingEventId,
            oldCredits.gatewayBillingEventId,
            oldNoCharge.gatewayBillingEventId,
          ],
        },
      },
      orderBy: { gatewayBillingEventId: 'asc' },
      select: {
        gatewayBillingEventId: true,
        producerBuildAuthorizationRevision: true,
        producerBuildAuthorizationEventId: true,
        producerBuildAuthorityHash: true,
      },
    });
    expect(oldEvidence).toHaveLength(3);
    expect(oldEvidence.every((row) =>
      row.producerBuildAuthorizationRevision === 1
      && Boolean(row.producerBuildAuthorizationEventId)
      && Boolean(row.producerBuildAuthorityHash))).toBe(true);

    await prisma.$queryRaw`
      SELECT append_gateway_producer_build_authorization(
        ${producerBuildSha},
        'REVOKED',
        'TEST-REVOKE-ROTATING-BUILD',
        'test-security-approver',
        'test-finance-approver'
      )
    `;

    const [oldAuthorityAfterRevocation] = await prisma.$queryRaw<
      Array<{ authorized: boolean }>
    >`
      SELECT gateway_usage_evidence_has_current_build_authority(
        ${oldBalance.gatewayBillingEventId},
        ${oldBalance.requestId},
        ${oldBalance.evidenceHash}
      ) AS authorized
    `;
    expect(oldAuthorityAfterRevocation).toEqual({ authorized: false });

    await prisma.$transaction(async (tx) => {
      await createFinancialProofRows(tx, base, oldBalance, 'authority-old-balance', {
        funding: {
          chargeUsd: 1,
          collectedUsd: 1,
          approvedUsd: 0,
          unapprovedUsd: 0,
        },
      });
      await assertTerminalProof(tx, oldBalance.reservationId);
    });
    await prisma.$transaction((tx) =>
      settleCreditsFixture(tx, base, oldCredits, 'authority-old'));
    await prisma.$transaction(async (tx) => {
      await createNoChargeProofRows(
        tx,
        oldNoCharge,
        'authority-old-no-charge',
        'quota_exceeded',
      );
      await assertTerminalProof(tx, oldNoCharge.reservationId);
    });

    expect(await prisma.gatewayUsageFundingReservation.findMany({
      where: { id: { in: [oldBalance.reservationId, oldNoCharge.reservationId] } },
      select: { status: true },
    })).toEqual(expect.arrayContaining([
      { status: 'CONSUMED' },
      { status: 'RELEASED' },
    ]));
    expect(await prisma.tokenUsage.count({
      where: {
        gatewayBillingEventId: {
          in: [oldBalance.gatewayBillingEventId, oldCredits.gatewayBillingEventId],
        },
      },
    })).toBe(2);

    await prisma.$queryRaw`
      SELECT append_gateway_producer_build_authorization(
        ${producerBuildSha},
        'AUTHORIZED',
        'TEST-REAUTHORIZE-ROTATING-BUILD',
        'test-platform-approver',
        'test-finance-approver'
      )
    `;
    const [oldAuthorityAfterReauthorization] = await prisma.$queryRaw<
      Array<{ authorized: boolean }>
    >`
      SELECT gateway_usage_evidence_has_current_build_authority(
        ${oldBalance.gatewayBillingEventId},
        ${oldBalance.requestId},
        ${oldBalance.evidenceHash}
      ) AS authorized
    `;
    expect(oldAuthorityAfterReauthorization).toEqual({ authorized: false });

  }, 90_000);

  it('does not serialize customer settlement behind mutable build-authority locks', async () => {
    await ensureEvidenceContractMode(
      prisma,
      'ENFORCE',
      'TEST-CONCURRENT-AUTHORITY-ENFORCEMENT',
    );
    const revoker = new PrismaClient();
    const allowFirstRevokeCommit = promiseGate();
    const firstRevokeHasLock = promiseGate();
    const allowSecondSettlementCommit = promiseGate();
    const secondSettlementHasLock = promiseGate();
    let firstRevokeTransaction: Promise<unknown> | undefined;
    let firstSettlementTransaction: Promise<unknown> | undefined;
    let secondSettlementTransaction: Promise<unknown> | undefined;
    let secondRevokeTransaction: Promise<unknown> | undefined;

    try {
      // Revoke-first: the uncommitted REVOKED append owns the SHA lock, but an
      // otherwise complete financial terminal no longer reads that mutable
      // authority and therefore commits independently.
      const revokeFirstBuildSha = createHash('sha1')
        .update(`gateway-build-revoke-first-${randomUUID()}`)
        .digest('hex');
      await prisma.$queryRaw`
        SELECT append_gateway_producer_build_authorization(
          ${revokeFirstBuildSha},
          'AUTHORIZED',
          'TEST-AUTHORIZE-REVOKE-FIRST',
          'test-platform-approver',
          'test-finance-approver'
        )
      `;
      const revokeFirstBase = await createBaseFixture(
        prisma,
        'authority-concurrency-revoke-first',
        { openingBalanceUsd: 2 },
      );
      const revokeFirstReservation = await prisma.$transaction((tx) =>
        createReservationFixture(
          tx,
          revokeFirstBase,
          'authority-concurrency-revoke-first',
          true,
          1,
          { rawEvidence: { producer_build_sha: revokeFirstBuildSha } },
        ));
      await expectPostgresFailure(
        prisma.$transaction(
          (tx) => tx.$queryRaw`
            SELECT gateway_usage_evidence_has_current_build_authority(
              ${revokeFirstReservation.gatewayBillingEventId},
              ${revokeFirstReservation.requestId},
              ${revokeFirstReservation.evidenceHash}
            ) AS authorized
          `,
          { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead },
        ),
        'gateway financial terminal requires READ COMMITTED isolation',
      );

      firstRevokeTransaction = revoker.$transaction(async (tx) => {
        await tx.$queryRaw`
          SELECT append_gateway_producer_build_authorization(
            ${revokeFirstBuildSha},
            'REVOKED',
            'TEST-REVOKE-FIRST-CONCURRENTLY',
            'test-security-approver',
            'test-finance-approver'
          )
        `;
        firstRevokeHasLock.open();
        await allowFirstRevokeCommit.wait;
      }, { timeout: 30_000 });
      await Promise.race([
        firstRevokeHasLock.wait,
        firstRevokeTransaction.then(() => {
          throw new Error('revoke-first transaction ended before exposing its lock');
        }),
      ]);

      firstSettlementTransaction = prisma.$transaction(async (tx) => {
        await createFinancialProofRows(
          tx,
          revokeFirstBase,
          revokeFirstReservation,
          'authority-concurrency-revoke-first',
          {
            funding: {
              chargeUsd: 1,
              collectedUsd: 1,
              approvedUsd: 0,
              unapprovedUsd: 0,
            },
          },
        );
        await assertTerminalProof(tx, revokeFirstReservation.reservationId);
      }, { timeout: 30_000 });
      await firstSettlementTransaction;
      expect(await prisma.gatewayUsageFundingReservation.findUniqueOrThrow({
        where: { id: revokeFirstReservation.reservationId },
        select: { status: true },
      })).toEqual({ status: 'CONSUMED' });
      expect(await prisma.tokenUsage.count({
        where: { gatewayBillingEventId: revokeFirstReservation.gatewayBillingEventId },
      })).toBe(1);
      allowFirstRevokeCommit.open();
      await firstRevokeTransaction;

      // Settlement-first: keeping the customer transaction open likewise does
      // not delay an append-only authority revocation.
      const settlementFirstBuildSha = createHash('sha1')
        .update(`gateway-build-settlement-first-${randomUUID()}`)
        .digest('hex');
      await prisma.$queryRaw`
        SELECT append_gateway_producer_build_authorization(
          ${settlementFirstBuildSha},
          'AUTHORIZED',
          'TEST-AUTHORIZE-SETTLEMENT-FIRST',
          'test-platform-approver',
          'test-finance-approver'
        )
      `;
      const settlementFirstBase = await createBaseFixture(
        prisma,
        'authority-concurrency-settlement-first',
        { openingBalanceUsd: 2 },
      );
      const settlementFirstReservation = await prisma.$transaction((tx) =>
        createReservationFixture(
          tx,
          settlementFirstBase,
          'authority-concurrency-settlement-first',
          true,
          1,
          { rawEvidence: { producer_build_sha: settlementFirstBuildSha } },
        ));

      secondSettlementTransaction = prisma.$transaction(async (tx) => {
        await createFinancialProofRows(
          tx,
          settlementFirstBase,
          settlementFirstReservation,
          'authority-concurrency-settlement-first',
          {
            funding: {
              chargeUsd: 1,
              collectedUsd: 1,
              approvedUsd: 0,
              unapprovedUsd: 0,
            },
          },
        );
        await assertTerminalProof(tx, settlementFirstReservation.reservationId);
        secondSettlementHasLock.open();
        await allowSecondSettlementCommit.wait;
      }, { timeout: 30_000 });
      await Promise.race([
        secondSettlementHasLock.wait,
        secondSettlementTransaction.then(() => {
          throw new Error('settlement-first transaction ended before exposing its lock');
        }),
      ]);

      secondRevokeTransaction = revoker.$queryRaw`
        SELECT append_gateway_producer_build_authorization(
          ${settlementFirstBuildSha},
          'REVOKED',
          'TEST-REVOKE-AFTER-SETTLEMENT',
          'test-security-approver',
          'test-finance-approver'
        )
      `;
      await secondRevokeTransaction;
      allowSecondSettlementCommit.open();
      await secondSettlementTransaction;

      expect(await prisma.gatewayUsageFundingReservation.findUniqueOrThrow({
        where: { id: settlementFirstReservation.reservationId },
        select: { status: true },
      })).toEqual({ status: 'CONSUMED' });
      expect(await prisma.tokenUsage.count({
        where: {
          gatewayBillingEventId: settlementFirstReservation.gatewayBillingEventId,
        },
      })).toBe(1);
      const [authorityAfterRevoke] = await prisma.$queryRaw<
        Array<{ authorized: boolean }>
      >`
        SELECT gateway_usage_evidence_has_current_build_authority(
          ${settlementFirstReservation.gatewayBillingEventId},
          ${settlementFirstReservation.requestId},
          ${settlementFirstReservation.evidenceHash}
        ) AS authorized
      `;
      expect(authorityAfterRevoke).toEqual({ authorized: false });
    } finally {
      allowFirstRevokeCommit.open();
      allowSecondSettlementCommit.open();
      await Promise.allSettled([
        firstRevokeTransaction,
        firstSettlementTransaction,
        secondSettlementTransaction,
        secondRevokeTransaction,
      ].filter((operation): operation is Promise<unknown> => Boolean(operation)));
      await revoker.$disconnect();
    }
  }, 120_000);

  it.each([
    ['a missing', null],
    ['a v1', 'gateway-customer-settlement-v1'],
  ] as const)(
    'rejects %s customer policy at the first anchor insert',
    async (_case, customerSettlementPolicyVersion) => {
      const label = customerSettlementPolicyVersion === null
        ? 'missing-anchor-policy'
        : 'v1-anchor-policy';
      const base = await createBaseFixture(prisma, label);

      await expectPostgresFailure(
        prisma.$transaction((tx) => createReservationFixture(
          tx,
          base,
          label,
          true,
          1,
          { customerSettlementPolicyVersion },
        )),
        'gateway_usage_settlement_anchors_customer_policy_v2_check',
      );

      const requestId = `protocol-${label}-request-${base.suffix}`;
      expect(await prisma.gatewayUsageSettlementAnchor.count({ where: { requestId } }))
        .toBe(0);
      expect(await prisma.gatewayBillingEvent.count({ where: { requestId } }))
        .toBe(0);
    },
    60_000,
  );

  it('proves all v3 CREDITS terminals and rejects post-terminal credit tampering', async () => {
    const base = await createBaseFixture(prisma, 'v3-credits-terminal-proof');
    const exactZero = await prisma.$transaction((tx) =>
      createCreditsFixture(
        tx,
        base,
        'zero-credits-exact',
        UNAUTHORIZED_PRODUCER_BUILD_SHA,
        0,
      ));
    const positive = await prisma.$transaction((tx) =>
      createCreditsFixture(
        tx,
        base,
        'positive-credits-charged',
        VERIFIED_PRODUCER_BUILD_SHA,
        2,
      ));
    const protectiveZero = await prisma.$transaction((tx) =>
      createCreditsFixture(
        tx,
        base,
        'positive-anchor-protective-zero',
        VERIFIED_PRODUCER_BUILD_SHA,
        3,
        {
          customerChargeUsd: '0.330000000000',
          customerSettlementPolicyVersion: 'gateway-customer-settlement-v2',
        },
      ));
    const included = await prisma.$transaction((tx) =>
      createCreditsFixture(
        tx,
        base,
        'included-upstream',
        UNAUTHORIZED_PRODUCER_BUILD_SHA,
        0,
        { includedUpstream: true },
      ));
    const debt = await prisma.$transaction((tx) =>
      createCreditsFixture(
        tx,
        base,
        'insufficient-credits-debt-open',
        UNAUTHORIZED_PRODUCER_BUILD_SHA,
        4,
        { customerChargeUsd: '0.440000000000' },
      ));
    const forgedZero = await prisma.$transaction((tx) =>
      createCreditsFixture(
        tx,
        base,
        'positive-anchor-forged-zero',
        VERIFIED_PRODUCER_BUILD_SHA,
        5,
      ));

    await prisma.$transaction((tx) =>
      settleZeroCreditsFixture(tx, base, exactZero, 'zero-credits-exact'));
    await prisma.$transaction((tx) =>
      settleCreditsFixture(tx, base, positive, 'positive-credits-charged'));
    await prisma.$transaction((tx) => settleZeroCreditsFixture(
      tx,
      base,
      protectiveZero,
      'positive-anchor-protective-zero',
      {
        basis: 'CUSTOMER_PROTECTIVE_ZERO',
        customerSettlementPolicyVersion: 'gateway-customer-settlement-v2',
      },
    ));
    await prisma.$transaction((tx) => settleCreditsFixture(
      tx,
      base,
      included,
      'included-upstream',
      { mode: 'INCLUDED' },
    ));
    await prisma.$transaction(async (tx) => {
      await settleCreditsFixture(
        tx,
        base,
        debt,
        'insufficient-credits-debt-open',
        { mode: 'DEBT_OPEN' },
      );
      await tx.billingAccessRestriction.create({
        data: {
          id: `protocol-debt-restriction-${base.suffix}`,
          gatewayBillingEventId: debt.gatewayBillingEventId,
          billingAccountId: base.billingAccountId,
          reason: 'debt_open',
          idempotencyKey: `gateway:debt:${debt.requestId}`,
          createdBy: 'SYSTEM',
        },
      });
      await tx.gatewayBillingEvent.update({
        where: { id: debt.gatewayBillingEventId },
        data: {
          status: 'DEBT_OPEN',
          reason: 'insufficient_credits',
          reconciliationStatus: 'OPEN',
          fundingOutcome: 'DEBT_OPEN',
          pendingExposureUsd: new Prisma.Decimal('0.440000000000'),
          pendingHoldUsd: new Prisma.Decimal(0),
          revision: { increment: 1 },
        },
      });
    });

    const exactZeroMutationKey =
      `gateway:credits:${exactZero.requestId}:${exactZero.anchorHash}`;
    expect(await prisma.creditTransaction.count({
      where: { idempotencyKey: exactZeroMutationKey },
    })).toBe(0);
    const exactZeroReceipt = await prisma.gatewayUsageSettlementReceipt.findFirstOrThrow({
      where: { gatewayBillingEventId: exactZero.gatewayBillingEventId },
      select: {
        creditAmount: true,
        amountUsd: true,
        fundingOutcome: true,
        reason: true,
        policyVersion: true,
        payload: true,
      },
    });
    expect(exactZeroReceipt).toMatchObject({
      creditAmount: 0,
      fundingOutcome: 'INCLUDED',
      reason: 'zero_priced_credits',
      policyVersion: 'gateway-settlement-v3-customer-authority',
    });
    expect(exactZeroReceipt.amountUsd.equals(0)).toBe(true);
    expect(exactZeroReceipt.payload).toEqual(expect.objectContaining({
      customerFinancialAuthority: expect.objectContaining({
        terminalClass: 'CREDITS_ZERO',
        basis: 'NORMALIZED_EXACT',
      }),
    }));
    expect(await prisma.creditTransaction.count({
      where: { requestId: positive.requestId },
    })).toBe(1);
    expect(await prisma.creditTransaction.count({
      where: {
        requestId: {
          in: [protectiveZero.requestId, included.requestId, debt.requestId],
        },
      },
    })).toBe(0);
    expect(await prisma.gatewayUsageSettlementReceipt.findFirstOrThrow({
      where: { gatewayBillingEventId: protectiveZero.gatewayBillingEventId },
      select: { payload: true },
    })).toEqual({
      payload: expect.objectContaining({
        customerFinancialAuthority: expect.objectContaining({
          policyVersion: 'gateway-customer-settlement-v2',
          basis: 'CUSTOMER_PROTECTIVE_ZERO',
        }),
      }),
    });
    expect(await prisma.billingAccessRestriction.findUniqueOrThrow({
      where: { idempotencyKey: `gateway:debt:${debt.requestId}` },
      select: { status: true, reason: true },
    })).toEqual({ status: 'ACTIVE', reason: 'debt_open' });
    expect(await prisma.gatewayBillingEvent.findUniqueOrThrow({
      where: { id: debt.gatewayBillingEventId },
      select: { status: true, reconciliationStatus: true, fundingOutcome: true },
    })).toEqual({
      status: 'DEBT_OPEN',
      reconciliationStatus: 'OPEN',
      fundingOutcome: 'DEBT_OPEN',
    });

    await expectPostgresFailure(
      prisma.$transaction((tx) =>
        settleZeroCreditsFixture(
          tx,
          base,
          forgedZero,
          'positive-anchor-forged-zero',
          {
            basis: 'NORMALIZED_EXACT',
            settledDimensions: {
              inputTokens: 0,
              outputTokens: 0,
              cachedInputTokens: 0,
              cacheWriteInputTokens: 0,
              totalTokens: 0,
              imageCount: 0,
            },
          },
        )),
      'gateway CREDITS original/settled dimension binding is invalid',
    );
    expect(await prisma.tokenUsage.count({
      where: { gatewayBillingEventId: forgedZero.gatewayBillingEventId },
    })).toBe(0);
    expect(await prisma.gatewayUsageSettlementReceipt.count({
      where: { gatewayBillingEventId: forgedZero.gatewayBillingEventId },
    })).toBe(0);

    const positiveMutation = await prisma.creditTransaction.findFirstOrThrow({
      where: { requestId: positive.requestId },
      select: { id: true },
    });
    await expectPostgresFailure(
      prisma.$transaction((tx) => tx.creditTransaction.update({
        where: { id: positiveMutation.id },
        data: { creditsAmount: -1 },
      })),
      'gateway positive CREDITS mutation proof is inconsistent',
    );
    await expectPostgresFailure(
      prisma.$transaction((tx) => tx.creditTransaction.delete({
        where: { id: positiveMutation.id },
      })),
      'gateway positive CREDITS mutation proof is inconsistent',
    );
    await expectPostgresFailure(
      prisma.$transaction((tx) => tx.creditTransaction.create({
        data: {
          userId: base.userId,
          tenantId: base.tenantId,
          productId: base.productId,
          subscriptionId: exactZero.subscriptionId,
          type: 'CONSUME',
          creditsAmount: -1,
          source: 'forged-post-terminal-zero-mutation',
          requestId: exactZero.requestId,
          quotaAfter: 9,
          bonusAfter: 0,
          idempotencyKey: null,
        },
      })),
      'gateway zero-priced CREDITS proof is inconsistent',
    );
  }, 60_000);

  it('commits a v2 CREDITS authority and rejects a v1 writer for a v2 anchor', async () => {
    const base = await createBaseFixture(prisma, 'v2-credits-policy-binding');
    const accepted = await prisma.$transaction((tx) => createCreditsFixture(
      tx,
      base,
      'v2-credits-policy-accepted',
      VERIFIED_PRODUCER_BUILD_SHA,
      2,
      { customerSettlementPolicyVersion: 'gateway-customer-settlement-v2' },
    ));
    const mixedWriter = await prisma.$transaction((tx) => createCreditsFixture(
      tx,
      base,
      'v2-credits-policy-mixed-writer',
      VERIFIED_PRODUCER_BUILD_SHA,
      2,
      { customerSettlementPolicyVersion: 'gateway-customer-settlement-v2' },
    ));

    await prisma.$transaction((tx) => settleCreditsFixture(
      tx,
      base,
      accepted,
      'v2-credits-policy-accepted',
      {
        basis: 'NORMALIZED_EXACT',
        customerSettlementPolicyVersion: 'gateway-customer-settlement-v2',
      },
    ));

    expect(await prisma.gatewayUsageSettlementReceipt.findFirstOrThrow({
      where: { gatewayBillingEventId: accepted.gatewayBillingEventId },
      select: { payload: true },
    })).toEqual({
      payload: expect.objectContaining({
        customerFinancialAuthority: expect.objectContaining({
          policyVersion: 'gateway-customer-settlement-v2',
          basis: 'NORMALIZED_EXACT',
        }),
      }),
    });

    await expectPostgresFailure(
      prisma.$transaction((tx) => settleCreditsFixture(
        tx,
        base,
        mixedWriter,
        'v2-credits-policy-mixed-writer',
        {
          basis: 'NORMALIZED_EXACT',
          customerSettlementPolicyVersion: 'gateway-customer-settlement-v1',
        },
      )),
      'gateway CREDITS receipt common proof is inconsistent',
    );
    expect(await prisma.gatewayUsageSettlementReceipt.count({
      where: { gatewayBillingEventId: mixedWriter.gatewayBillingEventId },
    })).toBe(0);
    expect(await prisma.tokenUsage.count({
      where: { gatewayBillingEventId: mixedWriter.gatewayBillingEventId },
    })).toBe(0);
  }, 60_000);

  it('proves a v2 BALANCE image quote can settle as a whole-request protective zero', async () => {
    const base = await createBaseFixture(
      prisma,
      'v3-balance-image-protective-zero',
      { openingBalanceUsd: 1 },
    );
    const originalDimensions: CustomerDimensions = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      totalTokens: 0,
      imageCount: 1,
    };
    const originalQuote = {
      unit: 'BALANCE',
      userId: base.userId,
      tenantId: base.tenantId,
      billingAccountId: base.billingAccountId,
      productId: base.productId,
      productSlug: base.productSlug,
      modelName: 'glm-5.2',
      ...originalDimensions,
      priceBasis: 'PRODUCT_EFFECTIVE',
      customerPricing: {
        inputPriceUsdPerM: '0',
        cachedInputPriceUsdPerM: '0',
        cacheWritePriceUsdPerM: '0',
        outputPriceUsdPerM: '0',
      },
      baseCostUsd: '0.250000000000',
      effectiveCostUsd: '0.250000000000',
      amountCents: 25,
      lineItems: [{
        meter: 'image',
        quantity: 1,
        unitPriceUsd: '0.25000000',
        amountUsd: '0.250000000000',
      }],
      policy: {
        id: null,
        scope: 'DEFAULT',
        modelName: null,
        priceMultiplier: '1',
        creditMultiplier: null,
        priority: 0,
      },
    };
    const reservation = await prisma.$transaction((tx) => createReservationFixture(
      tx,
      base,
      'v3-balance-image-protective-zero',
      true,
      '0.250000000000',
      {
        rawEvidence: {
          token_source: 'missing',
          image_count: 1,
          provider_reconciliation_required: true,
        },
        customerQuoteSnapshot: originalQuote,
        customerSettlementPolicyVersion: 'gateway-customer-settlement-v2',
      },
    ));
    const tokenUsageId = `protocol-v3-balance-image-zero-usage-${base.suffix}`;
    const settlementFingerprint =
      `protocol-v3-balance-image-zero-fingerprint-${base.suffix}`;
    const settledDimensions: CustomerDimensions = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      totalTokens: 0,
      imageCount: 0,
    };
    const settledQuote = {
      ...originalQuote,
      ...settledDimensions,
      baseCostUsd: '0.000000000000',
      effectiveCostUsd: '0.000000000000',
      amountCents: 0,
      lineItems: [],
    };

    await prisma.$transaction(async (tx) => {
      await tx.$executeRaw`
        SELECT set_config('ruidong.gateway_settlement_protocol', 'v1', true)
      `;
      await tx.tokenUsage.create({
        data: {
          id: tokenUsageId,
          apiKeyId: base.apiKeyId,
          tenantId: base.tenantId,
          productId: base.productId,
          gatewayBillingEventId: reservation.gatewayBillingEventId,
          requestId: reservation.requestId,
          model: 'glm-5.2',
          meter: 'token',
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          inputPriceUsdPerM: new Prisma.Decimal(0),
          outputPriceUsdPerM: new Prisma.Decimal(0),
          costUsd: new Prisma.Decimal(0),
          customerChargePolicy: 'payg_balance',
          customerChargeUsd: new Prisma.Decimal(0),
          customerCollectedUsd: new Prisma.Decimal(0),
          customerApprovedReceivableUsd: new Prisma.Decimal(0),
          customerUnapprovedDebtUsd: new Prisma.Decimal(0),
          customerFundingClassificationComplete: true,
        },
      });
      await transitionReservation(tx, reservation.reservationId, 'consume-v1', {
        status: 'CONSUMED',
        authoritativeAmountUsd: new Prisma.Decimal(0),
        consumedAt: new Date(),
      });
      await tx.gatewayUsageSettlementReceipt.create({
        data: {
          id: `protocol-v3-balance-image-zero-receipt-${base.suffix}`,
          gatewayBillingEventId: reservation.gatewayBillingEventId,
          requestId: reservation.requestId,
          settlementRevision: 1,
          fundingOutcome: 'COLLECTED',
          evidenceHash: reservation.evidenceHash,
          anchorHash: reservation.anchorHash,
          pricingHash: reservation.pricingHash,
          settlementFingerprint,
          billingUnit: 'BALANCE',
          billingCurrency: 'USD',
          amountUsd: new Prisma.Decimal(0),
          tokenUsageId,
          policyVersion: 'gateway-settlement-v3-customer-authority',
          idempotencyKey:
            `gateway:financial:${reservation.requestId}:${reservation.anchorHash}`,
          payload: {
            customerFinancialAuthority: {
              protocol: 'gateway-customer-financial-authority-v1',
              policyVersion: 'gateway-customer-settlement-v2',
              basis: 'CUSTOMER_PROTECTIVE_ZERO',
              billingUnit: 'BALANCE',
              terminalClass: 'BALANCE_SETTLED',
              fundingOutcome: 'COLLECTED',
              customerAmountUnit: 'USD',
              originalCustomerAmount: '0.250000000000',
              settledCustomerAmount: '0.000000000000',
              originalCustomerChargeUsd: '0.250000000000',
              settledCustomerChargeUsd: '0.000000000000',
              originalDimensions,
              settledDimensions,
              anchorHash: reservation.anchorHash,
              pricingHash: reservation.pricingHash,
              settlementFingerprint,
              tokenUsageId,
            },
            billingResult: {
              success: true,
              allowed: true,
              unit: 'BALANCE',
              quote: settledQuote,
              tokenUsageId,
            },
          } as Prisma.InputJsonValue,
        },
      });
      await assertTerminalProof(tx, reservation.reservationId);
    });

    expect(await prisma.balanceTransaction.count({ where: { tokenUsageId } })).toBe(0);
    expect(await prisma.balanceConsumptionAllocation.count({
      where: { tokenUsageId },
    })).toBe(0);
    expect(await prisma.gatewayUsageSettlementReceipt.findFirstOrThrow({
      where: { tokenUsageId },
      select: { payload: true },
    })).toEqual({
      payload: expect.objectContaining({
        customerFinancialAuthority: expect.objectContaining({
          policyVersion: 'gateway-customer-settlement-v2',
          basis: 'CUSTOMER_PROTECTIVE_ZERO',
          originalDimensions: expect.objectContaining({ imageCount: 1 }),
          settledDimensions: expect.objectContaining({ imageCount: 0 }),
        }),
      }),
    });
  }, 60_000);

  it('proves a v3 BALANCE exact terminal from typed customer authority', async () => {
    const label = 'v3-balance-normalized-exact';
    const base = await createBaseFixture(prisma, label, { openingBalanceUsd: 10 });
    const dimensions: CustomerDimensions = {
      inputTokens: 100,
      outputTokens: 10,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      totalTokens: 110,
      imageCount: 0,
    };
    const quote: JsonObject = {
      unit: 'BALANCE',
      userId: base.userId,
      tenantId: base.tenantId,
      billingAccountId: base.billingAccountId,
      productId: base.productId,
      productSlug: base.productSlug,
      modelName: 'glm-5.2',
      ...dimensions,
      priceBasis: 'PRODUCT_EFFECTIVE',
      customerPricing: {
        inputPriceUsdPerM: '1000',
        cachedInputPriceUsdPerM: '1000',
        cacheWritePriceUsdPerM: '1000',
        outputPriceUsdPerM: '1000',
      },
      baseCostUsd: '1.000000000000',
      effectiveCostUsd: '1.000000000000',
      amountCents: 100,
      lineItems: [],
      policy: {
        id: null,
        scope: 'DEFAULT',
        modelName: null,
        priceMultiplier: '1',
        creditMultiplier: null,
        priority: 0,
      },
    };
    const reservation = await prisma.$transaction((tx) => createReservationFixture(
      tx,
      base,
      label,
      true,
      1,
      { customerQuoteSnapshot: quote },
    ));
    const tokenUsageId = `protocol-${label}-usage-${base.suffix}`;
    const settlementFingerprint = `protocol-${label}-fingerprint-${base.suffix}`;
    const payload = {
      customerFinancialAuthority: {
        protocol: 'gateway-customer-financial-authority-v1',
        policyVersion: CUSTOMER_SETTLEMENT_POLICY_VERSION,
        basis: 'NORMALIZED_EXACT',
        billingUnit: 'BALANCE',
        terminalClass: 'BALANCE_SETTLED',
        fundingOutcome: 'COLLECTED',
        customerAmountUnit: 'USD',
        originalCustomerAmount: '1.000000000000',
        settledCustomerAmount: '1.000000000000',
        originalCustomerChargeUsd: '1.000000000000',
        settledCustomerChargeUsd: '1.000000000000',
        originalDimensions: dimensions,
        settledDimensions: dimensions,
        anchorHash: reservation.anchorHash,
        pricingHash: reservation.pricingHash,
        settlementFingerprint,
        tokenUsageId,
      },
      billingResult: {
        success: true,
        allowed: true,
        unit: 'BALANCE',
        fundingOutcome: 'COLLECTED',
        quote,
        tokenUsageId,
      },
    } as Prisma.InputJsonValue;

    await prisma.$transaction(async (tx) => {
      await createFinancialProofRows(tx, base, reservation, label, {
        funding: {
          chargeUsd: 1,
          collectedUsd: 1,
          approvedUsd: 0,
          unapprovedUsd: 0,
        },
        receiptPolicyVersion: 'gateway-settlement-v3-customer-authority',
        receiptIdempotencyKey:
          `gateway:financial:${reservation.requestId}:${reservation.anchorHash}`,
        receiptPayload: payload,
      });
      await assertTerminalProof(tx, reservation.reservationId);
    });

    expect(await prisma.gatewayUsageSettlementReceipt.findFirstOrThrow({
      where: { tokenUsageId },
      select: { policyVersion: true, payload: true },
    })).toEqual({
      policyVersion: 'gateway-settlement-v3-customer-authority',
      payload: expect.objectContaining({
        customerFinancialAuthority: expect.objectContaining({
          basis: 'NORMALIZED_EXACT',
          terminalClass: 'BALANCE_SETTLED',
        }),
      }),
    });
  }, 60_000);

  it('persists every BALANCE funding split through the real writer and PostgreSQL proof', async () => {
    const redisValues = new Map<string, string>();
    const redis = {
      get: jest.fn(async (key: string) => redisValues.get(key) ?? null),
      set: jest.fn(async (key: string, value: string, ...args: unknown[]) => {
        if (args.includes('NX') && redisValues.has(key)) return null;
        redisValues.set(key, value);
        return 'OK';
      }),
      del: jest.fn(async (...keys: string[]) => keys.reduce(
        (count, key) => count + Number(redisValues.delete(key)),
        0,
      )),
    };
    const publisherSync = {
      syncKeyBalanceById: jest.fn().mockResolvedValue(undefined),
      syncBillingAccountKeyBalancesRequired: jest.fn().mockResolvedValue(undefined),
      syncBillingAccountKeyBalancesByTenantIdRequired: jest.fn().mockResolvedValue(undefined),
      syncBillingAccountKeyBalancesByKeyIdRequired: jest.fn().mockResolvedValue(undefined),
    };
    const billingService = new BillingService(
      new BillingRepository(prisma as never),
      redis as never,
      prisma as never,
    );
    const modelPricingService = new ModelPricingService(prisma as never, redis as never);
    const usageBilling = new UsageBillingStrategyService(
      prisma as never,
      redis as never,
      billingService,
      {} as never,
      {} as never,
      modelPricingService,
      new ProviderCostPricingService(prisma as never, modelPricingService),
      {} as never,
      {} as never,
      publisherSync as never,
    );
    const dimensions: CustomerDimensions = {
      inputTokens: 1_000_000,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      totalTokens: 1_000_000,
      imageCount: 0,
    };

    const fundingCases = [
      {
        label: 'writer-cash',
        chargeUsd: '1',
        openingBalanceUsd: '1',
        collectedUsd: '1',
        approvedCreditUsd: '0',
        unapprovedDebtUsd: '0',
        fundingOutcome: 'COLLECTED' as const,
        activeCredit: false,
      },
      {
        label: 'writer-mixed-credit',
        chargeUsd: '1',
        openingBalanceUsd: '0.4',
        collectedUsd: '0.4',
        approvedCreditUsd: '0.6',
        unapprovedDebtUsd: '0',
        fundingOutcome: 'RECEIVABLE' as const,
        activeCredit: true,
      },
      {
        label: 'writer-full-credit',
        chargeUsd: '1',
        openingBalanceUsd: '0',
        collectedUsd: '0',
        approvedCreditUsd: '1',
        unapprovedDebtUsd: '0',
        fundingOutcome: 'RECEIVABLE' as const,
        activeCredit: true,
      },
      {
        label: 'writer-unapproved-debt',
        chargeUsd: '1',
        openingBalanceUsd: '0',
        collectedUsd: '0',
        approvedCreditUsd: '0',
        unapprovedDebtUsd: '1',
        fundingOutcome: 'DEBT_OPEN' as const,
        activeCredit: false,
      },
      {
        label: 'writer-zero-price',
        chargeUsd: '0',
        openingBalanceUsd: '0',
        collectedUsd: '0',
        approvedCreditUsd: '0',
        unapprovedDebtUsd: '0',
        fundingOutcome: 'COLLECTED' as const,
        activeCredit: false,
      },
    ];

    for (const fundingCase of fundingCases) {
      const base = await createBaseFixture(prisma, fundingCase.label, {
        accountType: 'enterprise',
        openingBalanceUsd: fundingCase.openingBalanceUsd,
      });
      const firstReceivedAt = new Date();
      const occurredAt = new Date(firstReceivedAt.getTime() - 5_000);
      const creditPolicyWindowStart = new Date(occurredAt.getTime() - 2_000);
      const creditPolicyAt = occurredAt;
      const policyDecisionAt = new Date(firstReceivedAt.getTime() - 60_000);
      const policyBoundaryAt = new Date(firstReceivedAt.getTime() - 50_000);
      const policyEffectiveAt = new Date(firstReceivedAt.getTime() - 70_000);
      const policyExpiresAt = new Date(
        firstReceivedAt.getTime() + 24 * 60 * 60 * 1_000,
      );
      const creditPolicy = fundingCase.activeCredit
        ? await createCreditPolicy(prisma, base, fundingCase.label, {
            limitUsd: 5,
            termsDays: 30,
            effectiveAt: policyEffectiveAt,
            expiresAt: policyExpiresAt,
            decisionAt: policyDecisionAt,
            boundaryAt: policyBoundaryAt,
          })
        : null;
      const approvedCreditDueAt = fundingCase.activeCredit
        ? new Date(creditPolicyAt.getTime() + 30 * 24 * 60 * 60 * 1_000)
        : null;
      const chargeUsd = new Prisma.Decimal(fundingCase.chargeUsd);
      const customerQuoteSnapshot: GatewaySettlementAnchor['customerQuoteSnapshot'] = {
        unit: 'BALANCE',
        userId: base.userId,
        tenantId: base.tenantId,
        billingAccountId: base.billingAccountId,
        productId: base.productId,
        productSlug: base.productSlug,
        modelName: 'enterprise-writer-proof',
        inputTokens: dimensions.inputTokens,
        outputTokens: dimensions.outputTokens,
        cachedInputTokens: dimensions.cachedInputTokens,
        cacheWriteInputTokens: dimensions.cacheWriteInputTokens,
        imageCount: dimensions.imageCount,
        pricingTierKey: null,
        priceBasis: 'LIST',
        customerPricing: {
          inputPriceUsdPerM: fundingCase.chargeUsd,
          cachedInputPriceUsdPerM: null,
          cacheWritePriceUsdPerM: null,
          outputPriceUsdPerM: '0',
        },
        baseCostUsd: fundingCase.chargeUsd,
        effectiveCostUsd: fundingCase.chargeUsd,
        amountCents: chargeUsd.mul(100).toNumber(),
        providerCode: null,
        providerLineId: null,
        policy: {
          id: null,
          scope: 'DEFAULT',
          modelName: null,
          priceMultiplier: '1',
          creditMultiplier: null,
          priority: 0,
        },
      };
      const verifiedPricing = {
        status: 'VERIFIED' as const,
        reason: null,
        costUsd: fundingCase.chargeUsd,
        pricingTierKey: null,
        inputPriceUsdPerM: fundingCase.chargeUsd,
        cachedInputPriceUsdPerM: null,
        cacheWritePriceUsdPerM: null,
        outputPriceUsdPerM: '0',
      };
      const customerPricingSnapshot: GatewayCustomerPricingSnapshot = {
        unit: 'BALANCE',
        priceBasis: 'LIST',
        basePricing: verifiedPricing,
        tokenUsagePricing: verifiedPricing,
        policy: customerQuoteSnapshot.policy,
        customerMultiplier: '1',
        planUsageMultiplier: null,
        modelAccessMultiplier: null,
        effectiveCostUsd: fundingCase.chargeUsd,
        baseCreditCost: null,
        creditCost: null,
        includedUpstream: false,
      };
      const providerCostSnapshot: GatewayProviderCostSnapshot = {
        status: 'UNAVAILABLE',
        reason: 'integration fixture has no provider invoice policy',
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
      const reservation = await prisma.$transaction((tx) => createReservationFixture(
        tx,
        base,
        fundingCase.label,
        true,
        chargeUsd,
        {
          collectedUsd: fundingCase.collectedUsd,
          approvedCreditUsd: fundingCase.approvedCreditUsd,
          unapprovedDebtUsd: fundingCase.unapprovedDebtUsd,
          occurredAt,
          firstReceivedAt,
          creditPolicyAt,
          creditPolicyWindowStart,
          creditPolicyEventId: creditPolicy?.eventId ?? null,
          creditPolicyRevision: creditPolicy?.revision ?? null,
          creditTermsDays: fundingCase.activeCredit ? 30 : null,
          approvedCreditDueAt,
          creditPolicySource: fundingCase.activeCredit ? 'EVENT_NEW_STATE' : 'CURRENT_PREPAID',
          creditLimitUsd: fundingCase.activeCredit ? 5 : 0,
          creditConfiguredLimitUsd: fundingCase.activeCredit ? 5 : 0,
          creditStatus: creditPolicy?.status ?? null,
          creditEffectiveAt: creditPolicy?.effectiveAt ?? null,
          creditExpiresAt: creditPolicy?.expiresAt ?? null,
          customerQuoteSnapshot,
          customerPricingSnapshot,
          providerCostSnapshot,
          canonicalServiceProof: true,
          reservationCanonicalPayload: {
            protocol: 'enterprise-funding-writer-test-v1',
            fundingCase: fundingCase.label,
            fixtureSuffix: base.suffix,
            collectedGrantSlices: new Prisma.Decimal(fundingCase.collectedUsd).gt(0)
              ? [{
                  balanceGrantId: base.balanceGrantId,
                  amountUsd: new Prisma.Decimal(fundingCase.collectedUsd).toFixed(12),
                  allocationOrder: 0,
                }]
              : [],
          },
        },
      ));
      const anchor: GatewaySettlementAnchor = {
        requestId: reservation.requestId,
        apiKeyId: base.apiKeyId,
        userId: base.userId,
        tenantId: base.tenantId,
        billingAccountId: base.billingAccountId,
        productId: base.productId,
        productSlug: base.productSlug,
        billingUnit: 'BALANCE',
        billingCurrency: 'USD',
        codingPlanEntitlementId: null,
        subscriptionId: null,
        planId: null,
        occurredAt: reservation.occurredAt,
        firstReceivedAt: reservation.firstReceivedAt,
        customerSettlementPolicyVersion: CUSTOMER_SETTLEMENT_POLICY_VERSION,
        fundingReservationProtocol: 'V1',
        pricingHash: reservation.pricingHash,
        customerQuoteSnapshot,
        customerPricingSnapshot,
        providerCostSnapshot,
        anchorHash: reservation.anchorHash,
        entitlementSnapshot: null,
        planSnapshot: null,
      };
      const input: UsageDeductInput = {
        apiKeyId: base.apiKeyId,
        userId: base.userId,
        tenantId: base.tenantId,
        productId: base.productId,
        productSlug: base.productSlug,
        modelName: customerQuoteSnapshot.modelName,
        ...dimensions,
        billingUnit: 'BALANCE',
        source: `gateway:integration:${fundingCase.label}`,
        requestId: reservation.requestId,
        idempotencyKey: `gateway:request:${reservation.requestId}`,
        eventOccurredAt: reservation.occurredAt,
        recordTokenUsage: true,
      };
      const settlementContext: GatewaySettlementContext = {
        gatewayBillingEventId: reservation.gatewayBillingEventId,
        expectedRevision: 0,
        evidenceHash: reservation.evidenceHash,
        anchor,
      };

      const result = await usageBilling.settleDeliveredGatewayUsage(input, settlementContext);
      await prisma.$transaction((tx) => assertTerminalProof(tx, reservation.reservationId));

      const usage = await prisma.tokenUsage.findUniqueOrThrow({
        where: { requestId: reservation.requestId },
      });
      const balanceTransaction = await prisma.balanceTransaction.findUnique({
        where: { tokenUsageId: usage.id },
      });
      const receipt = await prisma.gatewayUsageSettlementReceipt.findFirstOrThrow({
        where: { tokenUsageId: usage.id },
      });
      const allocations = await prisma.balanceConsumptionAllocation.findMany({
        where: { tokenUsageId: usage.id },
        select: {
          amountUsd: true,
          recognizedRevenueUsd: true,
          approvedCreditUsd: true,
          unapprovedDebtUsd: true,
        },
      });
      const allocationTotal = (field: keyof (typeof allocations)[number]) => allocations.reduce(
        (total, allocation) => total.plus(allocation[field]),
        new Prisma.Decimal(0),
      );

      expect(result).toMatchObject({
        success: true,
        fundingOutcome: fundingCase.fundingOutcome,
      });
      expect(usage.customerChargePolicy).toBe('payg_balance');
      expect(usage.customerChargeUsd).toEqual(chargeUsd);
      expect(usage.customerCollectedUsd).toEqual(new Prisma.Decimal(fundingCase.collectedUsd));
      expect(usage.customerApprovedReceivableUsd).toEqual(
        new Prisma.Decimal(fundingCase.approvedCreditUsd),
      );
      expect(usage.customerUnapprovedDebtUsd).toEqual(
        new Prisma.Decimal(fundingCase.unapprovedDebtUsd),
      );
      expect(balanceTransaction?.amountUsd ?? null).toEqual(
        chargeUsd.isZero() ? null : chargeUsd.negated(),
      );
      expect(receipt.fundingOutcome).toBe(fundingCase.fundingOutcome);
      expect(allocationTotal('amountUsd')).toEqual(chargeUsd);
      expect(allocationTotal('recognizedRevenueUsd')).toEqual(
        new Prisma.Decimal(fundingCase.collectedUsd),
      );
      expect(allocationTotal('approvedCreditUsd')).toEqual(
        new Prisma.Decimal(fundingCase.approvedCreditUsd),
      );
      expect(allocationTotal('unapprovedDebtUsd')).toEqual(
        new Prisma.Decimal(fundingCase.unapprovedDebtUsd),
      );
    }
  }, 120_000);

  it('commits a v2 BALANCE authority and rejects a v1 writer for a v2 anchor', async () => {
    const base = await createBaseFixture(
      prisma,
      'v2-balance-policy-binding',
      { openingBalanceUsd: 10 },
    );
    const dimensions: CustomerDimensions = {
      inputTokens: 100,
      outputTokens: 10,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      totalTokens: 110,
      imageCount: 0,
    };
    const quote: JsonObject = {
      unit: 'BALANCE',
      userId: base.userId,
      tenantId: base.tenantId,
      billingAccountId: base.billingAccountId,
      productId: base.productId,
      productSlug: base.productSlug,
      modelName: 'glm-5.2',
      ...dimensions,
      priceBasis: 'PRODUCT_EFFECTIVE',
      customerPricing: {
        inputPriceUsdPerM: '1000',
        cachedInputPriceUsdPerM: '1000',
        cacheWritePriceUsdPerM: '1000',
        outputPriceUsdPerM: '1000',
      },
      baseCostUsd: '1.000000000000',
      effectiveCostUsd: '1.000000000000',
      amountCents: 100,
      lineItems: [],
      policy: {
        id: null,
        scope: 'DEFAULT',
        modelName: null,
        priceMultiplier: '1',
        creditMultiplier: null,
        priority: 0,
      },
    };
    const acceptedLabel = 'v2-balance-policy-accepted';
    const mixedWriterLabel = 'v2-balance-policy-mixed-writer';
    const accepted = await prisma.$transaction((tx) => createReservationFixture(
      tx,
      base,
      acceptedLabel,
      true,
      1,
      {
        customerQuoteSnapshot: quote,
        customerSettlementPolicyVersion: 'gateway-customer-settlement-v2',
      },
    ));
    const mixedWriter = await prisma.$transaction((tx) => createReservationFixture(
      tx,
      base,
      mixedWriterLabel,
      true,
      1,
      {
        customerQuoteSnapshot: quote,
        customerSettlementPolicyVersion: 'gateway-customer-settlement-v2',
      },
    ));
    const receiptPayload = (
      reservation: ReservationFixture,
      label: string,
      policyVersion: CustomerSettlementWriterPolicyVersion,
    ): Prisma.InputJsonValue => {
      const tokenUsageId = `protocol-${label}-usage-${base.suffix}`;
      const settlementFingerprint =
        `protocol-${label}-fingerprint-${base.suffix}`;
      return {
        customerFinancialAuthority: {
          protocol: 'gateway-customer-financial-authority-v1',
          policyVersion,
          basis: 'NORMALIZED_EXACT',
          billingUnit: 'BALANCE',
          terminalClass: 'BALANCE_SETTLED',
          fundingOutcome: 'COLLECTED',
          customerAmountUnit: 'USD',
          originalCustomerAmount: '1.000000000000',
          settledCustomerAmount: '1.000000000000',
          originalCustomerChargeUsd: '1.000000000000',
          settledCustomerChargeUsd: '1.000000000000',
          originalDimensions: dimensions,
          settledDimensions: dimensions,
          anchorHash: reservation.anchorHash,
          pricingHash: reservation.pricingHash,
          settlementFingerprint,
          tokenUsageId,
        },
        billingResult: {
          success: true,
          allowed: true,
          unit: 'BALANCE',
          fundingOutcome: 'COLLECTED',
          quote,
          tokenUsageId,
        },
      } as Prisma.InputJsonValue;
    };

    await prisma.$transaction(async (tx) => {
      await createFinancialProofRows(tx, base, accepted, acceptedLabel, {
        funding: {
          chargeUsd: 1,
          collectedUsd: 1,
          approvedUsd: 0,
          unapprovedUsd: 0,
        },
        receiptPolicyVersion: 'gateway-settlement-v3-customer-authority',
        receiptIdempotencyKey:
          `gateway:financial:${accepted.requestId}:${accepted.anchorHash}`,
        receiptPayload: receiptPayload(
          accepted,
          acceptedLabel,
          'gateway-customer-settlement-v2',
        ),
      });
      await assertTerminalProof(tx, accepted.reservationId);
    });

    expect(await prisma.gatewayUsageSettlementReceipt.findFirstOrThrow({
      where: { gatewayBillingEventId: accepted.gatewayBillingEventId },
      select: { payload: true },
    })).toEqual({
      payload: expect.objectContaining({
        customerFinancialAuthority: expect.objectContaining({
          policyVersion: 'gateway-customer-settlement-v2',
          basis: 'NORMALIZED_EXACT',
        }),
      }),
    });

    await expectPostgresFailure(
      prisma.$transaction((tx) => createFinancialProofRows(
        tx,
        base,
        mixedWriter,
        mixedWriterLabel,
        {
          funding: {
            chargeUsd: 1,
            collectedUsd: 1,
            approvedUsd: 0,
            unapprovedUsd: 0,
          },
          receiptPolicyVersion: 'gateway-settlement-v3-customer-authority',
          receiptIdempotencyKey:
            `gateway:financial:${mixedWriter.requestId}:${mixedWriter.anchorHash}`,
          receiptPayload: receiptPayload(
            mixedWriter,
            mixedWriterLabel,
            'gateway-customer-settlement-v1',
          ),
        },
      )),
      'gateway BALANCE canonical financial authority is incomplete',
    );
    expect(await prisma.gatewayUsageSettlementReceipt.count({
      where: { gatewayBillingEventId: mixedWriter.gatewayBillingEventId },
    })).toBe(0);
    expect(await prisma.tokenUsage.count({
      where: { gatewayBillingEventId: mixedWriter.gatewayBillingEventId },
    })).toBe(0);
  }, 60_000);

  it('keeps historical v2 receipts valid and rejects unknown reserved policies', async () => {
    const label = 'v2-compatibility';
    const base = await createBaseFixture(prisma, label, { openingBalanceUsd: 10 });
    const reservation = await prisma.$transaction((tx) => createReservationFixture(
      tx,
      base,
      label,
      true,
      1,
    ));
    await prisma.$transaction(async (tx) => {
      await createFinancialProofRows(tx, base, reservation, label, {
        funding: {
          chargeUsd: 1,
          collectedUsd: 1,
          approvedUsd: 0,
          unapprovedUsd: 0,
        },
      });
      await assertTerminalProof(tx, reservation.reservationId);
    });
    expect(await prisma.gatewayUsageSettlementReceipt.findFirstOrThrow({
      where: { gatewayBillingEventId: reservation.gatewayBillingEventId },
      select: { policyVersion: true, payload: true },
    })).toEqual({ policyVersion: 'gateway-settlement-v2', payload: {} });

    const unknown = await prisma.$transaction((tx) => createCreditsFixture(
      tx,
      base,
      'unknown-reserved-policy',
      VERIFIED_PRODUCER_BUILD_SHA,
      1,
    ));
    await expectPostgresFailure(
      prisma.$transaction((tx) => tx.gatewayUsageSettlementReceipt.create({
        data: {
          id: `protocol-unknown-policy-receipt-${base.suffix}`,
          gatewayBillingEventId: unknown.gatewayBillingEventId,
          requestId: unknown.requestId,
          settlementRevision: 1,
          fundingOutcome: 'INCLUDED',
          evidenceHash: unknown.evidenceHash,
          anchorHash: unknown.anchorHash,
          pricingHash: unknown.pricingHash,
          settlementFingerprint: `protocol-unknown-policy-${base.suffix}`,
          billingUnit: 'CREDITS',
          billingCurrency: 'USD',
          creditAmount: 0,
          amountUsd: new Prisma.Decimal(0),
          tokenUsageId: null,
          policyVersion: 'gateway-settlement-forged-unknown',
          idempotencyKey:
            `gateway:financial:${unknown.requestId}:${unknown.anchorHash}`,
          payload: {},
        },
      })),
      'gateway financial receipt policy version is unsupported',
    );
    expect(await prisma.gatewayUsageSettlementReceipt.count({
      where: { gatewayBillingEventId: unknown.gatewayBillingEventId },
    })).toBe(0);
  }, 60_000);

  it('binds enterprise reservations to append-only credit authority and its occurrence window', async () => {
    const now = Date.now();
    const [activeBase, foreignBase, pendingBase, noConfigBase, legacyHistoryBase,
      disabledBase, suspendedBase, futureBase, allowanceBase, personalBase] = await Promise.all([
      createBaseFixture(prisma, 'credit-active', { accountType: 'enterprise' }),
      createBaseFixture(prisma, 'credit-foreign', { accountType: 'enterprise' }),
      createBaseFixture(prisma, 'credit-pending', { accountType: 'enterprise' }),
      createBaseFixture(prisma, 'credit-none', { accountType: 'enterprise' }),
      createBaseFixture(prisma, 'credit-legacy-history', { accountType: 'enterprise' }),
      createBaseFixture(prisma, 'credit-disabled', { accountType: 'enterprise' }),
      createBaseFixture(prisma, 'credit-suspended', { accountType: 'enterprise' }),
      createBaseFixture(prisma, 'credit-future', { accountType: 'enterprise' }),
      createBaseFixture(prisma, 'credit-allowance', { accountType: 'enterprise' }),
      createBaseFixture(prisma, 'personal-no-credit', { openingBalanceUsd: 10 }),
    ]);
    const policyOptions = {
      limitUsd: 5,
      termsDays: 30,
      effectiveAt: new Date(now - 60_000),
      expiresAt: new Date(now + 24 * 60 * 60 * 1_000),
      decisionAt: new Date(now - 30_000),
      boundaryAt: new Date(now - 25_000),
    };
    const [activePolicy, foreignPolicy, allowancePolicy] = await Promise.all([
      createCreditPolicy(prisma, activeBase, 'active-db-authority', policyOptions),
      createCreditPolicy(prisma, foreignBase, 'foreign-db-authority', policyOptions),
      createCreditPolicy(prisma, allowanceBase, 'allowance-db-authority', policyOptions),
    ]);
    const pendingPolicy = await createCreditPolicy(
      prisma,
      pendingBase,
      'unconfirmed-db-authority',
      { ...policyOptions, confirmed: false },
    );
    const futurePolicy = await createCreditPolicy(
      prisma,
      futureBase,
      'future-first-policy',
      {
        ...policyOptions,
        decisionAt: new Date(now + 20_000),
        boundaryAt: new Date(now + 25_000),
      },
    );
    await createCreditPolicy(
      prisma,
      disabledBase,
      'disabled-current-policy',
      {
        ...policyOptions,
        limitUsd: 0,
        status: 'DISABLED',
      },
    );
    await createCreditPolicy(
      prisma,
      suspendedBase,
      'suspended-current-policy',
      {
        ...policyOptions,
        status: 'SUSPENDED',
      },
    );
    await prisma.billingAccountCreditEvent.create({
      data: {
        id: `protocol-credit-event-legacy-${legacyHistoryBase.suffix}`,
        billingAccountId: legacyHistoryBase.billingAccountId,
        oldLimitUsd: null,
        newLimitUsd: new Prisma.Decimal(0),
        oldStatus: null,
        newStatus: 'DISABLED',
        oldTermsDays: null,
        newTermsDays: null,
        oldEffectiveAt: null,
        newEffectiveAt: null,
        oldExpiresAt: null,
        newExpiresAt: null,
        temporalSnapshotComplete: false,
        policyRevision: null,
        policyDecisionAt: null,
        policyEffectiveBoundaryAt: null,
        policyBoundaryComplete: false,
        actorId: `legacy-finance-${legacyHistoryBase.suffix}`,
        reason: 'Legacy credit history without revision',
      },
    });
    const times = {
      windowStart: new Date(now - 12_000),
      occurredAt: new Date(now - 10_000),
      policyAt: new Date(now - 8_000),
      firstReceivedAt: new Date(now - 6_000),
    };

    const active = await prisma.$transaction((tx) => createReservationFixture(
      tx,
      activeBase,
      'active-event-new',
      true,
      1,
      eventNewCreditFunding(activePolicy, times),
    ));
    expect(await prisma.gatewayUsageFundingReservation.findUniqueOrThrow({
      where: { id: active.reservationId },
      select: {
        creditPolicySource: true,
        creditPolicyEventId: true,
        creditPolicyRevision: true,
        creditConfiguredLimitUsd: true,
        creditLimitUsd: true,
        approvedCreditDueAt: true,
      },
    })).toEqual({
      creditPolicySource: 'EVENT_NEW_STATE',
      creditPolicyEventId: activePolicy.eventId,
      creditPolicyRevision: 1,
      creditConfiguredLimitUsd: new Prisma.Decimal(5),
      creditLimitUsd: new Prisma.Decimal(5),
      approvedCreditDueAt: new Date(
        times.policyAt.getTime() + 30 * 24 * 60 * 60 * 1_000,
      ),
    });

    const personal = await prisma.$transaction((tx) => createReservationFixture(
      tx,
      personalBase,
      'personal-no-credit',
    ));
    expect(await prisma.gatewayUsageFundingReservation.findUniqueOrThrow({
      where: { id: personal.reservationId },
      select: {
        creditPolicySource: true,
        creditPolicyEventId: true,
        creditPolicyRevision: true,
        creditConfiguredLimitUsd: true,
        creditLimitUsd: true,
      },
    })).toEqual({
      creditPolicySource: 'NOT_APPLICABLE',
      creditPolicyEventId: null,
      creditPolicyRevision: null,
      creditConfiguredLimitUsd: new Prisma.Decimal(0),
      creditLimitUsd: new Prisma.Decimal(0),
    });

    const plainNoConfig = await prisma.$transaction((tx) => createReservationFixture(
      tx,
      noConfigBase,
      'enterprise-no-config',
      true,
      1,
      {
        collectedUsd: 0,
        approvedCreditUsd: 0,
        unapprovedDebtUsd: 1,
        creditPolicySource: 'NO_CONFIG',
        creditConfiguredLimitUsd: 0,
        creditLimitUsd: 0,
      },
    ));
    expect(await prisma.gatewayUsageFundingReservation.findUniqueOrThrow({
      where: { id: plainNoConfig.reservationId },
      select: { creditPolicySource: true, approvedCreditUsd: true },
    })).toEqual({
      creditPolicySource: 'NO_CONFIG',
      approvedCreditUsd: new Prisma.Decimal(0),
    });

    const legacyHistoryCurrentPrepaid = await prisma.$transaction((tx) =>
      createReservationFixture(
        tx,
        legacyHistoryBase,
        'enterprise-legacy-history-current-prepaid',
        true,
        1,
        {
          collectedUsd: 0,
          approvedCreditUsd: 0,
          unapprovedDebtUsd: 1,
          creditPolicySource: 'CURRENT_PREPAID',
          creditConfiguredLimitUsd: 0,
          creditLimitUsd: 0,
        },
      ));
    expect(await prisma.gatewayUsageFundingReservation.findUniqueOrThrow({
      where: { id: legacyHistoryCurrentPrepaid.reservationId },
      select: { creditPolicySource: true, approvedCreditUsd: true },
    })).toEqual({
      creditPolicySource: 'CURRENT_PREPAID',
      approvedCreditUsd: new Prisma.Decimal(0),
    });

    const disabledCurrentPrepaid = await prisma.$transaction((tx) =>
      createReservationFixture(
        tx,
        disabledBase,
        'enterprise-disabled-current-prepaid',
        true,
        1,
        {
          collectedUsd: 0,
          approvedCreditUsd: 0,
          unapprovedDebtUsd: 1,
          creditPolicySource: 'CURRENT_PREPAID',
          creditConfiguredLimitUsd: 0,
          creditLimitUsd: 0,
        },
      ));
    expect(await prisma.gatewayUsageFundingReservation.findUniqueOrThrow({
      where: { id: disabledCurrentPrepaid.reservationId },
      select: { creditPolicySource: true, approvedCreditUsd: true },
    })).toEqual({
      creditPolicySource: 'CURRENT_PREPAID',
      approvedCreditUsd: new Prisma.Decimal(0),
    });

    const suspendedCurrentPrepaid = await prisma.$transaction((tx) =>
      createReservationFixture(
        tx,
        suspendedBase,
        'enterprise-suspended-current-prepaid',
        true,
        1,
        {
          collectedUsd: 0,
          approvedCreditUsd: 0,
          unapprovedDebtUsd: 1,
          creditPolicySource: 'CURRENT_PREPAID',
          creditConfiguredLimitUsd: 0,
          creditLimitUsd: 0,
        },
      ));
    expect(await prisma.gatewayUsageFundingReservation.findUniqueOrThrow({
      where: { id: suspendedCurrentPrepaid.reservationId },
      select: { creditPolicySource: true, approvedCreditUsd: true },
    })).toEqual({
      creditPolicySource: 'CURRENT_PREPAID',
      approvedCreditUsd: new Prisma.Decimal(0),
    });

    await expectPostgresFailure(
      prisma.$transaction((tx) => createReservationFixture(
        tx,
        disabledBase,
        'enterprise-current-prepaid-with-credit',
        true,
        1,
        {
          collectedUsd: 0,
          approvedCreditUsd: 1,
          unapprovedDebtUsd: 0,
          creditPolicySource: 'CURRENT_PREPAID',
          creditConfiguredLimitUsd: 1,
          creditLimitUsd: 1,
          creditTermsDays: 30,
          approvedCreditDueAt: new Date(now + 30 * 24 * 60 * 60 * 1_000),
          creditStatus: 'ACTIVE',
        },
      )),
      'gateway current prepaid reservation contains credit',
    );

    await expectPostgresFailure(
      prisma.$transaction((tx) => createReservationFixture(
        tx,
        activeBase,
        'enterprise-active-as-current-prepaid',
        true,
        1,
        {
          collectedUsd: 0,
          approvedCreditUsd: 0,
          unapprovedDebtUsd: 1,
          creditPolicySource: 'CURRENT_PREPAID',
          creditConfiguredLimitUsd: 0,
          creditLimitUsd: 0,
        },
      )),
      'gateway current prepaid policy requires credit to be disabled',
    );

    // Revision 1 exists now, but its decision/boundary is provably later than
    // this request's full occurrence window. The historical state was no config.
    const historicalNoConfig = await prisma.$transaction((tx) =>
      createReservationFixture(tx, futureBase, 'historical-no-config', true, 1, {
        collectedUsd: 0,
        approvedCreditUsd: 0,
        unapprovedDebtUsd: 1,
        ...times,
        creditPolicyWindowStart: times.windowStart,
        creditPolicyAt: times.policyAt,
        creditPolicyEventId: futurePolicy.eventId,
        creditPolicyRevision: 0,
        creditPolicySource: 'NO_CONFIG',
        creditConfiguredLimitUsd: 0,
        creditLimitUsd: 0,
      }));
    expect(await prisma.gatewayUsageFundingReservation.findUniqueOrThrow({
      where: { id: historicalNoConfig.reservationId },
      select: { creditPolicySource: true, creditPolicyEventId: true, creditPolicyRevision: true },
    })).toEqual({
      creditPolicySource: 'NO_CONFIG',
      creditPolicyEventId: futurePolicy.eventId,
      creditPolicyRevision: 0,
    });

    await expectPostgresFailure(
      prisma.$transaction((tx) => createReservationFixture(
        tx,
        noConfigBase,
        'forged-no-config-credit',
        true,
        1,
        {
          collectedUsd: 0,
          approvedCreditUsd: 1,
          unapprovedDebtUsd: 0,
          creditPolicySource: 'NO_CONFIG',
          creditConfiguredLimitUsd: 1,
          creditLimitUsd: 1,
          creditTermsDays: 30,
          approvedCreditDueAt: new Date(now + 30 * 24 * 60 * 60 * 1_000),
          creditStatus: 'ACTIVE',
        },
      )),
      'enterprise gateway NO_CONFIG reservation contains credit',
    );

    await expectPostgresFailure(
      prisma.$transaction((tx) => createReservationFixture(
        tx,
        activeBase,
        'foreign-account-event',
        true,
        1,
        {
          ...eventNewCreditFunding(activePolicy, times),
          creditPolicyEventId: foreignPolicy.eventId,
        },
      )),
      'enterprise gateway reservation EVENT_NEW_STATE proof is invalid',
    );

    await expectPostgresFailure(
      prisma.$transaction((tx) => createReservationFixture(
        tx,
        pendingBase,
        'unconfirmed-policy-boundary',
        true,
        1,
        eventNewCreditFunding(pendingPolicy, times),
      )),
      'enterprise gateway reservation credit config tail is invalid',
    );

    if (!activePolicy.boundaryAt) throw new Error('confirmed policy lacks boundary');
    const crossingTimes = {
      ...times,
      windowStart: new Date(activePolicy.boundaryAt.getTime() - 1),
    };
    await expectPostgresFailure(
      prisma.$transaction((tx) => createReservationFixture(
        tx,
        activeBase,
        'crossing-policy-window',
        true,
        1,
        eventNewCreditFunding(activePolicy, crossingTimes),
      )),
      'enterprise gateway reservation credit window crosses policy boundary',
    );

    const wrongDueFunding = eventNewCreditFunding(activePolicy, times);
    wrongDueFunding.approvedCreditDueAt = new Date(
      (wrongDueFunding.approvedCreditDueAt as Date).getTime() + 1,
    );
    await expectPostgresFailure(
      prisma.$transaction((tx) => createReservationFixture(
        tx,
        activeBase,
        'wrong-credit-due',
        true,
        1,
        wrongDueFunding,
      )),
      'enterprise gateway reservation approved credit policy is invalid',
    );

    await expectPostgresFailure(
      prisma.$transaction((tx) => createReservationFixture(
        tx,
        activeBase,
        'credit-over-policy-limit',
        true,
        6,
        eventNewCreditFunding(activePolicy, times, 6),
      )),
      'enterprise gateway reservation approved credit policy is invalid',
    );

    await prisma.$transaction((tx) => createReservationFixture(
      tx,
      allowanceBase,
      'credit-allowance-first',
      true,
      4,
      eventNewCreditFunding(allowancePolicy, times, 4),
    ));
    await expectPostgresFailure(
      prisma.$transaction((tx) => createReservationFixture(
        tx,
        allowanceBase,
        'credit-allowance-overbook',
        true,
        2,
        eventNewCreditFunding(allowancePolicy, times, 2),
      )),
      'enterprise gateway reservation exceeds proven available credit',
    );
  }, 90_000);

  it('releases holds only for the two immutable raw-evidence NO_CHARGE proofs', async () => {
    const base = await createBaseFixture(
      prisma,
      'no-charge-evidence',
      { openingBalanceUsd: 50 },
    );
    const [buildAuthority] = await prisma.$queryRaw<Array<{
      id: string;
      revision: number;
      authorityHash: string;
    }>>`
      SELECT
        id,
        revision,
        authority_hash AS "authorityHash"
      FROM "gateway_producer_build_authorization_events"
      WHERE producer_build_sha = ${VERIFIED_PRODUCER_BUILD_SHA}
        AND decision = 'AUTHORIZED'
      ORDER BY revision DESC
      LIMIT 1
    `;
    if (!buildAuthority) throw new Error('verified build authority fixture is missing');
    const fixtures = {
      quota: await prisma.$transaction((tx) => createReservationFixture(
        tx,
        base,
        'no-charge-quota',
        true,
        1,
        { rawEvidence: quotaExceededEvidence() },
      )),
      zero: await prisma.$transaction((tx) => createReservationFixture(
        tx,
        base,
        'no-charge-zero',
        true,
        1,
        { rawEvidence: authoritativeZeroUsageEvidence() },
      )),
      unregisteredBuild: await prisma.$transaction((tx) => createReservationFixture(
        tx,
        base,
        'no-charge-unregistered-build',
        true,
        1,
        {
          rawEvidence: {
            ...quotaExceededEvidence(),
            producer_build_sha: UNAUTHORIZED_PRODUCER_BUILD_SHA,
          },
          // A stale/compromised writer may try to nominate a valid authority
          // tuple. The BEFORE INSERT trigger must erase it and select only by
          // the evidence build + observed_at pair.
          producerBuildAuthorizationEventId: buildAuthority.id,
          producerBuildAuthorizationRevision: buildAuthority.revision,
          producerBuildAuthorityHash: buildAuthority.authorityHash,
        },
      )),
      pending: await prisma.$transaction((tx) => createReservationFixture(
        tx,
        base,
        'no-charge-pending',
        true,
        1,
        { rawEvidence: quotaExceededEvidence() },
      )),
      auth: await prisma.$transaction((tx) => createReservationFixture(
        tx,
        base,
        'no-charge-auth-description',
        true,
        1,
        {
          rawEvidence: {
            ...quotaExceededEvidence(),
            status_code: 401,
            quota_settlement: 'skipped',
            error: { stage: 'auth', type: 'invalid_api_key' },
          },
        },
      )),
      inputOnly: await prisma.$transaction((tx) => createReservationFixture(
        tx,
        base,
        'no-charge-input-only',
        true,
        1,
        {
          rawEvidence: authoritativeZeroUsageEvidence({
            prompt_tokens: 1,
            total_tokens: 1,
          }),
        },
      )),
      exactDuplicateDimensions: await prisma.$transaction((tx) => createReservationFixture(
        tx,
        base,
        'no-charge-exact-duplicate-dimensions',
        true,
        1,
        {
          rawEvidence: authoritativeZeroUsageEvidence({
            usage_evidence: {
              source: 'provider_terminal',
              status: 'complete',
              protocol: 'anthropic_sse',
              terminal_frame_seen: true,
              dimensions_present: [
                'input_tokens',
                'input_tokens',
                'output_tokens',
                'cache_read_input_tokens',
                'cache_creation_input_tokens',
              ],
            },
          }),
        },
      )),
      unsafeTokenExtra: await prisma.$transaction((tx) => createReservationFixture(
        tx,
        base,
        'no-charge-unsafe-token-extra',
        true,
        1,
        {
          rawEvidence: authoritativeZeroUsageEvidence({
            token_extras: {
              cached_tokens: 0,
              cache_creation_input_tokens: 0,
              reasoning_tokens: 1.5,
            },
          }),
        },
      )),
      estimatedDisconnect: await prisma.$transaction((tx) => createReservationFixture(
        tx,
        base,
        'no-charge-estimated-disconnect',
        true,
        1,
        {
          rawEvidence: authoritativeZeroUsageEvidence({
            status: 'failure',
            token_source: 'estimated',
            stream_end_reason: 'client_disconnect',
            disconnect_stage: 'stream_mid',
            provider_reconciliation_required: true,
            usage_evidence: {
              source: 'estimated_tokenizer',
              status: 'incomplete',
              protocol: 'anthropic_sse',
              terminal_frame_seen: false,
              dimensions_present: [
                'input_tokens',
                'output_tokens',
                'cache_read_input_tokens',
                'cache_creation_input_tokens',
              ],
            },
          }),
        },
      )),
      invalidTokenExtras: await prisma.$transaction((tx) => createReservationFixture(
        tx,
        base,
        'no-charge-invalid-token-extras',
        true,
        1,
        {
          rawEvidence: authoritativeZeroUsageEvidence({
            token_extras: {
              cached_tokens: 0,
              cache_creation_input_tokens: 0,
              provider_extension: 0.5,
            },
          }),
        },
      )),
      normalizedDuplicateDimensions: await prisma.$transaction((tx) => createReservationFixture(
        tx,
        base,
        'no-charge-normalized-duplicate-dimensions',
        true,
        1,
        {
          rawEvidence: authoritativeZeroUsageEvidence({
            usage_evidence: {
              source: 'provider_terminal',
              status: 'complete',
              protocol: 'anthropic_sse',
              terminal_frame_seen: true,
              dimensions_present: [
                'input_tokens',
                'output_tokens',
                'cache_read_input_tokens',
                'cache_creation_input_tokens',
                '\uFEFFINPUT_TOKENS\uFEFF',
              ],
            },
          }),
        },
      )),
    };

    const familyAttackInputs: Array<{ label: string; rawEvidence: JsonObject }> = [
      {
        label: 'provider-openai-route-anthropic-conflict',
        rawEvidence: authoritativeZeroUsageEvidence({ provider: 'openai' }),
      },
      {
        label: 'provider-anthropic-route-openai-conflict',
        rawEvidence: {
          ...authoritativeZeroUsageEvidenceWithProtocol('openai_sse'),
          provider: 'anthropic',
          resolved_api_type: 'openai_chat_completions',
        },
      },
      {
        label: 'route-protocol-conflict',
        rawEvidence: {
          ...authoritativeZeroUsageEvidenceWithProtocol('openai_sse'),
          resolved_api_type: 'anthropic_messages',
        },
      },
      {
        label: 'trimmed-provider-family-conflict',
        rawEvidence: {
          ...withoutEvidenceField(
            authoritativeZeroUsageEvidenceWithProtocol('openai_sse'),
            'upstream_request_id',
          ),
          provider: 'anthropic\u00A0',
          resolved_api_type: 'openai_chat_completions',
          upstream_response_id: 'response-id-cannot-bypass-trimmed-family',
        },
      },
      {
        label: 'provider-missing',
        rawEvidence: withoutEvidenceField(authoritativeZeroUsageEvidence(), 'provider'),
      },
      {
        label: 'resolved-api-type-missing',
        rawEvidence: withoutEvidenceField(
          authoritativeZeroUsageEvidence(),
          'resolved_api_type',
        ),
      },
      {
        label: 'protocol-missing',
        rawEvidence: withoutUsageEvidenceField(
          authoritativeZeroUsageEvidence(),
          'protocol',
        ),
      },
      {
        label: 'resolved-api-type-invalid-shape',
        rawEvidence: authoritativeZeroUsageEvidence({
          resolved_api_type: 'anthropic-v1',
        }),
      },
      {
        label: 'resolved-api-type-invalid-type',
        rawEvidence: authoritativeZeroUsageEvidence({ resolved_api_type: 52 }),
      },
      {
        label: 'protocol-invalid-shape',
        rawEvidence: authoritativeZeroUsageEvidenceWithProtocol('anthropic-v1'),
      },
      {
        label: 'protocol-invalid-type',
        rawEvidence: authoritativeZeroUsageEvidenceWithProtocol(52),
      },
      {
        label: 'resolved-api-type-unknown',
        rawEvidence: authoritativeZeroUsageEvidence({ resolved_api_type: 'future_api' }),
      },
      {
        label: 'protocol-unknown',
        rawEvidence: authoritativeZeroUsageEvidenceWithProtocol('future_protocol'),
      },
      {
        label: 'strict-upstream-request-id-missing',
        rawEvidence: {
          ...withoutEvidenceField(
            authoritativeZeroUsageEvidence(),
            'upstream_request_id',
          ),
          upstream_response_id: 'response-id-cannot-replace-request-id',
        },
      },
      {
        label: 'anthropic-cache-dimension-missing',
        rawEvidence: authoritativeZeroUsageEvidenceWithProtocol(
          'anthropic_sse',
          [
            'input_tokens',
            'output_tokens',
            'cache_creation_input_tokens',
            'image_count',
          ],
        ),
      },
    ];
    const familyAttackFixtures = await Promise.all(familyAttackInputs.map(
      async ({ label, rawEvidence }) => ({
        label,
        reason: 'zero_usage',
        fixture: await prisma.$transaction((tx) => createReservationFixture(
          tx,
          base,
          `no-charge-${label}`,
          true,
          1,
          { rawEvidence },
        )),
      }),
    ));
    const protocolNeutralProvider = await prisma.$transaction((tx) =>
      createReservationFixture(
        tx,
        base,
        'no-charge-protocol-neutral-provider',
        true,
        1,
        {
          rawEvidence: {
            ...authoritativeZeroUsageEvidenceWithProtocol('openai_sse'),
            provider: 'mystery-vendor',
            resolved_api_type: 'openai_chat_completions',
            upstream_request_id: '',
            upstream_response_id: 'openai-response-terminal-proof',
          },
        },
      ));

    const [quotaEvidence, unregisteredEvidence] = await Promise.all([
      prisma.gatewayUsageEvidence.findFirstOrThrow({
        where: { gatewayBillingEventId: fixtures.quota.gatewayBillingEventId },
        select: {
          producerBuildAuthorizationEventId: true,
          producerBuildAuthorizationRevision: true,
          producerBuildAuthorityHash: true,
        },
      }),
      prisma.gatewayUsageEvidence.findFirstOrThrow({
        where: {
          gatewayBillingEventId: fixtures.unregisteredBuild.gatewayBillingEventId,
        },
        select: {
          producerBuildAuthorizationEventId: true,
          producerBuildAuthorizationRevision: true,
          producerBuildAuthorityHash: true,
        },
      }),
    ]);
    expect(quotaEvidence).toEqual({
      producerBuildAuthorizationEventId: buildAuthority.id,
      producerBuildAuthorizationRevision: buildAuthority.revision,
      producerBuildAuthorityHash: buildAuthority.authorityHash,
    });
    expect(unregisteredEvidence).toEqual({
      producerBuildAuthorizationEventId: null,
      producerBuildAuthorizationRevision: null,
      producerBuildAuthorityHash: null,
    });

    for (const isolationLevel of [
      Prisma.TransactionIsolationLevel.RepeatableRead,
      Prisma.TransactionIsolationLevel.Serializable,
    ]) {
      await expectPostgresFailure(
        prisma.$transaction(async (tx) => {
          await createNoChargeProofRows(
            tx,
            fixtures.quota,
            `invalid-isolation-${isolationLevel}`,
            'quota_exceeded',
          );
          await assertTerminalProof(tx, fixtures.quota.reservationId);
        }, { isolationLevel }),
        'gateway financial terminal requires READ COMMITTED isolation',
      );
    }

    await prisma.$transaction(async (tx) => {
      await createNoChargeProofRows(tx, fixtures.quota, 'valid-quota', 'quota_exceeded');
      await assertTerminalProof(tx, fixtures.quota.reservationId);
    });
    await prisma.$transaction(async (tx) => {
      await createNoChargeProofRows(tx, fixtures.zero, 'valid-zero', 'zero_usage');
      await assertTerminalProof(tx, fixtures.zero.reservationId);
    });
    await prisma.$transaction(async (tx) => {
      await createNoChargeProofRows(
        tx,
        fixtures.unregisteredBuild,
        'valid-unregistered-build',
        'quota_exceeded',
      );
      await assertTerminalProof(tx, fixtures.unregisteredBuild.reservationId);
    });
    await prisma.$transaction(async (tx) => {
      await createNoChargeProofRows(
        tx,
        protocolNeutralProvider,
        'valid-protocol-neutral-provider',
        'zero_usage',
      );
      await assertTerminalProof(tx, protocolNeutralProvider.reservationId);
    });
    expect(await prisma.gatewayUsageFundingReservation.count({
      where: {
        id: {
          in: [
            fixtures.quota.reservationId,
            fixtures.zero.reservationId,
            fixtures.unregisteredBuild.reservationId,
            protocolNeutralProvider.reservationId,
          ],
        },
        status: 'RELEASED',
      },
    })).toBe(4);

    for (const attack of [
      { fixture: fixtures.pending, label: 'pending', reason: 'pending_settlement' },
      { fixture: fixtures.auth, label: 'auth', reason: 'auth_rejected_before_delivery' },
      { fixture: fixtures.inputOnly, label: 'input-only', reason: 'zero_usage' },
      {
        fixture: fixtures.exactDuplicateDimensions,
        label: 'exact-duplicate-dimensions',
        reason: 'zero_usage',
      },
      {
        fixture: fixtures.unsafeTokenExtra,
        label: 'unsafe-token-extra',
        reason: 'zero_usage',
      },
      {
        fixture: fixtures.estimatedDisconnect,
        label: 'estimated-disconnect',
        reason: 'zero_usage',
      },
      {
        fixture: fixtures.invalidTokenExtras,
        label: 'invalid-token-extras',
        reason: 'zero_usage',
      },
      {
        fixture: fixtures.normalizedDuplicateDimensions,
        label: 'normalized-duplicate-dimensions',
        reason: 'zero_usage',
      },
      ...familyAttackFixtures,
    ]) {
      await expectPostgresFailure(
        prisma.$transaction(async (tx) => {
          await createNoChargeProofRows(tx, attack.fixture, attack.label, attack.reason);
          await assertTerminalProof(tx, attack.fixture.reservationId);
        }),
        'gateway released reservation lacks one permanent release proof',
      );
      expect(await prisma.gatewayUsageFundingReservation.findUniqueOrThrow({
        where: { id: attack.fixture.reservationId },
        select: { status: true },
      })).toEqual({ status: 'ACTIVE' });
    }
  }, 60_000);

  it('keeps a NO_CHARGE parent terminal immutable when later evidence is appended', async () => {
    const base = await createBaseFixture(
      prisma,
      'no-charge-later-evidence',
      { openingBalanceUsd: 10 },
    );
    const reservation = await prisma.$transaction((tx) => createReservationFixture(
      tx,
      base,
      'no-charge-later-evidence',
      true,
      1,
      { rawEvidence: quotaExceededEvidence() },
    ));
    await prisma.$transaction(async (tx) => {
      await createNoChargeProofRows(
        tx,
        reservation,
        'no-charge-later-evidence',
        'quota_exceeded',
      );
      await assertTerminalProof(tx, reservation.reservationId);
    });

    const terminalBefore = await prisma.gatewayBillingEvent.findUniqueOrThrow({
      where: { id: reservation.gatewayBillingEventId },
      select: {
        status: true,
        revision: true,
        reason: true,
        evidenceHash: true,
        evidenceVerdict: true,
        reconciliationStatus: true,
        fundingOutcome: true,
      },
    });
    const laterRawEvidence: JsonObject = {
      ...authoritativeZeroUsageEvidence(),
      request_id: reservation.requestId,
      provider_usage_hash:
        'sha256:bbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbbb',
    };
    const laterEvidenceHash = canonicalSha256(laterRawEvidence);
    await prisma.$transaction(async (tx) => {
      await tx.gatewayUsageEvidence.create({
        data: {
          id: `protocol-no-charge-later-evidence-2-${base.suffix}`,
          gatewayBillingEventId: reservation.gatewayBillingEventId,
          requestId: reservation.requestId,
          source: 'GATEWAY_USAGE_EVENT',
          tokenSource: 'provider',
          producerBuildSha: VERIFIED_PRODUCER_BUILD_SHA,
          providerUsageHash: String(laterRawEvidence.provider_usage_hash),
          providerAccountRef: String(laterRawEvidence.provider_account_ref),
          streamEndReason: String(laterRawEvidence.stream_end_reason),
          upstreamRequestId: String(laterRawEvidence.upstream_request_id),
          usageEvidenceSource: 'provider_terminal',
          usageEvidenceStatus: 'complete',
          usageEvidenceProtocol: 'anthropic_sse',
          terminalFrameSeen: true,
          providerReconciliationRequired: false,
          evidenceHash: laterEvidenceHash,
          evidenceRevision: 2,
          rawEvidence: laterRawEvidence as Prisma.InputJsonValue,
          observedAt: new Date(),
        },
      });
      await tx.gatewayUsageReconciliationAction.create({
        data: {
          gatewayBillingEventId: reservation.gatewayBillingEventId,
          requestId: reservation.requestId,
          action: 'APPEND_EVIDENCE',
          expectedRevision: terminalBefore.revision,
          resultingRevision: terminalBefore.revision,
          reason: 'post-terminal provider evidence audit',
          idempotencyKey:
            `gateway:append-evidence:${reservation.requestId}:${laterEvidenceHash}`,
          metadata: {
            evidenceHash: laterEvidenceHash,
            parentTerminalPreserved: true,
          },
        },
      });
      await assertTerminalProof(tx, reservation.reservationId);
    });

    expect(await prisma.gatewayBillingEvent.findUniqueOrThrow({
      where: { id: reservation.gatewayBillingEventId },
      select: {
        status: true,
        revision: true,
        reason: true,
        evidenceHash: true,
        evidenceVerdict: true,
        reconciliationStatus: true,
        fundingOutcome: true,
      },
    })).toEqual(terminalBefore);
    expect(await prisma.gatewayUsageEvidence.count({
      where: { gatewayBillingEventId: reservation.gatewayBillingEventId },
    })).toBe(2);
    expect(await prisma.gatewayUsageReconciliationAction.count({
      where: {
        gatewayBillingEventId: reservation.gatewayBillingEventId,
        action: 'APPEND_EVIDENCE',
      },
    })).toBe(1);
  }, 60_000);

  it('accepts a NO_CHARGE receipt/event produced by the real billing service', async () => {
    const base = await createBaseFixture(
      prisma,
      'service-no-charge',
      { openingBalanceUsd: 10 },
    );
    const label = 'service-no-charge';
    const requestId = `protocol-${label}-request-${base.suffix}`;
    const occurredAt = new Date(Date.now() - 5_000);
    const firstReceivedAt = new Date();
    const rawEvidence: JsonObject = {
      version: 'v2',
      event_type: 'usage',
      event_id: `protocol-${label}-usage-event-${base.suffix}`,
      request_id: requestId,
      ts: occurredAt.toISOString(),
      key_id: base.apiKeyId,
      tenant_id: base.tenantId,
      model: 'glm-5.2',
      actual_model: 'glm-5.2',
      resolved_model: 'glm-5.2',
      upstream_model: 'glm-5.2',
      resolved_api_type: 'anthropic',
      quota_settlement: 'settled',
      labels: {
        tenant_id: base.tenantId,
        user_id: base.userId,
        'usr.product_id': base.productId,
        'usr.product_slug': base.productSlug,
      },
      error: null,
      ...authoritativeZeroUsageEvidence(),
    };
    const reservation = await prisma.$transaction((tx) => createReservationFixture(
      tx,
      base,
      label,
      true,
      1,
      {
        occurredAt,
        firstReceivedAt,
        rawEvidence,
        canonicalServiceProof: true,
      },
    ));

    const reserveGatewayBalanceFunding = jest.fn(async () =>
      prisma.gatewayUsageFundingReservation.findUniqueOrThrow({
        where: { id: reservation.reservationId },
      }));
    const releaseGatewayBalanceFunding = jest.fn(async (
      releasedRequestId: string,
      releaseReason: string,
    ) => {
      await prisma.$transaction(async (tx) => {
        const row = await tx.gatewayUsageFundingReservation.findUniqueOrThrow({
          where: { requestId: releasedRequestId },
          select: { id: true },
        });
        await transitionReservation(tx, row.id, 'release-v1', {
          status: 'RELEASED',
          releasedAt: new Date(),
          releaseReason,
        });
      });
    });
    const publisherSync = {
      syncBillingAccountKeyBalances: jest.fn().mockResolvedValue(undefined),
      syncBillingAccountKeyBalancesRequired: jest.fn().mockResolvedValue(undefined),
      syncKeyBalanceById: jest.fn().mockResolvedValue(undefined),
      syncKeyBalanceByIdRequired: jest.fn().mockResolvedValue(undefined),
    };
    const service = new GatewayRequestEventBillingService(
      { reserveGatewayBalanceFunding, releaseGatewayBalanceFunding } as never,
      prisma as never,
      {
        get: (key: string) => key === 'BILLING_USAGE_VERIFIED_PRODUCER_BUILDS'
          ? VERIFIED_PRODUCER_BUILD_SHA
          : undefined,
      } as never,
      undefined,
      publisherSync as never,
    );

    const result = await service.process(rawEvidence);
    expect(result).toMatchObject({
      action: 'skipped',
      requestId,
      reason: 'zero_usage',
      revision: 1,
      reconciliationStatus: 'CLOSED',
    });
    expect(reserveGatewayBalanceFunding).toHaveBeenCalledTimes(1);
    expect(releaseGatewayBalanceFunding).toHaveBeenCalledWith(
      requestId,
      'non_financial:zero_usage',
    );
    await prisma.$transaction((tx) => assertTerminalProof(tx, reservation.reservationId));

    const [event, receipt, releasedReservation] = await Promise.all([
      prisma.gatewayBillingEvent.findUniqueOrThrow({ where: { requestId } }),
      prisma.gatewayUsageSettlementReceipt.findUniqueOrThrow({
        where: {
          idempotencyKey:
            `gateway:no-charge:${requestId}:${reservation.anchorHash}`,
        },
      }),
      prisma.gatewayUsageFundingReservation.findUniqueOrThrow({
        where: { id: reservation.reservationId },
      }),
    ]);
    expect(event).toMatchObject({
      status: 'SKIPPED',
      fundingOutcome: 'NO_CHARGE',
      reason: 'zero_usage',
      revision: 1,
    });
    expect(receipt).toMatchObject({
      gatewayBillingEventId: reservation.gatewayBillingEventId,
      requestId,
      settlementRevision: 1,
      fundingOutcome: 'NO_CHARGE',
      evidenceHash: reservation.evidenceHash,
      anchorHash: reservation.anchorHash,
      pricingHash: reservation.pricingHash,
      billingCurrency: 'USD',
      amountUsd: new Prisma.Decimal(0),
      reason: 'zero_usage',
      policyVersion: 'gateway-no-charge-v1',
    });
    expect(releasedReservation).toMatchObject({
      status: 'RELEASED',
      releaseReason: 'non_financial:zero_usage',
    });
  }, 60_000);

  it('accepts an ABSORB receipt/action produced by the real billing service', async () => {
    const base = await createBaseFixture(
      prisma,
      'service-absorb',
      { openingBalanceUsd: 10 },
    );
    const reservation = await prisma.$transaction((tx) => createReservationFixture(
      tx,
      base,
      'service-absorb',
    ));
    await prisma.gatewayBillingEvent.update({
      where: { id: reservation.gatewayBillingEventId },
      data: {
        status: 'QUARANTINED',
        reconciliationStatus: 'MANUAL_REVIEW',
        reason: 'evidence requires finance decision',
        pendingExposureUsd: reservation.reservedAmountUsd,
        pendingHoldUsd: reservation.reservedAmountUsd,
      },
    });

    const releaseGatewayBalanceFunding = jest.fn(async (
      requestId: string,
      releaseReason: string,
    ) => {
      await prisma.$transaction(async (tx) => {
        const row = await tx.gatewayUsageFundingReservation.findUniqueOrThrow({
          where: { requestId },
          select: { id: true },
        });
        await transitionReservation(tx, row.id, 'release-v1', {
          status: 'RELEASED',
          releasedAt: new Date(),
          releaseReason,
        });
      });
    });
    const service = new GatewayRequestEventBillingService(
      { releaseGatewayBalanceFunding } as never,
      prisma as never,
    );
    const command = {
      expectedRevision: 0,
      actorId: `finance-${base.suffix}`,
      reason: 'approved platform absorption',
      idempotencyKey: `service-absorb-${base.suffix}`,
    };

    await service.absorb(reservation.requestId, command);
    await prisma.$transaction((tx) => assertTerminalProof(tx, reservation.reservationId));

    expect(releaseGatewayBalanceFunding).toHaveBeenCalledWith(
      reservation.requestId,
      `financial_absorption:${command.idempotencyKey}`,
    );
    expect(await prisma.gatewayUsageFundingReservation.findUniqueOrThrow({
      where: { id: reservation.reservationId },
      select: { status: true, releaseReason: true },
    })).toEqual({
      status: 'RELEASED',
      releaseReason: `financial_absorption:${command.idempotencyKey}`,
    });
    const [action, receipt] = await Promise.all([
      prisma.gatewayUsageReconciliationAction.findUniqueOrThrow({
        where: { idempotencyKey: command.idempotencyKey },
      }),
      prisma.gatewayUsageSettlementReceipt.findUniqueOrThrow({
        where: { idempotencyKey: `receipt:${command.idempotencyKey}` },
      }),
    ]);
    expect(action).toMatchObject({
      action: 'ABSORB',
      expectedRevision: 0,
      resultingRevision: 1,
      reason: command.reason,
      actorId: command.actorId,
    });
    expect(receipt).toMatchObject({
      fundingOutcome: 'ABSORBED',
      settlementRevision: 1,
      amountUsd: reservation.reservedAmountUsd,
      evidenceHash: reservation.evidenceHash,
      anchorHash: reservation.anchorHash,
      pricingHash: reservation.pricingHash,
      billingCurrency: 'USD',
      policyVersion: 'manual-finance-v2',
      reason: command.reason,
      actorId: command.actorId,
    });
  }, 60_000);

  it('accepts only a repair-bound zero-value unanchored currency ABSORB', async () => {
    const rollback = new Error('ROLLBACK_UNANCHORED_CURRENCY_ABSORB_FIXTURE');
    try {
      await prisma.$transaction(async (outerTx) => {
        const scopedPrisma = new Proxy(outerTx, {
          get(target, property) {
            if (property === '$transaction') {
              return async <T>(operation: (tx: Prisma.TransactionClient) => Promise<T>) =>
                operation(outerTx);
            }
            const value = Reflect.get(target, property, target);
            return typeof value === 'function' ? value.bind(target) : value;
          },
        }) as unknown as PrismaClient;
        const base = await createBaseFixture(scopedPrisma, 'unanchored-currency-absorb');
        const requestId = `unanchored-currency-request-${base.suffix}`;
        const eventId = `unanchored-currency-event-${base.suffix}`;
        const failureReason = 'settlement_anchor_missing';
        const errorMessage =
          'Gateway billing currency mismatch: account=USD deployment=CNY';
        const errorFingerprint = createHash('sha256')
          .update(errorMessage, 'utf8')
          .digest('hex');
        expect(errorFingerprint).toBe(
          'f7c470fb73da49f0ed8b517ec5993e0c3a1796e08b4b8835c03d96fb9364d137',
        );
        const rawEvidence = authoritativeZeroUsageEvidence({
          request_id: requestId,
          event_id: eventId,
          key_id: base.apiKeyId,
          tenant_id: base.tenantId,
          labels: { tenant_id: base.tenantId },
        });
        const evidenceHash = canonicalSha256(rawEvidence);

        // This row represents a receipt that predates the migration. Its JSON
        // nulls reproduce the legacy application writer; the marker and the
        // synthetic label transition remain test/CI-only and transaction-local.
        await outerTx.$executeRaw`
          SELECT set_config(
            'billing.allow_legacy_currency_failure_fixture',
            'true',
            true
          )
        `;
        const event = await outerTx.gatewayBillingEvent.create({
          data: {
            requestId,
            eventId,
            status: 'QUARANTINED',
            reason: failureReason,
            apiKeyId: base.apiKeyId,
            tenantId: base.tenantId,
            billingAccountId: null,
            billingUnit: null,
            billingResult: Prisma.JsonNull,
            pricingSnapshot: Prisma.JsonNull,
            reconciliationStatus: 'MANUAL_REVIEW',
            evidenceVerdict: 'INCOMPLETE',
            fundingOutcome: null,
            revision: 1,
            pendingExposureUsd: new Prisma.Decimal(0),
            pendingHoldUsd: new Prisma.Decimal(0),
            rawEvent: rawEvidence as Prisma.InputJsonValue,
            evidenceHash,
            errorMessage,
          },
        });
        const legacyNullStorage = await outerTx.$queryRaw<Array<{
          billingResultType: string | null;
          pricingSnapshotType: string | null;
          billingResultIsSqlNull: boolean;
          pricingSnapshotIsSqlNull: boolean;
        }>>`
          SELECT
            jsonb_typeof("billing_result") AS "billingResultType",
            jsonb_typeof("pricing_snapshot") AS "pricingSnapshotType",
            "billing_result" IS NULL AS "billingResultIsSqlNull",
            "pricing_snapshot" IS NULL AS "pricingSnapshotIsSqlNull"
          FROM "gateway_billing_events"
          WHERE "id" = ${event.id}
        `;
        expect(legacyNullStorage).toEqual([{
          billingResultType: 'null',
          pricingSnapshotType: 'null',
          billingResultIsSqlNull: false,
          pricingSnapshotIsSqlNull: false,
        }]);
        const evidence = await outerTx.gatewayUsageEvidence.create({
          data: {
            gatewayBillingEventId: event.id,
            requestId,
            eventId,
            source: 'GATEWAY_USAGE_EVENT',
            evidenceHash,
            evidenceRevision: 1,
            rawEvidence: rawEvidence as Prisma.InputJsonValue,
            observedAt: new Date(),
          },
        });
        await outerTx.billingAccessRestriction.create({
          data: {
            gatewayBillingEventId: event.id,
            apiKeyId: base.apiKeyId,
            reason: 'settlement_policy_review',
            idempotencyKey: `unanchored-currency-restriction-${base.suffix}`,
            createdBy: 'SYSTEM',
          },
        });

        const auditRunId = `currency-repair-run-${base.suffix}`;
        const auditItemId = `currency-repair-item-${base.suffix}`;
        const eligibleEventId = `currency-repair-event-${base.suffix}`;
        const manifestVersion = `integration-unanchored-currency-v1-${base.suffix}`;
        const manifestHash = canonicalSha256({
          schemaVersion: 'integration-currency-label-repair-manifest-v1',
          manifestVersion,
          sourceCurrency: 'USD',
          targetCurrency: 'CNY',
          accounts: [{ ordinal: 1, billingAccountId: base.billingAccountId }],
        });
        const repairEvidenceHash = canonicalSha256({
          schemaVersion: 'integration-currency-label-repair-evidence-v1',
          manifestVersion,
          manifestHash,
          billingAccountId: base.billingAccountId,
          gatewayBillingEventId: event.id,
          gatewayEvidenceHash: evidenceHash,
        });
        const appliedAt = new Date();
        const drainedUntil = new Date(appliedAt.getTime() + 20 * 60_000);

        await outerTx.$executeRaw`
          INSERT INTO "billing_account_currency_label_repair_runs" (
            "id", "manifest_version", "manifest_hash", "database_name",
            "database_identity", "database_system_identifier", "database_oid",
            "source_currency", "target_currency", "platform_config_snapshot",
            "platform_config_hash", "change_ticket", "operator", "approver_one",
            "approver_two", "evidence_sha256", "confirmation",
            "writers_drained_until", "account_count", "status", "applied_at",
            "created_at"
          )
          SELECT
            ${auditRunId}, ${manifestVersion}, ${manifestHash}, current_database(),
            rollout."database_identity", rollout."database_system_identifier",
            rollout."database_oid"::BIGINT, 'USD', 'CNY',
            '{"region":"domestic","currency":"cny"}'::JSONB,
            encode(sha256(convert_to(
              '{"region":"domestic","currency":"cny"}'::JSONB::TEXT,
              'UTF8'
            )), 'hex'),
            'TEST-UNANCHORED-CURRENCY-ABSORB', 'test-operator',
            'test-finance-approver', 'test-platform-approver',
            ${repairEvidenceHash}, 'LABEL_ONLY_NO_FX', ${drainedUntil}, 1,
            'APPLIED', ${appliedAt}, ${appliedAt}
          FROM "balance_ledger_rollout_control" AS rollout
          WHERE rollout."id" = 1
        `;
        await outerTx.$executeRaw`
          WITH snapshot AS (
            SELECT
              to_jsonb(account_row) AS before_account,
              jsonb_set(
                to_jsonb(account_row),
                '{currency}',
                to_jsonb('CNY'::TEXT)
              ) AS after_account,
              "billing_account_currency_label_financial_snapshot"(
                account_row."id"
              ) AS financial
            FROM "billing_accounts" AS account_row
            WHERE account_row."id" = ${base.billingAccountId}
          )
          INSERT INTO "billing_account_currency_label_repair_items" (
            "id", "run_id", "billing_account_id", "ordinal",
            "before_currency", "after_currency", "before_account_snapshot",
            "before_account_snapshot_hash", "after_account_snapshot",
            "after_account_snapshot_hash", "financial_snapshot",
            "financial_snapshot_hash", "created_at"
          )
          SELECT
            ${auditItemId}, ${auditRunId}, ${base.billingAccountId}, 1,
            'USD', 'CNY', snapshot.before_account,
            encode(sha256(convert_to(snapshot.before_account::TEXT, 'UTF8')), 'hex'),
            snapshot.after_account,
            encode(sha256(convert_to(snapshot.after_account::TEXT, 'UTF8')), 'hex'),
            snapshot.financial,
            encode(sha256(convert_to(snapshot.financial::TEXT, 'UTF8')), 'hex'),
            ${appliedAt}
          FROM snapshot
        `;
        const eligibleRows = await outerTx.$queryRaw<Array<{ rowHash: string }>>`
          WITH authority AS (
            SELECT jsonb_build_object(
              'event', to_jsonb(event_row)
                - 'raw_event'
                - 'billing_result'
                - 'subject_snapshot'
                - 'pricing_snapshot',
              'evidence', to_jsonb(evidence_row) - 'raw_evidence',
              'resolvedBillingAccountId', tenant_row."billing_account_id"
            ) AS event_snapshot
            FROM "gateway_billing_events" AS event_row
            JOIN "gateway_usage_evidences" AS evidence_row
              ON evidence_row."id" = ${evidence.id}
             AND evidence_row."gateway_billing_event_id" = event_row."id"
            JOIN "api_keys" AS api_key_row
              ON api_key_row."id" = event_row."api_key_id"
            JOIN "tenants" AS tenant_row
              ON tenant_row."id" = api_key_row."tenant_id"
            WHERE event_row."id" = ${event.id}
          ), proof AS (
            SELECT authority.event_snapshot, jsonb_build_object(
              'runId', ${auditRunId},
              'billingAccountId', ${base.billingAccountId},
              'gatewayBillingEventId', ${event.id},
              'requestId', ${requestId},
              'evidenceId', ${evidence.id},
              'evidenceHash', ${evidenceHash},
              'failureCode', 'BILLING_CURRENCY_MIGRATION_REQUIRED',
              'failureReason', ${failureReason},
              'errorMessage', ${errorMessage},
              'errorFingerprint', ${errorFingerprint},
              'eventSnapshot', authority.event_snapshot
            ) AS row_envelope
            FROM authority
          )
          INSERT INTO "billing_account_currency_label_repair_eligible_events" (
            "id", "run_id", "item_id", "gateway_billing_event_id",
            "request_id", "evidence_id", "evidence_hash", "failure_code",
            "failure_reason", "error_message", "error_fingerprint",
            "event_snapshot", "row_hash", "created_at"
          )
          SELECT
            ${eligibleEventId}, ${auditRunId}, ${auditItemId}, ${event.id},
            ${requestId}, ${evidence.id}, ${evidenceHash},
            'BILLING_CURRENCY_MIGRATION_REQUIRED', ${failureReason},
            ${errorMessage}, ${errorFingerprint}, proof.event_snapshot,
            encode(sha256(convert_to(proof.row_envelope::TEXT, 'UTF8')), 'hex'),
            ${appliedAt}
          FROM proof
          RETURNING "row_hash" AS "rowHash"
        `;
        expect(eligibleRows).toHaveLength(1);
        const eligibleEventRowHash = eligibleRows[0]?.rowHash;
        expect(eligibleEventRowHash).toMatch(/^[0-9a-f]{64}$/);

        await outerTx.$executeRaw`
          SELECT set_config(
            'billing.currency_label_repair_run_id',
            ${auditRunId},
            true
          )
        `;
        await outerTx.$executeRaw`
          SELECT set_config(
            'billing.allow_currency_label_repair_fixture',
            'true',
            true
          )
        `;
        const updatedAccountCount = await outerTx.$executeRaw`
          UPDATE "billing_accounts"
          SET "currency" = 'CNY'
          WHERE "id" = ${base.billingAccountId}
            AND "currency" = 'USD'
        `;
        expect(updatedAccountCount).toBe(1);
        await outerTx.$executeRaw`
          SELECT
            set_config('billing.allow_currency_label_repair_fixture', 'false', true),
            set_config('billing.currency_label_repair_run_id', '', true)
        `;

        const releaseGatewayBalanceFunding = jest.fn();
        const publisherSync = {
          syncBillingAccountKeyBalancesByKeyIdRequired: jest.fn(),
        };
        const service = new GatewayRequestEventBillingService(
          { releaseGatewayBalanceFunding } as never,
          scopedPrisma as never,
          { get: jest.fn() } as never,
          undefined,
          publisherSync as never,
          {
            getDeploymentConfig: jest.fn().mockResolvedValue({
              version: '1',
              region: 'domestic',
              provider: 'wechat',
              currency: 'cny',
              defaultLanguage: 'zh',
              oauth: {},
            }),
          } as never,
        );
        const command = {
          expectedRevision: 1,
          actorId: `finance-${base.suffix}`,
          reason: 'approved audited legacy currency closure',
          idempotencyKey: `unanchored-currency-absorb-${base.suffix}`,
          protocol: 'gateway-unanchored-absorb-v1',
          currencyRepairRunId: auditRunId,
          currencyRepairItemId: auditItemId,
          manifestHash,
        };

        await service.absorb(requestId, command);
        await outerTx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
        await outerTx.$executeRaw`
          SELECT set_config(
            'billing.allow_legacy_currency_failure_fixture',
            'false',
            true
          )
        `;

        const [
          closed,
          action,
          receipt,
          restriction,
          financialFacts,
          terminalNullStorage,
        ] = await Promise.all([
          outerTx.gatewayBillingEvent.findUniqueOrThrow({ where: { id: event.id } }),
          outerTx.gatewayUsageReconciliationAction.findUniqueOrThrow({
            where: { idempotencyKey: command.idempotencyKey },
          }),
          outerTx.gatewayUsageSettlementReceipt.findUniqueOrThrow({
            where: { idempotencyKey: `receipt:${command.idempotencyKey}` },
          }),
          outerTx.billingAccessRestriction.findFirstOrThrow({
            where: { gatewayBillingEventId: event.id },
          }),
          Promise.all([
            outerTx.gatewayUsageSettlementAnchor.count({
              where: { gatewayBillingEventId: event.id },
            }),
            outerTx.gatewayUsageFundingReservation.count({
              where: { gatewayBillingEventId: event.id },
            }),
            outerTx.tokenUsage.count({ where: { gatewayBillingEventId: event.id } }),
            outerTx.gatewayUsagePlatformLoss.count({
              where: { gatewayBillingEventId: event.id },
            }),
            outerTx.usageLossRecognitionClaim.count({
              where: { gatewayBillingEventId: event.id },
            }),
            outerTx.historicalPlatformLossLine.count({
              where: { gatewayBillingEventId: event.id },
            }),
            outerTx.creditTransaction.count({ where: { requestId } }),
          ]),
          outerTx.$queryRaw<Array<{
            billingResultIsSqlNull: boolean;
            pricingSnapshotIsSqlNull: boolean;
          }>>`
            SELECT
              "billing_result" IS NULL AS "billingResultIsSqlNull",
              "pricing_snapshot" IS NULL AS "pricingSnapshotIsSqlNull"
            FROM "gateway_billing_events"
            WHERE "id" = ${event.id}
          `,
        ]);
        expect(closed).toMatchObject({
          status: 'ABSORBED',
          reconciliationStatus: 'CLOSED',
          fundingOutcome: 'ABSORBED',
          revision: 2,
          billingAccountId: null,
          billingUnit: null,
        });
        expect(action).toMatchObject({
          action: 'ABSORB',
          expectedRevision: 1,
          resultingRevision: 2,
          actorId: command.actorId,
        });
        expect(action.metadata).toMatchObject({
          protocol: 'gateway-unanchored-absorb-v1',
          currencyRepairRunId: auditRunId,
          currencyRepairItemId: auditItemId,
          currencyRepairManifestHash: manifestHash,
          currencyRepairEligibleEventId: eligibleEventId,
          currencyRepairEligibleEventRowHash: eligibleEventRowHash,
          currencyRepairEligibilityCode: 'BILLING_CURRENCY_MIGRATION_REQUIRED',
          currencyRepairFailureReason: failureReason,
          currencyRepairErrorFingerprint: errorFingerprint,
          currencyRepairEvidenceId: evidence.id,
        });
        expect(receipt).toMatchObject({
          policyVersion: 'gateway-unanchored-absorb-v1',
          amountUsd: new Prisma.Decimal(0),
          anchorHash: null,
          pricingHash: null,
          billingUnit: null,
          billingCurrency: null,
          tokenUsageId: null,
        });
        expect(receipt.payload).toMatchObject({
          protocol: 'gateway-unanchored-absorb-v1',
          currencyRepairRunId: auditRunId,
          currencyRepairItemId: auditItemId,
          currencyRepairManifestHash: manifestHash,
          currencyRepairEligibleEventId: eligibleEventId,
          currencyRepairEligibleEventRowHash: eligibleEventRowHash,
          currencyRepairEligibilityCode: 'BILLING_CURRENCY_MIGRATION_REQUIRED',
          currencyRepairFailureReason: failureReason,
          currencyRepairErrorFingerprint: errorFingerprint,
          currencyRepairEvidenceId: evidence.id,
        });
        expect(restriction.status).toBe('RELEASED');
        expect(financialFacts).toEqual([0, 0, 0, 0, 0, 0, 0]);
        expect(terminalNullStorage).toEqual([{
          billingResultIsSqlNull: true,
          pricingSnapshotIsSqlNull: true,
        }]);
        expect(releaseGatewayBalanceFunding).not.toHaveBeenCalled();
        expect(publisherSync.syncBillingAccountKeyBalancesByKeyIdRequired)
          .toHaveBeenCalledWith(base.apiKeyId);
        throw rollback;
      }, { timeout: 60_000 });
    } catch (error) {
      if (error !== rollback) throw error;
    }
  }, 60_000);

  it('rejects split/replayed writes and accepts one complete atomic BALANCE settlement', async () => {
    const suffix = randomUUID();
    const base: BaseFixture = {
      suffix,
      userId: `protocol-user-${suffix}`,
      billingAccountId: `protocol-account-${suffix}`,
      tenantId: `protocol-tenant-${suffix}`,
      productId: `protocol-product-${suffix}`,
      productSlug: `protocol-product-${suffix}`,
      apiKeyId: `protocol-key-${suffix}`,
      balanceGrantId: `protocol-grant-${suffix}`,
      accountType: 'personal',
      ledgerMode: 'clean',
    };
    const cleanZeroBase: BaseFixture = {
      suffix: `zero-${suffix}`,
      userId: `protocol-zero-user-${suffix}`,
      billingAccountId: `protocol-zero-account-${suffix}`,
      tenantId: `protocol-zero-tenant-${suffix}`,
      productId: `protocol-zero-product-${suffix}`,
      productSlug: `protocol-zero-product-${suffix}`,
      apiKeyId: `protocol-zero-key-${suffix}`,
      // Zero-price reservations never create a grant hold.
      balanceGrantId: `protocol-zero-unused-grant-${suffix}`,
      accountType: 'personal',
      ledgerMode: 'clean',
    };
    const enterpriseBase: BaseFixture = {
      suffix: `enterprise-${suffix}`,
      userId: `protocol-enterprise-user-${suffix}`,
      billingAccountId: `protocol-enterprise-account-${suffix}`,
      tenantId: `protocol-enterprise-tenant-${suffix}`,
      productId: `protocol-enterprise-product-${suffix}`,
      productSlug: `protocol-enterprise-product-${suffix}`,
      apiKeyId: `protocol-enterprise-key-${suffix}`,
      // Credit-only reservations do not create a grant hold.
      balanceGrantId: `protocol-enterprise-unused-grant-${suffix}`,
      accountType: 'enterprise',
      ledgerMode: 'clean',
    };
    const openingAt = new Date(Date.now() - 10_000);

    await prisma.$transaction(async (tx) => {
      await tx.user.create({ data: { id: base.userId } });
      await tx.billingAccount.create({
        data: {
          id: base.billingAccountId,
          name: 'Gateway protocol integration',
          ownerUserId: base.userId,
          currency: 'USD',
          balanceGrantLedgerStatus: 'RECONCILED_V2',
          balanceGrantLedgerVersion: 2,
          balanceGrantLedgerHash: 'EMPTY_V2',
          balanceGrantLedgerReconciledAt: new Date(openingAt.getTime() - 1_000),
        },
      });
      await tx.accountWallet.create({
        data: { billingAccountId: base.billingAccountId, balanceUsd: new Prisma.Decimal(0) },
      });
      await tx.tenant.create({
        data: {
          id: base.tenantId,
          name: 'Gateway protocol integration',
          ownerUserId: base.userId,
          billingAccountId: base.billingAccountId,
        },
      });
      await tx.product.create({
        data: {
          id: base.productId,
          name: 'Gateway protocol integration',
          slug: `protocol-product-${suffix}`,
          billingMode: ProductBillingMode.PAY_AS_YOU_GO,
        },
      });
      await tx.apiKey.create({
        data: {
          id: base.apiKeyId,
          userId: base.userId,
          tenantId: base.tenantId,
          productId: base.productId,
          name: 'Gateway protocol integration',
          prefix: `sk-${suffix.slice(0, 8)}`,
          keyHash: `protocol-key-hash-${suffix}`,
        },
      });
      await tx.$queryRaw`
        SELECT "billing_account_id" FROM "account_wallets"
        WHERE "billing_account_id" = ${base.billingAccountId} FOR UPDATE
      `;
      await tx.$executeRaw`
        SELECT set_config('billing.balance_financial_now', ${openingAt.toISOString()}, true)
      `;
      await tx.accountWallet.update({
        where: { billingAccountId: base.billingAccountId },
        data: { balanceUsd: new Prisma.Decimal(10) },
      });
      await tx.balanceTransaction.create({
        data: {
          id: `protocol-opening-tx-${suffix}`,
          operationKey: `balance:admin-recharge:grant:${base.balanceGrantId}`,
          userId: base.userId,
          tenantId: base.tenantId,
          billingAccountId: base.billingAccountId,
          type: TransactionType.RECHARGE,
          amountUsd: new Prisma.Decimal(10),
          balanceAfterUsd: new Prisma.Decimal(10),
          description: 'Gateway protocol integration opening',
          productId: base.productId,
          createdAt: openingAt,
        },
      });
      await tx.balanceGrant.create({
        data: {
          id: base.balanceGrantId,
          userId: base.userId,
          tenantId: base.tenantId,
          billingAccountId: base.billingAccountId,
          productId: base.productId,
          source: 'RECHARGE',
          paidAmountUsd: new Prisma.Decimal(10),
          bonusAmountUsd: new Prisma.Decimal(0),
          grantedAmountUsd: new Prisma.Decimal(10),
          remainingAmountUsd: new Prisma.Decimal(10),
          remainingPaidAmountUsd: new Prisma.Decimal(10),
          remainingBonusAmountUsd: new Prisma.Decimal(0),
          discountRate: new Prisma.Decimal(1),
          validFrom: openingAt,
          createdAt: openingAt,
        },
      });
    });
    await prisma.$transaction(async (tx) => {
      await tx.user.create({ data: { id: enterpriseBase.userId } });
      await tx.billingAccount.create({
        data: {
          id: enterpriseBase.billingAccountId,
          type: 'enterprise',
          name: 'Gateway enterprise protocol integration',
          ownerUserId: enterpriseBase.userId,
          currency: 'USD',
          balanceGrantLedgerStatus: 'RECONCILED_V2',
          balanceGrantLedgerVersion: 2,
          balanceGrantLedgerHash: 'EMPTY_V2',
          balanceGrantLedgerReconciledAt: new Date(),
        },
      });
      await tx.accountWallet.create({
        data: {
          billingAccountId: enterpriseBase.billingAccountId,
          balanceUsd: new Prisma.Decimal(0),
        },
      });
      await tx.tenant.create({
        data: {
          id: enterpriseBase.tenantId,
          type: 'enterprise',
          name: 'Gateway enterprise protocol integration',
          ownerUserId: enterpriseBase.userId,
          billingAccountId: enterpriseBase.billingAccountId,
        },
      });
      await tx.product.create({
        data: {
          id: enterpriseBase.productId,
          name: 'Gateway enterprise protocol integration',
          slug: `protocol-enterprise-product-${suffix}`,
          billingMode: ProductBillingMode.PAY_AS_YOU_GO,
        },
      });
      await tx.apiKey.create({
        data: {
          id: enterpriseBase.apiKeyId,
          userId: enterpriseBase.userId,
          tenantId: enterpriseBase.tenantId,
          productId: enterpriseBase.productId,
          name: 'Gateway enterprise protocol integration',
          prefix: `sk-enterprise-${suffix.slice(0, 8)}`,
          keyHash: `protocol-enterprise-key-hash-${suffix}`,
        },
      });
    });
    await prisma.$transaction(async (tx) => {
      await tx.user.create({ data: { id: cleanZeroBase.userId } });
      await tx.billingAccount.create({
        data: {
          id: cleanZeroBase.billingAccountId,
          name: 'Gateway zero-price protocol integration',
          ownerUserId: cleanZeroBase.userId,
          currency: 'USD',
          balanceGrantLedgerStatus: 'RECONCILED_V2',
          balanceGrantLedgerVersion: 2,
          balanceGrantLedgerHash: 'EMPTY_V2',
          balanceGrantLedgerReconciledAt: new Date(),
        },
      });
      await tx.accountWallet.create({
        data: {
          billingAccountId: cleanZeroBase.billingAccountId,
          balanceUsd: new Prisma.Decimal(0),
        },
      });
      await tx.tenant.create({
        data: {
          id: cleanZeroBase.tenantId,
          name: 'Gateway zero-price protocol integration',
          ownerUserId: cleanZeroBase.userId,
          billingAccountId: cleanZeroBase.billingAccountId,
        },
      });
      await tx.product.create({
        data: {
          id: cleanZeroBase.productId,
          name: 'Gateway zero-price protocol integration',
          slug: `protocol-zero-product-${suffix}`,
          billingMode: ProductBillingMode.PAY_AS_YOU_GO,
        },
      });
      await tx.apiKey.create({
        data: {
          id: cleanZeroBase.apiKeyId,
          userId: cleanZeroBase.userId,
          tenantId: cleanZeroBase.tenantId,
          productId: cleanZeroBase.productId,
          name: 'Gateway zero-price protocol integration',
          prefix: `sk-zero-${suffix.slice(0, 8)}`,
          keyHash: `protocol-zero-key-hash-${suffix}`,
        },
      });
    });

    const noCreditEnterpriseBase = await createBaseFixture(
      prisma,
      'enterprise-no-credit',
      { accountType: 'enterprise', ledgerMode: 'clean' },
    );
    const policyDecisionAt = new Date(Date.now() - 20_000);
    const policyBoundaryAt = new Date(Date.now() - 15_000);
    const policyEffectiveAt = new Date(Date.now() - 30_000);
    const policyExpiresAt = new Date(Date.now() + 24 * 60 * 60 * 1_000);
    const activePolicy = await createCreditPolicy(
      prisma,
      enterpriseBase,
      'active',
      {
        limitUsd: 5,
        termsDays: 30,
        effectiveAt: policyEffectiveAt,
        expiresAt: policyExpiresAt,
        decisionAt: policyDecisionAt,
        boundaryAt: policyBoundaryAt,
      },
    );

    const settlement = await prisma.$transaction((tx) =>
      createReservationFixture(tx, base, 'settle'));
    const noCharge = await prisma.$transaction((tx) =>
      createReservationFixture(tx, base, 'no-charge', true, 1, {
        rawEvidence: quotaExceededEvidence(),
      }));
    const zeroPrice = await prisma.$transaction((tx) =>
      createReservationFixture(tx, cleanZeroBase, 'zero-price', true, 0));
    const frozenPolicyAt = new Date(Date.now() - 2_000);
    const frozenCreditDueAt = new Date(
      frozenPolicyAt.getTime() + 30 * 24 * 60 * 60 * 1_000,
    );
    const noCredit = await prisma.$transaction((tx) =>
      createReservationFixture(tx, noCreditEnterpriseBase, 'current-prepaid', true, 1, {
        collectedUsd: 0,
        approvedCreditUsd: 0,
        unapprovedDebtUsd: 1,
        creditLimitUsd: 0,
        creditPolicySource: 'CURRENT_PREPAID',
      }));
    const frozenCredit = await prisma.$transaction((tx) =>
      createReservationFixture(tx, enterpriseBase, 'frozen-credit', true, 1, {
        collectedUsd: 0,
        approvedCreditUsd: 1,
        unapprovedDebtUsd: 0,
        creditLimitUsd: 5,
        creditPolicyAt: frozenPolicyAt,
        creditTermsDays: 30,
        approvedCreditDueAt: frozenCreditDueAt,
        creditPolicySource: 'EVENT_NEW_STATE',
        creditPolicyEventId: activePolicy.eventId,
        creditPolicyRevision: activePolicy.revision,
        creditStatus: activePolicy.status,
        creditEffectiveAt: activePolicy.effectiveAt,
        creditExpiresAt: activePolicy.expiresAt,
      }));
    const authorityProof = await prisma.$transaction((tx) =>
      createReservationFixture(tx, base, 'authority-proof'));
    const absorbProof = await prisma.$transaction((tx) =>
      createReservationFixture(tx, base, 'absorb-proof'));
    const manualReviewProof = await prisma.$transaction((tx) =>
      createReservationFixture(tx, base, 'manual-review-proof'));
    const validAbsorb = await prisma.$transaction((tx) =>
      createReservationFixture(tx, base, 'valid-absorb'));
    const validCredit = await prisma.$transaction((tx) =>
      createReservationFixture(tx, enterpriseBase, 'valid-credit', true, 1, {
        collectedUsd: 0,
        approvedCreditUsd: 1,
        unapprovedDebtUsd: 0,
        creditLimitUsd: 5,
        creditPolicyAt: frozenPolicyAt,
        creditTermsDays: 30,
        approvedCreditDueAt: frozenCreditDueAt,
        creditPolicySource: 'EVENT_NEW_STATE',
        creditPolicyEventId: activePolicy.eventId,
        creditPolicyRevision: activePolicy.revision,
        creditStatus: activePolicy.status,
        creditEffectiveAt: activePolicy.effectiveAt,
        creditExpiresAt: activePolicy.expiresAt,
      }));

    await expectPostgresFailure(
      prisma.$transaction(async (tx) => {
        await createUsageForTerminalProof(
          tx,
          noCreditEnterpriseBase,
          noCredit,
          'no-credit-forgery',
          {
          chargeUsd: 1,
          collectedUsd: 0,
          approvedUsd: 1,
          unapprovedUsd: 0,
          },
        );
        await transitionReservation(tx, noCredit.reservationId, 'consume-v1', {
          status: 'CONSUMED',
          authoritativeAmountUsd: new Prisma.Decimal(1),
          consumedAt: new Date(),
        });
        await assertTerminalProof(tx, noCredit.reservationId);
      }),
      'gateway consumed reservation exceeds frozen funding authority',
    );

    await expectPostgresFailure(
      prisma.$transaction(async (tx) => {
        await createUsageForTerminalProof(
          tx,
          enterpriseBase,
          frozenCredit,
          'credit-over-frozen-limit',
          { chargeUsd: 2, collectedUsd: 0, approvedUsd: 2, unapprovedUsd: 0 },
        );
        await transitionReservation(tx, frozenCredit.reservationId, 'consume-v1', {
          status: 'CONSUMED',
          authoritativeAmountUsd: new Prisma.Decimal(2),
          consumedAt: new Date(),
        });
        await assertTerminalProof(tx, frozenCredit.reservationId);
      }),
      'gateway consumed reservation exceeds frozen funding authority',
    );

    await expectPostgresFailure(
      prisma.$transaction(async (tx) => {
        await createUsageForTerminalProof(tx, base, authorityProof, 'frozen-cash-bypass', {
          chargeUsd: 1,
          collectedUsd: 0,
          approvedUsd: 0,
          unapprovedUsd: 1,
        });
        await transitionReservation(tx, authorityProof.reservationId, 'consume-v1', {
          status: 'CONSUMED',
          authoritativeAmountUsd: new Prisma.Decimal(1),
          consumedAt: new Date(),
        });
        await assertTerminalProof(tx, authorityProof.reservationId);
      }),
      'gateway consumed reservation exceeds frozen funding authority',
    );

    for (const mismatch of [
      {
        label: 'policy-at',
        creditPolicyAt: new Date(frozenPolicyAt.getTime() + 1_000),
        creditTermsDays: 30,
        creditDueAt: frozenCreditDueAt,
      },
      {
        label: 'terms-days',
        creditPolicyAt: frozenPolicyAt,
        creditTermsDays: 31,
        creditDueAt: frozenCreditDueAt,
      },
      {
        label: 'due-at',
        creditPolicyAt: frozenPolicyAt,
        creditTermsDays: 30,
        creditDueAt: new Date(frozenCreditDueAt.getTime() + 1_000),
      },
    ]) {
      await expectPostgresFailure(
        prisma.$transaction(async (tx) => {
          await createFinancialProofRows(
            tx,
            enterpriseBase,
            frozenCredit,
            `credit-${mismatch.label}`,
            {
              funding: {
                chargeUsd: 1,
                collectedUsd: 0,
                approvedUsd: 1,
                unapprovedUsd: 0,
              },
              fundingOutcome: 'RECEIVABLE',
              allocationSource: 'ENTERPRISE_CREDIT',
              allocationBalanceGrantId: null,
              allocationApprovedUsd: 1,
              creditPolicyAt: mismatch.creditPolicyAt,
              creditTermsDays: mismatch.creditTermsDays,
              creditDueAt: mismatch.creditDueAt,
              creditPolicySnapshotComplete: true,
            },
          );
          await assertTerminalProof(tx, frozenCredit.reservationId);
        }),
        'gateway consumed reservation allocation proof is inconsistent',
      );
    }

    await expectPostgresFailure(
      prisma.$transaction(async (tx) => {
        await createFinancialProofRows(tx, base, authorityProof, 'foreign-evidence', {
          funding: {
            chargeUsd: 1,
            collectedUsd: 1,
            approvedUsd: 0,
            unapprovedUsd: 0,
          },
          receiptEvidenceHash: `foreign-evidence-${suffix}`,
        });
        await assertTerminalProof(tx, authorityProof.reservationId);
      }),
      'gateway consumed reservation v2 receipt is inconsistent',
    );

    await expectPostgresFailure(
      prisma.$transaction(async (tx) => {
        await createFinancialProofRows(tx, base, authorityProof, 'wrong-grant', {
          funding: {
            chargeUsd: 1,
            collectedUsd: 1,
            approvedUsd: 0,
            unapprovedUsd: 0,
          },
          allocationSource: 'UNRECONCILED_GRANT',
          allocationBalanceGrantId: null,
        });
        await assertTerminalProof(tx, authorityProof.reservationId);
      }),
      'unreconciled grant allocation is dirty-consume only',
    );

    await expectPostgresFailure(
      prisma.$transaction(async (tx) => {
        await transitionReservation(
          tx,
          manualReviewProof.reservationId,
          'manual-review-v1',
          { status: 'MANUAL_REVIEW', reviewReason: 'unbound review' },
        );
      }),
      'gateway funding reservation manual review transition is disabled',
    );

    for (const invalidAbsorb of [
      { label: 'amount', options: { amountUsd: 2 } },
      { label: 'currency', options: { billingCurrency: 'CNY' } },
      { label: 'evidence', options: { evidenceHash: `foreign-absorb-${suffix}` } },
      { label: 'anchor', options: { anchorHash: `foreign-anchor-${suffix}` } },
      { label: 'pricing', options: { pricingHash: `foreign-pricing-${suffix}` } },
      { label: 'expected-revision', options: { expectedRevision: 1 } },
      { label: 'resulting-revision', options: { resultingRevision: 2 } },
      { label: 'receipt-revision', options: { settlementRevision: 2 } },
      { label: 'action-reason', options: { actionReason: 'different approval' } },
      { label: 'receipt-reason', options: { receiptReason: 'different approval' } },
      { label: 'action-actor', options: { actionActorId: null } },
      {
        label: 'metadata-reservation',
        options: { metadataOverrides: { reservationHash: `foreign-reservation-${suffix}` } },
      },
      {
        label: 'metadata-fingerprint',
        options: { metadataOverrides: { settlementFingerprint: `foreign-${suffix}` } },
      },
      {
        label: 'payload-amount',
        options: { payloadOverrides: { approvedAbsorptionUsd: '2.000000000000' } },
      },
      {
        label: 'token-usage',
        options: { includeTokenUsage: true, bindManualReceiptToUsage: true },
      },
      {
        label: 'v2-coexistence',
        options: { includeTokenUsage: true, includeV2Receipt: true },
      },
    ] satisfies Array<{ label: string; options: AbsorbProofOptions }>) {
      await expectPostgresFailure(
        prisma.$transaction(async (tx) => {
          await createAbsorbProofRows(
            tx,
            base,
            absorbProof,
            invalidAbsorb.label,
            invalidAbsorb.options,
          );
          await assertTerminalProof(tx, absorbProof.reservationId);
        }),
        'gateway released reservation lacks one permanent release proof',
      );
    }

    await prisma.$transaction(async (tx) => {
      await createAbsorbProofRows(tx, base, validAbsorb, 'valid', {});
      await assertTerminalProof(tx, validAbsorb.reservationId);
    });
    expect(await prisma.gatewayUsageFundingReservation.findUniqueOrThrow({
      where: { id: validAbsorb.reservationId },
      select: { status: true },
    })).toEqual({ status: 'RELEASED' });

    await prisma.$transaction(async (tx) => {
      await createFinancialProofRows(tx, enterpriseBase, validCredit, 'valid-credit', {
        funding: {
          chargeUsd: 1,
          collectedUsd: 0,
          approvedUsd: 1,
          unapprovedUsd: 0,
        },
        fundingOutcome: 'RECEIVABLE',
        allocationSource: 'ENTERPRISE_CREDIT',
        allocationBalanceGrantId: null,
        allocationApprovedUsd: 1,
        creditPolicyAt: frozenPolicyAt,
        creditTermsDays: 30,
        creditDueAt: frozenCreditDueAt,
        creditPolicySnapshotComplete: true,
      });
      await assertTerminalProof(tx, validCredit.reservationId);
    });
    expect(await prisma.gatewayUsageFundingReservation.findUniqueOrThrow({
      where: { id: validCredit.reservationId },
      select: { status: true, authoritativeAmountUsd: true },
    })).toEqual({
      status: 'CONSUMED',
      authoritativeAmountUsd: new Prisma.Decimal(1),
    });

    await prisma.$transaction(async (tx) => {
      await createFinancialProofRows(
        tx,
        noCreditEnterpriseBase,
        noCredit,
        'valid-current-prepaid-debt',
        {
          funding: {
            chargeUsd: 1,
            collectedUsd: 0,
            approvedUsd: 0,
            unapprovedUsd: 1,
          },
          fundingOutcome: 'DEBT_OPEN',
          allocationSource: 'ENTERPRISE_CREDIT',
          allocationBalanceGrantId: null,
          allocationApprovedUsd: 0,
          allocationUnapprovedUsd: 1,
          creditPolicyAt: noCredit.firstReceivedAt,
          creditTermsDays: null,
          creditDueAt: null,
          creditPolicySnapshotComplete: true,
        },
      );
      await assertTerminalProof(tx, noCredit.reservationId);
    });
    expect(await prisma.gatewayUsageFundingReservation.findUniqueOrThrow({
      where: { id: noCredit.reservationId },
      select: { status: true, authoritativeAmountUsd: true },
    })).toEqual({
      status: 'CONSUMED',
      authoritativeAmountUsd: new Prisma.Decimal(1),
    });
    const [currentPrepaidReceipt, currentPrepaidUsage] = await Promise.all([
      prisma.gatewayUsageSettlementReceipt.findFirstOrThrow({
        where: { gatewayBillingEventId: noCredit.gatewayBillingEventId },
        select: { fundingOutcome: true, amountUsd: true },
      }),
      prisma.tokenUsage.findFirstOrThrow({
        where: { gatewayBillingEventId: noCredit.gatewayBillingEventId },
        select: {
          customerCollectedUsd: true,
          customerApprovedReceivableUsd: true,
          customerUnapprovedDebtUsd: true,
        },
      }),
    ]);
    expect(currentPrepaidReceipt).toEqual({
      fundingOutcome: 'DEBT_OPEN',
      amountUsd: new Prisma.Decimal(1),
    });
    expect(currentPrepaidUsage).toEqual({
      customerCollectedUsd: new Prisma.Decimal(0),
      customerApprovedReceivableUsd: new Prisma.Decimal(0),
      customerUnapprovedDebtUsd: new Prisma.Decimal(1),
    });

    const legacyDirtyBase = await createBaseFixture(
      prisma,
      'legacy-dirty-terminal',
      { ledgerMode: 'dirty', openingBalanceUsd: 10 },
    );
    const legacyDirtyReservation = await prisma.$transaction((tx) =>
      createReservationFixture(tx, legacyDirtyBase, 'legacy-dirty-positive'));
    await expectPostgresFailure(
      prisma.$transaction(async (tx) => {
        await createFinancialProofRows(
          tx,
          legacyDirtyBase,
          legacyDirtyReservation,
          'legacy-dirty-positive',
          {
            funding: {
              chargeUsd: 1,
              collectedUsd: 1,
              approvedUsd: 0,
              unapprovedUsd: 0,
            },
          },
        );
        await assertTerminalProof(tx, legacyDirtyReservation.reservationId);
      }),
      'gateway terminal settlement requires reconciled v2 ledger',
    );

    await expectPostgresFailure(
      prisma.$transaction((tx) => createReservationFixture(tx, base, 'partial-t1', false)),
      'gateway funding reservation grant backing is incomplete',
    );

    const splitTokenUsageId = `protocol-split-usage-${suffix}`;
    await expectPostgresFailure(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          SELECT set_config('ruidong.gateway_settlement_protocol', 'v1', true)
        `;
        await tx.tokenUsage.create({
          data: {
            id: splitTokenUsageId,
            apiKeyId: base.apiKeyId,
            tenantId: base.tenantId,
            productId: base.productId,
            gatewayBillingEventId: settlement.gatewayBillingEventId,
            requestId: settlement.requestId,
            model: 'glm-5.2',
            promptTokens: 100,
            completionTokens: 10,
            totalTokens: 110,
            inputPriceUsdPerM: new Prisma.Decimal(1_000),
            outputPriceUsdPerM: new Prisma.Decimal(1_000),
            costUsd: new Prisma.Decimal(1),
            customerChargePolicy: 'payg_balance',
            customerChargeUsd: new Prisma.Decimal(1),
            customerCollectedUsd: new Prisma.Decimal(1),
            customerApprovedReceivableUsd: new Prisma.Decimal(0),
            customerUnapprovedDebtUsd: new Prisma.Decimal(0),
            customerFundingClassificationComplete: true,
          },
        });
      }),
      'gateway TokenUsage must commit with exactly one v2 receipt',
    );
    expect(await prisma.tokenUsage.findUnique({ where: { id: splitTokenUsageId } })).toBeNull();

    await expectPostgresFailure(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          SELECT
            set_config(
              'ruidong.gateway_funding_transition_protocol',
              'release-v1',
              true
            ),
            set_config(
              'ruidong.gateway_funding_transition_reservation_id',
              ${settlement.reservationId},
              true
            )
        `;
        await tx.gatewayUsageFundingReservation.update({
          where: { id: settlement.reservationId },
          data: {
            status: 'RELEASED',
            releasedAt: new Date(),
            releaseReason: 'non_financial:missing_proof',
          },
        });
      }),
      'gateway released reservation lacks one permanent release proof',
    );

    const financialNow = new Date();
    const tokenUsageId = `protocol-usage-${suffix}`;
    const balanceTransactionId = `protocol-consume-tx-${suffix}`;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "billing_account_id" FROM "account_wallets"
        WHERE "billing_account_id" = ${base.billingAccountId} FOR UPDATE
      `;
      await tx.$queryRaw`
        SELECT "id" FROM "balance_grants"
        WHERE "billing_account_id" = ${base.billingAccountId}
        ORDER BY "created_at", "id" FOR UPDATE
      `;
      await tx.$executeRaw`
        SELECT set_config('billing.balance_financial_now', ${financialNow.toISOString()}, true)
      `;
      await tx.$executeRaw`
        SELECT
          set_config('ruidong.gateway_settlement_protocol', 'v1', true),
          set_config(
            'ruidong.gateway_consuming_reservation_id',
            ${settlement.reservationId},
            true
          )
      `;
      await tx.tokenUsage.create({
        data: {
          id: tokenUsageId,
          apiKeyId: base.apiKeyId,
          tenantId: base.tenantId,
          productId: base.productId,
          gatewayBillingEventId: settlement.gatewayBillingEventId,
          requestId: settlement.requestId,
          model: 'glm-5.2',
          promptTokens: 100,
          completionTokens: 10,
          totalTokens: 110,
          inputPriceUsdPerM: new Prisma.Decimal(1_000),
          outputPriceUsdPerM: new Prisma.Decimal(1_000),
          costUsd: new Prisma.Decimal(1),
          customerChargePolicy: 'payg_balance',
          customerChargeUsd: new Prisma.Decimal(1),
          customerCollectedUsd: new Prisma.Decimal(1),
          customerApprovedReceivableUsd: new Prisma.Decimal(0),
          customerUnapprovedDebtUsd: new Prisma.Decimal(0),
          customerFundingClassificationComplete: true,
        },
      });
      await tx.accountWallet.update({
        where: { billingAccountId: base.billingAccountId },
        data: { balanceUsd: new Prisma.Decimal(9) },
      });
      await tx.balanceGrant.update({
        where: { id: base.balanceGrantId },
        data: {
          remainingAmountUsd: new Prisma.Decimal(9),
          remainingPaidAmountUsd: new Prisma.Decimal(9),
        },
      });
      await tx.balanceTransaction.create({
        data: {
          id: balanceTransactionId,
          operationKey: `gateway:${settlement.requestId}`,
          userId: base.userId,
          tenantId: base.tenantId,
          billingAccountId: base.billingAccountId,
          type: TransactionType.CONSUME,
          amountUsd: new Prisma.Decimal(-1),
          balanceAfterUsd: new Prisma.Decimal(9),
          description: 'Gateway protocol atomic settlement',
          productId: base.productId,
          tokenUsageId,
          createdAt: financialNow,
        },
      });
      await tx.balanceConsumptionAllocation.create({
        data: {
          id: `protocol-allocation-${suffix}`,
          userId: base.userId,
          tenantId: base.tenantId,
          billingAccountId: base.billingAccountId,
          productId: base.productId,
          balanceTransactionId,
          tokenUsageId,
          balanceGrantId: base.balanceGrantId,
          source: 'BALANCE_GRANT',
          amountUsd: new Prisma.Decimal(1),
          recognizedRevenueUsd: new Prisma.Decimal(1),
          bonusConsumedUsd: new Prisma.Decimal(0),
          discountRate: new Prisma.Decimal(1),
          fundingClassificationComplete: true,
          createdAt: financialNow,
        },
      });
      await tx.$executeRaw`
        SELECT
          set_config(
            'ruidong.gateway_funding_transition_protocol',
            'consume-v1',
            true
          ),
          set_config(
            'ruidong.gateway_funding_transition_reservation_id',
            ${settlement.reservationId},
            true
          )
      `;
      await tx.gatewayUsageFundingReservation.update({
        where: { id: settlement.reservationId },
        data: {
          status: 'CONSUMED',
          authoritativeAmountUsd: new Prisma.Decimal(1),
          consumedAt: financialNow,
        },
      });
      await tx.gatewayUsageSettlementReceipt.create({
        data: {
          id: `protocol-receipt-${suffix}`,
          gatewayBillingEventId: settlement.gatewayBillingEventId,
          requestId: settlement.requestId,
          settlementRevision: 1,
          fundingOutcome: 'COLLECTED',
          evidenceHash: settlement.evidenceHash,
          anchorHash: settlement.anchorHash,
          pricingHash: settlement.pricingHash,
          settlementFingerprint: `protocol-fingerprint-${suffix}`,
          billingUnit: 'BALANCE',
          billingCurrency: 'USD',
          amountUsd: new Prisma.Decimal(1),
          tokenUsageId,
          policyVersion: 'gateway-settlement-v2',
          idempotencyKey: `gateway:financial:${settlement.requestId}`,
          payload: { billingResult: { fundingOutcome: 'COLLECTED' } },
        },
      });
    });

    expect(await prisma.gatewayUsageFundingReservation.findUniqueOrThrow({
      where: { id: settlement.reservationId },
      select: { status: true },
    })).toEqual({ status: 'CONSUMED' });

    await expectPostgresFailure(
      prisma.$transaction(async (tx) => {
        await tx.$executeRaw`
          SELECT
            set_config('ruidong.gateway_settlement_protocol', 'v1', true),
            set_config(
              'ruidong.gateway_consuming_reservation_id',
              ${settlement.reservationId},
              true
            )
        `;
        await tx.balanceGrant.update({
          where: { id: base.balanceGrantId },
          data: {
            remainingAmountUsd: new Prisma.Decimal(8),
            remainingPaidAmountUsd: new Prisma.Decimal(8),
          },
        });
      }),
      'invalid Gateway funding reservation consumption marker',
    );

    await prisma.$transaction(async (tx) => {
      await createNoChargeProofRows(tx, noCharge, 'quota', 'quota_exceeded');
      await assertTerminalProof(tx, noCharge.reservationId);
    });
    expect(await prisma.gatewayUsageFundingReservation.findUniqueOrThrow({
      where: { id: noCharge.reservationId },
      select: { status: true },
    })).toEqual({ status: 'RELEASED' });

    // A delivered request can have positive token usage but an exact zero
    // customer price (for example an enterprise multiplier of zero). It is a
    // financial settlement with TokenUsage + v2 receipt, not a NO_CHARGE skip.
    const zeroTokenUsageId = `protocol-zero-price-usage-${suffix}`;
    await prisma.$transaction(async (tx) => {
      await tx.$queryRaw`
        SELECT "billing_account_id" FROM "account_wallets"
        WHERE "billing_account_id" = ${cleanZeroBase.billingAccountId} FOR UPDATE
      `;
      await tx.$executeRaw`
        SELECT
          set_config('ruidong.gateway_settlement_protocol', 'v1', true),
          set_config(
            'ruidong.gateway_funding_transition_protocol',
            'consume-v1',
            true
          ),
          set_config(
            'ruidong.gateway_funding_transition_reservation_id',
            ${zeroPrice.reservationId},
            true
          )
      `;
      await tx.tokenUsage.create({
        data: {
          id: zeroTokenUsageId,
          apiKeyId: cleanZeroBase.apiKeyId,
          tenantId: cleanZeroBase.tenantId,
          productId: cleanZeroBase.productId,
          gatewayBillingEventId: zeroPrice.gatewayBillingEventId,
          requestId: zeroPrice.requestId,
          model: 'glm-5.2',
          promptTokens: 100,
          completionTokens: 10,
          totalTokens: 110,
          inputPriceUsdPerM: new Prisma.Decimal(0),
          outputPriceUsdPerM: new Prisma.Decimal(0),
          costUsd: new Prisma.Decimal(0),
          customerChargePolicy: 'payg_balance',
          customerChargeUsd: new Prisma.Decimal(0),
          customerCollectedUsd: new Prisma.Decimal(0),
          customerApprovedReceivableUsd: new Prisma.Decimal(0),
          customerUnapprovedDebtUsd: new Prisma.Decimal(0),
          customerFundingClassificationComplete: true,
        },
      });
      await tx.gatewayUsageFundingReservation.update({
        where: { id: zeroPrice.reservationId },
        data: {
          status: 'CONSUMED',
          authoritativeAmountUsd: new Prisma.Decimal(0),
          consumedAt: new Date(),
        },
      });
      await tx.gatewayUsageSettlementReceipt.create({
        data: {
          id: `protocol-zero-price-receipt-${suffix}`,
          gatewayBillingEventId: zeroPrice.gatewayBillingEventId,
          requestId: zeroPrice.requestId,
          settlementRevision: 1,
          fundingOutcome: 'COLLECTED',
          evidenceHash: zeroPrice.evidenceHash,
          anchorHash: zeroPrice.anchorHash,
          pricingHash: zeroPrice.pricingHash,
          settlementFingerprint: `protocol-zero-price-fingerprint-${suffix}`,
          billingUnit: 'BALANCE',
          billingCurrency: 'USD',
          amountUsd: new Prisma.Decimal(0),
          tokenUsageId: zeroTokenUsageId,
          policyVersion: 'gateway-settlement-v2',
          idempotencyKey: `gateway:financial:${zeroPrice.requestId}`,
          payload: { billingResult: { fundingOutcome: 'COLLECTED' } },
        },
      });
    });
    expect(await prisma.gatewayUsageFundingReservation.findUniqueOrThrow({
      where: { id: zeroPrice.reservationId },
      select: { status: true, authoritativeAmountUsd: true },
    })).toEqual({
      status: 'CONSUMED',
      authoritativeAmountUsd: new Prisma.Decimal(0),
    });
    expect(await prisma.balanceTransaction.count({
      where: { tokenUsageId: zeroTokenUsageId },
    })).toBe(0);
    expect(await prisma.balanceConsumptionAllocation.count({
      where: { tokenUsageId: zeroTokenUsageId },
    })).toBe(0);
    expect(await prisma.billingAccount.findUniqueOrThrow({
      where: { id: cleanZeroBase.billingAccountId },
      select: { balanceGrantLedgerStatus: true },
    })).toEqual({ balanceGrantLedgerStatus: 'RECONCILED_V2' });
  }, 60_000);
});
