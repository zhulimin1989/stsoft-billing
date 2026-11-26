-- Allocate the BALANCE funding queue at the immutable Billing first receipt,
-- not when the later wallet transaction happens. Existing append-only anchors
-- are deliberately not rewritten: they retain NULL protocol/sequence and may
-- only be manually reconciled or absorbed. CREDITS never joins this queue.
CREATE SEQUENCE "gateway_usage_first_receipt_sequence_seq" AS BIGINT;

ALTER TABLE "gateway_usage_settlement_anchors"
  ADD COLUMN "first_receipt_sequence" BIGINT,
  ADD COLUMN "funding_reservation_protocol" TEXT,
  ADD COLUMN "billing_currency" TEXT;

-- Receipts predate the funding protocol. Preserve historical rows as
-- currency-unknown instead of guessing from today's deployment setting.
ALTER TABLE "gateway_usage_settlement_receipts"
  ADD COLUMN "billing_currency" TEXT;

-- The database, not an application session variable, owns whether ordinary
-- financial settlement is still observing the additive evidence contract or
-- enforcing build authority. Runtime gets read-only access; a drained
-- two-approver operation is the only transition path.
CREATE TABLE "gateway_usage_evidence_contract_rollout_control" (
  "id" INTEGER NOT NULL,
  "mode" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "change_ticket" TEXT NOT NULL,
  "approver_one" TEXT NOT NULL,
  "approver_two" TEXT NOT NULL,
  "changed_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "gateway_usage_evidence_contract_rollout_control_pkey"
    PRIMARY KEY ("id"),
  CONSTRAINT "gateway_usage_evidence_contract_rollout_control_singleton_check"
    CHECK ("id" = 1),
  CONSTRAINT "gateway_usage_evidence_contract_rollout_control_shape_check"
    CHECK (
      "mode" IN ('SHADOW', 'ENFORCE')
      AND "revision" > 0
      AND NULLIF(btrim("change_ticket"), '') IS NOT NULL
      AND NULLIF(btrim("approver_one"), '') IS NOT NULL
      AND NULLIF(btrim("approver_two"), '') IS NOT NULL
      AND lower(btrim("approver_one")) <> lower(btrim("approver_two"))
    )
);

INSERT INTO "gateway_usage_evidence_contract_rollout_control" (
  "id", "mode", "revision", "change_ticket",
  "approver_one", "approver_two", "changed_at"
) VALUES (
  1,
  'SHADOW',
  1,
  'MIGRATION-20260806000124',
  'migration-owner',
  'release-controller',
  date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')
);

CREATE OR REPLACE FUNCTION enforce_gateway_usage_evidence_contract_rollout_control()
RETURNS trigger
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP <> 'UPDATE' THEN
    RAISE EXCEPTION 'gateway evidence contract rollout control is a protected singleton'
      USING ERRCODE = '55000';
  END IF;
  IF current_setting(
      'ruidong.gateway_evidence_contract_rollout_transition',
      TRUE
    ) IS DISTINCT FROM 'v1'
  THEN
    RAISE EXCEPTION 'gateway evidence contract rollout requires controlled transition function'
      USING ERRCODE = '55000';
  END IF;
  IF NEW.id IS DISTINCT FROM OLD.id
     OR NEW.revision IS DISTINCT FROM OLD.revision + 1
     OR NEW.mode IS NOT DISTINCT FROM OLD.mode
     OR NEW.changed_at < OLD.changed_at THEN
    RAISE EXCEPTION 'gateway evidence contract rollout transition is invalid'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER gateway_usage_evidence_contract_rollout_control_guard
  BEFORE INSERT OR UPDATE OR DELETE
  ON "gateway_usage_evidence_contract_rollout_control"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_gateway_usage_evidence_contract_rollout_control();

CREATE OR REPLACE FUNCTION transition_gateway_usage_evidence_contract_mode(
  requested_mode TEXT,
  requested_change_ticket TEXT,
  requested_approver_one TEXT,
  requested_approver_two TEXT
)
RETURNS INTEGER
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  normalized_mode TEXT := upper(btrim(requested_mode));
  normalized_ticket TEXT := btrim(requested_change_ticket);
  normalized_approver_one TEXT := btrim(requested_approver_one);
  normalized_approver_two TEXT := btrim(requested_approver_two);
  control_row RECORD;
  previous_transition_marker TEXT;
  resulting_revision INTEGER;
BEGIN
  IF normalized_mode NOT IN ('SHADOW', 'ENFORCE') THEN
    RAISE EXCEPTION 'gateway evidence contract rollout mode is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF NULLIF(normalized_ticket, '') IS NULL
     OR NULLIF(normalized_approver_one, '') IS NULL
     OR NULLIF(normalized_approver_two, '') IS NULL
     OR lower(normalized_approver_one) = lower(normalized_approver_two) THEN
    RAISE EXCEPTION 'gateway evidence contract rollout requires ticket and two distinct approvers'
      USING ERRCODE = '22023';
  END IF;

  SELECT * INTO control_row
  FROM public.gateway_usage_evidence_contract_rollout_control
  WHERE id = 1
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gateway evidence contract rollout control is missing'
      USING ERRCODE = '55000';
  END IF;
  IF control_row.mode = normalized_mode THEN
    RAISE EXCEPTION 'gateway evidence contract rollout mode is already current'
      USING ERRCODE = '23505';
  END IF;

  previous_transition_marker := current_setting(
    'ruidong.gateway_evidence_contract_rollout_transition',
    TRUE
  );
  PERFORM set_config(
    'ruidong.gateway_evidence_contract_rollout_transition',
    'v1',
    TRUE
  );
  UPDATE public.gateway_usage_evidence_contract_rollout_control
  SET
    mode = normalized_mode,
    revision = control_row.revision + 1,
    change_ticket = normalized_ticket,
    approver_one = normalized_approver_one,
    approver_two = normalized_approver_two,
    changed_at = date_trunc(
      'milliseconds',
      clock_timestamp() AT TIME ZONE 'UTC'
    )
  WHERE id = 1
  RETURNING revision INTO resulting_revision;
  PERFORM set_config(
    'ruidong.gateway_evidence_contract_rollout_transition',
    COALESCE(previous_transition_marker, ''),
    TRUE
  );
  RETURN resulting_revision;
END;
$$;

CREATE OR REPLACE FUNCTION current_gateway_usage_evidence_contract_mode()
RETURNS TEXT
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT mode
  FROM public.gateway_usage_evidence_contract_rollout_control
  WHERE id = 1
$$;

