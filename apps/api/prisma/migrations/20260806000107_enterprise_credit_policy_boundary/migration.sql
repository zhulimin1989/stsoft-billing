-- PostgreSQL created_at/updated_at defaults use the transaction timestamp,
-- which can precede commit visibility by an unbounded lock/commit window.
-- Credit history therefore needs a separately confirmed visibility boundary.
-- Existing rows remain revision 0 / incomplete and deliberately fail closed
-- for retrospective credit decisions that cannot be proven.
ALTER TABLE "billing_account_credit_configs"
  ADD COLUMN "policy_revision" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN "policy_effective_boundary_at" TIMESTAMP(3),
  ADD COLUMN "policy_boundary_complete" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "billing_account_credit_events"
  ADD COLUMN "policy_revision" INTEGER,
  ADD COLUMN "policy_decision_at" TIMESTAMP(3),
  ADD COLUMN "policy_effective_boundary_at" TIMESTAMP(3),
  ADD COLUMN "policy_boundary_complete" BOOLEAN NOT NULL DEFAULT false,
  ADD COLUMN "request_fingerprint" TEXT;

ALTER TABLE "billing_account_credit_configs"
  ADD CONSTRAINT "billing_account_credit_configs_policy_revision_check"
    CHECK ("policy_revision" >= 0) NOT VALID,
  ADD CONSTRAINT "billing_account_credit_configs_policy_boundary_shape_check"
    CHECK (
      (
        NOT "policy_boundary_complete"
        AND "policy_effective_boundary_at" IS NULL
      )
      OR (
        "policy_boundary_complete"
        AND "policy_revision" > 0
        AND "policy_effective_boundary_at" IS NOT NULL
      )
    ) NOT VALID;

ALTER TABLE "billing_account_credit_events"
  ADD CONSTRAINT "billing_account_credit_events_policy_revision_check"
    CHECK ("policy_revision" IS NULL OR "policy_revision" > 0) NOT VALID,
  ADD CONSTRAINT "billing_account_credit_events_policy_boundary_shape_check"
    CHECK (
      (
        "policy_revision" IS NULL
        AND NOT "policy_boundary_complete"
        AND "policy_decision_at" IS NULL
        AND "policy_effective_boundary_at" IS NULL
      )
      OR (
        "policy_revision" IS NOT NULL
        AND "temporal_snapshot_complete"
        AND "policy_decision_at" IS NOT NULL
        AND (
          (
            NOT "policy_boundary_complete"
            AND "policy_effective_boundary_at" IS NULL
          )
          OR (
            "policy_boundary_complete"
            AND "policy_effective_boundary_at" IS NOT NULL
            AND "policy_effective_boundary_at" >= "policy_decision_at"
          )
        )
      )
    ) NOT VALID;

ALTER TABLE "billing_account_credit_configs"
  VALIDATE CONSTRAINT "billing_account_credit_configs_policy_revision_check";
ALTER TABLE "billing_account_credit_configs"
  VALIDATE CONSTRAINT "billing_account_credit_configs_policy_boundary_shape_check";
ALTER TABLE "billing_account_credit_events"
  VALIDATE CONSTRAINT "billing_account_credit_events_policy_revision_check";
ALTER TABLE "billing_account_credit_events"
  VALIDATE CONSTRAINT "billing_account_credit_events_policy_boundary_shape_check";
