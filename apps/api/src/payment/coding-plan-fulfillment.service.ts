import { Injectable, Logger, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CodingPlanFulfillmentMode, Prisma, ProductBillingMode } from '@prisma/client';
import { CodingPlanProviderAdapterRegistry } from '../billing/coding-plan-provider-adapter.registry';
import {
  CodingPlanProviderEntitlementAttemptService,
  ProviderEntitlementAttemptClaim,
  ProviderEntitlementReservation,
} from '../billing/coding-plan-provider-entitlement-attempt.service';
import { CodingPlanProviderLineService } from '../billing/coding-plan-provider-line.service';
import { CodingPlanResaleRouteService } from '../billing/coding-plan-resale-route.service';
import {
  ProviderCreateOrderResult,
  ProviderLineRuntimeConfig,
} from '../billing/coding-plan-provider.types';
import { encrypt } from '../common/utils/crypto';
import { resolveEncryptionKey } from '../common/utils/encryption-key';
import { PrismaService } from '../prisma/prisma.service';
import {
  validateProviderResaleRouteGroupAccountIdentity,
} from '../provider-account-identity/provider-account-identity.policy';

type ProviderResaleSelection = {
  routeId: string;
  providerLineId: string;
  providerLineCode: string;
  providerCode: string;
  adapterType: string;
  upstreamProductId: string;
};

type FulfillmentProviderLine = ProviderLineRuntimeConfig & {
  providerAccountIdentityId: string;
};

type ProviderResaleLineBinding = ProviderResaleSelection & {
  line: FulfillmentProviderLine;
  role: 'primary' | 'runtime';
};

type FulfillSubscriptionOrderInput = {
  orderId: string;
  userId: string;
  tenantId: string;
  productId: string;
  planId: string;
  subscriptionId?: string | null;
  amountCents?: number | null;
  currency?: string | null;
  market?: string | null;
  salesChannel?: string | null;
  userSegmentId?: string | null;
  userSegmentIds?: string[] | null;
};

@Injectable()
export class CodingPlanFulfillmentService {
  private readonly logger = new Logger(CodingPlanFulfillmentService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly resaleRoutes: CodingPlanResaleRouteService,
    private readonly providerLines: CodingPlanProviderLineService,
    private readonly adapterRegistry: CodingPlanProviderAdapterRegistry,
    private readonly entitlementAttempts: CodingPlanProviderEntitlementAttemptService,
  ) {}

