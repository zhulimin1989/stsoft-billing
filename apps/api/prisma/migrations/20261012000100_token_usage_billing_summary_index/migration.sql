-- Standalone because CREATE INDEX CONCURRENTLY cannot run in a transaction.
-- Supports tenant/product/date-scoped billing summaries without scanning unrelated usage.
CREATE INDEX CONCURRENTLY "token_usage_tenant_product_created_id_idx"
  ON "token_usage"("tenant_id", "product_id", "created_at", "id");
