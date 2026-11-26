import { Test } from '@nestjs/testing';
import { BadRequestException, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { ProductService } from './product.service';
import { PrismaService } from '../prisma/prisma.service';

function makeProduct(overrides: Partial<{
  id: string;
  name: string;
  slug: string;
  description: string | null;
  icon: string | null;
  webhookUrl: string | null;
  allowedPaymentCallbackOrigins: string[] | null;
  defaultPlanId: string | null;
  billingMode: 'SUBSCRIPTION' | 'PAY_AS_YOU_GO' | 'CODING_PLAN';
  codingPlanFulfillmentMode: 'platform_model_package' | 'provider_resale' | null;
  isActive: boolean;
  sortOrder: number;
  createdAt: Date;
  updatedAt: Date;
}> = {}) {
  return {
    id: 'prod-1',
    name: 'RDClaw',
    slug: 'rdclaw',
    description: 'AI Agent',
    icon: null,
    webhookUrl: null,
    allowedPaymentCallbackOrigins: null,
    defaultPlanId: null,
    billingMode: 'SUBSCRIPTION',
    codingPlanFulfillmentMode: null,
    isActive: true,
    sortOrder: 1,
    createdAt: new Date('2025-01-01'),
    updatedAt: new Date('2025-01-01'),
    ...overrides,
  };
}

function makePrisma() {
  return {
    product: {
      findMany: jest.fn(),
      findFirst: jest.fn(),
      findUnique: jest.fn(),
      create: jest.fn(),
      update: jest.fn(),
      delete: jest.fn(),
    },
    plan: {
      count: jest.fn().mockResolvedValue(0),
      findFirst: jest.fn().mockResolvedValue(null),
    },
    boosterPack: { count: jest.fn().mockResolvedValue(0) },
    userSubscription: { count: jest.fn().mockResolvedValue(0) },
    campaign: { count: jest.fn().mockResolvedValue(0) },
    rechargeTier: { count: jest.fn().mockResolvedValue(0) },
    creditPolicy: { count: jest.fn().mockResolvedValue(0) },
    creditGrantRule: { count: jest.fn().mockResolvedValue(0) },
    referralProgram: { count: jest.fn().mockResolvedValue(0) },
    order: { count: jest.fn().mockResolvedValue(0) },
    balanceTransaction: { count: jest.fn().mockResolvedValue(0) },
    creditTransaction: { count: jest.fn().mockResolvedValue(0) },
    apiKey: { count: jest.fn().mockResolvedValue(0) },
    tokenUsage: { count: jest.fn().mockResolvedValue(0) },
    productRuntimePolicy: {
      upsert: jest.fn(),
      updateMany: jest.fn().mockResolvedValue({ count: 0 }),
    },
    channel: {
      findMany: jest.fn().mockResolvedValue([]),
    },
  };
}

function makeRuntimePolicy(overrides: Partial<{
  id: string;
  productId: string;
  credentialSource: string;
  allowedProviderIds: unknown;
  allowedChannelIds: unknown;
  modelScopeMode: string;
  allowedModels: unknown;
  fallbackPolicy: string;
  runtimeBillingMode: string;
  routeStrategy: string | null;
  protocolStrategy: string;
  allowHighLossBridgeWhenNoNative: boolean;
  allowBridgeOnNativeFailure: boolean;
  highLossBridgeReason: string | null;
  highLossBridgeOwner: string | null;
  highLossBridgeExpiresAt: Date | null;
  highLossBridgeApproval: string | null;
  status: string;
  revision: number;
  createdAt: Date;
  updatedAt: Date;
}> = {}) {
  return {
    id: 'policy-1',
    productId: 'prod-1',
    credentialSource: 'keypool',
    allowedProviderIds: [],
    allowedChannelIds: [],
    modelScopeMode: 'plan_configured',
    allowedModels: [],
    fallbackPolicy: 'within_product',
    runtimeBillingMode: 'subscription_credits',
    routeStrategy: null,
    protocolStrategy: 'auto',
    allowHighLossBridgeWhenNoNative: false,
    allowBridgeOnNativeFailure: false,
    highLossBridgeReason: null,
    highLossBridgeOwner: null,
    highLossBridgeExpiresAt: null,
    highLossBridgeApproval: null,
    status: 'active',
    revision: 1,
    createdAt: new Date('2026-01-01T00:00:00.000Z'),
    updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    ...overrides,
  };
}

async function buildService(
  prismaOverrides = {},
  configValues: Record<string, string | undefined> = {},
) {
  const prisma = { ...makePrisma(), ...prismaOverrides };
  const config = {
    get: jest.fn((key: string) => configValues[key]),
  };
  const m = await Test.createTestingModule({
    providers: [
      ProductService,
      { provide: PrismaService, useValue: prisma },
      { provide: ConfigService, useValue: config },
    ],
  }).compile();
  return { service: m.get(ProductService) as ProductService, prisma, config };
}

// ============================================================
// ProductService.findAll
// ============================================================
describe('ProductService.findAll', () => {
  it('returns all products when onlyActive=false (default)', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findMany.mockResolvedValue([makeProduct(), makeProduct({ id: 'prod-2', slug: 'chat' })]);

    const result = await service.findAll();

    expect(result).toHaveLength(2);
    expect(prisma.product.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null },
      orderBy: { sortOrder: 'asc' },
    });
  });

  it('filters by isActive=true when onlyActive=true', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findMany.mockResolvedValue([makeProduct()]);

    await service.findAll(true);

    expect(prisma.product.findMany).toHaveBeenCalledWith({
      where: { deletedAt: null, isActive: true },
      orderBy: { sortOrder: 'asc' },
    });
  });

  it('returns empty array when no products exist', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findMany.mockResolvedValue([]);

    const result = await service.findAll();
    expect(result).toEqual([]);
  });

  it('orders by sortOrder asc in both cases', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findMany.mockResolvedValue([]);

    await service.findAll(false);
    expect(prisma.product.findMany).toHaveBeenCalledWith(
      expect.objectContaining({ orderBy: { sortOrder: 'asc' } }),
    );
  });
});

