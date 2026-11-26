-- One non-transactional statement. Do not add IF NOT EXISTS: a failed
-- concurrent build must remain observable and be explicitly recovered.
CREATE INDEX CONCURRENTLY "gateway_billing_events_funding_created_idx"
  ON "gateway_billing_events"("funding_outcome", "created_at");
