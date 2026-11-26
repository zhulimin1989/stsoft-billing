-- Standalone because CREATE INDEX CONCURRENTLY cannot run in a transaction.
CREATE INDEX CONCURRENTLY "balance_transactions_tenant_created_id_idx"
  ON "balance_transactions"("tenant_id", "created_at", "id");
