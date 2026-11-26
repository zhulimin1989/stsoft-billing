import {
  Injectable,
  NotFoundException,
  BadRequestException,
  Logger,
  Optional,
} from '@nestjs/common';
import * as crypto from 'crypto';
import { RedisService } from '../redis/redis.service';
import { ApiKeyRepository } from './apikey.repository';
import { ModelPricingService } from '../billing/model-pricing.service';
import { PublisherSyncService } from '../publisher/publisher-sync.service';
import { centsToUsd, usdNumber, usdToCents, type DecimalLike } from '../billing/money';
import { ApiKey, API_KEY_PREFIX_LENGTH, MAX_API_KEYS_PER_USER } from '@ruidong/shared';
import { ApiKey as PrismaApiKey } from '@prisma/client';
import { apiKeyHashCandidates, hashApiKey } from '../common/utils/api-key-hash';

type CodingPlanEntitlementBinding = {
  id: string;
  tenantId: string;
  productId: string;
  fulfillmentMode: string;
  providerEntitlement?: { id: string; status: string } | null;
};

/**
 * Legacy billing-plane API key service.
 *
 * This provider is not mounted by `BillingRuntimeModule`; current API Platform
 * and TokenPlan key creation is owned by `codesphere-user`.
 */
@Injectable()
export class ApiKeyService {
  private readonly logger = new Logger(ApiKeyService.name);

  constructor(
    private readonly apiKeyRepository: ApiKeyRepository,
    private readonly redis: RedisService,
    private readonly modelPricingService: ModelPricingService,
    @Optional() private readonly publisherSync?: PublisherSyncService,
  ) {}

  async createKey(
    userId: string,
    name: string,
    allowedModels?: string[],
    budgetCents?: number | null,
    productId?: string | null,
    codingPlanEntitlementId?: string | null,
    requestedTenantId?: string | null,
  ): Promise<{ key: ApiKey; plainKey: string }> {
    const tenantId = await this.resolveTenantId(userId, requestedTenantId, ['owner', 'admin']);
    const count = await this.apiKeyRepository.countByTenant(tenantId, userId);
    if (count >= MAX_API_KEYS_PER_USER) {
      throw new BadRequestException(`最多创建 ${MAX_API_KEYS_PER_USER} 个 API Key`);
    }

    const rawKey = `rk-${crypto.randomBytes(32).toString('hex')}`;
    const prefix = rawKey.slice(0, API_KEY_PREFIX_LENGTH + 3); // "rk-" + 8 chars
    const keyHash = hashApiKey(rawKey);
    const normalizedProductId = productId?.trim() || null;
    const normalizedEntitlementId = codingPlanEntitlementId?.trim() || null;
    if (normalizedProductId) {
      const product = await this.apiKeyRepository.findActiveProductById(normalizedProductId);
      if (!product) {
        throw new BadRequestException('产品不存在或未启用');
      }
    }
    const entitlementBinding = normalizedEntitlementId
      ? await this.assertCodingPlanEntitlementBinding(
        normalizedEntitlementId,
        tenantId,
        normalizedProductId,
      )
      : null;

    const created = await this.apiKeyRepository.createWithProviderResaleGuard(
      {
        userId,
        tenantId,
        productId: normalizedProductId,
        codingPlanEntitlementId: normalizedEntitlementId,
        name,
        prefix,
        keyHash,
        allowedModels: allowedModels ? JSON.stringify(allowedModels) : null,
        budgetUsd: budgetCents == null ? null : centsToUsd(budgetCents),
      },
      this.providerResaleGuard(entitlementBinding),
    );

    this.publishApiKeyMeta(created);
    return {
      key: this.toApiKey(created, 0),
      plainKey: rawKey,
    };
  }

  async getUserKeys(userId: string, requestedTenantId?: string | null): Promise<ApiKey[]> {
    const tenantId = await this.resolveTenantId(userId, requestedTenantId);
    const keys = await this.apiKeyRepository.findByTenant(tenantId, userId);
    const spendRows = await this.apiKeyRepository.spendByKeyIds(
      keys.map((k: PrismaApiKey) => k.id),
    );
    const spendByKeyId = new Map(
      spendRows.map((row) => [row.apiKeyId, usdNumber(row._sum.costUsd ?? 0)]),
    );

    return keys.map((k: PrismaApiKey) => this.toApiKey(k, spendByKeyId.get(k.id) ?? 0));
  }

