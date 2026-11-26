import { BadRequestException, ConflictException, Injectable, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { resolvePlatformCurrency } from '../billing/platform-currency';
import { SystemConfigService } from '../billing/system-config.service';
import { PrismaService } from '../prisma/prisma.service';
import { BillingUserMirrorService } from './billing-user-mirror.service';

const PERSONAL_BILLING_ACCOUNT_ID_PREFIX = 'ba_personal_';

type BillingWorkspaceUserSnapshot = {
  id?: string | null;
  email?: string | null;
  phone?: string | null;
  nickname?: string | null;
  isActive?: boolean | null;
  sourceUpdatedAt?: string | Date | null;
};

type BillingWorkspaceTenantSnapshot = {
  id?: string | null;
  name?: string | null;
  slug?: string | null;
  type?: string | null;
  status?: string | null;
  ownerUserId?: string | null;
};

type BillingWorkspaceMembershipSnapshot = {
  userId?: string | null;
  role?: string | null;
  status?: string | null;
};

export type BillingWorkspaceMirrorRequest = {
  user?: BillingWorkspaceUserSnapshot | null;
  tenant?: BillingWorkspaceTenantSnapshot | null;
  membership?: BillingWorkspaceMembershipSnapshot | null;
};

@Injectable()
export class BillingWorkspaceMirrorService {
  constructor(
    private readonly prisma: PrismaService,
    private readonly userMirror: BillingUserMirrorService,
    @Optional() private readonly systemConfig?: SystemConfigService,
    @Optional() private readonly config?: ConfigService,
  ) {}

  async mirror(input: BillingWorkspaceMirrorRequest) {
    const userId = this.requireString(input.user?.id, 'user.id');
    const membershipUserId = this.requireString(
      input.membership?.userId,
      'membership.userId',
    );
    if (membershipUserId !== userId) {
      throw new BadRequestException('membership.userId 与 user.id 不一致');
    }
    const tenantId = this.requireString(input.tenant?.id, 'tenant.id');
    const ownerUserId = this.requireString(input.tenant?.ownerUserId, 'tenant.ownerUserId');
    const name = this.normalizeNullableString(input.tenant?.name) ?? `Workspace ${tenantId.slice(0, 8)}`;
    const type = this.requireTenantType(input.tenant?.type);
    const status = this.requireTenantStatus(input.tenant?.status);
    const role = this.requireMemberRole(input.membership?.role);
    const memberStatus = this.requireMemberStatus(input.membership?.status);
    if ((role === 'owner') !== (userId === ownerUserId)) {
      throw new BadRequestException('membership.role 与 tenant.ownerUserId 不一致');
    }
    const currency = await this.platformCurrencyCode();

    let billingAccountId: string | null = null;
    await this.prisma.$transaction(async (tx) => {
      await this.userMirror.mirrorUser({
        ...(ownerUserId === userId ? input.user : {}),
        id: ownerUserId,
      }, tx);
      await this.userMirror.mirrorUser({ ...input.user, id: userId }, tx);

      let personalAccountPrepared = false;
      let personalAccountWasCreated = false;
      let personalAccountStatus = 'active';
      let serializedBillingAccountId: string | null = null;
      if (status !== 'deleted' && type !== 'enterprise') {
        const beforeAdvisory = await tx.tenant.findUnique({
          where: { id: tenantId },
          select: { billingAccountId: true },
        });
        serializedBillingAccountId = beforeAdvisory?.billingAccountId
          ?? this.personalBillingAccountId(ownerUserId);
        // Serialize the deterministic owner account before tenant.upsert takes
        // a tenant row lock. BillingService provisioning uses the same key.
        await tx.$queryRaw`
          SELECT pg_advisory_xact_lock(
            hashtextextended(${serializedBillingAccountId}, 0::BIGINT)
          )::TEXT AS "advisoryLock"
        `;
        const afterAdvisory = await tx.tenant.findUnique({
          where: { id: tenantId },
          select: { billingAccountId: true },
        });
        if (
          afterAdvisory?.billingAccountId
          && afterAdvisory.billingAccountId !== serializedBillingAccountId
        ) {
          throw new ConflictException('账务主体绑定已变更，请重试镜像');
        }
        if (!afterAdvisory?.billingAccountId) {
          const prepared = await this.prepareBillingAccountBeforeTenantLock(tx, {
            billingAccountId: serializedBillingAccountId,
            ownerUserId,
            tenantName: name,
            tenantStatus: status,
            currency,
          });
          personalAccountWasCreated = prepared.created;
          personalAccountStatus = prepared.accountStatus;
          personalAccountPrepared = true;
        }
      }

      if (type === 'enterprise') {
        await this.assertBoundEnterpriseProjectionIsCurrent(tx, {
          tenantId,
          ownerUserId,
          memberUserId: userId,
          memberRole: role,
        });
      }

      const tenant = await tx.tenant.upsert({
        where: { id: tenantId },
        create: {
          id: tenantId,
          name,
          slug: this.normalizeNullableString(input.tenant?.slug),
          type,
          status,
          ownerUserId,
          mirroredAt: new Date(),
        },
        update: {
          name,
          slug: this.normalizeNullableString(input.tenant?.slug),
          type,
          status,
          ownerUserId,
          mirroredAt: new Date(),
          deletedAt: status === 'deleted' ? new Date() : null,
        },
        select: { id: true, billingAccountId: true },
      });

      await tx.tenantMember.upsert({
        where: { tenantId_userId: { tenantId, userId } },
        create: {
          tenantId,
          userId,
          role,
          status: memberStatus,
        },
        update: {
          role,
          status: memberStatus,
        },
      });

      if (memberStatus === 'active') {
        await tx.user.updateMany({
          where: { id: userId, currentTenantId: null },
          data: { currentTenantId: tenantId },
        });
      } else {
        await tx.user.updateMany({
          where: { id: userId, currentTenantId: tenantId },
          data: { currentTenantId: null },
        });
      }

      if (status !== 'deleted') {
        if (type === 'enterprise') {
          // §6.5:enterprise tenant 不静默创建 personal account,也不覆盖已挂 enterprise
          // account 的 name/ownerUserId/status(企业主体快照由 EnterpriseAccountService 维护)。
          // 已 attach 时保持既有绑定;未 attach 时留空,由企业开通链路 attach + fail-closed 兜底。
          billingAccountId = tenant.billingAccountId ?? null;
        } else if (tenant.billingAccountId) {
          // personal/team 已有绑定：保持不变。
          if (
            serializedBillingAccountId
            && tenant.billingAccountId !== serializedBillingAccountId
          ) {
            throw new ConflictException('账务主体绑定已变更，请重试镜像');
          }
          billingAccountId = tenant.billingAccountId;
        } else {
          // 个人账号与企业账号并存：普通 personal/team 工作区默认归 owner 的个人账务账户；
          // 企业账务主体只通过 enterprise tenant + attachEnterpriseTenant 显式绑定。
          billingAccountId = serializedBillingAccountId;
          if (!billingAccountId || !personalAccountPrepared) {
            throw new ConflictException('账务账号开户未完成，请重试镜像');
          }
          if (!personalAccountWasCreated) {
            await this.updateExistingBillingAccountOwnerMembership(tx, {
              billingAccountId,
              ownerUserId,
              accountStatus: personalAccountStatus,
            });
          }
          await tx.tenant.update({
            where: { id: tenantId },
            data: { billingAccountId },
          });
        }
      }
      // Cross-region (sg → use1 writer) round-trips blow past Prisma's default
      // 5s interactive-transaction budget; raise it so the mirror completes.
      }, { maxWait: 10_000, timeout: 30_000 });

    return { userId, tenantId, role, status: memberStatus, billingAccountId };
  }

  /**
   * Enterprise owner transfer is the only writer allowed to change the owner
   * of an already attached enterprise aggregate. A normal workspace mirror can
   * have been produced before that transfer and arrive afterwards, so lock the
   * tenant and compare against its post-transfer projection before upserting.
   *
   * The transfer path locks wallet -> account -> tenant. This mirror performs
   * all user/account work before this tenant lock and never touches the account
   * afterwards for enterprise tenants, avoiding a tenant -> account inversion.
   */
  private async assertBoundEnterpriseProjectionIsCurrent(
    tx: Prisma.TransactionClient,
    input: {
      tenantId: string;
      ownerUserId: string;
      memberUserId: string;
      memberRole: string;
    },
  ): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "tenants"
      WHERE "id" = ${input.tenantId}
      FOR UPDATE
    `;
    if (rows.length === 0) return;

    const tenant = await tx.tenant.findUnique({
      where: { id: input.tenantId },
      select: {
        id: true,
        type: true,
        billingAccountId: true,
        ownerUserId: true,
      },
    });
    // Unattached enterprise tenants are still in the initial provisioning
    // phase; their authoritative owner continues to come from user-api.
    if (!tenant || tenant.type !== 'enterprise' || !tenant.billingAccountId) return;

    const canonicalRole = input.memberUserId === tenant.ownerUserId ? 'owner' : 'member';
    if (
      input.ownerUserId !== tenant.ownerUserId
      || input.memberRole !== canonicalRole
    ) {
      throw new ConflictException({
        code: 'enterprise_tenant_projection_conflict',
        message: '企业工作区归属已变更，已停止陈旧镜像覆盖',
      });
    }
  }

  private async prepareBillingAccountBeforeTenantLock(
    tx: Prisma.TransactionClient,
    input: {
      billingAccountId: string;
      ownerUserId: string;
      tenantName: string;
      tenantStatus: string;
      currency: string;
    },
  ): Promise<{ created: boolean; accountStatus: string }> {
    const owner = await tx.user.findUnique({
      where: { id: input.ownerUserId },
      select: { email: true, nickname: true, isActive: true, createdAt: true },
    });
    const accountName = owner?.nickname?.trim()
      || owner?.email
      || input.tenantName
      || 'Personal account';
    const accountStatus = owner?.isActive === false || input.tenantStatus === 'suspended'
      ? 'suspended'
      : 'active';

    const existingAccount = await tx.billingAccount.findUnique({
      where: { id: input.billingAccountId },
      select: { id: true, currency: true },
    });
    if (!existingAccount) {
      await tx.billingAccount.create({
        data: {
          id: input.billingAccountId,
          type: 'personal',
          name: accountName,
          ownerUserId: input.ownerUserId,
          status: accountStatus,
          currency: input.currency,
          balanceGrantLedgerStatus: 'RECONCILED_V2',
          balanceGrantLedgerVersion: 2,
          balanceGrantLedgerHash: 'EMPTY_V2',
          balanceGrantLedgerReconciledAt: new Date(),
          createdAt: owner?.createdAt ?? new Date(),
        },
      });
      await tx.accountWallet.create({
        data: {
          billingAccountId: input.billingAccountId,
          balanceUsd: new Prisma.Decimal(0),
        },
      });
      await tx.billingAccountMember.create({
        data: {
          billingAccountId: input.billingAccountId,
          userId: input.ownerUserId,
          role: 'owner',
          status: accountStatus === 'active' ? 'active' : 'inactive',
        },
      });
      return { created: true, accountStatus };
    }
    this.assertBillingAccountCurrencyMatches(existingAccount.currency, input.currency);

    const walletRows = await tx.$queryRaw<Array<{ billing_account_id: string }>>`
      SELECT "billing_account_id"
      FROM "account_wallets"
      WHERE "billing_account_id" = ${input.billingAccountId}
      FOR UPDATE
    `;
    if (walletRows.length !== 1) {
      throw new ConflictException({
        code: 'billing_account_not_provisioned',
        message: '账务账号开户不完整，已停止镜像绑定',
      });
    }
    await tx.$queryRaw`
      SELECT "id"
      FROM "billing_accounts"
      WHERE "id" = ${input.billingAccountId}
      FOR UPDATE
    `;
    const lockedAccount = await tx.billingAccount.findUnique({
      where: { id: input.billingAccountId },
      select: { type: true, ownerUserId: true, currency: true, deletedAt: true },
    });
    if (
      !lockedAccount
      || lockedAccount.deletedAt
      || lockedAccount.type !== 'personal'
      || lockedAccount.ownerUserId !== input.ownerUserId
    ) {
      throw new ConflictException('账务主体配置不一致，已停止镜像绑定');
    }
    this.assertBillingAccountCurrencyMatches(lockedAccount.currency, input.currency);
    await tx.billingAccount.update({
      where: { id: input.billingAccountId },
      data: {
        name: accountName,
        ownerUserId: input.ownerUserId,
        status: accountStatus,
        deletedAt: null,
      },
    });
    return { created: false, accountStatus };
  }

  private async updateExistingBillingAccountOwnerMembership(
    tx: Prisma.TransactionClient,
    input: {
      billingAccountId: string;
      ownerUserId: string;
      accountStatus: string;
    },
  ): Promise<void> {
    const membership = await tx.billingAccountMember.findUnique({
      where: {
        billingAccountId_userId: {
          billingAccountId: input.billingAccountId,
          userId: input.ownerUserId,
        },
      },
      select: { id: true, role: true },
    });
    if (!membership || membership.role !== 'owner') {
      throw new ConflictException({
        code: 'billing_account_not_provisioned',
        message: '账务账号开户不完整，已停止镜像绑定',
      });
    }
    await tx.billingAccountMember.update({
      where: { id: membership.id },
      data: {
        role: 'owner',
        status: input.accountStatus === 'active' ? 'active' : 'inactive',
      },
    });
  }

  private async platformCurrencyCode(): Promise<string> {
    const platformConfig = await this.systemConfig?.getDeploymentConfig();
    return resolvePlatformCurrency(this.config, platformConfig).currencyCode;
  }

  private assertBillingAccountCurrencyMatches(
    persistedCurrency: string,
    deploymentCurrency: string,
  ): void {
    if (
      persistedCurrency.trim().toUpperCase()
      === deploymentCurrency.trim().toUpperCase()
    ) return;
    throw new ConflictException({
      code: 'billing_account_currency_migration_required',
      message: '账务账号币种与当前部署不一致，必须停写并排空待结算后执行专用币种迁移',
    });
  }

  private normalizeNullableString(value: unknown): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    const trimmed = String(value).trim();
    return trimmed || null;
  }

  private requireTenantType(value: unknown): string {
    const normalized = this.requireString(value, 'tenant.type');
    if (normalized === 'personal' || normalized === 'team' || normalized === 'enterprise') {
      return normalized;
    }
    throw new BadRequestException('tenant.type 仅支持 personal、team 或 enterprise');
  }

  private requireTenantStatus(value: unknown): string {
    const normalized = this.requireString(value, 'tenant.status');
    if (normalized === 'active' || normalized === 'suspended' || normalized === 'deleted') {
      return normalized;
    }
    throw new BadRequestException('tenant.status 仅支持 active、suspended 或 deleted');
  }

  private requireMemberRole(value: unknown): string {
    const normalized = this.requireString(value, 'membership.role');
    if (normalized === 'owner' || normalized === 'member') return normalized;
    throw new BadRequestException('membership.role 仅支持 owner 或 member');
  }

  private requireMemberStatus(value: unknown): string {
    const normalized = this.requireString(value, 'membership.status');
    if (normalized === 'active' || normalized === 'inactive') return normalized;
    throw new BadRequestException('membership.status 仅支持 active 或 inactive');
  }

  private personalBillingAccountId(ownerUserId: string): string {
    return `${PERSONAL_BILLING_ACCOUNT_ID_PREFIX}${ownerUserId}`;
  }

  private requireString(value: unknown, field: string): string {
    const normalized = this.normalizeNullableString(value);
    if (!normalized) throw new BadRequestException(`${field} 是必填字段`);
    return normalized;
  }
}
