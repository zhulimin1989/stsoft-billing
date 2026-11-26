-- Enforce the customer entitlement -> provider entitlement link.

UPDATE "coding_plan_entitlements" cpe
SET "provider_entitlement_id" = NULL
WHERE cpe."provider_entitlement_id" IS NOT NULL
  AND NOT EXISTS (
    SELECT 1
    FROM "coding_plan_provider_entitlements" cppe
    WHERE cppe."id" = cpe."provider_entitlement_id"
  );

ALTER TABLE "coding_plan_entitlements"
  ADD CONSTRAINT "coding_plan_entitlements_provider_entitlement_id_fkey"
  FOREIGN KEY ("provider_entitlement_id")
  REFERENCES "coding_plan_provider_entitlements"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
