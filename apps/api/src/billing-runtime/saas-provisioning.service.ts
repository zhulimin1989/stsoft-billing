import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  Injectable,
  Logger,
  OnModuleDestroy,
  OnModuleInit,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { API_KEY_PREFIX_LENGTH } from '@ruidong/shared';
import { createHash, randomBytes, randomUUID } from 'crypto';
import { hashApiKey } from '../common/utils/api-key-hash';
import { decrypt, encrypt } from '../common/utils/crypto';
import { resolveEncryptionKey } from '../common/utils/encryption-key';
import { BillingService } from '../billing/billing.service';
import { CreditService } from '../billing/credit.service';
import { ProductPortalCatalogService } from '../billing/product-portal-catalog.service';
import { SubscriptionLifecycleService } from '../billing/subscription-lifecycle.service';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherSyncService } from '../publisher/publisher-sync.service';
import { BillingUserMirrorService } from './billing-user-mirror.service';

type SaasProvisionUser = {
  id?: string;
  email?: string | null;
  phone?: string | null;
  nickname?: string | null;
  isActive?: boolean | null;
  sourceUpdatedAt?: string | Date | null;
};

type SaasProvisionTenant = {
  id?: string | null;
  name?: string | null;
  type?: string | null;
};

type SaasProvisionKey = {
  name?: string | null;
  allowedModels?: string[] | null;
  budgetCents?: number | null;
  rotate?: boolean | null;
};

export type SaasProvisionRequest = {
  idempotencyKey?: string | null;
  productSlug?: string | null;
  productId?: string | null;
  user?: SaasProvisionUser | null;
  tenant?: SaasProvisionTenant | null;
  key?: SaasProvisionKey | null;
  ensureFreePlan?: boolean | null;
};

type ProvisionedApiKey = {
  id: string;
  prefix: string;
  plainKey: string | null;
  created: boolean;
  rotated: boolean;
};

type ProvisionDb = Prisma.TransactionClient | PrismaService;

type ProductUserBindingResolution = {
  userId: string;
  email: string | null;
  phone: string | null;
  nickname: string | null;
};

type ProductTenantBindingResolution = {
  tenantId: string;
  ownerUserId: string;
  type: string;
};

type PreparedApiKey = {
  id: string;
  prefix: string;
  plainKey: string | null;
  created: boolean;
  rotated: boolean;
  predecessor: {
    id: string;
    keyHash: string;
  } | null;
};

type ProvisionReceiptLease = {
  id: string;
  leaseId: string;
  replayResult: Prisma.JsonValue | null;
};

type SaasProvisionResult = {
  userId: string;
  tenantId: string;
  productId: string;
  productSlug: string;
  apiKey: ProvisionedApiKey;
  subscription: {
    id: string;
    planId: string;
    created: boolean;
  } | null;
};

type ProvisionedPlan = {
  id: string;
  planId: string;
  created: boolean;
  provisionReceiptId: string | null;
};

const SAAS_PROVISION_MANAGED_BY = 'saas_provision';
const PROVISION_SECRET_RECOVERY_MS = 15 * 60 * 1000;
const PROVISION_LEASE_MS = 10 * 60 * 1000;
const PROVISION_IDEMPOTENCY_KEY_PATTERN = /^[A-Za-z0-9._:-]+$/;

