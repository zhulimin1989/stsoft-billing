-- Product-scoped channel routing. This is additive and keeps the existing
-- product_runtime_policies.allowed_channel_ids fallback intact.

CREATE TABLE "product_channels" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "channel_id" TEXT NOT NULL,
    "display_name" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "allowed_models" JSONB,
    "denied_models" JSONB,
    "priority" INTEGER NOT NULL DEFAULT 5,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "max_rpm" INTEGER,
    "max_tpm" INTEGER,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "product_channels_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "product_channel_groups" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "code" TEXT NOT NULL,
    "name" TEXT NOT NULL,
    "description" TEXT,
    "strategy" TEXT NOT NULL DEFAULT 'weighted_failover',
    "is_default" BOOLEAN NOT NULL DEFAULT false,
    "status" TEXT NOT NULL DEFAULT 'active',
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "product_channel_groups_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "product_channel_group_members" (
    "id" TEXT NOT NULL,
    "group_id" TEXT NOT NULL,
    "product_channel_id" TEXT NOT NULL,
    "priority" INTEGER NOT NULL DEFAULT 5,
    "weight" INTEGER NOT NULL DEFAULT 1,
    "role" TEXT NOT NULL DEFAULT 'primary',
    "max_rpm" INTEGER,
    "max_tpm" INTEGER,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "product_channel_group_members_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "route_assignments" (
    "id" TEXT NOT NULL,
    "product_id" TEXT NOT NULL,
    "subject_type" TEXT NOT NULL,
    "subject_id" TEXT NOT NULL,
    "model_pattern" TEXT,
    "client_compatibility" TEXT,
    "target_type" TEXT NOT NULL,
    "target_id" TEXT NOT NULL,
    "mode" TEXT NOT NULL DEFAULT 'ONLY',
    "priority" INTEGER NOT NULL DEFAULT 100,
    "starts_at" TIMESTAMP(3),
    "ends_at" TIMESTAMP(3),
    "is_active" BOOLEAN NOT NULL DEFAULT true,
    "reason" TEXT,
    "metadata" JSONB,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "route_assignments_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_channels_product_id_channel_id_active_key"
ON "product_channels"("product_id", "channel_id")
WHERE "deleted_at" IS NULL;

CREATE INDEX "product_channels_product_id_status_idx"
ON "product_channels"("product_id", "status");

CREATE INDEX "product_channels_channel_id_idx"
ON "product_channels"("channel_id");

CREATE UNIQUE INDEX "product_channel_groups_product_id_code_active_key"
ON "product_channel_groups"("product_id", "code")
WHERE "deleted_at" IS NULL;

CREATE INDEX "product_channel_groups_product_id_status_idx"
ON "product_channel_groups"("product_id", "status");

CREATE UNIQUE INDEX "product_channel_groups_one_default_per_product"
ON "product_channel_groups"("product_id")
WHERE "is_default" = true AND "deleted_at" IS NULL;

CREATE UNIQUE INDEX "product_channel_group_members_group_id_product_channel_id_key"
ON "product_channel_group_members"("group_id", "product_channel_id");

CREATE INDEX "product_channel_group_members_product_channel_id_idx"
ON "product_channel_group_members"("product_channel_id");

CREATE INDEX "route_assignments_product_id_subject_type_subject_id_idx"
ON "route_assignments"("product_id", "subject_type", "subject_id");

CREATE INDEX "route_assignments_product_id_target_type_target_id_idx"
ON "route_assignments"("product_id", "target_type", "target_id");

CREATE INDEX "route_assignments_product_id_is_active_idx"
ON "route_assignments"("product_id", "is_active");

CREATE INDEX "route_assignments_is_active_starts_at_ends_at_idx"
ON "route_assignments"("is_active", "starts_at", "ends_at");

ALTER TABLE "product_channels"
ADD CONSTRAINT "product_channels_product_id_fkey"
FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "product_channels"
ADD CONSTRAINT "product_channels_channel_id_fkey"
FOREIGN KEY ("channel_id") REFERENCES "channels"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "product_channel_groups"
ADD CONSTRAINT "product_channel_groups_product_id_fkey"
FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "product_channel_group_members"
ADD CONSTRAINT "product_channel_group_members_group_id_fkey"
FOREIGN KEY ("group_id") REFERENCES "product_channel_groups"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "product_channel_group_members"
ADD CONSTRAINT "product_channel_group_members_product_channel_id_fkey"
FOREIGN KEY ("product_channel_id") REFERENCES "product_channels"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "route_assignments"
ADD CONSTRAINT "route_assignments_product_id_fkey"
FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;