// ============================================================
// ProductService.getIntegrationStatus
// ============================================================
describe('ProductService.getIntegrationStatus', () => {
  it('counts only ACTIVE mirrored default virtual keys as active', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findFirst.mockResolvedValue(makeProduct({
      id: 'prod-1',
      slug: 'rdclaw',
      billingMode: 'SUBSCRIPTION',
      defaultPlanId: null,
    }));
    prisma.plan.findFirst.mockResolvedValue({
      id: 'free',
      name: 'Free',
      isActive: true,
      monthlyPrice: 0,
      monthlyCredits: 100,
    });
    prisma.plan.count.mockResolvedValue(1);
    prisma.apiKey.count
      .mockResolvedValueOnce(1)
      .mockResolvedValueOnce(2);

    const result = await service.getIntegrationStatus('prod-1');

    expect(result.virtualKey).toEqual({
      name: 'saas:rdclaw:virtual',
      activeCount: 1,
      totalCount: 2,
    });
    expect(result.checklist.hasActiveVirtualKey).toBe(true);
    expect(prisma.apiKey.count).toHaveBeenNthCalledWith(1, {
      where: {
        productId: 'prod-1',
        name: 'saas:rdclaw:virtual',
        isActive: true,
        mirrorStatus: 'ACTIVE',
        deletedAt: null,
      },
    });
    expect(prisma.apiKey.count).toHaveBeenNthCalledWith(2, {
      where: {
        productId: 'prod-1',
        name: 'saas:rdclaw:virtual',
        deletedAt: null,
      },
    });
  });

  it('uses the global callback origins only for a null product setting', async () => {
    const { service, prisma } = await buildService({}, {
      PAYMENT_CALLBACK_ALLOWED_ORIGINS: 'https://global.example.com,https://checkout.example.com',
      CORS_ORIGINS: '',
      STRIPE_SUCCESS_URL: '',
      STRIPE_CANCEL_URL: '',
      ALIPAY_RETURN_URL: '',
    });
    prisma.product.findFirst.mockResolvedValue(makeProduct({
      allowedPaymentCallbackOrigins: null,
    }));

    const result = await service.getIntegrationStatus('prod-1');

    expect(result.paymentCallbacks).toEqual({
      mode: 'GLOBAL_FALLBACK',
      configuredOrigins: null,
      effectiveOrigins: ['https://global.example.com', 'https://checkout.example.com'],
    });
    expect(result.checklist.hasPaymentCallbackOrigins).toBe(false);
  });

  it('reports an empty product setting as deny all', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findFirst.mockResolvedValue(makeProduct({
      allowedPaymentCallbackOrigins: [],
    }));

    const result = await service.getIntegrationStatus('prod-1');

    expect(result.paymentCallbacks).toEqual({
      mode: 'DENY_ALL',
      configuredOrigins: [],
      effectiveOrigins: [],
    });
    expect(result.checklist.hasPaymentCallbackOrigins).toBe(false);
  });

  it('reports a non-empty product allowlist without merging global origins', async () => {
    const { service, prisma } = await buildService({}, {
      PAYMENT_CALLBACK_ALLOWED_ORIGINS: 'https://global.example.com',
    });
    prisma.product.findFirst.mockResolvedValue(makeProduct({
      allowedPaymentCallbackOrigins: ['https://product.example.com'],
    }));

    const result = await service.getIntegrationStatus('prod-1');

    expect(result.paymentCallbacks).toEqual({
      mode: 'PRODUCT_ALLOWLIST',
      configuredOrigins: ['https://product.example.com'],
      effectiveOrigins: ['https://product.example.com'],
    });
    expect(result.checklist.hasPaymentCallbackOrigins).toBe(true);
  });
});

