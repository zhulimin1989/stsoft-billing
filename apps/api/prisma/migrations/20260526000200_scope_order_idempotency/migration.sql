DROP INDEX IF EXISTS "orders_idempotency_key_key";

CREATE UNIQUE INDEX IF NOT EXISTS "orders_user_id_tenant_id_idempotency_key_key"
  ON "orders"("user_id", "tenant_id", "idempotency_key");
