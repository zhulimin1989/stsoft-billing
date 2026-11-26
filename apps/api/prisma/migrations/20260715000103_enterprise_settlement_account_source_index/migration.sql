-- One non-transactional statement. Do not add IF NOT EXISTS: a failed
-- concurrent build must remain observable and be explicitly recovered.
CREATE INDEX CONCURRENTLY "enterprise_credit_settlements_account_source_created_idx"
  ON "enterprise_credit_settlements"("billing_account_id", "debt_source", "created_at");
