-- Add recharge lot accounting for PAYG balance.
-- Each successful recharge creates one balance_grant row. Consumption rows allocate
-- each balance_transactions(CONSUME) amount to grants using FIFO and the grant
-- discount rate paid / (paid + bonus).

CREATE TABLE "balance_grants" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "order_id" TEXT,
    "product_id" TEXT,
    "source" TEXT NOT NULL DEFAULT 'RECHARGE',
    "paid_amount_usd" DECIMAL(20,12) NOT NULL,
    "bonus_amount_usd" DECIMAL(20,12) NOT NULL DEFAULT 0,
    "granted_amount_usd" DECIMAL(20,12) NOT NULL,
    "remaining_amount_usd" DECIMAL(20,12) NOT NULL,
    "discount_rate" DECIMAL(20,12) NOT NULL DEFAULT 1,
    "valid_from" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "is_expired" BOOLEAN NOT NULL DEFAULT false,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "balance_grants_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "balance_consumption_allocations" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "product_id" TEXT,
    "balance_transaction_id" TEXT NOT NULL,
    "token_usage_id" TEXT,
    "balance_grant_id" TEXT NOT NULL,
    "amount_usd" DECIMAL(20,12) NOT NULL,
    "recognized_revenue_usd" DECIMAL(20,12) NOT NULL,
    "bonus_consumed_usd" DECIMAL(20,12) NOT NULL,
    "discount_rate" DECIMAL(20,12) NOT NULL,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

    CONSTRAINT "balance_consumption_allocations_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "balance_grants_order_id_key" ON "balance_grants"("order_id");
CREATE INDEX "balance_grants_user_id_idx" ON "balance_grants"("user_id");
CREATE INDEX "balance_grants_tenant_id_idx" ON "balance_grants"("tenant_id");
CREATE INDEX "balance_grants_tenant_id_product_id_idx" ON "balance_grants"("tenant_id", "product_id");
CREATE INDEX "balance_grants_tenant_id_expires_at_idx" ON "balance_grants"("tenant_id", "expires_at");
CREATE INDEX "balance_grants_product_id_idx" ON "balance_grants"("product_id");
CREATE INDEX "balance_grants_expires_at_idx" ON "balance_grants"("expires_at");

CREATE INDEX "balance_consumption_allocations_user_id_idx" ON "balance_consumption_allocations"("user_id");
CREATE INDEX "balance_consumption_allocations_tenant_id_idx" ON "balance_consumption_allocations"("tenant_id");
CREATE INDEX "balance_consumption_allocations_tenant_id_created_at_idx" ON "balance_consumption_allocations"("tenant_id", "created_at");
CREATE INDEX "balance_consumption_allocations_product_id_idx" ON "balance_consumption_allocations"("product_id");
CREATE INDEX "balance_consumption_allocations_balance_transaction_id_idx" ON "balance_consumption_allocations"("balance_transaction_id");
CREATE INDEX "balance_consumption_allocations_token_usage_id_idx" ON "balance_consumption_allocations"("token_usage_id");
CREATE INDEX "balance_consumption_allocations_balance_grant_id_idx" ON "balance_consumption_allocations"("balance_grant_id");

ALTER TABLE "balance_grants" ADD CONSTRAINT "balance_grants_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "balance_grants" ADD CONSTRAINT "balance_grants_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "balance_grants" ADD CONSTRAINT "balance_grants_order_id_fkey" FOREIGN KEY ("order_id") REFERENCES "orders"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "balance_grants" ADD CONSTRAINT "balance_grants_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "balance_consumption_allocations" ADD CONSTRAINT "balance_consumption_allocations_user_id_fkey" FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "balance_consumption_allocations" ADD CONSTRAINT "balance_consumption_allocations_tenant_id_fkey" FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "balance_consumption_allocations" ADD CONSTRAINT "balance_consumption_allocations_product_id_fkey" FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "balance_consumption_allocations" ADD CONSTRAINT "balance_consumption_allocations_balance_transaction_id_fkey" FOREIGN KEY ("balance_transaction_id") REFERENCES "balance_transactions"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "balance_consumption_allocations" ADD CONSTRAINT "balance_consumption_allocations_token_usage_id_fkey" FOREIGN KEY ("token_usage_id") REFERENCES "token_usage"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "balance_consumption_allocations" ADD CONSTRAINT "balance_consumption_allocations_balance_grant_id_fkey" FOREIGN KEY ("balance_grant_id") REFERENCES "balance_grants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
