-- Product-aware runtime routing policy.
-- Stored in billing, published to tokenplatform-publisher, consumed by gateway in a later rollout.
CREATE TABLE "product_runtime_policies" (
  "id" TEXT NOT NULL,
  "product_id" TEXT NOT NULL,
  "credential_source" TEXT NOT NULL DEFAULT 'platform_pool',
  "allowed_provider_ids" JSONB,
  "allowed_channel_ids" JSONB,
  "allowed_provider_profiles" JSONB,
  "model_scope_mode" TEXT NOT NULL DEFAULT 'plan_configured',
  "allowed_models" JSONB,
  "fallback_policy" TEXT NOT NULL DEFAULT 'within_product',
  "runtime_billing_mode" TEXT NOT NULL DEFAULT 'subscription_credits',
  "route_strategy" TEXT,
  "status" TEXT NOT NULL DEFAULT 'active',
  "revision" INTEGER NOT NULL DEFAULT 1,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "product_runtime_policies_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_runtime_policies_product_id_key" ON "product_runtime_policies"("product_id");
CREATE INDEX "product_runtime_policies_status_idx" ON "product_runtime_policies"("status");

ALTER TABLE "product_runtime_policies"
  ADD CONSTRAINT "product_runtime_policies_product_id_fkey"
  FOREIGN KEY ("product_id") REFERENCES "products"("id")
  ON DELETE CASCADE ON UPDATE CASCADE;
