import { Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

/**
 * Token 用量周期汇总 V2 —— 数据访问层。
 *
 * 与 v1（`billing.repository.ts#aggregateTokenUsagePeriodSummary`）完全独立，v1 不做任何改动。
 *
 * 关键设计（UAT 事故复盘）：
 * 1. 绝不 `LEFT JOIN gateway_token_usage_net_balance`。该视图内部是逐行相关子查询
 *    （`gateway_customer_net_charges` × `token_usage` × 每行 3 个 SUM 子查询），
 *    在 570 万 token_usage / 374 万 allocations 上单次 `count(*)` 就要 136 秒；
 *    作为 join 使用会让查询跑十几小时不返回，客户端 110 秒断开后 PostgreSQL 仍继续执行，
 *    查询越堆越多把整个 billing 拖垮。V2 只走基表 + 索引。
 * 2. 聚合全部下推到 PostgreSQL：`balance_consumption_allocations` 有
 *    `token_usage_id` 索引，按 scoped 行做 index lookup，不做全表重扫。
 * 3. **企业账户先解析 tenant ID 再用字面量过滤，不 JOIN `tenants`** ——
 *    这决定了优化器能否拿到正确基数，详见 `scopeFilters` 注释。
 * 4. 每条查询都带 `statement_timeout`，异常计划最多占用 90 秒，不会留下孤儿长查询。
 * 5. 时间列 `created_at` 是 `timestamp without time zone` 的 UTC 墙钟，
 *    范围用 `$bound AT TIME ZONE 'UTC'`，分桶用 `AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai'`。
 * 6. 在 90 秒预算内尽量让聚合留在内存里（见下方 `WORK_MEM_KB_DEFAULT`）。
 */

/**
 * 单条查询的硬上限。取值依据 UAT 实测（含最重客户广州头文，307 万行 / 3.0M 分摊）：
 * - 企业账单两个现算查询（生产基线）冷缓存 24s + 25s ≈ 50s，热缓存 4.9s（邻可 51 万行）；
 * - v2 合并成一条查询：邻可 12s~36s（随页缓存冷暖波动）；头文 65s~85s。
 * 90s 既覆盖最重客户，又低于网关 110s 的客户端中止阈值，
 * 不会重演「客户端断开、数据库继续跑十几小时」的孤儿查询事故。
 *
 * 已知边界：头文这种 300 万行级别的账户在 UAT 负载高峰会贴近甚至越过 90s，
 * 表现为 57014（statement timeout）而不是长时间占连接。要根治必须加覆盖索引
 * `balance_consumption_allocations (billing_account_id, token_usage_id) INCLUDE (...)`
 * 并把聚合顺序改成「先在账户侧流式聚合、再 join」——实测头文 65~83s → 29s。
 * 该方案是 schema 变更，未在此实施。
 */
const STATEMENT_TIMEOUT_MS = 90_000;
const STATEMENT_TIMEOUT_SQL = `SET LOCAL statement_timeout = ${STATEMENT_TIMEOUT_MS}`;

/**
 * 单条查询用的排序 / 哈希内存（kB）。这里改的是**落盘量**，依据 UAT 实测：
 * - 默认 4MB 时，企业账户按 `token_usage_id` 聚合分摊会 HashAggregate 落盘：
 *   51 万行账户落盘 293MB，307 万行账户落盘 2.4GB；
 * - 提到 256MB 后落盘降到 40MB / 1.5GB（`EXPLAIN (ANALYZE, BUFFERS)` 的 Disk Usage，可直接复现）。
 *
 * 端到端墙钟时间在共享 UAT 上**不可稳定复现**：同一查询连跑会在 12s~36s（51 万行账户）
 * 和 65s~85s（307 万行账户）之间跳动，波动来自页缓存冷暖与并发流量，幅度大于 work_mem 本身的影响。
 * 所以调大 work_mem 的理由是「少写临时文件、少占磁盘带宽」，而不是承诺固定百分比的加速。
 *
 * `work_mem` 是「每个排序/哈希节点」的上限而非预分配：用不到就不占内存，
 * 因此小账户和日粒度查询没有额外成本。但同一条 SQL 可能有多个节点，
 * 单请求峰值约为 work_mem 的数倍，故默认值不宜再调大 ——
 * 真要给 300 万行级别的账户提速，唯一有效的方向是覆盖索引，见文件头注释。
 */
const WORK_MEM_KB_DEFAULT = 262_144;
const WORK_MEM_KB_MIN = 4_096;
const WORK_MEM_KB_MAX = 1_048_576;

const workMemKb = (): number => {
  const raw = Number.parseInt(process.env.BILLING_TOKEN_USAGE_SUMMARY_V2_WORK_MEM_KB ?? '', 10);
  if (!Number.isFinite(raw) || raw <= 0) return WORK_MEM_KB_DEFAULT;
  return Math.min(Math.max(raw, WORK_MEM_KB_MIN), WORK_MEM_KB_MAX);
};

const workMemSql = (): string => `SET LOCAL work_mem = ${workMemKb()}`;

/**
 * Prisma 交互式事务默认 `timeout` 只有 5s，远小于上面的 statement_timeout。
 * 必须显式放宽到比 statement_timeout 更宽，让数据库侧的超时先触发
 * （能拿到真实的慢查询错误，而不是连接层的 "Transaction already closed"）。
 */
const TRANSACTION_TIMEOUT_MS = STATEMENT_TIMEOUT_MS + 15_000;
const TRANSACTION_MAX_WAIT_MS = 10_000;

const ALLOCATION_SOURCE_ENTERPRISE_CREDIT = 'ENTERPRISE_CREDIT';
const ALLOCATION_SOURCE_NEGATIVE_BALANCE = 'NEGATIVE_BALANCE';

export type TokenUsagePeriodSummaryV2Granularity = 'day' | 'month';

export interface TokenUsagePeriodSummaryV2Scope {
  tenantId: string;
  billingAccountId: string;
  /**
   * 企业账户：按账单账户（`tenants.billing_account_id`）汇总，与
   * `/api/admin/v2/enterprise-accounts/:id/bills` 完全同口径；
   * 个人 / 团队账户：按工作区（tenant）汇总，保持 v1 语义。
   */
  byBillingAccount: boolean;
}

export interface TokenUsagePeriodSummaryV2Filters {
  /** 起始边界（UTC 瞬时），左右闭开区间 */
  startInclusive: Date;
  /** 结束边界（UTC 瞬时，右开） */
  endExclusive: Date;
  productId?: string;
  model?: string;
  apiKeyId?: string;
}

export interface TokenUsagePeriodSummaryV2Row {
  period: string;
  calls: number;
  totalTokens: number;
  consumeUsd: Prisma.Decimal;
  accountPayUsd: Prisma.Decimal;
  voucherUsd: Prisma.Decimal;
}

interface RawRow {
  period: string;
  calls: number | bigint;
  totalTokens: number | bigint;
  consumeUsd: Prisma.Decimal | number | string;
  accountPayUsd: Prisma.Decimal | number | string;
  voucherUsd: Prisma.Decimal | number | string;
}

const BEIJING_MONTH_SQL = Prisma.sql`
  to_char((tu.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai'), 'YYYY-MM')
`;
const BEIJING_DAY_SQL = Prisma.sql`
  to_char((tu.created_at AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai'), 'YYYY-MM-DD')
`;

@Injectable()
export class TokenUsagePeriodSummaryV2Repository {
  constructor(private readonly prisma: PrismaService) {}

  async aggregate(
    scope: TokenUsagePeriodSummaryV2Scope,
    filters: TokenUsagePeriodSummaryV2Filters,
    granularity: TokenUsagePeriodSummaryV2Granularity,
  ): Promise<TokenUsagePeriodSummaryV2Row[]> {
    // 企业账户：先把 tenant 解析成具体 ID 列表，再以字面量过滤用量表。
    // 这一步决定了优化器能否拿到准确基数，见 scopeFilters 注释。
    const tenantIds = scope.byBillingAccount
      ? await this.resolveBillingAccountTenantIds(scope.billingAccountId)
      : [scope.tenantId];

    if (tenantIds.length === 0) return [];

    const query = granularity === 'month'
      ? this.buildMonthlyQuery(tenantIds, filters)
      : this.buildDailyQuery(tenantIds, filters);

    const rows = await this.prisma.$transaction(
      async (tx) => {
        await tx.$executeRawUnsafe(STATEMENT_TIMEOUT_SQL);
        await tx.$executeRawUnsafe(workMemSql());
        return tx.$queryRaw<RawRow[]>(query);
      },
      { timeout: TRANSACTION_TIMEOUT_MS, maxWait: TRANSACTION_MAX_WAIT_MS },
    );

    return rows.map((row) => ({
      period: row.period,
      calls: Number(row.calls),
      totalTokens: Number(row.totalTokens),
      consumeUsd: new Prisma.Decimal(row.consumeUsd ?? 0),
      accountPayUsd: new Prisma.Decimal(row.accountPayUsd ?? 0),
      voucherUsd: new Prisma.Decimal(row.voucherUsd ?? 0),
    }));
  }

  /**
   * 解析账单账户下的工作区 ID。
   *
   * 这是一次走 `tenants_billing_account_id_idx` 的小查询（单账户通常 1~4 行），
   * 换来的是下面这条关键收益：企业账户的大查询不再依赖 JOIN 推导租户。
   */
  private async resolveBillingAccountTenantIds(billingAccountId: string): Promise<string[]> {
    const rows = await this.prisma.$queryRaw<Array<{ id: string }>>(Prisma.sql`
      SELECT id FROM tenants WHERE billing_account_id = ${billingAccountId}
    `);
    return rows.map((row) => row.id);
  }

  /** 时间窗 + 可选维度过滤。 */
  private scopeFilters(
    tenantIds: string[],
    filters: TokenUsagePeriodSummaryV2Filters,
  ): Prisma.Sql {
    /**
     * 这里刻意不写 `JOIN tenants t ON t.id = tu.tenant_id WHERE t.billing_account_id = ...`。
     *
     * 生产实测（北京，`ruidong_billing`，2026-11）：优化器无法把 `billing_account_id`
     * 的常量推导到 `tu.tenant_id`，于是退化用 `n_distinct`（314）取平均 —— 对最大的企业账户
     * 估算 19,158 行，实际 3,310,897 行，低估 172 倍。后果是它把大查询当成小查询，
     * 选 Nested Loop 且不启用并行（代价估算 3,764）。改成字面量列表后，优化器可以直接命中
     * `token_usage.tenant_id` 的 MCV（该账户频率 0.539），估算回到 1,351,039 行，
     * 计划变为 Parallel Index Only Scan（代价 146,889）。
     *
     * 同理这里不加 `bca.created_at` 的时间边界：分摊行与用量行的 `created_at` 在生产上
     * 全部不相等（最大差 62 天），按它过滤会漏数据。
     */
    const conditions: Prisma.Sql[] = [
      Prisma.sql`tu.tenant_id IN (${Prisma.join(tenantIds)})`,
      Prisma.sql`tu.created_at >= (${filters.startInclusive} AT TIME ZONE 'UTC')`,
      Prisma.sql`tu.created_at < (${filters.endExclusive} AT TIME ZONE 'UTC')`,
    ];
    if (filters.productId) conditions.push(Prisma.sql`tu.product_id = ${filters.productId}`);
    if (filters.model) conditions.push(Prisma.sql`tu.model = ${filters.model}`);
    if (filters.apiKeyId) conditions.push(Prisma.sql`tu.api_key_id = ${filters.apiKeyId}`);
    return Prisma.join(conditions, ' AND ');
  }

  /**
   * 月粒度：对齐企业账单 `/enterprise-accounts/:id/bills` 的现算口径。
   *
   * - 请求数：可见行行数（与财务对账「API用量扣费」同一谓词，tokens 全 0 且无金额的归零调用不计）
   * - Token 总量：`discounted > 0` 的分量 token 之和
   * - 消耗金额：`ROUND(SUM(ABS(discounted)) * 100)`，先 SUM 再进分
   * - 代金券扣费：`collected_bonus`（排除无 grant 的企业信用 / 负余额分摊）
   * - 账户扣费：三渠道 `accountPay` 口径
   */
  private buildMonthlyQuery(
    tenantIds: string[],
    filters: TokenUsagePeriodSummaryV2Filters,
  ): Prisma.Sql {
    const where = this.scopeFilters(tenantIds, filters);
    return Prisma.sql`
      WITH scoped AS MATERIALIZED (
        SELECT
          tu.id,
          ${BEIJING_MONTH_SQL} AS period,
          GREATEST(COALESCE(tu.prompt_tokens, 0), 0) AS prompt,
          GREATEST(COALESCE(tu.cached_input_tokens, 0), 0) AS cache_read,
          GREATEST(COALESCE(tu.cache_write_input_tokens, 0), 0) AS cache_write,
          GREATEST(COALESCE(tu.completion_tokens, 0), 0) AS output,
          GREATEST(COALESCE(tu.total_tokens, 0), 0) AS total_tokens,
          COALESCE(tu.customer_charge_usd, 0) AS customer_charge_usd,
          COALESCE(tu.cost_usd, 0) AS cost_usd,
          tu.customer_charge_policy,
          COALESCE(tu.customer_collected_usd, 0) AS customer_collected_usd,
          COALESCE(tu.customer_approved_receivable_usd, 0) AS customer_approved_receivable_usd,
          COALESCE(tu.customer_unapproved_debt_usd, 0) AS customer_unapproved_debt_usd,
          COALESCE(tu.customer_funding_classification_complete, false) AS funding_complete,
          COALESCE(tu.provider_cost_estimate_usd, 0) AS provider_cost_estimate_usd
        FROM token_usage tu
        WHERE ${where}
      ),
      allocs AS (
        SELECT
          bca.token_usage_id,
          COALESCE(SUM(bca.amount_usd), 0) AS allocated_charge,
          COALESCE(SUM(CASE
            WHEN NOT (
              (bca.source = ${ALLOCATION_SOURCE_ENTERPRISE_CREDIT} AND bca.balance_grant_id IS NULL)
              OR (bca.source = ${ALLOCATION_SOURCE_NEGATIVE_BALANCE} AND bca.balance_grant_id IS NULL)
            ) THEN bca.recognized_revenue_usd ELSE 0
          END), 0) AS collected_revenue,
          COALESCE(SUM(CASE
            WHEN NOT (
              (bca.source = ${ALLOCATION_SOURCE_ENTERPRISE_CREDIT} AND bca.balance_grant_id IS NULL)
              OR (bca.source = ${ALLOCATION_SOURCE_NEGATIVE_BALANCE} AND bca.balance_grant_id IS NULL)
            ) THEN bca.bonus_consumed_usd ELSE 0
          END), 0) AS collected_bonus,
          BOOL_OR(
            bca.source IN (${ALLOCATION_SOURCE_ENTERPRISE_CREDIT}, ${ALLOCATION_SOURCE_NEGATIVE_BALANCE})
            AND bca.balance_grant_id IS NULL
            AND COALESCE(bca.funding_classification_complete, false) IS NOT TRUE
          ) AS has_unclassified_debt
        FROM balance_consumption_allocations bca
        JOIN scoped s ON s.id = bca.token_usage_id
        GROUP BY bca.token_usage_id
      ),
      joined AS (
        SELECT
          s.*,
          a.allocated_charge,
          a.collected_revenue,
          a.collected_bonus,
          COALESCE(a.has_unclassified_debt, false) AS has_unclassified_debt
        FROM scoped s
        LEFT JOIN allocs a ON a.token_usage_id = s.id
      ),
      sized AS (
        SELECT
          j.*,
          GREATEST(
            j.prompt
              - LEAST(j.cache_read, j.prompt)
              - LEAST(j.cache_write, GREATEST(j.prompt - LEAST(j.cache_read, j.prompt), 0)),
            0
          ) AS input_tokens
        FROM joined j
      ),
      visible AS (
        SELECT *
        FROM sized
        WHERE prompt > 0
          OR cache_read > 0
          OR cache_write > 0
          OR output > 0
          OR total_tokens > 0
          OR customer_charge_usd > 0
          OR provider_cost_estimate_usd > 0
          OR COALESCE(allocated_charge, 0) > 0
          OR (
            customer_charge_policy IN ('usage_charge', 'legacy_cost_usd')
            AND cost_usd <> 0
          )
      ),
      charged AS (
        SELECT
          v.*,
          CASE
            WHEN COALESCE(v.allocated_charge, 0) > 0 THEN v.allocated_charge
            WHEN v.customer_charge_usd > 0 THEN v.customer_charge_usd
            WHEN v.customer_charge_policy IS NULL
              OR v.customer_charge_policy IN ('usage_charge', 'legacy_cost_usd')
              THEN ABS(v.cost_usd)
            ELSE 0
          END AS customer_charge,
          CASE
            WHEN v.input_tokens + v.cache_read + v.cache_write + v.output > 0
              THEN v.input_tokens + v.cache_read + v.cache_write + v.output
            ELSE v.total_tokens
          END AS part_tokens
        FROM visible v
      ),
      priced AS (
        SELECT
          period,
          customer_charge AS discounted,
          CASE
            WHEN COALESCE(allocated_charge, 0) > 0 THEN collected_bonus
            ELSE 0
          END AS voucher,
          CASE
            WHEN COALESCE(allocated_charge, 0) > 0 THEN collected_revenue
            WHEN funding_complete
              AND (customer_collected_usd + customer_approved_receivable_usd + customer_unapproved_debt_usd) = customer_charge
              AND (COALESCE(allocated_charge, 0) <= 0 OR has_unclassified_debt)
              THEN customer_collected_usd
            ELSE customer_charge
          END AS account_pay,
          part_tokens
        FROM charged
      )
      SELECT
        period,
        COUNT(*)::bigint AS "calls",
        COALESCE(SUM(CASE WHEN discounted > 0 THEN part_tokens ELSE 0 END), 0)::bigint AS "totalTokens",
        (COALESCE(ROUND(SUM(ABS(discounted)) * 100), 0) / 100)::numeric AS "consumeUsd",
        (COALESCE(ROUND(SUM(ABS(account_pay)) * 100), 0) / 100)::numeric AS "accountPayUsd",
        (COALESCE(ROUND(SUM(ABS(voucher)) * 100), 0) / 100)::numeric AS "voucherUsd"
      FROM priced
      GROUP BY period
      ORDER BY period DESC
    `;
  }

  /**
   * 日粒度：保持现有 v1 的按日实现逻辑（不改为企业账单口径）。
   *
   * - 请求数：行数
   * - Token 总量：`GREATEST(total_tokens, prompt + completion)`
   * - 消耗金额 / 账户扣费 / 代金券扣费：分摊优先，缺失时回退到 `cost_usd`
   *
   * 与 v1 的差异只在「范围」：不再 `JOIN api_keys`（内连接会把没有 key 归属的行整批丢掉），
   * 也不按 `ak.user_id` 收窄，避免非 owner 成员看到空数据。
   */
  private buildDailyQuery(
    tenantIds: string[],
    filters: TokenUsagePeriodSummaryV2Filters,
  ): Prisma.Sql {
    const where = this.scopeFilters(tenantIds, filters);
    return Prisma.sql`
      WITH scoped AS MATERIALIZED (
        SELECT
          tu.id,
          ${BEIJING_DAY_SQL} AS period,
          GREATEST(
            COALESCE(tu.total_tokens, 0),
            COALESCE(tu.prompt_tokens, 0) + COALESCE(tu.completion_tokens, 0)
          ) AS tokens,
          COALESCE(tu.cost_usd, 0) AS cost_usd
        FROM token_usage tu
        WHERE ${where}
      ),
      allocs AS (
        SELECT
          bca.token_usage_id,
          SUM(bca.amount_usd) AS allocation_amount,
          SUM(bca.recognized_revenue_usd) AS payment_deduction,
          SUM(bca.bonus_consumed_usd) AS voucher_deduction
        FROM balance_consumption_allocations bca
        JOIN scoped s ON s.id = bca.token_usage_id
        GROUP BY bca.token_usage_id
      )
      SELECT
        s.period AS "period",
        COUNT(*)::bigint AS "calls",
        COALESCE(SUM(s.tokens), 0)::bigint AS "totalTokens",
        SUM(COALESCE(
          a.allocation_amount,
          CASE WHEN s.cost_usd > 0 THEN s.cost_usd ELSE ABS(s.cost_usd) END
        ))::numeric AS "consumeUsd",
        SUM(COALESCE(
          a.payment_deduction,
          CASE WHEN s.cost_usd > 0 THEN s.cost_usd ELSE ABS(s.cost_usd) END
        ))::numeric AS "accountPayUsd",
        SUM(COALESCE(a.voucher_deduction, 0))::numeric AS "voucherUsd"
      FROM scoped s
      LEFT JOIN allocs a ON a.token_usage_id = s.id
      GROUP BY s.period
      ORDER BY s.period DESC
    `;
  }
}
