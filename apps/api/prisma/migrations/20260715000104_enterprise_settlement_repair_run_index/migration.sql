-- One non-transactional statement. Do not add IF NOT EXISTS: a failed
-- concurrent build must remain observable and be explicitly recovered.
CREATE INDEX CONCURRENTLY "enterprise_credit_settlements_repair_run_idx"
  ON "enterprise_credit_settlements"("repair_run_id");
