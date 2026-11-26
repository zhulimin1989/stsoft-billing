import { ProductPortalCatalogService } from './product-portal-catalog.service';

describe('ProductPortalCatalogService', () => {
  function buildService() {
    const billingService = {
      getPlans: jest.fn().mockResolvedValue([]),
      getActiveBundles: jest.fn().mockResolvedValue([]),
    };
    const productService = {
      findById: jest.fn().mockResolvedValue({
        id: 'product-1',
        slug: 'product-one',
        isActive: true,
        webhookUrl: 'https://internal.example/webhook',
        integrationTokenPrefix: 'rpi_secret',
      }),
      findBySlug: jest.fn().mockResolvedValue({
        id: 'product-1',
        slug: 'product-one',
        isActive: true,
        webhookUrl: 'https://internal.example/webhook',
        integrationTokenPrefix: 'rpi_secret',
      }),
    };
    const boosterPackService = {
      findAll: jest.fn().mockResolvedValue([]),
    };
    const prisma = {
      productChannel: { findMany: jest.fn().mockResolvedValue([]) },
      productModelAvailability: { findMany: jest.fn().mockResolvedValue([]) },
      modelPricing: { findMany: jest.fn().mockResolvedValue([]) },
      plan: { findMany: jest.fn().mockResolvedValue([]) },
      modelAccess: { findMany: jest.fn().mockResolvedValue([]) },
      modelRoutePolicy: { findMany: jest.fn().mockResolvedValue([]) },
      planPrice: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const systemConfig = {
      getDeploymentConfig: jest.fn().mockResolvedValue({
        region: 'overseas',
        currency: 'usd',
      }),
    };
    const service = new ProductPortalCatalogService(
      billingService as never,
      productService as never,
      boosterPackService as never,
      prisma as never,
      systemConfig as never,
    );
    return {
      service,
      billingService,
      productService,
      boosterPackService,
      prisma,
      systemConfig,
    };
  }

  it('returns only the resolved product from the catalog products endpoint', async () => {
    const { service, productService } = buildService();

    const product = await service.resolveProduct({ productSlug: 'product-one' });

    expect(productService.findBySlug).toHaveBeenCalledWith('product-one');
    const products = service.getProducts(product) as Array<Record<string, unknown>>;
    expect(products).toEqual([
      expect.objectContaining({
        id: 'product-1',
        slug: 'product-one',
        isActive: true,
      }),
    ]);
    expect(products[0]).not.toHaveProperty('webhookUrl');
    expect(products[0]).not.toHaveProperty('integrationTokenPrefix');
  });

  it('uses the active platform-currency PlanPrice values exposed by checkout', async () => {
    const { service, billingService, prisma, systemConfig } = buildService();
    systemConfig.getDeploymentConfig.mockResolvedValue({
      region: 'domestic',
      currency: 'cny',
    });
    billingService.getPlans.mockResolvedValue([
      {
        id: 'plan-priced',
        productId: 'product-1',
        monthlyPrice: 9900,
        quarterlyPrice: 8900,
        yearlyPrice: 7900,
      },
      {
        id: 'plan-legacy',
        productId: 'product-1',
        monthlyPrice: 1900,
        quarterlyPrice: 1800,
        yearlyPrice: 1700,
      },
    ]);
    prisma.planPrice.findMany.mockResolvedValue([{
      planId: 'plan-priced',
      monthlyPrice: 6900,
      quarterlyPrice: 5900,
      yearlyPrice: 4900,
    }]);

    const result = await service.getPlans({
      id: 'product-1',
      slug: 'product-one',
      record: {},
    }) as Array<Record<string, unknown>>;

    expect(prisma.planPrice.findMany).toHaveBeenCalledWith({
      where: {
        planId: { in: ['plan-priced', 'plan-legacy'] },
        currency: 'cny',
        isActive: true,
      },
      select: {
        planId: true,
        monthlyPrice: true,
        quarterlyPrice: true,
        yearlyPrice: true,
      },
    });
    expect(result).toEqual([
      expect.objectContaining({
        id: 'plan-priced',
        currency: 'cny',
        monthlyPrice: 6900,
        quarterlyPrice: 5900,
        yearlyPrice: 4900,
      }),
      expect.objectContaining({
        id: 'plan-legacy',
        currency: 'cny',
        monthlyPrice: 1900,
        quarterlyPrice: 1800,
        yearlyPrice: 1700,
      }),
    ]);
  });

  it('returns only the published Partner catalog surface', async () => {
    const { service, billingService, boosterPackService } = buildService();
    billingService.getPlans.mockResolvedValue([{ id: 'plan-1' }]);
    boosterPackService.findAll.mockResolvedValue([{ id: 'booster-1' }]);

    const result = await service.getCatalog({
      id: 'product-1',
      slug: 'product-one',
      record: { id: 'product-1' },
    }) as Record<string, unknown>;

    expect(result.products).toEqual([{ id: 'product-1' }]);
    expect(result.plans).toEqual([expect.objectContaining({ id: 'plan-1' })]);
    expect(result.boosterPacks).toEqual([
      expect.objectContaining({ id: 'booster-1' }),
    ]);
    expect(result).toHaveProperty('models');
    expect(result).toHaveProperty('modelAccess');
    expect(result).toHaveProperty('modelRoutePolicies');
    expect(result).toHaveProperty('channels');
    expect(result).not.toHaveProperty('bundles');
    expect(result).not.toHaveProperty('modelPricing');
    expect(billingService.getActiveBundles).not.toHaveBeenCalled();
  });

  it('exposes product-scoped model access through the catalog', async () => {
    const { service, prisma } = buildService();
    prisma.productChannel.findMany.mockResolvedValue([
      {
        id: 'pc-1',
        displayName: null,
        isDefault: true,
        allowedModels: [],
        deniedModels: [],
        channel: {
          provider: 'provider-a',
          models: JSON.stringify(['glm-5', 'kimi-k2']),
          modelConfigs: null,
          sdkType: 'openai_compat',
        },
      },
    ]);
    prisma.modelPricing.findMany.mockResolvedValue([
      {
        modelName: 'glm-5',
        provider: 'provider-a',
        priceTiers: [],
      },
      {
        modelName: 'kimi-k2',
        provider: 'provider-a',
        priceTiers: [],
      },
    ]);
    prisma.plan.findMany.mockResolvedValue([{ id: 'free' }, { id: 'pro' }]);
    prisma.modelAccess.findMany.mockResolvedValue([
      { planId: 'free', modelName: 'glm-5', isActive: true, creditMultiplier: 1 },
      { planId: 'pro', modelName: 'kimi-k2', isActive: true, creditMultiplier: 1.5 },
    ]);

    const data = await service.getModelAccess({
      id: 'product-1',
      slug: 'product-one',
      record: {},
    });

    expect(prisma.plan.findMany).toHaveBeenCalledWith({
      where: { productId: 'product-1', isActive: true, deletedAt: null },
      select: { id: true },
    });
    expect(prisma.modelAccess.findMany).toHaveBeenCalledWith({
      where: {
        planId: { in: ['free', 'pro'] },
        modelName: { in: ['glm-5', 'kimi-k2'] },
        isActive: true,
      },
    });
    expect(data).toEqual({
      items: [
        { planId: 'free', modelName: 'glm-5', isActive: true, creditMultiplier: 1 },
        { planId: 'pro', modelName: 'kimi-k2', isActive: true, creditMultiplier: 1.5 },
      ],
    });
  });

  it('uses the published model display name on the product-scoped surface', async () => {
    const { service, prisma } = buildService();
    prisma.productChannel.findMany.mockResolvedValue([
      {
        id: 'pc-1',
        displayName: null,
        isDefault: true,
        allowedModels: ['glm-5'],
        deniedModels: [],
        channel: {
          provider: 'openai_compat',
          models: JSON.stringify(['glm-5']),
          modelConfigs: null,
          sdkType: 'openai_compat',
        },
      },
    ]);
    prisma.modelPricing.findMany.mockResolvedValue([
      {
        modelName: 'glm-5',
        modelId: 'GLM 5 用户版',
        provider: 'zhipu',
        modelType: 'chat',
      },
    ]);

    const data = await service.getModels({
      id: 'product-1',
      slug: 'product-one',
      record: { billingMode: 'SUBSCRIPTION' },
    });

    expect(data).toEqual({
      models: [{
        id: 'glm-5',
        displayName: 'GLM 5 用户版',
        provider: 'zhipu',
        modelType: 'chat',
      }],
    });
    expect(prisma.modelPricing.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        select: expect.objectContaining({ modelId: true }),
      }),
    );
  });

  it('removes hidden models from access and route-policy catalog surfaces', async () => {
    const { service, prisma } = buildService();
    prisma.productChannel.findMany.mockResolvedValue([
      {
        id: 'pc-1',
        displayName: null,
        isDefault: true,
        allowedModels: ['visible-model'],
        deniedModels: [],
        channel: {
          provider: 'provider-a',
          models: JSON.stringify(['visible-model', 'hidden-model']),
          modelConfigs: null,
          sdkType: 'openai_compat',
        },
      },
    ]);
    prisma.modelPricing.findMany.mockResolvedValue([
      {
        modelName: 'visible-model',
        provider: 'provider-a',
        priceTiers: [],
      },
      {
        modelName: 'hidden-model',
        provider: 'provider-a',
        priceTiers: [],
      },
    ]);
    prisma.plan.findMany.mockResolvedValue([{ id: 'plan-1' }]);
    prisma.modelAccess.findMany.mockResolvedValue([
      {
        planId: 'plan-1',
        modelName: 'visible-model',
        isActive: true,
        creditMultiplier: 1,
      },
    ]);
    prisma.modelRoutePolicy.findMany.mockResolvedValue([
      {
        planId: 'plan-1',
        routeKey: 'chat',
        primaryModel: 'visible-model',
        fallbackModels: JSON.stringify(['hidden-model', 'visible-model']),
        isActive: true,
      },
    ]);

    const product = {
      id: 'product-1',
      slug: 'product-one',
      record: { billingMode: 'SUBSCRIPTION' },
    };
    const [access, routePolicies] = await Promise.all([
      service.getModelAccess(product),
      service.getModelRoutePolicies(product),
    ]) as [
      { items: Array<{ modelName: string }> },
      { items: Array<{ primaryModel: string; fallbackModels: string[] }> },
    ];

    expect(prisma.modelAccess.findMany).toHaveBeenCalledWith({
      where: {
        planId: { in: ['plan-1'] },
        modelName: { in: ['visible-model'] },
        isActive: true,
      },
    });
    expect(prisma.modelRoutePolicy.findMany).toHaveBeenCalledWith({
      where: {
        planId: { in: ['plan-1'] },
        primaryModel: { in: ['visible-model'] },
        isActive: true,
      },
    });
    expect(access.items.map((item) => item.modelName)).toEqual(['visible-model']);
    expect(routePolicies.items).toEqual([
      {
        planId: 'plan-1',
        routeKey: 'chat',
        primaryModel: 'visible-model',
        fallbackModels: ['visible-model'],
        isActive: true,
      },
    ]);
  });

  it('does not expose internal sales inventory or deleted-row metadata', async () => {
    const { service, billingService, boosterPackService } = buildService();
    billingService.getPlans.mockResolvedValue([{
      id: 'plan-1',
      name: 'Pro',
      soldOut: false,
      salesLimit: 100,
      reservedSalesCount: 75,
      remainingSales: 25,
    }]);
    boosterPackService.findAll.mockResolvedValue([{
      id: 'booster-1',
      productId: 'product-1',
      name: 'Credits',
      description: '',
      creditsAmount: 1000,
      priceCents: 500,
      expiryDays: 30,
      isActive: true,
      sortOrder: 1,
      deletedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      product: { name: 'Internal product', slug: 'internal-product' },
    }]);
    const product = {
      id: 'product-1',
      slug: 'product-one',
      record: { billingMode: 'SUBSCRIPTION' },
    };

    const [plans, packs] = await Promise.all([
      service.getPlans(product) as Promise<Array<Record<string, unknown>>>,
      service.getBoosterPacks(product) as Promise<Array<Record<string, unknown>>>,
    ]);

    expect(plans[0]).toEqual(expect.objectContaining({
      id: 'plan-1',
      soldOut: false,
    }));
    expect(plans[0]).not.toHaveProperty('salesLimit');
    expect(plans[0]).not.toHaveProperty('reservedSalesCount');
    expect(plans[0]).not.toHaveProperty('remainingSales');
    expect(packs[0]).not.toHaveProperty('deletedAt');
    expect(packs[0]).not.toHaveProperty('createdAt');
    expect(packs[0]).not.toHaveProperty('product');
  });

  it('loads channels only through active bindings for the token product', async () => {
    const { service, prisma } = buildService();
    prisma.productChannel.findMany.mockResolvedValue([
      {
        id: 'pc-1',
        displayName: '智谱服务',
        isDefault: true,
        allowedModels: ['glm-5.1'],
        deniedModels: [],
        channel: {
          provider: 'zhipu',
          apiKey: 'sk-provider-secret',
          baseUrl: 'https://internal-provider.example',
          models: JSON.stringify(['glm-5.1', 'internal-model']),
          modelConfigs: JSON.stringify({
            'glm-5.1': { upstreamModelId: 'secret-upstream', routingPriority: 1 },
          }),
          sdkType: 'openai_compat',
        },
      },
    ]);
    prisma.modelPricing.findMany.mockResolvedValue([
      {
        modelName: 'glm-5.1',
        provider: 'zhipu',
        modelType: 'chat',
        pricingUnit: 'token_1m',
        unitPriceUsd: null,
        inputPricePerMToken: 1,
        outputPricePerMToken: 2,
        cachedInputPrice: null,
        priceTiers: [],
        contextLength: 262144,
        maxOutputTokens: 256000,
        defaultThinkingMode: null,
        defaultThinkingBudget: null,
      },
    ]);

    const product = {
      id: 'product-1',
      slug: 'product-one',
      record: { billingMode: 'SUBSCRIPTION' },
    };
    const data = await service.getChannels(product) as {
      items: Array<{
        id: string;
        name: string;
        runtime: string;
        models: Record<string, Record<string, unknown>>;
      }>;
    };

    expect(prisma.productChannel.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          productId: 'product-1',
          status: 'active',
          deletedAt: null,
        }),
      }),
    );
    const item = data.items[0];
    expect(item).toEqual(expect.objectContaining({
      id: 'pc-1',
      name: '智谱服务',
      runtime: 'gateway',
    }));
    expect(item.models['glm-5.1']).toEqual(
      expect.objectContaining({
        context_window: 262144,
        max_output_tokens: 256000,
      }),
    );
    expect(item).not.toHaveProperty('baseUrl');
    expect(item).not.toHaveProperty('apiKey');
    expect(item).not.toHaveProperty('modelsRaw');
    expect(item).not.toHaveProperty('modelConfigs');
    expect(item.models['glm-5.1']).not.toHaveProperty('provider_model_name');
    expect(item.models['glm-5.1']).not.toHaveProperty('routing_priority');
  });

  it('intersects PAYG model visibility with active product availability', async () => {
    const { service, prisma } = buildService();
    prisma.productChannel.findMany.mockResolvedValue([
      {
        id: 'pc-1',
        displayName: null,
        isDefault: true,
        allowedModels: [],
        deniedModels: [],
        channel: {
          provider: 'provider-a',
          models: JSON.stringify(['enabled-model', 'hidden-model']),
          modelConfigs: null,
          sdkType: 'openai_compat',
        },
      },
    ]);
    prisma.modelPricing.findMany.mockResolvedValue([
      {
        modelName: 'enabled-model',
        provider: 'provider-a',
        modelType: 'chat',
        pricingUnit: 'token_1m',
        unitPriceUsd: null,
        inputPricePerMToken: 1,
        outputPricePerMToken: 2,
        cachedInputPrice: null,
        contextLength: null,
        maxOutputTokens: null,
        defaultThinkingMode: null,
        defaultThinkingBudget: null,
        priceTiers: [],
      },
      {
        modelName: 'hidden-model',
        provider: 'provider-a',
        modelType: 'chat',
        pricingUnit: 'token_1m',
        unitPriceUsd: null,
        inputPricePerMToken: 1,
        outputPricePerMToken: 2,
        cachedInputPrice: null,
        contextLength: null,
        maxOutputTokens: null,
        defaultThinkingMode: null,
        defaultThinkingBudget: null,
        priceTiers: [],
      },
    ]);
    prisma.productModelAvailability.findMany.mockResolvedValue([
      { modelName: 'enabled-model' },
    ]);

    const data = await service.getModels({
      id: 'product-1',
      slug: 'product-one',
      record: { billingMode: 'PAY_AS_YOU_GO' },
    });

    expect(data.models.map((model) => model.id)).toEqual(['enabled-model']);
    expect(prisma.modelPricing.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: {
          modelName: { in: ['enabled-model', 'hidden-model'] },
          isActive: true,
          isPublished: true,
        },
        select: {
          modelName: true,
          modelId: true,
          provider: true,
          modelType: true,
          contextLength: true,
          maxOutputTokens: true,
          defaultThinkingMode: true,
          defaultThinkingBudget: true,
        },
      }),
    );
    expect(prisma.productModelAvailability.findMany).toHaveBeenCalledWith(
      expect.objectContaining({
        where: expect.objectContaining({
          productId: 'product-1',
          status: 'ACTIVE',
          apiEnabled: true,
          visible: true,
        }),
      }),
    );
  });
});
