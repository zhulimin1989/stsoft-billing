import { PartnerApiController } from './partner-api.controller';

describe('PartnerApiController', () => {
  function buildController() {
    const catalog = {
      resolveProduct: jest.fn().mockResolvedValue({ id: 'prod-1', slug: 'rdclaw', record: {} }),
      getCatalog: jest.fn().mockResolvedValue({ products: [{ id: 'prod-1' }], plans: [{ id: 'free' }] }),
      getPlans: jest.fn().mockResolvedValue([{ id: 'free' }]),
    };
    const provisioning = {
      provision: jest.fn().mockResolvedValue({ userId: 'user-1', productId: 'prod-1' }),
      resolveProductSubject: jest.fn().mockImplementation(
        async (_productId: string, userId: string, tenantId?: string | null) => ({
          userId,
          tenantId: tenantId ?? null,
        }),
      ),
    };
    const payment = {
      createOrder: jest.fn().mockResolvedValue({
        order: { id: 'order-1' },
        payUrl: 'https://checkout.stripe.com/pay/test',
      }),
      getUserOrders: jest.fn().mockResolvedValue({
        items: [{ id: 'order-1' }],
        total: 1,
        page: 2,
        pageSize: 10,
        totalPages: 1,
      }),
      getOrderStatus: jest.fn().mockResolvedValue({ status: 'PENDING', paidAt: null, cancelReason: null }),
      getOrder: jest.fn().mockResolvedValue({ id: 'order-1' }),
      cancelOrder: jest.fn().mockResolvedValue(undefined),
      getAvailablePaymentMethods: jest.fn().mockResolvedValue({
        methods: [{ channel: 'STRIPE', label: '银行卡', currency: 'usd', mode: 'redirect' }],
      }),
    };
    const billingSubject = { tenantId: 'tenant-1', billingAccountId: 'ba-1', tenantRole: 'owner' };
    const billing = {
      isSelfOperatedCodingPlanProduct: jest.fn().mockResolvedValue(false),
      resolveSubjectForUser: jest.fn().mockResolvedValue(billingSubject),
      getCurrentSubscriptionBySlug: jest.fn().mockResolvedValue({
        productId: 'prod-1',
        billingMode: 'SUBSCRIPTION',
        planId: 'plan-pro',
        planName: 'Pro',
        billingPeriod: 'monthly',
        monthlyPrice: 9900,
        monthlyCredits: 100000,
        rateLimitRpm: 60,
        rateLimitTpm: 0,
        maxContextWindow: 200000,
        features: [],
        status: 'active',
        expiresAt: null,
      }),
      resolveSelfOpEntitlementId: jest.fn().mockResolvedValue({ selfOp: false, entitlementId: null }),
      assertCodingPlanEntitlementAccess: jest.fn().mockResolvedValue({ id: 'ent-1' }),
      getTransactions: jest.fn().mockResolvedValue({
        items: [{ id: 'tx-1' }],
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
      }),
      getDailySummary: jest.fn().mockResolvedValue([{ date: '2026-07-01', creditConsumption: 10 }]),
      getMonthlySummary: jest.fn().mockResolvedValue([{ month: '2026-07', creditConsume: 10 }]),
    };
    const credits = {
      getSummary: jest.fn().mockResolvedValue({
        quotaCredits: 80,
        bonusCredits: 20,
        grantCredits: 5,
        totalCredits: 105,
        usedThisMonth: 15,
        usedThisCycle: 15,
        billingCycleStart: '2026-07-01T00:00:00.000Z',
      }),
      getTransactions: jest.fn().mockResolvedValue({
        items: [{
          id: 'ctx-1',
          userId: 'user-1',
          productId: 'prod-1',
          subscriptionId: 'sub-1',
          type: 'CONSUME',
          creditsAmount: -15,
          source: 'chat:gpt-4.1',
          quotaAfter: 80,
          bonusAfter: 20,
          createdAt: '2026-07-01T00:00:00.000Z',
        }],
        total: 1,
        page: 1,
        pageSize: 20,
        totalPages: 1,
      }),
    };
    const subscriptionResolver = {
      resolve: jest.fn().mockResolvedValue({ subscriptionId: 'sub-1' }),
    };
    const prisma = {
      product: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'prod-1',
          slug: 'rdclaw',
          name: 'RDClaw',
          billingMode: 'SUBSCRIPTION',
          isActive: true,
          defaultPlanId: 'plan-pro',
          webhookUrl: 'https://saas.example.com/webhook',
        }),
      },
      plan: {
        findFirst: jest.fn().mockResolvedValue({ id: 'plan-pro' }),
      },
      boosterPack: {
        findFirst: jest.fn().mockResolvedValue({ id: 'booster-1' }),
      },
      bundleSku: {
        findFirst: jest.fn().mockResolvedValue({
          items: [{ productId: 'prod-1' }],
        }),
      },
      productExternalUserBinding: {
        findMany: jest.fn().mockImplementation(async (
          { where }: { where: { userId: { in: string[] } } },
        ) =>
          where.userId.in.map((userId) => ({
            userId,
            externalUserId: userId === 'internal-user-id' ? 'external-user' : userId,
          }))),
      },
    };
    const config = {
      get: jest.fn((key: string) => {
        if (key === 'PARTNER_API_PUBLIC_BASE_URL') return 'https://partner.example.com';
        if (key === 'PAYMENT_CALLBACK_ALLOWED_ORIGINS') return 'https://global.example.com';
        return undefined;
      }),
    };
    const controller = new PartnerApiController(
      catalog as never,
      provisioning as never,
      payment as never,
      billing as never,
      credits as never,
      subscriptionResolver as never,
      prisma as never,
      config as never,
    );
    return { controller, catalog, provisioning, payment, billing, credits, subscriptionResolver, prisma, billingSubject };
  }

  it('rejects undeclared query parameters on catalog endpoints without query contracts', async () => {
    const { controller, catalog } = buildController();
    const request = {
      headers: {},
      productContext: {
        id: 'prod-1',
        slug: 'rdclaw',
        name: 'RDClaw',
        billingMode: 'SUBSCRIPTION',
        allowedPaymentCallbackOrigins: null,
      },
      query: { typo: '1' },
    } as never;

    await expect(controller.getCatalog(request)).rejects.toThrow(
      'Unrecognized query parameter(s): typo',
    );
    expect(catalog.getCatalog).not.toHaveBeenCalled();
  });

  const req = {
    headers: {},
    productContext: {
      id: 'prod-1',
      slug: 'rdclaw',
      name: 'RDClaw',
      billingMode: 'SUBSCRIPTION',
      allowedPaymentCallbackOrigins: null,
    },
  } as never;

  it('returns current product metadata with partner API endpoints', async () => {
    const { controller, prisma } = buildController();

    const result = await controller.getCurrentProduct(req);

    expect(prisma.product.findFirst).toHaveBeenCalledWith({
      where: { id: 'prod-1', deletedAt: null },
      select: {
        id: true,
        slug: true,
        name: true,
        billingMode: true,
        isActive: true,
        defaultPlanId: true,
        webhookUrl: true,
      },
    });
    expect(result.data).toMatchObject({
      productId: 'prod-1',
      productSlug: 'rdclaw',
      endpoints: {
        provision: 'https://partner.example.com/partner/v1/tenants/provision',
        currentProduct: 'https://partner.example.com/partner/v1/product/current',
        catalog: 'https://partner.example.com/partner/v1/catalog',
        plans: 'https://partner.example.com/partner/v1/catalog/plans',
        paymentCreate: 'https://partner.example.com/partner/v1/payment/create',
        paymentOrders: 'https://partner.example.com/partner/v1/payment/orders',
        paymentOrderStatus: 'https://partner.example.com/partner/v1/payment/orders/{id}/status',
        paymentOrder: 'https://partner.example.com/partner/v1/payment/orders/{id}',
        billingCurrentSubscription: 'https://partner.example.com/partner/v1/billing/current-subscription',
        billingCredits: 'https://partner.example.com/partner/v1/billing/credits',
        billingCreditTransactions: 'https://partner.example.com/partner/v1/billing/credit-transactions',
      },
    });
  });

  it('returns the product-scoped catalog summary', async () => {
    const { controller, catalog } = buildController();

    const result = await controller.getCatalog(req);

    expect(catalog.resolveProduct).toHaveBeenCalledWith({ productId: 'prod-1' });
    expect(catalog.getCatalog).toHaveBeenCalledWith({ id: 'prod-1', slug: 'rdclaw', record: {} });
    expect(result.data).toEqual({ products: [{ id: 'prod-1' }], plans: [{ id: 'free' }] });
  });

  it('derives provisioning product identity from the token context', async () => {
    const { controller, provisioning } = buildController();

    await controller.provision(req, {
      idempotencyKey: 'provision:user-1',
      user: { id: 'user-1' },
      tenant: { id: 'tenant-1' },
    });

    expect(provisioning.provision).toHaveBeenCalledWith({
      idempotencyKey: 'provision:user-1',
      user: { id: 'user-1' },
      tenant: { id: 'tenant-1' },
      productId: 'prod-1',
      productSlug: 'rdclaw',
    });
  });

  it('injects token product id for partner recharge orders', async () => {
    const { controller, payment } = buildController();

    await controller.createPaymentOrder(req, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      orderType: 'RECHARGE',
      channel: 'STRIPE',
      amountCents: 1000,
      currency: 'USD',
      idempotencyKey: 'order-idem-1',
    });

    expect(payment.createOrder).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        orderType: 'RECHARGE',
        channel: 'STRIPE',
        amountCents: 1000,
        currency: 'usd',
        idempotencyKey: 'order-idem-1',
        productId: 'prod-1',
      }),
      'tenant-1',
      expect.objectContaining({
        id: 'prod-1',
        allowedPaymentCallbackOrigins: null,
      }),
      { userId: 'user-1', tenantId: 'tenant-1' },
    );
  });

  it('passes caller idempotency, product context, and product-bound email separately', async () => {
    const { controller, payment, provisioning } = buildController();
    provisioning.resolveProductSubject.mockResolvedValue({
      userId: 'legacy-shared-user',
      tenantId: 'legacy-shared-tenant',
      email: 'buyer@shared.example',
    });
    const productARequest = {
      headers: {},
      productContext: {
        id: 'prod-a',
        slug: 'product-a',
        name: 'Product A',
        billingMode: 'SUBSCRIPTION',
        allowedPaymentCallbackOrigins: null,
      },
    } as never;
    const productBRequest = {
      headers: {},
      productContext: {
        id: 'prod-b',
        slug: 'product-b',
        name: 'Product B',
        billingMode: 'SUBSCRIPTION',
        allowedPaymentCallbackOrigins: null,
      },
    } as never;
    const input = {
      userId: 'legacy-shared-user',
      tenantId: 'legacy-shared-tenant',
      orderType: 'RECHARGE',
      channel: 'STRIPE',
      amountCents: 1000,
      idempotencyKey: 'shared-caller-key',
    };

    await controller.createPaymentOrder(productARequest, input);
    await controller.createPaymentOrder(productBRequest, input);

    expect(payment.createOrder).toHaveBeenNthCalledWith(
      1,
      'legacy-shared-user',
      expect.objectContaining({
        idempotencyKey: 'shared-caller-key',
        productId: 'prod-a',
      }),
      'legacy-shared-tenant',
      expect.objectContaining({ id: 'prod-a' }),
      {
        userId: 'legacy-shared-user',
        tenantId: 'legacy-shared-tenant',
        customerEmail: 'buyer@shared.example',
      },
    );
    expect(payment.createOrder).toHaveBeenNthCalledWith(
      2,
      'legacy-shared-user',
      expect.objectContaining({
        idempotencyKey: 'shared-caller-key',
        productId: 'prod-b',
      }),
      'legacy-shared-tenant',
      expect.objectContaining({ id: 'prod-b' }),
      {
        userId: 'legacy-shared-user',
        tenantId: 'legacy-shared-tenant',
        customerEmail: 'buyer@shared.example',
      },
    );
  });

  it('separates internal billing identity from external purchase verification identity', async () => {
    const { controller, payment, provisioning } = buildController();
    provisioning.resolveProductSubject.mockResolvedValue({
      userId: 'internal-user-id',
      tenantId: 'internal-tenant-id',
    });

    await controller.createPaymentOrder(req, {
      userId: 'external-user',
      tenantId: 'external-tenant',
      orderType: 'RECHARGE',
      channel: 'STRIPE',
      amountCents: 1000,
      idempotencyKey: 'external-verification-10001',
    });

    expect(payment.createOrder).toHaveBeenCalledWith(
      'internal-user-id',
      expect.objectContaining({ orderType: 'RECHARGE', productId: 'prod-1' }),
      'internal-tenant-id',
      expect.objectContaining({ id: 'prod-1' }),
      { userId: 'external-user', tenantId: 'external-tenant' },
    );
  });

  it('delegates subscription product-scope validation with the authenticated product context', async () => {
    const { controller, payment, prisma } = buildController();

    await controller.createPaymentOrder(req, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      orderType: 'SUBSCRIPTION',
      channel: 'STRIPE',
      planId: 'plan-pro',
      idempotencyKey: 'idem-subscription',
    });

    expect(prisma.plan.findFirst).not.toHaveBeenCalled();
    expect(payment.createOrder).toHaveBeenCalledWith(
      'user-1',
      expect.not.objectContaining({ productId: expect.any(String) }),
      'tenant-1',
      expect.objectContaining({
        id: 'prod-1',
        allowedPaymentCallbackOrigins: null,
      }),
      { userId: 'user-1', tenantId: 'tenant-1' },
    );
  });

  it('validates explicit callback URLs against the token product allowlist', async () => {
    const { controller, payment } = buildController();
    const productReq = {
      headers: {},
      productContext: {
        id: 'prod-1',
        slug: 'rdclaw',
        name: 'RDClaw',
        billingMode: 'SUBSCRIPTION',
        allowedPaymentCallbackOrigins: ['https://product.example.com'],
      },
    } as never;

    await controller.createPaymentOrder(productReq, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      orderType: 'SUBSCRIPTION',
      channel: 'STRIPE',
      planId: 'plan-pro',
      idempotencyKey: 'idem-explicit-callback',
      successUrl: 'https://product.example.com/payment/success?order=1',
      cancelUrl: 'https://product.example.com/payment/cancel',
    });

    expect(payment.createOrder).toHaveBeenCalledWith(
      'user-1',
      expect.objectContaining({
        successUrl: 'https://product.example.com/payment/success?order=1',
        cancelUrl: 'https://product.example.com/payment/cancel',
      }),
      'tenant-1',
      expect.objectContaining({
        id: 'prod-1',
        allowedPaymentCallbackOrigins: ['https://product.example.com'],
      }),
      { userId: 'user-1', tenantId: 'tenant-1' },
    );
  });

  it('does not fall back to global Stripe callback URLs for a product-managed policy', async () => {
    const { controller, payment } = buildController();
    payment.createOrder.mockRejectedValueOnce(new Error('Stripe 回跳地址未配置'));
    const productReq = {
      headers: {},
      productContext: {
        id: 'prod-1',
        slug: 'rdclaw',
        name: 'RDClaw',
        billingMode: 'SUBSCRIPTION',
        allowedPaymentCallbackOrigins: ['https://product.example.com'],
      },
    } as never;

    await expect(controller.createPaymentOrder(productReq, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      orderType: 'SUBSCRIPTION',
      channel: 'STRIPE',
      planId: 'plan-pro',
      idempotencyKey: 'idem-no-callback',
    })).rejects.toThrow('Stripe 回跳地址未配置');

    expect(payment.createOrder).toHaveBeenCalledTimes(1);
  });

  it('does not fall back to the global Alipay return URL for a product-managed policy', async () => {
    const { controller, payment } = buildController();
    payment.createOrder.mockRejectedValueOnce(new Error('Alipay 回跳地址未配置'));
    const productReq = {
      headers: {},
      productContext: {
        id: 'prod-1',
        slug: 'rdclaw',
        name: 'RDClaw',
        billingMode: 'SUBSCRIPTION',
        allowedPaymentCallbackOrigins: ['https://product.example.com'],
      },
    } as never;

    await expect(controller.createPaymentOrder(productReq, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      orderType: 'SUBSCRIPTION',
      channel: 'ALIPAY',
      planId: 'plan-pro',
      idempotencyKey: 'idem-alipay-no-callback',
    })).rejects.toThrow('Alipay 回跳地址未配置');

    expect(payment.createOrder).toHaveBeenCalledTimes(1);
  });

  it('does not union the product callback allowlist with the global allowlist', async () => {
    const { controller, payment } = buildController();
    payment.createOrder.mockRejectedValueOnce(
      new Error('successUrl 不在允许的支付回跳域名内'),
    );
    const productReq = {
      headers: {},
      productContext: {
        id: 'prod-1',
        slug: 'rdclaw',
        name: 'RDClaw',
        billingMode: 'SUBSCRIPTION',
        allowedPaymentCallbackOrigins: ['https://product.example.com'],
      },
    } as never;

    await expect(controller.createPaymentOrder(productReq, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      orderType: 'SUBSCRIPTION',
      channel: 'STRIPE',
      planId: 'plan-pro',
      idempotencyKey: 'idem-global-callback',
      successUrl: 'https://global.example.com/payment/success',
      cancelUrl: 'https://global.example.com/payment/cancel',
    })).rejects.toThrow('successUrl 不在允许的支付回跳域名内');

    expect(payment.createOrder).toHaveBeenCalledTimes(1);
  });

  it('does not derive Stripe callback URLs from request Origin', async () => {
    const { controller, payment } = buildController();
    const productReq = {
      headers: { origin: 'https://product.example.com' },
      productContext: {
        id: 'prod-1',
        slug: 'rdclaw',
        name: 'RDClaw',
        billingMode: 'SUBSCRIPTION',
        allowedPaymentCallbackOrigins: ['https://product.example.com'],
      },
    } as never;

    await controller.createPaymentOrder(productReq, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      orderType: 'SUBSCRIPTION',
      channel: 'STRIPE',
      planId: 'plan-pro',
      idempotencyKey: 'idem-origin-callback',
    });

    expect(payment.createOrder.mock.calls[0][1]).not.toHaveProperty('successUrl');
    expect(payment.createOrder.mock.calls[0][1]).not.toHaveProperty('cancelUrl');
  });

  it('does not derive an Alipay callback URL from request Origin', async () => {
    const { controller, payment } = buildController();
    const productReq = {
      headers: { origin: 'https://product.example.com' },
      productContext: {
        id: 'prod-1',
        slug: 'rdclaw',
        name: 'RDClaw',
        billingMode: 'SUBSCRIPTION',
        allowedPaymentCallbackOrigins: ['https://product.example.com'],
      },
    } as never;

    await controller.createPaymentOrder(productReq, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      orderType: 'SUBSCRIPTION',
      channel: 'ALIPAY',
      planId: 'plan-pro',
      idempotencyKey: 'idem-alipay-origin',
    });

    expect(payment.createOrder.mock.calls[0][1]).not.toHaveProperty('successUrl');
    expect(payment.createOrder.mock.calls[0][1]).not.toHaveProperty('cancelUrl');
  });

  it('rejects payment inputs that the selected order type or channel would ignore', async () => {
    const { controller, payment } = buildController();

    await expect(controller.createPaymentOrder(req, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      orderType: 'RECHARGE',
      channel: 'STRIPE',
      amountCents: 1000,
      billingPeriod: 'monthly',
      idempotencyKey: 'ignored-billing-period',
    })).rejects.toThrow();
    await expect(controller.createPaymentOrder(req, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      orderType: 'SUBSCRIPTION',
      channel: 'WECHAT',
      planId: 'plan-pro',
      successUrl: 'https://global.example.com/payment/success',
      idempotencyKey: 'ignored-wechat-callback',
    })).rejects.toThrow();
    await expect(controller.createPaymentOrder(req, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      orderType: 'SUBSCRIPTION',
      channel: 'ALIPAY',
      planId: 'plan-pro',
      successUrl: 'https://global.example.com/payment/success',
      cancelUrl: 'https://global.example.com/payment/cancel',
      idempotencyKey: 'ignored-alipay-cancel',
    })).rejects.toThrow();

    expect(payment.createOrder).not.toHaveBeenCalled();
  });

  it('does not derive callback URLs from request Referer', async () => {
    const { controller, payment } = buildController();
    const productReq = {
      headers: { referer: 'https://product.example.com/console/billing/checkout' },
      productContext: {
        id: 'prod-1',
        slug: 'rdclaw',
        name: 'RDClaw',
        billingMode: 'SUBSCRIPTION',
        allowedPaymentCallbackOrigins: ['https://product.example.com'],
      },
    } as never;

    await controller.createPaymentOrder(productReq, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      orderType: 'SUBSCRIPTION',
      channel: 'STRIPE',
      planId: 'plan-pro',
      idempotencyKey: 'idem-referer-callback',
    });

    expect(payment.createOrder.mock.calls[0][1]).not.toHaveProperty('successUrl');
    expect(payment.createOrder.mock.calls[0][1]).not.toHaveProperty('cancelUrl');
  });

  it('does not derive callback URLs from forwarded host headers', async () => {
    const { controller, payment } = buildController();
    const productReq = {
      headers: {
        'x-forwarded-host': 'product.example.com:8443',
        'x-forwarded-proto': 'https',
      },
      productContext: {
        id: 'prod-1',
        slug: 'rdclaw',
        name: 'RDClaw',
        billingMode: 'SUBSCRIPTION',
        allowedPaymentCallbackOrigins: ['https://product.example.com:8443'],
      },
    } as never;

    await controller.createPaymentOrder(productReq, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      orderType: 'SUBSCRIPTION',
      channel: 'STRIPE',
      planId: 'plan-pro',
      idempotencyKey: 'idem-forwarded-host',
    });

    expect(payment.createOrder.mock.calls[0][1]).not.toHaveProperty('successUrl');
    expect(payment.createOrder.mock.calls[0][1]).not.toHaveProperty('cancelUrl');
  });

  it('does not create orders for plans outside the token product', async () => {
    const { controller, payment } = buildController();
    payment.createOrder.mockRejectedValueOnce(new Error('套餐不存在'));

    await expect(controller.createPaymentOrder(req, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      orderType: 'SUBSCRIPTION',
      channel: 'STRIPE',
      planId: 'plan-other',
      idempotencyKey: 'idem-plan-other',
    })).rejects.toThrow('套餐不存在');

    expect(payment.createOrder).toHaveBeenCalledTimes(1);
  });

  it('rejects bundle creation before invoking payment while no reversible channel exists', async () => {
    const { controller, payment } = buildController();

    await expect(controller.createPaymentOrder(req, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      orderType: 'BUNDLE',
      channel: 'STRIPE',
      bundleSkuId: '799a4d5f-2b8e-4a4e-889b-26ca83383176',
      idempotencyKey: 'idem-bundle-other',
    })).rejects.toThrow();

    expect(payment.createOrder).not.toHaveBeenCalled();
  });

  it('rejects product selectors in partner payment requests', async () => {
    const { controller, payment } = buildController();

    await expect(controller.createPaymentOrder(req, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      orderType: 'RECHARGE',
      channel: 'STRIPE',
      amountCents: 1000,
      idempotencyKey: 'idem-product-selector',
      productId: 'prod-2',
    })).rejects.toThrow('product identity is derived from the integration token');

    expect(payment.createOrder).not.toHaveBeenCalled();
  });

  it('requires an explicit tenant for partner payment writes', async () => {
    const { controller, payment, provisioning } = buildController();

    await expect(controller.createPaymentOrder(req, {
      userId: 'user-1',
      orderType: 'RECHARGE',
      channel: 'STRIPE',
      amountCents: 1000,
      idempotencyKey: 'idem-missing-tenant',
    })).rejects.toThrow('tenantId');

    expect(provisioning.resolveProductSubject).not.toHaveBeenCalled();
    expect(payment.createOrder).not.toHaveBeenCalled();
  });

  it('requires an idempotency key for partner payment writes', async () => {
    const { controller, payment, provisioning } = buildController();

    await expect(controller.createPaymentOrder(req, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      orderType: 'RECHARGE',
      channel: 'STRIPE',
      amountCents: 1000,
    })).rejects.toThrow();

    expect(provisioning.resolveProductSubject).not.toHaveBeenCalled();
    expect(payment.createOrder).not.toHaveBeenCalled();
  });

  it('lists orders using the token product as the product scope', async () => {
    const { controller, payment } = buildController();

    await controller.getPaymentOrders(req, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      page: '2',
      pageSize: '10',
      status: 'PENDING',
      orderType: 'RECHARGE',
    });

    expect(payment.getUserOrders).toHaveBeenCalledWith(
      'user-1',
      2,
      10,
      'PENDING',
      'RECHARGE',
      'tenant-1',
      'prod-1',
    );
  });

  it('rejects an unknown order status before querying Prisma', async () => {
    const { controller, payment, provisioning } = buildController();

    await expect(controller.getPaymentOrders(req, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      status: 'NOT_A_REAL_STATUS',
    })).rejects.toThrow();

    expect(provisioning.resolveProductSubject).not.toHaveBeenCalled();
    expect(payment.getUserOrders).not.toHaveBeenCalled();
  });

  it('reads status and order detail through the token product scope', async () => {
    const { controller, payment } = buildController();

    await controller.getPaymentOrderStatus(req, 'order-1', { userId: 'user-1', tenantId: 'tenant-1' });
    await controller.getPaymentOrder(req, 'order-1', { userId: 'user-1', tenantId: 'tenant-1' });

    expect(payment.getOrderStatus).toHaveBeenCalledWith('order-1', 'user-1', 'tenant-1', 'prod-1');
    expect(payment.getOrder).toHaveBeenCalledWith('order-1', 'user-1', 'tenant-1', 'prod-1');
    expect(payment.cancelOrder).not.toHaveBeenCalled();
  });

  it('enforces the documented order id constraints before payment lookups', async () => {
    const { controller, payment } = buildController();

    await expect(
      controller.getPaymentOrder(req, 'x'.repeat(129), {
        userId: 'user-1',
        tenantId: 'tenant-1',
      }),
    ).rejects.toThrow('String must contain at most 128 character(s)');

    expect(payment.getOrder).not.toHaveBeenCalled();
  });

  it('resolves payment methods with the token product id', async () => {
    const { controller, payment } = buildController();

    await controller.getPaymentMethods(req, { orderType: 'RECHARGE', currency: 'USD' });

    expect(payment.getAvailablePaymentMethods).toHaveBeenCalledWith({
      orderType: 'RECHARGE',
      currency: 'usd',
      productId: 'prod-1',
      allowedPaymentCallbackOrigins: null,
    });
  });

  it('reads current subscription in the token product scope', async () => {
    const { controller, billing, billingSubject } = buildController();

    const result = await controller.getBillingCurrentSubscription(req, {
      userId: 'user-1',
      tenantId: 'tenant-1',
    });

    expect(billing.resolveSubjectForUser).toHaveBeenCalledWith('user-1', 'tenant-1');
    expect(billing.getCurrentSubscriptionBySlug).toHaveBeenCalledWith(
      'user-1',
      'prod-1',
      'rdclaw',
      billingSubject,
    );
    expect(result.data).toMatchObject({ planId: 'plan-pro', billingPeriod: 'monthly' });
  });

  it('reads product-scoped credits and credit transactions', async () => {
    const { controller, credits, subscriptionResolver } = buildController();

    const creditsResult = await controller.getBillingCredits(req, {
      userId: 'user-1',
      tenantId: 'tenant-1',
    });
    const txResult = await controller.getBillingCreditTransactions(req, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      page: '1',
      pageSize: '20',
    });

    expect(subscriptionResolver.resolve).toHaveBeenCalledWith('user-1', 'prod-1', {
      tenantId: 'tenant-1',
    });
    expect(credits.getSummary).toHaveBeenCalledWith('sub-1', 'user-1');
    expect(creditsResult.data).toMatchObject({ totalCredits: 105 });
    expect(credits.getTransactions).toHaveBeenCalledWith('sub-1', 'user-1', 1, 20);
    expect((txResult.data as { items: Array<{ balanceAfter: number }> }).items[0].balanceAfter).toBe(100);
  });

  it('uses explicit entitlement id only inside the token product', async () => {
    const { controller, billing, credits, subscriptionResolver } = buildController();

    await controller.getBillingCredits(req, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      entitlementId: 'ent-1',
    });

    expect(billing.assertCodingPlanEntitlementAccess).toHaveBeenCalledWith('user-1', 'ent-1', {
      productId: 'prod-1',
      tenantId: 'tenant-1',
    });
    expect(subscriptionResolver.resolve).not.toHaveBeenCalled();
    expect(credits.getSummary).toHaveBeenCalledWith('ent-1', 'user-1');
  });

  it('returns a composed credits summary for balance cards', async () => {
    const { controller } = buildController();

    const result = await controller.getBillingCreditsSummary(req, {
      userId: 'user-1',
      tenantId: 'tenant-1',
    });

    expect(result.data).toMatchObject({
      productId: 'prod-1',
      productSlug: 'rdclaw',
      subscription: { planId: 'plan-pro' },
      credits: { totalCredits: 105 },
      totalCredits: 105,
      usedThisMonth: 15,
    });
  });

  it('keeps partner billing amount and summary reads product-scoped', async () => {
    const { controller, billing, billingSubject } = buildController();

    await controller.getBillingTransactions(req, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      page: '1',
      pageSize: '20',
    });
    await controller.getBillingDailySummary(req, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      startDate: '2026-07-01',
      endDate: '2026-07-07',
    });
    await controller.getBillingMonthlySummary(req, {
      userId: 'user-1',
      tenantId: 'tenant-1',
      year: '2026',
    });

    expect(billing.getTransactions).toHaveBeenCalledWith('user-1', 1, 20, 'prod-1', billingSubject);
    expect(billing.getDailySummary).toHaveBeenCalledWith(
      'user-1',
      new Date('2026-07-01'),
      new Date('2026-07-08'),
      undefined,
      billingSubject,
      'prod-1',
    );
    expect(billing.getMonthlySummary).toHaveBeenCalledWith('user-1', 2026, billingSubject, 'prod-1');
  });

  it('resolves external product subjects and never returns internal identity ids', async () => {
    const { controller, provisioning, payment, billing } = buildController();
    provisioning.resolveProductSubject.mockResolvedValue({
      userId: 'internal-user-id',
      tenantId: 'internal-tenant-id',
    });
    payment.getOrder.mockResolvedValue({
      id: 'order-1',
      userId: 'internal-user-id',
      tenantId: 'internal-tenant-id',
    });
    billing.getTransactions.mockResolvedValue({
      items: [{
        id: 'tx-1',
        userId: 'internal-user-id',
        tenantId: 'internal-tenant-id',
      }],
      total: 1,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    });

    const orderResult = await controller.getPaymentOrder(req, 'order-1', {
      userId: 'external-user',
      tenantId: 'external-tenant',
    });
    const transactionResult = await controller.getBillingTransactions(req, {
      userId: 'external-user',
      tenantId: 'external-tenant',
      page: '1',
      pageSize: '20',
    });

    expect(provisioning.resolveProductSubject).toHaveBeenCalledWith(
      'prod-1',
      'external-user',
      'external-tenant',
    );
    expect(payment.getOrder).toHaveBeenCalledWith(
      'order-1',
      'internal-user-id',
      'internal-tenant-id',
      'prod-1',
    );
    expect(orderResult.data).toMatchObject({
      userId: 'external-user',
      tenantId: 'external-tenant',
    });
    expect((transactionResult.data as {
      items: Array<{ userId: string; tenantId: string }>;
    }).items[0]).toMatchObject({
      userId: 'external-user',
      tenantId: 'external-tenant',
    });
  });

  it('maps each ledger actor through the product namespace and nulls unmapped actors', async () => {
    const { controller, billing, credits, prisma } = buildController();
    prisma.productExternalUserBinding.findMany.mockResolvedValue([
      { userId: 'internal-member-1', externalUserId: 'external-member-1' },
      { userId: 'internal-legacy', externalUserId: 'internal-legacy' },
    ]);
    credits.getTransactions.mockResolvedValue({
      items: [
        {
          id: 'credit-1',
          userId: 'internal-member-1',
          quotaAfter: 80,
          bonusAfter: 20,
        },
        {
          id: 'credit-2',
          userId: 'internal-unmapped',
          quotaAfter: 70,
          bonusAfter: 10,
        },
        {
          id: 'credit-3',
          userId: 'internal-legacy',
          quotaAfter: 60,
          bonusAfter: 5,
        },
      ],
      total: 3,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    });
    billing.getTransactions.mockResolvedValue({
      items: [
        { id: 'balance-1', userId: 'internal-member-1' },
        { id: 'balance-2', userId: 'internal-unmapped' },
        { id: 'balance-3', userId: 'internal-legacy' },
      ],
      total: 3,
      page: 1,
      pageSize: 20,
      totalPages: 1,
    });

    const creditResult = await controller.getBillingCreditTransactions(req, {
      userId: 'external-owner',
      tenantId: 'external-tenant',
      page: '1',
      pageSize: '20',
    });
    const balanceResult = await controller.getBillingTransactions(req, {
      userId: 'external-owner',
      tenantId: 'external-tenant',
      page: '1',
      pageSize: '20',
    });

    expect((creditResult.data as { items: Array<{ userId: string | null }> }).items)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'credit-1', userId: 'external-member-1' }),
        expect.objectContaining({ id: 'credit-2', userId: null }),
        expect.objectContaining({ id: 'credit-3', userId: null }),
      ]));
    expect((balanceResult.data as { items: Array<{ userId: string | null }> }).items)
      .toEqual(expect.arrayContaining([
        expect.objectContaining({ id: 'balance-1', userId: 'external-member-1' }),
        expect.objectContaining({ id: 'balance-2', userId: null }),
        expect.objectContaining({ id: 'balance-3', userId: null }),
      ]));
    expect(JSON.stringify(creditResult.data)).not.toContain('internal-unmapped');
    expect(JSON.stringify(balanceResult.data)).not.toContain('internal-unmapped');
    expect(JSON.stringify(creditResult.data)).not.toContain('internal-legacy');
    expect(JSON.stringify(balanceResult.data)).not.toContain('internal-legacy');
    expect(prisma.productExternalUserBinding.findMany).toHaveBeenCalledWith({
      where: {
        productId: 'prod-1',
        userId: { in: ['internal-member-1', 'internal-unmapped', 'internal-legacy'] },
      },
      select: {
        userId: true,
        externalUserId: true,
      },
    });
  });

  it('rejects invalid, reversed, and unbounded daily summary date ranges', async () => {
    const { controller, billing } = buildController();

    await expect(controller.getBillingDailySummary(req, {
      userId: 'user-1',
      startDate: '2026-02-30',
      endDate: '2026-03-01',
    })).rejects.toThrow('日期格式不正确');
    await expect(controller.getBillingDailySummary(req, {
      userId: 'user-1',
      startDate: '2026-07-02',
      endDate: '2026-07-01',
    })).rejects.toThrow('startDate 不能晚于 endDate');
    await expect(controller.getBillingDailySummary(req, {
      userId: 'user-1',
      startDate: '2025-01-01',
      endDate: '2026-01-02',
    })).rejects.toThrow('日期范围不能超过 366 天');

    expect(billing.getDailySummary).not.toHaveBeenCalled();

    await controller.getBillingDailySummary(req, {
      userId: 'user-1',
      startDate: '2025-01-01',
      endDate: '2026-01-01',
    });
    expect(billing.getDailySummary).toHaveBeenCalledWith(
      'user-1',
      new Date('2025-01-01T00:00:00.000Z'),
      new Date('2026-01-02T00:00:00.000Z'),
      undefined,
      expect.any(Object),
      'prod-1',
    );
  });

  it('validates provisioning input and returns only the external subject ids', async () => {
    const { controller, provisioning } = buildController();
    provisioning.provision.mockResolvedValue({
      userId: 'internal-user-id',
      tenantId: 'internal-tenant-id',
      productId: 'prod-1',
      productSlug: 'rdclaw',
      apiKey: {
        id: 'key-1',
        prefix: 'rk-12345678',
        plainKey: null,
        created: false,
        rotated: false,
      },
      subscription: null,
    });

    await expect(controller.provision(req, {
      idempotencyKey: 'provision:external-user',
      user: { id: 'external-user', typo: true },
    })).rejects.toThrow('Unrecognized key');

    await expect(controller.provision(req, {
      user: { id: 'external-user' },
    })).rejects.toThrow('Required');

    const result = await controller.provision(req, {
      idempotencyKey: 'provision:external-user',
      user: { id: 'external-user' },
      tenant: { id: 'external-tenant' },
      ensureFreePlan: false,
    });

    expect(result.data).toMatchObject({
      userId: 'external-user',
      tenantId: 'external-tenant',
      productId: 'prod-1',
    });
  });

  it('rejects product selectors in partner billing reads', async () => {
    const { controller, credits } = buildController();

    await expect(controller.getBillingCredits(req, {
      userId: 'user-1',
      productId: 'prod-2',
    })).rejects.toThrow('product identity is derived from the integration token');

    expect(credits.getSummary).not.toHaveBeenCalled();
  });
});
