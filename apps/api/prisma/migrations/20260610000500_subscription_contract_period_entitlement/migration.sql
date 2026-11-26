-- Subscription long-term model.
-- No backfill is performed because subscription has not been launched in
-- production; existing non-production user_subscriptions can be recreated
-- through the new activation path.

CREATE TABLE "subscription_contracts" (
    "id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "billing_account_id" TEXT,
    "product_id" TEXT NOT NULL,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "ended_at" TIMESTAMP(3),
    "termination_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "subscription_contracts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "subscription_periods" (
    "id" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "user_subscription_id" TEXT,
    "user_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "billing_account_id" TEXT,
    "product_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "billing_period" TEXT NOT NULL DEFAULT 'monthly',
    "sequence" INTEGER NOT NULL DEFAULT 1,
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "termination_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "subscription_periods_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "subscription_entitlements" (
    "id" TEXT NOT NULL,
    "contract_id" TEXT NOT NULL,
    "period_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "billing_account_id" TEXT,
    "product_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "entitlement_type" TEXT NOT NULL DEFAULT 'plan_access',
    "source" TEXT NOT NULL DEFAULT 'subscription_period',
    "status" "SubscriptionStatus" NOT NULL DEFAULT 'ACTIVE',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "ended_at" TIMESTAMP(3),
    "termination_reason" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    CONSTRAINT "subscription_entitlements_pkey" PRIMARY KEY ("id")
);

CREATE INDEX "subscription_contracts_user_id_idx" ON "subscription_contracts"("user_id");
CREATE INDEX "subscription_contracts_tenant_id_idx" ON "subscription_contracts"("tenant_id");
CREATE INDEX "subscription_contracts_billing_account_id_idx" ON "subscription_contracts"("billing_account_id");
CREATE INDEX "subscription_contracts_product_id_status_idx" ON "subscription_contracts"("product_id", "status");
CREATE INDEX "subscription_contracts_tenant_id_product_id_status_idx" ON "subscription_contracts"("tenant_id", "product_id", "status");
CREATE UNIQUE INDEX "subscription_contracts_active_tenant_product_unique"
  ON "subscription_contracts"("tenant_id", "product_id")
  WHERE "status" = 'ACTIVE';

CREATE UNIQUE INDEX "subscription_periods_user_subscription_id_key" ON "subscription_periods"("user_subscription_id");
CREATE UNIQUE INDEX "subscription_periods_contract_id_sequence_key" ON "subscription_periods"("contract_id", "sequence");
CREATE INDEX "subscription_periods_contract_id_status_idx" ON "subscription_periods"("contract_id", "status");
CREATE INDEX "subscription_periods_user_id_idx" ON "subscription_periods"("user_id");
CREATE INDEX "subscription_periods_tenant_id_idx" ON "subscription_periods"("tenant_id");
CREATE INDEX "subscription_periods_billing_account_id_idx" ON "subscription_periods"("billing_account_id");
CREATE INDEX "subscription_periods_product_id_status_idx" ON "subscription_periods"("product_id", "status");
CREATE INDEX "subscription_periods_tenant_id_product_id_status_idx" ON "subscription_periods"("tenant_id", "product_id", "status");
CREATE INDEX "subscription_periods_plan_id_idx" ON "subscription_periods"("plan_id");
CREATE UNIQUE INDEX "subscription_periods_active_tenant_product_unique"
  ON "subscription_periods"("tenant_id", "product_id")
  WHERE "status" = 'ACTIVE';

CREATE UNIQUE INDEX "subscription_entitlements_period_id_entitlement_type_key"
  ON "subscription_entitlements"("period_id", "entitlement_type");
CREATE INDEX "subscription_entitlements_contract_id_status_idx" ON "subscription_entitlements"("contract_id", "status");
CREATE INDEX "subscription_entitlements_user_id_idx" ON "subscription_entitlements"("user_id");
CREATE INDEX "subscription_entitlements_tenant_id_idx" ON "subscription_entitlements"("tenant_id");
CREATE INDEX "subscription_entitlements_billing_account_id_idx" ON "subscription_entitlements"("billing_account_id");
CREATE INDEX "subscription_entitlements_product_id_status_idx" ON "subscription_entitlements"("product_id", "status");
CREATE INDEX "subscription_entitlements_tenant_id_product_id_status_idx" ON "subscription_entitlements"("tenant_id", "product_id", "status");
CREATE INDEX "subscription_entitlements_plan_id_idx" ON "subscription_entitlements"("plan_id");

ALTER TABLE "subscription_contracts"
  ADD CONSTRAINT "subscription_contracts_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_contracts"
  ADD CONSTRAINT "subscription_contracts_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_contracts"
  ADD CONSTRAINT "subscription_contracts_billing_account_id_fkey"
  FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_contracts"
  ADD CONSTRAINT "subscription_contracts_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "subscription_periods"
  ADD CONSTRAINT "subscription_periods_contract_id_fkey"
  FOREIGN KEY ("contract_id") REFERENCES "subscription_contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "subscription_periods"
  ADD CONSTRAINT "subscription_periods_user_subscription_id_fkey"
  FOREIGN KEY ("user_subscription_id") REFERENCES "user_subscriptions"("id") ON DELETE SET NULL ON UPDATE CASCADE;
ALTER TABLE "subscription_periods"
  ADD CONSTRAINT "subscription_periods_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_periods"
  ADD CONSTRAINT "subscription_periods_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_periods"
  ADD CONSTRAINT "subscription_periods_billing_account_id_fkey"
  FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_periods"
  ADD CONSTRAINT "subscription_periods_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_periods"
  ADD CONSTRAINT "subscription_periods_plan_id_fkey"
  FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "subscription_entitlements"
  ADD CONSTRAINT "subscription_entitlements_contract_id_fkey"
  FOREIGN KEY ("contract_id") REFERENCES "subscription_contracts"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "subscription_entitlements"
  ADD CONSTRAINT "subscription_entitlements_period_id_fkey"
  FOREIGN KEY ("period_id") REFERENCES "subscription_periods"("id") ON DELETE CASCADE ON UPDATE CASCADE;
ALTER TABLE "subscription_entitlements"
  ADD CONSTRAINT "subscription_entitlements_user_id_fkey"
  FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_entitlements"
  ADD CONSTRAINT "subscription_entitlements_tenant_id_fkey"
  FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_entitlements"
  ADD CONSTRAINT "subscription_entitlements_billing_account_id_fkey"
  FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_entitlements"
  ADD CONSTRAINT "subscription_entitlements_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
ALTER TABLE "subscription_entitlements"
  ADD CONSTRAINT "subscription_entitlements_plan_id_fkey"
  FOREIGN KEY ("plan_id") REFERENCES "plans"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
