/**
 * CreditPolicyService — admin v2 信用额度策略 (/admin/v2/credit-policy)
 *
 * 仅 PAY_AS_YOU_GO 产品适用:
 *   - GLOBAL 策略: 每个产品最多一条 (productId, scope=GLOBAL, segmentId=null)
 *   - SEGMENT 覆盖: 每个 (product, segment) 最多一条 (productId, scope=SEGMENT, segmentId)
 *
 * 核心使用方:
 *   - Admin Controller 增删改查
 *   - BillingService.deduct hook → resolvePolicyForUser 拿 EffectivePolicy
 *
 * 缓存:
 *   - resolvePolicyForUser 走 Redis 60s TTL,key: policy:user:{userId}:{productId||any}
 *   - upsert 不主动失效,等 60s TTL 过期(spec §10 决策)
 *
 * 故障 fallback:
 *   - Redis fail → 走 PG 路径,不抛
 *   - PG fail → fallback 保守 {allowOverdraft:false, creditLimitCents:0} + warn
 *
 * 详见 docs/superpowers/specs/2026-04-30-admin-v2-backend-p2-credit-policy-design.md
 */
import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import {
  CreditPolicy,
  CreditPolicyRecoveryCondition,
  CreditPolicyScope,
  CreditPolicyTriggerAction,
  Prisma,
} from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { RedisService } from '../redis/redis.service';
import { usdToCents, type DecimalLike } from '../billing/money';

const POLICY_CACHE_TTL_SECONDS = 60;
const PAGE_SIZE_MAX = 200;

/** Redis cache key for resolved policy (per user, optionally per product). */
function policyCacheKey(userId: string, productId?: string): string {
  return `policy:user:${userId}:${productId ?? 'any'}`;
}

/** 默认 GLOBAL policy(spec §7.1):productId 没配 policy 时返回此默认值,不写入 DB。 */
export interface DefaultGlobalPolicy {
  productId: string;
  scope: 'GLOBAL';
  segmentId: null;
  allowOverdraft: false;
  defaultCreditLimitCents: 0;
  triggerAction: CreditPolicyTriggerAction;
  recoveryCondition: CreditPolicyRecoveryCondition;
  recoveryDays: null;
  /** marker: 这是默认值,不是 DB 行 */
  isDefault: true;
}

/** BillingService.deduct hook 用的有效策略快照。 */
export interface EffectivePolicy {
  allowOverdraft: boolean;
  /** 0 = 严格不许透支;>0 = 允许透支到 -creditLimitCents */
  creditLimitCents: number;
}

/** 透支用户列表条目 */
export interface OverdueUserItem {
  userId: string;
  email: string;
  productId: string | null;
  balanceCents: number;
  overdueDays: number;
  reason: string;
  creditLimitCents: number;
}

/** upsertGlobal/upsertSegment 入参字段(都可选,缺省走 schema default)。 */
export interface CreditPolicyWriteInput {
  allowOverdraft?: boolean;
  defaultCreditLimitCents?: number;
  triggerAction?: CreditPolicyTriggerAction;
  recoveryCondition?: CreditPolicyRecoveryCondition;
  recoveryDays?: number | null;
}

/**
 * 内部:把字符串 enum 安全转为 Prisma enum。
 *
 * P2-C review fix(Minor #4): 之前非法值 silent drop(回退到 schema default),
 * 运营 admin 提交错值看不到反馈。改为非法值抛 BadRequestException,
 * 让前端能直接看到错误。
 */
const TRIGGER_ACTION_VALUES: readonly CreditPolicyTriggerAction[] = [
  'SUSPEND',
  'ALERT',
  'EMAIL',
];
const RECOVERY_CONDITION_VALUES: readonly CreditPolicyRecoveryCondition[] = [
  'ON_RECHARGE',
  'AFTER_DAYS',
  'MANUAL',
];

function toTriggerAction(raw: unknown): CreditPolicyTriggerAction {
  if (raw !== 'SUSPEND' && raw !== 'ALERT' && raw !== 'EMAIL') {
    throw new BadRequestException(
      `triggerAction 非法,允许值: [${TRIGGER_ACTION_VALUES.join(', ')}]`,
    );
  }
  return raw;
}