// ============================================================
// ProductService.resolveDefaultProduct
// ============================================================
describe('ProductService.resolveDefaultProduct', () => {
  it('uses an explicitly configured PAYG product id', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findFirst.mockResolvedValue(makeProduct({
      id: 'prod-payg',
      slug: 'payg',
      billingMode: 'PAY_AS_YOU_GO',
    }));

    const result = await service.resolveDefaultProduct({
      billingMode: 'PAY_AS_YOU_GO',
      productId: 'prod-payg',
    });

    expect(result?.id).toBe('prod-payg');
    expect(prisma.product.findFirst).toHaveBeenCalledWith({
      where: {
        id: 'prod-payg',
        billingMode: 'PAY_AS_YOU_GO',
        isActive: true,
        deletedAt: null,
      },
    });
  });

  it('selects the only active product for a billing mode', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findMany.mockResolvedValue([
      makeProduct({ id: 'prod-payg', slug: 'payg', billingMode: 'PAY_AS_YOU_GO' }),
    ]);

    const result = await service.resolveDefaultProduct({ billingMode: 'PAY_AS_YOU_GO' });

    expect(result?.id).toBe('prod-payg');
    expect(prisma.product.findMany).toHaveBeenCalledWith({
      where: {
        billingMode: 'PAY_AS_YOU_GO',
        isActive: true,
        deletedAt: null,
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  });

  it('rejects ambiguous active products for a billing mode', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findMany.mockResolvedValue([
      makeProduct({ id: 'prod-1', billingMode: 'PAY_AS_YOU_GO' }),
      makeProduct({ id: 'prod-2', billingMode: 'PAY_AS_YOU_GO' }),
    ]);

    await expect(service.resolveDefaultProduct({ billingMode: 'PAY_AS_YOU_GO' }))
      .rejects.toThrow('存在多个启用的 PAY_AS_YOU_GO 产品');
  });

  it('filters CODING_PLAN products by fulfillment mode', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findMany.mockResolvedValue([
      makeProduct({
        id: 'prod-resale',
        slug: 'tokenplan-resale',
        billingMode: 'CODING_PLAN',
        codingPlanFulfillmentMode: 'provider_resale',
      }),
    ]);

    const result = await service.resolveDefaultProduct({
      billingMode: 'CODING_PLAN',
      codingPlanFulfillmentMode: 'provider_resale',
    });

    expect(result?.id).toBe('prod-resale');
    expect(prisma.product.findMany).toHaveBeenCalledWith({
      where: {
        billingMode: 'CODING_PLAN',
        codingPlanFulfillmentMode: 'provider_resale',
        isActive: true,
        deletedAt: null,
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
  });
});

// ============================================================
// ProductService.findById
// ============================================================
describe('ProductService.findById', () => {
  it('returns product when found', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findFirst.mockResolvedValue(makeProduct({ id: 'prod-1' }));

    const result = await service.findById('prod-1');

    expect(result).not.toBeNull();
    expect(result?.id).toBe('prod-1');
    expect(prisma.product.findFirst).toHaveBeenCalledWith({ where: { id: 'prod-1', deletedAt: null } });
  });

  it('returns null when product not found', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findFirst.mockResolvedValue(null);

    const result = await service.findById('no-such-id');
    expect(result).toBeNull();
  });

  it('fails closed when a product contains malformed callback origin JSON', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findFirst.mockResolvedValue(makeProduct({
      allowedPaymentCallbackOrigins: { origin: 'https://invalid.example.com' } as any,
    }));

    const result = await service.findById('prod-1');

    expect(result?.allowedPaymentCallbackOrigins).toEqual([]);
  });
});

