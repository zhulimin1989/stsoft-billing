-- Non-transactional by design: this table is hot and may already be large.
-- New rows receive globally unique positive values; reconciliation assigns a
-- deterministic, account-local negative prefix before promotion.
CREATE UNIQUE INDEX CONCURRENTLY
  "balance_transactions_account_ledger_sequence_key"
  ON "balance_transactions"("billing_account_id", "ledger_sequence");
