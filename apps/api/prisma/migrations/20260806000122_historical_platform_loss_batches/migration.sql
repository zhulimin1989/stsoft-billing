-- Audited maker/checker closure for provider statement discrepancies that
-- predate Gateway occurrence-time settlement anchors. Posting never mutates a
-- customer wallet, invoice, TokenUsage or prior settlement receipt.
CREATE TABLE "historical_platform_loss_batches" (
  "id" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "provider_account_ref" TEXT NOT NULL,
  "region" TEXT NOT NULL,
  "period_start" TIMESTAMP(3) NOT NULL,
  "period_end" TIMESTAMP(3) NOT NULL,
  "currency" TEXT NOT NULL,
  "source_file_ref" TEXT NOT NULL,
  "source_file_sha256" TEXT NOT NULL,
  "calculation_method" TEXT NOT NULL,
  "rounding_policy" TEXT NOT NULL,
  "exchange_rate" DECIMAL(30,12),
  "exchange_rate_source" TEXT,
  "exchange_rate_source_currency" TEXT,
  "exchange_rate_as_of" TIMESTAMP(3),
  "platform_amount_before" DECIMAL(20,12) NOT NULL,
  "platform_amount_corrected" DECIMAL(20,12) NOT NULL,
  "customer_absorbed_delta" DECIMAL(20,12) NOT NULL,
  "customer_deduction" DECIMAL(20,12) NOT NULL DEFAULT 0,
  "provider_cost_before" DECIMAL(20,12) NOT NULL,
  "provider_cost_corrected" DECIMAL(20,12) NOT NULL,
  "provider_cost_delta" DECIMAL(20,12) NOT NULL,
  "item_count" INTEGER NOT NULL,
  "fingerprint" TEXT NOT NULL,
  "revision" INTEGER NOT NULL DEFAULT 0,
  "status" TEXT NOT NULL DEFAULT 'PREPARED',
  "reason" TEXT NOT NULL,
  "maker_actor_id" TEXT NOT NULL,
  "checker_actor_id" TEXT,
  "posted_by_actor_id" TEXT,
  "create_idempotency_key" TEXT NOT NULL,
  "post_idempotency_key" TEXT,
  "approved_at" TIMESTAMP(3),
  "posted_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "historical_platform_loss_batches_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "historical_platform_loss_batches_contract_check" CHECK (
    btrim("provider") <> ''
    AND btrim("provider_account_ref") <> ''
    AND btrim("region") <> ''
    AND "period_end" > "period_start"
    AND "currency" ~ '^[A-Z]{3}$'
    AND "source_file_sha256" ~ '^[0-9a-f]{64}$'
    AND btrim("source_file_ref") <> ''
    AND "calculation_method" = 'TOKEN_RATE_PER_MILLION_V1'
    AND "rounding_policy" = 'HALF_UP_12'
    AND (("exchange_rate" IS NULL AND "exchange_rate_source" IS NULL
          AND "exchange_rate_source_currency" IS NULL AND "exchange_rate_as_of" IS NULL)
      OR ("exchange_rate" IS NOT NULL AND "exchange_rate" > 0
          AND "exchange_rate_source" IS NOT NULL AND btrim("exchange_rate_source") <> ''
          AND "exchange_rate_source_currency" IS NOT NULL
          AND "exchange_rate_source_currency" ~ '^[A-Z]{3}$'
          AND "exchange_rate_source_currency" <> "currency"
          AND "exchange_rate_as_of" IS NOT NULL))
    AND "platform_amount_before" >= 0
    AND "platform_amount_corrected" >= 0
    AND "customer_absorbed_delta" =
      "platform_amount_corrected" - "platform_amount_before"
    AND "customer_absorbed_delta" >= 0
    AND "customer_deduction" = 0
    AND "provider_cost_before" >= 0
    AND "provider_cost_corrected" >= 0
    AND "provider_cost_delta" =
      "provider_cost_corrected" - "provider_cost_before"
    AND ("customer_absorbed_delta" > 0 OR "provider_cost_delta" > 0)
    AND "item_count" > 0
    AND "fingerprint" ~ '^[0-9a-f]{64}$'
    AND btrim("reason") <> '' AND btrim("maker_actor_id") <> ''
    AND btrim("create_idempotency_key") <> ''
    AND "revision" IN (0, 1)
    AND "status" IN ('PREPARED', 'POSTED')
    AND (("status" = 'PREPARED' AND "revision" = 0
          AND "checker_actor_id" IS NULL AND "posted_by_actor_id" IS NULL
          AND "post_idempotency_key" IS NULL AND "approved_at" IS NULL
          AND "posted_at" IS NULL)
      OR ("status" = 'POSTED' AND "revision" = 1
          AND "checker_actor_id" IS NOT NULL AND "posted_by_actor_id" IS NOT NULL
          AND btrim("checker_actor_id") <> '' AND btrim("posted_by_actor_id") <> ''
          AND "maker_actor_id" <> "checker_actor_id"
          AND btrim("post_idempotency_key") <> ''
          AND "approved_at" IS NOT NULL AND "posted_at" IS NOT NULL))
  )
);