-- Backfill existing product runtime policy channel allowlists into the new
-- product-scoped routing model. IDs are deterministic text values so this
-- migration does not depend on a database UUID extension.
WITH allowed_channels AS (
    SELECT
        prp."product_id",
        elem."channel_id",
        MIN(elem."ordinality") AS "sort_order"
    FROM "product_runtime_policies" prp
    JOIN "products" p
      ON p."id" = prp."product_id"
     AND p."deleted_at" IS NULL
    CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE
            WHEN jsonb_typeof(prp."allowed_channel_ids") = 'array' THEN prp."allowed_channel_ids"
            ELSE '[]'::jsonb
        END
    ) WITH ORDINALITY AS elem("channel_id", "ordinality")
    JOIN "channels" ch
      ON ch."id" = elem."channel_id"
     AND ch."deleted_at" IS NULL
    WHERE elem."channel_id" <> ''
    GROUP BY prp."product_id", elem."channel_id"
)
INSERT INTO "product_channel_groups" (
    "id",
    "product_id",
    "code",
    "name",
    "strategy",
    "is_default",
    "status",
    "created_at",
    "updated_at"
)
SELECT
    'pcg_' || md5("product_id" || ':default'),
    "product_id",
    'default',
    '默认渠道组',
    'weighted_failover',
    true,
    'active',
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM (SELECT DISTINCT "product_id" FROM allowed_channels) distinct_products
ON CONFLICT DO NOTHING;

WITH allowed_channels AS (
    SELECT
        prp."product_id",
        elem."channel_id",
        MIN(elem."ordinality") AS "sort_order"
    FROM "product_runtime_policies" prp
    JOIN "products" p
      ON p."id" = prp."product_id"
     AND p."deleted_at" IS NULL
    CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE
            WHEN jsonb_typeof(prp."allowed_channel_ids") = 'array' THEN prp."allowed_channel_ids"
            ELSE '[]'::jsonb
        END
    ) WITH ORDINALITY AS elem("channel_id", "ordinality")
    JOIN "channels" ch
      ON ch."id" = elem."channel_id"
     AND ch."deleted_at" IS NULL
    WHERE elem."channel_id" <> ''
    GROUP BY prp."product_id", elem."channel_id"
),
ranked_channels AS (
    SELECT
        "product_id",
        "channel_id",
        ROW_NUMBER() OVER (
            PARTITION BY "product_id"
            ORDER BY "sort_order" ASC, "channel_id" ASC
        ) AS "rank"
    FROM allowed_channels
)
INSERT INTO "product_channels" (
    "id",
    "product_id",
    "channel_id",
    "display_name",
    "status",
    "is_default",
    "priority",
    "weight",
    "max_rpm",
    "max_tpm",
    "created_at",
    "updated_at"
)
SELECT
    'pc_' || md5(ranked_channels."product_id" || ':' || ranked_channels."channel_id"),
    ranked_channels."product_id",
    ranked_channels."channel_id",
    ch."name",
    CASE WHEN ch."is_active" = true AND ch."status" = 'active' THEN 'active' ELSE 'disabled' END,
    ranked_channels."rank" = 1,
    ch."priority",
    ch."weight",
    ch."max_rpm",
    ch."max_tpm",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM ranked_channels
JOIN "channels" ch
  ON ch."id" = ranked_channels."channel_id"
ON CONFLICT DO NOTHING;

WITH allowed_channels AS (
    SELECT
        prp."product_id",
        elem."channel_id",
        MIN(elem."ordinality") AS "sort_order"
    FROM "product_runtime_policies" prp
    JOIN "products" p
      ON p."id" = prp."product_id"
     AND p."deleted_at" IS NULL
    CROSS JOIN LATERAL jsonb_array_elements_text(
        CASE
            WHEN jsonb_typeof(prp."allowed_channel_ids") = 'array' THEN prp."allowed_channel_ids"
            ELSE '[]'::jsonb
        END
    ) WITH ORDINALITY AS elem("channel_id", "ordinality")
    JOIN "channels" ch
      ON ch."id" = elem."channel_id"
     AND ch."deleted_at" IS NULL
    WHERE elem."channel_id" <> ''
    GROUP BY prp."product_id", elem."channel_id"
)
INSERT INTO "product_channel_group_members" (
    "id",
    "group_id",
    "product_channel_id",
    "priority",
    "weight",
    "role",
    "max_rpm",
    "max_tpm",
    "created_at",
    "updated_at"
)
SELECT
    'pcgm_' || md5(allowed_channels."product_id" || ':default:' || allowed_channels."channel_id"),
    'pcg_' || md5(allowed_channels."product_id" || ':default'),
    'pc_' || md5(allowed_channels."product_id" || ':' || allowed_channels."channel_id"),
    ch."priority",
    ch."weight",
    'primary',
    ch."max_rpm",
    ch."max_tpm",
    CURRENT_TIMESTAMP,
    CURRENT_TIMESTAMP
FROM allowed_channels
JOIN "channels" ch
  ON ch."id" = allowed_channels."channel_id"
ON CONFLICT DO NOTHING;
