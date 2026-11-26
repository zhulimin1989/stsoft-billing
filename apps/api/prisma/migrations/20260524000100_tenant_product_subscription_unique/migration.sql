-- Product accounts are tenant-scoped. A single user may operate multiple
-- tenants that subscribe to the same product.
DROP INDEX IF EXISTS "user_subscriptions_user_id_product_id_key";

-- The product account owner is always the tenant. The platform has not
-- launched yet, so fail fast on empty/new databases instead of preserving
-- nullable user-scope records.
ALTER TABLE "user_subscriptions" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "orders" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "balance_transactions" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "api_keys" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "token_usage" ALTER COLUMN "tenant_id" SET NOT NULL;

ALTER TABLE "user_subscriptions" DROP CONSTRAINT IF EXISTS "user_subscriptions_tenant_id_fkey";
ALTER TABLE "orders" DROP CONSTRAINT IF EXISTS "orders_tenant_id_fkey";
ALTER TABLE "balance_transactions" DROP CONSTRAINT IF EXISTS "balance_transactions_tenant_id_fkey";
ALTER TABLE "api_keys" DROP CONSTRAINT IF EXISTS "api_keys_tenant_id_fkey";
ALTER TABLE "token_usage" DROP CONSTRAINT IF EXISTS "token_usage_tenant_id_fkey";

ALTER TABLE "user_subscriptions"
  ADD CONSTRAINT "user_subscriptions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "orders"
  ADD CONSTRAINT "orders_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "balance_transactions"
  ADD CONSTRAINT "balance_transactions_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "api_keys"
  ADD CONSTRAINT "api_keys_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "token_usage"
  ADD CONSTRAINT "token_usage_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
