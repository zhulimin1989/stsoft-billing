import { BadRequestException, Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import {
  Channel,
  CodingPlanEntitlementStatus,
  CodingPlanFulfillmentMode,
  CodingPlanProviderEntitlementStatus,
  Prisma,
  Product,
  ProductBillingMode,
  ProductRuntimePolicy,
} from '@prisma/client';
import {
  CAPABILITIES,
  DEDICATED_PROTOCOL_CHANNELS,
  validateRuntimeIntent,
} from '@raytone-lab/publisher-contracts';
import type {
  Capability as PublisherCapability,
  ClientExposure as PublisherClientExposureIntent,
  ModelRouteIntent as PublisherModelRouteIntent,
  ProductPolicyDelete as PublisherProductPolicyDeleteIntent,
  ProtocolPath as PublisherProtocolPath,
  ProductRouteGraph as PublisherProductRouteGraphIntent,
  ProductRoutePolicy as PublisherProductRoutePolicyIntent,
  ProviderCredential as PublisherProviderCredentialIntent,
  ProviderEndpoint as PublisherProviderEndpointIntent,
  RuntimeIntent as PublisherRuntimeIntent,
} from '@raytone-lab/publisher-contracts';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { usd, usdNumber } from '../billing/money';
import { decrypt } from '../common/utils/crypto';
import { resolveEncryptionKey } from '../common/utils/encryption-key';
import {
  decryptGatewayLocalSecret,
  encryptGatewayLocalSecret,
  isGatewayLocalSecret,
  isLegacyAesGcmSecret,
  resolveGatewayLocalSecret,
} from '../common/utils/gateway-secret';
import { decryptCodingPlanProviderUpstreamCredential } from '../billing/coding-plan-provider-upstream-credential';
import {
  DEDICATED_PROVIDER_ACCOUNT_SOURCE_SELECT,
  PROVIDER_RESALE_ROUTE_LINE_IDENTITY_SELECT,
  resolveDedicatedProviderCode,
  validateDedicatedProviderAccountIdentityInheritance,
  validateProviderAccountIdentityForProvider,
  validateProviderResaleRouteGroupAccountIdentity,
} from '../provider-account-identity/provider-account-identity.policy';
import {
  rollingQuotaGateEnabled,
} from '../quota-templates/plan-quota-rule-views';
import { RedisService } from '../redis/redis.service';
import { PublisherClient } from './publisher.client';
import {
  isStrictDedicatedProviderIsolation,
  providerEndpointIsolationFromMetadata,
  type ProviderEndpointIsolation,
} from './provider-isolation.policy';
import { RollingQuotaGateService, ROLLING_QUOTA_GATED_ZSET } from './rolling-quota-gate.service';
import { timed } from '../common/runtime/usage-stage-timings';
import {
  PublisherAdmissionSupersededError,
  PublisherSyncJobService,
  type PublisherSyncDispatchResult,
} from './publisher-sync-job.service';
import {
  PublisherBalanceReason,
  PublisherEffectivePolicy,
  PublisherGuardrailPolicy,
  PublisherHttpMethod,
  PublisherApiType,
  PublisherAcceptedResponse,
  PublisherDedicatedUpstream,
  PublisherKeyActivation,
  PublisherKeyAdmissionDecision,
  PublisherKeyBalance,
  PublisherKeyMeta,
  PublisherNamespace,
  PublisherPlatformConfig,
  PublisherProductCredentialSource,
  PublisherProductFallbackPolicy,
  PublisherProductModelScopeMode,
  PublisherProductRouteStrategy,
  PublisherProductRuntimeBillingMode,
  PublisherProvider,
  PublisherProviderCompilePreview,
  PublisherRefundDrainSnapshot,
  PublisherReplayScope,
} from './publisher.types';
import {
  apiTypesForProviderSdk,
  type ChannelRuntimeIntentFields,
  inferProviderProfile,
  isGatewayRoutableChannel,
  buildProtocolPathsFromServedInboundProtocols,
  normalizeClientCompatibilityValue,
  normalizeProtocolPathListValue,
  normalizeProviderProfileValue,
  normalizeServedInboundProtocolListValue,
  type ProviderRuntimeIntent,
  providerApiTypesForChannels,
  providerIdFromCode,
  providerUrlParts,
  resolveProviderRuntimeIntent,
  servedInboundProtocolsForProtocolPaths,
} from './publisher-runtime-registry';
import {
  isSeedanceVideoSdkType,
  seedanceRealmForBaseUrl,
  seedanceUpstreamModelFor,
} from './seedance-runtime';

type PublisherModelRouteIntentEntry = PublisherModelRouteIntent['routes'][number];
type PublisherDedicatedUpstreamEndpoint = NonNullable<PublisherDedicatedUpstream['endpoints']>[number];
type DedicatedKmsProvider = 'aws' | 'alicloud' | 'local';
type PublisherDispatchMode = 'async' | 'required';

const ROUTE_GRAPH_ENFORCEMENT = 'enforce';
const BILLING_ACCESS_RESTRICTION_REASONS = new Set<string>([
  'manual_freeze',
  'debt_open',
  'pending_usage_exposure_limit',
  'pending_usage_unreserved',
  'settlement_policy_review',
  'settlement_retry_pending',
  'evidence_conflict',
]);
const DEDICATED_PROTOCOL_CHANNEL_SET = new Set<string>(DEDICATED_PROTOCOL_CHANNELS);
const EXPLICIT_DEDICATED_PROTOCOL_CHANNELS = new Set<string>([
  'passthrough',
  'responses_to_chat',
  'anthropic_to_chat',
]);
const REQUIRED_ADMISSION_FANOUT_CONCURRENCY = 20;

type PublisherProviderEndpointRuntimeIntent =
  PublisherProviderEndpointIntent & ProviderEndpointIsolation;

type AliCloudKmsEncryptClient = {
  encrypt(request: AliCloudKmsEncryptRequest): Promise<{
    body?: {
      ciphertextBlob?: string;
      keyId?: string;
    };
  }>;
};

type AliCloudKmsEncryptRequest = {
  keyId?: string;
  plaintext?: string;
  validate(): void;
};
type AliCloudKmsEncryptRequestConstructor = new (config: {
  keyId: string;
  plaintext: string;
}) => AliCloudKmsEncryptRequest;
type AliCloudKmsClientConstructor = new (config: Record<string, unknown>) => AliCloudKmsEncryptClient;
type AliCloudKmsModuleObject = {
  default?: AliCloudKmsClientConstructor;
  EncryptRequest?: AliCloudKmsEncryptRequestConstructor;
};
type AliCloudKmsModule = AliCloudKmsModuleObject | AliCloudKmsClientConstructor;

type DedicatedEndpointConfig = PublisherDedicatedUpstreamEndpoint;

type PublisherKeyStatus = 'active' | 'suspended' | 'revoked';

type ApiKeyRow = {
  id: string;
  userId: string;
  tenantId?: string | null;
  productId?: string | null;
  codingPlanEntitlementId?: string | null;
  product?: { slug?: string | null; name?: string | null; billingMode?: ProductBillingMode | null } | null;
  name: string;
  keyHash: string;
  isActive: boolean;
  mirrorStatus?: string | null;
  allowedModels: string | null;
  budgetUsd: unknown | null;
  expiresAt?: Date | null;
  ipWhitelist?: string | null;
  rateLimitRpm?: number | null;
  rateLimitTpm?: number | null;
  concurrencyLimit?: number | null;
  sseConcurrency?: number | null;
  maxTokensPerCall?: number | null;
  maxMessages?: number | null;
  allowTools?: boolean | null;
  allowVision?: boolean | null;
  deletedAt?: Date | null;
};

type ProviderResaleUnavailableReason =
  | 'entitlement_inactive'
  | 'entitlement_expired'
  | 'provider_entitlement_missing'
  | 'provider_entitlement_inactive'
  | 'provider_entitlement_expired'
  | 'provider_credentials_missing'
  | 'provider_line_runtime_disabled'
  | 'dedicated_endpoints_invalid';

type ProviderResaleProviderEntitlement = {
  id: string;
  status: CodingPlanProviderEntitlementStatus;
  provider: string;
  providerLineId: string;
  providerCode: string | null;
  adapterType: string | null;
  providerLineCode: string | null;
  providerAccountIdentityId: string | null;
  upstreamProductId: string;
  upstreamApiKeyEncrypted: string | null;
  upstreamSecretKeyEncrypted: string | null;
  productEndTime: Date | null;
  activatedAt: Date | null;
  updatedAt: Date;
  providerLine?: ProviderResaleProviderLineRef | null;
  providerAccountIdentity?: {
    ref: string;
    providerCode: string;
    status: string;
  } | null;
};

type ProviderResaleKeyAccess =
  | { kind: 'not_provider_resale' }
  | {
      kind: 'unavailable';
      entitlementId: string;
      reason: ProviderResaleUnavailableReason;
      detail: string;
    }
  | {
      kind: 'active';
      entitlementId: string;
      providerEntitlement: ProviderResaleProviderEntitlement;
      expiresAt: Date | null;
      endpoints: PublisherDedicatedUpstreamEndpoint[];
    };

type KeyMetaBuild = {
  body: PublisherKeyMeta;
  providerResaleAccess: ProviderResaleKeyAccess;
};

type RuntimeProductRow = Product & { runtimePolicy: ProductRuntimePolicy | null };
type RuntimeProductChannelRow = Prisma.ProductChannelGetPayload<{
  include: {
    channel: {
      include: {
        providerAccountIdentity: {
          select: { ref: true; providerCode: true; status: true };
        };
      };
    };
  };
}>;
type RuntimeGroupRow = Prisma.ProductChannelGroupGetPayload<{
  include: { members: { include: { productChannel: { include: { channel: true } } } } };
}>;
type RuntimeAssignmentRow = Prisma.RouteAssignmentGetPayload<Record<string, never>>;
type RuntimeProductModelAvailabilityRow = {
  productId: string;
  modelName: string;
};
type RuntimeIntentPlan = {
  intent: PublisherRuntimeIntent;
};

type ProviderResaleProviderLineRef = {
  id?: string | null;
  code?: string | null;
  providerCode?: string | null;
  providerAccountIdentityId?: string | null;
  adapterType?: string | null;
  runtimeEnabled?: boolean | null;
  dedicatedEndpoints?: unknown;
};

type ProviderResaleRuntimeLine = {
  providerLine: ProviderResaleProviderLineRef | null;
  lineLabel: string | null;
};

type ProviderResaleRouteGroupRow = {
  id: string;
  providerLineId: string;
  upstreamProductId: string;
  priority: number;
  market: string | null;
  currency: string | null;
  salesChannel: string | null;
  userSegmentId: string | null;
  providerLine: ProviderResaleProviderLineRef;
};

type ProviderResaleEntitlementRouteContext = {
  id: string;
  planId?: string | null;
  providerLineId?: string | null;
  providerLineCode?: string | null;
  providerLine?: ProviderResaleProviderLineRef | null;
  providerEntitlement?: {
    providerLineId?: string | null;
    providerLineCode?: string | null;
    providerCode?: string | null;
    adapterType?: string | null;
    upstreamProductId?: string | null;
    provider?: string | null;
    providerLine?: ProviderResaleProviderLineRef | null;
  } | null;
};

// 配额模板规则解析/合并/enforced 判定的单一口径在 plan-quota-rule-views.ts，
// 与 billing.service 的展示接口共用，禁止在本文件另写一份（展示=执行口径）。

type PublisherReplayContext = {
  replayRunId?: string;
};

export type PublisherRequiredFanoutControl = {
  assertActive?: () => void;
};

const PUBLISHER_CAPABILITY_SET = new Set<string>(CAPABILITIES);
// Reject an accidentally reset/small allocator while retaining the deployed
// epoch-microsecond scale and Publisher's JSON number contract.
const PUBLISHER_KEY_BALANCE_REVISION_FLOOR = 1_000_000_000_000_000;
// Gateway first-receipt amounts ultimately live in DECIMAL(20,12). Keep this
// input grammar bounded before PostgreSQL casts immutable JSON evidence: an
// unbounded exponent/mantissa must classify as an invalid guard, never abort
// the projection statement and leave an older Publisher allow-state behind.
const PENDING_ADMISSION_CANONICAL_AMOUNT_PATTERN =
  '^(?:(?:0|[1-9][0-9]{0,7})(?:\\.[0-9]{1,12})?'
  + '|[1-9](?:\\.[0-9]{1,5})?e-7'
  + '|[1-9](?:\\.[0-9]{1,4})?e-8'
  + '|[1-9](?:\\.[0-9]{1,3})?e-9'
  + '|[1-9](?:\\.[0-9]{1,2})?e-10'
  + '|[1-9](?:\\.[0-9])?e-11'
  + '|[1-9]e-12)$';
type PendingAdmissionSnapshot = {
  financialAuthorityValid: boolean;
  accountBalanceUsd: Prisma.Decimal;
  activeCreditLimitUsd: Prisma.Decimal;
  balanceAllowanceUsd: Prisma.Decimal | null;
  balanceAllowanceUsedUsd: Prisma.Decimal;
  keyBudgetUsd: Prisma.Decimal | null;
  /**
   * **仅服务 key 预算判定**,不是"该 key 历史总消费"的真实快照。
   * 当 api_keys.budget_usd IS NULL(无预算限制)时**恒为 0** —— 因为此时
   * budgetOk 走 `budgetUsd === null` 短路、本字段不参与任何运算,
   * 而算出真实值要对 token_usage 全表聚合(见 key_spend CTE 的注释)。
   * 需要真实累计消费请另查,不要复用本字段。
   */
  budgetRelevantSpentUsd: Prisma.Decimal;
  blockingReasons: string[];
  fundingReservationHoldUsd: Prisma.Decimal;
  fundingReservationRequestCount: bigint;
  provisionalHoldUsd: Prisma.Decimal;
  provisionalRequestCount: bigint;
};

@Injectable()
export class PublisherSyncService {
  private readonly logger = new Logger(PublisherSyncService.name);
  private readonly dedicatedUpstreamKmsKeyId: string | undefined;
  private readonly dedicatedUpstreamKmsClient: KMSClient | null;

  constructor(
    private readonly publisher: PublisherClient,
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly syncJobs: PublisherSyncJobService,
    private readonly rollingQuotaGate: RollingQuotaGateService,
    private readonly redis: RedisService,
  ) {
    this.dedicatedUpstreamKmsKeyId = this.firstConfig(
      'DEDICATED_UPSTREAM_KMS_KEY_ID',
      'CHANNEL_KMS_KEY_ID',
      'UPSTREAM_KEY_KMS_KEY_ID',
      'AWS_KMS_KEY_ID',
      'KMS_KEY_ID',
    );
    this.dedicatedUpstreamKmsClient = this.dedicatedUpstreamKmsKeyId
      ? new KMSClient({
          region: this.firstConfig(
            'DEDICATED_UPSTREAM_KMS_REGION',
            'CHANNEL_KMS_REGION',
            'AWS_REGION',
            'KMS_REGION',
          ) || undefined,
          endpoint: this.firstConfig(
            'DEDICATED_UPSTREAM_KMS_ENDPOINT',
            'CHANNEL_KMS_ENDPOINT',
            'AWS_KMS_ENDPOINT',
            'KMS_ENDPOINT',
          ) || undefined,
        })
      : null;
  }

  async syncApiKeyMetaById(keyId: string, context: PublisherReplayContext = {}): Promise<void> {
    await this.syncApiKeyMetaByIdWithMode(keyId, context, 'async');
  }

  async syncApiKeyMetaByIdRequired(keyId: string, context: PublisherReplayContext = {}): Promise<void> {
    await this.syncApiKeyMetaByIdWithMode(keyId, context, 'required');
  }

  /**
   * Provisioning publishes a not-yet-active local key as active remotely, then
   * atomically flips the local state only after Publisher acknowledges it.
   */
  async syncApiKeyActivationRequired(
    keyId: string,
    context: PublisherReplayContext = {},
  ): Promise<void> {
    const key = await this.prisma.apiKey.findUnique({
      where: { id: keyId },
      include: { product: { select: { slug: true, name: true, billingMode: true } } },
    });
    if (!key) {
      throw new Error(`API Key 不存在: ${keyId}`);
    }
    const { body, providerResaleAccess } = await this.buildKeyMeta(
      key,
      { forceActiveForProvision: true },
    );
    // Both ordinary keys and a fully validated provider-resale entitlement
    // may become active. Only an unavailable resale entitlement must stay
    // suspended; otherwise local finalize would diverge from Publisher.
    const canActivate = providerResaleAccess.kind !== 'unavailable';
    const activationBody: PublisherKeyMeta = canActivate
      ? { ...body, status: 'active' }
      : body;
    if (!canActivate) {
      await this.putUserKey(activationBody, context, 'required');
      await this.deleteKeyBalance(key.id, context, 'required');
      return;
    }
    await this.syncKeyBalanceByIdWithMode(
      key.id,
      { forceActiveForProvision: true, activationBody, providerResaleAccess },
      context,
      'required',
    );
  }

  private async syncApiKeyMetaByIdWithMode(
    keyId: string,
    context: PublisherReplayContext,
    mode: PublisherDispatchMode,
  ): Promise<void> {
    const key = await this.prisma.apiKey.findUnique({
      where: { id: keyId },
      include: { product: { select: { slug: true, name: true, billingMode: true } } },
    });
    if (!key) {
      await this.deleteKeyBalance(keyId, context, mode);
      return;
    }
    await this.syncApiKeyMetaWithMode(key, context, mode);
  }

  async syncApiKeyMeta(key: ApiKeyRow, context: PublisherReplayContext = {}): Promise<void> {
    await this.syncApiKeyMetaWithMode(key, context, 'async');
  }

  async syncApiKeyMetaRequired(key: ApiKeyRow, context: PublisherReplayContext = {}): Promise<void> {
    await this.syncApiKeyMetaWithMode(key, context, 'required');
  }

  private async syncApiKeyMetaWithMode(
    key: ApiKeyRow,
    context: PublisherReplayContext,
    mode: PublisherDispatchMode,
    options: { syncKeyBalance?: boolean } = {},
  ): Promise<void> {
    const { body, providerResaleAccess } = await this.buildKeyMeta(key);
    if (body.status === 'active' && options.syncKeyBalance !== false) {
      await this.syncKeyBalanceByIdWithMode(
        key.id,
        { activationBody: body, providerResaleAccess },
        context,
        mode,
      );
      return;
    }
    await this.putUserKey(body, context, mode);
    if (body.status === 'active') {
      await this.restoreUserKey(body.key_hash, body.key_id, context, mode);
    }
    if (options.syncKeyBalance === false) return;
    if (providerResaleAccess.kind !== 'not_provider_resale') {
      await this.deleteKeyBalance(key.id, context, mode);
      return;
    }
    await this.syncKeyBalanceByIdWithMode(key.id, {}, context, mode);
  }

  /**
   * 套餐配额规则变更后，按 planId 找到受影响的 active 订阅及其 api keys，
   * 重新下发 KeyMeta，使新的配额策略生效。供 quota-templates 改绑时调用。
   */
  async syncApiKeysByPlanId(
    planId: string,
    context: PublisherReplayContext = {},
  ): Promise<void> {
    const activeWindow = {
      status: 'ACTIVE' as const,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    };
    // quota-v2 §4.5：自营 CodingPlan 运行时归属走 codingPlanEntitlement，普通订阅走 subscriptionPeriod。
    // 两条链路都要扫，否则配额规则变更对自营套餐（本需求主体）整体不重推、不生效。
    const [subs, entitlements] = await Promise.all([
      this.prisma.subscriptionPeriod.findMany({
        where: { planId, ...activeWindow },
        select: { tenantId: true, productId: true },
      }),
      this.prisma.codingPlanEntitlement.findMany({
        where: { planId, ...activeWindow },
        select: { id: true },
      }),
    ]);
    if (subs.length === 0 && entitlements.length === 0) return;
    const seen = new Set<string>();
    const resyncKey = async (id: string) => {
      if (seen.has(id)) return;
      seen.add(id);
      await this.syncApiKeyMetaById(id, context);
    };
    for (const sub of subs) {
      const keys = await this.prisma.apiKey.findMany({
        where: { tenantId: sub.tenantId, productId: sub.productId, deletedAt: null },
        select: { id: true },
      });
      for (const k of keys) await resyncKey(k.id);
    }
    // 自营 key 按 codingPlanEntitlementId 绑定（组粒度，§4.5）
    for (const ent of entitlements) {
      const keys = await this.prisma.apiKey.findMany({
        where: { codingPlanEntitlementId: ent.id, deletedAt: null },
        select: { id: true },
      });
      for (const k of keys) await resyncKey(k.id);
    }
    this.logger.log(
      `re-synced ${seen.size} api key(s) after quota-rule change for plan=${planId}`,
    );
  }

  async syncApiKeysByCodingPlanEntitlementId(
    entitlementId: string,
    context: PublisherReplayContext = {},
  ): Promise<number> {
    return this.syncApiKeysByCodingPlanEntitlementIdWithMode(entitlementId, context, 'async');
  }

  async syncApiKeysByCodingPlanEntitlementIdRequired(
    entitlementId: string,
    context: PublisherReplayContext = {},
  ): Promise<number> {
    return this.syncApiKeysByCodingPlanEntitlementIdWithMode(entitlementId, context, 'required');
  }

  async establishCodingPlanRefundDrainRequired(
    entitlementId: string,
  ): Promise<PublisherRefundDrainSnapshot> {
    const keys = await this.prisma.apiKey.findMany({
      where: { codingPlanEntitlementId: entitlementId },
      select: { keyHash: true },
      orderBy: { id: 'asc' },
    });
    const keyHashes = [...new Set(keys.map((key) => key.keyHash))].sort();
    const snapshot = await this.publisher.establishRefundDrain(
      entitlementId,
      keyHashes,
    );
    if (!snapshot) {
      throw new Error('Publisher refund drain endpoint is not configured');
    }
    if (
      snapshot.protocol_version !== 1
      || snapshot.drain_id !== entitlementId
      || snapshot.key_count !== keyHashes.length
      || !Number.isSafeInteger(snapshot.in_flight)
      || snapshot.in_flight < 0
      || !Number.isSafeInteger(snapshot.request_seen_key_count)
      || snapshot.request_seen_key_count < 0
      || typeof snapshot.ready !== 'boolean'
    ) {
      throw new Error('Publisher returned an invalid refund drain proof');
    }
    return snapshot;
  }

  async releaseCodingPlanRefundDrain(entitlementId: string): Promise<void> {
    await this.publish(
      'billing',
      'DELETE',
      `/billing/api/v1/refund-drains/${encodeURIComponent(entitlementId)}`,
      undefined,
      {
        resourceType: 'coding_plan_refund_drain',
        resourceId: entitlementId,
      },
    );
  }

  private async syncApiKeysByCodingPlanEntitlementIdWithMode(
    entitlementId: string,
    context: PublisherReplayContext,
    mode: PublisherDispatchMode,
  ): Promise<number> {
    const keys = await this.prisma.apiKey.findMany({
      where: { codingPlanEntitlementId: entitlementId, deletedAt: null },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    for (const key of keys) {
      if (mode === 'required') {
        await this.syncApiKeyMetaByIdRequired(key.id, context);
      } else {
        await this.syncApiKeyMetaById(key.id, context);
      }
    }
    return keys.length;
  }

  async syncApiKeysByCodingPlanProviderLine(
    line: { id: string; code: string },
    context: PublisherReplayContext = {},
  ): Promise<number> {
    return this.syncApiKeysByCodingPlanProviderLineWithMode(line, context, 'async');
  }

  async syncApiKeysByCodingPlanProviderLineRequired(
    line: { id: string; code: string },
    context: PublisherReplayContext = {},
  ): Promise<number> {
    return this.syncApiKeysByCodingPlanProviderLineWithMode(line, context, 'required');
  }

  private async syncApiKeysByCodingPlanProviderLineWithMode(
    line: { id: string; code: string },
    context: PublisherReplayContext,
    mode: PublisherDispatchMode,
  ): Promise<number> {
    const now = new Date();
    const routePlanIds = await this.prisma.codingPlanResaleRoute.findMany({
      where: { providerLineId: line.id },
      select: { planId: true },
      distinct: ['planId'],
    });
    const entitlements = await this.prisma.codingPlanEntitlement.findMany({
      where: {
        fulfillmentMode: 'provider_resale',
        status: 'ACTIVE',
        AND: [
          { OR: [{ expiresAt: null }, { expiresAt: { gt: now } }] },
          {
            OR: [
              { providerLineId: line.id },
              { providerLineCode: line.code },
              { providerEntitlement: { providerLineId: line.id } },
              { providerEntitlement: { providerLineCode: line.code } },
              ...(routePlanIds.length > 0
                ? [{ planId: { in: routePlanIds.map((route) => route.planId) } }]
                : []),
            ],
          },
        ],
      },
      select: { id: true },
      orderBy: { id: 'asc' },
    });
    let count = 0;
    for (const entitlement of entitlements) {
      count += await this.syncApiKeysByCodingPlanEntitlementIdWithMode(entitlement.id, context, mode);
    }
    return count;
  }

  async revokeApiKey(key: Pick<ApiKeyRow, 'id' | 'keyHash'>): Promise<void> {
    await this.revokeApiKeyWithMode(key, 'async');
  }

  async revokeApiKeyRequired(key: Pick<ApiKeyRow, 'id' | 'keyHash'>): Promise<void> {
    await this.revokeApiKeyWithMode(key, 'required');
  }

  private async revokeApiKeyWithMode(
    key: Pick<ApiKeyRow, 'id' | 'keyHash'>,
    mode: PublisherDispatchMode,
    context: PublisherReplayContext = {},
    options: { syncKeyBalance?: boolean } = {},
  ): Promise<void> {
    await this.revokeUserKey(key.keyHash, key.id, mode, context);
    await this.deleteUserKey(key.keyHash, key.id, mode, context);
    if (options.syncKeyBalance !== false) {
      await this.deleteKeyBalance(key.id, context, mode);
    }
  }

  async syncKeyBalanceById(
    keyId: string,
    options: { deleteWhenMissing?: boolean } = {},
    context: PublisherReplayContext = {},
  ): Promise<void> {
    await this.syncKeyBalanceByIdWithMode(keyId, options, context, 'async');
  }

  async syncKeyBalanceByIdRequired(
    keyId: string,
    options: { deleteWhenMissing?: boolean } = {},
    context: PublisherReplayContext = {},
  ): Promise<void> {
    await this.syncKeyBalanceByIdWithMode(keyId, options, context, 'required');
  }

  // Every per-key projection funnels through here (7 call sites), so this is
  // the probe that is always present. The `publisherKeyProjection` probe one
  // layer up only covers projections entered via billing restriction sync —
  // measurements showed key work running on every message while that probe
  // stayed absent, i.e. other entry paths bypass it.
  private async syncKeyBalanceByIdWithMode(
    keyId: string,
    options: {
      deleteWhenMissing?: boolean;
      forceActiveForProvision?: boolean;
      activationBody?: PublisherKeyMeta;
      providerResaleAccess?: ProviderResaleKeyAccess;
    },
    context: PublisherReplayContext,
    mode: PublisherDispatchMode,
  ): Promise<void> {
    await timed('pubKeySync', () =>
      this.syncKeyBalanceByIdWithModeInner(keyId, options, context, mode),
    );
  }

  private async syncKeyBalanceByIdWithModeInner(
    keyId: string,
    options: {
      deleteWhenMissing?: boolean;
      forceActiveForProvision?: boolean;
      activationBody?: PublisherKeyMeta;
      providerResaleAccess?: ProviderResaleKeyAccess;
    },
    context: PublisherReplayContext,
    mode: PublisherDispatchMode,
  ): Promise<void> {
    try {
      await this.syncKeyBalanceByIdOnce(keyId, options, context, mode);
    } catch (err) {
      if (mode !== 'required' || !(err instanceof PublisherAdmissionSupersededError)) {
        throw err;
      }
      this.logger.warn(
        `publisher key admission superseded; rebuilding current projection key=${keyId}`,
      );
      // Superseded means a higher version won. Re-read Billing's source of
      // truth once with a fresh decision; durable callers own any later retry.
      await this.syncKeyBalanceByIdOnce(keyId, options, context, mode);
    }
  }

  private async syncKeyBalanceByIdOnce(
    keyId: string,
    options: {
      deleteWhenMissing?: boolean;
      forceActiveForProvision?: boolean;
      activationBody?: PublisherKeyMeta;
      providerResaleAccess?: ProviderResaleKeyAccess;
    },
    context: PublisherReplayContext,
    mode: PublisherDispatchMode,
  ): Promise<void> {
    // decision_version 必须在任何余额读取之前预分配。先读到旧快照的并发同步因此
    // 一定持有更小版本，不能在恢复执行后覆盖较新的 Publisher 状态。
    // Allocates from a single-row table (publisher_key_balance_revision_counter,
    // PK singleton), so every projection across every pod and partition
    // serialises here. Timed separately for that reason.
    const decision = this.keyAdmissionDecision(
      await timed('pubRevisionAlloc', () => this.nextKeyBalanceRevision()),
    );
    const publishAdmission = (
      state: Pick<PublisherKeyBalance, 'has_balance' | 'reason'>,
    ): Promise<void> => options.activationBody
      ? this.putKeyActivation(
          options.activationBody,
          { ...state, ...decision },
          context,
          mode,
        )
      : this.putKeyBalance(keyId, { ...state, ...decision }, context, mode);
    const key = await this.prisma.apiKey.findUnique({
      where: { id: keyId },
      select: {
        id: true,
        userId: true,
        tenantId: true,
        tenant: {
          select: {
            billingAccountId: true,
          },
        },
        productId: true,
        codingPlanEntitlementId: true,
        product: { select: { billingMode: true } },
        mirrorStatus: true,
        isActive: true,
        deletedAt: true,
      },
    });
    if (!key || key.deletedAt) {
      // 无论是否下发删除（deleteWhenMissing:false 是解封调度的重判路径），都把该 key 移出滚动配额关闸集，
      // 避免已删除/缺失的 key 残留 cpq:gated 被每分钟反复扫描。
      await this.redis.zrem(ROLLING_QUOTA_GATED_ZSET, keyId).catch(() => undefined);
      if (options.deleteWhenMissing === false) return;
      await this.deleteKeyBalance(keyId, context, mode, decision);
      return;
    }
    if (
      !options.forceActiveForProvision
      && (!key.isActive || key.mirrorStatus !== 'ACTIVE')
    ) {
      await this.deleteKeyBalance(key.id, context, mode, decision);
      return;
    }
    if (!key.tenantId && !key.codingPlanEntitlementId) {
      this.logger.warn(`skip key balance sync for apiKey without tenant binding key=${key.id}`);
      await this.deleteKeyBalance(key.id, context, mode, decision);
      return;
    }
    const providerResaleAccess = options.providerResaleAccess
      ?? await timed('pubResaleAccess', () => this.resolveProviderResaleKeyAccess(key));
    if (providerResaleAccess.kind !== 'not_provider_resale') {
      if (providerResaleAccess.kind === 'active') {
        // Dedicated upstream quota is authoritative for resale keys, but the
        // Gateway admission contract still requires an explicit value. Missing
        // is never used as an alias for allow.
        await this.redis.zrem(ROLLING_QUOTA_GATED_ZSET, keyId).catch(() => undefined);
        await publishAdmission({ has_balance: true });
      } else {
        await this.deleteKeyBalance(key.id, context, mode, decision);
      }
      return;
    }

    const billingAccountId = key.tenant?.billingAccountId ?? null;
    if (key.tenantId && !billingAccountId) {
      this.logger.warn(`publish key balance unavailable for apiKey without billing account key=${key.id}`);
      await publishAdmission({
        has_balance: false,
        reason: 'workspace_budget_exhausted',
      });
      return;
    }

    const pendingAdmission = await timed('pubPendingSnapshot', () =>
      this.pendingAdmissionSnapshot(key.id, billingAccountId, key.tenantId),
    );

    const balanceUsdBeforeHold = this.workspaceAvailableBalanceUsd(
      pendingAdmission.accountBalanceUsd.plus(pendingAdmission.activeCreditLimitUsd),
      pendingAdmission.balanceAllowanceUsd,
      pendingAdmission.balanceAllowanceUsedUsd,
    );
    // A durable reservation remains the funding authority. A structurally
    // complete first-receipt guard without one is a provisional hold: it
    // consumes only its frozen request amount instead of shutting every Key on
    // the shared account. Invalid guards stay in blockingReasons. Guard age is
    // deliberately not inferred from an unrelated worker lease; the explicit
    // request/exposure limits provide the deployed stuck-queue circuit breaker.
    const pendingHoldUsd = pendingAdmission.fundingReservationHoldUsd.plus(
      pendingAdmission.provisionalHoldUsd,
    );
    const balanceUsd = balanceUsdBeforeHold.minus(pendingHoldUsd);
    const spentUsd = pendingAdmission.budgetRelevantSpentUsd;
    const budgetUsd = pendingAdmission.keyBudgetUsd;
    const budgetOk = budgetUsd === null || usd(spentUsd).lt(budgetUsd);
    const creditBalance = await timed('pubCreditBalance', () =>
      this.resolveCreditBalanceForKey({
        userId: key.userId,
        tenantId: key.tenantId,
        productId: key.productId,
        codingPlanEntitlementId: key.codingPlanEntitlementId,
        billingMode: key.product?.billingMode ?? null,
      }),
    );
    // 计费分界（codingplan-all §4.3）：未绑定 entitlement 的 CODING_PLAN key 与无 productId/PAYG key
    // 同口径——按余额（balance）判定资金，不查套餐积分池。专属（绑 entitlement）key 才走积分池。
    const balanceFunded =
      !key.productId ||
      key.product?.billingMode === 'PAY_AS_YOU_GO' ||
      (key.product?.billingMode === 'CODING_PLAN' && !key.codingPlanEntitlementId);
    const hasFunding = balanceFunded
      ? usd(balanceUsd).gt(0)
      : Boolean(creditBalance?.billingByUpstream) || (creditBalance?.total ?? 0) > 0;
    const pendingRequestCount = this.pendingAdmissionRequestCount(pendingAdmission);
    const pendingRiskExceeded = this.pendingAdmissionRiskExceeded(
      pendingRequestCount,
      pendingHoldUsd,
    );
    const blockingReasons = [
      ...pendingAdmission.blockingReasons,
      ...(pendingRiskExceeded ? ['pending_usage_exposure_limit'] : []),
    ];
    const hasBalance = hasFunding && budgetOk && blockingReasons.length === 0;
    const reason: PublisherBalanceReason | '' = hasBalance
      ? ''
      : blockingReasons.length > 0
        ? this.publisherReasonForAccessRestrictions(
            blockingReasons,
          )
        : budgetOk
          ? 'balance_depleted'
          : 'key_spend_limit_exhausted';

    // P1-C B 关闸：自营 entitlement key + 总开关开启时，叠加滚动配额稳态判定。
    // 配额耗尽 → has_balance=false + reason=rolling_quota_exhausted（登记 cpq:gated 供解封调度重判）；
    // 资金本就不足时保留原 reason（更根本）。转售/通用/PAYG key 不受影响（零开销短路）。
    const quotaExhausted = await timed('pubRollingQuota', () =>
      this.evaluateRollingQuotaForKeyBalance(key),
    );
    const effectiveHasBalance = hasBalance && !quotaExhausted;
    const effectiveReason: PublisherBalanceReason | '' =
      hasBalance && quotaExhausted ? 'rolling_quota_exhausted' : reason;

    await publishAdmission({
      has_balance: effectiveHasBalance,
      ...(effectiveReason ? { reason: effectiveReason } : {}),
    });
  }

  /**
   * Read every key/account financial admission fact in one PostgreSQL statement snapshot.
   * A guard and its reservation must never be classified by independent
   * READ COMMITTED statements: the handoff race could otherwise double-count
   * or, worse, omit the delivered request entirely.
   */
  private async pendingAdmissionSnapshot(
    keyId: string,
    billingAccountId: string | null,
    tenantId: string | null,
  ): Promise<PendingAdmissionSnapshot> {
    const configuredPlatformCurrency = this.configString('BILLING_PLATFORM_CURRENCY')
      ?.toUpperCase();
    const platformCurrency = configuredPlatformCurrency
      && /^[A-Z]{3}$/.test(configuredPlatformCurrency)
      ? configuredPlatformCurrency
      : null;
    const rows = await this.prisma.$queryRaw<Array<{
      financialAuthorityValid: boolean;
      accountBalanceUsd: Prisma.Decimal;
      activeCreditLimitUsd: Prisma.Decimal;
      balanceAllowanceUsd: Prisma.Decimal | null;
      balanceAllowanceUsedUsd: Prisma.Decimal;
      keyBudgetUsd: Prisma.Decimal | null;
      budgetRelevantSpentUsd: Prisma.Decimal;
      blockingReasons: string[];
      fundingReservationHoldUsd: Prisma.Decimal;
      fundingReservationRequestCount: bigint;
      provisionalHoldUsd: Prisma.Decimal;
      provisionalRequestCount: bigint;
    }>>`
      WITH account_authority AS (
        SELECT
          account."id",
          account."type",
          UPPER(account."currency") AS "currency",
          tenant."id" AS "tenant_id",
          COALESCE(wallet."balance_usd", 0)::NUMERIC AS "account_balance_usd",
          CASE
            WHEN account."type" = 'enterprise'
              AND credit."status" = 'ACTIVE'
              AND credit."terms_days" > 0
              AND (
                credit."effective_at" IS NULL
                OR credit."effective_at" <= CURRENT_TIMESTAMP
              )
              AND (
                credit."expires_at" IS NULL
                OR credit."expires_at" > CURRENT_TIMESTAMP
              )
              AND credit."limit_usd" > 0
            THEN credit."limit_usd"
            ELSE 0
          END::NUMERIC AS "active_credit_limit_usd",
          tenant."balance_allowance_usd",
          tenant."balance_allowance_used_usd"
        FROM "billing_accounts" AS account
        LEFT JOIN "account_wallets" AS wallet
          ON wallet."billing_account_id" = account."id"
        LEFT JOIN "billing_account_credit_configs" AS credit
          ON credit."billing_account_id" = account."id"
        LEFT JOIN "tenants" AS tenant
          ON tenant."id" = ${tenantId}
         AND tenant."billing_account_id" = account."id"
         AND tenant."deleted_at" IS NULL
        WHERE account."id" = ${billingAccountId}
          AND account."deleted_at" IS NULL
      ),
      key_financial_authority AS (
        SELECT key."budget_usd"
        FROM "api_keys" AS key
        WHERE key."id" = ${keyId}
          AND key."deleted_at" IS NULL
          AND key."tenant_id" IS NOT DISTINCT FROM ${tenantId}
      ),
      key_spend AS (
        SELECT COALESCE(SUM(usage."cost_usd"), 0)::NUMERIC AS "spent_usd"
        FROM "token_usage" AS usage
        WHERE usage."api_key_id" = ${keyId}
          AND (
            ${tenantId}::TEXT IS NULL
            OR usage."tenant_id" = ${tenantId}
          )
          -- 只有设了 key 预算才需要算「已花多少」。这个门是把调用方**已有的**短路
          -- 下推到 SQL:唯一消费点是 budgetOk = budgetUsd === null || spent < budget
          -- (本文件 :875),budgetUsd 为 null 时 spent_usd 压根不参与运算、算了就扔。
          --
          -- 为什么值得下推:token_usage 是全库最高频写入表(国内 prod 2,215,483 行),
          -- 而单把热点 key 就占 41%(b75a7a29 有 903,358 行)⇒ api_key_id 索引
          -- 选择性天然差,planner **正确地**选择 Parallel Seq Scan 全表
          -- (实测 192ms / 131,622 buffers,占 pubPendingSnapshot 271ms 的 71%)。
          -- 这类问题加索引/加统计都救不了 —— 只能不算。
          -- 国内 prod 实测:561 把活跃 key 里 553 把(98.6%)没有预算,含两把热点 key。
          --
          -- 这个 EXISTS 不相关,planner 会提成 One-Time Filter 先判,
          -- 为假则整个 Seq Scan 标记 never executed(已在 prod EXPLAIN 验证):
          --   无预算 key  192ms / 131,622 buffers → 13.7ms / 3 buffers
          --   有预算 key  结果逐位一致(1.538412000000 == 1.538412000000)
          AND EXISTS (
            SELECT 1 FROM key_financial_authority
            WHERE "budget_usd" IS NOT NULL
          )
      ),
      scoped_restrictions AS (
        SELECT restriction.*
        FROM "billing_access_restrictions" AS restriction
        WHERE restriction."status" = 'ACTIVE'
          AND (
            restriction."api_key_id" = ${keyId}
            OR restriction."billing_account_id" = ${billingAccountId}
          )
      ),
      active_reservation_facts AS (
        SELECT
          reservation."id",
          reservation."gateway_billing_event_id",
          reservation."reserved_amount_usd",
          CASE
            WHEN account."id" IS NOT NULL
              AND ${platformCurrency}::TEXT IS NOT NULL
              AND account."currency" = UPPER(${platformCurrency}::TEXT)
              AND reservation."billing_account_id" = account."id"
              AND UPPER(reservation."billing_currency") = account."currency"
              AND reservation."billing_unit" = 'BALANCE'
              AND reservation."status" IN ('ACTIVE', 'MANUAL_REVIEW')
              AND reservation."reserved_amount_usd" >= 0
              AND reservation."collected_usd" >= 0
              AND reservation."approved_credit_usd" >= 0
              AND reservation."unapproved_debt_usd" >= 0
              AND reservation."collected_usd"
                + reservation."approved_credit_usd"
                + reservation."unapproved_debt_usd"
                = reservation."reserved_amount_usd"
              AND event."id" = reservation."gateway_billing_event_id"
              AND event."request_id" = reservation."request_id"
              AND event."billing_account_id" = reservation."billing_account_id"
              AND event."api_key_id" = reservation."api_key_id"
              AND event."tenant_id" = reservation."tenant_id"
              AND event."user_id" = reservation."user_id"
              AND event."product_id" IS NOT NULL
              AND event."billing_unit" = 'BALANCE'
              AND anchor."gateway_billing_event_id" = event."id"
              AND anchor."request_id" = event."request_id"
              AND anchor."billing_account_id" = reservation."billing_account_id"
              AND anchor."api_key_id" = reservation."api_key_id"
              AND anchor."tenant_id" = reservation."tenant_id"
              AND anchor."user_id" = reservation."user_id"
              AND anchor."product_id" = event."product_id"
              AND anchor."billing_unit" = 'BALANCE'
              AND anchor."funding_reservation_protocol" = 'V1'
              AND anchor."first_receipt_sequence" = reservation."reservation_sequence"
              AND anchor."anchor_hash" = reservation."anchor_hash"
              AND anchor."occurred_at" = reservation."occurred_at"
              AND anchor."first_received_at" = reservation."first_received_at"
              AND UPPER(anchor."billing_currency") = account."currency"
              AND quote."unit" = 'BALANCE'
              AND quote."effective_cost" IS NOT NULL
              AND quote."effective_cost" = reservation."reserved_amount_usd"
            THEN TRUE
            ELSE FALSE
          END AS "is_valid"
        FROM "gateway_usage_funding_reservations" AS reservation
        LEFT JOIN "gateway_billing_events" AS event
          ON event."id" = reservation."gateway_billing_event_id"
        LEFT JOIN "gateway_usage_settlement_anchors" AS anchor
          ON anchor."gateway_billing_event_id" = event."id"
        LEFT JOIN account_authority AS account
          ON account."id" = reservation."billing_account_id"
        LEFT JOIN LATERAL (
          SELECT
            anchor."customer_quote_snapshot" ->> 'unit' AS "unit",
            CASE
              WHEN jsonb_typeof(anchor."customer_quote_snapshot") = 'object'
                AND jsonb_typeof(
                  anchor."customer_quote_snapshot" -> 'effectiveCostUsd'
                ) = 'string'
                AND anchor."customer_quote_snapshot" ->> 'effectiveCostUsd'
                  ~ ${PENDING_ADMISSION_CANONICAL_AMOUNT_PATTERN}
              THEN (anchor."customer_quote_snapshot" ->> 'effectiveCostUsd')::NUMERIC
              ELSE NULL
            END AS "effective_cost"
        ) AS quote ON TRUE
        WHERE reservation."billing_account_id" = ${billingAccountId}
          AND reservation."status" IN ('ACTIVE', 'MANUAL_REVIEW')
      ),
      pending_guard_facts AS (
        SELECT
          restriction."id",
          restriction."gateway_billing_event_id",
          event."pending_hold_usd",
          COUNT(*) OVER (
            PARTITION BY restriction."gateway_billing_event_id"
          ) AS "guard_count",
          CASE
            WHEN account."id" IS NOT NULL
              AND ${platformCurrency}::TEXT IS NOT NULL
              AND account."currency" = UPPER(${platformCurrency}::TEXT)
              AND restriction."billing_account_id" = account."id"
              AND restriction."api_key_id" IS NULL
              AND restriction."gateway_billing_event_id" = event."id"
              AND restriction."idempotency_key"
                = 'gateway:pending-unreserved:' || event."request_id"
              AND restriction."created_by" = 'SYSTEM'
              AND restriction."released_at" IS NULL
              AND restriction."released_by" IS NULL
              AND restriction."release_reason" IS NULL
              AND event."billing_account_id" = account."id"
              AND event."request_id" IS NOT NULL
              AND event."api_key_id" IS NOT NULL
              AND event."tenant_id" IS NOT NULL
              AND event."user_id" IS NOT NULL
              AND event."product_id" IS NOT NULL
              AND event."billing_unit" = 'BALANCE'
              AND (
                (
                  event."status" = 'RECEIVED'
                  AND event."reason" IS NULL
                  AND event."reconciliation_status" = 'OPEN'
                )
                OR (
                  event."status" = 'RETRYABLE_FAILED'
                  AND event."reason" = 'funding_reservation_queue_pending'
                  AND event."reconciliation_status" = 'RETRY_WAIT'
                )
              )
              AND anchor."gateway_billing_event_id" = event."id"
              AND anchor."request_id" = event."request_id"
              AND anchor."billing_account_id" = event."billing_account_id"
              AND anchor."api_key_id" = event."api_key_id"
              AND anchor."tenant_id" = event."tenant_id"
              AND anchor."user_id" = event."user_id"
              AND anchor."product_id" = event."product_id"
              AND anchor."billing_unit" = 'BALANCE'
              AND anchor."funding_reservation_protocol" = 'V1'
              AND anchor."first_receipt_sequence" IS NOT NULL
              AND UPPER(anchor."billing_currency") = account."currency"
              AND quote."unit" = 'BALANCE'
              AND quote."effective_cost" IS NOT NULL
              AND event."pending_hold_usd" >= 0
              AND event."pending_exposure_usd" >= 0
              AND event."pending_hold_usd" = event."pending_exposure_usd"
              AND event."pending_hold_usd" = quote."effective_cost"
              -- The guard-to-reservation handoff is atomic. Coexistence is an
              -- invariant violation, not two holds that may be added together.
              AND reservation."id" IS NULL
            THEN TRUE
            ELSE FALSE
          END AS "is_valid"
        FROM scoped_restrictions AS restriction
        LEFT JOIN "gateway_billing_events" AS event
          ON event."id" = restriction."gateway_billing_event_id"
        LEFT JOIN "gateway_usage_settlement_anchors" AS anchor
          ON anchor."gateway_billing_event_id" = event."id"
        LEFT JOIN "gateway_usage_funding_reservations" AS reservation
          ON reservation."gateway_billing_event_id" = event."id"
        LEFT JOIN account_authority AS account
          ON account."id" = restriction."billing_account_id"
        LEFT JOIN LATERAL (
          SELECT
            anchor."customer_quote_snapshot" ->> 'unit' AS "unit",
            CASE
              WHEN jsonb_typeof(anchor."customer_quote_snapshot") = 'object'
                AND jsonb_typeof(
                  anchor."customer_quote_snapshot" -> 'effectiveCostUsd'
                ) = 'string'
                AND anchor."customer_quote_snapshot" ->> 'effectiveCostUsd'
                  ~ ${PENDING_ADMISSION_CANONICAL_AMOUNT_PATTERN}
              THEN (anchor."customer_quote_snapshot" ->> 'effectiveCostUsd')::NUMERIC
              ELSE NULL
            END AS "effective_cost"
        ) AS quote ON TRUE
        WHERE restriction."reason" = 'pending_usage_unreserved'
      ),
      valid_provisional_guards AS (
        SELECT guard.*
        FROM pending_guard_facts AS guard
        WHERE guard."is_valid" = TRUE
          AND guard."guard_count" = 1
      ),
      hard_reason_rows AS (
        SELECT restriction."reason"
        FROM scoped_restrictions AS restriction
        WHERE restriction."reason" <> 'pending_usage_unreserved'

        UNION ALL

        SELECT 'pending_usage_unreserved'
        FROM pending_guard_facts AS guard
        WHERE guard."is_valid" = FALSE
           OR guard."guard_count" <> 1

        UNION ALL

        SELECT 'pending_usage_unreserved'
        FROM active_reservation_facts AS reservation
        WHERE reservation."is_valid" = FALSE
      )
      SELECT
        EXISTS (
          SELECT 1
          FROM key_financial_authority
        ) AND (
          ${billingAccountId}::TEXT IS NULL
          OR EXISTS (
              SELECT 1
              FROM account_authority AS account
              WHERE account."tenant_id" = ${tenantId}
            )
        ) AS "financialAuthorityValid",
        COALESCE((
          SELECT account."account_balance_usd"
          FROM account_authority AS account
        ), 0)::NUMERIC AS "accountBalanceUsd",
        COALESCE((
          SELECT account."active_credit_limit_usd"
          FROM account_authority AS account
        ), 0)::NUMERIC AS "activeCreditLimitUsd",
        (
          SELECT account."balance_allowance_usd"
          FROM account_authority AS account
        )::NUMERIC AS "balanceAllowanceUsd",
        COALESCE((
          SELECT account."balance_allowance_used_usd"
          FROM account_authority AS account
        ), 0)::NUMERIC AS "balanceAllowanceUsedUsd",
        (
          SELECT key."budget_usd"
          FROM key_financial_authority AS key
        )::NUMERIC AS "keyBudgetUsd",
        COALESCE((
          SELECT spend."spent_usd"
          FROM key_spend AS spend
        ), 0)::NUMERIC AS "budgetRelevantSpentUsd",
        ARRAY(
          SELECT DISTINCT hard."reason"
          FROM hard_reason_rows AS hard
          ORDER BY hard."reason"
        ) AS "blockingReasons",
        COALESCE((
          SELECT SUM(reservation."reserved_amount_usd")
          FROM active_reservation_facts AS reservation
          WHERE reservation."is_valid" = TRUE
        ), 0)::NUMERIC AS "fundingReservationHoldUsd",
        (
          SELECT COUNT(*)
          FROM active_reservation_facts AS reservation
          WHERE reservation."is_valid" = TRUE
        )::BIGINT AS "fundingReservationRequestCount",
        COALESCE((
          SELECT SUM(guard."pending_hold_usd")
          FROM valid_provisional_guards AS guard
        ), 0)::NUMERIC AS "provisionalHoldUsd",
        (
          SELECT COUNT(*)
          FROM valid_provisional_guards
        )::BIGINT AS "provisionalRequestCount"
    `;
    const row = rows[0];
    if (!row) {
      throw new ServiceUnavailableException(
        `Billing pending admission snapshot missing for account ${billingAccountId}`,
      );
    }
    if (row.financialAuthorityValid !== true) {
      throw new ServiceUnavailableException(
        `Billing pending admission authority changed for account ${billingAccountId}`,
      );
    }
    return {
      financialAuthorityValid: true,
      accountBalanceUsd: this.requiredPendingAdmissionAmount(
        row.accountBalanceUsd,
        'account balance',
        true,
      ),
      activeCreditLimitUsd: this.requiredPendingAdmissionAmount(
        row.activeCreditLimitUsd,
        'active credit limit',
      ),
      balanceAllowanceUsd: row.balanceAllowanceUsd === null
        ? null
        : this.requiredPendingAdmissionAmount(
            row.balanceAllowanceUsd,
            'workspace allowance',
          ),
      balanceAllowanceUsedUsd: this.requiredPendingAdmissionAmount(
        row.balanceAllowanceUsedUsd,
        'workspace allowance used',
      ),
      keyBudgetUsd: row.keyBudgetUsd === null
        ? null
        : this.requiredPendingAdmissionAmount(row.keyBudgetUsd, 'key budget'),
      budgetRelevantSpentUsd: this.requiredPendingAdmissionAmount(
        row.budgetRelevantSpentUsd,
        'key spend',
      ),
      blockingReasons: Array.isArray(row.blockingReasons)
        && row.blockingReasons.every((reason) => typeof reason === 'string')
        ? row.blockingReasons
        : ['pending_usage_unreserved'],
      fundingReservationHoldUsd: this.requiredPendingAdmissionAmount(
        row.fundingReservationHoldUsd,
        'funding reservation hold',
      ),
      fundingReservationRequestCount: this.requiredPendingAdmissionCount(
        row.fundingReservationRequestCount,
        'funding reservation count',
      ),
      provisionalHoldUsd: this.requiredPendingAdmissionAmount(
        row.provisionalHoldUsd,
        'provisional hold',
      ),
      provisionalRequestCount: this.requiredPendingAdmissionCount(
        row.provisionalRequestCount,
        'provisional count',
      ),
    };
  }

  private requiredPendingAdmissionAmount(
    value: unknown,
    field: string,
    allowNegative = false,
  ): Prisma.Decimal {
    try {
      if (
        value === null
        || value === undefined
        || (
          typeof value !== 'string'
          && typeof value !== 'number'
          && !(value instanceof Prisma.Decimal)
        )
      ) {
        throw new Error('missing');
      }
      const amount = usd(value);
      if (
        !amount.isFinite()
        || (!allowNegative && amount.lt(0))
        || amount.decimalPlaces() > 12
      ) {
        throw new Error('invalid');
      }
      return amount;
    } catch {
      throw new ServiceUnavailableException(`Billing pending admission ${field} is invalid`);
    }
  }

  private requiredPendingAdmissionCount(value: unknown, field: string): bigint {
    try {
      const count = typeof value === 'bigint' ? value : BigInt(String(value));
      if (count < 0n) throw new Error('negative');
      return count;
    } catch {
      throw new ServiceUnavailableException(`Billing pending admission ${field} is invalid`);
    }
  }

  private pendingAdmissionRequestCount(snapshot: PendingAdmissionSnapshot): number {
    const count = snapshot.fundingReservationRequestCount
      + snapshot.provisionalRequestCount;
    return count > BigInt(Number.MAX_SAFE_INTEGER)
      ? Number.MAX_SAFE_INTEGER
      : Number(count);
  }

  private pendingAdmissionRiskExceeded(
    requestCount: number,
    pendingHoldUsd: Prisma.Decimal,
  ): boolean {
    const maxRequests = this.configPositiveSafeInteger(
      'BILLING_USAGE_PENDING_MAX_REQUESTS',
    );
    const maxExposureUsd = this.configNonNegativeDecimal(
      'BILLING_USAGE_PENDING_MAX_EXPOSURE_USD',
    );
    return Boolean(
      (requestCount > 0 && maxRequests === undefined)
      || (maxRequests !== undefined && requestCount >= maxRequests)
      || (maxExposureUsd?.gt(0) && pendingHoldUsd.gte(maxExposureUsd)),
    );
  }

  private publisherReasonForAccessRestrictions(reasons: string[]): PublisherBalanceReason {
    const active = new Set(reasons);
    const unknown = [...active]
      .filter((reason) => !BILLING_ACCESS_RESTRICTION_REASONS.has(reason))
      .sort();
    if (unknown.length > 0) {
      // The restriction table predates a database enum. Any schema drift must
      // be observable and must remain fail-closed even when a known reason is
      // present in the same account/key scope.
      this.logger.error(
        `unknown active billing access restriction reasons=${unknown.join(',')}`,
      );
      return 'billing_review';
    }
    if (active.has('manual_freeze')) return 'manual_freeze';
    // settlement_policy_review 单独给码：它是"结算侧要人看一眼"，与余额/欠费无关。
    // 客户拿到的 402 code 就是这个字符串，笼统的 billing_review 会让他先去查自己的余额
    // （2026-09-07 国内 prod 实际发生过）。优先级排在其余复核原因之前，取值确定。
    if (active.has('settlement_policy_review')) return 'settlement_review';
    const reviewReasons = [
      'pending_usage_unreserved',
      'settlement_retry_pending',
      'evidence_conflict',
    ];
    if (reviewReasons.some((reason) => active.has(reason))) return 'billing_review';
    if (active.has('pending_usage_exposure_limit')) {
      return 'settlement_risk_limit_exceeded';
    }
    if (active.has('debt_open')) return 'account_debt';

    // The caller invokes this helper only for a non-empty restriction set, but
    // keep an impossible empty input fail-closed as a review state.
    return 'billing_review';
  }

  private async nextKeyBalanceRevision(): Promise<number> {
    const rows = await this.prisma.$queryRaw<Array<{ revision: bigint }>>`
      SELECT "next_publisher_key_balance_revision"() AS "revision"
    `;
    const revision = Number(rows[0]?.revision);
    if (
      !Number.isSafeInteger(revision)
      || revision < PUBLISHER_KEY_BALANCE_REVISION_FLOOR
    ) {
      throw new ServiceUnavailableException(
        `Publisher key-balance revision allocator returned an unsafe value: ${
          rows[0]?.revision?.toString() ?? 'missing'
        }`,
      );
    }
    return revision;
  }

  private keyAdmissionDecision(decisionVersion: number): PublisherKeyAdmissionDecision {
    return {
      decision_id: randomUUID(),
      decision_version: decisionVersion,
    };
  }

  private async nextKeyAdmissionDecision(): Promise<PublisherKeyAdmissionDecision> {
    return this.keyAdmissionDecision(await this.nextKeyBalanceRevision());
  }

  /**
   * P1-C B 关闸判定 + cpq:gated 登记/摘除。仅对「自营(非转售) CODING_PLAN entitlement key」、
   * 且总开关开启时执行；其余 key 直接返回 false（零开销）。判定失败 fail-open（不阻断余额下发）。
   */
  private async evaluateRollingQuotaForKeyBalance(key: {
    id: string;
    userId: string;
    tenantId: string | null;
    productId: string | null;
    codingPlanEntitlementId: string | null;
    product?: { billingMode?: ProductBillingMode | null } | null;
  }): Promise<boolean> {
    if (
      !rollingQuotaGateEnabled() ||
      key.product?.billingMode !== 'CODING_PLAN' ||
      !key.codingPlanEntitlementId ||
      !key.productId
    ) {
      return false;
    }
    try {
      const entitlement = await this.findActiveCodingPlanEntitlementForKey({
        userId: key.userId,
        tenantId: key.tenantId,
        productId: key.productId,
        entitlementId: key.codingPlanEntitlementId,
      });
      // 转售 entitlement 的额度随上游，不走套餐滚动配额关闸。
      if (!entitlement || entitlement.fulfillmentMode === 'provider_resale' || !entitlement.planId) {
        await this.redis.zrem(ROLLING_QUOTA_GATED_ZSET, key.id).catch(() => undefined);
        return false;
      }
      const result = await this.rollingQuotaGate.evaluateExhaustion(entitlement.id, entitlement.planId);
      if (result.exhausted) {
        await this.redis.zadd(ROLLING_QUOTA_GATED_ZSET, result.recheckAtMs, key.id).catch(() => undefined);
      } else {
        await this.redis.zrem(ROLLING_QUOTA_GATED_ZSET, key.id).catch(() => undefined);
      }
      return result.exhausted;
    } catch (err) {
      this.logger.warn(
        `rolling quota gate check failed key=${key.id}: ${err instanceof Error ? err.message : String(err)}`,
      );
      return false;
    }
  }

  private async resolveCreditBalanceForKey(key: {
    userId: string;
    tenantId?: string | null;
    productId?: string | null;
    codingPlanEntitlementId?: string | null;
    billingMode?: string | null;
  }): Promise<{ total: number; billingByUpstream?: boolean } | null> {
    if (!key.productId || key.billingMode === 'PAY_AS_YOU_GO') {
      return null;
    }

    const creditPool = key.billingMode === 'CODING_PLAN'
      ? await this.findActiveCodingPlanEntitlementForKey({
          userId: key.userId,
          tenantId: key.tenantId,
          productId: key.productId,
          entitlementId: key.codingPlanEntitlementId,
        })
      : await this.findActiveSubscriptionForKey({
          userId: key.userId,
          tenantId: key.tenantId,
          productId: key.productId,
        });
    if (!creditPool) {
      return { total: 0 };
    }

    const total = await this.resolveCreditPoolTotal(creditPool.id, key.userId);
    return {
      total,
      billingByUpstream: creditPool.fulfillmentMode === 'provider_resale',
    };
  }

  private async resolveCreditPoolTotal(subscriptionId: string, userId: string): Promise<number> {
    const state = await this.prisma.creditBalanceState.findUnique({
      where: { subscriptionId },
      select: { quota: true, bonus: true },
    });
    if (!state) {
      // 存在旧流水却没有 V2 state，说明该余额没有通过上线回填审计（可能是
      // MISMATCH/CACHE_MISSING）。不得回退到未经验证的 after 快照继续放行。
      const legacy = await this.prisma.creditTransaction.findFirst({
        where: { subscriptionId, type: { not: 'QUOTA_RESET' } },
        orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
        select: { id: true },
      });
      if (legacy) {
        this.logger.error(
          `credit balance state missing for legacy subscription=${subscriptionId}; publishing depleted balance until verified backfill`,
        );
        return 0;
      }
      try {
        const [legacyQuota, legacyBonus] = await this.redis.mget(
          `credits:quota:${subscriptionId}`,
          `credits:bonus:${subscriptionId}`,
        );
        const verifiedEmpty = legacyQuota === null && legacyBonus === null
          || (
            legacyQuota !== null
            && legacyBonus !== null
            && /^\d+$/.test(legacyQuota)
            && /^\d+$/.test(legacyBonus)
            && Number(legacyQuota) === 0
            && Number(legacyBonus) === 0
          );
        if (!verifiedEmpty) {
          this.logger.error(
            `credit balance state missing for legacy Redis scope subscription=${subscriptionId}; publishing depleted balance until verified backfill`,
          );
          return 0;
        }
      } catch (err) {
        this.logger.error(
          `legacy credit cache check failed subscription=${subscriptionId}; publishing depleted balance: ${err instanceof Error ? err.message : String(err)}`,
        );
        return 0;
      }
    }
    const grantRows = await this.prisma.grantRedemption.findMany({
      where: {
        userId,
        isExpired: false,
        isUsedUp: false,
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: { amount: true, usedAmount: true },
      take: 1000,
    });
    const grant = grantRows.reduce((sum, row) => {
      const remaining = (row.amount ?? 0) - (row.usedAmount ?? 0);
      return sum + Math.max(remaining, 0);
    }, 0);

    return (state?.quota ?? 0)
      + (state?.bonus ?? 0)
      + grant;
  }

  private async findActiveSubscriptionForKey(key: {
    userId: string;
    tenantId?: string | null;
    productId: string;
  }): Promise<{ id: string; fulfillmentMode?: string | null } | null> {
    const activeWhere = {
      productId: key.productId,
      status: 'ACTIVE' as const,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    };
    const tenantId = key.tenantId?.trim();
    if (!tenantId) return null;
    return this.prisma.subscriptionPeriod.findFirst({
      where: { ...activeWhere, tenantId },
      select: { id: true },
      orderBy: [{ startedAt: 'desc' }, { createdAt: 'desc' }],
    });
  }

  private async findActiveCodingPlanEntitlementForKey(key: {
    userId: string;
    tenantId?: string | null;
    productId: string;
    entitlementId?: string | null;
  }): Promise<{ id: string; planId: string; fulfillmentMode?: string | null } | null> {
    const tenantId = key.tenantId?.trim();
    if (!tenantId) return null;
    const activeWhere = {
      tenantId,
      productId: key.productId,
      status: 'ACTIVE' as const,
      OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
    };
    const select = { id: true, planId: true, fulfillmentMode: true };
    // 计费分界（codingplan-all §4.3）：entitlement 是套餐积分归属的单一事实源，
    // 未显式绑定 entitlement 的 key 不再「兜底选取租户下任意 active entitlement」——返回 null，
    // 由调用方按余额判定资金（与 resolveBillingUnit 同口径）。
    if (!key.entitlementId) return null;
    return this.prisma.codingPlanEntitlement.findFirst({
      where: {
        ...activeWhere,
        id: key.entitlementId,
      },
      select,
    });
  }

  async syncUserKeyBalances(userId: string): Promise<void> {
    await this.syncKeyBalancePage({ userId, deletedAt: null });
  }

  async syncTenantKeyBalances(tenantId: string): Promise<void> {
    await this.syncKeyBalancePage({ tenantId, deletedAt: null });
  }

  async syncBillingAccountKeyBalances(billingAccountId: string): Promise<void> {
    await this.syncKeyBalancePage({
      deletedAt: null,
      tenant: { billingAccountId },
    });
  }

  async syncBillingAccountKeyBalancesRequired(
    billingAccountId: string,
    context: PublisherReplayContext = {},
    control: PublisherRequiredFanoutControl = {},
  ): Promise<void> {
    await this.syncKeyBalancePage(
      {
        deletedAt: null,
        tenant: { billingAccountId },
      },
      context,
      'required',
      control,
    );
  }

  async syncBillingAccountKeyBalancesByTenantIdRequired(
    tenantId: string,
    context: PublisherReplayContext = {},
  ): Promise<void> {
    const tenant = await this.prisma.tenant.findUnique({
      where: { id: tenantId },
      select: { billingAccountId: true },
    });
    const billingAccountId = tenant?.billingAccountId?.trim();
    if (!billingAccountId) {
      throw new Error(
        `Cannot require Publisher account balance sync: tenant ${tenantId} has no billing account`,
      );
    }
    await this.syncBillingAccountKeyBalancesRequired(billingAccountId, context);
  }

  /**
   * Resolve the billing account from the Key that delivered usage, then wait
   * until Publisher accepts a fresh balance projection for every Key sharing
   * that account. The projection is rebuilt at dispatch time, so a later
   * recharge cannot be overwritten by replaying a stale `has_balance=false`.
   */
  async syncBillingAccountKeyBalancesByKeyIdRequired(
    keyId: string,
    context: PublisherReplayContext = {},
  ): Promise<void> {
    const key = await this.prisma.apiKey.findUnique({
      where: { id: keyId },
      select: {
        tenant: { select: { billingAccountId: true } },
      },
    });
    const billingAccountId = key?.tenant?.billingAccountId?.trim();
    if (!billingAccountId) {
      await this.syncKeyBalanceByIdRequired(
        keyId,
        { deleteWhenMissing: true },
        context,
      );
      return;
    }
    await this.syncBillingAccountKeyBalancesRequired(billingAccountId, context);
  }

  private workspaceAvailableBalanceUsd(
    accountAvailableBalanceUsd: Prisma.Decimal,
    allowanceUsd: Prisma.Decimal | null,
    allowanceUsedUsd: Prisma.Decimal,
  ): Prisma.Decimal {
    if (allowanceUsd === null) return usd(accountAvailableBalanceUsd);
    const remaining = usd(allowanceUsd).minus(usd(allowanceUsedUsd));
    const normalizedRemaining = remaining.gt(0) ? remaining : new Prisma.Decimal(0);
    const accountBalance = usd(accountAvailableBalanceUsd);
    return accountBalance.lte(normalizedRemaining) ? accountBalance : normalizedRemaining;
  }

  private async syncKeyBalancePage(
    where: Prisma.ApiKeyWhereInput,
    context: PublisherReplayContext = {},
    mode: PublisherDispatchMode = 'async',
    control: PublisherRequiredFanoutControl = {},
  ): Promise<void> {
    let cursor: { id: string } | undefined;
    let firstFailure: { error: unknown } | undefined;
    while (true) {
      control.assertActive?.();
      const keyPageCursor = cursor;
      const keys = await timed('pubKeyPageQuery', () =>
        this.prisma.apiKey.findMany({
          where,
          select: { id: true },
          orderBy: { id: 'asc' },
          take: 100,
          ...(keyPageCursor ? { cursor: keyPageCursor, skip: 1 } : {}),
        }),
      );
      control.assertActive?.();
      if (keys.length === 0) {
        if (firstFailure) throw firstFailure.error;
        return;
      }
      if (mode === 'required') {
        try {
          await this.forEachLimited(keys, REQUIRED_ADMISSION_FANOUT_CONCURRENCY, async (key) => {
            await this.syncKeyBalanceByIdWithMode(key.id, {}, context, mode);
          }, control.assertActive);
        } catch (err) {
          firstFailure ??= { error: err };
        }
      } else {
        await Promise.all(keys.map((key) => this.syncKeyBalanceByIdWithMode(
          key.id,
          {},
          context,
          mode,
        )));
      }
      control.assertActive?.();
      cursor = { id: keys[keys.length - 1].id };
    }
  }

  private async forEachLimited<T>(
    items: T[],
    concurrency: number,
    fn: (item: T) => Promise<void>,
    assertActive?: () => void,
  ): Promise<void> {
    let index = 0;
    const failures: unknown[] = [];
    let cancellation: unknown;
    const workers = Array.from(
      { length: Math.min(Math.max(1, concurrency), Math.max(1, items.length)) },
      async () => {
        while (index < items.length) {
          if (cancellation) return;
          try {
            assertActive?.();
          } catch (err) {
            cancellation ??= err;
            return;
          }
          const item = items[index++];
          try {
            await fn(item);
          } catch (err) {
            failures.push(err);
          }
        }
      },
    );
    await Promise.all(workers);
    if (cancellation) throw cancellation;
    if (failures.length > 0) throw failures[0];
  }

  async syncRuntimeIntent(context: PublisherReplayContext = {}): Promise<void> {
    if (this.runtimeIntentPublishingDisabled()) return;
    await this.publishRuntimeIntentPlan(await this.buildRuntimeIntentPlan(), context);
  }

  async syncRuntimeIntentDetailed(
    context: PublisherReplayContext = {},
  ): Promise<PublisherSyncDispatchResult> {
    if (this.runtimeIntentPublishingDisabled()) {
      return this.runtimeIntentDisabledResult();
    }
    return this.publishRuntimeIntentPlanDetailed(await this.buildRuntimeIntentPlan(), context);
  }

  async syncRuntimeIntentRequired(context: PublisherReplayContext = {}): Promise<PublisherAcceptedResponse> {
    this.assertRuntimeIntentPublishingEnabled();
    return this.publishRuntimeIntentPlanRequired(await this.buildRuntimeIntentPlan(), context);
  }

  async buildRuntimeIntent(): Promise<PublisherRuntimeIntent> {
    return (await this.buildRuntimeIntentPlan()).intent;
  }

  private async buildRuntimeIntentPlan(
    extraProductPolicyDeletes: PublisherProductPolicyDeleteIntent[] = [],
  ): Promise<RuntimeIntentPlan> {
    const now = new Date();
    const products = await this.prisma.product.findMany({
      where: { deletedAt: null },
      include: { runtimePolicy: true },
      orderBy: { id: 'asc' },
    });
    const runtimeProducts = products.filter((product): product is RuntimeProductRow => product.runtimePolicy !== null);
    const productIds = runtimeProducts.map((product) => product.id);
    const paygProductIds = runtimeProducts
      .filter((product) => product.billingMode === ProductBillingMode.PAY_AS_YOU_GO)
      .map((product) => product.id);

    const [
      productChannels,
      groups,
      assignments,
      activeRuntimeModels,
      paygProductModels,
    ] = await Promise.all([
      productIds.length
        ? this.prisma.productChannel.findMany({
            where: {
              productId: { in: productIds },
              deletedAt: null,
              channel: { deletedAt: null },
            },
            orderBy: [{ productId: 'asc' }, { priority: 'asc' }, { weight: 'desc' }, { createdAt: 'asc' }],
            include: {
              channel: {
                include: {
                  providerAccountIdentity: {
                    select: { ref: true, providerCode: true, status: true },
                  },
                },
              },
            },
          })
        : Promise.resolve([] as RuntimeProductChannelRow[]),
      productIds.length
        ? this.prisma.productChannelGroup.findMany({
            where: { productId: { in: productIds }, deletedAt: null },
            orderBy: [{ productId: 'asc' }, { isDefault: 'desc' }, { code: 'asc' }],
            include: {
              members: {
                orderBy: [{ priority: 'asc' }, { weight: 'desc' }],
                include: { productChannel: { include: { channel: true } } },
              },
            },
          })
        : Promise.resolve([] as RuntimeGroupRow[]),
      productIds.length
        ? this.prisma.routeAssignment.findMany({
            where: {
              productId: { in: productIds },
              isActive: true,
              AND: [
                { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
                { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
              ],
            },
            orderBy: [{ productId: 'asc' }, { priority: 'desc' }, { updatedAt: 'desc' }],
          })
        : Promise.resolve([] as RuntimeAssignmentRow[]),
      this.runtimeActiveModelNames(),
      paygProductIds.length
        ? this.prisma.productModelAvailability.findMany({
            where: {
              productId: { in: paygProductIds },
              status: 'ACTIVE',
              apiEnabled: true,
              AND: [
                { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
                { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
              ],
              modelPricing: { isActive: true },
            },
            orderBy: [{ productId: 'asc' }, { displayOrder: 'asc' }, { modelName: 'asc' }],
            select: { productId: true, modelName: true },
          })
        : Promise.resolve([] as RuntimeProductModelAvailabilityRow[]),
    ]);

    const productsById = new Map(runtimeProducts.map((product) => [product.id, product]));
    const paygAllowedModelSetsByProduct = new Map(
      Array.from(this.groupBy(paygProductModels, (row) => row.productId).entries())
        .map(([productId, rows]) => [
          productId,
          new Set(this.uniqueSorted(rows.map((row) => row.modelName))),
        ]),
    );
    const allProductChannelsByProduct = this.groupBy(productChannels, (pc) => pc.productId);
    const groupsByProduct = this.groupBy(groups, (group) => group.productId);
    const assignmentsByProduct = this.groupBy(assignments, (assignment) => assignment.productId);
    const routedProductChannels = runtimeProducts.flatMap((product) =>
      this.productChannelsParticipatingInRouteGraph(
        allProductChannelsByProduct.get(product.id) ?? [],
        groupsByProduct.get(product.id) ?? [],
        assignmentsByProduct.get(product.id) ?? [],
      ),
    );
    const routedProductChannelIds = new Set(routedProductChannels.map((pc) => pc.id));
    const dedicatedOnlyProductChannels = productChannels.filter((pc) => this.productChannelHasDedicatedIsolation(pc));
    const conflictingDedicatedRoutes = dedicatedOnlyProductChannels.filter((pc) => routedProductChannelIds.has(pc.id));
    if (conflictingDedicatedRoutes.length > 0) {
      throw new Error(
        `Dedicated-only ProductChannel(s) must not participate in ordinary product route graph: `
        + conflictingDedicatedRoutes.map((pc) => pc.id).sort().join(', '),
      );
    }
    const providerProductChannels = this.uniqueProductChannels([
      ...routedProductChannels,
      ...dedicatedOnlyProductChannels,
    ]);
    const productChannelsByProduct = this.groupBy(routedProductChannels, (pc) => pc.productId);
    const pcModels = new Map<string, string[]>();
    const productPolicyDeletes: PublisherProductPolicyDeleteIntent[] = [...extraProductPolicyDeletes];

    const providerEndpoints: PublisherProviderEndpointRuntimeIntent[] = [];
    const providerCredentials: PublisherProviderCredentialIntent[] = [];
    const clientExposures: PublisherClientExposureIntent[] = [];
    const routeEntriesByModel = new Map<string, PublisherModelRouteIntentEntry[]>();
    const keyRefByChannelId = new Map<string, string>();

    for (const pc of providerProductChannels) {
      const product = productsById.get(pc.productId);
      if (!product) continue;
      this.assertIntentProductChannel(pc);

      const providerId = this.productChannelProviderId(pc.id);
      const isRouted = routedProductChannelIds.has(pc.id);
      const channelModels = isRouted ? this.modelsForProductChannel(pc, activeRuntimeModels) : [];
      const paygAllowedModels = product.billingMode === ProductBillingMode.PAY_AS_YOU_GO
        ? paygAllowedModelSetsByProduct.get(product.id)
        : undefined;
      const models = paygAllowedModels
        ? channelModels.filter((model) => paygAllowedModels.has(model))
        : channelModels;
      if (isRouted) pcModels.set(pc.id, models);
      if (isRouted && models.length === 0) {
        if (product.billingMode === ProductBillingMode.PAY_AS_YOU_GO) {
          throw new Error(
            `ProductChannel ${pc.id} has no runtime models within PAYG product_model_availabilities`,
          );
        }
        throw new Error(
          `ProductChannel ${pc.id} has no runtime models for RuntimeIntent; configure allowedModels or concrete channel.models`,
        );
      }

      providerEndpoints.push(this.buildProviderEndpointIntent(providerId, pc, product));
      if (!this.productChannelHasDedicatedIsolation(pc)) {
        providerCredentials.push(this.buildProviderCredentialIntent(providerId, pc, models, keyRefByChannelId));
      }
      clientExposures.push(this.buildClientExposureIntent(providerId, pc));

      if (!isRouted) continue;
      for (const model of models) {
        const modelConfig = this.modelConfigFor(pc.channel, model);
        const routeEntry: PublisherModelRouteIntentEntry = {
          provider_id: providerId,
          upstream_model: this.upstreamModelFor(pc.channel, model),
          status: this.productChannelEndpointStatus(pc),
          priority: this.productChannelRoutePriority(pc, model),
          weight: pc.weight,
        };
        const capabilities = this.routeCapabilitiesFor(pc.channel);
        if (capabilities.length > 0) routeEntry.capabilities = capabilities;
        const entries = routeEntriesByModel.get(model) ?? [];
        entries.push(routeEntry);
        routeEntriesByModel.set(model, entries);
      }
    }

    const modelRoutes: PublisherModelRouteIntent[] = Array.from(routeEntriesByModel.entries())
      .map(([logicalModel, routes]) => {
        const sortedRoutes = routes.sort((a, b) =>
          (a.priority ?? 0) - (b.priority ?? 0)
          || (b.weight ?? 0) - (a.weight ?? 0)
          || a.provider_id.localeCompare(b.provider_id),
        );
        const capabilities = this.publisherIntentCapabilities(
          sortedRoutes.flatMap((route) => route.capabilities ?? []),
        );
        return {
          logical_model: logicalModel,
          ...(capabilities.length > 0 ? { capabilities } : {}),
          routes: sortedRoutes,
        };
      })
      .sort((a, b) => a.logical_model.localeCompare(b.logical_model));

    const productPolicies = runtimeProducts.flatMap((product) => {
      const productChannelsForProduct = productChannelsByProduct.get(product.id) ?? [];
      if (productChannelsForProduct.length === 0) {
        productPolicyDeletes.push(this.buildProductPolicyDeleteIntent(product.id));
        this.logger.warn(
          `delete RuntimeIntent product_policy for product=${product.id}: no routed product_channels bound`,
        );
        return [];
      }
      return [this.buildProductRoutePolicyIntent(
        product,
        productChannelsForProduct,
        groupsByProduct.get(product.id) ?? [],
        assignmentsByProduct.get(product.id) ?? [],
        pcModels,
      )];
    });

    const intent: PublisherRuntimeIntent = {
      schema_version: 2,
      provider_endpoints: providerEndpoints.sort((a, b) => a.id.localeCompare(b.id)) as PublisherRuntimeIntent['provider_endpoints'],
      provider_credentials: providerCredentials.sort((a, b) => a.provider_id.localeCompare(b.provider_id)),
      client_exposures: clientExposures.sort((a, b) => a.provider_id.localeCompare(b.provider_id)),
      model_routes: modelRoutes,
      product_policies: productPolicies.sort((a, b) => a.product_id.localeCompare(b.product_id)),
      ...(productPolicyDeletes.length > 0
        ? { product_policy_deletes: this.mergeProductPolicyDeletes(productPolicyDeletes) }
        : {}),
    };
    this.assertRuntimeIntentReferences(intent);
    this.assertRuntimeIntentContract(intent);
    return { intent };
  }

  async syncOpsTopology(context: PublisherReplayContext = {}): Promise<void> {
    await this.syncRuntimeIntent(context);
  }

  async syncOpsTopologyRequired(context: PublisherReplayContext = {}): Promise<PublisherAcceptedResponse> {
    return this.syncRuntimeIntentRequired(context);
  }

  async syncOpsTopologyFresh(): Promise<void> {
    await this.syncOpsTopology({ replayRunId: randomUUID() });
  }

  async syncOpsTopologyFreshDetailed(): Promise<PublisherSyncDispatchResult> {
    return this.syncRuntimeIntentDetailed({ replayRunId: randomUUID() });
  }

  async syncOpsTopologyFreshRequired(): Promise<PublisherAcceptedResponse> {
    return this.syncOpsTopologyRequired({ replayRunId: randomUUID() });
  }

  async deleteModelRuntime(modelName: string, context: PublisherReplayContext = {}): Promise<void> {
    const logicalModel = String(modelName ?? '').trim();
    if (!logicalModel) return;
    await Promise.all([
      this.deleteModelCatalog(logicalModel, context),
      this.deleteModelRoute(logicalModel, context),
    ]);
  }

  async deleteProvider(provider: string): Promise<void> {
    this.logger.warn(`deleteProvider(${provider}) is ignored after RuntimeIntent migration; replaying intent instead`);
    await this.syncRuntimeIntent();
  }

  async cleanupRuntimeProviderIfUnused(
    channel: Pick<Channel, 'provider' | 'baseUrl' | 'sdkType'> & ChannelRuntimeIntentFields,
  ): Promise<void> {
    void channel;
    await this.syncRuntimeIntent();
  }

  runtimeProviderIdForChannel(
    channel: Pick<Channel, 'provider'> & Partial<Pick<Channel, 'baseUrl' | 'sdkType'>> & ChannelRuntimeIntentFields,
  ): string {
    return this.providerIdForChannel(channel);
  }

  async syncRuntimeIntentAfterProductPolicyChangeDetailed(
    productId: string,
    context: PublisherReplayContext = {},
  ): Promise<PublisherSyncDispatchResult> {
    if (this.runtimeIntentPublishingDisabled()) {
      return this.runtimeIntentDisabledResult();
    }
    if (await this.productRuntimePolicyDeletedAtSource(productId)) {
      return this.publishRuntimeIntentPlanDetailed(
        await this.buildRuntimeIntentPlan([this.buildProductPolicyDeleteIntent(productId)]),
        context,
      );
    }
    const plan = await this.buildRuntimeIntentPlan();
    return this.publishRuntimeIntentPlanDetailed(plan, context);
  }

  async syncRuntimeIntentAfterProductPolicyChangeRequired(
    productId: string,
    context: PublisherReplayContext = {},
  ): Promise<PublisherAcceptedResponse> {
    this.assertRuntimeIntentPublishingEnabled();
    if (await this.productRuntimePolicyDeletedAtSource(productId)) {
      return this.publishRuntimeIntentPlanRequired(
        await this.buildRuntimeIntentPlan([this.buildProductPolicyDeleteIntent(productId)]),
        context,
      );
    }
    return this.syncRuntimeIntentRequired(context);
  }

  async syncAllProductRuntimePolicies(context: PublisherReplayContext = {}): Promise<number> {
    const count = await this.prisma.productRuntimePolicy.count({
      where: { product: { deletedAt: null } },
    });
    await this.syncRuntimeIntent(context);
    return count;
  }

  async previewProviderCompile(
    input: Pick<Channel, 'provider' | 'baseUrl' | 'sdkType'> & Partial<Pick<Channel, 'name'>> & ChannelRuntimeIntentFields,
  ): Promise<{
    providerId: string;
    publisherRequest: PublisherProvider;
    publisherCompiled: PublisherProviderCompilePreview | null;
    mode: 'publisher_compiler' | 'billing_legacy';
  }> {
    const channel = {
      name: input.name || input.provider,
      provider: input.provider,
      baseUrl: input.baseUrl,
      sdkType: input.sdkType,
      providerProfile: input.providerProfile,
      clientCompatibility: input.clientCompatibility,
      servedInboundProtocols: input.servedInboundProtocols,
      protocolPaths: input.protocolPaths,
      tokenCountStrategy: input.tokenCountStrategy,
      isActive: true,
      status: 'active',
    } as Channel & ChannelRuntimeIntentFields;
    const providerId = this.providerIdForChannel(channel);
    const publisherRequest = this.buildProvider(providerId, [channel]);
    const mode = publisherRequest.provider_profile ? 'publisher_compiler' : 'billing_legacy';
    const publisherCompiled = mode === 'publisher_compiler'
      ? await this.publisher.compileProviderPreview(publisherRequest)
      : null;
    return {
      providerId,
      publisherRequest,
      publisherCompiled,
      mode,
    };
  }

  async syncAllApiKeys(limit = 5000, context: PublisherReplayContext = {}): Promise<number> {
    const keys = await this.prisma.apiKey.findMany({
      where: { deletedAt: null },
      include: { product: { select: { slug: true, name: true, billingMode: true } } },
      orderBy: { createdAt: 'asc' },
      take: limit,
    });
    for (const key of keys) {
      await this.syncApiKeyMeta(key, context);
    }
    return keys.length;
  }

  async syncApiKeysByUserId(userId: string, context: PublisherReplayContext = {}): Promise<number> {
    const keys = await this.prisma.apiKey.findMany({
      where: { userId, deletedAt: null },
      include: { product: { select: { slug: true, name: true, billingMode: true } } },
      orderBy: { createdAt: 'asc' },
    });
    for (const key of keys) {
      await this.syncApiKeyMeta(key, context);
    }
    return keys.length;
  }

  async syncAllKeyBalances(pageSize = 5000, context: PublisherReplayContext = {}): Promise<number> {
    const take = Math.max(1, Math.min(Math.floor(pageSize), 5000));
    let cursor: string | undefined;
    let total = 0;
    while (true) {
      const keys = await this.prisma.apiKey.findMany({
        where: { deletedAt: null, isActive: true, mirrorStatus: 'ACTIVE' },
        select: { id: true },
        orderBy: { id: 'asc' },
        take,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (keys.length === 0) break;
      for (const key of keys) {
        await this.syncKeyBalanceById(key.id, {}, context);
      }
      total += keys.length;
      if (keys.length < take) break;
      cursor = keys[keys.length - 1].id;
    }
    return total;
  }

  private async replayAllApiKeys(
    context: PublisherReplayContext,
    options: { pageSize?: number; includeKeyBalances?: boolean } = {},
  ): Promise<number> {
    const pageSize = options.pageSize ?? 500;
    const includeKeyBalances = options.includeKeyBalances ?? true;
    let cursor: string | undefined;
    let total = 0;
    while (true) {
      const keys = await this.prisma.apiKey.findMany({
        select: { id: true },
        orderBy: { id: 'asc' },
        take: pageSize,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (keys.length === 0) break;
      for (const key of keys) {
        // Page only stable identifiers. Re-read each source row immediately
        // before dispatch so a key revoked/deleted while an earlier item is
        // being sent cannot be restored from a stale page snapshot.
        await this.replayApiKeyById(key.id, context, includeKeyBalances);
      }
      total += keys.length;
      if (keys.length < pageSize) break;
      cursor = keys[keys.length - 1].id;
    }
    return total;
  }

  private async replayApiKeyById(
    keyId: string,
    context: PublisherReplayContext,
    includeKeyBalances: boolean,
  ): Promise<void> {
    const key = await this.prisma.apiKey.findUnique({
      where: { id: keyId },
      include: { product: { select: { slug: true, name: true, billingMode: true } } },
    });
    if (!key) {
      await this.deleteKeyBalance(keyId, context, 'async');
      return;
    }
    if (key.deletedAt || key.mirrorStatus === 'REVOKED') {
      await this.revokeApiKeyWithMode(key, 'async', context, {
        syncKeyBalance: includeKeyBalances,
      });
      return;
    }
    await this.syncApiKeyMetaWithMode(
      key,
      context,
      'async',
      { syncKeyBalance: includeKeyBalances },
    );
  }

  private async replayAllKeyBalances(
    context: PublisherReplayContext,
    pageSize = 500,
  ): Promise<number> {
    let cursor: string | undefined;
    let total = 0;
    while (true) {
      const keys = await this.prisma.apiKey.findMany({
        select: { id: true },
        orderBy: { id: 'asc' },
        take: pageSize,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
      });
      if (keys.length === 0) break;
      for (const key of keys) {
        await this.syncKeyBalanceById(key.id, {}, context);
      }
      total += keys.length;
      if (keys.length < pageSize) break;
      cursor = keys[keys.length - 1].id;
    }
    return total;
  }

  async replayPublisherState(scope: PublisherReplayScope = 'all') {
    const replayRunId = randomUUID();
    const context: PublisherReplayContext = { replayRunId };
    const result: {
      scope: typeof scope;
      replayRunId: string;
      apiKeys?: number;
      keyBalances?: number;
      adminTopology?: boolean;
      platformConfig?: boolean;
      productRuntimePolicies?: number;
    } = { scope, replayRunId };

    if (scope === 'all' || scope === 'platform') {
      try {
        await this.syncPlatformConfig(context);
        result.platformConfig = true;
        result.productRuntimePolicies = await this.syncAllProductRuntimePolicies(context);
      } catch (err) {
        if (scope === 'platform') throw err;
        result.platformConfig = false;
        this.logger.warn(`publisher platform config sync skipped during replay: ${(err as Error).message}`);
      }
    }
    if (scope === 'all' || scope === 'api_keys') {
      result.apiKeys = await this.replayAllApiKeys(context, {
        includeKeyBalances: scope !== 'all',
      });
    }
    if (scope === 'all' || scope === 'key_balances') {
      result.keyBalances = await this.replayAllKeyBalances(context);
    }
    if (scope === 'all' || scope === 'admin') {
      await this.syncOpsTopology(context);
      result.adminTopology = true;
    }

    return result;
  }

  async syncPlatformConfig(context: PublisherReplayContext = {}): Promise<void> {
    await this.putPlatformConfig(await this.buildPlatformConfig(), context);
  }

  private async publishRuntimeIntentPlan(
    plan: RuntimeIntentPlan,
    context: PublisherReplayContext = {},
  ): Promise<void> {
    await this.putRuntimeIntent(plan.intent, context);
  }

  private runtimeIntentPublishingDisabled(): boolean {
    return this.publisher.isExplicitlyDisabled?.() === true;
  }

  private assertRuntimeIntentPublishingEnabled(): void {
    if (!this.runtimeIntentPublishingDisabled()) return;
    throw new ServiceUnavailableException(
      'Publisher RuntimeIntent 下发已在受控迁移窗口中关闭',
    );
  }

  private runtimeIntentDisabledResult(): PublisherSyncDispatchResult {
    return {
      accepted: false,
      status: 'DISABLED',
      idempotencyKey: 'publisher-disabled:runtime-intent',
      error: 'Publisher RuntimeIntent delivery is explicitly disabled',
    };
  }

  private async publishRuntimeIntentPlanDetailed(
    plan: RuntimeIntentPlan,
    context: PublisherReplayContext = {},
  ): Promise<PublisherSyncDispatchResult> {
    return this.putRuntimeIntentDetailed(plan.intent, context);
  }

  private async publishRuntimeIntentPlanRequired(
    plan: RuntimeIntentPlan,
    context: PublisherReplayContext = {},
  ): Promise<PublisherAcceptedResponse> {
    return this.putRuntimeIntentRequired(plan.intent, context);
  }

  private async productRuntimePolicyDeletedAtSource(productId: string): Promise<boolean> {
    const id = String(productId ?? '').trim();
    if (!id) return true;
    const product = await this.prisma.product.findFirst({
      where: { id },
      select: {
        id: true,
        deletedAt: true,
        runtimePolicy: { select: { id: true } },
      },
    });
    return !product || product.deletedAt !== null || !product.runtimePolicy;
  }

  private async publish(
    namespace: PublisherNamespace,
    method: PublisherHttpMethod,
    path: string,
    body?: unknown,
    meta: { resourceType?: string; resourceId?: string } = {},
    context: PublisherReplayContext = {},
  ): Promise<void> {
    const result = await this.syncJobs.dispatchDetailed({
      namespace,
      method,
      path,
      body,
      ...(context.replayRunId
        ? { idempotencyKey: this.replayIdempotencyKey(context.replayRunId, namespace, method, path, body) }
        : meta.resourceType === 'api_key'
          ? { idempotencyKey: this.freshApiKeyIdempotencyKey(meta.resourceId) }
          : {}),
      source: 'admin',
      ...meta,
    });
    if (!result.accepted) {
      this.logger.warn(
        `publisher sync not accepted: ${namespace} ${method} ${path} status=${result.status}`
        + ` idempotencyKey=${result.idempotencyKey}`
        + (result.error ? ` error=${result.error}` : ''),
      );
    }
  }

  private publishDetailed(
    namespace: PublisherNamespace,
    method: PublisherHttpMethod,
    path: string,
    body?: unknown,
    meta: { resourceType?: string; resourceId?: string } = {},
    context: PublisherReplayContext = {},
  ): Promise<PublisherSyncDispatchResult> {
    return this.syncJobs.dispatchDetailed({
      namespace,
      method,
      path,
      body,
      ...(context.replayRunId
        ? { idempotencyKey: this.replayIdempotencyKey(context.replayRunId, namespace, method, path, body) }
        : meta.resourceType === 'api_key'
          ? { idempotencyKey: this.freshApiKeyIdempotencyKey(meta.resourceId) }
          : {}),
      source: 'admin',
      ...meta,
    });
  }

  private async publishRequired(
    namespace: PublisherNamespace,
    method: PublisherHttpMethod,
    path: string,
    body?: unknown,
    meta: { resourceType?: string; resourceId?: string } = {},
    context: PublisherReplayContext = {},
  ): Promise<PublisherAcceptedResponse> {
    return this.syncJobs.dispatchRequired({
      namespace,
      method,
      path,
      body,
      ...(context.replayRunId
        ? { idempotencyKey: this.replayIdempotencyKey(context.replayRunId, namespace, method, path, body) }
        : meta.resourceType === 'api_key'
          ? { idempotencyKey: this.freshApiKeyIdempotencyKey(meta.resourceId) }
          : {}),
      source: 'admin',
      ...meta,
    });
  }

  // Sole HTTP egress to Publisher on this path (7 call sites), so one probe
  // here separates network/dispatch cost from the DB work around it. Timing is
  // diagnostic only and a no-op outside the usage consumer.
  private async publishWithMode(
    mode: PublisherDispatchMode,
    namespace: PublisherNamespace,
    method: PublisherHttpMethod,
    path: string,
    body?: unknown,
    meta: { resourceType?: string; resourceId?: string } = {},
    context: PublisherReplayContext = {},
  ): Promise<void> {
    await timed('pubHttpDispatch', async () => {
      if (mode === 'required') {
        await this.publishRequired(namespace, method, path, body, meta, context);
        return;
      }
      await this.publish(namespace, method, path, body, meta, context);
    });
  }

  private putUserKey(
    body: PublisherKeyMeta,
    context: PublisherReplayContext = {},
    mode: PublisherDispatchMode = 'async',
  ): Promise<void> {
    return this.publishWithMode(mode, 'user', 'PUT', '/user/api/v1/keys', body, {
      resourceType: 'api_key',
      resourceId: body.key_id,
    }, context);
  }

  private deleteUserKey(
    keyHash: string,
    keyId?: string,
    mode: PublisherDispatchMode = 'async',
    context: PublisherReplayContext = {},
  ): Promise<void> {
    return this.publishWithMode(mode, 'user', 'DELETE', `/user/api/v1/keys/${keyHash}`, undefined, {
      resourceType: 'api_key',
      resourceId: keyId ?? keyHash,
    }, context);
  }

  private revokeUserKey(
    keyHash: string,
    keyId?: string,
    mode: PublisherDispatchMode = 'async',
    context: PublisherReplayContext = {},
  ): Promise<void> {
    return this.publishWithMode(mode, 'user', 'POST', '/user/api/v1/revoked-keys', { key_hash: keyHash }, {
      resourceType: 'api_key',
      resourceId: keyId ?? keyHash,
    }, context);
  }

  private restoreUserKey(
    keyHash: string,
    keyId?: string,
    context: PublisherReplayContext = {},
    mode: PublisherDispatchMode = 'async',
  ): Promise<void> {
    return this.publishWithMode(mode, 'user', 'DELETE', `/user/api/v1/revoked-keys/${keyHash}`, undefined, {
      resourceType: 'api_key',
      resourceId: keyId ?? keyHash,
    }, context);
  }

  private putKeyBalance(
    keyId: string,
    body: PublisherKeyBalance,
    context: PublisherReplayContext = {},
    mode: PublisherDispatchMode = 'async',
  ): Promise<void> {
    // 网关 publisher 契约暂未接受 reason='rolling_quota_exhausted'：会 400 INVALID_ARGUMENT
    // 整条 key-balance 更新被拒，导致 has_balance=false 无法下发、超限 key 仍被网关放行。
    // 映射为契约已接受的 'balance_depleted'——has_balance 才是阻断关键，reason 仅展示/诊断；
    // 内部 cpq:gated 解封逻辑用真实语义、不受影响。
    // TODO(tokenplatform)：契约新增 rolling_quota_exhausted 枚举后切回精确 reason。
    const wireBody: PublisherKeyBalance =
      body.reason === 'rolling_quota_exhausted'
        ? { ...body, reason: 'balance_depleted' }
        : body;
    return this.publishWithMode(mode, 'billing', 'PUT', `/billing/api/v1/key-balance/${keyId}`, wireBody, {
      resourceType: 'key_balance',
      resourceId: keyId,
    }, context);
  }

  private putKeyActivation(
    keyMeta: PublisherKeyMeta,
    balance: PublisherKeyBalance,
    context: PublisherReplayContext = {},
    mode: PublisherDispatchMode = 'async',
  ): Promise<void> {
    const reason = balance.reason === 'rolling_quota_exhausted'
      ? 'balance_depleted'
      : balance.reason;
    const body: PublisherKeyActivation = {
      key_meta: keyMeta,
      has_balance: balance.has_balance,
      ...(reason ? { reason } : {}),
      decision_id: balance.decision_id,
      decision_version: balance.decision_version,
    };
    return this.publishWithMode(
      mode,
      'billing',
      'PUT',
      `/billing/api/v1/key-activation/${keyMeta.key_id}`,
      body,
      { resourceType: 'api_key', resourceId: keyMeta.key_id },
      context,
    );
  }

  private async deleteKeyBalance(
    keyId: string,
    context: PublisherReplayContext = {},
    mode: PublisherDispatchMode = 'async',
    preallocatedDecision?: PublisherKeyAdmissionDecision,
  ): Promise<void> {
    const decision = preallocatedDecision ?? await this.nextKeyAdmissionDecision();
    // key 失效/删除/无绑定 → 一并移出滚动配额关闸集，避免 cpq:gated 残留被调度反复扫描。
    await this.redis.zrem(ROLLING_QUOTA_GATED_ZSET, keyId).catch(() => undefined);
    await this.publishWithMode(mode, 'billing', 'DELETE', `/billing/api/v1/key-balance/${keyId}`, decision, {
      resourceType: 'key_balance',
      resourceId: keyId,
    }, context);
  }

  private deleteProviderById(providerId: string): Promise<void> {
    return this.publish('admin', 'DELETE', `/admin/api/v1/providers/${providerId}`, undefined, {
      resourceType: 'provider',
      resourceId: providerId,
    });
  }

  private deleteModelCatalog(modelName: string, context: PublisherReplayContext = {}): Promise<void> {
    return this.publish('admin', 'DELETE', `/admin/api/v1/models/${encodeURIComponent(modelName)}/catalog`, undefined, {
      resourceType: 'model_catalog',
      resourceId: modelName,
    }, context);
  }

  private deleteModelRoute(modelName: string, context: PublisherReplayContext = {}): Promise<void> {
    return this.publish('admin', 'DELETE', `/admin/api/v1/models/${encodeURIComponent(modelName)}/route`, undefined, {
      resourceType: 'model_route',
      resourceId: modelName,
    }, context);
  }

  private putRuntimeIntent(
    body: PublisherRuntimeIntent,
    context: PublisherReplayContext = {},
  ): Promise<void> {
    return this.publish('admin', 'POST', '/admin/api/v1/providers:from-intent', body, {
      resourceType: 'runtime_intent',
      resourceId: 'default',
    }, context);
  }

  private putRuntimeIntentDetailed(
    body: PublisherRuntimeIntent,
    context: PublisherReplayContext = {},
  ): Promise<PublisherSyncDispatchResult> {
    return this.publishDetailed('admin', 'POST', '/admin/api/v1/providers:from-intent', body, {
      resourceType: 'runtime_intent',
      resourceId: 'default',
    }, context);
  }

  private putRuntimeIntentRequired(
    body: PublisherRuntimeIntent,
    context: PublisherReplayContext = {},
  ): Promise<PublisherAcceptedResponse> {
    return this.publishRequired('admin', 'POST', '/admin/api/v1/providers:from-intent', body, {
      resourceType: 'runtime_intent',
      resourceId: 'default',
    }, context);
  }

  private putPlatformConfig(
    body: PublisherPlatformConfig,
    context: PublisherReplayContext = {},
  ): Promise<void> {
    return this.publish('admin', 'PUT', '/admin/api/v1/platform-config', body, {
      resourceType: 'platform_config',
      resourceId: 'default',
    }, context);
  }

  private async buildPlatformConfig(): Promise<PublisherPlatformConfig> {
    const apiGatewayConfig = await this.loadApiGatewayConfig();
    const retryBudget = this.retryBudgetConfig();
    const auth = this.authRuntimeConfig();
    const defaultRoutePolicy = this.defaultRoutePolicyConfig();
    const responsesAffinityEnabled = this.configBoolean('PUBLISHER_RESPONSES_AFFINITY_ENABLED');
    const platformRpm = this.configNumber('PUBLISHER_PLATFORM_RPM')
      ?? this.numberSetting(apiGatewayConfig, 'rateLimitPerMin');
    const platformCc = this.configNumber('PUBLISHER_PLATFORM_CC');
    const defaultTimeoutMs = this.configNumber('PUBLISHER_DEFAULT_TIMEOUT_MS')
      ?? this.numberSetting(apiGatewayConfig, 'defaultTimeoutMs');
    const streamTimeoutMs = this.configNumber('PUBLISHER_STREAM_TIMEOUT_MS');
    const firstTokenTimeoutMs = this.configNumber('PUBLISHER_FIRST_TOKEN_TIMEOUT_MS');
    const attemptTimeoutMs = this.configNumber('PUBLISHER_ATTEMPT_TIMEOUT_MS');
    const maxBodySize = this.configNumber('PUBLISHER_MAX_BODY_SIZE');
    const maxFallbackDepth = this.configNumber('PUBLISHER_MAX_FALLBACK_DEPTH');

    const body: PublisherPlatformConfig = {
      default_provider_strategy: this.providerStrategy(
        this.configString('PUBLISHER_DEFAULT_PROVIDER_STRATEGY') ?? 'weight',
      ),
      operational: {
        idempotency_attr: this.configString('PUBLISHER_OPERATIONAL_IDEMPOTENCY_ATTR') ?? 'tenant_id',
        kafka_partition_attr: this.configString('PUBLISHER_OPERATIONAL_KAFKA_PARTITION_ATTR') ?? 'tenant_id',
        full_detail_attr: this.configString('PUBLISHER_OPERATIONAL_FULL_DETAIL_ATTR') ?? 'tenant_id',
      },
    };

    if (platformRpm !== undefined) body.platform_rpm = platformRpm;
    if (platformCc !== undefined) body.platform_cc = platformCc;
    if (defaultTimeoutMs !== undefined) body.default_timeout_ms = defaultTimeoutMs;
    if (streamTimeoutMs !== undefined) body.stream_timeout_ms = streamTimeoutMs;
    if (firstTokenTimeoutMs !== undefined) body.first_token_timeout_ms = firstTokenTimeoutMs;
    if (attemptTimeoutMs !== undefined) body.attempt_timeout_ms = attemptTimeoutMs;
    if (maxBodySize !== undefined) body.max_body_size = maxBodySize;
    if (maxFallbackDepth !== undefined) body.max_fallback_depth = maxFallbackDepth;
    if (defaultRoutePolicy) body.default_route_policy = defaultRoutePolicy;
    if (auth) body.auth = auth;
    if (retryBudget) body.retry_budget = retryBudget;
    if (responsesAffinityEnabled !== undefined) {
      body.responses_affinity_enabled = responsesAffinityEnabled;
    }

    return body;
  }

  private async loadApiGatewayConfig(): Promise<Record<string, unknown>> {
    try {
      const row = await this.prisma.systemConfig.findUnique({
        where: { key: 'apiGatewayConfig' },
        select: { value: true },
      });
      return this.parseJsonObject(row?.value) ?? {};
    } catch (err) {
      this.logger.warn(`skip system apiGatewayConfig for publisher platform config: ${(err as Error).message}`);
      return {};
    }
  }

  private defaultRoutePolicyConfig(): PublisherPlatformConfig['default_route_policy'] | undefined {
    const allowFallback = this.configBoolean('PUBLISHER_DEFAULT_ALLOW_FALLBACK');
    const preferredProviders = this.configStringList('PUBLISHER_DEFAULT_PREFERRED_PROVIDERS');
    const complianceTags = this.configStringList('PUBLISHER_DEFAULT_COMPLIANCE_TAGS');

    const policy: NonNullable<PublisherPlatformConfig['default_route_policy']> = {};
    if (allowFallback !== undefined) policy.allow_fallback = allowFallback;
    if (preferredProviders?.length) policy.preferred_providers = preferredProviders;
    if (complianceTags?.length) policy.compliance_tags = complianceTags;

    return Object.keys(policy).length > 0 ? policy : undefined;
  }

  private authRuntimeConfig(): PublisherPlatformConfig['auth'] | undefined {
    const auth: NonNullable<PublisherPlatformConfig['auth']> = {};
    const preAuthIpRpm = this.configNumber('PUBLISHER_AUTH_PRE_AUTH_IP_RPM');
    const abuseFailThreshold = this.configNumber('PUBLISHER_AUTH_ABUSE_FAIL_THRESHOLD');
    const idempotencyTtlSec = this.configNumber('PUBLISHER_AUTH_IDEMPOTENCY_TTL_SEC');
    if (preAuthIpRpm !== undefined) auth.pre_auth_ip_rpm = preAuthIpRpm;
    if (abuseFailThreshold !== undefined) auth.abuse_fail_threshold = abuseFailThreshold;
    if (idempotencyTtlSec !== undefined) auth.idempotency_ttl_sec = idempotencyTtlSec;
    return Object.keys(auth).length > 0 ? auth : undefined;
  }

  private retryBudgetConfig(): PublisherPlatformConfig['retry_budget'] | undefined {
    const keys = [
      'PUBLISHER_RETRY_BUDGET_MAX_KEYS_PER_PROVIDER',
      'PUBLISHER_RETRY_BUDGET_MAX_PROVIDERS',
      'PUBLISHER_RETRY_BUDGET_TOTAL_WALL_TIME_MS',
    ] as const;
    const present = keys.map((key) => this.hasConfigValue(key));
    if (!present.some(Boolean)) return undefined;
    if (!present.every(Boolean)) {
      throw new Error('Invalid publisher retry_budget config: all three axes must be set together');
    }

    const maxKeysPerProvider = this.configNumber(keys[0]);
    const maxProviders = this.configNumber(keys[1]);
    const totalWallTimeMs = this.configNumber(keys[2]);
    const values = [maxKeysPerProvider, maxProviders, totalWallTimeMs];
    if (values.some((value) => value === undefined || value <= 0)) {
      throw new Error('Invalid publisher retry_budget config: values must be positive integers');
    }

    return {
      max_keys_per_provider: maxKeysPerProvider as number,
      max_providers: maxProviders as number,
      total_wall_time_ms: totalWallTimeMs as number,
    };
  }

  private providerStrategy(value: string): NonNullable<PublisherPlatformConfig['default_provider_strategy']> {
    if (['priority', 'weight', 'latency', 'least_busy'].includes(value)) {
      return value as NonNullable<PublisherPlatformConfig['default_provider_strategy']>;
    }
    this.logger.warn(`unknown publisher default provider strategy "${value}", fallback to weight`);
    return 'weight';
  }

  private replayIdempotencyKey(
    replayRunId: string,
    namespace: PublisherNamespace,
    method: PublisherHttpMethod,
    path: string,
    body?: unknown,
  ): string {
    const digest = createHash('sha256')
      .update(JSON.stringify({ replayRunId, namespace, method, path, body: body ?? null }))
      .digest('hex')
      .slice(0, 32);
    const run = replayRunId.replace(/-/g, '').slice(0, 16);
    return `rd:replay:${run}:${digest}`;
  }

  private freshApiKeyIdempotencyKey(resourceId?: string): string {
    const id = (resourceId ?? 'unknown').replace(/[^a-zA-Z0-9_-]/g, '').slice(0, 36) || 'unknown';
    return `rd:api-key:${id}:${randomUUID()}`;
  }

  private async buildKeyMeta(
    key: ApiKeyRow,
    options: { forceActiveForProvision?: boolean } = {},
  ): Promise<KeyMetaBuild> {
    const allowedModels = this.parseStringArray(key.allowedModels);
    const ipWhitelist = this.parseStringArray(key.ipWhitelist);
    const providerResaleAccess = await this.resolveProviderResaleKeyAccess(key);
    const baseStatus = options.forceActiveForProvision
      ? 'active'
      : this.publisherKeyStatus(key);
    const status: PublisherKeyStatus =
      baseStatus === 'active' && providerResaleAccess.kind === 'unavailable'
        ? 'suspended'
        : baseStatus;
    const dedicatedUpstream =
      status === 'active' && providerResaleAccess.kind === 'active'
        ? await this.buildDedicatedUpstream(providerResaleAccess)
        : undefined;
    // 自营 CodingPlan entitlement key：allowed_models 以套餐 ModelAccess 为权威派生（不信任用户自填扩权），
    // 并恒强制白名单（空集=空白名单全拦，fail-closed）。严格只对自营（platform_model_package）生效；
    // 转售(provider_resale)与通用 SUBSCRIPTION/PAYG 维持原有「用户自填」口径不变。
    let effectiveAllowedModels = allowedModels;
    let enforceModelWhitelist = allowedModels.length > 0;
    // codingPlanEntitlementId 仅自营/转售 CodingPlan key 才有；下方 entitlement 查询再按 fulfillmentMode 排除转售。
    if (providerResaleAccess.kind === 'not_provider_resale' && key.codingPlanEntitlementId && key.productId) {
      const entitlement = await this.findActiveCodingPlanEntitlementForKey({
        userId: key.userId,
        tenantId: key.tenantId,
        productId: key.productId,
        entitlementId: key.codingPlanEntitlementId,
      });
      if (entitlement && entitlement.fulfillmentMode !== 'provider_resale' && entitlement.planId) {
        effectiveAllowedModels = await this.deriveEffectiveAllowedModels(entitlement.planId, allowedModels);
        enforceModelWhitelist = true; // 自营恒强制（空集 fail-closed 全拦）
      }
    }
    // provider-resale dedicated 上游的配额/限流由上游权益侧承载，billing 不下发 key 级 rpm/tpm 或 quota gate。
    const policies = providerResaleAccess.kind !== 'not_provider_resale'
      ? []
      : this.keyRateLimitPolicies(key);
    const maxTokensPerCall = this.positiveInteger(key.maxTokensPerCall);
    const guardrails = this.keyGuardrails(key);
    const tenantId = key.tenantId?.trim();
    if (!tenantId) {
      throw new Error(`API Key ${key.id} missing tenantId for publisher sync`);
    }
    const productId = key.productId?.trim();
    if (!productId) {
      throw new Error(`API Key ${key.id} missing productId for publisher routing ScopeAttrs`);
    }
    const scopeAttrs: Record<string, string> = {
      tenant_id: tenantId,
      user_id: key.userId,
      product_id: productId,
      client_compat: 'all',
    };
    scopeAttrs['usr.product_id'] = productId;
    if (key.product?.slug) scopeAttrs['usr.product_slug'] = key.product.slug;
    if (key.product?.billingMode === ProductBillingMode.PAY_AS_YOU_GO) {
      scopeAttrs.product_policy_required = 'true';
      scopeAttrs['usr.product_policy_required'] = 'true';
    }
    if (key.codingPlanEntitlementId) {
      scopeAttrs['usr.coding_plan_entitlement_id'] = key.codingPlanEntitlementId;
      scopeAttrs['usr.entitlement_id'] = key.codingPlanEntitlementId;
    }
    const segmentIds = await this.userSegmentIds(key.userId);
    if (segmentIds.length > 0) {
      this.assertSegmentIds(segmentIds);
      scopeAttrs.segment_ids = segmentIds.join(',');
      scopeAttrs['usr.segment_ids'] = segmentIds.join(',');
    }

    if (baseStatus === 'active' && providerResaleAccess.kind === 'unavailable') {
      this.logger.warn(
        `suspend provider-resale api key=${key.id} entitlement=${providerResaleAccess.entitlementId}: `
        + `${providerResaleAccess.reason} (${providerResaleAccess.detail})`,
      );
    }

    return {
      body: {
        key_id: key.id,
        key_hash: key.keyHash,
        alias: key.name,
        scope_attrs: scopeAttrs,
        status,
        expires_at: key.expiresAt ? Math.floor(key.expiresAt.getTime() / 1000) : 0,
        ip_whitelist: ipWhitelist,
        ...(enforceModelWhitelist ? { enforce_model_whitelist: true } : {}),
        allowed_models: effectiveAllowedModels,
        ...(dedicatedUpstream ? { dedicated_upstream: dedicatedUpstream } : {}),
        ...(policies.length ? { policies } : {}),
        ...(maxTokensPerCall ? { max_tokens_per_call: maxTokensPerCall } : {}),
        ...(guardrails ? { guardrails } : {}),
      },
      providerResaleAccess,
    };
  }

  /**
   * 自营 CodingPlan key 的有效模型白名单（单一口径，供发布/建 key 校验/UI 复用）：
   * = 交集(plan active ModelAccess 模型集, 用户自填 keyAllowedModels)；用户未自填则取全套餐授权集。
   * 用户只能在套餐授权内**收窄、不能扩权**；返回空集即「套餐未授权任何模型/交集为空」，
   * 调用方应 fail-closed（发布空白名单全拦 / 建 key 拒绝）。仅自营调用，转售不走此逻辑。
   */
  private async deriveEffectiveAllowedModels(
    planId: string,
    keyAllowedModels: string[],
  ): Promise<string[]> {
    const access = await this.prisma.modelAccess.findMany({
      where: { planId, isActive: true },
      select: { modelName: true },
    });
    const planModels = access.map((a) => a.modelName);
    if (keyAllowedModels.length === 0) return planModels;
    const planSet = new Set(planModels);
    return keyAllowedModels.filter((m) => planSet.has(m));
  }

  private async resolveProviderResaleKeyAccess(key: {
    id: string;
    tenantId?: string | null;
    productId?: string | null;
    codingPlanEntitlementId?: string | null;
  }): Promise<ProviderResaleKeyAccess> {
    const tenantId = key.tenantId?.trim();
    const productId = key.productId?.trim();
    const entitlementId = key.codingPlanEntitlementId?.trim();
    if (!tenantId || !productId || !entitlementId) return { kind: 'not_provider_resale' };
    const entitlement = await this.prisma.codingPlanEntitlement.findFirst({
      where: {
        id: entitlementId,
        tenantId,
        productId,
      },
      select: {
        id: true,
        planId: true,
        status: true,
        fulfillmentMode: true,
        expiresAt: true,
        providerCode: true,
        providerLineCode: true,
        providerLine: {
          select: {
            ...PROVIDER_RESALE_ROUTE_LINE_IDENTITY_SELECT,
            providerCode: true,
            adapterType: true,
            runtimeEnabled: true,
            dedicatedEndpoints: true,
          },
        },
        providerEntitlement: {
          select: {
            id: true,
            status: true,
            ...DEDICATED_PROVIDER_ACCOUNT_SOURCE_SELECT,
            providerLineId: true,
            adapterType: true,
            providerLineCode: true,
            upstreamProductId: true,
            upstreamApiKeyEncrypted: true,
            upstreamSecretKeyEncrypted: true,
            productEndTime: true,
            activatedAt: true,
            updatedAt: true,
            providerLine: {
              select: {
                ...DEDICATED_PROVIDER_ACCOUNT_SOURCE_SELECT.providerLine.select,
                id: true,
                code: true,
                adapterType: true,
                runtimeEnabled: true,
                dedicatedEndpoints: true,
              },
            },
          },
        },
      },
    });
    if (!entitlement || entitlement.fulfillmentMode !== CodingPlanFulfillmentMode.provider_resale) {
      return { kind: 'not_provider_resale' };
    }

    const now = Date.now();
    if (entitlement.status !== CodingPlanEntitlementStatus.ACTIVE) {
      return this.providerResaleUnavailable(
        entitlement.id,
        'entitlement_inactive',
        `customer entitlement status=${entitlement.status}`,
      );
    }
    if (entitlement.expiresAt && entitlement.expiresAt.getTime() <= now) {
      return this.providerResaleUnavailable(
        entitlement.id,
        'entitlement_expired',
        `customer entitlement expiresAt=${entitlement.expiresAt.toISOString()}`,
      );
    }
    const providerEntitlement = entitlement.providerEntitlement;
    if (!providerEntitlement) {
      return this.providerResaleUnavailable(
        entitlement.id,
        'provider_entitlement_missing',
        'customer entitlement is not bound to a provider entitlement',
      );
    }
    if (providerEntitlement.status !== CodingPlanProviderEntitlementStatus.ACTIVE) {
      return this.providerResaleUnavailable(
        entitlement.id,
        'provider_entitlement_inactive',
        `provider entitlement=${providerEntitlement.id} status=${providerEntitlement.status}`,
      );
    }
    if (providerEntitlement.productEndTime && providerEntitlement.productEndTime.getTime() <= now) {
      return this.providerResaleUnavailable(
        entitlement.id,
        'provider_entitlement_expired',
        `provider entitlement=${providerEntitlement.id} productEndTime=${providerEntitlement.productEndTime.toISOString()}`,
      );
    }
    if (!providerEntitlement.upstreamApiKeyEncrypted || !providerEntitlement.upstreamSecretKeyEncrypted) {
      return this.providerResaleUnavailable(
        entitlement.id,
        'provider_credentials_missing',
        `provider entitlement=${providerEntitlement.id} missing upstream credential`,
      );
    }

    const providerLine = entitlement.providerLine ?? providerEntitlement.providerLine ?? null;
    const lineLabel = providerLine?.code
      ?? providerEntitlement.providerLine?.code
      ?? entitlement.providerLineCode
      ?? providerEntitlement.providerLineCode
      ?? entitlement.providerCode
      ?? providerEntitlement.providerCode
      ?? providerEntitlement.provider;
    if (providerLine?.runtimeEnabled === false) {
      return this.providerResaleUnavailable(
        entitlement.id,
        'provider_line_runtime_disabled',
        `provider line=${lineLabel ?? providerLine.id ?? '<unknown>'} runtimeEnabled=false`,
      );
    }
    let endpoints: PublisherDedicatedUpstreamEndpoint[];
    try {
      const runtimeProviderLines = await this.productRuntimeProviderLines(productId);
      const runtimeLines = await this.providerResaleRuntimeLinesForEntitlement(entitlement);
      endpoints = this.buildDedicatedUpstreamEndpointsForLines(
        runtimeLines,
        runtimeProviderLines,
      );
    } catch (err) {
      return this.providerResaleUnavailable(
        entitlement.id,
        'dedicated_endpoints_invalid',
        err instanceof Error ? err.message : String(err),
      );
    }

    return {
      kind: 'active',
      entitlementId: entitlement.id,
      providerEntitlement,
      expiresAt: providerEntitlement.productEndTime ?? entitlement.expiresAt,
      endpoints,
    };
  }

  private providerResaleUnavailable(
    entitlementId: string,
    reason: ProviderResaleUnavailableReason,
    detail: string,
  ): ProviderResaleKeyAccess {
    return { kind: 'unavailable', entitlementId, reason, detail };
  }

  private async buildDedicatedUpstream(
    access: Extract<ProviderResaleKeyAccess, { kind: 'active' }>,
  ): Promise<PublisherDedicatedUpstream> {
    const encryptionKey = resolveEncryptionKey(this.config);
    if (!encryptionKey) {
      throw new ServiceUnavailableException('ENCRYPTION_KEY 未配置，不能发布 dedicated upstream key');
    }
    const providerEntitlement = access.providerEntitlement;
    validateDedicatedProviderAccountIdentityInheritance(providerEntitlement);
    const providerAccountRef = this.providerAccountRef({
      identity: providerEntitlement.providerAccountIdentity,
      expectedProvider: resolveDedicatedProviderCode(providerEntitlement),
      forbiddenValues: [
        providerEntitlement.id,
        providerEntitlement.upstreamApiKeyEncrypted,
        providerEntitlement.upstreamSecretKeyEncrypted,
      ],
      source: `CodingPlanProviderEntitlement ${providerEntitlement.id}`,
    });
    const upstreamCredential = decryptCodingPlanProviderUpstreamCredential(providerEntitlement, encryptionKey);
    const encrypted = await this.encryptDedicatedUpstreamCredential(upstreamCredential);
    if (providerAccountRef === encrypted.ciphertext) {
      throw new Error(
        `CodingPlanProviderEntitlement ${providerEntitlement.id}: provider_account_ref 不能复用凭据或路由标识`,
      );
    }
    const updatedAt = providerEntitlement.updatedAt ?? providerEntitlement.activatedAt ?? new Date();

    return {
      upstream_key_id: providerEntitlement.id,
      provider_account_ref: providerAccountRef,
      ciphertext: encrypted.ciphertext,
      ciphertext_version: this.dedicatedCiphertextVersion(updatedAt),
      ciphertext_sha256: encrypted.ciphertextSha256,
      kms_key_id: encrypted.kmsKeyId,
      status: 'active',
      expires_at: access.expiresAt ? Math.floor(access.expiresAt.getTime() / 1000) : 0,
      updated_at: updatedAt.toISOString(),
      fallback_allowed: false,
      endpoints: access.endpoints,
    };
  }

  private buildDedicatedUpstreamEndpointsForLines(
    runtimeLines: ProviderResaleRuntimeLine[],
    productRuntimeProviderLines: Map<string, string | null>,
  ): PublisherDedicatedUpstreamEndpoint[] {
    const endpoints: PublisherDedicatedUpstreamEndpoint[] = [];
    for (const runtimeLine of runtimeLines) {
      if (runtimeLine.providerLine?.runtimeEnabled === false) continue;
      endpoints.push(...this.buildDedicatedUpstreamEndpoints(
        runtimeLine.providerLine,
        runtimeLine.lineLabel,
        productRuntimeProviderLines,
      ));
    }
    if (endpoints.length === 0) {
      throw new ServiceUnavailableException('CodingPlan 转售履约线路缺少可用 dedicated endpoints 配置');
    }
    const seenProtocols = new Set<string>();
    for (const endpoint of endpoints) {
      if (seenProtocols.has(endpoint.client_protocol)) {
        throw new Error(
          `CodingPlan 转售多线路 dedicated endpoint client_protocol 重复: ${endpoint.client_protocol}`,
        );
      }
      seenProtocols.add(endpoint.client_protocol);
    }
    return endpoints;
  }

  private buildDedicatedUpstreamEndpoints(
    providerLine: ProviderResaleProviderLineRef | null,
    lineLabel: string | null | undefined,
    productRuntimeProviderLines: Map<string, string | null>,
  ): PublisherDedicatedUpstreamEndpoint[] {
    const endpointConfigs = this.dedicatedEndpointConfigs(
      providerLine?.dedicatedEndpoints,
      `CodingPlan provider line ${lineLabel ?? '<unknown>'}`,
    );
    const endpoints = endpointConfigs.map((endpoint) => ({
      client_protocol: endpoint.client_protocol,
      provider_id: this.dedicatedRuntimeProviderId(providerLine, endpoint, productRuntimeProviderLines),
      protocol_strategy: this.dedicatedEndpointProtocolChannel(endpoint, endpointConfigs),
    }));
    if (endpoints.length === 0) {
      throw new ServiceUnavailableException(
        `CodingPlan 转售履约线路缺少 dedicated endpoints 配置${lineLabel ? `: ${lineLabel}` : ''}`,
      );
    }
    return endpoints;
  }

  private async providerResaleRuntimeLinesForEntitlement(
    entitlement: ProviderResaleEntitlementRouteContext,
  ): Promise<ProviderResaleRuntimeLine[]> {
    const primaryProviderEntitlement = entitlement.providerEntitlement;
    const primaryLine = entitlement.providerLine ?? primaryProviderEntitlement?.providerLine ?? null;
    const fallbackLine = {
      providerLine: primaryLine,
      lineLabel: this.providerResaleLineLabel(entitlement),
    };
    if (
      !entitlement.planId
      || !primaryProviderEntitlement?.providerLineId
      || !primaryProviderEntitlement.upstreamProductId
    ) {
      return [fallbackLine];
    }

    const now = new Date();
    const routes = await this.prisma.codingPlanResaleRoute.findMany({
      where: {
        planId: entitlement.planId,
        enabled: true,
        OR: [{ startAt: null }, { startAt: { lte: now } }],
        AND: [{ OR: [{ endAt: null }, { endAt: { gt: now } }] }],
      },
      select: {
        id: true,
        providerLineId: true,
        upstreamProductId: true,
        priority: true,
        market: true,
        currency: true,
        salesChannel: true,
        userSegmentId: true,
        providerLine: {
          select: {
            ...PROVIDER_RESALE_ROUTE_LINE_IDENTITY_SELECT,
            providerCode: true,
            adapterType: true,
            runtimeEnabled: true,
            dedicatedEndpoints: true,
          },
        },
      },
      orderBy: [{ priority: 'asc' }, { createdAt: 'asc' }, { id: 'asc' }],
    });
    const primaryRoute = routes.find((route) =>
      route.providerLineId === primaryProviderEntitlement.providerLineId
      && route.upstreamProductId === primaryProviderEntitlement.upstreamProductId);
    if (!primaryRoute) return [fallbackLine];

    const group = routes.filter((route) =>
      route.priority === primaryRoute.priority
      && this.sameResaleRouteDimensions(route, primaryRoute));
    const expectedProviderCode = resolveDedicatedProviderCode({
      ...primaryProviderEntitlement,
      providerLine: primaryLine,
    });
    const expectedAdapterType = primaryProviderEntitlement.adapterType
      ?? primaryLine?.adapterType
      ?? null;
    const primaryAccountIdentityId = validateDedicatedProviderAccountIdentityInheritance(
      primaryProviderEntitlement,
    );
    validateProviderResaleRouteGroupAccountIdentity(
      group.map((route) => route.providerLine),
      {
        requireIdentity: true,
        expectedProviderAccountIdentityId: primaryAccountIdentityId,
      },
    );
    for (const route of group) {
      if (
        route.upstreamProductId !== primaryProviderEntitlement.upstreamProductId
        || resolveDedicatedProviderCode({ providerLine: route.providerLine }) !== expectedProviderCode
        || route.providerLine.adapterType !== expectedAdapterType
      ) {
        throw new Error(
          'CodingPlan 转售多线路绑定必须共享供应商、适配器和上游产品',
        );
      }
    }

    const seenLineIds = new Set<string>();
    const runtimeLines: ProviderResaleRuntimeLine[] = [];
    for (const route of group) {
      if (seenLineIds.has(route.providerLine.id)) continue;
      seenLineIds.add(route.providerLine.id);
      runtimeLines.push({
        providerLine: route.providerLine,
        lineLabel: route.providerLine.code,
      });
    }
    return runtimeLines.length > 0 ? runtimeLines : [fallbackLine];
  }

  private sameResaleRouteDimensions(
    left: Pick<ProviderResaleRouteGroupRow, 'market' | 'currency' | 'salesChannel' | 'userSegmentId'>,
    right: Pick<ProviderResaleRouteGroupRow, 'market' | 'currency' | 'salesChannel' | 'userSegmentId'>,
  ): boolean {
    return this.normalizedOptionalText(left.market) === this.normalizedOptionalText(right.market)
      && this.normalizedOptionalText(left.currency)?.toLowerCase() === this.normalizedOptionalText(right.currency)?.toLowerCase()
      && this.normalizedOptionalText(left.salesChannel) === this.normalizedOptionalText(right.salesChannel)
      && this.normalizedOptionalText(left.userSegmentId) === this.normalizedOptionalText(right.userSegmentId);
  }

  private providerResaleLineLabel(entitlement: ProviderResaleEntitlementRouteContext): string | null {
    return entitlement.providerLine?.code
      ?? entitlement.providerEntitlement?.providerLine?.code
      ?? entitlement.providerLineCode
      ?? entitlement.providerEntitlement?.providerLineCode
      ?? entitlement.providerEntitlement?.providerCode
      ?? entitlement.providerEntitlement?.provider
      ?? null;
  }

  private normalizedOptionalText(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    return text.length > 0 ? text : null;
  }

  private async productRuntimeProviderLines(productId: string): Promise<Map<string, string | null>> {
    const productChannels = await this.prisma.productChannel.findMany({
      where: {
        productId,
        deletedAt: null,
        channel: { deletedAt: null },
      },
      select: { id: true, metadata: true, providerLineId: true },
    });
    return new Map(productChannels
      .filter((pc) => this.productChannelHasDedicatedIsolation(pc))
      .map((pc) => [this.productChannelProviderId(pc.id), pc.providerLineId ?? null]));
  }

  private dedicatedRuntimeProviderId(
    providerLine: Pick<ProviderResaleProviderLineRef, 'id' | 'code'> | null,
    endpoint: DedicatedEndpointConfig,
    productRuntimeProviderLines: Map<string, string | null> = new Map(),
  ): string {
    const configured = endpoint.provider_id.trim();
    if (configured.startsWith('pc_')) {
      if (this.dedicatedEndpointHasRuntimeConfig(endpoint)) {
        throw new Error(
          `CodingPlan dedicated endpoint ${configured} for provider line ${providerLine?.code || providerLine?.id || '<unknown>'} `
          + 'must be reference-only; configure runtime provider base_url/provider_profile on a dedicated ProductChannel',
        );
      }
      if (!productRuntimeProviderLines.has(configured)) {
        const available = Array.from(productRuntimeProviderLines.keys()).sort().join(', ') || '<none>';
        throw new Error(
          `CodingPlan dedicated endpoint ${configured} is not an enabled ProductChannel-backed Runtime Provider; `
          + `available providers: ${available}`,
        );
      }
      const linkedProviderLineId = productRuntimeProviderLines.get(configured) ?? null;
      const expectedProviderLineId = providerLine?.id?.trim() || null;
      if (!linkedProviderLineId) {
        throw new Error(
          `CodingPlan dedicated endpoint ${configured} is missing ProductChannel.providerLineId; `
          + 're-run the ProductChannel provider-line backfill before publishing',
        );
      }
      if (expectedProviderLineId && linkedProviderLineId !== expectedProviderLineId) {
        throw new Error(
          `CodingPlan dedicated endpoint ${configured} belongs to provider line ${linkedProviderLineId}, `
          + `not ${expectedProviderLineId}`,
        );
      }
      return configured;
    }
    const available = Array.from(productRuntimeProviderLines.keys()).sort().join(', ') || '<none>';
    const line = providerLine?.code || providerLine?.id || '<unknown>';
    throw new Error(
      `CodingPlan dedicated endpoint ${configured} for provider line ${line} must resolve to a pc_* Runtime Provider; `
      + `configure provider_id as one of ProductChannel-backed providers [${available}]`,
    );
  }

  private dedicatedEndpointHasRuntimeConfig(endpoint: DedicatedEndpointConfig): boolean {
    return this.dedicatedEndpointRuntimeConfigKeys(endpoint as Record<string, unknown>).length > 0;
  }

  private async encryptDedicatedUpstreamCredential(plaintext: string): Promise<{
    ciphertext: string;
    ciphertextSha256: string;
    kmsKeyId: string;
  }> {
    switch (this.dedicatedKmsProvider()) {
      case 'aws':
        return this.encryptDedicatedUpstreamCredentialWithAwsKms(plaintext);
      case 'alicloud':
        return this.encryptDedicatedUpstreamCredentialWithAliCloudKms(plaintext);
      case 'local':
        return this.encryptDedicatedUpstreamCredentialWithGatewayLocalSecret(plaintext);
      default:
        throw new ServiceUnavailableException('unsupported dedicated upstream KMS provider');
    }
  }

  private encryptDedicatedUpstreamCredentialWithGatewayLocalSecret(plaintext: string): {
    ciphertext: string;
    ciphertextSha256: string;
    kmsKeyId: string;
  } {
    if (this.isProduction()) {
      throw new ServiceUnavailableException('KMS_PROVIDER=local is not allowed in production dedicated upstream key publish');
    }
    const gatewaySecret = this.gatewayLocalSecret();
    if (!gatewaySecret) {
      throw new ServiceUnavailableException(
        'KMS_HMAC_SECRET 或 ENCRYPTION_KEY 未配置，不能发布 dedicated upstream local key',
      );
    }
    const localCiphertext = encryptGatewayLocalSecret(plaintext, gatewaySecret);
    const payload = localCiphertext.startsWith('enc:')
      ? localCiphertext.slice('enc:'.length)
      : localCiphertext;
    if (!payload.startsWith('local:')) {
      throw new ServiceUnavailableException('gateway local encrypt returned unexpected ciphertext envelope');
    }
    const ciphertext = `kms:${payload}`;
    return {
      ciphertext,
      ciphertextSha256: `sha256:${createHash('sha256').update(ciphertext).digest('hex')}`,
      kmsKeyId: `gateway-local:${createHash('sha256').update(gatewaySecret).digest('hex').slice(0, 6)}`,
    };
  }

  private async encryptDedicatedUpstreamCredentialWithAliCloudKms(plaintext: string): Promise<{
    ciphertext: string;
    ciphertextSha256: string;
    kmsKeyId: string;
  }> {
    const keyId = this.firstConfig('ALICLOUD_KMS_KEY_ID', 'DEDICATED_KMS_KEY_ID', 'DEDICATED_UPSTREAM_KMS_KEY_ID');
    const region = this.firstConfig('ALICLOUD_KMS_REGION', 'DEDICATED_KMS_REGION', 'DEDICATED_UPSTREAM_KMS_REGION');
    const accessKeyId = this.firstConfig('ALICLOUD_ACCESS_KEY_ID', 'ALIBABA_CLOUD_ACCESS_KEY_ID');
    const accessKeySecret = this.firstConfig('ALICLOUD_ACCESS_KEY_SECRET', 'ALIBABA_CLOUD_ACCESS_KEY_SECRET');
    if (!keyId || !region || !accessKeyId || !accessKeySecret) {
      throw new ServiceUnavailableException(
        'KMS_PROVIDER=alicloud requires ALICLOUD_KMS_KEY_ID/REGION and RAM credentials',
      );
    }
    const client = this.createAliCloudKmsClient({
      accessKeyId,
      accessKeySecret,
      securityToken: this.firstConfig('ALICLOUD_SECURITY_TOKEN', 'ALIBABA_CLOUD_SECURITY_TOKEN'),
      regionId: region,
      endpoint: this.firstConfig('ALICLOUD_KMS_ENDPOINT', 'DEDICATED_KMS_ENDPOINT'),
    });
    const result = await client.encrypt(this.createAliCloudKmsEncryptRequest({
      keyId,
      plaintext: Buffer.from(plaintext, 'utf8').toString('base64'),
    }));
    const ciphertextBlob = result.body?.ciphertextBlob?.trim();
    if (!ciphertextBlob) {
      throw new ServiceUnavailableException('AliCloud KMS Encrypt returned empty CiphertextBlob');
    }
    const ciphertext = `kms:alicloud:${ciphertextBlob}`;
    return {
      ciphertext,
      ciphertextSha256: `sha256:${createHash('sha256').update(ciphertext).digest('hex')}`,
      kmsKeyId: result.body?.keyId?.trim() || keyId,
    };
  }

  private createAliCloudKmsClient(config: {
    accessKeyId: string;
    accessKeySecret: string;
    securityToken?: string;
    regionId: string;
    endpoint?: string;
  }): AliCloudKmsEncryptClient {
    const moduleValue = this.loadAliCloudKmsModule();
    const Client = typeof moduleValue === 'function' ? moduleValue : moduleValue.default;
    if (!Client) {
      throw new ServiceUnavailableException('AliCloud KMS SDK client unavailable');
    }
    return new Client({
      accessKeyId: config.accessKeyId,
      accessKeySecret: config.accessKeySecret,
      securityToken: config.securityToken,
      regionId: config.regionId,
      endpoint: config.endpoint,
    });
  }

  private createAliCloudKmsEncryptRequest(config: {
    keyId: string;
    plaintext: string;
  }): AliCloudKmsEncryptRequest {
    const moduleValue = this.loadAliCloudKmsModule();
    const EncryptRequest = typeof moduleValue === 'function'
      ? (moduleValue as unknown as AliCloudKmsModuleObject).EncryptRequest
      : moduleValue.EncryptRequest;
    if (!EncryptRequest) {
      throw new ServiceUnavailableException('AliCloud KMS SDK EncryptRequest unavailable');
    }
    return new EncryptRequest(config);
  }

  private loadAliCloudKmsModule(): AliCloudKmsModule {
    return require('@alicloud/kms20160120') as AliCloudKmsModule;
  }

  private async encryptDedicatedUpstreamCredentialWithAwsKms(plaintext: string): Promise<{
    ciphertext: string;
    ciphertextSha256: string;
    kmsKeyId: string;
  }> {
    if (!this.dedicatedUpstreamKmsClient || !this.dedicatedUpstreamKmsKeyId) {
      throw new ServiceUnavailableException(
        'DEDICATED_UPSTREAM_KMS_KEY_ID 或 CHANNEL_KMS_KEY_ID 未配置，不能发布 dedicated upstream key',
      );
    }
    const result = await this.dedicatedUpstreamKmsClient.send(new EncryptCommand({
      KeyId: this.dedicatedUpstreamKmsKeyId,
      Plaintext: Buffer.from(plaintext, 'utf8'),
    }));
    if (!result.CiphertextBlob) {
      throw new ServiceUnavailableException('KMS Encrypt returned empty CiphertextBlob');
    }
    const ciphertext = `kms:${Buffer.from(result.CiphertextBlob).toString('base64')}`;
    return {
      ciphertext,
      ciphertextSha256: `sha256:${createHash('sha256').update(ciphertext).digest('hex')}`,
      kmsKeyId: this.dedicatedUpstreamKmsKeyId,
    };
  }

  private dedicatedKmsProvider(): DedicatedKmsProvider {
    const raw = this.firstConfig('KMS_PROVIDER', 'DEDICATED_KMS_PROVIDER')?.toLowerCase();
    if (!raw) return this.isProduction() ? 'aws' : 'local';
    if (raw === 'aws' || raw === 'alicloud' || raw === 'local') return raw;
    throw new ServiceUnavailableException(`unsupported KMS_PROVIDER=${raw}`);
  }

  private dedicatedCiphertextVersion(updatedAt: Date): number {
    const version = updatedAt.getTime();
    return Number.isFinite(version) && version > 0 ? Math.floor(version) : 1;
  }

  private async userSegmentIds(userId: string): Promise<string[]> {
    const rows = await this.prisma.userSegmentMember.findMany({
      where: {
        userId,
        segment: {
          isActive: true,
          deletedAt: null,
        },
      },
      select: { segmentId: true },
      orderBy: { segmentId: 'asc' },
    });
    return rows.map((row) => row.segmentId);
  }

  private assertSegmentIds(segmentIds: string[]): void {
    const invalid = segmentIds.filter((id) => !/^[a-zA-Z0-9._:-]+$/.test(id));
    if (invalid.length > 0) {
      throw new Error(`Invalid segment id(s) for publisher ScopeAttrs: ${invalid.join(',')}`);
    }
    if (segmentIds.length > 100) {
      throw new Error(`Too many segment ids for publisher ScopeAttrs: ${segmentIds.length}`);
    }
  }

  private publisherKeyStatus(key: Pick<ApiKeyRow, 'deletedAt' | 'isActive' | 'mirrorStatus'>): 'active' | 'suspended' | 'revoked' {
    if (key.deletedAt || key.mirrorStatus === 'REVOKED') return 'revoked';
    if (key.isActive && key.mirrorStatus === 'ACTIVE') return 'active';
    return 'suspended';
  }

  async buildProductRouteGraph(productId: string): Promise<PublisherProductRouteGraphIntent> {
    const now = new Date();
    const [groups, productChannels, assignments, activeRuntimeModels] = await Promise.all([
      this.prisma.productChannelGroup.findMany({
        where: { productId, deletedAt: null },
        orderBy: [{ isDefault: 'desc' }, { code: 'asc' }],
        include: {
          members: {
            orderBy: [{ priority: 'asc' }, { weight: 'desc' }],
            include: {
              productChannel: {
                include: { channel: true },
              },
            },
          },
        },
      }),
      this.prisma.productChannel.findMany({
        where: { productId, deletedAt: null },
        orderBy: [{ priority: 'asc' }, { weight: 'desc' }],
        include: {
          channel: {
            include: {
              providerAccountIdentity: {
                select: { ref: true, providerCode: true, status: true },
              },
            },
          },
        },
      }),
      this.prisma.routeAssignment.findMany({
        where: {
          productId,
          isActive: true,
          AND: [
            { OR: [{ startsAt: null }, { startsAt: { lte: now } }] },
            { OR: [{ endsAt: null }, { endsAt: { gt: now } }] },
          ],
        },
        orderBy: [{ priority: 'desc' }, { updatedAt: 'desc' }],
      }),
      this.runtimeActiveModelNames(),
    ]);

    const routedProductChannels = this.productChannelsParticipatingInRouteGraph(
      productChannels,
      groups,
      assignments,
    );
    const pcModels = new Map(routedProductChannels.map((pc) => [
      pc.id,
      this.modelsForProductChannel(pc, activeRuntimeModels),
    ]));
    for (const pc of routedProductChannels) {
      if ((pcModels.get(pc.id) ?? []).length === 0) {
        throw new Error(
          `ProductChannel ${pc.id} has no runtime models for RuntimeIntent route_graph; configure allowedModels or concrete channel.models`,
        );
      }
    }
    return this.buildProductRouteGraphFromRows(productId, routedProductChannels, groups, assignments, pcModels);
  }

  private buildProductRoutePolicyIntent(
    product: RuntimeProductRow,
    productChannels: RuntimeProductChannelRow[],
    groups: RuntimeGroupRow[],
    assignments: RuntimeAssignmentRow[],
    pcModels: Map<string, string[]>,
  ): PublisherProductRoutePolicyIntent {
    const policy = product.runtimePolicy;
    if (!policy) {
      throw new Error(`Product ${product.id} missing runtime policy while building RuntimeIntent`);
    }
    const routedProductChannels = productChannels.filter((pc) => pc.status !== 'disabled');
    const allowedProviderIds = routedProductChannels.map((pc) => this.productChannelProviderId(pc.id));
    const isPaygProduct = product.billingMode === ProductBillingMode.PAY_AS_YOU_GO;
    const policyAllowedModels = this.stringArrayValue(policy.allowedModels);
    const allowedModels = policyAllowedModels.length > 0
      ? (isPaygProduct
          ? this.uniqueSorted(routedProductChannels.flatMap((pc) => pcModels.get(pc.id) ?? []))
          : policyAllowedModels)
      : this.uniqueSorted(routedProductChannels.flatMap((pc) => pcModels.get(pc.id) ?? []));
    const routeStrategy = this.productRouteStrategy(policy.routeStrategy);
    const intent: PublisherProductRoutePolicyIntent = {
      product_id: product.id,
      revision: this.nextProductPolicyIntentRevision(),
      product_slug: product.slug,
      status: policy.status === 'disabled' ? 'disabled' : 'active',
      credential_source: this.productCredentialSource(policy.credentialSource),
      model_scope_mode: isPaygProduct ? 'product_allowlist' : this.productModelScopeMode(policy.modelScopeMode),
      fallback_policy: this.productFallbackPolicy(policy.fallbackPolicy),
      billing_mode: isPaygProduct ? 'payg_balance' : this.productRuntimeBillingMode(policy.runtimeBillingMode),
      allow_high_loss_bridge_when_no_native: this.effectiveAllowHighLossBridgeWhenNoNative(policy),
      allow_bridge_on_native_failure: policy.allowBridgeOnNativeFailure === true,
      allowed_provider_ids: allowedProviderIds,
      allowed_channel_ids: this.uniqueSorted(routedProductChannels.map((pc) => pc.channelId)),
      allowed_models: allowedModels,
      ...(routeStrategy ? { route_strategy: routeStrategy } : {}),
    };
    if (routedProductChannels.length === 0) {
      return intent;
    }
    return {
      ...intent,
      route_graph_required: true,
      route_graph_enforcement: ROUTE_GRAPH_ENFORCEMENT,
      route_graph: this.buildProductRouteGraphFromRows(product.id, routedProductChannels, groups, assignments, pcModels),
    };
  }

  private productChannelsParticipatingInRouteGraph(
    productChannels: RuntimeProductChannelRow[],
    groups: RuntimeGroupRow[],
    assignments: RuntimeAssignmentRow[],
  ): RuntimeProductChannelRow[] {
    const referencedProductChannelIds = new Set<string>();
    for (const group of groups) {
      for (const member of group.members) {
        referencedProductChannelIds.add(member.productChannelId);
      }
    }
    for (const assignment of assignments) {
      if (assignment.targetType === 'PRODUCT_CHANNEL') {
        referencedProductChannelIds.add(assignment.targetId);
      }
    }

    if (referencedProductChannelIds.size === 0) {
      return productChannels.filter((pc) => !this.productChannelHasDedicatedIsolation(pc));
    }
    return productChannels.filter((pc) => referencedProductChannelIds.has(pc.id));
  }

  private uniqueProductChannels(productChannels: RuntimeProductChannelRow[]): RuntimeProductChannelRow[] {
    const seen = new Set<string>();
    const out: RuntimeProductChannelRow[] = [];
    for (const pc of productChannels) {
      if (seen.has(pc.id)) continue;
      seen.add(pc.id);
      out.push(pc);
    }
    return out;
  }

  private productChannelHasDedicatedIsolation(productChannel: Pick<RuntimeProductChannelRow, 'id' | 'metadata'>): boolean {
    const isolation = providerEndpointIsolationFromMetadata(
      productChannel.metadata,
      `ProductChannel ${productChannel.id} metadata`,
    );
    return isStrictDedicatedProviderIsolation(isolation);
  }

  private buildProductPolicyDeleteIntent(productId: string): PublisherProductPolicyDeleteIntent {
    return {
      product_id: String(productId ?? '').trim(),
      revision: this.nextProductPolicyIntentRevision(),
    };
  }

  private nextProductPolicyIntentRevision(): number {
    return this.publisher.revision();
  }

  private mergeProductPolicyDeletes(
    deletes: PublisherProductPolicyDeleteIntent[],
  ): PublisherProductPolicyDeleteIntent[] {
    const byProductId = new Map<string, PublisherProductPolicyDeleteIntent>();
    for (const deleted of deletes) {
      const productId = String(deleted.product_id ?? '').trim();
      if (!productId) continue;
      const current = byProductId.get(productId);
      if (!current || deleted.revision > current.revision) {
        byProductId.set(productId, {
          product_id: productId,
          revision: deleted.revision,
        });
      }
    }
    return Array.from(byProductId.values())
      .sort((a, b) => a.product_id.localeCompare(b.product_id));
  }

  private buildProductRouteGraphFromRows(
    productId: string,
    productChannels: RuntimeProductChannelRow[],
    groups: RuntimeGroupRow[],
    assignments: RuntimeAssignmentRow[],
    pcModels: Map<string, string[]>,
  ): PublisherProductRouteGraphIntent {
    if (productChannels.length === 0) {
      throw new Error(`Product ${productId} has no product_channels for RuntimeIntent route_graph`);
    }

    const productChannelIds = new Set(productChannels.map((pc) => pc.id));
    const graphProductChannels = productChannels.map((pc) => {
      const providerId = this.productChannelProviderId(pc.id);
      const allowedModels = this.uniqueSorted(pcModels.get(pc.id) ?? this.modelsForProductChannel(pc));
      const deniedModels = this.uniqueSorted(this.stringArrayValue(pc.deniedModels));
      return {
        id: providerId,
        channel_id: pc.channelId,
        provider_id: providerId,
        allowed_models: allowedModels,
        denied_models: deniedModels,
        priority: pc.priority,
        weight: pc.weight,
        ...(pc.maxRpm !== null ? { max_rpm: pc.maxRpm } : {}),
        ...(pc.maxTpm !== null ? { max_tpm: pc.maxTpm } : {}),
        status: this.productChannelGraphStatus(pc),
      };
    }) as PublisherProductRouteGraphIntent['product_channels'];
    const graphGroups = groups
      .map((group) => {
        const members = group.members
          .filter((member) => productChannelIds.has(member.productChannelId))
          .map((member) => {
            const providerId = this.productChannelProviderId(member.productChannelId);
            return {
              product_channel_id: providerId,
              channel_id: member.productChannel.channelId,
              provider_id: providerId,
              priority: member.priority,
              weight: member.weight,
              role: this.routeMemberRole(member.role),
              ...(member.maxRpm !== null ? { max_rpm: member.maxRpm } : {}),
              ...(member.maxTpm !== null ? { max_tpm: member.maxTpm } : {}),
            };
          });
        return {
          id: group.id,
          code: group.code,
          status: group.status === 'active' ? 'active' as const : 'disabled' as const,
          strategy: this.routeGroupStrategy(group.strategy),
          members,
        };
      })
      .filter((group) => group.members.length > 0);
    const groupIds = new Set(graphGroups.map((group) => group.id));
    const validAssignments = assignments.filter((assignment) => {
      if (assignment.targetType === 'GROUP') return groupIds.has(assignment.targetId);
      if (assignment.targetType === 'PRODUCT_CHANNEL') return productChannelIds.has(assignment.targetId);
      return false;
    });

    return {
      schema_version: 1,
      default_target: this.defaultRouteTarget(productChannels, groups, graphGroups),
      groups: graphGroups,
      product_channels: graphProductChannels,
      assignments: validAssignments.map((assignment) => ({
        id: assignment.id,
        product_id: productId,
        subject_type: this.routeSubjectType(assignment.subjectType),
        subject_id: assignment.subjectId,
        ...(assignment.modelPattern ? { model_pattern: assignment.modelPattern } : {}),
        ...(assignment.clientCompatibility ? { client_compatibility: assignment.clientCompatibility } : {}),
        target_type: this.routeTargetType(assignment.targetType),
        target_id: assignment.targetType === 'PRODUCT_CHANNEL'
          ? this.productChannelProviderId(assignment.targetId)
          : assignment.targetId,
        mode: this.routeAssignmentMode(assignment.mode),
        priority: assignment.priority,
      })),
    };
  }

  private normalizedPathPrefix(value: string | undefined): string | undefined {
    const text = value?.trim();
    if (!text) return undefined;
    const prefixed = text.startsWith('/') ? text : `/${text}`;
    return prefixed.replace(/\/+$/, '') || undefined;
  }

  private dedicatedEndpointConfigs(
    value: unknown,
    source = 'CodingPlan dedicatedEndpoints',
  ): DedicatedEndpointConfig[] {
    if (!Array.isArray(value)) return [];
    const configs = value.map((item, index) => {
      const label = `${source}[${index}]`;
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new Error(`${label} must be an object`);
      }
      const raw = item as Record<string, unknown>;
      const clientProtocol = this.stringValue(raw.client_protocol);
      if (clientProtocol !== 'anthropic' && clientProtocol !== 'openai' && clientProtocol !== 'responses') {
        throw new Error(`${label}.client_protocol is invalid`);
      }
      const providerId = this.stringValue(raw.provider_id);
      if (!providerId) {
        throw new Error(`${label}.provider_id is required`);
      }
      const protocolStrategy = this.stringValue(raw.protocol_strategy);
      if (protocolStrategy && !DEDICATED_PROTOCOL_CHANNEL_SET.has(protocolStrategy)) {
        throw new Error(`${label}.protocol_strategy is invalid`);
      }
      const runtimeConfigKeys = this.dedicatedEndpointRuntimeConfigKeys(raw);
      if (runtimeConfigKeys.length > 0) {
        throw new Error(
          `${label} must be reference-only; move ${runtimeConfigKeys.sort().join(', ')} `
          + 'to a dedicated ProductChannel Runtime Provider',
        );
      }
      const config: DedicatedEndpointConfig = {
        client_protocol: clientProtocol,
        provider_id: providerId,
        ...(protocolStrategy
          ? { protocol_strategy: protocolStrategy as DedicatedEndpointConfig['protocol_strategy'] }
          : {}),
      };
      return config;
    });
    return configs;
  }

  private dedicatedEndpointProtocolChannel(
    endpoint: DedicatedEndpointConfig,
    allEndpoints: DedicatedEndpointConfig[],
  ): NonNullable<PublisherDedicatedUpstreamEndpoint['protocol_strategy']> {
    const strategy = endpoint.protocol_strategy;
    if (strategy && EXPLICIT_DEDICATED_PROTOCOL_CHANNELS.has(strategy)) {
      return strategy as NonNullable<PublisherDedicatedUpstreamEndpoint['protocol_strategy']>;
    }
    if (endpoint.client_protocol === 'openai') return 'passthrough';

    const hasOpenAIEndpointForProvider = allEndpoints.some((candidate) =>
      candidate.provider_id === endpoint.provider_id && candidate.client_protocol === 'openai',
    );
    if (endpoint.client_protocol === 'responses') {
      return hasOpenAIEndpointForProvider ? 'responses_to_chat' : 'passthrough';
    }
    if (endpoint.client_protocol === 'anthropic') {
      return hasOpenAIEndpointForProvider ? 'anthropic_to_chat' : 'passthrough';
    }
    return 'passthrough';
  }

  private dedicatedEndpointRuntimeConfigKeys(raw: Record<string, unknown>): string[] {
    const runtimeKeys = [
      'base_url',
      'baseUrl',
      'provider_profile',
      'providerProfile',
      'path_prefix',
      'pathPrefix',
      'name',
      'code',
      'owned_by',
      'ownedBy',
      'status',
      'logical_models',
      'logicalModels',
      'upstream_model',
      'upstreamModel',
      'upstream_models',
      'upstreamModels',
      'client_compatibility',
      'clientCompatibility',
      'served_inbound_protocols',
      'servedInboundProtocols',
      'capabilities',
      'token_count_strategy',
      'tokenCountStrategy',
      'priority',
      'weight',
      'owner_scope',
      'ownerScope',
    ];
    return runtimeKeys.filter((key) => this.configValuePresent(raw[key]));
  }

  private configValuePresent(value: unknown): boolean {
    if (value === null || value === undefined) return false;
    if (typeof value === 'string') return value.trim().length > 0;
    if (Array.isArray(value)) return value.length > 0;
    if (typeof value === 'object') return Object.keys(value).length > 0;
    return true;
  }

  private buildProviderEndpointIntent(
    providerId: string,
    productChannel: RuntimeProductChannelRow,
    product: RuntimeProductRow,
  ): PublisherProviderEndpointRuntimeIntent {
    if (isSeedanceVideoSdkType(productChannel.channel.sdkType)) {
      seedanceRealmForBaseUrl(productChannel.channel.baseUrl);
    }
    const apiTypes = this.apiTypesFor(this.providerId(productChannel.channel.provider), productChannel.channel.sdkType);
    const { baseUrl, pathPrefix } = this.providerUrlParts(productChannel.channel.baseUrl, apiTypes[0]);
    if (!baseUrl) {
      throw new Error(`ProductChannel ${productChannel.id} channel=${productChannel.channelId} missing baseUrl`);
    }
    const intent = this.providerRuntimeIntentFor(providerId, [productChannel.channel], apiTypes);
    if (!intent) {
      throw new Error(
        `ProductChannel ${productChannel.id} channel=${productChannel.channelId} has unsupported provider profile`,
      );
    }
    const isolation = providerEndpointIsolationFromMetadata(
      productChannel.metadata,
      `ProductChannel ${productChannel.id} metadata`,
    );
    return {
      id: providerId,
      provider_profile: intent.providerProfile,
      base_url: baseUrl,
      status: this.productChannelEndpointStatus(productChannel),
      code: productChannel.channelId,
      ...(productChannel.channel.ownedBy?.trim() ? { owned_by: productChannel.channel.ownedBy.trim() } : {}),
      name: productChannel.displayName
        || `${productChannel.channel.name || productChannel.channel.provider} (${product.slug})`,
      ...(pathPrefix ? { path_prefix: pathPrefix } : {}),
      ...(isolation ?? {}),
    };
  }

  private buildProviderCredentialIntent(
    providerId: string,
    productChannel: RuntimeProductChannelRow,
    models: string[],
    keyRefByChannelId: Map<string, string> = new Map(),
  ): PublisherProviderCredentialIntent {
    let keyRef = keyRefByChannelId.get(productChannel.channelId);
    if (!keyRef) {
      keyRef = this.toPublisherCiphertext(productChannel.channel.apiKeyEncrypted) ?? undefined;
      if (keyRef) keyRefByChannelId.set(productChannel.channelId, keyRef);
    }
    if (!keyRef) {
      throw new Error(`ProductChannel ${productChannel.id} channel=${productChannel.channelId} missing usable key_ref`);
    }
    const providerAccountRef = this.providerAccountRef({
      identity: productChannel.channel.providerAccountIdentity,
      expectedProvider: productChannel.channel.provider,
      forbiddenValues: [
        providerId,
        productChannel.channelId,
        keyRef,
        productChannel.channel.baseUrl,
        productChannel.channel.provider,
        this.providerId(productChannel.channel.provider),
      ],
      source: `ProductChannel ${productChannel.id} channel=${productChannel.channelId}`,
    });
    return {
      provider_id: providerId,
      key_id: productChannel.channelId,
      alias: productChannel.channel.name || productChannel.channelId,
      key_ref: keyRef,
      provider_account_ref: providerAccountRef,
      status: this.productChannelCredentialStatus(productChannel),
      allowed_models: models,
      priority: productChannel.priority,
      weight: productChannel.weight,
      ...(productChannel.maxRpm !== null ? { rpm_limit: productChannel.maxRpm } : {}),
      ...(productChannel.maxTpm !== null ? { tpm_limit: productChannel.maxTpm } : {}),
    };
  }

  private providerAccountRef(input: {
    identity: { ref: unknown; providerCode: unknown; status: unknown } | null | undefined;
    expectedProvider: unknown;
    forbiddenValues: readonly unknown[];
    source: string;
  }): string {
    try {
      return validateProviderAccountIdentityForProvider(
        input.identity,
        input.expectedProvider,
        { forbiddenValues: input.forbiddenValues },
      ).ref;
    } catch (err) {
      const detail = err instanceof Error ? err.message : String(err);
      throw new Error(`${input.source}: provider_account_ref invalid: ${detail}`);
    }
  }

  private buildClientExposureIntent(
    providerId: string,
    productChannel: RuntimeProductChannelRow,
  ): PublisherClientExposureIntent {
    const apiTypes = this.apiTypesFor(this.providerId(productChannel.channel.provider), productChannel.channel.sdkType);
    const providerIntent = this.providerRuntimeIntentFor(providerId, [productChannel.channel], apiTypes);
    if (!providerIntent) {
      throw new Error(`ProductChannel ${productChannel.id} cannot resolve client exposure`);
    }
    const capabilities = this.routeCapabilitiesFor(productChannel.channel);
    if (capabilities.length === 0) {
      throw new Error(`ProductChannel ${productChannel.id} cannot resolve client exposure capabilities`);
    }
    const paths = capabilities.includes('chat') || capabilities.includes('video_generation')
      ? this.protocolPathsForProductChannel(productChannel, providerIntent)
      : [];
    const servedInboundProtocols = paths.length
      ? servedInboundProtocolsForProtocolPaths(paths)
      : this.servedInboundProtocolsForProductChannel(productChannel, providerIntent);
    return {
      provider_id: providerId,
      served_inbound_protocols: servedInboundProtocols,
      ...(paths.length ? { paths } : {}),
      capabilities,
      ...(providerIntent.tokenCountStrategy ? { token_count_strategy: providerIntent.tokenCountStrategy } : {}),
    };
  }

  private protocolPathsForProductChannel(
    productChannel: RuntimeProductChannelRow,
    providerIntent: ProviderRuntimeIntent,
  ): PublisherProtocolPath[] {
    const metadata = this.objectValue(productChannel.metadata);
    const dedicatedRuntime = this.objectValue(metadata.dedicated_runtime ?? metadata.dedicatedRuntime);
    const explicit = normalizeProtocolPathListValue(
      dedicatedRuntime.paths
      ?? dedicatedRuntime.protocol_paths
      ?? dedicatedRuntime.protocolPaths
      ?? productChannel.channel.protocolPaths,
    );
    if (explicit?.length) return explicit;
    return buildProtocolPathsFromServedInboundProtocols(
      this.servedInboundProtocolsForProductChannel(productChannel, providerIntent),
      providerIntent.providerProfile,
    );
  }

  private servedInboundProtocolsForProductChannel(
    productChannel: RuntimeProductChannelRow,
    providerIntent: ProviderRuntimeIntent,
  ): NonNullable<PublisherClientExposureIntent['served_inbound_protocols']> {
    const metadata = this.objectValue(productChannel.metadata);
    const dedicatedRuntime = this.objectValue(metadata.dedicated_runtime ?? metadata.dedicatedRuntime);
    const explicit = normalizeServedInboundProtocolListValue(
      dedicatedRuntime.served_inbound_protocols ?? dedicatedRuntime.servedInboundProtocols,
    );
    return explicit ?? providerIntent.servedInboundProtocols;
  }

  private assertIntentProductChannel(productChannel: RuntimeProductChannelRow): void {
    if (!this.isGatewayRoutableChannel(productChannel.channel)) {
      throw new Error(
        `ProductChannel ${productChannel.id} channel=${productChannel.channelId} sdkType=${productChannel.channel.sdkType} is not gateway routable`,
      );
    }
  }

  private modelsForProductChannel(
    productChannel: RuntimeProductChannelRow,
    activeRuntimeModels: Set<string> | null = null,
  ): string[] {
    const rawChannelModels = this.parseStringArray(productChannel.channel.models);
    const channelModels = rawChannelModels.filter((model) => model !== '*');
    const allowedModels = this.stringArrayValue(productChannel.allowedModels);
    const deniedModels = new Set(this.stringArrayValue(productChannel.deniedModels));
    const sourceModels = allowedModels.length > 0
      ? allowedModels
      : channelModels;
    return this.uniqueSorted(sourceModels
      .filter((model) => this.runtimeModelAllowed(model, activeRuntimeModels))
      .filter((model) => !deniedModels.has(model))
      .filter((model) => this.modelConfigFor(productChannel.channel, model).enabled !== false));
  }

  private async runtimeActiveModelNames(): Promise<Set<string> | null> {
    const rows = await this.prisma.modelPricing.findMany({
      select: { modelName: true, isActive: true },
      orderBy: { modelName: 'asc' },
    });
    if (rows.length === 0) {
      return null;
    }
    return new Set(rows
      .filter((row) => row.isActive)
      .map((row) => row.modelName));
  }

  private runtimeModelAllowed(modelName: string, activeRuntimeModels: Set<string> | null): boolean {
    if (!activeRuntimeModels) return true;
    return activeRuntimeModels.has(modelName);
  }

  private defaultRouteTarget(
    productChannels: RuntimeProductChannelRow[],
    groups: RuntimeGroupRow[],
    graphGroups: PublisherProductRouteGraphIntent['groups'],
  ): PublisherProductRouteGraphIntent['default_target'] {
    const graphGroupIds = new Set(graphGroups.map((group) => group.id));
    const activeGroups = groups.filter((group) => group.status === 'active' && graphGroupIds.has(group.id));
    const defaultGroup =
      activeGroups.find((group) => group.isDefault) ??
      activeGroups.find((group) => group.code === 'default') ??
      activeGroups[0];
    if (defaultGroup) {
      return { target_type: 'GROUP', target_id: defaultGroup.id };
    }
    const targetProductChannel =
      productChannels.find((pc) => this.productChannelGraphStatus(pc) === 'active')
      ?? productChannels.find((pc) => this.productChannelGraphStatus(pc) === 'testing')
      ?? productChannels[0];
    return {
      target_type: 'PRODUCT_CHANNEL',
      target_id: this.productChannelProviderId(targetProductChannel.id),
    };
  }

  private productChannelProviderId(productChannelId: string): string {
    return `pc_${productChannelId}`;
  }

  private productChannelEndpointStatus(productChannel: RuntimeProductChannelRow): 'active' | 'disabled' {
    if (!productChannel.channel.isActive || productChannel.channel.status !== 'active') return 'disabled';
    return productChannel.status === 'disabled' ? 'disabled' : 'active';
  }

  private productChannelCredentialStatus(productChannel: RuntimeProductChannelRow): 'enabled' | 'disabled' {
    if (!productChannel.channel.isActive || productChannel.channel.status !== 'active') return 'disabled';
    return productChannel.status === 'disabled' ? 'disabled' : 'enabled';
  }

  private productChannelGraphStatus(productChannel: RuntimeProductChannelRow): 'active' | 'disabled' | 'testing' {
    if (!productChannel.channel.isActive || productChannel.channel.status !== 'active') return 'disabled';
    return this.productChannelRuntimeStatus(productChannel.status);
  }

  private productChannelRoutePriority(productChannel: RuntimeProductChannelRow, modelName: string): number {
    void modelName;
    return productChannel.priority;
  }

  private routeGroupStrategy(value: string): 'weighted_failover' | 'priority_failover' | 'round_robin' | 'cost_first' | 'latency_first' {
    if (
      value === 'weighted_failover'
      || value === 'priority_failover'
      || value === 'round_robin'
      || value === 'cost_first'
      || value === 'latency_first'
    ) {
      return value;
    }
    throw new Error(`Invalid product channel group strategy: ${value}`);
  }

  private routeSubjectType(value: string): 'USER' | 'USER_SEGMENT' {
    if (value === 'USER' || value === 'USER_SEGMENT') return value;
    throw new Error(`Invalid route assignment subjectType: ${value}`);
  }

  private uniqueSorted(values: string[]): string[] {
    return Array.from(new Set(values.filter(Boolean))).sort((a, b) => a.localeCompare(b));
  }

  private groupBy<T>(items: T[], keyOf: (item: T) => string): Map<string, T[]> {
    const out = new Map<string, T[]>();
    for (const item of items) {
      const key = keyOf(item);
      const values = out.get(key) ?? [];
      values.push(item);
      out.set(key, values);
    }
    return out;
  }

  private assertRuntimeIntentReferences(intent: PublisherRuntimeIntent): void {
    const errors: string[] = [];
    const providerEndpoints = intent.provider_endpoints ?? [];
    const providerCredentials = intent.provider_credentials ?? [];
    const clientExposures = intent.client_exposures ?? [];
    const modelRoutes = intent.model_routes ?? [];
    const productPolicies = intent.product_policies ?? [];
    const productPolicyDeletes = intent.product_policy_deletes ?? [];
    const endpointIds = new Set(providerEndpoints.map((endpoint) => endpoint.id));
    const seenEndpointIds = new Set<string>();
    const productPolicyIds = new Set(productPolicies.map((policy) => policy.product_id));
    const checkProvider = (providerId: string, path: string, requireProductChannel = false) => {
      if (requireProductChannel && !providerId.startsWith('pc_')) {
        errors.push(`${path} provider_id must use pc_ prefix: ${providerId}`);
      }
      if (!endpointIds.has(providerId)) errors.push(`${path} provider_id not found in provider_endpoints: ${providerId}`);
    };

    for (const endpoint of providerEndpoints) {
      if (seenEndpointIds.has(endpoint.id)) errors.push(`provider_endpoints id duplicated: ${endpoint.id}`);
      seenEndpointIds.add(endpoint.id);
    }
    providerCredentials.forEach((credential, index) => {
      checkProvider(credential.provider_id, `provider_credentials[${index}]`);
    });
    clientExposures.forEach((exposure, index) => {
      checkProvider(exposure.provider_id, `client_exposures[${index}]`);
    });
    modelRoutes.forEach((route, routeIndex) => {
      route.routes.forEach((entry, entryIndex) => {
        checkProvider(entry.provider_id, `model_routes[${routeIndex}].routes[${entryIndex}]`);
      });
    });
    productPolicies.forEach((policy, policyIndex) => {
      (policy.allowed_provider_ids ?? []).forEach((providerId, providerIndex) => {
        checkProvider(providerId, `product_policies[${policyIndex}].allowed_provider_ids[${providerIndex}]`, true);
      });
      const routeGraph = policy.route_graph;
      if (!routeGraph) {
        if (policy.route_graph_required) {
          errors.push(`product_policies[${policyIndex}].route_graph required`);
        }
        return;
      }
      if (routeGraph.schema_version !== 1) {
        errors.push(`product_policies[${policyIndex}].route_graph.schema_version must be 1`);
      }
      const routeGraphGroupIds = new Set(routeGraph.groups.map((group) => group.id));
      const routeGraphProductChannelIds = new Set(routeGraph.product_channels.map((pc) => pc.id));
      const checkRouteTarget = (targetType: string, targetId: string, path: string) => {
        if (targetType === 'GROUP') {
          if (!routeGraphGroupIds.has(targetId)) errors.push(`${path} unknown GROUP target: ${targetId}`);
          return;
        }
        if (targetType === 'PRODUCT_CHANNEL') {
          if (!routeGraphProductChannelIds.has(targetId)) errors.push(`${path} unknown PRODUCT_CHANNEL target: ${targetId}`);
          return;
        }
        errors.push(`${path} invalid target_type=${targetType}`);
      };
      checkRouteTarget(
        routeGraph.default_target.target_type,
        routeGraph.default_target.target_id,
        `product_policies[${policyIndex}].route_graph.default_target`,
      );
      routeGraph.product_channels.forEach((pc, pcIndex) => {
        if (!pc.id.startsWith('pc_')) errors.push(`product_policies[${policyIndex}].route_graph.product_channels[${pcIndex}] id must use pc_ prefix: ${pc.id}`);
        checkProvider(pc.provider_id, `product_policies[${policyIndex}].route_graph.product_channels[${pcIndex}].provider_id`, true);
        if (pc.provider_id !== pc.id) {
          errors.push(`product_policies[${policyIndex}].route_graph.product_channels[${pcIndex}].provider_id must match id`);
        }
        if (!Array.isArray(pc.allowed_models)) errors.push(`product_policies[${policyIndex}].route_graph.product_channels[${pcIndex}].allowed_models required`);
        if (!Array.isArray(pc.denied_models)) errors.push(`product_policies[${policyIndex}].route_graph.product_channels[${pcIndex}].denied_models required`);
      });
      routeGraph.groups.forEach((group, groupIndex) => {
        group.members.forEach((member, memberIndex) => {
          const path = `product_policies[${policyIndex}].route_graph.groups[${groupIndex}].members[${memberIndex}]`;
          checkProvider(member.provider_id, `${path}.provider_id`, true);
          if (!routeGraphProductChannelIds.has(member.product_channel_id)) {
            errors.push(`${path}.product_channel_id unknown: ${member.product_channel_id}`);
          }
          const productChannel = routeGraph.product_channels.find((pc) => pc.id === member.product_channel_id);
          if (productChannel && productChannel.provider_id !== member.provider_id) {
            errors.push(`${path}.provider_id must match product_channel.provider_id`);
          }
        });
      });
      routeGraph.assignments.forEach((assignment, assignmentIndex) => {
        if (assignment.mode !== 'ONLY' && assignment.mode !== 'PREFER') {
          errors.push(`product_policies[${policyIndex}].route_graph.assignments[${assignmentIndex}] invalid mode=${assignment.mode}`);
        }
        if (assignment.client_compatibility) {
          try {
            normalizeClientCompatibilityValue(assignment.client_compatibility);
          } catch (err) {
            errors.push(`product_policies[${policyIndex}].route_graph.assignments[${assignmentIndex}].client_compatibility ${(err as Error).message}`);
          }
        }
        checkRouteTarget(
          assignment.target_type,
          assignment.target_id,
          `product_policies[${policyIndex}].route_graph.assignments[${assignmentIndex}]`,
        );
      });
    });
    productPolicyDeletes.forEach((deleted, index) => {
      if (productPolicyIds.has(deleted.product_id)) {
        errors.push(`product_policy_deletes[${index}].product_id also appears in product_policies: ${deleted.product_id}`);
      }
    });

    if (errors.length > 0) {
      throw new Error(`Invalid RuntimeIntent references: ${errors.join('; ')}`);
    }
  }

  private assertRuntimeIntentContract(intent: PublisherRuntimeIntent): void {
    this.assertRuntimeIntentPolicyRevisions(intent);
    if (validateRuntimeIntent(intent)) return;
    const details = (validateRuntimeIntent.errors ?? [])
      .map((error) => `${error.instancePath || '/'} ${error.message ?? error.keyword}`)
      .join('; ');
    throw new Error(`Invalid RuntimeIntent contract: ${details || 'unknown validation error'}`);
  }

  private assertRuntimeIntentPolicyRevisions(intent: PublisherRuntimeIntent): void {
    const errors: string[] = [];
    const seenDeletes = new Set<string>();

    for (const [index, policy] of (intent.product_policies ?? []).entries()) {
      const revision = policy.revision;
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision <= 0) {
        errors.push(`product_policies[${index}].revision must be a positive safe integer`);
      }
    }
    for (const [index, deleted] of (intent.product_policy_deletes ?? []).entries()) {
      const productId = String(deleted.product_id ?? '').trim();
      const revision = deleted.revision;
      if (!productId) errors.push(`product_policy_deletes[${index}].product_id is required`);
      if (typeof revision !== 'number' || !Number.isSafeInteger(revision) || revision <= 0) {
        errors.push(`product_policy_deletes[${index}].revision must be a positive safe integer`);
      }
      if (seenDeletes.has(productId)) {
        errors.push(`product_policy_deletes[${index}].product_id duplicated: ${productId}`);
      }
      seenDeletes.add(productId);
    }

    if (errors.length > 0) {
      throw new Error(`Invalid RuntimeIntent contract: ${errors.join('; ')}`);
    }
  }

  private routeMemberRole(value: string): 'primary' | 'fallback' | 'shadow' {
    if (value === 'fallback' || value === 'shadow') return value;
    return 'primary';
  }

  private productChannelRuntimeStatus(value: string): 'active' | 'disabled' | 'testing' {
    if (value === 'active' || value === 'testing') return value;
    return 'disabled';
  }

  private routeTargetType(value: string): 'GROUP' | 'PRODUCT_CHANNEL' {
    return value === 'PRODUCT_CHANNEL' ? 'PRODUCT_CHANNEL' : 'GROUP';
  }

  private routeAssignmentMode(value: string): 'ONLY' | 'PREFER' {
    if (value === 'ONLY' || value === 'PREFER') return value;
    throw new Error(`Invalid route assignment mode: ${value}`);
  }

  private buildProvider(
    providerId: string,
    channels: Channel[],
  ): PublisherProvider {
    const first = channels.find((ch) => ch.isActive && ch.status === 'active') ?? channels[0];
    const hasActive = channels.some((ch) => ch.isActive && ch.status === 'active');
    const providerCode = this.providerId(first.provider);
    const apiTypes = this.providerApiTypesForChannels(providerCode, channels);
    const { baseUrl, pathPrefix } = this.providerUrlParts(first.baseUrl, apiTypes[0]);
    const intent = this.providerRuntimeIntentFor(providerId, channels, apiTypes);
    if (intent) {
      return {
        id: providerId,
        code: providerCode,
        name: first.name || providerId,
        base_url: baseUrl,
        provider_profile: intent.providerProfile,
        ...(first.ownedBy?.trim() ? { owned_by: first.ownedBy.trim() } : {}),
        client_compatibility: intent.clientCompatibility,
        ...(intent.tokenCountStrategy ? { token_count_strategy: intent.tokenCountStrategy } : {}),
        ...(pathPrefix ? { path_prefix: pathPrefix } : {}),
        status: hasActive ? 'active' : 'disabled',
        key_strategy: 'weight',
      };
    }

    return {
      id: providerId,
      code: providerCode,
      name: first.name || providerId,
      base_url: baseUrl,
      ...(pathPrefix ? { path_prefix: pathPrefix } : {}),
      status: hasActive ? 'active' : 'disabled',
      key_strategy: 'weight',
    };
  }

  private routeCapabilitiesFor(channel: Pick<Channel, 'provider' | 'sdkType'>): PublisherCapability[] {
    if (isSeedanceVideoSdkType(channel.sdkType)) return ['video_generation'];
    const providerCode = this.providerId(channel.provider);
    return this.apiTypesFor(providerCode, channel.sdkType).length > 0 ? ['chat'] : [];
  }

  private publisherIntentCapabilities(values: Iterable<string>): PublisherCapability[] {
    return Array.from(new Set(Array.from(values)
      .map((value) => this.normalizeCapabilityName(value))
      .filter((value): value is PublisherCapability => PUBLISHER_CAPABILITY_SET.has(value))))
      .sort();
  }

  private normalizeCapabilityName(value: string): string {
    const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (normalized === 'function_call' || normalized === 'function_calling' || normalized === 'function_tools') {
      return 'tools';
    }
    if (normalized === 'streaming') return 'stream';
    if (normalized === 'embedding') return 'embeddings';
    return normalized;
  }

  private upstreamModelFor(channel: Channel, modelName: string): string {
    if (isSeedanceVideoSdkType(channel.sdkType)) {
      return seedanceUpstreamModelFor(channel.baseUrl, modelName);
    }
    const configs = this.parseJsonObject(channel.modelConfigs);
    const config = configs?.[modelName];
    if (config && typeof config === 'object') {
      const upstream = (config as Record<string, unknown>).upstreamModelId
        ?? (config as Record<string, unknown>).upstreamModel
        ?? (config as Record<string, unknown>).upstream_model
        ?? (config as Record<string, unknown>).model;
      if (typeof upstream === 'string' && upstream.trim()) {
        return upstream.trim();
      }
    }
    return modelName;
  }

  private routePriorityFor(channel: Channel, modelName: string): number {
    return this.modelConfigFor(channel, modelName).routingPriority ?? channel.priority;
  }

  private modelConfigFor(channel: Channel, modelName: string): Record<string, unknown> & {
    enabled?: boolean;
    routingPriority?: number;
  } {
    const configs = this.parseJsonObject(channel.modelConfigs);
    const raw = configs?.[modelName];
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return {};
    const config = raw as Record<string, unknown>;
    const priorityValue = config.routingPriority ?? config.routing_priority ?? config.priority;
    const priority = Number(priorityValue);
    const {
      protocolStrategyOverride: _protocolStrategyOverride,
      protocolStrategyOverrideReason: _protocolStrategyOverrideReason,
      protocolStrategyOverrideOwner: _protocolStrategyOverrideOwner,
      protocolStrategyOverrideExpiresAt: _protocolStrategyOverrideExpiresAt,
      capabilityOverrides: _capabilityOverrides,
      capability_overrides: _capability_overrides,
      ...baseConfig
    } = config;
    return {
      ...baseConfig,
      ...(Number.isInteger(priority) && priority >= 1 && priority <= 100
        ? { routingPriority: priority }
        : {}),
    };
  }

  private providerId(provider: string): string {
    return providerIdFromCode(provider);
  }

  private providerIdForChannel(
    channel: Pick<Channel, 'provider'> & Partial<Pick<Channel, 'baseUrl' | 'sdkType'>> & ChannelRuntimeIntentFields,
  ): string {
    const code = this.providerId(channel.provider);
    if (!channel.baseUrl && !channel.sdkType && !channel.providerProfile) return code;

    const apiTypes = this.apiTypesFor(code, channel.sdkType);
    if (apiTypes.length === 0) return code;
    const profile = normalizeProviderProfileValue(channel.providerProfile)
      ?? inferProviderProfile(code, apiTypes)
      ?? apiTypes.join('_');
    const { baseUrl, pathPrefix } = this.providerUrlParts(channel.baseUrl, apiTypes[0]);
    const digest = createHash('sha256')
      .update(JSON.stringify({
        provider: code,
        profile,
        base_url: baseUrl,
        path_prefix: pathPrefix ?? '',
        api_types: apiTypes,
      }))
      .digest('hex')
      .slice(0, 8);
    return `${code}-${profile}-${digest}`;
  }

  private keyRateLimitPolicies(key: ApiKeyRow): PublisherEffectivePolicy[] {
    return [
      this.keyRateLimitPolicy(key.id, 'rpm', this.positiveInteger(key.rateLimitRpm)),
      this.keyRateLimitPolicy(key.id, 'tpm', this.positiveInteger(key.rateLimitTpm)),
    ].filter((policy): policy is PublisherEffectivePolicy => policy !== null);
  }

  private keyRateLimitPolicy(
    keyId: string,
    metric: 'rpm' | 'tpm',
    limitValue: number | undefined,
  ): PublisherEffectivePolicy | null {
    if (!limitValue) return null;
    return {
      version: 2,
      policy_id: `${metric}-key-${keyId}`,
      policy_type: 'rate_limit',
      control_semantic: 'window_reject',
      subject_side: 'user',
      metric,
      scope: 'key',
      scope_id: keyId,
      window: '60s',
      limit_value: limitValue,
      runtime_keys: {
        family: 'rl',
        count_suffix: `key:{scope_id}:${metric}:{window}:{window_id}`,
      },
    };
  }

  private keyGuardrails(key: ApiKeyRow): PublisherGuardrailPolicy | undefined {
    const guardrails: PublisherGuardrailPolicy = {};
    const maxMessages = this.positiveInteger(key.maxMessages);
    if (maxMessages) guardrails.max_messages = maxMessages;
    if (key.allowTools === false) guardrails.allow_tools = false;
    if (key.allowVision === false) guardrails.allow_vision = false;
    return Object.keys(guardrails).length > 0 ? guardrails : undefined;
  }

  private providerApiTypesForChannels(providerId: string, channels: Channel[]): PublisherApiType[] {
    return providerApiTypesForChannels(providerId, channels);
  }

  private providerRuntimeIntentFor(
    providerId: string,
    channels: Channel[],
    apiTypes: PublisherApiType[],
  ): ProviderRuntimeIntent | null {
    return resolveProviderRuntimeIntent(providerId, channels, apiTypes);
  }

  private isGatewayRoutableChannel(channel: Pick<Channel, 'provider' | 'sdkType'>): boolean {
    return isGatewayRoutableChannel(channel, this.providerId(channel.provider));
  }

  private providerUrlParts(
    rawBaseUrl: string | null | undefined,
    apiType: PublisherApiType | undefined,
  ): { baseUrl: string; pathPrefix?: string } {
    return providerUrlParts(rawBaseUrl, apiType);
  }

  private apiTypesFor(providerId: string, sdkType: string | null | undefined): PublisherApiType[] {
    return apiTypesForProviderSdk(providerId, sdkType);
  }

  private stringValue(value: unknown): string | undefined {
    return typeof value === 'string' && value.trim() ? value.trim() : undefined;
  }

  private objectValue(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private stringArrayValue(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return value
      .filter((item): item is string => typeof item === 'string')
      .map((item) => item.trim())
      .filter(Boolean);
  }

  private productCredentialSource(value: string): PublisherProductCredentialSource {
    return this.requiredRuntimePolicyEnum(
      value,
      ['keypool', 'dedicated_upstream'],
      'credentialSource',
    );
  }

  private productModelScopeMode(value: string): PublisherProductModelScopeMode {
    return this.requiredRuntimePolicyEnum(
      value,
      ['plan_configured', 'product_allowlist', 'upstream_inherited'],
      'modelScopeMode',
    );
  }

  private productFallbackPolicy(value: string): PublisherProductFallbackPolicy {
    return this.requiredRuntimePolicyEnum(
      value,
      ['none', 'within_product', 'within_provider', 'platform_default'],
      'fallbackPolicy',
    );
  }

  private productRuntimeBillingMode(value: string): PublisherProductRuntimeBillingMode {
    return this.requiredRuntimePolicyEnum(
      value,
      ['payg_balance', 'subscription_credits', 'token_plan_quota', 'included_upstream'],
      'runtimeBillingMode',
    );
  }

  private effectiveAllowHighLossBridgeWhenNoNative(
    policy: Pick<ProductRuntimePolicy, 'allowHighLossBridgeWhenNoNative' | 'highLossBridgeExpiresAt'>,
  ): boolean {
    return policy.allowHighLossBridgeWhenNoNative === true &&
      policy.highLossBridgeExpiresAt !== null &&
      policy.highLossBridgeExpiresAt.getTime() > Date.now();
  }

  private productRouteStrategy(value: string | null): PublisherProductRouteStrategy | undefined {
    return this.optionalRuntimePolicyEnum(
      value,
      ['priority', 'weight', 'latency', 'least_busy'],
      'routeStrategy',
      undefined,
    );
  }

  private requiredRuntimePolicyEnum<const T extends readonly string[]>(
    value: string | null | undefined,
    allowed: T,
    field: string,
  ): T[number] {
    const normalized = this.stringValue(value);
    if (normalized && allowed.includes(normalized)) return normalized as T[number];
    throw new BadRequestException(`ProductRuntimePolicy.${field} 非法: ${value ?? '<empty>'}`);
  }

  private optionalRuntimePolicyEnum<const T extends readonly string[]>(
    value: string | null | undefined,
    allowed: T,
    field: string,
    fallback: T[number] | undefined,
  ): T[number] | undefined {
    const normalized = this.stringValue(value);
    if (!normalized) return fallback;
    if (allowed.includes(normalized)) return normalized as T[number];
    throw new BadRequestException(`ProductRuntimePolicy.${field} 非法: ${value}`);
  }

  private parseStringArray(raw: string | null | undefined): string[] {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return Array.isArray(parsed)
        ? parsed.filter((item): item is string => typeof item === 'string' && item.length > 0)
        : [];
    } catch {
      return [];
    }
  }

  private parseJsonObject(raw: string | null | undefined): Record<string, unknown> | null {
    if (!raw) return null;
    try {
      const parsed = JSON.parse(raw);
      return parsed && typeof parsed === 'object' && !Array.isArray(parsed)
        ? parsed as Record<string, unknown>
        : null;
    } catch {
      return null;
    }
  }

  private configNumber(key: string): number | undefined {
    const raw = this.config.get<string | number>(key);
    if (raw === undefined || raw === null || raw === '') return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return undefined;
    return Math.trunc(value);
  }

  private configPositiveInteger(key: string): number | undefined {
    return this.positiveInteger(this.configNumber(key));
  }

  private configPositiveSafeInteger(key: string): number | undefined {
    const raw = this.config.get<string | number>(key);
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      return undefined;
    }
    const value = Number(raw);
    return Number.isSafeInteger(value) && value > 0 ? value : undefined;
  }

  private configNonNegativeDecimal(key: string): Prisma.Decimal | undefined {
    const raw = this.config.get<string | number>(key);
    if (raw === undefined || raw === null || String(raw).trim() === '') {
      return undefined;
    }
    try {
      const value = new Prisma.Decimal(String(raw).trim());
      if (!value.isFinite() || value.lt(0) || value.decimalPlaces() > 12) {
        return undefined;
      }
      return value;
    } catch {
      return undefined;
    }
  }

  private positiveInteger(value: unknown): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const numeric = Number(value);
    if (!Number.isFinite(numeric) || numeric <= 0) return undefined;
    return Math.trunc(numeric);
  }

  private numberSetting(settings: Record<string, unknown>, key: string): number | undefined {
    const raw = settings[key];
    if (raw === undefined || raw === null || raw === '') return undefined;
    const value = Number(raw);
    if (!Number.isFinite(value) || value < 0) return undefined;
    return Math.trunc(value);
  }

  private hasConfigValue(key: string): boolean {
    const raw = this.config.get<string | number>(key);
    return raw !== undefined && raw !== null && String(raw).trim() !== '';
  }

  private configString(key: string): string | undefined {
    const raw = this.config.get<string>(key);
    const value = raw?.trim();
    return value || undefined;
  }

  private firstConfig(...keys: string[]): string | undefined {
    for (const key of keys) {
      const value = this.configString(key);
      if (value) return value;
    }
    return undefined;
  }

  private configStringList(key: string): string[] | undefined {
    const raw = this.configString(key);
    if (!raw) return undefined;
    return raw.split(',').map((item) => item.trim()).filter(Boolean);
  }

  private configBoolean(key: string): boolean | undefined {
    const raw = this.config.get<string | boolean>(key);
    if (typeof raw === 'boolean') return raw;
    const value = raw?.trim().toLowerCase();
    if (!value) return undefined;
    if (['true', '1', 'yes', 'on'].includes(value)) return true;
    if (['false', '0', 'no', 'off'].includes(value)) return false;
    return undefined;
  }

  private toPublisherCiphertext(storedApiKey: string): string | null {
    if (!storedApiKey) return null;
    const trimmed = storedApiKey.trim();
    if (isGatewayLocalSecret(trimmed)) {
      return this.normalizeGatewayLocalCiphertext(trimmed);
    }
    if (trimmed.startsWith('enc:')) {
      return trimmed;
    }
    if (isLegacyAesGcmSecret(trimmed)) {
      return this.encryptLegacyLocalKeyForGateway(trimmed);
    }
    const allowPlaintext = this.config.get<string>('PUBLISHER_ALLOW_PLAINTEXT_UPSTREAM_KEYS') === 'true';
    if (allowPlaintext && !this.isProduction()) {
      return trimmed;
    }
    if (allowPlaintext) {
      this.logger.warn('ignore PUBLISHER_ALLOW_PLAINTEXT_UPSTREAM_KEYS in production');
    }
    this.logger.warn('skip Publisher credential because stored upstream key is not encrypted');
    return null;
  }

  private encryptLegacyLocalKeyForGateway(storedApiKey: string): string | null {
    const encryptionKey = this.legacyEncryptionKey();
    if (!encryptionKey) {
      this.logger.warn('skip legacy Publisher credential because ENCRYPTION_KEY is missing');
      return null;
    }
    const gatewaySecret = this.gatewayLocalSecret();
    if (!gatewaySecret) {
      this.logger.warn('skip legacy Publisher credential because KMS_HMAC_SECRET is missing');
      return null;
    }
    try {
      const plaintext = decrypt(storedApiKey, encryptionKey);
      return encryptGatewayLocalSecret(plaintext, gatewaySecret);
    } catch (err) {
      this.logger.warn(`skip legacy Publisher credential because re-encryption failed: ${(err as Error).message}`);
      return null;
    }
  }

  private normalizeGatewayLocalCiphertext(storedApiKey: string): string {
    const gatewaySecret = this.gatewayLocalSecret();
    if (!gatewaySecret) return storedApiKey;
    try {
      decryptGatewayLocalSecret(storedApiKey, gatewaySecret);
      return storedApiKey;
    } catch (currentErr) {
      const encryptionKey = this.legacyEncryptionKey();
      if (!encryptionKey || encryptionKey === gatewaySecret) {
        throw new ServiceUnavailableException(
          `gateway local ciphertext cannot be decrypted with KMS_HMAC_SECRET: ${(currentErr as Error).message}`,
        );
      }
      try {
        const plaintext = decryptGatewayLocalSecret(storedApiKey, encryptionKey);
        return encryptGatewayLocalSecret(plaintext, gatewaySecret);
      } catch (legacyErr) {
        throw new ServiceUnavailableException(
          `gateway local ciphertext cannot be normalized from legacy secret: ${(legacyErr as Error).message}`,
        );
      }
    }
  }

  private gatewayLocalSecret(): string {
    return resolveGatewayLocalSecret(this.config);
  }

  private legacyEncryptionKey(): string {
    return this.config.get<string>('ENCRYPTION_KEY')?.trim() ?? '';
  }

  private isProduction(): boolean {
    return (
      this.config.get<string>('NODE_ENV') === 'production'
      || this.config.get<string>('APP_ENV') === 'production'
      || process.env.NODE_ENV === 'production'
      || process.env.APP_ENV === 'production'
    );
  }

  balanceSnapshotForLog(balance: Prisma.Decimal, spent: Prisma.Decimal | number | string): {
    balanceUsd: number;
    spentUsd: number;
  } {
    return {
      balanceUsd: usdNumber(balance),
      spentUsd: usdNumber(spent),
    };
  }
}
