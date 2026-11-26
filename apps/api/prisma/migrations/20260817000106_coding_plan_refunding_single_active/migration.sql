CREATE UNIQUE INDEX "uniq_active_self_coding_plan_refunding_tmp"
  ON "coding_plan_entitlements" ("tenant_id", "product_id")
  WHERE "status" IN ('ACTIVE', 'REFUNDING')
    AND "fulfillment_mode" = 'platform_model_package';

DROP INDEX IF EXISTS "uniq_active_self_coding_plan";

ALTER INDEX "uniq_active_self_coding_plan_refunding_tmp"
  RENAME TO "uniq_active_self_coding_plan";
