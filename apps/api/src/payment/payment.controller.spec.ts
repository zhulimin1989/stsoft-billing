/**
 * PaymentController focused unit tests for review-driven edge paths.
 */
import { PaymentController } from './payment.controller';
import { paymentNotifyReplayKey } from '../common/utils/redis-key.util';

const PAYMENT_NOTIFY_REPLAY_TTL_SECONDS = 30 * 86400;

function makeReplyStub() {
  const reply: Record<string, jest.Mock> = {};
  reply.code = jest.fn().mockReturnValue(reply);
  reply.status = jest.fn().mockReturnValue(reply);
  reply.type = jest.fn().mockReturnValue(reply);
  reply.send = jest.fn().mockResolvedValue(undefined);
  return reply;
}

describe('PaymentController.stripeWebhook — P2-A2 AlertEvent hook', () => {
  function buildController(opts: {
    verifyWebhookThrows?: Error;
    handleStripeEventThrows?: Error;
    rawBody?: Buffer | undefined;
    alertEvents?: { createAlert: jest.Mock };
  }) {
    const paymentService = {
      verifyStripeWebhook: opts.verifyWebhookThrows
        ? jest.fn().mockImplementation(() => {
            throw opts.verifyWebhookThrows;
          })
        : jest.fn().mockReturnValue({
            event: { id: 'evt_1' },
            verifiedPaymentProviderInstanceIds: ['ppi_stripe_1'],
          }),
      handleStripeEvent: opts.handleStripeEventThrows
        ? jest.fn().mockRejectedValue(opts.handleStripeEventThrows)
        : jest.fn().mockResolvedValue(undefined),
    } as any;
    const alertEvents = opts.alertEvents ?? {
      createAlert: jest.fn().mockResolvedValue(null),
    };
    const controller = new PaymentController(
      paymentService,
      {} as any, // wechat
      {} as any, // alipay
      {} as any, // redis
      alertEvents as any,
    );
    return { controller, paymentService, alertEvents };
  }

  it('verifyWebhook throws → emits PAYMENT/CRITICAL with sourceId=null', async () => {
    const { controller, alertEvents } = buildController({
      verifyWebhookThrows: new Error('No signatures match'),
    });
    const req = {
      headers: {
        'stripe-signature': 'sig-xyz',
        'user-agent': 'Stripe/1.0',
      },
      ip: '1.2.3.4',
      rawBody: Buffer.from('{}'),
    } as any;
    const reply = makeReplyStub();

    await controller.stripeWebhook(req, reply as any);
    // Wait microtask for fire-and-forget createAlert .catch().
    await Promise.resolve();
    await Promise.resolve();

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(alertEvents.createAlert).toHaveBeenCalledTimes(1);
    const arg = alertEvents.createAlert.mock.calls[0][0];
    expect(arg.category).toBe('PAYMENT');
    expect(arg.severity).toBe('CRITICAL');
    expect(arg.sourceType).toBe('order');
    expect(arg.sourceId).toBeNull();
    expect(arg.message).toMatch(/No signatures match/);
    expect(arg.context).toMatchObject({
      ip: '1.2.3.4',
      userAgent: 'Stripe/1.0',
    });
  });

  it('handleStripeEvent throws → emits PAYMENT/CRITICAL', async () => {
    const { controller, alertEvents } = buildController({
      handleStripeEventThrows: new Error('downstream boom'),
    });
    const req = {
      headers: { 'stripe-signature': 'sig-ok' },
      ip: '5.6.7.8',
      rawBody: Buffer.from('{}'),
    } as any;
    const reply = makeReplyStub();

    await controller.stripeWebhook(req, reply as any);
    await Promise.resolve();
    await Promise.resolve();

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(alertEvents.createAlert).toHaveBeenCalledTimes(1);
    expect(alertEvents.createAlert.mock.calls[0][0].severity).toBe('CRITICAL');
  });

  it('successful webhook → passes the verified provider identity and does NOT emit AlertEvent', async () => {
    const { controller, paymentService, alertEvents } = buildController({});
    const req = {
      headers: { 'stripe-signature': 'sig-ok' },
      ip: '5.6.7.8',
      rawBody: Buffer.from('{}'),
    } as any;
    const reply = makeReplyStub();

    await controller.stripeWebhook(req, reply as any);
    await Promise.resolve();

    expect(reply.code).toHaveBeenCalledWith(200);
    expect(paymentService.handleStripeEvent).toHaveBeenCalledWith(
      { id: 'evt_1' },
      ['ppi_stripe_1'],
    );
    expect(alertEvents.createAlert).not.toHaveBeenCalled();
  });

  it('createAlert throwing does NOT prevent reply.code(400)', async () => {
    const alertEvents = {
      createAlert: jest.fn().mockRejectedValue(new Error('alert DB down')),
    };
    const { controller } = buildController({
      verifyWebhookThrows: new Error('bad sig'),
      alertEvents,
    });
    const req = {
      headers: { 'stripe-signature': 'x' },
      ip: '9.9.9.9',
      rawBody: Buffer.from('{}'),
    } as any;
    const reply = makeReplyStub();

    await expect(controller.stripeWebhook(req, reply as any)).resolves.not.toThrow();
    await Promise.resolve();
    await Promise.resolve();
    expect(reply.code).toHaveBeenCalledWith(400);
  });

  it('missing stripe-signature header → 400 + emit AlertEvent (CRITICAL)', async () => {
    // P2-A2 review fix(Important #1): missing-header 早退路径也必须发 alert
    // (spec §7.2.b — 攻击信号或反代配置错误)。
    const { controller, alertEvents } = buildController({});
    const req = {
      headers: { 'user-agent': 'curl/8' },
      ip: '1.1.1.1',
      rawBody: Buffer.from('{}'),
    } as any;
    const reply = makeReplyStub();

    await controller.stripeWebhook(req, reply as any);
    await Promise.resolve();
    await Promise.resolve();

    expect(reply.code).toHaveBeenCalledWith(400);
    expect(alertEvents.createAlert).toHaveBeenCalledTimes(1);
    const arg = alertEvents.createAlert.mock.calls[0][0];
    expect(arg.category).toBe('PAYMENT');
    expect(arg.severity).toBe('CRITICAL');
    expect(arg.sourceType).toBe('order');
    expect(arg.sourceId).toBeNull();
    expect(arg.title).toMatch(/Stripe-Signature/);
    expect(arg.context).toMatchObject({
      ip: '1.1.1.1',
      userAgent: 'curl/8',
      reason: 'missing_signature_header',
    });
  });
});

