-- Provider resale entitlements are keyed by provider line in the current contract.
-- Drop the legacy activation_profile_id axis instead of storing provider line code in it.

UPDATE "coding_plan_provider_entitlements" e
SET
  "provider_line_id" = l."id",
  "provider_line_code" = COALESCE(e."provider_line_code", l."code")
FROM "coding_plan_provider_lines" l
WHERE e."provider_line_id" IS NULL
  AND (
    e."provider_line_code" = l."code"
    OR e."activation_profile_id" = l."code"
    OR replace(e."activation_profile_id", '_', '-') = l."code"
    OR replace(e."activation_profile_id", '-', '_') = l."code"
  );

DO $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "coding_plan_provider_entitlements"
    WHERE "provider_line_id" IS NULL
  ) THEN
    RAISE EXCEPTION 'Cannot drop activation_profile_id: coding_plan_provider_entitlements rows still lack provider_line_id';
  END IF;
END $$;

ALTER TABLE "coding_plan_provider_entitlements"
  DROP CONSTRAINT IF EXISTS "coding_plan_provider_entitlements_line_id_fkey";

DROP INDEX IF EXISTS "coding_plan_provider_entitlements_activation_profile_id_partner_order_no_key";
DROP INDEX IF EXISTS "coding_plan_provider_entitlements_activation_profile_id_status_idx";

ALTER TABLE "coding_plan_provider_entitlements"
  ALTER COLUMN "provider_line_id" SET NOT NULL;

CREATE UNIQUE INDEX "coding_plan_provider_entitlements_provider_line_id_partner_order_no_key"
  ON "coding_plan_provider_entitlements"("provider_line_id", "partner_order_no");

ALTER TABLE "coding_plan_provider_entitlements"
  ADD CONSTRAINT "coding_plan_provider_entitlements_line_id_fkey"
  FOREIGN KEY ("provider_line_id")
  REFERENCES "coding_plan_provider_lines"("id")
  ON DELETE RESTRICT
  ON UPDATE CASCADE;

ALTER TABLE "coding_plan_provider_entitlements"
  DROP COLUMN "activation_profile_id";
