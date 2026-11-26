-- This migration runs only after the pending bootstrap migration committed.
-- Its DB clock is therefore a conservative proof that revision 1 was visible.
BEGIN;

LOCK TABLE "billing_account_credit_configs" IN SHARE ROW EXCLUSIVE MODE;

WITH boundary AS (
  SELECT (
    date_trunc('milliseconds', clock_timestamp() AT TIME ZONE 'UTC')
    + INTERVAL '1 millisecond'
  )::TIMESTAMP(3) AS "effective_at"
), confirmed AS (
  UPDATE "billing_account_credit_events" event
  SET
    "policy_effective_boundary_at" = boundary."effective_at",
    "policy_boundary_complete" = true
  FROM boundary
  WHERE event."reason" = 'system_revision_bootstrap'
    AND event."policy_revision" = 1
    AND NOT event."policy_boundary_complete"
  RETURNING
    event."billing_account_id",
    event."policy_effective_boundary_at"
)
UPDATE "billing_account_credit_configs" config
SET
  "policy_effective_boundary_at" = confirmed."policy_effective_boundary_at",
  "policy_boundary_complete" = true
FROM confirmed
WHERE config."billing_account_id" = confirmed."billing_account_id"
  AND config."policy_revision" = 1
  AND NOT config."policy_boundary_complete";

COMMIT;

-- Every legacy row was either bootstrapped by 00114 or absent. Validation now
-- turns the mixed-version guard into a fully trusted database invariant.
ALTER TABLE "billing_account_credit_configs"
  VALIDATE CONSTRAINT "billing_account_credit_configs_revision_zero_safe_check";
