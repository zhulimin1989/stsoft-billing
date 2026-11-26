-- Bootstrap existing revision-0 configs without inventing historical credit.
-- The old snapshot is deliberately NULL: every request before this deployment
-- boundary remains no-credit. Current config becomes revision 1 only from the
-- separately confirmed boundary in the next migration.
BEGIN;

LOCK TABLE "billing_account_credit_configs" IN SHARE ROW EXCLUSIVE MODE;

WITH decision AS (
  SELECT date_trunc(
    'milliseconds',
    clock_timestamp() AT TIME ZONE 'UTC'
  )::TIMESTAMP(3) AS "decision_at"
)
INSERT INTO "billing_account_credit_events" (
  "id",
  "billing_account_id",
  "old_limit_usd",
  "new_limit_usd",
  "old_status",
  "new_status",
  "old_terms_days",
  "new_terms_days",
  "old_effective_at",
  "new_effective_at",
  "old_expires_at",
  "new_expires_at",
  "temporal_snapshot_complete",
  "policy_revision",
  "policy_decision_at",
  "policy_effective_boundary_at",
  "policy_boundary_complete",
  "actor_id",
  "reason",
  "note"
)
SELECT
  gen_random_uuid()::TEXT,
  config."billing_account_id",
  NULL,
  config."limit_usd",
  NULL,
  config."status",
  NULL,
  config."terms_days",
  NULL,
  config."effective_at",
  NULL,
  config."expires_at",
  true,
  1,
  decision."decision_at",
  NULL,
  false,
  'system:credit-revision-bootstrap',
  'system_revision_bootstrap',
  '存量授信仅从本次部署确认边界起生效；不追认此前历史请求'
FROM "billing_account_credit_configs" config
CROSS JOIN decision
WHERE config."policy_revision" = 0;

UPDATE "billing_account_credit_configs"
SET
  "policy_revision" = 1,
  "policy_effective_boundary_at" = NULL,
  "policy_boundary_complete" = false
WHERE "policy_revision" = 0;

COMMIT;
