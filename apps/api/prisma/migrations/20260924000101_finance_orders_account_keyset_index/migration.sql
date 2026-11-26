-- Standalone because CREATE INDEX CONCURRENTLY cannot run in a transaction.
CREATE INDEX CONCURRENTLY "orders_account_created_id_idx"
  ON "orders"("billing_account_id", "created_at", "id");