function toRecoveryCondition(raw: unknown): CreditPolicyRecoveryCondition {
  if (raw !== 'ON_RECHARGE' && raw !== 'AFTER_DAYS' && raw !== 'MANUAL') {
    throw new BadRequestException(
      `recoveryCondition 非法,允许值: [${RECOVERY_CONDITION_VALUES.join(', ')}]`,
    );
  }
  return raw;
}

@Injectable()
export class CreditPolicyService {
  private readonly logger = new Logger(CreditPolicyService.name);

  constructor(
    private readonly prisma: PrismaService,
    private readonly redis: RedisService,
  ) {}

  // ============================================================
  // Admin CRUD
  // ============================================================

  /**
   * 取产品的全局策略。无配置时返回默认值(不写入 DB,前端 upsert 触发首次写入)。
   */
  async getGlobal(productId: string): Promise<CreditPolicy | DefaultGlobalPolicy> {
    if (!productId || typeof productId !== 'string') {
      throw new BadRequestException('productId 必填');
    }
    const row = await this.prisma.creditPolicy.findFirst({
      where: { productId, scope: 'GLOBAL', segmentId: null },
    });
    if (row) return row;
    return {
      productId,
      scope: 'GLOBAL',
      segmentId: null,
      allowOverdraft: false,
      defaultCreditLimitCents: 0,
      triggerAction: 'SUSPEND',
      recoveryCondition: 'ON_RECHARGE',
      recoveryDays: null,
      isDefault: true,
    };
  }

  /**
   * upsert 产品全局策略。仅 PAY_AS_YOU_GO 产品允许配置。
   *
   * 唯一性: (productId, scope=GLOBAL, segmentId=null) 命中既有行则 update,否则 create。
   * PG unique index 把 NULL 视为不同 → DB 层不阻止重复,但 service 层用 findFirst+update/create
   * 路径保证幂等(每个产品只一条 GLOBAL)。
   */
  async upsertGlobal(productId: string, data: CreditPolicyWriteInput): Promise<CreditPolicy> {
    if (!productId || typeof productId !== 'string') {
      throw new BadRequestException('productId 必填');
    }
    await this.assertPayAsYouGoProduct(productId);

    const existing = await this.prisma.creditPolicy.findFirst({
      where: { productId, scope: 'GLOBAL', segmentId: null },
    });

    const writeData = this.buildWriteData(data);

    if (existing) {
      return this.prisma.creditPolicy.update({
        where: { id: existing.id },
        data: writeData,
      });
    }
    return this.prisma.creditPolicy.create({
      data: {
        productId,
        scope: 'GLOBAL',
        segmentId: null,
        ...writeData,
      },
    });
  }

  /**
   * 列产品下所有 SEGMENT 覆盖策略。按 createdAt 倒序。
   */
  async listSegments(productId: string): Promise<CreditPolicy[]> {
    if (!productId || typeof productId !== 'string') {
      throw new BadRequestException('productId 必填');
    }
    return this.prisma.creditPolicy.findMany({
      where: { productId, scope: 'SEGMENT' },
      orderBy: { createdAt: 'desc' },
    });
  }

  /**
   * upsert 一条 SEGMENT 覆盖策略。仅 PAY_AS_YOU_GO 产品允许。
   *
   * 唯一性: 由 @@unique([productId, scope, segmentId]) 保证(SEGMENT 时 segmentId
   * 必非空,unique index 正常生效)。先 findUnique 走 update,否则 create。
   */
  async upsertSegment(input: {
    productId: string;
    segmentId: string;
    data: CreditPolicyWriteInput;
  }): Promise<CreditPolicy> {
    const { productId, segmentId, data } = input;
    if (!productId || !segmentId) {
      throw new BadRequestException('productId 和 segmentId 必填');
    }
    await this.assertPayAsYouGoProduct(productId);
    // segment 必须存在(否则 FK 抛 P2003,不友好)
    const seg = await this.prisma.userSegment.findUnique({ where: { id: segmentId } });
    if (!seg) throw new NotFoundException('用户分群不存在');

    const writeData = this.buildWriteData(data);
    const existing = await this.prisma.creditPolicy.findFirst({
      where: { productId, scope: 'SEGMENT', segmentId },
    });
    if (existing) {
      return this.prisma.creditPolicy.update({
        where: { id: existing.id },
        data: writeData,
      });
    }
    return this.prisma.creditPolicy.create({
      data: {
        productId,
        scope: 'SEGMENT',
        segmentId,
        ...writeData,
      },
    });
  }

