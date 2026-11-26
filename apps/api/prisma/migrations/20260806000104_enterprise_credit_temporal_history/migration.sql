-- Existing audit rows did not capture effective_at, so they are deliberately
-- marked incomplete. Delayed settlements must not infer historical credit from
-- those rows; only events written by the upgraded application are reconstructible.
ALTER TABLE "billing_account_credit_events"
  ADD COLUMN "old_effective_at" TIMESTAMP(3),
  ADD COLUMN "new_effective_at" TIMESTAMP(3),
  ADD COLUMN "temporal_snapshot_complete" BOOLEAN NOT NULL DEFAULT false;

ALTER TABLE "balance_consumption_allocations"
  ADD COLUMN "credit_policy_at" TIMESTAMP(3),
  ADD COLUMN "credit_terms_days" INTEGER,
  ADD COLUMN "credit_due_at" TIMESTAMP(3),
  ADD COLUMN "credit_policy_snapshot_complete" BOOLEAN NOT NULL DEFAULT false;

-- Add the checks without holding an ACCESS EXCLUSIVE lock for a legacy-table
-- scan. They immediately protect all new writes; validation below uses the
-- lighter lock intended for online verification.
ALTER TABLE "balance_consumption_allocations"
  ADD CONSTRAINT "balance_consumption_allocations_credit_terms_nonnegative_check"
    CHECK ("credit_terms_days" IS NULL OR "credit_terms_days" >= 0) NOT VALID,
  ADD CONSTRAINT "balance_consumption_allocations_credit_policy_complete_check"
    CHECK (
      NOT "credit_policy_snapshot_complete"
      OR "credit_policy_at" IS NOT NULL
    ) NOT VALID,
  ADD CONSTRAINT "balance_consumption_allocations_credit_due_shape_check"
    CHECK (
      "credit_due_at" IS NULL
      OR (
        "credit_policy_snapshot_complete"
        AND "credit_policy_at" IS NOT NULL
        AND "credit_terms_days" > 0
        AND "credit_due_at" >= "credit_policy_at"
      )
    ) NOT VALID;

ALTER TABLE "balance_consumption_allocations"
  VALIDATE CONSTRAINT "balance_consumption_allocations_credit_terms_nonnegative_check";
ALTER TABLE "balance_consumption_allocations"
  VALIDATE CONSTRAINT "balance_consumption_allocations_credit_policy_complete_check";
ALTER TABLE "balance_consumption_allocations"
  VALIDATE CONSTRAINT "balance_consumption_allocations_credit_due_shape_check";
