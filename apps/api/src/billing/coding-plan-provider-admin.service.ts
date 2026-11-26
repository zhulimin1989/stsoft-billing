import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CodingPlanFulfillmentMode, Prisma, ProductBillingMode } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import {
  CAPABILITIES,
  DEDICATED_PROTOCOL_CHANNELS,
  TOKEN_COUNT_STRATEGIES,
} from '@raytone-lab/publisher-contracts';
import type { DedicatedProtocolChannel, ProtocolPath, ProviderProfile } from '@raytone-lab/publisher-contracts';
import { encrypt } from '../common/utils/crypto';
import { resolveEncryptionKey } from '../common/utils/encryption-key';
import { PrismaService } from '../prisma/prisma.service';
import { BillingService } from './billing.service';
import { CodingPlanProviderAdapterRegistry } from './coding-plan-provider-adapter.registry';
import { CodingPlanProviderEntitlementAttemptService } from './coding-plan-provider-entitlement-attempt.service';
import { CodingPlanProviderLineService } from './coding-plan-provider-line.service';
import { ProviderCreateOrderResult } from './coding-plan-provider.types';
import { PublisherSyncService } from '../publisher/publisher-sync.service';
import type { PublisherAcceptedResponse } from '../publisher/publisher.types';
import {
  buildChannelProtocolTemplates,
  defaultClientCompatibilityForProfile,
  defaultTokenCountStrategyForProfile,
  normalizeProtocolPathListValue,
  normalizeServedInboundProtocolListValue,
  normalizeProviderProfileValue,
  servedInboundProtocolsForProtocolPaths,
} from '../publisher/publisher-runtime-registry';
import type { ServedInboundProtocol } from '../publisher/publisher-runtime-registry';
import {
  normalizeProviderAccountCode,
  PROVIDER_ACCOUNT_IDENTITY_EVIDENCE_SELECT,
  validateProviderAccountIdentityForProvider,
} from '../provider-account-identity/provider-account-identity.policy';

const DEDICATED_CLIENT_PROTOCOLS = new Set(['anthropic', 'openai', 'responses']);
const DEDICATED_PROTOCOL_CHANNEL_SET = new Set<string>(DEDICATED_PROTOCOL_CHANNELS);
const DEDICATED_TOKEN_COUNT_STRATEGIES = new Set<string>(TOKEN_COUNT_STRATEGIES);
const DEDICATED_CAPABILITIES = new Set<string>(CAPABILITIES);
const DEDICATED_RESALE_SYSTEM_REMARK = 'system:dedicated_resale_runtime_provider';

type ProviderLineWriteContext = {
  lineId: string;
  lineCode: string;
  providerCode: string;
  providerName?: string | null;
};

type ProviderLineWriteResult = {
  data: Prisma.CodingPlanProviderLineUncheckedCreateInput | Prisma.CodingPlanProviderLineUncheckedUpdateInput;
  dedicatedProductIds: string[];
};

type PrismaWriteClient = PrismaService | Prisma.TransactionClient;

type ProviderLineWriteOptions = {
  processDedicatedEndpoints?: boolean;
};

type ProviderLinePublisherSync = {
  ok: true;
  status: 'ACCEPTED';
  warnings?: unknown[];
};

type DedicatedRuntimeEndpointConfig = {
  label: string;
  providerId?: string | null;
  baseUrl: string;
  providerProfile: ProviderProfile;
  name?: string | null;
  code?: string | null;
  ownedBy?: string | null;
  servedInboundProtocols: ServedInboundProtocol[];
  paths: ProtocolPath[];
  capabilities: string[];
  tokenCountStrategy?: string | null;
  status?: string | null;
  priority?: number;
  weight?: number;
};

@Injectable()
export class CodingPlanProviderAdminService {
  private readonly logger = new Logger(CodingPlanProviderAdminService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly providerLines: CodingPlanProviderLineService,
    private readonly adapterRegistry: CodingPlanProviderAdapterRegistry,
    private readonly billingService: BillingService,
    private readonly publisherSync: PublisherSyncService,
    private readonly entitlementAttempts: CodingPlanProviderEntitlementAttemptService,
  ) {}

  async listProviderLines() {
    const lines = await this.prisma.codingPlanProviderLine.findMany({
      orderBy: [{ providerCode: 'asc' }, { code: 'asc' }],
    });
    return lines.map((line) => this.providerLineView(line));
  }

  async createProviderLine(body: Record<string, unknown>) {
    const code = this.requiredText(body.code, 'code');
    const lineId = this.optionalText(body.id) ?? randomUUID();
    const providerCode = this.requiredText(body.providerCode, 'providerCode');
    const providerAccountIdentityId = this.optionalProviderAccountIdentityId(
      body.providerAccountIdentityId,
    );
    await this.assertProviderLineAccountIdentity(
      providerAccountIdentityId,
      providerCode,
      body.fulfillmentEnabled === true,
    );
    const context = {
      lineId,
      lineCode: code,
      providerCode,
      providerName: this.optionalText(body.providerName),
    };
    const result = await this.prisma.$transaction(async (tx) => {
      const write = await this.providerLineWriteData(body, true, context, tx, {
        processDedicatedEndpoints: false,
      });
      let line = await tx.codingPlanProviderLine.create({
        data: {
          ...write.data,
          id: lineId,
          code,
        } as Prisma.CodingPlanProviderLineUncheckedCreateInput,
      });
      const dedicatedProductIds = new Set(write.dedicatedProductIds);
      if (Object.prototype.hasOwnProperty.call(body, 'dedicatedEndpoints')) {
        const dedicated = await this.dedicatedEndpointsJson(body.dedicatedEndpoints, body, context, tx);
        line = await tx.codingPlanProviderLine.update({
          where: { id: lineId },
          data: { dedicatedEndpoints: dedicated.value },
        });
        for (const productId of dedicated.productIds) dedicatedProductIds.add(productId);
      }
      return {
        line,
        dedicatedProductIds: [...dedicatedProductIds],
      };
    });
    const publisherResponses = [
      ...(await this.syncDedicatedRuntimeProducts(result.dedicatedProductIds)),
      await this.syncProviderLineRuntime(result.line, 'create'),
    ];
    return {
      ...this.providerLineView(result.line),
      publisherSync: this.publisherSyncFromResponses(publisherResponses),
    };
  }

