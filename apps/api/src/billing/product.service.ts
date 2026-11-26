import { BadRequestException, Injectable, Logger, NotFoundException, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Channel, CodingPlanFulfillmentMode, Prisma, ProductBillingMode } from '@prisma/client';
import {
  canonicalizePaymentCallbackOrigin,
  PAYMENT_CALLBACK_ORIGIN_MAX_COUNT,
} from '@ruidong/shared';
import { createHash, randomBytes } from 'crypto';
import { buildPartnerApiEndpoints } from '../common/openapi/partner-api-endpoints';
import { encrypt } from '../common/utils/crypto';
import { resolveEncryptionKey } from '../common/utils/encryption-key';
import {
  normalizeProductPaymentCallbackOrigins,
  resolvePaymentCallbackAllowedOrigins,
} from '../payment/payment-callback-url-policy';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherSyncService } from '../publisher/publisher-sync.service';
import type { PublisherSyncDispatchResult } from '../publisher/publisher-sync-job.service';

const CREDENTIAL_SOURCES = ['keypool', 'dedicated_upstream'] as const;
const MODEL_SCOPE_MODES = ['plan_configured', 'product_allowlist', 'upstream_inherited'] as const;
const FALLBACK_POLICIES = ['none', 'within_product', 'within_provider', 'platform_default'] as const;
const RUNTIME_BILLING_MODES = ['payg_balance', 'subscription_credits', 'token_plan_quota', 'included_upstream'] as const;
const RUNTIME_POLICY_STATUSES = ['active', 'disabled'] as const;
const ROUTE_STRATEGIES = ['priority', 'weight', 'latency', 'least_busy'] as const;
const CODING_PLAN_FULFILLMENT_MODES = [
  CodingPlanFulfillmentMode.platform_model_package,
  CodingPlanFulfillmentMode.provider_resale,
] as const;
type CredentialSource = typeof CREDENTIAL_SOURCES[number];
type ModelScopeMode = typeof MODEL_SCOPE_MODES[number];
type FallbackPolicy = typeof FALLBACK_POLICIES[number];
type RuntimeBillingMode = typeof RUNTIME_BILLING_MODES[number];
type RuntimePolicyStatus = typeof RUNTIME_POLICY_STATUSES[number];
type RouteStrategy = typeof ROUTE_STRATEGIES[number];

type RuntimePolicyFields = {
  credentialSource: CredentialSource;
  allowedProviderIds: string[];
  allowedChannelIds: string[];
  modelScopeMode: ModelScopeMode;
  allowedModels: string[];
  fallbackPolicy: FallbackPolicy;
  runtimeBillingMode: RuntimeBillingMode;
  routeStrategy: RouteStrategy | null;
  allowHighLossBridgeWhenNoNative: boolean;
  allowBridgeOnNativeFailure: boolean;
  highLossBridgeReason: string | null;
  highLossBridgeOwner: string | null;
  highLossBridgeExpiresAt: Date | null;
  highLossBridgeApproval: string | null;
  status: RuntimePolicyStatus;
};

type ProductPublisherSync =
  | {
      ok: true;
      status: 'ACCEPTED';
      idempotencyKey: string;
      warnings?: unknown[];
    }
  | {
      ok: false;
      status: 'PENDING' | 'FAILED' | 'DISABLED';
      idempotencyKey?: string;
      error: string;
    };

@Injectable()
export class ProductService {
  private readonly logger = new Logger(ProductService.name);

  constructor(
    private readonly prisma: PrismaService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly publisherSync?: PublisherSyncService,
  ) {}

  async findAll(onlyActive = false) {
    const rows = await this.prisma.product.findMany({
      where: {
        deletedAt: null,
        ...(onlyActive ? { isActive: true } : {}),
      },
      orderBy: { sortOrder: 'asc' },
    });
    return rows.map((row) => this.safeProduct(row));
  }

  async findById(id: string) {
    return this.safeProduct(await this.prisma.product.findFirst({ where: { id, deletedAt: null } }));
  }

  async findBySlug(slug: string) {
    return this.safeProduct(await this.prisma.product.findFirst({
      where: { slug: { equals: slug, mode: 'insensitive' }, deletedAt: null },
    }));
  }

