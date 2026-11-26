import {
  BadRequestException,
  HttpException,
  Injectable,
  Logger,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherSyncService } from '../publisher/publisher-sync.service';
import { hasPrismaErrorCode } from '../common/utils/prisma-error.util';
import { BillingService } from './billing.service';
import { enqueueEnterpriseCreditPolicyFanout } from './enterprise-credit-policy-fanout';
import {
  accountAvailableFromWalletAndRemainingUsd,
  centsToUsd,
  usd,
  usdNumber,
  usdString,
  usdToCents,
} from './money';
import { resolvePlatformCurrency } from './platform-currency';
import { yearMonthInBeijing } from './enterprise-bills.policy';
import { SystemConfigService } from './system-config.service';

/**
 * 企业账户账务主体服务（M0）。
 *
 * 归属边界（见方案 §6 / §10）：
 * - user 服务持有企业实名主体（营业执照、verification），billing 只保存企业主体快照 + verificationId 回链。
 * - 本服务负责：企业 BillingAccount + AccountWallet + owner member 的创建/挂载/校验，
 *   以及 attach/detach 之后的 account 级 key-balance fanout（复用 PublisherSyncService）。
 * - 资金变动（grant/recharge/spend/subscription）不在本服务；仍走 BillingService 现有资金安全入口。
 *   本服务只创建 0 余额 wallet，属结构化操作、无资金移动，幂等由 DB 唯一约束 + P2002 捕获保证。
 */

const ENTERPRISE_ACCOUNT_TYPE = 'enterprise';

/**
 * 复合回收事务的超时上界。
 *
 * ⚠️ 这个数字被一条跨仓不等式约束（复核 P1）：
 *   maxWait(10s) + tx(本值) + 提交/网络余量 < user 侧 HTTP 超时(90s) < 执行权租约(120s)
 *
 * 原上界 110s 会把它配穿：10+110=120s 已顶到租约，且 > 90s ⇒ user 侧先抛 502、
 * billing 还在跑，而租约同时已可被接管 ⇒ 重复回收 + 调用方拿不到确定结果。
 * 70s 给提交与网络留出 10s。有单测钉住这条不等式。
 */
const VOID_TX_TIMEOUT_CEILING_MS = 70_000;
const CREDIT_STATUS_ACTIVE = 'ACTIVE';
const CREDIT_STATUS_DISABLED = 'DISABLED';
const CREDIT_STATUSES = new Set([CREDIT_STATUS_ACTIVE, CREDIT_STATUS_DISABLED, 'SUSPENDED']);

// 迁移 20260703000100_enterprise_account_foundation 里的约束/索引名。
const USCC_ACTIVE_UNIQUE_INDEX = 'billing_accounts_uscc_active_uk';
const TENANT_BILLING_ACCOUNT_UNIQUE = 'tenants_billing_account';

export type EnterpriseSubjectCheck = {
  uscc: string;
  occupied: boolean;
  truncated: boolean;
  accounts: Array<{
    accountId: string;
    type: string;
    ownerUserId: string | null;
    verificationId: string | null;
    status: string;
    deletedAt: Date | null;
    quarantinedAt: Date | null;
  }>;
};

export type CreateEnterpriseAccountInput = {
  userId: string;
  tenantId?: string | null;
  verificationId: string;
  enterpriseName: string;
  uscc: string;
  verifiedAt?: string | Date | null;
  idempotencyKey?: string | null;
};

export type CreateEnterpriseAccountResult = {
  id: string;
  type: 'enterprise';
  ownerUserId: string | null;
  walletCreated: boolean;
  ownerMemberCreated: boolean;
  attached: boolean;
  idempotent: boolean;
};

export type EnterpriseAccountView = {
  id: string;
  type: string;
  name: string;
  ownerUserId: string | null;
  status: string;
  currency: string;
  enterpriseName: string | null;
  uscc: string | null;
  verificationId: string | null;
  verifiedAt: Date | null;
  balanceUsd?: number;
  balanceAmount?: string;
  credit?: EnterpriseAccountCreditView;
  /** 财务对账「余额流水明细」该账户最新一条的变动后余额（分）；无流水为 null。 */
  ledgerBalanceAfterCents?: number | null;
  createdAt: Date;
  updatedAt: Date;
};

export type EnterpriseAccountCreditView = {
  billingAccountId: string;
  status: string;
  limitCents: number;
  limitUsd: number;
  limitAmount: string;
  activeLimitCents: number;
  activeLimitUsd: number;
  activeLimitAmount: string;
  usedCents: number;
  usedUsd: number;
  usedAmount: string;
  remainingCents: number;
  remainingUsd: number;
  remainingAmount: string;
  accountBalanceCents: number;
  accountBalanceUsd: number;
  accountBalanceAmount: string;
  accountAvailableBalanceCents: number;
  accountAvailableBalanceUsd: number;
  accountAvailableBalanceAmount: string;
  approvedReceivableOutstandingCents: number;
  approvedReceivableOutstandingUsd: number;
  approvedReceivableOutstandingAmount: string;
  unapprovedDebtOutstandingCents: number;
  unapprovedDebtOutstandingUsd: number;
  unapprovedDebtOutstandingAmount: string;
  fundingClassificationComplete: boolean;
  policyRevision: number;
  policyEffectiveBoundaryAt: Date | null;
  policyBoundaryComplete: boolean;
  termsDays: number | null;
  effectiveAt: Date | null;
  expiresAt: Date | null;
  updatedBy: string | null;
  note: string | null;
  createdAt: Date | null;
  updatedAt: Date | null;
};

type EnterpriseFundingOutstanding = {
  approvedReceivableUsd: Prisma.Decimal;
  unapprovedDebtUsd: Prisma.Decimal;
  classificationComplete: boolean;
};

/** 用户详情页「可用金额」卡片：个人账户与企业账户共用同一口径。 */
export type OwnerAvailableAmountItem = {
  billingAccountId: string;
  /** billingAccount.type：personal / enterprise */
  accountType: string;
  /** 企业账户取企业名称，个人账户取账户名称 */
  accountName: string;
  currency: string;
  /** 钱包余额（cents，可为负） */
  balanceCents: number;
  /** 剩余信用（cents） */
  creditRemainingCents: number;
  /** 可用金额（cents）= max(0, 余额) + 剩余信用 */
  availableAmountCents: number;
};

export type UpdateEnterpriseCreditInput = {
  limitCents?: number | null;
  status?: string | null;
  termsDays?: number | null;
  effectiveAt?: string | Date | null;
  expiresAt?: string | Date | null;
  updatedBy?: string | null;
  reason?: string | null;
  note?: string | null;
  idempotencyKey?: string | null;
};

export type EnterpriseAccountCreditEventView = {
  id: string;
  billingAccountId: string;
  oldLimitCents: number | null;
  newLimitCents: number;
  oldStatus: string | null;
  newStatus: string;
  oldTermsDays: number | null;
  newTermsDays: number | null;
  oldEffectiveAt: Date | null;
  newEffectiveAt: Date | null;
  oldExpiresAt: Date | null;
  newExpiresAt: Date | null;
  policyRevision: number | null;
  policyDecisionAt: Date | null;
  policyEffectiveBoundaryAt: Date | null;
  policyBoundaryComplete: boolean;
  policyFanoutEnqueuedAt: Date | null;
  actorId: string | null;
  reason: string | null;
  note: string | null;
  idempotencyKey: string | null;
  createdAt: Date;
};

export type EnterpriseAccountFundingAnchor = {
  billingAccountId: string;
  ownerUserId: string;
  tenantId: string;
};

export type UpdateEnterpriseSnapshotInput = {
  enterpriseName?: string | null;
  uscc?: string | null;
  verificationId?: string | null;
  verifiedAt?: string | Date | null;
  name?: string | null;
  status?: string | null;
};

export type UpsertOwnerMemberInput = {
  userId: string;
  idempotencyKey?: string | null;
};

export type AttachTenantInput = {
  tenantId: string;
  userId?: string | null;
  idempotencyKey?: string | null;
};

export type EnterpriseOwnerUserSnapshot = {
  id: string;
  email?: string | null;
  phone?: string | null;
  nickname?: string | null;
  isActive?: boolean | null;
  sourceUpdatedAt?: string | Date | null;
};

export type TransferEnterpriseOwnerInput = {
  tenantId: string;
  previousOwnerUserId: string;
  newOwner: EnterpriseOwnerUserSnapshot;
};

export type TransferEnterpriseOwnerResult = {
  id: string;
  tenantId: string;
  previousOwnerUserId: string;
  ownerUserId: string;
  transferred: boolean;
  idempotent: boolean;
};

type LockedEnterpriseAccount = {
  id: string;
  type: string;
  ownerUserId: string | null;
  status: string;
  // 议题二批一：回收屏障的派生缓存列。判据是本列而非 status（负余额账户保持 active）。
  provisioningQuarantinedAt: Date | null;
};

type LockedEnterpriseAccountContext = {
  account: LockedEnterpriseAccount;
  walletBalanceUsd: Prisma.Decimal;
};

@Injectable()
export class EnterpriseAccountService {
  private readonly logger = new Logger(EnterpriseAccountService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly publisherSync: PublisherSyncService,
    private readonly billing: BillingService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly systemConfig?: SystemConfigService,
  ) {}

  // ---------------------------------------------------------------------------
  // create
  // ---------------------------------------------------------------------------

  async checkEnterpriseSubject(uscc: unknown): Promise<EnterpriseSubjectCheck> {
    if (typeof uscc !== 'string' || !/^[0-9A-HJ-NP-RTUWXY]{18}$/.test(uscc)) {
      throw this.businessError('enterprise_uscc_invalid', '信用代码必须为18位规范大写字符', 400);
    }
    // Parameterized exact canonical equality. No ILIKE/substring and no lifecycle filter:
    // a deleted or quarantined historical account still needs manual verification.
    const rows = await this.prisma.$queryRaw<EnterpriseSubjectCheck['accounts']>`
      SELECT id AS "accountId", type, owner_user_id AS "ownerUserId",
             verification_id AS "verificationId", status,
             deleted_at AS "deletedAt", provisioning_quarantined_at AS "quarantinedAt"
      FROM billing_accounts
      WHERE uscc IS NOT NULL AND upper(btrim(uscc, E' \t\n\r\f\v\u00a0\u1680\u2000\u2001\u2002\u2003\u2004\u2005\u2006\u2007\u2008\u2009\u200a\u2028\u2029\u202f\u205f\u3000\ufeff')) = ${uscc}
      ORDER BY id LIMIT 101
    `;
    return { uscc, occupied: rows.length > 0, truncated: rows.length > 100, accounts: rows.slice(0, 100) };
  }

  private assertProvisioningOwner(account: { ownerUserId: string | null }, userId: string): void {
    if (account.ownerUserId !== userId) {
      throw this.businessError('enterprise_account_owner_changed', '企业账户管理员已变更，请联系平台运营处理', 409);
    }
  }

  async createEnterpriseAccount(
    input: CreateEnterpriseAccountInput,
  ): Promise<CreateEnterpriseAccountResult> {
    const userId = this.requireString(input.userId, 'userId');
    const verificationId = this.requireString(input.verificationId, 'verificationId');
    const enterpriseName = this.requireString(input.enterpriseName, 'enterpriseName');
    const uscc = this.requireString(input.uscc, 'uscc');
    const tenantId = this.normalizeNullable(input.tenantId);
    const verifiedAt = this.normalizeDate(input.verifiedAt);

    // ── 议题二批一：本方法必须是**单事务**，且事务内先取 verification 咨询锁再查墓碑 ──
    // 旧实现是三段独立事务（查既有在事务外 → 建账一个事务 → 内层 attach 另一个事务），
    // 即便加了墓碑检查，`查墓碑=无 → void 落墓碑并完成 → create 提交新账户` 的窗口依旧成立。
    // 与 voidProvisioning（同样在其事务内取同一把锁）互斥序列化后，窗口才真正闭合。
    // 只读配置在事务外先取，避免把它算进事务时长。
    const currency = await this.platformCurrencyCode();

    try {
      const created = await this.prisma.$transaction(async (tx) => {
        await this.acquireProvisioningLock(tx, verificationId);
        // 权威屏障：账户可能尚不存在，故只能挂在 verification 级墓碑上。
        await this.assertNotTombstoned(tx, verificationId);

        const existing = await tx.billingAccount.findFirst({
          where: { verificationId, deletedAt: null },
          select: { id: true, ownerUserId: true, provisioningQuarantinedAt: true, status: true },
        });
        if (existing) {
          // 派生屏障：既有账户已被回收 ⇒ 不再返回「幂等成功」，改为结构化 409。
          this.assertNotQuarantined(existing);
          if (existing.status !== 'active') {
            throw this.businessError(
              'enterprise_account_suspended',
              '该企业账户当前不可用，请联系平台运营处理',
              409,
            );
          }
          this.assertProvisioningOwner(existing, userId);
          return { account: existing, attached: false, fresh: false };
        }

        const account = await tx.billingAccount.create({
          data: {
            type: ENTERPRISE_ACCOUNT_TYPE,
            name: enterpriseName,
            ownerUserId: userId,
            status: 'active',
            currency,
            enterpriseName,
            uscc,
            verificationId,
            verifiedAt,
            balanceGrantLedgerStatus: 'RECONCILED_V2',
            balanceGrantLedgerVersion: 2,
            balanceGrantLedgerHash: 'EMPTY_V2',
            balanceGrantLedgerReconciledAt: new Date(),
          },
        });
        await tx.accountWallet.create({
          data: {
            billingAccountId: account.id,
            balanceUsd: new Prisma.Decimal(0),
          },
        });
        await tx.billingAccountMember.create({
          data: {
            billingAccountId: account.id,
            userId,
            role: 'owner',
            status: 'active',
          },
        });
        await tx.enterpriseBillMonthSummary.create({
          data: emptyCurrentMonthSummary(account.id),
        });

        // 内层 attach 必须在**同一事务**内，用 tx 版内核（原实现另开事务，会嵌套提交）。
        let attached = false;
        if (tenantId) {
          attached = await this.attachTenantCore(tx, account.id, tenantId, userId);
        }
        return { account, attached, fresh: true };
      });

      // ── 以下副作用一律在事务提交之后 ──
      if (tenantId) {
        await this.billing.syncTenantBalanceCacheForCurrentBinding(tenantId);
      }
      if (!created.fresh) {
        return this.buildCreateResult(created.account, tenantId, /* idempotent */ true);
      }
      if (created.attached) {
        await this.fanoutAccountKeyBalances(created.account.id);
      }
      return {
        id: created.account.id,
        type: 'enterprise',
        ownerUserId: created.account.ownerUserId,
        walletCreated: true,
        ownerMemberCreated: true,
        attached: created.attached,
        idempotent: false,
      };
    } catch (err) {
      // uscc 唯一冲突 → 业务错误（同 USCC 已存在 active enterprise account）。
      if (this.isUsccConflict(err)) {
        // 并发下同 verificationId 可能已被另一请求写入；再查一次做幂等兜底。
        // ⚠️ 必须在**同一把 advisory lock 内**重查，并保持冻结的错误码优先级
        // （tombstoned > quarantined > suspended）——否则本路径会成为绕过屏障的旁路。
        const raced = await this.prisma.$transaction(async (tx) => {
          await this.acquireProvisioningLock(tx, verificationId);
          await this.assertNotTombstoned(tx, verificationId);
          const row = await tx.billingAccount.findFirst({
            where: { verificationId, deletedAt: null },
            select: { id: true, ownerUserId: true, provisioningQuarantinedAt: true, status: true },
          });
          if (!row) return null;
          this.assertNotQuarantined(row);
          if (row.status !== 'active') {
            throw this.businessError(
              'enterprise_account_suspended',
              '该企业账户当前不可用，请联系平台运营处理',
              409,
            );
          }
          this.assertProvisioningOwner(row, userId);
          return row;
        });
        if (raced) {
          if (tenantId) {
            await this.billing.syncTenantBalanceCacheForCurrentBinding(tenantId);
          }
          return this.buildCreateResult(raced, tenantId, true);
        }
        throw this.businessError(
          'enterprise_uscc_conflict',
          '该统一社会信用代码已存在启用中的企业账户',
          409,
        );
      }
      throw err;
    }
  }

