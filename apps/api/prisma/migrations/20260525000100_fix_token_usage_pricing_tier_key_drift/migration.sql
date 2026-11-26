-- Guard against production databases whose migration history drifted before
-- 20260522093000_model_pricing_tiers was applied consistently.

ALTER TABLE "token_usage"
  ADD COLUMN IF NOT EXISTS "pricing_tier_key" TEXT;
