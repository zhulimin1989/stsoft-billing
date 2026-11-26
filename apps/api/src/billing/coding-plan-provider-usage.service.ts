import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { PrismaService } from '../prisma/prisma.service';
import { resolveEncryptionKey } from '../common/utils/encryption-key';
import { CodingPlanProviderAdapterRegistry } from './coding-plan-provider-adapter.registry';
import { CodingPlanProviderLineService } from './coding-plan-provider-line.service';
import type { CodingPlanEntitlementView } from './billing.service';
import type { ProviderUsageQuotaProgress, ProviderUsageSummary } from './coding-plan-provider.types';
import { decryptCodingPlanProviderUpstreamCredentialParts } from './coding-plan-provider-upstream-credential';

export type CodingPlanProviderUsageStatus =
  | 'available'
  | 'not_applicable'
  | 'not_supported'
  | 'unavailable';

export type CodingPlanProviderUsageView = {
  status: CodingPlanProviderUsageStatus;
  quotaProgress: ProviderUsageQuotaProgress | null;
  level: string | null;
  usageSummary: ProviderUsageSummary | null;
  updatedAt: string | null;
  lastSyncedAt: string | null;
  lastError: string | null;
};

type EntitlementUsageTarget = Pick<
  CodingPlanEntitlementView,
  | 'id'
  | 'providerEntitlementId'
  | 'providerLineId'
  | 'providerLineCode'
  | 'fulfillmentMode'
  | 'status'
>;

type ProviderEntitlementForUsage = {
  id: string;
  status: string;
  providerLineId: string | null;
  providerLineCode: string | null;
  adapterType: string | null;
  upstreamProductId: string;
  upstreamOrderId: string | null;
  partnerUserId: string;
  partnerOrderNo: string;
  upstreamApiKeyEncrypted: string | null;
  upstreamSecretKeyEncrypted: string | null;
  productEndTime: Date | null;
};

@Injectable()
export class CodingPlanProviderUsageService {
  private readonly logger = new Logger(CodingPlanProviderUsageService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
    private readonly providerLines: CodingPlanProviderLineService,
    private readonly adapterRegistry: CodingPlanProviderAdapterRegistry,
  ) {}

  async getUsageForEntitlements(
    entitlements: EntitlementUsageTarget[],
  ): Promise<Map<string, CodingPlanProviderUsageView>> {
    const result = new Map<string, CodingPlanProviderUsageView>();
    const providerIds = Array.from(
      new Set(
        entitlements
          .filter((item) => item.fulfillmentMode === 'provider_resale')
          .map((item) => item.providerEntitlementId)
          .filter((id): id is string => Boolean(id)),
      ),
    );

    const providerEntitlements = providerIds.length
      ? await this.prisma.codingPlanProviderEntitlement.findMany({
          where: { id: { in: providerIds } },
          select: {
            id: true,
            status: true,
            providerLineId: true,
            providerLineCode: true,
            adapterType: true,
            upstreamProductId: true,
            upstreamOrderId: true,
            partnerUserId: true,
            partnerOrderNo: true,
            upstreamApiKeyEncrypted: true,
            upstreamSecretKeyEncrypted: true,
            productEndTime: true,
          },
        })
      : [];
    const providerById = new Map(providerEntitlements.map((item) => [item.id, item]));

    await Promise.all(
      entitlements.map(async (entitlement) => {
        if (entitlement.fulfillmentMode !== 'provider_resale') {
          return;
        }
        result.set(entitlement.id, await this.getUsageForEntitlement(entitlement, providerById));
      }),
    );

    return result;
  }

  private async getUsageForEntitlement(
    entitlement: EntitlementUsageTarget,
    providerById: Map<string, ProviderEntitlementForUsage>,
  ): Promise<CodingPlanProviderUsageView> {
    if (entitlement.status !== 'ACTIVE') {
      return this.unavailable('CodingPlan 权益尚未激活');
    }
    const providerEntitlement = entitlement.providerEntitlementId
      ? providerById.get(entitlement.providerEntitlementId)
      : null;
    if (!providerEntitlement) {
      return this.unavailable('CodingPlan 上游权益不存在');
    }
    if (providerEntitlement.status !== 'ACTIVE') {
      return this.unavailable('CodingPlan 上游权益尚未激活');
    }
    if (providerEntitlement.productEndTime && providerEntitlement.productEndTime.getTime() <= Date.now()) {
      return this.unavailable('CodingPlan 上游权益已过期');
    }

    try {
      const providerLineId = entitlement.providerLineId ?? providerEntitlement.providerLineId;
      if (!providerLineId) {
        return this.unavailable('CodingPlan 上游权益缺少供应商线路绑定');
      }
      const line = await this.providerLines.getForRuntime(providerLineId);
      const adapter = this.adapterRegistry.get(line.adapterType);
      if (!adapter.queryCustomerUsage) {
        return {
          status: 'not_supported',
          level: null,
          quotaProgress: null,
          usageSummary: null,
          updatedAt: null,
          lastSyncedAt: null,
          lastError: '供应商 adapter 未实现用量查询',
        };
      }

      const encryptionKey = resolveEncryptionKey(this.config);
      if (!encryptionKey) {
        return this.unavailable('ENCRYPTION_KEY 未配置，不能查询供应商用量');
      }
      const credential = decryptCodingPlanProviderUpstreamCredentialParts(providerEntitlement, encryptionKey);
      const usage = await adapter.queryCustomerUsage(line, {
        upstreamApiKey: credential.apiKey,
        upstreamSecretKey: credential.secretKey,
        upstreamProductId: providerEntitlement.upstreamProductId,
        upstreamOrderId: providerEntitlement.upstreamOrderId,
        partnerUserId: providerEntitlement.partnerUserId,
        partnerOrderNo: providerEntitlement.partnerOrderNo,
      });
      return {
        status: 'available',
        level: usage.level,
        quotaProgress: usage.quotaProgress,
        usageSummary: usage.usageSummary,
        updatedAt: usage.updatedAt,
        lastSyncedAt: new Date().toISOString(),
        lastError: null,
      };
    } catch (error) {
      const message = this.errorMessage(error);
      this.logger.warn(`query provider usage failed for entitlement ${entitlement.id}: ${message}`);
      return this.unavailable(message);
    }
  }

  private unavailable(message: string): CodingPlanProviderUsageView {
    return {
      status: 'unavailable',
      level: null,
      quotaProgress: null,
      usageSummary: null,
      updatedAt: null,
      lastSyncedAt: null,
      lastError: message,
    };
  }

  private errorMessage(error: unknown): string {
    if (error instanceof Error && error.message.trim()) return error.message;
    return '供应商用量查询失败';
  }
}
