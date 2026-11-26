ALTER TABLE "orders"
  ADD COLUMN IF NOT EXISTS "recharge_tier_id" TEXT,
  ADD COLUMN IF NOT EXISTS "bonus_cents" INTEGER NOT NULL DEFAULT 0;

CREATE INDEX IF NOT EXISTS "orders_recharge_tier_id_idx"
  ON "orders"("recharge_tier_id");

WITH bonus_rows AS (
  SELECT
    "order_id",
    SUM(GREATEST(ROUND("amount_usd" * 100)::INTEGER, 0)) AS "bonus_cents",
    MAX(substring("description" FROM 'recharge-bonus tier:([^[:space:]]+)')) AS "tier_id"
  FROM "balance_transactions"
  WHERE "order_id" IS NOT NULL
    AND "type" = 'ADJUST'
    AND "description" LIKE 'recharge-bonus tier:%'
  GROUP BY "order_id"
)
UPDATE "orders" o
SET
  "bonus_cents" = bonus_rows."bonus_cents",
  "recharge_tier_id" = COALESCE(o."recharge_tier_id", bonus_rows."tier_id")
FROM bonus_rows
WHERE o."id" = bonus_rows."order_id"
  AND o."order_type" = 'RECHARGE'
  AND o."bonus_cents" = 0
  AND bonus_rows."bonus_cents" > 0;
