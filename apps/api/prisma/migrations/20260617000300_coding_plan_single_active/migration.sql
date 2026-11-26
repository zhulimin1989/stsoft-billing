-- F1b fix3 §2.1：单一活跃自营约束（同账号同产品 platform_model_package 至多一条 ACTIVE）。
-- advisory lock 负责并发切换语义，partial unique index 作为最终数据兜底（双保险）。
-- 判定自营以 fulfillment_mode = 'platform_model_package' 为准（≠ provider_resale，后者可并存多档）。

-- 0) 收敛已过期但 status 仍为 ACTIVE 的自营行 → EXPIRED（过期 cron 可能滞后），
--    使 partial unique 仅覆盖真正在用的 ACTIVE，与「未过期才算 current」业务口径一致。
UPDATE coding_plan_entitlements
SET status = 'EXPIRED'
WHERE status = 'ACTIVE'
  AND fulfillment_mode = 'platform_model_package'
  AND expires_at IS NOT NULL
  AND expires_at <= NOW();

-- 1) 再消解潜在历史重复：同 (tenant_id, product_id) 多条 ACTIVE 自营时，
--    保留 started_at（次序 created_at）最新一条，其余置 CANCELLED，否则唯一索引创建会失败。
WITH ranked AS (
  SELECT id,
         ROW_NUMBER() OVER (
           PARTITION BY tenant_id, product_id
           ORDER BY started_at DESC, created_at DESC
         ) AS rn
  FROM coding_plan_entitlements
  WHERE status = 'ACTIVE' AND fulfillment_mode = 'platform_model_package'
)
UPDATE coding_plan_entitlements e
SET status = 'CANCELLED', last_error = 'dedup:single-active-migration'
FROM ranked
WHERE e.id = ranked.id AND ranked.rn > 1;

-- 2) partial unique：自营至多一条 ACTIVE（Prisma schema 无法表达 PG partial unique，故用 raw SQL）。
CREATE UNIQUE INDEX "uniq_active_self_coding_plan"
  ON "coding_plan_entitlements" ("tenant_id", "product_id")
  WHERE "status" = 'ACTIVE' AND "fulfillment_mode" = 'platform_model_package';
