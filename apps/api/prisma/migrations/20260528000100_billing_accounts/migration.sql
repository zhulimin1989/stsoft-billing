-- Introduce BillingAccount as the billing subject.
-- The product still exposes personal accounts only; enterprise accounts can be
-- added later without changing recharge, deduction, and audit ownership.

CREATE TABLE "billing_accounts" (
    "id" TEXT NOT NULL,
    "type" TEXT NOT NULL DEFAULT 'personal',
    "name" TEXT NOT NULL,
    "owner_user_id" TEXT,
    "status" TEXT NOT NULL DEFAULT 'active',
    "currency" TEXT NOT NULL DEFAULT 'USD',
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,
    "deleted_at" TIMESTAMP(3),

    CONSTRAINT "billing_accounts_pkey" PRIMARY KEY ("id")
);

CREATE TABLE "account_wallets" (
    "billing_account_id" TEXT NOT NULL,
    "balance_usd" DECIMAL(20,12) NOT NULL DEFAULT 0,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "account_wallets_pkey" PRIMARY KEY ("billing_account_id")
);

CREATE TABLE "billing_account_members" (
    "id" TEXT NOT NULL,
    "billing_account_id" TEXT NOT NULL,
    "user_id" TEXT NOT NULL,
    "role" TEXT NOT NULL DEFAULT 'owner',
    "status" TEXT NOT NULL DEFAULT 'active',
    "joined_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
    "updated_at" TIMESTAMP(3) NOT NULL,

    CONSTRAINT "billing_account_members_pkey" PRIMARY KEY ("id")
);

ALTER TABLE "tenants" ADD COLUMN "billing_account_id" TEXT;
ALTER TABLE "tenants" ADD COLUMN "balance_allowance_usd" DECIMAL(20,12);
ALTER TABLE "tenants" ADD COLUMN "balance_allowance_used_usd" DECIMAL(20,12) NOT NULL DEFAULT 0;
ALTER TABLE "orders" ADD COLUMN "billing_account_id" TEXT;
ALTER TABLE "balance_transactions" ADD COLUMN "billing_account_id" TEXT;
ALTER TABLE "balance_grants" ADD COLUMN "billing_account_id" TEXT;
ALTER TABLE "balance_consumption_allocations" ADD COLUMN "billing_account_id" TEXT;

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
ON CONFLICT ("id") DO NOTHING;

UPDATE "tenants" t
SET "billing_account_id" = 'ba_personal_' || t."owner_user_id"
WHERE t."billing_account_id" IS NULL;

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
ON CONFLICT ("billing_account_id") DO UPDATE
SET
    "balance_usd" = EXCLUDED."balance_usd",
    "updated_at" = CURRENT_TIMESTAMP;

UPDATE "orders" o
SET "billing_account_id" = t."billing_account_id"
FROM "tenants" t
WHERE o."tenant_id" = t."id"
  AND o."billing_account_id" IS NULL;

UPDATE "balance_transactions" bt
SET "billing_account_id" = t."billing_account_id"
FROM "tenants" t
WHERE bt."tenant_id" = t."id"
  AND bt."billing_account_id" IS NULL;

UPDATE "balance_grants" bg
SET "billing_account_id" = t."billing_account_id"
FROM "tenants" t
WHERE bg."tenant_id" = t."id"
  AND bg."billing_account_id" IS NULL;

UPDATE "balance_consumption_allocations" bca
SET "billing_account_id" = t."billing_account_id"
FROM "tenants" t
WHERE bca."tenant_id" = t."id"
  AND bca."billing_account_id" IS NULL;

WITH consumed AS (
    SELECT
        bt."tenant_id",
        COALESCE(SUM(ABS(bt."amount_usd")), 0) AS "used_usd"
    FROM "balance_transactions" bt
    WHERE bt."type" = 'CONSUME'
      AND bt."tenant_id" IS NOT NULL
    GROUP BY bt."tenant_id"
)
UPDATE "tenants" t
SET "balance_allowance_used_usd" = consumed."used_usd"
FROM consumed
WHERE t."id" = consumed."tenant_id";

CREATE INDEX "billing_accounts_owner_user_id_idx" ON "billing_accounts"("owner_user_id");
CREATE INDEX "billing_accounts_type_status_idx" ON "billing_accounts"("type", "status");

CREATE UNIQUE INDEX "billing_account_members_billing_account_id_user_id_key"
    ON "billing_account_members"("billing_account_id", "user_id");
CREATE INDEX "billing_account_members_user_id_idx" ON "billing_account_members"("user_id");
CREATE INDEX "billing_account_members_billing_account_id_role_idx"
    ON "billing_account_members"("billing_account_id", "role");

CREATE INDEX "tenants_billing_account_id_idx" ON "tenants"("billing_account_id");
CREATE INDEX "tenants_balance_allowance_idx" ON "tenants"("balance_allowance_usd");
CREATE INDEX "orders_billing_account_id_idx" ON "orders"("billing_account_id");
CREATE INDEX "balance_transactions_billing_account_id_idx" ON "balance_transactions"("billing_account_id");
CREATE INDEX "balance_transactions_billing_account_id_created_at_idx"
    ON "balance_transactions"("billing_account_id", "created_at");
CREATE INDEX "balance_grants_billing_account_id_idx" ON "balance_grants"("billing_account_id");
CREATE INDEX "balance_grants_billing_account_id_product_id_idx"
    ON "balance_grants"("billing_account_id", "product_id");
CREATE INDEX "balance_grants_billing_account_id_expires_at_idx"
    ON "balance_grants"("billing_account_id", "expires_at");
CREATE INDEX "balance_consumption_allocations_billing_account_id_idx"
    ON "balance_consumption_allocations"("billing_account_id");
CREATE INDEX "balance_consumption_allocations_billing_account_id_created_at_idx"
    ON "balance_consumption_allocations"("billing_account_id", "created_at");

ALTER TABLE "billing_accounts"
    ADD CONSTRAINT "billing_accounts_owner_user_id_fkey"
    FOREIGN KEY ("owner_user_id") REFERENCES "users"("id") ON DELETE SET NULL ON UPDATE CASCADE;

ALTER TABLE "account_wallets"
    ADD CONSTRAINT "account_wallets_billing_account_id_fkey"
    FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "billing_account_members"
    ADD CONSTRAINT "billing_account_members_billing_account_id_fkey"
    FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "billing_account_members"
    ADD CONSTRAINT "billing_account_members_user_id_fkey"
    FOREIGN KEY ("user_id") REFERENCES "users"("id") ON DELETE CASCADE ON UPDATE CASCADE;

ALTER TABLE "tenants"
    ADD CONSTRAINT "tenants_billing_account_id_fkey"
    FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "orders"
    ADD CONSTRAINT "orders_billing_account_id_fkey"
    FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "balance_transactions"
    ADD CONSTRAINT "balance_transactions_billing_account_id_fkey"
    FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "balance_grants"
    ADD CONSTRAINT "balance_grants_billing_account_id_fkey"
    FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;

ALTER TABLE "balance_consumption_allocations"
    ADD CONSTRAINT "balance_consumption_allocations_billing_account_id_fkey"
    FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id") ON DELETE RESTRICT ON UPDATE CASCADE;
