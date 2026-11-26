import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  validateKeyMeta,
  validateRuntimeIntent,
  type RuntimeIntent as PublisherRuntimeIntent,
} from '@raytone-lab/publisher-contracts';
import { encrypt } from '../common/utils/crypto';
import { decryptGatewayLocalSecret, encryptGatewayLocalSecret } from '../common/utils/gateway-secret';
import { PublisherClient } from './publisher.client';
import { PublisherAdmissionSupersededError } from './publisher-sync-job.service';
import { PublisherSyncService } from './publisher-sync.service';

const mockKmsSend = jest.fn();
jest.mock('@aws-sdk/client-kms', () => ({
  KMSClient: jest.fn().mockImplementation(() => ({ send: mockKmsSend })),
  EncryptCommand: jest.fn().mockImplementation((input) => ({ input })),
}));

describe('PublisherSyncService', () => {
  const ENCRYPTION_KEY = 'a'.repeat(64);
  const LEGACY_PROCESS_REVISION = 1_731_494_400_123_456;
  const KEY_BALANCE_REVISION = 1_800_000_000_000_000;
  const KEY_BALANCE_REVISION_FLOOR = 1_000_000_000_000_000;

  function emptyPendingAdmissionRow() {
    return {
      financialAuthorityValid: true,
      accountBalanceUsd: new Prisma.Decimal('5'),
      activeCreditLimitUsd: new Prisma.Decimal(0),
      balanceAllowanceUsd: null as Prisma.Decimal | null,
      balanceAllowanceUsedUsd: new Prisma.Decimal(0),
      keyBudgetUsd: new Prisma.Decimal('10') as Prisma.Decimal | null,
      budgetRelevantSpentUsd: new Prisma.Decimal('2'),
      blockingReasons: [] as string[],
      fundingReservationHoldUsd: new Prisma.Decimal(0),
      fundingReservationRequestCount: 0n,
      provisionalHoldUsd: new Prisma.Decimal(0),
      provisionalRequestCount: 0n,
    };
  }

  function rawQueryText(query: unknown): string {
    return Array.isArray(query) ? query.join('') : String(query);
  }

  function zhipuAnthropicDedicatedEndpoints() {
    return [
      {
        client_protocol: 'anthropic',
        provider_id: 'pc_zhipu_coding_anthropic',
        protocol_strategy: 'passthrough',
      },
    ];
  }

  function zhipuOpenAiDedicatedEndpoints() {
    return [
      {
        client_protocol: 'openai',
        provider_id: 'pc_zhipu_coding_openai',
      },
      {
        client_protocol: 'responses',
        provider_id: 'pc_zhipu_coding_openai',
      },
    ];
  }

  function legacyZhipuOpenAiDedicatedEndpoints() {
    return [
      {
        client_protocol: 'openai',
        provider_id: 'pc_zhipu_coding_openai',
        protocol_strategy: 'passthrough',
        base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
        provider_profile: 'openai_compatible',
        logical_models: ['glm-5.2'],
      },
      {
        client_protocol: 'responses',
        provider_id: 'pc_zhipu_coding_openai',
        protocol_strategy: 'responses_to_chat',
        base_url: 'https://open.bigmodel.cn/api/coding/paas/v4',
        provider_profile: 'openai_compatible',
        logical_models: ['glm-5.2'],
      },
    ];
  }

  function makeService(configOverrides: Record<string, string | undefined> = {}) {
    mockKmsSend.mockReset();
    mockKmsSend.mockResolvedValue({ CiphertextBlob: Buffer.from('kms-ciphertext') });
    const publisher = {
      revision: jest.fn().mockReturnValue(LEGACY_PROCESS_REVISION),
      compileProviderPreview: jest.fn(),
      establishRefundDrain: jest.fn().mockResolvedValue({
        protocol_version: 1,
        drain_id: 'ent-1',
        key_count: 1,
        in_flight: 0,
        request_seen_key_count: 0,
        ready: true,
      }),
    } as unknown as jest.Mocked<PublisherClient>;
    const syncJobs = {
      dispatchDetailed: jest.fn().mockResolvedValue({
        accepted: true,
        status: 'ACCEPTED',
        idempotencyKey: 'rd:test',
      }),
      dispatchRequired: jest.fn().mockResolvedValue(null),
    };
    const pendingAdmission = emptyPendingAdmissionRow();
    const nextKeyBalanceRevision = jest.fn().mockReturnValue(BigInt(KEY_BALANCE_REVISION));
    const prisma = {
      tenant: {
        findUnique: jest.fn().mockResolvedValue({
          id: 'tenant-1',
          billingAccountId: 'ba_personal_user-1',
        }),
      },
      apiKey: {
        findUnique: jest.fn().mockResolvedValue({
          id: '9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
          userId: 'user-1',
          tenantId: 'tenant-1',
          tenant: {
            billingAccountId: 'ba_personal_user-1',
            balanceAllowanceUsd: null,
            balanceAllowanceUsedUsd: new Prisma.Decimal(0),
          },
          productId: 'prod-1',
          product: { slug: 'coding', name: 'Coding', billingMode: 'PAY_AS_YOU_GO' },
          name: 'prod key',
          keyHash: 'b'.repeat(64),
          allowedModels: JSON.stringify(['gpt-4o']),
          budgetUsd: new Prisma.Decimal('10'),
          isActive: true,
          mirrorStatus: 'ACTIVE',
          deletedAt: null,
        }),
        findMany: jest.fn().mockResolvedValue([{
          id: '9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
          userId: 'user-1',
          tenantId: 'tenant-1',
          productId: 'prod-1',
          product: { slug: 'coding', name: 'Coding' },
          name: 'prod key',
          keyHash: 'b'.repeat(64),
          isActive: true,
          mirrorStatus: 'ACTIVE',
          allowedModels: JSON.stringify(['gpt-4o']),
          budgetUsd: new Prisma.Decimal('10'),
          deletedAt: null,
        }]),
      },
      accountWallet: {
        findUnique: jest.fn().mockResolvedValue({ balanceUsd: new Prisma.Decimal('5') }),
      },
      billingAccount: {
        findUnique: jest.fn().mockResolvedValue({
          type: 'personal',
          creditConfig: null,
        }),
      },
      tokenUsage: {
        aggregate: jest.fn().mockResolvedValue({ _sum: { costUsd: new Prisma.Decimal('2') } }),
      },
      subscriptionPeriod: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      creditTransaction: {
        findFirst: jest.fn().mockResolvedValue(null),
      },
      creditBalanceState: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      codingPlanEntitlement: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      codingPlanProviderLine: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      codingPlanResaleRoute: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      grantRedemption: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      productRuntimePolicy: {
        count: jest.fn().mockResolvedValue(0),
        findMany: jest.fn().mockResolvedValue([]),
      },
      product: {
        findFirst: jest.fn().mockResolvedValue(null),
        findMany: jest.fn().mockResolvedValue([]),
      },
      productChannelGroup: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      productChannel: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      routeAssignment: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      userSegmentMember: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      channel: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      modelPricing: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockImplementation(({ where }: { where?: { modelName?: string } } = {}) => Promise.resolve({
          modelName: where?.modelName ?? 'gpt-4o',
          isActive: true,
          isPublished: true,
          provider: 'openai',
          supportedFeatures: null,
          inputModalities: null,
          outputModalities: null,
          contextLength: null,
          maxOutputTokens: null,
        })),
      },
      productModelAvailability: {
        findMany: jest.fn().mockResolvedValue([
          { productId: 'prod-1', modelName: 'gpt-4.1' },
          { productId: 'prod-1', modelName: 'gpt-4o' },
          { productId: 'prod-payg', modelName: 'glm-5.2' },
          { productId: 'prod-empty', modelName: 'gpt-4o' },
        ]),
      },
      systemConfig: {
        findUnique: jest.fn().mockResolvedValue(null),
      },
      publisherSyncJob: {
        findMany: jest.fn().mockResolvedValue([]),
      },
      $queryRaw: jest.fn().mockImplementation((query: unknown) => {
        const sql = rawQueryText(query);
        if (sql.includes('next_publisher_key_balance_revision')) {
          return Promise.resolve([{ revision: nextKeyBalanceRevision() }]);
        }
        if (sql.includes('account_authority')) {
          return Promise.resolve([{ ...pendingAdmission }]);
        }
        throw new Error(`Unexpected raw Publisher query: ${sql.slice(0, 80)}`);
      }),
    };
    const defaultConfig: Record<string, string | undefined> = {
      ENCRYPTION_KEY,
      DEDICATED_UPSTREAM_KMS_KEY_ID: 'kms-key-coding',
      DEDICATED_UPSTREAM_KMS_REGION: 'us-east-1',
      BILLING_PLATFORM_CURRENCY: 'cny',
      BILLING_USAGE_PENDING_MAX_REQUESTS: '100',
      BILLING_USAGE_PENDING_MAX_EXPOSURE_USD: '1000',
    };
    const config = {
      get: jest.fn((key: string) => {
        if (Object.prototype.hasOwnProperty.call(configOverrides, key)) {
          return configOverrides[key];
        }
        return defaultConfig[key];
      }),
    } as unknown as ConfigService;
    const rollingQuotaGate = {
      evaluateExhaustion: jest.fn().mockResolvedValue({ exhausted: false, recheckAtMs: 0 }),
      loadEnforcedRollingRules: jest.fn().mockResolvedValue([]),
      invalidateRulesCache: jest.fn().mockResolvedValue(undefined),
    };
    const redis = {
      zadd: jest.fn().mockResolvedValue(1),
      zrem: jest.fn().mockResolvedValue(1),
      zrangebyscore: jest.fn().mockResolvedValue([]),
      mget: jest.fn().mockResolvedValue([null, null]),
    };
    const service = new PublisherSyncService(
      publisher,
      prisma as never,
      config,
      syncJobs as never,
      rollingQuotaGate as never,
      redis as never,
    );
    return {
      service,
      publisher,
      prisma,
      syncJobs,
      config,
      rollingQuotaGate,
      redis,
      pendingAdmission,
      nextKeyBalanceRevision,
    };
  }

  function dedicatedProductChannel(providerId: string, productId = 'prod-coding', providerLineId: string | null = 'line-zhipu') {
    return {
      id: providerId.replace(/^pc_/, ''),
      productId,
      providerLineId,
      metadata: {
        provider_isolation: {
          visibility: 'dedicated_only',
          credential_source: 'dedicated_upstream',
          allowed_route_kinds: ['dedicated_route'],
          owner_scope: { product_id: productId },
        },
        ...(providerLineId ? { provider_line: { id: providerLineId } } : {}),
      },
      channel: { deletedAt: null },
      deletedAt: null,
    };
  }

  function mockDedicatedRuntimeProviders(
    prisma: ReturnType<typeof makeService>['prisma'],
    providerIds: Array<string | { providerId: string; providerLineId?: string | null }>,
    productId = 'prod-coding',
  ) {
    prisma.productChannel.findMany.mockResolvedValueOnce(
      providerIds.map((entry) => {
        if (typeof entry === 'string') return dedicatedProductChannel(entry, productId);
        return dedicatedProductChannel(entry.providerId, productId, entry.providerLineId ?? null);
      }),
    );
  }

  function providerResaleEntitlementFixture(overrides: {
    entitlement?: Record<string, unknown>;
    providerEntitlement?: Record<string, unknown> | null;
    dedicatedEndpoints?: unknown;
  } = {}) {
    const updatedAt = new Date('2026-06-15T00:00:00.000Z');
    const providerEntitlement = overrides.providerEntitlement === null
      ? null
      : {
          id: 'provider-entitlement-1',
          status: 'ACTIVE',
          provider: 'zhipu',
          providerLineId: 'line-zhipu',
          providerCode: 'zhipu',
          adapterType: 'zhipu_partner',
          providerLineCode: 'zhipu_overseas',
          providerAccountIdentityId: 'pai-zhipu-main',
          upstreamProductId: 'product-zhipu',
          upstreamApiKeyEncrypted: encrypt('api-key-1', ENCRYPTION_KEY),
          upstreamSecretKeyEncrypted: encrypt('secret-key-1', ENCRYPTION_KEY),
          providerAccountIdentity: {
            ref: 'pa_zhipu_main',
            providerCode: 'zhipu',
            status: 'active',
          },
          providerLine: {
            id: 'line-zhipu',
            code: 'zhipu_overseas',
            providerCode: 'zhipu',
            providerAccountIdentityId: 'pai-zhipu-main',
            adapterType: 'zhipu_partner',
            runtimeEnabled: true,
            dedicatedEndpoints: overrides.dedicatedEndpoints
              ?? zhipuOpenAiDedicatedEndpoints(),
          },
          productEndTime: new Date('2030-01-01T00:00:00.000Z'),
          activatedAt: new Date('2026-06-14T00:00:00.000Z'),
          updatedAt,
          ...overrides.providerEntitlement,
        };
    return {
      id: 'ent-dedicated-1',
      status: 'ACTIVE',
      fulfillmentMode: 'provider_resale',
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      providerCode: 'zhipu',
      providerLineCode: 'zhipu_overseas',
      providerLine: {
        id: 'line-zhipu',
        code: 'zhipu_overseas',
        providerCode: 'zhipu',
        providerAccountIdentityId: 'pai-zhipu-main',
        adapterType: 'zhipu_partner',
        runtimeEnabled: true,
        dedicatedEndpoints: overrides.dedicatedEndpoints ?? zhipuOpenAiDedicatedEndpoints(),
      },
      providerEntitlement,
      ...overrides.entitlement,
    };
  }

  function providerResaleApiKeyFixture(overrides: Record<string, unknown> = {}) {
    return {
      id: 'key-dedicated-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-coding',
      codingPlanEntitlementId: 'ent-dedicated-1',
      product: { slug: 'coding', name: 'Coding' },
      name: 'zhipu dedicated key',
      keyHash: 'e'.repeat(64),
      isActive: true,
      mirrorStatus: 'ACTIVE',
      allowedModels: JSON.stringify(['glm-5.2']),
      budgetUsd: null,
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      ipWhitelist: null,
      rateLimitRpm: 60,
      rateLimitTpm: 120000,
      deletedAt: null,
      ...overrides,
    };
  }

  async function syncProviderResaleApiKey(
    entitlement: Record<string, unknown>,
    keyOverrides: Record<string, unknown> = {},
    productRuntimeProviderIds: Array<string | { providerId: string; providerLineId?: string | null }> = [],
  ) {
    const context = makeService();
    context.prisma.codingPlanEntitlement.findFirst.mockResolvedValue(entitlement);
    mockDedicatedRuntimeProviders(context.prisma, productRuntimeProviderIds);
    await context.service.syncApiKeyMeta(providerResaleApiKeyFixture(keyOverrides));
    return context;
  }

  function expectSuspendedProviderResaleKey(syncJobs: ReturnType<typeof makeService>['syncJobs']) {
    const putKeyCall = syncJobs.dispatchDetailed.mock.calls.find(([job]) =>
      job.namespace === 'user' && job.method === 'PUT' && job.path === '/user/api/v1/keys',
    );
    expect(putKeyCall).toBeDefined();
    const body = putKeyCall?.[0].body as Record<string, unknown>;
    expect(body).toEqual(expect.objectContaining({
      key_id: 'key-dedicated-1',
      status: 'suspended',
      allowed_models: ['glm-5.2'],
    }));
    expect(body).not.toHaveProperty('dedicated_upstream');
    expect(body).not.toHaveProperty('policies');
    expect(validateKeyMeta(body)).toBe(true);
    expect(syncJobs.dispatchDetailed.mock.calls.some(([job]) =>
      job.namespace === 'user' && job.method === 'DELETE' && String(job.path).includes('/revoked-keys/'),
    )).toBe(false);
    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'billing',
      method: 'DELETE',
      path: '/billing/api/v1/key-balance/key-dedicated-1',
      body: {
        decision_id: expect.any(String),
        decision_version: KEY_BALANCE_REVISION,
      },
    }));
    expect(syncJobs.dispatchDetailed.mock.calls.some(([job]) =>
      job.namespace === 'billing' && job.method === 'PUT',
    )).toBe(false);
  }

  it('keeps provider compile-preview on the legacy preview client path', async () => {
    const { service, publisher } = makeService();
    publisher.compileProviderPreview.mockImplementationOnce(async (body) => ({
      provider: body,
      default_protocol_binding: 'openai_chat',
      binding_names: ['openai_chat'],
    }));

    const result = await service.previewProviderCompile({
      name: 'OpenAI Preview',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      sdkType: 'openai',
      providerProfile: 'openai_compatible',
    });

    expect(publisher.compileProviderPreview).toHaveBeenCalledWith(expect.objectContaining({
      code: 'openai',
      name: 'OpenAI Preview',
      base_url: 'https://api.openai.com',
      path_prefix: '/v1',
      provider_profile: 'openai_compatible',
      status: 'active',
    }));
    expect(result).toEqual(expect.objectContaining({
      mode: 'publisher_compiler',
      publisherCompiled: expect.objectContaining({
        binding_names: ['openai_chat'],
      }),
    }));
  });

  it('establishes a refund drain over every historical entitlement key', async () => {
    const { service, publisher, prisma } = makeService();
    prisma.apiKey.findMany.mockResolvedValueOnce([
      { keyHash: 'b'.repeat(64) },
      { keyHash: 'a'.repeat(64) },
      { keyHash: 'b'.repeat(64) },
    ] as never);
    publisher.establishRefundDrain.mockResolvedValueOnce({
      protocol_version: 1,
      drain_id: 'ent-1',
      key_count: 2,
      in_flight: 0,
      request_seen_key_count: 0,
      ready: true,
    });

    await expect(
      service.establishCodingPlanRefundDrainRequired('ent-1'),
    ).resolves.toMatchObject({ ready: true, key_count: 2 });

    expect(prisma.apiKey.findMany).toHaveBeenCalledWith({
      where: { codingPlanEntitlementId: 'ent-1' },
      select: { keyHash: true },
      orderBy: { id: 'asc' },
    });
    expect(publisher.establishRefundDrain).toHaveBeenCalledWith(
      'ent-1',
      ['a'.repeat(64), 'b'.repeat(64)],
    );
  });

  it('rejects a malformed refund drain proof', async () => {
    const { service, publisher } = makeService();
    publisher.establishRefundDrain.mockResolvedValueOnce({
      protocol_version: 1,
      drain_id: 'another-entitlement',
      key_count: 1,
      in_flight: 0,
      request_seen_key_count: 0,
      ready: true,
    });

    await expect(
      service.establishCodingPlanRefundDrainRequired('ent-1'),
    ).rejects.toThrow('invalid refund drain proof');
  });

  it('persists refund drain release through the Publisher retry queue', async () => {
    const { service, syncJobs } = makeService();

    await service.releaseCodingPlanRefundDrain('ent-1');

    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'billing',
      method: 'DELETE',
      path: '/billing/api/v1/refund-drains/ent-1',
      body: undefined,
      resourceType: 'coding_plan_refund_drain',
      resourceId: 'ent-1',
    }));
  });

  it('maps local ApiKey into Publisher KeyMeta and key-balance payloads', async () => {
    const { service, syncJobs } = makeService();

    await service.syncApiKeyMeta({
      id: '9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      product: { slug: 'coding', name: 'Coding' },
      name: 'prod key',
      keyHash: 'b'.repeat(64),
      isActive: true,
      mirrorStatus: 'ACTIVE',
      allowedModels: JSON.stringify(['gpt-4o']),
      budgetUsd: new Prisma.Decimal('10'),
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      ipWhitelist: JSON.stringify(['203.0.113.10']),
      rateLimitRpm: 120,
      rateLimitTpm: 50_000,
      maxTokensPerCall: 8192,
      maxMessages: 50,
      allowTools: false,
      allowVision: true,
      deletedAt: null,
    });

    expect(syncJobs.dispatchDetailed).toHaveBeenNthCalledWith(1, expect.objectContaining({
      namespace: 'billing',
      method: 'PUT',
      path: '/billing/api/v1/key-activation/9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
      source: 'admin',
      resourceType: 'api_key',
      resourceId: '9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
      body: expect.objectContaining({
        key_meta: expect.objectContaining({
          key_id: '9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
          key_hash: 'b'.repeat(64),
          alias: 'prod key',
          status: 'active',
          expires_at: 1893456000,
          ip_whitelist: ['203.0.113.10'],
          enforce_model_whitelist: true,
          allowed_models: ['gpt-4o'],
          max_tokens_per_call: 8192,
          guardrails: {
            max_messages: 50,
            allow_tools: false,
          },
          policies: [
          {
            version: 2,
            policy_id: 'rpm-key-9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
            policy_type: 'rate_limit',
            control_semantic: 'window_reject',
            subject_side: 'user',
            metric: 'rpm',
            scope: 'key',
            scope_id: '9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
            window: '60s',
            limit_value: 120,
            runtime_keys: {
              family: 'rl',
              count_suffix: 'key:{scope_id}:rpm:{window}:{window_id}',
            },
          },
          {
            version: 2,
            policy_id: 'tpm-key-9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
            policy_type: 'rate_limit',
            control_semantic: 'window_reject',
            subject_side: 'user',
            metric: 'tpm',
            scope: 'key',
            scope_id: '9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
            window: '60s',
            limit_value: 50_000,
            runtime_keys: {
              family: 'rl',
              count_suffix: 'key:{scope_id}:tpm:{window}:{window_id}',
            },
          },
        ],
          scope_attrs: expect.objectContaining({
            tenant_id: 'tenant-1',
            user_id: 'user-1',
            product_id: 'prod-1',
            client_compat: 'all',
            'usr.product_id': 'prod-1',
            'usr.product_slug': 'coding',
          }),
        }),
        has_balance: true,
        decision_id: expect.any(String),
        decision_version: KEY_BALANCE_REVISION,
      }),
    }));
    const activation = syncJobs.dispatchDetailed.mock.calls[0][0].body as Record<string, any>;
    const keyMeta = activation.key_meta as Record<string, unknown>;
    expect(syncJobs.dispatchDetailed.mock.calls[0][0].idempotencyKey).toMatch(/^rd:api-key:/);
    expect(keyMeta).not.toHaveProperty('schema_version');
    expect(keyMeta).not.toHaveProperty('revision');
    expect(keyMeta).not.toHaveProperty('sse_concurrency');
    expect(keyMeta).not.toHaveProperty('resource_bindings');
    expect(keyMeta).not.toHaveProperty('allowance_bindings');
    expect(syncJobs.dispatchDetailed).toHaveBeenCalledTimes(1);
    expect(syncJobs.dispatchDetailed).toHaveBeenNthCalledWith(1, expect.objectContaining({
      namespace: 'billing',
      method: 'PUT',
      path: '/billing/api/v1/key-activation/9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
      source: 'admin',
      resourceType: 'api_key',
      resourceId: '9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
      body: expect.objectContaining({
        key_meta: expect.objectContaining({
          key_id: '9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
          status: 'active',
        }),
        has_balance: true,
        decision_id: expect.any(String),
        decision_version: KEY_BALANCE_REVISION,
      }),
    }));
  });

  it('marks PAYG KeyMeta as requiring product policy at the gateway', async () => {
    const { service, syncJobs } = makeService();

    await service.syncApiKeyMeta({
      id: 'payg-key-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-payg',
      product: { slug: 'payg', name: 'PAYG', billingMode: 'PAY_AS_YOU_GO' },
      name: 'payg key',
      keyHash: 'c'.repeat(64),
      isActive: true,
      mirrorStatus: 'ACTIVE',
      allowedModels: null,
      budgetUsd: null,
      deletedAt: null,
    });

    const body = (syncJobs.dispatchDetailed.mock.calls[0][0].body as Record<string, any>).key_meta;
    expect(body.scope_attrs).toEqual(expect.objectContaining({
      product_id: 'prod-payg',
      product_policy_required: 'true',
      'usr.product_policy_required': 'true',
    }));
    expect(validateKeyMeta(body)).toBe(true);
  });

  it('uses required dispatch for explicit required api key syncs', async () => {
    const { service, syncJobs } = makeService();

    await service.syncApiKeyMetaRequired({
      id: '9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      product: { slug: 'coding', name: 'Coding' },
      name: 'prod key',
      keyHash: 'b'.repeat(64),
      isActive: true,
      mirrorStatus: 'ACTIVE',
      allowedModels: JSON.stringify(['gpt-4o']),
      budgetUsd: new Prisma.Decimal('10'),
      deletedAt: null,
    });

    expect(syncJobs.dispatchDetailed).not.toHaveBeenCalled();
    expect(syncJobs.dispatchRequired).toHaveBeenCalledTimes(1);
    expect(syncJobs.dispatchRequired).toHaveBeenNthCalledWith(1, expect.objectContaining({
      namespace: 'billing',
      method: 'PUT',
      path: '/billing/api/v1/key-activation/9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
      resourceType: 'api_key',
      resourceId: '9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
      body: expect.objectContaining({
        key_meta: expect.objectContaining({ status: 'active' }),
        has_balance: true,
        decision_id: expect.any(String),
        decision_version: KEY_BALANCE_REVISION,
      }),
    }));
  });

  it('publishes an explicit active payload while a provisioned key is still locally inactive', async () => {
    const { service, syncJobs, prisma } = makeService();
    prisma.apiKey.findUnique.mockResolvedValue({
      id: 'key-provisioning',
      userId: 'user-1',
      tenantId: 'tenant-1',
      tenant: { billingAccountId: 'ba_personal_user-1' },
      productId: 'prod-1',
      product: { slug: 'coding', name: 'Coding', billingMode: 'PAY_AS_YOU_GO' },
      name: 'saas:coding:virtual',
      keyHash: 'd'.repeat(64),
      isActive: false,
      mirrorStatus: 'PROVISIONING',
      allowedModels: null,
      budgetUsd: null,
      deletedAt: null,
    });

    await service.syncApiKeyActivationRequired('key-provisioning');

    expect(syncJobs.dispatchRequired).toHaveBeenCalledTimes(1);
    expect(syncJobs.dispatchRequired).toHaveBeenNthCalledWith(1, expect.objectContaining({
        namespace: 'billing',
        method: 'PUT',
        path: '/billing/api/v1/key-activation/key-provisioning',
        body: expect.objectContaining({
          key_meta: expect.objectContaining({
          key_id: 'key-provisioning',
          status: 'active',
          }),
          has_balance: true,
          decision_id: expect.any(String),
          decision_version: KEY_BALANCE_REVISION,
        }),
      }));
    expect(syncJobs.dispatchRequired).not.toHaveBeenCalledWith(
      expect.objectContaining({
        namespace: 'billing',
        method: 'DELETE',
        path: '/billing/api/v1/key-balance/key-provisioning',
      }),
    );
  });

  it('activates a locally provisioning provider-resale key with dedicated upstream metadata', async () => {
    const { service, syncJobs, prisma } = makeService();
    prisma.apiKey.findUnique.mockResolvedValue(providerResaleApiKeyFixture({
      isActive: false,
      mirrorStatus: 'PROVISIONING',
      product: {
        slug: 'coding',
        name: 'Coding',
        billingMode: 'CODING_PLAN',
      },
    }));
    prisma.codingPlanEntitlement.findFirst.mockResolvedValue(
      providerResaleEntitlementFixture(),
    );
    mockDedicatedRuntimeProviders(prisma, ['pc_zhipu_coding_openai']);

    await service.syncApiKeyActivationRequired('key-dedicated-1');

    const keyPut = syncJobs.dispatchRequired.mock.calls.find(([job]) =>
      job.namespace === 'billing' && job.method === 'PUT' && job.path === '/billing/api/v1/key-activation/key-dedicated-1',
    );
    expect(keyPut).toBeDefined();
    expect(keyPut?.[0].body).toEqual(expect.objectContaining({
      key_meta: expect.objectContaining({
        key_id: 'key-dedicated-1',
        status: 'active',
        dedicated_upstream: expect.objectContaining({
          upstream_key_id: 'provider-entitlement-1',
          status: 'active',
        }),
      }),
      has_balance: true,
      decision_id: expect.any(String),
      decision_version: KEY_BALANCE_REVISION,
    }));
    expect(syncJobs.dispatchRequired).toHaveBeenCalledTimes(1);
  });

  it('resolves a key billing account and requires fresh balance fanout for all account keys', async () => {
    const { service, syncJobs, prisma } = makeService();
    prisma.apiKey.findMany
      .mockResolvedValueOnce([{ id: '9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4' }])
      .mockResolvedValueOnce([]);

    await service.syncBillingAccountKeyBalancesByKeyIdRequired(
      '9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
    );

    expect(prisma.apiKey.findMany).toHaveBeenNthCalledWith(1, {
      where: {
        deletedAt: null,
        tenant: { billingAccountId: 'ba_personal_user-1' },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 100,
    });
    expect(syncJobs.dispatchDetailed).not.toHaveBeenCalled();
    expect(syncJobs.dispatchRequired).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'billing',
      method: 'PUT',
      path: '/billing/api/v1/key-balance/9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
      resourceType: 'key_balance',
      resourceId: '9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
    }));
  });

  it('resolves a tenant current billing account before required balance fanout', async () => {
    const { service, syncJobs, prisma } = makeService();
    prisma.apiKey.findMany
      .mockResolvedValueOnce([{ id: '9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4' }])
      .mockResolvedValueOnce([]);

    await service.syncBillingAccountKeyBalancesByTenantIdRequired('tenant-1');

    expect(prisma.tenant.findUnique).toHaveBeenCalledWith({
      where: { id: 'tenant-1' },
      select: { billingAccountId: true },
    });
    expect(prisma.apiKey.findMany).toHaveBeenNthCalledWith(1, {
      where: {
        deletedAt: null,
        tenant: { billingAccountId: 'ba_personal_user-1' },
      },
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 100,
    });
    expect(syncJobs.dispatchDetailed).not.toHaveBeenCalled();
    expect(syncJobs.dispatchRequired).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'billing',
      method: 'PUT',
      path: '/billing/api/v1/key-balance/9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
    }));
  });

  it('limits required account balance fanout to 20 concurrent admissions', async () => {
    const { service, syncJobs, prisma } = makeService();
    const keys = Array.from({ length: 45 }, (_, index) => ({ id: `required-key-${index}` }));
    prisma.apiKey.findMany
      .mockResolvedValueOnce(keys)
      .mockResolvedValueOnce([]);
    let active = 0;
    let maxActive = 0;
    syncJobs.dispatchRequired.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      return null;
    });

    await service.syncBillingAccountKeyBalancesRequired('ba-personal-owner');

    expect(syncJobs.dispatchRequired).toHaveBeenCalledTimes(keys.length);
    expect(maxActive).toBe(20);
  });

  it('attempts every key in a required fanout page before reporting failures', async () => {
    const { service, syncJobs, prisma } = makeService();
    const keys = Array.from({ length: 45 }, (_, index) => ({ id: `required-key-${index}` }));
    prisma.apiKey.findMany
      .mockResolvedValueOnce(keys)
      .mockResolvedValueOnce([]);
    syncJobs.dispatchRequired.mockRejectedValue(new Error('publisher unavailable'));

    await expect(
      service.syncBillingAccountKeyBalancesRequired('ba-personal-owner'),
    ).rejects.toThrow('publisher unavailable');

    expect(syncJobs.dispatchRequired).toHaveBeenCalledTimes(keys.length);
  });

  it('continues required account fanout across pages before reporting a page failure', async () => {
    const { service, syncJobs, prisma } = makeService();
    const keys = Array.from({ length: 101 }, (_, index) => ({
      id: `required-key-${String(index).padStart(3, '0')}`,
    }));
    prisma.apiKey.findMany
      .mockResolvedValueOnce(keys.slice(0, 100))
      .mockResolvedValueOnce(keys.slice(100))
      .mockResolvedValueOnce([]);
    syncJobs.dispatchRequired.mockImplementation(async (input) => {
      if (input.path.endsWith('/required-key-000')) {
        throw new Error('publisher rejected first page key');
      }
      return null;
    });

    await expect(
      service.syncBillingAccountKeyBalancesRequired('ba-personal-owner'),
    ).rejects.toThrow('publisher rejected first page key');

    expect(syncJobs.dispatchRequired).toHaveBeenCalledTimes(keys.length);
    expect(syncJobs.dispatchRequired).toHaveBeenCalledWith(expect.objectContaining({
      path: '/billing/api/v1/key-balance/required-key-100',
    }));
    expect(prisma.apiKey.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      cursor: { id: 'required-key-099' },
      skip: 1,
      take: 100,
    }));
  });

  it('stops dispatching new required admissions when the caller loses ownership', async () => {
    const { service, syncJobs, prisma } = makeService();
    const keys = Array.from({ length: 100 }, (_, index) => ({
      id: `required-key-${String(index).padStart(3, '0')}`,
    }));
    prisma.apiKey.findMany.mockResolvedValueOnce(keys);
    let owned = true;
    let dispatched = 0;
    syncJobs.dispatchRequired.mockImplementation(async () => {
      dispatched += 1;
      if (dispatched === 20) owned = false;
      await new Promise<void>((resolve) => setImmediate(resolve));
      return null;
    });

    await expect(service.syncBillingAccountKeyBalancesRequired(
      'ba-personal-owner',
      {},
      {
        assertActive: () => {
          if (!owned) throw new Error('projection lease lost');
        },
      },
    )).rejects.toThrow('projection lease lost');

    expect(syncJobs.dispatchRequired).toHaveBeenCalledTimes(20);
    expect(prisma.apiKey.findMany).toHaveBeenCalledTimes(1);
  });

  it('keeps async account balance fanout concurrent across the whole page', async () => {
    const { service, syncJobs, prisma } = makeService();
    const keys = Array.from({ length: 45 }, (_, index) => ({ id: `async-key-${index}` }));
    prisma.apiKey.findMany
      .mockResolvedValueOnce(keys)
      .mockResolvedValueOnce([]);
    let active = 0;
    let maxActive = 0;
    syncJobs.dispatchDetailed.mockImplementation(async () => {
      active += 1;
      maxActive = Math.max(maxActive, active);
      await new Promise<void>((resolve) => setImmediate(resolve));
      active -= 1;
      return {
        accepted: true,
        status: 'ACCEPTED',
        idempotencyKey: 'rd:test',
      };
    });

    await service.syncBillingAccountKeyBalances('ba-personal-owner');

    expect(syncJobs.dispatchDetailed).toHaveBeenCalledTimes(keys.length);
    expect(maxActive).toBe(keys.length);
  });

  it('deletes model catalog and route runtime state', async () => {
    const { service, syncJobs } = makeService();

    await service.deleteModelRuntime('glm-5.2');

    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'admin',
      method: 'DELETE',
      path: '/admin/api/v1/models/glm-5.2/catalog',
      resourceType: 'model_catalog',
      resourceId: 'glm-5.2',
    }));
    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'admin',
      method: 'DELETE',
      path: '/admin/api/v1/models/glm-5.2/route',
      resourceType: 'model_route',
      resourceId: 'glm-5.2',
    }));
  });

  it('re-syncs api keys bound to a CodingPlan provider line', async () => {
    const { service, prisma } = makeService();
    const syncSpy = jest.spyOn(service, 'syncApiKeyMetaById').mockResolvedValue(undefined);
    prisma.codingPlanEntitlement.findMany.mockResolvedValueOnce([
      { id: 'ent-1' },
      { id: 'ent-2' },
    ]);
    prisma.apiKey.findMany
      .mockResolvedValueOnce([{ id: 'key-1' }, { id: 'key-2' }])
      .mockResolvedValueOnce([{ id: 'key-3' }]);

    const count = await service.syncApiKeysByCodingPlanProviderLine({
      id: 'line-zhipu-cn',
      code: 'zhipu-cn',
    });

    expect(count).toBe(3);
    expect(prisma.codingPlanEntitlement.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        fulfillmentMode: 'provider_resale',
        status: 'ACTIVE',
      }),
    }));
    expect(syncSpy).toHaveBeenCalledTimes(3);
    expect(syncSpy).toHaveBeenNthCalledWith(1, 'key-1', {});
    expect(syncSpy).toHaveBeenNthCalledWith(3, 'key-3', {});
  });

  it('uses required key syncs for required CodingPlan provider line fanout', async () => {
    const { service, prisma } = makeService();
    const syncSpy = jest.spyOn(service, 'syncApiKeyMetaByIdRequired').mockResolvedValue(undefined);
    prisma.codingPlanEntitlement.findMany.mockResolvedValueOnce([{ id: 'ent-1' }]);
    prisma.apiKey.findMany.mockResolvedValueOnce([{ id: 'key-1' }, { id: 'key-2' }]);

    const count = await service.syncApiKeysByCodingPlanProviderLineRequired({
      id: 'line-zhipu-cn',
      code: 'zhipu-cn',
    });

    expect(count).toBe(2);
    expect(syncSpy).toHaveBeenCalledTimes(2);
    expect(syncSpy).toHaveBeenNthCalledWith(1, 'key-1', {});
    expect(syncSpy).toHaveBeenNthCalledWith(2, 'key-2', {});
  });

  it('compiles product route graph from product channel routing tables', async () => {
    const { service, prisma } = makeService();
    const channel = {
      id: 'ch-1',
      name: 'OpenAI primary',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      sdkType: 'openai_completions',
      providerProfile: 'openai_compatible',
      clientCompatibility: null,
      tokenCountStrategy: null,
      models: JSON.stringify(['gpt-4.1']),
      modelConfigs: null,
      apiKeyEncrypted: 'ciphertext',
      isActive: true,
      status: 'active',
      priority: 10,
      weight: 80,
      maxRpm: null,
      maxTpm: null,
      successRate: 1,
      totalReqs: 0,
      totalErrs: 0,
      avgLatencyMs: null,
      remark: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      deletedAt: null,
    };
    const productChannel = {
      id: 'pc-1',
      productId: 'prod-1',
      channelId: 'ch-1',
      displayName: 'OpenAI for PAYG',
      status: 'active',
      isDefault: true,
      allowedModels: [],
      deniedModels: [],
      priority: 10,
      weight: 80,
      maxRpm: 100,
      maxTpm: null,
      metadata: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      deletedAt: null,
      channel,
    };
    prisma.productChannelGroup.findMany.mockResolvedValueOnce([
      {
        id: 'grp-default',
        productId: 'prod-1',
        code: 'default',
        name: 'Default',
        description: null,
        strategy: 'weighted_failover',
        isDefault: true,
        status: 'active',
        metadata: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        deletedAt: null,
        members: [
          {
            id: 'member-1',
            groupId: 'grp-default',
            productChannelId: 'pc-1',
            priority: 10,
            weight: 80,
            role: 'primary',
            maxRpm: null,
            maxTpm: null,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            updatedAt: new Date('2026-01-01T00:00:00.000Z'),
            productChannel,
          },
        ],
      },
    ]);
    prisma.productChannel.findMany.mockResolvedValueOnce([productChannel]);
    prisma.routeAssignment.findMany.mockResolvedValueOnce([
      {
        id: 'ra-1',
        productId: 'prod-1',
        subjectType: 'USER',
        subjectId: 'user-1',
        modelPattern: null,
        clientCompatibility: null,
        targetType: 'GROUP',
        targetId: 'grp-default',
        mode: 'ONLY',
        priority: 1000,
        startsAt: null,
        endsAt: null,
        isActive: true,
        reason: null,
        metadata: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);
    const graph = await service.buildProductRouteGraph('prod-1');

    expect(graph.schema_version).toBe(1);
    expect(graph.default_target).toEqual({ target_type: 'GROUP', target_id: 'grp-default' });
    expect(graph.groups.find((group) => group.id === 'grp-default')).toEqual(expect.objectContaining({
      id: 'grp-default',
      code: 'default',
      status: 'active',
      strategy: 'weighted_failover',
      members: [
        expect.objectContaining({
          product_channel_id: 'pc_pc-1',
          channel_id: 'ch-1',
          provider_id: 'pc_pc-1',
          priority: 10,
          weight: 80,
          role: 'primary',
        }),
      ],
    }));
    expect(graph.product_channels.find((pc) => pc.id === 'pc_pc-1')).toEqual(expect.objectContaining({
      id: 'pc_pc-1',
      channel_id: 'ch-1',
      provider_id: 'pc_pc-1',
      allowed_models: ['gpt-4.1'],
      denied_models: [],
      priority: 10,
      weight: 80,
      max_rpm: 100,
      status: 'active',
    }));
    expect(graph.assignments).toEqual([
      expect.objectContaining({
        id: 'ra-1',
        product_id: 'prod-1',
        subject_type: 'USER',
        subject_id: 'user-1',
        target_type: 'GROUP',
        target_id: 'grp-default',
        mode: 'ONLY',
        priority: 1000,
      }),
    ]);
    expect(prisma.modelPricing.findMany).toHaveBeenCalledTimes(1);
  });

  it('uses a product channel default target when no route group exists', async () => {
    const { service, prisma } = makeService();
    const channel = {
      id: 'ch-1',
      name: 'OpenAI primary',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      sdkType: 'openai_completions',
      providerProfile: 'openai_compatible',
      clientCompatibility: null,
      tokenCountStrategy: null,
      models: JSON.stringify(['gpt-4.1']),
      modelConfigs: null,
      apiKeyEncrypted: 'ciphertext',
      isActive: true,
      status: 'active',
      priority: 10,
      weight: 80,
      maxRpm: null,
      maxTpm: null,
      successRate: 1,
      totalReqs: 0,
      totalErrs: 0,
      avgLatencyMs: null,
      remark: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      deletedAt: null,
    };
    const productChannel = {
      id: 'pc-1',
      productId: 'prod-1',
      channelId: 'ch-1',
      displayName: 'OpenAI for PAYG',
      status: 'active',
      isDefault: true,
      allowedModels: ['gpt-4.1'],
      deniedModels: [],
      priority: 10,
      weight: 80,
      maxRpm: null,
      maxTpm: null,
      metadata: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      deletedAt: null,
      channel,
    };
    prisma.productChannelGroup.findMany.mockResolvedValueOnce([]);
    prisma.productChannel.findMany.mockResolvedValueOnce([productChannel]);
    prisma.routeAssignment.findMany.mockResolvedValueOnce([]);
    const graph = await service.buildProductRouteGraph('prod-1');

    expect(graph.default_target).toEqual({ target_type: 'PRODUCT_CHANNEL', target_id: 'pc_pc-1' });
    expect(graph.groups).toEqual([]);
    expect(graph.product_channels).toEqual([
      expect.objectContaining({
        id: 'pc_pc-1',
        channel_id: 'ch-1',
        provider_id: 'pc_pc-1',
        allowed_models: ['gpt-4.1'],
      }),
    ]);
    expect(prisma.modelPricing.findMany).toHaveBeenCalledTimes(1);
  });

  it('requires concrete runtime models when a channel only stores wildcard inventory', async () => {
    const { service, prisma } = makeService();
    const channel = {
      id: 'ch-1',
      name: 'OpenAI wildcard',
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      sdkType: 'openai_completions',
      providerProfile: 'openai_compatible',
      clientCompatibility: null,
      tokenCountStrategy: null,
      models: JSON.stringify(['*']),
      modelConfigs: null,
      apiKeyEncrypted: 'ciphertext',
      isActive: true,
      status: 'active',
      priority: 10,
      weight: 80,
      maxRpm: null,
      maxTpm: null,
      successRate: 1,
      totalReqs: 0,
      totalErrs: 0,
      avgLatencyMs: null,
      remark: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      deletedAt: null,
    };
    prisma.productChannelGroup.findMany.mockResolvedValueOnce([]);
    prisma.productChannel.findMany.mockResolvedValueOnce([{
      id: 'pc-1',
      productId: 'prod-1',
      channelId: 'ch-1',
      displayName: 'OpenAI wildcard',
      status: 'active',
      isDefault: true,
      allowedModels: [],
      deniedModels: [],
      priority: 10,
      weight: 80,
      maxRpm: null,
      maxTpm: null,
      metadata: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      deletedAt: null,
      channel,
    }]);
    prisma.routeAssignment.findMany.mockResolvedValueOnce([]);

    await expect(service.buildProductRouteGraph('prod-1'))
      .rejects.toThrow('configure allowedModels or concrete channel.models');
    expect(prisma.modelPricing.findMany).toHaveBeenCalledTimes(1);
  });

  it('fails fast when a product route graph has no product channels', async () => {
    const { service, prisma } = makeService();
    prisma.productChannelGroup.findMany.mockResolvedValueOnce([]);
    prisma.productChannel.findMany.mockResolvedValueOnce([]);
    prisma.routeAssignment.findMany.mockResolvedValueOnce([]);

    await expect(service.buildProductRouteGraph('prod-empty'))
      .rejects.toThrow('Product prod-empty has no product_channels for RuntimeIntent route_graph');
  });

  it('deletes RuntimeIntent product policies for products without bound product channels', async () => {
    const { service, syncJobs, prisma } = makeService();
    prisma.product.findMany.mockResolvedValueOnce([{
      id: 'prod-empty',
      slug: 'empty',
      name: 'Empty product',
      billingMode: 'PAY_AS_YOU_GO',
      isActive: true,
      deletedAt: null,
      runtimePolicy: {
        id: 'policy-empty',
        productId: 'prod-empty',
        credentialSource: 'keypool',
        allowedProviderIds: [],
        allowedChannelIds: [],
        modelScopeMode: 'plan_configured',
        allowedModels: [],
        fallbackPolicy: 'within_product',
        runtimeBillingMode: 'payg_balance',
        routeStrategy: null,
        status: 'active',
        revision: 1,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    }]);
    prisma.productChannel.findMany.mockResolvedValueOnce([]);
    prisma.productChannelGroup.findMany.mockResolvedValueOnce([]);
    prisma.routeAssignment.findMany.mockResolvedValueOnce([]);

    await service.syncOpsTopologyFresh();

    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'admin',
      method: 'POST',
      path: '/admin/api/v1/providers:from-intent',
      resourceType: 'runtime_intent',
      body: expect.objectContaining({
        provider_endpoints: [],
        provider_credentials: [],
        client_exposures: [],
        model_routes: [],
        product_policies: [],
        product_policy_deletes: [{
          product_id: 'prod-empty',
          revision: 1731494400123456,
        }],
      }),
    }));
    expect(syncJobs.dispatchDetailed).toHaveBeenCalledTimes(1);
  });

  it('returns DISABLED without building or dispatching RuntimeIntent during the migration window', async () => {
    const { service, publisher, prisma, syncJobs } = makeService();
    (publisher as any).isExplicitlyDisabled = jest.fn().mockReturnValue(true);

    await expect(service.syncOpsTopologyFreshDetailed()).resolves.toEqual({
      accepted: false,
      status: 'DISABLED',
      idempotencyKey: 'publisher-disabled:runtime-intent',
      error: 'Publisher RuntimeIntent delivery is explicitly disabled',
    });

    expect(prisma.product.findMany).not.toHaveBeenCalled();
    expect(syncJobs.dispatchDetailed).not.toHaveBeenCalled();
  });

  it('rejects required RuntimeIntent delivery before building while explicitly disabled', async () => {
    const { service, publisher, prisma, syncJobs } = makeService();
    (publisher as any).isExplicitlyDisabled = jest.fn().mockReturnValue(true);

    await expect(service.syncOpsTopologyFreshRequired())
      .rejects.toThrow('受控迁移窗口中关闭');

    expect(prisma.product.findMany).not.toHaveBeenCalled();
    expect(syncJobs.dispatchRequired).not.toHaveBeenCalled();
  });

  it('replays RuntimeIntent with product_policy_deletes when the product is deleted locally', async () => {
    const { service, syncJobs, prisma } = makeService();
    const deletedAt = new Date('2026-01-02T00:00:00.000Z');
    prisma.product.findFirst.mockResolvedValueOnce({
      id: 'prod-deleted',
      deletedAt,
      runtimePolicy: { id: 'policy-deleted' },
    });
    syncJobs.dispatchDetailed.mockResolvedValueOnce({
      accepted: true,
      status: 'ACCEPTED',
      idempotencyKey: 'rd:admin:intent',
    });

    const result = await service.syncRuntimeIntentAfterProductPolicyChangeDetailed('prod-deleted');

    expect(result).toEqual(expect.objectContaining({
      accepted: true,
      status: 'ACCEPTED',
      idempotencyKey: 'rd:admin:intent',
    }));
    expect(syncJobs.dispatchDetailed).toHaveBeenCalledTimes(1);
    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'admin',
      method: 'POST',
      path: '/admin/api/v1/providers:from-intent',
      resourceType: 'runtime_intent',
      resourceId: 'default',
      body: expect.objectContaining({
        product_policy_deletes: [{
          product_id: 'prod-deleted',
          revision: 1731494400123456,
        }],
      }),
    }));
    expect(syncJobs.dispatchRequired).not.toHaveBeenCalled();
    expect(prisma.product.findMany).toHaveBeenCalledTimes(1);
  });

  it('publishes channelized RuntimeIntent with shared upstream credentials and full route graph', async () => {
    const { service, syncJobs, prisma } = makeService();
    const runtimePolicy = {
      id: 'policy-coding',
      productId: 'prod_coding',
      credentialSource: 'keypool',
      allowedProviderIds: [],
      allowedChannelIds: [],
      modelScopeMode: 'plan_configured',
      allowedModels: [],
      fallbackPolicy: 'within_product',
      runtimeBillingMode: 'token_plan_quota',
      routeStrategy: null,
      protocolStrategy: 'passthrough_only',
      allowHighLossBridgeWhenNoNative: true,
      allowBridgeOnNativeFailure: false,
      highLossBridgeReason: 'coding quality gate',
      highLossBridgeOwner: 'platform-ops',
      highLossBridgeExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
      highLossBridgeApproval: 'approval-123',
      status: 'active',
      revision: 3,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    const product = {
      id: 'prod_coding',
      slug: 'coding',
      name: 'Coding',
      runtimePolicy,
    };
    const channel = {
      id: 'kimi-main',
      name: 'Kimi main',
      provider: 'moonshot',
      baseUrl: 'https://api.moonshot.cn/v1',
      sdkType: 'openai_completions',
      providerProfile: 'openai_compatible',
      clientCompatibility: JSON.stringify(['claude_code', 'openai_sdk']),
      tokenCountStrategy: null,
      ownedBy: 'moonshot-enterprise-line',
      providerAccountIdentity: {
        ref: 'pa_kimi_enterprise',
        providerCode: 'kimi',
        status: 'active',
      },
      apiKeyEncrypted: encrypt('sk-kimi-shared', ENCRYPTION_KEY),
      models: JSON.stringify(['kimi-k2.6']),
      modelConfigs: JSON.stringify({
        'kimi-k2.6': {
          upstreamModelId: 'moonshot/kimi-k2.6',
          protocolStrategyOverride: 'passthrough_only',
          protocolStrategyOverrideReason: 'Native endpoint rollout protection',
          protocolStrategyOverrideOwner: 'platform-runtime',
          protocolStrategyOverrideExpiresAt: '2099-01-01T00:00:00.000Z',
        },
      }),
      isActive: true,
      status: 'active',
      priority: 1,
      weight: 100,
      maxRpm: null,
      maxTpm: null,
      deletedAt: null,
    };
    const pc101 = {
      id: '101',
      productId: 'prod_coding',
      channelId: 'kimi-main',
      displayName: 'Kimi coding primary',
      status: 'active',
      isDefault: true,
      allowedModels: ['kimi-k2.6'],
      deniedModels: [],
      priority: 1,
      weight: 100,
      maxRpm: 500,
      maxTpm: 100_000,
      metadata: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      deletedAt: null,
      channel,
    };
    const pc102 = {
      ...pc101,
      id: '102',
      displayName: 'Kimi coding fallback',
      isDefault: false,
      priority: 2,
      weight: 50,
      maxRpm: 200,
      maxTpm: 50_000,
    };
    prisma.product.findMany.mockResolvedValueOnce([product]);
    prisma.productChannel.findMany.mockResolvedValueOnce([pc101, pc102]);
    prisma.productChannelGroup.findMany.mockResolvedValueOnce([
      {
        id: 'grp-default',
        productId: 'prod_coding',
        code: 'default',
        name: 'Default',
        description: null,
        strategy: 'weighted_failover',
        isDefault: true,
        status: 'active',
        metadata: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        deletedAt: null,
        members: [
          {
            id: 'member-101',
            groupId: 'grp-default',
            productChannelId: '101',
            priority: 1,
            weight: 100,
            role: 'primary',
            maxRpm: 450,
            maxTpm: 90_000,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            updatedAt: new Date('2026-01-01T00:00:00.000Z'),
            productChannel: pc101,
          },
          {
            id: 'member-102',
            groupId: 'grp-default',
            productChannelId: '102',
            priority: 2,
            weight: 50,
            role: 'fallback',
            maxRpm: null,
            maxTpm: null,
            createdAt: new Date('2026-01-01T00:00:00.000Z'),
            updatedAt: new Date('2026-01-01T00:00:00.000Z'),
            productChannel: pc102,
          },
        ],
      },
    ]);
    prisma.routeAssignment.findMany.mockResolvedValueOnce([
      {
        id: 'asg-vip',
        productId: 'prod_coding',
        subjectType: 'USER_SEGMENT',
        subjectId: 'seg_vip',
        modelPattern: 'kimi-*',
        clientCompatibility: 'claude_code',
        targetType: 'PRODUCT_CHANNEL',
        targetId: '101',
        mode: 'PREFER',
        priority: 10,
        startsAt: null,
        endsAt: null,
        isActive: true,
        reason: null,
        metadata: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    ]);
    await service.syncOpsTopologyFresh();

    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'admin',
      method: 'POST',
      path: '/admin/api/v1/providers:from-intent',
      resourceType: 'runtime_intent',
      resourceId: 'default',
      idempotencyKey: expect.stringMatching(/^rd:replay:/),
    }));
    const body = syncJobs.dispatchDetailed.mock.calls[0][0].body as PublisherRuntimeIntent;
    expect(body.schema_version).toBe(2);
    expect(body.provider_endpoints).toEqual([
      expect.objectContaining({
        id: 'pc_101',
        code: 'kimi-main',
        owned_by: 'moonshot-enterprise-line',
        provider_profile: 'openai_compatible',
        base_url: 'https://api.moonshot.cn',
        path_prefix: '/v1',
      }),
      expect.objectContaining({
        id: 'pc_102',
        code: 'kimi-main',
        owned_by: 'moonshot-enterprise-line',
      }),
    ]);
    expect(body.provider_credentials).toEqual([
      expect.objectContaining({
        provider_id: 'pc_101',
        key_ref: expect.stringMatching(/^enc:local:/),
        provider_account_ref: 'pa_kimi_enterprise',
        status: 'enabled',
        rpm_limit: 500,
        tpm_limit: 100_000,
        allowed_models: ['kimi-k2.6'],
      }),
      expect.objectContaining({
        provider_id: 'pc_102',
        key_ref: expect.stringMatching(/^enc:local:/),
        provider_account_ref: 'pa_kimi_enterprise',
        status: 'enabled',
        rpm_limit: 200,
        tpm_limit: 50_000,
      }),
    ]);
    expect(body.provider_credentials?.[0].key_ref).toBe(body.provider_credentials?.[1].key_ref);
    expect(body.client_exposures).toContainEqual(expect.objectContaining({
      provider_id: 'pc_101',
      served_inbound_protocols: ['openai', 'responses', 'anthropic'],
      capabilities: ['chat'],
    }));
    expect(body.model_routes).toEqual([
      {
        capabilities: ['chat'],
        logical_model: 'kimi-k2.6',
        routes: [
          expect.objectContaining({
            provider_id: 'pc_101',
            upstream_model: 'moonshot/kimi-k2.6',
            priority: 1,
            weight: 100,
            capabilities: ['chat'],
          }),
          expect.objectContaining({
            provider_id: 'pc_102',
            upstream_model: 'moonshot/kimi-k2.6',
            priority: 2,
            weight: 50,
          }),
        ],
      },
    ]);
    expect(body.model_routes?.[0]?.routes[0]).not.toHaveProperty('protocol_strategy_override');
    expect(body.product_policies).toEqual([
      expect.objectContaining({
        product_id: 'prod_coding',
        revision: 1731494400123456,
        product_slug: 'coding',
        allow_high_loss_bridge_when_no_native: true,
        allow_bridge_on_native_failure: false,
        allowed_provider_ids: ['pc_101', 'pc_102'],
        allowed_channel_ids: ['kimi-main'],
        allowed_models: ['kimi-k2.6'],
        route_graph_required: true,
        route_graph_enforcement: 'enforce',
        route_graph: expect.objectContaining({
          schema_version: 1,
          default_target: { target_type: 'GROUP', target_id: 'grp-default' },
          product_channels: [
            expect.objectContaining({
              id: 'pc_101',
              channel_id: 'kimi-main',
              provider_id: 'pc_101',
              allowed_models: ['kimi-k2.6'],
              denied_models: [],
              priority: 1,
              weight: 100,
              max_rpm: 500,
              max_tpm: 100_000,
              status: 'active',
            }),
            expect.objectContaining({
              id: 'pc_102',
              channel_id: 'kimi-main',
              provider_id: 'pc_102',
              allowed_models: ['kimi-k2.6'],
              denied_models: [],
              priority: 2,
              weight: 50,
              max_rpm: 200,
              max_tpm: 50_000,
              status: 'active',
            }),
          ],
          groups: [
            expect.objectContaining({
              id: 'grp-default',
              code: 'default',
              status: 'active',
              strategy: 'weighted_failover',
              members: [
                expect.objectContaining({
                  product_channel_id: 'pc_101',
                  channel_id: 'kimi-main',
                  provider_id: 'pc_101',
                  priority: 1,
                  weight: 100,
                  role: 'primary',
                  max_rpm: 450,
                  max_tpm: 90_000,
                }),
                expect.objectContaining({
                  product_channel_id: 'pc_102',
                  channel_id: 'kimi-main',
                  provider_id: 'pc_102',
                  priority: 2,
                  weight: 50,
                  role: 'fallback',
                }),
              ],
            }),
          ],
          assignments: [
            expect.objectContaining({
              id: 'asg-vip',
              product_id: 'prod_coding',
              subject_type: 'USER_SEGMENT',
              subject_id: 'seg_vip',
              model_pattern: 'kimi-*',
              client_compatibility: 'claude_code',
              target_type: 'PRODUCT_CHANNEL',
              target_id: 'pc_101',
              mode: 'PREFER',
              priority: 10,
            }),
          ],
        }),
      }),
    ]);
    expect(body.product_policies?.[0]).not.toHaveProperty('protocol_strategy');
    expect(body.product_policies?.[0]?.route_graph_enforcement).toBe('enforce');
  });

  it('ignores orphan product channels that are not referenced by the route graph', async () => {
    const { service, syncJobs, prisma } = makeService();
    const runtimePolicy = {
      id: 'policy-payg',
      productId: 'prod-payg',
      credentialSource: 'keypool',
      allowedProviderIds: [],
      allowedChannelIds: [],
      modelScopeMode: 'product_allowlist',
      allowedModels: [],
      fallbackPolicy: 'within_product',
      runtimeBillingMode: 'payg_balance',
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
    };
    const validChannel = {
      id: 'glm-anthropic',
      name: 'GLM Anthropic',
      provider: 'zhipu',
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      sdkType: 'anthropic',
      providerProfile: 'anthropic_native',
      clientCompatibility: JSON.stringify(['all']),
      tokenCountStrategy: 'native',
      ownedBy: 'zhipu',
      dedicatedClientProtocol: null,
      dedicatedProtocolStrategy: null,
      providerAccountIdentity: {
        ref: 'pa_zhipu_anthropic',
        providerCode: 'zhipu',
        status: 'active',
      },
      apiKeyEncrypted: encrypt('sk-valid', ENCRYPTION_KEY),
      models: JSON.stringify(['glm-5.2']),
      modelConfigs: null,
      isActive: true,
      status: 'active',
      priority: 1,
      weight: 100,
      maxRpm: null,
      maxTpm: null,
      successRate: 1,
      totalReqs: 0,
      totalErrs: 0,
      avgLatencyMs: null,
      remark: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      deletedAt: null,
    };
    const orphanChannel = {
      ...validChannel,
      id: 'kimi-anthropic-empty',
      name: 'Kimi Anthropic empty',
      provider: 'kimi',
      baseUrl: 'https://api.moonshot.ai/anthropic',
      ownedBy: 'kimi',
      apiKeyEncrypted: encrypt('sk-orphan', ENCRYPTION_KEY),
      models: JSON.stringify([]),
    };
    const routedPc = {
      id: 'pc-routed',
      productId: 'prod-payg',
      channelId: validChannel.id,
      displayName: 'GLM routed',
      status: 'active',
      isDefault: true,
      allowedModels: null,
      deniedModels: null,
      priority: 1,
      weight: 100,
      maxRpm: null,
      maxTpm: null,
      metadata: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      deletedAt: null,
      channel: validChannel,
    };
    const orphanPc = {
      ...routedPc,
      id: 'pc-orphan',
      channelId: orphanChannel.id,
      displayName: 'Kimi orphan',
      channel: orphanChannel,
    };
    prisma.product.findMany.mockResolvedValueOnce([{
      id: 'prod-payg',
      slug: 'payg',
      name: 'PAYG',
      runtimePolicy,
    }]);
    prisma.productChannel.findMany.mockResolvedValueOnce([routedPc, orphanPc]);
    prisma.productChannelGroup.findMany.mockResolvedValueOnce([{
      id: 'grp-default',
      productId: 'prod-payg',
      code: 'default',
      name: 'Default',
      description: null,
      strategy: 'weighted_failover',
      isDefault: true,
      status: 'active',
      metadata: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      deletedAt: null,
      members: [{
        id: 'member-routed',
        groupId: 'grp-default',
        productChannelId: routedPc.id,
        priority: 1,
        weight: 100,
        role: 'primary',
        maxRpm: null,
        maxTpm: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        productChannel: routedPc,
      }],
    }]);
    prisma.routeAssignment.findMany.mockResolvedValueOnce([]);

    await service.syncOpsTopologyFresh();

    const body = syncJobs.dispatchDetailed.mock.calls[0][0].body as PublisherRuntimeIntent;
    expect((body.provider_endpoints ?? []).map((endpoint) => endpoint.id)).toEqual(['pc_pc-routed']);
    expect(body.provider_credentials?.map((credential) => credential.provider_id)).toEqual(['pc_pc-routed']);
    expect(body.client_exposures).toEqual([
      expect.objectContaining({
        provider_id: 'pc_pc-routed',
        served_inbound_protocols: ['anthropic'],
        token_count_strategy: 'native',
      }),
    ]);
    expect(body.product_policies?.[0]?.allowed_provider_ids).toEqual(['pc_pc-routed']);
    expect(body.product_policies?.[0]?.route_graph?.product_channels.map((pc) => pc.id)).toEqual(['pc_pc-routed']);
  });

  it('keeps provider_account_ref stable when a channel credential rotates', () => {
    const { service } = makeService();
    const productChannel = (apiKey: string) => ({
      id: 'kimi-primary',
      channelId: 'kimi-main',
      status: 'active',
      priority: 1,
      weight: 100,
      maxRpm: null,
      maxTpm: null,
      channel: {
        id: 'kimi-main',
        name: 'Kimi main',
        provider: 'moonshot',
        baseUrl: 'https://api.moonshot.cn/v1',
        apiKeyEncrypted: encrypt(apiKey, ENCRYPTION_KEY),
        providerAccountIdentity: {
          ref: 'pa_kimi_enterprise',
          providerCode: 'kimi',
          status: 'active',
        },
        isActive: true,
        status: 'active',
      },
    });

    const before = (service as any).buildProviderCredentialIntent(
      'pc_kimi-primary',
      productChannel('sk-kimi-before'),
      ['kimi-k2.6'],
    );
    const after = (service as any).buildProviderCredentialIntent(
      'pc_kimi-primary',
      productChannel('sk-kimi-after'),
      ['kimi-k2.6'],
    );

    expect(before.provider_account_ref).toBe('pa_kimi_enterprise');
    expect(after.provider_account_ref).toBe(before.provider_account_ref);
    expect(after.key_ref).not.toBe(before.key_ref);
  });

  it.each([
    ['missing', null, '供应商账户身份不存在'],
    ['inactive', { ref: 'pa_kimi_enterprise', providerCode: 'kimi', status: 'inactive' }, '供应商账户身份已停用'],
    ['provider mismatch', { ref: 'pa_openai_main', providerCode: 'openai', status: 'active' }, '与供应商 kimi 不匹配'],
    ['invalid ref', { ref: 'invalid ref', providerCode: 'kimi', status: 'active' }, 'provider_account_ref 格式不合法'],
    ['provider id reuse', { ref: 'pc_kimi-primary', providerCode: 'kimi', status: 'active' }, '不能复用凭据或路由标识'],
    ['provider code reuse', { ref: 'kimi', providerCode: 'kimi', status: 'active' }, '不能复用凭据或路由标识'],
  ])('rejects %s provider account identity before RuntimeIntent dispatch', (_case, identity, expectedError) => {
    const { service } = makeService();
    const productChannel = {
      id: 'kimi-primary',
      channelId: 'kimi-main',
      status: 'active',
      priority: 1,
      weight: 100,
      maxRpm: null,
      maxTpm: null,
      channel: {
        id: 'kimi-main',
        name: 'Kimi main',
        provider: 'moonshot',
        baseUrl: 'https://api.moonshot.cn/v1',
        apiKeyEncrypted: encrypt('sk-kimi', ENCRYPTION_KEY),
        providerAccountIdentity: identity,
        isActive: true,
        status: 'active',
      },
    };

    expect(() => (service as any).buildProviderCredentialIntent(
      'pc_kimi-primary',
      productChannel,
      ['kimi-k2.6'],
    )).toThrow(expectedError);
  });

  it('rejects a provider_account_ref copied from key_ref', () => {
    const { service } = makeService();
    const keyRef = 'enc:CiCexampleCiphertext';

    expect(() => (service as any).buildProviderCredentialIntent(
      'pc_kimi-primary',
      {
        id: 'kimi-primary',
        channelId: 'kimi-main',
        status: 'active',
        priority: 1,
        weight: 100,
        maxRpm: null,
        maxTpm: null,
        channel: {
          id: 'kimi-main',
          name: 'Kimi main',
          provider: 'kimi',
          baseUrl: 'https://api.moonshot.cn/v1',
          apiKeyEncrypted: keyRef,
          providerAccountIdentity: {
            ref: keyRef,
            providerCode: 'kimi',
            status: 'active',
          },
          isActive: true,
          status: 'active',
        },
      },
      ['kimi-k2.6'],
    )).toThrow('provider_account_ref 不能复用凭据或路由标识');
  });

  it('does not derive client exposure protocols from legacy client compatibility', () => {
    const { service } = makeService();

    const exposure = (service as any).buildClientExposureIntent('pc_pc-routed', {
      id: 'pc-routed',
      metadata: null,
      channel: {
        provider: 'openai',
        sdkType: 'openai_compatible',
        providerProfile: 'openai_compatible',
        clientCompatibility: JSON.stringify(['codex']),
        servedInboundProtocols: null,
        tokenCountStrategy: null,
      },
    });

    expect(exposure).toEqual(expect.objectContaining({
      provider_id: 'pc_pc-routed',
      served_inbound_protocols: ['openai', 'responses', 'anthropic'],
      capabilities: ['chat'],
    }));
  });

  it('filters inactive ModelPricing entries out of RuntimeIntent routes and route_graph', async () => {
    const { service, syncJobs, prisma } = makeService();
    const runtimePolicy = {
      id: 'policy-coding',
      productId: 'prod_coding',
      credentialSource: 'keypool',
      allowedProviderIds: [],
      allowedChannelIds: [],
      modelScopeMode: 'plan_configured',
      allowedModels: [],
      fallbackPolicy: 'within_product',
      runtimeBillingMode: 'token_plan_quota',
      routeStrategy: null,
      protocolStrategy: 'passthrough_only',
      allowHighLossBridgeWhenNoNative: true,
      allowBridgeOnNativeFailure: false,
      highLossBridgeReason: 'coding quality gate',
      highLossBridgeOwner: 'platform-ops',
      highLossBridgeExpiresAt: new Date('2099-01-01T00:00:00.000Z'),
      highLossBridgeApproval: 'approval-123',
      status: 'active',
      revision: 3,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    const channel = {
      id: 'glm-main',
      name: 'GLM main',
      provider: 'zhipu',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      sdkType: 'openai_completions',
      providerProfile: 'openai_compatible',
      clientCompatibility: JSON.stringify(['openai_sdk']),
      tokenCountStrategy: null,
      ownedBy: 'zhipu',
      providerAccountIdentity: {
        ref: 'pa_zhipu_main',
        providerCode: 'zhipu',
        status: 'active',
      },
      apiKeyEncrypted: encrypt('sk-glm', ENCRYPTION_KEY),
      models: JSON.stringify(['glm-5.1', 'glm-5.2']),
      modelConfigs: null,
      isActive: true,
      status: 'active',
      priority: 1,
      weight: 100,
      maxRpm: null,
      maxTpm: null,
      deletedAt: null,
    };
    const productChannel = {
      id: 'pc-glm',
      productId: 'prod_coding',
      channelId: 'glm-main',
      displayName: 'GLM coding',
      status: 'active',
      isDefault: true,
      allowedModels: ['glm-5.1', 'glm-5.2'],
      deniedModels: [],
      priority: 1,
      weight: 100,
      maxRpm: null,
      maxTpm: null,
      metadata: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      deletedAt: null,
      channel,
    };

    prisma.modelPricing.findMany.mockResolvedValueOnce([
      { modelName: 'glm-5.1', isActive: true },
      { modelName: 'glm-5.2', isActive: false },
    ]);
    prisma.product.findMany.mockResolvedValueOnce([{
      id: 'prod_coding',
      slug: 'coding',
      name: 'Coding',
      runtimePolicy,
    }]);
    prisma.productChannel.findMany.mockResolvedValueOnce([productChannel]);
    prisma.productChannelGroup.findMany.mockResolvedValueOnce([]);
    prisma.routeAssignment.findMany.mockResolvedValueOnce([]);

    await service.syncOpsTopologyFresh();

    const body = syncJobs.dispatchDetailed.mock.calls[0][0].body as PublisherRuntimeIntent;
    expect((body.model_routes ?? []).map((route) => route.logical_model)).toEqual(['glm-5.1']);
    expect(body.provider_credentials?.[0]).toEqual(expect.objectContaining({
      allowed_models: ['glm-5.1'],
    }));
    expect(body.product_policies?.[0]).toEqual(expect.objectContaining({
      allowed_models: ['glm-5.1'],
    }));
    expect(body.product_policies?.[0]?.route_graph?.product_channels?.[0]).toEqual(expect.objectContaining({
      allowed_models: ['glm-5.1'],
    }));
  });

  it('publishes dedicated-only ProductChannel provider without ordinary routes or keypool credentials', async () => {
    const { service, syncJobs, prisma } = makeService();
    const runtimePolicy = {
      id: 'policy-coding',
      productId: 'prod_coding',
      credentialSource: 'keypool',
      modelScopeMode: 'product_allowlist',
      allowedModels: ['glm-4.5'],
      allowedProviderIds: [],
      allowedChannelIds: [],
      runtimeBillingMode: 'token_plan_quota',
      routeStrategy: null,
      fallbackPolicy: 'none',
      protocolStrategy: 'passthrough_only',
      allowHighLossBridgeWhenNoNative: false,
      allowBridgeOnNativeFailure: false,
      status: 'active',
      revision: 3,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
    };
    const routedChannel = {
      id: 'glm-route',
      name: 'GLM route',
      provider: 'zhipu',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      sdkType: 'openai_completions',
      providerProfile: 'openai_compatible',
      clientCompatibility: JSON.stringify(['openai_sdk']),
      tokenCountStrategy: null,
      ownedBy: 'zhipu',
      providerAccountIdentity: {
        ref: 'pa_zhipu_main',
        providerCode: 'zhipu',
        status: 'active',
      },
      apiKeyEncrypted: encryptGatewayLocalSecret('route-key', ENCRYPTION_KEY),
      models: JSON.stringify(['glm-4.5']),
      modelConfigs: null,
      isActive: true,
      status: 'active',
      priority: 1,
      weight: 100,
      maxRpm: null,
      maxTpm: null,
      deletedAt: null,
    };
    const dedicatedChannel = {
      ...routedChannel,
      id: 'zhipu-dedicated',
      name: 'Zhipu dedicated',
      apiKeyEncrypted: encryptGatewayLocalSecret('unused-platform-key', ENCRYPTION_KEY),
    };
    const routedPc = {
      id: 'route',
      productId: 'prod_coding',
      channelId: 'glm-route',
      displayName: 'GLM ordinary route',
      status: 'active',
      isDefault: true,
      allowedModels: ['glm-4.5'],
      deniedModels: [],
      priority: 1,
      weight: 100,
      maxRpm: null,
      maxTpm: null,
      metadata: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      deletedAt: null,
      channel: routedChannel,
    };
    const dedicatedPc = {
      id: 'zhipu-line',
      productId: 'prod_coding',
      channelId: 'zhipu-dedicated',
      displayName: 'Zhipu dedicated route',
      status: 'active',
      isDefault: false,
      allowedModels: ['glm-4.5'],
      deniedModels: [],
      priority: 100,
      weight: 1,
      maxRpm: null,
      maxTpm: null,
      metadata: {
        provider_isolation: {
          visibility: 'dedicated_only',
          credential_source: 'dedicated_upstream',
          allowed_route_kinds: ['dedicated_route'],
          owner_scope: { product_id: 'prod_coding' },
        },
      },
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      deletedAt: null,
      channel: dedicatedChannel,
    };

    prisma.product.findMany.mockResolvedValueOnce([{
      id: 'prod_coding',
      slug: 'coding',
      name: 'Coding',
      runtimePolicy,
    }]);
    prisma.productChannel.findMany.mockResolvedValueOnce([routedPc, dedicatedPc]);
    prisma.productChannelGroup.findMany.mockResolvedValueOnce([]);
    prisma.routeAssignment.findMany.mockResolvedValueOnce([]);

    await service.syncOpsTopologyFresh();

    const body = syncJobs.dispatchDetailed.mock.calls[0][0].body as PublisherRuntimeIntent;
    expect(body.provider_endpoints).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'pc_zhipu-line',
        visibility: 'dedicated_only',
        credential_source: 'dedicated_upstream',
        allowed_route_kinds: ['dedicated_route'],
        owner_scope: { product_id: 'prod_coding' },
      }),
    ]));
    expect(body.client_exposures).toEqual(expect.arrayContaining([
      expect.objectContaining({ provider_id: 'pc_zhipu-line' }),
    ]));
    expect(body.provider_credentials?.map((item) => item.provider_id)).toEqual(['pc_route']);
    expect(body.model_routes?.flatMap((route) => route.routes.map((item) => item.provider_id)))
      .toEqual(['pc_route']);
    expect(body.product_policies?.[0]).toEqual(expect.objectContaining({
      allowed_provider_ids: ['pc_route'],
    }));
    expect(validateRuntimeIntent(body)).toBe(true);
  });

  it('drops retired route protocol strategy overrides from model config', () => {
    const { service } = makeService();
    const config = (service as any).modelConfigFor(
      {
        modelConfigs: JSON.stringify({
          'glm-5.1': {
            protocolStrategyOverride: 'passthrough_only',
            protocolStrategyOverrideReason: 'Temporary native endpoint guard',
            protocolStrategyOverrideOwner: 'platform-runtime',
            protocolStrategyOverrideExpiresAt: '2020-01-01T00:00:00.000Z',
          },
        }),
      },
      'glm-5.1',
    );

    expect(config.protocolStrategyOverride).toBeUndefined();
    expect(config.protocolStrategyOverrideReason).toBeUndefined();
    expect(config.protocolStrategyOverrideOwner).toBeUndefined();
    expect(config.protocolStrategyOverrideExpiresAt).toBeUndefined();
  });

  it('rejects invalid product runtime policy enum values instead of defaulting them', async () => {
    const { service, syncJobs, prisma } = makeService();
    const channel = {
      id: 'ch-invalid-policy',
      name: 'Invalid policy channel',
      provider: 'openai',
      baseUrl: 'https://api.example.test/v1',
      sdkType: 'openai_compatible',
      providerProfile: 'openai_compatible',
      clientCompatibility: JSON.stringify(['all']),
      tokenCountStrategy: null,
      ownedBy: null,
      providerAccountIdentity: {
        ref: 'pa_openai_invalid_policy',
        providerCode: 'openai',
        status: 'active',
      },
      apiKeyEncrypted: encrypt('sk-invalid-policy', ENCRYPTION_KEY),
      models: JSON.stringify(['gpt-4o']),
      modelConfigs: null,
      maxRpm: null,
      maxTpm: null,
      isActive: true,
      status: 'active',
      deletedAt: null,
    };
    prisma.product.findMany.mockResolvedValueOnce([{
      id: 'prod-invalid-policy',
      slug: 'invalid-policy',
      name: 'Invalid Policy',
      runtimePolicy: {
        id: 'policy-invalid',
        productId: 'prod-invalid-policy',
        status: 'active',
        credentialSource: 'legacy_pool',
        modelScopeMode: 'plan_configured',
        allowedModels: [],
        allowedProviderIds: [],
        allowedChannelIds: [],
        runtimeBillingMode: 'payg_balance',
        routeStrategy: null,
        fallbackPolicy: 'none',
        protocolStrategy: 'auto',
        revision: 1,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    }]);
    prisma.productChannel.findMany.mockResolvedValueOnce([{
      id: 'pc-invalid-policy',
      productId: 'prod-invalid-policy',
      channelId: 'ch-invalid-policy',
      displayName: 'Invalid policy route',
      status: 'active',
      isDefault: true,
      allowedModels: null,
      deniedModels: null,
      priority: 1,
      weight: 100,
      maxRpm: null,
      maxTpm: null,
      metadata: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      deletedAt: null,
      channel,
    }]);
    prisma.productChannelGroup.findMany.mockResolvedValueOnce([]);
    prisma.routeAssignment.findMany.mockResolvedValueOnce([]);

    await expect(service.syncOpsTopologyFresh())
      .rejects
      .toThrow('ProductRuntimePolicy.credentialSource 非法: legacy_pool');
    expect(syncJobs.dispatchDetailed).not.toHaveBeenCalled();
  });

  it('omits route graph when a product has no enabled product channels', async () => {
    const { service, syncJobs, prisma } = makeService();
    const product = {
      id: 'prod-resale',
      slug: 'codingplan-resale',
      name: 'CodingPlan Resale',
      runtimePolicy: {
        id: 'policy-resale',
        productId: 'prod-resale',
        status: 'active',
        credentialSource: 'dedicated_upstream',
        modelScopeMode: 'upstream_inherited',
        allowedModels: [],
        allowedProviderIds: [],
        allowedChannelIds: [],
        runtimeBillingMode: 'included_upstream',
        routeStrategy: 'priority',
        fallbackPolicy: 'none',
        revision: 1,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      },
    };
    const channel = {
      id: 'ch-disabled',
      provider: 'openai',
      name: 'Disabled OpenAI-compatible',
      baseUrl: 'https://api.example.test/v1',
      sdkType: 'openai_compatible',
      providerProfile: null,
      clientCompatibility: null,
      tokenCountStrategy: null,
      ownedBy: null,
      models: JSON.stringify(['glm-5']),
      modelMetadata: null,
      providerAccountIdentity: {
        ref: 'pa_openai_disabled',
        providerCode: 'openai',
        status: 'active',
      },
      apiKeyEncrypted: encryptGatewayLocalSecret('disabled-key', ENCRYPTION_KEY),
      isActive: true,
      status: 'active',
      deletedAt: null,
    };
    prisma.product.findMany.mockResolvedValueOnce([product]);
    prisma.productChannel.findMany.mockResolvedValueOnce([
      {
        id: 'pc-disabled',
        productId: 'prod-resale',
        channelId: 'ch-disabled',
        displayName: 'Disabled route',
        status: 'disabled',
        isDefault: true,
        allowedModels: null,
        deniedModels: null,
        priority: 100,
        weight: 100,
        maxRpm: null,
        maxTpm: null,
        metadata: null,
        createdAt: new Date('2026-01-01T00:00:00.000Z'),
        updatedAt: new Date('2026-01-01T00:00:00.000Z'),
        deletedAt: null,
        channel,
      },
    ]);
    prisma.productChannelGroup.findMany.mockResolvedValueOnce([]);
    prisma.routeAssignment.findMany.mockResolvedValueOnce([]);

    await service.syncOpsTopologyFresh();

    const body = syncJobs.dispatchDetailed.mock.calls[0][0].body as PublisherRuntimeIntent;
    expect(body.product_policies).toEqual([
      expect.objectContaining({
        product_id: 'prod-resale',
        allowed_provider_ids: [],
        allowed_channel_ids: [],
        allowed_models: [],
      }),
    ]);
    expect(body.product_policies?.[0]).not.toHaveProperty('route_graph');
    expect(body.product_policies?.[0]).not.toHaveProperty('route_graph_required');
    expect(body.product_policies?.[0]).not.toHaveProperty('route_graph_enforcement');
  });

  it('does not publish Runtime Providers from CodingPlan provider lines', async () => {
    const { service, syncJobs, prisma } = makeService();
    prisma.product.findMany.mockResolvedValueOnce([]);

    await service.syncOpsTopologyFresh();

    const body = syncJobs.dispatchDetailed.mock.calls[0][0].body as PublisherRuntimeIntent;
    expect(prisma.codingPlanProviderLine.findMany).not.toHaveBeenCalled();
    expect(body.provider_endpoints).toEqual([]);
    expect(body.client_exposures).toEqual([]);
    expect(body.model_routes).toEqual([]);
    expect(validateRuntimeIntent(body)).toBe(true);
  });

  it('suspends provider-resale keys when dedicated endpoint includes runtime config', async () => {
    const { syncJobs, redis } = await syncProviderResaleApiKey(providerResaleEntitlementFixture({
      dedicatedEndpoints: legacyZhipuOpenAiDedicatedEndpoints(),
    }), {}, ['pc_zhipu_coding_openai']);

    expectSuspendedProviderResaleKey(syncJobs);
    expect(redis.zrem).toHaveBeenCalledWith('cpq:gated', 'key-dedicated-1');
  });

  it('publishes unprovisioned api keys as suspended with no key balance', async () => {
    const { service, syncJobs, prisma } = makeService();
    prisma.apiKey.findUnique.mockResolvedValue({
      id: '9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      product: { billingMode: 'PAY_AS_YOU_GO' },
      isActive: true,
      mirrorStatus: 'PROVISIONING',
      budgetUsd: null,
      deletedAt: null,
    });

    await service.syncApiKeyMeta({
      id: '9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      product: { slug: 'coding', name: 'Coding' },
      name: 'prod key',
      keyHash: 'b'.repeat(64),
      isActive: true,
      mirrorStatus: 'PROVISIONING',
      allowedModels: null,
      budgetUsd: null,
      deletedAt: null,
    });

    expect(syncJobs.dispatchDetailed).toHaveBeenNthCalledWith(1, expect.objectContaining({
      namespace: 'user',
      method: 'PUT',
      body: expect.objectContaining({ status: 'suspended' }),
    }));
    expect(syncJobs.dispatchDetailed).toHaveBeenNthCalledWith(2, expect.objectContaining({
      namespace: 'billing',
      method: 'DELETE',
      path: '/billing/api/v1/key-balance/9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
      body: {
        decision_id: expect.any(String),
        decision_version: KEY_BALANCE_REVISION,
      },
    }));
  });

  it('retires gateway quota (cpq-*) downloads for self-operated CODING_PLAN keys (quota-v2 §4.1)', async () => {
    const { service, syncJobs, prisma } = makeService();
    // 即便套餐配有滚动配额规则，quota-v2 退役后网关不再下发任何 cpq-* 政策
    // （配额改由 billing 侧 A 前置 BalanceGate 执行）。
    prisma.subscriptionPeriod.findFirst.mockResolvedValue({
      plan: {
        features: '[]',
        product: { billingMode: 'CODING_PLAN' },
        quotaRules: [
          {
            template: {
              isActive: true,
              deletedAt: null,
              rules: JSON.stringify([
                { windowType: 'ROLLING', durationSec: 21600, metric: 'REQUESTS', limitValue: 5000 },
                { windowType: 'ROLLING', durationSec: 18000, metric: 'CREDITS', limitValue: 60 },
                { windowType: 'ROLLING', durationSec: 604800, metric: 'CREDITS', limitValue: 70_000 },
              ]),
            },
          },
        ],
      },
    });

    await service.syncApiKeyMeta({
      id: 'key-coding',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      product: { slug: 'coding', name: 'Coding' },
      name: 'coding key',
      keyHash: 'c'.repeat(64),
      isActive: true,
      allowedModels: null,
      budgetUsd: null,
      deletedAt: null,
    });

    const body = syncJobs.dispatchDetailed.mock.calls[0][0].body as Record<string, unknown>;
    const policies = (body.policies ?? []) as Array<Record<string, unknown>>;
    // 不产出任何 cpq-* 配额政策（防"只改谓词、cpq 复燃"）
    expect(policies.some((p) => String(p.policy_id).startsWith('cpq-'))).toBe(false);
  });

  it('publishes provider-resale coding keys with dedicated_upstream and explicit allow admission', async () => {
    const { service, syncJobs, prisma, redis } = makeService();
    const updatedAt = new Date('2026-06-15T00:00:00.000Z');
    const openaiProviderId = 'pc_zhipu_coding_openai';
    prisma.codingPlanEntitlement.findFirst.mockResolvedValue(providerResaleEntitlementFixture());
    mockDedicatedRuntimeProviders(prisma, [openaiProviderId]);

    await service.syncApiKeyMeta({
      id: 'key-dedicated-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-coding',
      codingPlanEntitlementId: 'ent-dedicated-1',
      product: { slug: 'coding', name: 'Coding' },
      name: 'zhipu dedicated key',
      keyHash: 'e'.repeat(64),
      isActive: true,
      mirrorStatus: 'ACTIVE',
      allowedModels: JSON.stringify(['glm-5.2']),
      budgetUsd: null,
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      ipWhitelist: null,
      rateLimitRpm: 60,
      rateLimitTpm: 120000,
      deletedAt: null,
    });

    const putKeyCall = syncJobs.dispatchDetailed.mock.calls.find(([job]) =>
      job.namespace === 'billing' && job.method === 'PUT'
        && job.path === '/billing/api/v1/key-activation/key-dedicated-1',
    );
    expect(putKeyCall).toBeDefined();
    const activation = putKeyCall?.[0].body as Record<string, any>;
    const body = activation.key_meta as Record<string, any>;
    expect(body.dedicated_upstream).toEqual({
      upstream_key_id: 'provider-entitlement-1',
      provider_account_ref: 'pa_zhipu_main',
      ciphertext: expect.stringMatching(/^kms:local:[A-Za-z0-9+/]+=*$/),
      ciphertext_version: updatedAt.getTime(),
      ciphertext_sha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      kms_key_id: expect.stringMatching(/^gateway-local:[a-f0-9]{6}$/),
      status: 'active',
      expires_at: 1893456000,
      updated_at: '2026-06-15T00:00:00.000Z',
      fallback_allowed: false,
      endpoints: [
        {
          client_protocol: 'openai',
          provider_id: openaiProviderId,
          protocol_strategy: 'passthrough',
        },
        {
          client_protocol: 'responses',
          provider_id: openaiProviderId,
          protocol_strategy: 'responses_to_chat',
        },
      ],
    });
    expect(typeof body.dedicated_upstream.ciphertext_version).toBe('number');
    expect(typeof body.dedicated_upstream.updated_at).toBe('string');
    expect(body.dedicated_upstream.provider_id).toBeUndefined();
    expect(decryptGatewayLocalSecret(
      String(body.dedicated_upstream.ciphertext).replace(/^kms:/, 'enc:'),
      ENCRYPTION_KEY,
    )).toBe('api-key-1.secret-key-1');
    expect(mockKmsSend).not.toHaveBeenCalled();
    expect(validateKeyMeta(body)).toBe(true);
    expect(body.policies).toBeUndefined();
    expect(activation).toEqual(expect.objectContaining({
      has_balance: true,
      decision_id: expect.any(String),
      decision_version: KEY_BALANCE_REVISION,
    }));
    expect(syncJobs.dispatchDetailed).toHaveBeenCalledTimes(1);
    expect(redis.zrem).toHaveBeenCalledWith('cpq:gated', 'key-dedicated-1');
  });

  it('publishes provider-resale dedicated_upstream from key-meta-only endpoint config', async () => {
    const { syncJobs } = await syncProviderResaleApiKey(providerResaleEntitlementFixture({
      dedicatedEndpoints: [
        {
          client_protocol: 'openai',
          provider_id: 'pc_runtime_openai',
          protocol_strategy: 'passthrough',
        },
        {
          client_protocol: 'responses',
          provider_id: 'pc_runtime_openai',
        },
      ],
    }), {}, ['pc_runtime_openai']);

    const putKeyCall = syncJobs.dispatchDetailed.mock.calls.find(([job]) =>
      job.namespace === 'billing' && job.method === 'PUT'
        && job.path === '/billing/api/v1/key-activation/key-dedicated-1',
    );
    const body = (putKeyCall?.[0].body as Record<string, any>).key_meta as Record<string, any>;
    expect(body.dedicated_upstream.endpoints).toEqual([
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
    ]);
    expect(validateKeyMeta(body)).toBe(true);
  });

  it.each([
    ['missing', null, '供应商账户身份不存在'],
    ['inactive', { ref: 'pa_zhipu_main', providerCode: 'zhipu', status: 'inactive' }, '供应商账户身份已停用'],
    ['provider mismatch', { ref: 'pa_openai_main', providerCode: 'openai', status: 'active' }, '与供应商 zhipu 不匹配'],
    [
      'upstream key id reuse',
      { ref: 'provider-entitlement-1', providerCode: 'zhipu', status: 'active' },
      '不能复用凭据或路由标识',
    ],
  ])('rejects %s provider account identity before dedicated KeyMeta dispatch', async (
    _case,
    identity,
    expectedError,
  ) => {
    const { service, prisma, syncJobs } = makeService();
    prisma.codingPlanEntitlement.findFirst.mockResolvedValue(providerResaleEntitlementFixture({
      providerEntitlement: { providerAccountIdentity: identity },
    }));
    mockDedicatedRuntimeProviders(prisma, ['pc_zhipu_coding_openai']);

    await expect(service.syncApiKeyMeta(providerResaleApiKeyFixture()))
      .rejects
      .toThrow(expectedError);
    expect(syncJobs.dispatchDetailed).not.toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'user',
      method: 'PUT',
      path: '/user/api/v1/keys',
    }));
  });

  it('rejects a provider entitlement that did not inherit its provider-line identity', async () => {
    const { service, prisma, syncJobs } = makeService();
    prisma.codingPlanEntitlement.findFirst.mockResolvedValue(
      providerResaleEntitlementFixture({
        providerEntitlement: {
          providerAccountIdentityId: 'pai-zhipu-other-account',
        },
      }),
    );
    mockDedicatedRuntimeProviders(prisma, ['pc_zhipu_coding_openai']);

    await expect(service.syncApiKeyMeta(providerResaleApiKeyFixture()))
      .rejects
      .toThrow('Provider Entitlement 的账户身份与供应商线路不一致');
    expect(syncJobs.dispatchDetailed).not.toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'user',
      method: 'PUT',
      path: '/user/api/v1/keys',
    }));
  });

  it('keeps dedicated provider_account_ref stable when upstream credentials rotate', async () => {
    const before = await syncProviderResaleApiKey(
      providerResaleEntitlementFixture(),
      {},
      ['pc_zhipu_coding_openai'],
    );
    const after = await syncProviderResaleApiKey(
      providerResaleEntitlementFixture({
        providerEntitlement: {
          upstreamApiKeyEncrypted: encrypt('api-key-rotated', ENCRYPTION_KEY),
          upstreamSecretKeyEncrypted: encrypt('secret-key-rotated', ENCRYPTION_KEY),
        },
      }),
      {},
      ['pc_zhipu_coding_openai'],
    );
    const dedicatedBody = (context: Awaited<ReturnType<typeof syncProviderResaleApiKey>>) =>
      context.syncJobs.dispatchDetailed.mock.calls.find(([job]) =>
        job.namespace === 'billing' && job.method === 'PUT'
          && job.path === '/billing/api/v1/key-activation/key-dedicated-1',
      )?.[0].body.key_meta as {
        dedicated_upstream: { provider_account_ref?: string; ciphertext: string };
      };

    const beforeDedicated = dedicatedBody(before).dedicated_upstream;
    const afterDedicated = dedicatedBody(after).dedicated_upstream;
    expect(beforeDedicated.provider_account_ref).toBe('pa_zhipu_main');
    expect(afterDedicated.provider_account_ref).toBe(beforeDedicated.provider_account_ref);
    expect(afterDedicated.ciphertext).not.toBe(beforeDedicated.ciphertext);
  });

  it('suspends provider-resale key when key-meta-only endpoint uses bare provider id', async () => {
    const { syncJobs } = await syncProviderResaleApiKey(providerResaleEntitlementFixture({
      dedicatedEndpoints: [
        {
          client_protocol: 'openai',
          provider_id: 'glm-openai',
          protocol_strategy: 'passthrough',
        },
      ],
    }));

    expectSuspendedProviderResaleKey(syncJobs);
  });

  it('suspends provider-resale key when ProductChannel provider line does not match the endpoint line', async () => {
    const { syncJobs } = await syncProviderResaleApiKey(
      providerResaleEntitlementFixture(),
      {},
      [{ providerId: 'pc_zhipu_coding_openai', providerLineId: 'line-other' }],
    );

    expectSuspendedProviderResaleKey(syncJobs);
  });

  it('suspends provider-resale keys when the customer entitlement is not ACTIVE', async () => {
    const { syncJobs, redis } = await syncProviderResaleApiKey(providerResaleEntitlementFixture({
      entitlement: { status: 'CANCELLED' },
    }));

    expectSuspendedProviderResaleKey(syncJobs);
    expect(redis.zrem).toHaveBeenCalledWith('cpq:gated', 'key-dedicated-1');
  });

  it('suspends provider-resale keys when the customer entitlement is expired', async () => {
    const { syncJobs, redis } = await syncProviderResaleApiKey(providerResaleEntitlementFixture({
      entitlement: { expiresAt: new Date('2020-01-01T00:00:00.000Z') },
    }));

    expectSuspendedProviderResaleKey(syncJobs);
    expect(redis.zrem).toHaveBeenCalledWith('cpq:gated', 'key-dedicated-1');
  });

  it('suspends provider-resale keys when the provider entitlement is not ACTIVE', async () => {
    const { syncJobs, redis } = await syncProviderResaleApiKey(providerResaleEntitlementFixture({
      providerEntitlement: { status: 'CANCELLED' },
    }));

    expectSuspendedProviderResaleKey(syncJobs);
    expect(redis.zrem).toHaveBeenCalledWith('cpq:gated', 'key-dedicated-1');
  });

  it('suspends provider-resale keys when the provider entitlement is missing', async () => {
    const { syncJobs, redis } = await syncProviderResaleApiKey(providerResaleEntitlementFixture({
      providerEntitlement: null,
    }));

    expectSuspendedProviderResaleKey(syncJobs);
    expect(redis.zrem).toHaveBeenCalledWith('cpq:gated', 'key-dedicated-1');
  });

  it('suspends provider-resale keys when the provider entitlement is expired', async () => {
    const { syncJobs, redis } = await syncProviderResaleApiKey(providerResaleEntitlementFixture({
      providerEntitlement: { productEndTime: new Date('2020-01-01T00:00:00.000Z') },
    }));

    expectSuspendedProviderResaleKey(syncJobs);
    expect(redis.zrem).toHaveBeenCalledWith('cpq:gated', 'key-dedicated-1');
  });

  it('suspends provider-resale keys when provider credentials are missing', async () => {
    const { syncJobs, redis } = await syncProviderResaleApiKey(providerResaleEntitlementFixture({
      providerEntitlement: { upstreamApiKeyEncrypted: null },
    }));

    expectSuspendedProviderResaleKey(syncJobs);
    expect(redis.zrem).toHaveBeenCalledWith('cpq:gated', 'key-dedicated-1');
  });

  it('suspends provider-resale keys when dedicated endpoints are missing', async () => {
    const { syncJobs, redis } = await syncProviderResaleApiKey(providerResaleEntitlementFixture({
      dedicatedEndpoints: [],
    }));

    expectSuspendedProviderResaleKey(syncJobs);
    expect(redis.zrem).toHaveBeenCalledWith('cpq:gated', 'key-dedicated-1');
  });

  it('suspends provider-resale keys when provider line runtime publishing is disabled', async () => {
    const { syncJobs, redis } = await syncProviderResaleApiKey(providerResaleEntitlementFixture({
      entitlement: {
        providerLine: {
          id: 'line-zhipu',
          code: 'zhipu_overseas',
          runtimeEnabled: false,
          dedicatedEndpoints: zhipuOpenAiDedicatedEndpoints(),
        },
      },
    }));

    expectSuspendedProviderResaleKey(syncJobs);
    expect(redis.zrem).toHaveBeenCalledWith('cpq:gated', 'key-dedicated-1');
  });

  it('deletes key-balance during balance replay for invalid provider-resale entitlements', async () => {
    const { service, syncJobs, prisma, redis } = makeService();
    prisma.apiKey.findUnique.mockResolvedValue({
      id: 'key-dedicated-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      tenant: {
        billingAccountId: 'ba_personal_user-1',
        balanceAllowanceUsd: null,
        balanceAllowanceUsedUsd: new Prisma.Decimal(0),
      },
      productId: 'prod-coding',
      product: { billingMode: 'CODING_PLAN' },
      codingPlanEntitlementId: 'ent-dedicated-1',
      budgetUsd: null,
      isActive: true,
      mirrorStatus: 'ACTIVE',
      deletedAt: null,
    });
    prisma.codingPlanEntitlement.findFirst.mockResolvedValue(providerResaleEntitlementFixture({
      entitlement: { expiresAt: new Date('2020-01-01T00:00:00.000Z') },
    }));

    await service.syncKeyBalanceById('key-dedicated-1');

    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'billing',
      method: 'DELETE',
      path: '/billing/api/v1/key-balance/key-dedicated-1',
      body: {
        decision_id: expect.any(String),
        decision_version: KEY_BALANCE_REVISION,
      },
    }));
    expect(syncJobs.dispatchDetailed.mock.calls.some(([job]) =>
      job.namespace === 'billing' && job.method === 'PUT',
    )).toBe(false);
    expect(prisma.accountWallet.findUnique).not.toHaveBeenCalled();
    expect(prisma.tokenUsage.aggregate).not.toHaveBeenCalled();
    expect(redis.zrem).toHaveBeenCalledWith('cpq:gated', 'key-dedicated-1');
  });

  it('builds dedicated_upstream endpoints from provider line fulfillment config', async () => {
    const { service, syncJobs, prisma } = makeService();
    const updatedAt = new Date('2026-06-15T00:00:00.000Z');
    const anthropicProviderId = 'pc_zhipu_coding_anthropic';
    mockDedicatedRuntimeProviders(prisma, [anthropicProviderId]);
    prisma.codingPlanEntitlement.findFirst.mockResolvedValue({
      id: 'ent-dedicated-2',
      status: 'ACTIVE',
      fulfillmentMode: 'provider_resale',
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      providerCode: 'zhipu',
      providerLineCode: 'zhipu_overseas',
      providerLine: {
        id: 'line-zhipu',
        code: 'zhipu_overseas',
        providerCode: 'zhipu',
        providerAccountIdentityId: 'pai-zhipu-secondary',
        runtimeEnabled: true,
        dedicatedEndpoints: zhipuAnthropicDedicatedEndpoints(),
      },
      providerEntitlement: {
        id: 'provider-entitlement-2',
        status: 'ACTIVE',
        provider: 'zhipu',
        providerLineId: 'line-zhipu',
        providerCode: 'zhipu',
        providerLineCode: 'zhipu_overseas',
        providerAccountIdentityId: 'pai-zhipu-secondary',
        upstreamApiKeyEncrypted: encrypt('api-key-2', ENCRYPTION_KEY),
        upstreamSecretKeyEncrypted: encrypt('secret-key-2', ENCRYPTION_KEY),
        providerAccountIdentity: {
          ref: 'pa_zhipu_secondary',
          providerCode: 'zhipu',
          status: 'active',
        },
        providerLine: {
          id: 'line-zhipu',
          code: 'zhipu_overseas',
          providerCode: 'zhipu',
          providerAccountIdentityId: 'pai-zhipu-secondary',
        },
        productEndTime: new Date('2030-01-01T00:00:00.000Z'),
        activatedAt: new Date('2026-06-14T00:00:00.000Z'),
        updatedAt,
      },
    });

    await service.syncApiKeyMeta({
      id: 'key-dedicated-2',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-coding',
      codingPlanEntitlementId: 'ent-dedicated-2',
      product: { slug: 'coding', name: 'Coding' },
      name: 'configured dedicated key',
      keyHash: 'f'.repeat(64),
      isActive: true,
      mirrorStatus: 'ACTIVE',
      allowedModels: JSON.stringify(['glm-5.2']),
      budgetUsd: null,
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      ipWhitelist: null,
      deletedAt: null,
    });

    const putKeyCall = syncJobs.dispatchDetailed.mock.calls.find(([job]) =>
      job.namespace === 'billing' && job.method === 'PUT'
        && job.path === '/billing/api/v1/key-activation/key-dedicated-2',
    );
    const body = (putKeyCall?.[0].body as Record<string, any>).key_meta as Record<string, any>;
    expect(body.dedicated_upstream.endpoints).toEqual([
      {
        client_protocol: 'anthropic',
        provider_id: anthropicProviderId,
        protocol_strategy: 'passthrough',
      },
    ]);
    expect(validateKeyMeta(body)).toBe(true);
  });

  it('merges dedicated_upstream endpoints from a shared provider-resale route group', async () => {
    const { service, syncJobs, prisma } = makeService();
    const anthropicProviderId = 'pc_zhipu_coding_anthropic';
    const openaiProviderId = 'pc_zhipu_coding_openai';
    mockDedicatedRuntimeProviders(prisma, [
      { providerId: anthropicProviderId, providerLineId: 'line-anthropic' },
      { providerId: openaiProviderId, providerLineId: 'line-openai' },
    ]);
    prisma.codingPlanEntitlement.findFirst.mockResolvedValue({
      id: 'ent-dedicated-2',
      planId: 'plan-zhipu',
      status: 'ACTIVE',
      fulfillmentMode: 'provider_resale',
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      providerCode: 'zhipu',
      providerLineCode: 'zhipu_anthropic',
      providerLine: {
        id: 'line-anthropic',
        code: 'zhipu_anthropic',
        providerCode: 'zhipu',
        providerAccountIdentityId: 'pai-zhipu-secondary',
        adapterType: 'zhipu_partner',
        runtimeEnabled: true,
        dedicatedEndpoints: zhipuAnthropicDedicatedEndpoints(),
      },
      providerEntitlement: {
        id: 'provider-entitlement-2',
        status: 'ACTIVE',
        provider: 'zhipu',
        providerLineId: 'line-anthropic',
        providerCode: 'zhipu',
        adapterType: 'zhipu_partner',
        providerLineCode: 'zhipu_anthropic',
        providerAccountIdentityId: 'pai-zhipu-secondary',
        upstreamProductId: 'product-zhipu',
        upstreamApiKeyEncrypted: encrypt('api-key-2', ENCRYPTION_KEY),
        upstreamSecretKeyEncrypted: encrypt('secret-key-2', ENCRYPTION_KEY),
        providerAccountIdentity: {
          ref: 'pa_zhipu_secondary',
          providerCode: 'zhipu',
          status: 'active',
        },
        providerLine: {
          id: 'line-anthropic',
          code: 'zhipu_anthropic',
          providerCode: 'zhipu',
          providerAccountIdentityId: 'pai-zhipu-secondary',
        },
        productEndTime: new Date('2030-01-01T00:00:00.000Z'),
        activatedAt: new Date('2026-06-14T00:00:00.000Z'),
        updatedAt: new Date('2026-06-15T00:00:00.000Z'),
      },
    });
    prisma.codingPlanResaleRoute.findMany.mockResolvedValue([
      {
        id: 'route-anthropic',
        providerLineId: 'line-anthropic',
        upstreamProductId: 'product-zhipu',
        priority: 100,
        market: null,
        currency: null,
        salesChannel: null,
        userSegmentId: null,
        providerLine: {
          id: 'line-anthropic',
          code: 'zhipu_anthropic',
          providerCode: 'zhipu',
          providerAccountIdentityId: 'pai-zhipu-secondary',
          adapterType: 'zhipu_partner',
          runtimeEnabled: true,
          dedicatedEndpoints: zhipuAnthropicDedicatedEndpoints(),
        },
      },
      {
        id: 'route-openai',
        providerLineId: 'line-openai',
        upstreamProductId: 'product-zhipu',
        priority: 100,
        market: null,
        currency: null,
        salesChannel: null,
        userSegmentId: null,
        providerLine: {
          id: 'line-openai',
          code: 'zhipu_openai',
          providerCode: 'zhipu',
          providerAccountIdentityId: 'pai-zhipu-secondary',
          adapterType: 'zhipu_partner',
          runtimeEnabled: true,
          dedicatedEndpoints: zhipuOpenAiDedicatedEndpoints(),
        },
      },
    ]);

    await service.syncApiKeyMeta({
      id: 'key-dedicated-2',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-coding',
      codingPlanEntitlementId: 'ent-dedicated-2',
      product: { slug: 'coding', name: 'Coding' },
      name: 'configured dedicated key',
      keyHash: 'f'.repeat(64),
      isActive: true,
      mirrorStatus: 'ACTIVE',
      allowedModels: JSON.stringify(['glm-5.2']),
      budgetUsd: null,
      expiresAt: new Date('2030-01-01T00:00:00.000Z'),
      ipWhitelist: null,
      deletedAt: null,
    });

    const putKeyCall = syncJobs.dispatchDetailed.mock.calls.find(([job]) =>
      job.namespace === 'billing' && job.method === 'PUT'
        && job.path === '/billing/api/v1/key-activation/key-dedicated-2',
    );
    const body = (putKeyCall?.[0].body as Record<string, any>).key_meta as Record<string, any>;
    expect(body.dedicated_upstream.endpoints).toEqual([
      {
        client_protocol: 'anthropic',
        provider_id: anthropicProviderId,
        protocol_strategy: 'passthrough',
      },
      {
        client_protocol: 'openai',
        provider_id: openaiProviderId,
        protocol_strategy: 'passthrough',
      },
      {
        client_protocol: 'responses',
        provider_id: openaiProviderId,
        protocol_strategy: 'responses_to_chat',
      },
    ]);
    expect(validateKeyMeta(body)).toBe(true);
  });

  it('reconstructs a resale Runtime group when Prisma returns one shared account identity', async () => {
    const { service, prisma } = makeService();
    const route = (id: string, lineId: string) => ({
      id,
      providerLineId: lineId,
      upstreamProductId: 'product-zhipu',
      priority: 100,
      market: null,
      currency: null,
      salesChannel: null,
      userSegmentId: null,
      providerLine: {
        id: lineId,
        code: lineId,
        providerCode: 'zhipu',
        providerAccountIdentityId: 'identity-primary',
        adapterType: 'zhipu_partner',
        runtimeEnabled: true,
        dedicatedEndpoints: [],
      },
    });
    prisma.codingPlanResaleRoute.findMany.mockResolvedValue([
      route('route-primary', 'line-primary'),
      route('route-runtime', 'line-runtime'),
    ]);
    const entitlement = {
      id: 'entitlement-1',
      planId: 'plan-zhipu',
      providerLine: {
        id: 'line-primary',
        code: 'line-primary',
        providerCode: 'zhipu',
        providerAccountIdentityId: 'identity-primary',
        adapterType: 'zhipu_partner',
      },
      providerEntitlement: {
        providerLineId: 'line-primary',
        providerAccountIdentityId: 'identity-primary',
        upstreamProductId: 'product-zhipu',
        adapterType: 'zhipu_partner',
        providerLine: {
          providerCode: 'zhipu',
          providerAccountIdentityId: 'identity-primary',
        },
      },
    };

    await expect((service as unknown as {
      providerResaleRuntimeLinesForEntitlement(input: unknown): Promise<unknown[]>;
    }).providerResaleRuntimeLinesForEntitlement(entitlement)).resolves.toHaveLength(2);
    expect(prisma.codingPlanResaleRoute.findMany).toHaveBeenCalledWith(expect.objectContaining({
      select: expect.objectContaining({
        providerLine: {
          select: expect.objectContaining({
            id: true,
            code: true,
            providerAccountIdentityId: true,
          }),
        },
      }),
    }));
  });

  it('rejects Runtime reconstruction when a resale route-group line uses another account identity', async () => {
    const { service, prisma } = makeService();
    prisma.codingPlanResaleRoute.findMany.mockResolvedValue([
      {
        id: 'route-primary',
        providerLineId: 'line-primary',
        upstreamProductId: 'product-zhipu',
        priority: 100,
        market: null,
        currency: null,
        salesChannel: null,
        userSegmentId: null,
        providerLine: {
          id: 'line-primary',
          code: 'zhipu-primary',
          providerCode: 'zhipu',
          providerAccountIdentityId: 'identity-primary',
          adapterType: 'zhipu_partner',
          runtimeEnabled: true,
          dedicatedEndpoints: zhipuAnthropicDedicatedEndpoints(),
        },
      },
      {
        id: 'route-runtime',
        providerLineId: 'line-runtime',
        upstreamProductId: 'product-zhipu',
        priority: 100,
        market: null,
        currency: null,
        salesChannel: null,
        userSegmentId: null,
        providerLine: {
          id: 'line-runtime',
          code: 'zhipu-runtime',
          providerCode: 'zhipu',
          providerAccountIdentityId: 'identity-secondary',
          adapterType: 'zhipu_partner',
          runtimeEnabled: true,
          dedicatedEndpoints: zhipuOpenAiDedicatedEndpoints(),
        },
      },
    ]);

    await expect((service as unknown as {
      providerResaleRuntimeLinesForEntitlement(input: unknown): Promise<unknown>;
    }).providerResaleRuntimeLinesForEntitlement({
      id: 'entitlement-1',
      planId: 'plan-zhipu',
      providerLine: {
        id: 'line-primary',
        code: 'zhipu-primary',
        providerCode: 'zhipu',
        providerAccountIdentityId: 'identity-primary',
        adapterType: 'zhipu_partner',
      },
      providerEntitlement: {
        providerLineId: 'line-primary',
        providerAccountIdentityId: 'identity-primary',
        upstreamProductId: 'product-zhipu',
        adapterType: 'zhipu_partner',
        providerLine: {
          providerCode: 'zhipu',
          providerAccountIdentityId: 'identity-primary',
        },
      },
    })).rejects.toThrow('必须共享同一供应商账户身份');
  });

  it('uses AWS KMS dedicated envelope in production', async () => {
    const { service } = makeService({ NODE_ENV: 'production', KMS_PROVIDER: 'aws' });
    const encrypted = await (service as unknown as {
      encryptDedicatedUpstreamCredential(plaintext: string): Promise<{
        ciphertext: string;
        ciphertextSha256: string;
        kmsKeyId: string;
      }>;
    }).encryptDedicatedUpstreamCredential('api-key-1.secret-key-1');

    expect(encrypted).toEqual({
      ciphertext: 'kms:a21zLWNpcGhlcnRleHQ=',
      ciphertextSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      kmsKeyId: 'kms-key-coding',
    });
    expect(Buffer.from(mockKmsSend.mock.calls[0][0].input.Plaintext).toString('utf8'))
      .toBe('api-key-1.secret-key-1');
  });

  it('uses AliCloud KMS dedicated envelope when KMS_PROVIDER=alicloud', async () => {
    const constructedConfigs: Array<Record<string, unknown>> = [];
    class MockAliCloudEncryptRequest {
      keyId?: string;
      plaintext?: string;

      constructor(config: { keyId: string; plaintext: string }) {
        this.keyId = config.keyId;
        this.plaintext = config.plaintext;
      }

      validate() {
        return undefined;
      }
    }
    const encryptCalls: Array<MockAliCloudEncryptRequest> = [];
    class MockAliCloudKmsClient {
      constructor(config: Record<string, unknown>) {
        constructedConfigs.push(config);
      }

      async encrypt(request: MockAliCloudEncryptRequest) {
        request.validate();
        encryptCalls.push(request);
        return {
          body: {
            ciphertextBlob: 'YWxpY2xvdWQtY2lwaGVydGV4dA==',
            keyId: 'alicloud-real-key-id',
          },
        };
      }
    }
    const { service } = makeService({
      KMS_PROVIDER: 'alicloud',
      ALICLOUD_KMS_KEY_ID: 'alias/dedicated',
      ALICLOUD_KMS_REGION: 'cn-hangzhou',
      ALICLOUD_KMS_ENDPOINT: 'kms.cn-hangzhou.aliyuncs.com',
      ALICLOUD_ACCESS_KEY_ID: 'ak',
      ALICLOUD_ACCESS_KEY_SECRET: 'sk',
      ALICLOUD_SECURITY_TOKEN: 'token',
    });
    (service as unknown as {
      loadAliCloudKmsModule: () => unknown;
    }).loadAliCloudKmsModule = () => ({
      default: MockAliCloudKmsClient,
      EncryptRequest: MockAliCloudEncryptRequest,
    });

    const encrypted = await (service as unknown as {
      encryptDedicatedUpstreamCredential(plaintext: string): Promise<{
        ciphertext: string;
        ciphertextSha256: string;
        kmsKeyId: string;
      }>;
    }).encryptDedicatedUpstreamCredential('api-key-1.secret-key-1');

    expect(encrypted).toEqual({
      ciphertext: 'kms:alicloud:YWxpY2xvdWQtY2lwaGVydGV4dA==',
      ciphertextSha256: expect.stringMatching(/^sha256:[a-f0-9]{64}$/),
      kmsKeyId: 'alicloud-real-key-id',
    });
    expect(constructedConfigs[0]).toMatchObject({
      accessKeyId: 'ak',
      accessKeySecret: 'sk',
      securityToken: 'token',
      regionId: 'cn-hangzhou',
      endpoint: 'kms.cn-hangzhou.aliyuncs.com',
    });
    expect(encryptCalls).toHaveLength(1);
    expect(encryptCalls[0]).toBeInstanceOf(MockAliCloudEncryptRequest);
    expect(encryptCalls[0]).toMatchObject({
      keyId: 'alias/dedicated',
      plaintext: Buffer.from('api-key-1.secret-key-1', 'utf8').toString('base64'),
    });
    expect(mockKmsSend).not.toHaveBeenCalled();
  });

  it('rejects local dedicated envelope in production', async () => {
    const { service } = makeService({ NODE_ENV: 'production', KMS_PROVIDER: 'local' });
    await expect((service as unknown as {
      encryptDedicatedUpstreamCredential(plaintext: string): Promise<unknown>;
    }).encryptDedicatedUpstreamCredential('api-key-1.secret-key-1')).rejects.toThrow(/production/);
  });

  it('does not download quota policies for provider-resale plans', async () => {
    const { service, syncJobs, prisma } = makeService();
    prisma.subscriptionPeriod.findFirst.mockResolvedValue({
      plan: {
        product: {
          billingMode: 'CODING_PLAN',
          codingPlanFulfillmentMode: 'provider_resale',
        },
        quotaRules: [
          {
            template: {
              isActive: true,
              deletedAt: null,
              rules: JSON.stringify([
                { windowType: 'ROLLING', durationSec: 21600, metric: 'REQUESTS', limitValue: 5000 },
              ]),
            },
          },
        ],
      },
    });

    await service.syncApiKeyMeta({
      id: 'key-resale',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      product: { slug: 'coding', name: 'Coding' },
      name: 'resale key',
      keyHash: 'd'.repeat(64),
      isActive: true,
      allowedModels: null,
      budgetUsd: null,
      deletedAt: null,
      rateLimitRpm: 60,
    });

    const body = syncJobs.dispatchDetailed.mock.calls[0][0].body as Record<string, unknown>;
    const policies = (body.policies ?? []) as Array<Record<string, unknown>>;
    // 转售套餐不下发任何配额(cpq-*)策略
    expect(policies.some((p) => String(p.policy_id).startsWith('cpq-'))).toBe(false);
    // 既有 60s rpm 限流不受影响
    expect(policies.some((p) => p.policy_id === 'rpm-key-key-resale')).toBe(true);
  });

  it('sets key-balance false when key budget is exhausted', async () => {
    const { service, syncJobs, pendingAdmission } = makeService();
    pendingAdmission.budgetRelevantSpentUsd = new Prisma.Decimal('11');

    await service.syncKeyBalanceById('9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4');

    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'billing',
      method: 'PUT',
      path: '/billing/api/v1/key-balance/9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
      body: {
        has_balance: false,
        reason: 'key_spend_limit_exhausted',
        decision_id: expect.any(String),
        decision_version: KEY_BALANCE_REVISION,
      },
    }));
  });

  // 上面那条取 spent=11 / budget=10,明显越线 ⇒ 抓不住把 `.lt` 写成 `.lte` 的回归。
  // 下面两条把边界的**两侧**钉住:紧贴预算下方必须放行,恰好等于预算必须拦下。
  // 断言落在 dispatch 的最终 reason 上(而不是快照字段),因为 key_spend_limit_exhausted
  // 是本文件 :919 由 budgetOk 映射出来的,不进快照的 blockingReasons。
  it('keeps key-balance true when key spend is just below the budget', async () => {
    const { service, syncJobs, pendingAdmission } = makeService();
    pendingAdmission.budgetRelevantSpentUsd = new Prisma.Decimal('9.999999999999');

    await service.syncKeyBalanceById('9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4');

    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'billing',
      method: 'PUT',
      path: '/billing/api/v1/key-balance/9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
      body: {
        has_balance: true,
        decision_id: expect.any(String),
        decision_version: KEY_BALANCE_REVISION,
      },
    }));
  });

  it('sets key-balance false when key spend exactly equals the budget', async () => {
    const { service, syncJobs, pendingAdmission } = makeService();
    pendingAdmission.budgetRelevantSpentUsd = new Prisma.Decimal('10');

    await service.syncKeyBalanceById('9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4');

    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'billing',
      method: 'PUT',
      path: '/billing/api/v1/key-balance/9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
      body: {
        has_balance: false,
        reason: 'key_spend_limit_exhausted',
        decision_id: expect.any(String),
        decision_version: KEY_BALANCE_REVISION,
      },
    }));
  });

  it('publishes the precise account debt reason for an active debt restriction', async () => {
    const { service, syncJobs, pendingAdmission } = makeService();
    pendingAdmission.blockingReasons = ['debt_open'];

    await service.syncKeyBalanceById('9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4');

    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'billing',
      method: 'PUT',
      path: '/billing/api/v1/key-balance/9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
      body: {
        has_balance: false,
        reason: 'account_debt',
        decision_id: expect.any(String),
        decision_version: KEY_BALANCE_REVISION,
      },
    }));
  });

  it.each([
    ['pending_usage_exposure_limit', 'settlement_risk_limit_exceeded'],
    ['pending_usage_unreserved', 'billing_review'],
    // 结算侧待复核单独给码，别让客户先去查自己的余额（2026-09-07 国内 prod）
    ['settlement_policy_review', 'settlement_review'],
    ['settlement_retry_pending', 'billing_review'],
    ['evidence_conflict', 'billing_review'],
    ['manual_freeze', 'manual_freeze'],
    ['future_unknown_reason', 'billing_review'],
  ])('maps active restriction %s to supported wire reason %s', async (
    restrictionReason,
    expectedReason,
  ) => {
    const { service, syncJobs, pendingAdmission } = makeService();
    pendingAdmission.blockingReasons = [restrictionReason];

    await service.syncKeyBalanceById('9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4');

    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      body: {
        has_balance: false,
        reason: expectedReason,
        decision_id: expect.any(String),
        decision_version: KEY_BALANCE_REVISION,
      },
    }));
  });

  it('chooses a deterministic review reason when several restrictions apply', async () => {
    const { service, syncJobs, pendingAdmission } = makeService();
    pendingAdmission.blockingReasons = [
      'debt_open',
      'settlement_policy_review',
      'pending_usage_exposure_limit',
    ];

    await service.syncKeyBalanceById('9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4');

    // settlement_policy_review 在多个复核原因里优先给码，取值确定且对客户可诊断
    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      body: {
        has_balance: false,
        reason: 'settlement_review',
        decision_id: expect.any(String),
        decision_version: KEY_BALANCE_REVISION,
      },
    }));
  });

  it('fails closed and reports an unknown reason even when a known restriction also applies', async () => {
    const { service, syncJobs, pendingAdmission } = makeService();
    const error = jest.spyOn((service as any).logger, 'error').mockImplementation();
    pendingAdmission.blockingReasons = ['debt_open', 'future_unknown_reason'];

    await service.syncKeyBalanceById('9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4');

    expect(error).toHaveBeenCalledWith(
      'unknown active billing access restriction reasons=future_unknown_reason',
    );
    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      body: {
        has_balance: false,
        reason: 'billing_review',
        decision_id: expect.any(String),
        decision_version: KEY_BALANCE_REVISION,
      },
    }));
  });

  it('does not expose internal evidence OPEN amounts as customer balance holds', async () => {
    const { service, syncJobs } = makeService();

    await service.syncKeyBalanceById('9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4');

    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      body: {
        has_balance: true,
        decision_id: expect.any(String),
        decision_version: KEY_BALANCE_REVISION,
      },
    }));
  });

  it('subtracts active first-receipt funding reservations from the account balance projection', async () => {
    const { service, syncJobs, pendingAdmission } = makeService();
    pendingAdmission.fundingReservationHoldUsd = new Prisma.Decimal('5');
    pendingAdmission.fundingReservationRequestCount = 1n;

    await service.syncKeyBalanceById('9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4');

    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      body: {
        has_balance: false,
        reason: 'balance_depleted',
        decision_id: expect.any(String),
        decision_version: KEY_BALANCE_REVISION,
      },
    }));
  });

  it('treats a structurally valid unreserved first receipt as an exact provisional hold', async () => {
    const { service, syncJobs, pendingAdmission } = makeService();
    pendingAdmission.provisionalHoldUsd = new Prisma.Decimal('1.25');
    pendingAdmission.provisionalRequestCount = 1n;

    await service.syncKeyBalanceById('9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4');

    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      body: {
        has_balance: true,
        decision_id: expect.any(String),
        decision_version: KEY_BALANCE_REVISION,
      },
    }));
  });

  it('depletes available capacity when an exact provisional hold reaches the wallet balance', async () => {
    const { service, syncJobs, pendingAdmission } = makeService();
    pendingAdmission.provisionalHoldUsd = new Prisma.Decimal('5');
    pendingAdmission.provisionalRequestCount = 1n;

    await service.syncKeyBalanceById('9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4');

    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      body: {
        has_balance: false,
        reason: 'balance_depleted',
        decision_id: expect.any(String),
        decision_version: KEY_BALANCE_REVISION,
      },
    }));
  });

  it.each([
    ['guard and reservation coexist', 'guard_reservation_coexistence'],
    ['guard amount is negative', 'negative_amount'],
    ['guard hold and exposure mismatch', 'amount_mismatch'],
    ['guard currency disagrees with its account', 'currency_mismatch'],
  ])('fails closed when the atomic snapshot classifies %s', async (_label, _case) => {
    const { service, syncJobs, pendingAdmission } = makeService();
    pendingAdmission.blockingReasons = ['pending_usage_unreserved'];
    pendingAdmission.fundingReservationHoldUsd = _case === 'guard_reservation_coexistence'
      ? new Prisma.Decimal('1')
      : new Prisma.Decimal(0);
    pendingAdmission.fundingReservationRequestCount = _case === 'guard_reservation_coexistence'
      ? 1n
      : 0n;

    await service.syncKeyBalanceById('9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4');

    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      body: {
        has_balance: false,
        reason: 'billing_review',
        decision_id: expect.any(String),
        decision_version: KEY_BALANCE_REVISION,
      },
    }));
  });

  it.each<[bigint, boolean, string | undefined]>([
    [99n, true, undefined],
    [100n, false, 'settlement_risk_limit_exceeded'],
    [101n, false, 'settlement_risk_limit_exceeded'],
  ])('applies the configured pending request limit around N=100 (count=%s)', async (
    pendingCount,
    expectedBalance,
    expectedReason,
  ) => {
    const { service, syncJobs, pendingAdmission } = makeService();
    pendingAdmission.provisionalHoldUsd = new Prisma.Decimal('0.25');
    pendingAdmission.provisionalRequestCount = pendingCount;

    await service.syncKeyBalanceById('9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4');

    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      body: {
        has_balance: expectedBalance,
        ...(expectedReason ? { reason: expectedReason } : {}),
        decision_id: expect.any(String),
        decision_version: KEY_BALANCE_REVISION,
      },
    }));
  });

  it.each<[string | undefined]>([
    [undefined],
    ['0'],
    ['1.5'],
    ['not-an-integer'],
  ])('fails closed for pending requests when MAX_REQUESTS is invalid (%s)', async (limit) => {
    const { service, syncJobs, pendingAdmission } = makeService({
      BILLING_USAGE_PENDING_MAX_REQUESTS: limit,
    });
    pendingAdmission.provisionalHoldUsd = new Prisma.Decimal('0.25');
    pendingAdmission.provisionalRequestCount = 1n;

    await service.syncKeyBalanceById('9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4');

    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      body: {
        has_balance: false,
        reason: 'settlement_risk_limit_exceeded',
        decision_id: expect.any(String),
        decision_version: KEY_BALANCE_REVISION,
      },
    }));
  });

  it.each<[string, boolean, string | undefined]>([
    ['4.999999999999', true, undefined],
    ['5', false, 'settlement_risk_limit_exceeded'],
  ])('applies the pending exposure limit at N, not N-1 (hold=%s)', async (
    pendingHold,
    expectedBalance,
    expectedReason,
  ) => {
    const { service, syncJobs, pendingAdmission } = makeService({
      BILLING_USAGE_PENDING_MAX_EXPOSURE_USD: '5',
    });
    pendingAdmission.provisionalHoldUsd = new Prisma.Decimal(pendingHold);
    pendingAdmission.provisionalRequestCount = 1n;

    await service.syncKeyBalanceById('9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4');

    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      body: {
        has_balance: expectedBalance,
        ...(expectedReason ? { reason: expectedReason } : {}),
        decision_id: expect.any(String),
        decision_version: KEY_BALANCE_REVISION,
      },
    }));
  });

  it('classifies guards and reservations from one bounded, atomic SQL snapshot', async () => {
    const { service, prisma } = makeService();

    await service.syncKeyBalanceById('9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4');

    const admissionCalls = prisma.$queryRaw.mock.calls.filter(([query]) =>
      rawQueryText(query).includes('account_authority'));
    expect(admissionCalls).toHaveLength(1);
    const [query, ...parameters] = admissionCalls[0];
    const sql = rawQueryText(query);
    expect(sql).toContain('"account_wallets"');
    expect(sql).toContain('"billing_account_credit_configs"');
    expect(sql).toContain('"tenants"');
    expect(sql).toContain('key_financial_authority');
    expect(sql).toContain('"api_keys"');
    expect(sql).toContain('key."budget_usd"');
    expect(sql).toContain('key_spend');
    expect(sql).toContain('"token_usage"');
    expect(sql).toContain('SUM(usage."cost_usd")');
    // key_spend 必须被 key 预算门挡住:唯一消费点是
    // budgetOk = budgetUsd === null || spent < budget,budgetUsd 为 null 时
    // spent_usd 算了就扔。而 token_usage 是全库最高频写入表(国内 prod 221 万行)、
    // 单把热点 key 占 41% ⇒ api_key_id 索引选择性天然差、planner 正确地选全表顺序扫
    // (实测 192ms / 131,622 buffers)。加索引/加统计都救不了,只能不算。
    // 该 EXISTS 不相关 ⇒ planner 提成 One-Time Filter,为假则 Seq Scan never executed
    // (prod EXPLAIN 实测 192ms → 13.7ms / 3 buffers;有预算 key 结果逐位一致)。
    // 若这条断言失败,通常意味着门被去掉了 —— 那 98.6% 的请求会重新白扫 221 万行。
    expect(sql).toMatch(/EXISTS\s*\(\s*SELECT 1 FROM key_financial_authority\s+WHERE "budget_usd" IS NOT NULL\s*\)/);
    expect(sql).toContain('account."active_credit_limit_usd"');
    expect(sql).toContain('account."balance_allowance_used_usd"');
    expect(sql).toContain('active_reservation_facts');
    expect(sql).toContain('pending_guard_facts');
    expect(sql).toContain('reservation."id" IS NULL');
    expect(sql).toContain('event."status" = \'RECEIVED\'');
    expect(sql).toContain('event."reason" IS NULL');
    expect(sql).toContain('event."reconciliation_status" = \'OPEN\'');
    expect(sql).toContain('event."status" = \'RETRYABLE_FAILED\'');
    expect(sql).toContain('event."reason" = \'funding_reservation_queue_pending\'');
    expect(sql).toContain('event."reconciliation_status" = \'RETRY_WAIT\'');
    expect(sql).toContain('event."pending_hold_usd" >= 0');
    expect(sql).toContain('event."pending_exposure_usd" >= 0');
    expect(sql).toContain('event."pending_hold_usd" = event."pending_exposure_usd"');
    expect(sql).toContain('event."billing_unit" = \'BALANCE\'');
    expect(sql).toContain('UPPER(anchor."billing_currency") = account."currency"');
    expect(sql).toContain('event."api_key_id" = reservation."api_key_id"');
    expect(sql).toContain('event."tenant_id" = reservation."tenant_id"');
    expect(sql).toContain('event."user_id" = reservation."user_id"');
    expect(sql).toContain('anchor."anchor_hash" = reservation."anchor_hash"');
    expect(sql).toContain('restriction."idempotency_key"');
    expect(sql).toContain('restriction."created_by" = \'SYSTEM\'');
    expect(sql).toContain('jsonb_typeof(anchor."customer_quote_snapshot") = \'object\'');
    expect(sql).toContain(') = \'string\'');
    expect(sql).toContain('quote."effective_cost" IS NOT NULL');
    expect(sql).toContain('WHERE guard."is_valid" = FALSE');

    const amountPatterns = parameters.filter((value: unknown): value is string =>
      typeof value === 'string' && value.startsWith('^(?:') && value.includes('e-12'));
    expect(amountPatterns).toHaveLength(2);
    const canonicalAmount = new RegExp(amountPatterns[0]);
    const acceptsAmountEvidence = (value: unknown) =>
      typeof value === 'string' && canonicalAmount.test(value);
    expect([
      '0',
      '0.000000000001',
      '99999999.999999999999',
      '1e-7',
      '1.23e-7',
      '1e-12',
    ].every((value) => canonicalAmount.test(value))).toBe(true);
    expect([
      '1e9999999',
      '1e99',
      '1e-13',
      '1.234567e-7',
      '1.2e-12',
      '123456789012345678901234567890',
      'NaN',
      '100000000',
      '01',
    ].some((value) => acceptsAmountEvidence(value))).toBe(false);
    expect([
      null,
      ['0.25'],
      { amount: '0.25' },
      0.25,
    ].some((value) => acceptsAmountEvidence(value))).toBe(false);
    expect(prisma.accountWallet.findUnique).not.toHaveBeenCalled();
    expect(prisma.billingAccount.findUnique).not.toHaveBeenCalled();
    expect(prisma.tokenUsage.aggregate).not.toHaveBeenCalled();
  });

  it('derives wallet, credit, allowance, budget, spend, and holds only from one snapshot row', async () => {
    const { service, syncJobs, prisma, pendingAdmission } = makeService();
    pendingAdmission.accountBalanceUsd = new Prisma.Decimal('100');
    pendingAdmission.activeCreditLimitUsd = new Prisma.Decimal('50');
    pendingAdmission.balanceAllowanceUsd = new Prisma.Decimal('10');
    pendingAdmission.balanceAllowanceUsedUsd = new Prisma.Decimal('4');
    pendingAdmission.fundingReservationHoldUsd = new Prisma.Decimal('6');
    pendingAdmission.fundingReservationRequestCount = 1n;
    pendingAdmission.budgetRelevantSpentUsd = new Prisma.Decimal('2');

    await service.syncKeyBalanceById('9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4');

    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      body: {
        has_balance: false,
        reason: 'balance_depleted',
        decision_id: expect.any(String),
        decision_version: KEY_BALANCE_REVISION,
      },
    }));
    expect(prisma.accountWallet.findUnique).not.toHaveBeenCalled();
    expect(prisma.billingAccount.findUnique).not.toHaveBeenCalled();
    expect(prisma.tokenUsage.aggregate).not.toHaveBeenCalled();
  });

  it('does not publish when key/account/tenant authority changed after the routing read', async () => {
    const { service, syncJobs, pendingAdmission } = makeService();
    pendingAdmission.financialAuthorityValid = false;

    await expect(
      service.syncKeyBalanceById('9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4'),
    ).rejects.toThrow('Billing pending admission authority changed');

    expect(syncJobs.dispatchDetailed).not.toHaveBeenCalled();
  });

  it('keeps a key-only hard restriction for an entitlement key without an account', async () => {
    const { service, syncJobs, prisma, pendingAdmission } = makeService();
    prisma.apiKey.findUnique.mockResolvedValue({
      id: 'entitlement-only-key',
      userId: 'user-1',
      tenantId: null,
      tenant: null,
      productId: null,
      product: null,
      codingPlanEntitlementId: 'entitlement-1',
      budgetUsd: null,
      mirrorStatus: 'ACTIVE',
      isActive: true,
      deletedAt: null,
    });
    pendingAdmission.blockingReasons = ['manual_freeze'];

    await service.syncKeyBalanceById('entitlement-only-key');

    const admissionCall = prisma.$queryRaw.mock.calls.find(([query]) =>
      rawQueryText(query).includes('account_authority'));
    expect(admissionCall).toBeDefined();
    expect(admissionCall?.slice(1)).toContain('entitlement-only-key');
    expect(admissionCall?.slice(1)).toContain(null);
    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      path: '/billing/api/v1/key-balance/entitlement-only-key',
      body: {
        has_balance: false,
        reason: 'manual_freeze',
        decision_id: expect.any(String),
        decision_version: KEY_BALANCE_REVISION,
      },
    }));
  });

  it('still publishes key-balance for self-operated CODING_PLAN entitlement keys', async () => {
    const prevGate = process.env.BILLING_ROLLING_QUOTA_GATE_ENABLED;
    delete process.env.BILLING_ROLLING_QUOTA_GATE_ENABLED;
    const { service, syncJobs, prisma } = makeService();
    prisma.apiKey.findUnique.mockResolvedValue({
      id: 'key-platform-coding',
      userId: 'user-1',
      tenantId: 'tenant-1',
      tenant: {
        billingAccountId: 'ba_personal_user-1',
        balanceAllowanceUsd: null,
        balanceAllowanceUsedUsd: new Prisma.Decimal(0),
      },
      productId: 'prod-coding',
      product: { billingMode: 'CODING_PLAN' },
      codingPlanEntitlementId: 'ent-platform-1',
      budgetUsd: null,
      isActive: true,
      mirrorStatus: 'ACTIVE',
      deletedAt: null,
    });
    prisma.codingPlanEntitlement.findFirst.mockResolvedValue({
      id: 'ent-platform-1',
      planId: 'plan-platform',
      fulfillmentMode: 'platform_model_package',
    });
    prisma.creditBalanceState.findUnique.mockResolvedValue({ quota: 100, bonus: 0 });
    // A stale historical snapshot must not override the authoritative state.
    prisma.creditTransaction.findFirst.mockResolvedValue({ quotaAfter: 0, bonusAfter: 0 });
    prisma.grantRedemption.findMany.mockResolvedValue([]);
    prisma.tokenUsage.aggregate.mockResolvedValue({ _sum: { costUsd: new Prisma.Decimal('0') } });

    try {
      await service.syncKeyBalanceById('key-platform-coding');
    } finally {
      if (prevGate === undefined) delete process.env.BILLING_ROLLING_QUOTA_GATE_ENABLED;
      else process.env.BILLING_ROLLING_QUOTA_GATE_ENABLED = prevGate;
    }

    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'billing',
      method: 'PUT',
      path: '/billing/api/v1/key-balance/key-platform-coding',
      body: {
        has_balance: true,
        decision_id: expect.any(String),
        decision_version: KEY_BALANCE_REVISION,
      },
    }));
    expect(prisma.creditTransaction.findFirst).not.toHaveBeenCalled();
  });

  it('fails closed instead of publishing an unverified legacy balance without V2 state', async () => {
    const { service, prisma } = makeService();
    prisma.creditBalanceState.findUnique.mockResolvedValue(null);
    prisma.creditTransaction.findFirst.mockResolvedValue({ id: 'legacy-tx' });
    prisma.grantRedemption.findMany.mockResolvedValue([{ amount: 999, usedAmount: 0 }]);

    const total = await (service as unknown as {
      resolveCreditPoolTotal: (subscriptionId: string, userId: string) => Promise<number>;
    }).resolveCreditPoolTotal('legacy-sub', 'user-1');

    expect(total).toBe(0);
    expect(prisma.grantRedemption.findMany).not.toHaveBeenCalled();
  });

  it('counts only unexpired grants for a genuinely new credit scope', async () => {
    const { service, prisma } = makeService();
    prisma.creditBalanceState.findUnique.mockResolvedValue(null);
    prisma.creditTransaction.findFirst.mockResolvedValue(null);
    prisma.grantRedemption.findMany.mockResolvedValue([{ amount: 20, usedAmount: 5 }]);

    const total = await (service as unknown as {
      resolveCreditPoolTotal: (subscriptionId: string, userId: string) => Promise<number>;
    }).resolveCreditPoolTotal('new-sub', 'user-1');

    expect(total).toBe(15);
    expect(prisma.grantRedemption.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        userId: 'user-1',
        OR: [{ expiresAt: null }, { expiresAt: { gt: expect.any(Date) } }],
      }),
    }));
  });

  it('fails closed for a Redis-only legacy balance even when the actor has grants', async () => {
    const { service, prisma, redis } = makeService();
    prisma.creditBalanceState.findUnique.mockResolvedValue(null);
    prisma.creditTransaction.findFirst.mockResolvedValue(null);
    redis.mget.mockResolvedValueOnce(['100', '0']);
    prisma.grantRedemption.findMany.mockResolvedValue([{ amount: 20, usedAmount: 0 }]);

    const total = await (service as unknown as {
      resolveCreditPoolTotal: (subscriptionId: string, userId: string) => Promise<number>;
    }).resolveCreditPoolTotal('redis-only-sub', 'user-1');

    expect(total).toBe(0);
    expect(prisma.grantRedemption.findMany).not.toHaveBeenCalled();
  });

  it('requires subscription credits for non-PAYG product keys instead of using wallet balance', async () => {
    const { service, syncJobs, prisma } = makeService();
    prisma.apiKey.findUnique.mockResolvedValue({
      id: '9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
      userId: 'user-1',
      tenantId: 'tenant-1',
      tenant: {
        billingAccountId: 'ba_personal_user-1',
        balanceAllowanceUsd: null,
        balanceAllowanceUsedUsd: new Prisma.Decimal(0),
      },
      productId: 'saas-product',
      product: { billingMode: 'SUBSCRIPTION' },
      isActive: true,
      mirrorStatus: 'ACTIVE',
      budgetUsd: null,
      deletedAt: null,
    });
    prisma.tokenUsage.aggregate.mockResolvedValue({ _sum: { costUsd: new Prisma.Decimal('0') } });
    prisma.subscriptionPeriod.findFirst.mockResolvedValue({ id: 'period-1' });
    prisma.creditTransaction.findFirst.mockResolvedValue({ quotaAfter: 0, bonusAfter: 0 });
    prisma.grantRedemption.findMany.mockResolvedValue([]);

    await service.syncKeyBalanceById('9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4');

    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'billing',
      method: 'PUT',
      path: '/billing/api/v1/key-balance/9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
      body: {
        has_balance: false,
        reason: 'balance_depleted',
        decision_id: expect.any(String),
        decision_version: KEY_BALANCE_REVISION,
      },
    }));
  });

  it('publishes the owner subscription balance for another member key in the same tenant', async () => {
    const { service, syncJobs, prisma } = makeService();
    prisma.apiKey.findUnique.mockResolvedValue({
      id: 'member-key',
      userId: 'member-user',
      tenantId: 'tenant-1',
      tenant: {
        billingAccountId: 'ba-personal-owner',
        balanceAllowanceUsd: null,
        balanceAllowanceUsedUsd: new Prisma.Decimal(0),
      },
      productId: 'saas-product',
      product: { billingMode: 'SUBSCRIPTION' },
      isActive: true,
      mirrorStatus: 'ACTIVE',
      budgetUsd: null,
      deletedAt: null,
    });
    prisma.tokenUsage.aggregate.mockResolvedValue({ _sum: { costUsd: new Prisma.Decimal(0) } });
    prisma.subscriptionPeriod.findFirst.mockResolvedValue({ id: 'owner-period' });
    prisma.creditBalanceState.findUnique.mockResolvedValue({ quota: 100, bonus: 0 });
    prisma.grantRedemption.findMany.mockResolvedValue([]);

    await service.syncKeyBalanceById('member-key');

    expect(prisma.subscriptionPeriod.findFirst).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({ tenantId: 'tenant-1', productId: 'saas-product' }),
    }));
    expect(prisma.subscriptionPeriod.findFirst.mock.calls[0][0].where).not.toHaveProperty('userId');
    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      path: '/billing/api/v1/key-balance/member-key',
      body: {
        has_balance: true,
        decision_id: expect.any(String),
        decision_version: KEY_BALANCE_REVISION,
      },
    }));
  });

  it('allocates unique monotonic key-balance revisions across two service instances before state reads', async () => {
    let nextRevision = BigInt(KEY_BALANCE_REVISION);
    const sharedDatabaseAllocator = jest.fn(() => nextRevision++);
    const first = makeService();
    const second = makeService();
    first.nextKeyBalanceRevision.mockImplementation(sharedDatabaseAllocator);
    second.nextKeyBalanceRevision.mockImplementation(sharedDatabaseAllocator);

    await Promise.all([
      first.service.syncKeyBalanceById('first-pod-key'),
      second.service.syncKeyBalanceById('second-pod-key'),
    ]);

    const revisions = [first, second].map((instance) => (
      instance.syncJobs.dispatchDetailed.mock.calls.find(
        ([input]) => input.resourceType === 'key_balance' && input.method === 'PUT',
      )?.[0].body.decision_version
    ));
    expect(revisions).toEqual([
      KEY_BALANCE_REVISION,
      KEY_BALANCE_REVISION + 1,
    ]);
    expect(revisions[0]).toBeGreaterThan(LEGACY_PROCESS_REVISION);
    expect(first.publisher.revision).not.toHaveBeenCalled();
    expect(second.publisher.revision).not.toHaveBeenCalled();
    expect(first.prisma.$queryRaw.mock.invocationCallOrder[0])
      .toBeLessThan(first.prisma.apiKey.findUnique.mock.invocationCallOrder[0]);
    expect(first.prisma.apiKey.findUnique.mock.invocationCallOrder[0])
      .toBeLessThan(first.prisma.$queryRaw.mock.invocationCallOrder[1]);
  });

  it('rebuilds a required superseded admission exactly once from freshly read state', async () => {
    const {
      service,
      prisma,
      syncJobs,
      pendingAdmission,
      nextKeyBalanceRevision,
    } = makeService();
    let nextRevision = BigInt(KEY_BALANCE_REVISION);
    nextKeyBalanceRevision.mockImplementation(() => nextRevision++);
    syncJobs.dispatchRequired
      .mockImplementationOnce(async () => {
        pendingAdmission.accountBalanceUsd = new Prisma.Decimal(0);
        throw new PublisherAdmissionSupersededError('rd:first', 409);
      })
      .mockResolvedValueOnce(null);

    await service.syncKeyBalanceByIdRequired('required-superseded-key');

    expect(syncJobs.dispatchRequired).toHaveBeenCalledTimes(2);
    expect(prisma.apiKey.findUnique).toHaveBeenCalledTimes(2);
    const accountAuthorityReads = prisma.$queryRaw.mock.calls.filter(([query]) =>
      rawQueryText(query).includes('account_authority'));
    expect(accountAuthorityReads).toHaveLength(2);
    const [first, second] = syncJobs.dispatchRequired.mock.calls.map(([input]) => input.body as {
      has_balance: boolean;
      reason?: string;
      decision_id: string;
      decision_version: number;
    });
    expect(first).toEqual({
      has_balance: true,
      decision_id: expect.any(String),
      decision_version: KEY_BALANCE_REVISION,
    });
    expect(second).toEqual({
      has_balance: false,
      reason: 'balance_depleted',
      decision_id: expect.any(String),
      decision_version: KEY_BALANCE_REVISION + 1,
    });
    expect(second.decision_id).not.toBe(first.decision_id);
  });

  it('fails closed before state reads if the database allocator restarts below the legacy-safe floor', async () => {
    const { service, publisher, prisma, syncJobs, nextKeyBalanceRevision } = makeService();
    nextKeyBalanceRevision.mockReturnValueOnce(BigInt(KEY_BALANCE_REVISION_FLOOR - 1));

    await expect(service.syncKeyBalanceById('unsafe-revision-key')).rejects.toThrow(
      'Publisher key-balance revision allocator returned an unsafe value',
    );

    expect(prisma.apiKey.findUnique).not.toHaveBeenCalled();
    expect(prisma.accountWallet.findUnique).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(syncJobs.dispatchDetailed).not.toHaveBeenCalled();
    expect(publisher.revision).not.toHaveBeenCalled();
  });

  it('gives a delayed old balance sync a lower revision than a newer concurrent sync', async () => {
    const previousGate = process.env.BILLING_ROLLING_QUOTA_GATE_ENABLED;
    delete process.env.BILLING_ROLLING_QUOTA_GATE_ENABLED;
    const {
      service,
      publisher,
      prisma,
      syncJobs,
      nextKeyBalanceRevision,
    } = makeService();
    nextKeyBalanceRevision
      .mockReturnValueOnce(BigInt(KEY_BALANCE_REVISION))
      .mockReturnValueOnce(BigInt(KEY_BALANCE_REVISION + 1));
    prisma.apiKey.findUnique.mockResolvedValue({
      id: 'concurrent-key',
      userId: 'member-user',
      tenantId: 'tenant-1',
      tenant: {
        billingAccountId: 'ba-personal-owner',
        balanceAllowanceUsd: null,
        balanceAllowanceUsedUsd: new Prisma.Decimal(0),
      },
      productId: 'saas-product',
      product: { billingMode: 'SUBSCRIPTION' },
      isActive: true,
      mirrorStatus: 'ACTIVE',
      budgetUsd: null,
      deletedAt: null,
    });
    prisma.tokenUsage.aggregate.mockResolvedValue({ _sum: { costUsd: new Prisma.Decimal(0) } });
    prisma.subscriptionPeriod.findFirst.mockResolvedValue({ id: 'owner-period' });
    prisma.creditBalanceState.findUnique
      .mockResolvedValueOnce({ quota: 100, bonus: 0 })
      .mockResolvedValueOnce({ quota: 0, bonus: 0 });

    let signalOldRead!: () => void;
    let releaseOldRead!: () => void;
    const oldReadStarted = new Promise<void>((resolve) => { signalOldRead = resolve; });
    const oldReadRelease = new Promise<void>((resolve) => { releaseOldRead = resolve; });
    prisma.grantRedemption.findMany
      .mockImplementationOnce(async () => {
        signalOldRead();
        await oldReadRelease;
        return [];
      })
      .mockResolvedValueOnce([]);

    try {
      const oldSync = service.syncKeyBalanceById('concurrent-key');
      await oldReadStarted;
      await service.syncKeyBalanceById('concurrent-key');
      releaseOldRead();
      await oldSync;
    } finally {
      releaseOldRead();
      if (previousGate === undefined) delete process.env.BILLING_ROLLING_QUOTA_GATE_ENABLED;
      else process.env.BILLING_ROLLING_QUOTA_GATE_ENABLED = previousGate;
    }

    const balanceBodies = syncJobs.dispatchDetailed.mock.calls
      .map((call) => call[0])
      .filter((input) => input.path === '/billing/api/v1/key-balance/concurrent-key')
      .map((input) => input.body);
    expect(balanceBodies).toEqual([
      {
        has_balance: false,
        reason: 'balance_depleted',
        decision_id: expect.any(String),
        decision_version: KEY_BALANCE_REVISION + 1,
      },
      {
        has_balance: true,
        decision_id: expect.any(String),
        decision_version: KEY_BALANCE_REVISION,
      },
    ]);
    expect(publisher.revision).not.toHaveBeenCalled();
  });

  describe('rolling quota gate (P1-C B-close)', () => {
    const GATE_ENV = 'BILLING_ROLLING_QUOTA_GATE_ENABLED';
    const KEY_ID = '9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4';
    let prevGate: string | undefined;

    beforeEach(() => {
      prevGate = process.env[GATE_ENV];
    });
    afterEach(() => {
      if (prevGate === undefined) delete process.env[GATE_ENV];
      else process.env[GATE_ENV] = prevGate;
    });

    function codingPlanScenario(prisma: ReturnType<typeof makeService>['prisma'], fulfillmentMode = 'platform_model_package') {
      prisma.apiKey.findUnique.mockResolvedValue({
        id: KEY_ID,
        userId: 'user-1',
        tenantId: 'tenant-1',
        tenant: {
          billingAccountId: 'ba_personal_user-1',
          balanceAllowanceUsd: null,
          balanceAllowanceUsedUsd: new Prisma.Decimal(0),
        },
        productId: 'prod-coding',
        product: { billingMode: 'CODING_PLAN' },
        codingPlanEntitlementId: 'ent-1',
        budgetUsd: null,
        isActive: true,
        mirrorStatus: 'ACTIVE',
        deletedAt: null,
      });
      // 套餐积分池有余额 → 资金充足，hasBalance 仅取决于配额关闸。
      prisma.codingPlanEntitlement.findFirst.mockResolvedValue({ id: 'ent-1', planId: 'plan-1', fulfillmentMode });
      prisma.creditBalanceState.findUnique.mockResolvedValue({ quota: 1000, bonus: 0 });
      prisma.grantRedemption.findMany.mockResolvedValue([]);
      prisma.tokenUsage.aggregate.mockResolvedValue({ _sum: { costUsd: new Prisma.Decimal('0') } });
    }

    it('blocks key-balance (rolling_quota_exhausted) and registers cpq:gated when quota is exhausted', async () => {
      process.env[GATE_ENV] = 'true';
      const { service, syncJobs, prisma, rollingQuotaGate, redis } = makeService();
      codingPlanScenario(prisma);
      rollingQuotaGate.evaluateExhaustion.mockResolvedValue({ exhausted: true, recheckAtMs: 999 });

      await service.syncKeyBalanceById(KEY_ID);

      expect(rollingQuotaGate.evaluateExhaustion).toHaveBeenCalledWith('ent-1', 'plan-1');
      expect(redis.zadd).toHaveBeenCalledWith('cpq:gated', 999, KEY_ID);
      // 内部语义为 rolling_quota_exhausted，但网关 publisher 契约暂不接受该枚举（会 400 整条拒），
      // 故 wire reason 映射为契约已接受的 balance_depleted；has_balance=false 照常下发以触发阻断。
      expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
        path: `/billing/api/v1/key-balance/${KEY_ID}`,
        body: {
          has_balance: false,
          reason: 'balance_depleted',
          decision_id: expect.any(String),
          decision_version: KEY_BALANCE_REVISION,
        },
      }));
    });

    it('keeps key-balance true and removes cpq:gated when quota is not exhausted', async () => {
      process.env[GATE_ENV] = 'true';
      const { service, syncJobs, prisma, rollingQuotaGate, redis } = makeService();
      codingPlanScenario(prisma);
      rollingQuotaGate.evaluateExhaustion.mockResolvedValue({ exhausted: false, recheckAtMs: 999 });

      await service.syncKeyBalanceById(KEY_ID);

      expect(redis.zrem).toHaveBeenCalledWith('cpq:gated', KEY_ID);
      expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
        path: `/billing/api/v1/key-balance/${KEY_ID}`,
        body: {
          has_balance: true,
          decision_id: expect.any(String),
          decision_version: KEY_BALANCE_REVISION,
        },
      }));
    });

    it('does not gate resale entitlements and removes any stale cpq:gated entry', async () => {
      process.env[GATE_ENV] = 'true';
      const { service, syncJobs, prisma, rollingQuotaGate, redis } = makeService();
      codingPlanScenario(prisma, 'provider_resale');
      prisma.codingPlanEntitlement.findFirst.mockResolvedValue(providerResaleEntitlementFixture({
        entitlement: { id: 'ent-1' },
      }));

      await service.syncKeyBalanceById(KEY_ID);

      expect(rollingQuotaGate.evaluateExhaustion).not.toHaveBeenCalled();
      expect(redis.zrem).toHaveBeenCalledWith('cpq:gated', KEY_ID);
      expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
        namespace: 'billing',
        method: 'DELETE',
        path: `/billing/api/v1/key-balance/${KEY_ID}`,
      }));
    });

    it('removes a deleted/missing key from cpq:gated on recheck (deleteWhenMissing:false)', async () => {
      const { service, prisma, redis } = makeService();
      prisma.apiKey.findUnique.mockResolvedValue(null);

      await service.syncKeyBalanceById(KEY_ID, { deleteWhenMissing: false });

      expect(redis.zrem).toHaveBeenCalledWith('cpq:gated', KEY_ID);
    });

    it('skips the quota gate entirely when the master switch is off', async () => {
      delete process.env[GATE_ENV];
      const { service, prisma, rollingQuotaGate, redis } = makeService();
      codingPlanScenario(prisma);
      rollingQuotaGate.evaluateExhaustion.mockResolvedValue({ exhausted: true, recheckAtMs: 999 });

      await service.syncKeyBalanceById(KEY_ID);

      expect(rollingQuotaGate.evaluateExhaustion).not.toHaveBeenCalled();
      expect(redis.zadd).not.toHaveBeenCalled();
      expect(redis.zrem).not.toHaveBeenCalled();
    });
  });

  it('uses a Publisher-allowed balance reason when a tenant has no billing account', async () => {
    const { service, syncJobs, prisma } = makeService();
    prisma.apiKey.findUnique.mockResolvedValue({
      id: '9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
      userId: 'user-1',
      tenantId: 'tenant-1',
      tenant: {
        billingAccountId: null,
        balanceAllowanceUsd: null,
        balanceAllowanceUsedUsd: new Prisma.Decimal(0),
      },
      productId: 'prod-1',
      product: { billingMode: 'PAY_AS_YOU_GO' },
      budgetUsd: null,
      isActive: true,
      mirrorStatus: 'ACTIVE',
      deletedAt: null,
    });

    await service.syncKeyBalanceById('9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4');

    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'billing',
      method: 'PUT',
      path: '/billing/api/v1/key-balance/9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
      body: {
        has_balance: false,
        reason: 'workspace_budget_exhausted',
        decision_id: expect.any(String),
        decision_version: KEY_BALANCE_REVISION,
      },
    }));
  });

  it('funds CODING_PLAN keys without an entitlement from wallet balance, not the plan credit pool (billing boundary §4.3)', async () => {
    const { service, syncJobs, prisma } = makeService();
    prisma.apiKey.findUnique.mockResolvedValue({
      id: '9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
      userId: 'user-1',
      tenantId: 'tenant-1',
      tenant: {
        billingAccountId: 'acct-1',
        balanceAllowanceUsd: null,
        balanceAllowanceUsedUsd: new Prisma.Decimal(0),
      },
      productId: 'coding-product',
      codingPlanEntitlementId: null,
      product: { billingMode: 'CODING_PLAN' },
      budgetUsd: null,
      isActive: true,
      mirrorStatus: 'ACTIVE',
      deletedAt: null,
    });
    prisma.tokenUsage.aggregate.mockResolvedValue({ _sum: { costUsd: new Prisma.Decimal('0') } });
    // 套餐积分池为空：若错误地按积分判定会得 has_balance:false；按余额（钱包 5）判定则为 true。
    prisma.creditTransaction.findFirst.mockResolvedValue({ quotaAfter: 0, bonusAfter: 0 });
    prisma.grantRedemption.findMany.mockResolvedValue([]);

    await service.syncKeyBalanceById('9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4');

    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'billing',
      method: 'PUT',
      path: '/billing/api/v1/key-balance/9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
      body: {
        has_balance: true,
        decision_id: expect.any(String),
        decision_version: KEY_BALANCE_REVISION,
      },
    }));
  });

  it('does not delete publisher key-balance for usage sync when local key mirror is absent', async () => {
    const { service, syncJobs, prisma } = makeService();
    prisma.apiKey.findUnique.mockResolvedValue(null);

    await service.syncKeyBalanceById('missing-key', { deleteWhenMissing: false });

    expect(syncJobs.dispatchDetailed).not.toHaveBeenCalled();
  });

  it('uses fresh api-key idempotency keys for repeated active key syncs', async () => {
    const { service, syncJobs } = makeService();
    const key = {
      id: '9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: 'prod-1',
      product: { slug: 'coding', name: 'Coding' },
      name: 'prod key',
      keyHash: 'b'.repeat(64),
      isActive: true,
      mirrorStatus: 'ACTIVE',
      allowedModels: null,
      budgetUsd: null,
      deletedAt: null,
    };

    await service.syncApiKeyMeta(key);
    const firstActivationKey = syncJobs.dispatchDetailed.mock.calls[0][0].idempotencyKey;

    syncJobs.dispatchDetailed.mockClear();
    await service.syncApiKeyMeta(key);
    const secondActivationKey = syncJobs.dispatchDetailed.mock.calls[0][0].idempotencyKey;

    expect(firstActivationKey).toMatch(/^rd:api-key:/);
    expect(secondActivationKey).toMatch(/^rd:api-key:/);
    expect(secondActivationKey).not.toBe(firstActivationKey);
  });

  it('uses fresh replay idempotency keys for full API key replay', async () => {
    const { service, syncJobs } = makeService();

    const result = await service.replayPublisherState('api_keys');

    expect(result).toEqual(expect.objectContaining({
      scope: 'api_keys',
      replayRunId: expect.any(String),
      apiKeys: 1,
    }));
    expect(syncJobs.dispatchDetailed).toHaveBeenNthCalledWith(1, expect.objectContaining({
      namespace: 'billing',
      resourceType: 'api_key',
      path: '/billing/api/v1/key-activation/9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
      idempotencyKey: expect.stringMatching(/^rd:replay:/),
    }));
    expect(syncJobs.dispatchDetailed).toHaveBeenCalledTimes(1);
  });

  it('replays platform config with a replay idempotency key', async () => {
    const { service, syncJobs } = makeService();

    const result = await service.replayPublisherState('platform');

    expect(result).toEqual(expect.objectContaining({
      scope: 'platform',
      replayRunId: expect.any(String),
      platformConfig: true,
    }));
    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'admin',
      method: 'PUT',
      path: '/admin/api/v1/platform-config',
      resourceType: 'platform_config',
      resourceId: 'default',
      idempotencyKey: expect.stringMatching(/^rd:replay:/),
      body: expect.objectContaining({
        default_provider_strategy: 'weight',
        operational: expect.objectContaining({
          idempotency_attr: 'tenant_id',
          kafka_partition_attr: 'tenant_id',
          full_detail_attr: 'tenant_id',
        }),
      }),
    }));
  });

  it('replays each retained key balance exactly once when replaying all publisher state', async () => {
    const { service, syncJobs, prisma } = makeService();

    const result = await service.replayPublisherState('all');

    expect(result).toEqual(expect.objectContaining({
      scope: 'all',
      apiKeys: 1,
      keyBalances: 1,
      adminTopology: true,
    }));
    expect(prisma.apiKey.findMany).toHaveBeenCalledWith(expect.objectContaining({
      select: { id: true },
      orderBy: { id: 'asc' },
      take: 500,
    }));
    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'billing',
      resourceType: 'key_balance',
      idempotencyKey: expect.stringMatching(/^rd:replay:/),
    }));
    expect(syncJobs.dispatchDetailed.mock.calls.filter(
      ([input]) => input.resourceType === 'key_balance',
    )).toHaveLength(1);
  });

  it('paginates a full API-key replay without a fixed record cap', async () => {
    const { service, prisma } = makeService();
    const keys = Array.from({ length: 501 }, (_, index) => ({
      id: `key-${String(index).padStart(4, '0')}`,
    }));
    prisma.apiKey.findMany
      .mockReset()
      .mockResolvedValueOnce(keys.slice(0, 500))
      .mockResolvedValueOnce(keys.slice(500));
    prisma.apiKey.findUnique.mockResolvedValue(null);

    await expect(service.replayPublisherState('api_keys')).resolves.toEqual(
      expect.objectContaining({ apiKeys: 501 }),
    );

    expect(prisma.apiKey.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.apiKey.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      orderBy: { id: 'asc' },
      take: 500,
      cursor: { id: 'key-0499' },
      skip: 1,
    }));
    expect(prisma.apiKey.findUnique).toHaveBeenCalledTimes(501);
    expect(prisma.apiKey.findUnique).toHaveBeenLastCalledWith({
      where: { id: 'key-0500' },
      include: { product: { select: { slug: true, name: true, billingMode: true } } },
    });
  });

  it('paginates a full key-balance replay without a fixed record cap', async () => {
    const { service, prisma } = makeService();
    const keys = Array.from({ length: 501 }, (_, index) => ({
      id: `key-${String(index).padStart(4, '0')}`,
    }));
    prisma.apiKey.findMany
      .mockReset()
      .mockResolvedValueOnce(keys.slice(0, 500))
      .mockResolvedValueOnce(keys.slice(500));
    const syncKeyBalanceById = jest
      .spyOn(service, 'syncKeyBalanceById')
      .mockResolvedValue(undefined);

    await expect(service.replayPublisherState('key_balances')).resolves.toEqual(
      expect.objectContaining({ keyBalances: 501 }),
    );

    expect(prisma.apiKey.findMany).toHaveBeenCalledTimes(2);
    expect(prisma.apiKey.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      orderBy: { id: 'asc' },
      take: 500,
      cursor: { id: 'key-0499' },
      skip: 1,
    }));
    expect(syncKeyBalanceById).toHaveBeenCalledTimes(501);
  });

  it('paginates the active key admission backfill instead of treating page size as a cap', async () => {
    const { service, prisma } = makeService();
    prisma.apiKey.findMany
      .mockResolvedValueOnce([{ id: 'key-1' }, { id: 'key-2' }])
      .mockResolvedValueOnce([{ id: 'key-3' }])
      .mockResolvedValueOnce([]);

    const total = await service.syncAllKeyBalances(2, { replayRunId: 'backfill-1' });

    expect(total).toBe(3);
    expect(prisma.apiKey.findMany).toHaveBeenNthCalledWith(1, expect.objectContaining({
      where: { deletedAt: null, isActive: true, mirrorStatus: 'ACTIVE' },
      orderBy: { id: 'asc' },
      take: 2,
    }));
    expect(prisma.apiKey.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      cursor: { id: 'key-2' },
      skip: 1,
      orderBy: { id: 'asc' },
      take: 2,
    }));
  });

  it('replays retained deleted keys through revoke and delete tombstones', async () => {
    const { service, syncJobs, prisma } = makeService();
    const deletedKey = {
      id: 'deleted-key-1',
      keyHash: 'd'.repeat(64),
      deletedAt: new Date('2026-08-10T00:00:00.000Z'),
      mirrorStatus: 'REVOKED',
    };
    prisma.apiKey.findMany.mockResolvedValueOnce([{ id: deletedKey.id }]);
    prisma.apiKey.findUnique.mockResolvedValueOnce(deletedKey);

    await expect(service.replayPublisherState('api_keys')).resolves.toEqual(
      expect.objectContaining({ apiKeys: 1 }),
    );

    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'user',
      method: 'POST',
      path: '/user/api/v1/revoked-keys',
      body: { key_hash: 'd'.repeat(64) },
      idempotencyKey: expect.stringMatching(/^rd:replay:/),
    }));
    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'user',
      method: 'DELETE',
      path: `/user/api/v1/keys/${'d'.repeat(64)}`,
      idempotencyKey: expect.stringMatching(/^rd:replay:/),
    }));
    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'billing',
      method: 'DELETE',
      path: '/billing/api/v1/key-balance/deleted-key-1',
      body: {
        decision_id: expect.any(String),
        decision_version: KEY_BALANCE_REVISION,
      },
      idempotencyKey: expect.stringMatching(/^rd:replay:/),
    }));
    expect(syncJobs.dispatchDetailed).not.toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'user',
      method: 'PUT',
      path: '/user/api/v1/keys',
    }));
  });

  it('does not prune publisher models from ModelPricing during admin replay', async () => {
    const { service, syncJobs, prisma } = makeService();

    const result = await service.replayPublisherState('admin');

    expect(result).toEqual(expect.objectContaining({
      scope: 'admin',
      replayRunId: expect.any(String),
      adminTopology: true,
    }));
    expect(result).not.toHaveProperty('staleModelsDeleted');
    expect(prisma.modelPricing.findMany).toHaveBeenCalledTimes(1);
    expect(prisma.publisherSyncJob.findMany).not.toHaveBeenCalled();
    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'admin',
      method: 'POST',
      path: '/admin/api/v1/providers:from-intent',
      resourceType: 'runtime_intent',
      resourceId: 'default',
      idempotencyKey: expect.stringMatching(/^rd:replay:/),
    }));
    expect(syncJobs.dispatchDetailed).not.toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'admin',
      method: 'DELETE',
      resourceType: 'model_catalog',
    }));
  });

  it('uses fresh replay idempotency keys for channel-triggered topology sync', async () => {
    const { service, syncJobs, prisma } = makeService();
    prisma.channel.findMany.mockResolvedValue([{
      id: 'ch-kimi',
      name: 'KIMI official',
      provider: 'kimi',
      baseUrl: 'https://api.moonshot.ai/v1',
      sdkType: 'openai_compatible',
      apiKeyEncrypted: encrypt('sk-kimi', ENCRYPTION_KEY),
      models: JSON.stringify(['kimi-k2.6']),
      modelConfigs: null,
      priority: 1,
      weight: 10,
      maxRpm: null,
      maxTpm: null,
      isActive: true,
      status: 'active',
      deletedAt: null,
    }]);

    await service.syncOpsTopologyFresh();

    expect(prisma.modelPricing.findMany).toHaveBeenCalledTimes(1);
    const idempotencyKeys = syncJobs.dispatchDetailed.mock.calls
      .map(([input]) => input.idempotencyKey)
      .filter(Boolean);
    expect(idempotencyKeys.length).toBeGreaterThan(0);
    expect(idempotencyKeys.every((key) => /^rd:replay:/.test(key))).toBe(true);
    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'admin',
      method: 'POST',
      path: '/admin/api/v1/providers:from-intent',
      resourceType: 'runtime_intent',
      resourceId: 'default',
      idempotencyKey: expect.stringMatching(/^rd:replay:/),
    }));
  });

  it('posts RuntimeIntent through the intent endpoint for topology sync', async () => {
    const { service, syncJobs, prisma } = makeService();
    prisma.channel.findMany.mockResolvedValue([{
      id: 'ch-anthropic',
      name: 'Anthropic official',
      provider: 'anthropic',
      baseUrl: 'https://api.anthropic.com',
      sdkType: 'anthropic',
      apiKeyEncrypted: encrypt('sk-ant', ENCRYPTION_KEY),
      models: JSON.stringify(['claude-sonnet-4-6']),
      modelConfigs: null,
      priority: 1,
      weight: 10,
      maxRpm: null,
      maxTpm: null,
      isActive: true,
      status: 'active',
      deletedAt: null,
    }]);

    await service.syncOpsTopologyFresh();

    expect(syncJobs.dispatchDetailed).toHaveBeenCalledWith(expect.objectContaining({
      namespace: 'admin',
      method: 'POST',
      path: '/admin/api/v1/providers:from-intent',
      resourceType: 'runtime_intent',
      body: expect.objectContaining({
        schema_version: 2,
        provider_endpoints: [],
        provider_credentials: [],
      }),
    }));
  });

  it('passes through AWS KMS and valid gateway local enc payloads for RuntimeIntent credentials', () => {
    const { service } = makeService();
    const gatewayLocalCiphertext = encryptGatewayLocalSecret('exampleCiphertext', ENCRYPTION_KEY);

    expect((service as any).toPublisherCiphertext('enc:CiCexampleCiphertext'))
      .toBe('enc:CiCexampleCiphertext');
    expect((service as any).toPublisherCiphertext(gatewayLocalCiphertext))
      .toBe(gatewayLocalCiphertext);
  });

  it('converts legacy local AES channel keys to gateway local ciphertext for RuntimeIntent credentials', () => {
    const { service } = makeService();
    const legacy = encrypt('sk-upstream', ENCRYPTION_KEY);

    const ciphertext = (service as any).toPublisherCiphertext(legacy);

    expect(ciphertext).toMatch(/^enc:local:/);
    expect(decryptGatewayLocalSecret(ciphertext, ENCRYPTION_KEY)).toBe('sk-upstream');
  });

  it('rejects gateway local ciphertext that cannot be normalized', () => {
    const { service } = makeService();
    const corruptForCurrentSecret = encryptGatewayLocalSecret('sk-upstream', 'b'.repeat(64));

    expect(() => (service as any).toPublisherCiphertext(corruptForCurrentSecret))
      .toThrow('gateway local ciphertext cannot be decrypted');
  });

  it('does not treat catalog-only media provider sdk types as gateway-routable api types', () => {
    const { service } = makeService();

    expect((service as any).apiTypesFor('minimax', 'minimax_video')).toEqual([]);
    expect((service as any).apiTypesFor('seedance', 'seedance_video')).toEqual(['ark']);
    expect((service as any).apiTypesFor('runway', 'runway_video')).toEqual([]);
    expect((service as any).apiTypesFor('kling', 'kling_video')).toEqual([]);
    expect((service as any).apiTypesFor('openai', 'openai_image')).toEqual([]);
    expect((service as any).apiTypesFor('minimax', 'minimax_image')).toEqual([]);
    expect((service as any).apiTypesFor('stability', 'stability_image')).toEqual([]);
    expect((service as any).apiTypesFor('fal', 'fal_image')).toEqual([]);
    expect((service as any).apiTypesFor('openai', 'openai_audio')).toEqual([]);
    expect((service as any).apiTypesFor('elevenlabs', 'elevenlabs_audio')).toEqual([]);
    expect((service as any).apiTypesFor('minimax', 'minimax_music')).toEqual([]);
  });

  it('compiles the three CN Seedance products as independent Ark video intent fragments', () => {
    const { service } = makeService();
    const models = [
      'doubao-seedance-2-5-260628',
      'doubao-seedance-2-0-260128',
      'doubao-seedance-2-0-fast-260128',
    ];
    const channel = {
      id: 'seedance-cn-main',
      name: 'Seedance CN main',
      provider: 'seedance',
      baseUrl: 'https://ark.cn-beijing.volces.com',
      sdkType: 'seedance_video',
      providerProfile: null,
      clientCompatibility: null,
      servedInboundProtocols: null,
      protocolPaths: null,
      tokenCountStrategy: null,
      ownedBy: 'seedance-cn-account',
      providerAccountIdentity: {
        ref: 'pa_seedance_cn_main',
        providerCode: 'seedance',
        status: 'active',
      },
      apiKeyEncrypted: encrypt('not-a-real-credential', ENCRYPTION_KEY),
      models: JSON.stringify(models),
      modelConfigs: null,
      isActive: true,
      status: 'active',
      priority: 1,
      weight: 100,
      maxRpm: null,
      maxTpm: null,
      deletedAt: null,
    };
    const productChannel = {
      id: 'pc-seedance-cn',
      channelId: channel.id,
      displayName: 'Seedance CN',
      status: 'active',
      priority: 1,
      weight: 100,
      maxRpm: null,
      maxTpm: null,
      metadata: null,
      channel,
    };

    const endpoint = (service as any).buildProviderEndpointIntent('pc_seedance_cn', productChannel, {
      slug: 'seedance',
    });
    expect(endpoint).toEqual({
      id: 'pc_seedance_cn',
      provider_profile: 'ark_video_native',
      base_url: 'https://ark.cn-beijing.volces.com',
      status: 'active',
      code: 'seedance-cn-main',
      owned_by: 'seedance-cn-account',
      name: 'Seedance CN',
      path_prefix: '/api/v3',
    });
    const exposure = (service as any).buildClientExposureIntent('pc_seedance_cn', productChannel);
    expect(exposure).toEqual({
      provider_id: 'pc_seedance_cn',
      served_inbound_protocols: ['ark'],
      paths: [{ inbound_protocol: 'ark', channel: 'passthrough' }],
      capabilities: ['video_generation'],
    });
    const credential = (service as any).buildProviderCredentialIntent(
      'pc_seedance_cn',
      productChannel,
      models,
    );
    expect(credential).toEqual(expect.objectContaining({
      provider_id: 'pc_seedance_cn',
      provider_account_ref: 'pa_seedance_cn_main',
      allowed_models: models,
    }));
    expect(models.map((model) => ({
      logical_model: model,
      upstream_model: (service as any).upstreamModelFor(channel, model),
      capabilities: (service as any).routeCapabilitiesFor(channel),
    }))).toEqual(models.map((model) => ({
      logical_model: model,
      upstream_model: model,
      capabilities: ['video_generation'],
    })));
    expect(validateRuntimeIntent({
      schema_version: 2,
      provider_endpoints: [endpoint],
      provider_credentials: [credential],
      client_exposures: [exposure],
      model_routes: models.map((model) => ({
        logical_model: model,
        capabilities: ['video_generation'],
        routes: [{
          provider_id: 'pc_seedance_cn',
          upstream_model: (service as any).upstreamModelFor(channel, model),
          status: 'active',
          priority: 1,
          weight: 100,
          capabilities: ['video_generation'],
        }],
      })),
      product_policies: [],
    })).toBe(true);
    for (const model of models) {
      expect(validateRuntimeIntent({
        schema_version: 2,
        provider_endpoints: [endpoint],
        provider_credentials: [{ ...credential, allowed_models: [model] }],
        client_exposures: [exposure],
        model_routes: [{
          logical_model: model,
          capabilities: ['video_generation'],
          routes: [{
            provider_id: 'pc_seedance_cn',
            upstream_model: (service as any).upstreamModelFor(channel, model),
            status: 'active',
            priority: 1,
            weight: 100,
            capabilities: ['video_generation'],
          }],
        }],
        product_policies: [],
      })).toBe(true);
    }
  });

  it('fails loud for Seedance without a stable provider account, CN mapping, or verified realm', () => {
    const { service } = makeService();
    const baseChannel = {
      id: 'seedance-cn-main',
      name: 'Seedance CN main',
      provider: 'seedance',
      baseUrl: 'https://ark.cn-beijing.volces.com',
      sdkType: 'seedance_video',
      providerProfile: null,
      clientCompatibility: null,
      servedInboundProtocols: null,
      tokenCountStrategy: null,
      ownedBy: 'seedance-cn-account',
      providerAccountIdentity: null,
      apiKeyEncrypted: encrypt('not-a-real-credential', ENCRYPTION_KEY),
      models: JSON.stringify(['doubao-seedance-2-5-260628']),
      modelConfigs: null,
      isActive: true,
      status: 'active',
      priority: 1,
      weight: 100,
      maxRpm: null,
      maxTpm: null,
      deletedAt: null,
    };
    const productChannel = {
      id: 'pc-seedance-cn',
      channelId: baseChannel.id,
      displayName: 'Seedance CN',
      status: 'active',
      priority: 1,
      weight: 100,
      maxRpm: null,
      maxTpm: null,
      metadata: null,
      channel: baseChannel,
    };

    expect(() => (service as any).buildProviderCredentialIntent(
      'pc_seedance_cn',
      productChannel,
      ['doubao-seedance-2-5-260628'],
    )).toThrow(/provider_account_ref/);
    expect(() => (service as any).upstreamModelFor(
      baseChannel,
      'doubao-seedance-1-5-pro-251215',
    )).toThrow(/Seedance.*CN.*mapping/i);
    expect(() => (service as any).upstreamModelFor(
      { ...baseChannel, baseUrl: 'https://ark.ap-southeast.volces.com' },
      'doubao-seedance-2-5-260628',
    )).toThrow(/Seedance.*realm/i);
    expect(() => (service as any).buildProviderEndpointIntent(
      'pc_seedance_cn',
      {
        ...productChannel,
        channel: { ...baseChannel, providerProfile: 'openai_compatible' },
      },
      { slug: 'seedance' },
    )).toThrow(/requires provider profile ark_video_native/);
    expect(() => (service as any).buildClientExposureIntent(
      'pc_seedance_cn',
      {
        ...productChannel,
        channel: { ...baseChannel, servedInboundProtocols: JSON.stringify(['openai']) },
      },
    )).toThrow(/requires served inbound protocol ark/);
  });

  it('uses Publisher provider profiles instead of gateway protocol bindings', () => {
    const { service } = makeService();

    const openaiCompat = (service as any).buildProvider('other', [{
      name: 'proxy-main',
      provider: 'other',
      baseUrl: 'https://proxy.example.com',
      sdkType: 'openai_completions',
      models: JSON.stringify(['claude-opus-4-7']),
      isActive: true,
      status: 'active',
    }]);
    const zhipuOpenAICompat = (service as any).buildProvider('zhipu', [{
      provider: 'zhipu',
      baseUrl: 'http://18.141.203.177:8080',
      sdkType: 'openai_completions',
      isActive: true,
      status: 'active',
    }]);
    const nativeGlm = (service as any).buildProvider('zhipu', [{
      provider: 'zhipu',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      sdkType: null,
      isActive: true,
      status: 'active',
    }]);
    const gemini = (service as any).buildProvider('google', [{
      provider: 'google',
      baseUrl: 'https://generativelanguage.googleapis.com',
      sdkType: null,
      isActive: true,
      status: 'active',
    }]);
    const responses = (service as any).buildProvider('openai', [{
      provider: 'openai',
      baseUrl: 'https://api.openai.com/v1',
      sdkType: 'openai_responses',
      isActive: true,
      status: 'active',
    }]);
    const anthropic = (service as any).buildProvider('anthropic', [{
      provider: 'claude',
      baseUrl: 'https://api.anthropic.com',
      sdkType: 'anthropic',
      isActive: true,
      status: 'active',
    }]);

    expect(openaiCompat).toEqual(expect.objectContaining({
      id: 'other',
      code: 'other',
      name: 'proxy-main',
      base_url: 'https://proxy.example.com',
      provider_profile: 'openai_compatible',
      client_compatibility: ['all'],
    }));
    expect(openaiCompat).not.toHaveProperty('protocol_bindings');
    expect(openaiCompat).not.toHaveProperty('default_protocol_binding');
    expect(zhipuOpenAICompat).toEqual(expect.objectContaining({
      base_url: 'http://18.141.203.177:8080',
      provider_profile: 'openai_compatible',
      client_compatibility: ['all'],
    }));
    expect(zhipuOpenAICompat).not.toHaveProperty('protocol_bindings');
    expect(zhipuOpenAICompat).not.toHaveProperty('default_protocol_binding');
    expect(nativeGlm).toEqual(expect.objectContaining({
      base_url: 'https://open.bigmodel.cn',
      provider_profile: 'glm',
      client_compatibility: ['all'],
      path_prefix: '/api/paas/v4',
    }));
    expect(nativeGlm).not.toHaveProperty('protocol_bindings');
    expect(nativeGlm).not.toHaveProperty('default_protocol_binding');
    expect(gemini).toEqual(expect.objectContaining({
      provider_profile: 'gemini_native',
      client_compatibility: ['all'],
    }));
    expect(gemini).not.toHaveProperty('protocol_bindings');
    expect(gemini).not.toHaveProperty('default_protocol_binding');
    expect(responses).toEqual(expect.objectContaining({
      provider_profile: 'openai_responses_native',
      client_compatibility: ['all'],
    }));
    expect(responses).not.toHaveProperty('protocol_bindings');
    expect(responses).not.toHaveProperty('default_protocol_binding');
    expect(anthropic).toEqual(expect.objectContaining({
      id: 'anthropic',
      base_url: 'https://api.anthropic.com',
      provider_profile: 'anthropic_native',
      client_compatibility: ['all'],
      token_count_strategy: 'native',
      path_prefix: '/v1',
    }));
    expect(anthropic).not.toHaveProperty('protocol_bindings');
    expect(anthropic).not.toHaveProperty('default_protocol_binding');
    expect(openaiCompat).not.toHaveProperty('provider_id');
    expect(openaiCompat).not.toHaveProperty('api_types');
    expect(openaiCompat).not.toHaveProperty('api_type');
    expect(openaiCompat).not.toHaveProperty('auth_type');
  });

  it('keeps representative non-video provider compile output byte-for-byte stable', () => {
    const { service } = makeService();
    const compile = (providerId: string, channel: Record<string, unknown>) =>
      (service as any).buildProvider(providerId, [{
        name: `${providerId} fixture`,
        provider: providerId,
        isActive: true,
        status: 'active',
        ...channel,
      }]);
    const output = [
      compile('openai', {
        baseUrl: 'https://api.openai.com/v1',
        sdkType: 'openai_completions',
      }),
      compile('anthropic', {
        baseUrl: 'https://api.anthropic.com',
        sdkType: 'anthropic',
      }),
      compile('cohere', {
        baseUrl: 'https://api.cohere.com/v2',
        sdkType: 'cohere_v2',
      }),
      compile('openai', {
        name: 'openai image fixture',
        baseUrl: 'https://api.openai.com/v1',
        sdkType: 'openai_image',
      }),
    ];

    expect(JSON.stringify(output)).toBe(
      '[{"id":"openai","code":"openai","name":"openai fixture","base_url":"https://api.openai.com",'
      + '"provider_profile":"openai_compatible","client_compatibility":["all"],'
      + '"token_count_strategy":"unsupported","path_prefix":"/v1","status":"active","key_strategy":"weight"},'
      + '{"id":"anthropic","code":"anthropic","name":"anthropic fixture","base_url":"https://api.anthropic.com",'
      + '"provider_profile":"anthropic_native","client_compatibility":["all"],'
      + '"token_count_strategy":"native","path_prefix":"/v1","status":"active","key_strategy":"weight"},'
      + '{"id":"cohere","code":"cohere","name":"cohere fixture","base_url":"https://api.cohere.com",'
      + '"provider_profile":"cohere_v2","client_compatibility":["all"],'
      + '"path_prefix":"/v2","status":"active","key_strategy":"weight"},'
      + '{"id":"openai","code":"openai","name":"openai image fixture","base_url":"https://api.openai.com",'
      + '"path_prefix":"/v1","status":"active","key_strategy":"weight"}]',
    );
  });

  it('uses channel name as the Publisher provider display name for generic channels', () => {
    const { service } = makeService();
    const providerId = 'other';

    const body = (service as any).buildProvider(providerId, [{
      id: 'channel-open-test-main',
      name: 'open-test-main',
      ownedBy: 'manual-upstream-owner',
      provider: 'other',
      baseUrl: 'https://open.test.cn/v1',
      sdkType: 'openai_completions',
      isActive: true,
      status: 'active',
    }]);

    expect(body).toEqual(expect.objectContaining({
      id: providerId,
      code: providerId,
      name: 'open-test-main',
      base_url: 'https://open.test.cn',
      path_prefix: '/v1',
      provider_profile: 'openai_compatible',
      owned_by: 'manual-upstream-owner',
      client_compatibility: ['all'],
      token_count_strategy: 'unsupported',
    }));
    expect(body).not.toHaveProperty('protocol_bindings');
    expect(body).not.toHaveProperty('default_protocol_binding');
  });

  it('splits runtime provider ids across endpoint changes while ignoring model changes', () => {
    const { service } = makeService();

    const before = (service as any).providerIdForChannel({
      id: 'channel-before',
      provider: 'other',
      baseUrl: 'https://sub2api-test.codesphere.run',
      sdkType: 'openai_completions',
      models: JSON.stringify(['kimi-k2.6']),
    });
    const after = (service as any).providerIdForChannel({
      id: 'channel-after',
      provider: 'other',
      baseUrl: 'http://18.141.203.177:8080',
      sdkType: 'openai_completions',
      models: JSON.stringify(['claude-haiku-4-5-20251001']),
    });
    const sameEndpointDifferentModel = (service as any).providerIdForChannel({
      id: 'channel-same-endpoint',
      provider: 'other',
      baseUrl: 'https://sub2api-test.codesphere.run',
      sdkType: 'openai_completions',
      models: JSON.stringify(['claude-haiku-4-5-20251001']),
    });

    expect(before).toMatch(/^other-openai_compatible-/);
    expect(after).toMatch(/^other-openai_compatible-/);
    expect(before).not.toBe(after);
    expect(before).toBe(sameEndpointDifferentModel);
  });

  it('respects explicit OpenAI-compatible sdk labels on zhipu providers', () => {
    const { service } = makeService();

    const openaiCompat = (service as any).providerIdForChannel({
      id: 'channel-zhipu-openai',
      provider: 'zhipu',
      baseUrl: 'https://proxy.example.com/v1',
      sdkType: 'openai_completions',
      models: JSON.stringify(['glm-5.1']),
    });
    const nativeGlm = (service as any).providerIdForChannel({
      id: 'channel-zhipu-native',
      provider: 'zhipu',
      baseUrl: 'https://open.bigmodel.cn/api/paas/v4',
      sdkType: 'glm',
      models: JSON.stringify(['glm-5.1']),
    });

    expect(openaiCompat).toMatch(/^zhipu-openai_compatible-/);
    expect(nativeGlm).toMatch(/^zhipu-glm-/);
    expect(openaiCompat).not.toBe(nativeGlm);
    expect((service as any).apiTypesFor('zhipu', 'openai_completions')).toEqual(['openai']);
    expect((service as any).apiTypesFor('zhipu', 'openai_compatible')).toEqual(['openai']);
    expect((service as any).apiTypesFor('zhipu', 'glm')).toEqual(['glm']);
    expect((service as any).apiTypesFor('azure', 'azure')).toEqual(['azure']);
    expect((service as any).apiTypesFor('doubao', 'doubao')).toEqual(['doubao']);
  });

  it('maps Moonshot/Kimi channels to the gateway kimi provider id', () => {
    const { service } = makeService();

    expect((service as any).providerIdForChannel({
      provider: 'moonshot',
    })).toBe('kimi');
    expect((service as any).providerIdForChannel({
      provider: 'kimi',
    })).toBe('kimi');
    expect((service as any).providerIdForChannel({
      provider: 'moonshot',
      baseUrl: 'https://api.moonshot.cn/v1',
      sdkType: 'openai_completions',
    })).toMatch(/^kimi-openai_compatible-/);
    expect((service as any).apiTypesFor('kimi', 'openai_completions')).toEqual(['openai']);
  });

  it('builds route capabilities from the stable chat axis only', () => {
    const { service } = makeService();

    const capabilities = (service as any).routeCapabilitiesFor({
      provider: 'moonshot',
      sdkType: 'openai_completions',
    });

    expect(capabilities).toEqual(['chat']);
  });

  it('does not expose frozen channel capability overrides in model config', () => {
    const { service } = makeService();

    const config = (service as any).modelConfigFor(
      {
        modelConfigs: JSON.stringify({
          'kimi-k2': {
            routingPriority: 3,
            capabilityOverrides: { add: ['count_tokens'] },
            capability_overrides: { remove: ['embeddings'] },
          },
        }),
      },
      'kimi-k2',
    );

    expect(config).toEqual({
      routingPriority: 3,
    });
  });

  it('does not allow plaintext upstream keys in production even when env flag is set', () => {
    const { service } = makeService();
    const config = (service as any).config as { get: jest.Mock };
    config.get.mockImplementation((key: string) => {
      if (key === 'PUBLISHER_ALLOW_PLAINTEXT_UPSTREAM_KEYS') return 'true';
      if (key === 'NODE_ENV') return 'production';
      return undefined;
    });

    expect((service as any).toPublisherCiphertext('sk-prod-plaintext')).toBeNull();
  });
});
