-- Intentionally a single non-transactional statement; do not add IF NOT
-- EXISTS because it would silently accept an invalid failed-build artifact.
CREATE UNIQUE INDEX CONCURRENTLY "balance_transactions_operation_key_key"
  ON "balance_transactions"("operation_key");
