-- Standalone because CREATE INDEX CONCURRENTLY cannot run in a transaction.
CREATE INDEX CONCURRENTLY "orders_user_created_id_idx"
  ON "orders"("user_id", "created_at", "id");
