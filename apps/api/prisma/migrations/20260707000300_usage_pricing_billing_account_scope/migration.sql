ALTER TYPE "UsagePricingPolicyScope" ADD VALUE IF NOT EXISTS 'BILLING_ACCOUNT';

ALTER TABLE "usage_pricing_policies"
  ADD COLUMN IF NOT EXISTS "billing_account_id" TEXT;

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'usage_pricing_policies_billing_account_id_fkey'
  ) THEN
    ALTER TABLE "usage_pricing_policies"
      ADD CONSTRAINT "usage_pricing_policies_billing_account_id_fkey"
      FOREIGN KEY ("billing_account_id")
      REFERENCES "billing_accounts"("id")
      ON DELETE CASCADE
      ON UPDATE CASCADE;
  END IF;
END $$;

CREATE INDEX IF NOT EXISTS "usage_pricing_policies_scope_billing_account_id_idx"
  ON "usage_pricing_policies"("scope", "billing_account_id");
