-- Drop the legacy unique index on payg_model_pricing_policies(product_id, model_name).
-- It was created by the init migration as a UNIQUE INDEX (Prisma @@unique), so it lives in
-- pg_indexes, not pg_constraint. The 20260622000100 temporal-PAYG migration meant to remove it
-- but used `DROP CONSTRAINT IF EXISTS` — a no-op against an index — so it survived in every DB.
-- The temporal/versioned model keeps multiple rows per (product_id, model_name) differentiated by
-- starts_at/ends_at, so this index makes createPaygModelPricingVersion fail with a unique violation.
DROP INDEX IF EXISTS "payg_model_pricing_policies_product_id_model_name_key";