  async resolveDefaultProduct(input: {
    billingMode: ProductBillingMode;
    productId?: string | null;
    productSlug?: string | null;
    codingPlanFulfillmentMode?: CodingPlanFulfillmentMode | string | null;
    fulfillmentMode?: CodingPlanFulfillmentMode | string | null;
  }) {
    const productId = input.productId?.trim();
    const productSlug = input.productSlug?.trim();
    const codingPlanFulfillmentMode = this.normalizeOptionalCodingPlanFulfillmentMode(
      input.billingMode,
      input.codingPlanFulfillmentMode ?? input.fulfillmentMode,
    );
    if (productId || productSlug) {
      const product = await this.prisma.product.findFirst({
        where: {
          ...(productId
            ? { id: productId }
            : { slug: { equals: productSlug, mode: 'insensitive' } }),
          billingMode: input.billingMode,
          ...(codingPlanFulfillmentMode ? { codingPlanFulfillmentMode } : {}),
          isActive: true,
          deletedAt: null,
        },
      });
      if (!product) {
        throw new BadRequestException(`${input.billingMode} 产品不存在、未启用，或计费模式不匹配`);
      }
      return this.safeProduct(product);
    }

    const products = await this.prisma.product.findMany({
      where: {
        billingMode: input.billingMode,
        ...(codingPlanFulfillmentMode ? { codingPlanFulfillmentMode } : {}),
        isActive: true,
        deletedAt: null,
      },
      orderBy: [{ sortOrder: 'asc' }, { createdAt: 'asc' }],
    });
    if (products.length === 1) return this.safeProduct(products[0]);
    if (products.length === 0) {
      throw new BadRequestException(`未找到启用的 ${input.billingMode} 产品`);
    }
    throw new BadRequestException(
      `存在多个启用的 ${input.billingMode} 产品，请显式指定 productId 或 productSlug`,
    );
  }

  async create(data: {
    name: string;
    slug: string;
    description?: string;
    icon?: string;
    webhookUrl?: string | null;
    allowedPaymentCallbackOrigins?: string[] | null;
    defaultPlanId?: string | null;
    billingMode?: ProductBillingMode;
    codingPlanFulfillmentMode?: CodingPlanFulfillmentMode | string | null;
    fulfillmentMode?: CodingPlanFulfillmentMode | string | null;
    isActive?: boolean;
    sortOrder?: number;
  }) {
    return this.safeProduct(await this.prisma.product.create({
      data: this.normalizeProductCreateData(data),
    }));
  }

  async update(
    id: string,
    data: {
      name?: string;
      description?: string;
      icon?: string;
      webhookUrl?: string | null;
      allowedPaymentCallbackOrigins?: string[] | null;
      defaultPlanId?: string | null;
      billingMode?: ProductBillingMode;
      codingPlanFulfillmentMode?: CodingPlanFulfillmentMode | string | null;
      fulfillmentMode?: CodingPlanFulfillmentMode | string | null;
      isActive?: boolean;
      sortOrder?: number;
    },
  ) {
    const product = await this.requireProduct(id);
    if (data.defaultPlanId !== undefined && data.defaultPlanId !== null) {
      await this.assertDefaultPlan(id, data.defaultPlanId);
    }
    return this.safeProduct(await this.prisma.product.update({
      where: { id },
      data: this.normalizeProductUpdateData(product.billingMode, product.codingPlanFulfillmentMode, data),
    }));
  }

  async getIntegrationStatus(id: string) {
    const product = await this.prisma.product.findFirst({ where: { id, deletedAt: null } });
    if (!product) throw new NotFoundException('产品不存在');

    const [configuredDefaultPlan, fallbackDefaultPlan, plansCount, activeVirtualKeys, totalVirtualKeys] =
      await Promise.all([
        product.defaultPlanId
          ? this.prisma.plan.findFirst({
              where: { id: product.defaultPlanId, productId: id, deletedAt: null },
              select: { id: true, name: true, isActive: true, monthlyPrice: true, monthlyCredits: true },
            })
          : Promise.resolve(null),
        this.prisma.plan.findFirst({
          where: {
            productId: id,
            deletedAt: null,
            isActive: true,
            OR: [{ id: 'free' }, { monthlyPrice: 0 }],
          },
          orderBy: [{ monthlyPrice: 'asc' }, { sortOrder: 'asc' }],
          select: { id: true, name: true, isActive: true, monthlyPrice: true, monthlyCredits: true },
        }),
        this.prisma.plan.count({ where: { productId: id, deletedAt: null } }),
        this.prisma.apiKey.count({
          where: {
            productId: id,
            name: `saas:${product.slug}:virtual`,
            isActive: true,
            mirrorStatus: 'ACTIVE',
            deletedAt: null,
          },
        }),
        this.prisma.apiKey.count({
          where: { productId: id, name: `saas:${product.slug}:virtual`, deletedAt: null },
        }),
      ]);

    const defaultPlan = configuredDefaultPlan ?? fallbackDefaultPlan;
    const requiresDefaultPlan = product.billingMode === 'SUBSCRIPTION';
    const paymentCallbacks = this.paymentCallbackStatus(product.id, product.allowedPaymentCallbackOrigins);
    return {
      product: this.safeProduct(product),
      endpoints: buildPartnerApiEndpoints(this.partnerApiPublicBaseUrl()),
      paymentCallbacks,
      credentials: {
        hasIntegrationToken: Boolean(product.integrationTokenHash),
        integrationTokenPrefix: product.integrationTokenPrefix,
        integrationTokenRotatedAt: product.integrationTokenRotatedAt?.toISOString() ?? null,
        hasWebhookSecret: Boolean(product.webhookSecretEncrypted),
        webhookSecretPrefix: product.webhookSecretPrefix,
        webhookSecretRotatedAt: product.webhookSecretRotatedAt?.toISOString() ?? null,
      },
      defaultPlan,
      requirements: {
        requiresDefaultPlan,
        requiresWebhookUrl: product.billingMode === 'SUBSCRIPTION',
        apiKeyDefaultBinding: product.billingMode === 'PAY_AS_YOU_GO',
      },
      virtualKey: {
        name: `saas:${product.slug}:virtual`,
        activeCount: activeVirtualKeys,
        totalCount: totalVirtualKeys,
      },
      checklist: {
        hasPlans: plansCount > 0,
        hasDefaultPlan: requiresDefaultPlan ? Boolean(defaultPlan) : true,
        hasWebhookUrl: Boolean(product.webhookUrl),
        hasIntegrationToken: Boolean(product.integrationTokenHash),
        hasWebhookSecret: Boolean(product.webhookSecretEncrypted),
        hasActiveVirtualKey: activeVirtualKeys > 0,
        hasApiKeyDefaultBinding: product.billingMode !== 'PAY_AS_YOU_GO' || product.isActive,
        hasPaymentCallbackOrigins: paymentCallbacks.mode === 'PRODUCT_ALLOWLIST',
      },
    };
  }

