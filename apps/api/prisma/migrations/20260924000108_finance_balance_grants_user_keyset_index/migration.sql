-- Standalone because CREATE INDEX CONCURRENTLY cannot run in a transaction.
CREATE INDEX CONCURRENTLY "balance_grants_user_created_id_idx"
  ON "balance_grants"("user_id", "created_at", "id");
