CREATE TABLE "coding_plan_entitlements" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "provider_entitlement_id" TEXT,
    "fulfillment_mode" TEXT NOT NULL DEFAULT 'platform_model_package',
    "billing_period" TEXT NOT NULL DEFAULT 'monthly',
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "started_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "expires_at" TIMESTAMP(3),
    "last_error" TEXT,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coding_plan_entitlements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "coding_plan_entitlements_order_id_key"
    ON "coding_plan_entitlements"("order_id");

CREATE UNIQUE INDEX "coding_plan_entitlements_provider_entitlement_id_key"
    ON "coding_plan_entitlements"("provider_entitlement_id");

CREATE INDEX "coding_plan_entitlements_user_id_idx"
    ON "coding_plan_entitlements"("user_id");

CREATE INDEX "coding_plan_entitlements_tenant_id_idx"
    ON "coding_plan_entitlements"("tenant_id");

CREATE INDEX "coding_plan_entitlements_tenant_id_product_id_idx"
    ON "coding_plan_entitlements"("tenant_id", "product_id");

CREATE INDEX "coding_plan_entitlements_product_id_idx"
    ON "coding_plan_entitlements"("product_id");

CREATE INDEX "coding_plan_entitlements_plan_id_idx"
    ON "coding_plan_entitlements"("plan_id");

CREATE INDEX "coding_plan_entitlements_status_idx"
    ON "coding_plan_entitlements"("status");

ALTER TABLE "api_keys"
    ADD COLUMN "coding_plan_entitlement_id" TEXT;

CREATE INDEX "api_keys_coding_plan_entitlement_id_idx"
    ON "api_keys"("coding_plan_entitlement_id");