  async getRuntimePolicy(id: string) {
    const product = await this.prisma.product.findFirst({
      where: { id, deletedAt: null },
      include: { runtimePolicy: true },
    });
    if (!product) throw new NotFoundException('产品不存在');

    const { runtimePolicy, ...productOnly } = product;
    return {
      product: this.safeProduct(productOnly),
      explicit: Boolean(runtimePolicy),
      policy: this.serializeRuntimePolicy(id, product.billingMode, runtimePolicy),
      channels: await this.runtimePolicyChannels(),
      options: {
        credentialSources: CREDENTIAL_SOURCES,
        modelScopeModes: MODEL_SCOPE_MODES,
        fallbackPolicies: FALLBACK_POLICIES,
        runtimeBillingModes: RUNTIME_BILLING_MODES,
        routeStrategies: ROUTE_STRATEGIES,
        statuses: RUNTIME_POLICY_STATUSES,
      },
    };
  }

  async updateRuntimePolicy(
    id: string,
    data: Record<string, unknown>,
  ) {
    const product = await this.requireProduct(id);
    const normalized = await this.normalizeRuntimePolicy(product.billingMode, data);
    const saved = await this.prisma.productRuntimePolicy.upsert({
      where: { productId: id },
      create: {
        productId: id,
        ...this.runtimePolicyWriteData(normalized),
      },
      update: {
        ...this.runtimePolicyWriteData(normalized),
        revision: { increment: 1 },
      },
    });

    const publisherSync = await this.syncRuntimePolicyToPublisher(id);

    return {
      product: this.safeProduct(product),
      explicit: true,
      policy: this.serializeRuntimePolicy(id, product.billingMode, saved),
      channels: await this.runtimePolicyChannels(),
      publisherSync,
    };
  }

  async rotateIntegrationToken(id: string) {
    const product = await this.requireProduct(id);
    const token = this.generateSecret(`rpi_${product.slug}`);
    const rotatedAt = new Date();
    await this.prisma.product.update({
      where: { id },
      data: {
        integrationTokenHash: this.hashSecret(token),
        integrationTokenPrefix: token.slice(0, 18),
        integrationTokenRotatedAt: rotatedAt,
      },
    });
    return {
      token,
      prefix: token.slice(0, 18),
      rotatedAt: rotatedAt.toISOString(),
    };
  }

  async rotateWebhookSecret(id: string) {
    const product = await this.requireProduct(id);
    const encryptionKey = this.resolveEncryptionKeyOrThrow();
    const secret = this.generateSecret(`rwh_${product.slug}`);
    const rotatedAt = new Date();
    await this.prisma.product.update({
      where: { id },
      data: {
        webhookSecretEncrypted: encrypt(secret, encryptionKey),
        webhookSecretPrefix: secret.slice(0, 18),
        webhookSecretRotatedAt: rotatedAt,
      },
    });
    return {
      secret,
      prefix: secret.slice(0, 18),
      rotatedAt: rotatedAt.toISOString(),
    };
  }

  async delete(id: string) {
    const product = await this.prisma.product.findFirst({ where: { id, deletedAt: null } });
    if (!product) throw new NotFoundException('产品不存在');

    const deletedAt = new Date();
    const deleted = await this.prisma.product.update({
      where: { id },
      data: {
        slug: this.tombstoneSlug(product.slug, deletedAt),
        isActive: false,
        deletedAt,
        defaultPlanId: null,
        integrationTokenHash: null,
        integrationTokenPrefix: null,
        webhookSecretEncrypted: null,
        webhookSecretPrefix: null,
      },
    });
    await this.prisma.productRuntimePolicy.updateMany({
      where: { productId: id },
      data: { revision: { increment: 1 } },
    });
    const publisherSync = await this.syncRuntimePolicyToPublisher(id);
    return {
      ...this.safeProduct(deleted),
      publisherSync,
    };
  }

