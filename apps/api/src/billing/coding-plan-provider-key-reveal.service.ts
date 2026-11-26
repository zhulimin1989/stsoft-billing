import { BadRequestException, Injectable, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { decrypt } from '../common/utils/crypto';
import { resolveEncryptionKey } from '../common/utils/encryption-key';
import { PrismaService } from '../prisma/prisma.service';
import { BillingService } from './billing.service';

export type RevealedCodingPlanProviderKey = {
  providerEntitlementId: string;
  provider: string;
  upstreamProductId: string;
  credentialFormat: string;
  apiKey: string;
  secretKey: string;
  combinedKey: string;
  upstreamApiKeyPrefix: string | null;
  upstreamSecretKeyPrefix: string | null;
  expiresAt: string | null;
};

@Injectable()
export class CodingPlanProviderKeyRevealService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly billingService: BillingService,
    private readonly config: ConfigService,
  ) {}

  async revealForUser(
    userId: string,
    entitlementId: string,
    options: { productId?: string | null } = {},
  ): Promise<RevealedCodingPlanProviderKey> {
    const entitlement = await this.billingService.assertCodingPlanEntitlementAccess(userId, entitlementId, {
      productId: options.productId?.trim() || null,
      requireActive: true,
    });
    if (entitlement.fulfillmentMode !== 'provider_resale') {
      throw new BadRequestException('CodingPlan 权益不是供应商转售模式');
    }
    if (!entitlement.providerEntitlementId) {
      throw new BadRequestException('CodingPlan 权益缺少上游供应商权益');
    }

    const providerEntitlement = await this.prisma.codingPlanProviderEntitlement.findUnique({
      where: { id: entitlement.providerEntitlementId },
      select: {
        id: true,
        provider: true,
        upstreamProductId: true,
        upstreamApiKeyEncrypted: true,
        upstreamApiKeyPrefix: true,
        upstreamSecretKeyEncrypted: true,
        upstreamSecretKeyPrefix: true,
        credentialFormat: true,
        productEndTime: true,
        status: true,
      },
    });
    if (!providerEntitlement) {
      throw new BadRequestException('CodingPlan 上游权益不存在');
    }
    if (providerEntitlement.status !== 'ACTIVE') {
      throw new BadRequestException('CodingPlan 上游权益尚未激活');
    }
    if (
      providerEntitlement.productEndTime
      && providerEntitlement.productEndTime.getTime() <= Date.now()
    ) {
      throw new BadRequestException('CodingPlan 上游权益已过期');
    }
    if (
      !providerEntitlement.upstreamApiKeyEncrypted
      || !providerEntitlement.upstreamSecretKeyEncrypted
    ) {
      throw new BadRequestException('CodingPlan 上游权益缺少供应商 key');
    }

    const encryptionKey = resolveEncryptionKey(this.config);
    if (!encryptionKey) {
      throw new ServiceUnavailableException('ENCRYPTION_KEY 未配置，不能显示供应商上游 key');
    }

    try {
      const apiKey = decrypt(providerEntitlement.upstreamApiKeyEncrypted, encryptionKey);
      const secretKey = decrypt(providerEntitlement.upstreamSecretKeyEncrypted, encryptionKey);
      const expiresAt = providerEntitlement.productEndTime?.toISOString() ?? entitlement.expiresAt;
      return {
        providerEntitlementId: providerEntitlement.id,
        provider: providerEntitlement.provider,
        upstreamProductId: providerEntitlement.upstreamProductId,
        credentialFormat: providerEntitlement.credentialFormat ?? 'apiKey.secretKey',
        apiKey,
        secretKey,
        combinedKey: `${apiKey}.${secretKey}`,
        upstreamApiKeyPrefix: providerEntitlement.upstreamApiKeyPrefix,
        upstreamSecretKeyPrefix: providerEntitlement.upstreamSecretKeyPrefix,
        expiresAt,
      };
    } catch {
      throw new ServiceUnavailableException('CodingPlan 上游 key 解密失败');
    }
  }
}
