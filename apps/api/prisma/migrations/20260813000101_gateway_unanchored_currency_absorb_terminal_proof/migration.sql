-- A deliberately narrow terminal pair for the three legacy domestic-UAT
-- receipts that failed before a settlement anchor could be created while the
-- account currency label was still USD.  This does not weaken the established
-- reservation-backed anchored absorption proof.

-- Match the application's recursive, key-sorted canonical JSON encoding for
-- the scalar/object/array shapes carried by this protocol.  PostgreSQL JSONB
-- text alone has a different object-key order and is not a proof hash.
CREATE OR REPLACE FUNCTION gateway_unanchored_absorb_canonical_json(
  value JSONB
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
STRICT
AS $$
  SELECT CASE jsonb_typeof(value)
    WHEN 'object' THEN '{' || COALESCE((
      SELECT string_agg(
        to_json(object_entry.key)::TEXT || ':'
          || gateway_unanchored_absorb_canonical_json(object_entry.value),
        ',' ORDER BY object_entry.key COLLATE "C"
      )
      FROM jsonb_each(value) AS object_entry
    ), '') || '}'
    WHEN 'array' THEN '[' || COALESCE((
      SELECT string_agg(
        gateway_unanchored_absorb_canonical_json(array_entry.value),
        ',' ORDER BY array_entry.ordinality
      )
      FROM jsonb_array_elements(value) WITH ORDINALITY AS array_entry(value, ordinality)
    ), '') || ']'
    ELSE value::TEXT
  END
$$;

-- The legacy text is an install-time eligibility marker. New Billing code no
-- longer persists it (the typed migration error rolls the first receipt back),
-- so it must neither be manufactured nor rewritten after this migration.
CREATE OR REPLACE FUNCTION enforce_gateway_legacy_currency_failure_immutable()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  legacy_pattern CONSTANT TEXT :=
    '^Gateway billing currency mismatch: account=[A-Z]{3} deployment=[A-Z]{3}$';
  allow_legacy_fixture BOOLEAN := COALESCE(
    NULLIF(current_setting(
      'billing.allow_legacy_currency_failure_fixture',
      TRUE
    ), ''),
    'false'
  )::BOOLEAN
    AND lower(current_database()) ~ '(test|ci)';
BEGIN
  IF TG_OP = 'INSERT'
     AND NEW."error_message" ~ legacy_pattern
     AND NOT allow_legacy_fixture THEN
    RAISE EXCEPTION 'new gateway legacy currency failure markers are forbidden'
      USING ERRCODE = '55000';
  END IF;
  IF TG_OP = 'UPDATE'
     AND (
       OLD."error_message" ~ legacy_pattern
       OR NEW."error_message" ~ legacy_pattern
     )
     AND NEW."error_message" IS DISTINCT FROM OLD."error_message" THEN
    RAISE EXCEPTION 'gateway legacy currency failure marker is immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER gateway_legacy_currency_failure_immutable
  BEFORE INSERT OR UPDATE ON "gateway_billing_events"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_gateway_legacy_currency_failure_immutable();

ALTER TABLE "gateway_usage_settlement_receipts"
  ADD CONSTRAINT "gateway_unanchored_absorb_v1_shape_check"
  CHECK (
    "policy_version" IS DISTINCT FROM 'gateway-unanchored-absorb-v1'
    OR COALESCE(
      "funding_outcome" = 'ABSORBED'
      AND "amount_usd" = 0
      AND "anchor_hash" IS NULL
      AND "pricing_hash" IS NULL
      AND "billing_unit" IS NULL
      AND "billing_currency" IS NULL
      AND "credit_amount" IS NULL
      AND "token_usage_id" IS NULL
      AND "evidence_hash" ~ '^[0-9a-f]{64}$'
      AND "settlement_fingerprint" ~ '^[0-9a-f]{64}$'
      AND jsonb_typeof("payload") = 'object'
      AND "payload"->>'protocol' = 'gateway-unanchored-absorb-v1'
      AND ("payload"->>'amountUsd')::NUMERIC = 0
      AND ("payload"->>'customerDeductionUsd')::NUMERIC = 0,
      FALSE
    )
  );

CREATE OR REPLACE FUNCTION assert_gateway_unanchored_currency_absorb_terminal(
  target_event_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  event_row RECORD;
  action_row RECORD;
  receipt_row RECORD;
  repair_run RECORD;
  repair_item RECORD;
  eligible_event RECORD;
  current_api_key RECORD;
  current_tenant RECORD;
  current_account RECORD;
  action_count BIGINT;
  receipt_count BIGINT;
  evidence_count BIGINT;
  source_currency TEXT;
  target_currency TEXT;
  action_metadata JSONB;
  receipt_payload JSONB;
  unanchored_protocol_present BOOLEAN;
BEGIN
  SELECT * INTO event_row
  FROM "gateway_billing_events"
  WHERE "id" = target_event_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;

  SELECT COALESCE(
    event_row."status" = 'ABSORBED' AND event_row."error_message" ~
      '^Gateway billing currency mismatch: account=[A-Z]{3} deployment=[A-Z]{3}$',
    FALSE
  )
  OR EXISTS (
    SELECT 1
    FROM "gateway_usage_reconciliation_actions" AS action_probe
    WHERE action_probe."gateway_billing_event_id" = target_event_id
      AND action_probe."metadata"->>'protocol' =
        'gateway-unanchored-absorb-v1'
  ) OR EXISTS (
    SELECT 1
    FROM "gateway_usage_settlement_receipts" AS receipt_probe
    WHERE receipt_probe."gateway_billing_event_id" = target_event_id
      AND receipt_probe."policy_version" = 'gateway-unanchored-absorb-v1'
  )
  INTO unanchored_protocol_present;

  IF NOT unanchored_protocol_present THEN
    RETURN;
  END IF;

  IF event_row."status" IS DISTINCT FROM 'ABSORBED'
     OR event_row."reconciliation_status" IS DISTINCT FROM 'CLOSED'
     OR event_row."funding_outcome" IS DISTINCT FROM 'ABSORBED'
     OR event_row."pending_exposure_usd" IS DISTINCT FROM 0
     OR event_row."pending_hold_usd" IS DISTINCT FROM 0
     OR event_row."billing_account_id" IS NOT NULL
     OR event_row."billing_unit" IS NOT NULL
     OR event_row."billing_result" IS NOT NULL
     OR event_row."pricing_snapshot" IS NOT NULL
     OR event_row."api_key_id" IS NULL
     OR event_row."tenant_id" IS NULL
     OR event_row."evidence_hash" IS NULL
     OR COALESCE(
       event_row."error_message" !~
         '^Gateway billing currency mismatch: account=[A-Z]{3} deployment=[A-Z]{3}$',
       TRUE
     )
  THEN
    RAISE EXCEPTION 'gateway unanchored absorb event terminal state is invalid'
      USING ERRCODE = '55000';
  END IF;

  source_currency := substring(
    event_row."error_message"
    FROM '^Gateway billing currency mismatch: account=([A-Z]{3}) deployment=[A-Z]{3}$'
  );
  target_currency := substring(
    event_row."error_message"
    FROM '^Gateway billing currency mismatch: account=[A-Z]{3} deployment=([A-Z]{3})$'
  );
  IF source_currency IS NULL
     OR target_currency IS NULL
     OR source_currency = target_currency THEN
    RAISE EXCEPTION 'gateway unanchored absorb currency failure is invalid'
      USING ERRCODE = '55000';
  END IF;

  SELECT COUNT(*)
  INTO action_count
  FROM "gateway_usage_reconciliation_actions" AS action_candidate
  WHERE action_candidate."gateway_billing_event_id" = target_event_id
    AND action_candidate."action" = 'ABSORB';
  IF action_count <> 1 THEN
    RAISE EXCEPTION 'gateway unanchored absorb requires exactly one ABSORB action'
      USING ERRCODE = '55000';
  END IF;
  SELECT * INTO action_row
  FROM "gateway_usage_reconciliation_actions"
  WHERE "gateway_billing_event_id" = target_event_id
    AND "action" = 'ABSORB';

  SELECT COUNT(*)
  INTO receipt_count
  FROM "gateway_usage_settlement_receipts" AS receipt_candidate
  WHERE receipt_candidate."gateway_billing_event_id" = target_event_id;
  IF receipt_count <> 1 THEN
    RAISE EXCEPTION 'gateway unanchored absorb requires exactly one receipt'
      USING ERRCODE = '55000';
  END IF;
  SELECT * INTO receipt_row
  FROM "gateway_usage_settlement_receipts"
  WHERE "gateway_billing_event_id" = target_event_id;

  action_metadata := action_row."metadata";
  receipt_payload := receipt_row."payload";
  IF jsonb_typeof(action_metadata) IS DISTINCT FROM 'object'
     OR jsonb_typeof(receipt_payload) IS DISTINCT FROM 'object'
     OR action_row."request_id" IS DISTINCT FROM event_row."request_id"
     OR action_row."expected_revision" + 1 IS DISTINCT FROM
       action_row."resulting_revision"
     OR action_row."resulting_revision" IS DISTINCT FROM event_row."revision"
     OR action_row."reason" IS DISTINCT FROM event_row."reason"
     OR NULLIF(btrim(action_row."reason"), '') IS NULL
     OR action_row."actor_id" IS NULL
     OR NULLIF(btrim(action_row."actor_id"), '') IS NULL
     OR NULLIF(btrim(action_row."idempotency_key"), '') IS NULL
     OR receipt_row."request_id" IS DISTINCT FROM event_row."request_id"
     OR receipt_row."settlement_revision" IS DISTINCT FROM event_row."revision"
     OR receipt_row."funding_outcome" IS DISTINCT FROM 'ABSORBED'
     OR receipt_row."evidence_hash" IS DISTINCT FROM event_row."evidence_hash"
     OR receipt_row."amount_usd" IS DISTINCT FROM 0
     OR receipt_row."anchor_hash" IS NOT NULL
     OR receipt_row."pricing_hash" IS NOT NULL
     OR receipt_row."billing_unit" IS NOT NULL
     OR receipt_row."billing_currency" IS NOT NULL
     OR receipt_row."credit_amount" IS NOT NULL
     OR receipt_row."token_usage_id" IS NOT NULL
     OR receipt_row."reason" IS DISTINCT FROM action_row."reason"
     OR receipt_row."actor_id" IS DISTINCT FROM action_row."actor_id"
     OR receipt_row."idempotency_key" IS DISTINCT FROM
       'receipt:' || action_row."idempotency_key"
     OR receipt_row."policy_version" IS DISTINCT FROM
       'gateway-unanchored-absorb-v1'
     OR receipt_row."settlement_fingerprint" IS NULL
     OR receipt_row."settlement_fingerprint" !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'gateway unanchored absorb action/receipt pair is invalid'
      USING ERRCODE = '55000';
  END IF;

  IF action_metadata->>'protocol' IS DISTINCT FROM
       'gateway-unanchored-absorb-v1'
     OR action_metadata->>'requestId' IS DISTINCT FROM event_row."request_id"
     OR action_metadata->>'gatewayBillingEventId' IS DISTINCT FROM event_row."id"
     OR (action_metadata->>'expectedRevision')::INTEGER IS DISTINCT FROM
       action_row."expected_revision"
     OR (action_metadata->>'resultingRevision')::INTEGER IS DISTINCT FROM
       action_row."resulting_revision"
     OR action_metadata->>'reason' IS DISTINCT FROM action_row."reason"
     OR action_metadata->>'actorId' IS DISTINCT FROM action_row."actor_id"
     OR action_metadata->>'idempotencyKey' IS DISTINCT FROM
       action_row."idempotency_key"
     OR action_metadata->>'evidenceHash' IS DISTINCT FROM event_row."evidence_hash"
     OR (action_metadata->>'evidenceRevision')::INTEGER IS DISTINCT FROM 1
     OR action_metadata->>'failureReason' IS DISTINCT FROM
       'settlement_anchor_missing'
     OR action_metadata->>'failureMessage' IS DISTINCT FROM
       event_row."error_message"
     OR action_metadata->>'originalAccountCurrency' IS DISTINCT FROM
       source_currency
     OR action_metadata->>'originalDeploymentCurrency' IS DISTINCT FROM
       target_currency
     OR action_metadata->>'currentAccountCurrency' IS DISTINCT FROM
       target_currency
     OR action_metadata->>'currentDeploymentCurrency' IS DISTINCT FROM
       target_currency
     OR action_metadata->>'anchorAbsent' IS DISTINCT FROM 'true'
     OR action_metadata->>'fundingReservationAbsent' IS DISTINCT FROM 'true'
     OR action_metadata->>'tokenUsageAbsent' IS DISTINCT FROM 'true'
     OR action_metadata->>'priorSettlementReceiptAbsent' IS DISTINCT FROM 'true'
     OR action_metadata->>'financialMutationAbsent' IS DISTINCT FROM 'true'
     OR (action_metadata->>'amountUsd')::NUMERIC IS DISTINCT FROM 0
     OR (action_metadata->>'customerDeductionUsd')::NUMERIC IS DISTINCT FROM 0
     OR action_metadata->>'settlementFingerprint' IS DISTINCT FROM
       receipt_row."settlement_fingerprint"
     OR NULLIF(action_metadata->>'currencyRepairEligibleEventId', '') IS NULL
     OR action_metadata->>'currencyRepairEligibleEventRowHash'
       !~ '^[0-9a-f]{64}$'
     OR action_metadata->>'currencyRepairEligibilityCode' IS DISTINCT FROM
       'BILLING_CURRENCY_MIGRATION_REQUIRED'
     OR action_metadata->>'currencyRepairFailureReason' IS DISTINCT FROM
       'settlement_anchor_missing'
     OR action_metadata->>'currencyRepairErrorFingerprint' IS DISTINCT FROM
       'f7c470fb73da49f0ed8b517ec5993e0c3a1796e08b4b8835c03d96fb9364d137'
     OR NULLIF(action_metadata->>'currencyRepairEvidenceId', '') IS NULL
  THEN
    RAISE EXCEPTION 'gateway unanchored absorb action proof is invalid'
      USING ERRCODE = '55000';
  END IF;

  IF receipt_payload->>'protocol' IS DISTINCT FROM
       'gateway-unanchored-absorb-v1'
     OR receipt_payload - 'fundingOutcome' - 'settlementFingerprint'
       IS DISTINCT FROM action_metadata - 'settlementFingerprint'
     OR receipt_payload->>'fundingOutcome' IS DISTINCT FROM 'ABSORBED'
     OR receipt_payload->>'settlementFingerprint' IS DISTINCT FROM
       receipt_row."settlement_fingerprint"
     OR encode(sha256(convert_to(
       gateway_unanchored_absorb_canonical_json(
         receipt_payload - 'settlementFingerprint'
       ),
       'UTF8'
     )), 'hex') IS DISTINCT FROM receipt_row."settlement_fingerprint"
     OR (receipt_payload->>'amountUsd')::NUMERIC IS DISTINCT FROM 0
     OR (receipt_payload->>'customerDeductionUsd')::NUMERIC IS DISTINCT FROM 0
  THEN
    RAISE EXCEPTION 'gateway unanchored absorb receipt proof is invalid'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO repair_run
  FROM "billing_account_currency_label_repair_runs"
  WHERE "id" = action_metadata->>'currencyRepairRunId';
  SELECT * INTO repair_item
  FROM "billing_account_currency_label_repair_items"
  WHERE "id" = action_metadata->>'currencyRepairItemId';
  SELECT * INTO eligible_event
  FROM "billing_account_currency_label_repair_eligible_events"
  WHERE "id" = action_metadata->>'currencyRepairEligibleEventId';
  IF repair_run."id" IS NULL
     OR repair_item."id" IS NULL
     OR eligible_event."id" IS NULL
     OR repair_run."status" IS DISTINCT FROM 'APPLIED'
     OR (
       SELECT COUNT(*)
       FROM "billing_account_currency_label_repair_items" AS manifest_item
       WHERE manifest_item."run_id" = repair_run."id"
     ) IS DISTINCT FROM repair_run."account_count"::BIGINT
     OR repair_item."run_id" IS DISTINCT FROM repair_run."id"
     OR repair_run."manifest_hash" IS DISTINCT FROM
       action_metadata->>'currencyRepairManifestHash'
     OR repair_run."manifest_hash" IS DISTINCT FROM
       receipt_payload->>'currencyRepairManifestHash'
     OR repair_run."source_currency" IS DISTINCT FROM source_currency
     OR repair_run."target_currency" IS DISTINCT FROM target_currency
     OR repair_item."before_currency" IS DISTINCT FROM source_currency
     OR repair_item."after_currency" IS DISTINCT FROM target_currency
     OR eligible_event."run_id" IS DISTINCT FROM repair_run."id"
     OR eligible_event."item_id" IS DISTINCT FROM repair_item."id"
     OR eligible_event."gateway_billing_event_id" IS DISTINCT FROM event_row."id"
     OR eligible_event."request_id" IS DISTINCT FROM event_row."request_id"
     OR eligible_event."evidence_hash" IS DISTINCT FROM event_row."evidence_hash"
     OR eligible_event."failure_code" IS DISTINCT FROM
       'BILLING_CURRENCY_MIGRATION_REQUIRED'
     OR eligible_event."failure_reason" IS DISTINCT FROM
       'settlement_anchor_missing'
     OR eligible_event."error_fingerprint" IS DISTINCT FROM
       'f7c470fb73da49f0ed8b517ec5993e0c3a1796e08b4b8835c03d96fb9364d137'
     OR eligible_event."error_message" IS DISTINCT FROM event_row."error_message"
     OR eligible_event."row_hash" IS DISTINCT FROM
       action_metadata->>'currencyRepairEligibleEventRowHash'
     OR eligible_event."evidence_id" IS DISTINCT FROM
       action_metadata->>'currencyRepairEvidenceId'
     OR receipt_payload->>'currencyRepairEligibleEventId' IS DISTINCT FROM
       eligible_event."id"
     OR receipt_payload->>'currencyRepairEligibleEventRowHash' IS DISTINCT FROM
       eligible_event."row_hash"
     OR receipt_payload->>'currencyRepairEligibilityCode' IS DISTINCT FROM
       eligible_event."failure_code"
     OR receipt_payload->>'currencyRepairFailureReason' IS DISTINCT FROM
       eligible_event."failure_reason"
     OR receipt_payload->>'currencyRepairErrorFingerprint' IS DISTINCT FROM
       eligible_event."error_fingerprint"
     OR receipt_payload->>'currencyRepairEvidenceId' IS DISTINCT FROM
       eligible_event."evidence_id"
     OR encode(sha256(convert_to(jsonb_build_object(
       'runId', repair_run."id",
       'billingAccountId', repair_item."billing_account_id",
       'gatewayBillingEventId', eligible_event."gateway_billing_event_id",
       'requestId', eligible_event."request_id",
       'evidenceId', eligible_event."evidence_id",
       'evidenceHash', eligible_event."evidence_hash",
       'failureCode', eligible_event."failure_code",
       'failureReason', eligible_event."failure_reason",
       'errorMessage', eligible_event."error_message",
       'errorFingerprint', eligible_event."error_fingerprint",
       'eventSnapshot', eligible_event."event_snapshot"
     )::TEXT, 'UTF8')), 'hex') IS DISTINCT FROM eligible_event."row_hash"
  THEN
    RAISE EXCEPTION 'gateway unanchored absorb currency repair proof is invalid'
      USING ERRCODE = '55000';
  END IF;

  -- The mutable key/tenant/account chain is a commit-time projection target,
  -- not a permanent prohibition on later account administration. The
  -- append-only eligible snapshot plus action/receipt freezes the chain used
  -- for this command; replay and projection recovery re-resolve it and fail
  -- closed after any legitimate rebind. Consequently we intentionally do not
  -- install reverse triggers on api_keys or tenants.
  SELECT * INTO current_api_key
  FROM "api_keys"
  WHERE "id" = event_row."api_key_id";
  SELECT * INTO current_tenant
  FROM "tenants"
  WHERE "id" = event_row."tenant_id";
  SELECT * INTO current_account
  FROM "billing_accounts"
  WHERE "id" = current_tenant."billing_account_id";
  IF current_api_key."id" IS NULL
     OR current_api_key."deleted_at" IS NOT NULL
     OR current_tenant."id" IS NULL
     OR current_tenant."deleted_at" IS NOT NULL
     OR current_account."id" IS NULL
     OR current_account."deleted_at" IS NOT NULL
     OR current_api_key."tenant_id" IS DISTINCT FROM current_tenant."id"
     OR repair_item."billing_account_id" IS DISTINCT FROM current_account."id"
     OR current_account."currency" IS DISTINCT FROM target_currency
     OR (
       NOT EXISTS (
         SELECT 1
         FROM "system_configs" AS deployment_config
         WHERE deployment_config."key" = 'deploymentConfig'
           AND lower(deployment_config."value"::JSONB->>'region') = 'domestic'
           AND upper(deployment_config."value"::JSONB->>'currency') = target_currency
       )
       AND NOT (
         COALESCE(
           current_setting(
             'billing.allow_legacy_currency_failure_fixture',
             TRUE
           ) = 'true',
           FALSE
         )
         AND lower(current_database()) ~ '(test|ci)'
         AND target_currency = 'CNY'
       )
     )
     OR action_metadata->>'currentApiKeyId' IS DISTINCT FROM current_api_key."id"
     OR action_metadata->>'currentTenantId' IS DISTINCT FROM current_tenant."id"
     OR action_metadata->>'currentBillingAccountId' IS DISTINCT FROM
       current_account."id"
  THEN
    RAISE EXCEPTION 'gateway unanchored absorb current subject projection is invalid'
      USING ERRCODE = '55000';
  END IF;

  SELECT COUNT(*) INTO evidence_count
  FROM "gateway_usage_evidences" AS evidence
  WHERE evidence."gateway_billing_event_id" = event_row."id"
    AND evidence."request_id" = event_row."request_id"
    AND evidence."event_id" IS NOT DISTINCT FROM event_row."event_id"
    AND evidence."source" = 'GATEWAY_USAGE_EVENT'
    AND evidence."evidence_revision" = 1
    AND evidence."id" = eligible_event."evidence_id"
    AND evidence."evidence_hash" = event_row."evidence_hash"
    AND evidence."raw_evidence" = event_row."raw_event"
    AND encode(sha256(convert_to(
      gateway_unanchored_absorb_canonical_json(event_row."raw_event"),
      'UTF8'
    )), 'hex') = event_row."evidence_hash"
    AND evidence."raw_evidence"->>'request_id' = event_row."request_id"
    AND evidence."raw_evidence"->>'key_id' = event_row."api_key_id"
    AND (
      evidence."raw_evidence"->>'tenant_id' = event_row."tenant_id"
      OR evidence."raw_evidence"->'labels'->>'tenant_id' = event_row."tenant_id"
      OR evidence."raw_evidence"->'labels'->>'tenantId' = event_row."tenant_id"
    )
    AND eligible_event."event_snapshot"->'event'->>'status' = 'QUARANTINED'
    AND eligible_event."event_snapshot"->'event'->>'reason' =
      'settlement_anchor_missing'
    AND eligible_event."event_snapshot"->'event'->>'reconciliation_status' =
      'MANUAL_REVIEW'
    AND eligible_event."event_snapshot"->'event'->'funding_outcome' = 'null'::JSONB
    AND (eligible_event."event_snapshot"->'event'->>'revision')::INTEGER =
      action_row."expected_revision"
    AND (eligible_event."event_snapshot"->'event'->>'pending_exposure_usd')::NUMERIC = 0
    AND (eligible_event."event_snapshot"->'event'->>'pending_hold_usd')::NUMERIC = 0
    AND (eligible_event."event_snapshot"->'event')
      - 'status'
      - 'reason'
      - 'reconciliation_status'
      - 'funding_outcome'
      - 'revision'
      - 'pending_exposure_usd'
      - 'pending_hold_usd'
      - 'processed_at'
      - 'updated_at'
      IS NOT DISTINCT FROM
      (to_jsonb(event_row)
        - 'raw_event'
        - 'billing_result'
        - 'subject_snapshot'
        - 'pricing_snapshot'
        - 'status'
        - 'reason'
        - 'reconciliation_status'
        - 'funding_outcome'
        - 'revision'
        - 'pending_exposure_usd'
        - 'pending_hold_usd'
        - 'processed_at'
        - 'updated_at')
    AND eligible_event."event_snapshot"->'evidence'
      IS NOT DISTINCT FROM to_jsonb(evidence) - 'raw_evidence'
    AND eligible_event."event_snapshot"->>'resolvedBillingAccountId' =
      current_account."id";
  IF evidence_count <> 1 THEN
    RAISE EXCEPTION 'gateway unanchored absorb evidence proof is invalid'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
       SELECT 1 FROM "gateway_usage_settlement_anchors"
       WHERE "gateway_billing_event_id" = event_row."id"
     ) OR EXISTS (
       SELECT 1 FROM "gateway_usage_funding_reservations"
       WHERE "gateway_billing_event_id" = event_row."id"
     ) OR EXISTS (
       SELECT 1 FROM "token_usage"
       WHERE "gateway_billing_event_id" = event_row."id"
     ) OR EXISTS (
       SELECT 1 FROM "gateway_usage_platform_losses"
       WHERE "gateway_billing_event_id" = event_row."id"
     ) OR EXISTS (
       SELECT 1 FROM "usage_loss_recognition_claims"
       WHERE "gateway_billing_event_id" = event_row."id"
     ) OR EXISTS (
       SELECT 1 FROM "historical_platform_loss_lines"
       WHERE "gateway_billing_event_id" = event_row."id"
     ) OR EXISTS (
       SELECT 1 FROM "credit_transactions"
       WHERE "request_id" = event_row."request_id"
     )
  THEN
    RAISE EXCEPTION 'gateway unanchored absorb has a forbidden financial fact'
      USING ERRCODE = '55000';
  END IF;
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION 'gateway unanchored absorb JSON proof is malformed'
      USING ERRCODE = '55000';
END;
$$;

CREATE OR REPLACE FUNCTION validate_gateway_unanchored_currency_absorb_event()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM assert_gateway_unanchored_currency_absorb_terminal(NEW."id");
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION validate_gateway_unanchored_currency_absorb_child()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Serialize every reverse-edge proof on the same event row locked by the
  -- absorb command. Without this lock, a concurrent child insert and terminal
  -- transition could each validate against the other's uncommitted snapshot.
  PERFORM 1
  FROM "gateway_billing_events"
  WHERE "id" = NEW."gateway_billing_event_id"
  FOR UPDATE;
  PERFORM assert_gateway_unanchored_currency_absorb_terminal(
    NEW."gateway_billing_event_id"
  );
  RETURN NULL;
END;
$$;

CREATE OR REPLACE FUNCTION
  validate_gateway_unanchored_currency_absorb_credit_transaction()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_event_id TEXT;
  old_request_id TEXT;
  new_request_id TEXT;
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    old_request_id := OLD."request_id";
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE') THEN
    new_request_id := NEW."request_id";
  END IF;

  -- Serialize on the same event row that the absorb command locks. Sorting
  -- closes the A<->B request-id update deadlock while the deferred assertion
  -- closes the otherwise possible credit/terminal write skew.
  FOR target_event_id IN
    SELECT event_row."id"
    FROM "gateway_billing_events" AS event_row
    WHERE event_row."request_id" IN (old_request_id, new_request_id)
    ORDER BY event_row."id"
    FOR UPDATE
  LOOP
    PERFORM assert_gateway_unanchored_currency_absorb_terminal(target_event_id);
  END LOOP;
  RETURN NULL;
END;
$$;

CREATE INDEX "credit_transactions_gateway_request_id_idx"
  ON "credit_transactions"("request_id")
  WHERE "request_id" IS NOT NULL;

-- Updating the event and appending action/receipt are one atomic terminal
-- transition, so each participant checks the final transaction image.
CREATE CONSTRAINT TRIGGER gateway_unanchored_absorb_event_terminal_pair
  AFTER INSERT OR UPDATE ON "gateway_billing_events"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION validate_gateway_unanchored_currency_absorb_event();

CREATE CONSTRAINT TRIGGER gateway_unanchored_absorb_action_terminal_pair
  AFTER INSERT ON "gateway_usage_reconciliation_actions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION validate_gateway_unanchored_currency_absorb_child();

CREATE CONSTRAINT TRIGGER gateway_unanchored_absorb_receipt_terminal_pair
  AFTER INSERT ON "gateway_usage_settlement_receipts"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION validate_gateway_unanchored_currency_absorb_child();

-- Close post-terminal bypasses as well. Any later financial fact linked to a
-- v1 event re-runs the same absence proof and aborts that transaction.
CREATE CONSTRAINT TRIGGER gateway_unanchored_absorb_anchor_absence
  AFTER INSERT ON "gateway_usage_settlement_anchors"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION validate_gateway_unanchored_currency_absorb_child();

CREATE CONSTRAINT TRIGGER gateway_unanchored_absorb_reservation_absence
  AFTER INSERT OR UPDATE ON "gateway_usage_funding_reservations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION validate_gateway_unanchored_currency_absorb_child();

CREATE CONSTRAINT TRIGGER gateway_unanchored_absorb_token_usage_absence
  AFTER INSERT ON "token_usage"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW."gateway_billing_event_id" IS NOT NULL)
  EXECUTE FUNCTION validate_gateway_unanchored_currency_absorb_child();

CREATE CONSTRAINT TRIGGER gateway_unanchored_absorb_platform_loss_absence
  AFTER INSERT ON "gateway_usage_platform_losses"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION validate_gateway_unanchored_currency_absorb_child();

CREATE CONSTRAINT TRIGGER gateway_unanchored_absorb_recognition_absence
  AFTER INSERT ON "usage_loss_recognition_claims"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW."gateway_billing_event_id" IS NOT NULL)
  EXECUTE FUNCTION validate_gateway_unanchored_currency_absorb_child();

CREATE CONSTRAINT TRIGGER gateway_unanchored_absorb_historical_loss_absence
  AFTER INSERT ON "historical_platform_loss_lines"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  WHEN (NEW."gateway_billing_event_id" IS NOT NULL)
  EXECUTE FUNCTION validate_gateway_unanchored_currency_absorb_child();

CREATE CONSTRAINT TRIGGER gateway_unanchored_absorb_credit_transaction_absence
  AFTER INSERT OR UPDATE OR DELETE ON "credit_transactions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION
    validate_gateway_unanchored_currency_absorb_credit_transaction();