  async updateProviderLine(id: string, body: Record<string, unknown>) {
    const existing = await this.prisma.codingPlanProviderLine.findUnique({
      where: { id },
      select: {
        id: true,
        code: true,
        providerCode: true,
        providerName: true,
        providerAccountIdentityId: true,
        fulfillmentEnabled: true,
      },
    });
    if (!existing) throw new BadRequestException('供应商线路不存在');
    const providerCode = Object.prototype.hasOwnProperty.call(body, 'providerCode')
      ? this.requiredText(body.providerCode, 'providerCode')
      : existing.providerCode;
    if (
      normalizeProviderAccountCode(providerCode)
      !== normalizeProviderAccountCode(existing.providerCode)
    ) {
      const entitlementCount = await this.prisma.codingPlanProviderEntitlement.count({
        where: { providerLineId: id },
      });
      if (entitlementCount > 0) {
        throw new BadRequestException(
          '供应商线路已有履约记录，不能跨供应商修改 providerCode；请新建供应商线路',
        );
      }
    }
    const providerAccountIdentityId = Object.prototype.hasOwnProperty.call(
      body,
      'providerAccountIdentityId',
    )
      ? this.optionalProviderAccountIdentityId(body.providerAccountIdentityId)
      : existing.providerAccountIdentityId;
    const fulfillmentEnabled = Object.prototype.hasOwnProperty.call(body, 'fulfillmentEnabled')
      ? body.fulfillmentEnabled === true
      : existing.fulfillmentEnabled;
    await this.assertProviderLineAccountIdentity(
      providerAccountIdentityId,
      providerCode,
      fulfillmentEnabled,
    );
    const write = await this.providerLineWriteData(body, false, {
      lineId: existing.id,
      lineCode: existing.code,
      providerCode,
      providerName: Object.prototype.hasOwnProperty.call(body, 'providerName')
        ? this.optionalText(body.providerName)
        : existing.providerName,
    });
    const line = await this.prisma.codingPlanProviderLine.update({
      where: { id },
      data: write.data as Prisma.CodingPlanProviderLineUncheckedUpdateInput,
    });
    const publisherResponses = [
      ...(await this.syncDedicatedRuntimeProducts(write.dedicatedProductIds)),
      await this.syncProviderLineRuntime(line, 'update'),
    ];
    return {
      ...this.providerLineView(line),
      publisherSync: this.publisherSyncFromResponses(publisherResponses),
    };
  }

  async deleteProviderLine(id: string) {
    const line = await this.prisma.codingPlanProviderLine.findUnique({
      where: { id },
      select: { id: true, code: true, name: true },
    });
    if (!line) throw new BadRequestException('供应商线路不存在');

    const [routeCount, providerEntitlementCount, customerEntitlementCount] = await Promise.all([
      this.prisma.codingPlanResaleRoute.count({ where: { providerLineId: id } }),
      this.prisma.codingPlanProviderEntitlement.count({ where: { providerLineId: id } }),
      this.prisma.codingPlanEntitlement.count({ where: { providerLineId: id } }),
    ]);
    if (routeCount > 0) {
      throw new BadRequestException('供应商线路已绑定转售映射，请先清理转售映射');
    }
    if (providerEntitlementCount > 0 || customerEntitlementCount > 0) {
      throw new BadRequestException('供应商线路已有履约记录或用户权益，不能删除');
    }

    await this.prisma.codingPlanProviderLine.delete({ where: { id } });
    const publisherResponse = await this.syncProviderLineRuntime(line, 'delete');
    return {
      deleted: true,
      id: line.id,
      code: line.code,
      name: line.name,
      publisherSync: this.publisherSyncFromResponses([publisherResponse]),
    };
  }

  async testProviderLine(id: string) {
    const lineRecord = await this.providerLines.loadLineById(id);
    const line = await this.providerLines.toRuntimeConfig(lineRecord);
    const adapter = this.adapterRegistry.get(line.adapterType);
    const products = await adapter.listProducts(line);
    return {
      providerLineId: line.id,
      providerLineCode: line.code,
      adapterType: line.adapterType,
      apiBaseUrl: line.apiBaseUrl,
      productCount: products.length,
      sampleProducts: products.slice(0, 5).map((product) => ({
        upstreamProductId: product.upstreamProductId,
        productName: product.productName,
        salePrice: product.salePrice ?? null,
        currency: product.currency ?? null,
      })),
    };
  }

  async syncProviderProducts(id: string) {
    const line = await this.providerLines.getForSync(id);
    const adapter = this.adapterRegistry.get(line.adapterType);
    const products = await adapter.listProducts(line);
    const now = new Date();
    for (const product of products) {
      await this.prisma.codingPlanProviderProduct.upsert({
        where: {
          providerLineId_upstreamProductId: {
            providerLineId: line.id,
            upstreamProductId: product.upstreamProductId,
          },
        },
        update: {
          productName: product.productName,
          salePrice: this.decimalValue(product.salePrice),
          currency: product.currency ?? null,
          productCycle: product.productCycle ?? null,
          productType: product.productType ?? null,
          productBigTitle: product.productBigTitle ?? null,
          productSmallTitle: product.productSmallTitle ?? null,
          description: product.description ?? null,
          productIntroduction: product.productIntroduction ?? null,
          salesVolume: product.salesVolume ?? null,
          dailySalesLimit: product.dailySalesLimit ?? null,
          monthlySalesLimit: product.monthlySalesLimit ?? null,
          yearlySalesLimit: product.yearlySalesLimit ?? null,
          maxSalesLimit: product.maxSalesLimit ?? null,
          status: product.status ?? 'ACTIVE',
          rawSnapshot: product.raw as Prisma.InputJsonObject,
          lastSyncedAt: now,
        },
        create: {
          providerLineId: line.id,
          upstreamProductId: product.upstreamProductId,
          productName: product.productName,
          salePrice: this.decimalValue(product.salePrice),
          currency: product.currency ?? null,
          productCycle: product.productCycle ?? null,
          productType: product.productType ?? null,
          productBigTitle: product.productBigTitle ?? null,
          productSmallTitle: product.productSmallTitle ?? null,
          description: product.description ?? null,
          productIntroduction: product.productIntroduction ?? null,
          salesVolume: product.salesVolume ?? null,
          dailySalesLimit: product.dailySalesLimit ?? null,
          monthlySalesLimit: product.monthlySalesLimit ?? null,
          yearlySalesLimit: product.yearlySalesLimit ?? null,
          maxSalesLimit: product.maxSalesLimit ?? null,
          status: product.status ?? 'ACTIVE',
          rawSnapshot: product.raw as Prisma.InputJsonObject,
          lastSyncedAt: now,
        },
      });
    }
    return {
      providerLineId: line.id,
      providerLineCode: line.code,
      syncedCount: products.length,
      syncedAt: now.toISOString(),
    };
  }

  async listProviderProducts(providerLineId?: string | null) {
    return this.prisma.codingPlanProviderProduct.findMany({
      where: providerLineId ? { providerLineId } : undefined,
      include: { providerLine: { select: { id: true, code: true, name: true } } },
      orderBy: [{ providerLineId: 'asc' }, { productName: 'asc' }],
    });
  }

  async listResaleRoutes(query: {
    planId?: string | null;
    providerLineId?: string | null;
  }) {
    return this.prisma.codingPlanResaleRoute.findMany({
      where: {
        ...(query.planId ? { planId: query.planId } : {}),
        ...(query.providerLineId ? { providerLineId: query.providerLineId } : {}),
      },
      include: {
        plan: { select: { id: true, name: true, productId: true } },
        providerLine: { select: { id: true, code: true, name: true, providerCode: true } },
      },
      orderBy: [{ planId: 'asc' }, { priority: 'asc' }, { createdAt: 'asc' }],
    });
  }

