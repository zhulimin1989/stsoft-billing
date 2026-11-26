-- Intentionally a single non-transactional statement. A failed concurrent
-- build may leave an invalid index; operators must drop that exact invalid
-- index and mark only this migration rolled back before retrying.
CREATE UNIQUE INDEX CONCURRENTLY
  "balance_consumption_allocations_account_ledger_sequence_key"
  ON "balance_consumption_allocations"("billing_account_id", "ledger_sequence");