  private async syncRuntimePolicyToPublisher(productId: string): Promise<ProductPublisherSync | null> {
    if (!this.publisherSync) return null;
    try {
      return this.publisherSyncResult(
        await this.publisherSync.syncRuntimeIntentAfterProductPolicyChangeDetailed(productId),
      );
    } catch (err) {
      const message = (err as Error).message;
      this.logger.error(`product runtime policy saved but publisher sync state could not be recorded product=${productId}: ${message}`);
      return { ok: false, status: 'FAILED', error: message };
    }
  }

  private publisherSyncResult(result: PublisherSyncDispatchResult): ProductPublisherSync {
    if (result.accepted) {
      return {
        ok: true,
        status: 'ACCEPTED',
        idempotencyKey: result.idempotencyKey,
        ...(result.response?.warnings?.length ? { warnings: result.response.warnings } : {}),
      };
    }
    return {
      ok: false,
      status: result.status === 'ACCEPTED' ? 'FAILED' : result.status,
      idempotencyKey: result.idempotencyKey,
      error: result.error ?? 'Publisher 同步未被接收',
    };
  }

  private async requireProduct(id: string) {
    const product = await this.prisma.product.findFirst({ where: { id, deletedAt: null } });
    if (!product) throw new NotFoundException('产品不存在');
    return product;
  }

  private async assertDefaultPlan(productId: string, planId: string): Promise<void> {
    const plan = await this.prisma.plan.findFirst({
      where: { id: planId, productId, deletedAt: null },
      select: { id: true },
    });
    if (!plan) {
      throw new BadRequestException('默认套餐不存在，或不属于该产品');
    }
  }

  private normalizeOptionalCodingPlanFulfillmentMode(
    billingMode: ProductBillingMode,
    value?: CodingPlanFulfillmentMode | string | null,
  ): CodingPlanFulfillmentMode | null {
    if (billingMode !== ProductBillingMode.CODING_PLAN || value === undefined || value === null || value === '') {
      return null;
    }
    if ((CODING_PLAN_FULFILLMENT_MODES as readonly string[]).includes(value)) {
      return value as CodingPlanFulfillmentMode;
    }
    throw new BadRequestException('codingPlanFulfillmentMode 必须是 platform_model_package / provider_resale 之一');
  }

  private normalizeProductCodingPlanFulfillmentMode(
    billingMode: ProductBillingMode,
    value?: CodingPlanFulfillmentMode | string | null,
    fallback?: CodingPlanFulfillmentMode | null,
  ): CodingPlanFulfillmentMode | null {
    if (billingMode !== ProductBillingMode.CODING_PLAN) return null;
    return this.normalizeOptionalCodingPlanFulfillmentMode(
      billingMode,
      value ?? fallback ?? CodingPlanFulfillmentMode.platform_model_package,
    );
  }

  private normalizeProductCreateData(data: {
    name: string;
    slug: string;
    description?: string;
    icon?: string;
    webhookUrl?: string | null;
    allowedPaymentCallbackOrigins?: string[] | null;
    defaultPlanId?: string | null;
    billingMode?: ProductBillingMode;
    codingPlanFulfillmentMode?: CodingPlanFulfillmentMode | string | null;
    fulfillmentMode?: CodingPlanFulfillmentMode | string | null;
    isActive?: boolean;
    sortOrder?: number;
  }): Prisma.ProductCreateInput {
    const {
      codingPlanFulfillmentMode,
      fulfillmentMode,
      billingMode,
      allowedPaymentCallbackOrigins,
      ...rest
    } = data;
    const nextBillingMode = billingMode ?? ProductBillingMode.SUBSCRIPTION;
    const normalizedFulfillmentMode = this.normalizeProductCodingPlanFulfillmentMode(
      nextBillingMode,
      codingPlanFulfillmentMode ?? fulfillmentMode,
    );
    return {
      ...rest,
      allowedPaymentCallbackOrigins: this.paymentCallbackOriginsWriteValue(
        allowedPaymentCallbackOrigins === undefined ? [] : allowedPaymentCallbackOrigins,
      ),
      ...(billingMode !== undefined ? { billingMode } : {}),
      ...(normalizedFulfillmentMode ? { codingPlanFulfillmentMode: normalizedFulfillmentMode } : {}),
    };
  }