  private buildCreateResult(
    account: { id: string; ownerUserId: string | null },
    tenantId: string | null,
    idempotent: boolean,
  ): CreateEnterpriseAccountResult {
    return {
      id: account.id,
      type: 'enterprise',
      ownerUserId: account.ownerUserId,
      walletCreated: false,
      ownerMemberCreated: false,
      attached: false,
      idempotent,
    };
  }

  // ---------------------------------------------------------------------------
  // read
  // ---------------------------------------------------------------------------

  async getEnterpriseAccount(id: string): Promise<EnterpriseAccountView> {
    const account = await this.prisma.billingAccount.findFirst({
      where: { id, deletedAt: null },
      include: {
        wallet: true,
        creditConfig: true,
      },
    });
    if (!account || account.type !== ENTERPRISE_ACCOUNT_TYPE) {
      throw this.businessError('enterprise_account_not_found', '企业账户不存在', 404);
    }
    const outstanding = await this.loadFundingSnapshots([id]);
    return this.toView(account, outstanding.get(id));
  }

  async listEnterpriseAccounts(options: {
    page?: number;
    pageSize?: number;
    status?: string | null;
    ownerUserId?: string | null;
    uscc?: string | null;
    search?: string | null;
  } = {}): Promise<{
    items: EnterpriseAccountView[];
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    const page = Math.max(Math.floor(options.page ?? 1), 1);
    const pageSize = Math.min(Math.max(Math.floor(options.pageSize ?? 20), 1), 200);
    const status = this.normalizeNullable(options.status);
    const ownerUserId = this.normalizeNullable(options.ownerUserId);
    const uscc = this.normalizeNullable(options.uscc);
    const search = this.normalizeNullable(options.search);
    const where: Prisma.BillingAccountWhereInput = {
      type: ENTERPRISE_ACCOUNT_TYPE,
      deletedAt: null,
      ...(status ? { status } : {}),
      ...(ownerUserId ? { ownerUserId } : {}),
      ...(uscc ? { uscc } : {}),
      ...(search
        ? {
            OR: [
              { enterpriseName: { contains: search, mode: 'insensitive' } },
              { name: { contains: search, mode: 'insensitive' } },
              { uscc: { contains: search, mode: 'insensitive' } },
              { ownerUserId: search },
              { id: search },
            ],
          }
        : {}),
    };
    const [total, rows] = await this.prisma.$transaction([
      this.prisma.billingAccount.count({ where }),
      this.prisma.billingAccount.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          wallet: true,
          creditConfig: true,
        },
      }),
    ]);
    const accountIds = rows.map((row) => row.id);
    const [outstanding, ledgerBalances] = await Promise.all([
      this.loadFundingSnapshots(accountIds),
      this.latestLedgerBalanceAfterCents(accountIds),
    ]);
    return {
      items: rows.map((row) => ({
        ...this.toView(row, outstanding.get(row.id)),
        ledgerBalanceAfterCents: ledgerBalances.get(row.id) ?? null,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  /**
   * 按 owner 用户聚合「可用金额」：个人账户 1 条 + 每个企业账户各 1 条。
   * 口径与企业账户详情页的「账户可用余额」一致（max(0, 余额) + 剩余信用），
   * 个人账户无信用配置时即钱包余额（负数按 0 计）。
   */
  async getOwnerAvailableAmounts(userId: string): Promise<{
    userId: string;
    items: OwnerAvailableAmountItem[];
  }> {
    const normalizedUserId = userId?.trim();
    if (!normalizedUserId) {
      throw new BadRequestException('userId 不能为空');
    }
    const accounts = await this.prisma.billingAccount.findMany({
      where: { ownerUserId: normalizedUserId, deletedAt: null },
      orderBy: [{ createdAt: 'asc' }],
      include: { wallet: true, creditConfig: true },
    });
    const outstanding = await this.loadFundingSnapshots(accounts.map((account) => account.id));
    const items = accounts
      .map((account): OwnerAvailableAmountItem => {
        const view = this.toView(account, outstanding.get(account.id));
        const isEnterprise = account.type === ENTERPRISE_ACCOUNT_TYPE;
        return {
          billingAccountId: account.id,
          accountType: account.type,
          accountName: isEnterprise
            ? account.enterpriseName ?? account.name
            : account.name,
          currency: account.currency,
          balanceCents: view.credit?.accountBalanceCents ?? 0,
          creditRemainingCents: view.credit?.remainingCents ?? 0,
          availableAmountCents: view.credit?.accountAvailableBalanceCents ?? 0,
        };
      })
      // 个人账户固定在前，企业账户按创建时间升序（findMany 已按 createdAt 排序）。
      .sort((a, b) => {
        const rank = (type: string) => (type === ENTERPRISE_ACCOUNT_TYPE ? 1 : 0);
        return rank(a.accountType) - rank(b.accountType);
      });
    return { userId: normalizedUserId, items };
  }

  // ---------------------------------------------------------------------------
  // update snapshot (admin-only)
  // ---------------------------------------------------------------------------

  async updateEnterpriseSnapshot(
    id: string,
    input: UpdateEnterpriseSnapshotInput,
  ): Promise<EnterpriseAccountView> {
    const data: Prisma.BillingAccountUpdateInput = {};
    if (input.enterpriseName !== undefined) {
      const name = this.normalizeNullable(input.enterpriseName);
      data.enterpriseName = name;
      if (name) data.name = name;
    }
    if (input.name !== undefined) {
      const name = this.normalizeNullable(input.name);
      if (name) data.name = name;
    }
    if (input.uscc !== undefined) data.uscc = this.normalizeNullable(input.uscc);
    if (input.verificationId !== undefined) {
      // 议题二批一：**既有账户的 verificationId 不可变**。
      // 若允许改，就能把一个未 quarantine 的账户改到"已有墓碑"的 verification 上，
      // 直接造出「墓碑存在 + quarantined_at IS NULL」——那正是设计稿声称不可达的状态；
      // 并发移入还会被 voidProvisioning 的账户枚举漏掉。
      // 需要纠正错绑时走 DBA 脚本（有人工时间屏障），不开放在线入口。
      const nextVerificationId = this.normalizeNullable(input.verificationId);
      const current = await this.prisma.billingAccount.findFirst({
        where: { id, deletedAt: null },
        select: { verificationId: true },
      });
      if (!current) {
        throw this.businessError('enterprise_account_not_found', '企业账户不存在', 404);
      }
      if (current.verificationId !== nextVerificationId) {
        throw this.businessError(
          'enterprise_verification_id_immutable',
          '企业账户的实名 ID 不可变更；如需纠正错绑请联系平台运营',
          409,
        );
      }
      // 值未变 ⇒ 幂等，不写该字段。
    }
    if (input.verifiedAt !== undefined) data.verifiedAt = this.normalizeDate(input.verifiedAt);
    if (input.status !== undefined) {
      const status = this.normalizeNullable(input.status);
      if (status) data.status = status;
    }
    // 议题二批一：禁止把已回收（quarantined）的账户经本入口重新激活。
    // ⚠️ 必须原子：`读到 NULL → void 提交 quarantine → 写回 active` 是可达窗口，
    // 所以激活分支走条件更新 + affected_rows 断言，而不是"先读后写"。
    const activating = data.status === 'active';

    try {
      const updated = await this.prisma.$transaction(async (tx) => {
        const locked = await this.lockExistingEnterpriseAccount(tx, id);
        // 有欠款（钱包为负）的企业账户不允许停用：账户失活会切断消费与还款
        // 闭环，欠款将无法通过正常充值路径核销。必须在 wallet 行锁内检查，避免检查后并发扣费。
        if (
          data.status !== undefined
          && data.status !== 'active'
          && locked.walletBalanceUsd.lt(0)
        ) {
          throw this.businessError(
            'enterprise_account_has_outstanding_credit',
            '企业账户存在未结清信用欠款，不能停用；请先完成还款核销',
            409,
          );
        }
        if (activating) {
          // 单条语句内同时判定屏障与写入 ⇒ 原子。
          // 不用 `update`（Prisma 的 update 只能按主键、无法附加条件），也不用"先读后写"。
          const affected = await tx.billingAccount.updateMany({
            where: { id, provisioningQuarantinedAt: null },
            data,
          });
          if (affected.count !== 1) {
            // 0 行 ⇒ 该账户已被回收：整笔事务回滚，其它快照字段的修改也一并回滚。
            throw this.businessError(
              'enterprise_account_quarantined',
              '该企业账户已被回收，开通类操作已停用',
              409,
            );
          }
          // 返回值仍走 update 以复用既有返回形状（此时屏障已通过，data 幂等重写一次无副作用）。
          return tx.billingAccount.update({ where: { id }, data });
        }
        return tx.billingAccount.update({ where: { id }, data });
      });
      // Re-read the full account view so financial classifications come from
      // immutable consumption allocations, never from the mutable wallet/config
      // snapshot returned by the metadata update.
      return this.getEnterpriseAccount(updated.id);
    } catch (err) {
      if (this.isUsccConflict(err)) {
        throw this.businessError(
          'enterprise_uscc_conflict',
          '该统一社会信用代码已存在启用中的企业账户',
          409,
        );
      }
      throw err;
    }
  }

  // ---------------------------------------------------------------------------
  // credit limit (admin-only)
  // ---------------------------------------------------------------------------

  async getEnterpriseCredit(id: string): Promise<EnterpriseAccountCreditView> {
    await this.requireEnterpriseAccount(id);
    const account = await this.prisma.billingAccount.findFirst({
      where: { id, deletedAt: null },
      include: {
        wallet: true,
        creditConfig: true,
      },
    });
    if (!account) {
      throw this.businessError('enterprise_account_not_found', '企业账户不存在', 404);
    }
    const outstanding = await this.loadFundingSnapshots([id]);
    return this.toCreditView(
      id,
      account.wallet,
      account.creditConfig,
      outstanding.get(id),
    );
  }

  async updateEnterpriseCredit(
    id: string,
    input: UpdateEnterpriseCreditInput,
  ): Promise<EnterpriseAccountCreditView> {
    const idempotencyKey = this.normalizeNullable(input.idempotencyKey);
    const requestFingerprint = idempotencyKey
      ? this.creditMutationFingerprint(input)
      : null;

    let fanoutTarget: { eventId: string; policyRevision: number } | null = null;
    try {
      const mutation = await this.prisma.$transaction(async (tx) => {
        await this.lockExistingEnterpriseAccount(tx, id);
        if (idempotencyKey) {
          const existingEvent = await tx.billingAccountCreditEvent.findUnique({
            where: { idempotencyKey },
          });
          if (existingEvent) {
            this.assertCreditIdempotencyMatch(
              existingEvent,
              id,
              requestFingerprint!,
            );
            return {
              replayed: true,
              eventId: existingEvent.id,
              policyRevision: existingEvent.policyRevision ?? null,
            };
          }
        }

        // Credit defaults and the audit "old" values must come from the row
        // observed after wallet -> account locks. Reading them before the
        // transaction loses concurrent administrator updates.
        const existing = await tx.billingAccountCreditConfig.findUnique({
          where: { billingAccountId: id },
        });
        await this.confirmPreviousCreditBoundaryUnderLock(tx, id, existing);
        const nextLimitUsd = input.limitCents === undefined
          ? usd(existing?.limitUsd ?? 0)
          : centsToUsd(this.normalizeNonNegativeCents(input.limitCents, 'limitCents'));
        const nextStatus = input.status === undefined
          ? existing?.status ?? CREDIT_STATUS_DISABLED
          : this.normalizeCreditStatus(input.status);
        const nextTermsDays = input.termsDays === undefined
          ? existing?.termsDays ?? null
          : this.normalizeNullableInt(input.termsDays, 'termsDays');
        const nextEffectiveAt = input.effectiveAt === undefined
          ? existing?.effectiveAt ?? null
          : this.normalizeDate(input.effectiveAt);
        const nextExpiresAt = input.expiresAt === undefined
          ? existing?.expiresAt ?? null
          : this.normalizeDate(input.expiresAt);
        const updatedBy = this.normalizeNullable(input.updatedBy);
        const note = input.note === undefined
          ? existing?.note ?? null
          : this.normalizeNullable(input.note);
        const reason = this.normalizeNullable(input.reason);

        if (
          nextEffectiveAt
          && nextExpiresAt
          && nextExpiresAt.getTime() <= nextEffectiveAt.getTime()
        ) {
          throw new BadRequestException('expiresAt 必须晚于 effectiveAt');
        }
        if (
          nextStatus === CREDIT_STATUS_ACTIVE
          && nextLimitUsd.gt(0)
          && (nextTermsDays === null || nextTermsDays <= 0)
        ) {
          throw new BadRequestException('启用正信用额度时 termsDays 必须为正整数');
        }

        // This is a decision clock captured after the aggregate locks. Commit
        // visibility is deliberately confirmed in a second transaction below.
        const policyDecisionAt = await this.captureCreditPolicyClock(tx);
        const policyRevision = (existing?.policyRevision ?? 0) + 1;

        // Must not be an upsert. Prisma compiles upsert into a native
        // INSERT ... ON CONFLICT DO UPDATE, and PostgreSQL fires BEFORE INSERT
        // row triggers before it resolves the conflict. The revision guard then
        // validates an in-practice UPDATE against its INSERT branch, which
        // demands revision 1, so every edit after the first one is rejected with
        // "enterprise credit initial revision must be 1 and pending". Branching
        // explicitly cannot race: `existing` was read after the wallet/account
        // locks this transaction still holds.
        const nextConfig = {
          limitUsd: nextLimitUsd,
          status: nextStatus,
          policyRevision,
          policyEffectiveBoundaryAt: null,
          policyBoundaryComplete: false,
          termsDays: nextTermsDays,
          effectiveAt: nextEffectiveAt,
          expiresAt: nextExpiresAt,
          updatedBy,
          note,
        };
        if (existing) {
          await tx.billingAccountCreditConfig.update({
            where: { billingAccountId: id },
            data: nextConfig,
          });
        } else {
          await tx.billingAccountCreditConfig.create({
            data: { billingAccountId: id, ...nextConfig },
          });
        }
        const event = await tx.billingAccountCreditEvent.create({
          data: {
            billingAccountId: id,
            oldLimitUsd: existing?.limitUsd ?? null,
            newLimitUsd: nextLimitUsd,
            oldStatus: existing?.status ?? null,
            newStatus: nextStatus,
            oldTermsDays: existing?.termsDays ?? null,
            newTermsDays: nextTermsDays,
            oldEffectiveAt: existing?.effectiveAt ?? null,
            newEffectiveAt: nextEffectiveAt,
            oldExpiresAt: existing?.expiresAt ?? null,
            newExpiresAt: nextExpiresAt,
            temporalSnapshotComplete: true,
            policyRevision,
            policyDecisionAt,
            policyEffectiveBoundaryAt: null,
            policyBoundaryComplete: false,
            requestFingerprint,
            actorId: updatedBy,
            reason,
            note,
            idempotencyKey,
          },
        });
        return { replayed: false, eventId: event.id, policyRevision };
      });
      if (mutation.policyRevision === null) {
        throw this.businessError(
          'enterprise_credit_history_unavailable',
          '幂等授信事件缺少可信修订号，无法确认提交边界',
          409,
        );
      }
      await this.confirmCreditPolicyBoundary(
        id,
        mutation.eventId,
        mutation.policyRevision,
      );
      fanoutTarget = {
        eventId: mutation.eventId,
        policyRevision: mutation.policyRevision,
      };
    } catch (err) {
      if (idempotencyKey && hasPrismaErrorCode(err, 'P2002')) {
        // P2002 also covers account+revision and unrelated unique indexes. It
        // is only an idempotent replay after proving the exact account and
        // normalized request fingerprint against the durable event.
        const existingEvent = await this.prisma.billingAccountCreditEvent.findUnique({
          where: { idempotencyKey },
        });
        if (!existingEvent) throw err;
        this.assertCreditIdempotencyMatch(
          existingEvent,
          id,
          requestFingerprint!,
        );
        if (existingEvent.policyRevision === null) {
          throw this.businessError(
            'enterprise_credit_history_unavailable',
            '幂等授信事件缺少可信修订号，无法确认提交边界',
            409,
          );
        }
        await this.confirmCreditPolicyBoundary(
          id,
          existingEvent.id,
          existingEvent.policyRevision,
        );
        fanoutTarget = {
          eventId: existingEvent.id,
          policyRevision: existingEvent.policyRevision,
        };
      } else {
        throw err;
      }
    }

    if (!fanoutTarget) {
      throw this.businessError(
        'enterprise_credit_history_unavailable',
        '企业授信发布目标缺失，已停止自动发布',
        409,
      );
    }
    // Replays are recovery attempts too: tx1 may have committed immediately
    // before a process crash. The marker is written only after Publisher has
    // accepted or durably queued every Key refresh; failures propagate and the
    // periodic policy recovery sweep retries the still-unmarked event.
    await enqueueEnterpriseCreditPolicyFanout(this.prisma, this.publisherSync, {
      billingAccountId: id,
      eventId: fanoutTarget.eventId,
      policyRevision: fanoutTarget.policyRevision,
    });
    // 授信恢复后立刻解除 debt_open 关闸。必须放在 fanout 之后：先让网关知道
    // 额度回来了，再放行流量，否则客户会在网关侧再撞一次拒绝。
    //
    // 为什么需要这一步：解封判据此前只认「该笔未批准欠款已被实付核销」，
    // 与授信是否恢复无关。国内 prod 2026-08-28 实测：运营 09:27 已把 config
    // 改回 ACTIVE，客户仍打不通，一直等到 13:21 充值到账才恢复 —— 白断 4 小时。
    //
    // best-effort：授信变更本身已提交且 fanout 完成，解封失败不该把一次成功的
    // 授信操作变成失败。overdue worker 每轮兜底会重试（该方法幂等，判据全部重读）。
    try {
      await this.prisma.$transaction((tx) => (
        this.billing.releasePolicyRestoredGatewayBalanceDebtRestrictions(tx, id)
      ));
    } catch (err) {
      this.logger.warn(
        `enterprise credit policy restored release failed account=${id}: `
        + `${(err as Error).message}`,
      );
    }
    return this.getEnterpriseCredit(id);
  }

  async listEnterpriseCreditEvents(
    id: string,
    options: { limit?: number; cursor?: string | null } = {},
  ): Promise<{ items: EnterpriseAccountCreditEventView[]; nextCursor: string | null }> {
    await this.requireEnterpriseAccount(id);
    const take = Math.min(Math.max(options.limit ?? 50, 1), 200);
    const cursor = this.normalizeNullable(options.cursor);
    const rows = await this.prisma.billingAccountCreditEvent.findMany({
      where: { billingAccountId: id },
      orderBy: { createdAt: 'desc' },
      take: take + 1,
      ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
    });
    const hasMore = rows.length > take;
    const page = hasMore ? rows.slice(0, take) : rows;
    return {
      items: page.map((row) => this.toCreditEventView(row)),
      nextCursor: hasMore ? page[page.length - 1].id : null,
    };
  }

  async resolveFundingAnchor(id: string): Promise<EnterpriseAccountFundingAnchor> {
    const account = await this.requireEnterpriseAccount(id);
    if (account.status !== 'active') {
      throw this.businessError('enterprise_account_unusable', '企业账户不可用', 409);
    }
    if (!account.ownerUserId) {
      throw this.businessError(
        'enterprise_account_owner_required',
        '企业账户缺少 owner 用户，无法充值',
        409,
      );
    }
    const tenant = await this.prisma.tenant.findFirst({
      where: {
        billingAccountId: id,
        status: 'active',
        deletedAt: null,
      },
      select: { id: true },
      orderBy: { createdAt: 'asc' },
    });
    if (!tenant) {
      throw this.businessError(
        'enterprise_account_tenant_required',
        '企业账户未挂载有效 tenant，无法充值',
        409,
      );
    }
    return {
      billingAccountId: id,
      ownerUserId: account.ownerUserId,
      tenantId: tenant.id,
    };
  }

  // ---------------------------------------------------------------------------
  // owner members
  // ---------------------------------------------------------------------------

  async listOwnerMembers(id: string) {
    await this.requireEnterpriseAccount(id);
    const members = await this.prisma.billingAccountMember.findMany({
      where: { billingAccountId: id },
      orderBy: { joinedAt: 'asc' },
    });
    return members.map((m) => ({
      id: m.id,
      userId: m.userId,
      role: m.role,
      status: m.status,
      joinedAt: m.joinedAt,
    }));
  }

  async upsertOwnerMember(id: string, input: UpsertOwnerMemberInput) {
    const userId = this.requireString(input.userId, 'userId');
    const member = await this.prisma.$transaction(async (tx) => {
      const { account } = await this.lockExistingEnterpriseAccount(tx, id);
      // 议题二批一：迟到的旧 owner-member 请求会把成员重新激活（本方法无条件 upsert
      // status:'active'），必须在账户行锁内拒绝已回收账户。
      this.assertNotQuarantined(account);
      // 幂等 upsert：重复调用不产生重复 owner member。Account
      // 行锁先于首次 BAM insert 的 FK 检查，不与资金路径 A -> BAM 逆序。
      this.assertProvisioningOwner(account, userId);
      return tx.billingAccountMember.upsert({
        where: { billingAccountId_userId: { billingAccountId: id, userId } },
        create: {
          billingAccountId: id,
          userId,
          role: 'owner',
          status: 'active',
        },
        update: {
          role: 'owner',
          status: 'active',
        },
      });
    });
    return {
      id: member.id,
      userId: member.userId,
      role: member.role,
      status: member.status,
    };
  }

  // ---------------------------------------------------------------------------
  // owner transfer (trusted user-api/admin-api internal callers only)
  // ---------------------------------------------------------------------------

  async transferEnterpriseOwner(
    id: string,
    input: TransferEnterpriseOwnerInput,
  ): Promise<TransferEnterpriseOwnerResult> {
    const accountId = this.requireString(id, 'id');
    const tenantId = this.requireString(input?.tenantId, 'tenantId');
    const newOwner = input?.newOwner ?? ({} as EnterpriseOwnerUserSnapshot);
    const previousOwnerUserId = this.requireString(
      input?.previousOwnerUserId,
      'previousOwnerUserId',
    );
    const newOwnerUserId = this.requireString(newOwner.id, 'newOwner.id');
    if (newOwnerUserId === previousOwnerUserId) {
      throw new BadRequestException('newOwner.id 必须与 previousOwnerUserId 不同');
    }
    return this.prisma.$transaction(async (tx) => {
      // Workspace/user mirrors also materialize the user before touching the
      // account aggregate. Keep that ordering here and only update this user
      // row: an ownership transfer must not reactivate unrelated accounts.
      const targetUserActive = await this.ensureTransferTargetUser(tx, newOwner);

      const { account } = await this.lockExistingEnterpriseAccount(tx, accountId);
      if (account.status !== 'active') {
        throw this.businessError(
          'enterprise_account_unusable',
          '企业账户不可用',
          409,
        );
      }
      const tenant = await this.lockTenantForAccountBinding(tx, tenantId);
      if (tenant.billingAccountId !== accountId) {
        throw this.businessError(
          'enterprise_tenant_binding_mismatch',
          '工作区未绑定到该企业账户',
          409,
        );
      }

      // A retry can legitimately still carry the former owner after the first
      // transaction committed. It is idempotent only when both authoritative
      // owner columns already point to the exact requested target.
      if (
        account.ownerUserId === newOwnerUserId
        && tenant.ownerUserId === newOwnerUserId
      ) {
        return {
          id: accountId,
          tenantId,
          previousOwnerUserId,
          ownerUserId: newOwnerUserId,
          transferred: false,
          idempotent: true,
        };
      }
      if (
        account.ownerUserId !== previousOwnerUserId
        || tenant.ownerUserId !== previousOwnerUserId
      ) {
        throw this.businessError(
          'enterprise_owner_transfer_conflict',
          '企业账户或工作区 owner 已变更，请刷新后重试',
          409,
        );
      }
      if (newOwner.isActive === false || !targetUserActive) {
        throw this.businessError(
          'enterprise_new_owner_inactive',
          '新的企业管理员账号不可用',
          409,
        );
      }

      // Financial readers lock memberships after wallet -> account -> tenant.
      // Take the same table order before changing the role projection.
      await this.lockOwnerTransferMemberships(
        tx,
        accountId,
        tenantId,
        previousOwnerUserId,
        newOwnerUserId,
      );

      await tx.billingAccount.update({
        where: { id: accountId },
        data: { ownerUserId: newOwnerUserId },
      });
      await tx.tenant.update({
        where: { id: tenantId },
        data: { ownerUserId: newOwnerUserId },
      });

      const orderedUserIds = [previousOwnerUserId, newOwnerUserId].sort();
      for (const userId of orderedUserIds) {
        await tx.tenantMember.upsert({
          where: { tenantId_userId: { tenantId, userId } },
          create: {
            tenantId,
            userId,
            role: userId === newOwnerUserId ? 'owner' : 'member',
            status: 'active',
          },
          update: {
            role: userId === newOwnerUserId ? 'owner' : 'member',
            status: 'active',
          },
        });
      }
      for (const userId of orderedUserIds) {
        await tx.billingAccountMember.upsert({
          where: {
            billingAccountId_userId: { billingAccountId: accountId, userId },
          },
          create: {
            billingAccountId: accountId,
            userId,
            role: userId === newOwnerUserId ? 'owner' : 'member',
            status: 'active',
          },
          update: {
            role: userId === newOwnerUserId ? 'owner' : 'member',
            status: 'active',
          },
        });
      }

      return {
        id: accountId,
        tenantId,
        previousOwnerUserId,
        ownerUserId: newOwnerUserId,
        transferred: true,
        idempotent: false,
      };
    });
  }

  // ---------------------------------------------------------------------------
  // attach / detach
  // ---------------------------------------------------------------------------

  async attachTenant(id: string, input: AttachTenantInput) {
    const tenantId = this.requireString(input.tenantId, 'tenantId');
    const expectedOwner = input.userId == null ? undefined : this.requireString(input.userId, 'userId');
    const attached = await this.attachTenantInternal(id, tenantId, expectedOwner);
    // The database binding is committed before any cache side effect. Resolve
    // it again here so an older attach completion cannot publish its stale
    // account after a newer detach/rebind has committed.
    await this.billing.syncTenantBalanceCacheForCurrentBinding(tenantId);
    // attach（无论首次还是幂等命中）后统一做 account 级 key-balance fanout。
    await this.fanoutAccountKeyBalances(id);
    return { id, tenantId, attached, idempotent: !attached };
  }

  // ---------------------------------------------------------------------------
  // 议题二批一：企业开通回收的屏障校验
  // 设计依据：me/payg-multiplier-verify-timeout-v2.md v69 §2.2b（唯一真源）
  // ---------------------------------------------------------------------------

  /**
   * verification 级事务咨询锁（议题二批一）。`createEnterpriseAccount` 与 `voidProvisioning`
   * 必须在**各自事务内**取同一把锁，二者才真正互斥序列化。
   * 键与设计稿一致：hashtext('enterprise_provisioning:' || verification_id)。
   * ⚠️ hashtext 只有 32 位：碰撞只会让两个不相关的 verification 误串行、不破坏正确性。
   */
  private async acquireProvisioningLock(
    tx: Prisma.TransactionClient,
    verificationId: string,
  ): Promise<void> {
    await tx.$executeRaw`
      SELECT pg_advisory_xact_lock(hashtext(${'enterprise_provisioning:' + verificationId}))
    `;
  }

  /**
   * 权威屏障：verification 级墓碑。**只有 createEnterpriseAccount 需要查它**——
   * 它面对的正是「账户还不存在」的情形，此时账户行级列无处可置。
   * 必须与建账、内层 attach 在**同一事务、同一把 verification 咨询锁**内，否则
   * 「查墓碑=无 → void 落墓碑并完成 → create 提交新账户」的窗口依旧成立。
   */
  private async assertNotTombstoned(
    tx: Prisma.TransactionClient,
    verificationId: string,
  ): Promise<void> {
    const rows = await tx.$queryRaw<Array<{ verificationId: string }>>`
      SELECT "verification_id" AS "verificationId"
      FROM "enterprise_provisioning_tombstones"
      WHERE "verification_id" = ${verificationId}
    `;
    if (rows.length > 0) {
      throw this.businessError(
        'enterprise_provisioning_tombstoned',
        '该企业认证已被回收，无法再开通；重新开通需平台处理',
        409,
      );
    }
  }

  /**
   * 派生屏障：账户行级 quarantine 标记。供**已持有账户行**的热写点做 O(1) 检查
   * （attach / owner-members / snapshot 激活）。
   * ⚠️ 判据是 `provisioningQuarantinedAt`，**不是 `status`**——负余额账户按既有策略
   * 保持 `active`（见 :463-476 的欠款守卫），用 status 做依据会漏掉它。
   */
  private assertNotQuarantined(account: { provisioningQuarantinedAt?: Date | null }): void {
    if (account.provisioningQuarantinedAt) {
      throw this.businessError(
        'enterprise_account_quarantined',
        '该企业账户已被回收，开通类操作已停用',
        409,
      );
    }
  }

  /**
   * 回收专用的 wallet→account 锁（议题二批一）。
   * 与 `lockExistingEnterpriseAccount` 的唯一差别：**允许软删（`deleted_at` 非空）的企业账户**。
   * ⚠️ 为什么必须有它：`voidProvisioning` 的枚举**含软删账户**（软删账户仍可能残留 tenant 绑定与
   * active 成员，正是 R3 要抓的"软删残留"），而生命周期用的 helper 强制 `deletedAt:null`、
   * 处理到软删行就抛 404 ⇒ **整个事务连墓碑一起回滚**，"全部账户回收"的承诺失效。
   * 普通生命周期入口继续用原 helper（保持排除软删的既有语义）。
   */
  private async lockEnterpriseAccountForRecovery(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<LockedEnterpriseAccountContext | null> {
    const walletRows = await tx.$queryRaw<Array<{ balanceUsd: Prisma.Decimal }>>`
      SELECT "balance_usd" AS "balanceUsd"
      FROM "account_wallets"
      WHERE "billing_account_id" = ${id}
      FOR UPDATE
    `;
    const accountRows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id" FROM "billing_accounts" WHERE "id" = ${id} FOR UPDATE
    `;
    if (accountRows.length !== 1) return null;
    const account = await tx.billingAccount.findFirst({
      where: { id },
      select: {
        id: true, type: true, ownerUserId: true, status: true,
        provisioningQuarantinedAt: true,
      },
    });
    if (!account || account.type !== ENTERPRISE_ACCOUNT_TYPE) return null;
    return {
      account,
      // 钱包缺失（聚合不完整）在回收路径按 0 处理：回收只收缩资源，不做资金判定；
      // 余额判定只影响"是否 suspend"，缺钱包时按非负处理 ⇒ 走 suspend 分支，方向安全。
      walletBalanceUsd: walletRows.length === 1 ? usd(walletRows[0].balanceUsd) : new Prisma.Decimal(0),
    };
  }

  /**
   * detach 的事务内核（议题二批一）。复合回收必须在**外层单事务**内逐 tenant 调它，
   * 因为 detachTenantForRecovery 自己开事务且在提交后做缓存同步与 fanout，
   * 在外层事务里调用会嵌套提交、破坏「整笔回滚」。
   * 缓存同步与 key-balance fanout 一律留给调用方在**外层事务提交之后**执行。
   */
  private async detachTenantCore(
    tx: Prisma.TransactionClient,
    accountId: string,
    tenantId: string,
    /** 回收路径传入**已锁**的 account（它可能是软删行，不能再走排除软删的 helper）。 */
    lockedAccount?: LockedEnterpriseAccount,
  ): Promise<boolean> {
    const account = lockedAccount
      ?? (await this.lockExistingEnterpriseAccount(tx, accountId)).account;
    const tenant = await this.lockTenantForAccountBinding(tx, tenantId);
    // 已改绑他人 ⇒ 幂等返回 false，且不清空那个更新的绑定。
    if (tenant.billingAccountId !== accountId) return false;
    // ⚠️ owner 一致性只是**挂载**的前置条件，回收（纯收缩）时不该再校验（评审 P0）。
    //
    // 校验留在回收路径上的后果：一行 owner 不一致的 tenant 抛 409 ⇒ voidProvisioning 整个
    // 事务回滚 ⇒ **墓碑 INSERT 也一起没了** ⇒ 屏障未建立、状态停在 VOIDING、每次「继续作废」
    // 都撞同一行，而迟到的 createEnterpriseAccount 仍能建号。这正是批一要消灭的形态本身。
    //
    // owner 不一致是**可达**的，不是理论：transferEnterpriseOwner 只更新传入的那一个 tenantId
    // 的 owner_user_id，而一个账户可绑多个 tenant ⇒ 转让完成的那一刻其余 tenant 就不一致了；
    // 另外 lockEnterpriseAccountForRecovery 有意允许软删行，其 ownerUserId 可为 NULL。
    if (!lockedAccount) this.assertTenantOwnerMatchesAccount(account, tenant);
    await tx.tenant.update({
      where: { id: tenantId },
      data: { billingAccountId: null },
    });
    return true;
  }

  async detachTenantForRecovery(id: string, tenantId: string, reason: string) {
    const normalizedTenant = this.requireString(tenantId, 'tenantId');
    const normalizedReason = this.requireString(reason, 'reason');
    const detached = await this.prisma.$transaction(
      async (tx) => this.detachTenantCore(tx, id, normalizedTenant),
    );
    if (detached) {
      this.logger.warn(
        `enterprise account detach account=${id} tenant=${normalizedTenant} reason=${normalizedReason}`,
      );
    }
    // Delete/rewrite the tenant cache from the committed current binding even
    // on an idempotent miss: another rebind may have won while this request was
    // waiting, and the older account must not remove that newer projection.
    await this.billing.syncTenantBalanceCacheForCurrentBinding(normalizedTenant);
    // detach 后账户绑定关系变化，重算 key-balance fanout。
    await this.fanoutAccountKeyBalances(id);
    return { id, tenantId: normalizedTenant, detached, reason: normalizedReason };
  }

  /**
   * 议题二批一：企业开通的**复合回收**（唯一写入口，按 verificationId 聚合）。
   * 设计依据：me/payg-multiplier-verify-timeout-v2.md §2.2b（唯一真源）。
   *
   * 单事务内完成四件事，**同成同败**：
   *   ① 落 verification 级墓碑（ON CONFLICT DO NOTHING；**无论账户数是否为 0 都必落**）
   *   ② 逐账户：全量 detach tenant → 成员失活 → 有条件 suspend → 置 quarantine
   *   ③ 递增 account_version（绑定摘要变化，供 R3-full 版本夹逼）——批二列，本批不写
   *   ④ fanout 作业入队（提交后由 worker 按当前状态重算投影）
   *
   * ⚠️ 为什么不按 accountId 寻址：批一恰恰要覆盖「user 回执丢失、billingAccountId 为空」
   * 与「同一 verificationId 多个账户」两种情形，按 accountId 的入口结构上覆盖不到。
   * ⚠️ 幂等性不依赖 op ledger（那属批二），而由资源状态的条件更新天然保证：
   * 已解绑 no-op、已 inactive 0 行、已 suspended 0 行 ⇒ 重放结果一致，但"本次变更计数"为 0，
   * **调用方不得依赖计数做判定**。
   */
  /** 复合回收的事务超时。默认 60s，必须低于 user 侧执行租约（120s）。 */
  private voidTxTimeoutMs(): number {
    const raw = Number.parseInt(this.config?.get<string>('ENTERPRISE_VOID_TX_TIMEOUT_MS') ?? '', 10);
    return Number.isFinite(raw) && raw > 0 ? Math.min(raw, VOID_TX_TIMEOUT_CEILING_MS) : 60_000;
  }

  async voidProvisioning(input: {
    verificationId: string;
    reason: string;
    /** 审计上下文（冻结要求）：调用方与请求关联键。 */
    audit?: { caller?: string; requestId?: string };
  }) {
    const verificationId = this.requireString(input?.verificationId, 'verificationId');
    const reason = this.requireString(input?.reason, 'reason');

    const result = await this.prisma.$transaction(async (tx) => {
      await this.acquireProvisioningLock(tx, verificationId);

      // ① 墓碑：权威屏障。账户可能压根没建成，此行也必须落 —— 否则「零账户窗口」闭不上。
      await tx.$executeRaw`
        INSERT INTO "enterprise_provisioning_tombstones" ("verification_id", "reason")
        VALUES (${verificationId}, ${reason.slice(0, 500)})
        ON CONFLICT ("verification_id") DO NOTHING
      `;

      // 该 verification 下的**全部**账户（verification_id 只有普通索引，可能多行）；
      // 按 id 升序加锁，避免同类操作之间自相 ABBA。
      // ⚠️ 故意**不过滤 deletedAt**：软删账户仍可能残留 tenant 绑定与 active 成员
      // （R3 的"软删残留"异常就是它），回收必须覆盖。
      const accounts = await tx.billingAccount.findMany({
        where: { verificationId, type: ENTERPRISE_ACCOUNT_TYPE },
        select: { id: true },
        orderBy: { id: 'asc' },
      });

      const fanout: Array<{ kind: string; accountId?: string; tenantId?: string; apiKeyId?: string }> = [];
      const perAccount: Array<{
        accountId: string;
        detachedTenantIds: string[];
        deactivatedMemberCount: number;
        accountStatus: string;
        pendingManual: boolean;
      }> = [];

      for (const row of accounts) {
        // 锁序恒为 wallet → account，随后 tenants → members。
        // 用回收专用 helper：它允许软删行（软删账户仍可能残留绑定与成员）。
        const locked = await this.lockEnterpriseAccountForRecovery(tx, row.id);
        // 行在枚举后被物理删除/改类型 ⇒ 跳过，不让单行异常回滚整笔回收。
        if (!locked) continue;

        // ② 全量 detach：一个账户可绑多个 tenant，必须遍历，不能只处理"当前那一个"。
        const boundTenants = await tx.tenant.findMany({
          where: { billingAccountId: row.id },
          select: { id: true },
          orderBy: { id: 'asc' },
        });
        const detachedTenantIds: string[] = [];
        for (const tenant of boundTenants) {
          // 传入已锁的 account，避免 detachTenantCore 内部再走"排除软删"的 helper。
          const ok = await this.detachTenantCore(tx, row.id, tenant.id, locked.account);
          if (ok) detachedTenantIds.push(tenant.id);
        }

        // 成员失活：条件更新，天然幂等（已 inactive ⇒ 0 行）。
        const deactivated = await tx.billingAccountMember.updateMany({
          where: { billingAccountId: row.id, status: 'active' },
          data: { status: 'inactive' },
        });

        // ③ **有条件** suspend：负余额账户按既有策略必须保持 active 并转人工
        // （既有守卫 enterprise_account_has_outstanding_credit 就是这个规则，在 wallet 行锁内判定）。
        const pendingManual = locked.walletBalanceUsd.lt(0);
        let accountStatus = locked.account.status;
        if (!pendingManual && accountStatus === 'active') {
          await tx.billingAccount.update({
            where: { id: row.id },
            data: { status: 'suspended' },
          });
          accountStatus = 'suspended';
        }

        // 派生屏障：只写首次时间（COALESCE），重复 void 不漂移审计时间。
        await tx.$executeRaw`
          UPDATE "billing_accounts"
          SET "provisioning_quarantined_at" = COALESCE("provisioning_quarantined_at", now())
          WHERE "id" = ${row.id}
        `;

        // ④ fanout 入队：被解绑 tenant 名下的 key 必须按 keyId 单独重算——
        // syncBillingAccountKeyBalances(accountId) 按"当前仍绑该账户的 tenant"查 key，
        // detach 提交后那些 tenant 已不在范围内，其 key 投影不会被重算。
        // 批量取 key（原实现逐 tenant 查，账户绑多个 tenant 时来回打库、拉长事务）。
        if (detachedTenantIds.length > 0) {
          const keys = await tx.apiKey.findMany({
            where: { tenantId: { in: detachedTenantIds }, deletedAt: null },
            select: { id: true },
          });
          for (const key of keys) fanout.push({ kind: 'KEY_BY_ID', apiKeyId: key.id });
          for (const tenantId of detachedTenantIds) fanout.push({ kind: 'TENANT_CACHE', tenantId });
        }
        fanout.push({ kind: 'ACCOUNT', accountId: row.id });

        perAccount.push({
          accountId: row.id,
          detachedTenantIds,
          deactivatedMemberCount: deactivated.count,
          accountStatus,
          pendingManual,
        });
      }

      // fanout 作业与资源回收**同事务**入队：崩溃后 job 必定存在，worker 幂等重放。
      // 批量插入（原实现逐条 INSERT，job 数与 key 数同阶，会把事务拖长）。
      // ⚠️ 复位放在 `if (fanout.length > 0)` **之外**（复核 P3）：
      // 「有历史 ALERTED 行、但本次一个可锁账户都没有」（例如账户已被物理删除）时，
      // 包在 if 里就会漏掉复位 —— 而那恰恰是最需要重跑的情形。
      //
      // 先把已 ALERTED 的行复位成可领取：否则「继续作废」永远无法让它们重跑。
        //
        // 机制：唯一键是 verificationId:kind:resource，ALERTED 是终态且**保留行** ⇒ 永久占位；
        // createMany skipDuplicates 会跳过，而 worker 的 claim 只取 PENDING ⇒ 重放看起来成功、
        // 实际那几个 fanout 再也不会执行，只能有人进库改状态。这与「不留运维手工动作」冲突。
        //
      // 复位放在**同一事务**里：要么连回收一起回滚，要么连回收一起生效，不产生中间态。
      // 只复位 ALERTED —— DONE 行代表该资源已收敛，不该被重新排（重放时它本就该被跳过）。
      await tx.enterpriseRecoveryFanoutJob.updateMany({
        where: { verificationId, status: 'ALERTED' },
        data: {
          status: 'PENDING',
          attempts: 0,
          leaseToken: null,
          // ⚠️ lockedAt 也要显式清（复核 P3）：目前失败写回路径恒带 lockedAt=null，
          // 所以 ALERTED 行的 lockedAt 必然已是 null —— 但那是**隐式不变量**，
          // 一旦哪天写回路径变了，复位出来的行就会带着陈旧 lockedAt 被当成 stale 处理。
          lockedAt: null,
          nextRunAt: new Date(),
        },
      });

      if (fanout.length > 0) {
        await tx.enterpriseRecoveryFanoutJob.createMany({
          data: fanout.map((job) => ({
            verificationId,
            kind: job.kind,
            accountId: job.accountId ?? null,
            tenantId: job.tenantId ?? null,
            apiKeyId: job.apiKeyId ?? null,
            idempotencyKey: `${verificationId}:${job.kind}:${job.apiKeyId ?? job.tenantId ?? job.accountId ?? ''}`,
          })),
          skipDuplicates: true,
        });
      }

      return { accounts: perAccount, accountCount: perAccount.length };
    }, {
      // 显式超时：默认 5s 在"多账户 × 多 tenant × 多 key"下会稳定超时回滚。
      // 必须**低于** user 侧执行租约（默认 120s），否则 user 侧会先接管、造成并发重放。
      timeout: this.voidTxTimeoutMs(),
      maxWait: 10_000,
    });

    // 审计：放行 user-api 调用回收是**权力扩张**（比未放行的 detach-tenant 更强），
    // 故必须记录调用方、请求关联键与**受影响资源清单**，而不只是账户数。
    const summary = result.accounts
      .map((a) => `${a.accountId}[tenants=${a.detachedTenantIds.join('|') || '-'}`
        + `,members=${a.deactivatedMemberCount},status=${a.accountStatus}`
        + `${a.pendingManual ? ',pendingManual' : ''}]`)
      .join(' ');
    this.logger.warn(
      `enterprise provisioning voided caller=${input?.audit?.caller ?? 'unknown'} `
      + `requestId=${input?.audit?.requestId ?? '-'} verification=${verificationId} `
      + `accounts=${result.accountCount} reason=${reason} ${summary}`,
    );
    return result;
  }

  /**
   * User 开通成功闸门的只读资源证明。一个 REPEATABLE READ 快照内返回
   * 指定账户、钱包存在性、Owner 成员、指定 Tenant 及 verification 全量账户数。
   * 不返回资金金额，不修复资源；历史删除和墓碑仍计入占用事实。
   */
  async provisioningProof(input: { verificationId: string; accountId: string; tenantId: string; ownerUserId: string }) {
    for (const value of Object.values(input)) if (typeof value !== 'string' || !value.trim() || value.length > 128) {
      throw new BadRequestException({ code: 'enterprise_proof_invalid', message: '开通资源引用无效', data: null });
    }
    return this.prisma.$transaction(async tx => {
      await tx.$executeRaw`SET TRANSACTION READ ONLY`;
      const tombstones = await tx.$queryRaw<Array<{ verificationId: string }>>`SELECT verification_id AS "verificationId" FROM enterprise_provisioning_tombstones WHERE verification_id = ${input.verificationId}`;
      const [accountCount, account, tenant, ownerMember, tenantMember] = await Promise.all([
        tx.billingAccount.count({ where: { verificationId: input.verificationId } }),
        tx.billingAccount.findUnique({ where: { id: input.accountId }, select: { id: true, type: true, status: true, verificationId: true, ownerUserId: true,
          uscc: true, deletedAt: true, provisioningQuarantinedAt: true, wallet: { select: { billingAccountId: true } } } }),
        tx.tenant.findUnique({ where: { id: input.tenantId }, select: { id: true, type: true, status: true, deletedAt: true, ownerUserId: true, billingAccountId: true } }),
        tx.billingAccountMember.findUnique({ where: { billingAccountId_userId: { billingAccountId: input.accountId, userId: input.ownerUserId } }, select: { userId: true, role: true, status: true } }),
        tx.tenantMember.findUnique({ where: { tenantId_userId: { tenantId: input.tenantId, userId: input.ownerUserId } }, select: { userId: true, role: true, status: true } }),
      ]);
      return { ...input, observedAt: (await tx.$queryRaw<Array<{ now: Date }>>`SELECT clock_timestamp() AS now`)[0].now.toISOString(), tombstoned: tombstones.length > 0, accountCount,
        account: account ? { id: account.id, type: account.type, status: account.status, verificationId: account.verificationId, ownerUserId: account.ownerUserId,
          uscc: account.uscc?.trim().toUpperCase() ?? null, deletedAt: account.deletedAt?.toISOString() ?? null, quarantinedAt: account.provisioningQuarantinedAt?.toISOString() ?? null } : null,
        walletExists: Boolean(account?.wallet), ownerMember, tenant: tenant ? { ...tenant, deletedAt: tenant.deletedAt?.toISOString() ?? null } : null, tenantMember };
    }, { isolationLevel: Prisma.TransactionIsolationLevel.RepeatableRead });
  }

  /** 既有重提核账：verification 可能多账户，墓碑独立于账户数量。 */
  async reconcileByVerification(verificationId: string) {
    const vid = this.requireString(verificationId, 'verificationId');

    const tombRows = await this.prisma.$queryRaw<Array<{ createdAt: Date }>>`
      SELECT "created_at" AS "createdAt"
      FROM "enterprise_provisioning_tombstones"
      WHERE "verification_id" = ${vid}
    `;
    const tombstoned = tombRows.length > 0;

    const rows = await this.prisma.billingAccount.findMany({
      where: { verificationId: vid, type: ENTERPRISE_ACCOUNT_TYPE },
      select: {
        id: true, status: true, deletedAt: true, provisioningQuarantinedAt: true,
        wallet: { select: { balanceUsd: true } },
        tenants: { select: { id: true } },
        members: { where: { status: 'active' }, select: { userId: true } },
      },
      orderBy: { id: 'asc' },
    });

    const accounts = rows.map((r) => ({
      accountId: r.id,
      // 负余额账户按既有策略保持 active、转人工：对外派生分类，DB 里仍是 active。
      status: r.wallet && r.wallet.balanceUsd.lt(0) ? 'active_pending_manual' : r.status,
      deletedAt: r.deletedAt,
      quarantinedAt: r.provisioningQuarantinedAt,
      tenantBindingCleared: r.tenants.length === 0,
      activeMemberCount: r.members.length,
      balanceUsd: r.wallet ? r.wallet.balanceUsd.toString() : null,
    }));

    return {
      tombstoned,
      tombstonedAt: tombstoned ? tombRows[0].createdAt : null,
      accountCount: accounts.length,
      accounts,
      aggregate: {
        allBindingsCleared: accounts.every((a) => a.tenantBindingCleared),
        totalActiveMembers: accounts.reduce((n, a) => n + a.activeMemberCount, 0),
        anyAccountActive: accounts.some((a) => a.status === 'active' || a.status === 'active_pending_manual'),
        anyAccountSuspended: accounts.some((a) => a.status === 'suspended'),
        anyAccountQuarantined: accounts.some((a) => a.quarantinedAt !== null),
        minBalanceUsd: rows.length
          ? rows.reduce<string | null>((min, r) => {
              if (!r.wallet) return min;
              const v = r.wallet.balanceUsd.toString();
              return min === null || r.wallet.balanceUsd.lt(new Prisma.Decimal(min)) ? v : min;
            }, null)
          : null,
      },
    };
  }

  /**
   * 议题二批一：只读危害候选集（供 R3-lite 巡检）。
   * 扫描域必须含 `deleted_at` 非空的软删账户、`verification_id IS NULL` 的孤儿账户，
   * 以及"无危害但同 verification 重复"的账户（后者用于基数异常判定）——
   * 这些 user 侧枚举不出来，故必须由 billing 起算。
   *
   * 稳定分页：`ORDER BY verification_id ASC NULLS LAST, account_id ASC`，
   * 按 NULL 分区分两段 seek；`nextCursor === null` 是**唯一**终止条件。
   */
  async listProvisioningHazards(input: { cursor?: string | null; limit?: number }) {
    const limit = Math.min(Math.max(input?.limit ?? 200, 1), 500);
    let cur: { v: string | null; a: string } | null = null;
    if (input?.cursor) {
      try {
        cur = JSON.parse(Buffer.from(input.cursor, 'base64').toString('utf8'));
      } catch {
        throw this.businessError('invalid_cursor', 'cursor 无法解析', 400);
      }
    }

    const inNullSegment = cur !== null && cur.v === null;
    const rows = await this.prisma.billingAccount.findMany({
      where: {
        type: ENTERPRISE_ACCOUNT_TYPE,
        // ⚠️ 非 NULL 段必须**显式**过滤 `verificationId IS NOT NULL`：
        // 否则首页会混入 NULL 分区，而总行数不足 limit 时又会返回 {v:null,a:''}，
        // 下一页把这些孤儿账户**整批重复**一次。
        ...(inNullSegment
          ? { verificationId: null, id: { gt: cur!.a } }
          : {
              verificationId: { not: null },
              ...(cur
                ? { OR: [
                    { verificationId: { gt: cur.v! } },
                    { AND: [{ verificationId: cur.v! }, { id: { gt: cur.a } }] },
                  ] }
                : {}),
            }),
      },
      select: {
        id: true, verificationId: true, status: true, deletedAt: true,
        provisioningQuarantinedAt: true,
        wallet: { select: { balanceUsd: true } },
        tenants: { select: { id: true }, orderBy: { id: 'asc' } },
        members: { where: { status: 'active' }, select: { userId: true }, orderBy: { userId: 'asc' } },
      },
      orderBy: [{ verificationId: 'asc' }, { id: 'asc' }],
      take: limit,
    });

    const vids = Array.from(new Set(rows.map((r) => r.verificationId).filter((v): v is string => !!v)));
    const [siblings, tombs, stalledFanout] = await Promise.all([
      vids.length
        ? this.prisma.billingAccount.findMany({
            where: { verificationId: { in: vids }, type: ENTERPRISE_ACCOUNT_TYPE },
            select: { id: true, verificationId: true },
            orderBy: { id: 'asc' },
          })
        : Promise.resolve([]),
      vids.length
        ? this.prisma.$queryRaw<Array<{ verificationId: string }>>`
            SELECT "verification_id" AS "verificationId"
            FROM "enterprise_provisioning_tombstones"
            WHERE "verification_id" = ANY(${vids}::text[])
          `
        : Promise.resolve([]),
      // ⚠️ 卡住的 fanout 必须在这里露出来（复核 P3）：运营看不到 fanout 表，
      // 而 ALERTED 行的唯一复位手段是**再点一次「继续作废」**。不暴露就等于要求运营
      // 「凭直觉知道该再点一次」，那实质上就是一条口口相传的运维手册 —— 本轮要避免的东西。
      // 挂到这个已有的只读端点上，比新加自愈 worker 或新端点都小。
      vids.length
        ? this.prisma.enterpriseRecoveryFanoutJob.groupBy({
            by: ['verificationId', 'kind'],
            where: { verificationId: { in: vids }, status: 'ALERTED' },
            _count: { _all: true },
          })
        : Promise.resolve([]),
    ]);
    const siblingMap = new Map<string, string[]>();
    for (const sib of siblings) {
      const key = sib.verificationId as string;
      siblingMap.set(key, [...(siblingMap.get(key) ?? []), sib.id]);
    }
    const tombSet = new Set(tombs.map((t) => t.verificationId));
    // verificationId ⇒ [{kind, count}]，按 kind 排序保证 state_fingerprint 稳定。
    const stalledMap = new Map<string, Array<{ kind: string; count: number }>>();
    for (const row of stalledFanout as Array<{
      verificationId: string; kind: string; _count: { _all: number };
    }>) {
      const prev = stalledMap.get(row.verificationId) ?? [];
      stalledMap.set(row.verificationId, [...prev, { kind: row.kind, count: row._count._all }]);
    }
    for (const list of stalledMap.values()) list.sort((a, b) => a.kind.localeCompare(b.kind));

    const items = rows.map((r) => ({
      accountId: r.id,
      verificationId: r.verificationId,
      status: r.status,
      deletedAt: r.deletedAt,
      quarantinedAt: r.provisioningQuarantinedAt,
      tombstoned: r.verificationId ? tombSet.has(r.verificationId) : false,
      // 必须给**排序后的 ID 集合**而非布尔/计数：state_fingerprint 需要它们，计数无法还原集合。
      boundTenantIds: r.tenants.map((t) => t.id),
      activeMemberUserIds: r.members.map((m) => m.userId),
      balanceUsd: r.wallet ? r.wallet.balanceUsd.toString() : null,
      sameVerificationAccountIds: r.verificationId ? (siblingMap.get(r.verificationId) ?? [r.id]) : [r.id],
      // 非空 = 有 fanout 作业已耗尽重试停在 ALERTED；出口是再点一次「继续作废」（会原子复位）。
      stalledFanout: r.verificationId ? (stalledMap.get(r.verificationId) ?? []) : [],
    }));

    // 分页游标：非 NULL 段耗尽后由**服务端**生成首个 NULL 段 cursor，不让调用方自己拼。
    let nextCursor: string | null = null;
    const enc = (v: string | null, a: string) =>
      Buffer.from(JSON.stringify({ v, a }), 'utf8').toString('base64');
    if (rows.length === limit) {
      const last = rows[rows.length - 1];
      nextCursor = enc(last.verificationId, last.id);
    } else if (!inNullSegment) {
      nextCursor = enc(null, '');
    }

    return {
      items,
      nextCursor,
      // 跨页无同一时点快照 ⇒ 巡检只开单不关单（关单走按工单点查复核，属批二）。
      snapshotDegraded: true,
    };
  }

  async listTenants(id: string) {
    await this.requireEnterpriseAccount(id);
    const tenants = await this.prisma.tenant.findMany({
      where: { billingAccountId: id },
      select: { id: true, name: true, type: true, status: true, ownerUserId: true },
      orderBy: { createdAt: 'asc' },
    });
    return tenants;
  }

  /**
   * attach 的事务内核（议题二批一）。`createEnterpriseAccount` 必须在其**单事务**内调它，
   * 否则内层 attach 会另开事务、嵌套提交，"整笔回滚"就是假的。
   */
  private async attachTenantCore(
    tx: Prisma.TransactionClient,
    accountId: string,
    tenantId: string,
    expectedOwnerUserId?: string | null,
  ): Promise<boolean> {
    const { account } = await this.lockExistingEnterpriseAccount(tx, accountId);
    // 议题二批一：迟到的旧 attach 不得把 tenant 重新绑回已回收的账户。
    // 现状核实：本方法此前完全不校验账户状态（对比 resolveFundingAnchor 有校验，属遗漏）。
    // ⚠️ 判据是 provisioningQuarantinedAt 而非 status——负余额账户按既有欠款守卫保持 active。
    this.assertNotQuarantined(account);
    if (
      expectedOwnerUserId !== undefined
      && account.ownerUserId !== expectedOwnerUserId
    ) {
      throw this.businessError(
        'enterprise_account_owner_changed',
        '企业账户 owner 已变更，已停止挂载工作区',
        409,
      );
    }
    const tenant = await this.lockTenantForAccountBinding(tx, tenantId);
    this.assertTenantOwnerMatchesAccount(account, tenant);
    if (tenant.billingAccountId === accountId) {
      // 已挂到本账户 → 幂等，无需变更。
      return false;
    }
    if (tenant.billingAccountId) {
      throw this.businessError(
        'tenant_attach_conflict',
        '该工作区已绑定其他账户',
        409,
      );
    }
    await tx.tenant.update({
      where: { id: tenantId },
      data: { billingAccountId: accountId },
    });
    return true;
  }

  private async attachTenantInternal(
    accountId: string,
    tenantId: string,
    expectedOwnerUserId?: string | null,
  ): Promise<boolean> {
    return this.prisma.$transaction(
      async (tx) => this.attachTenantCore(tx, accountId, tenantId, expectedOwnerUserId),
    );
  }

  // ---------------------------------------------------------------------------
  // guards / usability / fanout
  // ---------------------------------------------------------------------------

  /**
   * 校验企业账户可用于计费（存在、企业类型、active、未软删）。
   * grant/recharge/spend 等资金入口调用前应先过此闸。
   */
  async assertEnterpriseAccountUsable(id: string): Promise<EnterpriseAccountView> {
    const account = await this.getEnterpriseAccount(id);
    if (account.status !== 'active') {
      // 账户存在但状态不可用 → 409 语义(区别于 404 not_found)。
      throw this.businessError(
        'enterprise_account_unusable',
        '企业账户不可用',
        409,
      );
    }
    return account;
  }

  /**
   * account 级 key-balance fanout 复用入口。attach/detach/资金变化后调用。
   */
  async syncEnterpriseAccountKeyBalances(accountId: string): Promise<void> {
    await this.fanoutAccountKeyBalances(accountId);
  }

  private async fanoutAccountKeyBalances(accountId: string): Promise<void> {
    try {
      await this.publisherSync.syncBillingAccountKeyBalances(accountId);
    } catch (err) {
      // fanout 失败不阻断账户操作主链路，仅告警（与 BillingService.scheduleKeyBalanceSync 一致口径）。
      this.logger.warn(
        `enterprise account key-balance fanout failed account=${accountId}: ${(err as Error).message}`,
      );
    }
  }

  private async platformCurrencyCode(): Promise<string> {
    const platformConfig = await this.systemConfig?.getDeploymentConfig();
    return resolvePlatformCurrency(this.config, platformConfig).currencyCode;
  }

  // ---------------------------------------------------------------------------
  // helpers
  // ---------------------------------------------------------------------------

  private async ensureTransferTargetUser(
    tx: Prisma.TransactionClient,
    snapshot: EnterpriseOwnerUserSnapshot,
  ): Promise<boolean> {
    const userId = this.requireString(snapshot?.id, 'newOwner.id');
    const sourceUpdatedAt = this.normalizeDate(snapshot?.sourceUpdatedAt);
    const existing = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, isActive: true, sourceUpdatedAt: true },
    });
    const incomingIsCurrent = !existing?.sourceUpdatedAt
      || Boolean(
        sourceUpdatedAt
        && sourceUpdatedAt.getTime() >= existing.sourceUpdatedAt.getTime(),
      );
    const mirroredAt = new Date();

    if (!existing) {
      const email = this.hasOwn(snapshot, 'email')
        ? await this.normalizeTransferUniqueUserField(tx, userId, 'email', snapshot.email)
        : null;
      const phone = this.hasOwn(snapshot, 'phone')
        ? await this.normalizeTransferUniqueUserField(tx, userId, 'phone', snapshot.phone)
        : null;
      await tx.user.upsert({
        where: { id: userId },
        create: {
          id: userId,
          email,
          phone,
          nickname: this.normalizeNullable(snapshot.nickname)
            ?? this.normalizeNullable(snapshot.email)?.split('@')[0]
            ?? '',
          isActive: typeof snapshot.isActive === 'boolean' ? snapshot.isActive : true,
          sourceUpdatedAt,
          mirroredAt,
        },
        // A concurrent mirror may have materialized the same user after the
        // pre-read. Do not overwrite that newer row through the race path.
        update: { mirroredAt },
      });
    } else if (incomingIsCurrent) {
      const data: Prisma.UserUpdateInput = { mirroredAt };
      if (this.hasOwn(snapshot, 'email')) {
        data.email = await this.normalizeTransferUniqueUserField(
          tx,
          userId,
          'email',
          snapshot.email,
        );
      }
      if (this.hasOwn(snapshot, 'phone')) {
        data.phone = await this.normalizeTransferUniqueUserField(
          tx,
          userId,
          'phone',
          snapshot.phone,
        );
      }
      if (this.hasOwn(snapshot, 'nickname')) {
        data.nickname = this.normalizeNullable(snapshot.nickname) ?? '';
      }
      // This transfer-specific mirror may confirm/reactivate a current target,
      // but must never deactivate an already transferred owner as a side effect
      // of replaying an outbox event. Deactivation remains the normal mirror's
      // responsibility.
      if (snapshot.isActive === true) {
        data.isActive = true;
      }
      if (sourceUpdatedAt) {
        data.sourceUpdatedAt = sourceUpdatedAt;
      }
      await tx.user.update({ where: { id: userId }, data });
    } else {
      // Preserve the newer source snapshot, but keep the mirror heartbeat.
      await tx.user.update({
        where: { id: userId },
        data: { mirroredAt },
      });
    }

    const target = await tx.user.findUnique({
      where: { id: userId },
      select: { id: true, isActive: true },
    });
    return Boolean(target?.isActive);
  }

  private async normalizeTransferUniqueUserField(
    tx: Prisma.TransactionClient,
    userId: string,
    field: 'email' | 'phone',
    value: string | null | undefined,
  ): Promise<string | null> {
    const normalized = this.normalizeNullable(value);
    if (!normalized) return null;
    const conflict = await tx.user.findFirst({
      where: { [field]: normalized, NOT: { id: userId } },
      select: { id: true },
    });
    if (!conflict) return normalized;
    this.logger.warn(
      `enterprise owner transfer ${field} mirror conflict ignored user=${userId}`,
    );
    return null;
  }

  private async lockOwnerTransferMemberships(
    tx: Prisma.TransactionClient,
    accountId: string,
    tenantId: string,
    previousOwnerUserId: string,
    newOwnerUserId: string,
  ): Promise<void> {
    await tx.$queryRaw`
      SELECT "id"
      FROM "tenant_members"
      WHERE "tenant_id" = ${tenantId}
        AND ("user_id" = ${previousOwnerUserId} OR "user_id" = ${newOwnerUserId})
      ORDER BY "user_id"
      FOR UPDATE
    `;
    await tx.$queryRaw`
      SELECT "id"
      FROM "billing_account_members"
      WHERE "billing_account_id" = ${accountId}
        AND ("user_id" = ${previousOwnerUserId} OR "user_id" = ${newOwnerUserId})
      ORDER BY "user_id"
      FOR UPDATE
    `;
  }

  /**
   * Complete a boundary left pending by a process crash before allowing a
   * later mutation. The current config committed before this transaction
   * obtained the aggregate locks, so this clock is a conservative visibility
   * lower bound for that revision.
   */
  private async confirmPreviousCreditBoundaryUnderLock(
    tx: Prisma.TransactionClient,
    billingAccountId: string,
    config: {
      policyRevision: number;
      policyEffectiveBoundaryAt: Date | null;
      policyBoundaryComplete: boolean;
    } | null,
  ): Promise<void> {
    const revision = config?.policyRevision ?? 0;
    if (revision <= 0) return;
    const event = await tx.billingAccountCreditEvent.findUnique({
      where: {
        billingAccountId_policyRevision: {
          billingAccountId,
          policyRevision: revision,
        },
      },
    });
    if (
      !event
      || !event.temporalSnapshotComplete
      || !(event.policyDecisionAt instanceof Date)
    ) {
      throw this.businessError(
        'enterprise_credit_history_unavailable',
        '企业授信历史边界不完整，已停止后续变更',
        409,
      );
    }
    if (event.policyBoundaryComplete) {
      if (!(event.policyEffectiveBoundaryAt instanceof Date)) {
        throw this.businessError(
          'enterprise_credit_history_unavailable',
          '企业授信历史边界时间缺失，已停止后续变更',
          409,
        );
      }
      if (
        !config?.policyBoundaryComplete
        || config.policyEffectiveBoundaryAt?.getTime()
          !== event.policyEffectiveBoundaryAt.getTime()
      ) {
        await tx.billingAccountCreditConfig.update({
          where: { billingAccountId },
          data: {
            policyEffectiveBoundaryAt: event.policyEffectiveBoundaryAt,
            policyBoundaryComplete: true,
          },
        });
      }
      return;
    }
    const policyEffectiveBoundaryAt = await this.captureCreditPolicyClock(tx, true);
    const updated = await tx.billingAccountCreditEvent.updateMany({
      where: {
        id: event.id,
        billingAccountId,
        policyRevision: revision,
        policyBoundaryComplete: false,
      },
      data: {
        policyEffectiveBoundaryAt,
        policyBoundaryComplete: true,
      },
    });
    if (updated.count !== 1) {
      throw this.businessError(
        'enterprise_credit_history_unavailable',
        '企业授信历史边界确认冲突，已停止后续变更',
        409,
      );
    }
    await tx.billingAccountCreditConfig.update({
      where: { billingAccountId },
      data: {
        policyEffectiveBoundaryAt,
        policyBoundaryComplete: true,
      },
    });
  }

  /**
   * Confirm commit visibility in a separate transaction. Capturing this clock
   * in the mutation transaction would reintroduce the commit gap: a request
   * can occur after the captured time while still observing the old row.
   */
  private async confirmCreditPolicyBoundary(
    billingAccountId: string,
    eventId: string,
    policyRevision: number,
  ): Promise<void> {
    await this.prisma.$transaction(async (tx) => {
      await this.lockExistingEnterpriseAccount(tx, billingAccountId);
      await tx.$queryRaw`
        SELECT "billing_account_id"
        FROM "billing_account_credit_configs"
        WHERE "billing_account_id" = ${billingAccountId}
        FOR UPDATE
      `;
      const [config, event] = await Promise.all([
        tx.billingAccountCreditConfig.findUnique({
          where: { billingAccountId },
          select: {
            policyRevision: true,
            policyEffectiveBoundaryAt: true,
            policyBoundaryComplete: true,
          },
        }),
        tx.billingAccountCreditEvent.findUnique({ where: { id: eventId } }),
      ]);
      if (
        !event
        || event.billingAccountId !== billingAccountId
        || event.policyRevision !== policyRevision
        || !event.temporalSnapshotComplete
        || !(event.policyDecisionAt instanceof Date)
      ) {
        throw this.businessError(
          'enterprise_credit_history_unavailable',
          '企业授信提交边界无法确认，已停止自动结算',
          409,
        );
      }
      if (event.policyBoundaryComplete) {
        if (!(event.policyEffectiveBoundaryAt instanceof Date)) {
          throw this.businessError(
            'enterprise_credit_history_unavailable',
            '企业授信提交边界时间缺失，已停止自动结算',
            409,
          );
        }
        // A later serialized revision may already have confirmed this event
        // before advancing the config. The old caller still succeeds, but must
        // never project its older boundary back over that later revision.
        if (
          config?.policyRevision === policyRevision
          && (!config.policyBoundaryComplete
          || config.policyEffectiveBoundaryAt?.getTime()
            !== event.policyEffectiveBoundaryAt.getTime())
        ) {
          await tx.billingAccountCreditConfig.update({
            where: { billingAccountId },
            data: {
              policyEffectiveBoundaryAt: event.policyEffectiveBoundaryAt,
              policyBoundaryComplete: true,
            },
          });
        }
        return;
      }
      if (!config || config.policyRevision !== policyRevision) {
        throw this.businessError(
          'enterprise_credit_history_unavailable',
          '企业授信提交边界已被未确认的后续修订覆盖',
          409,
        );
      }
      const policyEffectiveBoundaryAt = await this.captureCreditPolicyClock(tx, true);
      const updated = await tx.billingAccountCreditEvent.updateMany({
        where: {
          id: eventId,
          billingAccountId,
          policyRevision,
          policyBoundaryComplete: false,
        },
        data: {
          policyEffectiveBoundaryAt,
          policyBoundaryComplete: true,
        },
      });
      if (updated.count !== 1) {
        throw this.businessError(
          'enterprise_credit_history_unavailable',
          '企业授信提交边界确认冲突，已停止自动结算',
          409,
        );
      }
      await tx.billingAccountCreditConfig.update({
        where: { billingAccountId },
        data: {
          policyEffectiveBoundaryAt,
          policyBoundaryComplete: true,
        },
      });
    });
  }

  private async captureCreditPolicyClock(
    tx: Prisma.TransactionClient,
    visibilityBoundary = false,
  ): Promise<Date> {
    // Stored/request timestamps have millisecond precision. decisionAt is
    // floored so the entire decision millisecond is uncertain; the confirmed
    // boundary is moved to the next millisecond so no request timestamp from
    // the confirmation millisecond can be mistaken for post-commit visibility.
    const rows = visibilityBoundary
      ? await tx.$queryRaw<Array<{ policyClock: Date }>>`
          SELECT (
            date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')
            + INTERVAL '1 millisecond'
          )::TIMESTAMP(3) AS "policyClock"
        `
      : await tx.$queryRaw<Array<{ policyClock: Date }>>`
          SELECT date_trunc(
            'milliseconds',
            clock_timestamp() AT TIME ZONE 'UTC'
          )::TIMESTAMP(3) AS "policyClock"
        `;
    const policyClock = rows[0]?.policyClock;
    if (!(policyClock instanceof Date) || Number.isNaN(policyClock.getTime())) {
      throw this.businessError(
        'enterprise_credit_clock_unavailable',
        '企业授信数据库时钟不可用',
        503,
      );
    }
    return policyClock;
  }

  /**
   * Lock an already published enterprise aggregate in the same order used by
   * financial mutations: wallet, then billing account. Lifecycle mutations
   * must never create a missing wallet on demand; that state means the account
   * aggregate is incomplete and requires explicit repair.
   */
  private async lockExistingEnterpriseAccount(
    tx: Prisma.TransactionClient,
    id: string,
  ): Promise<LockedEnterpriseAccountContext> {
    const walletRows = await tx.$queryRaw<Array<{ balanceUsd: Prisma.Decimal }>>`
      SELECT "balance_usd" AS "balanceUsd"
      FROM "account_wallets"
      WHERE "billing_account_id" = ${id}
      FOR UPDATE
    `;
    if (walletRows.length !== 1) {
      throw this.businessError(
        'billing_account_not_provisioned',
        '账务账号尚未完成开户，请稍后重试',
        409,
      );
    }

    const accountRows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "billing_accounts"
      WHERE "id" = ${id}
      FOR UPDATE
    `;
    if (accountRows.length !== 1) {
      throw this.businessError('enterprise_account_not_found', '企业账户不存在', 404);
    }
    const account = await tx.billingAccount.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, type: true, ownerUserId: true, status: true, provisioningQuarantinedAt: true },
    });
    if (!account || account.type !== ENTERPRISE_ACCOUNT_TYPE) {
      throw this.businessError('enterprise_account_not_found', '企业账户不存在', 404);
    }
    return {
      account,
      walletBalanceUsd: usd(walletRows[0].balanceUsd),
    };
  }

  private async lockTenantForAccountBinding(
    tx: Prisma.TransactionClient,
    tenantId: string,
  ): Promise<{ id: string; billingAccountId: string | null; ownerUserId: string }> {
    const tenantRows = await tx.$queryRaw<Array<{ id: string }>>`
      SELECT "id"
      FROM "tenants"
      WHERE "id" = ${tenantId}
      FOR UPDATE
    `;
    if (tenantRows.length !== 1) {
      throw new BadRequestException('工作区不存在');
    }
    const tenant = await tx.tenant.findUnique({
      where: { id: tenantId },
      select: { id: true, billingAccountId: true, ownerUserId: true },
    });
    if (!tenant) throw new BadRequestException('工作区不存在');
    return tenant;
  }

  private assertTenantOwnerMatchesAccount(
    account: LockedEnterpriseAccount,
    tenant: { ownerUserId: string },
  ): void {
    if (!account.ownerUserId) {
      throw this.businessError(
        'enterprise_account_owner_required',
        '企业账户缺少 owner 用户，无法挂载工作区',
        409,
      );
    }
    if (tenant.ownerUserId !== account.ownerUserId) {
      throw this.businessError(
        'enterprise_tenant_owner_mismatch',
        '工作区归属人与企业账户 owner 不一致',
        409,
      );
    }
  }

  private async requireEnterpriseAccount(id: string) {
    const account = await this.prisma.billingAccount.findFirst({
      where: { id, deletedAt: null },
      select: { id: true, type: true, ownerUserId: true, status: true, provisioningQuarantinedAt: true },
    });
    if (!account || account.type !== ENTERPRISE_ACCOUNT_TYPE) {
      throw this.businessError('enterprise_account_not_found', '企业账户不存在', 404);
    }
    return account;
  }

  /**
   * 与财务对账「余额流水明细」同一口径：usdToCents(balanceAfterUsd)，
   * 每账户 ORDER BY created_at DESC LIMIT 1；不做月份截断。
   * 一页一条 LATERAL，禁止 DISTINCT ON / 按户 Promise.all / ORDER BY id DESC。
   */
  private async latestLedgerBalanceAfterCents(
    billingAccountIds: string[],
  ): Promise<Map<string, number>> {
    const result = new Map<string, number>();
    if (billingAccountIds.length === 0) return result;
    const rows = await this.prisma.$queryRaw<Array<{
      billing_account_id: string | null;
      balance_after_usd: Prisma.Decimal | null;
    }>>(Prisma.sql`
      -- latest-ledger-lateral
      SELECT x."billing_account_id",
             x."balance_after_usd"
      FROM unnest(ARRAY[${Prisma.join(billingAccountIds)}]::text[]) AS a(id)
      LEFT JOIN LATERAL (
        SELECT bt."billing_account_id",
               bt."balance_after_usd"
        FROM "balance_transactions" bt
        WHERE bt."billing_account_id" = a.id
          AND bt."ledger_sequence" > 0
        ORDER BY bt."created_at" DESC
        LIMIT 1
      ) x ON TRUE
    `);
    for (const row of rows) {
      if (row.billing_account_id == null || row.balance_after_usd == null) {
        continue;
      }
      result.set(row.billing_account_id, usdToCents(row.balance_after_usd));
    }
    return result;
  }

  private fundingSnapshots() {
    return this.prisma as unknown as {
      enterpriseFundingSnapshot: {
        findMany: (args: {
          where: { billingAccountId: { in: string[] } };
        }) => Promise<Array<{
          billingAccountId: string;
          approvedReceivableUsd: Prisma.Decimal;
          unapprovedDebtUsd: Prisma.Decimal;
          classificationComplete: boolean;
        }>>;
      };
    };
  }

  /**
   * 把授信分摊未结清写成一户一行快照。GET 只读这行。
   * 一条 INSERT SELECT ON CONFLICT：GROUP BY 账户，左连企业户把没分摊的写成 0。
   * 公式与原先逐户 SUM 相同（ADR-0017），不按户 Promise.all。
   */
  async refreshFundingSnapshots(accountIds?: string[]): Promise<number> {
    const ids = accountIds
      ? [...new Set(accountIds.filter(Boolean))]
      : null;
    if (ids && ids.length === 0) {
      return 0;
    }
    const accountFilter = ids
      ? Prisma.sql`AND a.id = ANY(${ids})`
      : Prisma.sql``;
    const rows = await this.prisma.$queryRaw<Array<{ billing_account_id: string }>>`
      -- funding-snapshot-upsert
      INSERT INTO "enterprise_funding_snapshots" (
        "billing_account_id",
        "approved_receivable_usd",
        "unapproved_debt_usd",
        "classification_complete",
        "updated_at"
      )
      SELECT
        a.id,
        COALESCE(agg.approved_receivable_usd, 0),
        COALESCE(agg.unapproved_debt_usd, 0),
        (inc.billing_account_id IS NULL),
        NOW()
      FROM "billing_accounts" a
      LEFT JOIN (
        SELECT
          "billing_account_id",
          COALESCE(SUM(CASE
            WHEN "approved_credit_usd" > 0 THEN "approved_credit_usd" - "settled_usd"
            ELSE 0
          END), 0) AS approved_receivable_usd,
          COALESCE(SUM(CASE
            WHEN "unapproved_debt_usd" > 0 THEN "unapproved_debt_usd" - "settled_usd"
            ELSE 0
          END), 0) AS unapproved_debt_usd
        FROM "balance_consumption_allocations"
        WHERE "source" = 'ENTERPRISE_CREDIT'
          AND "funding_classification_complete"
          AND ("approved_credit_usd" > 0 OR "unapproved_debt_usd" > 0)
        GROUP BY "billing_account_id"
      ) agg ON agg.billing_account_id = a.id
      LEFT JOIN (
        SELECT DISTINCT "billing_account_id"
        FROM "balance_consumption_allocations"
        WHERE "source" = 'ENTERPRISE_CREDIT'
          AND "funding_classification_complete" IS NOT TRUE
          AND "settled_at" IS NULL
      ) inc ON inc.billing_account_id = a.id
      WHERE a.type = ${ENTERPRISE_ACCOUNT_TYPE}
        AND a.deleted_at IS NULL
        ${accountFilter}
      ON CONFLICT ("billing_account_id") DO UPDATE SET
        "approved_receivable_usd" = EXCLUDED."approved_receivable_usd",
        "unapproved_debt_usd" = EXCLUDED."unapproved_debt_usd",
        "classification_complete" = EXCLUDED."classification_complete",
        "updated_at" = EXCLUDED."updated_at"
      RETURNING "billing_account_id"
    `;
    return rows.length;
  }

  private async loadFundingSnapshots(
    billingAccountIds: string[],
  ): Promise<Map<string, EnterpriseFundingOutstanding>> {
    const result = new Map<string, EnterpriseFundingOutstanding>();
    if (billingAccountIds.length === 0) return result;
    const rows = await this.fundingSnapshots().enterpriseFundingSnapshot.findMany({
      where: { billingAccountId: { in: billingAccountIds } },
    });
    for (const billingAccountId of billingAccountIds) {
      result.set(billingAccountId, {
        approvedReceivableUsd: new Prisma.Decimal(0),
        unapprovedDebtUsd: new Prisma.Decimal(0),
        classificationComplete: false,
      });
    }
    for (const row of rows) {
      result.set(row.billingAccountId, {
        approvedReceivableUsd: usd(row.approvedReceivableUsd),
        unapprovedDebtUsd: usd(row.unapprovedDebtUsd),
        classificationComplete: row.classificationComplete,
      });
    }
    return result;
  }

  private toView(account: {
    id: string;
    type: string;
    name: string;
    ownerUserId: string | null;
    status: string;
    currency: string;
    enterpriseName: string | null;
    uscc: string | null;
    verificationId: string | null;
    verifiedAt: Date | null;
    wallet?: { balanceUsd: Prisma.Decimal } | null;
    creditConfig?: {
      limitUsd: Prisma.Decimal;
      status: string;
      termsDays: number | null;
      effectiveAt: Date | null;
      expiresAt: Date | null;
      policyRevision: number;
      policyEffectiveBoundaryAt: Date | null;
      policyBoundaryComplete: boolean;
      updatedBy: string | null;
      note: string | null;
      createdAt: Date;
      updatedAt: Date;
    } | null;
    createdAt: Date;
    updatedAt: Date;
  }, outstanding?: EnterpriseFundingOutstanding): EnterpriseAccountView {
    const balanceUsd = usd(account.wallet?.balanceUsd ?? 0);
    return {
      id: account.id,
      type: account.type,
      name: account.name,
      ownerUserId: account.ownerUserId,
      status: account.status,
      currency: account.currency,
      enterpriseName: account.enterpriseName,
      uscc: account.uscc,
      verificationId: account.verificationId,
      verifiedAt: account.verifiedAt,
      balanceUsd: usdNumber(balanceUsd),
      balanceAmount: usdString(balanceUsd),
      credit: this.toCreditView(
        account.id,
        account.wallet ?? null,
        account.creditConfig ?? null,
        outstanding,
      ),
      createdAt: account.createdAt,
      updatedAt: account.updatedAt,
    };
  }

  private toCreditView(
    billingAccountId: string,
    wallet: { balanceUsd: Prisma.Decimal } | null | undefined,
    config: {
      limitUsd: Prisma.Decimal;
      status: string;
      termsDays: number | null;
      effectiveAt: Date | null;
      expiresAt: Date | null;
      policyRevision: number;
      policyEffectiveBoundaryAt: Date | null;
      policyBoundaryComplete: boolean;
      updatedBy: string | null;
      note: string | null;
      createdAt: Date;
      updatedAt: Date;
    } | null | undefined,
    outstanding: EnterpriseFundingOutstanding = {
      approvedReceivableUsd: new Prisma.Decimal(0),
      unapprovedDebtUsd: new Prisma.Decimal(0),
      classificationComplete: true,
    },
  ): EnterpriseAccountCreditView {
    const accountBalanceUsd = usd(wallet?.balanceUsd ?? 0);
    const configuredLimitUsd = usd(config?.limitUsd ?? 0);
    const activeLimitUsd = this.activeCreditLimitUsd(config);
    // Approved receivables remain authoritative even if an administrator later
    // suspends or lowers the current line. Never relabel the wallet's entire
    // negative balance as approved credit; unapproved debt is reported below.
    const usedUsd = outstanding.approvedReceivableUsd;
    const remainingUsd = this.maxUsd(new Prisma.Decimal(0), activeLimitUsd.minus(usedUsd));
    // 账户可用余额 = max(0, 余额) + 剩余信用。与用户侧同一公式；负余额不冲减剩余信用。
    const accountAvailableBalanceUsd = accountAvailableFromWalletAndRemainingUsd(
      accountBalanceUsd,
      remainingUsd,
    );
    return {
      billingAccountId,
      status: config?.status ?? CREDIT_STATUS_DISABLED,
      limitCents: usdToCents(configuredLimitUsd),
      limitUsd: usdNumber(configuredLimitUsd),
      limitAmount: usdString(configuredLimitUsd),
      activeLimitCents: usdToCents(activeLimitUsd),
      activeLimitUsd: usdNumber(activeLimitUsd),
      activeLimitAmount: usdString(activeLimitUsd),
      usedCents: usdToCents(usedUsd),
      usedUsd: usdNumber(usedUsd),
      usedAmount: usdString(usedUsd),
      remainingCents: usdToCents(remainingUsd),
      remainingUsd: usdNumber(remainingUsd),
      remainingAmount: usdString(remainingUsd),
      accountBalanceCents: usdToCents(accountBalanceUsd),
      accountBalanceUsd: usdNumber(accountBalanceUsd),
      accountBalanceAmount: usdString(accountBalanceUsd),
      accountAvailableBalanceCents: usdToCents(accountAvailableBalanceUsd),
      accountAvailableBalanceUsd: usdNumber(accountAvailableBalanceUsd),
      accountAvailableBalanceAmount: usdString(accountAvailableBalanceUsd),
      approvedReceivableOutstandingCents: usdToCents(
        outstanding.approvedReceivableUsd,
      ),
      approvedReceivableOutstandingUsd: usdNumber(
        outstanding.approvedReceivableUsd,
      ),
      approvedReceivableOutstandingAmount: usdString(
        outstanding.approvedReceivableUsd,
      ),
      unapprovedDebtOutstandingCents: usdToCents(outstanding.unapprovedDebtUsd),
      unapprovedDebtOutstandingUsd: usdNumber(outstanding.unapprovedDebtUsd),
      unapprovedDebtOutstandingAmount: usdString(outstanding.unapprovedDebtUsd),
      fundingClassificationComplete: outstanding.classificationComplete,
      policyRevision: config?.policyRevision ?? 0,
      policyEffectiveBoundaryAt: config?.policyEffectiveBoundaryAt ?? null,
      policyBoundaryComplete: config?.policyBoundaryComplete ?? false,
      termsDays: config?.termsDays ?? null,
      effectiveAt: config?.effectiveAt ?? null,
      expiresAt: config?.expiresAt ?? null,
      updatedBy: config?.updatedBy ?? null,
      note: config?.note ?? null,
      createdAt: config?.createdAt ?? null,
      updatedAt: config?.updatedAt ?? null,
    };
  }

  private toCreditEventView(row: {
    id: string;
    billingAccountId: string;
    oldLimitUsd: Prisma.Decimal | null;
    newLimitUsd: Prisma.Decimal;
    oldStatus: string | null;
    newStatus: string;
    oldTermsDays: number | null;
    newTermsDays: number | null;
    oldEffectiveAt: Date | null;
    newEffectiveAt: Date | null;
    oldExpiresAt: Date | null;
    newExpiresAt: Date | null;
    policyRevision: number | null;
    policyDecisionAt: Date | null;
    policyEffectiveBoundaryAt: Date | null;
    policyBoundaryComplete: boolean;
    policyFanoutEnqueuedAt: Date | null;
    actorId: string | null;
    reason: string | null;
    note: string | null;
    idempotencyKey: string | null;
    createdAt: Date;
  }): EnterpriseAccountCreditEventView {
    return {
      id: row.id,
      billingAccountId: row.billingAccountId,
      oldLimitCents: row.oldLimitUsd === null ? null : usdToCents(row.oldLimitUsd),
      newLimitCents: usdToCents(row.newLimitUsd),
      oldStatus: row.oldStatus,
      newStatus: row.newStatus,
      oldTermsDays: row.oldTermsDays,
      newTermsDays: row.newTermsDays,
      oldEffectiveAt: row.oldEffectiveAt,
      newEffectiveAt: row.newEffectiveAt,
      oldExpiresAt: row.oldExpiresAt,
      newExpiresAt: row.newExpiresAt,
      policyRevision: row.policyRevision,
      policyDecisionAt: row.policyDecisionAt,
      policyEffectiveBoundaryAt: row.policyEffectiveBoundaryAt,
      policyBoundaryComplete: row.policyBoundaryComplete,
      policyFanoutEnqueuedAt: row.policyFanoutEnqueuedAt,
      actorId: row.actorId,
      reason: row.reason,
      note: row.note,
      idempotencyKey: row.idempotencyKey,
      createdAt: row.createdAt,
    };
  }

  private activeCreditLimitUsd(
    config: {
      limitUsd: Prisma.Decimal;
      status: string;
      termsDays?: number | null;
      effectiveAt?: Date | null;
      expiresAt?: Date | null;
    } | null | undefined,
    now = new Date(),
  ): Prisma.Decimal {
    if (!config || config.status !== CREDIT_STATUS_ACTIVE) return new Prisma.Decimal(0);
    if (config.termsDays === null || config.termsDays === undefined || config.termsDays <= 0) {
      return new Prisma.Decimal(0);
    }
    if (config.effectiveAt && config.effectiveAt.getTime() > now.getTime()) {
      return new Prisma.Decimal(0);
    }
    if (config.expiresAt && config.expiresAt.getTime() <= now.getTime()) {
      return new Prisma.Decimal(0);
    }
    const limitUsd = usd(config.limitUsd);
    return limitUsd.gt(0) ? limitUsd : new Prisma.Decimal(0);
  }

  private maxUsd(left: Prisma.Decimal, right: Prisma.Decimal): Prisma.Decimal {
    return left.gte(right) ? left : right;
  }

  private isUsccConflict(err: unknown): boolean {
    if (!hasPrismaErrorCode(err, 'P2002')) return false;
    // 只把 uscc 的 partial unique 冲突映射为业务错误；其它唯一冲突原样抛出。
    const target = this.uniqueTarget(err);
    if (target === null) return true; // 无法判定时保守当作 uscc 冲突（本服务唯一 create 冲突来源）。
    return target.includes(USCC_ACTIVE_UNIQUE_INDEX) || target.includes('uscc');
  }

  private uniqueTarget(err: unknown): string | null {
    const meta = (err as { meta?: { target?: unknown } })?.meta;
    const target = meta?.target;
    if (typeof target === 'string') return target;
    if (Array.isArray(target)) return target.join(',');
    return null;
  }

  private businessError(code: string, message: string, status: number): HttpException {
    // 复用仓库 HttpExceptionFilter 的自定义 code 约定（见 §10.3）。
    return new HttpException({ code, message }, status);
  }

  private creditMutationFingerprint(input: UpdateEnterpriseCreditInput): string {
    const omitted = { state: 'omitted' as const };
    const value = <T>(fieldValue: T) => ({ state: 'value' as const, value: fieldValue });
    const normalized = {
      limitCents: input.limitCents === undefined
        ? omitted
        : value(this.normalizeNonNegativeCents(input.limitCents, 'limitCents')),
      status: input.status === undefined
        ? omitted
        : value(this.normalizeCreditStatus(input.status)),
      termsDays: input.termsDays === undefined
        ? omitted
        : value(this.normalizeNullableInt(input.termsDays, 'termsDays')),
      effectiveAt: input.effectiveAt === undefined
        ? omitted
        : value(this.normalizeDate(input.effectiveAt)?.toISOString() ?? null),
      expiresAt: input.expiresAt === undefined
        ? omitted
        : value(this.normalizeDate(input.expiresAt)?.toISOString() ?? null),
      updatedBy: input.updatedBy === undefined
        ? omitted
        : value(this.normalizeNullable(input.updatedBy)),
      reason: input.reason === undefined
        ? omitted
        : value(this.normalizeNullable(input.reason)),
      note: input.note === undefined
        ? omitted
        : value(this.normalizeNullable(input.note)),
    };
    return createHash('sha256').update(JSON.stringify(normalized)).digest('hex');
  }

  private assertCreditIdempotencyMatch(
    event: {
      billingAccountId: string;
      requestFingerprint: string | null;
    },
    billingAccountId: string,
    requestFingerprint: string,
  ): void {
    if (
      event.billingAccountId !== billingAccountId
      || event.requestFingerprint !== requestFingerprint
    ) {
      throw this.businessError(
        'enterprise_credit_idempotency_conflict',
        '幂等键对应的企业账户或授信参数不一致',
        409,
      );
    }
  }

  private requireString(value: unknown, field: string): string {
    const normalized = this.normalizeNullable(value);
    if (!normalized) throw new BadRequestException(`${field} 是必填字段`);
    return normalized;
  }

  private normalizeNonNegativeCents(value: unknown, field: string): number {
    if (value == null) return 0;
    const amount = Number(value);
    if (!Number.isInteger(amount) || amount < 0) {
      throw new BadRequestException(`${field} 必须是非负整数分值`);
    }
    return amount;
  }

  private normalizeNullableInt(value: unknown, field: string): number | null {
    if (value === null || value === undefined || value === '') return null;
    const amount = Number(value);
    if (!Number.isInteger(amount) || amount < 0) {
      throw new BadRequestException(`${field} 必须是非负整数`);
    }
    return amount;
  }

  private normalizeCreditStatus(value: unknown): string {
    const status = this.normalizeNullable(value)?.toUpperCase();
    if (!status || !CREDIT_STATUSES.has(status)) {
      throw new BadRequestException('status 必须是 ACTIVE / DISABLED / SUSPENDED');
    }
    return status;
  }

  private normalizeNullable(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    const trimmed = String(value).trim();
    return trimmed || null;
  }

  private hasOwn<T extends object>(value: T, key: keyof T): boolean {
    return Object.prototype.hasOwnProperty.call(value, key);
  }

  private normalizeDate(value: string | Date | null | undefined): Date | null {
    if (value === undefined || value === null) return null;
    const date = value instanceof Date ? value : new Date(value);
    return Number.isNaN(date.getTime()) ? null : date;
  }
}

function emptyCurrentMonthSummary(billingAccountId: string, now: Date = new Date()) {
  return {
    billingAccountId,
    yearMonth: yearMonthInBeijing(now),
    paidCents: 0,
    pendingCents: 0,
    adjustedCents: 0,
    issuedVoucherCents: 0,
    consumeCents: 0,
    voucherCents: 0,
    chargeCents: 0,
    tokenTotal: 0,
    requestCount: 0,
    dueProjected: false,
  };
}