// ============================================================
// ProductService.findBySlug
// ============================================================
describe('ProductService.findBySlug', () => {
  it('returns product when slug matches', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findFirst.mockResolvedValue(makeProduct({ slug: 'rdclaw' }));

    const result = await service.findBySlug('rdclaw');

    expect(result?.slug).toBe('rdclaw');
    expect(prisma.product.findFirst).toHaveBeenCalledWith({
      where: { slug: { equals: 'rdclaw', mode: 'insensitive' }, deletedAt: null },
    });
  });

  it('returns null when slug not found', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findFirst.mockResolvedValue(null);

    const result = await service.findBySlug('unknown-slug');
    expect(result).toBeNull();
  });
});

// ============================================================
// ProductService.create
// ============================================================
describe('ProductService.create', () => {
  it('creates product with required fields only', async () => {
    const { service, prisma } = await buildService();
    const created = makeProduct({ name: 'New Product', slug: 'new-prod' });
    prisma.product.create.mockResolvedValue(created);

    const result = await service.create({ name: 'New Product', slug: 'new-prod' });

    expect(result.name).toBe('New Product');
    expect(result.slug).toBe('new-prod');
    expect(prisma.product.create).toHaveBeenCalledWith({
      data: {
        name: 'New Product',
        slug: 'new-prod',
        allowedPaymentCallbackOrigins: [],
      },
    });
  });

  it('creates product with all optional fields', async () => {
    const { service, prisma } = await buildService();
    const data = {
      name: 'Full Product',
      slug: 'full-prod',
      description: 'A full product',
      icon: 'icon.png',
      isActive: false,
      sortOrder: 5,
    };
    prisma.product.create.mockResolvedValue(makeProduct({ ...data }));

    await service.create(data);

    expect(prisma.product.create).toHaveBeenCalledWith({
      data: {
        ...data,
        allowedPaymentCallbackOrigins: [],
      },
    });
  });

  it('defaults CODING_PLAN products to self-operated fulfillment', async () => {
    const { service, prisma } = await buildService();
    prisma.product.create.mockResolvedValue(makeProduct({
      name: 'Token Plan',
      slug: 'tokenplan',
      billingMode: 'CODING_PLAN',
      codingPlanFulfillmentMode: 'platform_model_package',
    }));

    await service.create({
      name: 'Token Plan',
      slug: 'tokenplan',
      billingMode: 'CODING_PLAN',
    });

    expect(prisma.product.create).toHaveBeenCalledWith({
      data: {
        name: 'Token Plan',
        slug: 'tokenplan',
        allowedPaymentCallbackOrigins: [],
        billingMode: 'CODING_PLAN',
        codingPlanFulfillmentMode: 'platform_model_package',
      },
    });
  });

  it('creates provider-resale CODING_PLAN products explicitly', async () => {
    const { service, prisma } = await buildService();
    prisma.product.create.mockResolvedValue(makeProduct({
      name: 'Token Plan Resale',
      slug: 'tokenplan-resale',
      billingMode: 'CODING_PLAN',
      codingPlanFulfillmentMode: 'provider_resale',
    }));

    await service.create({
      name: 'Token Plan Resale',
      slug: 'tokenplan-resale',
      billingMode: 'CODING_PLAN',
      codingPlanFulfillmentMode: 'provider_resale',
    });

    expect(prisma.product.create).toHaveBeenCalledWith({
      data: {
        name: 'Token Plan Resale',
        slug: 'tokenplan-resale',
        allowedPaymentCallbackOrigins: [],
        billingMode: 'CODING_PLAN',
        codingPlanFulfillmentMode: 'provider_resale',
      },
    });
  });

  it('returns the created product', async () => {
    const { service, prisma } = await buildService();
    const created = makeProduct({ id: 'new-id', name: 'X', slug: 'x' });
    prisma.product.create.mockResolvedValue(created);

    const result = await service.create({ name: 'X', slug: 'x' });
    expect(result.id).toBe('new-id');
  });

  it('normalizes and deduplicates callback origins when creating a product', async () => {
    const { service, prisma } = await buildService();
    prisma.product.create.mockResolvedValue(makeProduct({
      allowedPaymentCallbackOrigins: ['https://example.com', 'http://localhost:3010'],
    }));

    await service.create({
      name: 'Callbacks',
      slug: 'callbacks',
      allowedPaymentCallbackOrigins: [
        ' HTTPS://EXAMPLE.COM:443/ ',
        'https://example.com',
        'http://localhost:3010/',
      ],
    });

    expect(prisma.product.create).toHaveBeenCalledWith({
      data: {
        name: 'Callbacks',
        slug: 'callbacks',
        allowedPaymentCallbackOrigins: ['https://example.com', 'http://localhost:3010'],
      },
    });
  });

  it('stores an explicit null callback setting as SQL NULL', async () => {
    const { service, prisma } = await buildService();
    prisma.product.create.mockResolvedValue(makeProduct({ allowedPaymentCallbackOrigins: null }));

    await service.create({
      name: 'Legacy-compatible',
      slug: 'legacy-compatible',
      allowedPaymentCallbackOrigins: null,
    });

    expect(prisma.product.create).toHaveBeenCalledWith({
      data: {
        name: 'Legacy-compatible',
        slug: 'legacy-compatible',
        allowedPaymentCallbackOrigins: Prisma.DbNull,
      },
    });
  });
});