  private normalizeProductUpdateData(
    currentBillingMode: ProductBillingMode,
    currentFulfillmentMode: CodingPlanFulfillmentMode | null | undefined,
    data: {
      name?: string;
      description?: string;
      icon?: string;
      webhookUrl?: string | null;
      allowedPaymentCallbackOrigins?: string[] | null;
      defaultPlanId?: string | null;
      billingMode?: ProductBillingMode;
      codingPlanFulfillmentMode?: CodingPlanFulfillmentMode | string | null;
      fulfillmentMode?: CodingPlanFulfillmentMode | string | null;
      isActive?: boolean;
      sortOrder?: number;
    },
  ): Prisma.ProductUpdateInput {
    const {
      codingPlanFulfillmentMode,
      fulfillmentMode,
      billingMode,
      allowedPaymentCallbackOrigins,
      ...rest
    } = data;
    const nextBillingMode = billingMode ?? currentBillingMode;
    const shouldTouchFulfillment =
      billingMode !== undefined ||
      codingPlanFulfillmentMode !== undefined ||
      fulfillmentMode !== undefined;
    return {
      ...rest,
      ...(allowedPaymentCallbackOrigins !== undefined
        ? {
            allowedPaymentCallbackOrigins: this.paymentCallbackOriginsWriteValue(
              allowedPaymentCallbackOrigins,
            ),
          }
        : {}),
      ...(billingMode !== undefined ? { billingMode } : {}),
      ...(shouldTouchFulfillment
        ? {
            codingPlanFulfillmentMode: this.normalizeProductCodingPlanFulfillmentMode(
              nextBillingMode,
              codingPlanFulfillmentMode ?? fulfillmentMode,
              currentFulfillmentMode,
            ),
          }
        : {}),
    };
  }

