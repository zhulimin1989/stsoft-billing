import { Prisma } from '@prisma/client';

/**
 * 账单明细聚合下推（「自然日 × 工作区 × 模型」）的一行结果。
 *
 * 金额一律以 `numeric::text` 返回，避免 Prisma 把 numeric 转成 JS number 掉精度；
 * token 以 `bigint::text` 返回，Node 侧再转 number（token 量级远小于 2^53）。
 *
 * 这里**不做**任何除法：`目录单价 = 折后单价 / 倍率` 与
 * `目录价格 = 目录单价 × 用量 / 1e6` 全部留给 Node 用 decimal.js 按原口径算，
 * SQL 只做可交换的整数/定点求和，保证与逐行折叠逐位对齐（见 spec 里的对照测试）。
 */
export type EnterpriseUsageAggregateRow = {
  /** 北京自然日，YYYY-MM-DD。 */
  day: string;
  tenant_id: string;
  model: string;
  call_type: string | null;
  /** 折后单价（catalog 单价的分母来源），组内常量。 */
  input_price: string | null;
  cached_price: string | null;
  cache_write_price: string | null;
  output_price: string | null;
  unit_price: string | null;
  /** 冻结的 customerMultiplier，文本原样；无快照为 null。 */
  multiplier: string | null;
  input_tokens: string;
  cache_read_tokens: string;
  cache_write_tokens: string;
  output_tokens: string;
  input_positive_tokens: string;
  cache_read_positive_tokens: string;
  cache_write_positive_tokens: string;
  output_positive_tokens: string;
  /** 四个分量全为 0 的行，回退成一个 total 分量；这里只求和它的 total_tokens。 */
  fallback_tokens: string;
  fallback_positive_tokens: string;
  /** 这类行有几条：即使 tokens 为 0，逐行路径也会产出一个 total 分量（类型/单价会计入）。 */
  fallback_rows: string;
  total_amount: string;
  credit_amount: string;
  debt_amount: string;
  voucher_amount: string;
  paid_amount: string;
  pending_amount: string;
  /** 折后 > 0 的行的 total_amount 合计。 */
  positive_discounted_amount: string;
};

/**
 * 单客户单账期的用量聚合查询。
 *
 * 与 `enterprise-bills.service.iterateUsagePages` 逐行路径同源同口径：
 * - 范围：`token_usage.created_at` 是 UTC 墙钟 timestamp，边界用 `AT TIME ZONE 'UTC'`；
 * - 自然日：`date_trunc('day', created_at + 8h)`；
 * - 渠道金额：`financeApiUsageChannelUsd` 的逐行判定 + 勾稽残差削减，逐行算完再 SUM；
 * - 分组键带上全部单价列与 `multiplier`，把「目录单价 / 倍率组内一致」的判定原样保留。
 */