  /**
   * 列当前透支用户(余额 < 0)。
   *
   * 数据来源: BalanceTransaction.balanceAfterUsd < 0 的最新一条 per user。
   * 用 Postgres 原生 `SELECT DISTINCT ON (user_id) ... ORDER BY user_id, created_at DESC`
   * 拿到每个用户的最新流水,然后过滤 balance_after_usd < 0。
   *
   * productId 过滤通过 BalanceTransaction.orderId → Order.planId → Plan.productId
   * 链路实现;但当前 BalanceTransaction 不直接关联 product,因此暂时:
   *   - 无 productId 过滤: 全部透支用户
   *   - 有 productId 过滤: 取 BalanceTransaction.orderId 链回 Order 的 productId
   *     等价过滤;若链路中断(无 orderId 或 Order 已删)则该笔不计入产品过滤结果。
   *
   * 性能: saas-test 量小(BalanceTransaction 数千行)直接全表 DISTINCT ON 可承受;
   * prod 上量后用 EXPLAIN 决定索引(spec §7.4)。本期暂不加新索引。
   */
  async listOverdueUsers(opts: {
    productId?: string;
    page?: number;
    pageSize?: number;
  }): Promise<{ items: OverdueUserItem[]; total: number; page: number; pageSize: number }> {
    const page = Math.max(1, Math.floor(opts.page ?? 1) || 1);
    const rawPageSize = Math.floor(opts.pageSize ?? 20) || 20;
    const pageSize = Math.max(1, Math.min(PAGE_SIZE_MAX, rawPageSize));
    const offset = (page - 1) * pageSize;

    // 拿到所有透支用户的最新一条流水。
    // DISTINCT ON 配合 ORDER BY user_id, created_at DESC 是 Postgres 惯用法。
    const rows = await this.prisma.$queryRaw<
      Array<{
        user_id: string;
        balance_after_usd: unknown;
        description: string;
        created_at: Date;
        first_overdue_at: Date | null;
      }>
    >(Prisma.sql`
      WITH latest_per_user AS (
        SELECT DISTINCT ON (bt.user_id)
          bt.user_id,
          bt.balance_after_usd,
          bt.description,
          bt.created_at
        FROM balance_transactions bt
        ORDER BY bt.user_id, bt.created_at DESC
      ),
      first_overdue AS (
        SELECT user_id, MIN(created_at) AS first_overdue_at
        FROM balance_transactions
        WHERE balance_after_usd < 0
        GROUP BY user_id
      )
      SELECT
        lpu.user_id,
        lpu.balance_after_usd,
        lpu.description,
        lpu.created_at,
        fo.first_overdue_at
      FROM latest_per_user lpu
      LEFT JOIN first_overdue fo ON fo.user_id = lpu.user_id
      WHERE lpu.balance_after_usd < 0
      ORDER BY lpu.balance_after_usd ASC
    `);

    // 内存 productId 过滤(saas-test 量小可接受;后续上量改 SQL JOIN)。
    let filtered = rows;
    if (opts.productId) {
      const userIds = rows.map((r) => r.user_id);
      if (userIds.length === 0) {
        return { items: [], total: 0, page, pageSize };
      }
      // 通过 Order.planId → Plan.productId 链路反查"持有该产品订单"的 user
      const orderUsers = await this.prisma.order.findMany({
        where: {
          userId: { in: userIds },
          plan: { productId: opts.productId },
        },
        select: { userId: true },
        distinct: ['userId'],
      });
      const allowSet = new Set(orderUsers.map((o) => o.userId));
      filtered = rows.filter((r) => allowSet.has(r.user_id));
    }

    const total = filtered.length;
    const slice = filtered.slice(offset, offset + pageSize);

    if (slice.length === 0) {
      return { items: [], total, page, pageSize };
    }

    // 批量取 email
    const sliceUserIds = slice.map((r) => r.user_id);
    const users = await this.prisma.user.findMany({
      where: { id: { in: sliceUserIds } },
      select: { id: true, email: true },
    });
    const emailMap = new Map(users.map((u) => [u.id, u.email ?? '']));

    // 每条算 creditLimit + overdueDays
    const now = Date.now();
    const items: OverdueUserItem[] = [];
    for (const row of slice) {
      const policy = await this.resolvePolicyForUser(row.user_id, opts.productId).catch(
        () => null,
      );
      const limitCents = policy?.allowOverdraft ? policy.creditLimitCents : 0;
      const overdueDays = row.first_overdue_at
        ? Math.max(0, Math.floor((now - row.first_overdue_at.getTime()) / 86_400_000))
        : 0;
      items.push({
        userId: row.user_id,
        email: emailMap.get(row.user_id) ?? '',
        productId: opts.productId ?? null,
        balanceCents: usdToCents(row.balance_after_usd as DecimalLike),
        overdueDays,
        reason: row.description ?? '',
        creditLimitCents: limitCents,
      });
    }

    return { items, total, page, pageSize };
  }

