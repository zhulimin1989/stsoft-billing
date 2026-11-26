-- captureFinancialNow reads the greatest database-created timestamp from the
-- positive (online) ledger epoch after holding the wallet/account locks.  A
-- partial index keeps that per-mutation monotonic-clock lookup O(log n) while
-- deliberately excluding untrusted repaired negative legacy sequences.
CREATE INDEX CONCURRENTLY
  "balance_transactions_account_online_created_idx"
  ON "balance_transactions"("billing_account_id", "created_at" DESC)
  WHERE "ledger_sequence" > 0;
