-- Standalone because CREATE INDEX CONCURRENTLY cannot run in a transaction.
CREATE INDEX CONCURRENTLY "balance_transactions_user_created_id_idx"
  ON "balance_transactions"("user_id", "created_at", "id");
