import { PrismaClient } from '@prisma/client';

const prisma = new PrismaClient();
const ACCOUNT = '6ad5ab22-add8-48d4-87f8-295781d4ca8d';
const start = new Date('2026-09-30T16:00:00.000Z');
const end = new Date('2026-10-31T16:00:00.000Z');

async function main() {
  const rows = await prisma.$queryRawUnsafe<Array<Record<string, unknown>>>(`
    WITH scoped AS (
      SELECT tu.id, tu.total_tokens, tu.prompt_tokens, tu.cached_input_tokens,
             tu.cache_write_input_tokens, tu.completion_tokens,
             tu.customer_charge_usd, tu.cost_usd, tu.customer_charge_policy
      FROM token_usage tu
      JOIN tenants t ON t.id = tu.tenant_id
      WHERE t.billing_account_id = $1::text
        AND tu.created_at >= $2::timestamptz AND tu.created_at < $3::timestamptz
    ),
    allocs AS (
      SELECT bca.token_usage_id, COALESCE(SUM(bca.amount_usd),0) AS allocated_charge
      FROM balance_consumption_allocations bca
      JOIN scoped s ON s.id = bca.token_usage_id
      GROUP BY bca.token_usage_id
    ),
    x AS (
      SELECT
        GREATEST(COALESCE(s.prompt_tokens,0),0) AS prompt,
        GREATEST(COALESCE(s.cached_input_tokens,0),0) AS cache_read,
        GREATEST(COALESCE(s.cache_write_input_tokens,0),0) AS cache_write,
        GREATEST(COALESCE(s.completion_tokens,0),0) AS output,
        GREATEST(COALESCE(s.total_tokens,0),0) AS total_tokens,
        CASE
          WHEN COALESCE(a.allocated_charge,0) > 0 THEN a.allocated_charge
          WHEN COALESCE(s.customer_charge_usd,0) > 0 THEN s.customer_charge_usd
          WHEN s.customer_charge_policy IS NULL OR s.customer_charge_policy IN ('usage_charge','legacy_cost_usd')
            THEN ABS(COALESCE(s.cost_usd,0))
          ELSE 0
        END AS discounted
      FROM scoped s LEFT JOIN allocs a ON a.token_usage_id = s.id
    ),
    p AS (
      SELECT *,
        GREATEST(prompt - LEAST(cache_read,prompt) - LEAST(cache_write, GREATEST(prompt - LEAST(cache_read,prompt),0)), 0) AS input_tokens,
        ROUND(discounted,12) AS d12
      FROM x
    )
    SELECT
      COUNT(*)::bigint AS n,
      SUM(total_tokens)::bigint AS sum_total,
      SUM(input_tokens + cache_read + cache_write + output)::bigint AS sum_parts,
      SUM(CASE WHEN d12 > 0 THEN total_tokens ELSE 0 END)::bigint AS sum_total_pos,
      SUM(CASE WHEN d12 > 0 THEN input_tokens + cache_read + cache_write + output ELSE 0 END)::bigint AS sum_parts_pos,
      SUM(CASE WHEN d12 <= 0 THEN total_tokens ELSE 0 END)::bigint AS sum_total_zero,
      SUM(CASE WHEN d12 <= 0 THEN input_tokens + cache_read + cache_write + output ELSE 0 END)::bigint AS sum_parts_zero,
      COUNT(*) FILTER (WHERE (input_tokens + cache_read + cache_write + output) <> total_tokens)::bigint AS n_parts_ne_total,
      COUNT(*) FILTER (WHERE d12 > 0 AND (input_tokens + cache_read + cache_write + output) <> total_tokens)::bigint AS n_pos_ne
    FROM p
  `, ACCOUNT, start, end);
  console.log(JSON.stringify(rows, (_k, v) => (typeof v === 'bigint' ? Number(v) : v), 2));
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
