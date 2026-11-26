import {
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// eslint-disable-next-line @typescript-eslint/no-require-imports
const Stripe = require('stripe');

export interface StripeCredentials {
  secretKey?: string | null;
  webhookSecret?: string | null;
}

export interface StripeLedgerSnapshot {
  transactionType: 'payment' | 'refund';
  checkoutSessionId?: string | null;
  subscriptionId?: string | null;
  invoiceId?: string | null;
  paymentIntentId?: string | null;
  chargeId?: string | null;
  refundId?: string | null;
  balanceTransactionId?: string | null;
  payoutId?: string | null;
  amountCents?: number | null;
  feeCents?: number | null;
  netCents?: number | null;
  currency?: string | null;
  stripeStatus?: string | null;
  customerEmail?: string | null;
  stripeCreatedAt?: Date | null;
  availableOn?: Date | null;
  rawPayload?: Record<string, unknown> | null;
}

export interface StripeRefundResult {
  success: boolean;
  refundId?: string;
  refundStatus?: string;
  error?: string;
  /**
   * The money has already been refunded at Stripe, but the recurring
   * subscription has not yet been confirmed canceled. Callers must persist a
   * cancellation retry before doing any local refund compensation.
   */
  providerRefundSucceeded?: boolean;
  /**
   * Stripe created a refund object but has not reached the only terminal
   * success state (`succeeded`). Callers must persist the refund id and poll it;
   * they must not cancel recurring billing or compensate local effects yet.
   */
  providerRefundPending?: boolean;
  subscriptionCancellationPending?: boolean;
  subscriptionId?: string;
  /**
   * Immutable invoice whose payment intent was refunded. Subscription refund
   * compensation must use this identity to reverse the matching local renewal
   * receipt rather than assuming the original checkout period.
   */
  refundedInvoiceId?: string;
}

export interface StripeSubscriptionRefundPreparation {
  subscriptionId: string;
  invoiceId: string;
  amountCents: number;
}

/**
 * 在 URL 上追加一段查询参数。支持 url 已经带 ?foo=bar 或纯净 URL。
 * 用于拼 success_url = <frontend>?order_id=xxx&session_id={CHECKOUT_SESSION_ID}
 * —— Stripe 会把 {CHECKOUT_SESSION_ID} 原样放在 URL 里替换。
 */
function appendQuery(url: string, kv: string): string {
  if (!url) return url;
  return url.includes('?') ? `${url}&${kv}` : `${url}?${kv}`;
}

function appendOrderId(url: string, orderId: string): string {
  if (!url || /(?:\?|&)order_id=/.test(url)) return url;
  return appendQuery(url, `order_id=${encodeURIComponent(orderId)}`);
}

function cleanMetadata(metadata: Record<string, string | null | undefined>): Record<string, string> {
  return Object.fromEntries(
    Object.entries(metadata)
      .filter(([, value]) => value !== null && value !== undefined && value !== '')
      .map(([key, value]) => [key, String(value)]),
  );
}

@Injectable()
export class StripeService {
  private readonly logger = new Logger(StripeService.name);
  private readonly clients = new Map<string, any>();
  private readonly secretKey: string | undefined;
  private readonly webhookSecret: string | undefined;

  constructor(private readonly config: ConfigService) {
    this.secretKey = this.config.get<string>('STRIPE_SECRET_KEY');
    this.webhookSecret = this.config.get<string>('STRIPE_WEBHOOK_SECRET');
  }

  /** 懒加载 Stripe 客户端 */
  private getClient(credentials?: StripeCredentials): any {
    const secretKey = this.resolveSecretKey(credentials);
    let client = this.clients.get(secretKey);
    if (!client) {
      client = new Stripe(secretKey);
      this.clients.set(secretKey, client);
    }
    return client;
  }

  private resolveSecretKey(credentials?: StripeCredentials): string {
    const secretKey = credentials?.secretKey?.trim() || this.secretKey?.trim();
    if (!secretKey) {
      throw new ServiceUnavailableException('Stripe 未配置');
    }
    return secretKey;
  }

  private resolveWebhookSecret(credentials?: StripeCredentials): string {
    const webhookSecret = credentials?.webhookSecret?.trim() || this.webhookSecret?.trim();
    if (!webhookSecret) {
      throw new ServiceUnavailableException('Stripe Webhook Secret 未配置');
    }
    return webhookSecret;
  }

  async createOneTimeAmountOffCoupon(params: {
    name: string;
    amountOffCents: number;
    currency: string;
    metadata: Record<string, string>;
    idempotencyKey: string;
    credentials?: StripeCredentials;
  }): Promise<string> {
    if (params.amountOffCents <= 0) {
      throw new Error(`Coupon amount_off 必须大于 0，收到 ${params.amountOffCents}`);
    }
    const stripe = this.getClient(params.credentials);
    const coupon = await stripe.coupons.create(
      {
        name: params.name.slice(0, 40),
        amount_off: params.amountOffCents,
        currency: params.currency,
        duration: 'once',
        metadata: params.metadata,
      },
      { idempotencyKey: params.idempotencyKey },
    );
    this.logger.log(
      `Stripe 一次性折扣 Coupon 创建成功: id=${coupon.id}, amount=${params.amountOffCents} ${params.currency}`,
    );
    return coupon.id;
  }

  // ============================
  // Checkout Session（一次性支付）
  // ============================

  async createCheckoutSession(params: {
    orderId: string;
    amountCents: number;
    currency: string;
    description: string;
    successUrl: string;
    cancelUrl: string;
    customerEmail?: string;
    /**
     * Stripe payment_method_types 白名单。
     * 默认 ['card', 'alipay'] —— 让 Stripe Checkout 页面让用户自选支付方式，
     * 与 Manus / Cursor 的主流做法对齐。Link / Google Pay / Apple Pay 等方式
     * 由 Stripe Dashboard 的 Payment methods 开关自动注入，代码不需要列出。
     */
    paymentMethodTypes?: string[];
    /**
     * 折扣活动/促销码的 Stripe Coupon ID。
     * 注意：checkout.sessions 一次性支付的 unit_amount 仍然是"原价"，
     * 由 Stripe 在结算页面应用 coupon 抵扣。这样前端看到原价 + 抵扣，
     * 对账也清晰（amount_total 反映实际扣款）。
     *
     * 仅允许系统已决策并记录在订单上下文中的 coupon。不要开启
     * allow_promotion_codes；Stripe 侧未记录的页面输入折扣会让 webhook
     * amount_total 低于订单金额，触发本服务的资金校验并卡住履约。
     */
    couponId?: string | null;
    metadata?: Record<string, string | null | undefined>;
    credentials?: StripeCredentials;
  }): Promise<{ sessionId: string; url: string }> {
    const stripe = this.getClient(params.credentials);
    const paymentMethodTypes = params.paymentMethodTypes && params.paymentMethodTypes.length > 0
      ? params.paymentMethodTypes
      : ['card', 'alipay'];

    this.logger.log(
      `Stripe Checkout 下单: orderId=${params.orderId}, amount=${params.amountCents} ${params.currency}, methods=${paymentMethodTypes.join(',')}`,
    );

    const metadata = cleanMetadata({
      ...(params.metadata ?? {}),
      orderId: params.orderId,
    });
    const sessionParams: any = {
      mode: 'payment',
      payment_method_types: paymentMethodTypes,
      client_reference_id: params.orderId,
      line_items: [
        {
          price_data: {
            currency: params.currency,
            product_data: { name: params.description },
            unit_amount: params.amountCents,
          },
          quantity: 1,
        },
      ],
      metadata,
      payment_intent_data: { metadata },
      customer_email: params.customerEmail || undefined,
      // success_url 可能已带 query，Stripe 要求 {CHECKOUT_SESSION_ID} 占位符可放在 query 里
      success_url: appendQuery(
        appendOrderId(params.successUrl, params.orderId),
        'session_id={CHECKOUT_SESSION_ID}',
      ),
      cancel_url: appendOrderId(params.cancelUrl, params.orderId),
      // 为未来 Stripe Tax / 发票合规收集账单地址
      billing_address_collection: 'auto',
    };
    if (params.couponId) {
      sessionParams.discounts = [{ coupon: params.couponId }];
    }
    const session = await stripe.checkout.sessions.create(
      sessionParams,
      { idempotencyKey: `checkout:${params.orderId}` },
    );

    if (!session.url) {
      throw new Error('Stripe Checkout Session 创建失败：未返回 URL');
    }

    return { sessionId: session.id, url: session.url };
  }

  // ============================
  // Subscription（自动续费订阅）
  // ============================

  async createSubscription(params: {
    orderId: string;
    planName: string;
    amountCents: number;
    currency: string;
    interval: 'month' | 'year';
    intervalCount?: number;
    customerEmail: string;
    successUrl: string;
    cancelUrl: string;
    /**
     * 默认 ['card']。Stripe 订阅模式对 alipay 有严格限制（需要 Dashboard
     * 开 recurring + Stripe 白名单），默认账号会被拒："The payment method
     * `alipay` cannot be used in `subscription` mode."。一律先走 card-only，
     * Link / Google Pay / Apple Pay 由 Stripe Dashboard 开关自动注入到 card 上。
     * alipay 付款体验放在 orderType=RECHARGE / BOOSTER_PACK 的一次性 Checkout 场景。
     */
    paymentMethodTypes?: string[];
    /**
     * Stripe Coupon ID。订阅模式下 coupon.duration 决定生命周期：
     * - 'once'：仅首期扣减（活动价 + 折扣码首单都走这个，续期按原价）
     * - 'forever' / 'repeating'：持续抵扣（仅部分促销码使用）
     */
    couponId?: string | null;
    metadata?: Record<string, string | null | undefined>;
    credentials?: StripeCredentials;
  }): Promise<{ sessionId: string; url: string }> {
    const stripe = this.getClient(params.credentials);
    const paymentMethodTypes = params.paymentMethodTypes && params.paymentMethodTypes.length > 0
      ? params.paymentMethodTypes
      : ['card'];

    this.logger.log(
      `Stripe Subscription 下单: orderId=${params.orderId}, plan=${params.planName}, amount=${params.amountCents} ${params.currency}/${params.interval}, methods=${paymentMethodTypes.join(',')}`,
    );

    const metadata = cleanMetadata({
      ...(params.metadata ?? {}),
      orderId: params.orderId,
    });
    const subParams: any = {
      mode: 'subscription',
      payment_method_types: paymentMethodTypes,
      client_reference_id: params.orderId,
      line_items: [
        {
          price_data: {
            currency: params.currency,
            product_data: { name: params.planName },
            unit_amount: params.amountCents,
            recurring: {
              interval: params.interval,
              ...(params.intervalCount && params.intervalCount > 1 ? { interval_count: params.intervalCount } : {}),
            },
          },
          quantity: 1,
        },
      ],
      metadata,
      subscription_data: { metadata },
      customer_email: params.customerEmail || undefined,
      success_url: appendQuery(
        appendOrderId(params.successUrl, params.orderId),
        'session_id={CHECKOUT_SESSION_ID}',
      ),
      cancel_url: appendOrderId(params.cancelUrl, params.orderId),
      // 为未来 Stripe Tax / 发票合规收集账单地址
      billing_address_collection: 'auto',
    };
    if (params.couponId) {
      // subscription 模式必须用 subscription_data.coupon，不能用顶层 discounts
      subParams.subscription_data = { ...(subParams.subscription_data ?? {}), coupon: params.couponId };
    }
    const session = await stripe.checkout.sessions.create(
      subParams,
      { idempotencyKey: `checkout:${params.orderId}` },
    );

    if (!session.url) {
      throw new Error('Stripe Subscription Session 创建失败：未返回 URL');
    }

    return { sessionId: session.id, url: session.url };
  }

  async createMixedSubscriptionCheckout(params: {
    orderId: string;
    bundleName: string;
    currency: string;
    recurringItems: Array<{
      name: string;
      amountCents: number;
      interval: 'month' | 'year';
      quantity?: number;
    }>;
    oneTimeItems: Array<{
      name: string;
      amountCents: number;
      quantity?: number;
    }>;
    customerEmail: string;
    successUrl: string;
    cancelUrl: string;
    paymentMethodTypes?: string[];
    couponId?: string | null;
    metadata?: Record<string, string | null | undefined>;
    credentials?: StripeCredentials;
  }): Promise<{ sessionId: string; url: string }> {
    const stripe = this.getClient(params.credentials);
    const paymentMethodTypes = params.paymentMethodTypes && params.paymentMethodTypes.length > 0
      ? params.paymentMethodTypes
      : ['card'];
    if (params.recurringItems.length === 0 || params.oneTimeItems.length === 0) {
      throw new Error('Stripe mixed checkout requires recurring and one-time items');
    }

    this.logger.log(
      `Stripe Bundle Subscription 下单: orderId=${params.orderId}, bundle=${params.bundleName}, recurring=${params.recurringItems.length}, oneTime=${params.oneTimeItems.length}`,
    );

    const lineItems = [
      ...params.recurringItems.map((item) => ({
        price_data: {
          currency: params.currency,
          product_data: { name: item.name },
          unit_amount: item.amountCents,
          recurring: { interval: item.interval },
        },
        quantity: item.quantity ?? 1,
      })),
      ...params.oneTimeItems.map((item) => ({
        price_data: {
          currency: params.currency,
          product_data: { name: item.name },
          unit_amount: item.amountCents,
        },
        quantity: item.quantity ?? 1,
      })),
    ];

    const metadata = cleanMetadata({
      ...(params.metadata ?? {}),
      orderId: params.orderId,
    });
    const sessionParams: any = {
      mode: 'subscription',
      payment_method_types: paymentMethodTypes,
      client_reference_id: params.orderId,
      line_items: lineItems,
      metadata,
      subscription_data: {
        metadata,
      },
      customer_email: params.customerEmail || undefined,
      success_url: appendQuery(
        appendOrderId(params.successUrl, params.orderId),
        'session_id={CHECKOUT_SESSION_ID}',
      ),
      cancel_url: appendOrderId(params.cancelUrl, params.orderId),
      billing_address_collection: 'auto',
    };
    if (params.couponId) {
      sessionParams.subscription_data.coupon = params.couponId;
    }

    const session = await stripe.checkout.sessions.create(
      sessionParams,
      { idempotencyKey: `checkout:${params.orderId}` },
    );
    if (!session.url) {
      throw new Error('Stripe Bundle Subscription Session 创建失败：未返回 URL');
    }
    return { sessionId: session.id, url: session.url };
  }

  // ============================
  // Webhook 签名验证
  // ============================

  verifyWebhook(
    payload: string | Buffer,
    signature: string,
    credentials?: StripeCredentials,
  ): any {
    const stripe = this.getClient(credentials);
    const webhookSecret = this.resolveWebhookSecret(credentials);
    return stripe.webhooks.constructEvent(
      payload,
      signature,
      webhookSecret,
    );
  }

  async retrieveCheckoutLedgerSnapshot(
    sessionId: string,
    credentials?: StripeCredentials,
  ): Promise<StripeLedgerSnapshot> {
    const stripe = this.getClient(credentials);
    const session = await stripe.checkout.sessions.retrieve(
      sessionId,
      {
        expand: [
          'payment_intent.latest_charge.balance_transaction',
          'invoice.payment_intent.latest_charge.balance_transaction',
          'subscription.latest_invoice.payment_intent.latest_charge',
        ],
      },
    );
    return this.buildPaymentLedgerSnapshot(stripe, session);
  }

  async retrieveSubscriptionLedgerSnapshot(
    subscriptionId: string,
    credentials?: StripeCredentials,
  ): Promise<StripeLedgerSnapshot> {
    const stripe = this.getClient(credentials);
    const subscription = await stripe.subscriptions.retrieve(
      subscriptionId,
      {
        expand: ['latest_invoice.payment_intent.latest_charge.balance_transaction'],
      },
    );
    const invoice = this.asObject(subscription.latest_invoice);
    const paymentIntent = this.asObject(invoice?.payment_intent);
    return this.buildPaymentLedgerSnapshot(stripe, {
      subscription,
      invoice,
      payment_intent: paymentIntent,
      amount_total:
        this.asNumber(invoice?.amount_paid) ??
        this.asNumber(invoice?.amount_due) ??
        this.asNumber(paymentIntent?.amount_received) ??
        this.asNumber(paymentIntent?.amount),
      currency: invoice?.currency ?? subscription.currency,
      payment_status: invoice?.status,
      status: subscription.status,
      customer_email: invoice?.customer_email,
      created: invoice?.created ?? subscription.created,
    });
  }

  async retrieveRefundLedgerSnapshot(
    refundId: string,
    credentials?: StripeCredentials,
  ): Promise<StripeLedgerSnapshot> {
    const stripe = this.getClient(credentials);
    const refund = await stripe.refunds.retrieve(
      refundId,
      {
        expand: [
          'balance_transaction',
          'charge.balance_transaction',
          'payment_intent.latest_charge.balance_transaction',
        ],
      },
    );
    return this.buildRefundLedgerSnapshot(stripe, refund);
  }

  // ============================
  // 退款
  // ============================

  /**
   * 通过 Checkout Session ID 或 Subscription ID 发起退款。
   * - 一次性支付：retrieve session → 获取 payment_intent → refund
   * - 订阅：解析 subscription.latest_invoice.payment_intent → refund，然后尝试取消订阅
   */
  async refundViaSessionOrSubscription(
    sessionIdOrSubscriptionId: string,
    amountCents?: number,
    credentials?: StripeCredentials,
    idempotencyKey?: string,
    expectedSubscriptionInvoiceId?: string,
  ): Promise<StripeRefundResult> {
    const stripe = this.getClient(credentials);

    // 1) 先尝试作为 Checkout Session 解析
    //    - 有 payment_intent → 一次性支付，走 refunds.create
    //    - 有 subscription   → 订阅支付，取 session.subscription 后退订阅发票 refund
    //    - 两者都没有        → 落到下一步按原始 id 当订阅 id 解析
    let resolvedSubscriptionId: string | null = null;
    try {
      const session = await stripe.checkout.sessions.retrieve(
        sessionIdOrSubscriptionId,
        {
          expand: [
            'payment_intent',
            'invoice.payment_intent',
            'subscription.latest_invoice.payment_intent',
          ],
        },
      );
      const sessionPaymentIntentId = this.extractStripeId(session.payment_intent) ||
        this.extractStripeId(session.invoice?.payment_intent);
      if (sessionPaymentIntentId) {
        const refund = await this.createRefund(
          stripe,
          {
            payment_intent: sessionPaymentIntentId,
            amount: amountCents,
          },
          idempotencyKey,
        );
        if (refund.status === 'succeeded') {
          return {
            success: true,
            refundId: refund.id,
            refundStatus: refund.status,
            providerRefundSucceeded: true,
          };
        }
        return {
          success: false,
          refundId: refund.id,
          refundStatus: refund.status,
          providerRefundPending: this.isPendingRefundStatus(refund.status),
          error:
            `Stripe refund ${refund.id} has not succeeded: status=${refund.status}`,
        };
      }
      if (session.subscription) {
        // 订阅类 session —— 取出真实 subscription id
        resolvedSubscriptionId =
          typeof session.subscription === 'string'
            ? session.subscription
            : session.subscription.id;
      }
    } catch {
      // 不是 session ID，继续按原始 id 作为 subscription 处理
    }

    // 2) 订阅退款。优先用从 session 解析出来的 subscription id，
    //    否则直接用入参（允许调用方直接传 sub_xxx）。
    const targetSubId = resolvedSubscriptionId ?? sessionIdOrSubscriptionId;
    let refund: { id: string; status: string };
    let refundedInvoiceId: string;
    try {
      const result = await this.refundLatestSubscriptionInvoice(
        stripe,
        targetSubId,
        amountCents,
        idempotencyKey,
        expectedSubscriptionInvoiceId,
      );
      refund = result.refund;
      refundedInvoiceId = result.invoiceId;
    } catch (err) {
      const message =
        err instanceof Error ? err.message : 'Stripe refund failed';
      this.logger.error(`Stripe 退款失败: ${message}`);
      return { success: false, error: message };
    }

    if (refund.status !== 'succeeded') {
      const message =
        `Stripe refund ${refund.id} has not succeeded: status=${refund.status}`;
      this.logger.error(
        `${message}, subscription=${targetSubId}, invoice=${refundedInvoiceId}`,
      );
      return {
        success: false,
        refundId: refund.id,
        refundStatus: refund.status,
        providerRefundPending: this.isPendingRefundStatus(refund.status),
        subscriptionId: targetSubId,
        refundedInvoiceId,
        error: message,
      };
    }

    try {
      await this.ensureSubscriptionCanceled(stripe, targetSubId);
      return {
        success: true,
        refundId: refund.id,
        refundStatus: refund.status,
        providerRefundSucceeded: true,
        subscriptionId: targetSubId,
        refundedInvoiceId,
      };
    } catch (cancelErr) {
      const cancelMessage = cancelErr instanceof Error
        ? cancelErr.message
        : 'Stripe subscription cancellation failed';
      this.logger.error(
        `Stripe 订阅已退款但取消未确认: subscription=${targetSubId} refund=${refund.id} error=${cancelMessage}`,
      );
      return {
        success: false,
        refundId: refund.id,
        refundStatus: refund.status,
        error: cancelMessage,
        providerRefundSucceeded: true,
        subscriptionCancellationPending: true,
        subscriptionId: targetSubId,
        refundedInvoiceId,
      };
    }
  }

  /**
   * Idempotently confirms that a provider subscription is canceled. A
   * non-canceled response is an error, not a warning: the caller owns a durable
   * retry task and must not close the local refund until this method succeeds.
   */
  async cancelSubscription(
    subscriptionId: string,
    credentials?: StripeCredentials,
  ): Promise<void> {
    const stripe = this.getClient(credentials);
    await this.ensureSubscriptionCanceled(stripe, subscriptionId);
  }

  async retrieveRefundStatus(
    refundId: string,
    credentials?: StripeCredentials,
  ): Promise<string> {
    const stripe = this.getClient(credentials);
    const refund = await stripe.refunds.retrieve(refundId);
    return this.requireRefundStatus(refund, refundId);
  }

  /**
   * Read-only preflight for the irreversible subscription refund. The caller
   * persists the returned invoice identity together with exact local-effect
   * evidence before it invokes refundViaSessionOrSubscription.
   */
  async prepareSubscriptionRefund(
    subscriptionId: string,
    amountCents: number,
    credentials?: StripeCredentials,
  ): Promise<StripeSubscriptionRefundPreparation> {
    const stripe = this.getClient(credentials);
    const target = await this.resolveSubscriptionRefundTarget(
      stripe,
      subscriptionId,
      amountCents,
    );
    return {
      subscriptionId,
      invoiceId: target.invoiceId,
      amountCents,
    };
  }

  private async refundLatestSubscriptionInvoice(
    stripe: any,
    subscriptionId: string,
    amountCents?: number,
    idempotencyKey?: string,
    expectedInvoiceId?: string,
  ): Promise<{
    refund: { id: string; status: string };
    invoiceId: string;
  }> {
    const target = await this.resolveSubscriptionRefundTarget(
      stripe,
      subscriptionId,
      amountCents,
      expectedInvoiceId,
    );

    const refund = await this.createRefund(
      stripe,
      {
        payment_intent: target.paymentIntentId,
        amount: amountCents,
      },
      idempotencyKey,
    );
    return { refund, invoiceId: target.invoiceId };
  }

  private async resolveSubscriptionRefundTarget(
    stripe: any,
    subscriptionId: string,
    amountCents?: number,
    expectedInvoiceId?: string,
  ): Promise<{
    invoiceId: string;
    paymentIntentId: string;
  }> {
    let invoice: Record<string, any>;
    let invoiceId: string;
    if (expectedInvoiceId) {
      invoiceId = expectedInvoiceId;
      invoice = await stripe.invoices.retrieve(invoiceId, {
        expand: ['payment_intent'],
      });
      const invoiceSubscriptionId = this.extractStripeId(invoice.subscription);
      if (invoiceSubscriptionId !== subscriptionId) {
        throw new Error(
          `Stripe invoice ${invoiceId} does not belong to subscription ${subscriptionId}`,
        );
      }
    } else {
      const subscription = await stripe.subscriptions.retrieve(subscriptionId, {
        expand: ['latest_invoice.payment_intent'],
      });
      invoiceId = this.extractStripeId(subscription.latest_invoice) ?? '';
      if (!invoiceId) {
        throw new Error(
          `Stripe subscription ${subscriptionId} 缺少可退款的 latest_invoice`,
        );
      }
      invoice = this.asObject(subscription.latest_invoice)
        ?? await stripe.invoices.retrieve(invoiceId, {
          expand: ['payment_intent'],
        });
    }

    const paymentIntentId = this.extractStripeId(invoice.payment_intent);
    if (!paymentIntentId) {
      throw new Error(
        `Stripe subscription ${subscriptionId} 缺少可退款的 payment_intent`,
      );
    }
    if (amountCents !== undefined) {
      const invoicePaidCents = this.asNumber(invoice.amount_paid);
      if (
        !Number.isSafeInteger(invoicePaidCents)
        || invoicePaidCents! < 0
        || amountCents !== invoicePaidCents
      ) {
        throw new Error(
          `Stripe subscription ${subscriptionId} refund amount does not match invoice ${invoiceId}`,
        );
      }
    }
    return { invoiceId, paymentIntentId };
  }

  private createRefund(
    stripe: any,
    params: { payment_intent: string; amount?: number },
    idempotencyKey?: string,
  ): Promise<{ id: string; status: string }> {
    const create = idempotencyKey
      ? stripe.refunds.create(params, { idempotencyKey })
      : stripe.refunds.create(params);
    return Promise.resolve(create).then((refund) => ({
      id: this.extractStripeId(refund) ?? '',
      status: this.requireRefundStatus(
        refund,
        this.extractStripeId(refund) ?? 'unknown',
      ),
    }));
  }

  private requireRefundStatus(
    refund: Record<string, unknown> | null | undefined,
    refundId: string,
  ): string {
    const status =
      typeof refund?.status === 'string'
        ? refund.status.trim().toLowerCase()
        : '';
    if (
      !refundId
      || ![
        'pending',
        'requires_action',
        'succeeded',
        'failed',
        'canceled',
      ].includes(status)
    ) {
      throw new Error(
        `Stripe refund ${refundId || 'unknown'} returned invalid status=${status || 'missing'}`,
      );
    }
    return status;
  }

  private isPendingRefundStatus(status: string): boolean {
    return status === 'pending' || status === 'requires_action';
  }

  private async ensureSubscriptionCanceled(
    stripe: any,
    subscriptionId: string,
  ): Promise<void> {
    const current = await stripe.subscriptions.retrieve(subscriptionId);
    if (current?.status === 'canceled') return;

    const canceled = await stripe.subscriptions.cancel(subscriptionId);
    if (canceled?.status !== 'canceled') {
      const status = typeof canceled?.status === 'string'
        ? canceled.status
        : 'unknown';
      throw new Error(
        `Stripe subscription ${subscriptionId} cancel returned status=${status}`,
      );
    }
  }

  private async buildPaymentLedgerSnapshot(stripe: any, session: any): Promise<StripeLedgerSnapshot> {
    const invoice = this.asObject(session.invoice) ?? this.asObject(session.subscription?.latest_invoice);
    const paymentIntent =
      this.asObject(session.payment_intent) ??
      this.asObject(session.invoice?.payment_intent) ??
      this.asObject(session.subscription?.latest_invoice?.payment_intent);
    const paymentIntentId =
      this.extractStripeId(paymentIntent) ??
      this.extractStripeId(session.payment_intent) ??
      this.extractStripeId(session.invoice?.payment_intent) ??
      this.extractStripeId(session.subscription?.latest_invoice?.payment_intent);
    const charge = await this.resolveCharge(stripe, paymentIntent);
    const balanceTransaction = await this.resolveBalanceTransaction(stripe, charge?.balance_transaction);
    const amountCents =
      this.asNumber(balanceTransaction?.amount) ??
      this.asNumber(session.amount_total) ??
      this.asNumber(charge?.amount) ??
      this.asNumber(paymentIntent?.amount_received) ??
      this.asNumber(paymentIntent?.amount);

    return {
      transactionType: 'payment',
      checkoutSessionId: this.extractStripeId(session),
      subscriptionId: this.extractStripeId(session.subscription),
      invoiceId: this.extractStripeId(invoice) ?? this.extractStripeId(session.invoice),
      paymentIntentId,
      chargeId: this.extractStripeId(charge),
      balanceTransactionId: this.extractStripeId(balanceTransaction) ?? this.extractStripeId(charge?.balance_transaction),
      payoutId: this.extractStripeId(balanceTransaction?.payout),
      amountCents,
      feeCents: this.asNumber(balanceTransaction?.fee),
      netCents: this.asNumber(balanceTransaction?.net),
      currency: this.asString(balanceTransaction?.currency ?? charge?.currency ?? paymentIntent?.currency ?? session.currency)?.toUpperCase(),
      stripeStatus: this.asString(charge?.status ?? paymentIntent?.status ?? session.payment_status ?? session.status),
      customerEmail: this.asString(
        session.customer_email ??
        session.customer_details?.email ??
        charge?.billing_details?.email ??
        paymentIntent?.receipt_email,
      ),
      stripeCreatedAt:
        this.unixToDate(balanceTransaction?.created) ??
        this.unixToDate(charge?.created) ??
        this.unixToDate(paymentIntent?.created) ??
        this.unixToDate(session.created),
      availableOn: this.unixToDate(balanceTransaction?.available_on),
      rawPayload: this.toJsonObject({
        session,
        paymentIntent,
        charge,
        balanceTransaction,
      }),
    };
  }

  private async buildRefundLedgerSnapshot(stripe: any, refund: any): Promise<StripeLedgerSnapshot> {
    const charge = await this.resolveCharge(stripe, refund.charge ?? refund.payment_intent?.latest_charge);
    const paymentIntent = this.asObject(refund.payment_intent);
    const balanceTransaction =
      await this.resolveBalanceTransaction(stripe, refund.balance_transaction) ??
      await this.resolveBalanceTransaction(stripe, charge?.balance_transaction);
    const refundAmount = this.asNumber(refund.amount);
    const amountCents = this.asNumber(balanceTransaction?.amount) ?? (refundAmount == null ? null : -Math.abs(refundAmount));

    return {
      transactionType: 'refund',
      paymentIntentId:
        this.extractStripeId(paymentIntent) ??
        this.extractStripeId(refund.payment_intent),
      chargeId: this.extractStripeId(charge) ?? this.extractStripeId(refund.charge),
      refundId: this.extractStripeId(refund),
      balanceTransactionId: this.extractStripeId(balanceTransaction) ?? this.extractStripeId(refund.balance_transaction),
      payoutId: this.extractStripeId(balanceTransaction?.payout),
      amountCents,
      feeCents: this.asNumber(balanceTransaction?.fee),
      netCents: this.asNumber(balanceTransaction?.net),
      currency: this.asString(balanceTransaction?.currency ?? refund.currency ?? charge?.currency)?.toUpperCase(),
      stripeStatus: this.asString(refund.status),
      customerEmail: this.asString(charge?.billing_details?.email),
      stripeCreatedAt:
        this.unixToDate(balanceTransaction?.created) ??
        this.unixToDate(refund.created),
      availableOn: this.unixToDate(balanceTransaction?.available_on),
      rawPayload: this.toJsonObject({
        refund,
        paymentIntent,
        charge,
        balanceTransaction,
      }),
    };
  }

  private async resolveCharge(stripe: any, value: unknown): Promise<any | null> {
    const maybeObject = this.asObject(value);
    if (maybeObject?.object === 'charge') return maybeObject;
    const latestCharge = maybeObject?.latest_charge;
    const latestChargeObject = this.asObject(latestCharge);
    if (latestChargeObject) return latestChargeObject;
    const chargeId = this.extractStripeId(latestCharge ?? value);
    if (!chargeId || !chargeId.startsWith('ch_')) return null;
    return stripe.charges.retrieve(chargeId, { expand: ['balance_transaction'] });
  }

  private async resolveBalanceTransaction(stripe: any, value: unknown): Promise<any | null> {
    const maybeObject = this.asObject(value);
    if (maybeObject?.object === 'balance_transaction') return maybeObject;
    const balanceTransactionId = this.extractStripeId(value);
    if (!balanceTransactionId) return null;
    return stripe.balanceTransactions.retrieve(balanceTransactionId);
  }

  private asObject(value: unknown): Record<string, any> | null {
    return value && typeof value === 'object' ? value as Record<string, any> : null;
  }

  private asNumber(value: unknown): number | null {
    return typeof value === 'number' && Number.isFinite(value) ? value : null;
  }

  private asString(value: unknown): string | null {
    return typeof value === 'string' && value ? value : null;
  }

  private unixToDate(value: unknown): Date | null {
    const seconds = this.asNumber(value);
    return seconds == null ? null : new Date(seconds * 1000);
  }

  private toJsonObject(value: unknown): Record<string, unknown> | null {
    try {
      return JSON.parse(JSON.stringify(value)) as Record<string, unknown>;
    } catch {
      return null;
    }
  }

  private extractStripeId(value: unknown): string | null {
    if (typeof value === 'string' && value) return value;
    if (value && typeof value === 'object' && 'id' in value) {
      const id = (value as { id?: unknown }).id;
      return typeof id === 'string' && id ? id : null;
    }
    return null;
  }
}
