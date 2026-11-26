-- Finalize AccountWallet as the only authoritative wallet.
-- Existing user_wallets / tenant_wallets values are copied only for accounts
-- that do not already have an account_wallet row.

INSERT INTO "billing_accounts" (
  "id",
  "type",
  "name",
  "owner_user_id",
  "status",
  "currency",
  "created_at",
  "updated_at"
)
SELECT
  'ba_personal_' || u."id",
  'personal',
  COALESCE(NULLIF(u."nickname", ''), u."email", 'Personal account'),
  u."id",
  CASE WHEN u."is_active" THEN 'active' ELSE 'suspended' END,
  'USD',
  u."created_at",
  CURRENT_TIMESTAMP
FROM "users" u
ON CONFLICT ("id") DO NOTHING;

INSERT INTO "billing_account_members" (
  "id",
  "billing_account_id",
  "user_id",
  "role",
  "status",
  "joined_at",
  "created_at",
  "updated_at"
)
SELECT
  'bam_personal_' || u."id",
  'ba_personal_' || u."id",
  u."id",
  'owner',
  CASE WHEN u."is_active" THEN 'active' ELSE 'inactive' END,
  u."created_at",
  u."created_at",
  CURRENT_TIMESTAMP
FROM "users" u
ON CONFLICT ("billing_account_id", "user_id") DO NOTHING;

UPDATE "tenants" t
SET "billing_account_id" = 'ba_personal_' || t."owner_user_id"
WHERE t."billing_account_id" IS NULL
  AND t."owner_user_id" IS NOT NULL;

WITH account_balances AS (
  SELECT
    ba."id" AS "billing_account_id",
    CASE
      WHEN COUNT(tw."tenant_id") > 0
        THEN COALESCE(SUM(tw."balance_usd"), 0)
      ELSE COALESCE(MAX(uw."balance_usd"), 0)
    END AS "balance_usd",
    MIN(COALESCE(tw."created_at", uw."created_at", ba."created_at")) AS "created_at"
  FROM "billing_accounts" ba
  LEFT JOIN "tenants" t ON t."billing_account_id" = ba."id"
  LEFT JOIN "tenant_wallets" tw ON tw."tenant_id" = t."id"
  LEFT JOIN "user_wallets" uw ON uw."user_id" = ba."owner_user_id"
  GROUP BY ba."id"
)
INSERT INTO "account_wallets" (
  "billing_account_id",
  "balance_usd",
  "created_at",
  "updated_at"
)
SELECT
  ab."billing_account_id",
  ab."balance_usd",
  COALESCE(ab."created_at", CURRENT_TIMESTAMP),
  CURRENT_TIMESTAMP
FROM account_balances ab
ON CONFLICT ("billing_account_id") DO NOTHING;

DROP TABLE IF EXISTS "tenant_wallets";
DROP TABLE IF EXISTS "user_wallets";
