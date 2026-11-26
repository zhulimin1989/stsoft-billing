CREATE TABLE IF NOT EXISTS "billing_account_credit_configs" (
  "billing_account_id" TEXT PRIMARY KEY,
  "limit_usd" DECIMAL(20, 12) NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'DISABLED',
  "terms_days" INTEGER,
  "effective_at" TIMESTAMP(3),
  "expires_at" TIMESTAMP(3),
  "updated_by" TEXT,
  "note" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_account_credit_configs_billing_account_id_fkey"
    FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE INDEX IF NOT EXISTS "billing_account_credit_configs_status_idx"
  ON "billing_account_credit_configs"("status");
CREATE INDEX IF NOT EXISTS "billing_account_credit_configs_expires_at_idx"
  ON "billing_account_credit_configs"("expires_at");

CREATE TABLE IF NOT EXISTS "billing_account_credit_events" (
  "id" TEXT PRIMARY KEY,
  "billing_account_id" TEXT NOT NULL,
  "old_limit_usd" DECIMAL(20, 12),
  "new_limit_usd" DECIMAL(20, 12) NOT NULL,
  "old_status" TEXT,
  "new_status" TEXT NOT NULL,
  "old_terms_days" INTEGER,
  "new_terms_days" INTEGER,
  "old_expires_at" TIMESTAMP(3),
  "new_expires_at" TIMESTAMP(3),
  "actor_id" TEXT,
  "reason" TEXT,
  "note" TEXT,
  "idempotency_key" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "billing_account_credit_events_billing_account_id_fkey"
    FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id")
    ON DELETE CASCADE ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "billing_account_credit_events_idempotency_key_key"
  ON "billing_account_credit_events"("idempotency_key")
  WHERE "idempotency_key" IS NOT NULL;
CREATE INDEX IF NOT EXISTS "billing_account_credit_events_billing_account_id_created_at_idx"
  ON "billing_account_credit_events"("billing_account_id", "created_at");
CREATE INDEX IF NOT EXISTS "billing_account_credit_events_created_at_idx"
  ON "billing_account_credit_events"("created_at");

ALTER TABLE "balance_consumption_allocations"
  ADD COLUMN IF NOT EXISTS "source" TEXT NOT NULL DEFAULT 'BALANCE_GRANT';

ALTER TABLE "balance_consumption_allocations"
  ALTER COLUMN "balance_grant_id" DROP NOT NULL;

CREATE INDEX IF NOT EXISTS "balance_consumption_allocations_source_idx"
  ON "balance_consumption_allocations"("source");
