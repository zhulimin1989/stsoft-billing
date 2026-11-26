CREATE TABLE IF NOT EXISTS "product_model_availabilities" (
  "id" TEXT NOT NULL,
  "product_id" TEXT NOT NULL,
  "model_name" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'ACTIVE',
  "api_enabled" BOOLEAN NOT NULL DEFAULT true,
  "visible" BOOLEAN NOT NULL DEFAULT true,
  "starts_at" TIMESTAMP(3),
  "ends_at" TIMESTAMP(3),
  "display_order" INTEGER NOT NULL DEFAULT 0,
  "reason" TEXT NOT NULL DEFAULT '',
  "metadata" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,

  CONSTRAINT "product_model_availabilities_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX IF NOT EXISTS "product_model_availabilities_product_id_model_name_key"
  ON "product_model_availabilities"("product_id", "model_name");

CREATE INDEX IF NOT EXISTS "product_model_availability_product_status_api_idx"
  ON "product_model_availabilities"("product_id", "status", "api_enabled");

CREATE INDEX IF NOT EXISTS "product_model_availability_model_status_idx"
  ON "product_model_availabilities"("model_name", "status");

CREATE INDEX IF NOT EXISTS "product_model_availability_visible_status_idx"
  ON "product_model_availabilities"("visible", "status");

DO $$
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'product_model_availabilities_product_id_fkey'
  ) THEN
    ALTER TABLE "product_model_availabilities"
      ADD CONSTRAINT "product_model_availabilities_product_id_fkey"
        FOREIGN KEY ("product_id") REFERENCES "products"("id") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_constraint
    WHERE conname = 'product_model_availabilities_model_name_fkey'
  ) THEN
    ALTER TABLE "product_model_availabilities"
      ADD CONSTRAINT "product_model_availabilities_model_name_fkey"
        FOREIGN KEY ("model_name") REFERENCES "model_pricing"("model_name") ON DELETE CASCADE ON UPDATE CASCADE;
  END IF;
END $$;

INSERT INTO "product_model_availabilities" (
  "id",
  "product_id",
  "model_name",
  "status",
  "api_enabled",
  "visible",
  "display_order",
  "reason",
  "created_at",
  "updated_at"
)
SELECT
  'pma_' || substr(md5(p."id" || ':' || mp."model_name"), 1, 28),
  p."id",
  mp."model_name",
  'ACTIVE',
  true,
  mp."is_published",
  mp."display_order",
  'initialized_from_existing_payg_pricing',
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "products" p
CROSS JOIN "model_pricing" mp
WHERE p."billing_mode" = 'PAY_AS_YOU_GO'
  AND p."deleted_at" IS NULL
  AND mp."is_active" = true
ON CONFLICT ("product_id", "model_name") DO NOTHING;