CREATE UNIQUE INDEX "historical_platform_loss_batches_fingerprint_key"
  ON "historical_platform_loss_batches"("fingerprint");
CREATE UNIQUE INDEX "historical_platform_loss_batches_create_idempotency_key"
  ON "historical_platform_loss_batches"("create_idempotency_key");
CREATE UNIQUE INDEX "historical_platform_loss_batches_post_idempotency_key"
  ON "historical_platform_loss_batches"("post_idempotency_key");
CREATE INDEX "historical_platform_loss_batches_status_created_idx"
  ON "historical_platform_loss_batches"("status", "created_at");
CREATE INDEX "historical_platform_loss_batches_provider_period_idx"
  ON "historical_platform_loss_batches"(
    "provider", "provider_account_ref", "period_start", "period_end"
  );

CREATE TABLE "historical_platform_loss_lines" (
  "id" TEXT NOT NULL,
  "batch_id" TEXT NOT NULL,
  "line_number" INTEGER NOT NULL,
  "line_type" TEXT NOT NULL,
  "gateway_billing_event_id" TEXT,
  "request_id" TEXT,
  "upstream_request_id" TEXT,
  "provider_aggregate_ref" TEXT,
  "service_date" DATE NOT NULL,
  "model_name" TEXT NOT NULL,
  "meter" TEXT NOT NULL,
  "platform_usage" DECIMAL(30,0) NOT NULL,
  "provider_usage" DECIMAL(30,0) NOT NULL,
  "usage_delta" DECIMAL(30,0) NOT NULL,
  "valuation_basis" JSONB NOT NULL,
  "source_row_ref" TEXT NOT NULL,
  "source_evidence" JSONB NOT NULL,
  "source_row_hash" TEXT NOT NULL,
  "recognition_keys" JSONB NOT NULL,
  "platform_amount_before" DECIMAL(20,12) NOT NULL,
  "platform_amount_corrected" DECIMAL(20,12) NOT NULL,
  "customer_absorbed_delta" DECIMAL(20,12) NOT NULL,
  "customer_deduction" DECIMAL(20,12) NOT NULL DEFAULT 0,
  "provider_cost_before" DECIMAL(20,12) NOT NULL,
  "provider_cost_corrected" DECIMAL(20,12) NOT NULL,
  "provider_cost_delta" DECIMAL(20,12) NOT NULL,
  "line_hash" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "historical_platform_loss_lines_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "historical_platform_loss_lines_batch_fkey"
    FOREIGN KEY ("batch_id") REFERENCES "historical_platform_loss_batches"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "historical_platform_loss_lines_event_fkey"
    FOREIGN KEY ("gateway_billing_event_id") REFERENCES "gateway_billing_events"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "historical_platform_loss_lines_contract_check" CHECK (
    "line_number" > 0
    AND "line_type" IN ('MISSING_ANCHOR_REQUEST', 'PROVIDER_AGGREGATE')
    AND (("line_type" = 'MISSING_ANCHOR_REQUEST'
          AND "gateway_billing_event_id" IS NOT NULL
          AND "request_id" IS NOT NULL AND btrim("request_id") <> ''
          AND "provider_aggregate_ref" IS NULL)
      OR ("line_type" = 'PROVIDER_AGGREGATE'
          AND "gateway_billing_event_id" IS NULL AND "request_id" IS NULL
          AND "upstream_request_id" IS NULL
          AND "provider_aggregate_ref" IS NOT NULL
          AND btrim("provider_aggregate_ref") <> ''))
    AND btrim("model_name") <> '' AND btrim("meter") <> ''
    AND "platform_usage" >= 0 AND "provider_usage" >= 0
    AND "usage_delta" = "provider_usage" - "platform_usage"
    AND jsonb_typeof("valuation_basis") = 'object'
    AND jsonb_typeof("source_evidence") = 'object'
    AND "source_evidence" <> '{}'::jsonb
    AND btrim("source_row_ref") <> ''
    AND "source_row_hash" ~ '^[0-9a-f]{64}$'
    AND jsonb_typeof("recognition_keys") = 'array'
    AND jsonb_array_length("recognition_keys") > 0
    AND "platform_amount_before" >= 0 AND "platform_amount_corrected" >= 0
    AND "customer_absorbed_delta" =
      "platform_amount_corrected" - "platform_amount_before"
    AND "customer_deduction" = 0
    AND "provider_cost_before" >= 0 AND "provider_cost_corrected" >= 0
    AND "provider_cost_delta" =
      "provider_cost_corrected" - "provider_cost_before"
    AND "line_hash" ~ '^[0-9a-f]{64}$'
  )
);

