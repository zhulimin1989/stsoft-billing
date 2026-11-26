-- Standalone because CREATE INDEX CONCURRENTLY cannot run in a transaction.
CREATE INDEX CONCURRENTLY "token_usage_api_key_created_id_idx"
  ON "token_usage"("api_key_id", "created_at", "id");
