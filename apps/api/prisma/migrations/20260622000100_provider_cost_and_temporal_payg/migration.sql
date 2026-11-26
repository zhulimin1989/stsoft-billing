-- Provider cost policies and temporal PAYG model pricing.

ALTER TABLE "payg_model_pricing_policies"
  ADD COLUMN IF NOT EXISTS "starts_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "ends_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "description" TEXT NOT NULL DEFAULT '';

UPDATE "payg_model_pricing_policies"
SET "starts_at" = COALESCE("starts_at", "created_at", NOW())
WHERE "starts_at" IS NULL;

ALTER TABLE "payg_model_pricing_policies"
  ALTER COLUMN "starts_at" SET NOT NULL,
  ALTER COLUMN "starts_at" SET DEFAULT NOW();

ALTER TABLE "payg_model_pricing_policies"
  DROP CONSTRAINT IF EXISTS "payg_model_pricing_policies_product_id_model_name_key";

DROP INDEX IF EXISTS "payg_model_pricing_policies_product_id_is_active_idx";

CREATE INDEX IF NOT EXISTS "payg_policy_product_model_active_start_idx"
  ON "payg_model_pricing_policies"("product_id", "model_name", "is_active", "starts_at");

CREATE INDEX IF NOT EXISTS "payg_policy_product_active_start_idx"
  ON "payg_model_pricing_policies"("product_id", "is_active", "starts_at");

CREATE TABLE IF NOT EXISTS "provider_model_cost_policies" (
  "id" TEXT NOT NULL,
  "product_id" TEXT,
  "provider_code" TEXT NOT NULL,
  "provider_line_id" TEXT,
  "model_name" TEXT NOT NULL,
  "price_multiplier" DECIMAL(10,4) NOT NULL DEFAULT 1,
  "input_cost_usd_per_m" DECIMAL(18,8),
  "cached_input_cost_usd_per_m" DECIMAL(18,8),
  "cache_write_cost_usd_per_m" DECIMAL(18,8),
  "output_cost_usd_per_m" DECIMAL(18,8),
  "starts_at" TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "ends_at" TIMESTAMP(3),
  "priority" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "description" TEXT NOT NULL DEFAULT '',
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT NOW(),
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT NOW(),

  CONSTRAINT "provider_model_cost_policies_pkey" PRIMARY KEY ("id")
);

CREATE INDEX IF NOT EXISTS "provider_cost_provider_model_start_idx"
  ON "provider_model_cost_policies"("provider_code", "model_name", "is_active", "starts_at");

CREATE INDEX IF NOT EXISTS "provider_cost_line_model_start_idx"
  ON "provider_model_cost_policies"("provider_line_id", "model_name", "is_active", "starts_at");

CREATE INDEX IF NOT EXISTS "provider_cost_product_provider_model_start_idx"
  ON "provider_model_cost_policies"("product_id", "provider_code", "model_name", "is_active", "starts_at");

CREATE INDEX IF NOT EXISTS "provider_cost_model_start_idx"
  ON "provider_model_cost_policies"("model_name", "is_active", "starts_at");

ALTER TABLE "provider_model_cost_policies"
  ADD CONSTRAINT "provider_model_cost_policies_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "provider_model_cost_policies_provider_line_id_fkey"
    FOREIGN KEY ("provider_line_id") REFERENCES "coding_plan_provider_lines"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "token_usage"
  ADD COLUMN IF NOT EXISTS "provider_cost_policy_id" TEXT,
  ADD COLUMN IF NOT EXISTS "provider_cost_multiplier" DECIMAL(10,4),
  ADD COLUMN IF NOT EXISTS "provider_input_cost_usd_per_m" DECIMAL(18,8),
  ADD COLUMN IF NOT EXISTS "provider_cached_input_cost_usd_per_m" DECIMAL(18,8),
  ADD COLUMN IF NOT EXISTS "provider_cache_write_cost_usd_per_m" DECIMAL(18,8),
  ADD COLUMN IF NOT EXISTS "provider_output_cost_usd_per_m" DECIMAL(18,8);

CREATE INDEX IF NOT EXISTS "token_usage_provider_code_idx"
  ON "token_usage"("provider_code");

CREATE INDEX IF NOT EXISTS "token_usage_provider_cost_policy_idx"
  ON "token_usage"("provider_cost_policy_id");

ALTER TABLE "token_usage"
  ADD CONSTRAINT "token_usage_provider_cost_policy_id_fkey"
    FOREIGN KEY ("provider_cost_policy_id") REFERENCES "provider_model_cost_policies"("id") ON DELETE SET NULL ON UPDATE CASCADE;