  async deleteKey(keyId: string, userId: string, requestedTenantId?: string | null): Promise<void> {
    const tenantId = await this.resolveTenantId(userId, requestedTenantId, ['owner', 'admin']);
    const key = await this.apiKeyRepository.findByIdAndTenant(keyId, tenantId, userId);
    if (!key) {
      throw new NotFoundException('API Key 不存在');
    }
    await this.apiKeyRepository.deleteById(keyId);
    // 清除 Redis 缓存
    await this.redis.del(`apikey:${key.keyHash}`);
    this.publishApiKeyRevoked(key);
  }

  async toggleKey(
    keyId: string,
    userId: string,
    isActive: boolean,
    requestedTenantId?: string | null,
  ): Promise<ApiKey> {
    const tenantId = await this.resolveTenantId(userId, requestedTenantId, ['owner', 'admin']);
    const key = await this.apiKeyRepository.findByIdAndTenant(keyId, tenantId, userId);
    if (!key) {
      throw new NotFoundException('API Key 不存在');
    }
    const entitlementBinding = isActive && key.codingPlanEntitlementId
      ? await this.assertCodingPlanEntitlementBinding(
          key.codingPlanEntitlementId,
          tenantId,
          key.productId ?? null,
        )
      : null;
    const updated = await this.apiKeyRepository.updateIsActiveWithProviderResaleGuard(
      keyId,
      isActive,
      this.providerResaleGuard(entitlementBinding, keyId),
    );
    // 更新 Redis 缓存
    await this.redis.del(`apikey:${key.keyHash}`);
    const usageUsd = await this.apiKeyRepository.spendByKeyId(keyId);
    this.publishApiKeyMetaById(keyId);
    return this.toApiKey(updated, usageUsd);
  }

  async getBudgetStatus(apiKeyId: string): Promise<{
    budgetCents: number | null;
    usageCents: number;
  }> {
    const key = await this.apiKeyRepository.findById(apiKeyId);
    if (!key) {
      throw new NotFoundException('API Key 不存在');
    }

    const usageUsd = await this.apiKeyRepository.spendByKeyId(apiKeyId);

    return {
      budgetCents: key.budgetUsd == null ? null : usdToCents(key.budgetUsd as DecimalLike),
      usageCents: usdToCents(usageUsd),
    };
  }

  /**
   * 通过 Bearer Token 验证 API Key，返回 userId
   * 用于 Gateway 鉴权
   */
  async validateKey(rawKey: string): Promise<{
    userId: string;
    tenantId: string;
    apiKeyId: string;
    allowedModels: string[] | null;
    productId?: string | null;
    codingPlanEntitlementId?: string | null;
  } | null> {
    const keyHashes = apiKeyHashCandidates(rawKey);

    // 先查 Redis 缓存
    let hasMissingCache = false;
    let hasInvalidCache = false;
    for (const keyHash of keyHashes) {
      const cached = await this.redis.get(`apikey:${keyHash}`);
      if (!cached) {
        hasMissingCache = true;
        continue;
      }
      if (cached === 'INVALID') {
        hasInvalidCache = true;
        continue;
      }
      const { userId, tenantId, apiKeyId, allowedModels, productId, codingPlanEntitlementId } = JSON.parse(cached);
      return {
        userId,
        tenantId,
        apiKeyId,
        allowedModels: allowedModels ?? null,
        ...(productId ? { productId } : {}),
        ...(codingPlanEntitlementId ? { codingPlanEntitlementId } : {}),
      };
    }
    if (hasInvalidCache && !hasMissingCache) return null;

    // 查数据库
    let matchedHash: string | null = null;
    let key: PrismaApiKey | null = null;
    for (const keyHash of keyHashes) {
      key = await this.apiKeyRepository.findByKeyHash(keyHash);
      if (key) {
        matchedHash = keyHash;
        break;
      }
    }

    if (!key || !key.isActive) {
      await Promise.all(
        keyHashes.map((keyHash) => this.redis.set(`apikey:${keyHash}`, 'INVALID', 'EX', 300)),
      );
      return null;
    }

    const allowedModels: string[] | null = key.allowedModels
      ? JSON.parse(key.allowedModels)
      : null;
    const result = {
      userId: key.userId,
      tenantId: key.tenantId,
      apiKeyId: key.id,
      allowedModels,
      ...(key.productId ? { productId: key.productId } : {}),
      ...(key.codingPlanEntitlementId ? { codingPlanEntitlementId: key.codingPlanEntitlementId } : {}),
    };
    await this.redis.set(`apikey:${matchedHash ?? keyHashes[0]}`, JSON.stringify(result), 'EX', 3600);

    // 更新最后使用时间（异步，不阻塞）
    this.apiKeyRepository.updateLastUsed(key.id).catch(() => {});

    return result;
  }

