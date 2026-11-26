-- The first Gateway payload remains the immutable occurrence record.  Later
-- provider/import evidence is appended to gateway_usage_evidences.
ALTER TABLE "gateway_billing_events"
  ADD COLUMN "billing_account_id" TEXT,
  ADD COLUMN "token_source" TEXT,
  ADD COLUMN "upstream_request_id" TEXT,
  ADD COLUMN "evidence_hash" TEXT,
  ADD COLUMN "evidence_verdict" TEXT NOT NULL DEFAULT 'UNKNOWN',
  ADD COLUMN "reconciliation_status" TEXT NOT NULL DEFAULT 'OPEN',
  ADD COLUMN "funding_outcome" TEXT,
  ADD COLUMN "revision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "pending_exposure_usd" DECIMAL(20,12) NOT NULL DEFAULT 0,
  ADD COLUMN "pending_hold_usd" DECIMAL(20,12) NOT NULL DEFAULT 0,
  ADD COLUMN "subject_snapshot" JSONB,
  ADD COLUMN "pricing_snapshot" JSONB;

-- Historical rows deliberately remain UNKNOWN/OPEN with no synthetic funding
-- outcome or receipt.  A separate evidence-backed, batched audit may classify
-- them later; deployment must not rewrite financial history from raw JSON alone.
ALTER TABLE "gateway_billing_events"
  ADD CONSTRAINT "gateway_billing_events_revision_nonnegative_check"
    CHECK ("revision" >= 0) NOT VALID,
  ADD CONSTRAINT "gateway_billing_events_pending_amounts_nonnegative_check"
    CHECK (
      "pending_exposure_usd" >= 0
      AND "pending_hold_usd" >= 0
      AND "pending_hold_usd" <= "pending_exposure_usd"
    ) NOT VALID;
ALTER TABLE "gateway_billing_events"
  VALIDATE CONSTRAINT "gateway_billing_events_revision_nonnegative_check";
ALTER TABLE "gateway_billing_events"
  VALIDATE CONSTRAINT "gateway_billing_events_pending_amounts_nonnegative_check";

CREATE TABLE "gateway_usage_evidences" (
  "id" TEXT NOT NULL,
  "gateway_billing_event_id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "event_id" TEXT,
  "source" TEXT NOT NULL,
  "token_source" TEXT,
  "upstream_request_id" TEXT,
  "evidence_hash" TEXT NOT NULL,
  "evidence_revision" INTEGER NOT NULL,
  "raw_evidence" JSONB NOT NULL,
  "observed_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gateway_usage_evidences_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gateway_usage_evidences_revision_positive_check"
    CHECK ("evidence_revision" > 0),
  CONSTRAINT "gateway_usage_evidences_gateway_billing_event_id_fkey"
    FOREIGN KEY ("gateway_billing_event_id") REFERENCES "gateway_billing_events"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "gateway_usage_evidences_event_hash_key"
  ON "gateway_usage_evidences"("gateway_billing_event_id", "evidence_hash");
CREATE UNIQUE INDEX "gateway_usage_evidences_event_revision_key"
  ON "gateway_usage_evidences"("gateway_billing_event_id", "evidence_revision");
CREATE INDEX "gateway_usage_evidences_request_created_idx"
  ON "gateway_usage_evidences"("request_id", "created_at");
CREATE INDEX "gateway_usage_evidences_upstream_created_idx"
  ON "gateway_usage_evidences"("upstream_request_id", "created_at");

CREATE TABLE "gateway_usage_reconciliation_actions" (
  "id" TEXT NOT NULL,
  "gateway_billing_event_id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "expected_revision" INTEGER NOT NULL,
  "resulting_revision" INTEGER NOT NULL,
  "reason" TEXT NOT NULL,
  "actor_id" TEXT,
  "idempotency_key" TEXT NOT NULL,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gateway_usage_reconciliation_actions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gateway_usage_reconciliation_actions_revisions_nonnegative_check"
    CHECK ("expected_revision" >= 0 AND "resulting_revision" >= 0),
  CONSTRAINT "gateway_usage_reconciliation_actions_event_fkey"
    FOREIGN KEY ("gateway_billing_event_id") REFERENCES "gateway_billing_events"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "gateway_usage_reconciliation_actions_idempotency_key_key"
  ON "gateway_usage_reconciliation_actions"("idempotency_key");
CREATE INDEX "gateway_usage_reconciliation_actions_request_created_idx"
  ON "gateway_usage_reconciliation_actions"("request_id", "created_at");
CREATE INDEX "gateway_usage_reconciliation_actions_event_created_idx"
  ON "gateway_usage_reconciliation_actions"("gateway_billing_event_id", "created_at");
CREATE INDEX "gateway_usage_reconciliation_actions_action_created_idx"
  ON "gateway_usage_reconciliation_actions"("action", "created_at");

CREATE TABLE "gateway_usage_settlement_receipts" (
  "id" TEXT NOT NULL,
  "gateway_billing_event_id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "settlement_revision" INTEGER NOT NULL,
  "funding_outcome" TEXT NOT NULL,
  "evidence_hash" TEXT,
  "amount_usd" DECIMAL(20,12) NOT NULL DEFAULT 0,
  "token_usage_id" TEXT,
  "reason" TEXT,
  "policy_version" TEXT,
  "actor_id" TEXT,
  "idempotency_key" TEXT NOT NULL,
  "payload" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gateway_usage_settlement_receipts_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gateway_usage_settlement_receipts_amount_revision_check"
    CHECK ("settlement_revision" >= 0 AND "amount_usd" >= 0),
  CONSTRAINT "gateway_usage_settlement_receipts_gateway_billing_event_id_fkey"
    FOREIGN KEY ("gateway_billing_event_id") REFERENCES "gateway_billing_events"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX "gateway_usage_settlement_receipts_idempotency_key_key"
  ON "gateway_usage_settlement_receipts"("idempotency_key");
CREATE UNIQUE INDEX "gateway_usage_receipts_event_revision_key"
  ON "gateway_usage_settlement_receipts"("gateway_billing_event_id", "settlement_revision");
CREATE INDEX "gateway_usage_settlement_receipts_request_created_idx"
  ON "gateway_usage_settlement_receipts"("request_id", "created_at");
CREATE INDEX "gateway_usage_settlement_receipts_outcome_created_idx"
  ON "gateway_usage_settlement_receipts"("funding_outcome", "created_at");

CREATE TABLE "billing_access_restrictions" (
  "id" TEXT NOT NULL,
  "gateway_billing_event_id" TEXT,
  "api_key_id" TEXT,
  "billing_account_id" TEXT,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "reason" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "created_by" TEXT,
  "released_by" TEXT,
  "release_reason" TEXT,
  "released_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "billing_access_restrictions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "billing_access_restrictions_gateway_billing_event_id_fkey"
    FOREIGN KEY ("gateway_billing_event_id") REFERENCES "gateway_billing_events"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "billing_access_restrictions_exactly_one_subject_check"
    CHECK (("api_key_id" IS NOT NULL)::int + ("billing_account_id" IS NOT NULL)::int = 1)
);

CREATE UNIQUE INDEX "billing_access_restrictions_idempotency_key_key"
  ON "billing_access_restrictions"("idempotency_key");
CREATE INDEX "billing_access_restrictions_api_key_status_idx"
  ON "billing_access_restrictions"("api_key_id", "status");
CREATE INDEX "billing_access_restrictions_account_status_idx"
  ON "billing_access_restrictions"("billing_account_id", "status");
CREATE INDEX "billing_access_restrictions_event_status_idx"
  ON "billing_access_restrictions"("gateway_billing_event_id", "status");
