-- Freeze the financial subject and entitlement at first Gateway receipt. No
-- historical row is backfilled: missing historical anchors must fail closed.
CREATE TABLE "gateway_usage_settlement_anchors" (
  "id" TEXT NOT NULL,
  "gateway_billing_event_id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "api_key_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "billing_account_id" TEXT NOT NULL,
  "product_id" TEXT NOT NULL,
  "product_slug" TEXT NOT NULL,
  "billing_unit" TEXT NOT NULL,
  "coding_plan_entitlement_id" TEXT,
  "subscription_id" TEXT,
  "plan_id" TEXT,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "first_received_at" TIMESTAMP(3) NOT NULL,
  "pricing_hash" TEXT NOT NULL,
  "customer_quote_snapshot" JSONB NOT NULL,
  "customer_pricing_snapshot" JSONB NOT NULL,
  "provider_cost_snapshot" JSONB NOT NULL,
  "anchor_hash" TEXT NOT NULL,
  "canonical_payload" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gateway_usage_settlement_anchors_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gateway_usage_settlement_anchors_event_fkey"
    FOREIGN KEY ("gateway_billing_event_id") REFERENCES "gateway_billing_events"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "gateway_usage_settlement_anchors_unit_check"
    CHECK ("billing_unit" IN ('BALANCE', 'CREDITS')),
  CONSTRAINT "gateway_usage_settlement_anchors_credit_fields_check"
    CHECK (
      ("billing_unit" = 'BALANCE' AND "subscription_id" IS NULL AND "plan_id" IS NULL)
      OR
      ("billing_unit" = 'CREDITS' AND "subscription_id" IS NOT NULL AND "plan_id" IS NOT NULL)
    )
);

CREATE UNIQUE INDEX "gateway_usage_settlement_anchors_gateway_billing_event_id_key"
  ON "gateway_usage_settlement_anchors"("gateway_billing_event_id");
CREATE UNIQUE INDEX "gateway_usage_settlement_anchors_request_id_key"
  ON "gateway_usage_settlement_anchors"("request_id");
CREATE UNIQUE INDEX "gateway_usage_settlement_anchors_anchor_hash_key"
  ON "gateway_usage_settlement_anchors"("anchor_hash");
CREATE INDEX "gateway_usage_settlement_anchors_account_occurred_idx"
  ON "gateway_usage_settlement_anchors"("billing_account_id", "occurred_at");
CREATE INDEX "gateway_usage_settlement_anchors_key_occurred_idx"
  ON "gateway_usage_settlement_anchors"("api_key_id", "occurred_at");

ALTER TABLE "gateway_usage_evidences"
  ADD COLUMN "producer_build_sha" TEXT,
  ADD COLUMN "provider_usage_hash" TEXT,
  ADD COLUMN "provider_account_ref" TEXT,
  ADD COLUMN "stream_end_reason" TEXT;

ALTER TABLE "gateway_usage_settlement_receipts"
  ADD COLUMN "anchor_hash" TEXT,
  ADD COLUMN "pricing_hash" TEXT,
  ADD COLUMN "settlement_fingerprint" TEXT,
  ADD COLUMN "billing_unit" TEXT,
  ADD COLUMN "credit_amount" INTEGER;

ALTER TABLE "gateway_usage_settlement_receipts"
  ADD CONSTRAINT "gateway_usage_receipts_v2_proof_shape_check"
    CHECK (
      "policy_version" IS DISTINCT FROM 'gateway-settlement-v2'
      OR (
        "evidence_hash" IS NOT NULL
        AND "anchor_hash" IS NOT NULL
        AND "pricing_hash" IS NOT NULL
        AND "settlement_fingerprint" IS NOT NULL
        AND (
          ("billing_unit" = 'BALANCE' AND "credit_amount" IS NULL)
          OR
          ("billing_unit" = 'CREDITS' AND "credit_amount" IS NOT NULL AND "credit_amount" >= 0)
        )
      )
    ) NOT VALID,
  ADD CONSTRAINT "gateway_usage_receipts_funding_outcome_check"
    CHECK ("funding_outcome" IN ('COLLECTED', 'INCLUDED', 'DEBT_OPEN', 'ABSORBED')) NOT VALID;
ALTER TABLE "gateway_usage_settlement_receipts"
  VALIDATE CONSTRAINT "gateway_usage_receipts_v2_proof_shape_check";
ALTER TABLE "gateway_usage_settlement_receipts"
  VALIDATE CONSTRAINT "gateway_usage_receipts_funding_outcome_check";

CREATE OR REPLACE FUNCTION reject_gateway_settlement_append_only_mutation()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION '% is append-only', TG_TABLE_NAME USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION enforce_gateway_billing_event_immutable_receipt()
RETURNS trigger AS $$
BEGIN
  IF NEW."request_id" IS DISTINCT FROM OLD."request_id"
    OR NEW."event_id" IS DISTINCT FROM OLD."event_id"
    OR NEW."raw_event" IS DISTINCT FROM OLD."raw_event"
    OR NEW."evidence_hash" IS DISTINCT FROM OLD."evidence_hash"
    OR NEW."occurred_at" IS DISTINCT FROM OLD."occurred_at"
    OR NEW."api_key_id" IS DISTINCT FROM OLD."api_key_id"
    OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
    OR NEW."product_id" IS DISTINCT FROM OLD."product_id"
    OR NEW."product_slug" IS DISTINCT FROM OLD."product_slug"
    OR NEW."model_name" IS DISTINCT FROM OLD."model_name"
    OR NEW."input_tokens" IS DISTINCT FROM OLD."input_tokens"
    OR NEW."output_tokens" IS DISTINCT FROM OLD."output_tokens"
    OR NEW."cached_input_tokens" IS DISTINCT FROM OLD."cached_input_tokens"
    OR NEW."cache_write_input_tokens" IS DISTINCT FROM OLD."cache_write_input_tokens"
    OR NEW."total_tokens" IS DISTINCT FROM OLD."total_tokens"
    OR NEW."token_source" IS DISTINCT FROM OLD."token_source"
    OR NEW."upstream_request_id" IS DISTINCT FROM OLD."upstream_request_id"
  THEN
    RAISE EXCEPTION 'gateway_billing_events receipt/evidence columns are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER gateway_billing_events_immutable_receipt
  BEFORE UPDATE ON "gateway_billing_events"
  FOR EACH ROW EXECUTE FUNCTION enforce_gateway_billing_event_immutable_receipt();

CREATE TRIGGER gateway_usage_settlement_anchors_append_only
  BEFORE UPDATE OR DELETE ON "gateway_usage_settlement_anchors"
  FOR EACH ROW EXECUTE FUNCTION reject_gateway_settlement_append_only_mutation();

CREATE TRIGGER gateway_usage_evidences_append_only
  BEFORE UPDATE OR DELETE ON "gateway_usage_evidences"
  FOR EACH ROW EXECUTE FUNCTION reject_gateway_settlement_append_only_mutation();

CREATE TRIGGER gateway_usage_reconciliation_actions_append_only
  BEFORE UPDATE OR DELETE ON "gateway_usage_reconciliation_actions"
  FOR EACH ROW EXECUTE FUNCTION reject_gateway_settlement_append_only_mutation();

CREATE TRIGGER gateway_usage_settlement_receipts_append_only
  BEFORE UPDATE OR DELETE ON "gateway_usage_settlement_receipts"
  FOR EACH ROW EXECUTE FUNCTION reject_gateway_settlement_append_only_mutation();
