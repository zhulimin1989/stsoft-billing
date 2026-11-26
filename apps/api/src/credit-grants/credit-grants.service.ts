/**
 * CreditGrantRule CRUD + preview/manual-trigger orchestration.
 *
 * Per spec §7 of admin-v2-backend-p1. The executor side (per-rule fan-out
 * over users + transactional writes) lives in CreditGrantExecutor; this
 * service is the admin-facing surface (validation, queries, references).
 */
import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
} from '@nestjs/common';
import {
  CreditGrantRule,
  GrantExpirePolicy,
  GrantNotifyType,
  GrantRewardType,
  GrantTriggerType,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

const NAME_MAX = 128;
const PER_USER_LIMIT_MAX = 100;
const REWARD_AMOUNT_MAX = 10_000_000;
const EXPIRE_DAYS_MIN = 1;
const EXPIRE_DAYS_MAX = 365;
const NOTIFY_TEMPLATE_MAX = 256;

const TRIGGER_TYPES: ReadonlySet<GrantTriggerType> = new Set([
  'DAILY_CRON',
  'FIRST_LOGIN',
  'DAILY_CHECKIN',
  'TASK_COMPLETE',
  'WEEKLY_CRON',
]);
const REWARD_TYPES: ReadonlySet<GrantRewardType> = new Set([
  'CREDIT',
  'BALANCE',
  'BOOSTER_PACK',
]);
const EXPIRE_POLICIES: ReadonlySet<GrantExpirePolicy> = new Set([
  'PERMANENT',
  'SAME_DAY_END',
  'N_DAYS',
  'NEXT_RESET',
]);
const NOTIFY_TYPES: ReadonlySet<GrantNotifyType> = new Set([
  'INAPP',
  'EMAIL',
  'SMS',
  'NONE',
]);

const CRON_TRIGGERS: ReadonlySet<GrantTriggerType> = new Set([
  'DAILY_CRON',
  'WEEKLY_CRON',
]);

export interface CreateGrantRuleInput {
  name: string;
  triggerType: GrantTriggerType;
  cronExpr?: string | null;
  segmentId?: string | null;
  rewardType: GrantRewardType;
  rewardAmount: number;
  productId?: string | null;
  expirePolicy: GrantExpirePolicy;
  expireDays?: number | null;
  perUserLimit?: number;
  globalDailyCap?: number | null;
  isActive?: boolean;
  startAt?: string | Date | null;
  endAt?: string | Date | null;
  notifyType?: GrantNotifyType | null;
  notifyTemplate?: string | null;
}

export type UpdateGrantRuleInput = Partial<CreateGrantRuleInput>;

export interface ListFilters {
  page: number;
  pageSize: number;
  search?: string;
  triggerType?: GrantTriggerType;
  isActive?: boolean;
  segmentId?: string;
}

export interface GrantRuleListResult {
  items: CreditGrantRule[];
  total: number;
  page: number;
  pageSize: number;
  totalPages: number;
}

@Injectable()
export class CreditGrantsService {
  private readonly logger = new Logger(CreditGrantsService.name);

  constructor(private readonly prisma: PrismaService) {}

  // ------------------------------ CRUD -------------------------------

  async list(filters: ListFilters): Promise<GrantRuleListResult> {
    const { page, pageSize, search, triggerType, isActive, segmentId } =
      filters;
    // P2-D 隐藏 referral hidden GrantRule:ReferralsService 为每个 program 创建
    // 2 条以 `__referral:` 前缀命名的 GrantRule(triggerType=TASK_COMPLETE)。
    // 这些规则只由 ReferralsService.triggerRewards 直接调用,不应该在 admin
    // /grant-rules UI 列出,以免运营误改/误停。这里在 list 端统一过滤。
    const where: Prisma.CreditGrantRuleWhereInput = {
      deletedAt: null,
      name: { not: { startsWith: '__referral:' } },
    };
    if (search) {
      // 同时保留 search 的 contains 与 NOT startsWith 隐藏过滤
      where.name = {
        contains: search,
        mode: 'insensitive',
        not: { startsWith: '__referral:' },
      };
    }
    if (triggerType) where.triggerType = triggerType;
    if (typeof isActive === 'boolean') where.isActive = isActive;
    if (segmentId) where.segmentId = segmentId;

    const [items, total] = await Promise.all([
      this.prisma.creditGrantRule.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.creditGrantRule.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async getById(id: string): Promise<CreditGrantRule> {
    const row = await this.prisma.creditGrantRule.findFirst({
      where: { id, deletedAt: null },
    });
    if (!row) throw new NotFoundException('奖励规则不存在');
    return row;
  }

  async create(input: CreateGrantRuleInput): Promise<CreditGrantRule> {
    const data = await this.normalizeCreate(input);
    return this.prisma.creditGrantRule.create({ data });
  }

  async update(
    id: string,
    input: UpdateGrantRuleInput,
  ): Promise<CreditGrantRule> {
    const existing = await this.getById(id);

    // Build the post-update merged view first so we can validate cross-field
    // invariants (e.g. cronExpr matches triggerType) regardless of which
    // subset of fields the caller passed.
    const merged = {
      name: input.name ?? existing.name,
      triggerType: input.triggerType ?? existing.triggerType,
      cronExpr: input.cronExpr === undefined ? existing.cronExpr : input.cronExpr,
      segmentId:
        input.segmentId === undefined ? existing.segmentId : input.segmentId,
      rewardType: input.rewardType ?? existing.rewardType,
      rewardAmount: input.rewardAmount ?? existing.rewardAmount,
      productId:
        input.productId === undefined ? existing.productId : input.productId,
      expirePolicy: input.expirePolicy ?? existing.expirePolicy,
      expireDays:
        input.expireDays === undefined ? existing.expireDays : input.expireDays,
      perUserLimit: input.perUserLimit ?? existing.perUserLimit,
      globalDailyCap:
        input.globalDailyCap === undefined
          ? existing.globalDailyCap
          : input.globalDailyCap,
      startAt: input.startAt === undefined ? existing.startAt : this.normalizeDate(input.startAt),
      endAt: input.endAt === undefined ? existing.endAt : this.normalizeDate(input.endAt),
      notifyType: input.notifyType === undefined ? existing.notifyType : input.notifyType,
      notifyTemplate:
        input.notifyTemplate === undefined
          ? existing.notifyTemplate
          : input.notifyTemplate,
    };

    this.assertCommon(merged);
    if (merged.segmentId) await this.assertSegmentExists(merged.segmentId);
    if (merged.productId) await this.assertProductExists(merged.productId);

    const data: Prisma.CreditGrantRuleUpdateInput = {};
    if (input.name !== undefined) data.name = merged.name;
    if (input.triggerType !== undefined) data.triggerType = merged.triggerType;
    if (input.cronExpr !== undefined) data.cronExpr = merged.cronExpr;
    if (input.segmentId !== undefined) {
      data.segment = merged.segmentId
        ? { connect: { id: merged.segmentId } }
        : { disconnect: true };
    }
    if (input.rewardType !== undefined) data.rewardType = merged.rewardType;
    if (input.rewardAmount !== undefined)
      data.rewardAmount = merged.rewardAmount;
    if (input.productId !== undefined) data.productId = merged.productId;
    if (input.expirePolicy !== undefined)
      data.expirePolicy = merged.expirePolicy;
    if (input.expireDays !== undefined) data.expireDays = merged.expireDays;
    if (input.perUserLimit !== undefined)
      data.perUserLimit = merged.perUserLimit;
    if (input.globalDailyCap !== undefined)
      data.globalDailyCap = merged.globalDailyCap;
    if (input.isActive !== undefined) data.isActive = input.isActive;
    if (input.startAt !== undefined) data.startAt = merged.startAt;
    if (input.endAt !== undefined) data.endAt = merged.endAt;
    if (input.notifyType !== undefined) data.notifyType = merged.notifyType;
    if (input.notifyTemplate !== undefined)
      data.notifyTemplate = merged.notifyTemplate;

    return this.prisma.creditGrantRule.update({
      where: { id: existing.id },
      data,
    });
  }

  async softDelete(id: string): Promise<void> {
    const existing = await this.getById(id);
    await this.prisma.creditGrantRule.update({
      where: { id: existing.id },
      data: { deletedAt: new Date(), isActive: false },
    });
  }

  // ------------------------------ preview ----------------------------

  /**
   * Preview matched user count + estimated total reward for `executeRule`.
   * Pure read — does NOT write any transactions or redemptions. Useful for
   * the admin UI to surface "expected impact" before saving.
   */
  async preview(id: string): Promise<{
    matchedCount: number;
    estimatedTotalAmount: number;
    sampleUserIds: string[];
  }> {
    const rule = await this.getById(id);

    const userIds = await this.resolveTargetUserIds(rule.segmentId);
    const cap = rule.globalDailyCap ?? userIds.length;
    const effectiveCount = Math.min(userIds.length, cap);
    return {
      matchedCount: effectiveCount,
      estimatedTotalAmount: effectiveCount * rule.rewardAmount,
      sampleUserIds: userIds.slice(0, 20),
    };
  }

  // ------------------------------ redemptions ------------------------

  async listRedemptions(
    ruleId: string,
    page: number,
    pageSize: number,
  ): Promise<{
    items: Array<{
      id: string;
      ruleId: string;
      userId: string;
      amount: number;
      expiresAt: Date | null;
      isExpired: boolean;
      isUsedUp: boolean;
      txId: string | null;
      createdAt: Date;
      user?: { email: string | null; nickname: string | null } | null;
    }>;
    total: number;
    page: number;
    pageSize: number;
    totalPages: number;
  }> {
    await this.getById(ruleId);
    const [rows, total] = await Promise.all([
      this.prisma.grantRedemption.findMany({
        where: { ruleId },
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
        include: {
          user: { select: { email: true, nickname: true } },
        },
      }),
      this.prisma.grantRedemption.count({ where: { ruleId } }),
    ]);
    return {
      items: rows.map((r) => ({
        id: r.id,
        ruleId: r.ruleId,
        userId: r.userId,
        amount: r.amount,
        expiresAt: r.expiresAt,
        isExpired: r.isExpired,
        isUsedUp: r.isUsedUp,
        txId: r.txId,
        createdAt: r.createdAt,
        user: r.user ?? null,
      })),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  // ------------------------------ helpers ----------------------------

  /** Resolve target userIds for a rule's segment (or all active users). */
  async resolveTargetUserIds(segmentId: string | null): Promise<string[]> {
    if (segmentId) {
      const segment = await this.prisma.userSegment.findFirst({
        where: { id: segmentId, deletedAt: null },
        select: { id: true, ruleType: true, ruleExpr: true },
      });
      if (!segment) return [];

      if (segment.ruleType === 'STATIC') {
        const members = await this.prisma.userSegmentMember.findMany({
          where: { segmentId: segment.id },
          select: { userId: true },
        });
        return members.map((m) => m.userId);
      }
      // DYNAMIC: we do NOT pull in UserSegmentRuleEngine here to avoid a
      // cross-module dependency. PR5 routes DYNAMIC resolution through the
      // UserSegment.memberCount table when the engine isn't available; in
      // production the executor will be wired with the engine at module
      // composition time. For now: fall back to the materialized member
      // table (DYNAMIC segments don't materialize members → empty list).
      // The executor should be invoked with concrete (resolved) userIds when
      // possible. See `setUserResolver` below.
      if (this.dynamicResolver) {
        return this.dynamicResolver(segment.ruleExpr);
      }
      this.logger.warn(
        `DYNAMIC segment ${segmentId} but no resolver wired — returning empty userIds`,
      );
      return [];
    }
    // No segmentId → all active, non-deleted users.
    const users = await this.prisma.user.findMany({
      where: { isActive: true, deletedAt: null },
      select: { id: true },
    });
    return users.map((u) => u.id);
  }

  private dynamicResolver:
    | ((ruleExpr: string | null) => Promise<string[]>)
    | undefined;

  /**
   * Optional injection point for the UserSegmentRuleEngine. If wired, the
   * executor will resolve DYNAMIC segments through it; otherwise it falls
   * back to the materialized member table. Called at module init time.
   */
  setDynamicResolver(
    fn: (ruleExpr: string | null) => Promise<string[]>,
  ): void {
    this.dynamicResolver = fn;
  }

  /** Compute expiresAt timestamp for a single redemption. */
  computeExpiresAt(
    policy: GrantExpirePolicy,
    expireDays: number | null,
    now: Date = new Date(),
  ): Date | null {
    switch (policy) {
      case 'PERMANENT':
        return null;
      case 'SAME_DAY_END': {
        // End of UTC day. Server timezone is UTC in production; document
        // this in the admin UI tooltip so operators know "当天" means UTC.
        const end = new Date(now);
        end.setUTCHours(23, 59, 59, 999);
        return end;
      }
      case 'N_DAYS': {
        if (!expireDays || expireDays <= 0) return null;
        const d = new Date(now);
        d.setUTCDate(d.getUTCDate() + expireDays);
        return d;
      }
      case 'NEXT_RESET': {
        // First day of next month, 00:00 UTC. This matches the existing
        // monthly billing reset cycle (resetQuota is invoked at month start).
        const d = new Date(
          Date.UTC(now.getUTCFullYear(), now.getUTCMonth() + 1, 1, 0, 0, 0, 0),
        );
        return d;
      }
    }
  }

  // ------------------------------ validation -------------------------

  private async normalizeCreate(
    input: CreateGrantRuleInput,
  ): Promise<Prisma.CreditGrantRuleCreateInput> {
    const merged = {
      name: input.name,
      triggerType: input.triggerType,
      cronExpr: input.cronExpr ?? null,
      segmentId: input.segmentId ?? null,
      rewardType: input.rewardType,
      rewardAmount: input.rewardAmount,
      productId: input.productId ?? null,
      expirePolicy: input.expirePolicy,
      expireDays: input.expireDays ?? null,
      perUserLimit: input.perUserLimit ?? 1,
      globalDailyCap: input.globalDailyCap ?? null,
      startAt: this.normalizeDate(input.startAt ?? null),
      endAt: this.normalizeDate(input.endAt ?? null),
      notifyType: input.notifyType ?? null,
      notifyTemplate: input.notifyTemplate ?? null,
    };
    this.assertCommon(merged);
    if (merged.segmentId) await this.assertSegmentExists(merged.segmentId);
    if (merged.productId) await this.assertProductExists(merged.productId);

    const base: Prisma.CreditGrantRuleCreateInput = {
      name: merged.name,
      triggerType: merged.triggerType,
      cronExpr: merged.cronExpr,
      rewardType: merged.rewardType,
      rewardAmount: merged.rewardAmount,
      productId: merged.productId,
      expirePolicy: merged.expirePolicy,
      expireDays: merged.expireDays,
      perUserLimit: merged.perUserLimit,
      globalDailyCap: merged.globalDailyCap,
      isActive: input.isActive ?? true,
      startAt: merged.startAt,
      endAt: merged.endAt,
      notifyType: merged.notifyType,
      notifyTemplate: merged.notifyTemplate,
    };
    if (merged.segmentId) {
      base.segment = { connect: { id: merged.segmentId } };
    }
    return base;
  }

  private assertCommon(merged: {
    name: string;
    triggerType: GrantTriggerType;
    cronExpr: string | null;
    rewardType: GrantRewardType;
    rewardAmount: number;
    expirePolicy: GrantExpirePolicy;
    expireDays: number | null;
    perUserLimit: number;
    globalDailyCap: number | null;
    startAt: Date | null;
    endAt: Date | null;
    notifyType: GrantNotifyType | null;
    notifyTemplate: string | null;
  }): void {
    // name
    if (typeof merged.name !== 'string' || !merged.name.trim()) {
      throw new BadRequestException('name 必填');
    }
    if (merged.name.length > NAME_MAX) {
      throw new BadRequestException(`name 长度不得超过 ${NAME_MAX} 字符`);
    }
    // enums
    if (!TRIGGER_TYPES.has(merged.triggerType)) {
      throw new BadRequestException('triggerType 非法');
    }
    if (!REWARD_TYPES.has(merged.rewardType)) {
      throw new BadRequestException('rewardType 非法');
    }
    if (merged.rewardType === 'BOOSTER_PACK') {
      throw new BadRequestException(
        'BOOSTER_PACK 奖励规则暂不支持发放：当前 CreditGrantRule 缺少 boosterPackId / SKU 绑定，请使用 CREDIT 或 BALANCE',
      );
    }
    if (!EXPIRE_POLICIES.has(merged.expirePolicy)) {
      throw new BadRequestException('expirePolicy 非法');
    }
    // cron expr matches trigger type
    if (CRON_TRIGGERS.has(merged.triggerType)) {
      if (!merged.cronExpr || !merged.cronExpr.trim()) {
        throw new BadRequestException(
          'DAILY_CRON / WEEKLY_CRON 必须填写 cronExpr',
        );
      }
      this.assertCronExpr(merged.cronExpr);
    } else if (merged.cronExpr) {
      throw new BadRequestException(
        '只有 DAILY_CRON / WEEKLY_CRON 触发方式允许设置 cronExpr',
      );
    }
    // reward amount
    if (
      typeof merged.rewardAmount !== 'number' ||
      !Number.isInteger(merged.rewardAmount) ||
      merged.rewardAmount <= 0
    ) {
      throw new BadRequestException('rewardAmount 必须是正整数');
    }
    if (merged.rewardAmount > REWARD_AMOUNT_MAX) {
      throw new BadRequestException(
        `rewardAmount 不得超过 ${REWARD_AMOUNT_MAX}`,
      );
    }
    // expire days
    if (merged.expirePolicy === 'N_DAYS') {
      if (
        typeof merged.expireDays !== 'number' ||
        !Number.isInteger(merged.expireDays) ||
        merged.expireDays < EXPIRE_DAYS_MIN ||
        merged.expireDays > EXPIRE_DAYS_MAX
      ) {
        throw new BadRequestException(
          `expireDays 必须在 ${EXPIRE_DAYS_MIN}-${EXPIRE_DAYS_MAX} 之间`,
        );
      }
    } else if (merged.expireDays != null) {
      throw new BadRequestException(
        '只有 expirePolicy=N_DAYS 时才允许设置 expireDays',
      );
    }
    // per-user limit
    if (
      !Number.isInteger(merged.perUserLimit) ||
      merged.perUserLimit < 1 ||
      merged.perUserLimit > PER_USER_LIMIT_MAX
    ) {
      throw new BadRequestException(
        `perUserLimit 必须在 1-${PER_USER_LIMIT_MAX} 之间`,
      );
    }
    // global daily cap
    if (
      merged.globalDailyCap != null &&
      (!Number.isInteger(merged.globalDailyCap) || merged.globalDailyCap < 1)
    ) {
      throw new BadRequestException(
        'globalDailyCap 必须是 ≥ 1 的整数或留空',
      );
    }
    // start/end window
    if (
      merged.startAt &&
      merged.endAt &&
      merged.endAt.getTime() <= merged.startAt.getTime()
    ) {
      throw new BadRequestException('endAt 必须晚于 startAt');
    }
    // notify
    if (merged.notifyType && !NOTIFY_TYPES.has(merged.notifyType)) {
      throw new BadRequestException('notifyType 非法');
    }
    if (
      merged.notifyType &&
      merged.notifyType !== 'NONE' &&
      (!merged.notifyTemplate || !merged.notifyTemplate.trim())
    ) {
      throw new BadRequestException(
        'notifyType 设置为 INAPP/EMAIL/SMS 时必须填写 notifyTemplate',
      );
    }
    if (
      merged.notifyTemplate &&
      merged.notifyTemplate.length > NOTIFY_TEMPLATE_MAX
    ) {
      throw new BadRequestException(
        `notifyTemplate 长度不得超过 ${NOTIFY_TEMPLATE_MAX} 字符`,
      );
    }
  }

  /** Light cron validation: 5 fields separated by whitespace. */
  private assertCronExpr(expr: string): void {
    const fields = expr.trim().split(/\s+/);
    if (fields.length !== 5) {
      throw new BadRequestException(
        'cronExpr 必须是 5 段标准 cron 表达式 (m h dom mon dow)',
      );
    }
    // Sanity: only allow digits / common cron meta-chars.
    if (!/^[0-9*,\-/ ?A-Za-z]+$/.test(expr)) {
      throw new BadRequestException('cronExpr 含非法字符');
    }
  }

  private normalizeDate(raw: string | Date | null | undefined): Date | null {
    if (raw === null || raw === undefined) return null;
    const d = raw instanceof Date ? raw : new Date(raw);
    if (Number.isNaN(d.getTime())) {
      throw new BadRequestException('startAt / endAt 必须是合法时间');
    }
    return d;
  }

  private async assertSegmentExists(segmentId: string): Promise<void> {
    const seg = await this.prisma.userSegment.findFirst({
      where: { id: segmentId, deletedAt: null },
      select: { id: true },
    });
    if (!seg) throw new BadRequestException('segmentId 不存在');
  }

  private async assertProductExists(productId: string): Promise<void> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: { id: true },
    });
    if (!product) throw new BadRequestException('productId 不存在');
  }
}
