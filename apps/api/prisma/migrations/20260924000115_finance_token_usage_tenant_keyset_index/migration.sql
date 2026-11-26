-- Standalone because CREATE INDEX CONCURRENTLY cannot run in a transaction.
CREATE INDEX CONCURRENTLY "token_usage_tenant_created_id_idx"
  ON "token_usage"("tenant_id", "created_at", "id");
