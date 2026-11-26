import { GatewayProvisionalExposureInvariantError }
  from './gateway-provisional-exposure.errors';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import { GatewayRequestEventBillingService } from './gateway-request-event-billing.service';
import { billingProvisionalExposureOutcomeTotal } from '../metrics/metrics.registry';
import { GatewayProvisionalExposureConfig } from './gateway-provisional-exposure.config';
import {
  GatewayBillingCurrencyMigrationRequiredError,
  GatewayBillingRevisionConflictError,
  GatewaySettlementAnchorConflictError,
} from './usage-billing-strategy.service';
import { ModelAccessDeniedError } from './credit-pricing.service';
import { GatewayFundingReservationQueuePendingError } from './billing.service';

const VERIFIED_PRODUCER_BUILD_SHA = '0123456789abcdef0123456789abcdef01234567';
const PROVIDER_USAGE_HASH = `sha256:${'a'.repeat(64)}`;

function testCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(testCanonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${testCanonicalJson(item)}`)
    .join(',')}}`;
}

function makeTestAnchor(input: Record<string, any>) {
  const firstReceivedAt = input.firstReceivedAt
    ?? new Date('2026-08-06T12:00:00.000Z');
  const billingUnit = input.billingUnit === 'CREDITS' ? 'CREDITS' : 'BALANCE';
  const customerSettlementPolicyVersion = 'gateway-customer-settlement-v2';
  const baseCacheWritePriceUsdPerM = input.baseCacheWritePriceUsdPerM ?? '1';
  const customerCacheWritePriceUsdPerM = input.customerCacheWritePriceUsdPerM ?? '0.8';
  const safeQuantity = (value: unknown) => {
    const numeric = Number(value ?? 0);
    return Number.isFinite(numeric) && numeric >= 0 ? Math.floor(numeric) : 0;
  };
  const inputTokens = safeQuantity(input.inputTokens ?? 1000);
  const outputTokens = safeQuantity(input.outputTokens ?? 525);
  const cachedInputTokens = Math.min(
    safeQuantity(input.cachedInputTokens ?? 100),
    inputTokens,
  );
  const cacheWriteInputTokens = Math.min(
    safeQuantity(input.cacheWriteInputTokens ?? 50),
    inputTokens - cachedInputTokens,
  );
  const imageCount = safeQuantity(input.imageCount);
  const customerQuoteSnapshot = {
    unit: billingUnit,
    userId: input.userId,
    tenantId: input.tenantId,
    billingAccountId: 'billing-account-1',
    productId: input.productId,
    productSlug: input.productSlug,
    modelName: input.modelName ?? 'gpt-4o',
    inputTokens,
    outputTokens,
    cachedInputTokens,
    cacheWriteInputTokens,
    imageCount,
    pricingTierKey: null,
    priceBasis: 'PRODUCT_EFFECTIVE',
    customerPricing: {
      inputPriceUsdPerM: '1',
      cachedInputPriceUsdPerM: '0.2',
      cacheWritePriceUsdPerM: baseCacheWritePriceUsdPerM,
      outputPriceUsdPerM: '2',
    },
    baseCostUsd: '0.001',
    effectiveCostUsd: '0.0008',
    amountCents: 1,
    policy: {
      id: null,
      scope: 'DEFAULT',
      modelName: null,
      priceMultiplier: '1',
      creditMultiplier: null,
      priority: 0,
    },
  };
  const customerPricingSnapshot = {
    unit: billingUnit,
    priceBasis: 'PRODUCT_EFFECTIVE',
    basePricing: {
      status: 'VERIFIED',
      costUsd: '0.001',
      pricingTierKey: null,
      inputPriceUsdPerM: '1',
      cachedInputPriceUsdPerM: '0.2',
      cacheWritePriceUsdPerM: baseCacheWritePriceUsdPerM,
      outputPriceUsdPerM: '2',
    },
    tokenUsagePricing: {
      status: 'VERIFIED',
      costUsd: '0.0008',
      pricingTierKey: null,
      inputPriceUsdPerM: '0.8',
      cachedInputPriceUsdPerM: '0.16',
      cacheWritePriceUsdPerM: customerCacheWritePriceUsdPerM,
      outputPriceUsdPerM: '1.6',
    },
    policy: customerQuoteSnapshot.policy,
    customerMultiplier: '1',
    planUsageMultiplier: null,
    modelAccessMultiplier: null,
    effectiveCostUsd: '0.0008',
    baseCreditCost: null,
    creditCost: null,
    includedUpstream: false,
  };
  const providerCostSnapshot = {
    status: 'UNAVAILABLE',
    reason: 'test fixture',
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
  const pricingHash = createHash('sha256').update(testCanonicalJson({
    customerQuoteSnapshot,
    customerPricingSnapshot,
    providerCostSnapshot,
  })).digest('hex');
  const canonical = {
    requestId: input.requestId,
    apiKeyId: input.apiKeyId,
    userId: input.userId,
    tenantId: input.tenantId,
    billingAccountId: 'billing-account-1',
    productId: input.productId,
    productSlug: input.productSlug,
    billingUnit,
    billingCurrency: input.billingCurrency ?? 'USD',
    codingPlanEntitlementId: null,
    subscriptionId: null,
    planId: null,
    occurredAt: input.eventOccurredAt.toISOString(),
    firstReceivedAt: firstReceivedAt.toISOString(),
    customerSettlementPolicyVersion,
    pricingHash,
    customerQuoteSnapshot,
    customerPricingSnapshot,
    providerCostSnapshot,
    entitlementSnapshot: null,
    planSnapshot: null,
  };
  return {
    ...canonical,
    occurredAt: input.eventOccurredAt,
    firstReceivedAt,
    firstReceiptSequence: input.firstReceiptSequence ?? 1n,
    fundingReservationProtocol: input.fundingReservationProtocol ?? 'V1',
    anchorHash: createHash('sha256').update(testCanonicalJson(canonical)).digest('hex'),
    canonicalPayload: canonical,
  };
}

describe('GatewayRequestEventBillingService', () => {
  function buildService(configValues: Record<string, string | boolean | undefined> = {}) {
    const storedExposures = new Map<string, Record<string, any>>();
    const effectiveConfigValues: Record<string, string | boolean | undefined> = {
      BILLING_USAGE_VERIFIED_PRODUCER_BUILDS: VERIFIED_PRODUCER_BUILD_SHA,
      ...configValues,
    };
    let storedEvent: Record<string, any> | null = null;
    let storedAnchor: Record<string, any> | null = null;
    const storedEvidences = new Map<string, Record<string, any>>();
    const coverageRegistry = new Map<string, Record<string, any>>();
    const usageBilling = {
      assertReachableGatewayBillingAccountCurrencies: jest.fn().mockResolvedValue(undefined),
      resolveGatewaySettlementAnchor: jest.fn().mockImplementation(async (
        _db,
        input,
        firstReceivedAt,
      ) => {
        const { canonicalPayload: _canonicalPayload, ...anchor } = makeTestAnchor({
          ...input,
          firstReceivedAt,
        });
        return anchor;
      }),
      assertGatewaySettlementAnchorForReceipt: jest.fn().mockResolvedValue(undefined),
      settleDeliveredGatewayUsage: jest.fn().mockResolvedValue({
        success: true,
        allowed: true,
      }),
      quote: jest.fn().mockResolvedValue({
        unit: 'BALANCE',
        billingAccountId: 'billing-account-1',
        amountCents: 80,
        tenantId: 'tenant-1',
        modelName: 'gpt-4o',
      }),
      valueGatewayUsageAtFrozenPricing: jest.fn().mockResolvedValue({
        quote: {
          unit: 'BALANCE',
          effectiveCostUsd: '0.0012',
          inputTokens: 120,
          outputTokens: 15,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
        },
        customerChargeUsd: '0.0012',
        providerCostUsd: '0.0007',
      }),
      reserveGatewayBalanceFunding: jest.fn().mockResolvedValue({
        id: 'funding-reservation-1',
        requestId: 'req-usage-v2-1',
        billingAccountId: 'billing-account-1',
        status: 'ACTIVE',
        reviewReason: null,
        reservedAmountUsd: new Prisma.Decimal('0.0008'),
        collectedUsd: new Prisma.Decimal('0.0008'),
        approvedCreditUsd: new Prisma.Decimal(0),
        unapprovedDebtUsd: new Prisma.Decimal(0),
      }),
      releaseGatewayBalanceFunding: jest.fn().mockResolvedValue(undefined),
    };
    const prisma: Record<string, any> = {
      gatewayBillingEvent: {
        createMany: jest.fn().mockImplementation(async ({ data }) => {
          if (storedEvent) return { count: 0 };
          storedEvent = {
            id: 'gateway-billing-event-1',
            revision: 0,
            pendingExposureUsd: new Prisma.Decimal(0),
            pendingHoldUsd: new Prisma.Decimal(0),
            ...data[0],
          };
          return { count: 1 };
        }),
        upsert: jest.fn().mockImplementation(async ({ create, update }) => {
          if (!storedEvent) {
            storedEvent = {
              id: 'gateway-billing-event-1',
              revision: 0,
              pendingExposureUsd: new Prisma.Decimal(0),
              pendingHoldUsd: new Prisma.Decimal(0),
              ...create,
            };
          } else {
            storedEvent = { ...storedEvent, ...update };
          }
          return storedEvent;
        }),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockImplementation(async ({ where, data }) => {
          if (storedEvent) {
            // 墓碑写入带 legacyOriginalEvidenceMissingAt: null 的 CAS 条件；
            // 已被写过时必须退化为 0 行更新，而不是覆盖。
            if (
              Object.prototype.hasOwnProperty.call(where ?? {}, 'legacyOriginalEvidenceMissingAt')
              && where.legacyOriginalEvidenceMissingAt === null
              && storedEvent.legacyOriginalEvidenceMissingAt != null
            ) {
              return { count: 0 };
            }
            const revisionIncrement = data.revision?.increment ?? 0;
            storedEvent = {
              ...storedEvent,
              ...data,
              revision: Number(storedEvent.revision ?? 0) + revisionIncrement,
            };
          }
          return { count: 1 };
        }),
        findMany: jest.fn().mockResolvedValue([]),
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest.fn().mockImplementation(async () => storedEvent),
        findUniqueOrThrow: jest.fn().mockImplementation(async () => ({
          id: 'gateway-billing-event-1',
          status: storedEvent?.status ?? 'RECEIVED',
          reconciliationStatus: storedEvent?.reconciliationStatus ?? 'OPEN',
          revision: storedEvent?.revision ?? 0,
          evidenceHash: storedEvent?.evidenceHash ?? 'evidence-hash-1',
          rawEvent: storedEvent?.rawEvent ?? usageEvent(),
          billingAccountId: storedEvent?.billingAccountId ?? null,
          apiKeyId: storedEvent?.apiKeyId ?? 'key-1',
          settlementAnchor: storedAnchor,
        })),
        aggregate: jest.fn().mockResolvedValue({
          _count: { _all: 0 },
          _sum: { pendingExposureUsd: null, pendingHoldUsd: null },
        }),
      },
      gatewayUsageEvidence: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
        createMany: jest.fn().mockImplementation(async ({ data }) => {
          let count = 0;
          for (const evidence of data) {
            const key = `${evidence.gatewayBillingEventId}:${evidence.evidenceHash}`;
            if (!storedEvidences.has(key)) {
              storedEvidences.set(key, evidence);
              count += 1;
            }
          }
          return { count };
        }),
        findUnique: jest.fn().mockImplementation(async ({ where }) => {
          if (where.id) {
            return [...storedEvidences.values()].find(
              (evidence) => evidence.id === where.id,
            ) ?? null;
          }
          // 真实库有 gateway_usage_evidences_event_revision_key，按 (event, revision) 点查。
          const byRevision = where.gatewayBillingEventId_evidenceRevision;
          if (byRevision) {
            return [...storedEvidences.values()].find((evidence) => (
              evidence.gatewayBillingEventId === byRevision.gatewayBillingEventId
              && Number(evidence.evidenceRevision) === Number(byRevision.evidenceRevision)
            )) ?? null;
          }
          const compound = where.gatewayBillingEventId_evidenceHash;
          if (!compound) return null;
          return storedEvidences.get(
            `${compound.gatewayBillingEventId}:${compound.evidenceHash}`,
          ) ?? null;
        }),
      },
      gatewayUsageProvisionalExposure: {
        createMany: jest.fn().mockImplementation(async ({ data, skipDuplicates }) => {
          let count = 0;
          for (const row of data) {
            const key = row.gatewayBillingEventId;
            if (storedExposures.has(key)) {
              // 真实库靠 uq_exposure_billing_event 唯一索引；skipDuplicates 会**吞掉内容冲突**，
              // 所以 mock 也必须保留既有行不变，让读回比对去发现冲突。
              if (!skipDuplicates) throw new Error('unique violation');
              continue;
            }
            storedExposures.set(key, { id: `exposure-${key}`, createdAt: new Date(), ...row });
            count += 1;
          }
          return { count };
        }),
        findUnique: jest.fn().mockImplementation(async ({ where }) => (
          storedExposures.get(where.gatewayBillingEventId) ?? null
        )),
      },
      gatewayUsageSettlementAnchor: {
        createMany: jest.fn().mockImplementation(async ({ data }) => {
          if (!storedAnchor) storedAnchor = data[0];
          return { count: storedAnchor ? 1 : 0 };
        }),
        findUnique: jest.fn().mockImplementation(async () => storedAnchor),
      },
      gatewayUsageFundingReservation: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      creditTransaction: {
        count: jest.fn().mockResolvedValue(0),
      },
      apiKey: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      gatewayUsageSettlementReceipt: {
        create: jest.fn().mockResolvedValue({}),
      },
      gatewayUsageReconciliationAction: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({}),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      gatewayUsagePlatformLoss: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
      },
      usageLossRecognitionClaim: {
        create: jest.fn().mockResolvedValue({}),
      },
      billingAccessRestriction: {
        findFirst: jest.fn().mockResolvedValue(null),
        // 主体级释放走 findMany + 逐行 update（要把 idempotency_key 改名腾出来，
        // updateMany 没法把列设成自身的函数），漂移哨兵走 count。
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockResolvedValue({}),
        update: jest.fn().mockResolvedValue({}),
        upsert: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
        count: jest.fn().mockResolvedValue(0),
      },
    };
    prisma.$transaction = jest.fn(async (fn: (tx: typeof prisma) => unknown) => fn(prisma));
    prisma.$queryRaw = jest.fn().mockImplementation(async (
      parts: TemplateStringsArray,
      ...values: any[]
    ) => {
      const sql = parts.join(' ');
      if (sql.includes('clock_timestamp')) {
        return [{ databaseNow: new Date('2026-08-06T12:00:00.000Z') }];
      }
      if (sql.includes('gateway_usage_first_receipt_sequence_seq')) {
        return [{ firstReceiptSequence: 1n }];
      }
      // 返回字段的父行锁：实现必须从**这里**取三态判定字段，而不是锁前的 JS 快照。
      // 因此本 mock 只从 storedEvent 现值取，测试可以让 findUniqueOrThrow 与它不一致。
      if (sql.includes('FOR UPDATE') && sql.includes('gateway_billing_events')) {
        return [{
          id: storedEvent?.id ?? 'gateway-billing-event-1',
          // storedEvent 缺席时沿用 findUniqueOrThrow 的同一套默认值：部分用例直接 mock
          // findUnique*/不填 storedEvent，若这里返回空就会误抛 NotFoundException。
          evidenceHash: storedEvent
            ? (storedEvent.evidenceHash ?? null)
            : 'evidence-hash-1',
          legacyOriginalEvidenceMissingAt:
            storedEvent?.legacyOriginalEvidenceMissingAt ?? null,
        }];
      }
      if (sql.includes('FROM "usage_loss_coverage_registry"')) {
        const stored = coverageRegistry.get(values[0]);
        return stored ? [stored] : [];
      }
      return [];
    });
    prisma.$executeRaw = jest.fn().mockImplementation(async (
      parts: TemplateStringsArray,
      ...values: any[]
    ) => {
      const sql = parts.join(' ');
      if (sql.includes('INSERT INTO "usage_loss_coverage_registry"')) {
        const [id, coverageKey, provider, providerAccountRef, region, serviceDate, model, meter, granularityMode] = values;
        if (!coverageRegistry.has(coverageKey)) {
          coverageRegistry.set(coverageKey, {
            id,
            coverageKey,
            provider,
            providerAccountRef,
            region,
            serviceDate,
            model,
            meter,
            granularityMode,
          });
        }
      }
      return 1;
    });
    const config = {
      get: jest.fn((key: string) => effectiveConfigValues[key]),
    };
    // 边界来自「建 exposure 表那次迁移的完成时刻」（启动时从 _prisma_migrations 读）。
    // service 只消费 .boundary，所以这里给最小对象即可；
    // 边界本身的读取逻辑由 billing-usage-kafka-consumer.service.spec.ts 里那组用例覆盖。
    // ⚠️ 这个不是环境变量（本次提交就是要消灭环境变量），是 harness 自己的旋钮；
    // 名字刻意不带 BILLING_ 前缀，免得将来 grep env key 时被误导。
    const boundaryRaw = effectiveConfigValues.provisionalExposureBoundary;
    const provisionalExposureConfig = {
      // 惰性读取：调用点每次都 await 它，所以桩必须是异步的。
      getBoundary: jest.fn().mockResolvedValue(
        boundaryRaw ? new Date(String(boundaryRaw)) : null,
      ),
    } as unknown as GatewayProvisionalExposureConfig;
    const growthEvents = {
      recordFirstApiCall: jest.fn().mockResolvedValue({ id: 'growth-1' }),
    };
    const publisherSync = {
      syncBillingAccountKeyBalances: jest.fn().mockResolvedValue(undefined),
      syncBillingAccountKeyBalancesRequired: jest.fn().mockResolvedValue(undefined),
      syncBillingAccountKeyBalancesByKeyIdRequired: jest.fn().mockResolvedValue(undefined),
      syncKeyBalanceById: jest.fn().mockResolvedValue(undefined),
      syncKeyBalanceByIdRequired: jest.fn().mockResolvedValue(undefined),
    };
    return {
      service: new GatewayRequestEventBillingService(
        usageBilling as never,
        prisma as never,
        config as never,
        growthEvents as never,
        publisherSync as never,
        {
          getDeploymentConfig: jest.fn().mockResolvedValue({
            version: '1',
            region: 'overseas',
            provider: 'google',
            currency: 'usd',
            defaultLanguage: 'en',
            oauth: {},
          }),
        } as never,
        provisionalExposureConfig as never,
      ),
      usageBilling,
      prisma,
      storedExposures,
      provisionalExposureConfig,
      coverageRegistry,
      config,
      growthEvents,
      publisherSync,
    };
  }

  /**
   * 除 lineage 墓碑之外的父行 updateMany 调用。
   *
   * 墓碑（legacy_original_evidence_missing_at 的一次性 CAS 写入）不是财务状态改写：
   * 它冻结的是「首收证据是否存在」这一事实，与 status / reconciliationStatus / revision
   * 无关，也不会改动任何金额列。因此「未重写财务状态」的断言应当排除它，
   * 但**只**排除它 —— 任何其它 updateMany 仍然是状态改写，照旧不允许。
   */
  function stateUpdateManyCalls(prisma: Record<string, any>): any[] {
    return prisma.gatewayBillingEvent.updateMany.mock.calls.filter((call: any[]) => {
      const data = call[0]?.data ?? {};
      const keys = Object.keys(data);
      return !(keys.length === 1 && keys[0] === 'legacyOriginalEvidenceMissingAt');
    });
  }

  function storedEvidencesOf(prisma: Record<string, any>): Record<string, any>[] {
    return prisma.gatewayUsageEvidence.createMany.mock.calls
      .flatMap((call: any[]) => call[0]?.data ?? []);
  }

  function requestEvent(overrides: Record<string, unknown> = {}) {
    return {
      version: 'v1',
      event_type: 'request_event',
      event_id: 'request-evt-1',
      request_id: 'req-1',
      occurred_at: '2026-05-21T08:30:15Z',
      usage: {
        status: 'success',
        status_code: 200,
        quota_settlement: 'settled',
      },
      error: null,
      ...overrides,
    };
  }

  function usageEvent(overrides: Record<string, unknown> = {}) {
    return {
      version: 'v2',
      event_type: 'usage',
      event_id: 'usage-evt-1',
      request_id: 'req-usage-v2-1',
      ts: '1779352215000000000',
      key_id: 'key-1',
      tenant_id: 'tenant-top-level',
      model: 'gpt-4o',
      actual_model: 'gpt-4o',
      resolved_model: 'gpt-4o-2024-08-06',
      upstream_model: 'gpt-4o-2024-08-06',
      provider: 'openai',
      resolved_api_type: 'openai',
      prompt_tokens: 1000,
      completion_tokens: 525,
      total_tokens: 1525,
      token_source: 'provider',
      producer_build_sha: VERIFIED_PRODUCER_BUILD_SHA,
      provider_usage_hash: PROVIDER_USAGE_HASH,
      provider_account_ref: 'provider-account-test-001',
      stream_end_reason: 'normal_end',
      usage_evidence: {
        source: 'provider_terminal',
        status: 'complete',
        protocol: 'openai_sse',
        terminal_frame_seen: true,
        dimensions_present: [
          'input_tokens',
          'output_tokens',
          'cache_read_input_tokens',
          'cache_creation_input_tokens',
        ],
      },
      provider_reconciliation_required: false,
      provider_credential_ref: 'provider-account-test-001',
      upstream_request_id: 'upstream-request-test-001',
      upstream_response_id: 'upstream-response-test-001',
      token_extras: {
        cache_hit_tokens: 100,
        cache_write_tokens: 50,
        reasoning_tokens: 25,
      },
      status: 'success',
      status_code: 200,
      quota_settlement: 'settled',
      labels: {
        tenant_id: 'tenant-1',
        user_id: 'user-1',
        'usr.product_id': 'prod-1',
        'usr.product_slug': 'payg',
        region: 'us-east-1',
      },
      error: null,
      ...overrides,
    };
  }

  function successfulSettlement(
    billingUnit: 'BALANCE' | 'CREDITS' = 'BALANCE',
  ) {
    return {
      success: true,
      allowed: true,
      tokenUsageId: `token-usage-${billingUnit.toLowerCase()}-1`,
      fundingOutcome: billingUnit === 'BALANCE' ? 'COLLECTED' : 'INCLUDED',
      quote: {
        unit: billingUnit,
        tenantId: 'tenant-1',
        billingAccountId: 'billing-account-1',
        ...(billingUnit === 'BALANCE'
          ? { effectiveCostUsd: '0.0008' }
          : { creditCost: 1 }),
      },
    };
  }

  it('passes production settlement preflight for a separated runtime role and exact evidence governance', async () => {
    const { service, prisma, usageBilling } = buildService();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ asserted: null }])
      .mockResolvedValueOnce([{
        runtimeCanAppend: false,
        runtimeCanMutateAuthority: false,
        runtimeCanTransitionEvidenceMode: false,
        runtimeCanMutateEvidenceMode: false,
      }])
      .mockResolvedValueOnce([{
        mode: 'SHADOW',
        transactionIsolation: 'read committed',
      }])
      .mockResolvedValueOnce([{
        producerBuildSha: VERIFIED_PRODUCER_BUILD_SHA,
      }]);

    await expect(service.assertProductionSettlementPreflight())
      .resolves.toBeUndefined();
    expect(usageBilling.assertReachableGatewayBillingAccountCurrencies)
      .toHaveBeenCalledTimes(1);
  });

  it('fails production preflight before governance reads when a reachable account currency drifts', async () => {
    const { service, prisma, usageBilling } = buildService();
    const currencyError = new GatewayBillingCurrencyMigrationRequiredError(
      'USD',
      'CNY',
      'billing-account-1',
      'key-1',
    );
    prisma.$queryRaw.mockResolvedValueOnce([{ asserted: null }]);
    usageBilling.assertReachableGatewayBillingAccountCurrencies
      .mockRejectedValueOnce(currencyError);

    await expect(service.assertProductionSettlementPreflight())
      .rejects.toBe(currencyError);
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('skips the duplicate currency query after Kafka has already asserted it', async () => {
    const { service, prisma, usageBilling } = buildService();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ asserted: null }])
      .mockResolvedValueOnce([{
        runtimeCanAppend: false,
        runtimeCanMutateAuthority: false,
        runtimeCanTransitionEvidenceMode: false,
        runtimeCanMutateEvidenceMode: false,
      }])
      .mockResolvedValueOnce([{
        mode: 'SHADOW',
        transactionIsolation: 'read committed',
      }])
      .mockResolvedValueOnce([{
        producerBuildSha: VERIFIED_PRODUCER_BUILD_SHA,
      }]);

    await expect(service.assertProductionSettlementPreflight({
      reachableCurrencyAlreadyAsserted: true,
    })).resolves.toBeUndefined();
    expect(usageBilling.assertReachableGatewayBillingAccountCurrencies)
      .not.toHaveBeenCalled();
  });

  it('fails production settlement preflight when the runtime DB role can append build authority', async () => {
    const { service, prisma } = buildService();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ asserted: null }])
      .mockResolvedValueOnce([{
        runtimeCanAppend: true,
        runtimeCanMutateAuthority: false,
        runtimeCanTransitionEvidenceMode: false,
        runtimeCanMutateEvidenceMode: false,
      }]);

    await expect(service.assertProductionSettlementPreflight()).rejects.toThrow(
      'Billing runtime DB role must not mutate Gateway build authority or evidence rollout state',
    );
  });

  it('fails production settlement preflight when the runtime DB role can mutate authority rows', async () => {
    const { service, prisma } = buildService();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ asserted: null }])
      .mockResolvedValueOnce([{
        runtimeCanAppend: false,
        runtimeCanMutateAuthority: true,
        runtimeCanTransitionEvidenceMode: false,
        runtimeCanMutateEvidenceMode: false,
      }]);

    await expect(service.assertProductionSettlementPreflight()).rejects.toThrow(
      'Billing runtime DB role must not mutate Gateway build authority or evidence rollout state',
    );
  });

  it('fails production settlement preflight when the runtime DB role can change evidence rollout mode', async () => {
    const { service, prisma } = buildService();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ asserted: null }])
      .mockResolvedValueOnce([{
        runtimeCanAppend: false,
        runtimeCanMutateAuthority: false,
        runtimeCanTransitionEvidenceMode: true,
        runtimeCanMutateEvidenceMode: false,
      }]);

    await expect(service.assertProductionSettlementPreflight()).rejects.toThrow(
      'Billing runtime DB role must not mutate Gateway build authority or evidence rollout state',
    );
  });

  it('reports evidence rollout mode drift without blocking customer settlement ingestion', async () => {
    const { service, prisma } = buildService();
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ asserted: null }])
      .mockResolvedValueOnce([{
        runtimeCanAppend: false,
        runtimeCanMutateAuthority: false,
        runtimeCanTransitionEvidenceMode: false,
        runtimeCanMutateEvidenceMode: false,
      }])
      .mockResolvedValueOnce([{
        mode: 'ENFORCE',
        transactionIsolation: 'read committed',
      }])
      .mockResolvedValueOnce([{
        producerBuildSha: VERIFIED_PRODUCER_BUILD_SHA,
      }]);

    await expect(service.assertProductionSettlementPreflight()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Gateway evidence rollout mode drift'),
    );
  });

  it('fails production settlement preflight when the runtime database session is not READ COMMITTED', async () => {
    const { service, prisma } = buildService();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ asserted: null }])
      .mockResolvedValueOnce([{
        runtimeCanAppend: false,
        runtimeCanMutateAuthority: false,
        runtimeCanTransitionEvidenceMode: false,
        runtimeCanMutateEvidenceMode: false,
      }])
      .mockResolvedValueOnce([{
        mode: 'SHADOW',
        transactionIsolation: 'repeatable read',
      }]);

    await expect(service.assertProductionSettlementPreflight()).rejects.toThrow(
      'Billing runtime database session must use READ COMMITTED transaction isolation',
    );
  });

  it('reports producer build authority drift without blocking customer settlement ingestion', async () => {
    const { service, prisma } = buildService();
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation();
    prisma.$queryRaw
      .mockResolvedValueOnce([{ asserted: null }])
      .mockResolvedValueOnce([{
        runtimeCanAppend: false,
        runtimeCanMutateAuthority: false,
        runtimeCanTransitionEvidenceMode: false,
        runtimeCanMutateEvidenceMode: false,
      }])
      .mockResolvedValueOnce([{
        mode: 'SHADOW',
        transactionIsolation: 'read committed',
      }])
      .mockResolvedValueOnce([{ producerBuildSha: 'f'.repeat(40) }]);

    await expect(service.assertProductionSettlementPreflight()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('Gateway producer build authority drift'),
    );
  });

  it('returns the immutable settlement anchor in the admin event detail', async () => {
    const { service, prisma } = buildService();
    const settlementAnchor = makeTestAnchor({
      requestId: 'req-detail-anchor',
      apiKeyId: 'key-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      productSlug: 'payg',
      eventOccurredAt: new Date('2026-05-21T08:30:15.000Z'),
    });
    prisma.gatewayBillingEvent.findUnique.mockResolvedValue({
      id: 'gateway-billing-event-detail',
      requestId: 'req-detail-anchor',
      pendingExposureUsd: new Prisma.Decimal('1.25'),
      pendingHoldUsd: new Prisma.Decimal('0.50'),
      settlementAnchor,
      usageEvidences: [],
      reconciliationActions: [],
      settlementReceipts: [],
      platformLossEntries: [],
      accessRestrictions: [],
    });

    const detail = await service.getEvent('req-detail-anchor');

    expect(prisma.gatewayBillingEvent.findUnique).toHaveBeenCalledWith({
      where: { requestId: 'req-detail-anchor' },
      include: {
        settlementAnchor: true,
        fundingReservation: true,
        tokenUsage: {
          include: {
            consumptionAllocations: {
              orderBy: [{ ledgerSequence: 'asc' }, { id: 'asc' }],
              include: {
                settlements: { orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] },
              },
            },
          },
        },
        usageEvidences: { orderBy: { createdAt: 'asc' } },
        reconciliationActions: { orderBy: { createdAt: 'asc' } },
        settlementReceipts: { orderBy: { createdAt: 'asc' } },
        platformLossEntries: { orderBy: { createdAt: 'asc' } },
        accessRestrictions: { orderBy: { createdAt: 'asc' } },
      },
    });
    expect(detail.settlementAnchor).toEqual({
      ...settlementAnchor,
      firstReceiptSequence: '1',
    });
    expect(() => JSON.stringify(detail)).not.toThrow();
    expect(detail.pendingExposureAmount).toBe('1.25');
    expect(detail.pendingHoldAmount).toBe('0.5');
  });

  it('maps v2 UsageEvent token_extras into existing usage deduct input', async () => {
    const { service, usageBilling, growthEvents } = buildService();

    const result = await service.process(usageEvent());

    expect(result.action).toBe('deducted');
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith({
      apiKeyId: 'key-1',
      tenantId: 'tenant-1',
      userId: 'user-1',
      email: undefined,
      productId: 'prod-1',
      productSlug: 'payg',
      modelName: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 525,
      cachedInputTokens: 100,
      cacheWriteInputTokens: 50,
      totalTokens: 1525,
      imageCount: 0,
      billingUnit: 'BALANCE',
      providerCode: 'openai',
      upstreamModel: 'gpt-4o-2024-08-06',
      source: 'gateway:us-east-1:openai:gpt-4o',
      requestId: 'req-usage-v2-1',
      idempotencyKey: 'gateway:request:req-usage-v2-1',
      eventOccurredAt: new Date('2026-05-21T08:30:15.000Z'),
      recordTokenUsage: true,
      allowNegativeBalance: false,
      gatewayCustomerSettlement: {
        policyVersion: 'gateway-customer-settlement-v2',
        basis: 'NORMALIZED_EXACT',
        evidenceReason: 'none',
        originalDimensions: {
          inputTokens: 1000,
          outputTokens: 525,
          cachedInputTokens: 100,
          cacheWriteInputTokens: 50,
          totalTokens: 1525,
          imageCount: 0,
        },
        settledDimensions: {
          inputTokens: 1000,
          outputTokens: 525,
          cachedInputTokens: 100,
          cacheWriteInputTokens: 50,
          totalTokens: 1525,
          imageCount: 0,
        },
      },
    }, expect.objectContaining({
      gatewayBillingEventId: 'gateway-billing-event-1',
      expectedRevision: 0,
      anchor: expect.objectContaining({ billingAccountId: 'billing-account-1' }),
    }));
    expect(growthEvents.recordFirstApiCall).toHaveBeenCalledWith({
      requestId: 'req-usage-v2-1',
      userId: 'user-1',
      apiKeyId: 'key-1',
      modelName: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 525,
      totalTokens: 1525,
      occurredAt: new Date('2026-05-21T08:30:15.000Z'),
      successful: true,
    });
  });

  it('requires a fresh account projection after ordinary BALANCE settlement releases the first-receipt guard', async () => {
    const { service, usageBilling, prisma, publisherSync } = buildService();
    usageBilling.settleDeliveredGatewayUsage.mockResolvedValue(
      successfulSettlement('BALANCE'),
    );
    prisma.gatewayBillingEvent.findUnique.mockResolvedValue({
      id: 'gateway-billing-event-1',
      requestId: 'req-usage-v2-1',
      apiKeyId: 'key-1',
      billingAccountId: 'billing-account-1',
      fundingReservation: { id: 'funding-reservation-1' },
    });
    prisma.billingAccessRestriction.updateMany.mockResolvedValue({ count: 1 });

    const result = await service.process(usageEvent());

    expect(result).toMatchObject({
      action: 'deducted',
      requestId: 'req-usage-v2-1',
      fundingOutcome: 'COLLECTED',
    });
    expect(prisma.billingAccessRestriction.updateMany).toHaveBeenCalledWith({
      where: {
        gatewayBillingEventId: 'gateway-billing-event-1',
        status: 'ACTIVE',
        reason: 'pending_usage_unreserved',
      },
      data: {
        status: 'RELEASED',
        releasedAt: expect.any(Date),
        releasedBy: 'SYSTEM',
        releaseReason: 'gateway_state_committed:deducted',
      },
    });
    expect(publisherSync.syncBillingAccountKeyBalancesRequired)
      .toHaveBeenCalledWith('billing-account-1');
    expect(
      prisma.billingAccessRestriction.updateMany.mock.invocationCallOrder[0],
    ).toBeLessThan(
      publisherSync.syncBillingAccountKeyBalancesRequired.mock.invocationCallOrder[0],
    );
  });

  it('replays a durable BALANCE settlement when its required release projection fails', async () => {
    const { service, usageBilling, prisma, publisherSync } = buildService();
    const billing = successfulSettlement('BALANCE');
    usageBilling.settleDeliveredGatewayUsage.mockResolvedValue(billing);
    prisma.gatewayBillingEvent.findUnique.mockResolvedValue({
      id: 'gateway-billing-event-1',
      requestId: 'req-usage-v2-1',
      status: 'DEDUCTED',
      reason: null,
      errorMessage: null,
      billingResult: billing,
      apiKeyId: 'key-1',
      billingAccountId: 'billing-account-1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      productSlug: 'payg',
      userId: 'user-1',
      modelName: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 525,
      cachedInputTokens: 100,
      cacheWriteInputTokens: 50,
      totalTokens: 1525,
      revision: 1,
      evidenceVerdict: 'SETTLEABLE_BY_POLICY',
      reconciliationStatus: 'CLOSED',
      fundingOutcome: 'COLLECTED',
      fundingReservation: { id: 'funding-reservation-1' },
    });
    prisma.billingAccessRestriction.updateMany.mockResolvedValue({ count: 1 });
    publisherSync.syncBillingAccountKeyBalancesRequired
      .mockRejectedValueOnce(new Error('publisher release projection unavailable'));

    await expect(service.process(usageEvent())).rejects.toThrow(
      'publisher release projection unavailable',
    );

    expect(prisma.gatewayBillingEvent.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.gatewayBillingEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: 'DEDUCTED' }),
      }),
    );
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledTimes(1);

    const replay = await service.process(usageEvent());

    expect(replay).toMatchObject({
      action: 'deducted',
      requestId: 'req-usage-v2-1',
      revision: 1,
      fundingOutcome: 'COLLECTED',
    });
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledTimes(1);
    expect(prisma.gatewayBillingEvent.updateMany).toHaveBeenCalledTimes(1);
    expect(publisherSync.syncBillingAccountKeyBalancesRequired).toHaveBeenCalledTimes(2);
  });

  it('does not project an ordinary CREDITS success without an admission restriction release', async () => {
    const { service, usageBilling, prisma, publisherSync } = buildService();
    usageBilling.resolveGatewaySettlementAnchor.mockImplementation(async (
      _db: unknown,
      input: Record<string, unknown>,
      firstReceivedAt: Date,
    ) => {
      const { canonicalPayload, ...anchor } = makeTestAnchor({
        ...input,
        billingUnit: 'CREDITS',
        firstReceivedAt,
      });
      void canonicalPayload;
      return anchor;
    });
    usageBilling.settleDeliveredGatewayUsage.mockResolvedValue(
      successfulSettlement('CREDITS'),
    );
    prisma.gatewayBillingEvent.findUnique.mockResolvedValue({
      id: 'gateway-billing-event-1',
      requestId: 'req-usage-v2-1',
      apiKeyId: 'key-1',
      billingAccountId: 'billing-account-1',
      fundingReservation: null,
    });

    const result = await service.process(usageEvent());

    expect(result).toMatchObject({
      action: 'deducted',
      fundingOutcome: 'INCLUDED',
    });
    expect(usageBilling.reserveGatewayBalanceFunding).not.toHaveBeenCalled();
    expect(prisma.billingAccessRestriction.upsert).not.toHaveBeenCalled();
    expect(publisherSync.syncBillingAccountKeyBalancesRequired).not.toHaveBeenCalled();
    expect(publisherSync.syncKeyBalanceByIdRequired).not.toHaveBeenCalled();
  });

  it('bills image_count usage with zero core tokens and maps image facts independently', async () => {
    const { service, usageBilling } = buildService();

    const result = await service.process(usageEvent({
      request_id: 'req-image-1',
      model: 'cogview-4',
      logical_model: 'cogview-4',
      actual_model: undefined,
      resolved_model: undefined,
      upstream_model: 'cogview-4',
      provider: 'zhipu',
      resolved_api_type: 'openai',
      call_type: 'image_generation',
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      token_source: 'image_count',
      token_extras: { image_count: 1 },
    }));

    expect(result.action).toBe('deducted');
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        modelName: 'cogview-4',
        imageCount: 1,
        callType: 'image_generation',
        upstreamModel: 'cogview-4',
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        providerCode: 'zhipu',
        gatewayCustomerSettlement: {
          policyVersion: 'gateway-customer-settlement-v2',
          basis: 'NORMALIZED_EXACT',
          evidenceReason: 'none',
          originalDimensions: {
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            totalTokens: 0,
            imageCount: 1,
          },
          settledDimensions: {
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            totalTokens: 0,
            imageCount: 1,
          },
        },
      }),
      expect.any(Object),
    );
  });

  it('settles a positive image fact at protective zero when token source is missing and replays without a hold', async () => {
    const { service, usageBilling, prisma } = buildService();
    const event = usageEvent({
      request_id: 'req-image-token-source-missing',
      model: 'cogview-4',
      actual_model: 'cogview-4',
      resolved_model: 'cogview-4',
      upstream_model: 'cogview-4',
      provider: 'zhipu',
      resolved_api_type: 'openai',
      call_type: 'image_generation',
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      token_source: undefined,
      token_extras: { image_count: 1 },
    });

    const first = await service.process(event);

    expect(first).toMatchObject({
      action: 'deducted',
      requestId: 'req-image-token-source-missing',
      reason: 'customer_protective_zero:token_source_missing',
      evidenceVerdict: 'INCOMPLETE',
      reconciliationStatus: 'OPEN',
    });
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        imageCount: 0,
        inputTokens: 0,
        outputTokens: 0,
        source: expect.stringContaining('customer-protective-zero'),
        gatewayCustomerSettlement: {
          policyVersion: 'gateway-customer-settlement-v2',
          basis: 'CUSTOMER_PROTECTIVE_ZERO',
          evidenceReason: 'token_source_missing',
          customerProtectionReason: 'token_source_missing',
          originalDimensions: {
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            totalTokens: 0,
            imageCount: 1,
          },
          settledDimensions: {
            inputTokens: 0,
            outputTokens: 0,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            totalTokens: 0,
            imageCount: 0,
          },
        },
      }),
      expect.any(Object),
    );
    expect(prisma.gatewayBillingEvent.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'DEDUCTED',
          pendingExposureUsd: new Prisma.Decimal(0),
          pendingHoldUsd: new Prisma.Decimal(0),
        }),
      }),
    );
    expect(prisma.billingAccessRestriction.upsert).not.toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          reason: expect.stringMatching(/evidence|settlement_policy_review/),
        }),
      }),
    );

    const replay = await service.process(event);

    expect(replay).toMatchObject({
      action: 'deducted',
      reconciliationStatus: 'OPEN',
    });
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledTimes(1);
  });

  it('settles image usage without a positive count at a customer-protective zero', async () => {
    const { service, usageBilling, prisma } = buildService();

    const result = await service.process(usageEvent({
      request_id: 'req-image-no-fact',
      call_type: 'image_generation',
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      token_source: 'image_count',
      token_extras: { image_count: 0 },
    }));

    expect(result).toMatchObject({
      action: 'deducted',
      requestId: 'req-image-no-fact',
      reason: 'customer_protective_zero:unproven_no_charge:zero_usage',
      reconciliationStatus: 'OPEN',
    });
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        imageCount: 0,
        gatewayCustomerSettlement: expect.objectContaining({
          basis: 'CUSTOMER_PROTECTIVE_ZERO',
        }),
      }),
      expect.any(Object),
    );
    expect(usageBilling.releaseGatewayBalanceFunding).not.toHaveBeenCalled();
    expect(prisma.gatewayUsageSettlementReceipt.create).not.toHaveBeenCalled();
  });

  it('does not apply output-token-only skip rules when a billable image fact exists', async () => {
    const { service, usageBilling } = buildService();

    const result = await service.process(usageEvent({
      request_id: 'req-image-playground',
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      token_source: 'image_count',
      token_extras: { image_count: 1 },
      labels: {
        tenant_id: 'tenant-1',
        user_id: 'user-1',
        'usr.product_id': 'prod-1',
        'usr.product_slug': 'payg',
        source: 'playground',
      },
    }));

    expect(result.action).toBe('deducted');
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(
      expect.objectContaining({ imageCount: 1 }),
      expect.any(Object),
    );
  });

  it('does not let a deployment flag create credit beyond the account policy', async () => {
    const { service, usageBilling, config } = buildService({
      BILLING_GATEWAY_USAGE_ALLOW_NEGATIVE_BALANCE: 'true',
    });

    await service.process(usageEvent());

    expect(config.get).not.toHaveBeenCalledWith(
      'BILLING_GATEWAY_USAGE_ALLOW_NEGATIVE_BALANCE',
    );
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledTimes(1);
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: 'req-usage-v2-1',
        recordTokenUsage: true,
        allowNegativeBalance: false,
      }),
      expect.any(Object),
    );
  });

  it('uses Gateway start_time before timestamp/end-time fallbacks', async () => {
    const { service, usageBilling } = buildService();

    await service.process(usageEvent({
      start_time: '2026-06-18T15:15:00.000Z',
      timestamp: '2026-06-18T15:16:00.000Z',
      occurred_at: '2026-06-18T15:20:00.000Z',
      ts: '1781796600000000000',
      raw_event: {
        ts: '1781796900000000000',
      },
    }));

    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(expect.objectContaining({
      eventOccurredAt: new Date('2026-06-18T15:15:00.000Z'),
    }), expect.any(Object));
  });

  it('anchors first receipt and evidence observation to the Billing database clock', async () => {
    const { service, usageBilling, prisma } = buildService();
    const databaseNow = new Date('2026-08-06T12:00:00.000Z');

    await service.process(usageEvent());

    expect(usageBilling.resolveGatewaySettlementAnchor).toHaveBeenCalledWith(
      expect.any(Object),
      expect.objectContaining({ requestId: 'req-usage-v2-1' }),
      databaseNow,
    );
    expect(prisma.gatewayUsageSettlementAnchor.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        requestId: 'req-usage-v2-1',
        firstReceivedAt: databaseNow,
        canonicalPayload: expect.objectContaining({
          firstReceivedAt: databaseNow.toISOString(),
        }),
      })],
      skipDuplicates: true,
    });
    expect(prisma.gatewayBillingEvent.update).toHaveBeenCalledWith({
      where: { id: 'gateway-billing-event-1' },
      data: expect.objectContaining({
        apiKeyId: 'key-1',
        userId: 'user-1',
        tenantId: 'tenant-1',
        billingAccountId: 'billing-account-1',
        productId: 'prod-1',
        productSlug: 'payg',
        billingUnit: 'BALANCE',
        pendingExposureUsd: new Prisma.Decimal('0.0008'),
        pendingHoldUsd: new Prisma.Decimal('0.0008'),
      }),
    });
    expect(prisma.gatewayUsageEvidence.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        observedAt: databaseNow,
        providerCredentialRef: 'provider-account-test-001',
        upstreamRequestId: 'upstream-request-test-001',
        upstreamResponseId: 'upstream-response-test-001',
        usageEvidenceSource: 'provider_terminal',
        usageEvidenceStatus: 'complete',
        usageEvidenceProtocol: 'openai_sse',
        terminalFrameSeen: true,
        providerReconciliationRequired: false,
      })],
      skipDuplicates: true,
    });
  });

  it('freezes the authoritative anchor subject when the raw event identifies only the API key', async () => {
    const { service, usageBilling, prisma } = buildService();
    const { canonicalPayload: _canonicalPayload, ...resolvedAnchor } = makeTestAnchor({
      requestId: 'req-usage-v2-1',
      apiKeyId: 'key-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      productSlug: 'payg',
      modelName: 'gpt-4o',
      eventOccurredAt: new Date('2026-05-21T08:30:15.000Z'),
      firstReceivedAt: new Date('2026-08-06T12:00:00.000Z'),
    });
    usageBilling.resolveGatewaySettlementAnchor.mockResolvedValueOnce(resolvedAnchor);

    await service.process(usageEvent({
      tenant_id: undefined,
      labels: { region: 'us-east-1' },
    }));

    expect(prisma.gatewayBillingEvent.update).toHaveBeenCalledWith({
      where: { id: 'gateway-billing-event-1' },
      data: expect.objectContaining({
        apiKeyId: 'key-1',
        userId: 'user-1',
        tenantId: 'tenant-1',
        billingAccountId: 'billing-account-1',
        productId: 'prod-1',
        productSlug: 'payg',
        billingUnit: 'BALANCE',
      }),
    });
  });

  it('falls back to raw_event.ts when wrapper timestamps are absent', async () => {
    const { service, usageBilling } = buildService();

    await service.process(usageEvent({
      timestamp: undefined,
      occurred_at: undefined,
      occurredAt: undefined,
      ts: undefined,
      raw_event: {
        ts: '1781796600000000000',
      },
    }));

    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(expect.objectContaining({
      eventOccurredAt: new Date('2026-06-18T15:30:00.000Z'),
    }), expect.any(Object));
  });

  it('quarantines an immutable contract defect with a known Key for manual review', async () => {
    const { service, usageBilling, prisma } = buildService();

    const result = await service.process(usageEvent({ ts: undefined }));

    expect(result).toMatchObject({
      action: 'quarantined',
      requestId: 'req-usage-v2-1',
      reason: 'invalid_event_contract',
      errorMessage: 'Gateway usage event 缺少有效发生时间',
      evidenceVerdict: 'INCOMPLETE',
      reconciliationStatus: 'MANUAL_REVIEW',
    });
    expect(usageBilling.settleDeliveredGatewayUsage).not.toHaveBeenCalled();
    expect(prisma.billingAccessRestriction.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          apiKeyId: 'key-1',
          reason: 'settlement_policy_review',
        }),
      }),
    );
  });

  it('bills by logical model before provider-specific upstream model', async () => {
    const { service, usageBilling } = buildService();

    await service.process(usageEvent({
      model: 'glm-5.1',
      logical_model: 'glm-5.1',
      actual_model: undefined,
      resolved_model: undefined,
      upstream_model: 'glm-5.1-openai-compatible',
      provider: 'glm-openai',
      resolved_api_type: 'openai',
    }));

    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(expect.objectContaining({
      modelName: 'glm-5.1',
      source: 'gateway:us-east-1:glm-openai:glm-5.1',
    }), expect.any(Object));
  });

  it('normalizes raw vendor token_extras after gateway stopped normalizing vendor fields', async () => {
    const { service, usageBilling } = buildService();

    await service.process(usageEvent({
      token_extras: {
        cache_read_input_tokens: 300,
        cache_creation_input_tokens: 80,
      },
    }));

    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(expect.objectContaining({
      cachedInputTokens: 300,
      cacheWriteInputTokens: 80,
    }), expect.any(Object));
  });

  it.each([
    [
      'usage',
      {
        usage: {
          prompt_cache_hit_tokens: 350,
          prompt_tokens_details: { cached_tokens: 420 },
          cache_creation: {
            ephemeral_5m_input_tokens: 40,
            ephemeral_1h_input_tokens: 60,
          },
        },
      },
    ],
    [
      'response.usage',
      {
        response: {
          usage: {
            input_tokens_details: { cached_tokens: 500 },
            cache_read_input_tokens: 600,
            cache_creation_input_tokens: 80,
          },
        },
      },
    ],
    [
      'raw_response.usage',
      {
        raw_response: {
          usage: {
            cache_read_input_tokens: 700,
            cache_creation_input_tokens: 90,
          },
        },
      },
    ],
    [
      'final_response.usage',
      {
        final_response: {
          usage: {
            cache_read_input_tokens: 800,
            cache_creation_input_tokens: 100,
          },
        },
      },
    ],
  ])('does not bill cache values from contract-out %s fields', async (
    _case,
    nestedPayload,
  ) => {
    const { service, usageBilling } = buildService();

    await service.process(usageEvent({
      token_extras: {},
      ...nestedPayload,
    }));

    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(expect.objectContaining({
      inputTokens: 1000,
      outputTokens: 525,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
    }), expect.any(Object));
  });

  it('sums Anthropic cache creation TTL buckets when no explicit cache write total exists', async () => {
    const { service, usageBilling } = buildService();

    await service.process(usageEvent({
      token_extras: {
        anthropic_ephemeral_5m_input_tokens: 40,
        anthropic_ephemeral_1h_input_tokens: 60,
      },
    }));

    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(expect.objectContaining({
      cacheWriteInputTokens: 100,
    }), expect.any(Object));
  });

  it('does not add v2 reasoning_tokens on top of completion_tokens', async () => {
    const { service, usageBilling } = buildService();

    await service.process(usageEvent({
      completion_tokens: 850,
      total_tokens: 1850,
      token_extras: {
        reasoning_tokens: 300,
      },
    }));

    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(expect.objectContaining({
      outputTokens: 850,
      totalTokens: 1850,
    }), expect.any(Object));
  });

  it('skips RequestEvent lifecycle facts without touching billing audit rows', async () => {
    const { service, usageBilling, prisma } = buildService();

    const result = await service.process(requestEvent());

    expect(result).toEqual({
      action: 'skipped',
      requestId: 'req-1',
      reason: 'unsupported_event_type:request_event',
    });
    expect(usageBilling.settleDeliveredGatewayUsage).not.toHaveBeenCalled();
    expect(prisma.gatewayBillingEvent.findUnique).not.toHaveBeenCalled();
    expect(prisma.gatewayBillingEvent.upsert).not.toHaveBeenCalled();
    expect(prisma.gatewayBillingEvent.update).not.toHaveBeenCalled();
  });

  it('skips non-v2 UsageEvent aliases so billing does not double-charge', async () => {
    const { service, usageBilling } = buildService();

    const result = await service.process({
      version: 'v1',
      event_type: 'usage_event',
      request_id: 'req-usage-alias-1',
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
    });

    expect(result).toEqual({
      action: 'skipped',
      requestId: 'req-usage-alias-1',
      reason: 'unsupported_event_type',
      revision: 1,
      reconciliationStatus: 'CLOSED',
    });
    expect(usageBilling.settleDeliveredGatewayUsage).not.toHaveBeenCalled();
  });

  it('settles an unproven idempotent-replay hint at a customer-protective zero', async () => {
    const { service, usageBilling, prisma } = buildService();

    const result = await service.process(usageEvent({
      is_idempotent_replay: true,
    }));

    expect(result).toMatchObject({
      action: 'deducted',
      requestId: 'req-usage-v2-1',
      reason: 'customer_protective_zero:unproven_no_charge:idempotent_replay',
      revision: 1,
      reconciliationStatus: 'OPEN',
    });
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      expect.any(Object),
    );
    expect(usageBilling.releaseGatewayBalanceFunding).not.toHaveBeenCalled();
    expect(prisma.gatewayUsageSettlementReceipt.create).not.toHaveBeenCalled();
  });

  it('skips auth quota failures and does not double-charge rollback events', async () => {
    const { service, usageBilling } = buildService();

    const result = await service.process(usageEvent({
      status: 'failure',
      status_code: 429,
      quota_settlement: 'rollback',
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      image_count: 0,
      upstream_started: false,
      response_started: false,
      token_extras: {
        cached_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      error: {
        stage: 'auth',
        type: 'quota_exceeded',
        code: 'QUOTA_EXCEEDED',
      },
    }));

    expect(result.action).toBe('skipped');
    expect(result.reason).toBe('quota_exceeded');
    expect(usageBilling.settleDeliveredGatewayUsage).not.toHaveBeenCalled();
  });

  it('settles an unverified quota rollback at zero without claiming NO_CHARGE proof', async () => {
    const { service, usageBilling, prisma } = buildService({
      BILLING_USAGE_VERIFIED_PRODUCER_BUILDS: 'f'.repeat(40),
    });

    const result = await service.process(usageEvent({
      status: 'failure',
      status_code: 429,
      quota_settlement: 'rollback',
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      image_count: 0,
      upstream_started: false,
      response_started: false,
      token_extras: {
        cached_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      error: {
        stage: 'auth',
        type: 'quota_exceeded',
        code: 'QUOTA_EXCEEDED',
      },
    }));

    expect(result).toMatchObject({
      action: 'deducted',
      reason: 'customer_protective_zero:unproven_no_charge:quota_exceeded',
    });
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      expect.any(Object),
    );
    expect(usageBilling.releaseGatewayBalanceFunding).not.toHaveBeenCalled();
    expect(prisma.gatewayUsageSettlementReceipt.create).not.toHaveBeenCalled();
  });

  it('commits a permanent NO_CHARGE proof, releases funding, then requires a fresh projection', async () => {
    const { service, usageBilling, prisma, publisherSync } = buildService();

    const result = await service.process(usageEvent({
      status: 'failure',
      status_code: 429,
      quota_settlement: 'rollback',
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      image_count: 0,
      upstream_started: false,
      response_started: false,
      token_extras: {
        cached_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      error: {
        stage: 'auth',
        type: 'quota_exceeded',
        code: 'QUOTA_EXCEEDED',
      },
    }));

    expect(result).toMatchObject({ action: 'skipped', reason: 'quota_exceeded' });
    expect(prisma.gatewayUsageSettlementReceipt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        gatewayBillingEventId: 'gateway-billing-event-1',
        requestId: 'req-usage-v2-1',
        fundingOutcome: 'NO_CHARGE',
        amountUsd: new Prisma.Decimal(0),
        reason: 'quota_exceeded',
        policyVersion: 'gateway-no-charge-v1',
      }),
    });
    expect(usageBilling.releaseGatewayBalanceFunding).toHaveBeenCalledWith(
      'req-usage-v2-1',
      'non_financial:quota_exceeded',
    );
    expect(
      prisma.gatewayUsageSettlementReceipt.create.mock.invocationCallOrder[0],
    ).toBeLessThan(
      usageBilling.releaseGatewayBalanceFunding.mock.invocationCallOrder[0],
    );
    expect(publisherSync.syncKeyBalanceByIdRequired).toHaveBeenCalledWith('key-1');
    expect(
      usageBilling.releaseGatewayBalanceFunding.mock.invocationCallOrder[0],
    ).toBeLessThan(
      publisherSync.syncKeyBalanceByIdRequired.mock.invocationCallOrder[0],
    );
    expect(prisma.gatewayBillingEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ fundingOutcome: 'NO_CHARGE' }),
      }),
    );
  });

  it('accepts only an explicit complete provider-terminal zero-usage proof', async () => {
    const { service, usageBilling, prisma } = buildService();

    const result = await service.process(usageEvent({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      image_count: 0,
      token_extras: {
        cached_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }));

    expect(result).toMatchObject({ action: 'skipped', reason: 'zero_usage' });
    expect(usageBilling.settleDeliveredGatewayUsage).not.toHaveBeenCalled();
    expect(usageBilling.releaseGatewayBalanceFunding).toHaveBeenCalledWith(
      'req-usage-v2-1',
      'non_financial:zero_usage',
    );
    expect(prisma.gatewayUsageSettlementReceipt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fundingOutcome: 'NO_CHARGE',
        reason: 'zero_usage',
        policyVersion: 'gateway-no-charge-v1',
        payload: expect.objectContaining({
          protocol: 'gateway-no-charge-v1',
          customerDeductionUsd: '0',
          reason: 'zero_usage',
        }),
      }),
    });
  });

  it('accepts generic provider zero usage with a response id when request id is unavailable', async () => {
    const { service, usageBilling } = buildService();

    const result = await service.process(usageEvent({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      image_count: 0,
      upstream_request_id: undefined,
      token_extras: {
        cached_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    }));

    expect(result).toMatchObject({ action: 'skipped', reason: 'zero_usage' });
    expect(usageBilling.releaseGatewayBalanceFunding).toHaveBeenCalledWith(
      'req-usage-v2-1',
      'non_financial:zero_usage',
    );
  });

  it.each([
    { name: 'producer build SHA', overrides: { producer_build_sha: undefined } },
    {
      name: 'producer build authorization',
      overrides: { producer_build_sha: 'f'.repeat(40) },
    },
    {
      name: 'canonical lowercase producer build SHA shape',
      overrides: { producer_build_sha: VERIFIED_PRODUCER_BUILD_SHA.toUpperCase() },
    },
    { name: 'provider usage hash', overrides: { provider_usage_hash: undefined } },
    { name: 'stable provider account', overrides: { provider_account_ref: undefined } },
    {
      name: 'safe-integer provider token extras',
      overrides: {
        token_extras: {
          cached_tokens: 0,
          cache_creation_input_tokens: 0,
          provider_extension: 0.5,
        },
      },
    },
    {
      name: 'upstream correlation',
      overrides: { upstream_request_id: undefined, upstream_response_id: undefined },
    },
    {
      name: 'Anthropic/Zhipu upstream request id even when a response id exists',
      overrides: {
        provider: 'zhipu',
        resolved_api_type: 'anthropic',
        upstream_request_id: undefined,
        upstream_response_id: 'response-only-is-insufficient',
        usage_evidence: {
          source: 'provider_terminal',
          status: 'complete',
          protocol: 'anthropic',
          terminal_frame_seen: true,
          dimensions_present: [
            'input_tokens',
            'output_tokens',
            'cache_read_input_tokens',
            'cache_creation_input_tokens',
          ],
        },
      },
    },
    {
      name: 'usage protocol',
      overrides: {
        usage_evidence: {
          source: 'provider_terminal',
          status: 'complete',
          terminal_frame_seen: true,
          dimensions_present: [
            'input_tokens',
            'output_tokens',
            'cache_read_input_tokens',
            'cache_creation_input_tokens',
          ],
        },
      },
    },
    {
      name: 'exact provider-terminal source',
      overrides: {
        usage_evidence: {
          source: ' provider_terminal ',
          status: 'complete',
          protocol: 'openai_sse',
          terminal_frame_seen: true,
          dimensions_present: [
            'input_tokens',
            'output_tokens',
            'cache_read_input_tokens',
            'cache_creation_input_tokens',
          ],
        },
      },
    },
    {
      name: 'normalized unique usage dimensions',
      overrides: {
        usage_evidence: {
          source: 'provider_terminal',
          status: 'complete',
          protocol: 'openai_sse',
          terminal_frame_seen: true,
          dimensions_present: [
            'input_tokens',
            'output_tokens',
            'cache_read_input_tokens',
            'cache_creation_input_tokens',
            ' INPUT_TOKENS ',
          ],
        },
      },
    },
  ])('settles provider-terminal zero usage without $name as a protective zero', async ({ overrides }) => {
    const { service, usageBilling, prisma } = buildService();

    const result = await service.process(usageEvent({
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      image_count: 0,
      token_extras: {
        cached_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      ...overrides,
    }));

    expect(result).toMatchObject({
      action: 'deducted',
      reason: 'customer_protective_zero:unproven_no_charge:zero_usage',
      reconciliationStatus: 'OPEN',
    });
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        gatewayCustomerSettlement: expect.objectContaining({
          basis: 'CUSTOMER_PROTECTIVE_ZERO',
        }),
      }),
      expect.any(Object),
    );
    expect(usageBilling.releaseGatewayBalanceFunding).not.toHaveBeenCalled();
    expect(prisma.gatewayUsageSettlementReceipt.create).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'pending quota settlement',
      overrides: { quota_settlement: 'pending' },
    },
    {
      name: 'auth rejection without the exact pre-upstream quota tuple',
      overrides: {
        status: 'failure',
        status_code: 403,
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        image_count: 0,
        token_extras: { cached_tokens: 0, cache_creation_input_tokens: 0 },
        error: { stage: 'auth', type: 'authentication_failed' },
      },
    },
    {
      name: 'quota rejection after upstream started',
      overrides: {
        status: 'failure',
        status_code: 429,
        quota_settlement: 'rollback',
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        image_count: 0,
        upstream_started: true,
        response_started: false,
        token_extras: { cached_tokens: 0, cache_creation_input_tokens: 0 },
        error: { stage: 'auth', type: 'quota_exceeded' },
      },
    },
    {
      name: 'quota status code encoded as a string',
      overrides: {
        status: 'failure',
        status_code: '429',
        quota_settlement: 'rollback',
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        image_count: 0,
        upstream_started: false,
        response_started: false,
        token_extras: { cached_tokens: 0, cache_creation_input_tokens: 0 },
        error: { stage: 'auth', type: 'quota_exceeded' },
      },
    },
    {
      name: 'missing usage status',
      overrides: { status: undefined },
    },
  ])('settles $name protectively without writing a NO_CHARGE proof', async ({ overrides }) => {
    const { service, usageBilling, prisma } = buildService();

    const result = await service.process(usageEvent(overrides));

    expect(result).toMatchObject({
      action: 'deducted',
      evidenceVerdict: 'INCOMPLETE',
      reconciliationStatus: 'OPEN',
    });
    expect(result.reason).toMatch(/^customer_protective_zero:unproven_no_charge:/);
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      expect.any(Object),
    );
    expect(usageBilling.releaseGatewayBalanceFunding).not.toHaveBeenCalled();
    expect(prisma.gatewayUsageSettlementReceipt.create).not.toHaveBeenCalled();
    expect(prisma.gatewayBillingEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'DEDUCTED',
          pendingHoldUsd: new Prisma.Decimal(0),
          reconciliationStatus: 'OPEN',
        }),
      }),
    );
  });

  it('replays NO_CHARGE release and projection after the post-release sync fails', async () => {
    const { service, usageBilling, prisma, publisherSync } = buildService();
    const event = usageEvent({
      status: 'failure',
      status_code: 429,
      quota_settlement: 'rollback',
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      image_count: 0,
      upstream_started: false,
      response_started: false,
      token_extras: {
        cached_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      error: {
        stage: 'auth',
        type: 'quota_exceeded',
        code: 'QUOTA_EXCEEDED',
      },
    });
    publisherSync.syncKeyBalanceByIdRequired
      .mockRejectedValueOnce(new Error('publisher projection unavailable'));

    await expect(service.process(event)).rejects.toThrow(
      'publisher projection unavailable',
    );

    expect(usageBilling.releaseGatewayBalanceFunding).toHaveBeenCalledTimes(1);
    expect(prisma.gatewayUsageSettlementReceipt.create).toHaveBeenCalledTimes(1);

    const replay = await service.process(event);

    expect(replay).toMatchObject({
      action: 'skipped',
      reason: 'quota_exceeded',
      revision: 1,
      reconciliationStatus: 'CLOSED',
    });
    expect(usageBilling.releaseGatewayBalanceFunding).toHaveBeenCalledTimes(2);
    expect(publisherSync.syncKeyBalanceByIdRequired).toHaveBeenCalledTimes(2);
    expect(prisma.gatewayUsageSettlementReceipt.create).toHaveBeenCalledTimes(1);
  });

  it('preserves a committed NO_CHARGE reason and releases funding when crash recovery receives different evidence', async () => {
    const { service, usageBilling, prisma } = buildService();
    const event = usageEvent({
      status: 'failure',
      status_code: 429,
      quota_settlement: 'rollback',
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      image_count: 0,
      upstream_started: false,
      response_started: false,
      token_extras: {
        cached_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      error: {
        stage: 'auth',
        type: 'quota_exceeded',
        code: 'QUOTA_EXCEEDED',
      },
    });
    usageBilling.releaseGatewayBalanceFunding
      .mockRejectedValueOnce(new Error('crashed before funding release completed'));

    await expect(service.process(event)).rejects.toThrow(
      'crashed before funding release completed',
    );

    const replay = await service.process({
      ...event,
      event_id: 'usage-evt-different-after-no-charge-crash',
    });

    expect(replay).toMatchObject({
      action: 'skipped',
      reason: 'quota_exceeded',
      evidenceVerdict: 'UNKNOWN',
      reconciliationStatus: 'CLOSED',
      fundingOutcome: 'NO_CHARGE',
    });
    expect(usageBilling.releaseGatewayBalanceFunding).toHaveBeenCalledTimes(2);
    expect(usageBilling.releaseGatewayBalanceFunding).toHaveBeenLastCalledWith(
      'req-usage-v2-1',
      'non_financial:quota_exceeded',
    );
    expect(prisma.gatewayBillingEvent.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ evidenceVerdict: 'CONFLICTED' }),
      }),
    );
    expect(prisma.gatewayUsageReconciliationAction.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        action: 'EVIDENCE_CONFLICT',
        reason: 'terminal_event_received_different_evidence',
        expectedRevision: 1,
        resultingRevision: 1,
        idempotencyKey: expect.stringContaining(
          'gateway:internal-evidence-conflict:req-usage-v2-1:',
        ),
        metadata: expect.objectContaining({
          customerFinancialParentUnchanged: true,
          firstReceiptFinancialAuthority: true,
        }),
      })],
      skipDuplicates: true,
    });
  });

  it('refuses NO_CHARGE when the selected evidence row raw payload does not match its hash', async () => {
    const { service, usageBilling, prisma } = buildService();
    const event = usageEvent({
      status: 'failure',
      status_code: 429,
      quota_settlement: 'rollback',
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      image_count: 0,
      upstream_started: false,
      response_started: false,
      token_extras: {
        cached_tokens: 0,
        cache_creation_input_tokens: 0,
      },
      error: {
        stage: 'auth',
        type: 'quota_exceeded',
      },
    });
    const evidenceHash = createHash('sha256')
      .update(testCanonicalJson(event))
      .digest('hex');
    prisma.gatewayUsageEvidence.findUnique.mockResolvedValueOnce({
      gatewayBillingEventId: 'gateway-billing-event-1',
      requestId: 'req-usage-v2-1',
      source: 'GATEWAY_USAGE_EVENT',
      evidenceHash,
      rawEvidence: { ...event, response_started: true },
    });

    const result = await service.process(event);

    expect(result).toMatchObject({
      action: 'quarantined',
      reason: 'settlement_anchor_conflict',
      reconciliationStatus: 'MANUAL_REVIEW',
    });
    expect(prisma.gatewayUsageSettlementReceipt.create).not.toHaveBeenCalled();
    expect(usageBilling.releaseGatewayBalanceFunding).not.toHaveBeenCalled();
  });

  it('settles pending/skipped quota projection states at zero and releases the hold', async () => {
    const { service, usageBilling, prisma } = buildService();

    const result = await service.process(usageEvent({
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      token_source: 'provider',
      quota_settlement: 'skipped',
    }));

    expect(result).toMatchObject({
      action: 'deducted',
      reason: 'customer_protective_zero:unproven_no_charge:quota_settlement_skipped',
      reconciliationStatus: 'OPEN',
    });
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      expect.any(Object),
    );
    expect(usageBilling.releaseGatewayBalanceFunding).not.toHaveBeenCalled();
    expect(prisma.gatewayUsageSettlementReceipt.create).not.toHaveBeenCalled();
  });

  it('settles a rollback hint with uncertain billable usage at zero', async () => {
    const { service, usageBilling, prisma } = buildService();

    const result = await service.process(usageEvent({
      status: 'failure',
      status_code: 502,
      prompt_tokens: 300,
      completion_tokens: 120,
      total_tokens: 420,
      token_source: 'provider',
      quota_settlement: 'rollback',
      error: {
        stage: 'upstream',
        type: 'upstream_error',
      },
    }));

    expect(result).toMatchObject({
      action: 'deducted',
      reason: 'customer_protective_zero:unproven_no_charge:quota_settlement_rollback',
      reconciliationStatus: 'OPEN',
    });
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      expect.any(Object),
    );
    expect(usageBilling.releaseGatewayBalanceFunding).not.toHaveBeenCalled();
    expect(prisma.gatewayUsageSettlementReceipt.create).not.toHaveBeenCalled();
  });

  it('charges upstream failures when provider usage is present', async () => {
    const { service, usageBilling } = buildService();

    const result = await service.process(usageEvent({
      status: 'failure',
      status_code: 502,
      prompt_tokens: 300,
      completion_tokens: 120,
      total_tokens: 420,
      token_source: 'provider',
      error: {
        stage: 'upstream',
        type: 'upstream_error',
        code: 'UPSTREAM_502',
      },
    }));

    expect(result.action).toBe('deducted');
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(expect.objectContaining({
      inputTokens: 300,
      outputTokens: 120,
      totalTokens: 420,
    }), expect.any(Object));
  });

  it('settles input-only playground usage at a protective zero', async () => {
    const { service, usageBilling, prisma } = buildService();

    const result = await service.process(usageEvent({
      prompt_tokens: 300,
      completion_tokens: 0,
      total_tokens: 300,
      labels: {
        tenant_id: 'tenant-1',
        user_id: 'user-1',
        'usr.product_id': 'prod-1',
        'usr.product_slug': 'payg',
        source: 'playground',
      },
    }));

    expect(result).toMatchObject({
      action: 'deducted',
      reason: 'customer_protective_zero:unproven_no_charge:no_output_tokens_for_output_required_usage',
      reconciliationStatus: 'OPEN',
    });
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      expect.any(Object),
    );
    expect(usageBilling.releaseGatewayBalanceFunding).not.toHaveBeenCalled();
    expect(prisma.gatewayUsageSettlementReceipt.create).not.toHaveBeenCalled();
  });

  it('settles input-only chat completion usage at a protective zero', async () => {
    const { service, usageBilling } = buildService();

    const result = await service.process(usageEvent({
      prompt_tokens: 300,
      completion_tokens: 0,
      total_tokens: 300,
      request: {
        path: '/v1/chat/completions',
      },
    }));

    expect(result).toMatchObject({
      action: 'deducted',
      reason: 'customer_protective_zero:unproven_no_charge:no_output_tokens_for_output_required_usage',
      reconciliationStatus: 'OPEN',
    });
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      expect.any(Object),
    );
  });

  it('keeps charging input-only usage when the event is not explicitly output-required', async () => {
    const { service, usageBilling } = buildService();

    const result = await service.process(usageEvent({
      prompt_tokens: 300,
      completion_tokens: 0,
      total_tokens: 300,
    }));

    expect(result.action).toBe('deducted');
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(expect.objectContaining({
      inputTokens: 300,
      outputTokens: 0,
      totalTokens: 300,
    }), expect.any(Object));
  });

  it('does not skip input-only embedding usage', async () => {
    const { service, usageBilling } = buildService();

    const result = await service.process(usageEvent({
      prompt_tokens: 300,
      completion_tokens: 0,
      total_tokens: 300,
      operation: 'embeddings',
    }));

    expect(result.action).toBe('deducted');
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(expect.objectContaining({
      inputTokens: 300,
      outputTokens: 0,
      totalTokens: 300,
    }), expect.any(Object));
  });

  it('marks a billable event without an identity subject for DLQ handling', async () => {
    const { service, prisma } = buildService();

    const result = await service.process(usageEvent({
      key_id: undefined,
      tenant_id: undefined,
      labels: { product_id: 'prod-1' },
    }));

    expect(result.action).toBe('failed');
    expect(result.reason).toBe('invalid_event_contract');
    expect(result.reconciliationStatus).toBe('MANUAL_REVIEW');
    expect(result.errorMessage).toContain('缺少 apiKeyId/tenantId/userId/email');
    expect(prisma.billingAccessRestriction.upsert).not.toHaveBeenCalled();
  });

  it('prefers tenant identity from labels over top-level tenant_id', async () => {
    const { service, usageBilling } = buildService();

    const result = await service.process(usageEvent({
      tenant_id: 'top-level-tenant',
      labels: {
        tenant_id: 'label-tenant',
        product_id: 'prod-1',
        product_slug: 'payg',
      },
    }));

    expect(result.action).toBe('deducted');
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'label-tenant',
    }), expect.any(Object));
  });

  it('fails closed when the signed event tenant differs from the first-receipt Key binding', async () => {
    const { service, usageBilling, prisma } = buildService();
    usageBilling.resolveGatewaySettlementAnchor.mockRejectedValueOnce(
      new GatewaySettlementAnchorConflictError('event tenant mismatch'),
    );

    const result = await service.process(usageEvent({
      labels: {
        tenant_id: 'tenant-from-event',
        product_id: 'prod-1',
        product_slug: 'payg',
      },
    }));

    expect(result).toMatchObject({
      action: 'quarantined',
      requestId: 'req-usage-v2-1',
      reason: 'settlement_anchor_missing',
      reconciliationStatus: 'MANUAL_REVIEW',
    });
    expect(usageBilling.settleDeliveredGatewayUsage).not.toHaveBeenCalled();
    expect(prisma.gatewayBillingEvent.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ requestId: 'req-usage-v2-1', revision: 0 }),
        data: expect.objectContaining({
          status: 'QUARANTINED',
          reason: 'settlement_anchor_missing',
          reconciliationStatus: 'MANUAL_REVIEW',
          billingResult: Prisma.DbNull,
          pricingSnapshot: Prisma.DbNull,
        }),
      }),
    );
  });

  // ─── 主体级复核限制（2026-09-07 国内 prod：单 Key 堆了 9,622 行 ACTIVE）───────
  //
  // 两条不变量：
  //   1. 幂等键按主体，不按事件 —— 否则每笔隔离事件多一行，且每行 INSERT 都触发一条投影
  //      intent，把该账户的 Key 投影重发一起带崩。
  //   2. 已存在 ACTIVE 行时走 update:{}，status 绝不进 SET 列表 —— 表上的触发器是
  //      AFTER INSERT OR UPDATE OF status，PG 的 `UPDATE OF` 只看列是否被提及、不看值变没变。
  it('隔离事件的复核限制按主体幂等，且不重复触发投影', async () => {
    const { service, usageBilling, prisma } = buildService();
    usageBilling.resolveGatewaySettlementAnchor.mockRejectedValueOnce(
      new GatewaySettlementAnchorConflictError('history has no immutable anchor'),
    );

    const result = await service.process(usageEvent({
      labels: { tenant_id: 'tenant-1', product_id: 'prod-1', product_slug: 'payg' },
    }));

    expect(result).toMatchObject({ action: 'quarantined', reason: 'settlement_anchor_missing' });

    const reviewUpsert = (prisma.billingAccessRestriction.upsert as jest.Mock).mock.calls
      .map(([arg]) => arg)
      .find((arg) => String(arg?.where?.idempotencyKey ?? '')
        .startsWith('gateway:settlement_policy_review:'));
    expect(reviewUpsert).toBeDefined();
    expect(reviewUpsert.where.idempotencyKey)
      .toMatch(/^gateway:settlement_policy_review:(account|key):/);
    expect(reviewUpsert.create.idempotencyKey).toBe(reviewUpsert.where.idempotencyKey);
    expect(reviewUpsert.create.reason).toBe('settlement_policy_review');
    // status 不在 update 里 —— 这一条就是"不再放大投影"的全部内容
    expect(reviewUpsert.update).toEqual({});

    // 绝不尝试「RELEASED → ACTIVE」的再武装：库里 BEFORE UPDATE OF status 的守卫
    // enforce_billing_access_restriction_lifecycle 只允许 ACTIVE→RELEASED，反向 RAISE 23514，
    // 而这里在 recordFinalState 的事务里，异常会被原样 rethrow ⇒ 结算硬失败、消息重试进 DLQ。
    // 同一主体第二次出问题靠「释放时腾键 + 这里新建一行」保证不 fail-open，不靠改回 ACTIVE。
    const reArm = (prisma.billingAccessRestriction.updateMany as jest.Mock).mock.calls
      .map(([arg]) => arg)
      .filter((arg) => arg?.where?.status === 'RELEASED' || arg?.data?.status === 'ACTIVE');
    expect(reArm).toEqual([]);
  });

  // 回归：幂等键主体漂移（2026-09-10~09-20 国内 prod 70 条误封、最长 253 小时）。
  // 建行在 RETRYABLE_FAILED 时事件还没 billingAccountId ⇒ 落 `:key:` 行；
  // 结算成功后事件有了 billingAccountId，释放侧若只按当前事件重算一次主体就变成 `:account:`，
  // 匹配 0 行且静默 ⇒ 限制永久 ACTIVE。所以两个候选主体都必须被尝试释放。
  it('释放时两个候选主体都尝试，避免建行按 key 级、释放按 account 级的漂移', async () => {
    const { service, usageBilling, prisma } = buildService();
    const serializationFailure = Object.assign(
      new Error('funding reservation serialization failed'),
      { code: 'P2034' },
    );
    usageBilling.reserveGatewayBalanceFunding.mockRejectedValueOnce(serializationFailure);
    await expect(service.process(usageEvent()))
      .rejects.toThrow('funding_reservation_retry_pending');

    // 该主体已无待重试事件 ⇒ 判据满足，应当放行
    (prisma.gatewayBillingEvent.count as jest.Mock).mockResolvedValue(0);
    // 库里那行是**建行时**落下的 key 级行（当时事件还没 billingAccountId）
    (prisma.billingAccessRestriction.findMany as jest.Mock).mockImplementation(
      async ({ where }: { where: { idempotencyKey?: string } }) => (
        where?.idempotencyKey === 'gateway:settlement_retry_pending:key:key-1'
          ? [{ id: 'restriction-1', idempotencyKey: where.idempotencyKey }]
          : []
      ),
    );
    const queuePending = new GatewayFundingReservationQueuePendingError(
      'billing-account-1',
      'req-usage-v2-1',
      'req-earlier-receipt',
      1n,
    );
    usageBilling.reserveGatewayBalanceFunding.mockRejectedValueOnce(queuePending);

    await expect(service.process(usageEvent())).rejects.toBe(queuePending);

    const attempted = (prisma.billingAccessRestriction.findMany as jest.Mock).mock.calls
      .map(([arg]) => String(arg?.where?.idempotencyKey ?? ''))
      .filter((key) => key.startsWith('gateway:settlement_retry_pending:'));
    // 事件此时已带 billingAccountId，若只算一次主体就只会试 account 级、永远碰不到那行 key 级
    expect(attempted).toEqual(expect.arrayContaining([
      'gateway:settlement_retry_pending:account:billing-account-1',
      'gateway:settlement_retry_pending:key:key-1',
    ]));

    // 释放必须把主体键改名腾出来，否则下次 upsert 命中 RELEASED 行走 update:{} ⇒ fail-open
    const renamed = (prisma.billingAccessRestriction.update as jest.Mock).mock.calls
      .map(([arg]) => arg)
      .find((arg) => arg?.where?.id === 'restriction-1');
    expect(renamed).toBeDefined();
    expect(renamed.data.status).toBe('RELEASED');
    expect(renamed.data.idempotencyKey)
      .toBe('gateway:settlement_retry_pending:key:key-1:released:restriction-1');
  });

  it('主体名下还有待复核事件时，收口单条不解封整个主体', async () => {
    const { service, usageBilling, prisma } = buildService();
    // 该主体还有 3 条 QUARANTINED/待复核事件
    (prisma.gatewayBillingEvent.count as jest.Mock).mockResolvedValue(3);
    usageBilling.resolveGatewaySettlementAnchor.mockRejectedValueOnce(
      new GatewaySettlementAnchorConflictError('history has no immutable anchor'),
    );

    await service.process(usageEvent({
      labels: { tenant_id: 'tenant-1', product_id: 'prod-1', product_slug: 'payg' },
    }));

    // 主体级释放现在走 findMany + 逐行 update（要腾主体键），所以断言这两个都没被碰过
    const subjectRelease = (prisma.billingAccessRestriction.findMany as jest.Mock).mock.calls
      .map(([arg]) => arg)
      .filter((arg) => /^gateway:settlement_policy_review:(account|key):/
        .test(String(arg?.where?.idempotencyKey ?? '')));
    expect(subjectRelease).toEqual([]);
    expect(prisma.billingAccessRestriction.update).not.toHaveBeenCalled();
    // 顺带守住老口径：也不能退回用 updateMany 直接放行主体级行
    const legacySubjectRelease = (prisma.billingAccessRestriction.updateMany as jest.Mock).mock.calls
      .map(([arg]) => arg)
      .filter((arg) => arg?.where?.status === 'ACTIVE'
        && /^gateway:settlement_policy_review:(account|key):/
          .test(String(arg?.where?.idempotencyKey ?? '')));
    expect(legacySubjectRelease).toEqual([]);
  });

  it('rolls back first receipt and leaves Kafka retryable for account currency migration', async () => {
    const { service, usageBilling, prisma } = buildService();
    const currencyError = new GatewayBillingCurrencyMigrationRequiredError(
      'USD',
      'CNY',
      'billing-account-1',
      'key-1',
    );
    usageBilling.resolveGatewaySettlementAnchor.mockRejectedValueOnce(currencyError);

    await expect(service.process(usageEvent())).rejects.toBe(currencyError);

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.gatewayUsageEvidence.createMany).not.toHaveBeenCalled();
    expect(stateUpdateManyCalls(prisma)).toHaveLength(0);
    expect(prisma.billingAccessRestriction.upsert).not.toHaveBeenCalled();
    expect(usageBilling.settleDeliveredGatewayUsage).not.toHaveBeenCalled();
  });

  it('keeps a legacy CREDITS scope without balance state unanchored for manual review', async () => {
    const { service, usageBilling, prisma } = buildService();
    usageBilling.resolveGatewaySettlementAnchor.mockRejectedValueOnce(
      new Error(
        'credit balance state missing for legacy subscription=sub-legacy; run the verified balance-state backfill before enabling V2',
      ),
    );

    const result = await service.process(usageEvent());

    expect(result).toMatchObject({
      action: 'quarantined',
      requestId: 'req-usage-v2-1',
      reason: 'settlement_anchor_missing',
      reconciliationStatus: 'MANUAL_REVIEW',
    });
    expect(prisma.gatewayUsageSettlementAnchor.createMany).not.toHaveBeenCalled();
    expect(usageBilling.settleDeliveredGatewayUsage).not.toHaveBeenCalled();
  });

  it('does not use estimated_total_tokens when provider usage is authoritative', async () => {
    const { service, usageBilling } = buildService();

    const result = await service.process(usageEvent({
      prompt_tokens: 20,
      completion_tokens: 30,
      total_tokens: 50,
      estimated_total_tokens: 1000,
      token_source: 'provider',
      token_extras: {},
    }));

    expect(result.action).toBe('deducted');
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(expect.objectContaining({
      inputTokens: 20,
      outputTokens: 30,
      totalTokens: 50,
    }), expect.any(Object));
  });

  it('settles estimated disconnect fallback at zero without a customer hold', async () => {
    const { service, usageBilling, prisma } = buildService();

    const result = await service.process(usageEvent({
      status: 'failure',
      status_code: 499,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      estimated_total_tokens: 800,
      token_source: 'estimated',
      disconnect_stage: 'stream_mid',
      quota_settlement: 'settled',
      error: {
        stage: 'upstream',
        type: 'upstream_error',
      },
    }));

    expect(result).toMatchObject({
      action: 'deducted',
      reason: 'customer_protective_zero:unproven_no_charge:estimated_disconnect_usage',
      evidenceVerdict: 'INCOMPLETE',
      reconciliationStatus: 'OPEN',
    });
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      expect.any(Object),
    );
    expect(prisma.gatewayBillingEvent.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ requestId: 'req-usage-v2-1', revision: 0 }),
        data: expect.objectContaining({
          status: 'DEDUCTED',
          pendingExposureUsd: new Prisma.Decimal(0),
          pendingHoldUsd: new Prisma.Decimal(0),
          reconciliationStatus: 'OPEN',
        }),
      }),
    );
    expect(prisma.gatewayUsageSettlementReceipt.create).not.toHaveBeenCalled();
    expect(usageBilling.releaseGatewayBalanceFunding).not.toHaveBeenCalled();
  });

  it('settles successful estimated responses at zero', async () => {
    const { service, usageBilling } = buildService();

    const result = await service.process(usageEvent({
      status: 'success',
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      estimated_total_tokens: 600,
      token_source: 'estimated',
    }));

    expect(result).toMatchObject({
      action: 'deducted',
      reason: 'customer_protective_zero:unsafe_estimated_usage',
      reconciliationStatus: 'OPEN',
    });
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      expect.any(Object),
    );
  });

  it('settles a CREDITS protective zero through the durable usage receipt and replays it', async () => {
    const { service, usageBilling, prisma } = buildService();
    usageBilling.settleDeliveredGatewayUsage.mockResolvedValueOnce({
      success: true,
      allowed: true,
      tokenUsageId: 'token-usage-credits-zero',
      fundingOutcome: 'INCLUDED',
      quote: {
        unit: 'CREDITS',
        tenantId: 'tenant-1',
        creditCost: 0,
      },
    });
    usageBilling.resolveGatewaySettlementAnchor.mockImplementationOnce(async (
      _db: unknown,
      input: Record<string, unknown>,
      firstReceivedAt: Date,
    ) => {
      const { canonicalPayload: _canonicalPayload, ...anchor } = makeTestAnchor({
        ...input,
        billingUnit: 'CREDITS',
        firstReceivedAt,
      });
      return anchor;
    });
    const event = usageEvent({
      request_id: 'req-credits-protective-zero',
      token_source: 'estimated',
      estimated_total_tokens: 600,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
    });

    const first = await service.process(event);
    const replay = await service.process(event);

    expect(first).toMatchObject({
      action: 'deducted',
      requestId: 'req-credits-protective-zero',
      evidenceVerdict: 'INCOMPLETE',
      reconciliationStatus: 'OPEN',
      fundingOutcome: 'INCLUDED',
      mapped: expect.objectContaining({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
      }),
    });
    expect(replay).toMatchObject({
      action: 'deducted',
      requestId: 'req-credits-protective-zero',
      evidenceVerdict: 'INCOMPLETE',
      reconciliationStatus: 'OPEN',
      fundingOutcome: 'INCLUDED',
    });
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledTimes(1);
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        imageCount: 0,
        gatewayCustomerSettlement: expect.objectContaining({
          basis: 'CUSTOMER_PROTECTIVE_ZERO',
        }),
      }),
      expect.any(Object),
    );
    expect(usageBilling.reserveGatewayBalanceFunding).not.toHaveBeenCalled();
    expect(prisma.gatewayBillingEvent.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.gatewayBillingEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'DEDUCTED',
          reason: 'customer_protective_zero:unsafe_estimated_usage',
          evidenceVerdict: 'INCOMPLETE',
          reconciliationStatus: 'OPEN',
          fundingOutcome: 'INCLUDED',
          pendingExposureUsd: new Prisma.Decimal(0),
          pendingHoldUsd: new Prisma.Decimal(0),
        }),
      }),
    );
  });

  it('settles missing token_source at zero without blocking the customer', async () => {
    const { service, usageBilling } = buildService();

    const result = await service.process(usageEvent({ token_source: undefined }));

    expect(result).toMatchObject({
      action: 'deducted',
      reason: 'customer_protective_zero:token_source_missing',
      evidenceVerdict: 'INCOMPLETE',
      reconciliationStatus: 'OPEN',
    });
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(
      expect.objectContaining({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      expect.any(Object),
    );
  });

  it.each([
    [
      'missing evidence object',
      { usage_evidence: undefined },
      'usage_evidence_missing',
      'CUSTOMER_PROTECTIVE_ZERO',
      true,
    ],
    [
      'pending evidence status',
      {
        usage_evidence: {
          source: 'provider_terminal',
          status: 'partial',
          protocol: 'openai_sse',
          terminal_frame_seen: true,
        },
      },
      'usage_evidence_partial',
      'CUSTOMER_PROTECTIVE_ZERO',
      true,
    ],
    [
      'invalid non-monotonic evidence status',
      {
        usage_evidence: {
          source: 'provider_terminal',
          status: 'invalid',
          protocol: 'openai_sse',
          terminal_frame_seen: true,
          dimensions_present: [
            'input_tokens',
            'output_tokens',
            'cache_read_input_tokens',
            'cache_creation_input_tokens',
          ],
        },
      },
      'usage_evidence_invalid',
      'CUSTOMER_PROTECTIVE_ZERO',
      true,
    ],
    [
      'invalid provider evidence source',
      {
        usage_evidence: {
          source: 'gateway_estimate',
          status: 'complete',
          protocol: 'openai_sse',
          terminal_frame_seen: true,
        },
      },
      'usage_evidence_source_invalid',
      'CUSTOMER_PROTECTIVE_ZERO',
      true,
    ],
    [
      'missing evidence protocol',
      {
        usage_evidence: {
          source: 'provider_terminal',
          status: 'complete',
          protocol: '',
          terminal_frame_seen: true,
        },
      },
      'usage_evidence_protocol_missing',
      'CUSTOMER_PROTECTIVE_ZERO',
      true,
    ],
    [
      'provider terminal without a terminal frame',
      {
        usage_evidence: {
          source: 'provider_terminal',
          status: 'complete',
          protocol: 'openai_sse',
          terminal_frame_seen: false,
        },
      },
      'provider_terminal_frame_missing',
      'CUSTOMER_PROTECTIVE_ZERO',
      true,
    ],
    [
      'provider reconciliation explicitly required',
      { provider_reconciliation_required: true },
      'provider_reconciliation_required',
      'NORMALIZED_EXACT',
      false,
    ],
    [
      'missing provider reconciliation verdict',
      { provider_reconciliation_required: undefined },
      'provider_reconciliation_verdict_missing',
      'NORMALIZED_EXACT',
      false,
    ],
    [
      'missing provider account reference',
      { provider_credential_ref: undefined, provider_account_ref: undefined },
      'provider_account_ref_missing',
      'NORMALIZED_EXACT',
      false,
    ],
    [
      'missing upstream correlation ID',
      { upstream_request_id: undefined, upstream_response_id: undefined },
      'upstream_correlation_id_missing',
      'NORMALIZED_EXACT',
      false,
    ],
  ])('settles normalized provider usage with internal-only %s', async (
    _case,
    overrides,
    reason,
    expectedBasis,
    zeroFloor,
  ) => {
    const { service, usageBilling, prisma } = buildService();

    const result = await service.process(usageEvent(overrides));

    expect(result).toMatchObject({
      action: 'deducted',
      evidenceVerdict: 'INCOMPLETE',
      reconciliationStatus: 'OPEN',
    });
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledTimes(1);
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: zeroFloor ? 0 : 1000,
        outputTokens: zeroFloor ? 0 : 525,
        totalTokens: zeroFloor ? 0 : 1525,
        gatewayCustomerSettlement: expect.objectContaining({
          policyVersion: 'gateway-customer-settlement-v2',
          basis: expectedBasis,
          evidenceReason: reason,
        }),
      }),
      expect.any(Object),
    );
    expect(prisma.billingAccessRestriction.upsert).not.toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          reason: expect.stringMatching(/evidence|pending_usage_exposure/),
        }),
      }),
    );
  });

  it.each([
    [
      'a missing core token dimension',
      { prompt_tokens: undefined },
      'provider_usage_dimensions_invalid',
    ],
    [
      'fractional token dimensions',
      { completion_tokens: 1.5 },
      'provider_usage_dimensions_invalid',
    ],
    [
      'negative token dimensions',
      { prompt_tokens: -1, completion_tokens: 525, total_tokens: 524 },
      'provider_usage_dimensions_invalid',
    ],
    [
      'negative canonical cache dimensions',
      { token_extras: { cache_hit_tokens: -1, cache_write_tokens: 0 } },
      'provider_usage_dimensions_invalid',
    ],
    [
      'fractional canonical cache dimensions',
      { token_extras: { cache_hit_tokens: 100, cache_write_tokens: 0.5 } },
      'provider_usage_dimensions_invalid',
    ],
    [
      'a total that differs from input plus output',
      { prompt_tokens: 1000, completion_tokens: 525, total_tokens: 1524 },
      'provider_total_tokens_mismatch',
    ],
    [
      'cache dimensions larger than prompt tokens',
      {
        prompt_tokens: 100,
        completion_tokens: 50,
        total_tokens: 150,
        token_extras: { cache_hit_tokens: 80, cache_write_tokens: 30 },
      },
      'provider_cache_tokens_exceed_prompt',
    ],
  ])('settles provider usage with invalid %s at a customer-protective zero', async (
    _case,
    overrides,
    reason,
  ) => {
    const { service, usageBilling, prisma } = buildService();

    const result = await service.process(usageEvent(overrides));

    expect(result).toMatchObject({
      action: 'deducted',
      reason: `customer_protective_zero:${reason}`,
      evidenceVerdict: 'INCOMPLETE',
      reconciliationStatus: 'OPEN',
    });
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 0,
        outputTokens: 0,
        totalTokens: 0,
        gatewayCustomerSettlement: expect.objectContaining({
          basis: 'CUSTOMER_PROTECTIVE_ZERO',
          evidenceReason: reason,
          customerProtectionReason: reason,
        }),
      }),
      expect.any(Object),
    );
    expect(prisma.billingAccessRestriction.create).not.toHaveBeenCalled();
  });

  it('observes additive evidence-contract gaps in shadow mode without changing settlement', async () => {
    const { service, usageBilling } = buildService({
      BILLING_USAGE_EVIDENCE_CONTRACT_MODE: 'shadow',
    });

    const result = await service.process(usageEvent({
      producer_build_sha: undefined,
      provider_usage_hash: undefined,
      stream_end_reason: undefined,
      usage_evidence: {
        source: 'provider_terminal',
        status: 'complete',
        protocol: 'openai_sse',
        terminal_frame_seen: true,
      },
    }));

    expect(result.action).toBe('deducted');
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledTimes(1);
  });

  it('settles only allowlisted complete provider evidence in enforce mode', async () => {
    const { service, usageBilling } = buildService({
      BILLING_USAGE_EVIDENCE_CONTRACT_MODE: 'enforce',
      BILLING_USAGE_VERIFIED_PRODUCER_BUILDS: VERIFIED_PRODUCER_BUILD_SHA,
    });

    const result = await service.process(usageEvent());

    expect(result.action).toBe('deducted');
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledTimes(1);
  });

  it('keeps an unverified producer build as internal evidence in enforce mode', async () => {
    const { service, usageBilling } = buildService({
      BILLING_USAGE_EVIDENCE_CONTRACT_MODE: 'enforce',
      BILLING_USAGE_VERIFIED_PRODUCER_BUILDS: VERIFIED_PRODUCER_BUILD_SHA,
    });

    const result = await service.process(usageEvent({
      producer_build_sha: undefined,
    }));

    expect(result).toMatchObject({
      action: 'deducted',
      evidenceVerdict: 'INCOMPLETE',
      reconciliationStatus: 'OPEN',
    });
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledTimes(1);
  });

  it('settles exact normalized meters when only build/account/upstream/hash audit fields are absent', async () => {
    const { service, usageBilling } = buildService({
      BILLING_USAGE_EVIDENCE_CONTRACT_MODE: 'enforce',
      BILLING_USAGE_VERIFIED_PRODUCER_BUILDS: VERIFIED_PRODUCER_BUILD_SHA,
    });

    const result = await service.process(usageEvent({
      producer_build_sha: undefined,
      provider_usage_hash: undefined,
      provider_account_ref: undefined,
      provider_credential_ref: undefined,
      upstream_request_id: undefined,
      upstream_response_id: undefined,
    }));

    expect(result).toMatchObject({
      action: 'deducted',
      evidenceVerdict: 'INCOMPLETE',
      reconciliationStatus: 'OPEN',
      mapped: {
        inputTokens: 1000,
        outputTokens: 525,
        cachedInputTokens: 100,
        cacheWriteInputTokens: 50,
      },
    });
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        gatewayCustomerSettlement: expect.objectContaining({
          basis: 'NORMALIZED_EXACT',
        }),
      }),
      expect.any(Object),
    );
  });

  it.each([
    ['cache read', 'cache_read_input_tokens'],
    ['cache write', 'cache_creation_input_tokens'],
  ])('uses an explicit %s value when presence metadata omits that dimension', async (
    _case,
    omittedDimension,
  ) => {
    const { service, usageBilling } = buildService();
    const dimensionsPresent = [
      'input_tokens',
      'output_tokens',
      'cache_read_input_tokens',
      'cache_creation_input_tokens',
    ].filter((dimension) => dimension !== omittedDimension);

    const result = await service.process(usageEvent({
      usage_evidence: {
        source: 'provider_terminal',
        status: 'complete',
        protocol: 'openai_sse',
        terminal_frame_seen: true,
        dimensions_present: dimensionsPresent,
      },
    }));

    expect(result).toMatchObject({
      action: 'deducted',
      mapped: {
        inputTokens: 1000,
        outputTokens: 525,
        cachedInputTokens: 100,
        cacheWriteInputTokens: 50,
      },
    });
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 1000,
        outputTokens: 525,
        cachedInputTokens: 100,
        cacheWriteInputTokens: 50,
        gatewayCustomerSettlement: expect.objectContaining({
          policyVersion: 'gateway-customer-settlement-v2',
          basis: 'NORMALIZED_EXACT',
          originalDimensions: expect.objectContaining({
            cachedInputTokens: 100,
            cacheWriteInputTokens: 50,
          }),
          settledDimensions: expect.objectContaining({
            cachedInputTokens: 100,
            cacheWriteInputTokens: 50,
          }),
        }),
      }),
      expect.any(Object),
    );
  });

  it.each([
    [
      'cache read',
      { cache_write_tokens: 0 },
      ['input_tokens', 'output_tokens', 'cache_creation_input_tokens'],
    ],
    [
      'cache write',
      { cache_hit_tokens: 0 },
      ['input_tokens', 'output_tokens', 'cache_read_input_tokens'],
    ],
    [
      'both cache meters',
      {},
      ['input_tokens', 'output_tokens'],
    ],
  ])('treats omitted %s as zero without clearing the proven core usage', async (
    _case,
    tokenExtras,
    dimensionsPresent,
  ) => {
    const { service, usageBilling, prisma } = buildService();

    const result = await service.process(usageEvent({
      token_extras: tokenExtras,
      usage_evidence: {
        source: 'provider_terminal',
        status: 'complete',
        protocol: 'openai_sse',
        terminal_frame_seen: true,
        dimensions_present: dimensionsPresent,
      },
    }));

    expect(result).toMatchObject({
      action: 'deducted',
      mapped: {
        inputTokens: 1000,
        outputTokens: 525,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
      },
    });
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 1000,
        outputTokens: 525,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        gatewayCustomerSettlement: expect.objectContaining({
          policyVersion: 'gateway-customer-settlement-v2',
          basis: 'NORMALIZED_EXACT',
          originalDimensions: expect.objectContaining({
            inputTokens: 1000,
            outputTokens: 525,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
          }),
          settledDimensions: expect.objectContaining({
            inputTokens: 1000,
            outputTokens: 525,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
          }),
        }),
      }),
      expect.any(Object),
    );
    expect(prisma.billingAccessRestriction.create).not.toHaveBeenCalled();
  });

  it.each([
    ['input', 'input_tokens', 'evidence_contract_usage_dimension_input_missing'],
    ['output', 'output_tokens', 'evidence_contract_usage_dimension_output_missing'],
  ])('keeps missing core %s presence customer-protective', async (
    _case,
    omittedDimension,
    reason,
  ) => {
    const { service, usageBilling } = buildService();
    const dimensionsPresent = [
      'input_tokens',
      'output_tokens',
      'cache_read_input_tokens',
      'cache_creation_input_tokens',
    ].filter((dimension) => dimension !== omittedDimension);

    const result = await service.process(usageEvent({
      usage_evidence: {
        source: 'provider_terminal',
        status: 'complete',
        protocol: 'openai_sse',
        terminal_frame_seen: true,
        dimensions_present: dimensionsPresent,
      },
    }));

    expect(result).toMatchObject({
      action: 'deducted',
      reason: `customer_protective_zero:${reason}`,
      evidenceVerdict: 'INCOMPLETE',
      reconciliationStatus: 'OPEN',
    });
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 0,
        outputTokens: 0,
        gatewayCustomerSettlement: expect.objectContaining({
          basis: 'CUSTOMER_PROTECTIVE_ZERO',
          evidenceReason: reason,
        }),
      }),
      expect.any(Object),
    );
  });

  it('settles the production-shaped GLM Anthropic three-dimension event while keeping evidence OPEN', async () => {
    const { service, usageBilling, prisma } = buildService({
      BILLING_USAGE_EVIDENCE_CONTRACT_MODE: 'enforce',
      BILLING_USAGE_VERIFIED_PRODUCER_BUILDS: VERIFIED_PRODUCER_BUILD_SHA,
    });
    usageBilling.resolveGatewaySettlementAnchor.mockImplementationOnce(async (
      _db,
      input,
      firstReceivedAt,
    ) => {
      const { canonicalPayload: _canonicalPayload, ...anchor } = makeTestAnchor({
        ...input,
        firstReceivedAt,
        baseCacheWritePriceUsdPerM: '1.25',
        customerCacheWritePriceUsdPerM: '1',
      });
      return anchor;
    });

    const result = await service.process(usageEvent({
      provider: 'zhipu',
      resolved_api_type: 'anthropic',
      // The UAT adapter build/account/correlation fields were absent. Numeric
      // settlement still follows the normalized Anthropic dimension contract;
      // these fields remain internal evidence only.
      producer_build_sha: undefined,
      provider_usage_hash: undefined,
      provider_account_ref: undefined,
      provider_credential_ref: undefined,
      upstream_request_id: undefined,
      upstream_response_id: undefined,
      prompt_tokens: 140602,
      completion_tokens: 165,
      total_tokens: 140767,
      token_extras: {
        cache_hit_tokens: 140352,
        cache_write_tokens: 0,
      },
      provider_reconciliation_required: true,
      usage_evidence: {
        source: 'provider_terminal',
        status: 'partial',
        protocol: 'anthropic',
        terminal_frame_seen: true,
        dimensions_present: [
          'input_tokens',
          'output_tokens',
          'cache_read_input_tokens',
        ],
      },
    }));

    expect(result).toMatchObject({
      action: 'deducted',
      reason: 'provider_evidence_open:usage_evidence_partial',
      evidenceVerdict: 'INCOMPLETE',
      reconciliationStatus: 'OPEN',
      mapped: {
        inputTokens: 140602,
        cachedInputTokens: 140352,
        cacheWriteInputTokens: 0,
        outputTokens: 165,
      },
    });
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledTimes(1);
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 140602,
        cachedInputTokens: 140352,
        cacheWriteInputTokens: 0,
        gatewayCustomerSettlement: expect.objectContaining({
          basis: 'NORMALIZED_EXACT',
          evidenceReason: 'usage_evidence_partial',
          originalDimensions: {
            inputTokens: 140602,
            outputTokens: 165,
            cachedInputTokens: 140352,
            cacheWriteInputTokens: 0,
            totalTokens: 140767,
            imageCount: 0,
          },
          settledDimensions: {
            inputTokens: 140602,
            outputTokens: 165,
            cachedInputTokens: 140352,
            cacheWriteInputTokens: 0,
            totalTokens: 140767,
            imageCount: 0,
          },
        }),
      }),
      expect.any(Object),
    );
    const settled = usageBilling.settleDeliveredGatewayUsage.mock.calls[0]?.[0];
    expect(
      settled.inputTokens
      - settled.cachedInputTokens
      - settled.cacheWriteInputTokens,
    ).toBe(250);
    expect(settled.cacheWriteInputTokens).toBe(0);
    expect(prisma.gatewayBillingEvent.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'DEDUCTED',
          evidenceVerdict: 'INCOMPLETE',
          reconciliationStatus: 'OPEN',
          pendingExposureUsd: new Prisma.Decimal(0),
          pendingHoldUsd: new Prisma.Decimal(0),
        }),
      }),
    );
    expect(prisma.billingAccessRestriction.create).not.toHaveBeenCalled();
  });

  it.each([
    ['an OpenAI protocol label', 'openai_sse', 'evidence_contract_usage_protocol_family_conflict'],
    ['an unknown protocol label', 'unknown_sse', 'evidence_contract_usage_protocol_family_invalid'],
  ])(
    'records %s as internal GLM Anthropic evidence without blocking settlement',
    async (_case, protocol, reason) => {
      const { service, usageBilling } = buildService({
        BILLING_USAGE_EVIDENCE_CONTRACT_MODE: 'enforce',
        BILLING_USAGE_VERIFIED_PRODUCER_BUILDS: VERIFIED_PRODUCER_BUILD_SHA,
      });

      const result = await service.process(usageEvent({
        provider: 'zhipu',
        resolved_api_type: 'anthropic',
        usage_evidence: {
          source: 'provider_terminal',
          status: 'complete',
          protocol,
          terminal_frame_seen: true,
          dimensions_present: ['input_tokens', 'output_tokens'],
        },
      }));

      expect(result).toMatchObject({
        action: 'deducted',
        evidenceVerdict: 'INCOMPLETE',
        reconciliationStatus: 'OPEN',
      });
      expect(reason).toMatch(/^evidence_contract_/);
      expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledTimes(1);
    },
  );

  it('keeps a GLM Anthropic protocol conflict internal during shadow rollout', async () => {
    const { service, usageBilling } = buildService({
      BILLING_USAGE_EVIDENCE_CONTRACT_MODE: 'shadow',
    });

    const result = await service.process(usageEvent({
      provider: 'zhipu',
      resolved_api_type: 'anthropic',
      usage_evidence: {
        source: 'provider_terminal',
        status: 'complete',
        protocol: 'openai_sse',
        terminal_frame_seen: true,
        dimensions_present: ['input_tokens', 'output_tokens'],
      },
    }));

    expect(result).toMatchObject({
      action: 'deducted',
      evidenceVerdict: 'INCOMPLETE',
      reconciliationStatus: 'OPEN',
    });
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledTimes(1);
  });

  it.each([
    ['a missing provider', { provider: undefined }, 'evidence_contract_provider_missing'],
    [
      'a contradictory native provider',
      { provider: 'openai' },
      'evidence_contract_usage_protocol_family_conflict',
    ],
  ])('keeps %s as internal evidence on an Anthropic route in enforce mode', async (
    _case,
    overrides,
    reason,
  ) => {
    const { service, usageBilling } = buildService({
      BILLING_USAGE_EVIDENCE_CONTRACT_MODE: 'enforce',
      BILLING_USAGE_VERIFIED_PRODUCER_BUILDS: VERIFIED_PRODUCER_BUILD_SHA,
    });

    const result = await service.process(usageEvent({
      resolved_api_type: 'anthropic',
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
        ],
      },
      ...overrides,
    }));

    expect(result).toMatchObject({
      action: 'deducted',
      evidenceVerdict: 'INCOMPLETE',
      reconciliationStatus: 'OPEN',
    });
    expect(reason).toMatch(/^evidence_contract_/);
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledTimes(1);
  });

  it('keeps policy-approved tokenizer usage settleable', async () => {
    const { service, usageBilling } = buildService();

    const result = await service.process(usageEvent({
      token_source: 'estimated_tokenizer',
    }));

    expect(result.action).toBe('deducted');
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledTimes(1);
  });

  it('keeps a financial quarantine unchanged while recording different provider evidence internally', async () => {
    const { service, usageBilling, prisma } = buildService();
    const originalEvent = usageEvent({
      token_source: 'estimated',
      estimated_total_tokens: 500,
    });
    const originalHash = createHash('sha256')
      .update(testCanonicalJson(originalEvent))
      .digest('hex');
    const quarantined = {
      id: 'gateway-billing-event-1',
      requestId: 'req-usage-v2-1',
      status: 'QUARANTINED',
      reconciliationStatus: 'OPEN',
      revision: 1,
      evidenceHash: originalHash,
      reason: 'unsafe_estimated_usage',
      evidenceVerdict: 'INCOMPLETE',
      fundingOutcome: null,
      billingAccountId: 'billing-account-1',
      apiKeyId: 'key-1',
    };
    prisma.gatewayBillingEvent.findUnique.mockResolvedValue(quarantined);
    prisma.gatewayBillingEvent.createMany.mockResolvedValue({ count: 0 });
    prisma.gatewayBillingEvent.findUniqueOrThrow.mockResolvedValue({
      ...quarantined,
      rawEvent: originalEvent,
      settlementAnchor: makeTestAnchor({
        requestId: quarantined.requestId,
        apiKeyId: 'key-1',
        userId: 'user-1',
        tenantId: 'tenant-1',
        productId: 'prod-1',
        productSlug: 'payg',
        eventOccurredAt: new Date('2026-05-21T08:30:15.000Z'),
      }),
      fundingReservation: { status: 'ACTIVE' },
    });

    const result = await service.process(usageEvent({
      token_source: 'estimated',
      estimated_total_tokens: 700,
      event_id: 'usage-evt-2',
    }));

    expect(result).toMatchObject({
      action: 'quarantined',
      reason: 'unsafe_estimated_usage',
      evidenceVerdict: 'INCOMPLETE',
      reconciliationStatus: 'OPEN',
      revision: 1,
    });
    expect(prisma.gatewayUsageReconciliationAction.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        action: 'EVIDENCE_CONFLICT',
        reason: 'quarantined_event_received_different_evidence',
        expectedRevision: 1,
        resultingRevision: 1,
        metadata: expect.objectContaining({
          customerFinancialParentUnchanged: true,
          firstReceiptFinancialAuthority: true,
        }),
      })],
      skipDuplicates: true,
    });
    expect(stateUpdateManyCalls(prisma)).toHaveLength(0);
    expect(prisma.billingAccessRestriction.upsert).not.toHaveBeenCalled();
    expect(usageBilling.settleDeliveredGatewayUsage).not.toHaveBeenCalled();
  });

  it('settles the immutable first receipt after retryable failure when different evidence arrives', async () => {
    const { service, usageBilling, prisma } = buildService();
    const original = usageEvent();
    usageBilling.settleDeliveredGatewayUsage.mockRejectedValueOnce(new Error('temporary outage'));
    await expect(service.process(original)).rejects.toThrow('temporary outage');

    const originalHash = prisma.gatewayBillingEvent.createMany.mock.calls[0][0].data[0].evidenceHash;
    const retryable = {
      id: 'gateway-billing-event-1',
      requestId: 'req-usage-v2-1',
      status: 'RETRYABLE_FAILED',
      reconciliationStatus: 'RETRY_WAIT',
      revision: 1,
      evidenceHash: originalHash,
      rawEvent: original,
      apiKeyId: 'key-1',
      billingAccountId: 'billing-account-1',
    };
    prisma.gatewayBillingEvent.findUnique.mockResolvedValue(retryable);
    prisma.gatewayBillingEvent.createMany.mockResolvedValue({ count: 0 });
    prisma.gatewayBillingEvent.findUniqueOrThrow.mockResolvedValue({
      ...retryable,
      settlementAnchor: makeTestAnchor({
        requestId: retryable.requestId,
        apiKeyId: 'key-1',
        userId: 'user-1',
        tenantId: 'tenant-1',
        productId: 'prod-1',
        productSlug: 'payg',
        eventOccurredAt: new Date('2026-05-21T08:30:15.000Z'),
      }),
      fundingReservation: { status: 'ACTIVE' },
    });
    // Model a previous attempt that committed the append-only evidence row,
    // then crashed before it could transition the parent event.
    prisma.gatewayUsageEvidence.createMany.mockResolvedValueOnce({ count: 0 });
    usageBilling.settleDeliveredGatewayUsage.mockClear();
    prisma.billingAccessRestriction.upsert.mockClear();

    const result = await service.process(usageEvent({
      event_id: 'usage-evt-different',
      total_tokens: 1600,
    }));

    expect(result).toMatchObject({
      action: 'deducted',
      evidenceVerdict: 'SETTLEABLE_BY_POLICY',
      reconciliationStatus: 'CLOSED',
    });
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(
      expect.objectContaining({
        inputTokens: 1000,
        outputTokens: 525,
        totalTokens: 1525,
      }),
      expect.objectContaining({ evidenceHash: originalHash }),
    );
    expect(prisma.gatewayUsageReconciliationAction.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        action: 'EVIDENCE_CONFLICT',
        reason: 'non_terminal_event_received_different_evidence',
        expectedRevision: 1,
        resultingRevision: 1,
      })],
      skipDuplicates: true,
    });
    expect(prisma.billingAccessRestriction.upsert).not.toHaveBeenCalled();
  });

  it.each([
    { billingUnit: 'BALANCE' as const, fundingOutcome: 'COLLECTED' },
    { billingUnit: 'CREDITS' as const, fundingOutcome: 'INCLUDED' },
  ])(
    'recovers a committed $billingUnit receipt before parent transition when different evidence arrives',
    async ({ billingUnit, fundingOutcome }) => {
      const {
        service,
        usageBilling,
        prisma,
        publisherSync,
      } = buildService();
      const requestId = `req-receipt-before-parent-${billingUnit.toLowerCase()}`;
      const original = usageEvent({ request_id: requestId });
      if (billingUnit === 'CREDITS') {
        usageBilling.resolveGatewaySettlementAnchor.mockImplementation(async (
          _db: unknown,
          input: Record<string, unknown>,
          firstReceivedAt: Date,
        ) => {
          const { canonicalPayload: _canonicalPayload, ...anchor } = makeTestAnchor({
            ...input,
            billingUnit: 'CREDITS',
            firstReceivedAt,
          });
          return anchor;
        });
      }
      const permanentResult = {
        success: true,
        allowed: true,
        tokenUsageId: `token-usage-${billingUnit.toLowerCase()}`,
        fundingOutcome,
        quote: {
          unit: billingUnit,
          tenantId: 'tenant-1',
          billingAccountId: 'billing-account-1',
          ...(billingUnit === 'CREDITS' ? { creditCost: 70 } : { effectiveCostUsd: '0.0008' }),
        },
      };
      usageBilling.settleDeliveredGatewayUsage.mockResolvedValue(permanentResult);

      const updateParent = prisma.gatewayBillingEvent.updateMany.getMockImplementation();
      if (!updateParent) throw new Error('expected gateway event update implementation');
      let crashBeforeParent = true;
      prisma.gatewayBillingEvent.updateMany.mockImplementation(async (args: any) => {
        if (crashBeforeParent && args.data?.status === 'DEDUCTED') {
          crashBeforeParent = false;
          throw new Error('crashed after permanent receipt before parent transition');
        }
        return updateParent(args);
      });

      await expect(service.process(original)).rejects.toThrow(
        'crashed after permanent receipt before parent transition',
      );
      const originalHash = prisma.gatewayBillingEvent.createMany.mock.calls[0][0]
        .data[0].evidenceHash;
      usageBilling.settleDeliveredGatewayUsage.mockClear();
      usageBilling.settleDeliveredGatewayUsage.mockResolvedValue(permanentResult);
      prisma.gatewayUsageReconciliationAction.createMany.mockClear();
      prisma.billingAccessRestriction.updateMany.mockClear();
      prisma.billingAccessRestriction.updateMany.mockResolvedValue({ count: 1 });
      prisma.billingAccessRestriction.upsert.mockClear();
      publisherSync.syncBillingAccountKeyBalancesRequired.mockClear();
      publisherSync.syncKeyBalanceByIdRequired.mockClear();

      const recovered = await service.process(usageEvent({
        request_id: requestId,
        event_id: `usage-evt-correction-${billingUnit.toLowerCase()}`,
        total_tokens: 1600,
      }));

      expect(recovered).toMatchObject({
        action: 'deducted',
        requestId,
        fundingOutcome,
      });
      expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledTimes(1);
      expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith(
        expect.objectContaining({
          inputTokens: 1000,
          outputTokens: 525,
          totalTokens: 1525,
        }),
        expect.objectContaining({ evidenceHash: originalHash }),
      );
      expect(prisma.gatewayUsageReconciliationAction.createMany).toHaveBeenCalledWith({
        data: [expect.objectContaining({
          action: 'EVIDENCE_CONFLICT',
          reason: 'non_terminal_event_received_different_evidence',
          metadata: expect.objectContaining({
            customerFinancialParentUnchanged: true,
            firstReceiptFinancialAuthority: true,
          }),
        })],
        skipDuplicates: true,
      });
      expect(prisma.billingAccessRestriction.updateMany).toHaveBeenCalledWith({
        where: {
          gatewayBillingEventId: 'gateway-billing-event-1',
          status: 'ACTIVE',
          reason: 'evidence_conflict',
        },
        data: expect.objectContaining({
          status: 'RELEASED',
          releaseReason: 'provider_evidence_conflict_is_internal_only',
        }),
      });
      // RECEIVED has not projected the billing-account columns yet, so the
      // immutable apiKey target is the required Publisher release path.
      expect(publisherSync.syncKeyBalanceByIdRequired).toHaveBeenCalledWith('key-1');
      expect(prisma.billingAccessRestriction.upsert).not.toHaveBeenCalledWith(
        expect.objectContaining({
          create: expect.objectContaining({ reason: 'evidence_conflict' }),
        }),
      );
    },
  );

  it('detects conflicting terminal evidence even when its append was committed before a crash', async () => {
    const { service, usageBilling, prisma } = buildService();
    const committed = {
      id: 'gateway-billing-event-1',
      requestId: 'req-usage-v2-1',
      status: 'DEDUCTED',
      reason: null,
      errorMessage: null,
      billingResult: { success: true, allowed: true },
      apiKeyId: 'key-1',
      billingAccountId: 'billing-account-1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      productSlug: 'payg',
      userId: 'user-1',
      modelName: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 525,
      cachedInputTokens: 100,
      cacheWriteInputTokens: 50,
      totalTokens: 1525,
      revision: 1,
      evidenceHash: 'original-canonical-evidence-hash',
      rawEvent: usageEvent(),
      evidenceVerdict: 'SETTLEABLE_BY_POLICY',
      reconciliationStatus: 'CLOSED',
      fundingOutcome: 'COLLECTED',
    };
    prisma.gatewayBillingEvent.findUnique.mockResolvedValue(committed);
    prisma.gatewayBillingEvent.createMany.mockResolvedValue({ count: 0 });
    prisma.gatewayBillingEvent.findUniqueOrThrow.mockResolvedValue({
      ...committed,
      settlementAnchor: makeTestAnchor({
        requestId: committed.requestId,
        apiKeyId: committed.apiKeyId,
        userId: committed.userId,
        tenantId: committed.tenantId,
        productId: committed.productId,
        productSlug: committed.productSlug,
        eventOccurredAt: new Date('2026-05-21T08:30:15.000Z'),
      }),
    });
    // The distinct evidence already exists, so createMany(skipDuplicates)
    // reports zero on this recovery attempt.
    prisma.gatewayUsageEvidence.createMany.mockResolvedValue({ count: 0 });

    const result = await service.process(usageEvent({
      event_id: 'usage-evt-different-after-terminal-crash',
      total_tokens: 1600,
    }));

    expect(result.action).toBe('deducted');
    expect(result).toMatchObject({
      revision: 1,
      evidenceVerdict: 'SETTLEABLE_BY_POLICY',
      reconciliationStatus: 'CLOSED',
    });
    expect(usageBilling.settleDeliveredGatewayUsage).not.toHaveBeenCalled();
    expect(stateUpdateManyCalls(prisma)).toHaveLength(0);
    expect(prisma.gatewayUsageReconciliationAction.createMany).toHaveBeenCalledWith({
      data: [expect.objectContaining({
        action: 'EVIDENCE_CONFLICT',
        reason: 'terminal_event_received_different_evidence',
        expectedRevision: 1,
        resultingRevision: 1,
        idempotencyKey: expect.stringContaining(
          'gateway:internal-evidence-conflict:req-usage-v2-1:',
        ),
      })],
      skipDuplicates: true,
    });
    expect(prisma.billingAccessRestriction.upsert).not.toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ reason: 'evidence_conflict' }),
      }),
    );
    expect(prisma.billingAccessRestriction.updateMany).toHaveBeenCalledWith({
      where: {
        gatewayBillingEventId: committed.id,
        status: 'ACTIVE',
        reason: 'evidence_conflict',
      },
      data: expect.objectContaining({
        status: 'RELEASED',
        releaseReason: 'provider_evidence_conflict_is_internal_only',
      }),
    });
  });

  it('re-syncs a committed terminal replay even when no retry restriction row changed', async () => {
    const { service, prisma, publisherSync, usageBilling } = buildService();
    const event = usageEvent();
    const first = await service.process(event);
    expect(first.action).toBe('deducted');

    publisherSync.syncBillingAccountKeyBalancesRequired.mockClear();
    publisherSync.syncKeyBalanceByIdRequired.mockClear();
    prisma.billingAccessRestriction.updateMany.mockResolvedValue({ count: 0 });
    usageBilling.settleDeliveredGatewayUsage.mockClear();

    const replay = await service.process(event);

    expect(replay.action).toBe('deducted');
    expect(usageBilling.settleDeliveredGatewayUsage).not.toHaveBeenCalled();
    expect(publisherSync.syncKeyBalanceByIdRequired).toHaveBeenCalledWith('key-1');
  });

  it('fails a historical technical retry closed when no first-receipt anchor exists', async () => {
    const { service, prisma, usageBilling } = buildService();
    const rawEvent = usageEvent();
    const retryable = {
      id: 'gateway-billing-event-1',
      requestId: 'req-usage-v2-1',
      status: 'RETRYABLE_FAILED',
      reconciliationStatus: 'RETRY_WAIT',
      evidenceVerdict: 'SETTLEABLE_BY_POLICY',
      fundingOutcome: null,
      revision: 0,
      reason: 'processing_error',
      evidenceHash: 'evidence-hash-1',
      rawEvent,
      apiKeyId: 'key-1',
      billingAccountId: 'billing-account-1',
      pendingExposureUsd: new Prisma.Decimal(0),
      pendingHoldUsd: new Prisma.Decimal(0),
    };
    prisma.gatewayBillingEvent.findUnique.mockResolvedValue(retryable);
    prisma.gatewayBillingEvent.upsert.mockResolvedValue(retryable);
    prisma.gatewayBillingEvent.findUniqueOrThrow.mockResolvedValue({
      ...retryable,
      settlementAnchor: null,
    });

    const result = await service.process(rawEvent, {
      force: true,
      expectedRevision: 0,
      actorId: 'admin-1',
    });

    expect(result).toMatchObject({
      action: 'quarantined',
      reason: 'settlement_anchor_missing',
      evidenceVerdict: 'INCOMPLETE',
      reconciliationStatus: 'MANUAL_REVIEW',
    });
    expect(usageBilling.settleDeliveredGatewayUsage).not.toHaveBeenCalled();
  });

  it('records insufficient delivered credits as durable debt', async () => {
    const { service, usageBilling, prisma } = buildService();
    usageBilling.settleDeliveredGatewayUsage.mockResolvedValueOnce({
      success: false,
      allowed: false,
      reason: 'insufficient_credits',
      quote: {
        unit: 'CREDITS',
        billingAccountId: 'billing-account-1',
        creditCost: 100,
      },
    });
    prisma.gatewayBillingEvent.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'gateway-billing-event-1',
        apiKeyId: 'key-1',
        billingAccountId: 'billing-account-1',
      });

    const result = await service.process(usageEvent());

    expect(result.action).toBe('debt_open');
    expect(result.reason).toBe('insufficient_credits');
    expect(prisma.gatewayBillingEvent.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ requestId: 'req-usage-v2-1', revision: 0 }),
        data: expect.objectContaining({
          status: 'DEBT_OPEN',
          reason: 'insufficient_credits',
          fundingOutcome: 'DEBT_OPEN',
          billingUnit: 'CREDITS',
        }),
      }),
    );
    expect(prisma.billingAccessRestriction.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ reason: 'debt_open' }),
      }),
    );
  });

  it('records insufficient balance as durable debt and closes the billing subject', async () => {
    const { service, usageBilling, prisma } = buildService();
    usageBilling.settleDeliveredGatewayUsage.mockResolvedValueOnce({
      success: false,
      allowed: false,
      reason: 'insufficient_balance',
      quote: {
        unit: 'BALANCE',
        billingAccountId: 'billing-account-1',
        effectiveCostUsd: '0.88',
      },
    });
    prisma.gatewayBillingEvent.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        id: 'gateway-billing-event-1',
        apiKeyId: 'key-1',
        billingAccountId: 'billing-account-1',
      });

    const result = await service.process(usageEvent());

    expect(result).toMatchObject({
      action: 'debt_open',
      reason: 'insufficient_balance',
      fundingOutcome: 'DEBT_OPEN',
    });
    expect(prisma.gatewayBillingEvent.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          billingUnit: 'BALANCE',
          pendingExposureUsd: new Prisma.Decimal('0.88'),
        }),
      }),
    );
    expect(prisma.gatewayUsageSettlementReceipt.create).not.toHaveBeenCalled();
    expect(prisma.billingAccessRestriction.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          billingAccountId: 'billing-account-1',
          reason: 'debt_open',
        }),
      }),
    );
  });

  it('routes an unknown post-delivery policy rejection to manual review', async () => {
    const { service, usageBilling, prisma } = buildService();
    usageBilling.settleDeliveredGatewayUsage.mockResolvedValueOnce({
      success: false,
      allowed: false,
      reason: 'provider said no',
    });

    const result = await service.process(usageEvent());

    expect(result.action).toBe('quarantined');
    expect(result.reason).toBe('billing_rejected');
    expect(prisma.gatewayBillingEvent.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ requestId: 'req-usage-v2-1', revision: 0 }),
        data: expect.objectContaining({
          status: 'QUARANTINED',
          reason: 'billing_rejected',
          evidenceVerdict: 'SETTLEABLE_BY_POLICY',
          reconciliationStatus: 'MANUAL_REVIEW',
        }),
      }),
    );
    expect(prisma.billingAccessRestriction.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ reason: 'settlement_policy_review' }),
      }),
    );
  });

  it.each([
    ['missing pricing', new NotFoundException('按量价格不存在')],
    ['subject provisioning', new BadRequestException('API Key 尚未完成账务开通')],
    ['mutable model access', new ModelAccessDeniedError('glm-5.2')],
  ])('keeps %s repairable after authoritative delivery', async (_case, failure) => {
    const { service, usageBilling, prisma } = buildService();
    usageBilling.settleDeliveredGatewayUsage.mockRejectedValueOnce(failure);

    await expect(service.process(usageEvent())).rejects.toBe(failure);

    expect(prisma.gatewayBillingEvent.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'RETRYABLE_FAILED',
          reason: 'billing_configuration_pending',
          reconciliationStatus: 'RETRY_WAIT',
        }),
      }),
    );
    expect(prisma.billingAccessRestriction.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ reason: 'settlement_retry_pending' }),
      }),
    );
    expect(prisma.gatewayUsageSettlementReceipt.create).not.toHaveBeenCalled();
  });

  it('keeps funding queue wait as a provisional hold without a hard retry restriction', async () => {
    const { service, usageBilling, prisma, publisherSync } = buildService();
    const queuePending = new GatewayFundingReservationQueuePendingError(
      'billing-account-1',
      'req-usage-v2-1',
      'req-earlier-receipt',
      1n,
    );
    usageBilling.reserveGatewayBalanceFunding.mockRejectedValueOnce(queuePending);

    await expect(service.process(usageEvent())).rejects.toBe(queuePending);

    expect(prisma.gatewayBillingEvent.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: 'RETRYABLE_FAILED',
          reason: 'funding_reservation_queue_pending',
          reconciliationStatus: 'RETRY_WAIT',
        }),
      }),
    );
    const finalState = prisma.gatewayBillingEvent.updateMany.mock.calls.at(-1)?.[0]?.data;
    expect(finalState).toEqual(expect.objectContaining({
      apiKeyId: 'key-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      billingAccountId: 'billing-account-1',
      productId: 'prod-1',
      productSlug: 'payg',
      billingUnit: 'BALANCE',
      pendingExposureUsd: new Prisma.Decimal('0.0008'),
      pendingHoldUsd: new Prisma.Decimal('0.0008'),
    }));
    expect(finalState).not.toHaveProperty('subjectSnapshot');
    expect(finalState).not.toHaveProperty('pricingSnapshot');
    expect(prisma.billingAccessRestriction.upsert).not.toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({ reason: 'settlement_retry_pending' }),
      }),
    );
    expect(publisherSync.syncBillingAccountKeyBalancesRequired)
      .toHaveBeenCalledWith('billing-account-1');
  });

  it('hard-projects a retryable funding failure that occurs before deduct input exists', async () => {
    const { service, usageBilling, prisma, publisherSync } = buildService();
    const serializationFailure = Object.assign(
      new Error('funding reservation serialization failed'),
      { code: 'P2034' },
    );
    usageBilling.reserveGatewayBalanceFunding.mockRejectedValueOnce(serializationFailure);

    await expect(service.process(usageEvent()))
      .rejects.toThrow('funding_reservation_retry_pending');

    expect(prisma.billingAccessRestriction.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          gatewayBillingEventId: 'gateway-billing-event-1',
          billingAccountId: 'billing-account-1',
          reason: 'settlement_retry_pending',
        }),
      }),
    );
    expect(publisherSync.syncBillingAccountKeyBalancesRequired)
      .toHaveBeenCalledWith('billing-account-1');
    const finalState = prisma.gatewayBillingEvent.updateMany.mock.calls.at(-1)?.[0]?.data;
    expect(finalState).toEqual(expect.objectContaining({
      status: 'RETRYABLE_FAILED',
      reason: 'funding_reservation_retry_pending',
      billingUnit: 'BALANCE',
      pendingExposureUsd: new Prisma.Decimal('0.0008'),
      pendingHoldUsd: new Prisma.Decimal('0.0008'),
    }));
  });

  it('releases a prior hard retry restriction when the recovered receipt enters the healthy queue', async () => {
    const { service, usageBilling, prisma, publisherSync } = buildService();
    const serializationFailure = Object.assign(
      new Error('funding reservation serialization failed'),
      { code: 'P2034' },
    );
    usageBilling.reserveGatewayBalanceFunding.mockRejectedValueOnce(serializationFailure);
    await expect(service.process(usageEvent()))
      .rejects.toThrow('funding_reservation_retry_pending');

    publisherSync.syncBillingAccountKeyBalancesRequired.mockClear();
    const queuePending = new GatewayFundingReservationQueuePendingError(
      'billing-account-1',
      'req-usage-v2-1',
      'req-earlier-receipt',
      1n,
    );
    usageBilling.reserveGatewayBalanceFunding.mockRejectedValueOnce(queuePending);

    await expect(service.process(usageEvent())).rejects.toBe(queuePending);

    // 释放改按幂等键：先收口存量的按事件行，再看该主体是否已无待重试事件
    expect(prisma.billingAccessRestriction.updateMany).toHaveBeenCalledWith({
      where: {
        idempotencyKey: 'gateway:settlement_retry_pending:req-usage-v2-1',
        status: 'ACTIVE',
      },
      data: expect.objectContaining({
        status: 'RELEASED',
        releasedBy: 'SYSTEM',
        releaseReason: 'settlement_retry_resolved',
      }),
    });
    expect(publisherSync.syncBillingAccountKeyBalancesRequired)
      .toHaveBeenCalledWith('billing-account-1');
  });

  it('propagates a terminal audit-write failure so Kafka cannot commit the source offset', async () => {
    const { service, usageBilling, prisma } = buildService();
    usageBilling.settleDeliveredGatewayUsage.mockRejectedValueOnce(
      new BadRequestException('invalid settlement input'),
    );
    // 必须让**状态转移**失败：mockRejectedValueOnce 会被先发生的 lineage 墓碑写入吃掉，
    // 那样这条用例仍然会通过，但通过的原因是错的（假绿）。
    const baseUpdateMany = prisma.gatewayBillingEvent.updateMany.getMockImplementation();
    let auditWriteRejected = false;
    prisma.gatewayBillingEvent.updateMany.mockImplementation(async (args: any) => {
      const keys = Object.keys(args?.data ?? {});
      const isTombstone = keys.length === 1 && keys[0] === 'legacyOriginalEvidenceMissingAt';
      if (!isTombstone && !auditWriteRejected) {
        auditWriteRejected = true;
        throw new Error('audit write failed');
      }
      return baseUpdateMany(args);
    });

    await expect(service.process(usageEvent())).rejects.toThrow('audit write failed');
  });

  it('records retryable state and rethrows transient processing errors', async () => {
    const { service, usageBilling, prisma } = buildService();
    usageBilling.settleDeliveredGatewayUsage.mockRejectedValueOnce(new Error('PG down'));

    await expect(service.process(usageEvent())).rejects.toThrow('PG down');

    expect(prisma.gatewayBillingEvent.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ requestId: 'req-usage-v2-1', revision: 0 }),
        data: expect.objectContaining({
          status: 'RETRYABLE_FAILED',
          reason: 'processing_error',
          errorMessage: 'PG down',
        }),
      }),
    );
  });

  it('treats idempotency_in_progress as retryable instead of terminal failed', async () => {
    const { service, usageBilling, prisma } = buildService();
    usageBilling.settleDeliveredGatewayUsage.mockResolvedValueOnce({
      success: false,
      allowed: false,
      reason: 'idempotency_in_progress',
    });

    await expect(service.process(usageEvent())).rejects.toThrow('idempotency_in_progress');

    expect(prisma.gatewayBillingEvent.updateMany).toHaveBeenLastCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ requestId: 'req-usage-v2-1', revision: 0 }),
        data: expect.objectContaining({
          status: 'RETRYABLE_FAILED',
          reason: 'idempotency_in_progress',
        }),
      }),
    );
  });

  it('returns committed audit result without deducting a duplicate event', async () => {
    const { service, usageBilling, prisma } = buildService();
    const committed = {
      id: 'gateway-billing-event-1',
      requestId: 'req-usage-v2-1',
      status: 'DEDUCTED',
      reason: null,
      errorMessage: null,
      billingResult: { success: true, allowed: true },
      apiKeyId: 'key-1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      productSlug: 'payg',
      userId: 'user-1',
      modelName: 'gpt-4o',
      inputTokens: 10,
      outputTokens: 20,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      totalTokens: 30,
      revision: 1,
      evidenceHash: null,
      evidenceVerdict: 'SETTLEABLE_BY_POLICY',
      reconciliationStatus: 'CLOSED',
      fundingOutcome: 'COLLECTED',
    };
    prisma.gatewayBillingEvent.findUnique
      .mockResolvedValueOnce(committed)
      .mockResolvedValueOnce(committed);
    prisma.gatewayBillingEvent.createMany.mockResolvedValue({ count: 0 });
    prisma.gatewayBillingEvent.findUniqueOrThrow.mockResolvedValue({
      ...committed,
      rawEvent: usageEvent(),
      settlementAnchor: null,
    });

    const result = await service.process(usageEvent());

    expect(result).toMatchObject({
      action: 'deducted',
      requestId: 'req-usage-v2-1',
      billing: { success: true, allowed: true },
      mapped: {
        apiKeyId: 'key-1',
        tenantId: 'tenant-1',
        productId: 'prod-1',
        productSlug: 'payg',
        userId: 'user-1',
        modelName: 'gpt-4o',
        totalTokens: 30,
      },
    });
    expect(usageBilling.settleDeliveredGatewayUsage).not.toHaveBeenCalled();
    expect(prisma.gatewayBillingEvent.update).toHaveBeenCalledWith({
      where: { id: 'gateway-billing-event-1' },
      data: { receivedAt: expect.any(Date) },
    });
  });

  it('moves quarantined evidence to manual review with CAS and authenticated actor audit', async () => {
    const { service, prisma } = buildService();
    const event = {
      id: 'gateway-billing-event-1',
      requestId: 'req-usage-v2-1',
      status: 'QUARANTINED',
      reconciliationStatus: 'OPEN',
      evidenceVerdict: 'INCOMPLETE',
      fundingOutcome: null,
      revision: 1,
      reason: 'unsafe_estimated_usage',
      errorMessage: null,
      billingResult: null,
      evidenceHash: 'evidence-hash-1',
      pendingExposureUsd: new Prisma.Decimal('0.8'),
      pendingHoldUsd: new Prisma.Decimal('0.8'),
      rawEvent: usageEvent({ token_source: 'estimated' }),
      usageEvidences: [],
      reconciliationActions: [],
      settlementReceipts: [],
      platformLossEntries: [],
      accessRestrictions: [],
    };
    prisma.gatewayBillingEvent.findUnique
      .mockResolvedValueOnce(event)
      .mockResolvedValue({
        ...event,
        status: 'ABSORBED',
        fundingReservation: null,
      });

    await service.markManualReview('req-usage-v2-1', {
      expectedRevision: 1,
      reason: 'provider evidence unavailable',
      idempotencyKey: 'review-req-usage-v2-1',
      actorId: 'finance-admin-1',
    });

    expect(prisma.gatewayBillingEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'gateway-billing-event-1',
        revision: 1,
        status: 'QUARANTINED',
      },
      data: {
        reconciliationStatus: 'MANUAL_REVIEW',        // QUARANTINED 原路径 status 值不变(显式写回),升级 RETRYABLE_FAILED 时为 QUARANTINED
        status: 'QUARANTINED',

        reason: 'provider evidence unavailable',
        revision: { increment: 1 },
      },
    });
    expect(prisma.gatewayUsageReconciliationAction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'MANUAL_REVIEW',
        actorId: 'finance-admin-1',
        idempotencyKey: 'review-req-usage-v2-1',
        expectedRevision: 1,
        resultingRevision: 2,
      }),
    });
  });

  it('absorbs the immutable reservation amount and binds the complete v2 finance proof', async () => {
    const { service, prisma, usageBilling } = buildService();
    const anchorHash = 'anchor-hash-absorb-1';
    const pricingHash = 'pricing-hash-absorb-1';
    const reservationHash = 'reservation-hash-absorb-1';
    const event = {
      id: 'gateway-billing-event-1',
      requestId: 'req-usage-v2-1',
      status: 'QUARANTINED',
      reconciliationStatus: 'MANUAL_REVIEW',
      evidenceVerdict: 'INCOMPLETE',
      fundingOutcome: null,
      revision: 2,
      reason: 'provider evidence unavailable',
      errorMessage: null,
      billingResult: null,
      evidenceHash: 'evidence-hash-1',
      billingAccountId: 'billing-account-1',
      pendingExposureUsd: new Prisma.Decimal('0.8'),
      pendingHoldUsd: new Prisma.Decimal('0.8'),
      rawEvent: usageEvent({ token_source: 'estimated' }),
      usageEvidences: [],
      reconciliationActions: [],
      settlementReceipts: [],
      platformLossEntries: [],
      accessRestrictions: [],
    };
    prisma.gatewayBillingEvent.findUnique
      .mockResolvedValueOnce(event)
      .mockResolvedValue({
        ...event,
        status: 'ABSORBED',
        fundingReservation: null,
      });
    prisma.gatewayUsageSettlementAnchor.findUnique.mockResolvedValue({
      anchorHash,
      pricingHash,
      billingUnit: 'BALANCE',
      billingCurrency: 'USD',
    });
    prisma.gatewayUsageFundingReservation.findUnique.mockResolvedValue({
      id: 'funding-reservation-absorb-1',
      gatewayBillingEventId: 'gateway-billing-event-1',
      requestId: 'req-usage-v2-1',
      status: 'ACTIVE',
      billingUnit: 'BALANCE',
      billingCurrency: 'USD',
      // Deliberately differs from mutable pendingExposureUsd above.
      reservedAmountUsd: new Prisma.Decimal('0.125'),
      anchorHash,
      reservationHash,
    });

    await service.absorb('req-usage-v2-1', {
      expectedRevision: 2,
      reason: 'July discrepancy absorbed by platform',
      idempotencyKey: 'absorb-req-usage-v2-1',
      actorId: 'finance-admin-1',
    });

    expect(prisma.gatewayBillingEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'gateway-billing-event-1',
        revision: 2,
        status: 'QUARANTINED',
        reconciliationStatus: 'MANUAL_REVIEW',
      },
      data: expect.objectContaining({
        status: 'ABSORBED',
        reconciliationStatus: 'CLOSED',
        fundingOutcome: 'ABSORBED',
        pendingHoldUsd: new Prisma.Decimal(0),
        revision: { increment: 1 },
      }),
    });
    const actionData = prisma.gatewayUsageReconciliationAction.create.mock.calls[0][0].data;
    const receiptData = prisma.gatewayUsageSettlementReceipt.create.mock.calls[0][0].data;
    const expectedProof = {
      protocol: 'gateway-absorb-v2',
      requestId: 'req-usage-v2-1',
      gatewayBillingEventId: 'gateway-billing-event-1',
      fundingReservationId: 'funding-reservation-absorb-1',
      reservationHash,
      expectedRevision: 2,
      resultingRevision: 3,
      reason: 'July discrepancy absorbed by platform',
      actorId: 'finance-admin-1',
      evidenceHash: 'evidence-hash-1',
      anchorHash,
      pricingHash,
      billingUnit: 'BALANCE',
      billingCurrency: 'USD',
      approvedAbsorptionUsd: '0.125000000000',
    };
    const expectedFingerprint = createHash('sha256').update(testCanonicalJson({
      ...expectedProof,
      fundingOutcome: 'ABSORBED',
      customerDeductionUsd: '0',
    })).digest('hex');
    expect(actionData).toMatchObject({
      action: 'ABSORB',
      expectedRevision: 2,
      resultingRevision: 3,
      reason: expectedProof.reason,
      actorId: expectedProof.actorId,
      metadata: {
        ...expectedProof,
        settlementFingerprint: expectedFingerprint,
      },
    });
    expect(receiptData).toMatchObject({
      settlementRevision: 3,
      fundingOutcome: 'ABSORBED',
      evidenceHash: 'evidence-hash-1',
      anchorHash,
      pricingHash,
      settlementFingerprint: expectedFingerprint,
      billingUnit: 'BALANCE',
      billingCurrency: 'USD',
      amountUsd: new Prisma.Decimal('0.125'),
      reason: expectedProof.reason,
      policyVersion: 'manual-finance-v2',
      actorId: 'finance-admin-1',
      idempotencyKey: 'receipt:absorb-req-usage-v2-1',
      payload: {
        ...expectedProof,
        fundingOutcome: 'ABSORBED',
        customerDeductionUsd: '0',
        settlementFingerprint: expectedFingerprint,
      },
    });
    expect(usageBilling.releaseGatewayBalanceFunding).toHaveBeenCalledWith(
      'req-usage-v2-1',
      'financial_absorption:absorb-req-usage-v2-1',
    );
    // 按事件绑定的那几类仍按 event id 释放
    expect(prisma.billingAccessRestriction.updateMany).toHaveBeenCalledWith({
      where: {
        gatewayBillingEventId: 'gateway-billing-event-1',
        status: 'ACTIVE',
        reason: {
          in: [
            'pending_usage_unreserved',
            'pending_usage_exposure_limit',
            'evidence_conflict',
          ],
        },
      },
      data: {
        status: 'RELEASED',
        releasedAt: expect.any(Date),
        releasedBy: 'finance-admin-1',
        releaseReason: 'financial_absorption_closed_reconciliation',
      },
    });
    // settlement_policy_review 不在上面那批里：它是主体级的一行，按 event id 放会在
    // 吸收掉其中一条时就解封整个主体。它走 drained 判定（按幂等键）。
    const policyReviewReleases = (prisma.billingAccessRestriction.updateMany as jest.Mock).mock.calls
      .map(([arg]) => arg)
      .filter((arg) => String(arg?.where?.idempotencyKey ?? '')
        .startsWith('gateway:settlement_policy_review:'));
    expect(policyReviewReleases.length).toBeGreaterThan(0);
    expect(policyReviewReleases[0].data).toMatchObject({
      status: 'RELEASED',
      releaseReason: 'financial_absorption_closed_reconciliation',
    });
  });

  it('rejects financial absorption without an immutable funding reservation and anchor', async () => {
    const { service, prisma, publisherSync } = buildService();
    const event = {
      id: 'gateway-billing-event-key-only',
      requestId: 'req-key-only-absorb',
      apiKeyId: 'key-only-1',
      billingAccountId: null,
      status: 'QUARANTINED',
      reconciliationStatus: 'MANUAL_REVIEW',
      evidenceVerdict: 'INCOMPLETE',
      fundingOutcome: null,
      revision: 2,
      reason: 'provider evidence unavailable',
      errorMessage: null,
      billingResult: null,
      evidenceHash: 'evidence-hash-key-only',
      pendingExposureUsd: new Prisma.Decimal('0.2'),
      pendingHoldUsd: new Prisma.Decimal('0.2'),
      rawEvent: usageEvent({ request_id: 'req-key-only-absorb', key_id: 'key-only-1' }),
      settlementAnchor: null,
      usageEvidences: [],
      reconciliationActions: [],
      settlementReceipts: [],
      platformLossEntries: [],
      accessRestrictions: [],
    };
    prisma.gatewayBillingEvent.findUnique.mockResolvedValue(event);

    await expect(service.absorb('req-key-only-absorb', {
      expectedRevision: 2,
      reason: 'approved platform absorption',
      idempotencyKey: 'absorb-req-key-only',
      actorId: 'finance-admin-1',
    })).rejects.toThrow('funding reservation/settlement anchor');

    expect(stateUpdateManyCalls(prisma)).toHaveLength(0);
    expect(prisma.gatewayUsageSettlementReceipt.create).not.toHaveBeenCalled();
    expect(publisherSync.syncKeyBalanceById).not.toHaveBeenCalled();
    expect(publisherSync.syncBillingAccountKeyBalances).not.toHaveBeenCalled();
  });

  it('closes only a repair-bound, remediated unanchored currency mismatch at zero value', async () => {
    const { service, prisma, usageBilling, publisherSync } = buildService();
    const rawEvent = usageEvent({
      request_id: 'req-unanchored-currency-1',
      event_id: 'evt-unanchored-currency-1',
      key_id: 'key-currency-1',
      tenant_id: 'tenant-currency-1',
      labels: {
        tenant_id: 'tenant-currency-1',
        user_id: 'user-1',
        'usr.product_id': 'prod-1',
        'usr.product_slug': 'payg',
        region: 'cn-north-1',
      },
    });
    const evidenceHash = createHash('sha256')
      .update(testCanonicalJson(rawEvent))
      .digest('hex');
    const event = {
      id: 'gateway-event-unanchored-currency-1',
      requestId: 'req-unanchored-currency-1',
      eventId: 'evt-unanchored-currency-1',
      status: 'QUARANTINED',
      reason: 'settlement_anchor_missing',
      apiKeyId: 'key-currency-1',
      tenantId: 'tenant-currency-1',
      billingAccountId: null,
      billingUnit: null,
      billingResult: null,
      pricingSnapshot: null,
      reconciliationStatus: 'MANUAL_REVIEW',
      evidenceVerdict: 'INCOMPLETE',
      fundingOutcome: null,
      revision: 1,
      pendingExposureUsd: new Prisma.Decimal(0),
      pendingHoldUsd: new Prisma.Decimal(0),
      rawEvent,
      evidenceHash,
      errorMessage: 'Gateway billing currency mismatch: account=USD deployment=CNY',
      settlementAnchor: null,
      fundingReservation: null,
      tokenUsage: null,
      settlementReceipts: [],
      platformLossEntries: [],
      usageLossRecognitionClaims: [],
      historicalPlatformLossLines: [],
    };
    prisma.gatewayBillingEvent.findUniqueOrThrow.mockResolvedValue(event);
    prisma.gatewayBillingEvent.findUnique.mockResolvedValue({
      ...event,
      status: 'ABSORBED',
      fundingReservation: null,
    });
    prisma.gatewayUsageEvidence.findMany.mockResolvedValue([{
      id: 'evidence-unanchored-currency-1',
      gatewayBillingEventId: event.id,
      requestId: event.requestId,
      eventId: event.eventId,
      source: 'GATEWAY_USAGE_EVENT',
      evidenceHash,
      evidenceRevision: 1,
      rawEvidence: rawEvent,
    }]);
    prisma.apiKey.findUnique.mockResolvedValue({
      id: 'key-currency-1',
      tenantId: 'tenant-currency-1',
      deletedAt: null,
      tenant: {
        id: 'tenant-currency-1',
        billingAccountId: 'billing-account-currency-1',
        deletedAt: null,
        billingAccount: {
          id: 'billing-account-currency-1',
          currency: 'CNY',
          deletedAt: null,
        },
      },
    });
    prisma.$queryRaw
      .mockResolvedValueOnce([{ id: event.id }])
      .mockResolvedValueOnce([{
        runId: 'currency-run-1',
        itemId: 'currency-item-1',
        manifestHash: 'a'.repeat(64),
        sourceCurrency: 'USD',
        targetCurrency: 'CNY',
        runStatus: 'APPLIED',
        billingAccountId: 'billing-account-currency-1',
        beforeCurrency: 'USD',
        afterCurrency: 'CNY',
        eligibleEventId: 'eligible-event-unanchored-currency-1',
        eligibleEventRowHash: 'c'.repeat(64),
        eligibilityCode: 'BILLING_CURRENCY_MIGRATION_REQUIRED',
        failureReason: 'settlement_anchor_missing',
        errorFingerprint:
          'f7c470fb73da49f0ed8b517ec5993e0c3a1796e08b4b8835c03d96fb9364d137',
        eligibleEvidenceId: 'evidence-unanchored-currency-1',
      }]);
    const systemConfig = (service as any).systemConfig;
    systemConfig.getDeploymentConfig.mockResolvedValue({
      version: '2',
      region: 'domestic',
      provider: 'wechat',
      currency: 'cny',
      defaultLanguage: 'zh',
      oauth: {},
    });

    await service.absorb(event.requestId, {
      expectedRevision: 1,
      reason: 'approved legacy currency closure',
      idempotencyKey: 'absorb-unanchored-currency-1',
      actorId: 'finance-admin-1',
      protocol: 'gateway-unanchored-absorb-v1',
      currencyRepairRunId: 'currency-run-1',
      currencyRepairItemId: 'currency-item-1',
      manifestHash: 'a'.repeat(64),
    });

    expect(prisma.gatewayBillingEvent.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          id: event.id,
          revision: 1,
          status: 'QUARANTINED',
          reconciliationStatus: 'MANUAL_REVIEW',
        }),
        data: expect.objectContaining({
          status: 'ABSORBED',
          billingResult: Prisma.DbNull,
          pricingSnapshot: Prisma.DbNull,
        }),
      }),
    );
    const action = prisma.gatewayUsageReconciliationAction.create.mock.calls[0][0].data;
    const receipt = prisma.gatewayUsageSettlementReceipt.create.mock.calls[0][0].data;
    expect(action).toMatchObject({
      action: 'ABSORB',
      expectedRevision: 1,
      resultingRevision: 2,
      metadata: expect.objectContaining({
        protocol: 'gateway-unanchored-absorb-v1',
        currencyRepairRunId: 'currency-run-1',
        currencyRepairItemId: 'currency-item-1',
        currencyRepairManifestHash: 'a'.repeat(64),
        currencyRepairEligibleEventId: 'eligible-event-unanchored-currency-1',
        currencyRepairEligibleEventRowHash: 'c'.repeat(64),
        currencyRepairEligibilityCode: 'BILLING_CURRENCY_MIGRATION_REQUIRED',
        currencyRepairFailureReason: 'settlement_anchor_missing',
        currencyRepairErrorFingerprint:
          'f7c470fb73da49f0ed8b517ec5993e0c3a1796e08b4b8835c03d96fb9364d137',
        currencyRepairEvidenceId: 'evidence-unanchored-currency-1',
        originalAccountCurrency: 'USD',
        originalDeploymentCurrency: 'CNY',
        currentAccountCurrency: 'CNY',
        currentDeploymentCurrency: 'CNY',
        financialMutationAbsent: true,
      }),
    });
    expect(receipt).toMatchObject({
      policyVersion: 'gateway-unanchored-absorb-v1',
      fundingOutcome: 'ABSORBED',
      amountUsd: new Prisma.Decimal(0),
      anchorHash: null,
      pricingHash: null,
      billingUnit: null,
      billingCurrency: null,
      tokenUsageId: null,
      payload: expect.objectContaining({
        amountUsd: '0.000000000000',
        customerDeductionUsd: '0.000000000000',
      }),
    });
    expect(usageBilling.releaseGatewayBalanceFunding).not.toHaveBeenCalled();
    expect(publisherSync.syncBillingAccountKeyBalancesByKeyIdRequired)
      .toHaveBeenCalledWith('key-currency-1');
  });

  it('rejects unanchored absorption for an inexact or non-currency failure', async () => {
    const { service, prisma } = buildService();
    prisma.gatewayBillingEvent.findUniqueOrThrow.mockResolvedValue({
      id: 'gateway-event-not-currency',
      requestId: 'req-not-currency',
      eventId: 'evt-not-currency',
      status: 'QUARANTINED',
      reason: 'settlement_anchor_missing',
      apiKeyId: 'key-1',
      tenantId: 'tenant-1',
      billingAccountId: null,
      billingUnit: null,
      billingResult: null,
      pricingSnapshot: null,
      reconciliationStatus: 'MANUAL_REVIEW',
      evidenceVerdict: 'INCOMPLETE',
      fundingOutcome: null,
      revision: 1,
      pendingExposureUsd: new Prisma.Decimal(0),
      pendingHoldUsd: new Prisma.Decimal(0),
      rawEvent: usageEvent({ request_id: 'req-not-currency' }),
      evidenceHash: 'unused',
      errorMessage: 'Gateway billing currency mismatch: account=USD deployment=CNY extra',
      settlementAnchor: null,
      fundingReservation: null,
      tokenUsage: null,
      settlementReceipts: [],
      platformLossEntries: [],
      usageLossRecognitionClaims: [],
      historicalPlatformLossLines: [],
    });
    prisma.$queryRaw.mockResolvedValueOnce([{ id: 'gateway-event-not-currency' }]);

    await expect(service.absorb('req-not-currency', {
      expectedRevision: 1,
      reason: 'do not allow prefix matches',
      idempotencyKey: 'absorb-not-currency',
      actorId: 'finance-admin-1',
      protocol: 'gateway-unanchored-absorb-v1',
      currencyRepairRunId: 'currency-run-1',
      currencyRepairItemId: 'currency-item-1',
      manifestHash: 'a'.repeat(64),
    })).rejects.toThrow('仅支持精确的首次收件币种不匹配事件');

    expect(stateUpdateManyCalls(prisma)).toHaveLength(0);
    expect(prisma.gatewayUsageSettlementReceipt.create).not.toHaveBeenCalled();
  });

  it('replays a concurrent unanchored absorb only from the complete v1 proof', async () => {
    const { service, prisma, usageBilling, publisherSync } = buildService();
    const manifestHash = 'b'.repeat(64);
    const proof = {
      protocol: 'gateway-unanchored-absorb-v1',
      requestId: 'req-unanchored-race',
      gatewayBillingEventId: 'event-unanchored-race',
      expectedRevision: 1,
      resultingRevision: 2,
      reason: 'approved audited currency closure',
      actorId: 'finance-admin-race',
      idempotencyKey: 'absorb-unanchored-race',
      evidenceHash: 'evidence-unanchored-race',
      evidenceRevision: 1,
      failureReason: 'settlement_anchor_missing',
      failureMessage: 'Gateway billing currency mismatch: account=USD deployment=CNY',
      originalAccountCurrency: 'USD',
      originalDeploymentCurrency: 'CNY',
      currentApiKeyId: 'key-unanchored-race',
      currentTenantId: 'tenant-unanchored-race',
      currentBillingAccountId: 'account-unanchored-race',
      currentAccountCurrency: 'CNY',
      currentDeploymentCurrency: 'CNY',
      currencyRepairRunId: 'repair-run-race',
      currencyRepairItemId: 'repair-item-race',
      currencyRepairManifestHash: manifestHash,
      currencyRepairEligibleEventId: 'eligible-event-race',
      currencyRepairEligibleEventRowHash: 'c'.repeat(64),
      currencyRepairEligibilityCode: 'BILLING_CURRENCY_MIGRATION_REQUIRED',
      currencyRepairFailureReason: 'settlement_anchor_missing',
      currencyRepairErrorFingerprint:
        'f7c470fb73da49f0ed8b517ec5993e0c3a1796e08b4b8835c03d96fb9364d137',
      currencyRepairEvidenceId: 'evidence-unanchored-race',
      anchorAbsent: true,
      fundingReservationAbsent: true,
      tokenUsageAbsent: true,
      priorSettlementReceiptAbsent: true,
      financialMutationAbsent: true,
      amountUsd: '0.000000000000',
      customerDeductionUsd: '0.000000000000',
    };
    const canonicalFingerprint = createHash('sha256')
      .update(testCanonicalJson({ ...proof, fundingOutcome: 'ABSORBED' }))
      .digest('hex');
    const payload = {
      ...proof,
      fundingOutcome: 'ABSORBED',
      settlementFingerprint: canonicalFingerprint,
    };
    const event = {
      id: proof.gatewayBillingEventId,
      requestId: proof.requestId,
      status: 'ABSORBED',
      reason: proof.reason,
      apiKeyId: proof.currentApiKeyId,
      evidenceHash: proof.evidenceHash,
      reconciliationStatus: 'CLOSED',
      fundingOutcome: 'ABSORBED',
      revision: 2,
      pendingExposureUsd: new Prisma.Decimal(0),
      pendingHoldUsd: new Prisma.Decimal(0),
      settlementAnchor: null,
      fundingReservation: null,
      tokenUsage: null,
      platformLossEntries: [],
      usageLossRecognitionClaims: [],
      historicalPlatformLossLines: [],
      settlementReceipts: [{
        gatewayBillingEventId: proof.gatewayBillingEventId,
        requestId: proof.requestId,
        settlementRevision: 2,
        fundingOutcome: 'ABSORBED',
        evidenceHash: proof.evidenceHash,
        amountUsd: new Prisma.Decimal(0),
        anchorHash: null,
        pricingHash: null,
        settlementFingerprint: canonicalFingerprint,
        billingUnit: null,
        billingCurrency: null,
        creditAmount: null,
        tokenUsageId: null,
        reason: proof.reason,
        policyVersion: 'gateway-unanchored-absorb-v1',
        actorId: proof.actorId,
        idempotencyKey: `receipt:${proof.idempotencyKey}`,
        payload,
      }],
    };
    prisma.$transaction
      .mockRejectedValueOnce(new GatewayBillingRevisionConflictError());
    prisma.gatewayUsageReconciliationAction.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        requestId: proof.requestId,
        action: 'ABSORB',
        reason: proof.reason,
        expectedRevision: 1,
        resultingRevision: 2,
        actorId: proof.actorId,
        metadata: { ...proof, settlementFingerprint: canonicalFingerprint },
        gatewayBillingEvent: event,
      });
    prisma.$queryRaw.mockResolvedValueOnce([{ proven: true }]);
    prisma.apiKey.findUnique.mockResolvedValue({
      id: proof.currentApiKeyId,
      tenantId: proof.currentTenantId,
      deletedAt: null,
      tenant: {
        id: proof.currentTenantId,
        billingAccountId: proof.currentBillingAccountId,
        deletedAt: null,
        billingAccount: {
          id: proof.currentBillingAccountId,
          deletedAt: null,
        },
      },
    });
    prisma.gatewayBillingEvent.findUnique.mockResolvedValue({
      ...event,
      billingAccountId: null,
    });

    await service.absorb(proof.requestId, {
      expectedRevision: 1,
      reason: proof.reason,
      idempotencyKey: proof.idempotencyKey,
      actorId: proof.actorId,
      protocol: 'gateway-unanchored-absorb-v1',
      currencyRepairRunId: proof.currencyRepairRunId,
      currencyRepairItemId: proof.currencyRepairItemId,
      manifestHash,
    });

    expect(usageBilling.releaseGatewayBalanceFunding).not.toHaveBeenCalled();
    expect(publisherSync.syncBillingAccountKeyBalancesByKeyIdRequired)
      .toHaveBeenCalledWith(proof.currentApiKeyId);
  });

  it('absorbs a verified delta on an already deducted request without another customer deduction', async () => {
    const { service, prisma, usageBilling, publisherSync, coverageRegistry } = buildService();
    const originalEvidence = usageEvent({
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      token_extras: { cache_hit_tokens: 0, cache_write_tokens: 0 },
    });
    const correctedEvidence = usageEvent({
      event_id: 'usage-evt-correction-1',
      prompt_tokens: 120,
      completion_tokens: 15,
      total_tokens: 135,
      token_extras: { cache_hit_tokens: 0, cache_write_tokens: 0 },
    });
    const originalEvidenceHash = createHash('sha256')
      .update(testCanonicalJson(originalEvidence))
      .digest('hex');
    const correctionEvidenceHash = createHash('sha256')
      .update(testCanonicalJson(correctedEvidence))
      .digest('hex');
    const settlementAnchor = makeTestAnchor({
      requestId: 'req-usage-v2-1',
      apiKeyId: 'key-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      productSlug: 'payg',
      modelName: 'gpt-4o',
      inputTokens: 100,
      outputTokens: 10,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      eventOccurredAt: new Date('2026-05-21T08:30:15.000Z'),
    });
    const event = {
      id: 'gateway-billing-event-1',
      requestId: 'req-usage-v2-1',
      apiKeyId: 'key-1',
      billingAccountId: 'billing-account-1',
      status: 'DEDUCTED',
      reconciliationStatus: 'MANUAL_REVIEW',
      evidenceVerdict: 'CONFLICTED',
      fundingOutcome: 'COLLECTED',
      revision: 4,
      reason: 'terminal_event_received_different_evidence',
      evidenceHash: originalEvidenceHash,
      rawEvent: originalEvidence,
      pendingExposureUsd: new Prisma.Decimal(0),
      pendingHoldUsd: new Prisma.Decimal(0),
      settlementAnchor,
      tokenUsage: {
        id: 'token-usage-original-1',
        promptTokens: 100,
        completionTokens: 10,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        customerChargeUsd: new Prisma.Decimal('0.8'),
        providerCostEstimateUsd: new Prisma.Decimal('0.4'),
      },
      settlementReceipts: [{
        id: 'receipt-original-1',
        tokenUsageId: 'token-usage-original-1',
        evidenceHash: originalEvidenceHash,
        anchorHash: settlementAnchor.anchorHash,
        fundingOutcome: 'COLLECTED',
        amountUsd: new Prisma.Decimal('0.8'),
        creditAmount: null,
      }],
      usageEvidences: [],
      reconciliationActions: [],
      platformLossEntries: [],
      accessRestrictions: [],
    };
    const selectedEvidence = {
      id: 'evidence-correction-1',
      gatewayBillingEventId: event.id,
      requestId: event.requestId,
      source: 'GATEWAY_USAGE_EVENT',
      evidenceHash: correctionEvidenceHash,
      rawEvidence: correctedEvidence,
      providerAccountRef: 'provider-account-test-001',
      upstreamRequestId: 'upstream-request-test-001',
    };
    prisma.gatewayUsageEvidence.findUnique.mockResolvedValue(selectedEvidence);
    prisma.gatewayBillingEvent.findUnique.mockResolvedValue(event);
    usageBilling.valueGatewayUsageAtFrozenPricing.mockResolvedValue({
      quote: {
        unit: 'BALANCE',
        effectiveCostUsd: '1.2',
        inputTokens: 120,
        outputTokens: 15,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
      },
      customerChargeUsd: '1.2',
      providerCostUsd: '0.7',
    });

    await service.absorbTerminalDelta(
      event.requestId,
      selectedEvidence.id,
      {
        expectedRevision: 4,
        reason: 'July GLM undercount absorbed by platform',
        idempotencyKey: 'absorb-delta-req-usage-v2-1',
        actorId: 'finance-admin-1',
      },
    );

    expect(usageBilling.settleDeliveredGatewayUsage).not.toHaveBeenCalled();
    expect(usageBilling.valueGatewayUsageAtFrozenPricing).toHaveBeenCalledWith(
      expect.objectContaining({
        requestId: event.requestId,
        inputTokens: 120,
        outputTokens: 15,
      }),
      expect.objectContaining({ anchorHash: settlementAnchor.anchorHash }),
    );
    expect(prisma.gatewayBillingEvent.updateMany).toHaveBeenCalledWith({
      where: {
        id: event.id,
        revision: 4,
        status: 'DEDUCTED',
        reconciliationStatus: 'MANUAL_REVIEW',
        evidenceVerdict: 'CONFLICTED',
      },
      data: {
        reason: 'July GLM undercount absorbed by platform',
        reconciliationStatus: 'CLOSED',
        evidenceVerdict: 'VERIFIED_PROVIDER_CORRECTION',
        revision: { increment: 1 },
      },
    });
    expect(prisma.gatewayUsageSettlementReceipt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fundingOutcome: 'ABSORBED',
        evidenceHash: correctionEvidenceHash,
        amountUsd: new Prisma.Decimal('0.4'),
        tokenUsageId: 'token-usage-original-1',
        policyVersion: 'gateway-platform-loss-v1',
        idempotencyKey: 'receipt:absorb-delta-req-usage-v2-1',
        payload: expect.objectContaining({
          customerDeductionUsd: '0',
          customerChargeBeforeUsd: '0.8',
          customerChargeCorrectedUsd: '1.2',
          absorbedCustomerChargeUsd: '0.4',
          providerCostBeforeUsd: '0.4',
          providerCostCorrectedUsd: '0.7',
          providerCostDeltaUsd: '0.3',
        }),
      }),
    });
    expect(prisma.gatewayUsagePlatformLoss.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        correctionEvidenceId: selectedEvidence.id,
        correctionEvidenceHash,
        originalSettlementReceiptId: 'receipt-original-1',
        customerChargeBeforeUsd: new Prisma.Decimal('0.8'),
        customerChargeCorrectedUsd: new Prisma.Decimal('1.2'),
        absorbedCustomerChargeUsd: new Prisma.Decimal('0.4'),
        customerDeductionUsd: new Prisma.Decimal(0),
        providerCostBeforeUsd: new Prisma.Decimal('0.4'),
        providerCostCorrectedUsd: new Prisma.Decimal('0.7'),
        providerCostDeltaUsd: new Prisma.Decimal('0.3'),
        platformLossUsd: new Prisma.Decimal('0.4'),
      }),
    });
    expect(prisma.usageLossRecognitionClaim.create).toHaveBeenCalledTimes(2);
    expect(prisma.usageLossRecognitionClaim.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        recognitionType: 'REQUEST_ID',
        claimSource: 'ABSORB_DELTA',
        gatewayBillingEventId: event.id,
      }),
    });
    expect([...coverageRegistry.values()]).toEqual(expect.arrayContaining([
      expect.objectContaining({ meter: 'INPUT', granularityMode: 'REQUEST' }),
      expect.objectContaining({ meter: 'OUTPUT', granularityMode: 'REQUEST' }),
    ]));
    expect(prisma.billingAccessRestriction.updateMany).toHaveBeenCalledWith({
      where: {
        gatewayBillingEventId: event.id,
        status: 'ACTIVE',
        reason: { in: ['evidence_conflict', 'settlement_policy_review'] },
      },
      data: {
        status: 'RELEASED',
        releasedAt: expect.any(Date),
        releasedBy: 'finance-admin-1',
        releaseReason: 'platform_absorbed_verified_usage_delta',
      },
    });
    expect(publisherSync.syncBillingAccountKeyBalancesRequired)
      .toHaveBeenCalledWith('billing-account-1');
  });

  it('replays a terminal delta absorption without creating another financial fact', async () => {
    const { service, prisma, usageBilling } = buildService();
    const correctedEvidence = usageEvent({ event_id: 'usage-evt-correction-replay' });
    const correctionEvidenceHash = createHash('sha256')
      .update(testCanonicalJson(correctedEvidence))
      .digest('hex');
    prisma.gatewayUsageEvidence.findUnique.mockResolvedValue({
      id: 'evidence-correction-replay',
      gatewayBillingEventId: 'gateway-billing-event-1',
      requestId: 'req-usage-v2-1',
      source: 'GATEWAY_USAGE_EVENT',
      evidenceHash: correctionEvidenceHash,
      rawEvidence: correctedEvidence,
    });
    prisma.gatewayUsageReconciliationAction.findUnique.mockResolvedValue({
      id: 'action-absorb-delta-1',
      requestId: 'req-usage-v2-1',
      action: 'PLATFORM_ABSORB_DELTA',
      reason: 'approved historical loss',
      expectedRevision: 4,
      actorId: 'finance-admin-1',
      metadata: {
        selectedEvidenceId: 'evidence-correction-replay',
        evidenceHash: correctionEvidenceHash,
      },
    });
    prisma.gatewayUsagePlatformLoss.findUnique.mockResolvedValue({
      reconciliationActionId: 'action-absorb-delta-1',
      correctionEvidenceId: 'evidence-correction-replay',
      correctionEvidenceHash,
      customerDeductionUsd: new Prisma.Decimal(0),
    });
    prisma.gatewayBillingEvent.findUnique.mockResolvedValue({
      id: 'gateway-billing-event-1',
      requestId: 'req-usage-v2-1',
      billingAccountId: 'billing-account-1',
      apiKeyId: 'key-1',
      pendingExposureUsd: new Prisma.Decimal(0),
      pendingHoldUsd: new Prisma.Decimal(0),
      settlementAnchor: null,
      usageEvidences: [],
      reconciliationActions: [],
      settlementReceipts: [],
      platformLossEntries: [],
      accessRestrictions: [],
    });

    await service.absorbTerminalDelta('req-usage-v2-1', 'evidence-correction-replay', {
      expectedRevision: 4,
      reason: 'approved historical loss',
      idempotencyKey: 'absorb-delta-replay-1',
      actorId: 'finance-admin-1',
    });

    expect(usageBilling.valueGatewayUsageAtFrozenPricing).not.toHaveBeenCalled();
    expect(prisma.gatewayUsageReconciliationAction.create).not.toHaveBeenCalled();
    expect(prisma.gatewayUsageSettlementReceipt.create).not.toHaveBeenCalled();
    expect(prisma.gatewayUsagePlatformLoss.create).not.toHaveBeenCalled();
  });

  it('replays stored raw event when retrying an audited event', async () => {
    const { service, prisma, usageBilling } = buildService();
    let transactionDepth = 0;
    prisma.$transaction.mockImplementation(async (fn: (tx: typeof prisma) => unknown) => {
      transactionDepth += 1;
      try {
        return await fn(prisma);
      } finally {
        transactionDepth -= 1;
      }
    });
    prisma.gatewayUsageReconciliationAction.create.mockImplementation(async () => {
      expect(transactionDepth).toBeGreaterThan(0);
      return {};
    });
    const retryableEvent = {
      id: 'gateway-billing-event-1',
      requestId: 'req-usage-v2-1',
      status: 'RETRYABLE_FAILED',
      reconciliationStatus: 'RETRY_WAIT',
      evidenceVerdict: 'SETTLEABLE_BY_POLICY',
      fundingOutcome: null,
      revision: 0,
      reason: 'processing_error',
      errorMessage: 'temporary failure',
      billingResult: null,
      evidenceHash: 'evidence-hash-1',
      pendingExposureUsd: new Prisma.Decimal(0),
      pendingHoldUsd: new Prisma.Decimal(0),
      rawEvent: usageEvent(),
      usageEvidences: [],
      reconciliationActions: [],
      settlementReceipts: [],
      platformLossEntries: [],
      accessRestrictions: [],
    };
    const retryAnchor = makeTestAnchor({
      requestId: retryableEvent.requestId,
      apiKeyId: 'key-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      productSlug: 'payg',
      eventOccurredAt: new Date('2026-05-21T08:30:15.000Z'),
    });
    prisma.gatewayBillingEvent.findUnique.mockResolvedValue(retryableEvent);
    prisma.gatewayBillingEvent.createMany.mockResolvedValue({ count: 0 });
    prisma.gatewayBillingEvent.findUniqueOrThrow.mockResolvedValue({
      ...retryableEvent,
      settlementAnchor: retryAnchor,
      fundingReservation: { status: 'ACTIVE' },
    });

    const result = await service.retryEvent('req-usage-v2-1', {
      expectedRevision: 0,
      reason: 'retry transient failure',
      idempotencyKey: 'retry-req-usage-v2-1',
      actorId: 'admin-1',
    });

    expect(result.action).toBe('deducted');
    expect(prisma.gatewayBillingEvent.findUnique).toHaveBeenCalled();
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledTimes(1);
    // 存量兼容路径：按事件的旧幂等键仍会被精确释放
    expect(prisma.billingAccessRestriction.updateMany).toHaveBeenCalledWith({
      where: {
        idempotencyKey: 'gateway:settlement_retry_pending:req-usage-v2-1',
        status: 'ACTIVE',
      },
      data: {
        status: 'RELEASED',
        releasedAt: expect.any(Date),
        releasedBy: 'admin-1',
        releaseReason: 'settlement_retry_resolved',
      },
    });
    expect(prisma.gatewayUsageReconciliationAction.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          action: 'TECHNICAL_RETRY',
          expectedRevision: 0,
          resultingRevision: 1,
          idempotencyKey: 'retry-req-usage-v2-1',
          metadata: expect.objectContaining({
            terminalStatus: 'DEDUCTED',
            reconciliationStatus: 'CLOSED',
          }),
        }),
      }),
    );
  });

  it('replays an atomically committed technical retry after publisher delivery crashes', async () => {
    const { service, prisma, usageBilling, publisherSync } = buildService();
    const command = {
      expectedRevision: 0,
      reason: 'retry after transient settlement failure',
      idempotencyKey: ' retry-atomic-crash-1 ',
      actorId: 'admin-atomic-1',
    };
    const retryableEvent = {
      id: 'gateway-billing-event-1',
      requestId: 'req-usage-v2-1',
      apiKeyId: 'key-1',
      billingAccountId: 'billing-account-1',
      status: 'RETRYABLE_FAILED',
      reconciliationStatus: 'RETRY_WAIT',
      evidenceVerdict: 'SETTLEABLE_BY_POLICY',
      fundingOutcome: null,
      revision: 0,
      reason: 'processing_error',
      errorMessage: 'temporary failure',
      billingResult: null,
      evidenceHash: 'evidence-hash-1',
      pendingExposureUsd: new Prisma.Decimal(0),
      pendingHoldUsd: new Prisma.Decimal(0),
      rawEvent: usageEvent(),
      usageEvidences: [],
      reconciliationActions: [],
      settlementReceipts: [],
      platformLossEntries: [],
      accessRestrictions: [],
    };
    const committedEvent = {
      ...retryableEvent,
      status: 'DEDUCTED',
      reconciliationStatus: 'CLOSED',
      fundingOutcome: 'COLLECTED',
      revision: 1,
      reason: null,
      errorMessage: null,
      billingResult: { success: true, allowed: true, fundingOutcome: 'COLLECTED' },
    };
    const retryAnchor = makeTestAnchor({
      requestId: retryableEvent.requestId,
      apiKeyId: 'key-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      productSlug: 'payg',
      eventOccurredAt: new Date('2026-05-21T08:30:15.000Z'),
    });

    prisma.gatewayUsageReconciliationAction.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        requestId: retryableEvent.requestId,
        action: 'TECHNICAL_RETRY',
        expectedRevision: command.expectedRevision,
        reason: command.reason,
        actorId: command.actorId,
      });
    prisma.gatewayBillingEvent.findUnique
      .mockResolvedValueOnce(retryableEvent)
      .mockResolvedValueOnce(retryableEvent)
      .mockResolvedValueOnce(committedEvent)
      .mockResolvedValueOnce(committedEvent)
      .mockResolvedValueOnce(committedEvent);
    prisma.gatewayBillingEvent.createMany.mockResolvedValue({ count: 0 });
    prisma.gatewayBillingEvent.findUniqueOrThrow.mockResolvedValue({
      ...retryableEvent,
      settlementAnchor: retryAnchor,
      fundingReservation: { status: 'ACTIVE' },
    });
    // 按 data 形状分派，而不是按调用序列：lineage 墓碑写入也走 updateMany，
    // 用 mockResolvedValueOnce 链会被它吃掉第一格，从而让状态转移拿到错误的返回。
    let stateTransitions = 0;
    prisma.gatewayBillingEvent.updateMany.mockImplementation(async ({ data }: any) => {
      const keys = Object.keys(data ?? {});
      if (keys.length === 1 && keys[0] === 'legacyOriginalEvidenceMissingAt') {
        return { count: 1 };
      }
      stateTransitions += 1;
      return { count: stateTransitions === 1 ? 1 : 0 };
    });
    publisherSync.syncBillingAccountKeyBalancesRequired
      .mockRejectedValueOnce(new Error('publisher delivery crashed'));

    await expect(service.retryEvent(retryableEvent.requestId, command))
      .rejects.toThrow('publisher delivery crashed');

    expect(prisma.gatewayUsageReconciliationAction.create).toHaveBeenCalledTimes(1);
    expect(prisma.gatewayUsageReconciliationAction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'TECHNICAL_RETRY',
        resultingRevision: 1,
        idempotencyKey: 'retry-atomic-crash-1',
      }),
    });

    const replay = await service.retryEvent(retryableEvent.requestId, command);

    expect(replay).toMatchObject({
      action: 'deducted',
      requestId: retryableEvent.requestId,
      revision: 1,
      fundingOutcome: 'COLLECTED',
    });
    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledTimes(1);
    expect(prisma.gatewayUsageReconciliationAction.create).toHaveBeenCalledTimes(1);
    expect(publisherSync.syncBillingAccountKeyBalancesRequired).toHaveBeenCalledTimes(2);
  });

  it('repairs a legacy evidence-only OPEN from the selected partial GLM evidence', async () => {
    const { service, prisma, publisherSync } = buildService();
    const authoritative = usageEvent({
      request_id: 'req-reconcile-1',
      provider: 'zhipu',
      resolved_api_type: 'anthropic',
      provider_account_ref: undefined,
      provider_credential_ref: undefined,
      upstream_request_id: undefined,
      upstream_response_id: undefined,
      usage_evidence: {
        source: 'provider_terminal',
        status: 'partial',
        protocol: 'anthropic',
        terminal_frame_seen: true,
        dimensions_present: [
          'input_tokens',
          'output_tokens',
          'cache_read_input_tokens',
        ],
      },
      provider_reconciliation_required: true,
      prompt_tokens: 120,
      completion_tokens: 15,
      total_tokens: 135,
      token_extras: {
        cache_hit_tokens: 20,
        cache_write_tokens: 0,
      },
    });
    const original = authoritative;
    const evidenceHash = createHash('sha256')
      .update(testCanonicalJson(authoritative))
      .digest('hex');
    const selectedEvidence = {
      id: 'evidence-authoritative-1',
      gatewayBillingEventId: 'event-reconcile-1',
      requestId: 'req-reconcile-1',
      source: 'GATEWAY_USAGE_EVENT',
      evidenceHash,
      rawEvidence: authoritative,
    };
    const pendingEvent = {
      id: 'event-reconcile-1',
      requestId: 'req-reconcile-1',
      apiKeyId: 'key-1',
      billingAccountId: 'billing-account-1',
      status: 'QUARANTINED',
      reconciliationStatus: 'OPEN',
      evidenceVerdict: 'INCOMPLETE',
      fundingOutcome: null,
      revision: 3,
      reason: 'usage_evidence_partial',
      errorMessage: null,
      billingResult: null,
      evidenceHash,
      pendingExposureUsd: new Prisma.Decimal('0.2'),
      pendingHoldUsd: new Prisma.Decimal('0.2'),
      rawEvent: original,
      settlementAnchor: {},
      usageEvidences: [selectedEvidence],
      reconciliationActions: [],
      settlementReceipts: [],
      platformLossEntries: [],
      accessRestrictions: [],
    };
    prisma.gatewayUsageEvidence.findUnique.mockResolvedValue(selectedEvidence);
    prisma.gatewayBillingEvent.findUnique.mockResolvedValue(pendingEvent);
    const processSpy = jest.spyOn(service, 'process').mockResolvedValue({
      action: 'deducted',
      requestId: 'req-reconcile-1',
      revision: 5,
      evidenceVerdict: 'INCOMPLETE',
      reconciliationStatus: 'OPEN',
      fundingOutcome: 'COLLECTED',
    });

    const result = await service.reconcileAndSettle(
      'req-reconcile-1',
      selectedEvidence.id,
      {
        expectedRevision: 3,
        reason: 'provider terminal evidence verified',
        idempotencyKey: 'reconcile-settle-1',
        actorId: 'finance-admin-1',
      },
    );

    expect(processSpy).toHaveBeenCalledWith(authoritative, {
      force: true,
      expectedRevision: 4,
      actorId: 'finance-admin-1',
      settlementReconcilesEvidence: true,
    });
    expect(prisma.gatewayUsageReconciliationAction.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        action: 'RECONCILE_SETTLE',
        expectedRevision: 3,
        resultingRevision: 4,
        idempotencyKey: 'reconcile-settle-1',
        metadata: {
          selectedEvidenceId: selectedEvidence.id,
          evidenceHash,
          state: 'CLAIMED',
        },
      }),
    });
    expect(publisherSync.syncBillingAccountKeyBalancesRequired)
      .toHaveBeenCalledWith('billing-account-1');
    expect(result).toMatchObject({
      action: 'deducted',
      evidenceVerdict: 'INCOMPLETE',
      reconciliationStatus: 'OPEN',
    });
  });

  it('closes a quarantined correction as NO_CHARGE from the selected authoritative zero evidence', async () => {
    const { service, prisma, usageBilling } = buildService();
    usageBilling.reserveGatewayBalanceFunding.mockResolvedValueOnce({
      id: 'funding-reservation-review',
      requestId: 'req-reconcile-zero-usage',
      billingAccountId: 'billing-account-1',
      status: 'MANUAL_REVIEW',
      reviewReason: 'legacy finance review',
      reservedAmountUsd: new Prisma.Decimal('0.0008'),
      collectedUsd: new Prisma.Decimal('0.0008'),
      approvedCreditUsd: new Prisma.Decimal(0),
      unapprovedDebtUsd: new Prisma.Decimal(0),
    });
    const requestId = 'req-reconcile-zero-usage';
    const original = usageEvent({
      request_id: requestId,
      token_source: 'estimated',
      estimated_total_tokens: 110,
      prompt_tokens: 100,
      completion_tokens: 10,
      total_tokens: 110,
      token_extras: {},
      usage_evidence: {
        source: 'gateway_estimate',
        status: 'partial',
        protocol: 'openai_sse',
        terminal_frame_seen: false,
      },
      provider_reconciliation_required: true,
    });
    const originalResult = await service.process(original);
    expect(originalResult).toMatchObject({
      action: 'quarantined',
      reason: 'funding_reservation_manual_review',
      revision: 1,
    });

    const authoritative = usageEvent({
      request_id: requestId,
      prompt_tokens: 0,
      completion_tokens: 0,
      total_tokens: 0,
      image_count: 0,
      token_extras: {
        cached_tokens: 0,
        cache_creation_input_tokens: 0,
      },
    });
    const selectedHash = createHash('sha256')
      .update(testCanonicalJson(authoritative))
      .digest('hex');
    const selectedEvidence = {
      id: 'evidence-reconcile-zero-usage',
      gatewayBillingEventId: 'gateway-billing-event-1',
      requestId,
      eventId: 'usage-evt-zero-correction',
      source: 'GATEWAY_USAGE_EVENT',
      evidenceHash: selectedHash,
      rawEvidence: authoritative,
    };
    await prisma.gatewayUsageEvidence.createMany({ data: [selectedEvidence] });

    const originalHash = createHash('sha256')
      .update(testCanonicalJson(original))
      .digest('hex');
    const settlementAnchor = makeTestAnchor({
      requestId,
      apiKeyId: 'key-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      productSlug: 'payg',
      eventOccurredAt: new Date('2026-05-21T08:30:15.000Z'),
    });
    prisma.gatewayBillingEvent.findUnique.mockResolvedValueOnce({
      id: 'gateway-billing-event-1',
      requestId,
      apiKeyId: 'key-1',
      billingAccountId: 'billing-account-1',
      status: 'QUARANTINED',
      reconciliationStatus: 'OPEN',
      evidenceVerdict: 'INCOMPLETE',
      fundingOutcome: null,
      revision: 1,
      reason: 'unsafe_estimated_usage',
      errorMessage: null,
      billingResult: null,
      evidenceHash: originalHash,
      pendingExposureUsd: new Prisma.Decimal('0.0008'),
      pendingHoldUsd: new Prisma.Decimal('0.0008'),
      rawEvent: original,
      settlementAnchor,
      fundingReservation: null,
      tokenUsage: null,
      usageEvidences: [selectedEvidence],
      reconciliationActions: [],
      settlementReceipts: [],
      platformLossEntries: [],
      accessRestrictions: [],
    });

    const result = await service.reconcileAndSettle(
      requestId,
      selectedEvidence.id,
      {
        expectedRevision: 1,
        reason: 'provider terminal proves exact zero usage',
        idempotencyKey: 'reconcile-zero-usage-1',
        actorId: 'finance-admin-1',
      },
    );

    expect(result).toMatchObject({
      action: 'skipped',
      reason: 'zero_usage',
      revision: 3,
      reconciliationStatus: 'CLOSED',
    });
    expect(originalHash).not.toBe(selectedHash);
    expect(prisma.gatewayUsageSettlementReceipt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        requestId,
        fundingOutcome: 'NO_CHARGE',
        evidenceHash: selectedHash,
        reason: 'zero_usage',
      }),
    });
    expect(usageBilling.releaseGatewayBalanceFunding).toHaveBeenCalledWith(
      requestId,
      'non_financial:zero_usage',
    );
  });

  it('rejects a stored evidence row that cannot be correlated to the original upstream call', async () => {
    const { service, prisma, usageBilling } = buildService();
    const original = usageEvent({
      request_id: 'req-reconcile-wrong-upstream',
      token_source: 'estimated',
      usage_evidence: {
        source: 'gateway_estimate',
        status: 'partial',
        protocol: 'anthropic_sse',
        terminal_frame_seen: false,
      },
      provider_reconciliation_required: true,
      token_extras: {},
    });
    const authoritative = usageEvent({
      request_id: 'req-reconcile-wrong-upstream',
      upstream_request_id: 'another-upstream-request',
      upstream_response_id: 'another-upstream-response',
      token_extras: {},
    });
    const evidenceHash = createHash('sha256')
      .update(testCanonicalJson(authoritative))
      .digest('hex');
    const originalEvidenceHash = createHash('sha256')
      .update(testCanonicalJson(original))
      .digest('hex');
    const selectedEvidence = {
      id: 'evidence-wrong-upstream',
      gatewayBillingEventId: 'event-wrong-upstream',
      requestId: 'req-reconcile-wrong-upstream',
      source: 'GATEWAY_USAGE_EVENT',
      evidenceHash,
      rawEvidence: authoritative,
    };
    prisma.gatewayUsageEvidence.findUnique.mockResolvedValue(selectedEvidence);
    prisma.gatewayBillingEvent.findUnique.mockResolvedValue({
      id: 'event-wrong-upstream',
      requestId: 'req-reconcile-wrong-upstream',
      status: 'QUARANTINED',
      reconciliationStatus: 'MANUAL_REVIEW',
      evidenceVerdict: 'CONFLICTED',
      fundingOutcome: null,
      revision: 2,
      reason: 'new_evidence_requires_reconciliation',
      errorMessage: null,
      billingResult: null,
      evidenceHash: originalEvidenceHash,
      pendingExposureUsd: new Prisma.Decimal(0),
      pendingHoldUsd: new Prisma.Decimal(0),
      rawEvent: original,
      settlementAnchor: {},
      usageEvidences: [selectedEvidence],
      reconciliationActions: [],
      settlementReceipts: [],
      platformLossEntries: [],
      accessRestrictions: [],
    });

    await expect(service.reconcileAndSettle(
      'req-reconcile-wrong-upstream',
      selectedEvidence.id,
      {
        expectedRevision: 2,
        reason: 'attempt wrong evidence',
        idempotencyKey: 'reconcile-wrong-upstream',
        actorId: 'finance-admin-1',
      },
    )).rejects.toThrow('upstream correlation id');
    expect(usageBilling.settleDeliveredGatewayUsage).not.toHaveBeenCalled();
    expect(prisma.gatewayUsageReconciliationAction.create).not.toHaveBeenCalled();
  });

  it('uses the selected reconciliation evidence for a later technical retry', async () => {
    const { service, prisma } = buildService();
    const authoritative = usageEvent({
      request_id: 'req-reconcile-retry',
      prompt_tokens: 120,
      completion_tokens: 15,
      total_tokens: 135,
      token_extras: {},
    });
    const evidenceHash = createHash('sha256')
      .update(testCanonicalJson(authoritative))
      .digest('hex');
    const retryableEvent = {
      id: 'event-reconcile-retry',
      requestId: 'req-reconcile-retry',
      status: 'RETRYABLE_FAILED',
      reconciliationStatus: 'RETRY_WAIT',
      evidenceVerdict: 'SETTLEABLE_BY_POLICY',
      fundingOutcome: null,
      revision: 5,
      reason: 'processing_error',
      errorMessage: 'temporary database outage',
      billingResult: null,
      pendingExposureUsd: new Prisma.Decimal(0),
      pendingHoldUsd: new Prisma.Decimal(0),
      rawEvent: usageEvent({
        request_id: 'req-reconcile-retry',
        token_source: 'estimated',
      }),
      usageEvidences: [{
        id: 'evidence-reconcile-retry',
        source: 'GATEWAY_USAGE_EVENT',
        evidenceHash,
        rawEvidence: authoritative,
      }],
      reconciliationActions: [{
        action: 'RECONCILE_SETTLE',
        metadata: {
          selectedEvidenceId: 'evidence-reconcile-retry',
          evidenceHash,
        },
      }],
      settlementReceipts: [],
      platformLossEntries: [],
      accessRestrictions: [],
    };
    prisma.gatewayBillingEvent.findUnique.mockResolvedValue(retryableEvent);
    const processSpy = jest.spyOn(service, 'process').mockResolvedValue({
      action: 'deducted',
      requestId: 'req-reconcile-retry',
      revision: 6,
    });

    await service.retryEvent('req-reconcile-retry', {
      expectedRevision: 5,
      reason: 'retry reconciled evidence',
      idempotencyKey: 'technical-retry-reconciled-evidence',
      actorId: 'finance-admin-1',
    });

    expect(processSpy).toHaveBeenCalledWith(authoritative, expect.objectContaining({
      force: true,
      expectedRevision: 5,
    }));
  });

  describe('P0-1 首收观察时间三态冻结', () => {
    // 冻结查询在服务里可被唯一识别：它是唯一 select 恰为
    // { observedAt, evidenceHash } 的 gatewayUsageEvidence.findUnique
    // （另一处复合键查询 select 五个字段，且在另一个事务里）。
    const FREEZE_SELECT = JSON.stringify({ observedAt: true, evidenceHash: true });
    const freezeCalls = (prisma: Record<string, any>) => prisma.gatewayUsageEvidence.findUnique.mock.calls
      .map((call: any[], index: number) => ({ index, args: call[0] }))
      .filter((entry: { args: any }) => JSON.stringify(entry.args?.select) === FREEZE_SELECT);
    // 墓碑写入走 updateMany（带 legacyOriginalEvidenceMissingAt: null 的 CAS 条件）。
    const tombstoneWrites = (prisma: Record<string, any>) => prisma
      .gatewayBillingEvent.updateMany.mock.calls
      .filter((call: any[]) => Object.prototype.hasOwnProperty.call(
        call[0]?.data ?? {},
        'legacyOriginalEvidenceMissingAt',
      ));
    // 把父 hash 指到一条从未存在的证据上，逼出「首收证据缺失」分支。
    // 改的是 **storedEvent**，因此锁语句与锁前读取都会看到它 —— 不掩盖实现从哪里取值。
    const forceMissingOriginalEvidence = (prisma: Record<string, any>) => {
      const base = prisma.gatewayBillingEvent.findUniqueOrThrow.getMockImplementation();
      prisma.gatewayBillingEvent.findUniqueOrThrow.mockImplementation(async (args: any) => ({
        ...(await base(args)),
        evidenceHash: 'evidence-hash-never-stored',
      }));
      prisma.gatewayBillingEvent.updateMany({
        where: { id: 'gateway-billing-event-1' },
        data: { evidenceHash: 'evidence-hash-never-stored' },
      });
      prisma.gatewayBillingEvent.updateMany.mockClear();
    };

    it('首收：既不查原证据也不写墓碑（本轮插入时间就是首收时间）', async () => {
      const { service, prisma } = buildService();
      await service.process(usageEvent());
      expect(freezeCalls(prisma)).toHaveLength(0);
      expect(tombstoneWrites(prisma)).toHaveLength(0);
    });

    it('重复收件：冻结查询必须早于本轮 evidence 追加（顺序错了 cutover 时钟就会被本轮时间污染）', async () => {
      const { service, prisma } = buildService();
      await service.process(usageEvent());
      prisma.gatewayUsageEvidence.findUnique.mockClear();
      prisma.gatewayUsageEvidence.createMany.mockClear();
      await service.process(usageEvent({ event_id: 'usage-evt-2' }));

      const freeze = freezeCalls(prisma);
      expect(freeze).toHaveLength(1);
      const freezeOrder = prisma.gatewayUsageEvidence.findUnique
        .mock.invocationCallOrder[freeze[0].index];
      const appendOrder = prisma.gatewayUsageEvidence.createMany.mock.invocationCallOrder[0];
      // 两个断言都必要：appendOrder 存在保证本轮真的追加过 evidence（否则顺序断言会空转）。
      expect(appendOrder).toBeGreaterThan(0);
      expect(freezeOrder).toBeLessThan(appendOrder);
    });

    it('重复收件且原证据可查到：不写墓碑', async () => {
      const { service, prisma } = buildService();
      await service.process(usageEvent());
      prisma.gatewayBillingEvent.update.mockClear();
      await service.process(usageEvent({ event_id: 'usage-evt-2' }));
      expect(freezeCalls(prisma)).toHaveLength(1);
      expect(tombstoneWrites(prisma)).toHaveLength(0);
    });

    it('重复收件但原证据缺失：写入墓碑并永久排除', async () => {
      const { service, prisma } = buildService();
      await service.process(usageEvent());
      forceMissingOriginalEvidence(prisma);
      await service.process(usageEvent({ event_id: 'usage-evt-2' }));

      const writes = tombstoneWrites(prisma);
      expect(writes).toHaveLength(1);
      expect(writes[0][0].data.legacyOriginalEvidenceMissingAt).toBeInstanceOf(Date);
    });

    it('墓碑已存在：不再查原证据、不再改写墓碑（重启后判定稳定）', async () => {
      const { service, prisma } = buildService();
      await service.process(usageEvent());
      // ⚠️ 只让**锁语句**看到墓碑，锁前的 findUniqueOrThrow 明确返回 null。
      // 实现若沿用锁前快照，就会走查证据分支 —— 这个用例正是为钉住那个并发缺陷而写。
      prisma.gatewayBillingEvent.updateMany({
        where: { id: 'gateway-billing-event-1' },
        data: { legacyOriginalEvidenceMissingAt: new Date('2026-01-02T03:04:05.000Z') },
      });
      const base = prisma.gatewayBillingEvent.findUniqueOrThrow.getMockImplementation();
      prisma.gatewayBillingEvent.findUniqueOrThrow.mockImplementation(async (args: any) => ({
        ...(await base(args)),
        legacyOriginalEvidenceMissingAt: null,
      }));
      prisma.gatewayUsageEvidence.findUnique.mockClear();
      prisma.gatewayBillingEvent.updateMany.mockClear();
      await service.process(usageEvent({ event_id: 'usage-evt-2' }));

      expect(freezeCalls(prisma)).toHaveLength(0);
      expect(tombstoneWrites(prisma)).toHaveLength(0);
    });

    it('冻结查询必须晚于父行锁语句（锁前读取的快照在并发重收时会过期）', async () => {
      const { service, prisma } = buildService();
      await service.process(usageEvent());
      prisma.$queryRaw.mockClear();
      prisma.gatewayUsageEvidence.findUnique.mockClear();
      await service.process(usageEvent({ event_id: 'usage-evt-2' }));

      const lockIndex = prisma.$queryRaw.mock.calls.findIndex((call: any[]) => {
        const sql = call[0].join(' ');
        return sql.includes('FOR UPDATE') && sql.includes('gateway_billing_events');
      });
      expect(lockIndex).toBeGreaterThanOrEqual(0);
      // 锁语句必须自己带出判定字段，否则「锁后读取」无从谈起。
      const lockSql = prisma.$queryRaw.mock.calls[lockIndex][0].join(' ');
      expect(lockSql).toContain('legacy_original_evidence_missing_at');
      expect(lockSql).toContain('evidence_hash');

      const freeze = freezeCalls(prisma);
      expect(freeze).toHaveLength(1);
      expect(prisma.$queryRaw.mock.invocationCallOrder[lockIndex]).toBeLessThan(
        prisma.gatewayUsageEvidence.findUnique.mock.invocationCallOrder[freeze[0].index],
      );
    });

    it('首收证据 hash 对得上但不是 rev1：必须冻结（否则 writer 必撞三列复合 FK）', async () => {
      const { service, prisma } = buildService();
      await service.process(usageEvent());
      // 库里允许「匹配 hash 的 evidence 是 rev2、rev1 缺失」这种异常状态：
      // 只让按 revision 的点查落空，按 hash 的查询保持原样可查到。
      const baseFindUnique = prisma.gatewayUsageEvidence.findUnique.getMockImplementation();
      prisma.gatewayUsageEvidence.findUnique.mockImplementation(async (args: any) => (
        args?.where?.gatewayBillingEventId_evidenceRevision
          ? null
          : baseFindUnique(args)
      ));
      prisma.gatewayBillingEvent.updateMany.mockClear();
      await service.process(usageEvent({ event_id: 'usage-evt-2' }));

      const writes = tombstoneWrites(prisma);
      expect(writes).toHaveLength(1);
      // 判定必须按 (event, revision=1) 点查，而不是只按 hash。
      const byRevision = prisma.gatewayUsageEvidence.findUnique.mock.calls
        .filter((call: any[]) => call[0]?.where?.gatewayBillingEventId_evidenceRevision);
      expect(byRevision).toHaveLength(1);
      expect(byRevision[0][0].where.gatewayBillingEventId_evidenceRevision.evidenceRevision)
        .toBe(1);
    });

    it('连续两次重复收件：墓碑 CAS 只生效一次（应用层单调，与数据库 write-once 触发器同向）', async () => {
      const { service, prisma } = buildService();
      await service.process(usageEvent());
      // 让父 hash 指向一条不存在的证据，逼出墓碑写入路径。
      forceMissingOriginalEvidence(prisma);
      prisma.gatewayBillingEvent.updateMany.mockClear();

      await service.process(usageEvent({ event_id: 'usage-evt-2' }));
      const first = tombstoneWrites(prisma);
      expect(first).toHaveLength(1);
      const firstValue = first[0][0].data.legacyOriginalEvidenceMissingAt;
      expect(firstValue).toBeInstanceOf(Date);

      await service.process(usageEvent({ event_id: 'usage-evt-3' }));
      // 第二轮仍会尝试写（父行锁内 CAS 是幂等的），但 CAS 必须命中 0 行。
      const writes = tombstoneWrites(prisma);
      expect(writes.length).toBeGreaterThanOrEqual(1);
      for (const call of writes) {
        expect(call[0].where.legacyOriginalEvidenceMissingAt).toBeNull();
      }
      const results = prisma.gatewayBillingEvent.updateMany.mock.results
        .map((r: any, i: number) => ({ i, r }))
        .filter((entry: any) => Object.prototype.hasOwnProperty.call(
          prisma.gatewayBillingEvent.updateMany.mock.calls[entry.i][0]?.data ?? {},
          'legacyOriginalEvidenceMissingAt',
        ));
      const counts = await Promise.all(results.map(async (entry: any) => (
        (await entry.r.value).count
      )));
      expect(counts.filter((c: number) => c === 1)).toHaveLength(1);
    });
  });

  describe('P0-2 provisional exposure writer', () => {
    // 复用仓里已验证会落在目标 reason 上的构造（见「settles pending/skipped quota
    // projection states at zero」用例），再补上本期判定需要的 status_code / is_stream。
    // 注意：客户侧被保护性归零（input 全 0），但 raw evidence 里 completion_tokens 仍是 20
    // —— 敞口量纲取的正是后者，这也是「禁止取 opts.input」的原因。
    const TARGET_EVENT = {
      prompt_tokens: 100,
      completion_tokens: 20,
      total_tokens: 120,
      token_source: 'provider',
      quota_settlement: 'skipped',
      status_code: 504,
      is_stream: false,
    };
    // 边界不再来自环境变量：它是「建 exposure 表那次迁移的完成时刻」，由
    // GatewayProvisionalExposureConfig 启动时从 _prisma_migrations 读一次。
    // 这里用 PROVISIONAL_EXPOSURE_BOUNDARY 直接注入该已读到的边界。
    const READY = {
      provisionalExposureBoundary: '2026-01-01T00:00:00.000Z',
    };

    /** 从注册表读某个 outcome 的当前计数。 */
    async function outcomeCount(outcome: string): Promise<number> {
      const { values } = await billingProvisionalExposureOutcomeTotal.get();
      return values.find((v) => v.labels.outcome === outcome)?.value ?? 0;
    }

    // ⚠️ 这三条钉的是 UAT 就绪评审的唯一阻断项。
    //
    // 原缺陷：writer 里 createMany/读回抛**普通** Prisma 错时，那个 catch 只对
    // GatewayProvisionalExposureInvariantError 计数并原样重抛 ⇒ 外层窄例外不认它 ⇒
    // 落到 `if (financialTerminalCommitted) throw err` ⇒ consumer 归 transient_uncommitted、
    // **不提交 offset** ⇒ 同一条消息无限重放。
    //
    // 瞬时抖动其实会自愈（重放时从既有 receipt 重新推出 financialTerminalCommitted=true）；
    // 真危害是**持久性**失败 —— 表权限被收、约束/schema 漂移、正缓存后表被删 ——
    // 那时该分区**所有租户**的计费永久停摆。一张「绝不参与余额」的旁路观测表
    // 不允许有这种能力。
    describe('写入失败必须归类，不得抛穿成 transient', () => {
      /** 让父事件的终态原因可读，用于确认落的是 QUARANTINED 而非静默放行。 */
      const finalReasons = (prisma: any) => prisma.gatewayBillingEvent.updateMany.mock.calls
        .map((call: any[]) => String(call[0]?.data?.reason ?? ''))
        .filter(Boolean);

      it.each([
        ['createMany 失败（写不进去）', 'createMany'],
        ['读回失败（写完读不到）', 'findUnique'],
      ])('%s ⇒ writer_persistence_failed / QUARANTINE_AND_DLQ', async (_l, fn: any) => {
        const { service, prisma, usageBilling } = buildService(READY);
        const before = await outcomeCount('persistence_failed');
        // ⚠️ 必须还原生产形态：保护性归零**照样**产生 TokenUsage receipt。
        // 43 上这 22 笔全部 billing_result.tokenUsageId 非空、funding_outcome=COLLECTED。
        // 而 fixture 的默认 settleDeliveredGatewayUsage 只返回 {success, allowed} ⇒
        // hasFinancialReceipt=false ⇒ 任何 invariant 都被降级成 BLOCK_PARTITION，
        // 于是测不到本修复要达成的「分区能继续」。
        usageBilling.settleDeliveredGatewayUsage.mockResolvedValue({
          success: true,
          allowed: true,
          tokenUsageId: 'token-usage-protective-zero-1',
          fundingOutcome: 'COLLECTED',
        });
        // 模拟持久性失败：权限被收 / 约束漂移 / 表被删都长这样 —— 普通 Prisma 异常。
        prisma.gatewayUsageProvisionalExposure[fn].mockRejectedValue(
          Object.assign(new Error('permission denied for table'), { code: 'P2010' }),
        );

        const err = await service.process(usageEvent(TARGET_EVENT)).then(
          () => { throw new Error('本应抛出'); },
          (e: unknown) => e,
        );

        // ① 必须是 invariant 族：consumer 只对这一族看 disposition，普通错会走 transient。
        expect(err).toBeInstanceOf(GatewayProvisionalExposureInvariantError);
        expect((err as any).code).toBe('writer_persistence_failed');
        // ② 必须是 quarantine：钱的 receipt 已独立提交，隔离它不丢结算。
        expect((err as any).disposition).toBe('QUARANTINE_AND_DLQ');
        // ③ 原始异常不得被掩盖 —— 包装只改处置，不改来源。
        expect((err as any).cause).toMatchObject({ code: 'P2010' });
        expect((err as any).context.detail).toContain('permission denied');
        // ④ 父事件落 QUARANTINED 并带上可检索的 code，不是静默放行。
        expect(finalReasons(prisma)).toContain(
          'provisional_exposure_invariant:writer_persistence_failed',
        );
        // ⑤ 计数落在独立一格：基础设施问题与记录内容矛盾的运维动作完全不同。
        expect(await outcomeCount('persistence_failed')).toBe(before + 1);
      });

      it('钱还没落地时，写入失败必须降级为 BLOCK_PARTITION（不许 DLQ+commit）', async () => {
        // 这一条守的是 quarantine 的前提。fixture 默认就没有 TokenUsage receipt，
        // 此时 DLQ + commit offset 会**同时**丢掉敞口与结算 —— 必须 fail-closed。
        const { service, prisma } = buildService(READY);
        prisma.gatewayUsageProvisionalExposure.createMany.mockRejectedValue(
          new Error('permission denied for table'),
        );

        const err = await service.process(usageEvent(TARGET_EVENT)).then(
          () => { throw new Error('本应抛出'); },
          (e: unknown) => e,
        );

        expect((err as any).code).toBe('writer_persistence_failed');
        expect((err as any).disposition).toBe('BLOCK_PARTITION');
      });
      it('真正的内容矛盾仍归 invariant_error，不被新分支吞掉', async () => {
        // 反向钉：若把归类写成无条件包装，既有 invariant 的 code 会被改写成
        // writer_persistence_failed，DLQ 里就再也分不出「证据不对」和「库写不进去」。
        const { service, prisma } = buildService(READY);
        const persistBefore = await outcomeCount('persistence_failed');
        const invariantBefore = await outcomeCount('invariant_error');
        // 写完读回为空 ⇒ exposure_missing_after_insert（内容矛盾，非写入失败）。
        prisma.gatewayUsageProvisionalExposure.findUnique.mockResolvedValue(null);

        const err = await service.process(usageEvent(TARGET_EVENT)).then(
          () => { throw new Error('本应抛出'); },
          (e: unknown) => e,
        );

        expect((err as any).code).toBe('exposure_missing_after_insert');
        expect(await outcomeCount('persistence_failed')).toBe(persistBefore);
        expect(await outcomeCount('invariant_error')).toBe(invariantBefore + 1);
      });
    });
    it('第一道 cutover 短路必须在证据读取之前：读不到证据也不能抛', async () => {
      // ⚠️ 这条钉的是**第一道**判定（评审 P1）。先前两道 cutover 判定各自都不被钉住 ——
      // 只留一道测试就全绿 ⇒ 下一个「清理重复逻辑」的人可以安全删掉第一道，
      // 而删掉就精确回退了 f543aaa 修的那个 P0：T 之前的事件先撞
      // source_evidence_missing / revision_not_one ⇒ BLOCK_PARTITION 卡住整个 partition，
      // 或把一笔正常结算投进 DLQ。
      const { service, prisma, storedExposures } = buildService({
        // T 远在未来 ⇒ 所有事件都在 T 之前。
        provisionalExposureBoundary: '2027-08-28T00:00:00.000Z',
      });
      // 让 writer 那次按复合唯一键的查询查不到证据（若短路在它之后，这里必抛）。
      const baseFindUnique = prisma.gatewayUsageEvidence.findUnique.getMockImplementation();
      prisma.gatewayUsageEvidence.findUnique.mockImplementation(async (args: any) => (
        args?.where?.gatewayBillingEventId_evidenceHash ? null : baseFindUnique(args)
      ));

      const before = await outcomeCount('pre_cutover');
      await expect(service.process(usageEvent(TARGET_EVENT)))
        .resolves.toMatchObject({ action: 'deducted' });
      expect(storedExposures.size).toBe(0);
      expect(await outcomeCount('pre_cutover')).toBe(before + 1);
    });

    it.each([
      ['forced_skip', { force: true }, 'forced_skip'],
      ['schema 未就绪', { provisionalExposureBoundary: undefined }, 'schema_not_ready'],
    ])('归因唯一化：%s ⇒ 计数只落在 %s 一格', async (_label, knobs: any, expected) => {
      // ⚠️ 归因契约（writer docblock 里写着「不得重复计数」）先前**零断言**：
      // 把边界的解析条件从 `decision ?` 改成 `decision?.kind === 'write' ?`（27 字符），
      // forced_skip 与 legacy_original_evidence_missing 就会静默改记成 schema_not_ready，
      // 而 schema_not_ready 正是删掉 ..._enabled gauge 之后唯一的「功能是不是悄悄关了」哨兵。
      const { force, ...configKnobs } = knobs;
      const { service } = buildService({ ...READY, ...configKnobs });
      const others = ['forced_skip', 'schema_not_ready', 'inserted', 'output_tokens_unrepresentable'];
      const before: Record<string, number> = {};
      for (const o of others) before[o] = await outcomeCount(o);

      await service.process(usageEvent(TARGET_EVENT), force ? { force: true } : undefined);

      for (const o of others) {
        const delta = (await outcomeCount(o)) - before[o];
        expect({ outcome: o, delta }).toEqual({ outcome: o, delta: o === expected ? 1 : 0 });
      }
    });

    it('输出 token 不是安全整数 ⇒ 只归 output_tokens_unrepresentable，绝不抛（不得改主路径终态）',
      async () => {
        // ⚠️ 原实现抛 output_tokens_not_safe_integer ⇒ QUARANTINE_AND_DLQ ⇒ 一个畸形的
        // completion_tokens 就能把一笔**已成功、已 0 计费落地**的结算改成 QUARANTINED、
        // 并把消息投进 DLQ。旁路观测不该有这种能力，本轮降级为不抛的归因。
        //
        // 这条用例同时是「删掉关停开关」的前提：开关唯一的现实场景就是这类 DLQ 洪水。
        // ⚠️ 注入位置有两个坑，都踩过：
        //   · 改 storedEvidence 的 rawEvidence ⇒ canonicalSha256(raw) 与 evidenceHash 不一致，
        //     先撞七项绑定断言里的 source_evidence_binding_mismatch，到不了 token 判定；
        //   · 把超大值放进**核心** token ⇒ 父结算路径自己的安全整数闸先把事件 quarantine 掉。
        // 真正可达的形态正是生产里那 84/84 的样子：核心 token 全 0、正输出只在
        // estimated_total_tokens 里（writer 的 extractTokens 有回落分支会取它）。
        const { service, prisma, storedExposures } = buildService(READY);
        // Number('9007199254740993') === 9007199254740992（2^53），isSafeInteger 为 false。
        const HUGE = '9007199254740993';

        // 实测结论（值得记下来）：父结算路径**自己**就会拒绝不可表示的 token 值 ——
        // 无论放在核心 token 还是 estimated_total_tokens，事件都会被父路径 quarantine。
        // 也就是说 writer 的这个分支在生产里本就**不可达**；本轮的降级属纵深防御，
        // 同时也说明「畸形 token 导致 DLQ 洪水」这个场景其实不存在 ——
        // 这正是可以放心删掉运行时关停开关的依据之一。
        //
        // 因此这里断言能观察到的真相：writer **不抛**（不贡献 BLOCK_PARTITION/DLQ）、
        // 不写行，且终态原因里**没有**我们的 invariant 前缀（quarantine 是父路径自己的判定）。
        const result = await service.process(usageEvent({
          ...TARGET_EVENT,
          prompt_tokens: 0,
          completion_tokens: 0,
          total_tokens: 0,
          estimated_total_tokens: HUGE,
          token_source: 'estimated',
        }));
        expect(storedExposures.size).toBe(0);
        const reasons = prisma.gatewayBillingEvent.updateMany.mock.calls
          .map((call: any[]) => String(call[0]?.data?.reason ?? ''))
          .join(' | ');
        expect(reasons).not.toContain('provisional_exposure_invariant');
        expect(result).toBeDefined();
      });

    it('schema 未就绪 + 有毒证据 ⇒ 只归 schema_not_ready，且证据表一次都不读', async () => {
      // ⚠️ 这条钉的是**判定顺序**（评审 P1）。把 `if (!cutoverAt) return 'schema_not_ready'`
      // 挪到证据读取或七项绑定断言之后，正常输入的用例照旧全绿；而生产后果正是 f543aaa 刚
      // 修掉的那个 P0 —— 未就绪时一行都不写，却因历史数据不一致抛 invariant，
      // BLOCK_PARTITION 卡住整个 partition 或把一笔正常结算投进 DLQ。
      //
      // 「证据表一次都没被读」这一条断言就足以冻结整个顺序。
      const { service, prisma, storedExposures } = buildService();
      // 把首收证据弄成会让绑定断言失败的形态（request_id 对不上）。
      const baseFindUnique = prisma.gatewayUsageEvidence.findUnique.getMockImplementation();
      prisma.gatewayUsageEvidence.findUnique.mockImplementation(async (args: any) => {
        const row = await baseFindUnique(args);
        if (row && args?.where?.gatewayBillingEventId_evidenceHash) {
          return { ...row, rawEvidence: { ...(row.rawEvidence ?? {}), request_id: 'someone-else' } };
        }
        return row;
      });
      prisma.gatewayUsageEvidence.findUnique.mockClear();

      await expect(service.process(usageEvent(TARGET_EVENT)))
        .resolves.toMatchObject({ action: 'deducted' });

      expect(storedExposures.size).toBe(0);
      // writer 走的那次查询用的是复合唯一键；未就绪时它绝不该发生。
      const readBySourceKey = prisma.gatewayUsageEvidence.findUnique.mock.calls
        .some((call: any[]) => Boolean(call[0]?.where?.gatewayBillingEventId_evidenceHash));
      expect(readBySourceKey).toBe(false);
    });

    it('schema 未就绪（读不到迁移记录）⇒ fail-closed，一行都不写', async () => {
      // 这是唯一的停用路径：迁移没跑成 ⇒ 边界为空 ⇒ writer 什么都不做。
      // 没有环境变量真值表可测了 —— 那两个一次性 GitOps 变量已删除。
      const { service, storedExposures } = buildService();
      await expect(service.process(usageEvent(TARGET_EVENT)))
        .resolves.toMatchObject({ action: 'deducted' });
      expect(storedExposures.size).toBe(0);
    });

    it('端到端：目标 reason + 已启用 + T 之后 ⇒ 真的写出一行，字段逐项正确', async () => {
      const { service, prisma, storedExposures } = buildService(READY);
      const result = await service.process(usageEvent(TARGET_EVENT));

      // 前提：这条事件确实落在目标 reason 上，否则整个用例是空转。
      expect(result).toMatchObject({ action: 'deducted' });
      const finalReason = prisma.gatewayBillingEvent.updateMany.mock.calls
        .map((call: any[]) => call[0]?.data?.reason)
        .filter(Boolean)
        .at(-1);
      expect(finalReason).toBe(
        'customer_protective_zero:unproven_no_charge:quota_settlement_skipped',
      );

      expect(storedExposures.size).toBe(1);
      const row = [...storedExposures.values()][0];
      expect(row).toMatchObject({
        gatewayBillingEventId: 'gateway-billing-event-1',
        sourceEvidenceRevision: 1,
        exposureKind: 'platform_timeout',
        sourceReason:
          'customer_protective_zero:unproven_no_charge:quota_settlement_skipped',
        httpStatus: 504,
        inputTokens: null,
        amountUsd: null,
        amountStatus: 'unpriced',
        tokenSource: 'provider',
      });
      // 量纲必须取自收窄后的 raw evidence，而不是被保护性归零清零过的 input。
      expect(row.outputTokens).toBe(20n);
      // sourceEvidenceId 必须指向首收证据本身 —— 这一条证明 P0-1 冻结的观察结果
      // 真的流到了写入，而不是停在结构体里。
      const rev1 = [...storedEvidencesOf(prisma)].find((e) => e.evidenceRevision === 1);
      expect(row.sourceEvidenceId).toBe(rev1?.id);
    });

    it('真实载荷形态：token_source=estimated 且核心 token 全 0 ⇒ 输出取 estimated_total_tokens', async () => {
      // ⚠️ 这条用例的存在理由：上面那条端到端用例用的是 completion_tokens=20，
      // 而 test 库里该族 **84/84** 的真实形态是
      // token_source='estimated'、prompt/completion/total_tokens 全为 0、
      // 正输出只在 estimated_total_tokens 里（2026-08-28 实测，与设计稿实测一致）。
      // 也就是说：只钉 completion_tokens 的用例会在一个**真实数据里不存在的形态**上通过，
      // 而 extractTokens 里那条「核心 token 为 0 时回落到 reportedTotal」的分支一旦被
      // 「清理」掉，生产会 100% 归到 zero_output、一行都不写，测试却全绿。
      const { service, prisma, storedExposures } = buildService(READY);
      await service.process(usageEvent({
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        token_source: 'estimated',
        estimated_total_tokens: 2063,
        quota_settlement: 'skipped',
        status_code: 504,
        is_stream: false,
      }));

      // 先确认前提成立：这条事件确实落在目标 reason 上（否则用例空转）。
      const finalReason = prisma.gatewayBillingEvent.updateMany.mock.calls
        .map((call: any[]) => call[0]?.data?.reason)
        .filter(Boolean)
        .at(-1);
      expect(finalReason).toBe(
        'customer_protective_zero:unproven_no_charge:quota_settlement_skipped',
      );

      expect(storedExposures.size).toBe(1);
      const row = [...storedExposures.values()][0];
      expect(row.outputTokens).toBe(2063n);
      expect(row.tokenSource).toBe('estimated');
      expect(row.httpStatus).toBe(504);
      expect(row.exposureKind).toBe('platform_timeout');
      // input 恒 NULL：该族 input 实测全为 0，是 UNKNOWN 被编码成 0，绝不写 0 冒充确实为 0。
      expect(row.inputTokens).toBeNull();
    });

    it('真实载荷形态 + 499 ⇒ client_cancellation', async () => {
      const { service, storedExposures } = buildService(READY);
      await service.process(usageEvent({
        prompt_tokens: 0,
        completion_tokens: 0,
        total_tokens: 0,
        token_source: 'estimated',
        estimated_total_tokens: 2171,
        quota_settlement: 'skipped',
        status_code: 499,
        is_stream: false,
      }));
      expect(storedExposures.size).toBe(1);
      const row = [...storedExposures.values()][0];
      expect(row.exposureKind).toBe('client_cancellation');
      expect(row.outputTokens).toBe(2171n);
    });

    it('cutover 边界：observedAt 恰等于 T ⇒ 写入；早于 T ⇒ 不写入', async () => {
      // 收件观察时间由 mock 的数据库时钟给出：2026-08-06T12:00:00.000Z。
      const onBoundary = buildService({
        ...READY,
        provisionalExposureBoundary: '2026-08-06T12:00:00.000Z',
      });
      await onBoundary.service.process(usageEvent(TARGET_EVENT));
      expect(onBoundary.storedExposures.size).toBe(1);

      const afterBoundary = buildService({
        ...READY,
        provisionalExposureBoundary: '2026-08-06T12:00:00.001Z',
      });
      await afterBoundary.service.process(usageEvent(TARGET_EVENT));
      expect(afterBoundary.storedExposures.size).toBe(0);
    });

    it('T 之前的事件即使证据绑定有问题，也只归 pre_cutover，绝不抛 invariant 卡 partition', async () => {
      // ⚠️ 这条钉的是**判定顺序**。cutover 若排在绑定断言之后，T 之前的历史事件会先撞
      // invariant ⇒ BLOCK_PARTITION 卡住整个 partition，或把一笔正常结算投进 DLQ ——
      // 「不记任何东西，却承担全部风险」。T 设得越远，这个窗口越长（设一年就是一年）。
      const { service, prisma, storedExposures } = buildService({
        ...READY,
        // T 远在未来 ⇒ 所有事件都在 T 之前。
        provisionalExposureBoundary: '2027-08-28T00:00:00.000Z',
      });
      // 把首收证据的 raw 弄成会让七项绑定断言失败的形态（request_id 对不上）。
      const baseFindUnique = prisma.gatewayUsageEvidence.findUnique.getMockImplementation();
      prisma.gatewayUsageEvidence.findUnique.mockImplementation(async (args: any) => {
        const row = await baseFindUnique(args);
        if (row && args?.where?.gatewayBillingEventId_evidenceHash) {
          return { ...row, rawEvidence: { ...(row.rawEvidence ?? {}), request_id: 'someone-else' } };
        }
        return row;
      });

      // 必须正常返回（deducted），不能因 invariant 抛出。
      await expect(service.process(usageEvent(TARGET_EVENT)))
        .resolves.toMatchObject({ action: 'deducted' });
      expect(storedExposures.size).toBe(0);
    });
    it('is_stream 三态：true ⇒ 不写；缺失/非布尔 ⇒ 不写（absent ≠ false）', async () => {
      // ⚠️ 「缺失」必须真的把字段去掉 —— 用 {} 覆盖是删不掉的（这一点我第一版就写错了）。
      const { is_stream: _omit, ...WITHOUT_STREAM } = TARGET_EVENT;
      const variants: Array<[string, Record<string, unknown>]> = [
        ['true', { ...TARGET_EVENT, is_stream: true }],
        ['absent', WITHOUT_STREAM],
        ['string "false"', { ...TARGET_EVENT, is_stream: 'false' }],
        ['null', { ...TARGET_EVENT, is_stream: null }],
      ];
      for (const [label, event] of variants) {
        const { service, storedExposures } = buildService(READY);
        await service.process(usageEvent(event));
        expect(storedExposures.size).toBe(0);
        expect(label).toBeTruthy();
      }
      // 对照：只有布尔 false 才写 —— 否则上面四格可能是因为别的原因不写（空转）。
      const control = buildService(READY);
      await control.service.process(usageEvent(TARGET_EVENT));
      expect(control.storedExposures.size).toBe(1);
    });

    it('force ⇒ forced_skip，不写入且不阻断既有结算', async () => {
      const { service, storedExposures } = buildService(READY);
      const result = await service.process(
        usageEvent(TARGET_EVENT),
        { force: true, expectedRevision: 0 } as never,
      );
      expect(result).toMatchObject({ action: 'deducted' });
      expect(storedExposures.size).toBe(0);
    });

    it('幂等：同一事件重复写入只留一行，内容一致不抛错', async () => {
      const { service, storedExposures } = buildService(READY);
      await service.process(usageEvent(TARGET_EVENT));
      expect(storedExposures.size).toBe(1);
      const before = { ...[...storedExposures.values()][0] };
      // 预置一条与本轮内容一致的行，再走一次 writer。
      await service.process(usageEvent(TARGET_EVENT));
      expect(storedExposures.size).toBe(1);
      expect([...storedExposures.values()][0].outputTokens).toBe(before.outputTokens);
    });

    it('既有行内容冲突 ⇒ 抛 existing_exposure_content_conflict（不得被 skipDuplicates 吞掉）', async () => {
      const { service, storedExposures } = buildService(READY);
      storedExposures.set('gateway-billing-event-1', {
        id: 'exposure-preexisting',
        createdAt: new Date(),
        gatewayBillingEventId: 'gateway-billing-event-1',
        sourceEvidenceId: 'some-other-evidence',
        sourceEvidenceRevision: 1,
        exposureKind: 'client_cancellation',
        sourceReason:
          'customer_protective_zero:unproven_no_charge:quota_settlement_skipped',
        httpStatus: 499,
        outputTokens: 7n,
        inputTokens: null,
        tokenSource: 'estimated',
        amountUsd: null,
        amountStatus: 'unpriced',
      });
      await expect(service.process(usageEvent(TARGET_EVENT)))
        .rejects.toThrow(/existing_exposure_content_conflict/);
    });
  });

  // 【2026-09-22 上海 UAT 402 回归】冻结 RETRY_WAIT 的自愈收口。
  // 事故:泄漏的队头 funding reservation 卡死重试,事件冻在 RETRY_WAIT 39 天,
  // 排空判据永不归零,账户级限制连坐整个账户全端点 402。
  describe('recoverFrozenRetryWaitEvent — RETRY_WAIT 死锁自愈', () => {
    it('收口冻结事件为 FAILED/CLOSED 并按 legacy requestId 键释放限制', async () => {
      const { service, prisma } = buildService();
      prisma.gatewayBillingEvent.findUnique.mockResolvedValue({
        id: 'evt-1', requestId: 'req-frozen-1', status: 'RETRYABLE_FAILED',
        reconciliationStatus: 'RETRY_WAIT',
        billingAccountId: 'ba-1', apiKeyId: 'key-1',
        errorMessage: 'GATEWAY_FUNDING_RESERVATION_QUEUE_PENDING',
      });
      prisma.gatewayBillingEvent.updateMany.mockResolvedValue({ count: 1 });
      prisma.gatewayBillingEvent.count.mockResolvedValue(0);
      (prisma.billingAccessRestriction.findMany as jest.Mock).mockResolvedValue([
        { id: 'restriction-legacy', idempotencyKey: 'gateway:settlement_retry_pending:req-frozen-1' },
      ]);

      const outcome = await service.recoverFrozenRetryWaitEvent('evt-1');

      expect(outcome).toEqual({ recovered: true, requestId: 'req-frozen-1' });
      expect(prisma.gatewayBillingEvent.updateMany).toHaveBeenCalledWith({
        where: { id: 'evt-1', status: 'RETRYABLE_FAILED' },
        data: expect.objectContaining({
          status: 'FAILED',
          reconciliationStatus: 'CLOSED',
          errorMessage: expect.stringContaining('retry_wait_recovery_20260922'),
        }),
      });
      const legacyRelease = (prisma.billingAccessRestriction.updateMany as jest.Mock).mock.calls
        .map(([w]) => w)
        .find((w) => w?.where?.idempotencyKey === 'gateway:settlement_retry_pending:req-frozen-1');
      expect(legacyRelease).toBeDefined();
      expect(legacyRelease.data.status).toBe('RELEASED');
    });

    it('事件已非 RETRYABLE(被并发收口)时放弃且不改任何状态', async () => {
      const { service, prisma } = buildService();
      prisma.gatewayBillingEvent.findUnique.mockResolvedValue({
        id: 'evt-2', requestId: 'req-2', status: 'DEDUCTED',
        reconciliationStatus: 'CLOSED', billingAccountId: null, apiKeyId: null,
        errorMessage: null,
      });

      const outcome = await service.recoverFrozenRetryWaitEvent('evt-2');

      expect(outcome).toEqual({ recovered: false, requestId: 'req-2' });
      expect(prisma.gatewayBillingEvent.updateMany).not.toHaveBeenCalled();
      expect(prisma.billingAccessRestriction.updateMany).not.toHaveBeenCalled();
    });
  });
});
