import { ConfigService } from '@nestjs/config';
import { CompressionCodecs, CompressionTypes, Kafka } from 'kafkajs';
import crypto from 'node:crypto';
import { existsSync, readFileSync } from 'fs';
import { join } from 'path';
import { BillingUsageKafkaConsumerService } from './billing-usage-kafka-consumer.service';
import { GatewayRequestEventBillingService } from '../billing/gateway-request-event-billing.service';
import { GatewayFundingReservationQueuePendingError } from '../billing/billing.service';
import { GatewayBillingCurrencyMigrationRequiredError } from '../billing/usage-billing-strategy.service';
import {
  GatewayProvisionalExposureConfig,
  PROVISIONAL_EXPOSURE_SCHEMA_MIGRATION,
} from '../billing/gateway-provisional-exposure.config';
import { billingProvisionalExposureBoundarySeconds } from '../metrics/metrics.registry';
import { GatewayProvisionalExposureInvariantError } from '../billing/gateway-provisional-exposure.errors';
import { billingKafkaUsageCacheKey } from '../common/utils/redis-key.util';
import {
  billingUsageKafkaHmacVerificationsTotal,
  billingUsageKafkaMessagesTotal,
} from '../metrics/metrics.registry';
import { BILLING_USAGE_KAFKA_HMAC_SCHEME } from './billing-usage-kafka-hmac';

const TEST_HMAC_KEY_ID = 'usage-test-a';
const TEST_HMAC_SECRET = '0123456789abcdef0123456789abcdef';

function signKafkaUsage(
  secret: string,
  keyId: string,
  timestamp: string,
  body: Buffer,
): string {
  const payloadSha256 = crypto.createHash('sha256').update(body).digest('hex');
  return crypto.createHmac('sha256', secret).update([
    BILLING_USAGE_KAFKA_HMAC_SCHEME,
    keyId,
    timestamp,
    payloadSha256,
  ].join('\n')).digest('hex');
}

let mockConsumer: {
  connect: jest.Mock;
  subscribe: jest.Mock;
  run: jest.Mock;
  disconnect: jest.Mock;
  commitOffsets: jest.Mock;
};
let mockConsumerFactory: jest.Mock;
let mockProducer: {
  connect: jest.Mock;
  disconnect: jest.Mock;
  send: jest.Mock;
};
let mockProducerFactory: jest.Mock;

jest.mock('kafkajs', () => ({
  Kafka: jest.fn().mockImplementation(() => ({
    consumer: mockConsumerFactory,
    producer: mockProducerFactory,
  })),
  CompressionCodecs: {},
  CompressionTypes: { Snappy: 2 },
  logLevel: { INFO: 4 },
}));

