-- Partner identities are product-scoped. Historical SaaS provision rows used
-- external ids as global ids, so backfill those exact legacy ids as explicit
-- bindings before the runtime stops accepting unbound global ids.

CREATE TABLE "product_external_user_bindings" (
  "id" TEXT NOT NULL,
  "product_id" TEXT NOT NULL,
  "external_user_id" TEXT NOT NULL,
  "user_id" TEXT NOT NULL,
  "snapshot_writable" BOOLEAN NOT NULL DEFAULT true,
  "email" TEXT,
  "phone" TEXT,
  "nickname" TEXT,
  "source_updated_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "product_external_user_bindings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_external_user_bindings_product_id_external_user_id_key"
  ON "product_external_user_bindings"("product_id", "external_user_id");
CREATE UNIQUE INDEX "product_external_user_bindings_user_id_key"
  ON "product_external_user_bindings"("user_id");

ALTER TABLE "product_external_user_bindings"
  ADD CONSTRAINT "product_external_user_bindings_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "products"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "product_external_user_bindings_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

CREATE TABLE "product_external_tenant_bindings" (
  "id" TEXT NOT NULL,
  "product_id" TEXT NOT NULL,
  "binding_key" TEXT NOT NULL,
  "external_tenant_id" TEXT,
  "tenant_id" TEXT NOT NULL,
  "snapshot_writable" BOOLEAN NOT NULL DEFAULT true,
  "provisioning_lease_id" TEXT,
  "provisioning_lease_expires_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "product_external_tenant_bindings_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "product_external_tenant_bindings_product_id_binding_key_key"
  ON "product_external_tenant_bindings"("product_id", "binding_key");
CREATE UNIQUE INDEX "product_ext_tenant_product_external_id_key"
  ON "product_external_tenant_bindings"("product_id", "external_tenant_id");
CREATE UNIQUE INDEX "product_external_tenant_bindings_product_id_tenant_id_key"
  ON "product_external_tenant_bindings"("product_id", "tenant_id");
CREATE INDEX "product_external_tenant_bindings_tenant_id_idx"
  ON "product_external_tenant_bindings"("tenant_id");
CREATE INDEX "product_ext_tenant_provision_lease_expiry_idx"
  ON "product_external_tenant_bindings"("provisioning_lease_expires_at");

ALTER TABLE "product_external_tenant_bindings"
  ADD CONSTRAINT "product_external_tenant_bindings_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "products"("id")
    ON DELETE CASCADE ON UPDATE CASCADE,
  ADD CONSTRAINT "product_external_tenant_bindings_tenant_id_fkey"
    FOREIGN KEY ("tenant_id") REFERENCES "tenants"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE;

-- A legacy User owns global grant-credit state. Binding that same internal
-- user into more than one Partner product would make one product able to see
-- and consume another product's grants. Stop the migration instead of
-- silently manufacturing a cross-product financial identity. Operators must
-- split/allocate that legacy user before retrying this migration.
DO $$
BEGIN
  IF EXISTS (
    WITH candidate_user_bindings AS (
      -- The canonical tenant owner is the only identity directly evidenced by
      -- the legacy tenant itself.
      SELECT DISTINCT
        entitlement."product_id",
        tenant."owner_user_id" AS "user_id"
      FROM "tenant_product_entitlements" entitlement
      JOIN "tenants" tenant ON tenant."id" = entitlement."tenant_id"
      JOIN "tenant_members" membership
        ON membership."tenant_id" = tenant."id"
        AND membership."user_id" = tenant."owner_user_id"
        AND membership."status" = 'active'
      WHERE entitlement."source" = 'saas_provision'

      UNION

      -- A product-scoped SaaS virtual key is durable evidence that this user
      -- was provisioned for this exact product and tenant.
      SELECT DISTINCT
        entitlement."product_id",
        api_key."user_id"
      FROM "tenant_product_entitlements" entitlement
      JOIN "products" product ON product."id" = entitlement."product_id"
      JOIN "api_keys" api_key
        ON api_key."tenant_id" = entitlement."tenant_id"
        AND api_key."product_id" = entitlement."product_id"
        AND api_key."deleted_at" IS NULL
        AND api_key."name" = 'saas:' || product."slug" || ':virtual'
      JOIN "tenant_members" membership
        ON membership."tenant_id" = entitlement."tenant_id"
        AND membership."user_id" = api_key."user_id"
        AND membership."status" = 'active'
      WHERE entitlement."source" = 'saas_provision'
    )
    SELECT 1
    FROM candidate_user_bindings
    GROUP BY "user_id"
    HAVING COUNT(DISTINCT "product_id") > 1
  ) THEN
    RAISE EXCEPTION USING
      ERRCODE = 'P0001',
      MESSAGE = 'partner identity migration blocked: a legacy internal user is evidenced in multiple products',
      HINT = 'Split or explicitly allocate the user-level grant identity per product, then retry migrate deploy.';
  END IF;
END
$$;

WITH candidate_user_bindings AS (
  SELECT DISTINCT
    entitlement."product_id",
    tenant."owner_user_id" AS "user_id"
  FROM "tenant_product_entitlements" entitlement
  JOIN "tenants" tenant ON tenant."id" = entitlement."tenant_id"
  JOIN "tenant_members" membership
    ON membership."tenant_id" = tenant."id"
    AND membership."user_id" = tenant."owner_user_id"
    AND membership."status" = 'active'
  WHERE entitlement."source" = 'saas_provision'

  UNION

  SELECT DISTINCT
    entitlement."product_id",
    api_key."user_id"
  FROM "tenant_product_entitlements" entitlement
  JOIN "products" product ON product."id" = entitlement."product_id"
  JOIN "api_keys" api_key
    ON api_key."tenant_id" = entitlement."tenant_id"
    AND api_key."product_id" = entitlement."product_id"
    AND api_key."deleted_at" IS NULL
    AND api_key."name" = 'saas:' || product."slug" || ':virtual'
  JOIN "tenant_members" membership
    ON membership."tenant_id" = entitlement."tenant_id"
    AND membership."user_id" = api_key."user_id"
    AND membership."status" = 'active'
  WHERE entitlement."source" = 'saas_provision'
)
INSERT INTO "product_external_user_bindings" (
  "id",
  "product_id",
  "external_user_id",
  "user_id",
  "snapshot_writable",
  "email",
  "phone",
  "nickname",
  "source_updated_at",
  "created_at",
  "updated_at"
)
SELECT
  gen_random_uuid()::TEXT,
  candidate."product_id",
  candidate."user_id",
  candidate."user_id",
  false,
  bound_user."email",
  bound_user."phone",
  bound_user."nickname",
  bound_user."source_updated_at",
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM candidate_user_bindings candidate
JOIN "users" bound_user ON bound_user."id" = candidate."user_id"
ON CONFLICT DO NOTHING;

-- Deliberately do not rewrite legacy tenant_members roles in the migration.
-- That compatibility change is applied lazily by the V2 runtime only after
-- PARTNER_IDENTITY_V2_WRITE_ENABLED is explicitly activated. Until then an
-- operator can still roll the application binary back without inheriting an
-- irreversible membership downgrade.

INSERT INTO "product_external_tenant_bindings" (
  "id",
  "product_id",
  "binding_key",
  "external_tenant_id",
  "tenant_id",
  "snapshot_writable",
  "created_at",
  "updated_at"
)
SELECT DISTINCT ON (entitlement."product_id", entitlement."tenant_id")
  gen_random_uuid()::TEXT,
  entitlement."product_id",
  'legacy:' || entitlement."tenant_id",
  entitlement."tenant_id",
  entitlement."tenant_id",
  false,
  CURRENT_TIMESTAMP,
  CURRENT_TIMESTAMP
FROM "tenant_product_entitlements" entitlement
JOIN "tenants" tenant ON tenant."id" = entitlement."tenant_id"
WHERE entitlement."source" = 'saas_provision'
ORDER BY entitlement."product_id", entitlement."tenant_id", entitlement."created_at" ASC
ON CONFLICT DO NOTHING;

CREATE TABLE "saas_provision_receipts" (
  "id" TEXT NOT NULL,
  "product_id" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "request_fingerprint" TEXT NOT NULL,
  "status" TEXT NOT NULL DEFAULT 'PENDING',
  "result" JSONB,
  "lease_id" TEXT,
  "lease_expires_at" TIMESTAMP(3),
  "last_error" TEXT,
  "completed_at" TIMESTAMP(3),
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,

  CONSTRAINT "saas_provision_receipts_pkey" PRIMARY KEY ("id")
);

CREATE UNIQUE INDEX "saas_provision_receipts_product_id_idempotency_key_key"
  ON "saas_provision_receipts"("product_id", "idempotency_key");
CREATE INDEX "saas_provision_receipts_status_lease_expires_at_idx"
  ON "saas_provision_receipts"("status", "lease_expires_at");

ALTER TABLE "saas_provision_receipts"
  ADD CONSTRAINT "saas_provision_receipts_product_id_fkey"
    FOREIGN KEY ("product_id") REFERENCES "products"("id")
    ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "subscription_periods"
  ADD COLUMN "provision_receipt_id" TEXT;

CREATE UNIQUE INDEX "subscription_periods_provision_receipt_id_key"
  ON "subscription_periods"("provision_receipt_id");

ALTER TABLE "subscription_periods"
  ADD CONSTRAINT "subscription_periods_provision_receipt_id_fkey"
    FOREIGN KEY ("provision_receipt_id") REFERENCES "saas_provision_receipts"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "coding_plan_entitlements"
  ADD COLUMN "provision_receipt_id" TEXT;

CREATE UNIQUE INDEX "coding_plan_entitlements_provision_receipt_id_key"
  ON "coding_plan_entitlements"("provision_receipt_id");

ALTER TABLE "coding_plan_entitlements"
  ADD CONSTRAINT "coding_plan_entitlements_provision_receipt_id_fkey"
    FOREIGN KEY ("provision_receipt_id") REFERENCES "saas_provision_receipts"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Managed provision keys keep an encrypted, short-lived recovery copy so a
-- lost HTTP response can be retried without generating another credential.
-- rotation_predecessor_id is the durable hand-off marker: the predecessor is
-- not soft-deleted until Publisher has acknowledged its revocation.
ALTER TABLE "api_keys"
  ADD COLUMN "managed_by" TEXT,
  ADD COLUMN "provision_secret_encrypted" TEXT,
  ADD COLUMN "provision_secret_expires_at" TIMESTAMP(3),
  ADD COLUMN "rotation_predecessor_id" TEXT;

UPDATE "api_keys"
SET "managed_by" = 'saas_provision'
WHERE "product_id" IS NOT NULL
  AND "name" LIKE 'saas:%:virtual'
  AND "is_active" = false
  AND "deleted_at" IS NULL;

WITH ranked_active AS (
  SELECT
    "id",
    ROW_NUMBER() OVER (
      PARTITION BY "user_id", "tenant_id", "product_id", "name"
      ORDER BY "activated_at" DESC NULLS LAST, "created_at" DESC, "id" DESC
    ) AS active_rank
  FROM "api_keys"
  WHERE "product_id" IS NOT NULL
    AND "name" LIKE 'saas:%:virtual'
    AND "is_active" = true
    AND "deleted_at" IS NULL
)
UPDATE "api_keys" key
SET "managed_by" = 'saas_provision'
FROM ranked_active ranked
WHERE key."id" = ranked."id"
  AND ranked.active_rank = 1;

CREATE UNIQUE INDEX "api_keys_rotation_predecessor_id_key"
  ON "api_keys"("rotation_predecessor_id");
CREATE INDEX "api_keys_managed_by_user_id_tenant_id_product_id_idx"
  ON "api_keys"("managed_by", "user_id", "tenant_id", "product_id");

ALTER TABLE "api_keys"
  ADD CONSTRAINT "api_keys_rotation_predecessor_id_fkey"
    FOREIGN KEY ("rotation_predecessor_id") REFERENCES "api_keys"("id")
    ON DELETE SET NULL ON UPDATE CASCADE;

-- Only Partner-managed keys are constrained by this name-level invariant.
-- Other API-key producers retain their existing naming semantics.
CREATE UNIQUE INDEX "api_keys_saas_provision_one_active_name_key"
  ON "api_keys"("user_id", "tenant_id", "product_id", "name")
  WHERE "managed_by" = 'saas_provision'
    AND "is_active" = true
    AND "deleted_at" IS NULL;