  async listAvailableModels(): Promise<
    Array<{ label: string; value: string; inputPrice: number; outputPrice: number }>
  > {
    const models = await this.modelPricingService.listPublic();
    return models.map((m) => ({
      label: m.displayName,
      value: m.modelName,
      inputPrice: m.inputPricePerMToken,
      outputPrice: m.outputPricePerMToken,
    }));
  }

  private async assertCodingPlanEntitlementBinding(
    entitlementId: string,
    tenantId: string,
    productId?: string | null,
  ): Promise<CodingPlanEntitlementBinding> {
    const entitlement = await this.apiKeyRepository.findActiveCodingPlanEntitlement(entitlementId);
    if (!entitlement) {
      throw new BadRequestException('CodingPlan 权益不存在或不可用');
    }
    if (entitlement.tenantId !== tenantId) {
      throw new BadRequestException('CodingPlan 权益不属于当前工作区');
    }
    if (productId && entitlement.productId !== productId) {
      throw new BadRequestException('CodingPlan 权益与产品不匹配');
    }
    if (
      entitlement.fulfillmentMode === 'provider_resale'
      && entitlement.providerEntitlement?.status !== 'ACTIVE'
    ) {
      throw new BadRequestException('CodingPlan 上游权益尚未激活');
    }
    return entitlement;
  }

  private providerResaleGuard(
    entitlement: CodingPlanEntitlementBinding | null,
    exceptApiKeyId?: string,
  ): { entitlementId: string; exceptApiKeyId?: string } | null {
    if (entitlement?.fulfillmentMode !== 'provider_resale') return null;
    return {
      entitlementId: entitlement.id,
      ...(exceptApiKeyId ? { exceptApiKeyId } : {}),
    };
  }

  private toApiKey(key: {
    id: string;
    userId: string;
    tenantId: string;
    productId?: string | null;
    codingPlanEntitlementId?: string | null;
    product?: { name: string } | null;
    name: string;
    prefix: string;
    isActive: boolean;
    allowedModels: string | null;
    budgetUsd: unknown | null;
    lastUsedAt: Date | null;
    createdAt: Date;
  }, usageUsd = 0): ApiKey {
    const budgetUsd = key.budgetUsd == null ? null : usdNumber(key.budgetUsd as DecimalLike);
    return {
      id: key.id,
      userId: key.userId,
      tenantId: key.tenantId,
      productId: key.productId ?? null,
      codingPlanEntitlementId: key.codingPlanEntitlementId ?? null,
      productName: key.product?.name ?? null,
      name: key.name,
      prefix: key.prefix,
      isActive: key.isActive,
      allowedModels: key.allowedModels ? JSON.parse(key.allowedModels) : null,
      budgetCents: key.budgetUsd == null ? null : usdToCents(key.budgetUsd as DecimalLike),
      usageCents: usdToCents(usageUsd),
      budgetUsd,
      usageUsd,
      lastUsedAt: key.lastUsedAt?.toISOString() ?? null,
      createdAt: key.createdAt.toISOString(),
    };
  }

  private publishApiKeyMeta(key: PrismaApiKey): void {
    if (!this.publisherSync) return;
    this.publisherSync.syncApiKeyMeta(key).catch((err) => {
      this.logger.warn(`publisher api key sync failed key=${key.id}: ${(err as Error).message}`);
    });
  }

  private publishApiKeyMetaById(keyId: string): void {
    if (!this.publisherSync) return;
    this.publisherSync.syncApiKeyMetaById(keyId).catch((err) => {
      this.logger.warn(`publisher api key sync failed key=${keyId}: ${(err as Error).message}`);
    });
  }

  private publishApiKeyRevoked(key: Pick<PrismaApiKey, 'id' | 'keyHash'>): void {
    if (!this.publisherSync) return;
    this.publisherSync.revokeApiKey(key).catch((err) => {
      this.logger.warn(`publisher api key revoke failed key=${key.id}: ${(err as Error).message}`);
    });
  }

  private resolveTenantId(
    userId: string,
    requestedTenantId?: string | null,
    allowedRoles?: string[],
  ): Promise<string> {
    return this.apiKeyRepository.resolveTenantId(userId, requestedTenantId, allowedRoles);
  }
}