  private paymentCallbackOriginsWriteValue(
    value: unknown,
  ): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
    if (value === null) return Prisma.DbNull;
    return this.normalizeAllowedPaymentCallbackOrigins(value);
  }

  private normalizeAllowedPaymentCallbackOrigins(value: unknown): string[] {
    if (!Array.isArray(value)) {
      throw new BadRequestException('allowedPaymentCallbackOrigins 必须是数组或 null');
    }
    if (value.length > PAYMENT_CALLBACK_ORIGIN_MAX_COUNT) {
      throw new BadRequestException(
        `allowedPaymentCallbackOrigins 最多允许 ${PAYMENT_CALLBACK_ORIGIN_MAX_COUNT} 项`,
      );
    }

    const origins = new Set<string>();
    for (const item of value) {
      try {
        origins.add(canonicalizePaymentCallbackOrigin(item));
      } catch (error) {
        throw new BadRequestException(
          error instanceof Error ? error.message : 'allowedPaymentCallbackOrigins 配置不合法',
        );
      }
    }
    return [...origins];
  }

  private paymentCallbackStatus(productId: string, value: Prisma.JsonValue | null) {
    if (value === null) {
      return {
        mode: 'GLOBAL_FALLBACK' as const,
        configuredOrigins: null,
        effectiveOrigins: [...resolvePaymentCallbackAllowedOrigins(this.paymentCallbackPolicyConfig())],
      };
    }

    try {
      const configuredOrigins = this.normalizeAllowedPaymentCallbackOrigins(value);
      if (configuredOrigins.length === 0) {
        return {
          mode: 'DENY_ALL' as const,
          configuredOrigins,
          effectiveOrigins: [],
        };
      }
      return {
        mode: 'PRODUCT_ALLOWLIST' as const,
        configuredOrigins,
        effectiveOrigins: configuredOrigins,
      };
    } catch (error) {
      this.logger.error(
        `invalid allowedPaymentCallbackOrigins found for product=${productId}; denying all callbacks: ${(error as Error).message}`,
      );
      return {
        mode: 'DENY_ALL' as const,
        configuredOrigins: [],
        effectiveOrigins: [],
      };
    }
  }

  private paymentCallbackPolicyConfig(): { get(key: string): string | undefined } | undefined {
    if (!this.config) return undefined;
    return { get: (key: string) => this.config?.get<string>(key) };
  }

  private defaultRuntimePolicyFor(billingMode: ProductBillingMode): RuntimePolicyFields {
    if (billingMode === ProductBillingMode.PAY_AS_YOU_GO) {
      return {
        credentialSource: 'keypool',
        allowedProviderIds: [],
        allowedChannelIds: [],
        modelScopeMode: 'product_allowlist',
        allowedModels: [],
        fallbackPolicy: 'within_product',
        runtimeBillingMode: 'payg_balance',
        routeStrategy: null,
        allowHighLossBridgeWhenNoNative: false,
        allowBridgeOnNativeFailure: false,
        highLossBridgeReason: null,
        highLossBridgeOwner: null,
        highLossBridgeExpiresAt: null,
        highLossBridgeApproval: null,
        status: 'active',
      };
    }
    if (billingMode === ProductBillingMode.CODING_PLAN) {
      return {
        credentialSource: 'keypool',
        allowedProviderIds: [],
        allowedChannelIds: [],
        modelScopeMode: 'plan_configured',
        allowedModels: [],
        fallbackPolicy: 'within_product',
        runtimeBillingMode: 'token_plan_quota',
        routeStrategy: null,
        allowHighLossBridgeWhenNoNative: false,
        allowBridgeOnNativeFailure: false,
        highLossBridgeReason: null,
        highLossBridgeOwner: null,
        highLossBridgeExpiresAt: null,
        highLossBridgeApproval: null,
        status: 'active',
      };
    }
    return {
      credentialSource: 'keypool',
      allowedProviderIds: [],
      allowedChannelIds: [],
      modelScopeMode: 'plan_configured',
      allowedModels: [],
      fallbackPolicy: 'within_product',
      runtimeBillingMode: 'subscription_credits',
      routeStrategy: null,
      allowHighLossBridgeWhenNoNative: false,
      allowBridgeOnNativeFailure: false,
      highLossBridgeReason: null,
      highLossBridgeOwner: null,
      highLossBridgeExpiresAt: null,
      highLossBridgeApproval: null,
      status: 'active',
    };
  }

  private async normalizeRuntimePolicy(
    billingMode: ProductBillingMode,
    data: Record<string, unknown>,
  ): Promise<RuntimePolicyFields> {
    const defaults = this.defaultRuntimePolicyFor(billingMode);
    const credentialSource = this.requiredEnumValue(data.credentialSource, CREDENTIAL_SOURCES, '凭证来源');
    const modelScopeMode = this.enumValue(data.modelScopeMode, MODEL_SCOPE_MODES, defaults.modelScopeMode, '模型范围');
    const fallbackPolicy = this.enumValue(data.fallbackPolicy, FALLBACK_POLICIES, defaults.fallbackPolicy, 'Fallback 策略');
    const runtimeBillingMode = this.enumValue(
      data.runtimeBillingMode,
      RUNTIME_BILLING_MODES,
      defaults.runtimeBillingMode,
      '运行计费语义',
    );
    const status = this.enumValue(data.status, RUNTIME_POLICY_STATUSES, defaults.status, '策略状态');
    const routeStrategy = this.optionalEnumValue(data.routeStrategy, ROUTE_STRATEGIES, '路由策略');
    const allowHighLossBridgeWhenNoNative = this.booleanValue(
      data.allowHighLossBridgeWhenNoNative,
      defaults.allowHighLossBridgeWhenNoNative,
      'allowHighLossBridgeWhenNoNative',
    );
    const allowBridgeOnNativeFailure = this.booleanValue(
      data.allowBridgeOnNativeFailure,
      defaults.allowBridgeOnNativeFailure,
      'allowBridgeOnNativeFailure',
    );
    const highLossBridgeReason = allowHighLossBridgeWhenNoNative
      ? this.requiredText(data.highLossBridgeReason, 'highLossBridgeReason')
      : null;
    const highLossBridgeOwner = allowHighLossBridgeWhenNoNative
      ? this.requiredText(data.highLossBridgeOwner, 'highLossBridgeOwner')
      : null;
    const highLossBridgeApproval = allowHighLossBridgeWhenNoNative
      ? this.requiredText(data.highLossBridgeApproval, 'highLossBridgeApproval')
      : null;
    const highLossBridgeExpiresAt = allowHighLossBridgeWhenNoNative
      ? this.requiredFutureDate(data.highLossBridgeExpiresAt, 'highLossBridgeExpiresAt')
      : null;

    const allowedChannelIds = this.normalizeStringArray(data.allowedChannelIds);
    const channels = await this.validateRuntimePolicyChannels(allowedChannelIds);
    const derivedProviderIds = channels.map((channel) => this.runtimeProviderIdForChannel(channel));
    const allowedProviderIds = this.normalizeStringArray([
      ...this.normalizeStringArray(data.allowedProviderIds),
      ...derivedProviderIds,
    ]);
    const allowedModels = modelScopeMode === 'product_allowlist'
      ? this.normalizeStringArray(data.allowedModels)
      : [];

    if (modelScopeMode === 'product_allowlist' && allowedModels.length === 0) {
      throw new BadRequestException('产品白名单模式必须至少配置一个模型');
    }
    if (credentialSource === 'dedicated_upstream' && fallbackPolicy === 'platform_default') {
      throw new BadRequestException('专属上游凭证不能回退到平台默认渠道');
    }

    return {
      credentialSource,
      allowedProviderIds,
      allowedChannelIds,
      modelScopeMode,
      allowedModels,
      fallbackPolicy,
      runtimeBillingMode,
      routeStrategy,
      allowHighLossBridgeWhenNoNative,
      allowBridgeOnNativeFailure,
      highLossBridgeReason,
      highLossBridgeOwner,
      highLossBridgeExpiresAt,
      highLossBridgeApproval,
      status,
    };
  }

  private runtimePolicyWriteData(
    fields: RuntimePolicyFields,
  ): Omit<Prisma.ProductRuntimePolicyUncheckedCreateInput, 'id' | 'productId' | 'revision' | 'createdAt' | 'updatedAt'> {
    return {
      credentialSource: fields.credentialSource,
      allowedProviderIds: fields.allowedProviderIds,
      allowedChannelIds: fields.allowedChannelIds,
      modelScopeMode: fields.modelScopeMode,
      allowedModels: fields.allowedModels,
      fallbackPolicy: fields.fallbackPolicy,
      runtimeBillingMode: fields.runtimeBillingMode,
      routeStrategy: fields.routeStrategy,
      allowHighLossBridgeWhenNoNative: fields.allowHighLossBridgeWhenNoNative,
      allowBridgeOnNativeFailure: fields.allowBridgeOnNativeFailure,
      highLossBridgeReason: fields.highLossBridgeReason,
      highLossBridgeOwner: fields.highLossBridgeOwner,
      highLossBridgeExpiresAt: fields.highLossBridgeExpiresAt,
      highLossBridgeApproval: fields.highLossBridgeApproval,
      status: fields.status,
    };
  }

  private serializeRuntimePolicy(
    productId: string,
    billingMode: ProductBillingMode,
    policy: {
      id: string;
      credentialSource: string;
      allowedProviderIds: Prisma.JsonValue | null;
      allowedChannelIds: Prisma.JsonValue | null;
      modelScopeMode: string;
      allowedModels: Prisma.JsonValue | null;
      fallbackPolicy: string;
      runtimeBillingMode: string;
      routeStrategy: string | null;
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
    } | null,
  ) {
    const defaults = this.defaultRuntimePolicyFor(billingMode);
    if (!policy) {
      return {
        id: null,
        productId,
        ...defaults,
        effectiveAllowHighLossBridgeWhenNoNative: false,
        highLossBridgeExpired: false,
        revision: 0,
        createdAt: null,
        updatedAt: null,
      };
    }
    return {
      id: policy.id,
      productId,
      credentialSource: this.requiredEnumValue(policy.credentialSource, CREDENTIAL_SOURCES, '凭证来源'),
      allowedProviderIds: this.normalizeStringArray(policy.allowedProviderIds),
      allowedChannelIds: this.normalizeStringArray(policy.allowedChannelIds),
      modelScopeMode: this.enumValue(policy.modelScopeMode, MODEL_SCOPE_MODES, defaults.modelScopeMode, '模型范围'),
      allowedModels: this.normalizeStringArray(policy.allowedModels),
      fallbackPolicy: this.enumValue(policy.fallbackPolicy, FALLBACK_POLICIES, defaults.fallbackPolicy, 'Fallback 策略'),
      runtimeBillingMode: this.enumValue(
        policy.runtimeBillingMode,
        RUNTIME_BILLING_MODES,
        defaults.runtimeBillingMode,
        '运行计费语义',
      ),
      routeStrategy: this.optionalEnumValue(policy.routeStrategy, ROUTE_STRATEGIES, '路由策略'),
      allowHighLossBridgeWhenNoNative: policy.allowHighLossBridgeWhenNoNative,
      effectiveAllowHighLossBridgeWhenNoNative: this.effectiveAllowHighLossBridgeWhenNoNative(policy),
      allowBridgeOnNativeFailure: policy.allowBridgeOnNativeFailure,
      highLossBridgeReason: policy.highLossBridgeReason,
      highLossBridgeOwner: policy.highLossBridgeOwner,
      highLossBridgeExpiresAt: policy.highLossBridgeExpiresAt?.toISOString() ?? null,
      highLossBridgeApproval: policy.highLossBridgeApproval,
      highLossBridgeExpired: this.highLossBridgeExpired(policy),
      status: this.enumValue(policy.status, RUNTIME_POLICY_STATUSES, defaults.status, '策略状态'),
      revision: policy.revision,
      createdAt: policy.createdAt.toISOString(),
      updatedAt: policy.updatedAt.toISOString(),
    };
  }

  private async runtimePolicyChannels() {
    const channels = await this.prisma.channel.findMany({
      where: { deletedAt: null },
      orderBy: [{ provider: 'asc' }, { priority: 'asc' }, { name: 'asc' }],
      select: {
        id: true,
        name: true,
        provider: true,
        providerProfile: true,
        baseUrl: true,
        sdkType: true,
        models: true,
        status: true,
        isActive: true,
        priority: true,
        weight: true,
      },
    });
    return channels.map((channel) => ({
      ...channel,
      runtimeProviderId: this.runtimeProviderIdForChannel(channel),
      models: this.parseStringArray(channel.models),
    }));
  }

  private async validateRuntimePolicyChannels(channelIds: string[]) {
    if (channelIds.length === 0) return [];
    const channels = await this.prisma.channel.findMany({
      where: { id: { in: channelIds }, deletedAt: null },
      select: {
        id: true,
        provider: true,
        providerProfile: true,
        baseUrl: true,
        sdkType: true,
      },
    });
    if (channels.length !== channelIds.length) {
      throw new BadRequestException('部分渠道不存在或已删除');
    }
    return channels;
  }

  private runtimeProviderIdForChannel(
    channel: Pick<Channel, 'provider'> & Partial<Pick<Channel, 'baseUrl' | 'sdkType' | 'providerProfile'>>,
  ): string {
    return this.publisherSync?.runtimeProviderIdForChannel(channel)
      ?? this.normalizeProviderId(channel.provider);
  }

  private normalizeProviderId(provider: string): string {
    const normalized = (provider || 'unknown').trim().toLowerCase().replace(/[^a-z0-9._-]+/g, '-');
    return normalized === 'moonshot' ? 'kimi' : normalized;
  }

  private enumValue<T extends readonly string[]>(
    value: unknown,
    allowed: T,
    fallback: T[number],
    label: string,
  ): T[number] {
    if (value === undefined || value === null || value === '') return fallback;
    const normalized = typeof value === 'string' ? value.trim() : '';
    if ((allowed as readonly string[]).includes(normalized)) return normalized as T[number];
    throw new BadRequestException(`${label} 不合法`);
  }

  private requiredEnumValue<T extends readonly string[]>(
    value: unknown,
    allowed: T,
    label: string,
  ): T[number] {
    if (value === undefined || value === null || value === '') {
      throw new BadRequestException(`${label} 不能为空`);
    }
    return this.enumValue(value, allowed, allowed[0], label);
  }

  private optionalEnumValue<T extends readonly string[]>(
    value: unknown,
    allowed: T,
    label: string,
  ): T[number] | null {
    if (value === undefined || value === null || value === '') return null;
    return this.enumValue(value, allowed, allowed[0], label);
  }

  private booleanValue(value: unknown, fallback: boolean, label: string): boolean {
    if (value === undefined || value === null || value === '') return fallback;
    if (typeof value === 'boolean') return value;
    throw new BadRequestException(`${label} 必须是布尔值`);
  }

  private requiredText(value: unknown, label: string): string {
    if (typeof value !== 'string') throw new BadRequestException(`${label} 必须是非空字符串`);
    const trimmed = value.trim();
    if (!trimmed) throw new BadRequestException(`${label} 必须是非空字符串`);
    if (trimmed.length > 512) throw new BadRequestException(`${label} 不能超过 512 字符`);
    return trimmed;
  }

  private requiredFutureDate(value: unknown, label: string): Date {
    if (typeof value !== 'string' && !(value instanceof Date)) {
      throw new BadRequestException(`${label} 必须是未来时间`);
    }
    const date = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(date.getTime())) throw new BadRequestException(`${label} 必须是合法时间`);
    if (date.getTime() <= Date.now()) throw new BadRequestException(`${label} 必须是未来时间`);
    return date;
  }

  private effectiveAllowHighLossBridgeWhenNoNative(
    policy: Pick<RuntimePolicyFields, 'allowHighLossBridgeWhenNoNative' | 'highLossBridgeExpiresAt'>,
  ): boolean {
    return policy.allowHighLossBridgeWhenNoNative && !this.highLossBridgeExpired(policy);
  }

  private highLossBridgeExpired(
    policy: Pick<RuntimePolicyFields, 'allowHighLossBridgeWhenNoNative' | 'highLossBridgeExpiresAt'>,
  ): boolean {
    return Boolean(
      policy.allowHighLossBridgeWhenNoNative &&
      policy.highLossBridgeExpiresAt &&
      policy.highLossBridgeExpiresAt.getTime() <= Date.now(),
    );
  }

  private normalizeStringArray(value: unknown): string[] {
    if (!Array.isArray(value)) return [];
    return Array.from(new Set(
      value
        .filter((item): item is string => typeof item === 'string')
        .map((item) => item.trim())
        .filter(Boolean),
    ));
  }

  private parseStringArray(raw: string | null | undefined): string[] {
    if (!raw) return [];
    try {
      const parsed = JSON.parse(raw);
      return this.normalizeStringArray(parsed);
    } catch {
      return [];
    }
  }

  private safeProduct<T extends Record<string, any> | null>(product: T): T {
    if (!product) return product;
    const {
      integrationTokenHash,
      webhookSecretEncrypted,
      ...safe
    } = product;
    void integrationTokenHash;
    void webhookSecretEncrypted;
    const fulfillmentMode = safe.billingMode === ProductBillingMode.CODING_PLAN
      ? safe.codingPlanFulfillmentMode ?? CodingPlanFulfillmentMode.platform_model_package
      : null;
    const allowedPaymentCallbackOrigins = normalizeProductPaymentCallbackOrigins(
      safe.allowedPaymentCallbackOrigins,
    );
    return {
      ...safe,
      allowedPaymentCallbackOrigins,
      fulfillmentMode,
    } as unknown as T;
  }

  private tombstoneSlug(slug: string, deletedAt: Date): string {
    return `${slug}__deleted_${deletedAt.getTime()}`;
  }

  private generateSecret(prefix: string): string {
    return `${prefix}_${randomBytes(32).toString('base64url')}`;
  }

  private hashSecret(value: string): string {
    return createHash('sha256').update(value).digest('hex');
  }

  private resolveEncryptionKeyOrThrow(): string {
    const config = this.config ?? { get: (key: string) => process.env[key] };
    const key = resolveEncryptionKey(config as Pick<ConfigService, 'get'>);
    if (!key) {
      throw new BadRequestException('ENCRYPTION_KEY 未配置，无法生成产品 Webhook Secret');
    }
    return key;
  }

  private partnerApiPublicBaseUrl(): string | null {
    return this.config?.get<string>('PARTNER_API_PUBLIC_BASE_URL')
      ?? this.config?.get<string>('OPENAPI_PUBLIC_BASE_URL')
      ?? null;
  }
}