describe('BillingUsageKafkaConsumerService', () => {
  beforeEach(() => {
    mockConsumer = {
      connect: jest.fn().mockResolvedValue(undefined),
      subscribe: jest.fn().mockResolvedValue(undefined),
      run: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      commitOffsets: jest.fn().mockResolvedValue(undefined),
    };
    mockConsumerFactory = jest.fn().mockReturnValue(mockConsumer);
    mockProducer = {
      connect: jest.fn().mockResolvedValue(undefined),
      disconnect: jest.fn().mockResolvedValue(undefined),
      send: jest.fn().mockResolvedValue(undefined),
    };
    mockProducerFactory = jest.fn().mockReturnValue(mockProducer);
    delete (CompressionCodecs as Record<number, unknown>)[CompressionTypes.Snappy];
    jest.clearAllMocks();
  });

  function buildService(values: Record<string, string | undefined> = {}) {
    const effectiveValues: Record<string, string | undefined> = {
      BILLING_GATEWAY_CLOCK_MAX_SKEW_MS: '5000',
      BILLING_GATEWAY_SETTLEMENT_PROTOCOL: 'v1',
      BILLING_PLATFORM_CURRENCY: 'usd',
      BILLING_USAGE_PENDING_MAX_REQUESTS: '100',
      BILLING_USAGE_EVIDENCE_CONTRACT_MODE: 'shadow',
      ...values,
    };
    const config = {
      get: jest.fn((key: string) => effectiveValues[key]),
    } as unknown as ConfigService;
    const gatewayRequestEventBilling = {
      assertReachableGatewayBillingAccountCurrencies: jest.fn().mockResolvedValue(undefined),
      assertProductionSettlementPreflight: jest.fn().mockResolvedValue(undefined),
      process: jest.fn().mockResolvedValue({
        action: 'deducted',
        requestId: 'req-1',
      }),
    };
    const redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    };

    return {
      service: new BillingUsageKafkaConsumerService(
        config,
        gatewayRequestEventBilling as never,
        redis as never,
      ),
      gatewayRequestEventBilling,
      redis,
    };
  }

  function productionKafkaConfig(
    values: Record<string, string | undefined> = {},
  ): Record<string, string | undefined> {
    return {
      APP_ENV: 'production',
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
      BILLING_USAGE_KAFKA_HMAC_MODE: 'required',
      BILLING_USAGE_KAFKA_HMAC_KEY_ID: TEST_HMAC_KEY_ID,
      BILLING_USAGE_KAFKA_HMAC_SECRET: TEST_HMAC_SECRET,
      BILLING_USAGE_KAFKA_DLQ_TOPIC: 'gateway.usage_events.dlq',
      ...values,
    };
  }

  function deferred<T>() {
    let resolve!: (value: T) => void;
    const promise = new Promise<T>((done) => {
      resolve = done;
    });
    return { promise, resolve };
  }

  function flushTasks() {
    return new Promise<void>((resolve) => {
      setImmediate(resolve);
    });
  }

  async function kafkaOutcomeCount(outcome: string): Promise<number> {
    const metric = await billingUsageKafkaMessagesTotal.get();
    return metric.values.find((value) => value.labels.outcome === outcome)?.value ?? 0;
  }

  async function hmacOutcomeCount(mode: string, outcome: string): Promise<number> {
    const metric = await billingUsageKafkaHmacVerificationsTotal.get();
    return metric.values.find((value) => (
      value.labels.mode === mode && value.labels.outcome === outcome
    ))?.value ?? 0;
  }

  // ⚠️ 这份 fixture 是 **billing 自己拥有的结算字段映射样本**，
  // **不**声明任何 gateway producer 可产出性。
  //
  // 历史上这里写成「优先读 gateway 仓的 usage_event_v2.sample.json、缺失才回落本地」，
  // 但 gateway 仓从来没有那个文件（该目录只有 4 个 schema.json + README）⇒
  // 这条「跨仓契约测试」的意图**从未实现**，而那段代码却让人以为已经实现了；
  // 它还 fail-open：环境变量指错路径也会静默回落本地副本。
  //
  // 因此这里**只读本地 fixture**，并把名字与用途都收窄到实情。
  // 真正的 producer 契约（「gateway 确实会产出这种形态」）需要 producer-owned golden bundle
  // —— 由 gateway 经真实构造路径生成样本并纳入其自身门禁、billing 按 revision 消费；
  // 那是独立一轮的跨仓能力建设，不在本轮范围。
  function loadBillingSettlementFixture(): Record<string, unknown> {
    return JSON.parse(
      readFileSync(join(__dirname, 'fixtures/usage_event_v2.sample.json'), 'utf8'),
    ) as Record<string, unknown>;
  }

  it('allows disabling Kafka usage ingestion outside production', async () => {
    const { service } = buildService({
      BILLING_USAGE_KAFKA_ENABLED: 'false',
    });

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(Kafka).not.toHaveBeenCalled();
  });

  it('requires Kafka usage ingestion in production because HTTP fallback is removed', async () => {
    const { service } = buildService({
      APP_ENV: 'production',
      BILLING_USAGE_KAFKA_ENABLED: 'false',
    });

    await expect(service.onModuleInit()).rejects.toThrow(
      'BILLING_USAGE_KAFKA_ENABLED=true is required in production',
    );
    expect(Kafka).not.toHaveBeenCalled();
  });

  it('fails production startup unless the immutable settlement protocol is explicit', async () => {
    const { service } = buildService({
      APP_ENV: 'production',
      BILLING_GATEWAY_SETTLEMENT_PROTOCOL: '',
      BILLING_USAGE_KAFKA_ENABLED: 'true',
    });

    await expect(service.onModuleInit()).rejects.toThrow(
      'BILLING_GATEWAY_SETTLEMENT_PROTOCOL=v1 is required in production',
    );
    expect(Kafka).not.toHaveBeenCalled();
  });

  it('fails production startup without an explicit platform currency', async () => {
    const { service } = buildService({
      APP_ENV: 'production',
      BILLING_PLATFORM_CURRENCY: '',
      BILLING_USAGE_KAFKA_ENABLED: 'true',
    });

    await expect(service.onModuleInit()).rejects.toThrow(
      'BILLING_PLATFORM_CURRENCY must be an explicit ISO-4217 code in production',
    );
    expect(Kafka).not.toHaveBeenCalled();
  });

  it('fails production startup when pending request count protection is disabled', async () => {
    const { service } = buildService({
      APP_ENV: 'production',
      BILLING_USAGE_PENDING_MAX_REQUESTS: '0',
      BILLING_USAGE_KAFKA_ENABLED: 'true',
    });

    await expect(service.onModuleInit()).rejects.toThrow(
      'BILLING_USAGE_PENDING_MAX_REQUESTS must be a positive integer in production',
    );
    expect(Kafka).not.toHaveBeenCalled();
  });

  it('fails production startup when unbound API keys may use the default PAYG fallback', async () => {
    const { service, gatewayRequestEventBilling } = buildService({
      APP_ENV: 'production',
      BILLING_ALLOW_DEFAULT_PAYG_FALLBACK: 'true',
      BILLING_USAGE_KAFKA_ENABLED: 'true',
    });

    await expect(service.onModuleInit()).rejects.toThrow(
      'BILLING_ALLOW_DEFAULT_PAYG_FALLBACK=false is required in production',
    );
    expect(gatewayRequestEventBilling.assertProductionSettlementPreflight)
      .not.toHaveBeenCalled();
    expect(Kafka).not.toHaveBeenCalled();
  });

  it('uses shadow evidence health semantics when the production mode is missing', async () => {
    const { service, gatewayRequestEventBilling } = buildService(productionKafkaConfig({
      BILLING_USAGE_EVIDENCE_CONTRACT_MODE: undefined,
    }));
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation();

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('safe shadow evidence semantics'),
    );
    expect(gatewayRequestEventBilling.assertProductionSettlementPreflight)
      .toHaveBeenCalledTimes(1);
    await service.onModuleDestroy();
  });

  it('uses shadow evidence health semantics for an unknown production mode', async () => {
    const { service, gatewayRequestEventBilling } = buildService(productionKafkaConfig({
      BILLING_USAGE_EVIDENCE_CONTRACT_MODE: 'audit',
    }));
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation();

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('safe shadow evidence semantics'),
    );
    expect(gatewayRequestEventBilling.assertProductionSettlementPreflight)
      .toHaveBeenCalledTimes(1);
    await service.onModuleDestroy();
  });

  it.each([
    ['', 'an empty allowlist'],
    ['9c6118a', 'a shortened commit SHA'],
    [`${'a'.repeat(40)},`, 'an empty allowlist entry'],
    [`sha256:${'b'.repeat(63)}`, 'a truncated sha256 digest'],
  ])(
    'reports production enforce allowlist issue for %s (%s) without blocking settlement',
    async (verifiedBuilds) => {
      const { service, gatewayRequestEventBilling } = buildService(productionKafkaConfig({
        BILLING_USAGE_EVIDENCE_CONTRACT_MODE: 'enforce',
        BILLING_USAGE_VERIFIED_PRODUCER_BUILDS: verifiedBuilds,
      }));
      const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation();

      await expect(service.onModuleInit()).resolves.toBeUndefined();
      expect(warn).toHaveBeenCalledWith(
        expect.stringContaining('continuing customer settlement'),
      );
      expect(gatewayRequestEventBilling.assertProductionSettlementPreflight)
        .toHaveBeenCalledTimes(1);
      await service.onModuleDestroy();
    },
  );

  it('starts production enforce only with a valid immutable producer allowlist', async () => {
    const { service, gatewayRequestEventBilling } = buildService({
      APP_ENV: 'production',
      BILLING_USAGE_EVIDENCE_CONTRACT_MODE: 'enforce',
      BILLING_USAGE_VERIFIED_PRODUCER_BUILDS: [
        '0123456789abcdef0123456789abcdef01234567',
        `sha256:${'a'.repeat(64)}`,
      ].join(','),
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
      BILLING_USAGE_KAFKA_HMAC_MODE: 'required',
      BILLING_USAGE_KAFKA_HMAC_KEY_ID: TEST_HMAC_KEY_ID,
      BILLING_USAGE_KAFKA_HMAC_SECRET: TEST_HMAC_SECRET,
      BILLING_USAGE_KAFKA_DLQ_TOPIC: 'gateway.usage_events.dlq',
    });

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(
      gatewayRequestEventBilling.assertProductionSettlementPreflight,
    ).toHaveBeenCalledTimes(1);
    expect(gatewayRequestEventBilling.assertProductionSettlementPreflight)
      .toHaveBeenCalledWith({ reachableCurrencyAlreadyAsserted: true });
    expect(gatewayRequestEventBilling.assertReachableGatewayBillingAccountCurrencies)
      .toHaveBeenCalledTimes(1);
    expect(mockConsumer.connect).toHaveBeenCalledTimes(1);
    expect(mockProducer.connect).toHaveBeenCalledTimes(1);

    await service.onModuleDestroy();
  });

  it('fails production before constructing Kafka when the database settlement preflight fails', async () => {
    const { service, gatewayRequestEventBilling } = buildService({
      APP_ENV: 'production',
      BILLING_USAGE_EVIDENCE_CONTRACT_MODE: 'enforce',
      BILLING_USAGE_VERIFIED_PRODUCER_BUILDS:
        '0123456789abcdef0123456789abcdef01234567',
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
    });
    gatewayRequestEventBilling.assertProductionSettlementPreflight
      .mockRejectedValueOnce(new Error('Release-B contract unavailable'));

    await expect(service.onModuleInit()).rejects.toThrow(
      'Release-B contract unavailable',
    );
    expect(Kafka).not.toHaveBeenCalled();
  });

  it('fails UAT before constructing Kafka when reachable account currency preflight fails', async () => {
    const { service, gatewayRequestEventBilling } = buildService({
      APP_ENV: 'uat',
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
    });
    gatewayRequestEventBilling.assertReachableGatewayBillingAccountCurrencies
      .mockRejectedValueOnce(new Error('reachable account currency mismatch'));

    await expect(service.onModuleInit()).rejects.toThrow(
      'reachable account currency mismatch',
    );
    expect(gatewayRequestEventBilling.assertReachableGatewayBillingAccountCurrencies)
      .toHaveBeenCalledTimes(1);
    expect(gatewayRequestEventBilling.assertProductionSettlementPreflight)
      .not.toHaveBeenCalled();
    expect(Kafka).not.toHaveBeenCalled();
    expect(mockConsumer.connect).not.toHaveBeenCalled();
  });

  it('reports an invalid production shadow allowlist without blocking settlement', async () => {
    const { service, gatewayRequestEventBilling } = buildService(productionKafkaConfig({
      BILLING_USAGE_EVIDENCE_CONTRACT_MODE: 'shadow',
      BILLING_USAGE_VERIFIED_PRODUCER_BUILDS: '9c6118a',
    }));
    const warn = jest.spyOn((service as any).logger, 'warn').mockImplementation();

    await expect(service.onModuleInit()).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledWith(
      expect.stringContaining('continuing customer settlement'),
    );
    expect(
      gatewayRequestEventBilling.assertProductionSettlementPreflight,
    ).toHaveBeenCalledTimes(1);
    await service.onModuleDestroy();
  });

  it('fails production startup when the Gateway clock skew bound is not measured', async () => {
    const { service } = buildService({
      APP_ENV: 'production',
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_GATEWAY_CLOCK_MAX_SKEW_MS: '',
    });

    await expect(service.onModuleInit()).rejects.toThrow(
      'BILLING_GATEWAY_CLOCK_MAX_SKEW_MS must be a measured positive integer in production',
    );
    expect(Kafka).not.toHaveBeenCalled();
  });

  it('starts the MSK consumer with SASL_SSL/SCRAM defaults and manual commit', async () => {
    const { service } = buildService({
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096,b-2.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
    });

    await service.onModuleInit();

    expect(Kafka).toHaveBeenCalledWith(expect.objectContaining({
      brokers: ['b-1.msk:9096', 'b-2.msk:9096'],
      ssl: true,
      sasl: {
        mechanism: 'scram-sha-512',
        username: 'billing',
        password: 'secret',
      },
      connectionTimeout: 10_000,
      requestTimeout: 30_000,
      retry: { retries: 3 },
    }));
    expect((CompressionCodecs as Record<number, unknown>)[CompressionTypes.Snappy]).toEqual(expect.any(Function));
    expect(mockConsumerFactory).toHaveBeenCalledWith({
      groupId: 'billing-ledger-v1',
    });
    expect(mockConsumer.subscribe).toHaveBeenCalledWith({
      topic: 'gateway.usage_events',
      fromBeginning: false,
    });
    expect(mockConsumer.run).toHaveBeenCalledWith(expect.objectContaining({
      autoCommit: false,
      partitionsConsumedConcurrently: 3,
      eachMessage: expect.any(Function),
    }));
  });

  it('accepts generic Kafka env aliases from deployment systems', async () => {
    const { service } = buildService({
      KAFKA_ENABLED: 'true',
      KAFKA_BROKERS: 'b-1.msk:9096,b-2.msk:9096',
      KAFKA_USERNAME: 'billing',
      KAFKA_PASSWORD: 'secret',
      KAFKA_GROUP_ID: 'tokenplatform_event',
      KAFKA_TOPICS: 'gateway.usage_events',
      KAFKA_SSL: 'true',
      KAFKA_SASL_MECHANISM: 'scram-sha-512',
    });

    await service.onModuleInit();

    expect(Kafka).toHaveBeenCalledWith(expect.objectContaining({
      brokers: ['b-1.msk:9096', 'b-2.msk:9096'],
      ssl: true,
      sasl: expect.objectContaining({
        mechanism: 'scram-sha-512',
        username: 'billing',
        password: 'secret',
      }),
    }));
    expect(mockConsumerFactory).toHaveBeenCalledWith({
      groupId: 'tokenplatform_event',
    });
    expect(mockConsumer.subscribe).toHaveBeenCalledWith({
      topic: 'gateway.usage_events',
      fromBeginning: false,
    });
  });

  it('rejects RequestEvent topics because they are audit-only', async () => {
    const { service } = buildService({
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
      BILLING_USAGE_KAFKA_TOPICS: 'gateway.request_events',
    });

    await expect(service.onModuleInit()).rejects.toThrow(
      'RequestEvent topics are audit-only',
    );
    expect(mockConsumer.connect).not.toHaveBeenCalled();
  });

  it('parses the billing-owned settlement fixture and deducts from usage facts', async () => {
    const usageBilling = {
      assertReachableGatewayBillingAccountCurrencies: jest.fn().mockResolvedValue(undefined),
      reserveGatewayBalanceFunding: jest.fn().mockResolvedValue({
        status: 'ACTIVE',
        reviewReason: null,
      }),
      settleDeliveredGatewayUsage: jest.fn().mockResolvedValue({
        success: true,
        allowed: true,
      }),
    };
    const prisma: Record<string, any> = {
      gatewayBillingEvent: {
        upsert: jest.fn().mockResolvedValue({
          id: 'gateway-event-1',
          revision: 0,
          evidenceHash: 'original-evidence-hash',
        }),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        findUnique: jest.fn().mockResolvedValue(null),
        findUniqueOrThrow: jest.fn().mockResolvedValue({
          id: 'gateway-event-1',
          evidenceHash: 'original-evidence-hash',
          billingAccountId: 'billing-account-1',
          apiKeyId: 'key-contract-001',
        }),
      },
      gatewayUsageEvidence: {
        count: jest.fn().mockResolvedValue(0),
        createMany: jest.fn().mockResolvedValue({ count: 1 }),
      },
      gatewayUsageSettlementReceipt: {
        create: jest.fn().mockResolvedValue({}),
      },
      billingAccessRestriction: {
        upsert: jest.fn().mockResolvedValue({}),
      },
    };
    prisma.$transaction = jest.fn(async (callback: (tx: typeof prisma) => unknown) => callback(prisma));
    prisma.$queryRaw = jest.fn().mockResolvedValue([]);
    const redis = {
      get: jest.fn().mockResolvedValue(null),
      set: jest.fn().mockResolvedValue('OK'),
    };
    const config = {
      get: jest.fn((key: string) => ({
        BILLING_USAGE_KAFKA_ENABLED: 'true',
        BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
        BILLING_USAGE_KAFKA_USERNAME: 'billing',
        BILLING_USAGE_KAFKA_PASSWORD: 'secret',
      } as Record<string, string | undefined>)[key]),
    } as unknown as ConfigService;
    const sample = loadBillingSettlementFixture();
    const gatewayUsageBilling = new GatewayRequestEventBillingService(
      usageBilling as never,
      prisma as never,
    );
    // This consumer contract test owns Kafka envelope parsing/mapping. The
    // first-receipt transaction and hash validation are covered by the Gateway
    // billing service suite, so inject an already-validated immutable anchor.
    jest.spyOn(gatewayUsageBilling as any, 'recordReceived').mockResolvedValue({
      eventId: 'gateway-event-1',
      existingStatus: null,
      existingReconciliationStatus: null,
      revision: 0,
      evidenceHash: 'evidence-contract-1',
      originalEvidenceHash: 'evidence-contract-1',
      firstReceiptCreated: true,
      fundingReservationStatus: 'ACTIVE',
      settlementAnchor: {
        requestId: sample.request_id,
        apiKeyId: sample.key_id,
        userId: 'user-contract-001',
        tenantId: 'tenant-contract-001',
        billingAccountId: 'billing-account-1',
        productId: 'prod-payg',
        productSlug: 'payg',
        billingUnit: 'BALANCE',
        billingCurrency: 'USD',
        codingPlanEntitlementId: null,
        subscriptionId: null,
        planId: null,
        occurredAt: new Date('2026-02-08T08:30:15.123Z'),
        firstReceivedAt: new Date('2026-02-08T08:30:16.000Z'),
        customerSettlementPolicyVersion: 'gateway-customer-settlement-v2',
        firstReceiptSequence: 1n,
        fundingReservationProtocol: 'V1',
        pricingHash: 'pricing-contract-1',
        customerQuoteSnapshot: {
          unit: 'BALANCE',
          userId: 'user-contract-001',
          tenantId: 'tenant-contract-001',
          billingAccountId: 'billing-account-1',
          productId: 'prod-payg',
          productSlug: 'payg',
          modelName: 'gpt-4o',
          inputTokens: 1000,
          outputTokens: 525,
          cachedInputTokens: 100,
          cacheWriteInputTokens: 50,
          imageCount: 0,
          effectiveCostUsd: '0.001',
        },
        customerPricingSnapshot: {
          unit: 'BALANCE',
          tokenUsagePricing: {
            status: 'VERIFIED',
            costUsd: '0.001',
            inputPriceUsdPerM: '1',
            cachedInputPriceUsdPerM: '0.2',
            cacheWritePriceUsdPerM: '1',
            outputPriceUsdPerM: '2',
          },
        },
        providerCostSnapshot: {},
        anchorHash: 'anchor-contract-1',
        entitlementSnapshot: null,
        planSnapshot: null,
      },
    });
    const service = new BillingUsageKafkaConsumerService(
      config,
      gatewayUsageBilling,
      redis as never,
    );

    await service.onModuleInit();

    const runArgs = mockConsumer.run.mock.calls[0][0];
    await runArgs.eachMessage({
      topic: 'gateway.usage_events',
      partition: 0,
      message: {
        key: Buffer.from(String(sample.request_id)),
        value: Buffer.from(JSON.stringify({ usage_event: sample })),
        offset: '9',
      },
    });

    expect(usageBilling.settleDeliveredGatewayUsage).toHaveBeenCalledWith({
      apiKeyId: 'key-contract-001',
      tenantId: 'tenant-contract-001',
      userId: 'user-contract-001',
      email: undefined,
      productId: 'prod-payg',
      productSlug: 'payg',
      modelName: 'gpt-4o',
      inputTokens: 1000,
      outputTokens: 525,
      cachedInputTokens: 100,
      cacheWriteInputTokens: 50,
      totalTokens: 1525,
      imageCount: 0,
      billingUnit: 'BALANCE',
      providerCode: 'openai',
      callType: 'chat',
      upstreamModel: 'gpt-4o-2024-08-06',
      source: 'gateway:us-east-1:openai:gpt-4o',
      requestId: 'req-contract-usage-v2-001',
      idempotencyKey: 'gateway:request:req-contract-usage-v2-001',
      eventOccurredAt: new Date('2026-02-08T08:30:15.123Z'),
      recordTokenUsage: true,
      allowNegativeBalance: false,
      gatewayCustomerSettlement: {
        policyVersion: 'gateway-customer-settlement-v2',
        basis: 'NORMALIZED_EXACT',
        evidenceReason: 'evidence_contract_producer_build_unverified',
        originalDimensions: {
          inputTokens: 1000,
          outputTokens: 525,
          cachedInputTokens: 100,
          cacheWriteInputTokens: 50,
          totalTokens: 1525,
          imageCount: 0,
        },
        settledDimensions: {
          inputTokens: 1000,
          outputTokens: 525,
          cachedInputTokens: 100,
          cacheWriteInputTokens: 50,
          totalTokens: 1525,
          imageCount: 0,
        },
      },
    }, expect.objectContaining({
      gatewayBillingEventId: 'gateway-event-1',
      evidenceHash: 'evidence-contract-1',
      anchor: expect.objectContaining({
        requestId: 'req-contract-usage-v2-001',
        billingUnit: 'BALANCE',
      }),
    }));
    expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([{
      topic: 'gateway.usage_events',
      partition: 0,
      offset: '10',
    }]);
  });

  it('commits offset+1 only after event billing succeeds', async () => {
    const committedBefore = await kafkaOutcomeCount('committed');
    const { service, gatewayRequestEventBilling, redis } = buildService({
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
    });

    await service.onModuleInit();

    const runArgs = mockConsumer.run.mock.calls[0][0];
    await runArgs.eachMessage({
      topic: 'gateway.usage_events',
      partition: 2,
      message: {
        key: Buffer.from('req-1'),
        value: Buffer.from(JSON.stringify({
          usage_event: { request_id: 'req-1' },
        })),
        offset: '41',
      },
    });

    expect(gatewayRequestEventBilling.process).toHaveBeenCalledWith({
      request_id: 'req-1',
    });
    expect(redis.set).toHaveBeenCalledWith(
      billingKafkaUsageCacheKey('req-1'),
      expect.stringContaining('"requestId":"req-1"'),
      'EX',
      86_400,
    );
    expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([{
      topic: 'gateway.usage_events',
      partition: 2,
      offset: '42',
    }]);
    await expect(kafkaOutcomeCount('committed')).resolves.toBe(committedBefore + 1);
  });

  it('does not commit or DLQ a database failure and settles once after redelivery', async () => {
    const transientBefore = await kafkaOutcomeCount('transient_uncommitted');
    const { service, gatewayRequestEventBilling } = buildService({
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
      BILLING_USAGE_KAFKA_DLQ_TOPIC: 'gateway.usage_events.dlq',
      BILLING_USAGE_KAFKA_MESSAGE_RETRIES: '1',
    });
    let successfulSettlements = 0;
    gatewayRequestEventBilling.process
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockImplementationOnce(async () => {
        successfulSettlements += 1;
        return { action: 'deducted', requestId: 'req-db-recovery' };
      });

    await service.onModuleInit();

    const runArgs = mockConsumer.run.mock.calls[0][0];
    const sourceMessage = {
      topic: 'gateway.usage_events',
      partition: 2,
      message: {
        key: Buffer.from('req-db-recovery'),
        value: Buffer.from(JSON.stringify({ request_id: 'req-db-recovery' })),
        offset: '71',
      },
    };

    await expect(runArgs.eachMessage(sourceMessage)).rejects.toThrow('database unavailable');
    expect(mockProducer.send).not.toHaveBeenCalled();
    expect(mockConsumer.commitOffsets).not.toHaveBeenCalled();
    expect(successfulSettlements).toBe(0);
    await expect(kafkaOutcomeCount('transient_uncommitted'))
      .resolves.toBe(transientBefore + 1);

    await expect(runArgs.eachMessage(sourceMessage)).resolves.toBeUndefined();
    expect(gatewayRequestEventBilling.process).toHaveBeenCalledTimes(2);
    expect(successfulSettlements).toBe(1);
    expect(mockProducer.send).not.toHaveBeenCalled();
    expect(mockConsumer.commitOffsets).toHaveBeenCalledTimes(1);
    expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([{
      topic: 'gateway.usage_events',
      partition: 2,
      offset: '72',
    }]);
  });

  it('retains the source offset when account currency migration is required', async () => {
    const { service, gatewayRequestEventBilling } = buildService({
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
      BILLING_USAGE_KAFKA_DLQ_TOPIC: 'gateway.usage_events.dlq',
      BILLING_USAGE_KAFKA_MESSAGE_RETRIES: '1',
    });
    const currencyError = new GatewayBillingCurrencyMigrationRequiredError(
      'USD',
      'CNY',
      'billing-account-1',
      'key-1',
    );
    gatewayRequestEventBilling.process.mockRejectedValueOnce(currencyError);

    await service.onModuleInit();
    const runArgs = mockConsumer.run.mock.calls[0][0];
    await expect(runArgs.eachMessage({
      topic: 'gateway.usage_events',
      partition: 2,
      message: {
        key: Buffer.from('req-currency-migration'),
        value: Buffer.from(JSON.stringify({ request_id: 'req-currency-migration' })),
        offset: '72',
      },
    })).rejects.toBe(currencyError);

    expect(mockProducer.send).not.toHaveBeenCalled();
    expect(mockConsumer.commitOffsets).not.toHaveBeenCalled();
  });

  it('keeps a bigint-backed funding queue wait retryable and JSON-log-safe', async () => {
    const { service, gatewayRequestEventBilling } = buildService({
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
      BILLING_USAGE_KAFKA_DLQ_TOPIC: 'gateway.usage_events.dlq',
      BILLING_USAGE_KAFKA_MESSAGE_RETRIES: '1',
    });
    const queuePending = new GatewayFundingReservationQueuePendingError(
      'billing-account-1',
      'request-later',
      'request-blocking',
      9_007_199_254_740_993n,
    );
    gatewayRequestEventBilling.process.mockRejectedValueOnce(queuePending);

    await service.onModuleInit();

    const runArgs = mockConsumer.run.mock.calls[0][0];
    const sourceMessage = {
      topic: 'gateway.usage_events',
      partition: 2,
      message: {
        key: Buffer.from('request-later'),
        value: Buffer.from(JSON.stringify({ request_id: 'request-later' })),
        offset: '72',
      },
    };

    await expect(runArgs.eachMessage(sourceMessage)).rejects.toBe(queuePending);
    expect(() => JSON.stringify({ error: queuePending })).not.toThrow();
    expect(queuePending.blockingSequence).toBe('9007199254740993');
    expect(mockProducer.send).not.toHaveBeenCalled();
    expect(mockConsumer.commitOffsets).not.toHaveBeenCalled();
  });

  it('commits quarantined events without writing a terminal Redis result', async () => {
    const { service, gatewayRequestEventBilling, redis } = buildService({
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
    });
    gatewayRequestEventBilling.process.mockResolvedValueOnce({
      action: 'quarantined',
      requestId: 'req-quarantined',
      reason: 'usage_evidence_incomplete',
    });

    await service.onModuleInit();

    const runArgs = mockConsumer.run.mock.calls[0][0];
    await runArgs.eachMessage({
      topic: 'gateway.usage_events',
      partition: 2,
      message: {
        key: Buffer.from('req-quarantined'),
        value: Buffer.from(JSON.stringify({ request_id: 'req-quarantined' })),
        offset: '51',
      },
    });

    expect(gatewayRequestEventBilling.process).toHaveBeenCalledWith({
      request_id: 'req-quarantined',
    });
    expect(redis.set).not.toHaveBeenCalled();
    expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([{
      topic: 'gateway.usage_events',
      partition: 2,
      offset: '52',
    }]);
  });

  it('hashes external request ids before using them as Redis cache keys', async () => {
    const requestId = 'req\r\nINJECT';
    const { service, gatewayRequestEventBilling, redis } = buildService({
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
    });
    gatewayRequestEventBilling.process.mockResolvedValueOnce({
      action: 'deducted',
      requestId,
    });

    await service.onModuleInit();

    const runArgs = mockConsumer.run.mock.calls[0][0];
    await runArgs.eachMessage({
      topic: 'gateway.usage_events',
      partition: 2,
      message: {
        key: Buffer.from(requestId),
        value: Buffer.from(JSON.stringify({ request_id: requestId })),
        offset: '41',
      },
    });

    expect(redis.get).not.toHaveBeenCalled();
    expect(redis.set).toHaveBeenCalledWith(
      billingKafkaUsageCacheKey(requestId),
      expect.stringContaining(`"requestId":"${requestId.replace('\r', '\\r').replace('\n', '\\n')}"`),
      'EX',
      86_400,
    );
    for (const key of redis.set.mock.calls.map((call: unknown[]) => call[0])) {
      expect(key).not.toContain('\r');
      expect(key).not.toContain('\n');
    }
  });

  it('always reprocesses cached messages through the permanent database inbox', async () => {
    const { service, gatewayRequestEventBilling, redis } = buildService({
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
    });
    redis.get.mockResolvedValueOnce(JSON.stringify({ action: 'deducted', requestId: 'req-1' }));

    await service.onModuleInit();

    const runArgs = mockConsumer.run.mock.calls[0][0];
    await runArgs.eachMessage({
      topic: 'gateway.usage_events',
      partition: 2,
      message: {
        key: Buffer.from('req-1'),
        value: Buffer.from(JSON.stringify({ usage_event: { request_id: 'req-1' } })),
        offset: '41',
      },
    });

    expect(redis.get).not.toHaveBeenCalled();
    expect(gatewayRequestEventBilling.process).toHaveBeenCalledWith({
      request_id: 'req-1',
    });
    expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([{
      topic: 'gateway.usage_events',
      partition: 2,
      offset: '42',
    }]);
  });

  it('does not let a legacy pending Redis result suppress reconciliation reprocessing', async () => {
    const { service, gatewayRequestEventBilling, redis } = buildService({
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
    });
    redis.get.mockResolvedValueOnce(JSON.stringify({
      action: 'pending',
      requestId: 'req-pending',
    }));
    gatewayRequestEventBilling.process.mockResolvedValueOnce({
      action: 'deducted',
      requestId: 'req-pending',
    });

    await service.onModuleInit();

    const runArgs = mockConsumer.run.mock.calls[0][0];
    await runArgs.eachMessage({
      topic: 'gateway.usage_events',
      partition: 2,
      message: {
        key: Buffer.from('req-pending'),
        value: Buffer.from(JSON.stringify({ request_id: 'req-pending' })),
        offset: '61',
      },
    });

    expect(gatewayRequestEventBilling.process).toHaveBeenCalledWith({
      request_id: 'req-pending',
    });
    expect(redis.set).toHaveBeenCalledWith(
      billingKafkaUsageCacheKey('req-pending'),
      expect.stringContaining('"action":"deducted"'),
      'EX',
      86_400,
    );
    expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([{
      topic: 'gateway.usage_events',
      partition: 2,
      offset: '62',
    }]);
  });

  it('does not depend on Redis cache reads when processing usage evidence', async () => {
    const { service, gatewayRequestEventBilling, redis } = buildService({
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
    });
    redis.get.mockRejectedValueOnce(new Error('redis down'));

    await service.onModuleInit();

    const runArgs = mockConsumer.run.mock.calls[0][0];
    await runArgs.eachMessage({
      topic: 'gateway.usage_events',
      partition: 2,
      message: {
        key: Buffer.from('req-redis-read'),
        value: Buffer.from(JSON.stringify({ request_id: 'req-redis-read' })),
        offset: '41',
      },
    });

    expect(gatewayRequestEventBilling.process).toHaveBeenCalledWith({
      request_id: 'req-redis-read',
    });
    expect(redis.get).not.toHaveBeenCalled();
    expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([{
      topic: 'gateway.usage_events',
      partition: 2,
      offset: '42',
    }]);
  });

  it('commits processed messages even when Redis idempotency cache write fails', async () => {
    const { service, gatewayRequestEventBilling, redis } = buildService({
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
    });
    redis.set.mockRejectedValueOnce(new Error('redis down'));
    gatewayRequestEventBilling.process.mockResolvedValueOnce({
      action: 'deducted',
      requestId: 'req-redis-write',
    });

    await service.onModuleInit();

    const runArgs = mockConsumer.run.mock.calls[0][0];
    await runArgs.eachMessage({
      topic: 'gateway.usage_events',
      partition: 2,
      message: {
        key: Buffer.from('req-redis-write'),
        value: Buffer.from(JSON.stringify({ request_id: 'req-redis-write' })),
        offset: '41',
      },
    });

    expect(gatewayRequestEventBilling.process).toHaveBeenCalledWith({
      request_id: 'req-redis-write',
    });
    expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([{
      topic: 'gateway.usage_events',
      partition: 2,
      offset: '42',
    }]);
  });

  it('limits in-flight message processing across partitions', async () => {
    const { service, gatewayRequestEventBilling } = buildService({
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
      BILLING_USAGE_KAFKA_MAX_IN_FLIGHT: '1',
    });
    const first = deferred<{ action: 'deducted'; requestId: string }>();
    gatewayRequestEventBilling.process
      .mockReturnValueOnce(first.promise)
      .mockResolvedValueOnce({ action: 'deducted', requestId: 'req-2' });

    await service.onModuleInit();

    const runArgs = mockConsumer.run.mock.calls[0][0];
    const p1 = runArgs.eachMessage({
      topic: 'gateway.usage_events',
      partition: 0,
      message: {
        key: Buffer.from('req-1'),
        value: Buffer.from(JSON.stringify({ request_id: 'req-1' })),
        offset: '1',
      },
    });
    await flushTasks();
    expect(gatewayRequestEventBilling.process).toHaveBeenCalledTimes(1);

    const p2 = runArgs.eachMessage({
      topic: 'gateway.usage_events',
      partition: 1,
      message: {
        key: Buffer.from('req-2'),
        value: Buffer.from(JSON.stringify({ request_id: 'req-2' })),
        offset: '8',
      },
    });
    await flushTasks();
    expect(gatewayRequestEventBilling.process).toHaveBeenCalledTimes(1);

    first.resolve({ action: 'deducted', requestId: 'req-1' });
    await p1;
    await flushTasks();
    expect(gatewayRequestEventBilling.process).toHaveBeenCalledTimes(2);
    await p2;
  });

  it('verifies the Kafka usage HMAC v1 envelope in required mode', async () => {
    const body = Buffer.from(JSON.stringify({ request_id: 'req-1' }));
    const ts = Math.floor(Date.now() / 1000).toString();
    const signature = signKafkaUsage(TEST_HMAC_SECRET, TEST_HMAC_KEY_ID, ts, body);
    const { service, gatewayRequestEventBilling } = buildService({
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
      BILLING_USAGE_KAFKA_HMAC_MODE: 'required',
      BILLING_USAGE_KAFKA_HMAC_KEY_ID: TEST_HMAC_KEY_ID,
      BILLING_USAGE_KAFKA_HMAC_SECRET: TEST_HMAC_SECRET,
    });

    await service.onModuleInit();

    const runArgs = mockConsumer.run.mock.calls[0][0];
    await runArgs.eachMessage({
      topic: 'gateway.usage_events',
      partition: 0,
      message: {
        key: Buffer.from('req-1'),
        value: body,
        offset: '1',
        headers: {
          'x-billing-key-id': Buffer.from(TEST_HMAC_KEY_ID),
          'x-billing-timestamp': Buffer.from(ts),
          'x-billing-signature': Buffer.from(signature),
        },
      },
    });

    expect(gatewayRequestEventBilling.process).toHaveBeenCalledWith({ request_id: 'req-1' });
  });

  it('accepts an authentic Kafka record after a long consumer outage', async () => {
    const body = Buffer.from(JSON.stringify({ request_id: 'req-backlog-24h' }));
    const ts = Math.floor(Date.now() / 1000 - 24 * 60 * 60).toString();
    const signature = signKafkaUsage(TEST_HMAC_SECRET, TEST_HMAC_KEY_ID, ts, body);
    const { service, gatewayRequestEventBilling } = buildService({
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
      BILLING_USAGE_KAFKA_HMAC_MODE: 'required',
      BILLING_USAGE_KAFKA_HMAC_KEY_ID: TEST_HMAC_KEY_ID,
      BILLING_USAGE_KAFKA_HMAC_SECRET: TEST_HMAC_SECRET,
    });

    await service.onModuleInit();

    const runArgs = mockConsumer.run.mock.calls[0][0];
    await runArgs.eachMessage({
      topic: 'gateway.usage_events',
      partition: 0,
      message: {
        key: Buffer.from('req-backlog-24h'),
        value: body,
        offset: '2',
        headers: {
          'x-billing-key-id': Buffer.from(TEST_HMAC_KEY_ID),
          'x-billing-timestamp': Buffer.from(ts),
          'x-billing-signature': Buffer.from(signature),
        },
      },
    });

    expect(gatewayRequestEventBilling.process).toHaveBeenCalledWith({
      request_id: 'req-backlog-24h',
    });
    expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([{
      topic: 'gateway.usage_events',
      partition: 0,
      offset: '3',
    }]);
  });

  it('authenticates exact bytes but rejects invalid UTF-8 before JSON parsing', async () => {
    const body = Buffer.from([0x7b, 0x22, 0x78, 0x22, 0x3a, 0x22, 0xff, 0x22, 0x7d]);
    const timestamp = '1786752000';
    const signature = signKafkaUsage(
      TEST_HMAC_SECRET,
      TEST_HMAC_KEY_ID,
      timestamp,
      body,
    );
    const { service, gatewayRequestEventBilling } = buildService({
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
      BILLING_USAGE_KAFKA_HMAC_MODE: 'required',
      BILLING_USAGE_KAFKA_HMAC_KEY_ID: TEST_HMAC_KEY_ID,
      BILLING_USAGE_KAFKA_HMAC_SECRET: TEST_HMAC_SECRET,
      BILLING_USAGE_KAFKA_DLQ_TOPIC: 'gateway.usage_events.dlq',
      BILLING_USAGE_KAFKA_MESSAGE_RETRIES: '1',
    });

    await service.onModuleInit();
    const runArgs = mockConsumer.run.mock.calls[0][0];
    await runArgs.eachMessage({
      topic: 'gateway.usage_events',
      partition: 0,
      message: {
        key: Buffer.from('invalid-utf8'),
        value: body,
        offset: '7',
        headers: {
          'x-billing-key-id': TEST_HMAC_KEY_ID,
          'x-billing-timestamp': timestamp,
          'x-billing-signature': signature,
        },
      },
    });

    expect(gatewayRequestEventBilling.process).not.toHaveBeenCalled();
    const dlqEnvelope = JSON.parse(mockProducer.send.mock.calls[0][0].messages[0].value);
    expect(dlqEnvelope).toEqual(expect.objectContaining({
      poisonReason: 'invalid_json',
      payloadBase64: body.toString('base64'),
    }));
  });

  it('DLQs a required-mode authentication failure once with binary-safe evidence', async () => {
    const poisonBefore = await kafkaOutcomeCount('poison_dlq');
    const hmacFailureBefore = await hmacOutcomeCount('required', 'invalid_signature_format');
    const body = JSON.stringify({ request_id: 'req-bad-signature' });
    const signatureTimestamp = Math.floor(Date.now() / 1000).toString();
    const sourceTimestamp = Date.now().toString();
    const sourceKey = Buffer.from([0x00, 0xff, 0x41]);
    const invalidSignature = Buffer.from([0xff, 0x00, 0x41]);
    const { service, gatewayRequestEventBilling } = buildService({
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
      BILLING_USAGE_KAFKA_HMAC_MODE: 'required',
      BILLING_USAGE_KAFKA_HMAC_KEY_ID: TEST_HMAC_KEY_ID,
      BILLING_USAGE_KAFKA_HMAC_SECRET: TEST_HMAC_SECRET,
      BILLING_USAGE_KAFKA_DLQ_TOPIC: 'gateway.usage_events.dlq',
      BILLING_USAGE_KAFKA_MESSAGE_RETRIES: '5',
      BILLING_USAGE_KAFKA_MESSAGE_RETRY_DELAY_MS: '1',
    });

    await service.onModuleInit();
    const sleep = jest.spyOn(service as any, 'sleep');

    const runArgs = mockConsumer.run.mock.calls[0][0];
    await expect(runArgs.eachMessage({
      topic: 'gateway.usage_events',
      partition: 3,
      message: {
        key: sourceKey,
        value: Buffer.from(body),
        offset: '81',
        timestamp: sourceTimestamp,
        headers: {
          'x-billing-key-id': Buffer.from(TEST_HMAC_KEY_ID),
          'x-billing-timestamp': Buffer.from(signatureTimestamp),
          'x-billing-signature': invalidSignature,
          'x-not-authentication': Buffer.from('not-copied'),
        },
      },
    })).resolves.toBeUndefined();

    expect(gatewayRequestEventBilling.process).not.toHaveBeenCalled();
    expect(sleep).not.toHaveBeenCalled();
    expect(mockProducer.send).toHaveBeenCalledTimes(1);
    const dlqSend = mockProducer.send.mock.calls[0][0];
    const dlqMessage = dlqSend.messages[0];
    const envelope = JSON.parse(dlqMessage.value);
    expect(dlqSend.topic).toBe('gateway.usage_events.dlq');
    expect(dlqMessage.key).toEqual(sourceKey);
    expect(dlqMessage.timestamp).toBe(sourceTimestamp);
    expect(dlqMessage.headers['x-billing-dlq-reason']).toEqual(
      Buffer.from('invalid_hmac_headers'),
    );
    expect(envelope).toEqual(expect.objectContaining({
      sourceTopic: 'gateway.usage_events',
      partition: 3,
      offset: '81',
      sourceKey: {
        encoding: 'base64',
        value: sourceKey.toString('base64'),
      },
      sourceTimestamp,
      poisonReason: 'invalid_hmac_headers',
      payloadBase64: Buffer.from(body).toString('base64'),
      authenticationHeaders: [
        {
          name: 'x-billing-key-id',
          values: [{
            encoding: 'base64',
            value: Buffer.from(TEST_HMAC_KEY_ID).toString('base64'),
          }],
        },
        {
          name: 'x-billing-timestamp',
          values: [{
            encoding: 'base64',
            value: Buffer.from(signatureTimestamp).toString('base64'),
          }],
        },
        {
          name: 'x-billing-signature',
          values: [{
            encoding: 'base64',
            value: invalidSignature.toString('base64'),
          }],
        },
      ],
    }));
    expect(JSON.stringify(envelope)).not.toContain('not-copied');
    expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([{
      topic: 'gateway.usage_events',
      partition: 3,
      offset: '82',
    }]);
    await expect(kafkaOutcomeCount('poison_dlq')).resolves.toBe(poisonBefore + 1);
    await expect(hmacOutcomeCount('required', 'invalid_signature_format'))
      .resolves.toBe(hmacFailureBefore + 1);
  });

  it('measures an invalid shadow signature and continues normal billing', async () => {
    const invalidBefore = await hmacOutcomeCount('shadow', 'invalid_signature');
    const body = Buffer.from(JSON.stringify({ request_id: 'req-shadow-hmac' }));
    const timestamp = '1786752000';
    const { service, gatewayRequestEventBilling } = buildService({
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
      BILLING_USAGE_KAFKA_HMAC_MODE: 'shadow',
      BILLING_USAGE_KAFKA_HMAC_KEY_ID: TEST_HMAC_KEY_ID,
      BILLING_USAGE_KAFKA_HMAC_SECRET: TEST_HMAC_SECRET,
    });

    await service.onModuleInit();
    const runArgs = mockConsumer.run.mock.calls[0][0];
    await runArgs.eachMessage({
      topic: 'gateway.usage_events',
      partition: 0,
      message: {
        key: Buffer.from('req-shadow-hmac'),
        value: body,
        offset: '8',
        headers: {
          'x-billing-key-id': TEST_HMAC_KEY_ID,
          'x-billing-timestamp': timestamp,
          'x-billing-signature': '0'.repeat(64),
        },
      },
    });

    expect(gatewayRequestEventBilling.process).toHaveBeenCalledWith({
      request_id: 'req-shadow-hmac',
    });
    expect(mockProducer.send).not.toHaveBeenCalled();
    expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([{
      topic: 'gateway.usage_events',
      partition: 0,
      offset: '9',
    }]);
    await expect(hmacOutcomeCount('shadow', 'invalid_signature'))
      .resolves.toBe(invalidBefore + 1);
  });

  it('accepts a rotating key loaded from the bounded in-memory keyring', async () => {
    const rotatingKeyId = 'usage-region-b';
    const rotatingSecret = 'fedcba9876543210fedcba9876543210';
    const body = Buffer.from(JSON.stringify({ request_id: 'req-rotating-key' }));
    const timestamp = '1786752000';
    const signature = signKafkaUsage(rotatingSecret, rotatingKeyId, timestamp, body);
    const { service, gatewayRequestEventBilling } = buildService({
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
      BILLING_USAGE_KAFKA_HMAC_MODE: 'required',
      BILLING_USAGE_KAFKA_HMAC_KEY_ID: TEST_HMAC_KEY_ID,
      BILLING_USAGE_KAFKA_HMAC_SECRET: TEST_HMAC_SECRET,
      BILLING_USAGE_KAFKA_HMAC_KEYRING_JSON: JSON.stringify({
        [rotatingKeyId]: rotatingSecret,
      }),
    });

    await service.onModuleInit();
    const runArgs = mockConsumer.run.mock.calls[0][0];
    await runArgs.eachMessage({
      topic: 'gateway.usage_events',
      partition: 0,
      message: {
        key: Buffer.from('req-rotating-key'),
        value: body,
        offset: '9',
        headers: {
          'x-billing-key-id': rotatingKeyId,
          'x-billing-timestamp': timestamp,
          'x-billing-signature': signature,
        },
      },
    });

    expect(gatewayRequestEventBilling.process).toHaveBeenCalledWith({
      request_id: 'req-rotating-key',
    });
  });

  it('uses only bounded outcome labels for an unknown key id', async () => {
    const unknownBefore = await hmacOutcomeCount('required', 'unknown_key_id');
    const { service, gatewayRequestEventBilling } = buildService({
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
      BILLING_USAGE_KAFKA_HMAC_MODE: 'required',
      BILLING_USAGE_KAFKA_HMAC_KEY_ID: TEST_HMAC_KEY_ID,
      BILLING_USAGE_KAFKA_HMAC_SECRET: TEST_HMAC_SECRET,
      BILLING_USAGE_KAFKA_DLQ_TOPIC: 'gateway.usage_events.dlq',
    });

    await service.onModuleInit();
    const runArgs = mockConsumer.run.mock.calls[0][0];
    await runArgs.eachMessage({
      topic: 'gateway.usage_events',
      partition: 0,
      message: {
        key: Buffer.from('req-unknown-kid'),
        value: Buffer.from(JSON.stringify({ request_id: 'req-unknown-kid' })),
        offset: '10',
        headers: {
          'x-billing-key-id': 'tenant-controlled-unknown-kid',
          'x-billing-timestamp': '1786752000',
          'x-billing-signature': '0'.repeat(64),
        },
      },
    });

    expect(gatewayRequestEventBilling.process).not.toHaveBeenCalled();
    await expect(hmacOutcomeCount('required', 'unknown_key_id'))
      .resolves.toBe(unknownBefore + 1);
    const metric = await billingUsageKafkaHmacVerificationsTotal.get();
    const unknown = metric.values.find((value) => (
      value.labels.mode === 'required' && value.labels.outcome === 'unknown_key_id'
    ));
    expect(Object.keys(unknown?.labels ?? {}).sort()).toEqual(['mode', 'outcome']);
    expect(JSON.stringify(unknown?.labels)).not.toContain('tenant-controlled-unknown-kid');
  });

  it('requires an HMAC secret when configured to require HMAC', async () => {
    const { service } = buildService({
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
      BILLING_USAGE_KAFKA_REQUIRE_HMAC: 'true',
    });

    await expect(service.onModuleInit()).rejects.toThrow('BILLING_USAGE_KAFKA_HMAC_SECRET');
  });

  it('requires an explicit HMAC mode in production even with key material', async () => {
    const { service } = buildService({
      APP_ENV: 'production',
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
      BILLING_USAGE_KAFKA_HMAC_KEY_ID: TEST_HMAC_KEY_ID,
      BILLING_USAGE_KAFKA_HMAC_SECRET: TEST_HMAC_SECRET,
      BILLING_USAGE_KAFKA_DLQ_TOPIC: 'gateway.usage_events.dlq',
    });

    await expect(service.onModuleInit()).rejects.toThrow(
      'BILLING_USAGE_KAFKA_HMAC_MODE must be explicitly set',
    );
  });

  it('does not accept the legacy HMAC boolean as a production mode', async () => {
    const { service } = buildService({
      APP_ENV: 'production',
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
      BILLING_USAGE_KAFKA_REQUIRE_HMAC: 'false',
      BILLING_USAGE_KAFKA_HMAC_KEY_ID: TEST_HMAC_KEY_ID,
      BILLING_USAGE_KAFKA_HMAC_SECRET: TEST_HMAC_SECRET,
      BILLING_USAGE_KAFKA_DLQ_TOPIC: 'gateway.usage_events.dlq',
    });

    await expect(service.onModuleInit()).rejects.toThrow(
      'BILLING_USAGE_KAFKA_HMAC_MODE must be explicitly set',
    );
  });

  it('allows explicit HMAC shadow mode in production only with a keyed secret', async () => {
    const { service } = buildService(productionKafkaConfig({
      BILLING_USAGE_KAFKA_HMAC_MODE: 'shadow',
    }));

    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });

  it('keeps HMAC shadow independent from the provider evidence enforce mode', async () => {
    const { service } = buildService(productionKafkaConfig({
      BILLING_USAGE_KAFKA_HMAC_MODE: 'shadow',
      BILLING_USAGE_EVIDENCE_CONTRACT_MODE: 'enforce',
      BILLING_USAGE_VERIFIED_PRODUCER_BUILDS: '0123456789abcdef0123456789abcdef01234567',
    }));

    await expect(service.onModuleInit()).resolves.toBeUndefined();
  });

  it('rejects production HMAC shadow mode without a keyring', async () => {
    const { service } = buildService(productionKafkaConfig({
      BILLING_USAGE_KAFKA_HMAC_MODE: 'shadow',
      BILLING_USAGE_KAFKA_HMAC_KEY_ID: undefined,
      BILLING_USAGE_KAFKA_HMAC_SECRET: undefined,
    }));

    await expect(service.onModuleInit()).rejects.toThrow(
      'BILLING_USAGE_KAFKA_HMAC_MODE=shadow needs a keyed secret',
    );
  });

  it('rejects explicit HMAC off mode in production', async () => {
    const { service } = buildService(productionKafkaConfig({
      BILLING_USAGE_KAFKA_HMAC_MODE: 'off',
    }));

    await expect(service.onModuleInit()).rejects.toThrow(
      'BILLING_USAGE_KAFKA_HMAC_MODE=off is forbidden in production',
    );
  });

  it('rejects surrounding whitespace instead of mutating HMAC secret bytes', async () => {
    const { service } = buildService({
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
      BILLING_USAGE_KAFKA_HMAC_MODE: 'required',
      BILLING_USAGE_KAFKA_HMAC_KEY_ID: TEST_HMAC_KEY_ID,
      BILLING_USAGE_KAFKA_HMAC_SECRET: `${TEST_HMAC_SECRET} `,
    });

    await expect(service.onModuleInit()).rejects.toThrow(
      'HMAC secret must not contain surrounding whitespace',
    );
  });

  it('rejects an unbounded HMAC keyring at startup', async () => {
    const keys = Object.fromEntries(Array.from({ length: 17 }, (_, index) => [
      `usage-key-${index}`,
      `${index.toString().padStart(2, '0')}${'a'.repeat(30)}`,
    ]));
    const { service } = buildService({
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
      BILLING_USAGE_KAFKA_HMAC_MODE: 'required',
      BILLING_USAGE_KAFKA_HMAC_KEYRING_JSON: JSON.stringify(keys),
    });

    await expect(service.onModuleInit()).rejects.toThrow('16-key limit');
  });

  it('requires a DLQ topic by default when APP_ENV=production', async () => {
    const { service } = buildService({
      APP_ENV: 'production',
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
      BILLING_USAGE_KAFKA_HMAC_MODE: 'required',
      BILLING_USAGE_KAFKA_HMAC_KEY_ID: TEST_HMAC_KEY_ID,
      BILLING_USAGE_KAFKA_HMAC_SECRET: TEST_HMAC_SECRET,
    });

    await expect(service.onModuleInit()).rejects.toThrow('BILLING_USAGE_KAFKA_DLQ_TOPIC');
    expect(mockConsumerFactory).not.toHaveBeenCalled();
    expect(mockProducerFactory).not.toHaveBeenCalled();
  });

  it('sends malformed messages to DLQ and commits when DLQ is configured', async () => {
    const { service } = buildService({
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
      BILLING_USAGE_KAFKA_DLQ_TOPIC: 'gateway.usage_events.dlq',
      BILLING_USAGE_KAFKA_MESSAGE_RETRIES: '1',
    });

    await service.onModuleInit();

    const runArgs = mockConsumer.run.mock.calls[0][0];
    await runArgs.eachMessage({
      topic: 'gateway.usage_events',
      partition: 1,
      message: {
        key: Buffer.from('bad-json'),
        value: Buffer.from('{bad-json'),
        offset: '3',
      },
    });

    expect(mockProducer.send).toHaveBeenCalledWith({
      topic: 'gateway.usage_events.dlq',
      messages: [expect.objectContaining({
        key: Buffer.from('bad-json'),
        value: expect.stringContaining('"sourceTopic":"gateway.usage_events"'),
      })],
    });
    expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([{
      topic: 'gateway.usage_events',
      partition: 1,
      offset: '4',
    }]);
  });

  it('retains malformed messages after retry exhaustion when no DLQ is available', async () => {
    const { service } = buildService({
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
      BILLING_USAGE_KAFKA_MESSAGE_RETRIES: '1',
    });

    await service.onModuleInit();

    const runArgs = mockConsumer.run.mock.calls[0][0];
    await expect(runArgs.eachMessage({
      topic: 'gateway.usage_events',
      partition: 1,
      message: {
        key: Buffer.from('bad-json'),
        value: Buffer.from('{bad-json'),
        offset: '3',
      },
    })).rejects.toThrow('Kafka usage DLQ unavailable; source offset retained');

    expect(mockProducer.send).not.toHaveBeenCalled();
    expect(mockConsumer.commitOffsets).not.toHaveBeenCalled();
  });

  it('does not commit the source offset when a configured DLQ send fails', async () => {
    const dlqFailureBefore = await kafkaOutcomeCount('dlq_send_failed');
    const { service } = buildService({
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
      BILLING_USAGE_KAFKA_DLQ_TOPIC: 'gateway.usage_events.dlq',
      BILLING_USAGE_KAFKA_MESSAGE_RETRIES: '1',
    });
    mockProducer.send.mockRejectedValueOnce(new Error('dlq unavailable'));

    await service.onModuleInit();

    const runArgs = mockConsumer.run.mock.calls[0][0];
    await expect(runArgs.eachMessage({
      topic: 'gateway.usage_events',
      partition: 1,
      message: {
        key: Buffer.from('bad-json'),
        value: Buffer.from('{bad-json'),
        offset: '3',
      },
    })).rejects.toThrow('Kafka usage DLQ unavailable; source offset retained');

    expect(mockProducer.send).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'gateway.usage_events.dlq',
    }));
    expect(mockConsumer.commitOffsets).not.toHaveBeenCalled();
    await expect(kafkaOutcomeCount('dlq_send_failed'))
      .resolves.toBe(dlqFailureBefore + 1);
  });

  it('DLQs a subjectless invalid contract before committing its source offset', async () => {
    const { service, gatewayRequestEventBilling } = buildService({
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
      BILLING_USAGE_KAFKA_DLQ_TOPIC: 'gateway.usage_events.dlq',
      BILLING_USAGE_KAFKA_MESSAGE_RETRIES: '2',
      BILLING_USAGE_KAFKA_MESSAGE_RETRY_DELAY_MS: '1',
    });
    gatewayRequestEventBilling.process.mockResolvedValue({
      action: 'failed',
      requestId: 'req-invalid-contract',
      reason: 'invalid_event_contract',
      errorMessage: 'missing settlement subject',
    });

    await service.onModuleInit();
    const runArgs = mockConsumer.run.mock.calls[0][0];
    await runArgs.eachMessage({
      topic: 'gateway.usage_events',
      partition: 1,
      message: {
        key: Buffer.from('req-invalid-contract'),
        value: Buffer.from(JSON.stringify({ request_id: 'req-invalid-contract' })),
        offset: '11',
      },
    });

    expect(mockProducer.send).toHaveBeenCalledWith(expect.objectContaining({
      topic: 'gateway.usage_events.dlq',
    }));
    expect(gatewayRequestEventBilling.process).toHaveBeenCalledTimes(2);
    expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([{
      topic: 'gateway.usage_events',
      partition: 1,
      offset: '12',
    }]);
    expect(mockProducer.send.mock.invocationCallOrder[0]).toBeLessThan(
      mockConsumer.commitOffsets.mock.invocationCallOrder[0],
    );
  });

  it('retains a subjectless invalid contract when its DLQ is unavailable', async () => {
    const { service, gatewayRequestEventBilling } = buildService({
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
      BILLING_USAGE_KAFKA_MESSAGE_RETRIES: '1',
    });
    gatewayRequestEventBilling.process.mockResolvedValueOnce({
      action: 'failed',
      requestId: 'req-invalid-contract',
      reason: 'invalid_event_contract',
      errorMessage: 'missing settlement subject',
    });

    await service.onModuleInit();
    const runArgs = mockConsumer.run.mock.calls[0][0];
    await expect(runArgs.eachMessage({
      topic: 'gateway.usage_events',
      partition: 1,
      message: {
        key: Buffer.from('req-invalid-contract'),
        value: Buffer.from(JSON.stringify({ request_id: 'req-invalid-contract' })),
        offset: '11',
      },
    })).rejects.toThrow('Kafka usage DLQ unavailable; source offset retained');

    expect(mockConsumer.commitOffsets).not.toHaveBeenCalled();
  });

  it('does not commit or DLQ an unclassified failed billing result', async () => {
    const { service, gatewayRequestEventBilling } = buildService({
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
      BILLING_USAGE_KAFKA_DLQ_TOPIC: 'gateway.usage_events.dlq',
      BILLING_USAGE_KAFKA_MESSAGE_RETRIES: '1',
    });
    gatewayRequestEventBilling.process.mockResolvedValueOnce({
      action: 'failed',
      requestId: 'req-1',
      reason: 'processing_error',
    });

    await service.onModuleInit();

    const runArgs = mockConsumer.run.mock.calls[0][0];
    await expect(runArgs.eachMessage({
      topic: 'gateway.usage_events',
      partition: 0,
      message: {
        key: Buffer.from('req-1'),
        value: Buffer.from(JSON.stringify({ request_id: 'req-1' })),
        offset: '7',
      },
    })).rejects.toThrow('did not reach a committable state');

    expect(mockProducer.send).not.toHaveBeenCalled();
    expect(mockConsumer.commitOffsets).not.toHaveBeenCalled();
  });

  it('requires SCRAM credentials for the default SASL_SSL mode', async () => {
    const { service } = buildService({
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
    });

    await expect(service.onModuleInit()).rejects.toThrow(
      'SASL Kafka usage consumer requires BILLING_USAGE_KAFKA_USERNAME and BILLING_USAGE_KAFKA_PASSWORD',
    );
  });
  // gateway 于 2026-08-28 给 UsageEvent 增加了可选的 `is_stream`（`*bool` + `omitempty`，MINOR）。
  // billing 在 **consumer transport 这一层**的契约义务只有一条：
  // 把 true / false / **缺失** 三态原样交给结算侧，不得剥离、不得把缺失折叠成 false。
  //
  // 为什么「缺失 ≠ false」是硬要求：缺失表示旧 producer 产的事件、流式性未知（下游须排除）；
  // 显式 false 表示确定非流式（是候选）。两者处置相反，一旦在 envelope 解析这一层被折叠，
  // 下游再也无法区分，且**没有任何报错**。
  //
  // ⚠️ 本组用例**只**覆盖 consumer 边界，**不**声明任何 producer 可产出性：
  // 输入是最小构造对象（只有 request_id + is_stream 形态），不是 gateway 真实事件；
  // 因此它不能证明「gateway 会产出该形态」，也不能证明「真实结算服务能完整处理该形态」。
  // 那两件事分别属于 producer-owned golden bundle 与真实 service 集成测试，均为独立事项。
  describe('is_stream 在 consumer 边界的三态保真', () => {
    async function forwardKafkaPayloadToProcess(
      input: Record<string, unknown>,
    ): Promise<Record<string, unknown>> {
      const { service, gatewayRequestEventBilling } = buildService({
        BILLING_USAGE_KAFKA_ENABLED: 'true',
        BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
        BILLING_USAGE_KAFKA_USERNAME: 'billing',
        BILLING_USAGE_KAFKA_PASSWORD: 'secret',
      });
      const process = gatewayRequestEventBilling.process as jest.Mock;

      await service.onModuleInit();
      const runArgs = mockConsumer.run.mock.calls[0][0];
      await runArgs.eachMessage({
        topic: 'gateway.usage_events',
        partition: 0,
        message: {
          key: Buffer.from(String(input.request_id)),
          value: Buffer.from(JSON.stringify({ usage_event: input })),
          offset: '11',
        },
      });

      expect(process).toHaveBeenCalledTimes(1);
      return process.mock.calls[0][0] as Record<string, unknown>;
    }

    it.each([
      ['true', { is_stream: true }, true, true],
      ['false', { is_stream: false }, true, false],
      ['missing', {}, false, undefined],
    ])('%s 形态原样到达 process()', async (name, streamFields, hasKey, expected) => {
      const input = {
        request_id: `req-is-stream-${name}`,
        ...streamFields,
      };

      const forwarded = await forwardKafkaPayloadToProcess(input);

      // 整个对象严格相等：防 parser 重建对象时漏字段（比逐字段断言更强）。
      expect(forwarded).toStrictEqual(input);
      // 键的存在性本身就是语义：缺失必须仍然缺失。
      expect(Object.hasOwn(forwarded, 'is_stream')).toBe(hasKey);
      expect(forwarded.is_stream).toBe(expected);
    });
  });

  describe('P0-3 provisional exposure 不变量在 consumer 边界的命运', () => {
    const KAFKA = {
      BILLING_USAGE_KAFKA_ENABLED: 'true',
      BILLING_USAGE_KAFKA_BROKERS: 'b-1.msk:9096',
      BILLING_USAGE_KAFKA_USERNAME: 'billing',
      BILLING_USAGE_KAFKA_PASSWORD: 'secret',
      BILLING_USAGE_KAFKA_DLQ_TOPIC: 'gateway.usage_events.dlq',
      // 故意保留默认的三次重试：invariant 必须在**第一次捕获**就退出重试循环，
      // 若退出点写错，process 会被调用三次 —— 那正是这里要钉住的回归。
      BILLING_USAGE_KAFKA_MESSAGE_RETRIES: '3',
    };
    const sourceMessage = (offset: string) => ({
      topic: 'gateway.usage_events',
      partition: 4,
      message: {
        key: Buffer.from('req-invariant'),
        value: Buffer.from(JSON.stringify({
          usage_event: { request_id: 'req-invariant' },
        })),
        offset,
      },
    });
    type InvariantCode =
      ConstructorParameters<typeof GatewayProvisionalExposureInvariantError>[0];
    const invariant = (
      code: InvariantCode,
      disposition?: 'BLOCK_PARTITION' | 'QUARANTINE_AND_DLQ',
    ) => new GatewayProvisionalExposureInvariantError(
      code,
      { requestId: 'req-invariant', gatewayBillingEventId: 'gateway-billing-event-9' },
      disposition,
    );

    it('QUARANTINE_AND_DLQ：先 producer.send 成功、再 commit offset+1，且只处理一次', async () => {
      const dlqBefore = await kafkaOutcomeCount('provisional_exposure_invariant_dlq');
      const { service, gatewayRequestEventBilling } = buildService(KAFKA);
      gatewayRequestEventBilling.process.mockRejectedValue(
        invariant('source_evidence_missing'),
      );

      await service.onModuleInit();
      const runArgs = mockConsumer.run.mock.calls[0][0];
      await runArgs.eachMessage(sourceMessage('77'));

      expect(gatewayRequestEventBilling.process).toHaveBeenCalledTimes(1);
      expect(mockProducer.send).toHaveBeenCalledTimes(1);
      expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([{
        topic: 'gateway.usage_events',
        partition: 4,
        offset: '78',
      }]);
      // 顺序是契约的一部分：commit 早于 send 就会在 DLQ 丢失时永久丢账。
      expect(mockProducer.send.mock.invocationCallOrder[0])
        .toBeLessThan(mockConsumer.commitOffsets.mock.invocationCallOrder[0]);
      await expect(kafkaOutcomeCount('provisional_exposure_invariant_dlq'))
        .resolves.toBe(dlqBefore + 1);
    });

    it('writer_persistence_failed ⇒ DLQ + commit offset+1（分区必须能继续）', async () => {
      // ⚠️ 这条才是阻断项真正的验收点：服务层只能证明「抛了个不同类型的错」，
      // 唯一有意义的断言是**下一条消息能被消费** —— 即 offset 被提交。
      // 若哪天把 writer_persistence_failed 的默认 disposition 改成 BLOCK_PARTITION，
      // 这条会红，而服务层那三条照旧全绿。
      const dlqBefore = await kafkaOutcomeCount('provisional_exposure_invariant_dlq');
      const { service, gatewayRequestEventBilling } = buildService(KAFKA);
      gatewayRequestEventBilling.process.mockRejectedValue(
        invariant('writer_persistence_failed'),
      );

      await service.onModuleInit();
      const runArgs = mockConsumer.run.mock.calls[0][0];
      // eachMessage 不得抛出：抛出就等于 partition 停在这条消息上。
      await expect(runArgs.eachMessage(sourceMessage('91'))).resolves.toBeUndefined();

      expect(mockProducer.send).toHaveBeenCalledTimes(1);
      expect(mockConsumer.commitOffsets).toHaveBeenCalledWith([{
        topic: 'gateway.usage_events',
        partition: 4,
        offset: '92',
      }]);
      const sent = mockProducer.send.mock.calls[0][0];
      expect(sent.messages[0].headers['x-billing-dlq-reason'].toString('utf8'))
        .toBe('provisional_exposure_invariant:writer_persistence_failed');
      await expect(kafkaOutcomeCount('provisional_exposure_invariant_dlq'))
        .resolves.toBe(dlqBefore + 1);
    });
    it('invariant DLQ 不伪装成 poison：envelope 带 code/requestId/eventId，header 用独立 reason', async () => {
      const { service, gatewayRequestEventBilling } = buildService(KAFKA);
      gatewayRequestEventBilling.process.mockRejectedValue(
        invariant('existing_exposure_content_conflict'),
      );

      await service.onModuleInit();
      const runArgs = mockConsumer.run.mock.calls[0][0];
      await runArgs.eachMessage(sourceMessage('80'));

      const sent = mockProducer.send.mock.calls[0][0];
      expect(sent.topic).toBe('gateway.usage_events.dlq');
      const envelope = JSON.parse(sent.messages[0].value);
      expect(envelope).toEqual(expect.objectContaining({
        sourceTopic: 'gateway.usage_events',
        partition: 4,
        offset: '80',
        invariantCode: 'existing_exposure_content_conflict',
        requestId: 'req-invariant',
        gatewayBillingEventId: 'gateway-billing-event-9',
      }));
      // poison 的 reason 字段不应出现：两类问题必须在 DLQ 里可区分。
      expect(envelope).not.toHaveProperty('poisonReason');
      expect(sent.messages[0].headers['x-billing-dlq-reason'].toString('utf8'))
        .toBe('provisional_exposure_invariant:existing_exposure_content_conflict');
    });

    it('DLQ 发送失败：eachMessage 抛出、零 commit', async () => {
      const failedBefore = await kafkaOutcomeCount(
        'provisional_exposure_invariant_dlq_failed',
      );
      const { service, gatewayRequestEventBilling } = buildService(KAFKA);
      gatewayRequestEventBilling.process.mockRejectedValue(
        invariant('source_evidence_raw_not_object'),
      );
      mockProducer.send.mockRejectedValue(new Error('dlq broker unavailable'));

      await service.onModuleInit();
      const runArgs = mockConsumer.run.mock.calls[0][0];
      await expect(runArgs.eachMessage(sourceMessage('81'))).rejects.toThrow(
        /DLQ unavailable/,
      );
      expect(mockConsumer.commitOffsets).not.toHaveBeenCalled();
      await expect(kafkaOutcomeCount('provisional_exposure_invariant_dlq_failed'))
        .resolves.toBe(failedBefore + 1);
    });

    it('BLOCK_PARTITION：零 DLQ、零 commit、eachMessage 抛出，且只处理一次', async () => {
      const blockedBefore = await kafkaOutcomeCount('provisional_exposure_blocked');
      const { service, gatewayRequestEventBilling } = buildService(KAFKA);
      gatewayRequestEventBilling.process.mockRejectedValue(
        invariant('decision_missing'),
      );

      await service.onModuleInit();
      const runArgs = mockConsumer.run.mock.calls[0][0];
      await expect(runArgs.eachMessage(sourceMessage('82'))).rejects.toThrow(
        /decision_missing/,
      );
      expect(gatewayRequestEventBilling.process).toHaveBeenCalledTimes(1);
      expect(mockProducer.send).not.toHaveBeenCalled();
      expect(mockConsumer.commitOffsets).not.toHaveBeenCalled();
      await expect(kafkaOutcomeCount('provisional_exposure_blocked'))
        .resolves.toBe(blockedBefore + 1);
    });

    it('被降级的 quarantine code 走 block（无 TokenUsage proof 时 service 会这样降级）', async () => {
      const { service, gatewayRequestEventBilling } = buildService(KAFKA);
      gatewayRequestEventBilling.process.mockRejectedValue(
        invariant('source_evidence_binding_mismatch', 'BLOCK_PARTITION'),
      );

      await service.onModuleInit();
      const runArgs = mockConsumer.run.mock.calls[0][0];
      await expect(runArgs.eachMessage(sourceMessage('83'))).rejects.toThrow(
        /source_evidence_binding_mismatch/,
      );
      // 关键：不能因为 code 默认是 quarantine 就 DLQ —— disposition 才是权威。
      expect(mockProducer.send).not.toHaveBeenCalled();
      expect(mockConsumer.commitOffsets).not.toHaveBeenCalled();
    });

    it('状态持久化失败（普通 DB 错误）：不得 DLQ、不得 commit', async () => {
      const { service, gatewayRequestEventBilling } = buildService({
        ...KAFKA,
        BILLING_USAGE_KAFKA_MESSAGE_RETRIES: '1',
      });
      // invariant 处理里若状态持久化本身失败，抛出的是普通 DB error 而不是 invariant。
      gatewayRequestEventBilling.process.mockRejectedValue(
        new Error('could not serialize access due to concurrent update'),
      );

      await service.onModuleInit();
      const runArgs = mockConsumer.run.mock.calls[0][0];
      await expect(runArgs.eachMessage(sourceMessage('84'))).rejects.toThrow(
        /concurrent update/,
      );
      expect(mockProducer.send).not.toHaveBeenCalled();
      expect(mockConsumer.commitOffsets).not.toHaveBeenCalled();
    });
  });