CREATE UNIQUE INDEX "historical_platform_loss_lines_batch_line_key"
  ON "historical_platform_loss_lines"("batch_id", "line_number");
CREATE UNIQUE INDEX "historical_platform_loss_lines_batch_hash_key"
  ON "historical_platform_loss_lines"("batch_id", "line_hash");
CREATE INDEX "historical_platform_loss_lines_request_idx"
  ON "historical_platform_loss_lines"("request_id");
CREATE INDEX "historical_platform_loss_lines_upstream_idx"
  ON "historical_platform_loss_lines"("upstream_request_id");

CREATE TABLE "historical_platform_loss_actions" (
  "id" TEXT NOT NULL,
  "batch_id" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "expected_revision" INTEGER NOT NULL,
  "resulting_revision" INTEGER NOT NULL,
  "actor_id" TEXT NOT NULL,
  "reason" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "historical_platform_loss_actions_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "historical_platform_loss_actions_batch_fkey"
    FOREIGN KEY ("batch_id") REFERENCES "historical_platform_loss_batches"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "historical_platform_loss_actions_contract_check" CHECK (
    "action" IN ('PREPARE', 'APPROVE_AND_POST')
    AND "expected_revision" >= -1
    AND "resulting_revision" = "expected_revision" + 1
    AND btrim("actor_id") <> '' AND btrim("reason") <> ''
    AND btrim("idempotency_key") <> ''
  )
);

CREATE UNIQUE INDEX "historical_platform_loss_actions_idempotency_key"
  ON "historical_platform_loss_actions"("idempotency_key");
CREATE INDEX "historical_platform_loss_actions_batch_created_idx"
  ON "historical_platform_loss_actions"("batch_id", "created_at");

-- One coverage tuple may contain many per-request corrections, but it may not
-- be recognized once per request and again as an indivisible provider
-- aggregate. The first mode wins atomically; additional REQUEST rows in the
-- same coverage remain valid and are deduplicated by their REQUEST_ID claims.
CREATE TABLE "usage_loss_coverage_registry" (
  "id" TEXT NOT NULL,
  "coverage_key" TEXT NOT NULL,
  "provider" TEXT NOT NULL,
  "provider_account_ref" TEXT NOT NULL,
  "region" TEXT NOT NULL,
  "service_date" DATE NOT NULL,
  "model_name" TEXT NOT NULL,
  "meter" TEXT NOT NULL,
  "granularity_mode" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "usage_loss_coverage_registry_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "usage_loss_coverage_registry_contract_check" CHECK (
    btrim("coverage_key") <> ''
    AND btrim("provider") <> ''
    AND btrim("provider_account_ref") <> ''
    AND btrim("region") <> ''
    AND btrim("model_name") <> ''
    AND btrim("meter") <> ''
    AND "granularity_mode" IN ('REQUEST', 'AGGREGATE')
  )
);

