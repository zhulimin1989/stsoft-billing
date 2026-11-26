-- 企业账户模型专属折扣：独立于个人用户/分群/全局模型折扣。
CREATE TABLE IF NOT EXISTS "enterprise_model_discounts" (
  "id" TEXT NOT NULL,
  "billing_account_id" TEXT NOT NULL,
  "product_id" TEXT NOT NULL,
  "model_name" TEXT NOT NULL,
  "price_multiplier" DECIMAL(10,4) NOT NULL DEFAULT 1,
  "is_active" BOOLEAN NOT NULL DEFAULT true,
  "note" TEXT NOT NULL DEFAULT '',
  "updated_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "enterprise_model_discounts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "enterprise_model_discounts_account_product_model_key"
  ON "enterprise_model_discounts"("billing_account_id", "product_id", "model_name");

CREATE INDEX IF NOT EXISTS "enterprise_model_discounts_account_product_idx"
  ON "enterprise_model_discounts"("billing_account_id", "product_id");

CREATE INDEX IF NOT EXISTS "enterprise_model_discounts_product_model_idx"
  ON "enterprise_model_discounts"("product_id", "model_name");

ALTER TABLE "enterprise_model_discounts"
  ADD CONSTRAINT "enterprise_model_discounts_billing_account_id_fkey"
  FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "enterprise_model_discounts"
  ADD CONSTRAINT "enterprise_model_discounts_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "enterprise_model_discounts"
  ADD CONSTRAINT "enterprise_model_discounts_model_name_fkey"
  FOREIGN KEY ("model_name") REFERENCES "model_pricing"("model_name")
  ON DELETE CASCADE ON UPDATE CASCADE;

-- 企业折扣已经拆到 enterprise_model_discounts；通用 usage_pricing_policies 仅保留个人账户策略。
DELETE FROM "usage_pricing_policies" WHERE "scope" = 'BILLING_ACCOUNT';

DROP INDEX IF EXISTS "usage_pricing_policies_scope_billing_account_id_idx";

ALTER TABLE "usage_pricing_policies"
  DROP CONSTRAINT IF EXISTS "usage_pricing_policies_billing_account_id_fkey";

ALTER TABLE "usage_pricing_policies"
  DROP COLUMN IF EXISTS "billing_account_id";

ALTER TYPE "UsagePricingPolicyScope" RENAME TO "UsagePricingPolicyScope_old";
CREATE TYPE "UsagePricingPolicyScope" AS ENUM ('GLOBAL', 'SEGMENT', 'USER');

ALTER TABLE "usage_pricing_policies"
  ALTER COLUMN "scope" TYPE "UsagePricingPolicyScope"
  USING ("scope"::text::"UsagePricingPolicyScope");

DROP TYPE "UsagePricingPolicyScope_old";
