-- TokenPlan/CodingPlan entitlements are account-scoped by tenant_id.
-- Backfill any transient user-scope rows from the user's personal tenant,
-- then restore NOT NULL so runtime keys always carry an account owner.

UPDATE "api_keys" ak
SET "tenant_id" = COALESCE(personal_tenant."id", u."current_tenant_id")
FROM "users" u
LEFT JOIN LATERAL (
  SELECT t."id"
  FROM "tenants" t
  WHERE t."owner_user_id" = u."id"
    AND t."type" = 'personal'
    AND t."status" = 'active'
    AND t."deleted_at" IS NULL
  ORDER BY t."created_at" ASC
  LIMIT 1
) personal_tenant ON TRUE
WHERE ak."tenant_id" IS NULL
  AND ak."user_id" = u."id"
  AND COALESCE(personal_tenant."id", u."current_tenant_id") IS NOT NULL;

UPDATE "coding_plan_entitlements" cpe
SET "tenant_id" = COALESCE(personal_tenant."id", u."current_tenant_id")
FROM "users" u
LEFT JOIN LATERAL (
  SELECT t."id"
  FROM "tenants" t
  WHERE t."owner_user_id" = u."id"
    AND t."type" = 'personal'
    AND t."status" = 'active'
    AND t."deleted_at" IS NULL
  ORDER BY t."created_at" ASC
  LIMIT 1
) personal_tenant ON TRUE
WHERE cpe."tenant_id" IS NULL
  AND cpe."user_id" = u."id"
  AND COALESCE(personal_tenant."id", u."current_tenant_id") IS NOT NULL;

UPDATE "coding_plan_provider_entitlements" cpe
SET "tenant_id" = entitlement."tenant_id"
FROM "coding_plan_entitlements" entitlement
WHERE cpe."tenant_id" IS NULL
  AND cpe."order_id" = entitlement."order_id";

UPDATE "coding_plan_provider_entitlements" cpe
SET "tenant_id" = COALESCE(personal_tenant."id", u."current_tenant_id")
FROM "users" u
LEFT JOIN LATERAL (
  SELECT t."id"
  FROM "tenants" t
  WHERE t."owner_user_id" = u."id"
    AND t."type" = 'personal'
    AND t."status" = 'active'
    AND t."deleted_at" IS NULL
  ORDER BY t."created_at" ASC
  LIMIT 1
) personal_tenant ON TRUE
WHERE cpe."tenant_id" IS NULL
  AND cpe."user_id" = u."id"
  AND COALESCE(personal_tenant."id", u."current_tenant_id") IS NOT NULL;

ALTER TABLE "api_keys" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "coding_plan_entitlements" ALTER COLUMN "tenant_id" SET NOT NULL;
ALTER TABLE "coding_plan_provider_entitlements" ALTER COLUMN "tenant_id" SET NOT NULL;

CREATE INDEX IF NOT EXISTS "coding_plan_entitlements_user_id_product_id_idx"
  ON "coding_plan_entitlements"("user_id", "product_id");

CREATE INDEX IF NOT EXISTS "api_keys_user_id_product_id_idx"
  ON "api_keys"("user_id", "product_id");
