CREATE INDEX CONCURRENTLY "billing_account_credit_events_decision_boundary_idx"
  ON "billing_account_credit_events" (
    "billing_account_id",
    "policy_decision_at",
    "policy_revision"
  );
