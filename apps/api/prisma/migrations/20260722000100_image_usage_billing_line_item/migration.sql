-- Persist the non-token customer billing fact on the existing one-row-per-request
-- usage detail. customer_charge_usd remains the authoritative line amount.
ALTER TABLE "token_usage"
  ADD COLUMN IF NOT EXISTS "meter" TEXT NOT NULL DEFAULT 'token',
  ADD COLUMN IF NOT EXISTS "quantity" INTEGER,
  ADD COLUMN IF NOT EXISTS "unit_price_usd" DECIMAL(18, 8),
  ADD COLUMN IF NOT EXISTS "call_type" TEXT,
  ADD COLUMN IF NOT EXISTS "upstream_model" TEXT;