// ============================================================
// ProductService.update
// ============================================================
describe('ProductService.update', () => {
  it('updates product name and returns updated record', async () => {
    const { service, prisma } = await buildService();
    const updated = makeProduct({ name: 'Updated Name' });
    prisma.product.findFirst.mockResolvedValue(makeProduct());
    prisma.product.update.mockResolvedValue(updated);

    const result = await service.update('prod-1', { name: 'Updated Name' });

    expect(result.name).toBe('Updated Name');
    expect(prisma.product.update).toHaveBeenCalledWith({
      where: { id: 'prod-1' },
      data: { name: 'Updated Name' },
    });
  });

  it('updates isActive flag to false', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findFirst.mockResolvedValue(makeProduct());
    prisma.product.update.mockResolvedValue(makeProduct({ isActive: false }));

    await service.update('prod-1', { isActive: false });

    expect(prisma.product.update).toHaveBeenCalledWith({
      where: { id: 'prod-1' },
      data: { isActive: false },
    });
  });

  it('updates sortOrder only', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findFirst.mockResolvedValue(makeProduct());
    prisma.product.update.mockResolvedValue(makeProduct({ sortOrder: 10 }));

    const result = await service.update('prod-1', { sortOrder: 10 });

    expect(result.sortOrder).toBe(10);
    expect(prisma.product.update).toHaveBeenCalledWith({
      where: { id: 'prod-1' },
      data: { sortOrder: 10 },
    });
  });

  it('passes empty update object when no fields provided', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findFirst.mockResolvedValue(makeProduct());
    prisma.product.update.mockResolvedValue(makeProduct());

    await service.update('prod-1', {});

    expect(prisma.product.update).toHaveBeenCalledWith({
      where: { id: 'prod-1' },
      data: {},
    });
  });

  it('normalizes and deduplicates callback origins on update', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findFirst.mockResolvedValue(makeProduct());
    prisma.product.update.mockResolvedValue(makeProduct({
      allowedPaymentCallbackOrigins: ['https://app.example.com'],
    }));

    await service.update('prod-1', {
      allowedPaymentCallbackOrigins: [
        `${' '.repeat(600)}https://APP.example.com/${' '.repeat(10)}`,
        'https://app.example.com',
      ],
    });

    expect(prisma.product.update).toHaveBeenCalledWith({
      where: { id: 'prod-1' },
      data: { allowedPaymentCallbackOrigins: ['https://app.example.com'] },
    });
  });

  it('stores a null callback setting as SQL NULL on update', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findFirst.mockResolvedValue(makeProduct());
    prisma.product.update.mockResolvedValue(makeProduct({ allowedPaymentCallbackOrigins: null }));

    await service.update('prod-1', { allowedPaymentCallbackOrigins: null });

    expect(prisma.product.update).toHaveBeenCalledWith({
      where: { id: 'prod-1' },
      data: { allowedPaymentCallbackOrigins: Prisma.DbNull },
    });
  });

  it.each([
    ['wildcard', 'https://*.example.com'],
    ['path', 'https://example.com/checkout'],
    ['normalized dot path', 'https://example.com/.'],
    ['backslash path', 'https://example.com\\checkout'],
    ['query', 'https://example.com?next=/checkout'],
    ['empty query', 'https://example.com?'],
    ['hash', 'https://example.com#checkout'],
    ['userinfo', 'https://user:secret@example.com'],
    ['unsupported protocol', 'ftp://example.com'],
    ['non-loopback HTTP', 'http://example.com'],
  ])('rejects an invalid callback origin containing %s', async (_case, origin) => {
    const { service, prisma } = await buildService();
    prisma.product.findFirst.mockResolvedValue(makeProduct());

    await expect(service.update('prod-1', {
      allowedPaymentCallbackOrigins: [origin],
    })).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.product.update).not.toHaveBeenCalled();
  });

  it('rejects callback origin lists over the configured limits', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findFirst.mockResolvedValue(makeProduct());

    await expect(service.update('prod-1', {
      allowedPaymentCallbackOrigins: Array.from(
        { length: 51 },
        (_, index) => `https://product-${index}.example.com`,
      ),
    })).rejects.toThrow('allowedPaymentCallbackOrigins 最多允许 50 项');

    await expect(service.update('prod-1', {
      allowedPaymentCallbackOrigins: [`https://${'a'.repeat(500)}.example.com`],
    })).rejects.toThrow('支付回跳 Origin 不能超过 512 个字符');
  });
});