  // ============================================================
  // BillingService.deduct hook
  // ============================================================

  /**
   * 解析用户在指定产品下的有效策略。
   *
   * 优先级 (spec §7.2):
   *   1. SEGMENT 命中(用户所属 STATIC segment 中任一条匹配 productId)
   *   2. GLOBAL (productId)
   *   3. fallback {allowOverdraft:false, creditLimitCents:0}
   *
   * 故障语义:
   *   - Redis 故障 → 走 PG 路径,不抛
   *   - PG 故障 → fallback 保守 + warn
   *
   * productId=undefined 处理(spec §7.2 关键):
   *   本期不做"全产品 SEGMENT 解析",直接 fallback 保守 + warn。
   *   留 P3:支持跨产品的 SEGMENT 策略时再扩展。
   */
  async resolvePolicyForUser(userId: string, productId?: string): Promise<EffectivePolicy> {
    if (!userId) {
      return { allowOverdraft: false, creditLimitCents: 0 };
    }

    // 本期 productId=undefined 直接走保守 fallback(spec §7.2 决策)
    if (!productId) {
      this.logger.warn(
        `resolvePolicyForUser called without productId for user=${userId}; falling back to conservative policy. (跨产品 policy 留 P3)`,
      );
      return { allowOverdraft: false, creditLimitCents: 0 };
    }

    const cacheKey = policyCacheKey(userId, productId);

    // 1. Redis cache
    try {
      const cached = await this.redis.get(cacheKey);
      if (cached) {
        try {
          const parsed = JSON.parse(cached) as EffectivePolicy;
          if (
            typeof parsed?.allowOverdraft === 'boolean' &&
            typeof parsed?.creditLimitCents === 'number'
          ) {
            return parsed;
          }
          // 损坏的缓存 → 跳过,继续走 PG
        } catch {
          // JSON 损坏 → 跳过,继续走 PG
        }
      }
    } catch (err) {
      // Redis 故障 → warn,继续走 PG 路径
      this.logger.warn(
        `resolvePolicyForUser redis get failed (user=${userId}, productId=${productId}): ${(err as Error)?.message ?? err}`,
      );
    }

    // 2. PG 解析
    let effective: EffectivePolicy;
    try {
      const memberships = await this.prisma.userSegmentMember.findMany({
        where: { userId },
        select: { segmentId: true },
      });
      const segmentIds = memberships.map((m) => m.segmentId);

      // 一次查 GLOBAL + 候选 SEGMENT,内存里挑优先级
      const policies = await this.prisma.creditPolicy.findMany({
        where: {
          productId,
          OR: [
            { scope: 'GLOBAL', segmentId: null },
            ...(segmentIds.length > 0
              ? [{ scope: 'SEGMENT' as CreditPolicyScope, segmentId: { in: segmentIds } }]
              : []),
          ],
        },
      });

      // SEGMENT > GLOBAL
      const segmentMatch = policies.find((p) => p.scope === 'SEGMENT');
      const globalMatch = policies.find(
        (p) => p.scope === 'GLOBAL' && p.segmentId === null,
      );
      const winner = segmentMatch ?? globalMatch;

      if (winner) {
        effective = {
          allowOverdraft: winner.allowOverdraft,
          creditLimitCents: winner.allowOverdraft ? winner.defaultCreditLimitCents : 0,
        };
      } else {
        // 都没匹配 → 保守 fallback
        effective = { allowOverdraft: false, creditLimitCents: 0 };
      }
    } catch (err) {
      this.logger.warn(
        `resolvePolicyForUser PG failed (user=${userId}, productId=${productId}): ${(err as Error)?.message ?? err}; falling back to conservative policy.`,
      );
      return { allowOverdraft: false, creditLimitCents: 0 };
    }

    // 3. 写 Redis cache(失败不抛)
    try {
      await this.redis.set(
        cacheKey,
        JSON.stringify(effective),
        'EX',
        POLICY_CACHE_TTL_SECONDS,
      );
    } catch (err) {
      this.logger.warn(
        `resolvePolicyForUser redis set failed (user=${userId}, productId=${productId}): ${(err as Error)?.message ?? err}`,
      );
    }

    return effective;
  }

