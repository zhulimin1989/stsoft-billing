CREATE TABLE "coding_plan_provider_entitlements" (
    "id" TEXT NOT NULL,
    "order_id" TEXT NOT NULL,
    "subscription_id" TEXT,
    "user_id" TEXT NOT NULL,
    "tenant_id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "provider" TEXT NOT NULL,
    "activation_profile_id" TEXT NOT NULL,
    "upstream_product_id" TEXT NOT NULL,
    "partner_user_id" TEXT NOT NULL,
    "partner_order_no" TEXT NOT NULL,
    "upstream_order_id" TEXT,
    "upstream_api_key_encrypted" TEXT,
    "upstream_api_key_prefix" TEXT,
    "upstream_secret_key_encrypted" TEXT,
    "upstream_secret_key_prefix" TEXT,
    "product_start_time" TIMESTAMP(3),
    "product_end_time" TIMESTAMP(3),
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "last_error" TEXT,
    "response_snapshot" JSONB,
    "activated_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coding_plan_provider_entitlements_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "coding_plan_provider_entitlements_order_id_key"
    ON "coding_plan_provider_entitlements"("order_id");

CREATE UNIQUE INDEX "coding_plan_provider_entitlements_activation_profile_id_partner_order_no_key"
    ON "coding_plan_provider_entitlements"("activation_profile_id", "partner_order_no");

CREATE INDEX "coding_plan_provider_entitlements_user_id_idx"
    ON "coding_plan_provider_entitlements"("user_id");

CREATE INDEX "coding_plan_provider_entitlements_tenant_id_idx"
    ON "coding_plan_provider_entitlements"("tenant_id");

CREATE INDEX "coding_plan_provider_entitlements_product_id_idx"
    ON "coding_plan_provider_entitlements"("product_id");

CREATE INDEX "coding_plan_provider_entitlements_plan_id_idx"
    ON "coding_plan_provider_entitlements"("plan_id");

CREATE INDEX "coding_plan_provider_entitlements_activation_profile_id_status_idx"
    ON "coding_plan_provider_entitlements"("activation_profile_id", "status");

CREATE INDEX "coding_plan_provider_entitlements_upstream_product_id_idx"
    ON "coding_plan_provider_entitlements"("upstream_product_id");
