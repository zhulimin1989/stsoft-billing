import { BadRequestException, Injectable, NotFoundException, ServiceUnavailableException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { CodingPlanProviderLine } from '@prisma/client';
import { decrypt } from '../common/utils/crypto';
import { resolveEncryptionKey } from '../common/utils/encryption-key';
import { PrismaService } from '../prisma/prisma.service';
import {
  PROVIDER_ACCOUNT_IDENTITY_EVIDENCE_SELECT,
  validateProviderAccountIdentityForProvider,
} from '../provider-account-identity/provider-account-identity.policy';
import {
  ProviderLineDedicatedEndpoint,
  ProviderLineRuntimeConfig,
} from './coding-plan-provider.types';

@Injectable()
export class CodingPlanProviderLineService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {}

  async getForFulfillment(providerLineId: string): Promise<ProviderLineRuntimeConfig & {
    providerAccountIdentityId: string;
  }> {
    const line = await this.loadLineById(providerLineId);
    if (!line.fulfillmentEnabled) {
      throw new ServiceUnavailableException('供应商线路已暂停履约');
    }
    if (!line.providerAccountIdentityId) {
      throw new ServiceUnavailableException(
        `供应商线路 ${line.code} 未配置供应商账户身份`,
      );
    }
    try {
      validateProviderAccountIdentityForProvider(
        line.providerAccountIdentity,
        line.providerCode,
      );
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new ServiceUnavailableException(
        `供应商线路 ${line.code} 未配置可用的供应商账户身份: ${detail}`,
      );
    }
    return {
      ...(await this.toRuntimeConfig(line)),
      providerAccountIdentityId: line.providerAccountIdentityId,
    };
  }

  async getForRuntime(providerLineId: string): Promise<ProviderLineRuntimeConfig> {
    const line = await this.loadLineById(providerLineId);
    if (!line.runtimeEnabled) {
      throw new ServiceUnavailableException('供应商线路已暂停运行时调用');
    }
    return this.toRuntimeConfig(line);
  }

  async getForSync(providerLineId: string): Promise<ProviderLineRuntimeConfig> {
    const line = await this.loadLineById(providerLineId);
    if (!line.syncEnabled) {
      throw new ServiceUnavailableException('供应商线路未开启同步');
    }
    return this.toRuntimeConfig(line);
  }

  async loadLineById(id: string): Promise<CodingPlanProviderLine & {
    providerAccountIdentity: {
      ref: string;
      providerCode: string;
      status: string;
    } | null;
  }> {
    const normalized = id.trim();
    if (!normalized) throw new BadRequestException('供应商线路 ID 不能为空');
    const line = await this.prisma.codingPlanProviderLine.findUnique({
      where: { id: normalized },
      include: {
        providerAccountIdentity: {
          select: PROVIDER_ACCOUNT_IDENTITY_EVIDENCE_SELECT,
        },
      },
    });
    if (!line) throw new NotFoundException('供应商线路不存在');
    return line;
  }

  async toRuntimeConfig(line: CodingPlanProviderLine): Promise<ProviderLineRuntimeConfig> {
    const credentials = await this.resolveCredentials(line);
    return {
      id: line.id,
      code: line.code,
      name: line.name,
      providerCode: line.providerCode,
      providerAccountIdentityId: line.providerAccountIdentityId,
      providerName: line.providerName,
      adapterType: line.adapterType,
      environment: line.environment,
      apiBaseUrl: line.apiBaseUrl.replace(/\/+$/, ''),
      authType: line.authType,
      partnerCode: credentials.partnerCode,
      partnerSecretKey: credentials.partnerSecretKey,
      qpsConfig: this.objectValue(line.qpsConfig),
      capabilities: this.objectValue(line.capabilities),
      dedicatedEndpoints: this.dedicatedEndpointsValue(line.dedicatedEndpoints),
      metadata: this.objectValue(line.metadata),
    };
  }

  private async resolveCredentials(line: CodingPlanProviderLine): Promise<{
    partnerCode: string | null;
    partnerSecretKey: string | null;
  }> {
    const encryptionKey = resolveEncryptionKey(this.config);
    const encryptedPartnerCode = this.stringValue(line.partnerCodeEncrypted);
    const encryptedPartnerSecret = this.stringValue(line.partnerSecretEncrypted);
    if ((encryptedPartnerCode || encryptedPartnerSecret) && !encryptionKey) {
      throw new ServiceUnavailableException('ENCRYPTION_KEY 未配置，不能读取供应商凭证');
    }
    const partnerCode = encryptedPartnerCode && encryptionKey
      ? decrypt(encryptedPartnerCode, encryptionKey)
      : null;
    const partnerSecretKey = encryptedPartnerSecret && encryptionKey
      ? decrypt(encryptedPartnerSecret, encryptionKey)
      : null;
    if (partnerCode && partnerSecretKey) {
      return { partnerCode, partnerSecretKey };
    }

    return { partnerCode, partnerSecretKey };
  }

  private objectValue(value: unknown): Record<string, unknown> | null {
    return value && typeof value === 'object' && !Array.isArray(value)
      ? value as Record<string, unknown>
      : null;
  }

  private dedicatedEndpointsValue(value: unknown): ProviderLineDedicatedEndpoint[] {
    if (!Array.isArray(value)) return [];
    return value.filter((item): item is ProviderLineDedicatedEndpoint => {
      if (!item || typeof item !== 'object' || Array.isArray(item)) return false;
      const endpoint = item as Record<string, unknown>;
      return typeof endpoint.client_protocol === 'string'
        && typeof endpoint.provider_id === 'string';
    });
  }

  private stringValue(value: unknown): string | null {
    if (typeof value !== 'string') return null;
    const trimmed = value.trim();
    return trimmed || null;
  }
}
