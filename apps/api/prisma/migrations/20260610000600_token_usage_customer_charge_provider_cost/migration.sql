ALTER TABLE "token_usage"
  ADD COLUMN "coding_plan_entitlement_id" TEXT,
  ADD COLUMN "provider_entitlement_id" TEXT,
  ADD COLUMN "customer_charge_policy" TEXT NOT NULL DEFAULT 'usage_charge',
  ADD COLUMN "customer_charge_usd" DECIMAL(20, 12) NOT NULL DEFAULT 0,
  ADD COLUMN "provider_cost_estimate_usd" DECIMAL(20, 12);

UPDATE "token_usage"
SET "customer_charge_usd" = "cost_usd"
WHERE "customer_charge_usd" = 0;

CREATE INDEX "token_usage_coding_plan_entitlement_id_idx"
  ON "token_usage"("coding_plan_entitlement_id");

CREATE INDEX "token_usage_provider_entitlement_id_idx"
  ON "token_usage"("provider_entitlement_id");

ALTER TABLE "token_usage"
  ADD CONSTRAINT "token_usage_coding_plan_entitlement_id_fkey"
  FOREIGN KEY ("coding_plan_entitlement_id")
  REFERENCES "coding_plan_entitlements"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;

ALTER TABLE "token_usage"
  ADD CONSTRAINT "token_usage_provider_entitlement_id_fkey"
  FOREIGN KEY ("provider_entitlement_id")
  REFERENCES "coding_plan_provider_entitlements"("id")
  ON DELETE SET NULL
  ON UPDATE CASCADE;
