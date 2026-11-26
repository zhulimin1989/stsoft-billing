CREATE INDEX IF NOT EXISTS "orders_created_at_id_idx" ON "orders"("created_at", "id");
CREATE INDEX IF NOT EXISTS "orders_paid_at_id_idx" ON "orders"("paid_at", "id");
CREATE INDEX IF NOT EXISTS "orders_completed_at_id_idx" ON "orders"("completed_at", "id");
CREATE INDEX IF NOT EXISTS "orders_refunded_at_id_idx" ON "orders"("refunded_at", "id");

CREATE INDEX IF NOT EXISTS "credit_transactions_created_at_id_idx" ON "credit_transactions"("created_at", "id");
CREATE INDEX IF NOT EXISTS "balance_transactions_created_at_id_idx" ON "balance_transactions"("created_at", "id");
CREATE INDEX IF NOT EXISTS "balance_grants_created_at_id_idx" ON "balance_grants"("created_at", "id");
CREATE INDEX IF NOT EXISTS "balance_consumption_allocations_created_at_id_idx" ON "balance_consumption_allocations"("created_at", "id");
CREATE INDEX IF NOT EXISTS "token_usage_created_at_id_idx" ON "token_usage"("created_at", "id");