export function buildEnterpriseUsageAggregateQuery(input: {
  accountId: string;
  start: Date;
  endExclusive: Date;
}): Prisma.Sql {
  return Prisma.sql`
-- enterprise-bills usage-aggregate-pushdown
WITH scoped AS (
  SELECT
    tu.id,
    tu.tenant_id,
    tu.model,
    tu.call_type,
    GREATEST(COALESCE(tu.prompt_tokens, 0), 0) AS prompt_tokens,
    GREATEST(COALESCE(tu.cached_input_tokens, 0), 0) AS cached_tokens,
    GREATEST(COALESCE(tu.cache_write_input_tokens, 0), 0) AS cache_write_tokens,
    GREATEST(COALESCE(tu.completion_tokens, 0), 0) AS completion_tokens,
    GREATEST(COALESCE(tu.total_tokens, 0), 0) AS total_tokens,
    tu.unit_price_usd,
    tu.input_price_usd_per_m,
    tu.cached_input_price_usd_per_m,
    tu.cache_write_price_usd_per_m,
    tu.output_price_usd_per_m,
    COALESCE(tu.customer_charge_usd, 0) AS stored_charge,
    COALESCE(tu.cost_usd, 0) AS cost_usd,
    NULLIF(tu.customer_charge_policy, '') AS charge_policy,
    COALESCE(tu.customer_collected_usd, 0) AS snapshot_collected,
    COALESCE(tu.customer_approved_receivable_usd, 0) AS snapshot_approved,
    COALESCE(tu.customer_unapproved_debt_usd, 0) AS snapshot_debt,
    tu.customer_funding_classification_complete AS snapshot_complete,
    sa.customer_pricing_snapshot ->> 'customerMultiplier' AS multiplier,
    (date_trunc('day', tu.created_at + interval '8 hours'))::date AS usage_day
  FROM token_usage tu
  JOIN tenants t ON t.id = tu.tenant_id
  -- 锚点按账号收窄（gateway_usage_settlement_anchors_account_occurred_idx）；
  -- 锚点的 billing_account_id 与用量所属账号恒等（UAT 实测 0 例外），这是纯谓词。
  LEFT JOIN gateway_usage_settlement_anchors sa
    ON sa.gateway_billing_event_id = tu.gateway_billing_event_id
   AND sa.billing_account_id = ${input.accountId}
  WHERE t.billing_account_id = ${input.accountId}
    AND tu.created_at >= (${input.start} AT TIME ZONE 'UTC')
    AND tu.created_at < (${input.endExclusive} AT TIME ZONE 'UTC')
),
-- 分摊按 token_usage_id 先汇总：渠道判定的「已收款分摊 / 券 / 信用 / 欠款」都是行内求和。
-- 这个分组刻意保留：分摊基本 1:1（UAT 头文 9 月 114.7 万行 → 114.7 万组），
-- 不负责降基数，只负责把同一 token_usage 的多条分摊折成一行。
-- UAT 实测替代方案更慢：LATERAL 57s、关 nestloop 56s、抬 work_mem 73.7s，都不如本形状 24.1s。
allocs AS (
  SELECT
    bca.token_usage_id,
    SUM(bca.amount_usd) AS alloc_total,
    SUM(bca.recognized_revenue_usd) FILTER (
      WHERE NOT (bca.source IN ('ENTERPRISE_CREDIT', 'NEGATIVE_BALANCE') AND bca.balance_grant_id IS NULL)
    ) AS collected,
    SUM(bca.bonus_consumed_usd) FILTER (
      WHERE NOT (bca.source IN ('ENTERPRISE_CREDIT', 'NEGATIVE_BALANCE') AND bca.balance_grant_id IS NULL)
    ) AS bonus,
    SUM(bca.approved_credit_usd) FILTER (
      WHERE bca.source = 'ENTERPRISE_CREDIT' AND bca.balance_grant_id IS NULL
        AND bca.funding_classification_complete
    ) AS credit_alloc,
    SUM(CASE WHEN bca.funding_classification_complete THEN bca.unapproved_debt_usd ELSE bca.amount_usd END) FILTER (
      WHERE bca.source IN ('ENTERPRISE_CREDIT', 'NEGATIVE_BALANCE') AND bca.balance_grant_id IS NULL
    ) AS debt_alloc,
    COALESCE(bool_or(NOT bca.funding_classification_complete) FILTER (
      WHERE bca.source IN ('ENTERPRISE_CREDIT', 'NEGATIVE_BALANCE') AND bca.balance_grant_id IS NULL
    ), FALSE) AS debt_unclassified
  FROM balance_consumption_allocations bca
  JOIN scoped s ON s.id = bca.token_usage_id
  -- 账号是分摊表索引前导列；分摊的 billing_account_id 与所属 token_usage 账号恒等（UAT 实测 0 例外）。
  -- 不能改按 bca.created_at 过滤：UAT 有 12 条分摊的 created_at 落在用量窗口外。
  WHERE bca.billing_account_id = ${input.accountId}
  GROUP BY bca.token_usage_id
),
-- 分量展开：input 走 clamped 常规输入，cache read/write 用原值（与 expandUsageDetailParts 一致）。
parts AS (
  SELECT
    s.*,
    GREATEST(
      s.prompt_tokens
        - LEAST(s.cached_tokens, s.prompt_tokens)
        - LEAST(s.cache_write_tokens, GREATEST(s.prompt_tokens - LEAST(s.cached_tokens, s.prompt_tokens), 0)),
      0
    ) AS input_tokens,
    CASE
      WHEN s.prompt_tokens = 0 AND s.cached_tokens = 0
        AND s.cache_write_tokens = 0 AND s.completion_tokens = 0
      THEN s.total_tokens
      ELSE 0
    END AS fallback_tokens,
    CASE
      WHEN s.prompt_tokens = 0 AND s.cached_tokens = 0
        AND s.cache_write_tokens = 0 AND s.completion_tokens = 0
      THEN 1
      ELSE 0
    END AS fallback_rows
  FROM scoped s
),
rated AS (
  SELECT
    p.*,
    COALESCE(a.alloc_total, 0) AS alloc_total,
    COALESCE(a.collected, 0) AS collected,
    COALESCE(a.bonus, 0) AS bonus,
    COALESCE(a.credit_alloc, 0) AS credit_alloc,
    COALESCE(a.debt_alloc, 0) AS debt_alloc,
    COALESCE(a.debt_unclassified, FALSE) AS debt_unclassified
  FROM parts p
  LEFT JOIN allocs a ON a.token_usage_id = p.id
),
-- 总消耗：分摊合计 > 0 优先；否则回退存量 charge；再否则按策略回退 |cost|。
charged AS (
  SELECT
    r.*,
    CASE
      WHEN r.alloc_total > 0 THEN r.alloc_total
      WHEN r.stored_charge > 0 THEN r.stored_charge
      WHEN r.charge_policy IS NULL OR r.charge_policy IN ('usage_charge', 'legacy_cost_usd')
        THEN ABS(r.cost_usd)
      ELSE 0
    END AS total_amount
  FROM rated r
),
funded AS (
  SELECT
    c.*,
    (
      c.snapshot_complete
      AND (c.snapshot_collected + c.snapshot_approved + c.snapshot_debt) = c.total_amount
      AND (c.alloc_total <= 0 OR c.debt_unclassified)
    ) AS use_snapshot
  FROM charged c
),
-- 渠道拆分：与 financeApiUsageChannelUsd 的 payment/voucher/credit/debt 分支一一对应。
split AS (
  SELECT
    f.*,
    CASE
      WHEN f.alloc_total > 0 THEN f.collected
      WHEN f.use_snapshot THEN f.snapshot_collected
      ELSE f.total_amount
    END AS payment_base,
    CASE WHEN f.alloc_total > 0 THEN f.bonus ELSE 0 END AS voucher_amount,
    CASE WHEN f.use_snapshot THEN f.snapshot_approved ELSE f.credit_alloc END AS credit_base,
    CASE WHEN f.use_snapshot THEN f.snapshot_debt ELSE f.debt_alloc END AS debt_amount,
    GREATEST(
      (CASE WHEN f.alloc_total > 0 THEN f.bonus ELSE 0 END)
        + (CASE WHEN f.alloc_total > 0 THEN f.collected WHEN f.use_snapshot THEN f.snapshot_collected ELSE f.total_amount END)
        + (CASE WHEN f.use_snapshot THEN f.snapshot_approved ELSE f.credit_alloc END)
        + (CASE WHEN f.use_snapshot THEN f.snapshot_debt ELSE f.debt_alloc END)
        - f.total_amount,
      0
    ) AS excess_amount
  FROM funded f
),
-- 待付款残差勾稽：溢出先削信用再削本金（与 splitUsageChannels 一致）。
-- 显式收窄输出：聚合输入只保留分组键 + 6 个金额 + 正负标记，避免把整行宽记录带进排序。
-- 注意：settled 收窄并不能消除 CTE 物化 —— scoped 仍会被物化，实测 UAT 头文 9 月
-- 单次导出写约 783MB 临时文件（scoped 237MB + allocs Hash 748MB）。并发下载叠加时
-- 需要关注 RDS 的 pgsql_tmp 容量。
settled AS (
  SELECT
    sp.usage_day,
    sp.tenant_id,
    sp.model,
    sp.call_type,
    sp.input_price_usd_per_m,
    sp.cached_input_price_usd_per_m,
    sp.cache_write_price_usd_per_m,
    sp.output_price_usd_per_m,
    sp.unit_price_usd,
    sp.multiplier,
    sp.input_tokens,
    sp.cached_tokens,
    sp.cache_write_tokens,
    sp.completion_tokens,
    sp.fallback_tokens,
    sp.fallback_rows,
    (sp.total_amount > 0) AS is_positive,
    sp.total_amount,
    (sp.credit_base - LEAST(sp.credit_base, sp.excess_amount)) AS credit_amount,
    sp.debt_amount,
    sp.voucher_amount,
    GREATEST(
      sp.payment_base - (sp.excess_amount - LEAST(sp.credit_base, sp.excess_amount)),
      0
    ) AS paid_amount,
    GREATEST(sp.total_amount - (sp.voucher_amount + sp.payment_base + sp.credit_base + sp.debt_amount), 0)
      AS pending_amount
  FROM split sp
)
SELECT
  s.usage_day::text AS day,
  s.tenant_id,
  s.model,
  s.call_type,
  s.input_price_usd_per_m::text AS input_price,
  s.cached_input_price_usd_per_m::text AS cached_price,
  s.cache_write_price_usd_per_m::text AS cache_write_price,
  s.output_price_usd_per_m::text AS output_price,
  s.unit_price_usd::text AS unit_price,
  s.multiplier,
  SUM(s.input_tokens)::text AS input_tokens,
  SUM(s.cached_tokens)::text AS cache_read_tokens,
  SUM(s.cache_write_tokens)::text AS cache_write_tokens,
  SUM(s.completion_tokens)::text AS output_tokens,
  SUM(CASE WHEN s.is_positive THEN s.input_tokens ELSE 0 END)::text AS input_positive_tokens,
  SUM(CASE WHEN s.is_positive THEN s.cached_tokens ELSE 0 END)::text AS cache_read_positive_tokens,
  SUM(CASE WHEN s.is_positive THEN s.cache_write_tokens ELSE 0 END)::text AS cache_write_positive_tokens,
  SUM(CASE WHEN s.is_positive THEN s.completion_tokens ELSE 0 END)::text AS output_positive_tokens,
  SUM(s.fallback_tokens)::text AS fallback_tokens,
  SUM(CASE WHEN s.is_positive THEN s.fallback_tokens ELSE 0 END)::text AS fallback_positive_tokens,
  SUM(s.fallback_rows)::text AS fallback_rows,
  SUM(s.total_amount)::text AS total_amount,
  SUM(s.credit_amount)::text AS credit_amount,
  SUM(s.debt_amount)::text AS debt_amount,
  SUM(s.voucher_amount)::text AS voucher_amount,
  SUM(s.paid_amount)::text AS paid_amount,
  SUM(s.pending_amount)::text AS pending_amount,
  SUM(CASE WHEN s.is_positive THEN s.total_amount ELSE 0 END)::text AS positive_discounted_amount
FROM settled s
GROUP BY
  s.usage_day, s.tenant_id, s.model, s.call_type,
  s.input_price_usd_per_m, s.cached_input_price_usd_per_m,
  s.cache_write_price_usd_per_m, s.output_price_usd_per_m,
  s.unit_price_usd, s.multiplier
ORDER BY s.usage_day, s.tenant_id, s.model, s.call_type
`;
}
