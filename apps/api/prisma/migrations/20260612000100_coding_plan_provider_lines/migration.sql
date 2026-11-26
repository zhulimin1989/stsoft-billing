-- Provider-line based CodingPlan resale routing.

CREATE TABLE "coding_plan_provider_lines" (
    "id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "provider_code" TEXT NOT NULL,
    "provider_name" TEXT,
    "adapter_type" TEXT NOT NULL,
    "environment" TEXT NOT NULL DEFAULT 'production',
    "api_base_url" TEXT NOT NULL,
    "auth_type" TEXT NOT NULL DEFAULT 'partner_md5_header',
    "partner_code_encrypted" TEXT,
    "partner_code_prefix" TEXT,
    "partner_secret_encrypted" TEXT,
    "partner_secret_prefix" TEXT,
    "sales_enabled" BOOLEAN NOT NULL DEFAULT false,
    "fulfillment_enabled" BOOLEAN NOT NULL DEFAULT false,
    "runtime_enabled" BOOLEAN NOT NULL DEFAULT false,
    "sync_enabled" BOOLEAN NOT NULL DEFAULT false,
    "capabilities" JSONB,
    "qps_config" JSONB,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coding_plan_provider_lines_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "coding_plan_provider_products" (
    "id" TEXT NOT NULL,
    "provider_line_id" TEXT NOT NULL,
    "upstream_product_id" TEXT NOT NULL,
    "product_name" TEXT NOT NULL,
    "sale_price" DECIMAL(20,6),
    "currency" TEXT DEFAULT 'CNY',
    "product_cycle" TEXT,
    "product_type" TEXT,
    "product_big_title" TEXT,
    "product_small_title" TEXT,
    "description" TEXT,
    "product_introduction" TEXT,
    "sales_volume" INTEGER,
    "daily_sales_limit" INTEGER,
    "monthly_sales_limit" INTEGER,
    "yearly_sales_limit" INTEGER,
    "max_sales_limit" INTEGER,
    "status" TEXT NOT NULL DEFAULT 'ACTIVE',
    "raw_snapshot" JSONB,
    "last_synced_at" TIMESTAMP(3),
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coding_plan_provider_products_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "coding_plan_resale_routes" (
    "id" TEXT NOT NULL,
    "plan_id" TEXT NOT NULL,
    "provider_line_id" TEXT NOT NULL,
    "upstream_product_id" TEXT NOT NULL,
    "fulfillment_method" TEXT NOT NULL DEFAULT 'create_order',
    "enabled" BOOLEAN NOT NULL DEFAULT true,
    "priority" INTEGER NOT NULL DEFAULT 100,
    "market" TEXT,
    "currency" TEXT,
    "sales_channel" TEXT,
    "user_segment_id" TEXT,
    "start_at" TIMESTAMP(3),
    "end_at" TIMESTAMP(3),
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "coding_plan_resale_routes_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "coding_plan_provider_entitlements"
    ADD COLUMN "provider_line_id" TEXT,
    ADD COLUMN "provider_line_code" TEXT,
    ADD COLUMN "provider_code" TEXT,
    ADD COLUMN "adapter_type" TEXT,
    ADD COLUMN "credential_format" TEXT;

ALTER TABLE "coding_plan_entitlements"
    ADD COLUMN "provider_line_id" TEXT,
    ADD COLUMN "provider_line_code" TEXT,
    ADD COLUMN "provider_code" TEXT,
    ADD COLUMN "adapter_type" TEXT,
    ADD COLUMN "upstream_product_id" TEXT;

ALTER TABLE "token_usage"
    ADD COLUMN "provider_line_id" TEXT,
    ADD COLUMN "provider_line_code" TEXT,
    ADD COLUMN "provider_code" TEXT,
    ADD COLUMN "upstream_product_id" TEXT;

CREATE UNIQUE INDEX "coding_plan_provider_lines_code_key"
    ON "coding_plan_provider_lines"("code");

CREATE INDEX "coding_plan_provider_lines_provider_code_idx"
    ON "coding_plan_provider_lines"("provider_code");

CREATE INDEX "coding_plan_provider_lines_adapter_type_idx"
    ON "coding_plan_provider_lines"("adapter_type");

CREATE INDEX "coding_plan_provider_lines_switches_idx"
    ON "coding_plan_provider_lines"("sales_enabled", "fulfillment_enabled", "runtime_enabled");

CREATE UNIQUE INDEX "coding_plan_provider_products_line_product_key"
    ON "coding_plan_provider_products"("provider_line_id", "upstream_product_id");

CREATE INDEX "coding_plan_provider_products_line_status_idx"
    ON "coding_plan_provider_products"("provider_line_id", "status");

CREATE INDEX "coding_plan_resale_routes_plan_enabled_priority_idx"
    ON "coding_plan_resale_routes"("plan_id", "enabled", "priority");

CREATE INDEX "coding_plan_resale_routes_provider_line_id_idx"
    ON "coding_plan_resale_routes"("provider_line_id");

CREATE INDEX "coding_plan_provider_entitlements_line_status_idx"
    ON "coding_plan_provider_entitlements"("provider_line_id", "status");

CREATE INDEX "coding_plan_provider_entitlements_line_code_idx"
    ON "coding_plan_provider_entitlements"("provider_line_code");

CREATE INDEX "coding_plan_entitlements_provider_line_id_idx"
    ON "coding_plan_entitlements"("provider_line_id");

CREATE INDEX "coding_plan_entitlements_provider_line_code_idx"
    ON "coding_plan_entitlements"("provider_line_code");

CREATE INDEX "token_usage_provider_line_id_idx"
    ON "token_usage"("provider_line_id");

CREATE INDEX "token_usage_provider_line_code_idx"
    ON "token_usage"("provider_line_code");

ALTER TABLE "coding_plan_provider_products"
    ADD CONSTRAINT "coding_plan_provider_products_line_fkey"
    FOREIGN KEY ("provider_line_id")
    REFERENCES "coding_plan_provider_lines"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;

ALTER TABLE "coding_plan_resale_routes"
    ADD CONSTRAINT "coding_plan_resale_routes_plan_id_fkey"
    FOREIGN KEY ("plan_id")
    REFERENCES "plans"("id")
    ON DELETE CASCADE
    ON UPDATE CASCADE;

ALTER TABLE "coding_plan_resale_routes"
    ADD CONSTRAINT "coding_plan_resale_routes_line_id_fkey"
    FOREIGN KEY ("provider_line_id")
    REFERENCES "coding_plan_provider_lines"("id")
    ON DELETE RESTRICT
    ON UPDATE CASCADE;

ALTER TABLE "coding_plan_provider_entitlements"
    ADD CONSTRAINT "coding_plan_provider_entitlements_line_id_fkey"
    FOREIGN KEY ("provider_line_id")
    REFERENCES "coding_plan_provider_lines"("id")
    ON DELETE SET NULL
    ON UPDATE CASCADE;

ALTER TABLE "coding_plan_entitlements"
    ADD CONSTRAINT "coding_plan_entitlements_line_id_fkey"
    FOREIGN KEY ("provider_line_id")
    REFERENCES "coding_plan_provider_lines"("id")
    ON DELETE SET NULL
    ON UPDATE CASCADE;

INSERT INTO "coding_plan_provider_lines" (
    "id",
    "code",
    "name",
    "provider_code",
    "provider_name",
    "adapter_type",
    "environment",
    "api_base_url",
    "auth_type",
    "sales_enabled",
    "fulfillment_enabled",
    "runtime_enabled",
    "sync_enabled",
    "qps_config",
    "capabilities",
    "updated_at"
)
VALUES
    (
        'line_zhipu_overseas',
        'zhipu_overseas',
        'Zhipu Overseas',
        'zhipu',
        'Zhipu',
        'zhipu_partner',
        'production',
        'https://api.z.ai',
        'partner_md5_header',
        false,
        false,
        false,
        false,
        '{"createOrder": 50}'::jsonb,
        '{"listProducts": true, "createOrder": true}'::jsonb,
        CURRENT_TIMESTAMP
    ),
    (
        'line_zhipu_cn',
        'zhipu_cn',
        'Zhipu CN',
        'zhipu',
        'Zhipu',
        'zhipu_partner',
        'production',
        'https://bigmodel.cn',
        'partner_md5_header',
        false,
        false,
        false,
        false,
        '{"createOrder": 100}'::jsonb,
        '{"listProducts": true, "createOrder": true}'::jsonb,
        CURRENT_TIMESTAMP
    )
ON CONFLICT ("code") DO NOTHING;

UPDATE "coding_plan_provider_entitlements"
SET
    "provider_line_id" = 'line_zhipu_overseas',
    "provider_line_code" = 'zhipu_overseas',
    "provider_code" = 'zhipu',
    "adapter_type" = 'zhipu_partner',
    "credential_format" = COALESCE("credential_format", 'apiKey.secretKey')
WHERE "activation_profile_id" = 'zhipu_overseas'
  AND "provider_line_id" IS NULL;

UPDATE "coding_plan_provider_entitlements"
SET
    "provider_line_id" = 'line_zhipu_cn',
    "provider_line_code" = 'zhipu_cn',
    "provider_code" = 'zhipu',
    "adapter_type" = 'zhipu_partner',
    "credential_format" = COALESCE("credential_format", 'apiKey.secretKey')
WHERE "activation_profile_id" = 'zhipu_cn'
  AND "provider_line_id" IS NULL;

UPDATE "coding_plan_entitlements" c
SET
    "provider_line_id" = p."provider_line_id",
    "provider_line_code" = p."provider_line_code",
    "provider_code" = p."provider_code",
    "adapter_type" = p."adapter_type",
    "upstream_product_id" = p."upstream_product_id"
FROM "coding_plan_provider_entitlements" p
WHERE c."provider_entitlement_id" = p."id"
  AND c."provider_line_id" IS NULL;

UPDATE "token_usage" t
SET
    "provider_line_id" = p."provider_line_id",
    "provider_line_code" = p."provider_line_code",
    "provider_code" = p."provider_code",
    "upstream_product_id" = p."upstream_product_id"
FROM "coding_plan_provider_entitlements" p
WHERE t."provider_entitlement_id" = p."id"
  AND t."provider_line_id" IS NULL;