// ============================================================
// ProductService.updateRuntimePolicy
// ============================================================
describe('ProductService.updateRuntimePolicy', () => {
  it('rejects runtime policy updates without credential source', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findFirst.mockResolvedValue(makeProduct({ billingMode: 'CODING_PLAN' }));

    await expect(service.updateRuntimePolicy('prod-1', {
      runtimeBillingMode: 'token_plan_quota',
    })).rejects.toThrow('凭证来源 不能为空');

    expect(prisma.productRuntimePolicy.upsert).not.toHaveBeenCalled();
  });

  it('rejects high-loss bridge opt-in without governance fields', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findFirst.mockResolvedValue(makeProduct({ billingMode: 'CODING_PLAN' }));

    await expect(service.updateRuntimePolicy('prod-1', {
      credentialSource: 'keypool',
      allowHighLossBridgeWhenNoNative: true,
    })).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.productRuntimePolicy.upsert).not.toHaveBeenCalled();
  });

  it('ignores retired protocol strategy and saves active high-loss governance fields', async () => {
    const { service, prisma } = await buildService();
    const expiresAt = new Date(Date.now() + 86_400_000);
    prisma.product.findFirst.mockResolvedValue(makeProduct({ billingMode: 'CODING_PLAN' }));
    prisma.productRuntimePolicy.upsert.mockResolvedValue(makeRuntimePolicy({
      runtimeBillingMode: 'token_plan_quota',
      protocolStrategy: 'passthrough_only',
      allowHighLossBridgeWhenNoNative: true,
      allowBridgeOnNativeFailure: true,
      highLossBridgeReason: 'GLM protocol bridge rollout',
      highLossBridgeOwner: 'platform-ops',
      highLossBridgeExpiresAt: expiresAt,
      highLossBridgeApproval: 'approval-42',
    }));

    const result = await service.updateRuntimePolicy('prod-1', {
      credentialSource: 'keypool',
      runtimeBillingMode: 'token_plan_quota',
      protocolStrategy: 'passthrough_only',
      allowHighLossBridgeWhenNoNative: true,
      allowBridgeOnNativeFailure: true,
      highLossBridgeReason: 'GLM protocol bridge rollout',
      highLossBridgeOwner: 'platform-ops',
      highLossBridgeExpiresAt: expiresAt.toISOString(),
      highLossBridgeApproval: 'approval-42',
    });

    expect(prisma.productRuntimePolicy.upsert).toHaveBeenCalledWith({
      where: { productId: 'prod-1' },
      create: expect.objectContaining({
        productId: 'prod-1',
        allowHighLossBridgeWhenNoNative: true,
        allowBridgeOnNativeFailure: true,
        highLossBridgeReason: 'GLM protocol bridge rollout',
        highLossBridgeOwner: 'platform-ops',
        highLossBridgeExpiresAt: expiresAt,
        highLossBridgeApproval: 'approval-42',
      }),
      update: expect.objectContaining({
        allowHighLossBridgeWhenNoNative: true,
        allowBridgeOnNativeFailure: true,
        highLossBridgeReason: 'GLM protocol bridge rollout',
        highLossBridgeOwner: 'platform-ops',
        highLossBridgeExpiresAt: expiresAt,
        highLossBridgeApproval: 'approval-42',
        revision: { increment: 1 },
      }),
    });
    const upsertArg = prisma.productRuntimePolicy.upsert.mock.calls[0][0];
    expect(upsertArg.create).not.toHaveProperty('protocolStrategy');
    expect(upsertArg.update).not.toHaveProperty('protocolStrategy');
    expect(result.policy).toMatchObject({
      allowHighLossBridgeWhenNoNative: true,
      effectiveAllowHighLossBridgeWhenNoNative: true,
      allowBridgeOnNativeFailure: true,
      highLossBridgeReason: 'GLM protocol bridge rollout',
      highLossBridgeOwner: 'platform-ops',
      highLossBridgeApproval: 'approval-42',
    });
    expect(result.policy).not.toHaveProperty('protocolStrategy');
  });
});

