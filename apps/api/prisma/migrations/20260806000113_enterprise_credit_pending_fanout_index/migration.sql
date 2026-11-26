CREATE INDEX CONCURRENTLY "billing_account_credit_events_pending_fanout_idx"
  ON "billing_account_credit_events" (
    "policy_boundary_complete",
    "policy_fanout_enqueued_at",
    "billing_account_id",
    "policy_revision"
  );
