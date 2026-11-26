import { NotFoundException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'node:crypto';
import {
  type GatewayCustomerPricingSnapshot,
  type GatewaySettlementAnchor,
  type GatewaySettlementContext,
  type UsageDeductInput,
  GatewayBillingCurrencyMigrationRequiredError,
  GatewaySettlementAnchorConflictError,
  UsageBillingStrategyService,
  fundingMeasure,
} from './usage-billing-strategy.service';
import { billingUsageDeductLockKey } from '../common/utils/redis-key.util';
import { setSelfopNegativeDeductOverride } from '../quota-templates/plan-quota-rule-views';
import { createStageTimings, runWithStageTimings } from '../common/runtime/usage-stage-timings';

describe('UsageBillingStrategyService', () => {
  function testCanonicalJson(value: unknown): string {
    if (value === null || typeof value !== 'object') return JSON.stringify(value);
    if (Array.isArray(value)) return `[${value.map(testCanonicalJson).join(',')}]`;
    return `{${Object.entries(value as Record<string, unknown>)
      .filter(([, item]) => item !== undefined)
      .sort(([left], [right]) => left.localeCompare(right))
      .map(([key, item]) => `${JSON.stringify(key)}:${testCanonicalJson(item)}`)
      .join(',')}}`;
  }

  function buildService(overrides: Record<string, unknown> = {}) {
    const { __config, __deploymentConfig, ...prismaOverrides } = overrides as Record<string, unknown> & {
      __config?: Record<string, string | boolean | undefined>;
      __deploymentConfig?: Record<string, unknown>;
    };
    const prisma = {
      product: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'prod-payg',
          slug: 'payg',
          billingMode: 'PAY_AS_YOU_GO',
        }),
        findFirst: jest.fn().mockResolvedValue({
          id: 'prod-payg',
          slug: 'payg',
          billingMode: 'PAY_AS_YOU_GO',
          deletedAt: null,
        }),
      },
      user: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'user-1',
          email: 'u@example.com',
          currentTenantId: 'tenant-1',
        }),
      },
      tenant: {
        findFirst: jest.fn().mockResolvedValue({ id: 'tenant-1' }),
        findUnique: jest.fn().mockResolvedValue({
          billingAccountId: 'ba-personal-1',
          billingAccount: { type: 'personal', currency: 'USD' },
        }),
      },
      apiKey: {
        findUnique: jest.fn().mockResolvedValue({
          userId: 'user-1',
          tenantId: 'tenant-1',
          productId: 'prod-payg',
          codingPlanEntitlementId: null,
        }),
        findFirst: jest.fn().mockResolvedValue({
          id: 'key-1',
          userId: 'user-1',
          tenantId: 'tenant-1',
          productId: 'prod-payg',
          isActive: true,
          mirrorStatus: 'ACTIVE',
          deletedAt: null,
          user: { id: 'user-1', email: 'u@example.com' },
          tenant: {
            billingAccountId: 'ba-personal-1',
            billingAccount: { type: 'personal', currency: 'USD' },
          },
          product: {
            id: 'prod-payg',
            slug: 'payg',
            billingMode: 'PAY_AS_YOU_GO',
          },
        }),
      },
      tokenUsage: {
        create: jest.fn().mockResolvedValue({ id: 'usage-1' }),
      },
      plan: {
        findUnique: jest.fn().mockResolvedValue({ quotaRules: [] }),
      },
      gatewayBillingEvent: {
        findUnique: jest.fn().mockResolvedValue(null),
        aggregate: jest.fn().mockResolvedValue({
          _sum: { pendingHoldUsd: null },
        }),
      },
      gatewayUsageSettlementAnchor: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      gatewayUsageFundingReservation: {
        aggregate: jest.fn().mockResolvedValue({
          _sum: { reservedAmountUsd: null },
        }),
      },
      gatewayUsageEvidence: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      gatewayUsageSettlementReceipt: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({ id: 'receipt-1' }),
      },
      accountWallet: {
        findUnique: jest.fn().mockResolvedValue({ billingAccountId: 'ba-personal-1' }),
      },
      billingAccount: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'ba-personal-1',
          type: 'personal',
          currency: 'USD',
        }),
      },
      codingPlanEntitlement: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      subscriptionPeriod: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      modelAccess: {
        findUnique: jest.fn().mockResolvedValue({
          isActive: true,
          creditMultiplier: new Prisma.Decimal(1),
        }),
      },
      tenantMember: {
        findFirst: jest.fn().mockResolvedValue({ id: 'member-1', tenantId: 'tenant-1' }),
      },
      userSegmentMember: {
        findMany: jest.fn().mockResolvedValue([{ segmentId: 'seg-1' }]),
      },
      idempotencyKey: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockResolvedValue({}),
        delete: jest.fn().mockResolvedValue({}),
        deleteMany: jest.fn().mockResolvedValue({ count: 1 }),
        upsert: jest.fn().mockResolvedValue({}),
      },
      usagePricingPolicy: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'global',
            scope: 'GLOBAL',
            userId: null,
            segmentId: null,
            modelName: null,
            priceMultiplier: new Prisma.Decimal('0.9'),
            creditMultiplier: null,
            priority: 10,
            createdAt: new Date('2026-01-01T00:00:00Z'),
          },
          {
            id: 'segment',
            scope: 'SEGMENT',
            userId: null,
            segmentId: 'seg-1',
            modelName: null,
            priceMultiplier: new Prisma.Decimal('0.8'),
            creditMultiplier: null,
            priority: 10,
            createdAt: new Date('2026-01-01T00:00:00Z'),
          },
          {
            id: 'user',
            scope: 'USER',
            userId: 'user-1',
            segmentId: null,
            modelName: null,
            priceMultiplier: new Prisma.Decimal('0.7'),
            creditMultiplier: null,
            priority: 0,
            createdAt: new Date('2026-01-01T00:00:00Z'),
          },
        ]),
      },
      enterpriseModelDiscount: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue({}),
      },
      ...prismaOverrides,
    };
    (prisma as typeof prisma & { $transaction: jest.Mock }).$transaction = jest.fn(
      async (callback: (tx: typeof prisma) => Promise<unknown>) => callback(prisma),
    );
    (prisma as typeof prisma & { $queryRaw: jest.Mock }).$queryRaw = jest
      .fn()
      .mockResolvedValue([]);
    (prisma as typeof prisma & { $executeRaw: jest.Mock }).$executeRaw = jest
      .fn()
      .mockResolvedValue(1);

    const modelPricing = {
      calculateCostQuote: jest.fn().mockImplementation(async (
        _model: string,
        inputTokens: number,
        outputTokens: number,
        cachedInputTokens = 0,
        cacheWriteInputTokens = 0,
        options: { imageCount?: number } = {},
      ) => {
        const imageCount = Math.max(0, Math.floor(options.imageCount ?? 0));
        if (imageCount > 0) {
          const unitPriceUsd = new Prisma.Decimal('0.06');
          const costUsd = unitPriceUsd.mul(imageCount);
          return {
            costUsd,
            pricingTierKey: null,
            inputPriceUsdPerM: new Prisma.Decimal(0),
            cachedInputPriceUsdPerM: null,
            cacheWritePriceUsdPerM: null,
            outputPriceUsdPerM: new Prisma.Decimal(0),
            lineItems: [{
              meter: 'image',
              quantity: imageCount,
              unitPriceUsd,
              amountUsd: costUsd,
            }],
          };
        }
        const inputPriceUsdPerM = new Prisma.Decimal('500');
        const outputPriceUsdPerM = new Prisma.Decimal('1500');
        const safeCachedInputTokens = Math.min(Math.max(0, cachedInputTokens), inputTokens);
        const safeCacheWriteInputTokens = Math.min(
          Math.max(0, cacheWriteInputTokens),
          inputTokens - safeCachedInputTokens,
        );
        const regularInputTokens = inputTokens - safeCachedInputTokens - safeCacheWriteInputTokens;
        const costUsd = new Prisma.Decimal(regularInputTokens + safeCachedInputTokens + safeCacheWriteInputTokens)
          .mul(inputPriceUsdPerM)
          .plus(new Prisma.Decimal(outputTokens).mul(outputPriceUsdPerM))
          .div(1_000_000)
          .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
        return {
          costUsd,
          pricingTierKey: null,
          inputPriceUsdPerM,
          cachedInputPriceUsdPerM: null,
          cacheWritePriceUsdPerM: null,
          outputPriceUsdPerM,
        };
      }),
    };
    const providerCostPricing = {
      quote: jest.fn().mockResolvedValue(null),
    };
    const redis = {
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };
    const balanceDeductState = {
      workspaceBalanceUsd: '9.125',
      accountBalanceUsd: '9.125',
      billingAccountId: 'ba-personal-1',
      tenantId: 'tenant-1',
      billingAccountType: 'personal',
      creditLimitUsd: '0',
      creditStatus: null as string | null,
      creditTermsDays: null as number | null,
      creditEffectiveAt: null as Date | null,
      creditExpiresAt: null as Date | null,
      creditPolicyAt: new Date('2026-07-16T00:00:00.000Z'),
      creditPolicySource: 'NOT_APPLICABLE',
      creditPolicyReconstructible: true,
      collectedUsd: undefined as string | undefined,
      approvedCreditUsd: undefined as string | undefined,
      unapprovedDebtUsd: undefined as string | undefined,
    };
    const billingService = {
      getBalanceUsd: jest.fn().mockResolvedValue(new Prisma.Decimal('10')),
      getBalanceReportForUser: jest.fn().mockResolvedValue({
        tenantId: 'tenant-1',
        balanceCents: 1000,
        balanceUsd: 10,
        accountBalanceCents: 1000,
        accountBalanceUsd: 10,
        accountAvailableBalanceCents: 1000,
        accountAvailableBalanceUsd: 10,
        billingAccountType: 'personal',
        creditLimitCents: 0,
        creditLimitUsd: 0,
        creditUsedCents: 0,
        creditUsedUsd: 0,
        creditRemainingCents: 0,
        creditRemainingUsd: 0,
      }),
      deduct: jest.fn().mockImplementation(async (
        _userId: string,
        _amount: string,
        _source: string,
        options?: {
          anchoredTenantId?: string;
          anchoredBillingAccountId?: string;
          fundingPolicyOccurrence?: {
            gatewayStartAt: Date;
            firstReceivedAt: Date;
          };
          validateAnchoredSubject?: (tx: typeof prisma) => Promise<void>;
          beforeBalanceTransaction?: (
            tx: typeof prisma,
            context: {
              debtOpen: boolean;
              debtExposureUsd: Prisma.Decimal;
              collectedUsd: Prisma.Decimal;
              approvedCreditUsd: Prisma.Decimal;
              unapprovedDebtUsd: Prisma.Decimal;
              fundingPolicy: {
                policyAt: Date;
                policyRevision?: number | null;
                source?: string;
                reconstructible?: boolean;
                termsDays: number | null;
                limitUsd: Prisma.Decimal;
                status?: string | null;
                effectiveAt?: Date | null;
                expiresAt?: Date | null;
              };
            },
          ) => Promise<{ tokenUsageId?: string | null } | void>;
          afterBalanceTransaction?: (
            tx: typeof prisma,
            snapshot: {
              workspaceBalanceUsd: Prisma.Decimal;
              accountBalanceUsd: Prisma.Decimal;
              billingAccountType: string;
              creditLimitUsd: Prisma.Decimal;
              creditStatus: string | null;
              creditTermsDays: number | null;
              creditEffectiveAt: Date | null;
              creditExpiresAt: Date | null;
              creditPolicyAt: Date;
              creditPolicySource: string;
              creditPolicyReconstructible: boolean;
              allowanceUsd: Prisma.Decimal | null;
              allowanceUsedUsd: Prisma.Decimal;
              allowanceRemainingUsd: Prisma.Decimal | null;
            },
            context: {
              balanceTransactionId: string;
              billingAccountId: string;
              tenantId: string;
              tokenUsageId?: string | null;
              debtOpen: boolean;
              debtExposureUsd: Prisma.Decimal;
              collectedUsd: Prisma.Decimal;
              approvedCreditUsd: Prisma.Decimal;
              unapprovedDebtUsd: Prisma.Decimal;
              fundingPolicy: {
                policyAt: Date;
                policyRevision?: number | null;
                source?: string;
                reconstructible?: boolean;
                termsDays: number | null;
                limitUsd: Prisma.Decimal;
                status?: string | null;
                effectiveAt?: Date | null;
                expiresAt?: Date | null;
              };
            },
          ) => Promise<void>;
        },
      ) => {
        const debtExposureUsd = Prisma.Decimal.max(
          new Prisma.Decimal(0),
          new Prisma.Decimal(balanceDeductState.workspaceBalanceUsd).neg(),
        );
        const debtOpen = debtExposureUsd.gt(0);
        const amountUsd = new Prisma.Decimal(_amount);
        const approvedCreditUsd = new Prisma.Decimal(
          balanceDeductState.approvedCreditUsd ?? 0,
        );
        const unapprovedDebtUsd = new Prisma.Decimal(
          balanceDeductState.unapprovedDebtUsd ?? (debtOpen ? amountUsd : 0),
        );
        const collectedUsd = balanceDeductState.collectedUsd === undefined
          ? amountUsd.minus(approvedCreditUsd).minus(unapprovedDebtUsd)
          : new Prisma.Decimal(balanceDeductState.collectedUsd);
        if (
          (options?.anchoredTenantId && options.anchoredTenantId !== balanceDeductState.tenantId) ||
          (options?.anchoredBillingAccountId &&
            options.anchoredBillingAccountId !== balanceDeductState.billingAccountId)
        ) {
          throw new Error('locked billing subject differs from settlement anchor');
        }
        await options?.validateAnchoredSubject?.(prisma);
        const beforeResult = await options?.beforeBalanceTransaction?.(prisma, {
          debtOpen,
          debtExposureUsd,
          collectedUsd,
          approvedCreditUsd,
          unapprovedDebtUsd,
          fundingPolicy: {
            policyAt: balanceDeductState.creditPolicyAt,
            policyRevision: null,
            source: balanceDeductState.creditPolicySource,
            reconstructible: balanceDeductState.creditPolicyReconstructible,
            termsDays: balanceDeductState.creditTermsDays,
            limitUsd: new Prisma.Decimal(balanceDeductState.creditLimitUsd),
            status: balanceDeductState.creditStatus,
            effectiveAt: balanceDeductState.creditEffectiveAt,
            expiresAt: balanceDeductState.creditExpiresAt,
          },
        });
        await options?.afterBalanceTransaction?.(prisma, {
          workspaceBalanceUsd: new Prisma.Decimal(balanceDeductState.workspaceBalanceUsd),
          accountBalanceUsd: new Prisma.Decimal(balanceDeductState.accountBalanceUsd),
          billingAccountType: balanceDeductState.billingAccountType,
          creditLimitUsd: new Prisma.Decimal(balanceDeductState.creditLimitUsd),
          creditStatus: balanceDeductState.creditStatus,
          creditTermsDays: balanceDeductState.creditTermsDays,
          creditEffectiveAt: balanceDeductState.creditEffectiveAt,
          creditExpiresAt: balanceDeductState.creditExpiresAt,
          creditPolicyAt: balanceDeductState.creditPolicyAt,
          creditPolicySource: balanceDeductState.creditPolicySource,
          creditPolicyReconstructible: balanceDeductState.creditPolicyReconstructible,
          allowanceUsd: null,
          allowanceUsedUsd: new Prisma.Decimal(0),
          allowanceRemainingUsd: null,
        }, {
          balanceTransactionId: 'balance-tx-1',
          billingAccountId: balanceDeductState.billingAccountId,
          tenantId: balanceDeductState.tenantId,
          tokenUsageId: beforeResult?.tokenUsageId ?? null,
          debtOpen,
          debtExposureUsd,
          collectedUsd,
          approvedCreditUsd,
          unapprovedDebtUsd,
          fundingPolicy: {
            policyAt: balanceDeductState.creditPolicyAt,
            policyRevision: null,
            source: balanceDeductState.creditPolicySource,
            reconstructible: balanceDeductState.creditPolicyReconstructible,
            termsDays: balanceDeductState.creditTermsDays,
            limitUsd: new Prisma.Decimal(balanceDeductState.creditLimitUsd),
            status: balanceDeductState.creditStatus,
            effectiveAt: balanceDeductState.creditEffectiveAt,
            expiresAt: balanceDeductState.creditExpiresAt,
          },
        });
        return {
          success: true,
          balance: Math.round(Number(balanceDeductState.workspaceBalanceUsd) * 100),
          balanceUsd: Number(balanceDeductState.workspaceBalanceUsd),
        };
      }),
    };
    const creditService = {
      ensureBalanceStateForGatewayAnchor: jest.fn().mockResolvedValue({
        subscriptionId: 'sub-1',
        userId: 'user-1',
        quota: 5000,
        bonus: 0,
        version: 1n,
      }),
      getBalances: jest.fn().mockResolvedValue({
        quota: 5000,
        bonus: 0,
        grant: 0,
        total: 5000,
      }),
      getAuthoritativeBalances: jest.fn().mockResolvedValue({
        quota: 5000,
        bonus: 0,
        grant: 0,
        total: 5000,
      }),
      windowUsage: jest.fn().mockResolvedValue(0),
      deduct: jest.fn().mockImplementation(async (
        _subscriptionId: string,
        _userId: string,
        _amount: number,
        _source: string,
        _modelName: string,
        _tokenDetail: unknown,
        options?: {
          beforeCreditTransaction?: (tx: typeof prisma) => Promise<void>;
          afterCreditTransaction?: (
            tx: typeof prisma,
            snapshot: {
              quotaAfter: number;
              bonusAfter: number;
              grantAfter: number;
              fromGrant: number;
            },
          ) => Promise<void>;
        },
      ) => {
        await options?.beforeCreditTransaction?.(prisma);
        await options?.afterCreditTransaction?.(prisma, {
          quotaAfter: 4900,
          bonusAfter: 0,
          grantAfter: 0,
          fromGrant: 0,
        });
        return { success: true, quota: 4900, bonus: 0, grant: 0 };
      }),
    };
    const creditCostImpl = async (
      _planId: string,
      _modelName: string,
      _inputTokens: number,
      _outputTokens: number,
      _usageMultiplier: number,
      _cachedInputTokens = 0,
      options: { imageCount?: number } = {},
    ) => options.imageCount ? options.imageCount * 6 : 100;
    const creditPricing = {
      calculateCreditCost: jest.fn().mockImplementation(creditCostImpl),
      calculateCreditCostQuote: jest.fn().mockImplementation(async (...args: Parameters<typeof creditCostImpl>) => ({
        creditCost: await creditCostImpl(...args),
        pricingTierKey: null,
      })),
    };
    const subscriptionResolver = {
      resolve: jest.fn().mockResolvedValue({
        subscriptionId: 'sub-1',
        planId: 'plan-1',
        plan: { usageMultiplier: 1 },
      }),
      resolveAtReceipt: jest.fn(),
    };
    const creditPolicy = {
      resolvePolicyForUser: jest.fn().mockResolvedValue({
        allowOverdraft: false,
        creditLimitCents: 0,
      }),
    };
    const publisherSync = {
      syncKeyBalanceById: jest.fn().mockResolvedValue(undefined),
      syncBillingAccountKeyBalancesRequired: jest.fn().mockResolvedValue(undefined),
      syncBillingAccountKeyBalancesByTenantIdRequired: jest.fn().mockResolvedValue(undefined),
      syncBillingAccountKeyBalancesByKeyIdRequired: jest.fn().mockResolvedValue(undefined),
    };
    const config = {
      get: jest.fn((key: string) => __config?.[key]),
    };

    const systemConfig = {
      getDeploymentConfig: jest.fn().mockResolvedValue(__deploymentConfig),
    };
    const service = new UsageBillingStrategyService(
      prisma as never,
      redis as never,
      billingService as never,
      creditService as never,
      creditPricing as never,
      modelPricing as never,
      providerCostPricing as never,
      subscriptionResolver as never,
      creditPolicy as never,
      publisherSync as never,
      config as never,
      systemConfig as never,
    );
    return {
      service,
      prisma,
      modelPricing,
      providerCostPricing,
      redis,
      billingService,
      balanceDeductState,
      creditService,
      creditPricing,
      subscriptionResolver,
      publisherSync,
      config,
      systemConfig,
    };
  }

  function prepareGatewaySettlement(
    built: ReturnType<typeof buildService>,
    input: UsageDeductInput,
    overrides: Partial<GatewaySettlementAnchor> & {
      billingAccountType?: string;
      productBillingMode?: string;
    } = {},
  ): GatewaySettlementContext {
    const requestId = input.requestId?.trim();
    const apiKeyId = input.apiKeyId?.trim();
    const occurredAt = input.eventOccurredAt instanceof Date
      ? input.eventOccurredAt
      : new Date(String(input.eventOccurredAt));
    if (!requestId || !apiKeyId || Number.isNaN(occurredAt.getTime())) {
      throw new Error('test settlement helper requires requestId/apiKeyId/eventOccurredAt');
    }
    const billingUnit = overrides.billingUnit
      ?? (input.billingUnit === 'CREDITS' ? 'CREDITS' : 'BALANCE');
    const codingPlanEntitlementId = overrides.codingPlanEntitlementId ?? null;
    const subscriptionId = billingUnit === 'CREDITS'
      ? overrides.subscriptionId ?? codingPlanEntitlementId ?? 'sub-1'
      : null;
    const planId = billingUnit === 'CREDITS' ? overrides.planId ?? 'plan-1' : null;
    const entitlementKind = billingUnit === 'CREDITS'
      ? overrides.entitlementSnapshot?.entitlementKind
        ?? (codingPlanEntitlementId
          ? 'coding_plan_entitlement' as const
          : 'subscription_period' as const)
      : undefined;
    const fulfillmentMode = billingUnit === 'CREDITS'
      ? overrides.entitlementSnapshot?.fulfillmentMode
        ?? (codingPlanEntitlementId ? 'platform_model_package' : null)
      : undefined;
    const productId = overrides.productId ?? input.productId ?? 'prod-payg';
    const productSlug = overrides.productSlug ?? input.productSlug
      ?? (productId === 'prod-coding' ? 'tokenplan' : 'payg');
    const anchorUserId = overrides.userId ?? input.userId ?? 'user-1';
    const anchorTenantId = overrides.tenantId ?? input.tenantId ?? 'tenant-1';
    const anchorBillingAccountId = overrides.billingAccountId ?? 'ba-personal-1';
    const inputTokens = Number(input.inputTokens ?? 0);
    const outputTokens = Number(input.outputTokens ?? 0);
    const cachedInputTokens = Number(input.cachedInputTokens ?? 0);
    const cacheWriteInputTokens = Number(input.cacheWriteInputTokens ?? 0);
    const imageCount = Number(input.imageCount ?? 0);
    const policy = overrides.billingAccountType === 'enterprise'
      ? {
          id: null,
          scope: 'DEFAULT' as const,
          modelName: null,
          priceMultiplier: '1',
          creditMultiplier: null,
          priority: 0,
        }
      : {
          id: 'user',
          scope: 'USER' as const,
          modelName: null,
          priceMultiplier: '0.7',
          creditMultiplier: null,
          priority: 0,
        };
    const includedUpstream = billingUnit === 'CREDITS'
      && fulfillmentMode === 'provider_resale';
    const effectiveCostUsd = overrides.billingAccountType === 'enterprise' ? '1.25' : '0.875';
    const customerQuoteSnapshot = billingUnit === 'BALANCE'
      ? {
          unit: 'BALANCE' as const,
          userId: anchorUserId,
          tenantId: anchorTenantId,
          billingAccountId: anchorBillingAccountId,
          productId,
          productSlug,
          modelName: input.modelName,
          inputTokens,
          outputTokens,
          cachedInputTokens,
          cacheWriteInputTokens,
          imageCount,
          pricingTierKey: null,
          priceBasis: overrides.billingAccountType === 'enterprise'
            ? 'LIST' as const
            : 'PRODUCT_EFFECTIVE' as const,
          customerPricing: {
            inputPriceUsdPerM: overrides.billingAccountType === 'enterprise' ? '500' : '350',
            cachedInputPriceUsdPerM: null,
            cacheWritePriceUsdPerM: null,
            outputPriceUsdPerM: overrides.billingAccountType === 'enterprise' ? '1500' : '1050',
          },
          baseCostUsd: '1.25',
          effectiveCostUsd,
          amountCents: Math.round(Number(effectiveCostUsd) * 100),
          providerCode: input.providerCode ?? null,
          providerLineId: input.providerLineId ?? null,
          policy,
        }
      : {
          unit: 'CREDITS' as const,
          userId: anchorUserId,
          tenantId: anchorTenantId,
          billingAccountId: anchorBillingAccountId,
          productId,
          productSlug,
          modelName: input.modelName,
          inputTokens,
          outputTokens,
          cachedInputTokens,
          cacheWriteInputTokens,
          imageCount,
          pricingTierKey: null,
          subscriptionId: subscriptionId!,
          entitlementKind,
          codingPlanEntitlementId,
          planId: planId!,
          fulfillmentMode,
          providerEntitlementId: overrides.entitlementSnapshot?.providerEntitlementId,
          providerLineId: overrides.entitlementSnapshot?.providerLineId,
          providerLineCode: overrides.entitlementSnapshot?.providerLineCode,
          providerCode: overrides.entitlementSnapshot?.providerCode,
          upstreamProductId: overrides.entitlementSnapshot?.upstreamProductId,
          baseCreditCost: includedUpstream ? 0 : 100,
          creditCost: includedUpstream ? 0 : 70,
          includedUpstream: includedUpstream || undefined,
          policy,
        };
    const verifiedModelPricing = {
      status: 'VERIFIED' as const,
      reason: null,
      costUsd: billingUnit === 'BALANCE' ? effectiveCostUsd : '1.25',
      pricingTierKey: null,
      inputPriceUsdPerM: billingUnit === 'BALANCE' ? '350' : '500',
      cachedInputPriceUsdPerM: null,
      cacheWritePriceUsdPerM: null,
      outputPriceUsdPerM: billingUnit === 'BALANCE' ? '1050' : '1500',
    };
    const customerPricingSnapshot: GatewayCustomerPricingSnapshot = {
      unit: billingUnit,
      priceBasis: billingUnit === 'BALANCE'
        ? overrides.billingAccountType === 'enterprise' ? 'LIST' : 'PRODUCT_EFFECTIVE'
        : includedUpstream ? 'INCLUDED_UPSTREAM' as const : 'SUBSCRIPTION_CREDITS' as const,
      basePricing: includedUpstream
        ? { status: 'NOT_APPLICABLE' as const, reason: 'included_upstream' }
        : verifiedModelPricing,
      tokenUsagePricing: verifiedModelPricing,
      policy,
      customerMultiplier: policy.priceMultiplier,
      planUsageMultiplier: billingUnit === 'CREDITS' ? 1 : null,
      modelAccessMultiplier: billingUnit === 'CREDITS' && !includedUpstream ? '1' : null,
      effectiveCostUsd: billingUnit === 'BALANCE' ? effectiveCostUsd : null,
      baseCreditCost: billingUnit === 'CREDITS' ? (includedUpstream ? 0 : 100) : null,
      creditCost: billingUnit === 'CREDITS' ? (includedUpstream ? 0 : 70) : null,
      includedUpstream,
    };
    const providerCostSnapshot = overrides.providerCostSnapshot ?? {
      status: 'UNAVAILABLE' as const,
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
    const anchor: GatewaySettlementAnchor = {
      requestId,
      apiKeyId,
      userId: anchorUserId,
      tenantId: anchorTenantId,
      billingAccountId: anchorBillingAccountId,
      billingCurrency: overrides.billingCurrency ?? 'USD',
      productId,
      productSlug,
      billingUnit,
      codingPlanEntitlementId,
      subscriptionId,
      planId,
      occurredAt,
      firstReceivedAt: overrides.firstReceivedAt
        ?? new Date(occurredAt.getTime() + 1_000),
      customerSettlementPolicyVersion: overrides.customerSettlementPolicyVersion
        ?? 'gateway-customer-settlement-v2',
      pricingHash,
      customerQuoteSnapshot,
      customerPricingSnapshot,
      providerCostSnapshot,
      anchorHash: overrides.anchorHash ?? `anchor-${requestId}`,
      entitlementSnapshot: billingUnit === 'CREDITS'
        ? overrides.entitlementSnapshot ?? {
            entitlementKind,
            billingPeriod: 'MONTHLY',
            fulfillmentMode,
            providerEntitlementId: null,
            providerLineId: null,
            providerLineCode: null,
            providerCode: null,
            upstreamProductId: null,
          }
        : null,
      planSnapshot: billingUnit === 'CREDITS'
        ? overrides.planSnapshot ?? {
            id: planId!,
            name: 'Frozen plan',
            monthlyCredits: 5000,
            usageMultiplier: 1,
            rateLimitRpm: 0,
            rateLimitTpm: 0,
            maxContextWindow: 0,
          }
        : null,
    };
    const gatewayBillingEventId = `event-${requestId}`;
    const evidenceHash = `evidence-${requestId}`;

    built.prisma.apiKey.findUnique.mockResolvedValue({
      userId: anchor.userId,
      tenantId: anchor.tenantId,
      productId: anchor.productId,
      codingPlanEntitlementId: anchor.codingPlanEntitlementId,
    });
    built.prisma.tenant.findUnique.mockResolvedValue({
      billingAccountId: anchor.billingAccountId,
      billingAccount: { type: overrides.billingAccountType ?? 'personal', currency: 'USD' },
    });
    built.prisma.product.findUnique.mockResolvedValue({
      id: anchor.productId,
      slug: anchor.productSlug,
      billingMode: overrides.productBillingMode
        ?? (anchor.billingUnit === 'CREDITS' ? 'CODING_PLAN' : 'PAY_AS_YOU_GO'),
    });
    built.prisma.billingAccount.findUnique.mockResolvedValue({
      id: anchor.billingAccountId,
      type: overrides.billingAccountType ?? 'personal',
      currency: 'USD',
    });
    built.prisma.gatewayBillingEvent.findUnique.mockResolvedValue({
      id: gatewayBillingEventId,
      requestId,
      revision: 0,
      evidenceHash,
    });
    built.prisma.gatewayUsageSettlementAnchor.findUnique.mockResolvedValue({
      requestId,
      anchorHash: anchor.anchorHash,
      pricingHash: anchor.pricingHash,
      billingCurrency: anchor.billingCurrency,
    });
    built.prisma.gatewayUsageSettlementReceipt.findUnique.mockResolvedValue(null);
    built.prisma.gatewayUsageEvidence.findFirst.mockResolvedValue({
      requestId,
      evidenceHash,
      rawEvidence: {},
    });
    if (anchor.codingPlanEntitlementId) {
      built.prisma.codingPlanEntitlement.findUnique.mockResolvedValue({
        id: anchor.subscriptionId,
        userId: anchor.userId,
        tenantId: anchor.tenantId,
        productId: anchor.productId,
        planId: anchor.planId,
        status: 'ACTIVE',
      });
    } else if (anchor.subscriptionId) {
      built.prisma.subscriptionPeriod.findUnique.mockResolvedValue({
        id: anchor.subscriptionId,
        userId: anchor.userId,
        tenantId: anchor.tenantId,
        billingAccountId: anchor.billingAccountId,
        productId: anchor.productId,
        planId: anchor.planId,
      });
    }
    return {
      gatewayBillingEventId,
      expectedRevision: 0,
      evidenceHash,
      anchor,
    };
  }

  function gatewaySettlementFingerprint(
    service: UsageBillingStrategyService,
    input: UsageDeductInput,
    context: GatewaySettlementContext,
  ): string {
    return (service as unknown as {
      gatewaySettlementFingerprint(
        settlementInput: UsageDeductInput,
        settlementContext: GatewaySettlementContext,
      ): string;
    }).gatewaySettlementFingerprint(input, context);
  }

  it('rejects a first receipt after the Coding Plan entitlement enters REFUNDING', async () => {
    const built = buildService();
    const input: UsageDeductInput = {
      apiKeyId: 'key-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-coding',
      productSlug: 'tokenplan',
      modelName: 'gpt-test',
      inputTokens: 1,
      outputTokens: 1,
      billingUnit: 'CREDITS',
      source: 'gateway:test',
      requestId: 'req-refunding-entitlement',
      idempotencyKey: 'gateway:request:req-refunding-entitlement',
      eventOccurredAt: new Date('2026-07-01T00:00:00.000Z'),
    };
    const context = prepareGatewaySettlement(built, input, {
      codingPlanEntitlementId: 'ent-refunding',
      subscriptionId: 'ent-refunding',
      planId: 'plan-coding',
    });
    built.prisma.codingPlanEntitlement.findUnique.mockResolvedValue({
      id: context.anchor.subscriptionId,
      userId: context.anchor.userId,
      tenantId: context.anchor.tenantId,
      productId: context.anchor.productId,
      planId: context.anchor.planId,
      status: 'REFUNDING',
    });

    await expect(
      built.service.assertGatewaySettlementAnchorForReceipt(
        built.prisma as never,
        context.anchor,
      ),
    ).rejects.toBeInstanceOf(GatewaySettlementAnchorConflictError);
    expect((built.prisma as typeof built.prisma & { $queryRaw: jest.Mock }).$queryRaw)
      .toHaveBeenCalled();
  });

  it('rejects first-receipt settlement with a typed retryable currency migration error', async () => {
    const { service, prisma } = buildService({
      __config: { BILLING_PLATFORM_CURRENCY: 'cny' },
    });
    const input: UsageDeductInput = {
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      inputTokens: 1,
      outputTokens: 1,
      billingUnit: 'BALANCE',
      source: 'gateway:test',
      requestId: 'req-currency-migration',
      idempotencyKey: 'gateway:request:req-currency-migration',
      eventOccurredAt: new Date('2026-07-01T00:00:00.000Z'),
    };

    let caught: unknown;
    try {
      await service.resolveGatewaySettlementAnchor(
        prisma as never,
        input,
        new Date('2026-07-01T00:00:01.000Z'),
      );
    } catch (error) {
      caught = error;
    }

    expect(caught).toBeInstanceOf(GatewayBillingCurrencyMigrationRequiredError);
    expect(caught).toMatchObject({
      name: 'GatewayBillingCurrencyMigrationRequiredError',
      code: 'billing_account_currency_migration_required',
      retryable: true,
      accountCurrency: 'USD',
      deploymentCurrency: 'CNY',
      billingAccountId: 'ba-personal-1',
      apiKeyId: 'key-1',
    });
  });

  it('preflights only locally reachable Gateway keys and includes provider-resale keys', async () => {
    const { service, prisma } = buildService({
      __config: { BILLING_PLATFORM_CURRENCY: 'cny' },
    });
    let query = '';
    (prisma as typeof prisma & { $queryRaw: jest.Mock }).$queryRaw.mockImplementationOnce(async (
      parts: TemplateStringsArray,
      ...values: unknown[]
    ) => {
      query = parts.join(' ');
      expect(values).toEqual(['CNY']);
      return [{
        billingAccountId: 'ba-provider-resale',
        accountCurrency: 'USD',
        apiKeyId: 'key-provider-resale',
      }];
    });

    await expect(
      service.assertReachableGatewayBillingAccountCurrencies(),
    ).rejects.toMatchObject({
      code: 'billing_account_currency_migration_required',
      billingAccountId: 'ba-provider-resale',
      apiKeyId: 'key-provider-resale',
    });
    expect(query).toContain('FROM "api_keys"');
    expect(query).toContain('ak."is_active" IS TRUE');
    expect(query).toContain('ak."mirror_status" = \'ACTIVE\'');
    expect(query).toContain('ak."expires_at" > clock_timestamp()');
    expect(query).toContain('t."status" = \'active\'');
    expect(query).toContain('ba."status" = \'active\'');
    expect(query).toContain('p."is_active" IS TRUE');
    expect(query).not.toContain('provider_resale');
    expect(query).not.toContain('coding_plan_fulfillment_mode');
    expect(query).not.toContain('LEFT JOIN "products"');
  });

  it('passes the reachable-account preflight when every live key is currency compatible', async () => {
    const { service, prisma } = buildService({
      __config: { BILLING_PLATFORM_CURRENCY: 'cny' },
    });
    (prisma as typeof prisma & { $queryRaw: jest.Mock }).$queryRaw.mockResolvedValueOnce([]);

    await expect(service.assertReachableGatewayBillingAccountCurrencies())
      .resolves.toBeUndefined();
  });

  it('settles an existing frozen anchor without re-reading deployment currency', async () => {
    const built = buildService({
      __config: { BILLING_PLATFORM_CURRENCY: 'cny' },
      __deploymentConfig: {
        version: '2',
        region: 'domestic',
        provider: 'wechat',
        currency: 'cny',
        defaultLanguage: 'zh',
        oauth: {},
      },
    });
    const { service, billingService, prisma, systemConfig } = built;
    const input: UsageDeductInput = {
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
      source: 'gateway:test',
      requestId: 'req-frozen-anchor-currency',
      idempotencyKey: 'gateway:request:req-frozen-anchor-currency',
      eventOccurredAt: new Date('2026-07-01T00:00:00.000Z'),
      recordTokenUsage: true,
    };
    const context = prepareGatewaySettlement(built, input, {
      billingCurrency: 'USD',
    });
    prisma.billingAccount.findUnique.mockResolvedValue({
      id: context.anchor.billingAccountId,
      type: 'personal',
      currency: 'USD',
    });

    await expect(service.settleDeliveredGatewayUsage(input, context))
      .resolves.toMatchObject({ success: true });
    expect(billingService.deduct).toHaveBeenCalledTimes(1);
    expect(systemConfig.getDeploymentConfig).not.toHaveBeenCalled();
  });

  // The probes added 2026-08-31 exist to attribute settleUsage's 1411ms. A probe
  // that is wired to a method nobody calls records nothing and reads exactly
  // like "this step is free", so assert the stages actually fire — and that the
  // instrumentation stays inert when no collector is active, since the same code
  // runs on every HTTP request path.
  it('records settlement sub-stage timings, and stays inert without a collector', async () => {
    function settlementFixture() {
      const built = buildService();
      const input: UsageDeductInput = {
        apiKeyId: 'key-1',
        modelName: 'gpt-test',
        inputTokens: 1000,
        outputTokens: 500,
        billingUnit: 'BALANCE',
        source: 'gateway:test',
        requestId: 'req-substage-timing',
        idempotencyKey: 'gateway:request:req-substage-timing',
        eventOccurredAt: new Date('2026-07-01T00:00:00.000Z'),
        recordTokenUsage: true,
      };
      const context = prepareGatewaySettlement(built, input);
      return { built, input, context };
    }

    const stages = createStageTimings();
    {
      const { built, input, context } = settlementFixture();
      await runWithStageTimings(stages, () =>
        built.service.settleDeliveredGatewayUsage(input, context));
    }

    // Every stage on the mandatory path of a first-receipt BALANCE settlement.
    for (const stage of [
      'stlReplayCheck',
      'stlIdemRead',
      'stlIdemLock',
      'stlAuthorize',
      'stlIdemBegin',
      'stlDeduct',
      'stlPubSync',
    ]) {
      expect(stages[stage]?.count ?? 0).toBeGreaterThan(0);
    }

    // Self time is the additive quantity the log line reports; a stage that
    // records a count but no self time would read as free.
    expect(stages.stlDeduct.selfMs).toBeGreaterThanOrEqual(0);

    // No collector => no bookkeeping at all, and identical behaviour.
    {
      const { built, input, context } = settlementFixture();
      const untimed = createStageTimings();
      await expect(built.service.settleDeliveredGatewayUsage(input, context))
        .resolves.toMatchObject({ success: true });
      expect(Object.keys(untimed)).toHaveLength(0);
    }
  });

  it('includes the immutable Billing DB first-receipt time in the settlement anchor hash', async () => {
    const { service, prisma } = buildService();
    const input: UsageDeductInput = {
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      inputTokens: 1,
      outputTokens: 1,
      billingUnit: 'BALANCE',
      source: 'gateway:test',
      requestId: 'req-anchor-db-clock',
      idempotencyKey: 'gateway:request:req-anchor-db-clock',
      eventOccurredAt: new Date('2026-07-01T00:00:00.000Z'),
    };
    const firstReceivedAt = new Date('2026-07-01T00:00:01.000Z');

    const first = await service.resolveGatewaySettlementAnchor(
      prisma as never,
      input,
      firstReceivedAt,
    );
    const later = await service.resolveGatewaySettlementAnchor(
      prisma as never,
      input,
      new Date('2026-07-01T00:00:02.000Z'),
    );

    expect(first.firstReceivedAt).toEqual(firstReceivedAt);
    expect(first.customerSettlementPolicyVersion).toBe(
      'gateway-customer-settlement-v2',
    );
    expect(first.anchorHash).not.toBe(later.anchorHash);
  });

  it.each(['BALANCE', 'CREDITS'] as const)(
    'freezes configured cache prices for a %s first receipt with zero cache quantities',
    async (billingUnit) => {
      const built = buildService();
      const {
        service,
        prisma,
        modelPricing,
        subscriptionResolver,
      } = built;
      modelPricing.calculateCostQuote.mockResolvedValue({
        costUsd: new Prisma.Decimal('0.00008'),
        pricingTierKey: null,
        inputPriceUsdPerM: new Prisma.Decimal('0.5'),
        cachedInputPriceUsdPerM: new Prisma.Decimal('0.125'),
        cacheWritePriceUsdPerM: new Prisma.Decimal('1.5'),
        outputPriceUsdPerM: new Prisma.Decimal('1.5'),
      });
      if (billingUnit === 'CREDITS') {
        subscriptionResolver.resolveAtReceipt.mockResolvedValue({
          subscriptionId: 'sub-cache-price-freeze',
          entitlementKind: 'subscription_period',
          codingPlanEntitlementId: null,
          planId: 'plan-cache-price-freeze',
          productId: 'prod-payg',
          billingPeriod: 'MONTHLY',
          fulfillmentMode: null,
          providerEntitlementId: null,
          providerLineId: null,
          providerLineCode: null,
          providerCode: null,
          upstreamProductId: null,
          plan: {
            id: 'plan-cache-price-freeze',
            name: 'Cache price freeze',
            monthlyCredits: 5000,
            usageMultiplier: 1,
            rateLimitRpm: 0,
            rateLimitTpm: 0,
            maxContextWindow: 0,
          },
        });
        prisma.subscriptionPeriod.findUnique.mockResolvedValue({
          id: 'sub-cache-price-freeze',
          userId: 'user-1',
          tenantId: 'tenant-1',
          billingAccountId: 'ba-personal-1',
          productId: 'prod-payg',
          planId: 'plan-cache-price-freeze',
        });
      }
      const input: UsageDeductInput = {
        apiKeyId: 'key-1',
        modelName: 'gpt-test',
        inputTokens: 100,
        outputTokens: 20,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        billingUnit,
        source: 'gateway:test',
        requestId: `req-zero-cache-price-${billingUnit.toLowerCase()}`,
        idempotencyKey: `gateway:request:req-zero-cache-price-${billingUnit.toLowerCase()}`,
        eventOccurredAt: new Date('2026-07-01T00:00:00.000Z'),
      };

      const anchor = await service.resolveGatewaySettlementAnchor(
        prisma as never,
        input,
        new Date('2026-07-01T00:00:01.000Z'),
      );

      expect(anchor.customerQuoteSnapshot).toEqual(expect.objectContaining({
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
      }));
      expect(anchor.customerPricingSnapshot.basePricing).toEqual(expect.objectContaining({
        cachedInputPriceUsdPerM: '0.125',
        cacheWritePriceUsdPerM: '1.5',
      }));
      expect(anchor.customerPricingSnapshot.tokenUsagePricing).toEqual(expect.objectContaining({
        cachedInputPriceUsdPerM: billingUnit === 'BALANCE' ? '0.0875' : '0.125',
        cacheWritePriceUsdPerM: billingUnit === 'BALANCE' ? '1.05' : '1.5',
      }));
    },
  );

  it('binds protective original/settled meters in the receipt and preserves provider cost risk', async () => {
    const built = buildService();
    const { service, prisma } = built;
    const originalDimensions = {
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      totalTokens: 1500,
      imageCount: 0,
    };
    const settledDimensions = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      totalTokens: 0,
      imageCount: 0,
    };
    const anchorInput: UsageDeductInput = {
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      ...originalDimensions,
      billingUnit: 'BALANCE',
      source: 'gateway:openai:gpt-test',
      requestId: 'req-customer-protective-zero',
      idempotencyKey: 'gateway:request:req-customer-protective-zero',
      eventOccurredAt: new Date('2026-07-01T00:00:00.000Z'),
      providerCode: 'openai',
      recordTokenUsage: true,
    };
    const input: UsageDeductInput = {
      ...anchorInput,
      ...settledDimensions,
      source: 'gateway:openai:gpt-test:customer-protective-zero',
      gatewayCustomerSettlement: {
        policyVersion: 'gateway-customer-settlement-v2',
        basis: 'CUSTOMER_PROTECTIVE_ZERO',
        evidenceReason: 'usage_evidence_invalid',
        originalDimensions,
        settledDimensions,
      },
    };
    const context = prepareGatewaySettlement(built, anchorInput, {
      providerCostSnapshot: {
        status: 'VERIFIED',
        reason: null,
        policyId: 'provider-cost-frozen',
        providerCode: 'openai',
        providerLineId: null,
        productId: 'prod-payg',
        priceMultiplier: '1',
        inputCostUsdPerM: '0.25',
        cachedInputCostUsdPerM: '0.05',
        cacheWriteCostUsdPerM: '0.1',
        outputCostUsdPerM: '0.75',
        costUsd: '0',
      },
    });

    await service.settleDeliveredGatewayUsage(input, context);

    const usage = prisma.tokenUsage.create.mock.calls[0][0].data;
    expect(usage.customerChargeUsd.toString()).toBe('0');
    expect(usage.providerCostEstimateUsd.toString()).toBe('0.000625');
    expect(prisma.gatewayUsageSettlementReceipt.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        settlementFingerprint: gatewaySettlementFingerprint(service, input, context),
        payload: expect.objectContaining({
          gatewayCustomerSettlement: input.gatewayCustomerSettlement,
        }),
      }),
    });
    expect(gatewaySettlementFingerprint(service, input, context)).not.toBe(
      gatewaySettlementFingerprint(service, {
        ...input,
        gatewayCustomerSettlement: {
          ...input.gatewayCustomerSettlement!,
          originalDimensions: { ...originalDimensions, inputTokens: 999 },
        },
      }, context),
    );
    expect(gatewaySettlementFingerprint(service, input, context)).toBe(
      gatewaySettlementFingerprint(service, {
        ...input,
        gatewayCustomerSettlement: {
          ...input.gatewayCustomerSettlement!,
          evidenceReason: 'producer_build_now_verified',
          customerProtectionReason: 'reclassified_internal_evidence',
        },
      }, context),
    );
    const unverifiedBuildExact: UsageDeductInput = {
      ...anchorInput,
      gatewayCustomerSettlement: {
        policyVersion: 'gateway-customer-settlement-v2',
        basis: 'NORMALIZED_EXACT',
        evidenceReason: 'producer_build_unverified',
        originalDimensions,
        settledDimensions: originalDimensions,
      },
    };
    expect(gatewaySettlementFingerprint(service, unverifiedBuildExact, context)).toBe(
      gatewaySettlementFingerprint(service, {
        ...unverifiedBuildExact,
        gatewayCustomerSettlement: {
          ...unverifiedBuildExact.gatewayCustomerSettlement!,
          evidenceReason: 'none',
        },
      }, context),
    );
  });

  it('accepts normalized settlement under a v2 first-receipt anchor', async () => {
    const built = buildService();
    const { service, billingService } = built;
    const dimensions = {
      inputTokens: 100,
      outputTokens: 20,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      totalTokens: 120,
      imageCount: 0,
    };
    const input: UsageDeductInput = {
      apiKeyId: 'key-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-payg',
      productSlug: 'payg',
      modelName: 'gpt-test',
      ...dimensions,
      billingUnit: 'BALANCE',
      source: 'gateway:openai:gpt-test',
      requestId: 'req-cache-omission-v2',
      idempotencyKey: 'gateway:request:req-cache-omission-v2',
      eventOccurredAt: new Date('2026-07-01T00:00:00.000Z'),
      recordTokenUsage: true,
      gatewayCustomerSettlement: {
        policyVersion: 'gateway-customer-settlement-v2',
        basis: 'NORMALIZED_EXACT',
        evidenceReason: 'usage_evidence_partial',
        originalDimensions: dimensions,
        settledDimensions: dimensions,
      },
    };
    const context = prepareGatewaySettlement(built, input, {
      customerSettlementPolicyVersion: 'gateway-customer-settlement-v2',
    });

    await expect(service.settleDeliveredGatewayUsage(input, context))
      .resolves.toMatchObject({ success: true });

    expect(billingService.deduct).toHaveBeenCalledTimes(1);
  });

  it.each(['BALANCE', 'CREDITS'] as const)(
    'rejects changed %s token dimensions when frozen pricing contains non-token line items',
    async (billingUnit) => {
      const built = buildService();
      const { service, billingService, creditService } = built;
      const anchorInput: UsageDeductInput = {
        apiKeyId: 'key-1',
        userId: 'user-1',
        tenantId: 'tenant-1',
        productId: 'prod-payg',
        productSlug: 'payg',
        modelName: 'gpt-test',
        inputTokens: 100,
        outputTokens: 50,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        totalTokens: 150,
        billingUnit,
        source: 'gateway:test:line-item-anchor',
        requestId: `req-line-item-protective-${billingUnit.toLowerCase()}`,
        idempotencyKey: `gateway:request:req-line-item-protective-${billingUnit.toLowerCase()}`,
        eventOccurredAt: new Date('2026-07-01T00:00:00.000Z'),
        recordTokenUsage: true,
      };
      const context = prepareGatewaySettlement(built, anchorInput);
      const lineItems = [{
        meter: 'image' as const,
        quantity: 1,
        unitPriceUsd: '0.06',
        amountUsd: '0.06',
      }];
      const customerPricingSnapshot: GatewayCustomerPricingSnapshot = {
        ...context.anchor.customerPricingSnapshot,
        basePricing: {
          ...context.anchor.customerPricingSnapshot.basePricing,
          lineItems,
        },
        tokenUsagePricing: {
          ...context.anchor.customerPricingSnapshot.tokenUsagePricing,
          lineItems,
        },
      } as GatewayCustomerPricingSnapshot;
      const anchor: GatewaySettlementAnchor = {
        ...context.anchor,
        customerPricingSnapshot,
        pricingHash: createHash('sha256').update(testCanonicalJson({
          customerQuoteSnapshot: context.anchor.customerQuoteSnapshot,
          customerPricingSnapshot,
          providerCostSnapshot: context.anchor.providerCostSnapshot,
        })).digest('hex'),
      };
      const protectiveInput: UsageDeductInput = {
        ...anchorInput,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        totalTokens: 0,
        source: 'gateway:test:line-item-anchor:customer-protective-zero',
      };

      await expect(service.valueGatewayUsageAtFrozenPricing(protectiveInput, anchor))
        .rejects.toBeInstanceOf(GatewaySettlementAnchorConflictError);
      expect(billingService.deduct).not.toHaveBeenCalled();
      expect(creditService.deduct).not.toHaveBeenCalled();
    },
  );

  it('reprices a frozen BALANCE image line item to protective zero and replays its permanent receipt', async () => {
    const built = buildService();
    const { service, prisma, billingService } = built;
    const originalDimensions = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      totalTokens: 0,
      imageCount: 1,
    };
    const anchorInput: UsageDeductInput = {
      apiKeyId: 'key-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-payg',
      productSlug: 'payg',
      modelName: 'image-test',
      ...originalDimensions,
      billingUnit: 'BALANCE',
      source: 'gateway:image:image-test',
      requestId: 'req-image-protective-zero',
      idempotencyKey: 'gateway:request:req-image-protective-zero',
      eventOccurredAt: new Date('2026-07-01T00:00:00.000Z'),
      recordTokenUsage: true,
    };
    const initialContext = prepareGatewaySettlement(built, anchorInput);
    const lineItems = [{
      meter: 'image' as const,
      quantity: 1,
      unitPriceUsd: '0.06',
      amountUsd: '0.06',
    }];
    const customerQuoteSnapshot = {
      ...initialContext.anchor.customerQuoteSnapshot,
      baseCostUsd: '0.06',
      effectiveCostUsd: '0.06',
      amountCents: 6,
      lineItems,
    };
    const imagePricing = {
      status: 'VERIFIED' as const,
      reason: null,
      costUsd: '0.06',
      pricingTierKey: null,
      inputPriceUsdPerM: '0',
      cachedInputPriceUsdPerM: null,
      cacheWritePriceUsdPerM: null,
      outputPriceUsdPerM: '0',
      lineItems,
    };
    const customerPricingSnapshot: GatewayCustomerPricingSnapshot = {
      ...initialContext.anchor.customerPricingSnapshot,
      basePricing: imagePricing,
      tokenUsagePricing: imagePricing,
      effectiveCostUsd: '0.06',
    };
    const pricingHash = createHash('sha256').update(testCanonicalJson({
      customerQuoteSnapshot,
      customerPricingSnapshot,
      providerCostSnapshot: initialContext.anchor.providerCostSnapshot,
    })).digest('hex');
    const context: GatewaySettlementContext = {
      ...initialContext,
      anchor: {
        ...initialContext.anchor,
        pricingHash,
        customerQuoteSnapshot,
        customerPricingSnapshot,
      },
    };
    prisma.gatewayUsageSettlementAnchor.findUnique.mockResolvedValue({
      requestId: context.anchor.requestId,
      anchorHash: context.anchor.anchorHash,
      pricingHash,
      billingCurrency: context.anchor.billingCurrency,
    });
    const settledDimensions = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      totalTokens: 0,
      imageCount: 0,
    };
    const input: UsageDeductInput = {
      ...anchorInput,
      ...settledDimensions,
      source: `${anchorInput.source}:customer-protective-zero`,
      gatewayCustomerSettlement: {
        policyVersion: 'gateway-customer-settlement-v2',
        basis: 'CUSTOMER_PROTECTIVE_ZERO',
        evidenceReason: 'token_source_missing',
        originalDimensions,
        settledDimensions,
      },
    };

    const first = await service.settleDeliveredGatewayUsage(input, context);

    expect(first).toMatchObject({
      success: true,
      allowed: true,
      unit: 'BALANCE',
      quote: expect.objectContaining({
        imageCount: 0,
        effectiveCostUsd: '0',
        amountCents: 0,
        lineItems: [{
          meter: 'image',
          quantity: 0,
          unitPriceUsd: '0.06',
          amountUsd: '0',
        }],
      }),
    });
    expect(billingService.deduct.mock.calls[0]?.[1]).toBe('0');
    const receipt = prisma.gatewayUsageSettlementReceipt.create.mock.calls[0][0].data;
    expect(receipt).toEqual(expect.objectContaining({
      amountUsd: new Prisma.Decimal(0),
      settlementFingerprint: gatewaySettlementFingerprint(service, input, context),
      payload: expect.objectContaining({
        gatewayCustomerSettlement: expect.objectContaining({
          originalDimensions,
          settledDimensions,
        }),
        customerFinancialAuthority: expect.objectContaining({
          protocol: 'gateway-customer-financial-authority-v1',
          basis: 'CUSTOMER_PROTECTIVE_ZERO',
          terminalClass: 'BALANCE_SETTLED',
          customerAmountUnit: 'USD',
          originalCustomerAmount: '0.060000000000',
          settledCustomerAmount: '0.000000000000',
          originalCustomerChargeUsd: '0.060000000000',
          settledCustomerChargeUsd: '0.000000000000',
          originalDimensions,
          settledDimensions,
          tokenUsageId: 'usage-1',
        }),
        billingResult: expect.objectContaining({
          quote: expect.objectContaining({
            lineItems: [{
              meter: 'image',
              quantity: 0,
              unitPriceUsd: '0.06',
              amountUsd: '0',
            }],
          }),
        }),
      }),
    }));
    const usage = prisma.tokenUsage.create.mock.calls[0][0].data;
    expect(usage).toEqual(expect.objectContaining({
      meter: 'token',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      customerChargeUsd: new Prisma.Decimal(0),
    }));
    expect(usage.quantity).toBeUndefined();
    prisma.gatewayUsageSettlementReceipt.findUnique.mockResolvedValue({
      gatewayBillingEventId: context.gatewayBillingEventId,
      requestId: context.anchor.requestId,
      evidenceHash: context.evidenceHash,
      anchorHash: context.anchor.anchorHash,
      pricingHash,
      settlementFingerprint: receipt.settlementFingerprint,
      billingUnit: 'BALANCE',
      creditAmount: null,
      tokenUsageId: receipt.tokenUsageId,
      fundingOutcome: receipt.fundingOutcome,
      policyVersion: 'gateway-settlement-v3-customer-authority',
      payload: receipt.payload,
    });

    const replay = await service.settleDeliveredGatewayUsage(input, context);

    expect(replay).toEqual(first);
    expect(billingService.deduct).toHaveBeenCalledTimes(1);
    expect(prisma.gatewayUsageSettlementReceipt.create).toHaveBeenCalledTimes(1);
  });

  it('rejects nonzero BALANCE meter corrections outside exact or protective-zero settlement', async () => {
    const built = buildService();
    const {
      service,
      prisma,
      modelPricing,
      providerCostPricing,
    } = built;
    const initialInput: UsageDeductInput = {
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      inputTokens: 100,
      outputTokens: 10,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 10,
      billingUnit: 'BALANCE',
      source: 'gateway:openai:gpt-test',
      requestId: 'req-frozen-balance-pricing',
      idempotencyKey: 'gateway:request:req-frozen-balance-pricing',
      eventOccurredAt: new Date('2026-07-01T00:00:00.000Z'),
      providerCode: 'openai',
      recordTokenUsage: true,
    };
    providerCostPricing.quote.mockResolvedValue({
      policyId: 'provider-policy-frozen',
      providerCode: 'openai',
      providerLineId: null,
      productId: 'prod-payg',
      priceMultiplier: new Prisma.Decimal('0.5'),
      inputCostUsdPerM: new Prisma.Decimal('0.25'),
      cachedInputCostUsdPerM: new Prisma.Decimal('0.05'),
      cacheWriteCostUsdPerM: new Prisma.Decimal('0.1'),
      outputCostUsdPerM: new Prisma.Decimal('0.75'),
      costUsd: new Prisma.Decimal('0.000027'),
    });
    const anchor = await service.resolveGatewaySettlementAnchor(
      prisma as never,
      initialInput,
      new Date('2026-07-01T00:00:01.000Z'),
    );
    const authoritativeInput: UsageDeductInput = {
      ...initialInput,
      inputTokens: 120,
      outputTokens: 15,
      cachedInputTokens: 30,
      cacheWriteInputTokens: 15,
      totalTokens: 135,
    };
    const context: GatewaySettlementContext = {
      gatewayBillingEventId: 'event-frozen-balance-pricing',
      expectedRevision: 0,
      evidenceHash: 'evidence-frozen-balance-pricing',
      anchor,
    };
    prisma.gatewayBillingEvent.findUnique.mockResolvedValue({
      id: context.gatewayBillingEventId,
      requestId: anchor.requestId,
      revision: context.expectedRevision,
      evidenceHash: context.evidenceHash,
    });
    prisma.gatewayUsageSettlementAnchor.findUnique.mockResolvedValue({
      requestId: anchor.requestId,
      anchorHash: anchor.anchorHash,
      pricingHash: anchor.pricingHash,
      billingCurrency: anchor.billingCurrency,
    });
    prisma.gatewayUsageEvidence.findFirst.mockResolvedValue({
      requestId: anchor.requestId,
      evidenceHash: context.evidenceHash,
      rawEvidence: {},
    });

    // Simulate model price and customer-discount edits after first receipt.
    // A settlement retry must not read either mutable table again.
    modelPricing.calculateCostQuote.mockClear();
    modelPricing.calculateCostQuote.mockRejectedValue(new Error('live model price changed'));
    prisma.usagePricingPolicy.findMany.mockClear();
    prisma.usagePricingPolicy.findMany.mockRejectedValue(new Error('live discount changed'));
    providerCostPricing.quote.mockClear();
    providerCostPricing.quote.mockRejectedValue(new Error('live provider cost changed'));

    await expect(service.valueGatewayUsageAtFrozenPricing(authoritativeInput, anchor))
      .rejects.toBeInstanceOf(GatewaySettlementAnchorConflictError);
    await expect(service.settleDeliveredGatewayUsage(authoritativeInput, context))
      .rejects.toBeInstanceOf(GatewaySettlementAnchorConflictError);
    expect(prisma.tokenUsage.create).not.toHaveBeenCalled();
    expect(modelPricing.calculateCostQuote).not.toHaveBeenCalled();
    expect(prisma.usagePricingPolicy.findMany).not.toHaveBeenCalled();
    expect(providerCostPricing.quote).not.toHaveBeenCalled();
    expect(prisma.gatewayUsageSettlementReceipt.create).not.toHaveBeenCalled();
  });

  it('ensures a provider-resale included scope before creating a CREDITS anchor', async () => {
    const built = buildService();
    const { service, prisma, subscriptionResolver, creditService } = built;
    prisma.apiKey.findFirst.mockResolvedValue({
      id: 'key-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-payg',
      codingPlanEntitlementId: 'ent-resale-1',
      isActive: true,
      mirrorStatus: 'ACTIVE',
      deletedAt: null,
      user: { id: 'user-1', email: 'u@example.com' },
      tenant: {
        billingAccountId: 'ba-personal-1',
        billingAccount: { type: 'personal', currency: 'USD' },
      },
      product: {
        id: 'prod-payg',
        slug: 'payg',
        billingMode: 'PAY_AS_YOU_GO',
      },
    });
    prisma.apiKey.findUnique.mockResolvedValue({
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-payg',
      codingPlanEntitlementId: 'ent-resale-1',
    });
    subscriptionResolver.resolveAtReceipt.mockResolvedValue({
      subscriptionId: 'ent-resale-1',
      entitlementKind: 'coding_plan_entitlement',
      codingPlanEntitlementId: 'ent-resale-1',
      planId: 'plan-resale-1',
      productId: 'prod-payg',
      billingPeriod: 'MONTHLY',
      fulfillmentMode: 'provider_resale',
      providerEntitlementId: 'provider-entitlement-1',
      providerLineId: 'line-1',
      providerLineCode: 'zhipu-line',
      providerCode: 'zhipu',
      upstreamProductId: 'glm-plan',
      plan: {
        id: 'plan-resale-1',
        name: 'Provider resale',
        monthlyCredits: 0,
        usageMultiplier: 1,
        rateLimitRpm: 0,
        rateLimitTpm: 0,
        maxContextWindow: 0,
      },
    });
    prisma.codingPlanEntitlement.findUnique.mockResolvedValue({
      id: 'ent-resale-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-payg',
      planId: 'plan-resale-1',
    });

    const anchor = await service.resolveGatewaySettlementAnchor(
      prisma as never,
      {
        apiKeyId: 'key-1',
        modelName: 'glm-5.2',
        inputTokens: 100,
        outputTokens: 20,
        billingUnit: 'CREDITS',
        source: 'gateway:zhipu:glm-5.2',
        requestId: 'req-resale-anchor',
        idempotencyKey: 'gateway:request:req-resale-anchor',
        eventOccurredAt: new Date('2026-07-01T00:00:00.000Z'),
      },
      new Date('2026-07-01T00:00:01.000Z'),
    );

    expect(anchor.customerQuoteSnapshot).toEqual(expect.objectContaining({
      unit: 'CREDITS',
      includedUpstream: true,
      creditCost: 0,
    }));
    expect(creditService.ensureBalanceStateForGatewayAnchor).toHaveBeenCalledWith(
      prisma,
      'ent-resale-1',
      'user-1',
    );
  });

  it('rejects nonzero CREDITS meter corrections outside exact or protective-zero settlement', async () => {
    const built = buildService();
    const {
      service,
      prisma,
      modelPricing,
      providerCostPricing,
      subscriptionResolver,
      creditService,
    } = built;
    const initialInput: UsageDeductInput = {
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      inputTokens: 100,
      outputTokens: 10,
      cachedInputTokens: 20,
      cacheWriteInputTokens: 10,
      billingUnit: 'CREDITS',
      source: 'gateway:openai:gpt-test',
      requestId: 'req-frozen-credit-pricing',
      idempotencyKey: 'gateway:request:req-frozen-credit-pricing',
      eventOccurredAt: new Date('2026-07-01T00:00:00.000Z'),
      providerCode: 'openai',
      recordTokenUsage: true,
    };
    providerCostPricing.quote.mockResolvedValue({
      policyId: 'provider-policy-frozen',
      providerCode: 'openai',
      providerLineId: null,
      productId: 'prod-payg',
      priceMultiplier: new Prisma.Decimal('0.5'),
      inputCostUsdPerM: new Prisma.Decimal('0.25'),
      cachedInputCostUsdPerM: new Prisma.Decimal('0.05'),
      cacheWriteCostUsdPerM: new Prisma.Decimal('0.1'),
      outputCostUsdPerM: new Prisma.Decimal('0.75'),
      costUsd: new Prisma.Decimal('0.000027'),
    });
    subscriptionResolver.resolveAtReceipt.mockResolvedValue({
      subscriptionId: 'sub-frozen-1',
      entitlementKind: 'subscription_period',
      codingPlanEntitlementId: null,
      planId: 'plan-frozen-1',
      productId: 'prod-payg',
      billingPeriod: 'MONTHLY',
      fulfillmentMode: null,
      plan: {
        id: 'plan-frozen-1',
        name: 'Frozen plan',
        monthlyCredits: 5000,
        usageMultiplier: 2,
        rateLimitRpm: 0,
        rateLimitTpm: 0,
        maxContextWindow: 0,
      },
    });
    prisma.subscriptionPeriod.findUnique.mockResolvedValue({
      id: 'sub-frozen-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba-personal-1',
      productId: 'prod-payg',
      planId: 'plan-frozen-1',
    });
    const anchor = await service.resolveGatewaySettlementAnchor(
      prisma as never,
      initialInput,
      new Date('2026-07-01T00:00:01.000Z'),
    );
    expect(creditService.ensureBalanceStateForGatewayAnchor).toHaveBeenCalledWith(
      prisma,
      'sub-frozen-1',
      'user-1',
    );
    const authoritativeInput: UsageDeductInput = {
      ...initialInput,
      inputTokens: 120,
      outputTokens: 15,
      cachedInputTokens: 30,
      cacheWriteInputTokens: 15,
      totalTokens: 135,
    };
    const context: GatewaySettlementContext = {
      gatewayBillingEventId: 'event-frozen-credit-pricing',
      expectedRevision: 0,
      evidenceHash: 'evidence-frozen-credit-pricing',
      anchor,
    };
    prisma.gatewayBillingEvent.findUnique.mockResolvedValue({
      id: context.gatewayBillingEventId,
      requestId: anchor.requestId,
      revision: context.expectedRevision,
      evidenceHash: context.evidenceHash,
    });
    prisma.gatewayUsageSettlementAnchor.findUnique.mockResolvedValue({
      requestId: anchor.requestId,
      anchorHash: anchor.anchorHash,
      pricingHash: anchor.pricingHash,
      billingCurrency: anchor.billingCurrency,
    });
    prisma.gatewayUsageEvidence.findFirst.mockResolvedValue({
      requestId: anchor.requestId,
      evidenceHash: context.evidenceHash,
      rawEvidence: {},
    });

    // Simulate plan multiplier/model-access/model-price edits after receipt.
    modelPricing.calculateCostQuote.mockClear();
    modelPricing.calculateCostQuote.mockRejectedValue(new Error('live model price changed'));
    subscriptionResolver.resolveAtReceipt.mockClear();
    subscriptionResolver.resolveAtReceipt.mockRejectedValue(new Error('live plan changed'));
    prisma.modelAccess.findUnique.mockClear();
    prisma.modelAccess.findUnique.mockResolvedValue({
      isActive: false,
      creditMultiplier: new Prisma.Decimal(99),
    });
    prisma.usagePricingPolicy.findMany.mockClear();
    prisma.usagePricingPolicy.findMany.mockRejectedValue(new Error('live discount changed'));
    providerCostPricing.quote.mockClear();
    providerCostPricing.quote.mockRejectedValue(new Error('live provider cost changed'));

    await expect(service.settleDeliveredGatewayUsage(authoritativeInput, context))
      .rejects.toBeInstanceOf(GatewaySettlementAnchorConflictError);
    expect(prisma.tokenUsage.create).not.toHaveBeenCalled();
    expect(creditService.deduct).not.toHaveBeenCalled();
    expect(modelPricing.calculateCostQuote).not.toHaveBeenCalled();
    expect(subscriptionResolver.resolveAtReceipt).not.toHaveBeenCalled();
    expect(prisma.modelAccess.findUnique).not.toHaveBeenCalled();
    expect(prisma.usagePricingPolicy.findMany).not.toHaveBeenCalled();
    expect(providerCostPricing.quote).not.toHaveBeenCalled();
    expect(prisma.gatewayUsageSettlementReceipt.create).not.toHaveBeenCalled();
  });

  it('atomically receipts a protective CREDITS zero from a positive original quote', async () => {
    const built = buildService();
    const { service, prisma, creditService } = built;
    const originalDimensions = {
      inputTokens: 120,
      outputTokens: 15,
      cachedInputTokens: 30,
      cacheWriteInputTokens: 10,
      totalTokens: 135,
      imageCount: 0,
    };
    const originalInput: UsageDeductInput = {
      apiKeyId: 'key-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-payg',
      productSlug: 'payg',
      modelName: 'gpt-test',
      ...originalDimensions,
      billingUnit: 'CREDITS',
      source: 'gateway:openai:gpt-test',
      requestId: 'req-zero-priced-credits',
      idempotencyKey: 'gateway:request:req-zero-priced-credits',
      eventOccurredAt: new Date('2026-07-01T00:00:00.000Z'),
      providerCode: 'openai',
      recordTokenUsage: true,
    };
    const initialContext = prepareGatewaySettlement(built, originalInput);
    if (initialContext.anchor.customerQuoteSnapshot.unit !== 'CREDITS') {
      throw new Error('expected CREDITS test anchor');
    }
    // The first receipt is genuinely positive. Any uncertain provider usage is
    // settled at an all-meter customer zero; no tariff redistribution is used.
    expect(initialContext.anchor.customerQuoteSnapshot.creditCost).toBe(70);
    const zeroCachedBasePricing = {
      ...initialContext.anchor.customerPricingSnapshot.basePricing,
      status: 'VERIFIED' as const,
      costUsd: '0.0675',
      cachedInputPriceUsdPerM: '0',
    };
    const customerPricingSnapshot: GatewayCustomerPricingSnapshot = {
      ...initialContext.anchor.customerPricingSnapshot,
      basePricing: zeroCachedBasePricing,
      includedUpstream: false,
    };
    const pricingHash = createHash('sha256').update(testCanonicalJson({
      customerQuoteSnapshot: initialContext.anchor.customerQuoteSnapshot,
      customerPricingSnapshot,
      providerCostSnapshot: initialContext.anchor.providerCostSnapshot,
    })).digest('hex');
    const context: GatewaySettlementContext = {
      ...initialContext,
      anchor: {
        ...initialContext.anchor,
        pricingHash,
        customerPricingSnapshot,
      },
    };
    prisma.gatewayUsageSettlementAnchor.findUnique.mockResolvedValue({
      requestId: context.anchor.requestId,
      anchorHash: context.anchor.anchorHash,
      pricingHash,
      billingCurrency: context.anchor.billingCurrency,
    });
    const settledDimensions = {
      inputTokens: 0,
      outputTokens: 0,
      cachedInputTokens: 0,
      cacheWriteInputTokens: 0,
      totalTokens: 0,
      imageCount: 0,
    };
    const input: UsageDeductInput = {
      ...originalInput,
      ...settledDimensions,
      source: `${originalInput.source}:customer-protective-zero`,
      gatewayCustomerSettlement: {
        policyVersion: 'gateway-customer-settlement-v2',
        basis: 'CUSTOMER_PROTECTIVE_ZERO',
        evidenceReason: 'usage_dimension_cache_creation_missing',
        originalDimensions,
        settledDimensions,
      },
    };

    const first = await service.settleDeliveredGatewayUsage(input, context);

    expect(first).toMatchObject({
      success: true,
      allowed: true,
      unit: 'CREDITS',
      fundingOutcome: 'INCLUDED',
      reason: 'zero_priced_credits',
      quote: expect.objectContaining({
        creditCost: 0,
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
      }),
      zeroCreditCharge: {
        protocol: 'gateway-credits-zero-charge-v1',
        creditMutationIdempotencyKey:
          `gateway:credits:${context.anchor.requestId}:${context.anchor.anchorHash}`,
      },
      tokenUsageId: 'usage-1',
    });
    expect(creditService.deduct).not.toHaveBeenCalled();
    const usage = prisma.tokenUsage.create.mock.calls[0][0].data;
    expect(usage).toEqual(expect.objectContaining({
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      customerChargePolicy: 'subscription_credits',
      customerFundingClassificationComplete: true,
    }));
    expect(usage.customerChargeUsd.toString()).toBe('0');
    expect(usage.customerCollectedUsd.toString()).toBe('0');
    const receipt = prisma.gatewayUsageSettlementReceipt.create.mock.calls[0][0].data;
    expect(receipt).toEqual(expect.objectContaining({
      fundingOutcome: 'INCLUDED',
      billingUnit: 'CREDITS',
      creditAmount: 0,
      amountUsd: new Prisma.Decimal(0),
      tokenUsageId: 'usage-1',
      reason: 'zero_priced_credits',
      policyVersion: 'gateway-settlement-v3-customer-authority',
      payload: expect.objectContaining({
        gatewayCustomerSettlement: expect.objectContaining({
          basis: 'CUSTOMER_PROTECTIVE_ZERO',
          originalDimensions,
          settledDimensions,
        }),
        customerFinancialAuthority: expect.objectContaining({
          terminalClass: 'CREDITS_ZERO',
          customerAmountUnit: 'CREDITS',
          originalCustomerAmount: '70',
          settledCustomerAmount: '0',
          settledCustomerChargeUsd: '0.000000000000',
          originalDimensions,
          settledDimensions,
        }),
        billingResult: expect.objectContaining({
          zeroCreditCharge: expect.objectContaining({
            protocol: 'gateway-credits-zero-charge-v1',
          }),
        }),
      }),
    }));
    prisma.gatewayUsageSettlementReceipt.findUnique.mockResolvedValue({
      gatewayBillingEventId: context.gatewayBillingEventId,
      requestId: context.anchor.requestId,
      evidenceHash: context.evidenceHash,
      anchorHash: context.anchor.anchorHash,
      pricingHash: context.anchor.pricingHash,
      settlementFingerprint: receipt.settlementFingerprint,
      billingUnit: 'CREDITS',
      creditAmount: 0,
      tokenUsageId: receipt.tokenUsageId,
      fundingOutcome: 'INCLUDED',
      policyVersion: 'gateway-settlement-v3-customer-authority',
      payload: receipt.payload,
    });

    const replay = await service.settleDeliveredGatewayUsage(input, context);

    expect(replay).toEqual(first);
    expect(prisma.tokenUsage.create).toHaveBeenCalledTimes(1);
    expect(prisma.gatewayUsageSettlementReceipt.create).toHaveBeenCalledTimes(1);
    expect(creditService.deduct).not.toHaveBeenCalled();
  });

  it('records exact zero-priced CREDITS authority as zero even when token usage pricing has cost', async () => {
    const built = buildService();
    const { service, prisma, creditService } = built;
    const input: UsageDeductInput = {
      apiKeyId: 'key-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-payg',
      productSlug: 'payg',
      modelName: 'gpt-test',
      inputTokens: 120,
      outputTokens: 15,
      cachedInputTokens: 30,
      cacheWriteInputTokens: 10,
      totalTokens: 135,
      imageCount: 0,
      billingUnit: 'CREDITS',
      source: 'gateway:openai:gpt-test',
      requestId: 'req-exact-zero-credit-multiplier',
      idempotencyKey: 'gateway:request:req-exact-zero-credit-multiplier',
      eventOccurredAt: new Date('2026-07-01T00:00:00.000Z'),
      providerCode: 'openai',
      recordTokenUsage: true,
    };
    const initial = prepareGatewaySettlement(built, input);
    if (initial.anchor.customerQuoteSnapshot.unit !== 'CREDITS') {
      throw new Error('expected CREDITS test anchor');
    }
    const customerQuoteSnapshot = {
      ...initial.anchor.customerQuoteSnapshot,
      baseCreditCost: 0,
      creditCost: 0,
    };
    const customerPricingSnapshot: GatewayCustomerPricingSnapshot = {
      ...initial.anchor.customerPricingSnapshot,
      customerMultiplier: '0',
      baseCreditCost: 0,
      creditCost: 0,
      includedUpstream: false,
      // The USD pricing snapshot intentionally stays positive. A frozen zero
      // credit policy is the customer authority, so it must not leak this
      // internal valuation into customer charge/funding fields.
      tokenUsagePricing: {
        ...initial.anchor.customerPricingSnapshot.tokenUsagePricing,
        status: 'VERIFIED',
        costUsd: '0.0675',
      },
    };
    const pricingHash = createHash('sha256').update(testCanonicalJson({
      customerQuoteSnapshot,
      customerPricingSnapshot,
      providerCostSnapshot: initial.anchor.providerCostSnapshot,
    })).digest('hex');
    const context: GatewaySettlementContext = {
      ...initial,
      anchor: {
        ...initial.anchor,
        pricingHash,
        customerQuoteSnapshot,
        customerPricingSnapshot,
      },
    };
    prisma.gatewayUsageSettlementAnchor.findUnique.mockResolvedValue({
      requestId: context.anchor.requestId,
      anchorHash: context.anchor.anchorHash,
      pricingHash,
      billingCurrency: context.anchor.billingCurrency,
    });

    const result = await service.settleDeliveredGatewayUsage(input, context);

    expect(result).toEqual(expect.objectContaining({
      success: true,
      fundingOutcome: 'INCLUDED',
      reason: 'zero_priced_credits',
      tokenUsageId: 'usage-1',
      quote: expect.objectContaining({ creditCost: 0 }),
    }));
    expect(creditService.deduct).not.toHaveBeenCalled();
    const usage = prisma.tokenUsage.create.mock.calls[0][0].data;
    expect(usage.customerChargeUsd.toString()).toBe('0');
    expect(usage.customerCollectedUsd.toString()).toBe('0');
    const receipt = prisma.gatewayUsageSettlementReceipt.create.mock.calls[0][0].data;
    expect(receipt.payload.customerFinancialAuthority).toEqual(expect.objectContaining({
      basis: 'NORMALIZED_EXACT',
      terminalClass: 'CREDITS_ZERO',
      customerAmountUnit: 'CREDITS',
      originalCustomerAmount: '0',
      settledCustomerAmount: '0',
      originalCustomerChargeUsd: '0.000000000000',
      settledCustomerChargeUsd: '0.000000000000',
    }));
  });

  it('uses the lowest price multiplier for balance quotes', async () => {
    const { service, modelPricing } = buildService();

    const quote = await service.quote({
      userId: 'user-1',
      productId: 'prod-payg',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
    });

    if (quote.unit !== 'BALANCE') throw new Error('expected BALANCE quote');
    expect(quote.policy.id).toBe('user');
    expect(quote.baseCostUsd).toBe('1.25');
    expect(quote.effectiveCostUsd).toBe('0.875');
    expect(quote.amountCents).toBe(88);
    expect(modelPricing.calculateCostQuote).toHaveBeenCalledWith(
      'gpt-test',
      1000,
      500,
      0,
      0,
      {
        productId: 'prod-payg',
        priceBasis: 'PRODUCT_EFFECTIVE',
        effectiveAt: expect.any(Date),
        bandAt: expect.any(Date),
      },
    );
  });

  it('freezes the caller-provided pricingAt as bandAt/effectiveAt for non-anchored quotes (cross-boundary safety)', async () => {
    const { service, modelPricing } = buildService();
    // 冻结的计价时刻（如 deductInternal 入口取的 now）必须逐层传到定价，
    // 而不是在 quote 内部重新取 new Date()——否则跨峰谷边界时档位分叉。
    const pricingAt = new Date('2026-08-24T13:00:00+08:00');

    await service.quote({
      userId: 'user-1',
      productId: 'prod-payg',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
    }, undefined, pricingAt);

    expect(modelPricing.calculateCostQuote).toHaveBeenCalledWith(
      'gpt-test',
      1000,
      500,
      0,
      0,
      expect.objectContaining({ effectiveAt: pricingAt, bandAt: pricingAt }),
    );
  });

  it('prefers the request start time (eventOccurredAt) over the frozen pricingAt', async () => {
    const { service, modelPricing } = buildService();
    const startTime = new Date('2026-08-24T10:00:00+08:00');
    const pricingAt = new Date('2026-08-24T13:00:00+08:00');

    await service.quote({
      userId: 'user-1',
      productId: 'prod-payg',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
      eventOccurredAt: startTime.toISOString(),
    }, undefined, pricingAt);

    expect(modelPricing.calculateCostQuote).toHaveBeenCalledWith(
      'gpt-test',
      1000,
      500,
      0,
      0,
      expect.objectContaining({ effectiveAt: startTime, bandAt: startTime }),
    );
  });

  it('reserves only live funding reservations before authorizing later usage', async () => {
    const { service, prisma } = buildService();
    prisma.gatewayBillingEvent.aggregate.mockResolvedValue({
      _sum: { pendingHoldUsd: new Prisma.Decimal('9.2') },
    });
    prisma.gatewayUsageFundingReservation.aggregate.mockResolvedValue({
      _sum: { reservedAmountUsd: new Prisma.Decimal('9.2') },
    });

    const result = await service.authorize({
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
      requestId: 'req-later-usage',
    });

    expect(result).toMatchObject({
      allowed: false,
      reason: 'insufficient_balance',
      balanceCents: 80,
    });
    expect(prisma.gatewayBillingEvent.aggregate).not.toHaveBeenCalled();
    expect(prisma.gatewayUsageFundingReservation.aggregate).toHaveBeenCalledWith({
      where: {
        billingAccountId: 'ba-personal-1',
        status: { in: ['ACTIVE', 'MANUAL_REVIEW'] },
        requestId: { not: 'req-later-usage' },
      },
      _sum: { reservedAmountUsd: true },
    });
  });

  it('ignores legacy evidence OPEN holds when no funding reservation exists', async () => {
    const { service, prisma } = buildService();
    prisma.gatewayBillingEvent.aggregate.mockResolvedValue({
      _sum: { pendingHoldUsd: new Prisma.Decimal('99') },
    });

    const result = await service.authorize({
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
      requestId: 'req-after-evidence-open',
    });

    expect(result.allowed).toBe(true);
    expect(prisma.gatewayBillingEvent.aggregate).not.toHaveBeenCalled();
  });

  it('allows an enterprise account to consume its active credit line', async () => {
    const { service, prisma, billingService } = buildService();
    prisma.apiKey.findFirst.mockResolvedValue({
      id: 'key-enterprise',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-payg',
      isActive: true,
      mirrorStatus: 'ACTIVE',
      deletedAt: null,
      user: { id: 'user-1', email: 'u@example.com' },
      tenant: {
        billingAccountId: 'ba-enterprise-1',
        billingAccount: { type: 'enterprise', currency: 'USD' },
      },
      product: {
        id: 'prod-payg',
        slug: 'payg',
        billingMode: 'PAY_AS_YOU_GO',
      },
    });
    billingService.getBalanceReportForUser.mockResolvedValue({
      balanceUsd: 5,
      billingAccountType: 'enterprise',
      creditLimitCents: 500,
    });

    const result = await service.authorize({
      apiKeyId: 'key-enterprise',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
    });

    expect(result.allowed).toBe(true);
    expect(result.creditLimitCents).toBe(500);
  });

  it('treats an enterprise account without active credit like a strict personal balance', async () => {
    const { service, prisma, billingService } = buildService();
    prisma.apiKey.findFirst.mockResolvedValue({
      id: 'key-enterprise-no-credit',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-payg',
      isActive: true,
      mirrorStatus: 'ACTIVE',
      deletedAt: null,
      user: { id: 'user-1', email: 'u@example.com' },
      tenant: {
        billingAccountId: 'ba-enterprise-no-credit',
        billingAccount: { type: 'enterprise', currency: 'USD' },
      },
      product: {
        id: 'prod-payg',
        slug: 'payg',
        billingMode: 'PAY_AS_YOU_GO',
      },
    });
    billingService.getBalanceReportForUser.mockResolvedValue({
      balanceUsd: 0,
      billingAccountType: 'enterprise',
      creditLimitCents: 0,
    });

    const result = await service.authorize({
      apiKeyId: 'key-enterprise-no-credit',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
    });

    expect(result).toMatchObject({
      allowed: false,
      reason: 'insufficient_balance',
      creditLimitCents: 0,
    });
  });

  it('returns displayName in PAYG model-pricing items without changing modelName', async () => {
    const productModelAvailabilityFindMany = jest.fn().mockResolvedValue([{
      id: 'availability-1',
      modelName: 'glm-5',
      status: 'ACTIVE',
      apiEnabled: true,
      visible: true,
      startsAt: null,
      endsAt: null,
      displayOrder: 1,
      reason: '',
      createdAt: new Date('2026-07-30T00:00:00Z'),
      updatedAt: new Date('2026-07-30T00:00:00Z'),
      modelPricing: {
        modelName: 'glm-5',
        modelId: 'GLM 5 用户版',
        provider: 'zhipu',
        isActive: true,
        inputPricePerMToken: new Prisma.Decimal('1'),
        cachedInputPrice: null,
        cacheWrite5minPrice: null,
        cacheWrite1hPrice: null,
        outputPricePerMToken: new Prisma.Decimal('2'),
      },
    }]);
    const { service } = buildService({
      productModelAvailability: {
        findMany: productModelAvailabilityFindMany,
      },
      paygModelPricingPolicy: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    });

    const result = await service.listPaygModelPricing('prod-payg');

    expect(result.items[0]).toEqual(expect.objectContaining({
      modelName: 'glm-5',
      displayName: 'GLM 5 用户版',
    }));
    expect(productModelAvailabilityFindMany).toHaveBeenCalledWith(
      expect.objectContaining({
        include: {
          modelPricing: {
            select: expect.objectContaining({ modelId: true }),
          },
        },
      }),
    );
  });

  it('listPaygModelPricing: 仍在生效的历史遗留覆盖价 ⇒ effective/offPeakEffective 置空并给出 pricingReason', async () => {
    const productModelAvailabilityFindMany = jest.fn().mockResolvedValue([{
      id: 'availability-legacy',
      modelName: 'glm-5',
      status: 'ACTIVE',
      apiEnabled: true,
      visible: true,
      startsAt: null,
      endsAt: null,
      displayOrder: 1,
      reason: '',
      createdAt: new Date('2026-07-30T00:00:00Z'),
      updatedAt: new Date('2026-07-30T00:00:00Z'),
      modelPricing: {
        modelName: 'glm-5',
        modelId: 'GLM 5 用户版',
        provider: 'zhipu',
        isActive: true,
        inputPricePerMToken: new Prisma.Decimal('1'),
        cachedInputPrice: null,
        cacheWrite5minPrice: null,
        cacheWrite1hPrice: null,
        outputPricePerMToken: new Prisma.Decimal('2'),
      },
    }]);
    // 脏数据：当前生效的策略行仍带绝对覆盖价（机制已废除）
    const legacyPolicy = {
      id: 'policy-legacy',
      modelName: 'glm-5',
      priceMultiplier: new Prisma.Decimal('0.9'),
      inputPricePerMToken: new Prisma.Decimal('7'),
      cachedInputPrice: null,
      cacheWritePrice: null,
      outputPricePerMToken: null,
      startsAt: new Date('2026-07-01T00:00:00Z'),
      endsAt: null,
      isActive: true,
      description: '',
      createdAt: new Date('2026-07-01T00:00:00Z'),
      updatedAt: new Date('2026-07-01T00:00:00Z'),
    };
    const { service } = buildService({
      productModelAvailability: { findMany: productModelAvailabilityFindMany },
      paygModelPricingPolicy: { findMany: jest.fn().mockResolvedValue([legacyPolicy]) },
    });

    const result = await service.listPaygModelPricing('prod-payg');
    const item = result.items[0] as any;

    expect(item.pricingReason).toBe('LEGACY_OVERRIDE_DETECTED');
    expect(item.effective).toBeNull();
    expect(item.offPeakEffective).toBeNull();
    // 历史策略仍可审计：base 与 policy/policies 保留
    expect(item.base.input).toBe(1);
    expect(item.policy.input).toBe(7);
    expect(item.policies).toHaveLength(1);
  });

  it('normalizes cache buckets once so quote, charge, and token usage share the same tokens', async () => {
    const { service, modelPricing } = buildService();

    const quote = await service.quote({
      userId: 'user-1',
      productId: 'prod-payg',
      modelName: 'gpt-test',
      inputTokens: 100,
      cachedInputTokens: 80,
      cacheWriteInputTokens: 80,
      outputTokens: 0,
      billingUnit: 'BALANCE',
    });

    if (quote.unit !== 'BALANCE') throw new Error('expected BALANCE quote');
    expect(quote.inputTokens).toBe(100);
    expect(quote.cachedInputTokens).toBe(80);
    expect(quote.cacheWriteInputTokens).toBe(20);
    expect(modelPricing.calculateCostQuote).toHaveBeenCalledWith(
      'gpt-test',
      100,
      0,
      80,
      20,
      expect.objectContaining({ priceBasis: 'PRODUCT_EFFECTIVE' }),
    );
  });

  it('settles configured image pricing to BALANCE and persists an image billing line', async () => {
    const { service, prisma, billingService, providerCostPricing } = buildService({
      usagePricingPolicy: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    });

    const result = await service.deduct({
      apiKeyId: 'key-1',
      modelName: 'cogview-4',
      imageCount: 2,
      callType: 'image_generation',
      upstreamModel: 'cogview-4',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      billingUnit: 'BALANCE',
      source: 'gateway:cn:zhipu:cogview-4',
      requestId: 'gw-image-balance-1',
      idempotencyKey: 'gateway:request:gw-image-balance-1',
      recordTokenUsage: true,
    });

    expect(result).toMatchObject({
      success: true,
      unit: 'BALANCE',
      quote: {
        effectiveCostUsd: '0.12',
        lineItems: [{
          meter: 'image',
          quantity: 2,
          unitPriceUsd: '0.06',
          amountUsd: '0.12',
        }],
      },
    });
    expect(billingService.deduct).toHaveBeenCalledWith(
      'user-1',
      '0.12',
      'gateway:cn:zhipu:cogview-4',
      expect.any(Object),
    );

    const usageData = prisma.tokenUsage.create.mock.calls[0][0].data;
    expect(usageData).toMatchObject({
      model: 'cogview-4',
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
      meter: 'image',
      quantity: 2,
      callType: 'image_generation',
      upstreamModel: 'cogview-4',
    });
    expect(usageData.unitPriceUsd.toString()).toBe('0.06');
    expect(usageData.customerChargeUsd.toString()).toBe('0.12');
    expect(usageData.costUsd.toString()).toBe('0.12');
    expect(providerCostPricing.quote).not.toHaveBeenCalled();
  });

  it('scales image line unit price and amount with the existing customer price policy', async () => {
    const { service } = buildService();

    const quote = await service.quote({
      userId: 'user-1',
      productId: 'prod-payg',
      modelName: 'cogview-4',
      imageCount: 1,
      inputTokens: 0,
      outputTokens: 0,
      billingUnit: 'BALANCE',
    });

    if (quote.unit !== 'BALANCE') throw new Error('expected BALANCE quote');
    expect(quote.policy.id).toBe('user');
    expect(quote.baseCostUsd).toBe('0.06');
    expect(quote.effectiveCostUsd).toBe('0.042');
    expect(quote.lineItems).toEqual([{
      meter: 'image',
      quantity: 1,
      unitPriceUsd: '0.042',
      amountUsd: '0.042',
    }]);
  });

  it('settles configured image pricing to CREDITS without token fabrication', async () => {
    const {
      service,
      prisma,
      creditPricing,
      creditService,
      providerCostPricing,
    } = buildService({
      usagePricingPolicy: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    });

    const result = await service.deduct({
      apiKeyId: 'key-1',
      modelName: 'cogview-4',
      imageCount: 1,
      callType: 'image_generation',
      upstreamModel: 'cogview-4',
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      billingUnit: 'CREDITS',
      source: 'gateway:cn:zhipu:cogview-4',
      requestId: 'gw-image-credits-1',
      idempotencyKey: 'gateway:request:gw-image-credits-1',
      recordTokenUsage: true,
    });

    expect(result).toMatchObject({
      success: true,
      unit: 'CREDITS',
      quote: {
        baseCreditCost: 6,
        creditCost: 6,
        inputTokens: 0,
        outputTokens: 0,
        lineItems: [{
          meter: 'image',
          quantity: 1,
          unitPriceUsd: '0.06',
          amountUsd: '0.06',
        }],
      },
    });
    expect(creditPricing.calculateCreditCostQuote).toHaveBeenCalledWith(
      'plan-1',
      'cogview-4',
      0,
      0,
      1,
      0,
      expect.objectContaining({ imageCount: 1 }),
    );
    expect(creditService.deduct).toHaveBeenCalledWith(
      'sub-1',
      'user-1',
      6,
      'gateway:cn:zhipu:cogview-4',
      'cogview-4',
      expect.objectContaining({ inputTokens: 0, outputTokens: 0, totalTokens: 0 }),
      expect.any(Object),
    );

    const usageData = prisma.tokenUsage.create.mock.calls[0][0].data;
    expect(usageData).toMatchObject({
      meter: 'image',
      quantity: 1,
      promptTokens: 0,
      completionTokens: 0,
      totalTokens: 0,
    });
    expect(usageData.unitPriceUsd.toString()).toBe('0.06');
    expect(usageData.customerChargeUsd.toString()).toBe('0.06');
    expect(providerCostPricing.quote).not.toHaveBeenCalled();
  });

  it('applies enterprise model discounts and ignores personal policy scopes for enterprise api key usage', async () => {
    const usagePricingPolicyFindMany = jest.fn().mockResolvedValue([
      {
        id: 'global',
        scope: 'GLOBAL',
        userId: null,
        segmentId: null,
        modelName: null,
        priceMultiplier: new Prisma.Decimal('0.1'),
        creditMultiplier: null,
        priority: 0,
        createdAt: new Date('2026-01-01T00:00:00Z'),
      },
    ]);
    const enterpriseDiscountFindUnique = jest.fn().mockResolvedValue({
      id: 'enterprise-model-discount',
      billingAccountId: 'ba-ent-1',
      productId: 'prod-payg',
      modelName: 'gpt-test',
      priceMultiplier: new Prisma.Decimal('0.6'),
      isActive: true,
    });
    const { service, modelPricing } = buildService({
      apiKey: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'key-ent-1',
          userId: 'user-1',
          tenantId: 'tenant-ent-1',
          productId: 'prod-payg',
          isActive: true,
          mirrorStatus: 'ACTIVE',
          deletedAt: null,
          user: { id: 'user-1', email: 'u@example.com' },
          tenant: {
            billingAccountId: 'ba-ent-1',
            billingAccount: { type: 'enterprise', currency: 'USD' },
          },
          product: {
            id: 'prod-payg',
            slug: 'payg',
            billingMode: 'PAY_AS_YOU_GO',
          },
        }),
      },
      usagePricingPolicy: {
        findMany: usagePricingPolicyFindMany,
      },
      enterpriseModelDiscount: {
        findUnique: enterpriseDiscountFindUnique,
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue({}),
      },
    });

    const quote = await service.quote({
      apiKeyId: 'key-ent-1',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
    });

    if (quote.unit !== 'BALANCE') throw new Error('expected BALANCE quote');
    expect(quote.policy.id).toBe('enterprise-model-discount');
    expect(quote.policy.scope).toBe('ENTERPRISE');
    expect(quote.effectiveCostUsd).toBe('0.75');
    expect(quote.amountCents).toBe(75);
    expect(quote.priceBasis).toBe('LIST');
    expect(quote.customerPricing).toEqual({
      inputPriceUsdPerM: '300',
      cachedInputPriceUsdPerM: null,
      cacheWritePriceUsdPerM: null,
      outputPriceUsdPerM: '900',
    });
    expect(modelPricing.calculateCostQuote).toHaveBeenCalledWith(
      'gpt-test',
      1000,
      500,
      0,
      0,
      {
        productId: 'prod-payg',
        priceBasis: 'LIST',
        effectiveAt: expect.any(Date),
        bandAt: expect.any(Date),
      },
    );
    expect(enterpriseDiscountFindUnique).toHaveBeenCalledWith({
      where: {
        billingAccountId_productId_modelName: {
          billingAccountId: 'ba-ent-1',
          productId: 'prod-payg',
          modelName: 'gpt-test',
        },
      },
    });
    expect(usagePricingPolicyFindMany).not.toHaveBeenCalled();
  });

  it('records enterprise token usage with final LIST-times-enterprise bucket prices', async () => {
    const { service, prisma, modelPricing } = buildService({
      apiKey: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'key-ent-1',
          userId: 'user-1',
          tenantId: 'tenant-ent-1',
          productId: 'prod-payg',
          isActive: true,
          mirrorStatus: 'ACTIVE',
          deletedAt: null,
          user: { id: 'user-1', email: 'u@example.com' },
          tenant: {
            billingAccountId: 'ba-ent-1',
            billingAccount: { type: 'enterprise', currency: 'USD' },
          },
          product: {
            id: 'prod-payg',
            slug: 'payg',
            billingMode: 'PAY_AS_YOU_GO',
          },
        }),
      },
      enterpriseModelDiscount: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'enterprise-model-discount',
          billingAccountId: 'ba-ent-1',
          productId: 'prod-payg',
          modelName: 'gpt-test',
          priceMultiplier: new Prisma.Decimal('0.3333'),
          isActive: true,
        }),
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue({}),
      },
    });

    await service.deduct({
      apiKeyId: 'key-ent-1',
      modelName: 'gpt-test',
      inputTokens: 1000,
      cachedInputTokens: 100,
      cacheWriteInputTokens: 50,
      outputTokens: 500,
      billingUnit: 'BALANCE',
      source: 'gateway:cn:openai:gpt-test',
      requestId: 'gw-enterprise-pricing',
      idempotencyKey: 'gateway:request:gw-enterprise-pricing',
      recordTokenUsage: true,
    });

    expect(modelPricing.calculateCostQuote).toHaveBeenNthCalledWith(
      1,
      'gpt-test',
      1000,
      500,
      100,
      50,
      {
        productId: 'prod-payg',
        priceBasis: 'LIST',
        effectiveAt: expect.any(Date),
        bandAt: expect.any(Date),
      },
    );
    expect(modelPricing.calculateCostQuote).toHaveBeenNthCalledWith(
      2,
      'gpt-test',
      1000,
      500,
      100,
      50,
      {
        productId: 'prod-payg',
        priceBasis: 'LIST',
        effectiveAt: expect.any(Date),
      },
    );
    expect(modelPricing.calculateCostQuote).toHaveBeenCalledTimes(2);

    const tokenUsageData = prisma.tokenUsage.create.mock.calls[0][0].data;
    expect(tokenUsageData.inputPriceUsdPerM.toString()).toBe('166.65');
    expect(tokenUsageData.cachedInputPriceUsdPerM.toString()).toBe('166.65');
    expect(tokenUsageData.cacheWritePriceUsdPerM.toString()).toBe('166.65');
    expect(tokenUsageData.outputPriceUsdPerM.toString()).toBe('499.95');
    expect(tokenUsageData.customerChargeUsd.toString()).toBe('0.416625');
    expect(tokenUsageData.costUsd.toString()).toBe('0.416625');
  });

  it('keeps non-PAYG enterprise balance fallback on product-effective pricing', async () => {
    const { service, modelPricing } = buildService({
      apiKey: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'key-ent-coding',
          userId: 'user-1',
          tenantId: 'tenant-ent-1',
          productId: 'prod-coding',
          codingPlanEntitlementId: null,
          isActive: true,
          mirrorStatus: 'ACTIVE',
          deletedAt: null,
          user: { id: 'user-1', email: 'u@example.com' },
          tenant: {
            billingAccountId: 'ba-ent-1',
            billingAccount: { type: 'enterprise', currency: 'USD' },
          },
          product: {
            id: 'prod-coding',
            slug: 'coding',
            billingMode: 'CODING_PLAN',
          },
        }),
      },
      enterpriseModelDiscount: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'enterprise-model-discount',
          billingAccountId: 'ba-ent-1',
          productId: 'prod-coding',
          modelName: 'gpt-test',
          priceMultiplier: new Prisma.Decimal('0.6'),
          isActive: true,
        }),
        findMany: jest.fn().mockResolvedValue([]),
        upsert: jest.fn().mockResolvedValue({}),
      },
    });

    const quote = await service.quote({
      apiKeyId: 'key-ent-coding',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
    });

    if (quote.unit !== 'BALANCE') throw new Error('expected BALANCE quote');
    expect(quote.priceBasis).toBe('PRODUCT_EFFECTIVE');
    expect(modelPricing.calculateCostQuote).toHaveBeenCalledWith(
      'gpt-test',
      1000,
      500,
      0,
      0,
      {
        productId: 'prod-coding',
        priceBasis: 'PRODUCT_EFFECTIVE',
        effectiveAt: expect.any(Date),
        bandAt: expect.any(Date),
      },
    );
  });

  it('returns active LIST pricing tiers in the enterprise discount matrix', async () => {
    const productModelAvailabilityFindMany = jest.fn().mockResolvedValue([{
      modelName: 'glm-5-turbo',
      status: 'ACTIVE',
      apiEnabled: true,
      visible: true,
      startsAt: null,
      endsAt: null,
      displayOrder: 1,
      reason: '',
      modelPricing: {
        modelName: 'glm-5-turbo',
        provider: 'zhipu',
        isActive: true,
        inputPricePerMToken: new Prisma.Decimal('7'),
        cachedInputPrice: new Prisma.Decimal('1.2'),
        cacheWrite5minPrice: null,
        cacheWrite1hPrice: null,
        outputPricePerMToken: new Prisma.Decimal('26'),
        longContextThreshold: 32_000,
        longContextInputPrice: new Prisma.Decimal('9'),
        longContextOutputPrice: new Prisma.Decimal('30'),
        priceTiers: [{
          tierKey: 'short',
          displayName: '0-32K',
          minInputTokens: 0,
          maxInputTokensExclusive: 32_000,
          inputPricePerMToken: new Prisma.Decimal('7'),
          outputPricePerMToken: new Prisma.Decimal('26'),
          cachedInputPrice: new Prisma.Decimal('1.2'),
          cacheWritePrice: null,
          currency: 'USD',
          rawCondition: 'input_tokens < 32000',
          source: 'official',
          priority: 0,
          isActive: true,
        }],
      },
    }]);
    const { service } = buildService({
      billingAccount: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'ba-ent-1',
          name: 'Enterprise',
          type: 'enterprise',
          status: 'active',
          enterpriseName: 'Enterprise',
          ownerUserId: 'user-1',
        }),
      },
      productModelAvailability: {
        findMany: productModelAvailabilityFindMany,
      },
      enterpriseModelDiscount: {
        findUnique: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([{
          id: 'discount-1',
          modelName: 'glm-5-turbo',
          priceMultiplier: new Prisma.Decimal('0.5'),
          isActive: true,
          note: '',
          updatedBy: 'admin-1',
          createdAt: new Date('2026-07-20T00:00:00Z'),
          updatedAt: new Date('2026-07-20T00:00:00Z'),
        }]),
        upsert: jest.fn().mockResolvedValue({}),
      },
    });

    const result = await service.listEnterpriseModelDiscounts('ba-ent-1', 'prod-payg');

    // ⚠️ 期望值已按修复更新：此前这里把缺陷编码进了期望（cacheWrite 一律 null）。
    // 该 fixture 的 cacheWrite5minPrice/1hPrice 都是 null，而结算侧对 cacheWrite tokens
    // 按 **input 价** 扣（effectiveCacheWritePrice = cacheWritePriceUsdPerM ?? inputPriceUsdPerM），
    // 所以页面必须显示 input 价，不能显示「未配置」。cached 是显式配置的 1.2，故不回退。
    const INHERITED = { cached: false, cacheWrite: true };
    expect(result.items[0]).toEqual(expect.objectContaining({
      inherited: INHERITED,
      base: { input: 7, cached: 1.2, cacheWrite: 7, output: 26 },
      effective: { input: 3.5, cached: 0.6, cacheWrite: 3.5, output: 13 },
      fallbackPricing: {
        longContext: {
          minInputTokens: 32_000,
          inherited: INHERITED,
          base: { input: 9, cached: 1.2, cacheWrite: 9, output: 30 },
          effective: { input: 4.5, cached: 0.6, cacheWrite: 4.5, output: 15 },
        },
        default: {
          inherited: INHERITED,
          base: { input: 7, cached: 1.2, cacheWrite: 7, output: 26 },
          effective: { input: 3.5, cached: 0.6, cacheWrite: 3.5, output: 13 },
        },
      },
      tiers: [{
        tierKey: 'short',
        displayName: '0-32K',
        minInputTokens: 0,
        maxInputTokensExclusive: 32_000,
        currency: 'USD',
        rawCondition: 'input_tokens < 32000',
        source: 'official',
        priority: 0,
        isActive: true,
        inherited: INHERITED,
        base: { input: 7, cached: 1.2, cacheWrite: 7, output: 26 },
        effective: { input: 3.5, cached: 0.6, cacheWrite: 3.5, output: 13 },
      }],
    }));
    expect(productModelAvailabilityFindMany).toHaveBeenCalledWith(expect.objectContaining({
      include: {
        modelPricing: {
          select: expect.objectContaining({
            priceTiers: expect.objectContaining({
              where: { isActive: true },
            }),
            longContextThreshold: true,
            longContextInputPrice: true,
            longContextOutputPrice: true,
          }),
        },
      },
    }));
  });

  it('uses lower global multiplier over higher user and segment multipliers for balance quotes', async () => {
    const { service } = buildService({
      usagePricingPolicy: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'global',
            scope: 'GLOBAL',
            userId: null,
            segmentId: null,
            modelName: null,
            priceMultiplier: new Prisma.Decimal('0.6'),
            creditMultiplier: null,
            priority: 0,
            createdAt: new Date('2026-01-01T00:00:00Z'),
          },
          {
            id: 'segment',
            scope: 'SEGMENT',
            userId: null,
            segmentId: 'seg-1',
            modelName: null,
            priceMultiplier: new Prisma.Decimal('0.7'),
            creditMultiplier: null,
            priority: 500,
            createdAt: new Date('2026-01-01T00:00:00Z'),
          },
          {
            id: 'user',
            scope: 'USER',
            userId: 'user-1',
            segmentId: null,
            modelName: null,
            priceMultiplier: new Prisma.Decimal('0.8'),
            creditMultiplier: null,
            priority: 1000,
            createdAt: new Date('2026-01-01T00:00:00Z'),
          },
        ]),
      },
    });

    const quote = await service.quote({
      userId: 'user-1',
      productId: 'prod-payg',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
    });

    if (quote.unit !== 'BALANCE') throw new Error('expected BALANCE quote');
    expect(quote.policy.id).toBe('global');
    expect(quote.effectiveCostUsd).toBe('0.75');
    expect(quote.amountCents).toBe(75);
  });

  it('uses lower global multiplier over higher user multiplier for apiKey deducts', async () => {
    const { service, billingService } = buildService({
      usagePricingPolicy: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'global',
            scope: 'GLOBAL',
            userId: null,
            segmentId: null,
            modelName: null,
            priceMultiplier: new Prisma.Decimal('0.6'),
            creditMultiplier: null,
            priority: 0,
            createdAt: new Date('2026-01-01T00:00:00Z'),
          },
          {
            id: 'user',
            scope: 'USER',
            userId: 'user-1',
            segmentId: null,
            modelName: null,
            priceMultiplier: new Prisma.Decimal('0.8'),
            creditMultiplier: null,
            priority: 1000,
            createdAt: new Date('2026-01-01T00:00:00Z'),
          },
        ]),
      },
    });

    const result = await service.deduct({
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
      source: 'gateway:us-east-1:openai:gpt-test',
      requestId: 'gw-lowest-discount',
      idempotencyKey: 'gateway:request:gw-lowest-discount',
    });

    expect(result.success).toBe(true);
    expect(result.quote).toEqual(expect.objectContaining({
      policy: expect.objectContaining({ id: 'global' }),
      effectiveCostUsd: '0.75',
    }));
    expect(billingService.deduct).toHaveBeenCalledWith(
      'user-1',
      '0.75',
      'gateway:us-east-1:openai:gpt-test',
      expect.objectContaining({
        productId: 'prod-payg',
        tenantId: 'tenant-1',
      }),
    );
  });

  it('uses the lowest effective credit multiplier for credit quotes', async () => {
    const { service } = buildService({
      usagePricingPolicy: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'global-credit',
            scope: 'GLOBAL',
            userId: null,
            segmentId: null,
            modelName: null,
            priceMultiplier: new Prisma.Decimal('0.9'),
            creditMultiplier: new Prisma.Decimal('0.6'),
            priority: 0,
            createdAt: new Date('2026-01-01T00:00:00Z'),
          },
          {
            id: 'segment',
            scope: 'SEGMENT',
            userId: null,
            segmentId: 'seg-1',
            modelName: null,
            priceMultiplier: new Prisma.Decimal('0.7'),
            creditMultiplier: null,
            priority: 500,
            createdAt: new Date('2026-01-01T00:00:00Z'),
          },
          {
            id: 'user-low-price',
            scope: 'USER',
            userId: 'user-1',
            segmentId: null,
            modelName: null,
            priceMultiplier: new Prisma.Decimal('0.5'),
            creditMultiplier: new Prisma.Decimal('0.8'),
            priority: 1000,
            createdAt: new Date('2026-01-01T00:00:00Z'),
          },
        ]),
      },
    });

    const quote = await service.quote({
      userId: 'user-1',
      productId: 'prod-payg',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'CREDITS',
    });

    if (quote.unit !== 'CREDITS') throw new Error('expected CREDITS quote');
    expect(quote.policy.id).toBe('global-credit');
    expect(quote.baseCreditCost).toBe(100);
    expect(quote.creditCost).toBe(60);
  });

  it('skips the publisher key-balance sync when funding stays positive', async () => {
    // Gateway only learns the has_balance boolean from this publish (the payload
    // carries value:"1", never an amount), so a settlement that leaves funding
    // positive republishes the identical projection. Production measured one
    // distinct (has_balance, fingerprint) pair across 50,526 writes in a day on
    // the busiest Key. The required closure on the exhausted branch is a
    // separate, deliberately repeated contract and is unaffected.
    const { service, publisherSync } = buildService();

    const result = await service.deduct({
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
      source: 'gateway:sg:openai:gpt-test',
      requestId: 'gw-req-1',
      idempotencyKey: 'gw-req-1:final',
      apiKeyId: 'key-1',
    });

    expect(result.success).toBe(true);
    expect(publisherSync.syncKeyBalanceById).not.toHaveBeenCalled();
  });

  it('still syncs publisher key balance when the skip is switched off', async () => {
    const { service, publisherSync } = buildService({
      __config: { BILLING_SETTLEMENT_PUBLISH_SKIP_UNCHANGED: 'false' },
    });

    const result = await service.deduct({
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
      source: 'gateway:sg:openai:gpt-test',
      requestId: 'gw-req-1',
      idempotencyKey: 'gw-req-1:final',
      apiKeyId: 'key-1',
    });

    expect(result.success).toBe(true);
    expect(publisherSync.syncKeyBalanceById).toHaveBeenCalledWith('key-1', {
      deleteWhenMissing: false,
    });
  });

  describe('PAYG 分档展示价必须等于实际扣费价', () => {
    const VALID_WINDOWS = [{ days: [1, 2, 3, 4, 5], start: '09:00', end: '12:00' }];

    /** 构造一个带 priceTiers 的可用模型。 */
    const availabilityWith = (tiers: any[]) => ([{
      id: 'availability-tiers',
      modelName: 'gpt-tier',
      status: 'ACTIVE',
      apiEnabled: true,
      visible: true,
      startsAt: null,
      endsAt: null,
      displayOrder: 1,
      reason: '',
      createdAt: new Date('2026-08-01T00:00:00Z'),
      updatedAt: new Date('2026-08-01T00:00:00Z'),
      modelPricing: {
        modelName: 'gpt-tier',
        modelId: 'GPT Tier',
        provider: 'openai',
        isActive: true,
        pricingUnit: 'token_1m',
        inputPricePerMToken: new Prisma.Decimal('10'),
        cachedInputPrice: null,
        cacheWrite5minPrice: null,
        cacheWrite1hPrice: null,
        outputPricePerMToken: new Prisma.Decimal('20'),
        longContextThreshold: null,
        longContextInputPrice: null,
        longContextOutputPrice: null,
        priceTiers: tiers,
      },
    }]);

    const policy = (multiplier: string) => ([{
      id: 'policy-tier',
      modelName: 'gpt-tier',
      priceMultiplier: new Prisma.Decimal(multiplier),
      inputPricePerMToken: null,
      cachedInputPrice: null,
      cacheWritePrice: null,
      outputPricePerMToken: null,
      startsAt: new Date('2026-08-01T00:00:00Z'),
      endsAt: null,
      isActive: true,
      description: '',
      createdAt: new Date('2026-08-01T00:00:00Z'),
      updatedAt: new Date('2026-08-01T00:00:00Z'),
    }]);

    const listWith = async (tiers: any[], multiplier = '0.5') => {
      const { service } = buildService({
        productModelAvailability: {
          findMany: jest.fn().mockResolvedValue(availabilityWith(tiers)),
        },
        paygModelPricingPolicy: { findMany: jest.fn().mockResolvedValue(policy(multiplier)) },
      });
      const result = await service.listPaygModelPricing('prod-payg');
      return result.items[0] as any;
    };

    it('档位缺 cached/cacheWrite 专属价 ⇒ 展示价按该档 input 回退（结算就是这么扣的）', async () => {
      // ⚠️ 结算侧：effectiveCachedInputPrice = cachedInputPriceUsdPerM ?? inputPriceUsdPerM，
      // effectiveCacheWritePrice 同理（model-pricing.service.ts）。此前这里吐 null ⇒
      // 页面显示「未配置」而实际按 input 价扣费。
      const item = await listWith([{
        tierKey: 'LONG_CTX',
        displayName: '长上下文',
        minInputTokens: 200000,
        maxInputTokensExclusive: null,
        priority: 10,
        inputPricePerMToken: new Prisma.Decimal('30'),
        cachedInputPrice: null,
        cacheWritePrice: null,
        outputPricePerMToken: new Prisma.Decimal('60'),
        bandSchedule: null,
      }]);

      const tier = item.tiers[0];
      // 基价：两个缓存桶都回退到本档 input（30），而不是 null。
      expect(tier.base.cached).toBe(30);
      expect(tier.base.cacheWrite).toBe(30);
      // 生效价：与 input 生效价逐项相同（30 × 0.5 = 15）—— 这才是实际扣费价。
      expect(tier.effective.input).toBe(15);
      expect(tier.effective.cached).toBe(15);
      expect(tier.effective.cacheWrite).toBe(15);
      // 来源可标注：让运营分得清「配了专属价」与「沿用 input」。
      expect(tier.inherited).toEqual({ cached: true, cacheWrite: true });
    });

    it('顶层 base 缺缓存价也回退到 input（否则前端会丢掉正确的 effective）', async () => {
      // ⚠️ 变异验证发现这一处**零覆盖**：把它改回吐 null，128 条测试照旧全绿。
      // 而它的危害是具体的：配对的 effective 本来就带回退（非空），前端的
      // effectivePriceForDraft 见 basePrice == null 就 return null ⇒ 把**正确的**
      // effective 丢掉，页面显示「未配置」而客户实际按 input 价被扣。
      const item = await listWith([], '0.5');
      // fixture：input=10、两个缓存桶都没配、模型不是 GLM ⇒ 两桶都回退到 10。
      expect(item.base.cached).toBe(10);
      expect(item.base.cacheWrite).toBe(10);
      expect(item.baseInherited).toEqual({ cached: true, cacheWrite: true });
      // 与配对的 effective 一致（10 × 0.5）——这才是「页面价 == 扣费价」。
      expect(item.effective.cached).toBe(5);
      expect(item.effective.cacheWrite).toBe(5);
    });
    it('两页四处的回退规则同源（改一处就该全变，不允许再出现第五份拷贝）', () => {
      // ⚠️ 这个缺陷此前有**四份拷贝**：按量页 tiers[]、按量页顶层 base、
      // 企业折扣页 tiers[]、两页共用的 toEnterpriseFallbackPrice。逐份改就是在等第五份。
      // 现在统一走 toPriceBuckets —— 这条直接对那个唯一落点断言，
      // 任何人把回退规则改坏（或再抄一份出去）都会在这里被发现。
      const svc = buildService().service as any;
      const D = (v: string) => new Prisma.Decimal(v);
      // 两个缓存桶都没配 ⇒ 都回退到 input(10)，生效价 = 10 × 0.5。
      expect(svc.toPriceBuckets('gpt-x', D('10'), D('20'), null, null, D('0.5')))
        .toEqual({
          inherited: { cached: true, cacheWrite: true },
          base: { input: 10, cached: 10, cacheWrite: 10, output: 20 },
          effective: { input: 5, cached: 5, cacheWrite: 5, output: 10 },
        });
      // 配了专属价 ⇒ 用专属价，不被回退覆盖。
      expect(svc.toPriceBuckets('gpt-x', D('10'), D('20'), D('1'), D('2'), D('0.5')))
        .toEqual({
          inherited: { cached: false, cacheWrite: false },
          base: { input: 10, cached: 1, cacheWrite: 2, output: 20 },
          effective: { input: 5, cached: 0.5, cacheWrite: 1, output: 10 },
        });
      // GLM 缓存读折扣（input × 0.2）优先于 input 回退，且与结算侧同规则。
      // 注意 inherited.cached 为 **false**：GLM 的缓存读价是**派生**的（input×0.2），
      // 不是「沿用 input 价」——这个标记的语义严格是「该桶价格就等于 input」。
      expect(svc.toPriceBuckets('glm-5', D('10'), D('20'), null, null, D('1')))
        .toMatchObject({
          inherited: { cached: false, cacheWrite: true },
          base: { cached: 2, cacheWrite: 10 },
        });
    });
    it('档位配了专属缓存价 ⇒ 用专属价，不被回退覆盖', async () => {
      // 反向钉：把回退写成无条件用 input 时，这条会红。
      const item = await listWith([{
        tierKey: 'LONG_CTX',
        displayName: '长上下文',
        minInputTokens: 200000,
        maxInputTokensExclusive: null,
        priority: 10,
        inputPricePerMToken: new Prisma.Decimal('30'),
        cachedInputPrice: new Prisma.Decimal('3'),
        cacheWritePrice: new Prisma.Decimal('6'),
        outputPricePerMToken: new Prisma.Decimal('60'),
        bandSchedule: null,
      }]);

      const tier = item.tiers[0];
      expect(tier.base.cached).toBe(3);
      expect(tier.base.cacheWrite).toBe(6);
      expect(tier.effective.cached).toBe(1.5);
      expect(tier.effective.cacheWrite).toBe(3);
      expect(tier.inherited).toEqual({ cached: false, cacheWrite: false });
    });

    it.each([
      ['schedule 缺失', null],
      ['schedule 空数组（否则会被当成全天空闲）', []],
      ['schedule 结构非法', { nope: 1 }],
      ['schedule 非法 JSON 字符串', '{'],
    ])('OFF_PEAK %s ⇒ 不作为可生效档展示', async (_label, bandSchedule: any) => {
      // ⚠️ 结算命中 OFF_PEAK 需 bandAt + isTokenPricingUnit + parseBandScheduleSafely 同时成立；
      // 脏 schedule 会被结算忽略并回落普通档。此前 tiers[] 无条件收录 ⇒
      // 页面显示一个**永不生效**的空闲价。
      const item = await listWith([{
        tierKey: 'OFF_PEAK',
        displayName: '空闲时段',
        minInputTokens: 0,
        maxInputTokensExclusive: null,
        priority: 1,
        inputPricePerMToken: new Prisma.Decimal('5'),
        cachedInputPrice: null,
        cacheWritePrice: null,
        outputPricePerMToken: new Prisma.Decimal('10'),
        bandSchedule,
      }]);

      expect(item.tiers.map((t: any) => t.tierKey)).not.toContain('OFF_PEAK');
    });

    it('OFF_PEAK schedule 合法 ⇒ 正常展示（证明上一条不是把整档写死排除）', async () => {
      const item = await listWith([{
        tierKey: 'OFF_PEAK',
        displayName: '空闲时段',
        minInputTokens: 0,
        maxInputTokensExclusive: null,
        priority: 1,
        inputPricePerMToken: new Prisma.Decimal('5'),
        cachedInputPrice: null,
        cacheWritePrice: null,
        outputPricePerMToken: new Prisma.Decimal('10'),
        bandSchedule: VALID_WINDOWS,
      }]);

      expect(item.tiers.map((t: any) => t.tierKey)).toContain('OFF_PEAK');
      expect(item.tiers[0].effective.input).toBe(2.5);
    });

    it('非 token 计价单位 ⇒ OFF_PEAK 也不展示（与结算的 isTokenPricingUnit 一致）', async () => {
      const avail = availabilityWith([{
        tierKey: 'OFF_PEAK',
        displayName: '空闲时段',
        minInputTokens: 0,
        maxInputTokensExclusive: null,
        priority: 1,
        inputPricePerMToken: new Prisma.Decimal('5'),
        cachedInputPrice: null,
        cacheWritePrice: null,
        outputPricePerMToken: new Prisma.Decimal('10'),
        bandSchedule: VALID_WINDOWS,
      }]);
      avail[0].modelPricing.pricingUnit = 'image_count';
      const { service } = buildService({
        productModelAvailability: { findMany: jest.fn().mockResolvedValue(avail) },
        paygModelPricingPolicy: { findMany: jest.fn().mockResolvedValue(policy('0.5')) },
      });
      const result = await service.listPaygModelPricing('prod-payg');
      expect((result.items[0] as any).tiers.map((t: any) => t.tierKey))
        .not.toContain('OFF_PEAK');
    });
  });
  describe('PAYG 倍率-only 写侧', () => {
    it('传入任一绝对覆盖价 ⇒ 400', async () => {
      const svc = buildService().service as any;
      await expect(
        svc.createPaygModelPricingVersion({
          productId: 'prod-payg',
          modelName: 'gpt-4o',
          priceMultiplier: '0.9',
          inputPricePerMToken: '7',
        }),
      ).rejects.toMatchObject({ status: 400 });
    });

    // ⚠️ 这一组钉的是资金级阻断项：Number() 宽松转换会把若干非法输入静默变成**倍率 0**，
    // 也就是客户免费。实测（node 复验）：Number('   ')===0、Number(false)===0、Number([])===0；
    // 另有 Number('0x10')===16（十六进制被接受）、'1e-9' 这类正数经 round4 变成 0.0000。
    // 0 本身是合法倍率，所以不能靠 falsy 挡 —— 只能把非法**输入形态**挡在外面。
    it.each([
      ['空白字符串（Number 得 0 = 免费）', '   '],
      ['布尔 false（Number 得 0 = 免费）', false],
      ['空数组（Number 得 0 = 免费）', []],
      ['单元素数组（Number 得 1）', [1]],
      ['十六进制字符串（Number 得 16）', '0x10'],
      ['科学计数法正数（round4 后变 0 = 免费）', '1e-9'],
      ['十进制正数但小于 4 位精度（round4 后变 0 = 免费）', '0.00001'],
      ['负数', -1],
      ['超上限', 100.0001],
      ['NaN 字符串', 'NaN'],
      ['对象', {}],
    ])('倍率非法形态：%s ⇒ 400，绝不静默变成免费', (_label, priceMultiplier: any) => {
      const svc = buildService().service as any;
      expect(() => svc.normalizePaygMultiplier(priceMultiplier))
        .toThrow(expect.objectContaining({ status: 400 }));
    });

    it('写链路真的用了这道校验（非法倍率在落库前被拒，DB 零写入）', async () => {
      // ⚠️ 单测那个函数本身不够：守卫必须真的接在写链路上。
      // 这条把产品/模型查询都 mock 通，让请求一直走到落库前，断言它被 400 挡住且 create 零调用。
      const paygCreate = jest.fn();
      const svc = buildService({
        product: {
          findFirst: jest.fn().mockResolvedValue({
            id: 'prod-payg',
            name: 'PAYG',
            slug: 'payg',
            billingMode: 'PAY_AS_YOU_GO',
            isActive: true,
          }),
        },
        modelPricing: {
          findFirst: jest.fn().mockResolvedValue({ modelName: 'gpt-4o' }),
        },
        paygModelPricingPolicy: { create: paygCreate },
      }).service as any;

      await expect(svc.createPaygModelPricingVersion({
        productId: 'prod-payg',
        modelName: 'gpt-4o',
        // 实测 Number('   ') === 0 ⇒ 旧实现会静默落库成「免费」。
        priceMultiplier: '   ',
      })).rejects.toMatchObject({ status: 400 });
      expect(paygCreate).not.toHaveBeenCalled();
    });

    it.each([
      ['数字 0（合法：免费）', 0, '0'],
      ['字符串 0', '0', '0'],
      ['十进制字符串', '0.5', '0.5'],
      ['带空格的十进制字符串', ' 0.5 ', '0.5'],
      ['数字 1', 1, '1'],
      ['上限 100', 100, '100'],
      ['四位小数', '0.1234', '0.1234'],
    ])('倍率合法形态：%s ⇒ 精确落值 %s', (_label, input: any, expected: string) => {
      const svc = buildService().service as any;
      expect(svc.normalizePaygMultiplier(input).toString()).toBe(expected);
    });

    it.each([[undefined], [null]])('未提供倍率 ⇒ 视为 1 倍（不改价）', (input: any) => {
      const svc = buildService().service as any;
      expect(svc.normalizePaygMultiplier(input).toString()).toBe('1');
    });
    it('只传倍率 ⇒ 守卫放行', () => {
      const svc = buildService().service as any;
      expect(() =>
        svc.assertNoPaygOverridePrices({
          productId: 'prod-payg',
          modelName: 'gpt-4o',
          priceMultiplier: '0.9',
        }),
      ).not.toThrow();
    });
  });

  describe('fundingMeasure', () => {
    // The skip decision reads a funding measure straight off a settlement
    // response. Number() would coerce several non-numeric shapes into finite
    // numbers; `true` is the dangerous one because it becomes 1 and would
    // suppress a publish on a response this code does not understand.
    it('accepts real numbers', () => {
      expect(fundingMeasure(9.125)).toBe(9.125);
      expect(fundingMeasure(0)).toBe(0);
      expect(fundingMeasure(-3.5)).toBe(-3.5);
    });

    it('accepts strictly numeric strings', () => {
      expect(fundingMeasure('9.125')).toBe(9.125);
      expect(fundingMeasure(' 0 ')).toBe(0);
    });

    it('rejects booleans so true cannot be read as a balance of 1', () => {
      expect(fundingMeasure(true)).toBeNull();
      expect(fundingMeasure(false)).toBeNull();
    });

    it('rejects the shapes Number() would coerce to zero', () => {
      expect(fundingMeasure(null)).toBeNull();
      expect(fundingMeasure(undefined)).toBeNull();
      expect(fundingMeasure('')).toBeNull();
      expect(fundingMeasure('   ')).toBeNull();
      expect(fundingMeasure([])).toBeNull();
      expect(fundingMeasure({})).toBeNull();
    });

    it('rejects non-finite numbers and unparseable strings', () => {
      expect(fundingMeasure(Number.NaN)).toBeNull();
      expect(fundingMeasure(Number.POSITIVE_INFINITY)).toBeNull();
      expect(fundingMeasure('forever')).toBeNull();
      expect(fundingMeasure('9.125usd')).toBeNull();
    });
  });

  it('hashes Redis lock keys for external idempotency keys', async () => {
    const { service, redis } = buildService();
    const idempotencyKey = 'gateway:request:gw-req\r\nEVAL injected';

    const result = await service.deduct({
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
      source: 'gateway:sg:openai:gpt-test',
      requestId: 'gw-req',
      idempotencyKey,
      apiKeyId: 'key-1',
    });

    expect(result.success).toBe(true);
    expect(redis.set).toHaveBeenCalledWith(
      billingUsageDeductLockKey(idempotencyKey),
      '1',
      'EX',
      60,
      'NX',
    );
    const redisKeys = [
      ...redis.set.mock.calls.map((call: unknown[]) => call[0]),
      ...redis.del.mock.calls.map((call: unknown[]) => call[0]),
    ];
    expect(redisKeys.every((key) => typeof key === 'string' && !key.includes('\r') && !key.includes('\n'))).toBe(true);
  });

  it('resolves user and product from apiKeyId for gateway quote', async () => {
    const { service, prisma } = buildService();

    const quote = await service.quote({
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
    });

    expect(prisma.apiKey.findFirst).toHaveBeenCalledWith({
      where: { id: 'key-1' },
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
    expect(prisma.user.findUnique).not.toHaveBeenCalled();
    expect(prisma.product.findUnique).not.toHaveBeenCalled();
    expect(quote.userId).toBe('user-1');
    expect(quote.productId).toBe('prod-payg');
    expect(quote.productSlug).toBe('payg');
  });

  it('settles delayed gateway usage for a soft-deleted apiKey when the event occurred before deletion', async () => {
    const { service, prisma, billingService } = buildService();
    prisma.apiKey.findFirst.mockResolvedValueOnce({
      id: 'key-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-payg',
      isActive: false,
      mirrorStatus: 'DELETED',
      deletedAt: new Date('2026-06-18T15:28:33.000Z'),
      user: { id: 'user-1', email: 'u@example.com' },
      product: {
        id: 'prod-payg',
        slug: 'payg',
        billingMode: 'PAY_AS_YOU_GO',
      },
    });

    const result = await service.deduct({
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      totalTokens: 1500,
      billingUnit: 'BALANCE',
      source: 'gateway:us-east-1:openai:gpt-test',
      requestId: 'gw-before-delete',
      idempotencyKey: 'gateway:request:gw-before-delete',
      eventOccurredAt: '2026-06-18T15:16:00.000Z',
      recordTokenUsage: true,
    });

    expect(result.success).toBe(true);
    expect(billingService.deduct).toHaveBeenCalledWith(
      'user-1',
      '0.875',
      'gateway:us-east-1:openai:gpt-test',
      expect.objectContaining({
        productId: 'prod-payg',
        tenantId: 'tenant-1',
      }),
    );
    expect(prisma.tokenUsage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        apiKeyId: 'key-1',
        requestId: 'gw-before-delete',
        createdAt: new Date('2026-06-18T15:16:00.000Z'),
      }),
    });
  });

  it('rejects soft-deleted apiKey usage when the event occurred at or after deletion', async () => {
    const { service, prisma } = buildService();
    prisma.apiKey.findFirst.mockResolvedValueOnce({
      id: 'key-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-payg',
      isActive: false,
      mirrorStatus: 'DELETED',
      deletedAt: new Date('2026-06-18T15:28:33.000Z'),
      user: { id: 'user-1', email: 'u@example.com' },
      product: {
        id: 'prod-payg',
        slug: 'payg',
        billingMode: 'PAY_AS_YOU_GO',
      },
    });

    await expect(service.quote({
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
      eventOccurredAt: '2026-06-18T15:28:33.000Z',
    })).rejects.toThrow('API Key 不存在或已删除');
  });

  it('rejects soft-deleted apiKey usage without a verifiable event occurrence time', async () => {
    const { service, prisma } = buildService();
    prisma.apiKey.findFirst.mockResolvedValueOnce({
      id: 'key-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-payg',
      isActive: false,
      mirrorStatus: 'DELETED',
      deletedAt: new Date('2026-06-18T15:28:33.000Z'),
      user: { id: 'user-1', email: 'u@example.com' },
      product: {
        id: 'prod-payg',
        slug: 'payg',
        billingMode: 'PAY_AS_YOU_GO',
      },
    });

    await expect(service.quote({
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
    })).rejects.toThrow('API Key 不存在或已删除');
  });

  it('requires ModelAccess for CODING_PLAN credit quotes', async () => {
    const { service, prisma, creditPricing } = buildService();
    prisma.apiKey.findFirst.mockResolvedValueOnce({
      id: 'key-coding',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-coding',
      // 专属 key：绑定 entitlement → 走套餐积分（计费分界 §4.3）
      codingPlanEntitlementId: 'ent-1',
      isActive: true,
      mirrorStatus: 'ACTIVE',
      deletedAt: null,
      user: { id: 'user-1', email: 'u@example.com' },
      product: {
        id: 'prod-coding',
        slug: 'tokenplan',
        billingMode: 'CODING_PLAN',
      },
    });

    const quote = await service.quote({
      apiKeyId: 'key-coding',
      modelName: 'glm-4.5',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'CREDITS',
    });

    expect(quote.unit).toBe('CREDITS');
    expect(creditPricing.calculateCreditCostQuote).toHaveBeenCalledWith(
      'plan-1',
      'glm-4.5',
      1000,
      500,
      1,
      0,
      expect.objectContaining({ requireModelAccess: true }),
    );
  });

  it('bills CODING_PLAN keys without an entitlement against BALANCE (billing boundary §4.3)', async () => {
    const { service, prisma, creditPricing } = buildService();
    // CODING_PLAN 产品但 key 未绑定 entitlement = 通用 key：按余额计费，即便显式请求 CREDITS。
    prisma.apiKey.findFirst.mockResolvedValueOnce({
      id: 'key-coding-unbound',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-coding',
      codingPlanEntitlementId: null,
      isActive: true,
      mirrorStatus: 'ACTIVE',
      deletedAt: null,
      user: { id: 'user-1', email: 'u@example.com' },
      product: {
        id: 'prod-coding',
        slug: 'tokenplan',
        billingMode: 'CODING_PLAN',
      },
    });

    const quote = await service.quote({
      apiKeyId: 'key-coding-unbound',
      modelName: 'glm-4.5',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'CREDITS',
    });

    expect(quote.unit).toBe('BALANCE');
    expect(creditPricing.calculateCreditCostQuote).not.toHaveBeenCalled();
  });

  describe('rolling quota gate (A 前置, quota-v2 §4.3)', () => {
    const prevFlag = process.env.BILLING_ROLLING_QUOTA_GATE_ENABLED;
    afterEach(() => {
      if (prevFlag === undefined) delete process.env.BILLING_ROLLING_QUOTA_GATE_ENABLED;
      else process.env.BILLING_ROLLING_QUOTA_GATE_ENABLED = prevFlag;
    });

    function codingPlanGateService(
      windowUsed: number,
      ruleSpec: { windowType: string; durationSec: number; metric: string; limitValue: number } = {
        windowType: 'ROLLING',
        durationSec: 18000,
        metric: 'REQUESTS',
        limitValue: 100,
      },
      extraOverrides: Record<string, unknown> = {},
    ) {
      const built = buildService({
        ...extraOverrides,
        plan: {
          findUnique: jest.fn().mockResolvedValue({
            quotaRules: [
              {
                template: {
                  isActive: true,
                  deletedAt: null,
                  rules: JSON.stringify([ruleSpec]),
                },
              },
            ],
          }),
        },
      });
      built.prisma.apiKey.findFirst.mockResolvedValueOnce({
        id: 'key-coding',
        userId: 'user-1',
        tenantId: 'tenant-1',
        productId: 'prod-coding',
        codingPlanEntitlementId: 'ent-1',
        isActive: true,
        mirrorStatus: 'ACTIVE',
        deletedAt: null,
        user: { id: 'user-1', email: 'u@example.com' },
        product: { id: 'prod-coding', slug: 'tokenplan', billingMode: 'CODING_PLAN' },
      });
      // 自营 CodingPlan entitlement 解析（A 闸自营守卫要求 entitlementKind==='coding_plan_entitlement'
      // 且 fulfillmentMode!=='provider_resale'）——本用例正是该 gate 应作用的对象。
      built.subscriptionResolver.resolve.mockResolvedValue({
        subscriptionId: 'ent-1',
        entitlementKind: 'coding_plan_entitlement',
        codingPlanEntitlementId: 'ent-1',
        planId: 'plan-coding',
        fulfillmentMode: 'platform_model_package',
        providerEntitlementId: null,
        plan: { usageMultiplier: 1 },
      });
      built.creditService.windowUsage.mockResolvedValue(windowUsed);
      return built;
    }

    const authInput = {
      apiKeyId: 'key-coding',
      modelName: 'glm-4.5',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'CREDITS' as const,
      eventOccurredAt: new Date('2026-07-01T00:00:00.000Z'),
    };

    // me/rolling-quota-gate-predicate-fix.md：谓词为「已达/超才拒」used>=limit（非前瞻 used+increment>limit）。
    it('rejects with rolling_quota_exhausted when used has reached the limit (used>=limit)', async () => {
      process.env.BILLING_ROLLING_QUOTA_GATE_ENABLED = 'true';
      const { service } = codingPlanGateService(100); // 已达上限 100 → 拒
      const result = await service.authorize(authInput);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('rolling_quota_exhausted');
      expect(result.quotaGate).toMatchObject({ metric: 'REQUESTS', limit: 100, used: 100 });
    });

    it('allows when window usage is under the limit', async () => {
      process.env.BILLING_ROLLING_QUOTA_GATE_ENABLED = 'true';
      const { service, creditService } = codingPlanGateService(10);
      const result = await service.authorize(authInput);
      expect(result.allowed).toBe(true);
      expect(result.reason).toBeUndefined();
      expect(creditService.getAuthoritativeBalances).toHaveBeenCalledWith('ent-1', 'user-1');
      expect(creditService.getBalances).not.toHaveBeenCalled();
    });

    // 核心行为变更：CREDITS 窗口 used 在 limit 之下时放行（允许本次把 used 推过 limit 的小额过冲），
    // 旧前瞻式会因 used+cost>limit 拒绝并把计数器冻结在 limit 之下、致 B 闸永不触发。
    const creditsRule = { windowType: 'ROLLING', durationSec: 18000, metric: 'CREDITS', limitValue: 300 };
    it('CREDITS: allows when used is below the limit even if this request would exceed it (允许小额过冲)', async () => {
      process.env.BILLING_ROLLING_QUOTA_GATE_ENABLED = 'true';
      const { service } = codingPlanGateService(290, creditsRule); // 290<300 → 放行（旧逻辑会因 290+cost>300 拒）
      const result = await service.authorize(authInput);
      expect(result.allowed).toBe(true);
      expect(result.reason).not.toBe('rolling_quota_exhausted');
    });

    it('CREDITS: rejects once used has reached/crossed the limit (used>=limit)', async () => {
      process.env.BILLING_ROLLING_QUOTA_GATE_ENABLED = 'true';
      const { service } = codingPlanGateService(300, creditsRule); // 300>=300 → 拒（计数器已抵达阈值，B 闸随即触发）
      const result = await service.authorize(authInput);
      expect(result.allowed).toBe(false);
      expect(result.reason).toBe('rolling_quota_exhausted');
      expect(result.quotaGate).toMatchObject({ metric: 'CREDITS', limit: 300, used: 300 });
    });

    it('自营守卫：非 coding_plan_entitlement(通用 SUBSCRIPTION) 即便超限也放行（不影响其它业务）', async () => {
      process.env.BILLING_ROLLING_QUOTA_GATE_ENABLED = 'true';
      const built = codingPlanGateService(100); // 已超限
      // 覆盖为通用订阅：A 闸自营守卫应直接放行，不跑滚动 gate。
      built.subscriptionResolver.resolve.mockResolvedValue({
        subscriptionId: 'sub-generic',
        entitlementKind: 'subscription_period',
        codingPlanEntitlementId: null,
        planId: 'plan-coding',
        fulfillmentMode: null,
        providerEntitlementId: null,
        plan: { usageMultiplier: 1 },
      });
      const result = await built.service.authorize(authInput);
      expect(result.allowed).toBe(true);
      expect(result.reason).not.toBe('rolling_quota_exhausted');
    });

    it('settles anchored CREDITS exactly once without re-running the T2 rolling admission gate', async () => {
      process.env.BILLING_ROLLING_QUOTA_GATE_ENABLED = 'true';
      setSelfopNegativeDeductOverride(true);
      try {
        const built = codingPlanGateService(100, undefined, {
          __config: { BILLING_GATEWAY_USAGE_ALLOW_NEGATIVE_BALANCE: 'true' },
        }); // T0 已交付；T2 即使窗口已满也必须留下资金/TokenUsage/永久回执。
        const settlementInput: UsageDeductInput = {
          ...authInput,
          apiKeyId: 'key-coding',
          source: 'gateway:us-east-1:openai:glm-4.5',
          requestId: 'gw-gate-not-exempt',
          idempotencyKey: 'gateway:request:gw-gate-not-exempt',
          allowNegativeBalance: true,
        };
        const settlementContext = prepareGatewaySettlement(built, settlementInput, {
          productId: 'prod-coding',
          productSlug: 'tokenplan',
          codingPlanEntitlementId: 'ent-1',
          subscriptionId: 'ent-1',
          planId: 'plan-coding',
        });
        const result = await built.service.settleDeliveredGatewayUsage(
          settlementInput,
          settlementContext,
        );
        expect(result).toEqual(expect.objectContaining({ success: true, allowed: true }));
        expect(built.creditService.windowUsage).not.toHaveBeenCalled();
        expect(built.creditService.deduct).toHaveBeenCalledTimes(1);
        expect(built.prisma.gatewayUsageSettlementReceipt.create).toHaveBeenCalledTimes(1);
        const receipt = built.prisma.gatewayUsageSettlementReceipt.create.mock.calls[0][0].data;
        expect(receipt.payload.customerFinancialAuthority).toEqual(expect.objectContaining({
          protocol: 'gateway-customer-financial-authority-v1',
          basis: 'NORMALIZED_EXACT',
          billingUnit: 'CREDITS',
          terminalClass: 'CREDITS_CHARGED',
          fundingOutcome: 'INCLUDED',
          customerAmountUnit: 'CREDITS',
          originalCustomerAmount: '70',
          settledCustomerAmount: '70',
          originalCustomerChargeUsd: '1.250000000000',
          settledCustomerChargeUsd: '1.250000000000',
          originalDimensions: {
            inputTokens: 1000,
            outputTokens: 500,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            totalTokens: 1500,
            imageCount: 0,
          },
          settledDimensions: {
            inputTokens: 1000,
            outputTokens: 500,
            cachedInputTokens: 0,
            cacheWriteInputTokens: 0,
            totalTokens: 1500,
            imageCount: 0,
          },
          tokenUsageId: 'usage-1',
        }));
      } finally {
        setSelfopNegativeDeductOverride(null);
      }
    });

    it('does not enforce the gate when the flag is off (default)', async () => {
      delete process.env.BILLING_ROLLING_QUOTA_GATE_ENABLED;
      const { service, creditService } = codingPlanGateService(100_000);
      const result = await service.authorize(authInput);
      expect(result.allowed).toBe(true);
      expect(creditService.windowUsage).not.toHaveBeenCalled();
    });
  });

  it('rejects apiKey usage when the key has no tenant binding', async () => {
    const { service, prisma } = buildService();
    prisma.apiKey.findFirst.mockResolvedValue({
      id: 'key-1',
      userId: 'user-1',
      tenantId: null,
      productId: 'prod-payg',
      isActive: true,
      mirrorStatus: 'ACTIVE',
      deletedAt: null,
      user: { id: 'user-1', email: 'u@example.com' },
      product: {
        id: 'prod-payg',
        slug: 'payg',
        billingMode: 'PAY_AS_YOU_GO',
      },
    });

    await expect(service.quote({
      apiKeyId: 'key-1',
      tenantId: 'tenant-from-event',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
    })).rejects.toThrow('API Key 必须绑定账号 tenantId');
  });

  it('rejects apiKey usage before billing mirror is active', async () => {
    const { service, prisma } = buildService();
    prisma.apiKey.findFirst.mockResolvedValue({
      id: 'key-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-payg',
      isActive: true,
      mirrorStatus: 'PROVISIONING',
      deletedAt: null,
      user: { id: 'user-1', email: 'u@example.com' },
      product: {
        id: 'prod-payg',
        slug: 'payg',
        billingMode: 'PAY_AS_YOU_GO',
      },
    });

    await expect(service.quote({
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
    })).rejects.toThrow('API Key 尚未完成账务开通');
  });

  it('rejects apiKey usage without product binding by default', async () => {
    const { service, prisma } = buildService();
    prisma.apiKey.findFirst.mockResolvedValue({
      id: 'key-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: null,
      isActive: true,
      mirrorStatus: 'ACTIVE',
      deletedAt: null,
      user: { id: 'user-1', email: 'u@example.com' },
      product: null,
    });

    await expect(service.quote({
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
    })).rejects.toThrow('api_key_product_unbound');
  });

  it('uses the apiKey tenant binding instead of gateway event tenantId', async () => {
    const { service, prisma, billingService } = buildService();
    prisma.apiKey.findFirst.mockResolvedValue({
      id: 'key-1',
      userId: 'user-1',
      tenantId: 'tenant-bound',
      productId: 'prod-payg',
      isActive: true,
      mirrorStatus: 'ACTIVE',
      deletedAt: null,
      user: { id: 'user-1', email: 'u@example.com' },
      product: {
        id: 'prod-payg',
        slug: 'payg',
        billingMode: 'PAY_AS_YOU_GO',
      },
    });

    await service.deduct({
      apiKeyId: 'key-1',
      tenantId: 'tenant-from-event',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
      source: 'gateway:us-east-1:openai:gpt-test',
      requestId: 'gw-tenant-bound',
      idempotencyKey: 'gateway:request:gw-tenant-bound',
    });

    expect(billingService.deduct).toHaveBeenCalledWith(
      'user-1',
      '0.875',
      'gateway:us-east-1:openai:gpt-test',
      expect.objectContaining({
        productId: 'prod-payg',
        tenantId: 'tenant-bound',
        allowNegativeBalance: false,
        afterBalanceTransaction: expect.any(Function),
      }),
    );
  });

  it('validates non-apiKey gateway tenantId against user membership', async () => {
    const { service, prisma, billingService } = buildService();

    await service.deduct({
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-payg',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
      source: 'gateway:us-east-1:openai:gpt-test',
      requestId: 'gw-user-tenant',
      idempotencyKey: 'gateway:request:gw-user-tenant',
    });

    expect(prisma.tenantMember.findFirst).toHaveBeenCalledWith({
      where: {
        tenantId: 'tenant-1',
        userId: 'user-1',
        status: 'active',
        tenant: {
          status: 'active',
          deletedAt: null,
        },
      },
      select: { id: true },
    });
    expect(billingService.deduct).toHaveBeenCalledWith(
      'user-1',
      '0.875',
      'gateway:us-east-1:openai:gpt-test',
      expect.objectContaining({
        productId: 'prod-payg',
        tenantId: 'tenant-1',
        allowNegativeBalance: false,
        afterBalanceTransaction: expect.any(Function),
      }),
    );
  });

  it('rejects non-apiKey gateway tenantId when the user is not an active member', async () => {
    const { service, prisma } = buildService();
    prisma.tenantMember.findFirst.mockResolvedValueOnce(null);

    await expect(
      service.quote({
        userId: 'user-1',
        tenantId: 'tenant-other',
        productId: 'prod-payg',
        modelName: 'gpt-test',
        inputTokens: 1000,
        outputTokens: 500,
        billingUnit: 'BALANCE',
      }),
    ).rejects.toThrow('tenantId 与用户不匹配或团队不可用');
  });

  it('records token usage for gateway event deducts when requested', async () => {
    const { service, prisma, modelPricing } = buildService();
    prisma.gatewayBillingEvent.findUnique.mockResolvedValueOnce({ id: 'gw-event-1' });

    const result = await service.deduct({
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      cachedInputTokens: 100,
      cacheWriteInputTokens: 50,
      totalTokens: 1500,
      billingUnit: 'BALANCE',
      source: 'gateway:us-east-1:openai:gpt-test',
      requestId: 'gw-req-2',
      idempotencyKey: 'gateway:request:gw-req-2',
      recordTokenUsage: true,
    });

    expect(result.tokenUsageId).toBe('usage-1');
    expect(prisma.gatewayBillingEvent.findUnique).toHaveBeenCalledWith({
      where: { requestId: 'gw-req-2' },
      select: { id: true },
    });
    expect(prisma.tokenUsage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        apiKeyId: 'key-1',
        productId: 'prod-payg',
        gatewayBillingEventId: 'gw-event-1',
        requestId: 'gw-req-2',
        model: 'gpt-test',
        promptTokens: 1000,
        cachedInputTokens: 100,
        cacheWriteInputTokens: 50,
        completionTokens: 500,
        totalTokens: 1500,
        costUsd: expect.any(Prisma.Decimal),
      }),
    });
    expect(modelPricing.calculateCostQuote).toHaveBeenNthCalledWith(
      2,
      'gpt-test',
      1000,
      500,
      100,
      50,
      {
        productId: 'prod-payg',
        priceBasis: 'LIST',
        effectiveAt: expect.any(Date),
      },
    );
    const tokenUsageData = prisma.tokenUsage.create.mock.calls[0][0].data;
    expect(tokenUsageData.pricingTierKey).toBeNull();
    expect(tokenUsageData.inputPriceUsdPerM.toString()).toBe('350');
    expect(tokenUsageData.cachedInputPriceUsdPerM.toString()).toBe('350');
    expect(tokenUsageData.cacheWritePriceUsdPerM.toString()).toBe('350');
    expect(tokenUsageData.outputPriceUsdPerM.toString()).toBe('1050');
  });

  it('fails the settlement and releases pending idempotency when token usage cannot be recorded', async () => {
    const { service, prisma } = buildService();
    prisma.tokenUsage.create.mockRejectedValueOnce(new Error('token_usage insert failed'));

    await expect(service.deduct({
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
      source: 'gateway:us-east-1:openai:gpt-test',
      requestId: 'gw-token-usage-failed',
      idempotencyKey: 'gateway:request:gw-token-usage-failed',
      recordTokenUsage: true,
    })).rejects.toThrow('token_usage insert failed');

    expect(prisma.idempotencyKey.upsert).not.toHaveBeenCalledWith(expect.objectContaining({
      update: expect.objectContaining({ status: 'COMMITTED' }),
    }));
    expect(prisma.idempotencyKey.deleteMany).toHaveBeenCalledWith({
      where: {
        key: 'gateway:request:gw-token-usage-failed',
        scope: 'billing:usage:deduct',
        status: 'PENDING',
      },
    });
  });

  it('commits upstream-included token usage and idempotency in one transaction', async () => {
    const { service, prisma, subscriptionResolver } = buildService();
    subscriptionResolver.resolve.mockResolvedValueOnce({
      subscriptionId: 'sub-resale',
      planId: 'plan-resale',
      fulfillmentMode: 'provider_resale',
      providerEntitlementId: 'provider-entitlement-1',
      plan: { usageMultiplier: 1 },
    });

    const result = await service.deduct({
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'CREDITS',
      source: 'gateway:us-east-1:openai:gpt-test',
      requestId: 'gw-resale-1',
      idempotencyKey: 'gateway:request:gw-resale-1',
      recordTokenUsage: true,
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      upstreamIncluded: true,
      tokenUsageId: 'usage-1',
    }));
    expect((prisma as typeof prisma & { $transaction: jest.Mock }).$transaction).toHaveBeenCalled();
    expect(prisma.tokenUsage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        codingPlanEntitlementId: 'sub-resale',
        providerEntitlementId: 'provider-entitlement-1',
        customerChargePolicy: 'included_upstream',
        customerChargeUsd: expect.any(Prisma.Decimal),
        providerCostEstimateUsd: expect.any(Prisma.Decimal),
        costUsd: expect.any(Prisma.Decimal),
      }),
    });
    const tokenUsageData = prisma.tokenUsage.create.mock.calls[0][0].data;
    expect(tokenUsageData.costUsd.toString()).toBe('0');
    expect(tokenUsageData.customerChargeUsd.toString()).toBe('0');
    expect(tokenUsageData.providerCostEstimateUsd.toString()).toBe('1.25');
    expect(prisma.idempotencyKey.upsert).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        key_scope: {
          key: 'gateway:request:gw-resale-1',
          scope: 'billing:usage:deduct',
        },
      },
      update: expect.objectContaining({ status: 'COMMITTED' }),
    }));
  });

  it('records upstream-included token usage with zero prices when model pricing is missing', async () => {
    const { service, prisma, modelPricing, providerCostPricing, subscriptionResolver } = buildService();
    modelPricing.calculateCostQuote.mockRejectedValue(new NotFoundException('模型 "glm-4.7" 暂未开放 API 定价'));
    subscriptionResolver.resolve.mockResolvedValueOnce({
      subscriptionId: 'sub-resale',
      planId: 'plan-resale',
      fulfillmentMode: 'provider_resale',
      providerEntitlementId: 'provider-entitlement-1',
      plan: { usageMultiplier: 1 },
    });

    const result = await service.deduct({
      apiKeyId: 'key-1',
      modelName: 'glm-4.7',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'CREDITS',
      source: 'gateway:us-east-1:openai:glm-4.7',
      requestId: 'gw-resale-missing-pricing',
      idempotencyKey: 'gateway:request:gw-resale-missing-pricing',
      recordTokenUsage: true,
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      upstreamIncluded: true,
      tokenUsageId: 'usage-1',
    }));
    expect(providerCostPricing.quote).not.toHaveBeenCalled();
    expect(prisma.tokenUsage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        model: 'glm-4.7',
        customerChargePolicy: 'included_upstream',
        inputPriceUsdPerM: expect.any(Prisma.Decimal),
        cachedInputPriceUsdPerM: null,
        outputPriceUsdPerM: expect.any(Prisma.Decimal),
        costUsd: expect.any(Prisma.Decimal),
        customerChargeUsd: expect.any(Prisma.Decimal),
      }),
    });
    const tokenUsageData = prisma.tokenUsage.create.mock.calls[0][0].data;
    expect(tokenUsageData.inputPriceUsdPerM.toString()).toBe('0');
    expect(tokenUsageData.outputPriceUsdPerM.toString()).toBe('0');
    expect(tokenUsageData.costUsd.toString()).toBe('0');
    expect(tokenUsageData.customerChargeUsd.toString()).toBe('0');
    expect(tokenUsageData.providerCostEstimateUsd).toBeUndefined();
  });

  it('keeps upstream-included image usage at zero credits when customer image pricing is missing', async () => {
    const { service, prisma, modelPricing, providerCostPricing, subscriptionResolver } = buildService();
    modelPricing.calculateCostQuote.mockRejectedValue(
      new NotFoundException('模型 "resale-image" 暂未开放 API 定价'),
    );
    subscriptionResolver.resolve.mockResolvedValueOnce({
      subscriptionId: 'sub-resale-image',
      planId: 'plan-resale',
      fulfillmentMode: 'provider_resale',
      providerEntitlementId: 'provider-entitlement-image',
      plan: { usageMultiplier: 1 },
    });

    const result = await service.deduct({
      apiKeyId: 'key-1',
      modelName: 'resale-image',
      imageCount: 1,
      inputTokens: 0,
      outputTokens: 0,
      totalTokens: 0,
      billingUnit: 'CREDITS',
      source: 'gateway:us-east-1:provider:resale-image',
      requestId: 'gw-resale-image-missing-pricing',
      idempotencyKey: 'gateway:request:gw-resale-image-missing-pricing',
      recordTokenUsage: true,
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      upstreamIncluded: true,
      tokenUsageId: 'usage-1',
    }));
    expect(providerCostPricing.quote).not.toHaveBeenCalled();
    const usageData = prisma.tokenUsage.create.mock.calls[0][0].data;
    expect(usageData).toMatchObject({
      meter: 'image',
      quantity: 1,
      customerChargePolicy: 'included_upstream',
    });
    expect(usageData.costUsd.toString()).toBe('0');
    expect(usageData.customerChargeUsd.toString()).toBe('0');
    expect(usageData.providerCostEstimateUsd).toBeUndefined();
  });

  it('keeps PAYG missing model pricing as a settlement failure', async () => {
    const { service, modelPricing } = buildService();
    modelPricing.calculateCostQuote.mockResolvedValueOnce({
      costUsd: new Prisma.Decimal('1.25'),
      pricingTierKey: null,
      inputPriceUsdPerM: new Prisma.Decimal('1'),
      cachedInputPriceUsdPerM: null,
      cacheWritePriceUsdPerM: null,
      outputPriceUsdPerM: new Prisma.Decimal('2'),
    });
    modelPricing.calculateCostQuote.mockRejectedValue(new NotFoundException('模型 "glm-4.7" 暂未开放 API 定价'));

    await expect(service.deduct({
      apiKeyId: 'key-1',
      modelName: 'glm-4.7',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
      source: 'gateway:us-east-1:openai:glm-4.7',
      requestId: 'gw-payg-missing-pricing',
      idempotencyKey: 'gateway:request:gw-payg-missing-pricing',
      recordTokenUsage: true,
    })).rejects.toThrow('模型 "glm-4.7" 暂未开放 API 定价');
  });

  it('records platform package coding plan usage against the entitlement', async () => {
    const { service, prisma, subscriptionResolver } = buildService();
    subscriptionResolver.resolve.mockResolvedValueOnce({
      subscriptionId: 'ent-platform-1',
      entitlementKind: 'coding_plan_entitlement',
      codingPlanEntitlementId: 'ent-platform-1',
      planId: 'plan-platform',
      fulfillmentMode: 'platform_model_package',
      providerEntitlementId: null,
      plan: { usageMultiplier: 1 },
    });

    const result = await service.deduct({
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'CREDITS',
      source: 'gateway:us-east-1:openai:gpt-test',
      requestId: 'gw-platform-1',
      idempotencyKey: 'gateway:request:gw-platform-1',
      recordTokenUsage: true,
    });

    expect(result).toEqual(expect.objectContaining({
      success: true,
      tokenUsageId: 'usage-1',
    }));
    expect(prisma.tokenUsage.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        codingPlanEntitlementId: 'ent-platform-1',
        customerChargePolicy: 'subscription_credits',
      }),
    });
  });

  it('allows trusted delivered gateway settlement to drive PAYG balance negative', async () => {
    const built = buildService({
      __config: {
        BILLING_GATEWAY_USAGE_ALLOW_NEGATIVE_BALANCE: 'true',
      },
    });
    const { service, billingService } = built;
    billingService.getBalanceReportForUser.mockResolvedValue({
      tenantId: 'tenant-1',
      balanceCents: 0,
      balanceUsd: 0,
      accountBalanceCents: 0,
      accountBalanceUsd: 0,
      accountAvailableBalanceCents: 0,
      accountAvailableBalanceUsd: 0,
      billingAccountType: 'personal',
      creditLimitCents: 0,
      creditLimitUsd: 0,
      creditUsedCents: 0,
      creditUsedUsd: 0,
      creditRemainingCents: 0,
      creditRemainingUsd: 0,
    });

    const input: UsageDeductInput = {
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
      source: 'gateway:us-east-1:openai:gpt-test',
      requestId: 'gw-req-negative',
      idempotencyKey: 'gateway:request:gw-req-negative',
      eventOccurredAt: new Date('2026-07-01T00:00:00.000Z'),
      allowNegativeBalance: true,
    };
    const result = await service.settleDeliveredGatewayUsage(
      input,
      prepareGatewaySettlement(built, input),
    );

    expect(result.success).toBe(true);
    expect(billingService.deduct).toHaveBeenCalledWith(
      'user-1',
      '0.875',
      'gateway:us-east-1:openai:gpt-test',
      expect.objectContaining({
        productId: 'prod-payg',
        tenantId: 'tenant-1',
        allowNegativeBalance: false,
        allowTerminalSettlement: true,
        beforeBalanceTransaction: expect.any(Function),
        afterBalanceTransaction: expect.any(Function),
      }),
    );
  });

  it('rejects trusted delivered settlement without an immutable occurrence time', async () => {
    const { service, billingService } = buildService();

    await expect(service.settleDeliveredGatewayUsage({
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
      source: 'gateway:us-east-1:openai:gpt-test',
      requestId: 'gw-missing-occurred-at',
      idempotencyKey: 'gateway:request:gw-missing-occurred-at',
    })).rejects.toThrow('已交付 Gateway 用量结算必须提供 eventOccurredAt');

    expect(billingService.deduct).not.toHaveBeenCalled();
  });

  it('passes event occurrence to balance settlement and returns the frozen enterprise funding policy', async () => {
    const built = buildService({
      __config: {
        BILLING_GATEWAY_USAGE_ALLOW_NEGATIVE_BALANCE: 'true',
      },
    });
    const { service, billingService, balanceDeductState } = built;
    const occurredAt = new Date('2026-07-01T00:00:00.000Z');
    balanceDeductState.billingAccountType = 'enterprise';
    balanceDeductState.creditLimitUsd = '100';
    balanceDeductState.creditStatus = 'ACTIVE';
    balanceDeductState.creditTermsDays = 30;
    balanceDeductState.creditEffectiveAt = new Date('2026-06-01T00:00:00.000Z');
    balanceDeductState.creditExpiresAt = new Date('2026-08-01T00:00:00.000Z');
    balanceDeductState.creditPolicyAt = occurredAt;
    balanceDeductState.creditPolicySource = 'EVENT_OLD_STATE';
    balanceDeductState.collectedUsd = '0';
    balanceDeductState.approvedCreditUsd = '1.25';
    balanceDeductState.unapprovedDebtUsd = '0';

    const input: UsageDeductInput = {
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
      source: 'gateway:us-east-1:openai:gpt-test',
      requestId: 'gw-enterprise-frozen-policy',
      idempotencyKey: 'gateway:request:gw-enterprise-frozen-policy',
      eventOccurredAt: occurredAt,
      recordTokenUsage: true,
    };
    const result = await service.settleDeliveredGatewayUsage(
      input,
      prepareGatewaySettlement(built, input, { billingAccountType: 'enterprise' }),
    );

    expect(billingService.deduct).toHaveBeenCalledWith(
      'user-1',
      '1.25',
      'gateway:us-east-1:openai:gpt-test',
      expect.objectContaining({
        allowTerminalSettlement: true,
        fundingPolicyOccurrence: {
          gatewayStartAt: occurredAt,
          firstReceivedAt: new Date('2026-07-01T00:00:01.000Z'),
        },
      }),
    );
    expect(result).toEqual(expect.objectContaining({
      fundingOutcome: 'RECEIVABLE',
      fundingBreakdown: {
        collectedUsd: '0',
        approvedCreditUsd: '1.25',
        unapprovedDebtUsd: '0',
        debtExposureUsd: '0',
        approvedCreditTermsDays: 30,
        approvedCreditDueAt: '2026-07-31T00:00:00.000Z',
      },
      fundingPolicy: {
        accountType: 'enterprise',
        policyAt: '2026-07-01T00:00:00.000Z',
        policyRevision: null,
        source: 'EVENT_OLD_STATE',
        reconstructible: true,
        limitUsd: '100',
        status: 'ACTIVE',
        configuredTermsDays: 30,
        termsDays: 30,
        effectiveAt: '2026-06-01T00:00:00.000Z',
        expiresAt: '2026-08-01T00:00:00.000Z',
      },
    }));
    const tokenUsage = built.prisma.tokenUsage.create.mock.calls[0][0].data;
    expect(tokenUsage.customerChargePolicy).toBe('payg_balance');
    expect(tokenUsage.customerChargeUsd.toString()).toBe('1.25');
    expect(tokenUsage.customerCollectedUsd.toString()).toBe('0');
    expect(tokenUsage.customerApprovedReceivableUsd.toString()).toBe('1.25');
    expect(tokenUsage.customerUnapprovedDebtUsd.toString()).toBe('0');
    expect(tokenUsage.customerFundingClassificationComplete).toBe(true);
  });

  it.each([
    {
      label: 'cash only',
      collectedUsd: '1.25',
      approvedCreditUsd: '0',
      unapprovedDebtUsd: '0',
      workspaceBalanceUsd: '8.75',
    },
    {
      label: 'mixed cash and approved enterprise credit',
      collectedUsd: '0.25',
      approvedCreditUsd: '1',
      unapprovedDebtUsd: '0',
      workspaceBalanceUsd: '4',
    },
    {
      label: 'unapproved enterprise debt',
      collectedUsd: '0',
      approvedCreditUsd: '0',
      unapprovedDebtUsd: '1.25',
      workspaceBalanceUsd: '-1.25',
    },
  ])('keeps BALANCE policy stable for $label', async ({
    label: _label,
    collectedUsd,
    approvedCreditUsd,
    unapprovedDebtUsd,
    workspaceBalanceUsd,
  }) => {
    const built = buildService({
      __config: {
        BILLING_GATEWAY_USAGE_ALLOW_NEGATIVE_BALANCE: 'true',
      },
    });
    const { service, balanceDeductState } = built;
    const occurredAt = new Date('2026-07-01T00:00:00.000Z');
    balanceDeductState.billingAccountType = 'enterprise';
    balanceDeductState.creditLimitUsd = '5';
    balanceDeductState.creditStatus = 'ACTIVE';
    balanceDeductState.creditTermsDays = 30;
    balanceDeductState.creditPolicyAt = occurredAt;
    balanceDeductState.creditPolicySource = 'EVENT_NEW_STATE';
    balanceDeductState.collectedUsd = collectedUsd;
    balanceDeductState.approvedCreditUsd = approvedCreditUsd;
    balanceDeductState.unapprovedDebtUsd = unapprovedDebtUsd;
    balanceDeductState.workspaceBalanceUsd = workspaceBalanceUsd;
    balanceDeductState.accountBalanceUsd = workspaceBalanceUsd;

    const input: UsageDeductInput = {
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
      source: 'gateway:us-east-1:openai:gpt-test',
      requestId: `gw-enterprise-${_label.replaceAll(' ', '-')}`,
      idempotencyKey: `gateway:request:gw-enterprise-${_label.replaceAll(' ', '-')}`,
      eventOccurredAt: occurredAt,
      recordTokenUsage: true,
    };

    await service.settleDeliveredGatewayUsage(
      input,
      prepareGatewaySettlement(built, input, { billingAccountType: 'enterprise' }),
    );

    const tokenUsage = built.prisma.tokenUsage.create.mock.calls[0][0].data;
    expect(tokenUsage.customerChargePolicy).toBe('payg_balance');
    expect(tokenUsage.customerChargeUsd.toString()).toBe('1.25');
    expect(tokenUsage.customerCollectedUsd.toString()).toBe(collectedUsd);
    expect(tokenUsage.customerApprovedReceivableUsd.toString()).toBe(approvedCreditUsd);
    expect(tokenUsage.customerUnapprovedDebtUsd.toString()).toBe(unapprovedDebtUsd);
    expect(tokenUsage.customerFundingClassificationComplete).toBe(true);
  });

  it('keeps ordinary usage deduct strict when the terminal-settlement flag is enabled', async () => {
    const { service, billingService } = buildService({
      __config: {
        BILLING_GATEWAY_USAGE_ALLOW_NEGATIVE_BALANCE: 'true',
      },
    });
    billingService.getBalanceReportForUser.mockResolvedValue({
      tenantId: 'tenant-1',
      balanceCents: 0,
      balanceUsd: 0,
      accountBalanceCents: 0,
      accountBalanceUsd: 0,
      accountAvailableBalanceCents: 0,
      accountAvailableBalanceUsd: 0,
      billingAccountType: 'personal',
      creditLimitCents: 0,
      creditLimitUsd: 0,
      creditUsedCents: 0,
      creditUsedUsd: 0,
      creditRemainingCents: 0,
      creditRemainingUsd: 0,
    });

    const result = await service.deduct({
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
      source: 'gateway:us-east-1:openai:gpt-test',
      requestId: 'admin-ordinary-deduct',
      idempotencyKey: 'admin:ordinary-deduct',
      allowNegativeBalance: true,
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      allowed: false,
      reason: 'insufficient_balance',
    }));
    expect(billingService.deduct).not.toHaveBeenCalled();
  });

  describe('R6 self-op CREDITS terminal negative settlement (end-to-end wiring)', () => {
    const selfOpResolved = {
      subscriptionId: 'ent-selfop-1',
      entitlementKind: 'coding_plan_entitlement',
      codingPlanEntitlementId: 'ent-selfop-1',
      planId: 'plan-selfop',
      fulfillmentMode: 'platform_model_package',
      providerEntitlementId: null,
      plan: { usageMultiplier: 1 },
    };
    const insufficientBalances = { quota: 1, bonus: 0, grant: 0, total: 1 };
    const settleInput = {
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'CREDITS' as const,
      source: 'gateway:us-east-1:openai:gpt-test',
      requestId: 'gw-selfop-negative',
      idempotencyKey: 'gateway:request:gw-selfop-negative',
      eventOccurredAt: new Date('2026-07-01T00:00:00.000Z'),
      allowNegativeBalance: true,
      recordTokenUsage: true,
    };
    const selfOpAnchor = {
      codingPlanEntitlementId: 'ent-selfop-1',
      subscriptionId: 'ent-selfop-1',
      planId: 'plan-selfop',
    };

    afterEach(() => {
      setSelfopNegativeDeductOverride(null);
    });

    it('lets delivered trusted usage pass the authorize gate and reach deduct with allowNegativeBalance', async () => {
      // 抓过一次真 P0：authorize 对 CREDITS 不足会 early-return，若豁免子句只认 BALANCE，
      // 负额接线永远执行不到（死代码）。本用例端到端锁死该链路。
      setSelfopNegativeDeductOverride(true);
      const built = buildService({
        __config: { BILLING_GATEWAY_USAGE_ALLOW_NEGATIVE_BALANCE: 'true' },
      });
      const { service, subscriptionResolver, creditService } = built;
      subscriptionResolver.resolve.mockResolvedValueOnce(selfOpResolved);
      creditService.getAuthoritativeBalances.mockResolvedValueOnce(insufficientBalances);

      const result = await service.settleDeliveredGatewayUsage(
        settleInput,
        prepareGatewaySettlement(built, settleInput, selfOpAnchor),
      );

      expect(result).toEqual(expect.objectContaining({ success: true }));
      expect(creditService.deduct).toHaveBeenCalledTimes(1);
      expect(creditService.deduct.mock.calls[0][6]).toEqual(
        expect.objectContaining({ allowNegativeBalance: true }),
      );
    });

    it('books delivered usage as durable debt when negative credit deduction is disabled', async () => {
      const built = buildService({
        __config: { BILLING_GATEWAY_USAGE_ALLOW_NEGATIVE_BALANCE: 'true' },
      });
      const { service, prisma, providerCostPricing, subscriptionResolver, creditService } = built;
      subscriptionResolver.resolve.mockResolvedValueOnce(selfOpResolved);
      creditService.getAuthoritativeBalances.mockResolvedValueOnce(insufficientBalances);
      providerCostPricing.quote.mockResolvedValueOnce({
        policyId: 'provider-cost-1',
        priceMultiplier: new Prisma.Decimal(1),
        inputCostUsdPerM: new Prisma.Decimal('0.25'),
        cachedInputCostUsdPerM: null,
        cacheWriteInputCostUsdPerM: null,
        outputCostUsdPerM: new Prisma.Decimal('0.75'),
        costUsd: new Prisma.Decimal('0.625'),
      });

      const result = await service.settleDeliveredGatewayUsage(
        settleInput,
        prepareGatewaySettlement(built, settleInput, {
          ...selfOpAnchor,
          providerCostSnapshot: {
            status: 'VERIFIED',
            reason: null,
            policyId: 'provider-cost-frozen',
            providerCode: 'openai',
            providerLineId: null,
            productId: 'prod-payg',
            priceMultiplier: '1',
            inputCostUsdPerM: '0.25',
            cachedInputCostUsdPerM: '0.25',
            cacheWriteCostUsdPerM: '0.25',
            outputCostUsdPerM: '0.75',
            costUsd: '0.625',
          },
        }),
      );

      expect(result).toEqual(expect.objectContaining({
        success: false,
        allowed: false,
        reason: 'insufficient_credits',
        debtOpen: true,
        fundingOutcome: 'DEBT_OPEN',
        tokenUsageId: 'usage-1',
      }));
      expect(creditService.deduct).not.toHaveBeenCalled();
      const tokenUsage = prisma.tokenUsage.create.mock.calls[0][0].data;
      expect(tokenUsage.customerChargePolicy).toBe('debt_open');
      expect(tokenUsage.customerChargeUsd.toString()).toBe('1.25');
      expect(tokenUsage.customerCollectedUsd.toString()).toBe('0');
      expect(tokenUsage.customerApprovedReceivableUsd.toString()).toBe('0');
      expect(tokenUsage.customerUnapprovedDebtUsd.toString()).toBe('1.25');
      expect(tokenUsage.customerFundingClassificationComplete).toBe(true);
      expect(tokenUsage.providerCostEstimateUsd.toString()).toBe('0.000625');
      const receipt = prisma.gatewayUsageSettlementReceipt.create.mock.calls[0][0].data;
      expect(receipt.payload.customerFinancialAuthority).toEqual(expect.objectContaining({
        protocol: 'gateway-customer-financial-authority-v1',
        basis: 'NORMALIZED_EXACT',
        billingUnit: 'CREDITS',
        terminalClass: 'CREDITS_DEBT_OPEN',
        fundingOutcome: 'DEBT_OPEN',
        customerAmountUnit: 'CREDITS',
        originalCustomerAmount: '70',
        settledCustomerAmount: '70',
        originalCustomerChargeUsd: '1.250000000000',
        settledCustomerChargeUsd: '1.250000000000',
        originalDimensions: {
          inputTokens: 1000,
          outputTokens: 500,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          totalTokens: 1500,
          imageCount: 0,
        },
        settledDimensions: {
          inputTokens: 1000,
          outputTokens: 500,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          totalTokens: 1500,
          imageCount: 0,
        },
        tokenUsageId: 'usage-1',
      }));
    });

    it('leaves reseller provider_resale untouched with both switches on (includedUpstream, no credits deduct)', async () => {
      setSelfopNegativeDeductOverride(true);
      const built = buildService({
        __config: { BILLING_GATEWAY_USAGE_ALLOW_NEGATIVE_BALANCE: 'true' },
      });
      const { service, prisma, subscriptionResolver, creditService } = built;
      subscriptionResolver.resolve.mockResolvedValueOnce({
        ...selfOpResolved,
        subscriptionId: 'ent-resale-1',
        codingPlanEntitlementId: 'ent-resale-1',
        fulfillmentMode: 'provider_resale',
        providerEntitlementId: 'prov-1',
      });

      const input: UsageDeductInput = {
        ...settleInput,
        requestId: 'gw-resale-untouched',
        idempotencyKey: 'gateway:request:gw-resale-untouched',
      };
      const result = await service.settleDeliveredGatewayUsage(
        input,
        prepareGatewaySettlement(built, input, {
          ...selfOpAnchor,
          codingPlanEntitlementId: 'ent-resale-1',
          subscriptionId: 'ent-resale-1',
          entitlementSnapshot: {
            entitlementKind: 'coding_plan_entitlement',
            billingPeriod: 'MONTHLY',
            fulfillmentMode: 'provider_resale',
            providerEntitlementId: 'prov-1',
          },
        }),
      );

      expect(result).toEqual(expect.objectContaining({ success: true, upstreamIncluded: true }));
      expect(creditService.deduct).not.toHaveBeenCalled();
      const receipt = prisma.gatewayUsageSettlementReceipt.create.mock.calls[0][0].data;
      expect(receipt.payload.customerFinancialAuthority).toEqual(expect.objectContaining({
        protocol: 'gateway-customer-financial-authority-v1',
        basis: 'NORMALIZED_EXACT',
        billingUnit: 'CREDITS',
        terminalClass: 'CREDITS_INCLUDED',
        fundingOutcome: 'INCLUDED',
        customerAmountUnit: 'CREDITS',
        originalCustomerAmount: '0',
        settledCustomerAmount: '0',
        originalCustomerChargeUsd: '0.000000000000',
        settledCustomerChargeUsd: '0.000000000000',
        originalDimensions: {
          inputTokens: 1000,
          outputTokens: 500,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          totalTokens: 1500,
          imageCount: 0,
        },
        settledDimensions: {
          inputTokens: 1000,
          outputTokens: 500,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          totalTokens: 1500,
          imageCount: 0,
        },
        tokenUsageId: 'usage-1',
      }));
    });

    it('books generic subscription overage as debt without mutating credits', async () => {
      setSelfopNegativeDeductOverride(true);
      const built = buildService({
        __config: { BILLING_GATEWAY_USAGE_ALLOW_NEGATIVE_BALANCE: 'true' },
      });
      const { service, subscriptionResolver, creditService } = built;
      subscriptionResolver.resolve.mockResolvedValueOnce({
        subscriptionId: 'sub-generic-1',
        entitlementKind: 'subscription_period',
        codingPlanEntitlementId: null,
        planId: 'plan-generic',
        fulfillmentMode: null,
        providerEntitlementId: null,
        plan: { usageMultiplier: 1 },
      });
      creditService.getAuthoritativeBalances.mockResolvedValueOnce(insufficientBalances);

      const input: UsageDeductInput = {
        ...settleInput,
        requestId: 'gw-generic-not-exempt',
        idempotencyKey: 'gateway:request:gw-generic-not-exempt',
      };
      const result = await service.settleDeliveredGatewayUsage(
        input,
        prepareGatewaySettlement(built, input, {
          codingPlanEntitlementId: null,
          subscriptionId: 'sub-generic-1',
          planId: 'plan-generic',
          productBillingMode: 'SUBSCRIPTION',
          entitlementSnapshot: {
            entitlementKind: 'subscription_period',
            billingPeriod: 'MONTHLY',
            fulfillmentMode: null,
          },
        }),
      );

      expect(result).toEqual(expect.objectContaining({
        success: false,
        allowed: false,
        reason: 'insufficient_credits',
        debtOpen: true,
        fundingOutcome: 'DEBT_OPEN',
      }));
      expect(creditService.deduct).not.toHaveBeenCalled();
    });

    it('never exempts the ordinary untrusted deduct path even with both switches on', async () => {
      setSelfopNegativeDeductOverride(true);
      const { service, subscriptionResolver, creditService } = buildService({
        __config: { BILLING_GATEWAY_USAGE_ALLOW_NEGATIVE_BALANCE: 'true' },
      });
      subscriptionResolver.resolve.mockResolvedValueOnce(selfOpResolved);
      creditService.getAuthoritativeBalances.mockResolvedValueOnce(insufficientBalances);

      const result = await service.deduct(settleInput);

      expect(result).toEqual(expect.objectContaining({
        success: false,
        allowed: false,
        reason: 'insufficient_credits',
      }));
      expect(creditService.deduct).not.toHaveBeenCalled();
    });
  });

  it('closes the immutable anchored account after terminal exhaustion', async () => {
    const built = buildService({
      __config: {
        BILLING_GATEWAY_USAGE_ALLOW_NEGATIVE_BALANCE: 'true',
      },
    });
    const { service, billingService, balanceDeductState, publisherSync } = built;
    billingService.getBalanceReportForUser.mockResolvedValue({
      tenantId: 'tenant-1',
      balanceCents: 1,
      balanceUsd: 0.0115649,
      accountBalanceCents: -99,
      accountBalanceUsd: -0.9884351,
      accountAvailableBalanceCents: 1,
      accountAvailableBalanceUsd: 0.0115649,
      billingAccountType: 'enterprise',
      creditLimitCents: 100,
      creditLimitUsd: 1,
      creditUsedCents: 99,
      creditUsedUsd: 0.9884351,
      creditRemainingCents: 1,
      creditRemainingUsd: 0.0115649,
    });
    balanceDeductState.workspaceBalanceUsd = '-0.0328111';
    balanceDeductState.accountBalanceUsd = '-1.0328111';
    balanceDeductState.billingAccountId = 'ba-transaction-enterprise';

    const input: UsageDeductInput = {
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
      source: 'gateway:us-east-1:openai:gpt-test',
      requestId: 'gw-enterprise-terminal-overage',
      idempotencyKey: 'gateway:request:gw-enterprise-terminal-overage',
      eventOccurredAt: new Date('2026-07-01T00:00:00.000Z'),
      recordTokenUsage: true,
      allowNegativeBalance: true,
    };
    const result = await service.settleDeliveredGatewayUsage(
      input,
      prepareGatewaySettlement(built, input, {
        billingAccountId: 'ba-transaction-enterprise',
        billingAccountType: 'enterprise',
      }),
    );

    expect(result).toEqual(expect.objectContaining({
      success: true,
      balanceUsdAfter: -0.0328111,
      quote: expect.objectContaining({
        billingAccountId: 'ba-transaction-enterprise',
      }),
    }));
    expect(billingService.deduct).toHaveBeenCalledWith(
      'user-1',
      '1.25',
      'gateway:us-east-1:openai:gpt-test',
      expect.objectContaining({
        allowNegativeBalance: false,
        allowTerminalSettlement: true,
      }),
    );
    expect(publisherSync.syncBillingAccountKeyBalancesRequired)
      .toHaveBeenCalledWith('ba-transaction-enterprise');
    expect(publisherSync.syncBillingAccountKeyBalancesByKeyIdRequired)
      .not.toHaveBeenCalled();
    expect(publisherSync.syncKeyBalanceById).not.toHaveBeenCalled();
  });

  it('rejects delivered settlement without an apiKey-backed anchor', async () => {
    const { service, billingService, balanceDeductState, publisherSync } = buildService({
      __config: {
        BILLING_GATEWAY_USAGE_ALLOW_NEGATIVE_BALANCE: 'true',
      },
    });
    billingService.getBalanceReportForUser.mockResolvedValue({
      tenantId: 'tenant-1',
      balanceCents: 1,
      balanceUsd: 0.0115649,
      accountBalanceCents: -99,
      accountBalanceUsd: -0.9884351,
      accountAvailableBalanceCents: 1,
      accountAvailableBalanceUsd: 0.0115649,
      billingAccountType: 'enterprise',
      creditLimitCents: 100,
      creditLimitUsd: 1,
      creditUsedCents: 99,
      creditUsedUsd: 0.9884351,
      creditRemainingCents: 1,
      creditRemainingUsd: 0.0115649,
    });
    balanceDeductState.workspaceBalanceUsd = '-0.0328111';
    balanceDeductState.accountBalanceUsd = '-1.0328111';

    await expect(service.settleDeliveredGatewayUsage({
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-payg',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
      source: 'gateway:internal:openai:gpt-test',
      requestId: 'gw-enterprise-terminal-no-key',
      idempotencyKey: 'gateway:request:gw-enterprise-terminal-no-key',
      eventOccurredAt: new Date('2026-07-01T00:00:00.000Z'),
      recordTokenUsage: true,
      allowNegativeBalance: true,
    })).rejects.toThrow('首次收件 settlement anchor');

    expect(billingService.deduct).not.toHaveBeenCalled();
    expect(publisherSync.syncBillingAccountKeyBalancesRequired)
      .not.toHaveBeenCalled();
    expect(publisherSync.syncBillingAccountKeyBalancesByKeyIdRequired)
      .not.toHaveBeenCalled();
  });

  it('settles the original account after key, membership, owner, and tenant binding drift', async () => {
    const built = buildService({
      __config: {
        BILLING_GATEWAY_USAGE_ALLOW_NEGATIVE_BALANCE: 'true',
      },
    });
    const { service, prisma, billingService, publisherSync } = built;
    const input: UsageDeductInput = {
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
      source: 'gateway:internal:openai:gpt-test',
      requestId: 'gw-terminal-lazy-provision',
      idempotencyKey: 'gateway:request:gw-terminal-lazy-provision',
      eventOccurredAt: new Date('2026-07-01T00:00:00.000Z'),
      recordTokenUsage: true,
      allowNegativeBalance: true,
    };
    const context = prepareGatewaySettlement(built, input);
    prisma.apiKey.findUnique.mockResolvedValue({
      id: 'key-1',
      userId: 'replacement-owner',
      tenantId: 'tenant-replacement',
      productId: 'prod-replacement',
      codingPlanEntitlementId: null,
      deletedAt: new Date('2026-07-01T00:00:01.500Z'),
    });
    prisma.tenant.findUnique.mockResolvedValue({
      id: 'tenant-1',
      ownerUserId: 'replacement-owner',
      billingAccountId: 'ba-drifted',
    });
    prisma.tenantMember.findFirst.mockResolvedValue(null);

    await expect(service.settleDeliveredGatewayUsage(input, context))
      .resolves.toEqual(expect.objectContaining({ success: true }));

    expect(billingService.deduct).toHaveBeenCalledWith(
      'user-1',
      expect.any(String),
      input.source,
      expect.objectContaining({
        anchoredTenantId: 'tenant-1',
        anchoredBillingAccountId: 'ba-personal-1',
        frozenGatewaySubject: {
          userId: 'user-1',
          tenantId: 'tenant-1',
          billingAccountId: 'ba-personal-1',
        },
      }),
    );
    expect(publisherSync.syncBillingAccountKeyBalancesRequired)
      .not.toHaveBeenCalledWith('ba-drifted');
  });

  it('repeats required Publisher closure when an exhausted terminal settlement is replayed', async () => {
    const built = buildService();
    const { service, prisma, billingService, publisherSync } = built;
    const input: UsageDeductInput = {
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      billingUnit: 'BALANCE',
      source: 'gateway:us-east-1:openai:gpt-test',
      requestId: 'gw-terminal-replay',
      idempotencyKey: 'gateway:request:gw-terminal-replay',
      eventOccurredAt: new Date('2026-07-01T00:00:00.000Z'),
      recordTokenUsage: true,
      allowNegativeBalance: true,
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
          imageCount: 0,
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
    };
    const context = prepareGatewaySettlement(built, input);
    const legacyFingerprint = 'f'.repeat(64);
    const billingResult = {
      success: true,
      allowed: true,
      balanceCentsAfter: -3,
      balanceUsdAfter: -0.0328111,
      terminalSettlement: true,
      quote: {
        tenantId: 'tenant-1',
        billingAccountId: 'ba-personal-1',
      },
    };
    prisma.gatewayUsageSettlementReceipt.findUnique.mockResolvedValue({
      gatewayBillingEventId: context.gatewayBillingEventId,
      requestId: context.anchor.requestId,
      evidenceHash: context.evidenceHash,
      anchorHash: context.anchor.anchorHash,
      pricingHash: context.anchor.pricingHash,
      settlementFingerprint: legacyFingerprint,
      billingUnit: 'BALANCE',
      creditAmount: null,
      tokenUsageId: 'usage-legacy-balance',
      fundingOutcome: 'COLLECTED',
      policyVersion: 'gateway-settlement-v2',
      payload: {
        anchorHash: context.anchor.anchorHash,
        pricingHash: context.anchor.pricingHash,
        settlementFingerprint: legacyFingerprint,
        billingResult,
      },
    });

    const result = await service.settleDeliveredGatewayUsage(input, context);

    expect(result).toEqual(expect.objectContaining({
      success: true,
      balanceUsdAfter: -0.0328111,
    }));
    expect(billingService.deduct).not.toHaveBeenCalled();
    expect(publisherSync.syncBillingAccountKeyBalancesRequired)
      .toHaveBeenCalledWith('ba-personal-1');
    expect(publisherSync.syncBillingAccountKeyBalancesByKeyIdRequired)
      .not.toHaveBeenCalled();
  });

  it('replays a legacy v2 CREDITS receipt without re-deducting after authority rollout', async () => {
    const built = buildService();
    const { service, prisma, creditService } = built;
    const input: UsageDeductInput = {
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'CREDITS',
      source: 'gateway:us-east-1:openai:gpt-test',
      requestId: 'gw-legacy-v2-credits-replay',
      idempotencyKey: 'gateway:request:gw-legacy-v2-credits-replay',
      eventOccurredAt: new Date('2026-07-01T00:00:00.000Z'),
      recordTokenUsage: true,
      gatewayCustomerSettlement: {
        policyVersion: 'gateway-customer-settlement-v2',
        basis: 'NORMALIZED_EXACT',
        evidenceReason: 'none',
        originalDimensions: {
          inputTokens: 1000,
          outputTokens: 500,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          totalTokens: 1500,
          imageCount: 0,
        },
        settledDimensions: {
          inputTokens: 1000,
          outputTokens: 500,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          totalTokens: 1500,
          imageCount: 0,
        },
      },
    };
    const context = prepareGatewaySettlement(built, input);
    const legacyFingerprint = 'e'.repeat(64);
    const billingResult = {
      success: true,
      allowed: true,
      unit: 'CREDITS',
      quote: context.anchor.customerQuoteSnapshot,
      quotaCreditsAfter: 430,
      bonusCreditsAfter: 0,
      grantCreditsAfter: 0,
      totalCreditsAfter: 430,
      tokenUsageId: 'usage-legacy-credits',
    };
    prisma.gatewayUsageSettlementReceipt.findUnique.mockResolvedValue({
      gatewayBillingEventId: context.gatewayBillingEventId,
      requestId: context.anchor.requestId,
      evidenceHash: context.evidenceHash,
      anchorHash: context.anchor.anchorHash,
      pricingHash: context.anchor.pricingHash,
      settlementFingerprint: legacyFingerprint,
      billingUnit: 'CREDITS',
      creditAmount: 70,
      tokenUsageId: 'usage-legacy-credits',
      fundingOutcome: 'COLLECTED',
      policyVersion: 'gateway-settlement-v2',
      payload: {
        anchorHash: context.anchor.anchorHash,
        pricingHash: context.anchor.pricingHash,
        settlementFingerprint: legacyFingerprint,
        billingResult,
      },
    });

    await expect(service.settleDeliveredGatewayUsage(input, context))
      .resolves.toEqual(billingResult);

    expect(creditService.deduct).not.toHaveBeenCalled();
    expect(prisma.tokenUsage.create).not.toHaveBeenCalled();
  });

  it('fails closed when a permanent Gateway receipt uses an unknown policy version', async () => {
    const built = buildService();
    const { service, prisma, billingService } = built;
    const input: UsageDeductInput = {
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
      source: 'gateway:us-east-1:openai:gpt-test',
      requestId: 'gw-unknown-receipt-policy',
      idempotencyKey: 'gateway:request:gw-unknown-receipt-policy',
      eventOccurredAt: new Date('2026-07-01T00:00:00.000Z'),
      recordTokenUsage: true,
    };
    const context = prepareGatewaySettlement(built, input);
    prisma.gatewayUsageSettlementReceipt.findUnique.mockResolvedValue({
      gatewayBillingEventId: context.gatewayBillingEventId,
      requestId: context.anchor.requestId,
      evidenceHash: context.evidenceHash,
      anchorHash: context.anchor.anchorHash,
      pricingHash: context.anchor.pricingHash,
      settlementFingerprint: 'd'.repeat(64),
      billingUnit: 'BALANCE',
      creditAmount: null,
      tokenUsageId: 'usage-unknown-policy',
      fundingOutcome: 'COLLECTED',
      policyVersion: 'gateway-settlement-v99',
      payload: { billingResult: { success: true, allowed: true } },
    });

    await expect(service.settleDeliveredGatewayUsage(input, context))
      .rejects.toThrow('policy version 不受支持');
    expect(billingService.deduct).not.toHaveBeenCalled();
  });

  it('rejects a finite idempotency replay when the permanent financial receipt is missing', async () => {
    const built = buildService();
    const { service, prisma, billingService, publisherSync } = built;
    const input: UsageDeductInput = {
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      billingUnit: 'BALANCE',
      source: 'gateway:us-east-1:openai:gpt-test',
      requestId: 'gw-terminal-lock-replay',
      idempotencyKey: 'gateway:request:gw-terminal-lock-replay',
      eventOccurredAt: new Date('2026-07-01T00:00:00.000Z'),
      recordTokenUsage: true,
      allowNegativeBalance: true,
    };
    const context = prepareGatewaySettlement(built, input);
    prisma.idempotencyKey.findUnique.mockResolvedValue({
      key: input.idempotencyKey,
      scope: 'billing:usage:deduct',
      userId: 'user-1',
      status: 'COMMITTED',
      result: {
        success: true,
        allowed: true,
        balanceCentsAfter: -3,
        balanceUsdAfter: -0.0328111,
        terminalSettlement: true,
      },
      expiresAt: new Date(Date.now() + 60_000),
    });

    await expect(service.settleDeliveredGatewayUsage(input, context))
      .rejects.toThrow('缺少永久资金回执');
    expect(billingService.deduct).not.toHaveBeenCalled();
    expect(publisherSync.syncBillingAccountKeyBalancesByKeyIdRequired)
      .not.toHaveBeenCalled();
  });

  it('rejects negative PAYG settlement by default even when input requests it', async () => {
    const { service, billingService } = buildService();
    billingService.getBalanceReportForUser.mockResolvedValue({
      tenantId: 'tenant-1',
      balanceCents: 0,
      balanceUsd: 0,
      accountBalanceCents: 0,
      accountBalanceUsd: 0,
      accountAvailableBalanceCents: 0,
      accountAvailableBalanceUsd: 0,
      billingAccountType: 'personal',
      creditLimitCents: 0,
      creditLimitUsd: 0,
      creditUsedCents: 0,
      creditUsedUsd: 0,
      creditRemainingCents: 0,
      creditRemainingUsd: 0,
    });

    const result = await service.deduct({
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
      source: 'gateway:us-east-1:openai:gpt-test',
      requestId: 'gw-req-negative-default',
      idempotencyKey: 'gateway:request:gw-req-negative-default',
      allowNegativeBalance: true,
    });

    expect(result).toEqual(expect.objectContaining({
      success: false,
      allowed: false,
      reason: 'insufficient_balance',
    }));
    expect(billingService.deduct).not.toHaveBeenCalled();
  });

  it('reclaims expired legacy pending idempotency rows before processing', async () => {
    const { service, prisma } = buildService();
    prisma.idempotencyKey.findUnique.mockResolvedValueOnce({
      key: 'gateway:request:expired-pending',
      scope: 'billing:usage:deduct',
      userId: 'user-1',
      status: 'PENDING',
      result: {},
      expiresAt: new Date(Date.now() - 1000),
    });

    const result = await service.deduct({
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'BALANCE',
      source: 'gateway:us-east-1:openai:gpt-test',
      requestId: 'expired-pending',
      idempotencyKey: 'gateway:request:expired-pending',
    });

    expect(result.success).toBe(true);
    expect(prisma.idempotencyKey.delete).toHaveBeenCalledWith({
      where: {
        key_scope: {
          key: 'gateway:request:expired-pending',
          scope: 'billing:usage:deduct',
        },
      },
    });
  });

  it('creates a persistent pending idempotency row before CREDIT debit', async () => {
    const { service, prisma, creditService } = buildService();

    const result = await service.deduct({
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'CREDITS',
      source: 'gateway:us-east-1:openai:gpt-test',
      requestId: 'credit-1',
      idempotencyKey: 'gateway:request:credit-1',
    });

    expect(result.success).toBe(true);
    expect(prisma.idempotencyKey.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        key: 'gateway:request:credit-1',
        scope: 'billing:usage:deduct',
        status: 'PENDING',
      }),
    });
    expect(
      prisma.idempotencyKey.create.mock.invocationCallOrder[0],
    ).toBeLessThan(creditService.deduct.mock.invocationCallOrder[0]);
  });

  it('scopes persistent idempotency lookups so other billing flows cannot block usage deducts', async () => {
    const { service, prisma, creditService } = buildService();

    const result = await service.deduct({
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'CREDITS',
      source: 'gateway:us-east-1:openai:gpt-test',
      requestId: 'shared-key',
      idempotencyKey: 'shared-key',
    });

    expect(result.success).toBe(true);
    expect(prisma.idempotencyKey.findUnique).toHaveBeenCalledWith({
      where: {
        key_scope: {
          key: 'shared-key',
          scope: 'billing:usage:deduct',
        },
      },
    });
    expect(prisma.idempotencyKey.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        key: 'shared-key',
        scope: 'billing:usage:deduct',
        status: 'PENDING',
      }),
    });
    expect(creditService.deduct).toHaveBeenCalledTimes(1);
  });

  it('does not CREDIT debit while a persistent pending idempotency row is active', async () => {
    const { service, prisma, creditService } = buildService();
    prisma.idempotencyKey.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({
        key: 'gateway:request:credit-pending',
        scope: 'billing:usage:deduct',
        userId: 'user-1',
        status: 'PENDING',
        result: {},
        expiresAt: new Date(Date.now() + 60_000),
      });
    prisma.idempotencyKey.create.mockRejectedValueOnce({ code: 'P2002' });

    const result = await service.deduct({
      apiKeyId: 'key-1',
      modelName: 'gpt-test',
      inputTokens: 1000,
      outputTokens: 500,
      billingUnit: 'CREDITS',
      source: 'gateway:us-east-1:openai:gpt-test',
      requestId: 'credit-pending',
      idempotencyKey: 'gateway:request:credit-pending',
    });

    expect(result).toEqual({
      success: false,
      allowed: false,
      reason: 'idempotency_in_progress',
    });
    expect(creditService.deduct).not.toHaveBeenCalled();
  });
});