// ============================================================
// ProductService.delete
// ============================================================
describe('ProductService.delete', () => {
  it('soft deletes product and tombstones slug', async () => {
    const { service, prisma } = await buildService();
    const product = makeProduct({ id: 'prod-1' });
    prisma.product.findFirst.mockResolvedValue(product);
    prisma.product.update.mockResolvedValue({ ...product, slug: 'rdclaw__deleted_1', isActive: false, deletedAt: new Date() });

    const result = await service.delete('prod-1');

    expect(result.id).toBe('prod-1');
    expect(prisma.product.update).toHaveBeenCalledWith({
      where: { id: 'prod-1' },
      data: expect.objectContaining({
        isActive: false,
        deletedAt: expect.any(Date),
        defaultPlanId: null,
        integrationTokenHash: null,
        integrationTokenPrefix: null,
        webhookSecretEncrypted: null,
        webhookSecretPrefix: null,
      }),
    });
    expect(prisma.product.update.mock.calls[0][0].data.slug).toMatch(/^rdclaw__deleted_\d+$/);
    expect(prisma.productRuntimePolicy.updateMany).toHaveBeenCalledWith({
      where: { productId: 'prod-1' },
      data: { revision: { increment: 1 } },
    });
    expect(prisma.product.delete).not.toHaveBeenCalled();
  });

  it('throws NotFoundException when product does not exist', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findFirst.mockResolvedValue(null);

    await expect(service.delete('missing')).rejects.toBeInstanceOf(NotFoundException);
    expect(prisma.product.delete).not.toHaveBeenCalled();
  });

  it('still soft deletes when historical records reference it', async () => {
    const { service, prisma } = await buildService();
    prisma.product.findFirst.mockResolvedValue(makeProduct({ id: 'prod-1' }));
    prisma.product.update.mockResolvedValue(makeProduct({ id: 'prod-1', isActive: false }));
    prisma.plan.count.mockResolvedValue(2);
    prisma.userSubscription.count.mockResolvedValue(1);

    await service.delete('prod-1');

    expect(prisma.product.update).toHaveBeenCalled();
    expect(prisma.product.delete).not.toHaveBeenCalled();
  });
});
