-- Intentionally a single non-transactional statement; do not add IF NOT
-- EXISTS because it would silently accept an invalid failed-build artifact.
CREATE UNIQUE INDEX CONCURRENTLY "enterprise_credit_settlements_operation_key_key"
  ON "enterprise_credit_settlements"("operation_key");