  async listProviderEntitlements(query: {
    status?: string | null;
    providerLineId?: string | null;
    providerLineCode?: string | null;
    userId?: string | null;
    tenantId?: string | null;
    orderId?: string | null;
    take?: number;
  }) {
    return this.prisma.codingPlanProviderEntitlement.findMany({
      where: {
        ...(query.status ? { status: query.status as never } : {}),
        ...(query.providerLineId ? { providerLineId: query.providerLineId } : {}),
        ...(query.providerLineCode ? { providerLineCode: query.providerLineCode } : {}),
        ...(query.userId ? { userId: query.userId } : {}),
        ...(query.tenantId ? { tenantId: query.tenantId } : {}),
        ...(query.orderId ? { orderId: query.orderId } : {}),
      },
      include: {
        providerLine: { select: { id: true, code: true, name: true, runtimeEnabled: true } },
        customerEntitlement: { select: { id: true, status: true, expiresAt: true } },
      },
      orderBy: { createdAt: 'desc' },
      take: query.take ?? 100,
    });
  }

  async retryProviderEntitlement(id: string) {
    const existing = await this.prisma.codingPlanProviderEntitlement.findUnique({
      where: { id },
    });
    if (!existing) throw new BadRequestException('供应商履约记录不存在');
    if (existing.status === 'ACTIVE') {
      await this.billingService.attachCodingPlanProviderEntitlement(existing.orderId);
      return { status: 'already_active', providerEntitlementId: existing.id };
    }

    if (!existing.providerLineId) {
      throw new BadRequestException('供应商履约记录缺少 providerLineId，不能按当前协议重试');
    }
    const line = await this.providerLines.getForFulfillment(existing.providerLineId);
    const claim = await this.claimProviderEntitlementRetry(existing.id, {
      provider: line.providerCode,
      providerLineId: line.id,
      providerLineCode: line.code,
      providerCode: line.providerCode,
      providerAccountIdentityId: line.providerAccountIdentityId,
      adapterType: line.adapterType,
    });
    if (claim.status === 'active') {
      await this.billingService.attachCodingPlanProviderEntitlement(existing.orderId);
      return { status: 'already_active', providerEntitlementId: existing.id };
    }
    if (claim.status === 'busy') {
      throw new ConflictException('供应商履约正在进行，不能重复发起上游订单');
    }
    if (claim.status === 'ineligible') {
      throw new BadRequestException(
        `供应商履约记录状态 ${claim.entitlementStatus} 不允许重试`,
      );
    }

    const encryptionKey = resolveEncryptionKey(this.config);
    if (!encryptionKey) {
      await this.entitlementAttempts.failIfCurrent(
        claim.providerEntitlementId,
        claim.attemptId,
        'ENCRYPTION_KEY 未配置，不能保存供应商上游 key',
      );
      throw new ServiceUnavailableException('ENCRYPTION_KEY 未配置，不能保存供应商上游 key');
    }
    const adapter = this.adapterRegistry.get(line.adapterType);
    try {
      const prepared = await this.entitlementAttempts.prepareForUpstreamIfCurrent(
        claim.providerEntitlementId,
        claim.attemptId,
      );
      if (!prepared) {
        const currentStatus = await this.entitlementAttempts.currentStatus(
          claim.providerEntitlementId,
        );
        if (currentStatus === 'ACTIVE') {
          await this.billingService.attachCodingPlanProviderEntitlement(existing.orderId);
          return { status: 'already_active', providerEntitlementId: existing.id };
        }
        throw new ConflictException('供应商履约尝试已被更新，未调用上游');
      }
      const response = await adapter.createOrder(line, {
        partnerUserId: existing.partnerUserId,
        partnerOrderNo: existing.partnerOrderNo,
        upstreamProductId: existing.upstreamProductId,
      });
      const activated = await this.saveProviderEntitlementRetry(
        claim.providerEntitlementId,
        claim.attemptId,
        response,
        encryptionKey,
      );
      if (!activated) {
        const currentStatus = await this.entitlementAttempts.currentStatus(
          claim.providerEntitlementId,
        );
        if (currentStatus === 'ACTIVE') {
          await this.billingService.attachCodingPlanProviderEntitlement(existing.orderId);
          return { status: 'already_active', providerEntitlementId: existing.id };
        }
        throw new ConflictException('供应商履约尝试已被更新，忽略当前上游响应');
      }
      await this.billingService.attachCodingPlanProviderEntitlement(existing.orderId);
      return { status: 'activated', providerEntitlementId: existing.id };
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      const failureRecorded = await this.entitlementAttempts.failIfCurrent(
        claim.providerEntitlementId,
        claim.attemptId,
        message,
      ).catch(() => false);
      if (!failureRecorded) {
        const currentStatus = await this.entitlementAttempts.currentStatus(
          claim.providerEntitlementId,
        ).catch(() => null);
        if (currentStatus === 'ACTIVE') {
          await this.billingService.attachCodingPlanProviderEntitlement(existing.orderId);
          return { status: 'already_active', providerEntitlementId: existing.id };
        }
      }
      throw error;
    }
  }

  private async saveProviderEntitlementRetry(
    id: string,
    attemptId: string,
    response: ProviderCreateOrderResult,
    encryptionKey: string,
  ): Promise<boolean> {
    return this.entitlementAttempts.activateIfCurrent(id, attemptId, {
      upstreamOrderId: response.upstreamOrderId,
      upstreamApiKeyEncrypted: encrypt(response.apiKey, encryptionKey),
      upstreamApiKeyPrefix: this.keyPrefix(response.apiKey),
      upstreamSecretKeyEncrypted: encrypt(response.secretKey, encryptionKey),
      upstreamSecretKeyPrefix: this.keyPrefix(response.secretKey),
      credentialFormat: response.credentialFormat,
      productStartTime: this.parseProviderDate(response.productStartTime),
      productEndTime: this.parseProviderDate(response.productEndTime),
      responseSnapshot: this.sanitizeProviderResponse(response.raw),
      activatedAt: new Date(),
    });
  }

  private async claimProviderEntitlementRetry(
    id: string,
    binding: Parameters<CodingPlanProviderEntitlementAttemptService['claimById']>[1],
  ) {
    try {
      const claim = await this.entitlementAttempts.claimById(id, binding);
      if (!claim) throw new BadRequestException('供应商履约记录不存在');
      return claim;
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (
        message.includes('provider_account_identity_provider_line_')
        || message.includes('active_provider_entitlement_identity_required')
      ) {
        throw new ServiceUnavailableException(
          '供应商线路账户身份在履约准备期间发生变化，未调用上游，请重试',
        );
      }
      throw error;
    }
  }