describe('provisional exposure 边界（来自 schema 迁移，非环境变量）', () => {
  /** 直接从注册表读 gauge 的当前值（0 = schema 未就绪）。 */
  async function boundaryGaugeValue(): Promise<number> {
    const { values } = await billingProvisionalExposureBoundarySeconds.get();
    return values[0]?.value ?? 0;
  }

  beforeEach(() => billingProvisionalExposureBoundarySeconds.set(0));

  // ⚠️ 这里不再有环境变量真值表。
  // 早先是两个 GitOps 变量（ENABLED / CUTOVER_AT），都是一次性翻转、上线后再无意义 ——
  // 纯运维心智负担。边界改为「建 exposure 表那次迁移的完成时刻」，启动时从
  // _prisma_migrations 读一次：零环境变量、零 GitOps 变更、全副本天然同值。
  it('读到迁移完成时刻且表存在 ⇒ 作为边界，并把 gauge 设成 unix 秒', async () => {
    const finishedAt = new Date('2026-08-28T03:37:00.000Z');
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ finishedAt, tableExists: true }]),
    };
    const config = new GatewayProvisionalExposureConfig(prisma as never);
    expect((await config.getBoundary())?.toISOString()).toBe(finishedAt.toISOString());
    // gauge 是删掉 ..._enabled 之后「确认部署真生效」的唯一指标通道，必须断言其**值**。
    expect(await boundaryGaugeValue()).toBe(Math.floor(finishedAt.getTime() / 1000));
  });

  it('SQL 逐字固定：别名带引号 + 参数化迁移名 + 两个就绪条件 + 表存在性', async () => {
    // ⚠️ 只用 toContain 比子串挡不住真实缺陷（评审 P1，且已实测存活）：
    //   · 去掉别名的双引号 ⇒ PG 折成 finishedat（真库实测）⇒ rows[0].finishedAt 恒 undefined
    //     ⇒ 边界恒空 ⇒ 悄悄一行都不写；
    //   · rolled_back_at IS NULL 反写成 IS NOT NULL ⇒ 只认被回滚的记录 ⇒ 同样恒空。
    // 两种失效都是**静默 null**，只能靠钉住完整 SQL 文本发现。
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([{ finishedAt: null, tableExists: true }]),
    };
    const config = new GatewayProvisionalExposureConfig(prisma as never);
    await config.getBoundary();

    // $queryRaw 是**标签模板**调用 ⇒ 第一个参数是字符串片段数组，其余是插值。
    const [fragments, ...values] = prisma.$queryRaw.mock.calls[0];
    const sql = (fragments as string[]).join('?').replace(/\s+/g, ' ').trim();
    expect(sql).toBe(
      `SELECT MIN("finished_at") AS "finishedAt",`
      + ` (to_regclass('"gateway_usage_provisional_exposures"') IS NOT NULL)`
      + ` AS "tableExists"`
      + ` FROM "_prisma_migrations"`
      + ` WHERE "migration_name" = ?`
      + ` AND "finished_at" IS NOT NULL`
      + ` AND "rolled_back_at" IS NULL`,
    );
    expect(values).toEqual([PROVISIONAL_EXPOSURE_SCHEMA_MIGRATION]);
    // Kafka 与本 provider 无关，不再假装断言「顺序保证」（那条断言近似恒真）。
  });

  it('迁移记录说已完成、但表其实不存在 ⇒ 视为未就绪', async () => {
    // migrate resolve --applied / 手改历史 / 表被误删 都能造成两者不一致。
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([
        { finishedAt: new Date('2026-08-28T03:37:00.000Z'), tableExists: false },
      ]),
    };
    const config = new GatewayProvisionalExposureConfig(prisma as never);
    expect(await config.getBoundary()).toBeNull();
    expect(await boundaryGaugeValue()).toBe(0);
  });

  it('读成功后永久缓存：多次取用只打一次库（不能每条消息都查 _prisma_migrations）', async () => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue([
      { finishedAt: new Date('2026-08-28T03:37:00.000Z'), tableExists: true },
    ]) };
    const config = new GatewayProvisionalExposureConfig(prisma as never);
    await config.getBoundary();
    await config.getBoundary();
    await config.getBoundary();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
  });

  it('并发首次取用合并为一次读取（否则启动瞬间会有一批并发查询）', async () => {
    let release: (rows: unknown) => void = () => {};
    const prisma = {
      $queryRaw: jest.fn().mockReturnValue(new Promise((r) => { release = r; })),
    };
    const config = new GatewayProvisionalExposureConfig(prisma as never);
    const all = Promise.all([config.getBoundary(), config.getBoundary(), config.getBoundary()]);
    release([{ finishedAt: new Date('2026-08-28T03:37:00.000Z'), tableExists: true }]);
    const results = await all;
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(results.every((r) => r?.toISOString() === '2026-08-28T03:37:00.000Z')).toBe(true);
  });

  it('读失败：30s 内不再打库（不洪泛），30s 后自动重试（不会关到进程重启）', async () => {
    // ⚠️ 两个方向都要钉住：
    //   · 完全不缓存 ⇒ 未就绪的稳定态下每条目标事件都打一次库 + 一条 warn（日志洪泛）；
    //   · 缓存失败结果 ⇒ 一次瞬时抖动就让本功能静默到进程重启。
    // 所以是**负缓存 30s**，而不是二选一。
    const finishedAt = new Date('2026-08-28T03:37:00.000Z');
    const prisma = {
      $queryRaw: jest.fn()
        .mockRejectedValueOnce(new Error('connection reset'))
        .mockResolvedValue([{ finishedAt, tableExists: true }]),
    };
    const base = 1_700_000_000_000;
    const nowSpy = jest.spyOn(Date, 'now').mockReturnValue(base);
    try {
      const config = new GatewayProvisionalExposureConfig(prisma as never);
      expect(await config.getBoundary()).toBeNull();
      // 负缓存窗口内：不再打库。
      nowSpy.mockReturnValue(base + 29_000);
      expect(await config.getBoundary()).toBeNull();
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
      // 窗口过后：自动重试并读到边界。
      nowSpy.mockReturnValue(base + 31_000);
      expect((await config.getBoundary())?.toISOString()).toBe(finishedAt.toISOString());
      expect(prisma.$queryRaw).toHaveBeenCalledTimes(2);
    } finally {
      nowSpy.mockRestore();
    }
  });

  it('边界来源的迁移必须真的存在于 prisma/migrations（改目录名 = 悄悄关掉本功能）', () => {
    // ⚠️ 变异验证发现的缺口：把常量改成一个不存在的迁移名，全部用例照旧通过 ——
    // 而线上会永远读不到那条记录 ⇒ 边界恒空 ⇒ writer 恒 fail-closed，一行都不写，
    // 且没有任何报错。所以必须把「常量 ↔ 目录名」这层绑定钉死。
    const dir = join(__dirname, '..', '..', 'prisma', 'migrations',
      PROVISIONAL_EXPOSURE_SCHEMA_MIGRATION);
    expect(existsSync(join(dir, 'migration.sql'))).toBe(true);
    // 那次迁移必须确实是建 exposure 表的那一次，否则边界语义就跑偏了。
    const sql = readFileSync(join(dir, 'migration.sql'), 'utf8');
    // ⚠️ 只断言表名子串挡不住最可能的改错（评审 P2）：相邻的前一次迁移
    // 20260828000050 里也提到了这个表名，把常量改成它时 existsSync + 表名子串双双通过，
    // 而边界的来源已经悄悄换了。所以断言**建表语句本身**。
    expect(sql).toContain('CREATE TABLE "gateway_usage_provisional_exposures"');
  });

  it.each([
    ['迁移未完成（查不到记录）', [{ finishedAt: null, tableExists: true }]],
    ['迁移表为空', []],
  ])('%s ⇒ 边界为空（writer 将 fail-closed 什么都不写）', async (_label, rows) => {
    const prisma = { $queryRaw: jest.fn().mockResolvedValue(rows) };
    const config = new GatewayProvisionalExposureConfig(prisma as never);
    expect(await config.getBoundary()).toBeNull();
  });

  it('读取抛错（表不存在/无权限）⇒ 不阻断启动，边界为空', async () => {
    // 本功能是旁路观测，不该让它把整个结算服务拖 down。
    const prisma = {
      $queryRaw: jest.fn().mockRejectedValue(new Error('relation does not exist')),
    };
    const config = new GatewayProvisionalExposureConfig(prisma as never);
    await expect(config.getBoundary()).resolves.toBeNull();
  });

  // ⚠️ prisma 现在是**必需**依赖（评审 P2）：consumer 那条只为顺序而存在的必需注入已删除，
  // 若这里还可选，将来新增 standalone runtime 时本功能会静默关闭，只剩 warn + gauge=0。

});
});
