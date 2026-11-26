CREATE INDEX CONCURRENTLY "billing_account_credit_events_effective_boundary_idx"
  ON "billing_account_credit_events" (
    "billing_account_id",
    "policy_effective_boundary_at",
    "policy_revision"
  );
