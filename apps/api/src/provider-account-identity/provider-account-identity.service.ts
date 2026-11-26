import { randomUUID } from 'node:crypto';
import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import type { ProviderAccountIdentity } from '@prisma/client';
import {
  ProviderAccountIdentityListFilter,
  ProviderAccountIdentityRepository,
} from './provider-account-identity.repository';
import {
  normalizeProviderAccountCode,
  PROVIDER_ACCOUNT_IDENTITY_BLOCKING_REFERENCE_ERROR,
  requireProviderAccountRef,
  validateProviderAccountIdentityForProvider,
} from './provider-account-identity.policy';

const DISPLAY_NAME_MAX_LENGTH = 128;

export type ProviderAccountIdentityStatus = 'active' | 'inactive';

@Injectable()
export class ProviderAccountIdentityService {
  constructor(private readonly repository: ProviderAccountIdentityRepository) {}

  list(query: { providerCode?: unknown; status?: unknown }): Promise<ProviderAccountIdentity[]> {
    const filter: ProviderAccountIdentityListFilter = {};
    if (query.providerCode !== undefined && query.providerCode !== '') {
      filter.providerCode = this.normalizeProviderCode(query.providerCode);
    }
    if (query.status !== undefined && query.status !== '') {
      filter.status = this.requireStatus(query.status);
    }
    return this.repository.findAll(filter);
  }

  create(input: { providerCode?: unknown; displayName?: unknown }): Promise<ProviderAccountIdentity> {
    const providerCode = this.normalizeProviderCode(input.providerCode);
    const displayName = this.requireDisplayName(input.displayName);
    const ref = requireProviderAccountRef(`pa_${randomUUID()}`);
    return this.repository.create({
      ref,
      providerCode,
      displayName,
      status: 'active',
    });
  }

  async deactivate(id: string): Promise<ProviderAccountIdentity> {
    const normalizedId = this.requireId(id);
    const identity = await this.repository.findById(normalizedId);
    if (!identity) throw new NotFoundException('供应商账户身份不存在');
    if (identity.status === 'inactive') return identity;
    const references = await this.repository.countBlockingReferences(normalizedId);
    if (
      references.channels > 0
      || references.providerLines > 0
      || references.activeProviderEntitlements > 0
    ) {
      throw new ConflictException(
        `供应商账户身份仍被 ${references.channels} 个未删除渠道和 `
        + `${references.providerLines} 个 Provider Line、`
        + `${references.activeProviderEntitlements} 个 ACTIVE Provider Entitlement 引用，不能停用`,
      );
    }
    try {
      return await this.repository.deactivate(normalizedId);
    } catch (error) {
      const message = error instanceof Error ? error.message : String(error);
      if (message.includes(PROVIDER_ACCOUNT_IDENTITY_BLOCKING_REFERENCE_ERROR)) {
        throw new ConflictException(
          '供应商账户身份在停用期间新增了引用，不能停用，请刷新后重试',
        );
      }
      throw error;
    }
  }

  async requireActiveForProvider(
    id: unknown,
    provider: unknown,
  ): Promise<ProviderAccountIdentity> {
    const normalizedId = this.requireId(id);
    const expectedProviderCode = this.normalizeProviderCode(provider);
    const identity = await this.repository.findById(normalizedId);
    try {
      validateProviderAccountIdentityForProvider(identity, expectedProviderCode);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
    return identity as ProviderAccountIdentity;
  }

  private normalizeProviderCode(value: unknown): string {
    try {
      return normalizeProviderAccountCode(value);
    } catch (error) {
      throw new BadRequestException((error as Error).message);
    }
  }

  private requireDisplayName(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException('displayName 为必填字符串');
    }
    const normalized = value.trim();
    if (normalized.length > DISPLAY_NAME_MAX_LENGTH) {
      throw new BadRequestException(`displayName 长度不能超过 ${DISPLAY_NAME_MAX_LENGTH}`);
    }
    return normalized;
  }

  private requireStatus(value: unknown): ProviderAccountIdentityStatus {
    if (value !== 'active' && value !== 'inactive') {
      throw new BadRequestException('status 只支持 active / inactive');
    }
    return value;
  }

  private requireId(value: unknown): string {
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException('供应商账户身份 ID 不能为空');
    }
    return value.trim();
  }
}
