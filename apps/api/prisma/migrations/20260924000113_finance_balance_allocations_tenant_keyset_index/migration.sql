-- Standalone because CREATE INDEX CONCURRENTLY cannot run in a transaction.
CREATE INDEX CONCURRENTLY "balance_allocations_tenant_created_id_idx"
  ON "balance_consumption_allocations"("tenant_id", "created_at", "id");
