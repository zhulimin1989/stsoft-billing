import { ConfigService } from '@nestjs/config';
import { CodingPlanFulfillmentMode, ProductBillingMode } from '@prisma/client';
import { CodingPlanProviderEntitlementAttemptService } from '../billing/coding-plan-provider-entitlement-attempt.service';
import { PrismaService } from '../prisma/prisma.service';
import { CodingPlanFulfillmentService } from './coding-plan-fulfillment.service';

const ENCRYPTION_KEY = 'a'.repeat(64);
const ROUTE = {
  id: 'route-1',
  providerLineId: 'line-1',
  upstreamProductId: 'prod_001',
  providerLine: {
    id: 'line-1',
    code: 'zhipu_overseas_primary',
    providerCode: 'zhipu',
    adapterType: 'zhipu_partner',
    salesEnabled: true,
  },
};
const PROVIDER_LINE = {
  id: 'line-1',
  code: 'zhipu_overseas_primary',
  name: 'Zhipu Overseas Primary',
  providerCode: 'zhipu',
  providerAccountIdentityId: 'pai-zhipu-main',
  providerName: 'Zhipu',
  adapterType: 'zhipu_partner',
  environment: 'production',
  apiBaseUrl: 'https://api.z.ai',
  authType: 'partner_signature',
  partnerCode: 'partner-code',
  partnerSecretKey: 'partner-secret',
  qpsConfig: null,
  capabilities: null,
  dedicatedEndpoints: [],
  metadata: null,
};

