-- Persist the exact nested UsageEvent v2 evidence contract emitted by Gateway.
-- The earlier flat draft columns remain nullable for historical audit only;
-- settlement decisions use these signed nested-contract projections together
-- with the immutable raw_evidence hash.
ALTER TABLE "gateway_usage_evidences"
  ADD COLUMN "provider_credential_ref" TEXT,
  ADD COLUMN "upstream_response_id" TEXT,
  ADD COLUMN "usage_evidence_source" TEXT,
  ADD COLUMN "usage_evidence_status" TEXT,
  ADD COLUMN "usage_evidence_protocol" TEXT,
  ADD COLUMN "terminal_frame_seen" BOOLEAN,
  ADD COLUMN "provider_reconciliation_required" BOOLEAN;

CREATE INDEX "gateway_usage_evidences_upstream_response_created_idx"
  ON "gateway_usage_evidences"("upstream_response_id", "created_at");
