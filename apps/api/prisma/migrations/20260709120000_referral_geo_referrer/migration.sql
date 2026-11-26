-- 邀请裂变访客画像:被邀请人地理位置(country/city)+ 访问来源(referrer)。
-- 幂等加列,兼容已物化的环境(对齐 20260629000100_referral_attribution_utm 写法)。
ALTER TABLE "referral_redemptions"
  ADD COLUMN IF NOT EXISTS "country"  TEXT,
  ADD COLUMN IF NOT EXISTS "city"     TEXT,
  ADD COLUMN IF NOT EXISTS "referrer" TEXT;
