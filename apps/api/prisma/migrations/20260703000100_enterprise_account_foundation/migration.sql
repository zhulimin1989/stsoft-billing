ALTER TABLE "billing_accounts" ADD COLUMN IF NOT EXISTS "enterprise_name" TEXT;
ALTER TABLE "billing_accounts" ADD COLUMN IF NOT EXISTS "uscc" TEXT;
ALTER TABLE "billing_accounts" ADD COLUMN IF NOT EXISTS "verification_id" TEXT;
ALTER TABLE "billing_accounts" ADD COLUMN IF NOT EXISTS "verified_at" TIMESTAMP(3);
CREATE INDEX IF NOT EXISTS "billing_accounts_verification_id_idx" ON "billing_accounts"("verification_id");
CREATE INDEX IF NOT EXISTS "billing_accounts_uscc_idx" ON "billing_accounts"("uscc");
-- M0 已定(§10.8-①):加 partial unique,一家公司一个 active enterprise account。
-- 存量安全:uscc 为新增列、现有行全 NULL,partial 条件不覆盖 NULL,建索引瞬时不锁表。
CREATE UNIQUE INDEX IF NOT EXISTS "billing_accounts_uscc_active_uk"
  ON "billing_accounts"("uscc")
  WHERE "deleted_at" IS NULL AND "uscc" IS NOT NULL;