CREATE UNIQUE INDEX "usage_loss_coverage_registry_coverage_key_key"
  ON "usage_loss_coverage_registry"("coverage_key");
CREATE INDEX "usage_loss_coverage_registry_scope_idx"
  ON "usage_loss_coverage_registry"(
    "provider", "provider_account_ref", "region", "service_date", "model_name", "meter"
  );

CREATE TABLE "usage_loss_recognition_claims" (
  "id" TEXT NOT NULL,
  "recognition_key" TEXT NOT NULL,
  "recognition_type" TEXT NOT NULL,
  "claim_source" TEXT NOT NULL,
  "gateway_billing_event_id" TEXT,
  "gateway_usage_platform_loss_id" TEXT,
  "historical_batch_line_id" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "usage_loss_recognition_claims_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "usage_loss_recognition_claims_event_fkey"
    FOREIGN KEY ("gateway_billing_event_id") REFERENCES "gateway_billing_events"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "usage_loss_recognition_claims_platform_loss_fkey"
    FOREIGN KEY ("gateway_usage_platform_loss_id") REFERENCES "gateway_usage_platform_losses"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "usage_loss_recognition_claims_historical_line_fkey"
    FOREIGN KEY ("historical_batch_line_id") REFERENCES "historical_platform_loss_lines"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "usage_loss_recognition_claims_owner_check" CHECK (
    "recognition_type" IN (
      'REQUEST_ID', 'UPSTREAM_REQUEST_ID',
      'PROVIDER_AGGREGATE_SOURCE', 'PROVIDER_AGGREGATE_COVERAGE'
    )
    AND (("claim_source" = 'ABSORB_DELTA'
          AND "gateway_billing_event_id" IS NOT NULL
          AND "gateway_usage_platform_loss_id" IS NOT NULL
          AND "historical_batch_line_id" IS NULL)
      OR ("claim_source" = 'HISTORICAL_BATCH'
          AND "gateway_usage_platform_loss_id" IS NULL
          AND "historical_batch_line_id" IS NOT NULL))
  )
);

CREATE UNIQUE INDEX "usage_loss_recognition_claims_recognition_key_key"
  ON "usage_loss_recognition_claims"("recognition_key");
CREATE INDEX "usage_loss_recognition_claims_source_created_idx"
  ON "usage_loss_recognition_claims"("claim_source", "created_at");
CREATE INDEX "usage_loss_recognition_claims_event_idx"
  ON "usage_loss_recognition_claims"("gateway_billing_event_id");
CREATE INDEX "usage_loss_recognition_claims_line_idx"
  ON "usage_loss_recognition_claims"("historical_batch_line_id");

-- Backfill the strongest identifier available for already-recorded
-- per-request platform losses before the global recognition registry existed.
INSERT INTO "usage_loss_recognition_claims" (
  "id", "recognition_key", "recognition_type", "claim_source",
  "gateway_billing_event_id", "gateway_usage_platform_loss_id"
)
SELECT
  gen_random_uuid()::text,
  'REQUEST_ID:' || replace(encode(convert_to(pl."request_id", 'UTF8'), 'base64'), E'\n', ''),
  'REQUEST_ID',
  'ABSORB_DELTA',
  pl."gateway_billing_event_id",
  pl."id"
FROM "gateway_usage_platform_losses" pl
ON CONFLICT ("recognition_key") DO NOTHING;

