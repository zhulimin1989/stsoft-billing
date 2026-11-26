-- One non-transactional statement. Do not add IF NOT EXISTS: a failed
-- concurrent build must remain observable and be explicitly recovered.
CREATE INDEX CONCURRENTLY "gateway_billing_events_evidence_reconciliation_created_idx"
  ON "gateway_billing_events"("evidence_verdict", "reconciliation_status", "created_at");
