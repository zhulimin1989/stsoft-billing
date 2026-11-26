-- Standalone because CREATE INDEX CONCURRENTLY cannot run in a transaction.
CREATE INDEX CONCURRENTLY "balance_allocations_user_created_id_idx"
  ON "balance_consumption_allocations"("user_id", "created_at", "id");
