-- One non-transactional statement. Do not add IF NOT EXISTS: a failed
-- concurrent build must remain observable and be explicitly recovered.
CREATE INDEX CONCURRENTLY "enterprise_credit_settlements_balance_grant_idx"
  ON "enterprise_credit_settlements"("balance_grant_id");
