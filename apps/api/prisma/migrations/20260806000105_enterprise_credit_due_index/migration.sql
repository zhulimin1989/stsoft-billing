CREATE INDEX CONCURRENTLY "balance_consumption_allocations_credit_due_idx"
  ON "balance_consumption_allocations" (
    "billing_account_id",
    "source",
    "settled_at",
    "credit_policy_snapshot_complete",
    "credit_due_at"
  );
