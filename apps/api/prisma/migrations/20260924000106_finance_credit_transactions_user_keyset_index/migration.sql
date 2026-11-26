-- Standalone because CREATE INDEX CONCURRENTLY cannot run in a transaction.
CREATE INDEX CONCURRENTLY "credit_transactions_user_created_id_idx"
  ON "credit_transactions"("user_id", "created_at", "id");
