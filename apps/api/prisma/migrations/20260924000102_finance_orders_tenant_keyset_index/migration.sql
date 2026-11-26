-- Standalone because CREATE INDEX CONCURRENTLY cannot run in a transaction.
CREATE INDEX CONCURRENTLY "orders_tenant_created_id_idx"
  ON "orders"("tenant_id", "created_at", "id");