function buildService(overrides: {
  prisma?: Record<string, any>;
  config?: Record<string, any>;
  resaleRoutes?: Record<string, any>;
  providerLines?: Record<string, any>;
  adapterRegistry?: Record<string, any>;
  adapter?: Record<string, any>;
} = {}) {
  const adapter = {
    createOrder: jest.fn().mockResolvedValue({
      upstreamOrderId: 'provider-order-1',
      apiKey: 'sk-abcdefghijklmnopqrstuvwxyz',
      secretKey: 'secret-abcdefghijklmnopqrstuvwxyz',
      credentialFormat: 'apiKey.secretKey',
      productStartTime: '2026-01-01 00:00:00',
      productEndTime: '2026-02-01 23:59:59',
      raw: {
        code: 200,
        data: {
          apiKey: 'sk-abcdefghijklmnopqrstuvwxyz',
          secretKey: 'secret-abcdefghijklmnopqrstuvwxyz',
          orderId: 'provider-order-1',
        },
      },
    }),
    ...overrides.adapter,
  };
  const prisma = {
    $transaction: jest.fn(),
    plan: {
      findUnique: jest.fn(),
    },
    codingPlanEntitlement: {
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    codingPlanProviderEntitlement: {
      findUnique: jest.fn(),
      update: jest.fn(),
      create: jest.fn().mockResolvedValue({ id: 'provider-entitlement-1' }),
      updateMany: jest.fn().mockResolvedValue({ count: 1 }),
    },
    ...overrides.prisma,
  };
  prisma.$transaction.mockImplementation(
    async (callback: (tx: typeof prisma) => unknown) => callback(prisma),
  );
  const config = {
    get: jest.fn((key: string) => key === 'ENCRYPTION_KEY' ? ENCRYPTION_KEY : undefined),
    ...overrides.config,
  };
  const resaleRoutes = {
    resolveRoute: jest.fn().mockResolvedValue(ROUTE),
    resolveRoutes: jest.fn().mockResolvedValue([ROUTE]),
    ...overrides.resaleRoutes,
  };
  const providerLines = {
    getForFulfillment: jest.fn().mockResolvedValue(PROVIDER_LINE),
    ...overrides.providerLines,
  };
  const adapterRegistry = {
    get: jest.fn().mockReturnValue(adapter),
    ...overrides.adapterRegistry,
  };
  const entitlementAttempts = new CodingPlanProviderEntitlementAttemptService(
    prisma as unknown as PrismaService,
  );
  return {
    service: new CodingPlanFulfillmentService(
      prisma as unknown as PrismaService,
      config as unknown as ConfigService,
      resaleRoutes as any,
      providerLines as any,
      adapterRegistry as any,
      entitlementAttempts,
    ),
    prisma,
    config,
    resaleRoutes,
    providerLines,
    adapterRegistry,
    adapter,
  };
}

describe('CodingPlanFulfillmentService', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('skips non CodingPlan products', async () => {
    const { service, prisma } = buildService();
    prisma.plan.findUnique.mockResolvedValue({
      id: 'plan-1',
      productId: 'product-1',
      features: '[]',
      product: { billingMode: ProductBillingMode.SUBSCRIPTION },
    });

    await expect(service.fulfillSubscriptionOrder({
      orderId: 'order-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'product-1',
      planId: 'plan-1',
    })).resolves.toBe('skipped');

    expect(prisma.codingPlanProviderEntitlement.create).not.toHaveBeenCalled();
  });

  it('activates resale order through configured route, provider line, and adapter', async () => {
    const upstreamApiKey = 'sk-abcdefghijklmnopqrstuvwxyz';
    const upstreamSecret = 'secret-abcdefghijklmnopqrstuvwxyz';
    const orderId = '9089cd6f-6e80-4bef-9d46-ace21f1fbf5a';
    const userId = '325a5341-78fe-4e5e-91c8-11a3d375c4c2';
    const { service, prisma, resaleRoutes, providerLines, adapterRegistry, adapter } = buildService({
      adapter: {
        createOrder: jest.fn().mockResolvedValue({
          upstreamOrderId: 'zhipu-order-1',
          apiKey: upstreamApiKey,
          secretKey: upstreamSecret,
          credentialFormat: 'apiKey.secretKey',
          productStartTime: '2026-01-01 00:00:00',
          productEndTime: '2026-02-01 23:59:59',
          raw: {
            code: 200,
            data: {
              apiKey: upstreamApiKey,
              secretKey: upstreamSecret,
              orderId: 'zhipu-order-1',
            },
          },
        }),
      },
    });
    prisma.plan.findUnique.mockResolvedValue({
      id: 'plan-1',
      productId: 'product-1',
      product: {
        billingMode: ProductBillingMode.CODING_PLAN,
        codingPlanFulfillmentMode: CodingPlanFulfillmentMode.provider_resale,
      },
    });
    prisma.codingPlanProviderEntitlement.findUnique.mockResolvedValue(null);

    await expect(service.fulfillSubscriptionOrder({
      orderId,
      userId,
      tenantId: 'tenant-1',
      productId: 'product-1',
      planId: 'plan-1',
      subscriptionId: 'entitlement-1',
      currency: 'USD',
      market: 'global',
      salesChannel: 'web',
      userSegmentIds: ['seg-vip'],
    })).resolves.toBe('activated');

    expect(resaleRoutes.resolveRoutes).toHaveBeenCalledWith({
      planId: 'plan-1',
      userId,
      tenantId: 'tenant-1',
      currency: 'USD',
      market: 'global',
      salesChannel: 'web',
      userSegmentId: undefined,
      userSegmentIds: ['seg-vip'],
    });
    expect(providerLines.getForFulfillment).toHaveBeenCalledWith('line-1');
    expect(adapterRegistry.get).toHaveBeenCalledWith('zhipu_partner');
    expect(adapter.createOrder).toHaveBeenCalledWith(PROVIDER_LINE, {
      partnerUserId: '325a534178fe4e5e91c811a3d375c4c2',
      partnerOrderNo: '9089cd6f6e804bef9d46ace21f1fbf5a',
      upstreamProductId: 'prod_001',
    });
    expect(prisma.codingPlanProviderEntitlement.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        providerAccountIdentityId: 'pai-zhipu-main',
        status: 'PENDING',
        fulfillmentAttemptId: expect.any(String),
        fulfillmentClaimedAt: expect.any(Date),
      }),
      select: { id: true },
    });
    expect(
      prisma.codingPlanProviderEntitlement.create.mock.invocationCallOrder[0],
    ).toBeLessThan(adapter.createOrder.mock.invocationCallOrder[0]);
    expect(prisma.codingPlanEntitlement.updateMany).toHaveBeenCalledWith({
      where: { id: 'entitlement-1' },
      data: {
        providerLineId: 'line-1',
        providerLineCode: 'zhipu_overseas_primary',
        providerCode: 'zhipu',
        adapterType: 'zhipu_partner',
        upstreamProductId: 'prod_001',
      },
    });
    const activationArg = prisma.codingPlanProviderEntitlement.updateMany.mock.calls[1][0];
    const serialized = JSON.stringify(activationArg);
    expect(activationArg).toMatchObject({
      where: {
        id: 'provider-entitlement-1',
        status: 'PENDING',
        fulfillmentAttemptId: expect.any(String),
      },
      data: {
        upstreamOrderId: 'zhipu-order-1',
        status: 'ACTIVE',
        upstreamApiKeyPrefix: 'sk-abcdefg',
        upstreamSecretKeyPrefix: 'secret-abc',
        fulfillmentAttemptId: null,
        fulfillmentClaimedAt: null,
      },
    });
    expect(serialized).not.toContain(upstreamApiKey);
    expect(serialized).not.toContain(upstreamSecret);
  });

  it('activates a multi-line resale route group with one shared upstream order', async () => {
    const openaiRoute = {
      ...ROUTE,
      id: 'route-openai',
      providerLineId: 'line-openai',
      providerLine: {
        ...ROUTE.providerLine,
        id: 'line-openai',
        code: 'zhipu_openai',
      },
    };
    const openaiLine = {
      ...PROVIDER_LINE,
      id: 'line-openai',
      code: 'zhipu_openai',
    };
    const { service, prisma, providerLines, adapter } = buildService({
      resaleRoutes: {
        resolveRoutes: jest.fn().mockResolvedValue([ROUTE, openaiRoute]),
      },
      providerLines: {
        getForFulfillment: jest.fn()
          .mockResolvedValueOnce(PROVIDER_LINE)
          .mockResolvedValueOnce(openaiLine),
      },
    });
    prisma.plan.findUnique.mockResolvedValue({
      id: 'plan-1',
      productId: 'product-1',
      product: {
        billingMode: ProductBillingMode.CODING_PLAN,
        codingPlanFulfillmentMode: CodingPlanFulfillmentMode.provider_resale,
      },
    });
    prisma.codingPlanProviderEntitlement.findUnique.mockResolvedValue(null);

    await expect(service.fulfillSubscriptionOrder({
      orderId: 'order-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'product-1',
      planId: 'plan-1',
      subscriptionId: 'entitlement-1',
    })).resolves.toBe('activated');

    expect(providerLines.getForFulfillment).toHaveBeenCalledTimes(2);
    expect(adapter.createOrder).toHaveBeenCalledTimes(1);
    expect(adapter.createOrder).toHaveBeenCalledWith(PROVIDER_LINE, expect.objectContaining({
      upstreamProductId: 'prod_001',
    }));
    const activationArg = prisma.codingPlanProviderEntitlement.updateMany.mock.calls[1][0];
    expect(activationArg.data.responseSnapshot._resale_route_bindings).toEqual([
      expect.objectContaining({
        routeId: 'route-1',
        role: 'primary',
        providerLineId: 'line-1',
        upstreamProductId: 'prod_001',
      }),
      expect.objectContaining({
        routeId: 'route-openai',
        role: 'runtime',
        providerLineId: 'line-openai',
        upstreamProductId: 'prod_001',
      }),
    ]);
  });

  it('rejects a multi-line resale group whose fresh provider lines use different accounts', async () => {
    const mismatchedLine = {
      ...PROVIDER_LINE,
      id: 'line-openai',
      code: 'zhipu_openai',
      providerAccountIdentityId: 'pai-zhipu-secondary',
    };
    const { service, prisma, adapter } = buildService({
      resaleRoutes: {
        resolveRoutes: jest.fn().mockResolvedValue([
          ROUTE,
          {
            ...ROUTE,
            id: 'route-openai',
            providerLineId: 'line-openai',
          },
        ]),
      },
      providerLines: {
        getForFulfillment: jest.fn()
          .mockResolvedValueOnce(PROVIDER_LINE)
          .mockResolvedValueOnce(mismatchedLine),
      },
    });
    prisma.plan.findUnique.mockResolvedValue({
      id: 'plan-1',
      productId: 'product-1',
      product: {
        billingMode: ProductBillingMode.CODING_PLAN,
        codingPlanFulfillmentMode: CodingPlanFulfillmentMode.provider_resale,
      },
    });
    prisma.codingPlanProviderEntitlement.findUnique.mockResolvedValue(null);

    await expect(service.fulfillSubscriptionOrder({
      orderId: 'order-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'product-1',
      planId: 'plan-1',
    })).rejects.toThrow('必须共享同一供应商账户身份');
    expect(adapter.createOrder).not.toHaveBeenCalled();
    expect(prisma.codingPlanProviderEntitlement.create).not.toHaveBeenCalled();
  });

  it('does not call upstream again for an active entitlement and attaches subscription id', async () => {
    const { service, prisma, providerLines, adapter } = buildService();
    prisma.plan.findUnique.mockResolvedValue({
      id: 'plan-1',
      productId: 'product-1',
      product: {
        billingMode: ProductBillingMode.CODING_PLAN,
        codingPlanFulfillmentMode: CodingPlanFulfillmentMode.provider_resale,
      },
    });
    prisma.codingPlanProviderEntitlement.findUnique.mockResolvedValue({
      status: 'ACTIVE',
      subscriptionId: null,
    });

    await expect(service.fulfillSubscriptionOrder({
      orderId: 'order-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'product-1',
      planId: 'plan-1',
      subscriptionId: 'sub-1',
    })).resolves.toBe('already_active');

    expect(providerLines.getForFulfillment).not.toHaveBeenCalled();
    expect(adapter.createOrder).not.toHaveBeenCalled();
    expect(prisma.codingPlanProviderEntitlement.update).toHaveBeenCalledWith({
      where: { orderId: 'order-1' },
      data: { subscriptionId: 'sub-1' },
    });
  });

  it('does not fulfill stale-feature plans unless the product mode is provider_resale', async () => {
    const { service, prisma, providerLines, adapter } = buildService({
      resaleRoutes: {
        resolveRoute: jest.fn().mockRejectedValue(new Error('should not resolve route')),
      },
    });
    prisma.plan.findUnique.mockResolvedValue({
      id: 'plan-1',
      productId: 'product-1',
      features: JSON.stringify(['stale_provider_resale_hint']),
      product: {
        billingMode: ProductBillingMode.CODING_PLAN,
        codingPlanFulfillmentMode: CodingPlanFulfillmentMode.platform_model_package,
      },
    });

    await expect(service.fulfillSubscriptionOrder({
      orderId: 'order-legacy',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'product-1',
      planId: 'plan-1',
    })).resolves.toBe('skipped');

    expect(providerLines.getForFulfillment).not.toHaveBeenCalled();
    expect(adapter.createOrder).not.toHaveBeenCalled();
    expect(prisma.codingPlanProviderEntitlement.create).not.toHaveBeenCalled();
  });

  it('fails provider_resale fulfillment when no route is configured', async () => {
    const routeError = new Error('当前套餐没有可用供应商转售线路');
    const { service, prisma, providerLines, adapter } = buildService({
      resaleRoutes: { resolveRoutes: jest.fn().mockRejectedValue(routeError) },
    });
    prisma.plan.findUnique.mockResolvedValue({
      id: 'plan-1',
      productId: 'product-1',
      features: '[]',
      product: {
        billingMode: ProductBillingMode.CODING_PLAN,
        codingPlanFulfillmentMode: CodingPlanFulfillmentMode.provider_resale,
      },
    });

    await expect(service.fulfillSubscriptionOrder({
      orderId: 'order-missing-route',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'product-1',
      planId: 'plan-1',
    })).rejects.toThrow('当前套餐没有可用供应商转售线路');

    expect(providerLines.getForFulfillment).not.toHaveBeenCalled();
    expect(adapter.createOrder).not.toHaveBeenCalled();
    expect(prisma.codingPlanProviderEntitlement.create).not.toHaveBeenCalled();
  });

  it('fails before calling upstream when the provider line identity is not ready', async () => {
    const { service, prisma, providerLines, adapter } = buildService({
      providerLines: {
        getForFulfillment: jest.fn().mockRejectedValue(
          new Error('供应商线路 zhipu_overseas_primary 未配置供应商账户身份'),
        ),
      },
    });
    prisma.plan.findUnique.mockResolvedValue({
      id: 'plan-1',
      productId: 'product-1',
      product: {
        billingMode: ProductBillingMode.CODING_PLAN,
        codingPlanFulfillmentMode: CodingPlanFulfillmentMode.provider_resale,
      },
    });
    prisma.codingPlanProviderEntitlement.findUnique.mockResolvedValue(null);

    await expect(service.fulfillSubscriptionOrder({
      orderId: 'order-identity-missing',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'product-1',
      planId: 'plan-1',
    })).rejects.toThrow('未配置供应商账户身份');

    expect(providerLines.getForFulfillment).toHaveBeenCalledWith('line-1');
    expect(adapter.createOrder).not.toHaveBeenCalled();
    expect(prisma.codingPlanProviderEntitlement.create).not.toHaveBeenCalled();
  });

  it('persists the identity-bound reservation before any upstream order is created', async () => {
    const { service, prisma, adapter } = buildService();
    prisma.plan.findUnique.mockResolvedValue({
      id: 'plan-1',
      productId: 'product-1',
      product: {
        billingMode: ProductBillingMode.CODING_PLAN,
        codingPlanFulfillmentMode: CodingPlanFulfillmentMode.provider_resale,
      },
    });
    prisma.codingPlanProviderEntitlement.findUnique.mockResolvedValue(null);
    prisma.codingPlanProviderEntitlement.create.mockRejectedValueOnce(
      new Error('provider_account_identity_provider_line_identity_mismatch'),
    );

    await expect(service.fulfillSubscriptionOrder({
      orderId: 'order-reservation-rejected',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'product-1',
      planId: 'plan-1',
    })).rejects.toThrow('供应商线路账户身份在履约准备期间发生变化');

    expect(prisma.codingPlanProviderEntitlement.create).toHaveBeenCalledTimes(1);
    expect(adapter.createOrder).not.toHaveBeenCalled();
  });

  it('does not rewrite the customer route or call upstream when another fresh attempt owns the claim', async () => {
    const { service, prisma, adapter } = buildService();
    const now = new Date();
    prisma.plan.findUnique.mockResolvedValue({
      id: 'plan-1',
      productId: 'product-1',
      product: {
        billingMode: ProductBillingMode.CODING_PLAN,
        codingPlanFulfillmentMode: CodingPlanFulfillmentMode.provider_resale,
      },
    });
    prisma.codingPlanProviderEntitlement.findUnique
      .mockResolvedValueOnce({ status: 'PENDING', subscriptionId: 'entitlement-1' })
      .mockResolvedValueOnce({
        id: 'provider-entitlement-1',
        status: 'PENDING',
        fulfillmentAttemptId: 'attempt-winner',
        fulfillmentClaimedAt: now,
        createdAt: now,
        updatedAt: now,
      });

    await expect(service.fulfillSubscriptionOrder({
      orderId: 'order-claim-loser',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'product-1',
      planId: 'plan-1',
      subscriptionId: 'entitlement-1',
    })).rejects.toThrow('供应商履约正在进行');

    expect(prisma.codingPlanEntitlement.updateMany).not.toHaveBeenCalled();
    expect(adapter.createOrder).not.toHaveBeenCalled();
  });

  it('does not let an old upstream response overwrite a newer ACTIVE attempt', async () => {
    const { service, prisma } = buildService();
    prisma.plan.findUnique.mockResolvedValue({
      id: 'plan-1',
      productId: 'product-1',
      product: {
        billingMode: ProductBillingMode.CODING_PLAN,
        codingPlanFulfillmentMode: CodingPlanFulfillmentMode.provider_resale,
      },
    });
    prisma.codingPlanProviderEntitlement.findUnique
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce(null)
      .mockResolvedValueOnce({ status: 'ACTIVE' });
    prisma.codingPlanProviderEntitlement.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await expect(service.fulfillSubscriptionOrder({
      orderId: 'order-old-attempt',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'product-1',
      planId: 'plan-1',
      subscriptionId: 'entitlement-1',
    })).resolves.toBe('already_active');

    expect(prisma.codingPlanProviderEntitlement.updateMany).toHaveBeenCalledTimes(2);
    const attemptId = prisma.codingPlanProviderEntitlement.create.mock.calls[0][0]
      .data.fulfillmentAttemptId;
    expect(prisma.codingPlanProviderEntitlement.updateMany).toHaveBeenNthCalledWith(2, {
      where: {
        id: 'provider-entitlement-1',
        status: 'PENDING',
        fulfillmentAttemptId: attemptId,
      },
      data: expect.objectContaining({
        status: 'ACTIVE',
        fulfillmentAttemptId: null,
      }),
    });
  });

  it('records an upstream failure only for the attempt that owns the claim', async () => {
    const upstreamError = new Error('provider timeout');
    const { service, prisma } = buildService({
      adapter: { createOrder: jest.fn().mockRejectedValue(upstreamError) },
    });
    prisma.plan.findUnique.mockResolvedValue({
      id: 'plan-1',
      productId: 'product-1',
      product: {
        billingMode: ProductBillingMode.CODING_PLAN,
        codingPlanFulfillmentMode: CodingPlanFulfillmentMode.provider_resale,
      },
    });
    prisma.codingPlanProviderEntitlement.findUnique.mockResolvedValue(null);

    await expect(service.fulfillSubscriptionOrder({
      orderId: 'order-provider-timeout',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'product-1',
      planId: 'plan-1',
      subscriptionId: 'entitlement-1',
    })).rejects.toBe(upstreamError);

    const attemptId = prisma.codingPlanProviderEntitlement.create.mock.calls[0][0]
      .data.fulfillmentAttemptId;
    expect(prisma.codingPlanProviderEntitlement.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'provider-entitlement-1',
        status: 'PENDING',
        fulfillmentAttemptId: attemptId,
      },
      data: {
        status: 'FAILED',
        fulfillmentAttemptId: null,
        fulfillmentClaimedAt: null,
        lastError: 'provider timeout',
      },
    });
  });
});