  private async providerLineWriteData(
    body: Record<string, unknown>,
    create: boolean,
    context: ProviderLineWriteContext,
    db: PrismaWriteClient = this.prisma,
    options: ProviderLineWriteOptions = {},
  ): Promise<ProviderLineWriteResult> {
    const data: Prisma.CodingPlanProviderLineUncheckedCreateInput | Prisma.CodingPlanProviderLineUncheckedUpdateInput = {};
    if (create || Object.prototype.hasOwnProperty.call(body, 'name')) {
      data.name = this.requiredText(body.name, 'name');
    }
    if (create || Object.prototype.hasOwnProperty.call(body, 'providerCode')) {
      data.providerCode = this.requiredText(body.providerCode, 'providerCode');
    }
    if (create || Object.prototype.hasOwnProperty.call(body, 'providerAccountIdentityId')) {
      data.providerAccountIdentityId = this.optionalProviderAccountIdentityId(
        body.providerAccountIdentityId,
      );
    }
    if (Object.prototype.hasOwnProperty.call(body, 'providerName')) {
      data.providerName = this.optionalText(body.providerName);
    }
    if (create || Object.prototype.hasOwnProperty.call(body, 'adapterType')) {
      data.adapterType = this.requiredText(body.adapterType, 'adapterType');
    }
    if (Object.prototype.hasOwnProperty.call(body, 'environment')) {
      data.environment = this.optionalText(body.environment) ?? 'production';
    } else if (create) {
      data.environment = 'production';
    }
    if (create || Object.prototype.hasOwnProperty.call(body, 'apiBaseUrl')) {
      data.apiBaseUrl = this.requiredText(body.apiBaseUrl, 'apiBaseUrl').replace(/\/+$/, '');
    }
    if (Object.prototype.hasOwnProperty.call(body, 'authType')) {
      data.authType = this.optionalText(body.authType) ?? 'partner_md5_header';
    } else if (create) {
      data.authType = 'partner_md5_header';
    }
    for (const key of ['salesEnabled', 'fulfillmentEnabled', 'runtimeEnabled', 'syncEnabled'] as const) {
      if (Object.prototype.hasOwnProperty.call(body, key)) {
        data[key] = body[key] === true;
      } else if (create) {
        data[key] = false;
      }
    }
    if (Object.prototype.hasOwnProperty.call(body, 'capabilities')) {
      data.capabilities = this.jsonObject(body.capabilities);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'qpsConfig')) {
      data.qpsConfig = this.jsonObject(body.qpsConfig);
    }
    const dedicatedProductIds = new Set<string>();
    if (
      options.processDedicatedEndpoints !== false
      && Object.prototype.hasOwnProperty.call(body, 'dedicatedEndpoints')
    ) {
      const dedicated = await this.dedicatedEndpointsJson(body.dedicatedEndpoints, body, context, db);
      data.dedicatedEndpoints = dedicated.value;
      for (const productId of dedicated.productIds) dedicatedProductIds.add(productId);
    }
    if (Object.prototype.hasOwnProperty.call(body, 'metadata')) {
      data.metadata = this.jsonObject(body.metadata);
    }
    await this.applyProviderLineSecretFields(data, body);
    return {
      data,
      dedicatedProductIds: [...dedicatedProductIds],
    };
  }

  private async applyProviderLineSecretFields(
    data: Prisma.CodingPlanProviderLineUncheckedCreateInput | Prisma.CodingPlanProviderLineUncheckedUpdateInput,
    body: Record<string, unknown>,
  ): Promise<void> {
    const encryptionKey = resolveEncryptionKey(this.config);
    const partnerCode = this.optionalText(body.partnerCode);
    if (partnerCode) {
      if (!encryptionKey) throw new ServiceUnavailableException('ENCRYPTION_KEY 未配置，不能保存供应商凭证');
      data.partnerCodeEncrypted = encrypt(partnerCode, encryptionKey);
      data.partnerCodePrefix = this.keyPrefix(partnerCode);
    } else if (body.clearPartnerCode === true) {
      data.partnerCodeEncrypted = null;
      data.partnerCodePrefix = null;
    }

    const partnerSecret = this.optionalText(body.partnerSecretKey);
    if (partnerSecret) {
      if (!encryptionKey) throw new ServiceUnavailableException('ENCRYPTION_KEY 未配置，不能保存供应商凭证');
      data.partnerSecretEncrypted = encrypt(partnerSecret, encryptionKey);
      data.partnerSecretPrefix = this.keyPrefix(partnerSecret);
    } else if (body.clearPartnerSecretKey === true) {
      data.partnerSecretEncrypted = null;
      data.partnerSecretPrefix = null;
    }
  }

  private providerLineView(line: {
    id: string;
    code: string;
    name: string;
    providerCode: string;
    providerAccountIdentityId: string | null;
    providerName: string | null;
    adapterType: string;
    environment: string;
    apiBaseUrl: string;
    authType: string;
    partnerCodeEncrypted: string | null;
    partnerCodePrefix: string | null;
    partnerSecretEncrypted: string | null;
    partnerSecretPrefix: string | null;
    salesEnabled: boolean;
    fulfillmentEnabled: boolean;
    runtimeEnabled: boolean;
    syncEnabled: boolean;
    capabilities: Prisma.JsonValue | null;
    qpsConfig: Prisma.JsonValue | null;
    dedicatedEndpoints: Prisma.JsonValue | null;
    metadata: Prisma.JsonValue | null;
    createdAt: Date;
    updatedAt: Date;
  }) {
    return {
      id: line.id,
      code: line.code,
      name: line.name,
      providerCode: line.providerCode,
      providerAccountIdentityId: line.providerAccountIdentityId,
      providerName: line.providerName,
      adapterType: line.adapterType,
      environment: line.environment,
      apiBaseUrl: line.apiBaseUrl,
      authType: line.authType,
      partnerCodeConfigured: Boolean(line.partnerCodeEncrypted),
      partnerCodePrefix: line.partnerCodePrefix,
      partnerSecretConfigured: Boolean(line.partnerSecretEncrypted),
      partnerSecretPrefix: line.partnerSecretPrefix,
      salesEnabled: line.salesEnabled,
      fulfillmentEnabled: line.fulfillmentEnabled,
      runtimeEnabled: line.runtimeEnabled,
      syncEnabled: line.syncEnabled,
      capabilities: line.capabilities,
      qpsConfig: line.qpsConfig,
      dedicatedEndpoints: line.dedicatedEndpoints,
      metadata: line.metadata,
      createdAt: line.createdAt.toISOString(),
      updatedAt: line.updatedAt.toISOString(),
    };
  }

  private optionalProviderAccountIdentityId(value: unknown): string | null {
    if (value === undefined || value === null || value === '') return null;
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException('providerAccountIdentityId 必须是非空字符串或 null');
    }
    return value.trim();
  }

  private async assertProviderLineAccountIdentity(
    identityId: string | null,
    providerCode: string,
    required: boolean,
  ): Promise<void> {
    if (!identityId) {
      if (required) {
        throw new BadRequestException(
          '开启供应商履约前必须绑定供应商账户身份',
        );
      }
      return;
    }
    const identity = await this.prisma.providerAccountIdentity.findUnique({
      where: { id: identityId },
      select: PROVIDER_ACCOUNT_IDENTITY_EVIDENCE_SELECT,
    });
    try {
      validateProviderAccountIdentityForProvider(identity, providerCode);
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new BadRequestException(`供应商线路账户身份无效: ${detail}`);
    }
  }

  private async syncProviderLineRuntime(
    line: {
      id: string;
      code: string;
    },
    action: 'create' | 'update' | 'delete',
  ): Promise<PublisherAcceptedResponse> {
    const response = await this.publisherSync.syncOpsTopologyFreshRequired();
    const count = await this.publisherSync.syncApiKeysByCodingPlanProviderLineRequired({
      id: line.id,
      code: line.code,
    });
    this.logger.log(
      `re-synced ${count} api key(s) after CodingPlan provider line ${action} line=${line.code}`,
    );
    return response;
  }

  private publisherSyncFromResponses(responses: Array<PublisherAcceptedResponse | undefined>): ProviderLinePublisherSync {
    const warnings = responses.flatMap((response) => response?.warnings ?? []);
    return {
      ok: true,
      status: 'ACCEPTED',
      ...(warnings.length ? { warnings } : {}),
    };
  }

  private sanitizeProviderResponse(payload: Record<string, unknown>): Prisma.InputJsonObject {
    const clone = JSON.parse(JSON.stringify(payload)) as Record<string, unknown>;
    const data = this.objectValue(clone.data);
    if (data.apiKey) data.apiKey = this.keyPrefix(String(data.apiKey));
    if (data.secretKey) data.secretKey = this.keyPrefix(String(data.secretKey));
    if (clone.data && typeof clone.data === 'object') clone.data = data;
    return clone as Prisma.InputJsonObject;
  }

  private parseProviderDate(value: string | null): Date | null {
    if (!value) return null;
    const normalized = value.trim().includes('T') ? value.trim() : value.trim().replace(' ', 'T');
    const date = new Date(/[zZ]|[+-]\d{2}:\d{2}$/.test(normalized) ? normalized : `${normalized}+08:00`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private decimalValue(value: unknown): string | null {
    if (value === undefined || value === null || value === '') return null;
    const text = String(value);
    const number = Number(text);
    if (!Number.isFinite(number)) return null;
    return text;
  }

  private async dedicatedEndpointsJson(
    value: unknown,
    body: Record<string, unknown>,
    context: ProviderLineWriteContext,
    db: PrismaWriteClient = this.prisma,
  ): Promise<{
    value: Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined;
    productIds: string[];
  }> {
    if (value === undefined) return { value: undefined, productIds: [] };
    if (value === null || value === '') return { value: Prisma.JsonNull, productIds: [] };
    const parsed = this.parseJsonIfString(value, 'dedicatedEndpoints');
    if (!Array.isArray(parsed)) {
      throw new BadRequestException('dedicatedEndpoints 必须是数组');
    }

    const seenProtocols = new Set<string>();
    const productIds = new Set<string>();
    const dedicatedProductId = this.optionalText(body.dedicatedProductId ?? body.dedicated_product_id);
    const normalized: Prisma.InputJsonObject[] = [];
    const pendingRuntimeUpserts: Array<{
      endpointRefs: Record<string, unknown>[];
      productId: string;
      config: DedicatedRuntimeEndpointConfig;
      cacheKey?: string;
    }> = [];
    for (const [index, item] of parsed.entries()) {
      if (!item || typeof item !== 'object' || Array.isArray(item)) {
        throw new BadRequestException(`dedicatedEndpoints[${index}] 必须是对象`);
      }
      const endpoint = item as Record<string, unknown>;
      const label = `dedicatedEndpoints[${index}]`;
      const clientProtocol = this.normalizeDedicatedToken(
        this.requiredText(endpoint.client_protocol ?? endpoint.clientProtocol, `${label}.client_protocol`),
      );
      if (!DEDICATED_CLIENT_PROTOCOLS.has(clientProtocol)) {
        throw new BadRequestException(`${label}.client_protocol 只支持 anthropic / openai / responses`);
      }

      const providerId = this.optionalText(endpoint.provider_id ?? endpoint.providerId);
      const protocolStrategy = this.optionalDedicatedEnum(
        endpoint.protocol_strategy ?? endpoint.protocolStrategy,
        DEDICATED_PROTOCOL_CHANNEL_SET,
        `${label}.protocol_strategy`,
        'passthrough / responses_to_chat / anthropic_to_chat',
      ) as DedicatedProtocolChannel | undefined;
      const baseUrl = this.optionalText(endpoint.base_url ?? endpoint.baseUrl ?? endpoint.endpoint);
      const providerProfile = this.optionalProviderProfile(endpoint.provider_profile ?? endpoint.providerProfile, `${label}.provider_profile`);
      if (endpoint.client_compatibility !== undefined || endpoint.clientCompatibility !== undefined) {
        throw new BadRequestException(`${label}.client_compatibility 已废弃；请改用 served_inbound_protocols`);
      }
      const explicitServedInboundProtocols = this.optionalServedInboundProtocols(
        endpoint.served_inbound_protocols ?? endpoint.servedInboundProtocols,
        `${label}.served_inbound_protocols`,
      );
      const paths = this.dedicatedProtocolPathsForEndpoint(
        endpoint,
        clientProtocol,
        protocolStrategy,
        explicitServedInboundProtocols,
        label,
      );
      const servedInboundProtocols = servedInboundProtocolsForProtocolPaths(paths);
      const capabilities = this.optionalEnumArray(
        endpoint.capabilities,
        DEDICATED_CAPABILITIES,
        `${label}.capabilities`,
      );
      const tokenCountStrategy = this.optionalDedicatedEnum(
        endpoint.token_count_strategy ?? endpoint.tokenCountStrategy,
        DEDICATED_TOKEN_COUNT_STRATEGIES,
        `${label}.token_count_strategy`,
        'publisher token_count_strategies',
      );
      const name = this.optionalText(endpoint.name);
      const code = this.optionalText(endpoint.code);
      const ownedBy = this.optionalText(endpoint.owned_by ?? endpoint.ownedBy);
      const status = this.optionalDedicatedEnum(
        endpoint.status,
        new Set(['active', 'disabled']),
        `${label}.status`,
        'active / disabled',
      );
      const priority = this.optionalPositiveInteger(endpoint.priority, `${label}.priority`);
      const weight = this.optionalPositiveInteger(endpoint.weight, `${label}.weight`);
      if (endpoint.owner_scope !== undefined || endpoint.ownerScope !== undefined) {
        throw new BadRequestException(
          `${label}.owner_scope 由转售权益 tenant/product/entitlement 自动派生，provider line 禁止配置静态 owner_scope`,
        );
      }
      const hasRuntimeConfig = Boolean(
        baseUrl
        || providerProfile
        || capabilities.length
        || tokenCountStrategy
        || name
        || code
        || ownedBy
        || status
        || priority
        || weight
      );
      if (hasRuntimeConfig && (!baseUrl || !providerProfile)) {
        throw new BadRequestException(
          `${label} 发布 dedicated runtime provider 时必须配置 base_url / provider_profile`,
        );
      }

      const endpointRefs = paths.map((path) => {
        const protocol = path.inbound_protocol;
        if (!DEDICATED_CLIENT_PROTOCOLS.has(protocol)) {
          throw new BadRequestException(`${label}.paths[].inbound_protocol 只支持 anthropic / openai / responses`);
        }
        if (seenProtocols.has(protocol)) {
          throw new BadRequestException(`dedicatedEndpoints client_protocol 不能重复: ${protocol}`);
        }
        seenProtocols.add(protocol);
        const endpointRef: Record<string, unknown> = {
          client_protocol: protocol,
          protocol_strategy: path.channel,
        };
        return endpointRef;
      });
      if (hasRuntimeConfig) {
        pendingRuntimeUpserts.push({
          endpointRefs,
          productId: this.requiredDedicatedProductId(
            this.optionalText(endpoint.product_id ?? endpoint.productId) ?? dedicatedProductId,
            label,
          ),
          config: {
            label,
            providerId,
            baseUrl: baseUrl as string,
            providerProfile: providerProfile as ProviderProfile,
            name,
            code,
            ownedBy,
            servedInboundProtocols,
            paths,
            capabilities,
            tokenCountStrategy,
            status,
            priority,
            weight,
          },
        });
      } else {
        const existingProviderId = this.existingDedicatedProviderId(providerId, `${label}.provider_id`);
        for (const endpointRef of endpointRefs) {
          endpointRef.provider_id = existingProviderId;
        }
      }
      normalized.push(...(endpointRefs as Prisma.InputJsonObject[]));
    }
    const servedInboundProtocolsByCacheKey = new Map<string, ServedInboundProtocol[]>();
    const pathsByCacheKey = new Map<string, ProtocolPath[]>();
    for (const pending of pendingRuntimeUpserts) {
      const cacheKey = this.dedicatedRuntimeCacheKey(pending.productId, context, pending.config);
      pending.cacheKey = cacheKey;
      servedInboundProtocolsByCacheKey.set(
        cacheKey,
        this.mergeServedInboundProtocols(
          servedInboundProtocolsByCacheKey.get(cacheKey) ?? [],
          pending.config.servedInboundProtocols,
        ),
      );
      pathsByCacheKey.set(
        cacheKey,
        this.mergeProtocolPaths(
          pathsByCacheKey.get(cacheKey) ?? [],
          pending.config.paths,
        ),
      );
    }
    const generatedProviderIds = new Map<string, string>();
    for (const pending of pendingRuntimeUpserts) {
      const cacheKey = pending.cacheKey ?? this.dedicatedRuntimeCacheKey(pending.productId, context, pending.config);
      let providerId = generatedProviderIds.get(cacheKey);
      if (!providerId) {
        const mergedConfig = {
          ...pending.config,
          servedInboundProtocols: servedInboundProtocolsByCacheKey.get(cacheKey) ?? pending.config.servedInboundProtocols,
          paths: pathsByCacheKey.get(cacheKey) ?? pending.config.paths,
        };
        providerId = await this.upsertDedicatedRuntimeProvider(
          pending.productId,
          context,
          mergedConfig,
          db,
        );
        generatedProviderIds.set(cacheKey, providerId);
      }
      for (const endpointRef of pending.endpointRefs) {
        endpointRef.provider_id = providerId;
      }
      productIds.add(pending.productId);
    }
    return { value: normalized as Prisma.InputJsonArray, productIds: [...productIds] };
  }

  private existingDedicatedProviderId(providerId: string | null, field: string): string {
    if (!providerId) {
      throw new BadRequestException(`${field} 不能为空；新增端点请填写 base_url / provider_profile，由后端生成 provider_id`);
    }
    if (!providerId.startsWith('pc_')) {
      throw new BadRequestException(`${field} 必须是已发布的 pc_* Runtime Provider，禁止裸 provider id`);
    }
    return providerId;
  }

  private requiredDedicatedProductId(productId: string | null, label: string): string {
    if (!productId) {
      throw new BadRequestException(`${label}.dedicatedProductId 不能为空；保存 dedicated 端点时必须选择转售产品`);
    }
    return productId;
  }

  private optionalProviderProfile(value: unknown, field: string): ProviderProfile | undefined {
    const text = this.optionalText(value);
    if (!text) return undefined;
    try {
      return normalizeProviderProfileValue(text) ?? undefined;
    } catch (err) {
      throw new BadRequestException(`${field} ${(err as Error).message}`);
    }
  }

  private optionalServedInboundProtocols(value: unknown, field: string): ServedInboundProtocol[] {
    try {
      return normalizeServedInboundProtocolListValue(value) ?? [];
    } catch (err) {
      throw new BadRequestException(`${field} ${(err as Error).message}`);
    }
  }

  private dedicatedProtocolPathsForEndpoint(
    endpoint: Record<string, unknown>,
    upstreamProtocol: string,
    requestedChannel: DedicatedProtocolChannel | undefined,
    servedInboundProtocols: ServedInboundProtocol[],
    label: string,
  ): ProtocolPath[] {
    const explicitPaths = this.optionalProtocolPaths(
      endpoint.paths ?? endpoint.protocol_paths ?? endpoint.protocolPaths,
      `${label}.paths`,
    );
    if (explicitPaths.length > 0) return explicitPaths;
    const protocols = servedInboundProtocols.length
      ? servedInboundProtocols
      : [upstreamProtocol as ServedInboundProtocol];
    return protocols.map((protocol) => ({
      inbound_protocol: protocol,
      channel: requestedChannel ?? this.defaultDedicatedProtocolChannel(upstreamProtocol, protocol),
    }));
  }

  private optionalProtocolPaths(value: unknown, field: string): ProtocolPath[] {
    try {
      return normalizeProtocolPathListValue(value) ?? [];
    } catch (err) {
      throw new BadRequestException(`${field} ${(err as Error).message}`);
    }
  }

  private defaultDedicatedProtocolChannel(
    upstreamProtocol: string,
    inboundProtocol: ServedInboundProtocol,
  ): DedicatedProtocolChannel {
    if (upstreamProtocol === inboundProtocol) return 'passthrough';
    if (upstreamProtocol === 'openai' && inboundProtocol === 'responses') return 'responses_to_chat';
    if (upstreamProtocol === 'openai' && inboundProtocol === 'anthropic') return 'anthropic_to_chat';
    return 'passthrough';
  }

  private mergeServedInboundProtocols(
    left: ServedInboundProtocol[],
    right: ServedInboundProtocol[],
  ): ServedInboundProtocol[] {
    return normalizeServedInboundProtocolListValue([...left, ...right]) ?? [];
  }

  private mergeProtocolPaths(left: ProtocolPath[], right: ProtocolPath[]): ProtocolPath[] {
    const seen = new Set<string>();
    const out: ProtocolPath[] = [];
    for (const path of [...left, ...right]) {
      const key = `${path.inbound_protocol}:${path.channel}`;
      if (seen.has(key)) continue;
      seen.add(key);
      out.push(path);
    }
    return out;
  }

  private async upsertDedicatedRuntimeProvider(
    productId: string,
    context: ProviderLineWriteContext,
    config: DedicatedRuntimeEndpointConfig,
    db: PrismaWriteClient = this.prisma,
  ): Promise<string> {
    await this.ensureDedicatedRuntimeProduct(productId, db);

    const baseUrl = this.runtimeBaseUrl(config.baseUrl);
    const identityHash = this.dedicatedRuntimeIdentityHash(productId, context, {
      ...config,
      baseUrl,
    });
    const existingProductChannelId = config.providerId ? this.providerIdToProductChannelId(config.providerId, config.label) : null;
    const existingProductChannel = existingProductChannelId
      ? await db.productChannel.findFirst({
          where: { id: existingProductChannelId, productId, deletedAt: null },
          select: { id: true, channelId: true, metadata: true, providerLineId: true },
        })
      : null;
    if (existingProductChannelId && !existingProductChannel) {
      throw new BadRequestException(`${config.label}.provider_id 不属于当前转售产品的 dedicated runtime provider`);
    }
    if (existingProductChannel && !this.isDedicatedProductChannelMetadata(existingProductChannel.metadata)) {
      throw new BadRequestException(`${config.label}.provider_id 不是 dedicated-only ProductChannel`);
    }
    if (
      existingProductChannel?.providerLineId
      && existingProductChannel.providerLineId !== context.lineId
    ) {
      throw new BadRequestException(`${config.label}.provider_id 已绑定到其他供应商线路`);
    }

    const productChannelId = existingProductChannel?.id ?? `dpc_${identityHash}`;
    const channelId = existingProductChannel?.channelId ?? `dch_${identityHash}`;
    const template = buildChannelProtocolTemplates().find((item) => item.providerProfile === config.providerProfile);
    const sdkType = template?.sdkType ?? config.providerProfile;
    const clientCompatibility = defaultClientCompatibilityForProfile(config.providerProfile);
    const tokenCountStrategy = config.tokenCountStrategy
      ?? defaultTokenCountStrategyForProfile(config.providerProfile)
      ?? null;
    const status = config.status ?? 'active';
    const priority = config.priority ?? 100;
    const weight = config.weight ?? 100;
    const displayName = config.name
      ?? `${context.lineCode} ${this.providerProfileDisplayName(config.providerProfile)}`;
    const ownedBy = config.ownedBy ?? context.providerCode;
    const runtimeModels: string[] = [];
    const modelsJson = JSON.stringify(runtimeModels);
    const clientCompatibilityJson = JSON.stringify(clientCompatibility);
    const servedInboundProtocolsJson = JSON.stringify(config.servedInboundProtocols);
    const protocolPathsJson = config.paths as unknown as Prisma.InputJsonArray;
    const metadata = this.dedicatedProductChannelMetadata(productId, context, config, identityHash);

    await db.channel.upsert({
      where: { id: channelId },
      create: {
        id: channelId,
        name: displayName,
        provider: context.providerCode,
        baseUrl,
        apiKeyEncrypted: this.dedicatedRuntimePlaceholderKey(identityHash),
        models: modelsJson,
        sdkType,
        providerProfile: config.providerProfile,
        clientCompatibility: clientCompatibilityJson,
        servedInboundProtocols: servedInboundProtocolsJson,
        protocolPaths: protocolPathsJson,
        tokenCountStrategy,
        ownedBy,
        priority,
        weight,
        status,
        remark: DEDICATED_RESALE_SYSTEM_REMARK,
        isActive: status !== 'disabled',
      },
      update: {
        name: displayName,
        provider: context.providerCode,
        baseUrl,
        models: modelsJson,
        sdkType,
        providerProfile: config.providerProfile,
        clientCompatibility: clientCompatibilityJson,
        servedInboundProtocols: servedInboundProtocolsJson,
        protocolPaths: protocolPathsJson,
        tokenCountStrategy,
        ownedBy,
        priority,
        weight,
        status,
        remark: DEDICATED_RESALE_SYSTEM_REMARK,
        isActive: status !== 'disabled',
        deletedAt: null,
      },
    });

    await db.productChannel.upsert({
      where: { id: productChannelId },
      create: {
        id: productChannelId,
        productId,
        channelId,
        displayName,
        status,
        isDefault: false,
        allowedModels: runtimeModels as Prisma.InputJsonArray,
        deniedModels: Prisma.JsonNull,
        priority,
        weight,
        metadata,
        providerLineId: context.lineId,
      },
      update: {
        channelId,
        displayName,
        status,
        isDefault: false,
        allowedModels: runtimeModels as Prisma.InputJsonArray,
        deniedModels: Prisma.JsonNull,
        priority,
        weight,
        metadata,
        providerLineId: context.lineId,
        deletedAt: null,
      },
    });

    return `pc_${productChannelId}`;
  }

  private async ensureDedicatedRuntimeProduct(
    productId: string,
    db: PrismaWriteClient = this.prisma,
  ): Promise<void> {
    const product = await db.product.findUnique({
      where: { id: productId },
      select: {
        id: true,
        billingMode: true,
        codingPlanFulfillmentMode: true,
        deletedAt: true,
      },
    });
    if (!product || product.deletedAt) {
      throw new BadRequestException('转售产品不存在');
    }
    if (
      product.billingMode !== ProductBillingMode.CODING_PLAN
      || product.codingPlanFulfillmentMode !== CodingPlanFulfillmentMode.provider_resale
    ) {
      throw new BadRequestException('dedicated runtime provider 只能挂在 provider_resale CodingPlan 产品下');
    }
    await db.productRuntimePolicy.upsert({
      where: { productId },
      create: {
        productId,
        credentialSource: 'dedicated_upstream',
        allowedProviderIds: [],
        allowedChannelIds: [],
        modelScopeMode: 'plan_configured',
        allowedModels: [],
        fallbackPolicy: 'within_product',
        runtimeBillingMode: 'included_upstream',
        routeStrategy: null,
        status: 'active',
      },
      update: {
        credentialSource: 'dedicated_upstream',
        runtimeBillingMode: 'included_upstream',
        revision: { increment: 1 },
      },
    });
  }

  private async syncDedicatedRuntimeProducts(productIds: string[]): Promise<PublisherAcceptedResponse[]> {
    const uniqueProductIds = [...new Set(productIds)].filter(Boolean).sort();
    const responses: PublisherAcceptedResponse[] = [];
    for (const productId of uniqueProductIds) {
      responses.push(await this.publisherSync.syncRuntimeIntentAfterProductPolicyChangeRequired(productId));
    }
    return responses;
  }

  private providerIdToProductChannelId(providerId: string, label: string): string {
    if (!providerId.startsWith('pc_')) {
      throw new BadRequestException(`${label}.provider_id 必须是 pc_<ProductChannelId>`);
    }
    const productChannelId = providerId.slice(3).trim();
    if (!productChannelId) {
      throw new BadRequestException(`${label}.provider_id 必须是 pc_<ProductChannelId>`);
    }
    return productChannelId;
  }

  private dedicatedRuntimeCacheKey(
    productId: string,
    context: ProviderLineWriteContext,
    config: DedicatedRuntimeEndpointConfig,
  ): string {
    if (config.providerId) return `${productId}:${config.providerId}`;
    const baseUrl = this.runtimeBaseUrl(config.baseUrl);
    return `${productId}:${this.dedicatedRuntimeIdentityHash(productId, context, {
      ...config,
      baseUrl,
    })}`;
  }

  private isDedicatedProductChannelMetadata(metadata: unknown): boolean {
    const raw = this.objectValue(metadata);
    const isolation = this.objectValue(raw.provider_isolation ?? raw.providerIsolation ?? raw.runtime_provider_isolation);
    const visibility = this.optionalText(isolation.visibility);
    const credentialSource = this.optionalText(isolation.credential_source ?? isolation.credentialSource);
    const routeKinds = this.optionalStringArray(isolation.allowed_route_kinds ?? isolation.allowedRouteKinds, 'provider_isolation.allowed_route_kinds');
    return visibility === 'dedicated_only'
      || credentialSource === 'dedicated_upstream'
      || routeKinds.includes('dedicated_route');
  }

  private dedicatedProductChannelMetadata(
    productId: string,
    context: ProviderLineWriteContext,
    config: DedicatedRuntimeEndpointConfig,
    identityHash: string,
  ): Prisma.InputJsonObject {
    const dedicatedRuntime: Prisma.InputJsonObject = {
      identity_hash: identityHash,
      provider_profile: config.providerProfile,
      base_url: this.runtimeBaseUrl(config.baseUrl),
      ...(config.servedInboundProtocols.length ? { served_inbound_protocols: config.servedInboundProtocols } : {}),
      ...(config.paths.length ? { paths: config.paths as unknown as Prisma.InputJsonArray } : {}),
      ...(config.capabilities.length ? { capabilities: config.capabilities } : {}),
    };
    const metadata: Prisma.InputJsonObject = {
      provider_isolation: {
        visibility: 'dedicated_only',
        credential_source: 'dedicated_upstream',
        allowed_route_kinds: ['dedicated_route'],
        owner_scope: { product_id: productId },
      },
      provider_line: {
        id: context.lineId,
        code: context.lineCode,
        provider_code: context.providerCode,
      },
      dedicated_runtime: dedicatedRuntime,
    };
    return metadata;
  }

  private dedicatedRuntimeIdentityHash(
    productId: string,
    context: ProviderLineWriteContext,
    config: DedicatedRuntimeEndpointConfig,
  ): string {
    const identity = {
      productId,
      providerLineId: context.lineId,
      providerCode: context.providerCode,
      baseUrl: config.baseUrl.replace(/\/+$/, ''),
      providerProfile: config.providerProfile,
    };
    return createHash('sha256').update(JSON.stringify(identity)).digest('hex').slice(0, 24);
  }

  private runtimeBaseUrl(baseUrl: string): string {
    return baseUrl.replace(/\/+$/, '');
  }

  private dedicatedRuntimePlaceholderKey(identityHash: string): string {
    const value = `dedicated-upstream-placeholder:${identityHash}`;
    const encryptionKey = resolveEncryptionKey(this.config);
    return encryptionKey ? encrypt(value, encryptionKey) : value;
  }

  private providerProfileDisplayName(profile: string): string {
    return profile.replace(/_/g, ' ');
  }

  private parseJsonIfString(value: unknown, field: string): unknown {
    if (typeof value !== 'string') return value;
    const trimmed = value.trim();
    if (!trimmed) return null;
    try {
      return JSON.parse(trimmed);
    } catch {
      throw new BadRequestException(`${field} 必须是合法 JSON`);
    }
  }

  private optionalDedicatedEnum(
    value: unknown,
    allowed: Set<string>,
    field: string,
    allowedLabel: string,
  ): string | undefined {
    const text = this.optionalText(value);
    if (!text) return undefined;
    const normalized = this.normalizeDedicatedToken(text);
    if (!allowed.has(normalized)) {
      throw new BadRequestException(`${field} 只支持 ${allowedLabel}`);
    }
    return normalized;
  }

  private optionalEnumArray(value: unknown, allowed: Set<string>, field: string): string[] {
    return this.optionalStringArray(value, field).map((item) => {
      const normalized = this.normalizeDedicatedToken(item);
      if (!allowed.has(normalized)) {
        throw new BadRequestException(`${field} 包含不支持的值: ${item}`);
      }
      return normalized;
    });
  }

  private optionalStringArray(value: unknown, field: string): string[] {
    if (value === undefined || value === null || value === '') return [];
    const parsed = this.parseJsonIfString(value, field);
    if (!Array.isArray(parsed)) {
      throw new BadRequestException(`${field} 必须是字符串数组`);
    }
    return parsed
      .map((item) => {
        if (typeof item !== 'string') throw new BadRequestException(`${field} 必须是字符串数组`);
        return item.trim();
      })
      .filter(Boolean);
  }

  private optionalPositiveInteger(value: unknown, field: string): number | undefined {
    if (value === undefined || value === null || value === '') return undefined;
    const number = Number(value);
    if (!Number.isInteger(number) || number <= 0) {
      throw new BadRequestException(`${field} 必须是正整数`);
    }
    return number;
  }

  private normalizeDedicatedToken(value: string): string {
    return value.trim().toLowerCase().replace(/[\s-]+/g, '_');
  }

  private jsonObject(
    value: unknown,
  ): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined {
    if (value === undefined) return undefined;
    if (value === null) return Prisma.JsonNull;
    if (typeof value !== 'object' || Array.isArray(value)) {
      throw new BadRequestException('JSON 字段必须是对象');
    }
    return value as Prisma.InputJsonObject;
  }

  private objectValue(value: unknown): Record<string, unknown> {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : {};
  }

  private requiredText(value: unknown, field: string): string {
    const text = this.optionalText(value);
    if (!text) throw new BadRequestException(`${field} 不能为空`);
    return text;
  }

  private optionalText(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
  }

  private keyPrefix(value: string): string {
    return value.length <= 10 ? value : value.slice(0, 10);
  }
}
