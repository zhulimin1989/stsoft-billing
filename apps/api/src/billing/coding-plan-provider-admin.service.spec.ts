import { Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { CodingPlanProviderAdminService } from './coding-plan-provider-admin.service';
import { CodingPlanProviderEntitlementAttemptService } from './coding-plan-provider-entitlement-attempt.service';

describe('CodingPlanProviderAdminService', () => {
  const now = new Date('2026-06-17T00:00:00.000Z');

  function providerLine(overrides: Record<string, unknown> = {}) {
    return {
      id: 'line-zhipu-cn',
      code: 'zhipu-cn',
      name: 'Zhipu CN',
      providerCode: 'zhipu',
      providerAccountIdentityId: 'pai-zhipu-main',
      providerName: 'Zhipu',
      adapterType: 'zhipu_partner',
      environment: 'production',
      apiBaseUrl: 'https://pre-open.bigmodel.cn',
      authType: 'partner_md5_header',
      partnerCodeEncrypted: null,
      partnerCodePrefix: null,
      partnerSecretEncrypted: null,
      partnerSecretPrefix: null,
      salesEnabled: true,
      fulfillmentEnabled: true,
      runtimeEnabled: true,
      syncEnabled: true,
      capabilities: null,
      qpsConfig: null,
      dedicatedEndpoints: [
        {
          client_protocol: 'openai',
          provider_id: 'pc_zhipu_coding_openai',
          protocol_strategy: 'passthrough',
        },
        {
          client_protocol: 'responses',
          provider_id: 'pc_zhipu_coding_openai',
          protocol_strategy: 'responses_to_chat',
        },
      ],
      metadata: null,
      createdAt: now,
      updatedAt: now,
      ...overrides,
    };
  }

  function buildService() {
    const prisma = {
      $transaction: jest.fn(),
      codingPlanProviderLine: {
        create: jest.fn().mockResolvedValue(providerLine()),
        update: jest.fn().mockResolvedValue(providerLine()),
        findUnique: jest.fn().mockResolvedValue(providerLine()),
        delete: jest.fn().mockResolvedValue(providerLine()),
      },
      codingPlanResaleRoute: {
        count: jest.fn().mockResolvedValue(0),
        create: jest.fn().mockResolvedValue({ id: 'route-1' }),
        update: jest.fn().mockResolvedValue({ id: 'route-1' }),
        findUnique: jest.fn(),
      },
      plan: {
        findUnique: jest.fn(),
      },
      product: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'prod-resale',
          billingMode: 'CODING_PLAN',
          codingPlanFulfillmentMode: 'provider_resale',
          deletedAt: null,
        }),
      },
      productRuntimePolicy: {
        upsert: jest.fn().mockResolvedValue({ id: 'policy-1' }),
      },
      channel: {
        upsert: jest.fn().mockResolvedValue({ id: 'dch-1' }),
      },
      productChannel: {
        findFirst: jest.fn().mockResolvedValue(null),
        upsert: jest.fn().mockResolvedValue({ id: 'dpc-1' }),
      },
      codingPlanProviderProduct: {
        findUnique: jest.fn(),
      },
      codingPlanProviderEntitlement: {
        count: jest.fn().mockResolvedValue(0),
        findUnique: jest.fn(),
        update: jest.fn().mockResolvedValue({}),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      providerAccountIdentity: {
        findUnique: jest.fn().mockResolvedValue({
          ref: 'pa_zhipu_main',
          providerCode: 'zhipu',
          status: 'active',
        }),
      },
      codingPlanEntitlement: {
        count: jest.fn().mockResolvedValue(0),
      },
    };
    prisma.$transaction.mockImplementation(async (callback: (tx: typeof prisma) => unknown) => callback(prisma));
    const accepted = { status: 'accepted' as const };
    const publisherSync = {
      syncOpsTopologyFreshRequired: jest.fn().mockResolvedValue(accepted),
      syncApiKeysByCodingPlanProviderLineRequired: jest.fn().mockResolvedValue(2),
      syncRuntimeIntentAfterProductPolicyChangeRequired: jest.fn().mockResolvedValue(accepted),
    };
    const providerLines = {
      getForFulfillment: jest.fn(),
    };
    const adapter = {
      createOrder: jest.fn(),
    };
    const adapterRegistry = {
      get: jest.fn().mockReturnValue(adapter),
    };
    const billingService = {
      attachCodingPlanProviderEntitlement: jest.fn().mockResolvedValue(undefined),
    };
    const config = { get: jest.fn() };
    const entitlementAttempts = new CodingPlanProviderEntitlementAttemptService(
      prisma as unknown as PrismaService,
    );
    const service = new CodingPlanProviderAdminService(
      prisma as never,
      config as unknown as ConfigService,
      providerLines as never,
      adapterRegistry as never,
      billingService as never,
      publisherSync as never,
      entitlementAttempts,
    );
    return {
      service,
      prisma,
      publisherSync,
      providerLines,
      adapterRegistry,
      adapter,
      billingService,
      config,
    };
  }

  beforeEach(() => {
    jest.spyOn(Logger.prototype, 'warn').mockImplementation(() => undefined);
    jest.spyOn(Logger.prototype, 'log').mockImplementation(() => undefined);
  });

  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('creates provider line before binding dedicated runtime product channels', async () => {
    const { service, prisma } = buildService();
    prisma.codingPlanProviderLine.create.mockResolvedValueOnce(providerLine({
      id: 'line-new',
      code: 'zhipu-new',
      dedicatedEndpoints: null,
    }));
    prisma.codingPlanProviderLine.update.mockResolvedValueOnce(providerLine({
      id: 'line-new',
      code: 'zhipu-new',
    }));

    await service.createProviderLine({
      id: 'line-new',
      code: 'zhipu-new',
      name: 'Zhipu New',
      providerCode: 'zhipu',
      providerName: 'Zhipu',
      adapterType: 'zhipu_partner',
      apiBaseUrl: 'https://pre-open.bigmodel.cn',
      runtimeEnabled: true,
      dedicatedProductId: 'prod-resale',
      dedicatedEndpoints: [
        {
          client_protocol: 'openai',
          base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
          provider_profile: 'glm_coding',
          served_inbound_protocols: ['openai', 'responses'],
        },
      ],
    });

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    expect(prisma.codingPlanProviderLine.create.mock.calls[0][0].data)
      .not.toHaveProperty('dedicatedEndpoints');
    expect(prisma.productChannel.upsert.mock.calls[0][0].create.providerLineId).toBe('line-new');
    expect(prisma.productChannel.upsert.mock.calls[0][0].update.providerLineId).toBe('line-new');
    expect(prisma.codingPlanProviderLine.create.mock.invocationCallOrder[0])
      .toBeLessThan(prisma.productChannel.upsert.mock.invocationCallOrder[0]);
    expect(prisma.productChannel.upsert.mock.invocationCallOrder[0])
      .toBeLessThan(prisma.codingPlanProviderLine.update.mock.invocationCallOrder[0]);
    expect(prisma.codingPlanProviderLine.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'line-new' },
      data: expect.objectContaining({
        dedicatedEndpoints: [
          {
            client_protocol: 'openai',
            provider_id: expect.stringMatching(/^pc_dpc_[a-f0-9]{24}$/),
            protocol_strategy: 'passthrough',
          },
          {
            client_protocol: 'responses',
            provider_id: expect.stringMatching(/^pc_dpc_[a-f0-9]{24}$/),
            protocol_strategy: 'responses_to_chat',
          },
        ],
      }),
    }));
  });

  it('requires an account identity before enabling provider fulfillment', async () => {
    const { service, prisma } = buildService();

    await expect(service.createProviderLine({
      code: 'zhipu-new',
      name: 'Zhipu New',
      providerCode: 'zhipu',
      adapterType: 'zhipu_partner',
      apiBaseUrl: 'https://pre-open.bigmodel.cn',
      fulfillmentEnabled: true,
    })).rejects.toThrow('开启供应商履约前必须绑定供应商账户身份');

    expect(prisma.codingPlanProviderLine.create).not.toHaveBeenCalled();
  });

  it('validates and persists the provider-line account identity', async () => {
    const { service, prisma } = buildService();
    prisma.codingPlanProviderLine.create.mockResolvedValueOnce(providerLine({
      providerAccountIdentityId: 'pai-zhipu-main',
    }));

    await service.createProviderLine({
      code: 'zhipu-new',
      name: 'Zhipu New',
      providerCode: 'zhipu',
      providerAccountIdentityId: ' pai-zhipu-main ',
      adapterType: 'zhipu_partner',
      apiBaseUrl: 'https://pre-open.bigmodel.cn',
      fulfillmentEnabled: true,
    });

    expect(prisma.providerAccountIdentity.findUnique).toHaveBeenCalledWith({
      where: { id: 'pai-zhipu-main' },
      select: { ref: true, providerCode: true, status: true },
    });
    expect(prisma.codingPlanProviderLine.create.mock.calls[0][0].data)
      .toEqual(expect.objectContaining({ providerAccountIdentityId: 'pai-zhipu-main' }));
  });

  it('inherits the provider-line account identity on entitlement retry', async () => {
    const {
      service,
      prisma,
      providerLines,
      adapter,
      billingService,
      config,
    } = buildService();
    prisma.codingPlanProviderEntitlement.findUnique.mockResolvedValue({
      id: 'provider-entitlement-1',
      orderId: 'order-1',
      status: 'FAILED',
      fulfillmentAttemptId: null,
      fulfillmentClaimedAt: null,
      createdAt: now,
      updatedAt: now,
      providerLineId: 'line-zhipu-cn',
      partnerUserId: 'partner-user-1',
      partnerOrderNo: 'partner-order-1',
      upstreamProductId: 'upstream-product-1',
    });
    providerLines.getForFulfillment.mockResolvedValueOnce({
      id: 'line-zhipu-cn',
      code: 'zhipu-cn',
      providerCode: 'zhipu',
      providerAccountIdentityId: 'pai-zhipu-main',
      adapterType: 'zhipu_partner',
    });
    adapter.createOrder.mockResolvedValueOnce({
      upstreamOrderId: 'upstream-order-1',
      apiKey: 'sk-upstream-long-value',
      secretKey: 'secret-upstream-long-value',
      credentialFormat: 'apiKey.secretKey',
      productStartTime: null,
      productEndTime: null,
      raw: {},
    });
    config.get.mockImplementation((key: string) => (
      key === 'ENCRYPTION_KEY' ? 'a'.repeat(64) : undefined
    ));

    await expect(service.retryProviderEntitlement('provider-entitlement-1'))
      .resolves.toEqual({
        status: 'activated',
        providerEntitlementId: 'provider-entitlement-1',
      });

    expect(prisma.codingPlanProviderEntitlement.updateMany).toHaveBeenNthCalledWith(
      1,
      {
        where: {
          id: 'provider-entitlement-1',
          status: 'FAILED',
          fulfillmentAttemptId: null,
          fulfillmentClaimedAt: null,
        },
        data: expect.objectContaining({
          providerAccountIdentityId: 'pai-zhipu-main',
          status: 'PENDING',
          fulfillmentAttemptId: expect.any(String),
          fulfillmentClaimedAt: expect.any(Date),
        }),
      },
    );
    expect(prisma.codingPlanProviderEntitlement.updateMany).toHaveBeenNthCalledWith(
      3,
      {
        where: {
          id: 'provider-entitlement-1',
          status: 'PENDING',
          fulfillmentAttemptId: expect.any(String),
        },
        data: expect.objectContaining({
          status: 'ACTIVE',
          fulfillmentAttemptId: null,
          fulfillmentClaimedAt: null,
        }),
      },
    );
    expect(billingService.attachCodingPlanProviderEntitlement)
      .toHaveBeenCalledWith('order-1');
  });

  it('rejects admin retry while a non-stale PENDING attempt owns the lease', async () => {
    const { service, prisma, providerLines, adapter } = buildService();
    const pending = {
      id: 'provider-entitlement-1',
      orderId: 'order-1',
      status: 'PENDING',
      providerLineId: 'line-zhipu-cn',
      partnerUserId: 'partner-user-1',
      partnerOrderNo: 'partner-order-1',
      upstreamProductId: 'upstream-product-1',
      fulfillmentAttemptId: 'attempt-running',
      fulfillmentClaimedAt: new Date(),
      createdAt: now,
      updatedAt: new Date(),
    };
    prisma.codingPlanProviderEntitlement.findUnique.mockResolvedValue(pending);
    providerLines.getForFulfillment.mockResolvedValueOnce({
      id: 'line-zhipu-cn',
      code: 'zhipu-cn',
      providerCode: 'zhipu',
      providerAccountIdentityId: 'pai-zhipu-main',
      adapterType: 'zhipu_partner',
    });

    await expect(service.retryProviderEntitlement('provider-entitlement-1'))
      .rejects.toThrow('供应商履约正在进行');

    expect(prisma.codingPlanProviderEntitlement.updateMany).not.toHaveBeenCalled();
    expect(adapter.createOrder).not.toHaveBeenCalled();
  });

  it('ignores an old admin response when a newer attempt is already ACTIVE', async () => {
    const {
      service,
      prisma,
      providerLines,
      adapter,
      billingService,
      config,
    } = buildService();
    const failed = {
      id: 'provider-entitlement-1',
      orderId: 'order-1',
      status: 'FAILED',
      providerLineId: 'line-zhipu-cn',
      partnerUserId: 'partner-user-1',
      partnerOrderNo: 'partner-order-1',
      upstreamProductId: 'upstream-product-1',
      fulfillmentAttemptId: null,
      fulfillmentClaimedAt: null,
      createdAt: now,
      updatedAt: now,
    };
    prisma.codingPlanProviderEntitlement.findUnique
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce(failed)
      .mockResolvedValueOnce({ status: 'ACTIVE' });
    prisma.codingPlanProviderEntitlement.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    providerLines.getForFulfillment.mockResolvedValueOnce({
      id: 'line-zhipu-cn',
      code: 'zhipu-cn',
      providerCode: 'zhipu',
      providerAccountIdentityId: 'pai-zhipu-main',
      adapterType: 'zhipu_partner',
    });
    adapter.createOrder.mockResolvedValueOnce({
      upstreamOrderId: 'upstream-order-old',
      apiKey: 'sk-upstream-old-value',
      secretKey: 'secret-upstream-old-value',
      credentialFormat: 'apiKey.secretKey',
      productStartTime: null,
      productEndTime: null,
      raw: {},
    });
    config.get.mockImplementation((key: string) => (
      key === 'ENCRYPTION_KEY' ? 'a'.repeat(64) : undefined
    ));

    await expect(service.retryProviderEntitlement('provider-entitlement-1'))
      .resolves.toEqual({
        status: 'already_active',
        providerEntitlementId: 'provider-entitlement-1',
      });

    expect(prisma.codingPlanProviderEntitlement.updateMany).toHaveBeenNthCalledWith(
      3,
      expect.objectContaining({
        where: {
          id: 'provider-entitlement-1',
          status: 'PENDING',
          fulfillmentAttemptId: expect.any(String),
        },
      }),
    );
    expect(billingService.attachCodingPlanProviderEntitlement)
      .toHaveBeenCalledWith('order-1');
  });

  it('syncs publisher topology and bound api keys after provider line update', async () => {
    const { service, prisma, publisherSync } = buildService();

    const result = await service.updateProviderLine('line-zhipu-cn', {
      runtimeEnabled: true,
      dedicatedProductId: 'prod-resale',
      dedicatedEndpoints: [
        {
          client_protocol: 'openai',
          base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
          provider_profile: 'glm_coding',
          served_inbound_protocols: ['openai', 'responses'],
        },
      ],
    });

    expect(result.id).toBe('line-zhipu-cn');
    const savedEndpoints = prisma.codingPlanProviderLine.update.mock.calls[0][0].data.dedicatedEndpoints;
    expect(savedEndpoints).toEqual([
      {
        client_protocol: 'openai',
        provider_id: expect.stringMatching(/^pc_dpc_[a-f0-9]{24}$/),
        protocol_strategy: 'passthrough',
      },
      {
        client_protocol: 'responses',
        provider_id: expect.stringMatching(/^pc_dpc_[a-f0-9]{24}$/),
        protocol_strategy: 'responses_to_chat',
      },
    ]);
    expect(savedEndpoints[0].provider_id).toBe(savedEndpoints[1].provider_id);
    expect(prisma.codingPlanProviderLine.update).toHaveBeenCalledWith(expect.objectContaining({
      where: { id: 'line-zhipu-cn' },
      data: expect.objectContaining({
        dedicatedEndpoints: savedEndpoints,
      }),
    }));
    expect(prisma.channel.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.productChannel.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.productChannel.upsert.mock.calls[0][0].create.providerLineId).toBe('line-zhipu-cn');
    expect(prisma.productChannel.upsert.mock.calls[0][0].update.providerLineId).toBe('line-zhipu-cn');
    expect(prisma.productChannel.upsert.mock.calls[0][0].create.allowedModels).toEqual([]);
    expect(prisma.productChannel.upsert.mock.calls[0][0].create.metadata).toEqual(
      expect.objectContaining({
        dedicated_runtime: expect.objectContaining({
          provider_profile: 'glm_coding',
          base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
          served_inbound_protocols: ['openai', 'responses'],
        }),
      }),
    );
    expect(prisma.productRuntimePolicy.upsert).toHaveBeenCalledTimes(1);
    expect(prisma.productRuntimePolicy.upsert).toHaveBeenCalledWith(expect.objectContaining({
      create: expect.objectContaining({
        credentialSource: 'dedicated_upstream',
        runtimeBillingMode: 'included_upstream',
      }),
      update: expect.objectContaining({
        credentialSource: 'dedicated_upstream',
        runtimeBillingMode: 'included_upstream',
      }),
    }));
    expect(publisherSync.syncRuntimeIntentAfterProductPolicyChangeRequired).toHaveBeenCalledWith('prod-resale');
    expect(publisherSync.syncOpsTopologyFreshRequired).toHaveBeenCalledTimes(1);
    expect(publisherSync.syncApiKeysByCodingPlanProviderLineRequired).toHaveBeenCalledWith({
      id: 'line-zhipu-cn',
      code: 'zhipu-cn',
    });
  });

  it('rejects changing a provider line across providers after fulfillment records exist', async () => {
    const { service, prisma, publisherSync } = buildService();
    prisma.codingPlanProviderEntitlement.count.mockResolvedValueOnce(1);

    await expect(service.updateProviderLine('line-zhipu-cn', {
      providerCode: 'kimi',
      providerAccountIdentityId: 'pai-kimi-main',
    })).rejects.toThrow('请新建供应商线路');

    expect(prisma.codingPlanProviderLine.update).not.toHaveBeenCalled();
    expect(prisma.providerAccountIdentity.findUnique).not.toHaveBeenCalled();
    expect(publisherSync.syncOpsTopologyFreshRequired).not.toHaveBeenCalled();
  });

  it('treats canonical provider aliases as the same provider on update', async () => {
    const { service, prisma } = buildService();
    prisma.codingPlanProviderLine.findUnique.mockResolvedValueOnce(providerLine({
      providerCode: 'moonshot',
      providerAccountIdentityId: 'pai-kimi-main',
    }));
    prisma.providerAccountIdentity.findUnique.mockResolvedValueOnce({
      ref: 'pa_kimi_main',
      providerCode: 'kimi',
      status: 'active',
    });

    await expect(service.updateProviderLine('line-zhipu-cn', {
      providerCode: 'kimi',
    })).resolves.toBeDefined();

    expect(prisma.codingPlanProviderEntitlement.count).not.toHaveBeenCalled();
    expect(prisma.codingPlanProviderLine.update).toHaveBeenCalled();
  });

  it('rejects reusing a dedicated ProductChannel owned by another provider line', async () => {
    const { service, prisma } = buildService();
    prisma.productChannel.findFirst.mockResolvedValueOnce({
      id: 'dpc-existing',
      channelId: 'dch-existing',
      providerLineId: 'line-other',
      metadata: {
        provider_isolation: {
          visibility: 'dedicated_only',
          credential_source: 'dedicated_upstream',
          allowed_route_kinds: ['dedicated_route'],
        },
      },
    });

    await expect(service.updateProviderLine('line-zhipu-cn', {
      runtimeEnabled: true,
      dedicatedProductId: 'prod-resale',
      dedicatedEndpoints: [
        {
          client_protocol: 'openai',
          provider_id: 'pc_dpc-existing',
          base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
          provider_profile: 'glm_coding',
        },
      ],
    })).rejects.toThrow('provider_id 已绑定到其他供应商线路');

    expect(prisma.productChannel.upsert).not.toHaveBeenCalled();
    expect(prisma.codingPlanProviderLine.update).not.toHaveBeenCalled();
  });

  it('expands GLM coding dedicated endpoints to explicit per-protocol channels', async () => {
    const { service, prisma } = buildService();

    await service.updateProviderLine('line-zhipu-cn', {
      runtimeEnabled: true,
      dedicatedProductId: 'prod-resale',
      dedicatedEndpoints: [
        {
          client_protocol: 'openai',
          base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
          provider_profile: 'glm_coding',
          served_inbound_protocols: ['openai', 'responses'],
        },
        {
          client_protocol: 'anthropic',
          base_url: 'https://open.bigmodel.cn/api/anthropic',
          provider_profile: 'anthropic_native',
          served_inbound_protocols: ['anthropic'],
        },
      ],
    });

    const savedEndpoints = prisma.codingPlanProviderLine.update.mock.calls[0][0].data.dedicatedEndpoints;
    expect(savedEndpoints).toEqual([
      {
        client_protocol: 'openai',
        provider_id: expect.stringMatching(/^pc_dpc_[a-f0-9]{24}$/),
        protocol_strategy: 'passthrough',
      },
      {
        client_protocol: 'responses',
        provider_id: expect.stringMatching(/^pc_dpc_[a-f0-9]{24}$/),
        protocol_strategy: 'responses_to_chat',
      },
      {
        client_protocol: 'anthropic',
        provider_id: expect.stringMatching(/^pc_dpc_[a-f0-9]{24}$/),
        protocol_strategy: 'passthrough',
      },
    ]);
    expect(savedEndpoints[0].provider_id).toBe(savedEndpoints[1].provider_id);
    expect(savedEndpoints[2].provider_id).not.toBe(savedEndpoints[0].provider_id);
  });

  it('uses anthropic_to_chat when an openai upstream has no native anthropic endpoint', async () => {
    const { service, prisma } = buildService();

    await service.updateProviderLine('line-zhipu-cn', {
      runtimeEnabled: true,
      dedicatedProductId: 'prod-resale',
      dedicatedEndpoints: [
        {
          client_protocol: 'openai',
          base_url: 'https://api.deepseek.com/v1',
          provider_profile: 'openai_compatible',
          served_inbound_protocols: ['openai', 'responses', 'anthropic'],
        },
      ],
    });

    const savedEndpoints = prisma.codingPlanProviderLine.update.mock.calls[0][0].data.dedicatedEndpoints;
    expect(savedEndpoints).toEqual([
      {
        client_protocol: 'openai',
        provider_id: expect.stringMatching(/^pc_dpc_[a-f0-9]{24}$/),
        protocol_strategy: 'passthrough',
      },
      {
        client_protocol: 'responses',
        provider_id: expect.stringMatching(/^pc_dpc_[a-f0-9]{24}$/),
        protocol_strategy: 'responses_to_chat',
      },
      {
        client_protocol: 'anthropic',
        provider_id: expect.stringMatching(/^pc_dpc_[a-f0-9]{24}$/),
        protocol_strategy: 'anthropic_to_chat',
      },
    ]);
    expect(savedEndpoints[0].provider_id).toBe(savedEndpoints[1].provider_id);
    expect(savedEndpoints[0].provider_id).toBe(savedEndpoints[2].provider_id);
  });

  it('rejects duplicate dedicated inbound protocols', async () => {
    const { service, prisma, publisherSync } = buildService();

    await expect(service.updateProviderLine('line-zhipu-cn', {
      runtimeEnabled: true,
      dedicatedProductId: 'prod-resale',
      dedicatedEndpoints: [
        {
          client_protocol: 'openai',
          base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
          provider_profile: 'glm_coding',
          served_inbound_protocols: ['openai', 'responses', 'anthropic'],
        },
        {
          client_protocol: 'anthropic',
          base_url: 'https://open.bigmodel.cn/api/anthropic',
          provider_profile: 'anthropic_native',
          served_inbound_protocols: ['anthropic'],
        },
      ],
    })).rejects.toThrow('dedicatedEndpoints client_protocol 不能重复: anthropic');
    expect(prisma.codingPlanProviderLine.update).not.toHaveBeenCalled();
    expect(prisma.channel.upsert).not.toHaveBeenCalled();
    expect(publisherSync.syncOpsTopologyFreshRequired).not.toHaveBeenCalled();
  });

  it('allows key-meta-only dedicated endpoints without runtime provider fields', async () => {
    const { service, prisma } = buildService();

    await service.updateProviderLine('line-zhipu-cn', {
      runtimeEnabled: true,
      dedicatedEndpoints: [
        {
          client_protocol: 'openai',
          provider_id: 'pc_runtime_openai',
          protocol_strategy: 'passthrough',
        },
        {
          client_protocol: 'responses',
          provider_id: 'pc_runtime_openai',
          protocol_strategy: 'responses_to_chat',
        },
      ],
    });

    expect(prisma.codingPlanProviderLine.update).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        dedicatedEndpoints: [
          {
            client_protocol: 'openai',
            provider_id: 'pc_runtime_openai',
            protocol_strategy: 'passthrough',
          },
          {
            client_protocol: 'responses',
            provider_id: 'pc_runtime_openai',
            protocol_strategy: 'responses_to_chat',
          },
        ],
      }),
    }));
  });

  it('allows physically invalid path declarations and leaves warnings to publisher', async () => {
    const { service, prisma } = buildService();

    await service.updateProviderLine('line-zhipu-cn', {
      runtimeEnabled: true,
      dedicatedProductId: 'prod-resale',
      dedicatedEndpoints: [
        {
          client_protocol: 'anthropic',
          base_url: 'https://open.bigmodel.cn/api/anthropic',
          provider_profile: 'anthropic_native',
          served_inbound_protocols: ['responses'],
        },
      ],
    });

    const savedEndpoints = prisma.codingPlanProviderLine.update.mock.calls[0][0].data.dedicatedEndpoints;
    expect(savedEndpoints).toEqual([
      {
        client_protocol: 'responses',
        provider_id: expect.stringMatching(/^pc_dpc_/),
        protocol_strategy: 'passthrough',
      },
    ]);
  });

  it('rejects legacy client compatibility on dedicated endpoints', async () => {
    const { service } = buildService();

    await expect(service.updateProviderLine('line-zhipu-cn', {
      runtimeEnabled: true,
      dedicatedProductId: 'prod-resale',
      dedicatedEndpoints: [
        {
          client_protocol: 'openai',
          base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
          provider_profile: 'glm_coding',
          client_compatibility: ['codex'],
        },
      ],
    })).rejects.toThrow('client_compatibility 已废弃；请改用 served_inbound_protocols');
  });

  it('rejects dedicated endpoints with bare provider ids', async () => {
    const { service } = buildService();

    await expect(service.updateProviderLine('line-zhipu-cn', {
      runtimeEnabled: true,
      dedicatedEndpoints: [
        {
          client_protocol: 'openai',
          provider_id: 'glm-openai',
          protocol_strategy: 'passthrough',
        },
      ],
    })).rejects.toThrow('pc_* Runtime Provider');
  });

  it('requires runtime provider fields only when a dedicated endpoint configures runtime publishing', async () => {
    const { service } = buildService();

    await expect(service.updateProviderLine('line-zhipu-cn', {
      runtimeEnabled: true,
      dedicatedEndpoints: [
        {
          client_protocol: 'responses',
          provider_id: 'pc_runtime_openai',
          protocol_strategy: 'responses_to_chat',
          base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
        },
      ],
    })).rejects.toThrow('base_url / provider_profile');
  });

  it('rejects static owner_scope on provider line runtime providers', async () => {
    const { service } = buildService();

    await expect(service.updateProviderLine('line-zhipu-cn', {
      runtimeEnabled: true,
      dedicatedEndpoints: [
        {
          client_protocol: 'responses',
          provider_id: 'pc_runtime_openai',
          protocol_strategy: 'responses_to_chat',
          base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
          provider_profile: 'openai_compatible',
          owner_scope: { tenant_id: 'tenant-1' },
        },
      ],
    })).rejects.toThrow('provider line 禁止配置静态 owner_scope');
  });

  it('fails provider line save when topology sync is not accepted by publisher', async () => {
    const { service, publisherSync } = buildService();
    publisherSync.syncOpsTopologyFreshRequired.mockRejectedValueOnce(new Error('publisher down'));

    await expect(service.updateProviderLine('line-zhipu-cn', { runtimeEnabled: true }))
      .rejects.toThrow('publisher down');

    expect(publisherSync.syncOpsTopologyFreshRequired).toHaveBeenCalledTimes(1);
    expect(publisherSync.syncApiKeysByCodingPlanProviderLineRequired).not.toHaveBeenCalled();
  });

  it('fails provider line save when bound api key sync is not accepted by publisher', async () => {
    const { service, publisherSync } = buildService();
    publisherSync.syncApiKeysByCodingPlanProviderLineRequired.mockRejectedValueOnce(new Error('key sync down'));

    await expect(service.updateProviderLine('line-zhipu-cn', { runtimeEnabled: true }))
      .rejects.toThrow('key sync down');

    expect(publisherSync.syncOpsTopologyFreshRequired).toHaveBeenCalledTimes(1);
    expect(publisherSync.syncApiKeysByCodingPlanProviderLineRequired).toHaveBeenCalledTimes(1);
  });

  it('deletes unused provider lines and refreshes publisher runtime', async () => {
    const { service, prisma, publisherSync } = buildService();

    await expect(service.deleteProviderLine('line-zhipu-cn')).resolves.toEqual({
      deleted: true,
      id: 'line-zhipu-cn',
      code: 'zhipu-cn',
      name: 'Zhipu CN',
      publisherSync: {
        ok: true,
        status: 'ACCEPTED',
      },
    });

    expect(prisma.codingPlanResaleRoute.count).toHaveBeenCalledWith({ where: { providerLineId: 'line-zhipu-cn' } });
    expect(prisma.codingPlanProviderEntitlement.count).toHaveBeenCalledWith({ where: { providerLineId: 'line-zhipu-cn' } });
    expect(prisma.codingPlanEntitlement.count).toHaveBeenCalledWith({ where: { providerLineId: 'line-zhipu-cn' } });
    expect(prisma.codingPlanProviderLine.delete).toHaveBeenCalledWith({ where: { id: 'line-zhipu-cn' } });
    expect(publisherSync.syncOpsTopologyFreshRequired).toHaveBeenCalledTimes(1);
  });

  it('blocks provider line deletion when resale routes exist', async () => {
    const { service, prisma } = buildService();
    prisma.codingPlanResaleRoute.count.mockResolvedValueOnce(1);

    await expect(service.deleteProviderLine('line-zhipu-cn')).rejects.toThrow('供应商线路已绑定转售映射');

    expect(prisma.codingPlanProviderLine.delete).not.toHaveBeenCalled();
  });

  it('blocks provider line deletion when entitlements exist', async () => {
    const { service, prisma } = buildService();
    prisma.codingPlanProviderEntitlement.count.mockResolvedValueOnce(1);

    await expect(service.deleteProviderLine('line-zhipu-cn')).rejects.toThrow('供应商线路已有履约记录或用户权益');

    expect(prisma.codingPlanProviderLine.delete).not.toHaveBeenCalled();
  });
});
