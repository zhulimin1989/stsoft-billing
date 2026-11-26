-- Make billing's API key mirror lifecycle explicit. Existing keys are
-- backfilled from their current active/deleted flags.

ALTER TABLE "api_keys"
  ADD COLUMN IF NOT EXISTS "mirror_status" TEXT NOT NULL DEFAULT 'PROVISIONING',
  ADD COLUMN IF NOT EXISTS "mirror_error" TEXT,
  ADD COLUMN IF NOT EXISTS "source_updated_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "mirrored_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "activated_at" TIMESTAMP(3);

UPDATE "api_keys"
SET
  "mirror_status" = CASE
    WHEN "deleted_at" IS NOT NULL THEN 'REVOKED'
    WHEN "is_active" = true THEN 'ACTIVE'
    ELSE 'SUSPENDED'
  END,
  "mirrored_at" = COALESCE("mirrored_at", "created_at"),
  "activated_at" = CASE
    WHEN "is_active" = true THEN COALESCE("activated_at", "created_at")
    ELSE "activated_at"
  END
WHERE "mirror_status" = 'PROVISIONING';

CREATE INDEX IF NOT EXISTS "api_keys_mirror_status_idx"
  ON "api_keys"("mirror_status");
