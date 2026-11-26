ALTER TABLE "model_pricing"
  ADD COLUMN IF NOT EXISTS "model_type" TEXT,
  ADD COLUMN IF NOT EXISTS "pricing_unit" TEXT,
  ADD COLUMN IF NOT EXISTS "unit_price_usd" DECIMAL(18, 8),
  ADD COLUMN IF NOT EXISTS "pricing_metadata" JSONB;