  // ============================================================
  // 内部辅助
  // ============================================================

  /**
   * 校验产品是 PAY_AS_YOU_GO。其它 billingMode 抛 BadRequest。
   */
  private async assertPayAsYouGoProduct(productId: string): Promise<void> {
    const product = await this.prisma.product.findFirst({
      where: { id: productId, deletedAt: null },
      select: { id: true, billingMode: true },
    });
    if (!product) throw new NotFoundException('产品不存在');
    if (product.billingMode !== 'PAY_AS_YOU_GO') {
      throw new BadRequestException(
        `信用额度策略仅适用于 PAY_AS_YOU_GO 产品(当前: ${product.billingMode})`,
      );
    }
  }

  /**
   * 把 CreditPolicyWriteInput 转为可写字段映射。
   * 返回值同时兼容 prisma update.data 和 create.data(只挑写入字段,不带 productId/scope/segmentId 定位字段)。
   *
   * P2-C review fix(Minor #4): 严格校验输入,非法值抛 BadRequestException,
   * 不再 silent drop。运营 admin 提交错值能立即看到反馈。
   * - 字符串 enum 非法 → BadRequest
   * - defaultCreditLimitCents < 0 → BadRequest
   * - recoveryDays < 0 → BadRequest
   */
  private buildWriteData(data: CreditPolicyWriteInput): {
    allowOverdraft?: boolean;
    defaultCreditLimitCents?: number;
    triggerAction?: CreditPolicyTriggerAction;
    recoveryCondition?: CreditPolicyRecoveryCondition;
    recoveryDays?: number | null;
  } {
    const out: ReturnType<CreditPolicyService['buildWriteData']> = {};
    if (typeof data.allowOverdraft === 'boolean') {
      out.allowOverdraft = data.allowOverdraft;
    }
    if (data.defaultCreditLimitCents !== undefined) {
      if (
        typeof data.defaultCreditLimitCents !== 'number' ||
        !Number.isFinite(data.defaultCreditLimitCents) ||
        data.defaultCreditLimitCents < 0
      ) {
        throw new BadRequestException(
          'defaultCreditLimitCents 非法,必须为 >= 0 的数字',
        );
      }
      out.defaultCreditLimitCents = Math.floor(data.defaultCreditLimitCents);
    }
    if (data.triggerAction !== undefined) {
      out.triggerAction = toTriggerAction(data.triggerAction);
    }
    if (data.recoveryCondition !== undefined) {
      out.recoveryCondition = toRecoveryCondition(data.recoveryCondition);
    }
    if (data.recoveryDays === null) {
      out.recoveryDays = null;
    } else if (data.recoveryDays !== undefined) {
      if (
        typeof data.recoveryDays !== 'number' ||
        !Number.isFinite(data.recoveryDays) ||
        data.recoveryDays < 0
      ) {
        throw new BadRequestException(
          'recoveryDays 非法,必须为 >= 0 的数字或 null',
        );
      }
      out.recoveryDays = Math.floor(data.recoveryDays);
    }
    return out;
  }
}
