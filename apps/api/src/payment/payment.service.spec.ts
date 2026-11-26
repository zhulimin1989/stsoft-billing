import { Test } from '@nestjs/testing';
import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Logger,
  NotFoundException,
  ServiceUnavailableException,
} from '@nestjs/common';
import { createHash } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { PaymentService } from './payment.service';
import { PaymentRepository } from './payment.repository';
import { AlertEventService } from '../alert-events/alert-events.service';
import {
  BillingService,
  RechargeBillingSubjectChangedError,
} from '../billing/billing.service';
import { SelfOpProrationSourceInvalidError } from '../billing/coding-plan-errors';
import { BoosterPackService } from '../billing/booster-pack.service';
import { CreditService } from '../billing/credit.service';
import { SystemConfigService } from '../billing/system-config.service';
import {
  WechatPayOrderOutcomeUnknownError,
  WechatPayService,
} from './wechat-pay.service';
import { AlipayService } from './alipay.service';
import { StripeService } from './stripe.service';
import { PaymentProviderRegistry } from './payment-provider-registry';
import { SubscriptionResolverService } from '../billing/subscription-resolver.service';
import { SubscriptionLifecycleService } from '../billing/subscription-lifecycle.service';
import { ProductSyncNotifier } from '../integration/product-sync-notifier';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { CampaignService } from '../campaign/campaign.service';
import { DiscountCodeService } from '../campaign/discount-code.service';
import { UserPurchaseVerificationClient } from './user-purchase-verification.client';
import { CodingPlanFulfillmentService } from './coding-plan-fulfillment.service';
import {
  RefundCompensationService,
  SelfOperatedCodingPlanRefundHoldRetryError,
} from './refund-compensation.service';
import { ProviderRefundSagaService } from './provider-refund-saga.service';
import { AlertEventCategory, AlertEventSeverity, BundleItemBillingType, CodingPlanFulfillmentMode, OrderItemStatus, OrderStatus, OrderType as PrismaOrderType, PayChannel, PaymentCheckoutInitState, ProductBillingMode, ProviderRefundIntentStatus, RefundCompensationTaskStatus } from '@prisma/client';
import { decrypt, encrypt } from '../common/utils/crypto';

const TEST_ENCRYPTION_KEY = 'ab'.repeat(32);

// ============================================================
// Test helpers
// ============================================================

function makeOrder(overrides: Record<string, unknown> = {}) {
  return {
    id: 'order-1',
    userId: 'user-1',
    tenantId: 'tenant-1',
    billingAccountId: 'ba-tenant-1',
    orderType: 'SUBSCRIPTION',
    planId: 'plan-1',
    boosterPackId: null,
    amountCents: 9900,
    originalAmountCents: 9900,
    currency: 'usd',
    status: OrderStatus.PENDING,
    channel: 'WECHAT',
    tradeNo: null,
    paidAt: null,
    completedAt: null,
    expiredAt: null,
    cancelledAt: null,
    refundedAt: null,
    refundReason: null,
    refundAmountCents: null,
    fulfillmentAttemptId: null,
    fulfillmentClaimedAt: null,
    idempotencyKey: null,
    partnerIdempotencyKey: null,
    idempotencyFingerprint: null,
    paymentProviderInstanceId: null,
    providerSubscriptionEndedAt: null,
    checkoutInitState: PaymentCheckoutInitState.NOT_STARTED,
    checkoutLeaseId: null,
    checkoutLeaseExpiresAt: null,
    checkoutContextEncrypted: null,
    checkoutProviderReference: null,
    checkoutPayUrlEncrypted: null,
    checkoutPayUrlExpiresAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
    plan: null,
    boosterPack: null,
    ...overrides,
  };
}

function makeProductIntegrationContext(allowedPaymentCallbackOrigins: string[] | null) {
  return {
    id: 'prod-1',
    slug: 'product-1',
    name: 'Product 1',
    billingMode: ProductBillingMode.SUBSCRIPTION,
    allowedPaymentCallbackOrigins,
  };
}

function canonicalizeForFingerprint(value: unknown): unknown {
  if (value === undefined) return undefined;
  if (value === null || typeof value !== 'object') return value;
  if (value instanceof Date) return value.toISOString();
  if (Array.isArray(value)) {
    return value.map((item) => {
      const normalized = canonicalizeForFingerprint(item);
      return normalized === undefined ? null : normalized;
    });
  }

  const record = value as Record<string, unknown>;
  const normalized: Record<string, unknown> = {};
  for (const key of Object.keys(record).sort()) {
    if (key === 'idempotencyKey') continue;
    const normalizedValue = canonicalizeForFingerprint(record[key]);
    if (normalizedValue !== undefined) {
      normalized[key] = normalizedValue;
    }
  }
  return normalized;
}

function orderFingerprint(userId: string, tenantId: string, dto: Record<string, unknown>): string {
  const orderType = dto.orderType ?? 'SUBSCRIPTION';
  const normalizedRequest = orderType === 'SUBSCRIPTION'
    ? {
        ...dto,
        billingPeriod: dto.billingPeriod ?? 'monthly',
      }
    : dto;
  return createHash('sha256')
    .update(JSON.stringify({
      version: 1,
      userId,
      tenantId,
      request: canonicalizeForFingerprint(normalizedRequest),
    }))
    .digest('hex');
}

function legacyOrderFingerprint(userId: string, tenantId: string, dto: Record<string, unknown>): string {
  return createHash('sha256')
    .update(JSON.stringify({
      version: 1,
      userId,
      tenantId,
      request: canonicalizeForFingerprint(dto),
    }))
    .digest('hex');
}

/**
 * Build a `findPlanWithPrice(id, currency)` mock return for tests.
 * price = usd monthly/quarterly/yearly synthesized from the plan, unless explicitly given.
 */
function planWithPrice(
  plan: Record<string, unknown> | null,
  priceOverride?: { currency: string; monthlyPrice: number; quarterlyPrice?: number; yearlyPrice: number } | null,
) {
  if (!plan) return null;
  const scopedPlan = {
    productId: 'prod-1',
    ...plan,
  };
  const mp = (plan as any).monthlyPrice ?? 0;
  const qp = (plan as any).quarterlyPrice ?? mp;
  const yp = (plan as any).yearlyPrice ?? mp;
  const price = priceOverride === null
    ? null
    : priceOverride ?? { currency: 'usd', monthlyPrice: mp, quarterlyPrice: qp, yearlyPrice: yp };
  return { plan: scopedPlan, price };
}

function makeBundleSkuForCheckout(overrides: Record<string, unknown> = {}) {
  return {
    id: 'bundle-1',
    code: 'A_B_YEARLY',
    name: 'A + B Yearly',
    description: '',
    currency: 'usd',
    billingPeriod: 'yearly',
    amountCents: 12900,
    originalAmountCents: 19900,
    startAt: null,
    endAt: null,
    maxUsesPerUser: 0,
    maxUsesTotal: 0,
    isActive: true,
    sortOrder: 0,
    createdAt: new Date(),
    updatedAt: new Date(),
    items: [
      {
        id: 'bundle-item-a',
        bundleSkuId: 'bundle-1',
        productId: 'prod-a',
        planId: 'plan-a',
        boosterPackId: null,
        billingType: BundleItemBillingType.SUBSCRIPTION,
        name: 'Product A Yearly',
        unitAmountCents: 9900,
        originalUnitAmountCents: 16900,
        quantity: 1,
        recurringInterval: 'year',
        validityDays: null,
        sortOrder: 0,
        createdAt: new Date(),
        updatedAt: new Date(),
        product: {
          id: 'prod-a',
          name: 'Product A',
          isActive: true,
          billingMode: ProductBillingMode.SUBSCRIPTION,
        },
        plan: { id: 'plan-a', name: 'A Pro', isActive: true },
        boosterPack: null,
      },
      {
        id: 'bundle-item-b',
        bundleSkuId: 'bundle-1',
        productId: 'prod-b',
        planId: 'plan-b',
        boosterPackId: null,
        billingType: BundleItemBillingType.ONE_TIME,
        name: 'Product B Access',
        unitAmountCents: 3000,
        originalUnitAmountCents: 3000,
        quantity: 1,
        recurringInterval: null,
        validityDays: 365,
        sortOrder: 1,
        createdAt: new Date(),
        updatedAt: new Date(),
        product: {
          id: 'prod-b',
          name: 'Product B',
          isActive: true,
          billingMode: ProductBillingMode.SUBSCRIPTION,
        },
        plan: { id: 'plan-b', name: 'B Access', isActive: true },
        boosterPack: null,
      },
    ],
    ...overrides,
  };
}

function makePrisma() {
  return {
    order: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      findMany: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      count: jest.fn(),
      aggregate: jest.fn(),
    },
    orderItem: {
      findMany: jest.fn(),
      createMany: jest.fn(),
      update: jest.fn(),
      updateMany: jest.fn(),
    },
    orderAuditLog: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
    },
    alertEvent: {
      create: jest.fn().mockResolvedValue({}),
      upsert: jest.fn().mockResolvedValue({}),
    },
    campaignRedemption: {
      findFirst: jest.fn().mockResolvedValue(null),
      create: jest.fn().mockResolvedValue({}),
    },
    discountCode: {
      findUnique: jest.fn().mockResolvedValue({
        id: 'dc1',
        isActive: true,
        maxUses: 0,
        maxUsesPerUser: 1,
        currentUses: 0,
      }),
      update: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    discountCodeRedemption: {
      findFirst: jest.fn().mockResolvedValue(null),
      count: jest.fn().mockResolvedValue(0),
      create: jest.fn().mockResolvedValue({}),
    },
    balanceTransaction: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    balanceGrant: {
      findUnique: jest.fn().mockResolvedValue(null),
    },
    plan: {
      findUnique: jest.fn(),
    },
    boosterPack: {
      findUnique: jest.fn(),
    },
    codingPlanEntitlement: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      findUnique: jest.fn().mockResolvedValue(null),
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
    },
    codingPlanProviderEntitlement: {
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    stripeEvent: {
      create: jest.fn().mockResolvedValue({}),
      findUnique: jest.fn().mockResolvedValue(null),
      update: jest.fn().mockResolvedValue({}),
    },
    stripeSubscriptionCancellationTask: {
      findUnique: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    providerRefundIntent: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    stripePaymentLedger: {
      findFirst: jest.fn().mockResolvedValue(null),
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({}),
      update: jest.fn().mockResolvedValue({}),
      upsert: jest.fn().mockResolvedValue({}),
    },
    user: {
      findUnique: jest.fn(),
    },
    userSubscription: {
      findFirst: jest.fn(),
      updateMany: jest.fn(),
    },
    subscriptionPeriod: {
      findFirst: jest.fn(),
      findUnique: jest.fn(),
    },
    product: {
      findUnique: jest.fn(),
      findFirst: jest.fn((args?: any) =>
        args?.where?.id ? Promise.resolve({ id: args.where.id }) : Promise.resolve(null),
      ),
      findMany: jest.fn().mockResolvedValue([{ id: 'payg-product-1' }]),
    },
    rechargeTier: {
      findMany: jest.fn().mockResolvedValue([]),
    },
    $executeRaw: jest.fn().mockResolvedValue(undefined),
    $transaction: jest.fn(),
  };
}

function makeDeps() {
  const prisma = makePrisma();
  const redis = {
    set: jest.fn().mockResolvedValue('OK'),
    del: jest.fn().mockResolvedValue(1),
    get: jest.fn().mockResolvedValue(null),
    eval: jest.fn().mockResolvedValue(1),
  };
  const paymentRepo = {
    findOrderById: jest.fn(),
    findOrderByIdAndUser: jest.fn(),
    findOrderStatusByIdAndUser: jest.fn(),
    // finding：自营订单 per-user 新增。默认非自营 → 走原当前工作区路径，既有用例不变。
    isSelfOpCodingPlanOrderOwnedByUser: jest.fn().mockResolvedValue(false),
    findOrderStatusOwnedByUser: jest.fn(),
    findOrderOwnedByUser: jest.fn(),
    findUserOrders: jest.fn(),
    countUserOrders: jest.fn(),
    findLegacyIdempotentOrder: jest.fn().mockResolvedValue(null),
    findPartnerIdempotentOrder: jest.fn().mockResolvedValue(null),
    migrateLegacyIdempotencyKey: jest.fn().mockResolvedValue(true),
    createOrder: jest.fn(),
    claimCheckoutInitialization: jest.fn().mockResolvedValue(true),
    completeCheckoutInitialization: jest.fn().mockImplementation(
      async (
        orderId: string,
        _leaseId: string,
        data: {
          tradeNo?: string | null;
          paymentProviderInstanceId?: string | null;
          checkoutPayUrlEncrypted: string;
          checkoutPayUrlExpiresAt: Date;
        },
      ) => makeOrder({
        id: orderId,
        tradeNo: data.tradeNo ?? null,
        paymentProviderInstanceId: data.paymentProviderInstanceId ?? null,
        checkoutProviderReference: data.tradeNo ?? null,
        checkoutInitState: PaymentCheckoutInitState.READY,
        checkoutPayUrlEncrypted: data.checkoutPayUrlEncrypted,
        checkoutPayUrlExpiresAt: data.checkoutPayUrlExpiresAt,
      }),
    ),
    releaseCheckoutInitialization: jest.fn().mockResolvedValue(true),
    markCheckoutOutcomeUnknown: jest.fn().mockResolvedValue(true),
    findPlanById: jest.fn(),
    findPlanWithPrice: jest.fn(),
    findBundleSkuForCheckout: jest.fn(),
  };
  const billingService = {
    deduct: jest.fn(),
    recharge: jest.fn(),
    rechargeWithBonus: jest.fn(),
    creditBonus: jest.fn(),
    refundBalance: jest.fn(),
    activateSubscription: jest.fn().mockResolvedValue({
      contractId: 'contract-renewal',
      periodId: 'sub-1',
      entitlementId: 'entitlement-renewal',
    }),
    getBalance: jest.fn(),
    resolvePersonalTenantIdForUser: jest.fn().mockResolvedValue('tenant-personal'),
    createCodingPlanEntitlement: jest.fn().mockResolvedValue({ id: 'entitlement-1' }),
    markCodingPlanEntitlementFailed: jest.fn().mockResolvedValue(undefined),
    attachCodingPlanProviderEntitlement: jest.fn().mockResolvedValue(undefined),
    provisionSelfOperatedEntitlement: jest.fn().mockResolvedValue({
      entitlement: { id: 'entitlement-self' },
      monthlyGrantNeeded: false,
      rebindFromEntitlementId: null,
    }),
    resyncCodingPlanEntitlementKeys: jest.fn().mockResolvedValue(undefined),
    resolveSubjectForUser: jest.fn(async (_userId: string, tenantId?: string | null) => ({
      tenantId: tenantId ?? 'tenant-1',
      billingAccountId: 'ba-tenant-1',
    })),
  };
  const boosterPackService = {
    findById: jest.fn(),
  };
  const creditService = {
    grantQuota: jest.fn(),
    addBonus: jest.fn(),
    deduct: jest.fn(),
    getBalances: jest.fn(),
    getAuthoritativeBalances: jest.fn(),
  };
  const systemConfigService = {
    get: jest.fn(),
    getDeploymentConfig: jest.fn().mockResolvedValue({
      version: '1',
      region: 'overseas',
      provider: 'auth0',
      currency: 'cny',
      defaultLanguage: 'en',
      oauth: {},
    }),
  };
  const wechatPayService = {
    createNativePay: jest.fn(),
    queryOrder: jest.fn(),
    refund: jest.fn(),
    queryRefund: jest.fn(),
  };
  const alipayService = {
    createPagePay: jest.fn(),
    verifyNotifySign: jest.fn(),
    refund: jest.fn(),
    queryRefund: jest.fn(),
  };
  const stripeService = {
    createOneTimeAmountOffCoupon: jest.fn(),
    createCheckoutSession: jest.fn(),
    createSubscription: jest.fn(),
    createMixedSubscriptionCheckout: jest.fn(),
    verifyWebhook: jest.fn(),
    refundViaSessionOrSubscription: jest.fn(),
    cancelSubscription: jest.fn(),
    prepareSubscriptionRefund: jest.fn().mockImplementation(
      async (subscriptionId: string, amountCents: number) => ({
        subscriptionId,
        invoiceId: 'in_refund_exact',
        amountCents,
      }),
    ),
    retrieveRefundStatus: jest.fn().mockResolvedValue('succeeded'),
    retrieveCheckoutLedgerSnapshot: jest.fn().mockImplementation(
      async (checkoutSessionId: string) => ({
        transactionType: 'payment',
        checkoutSessionId,
        subscriptionId: 'sub_123',
        invoiceId: 'in_checkout',
        amountCents: 9900,
        currency: 'usd',
        stripeStatus: 'paid',
      }),
    ),
    retrieveSubscriptionLedgerSnapshot: jest.fn(),
    retrieveRefundLedgerSnapshot: jest.fn().mockImplementation(
      async (refundId: string) => ({
        transactionType: 'refund',
        refundId,
        amountCents: -9900,
        currency: 'usd',
        stripeStatus: 'succeeded',
      }),
    ),
  };
  const paymentProviderRegistry = {
    selectInstance: jest.fn().mockResolvedValue(null),
    getInstanceCount: jest.fn().mockReturnValue(0),
    getInstanceById: jest.fn(),
    getInstances: jest.fn().mockResolvedValue([]),
  };
  paymentProviderRegistry.getInstanceById.mockImplementation(async (id: string) => {
    const lastSelection = paymentProviderRegistry.selectInstance.mock.results.at(-1);
    if (!lastSelection) return null;
    const selected = await lastSelection.value;
    return selected?.id === id ? selected : null;
  });
  const subscriptionResolver = {
    resolve: jest.fn(),
    invalidateCache: jest.fn(),
  };
  const subscriptionLifecycle = {
    closeActive: jest.fn().mockResolvedValue(1),
    closeActivationFamily: jest.fn().mockResolvedValue(true),
  };
  const productSync = {
    notifyCreditChanged: jest.fn().mockResolvedValue(undefined),
  };
  const config = {
    get: jest.fn((key: string): string | undefined => {
      if (key === 'PAYMENT_CALLBACK_ALLOWED_ORIGINS') return 'https://app.example.com';
      if (key === 'ENCRYPTION_KEY') return TEST_ENCRYPTION_KEY;
      return '';
    }),
  };
  const campaignService = {
    findBestActiveCampaign: jest.fn().mockResolvedValue(null),
  };
  const discountCodeService = {
    validateAndGet: jest.fn(),
  };
  const userPurchaseVerification = {
    assertCanPurchase: jest.fn().mockResolvedValue(undefined),
  };
  const codingPlanFulfillment = {
    fulfillSubscriptionOrder: jest.fn().mockResolvedValue('activated'),
  };
  const refundCompensation = {
    preflightOrderCompensation: jest.fn().mockResolvedValue(undefined),
    preflightUnusedSelfOperatedCodingPlanRefund: jest.fn(),
    assertUnusedSelfOperatedCodingPlanRefundHeld: jest.fn(),
    syncSelfOperatedCodingPlanRefundHoldRequired:
      jest.fn().mockResolvedValue(undefined),
    preflightStripeSubscriptionRefund: jest.fn().mockResolvedValue({
      refundedActivationIdempotencyKey:
        'checkout:order-1:activation',
      refundedSubscriptionPeriodId: 'period-order-1',
      originalGrantIdempotencyKey: 'checkout:order-1',
      initialActivationIdempotencyKey:
        'checkout:order-1:activation',
      renewalActivationIdempotencyPrefix:
        'stripe-renewal:order-1:',
      skipEntitlementCompensation: false,
    }),
    prepareAndRun: jest.fn().mockResolvedValue({
      complete: true,
      executed: 0,
      failed: 0,
      pending: 0,
      manualReview: 0,
    }),
  };
  let providerRefundIntent: any = null;
  const providerRefundSaga = {
    claimOrderAndPrepare: jest.fn().mockImplementation(async (input: any) => {
      const claimed = await prisma.order.updateMany({
        where: { id: input.orderId, status: input.fromStatus },
        data: {
          status: OrderStatus.REFUNDING,
          refundReason: input.reason,
          refundAmountCents: input.amountCents,
          fulfillmentAttemptId: null,
          fulfillmentClaimedAt: null,
        },
      });
      if (claimed.count !== 1) {
        throw new Error(
          `provider refund order claim conflict: ${input.orderId}`,
        );
      }
      providerRefundIntent = {
        id: 'provider-refund-intent-1',
        ...input,
        paymentProviderInstanceId:
          input.paymentProviderInstanceId ?? null,
        providerRefundId: null,
        providerStatus: null,
        providerAttemptedAt: null,
        providerConfirmedAt: null,
        attempts: 0,
        maxAttempts: 12,
        nextRunAt: new Date(),
        lockedAt: null,
        lockedBy: null,
        lastError: null,
        completedAt: null,
        createdAt: new Date(),
        updatedAt: new Date(),
        status: ProviderRefundIntentStatus.PREPARED,
      };
      return {
        intent: providerRefundIntent,
        hasRechargeWalletEffects:
          input.orderType === PrismaOrderType.RECHARGE
          && !input.skipRechargeBalanceCompensation,
      };
    }),
    findByOrderId: jest.fn().mockImplementation(async () => providerRefundIntent),
    findDue: jest.fn().mockResolvedValue([]),
    claim: jest.fn().mockImplementation(async () => {
      if (!providerRefundIntent) return null;
      const previousStatus = providerRefundIntent.status;
      providerRefundIntent = {
        ...providerRefundIntent,
        status: ProviderRefundIntentStatus.RUNNING,
        attempts: providerRefundIntent.attempts + 1,
        lockedBy: `lease-${providerRefundIntent.attempts + 1}`,
        lockedAt: new Date(),
      };
      return {
        task: providerRefundIntent,
        leaseId: providerRefundIntent.lockedBy,
        previousStatus,
      };
    }),
    recordProviderOutcome: jest.fn().mockImplementation(async (_claim: any, outcome: any) => {
      const status =
        outcome.state === 'SUCCEEDED'
          ? ProviderRefundIntentStatus.PROVIDER_SUCCEEDED
          : outcome.state === 'FAILED'
            ? ProviderRefundIntentStatus.PROVIDER_FAILED
            : ProviderRefundIntentStatus.PENDING_PROVIDER;
      providerRefundIntent = {
        ...providerRefundIntent,
        status,
        providerRefundId:
          outcome.refundId ?? providerRefundIntent.providerRefundId,
        providerStatus: outcome.providerStatus,
        providerConfirmedAt:
          outcome.state === 'SUCCEEDED' ? new Date() : null,
        lastError: outcome.error ?? null,
        lockedBy: null,
        lockedAt: null,
      };
      return status;
    }),
    releaseProviderSucceededForCompensationRetry: jest.fn(),
    markCompleted: jest.fn().mockImplementation(async () => {
      providerRefundIntent = {
        ...providerRefundIntent,
        status: ProviderRefundIntentStatus.COMPLETED,
      };
    }),
  };
  return {
    prisma, redis, paymentRepo, billingService, boosterPackService,
    creditService, systemConfigService, wechatPayService, alipayService,
    stripeService, paymentProviderRegistry, subscriptionResolver, subscriptionLifecycle, productSync, config,
    campaignService, discountCodeService, userPurchaseVerification, codingPlanFulfillment, refundCompensation,
    providerRefundSaga,
  };
}

async function buildService(deps: ReturnType<typeof makeDeps>) {
  const m = await Test.createTestingModule({
    providers: [
      PaymentService,
      { provide: PaymentRepository, useValue: deps.paymentRepo },
      { provide: BillingService, useValue: deps.billingService },
      { provide: BoosterPackService, useValue: deps.boosterPackService },
      { provide: CreditService, useValue: deps.creditService },
      { provide: SystemConfigService, useValue: deps.systemConfigService },
      { provide: WechatPayService, useValue: deps.wechatPayService },
      { provide: AlipayService, useValue: deps.alipayService },
      { provide: StripeService, useValue: deps.stripeService },
      { provide: PaymentProviderRegistry, useValue: deps.paymentProviderRegistry },
      { provide: SubscriptionResolverService, useValue: deps.subscriptionResolver },
      { provide: SubscriptionLifecycleService, useValue: deps.subscriptionLifecycle },
      { provide: ProductSyncNotifier, useValue: deps.productSync },
      { provide: PrismaService, useValue: deps.prisma },
      { provide: RedisService, useValue: deps.redis },
      { provide: ConfigService, useValue: deps.config },
      { provide: CampaignService, useValue: deps.campaignService },
      { provide: DiscountCodeService, useValue: deps.discountCodeService },
      { provide: RefundCompensationService, useValue: deps.refundCompensation },
      { provide: ProviderRefundSagaService, useValue: deps.providerRefundSaga },
      { provide: UserPurchaseVerificationClient, useValue: deps.userPurchaseVerification },
      { provide: CodingPlanFulfillmentService, useValue: deps.codingPlanFulfillment },
    ],
  }).compile();
  return m.get(PaymentService) as PaymentService;
}

function mockStripeCallbackEnv(deps: ReturnType<typeof makeDeps>) {
  deps.systemConfigService.getDeploymentConfig.mockResolvedValue({
    version: '1',
    region: 'overseas',
    provider: 'auth0',
    currency: 'usd',
    defaultLanguage: 'en',
    oauth: {},
  });
  deps.config.get.mockImplementation((key: string) => {
    if (key === 'PAYMENT_CALLBACK_ALLOWED_ORIGINS') return 'https://app.test,https://app.example.com';
    if (key === 'STRIPE_SUCCESS_URL') return 'https://app.test/payment/success';
    if (key === 'STRIPE_CANCEL_URL') return 'https://app.test/payment/cancel';
    if (key === 'ENCRYPTION_KEY') return TEST_ENCRYPTION_KEY;
    return '';
  });
}

function installCheckoutPersistence(deps: ReturnType<typeof makeDeps>, orderId = 'order-1') {
  let createdOrder: ReturnType<typeof makeOrder> | null = null;
  let persistedOrder: ReturnType<typeof makeOrder> | null = null;
  let createdData: Record<string, any> | null = null;
  let completedData: Record<string, any> | null = null;

  deps.paymentRepo.createOrder.mockImplementation(async (data: Record<string, any>) => {
    createdData = data;
    createdOrder = makeOrder({
      ...data,
      id: orderId,
      status: OrderStatus.PENDING,
      checkoutInitState: PaymentCheckoutInitState.NOT_STARTED,
      checkoutLeaseId: null,
      checkoutLeaseExpiresAt: null,
      checkoutPayUrlEncrypted: null,
      checkoutPayUrlExpiresAt: null,
      createdAt: new Date(),
    });
    return createdOrder;
  });
  deps.paymentRepo.completeCheckoutInitialization.mockImplementation(
    async (
      completedOrderId: string,
      _leaseId: string,
      data: Record<string, any>,
    ) => {
      completedData = data;
      persistedOrder = makeOrder({
        ...(createdOrder ?? {}),
        id: completedOrderId,
        tradeNo: data.tradeNo ?? null,
        paymentProviderInstanceId: data.paymentProviderInstanceId ?? null,
        checkoutProviderReference: data.tradeNo ?? null,
        checkoutInitState: PaymentCheckoutInitState.READY,
        checkoutLeaseId: null,
        checkoutLeaseExpiresAt: null,
        checkoutPayUrlEncrypted: data.checkoutPayUrlEncrypted,
        checkoutPayUrlExpiresAt: data.checkoutPayUrlExpiresAt,
      });
      return persistedOrder;
    },
  );

  return {
    createdOrder: () => createdOrder,
    createdData: () => createdData,
    completedData: () => completedData,
    persistedOrder: () => persistedOrder,
  };
}

// Helper to setup prisma.$transaction to execute the callback and capture audit logs
function setupPrismaTransaction(prisma: ReturnType<typeof makePrisma>) {
  prisma.$transaction.mockImplementation(async (arg: unknown) => {
    if (Array.isArray(arg)) {
      // Array form: [update, create]
      const results = await Promise.all(arg.map((p: Promise<unknown>) => p));
      return results;
    }
    if (typeof arg === 'function') {
      const tx = {
        $executeRaw: prisma.$executeRaw,
        order: {
          create: prisma.order.create,
          count: prisma.order.count,
          updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        },
        orderItem: {
          createMany: prisma.orderItem.createMany,
        },
        plan: prisma.plan,
        orderAuditLog: {
          create: jest.fn().mockResolvedValue({}),
        },
        stripeSubscriptionCancellationTask: {
          create: prisma.stripeSubscriptionCancellationTask.create,
        },
        discountCode: prisma.discountCode,
        discountCodeRedemption: prisma.discountCodeRedemption,
      };
      return arg(tx);
    }
    return arg;
  });
}

function setupStatefulOrderTransactions(
  deps: ReturnType<typeof makeDeps>,
  initialOrder: ReturnType<typeof makeOrder>,
) {
  let currentOrder: Record<string, any> = { ...initialOrder };
  deps.prisma.order.findUnique.mockImplementation(async () => ({ ...currentOrder }));
  deps.prisma.order.update.mockImplementation(async ({ data }: any) => {
    currentOrder = { ...currentOrder, ...data };
    return { ...currentOrder };
  });
  deps.prisma.order.updateMany.mockImplementation(async ({ where, data }: any) => {
    const expectedStatus = where?.status;
    if (typeof expectedStatus === 'string' && currentOrder.status !== expectedStatus) {
      return { count: 0 };
    }
    if (expectedStatus?.in && !expectedStatus.in.includes(currentOrder.status)) {
      return { count: 0 };
    }
    currentOrder = { ...currentOrder, ...data };
    return { count: 1 };
  });
  deps.prisma.$transaction.mockImplementation(async (arg: any) => {
    if (typeof arg !== 'function') return arg;
    const before = { ...currentOrder };
    try {
      return await arg({
        order: {
          updateMany: deps.prisma.order.updateMany,
          update: deps.prisma.order.update,
        },
        orderAuditLog: {
          create: deps.prisma.orderAuditLog.create,
        },
        stripeSubscriptionCancellationTask: {
          create: deps.prisma.stripeSubscriptionCancellationTask.create,
          updateMany:
            deps.prisma.stripeSubscriptionCancellationTask.updateMany,
        },
        balanceTransaction: deps.prisma.balanceTransaction,
        balanceGrant: deps.prisma.balanceGrant,
      });
    } catch (err) {
      currentOrder = before;
      throw err;
    }
  });
  return {
    getOrder: () => ({ ...currentOrder }),
    setStatus: (status: OrderStatus) => {
      currentOrder = { ...currentOrder, status };
    },
  };
}

// ============================================================
// createOrder — validation guards
// ============================================================
describe('PaymentService.createOrder — validation guards', () => {
  it('resolves the billing subject before checking tenant-aware purchase eligibility', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.userPurchaseVerification.assertCanPurchase.mockRejectedValueOnce(
      new ForbiddenException({ code: 'REALNAME_REQUIRED', message: '购买套餐前需完成实名认证' }),
    );

    await expect(
      service.createOrder(
        'u1',
        { orderType: 'RECHARGE', channel: 'WECHAT', amountCents: 1000 } as any,
        'tenant-1',
      ),
    ).rejects.toThrow(ForbiddenException);

    expect(deps.billingService.resolveSubjectForUser).toHaveBeenCalledWith(
      'u1',
      'tenant-1',
      { requireBillingRole: true, requireExplicitTenant: true },
    );
    expect(deps.userPurchaseVerification.assertCanPurchase).toHaveBeenCalledWith('u1', 'tenant-1');
  });

  it('fails closed when the resolved subject has no billing account', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.billingService.resolveSubjectForUser.mockResolvedValueOnce({
      tenantId: 'tenant-1',
      billingAccountId: null,
    } as any);

    await expect(
      service.createOrder(
        'u1',
        { orderType: 'RECHARGE', channel: 'WECHAT', amountCents: 1000 } as any,
        'tenant-1',
      ),
    ).rejects.toThrow('订单缺少明确账务账户');

    expect(deps.userPurchaseVerification.assertCanPurchase).not.toHaveBeenCalled();
    expect(deps.paymentRepo.createOrder).not.toHaveBeenCalled();
  });

  it('throws when SUBSCRIPTION uses BALANCE channel', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    await expect(
      service.createOrder('u1', { orderType: 'SUBSCRIPTION', channel: 'BALANCE', planId: 'p1' } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws when BOOSTER_PACK uses BALANCE channel', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    await expect(
      service.createOrder('u1', { orderType: 'BOOSTER_PACK', channel: 'BALANCE', boosterPackId: 'bp1' } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws when RECHARGE uses BALANCE channel', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    await expect(
      service.createOrder('u1', { orderType: 'RECHARGE', channel: 'BALANCE', amountCents: 1000 } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('returns 409 instead of a false-success replay when the existing payment is still PENDING', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const dto = {
      orderType: 'SUBSCRIPTION',
      channel: 'WECHAT',
      planId: 'plan-1',
      idempotencyKey: 'idem-key-1',
    };
    const existingOrder = makeOrder({
      idempotencyKey: 'idem-key-1',
      idempotencyFingerprint: orderFingerprint('u1', 'tenant-1', dto),
      tradeNo: 'trade-abc',
    });
    deps.prisma.order.findFirst.mockResolvedValue(existingOrder);

    await expect(service.createOrder('u1', dto as any))
      .rejects.toThrow(ConflictException);
    expect(deps.prisma.order.update).not.toHaveBeenCalled();
    expect(deps.paymentRepo.createOrder).not.toHaveBeenCalled();
  });

  it('does not detach the idempotency key from a PENDING order without tradeNo', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const dto = {
      orderType: 'RECHARGE',
      channel: 'WECHAT',
      amountCents: 1000,
      idempotencyKey: 'idem-pending-no-trade',
    };
    deps.prisma.order.findFirst.mockResolvedValue(makeOrder({
      orderType: 'RECHARGE',
      idempotencyKey: dto.idempotencyKey,
      idempotencyFingerprint: orderFingerprint('u1', 'tenant-1', dto),
      tradeNo: null,
      status: OrderStatus.PENDING,
    }));

    await expect(service.createOrder('u1', dto as any))
      .rejects.toThrow('已绑定订单 order-1');

    expect(deps.prisma.order.update).not.toHaveBeenCalled();
    expect(deps.paymentRepo.createOrder).not.toHaveBeenCalled();
  });

  it('keeps a FAILED request bound to its idempotency key and requires a new key', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const dto = {
      orderType: 'RECHARGE',
      channel: 'WECHAT',
      amountCents: 1000,
      idempotencyKey: 'idem-failed',
    };
    deps.prisma.order.findFirst.mockResolvedValue(makeOrder({
      orderType: 'RECHARGE',
      idempotencyKey: dto.idempotencyKey,
      idempotencyFingerprint: orderFingerprint('u1', 'tenant-1', dto),
      tradeNo: null,
      status: OrderStatus.FAILED,
    }));

    await expect(service.createOrder('u1', dto as any))
      .rejects.toThrow('已绑定失败订单 order-1');

    expect(deps.prisma.order.update).not.toHaveBeenCalled();
    expect(deps.paymentRepo.createOrder).not.toHaveBeenCalled();
  });

  it('rejects same idempotencyKey when the order payload fingerprint differs', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const originalDto = {
      orderType: 'SUBSCRIPTION',
      channel: 'WECHAT',
      planId: 'plan-1',
      idempotencyKey: 'idem-key-1',
    };
    deps.prisma.order.findFirst.mockResolvedValue(makeOrder({
      idempotencyKey: 'idem-key-1',
      idempotencyFingerprint: orderFingerprint('u1', 'tenant-1', originalDto),
      tradeNo: 'trade-abc',
    }));

    await expect(service.createOrder('u1', {
      ...originalDto,
      planId: 'plan-2',
    } as any)).rejects.toThrow(ConflictException);
    expect(deps.prisma.order.update).not.toHaveBeenCalled();
    expect(deps.paymentRepo.createOrder).not.toHaveBeenCalled();
  });

  it('rejects idempotent replay when the tenant is now bound to another billing account', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const dto = {
      orderType: 'RECHARGE',
      channel: 'WECHAT',
      amountCents: 1000,
      idempotencyKey: 'idem-account-drift',
    };
    deps.prisma.order.findFirst.mockResolvedValue(makeOrder({
      orderType: 'RECHARGE',
      billingAccountId: 'ba-old',
      idempotencyKey: dto.idempotencyKey,
      idempotencyFingerprint: orderFingerprint('u1', 'tenant-1', dto),
      tradeNo: 'trade-abc',
    }));

    await expect(service.createOrder('u1', dto as any, 'tenant-1'))
      .rejects.toThrow('幂等订单账务账户与当前主体不一致');

    expect(deps.paymentRepo.createOrder).not.toHaveBeenCalled();
  });

  it('rejects existing idempotency records that were created before fingerprint storage', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.prisma.order.findFirst.mockResolvedValue(makeOrder({
      idempotencyKey: 'legacy-idem-key',
      idempotencyFingerprint: null,
      tradeNo: 'trade-abc',
    }));

    await expect(service.createOrder('u1', {
      orderType: 'SUBSCRIPTION',
      channel: 'WECHAT',
      planId: 'plan-1',
      idempotencyKey: 'legacy-idem-key',
    } as any)).rejects.toThrow(ConflictException);
    expect(deps.paymentRepo.createOrder).not.toHaveBeenCalled();
  });

  it('idempotency lookup scopes by userId (cross-user key reuse does NOT leak orders)', async () => {
    // Regression for Codex High finding: lookup was using { idempotencyKey } only,
    // which let user B retrieve user A's order by guessing/copying the key.
    // After fix, the where clause MUST include userId.
    //
    // We only care here that the WHERE clause includes userId. Downstream
    // plan lookup throws NotFound because it's out of this test's scope;
    // we catch it and still assert the findFirst call.
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.prisma.order.findFirst.mockResolvedValue(null);

    await service
      .createOrder('u2', {
        orderType: 'SUBSCRIPTION',
        channel: 'WECHAT',
        planId: 'plan-1',
        idempotencyKey: 'idem-shared-key',
      } as any)
      .catch(() => {
        /* downstream plan lookup throws — not this test's concern */
      });

    expect(deps.prisma.order.findFirst).toHaveBeenCalledWith({
      where: { idempotencyKey: 'idem-shared-key', userId: 'u2', tenantId: 'tenant-1' },
    });
  });

  it('stores idempotency fingerprint when creating a new order', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.prisma.order.findFirst.mockResolvedValue(null);
    const plan = { id: 'plan-1', isActive: true, monthlyPrice: 9900, yearlyPrice: 9900, name: 'Pro' };
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue(planWithPrice(plan));
    deps.paymentRepo.createOrder.mockResolvedValue(makeOrder({
      idempotencyKey: 'idem-key-2',
      idempotencyFingerprint: 'stored',
      tradeNo: null,
    }));
    deps.wechatPayService.createNativePay.mockResolvedValue({ codeUrl: 'weixin://qr' });
    const dto = {
      orderType: 'SUBSCRIPTION',
      channel: 'WECHAT',
      planId: 'plan-1',
      billingPeriod: 'monthly',
      idempotencyKey: 'idem-key-2',
    };

    await service.createOrder('u1', dto as any);

    expect(deps.paymentRepo.createOrder).toHaveBeenCalledWith(expect.objectContaining({
      idempotencyKey: 'idem-key-2',
      idempotencyFingerprint: orderFingerprint('u1', 'tenant-1', dto),
    }));
  });

  it('maps a concurrent idempotency unique conflict to 409 after validating the winning order', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const dto = {
      orderType: 'RECHARGE',
      channel: 'WECHAT',
      amountCents: 1000,
      idempotencyKey: 'idem-concurrent',
    };
    const concurrentOrder = makeOrder({
      orderType: 'RECHARGE',
      idempotencyKey: dto.idempotencyKey,
      idempotencyFingerprint: orderFingerprint('u1', 'tenant-1', dto),
      billingAccountId: 'ba-tenant-1',
      status: OrderStatus.PENDING,
    });
    deps.prisma.order.findFirst
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(concurrentOrder);
    deps.paymentRepo.createOrder.mockRejectedValue({ code: 'P2002' });

    await expect(service.createOrder('u1', dto as any))
      .rejects.toThrow(ConflictException);

    expect(deps.prisma.order.findFirst).toHaveBeenLastCalledWith({
      where: {
        idempotencyKey: dto.idempotencyKey,
        userId: 'u1',
        tenantId: 'tenant-1',
      },
    });
    expect(deps.wechatPayService.createNativePay).not.toHaveBeenCalled();
  });

  it('throws when SUBSCRIPTION has no planId', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.prisma.order.findFirst.mockResolvedValue(null); // no idempotency match

    await expect(
      service.createOrder('u1', { orderType: 'SUBSCRIPTION', channel: 'WECHAT' } as any),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException when plan not found or inactive', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentRepo.findPlanById.mockResolvedValue(null);
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue(null);

    await expect(
      service.createOrder('u1', { orderType: 'SUBSCRIPTION', channel: 'WECHAT', planId: 'no-plan' } as any),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException when plan isActive=false', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const inactive = { id: 'p1', isActive: false, monthlyPrice: 999, yearlyPrice: 999, name: 'Old' };
    deps.paymentRepo.findPlanById.mockResolvedValue(inactive);
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue(planWithPrice(inactive));

    await expect(
      service.createOrder('u1', { orderType: 'SUBSCRIPTION', channel: 'WECHAT', planId: 'p1' } as any),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws BadRequestException when BOOSTER_PACK has no boosterPackId', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    await expect(
      service.createOrder('u1', { orderType: 'BOOSTER_PACK', channel: 'WECHAT' } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws NotFoundException when booster pack is not found', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.boosterPackService.findById.mockResolvedValue(null);

    await expect(
      service.createOrder('u1', { orderType: 'BOOSTER_PACK', channel: 'WECHAT', boosterPackId: 'bp1' } as any),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws NotFoundException when booster pack is inactive', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.boosterPackService.findById.mockResolvedValue({ id: 'bp1', isActive: false, priceCents: 500, name: 'Boost', productId: null });

    await expect(
      service.createOrder('u1', { orderType: 'BOOSTER_PACK', channel: 'WECHAT', boosterPackId: 'bp1' } as any),
    ).rejects.toThrow(NotFoundException);
  });

  it('throws when booster pack requires active subscription but user has none', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.boosterPackService.findById.mockResolvedValue({
      id: 'bp1', isActive: true, priceCents: 500, name: 'Boost', productId: 'p1',
    });
    deps.prisma.subscriptionPeriod.findFirst.mockResolvedValue(null);

    await expect(
      service.createOrder('u1', { orderType: 'BOOSTER_PACK', channel: 'WECHAT', boosterPackId: 'bp1' } as any),
    ).rejects.toThrow(BadRequestException);
    expect(deps.prisma.subscriptionPeriod.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'u1',
          tenantId: 'tenant-1',
          productId: 'p1',
          status: 'ACTIVE',
        }),
      }),
    );
  });

  it('does not let an active subscription in another tenant authorize a booster purchase', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.boosterPackService.findById.mockResolvedValue({
      id: 'bp1',
      isActive: true,
      priceCents: 500,
      name: 'Boost',
      productId: 'p1',
    });
    deps.prisma.subscriptionPeriod.findFirst.mockImplementation(
      async ({ where }: { where: { tenantId?: string } }) =>
        where.tenantId === 'tenant-a'
          ? { id: 'sub-team-a', status: 'ACTIVE' }
          : null,
    );

    await expect(
      service.createOrder(
        'u1',
        {
          orderType: 'BOOSTER_PACK',
          channel: 'WECHAT',
          boosterPackId: 'bp1',
        } as any,
        'tenant-b',
      ),
    ).rejects.toThrow(BadRequestException);

    expect(deps.prisma.subscriptionPeriod.findFirst).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          userId: 'u1',
          tenantId: 'tenant-b',
          productId: 'p1',
        }),
      }),
    );
  });

  it('proceeds to create order when booster pack has no productId (no sub check)', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    // Pack with no productId — skips subscription check
    deps.boosterPackService.findById.mockResolvedValue({
      id: 'bp2', isActive: true, priceCents: 500, name: 'Boost No Product', productId: null,
    });
    const order = makeOrder({ orderType: 'BOOSTER_PACK', channel: 'WECHAT', boosterPackId: 'bp2' });
    deps.paymentRepo.createOrder.mockResolvedValue(order);
    deps.wechatPayService.createNativePay.mockResolvedValue({ codeUrl: 'weixin://qr' });

    const result = await service.createOrder('u1', {
      orderType: 'BOOSTER_PACK', channel: 'WECHAT', boosterPackId: 'bp2',
    } as any);

    expect(result.payUrl).toBe('weixin://qr');
    // subscription findFirst should NOT have been called (no productId)
    expect(deps.prisma.subscriptionPeriod.findFirst).not.toHaveBeenCalled();
  });
});

// ============================================================
// createOrder — RECHARGE limits
// ============================================================
describe('PaymentService.createOrder — RECHARGE limits', () => {
  it('throws when recharge amount is below minimum', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.systemConfigService.get.mockResolvedValue({
      rechargeMinCents: 1000,
      rechargeMaxCents: 0,
      userDailyLimitCents: 0,
    });

    await expect(
      service.createOrder('u1', { orderType: 'RECHARGE', channel: 'WECHAT', amountCents: 500 } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws when recharge amount exceeds maximum', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.systemConfigService.get.mockResolvedValue({
      rechargeMinCents: 0,
      rechargeMaxCents: 10000,
      userDailyLimitCents: 0,
    });

    await expect(
      service.createOrder('u1', { orderType: 'RECHARGE', channel: 'WECHAT', amountCents: 15000 } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('throws when daily limit exceeded', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.systemConfigService.get.mockResolvedValue({
      rechargeMinCents: 0,
      rechargeMaxCents: 0,
      userDailyLimitCents: 5000,
    });
    deps.prisma.order.aggregate.mockResolvedValue({ _sum: { amountCents: 3000 } });

    await expect(
      service.createOrder('u1', { orderType: 'RECHARGE', channel: 'WECHAT', amountCents: 3000 } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('skips recharge amount and daily limits for domestic deployment', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.systemConfigService.getDeploymentConfig.mockResolvedValue({
      version: '2',
      region: 'domestic',
      provider: 'authing',
      currency: 'cny',
      defaultLanguage: 'zh',
      oauth: {},
    });
    deps.systemConfigService.get.mockImplementation(async (key: string) => {
      if (key === 'paymentConfig') {
        return {
          rechargeMinCents: 1000,
          rechargeMaxCents: 10000,
          userDailyLimitCents: 1,
        };
      }
      return null;
    });
    deps.paymentRepo.createOrder.mockResolvedValue(makeOrder({ orderType: 'RECHARGE', channel: 'WECHAT', amountCents: 100 }));
    deps.wechatPayService.createNativePay.mockResolvedValue({ codeUrl: 'weixin://qr' });

    const result = await service.createOrder(
      'u1',
      { orderType: 'RECHARGE', channel: 'WECHAT', amountCents: 100 } as any,
      'tenant-1',
    );

    expect(result.payUrl).toBe('weixin://qr');
    expect(deps.prisma.order.aggregate).not.toHaveBeenCalled();
    expect(deps.paymentRepo.createOrder).toHaveBeenCalledWith(expect.objectContaining({
      tenantId: 'tenant-1',
      billingAccountId: 'ba-tenant-1',
      orderType: 'RECHARGE',
    }));
  });

  it('rejects custom recharge amount with cents', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    await expect(
      service.createOrder('u1', { orderType: 'RECHARGE', channel: 'WECHAT', amountCents: 150 } as any),
    ).rejects.toThrow('自定义充值金额必须为整数');

    expect(deps.paymentRepo.createOrder).not.toHaveBeenCalled();
  });

  it('proceeds when daily limit not exceeded', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.systemConfigService.get.mockResolvedValue({
      rechargeMinCents: 0,
      rechargeMaxCents: 0,
      userDailyLimitCents: 10000,
    });
    deps.prisma.order.aggregate.mockResolvedValue({ _sum: { amountCents: 2000 } });
    deps.paymentRepo.createOrder.mockResolvedValue(makeOrder({ orderType: 'RECHARGE', channel: 'WECHAT' }));
    deps.wechatPayService.createNativePay.mockResolvedValue({ codeUrl: 'weixin://qr' });

    const result = await service.createOrder('u1', { orderType: 'RECHARGE', channel: 'WECHAT', amountCents: 3000 } as any);
    expect(result.payUrl).toBe('weixin://qr');
  });
});

// ============================================================
// createOrder — BALANCE channel
// NOTE: The BALANCE channel code block (lines ~152-175) in createOrder is
// currently unreachable because ALL three order types (SUBSCRIPTION,
// BOOSTER_PACK, RECHARGE) explicitly reject BALANCE channel before reaching
// that block. This is a SUSPECTED DEAD CODE / BUG in the implementation.
// We verify the blocking guards work correctly here.
// ============================================================
describe('PaymentService.createOrder — BALANCE channel guards', () => {
  it('SUBSCRIPTION + BALANCE throws BadRequestException', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    await expect(
      service.createOrder('u1', { orderType: 'SUBSCRIPTION', channel: 'BALANCE', planId: 'p1' } as any),
    ).rejects.toThrow(/套餐和加油包不支持余额支付/);
  });

  it('BOOSTER_PACK + BALANCE throws BadRequestException', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    await expect(
      service.createOrder('u1', { orderType: 'BOOSTER_PACK', channel: 'BALANCE', boosterPackId: 'bp1' } as any),
    ).rejects.toThrow(/套餐和加油包不支持余额支付/);
  });

  it('RECHARGE + BALANCE throws BadRequestException', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    await expect(
      service.createOrder('u1', { orderType: 'RECHARGE', channel: 'BALANCE', amountCents: 1000 } as any),
    ).rejects.toThrow(/余额充值不支持余额支付/);
  });
});

// ============================================================
// createOrder — external payment channels
// ============================================================
describe('PaymentService.createOrder — external channels', () => {
  function setupSubscriptionOrder(deps: ReturnType<typeof makeDeps>) {
    const plan = { id: 'plan-1', isActive: true, monthlyPrice: 9900, yearlyPrice: 9900, name: 'Pro' };
    deps.paymentRepo.findPlanById.mockResolvedValue(plan);
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue(planWithPrice(plan));
    const order = makeOrder({ channel: 'WECHAT' });
    deps.paymentRepo.createOrder.mockResolvedValue(order);
    return order;
  }

  it('creates WECHAT order and returns codeUrl as payUrl', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    setupSubscriptionOrder(deps);
    deps.wechatPayService.createNativePay.mockResolvedValue({ codeUrl: 'weixin://qr-1' });

    const result = await service.createOrder('u1', {
      orderType: 'SUBSCRIPTION',
      channel: 'WECHAT',
      planId: 'plan-1',
    } as any);

    expect(result.payUrl).toBe('weixin://qr-1');
    expect(deps.wechatPayService.createNativePay).toHaveBeenCalledWith(
      'order-1',
      9900,
      expect.stringContaining('Pro'),
      expect.any(Date),
    );
  });

  it('creates discounted order under advisory lock and counts pending reservations', async () => {
    const deps = makeDeps();
    setupPrismaTransaction(deps.prisma);
    const service = await buildService(deps);
    const plan = { id: 'plan-1', isActive: true, monthlyPrice: 9900, yearlyPrice: 9900, name: 'Pro' };
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue(planWithPrice(plan));
    deps.discountCodeService.validateAndGet.mockResolvedValue({
      code: {
        id: 'dc1',
        code: 'SAVE20',
        name: 'Save 20',
        discountType: 'percent_off',
        discountValue: 20,
        stripeCouponId: null,
      },
      originalAmountCents: 9900,
      amountAfterCents: 7920,
      amountSavedCents: 1980,
    });
    deps.prisma.order.create.mockResolvedValue(makeOrder({
      amountCents: 7920,
      discountCodeId: 'dc1',
      discountAmountCents: 1980,
      channel: 'WECHAT',
    }));
    deps.prisma.order.count.mockResolvedValue(0);
    deps.wechatPayService.createNativePay.mockResolvedValue({ codeUrl: 'weixin://discount' });

    const result = await service.createOrder('u1', {
      orderType: 'SUBSCRIPTION',
      channel: 'WECHAT',
      planId: 'plan-1',
      promoCode: 'save20',
    } as any);

    expect(result.payUrl).toBe('weixin://discount');
    expect(deps.prisma.$transaction).toHaveBeenCalled();
    expect(deps.prisma.order.count).toHaveBeenCalledWith({
      where: {
        discountCodeId: 'dc1',
        status: { in: [OrderStatus.PENDING, OrderStatus.PAID, OrderStatus.FULFILLING] },
      },
    });
    expect(deps.prisma.order.count).toHaveBeenCalledWith({
      where: {
        discountCodeId: 'dc1',
        status: OrderStatus.COMPLETED,
      },
    });
    expect(deps.prisma.order.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        amountCents: 7920,
        discountCodeId: 'dc1',
        discountAmountCents: 1980,
      }),
    });
    expect(deps.paymentRepo.createOrder).not.toHaveBeenCalled();
  });

  it('rejects discounted order creation when reservations already exhaust maxUses', async () => {
    const deps = makeDeps();
    setupPrismaTransaction(deps.prisma);
    const service = await buildService(deps);
    const plan = { id: 'plan-1', isActive: true, monthlyPrice: 9900, yearlyPrice: 9900, name: 'Pro' };
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue(planWithPrice(plan));
    deps.discountCodeService.validateAndGet.mockResolvedValue({
      code: {
        id: 'dc1',
        code: 'SAVE20',
        name: 'Save 20',
        discountType: 'percent_off',
        discountValue: 20,
        stripeCouponId: null,
      },
      originalAmountCents: 9900,
      amountAfterCents: 7920,
      amountSavedCents: 1980,
    });
    deps.prisma.discountCode.findUnique.mockResolvedValue({
      id: 'dc1',
      isActive: true,
      maxUses: 1,
      maxUsesPerUser: 0,
      currentUses: 0,
    });
    deps.prisma.order.count.mockResolvedValue(1);

    await expect(
      service.createOrder('u1', {
        orderType: 'SUBSCRIPTION',
        channel: 'WECHAT',
        planId: 'plan-1',
        promoCode: 'save20',
      } as any),
    ).rejects.toThrow(/使用完/);

    expect(deps.prisma.order.create).not.toHaveBeenCalled();
    expect(deps.wechatPayService.createNativePay).not.toHaveBeenCalled();
  });

  it('reserves provider resale plan stock under advisory lock when creating an order', async () => {
    const deps = makeDeps();
    setupPrismaTransaction(deps.prisma);
    const service = await buildService(deps);
    const product = {
      id: 'prod-resale',
      slug: 'resale',
      name: 'Provider Resale',
      billingMode: ProductBillingMode.CODING_PLAN,
      codingPlanFulfillmentMode: CodingPlanFulfillmentMode.provider_resale,
      isActive: true,
    };
    const plan = {
      id: 'plan-resale',
      productId: 'prod-resale',
      isActive: true,
      monthlyPrice: 9900,
      yearlyPrice: 9900,
      name: 'Provider Resale Pro',
      monthlyCredits: 0,
      product,
    };
    deps.prisma.plan.findUnique.mockResolvedValue({
      id: 'plan-resale',
      isActive: true,
      salesLimit: 2,
      product: {
        isActive: true,
        billingMode: ProductBillingMode.CODING_PLAN,
        codingPlanFulfillmentMode: CodingPlanFulfillmentMode.provider_resale,
      },
    });
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue(planWithPrice(plan));
    deps.prisma.order.count.mockResolvedValue(1);
    deps.prisma.order.create.mockResolvedValue(makeOrder({ id: 'order-resale', planId: 'plan-resale' }));
    deps.wechatPayService.createNativePay.mockResolvedValue({ codeUrl: 'weixin://resale' });
    deps.billingService.resolveSubjectForUser.mockImplementation(
      async (_userId: string, tenantId?: string | null) => ({
        tenantId: tenantId ?? 'tenant-enterprise',
        billingAccountId: tenantId === 'tenant-personal' ? 'ba-personal' : 'ba-enterprise',
      }),
    );

    const result = await service.createOrder('u1', {
      orderType: 'SUBSCRIPTION',
      channel: 'WECHAT',
      planId: 'plan-resale',
    } as any, 'tenant-enterprise');

    expect(result.payUrl).toBe('weixin://resale');
    expect(deps.prisma.$executeRaw).toHaveBeenCalled();
    expect(deps.prisma.order.count).toHaveBeenCalledWith({
      where: {
        planId: 'plan-resale',
        orderType: PrismaOrderType.SUBSCRIPTION,
        status: {
          in: [
            OrderStatus.PENDING,
            OrderStatus.PAID,
            OrderStatus.FULFILLING,
            OrderStatus.PARTIALLY_FULFILLED_REQUIRES_COMPENSATION,
            OrderStatus.COMPLETED,
          ],
        },
      },
    });
    expect(deps.prisma.order.create).toHaveBeenCalledWith({
      data: expect.objectContaining({ planId: 'plan-resale' }),
    });
    expect(deps.paymentRepo.createOrder).not.toHaveBeenCalled();
    expect(deps.userPurchaseVerification.assertCanPurchase).toHaveBeenCalledTimes(1);
    expect(deps.userPurchaseVerification.assertCanPurchase).toHaveBeenCalledWith(
      'u1',
      'tenant-personal',
    );
  });

  it('rejects provider resale plan checkout when stock is exhausted', async () => {
    const deps = makeDeps();
    setupPrismaTransaction(deps.prisma);
    const service = await buildService(deps);
    const product = {
      id: 'prod-resale',
      slug: 'resale',
      name: 'Provider Resale',
      billingMode: ProductBillingMode.CODING_PLAN,
      codingPlanFulfillmentMode: CodingPlanFulfillmentMode.provider_resale,
      isActive: true,
    };
    const plan = {
      id: 'plan-resale',
      productId: 'prod-resale',
      isActive: true,
      monthlyPrice: 9900,
      yearlyPrice: 9900,
      name: 'Provider Resale Pro',
      monthlyCredits: 0,
      product,
    };
    deps.prisma.plan.findUnique.mockResolvedValue({
      id: 'plan-resale',
      isActive: true,
      salesLimit: 1,
      product: {
        isActive: true,
        billingMode: ProductBillingMode.CODING_PLAN,
        codingPlanFulfillmentMode: CodingPlanFulfillmentMode.provider_resale,
      },
    });
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue(planWithPrice(plan));
    deps.prisma.order.count.mockResolvedValue(1);

    await expect(
      service.createOrder('u1', {
        orderType: 'SUBSCRIPTION',
        channel: 'WECHAT',
        planId: 'plan-resale',
      } as any),
    ).rejects.toThrow('该转售套餐已售罄');

    expect(deps.prisma.order.create).not.toHaveBeenCalled();
    expect(deps.paymentRepo.createOrder).not.toHaveBeenCalled();
    expect(deps.wechatPayService.createNativePay).not.toHaveBeenCalled();
  });

  it('creates ALIPAY order and returns page pay URL as payUrl', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const plan = { id: 'plan-1', isActive: true, monthlyPrice: 9900, yearlyPrice: 9900, name: 'Pro' };
    deps.paymentRepo.findPlanById.mockResolvedValue(plan);
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue(planWithPrice(plan));
    deps.paymentRepo.createOrder.mockResolvedValue(makeOrder({ channel: 'ALIPAY' }));
    deps.alipayService.createPagePay.mockResolvedValue({ url: 'https://openapi.alipay.com/gateway.do?method=alipay.trade.page.pay' });

    const result = await service.createOrder('u1', {
      orderType: 'SUBSCRIPTION',
      channel: 'ALIPAY',
      planId: 'plan-1',
      successUrl: 'https://app.example.com/payment/success',
    } as any);

    expect(result.payUrl).toBe('https://openapi.alipay.com/gateway.do?method=alipay.trade.page.pay');
    expect(deps.alipayService.createPagePay).toHaveBeenCalledWith(
      'order-1',
      9900,
      '购买套餐: Pro',
      undefined,
      'https://app.example.com/payment/success',
    );
  });

  it('rejects Alipay return URLs outside the allowlist', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const plan = { id: 'plan-1', isActive: true, monthlyPrice: 9900, yearlyPrice: 9900, name: 'Pro' };
    deps.paymentRepo.findPlanById.mockResolvedValue(plan);
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue(planWithPrice(plan));

    await expect(service.createOrder('u1', {
      orderType: 'SUBSCRIPTION',
      channel: 'ALIPAY',
      planId: 'plan-1',
      successUrl: 'https://evil.example/payment/success',
    } as any)).rejects.toThrow('successUrl 不在允许的支付回跳域名内');

    expect(deps.paymentRepo.createOrder).not.toHaveBeenCalled();
    expect(deps.alipayService.createPagePay).not.toHaveBeenCalled();
  });

  it('uses the partner product allowlist for Alipay return URL validation', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const plan = { id: 'plan-1', isActive: true, monthlyPrice: 9900, yearlyPrice: 9900, name: 'Pro' };
    deps.paymentRepo.findPlanById.mockResolvedValue(plan);
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue(planWithPrice(plan));
    deps.paymentRepo.createOrder.mockResolvedValue(makeOrder({ channel: 'ALIPAY' }));
    deps.alipayService.createPagePay.mockResolvedValue({ url: 'https://openapi.alipay.com/gateway.do' });

    await service.createOrder(
      'u1',
      {
        orderType: 'SUBSCRIPTION',
        channel: 'ALIPAY',
        planId: 'plan-1',
        successUrl: 'https://product.example.com/payment/success',
      } as any,
      undefined,
      makeProductIntegrationContext(['https://product.example.com']),
    );

    expect(deps.alipayService.createPagePay).toHaveBeenCalledWith(
      'order-1',
      9900,
      '购买套餐: Pro',
      undefined,
      'https://product.example.com/payment/success',
    );
  });

  it('does not use the global Alipay return URL for a product-managed policy', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const plan = { id: 'plan-1', isActive: true, monthlyPrice: 9900, yearlyPrice: 9900, name: 'Pro' };
    deps.paymentRepo.findPlanById.mockResolvedValue(plan);
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue(planWithPrice(plan));
    deps.config.get.mockImplementation((key: string) => {
      if (key === 'PAYMENT_CALLBACK_ALLOWED_ORIGINS') return 'https://product.example.com';
      if (key === 'ALIPAY_RETURN_URL') return 'https://product.example.com/payment/success';
      return '';
    });

    await expect(service.createOrder(
      'u1',
      {
        orderType: 'SUBSCRIPTION',
        channel: 'ALIPAY',
        planId: 'plan-1',
      } as any,
      undefined,
      makeProductIntegrationContext(['https://product.example.com']),
    )).rejects.toThrow('Alipay 回跳地址未配置');

    expect(deps.paymentRepo.createOrder).not.toHaveBeenCalled();
    expect(deps.alipayService.createPagePay).not.toHaveBeenCalled();
  });

  it('uses enabled Admin Alipay instance credentials and records the instance id', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const plan = {
      id: 'plan-1',
      productId: 'product-1',
      isActive: true,
      monthlyPrice: 9900,
      yearlyPrice: 9900,
      name: 'Pro',
    };
    deps.paymentProviderRegistry.selectInstance.mockResolvedValue({
      id: 'ppi_alipay_1',
      providerKey: 'alipay',
      name: 'Alipay Sandbox',
      config: {
        appId: '9021000164665533',
        privateKey: 'app-private-key',
        alipayPublicKey: 'alipay-public-key',
        notifyUrl: 'https://user.test/api/payment/notify/alipay',
        gateway: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
        keyType: 'PKCS8',
      },
      supportedTypes: ['product-1'],
      isActive: true,
      dailyLimitCents: 0,
    });
    deps.paymentRepo.findPlanById.mockResolvedValue(plan);
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue(planWithPrice(plan, {
      currency: 'cny',
      monthlyPrice: 9900,
      yearlyPrice: 9900,
    }));
    deps.paymentRepo.createOrder.mockResolvedValue(makeOrder({ channel: 'ALIPAY' }));
    deps.alipayService.createPagePay.mockResolvedValue({ url: 'https://openapi.alipay.com/gateway.do?order=admin' });

    const result = await service.createOrder('u1', {
      orderType: 'SUBSCRIPTION',
      channel: 'ALIPAY',
      planId: 'plan-1',
    } as any);

    expect(result.payUrl).toBe('https://openapi.alipay.com/gateway.do?order=admin');
    expect(deps.paymentProviderRegistry.selectInstance).toHaveBeenCalledWith('alipay', 'product-1');
    expect(deps.paymentRepo.createOrder).toHaveBeenCalledWith(expect.objectContaining({
      paymentProviderInstanceId: 'ppi_alipay_1',
    }));
    expect(deps.alipayService.createPagePay).toHaveBeenCalledWith(
      'order-1',
      9900,
      '购买套餐: Pro',
      expect.objectContaining({
        appId: '9021000164665533',
        gateway: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
        keyType: 'PKCS8',
      }),
      undefined,
    );
  });

  it('rejects ALIPAY order when active Admin instances do not support the product', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const plan = {
      id: 'plan-1',
      productId: 'product-1',
      isActive: true,
      monthlyPrice: 9900,
      yearlyPrice: 9900,
      name: 'Pro',
    };
    deps.paymentProviderRegistry.selectInstance.mockResolvedValue(null);
    deps.paymentProviderRegistry.getInstanceCount.mockReturnValue(1);
    deps.paymentRepo.findPlanById.mockResolvedValue(plan);
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue(planWithPrice(plan, {
      currency: 'cny',
      monthlyPrice: 9900,
      yearlyPrice: 9900,
    }));

    await expect(service.createOrder('u1', {
      orderType: 'SUBSCRIPTION',
      channel: 'ALIPAY',
      planId: 'plan-1',
    } as any)).rejects.toThrow('支付宝未启用当前产品或支付场景');

    expect(deps.paymentRepo.createOrder).not.toHaveBeenCalled();
    expect(deps.alipayService.createPagePay).not.toHaveBeenCalled();
  });

  it('creates STRIPE checkout session for non-subscription order and returns url', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentRepo.createOrder.mockResolvedValue(makeOrder({ orderType: 'RECHARGE', channel: 'STRIPE' }));
    deps.systemConfigService.get.mockResolvedValue(null); // no limits
    deps.prisma.user.findUnique.mockResolvedValue({ email: 'user@example.com' });
    mockStripeCallbackEnv(deps);
    deps.stripeService.createCheckoutSession.mockResolvedValue({
      sessionId: 'cs_1',
      url: 'https://checkout.stripe.com/pay/1',
    });

    const result = await service.createOrder('u1', {
      orderType: 'RECHARGE',
      channel: 'STRIPE',
      amountCents: 2000,
    } as any);

    expect(result.payUrl).toBe('https://checkout.stripe.com/pay/1');
    expect(deps.stripeService.createCheckoutSession).toHaveBeenCalled();
    expect(deps.paymentRepo.completeCheckoutInitialization).toHaveBeenCalledWith(
      'order-1',
      expect.any(String),
      expect.objectContaining({ tradeNo: 'cs_1' }),
    );
  });

  it('rejects STRIPE order when callback URLs are missing and not configured', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.systemConfigService.get.mockResolvedValue(null);
    deps.config.get.mockReturnValue(undefined);

    await expect(
      service.createOrder('u1', {
        orderType: 'RECHARGE',
        channel: 'STRIPE',
        amountCents: 2000,
      } as any),
    ).rejects.toThrow('Stripe 回跳地址未配置');

    expect(deps.paymentRepo.createOrder).not.toHaveBeenCalled();
    expect(deps.stripeService.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('uses enabled Admin Stripe instance credentials for checkout and records the instance id', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentProviderRegistry.selectInstance.mockResolvedValue({
      id: 'ppi_stripe_1',
      providerKey: 'stripe',
      name: 'Stripe Sandbox',
      config: { secretKey: 'sk_admin_123', webhookSecret: 'whsec_admin_123' },
      supportedTypes: [],
      isActive: true,
      dailyLimitCents: 0,
    });
    deps.paymentRepo.createOrder.mockResolvedValue(makeOrder({ orderType: 'RECHARGE', channel: 'STRIPE' }));
    deps.systemConfigService.get.mockResolvedValue(null);
    deps.prisma.user.findUnique.mockResolvedValue({ email: 'user@example.com' });
    mockStripeCallbackEnv(deps);
    deps.stripeService.createCheckoutSession.mockResolvedValue({
      sessionId: 'cs_admin',
      url: 'https://checkout.stripe.com/pay/admin',
    });

    const result = await service.createOrder('u1', {
      orderType: 'RECHARGE',
      channel: 'STRIPE',
      amountCents: 2000,
    } as any);

    expect(result.payUrl).toBe('https://checkout.stripe.com/pay/admin');
    expect(deps.paymentProviderRegistry.selectInstance).toHaveBeenCalledWith('stripe', 'payg-product-1');
    expect(deps.stripeService.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        credentials: {
          secretKey: 'sk_admin_123',
          webhookSecret: 'whsec_admin_123',
        },
      }),
    );
    expect(deps.paymentRepo.completeCheckoutInitialization).toHaveBeenCalledWith(
      'order-1',
      expect.any(String),
      expect.objectContaining({
        tradeNo: 'cs_admin',
        paymentProviderInstanceId: 'ppi_stripe_1',
      }),
    );
  });

  it('fails closed before creating a recurring Stripe SUBSCRIPTION checkout', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const plan = { id: 'plan-1', isActive: true, monthlyPrice: 2999, yearlyPrice: 2499, name: 'Pro Monthly' };
    deps.paymentRepo.findPlanById.mockResolvedValue(plan);
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue(planWithPrice(plan));
    deps.paymentRepo.createOrder.mockResolvedValue(makeOrder({ channel: 'STRIPE', orderType: 'SUBSCRIPTION' }));
    deps.prisma.user.findUnique.mockResolvedValue({ email: 'user@example.com' });
    mockStripeCallbackEnv(deps);
    deps.stripeService.createSubscription.mockResolvedValue({
      sessionId: 'cs_sub_1',
      url: 'https://checkout.stripe.com/sub/1',
    });

    await expect(service.createOrder('u1', {
      orderType: 'SUBSCRIPTION',
      channel: 'STRIPE',
      planId: 'plan-1',
    } as any)).rejects.toThrow(
      'Stripe 自动续费订阅暂不可用',
    );

    expect(deps.paymentRepo.createOrder).not.toHaveBeenCalled();
    expect(deps.stripeService.createSubscription).not.toHaveBeenCalled();
  });

  it('creates one-time Stripe Checkout for CODING_PLAN subscription orders', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const plan = {
      id: 'plan-token',
      productId: 'prod-token',
      isActive: true,
      monthlyPrice: 3600,
      quarterlyPrice: 3600,
      yearlyPrice: 3000,
      monthlyCredits: 1000,
      name: 'GLM Coding Pro',
      product: {
        id: 'prod-token',
        billingMode: ProductBillingMode.CODING_PLAN,
        codingPlanFulfillmentMode: CodingPlanFulfillmentMode.platform_model_package,
        isActive: true,
      },
    };
    deps.prisma.plan.findUnique.mockResolvedValue({
      product: {
        billingMode: ProductBillingMode.CODING_PLAN,
        codingPlanFulfillmentMode: CodingPlanFulfillmentMode.platform_model_package,
      },
    });
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue(planWithPrice(plan));
    deps.paymentRepo.createOrder.mockImplementation(async (data: any) =>
      makeOrder({ channel: 'STRIPE', orderType: 'SUBSCRIPTION', ...data }),
    );
    deps.prisma.user.findUnique.mockResolvedValue({ email: 'user@example.com' });
    mockStripeCallbackEnv(deps);
    deps.stripeService.createCheckoutSession.mockResolvedValue({
      sessionId: 'cs_token_1',
      url: 'https://checkout.stripe.com/pay/token',
    });
    // 自营套餐下单一律进 per-plan 锁事务（限量闸锁内重读 cap）；此处 cap=null（不限量）→ 放行建单。
    deps.prisma.$transaction.mockImplementation(async (cb: any) => cb({
      $executeRaw: deps.prisma.$executeRaw,
      plan: { findUnique: jest.fn().mockResolvedValue({ maxSellableQuantity: null }) },
      codingPlanEntitlement: { findMany: jest.fn().mockResolvedValue([]) },
      order: {
        findMany: jest.fn().mockResolvedValue([]),
        create: jest.fn().mockImplementation(async ({ data }: any) =>
          makeOrder({ channel: 'STRIPE', orderType: 'SUBSCRIPTION', ...data }),
        ),
      },
    }));

    const result = await service.createOrder('u1', {
      orderType: 'SUBSCRIPTION',
      channel: 'STRIPE',
      planId: 'plan-token',
      currency: 'usd',
      billingPeriod: 'quarterly',
    } as any);

    expect(result.payUrl).toBe('https://checkout.stripe.com/pay/token');
    expect(deps.stripeService.createSubscription).not.toHaveBeenCalled();
    expect(deps.stripeService.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({
        orderId: 'order-1',
        amountCents: 10800,
        currency: 'usd',
        description: expect.stringContaining('GLM Coding Pro'),
      }),
    );
    expect(deps.paymentRepo.completeCheckoutInitialization).toHaveBeenCalledWith(
      'order-1',
      expect.any(String),
      expect.objectContaining({ tradeNo: 'cs_token_1' }),
    );
  });

  it('自营限量：新客达上限 → 下单抛「已售罄」，不建单', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.prisma.order.findFirst.mockResolvedValue(null);
    const plan = {
      id: 'plan-limited', productId: 'prod-token', isActive: true,
      monthlyPrice: 9900, quarterlyPrice: 9900, yearlyPrice: 9900, monthlyCredits: 1000, name: 'Limited',
      product: {
        id: 'prod-token', billingMode: ProductBillingMode.CODING_PLAN,
        codingPlanFulfillmentMode: CodingPlanFulfillmentMode.platform_model_package, isActive: true,
      },
    };
    deps.prisma.plan.findUnique.mockResolvedValue({
      product: {
        billingMode: ProductBillingMode.CODING_PLAN,
        codingPlanFulfillmentMode: CodingPlanFulfillmentMode.platform_model_package,
      },
    });
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue(planWithPrice(plan));
    const orderCreate = jest.fn();
    deps.prisma.$transaction.mockImplementation(async (cb: any) => cb({
      $executeRaw: deps.prisma.$executeRaw,
      plan: { findUnique: jest.fn().mockResolvedValue({ maxSellableQuantity: 1 }) },
      // 已有 1 个其它 tenant 占用（ACTIVE），达到 cap=1
      codingPlanEntitlement: { findMany: jest.fn().mockResolvedValue([{ tenantId: 'tenant-other' }]) },
      order: { findMany: jest.fn().mockResolvedValue([]), create: orderCreate },
    }));

    await expect(service.createOrder('u1', {
      orderType: 'SUBSCRIPTION', channel: 'WECHAT', planId: 'plan-limited', currency: 'cny', billingPeriod: 'monthly',
    } as any)).rejects.toThrow('已售罄');
    expect(orderCreate).not.toHaveBeenCalled();
  });

  it('自营限量：持有者同套餐续订不占新份 → 达上限仍放行建单', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.prisma.order.findFirst.mockResolvedValue(null);
    const plan = {
      id: 'plan-limited', productId: 'prod-token', isActive: true,
      monthlyPrice: 9900, quarterlyPrice: 9900, yearlyPrice: 9900, monthlyCredits: 1000, name: 'Limited',
      product: {
        id: 'prod-token', billingMode: ProductBillingMode.CODING_PLAN,
        codingPlanFulfillmentMode: CodingPlanFulfillmentMode.platform_model_package, isActive: true,
      },
    };
    deps.prisma.plan.findUnique.mockResolvedValue({
      product: {
        billingMode: ProductBillingMode.CODING_PLAN,
        codingPlanFulfillmentMode: CodingPlanFulfillmentMode.platform_model_package,
      },
    });
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue(planWithPrice(plan));
    deps.wechatPayService.createNativePay.mockResolvedValue({ codeUrl: 'weixin://qr' });
    const orderCreate = jest.fn().mockImplementation(async ({ data }: any) =>
      makeOrder({ channel: 'WECHAT', orderType: 'SUBSCRIPTION', ...data }),
    );
    deps.prisma.$transaction.mockImplementation(async (cb: any) => cb({
      $executeRaw: deps.prisma.$executeRaw,
      plan: { findUnique: jest.fn().mockResolvedValue({ maxSellableQuantity: 1 }) },
      // 买家(个人 tenant=tenant-personal)已是持有者 → 续订放行
      codingPlanEntitlement: { findMany: jest.fn().mockResolvedValue([{ tenantId: 'tenant-personal' }]) },
      order: { findMany: jest.fn().mockResolvedValue([]), create: orderCreate },
    }));

    await service.createOrder('u1', {
      orderType: 'SUBSCRIPTION', channel: 'WECHAT', planId: 'plan-limited', currency: 'cny', billingPeriod: 'monthly',
    } as any);
    expect(orderCreate).toHaveBeenCalled();
  });

  it('fails closed before creating a recurring Stripe BUNDLE checkout', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.prisma.order.count.mockResolvedValue(0);
    deps.paymentRepo.findBundleSkuForCheckout.mockResolvedValue({
      id: 'bundle-1',
      code: 'A_B_YEARLY',
      name: 'A + B Yearly',
      description: '',
      currency: 'usd',
      billingPeriod: 'yearly',
      amountCents: 12900,
      originalAmountCents: 19900,
      startAt: null,
      endAt: null,
      maxUsesPerUser: 0,
      maxUsesTotal: 0,
      isActive: true,
      sortOrder: 0,
      createdAt: new Date(),
      updatedAt: new Date(),
      items: [
        {
          id: 'bundle-item-a',
          bundleSkuId: 'bundle-1',
          productId: 'prod-a',
          planId: 'plan-a',
          boosterPackId: null,
          billingType: BundleItemBillingType.SUBSCRIPTION,
          name: 'Product A Yearly',
          unitAmountCents: 9900,
          originalUnitAmountCents: 16900,
          quantity: 1,
          recurringInterval: 'year',
          validityDays: null,
          sortOrder: 0,
          createdAt: new Date(),
          updatedAt: new Date(),
          product: {
            id: 'prod-a',
            name: 'Product A',
            isActive: true,
            billingMode: ProductBillingMode.SUBSCRIPTION,
          },
          plan: { id: 'plan-a', name: 'A Pro', isActive: true },
          boosterPack: null,
        },
        {
          id: 'bundle-item-b',
          bundleSkuId: 'bundle-1',
          productId: 'prod-b',
          planId: 'plan-b',
          boosterPackId: null,
          billingType: BundleItemBillingType.ONE_TIME,
          name: 'Product B Access',
          unitAmountCents: 3000,
          originalUnitAmountCents: 3000,
          quantity: 1,
          recurringInterval: null,
          validityDays: 365,
          sortOrder: 1,
          createdAt: new Date(),
          updatedAt: new Date(),
          product: {
            id: 'prod-b',
            name: 'Product B',
            isActive: true,
            billingMode: ProductBillingMode.SUBSCRIPTION,
          },
          plan: { id: 'plan-b', name: 'B Access', isActive: true },
          boosterPack: null,
        },
      ],
    } as any);
    deps.prisma.$transaction.mockImplementation(async (cb: any) => cb({
      order: {
        create: jest.fn().mockResolvedValue(makeOrder({
          id: 'order-bundle',
          userId: 'u1',
          orderType: 'BUNDLE',
          bundleSkuId: 'bundle-1',
          amountCents: 12900,
          channel: 'STRIPE',
        })),
      },
      orderItem: {
        createMany: jest.fn().mockResolvedValue({ count: 2 }),
      },
    }));
    deps.prisma.user.findUnique.mockResolvedValue({ email: 'user@example.com' });
    mockStripeCallbackEnv(deps);
    deps.stripeService.createMixedSubscriptionCheckout.mockResolvedValue({
      sessionId: 'cs_bundle',
      url: 'https://checkout.stripe.com/bundle',
    });

    await expect(service.createOrder('u1', {
      orderType: 'BUNDLE',
      channel: 'STRIPE',
      bundleSkuId: 'bundle-1',
      currency: 'usd',
    } as any)).rejects.toThrow(
      'Stripe 自动续费订阅暂不可用',
    );

    expect(deps.prisma.$transaction).not.toHaveBeenCalled();
    expect(deps.stripeService.createMixedSubscriptionCheckout).not.toHaveBeenCalled();
  });

  it('rejects Coding Plan items before creating a bundle provider checkout', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const bundle = makeBundleSkuForCheckout() as any;
    bundle.items[0].product.billingMode = ProductBillingMode.CODING_PLAN;
    bundle.items[0].product.codingPlanFulfillmentMode =
      CodingPlanFulfillmentMode.platform_model_package;
    deps.paymentRepo.findBundleSkuForCheckout.mockResolvedValue(bundle);
    mockStripeCallbackEnv(deps);

    await expect(service.createOrder('u1', {
      orderType: 'BUNDLE',
      channel: 'STRIPE',
      bundleSkuId: 'bundle-1',
      currency: 'usd',
    } as any)).rejects.toThrow(
      '组合套餐暂不支持 Coding Plan 权益',
    );

    expect(deps.paymentRepo.createOrder).not.toHaveBeenCalled();
    expect(deps.stripeService.createMixedSubscriptionCheckout).not.toHaveBeenCalled();
  });

  it('rejects a bundle that would replace an existing active subscription', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentRepo.findBundleSkuForCheckout.mockResolvedValue(
      makeBundleSkuForCheckout() as any,
    );
    deps.prisma.subscriptionPeriod.findFirst.mockResolvedValue({
      id: 'existing-period',
    });
    mockStripeCallbackEnv(deps);

    await expect(service.createOrder('u1', {
      orderType: 'BUNDLE',
      channel: 'STRIPE',
      bundleSkuId: 'bundle-1',
      currency: 'usd',
    } as any)).rejects.toThrow(
      '组合套餐仅支持首次开通',
    );

    expect(deps.paymentRepo.createOrder).not.toHaveBeenCalled();
    expect(deps.stripeService.createMixedSubscriptionCheckout).not.toHaveBeenCalled();
  });

  it('rejects recurring BUNDLE before reservation checks or provider creation', async () => {
    const deps = makeDeps();
    setupPrismaTransaction(deps.prisma);
    const service = await buildService(deps);
    deps.paymentRepo.findBundleSkuForCheckout.mockResolvedValue(
      makeBundleSkuForCheckout({ maxUsesTotal: 1 }) as any,
    );
    deps.prisma.order.count.mockResolvedValueOnce(1);
    mockStripeCallbackEnv(deps);

    await expect(
      service.createOrder('u1', {
        orderType: 'BUNDLE',
        channel: 'STRIPE',
        bundleSkuId: 'bundle-1',
        currency: 'usd',
      } as any),
    ).rejects.toThrow('Stripe 自动续费订阅暂不可用');

    expect(deps.prisma.$executeRaw).not.toHaveBeenCalled();
    expect(deps.prisma.order.count).not.toHaveBeenCalled();
    expect(deps.prisma.order.create).not.toHaveBeenCalled();
    expect(deps.prisma.orderItem.createMany).not.toHaveBeenCalled();
    expect(deps.stripeService.createMixedSubscriptionCheckout).not.toHaveBeenCalled();
  });

  it('rejects recurring BUNDLE before per-user reservation checks', async () => {
    const deps = makeDeps();
    setupPrismaTransaction(deps.prisma);
    const service = await buildService(deps);
    deps.paymentRepo.findBundleSkuForCheckout.mockResolvedValue(
      makeBundleSkuForCheckout({ maxUsesPerUser: 1 }) as any,
    );
    deps.prisma.order.count.mockResolvedValueOnce(1);
    mockStripeCallbackEnv(deps);

    await expect(
      service.createOrder('u1', {
        orderType: 'BUNDLE',
        channel: 'STRIPE',
        bundleSkuId: 'bundle-1',
        currency: 'usd',
      } as any),
    ).rejects.toThrow('Stripe 自动续费订阅暂不可用');

    expect(deps.prisma.$executeRaw).not.toHaveBeenCalled();
    expect(deps.prisma.order.count).not.toHaveBeenCalled();
    expect(deps.prisma.order.create).not.toHaveBeenCalled();
    expect(deps.prisma.orderItem.createMany).not.toHaveBeenCalled();
    expect(deps.stripeService.createMixedSubscriptionCheckout).not.toHaveBeenCalled();
  });

  it('transitions the order to FAILED and rethrows ServiceUnavailableException', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const order = setupSubscriptionOrder(deps);
    const state = setupStatefulOrderTransactions(deps, order);
    deps.wechatPayService.createNativePay.mockRejectedValue(
      new ServiceUnavailableException('微信支付未配置'),
    );

    await expect(
      service.createOrder('u1', {
        orderType: 'SUBSCRIPTION',
        channel: 'WECHAT',
        planId: 'plan-1',
      } as any),
    ).rejects.toThrow(ServiceUnavailableException);

    expect(state.getOrder().status).toBe(OrderStatus.FAILED);
    expect(deps.prisma.orderAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'order-1',
        fromStatus: OrderStatus.PENDING,
        toStatus: OrderStatus.FAILED,
        detail: '微信支付未配置',
      }),
    });
  });

  it('transitions order to FAILED and rethrows non-ServiceUnavailable errors', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    setupSubscriptionOrder(deps);
    deps.wechatPayService.createNativePay.mockRejectedValue(new Error('network error'));

    deps.prisma.order.findUnique.mockResolvedValue(makeOrder());
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);

    await expect(
      service.createOrder('u1', {
        orderType: 'SUBSCRIPTION',
        channel: 'WECHAT',
        planId: 'plan-1',
      } as any),
    ).rejects.toThrow('network error');
  });
});

describe('PaymentService.createOrder — durable checkout recovery', () => {
  it('keeps a WeChat order retryable when the provider request outcome is unknown', async () => {
    const deps = makeDeps();
    installCheckoutPersistence(deps);
    const service = await buildService(deps);
    deps.wechatPayService.createNativePay.mockRejectedValue(
      new WechatPayOrderOutcomeUnknownError('socket timed out after request send'),
    );

    await expect(service.createOrder('u1', {
      orderType: 'RECHARGE',
      channel: 'WECHAT',
      amountCents: 1000,
      idempotencyKey: 'wechat-unknown-outcome',
    } as any)).rejects.toThrow(ServiceUnavailableException);

    expect(deps.paymentRepo.markCheckoutOutcomeUnknown).toHaveBeenCalledTimes(1);
    expect(deps.paymentRepo.releaseCheckoutInitialization).not.toHaveBeenCalled();
    expect(deps.prisma.orderAuditLog.create).not.toHaveBeenCalled();
  });

  it('queries and settles a durable outcome-unknown WeChat order before any re-create', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const dto = {
      orderType: 'RECHARGE',
      channel: 'WECHAT',
      amountCents: 1000,
      idempotencyKey: 'wechat-reconcile-paid',
    };
    const existing = makeOrder({
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba-tenant-1',
      orderType: PrismaOrderType.RECHARGE,
      amountCents: 1000,
      currency: 'cny',
      channel: PayChannel.WECHAT,
      idempotencyKey: dto.idempotencyKey,
      idempotencyFingerprint: orderFingerprint('u1', 'tenant-1', dto),
      checkoutInitState: PaymentCheckoutInitState.OUTCOME_UNKNOWN,
      checkoutContextEncrypted: encrypt(JSON.stringify({
        version: 1,
        channel: 'WECHAT',
        description: '余额充值 ¥10.00',
      }), TEST_ENCRYPTION_KEY),
    });
    deps.prisma.order.findFirst.mockResolvedValue(existing);
    deps.wechatPayService.queryOrder.mockResolvedValue({
      trade_state: 'SUCCESS',
      transaction_id: 'wx_tx_paid',
      amount: { total: 1000, currency: 'CNY' },
    });
    deps.paymentRepo.findOrderById.mockResolvedValue(existing);
    deps.redis.set.mockResolvedValue(null);
    deps.prisma.order.findUnique.mockResolvedValue(
      makeOrder({ ...existing, status: OrderStatus.PAID, tradeNo: 'wx_tx_paid' }),
    );

    await expect(service.createOrder('u1', dto as any)).resolves.toMatchObject({
      order: { id: 'order-1', status: OrderStatus.PAID },
      payUrl: null,
    });

    expect(deps.wechatPayService.queryOrder).toHaveBeenCalledWith('order-1');
    expect(deps.wechatPayService.createNativePay).not.toHaveBeenCalled();
    expect(deps.paymentRepo.completeCheckoutInitialization).not.toHaveBeenCalled();
    expect(deps.prisma.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          status: OrderStatus.PAID,
          tradeNo: 'wx_tx_paid',
        }),
      }),
    );
  });

  it('re-enters Native pay with the same order facts only after query confirms NOTPAY', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const dto = {
      orderType: 'RECHARGE',
      channel: 'WECHAT',
      amountCents: 1000,
      idempotencyKey: 'wechat-reconcile-notpay',
    };
    const existing = makeOrder({
      userId: 'u1',
      tenantId: 'tenant-1',
      billingAccountId: 'ba-tenant-1',
      orderType: PrismaOrderType.RECHARGE,
      amountCents: 1000,
      currency: 'cny',
      channel: PayChannel.WECHAT,
      idempotencyKey: dto.idempotencyKey,
      idempotencyFingerprint: orderFingerprint('u1', 'tenant-1', dto),
      checkoutInitState: PaymentCheckoutInitState.OUTCOME_UNKNOWN,
      checkoutContextEncrypted: encrypt(JSON.stringify({
        version: 1,
        channel: 'WECHAT',
        description: '余额充值 ¥10.00',
      }), TEST_ENCRYPTION_KEY),
    });
    deps.prisma.order.findFirst.mockResolvedValue(existing);
    deps.wechatPayService.queryOrder.mockResolvedValue({
      trade_state: 'NOTPAY',
    });
    deps.wechatPayService.createNativePay.mockResolvedValue({
      codeUrl: 'weixin://reissued-after-query',
    });

    await expect(service.createOrder('u1', dto as any)).resolves.toMatchObject({
      payUrl: 'weixin://reissued-after-query',
    });

    expect(deps.wechatPayService.queryOrder).toHaveBeenCalledWith('order-1');
    expect(deps.wechatPayService.createNativePay).toHaveBeenCalledWith(
      'order-1',
      1000,
      '余额充值 ¥10.00',
      expect.any(Date),
    );
  });

  it('keeps a Stripe order retryable because provider initialization is idempotent', async () => {
    const deps = makeDeps();
    installCheckoutPersistence(deps);
    const service = await buildService(deps);
    deps.prisma.user.findUnique.mockResolvedValue({ email: 'user@example.com' });
    mockStripeCallbackEnv(deps);
    deps.stripeService.createCheckoutSession.mockRejectedValue(
      new Error('connection reset after request send'),
    );

    await expect(service.createOrder('u1', {
      orderType: 'RECHARGE',
      channel: 'STRIPE',
      amountCents: 2000,
      idempotencyKey: 'stripe-unknown-outcome',
    } as any)).rejects.toThrow(ServiceUnavailableException);

    expect(deps.paymentRepo.releaseCheckoutInitialization).toHaveBeenCalledTimes(1);
    expect(deps.prisma.orderAuditLog.create).not.toHaveBeenCalled();
  });

  it('replays a persisted WECHAT QR URL after the HTTP response is lost', async () => {
    const deps = makeDeps();
    const persistence = installCheckoutPersistence(deps);
    const service = await buildService(deps);
    const dto = {
      orderType: 'RECHARGE',
      channel: 'WECHAT',
      amountCents: 1000,
      idempotencyKey: 'wechat-response-loss',
    };
    let replay = false;
    deps.prisma.order.findFirst.mockImplementation(async () =>
      replay ? persistence.persistedOrder() : null,
    );
    deps.wechatPayService.createNativePay.mockResolvedValue({ codeUrl: 'weixin://recoverable-qr' });

    await expect(service.createOrder('u1', dto as any)).resolves.toMatchObject({
      payUrl: 'weixin://recoverable-qr',
    });
    replay = true;
    deps.userPurchaseVerification.assertCanPurchase.mockRejectedValue(
      new ServiceUnavailableException('user-api unavailable'),
    );
    await expect(service.createOrder('u1', dto as any)).resolves.toMatchObject({
      payUrl: 'weixin://recoverable-qr',
    });
    expect(deps.wechatPayService.createNativePay).toHaveBeenCalledTimes(1);
    expect(deps.userPurchaseVerification.assertCanPurchase).toHaveBeenCalledTimes(1);
  });

  it('replays a persisted ALIPAY redirect URL after the HTTP response is lost', async () => {
    const deps = makeDeps();
    const persistence = installCheckoutPersistence(deps);
    const service = await buildService(deps);
    const dto = {
      orderType: 'RECHARGE',
      channel: 'ALIPAY',
      amountCents: 1000,
      idempotencyKey: 'alipay-response-loss',
    };
    let replay = false;
    deps.prisma.order.findFirst.mockImplementation(async () =>
      replay ? persistence.persistedOrder() : null,
    );
    deps.alipayService.createPagePay.mockResolvedValue({
      url: 'https://openapi.alipay.com/gateway.do?recover=1',
    });

    await expect(service.createOrder('u1', dto as any)).resolves.toMatchObject({
      payUrl: 'https://openapi.alipay.com/gateway.do?recover=1',
    });
    replay = true;
    await expect(service.createOrder('u1', dto as any)).resolves.toMatchObject({
      payUrl: 'https://openapi.alipay.com/gateway.do?recover=1',
    });
    expect(deps.alipayService.createPagePay).toHaveBeenCalledTimes(1);
  });

  it('replays a persisted STRIPE URL and returns the atomically stored session tradeNo', async () => {
    const deps = makeDeps();
    const persistence = installCheckoutPersistence(deps);
    const service = await buildService(deps);
    const dto = {
      orderType: 'RECHARGE',
      channel: 'STRIPE',
      amountCents: 2000,
      idempotencyKey: 'stripe-response-loss',
    };
    let replay = false;
    deps.prisma.order.findFirst.mockImplementation(async () =>
      replay ? persistence.persistedOrder() : null,
    );
    deps.prisma.user.findUnique.mockResolvedValue({ email: 'internal@example.com' });
    mockStripeCallbackEnv(deps);
    deps.stripeService.createCheckoutSession.mockResolvedValue({
      sessionId: 'cs_recoverable',
      url: 'https://checkout.stripe.com/pay/recoverable',
    });

    const first = await service.createOrder('u1', dto as any);
    replay = true;
    const second = await service.createOrder('u1', dto as any);

    expect(first.order.tradeNo).toBe('cs_recoverable');
    expect(second).toMatchObject({
      payUrl: 'https://checkout.stripe.com/pay/recoverable',
      order: { tradeNo: 'cs_recoverable' },
    });
    expect(deps.stripeService.createCheckoutSession).toHaveBeenCalledTimes(1);
  });

  it('stores callback context and checkout URL only as ciphertext', async () => {
    const deps = makeDeps();
    const persistence = installCheckoutPersistence(deps);
    const service = await buildService(deps);
    deps.prisma.user.findUnique.mockResolvedValue({ email: 'user@example.com' });
    mockStripeCallbackEnv(deps);
    deps.stripeService.createCheckoutSession.mockResolvedValue({
      sessionId: 'cs_ciphertext',
      url: 'https://checkout.stripe.com/pay/plaintext-must-not-leak',
    });

    await service.createOrder('u1', {
      orderType: 'RECHARGE',
      channel: 'STRIPE',
      amountCents: 2000,
      idempotencyKey: 'ciphertext-only',
    } as any);

    const contextCiphertext = persistence.createdData()?.checkoutContextEncrypted;
    const payUrlCiphertext = persistence.completedData()?.checkoutPayUrlEncrypted;
    expect(contextCiphertext).toEqual(expect.any(String));
    expect(payUrlCiphertext).toEqual(expect.any(String));
    expect(contextCiphertext).not.toContain('https://');
    expect(payUrlCiphertext).not.toContain('https://');
    expect(JSON.parse(decrypt(contextCiphertext, TEST_ENCRYPTION_KEY))).toMatchObject({
      stripe: {
        successUrl: 'https://app.test/payment/success',
        cancelUrl: 'https://app.test/payment/cancel',
      },
    });
    expect(decrypt(payUrlCiphertext, TEST_ENCRYPTION_KEY)).toBe(
      'https://checkout.stripe.com/pay/plaintext-must-not-leak',
    );
  });

  it('allows only one concurrent caller to initialize the same checkout lease', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const dto = {
      orderType: 'RECHARGE',
      channel: 'WECHAT',
      amountCents: 1000,
      idempotencyKey: 'concurrent-checkout',
    };
    const contextCiphertext = encrypt(JSON.stringify({
      version: 1,
      channel: 'WECHAT',
      description: '余额充值 ¥10.00',
    }), TEST_ENCRYPTION_KEY);
    const existing = makeOrder({
      userId: 'u1',
      orderType: 'RECHARGE',
      channel: 'WECHAT',
      amountCents: 1000,
      idempotencyKey: dto.idempotencyKey,
      idempotencyFingerprint: orderFingerprint('u1', 'tenant-1', dto),
      checkoutInitState: PaymentCheckoutInitState.NOT_STARTED,
      checkoutContextEncrypted: contextCiphertext,
    });
    deps.prisma.order.findFirst.mockResolvedValue(existing);
    let claimed = false;
    deps.paymentRepo.claimCheckoutInitialization.mockImplementation(async () => {
      if (claimed) return false;
      claimed = true;
      return true;
    });
    deps.prisma.order.findUnique.mockResolvedValue(makeOrder({
      ...existing,
      checkoutInitState: PaymentCheckoutInitState.INITIALIZING,
      checkoutLeaseExpiresAt: new Date(Date.now() + 60_000),
    }));
    let releaseProvider!: (value: { codeUrl: string }) => void;
    deps.wechatPayService.createNativePay.mockReturnValue(new Promise((resolve) => {
      releaseProvider = resolve;
    }));

    const first = service.createOrder('u1', dto as any);
    await new Promise<void>((resolve) => setImmediate(resolve));
    const second = service.createOrder('u1', dto as any);
    await expect(second).rejects.toThrow(ConflictException);
    releaseProvider({ codeUrl: 'weixin://single-provider-call' });
    await expect(first).resolves.toMatchObject({ payUrl: 'weixin://single-provider-call' });
    expect(deps.wechatPayService.createNativePay).toHaveBeenCalledTimes(1);
  });

  it('recovers Stripe provider success followed by a local persistence failure', async () => {
    const deps = makeDeps();
    const persistence = installCheckoutPersistence(deps);
    const service = await buildService(deps);
    const dto = {
      orderType: 'RECHARGE',
      channel: 'STRIPE',
      amountCents: 2000,
      idempotencyKey: 'stripe-db-recovery',
    };
    let replay = false;
    deps.prisma.order.findFirst.mockImplementation(async () =>
      replay ? persistence.createdOrder() : null,
    );
    deps.prisma.user.findUnique.mockResolvedValue({ email: 'user@example.com' });
    mockStripeCallbackEnv(deps);
    deps.stripeService.createCheckoutSession.mockResolvedValue({
      sessionId: 'cs_same_provider_session',
      url: 'https://checkout.stripe.com/pay/same-provider-session',
    });
    const durableComplete = deps.paymentRepo.completeCheckoutInitialization.getMockImplementation()!;
    deps.paymentRepo.completeCheckoutInitialization
      .mockRejectedValueOnce(new Error('database write failed after Stripe success'))
      .mockImplementation(durableComplete);

    await expect(service.createOrder('u1', dto as any)).rejects.toThrow(
      ServiceUnavailableException,
    );
    replay = true;
    await expect(service.createOrder('u1', dto as any)).resolves.toMatchObject({
      payUrl: 'https://checkout.stripe.com/pay/same-provider-session',
      order: { tradeNo: 'cs_same_provider_session' },
    });
    expect(deps.stripeService.createCheckoutSession).toHaveBeenCalledTimes(2);
    expect(deps.paymentRepo.releaseCheckoutInitialization).toHaveBeenCalledTimes(1);
  });

  it('uses the external verification subject while keeping internal order ownership', async () => {
    const deps = makeDeps();
    const persistence = installCheckoutPersistence(deps);
    const service = await buildService(deps);
    deps.wechatPayService.createNativePay.mockResolvedValue({ codeUrl: 'weixin://external-kyc' });

    await service.createOrder(
      'internal-user',
      { orderType: 'RECHARGE', channel: 'WECHAT', amountCents: 1000 } as any,
      'internal-tenant',
      makeProductIntegrationContext(null),
      { userId: 'external-user', tenantId: 'external-tenant' },
    );

    expect(deps.userPurchaseVerification.assertCanPurchase).toHaveBeenCalledWith(
      'external-user',
      'external-tenant',
    );
    expect(persistence.createdData()).toMatchObject({
      userId: 'internal-user',
      tenantId: 'internal-tenant',
    });
  });

  it('prefers the product-authoritative email for Stripe without reading the global user email', async () => {
    const deps = makeDeps();
    installCheckoutPersistence(deps);
    const service = await buildService(deps);
    mockStripeCallbackEnv(deps);
    deps.stripeService.createCheckoutSession.mockResolvedValue({
      sessionId: 'cs_product_email',
      url: 'https://checkout.stripe.com/pay/product-email',
    });

    await service.createOrder(
      'internal-user',
      { orderType: 'RECHARGE', channel: 'STRIPE', amountCents: 2000 } as any,
      'internal-tenant',
      makeProductIntegrationContext(null),
      {
        userId: 'external-user',
        tenantId: 'external-tenant',
        customerEmail: 'product-user@example.com',
      },
    );

    expect(deps.prisma.user.findUnique).not.toHaveBeenCalled();
    expect(deps.stripeService.createCheckoutSession).toHaveBeenCalledWith(
      expect.objectContaining({ customerEmail: 'product-user@example.com' }),
    );
  });

  it('replays a durable Partner checkout before current catalog and callback-policy validation', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const dto = {
      orderType: 'SUBSCRIPTION',
      channel: 'STRIPE',
      planId: 'plan-now-deleted',
      idempotencyKey: 'recover-after-policy-change',
      successUrl: 'https://old-product.example.com/payment/success',
      cancelUrl: 'https://old-product.example.com/payment/cancel',
    };
    deps.paymentRepo.findPartnerIdempotentOrder.mockResolvedValue(makeOrder({
      productId: 'prod-1',
      planId: 'plan-now-deleted',
      channel: 'STRIPE',
      partnerIdempotencyKey: expect.anything(),
      idempotencyFingerprint: orderFingerprint('user-1', 'tenant-1', dto),
      checkoutInitState: PaymentCheckoutInitState.READY,
      checkoutPayUrlEncrypted: encrypt(
        'https://checkout.stripe.com/pay/original-session',
        TEST_ENCRYPTION_KEY,
      ),
      checkoutPayUrlExpiresAt: new Date(Date.now() + 60_000),
    }));

    await expect(service.createOrder(
      'user-1',
      dto as any,
      'tenant-1',
      makeProductIntegrationContext([]),
      { userId: 'external-user', tenantId: 'external-tenant' },
    )).resolves.toMatchObject({
      payUrl: 'https://checkout.stripe.com/pay/original-session',
    });

    expect(deps.paymentRepo.findPlanWithPrice).not.toHaveBeenCalled();
    expect(deps.userPurchaseVerification.assertCanPurchase).not.toHaveBeenCalled();
    expect(deps.stripeService.createCheckoutSession).not.toHaveBeenCalled();
  });

  it('stores a rollback-readable raw key plus a product-scoped Partner namespace', async () => {
    const deps = makeDeps();
    installCheckoutPersistence(deps);
    const service = await buildService(deps);
    deps.prisma.order.findFirst.mockResolvedValue(null);
    deps.wechatPayService.createNativePay.mockResolvedValue({ codeUrl: 'weixin://product-scope' });
    const dto = {
      orderType: 'RECHARGE',
      channel: 'WECHAT',
      amountCents: 1000,
      idempotencyKey: 'same-caller-key',
    };
    const productA = { ...makeProductIntegrationContext(null), id: 'product-a' };
    const productB = { ...makeProductIntegrationContext(null), id: 'product-b' };
    const verification = { userId: 'external-user', tenantId: 'external-tenant' };

    await service.createOrder('legacy-internal-user', dto as any, 'legacy-internal-tenant', productA, verification);
    await service.createOrder('legacy-internal-user', dto as any, 'legacy-internal-tenant', productB, verification);

    const [first, second] = deps.paymentRepo.createOrder.mock.calls.map(([data]) => data);
    expect(first.idempotencyKey).toBe('same-caller-key');
    expect(second.idempotencyKey).toBe('same-caller-key');
    expect(first.partnerIdempotencyKey).toMatch(/^partner:product-a:/);
    expect(second.partnerIdempotencyKey).toMatch(/^partner:product-b:/);
    expect(first.partnerIdempotencyKey).not.toBe(second.partnerIdempotencyKey);
    expect(first.idempotencyFingerprint).toBe(second.idempotencyFingerprint);
    expect(first.idempotencyFingerprint).toBe(
      orderFingerprint('legacy-internal-user', 'legacy-internal-tenant', dto),
    );
  });

  it('migrates and replays a product-owned legacy raw key without another provider call', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const dto = {
      orderType: 'SUBSCRIPTION',
      channel: 'WECHAT',
      planId: 'plan-legacy',
      idempotencyKey: 'legacy-raw-key',
    };
    const legacyReady = makeOrder({
      userId: 'legacy-internal-user',
      tenantId: 'legacy-internal-tenant',
      productId: 'product-a',
      planId: 'plan-legacy',
      idempotencyKey: dto.idempotencyKey,
      // Historical omission did not normalize billingPeriod=monthly.
      idempotencyFingerprint: legacyOrderFingerprint(
        'legacy-internal-user',
        'legacy-internal-tenant',
        dto,
      ),
      checkoutInitState: PaymentCheckoutInitState.READY,
      checkoutPayUrlEncrypted: encrypt('weixin://legacy-ready', TEST_ENCRYPTION_KEY),
      checkoutPayUrlExpiresAt: new Date(Date.now() + 60_000),
    });
    deps.prisma.order.findFirst.mockResolvedValue(null);
    deps.paymentRepo.findLegacyIdempotentOrder.mockResolvedValue(legacyReady);
    deps.userPurchaseVerification.assertCanPurchase.mockRejectedValue(
      new ServiceUnavailableException('user-api unavailable'),
    );
    const product = { ...makeProductIntegrationContext(null), id: 'product-a' };

    await expect(service.createOrder(
      'legacy-internal-user',
      dto as any,
      'legacy-internal-tenant',
      product,
      { userId: 'external-user', tenantId: 'external-tenant' },
    )).resolves.toMatchObject({ payUrl: 'weixin://legacy-ready' });

    expect(deps.paymentRepo.findLegacyIdempotentOrder).toHaveBeenCalledWith(
      'legacy-raw-key',
      'legacy-internal-user',
      'legacy-internal-tenant',
      'product-a',
    );
    expect(deps.paymentRepo.migrateLegacyIdempotencyKey).toHaveBeenCalledWith(
      'order-1',
      'legacy-raw-key',
      expect.stringMatching(/^partner:product-a:/),
      orderFingerprint('legacy-internal-user', 'legacy-internal-tenant', dto),
    );
    expect(deps.userPurchaseVerification.assertCanPurchase).not.toHaveBeenCalled();
    expect(deps.wechatPayService.createNativePay).not.toHaveBeenCalled();
  });

  it('does not replay a legacy raw key owned by another product', async () => {
    const deps = makeDeps();
    installCheckoutPersistence(deps);
    const service = await buildService(deps);
    const dto = {
      orderType: 'RECHARGE',
      channel: 'WECHAT',
      amountCents: 1000,
      idempotencyKey: 'legacy-other-product',
    };
    deps.prisma.order.findFirst.mockResolvedValue(null);
    deps.paymentRepo.findLegacyIdempotentOrder.mockImplementation(
      async (_key: string, _user: string, _tenant: string, productId: string) =>
        productId === 'product-a'
          ? makeOrder({ productId: 'product-a' })
          : null,
    );
    deps.wechatPayService.createNativePay.mockResolvedValue({ codeUrl: 'weixin://new-product-b' });
    const productB = { ...makeProductIntegrationContext(null), id: 'product-b' };

    await expect(service.createOrder(
      'legacy-internal-user',
      dto as any,
      'legacy-internal-tenant',
      productB,
      { userId: 'external-user', tenantId: 'external-tenant' },
    )).resolves.toMatchObject({ payUrl: 'weixin://new-product-b' });

    expect(deps.paymentRepo.findLegacyIdempotentOrder).toHaveBeenCalledWith(
      dto.idempotencyKey,
      'legacy-internal-user',
      'legacy-internal-tenant',
      'product-b',
    );
    expect(deps.paymentRepo.migrateLegacyIdempotencyKey).not.toHaveBeenCalled();
    expect(deps.wechatPayService.createNativePay).toHaveBeenCalledTimes(1);
  });

  it('treats omitted and explicit monthly subscription periods as the same fingerprint', async () => {
    const deps = makeDeps();
    const persistence = installCheckoutPersistence(deps);
    const service = await buildService(deps);
    const plan = {
      id: 'plan-monthly',
      isActive: true,
      monthlyPrice: 9900,
      yearlyPrice: 9900,
      name: 'Monthly',
    };
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue(planWithPrice(plan));
    deps.wechatPayService.createNativePay.mockResolvedValue({ codeUrl: 'weixin://monthly' });
    let replay = false;
    deps.prisma.order.findFirst.mockImplementation(async () =>
      replay ? persistence.persistedOrder() : null,
    );
    const base = {
      orderType: 'SUBSCRIPTION',
      channel: 'WECHAT',
      planId: 'plan-monthly',
      idempotencyKey: 'monthly-default',
    };

    await service.createOrder('u1', base as any);
    replay = true;
    await expect(service.createOrder('u1', {
      ...base,
      billingPeriod: 'monthly',
    } as any)).resolves.toMatchObject({ payUrl: 'weixin://monthly' });

    expect(deps.wechatPayService.createNativePay).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// getOrderStatus / getOrder
// ============================================================
describe('PaymentService.getOrderStatus / getOrder', () => {
  it('getOrderStatus returns status, paidAt, cancelReason for existing order', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentRepo.findOrderStatusByIdAndUser.mockResolvedValue({
      status: 'PAID',
      paidAt: new Date('2025-01-15'),
      cancelReason: null,
    });

    const result = await service.getOrderStatus('order-1', 'u1');
    expect(result.status).toBe('PAID');
    expect(result.paidAt).toBe(new Date('2025-01-15').toISOString());
    expect(result.cancelReason).toBeNull();
    expect(deps.billingService.resolveSubjectForUser).toHaveBeenCalledWith(
      'u1',
      undefined,
      { requireBillingRole: true },
    );
    expect(deps.paymentRepo.findOrderStatusByIdAndUser).toHaveBeenCalledWith(
      'order-1',
      'u1',
      'tenant-1',
      undefined,
    );
  });

  it('getOrderStatus throws NotFoundException when order not found', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentRepo.findOrderStatusByIdAndUser.mockResolvedValue(null);

    await expect(service.getOrderStatus('missing', 'u1')).rejects.toThrow(NotFoundException);
  });

  it('getOrder returns order for owner', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentRepo.findOrderByIdAndUser.mockResolvedValue(makeOrder());

    const order = await service.getOrder('order-1', 'u1', 'tenant-1', 'product-1');
    expect(order.id).toBe('order-1');
    expect(deps.billingService.resolveSubjectForUser).toHaveBeenCalledWith(
      'u1',
      'tenant-1',
      { requireBillingRole: true },
    );
    expect(deps.paymentRepo.findOrderByIdAndUser).toHaveBeenCalledWith(
      'order-1',
      'u1',
      'tenant-1',
      'product-1',
    );
  });

  it('getOrder throws NotFoundException when order not found', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentRepo.findOrderByIdAndUser.mockResolvedValue(null);

    await expect(service.getOrder('missing', 'u1')).rejects.toThrow(NotFoundException);
  });

  it('getUserOrders exposes recharge bonus and total granted amount', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentRepo.findUserOrders.mockResolvedValue([
      makeOrder({
        orderType: 'RECHARGE',
        amountCents: 5000,
        rechargeTierId: 'tier-1',
        bonusCents: 250,
      }),
    ]);
    deps.paymentRepo.countUserOrders.mockResolvedValue(1);

    const result = await service.getUserOrders('u1', 1, 20, undefined, 'RECHARGE');

    expect(result.items[0]).toEqual(
      expect.objectContaining({
        amountCents: 5000,
        rechargeTierId: 'tier-1',
        bonusCents: 250,
        totalGrantedCents: 5250,
      }),
    );
  });
});

// ============================================================
// cancelOrder
// ============================================================
describe('PaymentService.cancelOrder', () => {
  it('cancels PENDING order for owner', async () => {
    const deps = makeDeps();
    setupPrismaTransaction(deps.prisma);
    const service = await buildService(deps);
    const order = makeOrder({ userId: 'u1', status: OrderStatus.PENDING });
    deps.paymentRepo.findOrderById.mockResolvedValue(order);

    await expect(service.cancelOrder('order-1', 'u1')).resolves.toBeUndefined();
    expect(deps.billingService.resolveSubjectForUser).toHaveBeenCalledWith(
      'u1',
      undefined,
      { requireBillingRole: true },
    );
    expect(deps.prisma.$transaction).toHaveBeenCalled();
  });

  it('fails closed once a provider checkout may exist', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentRepo.findOrderById.mockResolvedValue(makeOrder({
      userId: 'u1',
      status: OrderStatus.PENDING,
      checkoutInitState: PaymentCheckoutInitState.READY,
      checkoutProviderReference: 'wx-order-1',
      tradeNo: 'wx-order-1',
    }));

    await expect(service.cancelOrder('order-1', 'u1')).rejects.toThrow(
      '支付渠道订单已创建，当前缺少可确认的远端关单协议',
    );
    expect(deps.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when order not found', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentRepo.findOrderById.mockResolvedValue(null);

    await expect(service.cancelOrder('missing', 'u1')).rejects.toThrow(NotFoundException);
  });

  it('returns 404 when a Partner product scope cannot see the order', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentRepo.findOrderByIdAndUser.mockResolvedValue(null);

    await expect(
      service.cancelOrder('order-mixed', 'u1', 'tenant-1', 'prod-a'),
    ).rejects.toThrow(NotFoundException);

    expect(deps.paymentRepo.findOrderByIdAndUser).toHaveBeenCalledWith(
      'order-mixed',
      'u1',
      'tenant-1',
      'prod-a',
    );
  });

  it('throws ForbiddenException when user does not own the order', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const order = makeOrder({ userId: 'other-user', status: OrderStatus.PENDING });
    deps.paymentRepo.findOrderById.mockResolvedValue(order);

    await expect(service.cancelOrder('order-1', 'u1')).rejects.toThrow(ForbiddenException);
  });

  it('throws ForbiddenException when current tenant does not match order tenant', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const order = makeOrder({ userId: 'u1', tenantId: 'tenant-1', status: OrderStatus.PENDING });
    deps.paymentRepo.findOrderById.mockResolvedValue(order);
    deps.billingService.resolveSubjectForUser.mockResolvedValueOnce({
      tenantId: 'tenant-other',
      billingAccountId: 'ba-tenant-other',
    });

    await expect(service.cancelOrder('order-1', 'u1')).rejects.toThrow(ForbiddenException);
  });

  it('returns a 409 conflict when trying to cancel a non-PENDING order', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const order = makeOrder({ userId: 'u1', status: OrderStatus.PAID });
    deps.paymentRepo.findOrderById.mockResolvedValue(order);

    await expect(service.cancelOrder('order-1', 'u1')).rejects.toBeInstanceOf(ConflictException);
  });

  it('returns a 409 conflict when the order leaves PENDING during cancellation', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentRepo.findOrderById.mockResolvedValue(
      makeOrder({ userId: 'u1', status: OrderStatus.PENDING }),
    );
    deps.prisma.$transaction.mockImplementation(async (callback: any) => callback({
      order: {
        updateMany: jest.fn().mockResolvedValue({ count: 0 }),
      },
      orderAuditLog: {
        create: jest.fn().mockResolvedValue({}),
      },
    }));

    await expect(service.cancelOrder('order-1', 'u1')).rejects.toBeInstanceOf(ConflictException);
    expect(deps.prisma.$transaction).toHaveBeenCalled();
  });
});

// ============================================================
// finding：自营订单 per-user（绕开当前工作区）
// ============================================================
describe('PaymentService — 自营订单 per-user', () => {
  it('getOrderStatus 自营：按 userId 查、不调 resolveSubjectForUser（不受当前工作区限制）', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentRepo.isSelfOpCodingPlanOrderOwnedByUser.mockResolvedValue(true);
    deps.paymentRepo.findOrderStatusOwnedByUser.mockResolvedValue({
      status: 'PAID', paidAt: new Date('2025-01-15'), cancelReason: null,
    });

    const result = await service.getOrderStatus('order-1', 'u1');
    expect(result.status).toBe('PAID');
    expect(deps.billingService.resolveSubjectForUser).not.toHaveBeenCalled();
    expect(deps.paymentRepo.findOrderStatusOwnedByUser).toHaveBeenCalledWith('order-1', 'u1', undefined);
    expect(deps.paymentRepo.findOrderStatusByIdAndUser).not.toHaveBeenCalled();
  });

  it('getOrder 自营：按 userId 查、不调 resolveSubjectForUser', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentRepo.isSelfOpCodingPlanOrderOwnedByUser.mockResolvedValue(true);
    deps.paymentRepo.findOrderOwnedByUser.mockResolvedValue(makeOrder({ userId: 'u1' }));

    await service.getOrder('order-1', 'u1');
    expect(deps.billingService.resolveSubjectForUser).not.toHaveBeenCalled();
    expect(deps.paymentRepo.findOrderOwnedByUser).toHaveBeenCalledWith('order-1', 'u1', undefined);
  });

  it('cancelOrder 自营：属主即可取消、不校验当前工作区 tenant', async () => {
    const deps = makeDeps();
    setupPrismaTransaction(deps.prisma);
    const service = await buildService(deps);
    const order = makeOrder({ userId: 'u1', tenantId: 'personal-t', status: OrderStatus.PENDING });
    deps.paymentRepo.isSelfOpCodingPlanOrderOwnedByUser.mockResolvedValue(true);
    deps.paymentRepo.findOrderOwnedByUser.mockResolvedValue(order);

    await expect(service.cancelOrder('order-1', 'u1')).resolves.toBeUndefined();
    expect(deps.billingService.resolveSubjectForUser).not.toHaveBeenCalled();
    expect(deps.paymentRepo.findOrderOwnedByUser).toHaveBeenCalledWith('order-1', 'u1', undefined);
  });

  it('getOrderStatus 自营 + productId 不匹配 → NotFound（产品隔离）', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentRepo.isSelfOpCodingPlanOrderOwnedByUser.mockResolvedValue(true);
    deps.paymentRepo.findOrderStatusOwnedByUser.mockResolvedValue(null); // productScopeWhere 过滤后无

    await expect(
      service.getOrderStatus('order-1', 'u1', undefined, 'other-product'),
    ).rejects.toThrow(NotFoundException);
    expect(deps.paymentRepo.findOrderStatusOwnedByUser).toHaveBeenCalledWith('order-1', 'u1', 'other-product');
  });

  it('cancelOrder 自营：非本人订单仍拒（属主校验先行）', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentRepo.findOrderById.mockResolvedValue(makeOrder({ userId: 'other', status: OrderStatus.PENDING }));

    await expect(service.cancelOrder('order-1', 'u1')).rejects.toThrow(ForbiddenException);
  });
});

// ============================================================
// getUserOrders
// ============================================================
describe('PaymentService.getUserOrders', () => {
  it('returns paginated order list', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentRepo.findUserOrders.mockResolvedValue([makeOrder()]);
    deps.paymentRepo.countUserOrders.mockResolvedValue(15);

    const result = await service.getUserOrders('u1', 1, 5, 'PENDING', undefined, 'tenant-1', 'product-1');
    expect(result.items).toHaveLength(1);
    expect(result.total).toBe(15);
    expect(result.totalPages).toBe(3);
    expect(deps.billingService.resolveSubjectForUser).toHaveBeenCalledWith(
      'u1',
      'tenant-1',
      { requireBillingRole: true },
    );
    expect(deps.paymentRepo.findUserOrders).toHaveBeenCalledWith(
      'u1',
      0,
      5,
      'PENDING',
      undefined,
      'tenant-1',
      'product-1',
    );
    expect(deps.paymentRepo.countUserOrders).toHaveBeenCalledWith(
      'u1',
      'PENDING',
      undefined,
      'tenant-1',
      'product-1',
    );
  });
});

// ============================================================
// verifyStripeWebhook
// ============================================================
describe('PaymentService.verifyStripeWebhook', () => {
  it('verifies with Admin Stripe webhook credentials before falling back to env', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const event = { id: 'evt_admin', type: 'checkout.session.completed', data: { object: {} } };
    deps.paymentProviderRegistry.getInstances.mockResolvedValue([
      {
        id: 'ppi_stripe_1',
        providerKey: 'stripe',
        name: 'Stripe Live',
        config: { secretKey: 'sk_live_admin', webhookSecret: 'whsec_live_admin' },
        supportedTypes: [],
        isActive: true,
        dailyLimitCents: 0,
      },
    ]);
    deps.stripeService.verifyWebhook.mockReturnValue(event);

    await expect(service.verifyStripeWebhook(Buffer.from('{}'), 'sig_live')).resolves.toEqual({
      event,
      verifiedPaymentProviderInstanceIds: ['ppi_stripe_1'],
    });

    expect(deps.stripeService.verifyWebhook).toHaveBeenCalledWith(
      expect.any(Buffer),
      'sig_live',
      { secretKey: 'sk_live_admin', webhookSecret: 'whsec_live_admin' },
    );
  });

  it('tries the env Stripe webhook config when Admin instance signatures do not match', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const event = { id: 'evt_env', type: 'checkout.session.completed', data: { object: {} } };
    deps.paymentProviderRegistry.getInstances.mockResolvedValue([
      {
        id: 'ppi_stripe_1',
        providerKey: 'stripe',
        name: 'Stripe Live',
        config: { secretKey: 'sk_live_admin', webhookSecret: 'whsec_live_admin' },
        supportedTypes: [],
        isActive: true,
        dailyLimitCents: 0,
      },
    ]);
    deps.stripeService.verifyWebhook
      .mockImplementationOnce(() => {
        throw new Error('No signatures found');
      })
      .mockReturnValueOnce(event);

    await expect(service.verifyStripeWebhook(Buffer.from('{}'), 'sig_env')).resolves.toEqual({
      event,
      verifiedPaymentProviderInstanceIds: [],
    });

    expect(deps.stripeService.verifyWebhook).toHaveBeenNthCalledWith(
      1,
      expect.any(Buffer),
      'sig_env',
      { secretKey: 'sk_live_admin', webhookSecret: 'whsec_live_admin' },
    );
    expect(deps.stripeService.verifyWebhook).toHaveBeenNthCalledWith(
      2,
      expect.any(Buffer),
      'sig_env',
    );
  });

  it('treats every instance sharing a Stripe webhook secret as a verified identity', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const event = { id: 'evt_shared', type: 'checkout.session.completed', data: { object: {} } };
    deps.paymentProviderRegistry.getInstances.mockResolvedValue([
      {
        id: 'ppi_stripe_a',
        providerKey: 'stripe',
        name: 'Stripe A',
        config: { secretKey: 'sk_a', webhookSecret: 'whsec_shared' },
        supportedTypes: [],
        isActive: true,
        dailyLimitCents: 0,
      },
      {
        id: 'ppi_stripe_b',
        providerKey: 'stripe',
        name: 'Stripe B',
        config: { secretKey: 'sk_b', webhookSecret: 'whsec_shared' },
        supportedTypes: [],
        isActive: true,
        dailyLimitCents: 0,
      },
    ]);
    deps.stripeService.verifyWebhook.mockReturnValue(event);

    await expect(service.verifyStripeWebhook(Buffer.from('{}'), 'sig_shared')).resolves.toEqual({
      event,
      verifiedPaymentProviderInstanceIds: ['ppi_stripe_a', 'ppi_stripe_b'],
    });
    expect(deps.stripeService.verifyWebhook).toHaveBeenCalledTimes(1);
  });
});

describe('PaymentService.getAvailablePaymentMethods', () => {
  it('rejects a currency that differs from the deployment currency', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    await expect(service.getAvailablePaymentMethods({
      orderType: 'RECHARGE',
      currency: 'usd',
    } as any)).rejects.toThrow('当前部署仅支持 CNY 支付');

    expect(deps.paymentProviderRegistry.getInstances).not.toHaveBeenCalled();
  });

  it('returns enabled Admin payment methods that support the product', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentProviderRegistry.getInstances.mockImplementation(async (providerKey: string) => {
      if (providerKey === 'alipay') {
        return [{
          id: 'ppi_alipay_1',
          providerKey: 'alipay',
          name: 'Alipay Sandbox',
          config: {
            appId: '9021000164665533',
            privateKey: 'app-private-key',
            alipayPublicKey: 'alipay-public-key',
            notifyUrl: 'https://user.test/api/payment/notify/alipay',
          },
          supportedTypes: ['product-1'],
          isActive: true,
          dailyLimitCents: 0,
        }];
      }
      if (providerKey === 'stripe') {
        return [{
          id: 'ppi_stripe_1',
          providerKey: 'stripe',
          name: 'Stripe Sandbox',
          config: { secretKey: 'sk_test_123' },
          supportedTypes: ['product-1'],
          isActive: true,
          dailyLimitCents: 0,
        }];
      }
      return [];
    });

    await expect(service.getAvailablePaymentMethods({
      orderType: 'RECHARGE',
      productId: 'product-1',
      currency: 'cny',
    } as any)).resolves.toEqual({
      methods: [
        { channel: 'ALIPAY', label: '支付宝', currency: 'cny', mode: 'redirect' },
        { channel: 'STRIPE', label: '银行卡', currency: 'cny', mode: 'redirect' },
      ],
    });
  });

  it('hides redirect channels when the Partner product explicitly allows no callback origins', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentProviderRegistry.getInstances.mockResolvedValue([{
      id: 'ppi_redirect',
      providerKey: 'stripe',
      name: 'Redirect provider',
      config: { secretKey: 'sk_test_123' },
      supportedTypes: ['product-1'],
      isActive: true,
      dailyLimitCents: 0,
    }]);

    await expect(service.getAvailablePaymentMethods({
      orderType: 'RECHARGE',
      productId: 'product-1',
      currency: 'cny',
      allowedPaymentCallbackOrigins: [],
    })).resolves.toEqual({ methods: [] });

    expect(deps.paymentProviderRegistry.getInstances).not.toHaveBeenCalled();
  });

  it('hides Admin instances that do not support the selected product', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentProviderRegistry.getInstances.mockImplementation(async () => [{
      id: 'ppi_1',
      providerKey: 'alipay',
      name: 'Wrong Product',
      config: {
        appId: '9021000164665533',
        privateKey: 'app-private-key',
        alipayPublicKey: 'alipay-public-key',
        notifyUrl: 'https://user.test/api/payment/notify/alipay',
      },
      supportedTypes: ['other-product'],
      isActive: true,
      dailyLimitCents: 0,
    }]);

    await expect(service.getAvailablePaymentMethods({
      orderType: 'RECHARGE',
      productId: 'product-1',
    } as any)).resolves.toEqual({ methods: [] });
  });

  it('hides recurring BUNDLE even when env Stripe is configured', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentProviderRegistry.getInstances.mockResolvedValue([]);
    deps.config.get.mockImplementation((key: string) => ({
      STRIPE_SECRET_KEY: 'sk_env_123',
      ALIPAY_APP_ID: 'alipay-app',
      ALIPAY_PRIVATE_KEY: 'private-key',
      ALIPAY_ALIPAY_PUBLIC_KEY: 'alipay-public-key',
      ALIPAY_NOTIFY_URL: 'https://user.test/api/payment/notify/alipay',
    })[key]);

    await expect(service.getAvailablePaymentMethods({
      orderType: 'BUNDLE',
      currency: 'cny',
    } as any)).resolves.toEqual({ methods: [] });
    expect(deps.paymentProviderRegistry.getInstances).not.toHaveBeenCalledWith('stripe');
    expect(deps.paymentProviderRegistry.getInstances).not.toHaveBeenCalledWith('alipay');
  });

  it('hides recurring BUNDLE when Partner injects productId', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentProviderRegistry.getInstances.mockImplementation(async (providerKey: string) => {
      if (providerKey !== 'stripe') return [];
      return [{
        id: 'ppi_bundle',
        providerKey: 'stripe',
        name: 'Bundle Stripe',
        config: { secretKey: 'sk_bundle' },
        supportedTypes: ['bundle'],
        isActive: true,
        dailyLimitCents: 0,
      }];
    });

    await expect(service.getAvailablePaymentMethods({
      orderType: 'BUNDLE',
      productId: 'product-1',
      currency: 'cny',
    } as any)).resolves.toEqual({ methods: [] });
    expect(deps.paymentProviderRegistry.getInstances).not.toHaveBeenCalled();
  });

  it('advertises WECHAT for non-BUNDLE CNY orders only when its required config is complete', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentProviderRegistry.getInstances.mockResolvedValue([]);
    deps.config.get.mockImplementation((key: string) => ({
      WECHAT_APP_ID: 'wx-app',
      WECHAT_MCH_ID: 'mch-1',
      WECHAT_API_V3_KEY: 'v3-key',
      WECHAT_SERIAL_NO: 'serial-1',
      WECHAT_PRIVATE_KEY_PATH: '/run/secrets/wechat.pem',
      WECHAT_NOTIFY_URL: 'https://billing.example.com/payment/wechat/notify',
    })[key]);

    await expect(service.getAvailablePaymentMethods({
      orderType: 'RECHARGE',
      currency: 'cny',
    } as any)).resolves.toEqual({
      methods: [
        { channel: 'WECHAT', label: '微信支付', currency: 'cny', mode: 'qr' },
      ],
    });
  });
});

// ============================================================
// verifyAlipayNotify
// ============================================================
describe('PaymentService.verifyAlipayNotify', () => {
  it('verifies with matching Admin Alipay credentials before falling back to env', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const params = {
      app_id: '9021000164665533',
      sign: 'sig',
      sign_type: 'RSA2',
    };
    deps.paymentProviderRegistry.getInstances.mockResolvedValue([
      {
        id: 'ppi_alipay_1',
        providerKey: 'alipay',
        name: 'Alipay Sandbox',
        config: {
          appId: '9021000164665533',
          privateKey: 'app-private-key',
          alipayPublicKey: 'alipay-public-key',
          gateway: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
          keyType: 'PKCS8',
        },
        supportedTypes: [],
        isActive: true,
        dailyLimitCents: 0,
      },
    ]);
    deps.alipayService.verifyNotifySign.mockReturnValue(true);

    await expect(service.verifyAlipayNotify(params)).resolves.toEqual({
      valid: true,
      verifiedPaymentProviderInstanceIds: ['ppi_alipay_1'],
    });

    expect(deps.alipayService.verifyNotifySign).toHaveBeenCalledWith(
      params,
      expect.objectContaining({
        appId: '9021000164665533',
        gateway: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
        keyType: 'PKCS8',
      }),
    );
  });

  it('falls back to env Alipay config when Admin credentials do not match', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentProviderRegistry.getInstances.mockResolvedValue([
      {
        id: 'ppi_alipay_1',
        providerKey: 'alipay',
        name: 'Alipay Sandbox',
        config: {
          appId: '9021000164665533',
          privateKey: 'app-private-key',
          alipayPublicKey: 'alipay-public-key',
        },
        supportedTypes: [],
        isActive: true,
        dailyLimitCents: 0,
      },
    ]);
    deps.alipayService.verifyNotifySign
      .mockReturnValueOnce(false)
      .mockReturnValueOnce(true);

    await expect(service.verifyAlipayNotify({
      app_id: '9021000164665533',
      sign: 'sig',
    })).resolves.toEqual({ valid: true });

    expect(deps.alipayService.verifyNotifySign).toHaveBeenNthCalledWith(
      2,
      expect.any(Object),
    );
  });

  it('treats every instance with indistinguishable Alipay verification keys as verified', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const base = {
      providerKey: 'alipay',
      supportedTypes: [],
      isActive: true,
      dailyLimitCents: 0,
    };
    deps.paymentProviderRegistry.getInstances.mockResolvedValue([
      {
        ...base,
        id: 'ppi_alipay_a',
        name: 'Alipay A',
        config: {
          appId: 'app-shared',
          privateKey: 'private-a',
          alipayPublicKey: 'public-shared',
          keyType: 'PKCS8',
        },
      },
      {
        ...base,
        id: 'ppi_alipay_b',
        name: 'Alipay B',
        config: {
          appId: 'app-shared',
          privateKey: 'private-b',
          alipayPublicKey: 'public-shared',
          keyType: 'PKCS8',
        },
      },
    ]);
    deps.alipayService.verifyNotifySign.mockReturnValue(true);

    await expect(service.verifyAlipayNotify({
      app_id: 'app-shared',
      sign: 'sig',
    })).resolves.toEqual({
      valid: true,
      verifiedPaymentProviderInstanceIds: ['ppi_alipay_a', 'ppi_alipay_b'],
    });
    expect(deps.alipayService.verifyNotifySign).toHaveBeenCalledTimes(1);
  });
});

// ============================================================
// handlePaymentCallback
// ============================================================
describe('PaymentService.handlePaymentCallback', () => {
  it('rejects a callback whose provider currency differs from the order currency', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentRepo.findOrderById.mockResolvedValue(
      makeOrder({ status: OrderStatus.PENDING, channel: PayChannel.STRIPE, currency: 'usd' }),
    );

    const result = await service.handlePaymentCallback('TX-1', 'order-1', 'STRIPE', {
      paidAmountCents: 9900,
      paidCurrency: 'cny',
    });

    expect(result).toBe(false);
    expect(deps.prisma.order.updateMany).not.toHaveBeenCalled();
    expect(deps.redis.set).not.toHaveBeenCalled();
  });

  it('rejects an env-signed Alipay callback for an instance-bound order', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentRepo.findOrderById.mockResolvedValue(
      makeOrder({
        status: OrderStatus.PENDING,
        channel: PayChannel.ALIPAY,
        currency: 'cny',
        paymentProviderInstanceId: 'ppi_alipay_1',
      }),
    );

    const result = await service.handlePaymentCallback(
      'TX-1',
      'order-1',
      'ALIPAY',
      {
        paidAmountCents: 9900,
        paidCurrency: 'cny',
      },
    );

    expect(result).toBe(false);
    expect(deps.prisma.order.updateMany).not.toHaveBeenCalled();
    expect(deps.redis.set).not.toHaveBeenCalled();
  });

  it('validates provider identity before accepting an idempotent callback', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentRepo.findOrderById.mockResolvedValue(
      makeOrder({
        status: OrderStatus.PAID,
        channel: PayChannel.STRIPE,
        paymentProviderInstanceId: 'ppi_stripe_1',
      }),
    );

    const result = await service.handlePaymentCallback(
      'TX-1',
      'order-1',
      'STRIPE',
      {
        paidAmountCents: 9900,
        paidCurrency: 'usd',
        paymentProviderInstanceId: 'ppi_stripe_2',
      },
    );

    expect(result).toBe(false);
    expect(deps.redis.set).not.toHaveBeenCalled();
  });

  it('accepts an Alipay callback when the bound instance is among indistinguishable verified identities', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentRepo.findOrderById.mockResolvedValue(
      makeOrder({
        status: OrderStatus.PAID,
        channel: PayChannel.ALIPAY,
        currency: 'cny',
        paymentProviderInstanceId: 'ppi_alipay_b',
      }),
    );

    await expect(service.handlePaymentCallback(
      'TX-1',
      'order-1',
      'ALIPAY',
      {
        paidAmountCents: 9900,
        paidCurrency: 'cny',
        verifiedPaymentProviderInstanceIds: ['ppi_alipay_a', 'ppi_alipay_b'],
      },
    )).resolves.toBe(true);
  });

  it('returns true and processes order on first callback', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const order = makeOrder({ status: OrderStatus.PENDING });
    deps.paymentRepo.findOrderById.mockResolvedValue(order);
    deps.prisma.order.updateMany.mockResolvedValue({ count: 1 });
    deps.prisma.order.findUnique
      .mockResolvedValueOnce({ ...order, status: OrderStatus.PAID }) // fulfillOrder check
      .mockResolvedValueOnce(order);            // transitionOrderStatus PAID→FULFILLING
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);
    deps.redis.set.mockResolvedValue('OK');     // fulfillOrder lock succeeds

    // fulfillOrder: order is SUBSCRIPTION type, planId=plan-1
    deps.prisma.order.findUnique
      .mockResolvedValueOnce({ ...order, status: OrderStatus.PAID }) // fulfillOrder finds PAID
      .mockResolvedValueOnce({ ...order, status: OrderStatus.FULFILLING }); // PAID->FULFILLING

    deps.prisma.plan.findUnique.mockResolvedValue({
      id: 'plan-1', productId: 'prod-1', name: 'Pro', monthlyCredits: 1000,
    });
    deps.billingService.activateSubscription.mockResolvedValue({
      contractId: 'contract-activated',
      periodId: 'subscription-activated',
      entitlementId: 'entitlement-activated',
    });
    deps.subscriptionResolver.invalidateCache.mockResolvedValue(undefined);
    deps.subscriptionResolver.resolve.mockResolvedValue({ subscriptionId: 'sub-1' });
    deps.creditService.grantQuota.mockResolvedValue(undefined);
    deps.prisma.user.findUnique.mockResolvedValue({ email: 'u@x.com' });
    deps.prisma.product.findUnique.mockResolvedValue({ slug: 'rdclaw' });

    const result = await service.handlePaymentCallback('TX-1', 'order-1', 'WECHAT', {
      paidAmountCents: 9900,
    });
    expect(result).toBe(true);
    expect(deps.prisma.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'order-1', status: OrderStatus.PENDING, channel: PayChannel.WECHAT },
        data: expect.objectContaining({ status: OrderStatus.PAID, tradeNo: 'TX-1' }),
      }),
    );
  });

  it('returns false when order not found', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentRepo.findOrderById.mockResolvedValue(null);

    const result = await service.handlePaymentCallback('TX-1', 'missing', 'WECHAT');
    expect(result).toBe(false);
  });

  it('returns false when callback channel does not match the order channel', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentRepo.findOrderById.mockResolvedValue(
      makeOrder({ status: OrderStatus.PENDING, channel: PayChannel.STRIPE }),
    );

    const result = await service.handlePaymentCallback('TX-1', 'order-1', 'WECHAT', {
      paidAmountCents: 9900,
    });

    expect(result).toBe(false);
    expect(deps.prisma.order.updateMany).not.toHaveBeenCalled();
    expect(deps.prisma.orderAuditLog.create).not.toHaveBeenCalled();
    expect(deps.redis.set).not.toHaveBeenCalled();
  });

  it('returns true (idempotent) when order is already PAID', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentRepo.findOrderById.mockResolvedValue(
      makeOrder({ status: OrderStatus.PAID }),
    );

    const result = await service.handlePaymentCallback('TX-1', 'order-1', 'WECHAT');
    expect(result).toBe(true);
    expect(deps.prisma.order.update).not.toHaveBeenCalled();
  });

  it('does not treat an already paid order as idempotent when callback channel differs', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentRepo.findOrderById.mockResolvedValue(
      makeOrder({ status: OrderStatus.PAID, channel: PayChannel.STRIPE }),
    );

    const result = await service.handlePaymentCallback('TX-1', 'order-1', 'WECHAT', {
      paidAmountCents: 9900,
    });

    expect(result).toBe(false);
    expect(deps.redis.set).not.toHaveBeenCalled();
  });

  it('returns true (idempotent) when order is FULFILLING', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentRepo.findOrderById.mockResolvedValue(
      makeOrder({ status: OrderStatus.FULFILLING, channel: PayChannel.ALIPAY }),
    );

    const result = await service.handlePaymentCallback('TX-1', 'order-1', 'ALIPAY');
    expect(result).toBe(true);
  });

  it('returns true (idempotent) when order is COMPLETED', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentRepo.findOrderById.mockResolvedValue(
      makeOrder({ status: OrderStatus.COMPLETED, channel: PayChannel.STRIPE }),
    );

    const result = await service.handlePaymentCallback('TX-1', 'order-1', 'STRIPE');
    expect(result).toBe(true);
  });

  it.each([
    ['WECHAT', PayChannel.WECHAT],
    ['ALIPAY', PayChannel.ALIPAY],
    ['STRIPE', PayChannel.STRIPE],
  ] as const)(
    'acknowledges a paid %s callback for a cancelled order after durable reconciliation',
    async (channel, payChannel) => {
      const deps = makeDeps();
      const service = await buildService(deps);
      deps.paymentRepo.findOrderById.mockResolvedValue(
        makeOrder({
          status: OrderStatus.CANCELLED,
          channel: payChannel,
        }),
      );

      const result = await service.handlePaymentCallback(
        'TX-CANCELLED-LATE',
        'order-1',
        channel,
        {
          paidAmountCents: 9900,
          paidCurrency: 'usd',
          paymentStatus: 'paid',
        },
      );

      expect(result).toBe(true);
      expect(deps.prisma.order.updateMany).not.toHaveBeenCalled();
      expect(deps.redis.set).not.toHaveBeenCalled();
      expect(deps.prisma.alertEvent.upsert).toHaveBeenCalledTimes(1);
      const alert = deps.prisma.alertEvent.upsert.mock.calls[0][0];
      expect(alert.where.id).toMatch(/^payment-late-[0-9a-f]{64}$/);
      expect(alert.create).toEqual(expect.objectContaining({
        category: 'PAYMENT',
        severity: 'CRITICAL',
        title: '已取消订单收到支付成功回调',
        sourceType: 'order',
        sourceId: 'order-1',
        userId: 'user-1',
      }));
      expect(JSON.parse(alert.create.context)).toEqual(expect.objectContaining({
        reconciliationType: 'LATE_PAYMENT_ON_TERMINAL_ORDER',
        terminalStatus: OrderStatus.CANCELLED,
        channel,
        tradeNo: 'TX-CANCELLED-LATE',
        paidAmountCents: 9900,
      }));
    },
  );

  it('records a concurrent PENDING-to-CANCELLED race and acknowledges the callback', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentRepo.findOrderById
      .mockResolvedValueOnce(makeOrder({ status: OrderStatus.PENDING }))
      .mockResolvedValueOnce(makeOrder({ status: OrderStatus.CANCELLED }));
    deps.prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await service.handlePaymentCallback(
      'TX-CANCEL-RACE',
      'order-1',
      'WECHAT',
      { paidAmountCents: 9900 },
    );

    expect(result).toBe(true);
    expect(deps.prisma.alertEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          severity: 'CRITICAL',
          title: '已取消订单收到支付成功回调',
        }),
      }),
    );
  });

  it('does not acknowledge a terminal late payment before reconciliation is durable', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentRepo.findOrderById.mockResolvedValue(
      makeOrder({ status: OrderStatus.CANCELLED }),
    );
    deps.prisma.alertEvent.upsert.mockRejectedValueOnce(
      new Error('reconciliation database unavailable'),
    );

    await expect(service.handlePaymentCallback(
      'TX-CANCELLED-RETRY',
      'order-1',
      'WECHAT',
      { paidAmountCents: 9900 },
    )).rejects.toThrow('reconciliation database unavailable');

    expect(deps.prisma.order.updateMany).not.toHaveBeenCalled();
    expect(deps.redis.set).not.toHaveBeenCalled();
  });

  it('acknowledges expired paid callback with alert but does not revive the order', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.paymentRepo.findOrderById.mockResolvedValue(
      makeOrder({ status: OrderStatus.EXPIRED }),
    );

    const result = await service.handlePaymentCallback('TX-LATE', 'order-1', 'WECHAT', {
      paidAmountCents: 9900,
    });

    expect(result).toBe(true);
    expect(deps.prisma.order.updateMany).not.toHaveBeenCalled();
    expect(deps.prisma.orderAuditLog.create).not.toHaveBeenCalled();
    expect(deps.redis.set).not.toHaveBeenCalled();
    expect(deps.prisma.alertEvent.upsert).toHaveBeenCalledWith(
      expect.objectContaining({
        create: expect.objectContaining({
          category: 'PAYMENT',
          severity: 'CRITICAL',
          title: '过期订单收到支付成功回调',
          sourceId: 'order-1',
        }),
      }),
    );
    const alert = deps.prisma.alertEvent.upsert.mock.calls[0][0];
    expect(JSON.parse(alert.create.context)).toEqual(expect.objectContaining({
      terminalStatus: OrderStatus.EXPIRED,
      tradeNo: 'TX-LATE',
      paidAmountCents: 9900,
    }));
  });

  it('fulfills bundle checkout by granting both subscription and one-time entitlements once', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.paymentRepo.findOrderById.mockResolvedValue(
      makeOrder({ id: 'order-bundle', userId: 'user-1', orderType: PrismaOrderType.BUNDLE, status: OrderStatus.PENDING, channel: PayChannel.STRIPE }),
    );
    deps.prisma.order.updateMany.mockResolvedValue({ count: 1 });
    deps.prisma.order.findUnique.mockResolvedValue(
      makeOrder({ id: 'order-bundle', userId: 'user-1', orderType: PrismaOrderType.BUNDLE, status: OrderStatus.PAID, channel: PayChannel.STRIPE }),
    );
    deps.prisma.order.update.mockResolvedValue({});
    deps.prisma.orderAuditLog.create.mockResolvedValue({});
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);
    deps.redis.set.mockResolvedValue('OK');
    deps.prisma.orderItem.findMany.mockResolvedValue([
      {
        id: 'item-a',
        status: OrderItemStatus.PENDING,
        planId: 'plan-a',
        productId: 'prod-a',
        boosterPackId: null,
        name: 'Product A Yearly',
        validityDays: null,
        plan: { id: 'plan-a', name: 'A Pro', monthlyCredits: 500 },
        boosterPack: null,
      },
      {
        id: 'item-b',
        status: OrderItemStatus.PENDING,
        planId: 'plan-b',
        productId: 'prod-b',
        boosterPackId: null,
        name: 'Product B Access',
        validityDays: 365,
        plan: { id: 'plan-b', name: 'B Access', monthlyCredits: 100 },
        boosterPack: null,
      },
    ] as any);
    deps.subscriptionResolver.resolve.mockResolvedValue({ subscriptionId: 'local-sub' });
    deps.creditService.grantQuota.mockResolvedValue(undefined);
    deps.prisma.orderItem.update.mockResolvedValue({});

    const result = await service.handlePaymentCallback('sub_stripe_bundle', 'order-bundle', 'STRIPE');

    expect(result).toBe(true);
    expect(deps.billingService.activateSubscription).toHaveBeenNthCalledWith(
      1,
      'user-1',
      'plan-a',
      'prod-a',
      undefined,
      'monthly',
      {
        tenantId: 'tenant-1',
        idempotencyKey: 'bundle:order-bundle:item:item-a:activation',
        requireNoActiveSubscription: true,
      },
    );
    expect(deps.billingService.activateSubscription).toHaveBeenNthCalledWith(
      2,
      'user-1',
      'plan-b',
      'prod-b',
      365,
      'monthly',
      {
        tenantId: 'tenant-1',
        idempotencyKey: 'bundle:order-bundle:item:item-b:activation',
        requireNoActiveSubscription: true,
      },
    );
    expect(deps.creditService.grantQuota).toHaveBeenCalledTimes(2);
    expect(deps.prisma.orderItem.update).toHaveBeenCalledWith({
      where: { id: 'item-a' },
      data: { status: OrderItemStatus.FULFILLED, fulfilledAt: expect.any(Date) },
    });
    expect(deps.prisma.orderItem.update).toHaveBeenCalledWith({
      where: { id: 'item-b' },
      data: { status: OrderItemStatus.FULFILLED, fulfilledAt: expect.any(Date) },
    });
  });
});

// ============================================================
// handleStripeEvent
// ============================================================
describe('PaymentService.handleStripeEvent', () => {
  function paidStandaloneRenewalInvoice(
    overrides: Record<string, unknown> = {},
  ) {
    return {
      id: 'in_test_42',
      subscription: 'sub_123',
      billing_reason: 'subscription_cycle',
      currency: 'usd',
      status: 'paid',
      paid: true,
      collection_method: 'charge_automatically',
      amount_paid: 9900,
      amount_remaining: 0,
      total: 9900,
      lines: {
        has_more: false,
        data: [
          {
            id: 'il_renewal',
            type: 'subscription',
            subscription: 'sub_123',
            amount: 9900,
            currency: 'usd',
            quantity: 1,
            price: {
              type: 'recurring',
              currency: 'usd',
              unit_amount: 9900,
              recurring: {
                interval: 'month',
                interval_count: 1,
              },
            },
          },
        ],
      },
      ...overrides,
    };
  }

  it('ignores unknown event types', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    await expect(
      service.handleStripeEvent({ id: 'evt_unknown_1', type: 'charge.succeeded', data: { object: {} } }),
    ).resolves.toBeUndefined();
  });

  it('handles checkout.session.completed with orderId in metadata', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    // Mock handlePaymentCallback path
    deps.paymentRepo.findOrderById.mockResolvedValue(
      makeOrder({ status: OrderStatus.PENDING, channel: PayChannel.STRIPE }),
    );
    deps.prisma.order.updateMany.mockResolvedValue({ count: 1 });
    deps.prisma.order.update.mockResolvedValue({});
    deps.prisma.order.findUnique
      .mockResolvedValue(makeOrder({
        status: OrderStatus.PAID,
        channel: PayChannel.STRIPE,
        orderType: PrismaOrderType.RECHARGE,
        checkoutProviderReference: 'cs_123',
      }));
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);
    deps.redis.set
      .mockResolvedValueOnce('OK')
      .mockResolvedValue(null); // event lock acquired; fulfillment lock skips

    await service.handleStripeEvent({
      id: 'evt_cs_1',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_123',
          metadata: { orderId: 'order-1' },
          mode: 'payment',
          subscription: null,
          amount_total: 9900,
          currency: 'usd',
          payment_status: 'paid',
        },
      },
    });

    expect(deps.paymentRepo.findOrderById).toHaveBeenCalledWith('order-1');
  });

  it('fulfills a zero-value Stripe Checkout session with no_payment_required', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const zeroValueOrder = makeOrder({
      amountCents: 0,
      status: OrderStatus.PENDING,
      channel: PayChannel.STRIPE,
      orderType: PrismaOrderType.SUBSCRIPTION,
      checkoutProviderReference: 'cs_free',
    });
    deps.paymentRepo.findOrderById.mockResolvedValue(zeroValueOrder);
    deps.prisma.order.updateMany.mockResolvedValue({ count: 1 });
    deps.prisma.order.update.mockResolvedValue({});
    deps.prisma.order.findUnique.mockResolvedValue({
      ...zeroValueOrder,
      status: OrderStatus.PAID,
    });
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);
    deps.redis.set
      .mockResolvedValueOnce('OK')
      .mockResolvedValue(null);

    await expect(service.handleStripeEvent({
      id: 'evt_cs_free',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_free',
          metadata: { orderId: 'order-1' },
          mode: 'subscription',
          subscription: 'sub_free',
          amount_total: 0,
          currency: 'usd',
          payment_status: 'no_payment_required',
        },
      },
    })).resolves.toBeUndefined();

    expect(deps.prisma.order.updateMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({ id: 'order-1', status: OrderStatus.PENDING }),
      }),
    );
  });

  it('rejects no_payment_required for a positive-value Stripe order', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.prisma.order.findUnique.mockResolvedValue(makeOrder({
      amountCents: 9900,
      status: OrderStatus.PENDING,
      channel: PayChannel.STRIPE,
      orderType: PrismaOrderType.SUBSCRIPTION,
      checkoutProviderReference: 'cs_invalid_free',
    }));

    await expect(service.handleStripeEvent({
      id: 'evt_cs_invalid_free',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_invalid_free',
          metadata: { orderId: 'order-1' },
          mode: 'subscription',
          subscription: 'sub_invalid_free',
          amount_total: 0,
          currency: 'usd',
          payment_status: 'no_payment_required',
        },
      },
    })).rejects.toThrow('缺少已支付状态、有效金额或币种');

    expect(deps.prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('skips checkout.session.completed when metadata has no orderId', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    await service.handleStripeEvent({
      id: 'evt_cs_2',
      type: 'checkout.session.completed',
      data: { object: { id: 'cs_123', metadata: {}, mode: 'payment' } },
    });

    expect(deps.paymentRepo.findOrderById).not.toHaveBeenCalled();
  });

  it('does not mark Stripe checkout event processed when callback is rejected', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.paymentRepo.findOrderById.mockResolvedValue(
      makeOrder({ status: OrderStatus.PENDING, channel: PayChannel.STRIPE }),
    );
    deps.prisma.order.findUnique.mockResolvedValue({
      ...makeOrder({
        orderType: PrismaOrderType.RECHARGE,
        checkoutProviderReference: 'cs_rejected',
      }),
      paymentProviderInstanceId: null,
    });

    await expect(
      service.handleStripeEvent({
        id: 'evt_cs_rejected',
        type: 'checkout.session.completed',
        data: {
          object: {
            id: 'cs_rejected',
            metadata: { orderId: 'order-1' },
            mode: 'payment',
            amount_total: 123,
            currency: 'usd',
            payment_status: 'paid',
          },
        },
      }),
    ).rejects.toThrow('Stripe checkout callback not accepted');

    expect(deps.prisma.stripeEvent.update).not.toHaveBeenCalled();
  });

  it('rejects a checkout signed by a different Stripe provider instance', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.prisma.order.findUnique.mockResolvedValue({
      paymentProviderInstanceId: 'ppi_stripe_b',
    });

    await expect(service.handleStripeEvent({
      id: 'evt_cross_instance',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_cross_instance',
          metadata: { orderId: 'order-1' },
          mode: 'payment',
          amount_total: 9900,
          currency: 'usd',
          payment_status: 'paid',
        },
      },
    }, ['ppi_stripe_a'])).rejects.toThrow('Stripe webhook 支付实例不匹配');

    expect(deps.paymentRepo.findOrderById).not.toHaveBeenCalled();
    expect(deps.prisma.stripeEvent.update).not.toHaveBeenCalled();
  });

  it('rejects a paid checkout from the same Stripe instance but a different Session', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.prisma.order.findUnique.mockResolvedValue(
      makeOrder({
        channel: PayChannel.STRIPE,
        orderType: PrismaOrderType.RECHARGE,
        paymentProviderInstanceId: 'ppi_stripe_a',
        checkoutProviderReference: 'cs_expected',
        tradeNo: 'cs_expected',
      }),
    );

    await expect(service.handleStripeEvent({
      id: 'evt_wrong_session',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_attacker',
          metadata: { orderId: 'order-1' },
          mode: 'payment',
          amount_total: 9900,
          currency: 'usd',
          payment_status: 'paid',
        },
      },
    }, ['ppi_stripe_a'])).rejects.toThrow(
      'Stripe checkout Session 与订单不匹配',
    );

    expect(deps.paymentRepo.findOrderById).not.toHaveBeenCalled();
    expect(deps.prisma.stripeEvent.update).not.toHaveBeenCalled();
  });

  it('rejects a Checkout mode that conflicts with the order semantics', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.prisma.order.findUnique.mockResolvedValue(
      makeOrder({
        channel: PayChannel.STRIPE,
        orderType: PrismaOrderType.RECHARGE,
        checkoutProviderReference: 'cs_mode_mismatch',
        tradeNo: 'cs_mode_mismatch',
      }),
    );

    await expect(service.handleStripeEvent({
      id: 'evt_mode_mismatch',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_mode_mismatch',
          metadata: { orderId: 'order-1' },
          mode: 'subscription',
          subscription: 'sub_attacker',
          amount_total: 9900,
          currency: 'usd',
          payment_status: 'paid',
        },
      },
    })).rejects.toThrow('Stripe checkout mode 与订单语义不匹配');

    expect(deps.paymentRepo.findOrderById).not.toHaveBeenCalled();
    expect(deps.prisma.stripeEvent.update).not.toHaveBeenCalled();
  });

  it.each([
    [{ amount_total: 9900, currency: 'usd' }],
    [{ payment_status: 'paid', currency: 'usd' }],
    [{ payment_status: 'paid', amount_total: 9900 }],
  ])('rejects incomplete paid checkout facts: %o', async (facts) => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.prisma.order.findUnique.mockResolvedValue(
      makeOrder({
        orderType: PrismaOrderType.RECHARGE,
        checkoutProviderReference: 'cs_incomplete',
      }),
    );

    await expect(service.handleStripeEvent({
      id: `evt_missing_${Object.keys(facts).join('_')}`,
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_incomplete',
          metadata: { orderId: 'order-1' },
          mode: 'payment',
          ...facts,
        },
      },
    })).rejects.toThrow('Stripe checkout callback 缺少');

    expect(deps.paymentRepo.findOrderById).not.toHaveBeenCalled();
    expect(deps.prisma.stripeEvent.update).not.toHaveBeenCalled();
  });

  it('handles checkout.session.completed in subscription mode (uses subscription ID as tradeNo)', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.paymentRepo.findOrderById.mockResolvedValue(
      makeOrder({ status: OrderStatus.PAID, channel: PayChannel.STRIPE }),
    );
    deps.prisma.order.findUnique.mockResolvedValue(
      makeOrder({
        orderType: PrismaOrderType.SUBSCRIPTION,
        checkoutProviderReference: 'cs_sub',
      }),
    );

    await service.handleStripeEvent({
      id: 'evt_cs_sub',
      type: 'checkout.session.completed',
      data: {
        object: {
          id: 'cs_sub',
          metadata: { orderId: 'order-1' },
          mode: 'subscription',
          subscription: 'sub_xyz',
          amount_total: 9900,
          currency: 'usd',
          payment_status: 'paid',
        },
      },
    });

    // Idempotent since already PAID — just check it called findOrderById
    expect(deps.paymentRepo.findOrderById).toHaveBeenCalledWith('order-1');
  });

  it('skips invoice.paid when no subscription ID', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    await service.handleStripeEvent({
      id: 'evt_inv_1',
      type: 'invoice.paid',
      data: { object: { subscription: null, billing_reason: 'subscription_cycle' } },
    });

    expect(deps.prisma.order.findFirst).not.toHaveBeenCalled();
  });

  it('fails closed for historical invoice.paid without granting renewal quota', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.prisma.order.findFirst.mockResolvedValue({
      ...makeOrder(),
      plan: { id: 'plan-1', name: 'Pro', productId: 'prod-1', monthlyCredits: 500 },
    });
    deps.subscriptionResolver.resolve.mockResolvedValue({ subscriptionId: 'sub-1' });
    deps.creditService.grantQuota.mockResolvedValue(undefined);
    deps.prisma.user.findUnique.mockResolvedValue({ email: 'u@x.com' });
    deps.prisma.product.findUnique.mockResolvedValue({ slug: 'rdclaw' });

    await expect(service.handleStripeEvent({
      id: 'evt_inv_2',
      type: 'invoice.paid',
      data: {
        object: paidStandaloneRenewalInvoice(),
      },
    })).rejects.toThrow('automatic renewal is disabled');

    expect(deps.billingService.activateSubscription).not.toHaveBeenCalled();
    expect(deps.creditService.grantQuota).not.toHaveBeenCalled();
    expect(deps.prisma.stripeEvent.update).not.toHaveBeenCalled();
  });

  it('fails closed before applying any historical renewal with mismatched currency', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.prisma.order.findFirst.mockResolvedValue({
      ...makeOrder({ currency: 'usd' }),
      plan: { id: 'plan-1', name: 'Pro', productId: 'prod-1', monthlyCredits: 500 },
    });

    await expect(service.handleStripeEvent({
      id: 'evt_inv_currency_mismatch',
      type: 'invoice.paid',
      data: {
        object: paidStandaloneRenewalInvoice({
          id: 'in_currency_mismatch',
          currency: 'cny',
        }),
      },
    })).rejects.toThrow('automatic renewal is disabled');

    expect(deps.creditService.grantQuota).not.toHaveBeenCalled();
    expect(deps.prisma.stripeEvent.update).not.toHaveBeenCalled();
  });

  it('rejects a renewal signed by a different Stripe provider instance', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.prisma.order.findFirst.mockResolvedValue({
      ...makeOrder({ paymentProviderInstanceId: 'ppi_stripe_b' }),
      plan: { id: 'plan-1', name: 'Pro', productId: 'prod-1', monthlyCredits: 500 },
    });

    await expect(service.handleStripeEvent({
      id: 'evt_inv_cross_instance',
      type: 'invoice.paid',
      data: {
        object: {
          id: 'in_cross_instance',
          subscription: 'sub_123',
          billing_reason: 'subscription_cycle',
          currency: 'usd',
        },
      },
    }, ['ppi_stripe_a'])).rejects.toThrow('Stripe webhook 支付实例不匹配');

    expect(deps.creditService.grantQuota).not.toHaveBeenCalled();
    expect(deps.prisma.stripeEvent.update).not.toHaveBeenCalled();
  });

  it('fails closed for bundle renewal without durable provider item bindings', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.prisma.order.findFirst.mockResolvedValue({
      ...makeOrder({ orderType: PrismaOrderType.BUNDLE }),
      items: [
        {
          id: 'order-item-sub',
          productId: 'prod-a',
          planId: 'plan-a',
          name: 'Product A Yearly',
          plan: { id: 'plan-a', name: 'A Pro', monthlyCredits: 700 },
        },
      ],
    });
    deps.billingService.activateSubscription.mockResolvedValue({
      contractId: 'contract-local-a',
      periodId: 'sub-local-a',
      entitlementId: 'entitlement-local-a',
    });
    deps.subscriptionResolver.invalidateCache.mockResolvedValue(undefined);
    deps.subscriptionResolver.resolve.mockResolvedValue({ subscriptionId: 'sub-local-a' });
    deps.creditService.grantQuota.mockResolvedValue(undefined);
    deps.prisma.user.findUnique.mockResolvedValue({ email: 'u@x.com' });
    deps.prisma.product.findUnique.mockResolvedValue({ slug: 'prod-a' });

    await expect(service.handleStripeEvent({
      id: 'evt_inv_bundle',
      type: 'invoice.paid',
      data: {
        object: paidStandaloneRenewalInvoice({
          id: 'in_bundle_1',
          subscription: 'sub_stripe_bundle',
        }),
      },
    })).rejects.toThrow('bundle renewal lacks durable');

    expect(deps.billingService.activateSubscription).not.toHaveBeenCalled();
    expect(deps.creditService.grantQuota).not.toHaveBeenCalled();
    expect(deps.prisma.stripeEvent.update).not.toHaveBeenCalled();
  });

  it('fails closed when a disabled invoice.paid is missing invoice.id', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.prisma.order.findFirst.mockResolvedValue({
      ...makeOrder(),
      plan: { id: 'plan-1', name: 'Pro', productId: 'prod-1', monthlyCredits: 500 },
    });
    deps.subscriptionResolver.resolve.mockResolvedValue({ subscriptionId: 'sub-1' });
    deps.creditService.grantQuota.mockResolvedValue(undefined);
    deps.prisma.user.findUnique.mockResolvedValue({ email: 'u@x.com' });
    deps.prisma.product.findUnique.mockResolvedValue({ slug: 'rdclaw' });

    const errorSpy = jest
      .spyOn(Logger.prototype, 'error')
      .mockImplementation(() => {});

    try {
      await expect(service.handleStripeEvent({
        id: 'evt_inv_no_id',
        type: 'invoice.paid',
        data: {
          object: paidStandaloneRenewalInvoice({ id: undefined }),
        },
      })).rejects.toThrow('automatic renewal is disabled');

      expect(deps.creditService.grantQuota).not.toHaveBeenCalled();
      expect(errorSpy).toHaveBeenCalledWith(
        expect.stringContaining('automatic renewal is disabled'),
      );
    } finally {
      errorSpy.mockRestore();
    }
  });

  it('skips invoice.paid when billing_reason is not subscription_cycle', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    await service.handleStripeEvent({
      id: 'evt_inv_3',
      type: 'invoice.paid',
      data: { object: { subscription: 'sub_1', billing_reason: 'manual' } },
    });

    expect(deps.creditService.grantQuota).not.toHaveBeenCalled();
  });

  it('handles customer.subscription.deleted with an exact activation family', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    const order = makeOrder({
      status: OrderStatus.COMPLETED,
      channel: PayChannel.STRIPE,
      tradeNo: 'sub_abc',
      planId: 'plan-1',
      productId: 'prod-1',
      plan: {
        id: 'plan-1',
        productId: 'prod-1',
        product: { billingMode: ProductBillingMode.SUBSCRIPTION },
      },
      items: [],
    });
    deps.prisma.order.findFirst.mockResolvedValue(order);
    deps.prisma.order.findUnique.mockResolvedValue(order);

    await service.handleStripeEvent({
      id: 'evt_subdel_1',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_abc' } },
    });

    expect(deps.subscriptionLifecycle.closeActivationFamily).toHaveBeenCalledWith({
        initialActivationIdempotencyKey: 'checkout:order-1:activation',
        renewalActivationIdempotencyPrefix: 'stripe-renewal:order-1:',
        userId: 'user-1',
        tenantId: 'tenant-1',
        productId: 'prod-1',
        planId: 'plan-1',
        endedAt: expect.any(Date),
        terminationReason: 'stripe_subscription_canceled',
      });
    expect(deps.subscriptionLifecycle.closeActive).not.toHaveBeenCalled();
  });

  it('rejects a subscription deletion signed by a different Stripe provider instance', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const order = makeOrder({
        status: OrderStatus.COMPLETED,
        channel: PayChannel.STRIPE,
        tradeNo: 'sub_abc',
        planId: 'plan-1',
        productId: 'prod-1',
        paymentProviderInstanceId: 'ppi_stripe_b',
        plan: {
          id: 'plan-1',
          productId: 'prod-1',
          product: { billingMode: ProductBillingMode.SUBSCRIPTION },
        },
        items: [],
      });
    deps.prisma.order.findFirst.mockResolvedValue(order);
    deps.prisma.order.findUnique.mockResolvedValue(order);

    await expect(service.handleStripeEvent({
      id: 'evt_subdel_cross_instance',
      type: 'customer.subscription.deleted',
      data: { object: { id: 'sub_abc' } },
    }, ['ppi_stripe_a'])).rejects.toThrow('Stripe webhook 支付实例不匹配');

    expect(deps.subscriptionLifecycle.closeActivationFamily).not.toHaveBeenCalled();
    expect(deps.prisma.stripeEvent.update).not.toHaveBeenCalled();
  });

  it('skips customer.subscription.deleted when no subscription id', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    await service.handleStripeEvent({
      id: 'evt_subdel_2',
      type: 'customer.subscription.deleted',
      data: { object: {} },
    });

    expect(deps.prisma.order.findFirst).not.toHaveBeenCalled();
  });
});

// ============================================================
// handleStripeEvent — idempotency (Phase 3.2 Unit C.2)
// ============================================================
describe('PaymentService.handleStripeEvent idempotency', () => {
  it('skips processing if event.id already seen (P2002)', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.prisma.stripeEvent.create.mockRejectedValueOnce({ code: 'P2002' });
    deps.prisma.stripeEvent.findUnique.mockResolvedValueOnce({
      id: 'evt_abc123',
      processedAt: new Date(),
    });

    await service.handleStripeEvent({
      id: 'evt_abc123',
      type: 'invoice.paid',
      data: { object: { subscription: 'sub_x', billing_reason: 'subscription_cycle' } },
    });

    expect(deps.prisma.stripeEvent.create).toHaveBeenCalledTimes(1);
    // dedupe 短路：order.findFirst 不应被调
    expect(deps.prisma.order.findFirst).not.toHaveBeenCalled();
    // dedupe 短路：processedAt 也不应被更新（因为根本没进 try 块）
    expect(deps.prisma.stripeEvent.update).not.toHaveBeenCalled();
  });

  it('processes fresh event and marks processedAt', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.prisma.stripeEvent.create.mockResolvedValueOnce({ id: 'evt_fresh_1' });

    await service.handleStripeEvent({
      id: 'evt_fresh_1',
      type: 'unknown.type', // 未知 type，避免走 switch 分支
      data: { object: {} },
    });

    expect(deps.prisma.stripeEvent.create).toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({
          id: 'evt_fresh_1',
          type: 'unknown.type',
        }),
      }),
    );
    expect(deps.prisma.stripeEvent.update).toHaveBeenCalledWith(
      expect.objectContaining({
        where: { id: 'evt_fresh_1' },
        data: expect.objectContaining({ processedAt: expect.any(Date) }),
      }),
    );
  });

  it('rethrows non-P2002 errors from stripeEvent.create', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.prisma.stripeEvent.create.mockRejectedValueOnce(new Error('connection lost'));

    await expect(
      service.handleStripeEvent({
        id: 'evt_err_1',
        type: 'invoice.paid',
        data: { object: { subscription: 'sub_x' } },
      }),
    ).rejects.toThrow('connection lost');

    // 入口失败：业务逻辑不应执行
    expect(deps.prisma.order.findFirst).not.toHaveBeenCalled();
  });

  it('leaves processedAt empty if business logic throws so Stripe can retry', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.prisma.stripeEvent.create.mockResolvedValueOnce({ id: 'evt_throw_1' });
    // 让业务路径抛错：invoice.paid renewal 链路
    deps.prisma.order.findFirst.mockRejectedValueOnce(new Error('db down'));

    await expect(
      service.handleStripeEvent({
        id: 'evt_throw_1',
        type: 'invoice.paid',
        data: { object: { subscription: 'sub_x', billing_reason: 'subscription_cycle' } },
      }),
    ).rejects.toThrow('db down');

    // 业务失败不能标记 processedAt，否则 Stripe 重试会被错误跳过。
    expect(deps.prisma.stripeEvent.update).not.toHaveBeenCalled();
  });
});

// ============================================================
// refundOrder
// ============================================================
describe('PaymentService.refundOrder', () => {
  const selfOperatedRefundEvidence = {
    orderId: 'order-1',
    entitlementId: 'entitlement-self-1',
    userId: 'user-1',
    tenantId: 'tenant-1',
    productId: 'prod-coding-plan',
    planId: 'plan-1',
    grantId: 'grant-1',
    grantIdempotencyKey: 'checkout:order-1',
    grantCredits: 500,
    grantBalanceVersion: 1n,
  };

  function makeRefundableOrder(overrides = {}) {
    return makeOrder({
      status: OrderStatus.COMPLETED,
      tradeNo: 'TX-1',
      channel: PayChannel.WECHAT,
      paidAt: new Date('2025-01-10'),
      ...overrides,
    });
  }

  function makeSelfOperatedCodingPlanOrder(overrides = {}) {
    return makeRefundableOrder({
      orderType: PrismaOrderType.SUBSCRIPTION,
      productId: 'prod-coding-plan',
      planId: 'plan-1',
      channel: PayChannel.ALIPAY,
      plan: {
        id: 'plan-1',
        name: 'Tokenplan-Self',
        productId: 'prod-coding-plan',
        monthlyCredits: 500,
      },
      items: [],
      ...overrides,
    });
  }

  function configureSelfOperatedCodingPlanRefund(
    deps: ReturnType<typeof makeDeps>,
  ) {
    deps.prisma.codingPlanEntitlement.findUnique.mockResolvedValue({
      fulfillmentMode: CodingPlanFulfillmentMode.platform_model_package,
    });
    deps.refundCompensation.preflightUnusedSelfOperatedCodingPlanRefund
      .mockResolvedValue(selfOperatedRefundEvidence);
    deps.refundCompensation.assertUnusedSelfOperatedCodingPlanRefundHeld
      .mockResolvedValue(selfOperatedRefundEvidence);
  }

  it('throws BadRequestException when order not found', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.prisma.order.findUnique.mockResolvedValue(null);

    await expect(service.refundOrder('missing', '退款')).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequestException when order is in non-refundable status', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.prisma.order.findUnique.mockResolvedValue(
      makeOrder({ status: OrderStatus.PENDING }),
    );

    await expect(service.refundOrder('order-1', '退款')).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequestException when refund amount is 0', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.prisma.order.findUnique.mockResolvedValue(makeRefundableOrder());

    await expect(service.refundOrder('order-1', '退款', 0)).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequestException when refund amount exceeds order amount', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.prisma.order.findUnique.mockResolvedValue(makeRefundableOrder());

    await expect(service.refundOrder('order-1', '退款', 99999)).rejects.toThrow(BadRequestException);
  });

  it('throws BadRequestException when order has no tradeNo', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.prisma.order.findUnique.mockResolvedValue(
      makeRefundableOrder({ tradeNo: null }),
    );
    deps.prisma.order.update.mockResolvedValue({});
    deps.prisma.order.findUnique
      .mockResolvedValueOnce(makeRefundableOrder({ tradeNo: null })) // refundOrder findUnique
      .mockResolvedValueOnce(makeRefundableOrder({
        tradeNo: null,
        status: OrderStatus.REFUNDING,
      })); // REFUNDING→REFUND_FAILED
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);

    await expect(service.refundOrder('order-1', '退款')).rejects.toThrow(BadRequestException);
  });

  it('refunds WECHAT order and transitions to REFUNDED', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    const order = makeRefundableOrder({ channel: PayChannel.WECHAT });
    deps.prisma.order.findUnique.mockResolvedValue(order);
    deps.prisma.order.update.mockResolvedValue(order);
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);
    deps.wechatPayService.refund.mockResolvedValue({ success: true, refundId: 'ref-1' });

    const result = await service.refundOrder('order-1', '退款');
    expect(deps.wechatPayService.refund).toHaveBeenCalledWith(
      order.tradeNo,
      order.id,
      order.amountCents,
      9900,
      'refund_order-1_9900',
    );
    expect(deps.refundCompensation.prepareAndRun).toHaveBeenCalledWith(
      order,
      9900,
      { reason: '退款', trigger: 'inline' },
    );
    expect(result).toBeDefined();
  });

  it('refunds ALIPAY order', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    const order = makeRefundableOrder({ channel: PayChannel.ALIPAY });
    deps.prisma.order.findUnique.mockResolvedValue(order);
    deps.prisma.order.update.mockResolvedValue(order);
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);
    deps.alipayService.refund.mockResolvedValue({ success: true });

    const result = await service.refundOrder('order-1', '退款');
    expect(deps.alipayService.refund).toHaveBeenCalled();
    expect(deps.refundCompensation.prepareAndRun).toHaveBeenCalledWith(
      order,
      9900,
      { reason: '退款', trigger: 'inline' },
    );
    expect(result).toBeDefined();
  });

  it('refunds a fully unused self-operated Coding Plan through ALIPAY', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const order = makeSelfOperatedCodingPlanOrder();
    configureSelfOperatedCodingPlanRefund(deps);
    deps.prisma.product.findUnique.mockResolvedValue({
      billingMode: ProductBillingMode.CODING_PLAN,
      codingPlanFulfillmentMode: CodingPlanFulfillmentMode.provider_resale,
    });
    deps.prisma.order.findUnique.mockResolvedValue(order);
    deps.alipayService.refund.mockResolvedValue({ success: true });

    await service.refundOrder(order.id, '未使用退款');

    expect(
      deps.refundCompensation.preflightUnusedSelfOperatedCodingPlanRefund,
    ).toHaveBeenCalledWith(order, order.amountCents);
    expect(deps.providerRefundSaga.claimOrderAndPrepare)
      .toHaveBeenCalledWith(expect.objectContaining({
        orderId: order.id,
        amountCents: order.amountCents,
        selfOperatedCodingPlanRefund: selfOperatedRefundEvidence,
      }));
    expect(
      deps.refundCompensation.syncSelfOperatedCodingPlanRefundHoldRequired,
    ).toHaveBeenCalledWith(selfOperatedRefundEvidence.entitlementId);
    expect(
      deps.refundCompensation.assertUnusedSelfOperatedCodingPlanRefundHeld,
    ).toHaveBeenCalledWith(
      order,
      order.amountCents,
      selfOperatedRefundEvidence,
    );
    expect(deps.alipayService.refund).toHaveBeenCalledTimes(1);
    expect(deps.prisma.product.findUnique).not.toHaveBeenCalled();
  });

  it('does not call ALIPAY for a partial self-operated Coding Plan refund', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const order = makeSelfOperatedCodingPlanOrder();
    configureSelfOperatedCodingPlanRefund(deps);
    deps.prisma.order.findUnique.mockResolvedValue(order);
    deps.refundCompensation.preflightUnusedSelfOperatedCodingPlanRefund
      .mockRejectedValue(new Error('自营套餐仅支持整单全额退款'));

    await expect(
      service.refundOrder(order.id, '部分退款', order.amountCents - 1),
    ).rejects.toThrow('自营套餐仅支持整单全额退款');
    expect(deps.providerRefundSaga.claimOrderAndPrepare)
      .not.toHaveBeenCalled();
    expect(deps.alipayService.refund).not.toHaveBeenCalled();
  });

  it('does not call ALIPAY for a provider-resale Coding Plan', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const order = makeSelfOperatedCodingPlanOrder();
    deps.prisma.order.findUnique.mockResolvedValue(order);
    deps.prisma.codingPlanEntitlement.findUnique.mockResolvedValue({
      fulfillmentMode: CodingPlanFulfillmentMode.provider_resale,
    });

    await expect(
      service.refundOrder(order.id, '转售套餐退款'),
    ).rejects.toThrow('供应商转售套餐暂不支持自动退款');
    expect(
      deps.refundCompensation.preflightUnusedSelfOperatedCodingPlanRefund,
    ).not.toHaveBeenCalled();
    expect(deps.alipayService.refund).not.toHaveBeenCalled();
  });

  it('does not call ALIPAY when self-operated usage evidence is present', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const order = makeSelfOperatedCodingPlanOrder();
    configureSelfOperatedCodingPlanRefund(deps);
    deps.prisma.order.findUnique.mockResolvedValue(order);
    deps.refundCompensation.preflightUnusedSelfOperatedCodingPlanRefund
      .mockRejectedValue(
        new Error('该套餐已产生用量、额度变化或请求记录，不能自动退款'),
      );

    await expect(
      service.refundOrder(order.id, '已使用退款'),
    ).rejects.toThrow('已产生用量');
    expect(deps.providerRefundSaga.claimOrderAndPrepare)
      .not.toHaveBeenCalled();
    expect(deps.alipayService.refund).not.toHaveBeenCalled();
  });

  it('keeps the held refund retryable when Publisher closure fails', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const order = makeSelfOperatedCodingPlanOrder();
    configureSelfOperatedCodingPlanRefund(deps);
    deps.prisma.order.findUnique.mockResolvedValue(order);
    deps.refundCompensation.syncSelfOperatedCodingPlanRefundHoldRequired
      .mockRejectedValue(
        new SelfOperatedCodingPlanRefundHoldRetryError(
          'Publisher 退款关闸失败，已等待自动重试',
        ),
      );

    await expect(
      service.refundOrder(order.id, '未使用退款'),
    ).rejects.toThrow(ServiceUnavailableException);
    expect(deps.providerRefundSaga.recordProviderOutcome)
      .toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          state: 'NOT_FOUND',
          providerStatus: 'LOCAL_REFUND_HOLD_RETRY',
        }),
      );
    expect(deps.alipayService.refund).not.toHaveBeenCalled();
  });

  it('refunds ALIPAY order with credentials from the bound Admin instance', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    const order = makeRefundableOrder({
      channel: PayChannel.ALIPAY,
      paymentProviderInstanceId: 'ppi_alipay_1',
    });
    deps.paymentProviderRegistry.getInstanceById.mockResolvedValue({
      id: 'ppi_alipay_1',
      providerKey: 'alipay',
      name: 'Alipay Sandbox',
      config: {
        appId: '9021000164665533',
        privateKey: 'app-private-key',
        alipayPublicKey: 'alipay-public-key',
        gateway: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
        keyType: 'PKCS8',
      },
      supportedTypes: [],
      isActive: true,
      dailyLimitCents: 0,
    });
    deps.prisma.order.findUnique.mockResolvedValue(order);
    deps.prisma.order.update.mockResolvedValue(order);
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);
    deps.alipayService.refund.mockResolvedValue({ success: true });

    await service.refundOrder('order-1', '退款');

    expect(deps.paymentProviderRegistry.getInstanceById).toHaveBeenCalledWith('ppi_alipay_1');
    expect(deps.alipayService.refund).toHaveBeenCalledWith(
      order.tradeNo,
      order.amountCents,
      '退款',
      expect.objectContaining({
        appId: '9021000164665533',
        gateway: 'https://openapi-sandbox.dl.alipaydev.com/gateway.do',
        keyType: 'PKCS8',
      }),
      'refund_order-1_9900',
    );
  });

  it('refunds STRIPE order', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    const order = makeRefundableOrder({ channel: PayChannel.STRIPE });
    deps.prisma.order.findUnique.mockResolvedValue(order);
    deps.prisma.order.update.mockResolvedValue(order);
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);
    deps.stripeService.refundViaSessionOrSubscription.mockResolvedValue({ success: true, refundId: 'ref-s' });

    const result = await service.refundOrder('order-1', '退款');
    expect(deps.stripeService.refundViaSessionOrSubscription).toHaveBeenCalledWith(
      order.tradeNo,
      9900,
      undefined,
      'refund:order-1:9900',
      undefined,
    );
    expect(deps.refundCompensation.prepareAndRun).toHaveBeenCalledWith(
      order,
      9900,
      { reason: '退款', trigger: 'inline' },
    );
    expect(result).toBeDefined();
  });

  it('rejects a duplicate refund while the order refund lock is held', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.redis.set.mockResolvedValueOnce(null);

    await expect(service.refundOrder('order-1', '退款')).rejects.toThrow(ConflictException);

    expect(deps.prisma.order.findUnique).not.toHaveBeenCalled();
    expect(deps.wechatPayService.refund).not.toHaveBeenCalled();
    expect(deps.redis.eval).not.toHaveBeenCalled();
  });

  it('does not call the payment channel when the REFUNDING claim loses the CAS race', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const order = makeRefundableOrder({ channel: PayChannel.WECHAT });
    deps.prisma.order.findUnique.mockResolvedValue(order);
    deps.providerRefundSaga.claimOrderAndPrepare.mockRejectedValueOnce(
      new Error('provider refund order claim conflict: order-1'),
    );

    await expect(service.refundOrder('order-1', '退款')).rejects.toThrow(ConflictException);

    expect(
      deps.providerRefundSaga.claimOrderAndPrepare,
    ).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'order-1',
      fromStatus: OrderStatus.COMPLETED,
      amountCents: 9900,
    }));
    expect(deps.wechatPayService.refund).not.toHaveBeenCalled();
  });

  it('atomically rolls back the Stripe subscription claim when intent creation fails', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const order = makeRefundableOrder({
      orderType: PrismaOrderType.BUNDLE,
      channel: PayChannel.STRIPE,
      tradeNo: 'sub_crash_window',
      items: [],
    });
    const state = setupStatefulOrderTransactions(deps, order);
    deps.prisma.stripeSubscriptionCancellationTask.create
      .mockRejectedValueOnce(new Error('intent database unavailable'));

    await expect(
      service.refundOrder('order-1', '退款'),
    ).rejects.toThrow('intent database unavailable');

    expect(state.getOrder().status).toBe(OrderStatus.COMPLETED);
    expect(
      deps.prisma.stripeSubscriptionCancellationTask.create,
    ).toHaveBeenCalledWith({
      data: expect.objectContaining({
        orderId: 'order-1',
        subscriptionId: 'sub_crash_window',
        refundId: null,
        status: RefundCompensationTaskStatus.RUNNING,
        lockedBy: expect.stringMatching(/^stripe-cancellation:/),
        lockedAt: expect.any(Date),
      }),
    });
    expect(
      deps.stripeService.refundViaSessionOrSubscription,
    ).not.toHaveBeenCalled();
  });

  it('waits for a pending Stripe refund before canceling and compensating locally', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const order = makeRefundableOrder({
      orderType: PrismaOrderType.BUNDLE,
      channel: PayChannel.STRIPE,
      tradeNo: 'sub_pending_refund',
      items: [],
    });
    setupStatefulOrderTransactions(deps, order);
    let taskState: Record<string, any> | null = null;
    deps.prisma.stripeSubscriptionCancellationTask.create
      .mockImplementation(async ({ data }: any) => {
        taskState = {
          id: 'stripe-cancel-task-1',
          ...data,
          createdAt: new Date(),
          updatedAt: new Date(),
        };
        return taskState;
      });
    deps.prisma.stripeSubscriptionCancellationTask.findUnique
      .mockImplementation(async () => taskState);
    deps.prisma.stripeSubscriptionCancellationTask.updateMany
      .mockImplementation(async ({ data }: any) => {
        if (!taskState) return { count: 0 };
        const next = { ...data };
        if (next.attempts?.increment) {
          next.attempts =
            (taskState.attempts ?? 0) + next.attempts.increment;
        }
        taskState = { ...taskState, ...next, updatedAt: new Date() };
        return { count: 1 };
      });
    deps.stripeService.refundViaSessionOrSubscription
      .mockResolvedValueOnce({
        success: false,
        refundId: 'ref_pending',
        refundStatus: 'pending',
        providerRefundPending: true,
        subscriptionId: 'sub_pending_refund',
        refundedInvoiceId: 'in_refund_exact',
        error:
          'Stripe refund ref_pending has not succeeded: status=pending',
      });

    await expect(
      service.refundOrder('order-1', '退款'),
    ).rejects.toThrow('status=pending');

    expect(taskState).toEqual(expect.objectContaining({
      refundId: 'ref_pending',
      providerCanceledAt: null,
      status: RefundCompensationTaskStatus.FAILED,
    }));
    expect(deps.stripeService.cancelSubscription).not.toHaveBeenCalled();
    expect(deps.refundCompensation.prepareAndRun).not.toHaveBeenCalled();

    deps.prisma.stripeSubscriptionCancellationTask.findMany
      .mockImplementation(async () => [taskState]);
    deps.stripeService.retrieveRefundStatus
      .mockResolvedValueOnce('succeeded');
    deps.stripeService.retrieveRefundLedgerSnapshot
      .mockRejectedValueOnce(new Error('Stripe ledger API unavailable'));
    deps.stripeService.cancelSubscription
      .mockResolvedValueOnce(undefined);

    const recovered =
      await service.runDueStripeSubscriptionCancellationTasks();

    expect(
      deps.stripeService.retrieveRefundStatus,
    ).toHaveBeenCalledWith('ref_pending', undefined);
    expect(deps.stripeService.cancelSubscription)
      .toHaveBeenCalledWith('sub_pending_refund', undefined);
    expect(deps.prisma.alertEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        severity: AlertEventSeverity.CRITICAL,
        title: 'Stripe退款台账记录失败',
        sourceId: 'order-1',
        context: expect.stringContaining(
          '"stripeSubscriptionCancellationTaskId":"stripe-cancel-task-1"',
        ),
      }),
    });
    expect(deps.refundCompensation.prepareAndRun)
      .toHaveBeenCalledTimes(1);
    expect(recovered).toEqual({
      tasks: 1,
      completed: 1,
      failed: 0,
      manualReview: 0,
    });
  });

  it('does not let a stale Stripe inline lease persist after the task is reclaimed', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.prisma.stripeSubscriptionCancellationTask.findUnique
      .mockResolvedValue({
        id: 'stripe-task-1',
        orderId: 'order-1',
        subscriptionId: 'sub_1',
        refundedInvoiceId: 'in_1',
        paymentProviderInstanceId: null,
        refundId: null,
        providerCanceledAt: null,
        attempts: 2,
        status: RefundCompensationTaskStatus.RUNNING,
        lockedBy: 'stripe-cancellation:new-worker',
      });
    deps.prisma.stripeSubscriptionCancellationTask.updateMany
      .mockResolvedValue({ count: 0 });

    await expect(
      (service as any).persistStripeSubscriptionCancellationTask({
        orderId: 'order-1',
        subscriptionId: 'sub_1',
        refundId: 're_1',
        refundedInvoiceId: 'in_1',
        paymentProviderInstanceId: null,
        providerCanceledAt: new Date(),
        leaseId: 'stripe-cancellation:stale-inline',
      }),
    ).rejects.toThrow('lease lost');

    expect(
      deps.prisma.stripeSubscriptionCancellationTask.updateMany,
    ).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        id: 'stripe-task-1',
        lockedBy: 'stripe-cancellation:stale-inline',
      }),
    }));
  });

  it('atomically persists Stripe cancellation MANUAL_REVIEW with its CRITICAL alert', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const leaseId = 'stripe-cancellation:manual-review';
    let taskState: Record<string, any> = {
      id: 'stripe-task-manual-review',
      orderId: 'order-1',
      subscriptionId: 'sub_manual_review',
      refundId: 're_succeeded',
      refundedInvoiceId: 'in_exact',
      refundedActivationIdempotencyKey: 'stripe:invoice:in_exact',
      refundedSubscriptionPeriodId: 'period-1',
      originalGrantIdempotencyKey: null,
      skipEntitlementCompensation: false,
      paymentProviderInstanceId: 'provider-stripe-1',
      status: RefundCompensationTaskStatus.RUNNING,
      providerCanceledAt: null,
      attempts: 12,
      maxAttempts: 12,
      nextRunAt: new Date(),
      lockedAt: new Date(),
      lockedBy: leaseId,
      lastError: null,
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const alerts: Record<string, any>[] = [];
    let rejectAlertWrite = true;

    deps.prisma.$transaction.mockImplementation(async (callback: any) => {
      const taskBefore = { ...taskState };
      const alertsBefore = [...alerts];
      try {
        return await callback({
          stripeSubscriptionCancellationTask: {
            updateMany: jest.fn(async ({ where, data }: any) => {
              if (
                taskState.id !== where.id
                || taskState.status !== where.status
                || taskState.lockedBy !== where.lockedBy
              ) {
                return { count: 0 };
              }
              taskState = { ...taskState, ...data };
              return { count: 1 };
            }),
          },
          alertEvent: {
            create: jest.fn(async ({ data }: any) => {
              if (rejectAlertWrite) {
                throw new Error('alert database unavailable');
              }
              alerts.push(data);
              return data;
            }),
          },
        });
      } catch (err) {
        taskState = taskBefore;
        alerts.splice(0, alerts.length, ...alertsBefore);
        throw err;
      }
    });

    await expect(
      (service as any).markStripeCancellationTaskFailed(
        taskState,
        'Stripe cancellation failed',
        leaseId,
      ),
    ).rejects.toThrow('alert database unavailable');
    expect(taskState).toEqual(expect.objectContaining({
      status: RefundCompensationTaskStatus.RUNNING,
      lockedBy: leaseId,
    }));
    expect(alerts).toHaveLength(0);

    rejectAlertWrite = false;
    await (service as any).markStripeCancellationTaskFailed(
      taskState,
      'Stripe cancellation failed',
      leaseId,
    );

    expect(taskState).toEqual(expect.objectContaining({
      status: RefundCompensationTaskStatus.MANUAL_REVIEW,
      lockedAt: null,
      lockedBy: null,
      lastError: 'Stripe cancellation failed',
    }));
    expect(alerts).toEqual([
      expect.objectContaining({
        category: AlertEventCategory.PAYMENT,
        severity: AlertEventSeverity.CRITICAL,
        title: 'Stripe订阅取消进入人工处理',
        sourceType: 'order',
        sourceId: 'order-1',
        context: expect.stringContaining('"taskId":"stripe-task-manual-review"'),
      }),
    ]);
  });

  it('marks refund compensation failed when channel refund succeeds but internal reversal fails', async () => {
    const deps = makeDeps();
    const alertEvents = { createAlert: jest.fn().mockResolvedValue(null) };
    const service = await buildServiceWithAlerts(deps, alertEvents);

    const order = makeRefundableOrder({
      orderType: PrismaOrderType.SUBSCRIPTION,
      planId: 'plan-1',
      channel: PayChannel.WECHAT,
      plan: {
        id: 'plan-1',
        name: 'Pro',
        productId: 'prod-1',
        monthlyCredits: 0,
      },
    });
    deps.prisma.order.findUnique
      .mockResolvedValueOnce(order)
      .mockResolvedValueOnce({ ...order, status: OrderStatus.REFUNDING });
    deps.prisma.order.update.mockResolvedValue(order);
    deps.prisma.$transaction.mockImplementation(async (cb: any) => cb({
      order: { updateMany: deps.prisma.order.updateMany },
      orderAuditLog: { create: deps.prisma.orderAuditLog.create },
      stripeSubscriptionCancellationTask: {
        create:
          deps.prisma.stripeSubscriptionCancellationTask.create,
      },
    }));
    deps.wechatPayService.refund.mockResolvedValue({ success: true, refundId: 'ref-1' });
    deps.refundCompensation.prepareAndRun.mockResolvedValueOnce({
      complete: false,
      executed: 1,
      failed: 1,
      pending: 0,
      manualReview: 0,
      error: 'close failed',
    });

    await expect(service.refundOrder('order-1', '退款')).rejects.toThrow(ServiceUnavailableException);

    expect(deps.wechatPayService.refund).toHaveBeenCalled();
    expect(deps.refundCompensation.prepareAndRun).toHaveBeenCalledWith(
      order,
      9900,
      { reason: '退款', trigger: 'inline' },
    );
    expect(deps.prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', status: OrderStatus.REFUNDING },
      data: expect.objectContaining({
        status: OrderStatus.REFUND_COMPENSATION_FAILED,
        refundedAt: expect.any(Date),
      }),
    });
    expect(deps.prisma.order.updateMany).not.toHaveBeenCalledWith(
      expect.objectContaining({
        data: expect.objectContaining({ status: OrderStatus.REFUNDED }),
      }),
    );
    expect(alertEvents.createAlert).toHaveBeenCalledWith(
      expect.objectContaining({
        category: 'PAYMENT',
        severity: 'CRITICAL',
        title: '退款补偿失败',
        sourceType: 'order',
        sourceId: 'order-1',
        context: expect.objectContaining({
          orderType: PrismaOrderType.SUBSCRIPTION,
          channel: PayChannel.WECHAT,
          refundAmountCents: 9900,
        }),
      }),
    );
  });

  it('marks refund compensation failed when bundle compensation task runner reports failure', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    const order = makeOrder({
      id: 'order-bundle',
      orderType: PrismaOrderType.BUNDLE,
      status: OrderStatus.PARTIALLY_FULFILLED_REQUIRES_COMPENSATION,
      paidAt: new Date(),
      tradeNo: 'sub_bundle',
      channel: PayChannel.STRIPE,
      amountCents: 12900,
      plan: null,
      boosterPack: null,
      items: [],
    });

    deps.prisma.order.findUnique
      .mockResolvedValueOnce(order)
      .mockResolvedValueOnce({ ...order, status: OrderStatus.REFUNDING });
    deps.prisma.order.update.mockResolvedValue(order);
    deps.prisma.$transaction.mockImplementation(async (cb: any) => cb({
      order: { updateMany: deps.prisma.order.updateMany },
      orderAuditLog: { create: deps.prisma.orderAuditLog.create },
      stripeSubscriptionCancellationTask: {
        create:
          deps.prisma.stripeSubscriptionCancellationTask.create,
      },
    }));
    deps.stripeService.refundViaSessionOrSubscription.mockResolvedValue({ success: true, refundId: 'ref-bundle' });
    deps.refundCompensation.prepareAndRun.mockResolvedValueOnce({
      complete: false,
      executed: 1,
      failed: 1,
      pending: 0,
      manualReview: 0,
      error: 'close failed',
    });

    await expect(service.refundOrder('order-bundle', '退款')).rejects.toThrow(ServiceUnavailableException);

    expect(deps.refundCompensation.prepareAndRun).toHaveBeenCalledWith(
      order,
      12900,
      { reason: '退款', trigger: 'inline' },
    );
    expect(deps.prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-bundle', status: OrderStatus.REFUNDING },
      data: expect.objectContaining({
        status: OrderStatus.REFUND_COMPENSATION_FAILED,
      }),
    });
  });

  it('rejects changing refund amount when retrying internal compensation', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.prisma.order.findUnique.mockResolvedValue(makeOrder({
      status: OrderStatus.REFUND_COMPENSATION_FAILED,
      tradeNo: 'TX-1',
      refundAmountCents: 5000,
    }));

    await expect(service.refundOrder('order-1', '重试补偿', 4000)).rejects.toThrow(
      '退款补偿重试必须使用原退款金额',
    );
    expect(deps.prisma.order.update).not.toHaveBeenCalled();
    expect(deps.wechatPayService.refund).not.toHaveBeenCalled();
  });

  it('delegates RECHARGE refund compensation with the requested partial amount', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    const order = makeRefundableOrder({
      orderType: PrismaOrderType.RECHARGE,
      productId: 'payg-1',
      amountCents: 10000,
      channel: PayChannel.WECHAT,
      plan: null,
      boosterPack: null,
    });
    setupStatefulOrderTransactions(deps, order);
    deps.prisma.balanceTransaction.findFirst.mockResolvedValue({ id: 'recharge-tx-1' });
    deps.wechatPayService.refund.mockResolvedValue({ success: true, refundId: 'ref-1' });

    await service.refundOrder('order-1', '退款', 5000);

    expect(deps.refundCompensation.prepareAndRun).toHaveBeenCalledWith(
      order,
      5000,
      { reason: '退款', trigger: 'inline' },
    );
  });

  it('re-derives channel-only compensation from missing wallet effects on REFUND_FAILED retry', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const order = makeRefundableOrder({
      orderType: PrismaOrderType.RECHARGE,
      status: OrderStatus.REFUND_FAILED,
      refundAmountCents: 9900,
      plan: null,
      boosterPack: null,
    });
    const state = setupStatefulOrderTransactions(deps, order);
    deps.wechatPayService.refund.mockResolvedValue({ success: true, refundId: 'ref-retry' });
    deps.refundCompensation.prepareAndRun.mockImplementationOnce(async () => {
      state.setStatus(OrderStatus.REFUNDED);
      return { complete: true, executed: 0, failed: 0, pending: 0, manualReview: 0 };
    });

    await service.refundOrder('order-1', '重试自动退款');

    expect(deps.wechatPayService.refund).toHaveBeenCalledTimes(1);
    expect(deps.refundCompensation.prepareAndRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'order-1', status: OrderStatus.REFUND_FAILED }),
      9900,
      expect.objectContaining({
        trigger: 'inline',
        skipRechargeBalanceCompensation: true,
      }),
    );
    expect(state.getOrder().status).toBe(OrderStatus.REFUNDED);
  });

  it('re-derives channel-only compensation on REFUND_COMPENSATION_FAILED without refunding twice', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const order = makeRefundableOrder({
      orderType: PrismaOrderType.RECHARGE,
      status: OrderStatus.REFUND_COMPENSATION_FAILED,
      refundAmountCents: 9900,
      plan: null,
      boosterPack: null,
    });
    const state = setupStatefulOrderTransactions(deps, order);
    deps.refundCompensation.prepareAndRun.mockImplementationOnce(async () => {
      state.setStatus(OrderStatus.REFUNDED);
      return { complete: true, executed: 0, failed: 0, pending: 0, manualReview: 0 };
    });

    await service.refundOrder('order-1', '重试内部补偿');

    expect(deps.wechatPayService.refund).not.toHaveBeenCalled();
    expect(deps.refundCompensation.prepareAndRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'order-1', status: OrderStatus.REFUND_COMPENSATION_FAILED }),
      9900,
      expect.objectContaining({
        trigger: 'manual-retry',
        skipRechargeBalanceCompensation: true,
      }),
    );
    expect(state.getOrder().status).toBe(OrderStatus.REFUNDED);
  });

  it.each([
    ['recharge transaction', { transaction: { id: 'recharge-tx-1' }, grant: null }],
    ['balance grant', { transaction: null, grant: { id: 'grant-1' } }],
  ])('refuses channel-only refund when a %s already exists', async (_label, artifact) => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const order = makeRefundableOrder({
      orderType: PrismaOrderType.RECHARGE,
      status: OrderStatus.FULFILLING,
      plan: null,
      boosterPack: null,
    });
    const state = setupStatefulOrderTransactions(deps, order);
    deps.prisma.balanceTransaction.findFirst.mockResolvedValue(artifact.transaction);
    deps.prisma.balanceGrant.findUnique.mockResolvedValue(artifact.grant);

    await expect(service.refundOrder(
      'order-1',
      '充值主体变化自动退款',
      undefined,
      { skipRechargeBalanceCompensation: true },
    )).rejects.toThrow('充值订单已产生余额效果');

    expect(deps.wechatPayService.refund).not.toHaveBeenCalled();
    // conflict is raised inside the claim transaction, so REFUNDING must roll back.
    expect(state.getOrder().status).toBe(OrderStatus.FULFILLING);
  });

  it('returns REFUND_FAILED and throws when refund via channel fails', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    const order = makeRefundableOrder({ channel: PayChannel.WECHAT });
    deps.prisma.order.findUnique
      .mockResolvedValueOnce(order)
      .mockResolvedValueOnce({ ...order, status: OrderStatus.REFUNDING });
    deps.prisma.order.update.mockResolvedValue(order);
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);
    deps.wechatPayService.refund.mockResolvedValue({
      success: false,
      state: 'FAILED',
      providerStatus: 'CLOSED',
      error: 'rejected',
    });

    await expect(service.refundOrder('order-1', '退款')).rejects.toThrow(BadRequestException);
  });

  it('fails closed instead of replaying a generic provider refund with a terminal intent', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const order = makeRefundableOrder({
      channel: PayChannel.WECHAT,
      status: OrderStatus.REFUND_FAILED,
    });
    deps.prisma.order.findUnique.mockResolvedValue(order);
    deps.providerRefundSaga.findByOrderId.mockResolvedValue({
      id: 'provider-refund-intent-terminal',
      orderId: order.id,
      status: ProviderRefundIntentStatus.PROVIDER_FAILED,
    });

    await expect(service.refundOrder('order-1', '再次退款'))
      .rejects.toThrow('已有终态退款记录');

    expect(deps.providerRefundSaga.claimOrderAndPrepare).not.toHaveBeenCalled();
    expect(deps.wechatPayService.refund).not.toHaveBeenCalled();
  });

  it('recovers a pending WeChat refund by query and compensates only after terminal success', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const order = makeRefundableOrder({
      status: OrderStatus.REFUNDING,
      refundAmountCents: 9900,
    });
    const task = {
      id: 'provider-refund-wx-1',
      orderId: order.id,
      channel: PayChannel.WECHAT,
      tradeNo: order.tradeNo,
      requestNo: 'refund_order-1_9900',
      providerRefundId: 'wx-refund-1',
      amountCents: 9900,
      currency: 'USD',
      reason: '退款',
      paymentProviderInstanceId: null,
      skipEntitlementCompensation: false,
      skipRechargeBalanceCompensation: false,
      preflightCompletedAt: new Date(),
      status: ProviderRefundIntentStatus.PENDING_PROVIDER,
      providerStatus: 'PROCESSING',
      providerAttemptedAt: new Date(),
      providerConfirmedAt: null,
      attempts: 1,
      maxAttempts: 12,
      nextRunAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    deps.providerRefundSaga.findDue.mockResolvedValue([task]);
    deps.providerRefundSaga.claim
      .mockResolvedValueOnce({
        task: { ...task, status: ProviderRefundIntentStatus.RUNNING },
        leaseId: 'provider-refund:query',
        previousStatus: ProviderRefundIntentStatus.PENDING_PROVIDER,
      })
      .mockResolvedValueOnce({
        task: {
          ...task,
          status: ProviderRefundIntentStatus.RUNNING,
          providerConfirmedAt: new Date(),
          providerStatus: 'SUCCESS',
        },
        leaseId: 'provider-refund:compensate',
        previousStatus: ProviderRefundIntentStatus.PROVIDER_SUCCEEDED,
      });
    deps.wechatPayService.queryRefund.mockResolvedValue({
      state: 'SUCCEEDED',
      providerStatus: 'SUCCESS',
      refundId: 'wx-refund-1',
    });
    deps.providerRefundSaga.recordProviderOutcome.mockResolvedValue(
      ProviderRefundIntentStatus.PROVIDER_SUCCEEDED,
    );
    deps.prisma.order.findUnique
      .mockResolvedValueOnce(order)
      .mockResolvedValueOnce({ status: OrderStatus.REFUNDED });
    deps.providerRefundSaga.findByOrderId.mockResolvedValue({
      ...task,
      status: ProviderRefundIntentStatus.COMPLETED,
    });

    await expect(service.runDueProviderRefundIntents()).resolves.toEqual({
      tasks: 1,
      completed: 1,
      pending: 0,
      failed: 0,
      manualReview: 0,
    });

    expect(deps.wechatPayService.queryRefund)
      .toHaveBeenCalledWith('refund_order-1_9900');
    expect(deps.refundCompensation.prepareAndRun).toHaveBeenCalledWith(
      order,
      9900,
      expect.objectContaining({ trigger: 'provider-refund-worker' }),
    );
    expect(deps.providerRefundSaga.markCompleted).toHaveBeenCalledWith(
      expect.objectContaining({
        leaseId: 'provider-refund:compensate',
      }),
    );
  });

  it('revalidates a held self-operated entitlement on worker submission despite product config drift', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const order = makeSelfOperatedCodingPlanOrder({
      status: OrderStatus.REFUNDING,
      refundAmountCents: 9900,
    });
    const task = {
      id: 'provider-refund-self-1',
      orderId: order.id,
      channel: order.channel,
      tradeNo: order.tradeNo,
      requestNo: 'refund_order-1_9900',
      providerRefundId: null,
      amountCents: 9900,
      currency: order.currency.toUpperCase(),
      reason: '未使用退款',
      paymentProviderInstanceId: order.paymentProviderInstanceId,
      skipEntitlementCompensation: false,
      skipRechargeBalanceCompensation: false,
      preflightCompletedAt: new Date(),
      status: ProviderRefundIntentStatus.PREPARED,
      providerStatus: null,
      providerAttemptedAt: null,
      providerConfirmedAt: null,
      attempts: 1,
      maxAttempts: 12,
      nextRunAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    deps.prisma.product.findUnique.mockResolvedValue({
      billingMode: ProductBillingMode.CODING_PLAN,
      codingPlanFulfillmentMode: CodingPlanFulfillmentMode.provider_resale,
    });
    deps.prisma.codingPlanEntitlement.findUnique.mockResolvedValue({
      fulfillmentMode: CodingPlanFulfillmentMode.platform_model_package,
    });
    deps.refundCompensation.assertUnusedSelfOperatedCodingPlanRefundHeld
      .mockResolvedValue(selfOperatedRefundEvidence);
    deps.providerRefundSaga.findDue.mockResolvedValue([task]);
    deps.providerRefundSaga.claim.mockResolvedValueOnce({
      task: { ...task, status: ProviderRefundIntentStatus.RUNNING },
      leaseId: 'provider-refund:self-submit',
      previousStatus: ProviderRefundIntentStatus.PREPARED,
    });
    deps.providerRefundSaga.recordProviderOutcome.mockResolvedValue(
      ProviderRefundIntentStatus.PENDING_PROVIDER,
    );
    deps.providerRefundSaga.findByOrderId.mockResolvedValue({
      ...task,
      status: ProviderRefundIntentStatus.PENDING_PROVIDER,
    });
    deps.prisma.order.findUnique.mockResolvedValue(order);
    deps.alipayService.refund.mockResolvedValue({
      success: false,
      state: 'PENDING',
      providerStatus: 'PROCESSING',
    });

    await expect(service.runDueProviderRefundIntents()).resolves.toMatchObject({
      tasks: 1,
      pending: 1,
    });

    expect(
      deps.refundCompensation.syncSelfOperatedCodingPlanRefundHoldRequired,
    ).toHaveBeenCalledWith(selfOperatedRefundEvidence.entitlementId);
    expect(deps.alipayService.refund).toHaveBeenCalledTimes(1);
    expect(deps.prisma.product.findUnique).not.toHaveBeenCalled();
  });

  it('re-submits Stripe one-time recovery with the same idempotency key and does not compensate while requires_action', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const order = makeRefundableOrder({
      status: OrderStatus.REFUNDING,
      channel: PayChannel.STRIPE,
      tradeNo: 'cs_one_time_1',
      refundAmountCents: 9900,
    });
    const task = {
      id: 'provider-refund-stripe-1',
      orderId: order.id,
      channel: PayChannel.STRIPE,
      tradeNo: order.tradeNo,
      requestNo: 'refund_order-1_9900',
      providerRefundId: null,
      amountCents: 9900,
      currency: 'USD',
      reason: '退款',
      paymentProviderInstanceId: null,
      skipEntitlementCompensation: false,
      skipRechargeBalanceCompensation: false,
      preflightCompletedAt: new Date(),
      status: ProviderRefundIntentStatus.PENDING_PROVIDER,
      providerStatus: 'REQUEST_OUTCOME_UNKNOWN',
      providerAttemptedAt: new Date(),
      providerConfirmedAt: null,
      attempts: 1,
      maxAttempts: 12,
      nextRunAt: new Date(),
      lockedAt: null,
      lockedBy: null,
      lastError: null,
      completedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    deps.providerRefundSaga.findDue.mockResolvedValue([task]);
    deps.providerRefundSaga.claim.mockResolvedValueOnce({
      task: { ...task, status: ProviderRefundIntentStatus.RUNNING },
      leaseId: 'provider-refund:stripe-query',
      previousStatus: ProviderRefundIntentStatus.PENDING_PROVIDER,
    });
    deps.prisma.order.findUnique.mockResolvedValue(order);
    deps.stripeService.refundViaSessionOrSubscription.mockResolvedValue({
      success: false,
      refundId: 're_pending_1',
      refundStatus: 'requires_action',
      providerRefundPending: true,
      error: 'refund requires action',
    });
    deps.providerRefundSaga.recordProviderOutcome.mockResolvedValue(
      ProviderRefundIntentStatus.PENDING_PROVIDER,
    );
    deps.providerRefundSaga.findByOrderId.mockResolvedValue({
      ...task,
      providerRefundId: 're_pending_1',
      status: ProviderRefundIntentStatus.PENDING_PROVIDER,
    });

    await expect(service.runDueProviderRefundIntents()).resolves.toEqual({
      tasks: 1,
      completed: 0,
      pending: 1,
      failed: 0,
      manualReview: 0,
    });

    expect(deps.stripeService.refundViaSessionOrSubscription)
      .toHaveBeenCalledWith(
        'cs_one_time_1',
        9900,
        undefined,
        'refund:order-1:9900',
        undefined,
      );
    expect(deps.providerRefundSaga.recordProviderOutcome)
      .toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          state: 'PENDING',
          providerStatus: 'requires_action',
          refundId: 're_pending_1',
        }),
      );
    expect(deps.refundCompensation.prepareAndRun).not.toHaveBeenCalled();
  });

  it('persists a CRITICAL alert when a recovered Stripe refund ledger cannot be written', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const task = {
      id: 'provider-refund-stripe-ledger-alert',
      orderId: 'order-1',
      channel: PayChannel.STRIPE,
      providerRefundId: 're_recovered_success',
      paymentProviderInstanceId: null,
    };
    deps.stripeService.retrieveRefundStatus.mockResolvedValueOnce(
      'succeeded',
    );
    deps.stripeService.retrieveRefundLedgerSnapshot.mockRejectedValueOnce(
      new Error('Stripe ledger API unavailable'),
    );

    await expect(
      (service as any).queryProviderRefund(task),
    ).resolves.toEqual(expect.objectContaining({
      state: 'SUCCEEDED',
      refundId: 're_recovered_success',
    }));
    expect(deps.prisma.alertEvent.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        category: AlertEventCategory.PAYMENT,
        severity: AlertEventSeverity.CRITICAL,
        title: 'Stripe退款台账记录失败',
        sourceType: 'order',
        sourceId: 'order-1',
        context: expect.stringContaining(
          '"providerRefundIntentId":"provider-refund-stripe-ledger-alert"',
        ),
      }),
    });
  });

  it('backfills missing Stripe refund ledgers from durable provider intents', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.prisma.order.findMany.mockResolvedValueOnce([]);
    deps.prisma.providerRefundIntent.findMany.mockResolvedValueOnce([
      {
        id: 'provider-refund-intent-backfill',
        orderId: 'order-1',
        providerRefundId: 're_backfill_1',
        paymentProviderInstanceId: null,
      },
    ]);

    await expect(
      service.backfillStripePaymentLedgers({ limit: 25 }),
    ).resolves.toEqual({
      scanned: 0,
      backfilled: 0,
      failed: 0,
      skippedUnsupportedTradeNo: 0,
      refundScanned: 1,
      refundBackfilled: 1,
      refundFailed: 0,
      dryRun: false,
    });
    expect(deps.prisma.providerRefundIntent.findMany)
      .toHaveBeenCalledWith(expect.objectContaining({
        where: expect.objectContaining({
          channel: PayChannel.STRIPE,
          providerRefundId: { not: null },
        }),
        orderBy: { id: 'asc' },
        take: 200,
      }));
    expect(deps.prisma.stripePaymentLedger.findMany)
      .toHaveBeenCalledWith({
        where: { refundId: { in: ['re_backfill_1'] } },
        select: { refundId: true },
      });
    expect(deps.stripeService.retrieveRefundLedgerSnapshot)
      .toHaveBeenCalledWith('re_backfill_1', undefined);
    expect(deps.prisma.stripePaymentLedger.upsert)
      .toHaveBeenCalledWith(expect.objectContaining({
        where: { refundId: 're_backfill_1' },
        create: expect.objectContaining({
          orderId: 'order-1',
          refundId: 're_backfill_1',
          transactionType: 'refund',
        }),
      }));
  });

  it('backfills Stripe subscription refund ledgers from durable cancellation tasks', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.prisma.order.findMany.mockResolvedValueOnce([]);
    deps.prisma.stripeSubscriptionCancellationTask.findMany
      .mockResolvedValueOnce([
        {
          id: 'stripe-cancellation-ledger-backfill',
          orderId: 'order-subscription-1',
          refundId: 're_subscription_backfill',
          paymentProviderInstanceId: null,
        },
      ]);

    await expect(
      service.backfillStripePaymentLedgers({ limit: 25 }),
    ).resolves.toEqual({
      scanned: 0,
      backfilled: 0,
      failed: 0,
      skippedUnsupportedTradeNo: 0,
      refundScanned: 1,
      refundBackfilled: 1,
      refundFailed: 0,
      dryRun: false,
    });
    expect(
      deps.prisma.stripeSubscriptionCancellationTask.findMany,
    ).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        refundId: { not: null },
      }),
      orderBy: { id: 'asc' },
      take: 200,
    }));
    expect(deps.prisma.stripePaymentLedger.findMany)
      .toHaveBeenCalledWith({
        where: {
          refundId: { in: ['re_subscription_backfill'] },
        },
        select: { refundId: true },
      });
    expect(deps.stripeService.retrieveRefundLedgerSnapshot)
      .toHaveBeenCalledWith(
        're_subscription_backfill',
        undefined,
      );
  });

  it('keeps an exception outcome recoverable without compensating locally', async () => {
    const deps = makeDeps();
    const alertEvents = { createAlert: jest.fn().mockResolvedValue(null) };
    const service = await buildServiceWithAlerts(deps, alertEvents);
    const order = makeRefundableOrder({ channel: PayChannel.WECHAT });
    const state = setupStatefulOrderTransactions(deps, order);
    deps.wechatPayService.refund.mockRejectedValue(new Error('provider timeout'));

    await expect(service.refundOrder('order-1', '退款')).rejects.toThrow(
      ServiceUnavailableException,
    );

    expect(state.getOrder().status).toBe(OrderStatus.REFUNDING);
    expect(deps.refundCompensation.prepareAndRun).not.toHaveBeenCalled();
    expect(deps.providerRefundSaga.recordProviderOutcome).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({
        state: 'UNKNOWN',
        providerStatus: 'REQUEST_OUTCOME_UNKNOWN',
      }),
    );
  });

  it('refunds BALANCE channel order returns error (not supported)', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    const order = makeRefundableOrder({ channel: PayChannel.BALANCE });
    deps.prisma.order.findUnique
      .mockResolvedValueOnce(order)
      .mockResolvedValueOnce({ ...order, status: OrderStatus.REFUNDING });
    deps.prisma.order.update.mockResolvedValue(order);
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);

    // BALANCE channel has no refund handler → returns { success: false, error: '...' }
    await expect(service.refundOrder('order-1', '退款')).rejects.toThrow(BadRequestException);
  });
});

// ============================================================
// fulfillOrder internals via retryFulfill
// ============================================================
describe('PaymentService.fulfillOrder — RECHARGE', () => {
  it('retryFulfill calls fulfillOrder which recharges balance for RECHARGE order', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.redis.set.mockResolvedValue('OK'); // lock succeeds
    deps.prisma.order.findUnique.mockResolvedValue(
      makeOrder({ orderType: 'RECHARGE', status: OrderStatus.PAID, paidAt: new Date() }),
    );
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);
    deps.billingService.rechargeWithBonus.mockResolvedValue({ id: 'tx-1' });

    await service.retryFulfill('order-1');

    expect(deps.billingService.rechargeWithBonus).toHaveBeenCalledWith(
      'user-1',
      9900,
      0,
      expect.any(String),
      'order-1',
      undefined,
      {
        tenantId: 'tenant-1',
        billingAccountId: 'ba-tenant-1',
        bonusDescription: 'recharge-bonus',
      },
    );
  });

  it('auto-refunds a paid recharge with no anchored billing account and no wallet effects', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const paidOrder = makeOrder({
      orderType: 'RECHARGE',
      status: OrderStatus.PAID,
      paidAt: new Date(),
      tradeNo: 'TX-MISSING-ACCOUNT',
      channel: PayChannel.WECHAT,
      billingAccountId: null,
    });
    const state = setupStatefulOrderTransactions(deps, paidOrder);
    deps.wechatPayService.refund.mockResolvedValue({ success: true, refundId: 'ref-missing-account' });
    deps.refundCompensation.prepareAndRun.mockImplementationOnce(async () => {
      state.setStatus(OrderStatus.REFUNDED);
      return { complete: true, executed: 0, failed: 0, pending: 0, manualReview: 0 };
    });

    await expect(service.retryFulfill('order-1')).resolves.toBeUndefined();

    expect(deps.billingService.rechargeWithBonus).not.toHaveBeenCalled();
    expect(deps.wechatPayService.refund).toHaveBeenCalledTimes(1);
    expect(deps.refundCompensation.prepareAndRun).toHaveBeenCalledWith(
      expect.objectContaining({ billingAccountId: null }),
      9900,
      expect.objectContaining({ skipRechargeBalanceCompensation: true }),
    );
    expect(state.getOrder().status).toBe(OrderStatus.REFUNDED);
  });

  it('auto-refunds deterministic recharge subject drift without crediting or reversing a wallet', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const paidOrder = makeOrder({
      orderType: 'RECHARGE',
      status: OrderStatus.PAID,
      paidAt: new Date(),
      tradeNo: 'TX-SUBJECT-DRIFT',
      channel: PayChannel.WECHAT,
    });
    const state = setupStatefulOrderTransactions(deps, paidOrder);
    deps.billingService.rechargeWithBonus.mockRejectedValue(
      new RechargeBillingSubjectChangedError(),
    );
    deps.wechatPayService.refund.mockResolvedValue({ success: true, refundId: 'ref-subject-drift' });
    deps.refundCompensation.prepareAndRun.mockImplementationOnce(async () => {
      state.setStatus(OrderStatus.REFUNDED);
      return { complete: true, executed: 0, failed: 0, pending: 0, manualReview: 0 };
    });

    await service.retryFulfill('order-1');

    expect(deps.billingService.rechargeWithBonus).toHaveBeenCalledTimes(1);
    expect(deps.wechatPayService.refund).toHaveBeenCalledTimes(1);
    expect(deps.refundCompensation.prepareAndRun).toHaveBeenCalledWith(
      expect.objectContaining({ id: 'order-1' }),
      9900,
      expect.objectContaining({ skipRechargeBalanceCompensation: true }),
    );
    expect(deps.billingService.refundBalance).not.toHaveBeenCalled();
    expect(state.getOrder().status).toBe(OrderStatus.REFUNDED);
  });

  it('does not auto-refund a transient recharge database failure', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const paidOrder = makeOrder({
      orderType: 'RECHARGE',
      status: OrderStatus.PAID,
      paidAt: new Date(),
      tradeNo: 'TX-DB-ERROR',
      channel: PayChannel.WECHAT,
    });
    const state = setupStatefulOrderTransactions(deps, paidOrder);
    deps.billingService.rechargeWithBonus.mockRejectedValue(new Error('database unavailable'));

    await service.retryFulfill('order-1');

    expect(deps.wechatPayService.refund).not.toHaveBeenCalled();
    expect(state.getOrder().status).toBe(OrderStatus.FAILED);
  });

  it('keeps FULFILLING when the outer no-effects gate already sees a recharge effect', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const paidOrder = makeOrder({
      orderType: 'RECHARGE',
      status: OrderStatus.PAID,
      paidAt: new Date(),
      tradeNo: 'TX-OUTER-RACE',
      channel: PayChannel.WECHAT,
    });
    const state = setupStatefulOrderTransactions(deps, paidOrder);
    deps.billingService.rechargeWithBonus.mockRejectedValue(
      new RechargeBillingSubjectChangedError(),
    );
    deps.prisma.balanceTransaction.findFirst.mockResolvedValue({ id: 'existing-recharge-tx' });

    await service.retryFulfill('order-1');

    expect(deps.wechatPayService.refund).not.toHaveBeenCalled();
    expect(state.getOrder().status).toBe(OrderStatus.FULFILLING);
  });

  it('keeps FULFILLING when the no-effects refund gate observes a concurrent recharge effect', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const paidOrder = makeOrder({
      orderType: 'RECHARGE',
      status: OrderStatus.PAID,
      paidAt: new Date(),
      tradeNo: 'TX-RACE',
      channel: PayChannel.WECHAT,
    });
    const state = setupStatefulOrderTransactions(deps, paidOrder);
    deps.billingService.rechargeWithBonus.mockRejectedValue(
      new RechargeBillingSubjectChangedError(),
    );
    deps.prisma.balanceTransaction.findFirst
      .mockResolvedValueOnce(null) // outer fast check sees no effect
      .mockResolvedValueOnce({ id: 'concurrent-recharge-tx' }); // locked claim sees committed effect

    await service.retryFulfill('order-1');

    expect(deps.wechatPayService.refund).not.toHaveBeenCalled();
    expect(state.getOrder().status).toBe(OrderStatus.FULFILLING);
  });

  it('aborts before provider submission if a wallet effect appears before the atomic claim', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const paidOrder = makeOrder({
      orderType: 'RECHARGE',
      status: OrderStatus.PAID,
      paidAt: new Date(),
      tradeNo: 'TX-LATE-EFFECT',
      channel: PayChannel.WECHAT,
    });
    const state = setupStatefulOrderTransactions(deps, paidOrder);
    deps.billingService.rechargeWithBonus.mockRejectedValue(
      new RechargeBillingSubjectChangedError(),
    );
    deps.prisma.balanceTransaction.findFirst
      .mockResolvedValueOnce(null) // outer no-effects gate
      .mockResolvedValueOnce({ id: 'late-recharge-tx' }); // pre-compensation recheck
    deps.wechatPayService.refund.mockResolvedValue({ success: true, refundId: 'ref-late-effect' });
    await service.retryFulfill('order-1');

    expect(deps.wechatPayService.refund).not.toHaveBeenCalled();
    expect(deps.refundCompensation.prepareAndRun).not.toHaveBeenCalled();
    expect(state.getOrder().status).toBe(OrderStatus.FULFILLING);
  });

  it('moves to REFUND_COMPENSATION_FAILED when the post-channel wallet-effects check throws', async () => {
    const deps = makeDeps();
    const alertEvents = { createAlert: jest.fn().mockResolvedValue(null) };
    const service = await buildServiceWithAlerts(deps, alertEvents);
    const paidOrder = makeOrder({
      orderType: 'RECHARGE',
      status: OrderStatus.PAID,
      paidAt: new Date(),
      tradeNo: 'TX-POST-REFUND-FACTS',
      channel: PayChannel.WECHAT,
    });
    const state = setupStatefulOrderTransactions(deps, paidOrder);
    deps.billingService.rechargeWithBonus.mockRejectedValue(
      new RechargeBillingSubjectChangedError(),
    );
    deps.prisma.balanceTransaction.findFirst
      .mockResolvedValueOnce(null) // outer no-effects gate
      .mockResolvedValueOnce(null) // pre-claim evidence
      .mockRejectedValueOnce(new Error('wallet facts unavailable')); // after provider success
    deps.wechatPayService.refund.mockResolvedValue({ success: true, refundId: 'ref-facts-error' });

    await service.retryFulfill('order-1');

    expect(deps.wechatPayService.refund).toHaveBeenCalledTimes(1);
    expect(deps.refundCompensation.prepareAndRun).not.toHaveBeenCalled();
    expect(state.getOrder().status).toBe(OrderStatus.REFUND_COMPENSATION_FAILED);
    expect(alertEvents.createAlert).toHaveBeenCalledWith(expect.objectContaining({
      category: 'PAYMENT',
      severity: 'CRITICAL',
      title: '退款补偿失败',
      sourceId: 'order-1',
    }));
  });

  it('keeps unknown provider auto-refund recoverable and emits a CRITICAL alert', async () => {
    const deps = makeDeps();
    const alertEvents = { createAlert: jest.fn().mockResolvedValue(null) };
    const service = await buildServiceWithAlerts(deps, alertEvents);
    const paidOrder = makeOrder({
      orderType: 'RECHARGE',
      status: OrderStatus.PAID,
      paidAt: new Date(),
      tradeNo: 'TX-REFUND-FAIL',
      channel: PayChannel.WECHAT,
    });
    const state = setupStatefulOrderTransactions(deps, paidOrder);
    deps.billingService.rechargeWithBonus.mockRejectedValue(
      new RechargeBillingSubjectChangedError(),
    );
    deps.wechatPayService.refund.mockRejectedValue(new Error('provider timeout'));

    await service.retryFulfill('order-1');

    expect(deps.wechatPayService.refund).toHaveBeenCalledTimes(1);
    expect(deps.refundCompensation.prepareAndRun).not.toHaveBeenCalled();
    expect(state.getOrder().status).toBe(OrderStatus.REFUNDING);
    expect(alertEvents.createAlert).toHaveBeenCalledWith(expect.objectContaining({
      category: 'PAYMENT',
      severity: 'CRITICAL',
      title: '充值履约失败且自动退款失败',
      sourceId: 'order-1',
      context: expect.objectContaining({
        refundError: expect.stringContaining('自动查询恢复'),
      }),
    }));
  });
});

describe('PaymentService.fulfillOrder — lock', () => {
  it('skips fulfillment when lock cannot be acquired', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.redis.set.mockResolvedValue(null); // lock NOT acquired

    await service.retryFulfill('order-1');

    expect(deps.prisma.order.findUnique).not.toHaveBeenCalled();
  });
});

describe('PaymentService.fulfillOrder — early exit when order not PAID', () => {
  it('returns without transitioning when order is not found', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.redis.set.mockResolvedValue('OK');
    deps.prisma.order.findUnique.mockResolvedValue(null);

    await service.retryFulfill('order-1');

    // Should not transition to FULFILLING since order is null
    expect(deps.prisma.$transaction).not.toHaveBeenCalled();
  });

  it('returns without transitioning when order status is CANCELLED (not PAID)', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.redis.set.mockResolvedValue('OK');
    deps.prisma.order.findUnique.mockResolvedValue(
      makeOrder({ status: OrderStatus.CANCELLED }),
    );

    await service.retryFulfill('order-1');
    expect(deps.prisma.$transaction).not.toHaveBeenCalled();
  });
});

describe('PaymentService.fulfillment state machine guards', () => {
  type PaymentServiceInternals = {
    transitionOrderStatus: (
      orderId: string,
      newStatus: OrderStatus,
      operator?: string,
      detail?: string,
    ) => Promise<void>;
    claimOrderForFulfillment: (orderId: string) => Promise<unknown>;
  };

  it('rejects illegal status transitions before writing status or audit logs', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.prisma.order.findUnique.mockResolvedValue(
      makeOrder({ status: OrderStatus.REFUNDED }),
    );

    await expect(
      (service as unknown as PaymentServiceInternals).transitionOrderStatus(
        'order-1',
        OrderStatus.PAID,
      ),
    ).rejects.toThrow('订单状态不允许从 REFUNDED 切换到 PAID');

    expect(deps.prisma.$transaction).not.toHaveBeenCalled();
    expect(deps.prisma.orderAuditLog.create).not.toHaveBeenCalled();
  });

  it('rejects EXPIRED to PAID transitions before writing status or audit logs', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.prisma.order.findUnique.mockResolvedValue(
      makeOrder({ status: OrderStatus.EXPIRED }),
    );

    await expect(
      (service as unknown as PaymentServiceInternals).transitionOrderStatus(
        'order-1',
        OrderStatus.PAID,
      ),
    ).rejects.toThrow('订单状态不允许从 EXPIRED 切换到 PAID');

    expect(deps.prisma.$transaction).not.toHaveBeenCalled();
    expect(deps.prisma.orderAuditLog.create).not.toHaveBeenCalled();
  });

  it('rejects same-state transitions before writing status or audit logs', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.prisma.order.findUnique.mockResolvedValue(
      makeOrder({ status: OrderStatus.REFUNDING }),
    );

    await expect(
      (service as unknown as PaymentServiceInternals).transitionOrderStatus(
        'order-1',
        OrderStatus.REFUNDING,
      ),
    ).rejects.toThrow('订单已处于 REFUNDING 状态');

    expect(deps.prisma.$transaction).not.toHaveBeenCalled();
    expect(deps.prisma.orderAuditLog.create).not.toHaveBeenCalled();
  });

  it('rejects legal transitions when the status CAS loses', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const txUpdateMany = jest.fn().mockResolvedValue({ count: 0 });
    const txAuditCreate = jest.fn().mockResolvedValue({});
    deps.prisma.order.findUnique.mockResolvedValue(
      makeOrder({ status: OrderStatus.PAID }),
    );
    deps.prisma.$transaction.mockImplementation(async (
      fn: (tx: {
        order: { updateMany: jest.Mock };
        orderAuditLog: { create: jest.Mock };
      }) => Promise<unknown>,
    ) => fn({
      order: { updateMany: txUpdateMany },
      orderAuditLog: { create: txAuditCreate },
    }));

    await expect(
      (service as unknown as PaymentServiceInternals).transitionOrderStatus(
        'order-1',
        OrderStatus.FULFILLING,
      ),
    ).rejects.toBeInstanceOf(ConflictException);

    expect(txUpdateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', status: OrderStatus.PAID },
      data: expect.objectContaining({ status: OrderStatus.FULFILLING }),
    });
    expect(txAuditCreate).not.toHaveBeenCalled();
  });

  it('does not fulfill a PAID order when the PAID to FULFILLING CAS loses', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.prisma.order.findUnique.mockResolvedValue(
      makeOrder({ status: OrderStatus.PAID }),
    );
    deps.prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });

    const result = await (
      service as unknown as PaymentServiceInternals
    ).claimOrderForFulfillment('order-1');

    expect(result).toBeNull();
    expect(deps.prisma.order.updateMany).toHaveBeenCalledWith({
      where: { id: 'order-1', status: OrderStatus.PAID },
      data: expect.objectContaining({
        status: OrderStatus.FULFILLING,
        fulfillmentAttemptId: expect.any(String),
        fulfillmentClaimedAt: expect.any(Date),
      }),
    });
    expect(deps.prisma.orderAuditLog.create).not.toHaveBeenCalled();
  });
});

describe('PaymentService.fulfillOrder — stale claim recovery', () => {
  it('recovers stale FULFILLING orders with a database CAS claim', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const staleClaimedAt = new Date(Date.now() - 11 * 60 * 1000);
    const fulfillingOrder = makeOrder({
      status: OrderStatus.FULFILLING,
      fulfillmentAttemptId: 'attempt-old',
      fulfillmentClaimedAt: staleClaimedAt,
    });

    deps.redis.set.mockResolvedValue('OK');
    deps.prisma.order.findUnique
      .mockResolvedValueOnce(fulfillingOrder)
      .mockResolvedValueOnce(fulfillingOrder);
    deps.prisma.orderAuditLog.findFirst.mockResolvedValue({ createdAt: new Date() });
    deps.prisma.plan.findUnique.mockResolvedValue(null);
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);

    await service.retryFulfill('order-1');

    expect(deps.prisma.order.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'order-1',
        status: OrderStatus.FULFILLING,
        fulfillmentAttemptId: 'attempt-old',
      },
      data: {
        fulfillmentAttemptId: expect.any(String),
        fulfillmentClaimedAt: expect.any(Date),
      },
    });
    expect(deps.prisma.orderAuditLog.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        fromStatus: OrderStatus.FULFILLING,
        toStatus: OrderStatus.FULFILLING,
        detail: '恢复陈旧履约任务',
      }),
    });
  });

  it('does not fulfill when stale recovery CAS loses', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const staleClaimedAt = new Date(Date.now() - 11 * 60 * 1000);

    deps.redis.set.mockResolvedValue('OK');
    deps.prisma.order.findUnique.mockResolvedValueOnce(makeOrder({
      status: OrderStatus.FULFILLING,
      fulfillmentAttemptId: 'attempt-old',
      fulfillmentClaimedAt: staleClaimedAt,
    }));
    deps.prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });

    await service.retryFulfill('order-1');

    expect(deps.prisma.orderAuditLog.create).not.toHaveBeenCalled();
    expect(deps.billingService.activateSubscription).not.toHaveBeenCalled();
    expect(deps.creditService.addBonus).not.toHaveBeenCalled();
    expect(deps.billingService.rechargeWithBonus).not.toHaveBeenCalled();
  });

  it('does not create a failure audit when FAILED marking CAS loses', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    type FailureMarkTx = {
      order: { updateMany: jest.Mock };
      orderAuditLog: { create: jest.Mock };
    };
    type PaymentServiceInternals = {
      markFulfillmentFailedIfCurrent: (orderId: string, detail: string) => Promise<void>;
    };

    deps.prisma.order.updateMany.mockResolvedValueOnce({ count: 0 });
    deps.prisma.$transaction.mockImplementation(async (fn: (tx: FailureMarkTx) => Promise<unknown>) => fn({
      order: { updateMany: deps.prisma.order.updateMany },
      orderAuditLog: { create: deps.prisma.orderAuditLog.create },
    }));

    await (service as unknown as PaymentServiceInternals).markFulfillmentFailedIfCurrent(
      'order-1',
      'refund rejected',
    );

    expect(deps.prisma.order.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'order-1',
        status: OrderStatus.FULFILLING,
      },
      data: {
        status: OrderStatus.FAILED,
        fulfillmentAttemptId: null,
        fulfillmentClaimedAt: null,
      },
    });
    expect(deps.prisma.orderAuditLog.create).not.toHaveBeenCalled();
  });
});

describe('PaymentService.fulfillOrder — BOOSTER_PACK (missing pack warning)', () => {
  it('logs warning when boosterPack record not found in DB', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    const paidOrder = makeOrder({ orderType: 'BOOSTER_PACK', boosterPackId: 'bp-missing', status: OrderStatus.PAID });
    const fulfillingOrder = { ...paidOrder, status: OrderStatus.FULFILLING };

    deps.redis.set.mockResolvedValue('OK');
    // Calls: fulfillOrder.findUnique, transitionOrderStatus.findUnique (PAID->FULFILLING), transitionOrderStatus.findUnique (FULFILLING->COMPLETED)
    deps.prisma.order.findUnique
      .mockResolvedValueOnce(paidOrder)      // fulfillOrder initial check
      .mockResolvedValueOnce(paidOrder)      // transitionOrderStatus PAID→FULFILLING
      .mockResolvedValueOnce(fulfillingOrder); // transitionOrderStatus FULFILLING→COMPLETED
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);
    deps.prisma.boosterPack.findUnique.mockResolvedValue(null); // pack not found

    // Should complete without throwing (logs warning only)
    await service.retryFulfill('order-1');
    expect(deps.prisma.boosterPack.findUnique).toHaveBeenCalled();
    expect(deps.creditService.addBonus).not.toHaveBeenCalled();
  });
});

describe('PaymentService.fulfillOrder — SUBSCRIPTION (missing plan warning)', () => {
  it('logs warning when plan record not found in DB', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    const paidOrder = makeOrder({ orderType: 'SUBSCRIPTION', planId: 'plan-missing', status: OrderStatus.PAID });
    const fulfillingOrder = { ...paidOrder, status: OrderStatus.FULFILLING };

    deps.redis.set.mockResolvedValue('OK');
    deps.prisma.order.findUnique
      .mockResolvedValueOnce(paidOrder)        // fulfillOrder initial check
      .mockResolvedValueOnce(paidOrder)        // transitionOrderStatus PAID→FULFILLING
      .mockResolvedValueOnce(fulfillingOrder); // transitionOrderStatus FULFILLING→COMPLETED
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);
    deps.prisma.plan.findUnique.mockResolvedValue(null); // plan not found

    await service.retryFulfill('order-1');
    expect(deps.prisma.plan.findUnique).toHaveBeenCalled();
    expect(deps.billingService.activateSubscription).not.toHaveBeenCalled();
  });
});

describe('PaymentService.fulfillOrder — CodingPlan fulfillment mode', () => {
  it('uses provider resale fulfillment only when product mode is provider_resale', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const paidOrder = makeOrder({
      orderType: 'SUBSCRIPTION',
      planId: 'plan-resale',
      status: OrderStatus.PAID,
      paidAt: new Date(),
      billingPeriod: 'monthly',
      amountCents: 9900,
      currency: 'usd',
    });
    const fulfillingOrder = { ...paidOrder, status: OrderStatus.FULFILLING };

    deps.redis.set.mockResolvedValue('OK');
    deps.prisma.order.findUnique
      .mockResolvedValueOnce(paidOrder)
      .mockResolvedValueOnce(fulfillingOrder);
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);
    deps.prisma.plan.findUnique.mockResolvedValue({
      id: 'plan-resale',
      productId: 'prod-coding',
      name: 'Provider Resale',
      monthlyCredits: 0,
      features: '[]',
      product: {
        billingMode: ProductBillingMode.CODING_PLAN,
        codingPlanFulfillmentMode: CodingPlanFulfillmentMode.provider_resale,
      },
    });

    await service.retryFulfill('order-1');

    expect(deps.billingService.createCodingPlanEntitlement).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'order-1',
      userId: 'user-1',
      tenantId: 'tenant-personal',
      productId: 'prod-coding',
      planId: 'plan-resale',
      fulfillmentMode: 'provider_resale',
      status: 'PENDING',
    }));
    expect(deps.codingPlanFulfillment.fulfillSubscriptionOrder).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'order-1',
      userId: 'user-1',
      tenantId: 'tenant-personal',
      productId: 'prod-coding',
      planId: 'plan-resale',
      subscriptionId: 'entitlement-1',
      amountCents: 9900,
      currency: 'usd',
    }));
    expect(deps.billingService.attachCodingPlanProviderEntitlement).toHaveBeenCalledWith('order-1');
    expect(deps.billingService.provisionSelfOperatedEntitlement).not.toHaveBeenCalled();
    expect(deps.billingService.activateSubscription).not.toHaveBeenCalled();
  });

  it('ignores legacy provider_resale feature markers for self-operated CodingPlan products', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const paidOrder = makeOrder({
      orderType: 'SUBSCRIPTION',
      planId: 'plan-self',
      status: OrderStatus.PAID,
      paidAt: new Date(),
      billingPeriod: 'monthly',
    });
    const fulfillingOrder = { ...paidOrder, status: OrderStatus.FULFILLING };

    deps.redis.set.mockResolvedValue('OK');
    deps.prisma.order.findUnique
      .mockResolvedValueOnce(paidOrder)
      .mockResolvedValueOnce(fulfillingOrder);
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);
    deps.prisma.plan.findUnique.mockResolvedValue({
      id: 'plan-self',
      productId: 'prod-coding',
      name: 'Self Operated',
      monthlyCredits: 0,
      features: '["stale_provider_resale_hint"]',
      product: {
        billingMode: ProductBillingMode.CODING_PLAN,
        codingPlanFulfillmentMode: CodingPlanFulfillmentMode.platform_model_package,
      },
    });

    await service.retryFulfill('order-1');

    expect(deps.billingService.provisionSelfOperatedEntitlement).toHaveBeenCalledWith(expect.objectContaining({
      orderId: 'order-1',
      userId: 'user-1',
      tenantId: 'tenant-personal',
      productId: 'prod-coding',
      planId: 'plan-self',
    }));
    expect(deps.billingService.createCodingPlanEntitlement).not.toHaveBeenCalled();
    expect(deps.codingPlanFulfillment.fulfillSubscriptionOrder).not.toHaveBeenCalled();
  });

  it('自营换档抵扣安全闸拒单（已支付）→ 自动全额退款，不留付款无履约（codex R3 P1）', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const paidOrder = makeOrder({
      orderType: 'SUBSCRIPTION',
      planId: 'plan-self',
      status: OrderStatus.PAID,
      paidAt: new Date(),
      tradeNo: 'TX-1',
      channel: PayChannel.WECHAT,
      billingPeriod: 'monthly',
    });
    const fulfillingOrder = { ...paidOrder, status: OrderStatus.FULFILLING };

    deps.redis.set.mockResolvedValue('OK');
    deps.prisma.order.findUnique
      .mockResolvedValueOnce(paidOrder) // fulfillOrder claim check
      .mockResolvedValueOnce(fulfillingOrder) // claim PAID→FULFILLING
      .mockResolvedValueOnce(fulfillingOrder) // refundOrder findUnique(include)
      .mockResolvedValueOnce({ ...fulfillingOrder, status: OrderStatus.REFUNDED });
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);
    deps.prisma.plan.findUnique.mockResolvedValue({
      id: 'plan-self',
      productId: 'prod-coding',
      name: 'Self Operated',
      monthlyCredits: 1000,
      product: {
        billingMode: ProductBillingMode.CODING_PLAN,
        codingPlanFulfillmentMode: CodingPlanFulfillmentMode.platform_model_package,
      },
    });
    // 履约命中安全闸：源 entitlement 失效 → 永久性业务拒绝。
    deps.billingService.provisionSelfOperatedEntitlement.mockRejectedValue(
      new SelfOpProrationSourceInvalidError(),
    );
    // 自动退款走渠道
    deps.prisma.order.update.mockResolvedValue(paidOrder);
    deps.wechatPayService.refund.mockResolvedValue({ success: true, refundId: 'ref-auto' });

    await service.retryFulfill('order-1');

    expect(deps.billingService.provisionSelfOperatedEntitlement).toHaveBeenCalled();
    expect(deps.wechatPayService.refund).toHaveBeenCalled(); // 已支付 → 自动退款触发
    // 未产生权益 → 跳过权益补偿（否则会误扣旧套餐积分/误关活动权益）
    expect(deps.refundCompensation.prepareAndRun).toHaveBeenCalledWith(
      expect.anything(),
      expect.any(Number),
      expect.objectContaining({ skipEntitlementCompensation: true }),
    );
    // 未把订单打成 FAILED（退款路径 return 在前）
    const failedTransition = deps.prisma.orderAuditLog.create.mock.calls.find(
      (c: unknown[]) => (c[0] as { data?: { toStatus?: string } })?.data?.toStatus === OrderStatus.FAILED,
    );
    expect(failedTransition).toBeUndefined();
  });

  it('自营瞬时故障（非安全闸）→ 不自动退款，走 FAILED 重试路径（不误退）', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const paidOrder = makeOrder({
      orderType: 'SUBSCRIPTION',
      planId: 'plan-self',
      status: OrderStatus.PAID,
      paidAt: new Date(),
      tradeNo: 'TX-1',
      channel: PayChannel.WECHAT,
      billingPeriod: 'monthly',
    });
    const fulfillingOrder = { ...paidOrder, status: OrderStatus.FULFILLING };

    deps.redis.set.mockResolvedValue('OK');
    deps.prisma.order.findUnique
      .mockResolvedValueOnce(paidOrder)
      .mockResolvedValueOnce(fulfillingOrder);
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);
    deps.prisma.plan.findUnique.mockResolvedValue({
      id: 'plan-self',
      productId: 'prod-coding',
      name: 'Self Operated',
      monthlyCredits: 1000,
      product: {
        billingMode: ProductBillingMode.CODING_PLAN,
        codingPlanFulfillmentMode: CodingPlanFulfillmentMode.platform_model_package,
      },
    });
    // 瞬时故障（DB/网络等）——非 SelfOpProrationSourceInvalidError。
    deps.billingService.provisionSelfOperatedEntitlement.mockRejectedValue(new Error('DB down'));
    deps.prisma.order.updateMany.mockResolvedValue({ count: 1 }); // markFulfillmentFailedIfCurrent

    await service.retryFulfill('order-1');

    expect(deps.wechatPayService.refund).not.toHaveBeenCalled(); // 瞬时故障不退款
  });
});

describe('PaymentService.fulfillOrder — BOOSTER_PACK auto-refund on failure', () => {
  it('attempts auto-refund when BOOSTER_PACK fulfillment fails, then transitions to REFUNDED', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    const paidOrder = makeOrder({
      orderType: 'BOOSTER_PACK', boosterPackId: 'bp1',
      status: OrderStatus.PAID, paidAt: new Date(), tradeNo: 'TX-1',
      channel: PayChannel.WECHAT,
      boosterPack: null, plan: null,
    });
    const fulfillingOrder = { ...paidOrder, status: OrderStatus.FULFILLING };

    deps.redis.set.mockResolvedValue('OK');
    deps.prisma.order.findUnique
      .mockResolvedValueOnce(paidOrder)
      .mockResolvedValueOnce(fulfillingOrder)
      .mockResolvedValueOnce({ ...fulfillingOrder, status: OrderStatus.REFUNDED });
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);

    // boosterPack found but addBonus throws
    deps.prisma.boosterPack.findUnique.mockResolvedValue({
      id: 'bp1', creditsAmount: 500, productId: 'prod-1',
    });
    deps.subscriptionResolver.resolve.mockResolvedValue({ subscriptionId: 'sub-1' });
    deps.creditService.addBonus.mockRejectedValue(new Error('Redis down'));

    // Auto refund via channel
    deps.prisma.order.update.mockResolvedValue(paidOrder);
    deps.wechatPayService.refund.mockResolvedValue({ success: true, refundId: 'ref-auto' });

    await service.retryFulfill('order-1');

    expect(deps.wechatPayService.refund).toHaveBeenCalled(); // auto refund triggered
  });
});

describe('PaymentService.fulfillOrder — BUNDLE auto-refund on partial failure', () => {
  it('routes a plan side effect through compensation when the FULFILLED marker write fails', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const item = {
      id: 'item-marker-failure',
      status: OrderItemStatus.PENDING,
      orderId: 'order-bundle',
      planId: 'plan-a',
      productId: 'prod-a',
      boosterPackId: null,
      quantity: 1,
      name: 'Product A',
      amountCents: 9900,
      currency: 'usd',
      validityDays: null,
      plan: { id: 'plan-a', name: 'A Pro', monthlyCredits: 500 },
      product: {
        billingMode: ProductBillingMode.SUBSCRIPTION,
        codingPlanFulfillmentMode: null,
      },
      boosterPack: null,
    };
    deps.prisma.orderItem.findMany.mockResolvedValue([item] as any);
    deps.prisma.orderItem.update.mockImplementation(async ({ data }: any) => {
      if (data.status === OrderItemStatus.FULFILLED) {
        throw new Error('terminal marker unavailable');
      }
      return {};
    });
    deps.billingService.activateSubscription.mockResolvedValue({
      contractId: 'contract-a',
      periodId: 'period-a',
      entitlementId: 'entitlement-a',
    });
    deps.creditService.grantQuota.mockResolvedValue(undefined);

    await expect((service as any).fulfillBundleOrder(
      'order-bundle',
      'user-1',
      'tenant-1',
    )).rejects.toThrow('terminal marker unavailable');

    expect(deps.billingService.activateSubscription).toHaveBeenCalledWith(
      'user-1',
      'plan-a',
      'prod-a',
      undefined,
      'monthly',
      {
        tenantId: 'tenant-1',
        idempotencyKey:
          'bundle:order-bundle:item:item-marker-failure:activation',
        requireNoActiveSubscription: true,
      },
    );
    expect(deps.creditService.grantQuota).toHaveBeenCalledWith(
      'period-a',
      'user-1',
      500,
      'bundle:Product A',
      {
        idempotencyKey:
          'bundle:order-bundle:item:item-marker-failure:quota',
      },
    );
    expect(deps.prisma.orderItem.update).toHaveBeenLastCalledWith({
      where: { id: 'item-marker-failure' },
      data: { status: OrderItemStatus.COMPENSATING },
    });
  });

  it('refunds and rolls back bundle entitlements when a later item fails', async () => {
    const deps = makeDeps();
    setupPrismaTransaction(deps.prisma);
    const service = await buildService(deps);

    const paidOrder = makeOrder({
      id: 'order-bundle',
      orderType: PrismaOrderType.BUNDLE,
      status: OrderStatus.PAID,
      paidAt: new Date(),
      tradeNo: 'sub_bundle',
      channel: PayChannel.STRIPE,
      amountCents: 12900,
    });
    const itemA = {
      id: 'item-a',
      status: OrderItemStatus.PENDING,
      orderId: 'order-bundle',
      planId: 'plan-a',
      productId: 'prod-a',
      boosterPackId: null,
      name: 'Product A Yearly',
      amountCents: 9900,
      currency: 'usd',
      validityDays: null,
      plan: { id: 'plan-a', name: 'A Pro', monthlyCredits: 500 },
      product: { billingMode: ProductBillingMode.SUBSCRIPTION, codingPlanFulfillmentMode: null },
      boosterPack: null,
    };
    const itemB = {
      id: 'item-b',
      status: OrderItemStatus.PENDING,
      orderId: 'order-bundle',
      planId: 'plan-b',
      productId: 'prod-b',
      boosterPackId: null,
      name: 'Product B Access',
      amountCents: 3000,
      currency: 'usd',
      validityDays: 365,
      plan: { id: 'plan-b', name: 'B Access', monthlyCredits: 100 },
      product: { billingMode: ProductBillingMode.SUBSCRIPTION, codingPlanFulfillmentMode: null },
      boosterPack: null,
    };
    const itemAFulfilled = { ...itemA, status: OrderItemStatus.FULFILLED };
    const itemBCompensating = { ...itemB, status: OrderItemStatus.COMPENSATING };
    const compensatingOrder = {
      ...paidOrder,
      status: OrderStatus.PARTIALLY_FULFILLED_REQUIRES_COMPENSATION,
      items: [itemAFulfilled, itemBCompensating],
      plan: null,
      boosterPack: null,
    };

    deps.redis.set.mockResolvedValue('OK');
    deps.prisma.order.findUnique
      .mockResolvedValueOnce(paidOrder)
      .mockResolvedValueOnce(compensatingOrder)
      .mockResolvedValueOnce({ ...compensatingOrder, status: OrderStatus.REFUNDED });
    deps.prisma.orderItem.findMany.mockResolvedValue([itemA, itemB] as any);
    deps.billingService.activateSubscription.mockResolvedValue({
      contractId: 'contract-activated',
      periodId: 'subscription-activated',
      entitlementId: 'entitlement-activated',
    });
    deps.subscriptionResolver.resolve.mockResolvedValue({ subscriptionId: 'sub-product' });
    deps.creditService.grantQuota
      .mockResolvedValueOnce(undefined)
      .mockRejectedValueOnce(new Error('quota grant failed'));
    deps.prisma.orderItem.update.mockResolvedValue({});
    deps.prisma.order.update.mockResolvedValue(compensatingOrder);
    deps.stripeService.refundViaSessionOrSubscription.mockResolvedValue({ success: true, refundId: 'ref-bundle' });

    await service.retryFulfill('order-bundle');

    expect(deps.stripeService.refundViaSessionOrSubscription).toHaveBeenCalledWith(
      'sub_bundle',
      12900,
      undefined,
      'refund:order-bundle:12900',
      'in_refund_exact',
    );
    expect(deps.prisma.orderItem.update).toHaveBeenCalledWith({
      where: { id: 'item-a' },
      data: { status: OrderItemStatus.FULFILLING },
    });
    expect(deps.prisma.orderItem.update).toHaveBeenCalledWith({
      where: { id: 'item-a' },
      data: { status: OrderItemStatus.FULFILLED, fulfilledAt: expect.any(Date) },
    });
    expect(deps.prisma.orderItem.update).toHaveBeenCalledWith({
      where: { id: 'item-b' },
      data: { status: OrderItemStatus.FULFILLING },
    });
    expect(deps.prisma.orderItem.update).toHaveBeenCalledWith({
      where: { id: 'item-b' },
      data: { status: OrderItemStatus.COMPENSATING },
    });
    expect(deps.refundCompensation.prepareAndRun).toHaveBeenCalledWith(
      compensatingOrder,
      12900,
      { reason: '履约失败自动退款: quota grant failed', trigger: 'inline' },
    );
    expect(deps.creditService.deduct).not.toHaveBeenCalled();
  });
});

// ============================================================
// refundOrder — refund compensation delegation
// ============================================================
describe('PaymentService.refundOrder — refund compensation delegation', () => {
  it('blocks provider-resale Coding Plan refunds before any irreversible provider call', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.prisma.order.findUnique.mockResolvedValue(makeOrder({
      status: OrderStatus.COMPLETED,
      orderType: PrismaOrderType.SUBSCRIPTION,
      productId: 'coding-product',
      planId: 'coding-plan',
      tradeNo: 'sub_coding',
      channel: PayChannel.STRIPE,
    }));
    deps.prisma.codingPlanEntitlement.findUnique.mockResolvedValue({
      fulfillmentMode: CodingPlanFulfillmentMode.provider_resale,
    });

    await expect(service.refundOrder(
      'order-1',
      'manual refund',
    )).rejects.toThrow(
      '供应商转售套餐暂不支持自动退款',
    );

    expect(
      deps.refundCompensation.preflightUnusedSelfOperatedCodingPlanRefund,
    ).not.toHaveBeenCalled();
    expect(deps.stripeService.refundViaSessionOrSubscription).not.toHaveBeenCalled();
    expect(deps.prisma.order.updateMany).not.toHaveBeenCalled();
  });

  it('delegates full subscription compensation to refund task service', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    const order = makeOrder({
      status: OrderStatus.COMPLETED,
      orderType: 'SUBSCRIPTION',
      planId: 'plan-1',
      tradeNo: 'TX-1',
      channel: PayChannel.WECHAT,
      boosterPack: null,
      plan: { id: 'plan-1', name: 'Pro', productId: 'prod-1', monthlyCredits: 500 },
    });

    deps.prisma.order.findUnique.mockResolvedValue(order);
    deps.prisma.order.update.mockResolvedValue(order);
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);
    deps.wechatPayService.refund.mockResolvedValue({ success: true, refundId: 'ref-1' });

    await service.refundOrder('order-1', '退款');

    expect(deps.refundCompensation.prepareAndRun).toHaveBeenCalledWith(
      order,
      9900,
      { reason: '退款', trigger: 'inline' },
    );
    expect(deps.creditService.deduct).not.toHaveBeenCalled();
    expect(deps.subscriptionLifecycle.closeActive).not.toHaveBeenCalled();
  });

  it('delegates partial subscription compensation with the partial amount', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    const order = makeOrder({
      status: OrderStatus.COMPLETED,
      orderType: 'SUBSCRIPTION',
      planId: 'plan-1',
      amountCents: 10000,
      tradeNo: 'TX-1',
      channel: PayChannel.WECHAT,
      boosterPack: null,
      plan: { id: 'plan-1', name: 'Pro', productId: 'prod-1', monthlyCredits: 500 },
    });

    deps.prisma.order.findUnique.mockResolvedValue(order);
    deps.prisma.order.update.mockResolvedValue(order);
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);
    deps.wechatPayService.refund.mockResolvedValue({ success: true, refundId: 'ref-2' });

    await service.refundOrder('order-1', '退款', 5000); // partial refund

    expect(deps.refundCompensation.prepareAndRun).toHaveBeenCalledWith(
      order,
      5000,
      { reason: '退款', trigger: 'inline' },
    );
  });

  it('delegates BOOSTER_PACK compensation to refund task service', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    const order = makeOrder({
      status: OrderStatus.COMPLETED,
      orderType: 'BOOSTER_PACK',
      boosterPackId: 'bp1',
      tradeNo: 'TX-1',
      channel: PayChannel.WECHAT,
      plan: null,
      boosterPack: { id: 'bp1', creditsAmount: 1000 },
    });

    deps.prisma.order.findUnique.mockResolvedValue(order);
    deps.prisma.order.update.mockResolvedValue(order);
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);
    deps.wechatPayService.refund.mockResolvedValue({ success: true });

    await service.refundOrder('order-1', '退款');

    expect(deps.refundCompensation.prepareAndRun).toHaveBeenCalledWith(
      order,
      9900,
      { reason: '退款', trigger: 'inline' },
    );
  });

  it('retries failed internal compensation without issuing another channel refund', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    const order = makeOrder({
      status: OrderStatus.REFUND_COMPENSATION_FAILED,
      orderType: 'SUBSCRIPTION',
      planId: 'plan-1',
      refundAmountCents: 5000,
      tradeNo: 'TX-1',
      channel: PayChannel.WECHAT,
      boosterPack: null,
      plan: { id: 'plan-1', name: 'Pro', productId: 'prod-1', monthlyCredits: 500 },
    });

    deps.prisma.order.findUnique.mockResolvedValue(order);
    deps.prisma.order.update.mockResolvedValue(order);
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);

    await service.refundOrder('order-1', '重试补偿');

    expect(deps.wechatPayService.refund).not.toHaveBeenCalled();
    expect(deps.refundCompensation.prepareAndRun).toHaveBeenCalledWith(
      order,
      5000,
      { reason: '重试补偿', trigger: 'manual-retry' },
    );
  });
});

// ============================================================
// boosterPack fulfill — auto-refund failure
// ============================================================
describe('PaymentService.fulfillOrder — BOOSTER_PACK auto-refund failure', () => {
  it('keeps the refund failure path isolated from the fulfillment failure path', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    const paidOrder = makeOrder({
      orderType: 'BOOSTER_PACK', boosterPackId: 'bp1',
      status: OrderStatus.PAID, paidAt: new Date(), tradeNo: 'TX-1',
      channel: PayChannel.WECHAT, boosterPack: null, plan: null,
    });
    const fulfillingOrder = { ...paidOrder, status: OrderStatus.FULFILLING };
    const refundingOrder = { ...paidOrder, status: OrderStatus.REFUNDING };

    deps.redis.set.mockResolvedValue('OK');
    deps.prisma.order.findUnique
      .mockResolvedValueOnce(paidOrder)
      .mockResolvedValueOnce(fulfillingOrder)
      .mockResolvedValueOnce(refundingOrder);
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);

    // addBonus throws
    deps.prisma.boosterPack.findUnique.mockResolvedValue({
      id: 'bp1', creditsAmount: 500, productId: 'prod-1',
    });
    deps.subscriptionResolver.resolve.mockResolvedValue({ subscriptionId: 'sub-1' });
    deps.creditService.addBonus.mockRejectedValue(new Error('Redis down'));

    // Auto refund fails via channel
    deps.prisma.order.update.mockResolvedValue(paidOrder);
    deps.wechatPayService.refund.mockResolvedValue({ success: false, error: 'refund rejected' });

    await service.retryFulfill('order-1');

    // refund transitions are still driven through the state machine.
    expect(deps.prisma.$transaction).toHaveBeenCalled();
  });
});

describe('PaymentService.fulfillOrder — BOOSTER_PACK without productId', () => {
  it('uses empty subscriptionId when pack has no productId', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    const paidOrder = makeOrder({
      orderType: 'BOOSTER_PACK', boosterPackId: 'bp-no-product',
      status: OrderStatus.PAID, paidAt: new Date(),
    });
    const fulfillingOrder = { ...paidOrder, status: OrderStatus.FULFILLING };

    deps.redis.set.mockResolvedValue('OK');
    deps.prisma.order.findUnique
      .mockResolvedValueOnce(paidOrder)
      .mockResolvedValueOnce(paidOrder)       // transitionOrderStatus PAID→FULFILLING
      .mockResolvedValueOnce(fulfillingOrder) // transitionOrderStatus FULFILLING→COMPLETED
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);
    deps.prisma.boosterPack.findUnique.mockResolvedValue({
      id: 'bp-no-product', creditsAmount: 200, productId: null,
    });
    deps.creditService.addBonus.mockResolvedValue(undefined);
    deps.prisma.user.findUnique.mockResolvedValue({ email: 'u@x.com' });
    deps.prisma.product.findUnique.mockResolvedValue(null);

    await service.retryFulfill('order-1');

    expect(deps.creditService.addBonus).toHaveBeenCalledWith(
      '',
      'user-1',
      200,
      expect.any(String),
      { idempotencyKey: 'booster:order-1' },
    );
  });
});

// ============================================================
// SUBSCRIPTION fulfill — plan without productId
// ============================================================
describe('PaymentService.fulfillOrder — SUBSCRIPTION without productId', () => {
  it('skips activateSubscription when plan has no productId', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    const paidOrder = makeOrder({
      orderType: 'SUBSCRIPTION', planId: 'plan-no-product',
      status: OrderStatus.PAID, paidAt: new Date(),
    });
    const fulfillingOrder = { ...paidOrder, status: OrderStatus.FULFILLING };

    deps.redis.set.mockResolvedValue('OK');
    deps.prisma.order.findUnique
      .mockResolvedValueOnce(paidOrder)
      .mockResolvedValueOnce(paidOrder)       // transitionOrderStatus PAID→FULFILLING
      .mockResolvedValueOnce(fulfillingOrder); // transitionOrderStatus FULFILLING→COMPLETED
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);
    deps.prisma.plan.findUnique.mockResolvedValue({
      id: 'plan-no-product', productId: null, name: 'Custom', monthlyCredits: 300,
    });
    deps.creditService.grantQuota.mockResolvedValue(undefined);
    deps.prisma.user.findUnique.mockResolvedValue({ email: 'u@x.com' });
    deps.prisma.product.findUnique.mockResolvedValue(null);

    await service.retryFulfill('order-1');

    expect(deps.billingService.activateSubscription).not.toHaveBeenCalled();
    expect(deps.creditService.grantQuota).toHaveBeenCalledWith(
      '', 'user-1', 300, expect.any(String),
      expect.objectContaining({ idempotencyKey: expect.stringMatching(/^checkout:/) }),
    );
  });
});

// ============================================================
// createOrder — multi-currency / billingPeriod / paymentMethod
// Phase 2: Stripe 订阅新增字段的分支覆盖
// ============================================================
describe('PaymentService.createOrder — Stripe multi-currency + billing period', () => {
  function setupForStripe(deps: ReturnType<typeof makeDeps>) {
    deps.paymentRepo.createOrder.mockImplementation(async (data: any) =>
      makeOrder({ channel: 'STRIPE', orderType: 'SUBSCRIPTION', ...data }),
    );
    deps.prisma.user.findUnique.mockResolvedValue({ email: 'u@test.com' });
    mockStripeCallbackEnv(deps);
    deps.stripeService.createSubscription.mockResolvedValue({
      sessionId: 'cs_sub_1', url: 'https://checkout.stripe.com/sub/1',
    });
    deps.stripeService.createCheckoutSession.mockResolvedValue({
      sessionId: 'cs_1', url: 'https://checkout.stripe.com/oneshot/1',
    });
  }

  it('rejects USD recurring checkout after resolving the exact plan price', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    setupForStripe(deps);
    const plan = { id: 'p1', isActive: true, monthlyPrice: 4900, yearlyPrice: 3900, name: 'Pro' };
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue({
      plan,
      price: { currency: 'usd', monthlyPrice: 4900, yearlyPrice: 3900 },
    });

    await expect(service.createOrder('u1', {
      orderType: 'SUBSCRIPTION', channel: 'STRIPE', planId: 'p1',
      currency: 'usd', billingPeriod: 'monthly',
    } as any)).rejects.toThrow('Stripe 自动续费订阅暂不可用');

    expect(deps.paymentRepo.findPlanWithPrice).toHaveBeenCalledWith('p1', 'usd');
    expect(deps.paymentRepo.createOrder).not.toHaveBeenCalled();
    expect(deps.stripeService.createSubscription).not.toHaveBeenCalled();
  });

  it('rejects SGD recurring checkout after resolving the exact plan price', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    setupForStripe(deps);
    deps.systemConfigService.getDeploymentConfig.mockResolvedValue({
      version: '1', region: 'overseas', provider: 'auth0', currency: 'sgd', defaultLanguage: 'en', oauth: {},
    });
    const plan = { id: 'p1', isActive: true, monthlyPrice: 4900, yearlyPrice: 3900, name: 'Pro' };
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue({
      plan,
      price: { currency: 'sgd', monthlyPrice: 6500, yearlyPrice: 5200 },
    });

    await expect(service.createOrder('u1', {
      orderType: 'SUBSCRIPTION', channel: 'STRIPE', planId: 'p1',
      currency: 'sgd', billingPeriod: 'monthly',
    } as any)).rejects.toThrow('Stripe 自动续费订阅暂不可用');

    expect(deps.paymentRepo.findPlanWithPrice).toHaveBeenCalledWith('p1', 'sgd');
    expect(deps.paymentRepo.createOrder).not.toHaveBeenCalled();
    expect(deps.stripeService.createSubscription).not.toHaveBeenCalled();
  });

  it('rejects yearly recurring checkout before provider creation', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    setupForStripe(deps);
    const plan = { id: 'p1', isActive: true, monthlyPrice: 4900, yearlyPrice: 3900, name: 'Pro' };
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue({
      plan,
      price: { currency: 'usd', monthlyPrice: 4900, yearlyPrice: 3900 },
    });

    await expect(service.createOrder('u1', {
      orderType: 'SUBSCRIPTION', channel: 'STRIPE', planId: 'p1',
      currency: 'usd', billingPeriod: 'yearly',
    } as any)).rejects.toThrow('Stripe 自动续费订阅暂不可用');

    expect(deps.stripeService.createSubscription).not.toHaveBeenCalled();
  });

  it('rejects quarterly recurring checkout before provider creation', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    setupForStripe(deps);
    const plan = {
      id: 'p1',
      isActive: true,
      monthlyPrice: 4900,
      quarterlyPrice: 4500,
      yearlyPrice: 3900,
      name: 'Pro',
    };
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue({
      plan,
      price: { currency: 'usd', monthlyPrice: 4900, quarterlyPrice: 4500, yearlyPrice: 3900 },
    });

    await expect(service.createOrder('u1', {
      orderType: 'SUBSCRIPTION', channel: 'STRIPE', planId: 'p1',
      currency: 'usd', billingPeriod: 'quarterly',
    } as any)).rejects.toThrow('Stripe 自动续费订阅暂不可用');

    expect(deps.stripeService.createSubscription).not.toHaveBeenCalled();
  });

  it('does not let paymentMethod hints bypass the recurring safety boundary', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    setupForStripe(deps);
    deps.systemConfigService.getDeploymentConfig.mockResolvedValue({
      version: '1', region: 'overseas', provider: 'auth0', currency: 'sgd', defaultLanguage: 'en', oauth: {},
    });
    const plan = { id: 'p1', isActive: true, monthlyPrice: 4900, yearlyPrice: 3900, name: 'Pro' };
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue({
      plan,
      price: { currency: 'sgd', monthlyPrice: 6500, yearlyPrice: 5200 },
    });

    await expect(service.createOrder('u1', {
      orderType: 'SUBSCRIPTION', channel: 'STRIPE', planId: 'p1',
      currency: 'sgd', billingPeriod: 'monthly', paymentMethod: 'alipay',
    } as any)).rejects.toThrow('Stripe 自动续费订阅暂不可用');

    expect(deps.stripeService.createCheckoutSession).not.toHaveBeenCalled();
    expect(deps.stripeService.createSubscription).not.toHaveBeenCalled();
  });

  it('does not create recurring checkout even with valid explicit callback URLs', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    setupForStripe(deps);
    const plan = { id: 'p1', isActive: true, monthlyPrice: 4900, yearlyPrice: 3900, name: 'Pro' };
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue({
      plan,
      price: { currency: 'usd', monthlyPrice: 4900, yearlyPrice: 3900 },
    });

    await expect(service.createOrder('u1', {
      orderType: 'SUBSCRIPTION', channel: 'STRIPE', planId: 'p1',
      currency: 'usd', billingPeriod: 'monthly',
      successUrl: 'https://app.example.com/billing/success?order_id=x',
      cancelUrl: 'https://app.example.com/billing/cancel',
    } as any)).rejects.toThrow('Stripe 自动续费订阅暂不可用');

    expect(deps.stripeService.createSubscription).not.toHaveBeenCalled();
  });

  it('applies the recurring safety boundary before callback URL policy', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    setupForStripe(deps);
    const plan = { id: 'p1', isActive: true, monthlyPrice: 4900, yearlyPrice: 3900, name: 'Pro' };
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue({
      plan,
      price: { currency: 'usd', monthlyPrice: 4900, yearlyPrice: 3900 },
    });

    await expect(service.createOrder('u1', {
      orderType: 'SUBSCRIPTION', channel: 'STRIPE', planId: 'p1',
      currency: 'usd', billingPeriod: 'monthly',
      successUrl: 'https://evil.example/billing/success',
      cancelUrl: 'https://app.example.com/billing/cancel',
    } as any)).rejects.toThrow('Stripe 自动续费订阅暂不可用');

    expect(deps.paymentRepo.createOrder).not.toHaveBeenCalled();
    expect(deps.stripeService.createSubscription).not.toHaveBeenCalled();
  });

  it('blocks recurring checkout even with a matching Partner callback allowlist', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    setupForStripe(deps);
    const plan = {
      id: 'p1',
      productId: 'prod-1',
      isActive: true,
      monthlyPrice: 4900,
      yearlyPrice: 3900,
      name: 'Pro',
    };
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue({
      plan,
      price: { currency: 'usd', monthlyPrice: 4900, yearlyPrice: 3900 },
    });

    await expect(service.createOrder(
      'u1',
      {
        orderType: 'SUBSCRIPTION',
        channel: 'STRIPE',
        planId: 'p1',
        currency: 'usd',
        billingPeriod: 'monthly',
        successUrl: 'https://product.example.com/billing/success',
        cancelUrl: 'https://product.example.com/billing/cancel',
      } as any,
      undefined,
      makeProductIntegrationContext(['https://product.example.com']),
    )).rejects.toThrow('Stripe 自动续费订阅暂不可用');

    expect(deps.stripeService.createSubscription).not.toHaveBeenCalled();
  });

  it('rejects a Stripe cancel URL outside the partner product allowlist', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    setupForStripe(deps);
    const plan = {
      id: 'p1',
      productId: 'prod-1',
      isActive: true,
      monthlyPrice: 4900,
      yearlyPrice: 3900,
      name: 'Pro',
    };
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue({
      plan,
      price: { currency: 'usd', monthlyPrice: 4900, yearlyPrice: 3900 },
    });

    await expect(service.createOrder(
      'u1',
      {
        orderType: 'SUBSCRIPTION',
        channel: 'STRIPE',
        planId: 'p1',
        currency: 'usd',
        billingPeriod: 'monthly',
        successUrl: 'https://product.example.com/billing/success',
        cancelUrl: 'https://evil.example.com/billing/cancel',
      } as any,
      undefined,
      makeProductIntegrationContext(['https://product.example.com']),
    )).rejects.toThrow('Stripe 自动续费订阅暂不可用');

    expect(deps.paymentRepo.createOrder).not.toHaveBeenCalled();
    expect(deps.stripeService.createSubscription).not.toHaveBeenCalled();
  });

  it('does not use global Stripe callback URLs for a product-managed policy', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    setupForStripe(deps);
    const plan = {
      id: 'p1',
      productId: 'prod-1',
      isActive: true,
      monthlyPrice: 4900,
      yearlyPrice: 3900,
      name: 'Pro',
    };
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue({
      plan,
      price: { currency: 'usd', monthlyPrice: 4900, yearlyPrice: 3900 },
    });

    await expect(service.createOrder(
      'u1',
      {
        orderType: 'SUBSCRIPTION',
        channel: 'STRIPE',
        planId: 'p1',
        currency: 'usd',
        billingPeriod: 'monthly',
      } as any,
      undefined,
      makeProductIntegrationContext(['https://app.test']),
    )).rejects.toThrow('Stripe 自动续费订阅暂不可用');

    expect(deps.paymentRepo.createOrder).not.toHaveBeenCalled();
    expect(deps.stripeService.createSubscription).not.toHaveBeenCalled();
  });

  it('does not let a global origin bypass a non-null product callback allowlist', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    setupForStripe(deps);
    const plan = {
      id: 'p1',
      productId: 'prod-1',
      isActive: true,
      monthlyPrice: 4900,
      yearlyPrice: 3900,
      name: 'Pro',
    };
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue({
      plan,
      price: { currency: 'usd', monthlyPrice: 4900, yearlyPrice: 3900 },
    });

    await expect(service.createOrder(
      'u1',
      {
        orderType: 'SUBSCRIPTION',
        channel: 'STRIPE',
        planId: 'p1',
        currency: 'usd',
        billingPeriod: 'monthly',
        successUrl: 'https://app.example.com/billing/success',
        cancelUrl: 'https://app.example.com/billing/cancel',
      } as any,
      undefined,
      makeProductIntegrationContext(['https://product.example.com']),
    )).rejects.toThrow('Stripe 自动续费订阅暂不可用');

    expect(deps.paymentRepo.createOrder).not.toHaveBeenCalled();
  });

  it('treats an empty partner product callback allowlist as deny-all', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    setupForStripe(deps);
    const plan = {
      id: 'p1',
      productId: 'prod-1',
      isActive: true,
      monthlyPrice: 4900,
      yearlyPrice: 3900,
      name: 'Pro',
    };
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue({
      plan,
      price: { currency: 'usd', monthlyPrice: 4900, yearlyPrice: 3900 },
    });

    await expect(service.createOrder(
      'u1',
      {
        orderType: 'SUBSCRIPTION',
        channel: 'STRIPE',
        planId: 'p1',
        currency: 'usd',
        billingPeriod: 'monthly',
        successUrl: 'https://app.example.com/billing/success',
        cancelUrl: 'https://app.example.com/billing/cancel',
      } as any,
      undefined,
      makeProductIntegrationContext([]),
    )).rejects.toThrow('Stripe 自动续费订阅暂不可用');

    expect(deps.paymentRepo.createOrder).not.toHaveBeenCalled();
  });

  it('blocks recurring checkout when the product callback setting is null', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    setupForStripe(deps);
    const plan = {
      id: 'p1',
      productId: 'prod-1',
      isActive: true,
      monthlyPrice: 4900,
      yearlyPrice: 3900,
      name: 'Pro',
    };
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue({
      plan,
      price: { currency: 'usd', monthlyPrice: 4900, yearlyPrice: 3900 },
    });

    await expect(service.createOrder(
      'u1',
      {
        orderType: 'SUBSCRIPTION',
        channel: 'STRIPE',
        planId: 'p1',
        currency: 'usd',
        billingPeriod: 'monthly',
        successUrl: 'https://app.example.com/billing/success',
        cancelUrl: 'https://app.example.com/billing/cancel',
      } as any,
      undefined,
      makeProductIntegrationContext(null),
    )).rejects.toThrow('Stripe 自动续费订阅暂不可用');

    expect(deps.stripeService.createSubscription).not.toHaveBeenCalled();
  });

  it('blocks recurring checkout when price resolution falls back to Plan fields', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    setupForStripe(deps);
    const plan = { id: 'p1', isActive: true, monthlyPrice: 1234, yearlyPrice: 999, name: 'Legacy' };
    // price=null: simulate old data, no plan_prices row
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue({ plan, price: null });

    await expect(service.createOrder('u1', {
      orderType: 'SUBSCRIPTION', channel: 'STRIPE', planId: 'p1',
      currency: 'usd', billingPeriod: 'monthly',
    } as any)).rejects.toThrow('Stripe 自动续费订阅暂不可用');

    expect(deps.stripeService.createSubscription).not.toHaveBeenCalled();
  });

  it('blocks quarterly recurring checkout after Plan-field price fallback', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    setupForStripe(deps);
    deps.systemConfigService.getDeploymentConfig.mockResolvedValue({
      version: '2',
      region: 'domestic',
      provider: 'authing',
      currency: 'cny',
      defaultLanguage: 'zh',
      oauth: {},
    });
    const plan = {
      id: 'p1',
      isActive: true,
      monthlyPrice: 0,
      quarterlyPrice: 17600,
      yearlyPrice: 0,
      name: 'GLM Coding Pro',
    };
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue({ plan, price: null });

    await expect(service.createOrder('u1', {
      orderType: 'SUBSCRIPTION', channel: 'STRIPE', planId: 'p1',
      currency: 'cny', billingPeriod: 'quarterly',
    } as any)).rejects.toThrow('Stripe 自动续费订阅暂不可用');

    expect(deps.paymentRepo.findPlanWithPrice).toHaveBeenCalledWith('p1', 'cny');
    expect(deps.stripeService.createSubscription).not.toHaveBeenCalled();
  });

  it('rejects a requested currency that differs from the deployment currency', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    setupForStripe(deps);
    const plan = { id: 'p1', isActive: true, monthlyPrice: 1234, yearlyPrice: 999, name: 'Legacy' };
    deps.paymentRepo.findPlanWithPrice.mockResolvedValue({ plan, price: null });

    await expect(
      service.createOrder('u1', {
        orderType: 'SUBSCRIPTION', channel: 'STRIPE', planId: 'p1',
        currency: 'sgd', billingPeriod: 'monthly',
      } as any),
    ).rejects.toThrow('当前部署仅支持 USD 订单');
    expect(deps.paymentRepo.findPlanWithPrice).not.toHaveBeenCalled();
  });
});

// ============================================================
// PR0-4: RechargeTier 接入充值流程
// ============================================================
describe('PaymentService.createOrder — RechargeTier matching (PR0-4)', () => {
  function makeTier(overrides: Record<string, unknown> = {}) {
    return {
      id: 'tier-1',
      productId: 'prod-1',
      amountCents: 10000,
      bonusType: 'FIXED',
      bonusValue: 1000,
      isActive: true,
      sortOrder: 0,
      startAt: null,
      endAt: null,
      deletedAt: null,
      createdAt: new Date('2025-01-01'),
      ...overrides,
    };
  }

  it('FIXED tier hit: stores tier context in Redis with bonusCents from bonusValue', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.prisma.rechargeTier.findMany.mockResolvedValue([makeTier()]);
    deps.paymentRepo.createOrder.mockResolvedValue(
      makeOrder({ orderType: 'RECHARGE', channel: 'WECHAT', amountCents: 10000 }),
    );
    deps.wechatPayService.createNativePay.mockResolvedValue({ codeUrl: 'weixin://qr' });

    await service.createOrder('u1', {
      orderType: 'RECHARGE',
      channel: 'WECHAT',
      amountCents: 10000,
      productId: 'prod-1',
    } as any);

    expect(deps.prisma.rechargeTier.findMany).toHaveBeenCalled();
    expect(deps.paymentRepo.createOrder).toHaveBeenCalledWith(
      expect.objectContaining({
        rechargeTierId: 'tier-1',
        bonusCents: 1000,
        currency: 'cny',
      }),
    );
    // Redis SET 里的 value 应该包含 tierId + bonusCents=1000
    expect(deps.redis.set).toHaveBeenCalledWith(
      'recharge:tier:order-1',
      expect.stringContaining('"tierId":"tier-1"'),
      'EX',
      expect.any(Number),
    );
    const setCall = deps.redis.set.mock.calls.find(
      (c: unknown[]) => c[0] === 'recharge:tier:order-1',
    );
    const payload = JSON.parse(setCall![1] as string);
    expect(payload).toEqual({ tierId: 'tier-1', bonusCents: 1000 });
  });

  it('PERCENT tier hit: bonusCents = floor(amountCents * pct / 100)', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    // 100元 * 10% = 10元 = 1000 cents
    deps.prisma.rechargeTier.findMany.mockResolvedValue([
      makeTier({ id: 'tier-pct', bonusType: 'PERCENT', bonusValue: 10 }),
    ]);
    deps.paymentRepo.createOrder.mockResolvedValue(
      makeOrder({ orderType: 'RECHARGE', channel: 'WECHAT', amountCents: 10000 }),
    );
    deps.wechatPayService.createNativePay.mockResolvedValue({ codeUrl: 'weixin://qr' });

    await service.createOrder('u1', {
      orderType: 'RECHARGE',
      channel: 'WECHAT',
      amountCents: 10000,
      productId: 'prod-1',
    } as any);

    const setCall = deps.redis.set.mock.calls.find(
      (c: unknown[]) => c[0] === 'recharge:tier:order-1',
    );
    expect(setCall).toBeDefined();
    const payload = JSON.parse(setCall![1] as string);
    expect(payload).toEqual({ tierId: 'tier-pct', bonusCents: 1000 });
  });

  it('no productId in DTO: skips tier lookup entirely (back-compat path)', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.paymentRepo.createOrder.mockResolvedValue(
      makeOrder({ orderType: 'RECHARGE', channel: 'WECHAT' }),
    );
    deps.wechatPayService.createNativePay.mockResolvedValue({ codeUrl: 'weixin://qr' });

    await service.createOrder('u1', {
      orderType: 'RECHARGE',
      channel: 'WECHAT',
      amountCents: 5000,
    } as any);

    expect(deps.prisma.rechargeTier.findMany).not.toHaveBeenCalled();
    // Redis set 不应该带 recharge:tier 前缀
    const tierSetCall = deps.redis.set.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).startsWith('recharge:tier:'),
    );
    expect(tierSetCall).toBeUndefined();
  });

  it('amountCents不匹配任一 tier (含时间窗口外): no Redis context, normal recharge', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    // 时间窗口已过期 → 查询返回空（DB 层用 startAt/endAt 过滤）
    deps.prisma.rechargeTier.findMany.mockResolvedValue([]);
    deps.paymentRepo.createOrder.mockResolvedValue(
      makeOrder({ orderType: 'RECHARGE', channel: 'WECHAT', amountCents: 5000 }),
    );
    deps.wechatPayService.createNativePay.mockResolvedValue({ codeUrl: 'weixin://qr' });

    await service.createOrder('u1', {
      orderType: 'RECHARGE',
      channel: 'WECHAT',
      amountCents: 5000,
      productId: 'prod-1',
    } as any);

    const tierSetCall = deps.redis.set.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).startsWith('recharge:tier:'),
    );
    expect(tierSetCall).toBeUndefined();
  });

  it('claimed tierId mismatches resolved winner → 400', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.prisma.rechargeTier.findMany.mockResolvedValue([makeTier({ id: 'tier-A' })]);

    await expect(
      service.createOrder('u1', {
        orderType: 'RECHARGE',
        channel: 'WECHAT',
        amountCents: 10000,
        productId: 'prod-1',
        tierId: 'tier-B',
      } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('claimed tierId but no tier matched → 400', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.prisma.rechargeTier.findMany.mockResolvedValue([]);

    await expect(
      service.createOrder('u1', {
        orderType: 'RECHARGE',
        channel: 'WECHAT',
        amountCents: 10000,
        productId: 'prod-1',
        tierId: 'tier-B',
      } as any),
    ).rejects.toThrow(BadRequestException);
  });

  it('PERCENT bonusValue out of range (>100) → defensive skip, no bonus stored', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.prisma.rechargeTier.findMany.mockResolvedValue([
      makeTier({ bonusType: 'PERCENT', bonusValue: 150 }),
    ]);
    deps.paymentRepo.createOrder.mockResolvedValue(
      makeOrder({ orderType: 'RECHARGE', channel: 'WECHAT' }),
    );
    deps.wechatPayService.createNativePay.mockResolvedValue({ codeUrl: 'weixin://qr' });

    await service.createOrder('u1', {
      orderType: 'RECHARGE',
      channel: 'WECHAT',
      amountCents: 10000,
      productId: 'prod-1',
    } as any);

    const tierSetCall = deps.redis.set.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).startsWith('recharge:tier:'),
    );
    expect(tierSetCall).toBeUndefined();
  });

  it('FIXED bonusValue=0 → no bonus row written (avoid no-op transaction)', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.prisma.rechargeTier.findMany.mockResolvedValue([
      makeTier({ bonusType: 'FIXED', bonusValue: 0 }),
    ]);
    deps.paymentRepo.createOrder.mockResolvedValue(
      makeOrder({ orderType: 'RECHARGE', channel: 'WECHAT' }),
    );
    deps.wechatPayService.createNativePay.mockResolvedValue({ codeUrl: 'weixin://qr' });

    await service.createOrder('u1', {
      orderType: 'RECHARGE',
      channel: 'WECHAT',
      amountCents: 10000,
      productId: 'prod-1',
    } as any);

    const tierSetCall = deps.redis.set.mock.calls.find(
      (c: unknown[]) => typeof c[0] === 'string' && (c[0] as string).startsWith('recharge:tier:'),
    );
    expect(tierSetCall).toBeUndefined();
  });

  it('multiple active tiers same amount → picks lowest sortOrder', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.prisma.rechargeTier.findMany.mockResolvedValue([
      makeTier({ id: 'tier-low', sortOrder: 0, bonusValue: 500 }),
      makeTier({ id: 'tier-high', sortOrder: 5, bonusValue: 9999 }),
    ]);
    deps.paymentRepo.createOrder.mockResolvedValue(
      makeOrder({ orderType: 'RECHARGE', channel: 'WECHAT' }),
    );
    deps.wechatPayService.createNativePay.mockResolvedValue({ codeUrl: 'weixin://qr' });

    await service.createOrder('u1', {
      orderType: 'RECHARGE',
      channel: 'WECHAT',
      amountCents: 10000,
      productId: 'prod-1',
    } as any);

    const setCall = deps.redis.set.mock.calls.find(
      (c: unknown[]) => c[0] === 'recharge:tier:order-1',
    );
    const payload = JSON.parse(setCall![1] as string);
    expect(payload.tierId).toBe('tier-low');
    expect(payload.bonusCents).toBe(500);
  });
});

describe('PaymentService.fulfillOrder — RECHARGE bonus (PR0-4)', () => {
  it('applies persisted order bonus even when Redis context is absent', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.redis.set.mockResolvedValue('OK');
    deps.redis.get.mockResolvedValue(null);
    deps.prisma.order.findUnique.mockResolvedValue(
      makeOrder({
        orderType: 'RECHARGE',
        status: OrderStatus.PAID,
        paidAt: new Date(),
        amountCents: 10000,
        rechargeTierId: 'tier-db',
        bonusCents: 500,
      }),
    );
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);
    deps.billingService.rechargeWithBonus.mockResolvedValue({ id: 'tx-recharge' });

    await service.retryFulfill('order-1');

    expect(deps.redis.get).not.toHaveBeenCalledWith('recharge:tier:order-1');
    expect(deps.billingService.rechargeWithBonus).toHaveBeenCalledWith(
      'user-1',
      10000,
      500,
      expect.any(String),
      'order-1',
      undefined,
      {
        tenantId: 'tenant-1',
        billingAccountId: 'ba-tenant-1',
        bonusDescription: 'recharge-bonus tier:tier-db',
      },
    );
    expect(deps.billingService.creditBonus).not.toHaveBeenCalled();
  });

  it('applies bonus when Redis context is present, then deletes the key', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.redis.set.mockResolvedValue('OK');
    deps.redis.get.mockImplementation((k: string) =>
      Promise.resolve(
        k === 'recharge:tier:order-1'
          ? JSON.stringify({ tierId: 'tier-1', bonusCents: 1000 })
          : null,
      ),
    );
    deps.redis.del.mockResolvedValue(1);
    deps.prisma.order.findUnique.mockResolvedValue(
      makeOrder({ orderType: 'RECHARGE', status: OrderStatus.PAID, paidAt: new Date(), amountCents: 10000 }),
    );
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);
    deps.billingService.rechargeWithBonus.mockResolvedValue({ id: 'tx-recharge' });

    await service.retryFulfill('order-1');

    expect(deps.billingService.rechargeWithBonus).toHaveBeenCalledWith(
      'user-1',
      10000,
      1000,
      expect.any(String),
      'order-1',
      undefined,
      {
        tenantId: 'tenant-1',
        billingAccountId: 'ba-tenant-1',
        bonusDescription: 'recharge-bonus tier:tier-1',
      },
    );
    expect(deps.billingService.creditBonus).not.toHaveBeenCalled();
    // Redis key 应被清理
    expect(deps.redis.del).toHaveBeenCalledWith('recharge:tier:order-1');
  });

  it('no Redis context → no bonus applied, recharge proceeds normally', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.redis.set.mockResolvedValue('OK');
    deps.redis.get.mockResolvedValue(null);
    deps.prisma.order.findUnique.mockResolvedValue(
      makeOrder({ orderType: 'RECHARGE', status: OrderStatus.PAID, paidAt: new Date() }),
    );
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);
    deps.billingService.rechargeWithBonus.mockResolvedValue({ id: 'tx-recharge' });

    await service.retryFulfill('order-1');

    expect(deps.billingService.rechargeWithBonus).toHaveBeenCalled();
    expect(deps.billingService.creditBonus).not.toHaveBeenCalled();
  });

  it('corrupted Redis JSON → silent skip, recharge still completes', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.redis.set.mockResolvedValue('OK');
    deps.redis.get.mockResolvedValue('not-json');
    deps.redis.del.mockResolvedValue(1);
    deps.prisma.order.findUnique.mockResolvedValue(
      makeOrder({ orderType: 'RECHARGE', status: OrderStatus.PAID, paidAt: new Date() }),
    );
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);
    deps.billingService.rechargeWithBonus.mockResolvedValue({ id: 'tx-recharge' });

    await service.retryFulfill('order-1');

    expect(deps.billingService.rechargeWithBonus).toHaveBeenCalledWith(
      'user-1',
      9900,
      0,
      expect.any(String),
      'order-1',
      undefined,
      {
        tenantId: 'tenant-1',
        billingAccountId: 'ba-tenant-1',
        bonusDescription: 'recharge-bonus',
      },
    );
    expect(deps.billingService.creditBonus).not.toHaveBeenCalled();
    // 损坏的 key 被清理
    expect(deps.redis.del).toHaveBeenCalledWith('recharge:tier:order-1');
  });

  it('rechargeWithBonus throws → retryFulfill does not delete recharge tier context', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.redis.set.mockResolvedValue('OK');
    deps.redis.get.mockResolvedValue(
      JSON.stringify({ tierId: 'tier-1', bonusCents: 1000 }),
    );
    deps.prisma.order.findUnique.mockResolvedValue(
      makeOrder({ orderType: 'RECHARGE', status: OrderStatus.PAID, paidAt: new Date() }),
    );
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);
    deps.billingService.rechargeWithBonus.mockRejectedValue(new Error('db down'));

    await expect(service.retryFulfill('order-1')).resolves.toBeUndefined();
    expect(deps.billingService.rechargeWithBonus).toHaveBeenCalled();
    const tierDelCalls = deps.redis.del.mock.calls.filter(
      (c: unknown[]) => c[0] === 'recharge:tier:order-1',
    );
    expect(tierDelCalls).toHaveLength(0);
  });

  it('passes Redis bonus context into one recharge batch', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.redis.set.mockResolvedValue('OK');
    deps.redis.get.mockImplementation((k: string) =>
      Promise.resolve(
        k === 'recharge:tier:order-1'
          ? JSON.stringify({ tierId: 'tier-1', bonusCents: 1000 })
          : null,
      ),
    );
    deps.redis.del.mockResolvedValue(1);
    deps.prisma.order.findUnique.mockResolvedValue(
      makeOrder({ orderType: 'RECHARGE', status: OrderStatus.PAID, paidAt: new Date(), amountCents: 10000 }),
    );
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);
    deps.billingService.rechargeWithBonus.mockResolvedValue({ id: 'tx-recharge' });

    await service.retryFulfill('order-1');

    expect(deps.billingService.rechargeWithBonus).toHaveBeenCalledWith(
      'user-1',
      10000,
      1000,
      expect.any(String),
      'order-1',
      undefined,
      {
        tenantId: 'tenant-1',
        billingAccountId: 'ba-tenant-1',
        bonusDescription: 'recharge-bonus tier:tier-1',
      },
    );
  });

  it('rechargeWithBonus failure → does not write legacy bonus audit row', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.redis.set.mockResolvedValue('OK');
    deps.redis.get.mockResolvedValue(
      JSON.stringify({ tierId: 'tier-99', bonusCents: 2500 }),
    );
    deps.prisma.order.findUnique.mockResolvedValue(
      makeOrder({ orderType: 'RECHARGE', status: OrderStatus.PAID, paidAt: new Date() }),
    );
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);
    deps.billingService.rechargeWithBonus.mockRejectedValue(new Error('db down'));
    deps.prisma.orderAuditLog.create.mockResolvedValue({});

    await service.retryFulfill('order-1');

    const auditCall = deps.prisma.orderAuditLog.create.mock.calls.find(
      (c: any[]) => c[0]?.data?.operator === 'system:bonus',
    );
    expect(auditCall).toBeUndefined();
  });

  // PR0-4 review fix(Minor #4): 失败路径不删 Redis context（保留给运营查 30 天）
  it('bonus failure → Redis context NOT deleted (preserved for ops investigation)', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.redis.set.mockResolvedValue('OK');
    deps.redis.get.mockResolvedValue(
      JSON.stringify({ tierId: 'tier-1', bonusCents: 1000 }),
    );
    deps.prisma.order.findUnique.mockResolvedValue(
      makeOrder({ orderType: 'RECHARGE', status: OrderStatus.PAID, paidAt: new Date() }),
    );
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);
    deps.billingService.rechargeWithBonus.mockRejectedValue(new Error('redis down'));

    await service.retryFulfill('order-1');

    // 唯一允许 del 的 key 是 fulfillOrder 自身的 lock；recharge:tier:order-1 必须保留
    const tierDelCalls = deps.redis.del.mock.calls.filter(
      (c: unknown[]) => c[0] === 'recharge:tier:order-1',
    );
    expect(tierDelCalls).toHaveLength(0);
  });
});

// ============================================================
// PR0-4 helper edge cases — coverage for previously untested branches
// ============================================================

describe('PaymentService.RechargeTier helper edges (PR0-4)', () => {
  // L1251: persistRechargeTierContext 在 redis.set 抛错时仅 warn,不阻塞调用方
  // 直接走 private method 测试 swallow 行为
  it('persistRechargeTierContext: redis.set throws → warn, does not propagate', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.redis.set.mockRejectedValue(new Error('redis flaky'));

    const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});

    await expect(
      (service as any).persistRechargeTierContext('order-x', {
        tierId: 'tier-1',
        bonusCents: 1000,
      }),
    ).resolves.toBeUndefined();

    const calls = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(calls).toMatch(/RechargeTier 上下文写入 Redis 失败/);
    warnSpy.mockRestore();
  });

  // L1302-1303: applyRechargeTierBonus 拿到 invalid context (无 tierId 或 bonusCents <= 0)
  // → 不调 creditBonus,但 del key 清理。
  it('applyRechargeTierBonus: invalid context (missing tierId) → del key, no creditBonus call', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.redis.set.mockResolvedValue('OK');
    // 无 tierId
    deps.redis.get.mockResolvedValue(JSON.stringify({ bonusCents: 1000 }));
    deps.prisma.order.findUnique.mockResolvedValue(
      makeOrder({ orderType: 'RECHARGE', status: OrderStatus.PAID, paidAt: new Date() }),
    );
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);
    deps.billingService.rechargeWithBonus.mockResolvedValue({ id: 'tx-recharge' });

    await service.retryFulfill('order-1');

    expect(deps.billingService.creditBonus).not.toHaveBeenCalled();
    // 失败/无效路径之外,仍 del 清理无效 context
    const tierDelCalls = deps.redis.del.mock.calls.filter(
      (c: unknown[]) => c[0] === 'recharge:tier:order-1',
    );
    expect(tierDelCalls.length).toBeGreaterThan(0);
  });

  it('applyRechargeTierBonus: bonusCents <= 0 → del key, no creditBonus call', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.redis.set.mockResolvedValue('OK');
    deps.redis.get.mockResolvedValue(
      JSON.stringify({ tierId: 'tier-1', bonusCents: 0 }),
    );
    deps.prisma.order.findUnique.mockResolvedValue(
      makeOrder({ orderType: 'RECHARGE', status: OrderStatus.PAID, paidAt: new Date() }),
    );
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);
    deps.billingService.rechargeWithBonus.mockResolvedValue({ id: 'tx-recharge' });

    await service.retryFulfill('order-1');

    expect(deps.billingService.creditBonus).not.toHaveBeenCalled();
    const tierDelCalls = deps.redis.del.mock.calls.filter(
      (c: unknown[]) => c[0] === 'recharge:tier:order-1',
    );
    expect(tierDelCalls.length).toBeGreaterThan(0);
  });

  // L1359: recordBonusFailureAudit 自身 prisma 写入失败 → warn 吞错,不向上抛
  // 直接走 private method 测试,避免 fulfillOrder 路径上的多重 mock 嵌套
  it('recordBonusFailureAudit: orderAuditLog.create throws → warn, does not propagate', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);

    deps.prisma.orderAuditLog.create.mockRejectedValue(new Error('db dead'));

    const warnSpy = jest.spyOn((service as any).logger, 'warn').mockImplementation(() => {});

    // 直接调 private 方法测试 audit 写入失败的 swallow 行为
    await expect(
      (service as any).recordBonusFailureAudit(
        'order-1',
        'tier-1',
        1000,
        'user-1',
        'simulated bonus failure',
      ),
    ).resolves.toBeUndefined();

    const calls = warnSpy.mock.calls.flat().map(String).join(' ');
    expect(calls).toMatch(/bonus failure audit 写入失败/);
    warnSpy.mockRestore();
  });
});

// ============================================================
// P2-A2: AlertEvent emission on fulfillOrder failure (spec §7.2.a)
// ============================================================
async function buildServiceWithAlerts(
  deps: ReturnType<typeof makeDeps>,
  alertEvents: { createAlert: jest.Mock },
) {
  const m = await Test.createTestingModule({
    providers: [
      PaymentService,
      { provide: PaymentRepository, useValue: deps.paymentRepo },
      { provide: BillingService, useValue: deps.billingService },
      { provide: BoosterPackService, useValue: deps.boosterPackService },
      { provide: CreditService, useValue: deps.creditService },
      { provide: SystemConfigService, useValue: deps.systemConfigService },
      { provide: WechatPayService, useValue: deps.wechatPayService },
      { provide: AlipayService, useValue: deps.alipayService },
      { provide: StripeService, useValue: deps.stripeService },
      { provide: SubscriptionResolverService, useValue: deps.subscriptionResolver },
      { provide: ProductSyncNotifier, useValue: deps.productSync },
      { provide: PrismaService, useValue: deps.prisma },
      { provide: RedisService, useValue: deps.redis },
      { provide: ConfigService, useValue: deps.config },
      { provide: CampaignService, useValue: deps.campaignService },
      { provide: DiscountCodeService, useValue: deps.discountCodeService },
      { provide: RefundCompensationService, useValue: deps.refundCompensation },
      { provide: ProviderRefundSagaService, useValue: deps.providerRefundSaga },
      { provide: UserPurchaseVerificationClient, useValue: deps.userPurchaseVerification },
      { provide: AlertEventService, useValue: alertEvents },
    ],
  }).compile();
  return m.get(PaymentService) as PaymentService;
}

describe('PaymentService.fulfillOrder — P2-A2 AlertEvent on failure', () => {
  it('emits PAYMENT/HIGH AlertEvent when SUBSCRIPTION fulfillment throws', async () => {
    const deps = makeDeps();
    const alertEvents = { createAlert: jest.fn().mockResolvedValue(null) };
    const service = await buildServiceWithAlerts(deps, alertEvents);

    const paidOrder = makeOrder({
      orderType: 'SUBSCRIPTION',
      planId: 'plan-1',
      status: OrderStatus.PAID,
      amountCents: 12345,
      channel: PayChannel.WECHAT,
    });
    const fulfillingOrder = { ...paidOrder, status: OrderStatus.FULFILLING };

    deps.redis.set.mockResolvedValue('OK');
    deps.prisma.order.findUnique
      .mockResolvedValueOnce(paidOrder)
      .mockResolvedValueOnce(paidOrder)
      .mockResolvedValueOnce(fulfillingOrder);
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);
    deps.prisma.plan.findUnique.mockResolvedValue({
      id: 'plan-1',
      productId: 'prod-1',
      monthlyCredits: 1000,
      name: 'Pro',
    });
    // Make activateSubscription throw → falls into the catch block that
    // emits the AlertEvent + transitions to FAILED.
    deps.billingService.activateSubscription.mockRejectedValue(
      new Error('activation boom'),
    );

    await service.retryFulfill('order-1');
    // Wait microtask queue so fire-and-forget createAlert .catch settles.
    await Promise.resolve();
    await Promise.resolve();

    expect(alertEvents.createAlert).toHaveBeenCalledTimes(1);
    const arg = alertEvents.createAlert.mock.calls[0][0];
    expect(arg.category).toBe('PAYMENT');
    expect(arg.severity).toBe('HIGH');
    expect(arg.sourceType).toBe('order');
    expect(arg.sourceId).toBe('order-1');
    expect(arg.userId).toBe('user-1');
    expect(arg.context).toMatchObject({
      amountCents: 12345,
      channel: PayChannel.WECHAT,
      orderType: 'SUBSCRIPTION',
    });
    expect(arg.message).toMatch(/activation boom/);
  });

  it('createAlert throwing does NOT prevent transitionOrderStatus(FAILED)', async () => {
    const deps = makeDeps();
    const alertEvents = {
      createAlert: jest.fn().mockRejectedValue(new Error('alert DB down')),
    };
    const service = await buildServiceWithAlerts(deps, alertEvents);

    const paidOrder = makeOrder({
      orderType: 'SUBSCRIPTION',
      planId: 'plan-1',
      status: OrderStatus.PAID,
    });
    const fulfillingOrder = { ...paidOrder, status: OrderStatus.FULFILLING };

    deps.redis.set.mockResolvedValue('OK');
    deps.prisma.order.findUnique
      .mockResolvedValueOnce(paidOrder)
      .mockResolvedValueOnce(paidOrder)
      .mockResolvedValueOnce(fulfillingOrder)
      // After fulfill catch → transitionOrderStatus FULFILLING→FAILED needs
      // another findUnique on the order.
      .mockResolvedValueOnce(fulfillingOrder);
    deps.prisma.$transaction.mockResolvedValue([{}, {}]);
    deps.prisma.plan.findUnique.mockResolvedValue({
      id: 'plan-1',
      productId: 'prod-1',
      monthlyCredits: 1000,
      name: 'Pro',
    });
    deps.billingService.activateSubscription.mockRejectedValue(
      new Error('activation boom'),
    );

    await expect(service.retryFulfill('order-1')).resolves.not.toThrow();
    await Promise.resolve();
    await Promise.resolve();

    expect(alertEvents.createAlert).toHaveBeenCalled();
    // 主链路不能挂:验证 $transaction 被调用过(transitionOrderStatus 走 tx)。
    expect(deps.prisma.$transaction).toHaveBeenCalled();
  });
});

describe('PaymentService.recordDiscountRedemptions', () => {
  it('records discount code redemption under an advisory lock and increments usage atomically', async () => {
    const deps = makeDeps();
    setupPrismaTransaction(deps.prisma);
    const service = await buildService(deps);

    await (service as any).recordDiscountRedemptions({
      id: 'order-1',
      userId: 'u1',
      campaignId: null,
      discountCodeId: 'dc1',
      discountAmountCents: 500,
    });

    expect(deps.prisma.discountCodeRedemption.findFirst).toHaveBeenCalledWith({
      where: { orderId: 'order-1' },
    });
    expect(deps.prisma.discountCode.update).toHaveBeenCalledWith({
      where: { id: 'dc1' },
      data: { currentUses: { increment: 1 } },
    });
    expect(deps.prisma.discountCodeRedemption.create).toHaveBeenCalledWith({
      data: {
        discountCodeId: 'dc1',
        userId: 'u1',
        orderId: 'order-1',
        amountSavedCents: 500,
      },
    });
  });

  it('rejects redemption when maxUsesPerUser has already been reached', async () => {
    const deps = makeDeps();
    setupPrismaTransaction(deps.prisma);
    deps.prisma.discountCodeRedemption.count.mockResolvedValue(1);
    const service = await buildService(deps);

    await expect((service as any).recordDiscountRedemptions({
      id: 'order-1',
      userId: 'u1',
      campaignId: null,
      discountCodeId: 'dc1',
      discountAmountCents: 500,
    })).rejects.toThrow(BadRequestException);

    expect(deps.prisma.discountCode.update).not.toHaveBeenCalled();
    expect(deps.prisma.discountCodeRedemption.create).not.toHaveBeenCalled();
  });

  it('uses updateMany when maxUses is finite so concurrent redemptions cannot exceed the limit', async () => {
    const deps = makeDeps();
    setupPrismaTransaction(deps.prisma);
    deps.prisma.discountCode.findUnique.mockResolvedValue({
      id: 'dc1',
      isActive: true,
      maxUses: 3,
      maxUsesPerUser: 0,
      currentUses: 2,
    });
    deps.prisma.discountCode.updateMany.mockResolvedValue({ count: 1 });
    const service = await buildService(deps);

    await (service as any).recordDiscountRedemptions({
      id: 'order-1',
      userId: 'u1',
      campaignId: null,
      discountCodeId: 'dc1',
      discountAmountCents: 500,
    });

    expect(deps.prisma.discountCode.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'dc1',
        currentUses: { lt: 3 },
      },
      data: { currentUses: { increment: 1 } },
    });
  });
});

describe('PaymentService.calculateSubscriptionProration — 自营换档抵扣 / 禁降档（fix3 §2 方案A）', () => {
  const DAY_MS = 24 * 60 * 60 * 1000;
  const periodMonthsOf = (bp: string) => (bp === 'quarterly' ? 3 : bp === 'yearly' ? 12 : 1);
  type RenewalSpec = {
    orderId: string;
    amountCents: number;
    prorationCreditCents?: number;
    currency?: string;
    billingPeriod?: string;
  };
  // 构建分段模型的 mock：原始/切换单(block0) + 可选续订单(renewal blocks)。默认自动按
  // totalMonths×validityDays 生成一致的 createdAt/expiresAt(满足一致性守卫)；elapsedDays 控制「现在」落哪个月。
  function setupSelfOp(
    deps: ReturnType<typeof makeDeps>,
    opts: {
      oldMonthly?: number;
      paidCents?: number;
      prorationCreditCents?: number;
      remainingQuota?: number;
      billingPeriod?: string;
      validityDays?: number;
      elapsedDays?: number;
      createdAt?: Date;
      expiresAt?: Date;
      currency?: string;
      renewals?: RenewalSpec[];
      orders?: unknown[]; // 显式覆盖 order.findMany 结果（测退款过滤/脏数据）
    } = {},
  ) {
    const {
      oldMonthly = 1600,
      paidCents = 990,
      prorationCreditCents = 0,
      remainingQuota = 800,
      billingPeriod = 'monthly',
      validityDays = 30,
      elapsedDays = 0,
      createdAt,
      expiresAt,
      currency = 'cny',
      renewals = [],
      orders,
    } = opts;
    const totalMonths =
      periodMonthsOf(billingPeriod) +
      renewals.reduce((s, r) => s + periodMonthsOf(r.billingPeriod ?? 'monthly'), 0);
    const created = createdAt ?? new Date(Date.now() - elapsedDays * DAY_MS - 60_000);
    const expires = expiresAt ?? new Date(created.getTime() + totalMonths * validityDays * DAY_MS);
    deps.prisma.codingPlanEntitlement.findFirst.mockResolvedValue({
      id: 'ent-old',
      planId: 'plan-lite',
      orderId: 'order-old',
      billingPeriod,
      createdAt: created,
      expiresAt: expires,
    } as never);
    deps.prisma.plan.findUnique.mockResolvedValue({ monthlyCredits: oldMonthly, validityDays } as never);
    // 续订审计行
    deps.prisma.codingPlanEntitlement.findMany.mockResolvedValue(
      renewals.map((r) => ({ orderId: r.orderId })) as never,
    );
    // 服务块 order（原始 + 续订）
    const originalOrder = {
      id: 'order-old',
      amountCents: paidCents,
      prorationCreditCents,
      currency,
      billingPeriod,
      createdAt: created,
    };
    const renewalOrders = renewals.map((r, i) => ({
      id: r.orderId,
      amountCents: r.amountCents,
      prorationCreditCents: r.prorationCreditCents ?? 0,
      currency: r.currency ?? currency,
      billingPeriod: r.billingPeriod ?? 'monthly',
      createdAt: new Date(created.getTime() + (i + 1) * 1000),
    }));
    deps.prisma.order.findMany.mockResolvedValue((orders ?? [originalOrder, ...renewalOrders]) as never);
    deps.creditService.getAuthoritativeBalances.mockResolvedValue({
      quota: remainingQuota,
      bonus: 0,
      grant: 0,
      total: remainingQuota,
    });
  }
  const baseParams = {
    userId: 'u1',
    tenantId: 't1',
    productId: 'prod-self',
    targetPlanId: 'plan-std',
    targetBillingPeriod: 'monthly' as const,
    currency: 'cny',
    maxCreditCents: 100000,
    targetIsSelfOpCodingPlan: true,
  };

  it('升档：抵扣 = 旧单实付 × 剩余比例（¥9.9 实付、用一半 → 495 分）', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    setupSelfOp(deps, { oldMonthly: 1600, paidCents: 990, remainingQuota: 800 });
    const r = await (service as never as { calculateSubscriptionProration: (p: unknown) => Promise<{ creditCents: number; sourcePlanId: string; sourceEntitlementId?: string } | null> })
      .calculateSubscriptionProration({ ...baseParams, targetMonthlyCredits: 80000 });
    expect(r?.creditCents).toBe(495);
    expect(r?.sourcePlanId).toBe('plan-lite');
    expect(r?.sourceEntitlementId).toBe('ent-old'); // 履约锚定同一性
    expect(deps.creditService.getAuthoritativeBalances).toHaveBeenCalledWith('ent-old', 'u1');
    expect(deps.creditService.getBalances).not.toHaveBeenCalled();
  });

  it('降档：目标档月度积分 < 当前档 → 抛 BadRequest（拒单）', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    setupSelfOp(deps, { oldMonthly: 1600 });
    await expect(
      (service as never as { calculateSubscriptionProration: (p: unknown) => Promise<unknown> })
        .calculateSubscriptionProration({ ...baseParams, targetPlanId: 'plan-mini', targetMonthlyCredits: 400 }),
    ).rejects.toThrow(BadRequestException);
  });

  it('同档续订（targetPlanId == 当前）→ null（不走换档抵扣）', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    setupSelfOp(deps);
    const r = await (service as never as { calculateSubscriptionProration: (p: unknown) => Promise<unknown> })
      .calculateSubscriptionProration({ ...baseParams, targetPlanId: 'plan-lite', targetMonthlyCredits: 1600 });
    expect(r).toBeNull();
  });

  it('首购（无 active 自营）→ null', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    deps.prisma.codingPlanEntitlement.findFirst.mockResolvedValue(null as never);
    const r = await (service as never as { calculateSubscriptionProration: (p: unknown) => Promise<unknown> })
      .calculateSubscriptionProration({ ...baseParams, targetMonthlyCredits: 80000 });
    expect(r).toBeNull();
  });

  it('超额不支持换套餐：剩余价值 > 目标本单价 → 抛 BadRequest（不封顶抵扣、不蒸发、不支付）', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    setupSelfOp(deps, { oldMonthly: 1600, paidCents: 990, remainingQuota: 1600 }); // 全额 → rawCredit 990
    await expect(
      (service as never as { calculateSubscriptionProration: (p: unknown) => Promise<unknown> })
        .calculateSubscriptionProration({ ...baseParams, targetMonthlyCredits: 80000, maxCreditCents: 300 }),
    ).rejects.toThrow(BadRequestException);
  });

  it('基准含结转：heldValue = amountCents + prorationCreditCents（链式升级不漏结转价值）', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    // 净现金 100 + 从上一档结转 50 = 持有价值 150；月付、当月全额 → rawCredit 150（若只用净现金则为 100）。
    setupSelfOp(deps, { oldMonthly: 1000, paidCents: 100, prorationCreditCents: 50, remainingQuota: 1000 });
    const r = await (service as never as { calculateSubscriptionProration: (p: unknown) => Promise<{ creditCents: number } | null> })
      .calculateSubscriptionProration({ ...baseParams, targetMonthlyCredits: 80000 });
    expect(r?.creditCents).toBe(150);
  });

  it('季度多月刚买：剩余整月(2)+当月(1) → 抵扣≈全额持有价值（¥267）', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    // 季度 Pro：净现金 16718 + 结转 9982 = 持有 26700；刚买(created 1min前, expires +90天)、当月全额。
    setupSelfOp(deps, {
      oldMonthly: 8000,
      paidCents: 16718,
      prorationCreditCents: 9982,
      remainingQuota: 8000,
      billingPeriod: 'quarterly',
      createdAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 90 * DAY_MS),
    });
    const r = await (service as never as { calculateSubscriptionProration: (p: unknown) => Promise<{ creditCents: number } | null> })
      .calculateSubscriptionProration({ ...baseParams, targetMonthlyCredits: 80000, maxCreditCents: 100000 });
    // perMonthValue=8900, effective=2(整月)+1(当月)=3 → 26700
    expect(r?.creditCents).toBe(26700);
  });

  it('季度→月付且剩余价值(¥267) > 目标本单价(¥262) → 超额拒单（用户第3单场景）', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    setupSelfOp(deps, {
      oldMonthly: 8000,
      paidCents: 16718,
      prorationCreditCents: 9982,
      remainingQuota: 8000,
      billingPeriod: 'quarterly',
      createdAt: new Date(Date.now() - 60_000),
      expiresAt: new Date(Date.now() + 90 * DAY_MS),
    });
    await expect(
      (service as never as { calculateSubscriptionProration: (p: unknown) => Promise<unknown> })
        .calculateSubscriptionProration({ ...baseParams, targetMonthlyCredits: 80000, maxCreditCents: 26200 }),
    ).rejects.toThrow(BadRequestException);
  });

  it('跨币种（原始单 currency ≠ 本单）→ null（不误算）', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    setupSelfOp(deps, { currency: 'usd' }); // 原始单 usd，本单 cny
    const r = await (service as never as { calculateSubscriptionProration: (p: unknown) => Promise<unknown> })
      .calculateSubscriptionProration({ ...baseParams, currency: 'cny', targetMonthlyCredits: 80000 });
    expect(r).toBeNull();
  });

  it('0 元订单仍拦降档（maxCreditCents=0 不绕过禁令）', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    setupSelfOp(deps, { oldMonthly: 1600 });
    await expect(
      (service as never as { calculateSubscriptionProration: (p: unknown) => Promise<unknown> })
        .calculateSubscriptionProration({ ...baseParams, targetPlanId: 'plan-mini', targetMonthlyCredits: 400, maxCreditCents: 0 }),
    ).rejects.toThrow(BadRequestException);
  });

  it('目标 0 元且非降档、旧套餐仍有持有价值 → 超额拒单（maxCreditCents=0 不绕过超额闸，codex P1）', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    // heldValue=500、月付、当月全额 → rawCredit 500 > 0+1 → 拒单，不因 0 元静默放行让旧价值蒸发。
    setupSelfOp(deps, { oldMonthly: 1000, paidCents: 500, remainingQuota: 1000 });
    await expect(
      (service as never as { calculateSubscriptionProration: (p: unknown) => Promise<unknown> })
        .calculateSubscriptionProration({ ...baseParams, targetMonthlyCredits: 80000, maxCreditCents: 0 }),
    ).rejects.toThrow(BadRequestException);
  });

  it('边界：rawCredit=1 且 maxCreditCents=0 → 退化为无抵扣返回 null（不误拒单）', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    // heldValue=1、月付、当月全额 → rawCredit=round(1×1)=1；maxCreditCents=0 时 1>0+1 不成立 → clamp 0 → null。
    setupSelfOp(deps, { oldMonthly: 1000, paidCents: 1, remainingQuota: 1000 });
    const r = await (service as never as { calculateSubscriptionProration: (p: unknown) => Promise<unknown> })
      .calculateSubscriptionProration({ ...baseParams, targetMonthlyCredits: 80000, maxCreditCents: 0 });
    expect(r).toBeNull();
  });

  it('边界：rawCredit=2 且 maxCreditCents=0 → 超额拒单（超过 +1 容差）', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    // heldValue=2 → rawCredit=2；2 > 0+1 → 拒单。
    setupSelfOp(deps, { oldMonthly: 1000, paidCents: 2, remainingQuota: 1000 });
    await expect(
      (service as never as { calculateSubscriptionProration: (p: unknown) => Promise<unknown> })
        .calculateSubscriptionProration({ ...baseParams, targetMonthlyCredits: 80000, maxCreditCents: 0 }),
    ).rejects.toThrow(BadRequestException);
  });

  it('季度临到期（剩≈1天）：整月0 + 当月比例 → ≈单月持有价值', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    // span=90天(created 89天前, expires +1天)、perMonthMs=30天、remainingMs≈1天 → ceil(1/30)-1=0 整月；
    // 当月比例=8000/8000=1 → perMonthValue(8900)×1 = 8900（最后一期只剩当月价值）。
    setupSelfOp(deps, {
      oldMonthly: 8000,
      paidCents: 16718,
      prorationCreditCents: 9982,
      remainingQuota: 8000,
      billingPeriod: 'quarterly',
      createdAt: new Date(Date.now() - 89 * DAY_MS),
      expiresAt: new Date(Date.now() + 1 * DAY_MS),
    });
    const r = await (service as never as { calculateSubscriptionProration: (p: unknown) => Promise<{ creditCents: number } | null> })
      .calculateSubscriptionProration({ ...baseParams, targetMonthlyCredits: 80000, maxCreditCents: 100000 });
    expect(r?.creditCents).toBe(8900);
  });

  it('季度剩余略超 1 整月（剩31天）：整月1 + 当月 → 2 个月持有价值', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    // span=90天(created 59天前, expires +31天)、perMonthMs=30天、remainingMs≈31天 → ceil(31/30)-1=1 整月；
    // 当月比例=1 → (1+1)×8900 = 17800（跨整月临界，验证 ceil/-1 口径）。
    setupSelfOp(deps, {
      oldMonthly: 8000,
      paidCents: 16718,
      prorationCreditCents: 9982,
      remainingQuota: 8000,
      billingPeriod: 'quarterly',
      createdAt: new Date(Date.now() - 59 * DAY_MS),
      expiresAt: new Date(Date.now() + 31 * DAY_MS),
    });
    const r = await (service as never as { calculateSubscriptionProration: (p: unknown) => Promise<{ creditCents: number } | null> })
      .calculateSubscriptionProration({ ...baseParams, targetMonthlyCredits: 80000, maxCreditCents: 100000 });
    expect(r?.creditCents).toBe(17800);
  });

  // ── 续订后换档：分段计值（用户实测缺口） ───────────────────────────────────────
  it('续订后换档：原始1月¥100 + 续订3月¥270 → 当前月落 block0 → 100×ratio+270（用户案例）', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    // block0=ird 1月(净80.48+结转19.52=¥100)、renewal=3月¥270；totalMonths=4、刚续订(k=0)、本月未用0.9964。
    setupSelfOp(deps, {
      oldMonthly: 330000,
      paidCents: 8048,
      prorationCreditCents: 1952,
      remainingQuota: 328827,
      billingPeriod: 'monthly',
      elapsedDays: 0,
      renewals: [{ orderId: 'order-renew', amountCents: 27000, billingPeriod: 'quarterly' }],
    });
    // 当前月 block0 perMonth=10000×0.9964=9964 + 未来3月 block1 perMonth 9000×3=27000 → 36964 = ¥369.64
    // 目标 Max 月度积分=330000（与 ird 同，非降档）；maxCreditCents=Max 季度价 ¥867。
    const r = await (service as never as { calculateSubscriptionProration: (p: unknown) => Promise<{ creditCents: number } | null> })
      .calculateSubscriptionProration({ ...baseParams, targetMonthlyCredits: 330000, maxCreditCents: 86700 });
    expect(r?.creditCents).toBe(36964);
  });

  it('续订后换档且目标本单价低于剩余价值（Max 月付 ¥289）→ 超额拒单', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    setupSelfOp(deps, {
      oldMonthly: 330000,
      paidCents: 8048,
      prorationCreditCents: 1952,
      remainingQuota: 328827,
      billingPeriod: 'monthly',
      renewals: [{ orderId: 'order-renew', amountCents: 27000, billingPeriod: 'quarterly' }],
    });
    // 目标 Max 月度积分=330000（非降档）；maxCreditCents=Max 月付价 ¥289 < 剩余 ¥369.64 → 超额拒单。
    await expect(
      (service as never as { calculateSubscriptionProration: (p: unknown) => Promise<unknown> })
        .calculateSubscriptionProration({ ...baseParams, targetMonthlyCredits: 330000, maxCreditCents: 28900 }),
    ).rejects.toThrow(BadRequestException);
  });

  it('不同单月价分段（不均摊）：¥100/1月 + ¥600/12月、首月剩50% → 650（codex 反例）', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    // block0 perMonth=10000、block1 perMonth=60000/12=5000；当前 block0×0.5=5000 + 未来12月×5000=60000 → 65000
    setupSelfOp(deps, {
      oldMonthly: 1000,
      paidCents: 10000,
      remainingQuota: 500,
      billingPeriod: 'monthly',
      renewals: [{ orderId: 'order-renew', amountCents: 60000, billingPeriod: 'yearly' }],
    });
    const r = await (service as never as { calculateSubscriptionProration: (p: unknown) => Promise<{ creditCents: number } | null> })
      .calculateSubscriptionProration({ ...baseParams, targetMonthlyCredits: 80000, maxCreditCents: 100000 });
    expect(r?.creditCents).toBe(65000);
  });

  it('当前月落续订块：block0 已全过去、只算 block1 剩余当月', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    // totalMonths=4(1+3)、created 90天前(k=floor(90/30)=3→block1最后一月)、expires +30天；block0(月0)已过去不计。
    const created = new Date(Date.now() - 90 * DAY_MS);
    setupSelfOp(deps, {
      oldMonthly: 8000,
      paidCents: 10000,
      remainingQuota: 8000, // 本月未用比例=1
      billingPeriod: 'monthly',
      createdAt: created,
      expiresAt: new Date(created.getTime() + 4 * 30 * DAY_MS), // span=120天=4×30
      renewals: [{ orderId: 'order-renew', amountCents: 27000, billingPeriod: 'quarterly' }],
    });
    const r = await (service as never as { calculateSubscriptionProration: (p: unknown) => Promise<{ creditCents: number } | null> })
      .calculateSubscriptionProration({ ...baseParams, targetMonthlyCredits: 80000, maxCreditCents: 100000 });
    // 当前月 k=3 属 block1(perMonth 9000)×1，无未来月 → 9000
    expect(r?.creditCents).toBe(9000);
  });

  it('一致性守卫：span 与 totalMonths×validityDays 不符（validityDays 中途被改）→ null（不错位）', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    // validityDays=45，但时间轴按 30 天/月构建(span=120天)，totalMonths=4 → expected 180天 ≠ 120天 → null。
    const created = new Date(Date.now() - 60_000);
    setupSelfOp(deps, {
      oldMonthly: 8000,
      paidCents: 10000,
      remainingQuota: 8000,
      billingPeriod: 'monthly',
      validityDays: 45,
      createdAt: created,
      expiresAt: new Date(created.getTime() + 4 * 30 * DAY_MS), // 120天，与 4×45 不符
      renewals: [{ orderId: 'order-renew', amountCents: 27000, billingPeriod: 'quarterly' }],
    });
    const r = await (service as never as { calculateSubscriptionProration: (p: unknown) => Promise<unknown> })
      .calculateSubscriptionProration({ ...baseParams, targetMonthlyCredits: 80000, maxCreditCents: 100000 });
    expect(r).toBeNull();
  });

  it('跨币种续订块 → 整条 null（不删块部分抵扣）', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    setupSelfOp(deps, {
      oldMonthly: 8000,
      paidCents: 10000,
      remainingQuota: 8000,
      billingPeriod: 'monthly',
      renewals: [{ orderId: 'order-renew', amountCents: 27000, billingPeriod: 'quarterly', currency: 'usd' }],
    });
    const r = await (service as never as { calculateSubscriptionProration: (p: unknown) => Promise<unknown> })
      .calculateSubscriptionProration({ ...baseParams, currency: 'cny', targetMonthlyCredits: 80000, maxCreditCents: 100000 });
    expect(r).toBeNull();
  });

  it('过期 entitlement（expiresAt<=now）→ null（无剩余价值）', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    const created = new Date(Date.now() - 40 * DAY_MS);
    setupSelfOp(deps, {
      oldMonthly: 1000,
      paidCents: 10000,
      remainingQuota: 1000,
      billingPeriod: 'monthly',
      createdAt: created,
      expiresAt: new Date(created.getTime() + 30 * DAY_MS), // 已过期 10 天
    });
    const r = await (service as never as { calculateSubscriptionProration: (p: unknown) => Promise<unknown> })
      .calculateSubscriptionProration({ ...baseParams, targetMonthlyCredits: 80000 });
    expect(r).toBeNull();
  });

  it('order.findMany 只纳入 PAID/FULFILLING/COMPLETED（排除退款单）', async () => {
    const deps = makeDeps();
    const service = await buildService(deps);
    setupSelfOp(deps);
    await (service as never as { calculateSubscriptionProration: (p: unknown) => Promise<unknown> })
      .calculateSubscriptionProration({ ...baseParams, targetMonthlyCredits: 80000 });
    const call = deps.prisma.order.findMany.mock.calls[0]?.[0] as { where?: { status?: { in?: string[] } } };
    expect(call?.where?.status?.in).toEqual(
      expect.arrayContaining([OrderStatus.PAID, OrderStatus.FULFILLING, OrderStatus.COMPLETED]),
    );
  });
});
