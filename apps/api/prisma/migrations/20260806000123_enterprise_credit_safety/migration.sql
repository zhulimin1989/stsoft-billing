-- A positive enterprise credit line is valid only together with a positive
-- payment term. Abort instead of silently rewriting existing financial policy;
-- the deployment runbook contains the exact preflight/remediation query.
DO $$
DECLARE
  invalid_configs BIGINT;
  invalid_allocations BIGINT;
BEGIN
  SELECT COUNT(*) INTO invalid_configs
  FROM "billing_account_credit_configs"
  WHERE "status" = 'ACTIVE'
    AND "limit_usd" > 0
    AND ("terms_days" IS NULL OR "terms_days" <= 0);

  IF invalid_configs > 0 THEN
    RAISE EXCEPTION
      'enterprise credit safety preflight failed: % ACTIVE positive-limit configs lack positive terms_days',
      invalid_configs
      USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*) INTO invalid_allocations
  FROM "balance_consumption_allocations"
  WHERE "funding_classification_complete"
    AND "approved_credit_usd" > 0
    AND (
      NOT "credit_policy_snapshot_complete"
      OR "credit_terms_days" IS NULL
      OR "credit_terms_days" <= 0
      OR "credit_due_at" IS NULL
    );

  IF invalid_allocations > 0 THEN
    RAISE EXCEPTION
      'enterprise credit safety preflight failed: % approved-credit allocations lack complete positive terms/due date',
      invalid_allocations
      USING ERRCODE = '23514';
  END IF;
END;
$$;

ALTER TABLE "billing_account_credit_configs"
  ADD CONSTRAINT "billing_account_credit_configs_active_terms_check"
  CHECK (
    "status" <> 'ACTIVE'
    OR "limit_usd" <= 0
    OR ("terms_days" IS NOT NULL AND "terms_days" > 0)
  );

ALTER TABLE "balance_consumption_allocations"
  ADD CONSTRAINT "balance_allocations_approved_credit_due_check"
  CHECK (
    NOT "funding_classification_complete"
    OR "approved_credit_usd" = 0
    OR (
      "credit_policy_snapshot_complete"
      AND "credit_terms_days" IS NOT NULL
      AND "credit_terms_days" > 0
      AND "credit_due_at" IS NOT NULL
    )
  );

-- Immediate policy fanout cannot represent a future wall-clock transition.
-- These append-only markers make activation/expiration projection retryable.
ALTER TABLE "billing_account_credit_events"
  ADD COLUMN "activation_fanout_enqueued_at" TIMESTAMP(3),
  ADD COLUMN "expiration_fanout_enqueued_at" TIMESTAMP(3);

CREATE INDEX "billing_account_credit_configs_status_effective_at_idx"
  ON "billing_account_credit_configs"("status", "effective_at");

CREATE INDEX "billing_account_credit_events_timed_fanout_idx"
  ON "billing_account_credit_events"(
    "billing_account_id",
    "policy_revision",
    "activation_fanout_enqueued_at",
    "expiration_fanout_enqueued_at"
  );

-- Credit-event snapshots are financial authority for delayed settlement. Keep
-- the payload immutable while allowing only the two monotonic lifecycle writes:
-- pending -> confirmed visibility boundary, and NULL -> fanout marker.
CREATE OR REPLACE FUNCTION enforce_enterprise_credit_event_immutability()
RETURNS trigger AS $$
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'enterprise credit event history is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF ROW(
    NEW."id",
    NEW."billing_account_id",
    NEW."old_limit_usd",
    NEW."new_limit_usd",
    NEW."old_status",
    NEW."new_status",
    NEW."old_terms_days",
    NEW."new_terms_days",
    NEW."old_effective_at",
    NEW."new_effective_at",
    NEW."old_expires_at",
    NEW."new_expires_at",
    NEW."temporal_snapshot_complete",
    NEW."policy_revision",
    NEW."policy_decision_at",
    NEW."request_fingerprint",
    NEW."actor_id",
    NEW."reason",
    NEW."note",
    NEW."idempotency_key",
    NEW."created_at"
  ) IS DISTINCT FROM ROW(
    OLD."id",
    OLD."billing_account_id",
    OLD."old_limit_usd",
    OLD."new_limit_usd",
    OLD."old_status",
    OLD."new_status",
    OLD."old_terms_days",
    OLD."new_terms_days",
    OLD."old_effective_at",
    OLD."new_effective_at",
    OLD."old_expires_at",
    OLD."new_expires_at",
    OLD."temporal_snapshot_complete",
    OLD."policy_revision",
    OLD."policy_decision_at",
    OLD."request_fingerprint",
    OLD."actor_id",
    OLD."reason",
    OLD."note",
    OLD."idempotency_key",
    OLD."created_at"
  ) THEN
    RAISE EXCEPTION 'enterprise credit event financial snapshot is immutable'
      USING ERRCODE = '55000';
  END IF;

  IF OLD."policy_boundary_complete" THEN
    IF NOT NEW."policy_boundary_complete"
       OR NEW."policy_effective_boundary_at"
          IS DISTINCT FROM OLD."policy_effective_boundary_at" THEN
      RAISE EXCEPTION 'enterprise credit event confirmed boundary is immutable'
        USING ERRCODE = '55000';
    END IF;
  ELSE
    IF NEW."policy_boundary_complete" THEN
      IF NEW."policy_effective_boundary_at" IS NULL
         OR NEW."policy_effective_boundary_at" < NEW."policy_decision_at" THEN
        RAISE EXCEPTION 'enterprise credit event boundary confirmation is invalid'
          USING ERRCODE = '23514';
      END IF;
    ELSIF NEW."policy_effective_boundary_at" IS NOT NULL THEN
      RAISE EXCEPTION 'enterprise credit event pending boundary timestamp must remain null'
        USING ERRCODE = '23514';
    END IF;
  END IF;

  IF OLD."policy_fanout_enqueued_at" IS NOT NULL
     AND NEW."policy_fanout_enqueued_at"
       IS DISTINCT FROM OLD."policy_fanout_enqueued_at" THEN
    RAISE EXCEPTION 'enterprise credit policy fanout marker is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD."activation_fanout_enqueued_at" IS NOT NULL
     AND NEW."activation_fanout_enqueued_at"
       IS DISTINCT FROM OLD."activation_fanout_enqueued_at" THEN
    RAISE EXCEPTION 'enterprise credit activation fanout marker is immutable'
      USING ERRCODE = '55000';
  END IF;
  IF OLD."expiration_fanout_enqueued_at" IS NOT NULL
     AND NEW."expiration_fanout_enqueued_at"
       IS DISTINCT FROM OLD."expiration_fanout_enqueued_at" THEN
    RAISE EXCEPTION 'enterprise credit expiration fanout marker is immutable'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER billing_account_credit_events_immutable
  BEFORE UPDATE OR DELETE ON "billing_account_credit_events"
  FOR EACH ROW EXECUTE FUNCTION enforce_enterprise_credit_event_immutability();
