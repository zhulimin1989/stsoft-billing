-- Standalone because CREATE INDEX CONCURRENTLY cannot run in a transaction.
CREATE INDEX CONCURRENTLY "balance_grants_account_created_id_idx"
  ON "balance_grants"("billing_account_id", "created_at", "id");