CREATE OR REPLACE FUNCTION guard_historical_platform_loss_batch_mutation()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    IF OLD."status" = 'POSTED' THEN
      RAISE EXCEPTION 'posted historical platform loss batches are append-only'
        USING ERRCODE = '55000';
    END IF;
    RETURN OLD;
  END IF;

  IF OLD."status" = 'POSTED' THEN
    RAISE EXCEPTION 'posted historical platform loss batches are append-only'
      USING ERRCODE = '55000';
  END IF;

  IF NEW."provider" IS DISTINCT FROM OLD."provider"
    OR NEW."provider_account_ref" IS DISTINCT FROM OLD."provider_account_ref"
    OR NEW."region" IS DISTINCT FROM OLD."region"
    OR NEW."period_start" IS DISTINCT FROM OLD."period_start"
    OR NEW."period_end" IS DISTINCT FROM OLD."period_end"
    OR NEW."currency" IS DISTINCT FROM OLD."currency"
    OR NEW."source_file_ref" IS DISTINCT FROM OLD."source_file_ref"
    OR NEW."source_file_sha256" IS DISTINCT FROM OLD."source_file_sha256"
    OR NEW."calculation_method" IS DISTINCT FROM OLD."calculation_method"
    OR NEW."rounding_policy" IS DISTINCT FROM OLD."rounding_policy"
    OR NEW."exchange_rate" IS DISTINCT FROM OLD."exchange_rate"
    OR NEW."exchange_rate_source" IS DISTINCT FROM OLD."exchange_rate_source"
    OR NEW."exchange_rate_source_currency" IS DISTINCT FROM OLD."exchange_rate_source_currency"
    OR NEW."exchange_rate_as_of" IS DISTINCT FROM OLD."exchange_rate_as_of"
    OR NEW."platform_amount_before" IS DISTINCT FROM OLD."platform_amount_before"
    OR NEW."platform_amount_corrected" IS DISTINCT FROM OLD."platform_amount_corrected"
    OR NEW."customer_absorbed_delta" IS DISTINCT FROM OLD."customer_absorbed_delta"
    OR NEW."customer_deduction" IS DISTINCT FROM OLD."customer_deduction"
    OR NEW."provider_cost_before" IS DISTINCT FROM OLD."provider_cost_before"
    OR NEW."provider_cost_corrected" IS DISTINCT FROM OLD."provider_cost_corrected"
    OR NEW."provider_cost_delta" IS DISTINCT FROM OLD."provider_cost_delta"
    OR NEW."item_count" IS DISTINCT FROM OLD."item_count"
    OR NEW."fingerprint" IS DISTINCT FROM OLD."fingerprint"
    OR NEW."reason" IS DISTINCT FROM OLD."reason"
    OR NEW."maker_actor_id" IS DISTINCT FROM OLD."maker_actor_id"
    OR NEW."create_idempotency_key" IS DISTINCT FROM OLD."create_idempotency_key"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at" THEN
      RAISE EXCEPTION 'prepared historical platform loss batch evidence is immutable'
        USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER historical_platform_loss_batches_mutation_guard
  BEFORE UPDATE OR DELETE ON "historical_platform_loss_batches"
  FOR EACH ROW EXECUTE FUNCTION guard_historical_platform_loss_batch_mutation();

CREATE TRIGGER historical_platform_loss_lines_append_only
  BEFORE UPDATE OR DELETE ON "historical_platform_loss_lines"
  FOR EACH ROW EXECUTE FUNCTION reject_gateway_settlement_append_only_mutation();

CREATE TRIGGER historical_platform_loss_actions_append_only
  BEFORE UPDATE OR DELETE ON "historical_platform_loss_actions"
  FOR EACH ROW EXECUTE FUNCTION reject_gateway_settlement_append_only_mutation();

CREATE TRIGGER usage_loss_coverage_registry_append_only
  BEFORE UPDATE OR DELETE ON "usage_loss_coverage_registry"
  FOR EACH ROW EXECUTE FUNCTION reject_gateway_settlement_append_only_mutation();

CREATE TRIGGER usage_loss_recognition_claims_append_only
  BEFORE UPDATE OR DELETE ON "usage_loss_recognition_claims"
  FOR EACH ROW EXECUTE FUNCTION reject_gateway_settlement_append_only_mutation();
