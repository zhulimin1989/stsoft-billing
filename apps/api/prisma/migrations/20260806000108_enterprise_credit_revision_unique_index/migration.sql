CREATE UNIQUE INDEX CONCURRENTLY "billing_account_credit_events_account_revision_key"
  ON "billing_account_credit_events" ("billing_account_id", "policy_revision");
