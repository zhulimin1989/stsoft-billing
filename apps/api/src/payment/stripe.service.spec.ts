import { StripeService } from './stripe.service';
import { ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';

// Mock the stripe module before import
const mockSessionsCreate = jest.fn();
const mockSessionsRetrieve = jest.fn();
const mockChargesRetrieve = jest.fn();
const mockBalanceTransactionsRetrieve = jest.fn();
const mockInvoicesRetrieve = jest.fn();
const mockRefundsCreate = jest.fn();
const mockRefundsRetrieve = jest.fn();
const mockSubscriptionsCancel = jest.fn();
const mockSubscriptionsRetrieve = jest.fn();
const mockWebhooksConstructEvent = jest.fn();
const mockCouponsCreate = jest.fn();

jest.mock('stripe', () => {
  return jest.fn().mockImplementation(() => ({
    checkout: {
      sessions: {
        create: mockSessionsCreate,
        retrieve: mockSessionsRetrieve,
      },
    },
    charges: {
      retrieve: mockChargesRetrieve,
    },
    balanceTransactions: {
      retrieve: mockBalanceTransactionsRetrieve,
    },
    refunds: {
      create: mockRefundsCreate,
      retrieve: mockRefundsRetrieve,
    },
    invoices: {
      retrieve: mockInvoicesRetrieve,
    },
    subscriptions: {
      cancel: mockSubscriptionsCancel,
      retrieve: mockSubscriptionsRetrieve,
    },
    coupons: {
      create: mockCouponsCreate,
    },
    webhooks: {
      constructEvent: mockWebhooksConstructEvent,
    },
  }));
});
const StripeMock = require('stripe') as jest.Mock;

function makeConfig(overrides: Record<string, string> = {}): ConfigService {
  const defaults: Record<string, string> = {
    STRIPE_SECRET_KEY: 'sk_test_abc123',
    STRIPE_WEBHOOK_SECRET: 'whsec_test_xyz',
    ...overrides,
  };
  return {
    get: jest.fn((k: string) => defaults[k]),
  } as unknown as ConfigService;
}

beforeEach(() => {
  StripeMock.mockClear();
  mockSessionsCreate.mockReset();
  mockSessionsRetrieve.mockReset();
  mockChargesRetrieve.mockReset();
  mockBalanceTransactionsRetrieve.mockReset();
  mockInvoicesRetrieve.mockReset();
  mockRefundsCreate.mockReset();
  mockRefundsRetrieve.mockReset();
  mockSubscriptionsCancel.mockReset();
  mockSubscriptionsRetrieve.mockReset();
  mockWebhooksConstructEvent.mockReset();
  mockCouponsCreate.mockReset();
});

// ============================================================
// createCheckoutSession
// ============================================================
describe('StripeService.createCheckoutSession', () => {
  it('returns sessionId and url on success', async () => {
    mockSessionsCreate.mockResolvedValue({
      id: 'cs_test_123',
      url: 'https://checkout.stripe.com/pay/cs_test_123',
    });

    const service = new StripeService(makeConfig());
    const result = await service.createCheckoutSession({
      orderId: 'order-1',
      amountCents: 9900,
      currency: 'usd',
      description: 'Pro Plan',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
      customerEmail: 'user@example.com',
    });

    expect(result.sessionId).toBe('cs_test_123');
    expect(result.url).toBe('https://checkout.stripe.com/pay/cs_test_123');
  });

  it('passes correct line_items with amount and currency', async () => {
    mockSessionsCreate.mockResolvedValue({ id: 'cs_1', url: 'https://stripe.com/pay/1' });

    const service = new StripeService(makeConfig());
    await service.createCheckoutSession({
      orderId: 'order-2',
      amountCents: 4999,
      currency: 'usd',
      description: 'Starter Pack',
      successUrl: 'https://x.com/ok',
      cancelUrl: 'https://x.com/cancel',
    });

    const call = mockSessionsCreate.mock.calls[0][0];
    expect(call.mode).toBe('payment');
    expect(call.line_items[0].price_data.unit_amount).toBe(4999);
    expect(call.line_items[0].price_data.currency).toBe('usd');
    expect(call.line_items[0].price_data.product_data.name).toBe('Starter Pack');
    expect(call.metadata.orderId).toBe('order-2');
    expect(call.client_reference_id).toBe('order-2');
    expect(call.payment_intent_data.metadata.orderId).toBe('order-2');
  });

  it('passes internal metadata to checkout session and payment intent', async () => {
    mockSessionsCreate.mockResolvedValue({ id: 'cs_meta', url: 'https://x.com/pay' });

    const service = new StripeService(makeConfig());
    await service.createCheckoutSession({
      orderId: 'order-meta',
      amountCents: 100,
      currency: 'usd',
      description: 'desc',
      successUrl: 'https://x.com/ok',
      cancelUrl: 'https://x.com/cancel',
      metadata: {
        userId: 'user-1',
        tenantId: 'tenant-1',
        productId: '',
      },
    });

    const call = mockSessionsCreate.mock.calls[0][0];
    expect(call.client_reference_id).toBe('order-meta');
    expect(call.metadata).toEqual({
      orderId: 'order-meta',
      userId: 'user-1',
      tenantId: 'tenant-1',
    });
    expect(call.payment_intent_data.metadata).toEqual(call.metadata);
  });

  it('defaults payment_method_types to [card, alipay]', async () => {
    mockSessionsCreate.mockResolvedValue({ id: 'cs_1', url: 'https://x.com/pay' });
    const service = new StripeService(makeConfig());
    await service.createCheckoutSession({
      orderId: 'order-pm',
      amountCents: 100,
      currency: 'usd',
      description: 'desc',
      successUrl: 'https://x.com/ok',
      cancelUrl: 'https://x.com/cancel',
    });
    const call = mockSessionsCreate.mock.calls[0][0];
    expect(call.payment_method_types).toEqual(['card', 'alipay']);
  });

  it('passes through provided paymentMethodTypes when non-empty (overrides default)', async () => {
    mockSessionsCreate.mockResolvedValue({ id: 'cs_2', url: 'https://x.com/pay' });
    const service = new StripeService(makeConfig());
    await service.createCheckoutSession({
      orderId: 'order-pm-2',
      amountCents: 100,
      currency: 'usd',
      description: 'desc',
      successUrl: 'https://x.com/ok',
      cancelUrl: 'https://x.com/cancel',
      paymentMethodTypes: ['link', 'wechat_pay'],
    } as any);
    const call = mockSessionsCreate.mock.calls[0][0];
    expect(call.payment_method_types).toEqual(['link', 'wechat_pay']);
  });

  // appendQuery edge: empty successUrl → returns empty string (Stripe will reject upstream,
  // but the helper itself should be defensive and not crash)
  it('appendQuery: empty successUrl passes through unchanged (no NPE)', async () => {
    mockSessionsCreate.mockResolvedValue({ id: 'cs_3', url: 'https://x.com/pay' });
    const service = new StripeService(makeConfig());
    await service.createCheckoutSession({
      orderId: 'order-empty-url',
      amountCents: 100,
      currency: 'usd',
      description: 'desc',
      successUrl: '',
      cancelUrl: 'https://x.com/cancel',
    });
    const call = mockSessionsCreate.mock.calls[0][0];
    // 空 url 经 appendQuery 处理后仍为空(if !url return url 分支)
    expect(call.success_url).toBe('');
  });

  it('does not enable free-form promotion codes and keeps billing_address_collection=auto by default', async () => {
    mockSessionsCreate.mockResolvedValue({ id: 'cs_1', url: 'https://x.com/pay' });
    const service = new StripeService(makeConfig());
    await service.createCheckoutSession({
      orderId: 'order-promo',
      amountCents: 100,
      currency: 'usd',
      description: 'desc',
      successUrl: 'https://x.com/ok',
      cancelUrl: 'https://x.com/cancel',
    });
    const call = mockSessionsCreate.mock.calls[0][0];
    expect(call.allow_promotion_codes).toBeUndefined();
    expect(call.billing_address_collection).toBe('auto');
  });

  it('applies a system coupon without enabling free-form promotion codes', async () => {
    mockSessionsCreate.mockResolvedValue({ id: 'cs_1', url: 'https://x.com/pay' });
    const service = new StripeService(makeConfig());
    await service.createCheckoutSession({
      orderId: 'order-coupon',
      amountCents: 100,
      currency: 'usd',
      description: 'desc',
      successUrl: 'https://x.com/ok',
      cancelUrl: 'https://x.com/cancel',
      couponId: 'coupon_abc',
    });
    const call = mockSessionsCreate.mock.calls[0][0];
    expect(call.discounts).toEqual([{ coupon: 'coupon_abc' }]);
    expect(call.allow_promotion_codes).toBeUndefined();
  });

  it('appends order_id and session_id placeholder to success_url', async () => {
    mockSessionsCreate.mockResolvedValue({ id: 'cs_1', url: 'https://x.com/pay' });
    const service = new StripeService(makeConfig());
    await service.createCheckoutSession({
      orderId: 'order-1',
      amountCents: 100,
      currency: 'usd',
      description: 'desc',
      successUrl: 'https://example.com/success',
      cancelUrl: 'https://example.com/cancel',
    });
    const call = mockSessionsCreate.mock.calls[0][0];
    expect(call.success_url).toContain('{CHECKOUT_SESSION_ID}');
    // 无 query 时 appendQuery 用 ? 拼
    expect(call.success_url).toBe(
      'https://example.com/success?order_id=order-1&session_id={CHECKOUT_SESSION_ID}',
    );
    expect(call.cancel_url).toBe('https://example.com/cancel?order_id=order-1');
  });

  // appendQuery branch: successUrl 已含 query → 用 & 拼
  it('uses & to append order_id and session_id when successUrl already has a query string', async () => {
    mockSessionsCreate.mockResolvedValue({ id: 'cs_q', url: 'https://x.com/pay' });
    const service = new StripeService(makeConfig());
    await service.createCheckoutSession({
      orderId: 'order-q',
      amountCents: 100,
      currency: 'usd',
      description: 'desc',
      successUrl: 'https://example.com/success?from=app',
      cancelUrl: 'https://example.com/cancel',
    });
    const call = mockSessionsCreate.mock.calls[0][0];
    expect(call.success_url).toBe(
      'https://example.com/success?from=app&order_id=order-q&session_id={CHECKOUT_SESSION_ID}',
    );
  });

  it('does not duplicate an existing order_id in callback URLs', async () => {
    mockSessionsCreate.mockResolvedValue({ id: 'cs_existing', url: 'https://x.com/pay' });
    const service = new StripeService(makeConfig());
    await service.createCheckoutSession({
      orderId: 'order-existing',
      amountCents: 100,
      currency: 'usd',
      description: 'desc',
      successUrl: 'https://example.com/success?order_id=already',
      cancelUrl: 'https://example.com/cancel?order_id=already',
    });
    const call = mockSessionsCreate.mock.calls[0][0];
    expect(call.success_url).toBe(
      'https://example.com/success?order_id=already&session_id={CHECKOUT_SESSION_ID}',
    );
    expect(call.cancel_url).toBe('https://example.com/cancel?order_id=already');
  });

  it('throws when stripe returns session without url', async () => {
    mockSessionsCreate.mockResolvedValue({ id: 'cs_1', url: null });
    const service = new StripeService(makeConfig());
    await expect(
      service.createCheckoutSession({
        orderId: 'order-1',
        amountCents: 100,
        currency: 'usd',
        description: 'desc',
        successUrl: 'https://x.com/ok',
        cancelUrl: 'https://x.com/cancel',
      }),
    ).rejects.toThrow(/Stripe Checkout Session 创建失败/);
  });

  it('throws ServiceUnavailableException when STRIPE_SECRET_KEY is missing', async () => {
    const service = new StripeService(makeConfig({ STRIPE_SECRET_KEY: '' }));
    await expect(
      service.createCheckoutSession({
        orderId: 'order-1',
        amountCents: 100,
        currency: 'usd',
        description: 'desc',
        successUrl: 'https://x.com/ok',
        cancelUrl: 'https://x.com/cancel',
      }),
    ).rejects.toThrow(ServiceUnavailableException);
  });

  it('uses explicit Admin Stripe credentials instead of env secret key', async () => {
    mockSessionsCreate.mockResolvedValue({ id: 'cs_admin', url: 'https://x.com/pay/admin' });
    const service = new StripeService(makeConfig({ STRIPE_SECRET_KEY: 'sk_env_123' }));

    await service.createCheckoutSession({
      orderId: 'order-admin',
      amountCents: 100,
      currency: 'usd',
      description: 'desc',
      successUrl: 'https://x.com/ok',
      cancelUrl: 'https://x.com/cancel',
      credentials: { secretKey: 'sk_admin_123' },
    });

    expect(StripeMock).toHaveBeenCalledWith('sk_admin_123');
  });

  it('omits customer_email when not provided', async () => {
    mockSessionsCreate.mockResolvedValue({ id: 'cs_1', url: 'https://x.com/pay' });
    const service = new StripeService(makeConfig());
    await service.createCheckoutSession({
      orderId: 'order-1',
      amountCents: 100,
      currency: 'usd',
      description: 'desc',
      successUrl: 'https://x.com/ok',
      cancelUrl: 'https://x.com/cancel',
    });
    const call = mockSessionsCreate.mock.calls[0][0];
    expect(call.customer_email).toBeUndefined();
  });
});

// ============================================================
// createSubscription
// ============================================================
describe('StripeService.createSubscription', () => {
  it('returns sessionId and url for subscription session', async () => {
    mockSessionsCreate.mockResolvedValue({
      id: 'cs_sub_1',
      url: 'https://checkout.stripe.com/sub/1',
    });
    const service = new StripeService(makeConfig());
    const result = await service.createSubscription({
      orderId: 'order-sub-1',
      planName: 'Pro Monthly',
      amountCents: 2999,
      currency: 'usd',
      interval: 'month',
      customerEmail: 'user@example.com',
      successUrl: 'https://x.com/ok',
      cancelUrl: 'https://x.com/cancel',
    });
    expect(result.sessionId).toBe('cs_sub_1');
    expect(result.url).toBe('https://checkout.stripe.com/sub/1');
  });

  it('creates session in subscription mode with recurring price', async () => {
    mockSessionsCreate.mockResolvedValue({ id: 'cs_sub_2', url: 'https://x.com/pay' });
    const service = new StripeService(makeConfig());
    await service.createSubscription({
      orderId: 'order-sub-2',
      planName: 'Enterprise',
      amountCents: 9999,
      currency: 'usd',
      interval: 'year',
      customerEmail: 'admin@example.com',
      successUrl: 'https://x.com/ok',
      cancelUrl: 'https://x.com/cancel',
    });
    const call = mockSessionsCreate.mock.calls[0][0];
    expect(call.mode).toBe('subscription');
    expect(call.line_items[0].price_data.recurring.interval).toBe('year');
    expect(call.line_items[0].price_data.unit_amount).toBe(9999);
    expect(call.metadata.orderId).toBe('order-sub-2');
    expect(call.client_reference_id).toBe('order-sub-2');
    expect(call.subscription_data.metadata.orderId).toBe('order-sub-2');
  });

  it('sets interval_count for quarterly subscriptions', async () => {
    mockSessionsCreate.mockResolvedValue({ id: 'cs_sub_quarter', url: 'https://x.com/pay' });
    const service = new StripeService(makeConfig());
    await service.createSubscription({
      orderId: 'order-sub-quarter',
      planName: 'Pro Quarterly',
      amountCents: 13500,
      currency: 'usd',
      interval: 'month',
      intervalCount: 3,
      customerEmail: 'user@example.com',
      successUrl: 'https://x.com/ok',
      cancelUrl: 'https://x.com/cancel',
    });
    const call = mockSessionsCreate.mock.calls[0][0];
    expect(call.line_items[0].price_data.recurring).toEqual({
      interval: 'month',
      interval_count: 3,
    });
  });

  it('defaults payment_method_types to [card] for subscriptions (card-only)', async () => {
    mockSessionsCreate.mockResolvedValue({ id: 'cs_sub_pm', url: 'https://x.com/pay' });
    const service = new StripeService(makeConfig());
    await service.createSubscription({
      orderId: 'order-sub-pm',
      planName: 'Pro',
      amountCents: 100,
      currency: 'usd',
      interval: 'month',
      customerEmail: 'user@example.com',
      successUrl: 'https://x.com/ok',
      cancelUrl: 'https://x.com/cancel',
    });
    const call = mockSessionsCreate.mock.calls[0][0];
    expect(call.payment_method_types).toEqual(['card']);
  });

  it('subscription: passes through provided paymentMethodTypes when non-empty', async () => {
    mockSessionsCreate.mockResolvedValue({ id: 'cs_sub_pm2', url: 'https://x.com/pay' });
    const service = new StripeService(makeConfig());
    await service.createSubscription({
      orderId: 'order-sub-pm-2',
      planName: 'Team',
      amountCents: 100,
      currency: 'usd',
      interval: 'month',
      customerEmail: 'user@example.com',
      successUrl: 'https://x.com/ok',
      cancelUrl: 'https://x.com/cancel',
      paymentMethodTypes: ['card', 'link'],
    } as any);
    const call = mockSessionsCreate.mock.calls[0][0];
    expect(call.payment_method_types).toEqual(['card', 'link']);
  });

  it('does not enable free-form promotion codes and keeps billing_address_collection=auto for subscriptions', async () => {
    mockSessionsCreate.mockResolvedValue({ id: 'cs_sub_promo', url: 'https://x.com/pay' });
    const service = new StripeService(makeConfig());
    await service.createSubscription({
      orderId: 'order-sub-promo',
      planName: 'Pro',
      amountCents: 100,
      currency: 'usd',
      interval: 'month',
      customerEmail: 'user@example.com',
      successUrl: 'https://x.com/ok',
      cancelUrl: 'https://x.com/cancel',
    });
    const call = mockSessionsCreate.mock.calls[0][0];
    expect(call.allow_promotion_codes).toBeUndefined();
    expect(call.billing_address_collection).toBe('auto');
  });

  it('applies a subscription coupon without enabling free-form promotion codes', async () => {
    mockSessionsCreate.mockResolvedValue({ id: 'cs_sub_coupon', url: 'https://x.com/pay' });
    const service = new StripeService(makeConfig());
    await service.createSubscription({
      orderId: 'order-sub-coupon',
      planName: 'Pro',
      amountCents: 100,
      currency: 'usd',
      interval: 'month',
      customerEmail: 'user@example.com',
      successUrl: 'https://x.com/ok',
      cancelUrl: 'https://x.com/cancel',
      couponId: 'coupon_sub',
    });
    const call = mockSessionsCreate.mock.calls[0][0];
    expect(call.subscription_data).toEqual({
      metadata: { orderId: 'order-sub-coupon' },
      coupon: 'coupon_sub',
    });
    expect(call.allow_promotion_codes).toBeUndefined();
  });

  it('throws when session has no url', async () => {
    mockSessionsCreate.mockResolvedValue({ id: 'cs_sub_3', url: null });
    const service = new StripeService(makeConfig());
    await expect(
      service.createSubscription({
        orderId: 'order-sub-3',
        planName: 'Pro',
        amountCents: 100,
        currency: 'usd',
        interval: 'month',
        customerEmail: 'user@example.com',
        successUrl: 'https://x.com/ok',
        cancelUrl: 'https://x.com/cancel',
      }),
    ).rejects.toThrow(/Stripe Subscription Session 创建失败/);
  });

  it('omits customer_email when empty string is passed', async () => {
    mockSessionsCreate.mockResolvedValue({ id: 'cs_sub_4', url: 'https://x.com/pay' });
    const service = new StripeService(makeConfig());
    await service.createSubscription({
      orderId: 'order-sub-4',
      planName: 'Pro',
      amountCents: 100,
      currency: 'usd',
      interval: 'month',
      customerEmail: '',
      successUrl: 'https://x.com/ok',
      cancelUrl: 'https://x.com/cancel',
    });
    const call = mockSessionsCreate.mock.calls[0][0];
    expect(call.customer_email).toBeUndefined();
  });
});

// ============================================================
// createMixedSubscriptionCheckout
// ============================================================
describe('StripeService.createMixedSubscriptionCheckout', () => {
  it('creates a subscription session with recurring and one-time line items', async () => {
    mockSessionsCreate.mockResolvedValue({
      id: 'cs_bundle_1',
      url: 'https://checkout.stripe.com/bundle/1',
    });
    const service = new StripeService(makeConfig());

    const result = await service.createMixedSubscriptionCheckout({
      orderId: 'order-bundle-1',
      bundleName: 'A + B Bundle',
      currency: 'usd',
      recurringItems: [
        { name: 'Product A Yearly', amountCents: 9900, interval: 'year', quantity: 1 },
      ],
      oneTimeItems: [
        { name: 'Product B Access', amountCents: 3000, quantity: 1 },
      ],
      customerEmail: 'buyer@example.com',
      successUrl: 'https://x.com/ok',
      cancelUrl: 'https://x.com/cancel',
    });

    expect(result.sessionId).toBe('cs_bundle_1');
    const call = mockSessionsCreate.mock.calls[0][0];
    expect(call.mode).toBe('subscription');
    expect(call.payment_method_types).toEqual(['card']);
    expect(call.line_items).toHaveLength(2);
    expect(call.line_items[0].price_data.recurring.interval).toBe('year');
    expect(call.line_items[0].price_data.unit_amount).toBe(9900);
    expect(call.line_items[1].price_data.recurring).toBeUndefined();
    expect(call.line_items[1].price_data.unit_amount).toBe(3000);
    expect(call.metadata.orderId).toBe('order-bundle-1');
    expect(call.subscription_data.metadata.orderId).toBe('order-bundle-1');
  });

  it('requires at least one recurring item and one one-time item', async () => {
    const service = new StripeService(makeConfig());
    await expect(
      service.createMixedSubscriptionCheckout({
        orderId: 'order-bundle-bad',
        bundleName: 'Bad Bundle',
        currency: 'usd',
        recurringItems: [],
        oneTimeItems: [{ name: 'One time', amountCents: 100, quantity: 1 }],
        customerEmail: '',
        successUrl: 'https://x.com/ok',
        cancelUrl: 'https://x.com/cancel',
      }),
    ).rejects.toThrow(/requires recurring and one-time items/);
  });
});

describe('StripeService checkout provider idempotency', () => {
  it('uses checkout:<orderId> for payment, subscription, and mixed sessions', async () => {
    mockSessionsCreate
      .mockResolvedValueOnce({ id: 'cs_payment', url: 'https://x.com/payment' })
      .mockResolvedValueOnce({ id: 'cs_subscription', url: 'https://x.com/subscription' })
      .mockResolvedValueOnce({ id: 'cs_mixed', url: 'https://x.com/mixed' });
    const service = new StripeService(makeConfig());

    await service.createCheckoutSession({
      orderId: 'order-payment',
      amountCents: 100,
      currency: 'usd',
      description: 'Payment',
      successUrl: 'https://x.com/ok',
      cancelUrl: 'https://x.com/cancel',
    });
    await service.createSubscription({
      orderId: 'order-subscription',
      planName: 'Subscription',
      amountCents: 100,
      currency: 'usd',
      interval: 'month',
      customerEmail: 'user@example.com',
      successUrl: 'https://x.com/ok',
      cancelUrl: 'https://x.com/cancel',
    });
    await service.createMixedSubscriptionCheckout({
      orderId: 'order-mixed',
      bundleName: 'Mixed',
      currency: 'usd',
      recurringItems: [{ name: 'Recurring', amountCents: 50, interval: 'month' }],
      oneTimeItems: [{ name: 'One time', amountCents: 50 }],
      customerEmail: 'user@example.com',
      successUrl: 'https://x.com/ok',
      cancelUrl: 'https://x.com/cancel',
    });

    expect(mockSessionsCreate.mock.calls.map((call) => call[1])).toEqual([
      { idempotencyKey: 'checkout:order-payment' },
      { idempotencyKey: 'checkout:order-subscription' },
      { idempotencyKey: 'checkout:order-mixed' },
    ]);
  });

  it('uses an explicit stable idempotency key when creating a recovery coupon', async () => {
    mockCouponsCreate.mockResolvedValue({ id: 'coupon_recovery' });
    const service = new StripeService(makeConfig());

    await expect(service.createOneTimeAmountOffCoupon({
      name: 'Proration',
      amountOffCents: 100,
      currency: 'usd',
      metadata: { orderId: 'order-coupon' },
      idempotencyKey: 'checkout:order-coupon:coupon',
    })).resolves.toBe('coupon_recovery');

    expect(mockCouponsCreate).toHaveBeenCalledWith(
      expect.objectContaining({ amount_off: 100 }),
      { idempotencyKey: 'checkout:order-coupon:coupon' },
    );
  });
});

// ============================================================
// verifyWebhook
// ============================================================
describe('StripeService.verifyWebhook', () => {
  it('returns event object from constructEvent on success', () => {
    const fakeEvent = { type: 'checkout.session.completed', data: { object: {} } };
    mockWebhooksConstructEvent.mockReturnValue(fakeEvent);

    const service = new StripeService(makeConfig());
    const result = service.verifyWebhook(Buffer.from('payload'), 'sig_abc');

    expect(result).toBe(fakeEvent);
    expect(mockWebhooksConstructEvent).toHaveBeenCalledWith(
      expect.any(Buffer),
      'sig_abc',
      'whsec_test_xyz',
    );
  });

  it('uses explicit Admin webhook secret when provided', () => {
    const fakeEvent = { type: 'checkout.session.completed', data: { object: {} } };
    mockWebhooksConstructEvent.mockReturnValue(fakeEvent);

    const service = new StripeService(makeConfig());
    const result = service.verifyWebhook(Buffer.from('payload'), 'sig_admin', {
      secretKey: 'sk_admin_123',
      webhookSecret: 'whsec_admin_123',
    });

    expect(result).toBe(fakeEvent);
    expect(mockWebhooksConstructEvent).toHaveBeenCalledWith(
      expect.any(Buffer),
      'sig_admin',
      'whsec_admin_123',
    );
  });

  it('throws ServiceUnavailableException when STRIPE_WEBHOOK_SECRET is missing', () => {
    const service = new StripeService(makeConfig({ STRIPE_WEBHOOK_SECRET: '' }));
    expect(() => service.verifyWebhook('payload', 'sig')).toThrow(
      ServiceUnavailableException,
    );
    expect(mockWebhooksConstructEvent).not.toHaveBeenCalled();
  });

  it('propagates constructEvent errors (e.g. invalid signature)', () => {
    mockWebhooksConstructEvent.mockImplementation(() => {
      throw new Error('No signatures found matching the expected signature for payload');
    });
    const service = new StripeService(makeConfig());
    expect(() => service.verifyWebhook('payload', 'bad_sig')).toThrow(/No signatures/);
  });
});

// ============================================================
// ledger snapshots
// ============================================================
describe('StripeService ledger snapshots', () => {
  it('normalizes checkout session payment ledger with expanded charge balance transaction', async () => {
    mockSessionsRetrieve.mockResolvedValue({
      id: 'cs_ledger_1',
      object: 'checkout.session',
      amount_total: 10000,
      currency: 'usd',
      payment_status: 'paid',
      customer_email: 'buyer@example.com',
      created: 1800000000,
      payment_intent: {
        id: 'pi_1',
        object: 'payment_intent',
        status: 'succeeded',
        latest_charge: {
          id: 'ch_1',
          object: 'charge',
          status: 'succeeded',
          amount: 10000,
          currency: 'usd',
          created: 1800000001,
          billing_details: { email: 'charge@example.com' },
          balance_transaction: {
            id: 'txn_1',
            object: 'balance_transaction',
            amount: 10000,
            fee: 420,
            net: 9580,
            currency: 'usd',
            created: 1800000002,
            available_on: 1800086400,
            payout: 'po_1',
          },
        },
      },
    });

    const service = new StripeService(makeConfig());
    const snapshot = await service.retrieveCheckoutLedgerSnapshot('cs_ledger_1');

    expect(snapshot).toMatchObject({
      transactionType: 'payment',
      checkoutSessionId: 'cs_ledger_1',
      paymentIntentId: 'pi_1',
      chargeId: 'ch_1',
      balanceTransactionId: 'txn_1',
      payoutId: 'po_1',
      amountCents: 10000,
      feeCents: 420,
      netCents: 9580,
      currency: 'USD',
      stripeStatus: 'succeeded',
      customerEmail: 'buyer@example.com',
    });
    expect(snapshot.stripeCreatedAt?.toISOString()).toBe('2027-01-15T08:00:02.000Z');
    expect(snapshot.availableOn?.toISOString()).toBe('2027-01-16T08:00:00.000Z');
  });

  it('retrieves charge and balance transaction when checkout expansion only returns ids', async () => {
    mockSessionsRetrieve.mockResolvedValue({
      id: 'cs_ledger_2',
      object: 'checkout.session',
      currency: 'usd',
      payment_intent: {
        id: 'pi_2',
        object: 'payment_intent',
        latest_charge: 'ch_2',
      },
    });
    mockChargesRetrieve.mockResolvedValue({
      id: 'ch_2',
      object: 'charge',
      amount: 500,
      currency: 'usd',
      status: 'succeeded',
      balance_transaction: 'txn_2',
    });
    mockBalanceTransactionsRetrieve.mockResolvedValue({
      id: 'txn_2',
      object: 'balance_transaction',
      amount: 500,
      fee: 45,
      net: 455,
      currency: 'usd',
    });

    const service = new StripeService(makeConfig());
    const snapshot = await service.retrieveCheckoutLedgerSnapshot('cs_ledger_2');

    expect(mockChargesRetrieve).toHaveBeenCalledWith('ch_2', { expand: ['balance_transaction'] });
    expect(mockBalanceTransactionsRetrieve).toHaveBeenCalledWith('txn_2');
    expect(snapshot).toMatchObject({
      chargeId: 'ch_2',
      balanceTransactionId: 'txn_2',
      amountCents: 500,
      feeCents: 45,
      netCents: 455,
    });
  });

  it('records a no-cost Checkout session without requiring a PaymentIntent', async () => {
    mockSessionsRetrieve.mockResolvedValue({
      id: 'cs_free',
      object: 'checkout.session',
      amount_total: 0,
      currency: 'usd',
      payment_status: 'no_payment_required',
      payment_intent: null,
      subscription: {
        id: 'sub_free',
        object: 'subscription',
        latest_invoice: null,
      },
      created: 1800001000,
    });

    const service = new StripeService(makeConfig());
    const snapshot = await service.retrieveCheckoutLedgerSnapshot('cs_free');

    expect(snapshot).toMatchObject({
      checkoutSessionId: 'cs_free',
      subscriptionId: 'sub_free',
      amountCents: 0,
      currency: 'USD',
      stripeStatus: 'no_payment_required',
    });
    expect(snapshot.paymentIntentId).toBeNull();
    expect(snapshot.chargeId).toBeNull();
    expect(snapshot.balanceTransactionId).toBeNull();
    expect(mockChargesRetrieve).not.toHaveBeenCalled();
    expect(mockBalanceTransactionsRetrieve).not.toHaveBeenCalled();
  });

  it('normalizes subscription ledger from the latest invoice', async () => {
    mockSubscriptionsRetrieve.mockResolvedValue({
      id: 'sub_ledger_1',
      object: 'subscription',
      status: 'active',
      currency: 'usd',
      created: 1800002000,
      latest_invoice: {
        id: 'in_1',
        object: 'invoice',
        amount_paid: 1200,
        currency: 'usd',
        status: 'paid',
        customer_email: 'invoice@example.com',
        created: 1800002001,
        payment_intent: {
          id: 'pi_sub_1',
          object: 'payment_intent',
          latest_charge: {
            id: 'ch_sub_1',
            object: 'charge',
            amount: 1200,
            currency: 'usd',
            status: 'succeeded',
            balance_transaction: {
              id: 'txn_sub_1',
              object: 'balance_transaction',
              amount: 1200,
              fee: 65,
              net: 1135,
              currency: 'usd',
            },
          },
        },
      },
    });

    const service = new StripeService(makeConfig());
    const snapshot = await service.retrieveSubscriptionLedgerSnapshot('sub_ledger_1');

    expect(mockSubscriptionsRetrieve).toHaveBeenCalledWith('sub_ledger_1', {
      expand: ['latest_invoice.payment_intent.latest_charge.balance_transaction'],
    });
    expect(snapshot).toMatchObject({
      transactionType: 'payment',
      checkoutSessionId: null,
      subscriptionId: 'sub_ledger_1',
      invoiceId: 'in_1',
      paymentIntentId: 'pi_sub_1',
      chargeId: 'ch_sub_1',
      balanceTransactionId: 'txn_sub_1',
      amountCents: 1200,
      feeCents: 65,
      netCents: 1135,
      currency: 'USD',
      stripeStatus: 'succeeded',
      customerEmail: 'invoice@example.com',
    });
  });

  it('normalizes refund ledger with expanded balance transaction', async () => {
    mockRefundsRetrieve.mockResolvedValue({
      id: 're_1',
      object: 'refund',
      amount: 200,
      currency: 'usd',
      status: 'succeeded',
      created: 1800001000,
      payment_intent: { id: 'pi_ref', object: 'payment_intent' },
      charge: {
        id: 'ch_ref',
        object: 'charge',
        billing_details: { email: 'refund@example.com' },
        balance_transaction: 'txn_original',
      },
      balance_transaction: {
        id: 'txn_ref',
        object: 'balance_transaction',
        amount: -200,
        fee: 0,
        net: -200,
        currency: 'usd',
        payout: 'po_ref',
        created: 1800001001,
        available_on: 1800086400,
      },
    });

    const service = new StripeService(makeConfig());
    const snapshot = await service.retrieveRefundLedgerSnapshot('re_1');

    expect(snapshot).toMatchObject({
      transactionType: 'refund',
      refundId: 're_1',
      paymentIntentId: 'pi_ref',
      chargeId: 'ch_ref',
      balanceTransactionId: 'txn_ref',
      payoutId: 'po_ref',
      amountCents: -200,
      feeCents: 0,
      netCents: -200,
      currency: 'USD',
      stripeStatus: 'succeeded',
      customerEmail: 'refund@example.com',
    });
  });

  it('falls back to negative refund amount when refund balance transaction is unavailable', async () => {
    mockRefundsRetrieve.mockResolvedValue({
      id: 're_no_txn',
      object: 'refund',
      amount: 200,
      currency: 'usd',
      status: 'pending',
      charge: 'ch_no_txn',
      balance_transaction: null,
    });
    mockChargesRetrieve.mockResolvedValue({
      id: 'ch_no_txn',
      object: 'charge',
      currency: 'usd',
      balance_transaction: null,
    });

    const service = new StripeService(makeConfig());
    const snapshot = await service.retrieveRefundLedgerSnapshot('re_no_txn');

    expect(snapshot).toMatchObject({
      transactionType: 'refund',
      refundId: 're_no_txn',
      chargeId: 'ch_no_txn',
      amountCents: -200,
      currency: 'USD',
      stripeStatus: 'pending',
    });
  });
});

// ============================================================
// refundViaSessionOrSubscription
// ============================================================
describe('StripeService.refundViaSessionOrSubscription', () => {
  it('refunds via payment_intent when session is retrieved successfully', async () => {
    mockSessionsRetrieve.mockResolvedValue({
      id: 'cs_123',
      payment_intent: 'pi_abc',
    });
    mockRefundsCreate.mockResolvedValue({
      id: 'ref_001',
      status: 'succeeded',
    });

    const service = new StripeService(makeConfig());
    const result = await service.refundViaSessionOrSubscription('cs_123', 5000);

    expect(result.success).toBe(true);
    expect(result.refundId).toBe('ref_001');
    expect(mockRefundsCreate).toHaveBeenCalledWith({
      payment_intent: 'pi_abc',
      amount: 5000,
    });
  });

  it('passes idempotency key when refunding a checkout session payment_intent', async () => {
    mockSessionsRetrieve.mockResolvedValue({
      id: 'cs_123',
      payment_intent: 'pi_abc',
    });
    mockRefundsCreate.mockResolvedValue({
      id: 'ref_001',
      status: 'succeeded',
    });

    const service = new StripeService(makeConfig());
    await service.refundViaSessionOrSubscription(
      'cs_123',
      5000,
      undefined,
      'refund:order-1:5000',
    );

    expect(mockRefundsCreate).toHaveBeenCalledWith(
      {
        payment_intent: 'pi_abc',
        amount: 5000,
      },
      { idempotencyKey: 'refund:order-1:5000' },
    );
  });

  it('refunds latest subscription invoice when session retrieval fails (subscription flow)', async () => {
    mockSessionsRetrieve.mockRejectedValue(new Error('No such session'));
    mockSubscriptionsRetrieve.mockResolvedValue({
      id: 'sub_123',
      latest_invoice: {
        id: 'in_123',
        payment_intent: 'pi_sub_123',
        amount_paid: 3000,
      },
    });
    mockRefundsCreate.mockResolvedValue({
      id: 'ref_sub_123',
      status: 'succeeded',
    });
    mockSubscriptionsCancel.mockResolvedValue({ id: 'sub_123', status: 'canceled' });

    const service = new StripeService(makeConfig());
    const result = await service.refundViaSessionOrSubscription('sub_123', 3000);

    expect(result.success).toBe(true);
    expect(result.refundId).toBe('ref_sub_123');
    expect(mockRefundsCreate).toHaveBeenCalledWith({
      payment_intent: 'pi_sub_123',
      amount: 3000,
    });
    expect(mockSubscriptionsCancel).toHaveBeenCalledWith('sub_123');
  });

  it('passes idempotency key when refunding the latest subscription invoice', async () => {
    mockSessionsRetrieve.mockRejectedValue(new Error('No such session'));
    mockSubscriptionsRetrieve.mockResolvedValue({
      id: 'sub_123',
      latest_invoice: {
        id: 'in_123',
        payment_intent: 'pi_sub_123',
        amount_paid: 3000,
      },
    });
    mockRefundsCreate.mockResolvedValue({
      id: 'ref_sub_123',
      status: 'succeeded',
    });
    mockSubscriptionsCancel.mockResolvedValue({ id: 'sub_123', status: 'canceled' });

    const service = new StripeService(makeConfig());
    await service.refundViaSessionOrSubscription(
      'sub_123',
      3000,
      undefined,
      'refund:order-1:3000',
    );

    expect(mockRefundsCreate).toHaveBeenCalledWith(
      {
        payment_intent: 'pi_sub_123',
        amount: 3000,
      },
      { idempotencyKey: 'refund:order-1:3000' },
    );
  });

  it('reports a durable-cancellation outcome when refund succeeds but cancel is not confirmed', async () => {
    mockSessionsRetrieve.mockRejectedValue(new Error('no session'));
    mockSubscriptionsRetrieve.mockResolvedValue({
      id: 'sub_456',
      latest_invoice: { id: 'in_456', payment_intent: 'pi_sub_456' },
    });
    mockRefundsCreate.mockResolvedValue({
      id: 'ref_sub_456',
      status: 'succeeded',
    });
    mockSubscriptionsCancel.mockResolvedValue({ id: 'sub_456', status: 'active' });

    const service = new StripeService(makeConfig());
    const result = await service.refundViaSessionOrSubscription('sub_456');

    expect(result.success).toBe(false);
    expect(result.refundId).toBe('ref_sub_456');
    expect(result).toMatchObject({
      providerRefundSucceeded: true,
      subscriptionCancellationPending: true,
      subscriptionId: 'sub_456',
    });
    expect(result.error).toContain('status=active');
  });

  it('does not hide a cancel exception after the provider refund succeeded', async () => {
    mockSessionsRetrieve.mockRejectedValue(new Error('no session'));
    mockSubscriptionsRetrieve.mockResolvedValue({
      id: 'sub_cancel_timeout',
      latest_invoice: {
        id: 'in_cancel_timeout',
        payment_intent: 'pi_cancel_timeout',
      },
    });
    mockRefundsCreate.mockResolvedValue({
      id: 'ref_cancel_timeout',
      status: 'succeeded',
    });
    mockSubscriptionsCancel.mockRejectedValue(new Error('cancel timeout'));

    const service = new StripeService(makeConfig());
    const result = await service.refundViaSessionOrSubscription(
      'sub_cancel_timeout',
    );

    expect(result).toMatchObject({
      success: false,
      refundId: 'ref_cancel_timeout',
      providerRefundSucceeded: true,
      subscriptionCancellationPending: true,
      subscriptionId: 'sub_cancel_timeout',
      error: 'cancel timeout',
    });
  });

  it('does not cancel a subscription while the Stripe refund is pending', async () => {
    mockSessionsRetrieve.mockRejectedValue(new Error('no session'));
    mockSubscriptionsRetrieve.mockResolvedValue({
      id: 'sub_pending',
      latest_invoice: {
        id: 'in_pending',
        payment_intent: 'pi_pending',
        amount_paid: 3000,
      },
    });
    mockRefundsCreate.mockResolvedValue({
      id: 'ref_pending',
      status: 'pending',
    });

    const service = new StripeService(makeConfig());
    const result = await service.refundViaSessionOrSubscription(
      'sub_pending',
      3000,
    );

    expect(result).toMatchObject({
      success: false,
      refundId: 'ref_pending',
      refundStatus: 'pending',
      providerRefundPending: true,
      subscriptionId: 'sub_pending',
      refundedInvoiceId: 'in_pending',
    });
    expect(mockSubscriptionsCancel).not.toHaveBeenCalled();
  });

  it('binds a subscription refund to the expected invoice before creating it', async () => {
    mockSessionsRetrieve.mockRejectedValue(new Error('no session'));
    mockInvoicesRetrieve.mockResolvedValue({
      id: 'in_exact',
      subscription: 'sub_exact',
      payment_intent: 'pi_exact',
      amount_paid: 3000,
    });
    mockRefundsCreate.mockResolvedValue({
      id: 'ref_exact',
      status: 'succeeded',
    });
    mockSubscriptionsRetrieve.mockResolvedValue({
      id: 'sub_exact',
      status: 'active',
    });
    mockSubscriptionsCancel.mockResolvedValue({
      id: 'sub_exact',
      status: 'canceled',
    });

    const service = new StripeService(makeConfig());
    const result = await service.refundViaSessionOrSubscription(
      'sub_exact',
      3000,
      undefined,
      'refund:order-exact:3000',
      'in_exact',
    );

    expect(result).toMatchObject({
      success: true,
      refundId: 'ref_exact',
      refundStatus: 'succeeded',
      refundedInvoiceId: 'in_exact',
    });
    expect(mockInvoicesRetrieve).toHaveBeenCalledWith('in_exact', {
      expand: ['payment_intent'],
    });
  });

  it('rejects an expected invoice owned by another subscription before refund creation', async () => {
    mockSessionsRetrieve.mockRejectedValue(new Error('no session'));
    mockInvoicesRetrieve.mockResolvedValue({
      id: 'in_wrong',
      subscription: 'sub_other',
      payment_intent: 'pi_wrong',
      amount_paid: 3000,
    });

    const service = new StripeService(makeConfig());
    const result = await service.refundViaSessionOrSubscription(
      'sub_exact',
      3000,
      undefined,
      'refund:order-exact:3000',
      'in_wrong',
    );

    expect(result.success).toBe(false);
    expect(result.error).toContain('does not belong to subscription');
    expect(mockRefundsCreate).not.toHaveBeenCalled();
  });

  it('returns success=false with error when subscription payment refund fails', async () => {
    mockSessionsRetrieve.mockRejectedValue(new Error('no session'));
    mockSubscriptionsRetrieve.mockRejectedValue(new Error('subscription retrieve failed'));

    const service = new StripeService(makeConfig());
    const result = await service.refundViaSessionOrSubscription('unknown_id');

    expect(result.success).toBe(false);
    expect(result.error).toContain('subscription retrieve failed');
  });

  it('refunds with session.subscription when session has subscription id (string form)', async () => {
    // Regression: previously code called subscriptions.cancel(sessionId),
    // which Stripe would reject for cs_xxx ids. Now uses session.subscription.
    mockSessionsRetrieve.mockResolvedValue({
      id: 'cs_sub',
      payment_intent: null,
      subscription: 'sub_789',
    });
    mockSubscriptionsRetrieve.mockResolvedValue({
      id: 'sub_789',
      latest_invoice: { id: 'in_789', payment_intent: 'pi_sub_789' },
    });
    mockRefundsCreate.mockResolvedValue({
      id: 'ref_sub_789',
      status: 'succeeded',
    });
    mockSubscriptionsCancel.mockResolvedValue({ id: 'sub_789', status: 'canceled' });

    const service = new StripeService(makeConfig());
    const result = await service.refundViaSessionOrSubscription('cs_sub');

    expect(result.success).toBe(true);
    expect(result.refundId).toBe('ref_sub_789');
    expect(mockSubscriptionsCancel).toHaveBeenCalledWith('sub_789');
  });

  it('refunds with session.subscription.id when session returns expanded subscription object', async () => {
    mockSessionsRetrieve.mockResolvedValue({
      id: 'cs_sub',
      payment_intent: null,
      subscription: { id: 'sub_999', status: 'active' },
    });
    mockSubscriptionsRetrieve.mockResolvedValue({
      id: 'sub_999',
      latest_invoice: { id: 'in_999', payment_intent: 'pi_sub_999' },
    });
    mockRefundsCreate.mockResolvedValue({
      id: 'ref_sub_999',
      status: 'succeeded',
    });
    mockSubscriptionsCancel.mockResolvedValue({ id: 'sub_999', status: 'canceled' });

    const service = new StripeService(makeConfig());
    const result = await service.refundViaSessionOrSubscription('cs_sub');

    expect(result.success).toBe(true);
    expect(mockSubscriptionsCancel).toHaveBeenCalledWith('sub_999');
  });

  it('session with neither payment_intent nor subscription → subscription refund uses original id', async () => {
    // Defensive fallback: if the session is a degenerate shape, still try
    // the original id as a subscription id (backward-compat).
    mockSessionsRetrieve.mockResolvedValue({
      id: 'cs_degenerate',
      payment_intent: null,
      subscription: null,
    });
    mockSubscriptionsRetrieve.mockResolvedValue({
      id: 'cs_degenerate',
      latest_invoice: { id: 'in_degenerate', payment_intent: 'pi_degenerate' },
    });
    mockRefundsCreate.mockResolvedValue({
      id: 'ref_degenerate',
      status: 'succeeded',
    });
    mockSubscriptionsCancel.mockResolvedValue({ id: 'cs_degenerate', status: 'canceled' });

    const service = new StripeService(makeConfig());
    await service.refundViaSessionOrSubscription('cs_degenerate');

    expect(mockSubscriptionsCancel).toHaveBeenCalledWith('cs_degenerate');
  });

  it('returns non-Error message as fallback error string', async () => {
    mockSessionsRetrieve.mockRejectedValue(new Error('no session'));
    mockSubscriptionsRetrieve.mockRejectedValue('non-Error value');

    const service = new StripeService(makeConfig());
    const result = await service.refundViaSessionOrSubscription('sub_x');

    expect(result.success).toBe(false);
    expect(result.error).toBe('Stripe refund failed');
  });

  it('throws ServiceUnavailableException when secret key is missing', async () => {
    const service = new StripeService(makeConfig({ STRIPE_SECRET_KEY: '' }));
    await expect(
      service.refundViaSessionOrSubscription('cs_123'),
    ).rejects.toThrow(ServiceUnavailableException);
  });
});

describe('StripeService.cancelSubscription', () => {
  it('is idempotent when Stripe already reports canceled', async () => {
    mockSubscriptionsRetrieve.mockResolvedValue({
      id: 'sub_already_canceled',
      status: 'canceled',
    });
    const service = new StripeService(makeConfig());

    await service.cancelSubscription('sub_already_canceled');

    expect(mockSubscriptionsCancel).not.toHaveBeenCalled();
  });

  it('throws when Stripe cancel returns a non-canceled status', async () => {
    mockSubscriptionsRetrieve.mockResolvedValue({
      id: 'sub_active',
      status: 'active',
    });
    mockSubscriptionsCancel.mockResolvedValue({
      id: 'sub_active',
      status: 'active',
    });
    const service = new StripeService(makeConfig());

    await expect(
      service.cancelSubscription('sub_active'),
    ).rejects.toThrow('status=active');
  });
});

describe('StripeService.retrieveRefundStatus', () => {
  it('returns the normalized provider status', async () => {
    mockRefundsRetrieve.mockResolvedValue({
      id: 'ref_pending',
      status: 'pending',
    });
    const service = new StripeService(makeConfig());

    await expect(
      service.retrieveRefundStatus('ref_pending'),
    ).resolves.toBe('pending');
  });

  it('fails closed when Stripe omits refund status', async () => {
    mockRefundsRetrieve.mockResolvedValue({ id: 'ref_unknown' });
    const service = new StripeService(makeConfig());

    await expect(
      service.retrieveRefundStatus('ref_unknown'),
    ).rejects.toThrow('invalid status=missing');
  });
});
