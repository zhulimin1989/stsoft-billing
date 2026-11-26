-- Billing runtime should store identity mirrors, not authentication credentials.
-- Keep the legacy password column temporarily for old compile-time modules, but
-- remove all credential values from the billing database and make future mirror
-- inserts omit it safely.

ALTER TABLE "users"
  ADD COLUMN IF NOT EXISTS "source_updated_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "mirrored_at" TIMESTAMP(3);

ALTER TABLE "tenants"
  ADD COLUMN IF NOT EXISTS "source_updated_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "mirrored_at" TIMESTAMP(3);

UPDATE "users"
SET "password" = ''
WHERE "password" IS DISTINCT FROM '';

ALTER TABLE "users"
  ALTER COLUMN "password" SET DEFAULT '';

UPDATE "users"
SET "mirrored_at" = COALESCE("mirrored_at", "updated_at", "created_at", NOW());

UPDATE "tenants"
SET "mirrored_at" = COALESCE("mirrored_at", "updated_at", "created_at", NOW());
