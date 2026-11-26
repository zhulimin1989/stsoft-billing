-- One non-transactional statement. Do not add IF NOT EXISTS: a failed
-- concurrent build must remain observable and be explicitly recovered.
CREATE INDEX CONCURRENTLY "billing_accounts_balance_grant_ledger_status_idx"
  ON "billing_accounts"("balance_grant_ledger_status");
