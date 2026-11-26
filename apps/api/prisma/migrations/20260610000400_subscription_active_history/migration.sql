-- UserSubscription becomes a period/history table. Keep only one ACTIVE row per
-- tenant/product while allowing expired and cancelled historical periods.

ALTER TABLE "user_subscriptions"
  ADD COLUMN IF NOT EXISTS "ended_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "termination_reason" TEXT;

WITH ranked_active AS (
  SELECT
    "id",
    row_number() OVER (
      PARTITION BY "tenant_id", "product_id"
      ORDER BY "started_at" DESC, "created_at" DESC, "id" DESC
    ) AS row_number
  FROM "user_subscriptions"
  WHERE "status" = 'ACTIVE'
)
UPDATE "user_subscriptions" AS subscription
SET
  "status" = 'EXPIRED',
  "ended_at" = COALESCE(subscription."ended_at", NOW()),
  "termination_reason" = COALESCE(subscription."termination_reason", 'deduplicated_before_active_unique_index')
FROM ranked_active
WHERE subscription."id" = ranked_active."id"
  AND ranked_active.row_number > 1;

ALTER TABLE "user_subscriptions"
  DROP CONSTRAINT IF EXISTS "user_subscriptions_tenant_id_product_id_key";

CREATE UNIQUE INDEX IF NOT EXISTS "user_subscriptions_active_tenant_product_unique"
  ON "user_subscriptions" ("tenant_id", "product_id")
  WHERE "status" = 'ACTIVE';

CREATE INDEX IF NOT EXISTS "user_subscriptions_tenant_product_status_idx"
  ON "user_subscriptions" ("tenant_id", "product_id", "status");