REVOKE ALL ON TABLE "gateway_usage_evidence_contract_rollout_control" FROM PUBLIC;
GRANT SELECT ON TABLE "gateway_usage_evidence_contract_rollout_control" TO PUBLIC;
REVOKE ALL ON FUNCTION transition_gateway_usage_evidence_contract_mode(
  TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION current_gateway_usage_evidence_contract_mode() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_gateway_usage_evidence_contract_mode() TO PUBLIC;

-- A producer build is financial authority, not a string shape supplied by the
-- producer itself.  Operations records every authorization transition through
-- one database-owned append function.  The immutable hash chain, independent
-- approvers and change ticket make an authorization (or revocation) durable
-- evidence instead of a mutable runtime flag.
CREATE TABLE "gateway_producer_build_authorization_events" (
  "id" TEXT NOT NULL,
  "producer_build_sha" TEXT NOT NULL,
  "revision" INTEGER NOT NULL,
  "decision" TEXT NOT NULL,
  "effective_at" TIMESTAMP(3) NOT NULL,
  "change_ticket" TEXT NOT NULL,
  "approver_one" TEXT NOT NULL,
  "approver_two" TEXT NOT NULL,
  "previous_authority_hash" TEXT,
  "authority_hash" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "gateway_producer_build_authorization_events_pkey"
    PRIMARY KEY ("id"),
  CONSTRAINT "gateway_producer_build_authorization_events_sha_revision_key"
    UNIQUE ("producer_build_sha", "revision"),
  CONSTRAINT "gateway_producer_build_authorization_events_authority_hash_key"
    UNIQUE ("authority_hash"),
  CONSTRAINT "gateway_producer_build_authorization_events_proof_key"
    UNIQUE ("id", "revision", "authority_hash"),
  CONSTRAINT "gateway_producer_build_authorization_events_shape_check"
    CHECK (
      "producer_build_sha" ~ '^([0-9a-f]{40}|sha256:[0-9a-f]{64})$'
      AND "revision" > 0
      AND "decision" IN ('AUTHORIZED', 'REVOKED')
      AND NULLIF(btrim("change_ticket"), '') IS NOT NULL
      AND NULLIF(btrim("approver_one"), '') IS NOT NULL
      AND NULLIF(btrim("approver_two"), '') IS NOT NULL
      AND lower(btrim("approver_one")) <> lower(btrim("approver_two"))
      AND "authority_hash" ~ '^[0-9a-f]{64}$'
      AND (
        ("revision" = 1 AND "previous_authority_hash" IS NULL)
        OR
        ("revision" > 1 AND "previous_authority_hash" ~ '^[0-9a-f]{64}$')
      )
      AND "effective_at" = "created_at"
    )
);

CREATE INDEX "gateway_producer_build_authorization_events_sha_effective_idx"
  ON "gateway_producer_build_authorization_events"(
    "producer_build_sha", "effective_at", "revision"
  );

CREATE OR REPLACE FUNCTION enforce_gateway_producer_build_authorization_append()
RETURNS trigger
LANGUAGE plpgsql
AS $$
DECLARE
  prior_event RECORD;
  expected_payload JSONB;
  expected_hash TEXT;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'gateway producer build authorization events are append-only'
      USING ERRCODE = '55000';
  END IF;

  IF current_setting(
      'ruidong.gateway_producer_build_authority_append',
      TRUE
    ) IS DISTINCT FROM 'v1'
  THEN
    RAISE EXCEPTION 'gateway producer build authorization requires controlled append function'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO prior_event
  FROM public.gateway_producer_build_authorization_events
  WHERE producer_build_sha = NEW.producer_build_sha
  ORDER BY revision DESC
  LIMIT 1;

  IF NOT FOUND THEN
    IF NEW.revision IS DISTINCT FROM 1
       OR NEW.previous_authority_hash IS NOT NULL
       OR NEW.decision IS DISTINCT FROM 'AUTHORIZED' THEN
      RAISE EXCEPTION 'first gateway producer build authority event must authorize revision 1'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW.revision IS DISTINCT FROM prior_event.revision + 1
     OR NEW.previous_authority_hash IS DISTINCT FROM prior_event.authority_hash
     OR NEW.decision IS NOT DISTINCT FROM prior_event.decision
     OR NEW.effective_at < prior_event.effective_at THEN
    RAISE EXCEPTION 'gateway producer build authority chain is not sequential'
      USING ERRCODE = '55000';
  END IF;

  expected_payload := jsonb_build_object(
    'protocol', 'gateway-producer-build-authority-v1',
    'producerBuildSha', NEW.producer_build_sha,
    'revision', NEW.revision,
    'decision', NEW.decision,
    'effectiveAt', NEW.effective_at,
    'changeTicket', NEW.change_ticket,
    'approverOne', NEW.approver_one,
    'approverTwo', NEW.approver_two,
    'previousAuthorityHash', NEW.previous_authority_hash
  );
  expected_hash := encode(
    sha256(convert_to(expected_payload::TEXT, 'UTF8')),
    'hex'
  );
  IF NEW.authority_hash IS DISTINCT FROM expected_hash THEN
    RAISE EXCEPTION 'gateway producer build authority hash is invalid'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$;

CREATE TRIGGER gateway_producer_build_authorization_events_append_only
  BEFORE INSERT OR UPDATE OR DELETE
  ON "gateway_producer_build_authorization_events"
  FOR EACH ROW
  EXECUTE FUNCTION enforce_gateway_producer_build_authorization_append();

CREATE OR REPLACE FUNCTION append_gateway_producer_build_authorization(
  requested_producer_build_sha TEXT,
  requested_decision TEXT,
  requested_change_ticket TEXT,
  requested_approver_one TEXT,
  requested_approver_two TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  normalized_sha TEXT := lower(btrim(requested_producer_build_sha));
  normalized_decision TEXT := upper(btrim(requested_decision));
  normalized_ticket TEXT := btrim(requested_change_ticket);
  normalized_approver_one TEXT := btrim(requested_approver_one);
  normalized_approver_two TEXT := btrim(requested_approver_two);
  prior_event RECORD;
  allocated_revision INTEGER;
  allocated_effective_at TIMESTAMP(3);
  allocated_previous_hash TEXT;
  authority_payload JSONB;
  allocated_authority_hash TEXT;
  previous_append_marker TEXT;
BEGIN
  IF normalized_sha IS NULL
     OR normalized_sha !~ '^([0-9a-f]{40}|sha256:[0-9a-f]{64})$' THEN
    RAISE EXCEPTION 'gateway producer build authority requires a full immutable SHA'
      USING ERRCODE = '22023';
  END IF;
  IF normalized_decision NOT IN ('AUTHORIZED', 'REVOKED') THEN
    RAISE EXCEPTION 'gateway producer build authority decision is invalid'
      USING ERRCODE = '22023';
  END IF;
  IF NULLIF(normalized_ticket, '') IS NULL
     OR NULLIF(normalized_approver_one, '') IS NULL
     OR NULLIF(normalized_approver_two, '') IS NULL
     OR lower(normalized_approver_one) = lower(normalized_approver_two) THEN
    RAISE EXCEPTION 'gateway producer build authority requires ticket and two distinct approvers'
      USING ERRCODE = '22023';
  END IF;

  -- The same lock is taken by evidence INSERT, closing the race where a
  -- revocation could commit between authority selection and evidence freeze.
  PERFORM pg_advisory_xact_lock(60806, hashtext(normalized_sha));
  SELECT * INTO prior_event
  FROM public.gateway_producer_build_authorization_events
  WHERE producer_build_sha = normalized_sha
  ORDER BY revision DESC
  LIMIT 1
  FOR UPDATE;

  IF FOUND THEN
    IF normalized_decision = prior_event.decision THEN
      RAISE EXCEPTION 'gateway producer build authority decision is already current'
        USING ERRCODE = '23505';
    END IF;
    allocated_revision := prior_event.revision + 1;
    allocated_previous_hash := prior_event.authority_hash;
    allocated_effective_at := date_trunc(
      'milliseconds',
      clock_timestamp() AT TIME ZONE 'UTC'
    );
  ELSE
    IF normalized_decision <> 'AUTHORIZED' THEN
      RAISE EXCEPTION 'a gateway producer build must be authorized before revocation'
        USING ERRCODE = '55000';
    END IF;
    allocated_revision := 1;
    allocated_previous_hash := NULL;
    allocated_effective_at := date_trunc(
      'milliseconds',
      clock_timestamp() AT TIME ZONE 'UTC'
    );
  END IF;

  authority_payload := jsonb_build_object(
    'protocol', 'gateway-producer-build-authority-v1',
    'producerBuildSha', normalized_sha,
    'revision', allocated_revision,
    'decision', normalized_decision,
    'effectiveAt', allocated_effective_at,
    'changeTicket', normalized_ticket,
    'approverOne', normalized_approver_one,
    'approverTwo', normalized_approver_two,
    'previousAuthorityHash', allocated_previous_hash
  );
  allocated_authority_hash := encode(
    sha256(convert_to(authority_payload::TEXT, 'UTF8')),
    'hex'
  );

  previous_append_marker := current_setting(
    'ruidong.gateway_producer_build_authority_append',
    TRUE
  );
  PERFORM set_config(
    'ruidong.gateway_producer_build_authority_append',
    'v1',
    TRUE
  );
  INSERT INTO public.gateway_producer_build_authorization_events (
    id,
    producer_build_sha,
    revision,
    decision,
    effective_at,
    change_ticket,
    approver_one,
    approver_two,
    previous_authority_hash,
    authority_hash,
    created_at
  ) VALUES (
    gen_random_uuid()::TEXT,
    normalized_sha,
    allocated_revision,
    normalized_decision,
    allocated_effective_at,
    normalized_ticket,
    normalized_approver_one,
    normalized_approver_two,
    allocated_previous_hash,
    allocated_authority_hash,
    allocated_effective_at
  );
  PERFORM set_config(
    'ruidong.gateway_producer_build_authority_append',
    COALESCE(previous_append_marker, ''),
    TRUE
  );

  RETURN allocated_authority_hash;
END;
$$;

CREATE OR REPLACE FUNCTION current_gateway_producer_build_authorizations()
RETURNS TABLE (
  producer_build_sha TEXT,
  revision INTEGER,
  authority_hash TEXT
)
LANGUAGE sql
STABLE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
  SELECT
    authority_event.producer_build_sha,
    authority_event.revision,
    authority_event.authority_hash
  FROM public.gateway_producer_build_authorization_events AS authority_event
  WHERE authority_event.decision = 'AUTHORIZED'
    AND authority_event.effective_at <= date_trunc(
      'milliseconds',
      statement_timestamp() AT TIME ZONE 'UTC'
    )
    AND NOT EXISTS (
      SELECT 1
      FROM public.gateway_producer_build_authorization_events AS later_event
      WHERE later_event.producer_build_sha = authority_event.producer_build_sha
        AND later_event.revision > authority_event.revision
        AND later_event.effective_at <= date_trunc(
          'milliseconds',
          statement_timestamp() AT TIME ZONE 'UTC'
        )
    )
  ORDER BY authority_event.producer_build_sha
$$;

ALTER TABLE "gateway_usage_evidences"
  ADD COLUMN "producer_build_authorization_event_id" TEXT,
  ADD COLUMN "producer_build_authorization_revision" INTEGER,
  ADD COLUMN "producer_build_authority_hash" TEXT,
  ADD CONSTRAINT "gateway_usage_evidences_build_authorization_tuple_check"
    CHECK (
      (
        "producer_build_authorization_event_id" IS NULL
        AND "producer_build_authorization_revision" IS NULL
        AND "producer_build_authority_hash" IS NULL
      )
      OR
      (
        "producer_build_authorization_event_id" IS NOT NULL
        AND "producer_build_authorization_revision" IS NOT NULL
        AND "producer_build_authorization_revision" > 0
        AND "producer_build_authority_hash" ~ '^[0-9a-f]{64}$'
      )
    ),
  ADD CONSTRAINT "gateway_usage_evidences_build_authorization_event_fkey"
    FOREIGN KEY (
      "producer_build_authorization_event_id",
      "producer_build_authorization_revision",
      "producer_build_authority_hash"
    ) REFERENCES "gateway_producer_build_authorization_events"(
      "id", "revision", "authority_hash"
    ) ON DELETE RESTRICT ON UPDATE RESTRICT;

CREATE OR REPLACE FUNCTION freeze_gateway_usage_evidence_build_authorization()
RETURNS trigger
LANGUAGE plpgsql
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  raw_build_sha TEXT;
  authority_event RECORD;
BEGIN
  -- These columns are database output. Ignore any writer nomination so an old
  -- or compromised producer cannot point evidence at a convenient authority.
  NEW.producer_build_authorization_event_id := NULL;
  NEW.producer_build_authorization_revision := NULL;
  NEW.producer_build_authority_hash := NULL;

  raw_build_sha := NULLIF(btrim(NEW.raw_evidence->>'producer_build_sha'), '');
  IF NEW.producer_build_sha IS NULL
     OR NEW.producer_build_sha IS DISTINCT FROM raw_build_sha
     OR NEW.producer_build_sha !~ '^([0-9a-f]{40}|sha256:[0-9a-f]{64})$' THEN
    RETURN NEW;
  END IF;

  PERFORM pg_advisory_xact_lock(60806, hashtext(NEW.producer_build_sha));
  SELECT * INTO authority_event
  FROM public.gateway_producer_build_authorization_events
  WHERE producer_build_sha = NEW.producer_build_sha
    AND effective_at <= NEW.observed_at
  ORDER BY revision DESC
  LIMIT 1;

  IF FOUND AND authority_event.decision = 'AUTHORIZED' THEN
    NEW.producer_build_authorization_event_id := authority_event.id;
    NEW.producer_build_authorization_revision := authority_event.revision;
    NEW.producer_build_authority_hash := authority_event.authority_hash;
  END IF;
  RETURN NEW;
END;
$$;

CREATE TRIGGER gateway_usage_evidences_freeze_build_authorization
  BEFORE INSERT ON "gateway_usage_evidences"
  FOR EACH ROW
  EXECUTE FUNCTION freeze_gateway_usage_evidence_build_authorization();

-- Mutable rollout and build-authority state requires a fresh PostgreSQL
-- statement snapshot at every automatic financial terminal boundary.
CREATE OR REPLACE FUNCTION assert_gateway_financial_read_committed()
RETURNS VOID
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
BEGIN
  IF current_setting('transaction_isolation') IS DISTINCT FROM 'read committed' THEN
    RAISE EXCEPTION 'gateway financial terminal requires READ COMMITTED isolation'
      USING ERRCODE = '55000';
  END IF;
END;
$$;

-- One reusable authority predicate for every automatic terminal money path.
-- It binds the selected immutable evidence to the exact DB-frozen authority
-- tuple and also requires that tuple to remain the current effective tail.
-- Revocation or re-authorization therefore invalidates old evidence without
-- rewriting its historical authorization snapshot.
CREATE OR REPLACE FUNCTION gateway_usage_evidence_has_current_build_authority(
  target_gateway_billing_event_id TEXT,
  target_request_id TEXT,
  target_evidence_hash TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
VOLATILE
SECURITY DEFINER
SET search_path = pg_catalog, public
AS $$
DECLARE
  selected_build_sha TEXT;
  authority_is_current BOOLEAN;
BEGIN
  -- The authority append path and evidence freeze path use this exact lock.
  -- Holding it until settlement commit makes the tail check linearizable: a
  -- revocation either commits before this transaction re-checks and causes a
  -- rollback, or waits until the authorized settlement has committed.
  SELECT selected_evidence.producer_build_sha
  INTO selected_build_sha
  FROM public.gateway_usage_evidences AS selected_evidence
  WHERE selected_evidence.gateway_billing_event_id =
      target_gateway_billing_event_id
    AND selected_evidence.request_id = target_request_id
    AND selected_evidence.evidence_hash = target_evidence_hash;
  IF NOT FOUND OR selected_build_sha IS NULL THEN
    RETURN FALSE;
  END IF;

  PERFORM public.assert_gateway_financial_read_committed();
  PERFORM pg_advisory_xact_lock(60806, hashtext(selected_build_sha));

  -- VOLATILE PL/pgSQL executes this query with a fresh READ COMMITTED command
  -- snapshot after any lock wait. statement_timestamp() would predate that
  -- wait, so use the current DB clock when evaluating the effective tail.
  SELECT EXISTS (
    SELECT 1
    FROM public.gateway_usage_evidences AS selected_evidence
    JOIN public.gateway_producer_build_authorization_events AS build_authority
      ON build_authority.id =
          selected_evidence.producer_build_authorization_event_id
     AND build_authority.revision =
          selected_evidence.producer_build_authorization_revision
     AND build_authority.authority_hash =
          selected_evidence.producer_build_authority_hash
     AND build_authority.producer_build_sha =
          selected_evidence.producer_build_sha
    WHERE selected_evidence.gateway_billing_event_id =
        target_gateway_billing_event_id
      AND selected_evidence.request_id = target_request_id
      AND selected_evidence.evidence_hash = target_evidence_hash
      AND selected_evidence.producer_build_sha = selected_build_sha
      AND selected_evidence.raw_evidence->>'request_id' = target_request_id
      AND selected_evidence.raw_evidence->>'producer_build_sha' =
          selected_evidence.producer_build_sha
      AND build_authority.decision = 'AUTHORIZED'
      AND build_authority.effective_at <= selected_evidence.observed_at
      AND NOT EXISTS (
        SELECT 1
        FROM public.gateway_producer_build_authorization_events AS later_authority
        WHERE later_authority.producer_build_sha =
            build_authority.producer_build_sha
          AND later_authority.revision > build_authority.revision
          AND later_authority.effective_at <= date_trunc(
            'milliseconds',
            clock_timestamp() AT TIME ZONE 'UTC'
          )
      )
  )
  INTO authority_is_current;
  RETURN authority_is_current;
END;
$$;

REVOKE ALL ON TABLE "gateway_producer_build_authorization_events" FROM PUBLIC;
GRANT SELECT ON TABLE "gateway_producer_build_authorization_events" TO PUBLIC;
REVOKE ALL ON FUNCTION append_gateway_producer_build_authorization(
  TEXT, TEXT, TEXT, TEXT, TEXT
) FROM PUBLIC;
REVOKE ALL ON FUNCTION current_gateway_producer_build_authorizations() FROM PUBLIC;
GRANT EXECUTE ON FUNCTION current_gateway_producer_build_authorizations() TO PUBLIC;
REVOKE ALL ON FUNCTION gateway_usage_evidence_has_current_build_authority(
  TEXT, TEXT, TEXT
) FROM PUBLIC;
GRANT EXECUTE ON FUNCTION gateway_usage_evidence_has_current_build_authority(
  TEXT, TEXT, TEXT
) TO PUBLIC;

COMMENT ON TABLE "gateway_producer_build_authorization_events" IS
  'Append-only two-approver authority chain for Gateway builds allowed to produce financial usage evidence.';
COMMENT ON FUNCTION append_gateway_producer_build_authorization(
  TEXT, TEXT, TEXT, TEXT, TEXT
) IS 'Controlled ops-only append path for Gateway build authorization and revocation.';
COMMENT ON FUNCTION assert_gateway_financial_read_committed() IS
  'Fail-closed isolation guard for every automatic Gateway financial terminal path.';
COMMENT ON FUNCTION gateway_usage_evidence_has_current_build_authority(
  TEXT, TEXT, TEXT
) IS 'Validates the selected evidence exact frozen build authority tuple and its current effective tail.';

-- Anchors created before this migration are not guessed or rewritten. NOT
-- VALID keeps rollout safe for any historical orphan, while PostgreSQL still
-- enforces every new anchor immediately. These references preserve the T0
-- identity rows so delayed settlement never depends on a mutable lookup or
-- gets redirected after key rotation/tenant rebind.
ALTER TABLE "gateway_usage_settlement_anchors"
  ADD CONSTRAINT "gateway_usage_settlement_anchors_api_key_fkey"
    FOREIGN KEY ("api_key_id") REFERENCES "api_keys"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
  ADD CONSTRAINT "gateway_usage_settlement_anchors_user_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
  ADD CONSTRAINT "gateway_usage_settlement_anchors_tenant_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
  ADD CONSTRAINT "gateway_usage_settlement_anchors_account_fkey"
    FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
  ADD CONSTRAINT "gateway_usage_settlement_anchors_product_fkey"
    FOREIGN KEY ("product_id") REFERENCES "products"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
  ADD CONSTRAINT "gateway_usage_settlement_anchors_coding_entitlement_fkey"
    FOREIGN KEY ("coding_plan_entitlement_id")
    REFERENCES "coding_plan_entitlements"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
  ADD CONSTRAINT "gateway_usage_settlement_anchors_plan_fkey"
    FOREIGN KEY ("plan_id") REFERENCES "plans"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
  ADD CONSTRAINT "gateway_usage_settlement_anchors_credit_balance_fkey"
    FOREIGN KEY ("subscription_id")
    REFERENCES "credit_balance_states"("subscription_id")
    ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;

ALTER TABLE "gateway_usage_settlement_anchors"
  ADD CONSTRAINT "gateway_usage_settlement_anchors_funding_queue_shape_check"
    CHECK (
      ("billing_unit" = 'BALANCE'
        AND (
          ("first_receipt_sequence" IS NULL
            AND "funding_reservation_protocol" IS NULL)
          OR
          ("first_receipt_sequence" IS NOT NULL
            AND "first_receipt_sequence" > 0
            AND "funding_reservation_protocol" = 'V1'
            AND "billing_currency" ~ '^[A-Z]{3}$')
        ))
      OR
      ("billing_unit" = 'CREDITS'
        AND "first_receipt_sequence" IS NULL
        AND "funding_reservation_protocol" IS NULL)
    );

ALTER TABLE "gateway_usage_settlement_anchors"
  ADD CONSTRAINT "gateway_usage_settlement_anchors_currency_check"
    CHECK ("billing_currency" IS NULL OR "billing_currency" ~ '^[A-Z]{3}$');

ALTER TABLE "gateway_usage_settlement_receipts"
  ADD CONSTRAINT "gateway_usage_settlement_receipts_currency_check"
    CHECK ("billing_currency" IS NULL OR "billing_currency" ~ '^[A-Z]{3}$');

-- A request proven to have delivered no billable usage receives a permanent
-- zero-value proof before its funding reservation is released.  This keeps a
-- release independently auditable without misclassifying it as platform loss.
ALTER TABLE "gateway_usage_settlement_receipts"
  DROP CONSTRAINT "gateway_usage_receipts_funding_outcome_check";
ALTER TABLE "gateway_usage_settlement_receipts"
  ADD CONSTRAINT "gateway_usage_receipts_funding_outcome_check"
    CHECK (
      "funding_outcome" IN (
        'COLLECTED', 'INCLUDED', 'DEBT_OPEN', 'RECEIVABLE', 'ABSORBED', 'NO_CHARGE'
      )
    ) NOT VALID;
ALTER TABLE "gateway_usage_settlement_receipts"
  VALIDATE CONSTRAINT "gateway_usage_receipts_funding_outcome_check";

-- Existing anchors deliberately retain NULL legacy fields, but no write after
-- this migration may create another legacy-shaped row. A BEFORE INSERT trigger
-- gives new rows the strict contract that a NOT VALID/backward-compatible
-- column migration cannot express with a table CHECK alone.
CREATE OR REPLACE FUNCTION enforce_gateway_usage_anchor_v1_insert()
RETURNS trigger AS $$
BEGIN
  IF NEW."billing_currency" IS NULL
     OR NEW."billing_currency" !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'new gateway settlement anchor requires frozen billing currency'
      USING ERRCODE = '55000';
  END IF;

  IF NEW."billing_unit" = 'BALANCE' AND (
    NEW."first_receipt_sequence" IS NULL
    OR NEW."first_receipt_sequence" <= 0
    OR NEW."funding_reservation_protocol" IS DISTINCT FROM 'V1'
  ) THEN
    RAISE EXCEPTION 'new BALANCE gateway anchor requires V1 first-receipt funding order'
      USING ERRCODE = '55000';
  END IF;

  IF NEW."billing_unit" = 'CREDITS' AND (
    NEW."first_receipt_sequence" IS NOT NULL
    OR NEW."funding_reservation_protocol" IS NOT NULL
  ) THEN
    RAISE EXCEPTION 'CREDITS gateway anchor cannot join BALANCE funding order'
      USING ERRCODE = '55000';
  END IF;

  -- A collection of individually valid foreign keys is not a billing
  -- subject.  Freeze only a tuple that is actually connected at T0: the Key
  -- owns the user/tenant/product, the tenant points at the account, and the
  -- product slug/account currency are the values copied into the anchor.  A
  -- later Key rotation or tenant rebind cannot rewrite this append-only fact.
  IF NOT EXISTS (
    SELECT 1
    FROM "api_keys" AS api_key
    JOIN "tenants" AS tenant
      ON tenant."id" = api_key."tenant_id"
    JOIN "products" AS product
      ON product."id" = api_key."product_id"
    JOIN "billing_accounts" AS account
      ON account."id" = tenant."billing_account_id"
    WHERE api_key."id" = NEW."api_key_id"
      AND api_key."user_id" = NEW."user_id"
      AND api_key."tenant_id" = NEW."tenant_id"
      AND api_key."product_id" = NEW."product_id"
      AND product."slug" = NEW."product_slug"
      AND tenant."billing_account_id" = NEW."billing_account_id"
      AND account."status" = 'active'
      AND account."currency" = NEW."billing_currency"
  ) THEN
    RAISE EXCEPTION 'new gateway settlement anchor billing subject is invalid'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER gateway_usage_settlement_anchors_v1_insert
  BEFORE INSERT ON "gateway_usage_settlement_anchors"
  FOR EACH ROW EXECUTE FUNCTION enforce_gateway_usage_anchor_v1_insert();

-- Ledger currency is an identity dimension, not mutable presentation data.
-- A conversion requires drained maintenance and a dedicated migration that
-- replaces this trigger explicitly; ordinary SQL and stale binaries cannot
-- rewrite the unit underneath existing balances, holds, debts, or receipts.
CREATE OR REPLACE FUNCTION enforce_billing_account_currency_immutability()
RETURNS trigger AS $$
BEGIN
  IF NEW."currency" IS DISTINCT FROM OLD."currency" THEN
    RAISE EXCEPTION 'billing account currency requires a drained dedicated migration'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER billing_accounts_currency_immutable
  BEFORE UPDATE OF "currency" ON "billing_accounts"
  FOR EACH ROW EXECUTE FUNCTION enforce_billing_account_currency_immutability();

CREATE UNIQUE INDEX "gateway_usage_settlement_anchors_first_receipt_sequence_key"
  ON "gateway_usage_settlement_anchors"("first_receipt_sequence");
CREATE UNIQUE INDEX "gateway_usage_settlement_anchors_event_receipt_sequence_key"
  ON "gateway_usage_settlement_anchors"(
    "gateway_billing_event_id",
    "first_receipt_sequence"
  );
CREATE INDEX "gateway_usage_settlement_anchors_account_receipt_sequence_idx"
  ON "gateway_usage_settlement_anchors"(
    "billing_account_id",
    "first_receipt_sequence"
  );

-- The first-receipt transaction obtains a transaction-scoped advisory lock on
-- billing_account_id before explicitly calling nextval(). The later financial
-- transaction copies this sequence verbatim; it never allocates a new order.
CREATE TABLE "gateway_usage_funding_reservations" (
  "id" TEXT NOT NULL,
  "gateway_billing_event_id" TEXT NOT NULL,
  "request_id" TEXT NOT NULL,
  "billing_account_id" TEXT NOT NULL,
  "tenant_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "api_key_id" TEXT NOT NULL,
  "billing_unit" TEXT NOT NULL DEFAULT 'BALANCE',
  "billing_currency" TEXT NOT NULL,
  "collected_funding_protocol" TEXT NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "first_received_at" TIMESTAMP(3) NOT NULL,
  "reservation_sequence" BIGINT NOT NULL,
  "reserved_amount_usd" DECIMAL(20,12) NOT NULL,
  "collected_usd" DECIMAL(20,12) NOT NULL,
  "approved_credit_usd" DECIMAL(20,12) NOT NULL,
  "unapproved_debt_usd" DECIMAL(20,12) NOT NULL,
  "credit_policy_at" TIMESTAMP(3) NOT NULL,
  "credit_policy_window_start" TIMESTAMP(3) NOT NULL,
  "credit_policy_event_id" TEXT,
  "credit_policy_revision" INTEGER,
  "credit_policy_source" TEXT NOT NULL,
  "credit_policy_reconstructible" BOOLEAN NOT NULL,
  "credit_configured_limit_usd" DECIMAL(20,12) NOT NULL,
  "credit_limit_usd" DECIMAL(20,12) NOT NULL,
  "credit_terms_days" INTEGER,
  "approved_credit_due_at" TIMESTAMP(3),
  "credit_status" TEXT,
  "credit_effective_at" TIMESTAMP(3),
  "credit_expires_at" TIMESTAMP(3),
  "anchor_hash" TEXT NOT NULL,
  "reservation_hash" TEXT NOT NULL,
  "canonical_payload" JSONB NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "review_reason" TEXT,
  "authoritative_amount_usd" DECIMAL(20,12),
  "consumed_at" TIMESTAMP(3),
  "released_at" TIMESTAMP(3),
  "release_reason" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gateway_usage_funding_reservations_pkey" PRIMARY KEY ("id"),
  CONSTRAINT "gateway_usage_funding_reservations_event_key" UNIQUE ("gateway_billing_event_id"),
  CONSTRAINT "gateway_usage_funding_reservations_request_key" UNIQUE ("request_id"),
  CONSTRAINT "gateway_usage_funding_reservations_sequence_key" UNIQUE ("reservation_sequence"),
  CONSTRAINT "gateway_usage_funding_reservations_hash_key" UNIQUE ("reservation_hash"),
  CONSTRAINT "gateway_usage_funding_reservations_event_fkey"
    FOREIGN KEY ("gateway_billing_event_id") REFERENCES "gateway_billing_events"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "gateway_usage_funding_reservations_anchor_sequence_fkey"
    FOREIGN KEY ("gateway_billing_event_id", "reservation_sequence")
    REFERENCES "gateway_usage_settlement_anchors"(
      "gateway_billing_event_id",
      "first_receipt_sequence"
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "gateway_usage_funding_reservations_account_fkey"
    FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "gateway_usage_funding_reservations_credit_policy_event_fkey"
    FOREIGN KEY ("credit_policy_event_id")
    REFERENCES "billing_account_credit_events"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "gateway_usage_funding_reservations_amount_check" CHECK (
    "reserved_amount_usd" >= 0
    AND "collected_usd" >= 0
    AND "approved_credit_usd" >= 0
    AND "unapproved_debt_usd" >= 0
    AND "credit_configured_limit_usd" >= 0
    AND "credit_limit_usd" >= 0
    AND "reserved_amount_usd" =
      "collected_usd" + "approved_credit_usd" + "unapproved_debt_usd"
  ),
  CONSTRAINT "gateway_usage_funding_reservations_credit_terms_check" CHECK (
    ("approved_credit_usd" = 0 AND "approved_credit_due_at" IS NULL)
    OR (
      "approved_credit_usd" > 0
      AND
      "credit_policy_reconstructible"
      AND "credit_limit_usd" > 0
      AND "credit_terms_days" IS NOT NULL
      AND "credit_terms_days" > 0
      AND "approved_credit_due_at" IS NOT NULL
    )
  ),
  CONSTRAINT "gateway_usage_funding_reservations_credit_source_check" CHECK (
    "credit_policy_source" IN (
      'EVENT_OLD_STATE', 'EVENT_NEW_STATE', 'NO_CONFIG', 'NOT_APPLICABLE'
    )
  ),
  CONSTRAINT "gateway_usage_funding_reservations_credit_window_check" CHECK (
    -- Do not require occurred_at <= first_received_at: a Gateway clock that is
    -- fast but still inside the signed skew bound has occurred_at later than
    -- receipt time.  The bounded interval is nevertheless non-empty when its
    -- earliest possible instant is at/before policy_at=first_received_at.
    "credit_policy_window_start" <= "credit_policy_at"
    AND "credit_policy_window_start" <= "occurred_at"
    AND "credit_policy_at" <= "first_received_at"
  ),
  CONSTRAINT "gateway_usage_funding_reservations_status_check" CHECK (
    "status" IN ('ACTIVE', 'MANUAL_REVIEW', 'CONSUMED', 'RELEASED')
  ),
  CONSTRAINT "gateway_usage_funding_reservations_currency_check" CHECK (
    "billing_currency" ~ '^[A-Z]{3}$'
  ),
  CONSTRAINT "gateway_usage_funding_reservations_collected_protocol_check" CHECK (
    "collected_funding_protocol" = 'NON_EXPIRING_GRANTS_V1'
  ),
  CONSTRAINT "gateway_usage_funding_reservations_terminal_check" CHECK (
    ("status" = 'ACTIVE'
      AND "review_reason" IS NULL
      AND "authoritative_amount_usd" IS NULL
      AND "consumed_at" IS NULL
      AND "released_at" IS NULL
      AND "release_reason" IS NULL)
    OR ("status" = 'MANUAL_REVIEW'
      AND "review_reason" IS NOT NULL
      AND "authoritative_amount_usd" IS NULL
      AND "consumed_at" IS NULL
      AND "released_at" IS NULL
      AND "release_reason" IS NULL)
    OR ("status" = 'CONSUMED'
      AND "authoritative_amount_usd" IS NOT NULL
      AND "authoritative_amount_usd" >= 0
      AND "consumed_at" IS NOT NULL
      AND "released_at" IS NULL
      AND "release_reason" IS NULL)
    OR ("status" = 'RELEASED'
      AND "authoritative_amount_usd" IS NULL
      AND "consumed_at" IS NULL
      AND "released_at" IS NOT NULL
      AND "release_reason" IS NOT NULL)
  )
);

CREATE INDEX "gateway_usage_funding_reservations_account_status_sequence_idx"
  ON "gateway_usage_funding_reservations"(
    "billing_account_id",
    "status",
    "reservation_sequence"
  );
CREATE INDEX "gateway_usage_funding_reservations_account_occurrence_idx"
  ON "gateway_usage_funding_reservations"(
    "billing_account_id",
    "occurred_at",
    "first_received_at"
  );

-- A reservation must be the exact financial projection of one immutable
-- settlement anchor. The composite event/sequence FK alone does not prove that
-- request, subject, currency, clocks and hash all belong to that same anchor.
CREATE OR REPLACE FUNCTION validate_gateway_usage_funding_reservation_anchor()
RETURNS trigger AS $$
DECLARE
  anchor RECORD;
  account_row RECORD;
  tenant_row RECORD;
  credit_config RECORD;
  credit_tail RECORD;
  selected_policy RECORD;
  previous_policy RECORD;
  config_found BOOLEAN := false;
  tail_found BOOLEAN := false;
  incomplete_policy_count BIGINT := 0;
  prior_approved_usd NUMERIC(20,12) := 0;
  prior_reserved_usd NUMERIC(20,12) := 0;
  open_approved_usd NUMERIC(20,12) := 0;
  later_transaction_usd NUMERIC(20,12) := 0;
  reconstructed_wallet_usd NUMERIC(20,12) := 0;
  proven_credit_used_usd NUMERIC(20,12) := 0;
  available_credit_usd NUMERIC(20,12) := 0;
  allowance_funded_capacity_usd NUMERIC(20,12) := 0;
BEGIN
  SELECT
    settlement_anchor."request_id",
    settlement_anchor."api_key_id",
    settlement_anchor."user_id",
    settlement_anchor."tenant_id",
    settlement_anchor."billing_account_id",
    settlement_anchor."billing_unit",
    settlement_anchor."billing_currency",
    settlement_anchor."occurred_at",
    settlement_anchor."first_received_at",
    settlement_anchor."first_receipt_sequence",
    settlement_anchor."funding_reservation_protocol",
    settlement_anchor."anchor_hash",
    event."request_id" AS event_request_id
  INTO anchor
  FROM "gateway_usage_settlement_anchors" AS settlement_anchor
  JOIN "gateway_billing_events" AS event
    ON event."id" = settlement_anchor."gateway_billing_event_id"
  WHERE settlement_anchor."gateway_billing_event_id" = NEW."gateway_billing_event_id"
  FOR KEY SHARE OF settlement_anchor, event;

  IF NOT FOUND
     OR anchor."request_id" IS DISTINCT FROM NEW."request_id"
     OR anchor.event_request_id IS DISTINCT FROM NEW."request_id"
     OR anchor."api_key_id" IS DISTINCT FROM NEW."api_key_id"
     OR anchor."user_id" IS DISTINCT FROM NEW."user_id"
     OR anchor."tenant_id" IS DISTINCT FROM NEW."tenant_id"
     OR anchor."billing_account_id" IS DISTINCT FROM NEW."billing_account_id"
     OR anchor."billing_unit" IS DISTINCT FROM 'BALANCE'
     OR NEW."billing_unit" IS DISTINCT FROM 'BALANCE'
     OR anchor."billing_currency" IS DISTINCT FROM NEW."billing_currency"
     OR anchor."occurred_at" IS DISTINCT FROM NEW."occurred_at"
     OR anchor."first_received_at" IS DISTINCT FROM NEW."first_received_at"
     OR anchor."first_receipt_sequence" IS DISTINCT FROM NEW."reservation_sequence"
     OR anchor."funding_reservation_protocol" IS DISTINCT FROM 'V1'
     OR anchor."anchor_hash" IS DISTINCT FROM NEW."anchor_hash"
     OR NEW."status" IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'gateway funding reservation does not match immutable anchor'
      USING ERRCODE = '55000';
  END IF;

  -- The reservation is a financial authority, not an application assertion.
  -- Bind it to the real account/wallet under the same locks used by Billing.
  SELECT account.*, wallet."balance_usd" AS wallet_balance_usd
  INTO account_row
  FROM "billing_accounts" AS account
  JOIN "account_wallets" AS wallet
    ON wallet."billing_account_id" = account."id"
  WHERE account."id" = NEW."billing_account_id"
  FOR UPDATE OF account, wallet;
  IF NOT FOUND
     OR account_row."status" IS DISTINCT FROM 'active'
     OR account_row."currency" IS DISTINCT FROM NEW."billing_currency" THEN
    RAISE EXCEPTION 'gateway funding reservation account authority is invalid'
      USING ERRCODE = '55000';
  END IF;

  -- balanceAllowance is the workspace admission/funding ceiling, not a UI
  -- hint.  Freeze against it under the same lock used by allowance updates.
  -- The tenant may legitimately be rebound after T0, so identity is proved by
  -- the append-only anchor; this T1 read freezes only its allowance capacity.
  SELECT tenant."balance_allowance_usd", tenant."balance_allowance_used_usd"
  INTO tenant_row
  FROM "tenants" AS tenant
  WHERE tenant."id" = NEW."tenant_id"
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gateway funding reservation tenant authority is invalid'
      USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(SUM(reservation."reserved_amount_usd"), 0)
  INTO prior_reserved_usd
  FROM "gateway_usage_funding_reservations" AS reservation
  WHERE reservation."billing_account_id" = NEW."billing_account_id"
    AND reservation."status" IN ('ACTIVE', 'MANUAL_REVIEW');
  allowance_funded_capacity_usd := NEW."collected_usd" + NEW."approved_credit_usd";
  IF tenant_row."balance_allowance_usd" IS NOT NULL
     AND allowance_funded_capacity_usd > GREATEST(
       0,
       tenant_row."balance_allowance_usd"
         - tenant_row."balance_allowance_used_usd"
         - prior_reserved_usd
     ) THEN
    RAISE EXCEPTION 'gateway funding reservation exceeds workspace allowance authority'
      USING ERRCODE = '55000';
  END IF;

  IF account_row."type" IS DISTINCT FROM 'enterprise' THEN
    IF NEW."approved_credit_usd" <> 0
       OR NEW."credit_policy_event_id" IS NOT NULL
       OR NEW."credit_policy_revision" IS NOT NULL
       OR NEW."credit_policy_source" IS DISTINCT FROM 'NOT_APPLICABLE'
       OR NEW."credit_policy_reconstructible" IS DISTINCT FROM TRUE
       OR NEW."credit_configured_limit_usd" <> 0
       OR NEW."credit_limit_usd" <> 0
       OR NEW."credit_terms_days" IS NOT NULL
       OR NEW."approved_credit_due_at" IS NOT NULL
       OR NEW."credit_status" IS NOT NULL
       OR NEW."credit_effective_at" IS NOT NULL
       OR NEW."credit_expires_at" IS NOT NULL THEN
      RAISE EXCEPTION 'personal gateway reservation cannot contain enterprise credit'
        USING ERRCODE = '55000';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."credit_policy_reconstructible" IS DISTINCT FROM TRUE
     OR NEW."credit_policy_window_start" > NEW."credit_policy_at"
     OR NEW."credit_policy_at" > NEW."first_received_at" THEN
    RAISE EXCEPTION 'enterprise gateway reservation credit window is not reconstructible'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO credit_config
  FROM "billing_account_credit_configs"
  WHERE "billing_account_id" = NEW."billing_account_id"
  FOR UPDATE;
  config_found := FOUND;

  SELECT * INTO credit_tail
  FROM "billing_account_credit_events"
  WHERE "billing_account_id" = NEW."billing_account_id"
    AND "policy_revision" IS NOT NULL
  ORDER BY "policy_revision" DESC, "id" DESC
  LIMIT 1
  FOR KEY SHARE;
  tail_found := FOUND;

  IF config_found IS DISTINCT FROM tail_found
     OR (
       config_found
       AND (
         credit_config."policy_revision" <= 0
         OR credit_config."policy_boundary_complete" IS DISTINCT FROM TRUE
         OR credit_tail."temporal_snapshot_complete" IS DISTINCT FROM TRUE
         OR credit_tail."policy_boundary_complete" IS DISTINCT FROM TRUE
         OR credit_config."policy_revision" IS DISTINCT FROM credit_tail."policy_revision"
         OR credit_config."policy_effective_boundary_at"
            IS DISTINCT FROM credit_tail."policy_effective_boundary_at"
         OR credit_config."limit_usd" IS DISTINCT FROM credit_tail."new_limit_usd"
         OR credit_config."status" IS DISTINCT FROM credit_tail."new_status"
         OR credit_config."terms_days" IS DISTINCT FROM credit_tail."new_terms_days"
         OR credit_config."effective_at" IS DISTINCT FROM credit_tail."new_effective_at"
         OR credit_config."expires_at" IS DISTINCT FROM credit_tail."new_expires_at"
       )
     ) THEN
    RAISE EXCEPTION 'enterprise gateway reservation credit config tail is invalid'
      USING ERRCODE = '55000';
  END IF;

  SELECT COUNT(*) INTO incomplete_policy_count
  FROM "billing_account_credit_events"
  WHERE "billing_account_id" = NEW."billing_account_id"
    AND "policy_revision" IS NOT NULL
    AND (
      "temporal_snapshot_complete" IS DISTINCT FROM TRUE
      OR "policy_boundary_complete" IS DISTINCT FROM TRUE
      OR "policy_decision_at" IS NULL
      OR "policy_effective_boundary_at" IS NULL
    );
  IF incomplete_policy_count <> 0 THEN
    RAISE EXCEPTION 'enterprise gateway reservation has incomplete credit history'
      USING ERRCODE = '55000';
  END IF;

  -- No decision/commit uncertainty or policy transition may intersect any
  -- possible occurrence instant in the signed Gateway clock window.
  IF EXISTS (
    SELECT 1
    FROM "billing_account_credit_events" AS policy_event
    WHERE policy_event."billing_account_id" = NEW."billing_account_id"
      AND policy_event."policy_revision" IS NOT NULL
      AND policy_event."policy_decision_at" <= NEW."credit_policy_at"
      AND policy_event."policy_effective_boundary_at" >
          NEW."credit_policy_window_start"
  ) THEN
    RAISE EXCEPTION 'enterprise gateway reservation credit window crosses policy boundary'
      USING ERRCODE = '55000';
  END IF;

  IF NEW."credit_policy_source" = 'EVENT_NEW_STATE' THEN
    SELECT * INTO selected_policy
    FROM "billing_account_credit_events"
    WHERE "id" = NEW."credit_policy_event_id"
      AND "billing_account_id" = NEW."billing_account_id";
    IF NOT FOUND
       OR NEW."credit_policy_revision" IS NULL
       OR selected_policy."policy_revision" IS DISTINCT FROM NEW."credit_policy_revision"
       OR selected_policy."temporal_snapshot_complete" IS DISTINCT FROM TRUE
       OR selected_policy."policy_boundary_complete" IS DISTINCT FROM TRUE
       OR selected_policy."policy_effective_boundary_at" >
          NEW."credit_policy_window_start"
         OR selected_policy."new_limit_usd" IS DISTINCT FROM
            NEW."credit_configured_limit_usd"
       OR selected_policy."new_status" IS DISTINCT FROM NEW."credit_status"
       OR selected_policy."new_terms_days" IS DISTINCT FROM NEW."credit_terms_days"
       OR selected_policy."new_effective_at" IS DISTINCT FROM NEW."credit_effective_at"
       OR selected_policy."new_expires_at" IS DISTINCT FROM NEW."credit_expires_at"
       OR EXISTS (
         SELECT 1
         FROM "billing_account_credit_events" AS later_policy
         WHERE later_policy."billing_account_id" = NEW."billing_account_id"
           AND later_policy."policy_revision" > NEW."credit_policy_revision"
           AND later_policy."policy_decision_at" <= NEW."credit_policy_at"
       ) THEN
      RAISE EXCEPTION 'enterprise gateway reservation EVENT_NEW_STATE proof is invalid'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW."credit_policy_source" = 'EVENT_OLD_STATE' THEN
    SELECT * INTO selected_policy
    FROM "billing_account_credit_events"
    WHERE "id" = NEW."credit_policy_event_id"
      AND "billing_account_id" = NEW."billing_account_id";
    IF NOT FOUND
       OR NEW."credit_policy_revision" IS NULL
       OR NEW."credit_policy_revision" <= 0
       OR selected_policy."policy_revision" IS DISTINCT FROM
          NEW."credit_policy_revision" + 1
       OR selected_policy."temporal_snapshot_complete" IS DISTINCT FROM TRUE
       OR selected_policy."policy_boundary_complete" IS DISTINCT FROM TRUE
       OR selected_policy."policy_decision_at" <= NEW."credit_policy_at"
       OR selected_policy."old_limit_usd" IS DISTINCT FROM
          NEW."credit_configured_limit_usd"
       OR selected_policy."old_status" IS DISTINCT FROM NEW."credit_status"
       OR selected_policy."old_terms_days" IS DISTINCT FROM NEW."credit_terms_days"
       OR selected_policy."old_effective_at" IS DISTINCT FROM NEW."credit_effective_at"
       OR selected_policy."old_expires_at" IS DISTINCT FROM NEW."credit_expires_at" THEN
      RAISE EXCEPTION 'enterprise gateway reservation EVENT_OLD_STATE proof is invalid'
        USING ERRCODE = '55000';
    END IF;

    SELECT * INTO previous_policy
    FROM "billing_account_credit_events"
    WHERE "billing_account_id" = NEW."billing_account_id"
      AND "policy_revision" = NEW."credit_policy_revision";
    IF NOT FOUND
       OR previous_policy."temporal_snapshot_complete" IS DISTINCT FROM TRUE
       OR previous_policy."policy_boundary_complete" IS DISTINCT FROM TRUE
       OR previous_policy."policy_effective_boundary_at" >
          NEW."credit_policy_window_start"
       OR previous_policy."new_limit_usd" IS DISTINCT FROM
          NEW."credit_configured_limit_usd"
       OR previous_policy."new_status" IS DISTINCT FROM NEW."credit_status"
       OR previous_policy."new_terms_days" IS DISTINCT FROM NEW."credit_terms_days"
       OR previous_policy."new_effective_at" IS DISTINCT FROM NEW."credit_effective_at"
       OR previous_policy."new_expires_at" IS DISTINCT FROM NEW."credit_expires_at" THEN
      RAISE EXCEPTION 'enterprise gateway reservation previous policy proof is invalid'
        USING ERRCODE = '55000';
    END IF;
  ELSIF NEW."credit_policy_source" = 'NO_CONFIG' THEN
    IF NEW."approved_credit_usd" <> 0
       OR NEW."credit_configured_limit_usd" <> 0
       OR NEW."credit_limit_usd" <> 0
       OR NEW."credit_status" IS NOT NULL
       OR NEW."credit_terms_days" IS NOT NULL
       OR NEW."approved_credit_due_at" IS NOT NULL
       OR NEW."credit_effective_at" IS NOT NULL
       OR NEW."credit_expires_at" IS NOT NULL THEN
      RAISE EXCEPTION 'enterprise gateway NO_CONFIG reservation contains credit'
        USING ERRCODE = '55000';
    END IF;
    IF NEW."credit_policy_event_id" IS NULL THEN
      IF config_found OR tail_found OR NEW."credit_policy_revision" IS NOT NULL THEN
        RAISE EXCEPTION 'enterprise gateway NO_CONFIG proof is invalid'
          USING ERRCODE = '55000';
      END IF;
    ELSE
      SELECT * INTO selected_policy
      FROM "billing_account_credit_events"
      WHERE "id" = NEW."credit_policy_event_id"
        AND "billing_account_id" = NEW."billing_account_id";
      IF NOT FOUND
         OR NEW."credit_policy_revision" IS DISTINCT FROM 0
         OR selected_policy."policy_revision" IS DISTINCT FROM 1
         OR selected_policy."temporal_snapshot_complete" IS DISTINCT FROM TRUE
         OR selected_policy."policy_boundary_complete" IS DISTINCT FROM TRUE
         OR selected_policy."policy_decision_at" <= NEW."credit_policy_at"
         OR selected_policy."old_limit_usd" IS NOT NULL
         OR selected_policy."old_status" IS NOT NULL
         OR selected_policy."old_terms_days" IS NOT NULL
         OR selected_policy."old_effective_at" IS NOT NULL
         OR selected_policy."old_expires_at" IS NOT NULL THEN
        RAISE EXCEPTION 'enterprise gateway historical NO_CONFIG proof is invalid'
          USING ERRCODE = '55000';
      END IF;
    END IF;
  ELSE
    RAISE EXCEPTION 'enterprise gateway reservation credit source is invalid'
      USING ERRCODE = '55000';
  END IF;

  -- credit_configured_limit_usd is the immutable event tuple; credit_limit_usd
  -- is the effective amount that was actually available throughout the whole
  -- possible occurrence window.  Keeping both prevents a future-effective or
  -- suspended policy from being misrepresented as either a different event
  -- tuple or active borrowing authority.
  IF NEW."credit_policy_source" IN ('EVENT_NEW_STATE', 'EVENT_OLD_STATE') THEN
    IF NEW."credit_limit_usd" IS DISTINCT FROM (
      CASE
        WHEN NEW."credit_status" = 'ACTIVE'
          AND NEW."credit_terms_days" IS NOT NULL
          AND NEW."credit_terms_days" > 0
          AND (
            NEW."credit_effective_at" IS NULL
            OR NEW."credit_effective_at" <= NEW."credit_policy_window_start"
          )
          AND (
            NEW."credit_expires_at" IS NULL
            OR NEW."credit_expires_at" > NEW."credit_policy_at"
          )
        THEN NEW."credit_configured_limit_usd"
        ELSE 0
      END
    ) THEN
      RAISE EXCEPTION 'enterprise gateway reservation effective credit limit is invalid'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF NEW."approved_credit_usd" > 0 THEN
    IF NEW."credit_policy_source" NOT IN ('EVENT_NEW_STATE', 'EVENT_OLD_STATE')
       OR NEW."credit_status" IS DISTINCT FROM 'ACTIVE'
       OR NEW."credit_limit_usd" <= 0
       OR NEW."credit_terms_days" IS NULL
       OR NEW."credit_terms_days" <= 0
       OR NEW."approved_credit_usd" > NEW."credit_limit_usd"
       OR (NEW."credit_effective_at" IS NOT NULL
           AND NEW."credit_effective_at" > NEW."credit_policy_window_start")
       OR (NEW."credit_expires_at" IS NOT NULL
           AND NEW."credit_expires_at" <= NEW."credit_policy_at")
       OR NEW."approved_credit_due_at" IS DISTINCT FROM (
         NEW."credit_policy_at"
         + NEW."credit_terms_days" * INTERVAL '1 day'
       )::TIMESTAMP(3) THEN
      RAISE EXCEPTION 'enterprise gateway reservation approved credit policy is invalid'
        USING ERRCODE = '55000';
    END IF;

    SELECT COALESCE(SUM(
      GREATEST(allocation."approved_credit_usd" - allocation."settled_usd", 0)
    ), 0)
    INTO open_approved_usd
    FROM "balance_consumption_allocations" AS allocation
    WHERE allocation."billing_account_id" = NEW."billing_account_id"
      AND allocation."source" = 'ENTERPRISE_CREDIT'
      AND allocation."funding_classification_complete"
      AND allocation."approved_credit_usd" > 0;

    SELECT COALESCE(SUM(reservation."approved_credit_usd"), 0)
    INTO prior_approved_usd
    FROM "gateway_usage_funding_reservations" AS reservation
    WHERE reservation."billing_account_id" = NEW."billing_account_id"
      AND reservation."status" IN ('ACTIVE', 'MANUAL_REVIEW');

    SELECT COALESCE(SUM(transaction_row."amount_usd"), 0)
    INTO later_transaction_usd
    FROM "balance_transactions" AS transaction_row
    WHERE transaction_row."billing_account_id" = NEW."billing_account_id"
      AND transaction_row."created_at" >= NEW."first_received_at";
    reconstructed_wallet_usd := account_row.wallet_balance_usd - later_transaction_usd;
    proven_credit_used_usd := LEAST(
      NEW."credit_limit_usd",
      GREATEST(
        0,
        -account_row.wallet_balance_usd,
        -reconstructed_wallet_usd,
        open_approved_usd
      )
    );
    available_credit_usd := GREATEST(
      0,
      NEW."credit_limit_usd" - proven_credit_used_usd - prior_approved_usd
    );
    IF NEW."approved_credit_usd" > available_credit_usd THEN
      RAISE EXCEPTION 'enterprise gateway reservation exceeds proven available credit'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER gateway_usage_funding_reservations_anchor_bind
  BEFORE INSERT ON "gateway_usage_funding_reservations"
  FOR EACH ROW EXECUTE FUNCTION validate_gateway_usage_funding_reservation_anchor();

-- The collected reservation is bound to exact non-expiring grants, not merely
-- to an account-level aggregate. Without these immutable holds, settlement A
-- could consume the only first-receipt-eligible grant that still backs later
-- reservation B after new money arrives.
ALTER TABLE "gateway_usage_funding_reservations"
  ADD CONSTRAINT "gateway_usage_funding_reservations_id_event_key"
    UNIQUE ("id", "gateway_billing_event_id");

CREATE TABLE "gateway_usage_funding_reservation_grants" (
  "id" TEXT NOT NULL,
  "funding_reservation_id" TEXT NOT NULL,
  "gateway_billing_event_id" TEXT NOT NULL,
  "balance_grant_id" TEXT NOT NULL,
  "amount_usd" DECIMAL(20,12) NOT NULL,
  "allocation_order" INTEGER NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "gateway_usage_funding_reservation_grants_pkey"
    PRIMARY KEY ("id"),
  CONSTRAINT "gateway_usage_funding_reservation_grants_reservation_grant_key"
    UNIQUE ("funding_reservation_id", "balance_grant_id"),
  CONSTRAINT "gateway_usage_funding_reservation_grants_reservation_order_key"
    UNIQUE ("funding_reservation_id", "allocation_order"),
  CONSTRAINT "gateway_usage_funding_reservation_grants_amount_check"
    CHECK ("amount_usd" > 0),
  CONSTRAINT "gateway_usage_funding_reservation_grants_order_check"
    CHECK ("allocation_order" >= 0),
  CONSTRAINT "gateway_usage_funding_reservation_grants_reservation_fkey"
    FOREIGN KEY ("funding_reservation_id", "gateway_billing_event_id")
    REFERENCES "gateway_usage_funding_reservations"(
      "id", "gateway_billing_event_id"
    ) ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "gateway_usage_funding_reservation_grants_grant_fkey"
    FOREIGN KEY ("balance_grant_id") REFERENCES "balance_grants"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE INDEX "gateway_usage_funding_reservation_grants_grant_idx"
  ON "gateway_usage_funding_reservation_grants"("balance_grant_id");
CREATE INDEX "gateway_usage_funding_reservation_grants_event_idx"
  ON "gateway_usage_funding_reservation_grants"("gateway_billing_event_id");

CREATE OR REPLACE FUNCTION validate_gateway_usage_funding_grant_hold()
RETURNS trigger AS $$
DECLARE
  reservation_account_id TEXT;
  reservation_first_received_at TIMESTAMP(3);
  reservation_status TEXT;
  reservation_collected_usd DECIMAL(20,12);
  reservation_existing_hold_usd DECIMAL(20,12);
  grant_account_id TEXT;
  grant_remaining_usd DECIMAL(20,12);
  grant_valid_from TIMESTAMP(3);
  grant_created_at TIMESTAMP(3);
  grant_expires_at TIMESTAMP(3);
  grant_is_expired BOOLEAN;
  active_grant_hold_usd DECIMAL(20,12);
BEGIN
  SELECT
    reservation."billing_account_id",
    reservation."first_received_at",
    reservation."status",
    reservation."collected_usd"
  INTO
    reservation_account_id,
    reservation_first_received_at,
    reservation_status,
    reservation_collected_usd
  FROM "gateway_usage_funding_reservations" AS reservation
  WHERE reservation."id" = NEW."funding_reservation_id"
    AND reservation."gateway_billing_event_id" = NEW."gateway_billing_event_id"
  FOR UPDATE;

  IF NOT FOUND OR reservation_status <> 'ACTIVE' THEN
    RAISE EXCEPTION 'active gateway funding reservation is required for grant hold'
      USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(SUM(hold."amount_usd"), 0)
  INTO reservation_existing_hold_usd
  FROM "gateway_usage_funding_reservation_grants" AS hold
  WHERE hold."funding_reservation_id" = NEW."funding_reservation_id";
  IF reservation_existing_hold_usd + NEW."amount_usd" > reservation_collected_usd THEN
    RAISE EXCEPTION 'gateway funding grant holds exceed collected reservation'
      USING ERRCODE = '55000';
  END IF;

  SELECT
    balance_grant."billing_account_id",
    balance_grant."remaining_amount_usd",
    balance_grant."valid_from",
    balance_grant."created_at",
    balance_grant."expires_at",
    balance_grant."is_expired"
  INTO
    grant_account_id,
    grant_remaining_usd,
    grant_valid_from,
    grant_created_at,
    grant_expires_at,
    grant_is_expired
  FROM "balance_grants" AS balance_grant
  WHERE balance_grant."id" = NEW."balance_grant_id"
  FOR UPDATE;

  IF NOT FOUND
     OR grant_account_id IS DISTINCT FROM reservation_account_id
     OR grant_is_expired
     OR grant_expires_at IS NOT NULL
     OR grant_valid_from > reservation_first_received_at
     OR grant_created_at > reservation_first_received_at THEN
    RAISE EXCEPTION 'gateway funding grant hold is not first-receipt eligible'
      USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(SUM(hold."amount_usd"), 0)
  INTO active_grant_hold_usd
  FROM "gateway_usage_funding_reservation_grants" AS hold
  JOIN "gateway_usage_funding_reservations" AS reservation
    ON reservation."id" = hold."funding_reservation_id"
  WHERE hold."balance_grant_id" = NEW."balance_grant_id"
    AND reservation."status" IN ('ACTIVE', 'MANUAL_REVIEW');
  IF active_grant_hold_usd + NEW."amount_usd" > grant_remaining_usd THEN
    RAISE EXCEPTION 'gateway funding grant hold exceeds available grant balance'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER gateway_usage_funding_reservation_grants_validate
  BEFORE INSERT ON "gateway_usage_funding_reservation_grants"
  FOR EACH ROW EXECUTE FUNCTION validate_gateway_usage_funding_grant_hold();

CREATE OR REPLACE FUNCTION enforce_gateway_usage_funding_grant_immutability()
RETURNS trigger AS $$
BEGIN
  RAISE EXCEPTION 'gateway usage funding grant hold is immutable'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER gateway_usage_funding_reservation_grants_immutable
  BEFORE UPDATE OR DELETE ON "gateway_usage_funding_reservation_grants"
  FOR EACH ROW EXECUTE FUNCTION enforce_gateway_usage_funding_grant_immutability();

-- Final database boundary for every grant mutation path (deduct, refund,
-- admin adjustment, repair, or a stale binary). A Gateway settlement sets the
-- transaction-local reservation ID only after its TokenUsage protocol guard
-- passes; that reservation's own slice may then be consumed, while every
-- other active/manual slice remains protected.
CREATE OR REPLACE FUNCTION protect_gateway_usage_funding_grant_holds()
RETURNS trigger AS $$
DECLARE
  consuming_reservation_id TEXT;
  settlement_protocol_marker TEXT;
  consuming_reservation_account_id TEXT;
  consuming_token_usage_exists BOOLEAN;
  all_active_hold_usd DECIMAL(20,12);
  protected_hold_usd DECIMAL(20,12);
BEGIN
  consuming_reservation_id := NULLIF(current_setting(
    'ruidong.gateway_consuming_reservation_id',
    true
  ), '');
  IF consuming_reservation_id IS NOT NULL THEN
    settlement_protocol_marker := current_setting(
      'ruidong.gateway_settlement_protocol',
      true
    );
    SELECT
      reservation."billing_account_id",
      EXISTS (
        SELECT 1
        FROM "token_usage" AS usage
        WHERE usage."gateway_billing_event_id" = reservation."gateway_billing_event_id"
      )
    INTO consuming_reservation_account_id, consuming_token_usage_exists
    FROM "gateway_usage_funding_reservations" AS reservation
    WHERE reservation."id" = consuming_reservation_id
      AND reservation."status" IN ('ACTIVE', 'MANUAL_REVIEW');
    IF NOT FOUND
       OR settlement_protocol_marker IS DISTINCT FROM 'v1'
       OR consuming_token_usage_exists IS DISTINCT FROM TRUE
       OR consuming_reservation_account_id IS DISTINCT FROM OLD."billing_account_id" THEN
      RAISE EXCEPTION 'invalid Gateway funding reservation consumption marker'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  SELECT
    COALESCE(SUM(hold."amount_usd"), 0),
    COALESCE(SUM(hold."amount_usd") FILTER (
      WHERE reservation."id" IS DISTINCT FROM consuming_reservation_id
    ), 0)
  INTO all_active_hold_usd, protected_hold_usd
  FROM "gateway_usage_funding_reservation_grants" AS hold
  JOIN "gateway_usage_funding_reservations" AS reservation
    ON reservation."id" = hold."funding_reservation_id"
  WHERE hold."balance_grant_id" = OLD."id"
    AND reservation."status" IN ('ACTIVE', 'MANUAL_REVIEW');

  IF NEW."remaining_amount_usd" < protected_hold_usd THEN
    RAISE EXCEPTION 'balance grant update would consume reserved Gateway funding'
      USING ERRCODE = '55000';
  END IF;

  IF all_active_hold_usd > 0 AND (
    NEW."billing_account_id" IS DISTINCT FROM OLD."billing_account_id"
    OR NEW."is_expired" IS DISTINCT FROM OLD."is_expired"
    OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
    OR NEW."valid_from" IS DISTINCT FROM OLD."valid_from"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'balance grant eligibility is immutable while Gateway funding is reserved'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER balance_grants_gateway_funding_holds_guard
  BEFORE UPDATE ON "balance_grants"
  FOR EACH ROW EXECUTE FUNCTION protect_gateway_usage_funding_grant_holds();

-- Historical non-terminal BALANCE anchors cannot be funded from today's
-- wallet or today's credit policy. Keep them reservation-less and fail-closed;
-- finance must either reconcile them explicitly or create an ABSORB receipt.
UPDATE "gateway_billing_events" AS event
SET
  "status" = 'QUARANTINED',
  "reason" = 'funding_reservation_missing',
  "evidence_verdict" = 'INCOMPLETE',
  "reconciliation_status" = 'MANUAL_REVIEW',
  "revision" = event."revision" + 1,
  "updated_at" = CURRENT_TIMESTAMP
FROM "gateway_usage_settlement_anchors" AS anchor
WHERE anchor."gateway_billing_event_id" = event."id"
  AND anchor."billing_unit" = 'BALANCE'
  AND anchor."funding_reservation_protocol" IS NULL
  AND event."status" IN ('RECEIVED', 'PROCESSING', 'QUARANTINED', 'RETRYABLE_FAILED');

INSERT INTO "billing_access_restrictions" (
  "id", "gateway_billing_event_id", "billing_account_id", "status", "reason",
  "idempotency_key", "created_by", "created_at", "updated_at"
)
SELECT
  'legacy-funding-review:' || anchor."gateway_billing_event_id",
  anchor."gateway_billing_event_id",
  anchor."billing_account_id",
  'ACTIVE',
  'settlement_policy_review',
  'gateway:legacy-funding-review:' || anchor."request_id",
  'MIGRATION',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "gateway_usage_settlement_anchors" AS anchor
JOIN "gateway_billing_events" AS event
  ON event."id" = anchor."gateway_billing_event_id"
WHERE anchor."billing_unit" = 'BALANCE'
  AND anchor."funding_reservation_protocol" IS NULL
  AND event."reconciliation_status" = 'MANUAL_REVIEW'
ON CONFLICT ("idempotency_key") DO NOTHING;

-- New legacy-shaped anchors are rejected by the BEFORE INSERT trigger above.
-- The complete receipt transaction therefore rolls back and Kafka redelivery
-- moves the event to a V1 consumer. Existing pre-migration legacy anchors were
-- quarantined above and remain unchanged.

CREATE OR REPLACE FUNCTION enforce_gateway_usage_funding_reservation_immutability()
RETURNS trigger AS $$
DECLARE
  transition_protocol TEXT;
  transition_reservation_id TEXT;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'gateway usage funding reservation is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF ROW(
    NEW."id", NEW."gateway_billing_event_id", NEW."request_id",
    NEW."billing_account_id", NEW."tenant_id", NEW."user_id", NEW."api_key_id",
    NEW."billing_unit", NEW."billing_currency", NEW."collected_funding_protocol",
    NEW."occurred_at", NEW."first_received_at",
    NEW."reservation_sequence", NEW."reserved_amount_usd", NEW."collected_usd",
    NEW."approved_credit_usd", NEW."unapproved_debt_usd", NEW."credit_policy_at",
    NEW."credit_policy_window_start", NEW."credit_policy_event_id",
    NEW."credit_policy_revision", NEW."credit_policy_source",
    NEW."credit_policy_reconstructible", NEW."credit_configured_limit_usd",
    NEW."credit_limit_usd",
    NEW."credit_terms_days", NEW."credit_status", NEW."credit_effective_at",
    NEW."approved_credit_due_at", NEW."credit_expires_at", NEW."anchor_hash",
    NEW."reservation_hash", NEW."canonical_payload", NEW."created_at"
  ) IS DISTINCT FROM ROW(
    OLD."id", OLD."gateway_billing_event_id", OLD."request_id",
    OLD."billing_account_id", OLD."tenant_id", OLD."user_id", OLD."api_key_id",
    OLD."billing_unit", OLD."billing_currency", OLD."collected_funding_protocol",
    OLD."occurred_at", OLD."first_received_at",
    OLD."reservation_sequence", OLD."reserved_amount_usd", OLD."collected_usd",
    OLD."approved_credit_usd", OLD."unapproved_debt_usd", OLD."credit_policy_at",
    OLD."credit_policy_window_start", OLD."credit_policy_event_id",
    OLD."credit_policy_revision", OLD."credit_policy_source",
    OLD."credit_policy_reconstructible", OLD."credit_configured_limit_usd",
    OLD."credit_limit_usd",
    OLD."credit_terms_days", OLD."credit_status", OLD."credit_effective_at",
    OLD."approved_credit_due_at", OLD."credit_expires_at", OLD."anchor_hash",
    OLD."reservation_hash", OLD."canonical_payload", OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'gateway usage funding reservation financial snapshot is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF NEW."status" IS DISTINCT FROM OLD."status" THEN
    transition_protocol := current_setting(
      'ruidong.gateway_funding_transition_protocol',
      true
    );
    transition_reservation_id := NULLIF(current_setting(
      'ruidong.gateway_funding_transition_reservation_id',
      true
    ), '');

    IF transition_reservation_id IS DISTINCT FROM OLD."id" THEN
      RAISE EXCEPTION 'gateway funding reservation transition identity is missing'
        USING ERRCODE = '55000';
    END IF;

    IF NEW."status" = 'CONSUMED' THEN
      IF OLD."status" NOT IN ('ACTIVE', 'MANUAL_REVIEW')
         OR transition_protocol IS DISTINCT FROM 'consume-v1' THEN
        RAISE EXCEPTION 'gateway funding reservation consume transition is unauthorized'
          USING ERRCODE = '55000';
      END IF;
    ELSIF NEW."status" = 'RELEASED' THEN
      IF OLD."status" NOT IN ('ACTIVE', 'MANUAL_REVIEW')
         OR transition_protocol IS DISTINCT FROM 'release-v1' THEN
        RAISE EXCEPTION 'gateway funding reservation release transition is unauthorized'
          USING ERRCODE = '55000';
      END IF;
    ELSIF NEW."status" = 'MANUAL_REVIEW' THEN
      -- No production writer owns this transition. Keep the status readable
      -- for historical compatibility, but fail closed until a future writer
      -- can bind the transition to an exact reconciliation action.
      RAISE EXCEPTION 'gateway funding reservation manual review transition is disabled'
        USING ERRCODE = '55000';
    ELSE
      RAISE EXCEPTION 'gateway funding reservation status transition is invalid'
        USING ERRCODE = '55000';
    END IF;
  END IF;

  IF NEW."review_reason" IS DISTINCT FROM OLD."review_reason"
     AND NOT (
       OLD."status" = 'ACTIVE'
       AND NEW."status" = 'MANUAL_REVIEW'
       AND OLD."review_reason" IS NULL
       AND NEW."review_reason" IS NOT NULL
     ) THEN
    RAISE EXCEPTION 'gateway usage funding reservation review reason is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD."status" IN ('CONSUMED', 'RELEASED') THEN
    IF ROW(NEW."status", NEW."review_reason", NEW."authoritative_amount_usd",
           NEW."consumed_at", NEW."released_at", NEW."release_reason")
       IS DISTINCT FROM
       ROW(OLD."status", OLD."review_reason", OLD."authoritative_amount_usd",
           OLD."consumed_at", OLD."released_at", OLD."release_reason") THEN
      RAISE EXCEPTION 'gateway usage funding reservation terminal state is immutable'
        USING ERRCODE = '55000';
    END IF;
  ELSIF OLD."status" = 'MANUAL_REVIEW'
        AND NEW."status" NOT IN ('MANUAL_REVIEW', 'CONSUMED', 'RELEASED') THEN
    RAISE EXCEPTION 'gateway usage funding reservation review transition is invalid'
      USING ERRCODE = '55000';
  ELSIF OLD."status" = 'ACTIVE'
        AND NEW."status" NOT IN ('ACTIVE', 'MANUAL_REVIEW', 'CONSUMED', 'RELEASED') THEN
    RAISE EXCEPTION 'gateway usage funding reservation transition is invalid'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER gateway_usage_funding_reservations_immutable
  BEFORE UPDATE OR DELETE ON "gateway_usage_funding_reservations"
  FOR EACH ROW EXECUTE FUNCTION enforce_gateway_usage_funding_reservation_immutability();

-- Application-level rolling-deploy flags are insufficient for a financial
-- protocol change: an older consumer can still be a live Kafka group member.
-- Every new Gateway-linked TokenUsage therefore needs a transaction-local V1
-- marker set by the new financial writer. BALANCE additionally requires the
-- immutable V1 anchor and a live funding reservation. Missing state rolls the
-- whole wallet/TokenUsage/receipt transaction back with SQLSTATE 55000.
CREATE OR REPLACE FUNCTION enforce_gateway_token_usage_settlement_protocol()
RETURNS trigger AS $$
DECLARE
  protocol_marker TEXT;
  anchor_unit TEXT;
  anchor_protocol TEXT;
  anchor_currency TEXT;
  reservation_status TEXT;
  reservation_collected_usd DECIMAL(20,12);
  reservation_grant_hold_usd DECIMAL(20,12);
BEGIN
  IF NEW."gateway_billing_event_id" IS NULL THEN
    RETURN NEW;
  END IF;

  protocol_marker := current_setting(
    'ruidong.gateway_settlement_protocol',
    true
  );
  IF protocol_marker IS DISTINCT FROM 'v1' THEN
    RAISE EXCEPTION 'gateway settlement protocol marker v1 is required'
      USING ERRCODE = '55000';
  END IF;

  SELECT
    anchor."billing_unit",
    anchor."funding_reservation_protocol",
    anchor."billing_currency"
  INTO anchor_unit, anchor_protocol, anchor_currency
  FROM "gateway_usage_settlement_anchors" AS anchor
  WHERE anchor."gateway_billing_event_id" = NEW."gateway_billing_event_id";

  IF NOT FOUND THEN
    RAISE EXCEPTION 'gateway settlement anchor is required'
      USING ERRCODE = '55000';
  END IF;

  IF anchor_currency IS NULL OR anchor_currency !~ '^[A-Z]{3}$' THEN
    RAISE EXCEPTION 'gateway settlement anchor currency is required'
      USING ERRCODE = '55000';
  END IF;

  IF anchor_unit = 'BALANCE' THEN
    IF anchor_protocol IS DISTINCT FROM 'V1' THEN
      RAISE EXCEPTION 'gateway BALANCE settlement anchor protocol V1 is required'
        USING ERRCODE = '55000';
    END IF;

    SELECT
      reservation."status",
      reservation."collected_usd",
      COALESCE(SUM(grant_hold."amount_usd"), 0)
    INTO
      reservation_status,
      reservation_collected_usd,
      reservation_grant_hold_usd
    FROM "gateway_usage_funding_reservations" AS reservation
    LEFT JOIN "gateway_usage_funding_reservation_grants" AS grant_hold
      ON grant_hold."funding_reservation_id" = reservation."id"
    WHERE reservation."gateway_billing_event_id" = NEW."gateway_billing_event_id"
    GROUP BY reservation."id", reservation."status", reservation."collected_usd";

    IF NOT FOUND OR reservation_status NOT IN ('ACTIVE', 'MANUAL_REVIEW') THEN
      RAISE EXCEPTION 'gateway BALANCE active funding reservation is required'
        USING ERRCODE = '55000';
    END IF;

    IF reservation_grant_hold_usd IS DISTINCT FROM reservation_collected_usd THEN
      RAISE EXCEPTION 'gateway BALANCE funding grant holds must equal collected reservation'
        USING ERRCODE = '55000';
    END IF;
  ELSIF anchor_unit <> 'CREDITS' THEN
    RAISE EXCEPTION 'gateway settlement anchor billing unit is invalid'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER token_usage_gateway_settlement_protocol_guard
  BEFORE INSERT ON "token_usage"
  FOR EACH ROW EXECUTE FUNCTION enforce_gateway_token_usage_settlement_protocol();

-- Return a reason only when the immutable raw Gateway evidence itself proves
-- a permanently non-billable outcome.  Event/status strings are workflow
-- projections and are deliberately not authority for releasing a funding
-- hold.  Every billable dimension must be present and exactly zero.
CREATE OR REPLACE FUNCTION gateway_usage_jsonb_explicit_zero(
  raw_evidence JSONB,
  value_path TEXT[]
)
RETURNS BOOLEAN
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT COALESCE(
    jsonb_typeof(raw_evidence #> value_path) = 'number'
      AND (raw_evidence #> value_path) = '0'::JSONB,
    FALSE
  )
$$;

-- Mirror JavaScript Number.isSafeInteger() for every provider token_extras
-- value.  Billing's provider-evidence hard gate rejects malformed auxiliary
-- dimensions even when the two metered cache fields themselves are zero; the
-- database release predicate must not be weaker than that application gate.
CREATE OR REPLACE FUNCTION gateway_usage_jsonb_nonnegative_safe_integer(
  raw_value JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  numeric_value NUMERIC;
BEGIN
  IF raw_value IS NULL OR jsonb_typeof(raw_value) <> 'number' THEN
    RETURN FALSE;
  END IF;
  numeric_value := (raw_value #>> ARRAY[]::TEXT[])::NUMERIC;
  RETURN numeric_value >= 0
    AND numeric_value = trunc(numeric_value)
    AND numeric_value <= 9007199254740991;
END;
$$;

-- Match the ECMAScript String.trim() code-point set exactly. PostgreSQL's
-- btrim(text) removes only ASCII space and its POSIX space class omits NBSP
-- and BOM, both of which JavaScript trims. An explicit character set prevents
-- those code points from changing family, correlation, or dimension identity
-- between the application gate and PostgreSQL terminal proof.
CREATE OR REPLACE FUNCTION gateway_usage_jsonb_trimmed_string(
  raw_value JSONB
)
RETURNS TEXT
LANGUAGE sql
IMMUTABLE
PARALLEL SAFE
AS $$
  SELECT CASE
    WHEN jsonb_typeof(raw_value) = 'string' THEN NULLIF(
      btrim(
        raw_value #>> ARRAY[]::TEXT[],
        U&'\0009\000A\000B\000C\000D\0020\00A0\1680'
          || U&'\2000\2001\2002\2003\2004\2005\2006\2007'
          || U&'\2008\2009\200A\2028\2029\202F\205F\3000\FEFF'
      ),
      ''
    )
    ELSE NULL
  END
$$;

-- evaluateGatewayProviderEvidenceContract() accepts additional dimensions,
-- but every entry must be a non-empty string and must remain unique after the
-- same trim/lower normalization.  Required lower-case dimension names are
-- checked separately by JSON containment below.
CREATE OR REPLACE FUNCTION gateway_usage_jsonb_normalized_unique_strings(
  raw_array JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  element_count INTEGER;
  normalized_count INTEGER;
BEGIN
  IF raw_array IS NULL OR jsonb_typeof(raw_array) <> 'array' THEN
    RETURN FALSE;
  END IF;
  IF EXISTS (
    SELECT 1
    FROM jsonb_array_elements(raw_array) AS item(value)
    WHERE jsonb_typeof(item.value) <> 'string'
      OR gateway_usage_jsonb_trimmed_string(item.value) IS NULL
  ) THEN
    RETURN FALSE;
  END IF;
  SELECT
    COUNT(*),
    COUNT(DISTINCT lower(gateway_usage_jsonb_trimmed_string(item.value)))
  INTO element_count, normalized_count
  FROM jsonb_array_elements(raw_array) AS item(value);
  RETURN element_count = normalized_count;
END;
$$;

CREATE OR REPLACE FUNCTION gateway_permanent_no_charge_reason(
  raw_evidence JSONB
)
RETURNS TEXT
LANGUAGE plpgsql
IMMUTABLE
PARALLEL SAFE
AS $$
DECLARE
  dimensions JSONB;
  all_dimensions_zero BOOLEAN;
  provider_value TEXT;
  resolved_api_type_value TEXT;
  usage_protocol_value TEXT;
  provider_family TEXT;
  resolved_api_type_family TEXT;
  usage_protocol_family TEXT;
  upstream_request_id_value TEXT;
  upstream_response_id_value TEXT;
  requires_strict_upstream_request_id BOOLEAN;
BEGIN
  IF raw_evidence IS NULL OR jsonb_typeof(raw_evidence) <> 'object' THEN
    RETURN NULL;
  END IF;

  provider_value := lower(gateway_usage_jsonb_trimmed_string(
    raw_evidence->'provider'
  ));
  resolved_api_type_value := lower(gateway_usage_jsonb_trimmed_string(
    raw_evidence->'resolved_api_type'
  ));
  usage_protocol_value := lower(gateway_usage_jsonb_trimmed_string(
    raw_evidence #> ARRAY['usage_evidence', 'protocol']
  ));
  provider_family := CASE
    WHEN provider_value ~ '^anthropic(_|$)' THEN 'anthropic'
    WHEN provider_value ~ '^openai(_|$)' THEN 'openai'
    ELSE NULL
  END;
  resolved_api_type_family := CASE
    WHEN resolved_api_type_value ~ '^anthropic(_|$)' THEN 'anthropic'
    WHEN resolved_api_type_value ~ '^openai(_|$)' THEN 'openai'
    ELSE NULL
  END;
  usage_protocol_family := CASE
    WHEN usage_protocol_value ~ '^anthropic(_|$)' THEN 'anthropic'
    WHEN usage_protocol_value ~ '^openai(_|$)' THEN 'openai'
    ELSE NULL
  END;
  upstream_request_id_value := gateway_usage_jsonb_trimmed_string(
    raw_evidence->'upstream_request_id'
  );
  upstream_response_id_value := gateway_usage_jsonb_trimmed_string(
    raw_evidence->'upstream_response_id'
  );
  requires_strict_upstream_request_id :=
    COALESCE(
      provider_value IN ('anthropic', 'bigmodel', 'glm', 'zhipu', 'zhipuai'),
      FALSE
    )
    OR COALESCE(provider_family = 'anthropic', FALSE)
    OR COALESCE(resolved_api_type_family = 'anthropic', FALSE)
    OR COALESCE(usage_protocol_family = 'anthropic', FALSE);

  all_dimensions_zero :=
    gateway_usage_jsonb_explicit_zero(raw_evidence, ARRAY['prompt_tokens'])
    AND gateway_usage_jsonb_explicit_zero(raw_evidence, ARRAY['completion_tokens'])
    AND gateway_usage_jsonb_explicit_zero(raw_evidence, ARRAY['total_tokens'])
    AND gateway_usage_jsonb_explicit_zero(
      raw_evidence,
      ARRAY['token_extras', 'cached_tokens']
    )
    AND gateway_usage_jsonb_explicit_zero(
      raw_evidence,
      ARRAY['token_extras', 'cache_creation_input_tokens']
    )
    AND gateway_usage_jsonb_explicit_zero(raw_evidence, ARRAY['image_count']);
  IF NOT all_dimensions_zero THEN
    RETURN NULL;
  END IF;

  -- This exact quota rejection is proven to have stopped before any provider
  -- request/response began.  A descriptive reason such as
  -- auth_rejected_before_delivery is intentionally insufficient.
  IF raw_evidence->>'status' = 'failure'
     AND raw_evidence->'status_code' = '429'::JSONB
     AND raw_evidence->'error' @> '{"stage":"auth","type":"quota_exceeded"}'::JSONB
     AND raw_evidence->'upstream_started' = 'false'::JSONB
     AND raw_evidence->'response_started' = 'false'::JSONB
     AND raw_evidence->>'quota_settlement' = 'rollback' THEN
    RETURN 'quota_exceeded';
  END IF;

  dimensions := raw_evidence #> ARRAY['usage_evidence', 'dimensions_present'];
  -- Provider-terminal zero usage is accepted only when the complete signed
  -- dimension set is explicit and no provider reconciliation remains.
  IF raw_evidence->>'status' = 'success'
     AND raw_evidence->>'token_source' = 'provider'
     AND raw_evidence->>'stream_end_reason' = 'normal_end'
     AND raw_evidence->>'producer_build_sha'
       ~ '^([0-9a-f]{40}|sha256:[0-9a-f]{64})$'
     AND raw_evidence->>'provider_usage_hash' ~ '^sha256:[0-9a-f]{64}$'
     AND gateway_usage_jsonb_trimmed_string(
       raw_evidence->'provider_account_ref'
     ) IS NOT NULL
     -- Keep the database terminal proof exactly aligned with the pure
     -- TypeScript evidence evaluator. Vendor names such as zhipu are
     -- protocol-neutral, while resolved_api_type and evidence protocol must
     -- both declare one known family and all declared families must agree.
     AND provider_value IS NOT NULL
     AND provider_value <> ''
     AND resolved_api_type_value IS NOT NULL
     AND resolved_api_type_value <> ''
     AND resolved_api_type_family IS NOT NULL
     AND usage_protocol_value IS NOT NULL
     AND usage_protocol_value <> ''
     AND usage_protocol_family IS NOT NULL
     AND resolved_api_type_family = usage_protocol_family
     AND (provider_family IS NULL OR provider_family = resolved_api_type_family)
     AND (
       (
         requires_strict_upstream_request_id
         AND upstream_request_id_value IS NOT NULL
       )
       OR (
         NOT requires_strict_upstream_request_id
         AND (
           upstream_request_id_value IS NOT NULL
           OR upstream_response_id_value IS NOT NULL
         )
       )
     )
     AND raw_evidence->'provider_reconciliation_required' = 'false'::JSONB
     AND raw_evidence #>> ARRAY['usage_evidence', 'source'] = 'provider_terminal'
     AND raw_evidence #>> ARRAY['usage_evidence', 'status'] = 'complete'
     AND raw_evidence #> ARRAY['usage_evidence', 'terminal_frame_seen'] = 'true'::JSONB
     AND gateway_usage_jsonb_normalized_unique_strings(dimensions)
     AND jsonb_typeof(raw_evidence->'token_extras') = 'object'
     AND NOT EXISTS (
       SELECT 1
       FROM jsonb_each(raw_evidence->'token_extras') AS extra(key, value)
       WHERE NOT gateway_usage_jsonb_nonnegative_safe_integer(extra.value)
     )
     AND dimensions @> '["input_tokens","output_tokens","cache_read_input_tokens","cache_creation_input_tokens"]'::JSONB THEN
    RETURN 'zero_usage';
  END IF;

  RETURN NULL;
END;
$$;

-- Gateway money movement is allowed only while the strict Release-B ledger
-- contract is physically installed. A name-only count is insufficient: bind
-- each of the 15 required triggers to its exact relation, trigger function,
-- enabled state, timing/event bitmap and deferred semantics. This function is
-- shared by runtime startup preflight and deferred terminal proof.
CREATE OR REPLACE FUNCTION assert_gateway_balance_ledger_v2_contract()
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  rollout_row_count BIGINT;
  rollout_phase TEXT;
  expected_trigger_count CONSTANT INTEGER := 15;
  actual_trigger_count BIGINT;
  missing_trigger_count BIGINT;
  unexpected_trigger_count BIGINT;
BEGIN
  SELECT
    COUNT(*),
    MAX(control.phase) FILTER (WHERE control.id = 1)
  INTO rollout_row_count, rollout_phase
  FROM public.balance_ledger_rollout_control AS control;

  IF rollout_row_count IS DISTINCT FROM 1
     OR rollout_phase IS DISTINCT FROM 'V2_CONTRACT' THEN
    RAISE EXCEPTION
      'gateway settlement requires Release-B V2_CONTRACT phase rows=% phase=%',
      rollout_row_count,
      COALESCE(rollout_phase, 'MISSING')
      USING ERRCODE = '55000';
  END IF;

  WITH expected(
    relation_schema,
    relation_name,
    trigger_name,
    function_schema,
    function_name,
    function_arguments,
    enabled_state,
    is_deferrable,
    is_initially_deferred,
    trigger_type
  ) AS (
    VALUES
      ('public', 'account_wallets', 'account_wallets_clean_canonical_deferred', 'public', 'assert_clean_account_wallet_canonical_deferred', '', 'O', TRUE, TRUE, 21),
      ('public', 'account_wallets', 'account_wallets_identity_guard', 'public', 'guard_account_wallet_identity', '', 'O', FALSE, FALSE, 27),
      ('public', 'account_wallets', 'balance_canonical_revision_marker', 'public', 'mark_balance_canonical_revision', '', 'O', FALSE, FALSE, 23),
      ('public', 'balance_consumption_allocations', 'balance_canonical_revision_marker', 'public', 'mark_balance_canonical_revision', '', 'O', FALSE, FALSE, 23),
      ('public', 'balance_consumption_allocations', 'balance_consumption_allocations_identity_guard', 'public', 'guard_balance_consumption_allocation_identity', '', 'O', FALSE, FALSE, 23),
      ('public', 'balance_consumption_allocations', 'balance_debt_allocations_clean_canonical_deferred', 'public', 'assert_clean_account_wallet_canonical_deferred', '', 'O', TRUE, TRUE, 21),
      ('public', 'balance_grant_refund_allocations', 'balance_grant_refund_allocations_canonical_deferred', 'public', 'validate_balance_grant_refund_trigger', '', 'O', TRUE, TRUE, 5),
      ('public', 'balance_grant_refunds', 'balance_grant_refunds_canonical_deferred', 'public', 'validate_balance_grant_refund_trigger', '', 'O', TRUE, TRUE, 5),
      ('public', 'balance_grants', 'balance_canonical_revision_marker', 'public', 'mark_balance_canonical_revision', '', 'O', FALSE, FALSE, 23),
      ('public', 'balance_grants', 'balance_grants_clean_canonical_deferred', 'public', 'assert_clean_account_wallet_canonical_deferred', '', 'O', TRUE, TRUE, 21),
      ('public', 'balance_grants', 'balance_grants_expiry_aggregate_deferred', 'public', 'validate_balance_grant_expiry_transition_trigger', '', 'O', TRUE, TRUE, 17),
      ('public', 'balance_grants', 'balance_grants_expiry_reconciled_v2_guard', 'public', 'guard_balance_grant_expiry_reconciled_v2', '', 'O', FALSE, FALSE, 19),
      ('public', 'balance_transactions', 'balance_canonical_revision_marker', 'public', 'mark_balance_canonical_revision', '', 'O', FALSE, FALSE, 23),
      ('public', 'balance_transactions', 'balance_transactions_clean_canonical_deferred', 'public', 'assert_clean_account_wallet_canonical_deferred', '', 'O', TRUE, TRUE, 21),
      ('public', 'billing_accounts', 'billing_accounts_clean_type_guard', 'public', 'guard_clean_billing_account_type', '', 'O', FALSE, FALSE, 19)
  ),
  actual AS (
    SELECT
      relation_namespace.nspname::TEXT AS relation_schema,
      relation.relname::TEXT AS relation_name,
      trigger_row.tgname::TEXT AS trigger_name,
      function_namespace.nspname::TEXT AS function_schema,
      function_row.proname::TEXT AS function_name,
      pg_get_function_identity_arguments(function_row.oid)::TEXT AS function_arguments,
      trigger_row.tgenabled::TEXT AS enabled_state,
      trigger_row.tgdeferrable AS is_deferrable,
      trigger_row.tginitdeferred AS is_initially_deferred,
      trigger_row.tgtype::INTEGER AS trigger_type
    FROM pg_catalog.pg_trigger AS trigger_row
    JOIN pg_catalog.pg_class AS relation
      ON relation.oid = trigger_row.tgrelid
    JOIN pg_catalog.pg_namespace AS relation_namespace
      ON relation_namespace.oid = relation.relnamespace
    JOIN pg_catalog.pg_proc AS function_row
      ON function_row.oid = trigger_row.tgfoid
    JOIN pg_catalog.pg_namespace AS function_namespace
      ON function_namespace.oid = function_row.pronamespace
    WHERE NOT trigger_row.tgisinternal
      AND trigger_row.tgname IN (SELECT trigger_name FROM expected)
      AND function_row.prorettype = 'trigger'::REGTYPE
  )
  SELECT
    (SELECT COUNT(*) FROM actual),
    (
      SELECT COUNT(*)
      FROM expected
      LEFT JOIN actual
        ON ROW(
          actual.relation_schema,
          actual.relation_name,
          actual.trigger_name,
          actual.function_schema,
          actual.function_name,
          actual.function_arguments,
          actual.enabled_state,
          actual.is_deferrable,
          actual.is_initially_deferred,
          actual.trigger_type
        ) = ROW(
          expected.relation_schema,
          expected.relation_name,
          expected.trigger_name,
          expected.function_schema,
          expected.function_name,
          expected.function_arguments,
          expected.enabled_state,
          expected.is_deferrable,
          expected.is_initially_deferred,
          expected.trigger_type
        )
      WHERE actual.trigger_name IS NULL
    ),
    (
      SELECT COUNT(*)
      FROM actual
      LEFT JOIN expected
        ON ROW(
          actual.relation_schema,
          actual.relation_name,
          actual.trigger_name,
          actual.function_schema,
          actual.function_name,
          actual.function_arguments,
          actual.enabled_state,
          actual.is_deferrable,
          actual.is_initially_deferred,
          actual.trigger_type
        ) = ROW(
          expected.relation_schema,
          expected.relation_name,
          expected.trigger_name,
          expected.function_schema,
          expected.function_name,
          expected.function_arguments,
          expected.enabled_state,
          expected.is_deferrable,
          expected.is_initially_deferred,
          expected.trigger_type
        )
      WHERE expected.trigger_name IS NULL
    )
  INTO actual_trigger_count, missing_trigger_count, unexpected_trigger_count;

  IF actual_trigger_count IS DISTINCT FROM expected_trigger_count
     OR missing_trigger_count <> 0
     OR unexpected_trigger_count <> 0 THEN
    RAISE EXCEPTION
      'gateway settlement Release-B trigger contract failed actual=% missing=% unexpected=%',
      actual_trigger_count,
      missing_trigger_count,
      unexpected_trigger_count
      USING ERRCODE = '55000';
  END IF;
END;
$$;

-- Re-read the final row at COMMIT. Immediate row triggers can validate write
-- shape, but only a deferred constraint can prove that T1 grant backing is
-- complete and that T2 usage, ledger, reservation and permanent receipt were
-- committed as one financial unit.
CREATE OR REPLACE FUNCTION assert_gateway_usage_funding_terminal(
  target_reservation_id TEXT
)
RETURNS VOID AS $$
DECLARE
  reservation RECORD;
  anchor RECORD;
  event RECORD;
  usage RECORD;
  receipt RECORD;
  balance_tx RECORD;
  hold_amount NUMERIC(20,12);
  allocation_amount NUMERIC(20,12);
  allocation_collected_amount NUMERIC(20,12);
  allocation_approved_amount NUMERIC(20,12);
  allocation_unapproved_amount NUMERIC(20,12);
  allocation_count BIGINT;
  invalid_allocation_count BIGINT;
  invalid_reserved_grant_allocation_count BIGINT;
  balance_tx_found BOOLEAN;
  balance_tx_id TEXT;
  receipt_count BIGINT;
  release_proof_count BIGINT;
  ledger_account_status TEXT;
  ledger_account_version INTEGER;
  ledger_wallet_balance NUMERIC;
  ledger_wallet_path_ids TEXT[];
  ledger_tail_transaction_id TEXT;
BEGIN
  SELECT * INTO reservation
  FROM "gateway_usage_funding_reservations"
  WHERE "id" = target_reservation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gateway funding terminal proof references missing reservation'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO anchor
  FROM "gateway_usage_settlement_anchors"
  WHERE "gateway_billing_event_id" = reservation."gateway_billing_event_id";
  IF NOT FOUND
     OR anchor."request_id" IS DISTINCT FROM reservation."request_id"
     OR anchor."api_key_id" IS DISTINCT FROM reservation."api_key_id"
     OR anchor."user_id" IS DISTINCT FROM reservation."user_id"
     OR anchor."tenant_id" IS DISTINCT FROM reservation."tenant_id"
     OR anchor."billing_account_id" IS DISTINCT FROM reservation."billing_account_id"
     OR anchor."billing_unit" IS DISTINCT FROM 'BALANCE'
     OR anchor."billing_currency" IS DISTINCT FROM reservation."billing_currency"
     OR anchor."occurred_at" IS DISTINCT FROM reservation."occurred_at"
     OR anchor."first_received_at" IS DISTINCT FROM reservation."first_received_at"
     OR anchor."first_receipt_sequence" IS DISTINCT FROM reservation."reservation_sequence"
     OR anchor."funding_reservation_protocol" IS DISTINCT FROM 'V1'
     OR anchor."anchor_hash" IS DISTINCT FROM reservation."anchor_hash" THEN
    RAISE EXCEPTION 'gateway funding reservation terminal anchor binding is invalid'
      USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(SUM(hold."amount_usd"), 0)
  INTO hold_amount
  FROM "gateway_usage_funding_reservation_grants" AS hold
  WHERE hold."funding_reservation_id" = reservation."id";
  IF hold_amount IS DISTINCT FROM reservation."collected_usd" THEN
    RAISE EXCEPTION 'gateway funding reservation grant backing is incomplete'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO event
  FROM "gateway_billing_events"
  WHERE "id" = reservation."gateway_billing_event_id";
  IF NOT FOUND OR event."request_id" IS DISTINCT FROM reservation."request_id" THEN
    RAISE EXCEPTION 'gateway funding reservation parent event is invalid'
      USING ERRCODE = '55000';
  END IF;

  IF reservation."status" = 'ACTIVE' THEN
    RETURN;
  END IF;

  IF reservation."status" = 'MANUAL_REVIEW' THEN
    IF event."status" IS DISTINCT FROM 'QUARANTINED'
       OR event."reconciliation_status" IS DISTINCT FROM 'MANUAL_REVIEW' THEN
      RAISE EXCEPTION 'gateway funding manual review lacks quarantined event proof'
        USING ERRCODE = '55000';
    END IF;
    RETURN;
  END IF;

  -- Rollout mode and build authority are mutable database state. Every money
  -- terminal must see a fresh statement snapshot even in SHADOW, including
  -- release paths that do not produce a TokenUsage row.
  PERFORM assert_gateway_financial_read_committed();

  -- Both financial consumption and permanent release are money-moving
  -- terminal states. Re-prove Release-B at commit even when startup preflight
  -- previously passed, so a disabled/dropped strict trigger cannot create a
  -- settlement window between deployment checks.
  PERFORM assert_gateway_balance_ledger_v2_contract();

  IF reservation."status" = 'CONSUMED' THEN
    SELECT
      account."balance_grant_ledger_status",
      account."balance_grant_ledger_version",
      wallet."balance_usd"
    INTO
      ledger_account_status,
      ledger_account_version,
      ledger_wallet_balance
    FROM "billing_accounts" AS account
    JOIN "account_wallets" AS wallet
      ON wallet."billing_account_id" = account."id"
    WHERE account."id" = reservation."billing_account_id";
    IF NOT FOUND
       OR ledger_account_status IS DISTINCT FROM 'RECONCILED_V2'
       OR ledger_account_version IS DISTINCT FROM 2 THEN
      RAISE EXCEPTION 'gateway terminal settlement requires reconciled v2 ledger'
        USING ERRCODE = '55000';
    END IF;

    SELECT * INTO usage
    FROM "token_usage"
    WHERE "gateway_billing_event_id" = reservation."gateway_billing_event_id";
    IF NOT FOUND
       OR usage."request_id" IS DISTINCT FROM reservation."request_id"
       OR usage."api_key_id" IS DISTINCT FROM reservation."api_key_id"
       OR usage."tenant_id" IS DISTINCT FROM reservation."tenant_id"
       OR usage."product_id" IS DISTINCT FROM anchor."product_id"
       OR usage."customer_funding_classification_complete" IS DISTINCT FROM TRUE
       OR usage."customer_charge_usd" IS DISTINCT FROM reservation."authoritative_amount_usd"
       OR usage."customer_collected_usd"
          + usage."customer_approved_receivable_usd"
          + usage."customer_unapproved_debt_usd"
          IS DISTINCT FROM usage."customer_charge_usd" THEN
      RAISE EXCEPTION 'gateway consumed reservation lacks matching TokenUsage proof'
        USING ERRCODE = '55000';
    END IF;

    IF usage."customer_approved_receivable_usd" > reservation."approved_credit_usd"
       OR usage."customer_collected_usd" < LEAST(
         reservation."authoritative_amount_usd",
         reservation."collected_usd"
       ) THEN
      RAISE EXCEPTION 'gateway consumed reservation exceeds frozen funding authority'
        USING ERRCODE = '55000';
    END IF;

    SELECT COUNT(*) INTO receipt_count
    FROM "gateway_usage_settlement_receipts"
    WHERE "gateway_billing_event_id" = reservation."gateway_billing_event_id"
      AND "request_id" = reservation."request_id"
      AND "token_usage_id" = usage."id"
      AND "policy_version" = 'gateway-settlement-v2';
    IF receipt_count <> 1 THEN
      RAISE EXCEPTION 'gateway consumed reservation requires exactly one v2 receipt'
        USING ERRCODE = '55000';
    END IF;

    SELECT * INTO receipt
    FROM "gateway_usage_settlement_receipts"
    WHERE "gateway_billing_event_id" = reservation."gateway_billing_event_id"
      AND "request_id" = reservation."request_id"
      AND "token_usage_id" = usage."id"
      AND "policy_version" = 'gateway-settlement-v2';
    IF receipt."amount_usd" IS DISTINCT FROM reservation."authoritative_amount_usd"
       OR receipt."anchor_hash" IS DISTINCT FROM reservation."anchor_hash"
       OR receipt."pricing_hash" IS DISTINCT FROM anchor."pricing_hash"
       OR receipt."billing_unit" IS DISTINCT FROM 'BALANCE'
       OR receipt."billing_currency" IS DISTINCT FROM reservation."billing_currency"
       OR receipt."evidence_hash" IS NULL
       OR receipt."settlement_fingerprint" IS NULL
       OR NOT EXISTS (
         SELECT 1
         FROM "gateway_usage_evidences" AS selected_evidence
         WHERE selected_evidence."gateway_billing_event_id" =
             reservation."gateway_billing_event_id"
           AND selected_evidence."request_id" = reservation."request_id"
           AND selected_evidence."evidence_hash" = receipt."evidence_hash"
       )
       OR (
         usage."customer_unapproved_debt_usd" > 0
         AND receipt."funding_outcome" IS DISTINCT FROM 'DEBT_OPEN'
       )
       OR (
         usage."customer_unapproved_debt_usd" = 0
         AND usage."customer_approved_receivable_usd" > 0
         AND receipt."funding_outcome" IS DISTINCT FROM 'RECEIVABLE'
       )
       OR (
         usage."customer_unapproved_debt_usd" = 0
         AND usage."customer_approved_receivable_usd" = 0
         AND receipt."funding_outcome" IS DISTINCT FROM 'COLLECTED'
       ) THEN
      RAISE EXCEPTION 'gateway consumed reservation v2 receipt is inconsistent'
        USING ERRCODE = '55000';
    END IF;

    IF current_gateway_usage_evidence_contract_mode() IS DISTINCT FROM 'SHADOW'
       AND NOT gateway_usage_evidence_has_current_build_authority(
         reservation."gateway_billing_event_id",
         reservation."request_id",
         receipt."evidence_hash"
       ) THEN
      RAISE EXCEPTION 'gateway financial settlement build authority is not current'
        USING ERRCODE = '55000';
    END IF;

    SELECT * INTO balance_tx
    FROM "balance_transactions"
    WHERE "token_usage_id" = usage."id";
    balance_tx_found := FOUND;
    balance_tx_id := CASE WHEN balance_tx_found THEN balance_tx."id" ELSE NULL END;
    IF reservation."authoritative_amount_usd" > 0 AND NOT balance_tx_found THEN
      RAISE EXCEPTION 'gateway consumed reservation lacks balance transaction'
        USING ERRCODE = '55000';
    END IF;
    IF reservation."authoritative_amount_usd" = 0 AND balance_tx_found THEN
      RAISE EXCEPTION 'gateway zero-price settlement must not create balance transaction'
        USING ERRCODE = '55000';
    END IF;
    IF balance_tx_found AND (
      balance_tx."billing_account_id" IS DISTINCT FROM reservation."billing_account_id"
      OR balance_tx."tenant_id" IS DISTINCT FROM reservation."tenant_id"
      OR balance_tx."user_id" IS DISTINCT FROM reservation."user_id"
      OR balance_tx."type"::TEXT IS DISTINCT FROM 'CONSUME'
      OR balance_tx."amount_usd" IS DISTINCT FROM -reservation."authoritative_amount_usd"
    ) THEN
      RAISE EXCEPTION 'gateway consumed reservation balance transaction is inconsistent'
        USING ERRCODE = '55000';
    END IF;

    IF reservation."authoritative_amount_usd" > 0 THEN
      -- Reuse the canonical ledger path assertions instead of accepting a
      -- locally plausible CONSUME/allocation pair.  Release-B's deferred
      -- canonical aggregate independently proves the grant/debt final state;
      -- these calls bind this terminal transaction to that same wallet path
      -- and allocation order.
      ledger_wallet_path_ids := "assert_balance_transaction_unique_wallet_path"(
        reservation."billing_account_id",
        ledger_wallet_balance
      );
      PERFORM "assert_balance_allocation_sequence_order"(
        reservation."billing_account_id",
        ledger_wallet_path_ids
      );
      SELECT tail."id" INTO ledger_tail_transaction_id
      FROM "balance_transactions" AS tail
      WHERE tail."billing_account_id" = reservation."billing_account_id"
      ORDER BY tail."ledger_sequence" DESC
      LIMIT 1;
      IF ledger_tail_transaction_id IS DISTINCT FROM balance_tx."id"
         OR balance_tx."balance_after_usd" IS DISTINCT FROM ledger_wallet_balance THEN
        RAISE EXCEPTION 'gateway consumed reservation is not canonical wallet tail'
          USING ERRCODE = '55000';
      END IF;
    END IF;

    SELECT
      COALESCE(SUM(allocation."amount_usd"), 0),
      COALESCE(SUM(
        allocation."amount_usd"
        - allocation."approved_credit_usd"
        - allocation."unapproved_debt_usd"
      ), 0),
      COALESCE(SUM(allocation."approved_credit_usd"), 0),
      COALESCE(SUM(allocation."unapproved_debt_usd"), 0),
      COUNT(*),
      COUNT(*) FILTER (
        WHERE allocation."billing_account_id" IS DISTINCT FROM reservation."billing_account_id"
          OR allocation."tenant_id" IS DISTINCT FROM reservation."tenant_id"
          OR allocation."user_id" IS DISTINCT FROM reservation."user_id"
          OR allocation."token_usage_id" IS DISTINCT FROM usage."id"
          OR balance_tx_id IS NULL
          OR allocation."balance_transaction_id" IS DISTINCT FROM balance_tx_id
          OR allocation."funding_classification_complete" IS DISTINCT FROM TRUE
          OR (
            allocation."approved_credit_usd" > 0
            AND (
              allocation."source" IS DISTINCT FROM 'ENTERPRISE_CREDIT'
              OR allocation."credit_policy_snapshot_complete" IS DISTINCT FROM TRUE
              OR allocation."credit_policy_at" IS DISTINCT FROM
                reservation."credit_policy_at"
              OR allocation."credit_terms_days" IS DISTINCT FROM
                reservation."credit_terms_days"
              OR allocation."credit_due_at" IS DISTINCT FROM
                reservation."approved_credit_due_at"
            )
          )
      )
    INTO
      allocation_amount,
      allocation_collected_amount,
      allocation_approved_amount,
      allocation_unapproved_amount,
      allocation_count,
      invalid_allocation_count
    FROM "balance_consumption_allocations" AS allocation
    WHERE allocation."token_usage_id" = usage."id";
    IF allocation_amount IS DISTINCT FROM reservation."authoritative_amount_usd"
       OR allocation_collected_amount IS DISTINCT FROM usage."customer_collected_usd"
       OR allocation_approved_amount IS DISTINCT FROM
          usage."customer_approved_receivable_usd"
       OR allocation_approved_amount > reservation."approved_credit_usd"
       OR allocation_unapproved_amount IS DISTINCT FROM
          usage."customer_unapproved_debt_usd"
       OR invalid_allocation_count <> 0
       OR (reservation."authoritative_amount_usd" > 0 AND allocation_count = 0)
       OR (reservation."authoritative_amount_usd" = 0 AND allocation_count <> 0) THEN
      RAISE EXCEPTION 'gateway consumed reservation allocation proof is inconsistent'
        USING ERRCODE = '55000';
    END IF;

    -- The application consumes the immutable grant holds in allocation_order
    -- until min(authoritative, frozen-collected) is satisfied. The last hold
    -- may be partial, and later supplemental cash may legally consume more
    -- from the same grant, so prove a per-grant lower bound rather than exact
    -- equality with the frozen slice.
    SELECT COUNT(*) INTO invalid_reserved_grant_allocation_count
    FROM (
      SELECT
        hold."balance_grant_id",
        LEAST(
          hold."amount_usd",
          GREATEST(
            0::NUMERIC,
            LEAST(
              reservation."authoritative_amount_usd",
              reservation."collected_usd"
            ) - COALESCE(
              SUM(hold."amount_usd") OVER (
                ORDER BY hold."allocation_order"
                ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
              ),
              0
            )
          )
        ) AS required_amount_usd
      FROM "gateway_usage_funding_reservation_grants" AS hold
      WHERE hold."funding_reservation_id" = reservation."id"
    ) AS expected_hold
    WHERE expected_hold.required_amount_usd > 0
      AND COALESCE((
        SELECT SUM(allocation."amount_usd")
        FROM "balance_consumption_allocations" AS allocation
        WHERE allocation."token_usage_id" = usage."id"
          AND allocation."balance_transaction_id" = balance_tx_id
          AND allocation."balance_grant_id" = expected_hold."balance_grant_id"
          AND allocation."source" IN ('BALANCE_GRANT', 'UNRECONCILED_GRANT')
      ), 0) < expected_hold.required_amount_usd;
    IF invalid_reserved_grant_allocation_count <> 0 THEN
      RAISE EXCEPTION 'gateway consumed reservation did not consume frozen grant prefix'
        USING ERRCODE = '55000';
    END IF;
    RETURN;
  END IF;

  IF reservation."status" = 'RELEASED' THEN
    IF reservation."release_reason" LIKE 'financial_absorption:%' THEN
      SELECT COUNT(*) INTO release_proof_count
      FROM "gateway_usage_reconciliation_actions" AS action
      JOIN "gateway_usage_settlement_receipts" AS absorbed_receipt
        ON absorbed_receipt."gateway_billing_event_id" = action."gateway_billing_event_id"
       AND absorbed_receipt."request_id" = action."request_id"
       AND absorbed_receipt."funding_outcome" = 'ABSORBED'
       AND absorbed_receipt."actor_id" = action."actor_id"
       AND absorbed_receipt."idempotency_key" = 'receipt:' || action."idempotency_key"
      WHERE action."gateway_billing_event_id" = reservation."gateway_billing_event_id"
        AND action."request_id" = reservation."request_id"
        AND action."action" = 'ABSORB'
        AND action."expected_revision" + 1 = action."resulting_revision"
        AND action."resulting_revision" = event."revision"
        AND action."resulting_revision" = absorbed_receipt."settlement_revision"
        AND btrim(action."reason") <> ''
        AND action."reason" = event."reason"
        AND action."reason" = absorbed_receipt."reason"
        AND action."actor_id" IS NOT NULL
        AND btrim(action."actor_id") <> ''
        AND action."actor_id" = absorbed_receipt."actor_id"
        AND reservation."release_reason" =
          'financial_absorption:' || action."idempotency_key"
        AND event."status" = 'ABSORBED'
        AND event."reconciliation_status" = 'CLOSED'
        AND event."funding_outcome" = 'ABSORBED'
        AND event."pending_hold_usd" = 0
        AND absorbed_receipt."policy_version" = 'manual-finance-v2'
        AND absorbed_receipt."amount_usd" = reservation."reserved_amount_usd"
        AND absorbed_receipt."anchor_hash" = reservation."anchor_hash"
        AND absorbed_receipt."pricing_hash" = anchor."pricing_hash"
        AND absorbed_receipt."billing_unit" = 'BALANCE'
        AND absorbed_receipt."billing_currency" = reservation."billing_currency"
        AND absorbed_receipt."evidence_hash" = event."evidence_hash"
        AND absorbed_receipt."settlement_fingerprint" IS NOT NULL
        AND absorbed_receipt."token_usage_id" IS NULL
        AND action."metadata"->>'protocol' = 'gateway-absorb-v2'
        AND action."metadata"->>'fundingReservationId' = reservation."id"
        AND action."metadata"->>'reservationHash' = reservation."reservation_hash"
        AND action."metadata"->>'anchorHash' = reservation."anchor_hash"
        AND action."metadata"->>'pricingHash' = anchor."pricing_hash"
        AND action."metadata"->>'evidenceHash' = absorbed_receipt."evidence_hash"
        AND action."metadata"->>'billingCurrency' = reservation."billing_currency"
        AND (action."metadata"->>'approvedAbsorptionUsd')::NUMERIC
          = reservation."reserved_amount_usd"
        AND action."metadata"->>'settlementFingerprint'
          = absorbed_receipt."settlement_fingerprint"
        AND absorbed_receipt."payload"->>'customerDeductionUsd' = '0'
        AND (absorbed_receipt."payload"->>'approvedAbsorptionUsd')::NUMERIC
          = reservation."reserved_amount_usd"
        AND absorbed_receipt."payload"->>'fundingReservationId' = reservation."id"
        AND absorbed_receipt."payload"->>'reservationHash' = reservation."reservation_hash"
        AND absorbed_receipt."payload"->>'anchorHash' = reservation."anchor_hash"
        AND absorbed_receipt."payload"->>'pricingHash' = anchor."pricing_hash"
        AND absorbed_receipt."payload"->>'evidenceHash' = absorbed_receipt."evidence_hash"
        AND absorbed_receipt."payload"->>'billingCurrency' = reservation."billing_currency"
        AND absorbed_receipt."payload"->>'settlementFingerprint'
          = absorbed_receipt."settlement_fingerprint"
        AND EXISTS (
          SELECT 1
          FROM "gateway_usage_evidences" AS selected_evidence
          WHERE selected_evidence."gateway_billing_event_id" =
              reservation."gateway_billing_event_id"
            AND selected_evidence."request_id" = reservation."request_id"
            AND selected_evidence."evidence_hash" = absorbed_receipt."evidence_hash"
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "token_usage" AS billed_usage
          WHERE billed_usage."gateway_billing_event_id" =
              reservation."gateway_billing_event_id"
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "gateway_usage_settlement_receipts" AS financial_receipt
          WHERE financial_receipt."gateway_billing_event_id" =
              reservation."gateway_billing_event_id"
            AND financial_receipt."policy_version" = 'gateway-settlement-v2'
        );
    ELSIF reservation."release_reason" LIKE 'non_financial:%' THEN
      SELECT COUNT(*) INTO release_proof_count
      FROM "gateway_usage_settlement_receipts" AS no_charge_receipt
      WHERE no_charge_receipt."gateway_billing_event_id" = reservation."gateway_billing_event_id"
        AND no_charge_receipt."request_id" = reservation."request_id"
        AND no_charge_receipt."funding_outcome" = 'NO_CHARGE'
        AND no_charge_receipt."policy_version" = 'gateway-no-charge-v1'
        AND no_charge_receipt."settlement_revision" = event."revision"
        AND no_charge_receipt."amount_usd" = 0
        AND no_charge_receipt."token_usage_id" IS NULL
        AND no_charge_receipt."anchor_hash" = reservation."anchor_hash"
        AND no_charge_receipt."pricing_hash" = anchor."pricing_hash"
        AND no_charge_receipt."billing_unit" = 'BALANCE'
        AND no_charge_receipt."billing_currency" = reservation."billing_currency"
        AND no_charge_receipt."settlement_fingerprint" IS NOT NULL
        AND no_charge_receipt."reason" = event."reason"
        AND reservation."release_reason" = 'non_financial:' || event."reason"
        AND event."status" = 'SKIPPED'
        AND event."reconciliation_status" = 'CLOSED'
        AND event."funding_outcome" = 'NO_CHARGE'
        AND event."pending_exposure_usd" = 0
        AND event."pending_hold_usd" = 0
        AND event."input_tokens" = 0
        AND event."output_tokens" = 0
        AND event."cached_input_tokens" = 0
        AND event."cache_write_input_tokens" = 0
        AND event."total_tokens" = 0
        AND no_charge_receipt."payload"->>'customerDeductionUsd' = '0'
        AND no_charge_receipt."payload"->>'evidenceHash' = no_charge_receipt."evidence_hash"
        AND no_charge_receipt."payload"->>'anchorHash' = reservation."anchor_hash"
        AND no_charge_receipt."payload"->>'pricingHash' = anchor."pricing_hash"
        AND no_charge_receipt."payload"->>'settlementFingerprint'
          = no_charge_receipt."settlement_fingerprint"
        AND no_charge_receipt."payload"->>'reason' = no_charge_receipt."reason"
        AND EXISTS (
          SELECT 1 FROM "gateway_usage_evidences" AS selected_evidence
          WHERE selected_evidence."gateway_billing_event_id" =
              reservation."gateway_billing_event_id"
            AND selected_evidence."request_id" = reservation."request_id"
            AND selected_evidence."evidence_hash" = no_charge_receipt."evidence_hash"
            AND gateway_usage_evidence_has_current_build_authority(
              reservation."gateway_billing_event_id",
              reservation."request_id",
              no_charge_receipt."evidence_hash"
            )
            AND gateway_permanent_no_charge_reason(selected_evidence."raw_evidence")
              = no_charge_receipt."reason"
        )
        AND NOT EXISTS (
          SELECT 1 FROM "token_usage" AS billed_usage
          WHERE billed_usage."gateway_billing_event_id" = reservation."gateway_billing_event_id"
        )
        AND NOT EXISTS (
          SELECT 1 FROM "gateway_usage_settlement_receipts" AS financial_receipt
          WHERE financial_receipt."gateway_billing_event_id" = reservation."gateway_billing_event_id"
            AND financial_receipt."policy_version" = 'gateway-settlement-v2'
        );
    ELSE
      release_proof_count := 0;
    END IF;

    IF release_proof_count <> 1 THEN
      RAISE EXCEPTION 'gateway released reservation lacks one permanent release proof'
        USING ERRCODE = '55000';
    END IF;
    RETURN;
  END IF;

  RAISE EXCEPTION 'gateway funding reservation terminal status is invalid'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_gateway_usage_funding_terminal_trigger()
RETURNS trigger AS $$
BEGIN
  PERFORM assert_gateway_usage_funding_terminal(NEW."id");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER gateway_usage_funding_reservations_terminal_proof
  AFTER INSERT OR UPDATE ON "gateway_usage_funding_reservations"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_gateway_usage_funding_terminal_trigger();

CREATE OR REPLACE FUNCTION assert_gateway_token_usage_terminal_pair(
  target_token_usage_id TEXT
)
RETURNS VOID AS $$
DECLARE
  usage RECORD;
  anchor RECORD;
  reservation RECORD;
  receipt RECORD;
  receipt_count BIGINT;
BEGIN
  SELECT * INTO usage FROM "token_usage" WHERE "id" = target_token_usage_id;
  IF NOT FOUND OR usage."gateway_billing_event_id" IS NULL THEN
    RETURN;
  END IF;

  -- CREDITS has no BALANCE funding reservation, so its TokenUsage/receipt
  -- pair must enforce the same fresh-snapshot isolation independently.
  PERFORM assert_gateway_financial_read_committed();

  SELECT * INTO anchor
  FROM "gateway_usage_settlement_anchors"
  WHERE "gateway_billing_event_id" = usage."gateway_billing_event_id";
  IF NOT FOUND
     OR usage."request_id" IS DISTINCT FROM anchor."request_id"
     OR usage."api_key_id" IS DISTINCT FROM anchor."api_key_id"
     OR usage."tenant_id" IS DISTINCT FROM anchor."tenant_id"
     OR usage."product_id" IS DISTINCT FROM anchor."product_id" THEN
    RAISE EXCEPTION 'gateway TokenUsage terminal anchor binding is invalid'
      USING ERRCODE = '55000';
  END IF;

  SELECT COUNT(*) INTO receipt_count
  FROM "gateway_usage_settlement_receipts"
  WHERE "gateway_billing_event_id" = usage."gateway_billing_event_id"
    AND "request_id" = usage."request_id"
    AND "token_usage_id" = usage."id"
    AND "policy_version" = 'gateway-settlement-v2';
  IF receipt_count <> 1 THEN
    RAISE EXCEPTION 'gateway TokenUsage must commit with exactly one v2 receipt'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO receipt
  FROM "gateway_usage_settlement_receipts"
  WHERE "gateway_billing_event_id" = usage."gateway_billing_event_id"
    AND "request_id" = usage."request_id"
    AND "token_usage_id" = usage."id"
    AND "policy_version" = 'gateway-settlement-v2';
  IF receipt."anchor_hash" IS DISTINCT FROM anchor."anchor_hash"
     OR receipt."pricing_hash" IS DISTINCT FROM anchor."pricing_hash"
     OR receipt."billing_unit" IS DISTINCT FROM anchor."billing_unit"
     OR receipt."billing_currency" IS DISTINCT FROM anchor."billing_currency"
     OR receipt."evidence_hash" IS NULL
     OR receipt."settlement_fingerprint" IS NULL
     OR NOT EXISTS (
       SELECT 1
       FROM "gateway_usage_evidences" AS selected_evidence
       WHERE selected_evidence."gateway_billing_event_id" =
           usage."gateway_billing_event_id"
         AND selected_evidence."request_id" = usage."request_id"
         AND selected_evidence."evidence_hash" = receipt."evidence_hash"
     ) THEN
    RAISE EXCEPTION 'gateway TokenUsage v2 receipt binding is invalid'
      USING ERRCODE = '55000';
  END IF;

  IF current_gateway_usage_evidence_contract_mode() IS DISTINCT FROM 'SHADOW'
     AND NOT gateway_usage_evidence_has_current_build_authority(
       usage."gateway_billing_event_id",
       usage."request_id",
       receipt."evidence_hash"
     ) THEN
    RAISE EXCEPTION 'gateway financial settlement build authority is not current'
      USING ERRCODE = '55000';
  END IF;

  IF anchor."billing_unit" = 'BALANCE' THEN
    SELECT * INTO reservation
    FROM "gateway_usage_funding_reservations"
    WHERE "gateway_billing_event_id" = usage."gateway_billing_event_id";
    IF NOT FOUND OR reservation."status" IS DISTINCT FROM 'CONSUMED' THEN
      RAISE EXCEPTION 'gateway BALANCE TokenUsage requires consumed reservation'
        USING ERRCODE = '55000';
    END IF;
    PERFORM assert_gateway_usage_funding_terminal(reservation."id");
  ELSIF anchor."billing_unit" <> 'CREDITS' THEN
    RAISE EXCEPTION 'gateway TokenUsage anchor billing unit is invalid'
      USING ERRCODE = '55000';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_gateway_token_usage_terminal_pair_trigger()
RETURNS trigger AS $$
BEGIN
  PERFORM assert_gateway_token_usage_terminal_pair(NEW."id");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER token_usage_gateway_terminal_pair
  AFTER INSERT OR UPDATE ON "token_usage"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW EXECUTE FUNCTION validate_gateway_token_usage_terminal_pair_trigger();

-- A receipt can be inserted after an older TokenUsage row, so the TokenUsage
-- trigger alone is not a transaction-complete guard. Every automatic Gateway
-- financial receipt independently re-runs the same terminal pair proof. This
-- closes CREDITS (which deliberately has no BALANCE reservation trigger) and
-- all receipt insertion-order/replay paths.
CREATE OR REPLACE FUNCTION assert_gateway_financial_receipt_terminal_pair(
  target_receipt_id TEXT
)
RETURNS VOID AS $$
DECLARE
  receipt RECORD;
  usage RECORD;
BEGIN
  SELECT * INTO receipt
  FROM "gateway_usage_settlement_receipts"
  WHERE "id" = target_receipt_id;
  IF NOT FOUND OR receipt."policy_version" <> 'gateway-settlement-v2' THEN
    RETURN;
  END IF;
  PERFORM assert_gateway_financial_read_committed();
  IF receipt."token_usage_id" IS NULL THEN
    RAISE EXCEPTION 'gateway financial receipt requires TokenUsage'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO usage
  FROM "token_usage"
  WHERE "id" = receipt."token_usage_id";
  IF NOT FOUND OR usage."gateway_billing_event_id" IS NULL THEN
    RAISE EXCEPTION 'gateway financial receipt requires Gateway-linked TokenUsage'
      USING ERRCODE = '55000';
  END IF;
  PERFORM assert_gateway_token_usage_terminal_pair(usage."id");
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_gateway_financial_receipt_terminal_pair_trigger()
RETURNS trigger AS $$
BEGIN
  PERFORM assert_gateway_financial_receipt_terminal_pair(NEW."id");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER gateway_usage_settlement_receipts_terminal_pair
  AFTER INSERT OR UPDATE ON "gateway_usage_settlement_receipts"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION validate_gateway_financial_receipt_terminal_pair_trigger();

-- Financial and identity columns of a settled Gateway usage row are permanent.
-- Provider-cost enrichment remains a separate management-accounting operation.
CREATE OR REPLACE FUNCTION enforce_gateway_token_usage_financial_immutability()
RETURNS trigger AS $$
DECLARE
  mutable_provider_columns TEXT[] := ARRAY[
    'provider_cost_estimate_usd',
    'provider_cost_policy_id',
    'provider_cost_multiplier',
    'provider_input_cost_usd_per_m',
    'provider_cached_input_cost_usd_per_m',
    'provider_cache_write_cost_usd_per_m',
    'provider_output_cost_usd_per_m'
  ];
BEGIN
  IF OLD."gateway_billing_event_id" IS NULL THEN
    IF TG_OP = 'DELETE' THEN
      RETURN OLD;
    END IF;
    RETURN NEW;
  END IF;
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'gateway TokenUsage is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF (to_jsonb(NEW) - mutable_provider_columns)
     IS DISTINCT FROM (to_jsonb(OLD) - mutable_provider_columns) THEN
    RAISE EXCEPTION 'gateway TokenUsage financial facts are immutable'
      USING ERRCODE = '55000';
  END IF;
  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER token_usage_gateway_financial_immutable
  BEFORE UPDATE OR DELETE ON "token_usage"
  FOR EACH ROW EXECUTE FUNCTION enforce_gateway_token_usage_financial_immutability();
