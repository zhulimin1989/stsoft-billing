-- Standalone because CREATE INDEX CONCURRENTLY cannot run in a transaction.
CREATE INDEX CONCURRENTLY "enterprise_credit_settlements_occurred_id_idx"
ON "enterprise_credit_settlements" ("occurred_at", "id");
