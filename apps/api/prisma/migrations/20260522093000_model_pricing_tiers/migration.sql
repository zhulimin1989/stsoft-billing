-- Support multiple context-dependent prices for the same model.

CREATE TABLE IF NOT EXISTS "model_pricing_tiers" (
  "id" TEXT NOT NULL,
  "model_pricing_id" TEXT NOT NULL,
  "tier_key" TEXT NOT NULL,
  "display_name" TEXT,
  "min_input_tokens" INTEGER NOT NULL DEFAULT 0,
  "max_input_tokens_exclusive" INTEGER,
  "input_price_per_m_token" DECIMAL(18,8) NOT NULL,
  "output_price_per_m_token" DECIMAL(18,8) NOT NULL,
  "cached_input_price" DECIMAL(18,8),
  "cache_write_price" DECIMAL(18,8),
  "currency" TEXT NOT NULL DEFAULT 'USD',
  "raw_condition" TEXT,
  "source" TEXT,
  "priority" INTEGER NOT NULL DEFAULT 0,
  "is_active" BOOLEAN NOT NULL DEFAULT TRUE,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "model_pricing_tiers_pkey" PRIMARY KEY ("id")
);

DO $$
BEGIN
  ALTER TABLE "model_pricing_tiers"
    ADD CONSTRAINT "model_pricing_tiers_model_pricing_id_fkey"
    FOREIGN KEY ("model_pricing_id") REFERENCES "model_pricing"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;
EXCEPTION
  WHEN duplicate_object THEN NULL;
END $$;

CREATE UNIQUE INDEX IF NOT EXISTS "model_pricing_tiers_model_pricing_id_tier_key_key"
  ON "model_pricing_tiers"("model_pricing_id", "tier_key");

CREATE INDEX IF NOT EXISTS "model_pricing_tiers_model_pricing_id_is_active_idx"
  ON "model_pricing_tiers"("model_pricing_id", "is_active");

CREATE INDEX IF NOT EXISTS "model_pricing_tiers_model_pricing_id_min_input_tokens_idx"
  ON "model_pricing_tiers"("model_pricing_id", "min_input_tokens");

ALTER TABLE "token_usage"
  ADD COLUMN IF NOT EXISTS "pricing_tier_key" TEXT;

INSERT INTO "model_pricing_tiers" (
  "id",
  "model_pricing_id",
  "tier_key",
  "display_name",
  "min_input_tokens",
  "max_input_tokens_exclusive",
  "input_price_per_m_token",
  "output_price_per_m_token",
  "cached_input_price",
  "cache_write_price",
  "currency",
  "raw_condition",
  "source",
  "priority",
  "is_active",
  "created_at",
  "updated_at"
)
SELECT
  md5(mp."id" || ':default'),
  mp."id",
  'default',
  'Default',
  0,
  CASE
    WHEN mp."long_context_threshold" IS NOT NULL
      AND (
        mp."long_context_input_price_cents" IS NOT NULL
        OR mp."long_context_output_price_cents" IS NOT NULL
      )
    THEN mp."long_context_threshold"
    ELSE NULL
  END,
  mp."input_price_per_m_token",
  mp."output_price_per_m_token",
  mp."cached_input_price_cents",
  COALESCE(mp."cache_write_5min_price_cents", mp."cache_write_1h_price_cents"),
  'USD',
  'default',
  COALESCE(mp."pricing_source", 'migration'),
  0,
  mp."is_active",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "model_pricing" mp
ON CONFLICT ("model_pricing_id", "tier_key") DO NOTHING;

INSERT INTO "model_pricing_tiers" (
  "id",
  "model_pricing_id",
  "tier_key",
  "display_name",
  "min_input_tokens",
  "max_input_tokens_exclusive",
  "input_price_per_m_token",
  "output_price_per_m_token",
  "cached_input_price",
  "cache_write_price",
  "currency",
  "raw_condition",
  "source",
  "priority",
  "is_active",
  "created_at",
  "updated_at"
)
SELECT
  md5(mp."id" || ':long_context'),
  mp."id",
  'long_context',
  'Long context',
  mp."long_context_threshold",
  NULL,
  COALESCE(mp."long_context_input_price_cents", mp."input_price_per_m_token"),
  COALESCE(mp."long_context_output_price_cents", mp."output_price_per_m_token"),
  mp."cached_input_price_cents",
  COALESCE(mp."cache_write_5min_price_cents", mp."cache_write_1h_price_cents"),
  'USD',
  'input_tokens >= long_context_threshold',
  COALESCE(mp."pricing_source", 'migration'),
  10,
  mp."is_active",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "model_pricing" mp
WHERE mp."long_context_threshold" IS NOT NULL
  AND (
    mp."long_context_input_price_cents" IS NOT NULL
    OR mp."long_context_output_price_cents" IS NOT NULL
  )
ON CONFLICT ("model_pricing_id", "tier_key") DO NOTHING;
