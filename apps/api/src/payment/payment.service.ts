import {
  Injectable,
  NotFoundException,
  BadRequestException,
  ConflictException,
  ForbiddenException,
  ServiceUnavailableException,
  Logger,
  Inject,
  Optional,
} from '@nestjs/common';
import { createHash, randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import { AlertEventService } from '../alert-events/alert-events.service';
import { ReferralsService } from '../referrals/referrals.service';
import { GrowthEventsService } from '../growth-events/growth-events.service';
import {
  BillingService,
  RechargeBillingSubjectChangedError,
} from '../billing/billing.service';
import type { ProductIntegrationContext } from '../billing/product-integration-auth.service';
import { SelfOpProrationSourceInvalidError } from '../billing/coding-plan-errors';
import { BoosterPackService } from '../billing/booster-pack.service';
import { CreditService } from '../billing/credit.service';
import { SystemConfigService } from '../billing/system-config.service';
import { SubscriptionResolverService } from '../billing/subscription-resolver.service';
import { SubscriptionLifecycleService } from '../billing/subscription-lifecycle.service';
import {
  WechatPayOrderOutcomeUnknownError,
  WechatPayService,
} from './wechat-pay.service';
import { AlipayService, type AlipayCredentials } from './alipay.service';
import {
  StripeService,
  type StripeCredentials,
  type StripeLedgerSnapshot,
  type StripeRefundResult,
} from './stripe.service';
import { PaymentProviderRegistry, type ProviderInstance } from './payment-provider-registry';
import { PaymentRepository } from './payment.repository';
import { ProductSyncNotifier } from '../integration/product-sync-notifier';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { CampaignService } from '../campaign/campaign.service';
import { DiscountCodeService } from '../campaign/discount-code.service';
import { type AvailablePaymentMethod, type BillingPeriod, CreateOrderInput, CreateOrderResponse, Order, OrderStatus as SharedOrderStatus, OrderType, PaymentChannel, type PaymentMethodsQueryInput, type PaymentMethodsResponse } from '@ruidong/shared';
import { AlertEventCategory, AlertEventSeverity, BundleItemBillingType, CodingPlanEntitlementStatus, CodingPlanFulfillmentMode, Order as PrismaOrder, OrderItemStatus, PaymentCheckoutInitState, Prisma, ProviderRefundIntent, ProviderRefundIntentStatus, RefundCompensationTaskStatus, StripeSubscriptionCancellationTask, OrderStatus, OrderType as PrismaOrderType, PayChannel, ProductBillingMode, RechargeBonusType, TransactionType as PrismaTransactionType } from '@prisma/client';
import { resolvePlanPeriodMonthlyEquivalentCents } from '../billing/plan-pricing.util';
import { acquirePlanWriteLock } from '../billing/plan-write-lock';
import { normalizeCurrencyCode, resolvePlatformCurrency } from '../billing/platform-currency';
import { hasPrismaErrorCode } from '../common/utils/prisma-error.util';
import { CodingPlanFulfillmentService } from './coding-plan-fulfillment.service';
import { assertAllowedPaymentCallbackUrl } from './payment-callback-url-policy';
import { UserPurchaseVerificationClient } from './user-purchase-verification.client';
import {
  RefundCompensationService,
  SelfOperatedCodingPlanRefundEligibilityError,
  SelfOperatedCodingPlanRefundHoldRetryError,
  type SelfOperatedCodingPlanRefundEvidence,
  type StripeSubscriptionRefundEvidence,
} from './refund-compensation.service';
import {
  ProviderRefundSagaService,
  type ClaimedProviderRefundIntent,
} from './provider-refund-saga.service';
import type { ProviderRefundOutcome } from './provider-refund.types';
import { PLAN_SALES_RESERVED_ORDER_STATUSES } from '../billing/plan-sales-status';
import { decrypt, encrypt } from '../common/utils/crypto';

// RechargeTier 上下文会写入 Order.rechargeTierId/bonusCents；Redis 只保留为
// 旧订单和部署窗口内的兼容兜底。
//
// PR0-4 review fix(Minor #3): 30 天 TTL。
// 支付宝网页支付、微信扫码、Stripe Checkout 都是异步到账。
// 30 天能覆盖支付窗口、回调延迟和运营查证缓冲。
// 失败路径不主动 del key（review fix Minor #4），让运营查清后再清理或自然过期。
const RECHARGE_TIER_TTL_SECONDS = 30 * 24 * 60 * 60;
const DEFAULT_RECHARGE_MIN_CENTS = 500;
const DEFAULT_RECHARGE_MAX_CENTS = 2_500_000;
const FULFILLMENT_LOCK_SECONDS = 5 * 60;
const REFUND_LOCK_SECONDS = 30 * 60;
const FULFILLMENT_STALE_MS = 10 * 60 * 1000;
const CHECKOUT_INITIALIZATION_LEASE_MS = 2 * 60 * 1000;
const STRIPE_CANCELLATION_TASK_MAX_ATTEMPTS = 12;
const STRIPE_CANCELLATION_TASK_STALE_MS = 10 * 60 * 1000;
const STRIPE_SUBSCRIPTION_EVENT_LOCK_SECONDS = 30 * 60;
const CHECKOUT_RECOVERY_TTL_MS: Readonly<Record<'WECHAT' | 'ALIPAY' | 'STRIPE', number>> = {
  WECHAT: 2 * 60 * 60 * 1000,
  ALIPAY: 15 * 24 * 60 * 60 * 1000,
  STRIPE: 24 * 60 * 60 * 1000,
};

interface RefundOrderOptions {
  skipEntitlementCompensation?: boolean;
  skipRechargeBalanceCompensation?: boolean;
  stripeCancellationLeaseId?: string;
}

interface ChannelRefundResult {
  success: boolean;
  error?: string;
  refundId?: string;
  providerOutcome?: ProviderRefundOutcome;
  stripeSubscriptionRefund?: {
    subscriptionId: string;
    refundId: string;
    refundedInvoiceId: string;
    providerRefundSucceeded: boolean;
    refundStatus: string;
    cancellationPending: boolean;
    error?: string;
  };
}

type StripeRefundLedgerRecoveryCandidate = {
  source:
    | 'PROVIDER_REFUND_INTENT'
    | 'STRIPE_SUBSCRIPTION_CANCELLATION_TASK';
  sourceId: string;
  orderId: string;
  refundId: string;
  paymentProviderInstanceId: string | null;
};

const STRIPE_REFUND_LEDGER_SCAN_PAGE_SIZE = 200;

function normalizePlatformRegion(value: unknown): 'overseas' | 'domestic' | undefined {
  const normalized = String(value ?? '').trim().toLowerCase();
  if (normalized === 'domestic' || normalized === 'cn' || normalized === 'china') return 'domestic';
  if (normalized === 'overseas' || normalized === 'global' || normalized === 'intl') return 'overseas';
  return undefined;
}

function isWholeCurrencyAmountCents(amountCents: number): boolean {
  return Number.isInteger(amountCents) && amountCents > 0 && amountCents % 100 === 0;
}

function rechargeTierKey(orderId: string): string {
  return `recharge:tier:${orderId}`;
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

function orderIdempotencyFingerprint(input: {
  userId: string;
  tenantId: string;
  dto: CreateOrderInput;
}): string {
  const orderType = input.dto.orderType ?? OrderType.SUBSCRIPTION;
  const normalizedRequest = orderType === OrderType.SUBSCRIPTION
    ? {
        ...input.dto,
        billingPeriod: input.dto.billingPeriod ?? 'monthly',
      }
    : input.dto;
  return hashOrderIdempotencyFingerprint({
    userId: input.userId,
    tenantId: input.tenantId,
    request: normalizedRequest,
  });
}

function legacyOrderIdempotencyFingerprint(input: {
  userId: string;
  tenantId: string;
  dto: CreateOrderInput;
}): string {
  return hashOrderIdempotencyFingerprint({
    userId: input.userId,
    tenantId: input.tenantId,
    request: input.dto,
  });
}

function hashOrderIdempotencyFingerprint(input: {
  userId: string;
  tenantId: string;
  request: CreateOrderInput;
}): string {
  const payload = {
    version: 1,
    userId: input.userId,
    tenantId: input.tenantId,
    request: canonicalizeForFingerprint(input.request),
  };
  return createHash('sha256')
    .update(JSON.stringify(payload))
    .digest('hex');
}

type BundleOrderItemDraft = {
  bundleSkuId: string;
  bundleSkuItemId: string;
  productId: string;
  planId: string | null;
  boosterPackId: string | null;
  billingType: BundleItemBillingType;
  name: string;
  amountCents: number;
  originalAmountCents: number | null;
  discountAmountCents: number | null;
  currency: string;
  quantity: number;
  recurringInterval: 'month' | 'year' | null;
  validityDays: number | null;
};

type CheckoutRecoveryContext = {
  version: 1;
  channel: 'WECHAT' | 'ALIPAY' | 'STRIPE';
  description: string;
  alipayReturnUrl?: string;
  stripe?: {
    mode: 'payment' | 'subscription' | 'mixed_subscription';
    successUrl: string;
    cancelUrl: string;
    customerEmail: string;
    originalAmountCents: number;
    couponId: string | null;
    generatedCoupon: {
      amountOffCents: number;
      metadata: Record<string, string>;
    } | null;
    interval?: 'month' | 'year';
    intervalCount?: number;
    bundleItems?: BundleOrderItemDraft[];
  };
};

type CheckoutProviderResult = {
  settled?: false;
  payUrl: string;
  tradeNo?: string | null;
} | {
  settled: true;
};

type PurchaseVerificationSubject = {
  userId: string;
  tenantId: string;
  customerEmail?: string | null;
};

type RefundOrderRecord = Prisma.OrderGetPayload<{
  include: {
    plan: true;
    boosterPack: true;
    items: {
      include: { plan: true; boosterPack: true };
    };
  };
}>;

type ProrationAdjustment = {
  creditCents: number;
  sourcePlanId: string;
  /** 自营换档：定价所依据的源 entitlement id（履约时锚定同一性）。通用订阅抵扣为 null。 */
  sourceEntitlementId?: string | null;
  remainingCredits: number;
  monthlyCredits: number;
};

type PaymentOrderCreateInput = Parameters<PaymentRepository['createOrder']>[0];

type BundleLimitPolicy = {
  bundleSkuId: string;
  userId: string;
  maxUsesPerUser: number;
  maxUsesTotal: number;
};

type FulfillablePlan = {
  id: string;
  productId: string | null;
  name: string;
  monthlyCredits: number;
  features: string | null;
  product?: {
    billingMode: ProductBillingMode;
    codingPlanFulfillmentMode?: CodingPlanFulfillmentMode | null;
  } | null;
};

class BundleFulfillmentError extends Error {
  constructor(
    message: string,
    readonly hasFulfilledItems: boolean,
    readonly originalError: unknown,
  ) {
    super(message);
    this.name = 'BundleFulfillmentError';
  }
}

class RechargeWalletEffectsDetectedError extends ConflictException {
  constructor() {
    super('充值订单已产生余额效果，不能跳过余额退款补偿');
  }
}

const BUNDLE_FULFILLMENT_SKIP_ITEM_STATUSES = new Set<OrderItemStatus>([
  OrderItemStatus.FULFILLED,
  OrderItemStatus.COMPENSATING,
  OrderItemStatus.COMPENSATED,
  OrderItemStatus.COMPENSATION_FAILED,
  OrderItemStatus.REFUNDED,
]);

const DISCOUNT_RESERVED_ORDER_STATUSES = [
  OrderStatus.PENDING,
  OrderStatus.PAID,
  OrderStatus.FULFILLING,
];

const BUNDLE_RESERVED_ORDER_STATUSES = [
  OrderStatus.PENDING,
  OrderStatus.PAID,
  OrderStatus.FULFILLING,
  OrderStatus.PARTIALLY_FULFILLED_REQUIRES_COMPENSATION,
  OrderStatus.COMPLETED,
];

// 自营限量售卖「在途订单」口径：已下单未终结（未失败/取消/退款）即占用一份名额。
const SALES_CAP_RESERVED_ORDER_STATUSES = [
  OrderStatus.PENDING,
  OrderStatus.PAID,
  OrderStatus.FULFILLING,
];

const ORDER_STATUS_TRANSITIONS: Record<OrderStatus, ReadonlySet<OrderStatus>> = {
  [OrderStatus.PENDING]: new Set([
    OrderStatus.PAID,
    OrderStatus.EXPIRED,
    OrderStatus.CANCELLED,
    OrderStatus.FAILED,
  ]),
  [OrderStatus.EXPIRED]: new Set([OrderStatus.CANCELLED, OrderStatus.FAILED]),
  [OrderStatus.PAID]: new Set([
    OrderStatus.FULFILLING,
    OrderStatus.COMPLETED,
    OrderStatus.REFUNDING,
    OrderStatus.FAILED,
  ]),
  [OrderStatus.FULFILLING]: new Set([
    OrderStatus.COMPLETED,
    OrderStatus.PARTIALLY_FULFILLED_REQUIRES_COMPENSATION,
    OrderStatus.FAILED,
    OrderStatus.REFUNDING,
    OrderStatus.REFUNDED,
  ]),
  [OrderStatus.PARTIALLY_FULFILLED_REQUIRES_COMPENSATION]: new Set([
    OrderStatus.REFUNDING,
  ]),
  [OrderStatus.COMPLETED]: new Set([OrderStatus.REFUNDING, OrderStatus.REFUNDED]),
  [OrderStatus.FAILED]: new Set([OrderStatus.PAID]),
  [OrderStatus.REFUNDING]: new Set([
    OrderStatus.REFUNDED,
    OrderStatus.REFUND_FAILED,
    OrderStatus.REFUND_COMPENSATION_FAILED,
    OrderStatus.FAILED,
  ]),
  [OrderStatus.REFUND_FAILED]: new Set([OrderStatus.REFUNDING]),
  [OrderStatus.REFUND_COMPENSATION_FAILED]: new Set([OrderStatus.REFUNDED]),
  [OrderStatus.REFUNDED]: new Set([]),
  [OrderStatus.CANCELLED]: new Set([]),
};

const BILLING_PERIOD_CONFIG: Record<BillingPeriod, {
  multiplier: number;
  stripeInterval: 'month' | 'year';
  stripeIntervalCount: number;
  label: string;
  missingPriceLabel: string;
}> = {
  monthly: {
    multiplier: 1,
    stripeInterval: 'month',
    stripeIntervalCount: 1,
    label: '',
    missingPriceLabel: '月付',
  },
  quarterly: {
    multiplier: 3,
    stripeInterval: 'month',
    stripeIntervalCount: 3,
    label: ' (季付)',
    missingPriceLabel: '季付',
  },
  yearly: {
    multiplier: 12,
    stripeInterval: 'year',
    stripeIntervalCount: 1,
    label: ' (年付)',
    missingPriceLabel: '年付',
  },
};

@Injectable()
export class PaymentService {
  private readonly logger = new Logger(PaymentService.name);

  constructor(
    private readonly paymentRepository: PaymentRepository,
    private readonly billingService: BillingService,
    private readonly boosterPackService: BoosterPackService,
    private readonly creditService: CreditService,
    private readonly systemConfigService: SystemConfigService,
    private readonly wechatPayService: WechatPayService,
    private readonly alipayService: AlipayService,
    private readonly stripeService: StripeService,
    private readonly subscriptionResolver: SubscriptionResolverService,
    @Inject(ProductSyncNotifier)
    private readonly productSync: ProductSyncNotifier,
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
    private readonly config: ConfigService,
    private readonly campaignService: CampaignService,
    private readonly discountCodeService: DiscountCodeService,
    private readonly refundCompensation: RefundCompensationService,
    private readonly providerRefundSaga: ProviderRefundSagaService,
    private readonly userPurchaseVerification: UserPurchaseVerificationClient,
    // P2-A2: 可选 inject — 现有大量 unit test 通过 Test.createTestingModule
    // 直接构造 PaymentService(不 wire AlertEventsModule),@Optional 让它们继续过。
    @Optional() private readonly alertEvents?: AlertEventService,
    // P2-D: 邀请裂变触发回调(FIRST_RECHARGE / FIRST_SUBSCRIBE 条件依赖订单完成)。
    // @Optional 同样保护既有测试,onOrderCompleted 是 fire-and-forget。
    @Optional() private readonly referrals?: ReferralsService,
    @Optional() private readonly paymentProviderRegistry?: PaymentProviderRegistry,
    @Optional() private readonly codingPlanFulfillment?: CodingPlanFulfillmentService,
    @Optional() private readonly subscriptionLifecycle?: SubscriptionLifecycleService,
    @Optional() private readonly growthEvents?: GrowthEventsService,
  ) {}

  private async cancelActiveSubscriptions(input: {
    tenantId: string;
    productId?: string;
    planId?: string;
    reason: string;
  }): Promise<void> {
    if (!this.subscriptionLifecycle) {
      throw new Error('SubscriptionLifecycleService is required for subscription cancellation');
    }
    await this.subscriptionLifecycle.closeActive({
      tenantId: input.tenantId,
      productId: input.productId,
      planId: input.planId,
      status: 'CANCELLED',
      endedAt: new Date(),
      terminationReason: input.reason,
    });
  }

  private async platformCurrency(): Promise<string> {
    const platformConfig = await this.systemConfigService.getDeploymentConfig();
    return resolvePlatformCurrency(this.config, platformConfig).currency;
  }

  private async isDomesticDeployment(): Promise<boolean> {
    const platformConfig = await this.systemConfigService.getDeploymentConfig();
    const region = normalizePlatformRegion(platformConfig?.region ?? this.config.get<string>('PLATFORM_REGION'));
    return region === 'domestic';
  }

  async verifyStripeWebhook(payload: string | Buffer, signature: string): Promise<{
    event: any;
    verifiedPaymentProviderInstanceIds: string[];
  }> {
    const candidates = await this.getStripeWebhookCredentialCandidates();
    let lastError: unknown;

    for (const candidate of candidates) {
      try {
        return {
          event: this.stripeService.verifyWebhook(
            payload,
            signature,
            candidate.credentials,
          ),
          verifiedPaymentProviderInstanceIds: candidate.instanceIds,
        };
      } catch (err) {
        lastError = err;
      }
    }

    try {
      return {
        event: this.stripeService.verifyWebhook(payload, signature),
        // Environment credentials are intentionally the identity for legacy
        // orders that have no provider-instance binding.
        verifiedPaymentProviderInstanceIds: [],
      };
    } catch (err) {
      if (!(err instanceof ServiceUnavailableException) || !lastError) {
        lastError = err;
      }
    }

    throw lastError instanceof Error ? lastError : new BadRequestException('Stripe webhook 验签失败');
  }

  async verifyAlipayNotify(params: Record<string, string>): Promise<{
    valid: boolean;
    verifiedPaymentProviderInstanceIds?: string[];
  }> {
    const candidates = await this.getAlipayNotifyCredentialCandidates(params.app_id);
    let triedAdminCredentials = false;

    for (const candidate of candidates) {
      triedAdminCredentials = true;
      if (this.alipayService.verifyNotifySign(params, candidate.credentials)) {
        return {
          valid: true,
          verifiedPaymentProviderInstanceIds: candidate.instanceIds,
        };
      }
    }

    try {
      return { valid: this.alipayService.verifyNotifySign(params) };
    } catch (err) {
      if (triedAdminCredentials) {
        return { valid: false };
      }
      throw err;
    }
  }

  async createOrder(
    userId: string,
    dto: CreateOrderInput,
    tenantId?: string | null,
    productIntegrationContext?: ProductIntegrationContext,
    purchaseVerificationSubject?: PurchaseVerificationSubject,
  ): Promise<CreateOrderResponse> {
    const orderType = (dto.orderType ?? 'SUBSCRIPTION') as string;
    if (!['SUBSCRIPTION', 'BOOSTER_PACK', 'BUNDLE', 'RECHARGE'].includes(orderType)) {
      throw new BadRequestException('不支持的订单类型');
    }

    if (dto.orderType === 'BUNDLE' && dto.channel !== 'STRIPE') {
      throw new BadRequestException('组合套餐暂只支持 Stripe 支付');
    }

    if (dto.channel === 'BALANCE' && (orderType === 'SUBSCRIPTION' || orderType === 'BOOSTER_PACK')) {
      throw new BadRequestException('套餐和加油包不支持余额支付，请使用微信、支付宝或 Stripe');
    }
    if (dto.channel === 'BALANCE' && orderType === 'RECHARGE') {
      throw new BadRequestException('余额充值不支持余额支付');
    }
    if (dto.channel === 'BALANCE') {
      throw new BadRequestException('余额支付暂不支持下单，请使用微信、支付宝或 Stripe');
    }

    // Product-scoped durable replay is resolved before reading the current
    // catalog or callback policy. A provider checkout that already exists must
    // remain recoverable if the target is later disabled/deleted or a product
    // callback allowlist is tightened.
    const durableReplay = await this.tryReplayExistingPartnerCheckout(
      userId,
      dto,
      tenantId,
      productIntegrationContext,
    );
    if (durableReplay) {
      return durableReplay;
    }

    // finding：自营 CodingPlan(platform_model_package) 下单/升级 per-user——先解析到个人 tenant、绕开当前工作区
    // requireBillingRole gate（根因：原首个 resolveSubjectForUser 在自营改归属 :400/:612 之前就按当前工作区抛
    // 403「无权访问该团队账务」）。个人 tenant 用户为 owner 恒过 requireBillingRole，不降鉴权。
    // 转售 CODING_PLAN / 普通 SUBSCRIPTION：selfOpTenantId=null → 维持当前工作区口径不变。
    const selfOpTenantId =
      (dto.orderType ?? 'SUBSCRIPTION') === 'SUBSCRIPTION' && dto.planId
        ? await this.resolveSelfOpOrderTenantId(userId, dto.planId)
        : null;
    let subject = await this.billingService.resolveSubjectForUser(userId, selfOpTenantId ?? tenantId, {
      requireBillingRole: true,
      requireExplicitTenant: !selfOpTenantId,
    });
    let orderTenantId = this.requireTenantId(subject);
    let billingAccountId = subject.billingAccountId;

    let codingPlanTenantId: string | null = null;
    if (orderType === 'SUBSCRIPTION' && dto.planId) {
      codingPlanTenantId = await this.resolveCodingPlanOrderTenantId(userId, dto.planId);
      if (codingPlanTenantId && codingPlanTenantId !== orderTenantId) {
        subject = await this.billingService.resolveSubjectForUser(userId, codingPlanTenantId, {
          requireBillingRole: true,
        });
        orderTenantId = this.requireTenantId(subject);
        billingAccountId = subject.billingAccountId;
      }
    }

    const normalizedBillingAccountId = billingAccountId?.trim();
    if (!normalizedBillingAccountId) {
      throw new ConflictException('订单缺少明确账务账户，已停止创建');
    }
    billingAccountId = normalizedBillingAccountId;

    // 单币种部署：订单币种只能等于 deploymentConfig 中的平台币种。
    // 在幂等查询之前校验，避免历史订单让非平台币种请求绕过当前边界。
    const platformCurrency = await this.platformCurrency();
    const requestedCurrency = dto.currency ? normalizeCurrencyCode(dto.currency) : platformCurrency;
    if (dto.currency && requestedCurrency !== platformCurrency) {
      throw new BadRequestException(`当前部署仅支持 ${platformCurrency.toUpperCase()} 订单`);
    }
    const currency = platformCurrency;
    if ((dto.channel === 'WECHAT' || dto.channel === 'ALIPAY') && currency !== 'cny') {
      throw new BadRequestException('微信/支付宝仅支持 CNY 订单');
    }

    const idempotencyFingerprint = dto.idempotencyKey
      ? orderIdempotencyFingerprint({ userId, tenantId: orderTenantId, dto })
      : null;
    // Keep the raw caller key for old-binary rollback compatibility. Partner
    // isolation is enforced by a separate product-scoped hash column.
    const storedIdempotencyKey = dto.idempotencyKey ?? null;
    const partnerIdempotencyKey =
      dto.idempotencyKey && productIntegrationContext?.id
        ? this.storageIdempotencyKey(dto.idempotencyKey, productIntegrationContext.id)
        : null;
    if (dto.idempotencyKey) {
      let existing = await this.prisma.order.findFirst({
        where: {
          ...(partnerIdempotencyKey
            ? { partnerIdempotencyKey }
            : { idempotencyKey: storedIdempotencyKey }),
          userId,
          tenantId: orderTenantId,
        },
      });
      if (
        !existing &&
        productIntegrationContext?.id &&
        partnerIdempotencyKey
      ) {
        const legacy = await this.paymentRepository.findLegacyIdempotentOrder(
          dto.idempotencyKey,
          userId,
          orderTenantId,
          productIntegrationContext.id,
        );
        if (legacy) {
          if (legacy.billingAccountId !== billingAccountId) {
            throw new ConflictException('幂等订单账务账户与当前主体不一致');
          }
          const legacyFingerprint = legacyOrderIdempotencyFingerprint({
            userId,
            tenantId: orderTenantId,
            dto,
          });
          if (
            legacy.idempotencyFingerprint !== idempotencyFingerprint &&
            legacy.idempotencyFingerprint !== legacyFingerprint
          ) {
            throw new ConflictException('Idempotency-Key 与请求内容不匹配');
          }

          let migrated = false;
          try {
            migrated = await this.paymentRepository.migrateLegacyIdempotencyKey(
              legacy.id,
              dto.idempotencyKey,
              partnerIdempotencyKey,
              idempotencyFingerprint!,
            );
          } catch (err) {
            if (!hasPrismaErrorCode(err, 'P2002')) throw err;
          }
          if (migrated) {
            existing = {
              ...legacy,
              partnerIdempotencyKey,
              idempotencyFingerprint,
            };
          } else {
            existing = await this.prisma.order.findFirst({
              where: {
                partnerIdempotencyKey,
                userId,
                tenantId: orderTenantId,
              },
            });
            if (!existing) {
              throw new ConflictException(
                'Idempotency-Key 旧订单迁移发生并发冲突，请稍后用同一 Key 重试',
              );
            }
          }
        }
      }
      if (existing) {
        if (existing.billingAccountId !== billingAccountId) {
          throw new ConflictException('幂等订单账务账户与当前主体不一致');
        }
        if (existing.idempotencyFingerprint !== idempotencyFingerprint) {
          throw new ConflictException('Idempotency-Key 与请求内容不匹配');
        }
        return this.resumeOrReplayCheckout(existing);
      }
    }

    // Purchase eligibility gates new provider side effects. A matching durable
    // idempotency replay above must remain recoverable even if user-api is
    // temporarily unavailable or eligibility changes after the checkout was created.
    await this.assertCanCreatePurchaseOrder(
      purchaseVerificationSubject?.userId ?? userId,
      purchaseVerificationSubject?.tenantId ?? orderTenantId,
    );

    let amountCents: number;
    let bundleSkuId: string | null = null;
    let productId: string | null = null;
    let planId: string | null = null;
    let boosterPackId: string | null = null;
    let description: string;
    let bundleOrderItems: BundleOrderItemDraft[] = [];
    let bundleLimitPolicy: BundleLimitPolicy | null = null;
    // PR0-4: RECHARGE tier 命中（amountCents 与 productId 决定）。
    let rechargeTierMatch: { tierId: string; bonusCents: number } | null = null;

    const billingPeriod = dto.billingPeriod ?? 'monthly';
    const billingConfig = BILLING_PERIOD_CONFIG[billingPeriod];
    if (!billingConfig) {
      throw new BadRequestException('不支持的计费周期');
    }
    let originalAmountCents = 0;
    let discountAmountCents = 0;
    let prorationAdjustment: ProrationAdjustment | null = null;
    let requiresGeneratedStripeCoupon = false;
    // 目标套餐自营换档抵扣判定（在 SUBSCRIPTION 定价块内 plan 在作用域时赋值，供下方 proration 调用）。
    let targetIsSelfOpCodingPlan = false;
    let targetMonthlyCredits: number | null = null;
    let targetIsCodingPlan = false;
    let targetIsProviderResaleCodingPlan = false;
    // 自营限量售卖：目标套餐最大可售份数（null=不限量），供下方下单原子闸使用。
    let targetMaxSellableQuantity: number | null = null;

    if (orderType === 'RECHARGE') {
      // 充值订单：不查 plan，直接用 amountCents
      amountCents = dto.amountCents!;
      const callerProductId = (dto as { productId?: string }).productId;
      if (
        productIntegrationContext?.id
        && callerProductId
        && callerProductId !== productIntegrationContext.id
      ) {
        throw new NotFoundException('产品不存在');
      }
      const requestedProductId = productIntegrationContext?.id ?? callerProductId;
      const claimedTierId = (dto as { tierId?: string }).tierId;
      if (!(requestedProductId && claimedTierId) && !isWholeCurrencyAmountCents(amountCents)) {
        throw new BadRequestException('自定义充值金额必须为整数');
      }
      description = `余额充值 ${this.formatCurrencyAmount(currency, amountCents)}`;
      productId = await this.resolvePaygProductId(requestedProductId);
    } else if (orderType === 'BOOSTER_PACK') {
      // 加油包订单
      if (!dto.boosterPackId) {
        throw new BadRequestException('加油包订单需要 boosterPackId');
      }
      const boosterPack = await this.boosterPackService.findById(dto.boosterPackId);
      if (
        !boosterPack
        || !boosterPack.isActive
        || boosterPack.deletedAt
        || (
          productIntegrationContext?.id
          && boosterPack.productId !== productIntegrationContext.id
        )
      ) {
        throw new NotFoundException('加油包不存在');
      }
      // 检查用户是否有活跃订阅（加油包必须依附于订阅）
      if (boosterPack.productId) {
        const activeSub = await this.prisma.subscriptionPeriod.findFirst({
          where: {
            userId,
            tenantId: orderTenantId,
            productId: boosterPack.productId,
            status: 'ACTIVE',
            OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
          },
          orderBy: [{ startedAt: 'desc' }, { createdAt: 'desc' }],
        });
        if (!activeSub) {
          throw new BadRequestException('请先订阅套餐后再购买加油包');
        }
      }
      amountCents = boosterPack.priceCents;
      productId = boosterPack.productId ?? null;
      boosterPackId = boosterPack.id;
      description = `购买加油包: ${boosterPack.name}`;
    } else if (orderType === 'BUNDLE') {
      if (!dto.bundleSkuId) {
        throw new NotFoundException('组合套餐不存在');
      }
      const bundle = await this.paymentRepository.findBundleSkuForCheckout(dto.bundleSkuId);
      if (!bundle || !bundle.isActive) {
        throw new NotFoundException('组合套餐不存在');
      }
      if (
        productIntegrationContext?.id
        && (
          !bundle.items?.length
          || bundle.items.some((item) => item.productId !== productIntegrationContext.id)
        )
      ) {
        throw new NotFoundException('组合套餐不存在');
      }
      const now = new Date();
      if ((bundle.startAt && bundle.startAt > now) || (bundle.endAt && bundle.endAt < now)) {
        throw new BadRequestException('组合套餐不在活动时间内');
      }
      if (bundle.currency.toLowerCase() !== currency) {
        throw new BadRequestException(`组合套餐仅支持 ${bundle.currency.toUpperCase()} 支付`);
      }
      if (!bundle.items || bundle.items.length === 0) {
        throw new BadRequestException('组合套餐配置异常：缺少商品明细');
      }
      const planItemCountByProduct = new Map<string, number>();
      for (const item of bundle.items) {
        if (!item.product.isActive) {
          throw new BadRequestException('组合套餐配置异常：商品所属产品未启用');
        }
        if (item.product.billingMode === ProductBillingMode.CODING_PLAN) {
          throw new BadRequestException(
            '组合套餐暂不支持 Coding Plan 权益；该类权益缺少可逆履约协议',
          );
        }
        if (item.quantity !== 1) {
          throw new BadRequestException(
            '组合套餐权益项 quantity 必须为 1；当前履约协议不支持批量权益',
          );
        }
        if (item.planId) {
          const nextCount = (planItemCountByProduct.get(item.productId) ?? 0) + 1;
          planItemCountByProduct.set(item.productId, nextCount);
          if (nextCount > 1) {
            throw new BadRequestException('组合套餐同一产品最多只能包含一个套餐权益');
          }
        }
      }
      for (const item of bundle.items) {
        if (
          item.boosterPackId
          && (planItemCountByProduct.get(item.productId) ?? 0) !== 1
        ) {
          throw new BadRequestException(
            '组合套餐加油包必须绑定同一产品内唯一的套餐权益',
          );
        }
      }
      const bundlePlanProductIds = Array.from(planItemCountByProduct.keys());
      if (bundlePlanProductIds.length > 0) {
        const existingBundleScope = await this.prisma.subscriptionPeriod.findFirst({
          where: {
            userId,
            tenantId: orderTenantId,
            productId: { in: bundlePlanProductIds },
            status: 'ACTIVE',
            OR: [{ expiresAt: null }, { expiresAt: { gt: now } }],
          },
          select: { id: true },
        });
        if (existingBundleScope) {
          throw new BadRequestException(
            '组合套餐仅支持首次开通；已有产品权益不能通过组合套餐续期或换档',
          );
        }
      }

      bundleOrderItems = bundle.items.map((item) => {
        const quantity = item.quantity > 0 ? item.quantity : 1;
        if (item.billingType === BundleItemBillingType.SUBSCRIPTION) {
          if (!item.planId || !item.plan || !item.plan.isActive) {
            throw new BadRequestException('组合套餐配置异常：订阅项套餐不存在或未启用');
          }
          if (item.recurringInterval !== 'month' && item.recurringInterval !== 'year') {
            throw new BadRequestException('组合套餐配置异常：订阅项缺少续费周期');
          }
        } else if (item.billingType === BundleItemBillingType.ONE_TIME) {
          if (item.planId && (!item.plan || !item.plan.isActive)) {
            throw new BadRequestException('组合套餐配置异常：一次性套餐不存在或未启用');
          }
          if (item.boosterPackId && (!item.boosterPack || !item.boosterPack.isActive)) {
            throw new BadRequestException('组合套餐配置异常：一次性加油包不存在或未启用');
          }
          if (!item.planId && !item.boosterPackId) {
            throw new BadRequestException('组合套餐配置异常：一次性项缺少权益目标');
          }
        }

        const name = item.name || item.plan?.name || item.boosterPack?.name || item.product.name;
        const amount = item.unitAmountCents * quantity;
        const originalAmount = (item.originalUnitAmountCents ?? item.unitAmountCents) * quantity;
        return {
          bundleSkuId: bundle.id,
          bundleSkuItemId: item.id,
          productId: item.productId,
          planId: item.planId ?? null,
          boosterPackId: item.boosterPackId ?? null,
          billingType: item.billingType,
          name,
          amountCents: amount,
          originalAmountCents: originalAmount,
          discountAmountCents: originalAmount > amount ? originalAmount - amount : null,
          currency,
          quantity,
          recurringInterval: item.recurringInterval as 'month' | 'year' | null,
          validityDays: item.validityDays ?? null,
        };
      });
      const hasRecurring = bundleOrderItems.some((item) => item.billingType === BundleItemBillingType.SUBSCRIPTION);
      const hasOneTime = bundleOrderItems.some((item) => item.billingType === BundleItemBillingType.ONE_TIME);
      if (!hasRecurring || !hasOneTime) {
        throw new BadRequestException('组合套餐必须同时包含可续费项和一次性权益项');
      }

      amountCents = bundleOrderItems.reduce((sum, item) => sum + item.amountCents, 0);
      const itemOriginalTotal = bundleOrderItems.reduce(
        (sum, item) => sum + (item.originalAmountCents ?? item.amountCents),
        0,
      );
      if (amountCents !== bundle.amountCents) {
        throw new BadRequestException('组合套餐配置异常：明细金额与套餐金额不一致');
      }
      bundleSkuId = bundle.id;
      bundleLimitPolicy = {
        bundleSkuId: bundle.id,
        userId,
        maxUsesPerUser: bundle.maxUsesPerUser,
        maxUsesTotal: bundle.maxUsesTotal,
      };
      originalAmountCents = bundle.originalAmountCents ?? itemOriginalTotal;
      discountAmountCents = Math.max(0, originalAmountCents - amountCents);
      description = `购买组合套餐: ${bundle.name}`;
    } else {
      // 套餐订单（SUBSCRIPTION）
      if (!dto.planId) {
        throw new NotFoundException('套餐不存在');
      }
      const found = await this.paymentRepository.findPlanWithPrice(dto.planId, currency);
      if (
        !found
        || !found.plan.isActive
        || (
          productIntegrationContext?.id
          && found.plan.productId !== productIntegrationContext.id
        )
      ) {
        throw new NotFoundException('套餐不存在');
      }
      const plan = found.plan;
      if (plan.product && plan.product.billingMode === 'PAY_AS_YOU_GO') {
        throw new BadRequestException('PAYG 产品不支持订阅套餐订单，请使用充值或按量计费');
      }
      if (plan.product && !plan.product.isActive) {
        throw new BadRequestException('套餐所属产品未启用');
      }
      if (plan.product?.billingMode === ProductBillingMode.CODING_PLAN) {
        const personalTenantId = await this.billingService.resolvePersonalTenantIdForUser(userId);
        if (!codingPlanTenantId || personalTenantId !== orderTenantId) {
          throw new ConflictException('套餐账务类型在下单过程中发生变化，请重试');
        }
      } else if (codingPlanTenantId) {
        throw new ConflictException('套餐账务类型在下单过程中发生变化，请重试');
      }

      // 价格选择策略（plan_prices→Plan 顶层回退，quarterly/yearly 为月均价）：抽到 plan-pricing.util，
      // 与展示侧 /billing/plans/promotions 同源，避免展示与下单原价漂移。
      const monthlyEquivalent = resolvePlanPeriodMonthlyEquivalentCents(
        billingPeriod,
        found.price,
        plan,
        currency,
        await this.platformCurrency(),
      );
      if (monthlyEquivalent == null || monthlyEquivalent <= 0) {
        throw new NotFoundException(`套餐 ${plan.name} 暂无 ${currency.toUpperCase()} ${billingConfig.missingPriceLabel}价格`);
      }
      const unitPriceCents = monthlyEquivalent;

      // 订阅订单：订单总金额 = 对应周期月均价 × 周期月数
      amountCents = unitPriceCents * billingConfig.multiplier;
      productId = plan.productId ?? null;
      planId = plan.id;
      description = `购买套餐: ${plan.name}${billingConfig.label}`;
      targetIsCodingPlan = plan.product?.billingMode === ProductBillingMode.CODING_PLAN;
      targetIsProviderResaleCodingPlan = targetIsCodingPlan && this.isProviderResalePlan(plan);
      targetIsSelfOpCodingPlan =
        targetIsCodingPlan && !targetIsProviderResaleCodingPlan;
      targetMonthlyCredits = plan.monthlyCredits ?? null;
      targetMaxSellableQuantity = plan.maxSellableQuantity ?? null;
    }

    if (
      dto.channel === 'STRIPE'
      && (
        orderType === 'BUNDLE'
        || (
          orderType === 'SUBSCRIPTION'
          && !targetIsCodingPlan
        )
      )
    ) {
      throw new ServiceUnavailableException(
        'Stripe 自动续费订阅暂不可用；账期顺序与权益游标升级完成前不会创建 recurring Checkout',
      );
    }

    // ============================
    // 折扣活动 + 促销码解析（仅 SUBSCRIPTION 走）
    // 算法：最终价 = min(原价, 命中活动价, 原价-码折扣)
    // 选中谁：tie-break 优先 Campaign
    // ============================
    let appliedCampaignId: string | null = null;
    let appliedDiscountCodeId: string | null = null;
    let appliedStripeCouponId: string | null = null;
    if (originalAmountCents <= 0) {
      originalAmountCents = amountCents;
    }

    if (orderType === 'SUBSCRIPTION' && planId) {
      // 查用户是否"新用户"（没有任何付费订阅历史）
      const priorSub = await this.prisma.subscriptionPeriod.findFirst({
        where: { userId, status: { in: ['ACTIVE', 'EXPIRED', 'CANCELLED'] } },
      });
      const isNewUser = !priorSub;
      // 查用户是否曾经订阅过这个 plan（firstTimeOnly 用）
      const priorSameplan = await this.prisma.subscriptionPeriod.findFirst({
        where: { userId, planId },
      });
      const userHasPlanHistory = !!priorSameplan;

      const candidatePrices: Array<{ amount: number; kind: 'A' | 'B' | 'C'; payload?: any }> = [
        { amount: originalAmountCents, kind: 'A' },
      ];

      const campaignHit = await this.campaignService.findBestActiveCampaign({
        planId,
        currency,
        billingPeriod,
        userId,
        originalAmountCents,
        isNewUser,
        userHasPlanHistory,
      });
      if (campaignHit) {
        candidatePrices.push({
          amount: campaignHit.campaignAmountCents,
          kind: 'B',
          payload: campaignHit,
        });
      }

      let codeHit: any = null;
      if (dto.promoCode && dto.promoCode.trim()) {
        codeHit = await this.discountCodeService.validateAndGet({
          code: dto.promoCode.trim(),
          userId,
          planId,
          currency,
          isNewUser,
          userHasPlanHistory,
          originalAmountCents,
        });
        candidatePrices.push({
          amount: codeHit.amountAfterCents,
          kind: 'C',
          payload: codeHit,
        });
      }

      // 选最便宜；tie-break 按 A < B < C 的顺序（A 是原价，B 是活动，C 是码）
      const kindRank = { A: 0, B: 1, C: 2 };
      candidatePrices.sort((x, y) => x.amount - y.amount || kindRank[x.kind] - kindRank[y.kind]);
      const winner = candidatePrices[0];

      if (winner.kind === 'B') {
        appliedCampaignId = winner.payload.campaign.id;
        appliedStripeCouponId = winner.payload.campaign.stripeCouponId;
        amountCents = winner.amount;
        discountAmountCents = originalAmountCents - amountCents;
        // 决策：Stripe coupon 必须存在。没 coupon 不能下单（避免价格漂移）。
        if (!appliedStripeCouponId && dto.channel === 'STRIPE') {
          throw new BadRequestException('活动配置异常（Stripe Coupon 缺失），请联系管理员');
        }
      } else if (winner.kind === 'C') {
        appliedDiscountCodeId = winner.payload.code.id;
        appliedStripeCouponId = winner.payload.code.stripeCouponId;
        amountCents = winner.amount;
        discountAmountCents = originalAmountCents - amountCents;
        if (!appliedStripeCouponId && dto.channel === 'STRIPE') {
          throw new BadRequestException('促销码配置异常（Stripe Coupon 缺失），请联系管理员');
        }
      }
      // kind === 'A' → 无折扣，原价

      prorationAdjustment = await this.calculateSubscriptionProration({
        userId,
        tenantId: orderTenantId,
        productId,
        targetPlanId: planId,
        targetBillingPeriod: billingPeriod,
        currency,
        maxCreditCents: amountCents,
        targetIsSelfOpCodingPlan,
        targetMonthlyCredits,
      });
      if (prorationAdjustment?.creditCents) {
        amountCents = Math.max(0, amountCents - prorationAdjustment.creditCents);
        discountAmountCents = Math.max(0, originalAmountCents - amountCents);
        requiresGeneratedStripeCoupon = dto.channel === 'STRIPE';
      }
    }

    // PR0-4: RECHARGE tier 解析。
    //
    // 行为：
    //   - 用户传 productId → 按 (productId, amountCents, isActive, 时间窗口) 匹配 active tier。
    //   - 命中 → 计算 bonusCents（FIXED: bonusValue; PERCENT: floor(amountCents*bonusValue/100)）。
    //   - 用户额外传 tierId → 强校验：必须与匹配出的 tier 一致，否则 400。
    //   - 不匹配（含时间窗口外）→ 静默 fallback 为无 bonus（spec §12 决策）。
    //
    // 不传 productId：行为与历史一致（无 tier，无 bonus）。
    if (orderType === 'RECHARGE' && (dto as { productId?: string }).productId) {
      const claimedTierId = (dto as { tierId?: string }).tierId;
      rechargeTierMatch = await this.resolveRechargeTier(
        productId!,
        amountCents,
        claimedTierId,
      );
    }

    // 国内部署不限制充值金额；海外部署保留 min/max/daily 保护。
    if (orderType === 'RECHARGE' && !(await this.isDomesticDeployment())) {
      const paymentConfig = await this.systemConfigService.get('paymentConfig') as Record<string, number> | undefined;
      const configuredMinCents = paymentConfig?.rechargeMinCents ?? DEFAULT_RECHARGE_MIN_CENTS;
      const configuredMaxCents = paymentConfig?.rechargeMaxCents ?? DEFAULT_RECHARGE_MAX_CENTS;
      const minCents = Math.max(DEFAULT_RECHARGE_MIN_CENTS, configuredMinCents > 0 ? configuredMinCents : DEFAULT_RECHARGE_MIN_CENTS);
      const maxCents = Math.min(DEFAULT_RECHARGE_MAX_CENTS, configuredMaxCents > 0 ? configuredMaxCents : DEFAULT_RECHARGE_MAX_CENTS);
      const userDailyLimit = paymentConfig?.userDailyLimitCents || 0;

      if (amountCents < minCents) {
        throw new BadRequestException(`最低充值金额 ${this.formatCurrencyAmount(currency, minCents)}`);
      }
      if (amountCents > maxCents) {
        throw new BadRequestException(`最高充值金额 ${this.formatCurrencyAmount(currency, maxCents)}`);
      }
      if (userDailyLimit > 0) {
        const todayStart = new Date();
        todayStart.setHours(0, 0, 0, 0);

        const todaySum = await this.prisma.order.aggregate({
          where: {
            userId,
            billingAccountId,
            orderType: PrismaOrderType.RECHARGE,
            ...(productId ? { productId } : {}),
            status: { in: [OrderStatus.PAID, OrderStatus.FULFILLING, OrderStatus.COMPLETED] },
            createdAt: { gte: todayStart },
          },
          _sum: { amountCents: true },
        });

        if ((todaySum._sum.amountCents || 0) + amountCents > userDailyLimit) {
          throw new BadRequestException(`已超出每日充值上限 ${this.formatCurrencyAmount(currency, userDailyLimit)}`);
        }
      }
    }

    const stripeCallbackUrls = dto.channel === 'STRIPE'
      ? this.resolveStripeCallbackUrls(
        dto,
        productIntegrationContext?.allowedPaymentCallbackOrigins,
      )
      : null;
    const alipayReturnUrl = dto.channel === 'ALIPAY'
      ? this.resolveAlipayReturnUrl(
        dto,
        productIntegrationContext?.allowedPaymentCallbackOrigins,
      )
      : undefined;
    const paymentType = this.resolvePaymentType(orderType, productId);
    const alipaySelection = dto.channel === 'ALIPAY'
      ? await this.selectAlipayProviderInstance(paymentType)
      : null;
    const stripeSelection = dto.channel === 'STRIPE'
      ? await this.selectStripeProviderInstance(paymentType)
      : null;
    const productCustomerEmail = purchaseVerificationSubject?.customerEmail?.trim() || null;
    const stripeUser = dto.channel === 'STRIPE' && !productCustomerEmail
      ? await this.prisma.user.findUnique({
          where: { id: userId },
          select: { email: true },
        })
      : null;
    const generatedCoupon = requiresGeneratedStripeCoupon && discountAmountCents > 0
      ? {
          amountOffCents: discountAmountCents,
          metadata: {
            userId,
            planId: planId ?? '',
            billingPeriod,
            prorationCreditCents: String(prorationAdjustment?.creditCents ?? 0),
            campaignId: appliedCampaignId ?? '',
            discountCodeId: appliedDiscountCodeId ?? '',
          },
        }
      : null;
    const checkoutRecoveryContext: CheckoutRecoveryContext = {
      version: 1,
      channel: dto.channel as 'WECHAT' | 'ALIPAY' | 'STRIPE',
      description,
      ...(alipayReturnUrl ? { alipayReturnUrl } : {}),
      ...(dto.channel === 'STRIPE'
        ? {
            stripe: {
              mode: orderType === 'BUNDLE'
                ? 'mixed_subscription'
                : orderType === 'SUBSCRIPTION' && !targetIsCodingPlan
                  ? 'subscription'
                  : 'payment',
              successUrl: stripeCallbackUrls!.successUrl,
              cancelUrl: stripeCallbackUrls!.cancelUrl,
              customerEmail: productCustomerEmail ?? stripeUser?.email ?? '',
              originalAmountCents,
              couponId: appliedStripeCouponId,
              generatedCoupon,
              ...(orderType === 'SUBSCRIPTION' && !targetIsCodingPlan
                ? {
                    interval: billingConfig.stripeInterval,
                    intervalCount: billingConfig.stripeIntervalCount,
                  }
                : {}),
              ...(orderType === 'BUNDLE'
                ? { bundleItems: bundleOrderItems }
                : {}),
            },
          }
        : {}),
    };
    const checkoutContextEncrypted = this.encryptCheckoutValue(
      JSON.stringify(checkoutRecoveryContext),
    );

    // 外部支付渠道（WECHAT / ALIPAY / STRIPE）
    const orderData: PaymentOrderCreateInput = {
      userId,
      tenantId: orderTenantId,
      billingAccountId,
      orderType: orderType as PrismaOrderType,
      bundleSkuId,
      productId,
      planId,
      boosterPackId,
      amountCents,
      currency,
      rechargeTierId: rechargeTierMatch?.tierId ?? null,
      bonusCents: rechargeTierMatch?.bonusCents ?? 0,
      channel: dto.channel as PayChannel,
      idempotencyKey: storedIdempotencyKey,
      partnerIdempotencyKey,
      idempotencyFingerprint,
      campaignId: appliedCampaignId,
      discountCodeId: appliedDiscountCodeId,
      originalAmountCents,
      discountAmountCents: discountAmountCents > 0 ? discountAmountCents : null,
      billingPeriod: orderType === 'SUBSCRIPTION' ? billingPeriod : null,
      prorationCreditCents: prorationAdjustment?.creditCents ?? null,
      prorationSourcePlanId: prorationAdjustment?.sourcePlanId ?? null,
      prorationSourceEntitlementId: prorationAdjustment?.sourceEntitlementId ?? null,
      prorationRemainingCredits: prorationAdjustment?.remainingCredits ?? null,
      prorationMonthlyCredits: prorationAdjustment?.monthlyCredits ?? null,
      paymentProviderInstanceId:
        alipaySelection?.instanceId ?? stripeSelection?.instanceId ?? null,
      checkoutContextEncrypted,
    };
    // 自营 CodingPlan 订单一律进 per-plan 锁事务（不依赖锁外 cap 快照）——锁内重读 cap 判定售罄，
    // 关闭「下单读到旧 null/大 cap、管理端并发改小 cap」的超卖窗口(codex P1)。cap 为空时锁内跳过。
    const salesCapPlanId = targetIsSelfOpCodingPlan && planId ? planId : null;
    void targetMaxSellableQuantity; // 锁外快照仅调试参考，判定以锁内重读为准
    let order: PrismaOrder;
    try {
      order = orderType === 'BUNDLE'
        ? await this.createBundleOrderRecord(orderData, bundleOrderItems, bundleLimitPolicy)
        : appliedDiscountCodeId || (targetIsProviderResaleCodingPlan && planId) || salesCapPlanId
          ? await this.createOrderWithPurchaseReservations(orderData, {
              discountCodeId: appliedDiscountCodeId,
              discountUserId: userId,
              resalePlanId: targetIsProviderResaleCodingPlan ? planId : null,
              selfOpSalesCapPlanId: salesCapPlanId,
            })
          : await this.paymentRepository.createOrder(orderData);
    } catch (err) {
      if (!dto.idempotencyKey || !hasPrismaErrorCode(err, 'P2002')) {
        throw err;
      }
      const concurrentOrder = await this.prisma.order.findFirst({
        where: {
          ...(partnerIdempotencyKey
            ? { partnerIdempotencyKey }
            : { idempotencyKey: storedIdempotencyKey }),
          userId,
          tenantId: orderTenantId,
        },
      });
      if (!concurrentOrder) {
        throw new ConflictException('Idempotency-Key 并发创建冲突，请查询订单状态后重试');
      }
      if (
        concurrentOrder.billingAccountId !== billingAccountId ||
        concurrentOrder.idempotencyFingerprint !== idempotencyFingerprint
      ) {
        throw new ConflictException('Idempotency-Key 与并发请求内容不匹配');
      }
      return this.resumeOrReplayCheckout(concurrentOrder);
    }
    // Prisma returns DB defaults and the encrypted context. Unit-test repositories and
    // older adapters may omit newly-added fields from their structural mocks; retain the
    // exact context just written so initialization still follows the durable path.
    if (!order.checkoutContextEncrypted) {
      order = {
        ...order,
        checkoutContextEncrypted,
        checkoutInitState: order.checkoutInitState ?? PaymentCheckoutInitState.NOT_STARTED,
        paymentProviderInstanceId:
          order.paymentProviderInstanceId ?? orderData.paymentProviderInstanceId ?? null,
      };
    }

    // PR0-4: 暂存 RechargeTier 上下文，履约（webhook 到账）时读取并补 bonus。
    await this.persistRechargeTierContext(order.id, rechargeTierMatch);

    return this.resumeOrReplayCheckout(order);
  }

  private async resumeOrReplayCheckout(order: PrismaOrder): Promise<CreateOrderResponse> {
    if (order.status === OrderStatus.FAILED) {
      throw new ConflictException(
        `该 Idempotency-Key 已绑定失败订单 ${order.id}；请先确认渠道侧未生成交易，再使用新的 Idempotency-Key 重新下单`,
      );
    }
    if (order.status !== OrderStatus.PENDING) {
      return { order: this.toOrder(order), payUrl: null };
    }

    const now = new Date();
    if (order.checkoutInitState === PaymentCheckoutInitState.READY) {
      if (!order.checkoutPayUrlEncrypted || !order.checkoutPayUrlExpiresAt) {
        throw new ServiceUnavailableException(`订单 ${order.id} 的支付链接恢复数据不完整`);
      }
      if (order.checkoutPayUrlExpiresAt.getTime() <= now.getTime()) {
        await this.expireCheckoutOrder(order.id, '支付链接恢复窗口已过期');
        const expired = await this.prisma.order.findUnique({ where: { id: order.id } });
        return {
          order: this.toOrder(expired ?? { ...order, status: OrderStatus.EXPIRED }),
          payUrl: null,
        };
      }
      return {
        order: this.toOrder(order),
        payUrl: this.decryptCheckoutValue(order.checkoutPayUrlEncrypted),
      };
    }

    if (
      order.checkoutInitState === PaymentCheckoutInitState.INITIALIZING &&
      order.checkoutLeaseExpiresAt &&
      order.checkoutLeaseExpiresAt.getTime() > now.getTime()
    ) {
      throw new ConflictException(
        `该 Idempotency-Key 已绑定订单 ${order.id}，支付渠道正在初始化，请稍后用同一 Idempotency-Key 重试`,
      );
    }
    const reconcileWechatOutcome =
      order.channel === PayChannel.WECHAT
      && (
        order.checkoutInitState === PaymentCheckoutInitState.OUTCOME_UNKNOWN
        || (
          order.checkoutInitState === PaymentCheckoutInitState.INITIALIZING
          && (
            !order.checkoutLeaseExpiresAt
            || order.checkoutLeaseExpiresAt.getTime() <= now.getTime()
          )
        )
      );
    if (!order.checkoutContextEncrypted) {
      throw new ConflictException(
        `该 Idempotency-Key 已绑定订单 ${order.id}，但没有可恢复的支付初始化数据；请查询订单状态`,
      );
    }

    const context = this.decryptCheckoutContext(order.checkoutContextEncrypted);
    if (context.channel !== order.channel) {
      throw new ServiceUnavailableException(`订单 ${order.id} 的支付恢复渠道不一致`);
    }
    const recoveryExpiresAt = this.checkoutRecoveryExpiresAt(order);
    if (recoveryExpiresAt.getTime() <= now.getTime()) {
      await this.expireCheckoutOrder(order.id, '支付初始化窗口已过期');
      const expired = await this.prisma.order.findUnique({ where: { id: order.id } });
      return {
        order: this.toOrder(expired ?? { ...order, status: OrderStatus.EXPIRED }),
        payUrl: null,
      };
    }

    const leaseId = randomUUID();
    const claimed = await this.paymentRepository.claimCheckoutInitialization(
      order.id,
      leaseId,
      now,
      new Date(now.getTime() + CHECKOUT_INITIALIZATION_LEASE_MS),
    );
    if (!claimed) {
      const latest = await this.prisma.order.findUnique({ where: { id: order.id } });
      if (!latest) {
        throw new ConflictException(`订单 ${order.id} 不存在`);
      }
      if (latest?.checkoutInitState === PaymentCheckoutInitState.READY || latest?.status !== OrderStatus.PENDING) {
        return this.resumeOrReplayCheckout(latest);
      }
      throw new ConflictException(
        `该 Idempotency-Key 已绑定订单 ${order.id}，支付渠道正在初始化，请稍后用同一 Idempotency-Key 重试`,
      );
    }

    let providerResult: CheckoutProviderResult | null = null;
    try {
      providerResult = await this.initializeCheckoutProvider(
        order,
        context,
        reconcileWechatOutcome,
      );
      if (providerResult.settled) {
        const settledOrder = await this.prisma.order.findUnique({
          where: { id: order.id },
        });
        if (!settledOrder || settledOrder.status === OrderStatus.PENDING) {
          throw new WechatPayOrderOutcomeUnknownError(
            `微信查单成功但本地订单未完成结算: order=${order.id}`,
          );
        }
        return {
          order: this.toOrder(settledOrder),
          payUrl: null,
        };
      }
      const checkoutPayUrlEncrypted = this.encryptCheckoutValue(providerResult.payUrl);
      const completed = await this.paymentRepository.completeCheckoutInitialization(
        order.id,
        leaseId,
        {
          checkoutPayUrlEncrypted,
          checkoutPayUrlExpiresAt: recoveryExpiresAt,
          tradeNo: providerResult.tradeNo ?? null,
          paymentProviderInstanceId: order.paymentProviderInstanceId,
        },
      );
      if (!completed) {
        const latest = await this.prisma.order.findUnique({ where: { id: order.id } });
        if (!latest) {
          throw new ConflictException(`订单 ${order.id} 不存在`);
        }
        if (latest?.checkoutInitState === PaymentCheckoutInitState.READY || latest?.status !== OrderStatus.PENDING) {
          return this.resumeOrReplayCheckout(latest);
        }
        throw new ServiceUnavailableException('支付渠道已初始化，但支付结果持久化竞争失败，请重试');
      }
      return {
        order: this.toOrder(completed),
        payUrl: providerResult.payUrl,
      };
    } catch (err) {
      const providerOutcomeUnknown =
        order.channel === PayChannel.STRIPE
        || err instanceof WechatPayOrderOutcomeUnknownError;
      const wechatOutcomeRequiresReconciliation =
        order.channel === PayChannel.WECHAT
        && (providerResult !== null || providerOutcomeUnknown);
      const releaseOrMarkPromise = wechatOutcomeRequiresReconciliation
        ? this.paymentRepository.markCheckoutOutcomeUnknown(order.id, leaseId)
        : this.paymentRepository.releaseCheckoutInitialization(order.id, leaseId);
      await releaseOrMarkPromise.catch((releaseErr) => {
        this.logger.error(
          `支付初始化状态释放失败: order=${order.id} reconcile=${wechatOutcomeRequiresReconciliation} error=${
            releaseErr instanceof Error ? releaseErr.message : String(releaseErr)
          }`,
        );
      });
      if (providerResult || providerOutcomeUnknown) {
        // 渠道已成功返回。此时绝不能把订单标记 FAILED；Stripe 可通过稳定
        // provider idempotency key 重新取得同一 Session。微信网络错误或
        // SYSTEM_ERROR 也可能已经落单，必须保留 PENDING 供同单号重试/查单，
        // 不能把“结果未知”误写为确定失败。
        this.logger.error(
          `支付渠道结果未确认，保留订单重试: order=${order.id} error=${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        throw new ServiceUnavailableException(
          `订单 ${order.id} 的支付渠道结果尚未确认，请使用同一 Idempotency-Key 重试`,
        );
      } else {
        if (err instanceof ServiceUnavailableException) {
          this.logger.warn(`支付渠道未配置 (${order.channel}): ${err.message}`);
        } else {
          this.logger.error(`支付下单失败: ${err}`);
        }
        await this.transitionOrderStatus(
          order.id,
          OrderStatus.FAILED,
          'system',
          err instanceof Error ? err.message : String(err),
        ).catch((transitionErr) => {
          this.logger.error(
            `支付初始化失败状态写入失败: order=${order.id} error=${
              transitionErr instanceof Error ? transitionErr.message : String(transitionErr)
            }`,
          );
        });
      }
      throw err;
    }
  }

  private async initializeCheckoutProvider(
    order: PrismaOrder,
    context: CheckoutRecoveryContext,
    reconcileWechatOutcome = false,
  ): Promise<CheckoutProviderResult> {
    if (context.channel === 'WECHAT') {
      if (reconcileWechatOutcome) {
        const queried = await this.wechatPayService.queryOrder(order.id);
        if (queried.trade_state === 'SUCCESS') {
          const transactionId = queried.transaction_id?.trim();
          const paidAmountCents = queried.amount?.total;
          const paidCurrency = queried.amount?.currency?.trim().toLowerCase();
          if (
            !transactionId
            || typeof paidAmountCents !== 'number'
            || !Number.isSafeInteger(paidAmountCents)
            || !paidCurrency
          ) {
            throw new WechatPayOrderOutcomeUnknownError(
              `微信查单成功但缺少交易号、金额或币种: order=${order.id}`,
            );
          }
          const handled = await this.handlePaymentCallback(
            transactionId,
            order.id,
            'WECHAT',
            {
              paidAmountCents,
              paidCurrency,
            },
          );
          if (!handled) {
            throw new WechatPayOrderOutcomeUnknownError(
              `微信查单成功但本地支付确认失败: order=${order.id}`,
            );
          }
          return { settled: true };
        }
        if (
          queried.trade_state !== 'NOTPAY'
          && queried.trade_state !== 'NOT_FOUND'
        ) {
          if (
            queried.trade_state === 'CLOSED'
            || queried.trade_state === 'REVOKED'
            || queried.trade_state === 'PAYERROR'
          ) {
            throw new Error(
              `微信订单已处于不可支付状态 ${queried.trade_state}: order=${order.id}`,
            );
          }
          throw new WechatPayOrderOutcomeUnknownError(
            `微信订单状态尚不能安全重建二维码 ${queried.trade_state}: order=${order.id}`,
          );
        }
      }
      const result = await this.wechatPayService.createNativePay(
        order.id,
        order.amountCents,
        context.description,
        this.checkoutRecoveryExpiresAt(order),
      );
      return { payUrl: result.codeUrl };
    }
    if (context.channel === 'ALIPAY') {
      const credentials = await this.resolveAlipayCredentialsForOrder(
        order.paymentProviderInstanceId,
      );
      const result = await this.alipayService.createPagePay(
        order.id,
        order.amountCents,
        context.description,
        credentials,
        context.alipayReturnUrl,
      );
      return { payUrl: result.url };
    }

    const stripe = context.stripe;
    if (!stripe) {
      throw new ServiceUnavailableException(`订单 ${order.id} 缺少 Stripe 恢复上下文`);
    }
    const credentials = await this.resolveStripeCredentialsForOrder(
      order.paymentProviderInstanceId,
    );
    const stripeCallOptions = credentials ? { credentials } : {};
    const stripeMetadata = this.buildStripePaymentMetadata({
      orderId: order.id,
      userId: order.userId,
      tenantId: order.tenantId,
      billingAccountId: order.billingAccountId,
      productId: order.productId,
      planId: order.planId,
      boosterPackId: order.boosterPackId,
      bundleSkuId: order.bundleSkuId,
      orderType: order.orderType,
      billingPeriod: order.billingPeriod,
    });
    if (
      stripe.mode === 'subscription'
      || stripe.mode === 'mixed_subscription'
    ) {
      throw new ServiceUnavailableException(
        `订单 ${order.id} 的 recurring Stripe Checkout 已暂停；禁止在无单调账期游标时创建自动续费`,
      );
    }
    let checkoutCouponId = stripe.couponId;
    if (stripe.generatedCoupon) {
      checkoutCouponId = await this.stripeService.createOneTimeAmountOffCoupon({
        name: `Proration ${order.id}`,
        amountOffCents: stripe.generatedCoupon.amountOffCents,
        currency: order.currency,
        metadata: {
          orderId: order.id,
          ...stripe.generatedCoupon.metadata,
        },
        idempotencyKey: `checkout:${order.id}:coupon`,
        ...stripeCallOptions,
      });
    }

    const useCoupon = Boolean(checkoutCouponId);
    const result = await this.stripeService.createCheckoutSession({
      orderId: order.id,
      amountCents: useCoupon ? stripe.originalAmountCents : order.amountCents,
      currency: order.currency,
      description: context.description,
      customerEmail: stripe.customerEmail,
      successUrl: stripe.successUrl,
      cancelUrl: stripe.cancelUrl,
      couponId: useCoupon ? checkoutCouponId : null,
      metadata: stripeMetadata,
      ...stripeCallOptions,
    });
    return { payUrl: result.url, tradeNo: result.sessionId };
  }

  private checkoutRecoveryExpiresAt(order: Pick<PrismaOrder, 'channel' | 'createdAt'>): Date {
    if (
      order.channel !== PayChannel.WECHAT &&
      order.channel !== PayChannel.ALIPAY &&
      order.channel !== PayChannel.STRIPE
    ) {
      throw new ServiceUnavailableException('订单支付渠道不支持链接恢复');
    }
    return new Date(order.createdAt.getTime() + CHECKOUT_RECOVERY_TTL_MS[order.channel]);
  }

  private async expireCheckoutOrder(orderId: string, detail: string): Promise<void> {
    try {
      await this.transitionOrderStatus(orderId, OrderStatus.EXPIRED, 'system', detail);
    } catch (err) {
      const latest = await this.prisma.order.findUnique({ where: { id: orderId } });
      if (latest && latest.status !== OrderStatus.PENDING) return;
      throw err;
    }
  }

  private encryptCheckoutValue(value: string): string {
    return encrypt(value, this.checkoutEncryptionKey());
  }

  private decryptCheckoutValue(value: string): string {
    try {
      return decrypt(value, this.checkoutEncryptionKey());
    } catch {
      throw new ServiceUnavailableException('支付链接恢复数据无法解密');
    }
  }

  private decryptCheckoutContext(value: string): CheckoutRecoveryContext {
    let parsed: unknown;
    try {
      parsed = JSON.parse(this.decryptCheckoutValue(value));
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      throw new ServiceUnavailableException('支付初始化恢复数据格式无效');
    }
    if (
      !parsed ||
      typeof parsed !== 'object' ||
      (parsed as { version?: unknown }).version !== 1 ||
      !['WECHAT', 'ALIPAY', 'STRIPE'].includes(
        String((parsed as { channel?: unknown }).channel ?? ''),
      ) ||
      typeof (parsed as { description?: unknown }).description !== 'string'
    ) {
      throw new ServiceUnavailableException('支付初始化恢复数据格式无效');
    }
    return parsed as CheckoutRecoveryContext;
  }

  private checkoutEncryptionKey(): string {
    const key = this.config.get<string>('ENCRYPTION_KEY')?.trim() ?? '';
    if (!/^[0-9a-fA-F]{64}$/.test(key)) {
      throw new ServiceUnavailableException(
        'ENCRYPTION_KEY 未配置或格式无效，不能安全保存支付恢复链接',
      );
    }
    return key;
  }

  private storageIdempotencyKey(idempotencyKey: string, partnerProductId?: string): string {
    if (!partnerProductId) return idempotencyKey;
    const digest = createHash('sha256').update(idempotencyKey).digest('hex');
    return `partner:${partnerProductId}:${digest}`;
  }

  /**
   * Recover a product-scoped checkout before consulting mutable catalog or
   * callback-policy state. Authorization and the immutable request fingerprint
   * are still revalidated; only the already-persisted provider side effect is
   * replayed.
   */
  private async tryReplayExistingPartnerCheckout(
    userId: string,
    dto: CreateOrderInput,
    tenantId: string | null | undefined,
    productIntegrationContext?: ProductIntegrationContext,
  ): Promise<CreateOrderResponse | null> {
    const callerKey = dto.idempotencyKey?.trim();
    const productId = productIntegrationContext?.id?.trim();
    if (!callerKey || !productId) return null;

    const existing = await this.paymentRepository.findPartnerIdempotentOrder(
      this.storageIdempotencyKey(callerKey, productId),
      userId,
      productId,
    );
    if (!existing) return null;

    const isSelfOp = await this.paymentRepository.isSelfOpCodingPlanOrderOwnedByUser(
      existing.id,
      userId,
    );
    let subject;
    if (isSelfOp) {
      const personalTenantId = await this.billingService.resolvePersonalTenantIdForUser(userId);
      if (personalTenantId !== existing.tenantId) {
        throw new ConflictException('幂等订单个人账务主体与当前用户不一致');
      }
      subject = await this.billingService.resolveSubjectForUser(userId, personalTenantId, {
        requireBillingRole: true,
      });
    } else {
      subject = await this.billingService.resolveSubjectForUser(userId, tenantId, {
        requireBillingRole: true,
        requireExplicitTenant: true,
      });
      if (subject.tenantId !== existing.tenantId) {
        throw new ConflictException('幂等订单工作区与当前请求不一致');
      }
    }

    const billingAccountId = subject.billingAccountId?.trim();
    if (!billingAccountId || existing.billingAccountId !== billingAccountId) {
      throw new ConflictException('幂等订单账务账户与当前主体不一致');
    }

    const normalizedFingerprint = orderIdempotencyFingerprint({
      userId,
      tenantId: existing.tenantId,
      dto,
    });
    const legacyFingerprint = legacyOrderIdempotencyFingerprint({
      userId,
      tenantId: existing.tenantId,
      dto,
    });
    if (
      existing.idempotencyFingerprint !== normalizedFingerprint
      && existing.idempotencyFingerprint !== legacyFingerprint
    ) {
      throw new ConflictException('Idempotency-Key 与请求内容不匹配');
    }

    return this.resumeOrReplayCheckout(existing);
  }

  private async assertCanCreatePurchaseOrder(userId: string, tenantId: string): Promise<void> {
    const normalizedUserId = userId?.trim();
    const normalizedTenantId = tenantId?.trim();
    if (!normalizedUserId || !normalizedTenantId) {
      throw new BadRequestException('支付资格校验必须提供明确的 userId 和 tenantId');
    }
    await this.userPurchaseVerification.assertCanPurchase(normalizedUserId, normalizedTenantId);
  }

  /** 轻量状态查询（前端轮询用） */
  async getOrderStatus(
    orderId: string,
    userId: string,
    tenantId?: string | null,
    productId?: string | null,
  ): Promise<{ status: SharedOrderStatus; paidAt: string | null; cancelReason: string | null }> {
    // finding：自营 CodingPlan 订单 per-user（实际落 personal tenant）。先按 (orderId, userId) 判自营，
    // 命中则按 userId 授权查、绕开当前工作区（否则非 personal 工作区轮询永远查不到 → 支付成功仍 timeout）。
    // 授权真源=order.userId（repo where 必含 userId）；非自营维持当前工作区 + requireBillingRole + productId 过滤。
    if (await this.paymentRepository.isSelfOpCodingPlanOrderOwnedByUser(orderId, userId)) {
      const selfOpOrder = await this.paymentRepository.findOrderStatusOwnedByUser(orderId, userId, productId);
      if (!selfOpOrder) {
        throw new NotFoundException('订单不存在');
      }
      return {
        status: selfOpOrder.status as SharedOrderStatus,
        paidAt: selfOpOrder.paidAt?.toISOString() ?? null,
        cancelReason: selfOpOrder.cancelReason ?? null,
      };
    }
    const subject = await this.billingService.resolveSubjectForUser(userId, tenantId, {
      requireBillingRole: true,
    });
    const order = await this.paymentRepository.findOrderStatusByIdAndUser(
      orderId,
      userId,
      subject.tenantId,
      productId,
    );
    if (!order) {
      throw new NotFoundException('订单不存在');
    }
    return {
      status: order.status as SharedOrderStatus,
      paidAt: order.paidAt?.toISOString() ?? null,
      cancelReason: order.cancelReason ?? null,
    };
  }

  async getOrder(
    orderId: string,
    userId: string,
    tenantId?: string | null,
    productId?: string | null,
  ): Promise<Order> {
    // finding：自营订单 per-user（同 getOrderStatus）。
    if (await this.paymentRepository.isSelfOpCodingPlanOrderOwnedByUser(orderId, userId)) {
      const selfOpOrder = await this.paymentRepository.findOrderOwnedByUser(orderId, userId, productId);
      if (!selfOpOrder) {
        throw new NotFoundException('订单不存在');
      }
      return this.toOrder(selfOpOrder);
    }
    const subject = await this.billingService.resolveSubjectForUser(userId, tenantId, {
      requireBillingRole: true,
    });
    const order = await this.paymentRepository.findOrderByIdAndUser(
      orderId,
      userId,
      subject.tenantId,
      productId,
    );
    if (!order) {
      throw new NotFoundException('订单不存在');
    }
    return this.toOrder(order);
  }

  private async calculateSubscriptionProration(params: {
    userId: string;
    tenantId?: string | null;
    productId: string | null;
    targetPlanId: string;
    targetBillingPeriod: BillingPeriod;
    currency: string;
    maxCreditCents: number;
    /** 目标套餐是否自营 CodingPlan（platform_model_package）——走 entitlement+实付 抵扣 + 禁降档。 */
    targetIsSelfOpCodingPlan?: boolean;
    /** 目标套餐月度积分（用于自营降档判定）。 */
    targetMonthlyCredits?: number | null;
  }): Promise<ProrationAdjustment | null> {
    // 注意：maxCreditCents<=0（如 0 元订单）不在此早退——否则会绕过下方自营降档禁令；
    // 抵扣额计算各分支内单独再判 maxCreditCents<=0。
    if (!params.productId) return null;
    const tenantId = this.requireTenantId({ tenantId: params.tenantId });

    // 自营 CodingPlan 换档抵扣：单一活跃下找当前 ACTIVE 自营 entitlement，估值 = 旧套餐剩余「持有价值」。
    // 持有价值按 order **分段计值**（原始/切换单 + 各续订单各成服务块，各自单月价），当前月按未用占比折算、
    // 未来整月全额、过去月不计；禁止降档；超额（剩余价值 > 目标本单价）拒单（防价值蒸发/不支付换）。
    if (params.targetIsSelfOpCodingPlan) {
      const activeSelf = await this.prisma.codingPlanEntitlement.findFirst({
        where: {
          tenantId,
          productId: params.productId,
          fulfillmentMode: CodingPlanFulfillmentMode.platform_model_package,
          status: 'ACTIVE',
          OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
        },
        orderBy: [{ createdAt: 'desc' }],
      });
      if (!activeSelf) return null; // 首购，无可抵扣
      if (activeSelf.planId === params.targetPlanId) return null; // 同档续订，不走换档抵扣
      const oldPlan = await this.prisma.plan.findUnique({
        where: { id: activeSelf.planId },
        select: { monthlyCredits: true, validityDays: true },
      });
      const oldMonthly = oldPlan?.monthlyCredits ?? 0;
      // 禁止降档：目标档月度积分 < 当前档 → 拒单（剩余抵扣额可能 > 低档价，超出丢弃会让剩余价值凭空消失）。
      if (
        params.targetMonthlyCredits != null &&
        oldMonthly > 0 &&
        params.targetMonthlyCredits < oldMonthly
      ) {
        throw new BadRequestException(
          '自营套餐不支持降档；请用完当前套餐后下月再购买低档，或通过退套餐退款流程处理。',
        );
      }
      if (oldMonthly <= 0) return null;
      // 注意：此处不因 maxCreditCents<=0（如目标档被活动/券打到 0 元）早退——否则会绕过下方「超额拒单」，
      // 让「旧套餐仍有持有价值、目标 0 元」的换档静默放行、旧价值蒸发。0 元场景由 rawCredit/超额判定兜底：
      // rawCredit≥2 → 超额拒单；rawCredit∈{0,1} → clamp 为 0 → return null（退化为无抵扣，不影响 0 元下单）。
      const authQuota = (await this.creditService.getAuthoritativeBalances(activeSelf.id, params.userId)).quota || 0;
      // remainingCredits 维持既有语义（clamp≥0，供返回值锚定/下游用，字节不变）。
      // R6 §1.4：欠额（quota<0）单独取绝对值，用于从持有价值中显式扣减；
      // quota===0 仍与原逻辑一致（无正余额、无欠额）→ return null。
      const remainingCredits = Math.max(0, authQuota);
      const debtCredits = Math.max(0, -authQuota);
      if (remainingCredits <= 0 && debtCredits <= 0) return null;

      // ── 分段持有价值（按 order 分块）──────────────────────────────────────────────
      // 当前 entitlement 的有效期由「原始/切换单 + 各续订单」按购买顺序拼成服务块序列；每块自带单月价
      // (value/months)。剩余价值 = 当前所在块按本月未用比例折算 + 未来整月各自所属块的全额单月价（过去
      // 月不计）。不跨块均摊——兼容不同周期价/活动价/结转价（否则会把某块折扣/溢价错摊到别的月）。
      const DAY_MS = 24 * 60 * 60 * 1000;
      const warnNoAbate = (reason: string, extra?: Record<string, unknown>) =>
        this.logger.warn(
          `自营换档抵扣跳过(${reason}) entitlement=${activeSelf.id} order=${activeSelf.orderId ?? ''} ` +
            `currency=${params.currency}${extra ? ' ' + JSON.stringify(extra) : ''}`,
        );
      const periodToMonths = (bp: string | null | undefined) =>
        bp === 'quarterly' ? 3 : bp === 'yearly' ? 12 : 1;

      // 续订审计行（本 entitlement 的续订单）：CANCELLED + lastError=renewal-of:<id> + 同 tenant/product。
      const renewalRows = await this.prisma.codingPlanEntitlement.findMany({
        where: {
          tenantId,
          productId: params.productId,
          fulfillmentMode: CodingPlanFulfillmentMode.platform_model_package,
          status: 'CANCELLED',
          lastError: `renewal-of:${activeSelf.id}`,
        },
        select: { orderId: true },
      });
      // 原始/切换单 + 续订单，按 orderId 去重。
      const orderIds = Array.from(
        new Set(
          [activeSelf.orderId, ...renewalRows.map((r) => r.orderId)].filter(
            (id): id is string => !!id,
          ),
        ),
      );
      if (orderIds.length === 0) return null;
      // 仅纳入已支付/履约中/已完成的有效订单（排除退款/取消/失败，防退款单仍计入价值）。
      const blockOrders = await this.prisma.order.findMany({
        where: {
          id: { in: orderIds },
          status: { in: [OrderStatus.PAID, OrderStatus.FULFILLING, OrderStatus.COMPLETED] },
        },
        select: {
          id: true,
          amountCents: true,
          prorationCreditCents: true,
          currency: true,
          billingPeriod: true,
          createdAt: true,
        },
      });
      // 原始单必须存在且有效。
      const originalOrder = blockOrders.find((o) => o.id === activeSelf.orderId);
      if (!originalOrder) return null;
      // 任一相关块跨币种 → 整条不抵（不删块，避免破坏时间轴；外币按面值折算会错算）。
      if (blockOrders.some((o) => (o.currency ?? '').toLowerCase() !== params.currency.toLowerCase())) {
        warnNoAbate('currency_mismatch');
        return null;
      }
      // 按购买时间稳定排序拼服务块（block0=原始/切换，其后各续订）。
      const blocks = blockOrders
        .slice()
        .sort((a, b) => a.createdAt.getTime() - b.createdAt.getTime() || a.id.localeCompare(b.id))
        .map((o) => ({
          months: periodToMonths(o.billingPeriod),
          value: Math.max(0, o.amountCents ?? 0) + Math.max(0, o.prorationCreditCents ?? 0),
        }));
      const totalMonths = blocks.reduce((sum, b) => sum + b.months, 0);
      const heldValueCents = blocks.reduce((sum, b) => sum + b.value, 0);
      if (totalMonths <= 0) {
        warnNoAbate('invalid_total_months');
        return null;
      }
      if (heldValueCents <= 0) return null;

      // 时间轴 + 一致性守卫：只有 span ≈ totalMonths × plan.validityDays（同 plan 服务月等长）才走均匀月轴；
      // 否则（validityDaysOverride / validityDays 中途被改 / 非标扩展）块边界不确定 → 保守不抵。
      const createdMs = activeSelf.createdAt?.getTime();
      const expiresMs = activeSelf.expiresAt?.getTime();
      if (createdMs == null || expiresMs == null || expiresMs <= createdMs) {
        warnNoAbate('invalid_entitlement_span', { createdMs, expiresMs });
        return null;
      }
      if (expiresMs <= Date.now()) {
        warnNoAbate('expired_entitlement');
        return null;
      }
      const vd = oldPlan?.validityDays ?? 0;
      const spanMs = expiresMs - createdMs;
      if (vd <= 0 || Math.abs(spanMs - totalMonths * vd * DAY_MS) > DAY_MS) {
        warnNoAbate('non_uniform_span', { spanMs, totalMonths, validityDays: vd });
        return null;
      }

      // 均匀月轴：定位当前月 k，映射到所属块取单月价。
      const monthLen = spanMs / totalMonths;
      const k = Math.min(totalMonths - 1, Math.max(0, Math.floor((Date.now() - createdMs) / monthLen)));
      const perMonthOfIndex = (j: number): number => {
        let acc = 0;
        for (const b of blocks) {
          if (j < acc + b.months) return b.value / b.months;
          acc += b.months;
        }
        const last = blocks[blocks.length - 1];
        return last.value / last.months;
      };
      const currentMonthRatio = Math.min(1, Math.max(0, remainingCredits / oldMonthly));
      // 剩余价值 = 当前月(所属块单月价 × 本月未用比例) + 各未来整月(所属块单月价全额)。
      let remainingValue = perMonthOfIndex(k) * currentMonthRatio;
      for (let j = k + 1; j < totalMonths; j++) remainingValue += perMonthOfIndex(j);
      // R6 §1.4：欠额按「当前月单价 × 欠额/月度额」显式换算成金额，从持有价值中扣减（=下单还账）。
      // 用与上方 currentMonthRatio 完全一致的单价口径（perMonthOfIndex(k)），欠额封顶一个月。
      const debtValue = perMonthOfIndex(k) * Math.min(1, debtCredits / oldMonthly);
      remainingValue -= debtValue;
      const rawCredit = Math.round(remainingValue);
      if (rawCredit <= 0) {
        // 欠额把持有价值抵扣殆尽 → 零抵扣放行；余额欠额随旧 entitlement 废弃=核销。
        // 注意：本函数在下单估价阶段被调用（订单未支付、旧 entitlement 未取消），此处只记
        // 诊断日志，不落核销指标——否则用户反复建单弃付会重复累计、污染财务/灰度信号（codex P2#3）。
        // 真正的核销指标应在支付成功、旧 entitlement 作废后由履约链路记（随 #74 一并接线）。
        if (debtCredits > 0) {
          this.logger.warn(
            `自营换档欠额将核销(估价) entitlement=${activeSelf.id} debtCredits=${debtCredits} ` +
              `heldValueBeforeDebt=${Math.round(remainingValue + debtValue)}`,
          );
        }
        return null;
      }
      // 超额不支持换套餐（产品拍板）：剩余持有价值 > 目标套餐本单价 → 拒单（不封顶/不蒸发/不付费换）。
      if (rawCredit > params.maxCreditCents + 1) {
        throw new BadRequestException(
          '当前套餐剩余价值高于目标套餐单期价格，暂不支持直接切换；请到期后再购，或通过退套餐/退款流程处理。',
        );
      }
      const creditCents = Math.min(params.maxCreditCents, Math.max(0, rawCredit));
      if (creditCents <= 0) return null;
      return {
        creditCents,
        sourcePlanId: activeSelf.planId,
        sourceEntitlementId: activeSelf.id, // 履约时锚定同一性，防「切走再切回同档」等场景重复抵扣
        remainingCredits,
        monthlyCredits: oldMonthly,
      };
    }

    // 通用订阅抵扣无降档禁令，maxCreditCents<=0 时无抵扣空间，照旧早退。
    if (params.maxCreditCents <= 0) return null;
    const subscription = await this.prisma.subscriptionPeriod.findFirst({
      where: {
        tenantId,
        productId: params.productId,
        status: 'ACTIVE',
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      include: {
        plan: {
          include: {
            prices: {
              where: {
                currency: params.currency.toLowerCase(),
                isActive: true,
              },
              take: 1,
            },
          },
        },
      },
      orderBy: [{ startedAt: 'desc' }, { createdAt: 'desc' }],
    });
    if (!subscription?.plan) return null;
    if (
      subscription.planId === params.targetPlanId &&
      subscription.billingPeriod === params.targetBillingPeriod
    ) {
      return null;
    }

    const monthlyCredits = subscription.plan.monthlyCredits;
    if (!monthlyCredits || monthlyCredits <= 0) return null;

    const balances = await this.creditService.getAuthoritativeBalances(
      subscription.id,
      params.userId,
    );
    const remainingCredits = Math.max(0, balances.quota || 0);
    if (remainingCredits <= 0) return null;

    const price = subscription.plan.prices?.[0] ?? null;
    const currentMonthlyPrice = price?.monthlyPrice ??
      (params.currency.toLowerCase() === 'usd' ? subscription.plan.monthlyPrice : null);
    if (!currentMonthlyPrice || currentMonthlyPrice <= 0) return null;

    const rawCredit = Math.round((remainingCredits / monthlyCredits) * currentMonthlyPrice);
    const creditCents = Math.min(params.maxCreditCents, Math.max(0, rawCredit));
    if (creditCents <= 0) return null;

    return {
      creditCents,
      sourcePlanId: subscription.planId,
      remainingCredits,
      monthlyCredits,
    };
  }

  private async resolveCodingPlanOrderTenantId(userId: string, planId: string): Promise<string | null> {
    const plan = await this.prisma.plan.findUnique({
      where: { id: planId },
      select: {
        product: { select: { billingMode: true } },
      },
    });
    if (plan?.product?.billingMode !== ProductBillingMode.CODING_PLAN) return null;
    return this.billingService.resolvePersonalTenantIdForUser(userId);
  }

  // finding：仅自营 CodingPlan(platform_model_package)——下单/升级 per-user，解析到个人 tenant、绕开当前工作区
  // requireBillingRole gate。转售 provider_resale / 历史 null 返回 null（维持当前工作区口径，不误伤转售/订阅）。
  private async resolveSelfOpOrderTenantId(userId: string, planId: string): Promise<string | null> {
    const plan = await this.prisma.plan.findUnique({
      where: { id: planId },
      select: { product: { select: { billingMode: true, codingPlanFulfillmentMode: true } } },
    });
    const p = plan?.product;
    if (p?.billingMode !== ProductBillingMode.CODING_PLAN || p?.codingPlanFulfillmentMode !== 'platform_model_package') {
      return null;
    }
    return this.billingService.resolvePersonalTenantIdForUser(userId);
  }

  private async createOrderWithPurchaseReservations(
    data: PaymentOrderCreateInput,
    options: {
      discountCodeId?: string | null;
      discountUserId: string;
      resalePlanId?: string | null;
      selfOpSalesCapPlanId?: string | null;
    },
  ) {
    return this.prisma.$transaction(async (tx) => {
      // 锁序：自营限量(per-plan 写锁) → 促销码锁 → 转售库存锁 → 建单。三特性按 plan 归属互斥，统一事务内串行。
      if (options.selfOpSalesCapPlanId) {
        await acquirePlanWriteLock(tx, options.selfOpSalesCapPlanId); // 与 setPlanActive/绑定写同锁串行化
        await this.assertSalesCapAvailable(tx, options.selfOpSalesCapPlanId, data.tenantId);
      }
      if (options.discountCodeId) {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`discount-code:${options.discountCodeId}`}))`;
        await this.assertDiscountReservationAvailable(tx, options.discountCodeId, options.discountUserId);
      }
      if (options.resalePlanId) {
        await this.assertProviderResalePlanStockAvailable(tx, options.resalePlanId);
      }
      return tx.order.create({ data });
    });
  }

  private async assertProviderResalePlanStockAvailable(
    tx: Prisma.TransactionClient,
    planId: string,
  ): Promise<void> {
    const plan = await tx.plan.findUnique({
      where: { id: planId },
      select: {
        id: true,
        isActive: true,
        salesLimit: true,
        product: {
          select: {
            isActive: true,
            billingMode: true,
            codingPlanFulfillmentMode: true,
          },
        },
      },
    });
    if (!plan || !plan.isActive) {
      throw new NotFoundException('套餐不存在');
    }
    if (!plan.product || plan.product.billingMode !== ProductBillingMode.CODING_PLAN) return;
    if (plan.product.codingPlanFulfillmentMode !== CodingPlanFulfillmentMode.provider_resale) return;
    if (!plan.product.isActive) {
      throw new BadRequestException('套餐所属产品未启用');
    }
    const salesLimit = Math.max(0, plan.salesLimit ?? 0);
    if (salesLimit <= 0) return;

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`plan-sales:${planId}`}))`;
    const reserved = await tx.order.count({
      where: {
        planId,
        orderType: PrismaOrderType.SUBSCRIPTION,
        status: { in: [...PLAN_SALES_RESERVED_ORDER_STATUSES] },
      },
    });
    if (reserved >= salesLimit) {
      throw new BadRequestException('该转售套餐已售罄');
    }
  }

  /**
   * 自营套餐限量售罄闸（tx 内、per-plan 写锁下调用）。**锁内重读 cap**（不信锁外快照，防并发改 cap 超卖）。
   * 「已占份数」= 去重(持该 plan ACTIVE 自营 entitlement 的 tenant ∪ 该 plan 有在途订单的 tenant)。在途 =
   * 已下单未履约(PENDING/PAID/FULFILLING)；已履约占用体现为 ACTIVE entitlement；退款/取消/过期→entitlement
   * 转非 ACTIVE 即释放名额。买家 tenant 已在集合(同 plan 续订/在途)→放行不新增；否则新客达上限抛「已售罄」。
   */
  private async assertSalesCapAvailable(
    tx: Prisma.TransactionClient,
    planId: string,
    buyerTenantId: string,
  ): Promise<void> {
    const plan = await tx.plan.findUnique({
      where: { id: planId },
      select: { maxSellableQuantity: true },
    });
    const cap = plan?.maxSellableQuantity;
    if (cap == null || cap <= 0) return; // 不限量（锁内确认）
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
    // 买家已是持有者/在途者：同 plan 续订，不占新份，放行。
    if (holders.has(buyerTenantId)) return;
    if (holders.size >= cap) {
      throw new ConflictException('该套餐已售罄');
    }
  }

  private async assertDiscountReservationAvailable(
    tx: Prisma.TransactionClient,
    discountCodeId: string,
    userId: string,
  ): Promise<void> {
    const code = await tx.discountCode.findUnique({
      where: { id: discountCodeId },
      select: {
        id: true,
        isActive: true,
        maxUses: true,
        maxUsesPerUser: true,
        currentUses: true,
      },
    });
    if (!code || !code.isActive) {
      throw new BadRequestException('促销码无效');
    }

    const [reservedUses, completedUses] = await Promise.all([
      tx.order.count({
        where: {
          discountCodeId,
          status: { in: DISCOUNT_RESERVED_ORDER_STATUSES },
        },
      }),
      tx.order.count({
        where: {
          discountCodeId,
          status: OrderStatus.COMPLETED,
        },
      }),
    ]);
    if (code.maxUses > 0 && Math.max(code.currentUses, completedUses) + reservedUses >= code.maxUses) {
      throw new BadRequestException('促销码已使用完');
    }

    if (code.maxUsesPerUser > 0) {
      const [redeemed, reservedByUser, completedByUser] = await Promise.all([
        tx.discountCodeRedemption.count({
          where: { discountCodeId, userId },
        }),
        tx.order.count({
          where: {
            discountCodeId,
            userId,
            status: { in: DISCOUNT_RESERVED_ORDER_STATUSES },
          },
        }),
        tx.order.count({
          where: {
            discountCodeId,
            userId,
            status: OrderStatus.COMPLETED,
          },
        }),
      ]);
      if (Math.max(redeemed, completedByUser) + reservedByUser >= code.maxUsesPerUser) {
        throw new BadRequestException('促销码使用次数已达上限');
      }
    }
  }

  async cancelOrder(
    orderId: string,
    userId: string,
    tenantId?: string | null,
    productId?: string | null,
  ): Promise<void> {
    // finding：自营 CodingPlan 订单 per-user——按 userId(+productId 隔离)取、绕开当前工作区
    // （订单实际落 personal tenant，非 personal 工作区原会 Forbidden）。
    // 非自营维持原逻辑（当前工作区 + requireBillingRole + tenant 匹配 + productId 范围），零改。
    const selfOp = await this.paymentRepository.isSelfOpCodingPlanOrderOwnedByUser(orderId, userId);
    let order: {
      userId: string;
      tenantId: string;
      status: OrderStatus;
      tradeNo?: string | null;
      checkoutInitState?: PaymentCheckoutInitState;
      checkoutProviderReference?: string | null;
    } | null;
    if (selfOp) {
      // findOrderOwnedByUser 的 where 必含 userId + productId 范围 → 属主 + 产品隔离由查询保证。
      order = await this.paymentRepository.findOrderOwnedByUser(orderId, userId, productId);
      if (!order) {
        throw new NotFoundException('订单不存在');
      }
    } else {
      const subject = await this.billingService.resolveSubjectForUser(userId, tenantId, {
        requireBillingRole: true,
      });
      order = productId
        ? await this.paymentRepository.findOrderByIdAndUser(orderId, userId, subject.tenantId, productId)
        : await this.paymentRepository.findOrderById(orderId);
      if (!order) {
        throw new NotFoundException('订单不存在');
      }
      if (order.userId !== userId || order.tenantId !== subject.tenantId) {
        throw new ForbiddenException('无权操作该订单');
      }
    }

    if (order.status !== OrderStatus.PENDING) {
      throw new ConflictException('只能取消待支付订单');
    }
    if (
      order.checkoutInitState !== PaymentCheckoutInitState.NOT_STARTED
      || Boolean(order.checkoutProviderReference)
      || Boolean(order.tradeNo)
    ) {
      throw new ConflictException(
        '支付渠道订单已创建，当前缺少可确认的远端关单协议；请等待支付链接过期',
      );
    }

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const updated = await tx.order.updateMany({
        where: {
          id: orderId,
          status: OrderStatus.PENDING,
          checkoutInitState: PaymentCheckoutInitState.NOT_STARTED,
          checkoutProviderReference: null,
          tradeNo: null,
        },
        data: {
          status: OrderStatus.CANCELLED,
          cancelledAt: new Date(),
          fulfillmentAttemptId: null,
          fulfillmentClaimedAt: null,
          checkoutInitState: PaymentCheckoutInitState.TERMINAL,
          checkoutLeaseId: null,
          checkoutLeaseExpiresAt: null,
          checkoutContextEncrypted: null,
          checkoutPayUrlEncrypted: null,
          checkoutPayUrlExpiresAt: null,
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException(
          '订单状态或支付渠道初始化状态已被并发修改，请刷新后重试',
        );
      }
      await tx.orderAuditLog.create({
        data: {
          orderId,
          fromStatus: OrderStatus.PENDING,
          toStatus: OrderStatus.CANCELLED,
          operator: `user:${userId}`,
          detail: '用户主动取消（渠道订单尚未创建）',
        },
      });
    });
  }

  async getUserOrders(
    userId: string,
    page: number,
    pageSize: number,
    status?: string,
    orderType?: string,
    tenantId?: string | null,
    productId?: string | null,
  ) {
    const subject = await this.billingService.resolveSubjectForUser(userId, tenantId, {
      requireBillingRole: true,
    });
    const [items, total] = await Promise.all([
      this.paymentRepository.findUserOrders(
        userId,
        (page - 1) * pageSize,
        pageSize,
        status,
        orderType,
        subject.tenantId,
        productId,
      ),
      this.paymentRepository.countUserOrders(userId, status, orderType, subject.tenantId, productId),
    ]);

    return {
      items: items.map((o: Prisma.OrderGetPayload<{ include: { plan: true } }>) => this.toOrder(o)),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async retryFulfill(orderId: string) {
    await this.fulfillOrder(orderId);
  }

  async getAvailablePaymentMethods(
    input: PaymentMethodsQueryInput & {
      allowedPaymentCallbackOrigins?: string[] | null;
    },
  ): Promise<PaymentMethodsResponse> {
    const paymentType = this.resolvePaymentType(input.orderType, input.productId ?? null);
    const platformCurrency = await this.platformCurrency();
    const requestedCurrency = input.currency
      ? normalizeCurrencyCode(input.currency)
      : platformCurrency;
    if (input.currency && requestedCurrency !== platformCurrency) {
      throw new BadRequestException(`当前部署仅支持 ${platformCurrency.toUpperCase()} 支付`);
    }
    const currency = platformCurrency;
    const methods: AvailablePaymentMethod[] = [];
    const stripeRecurringCheckoutBlocked =
      input.orderType === 'BUNDLE'
      || (
        input.orderType === 'SUBSCRIPTION'
        && (
          !input.productId
          || (
            await this.prisma.product.findUnique({
              where: { id: input.productId },
              select: { billingMode: true },
            })
          )?.billingMode !== ProductBillingMode.CODING_PLAN
        )
      );
    // undefined is the non-Partner/internal call path; null is the legacy
    // global-policy mode. An explicit empty product policy cannot supply the
    // callbacks that Partner order creation requires for redirect channels.
    const supportsPartnerRedirectCallbacks =
      input.allowedPaymentCallbackOrigins === undefined
      || input.allowedPaymentCallbackOrigins === null
      || input.allowedPaymentCallbackOrigins.length > 0;

    // BUNDLE 的 createOrder 明确只支持 Stripe。发现接口必须复用同一能力边界，
    // 避免先向调用方展示支付宝/微信，提交时再被拒绝。
    if (input.orderType !== 'BUNDLE') {
      if (currency === 'cny' && this.isWechatAvailable()) {
        methods.push({
          channel: 'WECHAT',
          label: '微信支付',
          currency: 'cny',
          mode: 'qr',
        });
      }

      if (
        supportsPartnerRedirectCallbacks
        && currency === 'cny'
        && await this.isAlipayAvailable(paymentType)
      ) {
        methods.push({
          channel: 'ALIPAY',
          label: '支付宝',
          currency: 'cny',
          mode: 'redirect',
        });
      }
    }

    if (
      supportsPartnerRedirectCallbacks
      && !stripeRecurringCheckoutBlocked
      && await this.isStripeAvailable(paymentType)
    ) {
      methods.push({
        channel: 'STRIPE',
        label: '银行卡',
        currency,
        mode: 'redirect',
      });
    }

    return { methods };
  }

  private isWechatAvailable(): boolean {
    return [
      'WECHAT_APP_ID',
      'WECHAT_MCH_ID',
      'WECHAT_API_V3_KEY',
      'WECHAT_SERIAL_NO',
      'WECHAT_PRIVATE_KEY_PATH',
      'WECHAT_NOTIFY_URL',
    ].every((key) => Boolean(this.config.get<string>(key)?.trim()));
  }

  private async isStripeAvailable(paymentType: string): Promise<boolean> {
    const instances = await this.paymentProviderRegistry?.getInstances('stripe') ?? [];
    if (instances.length > 0) {
      return instances.some((instance) => {
        if (!this.instanceSupportsPaymentType(instance, paymentType)) return false;
        try {
          this.buildStripeCredentials(instance, { requireSecretKey: true });
          return true;
        } catch {
          return false;
        }
      });
    }

    return Boolean(this.config.get<string>('STRIPE_SECRET_KEY')?.trim());
  }

  private async isAlipayAvailable(paymentType: string): Promise<boolean> {
    const instances = await this.paymentProviderRegistry?.getInstances('alipay') ?? [];
    if (instances.length > 0) {
      return instances.some((instance) => {
        if (!this.instanceSupportsPaymentType(instance, paymentType)) return false;
        try {
          this.buildAlipayCredentials(instance, {
            requireAppId: true,
            requirePrivateKey: true,
            requireAlipayPublicKey: true,
            requireNotifyUrl: true,
          });
          return true;
        } catch {
          return false;
        }
      });
    }

    return Boolean(
      this.config.get<string>('ALIPAY_APP_ID')?.trim() &&
      this.config.get<string>('ALIPAY_PRIVATE_KEY')?.trim() &&
      this.config.get<string>('ALIPAY_ALIPAY_PUBLIC_KEY')?.trim() &&
      this.config.get<string>('ALIPAY_NOTIFY_URL')?.trim()
    );
  }

  private instanceSupportsPaymentType(instance: ProviderInstance, paymentType?: string): boolean {
    const normalized = paymentType?.toLowerCase();
    if (!normalized || instance.supportedTypes.length === 0) return true;
    return instance.supportedTypes.some((type) => type.toLowerCase() === normalized);
  }

  private resolvePaymentType(orderType: string, productId: string | null): string {
    // Bundle 的创建路径以统一的 bundle capability 选择 Stripe 实例；
    // methods 即使由 Partner 注入 productId，也必须得到同一选择结果。
    if (orderType === 'BUNDLE') return 'bundle';
    if (productId) return productId;
    if (orderType === 'RECHARGE') return 'recharge';
    if (orderType === 'BOOSTER_PACK') return 'addon';
    return 'subscription';
  }

  private resolveStripeCallbackUrls(
    dto: CreateOrderInput,
    productOrigins?: string[] | null,
  ): {
    successUrl: string;
    cancelUrl: string;
  } {
    const useGlobalFallback = productOrigins === null || productOrigins === undefined;
    const successUrl = dto.successUrl || (
      useGlobalFallback ? this.config.get<string>('STRIPE_SUCCESS_URL') : undefined
    );
    const cancelUrl = dto.cancelUrl || (
      useGlobalFallback ? this.config.get<string>('STRIPE_CANCEL_URL') : undefined
    );

    if (!successUrl || !cancelUrl) {
      throw new BadRequestException('Stripe 回跳地址未配置');
    }
    assertAllowedPaymentCallbackUrl(successUrl, this.config, 'successUrl', productOrigins);
    assertAllowedPaymentCallbackUrl(cancelUrl, this.config, 'cancelUrl', productOrigins);

    return { successUrl, cancelUrl };
  }

  private resolveAlipayReturnUrl(
    dto: CreateOrderInput,
    productOrigins?: string[] | null,
  ): string | undefined {
    const useGlobalFallback = productOrigins === null || productOrigins === undefined;
    const returnUrl = dto.successUrl || (
      useGlobalFallback
        ? this.config.get<string>('ALIPAY_RETURN_URL')?.trim() || undefined
        : undefined
    );
    if (!returnUrl && !useGlobalFallback) {
      throw new BadRequestException('Alipay 回跳地址未配置');
    }
    assertAllowedPaymentCallbackUrl(returnUrl, this.config, 'successUrl', productOrigins);
    return returnUrl;
  }

  private async selectStripeProviderInstance(paymentType?: string | null): Promise<{
    instanceId?: string;
    credentials?: StripeCredentials;
  }> {
    const instance = await this.paymentProviderRegistry?.selectInstance(
      'stripe',
      paymentType ?? undefined,
    );
    if (!instance) {
      const activeStripeCount = this.paymentProviderRegistry?.getInstanceCount('stripe') ?? 0;
      if (activeStripeCount > 0) {
        throw new ServiceUnavailableException('Stripe 未启用当前产品或支付场景');
      }
      return {};
    }

    return {
      instanceId: instance.id,
      credentials: this.buildStripeCredentials(instance, { requireSecretKey: true }),
    };
  }

  private async selectAlipayProviderInstance(paymentType?: string | null): Promise<{
    instanceId?: string;
    credentials?: AlipayCredentials;
  }> {
    const instance = await this.paymentProviderRegistry?.selectInstance(
      'alipay',
      paymentType ?? undefined,
    );
    if (!instance) {
      const activeAlipayCount = this.paymentProviderRegistry?.getInstanceCount('alipay') ?? 0;
      if (activeAlipayCount > 0) {
        throw new ServiceUnavailableException('支付宝未启用当前产品或支付场景');
      }
      return {};
    }

    return {
      instanceId: instance.id,
      credentials: this.buildAlipayCredentials(instance, {
        requireAppId: true,
        requirePrivateKey: true,
        requireAlipayPublicKey: true,
        requireNotifyUrl: true,
      }),
    };
  }

  private async resolveStripeCredentialsForOrder(
    paymentProviderInstanceId?: string | null,
  ): Promise<StripeCredentials | undefined> {
    if (paymentProviderInstanceId) {
      const instance = await this.paymentProviderRegistry?.getInstanceById(paymentProviderInstanceId);
      if (!instance) {
        throw new ServiceUnavailableException('订单关联的 Stripe 支付实例不存在');
      }
      return this.buildStripeCredentials(instance, { requireSecretKey: true });
    }

    const selected = await this.selectStripeProviderInstance();
    return selected.credentials;
  }

  private async resolveAlipayCredentialsForOrder(
    paymentProviderInstanceId?: string | null,
  ): Promise<AlipayCredentials | undefined> {
    if (paymentProviderInstanceId) {
      const instance = await this.paymentProviderRegistry?.getInstanceById(paymentProviderInstanceId);
      if (!instance) {
        throw new ServiceUnavailableException('订单关联的支付宝支付实例不存在');
      }
      return this.buildAlipayCredentials(instance, {
        requireAppId: true,
        requirePrivateKey: true,
        requireAlipayPublicKey: true,
      });
    }

    const selected = await this.selectAlipayProviderInstance();
    return selected.credentials;
  }

  private async getStripeWebhookCredentialCandidates(): Promise<Array<{
    instanceIds: string[];
    credentials: StripeCredentials;
  }>> {
    const instances = await this.paymentProviderRegistry?.getInstances('stripe', { includeInactive: true }) ?? [];
    const candidates = new Map<string, {
      instanceIds: string[];
      credentials: StripeCredentials;
    }>();

    for (const instance of instances) {
      const secretKey = instance.config.secretKey?.trim();
      const webhookSecret = instance.config.webhookSecret?.trim();
      if (!secretKey || !webhookSecret) {
        continue;
      }
      // Stripe signature verification is distinguishable only by webhook
      // secret. Instances sharing it are all valid identities for the event,
      // even if their API secret keys differ.
      const fingerprint = webhookSecret;
      const existing = candidates.get(fingerprint);
      if (existing) {
        existing.instanceIds.push(instance.id);
      } else {
        candidates.set(fingerprint, {
          instanceIds: [instance.id],
          credentials: { secretKey, webhookSecret },
        });
      }
    }

    return Array.from(candidates.values());
  }

  private buildStripeCredentials(
    instance: ProviderInstance,
    options: { requireSecretKey?: boolean; requireWebhookSecret?: boolean } = {},
  ): StripeCredentials {
    const secretKey = instance.config.secretKey?.trim();
    const webhookSecret = instance.config.webhookSecret?.trim();

    if (options.requireSecretKey && !secretKey) {
      throw new ServiceUnavailableException(`Stripe 实例 ${instance.name} 未配置 Secret Key`);
    }
    if (options.requireWebhookSecret && !webhookSecret) {
      throw new ServiceUnavailableException(`Stripe 实例 ${instance.name} 未配置 Webhook Secret`);
    }

    return { secretKey, webhookSecret };
  }

  private async getAlipayNotifyCredentialCandidates(appId?: string): Promise<Array<{
    instanceIds: string[];
    credentials: AlipayCredentials;
  }>> {
    const instances = await this.paymentProviderRegistry?.getInstances('alipay', { includeInactive: true }) ?? [];
    const candidates = new Map<string, {
      instanceIds: string[];
      credentials: AlipayCredentials;
    }>();
    const normalizedAppId = appId?.trim();

    for (const instance of instances) {
      let credentials: AlipayCredentials;
      try {
        credentials = this.buildAlipayCredentials(instance, {
          requireAppId: true,
          requirePrivateKey: true,
          requireAlipayPublicKey: true,
        });
      } catch {
        continue;
      }

      if (normalizedAppId && credentials.appId !== normalizedAppId) {
        continue;
      }

      const fingerprint = [
        credentials.appId,
        credentials.alipayPublicKey,
        credentials.keyType,
      ].join(':');
      const existing = candidates.get(fingerprint);
      if (existing) {
        existing.instanceIds.push(instance.id);
      } else {
        candidates.set(fingerprint, {
          instanceIds: [instance.id],
          credentials,
        });
      }
    }

    return Array.from(candidates.values());
  }

  private buildAlipayCredentials(
    instance: ProviderInstance,
    options: {
      requireAppId?: boolean;
      requirePrivateKey?: boolean;
      requireAlipayPublicKey?: boolean;
      requireNotifyUrl?: boolean;
    } = {},
  ): AlipayCredentials {
    const appId = instance.config.appId?.trim();
    const privateKey = instance.config.privateKey?.trim();
    const alipayPublicKey = instance.config.alipayPublicKey?.trim();
    const notifyUrl = instance.config.notifyUrl?.trim();
    const returnUrl = instance.config.returnUrl?.trim();
    const gateway = instance.config.gateway?.trim();
    const keyType = instance.config.keyType?.trim();
    const timeoutMs = this.normalizeAlipayTimeoutMs(
      instance.config.timeoutMs ??
      instance.config.requestTimeoutMs ??
      instance.config.timeout,
    );

    if (options.requireAppId && !appId) {
      throw new ServiceUnavailableException(`支付宝实例 ${instance.name} 未配置 App ID`);
    }
    if (options.requirePrivateKey && !privateKey) {
      throw new ServiceUnavailableException(`支付宝实例 ${instance.name} 未配置应用私钥`);
    }
    if (options.requireAlipayPublicKey && !alipayPublicKey) {
      throw new ServiceUnavailableException(`支付宝实例 ${instance.name} 未配置支付宝公钥`);
    }
    if (options.requireNotifyUrl && !notifyUrl) {
      throw new ServiceUnavailableException(`支付宝实例 ${instance.name} 未配置回调地址`);
    }

    return {
      appId,
      privateKey,
      alipayPublicKey,
      notifyUrl,
      returnUrl,
      gateway,
      keyType,
      timeoutMs,
    };
  }

  private normalizeAlipayTimeoutMs(value: string | undefined): number | undefined {
    if (!value?.trim()) return undefined;
    const parsed = Number.parseInt(value, 10);
    if (!Number.isFinite(parsed)) return undefined;
    return Math.min(Math.max(parsed, 1_000), 60_000);
  }

  private buildStripePaymentMetadata(input: {
    orderId: string;
    userId: string;
    tenantId: string;
    billingAccountId?: string | null;
    productId?: string | null;
    planId?: string | null;
    boosterPackId?: string | null;
    bundleSkuId?: string | null;
    orderType: string;
    billingPeriod?: string | null;
  }): Record<string, string> {
    return {
      orderId: input.orderId,
      userId: input.userId,
      tenantId: input.tenantId,
      billingAccountId: input.billingAccountId ?? '',
      productId: input.productId ?? '',
      planId: input.planId ?? '',
      boosterPackId: input.boosterPackId ?? '',
      bundleSkuId: input.bundleSkuId ?? '',
      orderType: input.orderType,
      billingPeriod: input.billingPeriod ?? '',
    };
  }

  private async recordStripeCheckoutLedger(params: {
    orderId: string;
    checkoutSessionId: string;
    paymentProviderInstanceId?: string | null;
    stripeEventId?: string | null;
  }): Promise<boolean> {
    try {
      const credentials = await this.resolveStripeCredentialsForOrder(params.paymentProviderInstanceId);
      const snapshot = await this.stripeService.retrieveCheckoutLedgerSnapshot(
        params.checkoutSessionId,
        credentials,
      );
      await this.upsertStripeLedgerSnapshot({
        orderId: params.orderId,
        paymentProviderInstanceId: params.paymentProviderInstanceId,
        stripeEventId: params.stripeEventId,
        snapshot,
      });
      return true;
    } catch (err) {
      this.logger.warn(
        `Stripe ledger 写入失败: order=${params.orderId} session=${params.checkoutSessionId} error=${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  private async recordStripeSubscriptionLedger(params: {
    orderId: string;
    subscriptionId: string;
    paymentProviderInstanceId?: string | null;
  }): Promise<boolean> {
    try {
      const credentials = await this.resolveStripeCredentialsForOrder(params.paymentProviderInstanceId);
      const snapshot = await this.stripeService.retrieveSubscriptionLedgerSnapshot(
        params.subscriptionId,
        credentials,
      );
      await this.upsertStripeLedgerSnapshot({
        orderId: params.orderId,
        paymentProviderInstanceId: params.paymentProviderInstanceId,
        snapshot,
      });
      return true;
    } catch (err) {
      this.logger.warn(
        `Stripe subscription ledger 写入失败: order=${params.orderId} subscription=${params.subscriptionId} error=${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  private async recordStripeRefundLedger(params: {
    orderId: string;
    refundId: string;
    paymentProviderInstanceId?: string | null;
  }): Promise<boolean> {
    try {
      const credentials = await this.resolveStripeCredentialsForOrder(params.paymentProviderInstanceId);
      const snapshot = await this.stripeService.retrieveRefundLedgerSnapshot(
        params.refundId,
        credentials,
      );
      await this.upsertStripeLedgerSnapshot({
        orderId: params.orderId,
        paymentProviderInstanceId: params.paymentProviderInstanceId,
        snapshot,
      });
      return true;
    } catch (err) {
      this.logger.warn(
        `Stripe refund ledger 写入失败: order=${params.orderId} refund=${params.refundId} error=${
          err instanceof Error ? err.message : String(err)
        }`,
      );
      return false;
    }
  }

  private async persistStripeRefundLedgerRecoveryAlert(params: {
    orderId: string;
    refundId: string;
    paymentProviderInstanceId?: string | null;
    providerRefundIntentId?: string | null;
    stripeSubscriptionCancellationTaskId?: string | null;
    error: string;
  }): Promise<void> {
    try {
      await this.prisma.alertEvent.create({
        data: {
          category: AlertEventCategory.PAYMENT,
          severity: AlertEventSeverity.CRITICAL,
          title: 'Stripe退款台账记录失败',
          message:
            `订单 ${params.orderId} 已在 Stripe 退款成功，但本地退款台账写入失败；可从持久退款 intent 重放补录`,
          sourceType: 'order',
          sourceId: params.orderId,
          context: JSON.stringify({
            refundId: params.refundId,
            paymentProviderInstanceId:
              params.paymentProviderInstanceId ?? null,
            providerRefundIntentId:
              params.providerRefundIntentId ?? null,
            stripeSubscriptionCancellationTaskId:
              params.stripeSubscriptionCancellationTaskId ?? null,
            error: params.error,
          }),
        },
      });
    } catch (err) {
      this.logger.error(
        `Stripe refund ledger recovery alert 写入失败: order=${params.orderId} refund=${params.refundId} error=${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async collectMissingStripeRefundLedgerCandidates(
    loadPage: (
      cursorId?: string,
    ) => Promise<StripeRefundLedgerRecoveryCandidate[]>,
    limit: number,
  ): Promise<StripeRefundLedgerRecoveryCandidate[]> {
    const missing: StripeRefundLedgerRecoveryCandidate[] = [];
    let cursorId: string | undefined;

    while (missing.length < limit) {
      const page = await loadPage(cursorId);
      if (page.length === 0) break;
      const existingRows = await this.prisma.stripePaymentLedger.findMany({
        where: {
          refundId: {
            in: Array.from(new Set(page.map((row) => row.refundId))),
          },
        },
        select: { refundId: true },
      });
      const existing = new Set(
        existingRows
          .map((row) => row.refundId)
          .filter((refundId): refundId is string => Boolean(refundId)),
      );
      for (const candidate of page) {
        if (!existing.has(candidate.refundId)) {
          missing.push(candidate);
          if (missing.length >= limit) break;
        }
      }

      const nextCursorId = page.at(-1)!.sourceId;
      if (
        page.length < STRIPE_REFUND_LEDGER_SCAN_PAGE_SIZE
        || nextCursorId === cursorId
      ) {
        break;
      }
      cursorId = nextCursorId;
    }
    return missing;
  }

  async backfillStripePaymentLedgers(params: {
    start?: Date;
    end?: Date;
    limit?: number;
    dryRun?: boolean;
  } = {}): Promise<{
    scanned: number;
    backfilled: number;
    failed: number;
    skippedUnsupportedTradeNo: number;
    refundScanned: number;
    refundBackfilled: number;
    refundFailed: number;
    dryRun: boolean;
  }> {
    const limit = Math.min(Math.max(Number(params.limit ?? 100), 1), 500);
    const periodWhere = params.start && params.end
      ? {
          OR: [
            { paidAt: { gte: params.start, lt: params.end } },
            { createdAt: { gte: params.start, lt: params.end } },
            { completedAt: { gte: params.start, lt: params.end } },
            { refundedAt: { gte: params.start, lt: params.end } },
          ],
        }
      : {};
    const providerRefundPeriodWhere:
      Prisma.ProviderRefundIntentWhereInput =
      params.start && params.end
        ? {
            providerConfirmedAt: {
              gte: params.start,
              lt: params.end,
            },
          }
        : { providerConfirmedAt: { not: null } };
    const subscriptionRefundPeriodWhere:
      Prisma.StripeSubscriptionCancellationTaskWhereInput =
      params.start && params.end
        ? {
            OR: [
              {
                providerCanceledAt: {
                  gte: params.start,
                  lt: params.end,
                },
              },
              {
                createdAt: {
                  gte: params.start,
                  lt: params.end,
                },
              },
              {
                updatedAt: {
                  gte: params.start,
                  lt: params.end,
                },
              },
            ],
          }
        : {};
    const [
      orders,
      providerRefundCandidates,
      subscriptionRefundCandidates,
    ] = await Promise.all([
      this.prisma.order.findMany({
        where: {
          channel: PayChannel.STRIPE,
          tradeNo: { not: null },
          ...periodWhere,
        },
        orderBy: [{ paidAt: 'desc' }, { createdAt: 'desc' }, { id: 'desc' }],
        take: limit,
        select: {
          id: true,
          tradeNo: true,
          paymentProviderInstanceId: true,
        },
      }),
      this.collectMissingStripeRefundLedgerCandidates(
        async (cursorId) => {
          const rows = await this.prisma.providerRefundIntent.findMany({
            where: {
              channel: PayChannel.STRIPE,
              providerRefundId: { not: null },
              ...providerRefundPeriodWhere,
            },
            orderBy: { id: 'asc' },
            take: STRIPE_REFUND_LEDGER_SCAN_PAGE_SIZE,
            ...(cursorId
              ? { cursor: { id: cursorId }, skip: 1 }
              : {}),
            select: {
              id: true,
              orderId: true,
              providerRefundId: true,
              paymentProviderInstanceId: true,
            },
          });
          return rows.flatMap((row) =>
            row.providerRefundId
              ? [{
                  source: 'PROVIDER_REFUND_INTENT' as const,
                  sourceId: row.id,
                  orderId: row.orderId,
                  refundId: row.providerRefundId,
                  paymentProviderInstanceId:
                    row.paymentProviderInstanceId,
                }]
              : [],
          );
        },
        limit,
      ),
      this.collectMissingStripeRefundLedgerCandidates(
        async (cursorId) => {
          const rows =
            await this.prisma.stripeSubscriptionCancellationTask.findMany({
              where: {
                refundId: { not: null },
                ...subscriptionRefundPeriodWhere,
              },
              orderBy: { id: 'asc' },
              take: STRIPE_REFUND_LEDGER_SCAN_PAGE_SIZE,
              ...(cursorId
                ? { cursor: { id: cursorId }, skip: 1 }
                : {}),
              select: {
                id: true,
                orderId: true,
                refundId: true,
                paymentProviderInstanceId: true,
              },
            });
          return rows.flatMap((row) =>
            row.refundId
              ? [{
                  source:
                    'STRIPE_SUBSCRIPTION_CANCELLATION_TASK' as const,
                  sourceId: row.id,
                  orderId: row.orderId,
                  refundId: row.refundId,
                  paymentProviderInstanceId:
                    row.paymentProviderInstanceId,
                }]
              : [],
          );
        },
        limit,
      ),
    ]);
    const refundCandidates = Array.from(
      new Map(
        [
          ...providerRefundCandidates,
          ...subscriptionRefundCandidates,
        ].map((candidate) => [candidate.refundId, candidate]),
      ).values(),
    );

    let backfilled = 0;
    let failed = 0;
    let skippedUnsupportedTradeNo = 0;
    for (const order of orders) {
      const tradeNo = order.tradeNo ?? '';
      if (params.dryRun) {
        if (tradeNo.startsWith('cs_') || tradeNo.startsWith('sub_')) {
          backfilled += 1;
        } else {
          skippedUnsupportedTradeNo += 1;
        }
        continue;
      }
      let ok = false;
      if (tradeNo.startsWith('cs_')) {
        ok = await this.recordStripeCheckoutLedger({
          orderId: order.id,
          checkoutSessionId: tradeNo,
          paymentProviderInstanceId: order.paymentProviderInstanceId,
        });
      } else if (tradeNo.startsWith('sub_')) {
        ok = await this.recordStripeSubscriptionLedger({
          orderId: order.id,
          subscriptionId: tradeNo,
          paymentProviderInstanceId: order.paymentProviderInstanceId,
        });
      } else {
        skippedUnsupportedTradeNo += 1;
        continue;
      }
      if (ok) backfilled += 1;
      else failed += 1;
    }

    let refundBackfilled = 0;
    let refundFailed = 0;
    for (const candidate of refundCandidates) {
      if (params.dryRun) {
        refundBackfilled += 1;
        continue;
      }
      const ok = await this.recordStripeRefundLedger({
        orderId: candidate.orderId,
        refundId: candidate.refundId,
        paymentProviderInstanceId:
          candidate.paymentProviderInstanceId,
      });
      if (ok) {
        refundBackfilled += 1;
      } else {
        refundFailed += 1;
        await this.persistStripeRefundLedgerRecoveryAlert({
          orderId: candidate.orderId,
          refundId: candidate.refundId,
          paymentProviderInstanceId:
            candidate.paymentProviderInstanceId,
          providerRefundIntentId:
            candidate.source === 'PROVIDER_REFUND_INTENT'
              ? candidate.sourceId
              : null,
          stripeSubscriptionCancellationTaskId:
            candidate.source ===
            'STRIPE_SUBSCRIPTION_CANCELLATION_TASK'
              ? candidate.sourceId
              : null,
          error: 'Stripe refund ledger backfill failed',
        });
      }
    }

    return {
      scanned: orders.length,
      backfilled,
      failed,
      skippedUnsupportedTradeNo,
      refundScanned: refundCandidates.length,
      refundBackfilled,
      refundFailed,
      dryRun: !!params.dryRun,
    };
  }

  private async upsertStripeLedgerSnapshot(params: {
    orderId?: string | null;
    paymentProviderInstanceId?: string | null;
    stripeEventId?: string | null;
    snapshot: StripeLedgerSnapshot;
  }): Promise<void> {
    const data = this.toStripeLedgerData(params);

    if (params.snapshot.balanceTransactionId) {
      await this.prisma.stripePaymentLedger.upsert({
        where: { balanceTransactionId: params.snapshot.balanceTransactionId },
        create: data,
        update: data,
      });
      return;
    }

    if (params.snapshot.refundId) {
      await this.prisma.stripePaymentLedger.upsert({
        where: { refundId: params.snapshot.refundId },
        create: data,
        update: data,
      });
      return;
    }

    const existing = await this.prisma.stripePaymentLedger.findFirst({
      where: {
        orderId: params.orderId ?? null,
        transactionType: params.snapshot.transactionType,
        checkoutSessionId: params.snapshot.checkoutSessionId ?? undefined,
        paymentIntentId: params.snapshot.paymentIntentId ?? undefined,
      },
      select: { id: true },
    });
    if (existing) {
      await this.prisma.stripePaymentLedger.update({
        where: { id: existing.id },
        data,
      });
      return;
    }

    await this.prisma.stripePaymentLedger.create({ data });
  }

  private toStripeLedgerData(params: {
    orderId?: string | null;
    paymentProviderInstanceId?: string | null;
    stripeEventId?: string | null;
    snapshot: StripeLedgerSnapshot;
  }): Prisma.StripePaymentLedgerUncheckedCreateInput {
    const snapshot = params.snapshot;
    return {
      orderId: params.orderId ?? null,
      paymentProviderInstanceId: params.paymentProviderInstanceId ?? null,
      stripeEventId: params.stripeEventId ?? null,
      transactionType: snapshot.transactionType,
      checkoutSessionId: snapshot.checkoutSessionId ?? null,
      subscriptionId: snapshot.subscriptionId ?? null,
      invoiceId: snapshot.invoiceId ?? null,
      paymentIntentId: snapshot.paymentIntentId ?? null,
      chargeId: snapshot.chargeId ?? null,
      refundId: snapshot.refundId ?? null,
      balanceTransactionId: snapshot.balanceTransactionId ?? null,
      payoutId: snapshot.payoutId ?? null,
      amountCents: snapshot.amountCents ?? null,
      feeCents: snapshot.feeCents ?? null,
      netCents: snapshot.netCents ?? null,
      currency: snapshot.currency ?? null,
      stripeStatus: snapshot.stripeStatus ?? null,
      customerEmail: snapshot.customerEmail ?? null,
      stripeCreatedAt: snapshot.stripeCreatedAt ?? null,
      availableOn: snapshot.availableOn ?? null,
      rawPayload: snapshot.rawPayload as Prisma.InputJsonValue | undefined,
    };
  }

  private formatCurrencyAmount(currency: string, amountCents: number): string {
    const code = currency.toUpperCase();
    const symbol = ({ CNY: '¥', USD: '$', SGD: 'S$', EUR: '€', GBP: '£' } as Record<string, string>)[code];
    return `${symbol ?? `${code} `}${(amountCents / 100).toFixed(2)}`;
  }

  private async createBundleOrderRecord(
    data: Parameters<PaymentRepository['createOrder']>[0],
    items: BundleOrderItemDraft[],
    limitPolicy: BundleLimitPolicy | null,
  ) {
    if (items.length === 0) {
      throw new BadRequestException('组合套餐配置异常：缺少订单明细');
    }
    if (!limitPolicy) {
      throw new BadRequestException('组合套餐配置异常：缺少限购策略');
    }
    return this.prisma.$transaction(async (db) => {
      await this.assertBundleReservationAvailable(db, limitPolicy);
      const order = await db.order.create({ data });
      await db.orderItem.createMany({
        data: items.map((item) => ({
          orderId: order.id,
          bundleSkuId: item.bundleSkuId,
          bundleSkuItemId: item.bundleSkuItemId,
          productId: item.productId,
          planId: item.planId,
          boosterPackId: item.boosterPackId,
          billingType: item.billingType,
          name: item.name,
          amountCents: item.amountCents,
          originalAmountCents: item.originalAmountCents,
          discountAmountCents: item.discountAmountCents,
          currency: item.currency,
          quantity: item.quantity,
          recurringInterval: item.recurringInterval,
          validityDays: item.validityDays,
        })),
      });
      return order;
    });
  }

  private async assertBundleReservationAvailable(
    tx: Prisma.TransactionClient,
    policy: BundleLimitPolicy,
  ): Promise<void> {
    if (policy.maxUsesPerUser <= 0 && policy.maxUsesTotal <= 0) return;

    await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`bundle-sku:${policy.bundleSkuId}`}))`;

    if (policy.maxUsesPerUser > 0) {
      const usedByUser = await tx.order.count({
        where: {
          userId: policy.userId,
          bundleSkuId: policy.bundleSkuId,
          status: { in: BUNDLE_RESERVED_ORDER_STATUSES },
        },
      });
      if (usedByUser >= policy.maxUsesPerUser) {
        throw new BadRequestException('已达到该组合套餐的购买次数限制');
      }
    }

    if (policy.maxUsesTotal > 0) {
      const usedTotal = await tx.order.count({
        where: {
          bundleSkuId: policy.bundleSkuId,
          status: { in: BUNDLE_RESERVED_ORDER_STATUSES },
        },
      });
      if (usedTotal >= policy.maxUsesTotal) {
        throw new BadRequestException('该组合套餐已售罄');
      }
    }
  }

  private async transitionOrderStatus(
    orderId: string,
    newStatus: OrderStatus,
    operator: string = 'system',
    detail?: string,
    expectedFromStatus?: OrderStatus,
  ) {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) throw new BadRequestException('订单不存在');

    const fromStatus = order.status;
    if (expectedFromStatus !== undefined && fromStatus !== expectedFromStatus) {
      throw new ConflictException('订单状态已被并发修改，请刷新后重试');
    }
    if (fromStatus === newStatus) {
      throw new ConflictException(`订单已处于 ${newStatus} 状态`);
    }
    if (!ORDER_STATUS_TRANSITIONS[fromStatus].has(newStatus)) {
      throw new BadRequestException(`订单状态不允许从 ${fromStatus} 切换到 ${newStatus}`);
    }
    const updateData: Prisma.OrderUpdateInput = { status: newStatus };

    if (newStatus === OrderStatus.PAID) updateData.paidAt = new Date();
    if (newStatus === OrderStatus.COMPLETED) updateData.completedAt = new Date();
    if (newStatus === OrderStatus.EXPIRED) updateData.expiredAt = new Date();
    if (newStatus === OrderStatus.CANCELLED) updateData.cancelledAt = new Date();
    if (
      newStatus === OrderStatus.REFUNDED ||
      newStatus === OrderStatus.REFUND_COMPENSATION_FAILED
    ) {
      updateData.refundedAt = new Date();
    }
    if (newStatus !== OrderStatus.FULFILLING) {
      updateData.fulfillmentAttemptId = null;
      updateData.fulfillmentClaimedAt = null;
    }
    if (newStatus !== OrderStatus.PENDING) {
      updateData.checkoutInitState = PaymentCheckoutInitState.TERMINAL;
      updateData.checkoutLeaseId = null;
      updateData.checkoutLeaseExpiresAt = null;
      updateData.checkoutContextEncrypted = null;
      updateData.checkoutPayUrlEncrypted = null;
      updateData.checkoutPayUrlExpiresAt = null;
    }

    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const updated = await tx.order.updateMany({
        where: { id: orderId, status: fromStatus },
        data: updateData,
      });
      if (updated.count !== 1) {
        throw new ConflictException('订单状态已被并发修改，请刷新后重试');
      }

      await tx.orderAuditLog.create({
        data: {
          orderId,
          fromStatus: fromStatus as string,
          toStatus: newStatus as string,
          operator,
          detail,
        },
      });
    });

    if (newStatus === OrderStatus.COMPLETED) {
      await this.growthEvents?.recordPurchase(orderId).catch((err) => {
        this.logger.warn(
          `purchase growth event failed orderId=${orderId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }
    if (newStatus === OrderStatus.REFUNDED) {
      await this.growthEvents?.recordRefund(orderId).catch((err) => {
        this.logger.warn(
          `refund growth event failed orderId=${orderId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      });
    }
  }

  /**
   * Stripe Webhook 事件处理
   *
   * Phase 3.2 Unit C.2: 入口处用 stripe_events 表 + unique 约束去重。
   * Stripe 失败重试（最多 3 次）时同一 event.id 会触发同一逻辑多次，
   * 这里在最早的位置短路，避免重复发放积分/扣款。
   */
  private assertStripeEventProviderInstance(
    orderId: string,
    expectedInstanceId: string | null | undefined,
    verifiedInstanceIds: readonly string[],
  ): void {
    const expected = expectedInstanceId?.trim() || null;
    const verified = verifiedInstanceIds.filter(Boolean);
    const matched = expected
      ? verified.includes(expected)
      : verified.length === 0;
    if (!matched) {
      throw new Error(
        `Stripe webhook 支付实例不匹配 order=${orderId} expected=${
          expected ?? 'legacy-env'
        } verified=${verified.join(',') || 'legacy-env'}`,
      );
    }
  }

  private assertStripeSubscriptionMetadataSubject(
    subscriptionId: string,
    metadata: {
      orderId?: string;
      userId?: string;
      tenantId?: string;
      productId?: string;
      planId?: string;
    } | undefined,
    order: {
      id: string;
      userId: string;
      tenantId: string;
      productId?: string | null;
      planId?: string | null;
      channel?: PayChannel | null;
      tradeNo?: string | null;
      checkoutContextEncrypted?: string | null;
      orderType: PrismaOrderType;
      product?: { billingMode: ProductBillingMode } | null;
      plan?: { product?: { billingMode: ProductBillingMode } | null } | null;
    },
  ): void {
    if (order.channel !== PayChannel.STRIPE) {
      throw new Error(
        `Stripe subscription metadata points to non-Stripe order=${order.id}`,
      );
    }
    if (metadata?.orderId?.trim() && metadata.orderId.trim() !== order.id) {
      throw new Error(`Stripe subscription metadata order mismatch order=${order.id}`);
    }
    const subjectChecks: Array<[string, string | undefined, string | null | undefined]> = [
      ['userId', metadata?.userId, order.userId],
      ['tenantId', metadata?.tenantId, order.tenantId],
      ['productId', metadata?.productId, order.productId],
      ['planId', metadata?.planId, order.planId],
    ];
    for (const [field, metadataValue, orderValue] of subjectChecks) {
      if (metadataValue?.trim() && metadataValue.trim() !== (orderValue ?? '')) {
        throw new Error(
          `Stripe subscription metadata ${field} mismatch order=${order.id}`,
        );
      }
    }
    if (
      order.tradeNo?.startsWith('sub_')
      && order.tradeNo !== subscriptionId
    ) {
      throw new Error(
        `Stripe subscription id mismatch order=${order.id} expected=${order.tradeNo} actual=${subscriptionId}`,
      );
    }
    if (this.expectedStripeCheckoutMode(order) !== 'subscription') {
      throw new Error(
        `Stripe subscription metadata points to non-subscription checkout order=${order.id}`,
      );
    }
  }

  private stripeObjectId(value: unknown): string | null {
    if (typeof value === 'string') {
      return value.trim() || null;
    }
    if (value && typeof value === 'object' && 'id' in value) {
      const id = (value as { id?: unknown }).id;
      return typeof id === 'string' ? id.trim() || null : null;
    }
    return null;
  }

  private async acquireStripeSubscriptionEventLock(
    orderId: string,
  ): Promise<{ key: string; token: string }> {
    const key = `stripe:subscription-event:${orderId}`;
    const token = randomUUID();
    const acquired = await this.redis.set(
      key,
      token,
      'EX',
      STRIPE_SUBSCRIPTION_EVENT_LOCK_SECONDS,
      'NX',
    );
    if (!acquired) {
      throw new Error(
        `Stripe subscription event is concurrently processing order=${orderId}`,
      );
    }
    return { key, token };
  }

  private async reportMissingStripeActivationReceipt(input: {
    orderId: string;
    userId: string;
    subscriptionId: string;
    productId: string | null;
    planId: string;
    activationFamily: string;
  }): Promise<never> {
    const message =
      `Stripe subscription ${input.subscriptionId} ended, but order ${input.orderId} has no matching active activation receipt; broad cancellation is forbidden`;
    this.logger.error(message);
    await this.alertEvents
      ?.createAlert({
        category: 'PAYMENT',
        severity: 'CRITICAL',
        title: 'Stripe订阅取消缺少精确权益凭据',
        message: `订单 ${input.orderId} 已写入 provider tombstone，但找不到该订单 activation family，需人工对账；系统未执行 tenant/plan 级宽泛关闭`,
        sourceType: 'order',
        sourceId: input.orderId,
        userId: input.userId,
        context: {
          subscriptionId: input.subscriptionId,
          productId: input.productId,
          planId: input.planId,
          activationFamily: input.activationFamily,
        },
      })
      .catch(() => {});
    throw new Error(message);
  }

  private expectedStripeCheckoutMode(order: {
    orderType: PrismaOrderType;
    checkoutContextEncrypted?: string | null;
    product?: { billingMode: ProductBillingMode } | null;
    plan?: { product?: { billingMode: ProductBillingMode } | null } | null;
  }): 'payment' | 'subscription' {
    if (order.checkoutContextEncrypted) {
      const context = this.decryptCheckoutContext(order.checkoutContextEncrypted);
      if (context.channel !== 'STRIPE' || !context.stripe) {
        throw new Error('Stripe checkout callback 与持久化恢复上下文不一致');
      }
      return context.stripe.mode === 'payment' ? 'payment' : 'subscription';
    }

    // Legacy orders created before durable recovery can still be validated
    // from immutable order semantics. CODING_PLAN is always one-time payment.
    if (order.orderType === PrismaOrderType.BUNDLE) return 'subscription';
    if (
      order.orderType === PrismaOrderType.RECHARGE
      || order.orderType === PrismaOrderType.BOOSTER_PACK
    ) {
      return 'payment';
    }
    const billingMode =
      order.product?.billingMode
      ?? order.plan?.product?.billingMode;
    return billingMode === ProductBillingMode.CODING_PLAN
      ? 'payment'
      : 'subscription';
  }

  async handleStripeEvent(event: {
    id: string;
    type: string;
    data: { object: unknown };
  }, verifiedPaymentProviderInstanceIds: readonly string[] = []): Promise<void> {
    // Phase 3.2 Unit C.2: Stripe event 去重
    try {
      await this.prisma.stripeEvent.create({
        data: {
          id: event.id,
          type: event.type,
          payload: event as unknown as Prisma.JsonObject,
        },
      });
    } catch (err: unknown) {
      if (hasPrismaErrorCode(err, 'P2002')) {
        const existing = await this.prisma.stripeEvent.findUnique({
          where: { id: event.id },
          select: { processedAt: true },
        });
        if (existing?.processedAt) {
          this.logger.log(
            `Stripe 事件重放跳过: id=${event.id} type=${event.type}`,
          );
          return;
        }
        this.logger.warn(
          `Stripe 事件未完成，允许重试处理: id=${event.id} type=${event.type}`,
        );
      } else {
        throw err;
      }
    }

    switch (event.type) {
      case 'checkout.session.completed': {
        const session = event.data.object as {
          id?: string;
          metadata?: { orderId?: string };
          mode?: string;
          subscription?: unknown;
          amount_total?: number;
          currency?: string;
          payment_status?: string;
        };
        const orderId = session.metadata?.orderId;
        if (!orderId) {
          this.logger.warn('Stripe checkout.session.completed: missing orderId in metadata');
          break;
        }
        const eventLock = await this.acquireStripeSubscriptionEventLock(orderId);
        try {
          const order = await this.prisma.order.findUnique({
          where: { id: orderId },
          select: {
            paymentProviderInstanceId: true,
            checkoutProviderReference: true,
            checkoutContextEncrypted: true,
            tradeNo: true,
            status: true,
            providerSubscriptionEndedAt: true,
            amountCents: true,
            orderType: true,
            product: { select: { billingMode: true } },
            plan: {
              select: {
                product: { select: { billingMode: true } },
              },
            },
          },
          });
          if (!order) {
            throw new Error(`Stripe checkout callback order not found order=${orderId}`);
          }
          this.assertStripeEventProviderInstance(
            orderId,
            order.paymentProviderInstanceId,
            verifiedPaymentProviderInstanceIds,
          );
        const checkoutSessionId = session.id?.trim();
        const boundCheckoutReference =
          order.checkoutProviderReference?.trim()
          || (order.status === OrderStatus.PENDING
            ? order.tradeNo?.trim()
            : null);
        if (!checkoutSessionId || !boundCheckoutReference) {
          throw new Error(
            `Stripe checkout callback 缺少本地或渠道 Session 绑定 order=${orderId}`,
          );
        }
        if (checkoutSessionId !== boundCheckoutReference) {
          throw new Error(
            `Stripe checkout Session 与订单不匹配 order=${orderId}`,
          );
        }
        const expectedMode = this.expectedStripeCheckoutMode(order);
        const subscriptionId = this.stripeObjectId(session.subscription);
        if (
          session.mode !== expectedMode
          || (expectedMode === 'subscription' && !subscriptionId)
          || (expectedMode === 'payment' && subscriptionId)
        ) {
          throw new Error(
            `Stripe checkout mode 与订单语义不匹配 order=${orderId}`,
          );
        }
        const normalizedCurrency = session.currency?.trim().toLowerCase();
        const paidAmountCents = session.amount_total;
        const paymentStatusAccepted =
          session.payment_status === 'paid'
          || (
            session.payment_status === 'no_payment_required'
            && order.amountCents === 0
            && paidAmountCents === 0
          );
        if (
          !paymentStatusAccepted
          || typeof paidAmountCents !== 'number'
          || !Number.isSafeInteger(paidAmountCents)
          || paidAmountCents < 0
          || !normalizedCurrency
        ) {
          throw new Error(
            `Stripe checkout callback 缺少已支付状态、有效金额或币种 order=${orderId}`,
          );
        }

        // 确定 tradeNo：订阅模式用 subscription ID（后续续费/取消需要），
        // 一次性支付用 session ID（退款需要通过 session 找 payment_intent）
        let stripeTradeNo: string;
        if (expectedMode === 'subscription') {
          stripeTradeNo = subscriptionId!;
        } else {
          stripeTradeNo = checkoutSessionId;
        }

          const ledgerRecorded = await this.recordStripeCheckoutLedger({
            orderId,
            checkoutSessionId,
            paymentProviderInstanceId:
              order.paymentProviderInstanceId ?? null,
            stripeEventId: event.id,
          });
          if (expectedMode === 'subscription' && !ledgerRecorded) {
            throw new Error(
              `Stripe subscription checkout ledger is not durable order=${orderId}`,
            );
          }
          const handled = await this.handlePaymentCallback(stripeTradeNo, orderId, 'STRIPE', {
            paidAmountCents,
            paidCurrency: normalizedCurrency,
            paymentStatus: session.payment_status,
            paymentProviderInstanceId: order.paymentProviderInstanceId ?? undefined,
          });
          if (!handled) {
            throw new Error(`Stripe checkout callback not accepted order=${orderId}`);
          }
        } finally {
          await this.releaseRedisLock(eventLock.key, eventLock.token);
        }
        break;
      }

      case 'invoice.paid': {
        await this.handleStripeRenewalInvoice(
          event,
          verifiedPaymentProviderInstanceIds,
        );
        break;
      }

      case 'customer.subscription.deleted': {
        const subscription = event.data.object as {
          id?: string;
          metadata?: {
            orderId?: string;
            userId?: string;
            tenantId?: string;
            productId?: string;
            planId?: string;
          };
        };
        if (!subscription.id) break;

        const metadataOrderId = subscription.metadata?.orderId?.trim() || null;
        const locatedOrder = metadataOrderId
          ? await this.prisma.order.findUnique({
              where: { id: metadataOrderId },
              select: { id: true },
            })
          : await this.prisma.order.findFirst({
              where: { tradeNo: subscription.id },
              select: { id: true },
            });
        if (!locatedOrder) {
          if (metadataOrderId) {
            throw new Error(
              `Stripe subscription deletion order not found order=${metadataOrderId}`,
            );
          }
          break;
        }

        const eventLock = await this.acquireStripeSubscriptionEventLock(locatedOrder.id);
        try {
          const order = await this.prisma.order.findUnique({
          where: { id: locatedOrder.id },
          include: {
            items: {
              where: { billingType: BundleItemBillingType.SUBSCRIPTION },
            },
            product: { select: { billingMode: true } },
            plan: {
              include: {
                product: { select: { billingMode: true } },
              },
            },
          },
        });
          if (!order) {
            throw new Error(
              `Stripe subscription deletion order disappeared order=${locatedOrder.id}`,
            );
          }
          this.assertStripeSubscriptionMetadataSubject(
            subscription.id,
            subscription.metadata,
            order,
          );
          this.assertStripeEventProviderInstance(
            order.id,
            order.paymentProviderInstanceId,
            verifiedPaymentProviderInstanceIds,
          );
          await this.prisma.order.updateMany({
            where: {
              id: order.id,
              providerSubscriptionEndedAt: null,
            },
            data: {
              providerSubscriptionEndedAt: new Date(),
            },
          });
          this.logger.log(
            `Stripe 订阅取消: order=${order.id}, subscription=${subscription.id}`,
          );
          // A deletion that precedes checkout completion has no local
          // entitlement belonging to this order. The tombstone alone blocks
          // fulfillment; broad tenant/plan cancellation here could otherwise
          // close an older, unrelated active subscription.
          const localEntitlementStatuses = new Set<OrderStatus>([
            OrderStatus.PAID,
            OrderStatus.FULFILLING,
            OrderStatus.COMPLETED,
            OrderStatus.REFUNDING,
            OrderStatus.REFUND_FAILED,
            OrderStatus.REFUND_COMPENSATION_FAILED,
            OrderStatus.REFUNDED,
          ]);
          const mayHaveLocalEntitlement =
            localEntitlementStatuses.has(order.status);
          if (mayHaveLocalEntitlement && order.orderType === PrismaOrderType.BUNDLE) {
            for (const item of order.items) {
              if (!item.planId || !item.productId) continue;
              if (!this.subscriptionLifecycle) {
                throw new Error(
                  'SubscriptionLifecycleService is required for Stripe cancellation',
                );
              }
              const closed = await this.subscriptionLifecycle.closeActivationFamily({
                initialActivationIdempotencyKey:
                  `bundle:${order.id}:item:${item.id}:activation`,
                renewalActivationIdempotencyPrefix:
                  `stripe-renewal:${order.id}:`,
                userId: order.userId,
                tenantId: order.tenantId,
                productId: item.productId,
                planId: item.planId,
                endedAt: new Date(),
                terminationReason: 'stripe_subscription_canceled',
              });
              if (!closed) {
                await this.reportMissingStripeActivationReceipt({
                  orderId: order.id,
                  userId: order.userId,
                  subscriptionId: subscription.id,
                  productId: item.productId,
                  planId: item.planId,
                  activationFamily:
                    `bundle:${order.id}:item:${item.id}:activation`,
                });
              }
            }
          } else if (mayHaveLocalEntitlement && order.planId) {
            const productId = order.plan?.productId;
            const subscriptionLifecycle = this.subscriptionLifecycle;
            if (!productId || !subscriptionLifecycle) {
              await this.reportMissingStripeActivationReceipt({
                orderId: order.id,
                userId: order.userId,
                subscriptionId: subscription.id,
                productId: productId ?? null,
                planId: order.planId,
                activationFamily: `checkout:${order.id}:activation`,
              });
              throw new Error('unreachable');
            }
            const closed = await subscriptionLifecycle.closeActivationFamily({
              initialActivationIdempotencyKey:
                `checkout:${order.id}:activation`,
              renewalActivationIdempotencyPrefix:
                `stripe-renewal:${order.id}:`,
              userId: order.userId,
              tenantId: order.tenantId,
              productId: productId!,
              planId: order.planId,
              endedAt: new Date(),
              terminationReason: 'stripe_subscription_canceled',
            });
            if (!closed) {
              if (
                order.status === OrderStatus.FULFILLING
                && !await this.hasCompleteStripeCheckoutFulfillmentEffects(
                  order,
                )
              ) {
                break;
              }
              await this.reportMissingStripeActivationReceipt({
                orderId: order.id,
                userId: order.userId,
                subscriptionId: subscription.id,
                productId: productId ?? null,
                planId: order.planId,
                activationFamily: `checkout:${order.id}:activation`,
              });
            }
          }
        } finally {
          await this.releaseRedisLock(eventLock.key, eventLock.token);
        }
        break;
      }

      default:
        this.logger.debug(`Stripe event ignored: ${event.type}`);
    }

    try {
      await this.prisma.stripeEvent.update({
        where: { id: event.id },
        data: { processedAt: new Date() },
      });
    } catch (e) {
      this.logger.warn(
        `stripeEvent.update 失败 id=${event.id}: ${(e as Error).message}`,
      );
    }
  }

  private async handleStripeRenewalInvoice(
    event: {
      id: string;
      type: string;
      data: { object: unknown };
    },
    verifiedPaymentProviderInstanceIds: readonly string[],
  ): Promise<void> {
    const invoice = event.data.object as {
      id?: string;
      subscription?: unknown;
      billing_reason?: string;
      currency?: string;
      status?: string;
      paid?: boolean;
      amount_paid?: number;
      amount_remaining?: number;
      total?: number;
      collection_method?: string;
      lines?: {
        has_more?: boolean;
        data?: Array<{
          id?: string;
          type?: string;
          amount?: number;
          currency?: string;
          quantity?: number;
          subscription?: unknown;
          parent?: {
            type?: string;
            subscription_item_details?: {
              subscription?: unknown;
            };
          };
          price?: {
            type?: string;
            currency?: string;
            unit_amount?: number | null;
            recurring?: {
              interval?: string;
              interval_count?: number;
            } | null;
          } | null;
        }>;
      };
    };
    if (invoice.billing_reason !== 'subscription_cycle') return;
    const subscriptionId = this.stripeObjectId(invoice.subscription);
    if (!subscriptionId) return;

    const locatedOrder = await this.prisma.order.findFirst({
      where: { tradeNo: subscriptionId },
      select: { id: true },
    });
    if (!locatedOrder) return;

    const eventLock = await this.acquireStripeSubscriptionEventLock(locatedOrder.id);
    try {
      const order = await this.prisma.order.findFirst({
        where: {
          id: locatedOrder.id,
          tradeNo: subscriptionId,
          status: OrderStatus.COMPLETED,
          providerSubscriptionEndedAt: null,
        },
        include: { plan: true },
      });
      // A serialized subscription.deleted may have tombstoned the order after
      // the initial lookup. In that case renewal is deliberately ignored.
      if (!order) return;

      this.assertStripeEventProviderInstance(
        order.id,
        order.paymentProviderInstanceId,
        verifiedPaymentProviderInstanceIds,
      );
      await this.rejectStripeRenewalInvoice(
        order,
        subscriptionId,
        invoice.id,
        order.orderType === PrismaOrderType.BUNDLE
          ? 'bundle renewal lacks durable Stripe subscription-item/price binding'
          : 'automatic renewal is disabled until invoice period bounds and a durable monotonic period cursor are persisted',
      );
    } finally {
      await this.releaseRedisLock(eventLock.key, eventLock.token);
    }
  }

  private async rejectStripeRenewalInvoice(
    order: { id: string; userId: string },
    subscriptionId: string,
    invoiceId: string | undefined,
    reason: string,
  ): Promise<never> {
    this.logger.error(
      `Stripe renewal rejected: order=${order.id} subscription=${subscriptionId} invoice=${invoiceId ?? 'missing'} reason=${reason}`,
    );
    await this.alertEvents
      ?.createAlert({
        category: 'PAYMENT',
        severity: 'CRITICAL',
        title: 'Stripe续费需人工处理',
        message: `订单 ${order.id} 的 Stripe 续费未发放权益且事件保持未完成；需人工核对账期顺序与本地权益`,
        sourceType: 'order',
        sourceId: order.id,
        userId: order.userId,
        context: {
          subscriptionId,
          invoiceId: invoiceId ?? null,
          reason,
        },
      })
      .catch(() => {});
    throw new Error(
      `Stripe renewal rejected order=${order.id}: ${reason}`,
    );
  }

  /**
   * 支付回调处理（微信/支付宝/Stripe）
   * 生产环境需实现验签逻辑
   */
  async handlePaymentCallback(
    tradeNo: string,
    orderId: string,
    channel: 'WECHAT' | 'ALIPAY' | 'STRIPE',
    opts: {
      paidAmountCents?: number;
      paidCurrency?: string;
      paymentStatus?: string;
      paymentProviderInstanceId?: string;
      verifiedPaymentProviderInstanceIds?: readonly string[];
    } = {},
  ): Promise<boolean> {
    const order = await this.paymentRepository.findOrderById(orderId);

    if (!order) {
      this.logger.warn(`回调订单不存在: ${orderId}`);
      return false;
    }

    if (order.channel !== channel) {
      this.logger.error(
        `支付渠道不一致: order=${orderId} expected=${order.channel ?? 'null'} actual=${channel}`,
      );
      return false;
    }

    const paidCurrency = opts.paidCurrency?.trim().toLowerCase();
    if (paidCurrency && paidCurrency !== order.currency.toLowerCase()) {
      this.logger.error(
        `支付币种不一致: order=${orderId} expected=${order.currency} actual=${paidCurrency} channel=${channel}`,
      );
      return false;
    }

    const orderProviderInstanceId = order.paymentProviderInstanceId?.trim() || null;
    const verifiedProviderInstanceIds = opts.verifiedPaymentProviderInstanceIds
      ?.map((id) => id.trim())
      .filter(Boolean);
    const callbackProviderInstanceId = opts.paymentProviderInstanceId?.trim() || null;
    const providerMatches = verifiedProviderInstanceIds
      ? (
          orderProviderInstanceId
            ? verifiedProviderInstanceIds.includes(orderProviderInstanceId)
            : verifiedProviderInstanceIds.length === 0
        )
      : orderProviderInstanceId === callbackProviderInstanceId;
    if (!providerMatches) {
      this.logger.error(
        `支付实例不一致: order=${orderId} expected=${orderProviderInstanceId ?? 'legacy-env'} actual=${
          verifiedProviderInstanceIds?.join(',') || callbackProviderInstanceId || 'legacy-env'
        } channel=${channel}`,
      );
      return false;
    }

    const stripeTombstonedBeforeActivation =
      channel === 'STRIPE'
      && Boolean(order.providerSubscriptionEndedAt)
      && (
        order.status === OrderStatus.PENDING
        || order.status === OrderStatus.PAID
        || order.status === OrderStatus.FULFILLING
      );

    // 幂等检查。Stripe 已结束且尚未激活的订阅必须先走 late-paid
    // reconciliation，不能把 PAID 重放误送回履约。
    if (
      !stripeTombstonedBeforeActivation
      && (
        order.status === OrderStatus.PAID
        || order.status === OrderStatus.FULFILLING
      )
    ) {
      this.logger.log(`订单已处理（幂等）: ${orderId}`);
      await this.fulfillOrder(orderId);
      return true;
    }
    if (order.status === OrderStatus.COMPLETED) {
      this.logger.log(`订单已处理（幂等）: ${orderId}`);
      return true;
    }

    const paymentStatusAccepted =
      !opts.paymentStatus
      || opts.paymentStatus === 'paid'
      || (
        channel === 'STRIPE'
        && opts.paymentStatus === 'no_payment_required'
        && order.amountCents === 0
        && opts.paidAmountCents === 0
      );
    if (!paymentStatusAccepted) {
      this.logger.warn(
        `支付状态未完成: order=${orderId} channel=${channel} status=${opts.paymentStatus}`,
      );
      return false;
    }

    if ((channel === 'WECHAT' || channel === 'ALIPAY') && opts.paidAmountCents == null) {
      this.logger.error(`支付回调缺少金额: order=${orderId} channel=${channel}`);
      return false;
    }

    if (opts.paidAmountCents != null && opts.paidAmountCents !== order.amountCents) {
      this.logger.error(
        `支付金额不一致: order=${orderId} expected=${order.amountCents} actual=${opts.paidAmountCents} channel=${channel}`,
      );
      return false;
    }

    if (stripeTombstonedBeforeActivation) {
      await this.handleTombstonedStripeCheckoutPayment(order, tradeNo, opts);
      return true;
    }

    if (
      order.status === OrderStatus.EXPIRED
      || order.status === OrderStatus.CANCELLED
    ) {
      await this.recordTerminalOrderPaymentCallback(order, tradeNo, channel, opts);
      return true;
    }

    if (order.status !== OrderStatus.PENDING) {
      this.logger.warn(`订单状态异常: ${orderId} status=${order.status}`);
      return false;
    }

    const claim = await this.prisma.order.updateMany({
      where: {
        id: orderId,
        status: OrderStatus.PENDING,
        channel: channel as PayChannel,
        ...(channel === 'STRIPE'
          ? { providerSubscriptionEndedAt: null }
          : {}),
      },
      data: {
        status: OrderStatus.PAID,
        paidAt: new Date(),
        tradeNo,
        channel: channel as PayChannel,
        checkoutInitState: PaymentCheckoutInitState.TERMINAL,
        checkoutLeaseId: null,
        checkoutLeaseExpiresAt: null,
        checkoutContextEncrypted: null,
        checkoutPayUrlEncrypted: null,
        checkoutPayUrlExpiresAt: null,
        ...(opts.paymentProviderInstanceId ? { paymentProviderInstanceId: opts.paymentProviderInstanceId } : {}),
      },
    });
    if (claim.count !== 1) {
      const latest = await this.paymentRepository.findOrderById(orderId);
      if (latest && latest.channel !== channel) {
        this.logger.error(
          `支付渠道并发变更: order=${orderId} expected=${channel} actual=${latest.channel ?? 'null'}`,
        );
        return false;
      }
      if (
        latest?.status === OrderStatus.PAID ||
        latest?.status === OrderStatus.FULFILLING ||
        latest?.status === OrderStatus.COMPLETED
      ) {
        if (
          channel === 'STRIPE'
          && latest.providerSubscriptionEndedAt
          && latest.status === OrderStatus.PAID
        ) {
          await this.handleTombstonedStripeCheckoutPayment(latest, tradeNo, opts);
          return true;
        }
        this.logger.log(`订单已被并发回调处理（幂等）: ${orderId}`);
        await this.fulfillOrder(orderId);
        return true;
      }
      if (
        latest?.status === OrderStatus.EXPIRED
        || latest?.status === OrderStatus.CANCELLED
      ) {
        await this.recordTerminalOrderPaymentCallback(latest, tradeNo, channel, opts);
        return true;
      }
      this.logger.warn(`订单支付确认竞争失败: ${orderId}`);
      return false;
    }

    await this.prisma.orderAuditLog.create({
      data: {
        orderId,
        fromStatus: order.status,
        toStatus: OrderStatus.PAID,
        operator: `callback:${channel}`,
        detail: tradeNo,
      },
    });
    await this.fulfillOrder(orderId);

    return true;
  }

  private async handleTombstonedStripeCheckoutPayment(
    order: PrismaOrder,
    subscriptionId: string,
    opts: {
      paidAmountCents?: number;
      paidCurrency?: string;
      paymentStatus?: string;
      paymentProviderInstanceId?: string;
      verifiedPaymentProviderInstanceIds?: readonly string[];
    },
  ): Promise<void> {
    if (!order.providerSubscriptionEndedAt) {
      throw new Error(
        `Stripe late-paid reconciliation requires provider tombstone: ${order.id}`,
      );
    }
    if (
      order.amountCents === 0
      && opts.paidAmountCents === 0
      && opts.paymentStatus === 'no_payment_required'
    ) {
      await this.finalizeZeroValueTombstonedStripeCheckout(
        order,
        subscriptionId,
      );
      return;
    }

    if (order.status === OrderStatus.PENDING) {
      const claimed = await this.prisma.order.updateMany({
        where: {
          id: order.id,
          status: OrderStatus.PENDING,
          channel: PayChannel.STRIPE,
          providerSubscriptionEndedAt: { not: null },
        },
        data: {
          status: OrderStatus.PAID,
          paidAt: new Date(),
          tradeNo: subscriptionId,
          checkoutInitState: PaymentCheckoutInitState.TERMINAL,
          checkoutLeaseId: null,
          checkoutLeaseExpiresAt: null,
          checkoutContextEncrypted: null,
          checkoutPayUrlEncrypted: null,
          checkoutPayUrlExpiresAt: null,
        },
      });
      if (claimed.count !== 1) {
        const latest = await this.prisma.order.findUnique({
          where: { id: order.id },
          select: { status: true, providerSubscriptionEndedAt: true },
        });
        if (
          latest?.providerSubscriptionEndedAt
          && (
            latest.status === OrderStatus.REFUNDING
            || latest.status === OrderStatus.REFUND_FAILED
            || latest.status === OrderStatus.REFUND_COMPENSATION_FAILED
            || latest.status === OrderStatus.REFUNDED
          )
        ) {
          return;
        }
        if (
          !latest?.providerSubscriptionEndedAt
          || latest.status !== OrderStatus.PAID
        ) {
          throw new Error(
            `Stripe tombstoned checkout payment claim failed order=${order.id}`,
          );
        }
      }
      if (claimed.count === 1) {
        await this.prisma.orderAuditLog.create({
          data: {
            orderId: order.id,
            fromStatus: OrderStatus.PENDING,
            toStatus: OrderStatus.PAID,
            operator: 'callback:STRIPE',
            detail: `late-paid-after-subscription-ended:${subscriptionId}`,
          },
        });
      }
    } else if (
      order.status !== OrderStatus.PAID
      && order.status !== OrderStatus.FULFILLING
    ) {
      return;
    }

    const skipEntitlementCompensation =
      order.status !== OrderStatus.FULFILLING
      || !await this.hasCompleteStripeCheckoutFulfillmentEffects(order);
    await this.alertEvents
      ?.createAlert({
        category: 'PAYMENT',
        severity: 'CRITICAL',
        title: 'Stripe已取消订阅收到迟到支付',
        message: `订单 ${order.id} 的 Stripe 订阅已结束后才收到 checkout 完成；禁止履约并自动原路退款`,
        sourceType: 'order',
        sourceId: order.id,
        userId: order.userId,
        context: {
          subscriptionId,
          providerSubscriptionEndedAt:
            order.providerSubscriptionEndedAt.toISOString(),
          paidAmountCents: opts.paidAmountCents ?? null,
          paidCurrency: opts.paidCurrency ?? null,
          paymentProviderInstanceId:
            opts.paymentProviderInstanceId
            ?? order.paymentProviderInstanceId
            ?? null,
          skipEntitlementCompensation,
        },
      })
      .catch(() => {});

    try {
      await this.refundOrder(
        order.id,
        'Stripe 订阅先于 checkout 完成被取消，迟到支付自动退款',
        undefined,
        { skipEntitlementCompensation },
      );
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `Stripe tombstoned checkout 自动退款未完成: order=${order.id} error=${message}`,
      );
      await this.alertEvents
        ?.createAlert({
          category: 'PAYMENT',
          severity: 'CRITICAL',
          title: 'Stripe迟到支付自动退款未完成',
          message: `订单 ${order.id} 已禁止履约，但自动退款未完成；已保留退款失败/补偿状态供重试或人工对账`,
          sourceType: 'order',
          sourceId: order.id,
          userId: order.userId,
          context: {
            subscriptionId,
            error: message,
          },
        })
        .catch(() => {});
    }
  }

  private async hasCompleteStripeCheckoutFulfillmentEffects(
    order: PrismaOrder,
  ): Promise<boolean> {
    const persisted = await this.prisma.order.findUnique({
      where: { id: order.id },
      select: {
        userId: true,
        tenantId: true,
        planId: true,
        plan: {
          select: {
            productId: true,
            monthlyCredits: true,
          },
        },
      },
    });
    if (!persisted?.planId || !persisted.plan?.productId) {
      throw new Error(
        `Stripe tombstoned fulfillment order binding missing: ${order.id}`,
      );
    }
    const [period, grant] = await Promise.all([
      this.prisma.subscriptionPeriod.findUnique({
        where: {
          activationIdempotencyKey:
            `checkout:${order.id}:activation`,
        },
        select: { id: true },
      }),
      persisted.plan.monthlyCredits > 0
        ? this.prisma.creditTransaction.findUnique({
            where: { idempotencyKey: `checkout:${order.id}` },
            select: { id: true },
          })
        : Promise.resolve(null),
    ]);
    const requiresGrant = persisted.plan.monthlyCredits > 0;
    if (period && (!requiresGrant || grant)) return true;
    if (!period && !grant) return false;
    throw new Error(
      `Stripe tombstoned fulfillment effects are partial/ambiguous: ${order.id}`,
    );
  }

  private async finalizeZeroValueTombstonedStripeCheckout(
    order: PrismaOrder,
    subscriptionId: string,
  ): Promise<void> {
    const fromStatus = order.status;
    const cancelledAt = new Date();
    const detail =
      `zero-value Stripe subscription ended before checkout completion:${subscriptionId}`;
    const claimed = await this.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const updated = await tx.order.updateMany({
          where: {
            id: order.id,
            status: fromStatus,
            channel: PayChannel.STRIPE,
            amountCents: 0,
            providerSubscriptionEndedAt: { not: null },
          },
          data: {
            status: OrderStatus.CANCELLED,
            cancelledAt,
            cancelReason:
              'Stripe 零金额订阅先于 checkout 完成结束，未产生渠道退款',
            tradeNo: subscriptionId,
            checkoutInitState: PaymentCheckoutInitState.TERMINAL,
            checkoutLeaseId: null,
            checkoutLeaseExpiresAt: null,
            checkoutContextEncrypted: null,
            checkoutPayUrlEncrypted: null,
            checkoutPayUrlExpiresAt: null,
          },
        });
        if (updated.count !== 1) return false;
        await tx.orderAuditLog.create({
          data: {
            orderId: order.id,
            fromStatus,
            toStatus: OrderStatus.CANCELLED,
            operator: 'callback:STRIPE',
            detail,
          },
        });
        return true;
      },
    );
    if (!claimed) {
      const latest = await this.prisma.order.findUnique({
        where: { id: order.id },
        select: { status: true, providerSubscriptionEndedAt: true },
      });
      if (
        latest?.providerSubscriptionEndedAt
        && (
          latest.status === OrderStatus.CANCELLED
          || latest.status === OrderStatus.REFUNDED
        )
      ) {
        return;
      }
      throw new Error(
        `Stripe zero-value tombstoned checkout claim failed order=${order.id}`,
      );
    }

    await this.alertEvents
      ?.createAlert({
        category: 'PAYMENT',
        severity: 'CRITICAL',
        title: 'Stripe零金额订阅在结账前结束',
        message: `订单 ${order.id} 未产生渠道扣款，已原子关闭为 CANCELLED；未调用退款接口且未发放权益`,
        sourceType: 'order',
        sourceId: order.id,
        userId: order.userId,
        context: {
          subscriptionId,
          providerSubscriptionEndedAt:
            order.providerSubscriptionEndedAt?.toISOString() ?? null,
        },
      })
      .catch(() => {});
  }

  private async recordTerminalOrderPaymentCallback(
    order: PrismaOrder,
    tradeNo: string,
    channel: 'WECHAT' | 'ALIPAY' | 'STRIPE',
    opts: {
      paidAmountCents?: number;
      paidCurrency?: string;
      paymentStatus?: string;
      paymentProviderInstanceId?: string;
      verifiedPaymentProviderInstanceIds?: readonly string[];
    },
  ): Promise<void> {
    if (
      order.status !== OrderStatus.EXPIRED
      && order.status !== OrderStatus.CANCELLED
    ) {
      throw new Error(
        `late-payment reconciliation requires a terminal unpaid order: ${order.id} status=${order.status}`,
      );
    }
    const terminalLabel = order.status === OrderStatus.EXPIRED ? '过期' : '已取消';
    const terminalDescription =
      order.status === OrderStatus.EXPIRED ? '已过期' : '已取消';
    const title = `${terminalLabel}订单收到支付成功回调`;
    const message =
      `订单 ${order.id} ${terminalDescription}但收到支付成功回调，订单未转为 PAID，需人工退款或对账处理`;
    const reconciliationId = `payment-late-${createHash('sha256')
      .update(`${order.id}\u0000${order.status}\u0000${channel}\u0000${tradeNo}`)
      .digest('hex')}`;
    const context = JSON.stringify({
      reconciliationType: 'LATE_PAYMENT_ON_TERMINAL_ORDER',
      terminalStatus: order.status,
      orderType: order.orderType,
      channel,
      orderChannel: order.channel,
      amountCents: order.amountCents,
      paidAmountCents: opts.paidAmountCents ?? null,
      paidCurrency: opts.paidCurrency ?? null,
      paymentStatus: opts.paymentStatus ?? null,
      tradeNo,
      paymentProviderInstanceId:
        opts.paymentProviderInstanceId ?? order.paymentProviderInstanceId ?? null,
      verifiedPaymentProviderInstanceIds:
        opts.verifiedPaymentProviderInstanceIds ?? null,
    });

    this.logger.error(
      `${title}: order=${order.id} tradeNo=${tradeNo} channel=${channel}`,
    );
    // 渠道只有在这条幂等、可运营处理的 CRITICAL 记录持久化后才会收到成功
    // ACK。数据库瞬时失败由渠道重试恢复，不能用 best-effort AlertEventService
    // 吞掉后仍返回成功，否则会永久丢失已收款但未履约的财务事实。
    await this.prisma.alertEvent.upsert({
      where: { id: reconciliationId },
      update: {
        category: 'PAYMENT',
        severity: 'CRITICAL',
        title,
        message,
        sourceType: 'order',
        sourceId: order.id,
        userId: order.userId,
        context,
      },
      create: {
        id: reconciliationId,
        category: 'PAYMENT',
        severity: 'CRITICAL',
        title,
        message,
        sourceType: 'order',
        sourceId: order.id,
        userId: order.userId,
        context,
      },
    });
  }

  /**
   * 订单发放逻辑（支付成功后执行）
   * SUBSCRIPTION: 激活订阅 + 发放积分配额
   * BOOSTER_PACK: 充入加油包积分
   * RECHARGE: 充值用户余额
   */
  private async fulfillOrder(orderId: string): Promise<void> {
    const lockKey = `fulfill:${orderId}`;
    const locked = await this.redis.set(lockKey, '1', 'EX', FULFILLMENT_LOCK_SECONDS, 'NX');
    if (!locked) {
      return;
    }

    try {
      const order = await this.claimOrderForFulfillment(orderId);
      if (!order) {
        return;
      }

      try {
        if (order.orderType === 'BUNDLE') {
          await this.fulfillBundleOrder(order.id, order.userId, order.tenantId);
        } else if (order.orderType === 'BOOSTER_PACK' && order.boosterPackId) {
          const pack = await this.prisma.boosterPack.findUnique({
            where: { id: order.boosterPackId },
            include: { product: { select: { id: true } } },
          });
          if (pack) {
            // 找到用户对应产品的 active subscription
            const sub = pack.productId
              ? await this.subscriptionResolver.resolve(order.userId, pack.productId, { tenantId: order.tenantId })
              : null;
            const subscriptionId = sub?.subscriptionId ?? '';
            await this.creditService.addBonus(
              subscriptionId,
              order.userId,
              pack.creditsAmount,
              `booster:${pack.id}`,
              { idempotencyKey: `booster:${order.id}` },
            );
            // fire-and-forget: 通知 SaaS 端清除积分缓存
            this.notifyCreditChangedByUserId(order.userId, pack.productId).catch(() => {});
          } else {
            this.logger.warn(`加油包不存在: ${order.boosterPackId}`);
          }
        } else if (order.orderType === 'SUBSCRIPTION' && order.planId) {
          const plan = await this.prisma.plan.findUnique({
            where: { id: order.planId },
            include: { product: { select: { billingMode: true, codingPlanFulfillmentMode: true } } },
          });
          if (plan) {
            await this.fulfillPlanPurchase({
              orderId: order.id,
              userId: order.userId,
              tenantId: order.tenantId,
              plan,
              billingPeriod: (order.billingPeriod as BillingPeriod | null) ?? 'monthly',
              amountCents: order.amountCents,
              currency: order.currency,
              quotaSource: `plan:${plan.name}`,
              quotaIdempotencyKey: `checkout:${order.id}`,
            });

            // 记录 Campaign / DiscountCode redemption
            await this.recordDiscountRedemptions(order).catch((e) => {
              this.logger.warn(`redemption 记录失败（不影响订单发放）: ${e}`);
            });
          } else {
            this.logger.warn(`套餐不存在: ${order.planId}`);
          }
        } else if (order.orderType === 'RECHARGE') {
          if (!order.billingAccountId) {
            throw new RechargeBillingSubjectChangedError();
          }
          // 充值订单：实付与赠额必须形成同一个有效期批次，并在消耗时按
          // paid / (paid + bonus) 比例确认收入。
          let tierId = order.rechargeTierId ?? undefined;
          let bonusCents = order.bonusCents ?? 0;
          let shouldDeleteTierContext = Boolean(tierId || bonusCents > 0);
          if (!tierId || bonusCents <= 0) {
            const raw = await this.redis.get(rechargeTierKey(order.id)).catch(() => null);
            if (raw) {
              shouldDeleteTierContext = true;
              try {
                const parsed = JSON.parse(raw) as { tierId?: string; bonusCents?: number };
                if (parsed.tierId && typeof parsed.bonusCents === 'number' && parsed.bonusCents > 0) {
                  tierId = parsed.tierId;
                  bonusCents = parsed.bonusCents;
                }
              } catch {
                this.logger.warn(`RechargeTier 上下文 JSON 损坏 order=${order.id}: ${raw}`);
              }
            }
          }
          await this.billingService.rechargeWithBonus(
            order.userId,
            order.amountCents,
            bonusCents,
            `充值订单: ${orderId}`,
            orderId,
            order.productId ?? undefined,
            {
              tenantId: order.tenantId,
              billingAccountId: order.billingAccountId,
              bonusDescription: tierId
                ? `recharge-bonus tier:${tierId}`
                : 'recharge-bonus',
            },
          );
          if (shouldDeleteTierContext) {
            await this.redis.del(rechargeTierKey(order.id)).catch(() => {});
          }
        }

        await this.transitionOrderStatus(orderId, OrderStatus.COMPLETED);

        // P2-D: 邀请裂变 FIRST_RECHARGE / FIRST_SUBSCRIBE 触发回调。
        // fire-and-forget,内部所有路径已 try/catch + warn,不影响订单履约。
        if (this.referrals) {
          void this.referrals
            .onOrderCompleted({ orderId })
            .catch(() => {});
        }
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : 'Unknown error';
        // P2-A2: fulfillOrder 失败 → 写 PAYMENT/HIGH AlertEvent(spec §7.2.a)。
        // - 主链路是把订单转 FAILED / 自动退款,Alert 是补充审计,绝不能阻断下面逻辑。
        // - createAlert 内部已 catch + warn,这里再 .catch 兜底防止 Promise 抛逸。
        // - fire-and-forget(不 await),不让 Alert 写入耽误订单状态机。
        this.alertEvents
          ?.createAlert({
            category: 'PAYMENT',
            severity: 'HIGH',
            title: '订单履约失败',
            message: `订单 ${orderId} 履约异常:${errMsg}`,
            sourceType: 'order',
            sourceId: orderId,
            userId: order.userId,
            context: {
              amountCents: order.amountCents,
              channel: order.channel,
              orderType: order.orderType,
              // P2-A2 review fix(Minor #5): 让运营快速分类错误
              // (网络超时 / Prisma 主键冲突 / 业务异常 等)。
              errType: err instanceof Error ? err.constructor.name : 'unknown',
            },
          })
          .catch(() => {});

        if (
          order.orderType === 'BUNDLE' &&
          err instanceof BundleFulfillmentError &&
          err.hasFulfilledItems
        ) {
          await this.markBundleRequiresCompensationIfCurrent(order.id, errMsg);
        }

        // 自营换档抵扣「安全闸」拒单（并发/来源失效等永久性业务拒绝）：entitlement 已回滚、无部分权益。
        // 已付款则自动全额退款，避免用户付款却既无履约又无退款。用独立异常类型精确识别——
        // 只退这类拒单，不误退 DB/网络等瞬时故障（后者仍走 FAILED + 告警重试路径）。
        if (err instanceof SelfOpProrationSourceInvalidError && order.paidAt) {
          try {
            // 该订单未产生任何权益/积分（entitlement 事务已回滚、未 grantQuota）：只退渠道款，
            // 跳过权益补偿，避免误扣用户当前(旧)套餐积分或误关活动权益。
            await this.refundOrder(order.id, `自营换档抵扣来源失效自动退款: ${errMsg}`, undefined, {
              skipEntitlementCompensation: true,
            });
            this.logger.log(`自营换档抵扣拒单自动退款成功: ${order.id}`);
            return; // 已进入退款态，不再标 FAILED
          } catch (refundErr) {
            this.logger.error(`自营换档抵扣拒单自动退款失败: ${order.id} → ${refundErr}`);
          }
        }

        // 充值主体漂移是确定性拒绝，不应反复重试。仅当订单没有产生任何 RECHARGE/ADJUST
        // 流水或 BalanceGrant 时，才可原路退款并跳过钱包回退；瞬时 DB/网络异常不走此分支。
        if (
          order.orderType === PrismaOrderType.RECHARGE
          && err instanceof RechargeBillingSubjectChangedError
          && order.paidAt
        ) {
          try {
            if (await this.hasRechargeWalletEffects(order.id)) {
              throw new RechargeWalletEffectsDetectedError();
            }
            await this.refundOrder(
              order.id,
              `充值主体变化自动退款: ${errMsg}`,
              undefined,
              { skipRechargeBalanceCompensation: true },
            );
            this.logger.log(`充值主体变化自动退款成功: ${order.id}`);
            return;
          } catch (refundErr) {
            if (refundErr instanceof RechargeWalletEffectsDetectedError) {
              this.logger.warn(
                `充值主体变化退款闸检测到已入账效果，保留履约态等待成功链路收口: ${order.id}`,
              );
              return;
            }
            const refundErrMsg = refundErr instanceof Error ? refundErr.message : String(refundErr);
            this.logger.error(`充值主体变化自动退款失败: ${order.id} → ${refundErrMsg}`);
            this.alertEvents
              ?.createAlert({
                category: 'PAYMENT',
                severity: 'CRITICAL',
                title: '充值履约失败且自动退款失败',
                message: `充值订单 ${order.id} 未入账，自动原路退款失败`,
                sourceType: 'order',
                sourceId: order.id,
                userId: order.userId,
                context: {
                  amountCents: order.amountCents,
                  channel: order.channel,
                  fulfillmentError: errMsg,
                  refundError: refundErrMsg,
                },
              })
              .catch(() => {});
          }
        }

        // 单项/组合类订单履约失败后不能留下部分权益；已付款时先走全额退款，
        // 由 refundOrder 按订单项 Saga 状态精确回退已履约成功的积分、订阅和 CodingPlan entitlement。
        if ((order.orderType === 'BOOSTER_PACK' || order.orderType === 'BUNDLE') && order.paidAt) {
          try {
            await this.refundOrder(orderId, `履约失败自动退款: ${errMsg}`);
            const orderTypeLabel = order.orderType === 'BUNDLE' ? '组合套餐' : '加油包';
            this.logger.log(`${orderTypeLabel}履约失败自动退款成功: ${orderId}`);
            return; // 退款成功，订单已是 REFUNDED 状态，不转 FAILED
          } catch (refundErr) {
            this.logger.error(`自动退款失败: ${orderId} → ${refundErr}`);
          }
        }
        // 退款失败或不是 booster pack，仅在订单仍处于履约中时标记失败。
        // 若自动退款已把订单推进到退款态，
        // 这里不能再把终态或退款态覆盖成 FAILED。
        await this.markFulfillmentFailedIfCurrent(order.id, errMsg);
      }
    } finally {
      await this.redis.del(lockKey);
    }
  }

  private async markFulfillmentFailedIfCurrent(orderId: string, detail: string): Promise<void> {
    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const updated = await tx.order.updateMany({
        where: {
          id: orderId,
          status: OrderStatus.FULFILLING,
        },
        data: {
          status: OrderStatus.FAILED,
          fulfillmentAttemptId: null,
          fulfillmentClaimedAt: null,
        },
      });
      if (updated.count !== 1) {
        this.logger.warn(`订单履约失败但状态已变化，跳过 FAILED 覆盖: ${orderId}`);
        return;
      }

      await tx.orderAuditLog.create({
        data: {
          orderId,
          fromStatus: OrderStatus.FULFILLING,
          toStatus: OrderStatus.FAILED,
          operator: 'system',
          detail,
        },
      });
    });
  }

  private async markBundleRequiresCompensationIfCurrent(orderId: string, detail: string): Promise<void> {
    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const updated = await tx.order.updateMany({
        where: {
          id: orderId,
          status: OrderStatus.FULFILLING,
        },
        data: {
          status: OrderStatus.PARTIALLY_FULFILLED_REQUIRES_COMPENSATION,
          fulfillmentAttemptId: null,
          fulfillmentClaimedAt: null,
        },
      });
      if (updated.count !== 1) {
        this.logger.warn(`组合套餐进入补偿态失败，订单状态已变化: ${orderId}`);
        return;
      }

      await tx.orderAuditLog.create({
        data: {
          orderId,
          fromStatus: OrderStatus.FULFILLING,
          toStatus: OrderStatus.PARTIALLY_FULFILLED_REQUIRES_COMPENSATION,
          operator: 'system',
          detail,
        },
      });
    });
  }

  private async claimOrderForFulfillment(orderId: string): Promise<PrismaOrder | null> {
    const order = await this.prisma.order.findUnique({ where: { id: orderId } });
    if (!order) return null;
    if (
      order.channel === PayChannel.STRIPE
      && order.providerSubscriptionEndedAt
    ) {
      this.logger.error(
        `Stripe 订单已有 provider subscription tombstone，拒绝履约: order=${orderId}`,
      );
      return null;
    }

    if (order.status === OrderStatus.PAID) {
      const attemptId = randomUUID();
      const claimedAt = new Date();
      const claimed = await this.prisma.order.updateMany({
        where: {
          id: orderId,
          status: OrderStatus.PAID,
          ...(order.channel === PayChannel.STRIPE
            ? { providerSubscriptionEndedAt: null }
            : {}),
        },
        data: {
          status: OrderStatus.FULFILLING,
          fulfillmentAttemptId: attemptId,
          fulfillmentClaimedAt: claimedAt,
        },
      });
      if (claimed.count !== 1) {
        this.logger.warn(`订单履约抢占失败: ${orderId}`);
        return null;
      }
      await this.prisma.orderAuditLog.create({
        data: {
          orderId,
          fromStatus: OrderStatus.PAID,
          toStatus: OrderStatus.FULFILLING,
          operator: 'system',
          detail: '开始订单履约',
        },
      });
      return {
        ...order,
        status: OrderStatus.FULFILLING,
        fulfillmentAttemptId: attemptId,
        fulfillmentClaimedAt: claimedAt,
      };
    }

    if (order.status === OrderStatus.FULFILLING) {
      const marker = await this.prisma.orderAuditLog.findFirst({
        where: {
          orderId,
          toStatus: OrderStatus.FULFILLING,
        },
        orderBy: { createdAt: 'desc' },
        select: { createdAt: true },
      });
      const startedAt = order.fulfillmentClaimedAt ?? marker?.createdAt ?? order.paidAt ?? order.createdAt;
      const isStale = Date.now() - startedAt.getTime() >= FULFILLMENT_STALE_MS;
      if (!isStale) {
        this.logger.warn(`订单正在履约中，跳过重复发放: ${orderId}`);
        return null;
      }
      const attemptId = randomUUID();
      const claimedAt = new Date();
      const claimed = await this.prisma.order.updateMany({
        where: {
          id: orderId,
          status: OrderStatus.FULFILLING,
          fulfillmentAttemptId: order.fulfillmentAttemptId,
          ...(order.channel === PayChannel.STRIPE
            ? { providerSubscriptionEndedAt: null }
            : {}),
        },
        data: {
          fulfillmentAttemptId: attemptId,
          fulfillmentClaimedAt: claimedAt,
        },
      });
      if (claimed.count !== 1) {
        this.logger.warn(`陈旧订单履约恢复抢占失败: ${orderId}`);
        return null;
      }
      await this.prisma.orderAuditLog.create({
        data: {
          orderId,
          fromStatus: OrderStatus.FULFILLING,
          toStatus: OrderStatus.FULFILLING,
          operator: 'system',
          detail: '恢复陈旧履约任务',
        },
      });
      return {
        ...order,
        fulfillmentAttemptId: attemptId,
        fulfillmentClaimedAt: claimedAt,
      };
    }

    return null;
  }

  private async fulfillPlanPurchase(input: {
    orderId: string;
    fulfillmentOrderId?: string;
    userId: string;
    tenantId?: string | null;
    plan: FulfillablePlan;
    billingPeriod: BillingPeriod;
    validityDaysOverride?: number | null;
    amountCents?: number | null;
    currency?: string | null;
    quotaSource: string;
    quotaIdempotencyKey: string;
  }): Promise<string | null> {
    const productId = input.plan.productId;
    if (!productId) {
      if (input.plan.monthlyCredits > 0) {
        await this.creditService.grantQuota(
          '',
          input.userId,
          input.plan.monthlyCredits,
          input.quotaSource,
          { idempotencyKey: input.quotaIdempotencyKey },
        );
      }
      return null;
    }
    const tenantId = input.plan.product?.billingMode === ProductBillingMode.CODING_PLAN
      ? await this.billingService.resolvePersonalTenantIdForUser(input.userId)
      : this.requireTenantId({ tenantId: input.tenantId });

    if (input.plan.product?.billingMode === ProductBillingMode.CODING_PLAN) {
      if (input.fulfillmentOrderId) {
        throw new ConflictException(
          'Bundle fulfillment does not support Coding Plan entitlements',
        );
      }
      const providerResale = this.isProviderResalePlan(input.plan);
      const fulfillmentOrderId = input.fulfillmentOrderId ?? input.orderId;

      if (providerResale) {
        // 转售（vendor）：可并存多档，不受单一活跃约束，沿用 orderId upsert + 供应商履约。
        const entitlement = await this.billingService.createCodingPlanEntitlement({
          orderId: fulfillmentOrderId,
          userId: input.userId,
          tenantId,
          productId,
          planId: input.plan.id,
          billingPeriod: input.billingPeriod,
          validityDaysOverride: input.validityDaysOverride,
          fulfillmentMode: 'provider_resale',
          status: 'PENDING',
        });
        if (!this.codingPlanFulfillment) {
          await this.billingService.markCodingPlanEntitlementFailed(
            fulfillmentOrderId,
            'CodingPlan 供应商履约服务未启用',
          );
          throw new ServiceUnavailableException('CodingPlan 供应商履约服务未启用');
        }
        try {
          await this.codingPlanFulfillment.fulfillSubscriptionOrder({
            orderId: fulfillmentOrderId,
            userId: input.userId,
            tenantId,
            productId,
            planId: input.plan.id,
            subscriptionId: entitlement.id,
            amountCents: input.amountCents,
            currency: input.currency,
          });
          await this.billingService.attachCodingPlanProviderEntitlement(fulfillmentOrderId);
        } catch (err) {
          await this.billingService.markCodingPlanEntitlementFailed(
            fulfillmentOrderId,
            err instanceof Error ? err.message : String(err),
          );
          throw err;
        }
        await this.subscriptionResolver.invalidateCache(input.userId, productId, tenantId);
        this.notifyCreditChangedByUserId(input.userId, productId).catch(() => {});
        return entitlement.id;
      }

      // 自营（platform_model_package）：单一活跃约束 + 同档续订延期 + 异档切换（F1b，本期不含 carry-over）。
      const provision = await this.billingService.provisionSelfOperatedEntitlement({
        orderId: fulfillmentOrderId,
        userId: input.userId,
        tenantId,
        productId,
        planId: input.plan.id,
        billingPeriod: input.billingPeriod,
        validityDaysOverride: input.validityDaysOverride,
      });

      await this.subscriptionResolver.invalidateCache(input.userId, productId, tenantId);
      // 续订（renewed）不重复发月度——月度由 resetQuota cron 在现有 entitlement 上继续发；新建/切换才发首月。
      if (provision.monthlyGrantNeeded && input.plan.monthlyCredits > 0) {
        await this.creditService.grantQuota(
          provision.entitlement.id,
          input.userId,
          input.plan.monthlyCredits,
          input.quotaSource,
          { idempotencyKey: input.quotaIdempotencyKey },
        );
      }
      // 异档切换：旧 key 已改绑新 entitlement（同事务），提交后重新镜像到网关（新绑定 + 余额）。
      if (provision.rebindFromEntitlementId) {
        await this.billingService.resyncCodingPlanEntitlementKeys(provision.entitlement.id);
        this.logger.warn(
          `coding-plan 切换 order=${fulfillmentOrderId} from=${provision.rebindFromEntitlementId} to=${provision.entitlement.id}：` +
            `旧池剩余积分本期不 carry-over（随旧 entitlement 作废搁置）`,
        );
      }
      this.notifyCreditChangedByUserId(input.userId, productId).catch(() => {});
      return provision.entitlement.id;
    }

    const activationIdempotencyKey = input.fulfillmentOrderId
      ? `bundle:${input.orderId}:item:${input.fulfillmentOrderId}:activation`
      : `checkout:${input.orderId}:activation`;
    const activated = await this.billingService.activateSubscription(
      input.userId,
      input.plan.id,
      productId,
      input.validityDaysOverride ?? undefined,
      input.billingPeriod,
      {
        tenantId,
        idempotencyKey: activationIdempotencyKey,
        requireNoActiveSubscription: Boolean(input.fulfillmentOrderId),
      },
    );
    await this.subscriptionResolver.invalidateCache(input.userId, productId, tenantId);
    if (input.plan.monthlyCredits > 0) {
      await this.creditService.grantQuota(
        activated.periodId,
        input.userId,
        input.plan.monthlyCredits,
        input.quotaSource,
        { idempotencyKey: input.quotaIdempotencyKey },
      );
    }
    this.notifyCreditChangedByUserId(input.userId, productId).catch(() => {});
    return activated.periodId;
  }

  private isProviderResalePlan(plan: FulfillablePlan): boolean {
    return plan.product?.codingPlanFulfillmentMode === CodingPlanFulfillmentMode.provider_resale;
  }

  private async fulfillBundleOrder(
    orderId: string,
    userId: string,
    tenantId?: string | null,
  ): Promise<void> {
    const persistedItems = await this.prisma.orderItem.findMany({
      where: { orderId },
      orderBy: { createdAt: 'asc' },
      include: {
        product: { select: { billingMode: true, codingPlanFulfillmentMode: true } },
        plan: true,
        boosterPack: true,
      },
    });
    const items = [...persistedItems].sort((left, right) => {
      const leftRank = left.planId ? 0 : left.boosterPackId ? 1 : 2;
      const rightRank = right.planId ? 0 : right.boosterPackId ? 1 : 2;
      return leftRank - rightRank
        || left.id.localeCompare(right.id);
    });
    if (items.length === 0) {
      throw new BadRequestException('组合套餐订单缺少明细');
    }
    const planItemByProduct = new Map<string, (typeof items)[number]>();
    for (const item of items) {
      if (item.product?.billingMode === ProductBillingMode.CODING_PLAN) {
        throw new ConflictException(
          'Bundle fulfillment does not support Coding Plan entitlements',
        );
      }
      if (item.planId && item.productId) {
        if (planItemByProduct.has(item.productId)) {
          throw new ConflictException('Bundle has multiple plan entitlements for one product');
        }
        planItemByProduct.set(item.productId, item);
      }
      if ((item.quantity ?? 1) !== 1) {
        throw new ConflictException('Bundle entitlement quantity must be exactly one');
      }
    }
    for (const item of items) {
      if (
        item.boosterPackId
        && (!item.productId || !planItemByProduct.has(item.productId))
      ) {
        throw new ConflictException(
          'Bundle booster must be anchored to a plan entitlement in the same product',
        );
      }
    }

    const fulfilledItemIds = new Set(
      items
        .filter((item) => item.status === OrderItemStatus.FULFILLED)
        .map((item) => item.id),
    );
    const subscriptionIdByProduct = new Map<string, string>();
    for (const item of items) {
      if (
        item.status !== OrderItemStatus.FULFILLED
        || !item.planId
        || !item.productId
      ) {
        continue;
      }
      const activation = await this.prisma.subscriptionPeriod.findUnique({
        where: {
          activationIdempotencyKey:
            `bundle:${orderId}:item:${item.id}:activation`,
        },
        select: {
          id: true,
          userId: true,
          tenantId: true,
          productId: true,
          planId: true,
        },
      });
      if (
        !activation
        || activation.userId !== userId
        || activation.tenantId !== tenantId
        || activation.productId !== item.productId
        || activation.planId !== item.planId
      ) {
        throw new ConflictException(
          `Bundle fulfilled plan activation receipt is missing or mismatched: ${item.id}`,
        );
      }
      subscriptionIdByProduct.set(item.productId, activation.id);
    }

    for (const item of items) {
      if (BUNDLE_FULFILLMENT_SKIP_ITEM_STATUSES.has(item.status)) continue;
      try {
        await this.prisma.orderItem.update({
          where: { id: item.id },
          data: { status: OrderItemStatus.FULFILLING },
        });

        if (item.planId && item.productId && item.plan) {
          const subscriptionId = await this.fulfillPlanPurchase({
            orderId,
            fulfillmentOrderId: item.id,
            userId,
            tenantId,
            plan: {
              ...item.plan,
              productId: item.productId,
              product: item.product,
            },
            billingPeriod: 'monthly',
            validityDaysOverride: item.validityDays,
            amountCents: item.amountCents,
            currency: item.currency,
            quotaSource: `bundle:${item.name}`,
            quotaIdempotencyKey: `bundle:${orderId}:item:${item.id}:quota`,
          });
          if (!subscriptionId) {
            throw new ConflictException(
              `Bundle plan activation did not return a subscription receipt: ${item.id}`,
            );
          }
          subscriptionIdByProduct.set(item.productId, subscriptionId);
        } else if (item.boosterPackId && item.boosterPack) {
          const subscriptionId = item.productId
            ? subscriptionIdByProduct.get(item.productId)
            : null;
          if (!subscriptionId) {
            throw new ConflictException(
              `Bundle booster subscription receipt is missing: ${item.id}`,
            );
          }
          await this.creditService.addBonus(
            subscriptionId,
            userId,
            item.boosterPack.creditsAmount,
            `bundle:${item.name}`,
            { idempotencyKey: `bundle:${orderId}:item:${item.id}:bonus` },
          );
          this.notifyCreditChangedByUserId(userId, item.productId).catch(() => {});
        } else {
          throw new BadRequestException(`组合套餐明细缺少权益目标: ${item.id}`);
        }

        await this.prisma.orderItem.update({
          where: { id: item.id },
          data: { status: OrderItemStatus.FULFILLED, fulfilledAt: new Date() },
        });
        fulfilledItemIds.add(item.id);
      } catch (err) {
        const sideEffectMayExist = Boolean(item.plan || item.boosterPack);
        await this.prisma.orderItem.update({
          where: { id: item.id },
          // FULFILLING -> final status is not an atomic boundary with provider,
          // subscription, or credit side effects. Route ambiguous items through
          // evidence-based compensation instead of declaring "no effects".
          data: {
            status: sideEffectMayExist
              ? OrderItemStatus.COMPENSATING
              : OrderItemStatus.FAILED,
          },
        });
        const errMsg = err instanceof Error ? err.message : String(err);
        throw new BundleFulfillmentError(errMsg, fulfilledItemIds.size > 0, err);
      }
    }
  }

  /**
   * 订单退款
   */
  async refundOrder(
    orderId: string,
    reason: string,
    refundAmountCents?: number,
    opts: RefundOrderOptions = {},
  ) {
    const lockKey = `refund:lock:${orderId}`;
    const lockToken = randomUUID();
    const locked = await this.redis.set(lockKey, lockToken, 'EX', REFUND_LOCK_SECONDS, 'NX');
    if (!locked) {
      throw new ConflictException('订单退款正在处理中，请刷新后重试');
    }

    try {
      return await this.refundOrderLocked(orderId, reason, refundAmountCents, opts);
    } finally {
      await this.releaseRedisLock(lockKey, lockToken);
    }
  }

  private async refundOrderLocked(
    orderId: string,
    reason: string,
    refundAmountCents?: number,
    opts: RefundOrderOptions = {},
  ) {
    const order = await this.prisma.order.findUnique({
      where: { id: orderId },
      include: {
        plan: true,
        boosterPack: true,
        items: {
          include: { plan: true, boosterPack: true },
        },
      },
    });
    if (!order) throw new BadRequestException('订单不存在');

    const isStripeSubscriptionRefund =
      order.channel === PayChannel.STRIPE
      && Boolean(order.tradeNo?.startsWith('sub_'));
    const isGenericProviderRefund =
      Boolean(order.tradeNo)
      && (
        order.channel === PayChannel.WECHAT
        || order.channel === PayChannel.ALIPAY
        || (
          order.channel === PayChannel.STRIPE
          && !isStripeSubscriptionRefund
        )
      );
    const stripeRefundTask = isStripeSubscriptionRefund
      ? await this.prisma.stripeSubscriptionCancellationTask.findUnique({
          where: { orderId: order.id },
        })
      : null;
    const skipEntitlementCompensation =
      opts.skipEntitlementCompensation
      ?? stripeRefundTask?.skipEntitlementCompensation
      ?? false;
    const refundableStatuses: OrderStatus[] = [
      OrderStatus.PAID,
      OrderStatus.FULFILLING,
      OrderStatus.PARTIALLY_FULFILLED_REQUIRES_COMPENSATION,
      OrderStatus.COMPLETED,
      OrderStatus.REFUND_FAILED,
      OrderStatus.REFUND_COMPENSATION_FAILED,
      ...(stripeRefundTask ? [OrderStatus.REFUNDING] : []),
    ];
    if (!refundableStatuses.includes(order.status)) {
      throw new BadRequestException('只能退款已支付或已完成订单');
    }

    const isStripeProviderRecovery =
      Boolean(stripeRefundTask)
      && (
        order.status === OrderStatus.REFUNDING
        || order.status === OrderStatus.REFUND_FAILED
        || order.status === OrderStatus.REFUND_COMPENSATION_FAILED
      );
    const isInternalCompensationRetry =
      order.status === OrderStatus.REFUND_COMPENSATION_FAILED
      || isStripeProviderRecovery;
    const shouldReuseExistingRefundIntent =
      order.status === OrderStatus.REFUND_FAILED ||
      order.status === OrderStatus.REFUND_COMPENSATION_FAILED ||
      order.status === OrderStatus.REFUNDING;
    const storedRefundCents = order.refundAmountCents ?? order.amountCents;
    if (
      isInternalCompensationRetry &&
      refundAmountCents !== undefined &&
      refundAmountCents !== storedRefundCents
    ) {
      throw new BadRequestException('退款补偿重试必须使用原退款金额');
    }
    const actualRefundCents =
      refundAmountCents ??
      (shouldReuseExistingRefundIntent
        ? storedRefundCents
        : order.amountCents);
    if (actualRefundCents <= 0) {
      throw new BadRequestException('退款金额必须大于 0');
    }
    if (actualRefundCents > order.amountCents) {
      throw new BadRequestException('退款金额不能超过订单金额');
    }
    if (
      order.channel === PayChannel.STRIPE
      && order.tradeNo?.startsWith('sub_')
      && actualRefundCents !== order.amountCents
    ) {
      throw new ConflictException(
        'Stripe 自动续费订阅仅支持整张最新账单退款；部分退款无法安全映射本地权益',
      );
    }
    let selfOperatedCodingPlanRefundEvidence:
      SelfOperatedCodingPlanRefundEvidence | null = null;
    if (
      order.orderType === PrismaOrderType.SUBSCRIPTION
      && order.productId
    ) {
      const codingPlanFulfillmentMode =
        await this.findOrderCodingPlanFulfillmentMode(order.id);
      if (codingPlanFulfillmentMode) {
        try {
          if (
            codingPlanFulfillmentMode
            === CodingPlanFulfillmentMode.provider_resale
          ) {
            throw new SelfOperatedCodingPlanRefundEligibilityError(
              'PROVIDER_RESALE_UNSUPPORTED',
              '供应商转售套餐暂不支持自动退款，请人工核对上游权益',
            );
          }
          if (skipEntitlementCompensation && !isInternalCompensationRetry) {
            throw new SelfOperatedCodingPlanRefundEligibilityError(
              'ENTITLEMENT_COMPENSATION_REQUIRED',
              '自营套餐退款必须同步撤销套餐权益，不能跳过权益补偿',
            );
          }
          if (!isInternalCompensationRetry) {
            selfOperatedCodingPlanRefundEvidence =
              await this.refundCompensation
                .preflightUnusedSelfOperatedCodingPlanRefund(
                  order,
                  actualRefundCents,
                );
          }
        } catch (error) {
          const message =
            error instanceof Error ? error.message : String(error);
          await this.alertEvents
            ?.createAlert({
              category: 'PAYMENT',
              severity: 'HIGH',
              title: '自营套餐自动退款资格校验未通过',
              message: `订单 ${order.id} 未调用支付渠道退款: ${message}`,
              sourceType: 'order',
              sourceId: order.id,
              userId: order.userId,
              context: {
                fulfillmentMode: codingPlanFulfillmentMode,
                orderStatus: order.status,
                refundAmountCents: actualRefundCents,
                reason,
                eligibilityCode:
                  error instanceof SelfOperatedCodingPlanRefundEligibilityError
                    ? error.code
                    : null,
              },
            })
            .catch(() => {});
          throw new ConflictException(message);
        }
      }
    }

    let stripeRefundPreparation: {
      subscriptionId: string;
      invoiceId: string;
    } | null = null;
    let stripeRefundEvidence:
      StripeSubscriptionRefundEvidence | null = null;
    if (!isInternalCompensationRetry && isStripeSubscriptionRefund) {
      try {
        const credentials =
          await this.resolveStripeCredentialsForOrder(
            order.paymentProviderInstanceId,
          );
        stripeRefundPreparation =
          await this.stripeService.prepareSubscriptionRefund(
            order.tradeNo!,
            actualRefundCents,
            credentials,
          );
        stripeRefundEvidence =
          await this.refundCompensation.preflightStripeSubscriptionRefund(
            order,
            stripeRefundPreparation.invoiceId,
            {
              skipEntitlementCompensation,
            },
          );
      } catch (err) {
        const message =
          err instanceof Error ? err.message : String(err);
        await this.alertEvents
          ?.createAlert({
            category: 'PAYMENT',
            severity: 'CRITICAL',
            title: 'Stripe订阅退款前置证据校验失败',
            message:
              `订单 ${order.id} 未 claim、未调用 Stripe 退款；invoice 无法与本地 activation/grant 唯一对应`,
            sourceType: 'order',
            sourceId: order.id,
            userId: order.userId,
            context: {
              subscriptionId: order.tradeNo,
              refundAmountCents: actualRefundCents,
              error: message,
            },
          })
          .catch(() => {});
        throw new ConflictException(
          `Stripe 订阅退款前置证据校验失败: ${message}`,
        );
      }
    }

    let skipRechargeBalanceCompensation = false;
    let genericProviderClaim: ClaimedProviderRefundIntent | null = null;
    let genericCompensationClaim: ClaimedProviderRefundIntent | null = null;

    if (isInternalCompensationRetry) {
      const recoveredStripeLeaseId =
        await this.ensureStripeCancellationCompletedBeforeCompensation(
        order,
        stripeRefundTask,
        opts.stripeCancellationLeaseId,
      );
      if (recoveredStripeLeaseId) {
        opts.stripeCancellationLeaseId = recoveredStripeLeaseId;
      }
      if (order.orderType === PrismaOrderType.RECHARGE) {
        const hasWalletEffects = await this.hasRechargeWalletEffects(order.id);
        if (opts.skipRechargeBalanceCompensation && hasWalletEffects) {
          throw new RechargeWalletEffectsDetectedError();
        }
        skipRechargeBalanceCompensation = !hasWalletEffects;
      }
      await this.prisma.order.update({
        where: { id: orderId },
        data: {
          refundReason: reason,
          refundAmountCents: actualRefundCents,
        },
      });
    } else {
      let hasRechargeWalletEffects = false;
      if (isStripeSubscriptionRefund) {
        opts.stripeCancellationLeaseId =
          await this.claimStripeSubscriptionRefundIntent({
              orderId: order.id,
              fromStatus: order.status,
              refundReason: reason,
              refundAmountCents: actualRefundCents,
              subscriptionId:
                stripeRefundPreparation!.subscriptionId,
              refundedInvoiceId:
                stripeRefundPreparation!.invoiceId,
              refundedActivationIdempotencyKey:
                stripeRefundEvidence!
                  .refundedActivationIdempotencyKey,
              refundedSubscriptionPeriodId:
                stripeRefundEvidence!
                  .refundedSubscriptionPeriodId,
              originalGrantIdempotencyKey:
                stripeRefundEvidence!
                  .originalGrantIdempotencyKey,
              skipEntitlementCompensation:
                stripeRefundEvidence!
                  .skipEntitlementCompensation,
            paymentProviderInstanceId:
              order.paymentProviderInstanceId,
          });
      } else if (isGenericProviderRefund) {
        if (!order.channel || !order.tradeNo) {
          throw new BadRequestException('订单缺少支付渠道或支付流水号，无法发起退款');
        }
        const existingIntent =
          await this.providerRefundSaga.findByOrderId(order.id);
        if (existingIntent) {
          if (
            existingIntent.status
              === ProviderRefundIntentStatus.PROVIDER_FAILED
            || existingIntent.status
              === ProviderRefundIntentStatus.MANUAL_REVIEW
          ) {
            throw new ConflictException(
              '该订单已有终态退款记录，禁止自动重放支付渠道请求，请人工核对后处理',
            );
          }
          throw new ConflictException(
            '该订单已有退款恢复任务，禁止重复发起，请等待自动恢复或查询退款结果',
          );
        }
        const hasRechargeEffectsBeforeClaim =
          order.orderType === PrismaOrderType.RECHARGE
            ? await this.hasRechargeWalletEffects(order.id)
            : false;
        if (
          opts.skipRechargeBalanceCompensation
          && hasRechargeEffectsBeforeClaim
        ) {
          throw new RechargeWalletEffectsDetectedError();
        }
        skipRechargeBalanceCompensation =
          order.orderType === PrismaOrderType.RECHARGE
          && !hasRechargeEffectsBeforeClaim;

        try {
          await this.refundCompensation.preflightOrderCompensation(
            order,
            actualRefundCents,
            {
              ...(skipEntitlementCompensation
                ? { skipEntitlementCompensation: true }
                : {}),
              ...(skipRechargeBalanceCompensation
                ? { skipRechargeBalanceCompensation: true }
                : {}),
            },
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await this.alertEvents
            ?.createAlert({
              category: 'PAYMENT',
              severity: 'CRITICAL',
              title: '退款前置补偿证据校验失败',
              message:
                `订单 ${order.id} 未 claim、未调用支付渠道退款；本地履约效果无法与订单唯一对应`,
              sourceType: 'order',
              sourceId: order.id,
              userId: order.userId,
              context: {
                channel: order.channel,
                orderType: order.orderType,
                refundAmountCents: actualRefundCents,
                error: message,
              },
            })
            .catch(() => {});
          throw new ConflictException(
            `退款前置补偿证据校验失败: ${message}`,
          );
        }

        let intent;
        try {
          ({ intent, hasRechargeWalletEffects } =
            await this.providerRefundSaga.claimOrderAndPrepare({
              orderId: order.id,
              fromStatus: order.status,
              orderType: order.orderType,
              channel: order.channel,
              tradeNo: order.tradeNo,
              requestNo: this.buildProviderRefundRequestNo(
                order.id,
                actualRefundCents,
              ),
              amountCents: actualRefundCents,
              currency: order.currency,
              reason,
              paymentProviderInstanceId:
                order.paymentProviderInstanceId,
              skipEntitlementCompensation,
              skipRechargeBalanceCompensation,
              requireNoRechargeWalletEffects:
                skipRechargeBalanceCompensation,
              preflightCompletedAt: new Date(),
              ...(selfOperatedCodingPlanRefundEvidence
                ? {
                    selfOperatedCodingPlanRefund:
                      selfOperatedCodingPlanRefundEvidence,
                  }
                : {}),
            }));
        } catch (err) {
          if (
            err instanceof Error
            && err.message.includes('recharge effects appeared during claim')
          ) {
            throw new RechargeWalletEffectsDetectedError();
          }
          if (
            err instanceof Error
            && err.message.includes('order claim conflict')
          ) {
            throw new ConflictException(
              '订单退款状态已被并发修改，请刷新后重试',
            );
          }
          throw err;
        }
        skipRechargeBalanceCompensation =
          order.orderType === PrismaOrderType.RECHARGE
          && !hasRechargeWalletEffects;
        genericProviderClaim =
          await this.providerRefundSaga.claim(intent.id);
        if (!genericProviderClaim) {
          throw new ConflictException(
            '退款 intent 已由其他执行器接管，请稍后查询结果',
          );
        }
      } else {
        hasRechargeWalletEffects =
          await this.claimOrderForRefund(
            order,
            actualRefundCents,
            reason,
            opts.skipRechargeBalanceCompensation ?? false,
          );
      }
      if (order.orderType === PrismaOrderType.RECHARGE) {
        skipRechargeBalanceCompensation = !hasRechargeWalletEffects;
      }

      if (!isStripeSubscriptionRefund && !isGenericProviderRefund) {
        try {
          await this.refundCompensation.preflightOrderCompensation(
            order,
            actualRefundCents,
            {
              ...(skipEntitlementCompensation
                ? { skipEntitlementCompensation: true }
                : {}),
              ...(skipRechargeBalanceCompensation
                ? { skipRechargeBalanceCompensation: true }
                : {}),
            },
          );
        } catch (err) {
          const message = err instanceof Error ? err.message : String(err);
          await this.transitionOrderStatus(
            order.id,
            OrderStatus.REFUND_FAILED,
            'system',
            `退款前置补偿证据校验失败: ${message}`,
          );
          await this.alertEvents
            ?.createAlert({
              category: 'PAYMENT',
              severity: 'CRITICAL',
              title: '退款前置补偿证据校验失败',
              message:
                `订单 ${order.id} 未调用支付渠道退款；本地履约效果无法与订单唯一对应`,
              sourceType: 'order',
              sourceId: order.id,
              userId: order.userId,
              context: {
                channel: order.channel,
                orderType: order.orderType,
                refundAmountCents: actualRefundCents,
                error: message,
              },
            })
            .catch(() => {});
          throw new ConflictException(
            `退款前置补偿证据校验失败: ${message}`,
          );
        }
      }

      if (
        genericProviderClaim
        && selfOperatedCodingPlanRefundEvidence
      ) {
        try {
          await this.refundCompensation
            .syncSelfOperatedCodingPlanRefundHoldRequired(
              selfOperatedCodingPlanRefundEvidence.entitlementId,
            );
          await this.refundCompensation
            .assertUnusedSelfOperatedCodingPlanRefundHeld(
              order,
              actualRefundCents,
              selfOperatedCodingPlanRefundEvidence,
            );
        } catch (error) {
          const retryable =
            error instanceof SelfOperatedCodingPlanRefundHoldRetryError;
          const message =
            error instanceof Error ? error.message : String(error);
          await this.providerRefundSaga.recordProviderOutcome(
            genericProviderClaim,
            {
              state: retryable ? 'NOT_FOUND' : 'FAILED',
              providerStatus: retryable
                ? 'LOCAL_REFUND_HOLD_RETRY'
                : 'LOCAL_REFUND_ELIGIBILITY_LOST',
              error: message,
            },
          );
          if (retryable) {
            throw new ServiceUnavailableException(message);
          }
          throw new ConflictException(message);
        }
      }

      const expectedStripeSubscriptionInvoiceId =
        stripeRefundPreparation?.invoiceId;

      let refundResult: ChannelRefundResult;
      try {
        refundResult = await this.refundViaChannel(
          order,
          actualRefundCents,
          reason,
          expectedStripeSubscriptionInvoiceId,
        );
      } catch (err) {
        const errMsg = err instanceof Error ? err.message : String(err);
        const detail = `支付渠道退款调用异常: ${errMsg}`;
        if (genericProviderClaim) {
          await this.providerRefundSaga.recordProviderOutcome(
            genericProviderClaim,
            {
              state: 'UNKNOWN',
              providerStatus: 'REQUEST_OUTCOME_UNKNOWN',
              error: detail,
            },
          );
          throw new ServiceUnavailableException(
            '支付渠道退款结果未知，已进入自动查询恢复；确认成功前不会回退本地权益',
          );
        }
        try {
          await this.transitionOrderStatus(orderId, OrderStatus.REFUND_FAILED, 'system', detail);
        } catch (transitionErr) {
          this.logger.error(
            `支付渠道退款异常且 REFUND_FAILED 状态写入失败: order=${orderId} error=${
              transitionErr instanceof Error ? transitionErr.message : String(transitionErr)
            }`,
          );
        }
        await this.alertEvents
          ?.createAlert({
            category: 'PAYMENT',
            severity: 'CRITICAL',
            title: '支付渠道退款调用异常',
            message: `订单 ${orderId} 调用支付渠道退款时发生异常，已转为可重试失败状态`,
            sourceType: 'order',
            sourceId: orderId,
            userId: order.userId,
            context: {
              orderType: order.orderType,
              channel: order.channel,
              amountCents: order.amountCents,
              refundAmountCents: actualRefundCents,
              error: errMsg,
            },
          })
          .catch(() => {});
        throw err;
      }
      if (refundResult.stripeSubscriptionRefund) {
        const subscriptionRefund = refundResult.stripeSubscriptionRefund;
        try {
          await this.persistStripeSubscriptionCancellationTask({
            orderId: order.id,
            subscriptionId: subscriptionRefund.subscriptionId,
            refundId: subscriptionRefund.refundId,
            refundedInvoiceId: subscriptionRefund.refundedInvoiceId,
            paymentProviderInstanceId: order.paymentProviderInstanceId,
            error: subscriptionRefund.error,
            providerCanceledAt:
              subscriptionRefund.providerRefundSucceeded
              && !subscriptionRefund.cancellationPending
                ? new Date()
                : null,
            leaseId: opts.stripeCancellationLeaseId!,
          });
        } catch (taskErr) {
          const taskError = taskErr instanceof Error ? taskErr.message : String(taskErr);
          this.logger.error(
            `Stripe 订阅取消任务持久化失败: order=${order.id} subscription=${subscriptionRefund.subscriptionId} refund=${subscriptionRefund.refundId} invoice=${subscriptionRefund.refundedInvoiceId} error=${taskError}`,
          );
          await this.alertEvents
            ?.createAlert({
              category: 'PAYMENT',
              severity: 'CRITICAL',
              title: 'Stripe订阅取消任务持久化失败',
              message: `订单 ${order.id} 已在 Stripe 退款，但订阅取消任务无法持久化；订单保持 REFUNDING，禁止本地退款收口`,
              sourceType: 'order',
              sourceId: order.id,
              userId: order.userId,
              context: {
                subscriptionId: subscriptionRefund.subscriptionId,
                refundId: subscriptionRefund.refundId,
                refundedInvoiceId: subscriptionRefund.refundedInvoiceId,
                paymentProviderInstanceId: order.paymentProviderInstanceId,
                cancellationError: subscriptionRefund.error ?? null,
                taskError,
              },
            })
            .catch(() => {});
          // The external refund already happened. Keep REFUNDING as a durable
          // stop state: moving to REFUND_FAILED could replay the remote refund,
          // while moving to REFUND_COMPENSATION_FAILED without a task would
          // allow a later retry to close locally without canceling Stripe.
          throw new ServiceUnavailableException(
            'Stripe 已退款，但订阅取消任务持久化失败，需人工处理',
          );
        }

        if (subscriptionRefund.cancellationPending) {
          const detail =
            `Stripe 已退款但订阅取消未完成: ${
              subscriptionRefund.error
              ?? 'Stripe subscription cancellation not confirmed'
            }`;
          await this.markRefundCompensationFailed(
            order,
            actualRefundCents,
            detail,
            new Error(detail),
          );
          await this.alertEvents
            ?.createAlert({
              category: 'PAYMENT',
              severity: 'CRITICAL',
              title: 'Stripe订阅退款后取消失败',
              message: `订单 ${order.id} 的退款已成功，但 Stripe 订阅 ${subscriptionRefund.subscriptionId} 尚未确认取消；已进入持久重试`,
              sourceType: 'order',
              sourceId: order.id,
              userId: order.userId,
              context: {
                subscriptionId: subscriptionRefund.subscriptionId,
                refundId: subscriptionRefund.refundId,
                refundedInvoiceId: subscriptionRefund.refundedInvoiceId,
                paymentProviderInstanceId: order.paymentProviderInstanceId,
                error: subscriptionRefund.error ?? null,
              },
            })
            .catch(() => {});
          throw new ServiceUnavailableException(detail);
        }
      }
      if (genericProviderClaim) {
        const outcome = refundResult.providerOutcome ?? {
          state: refundResult.success ? 'SUCCEEDED' as const : 'UNKNOWN' as const,
          providerStatus: refundResult.success
            ? 'SUCCEEDED'
            : 'REQUEST_OUTCOME_UNKNOWN',
          ...(refundResult.refundId
            ? { refundId: refundResult.refundId }
            : {}),
          ...(refundResult.error ? { error: refundResult.error } : {}),
        };
        const intentStatus =
          await this.providerRefundSaga.recordProviderOutcome(
            genericProviderClaim,
            outcome,
          );
        if (
          intentStatus === ProviderRefundIntentStatus.PROVIDER_FAILED
        ) {
          const detail =
            outcome.error
            || `支付渠道退款失败: ${outcome.providerStatus}`;
          throw new BadRequestException(detail);
        }
        if (
          intentStatus !==
          ProviderRefundIntentStatus.PROVIDER_SUCCEEDED
        ) {
          throw new ServiceUnavailableException(
            '退款已受理，正在等待支付渠道确认；确认成功前不会回退本地权益',
          );
        }
        genericCompensationClaim =
          await this.providerRefundSaga.claim(
            genericProviderClaim.task.id,
          );
        if (!genericCompensationClaim) {
          throw new ServiceUnavailableException(
            '支付渠道退款已确认，内部补偿已由其他执行器接管',
          );
        }
      }
      if (!refundResult.success) {
        const detail = refundResult.error || '退款失败';
        await this.transitionOrderStatus(orderId, OrderStatus.REFUND_FAILED, 'system', detail);
        throw new BadRequestException(detail);
      }
    }

    const compensationTrigger = isInternalCompensationRetry ? 'manual-retry' : 'inline';
    try {
      if (order.orderType === PrismaOrderType.RECHARGE) {
        // 渠道调用可能耗时，补偿前再以账务事实复核一次。正常路径已通过订单行锁
        // 阻止新的履约写入；此处同时覆盖旧调用方未遵循订单锁协议的防御场景。
        // 该查询发生在渠道成功后，失败必须进入 REFUND_COMPENSATION_FAILED，不能把
        // 已退款订单遗留在 REFUNDING。
        skipRechargeBalanceCompensation = !await this.hasRechargeWalletEffects(order.id);
      }
      const compensation = await this.refundCompensation.prepareAndRun(order, actualRefundCents, {
        reason,
        trigger: compensationTrigger,
        // 仅永久拒单自动退款路径传 true；正常退款不带此键，保持既有调用形态。
        ...(skipEntitlementCompensation ? { skipEntitlementCompensation: true } : {}),
        ...(skipRechargeBalanceCompensation
          ? { skipRechargeBalanceCompensation: true }
          : {}),
      });
      if (!compensation.complete) {
        const detail = `支付渠道退款已成功，但内部退款补偿失败: ${
          compensation.error ?? 'refund compensation task did not complete'
        }`;
        await this.markRefundCompensationFailed(order, actualRefundCents, detail, new Error(detail));
        if (genericCompensationClaim) {
          await this.providerRefundSaga
            .releaseProviderSucceededForCompensationRetry(
              genericCompensationClaim,
              detail,
            );
          genericCompensationClaim = null;
        }
        throw new ServiceUnavailableException(detail);
      }
    } catch (err) {
      if (err instanceof ServiceUnavailableException) throw err;
      const errMsg = err instanceof Error ? err.message : String(err);
      const detail = `支付渠道退款已成功，但内部退款补偿失败: ${errMsg}`;
      await this.markRefundCompensationFailed(order, actualRefundCents, detail, err);
      if (genericCompensationClaim) {
        await this.providerRefundSaga
          .releaseProviderSucceededForCompensationRetry(
            genericCompensationClaim,
            detail,
          );
        genericCompensationClaim = null;
      }
      throw new ServiceUnavailableException(detail);
    }

    if (
      isStripeSubscriptionRefund
      && opts.stripeCancellationLeaseId
    ) {
      await this.markStripeCancellationTaskSucceeded(
        order.id,
        opts.stripeCancellationLeaseId,
      );
    }
    if (genericCompensationClaim) {
      await this.providerRefundSaga.markCompleted(
        genericCompensationClaim,
      );
    }
    return this.prisma.order.findUnique({
      where: { id: orderId },
      include: { plan: true, boosterPack: true },
    });
  }

  private async claimOrderForRefund(
    order: RefundOrderRecord,
    refundAmountCents: number,
    reason: string,
    requireNoRechargeWalletEffects = false,
  ): Promise<boolean> {
    const fromStatus = order.status;
    if (!ORDER_STATUS_TRANSITIONS[fromStatus].has(OrderStatus.REFUNDING)) {
      throw new BadRequestException(`订单状态不允许从 ${fromStatus} 切换到 ${OrderStatus.REFUNDING}`);
    }

    return this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const updated = await tx.order.updateMany({
        where: { id: order.id, status: fromStatus },
        data: {
          status: OrderStatus.REFUNDING,
          refundReason: reason,
          refundAmountCents,
          fulfillmentAttemptId: null,
          fulfillmentClaimedAt: null,
        },
      });
      if (updated.count !== 1) {
        throw new ConflictException('订单退款状态已被并发修改，请刷新后重试');
      }

      let hasRechargeWalletEffects = false;
      if (order.orderType === PrismaOrderType.RECHARGE) {
        // 与 BillingService.rechargeWithBonus 的订单行锁形成同一串行化点。
        // 只有在 REFUNDING claim 已持有行锁后读取效果，才能排除“先判断未入账，
        // 随后并发充值到账”的退款/履约竞态。
        hasRechargeWalletEffects = await this.hasRechargeWalletEffects(order.id, tx);
        if (requireNoRechargeWalletEffects && hasRechargeWalletEffects) {
          throw new RechargeWalletEffectsDetectedError();
        }
      }

      await tx.orderAuditLog.create({
        data: {
          orderId: order.id,
          fromStatus: fromStatus as string,
          toStatus: OrderStatus.REFUNDING,
          operator: 'system',
          detail: reason,
        },
      });
      return hasRechargeWalletEffects;
    });
  }

  private async releaseRedisLock(lockKey: string, lockToken: string): Promise<void> {
    const unlockScript = `
      if redis.call("get", KEYS[1]) == ARGV[1] then
        return redis.call("del", KEYS[1])
      end
      return 0
    `;
    try {
      await this.redis.eval(unlockScript, 1, lockKey, lockToken);
    } catch (err) {
      this.logger.warn(
        `Redis 锁释放失败: key=${lockKey} error=${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }

  private async markRefundCompensationFailed(
    order: {
      id: string;
      userId: string;
      orderType: PrismaOrderType;
      channel: PayChannel | null;
      amountCents: number;
    },
    refundAmountCents: number,
    detail: string,
    err: unknown,
  ): Promise<void> {
    this.logger.error(`退款补偿失败: order=${order.id} detail=${detail}`);
    try {
      await this.transitionOrderStatus(
        order.id,
        OrderStatus.REFUND_COMPENSATION_FAILED,
        'system',
        detail,
      );
    } catch (transitionErr) {
      this.logger.error(
        `退款补偿失败状态写入失败: order=${order.id} error=${
          transitionErr instanceof Error ? transitionErr.message : String(transitionErr)
        }`,
      );
    }

    await this.alertEvents
      ?.createAlert({
        category: 'PAYMENT',
        severity: 'CRITICAL',
        title: '退款补偿失败',
        message: `订单 ${order.id} 支付渠道退款已成功，但内部权益或积分回退失败`,
        sourceType: 'order',
        sourceId: order.id,
        userId: order.userId,
        context: {
          orderType: order.orderType,
          channel: order.channel,
          amountCents: order.amountCents,
          refundAmountCents,
          detail,
          errType: err instanceof Error ? err.constructor.name : 'unknown',
        },
      })
      .catch(() => {});
  }

  private async claimStripeSubscriptionRefundIntent(input: {
    orderId: string;
    fromStatus: OrderStatus;
    refundReason: string;
    refundAmountCents: number;
    subscriptionId: string;
    refundedInvoiceId: string;
    refundedActivationIdempotencyKey:
      StripeSubscriptionRefundEvidence['refundedActivationIdempotencyKey'];
    refundedSubscriptionPeriodId:
      StripeSubscriptionRefundEvidence['refundedSubscriptionPeriodId'];
    originalGrantIdempotencyKey:
      StripeSubscriptionRefundEvidence['originalGrantIdempotencyKey'];
    skipEntitlementCompensation:
      StripeSubscriptionRefundEvidence['skipEntitlementCompensation'];
    paymentProviderInstanceId?: string | null;
  }): Promise<string> {
    if (
      !ORDER_STATUS_TRANSITIONS[input.fromStatus].has(
        OrderStatus.REFUNDING,
      )
    ) {
      throw new BadRequestException(
        `订单状态不允许从 ${input.fromStatus} 切换到 ${OrderStatus.REFUNDING}`,
      );
    }
    const now = new Date();
    const leaseId = `stripe-cancellation:${randomUUID()}`;
    await this.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const claimed = await tx.order.updateMany({
          where: {
            id: input.orderId,
            status: input.fromStatus,
          },
          data: {
            status: OrderStatus.REFUNDING,
            refundReason: input.refundReason,
            refundAmountCents: input.refundAmountCents,
            fulfillmentAttemptId: null,
            fulfillmentClaimedAt: null,
          },
        });
        if (claimed.count !== 1) {
          throw new ConflictException(
            '订单退款状态已被并发修改，请刷新后重试',
          );
        }
        await tx.stripeSubscriptionCancellationTask.create({
          data: {
            orderId: input.orderId,
            subscriptionId: input.subscriptionId,
            refundId: null,
            refundedInvoiceId: input.refundedInvoiceId,
            refundedActivationIdempotencyKey:
              input.refundedActivationIdempotencyKey,
            refundedSubscriptionPeriodId:
              input.refundedSubscriptionPeriodId,
            originalGrantIdempotencyKey:
              input.originalGrantIdempotencyKey,
            skipEntitlementCompensation:
              input.skipEntitlementCompensation,
            paymentProviderInstanceId:
              input.paymentProviderInstanceId ?? null,
            status: RefundCompensationTaskStatus.RUNNING,
            providerCanceledAt: null,
            attempts: 1,
            maxAttempts:
              STRIPE_CANCELLATION_TASK_MAX_ATTEMPTS,
            nextRunAt: now,
            lockedAt: now,
            lockedBy: leaseId,
            lastError: null,
          },
        });
        await tx.orderAuditLog.create({
          data: {
            orderId: input.orderId,
            fromStatus: input.fromStatus,
            toStatus: OrderStatus.REFUNDING,
            operator: 'system',
            detail: input.refundReason,
          },
        });
      },
    );
    return leaseId;
  }

  private async persistStripeSubscriptionCancellationTask(input: {
    orderId: string;
    subscriptionId: string;
    refundId: string;
    refundedInvoiceId: string;
    paymentProviderInstanceId?: string | null;
    error?: string;
    providerCanceledAt?: Date | null;
    leaseId: string;
  }): Promise<void> {
    const existing =
      await this.prisma.stripeSubscriptionCancellationTask.findUnique({
        where: { orderId: input.orderId },
      });
    if (!existing) {
      throw new Error(
        `Stripe subscription refund intent missing for order ${input.orderId}`,
      );
    }
    if (
      existing.orderId !== input.orderId
      || existing.subscriptionId !== input.subscriptionId
      || existing.refundedInvoiceId !== input.refundedInvoiceId
      || existing.paymentProviderInstanceId
        !== (input.paymentProviderInstanceId ?? null)
      || (existing.refundId && existing.refundId !== input.refundId)
    ) {
      throw new Error(
        `Stripe subscription refund outcome binding mismatch for order ${input.orderId}`,
      );
    }
    if (existing.status === RefundCompensationTaskStatus.SUCCEEDED) return;
    const providerCanceledAt =
      existing.providerCanceledAt
      ?? input.providerCanceledAt
      ?? null;
    const updated =
      await this.prisma.stripeSubscriptionCancellationTask.updateMany({
        where: {
          id: existing.id,
          status: { not: RefundCompensationTaskStatus.SUCCEEDED },
          lockedBy: input.leaseId,
        },
        data: {
          refundId: input.refundId,
          status: providerCanceledAt
            ? RefundCompensationTaskStatus.RUNNING
            : RefundCompensationTaskStatus.FAILED,
          providerCanceledAt,
          lastError: providerCanceledAt ? null : input.error,
          nextRunAt: providerCanceledAt
            ? new Date()
            : this.nextStripeCancellationRetryAt(existing.attempts + 1),
          lockedAt: providerCanceledAt ? new Date() : null,
          lockedBy: providerCanceledAt ? input.leaseId : null,
        },
      });
    if (updated.count !== 1) {
      throw new Error(
        `Stripe subscription refund intent lease lost for order ${input.orderId}`,
      );
    }
  }

  private assertStripeSubscriptionRefundIntentBinding(
    task: Pick<
      StripeSubscriptionCancellationTask,
      | 'orderId'
      | 'subscriptionId'
      | 'refundedInvoiceId'
      | 'refundedActivationIdempotencyKey'
      | 'refundedSubscriptionPeriodId'
      | 'originalGrantIdempotencyKey'
      | 'skipEntitlementCompensation'
      | 'paymentProviderInstanceId'
    >,
    input: {
      orderId: string;
      subscriptionId: string;
      refundedInvoiceId: string;
      refundedActivationIdempotencyKey: string;
      refundedSubscriptionPeriodId: string | null;
      originalGrantIdempotencyKey: string | null;
      skipEntitlementCompensation: boolean;
      paymentProviderInstanceId?: string | null;
    },
  ): void {
    if (
      task.orderId !== input.orderId
      || task.subscriptionId !== input.subscriptionId
      || task.refundedInvoiceId !== input.refundedInvoiceId
      || task.refundedActivationIdempotencyKey
        !== input.refundedActivationIdempotencyKey
      || task.refundedSubscriptionPeriodId
        !== input.refundedSubscriptionPeriodId
      || task.originalGrantIdempotencyKey
        !== input.originalGrantIdempotencyKey
      || task.skipEntitlementCompensation
        !== input.skipEntitlementCompensation
      || task.paymentProviderInstanceId !== (input.paymentProviderInstanceId ?? null)
    ) {
      throw new Error(
        `Stripe subscription refund intent binding mismatch for order ${input.orderId}`,
      );
    }
  }

  private async ensureStripeCancellationCompletedBeforeCompensation(
    order: {
      id: string;
      channel: PayChannel | null;
      tradeNo: string | null;
    },
    knownTask?: StripeSubscriptionCancellationTask | null,
    knownLeaseId?: string,
  ): Promise<string | null> {
    if (
      order.channel !== PayChannel.STRIPE
      || !order.tradeNo?.startsWith('sub_')
    ) {
      return null;
    }
    const task = knownTask
      ?? await this.prisma.stripeSubscriptionCancellationTask.findUnique({
        where: { orderId: order.id },
      });
    if (
      !task
      || task.subscriptionId !== order.tradeNo
      || !task.refundedInvoiceId
    ) {
      throw new ServiceUnavailableException(
        `Stripe 订阅 ${order.tradeNo} 缺少退款 intent/evidence，禁止本地退款收口`,
      );
    }
    if (task.status === RefundCompensationTaskStatus.SUCCEEDED) {
      return null;
    }
    if (
      knownLeaseId
      && task.status === RefundCompensationTaskStatus.RUNNING
      && task.lockedBy === knownLeaseId
      && task.providerCanceledAt
    ) {
      return knownLeaseId;
    }

    const claim =
      await this.runStripeSubscriptionCancellationTask(task, true);
    if (!claim) {
      throw new ServiceUnavailableException(
        `Stripe 订阅 ${task.subscriptionId} 尚未确认取消，禁止本地退款收口`,
      );
    }
    return claim.leaseId;
  }

  async runDueStripeSubscriptionCancellationTasks(
    batchSize = 50,
  ): Promise<{
    tasks: number;
    completed: number;
    failed: number;
    manualReview: number;
  }> {
    const now = new Date();
    const staleBefore = new Date(
      now.getTime() - STRIPE_CANCELLATION_TASK_STALE_MS,
    );
    const tasks = await this.prisma.stripeSubscriptionCancellationTask.findMany({
      where: {
        OR: [
          {
            status: {
              in: [
                RefundCompensationTaskStatus.PENDING,
                RefundCompensationTaskStatus.FAILED,
              ],
            },
            nextRunAt: { lte: now },
          },
          {
            status: RefundCompensationTaskStatus.RUNNING,
            lockedAt: { lt: staleBefore },
          },
        ],
      },
      orderBy: [{ nextRunAt: 'asc' }, { createdAt: 'asc' }],
      take: Math.min(Math.max(Math.floor(batchSize), 1), 200),
    });
    let completed = 0;
    let failed = 0;
    let manualReview = 0;

    for (const task of tasks) {
      const claim =
        await this.runStripeSubscriptionCancellationTask(task, false);
      if (!claim) {
        failed += 1;
        if (task.attempts + 1 >= task.maxAttempts) manualReview += 1;
        continue;
      }

      const order = await this.prisma.order.findUnique({
        where: { id: task.orderId },
        select: {
          status: true,
          refundReason: true,
          refundAmountCents: true,
        },
      });
      if (order?.status === OrderStatus.REFUNDED) {
        await this.markStripeCancellationTaskSucceeded(
          task.orderId,
          claim.leaseId,
        );
        completed += 1;
        continue;
      }
      if (
        !order
        || !([
          OrderStatus.REFUNDING,
          OrderStatus.REFUND_FAILED,
          OrderStatus.REFUND_COMPENSATION_FAILED,
        ] as OrderStatus[]).includes(order.status)
      ) {
        await this.releaseStripeCancellationTaskForRetry(
          claim.task,
          `order ${task.orderId} is not ready for local refund compensation: ${order?.status ?? 'missing'}`,
          claim.leaseId,
        );
        failed += 1;
        continue;
      }

      try {
        await this.refundOrder(
          task.orderId,
          order.refundReason ?? 'Stripe 订阅取消完成，继续退款补偿',
          order.refundAmountCents ?? undefined,
          { stripeCancellationLeaseId: claim.leaseId },
        );
        completed += 1;
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        await this.releaseStripeCancellationTaskForRetry(
          claim.task,
          message,
          claim.leaseId,
        );
        this.logger.error(
          `Stripe 订阅已取消但本地退款补偿恢复失败: order=${task.orderId} error=${message}`,
        );
        failed += 1;
      }
    }

    return { tasks: tasks.length, completed, failed, manualReview };
  }

  private async runStripeSubscriptionCancellationTask(
    task: StripeSubscriptionCancellationTask,
    force: boolean,
  ): Promise<{
    task: StripeSubscriptionCancellationTask;
    leaseId: string;
  } | null> {
    const now = new Date();
    const staleBefore = new Date(now.getTime() - STRIPE_CANCELLATION_TASK_STALE_MS);
    const claimableStatuses = force
      ? [
          RefundCompensationTaskStatus.PENDING,
          RefundCompensationTaskStatus.FAILED,
          RefundCompensationTaskStatus.MANUAL_REVIEW,
        ]
      : [
          RefundCompensationTaskStatus.PENDING,
          RefundCompensationTaskStatus.FAILED,
        ];
    const leaseId = `stripe-cancellation:${randomUUID()}`;
    const claimed = await this.prisma.stripeSubscriptionCancellationTask.updateMany({
      where: {
        id: task.id,
        OR: [
          {
            status: { in: claimableStatuses },
            ...(force ? {} : { nextRunAt: { lte: now } }),
          },
          {
            status: RefundCompensationTaskStatus.RUNNING,
            lockedAt: { lt: staleBefore },
          },
        ],
      },
      data: {
        status: RefundCompensationTaskStatus.RUNNING,
        attempts: { increment: 1 },
        lockedAt: now,
        lockedBy: leaseId,
      },
    });
    if (claimed.count !== 1) return null;
    const claimedTask: StripeSubscriptionCancellationTask = {
      ...task,
      status: RefundCompensationTaskStatus.RUNNING,
      attempts: task.attempts + 1,
      lockedAt: now,
      lockedBy: leaseId,
    };

    if (task.providerCanceledAt) {
      return { task: claimedTask, leaseId };
    }

    try {
      if (!task.refundId) {
        const completed =
          await this.resumeStripeSubscriptionRefundIntent(
            claimedTask,
            leaseId,
          );
        return completed ? { task: claimedTask, leaseId } : null;
      }
      const credentials = await this.resolveStripeCredentialsForOrder(
        task.paymentProviderInstanceId,
      );
      const refundStatus = await this.stripeService.retrieveRefundStatus(
        task.refundId,
        credentials,
      );
      if (refundStatus !== 'succeeded') {
        throw new Error(
          `Stripe refund ${task.refundId} has not succeeded: status=${refundStatus}`,
        );
      }
      await this.ensureStripeCancellationRefundLedger(
        claimedTask,
        task.refundId,
        'Stripe subscription cancellation worker confirmed the refund',
      );
      await this.stripeService.cancelSubscription(task.subscriptionId, credentials);
      const canceledAt = new Date();
      await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
        const updated = await tx.stripeSubscriptionCancellationTask.updateMany({
          where: {
            id: task.id,
            status: RefundCompensationTaskStatus.RUNNING,
            lockedBy: leaseId,
          },
          data: {
            providerCanceledAt: canceledAt,
            lastError: null,
          },
        });
        if (updated.count !== 1) {
          throw new Error(`Stripe cancellation task lease lost: ${task.id}`);
        }
        await tx.order.update({
          where: { id: task.orderId },
          data: { providerSubscriptionEndedAt: canceledAt },
        });
      });
      return { task: claimedTask, leaseId };
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.markStripeCancellationTaskFailed(
        claimedTask,
        message,
        leaseId,
      );
      return null;
    }
  }

  private async ensureStripeCancellationRefundLedger(
    task: StripeSubscriptionCancellationTask,
    refundId: string,
    reason: string,
  ): Promise<void> {
    const recorded = await this.recordStripeRefundLedger({
      orderId: task.orderId,
      refundId,
      paymentProviderInstanceId:
        task.paymentProviderInstanceId,
    });
    if (recorded) return;
    await this.persistStripeRefundLedgerRecoveryAlert({
      orderId: task.orderId,
      refundId,
      paymentProviderInstanceId:
        task.paymentProviderInstanceId,
      stripeSubscriptionCancellationTaskId: task.id,
      error: `${reason}, but its ledger snapshot could not be persisted`,
    });
  }

  private async resumeStripeSubscriptionRefundIntent(
    task: StripeSubscriptionCancellationTask,
    leaseId: string,
  ): Promise<boolean> {
    const order = await this.prisma.order.findUnique({
      where: { id: task.orderId },
      select: {
        status: true,
        channel: true,
        tradeNo: true,
        amountCents: true,
        refundAmountCents: true,
        paymentProviderInstanceId: true,
      },
    });
    if (
      !order
      || order.channel !== PayChannel.STRIPE
      || order.tradeNo !== task.subscriptionId
      || order.paymentProviderInstanceId
        !== task.paymentProviderInstanceId
      || !([
          OrderStatus.REFUNDING,
          OrderStatus.REFUND_FAILED,
          OrderStatus.REFUND_COMPENSATION_FAILED,
        ] as OrderStatus[]).includes(order.status)
    ) {
      throw new Error(
        `Stripe subscription refund intent order binding mismatch: ${task.orderId}`,
      );
    }
    const refundCents = order.refundAmountCents ?? order.amountCents;
    const credentials = await this.resolveStripeCredentialsForOrder(
      task.paymentProviderInstanceId,
    );
    const result = await this.stripeService.refundViaSessionOrSubscription(
      task.subscriptionId,
      refundCents,
      credentials,
      this.buildStripeRefundIdempotencyKey(task.orderId, refundCents),
      task.refundedInvoiceId,
    );
    if (
      !result.refundId
      || result.subscriptionId !== task.subscriptionId
      || result.refundedInvoiceId !== task.refundedInvoiceId
      || !result.refundStatus
    ) {
      throw new Error(
        result.error
        ?? `Stripe subscription refund intent did not return exact provider evidence: ${task.orderId}`,
      );
    }

    const cancellationPending =
      result.subscriptionCancellationPending === true;
    const canceledAt =
      result.providerRefundSucceeded && !cancellationPending
        ? new Date()
        : null;
    await this.prisma.$transaction(async (tx: Prisma.TransactionClient) => {
      const updated =
        await tx.stripeSubscriptionCancellationTask.updateMany({
          where: {
            id: task.id,
            status: RefundCompensationTaskStatus.RUNNING,
            lockedBy: leaseId,
          },
          data: {
            refundId: result.refundId,
            providerCanceledAt: canceledAt,
            lastError: result.providerRefundSucceeded
              ? cancellationPending
                ? result.error
                  ?? 'Stripe subscription cancellation not confirmed'
                : null
              : result.error
                ?? `Stripe refund ${result.refundId} has not succeeded: status=${result.refundStatus}`,
          },
        });
      if (updated.count !== 1) {
        throw new Error(`Stripe refund intent lease lost: ${task.id}`);
      }
      if (canceledAt) {
        await tx.order.update({
          where: { id: task.orderId },
          data: { providerSubscriptionEndedAt: canceledAt },
        });
      }
    });
    if (result.providerRefundSucceeded) {
      await this.ensureStripeCancellationRefundLedger(
        task,
        result.refundId,
        'Stripe subscription refund intent recovery confirmed the refund',
      );
    }
    if (!result.providerRefundSucceeded) {
      throw new Error(
        result.error
        ?? `Stripe refund ${result.refundId} has not succeeded: status=${result.refundStatus}`,
      );
    }
    if (cancellationPending) {
      throw new Error(
        result.error
        ?? 'Stripe subscription cancellation not confirmed',
      );
    }
    return true;
  }

  private async releaseStripeCancellationTaskForRetry(
    task: StripeSubscriptionCancellationTask,
    message: string,
    leaseId: string,
  ): Promise<void> {
    await this.markStripeCancellationTaskFailed(task, message, leaseId);
  }

  private async markStripeCancellationTaskFailed(
    task: StripeSubscriptionCancellationTask,
    message: string,
    leaseId: string,
  ): Promise<void> {
    const attempts = task.attempts;
    const manualReview = attempts >= task.maxAttempts;
    const updated = await this.prisma.$transaction(
      async (tx: Prisma.TransactionClient) => {
        const result =
          await tx.stripeSubscriptionCancellationTask.updateMany({
            where: {
              id: task.id,
              status: RefundCompensationTaskStatus.RUNNING,
              lockedBy: leaseId,
            },
            data: {
              status: manualReview
                ? RefundCompensationTaskStatus.MANUAL_REVIEW
                : RefundCompensationTaskStatus.FAILED,
              lockedAt: null,
              lockedBy: null,
              lastError: message,
              nextRunAt: manualReview
                ? task.nextRunAt
                : this.nextStripeCancellationRetryAt(attempts),
            },
          });
        if (result.count !== 1 || !manualReview) {
          return result;
        }

        await tx.alertEvent.create({
          data: {
            category: AlertEventCategory.PAYMENT,
            severity: AlertEventSeverity.CRITICAL,
            title: 'Stripe订阅取消进入人工处理',
            message:
              `订单 ${task.orderId} 的 Stripe 订阅 ${task.subscriptionId} 多次取消失败，需人工处理`,
            sourceType: 'order',
            sourceId: task.orderId,
            context: JSON.stringify({
              taskId: task.id,
              subscriptionId: task.subscriptionId,
              refundId: task.refundId,
              paymentProviderInstanceId: task.paymentProviderInstanceId,
              attempts,
              error: message,
            }),
          },
        });
        return result;
      },
    );
    if (updated.count !== 1) {
      this.logger.warn(
        `Stripe cancellation task lease lost before failure write: task=${task.id}`,
      );
    }
  }

  private async markStripeCancellationTaskSucceeded(
    orderId: string,
    leaseId: string,
  ): Promise<void> {
    const updated =
      await this.prisma.stripeSubscriptionCancellationTask.updateMany({
      where: {
        orderId,
        providerCanceledAt: { not: null },
        status: { not: RefundCompensationTaskStatus.SUCCEEDED },
        lockedBy: leaseId,
      },
      data: {
        status: RefundCompensationTaskStatus.SUCCEEDED,
        completedAt: new Date(),
        lockedAt: null,
        lockedBy: null,
        lastError: null,
      },
    });
    if (updated.count === 0) {
      const task =
        await this.prisma.stripeSubscriptionCancellationTask.findUnique({
          where: { orderId },
          select: { status: true },
        });
      if (task?.status !== RefundCompensationTaskStatus.SUCCEEDED) {
        throw new Error(
          `Stripe cancellation task lease lost for order ${orderId}`,
        );
      }
    }
  }

  private nextStripeCancellationRetryAt(attempts: number): Date {
    const baseMs = 60_000;
    const delayMs = Math.min(
      baseMs * (2 ** Math.max(0, Math.min(attempts - 1, 8))),
      6 * 60 * 60 * 1000,
    );
    return new Date(Date.now() + delayMs);
  }

  async runDueProviderRefundIntents(
    batchSize = 50,
  ): Promise<{
    tasks: number;
    completed: number;
    pending: number;
    failed: number;
    manualReview: number;
  }> {
    const tasks = await this.providerRefundSaga.findDue(batchSize);
    const result = {
      tasks: tasks.length,
      completed: 0,
      pending: 0,
      failed: 0,
      manualReview: 0,
    };
    for (const task of tasks) {
      try {
        await this.processProviderRefundIntent(task.id, 'worker');
      } catch (err) {
        this.logger.error(
          `provider refund worker failed: task=${task.id} order=${task.orderId} error=${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
      const latest = await this.providerRefundSaga.findByOrderId(task.orderId);
      if (!latest) {
        result.failed += 1;
      } else if (latest.status === ProviderRefundIntentStatus.COMPLETED) {
        result.completed += 1;
      } else if (
        latest.status === ProviderRefundIntentStatus.PROVIDER_FAILED
      ) {
        result.failed += 1;
      } else if (
        latest.status === ProviderRefundIntentStatus.MANUAL_REVIEW
      ) {
        result.manualReview += 1;
      } else {
        result.pending += 1;
      }
    }
    return result;
  }

  private async processProviderRefundIntent(
    taskId: string,
    trigger: 'inline' | 'worker',
  ): Promise<void> {
    let claimed = await this.providerRefundSaga.claim(taskId);
    if (!claimed) return;

    if (
      claimed.previousStatus ===
        ProviderRefundIntentStatus.PROVIDER_SUCCEEDED
      || claimed.task.providerConfirmedAt
    ) {
      await this.completeConfirmedProviderRefund(claimed, trigger);
      return;
    }

    let outcome: ProviderRefundOutcome;
    try {
      outcome =
        claimed.previousStatus === ProviderRefundIntentStatus.PREPARED
          ? await this.submitProviderRefund(claimed.task)
          : await this.queryProviderRefund(claimed.task);
    } catch (err) {
      const error = err instanceof Error ? err.message : String(err);
      outcome =
        err instanceof SelfOperatedCodingPlanRefundHoldRetryError
          ? {
              state: 'NOT_FOUND',
              providerStatus: 'LOCAL_REFUND_HOLD_RETRY',
              error,
            }
          : err instanceof SelfOperatedCodingPlanRefundEligibilityError
            ? {
                state: 'FAILED',
                providerStatus: 'LOCAL_REFUND_ELIGIBILITY_LOST',
                error,
              }
            : {
                state: 'UNKNOWN',
                providerStatus: 'REQUEST_OUTCOME_UNKNOWN',
                error,
              };
    }

    const status =
      await this.providerRefundSaga.recordProviderOutcome(claimed, outcome);
    if (status === ProviderRefundIntentStatus.PROVIDER_FAILED) {
      return;
    }
    if (status !== ProviderRefundIntentStatus.PROVIDER_SUCCEEDED) {
      return;
    }

    claimed = await this.providerRefundSaga.claim(taskId);
    if (!claimed) return;
    await this.completeConfirmedProviderRefund(claimed, trigger);
  }

  private async submitProviderRefund(
    task: ProviderRefundIntent,
  ): Promise<ProviderRefundOutcome> {
    const order = await this.prisma.order.findUnique({
      where: { id: task.orderId },
      include: {
        plan: true,
        boosterPack: true,
        items: { include: { plan: true, boosterPack: true } },
      },
    });
    this.assertProviderRefundTaskOrderBinding(task, order);
    await this.ensureSelfOperatedCodingPlanRefundReady(
      order!,
      task.amountCents,
    );
    const result = await this.refundViaChannel(
      order!,
      task.amountCents,
      task.reason,
    );
    return result.providerOutcome ?? {
      state: result.success ? 'SUCCEEDED' : 'UNKNOWN',
      providerStatus: result.success
        ? 'SUCCEEDED'
        : 'REQUEST_OUTCOME_UNKNOWN',
      refundId: result.refundId,
      error: result.error,
    };
  }

  private async ensureSelfOperatedCodingPlanRefundReady(
    order: RefundOrderRecord,
    actualRefundCents: number,
  ): Promise<void> {
    if (
      order.orderType !== PrismaOrderType.SUBSCRIPTION
      || !order.productId
    ) {
      return;
    }
    const fulfillmentMode =
      await this.findOrderCodingPlanFulfillmentMode(order.id);
    if (!fulfillmentMode) return;
    if (
      fulfillmentMode === CodingPlanFulfillmentMode.provider_resale
    ) {
      throw new SelfOperatedCodingPlanRefundEligibilityError(
        'PROVIDER_RESALE_UNSUPPORTED',
        '供应商转售套餐暂不支持自动退款，请人工核对上游权益',
      );
    }
    const evidence =
      await this.refundCompensation
        .assertUnusedSelfOperatedCodingPlanRefundHeld(
          order,
          actualRefundCents,
        );
    await this.refundCompensation
      .syncSelfOperatedCodingPlanRefundHoldRequired(
        evidence.entitlementId,
      );
    await this.refundCompensation
      .assertUnusedSelfOperatedCodingPlanRefundHeld(
        order,
        actualRefundCents,
        evidence,
      );
  }

  private async findOrderCodingPlanFulfillmentMode(
    orderId: string,
  ): Promise<CodingPlanFulfillmentMode | null> {
    const entitlement = await this.prisma.codingPlanEntitlement.findUnique({
      where: { orderId },
      select: { fulfillmentMode: true },
    });
    return entitlement?.fulfillmentMode ?? null;
  }

  private async queryProviderRefund(
    task: ProviderRefundIntent,
  ): Promise<ProviderRefundOutcome> {
    if (task.channel === PayChannel.WECHAT) {
      return this.wechatPayService.queryRefund(task.requestNo);
    }
    if (task.channel === PayChannel.ALIPAY) {
      const credentials =
        await this.resolveAlipayCredentialsForOrder(
          task.paymentProviderInstanceId,
        );
      return this.alipayService.queryRefund(
        task.tradeNo,
        task.requestNo,
        credentials,
      );
    }
    if (task.channel === PayChannel.STRIPE) {
      if (!task.providerRefundId) {
        // Stripe cannot retrieve a refund when the create response was lost.
        // Re-submit with the same idempotency key to recover the same object.
        return this.submitProviderRefund(task);
      }
      const credentials =
        await this.resolveStripeCredentialsForOrder(
          task.paymentProviderInstanceId,
        );
      const refundStatus =
        await this.stripeService.retrieveRefundStatus(
          task.providerRefundId,
          credentials,
        );
      const outcome = this.normalizeStripeRefundOutcome(
        task.providerRefundId,
        refundStatus,
      );
      if (outcome.state === 'SUCCEEDED') {
        const recorded = await this.recordStripeRefundLedger({
          orderId: task.orderId,
          refundId: task.providerRefundId,
          paymentProviderInstanceId:
            task.paymentProviderInstanceId,
        });
        if (!recorded) {
          await this.persistStripeRefundLedgerRecoveryAlert({
            orderId: task.orderId,
            refundId: task.providerRefundId,
            paymentProviderInstanceId:
              task.paymentProviderInstanceId,
            providerRefundIntentId: task.id,
            error:
              'Stripe refund was confirmed during provider recovery, but its ledger snapshot could not be persisted',
          });
        }
      }
      return outcome;
    }
    return {
      state: 'FAILED',
      providerStatus: 'UNSUPPORTED_CHANNEL',
      error: `该支付渠道不支持退款恢复: ${task.channel}`,
    };
  }

  private async completeConfirmedProviderRefund(
    claimed: ClaimedProviderRefundIntent,
    trigger: 'inline' | 'worker',
  ): Promise<void> {
    const task = claimed.task;
    if (!task.providerConfirmedAt) {
      throw new Error(
        `provider refund ${task.id} lacks terminal success evidence`,
      );
    }
    const order = await this.prisma.order.findUnique({
      where: { id: task.orderId },
      include: {
        plan: true,
        boosterPack: true,
        items: { include: { plan: true, boosterPack: true } },
      },
    });
    this.assertProviderRefundTaskOrderBinding(task, order);
    if (order!.status === OrderStatus.REFUNDED) {
      await this.providerRefundSaga.markCompleted(claimed);
      return;
    }
    if (
      order!.status !== OrderStatus.REFUNDING
      && order!.status !== OrderStatus.REFUND_COMPENSATION_FAILED
    ) {
      await this.providerRefundSaga
        .releaseProviderSucceededForCompensationRetry(
          claimed,
          `order status does not permit compensation: ${order!.status}`,
        );
      return;
    }

    try {
      if (
        task.skipRechargeBalanceCompensation
        && await this.hasRechargeWalletEffects(order!.id)
      ) {
        throw new Error(
          `refund recharge effects appeared after atomic claim: ${order!.id}`,
        );
      }
      await this.refundCompensation.preflightOrderCompensation(
        order!,
        task.amountCents,
        {
          ...(task.skipEntitlementCompensation
            ? { skipEntitlementCompensation: true }
            : {}),
          ...(task.skipRechargeBalanceCompensation
            ? { skipRechargeBalanceCompensation: true }
            : {}),
        },
      );
      const compensation =
        await this.refundCompensation.prepareAndRun(
          order!,
          task.amountCents,
          {
            reason: task.reason,
            trigger: `provider-refund-${trigger}`,
            ...(task.skipEntitlementCompensation
              ? { skipEntitlementCompensation: true }
              : {}),
            ...(task.skipRechargeBalanceCompensation
              ? { skipRechargeBalanceCompensation: true }
              : {}),
          },
        );
      if (!compensation.complete) {
        throw new Error(
          compensation.error
          ?? 'refund compensation task did not complete',
        );
      }
      const latestOrder = await this.prisma.order.findUnique({
        where: { id: task.orderId },
        select: { status: true },
      });
      if (latestOrder?.status !== OrderStatus.REFUNDED) {
        throw new Error('refund compensation completed without REFUNDED order');
      }
      await this.providerRefundSaga.markCompleted(claimed);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      await this.markRefundCompensationFailed(
        order!,
        task.amountCents,
        `支付渠道退款已确认成功，但内部退款补偿失败: ${message}`,
        err,
      );
      await this.providerRefundSaga
        .releaseProviderSucceededForCompensationRetry(claimed, message);
    }
  }

  private assertProviderRefundTaskOrderBinding(
    task: ProviderRefundIntent,
    order: RefundOrderRecord | null,
  ): void {
    if (
      !order
      || order.id !== task.orderId
      || order.channel !== task.channel
      || order.tradeNo !== task.tradeNo
      || order.currency.toUpperCase() !== task.currency
      || order.paymentProviderInstanceId
        !== task.paymentProviderInstanceId
      || (order.refundAmountCents ?? order.amountCents) !== task.amountCents
      || (
        task.channel === PayChannel.STRIPE
        && task.tradeNo.startsWith('sub_')
      )
    ) {
      throw new Error(
        `provider refund intent/order binding mismatch: ${task.id}`,
      );
    }
  }

  private normalizeStripeRefundOutcome(
    refundId: string,
    refundStatus: string,
  ): ProviderRefundOutcome {
    const normalized = refundStatus.trim().toLowerCase();
    if (normalized === 'succeeded') {
      return {
        state: 'SUCCEEDED',
        providerStatus: normalized,
        refundId,
      };
    }
    if (normalized === 'failed' || normalized === 'canceled') {
      return {
        state: 'FAILED',
        providerStatus: normalized,
        refundId,
        error: `Stripe refund ${refundId} ended with status=${normalized}`,
      };
    }
    return {
      state: 'PENDING',
      providerStatus: normalized || 'unknown',
      refundId,
    };
  }

  private async refundViaChannel(
    order: Prisma.OrderGetPayload<{ include: { plan: true; boosterPack: true } }>,
    refundCents: number,
    reason: string,
    expectedStripeSubscriptionInvoiceId?: string,
  ): Promise<ChannelRefundResult> {
    if (!order.tradeNo) {
      return { success: false, error: '订单缺少支付流水号，无法发起退款' };
    }

    if (order.channel === PayChannel.WECHAT) {
      const result = await this.wechatPayService.refund(
        order.tradeNo,
        order.id,
        order.amountCents,
        refundCents,
        this.buildProviderRefundRequestNo(order.id, refundCents),
      );
      return {
        success: result.success,
        error: result.error,
        refundId: result.refundId,
        providerOutcome: {
          state:
            result.state
            ?? (result.success ? 'SUCCEEDED' : 'UNKNOWN'),
          providerStatus:
            result.providerStatus
            ?? (result.success ? 'SUCCESS' : 'REQUEST_OUTCOME_UNKNOWN'),
          refundId: result.refundId,
          error: result.error,
        },
      };
    }

    if (order.channel === PayChannel.ALIPAY) {
      const credentials = await this.resolveAlipayCredentialsForOrder(order.paymentProviderInstanceId);
      const result = await this.alipayService.refund(
        order.tradeNo,
        refundCents,
        reason,
        credentials,
        this.buildProviderRefundRequestNo(order.id, refundCents),
      );
      return {
        success: result.success,
        error: result.error,
        providerOutcome: {
          state:
            result.state
            ?? (result.success ? 'SUCCEEDED' : 'UNKNOWN'),
          providerStatus:
            result.providerStatus
            ?? (result.success ? '10000' : 'REQUEST_OUTCOME_UNKNOWN'),
          error: result.error,
        },
      };
    }

    if (order.channel === PayChannel.STRIPE) {
      const credentials = await this.resolveStripeCredentialsForOrder(order.paymentProviderInstanceId);
      const result = await this.stripeService.refundViaSessionOrSubscription(
        order.tradeNo,
        refundCents,
        credentials,
        this.buildStripeRefundIdempotencyKey(order.id, refundCents),
        expectedStripeSubscriptionInvoiceId,
      );
      if (result.refundId && result.providerRefundSucceeded) {
        const recorded = await this.recordStripeRefundLedger({
          orderId: order.id,
          refundId: result.refundId,
          paymentProviderInstanceId: order.paymentProviderInstanceId,
        });
        if (!recorded) {
          this.logger.error(`Stripe 退款成功但本地台账记录失败: order=${order.id}`);
          await this.persistStripeRefundLedgerRecoveryAlert({
            orderId: order.id,
            refundId: result.refundId,
            paymentProviderInstanceId:
              order.paymentProviderInstanceId,
            error:
              'Stripe refund succeeded, but its ledger snapshot could not be persisted',
          });
        }
      }
      const subscriptionRefund = this.stripeSubscriptionRefundFromResult(result);
      if (subscriptionRefund) {
        return {
          success: result.success,
          error: result.error,
          refundId: result.refundId,
          stripeSubscriptionRefund: subscriptionRefund,
        };
      }
      const providerOutcome = result.refundId && result.refundStatus
        ? this.normalizeStripeRefundOutcome(
            result.refundId,
            result.refundStatus,
          )
        : result.success
          ? {
              state: 'SUCCEEDED' as const,
              providerStatus: 'succeeded',
              ...(result.refundId ? { refundId: result.refundId } : {}),
            }
        : {
            state: 'UNKNOWN' as const,
            providerStatus: 'REQUEST_OUTCOME_UNKNOWN',
            ...(result.refundId ? { refundId: result.refundId } : {}),
            ...(result.error ? { error: result.error } : {}),
          };
      return {
        success: result.success,
        error: result.error,
        refundId: result.refundId,
        providerOutcome,
      };
    }

    return { success: false, error: '该支付渠道暂不支持退款' };
  }

  private stripeSubscriptionRefundFromResult(
    result: StripeRefundResult,
  ): ChannelRefundResult['stripeSubscriptionRefund'] | null {
    if (
      !result.refundId
      || !result.subscriptionId
      || !result.refundedInvoiceId
      || !result.refundStatus
    ) {
      return null;
    }
    return {
      subscriptionId: result.subscriptionId,
      refundId: result.refundId,
      refundedInvoiceId: result.refundedInvoiceId,
      providerRefundSucceeded:
        result.providerRefundSucceeded === true,
      refundStatus: result.refundStatus,
      cancellationPending: result.subscriptionCancellationPending === true,
      ...(result.error ? { error: result.error } : {}),
    };
  }

  private async hasRechargeWalletEffects(
    orderId: string,
    db: Prisma.TransactionClient | PrismaService = this.prisma,
  ): Promise<boolean> {
    const [transaction, grant] = await Promise.all([
      db.balanceTransaction.findFirst({
        where: {
          orderId,
          type: {
            in: [PrismaTransactionType.RECHARGE, PrismaTransactionType.ADJUST],
          },
        },
        select: { id: true },
      }),
      db.balanceGrant.findUnique({
        where: { orderId },
        select: { id: true },
      }),
    ]);
    return Boolean(transaction || grant);
  }

  private buildProviderRefundRequestNo(orderId: string, refundCents: number): string {
    return `refund_${orderId}_${refundCents}`;
  }

  private buildStripeRefundIdempotencyKey(orderId: string, refundCents: number): string {
    return `refund:${orderId}:${refundCents}`;
  }

  /**
   * fire-and-forget: 通知 SaaS 端清除用户积分缓存
   */
  private async notifyCreditChangedByUserId(userId: string, productId: string | null | undefined): Promise<void> {
    try {
      const [user, product] = await Promise.all([
        this.prisma.user.findUnique({ where: { id: userId }, select: { email: true } }),
        productId
          ? this.prisma.product.findFirst({ where: { id: productId, deletedAt: null }, select: { slug: true } })
          : null,
      ]);
      if (user?.email && product?.slug) {
        this.productSync.notifyCreditChanged(user.email, product.slug).catch(() => {});
      }
    } catch { /* non-critical */ }
  }

  private requireTenantId(subject: { tenantId?: string | null }): string {
    const tenantId = subject.tenantId?.trim();
    if (!tenantId) {
      throw new BadRequestException('订单必须绑定账号 tenantId');
    }
    return tenantId;
  }

  private toOrder(order: {
    id: string;
    userId: string;
    tenantId?: string | null;
    orderType?: string;
    bundleSkuId?: string | null;
    productId?: string | null;
    planId: string | null;
    boosterPackId?: string | null;
    amountCents: number;
    rechargeTierId?: string | null;
    bonusCents?: number | null;
    billingPeriod?: string | null;
    prorationCreditCents?: number | null;
    status: string;
    channel: string | null;
    tradeNo: string | null;
    paidAt: Date | null;
    refundedAt?: Date | null;
    refundReason?: string | null;
    createdAt: Date;
  }): Order {
    return {
      id: order.id,
      userId: order.userId,
      tenantId: order.tenantId ?? null,
      orderType: (order.orderType as OrderType) ?? OrderType.SUBSCRIPTION,
      bundleSkuId: order.bundleSkuId ?? null,
      productId: order.productId ?? null,
      planId: order.planId,
      boosterPackId: order.boosterPackId ?? null,
      amountCents: order.amountCents,
      rechargeTierId: order.rechargeTierId ?? null,
      bonusCents: order.bonusCents ?? 0,
      totalGrantedCents: order.amountCents + (order.bonusCents ?? 0),
      billingPeriod: (order.billingPeriod as BillingPeriod | null) ?? null,
      prorationCreditCents: order.prorationCreditCents ?? null,
      status: order.status as SharedOrderStatus,
      channel: order.channel as PaymentChannel | null,
      tradeNo: order.tradeNo,
      paidAt: order.paidAt?.toISOString() ?? null,
      refundedAt: order.refundedAt?.toISOString() ?? null,
      refundReason: order.refundReason ?? null,
      createdAt: order.createdAt.toISOString(),
    };
  }

  /**
   * PR0-4: 在 active RechargeTier 中匹配 (productId, amountCents)。
   *
   * 决策（spec §9.4 / §12）：
   *  - 时间窗口外或 isActive=false → 静默 fallback（返回 null），按无 bonus 走。
   *  - 用户传 claimedTierId 但找不到匹配 → 抛 400（防止前端误传错绑定）。
   *  - 多条同 (productId, amountCents) 命中（A/B 同时启用）→ 取 sortOrder 最小的，
   *    保证可预测；admin 在 CRUD 层已有 overlapWarning 提示运营人。
   *  - PERCENT 类型 bonusValue > 100 → 防御性丢弃（schema 已约束，运行时再检一遍）。
   */
  private async resolveRechargeTier(
    productId: string,
    amountCents: number,
    claimedTierId: string | undefined,
  ): Promise<{ tierId: string; bonusCents: number } | null> {
    const now = new Date();
    const candidates = await this.prisma.rechargeTier.findMany({
      where: {
        productId,
        amountCents,
        isActive: true,
        deletedAt: null,
        AND: [
          { OR: [{ startAt: null }, { startAt: { lte: now } }] },
          { OR: [{ endAt: null }, { endAt: { gte: now } }] },
        ],
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      take: 5,
    });

    if (candidates.length === 0) {
      // 用户传了 tierId 但没匹配 → 拒绝。
      if (claimedTierId) {
        throw new BadRequestException('指定的充值面额与金额不匹配或不可用');
      }
      return null;
    }

    const winner = candidates[0];

    // 用户主张某个 tierId → 必须与 winner 一致（防止前端绑错 tier）。
    if (claimedTierId && claimedTierId !== winner.id) {
      throw new BadRequestException('指定的充值面额与金额不匹配或不可用');
    }

    let bonusCents = 0;
    if (winner.bonusType === RechargeBonusType.FIXED) {
      bonusCents = Math.max(0, winner.bonusValue);
    } else if (winner.bonusType === RechargeBonusType.PERCENT) {
      const pct = winner.bonusValue;
      if (pct < 0 || pct > 100) {
        // 防御性：schema 已约束，但运行时若数据漂移到非法值，丢弃 bonus。
        this.logger.warn(
          `RechargeTier ${winner.id} PERCENT bonusValue=${pct} 越界，跳过 bonus`,
        );
        return null;
      }
      bonusCents = Math.floor((amountCents * pct) / 100);
    }

    if (bonusCents <= 0) {
      // 命中了 tier 但赠送为 0（PERCENT=0 / FIXED=0），无需后续处理。
      return null;
    }

    return { tierId: winner.id, bonusCents };
  }

  private async resolvePaygProductId(productId?: string | null): Promise<string | null> {
    if (productId) {
      const product = await this.prisma.product.findFirst({
        where: {
          id: productId,
          isActive: true,
          deletedAt: null,
          billingMode: 'PAY_AS_YOU_GO',
        },
        select: { id: true },
      });
      if (!product) {
        throw new BadRequestException('按量产品不存在或未启用');
      }
      return product.id;
    }

    const explicitConfiguredSlug =
      this.config.get<string>('PAYG_PRODUCT_SLUG') ||
      this.config.get<string>('API_PRODUCT_SLUG');
    const legacyConfiguredSlug = this.config.get<string>('VITE_PRODUCT_SLUG');

    if (explicitConfiguredSlug) {
      const configuredProduct = await this.prisma.product.findFirst({
        where: {
          slug: explicitConfiguredSlug,
          isActive: true,
          deletedAt: null,
          billingMode: 'PAY_AS_YOU_GO',
        },
        select: { id: true },
      });
      if (!configuredProduct) {
        throw new BadRequestException(`默认 PAYG 产品不存在或未启用: ${explicitConfiguredSlug}`);
      }
      return configuredProduct.id;
    }
    if (legacyConfiguredSlug) {
      const configuredProduct = await this.prisma.product.findFirst({
        where: {
          slug: legacyConfiguredSlug,
          isActive: true,
          deletedAt: null,
          billingMode: 'PAY_AS_YOU_GO',
        },
        select: { id: true },
      });
      if (configuredProduct) return configuredProduct.id;
    }

    const candidates = await this.prisma.product.findMany({
      where: {
        isActive: true,
        deletedAt: null,
        billingMode: 'PAY_AS_YOU_GO',
        NOT: { slug: { startsWith: 'e2e', mode: 'insensitive' } },
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
      select: { id: true },
      take: 2,
    });
    if (candidates.length === 1) return candidates[0].id;
    if (candidates.length === 0) {
      throw new BadRequestException('未配置可用的 PAYG 产品，充值需要 productId');
    }
    throw new BadRequestException('存在多个 PAYG 产品，充值需要显式传入 productId');
  }

  /**
   * PR0-4: 把命中的 tier 暂存到 Redis；履约时读取，应用后删除。
   * 不写时（rechargeTierMatch=null）直接 no-op，避免无谓的 Redis 操作。
   */
  private async persistRechargeTierContext(
    orderId: string,
    match: { tierId: string; bonusCents: number } | null,
  ): Promise<void> {
    if (!match) return;
    try {
      await this.redis.set(
        rechargeTierKey(orderId),
        JSON.stringify(match),
        'EX',
        RECHARGE_TIER_TTL_SECONDS,
      );
    } catch (err) {
      // 失败仅 warn —— 用户主充值仍能成功，bonus 拿不到是次要后果。
      this.logger.warn(
        `RechargeTier 上下文写入 Redis 失败 order=${orderId}: ${err}`,
      );
    }
  }

  /**
   * PR0-4: 履约时读 Redis 上下文，给 bonus 写一行 BalanceTransaction(ADJUST)。
   *
   * 与主 RECHARGE 流水语义衔接：
   *   - 主 RECHARGE 已 incrby + 写 RECHARGE 行；这里再 incrby + 写 ADJUST 行。
   *   - 两条 BalanceTransaction.balanceAfterCents 都来自 Redis 真实值，连续。
   *   - description 编码 `recharge-bonus tier:{tierId}` 用于追溯。
   *
   * PR0-4 review fix(Important #1): 幂等。
   *   - retryFulfill 在订单 PAID/FULFILLING/COMPLETED 时被运营手工触发会重入此处；
   *     creditBonus 内部以 (orderId, ADJUST, description) 三元组去重，
   *     重入返回原 BalanceTransaction、不重复 incrby。
   *   - fulfillOrder 自身已被 redis lock 保护（lockKey=`fulfill:${orderId}`），
   *     正常流程不会并发；幂等是给手工 retry 兜底。
   *   - 传入 idempotencyKey: `bonus:{orderId}` 作为可读标识（实际去重锚在 orderId）。
   *
   * PR0-4 review fix(Minor #4): 失败保留 Redis context。
   *   - 成功路径：del key（一次性消费）。
   *   - 失败路径：不 del，让 30 天 TTL 自然过期，运营在此期间可查 Redis 拿到
   *     原始 tierId/bonusCents 用于手工补发或排查，比丢失上下文 + 救火重建更稳。
   *     损坏 JSON 仍 del（无可恢复的语义）。
   */
  private async applyRechargeTierBonus(
    orderId: string,
    userId: string,
    productId: string | null,
    tenantId?: string | null,
    persisted?: { tierId?: string | null; bonusCents?: number | null },
  ): Promise<void> {
    const key = rechargeTierKey(orderId);
    let tierId = persisted?.tierId ?? undefined;
    let bonusCents = persisted?.bonusCents ?? undefined;
    let raw: string | null = null;
    let loadedFromRedis = false;

    if (!tierId || typeof bonusCents !== 'number' || bonusCents <= 0) {
      raw = await this.redis.get(key);
      if (!raw) return;
      loadedFromRedis = true;

      let parsed: { tierId?: string; bonusCents?: number };
      try {
        parsed = JSON.parse(raw);
      } catch {
        this.logger.warn(`RechargeTier 上下文 JSON 损坏 order=${orderId}: ${raw}`);
        // 损坏的 key 无可恢复的 tierId/bonusCents → del；仍写一行 audit 让运营可见。
        await this.redis.del(key).catch(() => {});
        await this.recordBonusFailureAudit(orderId, null, 0, userId, `corrupted redis context: ${raw}`);
        return;
      }

      tierId = parsed.tierId;
      bonusCents = parsed.bonusCents;
    }

    if (!tierId || typeof bonusCents !== 'number' || bonusCents <= 0) {
      // 数据无效（无 tierId 或 bonusCents 非正）→ 无业务语义，安全清理。
      if (loadedFromRedis) {
        await this.redis.del(key).catch(() => {});
      }
      return;
    }

    try {
      await this.billingService.creditBonus(
        userId,
        bonusCents,
        `recharge-bonus tier:${tierId}`,
        orderId,
        productId
          ? { idempotencyKey: `bonus:${orderId}`, productId, tenantId }
          : { idempotencyKey: `bonus:${orderId}`, tenantId },
      );
    } catch (err) {
      // 失败：写 audit row + 结构化日志 + 保留 Redis context（不 del），
      // 让运营有依据手工补发。重新抛给上层（fulfillOrder catch + warn）。
      const errMsg = err instanceof Error ? err.message : String(err);
      this.logger.error(
        `RECHARGE bonus 应用失败 order=${orderId} userId=${userId} tierId=${tierId} bonusCents=${bonusCents} error=${errMsg}`,
      );
      await this.recordBonusFailureAudit(orderId, tierId, bonusCents, userId, errMsg);
      throw err;
    }

    // 仅成功路径 del key；失败路径保留 30 天给运营查证。
    await this.redis.del(key).catch(() => {});
  }

  /**
   * PR0-4 review fix(Important #2): bonus 失败 audit trail。
   *
   * 复用现有 OrderAuditLog 表（无需新建表）：
   *   - operator='system:bonus' 区别于状态迁移产生的行（operator='system'/'callback:*'）。
   *   - fromStatus=toStatus='BONUS_FAILED'（语义标签，不是真实订单状态变更，不会
   *     与 transitionOrderStatus 写的真实状态冲突）。
   *   - detail 用 JSON 字符串编码 {tierId, bonusCents, userId, error}，
   *     运营查 audit log 时一行就有全部信息可手工补发。
   *
   * 自身错误吞掉（仅 logger.warn）—— audit 失败不应阻塞主链路。
   */
  private async recordBonusFailureAudit(
    orderId: string,
    tierId: string | null,
    bonusCents: number,
    userId: string,
    error: string,
  ): Promise<void> {
    try {
      await this.prisma.orderAuditLog.create({
        data: {
          orderId,
          fromStatus: 'BONUS_FAILED',
          toStatus: 'BONUS_FAILED',
          operator: 'system:bonus',
          detail: JSON.stringify({ tierId, bonusCents, userId, error }),
        },
      });
    } catch (e) {
      this.logger.warn(
        `bonus failure audit 写入失败 order=${orderId}: ${(e as Error).message}`,
      );
    }
  }

  /**
   * 支付成功后记录折扣核销。
   * - Campaign → campaign_redemptions
   * - DiscountCode → discount_code_redemptions + current_uses++
   *
   * 设计上"尽力而为" — 如果写失败不影响订单发放（已扣积分/订阅），只写警告日志。
   */
  private async recordDiscountRedemptions(order: {
    id: string;
    userId: string;
    campaignId: string | null;
    discountCodeId: string | null;
    discountAmountCents: number | null;
  }) {
    const saved = order.discountAmountCents ?? 0;
    if (saved <= 0) return;

    // 幂等：同 orderId 不重复记录
    if (order.campaignId) {
      const existing = await this.prisma.campaignRedemption.findFirst({
        where: { orderId: order.id },
      });
      if (!existing) {
        await this.prisma.campaignRedemption.create({
          data: {
            campaignId: order.campaignId,
            userId: order.userId,
            orderId: order.id,
            amountSavedCents: saved,
          },
        });
      }
    }
    const discountCodeId = order.discountCodeId;
    if (discountCodeId) {
      await this.prisma.$transaction(async (tx) => {
        await tx.$executeRaw`SELECT pg_advisory_xact_lock(hashtext(${`discount-code:${discountCodeId}`}))`;
        const existing = await tx.discountCodeRedemption.findFirst({
          where: { orderId: order.id },
        });
        if (existing) return;

        const code = await tx.discountCode.findUnique({
          where: { id: discountCodeId },
          select: {
            id: true,
            isActive: true,
            maxUses: true,
            maxUsesPerUser: true,
            currentUses: true,
          },
        });
        if (!code?.isActive) {
          throw new BadRequestException('促销码无效');
        }
        if (code.maxUses > 0 && code.currentUses >= code.maxUses) {
          throw new BadRequestException('促销码已使用完');
        }
        if (code.maxUsesPerUser > 0) {
          const used = await tx.discountCodeRedemption.count({
            where: {
              discountCodeId,
              userId: order.userId,
            },
          });
          if (used >= code.maxUsesPerUser) {
            throw new BadRequestException('促销码使用次数已达上限');
          }
        }

        const updated = code.maxUses > 0
          ? await tx.discountCode.updateMany({
              where: {
                id: discountCodeId,
                currentUses: { lt: code.maxUses },
              },
              data: { currentUses: { increment: 1 } },
            })
          : await tx.discountCode
              .update({
                where: { id: discountCodeId },
                data: { currentUses: { increment: 1 } },
              })
              .then(() => ({ count: 1 }));
        if (updated.count !== 1) {
          throw new BadRequestException('促销码已使用完');
        }

        await tx.discountCodeRedemption.create({
          data: {
            discountCodeId,
            userId: order.userId,
            orderId: order.id,
            amountSavedCents: saved,
          },
        });
      });
    }
  }
}