  async fulfillSubscriptionOrder(input: FulfillSubscriptionOrderInput): Promise<'activated' | 'already_active' | 'skipped'> {
    const plan = await this.prisma.plan.findUnique({
      where: { id: input.planId },
      select: {
        id: true,
        productId: true,
        name: true,
        product: { select: { id: true, billingMode: true, codingPlanFulfillmentMode: true } },
      },
    });
    if (!plan || plan.productId !== input.productId) return 'skipped';
    if (plan.product?.billingMode !== ProductBillingMode.CODING_PLAN) return 'skipped';
    if (plan.product.codingPlanFulfillmentMode !== CodingPlanFulfillmentMode.provider_resale) return 'skipped';

    const resaleSelections = await this.resolveResaleSelections(input);

    const existing = await this.prisma.codingPlanProviderEntitlement.findUnique({
      where: { orderId: input.orderId },
      select: { status: true, subscriptionId: true },
    });
    if (existing?.status === 'ACTIVE') {
      if (input.subscriptionId && existing.subscriptionId !== input.subscriptionId) {
        await this.prisma.codingPlanProviderEntitlement.update({
          where: { orderId: input.orderId },
          data: { subscriptionId: input.subscriptionId },
        });
      }
      return 'already_active';
    }

    const bindings = await this.resolveProviderLineBindings(resaleSelections);
    const primary = bindings[0];
    const partnerUserId = this.providerReferenceId(input.userId);
    const partnerOrderNo = this.providerReferenceId(input.orderId);
    const baseRecord: ProviderEntitlementReservation = {
      orderId: input.orderId,
      subscriptionId: input.subscriptionId ?? null,
      userId: input.userId,
      tenantId: input.tenantId,
      productId: input.productId,
      planId: input.planId,
      providerLineId: primary.line.id,
      providerLineCode: primary.line.code,
      providerCode: primary.line.providerCode,
      providerAccountIdentityId: primary.line.providerAccountIdentityId,
      adapterType: primary.line.adapterType,
      upstreamProductId: primary.upstreamProductId,
      partnerUserId,
      partnerOrderNo,
      provider: primary.line.providerCode,
    };
    const claim = await this.claimProviderEntitlement(baseRecord);
    if (claim.status === 'active') return 'already_active';
    if (claim.status === 'busy') {
      throw new ServiceUnavailableException('供应商履约正在进行，请稍后重试');
    }
    if (claim.status === 'ineligible') {
      throw new ServiceUnavailableException(
        `供应商履约记录状态 ${claim.entitlementStatus} 不允许重试`,
      );
    }

    try {
      const prepared = await this.entitlementAttempts.prepareForUpstreamIfCurrent(
        claim.providerEntitlementId,
        claim.attemptId,
        baseRecord,
      );
      if (!prepared) {
        const currentStatus = await this.entitlementAttempts.currentStatus(
          claim.providerEntitlementId,
        );
        if (currentStatus === 'ACTIVE') return 'already_active';
        throw new ServiceUnavailableException(
          '供应商履约尝试已被更新，未调用上游',
        );
      }
      const encryptionKey = resolveEncryptionKey(this.config);
      if (!encryptionKey) {
        throw new ServiceUnavailableException('ENCRYPTION_KEY 未配置，不能保存供应商上游 key');
      }
      const response = await this.createProviderOrder(primary.line, {
        partnerUserId,
        partnerOrderNo,
        upstreamProductId: primary.upstreamProductId,
      });
      const credentialFormat = this.credentialFormat(response);

      const activated = await this.entitlementAttempts.activateIfCurrent(
        claim.providerEntitlementId,
        claim.attemptId,
        {
          upstreamOrderId: this.responseOrderId(response),
          upstreamApiKeyEncrypted: response.apiKey ? encrypt(response.apiKey, encryptionKey) : null,
          upstreamApiKeyPrefix: response.apiKey ? this.keyPrefix(response.apiKey) : null,
          upstreamSecretKeyEncrypted: response.secretKey ? encrypt(response.secretKey, encryptionKey) : null,
          upstreamSecretKeyPrefix: response.secretKey ? this.keyPrefix(response.secretKey) : null,
          credentialFormat,
          productStartTime: this.parseProviderDate(response.productStartTime),
          productEndTime: this.parseProviderDate(response.productEndTime),
          responseSnapshot: this.providerResponseSnapshot(response.raw, bindings),
          activatedAt: new Date(),
        },
      );
      if (!activated) {
        const currentStatus = await this.entitlementAttempts.currentStatus(
          claim.providerEntitlementId,
        );
        if (currentStatus === 'ACTIVE') return 'already_active';
        throw new ServiceUnavailableException(
          '供应商履约尝试已被更新，忽略当前上游响应',
        );
      }
      this.logger.log(
        `coding plan provider activation success order=${input.orderId} line=${baseRecord.providerLineCode} route_count=${bindings.length} upstreamProduct=${primary.upstreamProductId} upstreamOrder=${this.responseOrderId(response) ?? 'n/a'}`,
      );
      return 'activated';
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      this.logger.error(
        `coding plan provider activation failed order=${input.orderId} line=${baseRecord.providerLineCode}: ${message}`,
      );
      const failureRecorded = await this.entitlementAttempts.failIfCurrent(
        claim.providerEntitlementId,
        claim.attemptId,
        message,
      ).catch((auditError) => {
        this.logger.warn(
          `coding plan provider entitlement failure audit failed order=${input.orderId}: ${
            auditError instanceof Error ? auditError.message : String(auditError)
          }`,
        );
        return false;
      });
      if (!failureRecorded) {
        const currentStatus = await this.entitlementAttempts.currentStatus(
          claim.providerEntitlementId,
        ).catch(() => null);
        if (currentStatus === 'ACTIVE') return 'already_active';
      }
      throw error;
    }
  }

  private async resolveResaleSelections(input: FulfillSubscriptionOrderInput): Promise<ProviderResaleSelection[]> {
    const routes = await this.resaleRoutes.resolveRoutes({
      planId: input.planId,
      userId: input.userId,
      tenantId: input.tenantId,
      market: input.market,
      currency: input.currency,
      salesChannel: input.salesChannel,
      userSegmentId: input.userSegmentId,
      userSegmentIds: input.userSegmentIds,
    });
    const unique = new Map<string, ProviderResaleSelection>();
    for (const route of routes) {
      unique.set(`${route.providerLineId}:${route.upstreamProductId}`, {
        routeId: route.id,
        providerLineId: route.providerLineId,
        providerLineCode: route.providerLine.code,
        providerCode: route.providerLine.providerCode,
        adapterType: route.providerLine.adapterType,
        upstreamProductId: route.upstreamProductId,
      });
    }
    return Array.from(unique.values());
  }

