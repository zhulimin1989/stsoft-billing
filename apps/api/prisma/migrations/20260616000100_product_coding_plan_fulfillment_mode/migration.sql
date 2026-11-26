-- Distinguish self-operated CodingPlan products from provider-resale products at the product boundary.
ALTER TABLE "products"
  ADD COLUMN "coding_plan_fulfillment_mode" "CodingPlanFulfillmentMode";

UPDATE "products" AS p
SET "coding_plan_fulfillment_mode" = CASE
  WHEN EXISTS (
    SELECT 1
    FROM "plans" AS pl
    WHERE pl."product_id" = p."id"
      AND pl."deleted_at" IS NULL
      AND pl."features" ~* '(^|[^a-z0-9_])provider_resale(:|[^a-z0-9_]|$)'
  ) THEN 'provider_resale'::"CodingPlanFulfillmentMode"
  ELSE 'platform_model_package'::"CodingPlanFulfillmentMode"
END
WHERE p."billing_mode" = 'CODING_PLAN'
  AND p."deleted_at" IS NULL;

CREATE INDEX "products_billing_mode_coding_fulfillment_active_deleted_idx"
  ON "products"("billing_mode", "coding_plan_fulfillment_mode", "is_active", "deleted_at");
