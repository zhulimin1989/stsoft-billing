-- 基础模型定价的**结算取价窗口**：让已发生但尚未结算的事件按 occurred_at 取到"当时的价"。
--
-- 为什么需要它（2026-09-07 国内 prod 实际事故）：
--   13:31:52 把 model_pricing.deepseek-v4-flash 的 is_active 置为 false（改代号切 -0731）。
--   该客户当时有 9,622 笔请求还堵在 Kafka 里没结算（当天结算滞后已恶化到 146 分钟），
--   occurred_at 全在 11:02–13:31:24，最后一笔比下架早 28 秒。
--   结算链路本来是按事件发生时刻取价的（usage-billing-strategy 传 effectiveAt = occurred_at，
--   payg_model_pricing_policies 有 starts_at/ends_at），但**基础价这一层没有时间维度**：
--   getPricing 只 `where { model_name, is_active: true }`。于是这批历史事件全部报不出价 ⇒
--   形不成 settlement anchor ⇒ QUARANTINED(settlement_anchor_missing) ⇒ 每笔挂一行
--   settlement_policy_review 限制行 ⇒ 客户 Key 被 402 封了约 4 小时。
--
-- 与 is_active 的分工（**不要把下架改成只写 ends_at**）：
--   is_active 是**数据面**开关 —— publisher 的 runtimeActiveModelNames / productModelAvailability
--   投影都按它剔除网关目录。若下架只写 ends_at 而留着 is_active=true，网关目录不会删、
--   客户还能继续调，而结算按 now 取价又已过期 ⇒ 会持续制造新的隔离事件。
--   所以下架动作是**两者同写**：is_active=false + ends_at=now()。
--   新请求立刻拿网关的 400 model_not_found，积压的历史事件仍能按 occurred_at 取价。
--
-- 半开区间语义 [starts_at, ends_at)，命名与类型沿用 payg_model_pricing_policies
-- （见 20260622000100_provider_cost_and_temporal_payg）：起点非空 + 默认 NOW()，终点可空。
--
-- 不建新索引：model_name 已有 UNIQUE 约束（model_pricing_model_name_key），
-- 结算谓词 `model_name = ? AND starts_at <= ? AND (ends_at IS NULL OR ends_at > ?)`
-- 正好走它，再加复合索引只是多一次 ACCESS EXCLUSIVE。
--
-- ⚠️ 锁等待上限：ALTER TABLE 取 ACCESS EXCLUSIVE，动作本身是元数据级（低频小表加可空列，
-- 即时完成，无需 NOT VALID/VALIDATE 两步），但**等锁**时间无上限 —— 一旦排到锁队列队首，
-- 后续所有对该表的新查询都会排在它后面。宁可迁移失败重试，也别把定价表卡住。

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

-- 1) expand：两列都先可空，存量行不受影响
ALTER TABLE "model_pricing"
  ADD COLUMN IF NOT EXISTS "starts_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "ends_at" TIMESTAMP(3);

-- 2) backfill 起点：存量行一律视作"自创建起有效"
UPDATE "model_pricing"
SET "starts_at" = COALESCE("starts_at", "created_at", NOW())
WHERE "starts_at" IS NULL;

-- 3) backfill 终点：**已经下架的行必须把窗口封闭**。
--    取价谓词不再看 is_active（否则历史事件照样取不到价），所以 is_active=false 且
--    ends_at 为空的存量行会退化成"永远可取价"。updated_at 是最接近其下架时刻的可得值。
--    对本次事故的 deepseek-v4-flash 而言 updated_at = 13:31:52，而那 9,622 笔的
--    occurred_at ≤ 13:31:24 ⇒ 它们在本迁移之后可以直接 reconcile-settle 收口，
--    不必先把 is_active 改回 true。
UPDATE "model_pricing"
SET "ends_at" = "updated_at"
WHERE "is_active" = false
  AND "ends_at" IS NULL;

-- 4) contract：起点收成 NOT NULL + DEFAULT NOW()
ALTER TABLE "model_pricing"
  ALTER COLUMN "starts_at" SET NOT NULL,
  ALTER COLUMN "starts_at" SET DEFAULT NOW();

COMMIT;