  private async claimProviderEntitlement(
    reservation: ProviderEntitlementReservation,
  ): Promise<ProviderEntitlementAttemptClaim> {
    try {
      return await this.entitlementAttempts.claimForOrder(reservation);
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

  private async resolveProviderLineBindings(
    selections: ProviderResaleSelection[],
  ): Promise<ProviderResaleLineBinding[]> {
    if (selections.length === 0) {
      throw new ServiceUnavailableException('当前套餐没有可用供应商转售线路');
    }
    const bindings: ProviderResaleLineBinding[] = [];
    for (const selection of selections) {
      const line = await this.resolveProviderLine(selection);
      bindings.push({
        ...selection,
        line,
        role: bindings.length === 0 ? 'primary' : 'runtime',
      });
    }
    const primary = bindings[0];
    try {
      validateProviderResaleRouteGroupAccountIdentity(
        bindings.map((binding) => binding.line),
        {
          requireIdentity: true,
          expectedProviderAccountIdentityId: primary.line.providerAccountIdentityId,
        },
      );
    } catch (error) {
      throw new ServiceUnavailableException(
        error instanceof Error ? error.message : String(error),
      );
    }
    for (const binding of bindings.slice(1)) {
      if (
        binding.line.providerCode !== primary.line.providerCode
        || binding.line.adapterType !== primary.line.adapterType
        || binding.upstreamProductId !== primary.upstreamProductId
      ) {
        throw new ServiceUnavailableException(
          '同一三方转售套餐的多线路绑定必须共享供应商、适配器和上游产品',
        );
      }
    }
    return bindings;
  }

  private async resolveProviderLine(
    resale: ProviderResaleSelection,
  ): Promise<FulfillmentProviderLine> {
    return this.providerLines.getForFulfillment(resale.providerLineId);
  }

  private async createProviderOrder(
    line: ProviderLineRuntimeConfig,
    input: {
      partnerUserId: string;
      partnerOrderNo: string;
      upstreamProductId: string;
    },
  ): Promise<ProviderCreateOrderResult> {
    const adapter = this.adapterRegistry.get(line.adapterType);
    return adapter.createOrder(line, input);
  }

  private responseOrderId(response: ProviderCreateOrderResult): string | null {
    return response.upstreamOrderId;
  }

  private credentialFormat(response: ProviderCreateOrderResult): string {
    return response.credentialFormat;
  }

  private providerResponseSnapshot(
    payload: Record<string, unknown>,
    bindings: ProviderResaleLineBinding[],
  ): Prisma.InputJsonObject {
    const sanitized = this.sanitizeProviderResponse(payload) as Record<string, unknown>;
    return {
      ...sanitized,
      _resale_route_bindings: bindings.map((binding) => ({
        routeId: binding.routeId,
        role: binding.role,
        providerLineId: binding.line.id,
        providerLineCode: binding.line.code,
        providerCode: binding.line.providerCode,
        adapterType: binding.line.adapterType,
        upstreamProductId: binding.upstreamProductId,
      })),
    } as Prisma.InputJsonObject;
  }

  private sanitizeProviderResponse(payload: Record<string, unknown>): Prisma.InputJsonObject {
    return this.sanitizeProviderJson(payload) as Prisma.InputJsonObject;
  }

  private sanitizeProviderJson(value: unknown): unknown {
    if (Array.isArray(value)) return value.map((item) => this.sanitizeProviderJson(item));
    if (!value || typeof value !== 'object') return value;

    const result: Record<string, unknown> = {};
    for (const [key, item] of Object.entries(value as Record<string, unknown>)) {
      if (this.isSensitiveProviderKey(key) && typeof item === 'string') {
        result[key] = this.keyPrefix(item);
      } else {
        result[key] = this.sanitizeProviderJson(item);
      }
    }
    return result;
  }

  private isSensitiveProviderKey(key: string): boolean {
    const normalized = key.toLowerCase();
    return normalized === 'apikey'
      || normalized === 'secretkey'
      || normalized === 'api_key'
      || normalized === 'secret_key';
  }

  private parseProviderDate(value: string | null): Date | null {
    if (!value) return null;
    const trimmed = value.trim();
    const normalized = trimmed.includes('T') ? trimmed : trimmed.replace(' ', 'T');
    const date = new Date(/[zZ]|[+-]\d{2}:\d{2}$/.test(normalized) ? normalized : `${normalized}+08:00`);
    return Number.isNaN(date.getTime()) ? null : date;
  }

  private keyPrefix(value: string): string {
    return value.length <= 10 ? value : value.slice(0, 10);
  }

  private providerReferenceId(value: string): string {
    const trimmed = value.trim();
    return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(trimmed)
      ? trimmed.replace(/-/g, '')
      : trimmed;
  }
}