@Injectable()
export class SaasProvisioningService implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(SaasProvisioningService.name);
  private provisionSecretCleanupTimer: NodeJS.Timeout | null = null;

  constructor(
    private readonly prisma: PrismaService,
    private readonly billingService: BillingService,
    private readonly creditService: CreditService,
    private readonly publisherSync: PublisherSyncService,
    private readonly userMirror: BillingUserMirrorService,
    private readonly config: ConfigService,
    private readonly subscriptionLifecycle: SubscriptionLifecycleService,
    private readonly catalog: ProductPortalCatalogService,
  ) {}

  async onModuleInit(): Promise<void> {
    await this.cleanupExpiredProvisionSecrets();
    this.provisionSecretCleanupTimer = setInterval(() => {
      this.cleanupExpiredProvisionSecrets().catch((error) => {
        this.logger.error(
          `failed to clean expired SaaS API key recovery secrets: ${this.errorMessage(error)}`,
        );
      });
    }, 60_000);
    this.provisionSecretCleanupTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.provisionSecretCleanupTimer) {
      clearInterval(this.provisionSecretCleanupTimer);
      this.provisionSecretCleanupTimer = null;
    }
  }

  async provision(input: SaasProvisionRequest = {}): Promise<SaasProvisionResult> {
    const externalUserId = this.requireString(input.user?.id, 'user.id');
    this.assertPartnerUserSnapshot(input.user);
    const idempotencyKey = this.requireProvisionIdempotencyKey(input.idempotencyKey);
    const product = await this.resolveProduct(input.productId, input.productSlug);
    const requestedTenantId = this.normalizeNullableString(input.tenant?.id);
    if (!requestedTenantId && !this.isUserOnlyProduct(product)) {
      throw new BadRequestException(
        'tenant.id 对该产品是必填字段；仅自营 Coding Plan 支持 user-only scope',
      );
    }
    if (
      !requestedTenantId
      && this.normalizeNullableString(input.tenant?.type)
      && this.normalizeTenantType(input.tenant?.type) !== 'personal'
    ) {
      throw new BadRequestException(
        'user-only Coding Plan 的 tenant.type 只能是 personal',
      );
    }
    this.assertAllowedModelsInput(input.key);
    const ensureFreePlan = this.resolveEnsureFreePlan(
      product,
      input.ensureFreePlan,
    );
    const receipt = await this.beginProvisionReceipt(
      product.id,
      idempotencyKey,
      this.provisionRequestFingerprint(product.id, input, ensureFreePlan),
    );
    if (receipt.replayResult) {
      return this.hydrateProvisionReceiptResult(receipt.replayResult);
    }

    let tenantLease: { bindingId: string; leaseId: string } | null = null;
    let primaryError: unknown;
    try {
      const identity = await this.prisma.$transaction(async (tx) => {
        await this.lockProvisionIdentity(tx, `user:${product.id}:${externalUserId}`);
        const user = await this.ensureBoundUser(
          tx,
          product.id,
          externalUserId,
          input.user ?? undefined,
        );
        await this.lockProvisionIdentity(
          tx,
          requestedTenantId
            ? `tenant:${product.id}:${requestedTenantId}`
            : `personal-tenant:${product.id}:${externalUserId}`,
        );
        const tenant = await this.ensureBoundTenant(
          tx,
          product.id,
          user.bindingId,
          user.id,
          input.tenant ?? undefined,
        );
        let runtimeTenant = tenant;
        if (this.isUserOnlyProduct(product) && requestedTenantId) {
          await this.lockProvisionIdentity(
            tx,
            `personal-tenant:${product.id}:${externalUserId}`,
          );
          runtimeTenant = await this.ensureBoundTenant(
            tx,
            product.id,
            user.bindingId,
            user.id,
            undefined,
          );
        }
        return { user, tenant, runtimeTenant };
      }, {
        maxWait: 10_000,
        timeout: 30_000,
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      });
      const { user, tenant, runtimeTenant } = identity;
      await this.renewProvisionReceipt(receipt);
      const leaseId = await this.acquireProvisionLease(runtimeTenant.bindingId);
      tenantLease = { bindingId: runtimeTenant.bindingId, leaseId };

      const billingSubject = await this.ensureTenantBillingAccount(
        user.id,
        runtimeTenant.id,
      );
      await this.renewProvisionLeases(tenantLease, receipt);
      const subscription: ProvisionedPlan | null = ensureFreePlan
        ? product.billingMode === 'CODING_PLAN'
          ? await this.ensureDefaultCodingPlan(
              user.id,
              runtimeTenant.id,
              product.id,
              receipt.id,
            )
          : await this.ensureDefaultPlan(
            user.id,
            runtimeTenant.id,
            product.id,
            receipt.id,
            billingSubject.billingAccountId,
          )
        : null;

      const finish = async (
        authoritativePlan: ProvisionedPlan | null,
        codingPlanEntitlementId: string | null,
      ): Promise<SaasProvisionResult> => {
        await this.renewProvisionLeases(tenantLease!, receipt);
        await this.assertRequestedModelsAuthorized(
          product,
          authoritativePlan?.planId ?? null,
          input.key,
        );
        await this.ensureTenantProductEntitlement(
          runtimeTenant.id,
          product.id,
          authoritativePlan?.planId ?? null,
        );
        await this.renewProvisionLeases(tenantLease!, receipt);
        const apiKey = await this.ensureVirtualApiKey(
          user.id,
          runtimeTenant.id,
          product.id,
          product.slug,
          input.key ?? undefined,
          receipt,
          codingPlanEntitlementId,
        );
        if (
          authoritativePlan
          && authoritativePlan.provisionReceiptId === receipt.id
        ) {
          const quotaPlan = await this.requireProvisionPlan(
            authoritativePlan.planId,
            product.id,
          );
          await this.grantProvisionQuota(
            authoritativePlan.id,
            user.id,
            quotaPlan,
          );
        }
        const result: SaasProvisionResult = {
          userId: user.id,
          tenantId: tenant.id,
          productId: product.id,
          productSlug: product.slug,
          apiKey,
          subscription: authoritativePlan
            ? {
                id: authoritativePlan.id,
                planId: authoritativePlan.planId,
                created: authoritativePlan.created,
              }
            : null,
        };
        await this.completeProvisionReceipt(receipt, result);
        return result;
      };

      if (subscription && product.billingMode === 'SUBSCRIPTION') {
        return await this.subscriptionLifecycle.withCurrentActivePeriod(
          runtimeTenant.id,
          product.id,
          async (current) => finish({
            id: current.periodId,
            planId: current.planId,
            provisionReceiptId: current.provisionReceiptId,
            created: subscription.created && current.periodId === subscription.id,
          }, null),
        );
      }

      if (subscription && this.isUserOnlyProduct(product)) {
        return await this.subscriptionLifecycle.withCurrentActiveCodingPlanEntitlement(
          runtimeTenant.id,
          product.id,
          async (current) => finish({
            id: current.id,
            planId: current.planId,
            provisionReceiptId: current.provisionReceiptId,
            created: subscription.created && current.id === subscription.id,
          }, current.id),
        );
      }

      const existingCodingPlan = product.billingMode === 'CODING_PLAN'
        ? await this.findCurrentCodingPlanEntitlement(
            user.id,
            runtimeTenant.id,
            product.id,
            product.codingPlanFulfillmentMode,
          )
        : null;
      if (
        product.billingMode === 'CODING_PLAN'
        && product.codingPlanFulfillmentMode === 'provider_resale'
        && !existingCodingPlan
      ) {
        throw new ConflictException(
          'provider_resale Coding Plan provision 需要既有 active entitlement',
        );
      }
      const existingSubscription =
        product.billingMode === 'SUBSCRIPTION'
        && input.key
        && Object.prototype.hasOwnProperty.call(input.key, 'allowedModels')
        ? await this.findCurrentSubscriptionPeriod(runtimeTenant.id, product.id)
        : null;
      return await finish(
        existingSubscription
          ? {
              id: existingSubscription.id,
              planId: existingSubscription.planId,
              provisionReceiptId: existingSubscription.provisionReceiptId,
              created: false,
            }
          : existingCodingPlan
            ? {
                id: existingCodingPlan.id,
                planId: existingCodingPlan.planId,
                provisionReceiptId: existingCodingPlan.provisionReceiptId,
                created: false,
              }
            : null,
        existingCodingPlan?.id ?? null,
      );
    } catch (error) {
      primaryError = error;
      try {
        await this.failProvisionReceipt(receipt, error);
      } catch (receiptError) {
        this.logger.error(
          `failed to persist SaaS provision receipt failure receipt=${receipt.id}: `
          + this.errorMessage(receiptError),
        );
      }
      throw error;
    } finally {
      if (tenantLease) {
        try {
          await this.releaseProvisionLease(tenantLease.bindingId, tenantLease.leaseId);
        } catch (releaseError) {
          this.logger.error(
            `failed to release SaaS provision tenant lease binding=${tenantLease.bindingId}: `
            + this.errorMessage(releaseError)
            + (primaryError ? `; primary=${this.errorMessage(primaryError)}` : ''),
          );
        }
      }
    }
  }

  /** Resolve only the product-scoped external id; internal ids are never aliases. */
  async resolveProductUser(
    productId: string,
    externalUserId: string,
  ): Promise<ProductUserBindingResolution> {
    const normalizedProductId = this.requireString(productId, 'productId');
    const normalizedUserId = this.requireString(externalUserId, 'userId');
    const bindings = await this.prisma.productExternalUserBinding.findMany({
      where: {
        productId: normalizedProductId,
        externalUserId: normalizedUserId,
      },
      select: {
        userId: true,
        email: true,
        phone: true,
        nickname: true,
        user: {
          select: {
            isActive: true,
            deletedAt: true,
          },
        },
      },
      take: 2,
    });
    const binding = this.requireSingleUserBinding(bindings);
    if (!binding.user.isActive || binding.user.deletedAt) {
      throw new ForbiddenException('产品绑定用户不可用');
    }
    return {
      userId: binding.userId,
      email: binding.email,
      phone: binding.phone,
      nickname: binding.nickname,
    };
  }

  /** Resolve only the product-scoped external tenant id. */
  async resolveProductTenant(
    productId: string,
    externalTenantId: string,
  ): Promise<ProductTenantBindingResolution> {
    const normalizedProductId = this.requireString(productId, 'productId');
    const normalizedTenantId = this.requireString(externalTenantId, 'tenantId');
    const bindings = await this.prisma.productExternalTenantBinding.findMany({
      where: {
        productId: normalizedProductId,
        externalTenantId: normalizedTenantId,
      },
      select: {
        tenantId: true,
        tenant: {
          select: {
            ownerUserId: true,
            type: true,
            status: true,
            deletedAt: true,
          },
        },
      },
      take: 2,
    });
    const binding = this.requireSingleTenantBinding(bindings);
    if (binding.tenant.status !== 'active' || binding.tenant.deletedAt) {
      throw new ForbiddenException('产品绑定租户不可用');
    }
    return {
      tenantId: binding.tenantId,
      ownerUserId: binding.tenant.ownerUserId,
      type: binding.tenant.type,
    };
  }

  async resolveProductSubject(
    productId: string,
    externalUserId: string,
    externalTenantId?: string | null,
  ): Promise<{ userId: string; tenantId: string | null; email: string | null }> {
    const normalizedProductId = this.requireString(productId, 'productId');
    const user = await this.resolveProductUser(normalizedProductId, externalUserId);
    const normalizedTenantId = this.normalizeNullableString(externalTenantId);
    if (!normalizedTenantId) {
      if (!await this.billingService.isSelfOperatedCodingPlanProduct(normalizedProductId)) {
        throw new BadRequestException(
          'tenantId 对该产品是必填字段；仅自营 Coding Plan 支持 user-only scope',
        );
      }
      const bindings = await this.prisma.productExternalTenantBinding.findMany({
        where: {
          productId: normalizedProductId,
          tenant: {
            ownerUserId: user.userId,
            type: 'personal',
          },
        },
        select: {
          tenantId: true,
          tenant: {
            select: {
              ownerUserId: true,
              status: true,
              deletedAt: true,
            },
          },
        },
        take: 2,
      });
      const tenant = this.requireSingleTenantBinding(bindings);
      if (tenant.tenant.status !== 'active' || tenant.tenant.deletedAt) {
        throw new ForbiddenException('产品绑定租户不可用');
      }
      const membership = await this.prisma.tenantMember.findUnique({
        where: {
          tenantId_userId: {
            tenantId: tenant.tenantId,
            userId: user.userId,
          },
        },
        select: { role: true, status: true },
      });
      if (membership?.role !== 'owner' || membership.status !== 'active') {
        throw new ForbiddenException('产品个人租户 owner 关系不完整');
      }
      return {
        userId: user.userId,
        tenantId: tenant.tenantId,
        email: user.email,
      };
    }

    const tenant = await this.resolveProductTenant(
      normalizedProductId,
      normalizedTenantId,
    );
    if (tenant.type === 'personal' && tenant.ownerUserId !== user.userId) {
      throw new ForbiddenException('产品个人租户只允许 canonical owner 访问');
    }
    const membership = await this.prisma.tenantMember.findUnique({
      where: {
        tenantId_userId: {
          tenantId: tenant.tenantId,
          userId: user.userId,
        },
      },
      select: { role: true, status: true },
    });
    if (
      membership?.status !== 'active'
      || (membership.role !== 'owner' && membership.role !== 'member')
    ) {
      throw new ForbiddenException('产品用户与租户绑定不匹配');
    }
    if (
      await this.billingService.isSelfOperatedCodingPlanProduct(
        normalizedProductId,
      )
    ) {
      const personalBindings =
        await this.prisma.productExternalTenantBinding.findMany({
          where: {
            productId: normalizedProductId,
            tenant: {
              ownerUserId: user.userId,
              type: 'personal',
            },
          },
          select: {
            tenantId: true,
            tenant: {
              select: {
                ownerUserId: true,
                status: true,
                deletedAt: true,
              },
            },
          },
          take: 2,
        });
      const personal = this.requireSingleTenantBinding(personalBindings);
      if (personal.tenant.status !== 'active' || personal.tenant.deletedAt) {
        throw new ForbiddenException('产品绑定个人租户不可用');
      }
      const personalMembership = await this.prisma.tenantMember.findUnique({
        where: {
          tenantId_userId: {
            tenantId: personal.tenantId,
            userId: user.userId,
          },
        },
        select: { role: true, status: true },
      });
      if (
        personalMembership?.role !== 'owner'
        || personalMembership.status !== 'active'
      ) {
        throw new ForbiddenException('产品个人租户 owner 关系不完整');
      }
      return {
        userId: user.userId,
        tenantId: personal.tenantId,
        email: user.email,
      };
    }
    return {
      userId: user.userId,
      tenantId: tenant.tenantId,
      email: user.email,
    };
  }

  private async resolveProduct(productId?: string | null, productSlug?: string | null) {
    const id = this.normalizeNullableString(productId);
    const slug = this.normalizeNullableString(productSlug)
      ?? this.normalizeNullableString(this.config.get<string>('SAAS_DEFAULT_PRODUCT_SLUG'))
      ?? this.normalizeNullableString(this.config.get<string>('BILLING_DEFAULT_PRODUCT_SLUG'));
    if (!id && !slug) {
      throw new BadRequestException('productId 或 productSlug 是必填字段');
    }
    const product = id
      ? await this.prisma.product.findFirst({ where: { id, isActive: true, deletedAt: null } })
      : await this.prisma.product.findFirst({
          where: { slug: { equals: slug!, mode: 'insensitive' }, isActive: true, deletedAt: null },
        });
    if (!product) {
      throw new BadRequestException(`产品不存在或未启用: ${id ?? slug}`);
    }
    if (slug && product.slug.toLowerCase() !== slug.toLowerCase()) {
      throw new BadRequestException('productId 与 productSlug 不匹配');
    }
    return product;
  }

  private async ensureBoundUser(
    db: ProvisionDb,
    productId: string,
    externalUserId: string,
    snapshot?: SaasProvisionUser | null,
  ): Promise<{ id: string; bindingId: string }> {
    const bindings = await db.productExternalUserBinding.findMany({
      where: {
        productId,
        externalUserId,
      },
      select: {
        id: true,
        userId: true,
        snapshotWritable: true,
        email: true,
        phone: true,
        nickname: true,
        sourceUpdatedAt: true,
        user: {
          select: {
            isActive: true,
            deletedAt: true,
            email: true,
            phone: true,
            nickname: true,
            sourceUpdatedAt: true,
          },
        },
      },
      take: 2,
    });
    if (bindings.length > 1 && new Set(bindings.map((binding) => binding.userId)).size > 1) {
      throw new ConflictException('产品用户绑定冲突');
    }
    const existing = bindings[0];
    if (existing) {
      if (!existing.user.isActive || existing.user.deletedAt) {
        throw new ConflictException('产品用户绑定指向不可用用户');
      }
      if (existing.snapshotWritable) {
        const profileChanged = this.productUserSnapshotChanged(existing, snapshot);
        this.assertPartnerSnapshotFreshForChanges(
          existing.sourceUpdatedAt,
          snapshot,
          profileChanged,
        );
        const mirrored = await this.userMirror.mirrorUser(
          this.partnerMirrorSnapshot(existing.userId, snapshot),
          db,
        );
        if (profileChanged && mirrored.skippedStale) {
          throw new ConflictException(
            'Partner 用户资料版本过旧，未执行更新',
          );
        }
        if (
          snapshot
          && (
            Object.prototype.hasOwnProperty.call(snapshot, 'email')
            || Object.prototype.hasOwnProperty.call(snapshot, 'phone')
            || Object.prototype.hasOwnProperty.call(snapshot, 'nickname')
            || Object.prototype.hasOwnProperty.call(snapshot, 'sourceUpdatedAt')
          )
        ) {
          const sourceUpdatedAt = this.parsePartnerSourceUpdatedAt(
            snapshot.sourceUpdatedAt,
          );
          await db.productExternalUserBinding.update({
            where: { id: existing.id },
            data: {
              ...(Object.prototype.hasOwnProperty.call(snapshot, 'email')
                ? { email: this.normalizeNullableString(snapshot.email) }
                : {}),
              ...(Object.prototype.hasOwnProperty.call(snapshot, 'phone')
                ? { phone: this.normalizeNullableString(snapshot.phone) }
                : {}),
              ...(Object.prototype.hasOwnProperty.call(snapshot, 'nickname')
                ? { nickname: this.normalizeNullableString(snapshot.nickname) }
                : {}),
              ...(sourceUpdatedAt ? { sourceUpdatedAt } : {}),
            },
          });
        }
      } else {
        this.assertReadOnlyUserSnapshotUnchanged(existing.user, snapshot);
      }
      return { id: existing.userId, bindingId: existing.id };
    }

    this.assertIdentityV2WritesEnabled();
    const userId = randomUUID();
    await this.userMirror.mirrorUser(this.partnerMirrorSnapshot(userId, snapshot), db);
    const binding = await db.productExternalUserBinding.create({
      data: {
        productId,
        externalUserId,
        userId,
        snapshotWritable: true,
        email: this.normalizeNullableString(snapshot?.email),
        phone: this.normalizeNullableString(snapshot?.phone),
        nickname: this.normalizeNullableString(snapshot?.nickname),
        sourceUpdatedAt: this.parsePartnerSourceUpdatedAt(snapshot?.sourceUpdatedAt),
      },
      select: { id: true },
    });
    return { id: userId, bindingId: binding.id };
  }

  private async ensureBoundTenant(
    db: ProvisionDb,
    productId: string,
    userBindingId: string,
    userId: string,
    snapshot?: SaasProvisionTenant | null,
  ): Promise<{ id: string; bindingId: string }> {
    const requestedTenantId = this.normalizeNullableString(snapshot?.id);
    const bindings = requestedTenantId
      ? await db.productExternalTenantBinding.findMany({
          where: {
            productId,
            externalTenantId: requestedTenantId,
          },
          select: {
            id: true,
            tenantId: true,
            snapshotWritable: true,
            tenant: {
              select: {
                ownerUserId: true,
                name: true,
                type: true,
                status: true,
                deletedAt: true,
              },
            },
          },
          take: 2,
        })
      : await db.productExternalTenantBinding.findMany({
          where: {
            productId,
            tenant: {
              ownerUserId: userId,
              type: 'personal',
            },
          },
          select: {
            id: true,
            tenantId: true,
            snapshotWritable: true,
            tenant: {
              select: {
                ownerUserId: true,
                name: true,
                type: true,
                status: true,
                deletedAt: true,
              },
            },
          },
          take: 2,
        });
    if (bindings.length > 1 && new Set(bindings.map((binding) => binding.tenantId)).size > 1) {
      throw new ConflictException('产品租户绑定冲突');
    }
    const existing = bindings[0];
    if (existing) {
      if (
        existing.tenant.ownerUserId !== userId
        && (!requestedTenantId || existing.tenant.type === 'personal')
      ) {
        throw new ConflictException('产品租户绑定的 owner 不匹配');
      }
      if (existing.tenant.status !== 'active' || existing.tenant.deletedAt) {
        throw new ConflictException('产品租户绑定指向不可用租户');
      }
      const requestedType = this.normalizeNullableString(snapshot?.type);
      if (requestedType && requestedType !== existing.tenant.type) {
        throw new ConflictException('tenant.type 与既有产品租户绑定不匹配');
      }
      const hasRequestedName = Boolean(
        snapshot
        && Object.prototype.hasOwnProperty.call(snapshot, 'name')
        && snapshot.name !== undefined
        && snapshot.name !== null,
      );
      const requestedName = hasRequestedName
        ? this.normalizeNullableString(snapshot?.name)
        : null;
      if (hasRequestedName && !requestedName) {
        throw new BadRequestException('tenant.name 不能为空');
      }
      if (!existing.snapshotWritable) {
        if (requestedName && requestedName !== existing.tenant.name) {
          throw new ConflictException(
            '历史共享租户绑定不允许由 Partner provision 修改资料',
          );
        }
      } else if (requestedName && requestedName !== existing.tenant.name) {
        await db.tenant.update({
          where: { id: existing.tenantId },
          data: {
            name: requestedName,
            mirroredAt: new Date(),
          },
        });
      }
      const role = existing.tenant.ownerUserId === userId ? 'owner' : 'member';
      if (role === 'member' && !this.identityV2WritesEnabled()) {
        const currentMembership = await db.tenantMember.findUnique({
          where: {
            tenantId_userId: {
              tenantId: existing.tenantId,
              userId,
            },
          },
          select: { role: true, status: true },
        });
        if (
          !currentMembership
          || currentMembership.role !== 'member'
          || currentMembership.status !== 'active'
        ) {
          throw new ServiceUnavailableException(
            'Partner identity V2 写入尚未启用，不能迁移团队成员关系',
          );
        }
      }
      await db.tenantMember.upsert({
        where: { tenantId_userId: { tenantId: existing.tenantId, userId } },
        create: {
          tenantId: existing.tenantId,
          userId,
          role,
          status: 'active',
        },
        update: {
          role,
          status: 'active',
        },
      });
      return { id: existing.tenantId, bindingId: existing.id };
    }

    this.assertIdentityV2WritesEnabled();
    const tenantId = randomUUID();
    const type = this.normalizeTenantType(snapshot?.type);
    const tenant = await db.tenant.create({
      data: {
        id: tenantId,
        name: this.normalizeNullableString(snapshot?.name)
          ?? `SaaS Tenant ${tenantId.slice(0, 8)}`,
        type,
        status: 'active',
        ownerUserId: userId,
        mirroredAt: new Date(),
      },
      select: { id: true },
    });
    await db.tenantMember.create({
      data: {
        tenantId: tenant.id,
        userId,
        role: 'owner',
        status: 'active',
      },
    });
    const binding = await db.productExternalTenantBinding.create({
      data: {
        productId,
        bindingKey: requestedTenantId
          ? `external:${requestedTenantId}`
          : `personal:${userBindingId}`,
        externalTenantId: requestedTenantId,
        tenantId: tenant.id,
        snapshotWritable: true,
      },
      select: { id: true },
    });
    return { id: tenant.id, bindingId: binding.id };
  }

  private async ensureTenantBillingAccount(
    userId: string,
    tenantId: string,
  ): Promise<{ billingAccountId: string }> {
    return this.billingService.resolveSubjectForUser(userId, tenantId);
  }

  private async acquireProvisionLease(bindingId: string): Promise<string> {
    const leaseId = randomUUID();
    const now = new Date();
    const acquired = await this.prisma.productExternalTenantBinding.updateMany({
      where: {
        id: bindingId,
        OR: [
          { provisioningLeaseId: null },
          { provisioningLeaseExpiresAt: null },
          { provisioningLeaseExpiresAt: { lte: now } },
        ],
      },
      data: {
        provisioningLeaseId: leaseId,
        provisioningLeaseExpiresAt: new Date(now.getTime() + PROVISION_LEASE_MS),
      },
    });
    if (acquired.count !== 1) {
      throw new ConflictException('该产品租户正在执行 provision，请稍后重试');
    }
    return leaseId;
  }

  private async renewProvisionLease(bindingId: string, leaseId: string): Promise<void> {
    const renewed = await this.prisma.productExternalTenantBinding.updateMany({
      where: {
        id: bindingId,
        provisioningLeaseId: leaseId,
      },
      data: {
        provisioningLeaseExpiresAt: new Date(Date.now() + PROVISION_LEASE_MS),
      },
    });
    if (renewed.count !== 1) {
      throw new ConflictException('Provision lease 已失效，请重试');
    }
  }

  private async releaseProvisionLease(bindingId: string, leaseId: string): Promise<void> {
    await this.prisma.productExternalTenantBinding.updateMany({
      where: {
        id: bindingId,
        provisioningLeaseId: leaseId,
      },
      data: {
        provisioningLeaseId: null,
        provisioningLeaseExpiresAt: null,
      },
    });
  }

  private requireProvisionIdempotencyKey(value: unknown): string {
    const key = this.requireString(value, 'idempotencyKey');
    if (
      key.length < 8
      || key.length > 128
      || !PROVISION_IDEMPOTENCY_KEY_PATTERN.test(key)
    ) {
      throw new BadRequestException(
        'idempotencyKey 长度必须为 8-128，且仅包含字母、数字、点、下划线、冒号或连字符',
      );
    }
    return key;
  }

  private provisionRequestFingerprint(
    productId: string,
    input: SaasProvisionRequest,
    ensureFreePlan: boolean,
  ): string {
    const sourceUpdatedAt = input.user?.sourceUpdatedAt
      ? new Date(input.user.sourceUpdatedAt).toISOString()
      : null;
    const allowedModels = this.serializeAllowedModels(input.key?.allowedModels);
    const normalized = {
      productId,
      user: {
        id: this.requireString(input.user?.id, 'user.id'),
        email: this.normalizeNullableString(input.user?.email),
        phone: this.normalizeNullableString(input.user?.phone),
        nickname: this.normalizeNullableString(input.user?.nickname),
        sourceUpdatedAt,
      },
      tenant: {
        id: this.normalizeNullableString(input.tenant?.id),
        name: this.normalizeNullableString(input.tenant?.name),
        type: this.normalizeTenantType(input.tenant?.type),
      },
      key: {
        name: this.normalizeNullableString(input.key?.name),
        allowedModels: allowedModels ? JSON.parse(allowedModels) : null,
        budgetCents: input.key?.budgetCents ?? null,
        rotate: input.key?.rotate === true,
      },
      ensureFreePlan,
    };
    return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  }

  private async beginProvisionReceipt(
    productId: string,
    idempotencyKey: string,
    requestFingerprint: string,
  ): Promise<ProvisionReceiptLease> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockProvisionIdentity(
        tx,
        `receipt:${productId}:${idempotencyKey}`,
      );
      const existing = await tx.saasProvisionReceipt.findUnique({
        where: {
          productId_idempotencyKey: {
            productId,
            idempotencyKey,
          },
        },
        select: {
          id: true,
          requestFingerprint: true,
          status: true,
          result: true,
          leaseExpiresAt: true,
        },
      });
      if (existing?.requestFingerprint !== undefined
        && existing.requestFingerprint !== requestFingerprint) {
        throw new ConflictException(
          'idempotencyKey 已用于不同的 provision 请求',
        );
      }
      if (existing?.status === 'SUCCEEDED') {
        if (!existing.result) {
          throw new ConflictException('Provision 幂等回执缺少结果');
        }
        return {
          id: existing.id,
          leaseId: '',
          replayResult: existing.result,
        };
      }

      const now = new Date();
      if (
        existing?.status === 'PENDING'
        && existing.leaseExpiresAt
        && existing.leaseExpiresAt.getTime() > now.getTime()
      ) {
        throw new ConflictException('该幂等 provision 请求正在执行，请稍后重试');
      }
      const leaseId = randomUUID();
      const leaseExpiresAt = new Date(now.getTime() + PROVISION_LEASE_MS);
      if (existing) {
        await tx.saasProvisionReceipt.update({
          where: { id: existing.id },
          data: {
            status: 'PENDING',
            leaseId,
            leaseExpiresAt,
            lastError: null,
          },
        });
        return { id: existing.id, leaseId, replayResult: null };
      }

      const created = await tx.saasProvisionReceipt.create({
        data: {
          productId,
          idempotencyKey,
          requestFingerprint,
          status: 'PENDING',
          leaseId,
          leaseExpiresAt,
        },
        select: { id: true },
      });
      return { id: created.id, leaseId, replayResult: null };
    }, {
      maxWait: 10_000,
      timeout: 30_000,
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  }

  private async renewProvisionReceipt(receipt: ProvisionReceiptLease): Promise<void> {
    const renewed = await this.prisma.saasProvisionReceipt.updateMany({
      where: {
        id: receipt.id,
        status: 'PENDING',
        leaseId: receipt.leaseId,
      },
      data: {
        leaseExpiresAt: new Date(Date.now() + PROVISION_LEASE_MS),
      },
    });
    if (renewed.count !== 1) {
      throw new ConflictException('Provision 幂等回执 lease 已失效，请重试');
    }
  }

  private async completeProvisionReceipt(
    receipt: ProvisionReceiptLease,
    result: SaasProvisionResult,
  ): Promise<void> {
    const persistedResult: Prisma.InputJsonObject = {
      userId: result.userId,
      tenantId: result.tenantId,
      productId: result.productId,
      productSlug: result.productSlug,
      apiKey: {
        id: result.apiKey.id,
        prefix: result.apiKey.prefix,
        plainKey: null,
        plainKeyRecoverable: result.apiKey.plainKey !== null,
        created: result.apiKey.created,
        rotated: result.apiKey.rotated,
      },
      subscription: result.subscription
        ? {
            id: result.subscription.id,
            planId: result.subscription.planId,
            created: result.subscription.created,
          }
        : null,
    };
    const now = new Date();
    const completed = await this.prisma.saasProvisionReceipt.updateMany({
      where: {
        id: receipt.id,
        status: 'PENDING',
        leaseId: receipt.leaseId,
      },
      data: {
        status: 'SUCCEEDED',
        result: persistedResult,
        leaseId: null,
        leaseExpiresAt: null,
        lastError: null,
        completedAt: now,
      },
    });
    if (completed.count !== 1) {
      throw new ConflictException('Provision 幂等回执完成状态冲突');
    }
  }

  private async failProvisionReceipt(
    receipt: ProvisionReceiptLease,
    error: unknown,
  ): Promise<void> {
    if (!receipt.leaseId) return;
    await this.prisma.saasProvisionReceipt.updateMany({
      where: {
        id: receipt.id,
        status: 'PENDING',
        leaseId: receipt.leaseId,
      },
      data: {
        status: 'FAILED',
        leaseId: null,
        leaseExpiresAt: null,
        lastError: this.errorMessage(error).slice(0, 2000),
      },
    });
  }

  private async hydrateProvisionReceiptResult(
    value: Prisma.JsonValue,
  ): Promise<SaasProvisionResult> {
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      throw new ConflictException('Provision 幂等回执结果格式无效');
    }
    const result = value as Record<string, unknown>;
    const storedApiKey = result.apiKey;
    if (
      !storedApiKey
      || Array.isArray(storedApiKey)
      || typeof storedApiKey !== 'object'
    ) {
      throw new ConflictException('Provision 幂等回执缺少 API Key 结果');
    }
    const apiKeyResult = storedApiKey as Record<string, unknown>;
    const apiKeyId = this.requireReceiptString(apiKeyResult.id, 'apiKey.id');
    const key = await this.prisma.apiKey.findUnique({
      where: { id: apiKeyId },
      select: {
        managedBy: true,
        prefix: true,
        provisionSecretEncrypted: true,
        provisionSecretExpiresAt: true,
      },
    });
    if (key && key.managedBy !== SAAS_PROVISION_MANAGED_BY) {
      throw new ConflictException('Provision 幂等回执 API Key 归属冲突');
    }
    const secretRecoveryAllowed = apiKeyResult.plainKeyRecoverable === true;
    const expiredSecret = key ? this.provisionSecretExpired(key) : false;
    const plainKey = key && secretRecoveryAllowed
      ? this.recoverProvisionSecret(key)
      : null;
    if (key && expiredSecret) {
      await this.prisma.apiKey.updateMany({
        where: {
          id: apiKeyId,
          managedBy: SAAS_PROVISION_MANAGED_BY,
        },
        data: {
          provisionSecretEncrypted: null,
          provisionSecretExpiresAt: null,
        },
      });
    }
    const subscription = result.subscription;
    const parsedSubscription = subscription === null
      ? null
      : this.parseReceiptSubscription(subscription);
    return {
      userId: this.requireReceiptString(result.userId, 'userId'),
      tenantId: this.requireReceiptString(result.tenantId, 'tenantId'),
      productId: this.requireReceiptString(result.productId, 'productId'),
      productSlug: this.requireReceiptString(result.productSlug, 'productSlug'),
      apiKey: {
        id: apiKeyId,
        prefix: key?.prefix
          ?? this.requireReceiptString(apiKeyResult.prefix, 'apiKey.prefix'),
        plainKey,
        created: apiKeyResult.created === true,
        rotated: apiKeyResult.rotated === true,
      },
      subscription: parsedSubscription,
    };
  }

  private parseReceiptSubscription(value: unknown): {
    id: string;
    planId: string;
    created: boolean;
  } {
    if (!value || Array.isArray(value) || typeof value !== 'object') {
      throw new ConflictException('Provision 幂等回执订阅结果格式无效');
    }
    const subscription = value as Record<string, unknown>;
    return {
      id: this.requireReceiptString(subscription.id, 'subscription.id'),
      planId: this.requireReceiptString(subscription.planId, 'subscription.planId'),
      created: subscription.created === true,
    };
  }

  private requireReceiptString(value: unknown, field: string): string {
    if (typeof value !== 'string' || !value) {
      throw new ConflictException(`Provision 幂等回执缺少 ${field}`);
    }
    return value;
  }

  private async renewProvisionLeases(
    tenantLease: { bindingId: string; leaseId: string },
    receipt: ProvisionReceiptLease,
  ): Promise<void> {
    await this.renewProvisionLease(tenantLease.bindingId, tenantLease.leaseId);
    await this.renewProvisionReceipt(receipt);
  }

  private async ensureDefaultPlan(
    userId: string,
    tenantId: string,
    productId: string,
    provisionReceiptId: string,
    billingAccountId: string,
  ) {
    const owned = await this.prisma.subscriptionPeriod.findUnique({
      where: { provisionReceiptId },
      select: {
        id: true,
        planId: true,
        status: true,
        expiresAt: true,
        plan: {
          select: {
            id: true,
            monthlyCredits: true,
          },
        },
      },
    });
    if (owned) {
      return {
        id: owned.id,
        planId: owned.planId,
        provisionReceiptId,
        created: false,
      };
    }

    const plan = await this.findDefaultPlan(productId);
    const startedAt = new Date();
    const ensured = await this.subscriptionLifecycle.activateIfAbsent({
      userId,
      tenantId,
      billingAccountId,
      productId,
      planId: plan.id,
      billingPeriod: 'monthly',
      startedAt,
      expiresAt: plan.validityDays > 0
        ? new Date(startedAt.getTime() + plan.validityDays * 24 * 60 * 60 * 1000)
        : null,
      provisionReceiptId,
    });

    return {
      id: ensured.periodId,
      planId: ensured.planId,
      provisionReceiptId: ensured.provisionReceiptId,
      created: ensured.created,
    };
  }

  private async ensureDefaultCodingPlan(
    userId: string,
    tenantId: string,
    productId: string,
    provisionReceiptId: string,
  ): Promise<ProvisionedPlan> {
    const owned = await this.prisma.codingPlanEntitlement.findUnique({
      where: { provisionReceiptId },
      select: {
        id: true,
        planId: true,
        provisionReceiptId: true,
      },
    });
    if (owned) {
      return {
        id: owned.id,
        planId: owned.planId,
        provisionReceiptId: owned.provisionReceiptId,
        created: false,
      };
    }
    const plan = await this.findDefaultPlan(productId);
    const startedAt = new Date();
    const ensured = await this.subscriptionLifecycle.activateCodingPlanIfAbsent({
      userId,
      tenantId,
      productId,
      planId: plan.id,
      startedAt,
      expiresAt: plan.validityDays > 0
        ? new Date(startedAt.getTime() + plan.validityDays * 24 * 60 * 60 * 1000)
        : null,
      provisionReceiptId,
    });
    return {
      id: ensured.id,
      planId: ensured.planId,
      provisionReceiptId: ensured.provisionReceiptId,
      created: ensured.created,
    };
  }

  private async findCurrentSubscriptionPeriod(tenantId: string, productId: string) {
    return this.prisma.subscriptionPeriod.findFirst({
      where: {
        tenantId,
        productId,
        status: 'ACTIVE',
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: {
        id: true,
        planId: true,
        provisionReceiptId: true,
      },
      orderBy: [{ startedAt: 'desc' }, { createdAt: 'desc' }],
    });
  }

  private async findCurrentCodingPlanEntitlement(
    userId: string,
    tenantId: string,
    productId: string,
    fulfillmentMode: 'platform_model_package' | 'provider_resale' | null,
  ) {
    return this.prisma.codingPlanEntitlement.findFirst({
      where: {
        userId,
        tenantId,
        productId,
        ...(fulfillmentMode ? { fulfillmentMode } : {}),
        status: 'ACTIVE',
        OR: [{ expiresAt: null }, { expiresAt: { gt: new Date() } }],
      },
      select: {
        id: true,
        planId: true,
        provisionReceiptId: true,
      },
      orderBy: [{ startedAt: 'desc' }, { createdAt: 'desc' }],
    });
  }

  private async grantProvisionQuota(
    subscriptionId: string,
    userId: string,
    plan: { id: string; monthlyCredits: number },
  ): Promise<void> {
    if (plan.monthlyCredits > 0) {
      await this.creditService.grantQuota(
        subscriptionId,
        userId,
        plan.monthlyCredits,
        `plan:${plan.id}`,
        { idempotencyKey: `saas_provision:${subscriptionId}` },
      );
    }
  }

  private async requireProvisionPlan(planId: string, productId: string) {
    const plan = await this.prisma.plan.findFirst({
      where: {
        id: planId,
        productId,
        deletedAt: null,
      },
      select: {
        id: true,
        monthlyCredits: true,
        validityDays: true,
      },
    });
    if (!plan) {
      throw new ConflictException('Provision 订阅套餐不存在');
    }
    return plan;
  }

  private async findDefaultPlan(productId: string) {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: { defaultPlanId: true },
    });
    if (product?.defaultPlanId) {
      const configured = await this.prisma.plan.findFirst({
        where: {
          id: product.defaultPlanId,
          productId,
          isActive: true,
          deletedAt: null,
          monthlyPrice: 0,
          quarterlyPrice: 0,
          yearlyPrice: 0,
          prices: {
            none: {
              isActive: true,
              OR: [
                { monthlyPrice: { gt: 0 } },
                { quarterlyPrice: { gt: 0 } },
                { yearlyPrice: { gt: 0 } },
              ],
            },
          },
        },
        select: { id: true, name: true, monthlyCredits: true, validityDays: true },
      });
      if (!configured) {
        throw new BadRequestException(
          '产品配置的 SaaS 默认套餐不存在、未启用或不是免费套餐',
        );
      }
      return configured;
    }

    const plan = await this.prisma.plan.findFirst({
      where: {
        productId,
        isActive: true,
        deletedAt: null,
        monthlyPrice: 0,
        quarterlyPrice: 0,
        yearlyPrice: 0,
        prices: {
          none: {
            isActive: true,
            OR: [
              { monthlyPrice: { gt: 0 } },
              { quarterlyPrice: { gt: 0 } },
              { yearlyPrice: { gt: 0 } },
            ],
          },
        },
      },
      orderBy: [{ monthlyPrice: 'asc' }, { sortOrder: 'asc' }],
      select: { id: true, name: true, monthlyCredits: true, validityDays: true },
    });
    if (!plan) {
      throw new BadRequestException('产品未配置可用于 SaaS 自动开通的免费套餐');
    }
    return plan;
  }

  private async ensureTenantProductEntitlement(
    tenantId: string,
    productId: string,
    planId: string | null,
  ): Promise<void> {
    await this.prisma.tenantProductEntitlement.upsert({
      where: { tenantId_productId: { tenantId, productId } },
      create: {
        tenantId,
        productId,
        planId,
        status: 'active',
        source: 'saas_provision',
      },
      update: {
        ...(planId ? { planId } : {}),
        status: 'active',
        source: 'saas_provision',
        expiresAt: null,
      },
    });
  }

  private async ensureVirtualApiKey(
    userId: string,
    tenantId: string,
    productId: string,
    productSlug: string,
    keyOptions?: SaasProvisionKey | null,
    receipt?: ProvisionReceiptLease,
    codingPlanEntitlementId: string | null = null,
  ): Promise<ProvisionedApiKey> {
    const name = `saas:${productSlug}:virtual`;
    const requestedName = this.normalizeNullableString(keyOptions?.name);
    if (requestedName && requestedName !== name) {
      throw new BadRequestException(`key.name 仅支持固定值 ${name}`);
    }
    const rotate = keyOptions?.rotate === true;
    const allowedModelsSpecified = Boolean(
      keyOptions
      && Object.prototype.hasOwnProperty.call(keyOptions, 'allowedModels'),
    );
    const budgetSpecified = Boolean(
      keyOptions
      && Object.prototype.hasOwnProperty.call(keyOptions, 'budgetCents'),
    );
    const prepared = await this.prepareVirtualApiKey({
      userId,
      tenantId,
      productId,
      codingPlanEntitlementId,
      name,
      rotate,
      allowedModels: this.serializeAllowedModels(keyOptions?.allowedModels),
      budgetUsd: this.toBudgetUsd(keyOptions?.budgetCents),
      allowedModelsSpecified,
      budgetSpecified,
    }, receipt);

    try {
      await this.publisherSync.syncApiKeyActivationRequired(prepared.id);
      if (prepared.predecessor) {
        await this.publisherSync.revokeApiKeyRequired(prepared.predecessor);
      }
      await this.finalizeVirtualApiKey(prepared);
    } catch (error) {
      const message = this.errorMessage(error);
      await this.prisma.apiKey.updateMany({
        where: {
          id: prepared.id,
          managedBy: SAAS_PROVISION_MANAGED_BY,
          deletedAt: null,
        },
        data: {
          mirrorError: message.slice(0, 2000),
        },
      }).catch((updateError) => {
        this.logger.error(
          `failed to persist SaaS API key sync error key=${prepared.id}: ${this.errorMessage(updateError)}`,
        );
      });
      throw error;
    }

    return {
      id: prepared.id,
      prefix: prepared.prefix,
      plainKey: prepared.plainKey,
      created: prepared.created,
      rotated: prepared.rotated,
    };
  }

  private async prepareVirtualApiKey(input: {
    userId: string;
    tenantId: string;
    productId: string;
    codingPlanEntitlementId: string | null;
    name: string;
    rotate: boolean;
    allowedModels: string | null;
    budgetUsd: Prisma.Decimal | null;
    allowedModelsSpecified: boolean;
    budgetSpecified: boolean;
  }, receipt?: ProvisionReceiptLease): Promise<PreparedApiKey> {
    return this.prisma.$transaction(async (tx) => {
      await this.lockProvisionIdentity(
        tx,
        `api-key:${input.userId}:${input.tenantId}:${input.productId}:${input.name}`,
      );
      if (receipt) {
        const remembered = await this.loadRememberedProvisionApiKey(tx, receipt);
        if (remembered) {
          await tx.apiKey.update({
            where: { id: remembered.id },
            data: { codingPlanEntitlementId: input.codingPlanEntitlementId },
          });
          return remembered;
        }
      }
      const keys = await tx.apiKey.findMany({
        where: {
          userId: input.userId,
          tenantId: input.tenantId,
          productId: input.productId,
          name: input.name,
          deletedAt: null,
        },
        orderBy: { createdAt: 'desc' },
        select: {
          id: true,
          prefix: true,
          keyHash: true,
          isActive: true,
          mirrorStatus: true,
          activatedAt: true,
          provisionSecretEncrypted: true,
          provisionSecretExpiresAt: true,
          rotationPredecessorId: true,
          managedBy: true,
          allowedModels: true,
          budgetUsd: true,
          codingPlanEntitlementId: true,
        },
      });
      if (keys.some((key) => key.managedBy !== SAAS_PROVISION_MANAGED_BY)) {
        throw new ConflictException(
          '同名 API Key 不属于 SaaS provision，拒绝接管或创建重复 active Key',
        );
      }
      const activeKeys = keys.filter((key) => key.isActive);
      if (activeKeys.length > 1) {
        throw new ConflictException('SaaS API Key 存在多个 active 记录，请先修复数据');
      }
      const pendingKeys = keys.filter(
        (key) => !key.isActive && key.mirrorStatus === 'PROVISIONING',
      );
      if (pendingKeys.length > 1) {
        throw new ConflictException('SaaS API Key 存在多个 provisioning 记录，请先修复数据');
      }
      const pending = pendingKeys[0];
      if (pending) {
        if (receipt) {
          throw new ConflictException(
            '存在属于其他幂等请求的未完成 SaaS API Key；请使用原 idempotencyKey 重试',
          );
        }
        const predecessor = pending.rotationPredecessorId
          ? keys.find((key) => key.id === pending.rotationPredecessorId)
          : null;
        if (pending.rotationPredecessorId && !predecessor) {
          throw new ConflictException('SaaS API Key 轮换前驱记录缺失');
        }
        const secretExpired = this.provisionSecretExpired(pending);
        const prepared: PreparedApiKey = {
          id: pending.id,
          prefix: pending.prefix,
          plainKey: this.recoverProvisionSecret(pending),
          created: false,
          rotated: Boolean(predecessor),
          predecessor: predecessor
            ? { id: predecessor.id, keyHash: predecessor.keyHash }
            : null,
        };
        await tx.apiKey.update({
          where: { id: pending.id },
          data: {
            codingPlanEntitlementId: input.codingPlanEntitlementId,
            ...(secretExpired
              ? {
              provisionSecretEncrypted: null,
              provisionSecretExpiresAt: null,
                }
              : {}),
          },
        });
        await this.rememberProvisionApiKey(tx, receipt, prepared);
        return prepared;
      }
      const active = activeKeys[0];
      if (active) {
        const currentAllowedModels = this.canonicalizeStoredAllowedModels(
          active.allowedModels,
        );
        const allowedModelsChanged = input.allowedModelsSpecified
          && input.allowedModels !== currentAllowedModels;
        const budgetChanged = input.budgetSpecified
          && !this.sameDecimal(input.budgetUsd, active.budgetUsd);
        if (!input.rotate && (allowedModelsChanged || budgetChanged)) {
          throw new ConflictException(
            'SaaS API Key 配置变化需要显式设置 rotate=true',
          );
        }
        const secretExpired = this.provisionSecretExpired(active);
        // The ciphertext belongs to the idempotent operation that originally
        // created or rotated the key. A different receipt may reuse the key
        // identity, but it is never allowed to recover that operation's
        // plaintext secret.
        const plainKey = receipt ? null : this.recoverProvisionSecret(active);
        const predecessor = active.rotationPredecessorId
          ? keys.find((key) => key.id === active.rotationPredecessorId)
          : null;
        if (active.rotationPredecessorId && !predecessor) {
          throw new ConflictException('SaaS API Key 轮换前驱记录缺失');
        }

        // A recoverable secret means the prior HTTP response may have been
        // lost. Coalesce retries during the short recovery window instead of
        // rotating again and losing the only returnable secret.
        if (!input.rotate || predecessor) {
          await tx.apiKey.update({
            where: { id: active.id },
            data: {
              isActive: true,
              mirrorStatus: 'ACTIVE',
              mirrorError: null,
              managedBy: SAAS_PROVISION_MANAGED_BY,
              codingPlanEntitlementId: input.codingPlanEntitlementId,
              activatedAt: active.activatedAt ?? new Date(),
              ...(secretExpired
                ? {
                    provisionSecretEncrypted: null,
                    provisionSecretExpiresAt: null,
                  }
                : {}),
            },
          });
          const prepared = {
            id: active.id,
            prefix: active.prefix,
            plainKey,
            created: false,
            rotated: Boolean(predecessor),
            predecessor: predecessor
              ? { id: predecessor.id, keyHash: predecessor.keyHash }
              : null,
          };
          await this.rememberProvisionApiKey(tx, receipt, prepared);
          return prepared;
        }

        const replacement = this.newProvisionKeyMaterial();
        const replacementAllowedModels = input.allowedModelsSpecified
          ? input.allowedModels
          : currentAllowedModels;
        const replacementBudgetUsd = input.budgetSpecified
          ? input.budgetUsd
          : active.budgetUsd;
        await tx.apiKey.create({
          data: {
            id: replacement.id,
            userId: input.userId,
            tenantId: input.tenantId,
            productId: input.productId,
            codingPlanEntitlementId: input.codingPlanEntitlementId,
            name: input.name,
            prefix: replacement.prefix,
            keyHash: replacement.keyHash,
            allowedModels: replacementAllowedModels,
            budgetUsd: replacementBudgetUsd,
            isActive: false,
            mirrorStatus: 'PROVISIONING',
            mirrorError: null,
            managedBy: SAAS_PROVISION_MANAGED_BY,
            provisionSecretEncrypted: replacement.encryptedSecret,
            provisionSecretExpiresAt: replacement.secretExpiresAt,
            rotationPredecessorId: active.id,
          },
        });
        const prepared = {
          id: replacement.id,
          prefix: replacement.prefix,
          plainKey: replacement.plainKey,
          created: true,
          rotated: true,
          predecessor: { id: active.id, keyHash: active.keyHash },
        };
        await this.rememberProvisionApiKey(tx, receipt, prepared);
        return prepared;
      }

      const key = this.newProvisionKeyMaterial();
      await tx.apiKey.create({
        data: {
          id: key.id,
          userId: input.userId,
          tenantId: input.tenantId,
          productId: input.productId,
          codingPlanEntitlementId: input.codingPlanEntitlementId,
          name: input.name,
          prefix: key.prefix,
          keyHash: key.keyHash,
          allowedModels: input.allowedModels,
          budgetUsd: input.budgetUsd,
          isActive: false,
          mirrorStatus: 'PROVISIONING',
          mirrorError: null,
          managedBy: SAAS_PROVISION_MANAGED_BY,
          provisionSecretEncrypted: key.encryptedSecret,
          provisionSecretExpiresAt: key.secretExpiresAt,
          activatedAt: null,
        },
      });
      const prepared = {
        id: key.id,
        prefix: key.prefix,
        plainKey: key.plainKey,
        created: true,
        rotated: false,
        predecessor: null,
      };
      await this.rememberProvisionApiKey(tx, receipt, prepared);
      return prepared;
    }, {
      maxWait: 10_000,
      timeout: 30_000,
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  }

  private async loadRememberedProvisionApiKey(
    tx: Prisma.TransactionClient,
    receipt: ProvisionReceiptLease,
  ): Promise<PreparedApiKey | null> {
    const row = await tx.saasProvisionReceipt.findUnique({
      where: { id: receipt.id },
      select: {
        status: true,
        leaseId: true,
        result: true,
      },
    });
    if (!row || row.status !== 'PENDING' || row.leaseId !== receipt.leaseId) {
      throw new ConflictException('Provision 幂等回执 lease 已失效，请重试');
    }
    if (!row.result || Array.isArray(row.result) || typeof row.result !== 'object') {
      return null;
    }
    const remembered = (row.result as Record<string, unknown>).apiKey;
    if (!remembered || Array.isArray(remembered) || typeof remembered !== 'object') {
      return null;
    }
    const rememberedKey = remembered as Record<string, unknown>;
    const id = this.requireReceiptString(rememberedKey.id, 'apiKey.id');
    const key = await tx.apiKey.findUnique({
      where: { id },
      select: {
        id: true,
        prefix: true,
        managedBy: true,
        provisionSecretEncrypted: true,
        provisionSecretExpiresAt: true,
        rotationPredecessorId: true,
      },
    });
    if (!key || key.managedBy !== SAAS_PROVISION_MANAGED_BY) {
      throw new ConflictException('Provision 幂等回执对应的 API Key 不存在');
    }
    const predecessor = key.rotationPredecessorId
      ? await tx.apiKey.findUnique({
          where: { id: key.rotationPredecessorId },
          select: {
            id: true,
            keyHash: true,
          },
        })
      : null;
    if (key.rotationPredecessorId && !predecessor) {
      throw new ConflictException('SaaS API Key 轮换前驱记录缺失');
    }
    const secretExpired = this.provisionSecretExpired(key);
    const plainKey = rememberedKey.plainKeyRecoverable === true
      ? this.recoverProvisionSecret(key)
      : null;
    if (secretExpired) {
      await tx.apiKey.update({
        where: { id: key.id },
        data: {
          provisionSecretEncrypted: null,
          provisionSecretExpiresAt: null,
        },
      });
    }
    return {
      id: key.id,
      prefix: key.prefix,
      plainKey,
      created: rememberedKey.created === true,
      rotated: rememberedKey.rotated === true,
      predecessor,
    };
  }

  private async rememberProvisionApiKey(
    tx: Prisma.TransactionClient,
    receipt: ProvisionReceiptLease | undefined,
    prepared: PreparedApiKey,
  ): Promise<void> {
    if (!receipt) return;
    const remembered: Prisma.InputJsonObject = {
      apiKey: {
        id: prepared.id,
        prefix: prepared.prefix,
        plainKeyRecoverable: prepared.plainKey !== null,
        created: prepared.created,
        rotated: prepared.rotated,
      },
    };
    const updated = await tx.saasProvisionReceipt.updateMany({
      where: {
        id: receipt.id,
        status: 'PENDING',
        leaseId: receipt.leaseId,
      },
      data: {
        result: remembered,
        leaseExpiresAt: new Date(Date.now() + PROVISION_LEASE_MS),
      },
    });
    if (updated.count !== 1) {
      throw new ConflictException('Provision 幂等回执 lease 已失效，请重试');
    }
  }

  private async finalizeVirtualApiKey(prepared: PreparedApiKey): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockProvisionIdentity(tx, `api-key-finalize:${prepared.id}`);
      const now = new Date();
      if (prepared.predecessor) {
        await tx.apiKey.updateMany({
          where: {
            id: prepared.predecessor.id,
            deletedAt: null,
          },
          data: {
            isActive: false,
            mirrorStatus: 'REVOKED',
            mirrorError: null,
            provisionSecretEncrypted: null,
            provisionSecretExpiresAt: null,
            deletedAt: now,
          },
        });
      }
      await tx.apiKey.update({
        where: { id: prepared.id },
        data: {
          isActive: true,
          mirrorStatus: 'ACTIVE',
          mirrorError: null,
          mirroredAt: now,
          activatedAt: now,
          rotationPredecessorId: null,
        },
      });
    }, {
      maxWait: 10_000,
      timeout: 30_000,
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    });
  }

  private newProvisionKeyMaterial(): {
    id: string;
    plainKey: string;
    prefix: string;
    keyHash: string;
    encryptedSecret: string;
    secretExpiresAt: Date;
  } {
    const encryptionKey = resolveEncryptionKey(this.config);
    if (!encryptionKey) {
      throw new ServiceUnavailableException(
        'ENCRYPTION_KEY 未配置，不能安全保存可恢复的 SaaS API Key',
      );
    }
    const plainKey = `rk-${randomBytes(32).toString('hex')}`;
    return {
      id: randomUUID(),
      plainKey,
      prefix: plainKey.slice(0, API_KEY_PREFIX_LENGTH + 3),
      keyHash: hashApiKey(plainKey),
      encryptedSecret: encrypt(plainKey, encryptionKey),
      secretExpiresAt: new Date(Date.now() + PROVISION_SECRET_RECOVERY_MS),
    };
  }

  private recoverProvisionSecret(key: {
    provisionSecretEncrypted: string | null;
    provisionSecretExpiresAt: Date | null;
  }): string | null {
    if (
      !key.provisionSecretEncrypted
      || !key.provisionSecretExpiresAt
      || key.provisionSecretExpiresAt.getTime() <= Date.now()
    ) {
      return null;
    }
    const encryptionKey = resolveEncryptionKey(this.config);
    if (!encryptionKey) {
      throw new ServiceUnavailableException(
        'ENCRYPTION_KEY 未配置，不能恢复 SaaS API Key',
      );
    }
    try {
      return decrypt(key.provisionSecretEncrypted, encryptionKey);
    } catch {
      throw new ConflictException('SaaS API Key 恢复密文不可解密');
    }
  }

  private provisionSecretExpired(key: {
    provisionSecretEncrypted: string | null;
    provisionSecretExpiresAt: Date | null;
  }): boolean {
    return Boolean(
      key.provisionSecretEncrypted
      && (
        !key.provisionSecretExpiresAt
        || key.provisionSecretExpiresAt.getTime() <= Date.now()
      ),
    );
  }

  private async cleanupExpiredProvisionSecrets(now = new Date()): Promise<number> {
    const cleaned = await this.prisma.apiKey.updateMany({
      where: {
        managedBy: SAAS_PROVISION_MANAGED_BY,
        provisionSecretEncrypted: { not: null },
        OR: [
          { provisionSecretExpiresAt: null },
          { provisionSecretExpiresAt: { lte: now } },
        ],
      },
      data: {
        provisionSecretEncrypted: null,
        provisionSecretExpiresAt: null,
      },
    });
    return cleaned.count;
  }

  private assertPartnerUserSnapshot(snapshot?: SaasProvisionUser | null): void {
    if (
      snapshot
      && Object.prototype.hasOwnProperty.call(snapshot, 'isActive')
      && snapshot.isActive !== undefined
      && snapshot.isActive !== null
    ) {
      throw new BadRequestException(
        'Partner provision 不允许修改 user.isActive',
      );
    }
    if (snapshot?.sourceUpdatedAt) {
      const sourceUpdatedAt = snapshot.sourceUpdatedAt instanceof Date
        ? snapshot.sourceUpdatedAt
        : new Date(snapshot.sourceUpdatedAt);
      if (Number.isNaN(sourceUpdatedAt.getTime())) {
        throw new BadRequestException('user.sourceUpdatedAt 必须是有效时间');
      }
      if (sourceUpdatedAt.getTime() > Date.now() + 5 * 60 * 1000) {
        throw new BadRequestException('user.sourceUpdatedAt 不能超过当前时间 5 分钟');
      }
    }
  }

  private partnerMirrorSnapshot(
    userId: string,
    snapshot?: SaasProvisionUser | null,
  ): {
    id: string;
    email?: string | null;
    phone?: string | null;
    nickname?: string | null;
    sourceUpdatedAt?: string | Date | null;
  } {
    if (!snapshot) return { id: userId };
    return {
      id: userId,
      ...(Object.prototype.hasOwnProperty.call(snapshot, 'email')
        ? { email: snapshot.email }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(snapshot, 'phone')
        ? { phone: snapshot.phone }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(snapshot, 'nickname')
        ? { nickname: snapshot.nickname }
        : {}),
      ...(Object.prototype.hasOwnProperty.call(snapshot, 'sourceUpdatedAt')
        ? { sourceUpdatedAt: snapshot.sourceUpdatedAt }
        : {}),
    };
  }

  private productUserSnapshotChanged(
    existing: {
      email: string | null;
      phone: string | null;
      nickname: string | null;
    },
    snapshot?: SaasProvisionUser | null,
  ): boolean {
    if (!snapshot) return false;
    return (
      (
        Object.prototype.hasOwnProperty.call(snapshot, 'email')
        && this.normalizeNullableString(snapshot.email) !== existing.email
      )
      || (
        Object.prototype.hasOwnProperty.call(snapshot, 'phone')
        && this.normalizeNullableString(snapshot.phone) !== existing.phone
      )
      || (
        Object.prototype.hasOwnProperty.call(snapshot, 'nickname')
        && this.normalizeNullableString(snapshot.nickname) !== existing.nickname
      )
    );
  }

  private assertPartnerSnapshotFreshForChanges(
    existingSourceUpdatedAt: Date | null,
    snapshot: SaasProvisionUser | null | undefined,
    profileChanged: boolean,
  ): void {
    if (!profileChanged || !existingSourceUpdatedAt) return;
    const incoming = this.parsePartnerSourceUpdatedAt(snapshot?.sourceUpdatedAt);
    if (!incoming || incoming.getTime() <= existingSourceUpdatedAt.getTime()) {
      throw new ConflictException(
        '修改 Partner 用户资料必须提供晚于当前快照的 user.sourceUpdatedAt',
      );
    }
  }

  private parsePartnerSourceUpdatedAt(
    value?: string | Date | null,
  ): Date | null {
    if (!value) return null;
    const parsed = value instanceof Date ? value : new Date(value);
    if (Number.isNaN(parsed.getTime())) {
      throw new BadRequestException('user.sourceUpdatedAt 必须是有效时间');
    }
    return parsed;
  }

  private assertReadOnlyUserSnapshotUnchanged(
    user: {
      email: string | null;
      phone: string | null;
      nickname: string;
    },
    snapshot?: SaasProvisionUser | null,
  ): void {
    if (!snapshot) return;
    const changed =
      (
        Object.prototype.hasOwnProperty.call(snapshot, 'email')
        && this.normalizeNullableString(snapshot.email) !== user.email
      )
      || (
        Object.prototype.hasOwnProperty.call(snapshot, 'phone')
        && this.normalizeNullableString(snapshot.phone) !== user.phone
      )
      || (
        Object.prototype.hasOwnProperty.call(snapshot, 'nickname')
        && (this.normalizeNullableString(snapshot.nickname) ?? '') !== user.nickname
      );
    if (changed) {
      throw new ConflictException(
        '历史共享用户绑定不允许由 Partner provision 修改资料',
      );
    }
  }

  private requireSingleUserBinding<T extends { userId: string }>(bindings: T[]): T {
    if (bindings.length === 0) {
      throw new ForbiddenException('产品未绑定该用户');
    }
    if (new Set(bindings.map((binding) => binding.userId)).size !== 1) {
      throw new ConflictException('产品用户绑定冲突');
    }
    return bindings[0];
  }

  private requireSingleTenantBinding<T extends { tenantId: string }>(bindings: T[]): T {
    if (bindings.length === 0) {
      throw new ForbiddenException('产品未绑定该租户');
    }
    if (new Set(bindings.map((binding) => binding.tenantId)).size !== 1) {
      throw new ConflictException('产品租户绑定冲突');
    }
    return bindings[0];
  }

  private async lockProvisionIdentity(
    db: ProvisionDb,
    lockKey: string,
  ): Promise<void> {
    await db.$executeRaw`
      SELECT pg_advisory_xact_lock(
        hashtextextended(${`saas-provision:${lockKey}`}, 0::BIGINT)
      )
    `;
  }

  private errorMessage(error: unknown): string {
    return error instanceof Error ? error.message : String(error);
  }

  private identityV2WritesEnabled(): boolean {
    const configured = this.config.get<unknown>(
      'PARTNER_IDENTITY_V2_WRITE_ENABLED',
    );
    if (configured === true || configured === 'true' || configured === '1') {
      return true;
    }
    if (configured === false || configured === 'false' || configured === '0') {
      return false;
    }
    return this.config.get<string>('NODE_ENV') !== 'production';
  }

  private assertIdentityV2WritesEnabled(): void {
    if (this.identityV2WritesEnabled()) return;
    throw new ServiceUnavailableException(
      'Partner identity V2 新主体写入尚未启用；请先完成迁移 preflight 并显式开启 PARTNER_IDENTITY_V2_WRITE_ENABLED',
    );
  }

  private isUserOnlyProduct(product: {
    billingMode: string;
    codingPlanFulfillmentMode: string | null;
  }): boolean {
    return product.billingMode === 'CODING_PLAN'
      && product.codingPlanFulfillmentMode === 'platform_model_package';
  }

  private resolveEnsureFreePlan(
    product: {
      billingMode: string;
      codingPlanFulfillmentMode: string | null;
    },
    requested: boolean | null | undefined,
  ): boolean {
    if (product.billingMode === 'PAY_AS_YOU_GO') {
      if (requested === true) {
        throw new BadRequestException(
          'PAY_AS_YOU_GO 产品不支持 ensureFreePlan=true',
        );
      }
      return false;
    }
    if (
      product.billingMode === 'CODING_PLAN'
      && product.codingPlanFulfillmentMode === 'provider_resale'
    ) {
      if (requested === true) {
        throw new BadRequestException(
          'provider_resale Coding Plan 不允许由 Partner 自动开通免费权益',
        );
      }
      return false;
    }
    if (
      product.billingMode === 'CODING_PLAN'
      && product.codingPlanFulfillmentMode !== 'platform_model_package'
    ) {
      throw new BadRequestException(
        'CODING_PLAN 产品 fulfillment mode 未配置或不受 Partner provision 支持',
      );
    }
    return requested !== false;
  }

  private assertAllowedModelsInput(key?: SaasProvisionKey | null): void {
    if (!key || !Object.prototype.hasOwnProperty.call(key, 'allowedModels')) return;
    if (key.allowedModels === undefined || key.allowedModels === null) return;
    if (!Array.isArray(key.allowedModels)) {
      throw new BadRequestException('key.allowedModels 必须是字符串数组');
    }
    if (!this.serializeAllowedModels(key.allowedModels)) {
      throw new BadRequestException(
        'key.allowedModels 显式传入时至少需要一个非空模型',
      );
    }
  }

  private async assertRequestedModelsAuthorized(
    product: {
      id: string;
      slug: string;
      billingMode: string;
    },
    planId: string | null,
    key?: SaasProvisionKey | null,
  ): Promise<void> {
    if (!key || !Object.prototype.hasOwnProperty.call(key, 'allowedModels')) return;
    if (key.allowedModels === undefined || key.allowedModels === null) return;
    const serialized = this.serializeAllowedModels(key.allowedModels);
    if (!serialized) {
      throw new BadRequestException(
        'key.allowedModels 显式传入时至少需要一个非空模型',
      );
    }
    if (!planId && product.billingMode !== 'PAY_AS_YOU_GO') {
      throw new BadRequestException(
        'key.allowedModels 需要当前产品存在有效套餐或 Coding Plan entitlement',
      );
    }
    const requested = JSON.parse(serialized) as string[];
    const modelSurface = await this.catalog.getModels({
      id: product.id,
      slug: product.slug,
      record: product,
    });
    const visible = new Set(modelSurface.models.map((model) => model.id));
    let authorized = visible;
    if (planId) {
      const accessRows = await this.prisma.modelAccess.findMany({
        where: {
          planId,
          isActive: true,
          modelName: { in: requested },
        },
        select: { modelName: true },
      });
      const accessible = new Set(accessRows.map((row) => row.modelName));
      authorized = new Set(
        requested.filter((model) => visible.has(model) && accessible.has(model)),
      );
    }
    const denied = requested.filter((model) => !authorized.has(model));
    if (denied.length > 0) {
      throw new BadRequestException(
        `key.allowedModels 包含当前产品或套餐未授权模型: ${denied.join(', ')}`,
      );
    }
  }

  private serializeAllowedModels(value?: string[] | null): string | null {
    if (!Array.isArray(value)) return null;
    const models = Array.from(new Set(
      value.map((item) => String(item).trim()).filter(Boolean),
    )).sort();
    return models.length > 0 ? JSON.stringify(models) : null;
  }

  private canonicalizeStoredAllowedModels(value: string | null): string | null {
    if (!value) return null;
    try {
      const parsed = JSON.parse(value);
      if (!Array.isArray(parsed)) {
        throw new Error('not an array');
      }
      return this.serializeAllowedModels(parsed.map((item) => String(item)));
    } catch {
      throw new ConflictException('既有 SaaS API Key allowedModels 格式无效');
    }
  }

  private sameDecimal(
    left: Prisma.Decimal | null,
    right: Prisma.Decimal | null,
  ): boolean {
    if (left === null || right === null) return left === right;
    return left.equals(right);
  }

  private toBudgetUsd(value?: number | null): Prisma.Decimal | null {
    if (value === undefined || value === null) return null;
    if (!Number.isFinite(value) || value <= 0) return null;
    return new Prisma.Decimal(value).div(100);
  }

  private requireString(value: unknown, field: string): string {
    const normalized = this.normalizeNullableString(value);
    if (!normalized) throw new BadRequestException(`${field} 是必填字段`);
    return normalized;
  }

  private normalizeNullableString(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    return text || null;
  }

  private normalizeTenantType(value: unknown): string {
    const type = this.normalizeNullableString(value);
    if (!type) return 'personal';
    if (type === 'personal' || type === 'team') return type;
    throw new BadRequestException('tenant.type 仅支持 personal 或 team');
  }
}