describe('PaymentController.createOrder — redirect callback URL defaults', () => {
  function buildController() {
    const paymentService = {
      createOrder: jest.fn().mockResolvedValue({
        order: { id: 'order-1' },
        payUrl: 'https://checkout.stripe.com/pay/test',
      }),
    };
    const config = {
      get: jest.fn((key: string): string | undefined => {
        if (key === 'PAYMENT_CALLBACK_ALLOWED_ORIGINS') {
          return 'https://user-test.codesphere.run,https://app.example.com';
        }
        return '';
      }),
    };
    const controller = new PaymentController(
      paymentService as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
      config as any,
    );
    return { controller, paymentService };
  }

  it('rejects order creation without an explicit tenant header', async () => {
    const { controller, paymentService } = buildController();

    await expect(controller.createOrder(
      'user-1',
      { orderType: 'RECHARGE', channel: 'STRIPE', amountCents: 1000 },
      { headers: {} } as any,
      undefined,
    )).rejects.toThrow('充值和购买必须明确指定工作区');

    expect(paymentService.createOrder).not.toHaveBeenCalled();
  });

  it('fills missing Stripe callbacks from request origin', async () => {
    const { controller, paymentService } = buildController();

    await controller.createOrder(
      'user-1',
      {
        orderType: 'RECHARGE',
        channel: 'STRIPE',
        amountCents: 1000,
      },
      {
        headers: {
          origin: 'https://user-test.codesphere.run',
          host: 'saas-admin-test.codesphere.run',
          'x-forwarded-proto': 'https',
        },
      } as any,
      'tenant-1',
    );

    expect(paymentService.createOrder).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        successUrl: 'https://user-test.codesphere.run/payment/success',
        cancelUrl: 'https://user-test.codesphere.run/payment/cancel',
      }),
      'tenant-1',
    );
  });

  it('fills missing Alipay callbacks from request origin', async () => {
    const { controller, paymentService } = buildController();

    await controller.createOrder(
      'user-1',
      {
        orderType: 'RECHARGE',
        channel: 'ALIPAY',
        amountCents: 1000,
      },
      {
        headers: {
          origin: 'https://user-test.codesphere.run',
        },
      } as any,
      'tenant-1',
    );

    expect(paymentService.createOrder).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        successUrl: 'https://user-test.codesphere.run/payment/success',
        cancelUrl: 'https://user-test.codesphere.run/payment/cancel',
      }),
      'tenant-1',
    );
  });

  it('keeps explicit Stripe callbacks unchanged', async () => {
    const { controller, paymentService } = buildController();

    await controller.createOrder(
      'user-1',
      {
        orderType: 'RECHARGE',
        channel: 'STRIPE',
        amountCents: 1000,
        successUrl: 'https://app.example.com/done',
        cancelUrl: 'https://app.example.com/cancelled',
      },
      {
        headers: {
          origin: 'https://user-test.codesphere.run',
        },
      } as any,
      'tenant-1',
    );

    expect(paymentService.createOrder).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        successUrl: 'https://app.example.com/done',
        cancelUrl: 'https://app.example.com/cancelled',
      }),
      'tenant-1',
    );
  });

  it('rejects explicit Stripe callbacks outside the allowlist', async () => {
    const { controller, paymentService } = buildController();

    await expect(controller.createOrder(
      'user-1',
      {
        orderType: 'RECHARGE',
        channel: 'STRIPE',
        amountCents: 1000,
        successUrl: 'https://evil.example/done',
        cancelUrl: 'https://app.example.com/cancelled',
      },
      {
        headers: {
          origin: 'https://user-test.codesphere.run',
        },
      } as any,
      'tenant-1',
    )).rejects.toThrow('successUrl 不在允许的支付回跳域名内');

    expect(paymentService.createOrder).not.toHaveBeenCalled();
  });

  it('does not infer callbacks from an unlisted forwarded host', async () => {
    const { controller, paymentService } = buildController();

    await controller.createOrder(
      'user-1',
      {
        orderType: 'RECHARGE',
        channel: 'STRIPE',
        amountCents: 1000,
      },
      {
        headers: {
          host: 'evil.example',
          'x-forwarded-host': 'evil.example',
          'x-forwarded-proto': 'https',
        },
      } as any,
      'tenant-1',
    );

    expect(paymentService.createOrder).toHaveBeenCalledWith(
      'user-1',
      expect.not.objectContaining({
        successUrl: expect.any(String),
        cancelUrl: expect.any(String),
      }),
      'tenant-1',
    );
  });
});

