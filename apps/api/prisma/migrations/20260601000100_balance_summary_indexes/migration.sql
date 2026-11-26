CREATE INDEX IF NOT EXISTS "balance_transactions_billing_account_id_type_created_at_idx"
  ON "balance_transactions"("billing_account_id", "type", "created_at");

CREATE INDEX IF NOT EXISTS "balance_transactions_tenant_id_type_created_at_idx"
  ON "balance_transactions"("tenant_id", "type", "created_at");