describe('PaymentController.getPaymentMethods', () => {
  it('validates query and returns available payment methods', async () => {
    const paymentService = {
      getAvailablePaymentMethods: jest.fn().mockResolvedValue({
        methods: [{ channel: 'ALIPAY', label: '支付宝', currency: 'cny', mode: 'redirect' }],
      }),
    };
    const controller = new PaymentController(
      paymentService as any,
      {} as any,
      {} as any,
      {} as any,
      undefined,
    );

    await expect(controller.getPaymentMethods({
      orderType: 'RECHARGE',
      productId: '799a4d5f-2b8e-4a4e-889b-26ca83383176',
    })).resolves.toEqual({
      code: 0,
      message: 'ok',
      data: {
        methods: [{ channel: 'ALIPAY', label: '支付宝', currency: 'cny', mode: 'redirect' }],
      },
    });

    expect(paymentService.getAvailablePaymentMethods).toHaveBeenCalledWith({
      orderType: 'RECHARGE',
      productId: '799a4d5f-2b8e-4a4e-889b-26ca83383176',
    });
  });
});

describe('PaymentController payment notifications', () => {
  function buildNotifyController() {
    const paymentService = {
      handlePaymentCallback: jest.fn().mockResolvedValue(true),
      verifyAlipayNotify: jest.fn().mockResolvedValue({ valid: true }),
    };
    const wechatPayService = {
      verifyNotifySign: jest.fn().mockResolvedValue({
        trade_state: 'SUCCESS',
        transaction_id: 'wx-tx-1',
        out_trade_no: 'order-wx-1',
        amount: { total: 1000 },
      }),
    };
    const alipayService = {
      verifyNotifySign: jest.fn().mockReturnValue(true),
    };
    const redis = {
      set: jest.fn().mockResolvedValue('OK'),
      del: jest.fn().mockResolvedValue(1),
    };
    const controller = new PaymentController(
      paymentService as any,
      wechatPayService as any,
      alipayService as any,
      redis as any,
      undefined,
    );
    return { controller, paymentService, wechatPayService, alipayService, redis };
  }

  it('stores WeChat notification replay keys for 30 days', async () => {
    const { controller, paymentService, redis } = buildNotifyController();
    const reply = makeReplyStub();

    await controller.wechatNotify(
      {
        headers: {},
        rawBody: Buffer.from('{"id":"notify-wx-1"}'),
        body: {
          id: 'notify-wx-1',
          resource: {
            ciphertext: 'ciphertext',
            nonce: 'nonce',
            associated_data: 'associated-data',
          },
        },
      } as any,
      reply as any,
    );

    expect(redis.set).toHaveBeenCalledWith(
      paymentNotifyReplayKey('wechat', 'notify-wx-1'),
      '1',
      'EX',
      PAYMENT_NOTIFY_REPLAY_TTL_SECONDS,
      'NX',
    );
    expect(paymentService.handlePaymentCallback).toHaveBeenCalledWith(
      'wx-tx-1',
      'order-wx-1',
      'WECHAT',
      { paidAmountCents: 1000 },
    );
    expect(reply.send).toHaveBeenCalledWith({ code: 'SUCCESS', message: '成功' });
  });

  it('stores Alipay notification replay keys for 30 days and converts amounts with decimal rounding', async () => {
    const { controller, paymentService, redis } = buildNotifyController();
    const reply = makeReplyStub();

    await controller.alipayNotify(
      {
        body: {
          notify_id: 'notify-ali-1',
          trade_status: 'TRADE_SUCCESS',
          trade_no: 'ali-tx-1',
          out_trade_no: 'order-ali-1',
          total_amount: '1.005',
        },
      } as any,
      reply as any,
    );

    expect(redis.set).toHaveBeenCalledWith(
      paymentNotifyReplayKey('alipay', 'notify-ali-1'),
      '1',
      'EX',
      PAYMENT_NOTIFY_REPLAY_TTL_SECONDS,
      'NX',
    );
    expect(paymentService.handlePaymentCallback).toHaveBeenCalledWith(
      'ali-tx-1',
      'order-ali-1',
      'ALIPAY',
      { paidAmountCents: 101, paidCurrency: 'cny' },
    );
    expect(reply.type).toHaveBeenCalledWith('text/plain');
    expect(reply.send).toHaveBeenCalledWith('success');
  });

  it('passes all indistinguishable verified Alipay instance ids into callback handling', async () => {
    const { controller, paymentService } = buildNotifyController();
    paymentService.verifyAlipayNotify.mockResolvedValueOnce({
      valid: true,
      verifiedPaymentProviderInstanceIds: ['ppi_alipay_1'],
    });
    const reply = makeReplyStub();

    await controller.alipayNotify(
      {
        body: {
          notify_id: 'notify-ali-instance',
          trade_status: 'TRADE_SUCCESS',
          trade_no: 'ali-tx-instance',
          out_trade_no: 'order-ali-instance',
          total_amount: '1.00',
        },
      } as any,
      reply as any,
    );

    expect(paymentService.handlePaymentCallback).toHaveBeenCalledWith(
      'ali-tx-instance',
      'order-ali-instance',
      'ALIPAY',
      {
        paidAmountCents: 100,
        paidCurrency: 'cny',
        verifiedPaymentProviderInstanceIds: ['ppi_alipay_1'],
      },
    );
  });

  it('returns WeChat FAIL and clears replay key when payment handling is rejected', async () => {
    const { controller, paymentService, redis } = buildNotifyController();
    paymentService.handlePaymentCallback.mockResolvedValueOnce(false);
    const reply = makeReplyStub();

    await controller.wechatNotify(
      {
        headers: {},
        rawBody: Buffer.from('{"id":"notify-wx-fail"}'),
        body: {
          id: 'notify-wx-fail',
          resource: {
            ciphertext: 'ciphertext',
            nonce: 'nonce',
            associated_data: 'associated-data',
          },
        },
      } as any,
      reply as any,
    );

    expect(redis.del).toHaveBeenCalledWith(paymentNotifyReplayKey('wechat', 'notify-wx-fail'));
    expect(reply.status).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ code: 'FAIL', message: '处理失败' });
  });

  it('clears WeChat replay key when payment handling throws so provider retries can run', async () => {
    const { controller, paymentService, redis } = buildNotifyController();
    paymentService.handlePaymentCallback.mockRejectedValueOnce(new Error('db down'));
    const reply = makeReplyStub();

    await controller.wechatNotify(
      {
        headers: {},
        rawBody: Buffer.from('{"id":"notify-wx-throw"}'),
        body: {
          id: 'notify-wx-throw',
          resource: {
            ciphertext: 'ciphertext',
            nonce: 'nonce',
            associated_data: 'associated-data',
          },
        },
      } as any,
      reply as any,
    );

    expect(redis.del).toHaveBeenCalledWith(paymentNotifyReplayKey('wechat', 'notify-wx-throw'));
    expect(reply.status).toHaveBeenCalledWith(500);
    expect(reply.send).toHaveBeenCalledWith({ code: 'FAIL', message: '处理失败' });
  });

  it('returns Alipay fail and clears replay key when payment handling is rejected', async () => {
    const { controller, paymentService, redis } = buildNotifyController();
    paymentService.handlePaymentCallback.mockResolvedValueOnce(false);
    const reply = makeReplyStub();

    await controller.alipayNotify(
      {
        body: {
          notify_id: 'notify-ali-fail',
          trade_status: 'TRADE_SUCCESS',
          trade_no: 'ali-tx-fail',
          out_trade_no: 'order-ali-fail',
          total_amount: '1.00',
        },
      } as any,
      reply as any,
    );

    expect(redis.del).toHaveBeenCalledWith(paymentNotifyReplayKey('alipay', 'notify-ali-fail'));
    expect(reply.type).toHaveBeenCalledWith('text/plain');
    expect(reply.send).toHaveBeenCalledWith('fail');
  });

  it('clears Alipay replay key when payment handling throws so provider retries can run', async () => {
    const { controller, paymentService, redis } = buildNotifyController();
    paymentService.handlePaymentCallback.mockRejectedValueOnce(new Error('db down'));
    const reply = makeReplyStub();

    await controller.alipayNotify(
      {
        body: {
          notify_id: 'notify-ali-throw',
          trade_status: 'TRADE_SUCCESS',
          trade_no: 'ali-tx-throw',
          out_trade_no: 'order-ali-throw',
          total_amount: '1.00',
        },
      } as any,
      reply as any,
    );

    expect(redis.del).toHaveBeenCalledWith(paymentNotifyReplayKey('alipay', 'notify-ali-throw'));
    expect(reply.type).toHaveBeenCalledWith('text/plain');
    expect(reply.send).toHaveBeenCalledWith('fail');
  });

  it('hashes notification ids before using them as Redis key segments', async () => {
    const { controller, redis } = buildNotifyController();
    const reply = makeReplyStub();
    const notificationId = 'notify\r\nINJECT';

    await controller.wechatNotify(
      {
        headers: {},
        rawBody: Buffer.from('{"id":"notify"}'),
        body: {
          id: notificationId,
          resource: {
            ciphertext: 'ciphertext',
            nonce: 'nonce',
            associated_data: 'associated-data',
          },
        },
      } as any,
      reply as any,
    );

    const redisKey = redis.set.mock.calls[0][0] as string;
    expect(redisKey).toBe(paymentNotifyReplayKey('wechat', notificationId));
    expect(redisKey).not.toContain('\r');
    expect(redisKey).not.toContain('\n');
  });
});
