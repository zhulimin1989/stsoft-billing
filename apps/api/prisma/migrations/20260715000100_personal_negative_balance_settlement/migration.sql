-- Generalize the existing enterprise-credit settlement ledger so personal
-- NEGATIVE_BALANCE debt repayments are equally auditable. The physical table
-- name is retained to avoid a risky rename in the hotfix migration.

-- This file is restartable only while its terminal rollout marker is absent.
-- A process can lose contact after the final database COMMIT but before Prisma
-- records success; in that case operators must prove the terminal marker/audit
-- and resolve the migration as applied instead of replaying financial DDL.
-- Fail before the first DDL if the migration role cannot read the immutable
-- cluster locator required by the terminal rollout marker.
DO $$
DECLARE
  current_system_identifier NUMERIC(20, 0);
BEGIN
  SELECT "system_identifier"::NUMERIC(20, 0)
    INTO current_system_identifier
  FROM pg_control_system();
  IF current_system_identifier IS NULL THEN
    RAISE EXCEPTION 'balance ledger migration cannot read PostgreSQL system identifier'
      USING ERRCODE = '42501';
  END IF;
EXCEPTION
  WHEN insufficient_privilege OR undefined_function THEN
    RAISE EXCEPTION
      'balance ledger migration role must be allowed to call pg_control_system()'
      USING ERRCODE = '42501';
END
$$;

DO $$
DECLARE
  existing_phase TEXT;
BEGIN
  IF to_regclass('public.balance_ledger_rollout_control') IS NOT NULL THEN
    EXECUTE
      'SELECT "phase" FROM "balance_ledger_rollout_control" WHERE "id" = 1'
      INTO existing_phase;
    IF existing_phase IS NOT NULL THEN
      RAISE EXCEPTION
        'balance ledger expand already reached terminal marker phase=%; do not replay',
        existing_phase
        USING ERRCODE = '55000';
    END IF;
  END IF;
END
$$;

-- This migration deliberately has no file-wide transaction. Holding the first
-- ACCESS EXCLUSIVE metadata lock until all proof functions and data work have
-- finished would block the still-open debit / personal-negative-balance path.
-- Existing-table metadata changes below run in bounded, very short
-- transactions. Existing-table indexes live in one-statement concurrent
-- migrations. Data backfills run outside metadata-lock transactions while the
-- funding writers named in the runbook are drained.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

ALTER TABLE "balance_grants"
  ADD COLUMN IF NOT EXISTS "remaining_paid_amount_usd" DECIMAL(20, 12),
  ADD COLUMN IF NOT EXISTS "remaining_bonus_amount_usd" DECIMAL(20, 12);
COMMIT;

-- The transaction INSERT guard reads this marker. Install the complete
-- backward-compatible marker shape before the guard can become visible; every
-- pre-existing account remains LEGACY_DIRTY.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "billing_accounts"
  ADD COLUMN IF NOT EXISTS "balance_grant_ledger_status" TEXT NOT NULL DEFAULT 'LEGACY_DIRTY',
  ADD COLUMN IF NOT EXISTS "balance_grant_ledger_version" INTEGER NOT NULL DEFAULT 0,
  ADD COLUMN IF NOT EXISTS "balance_grant_ledger_hash" TEXT,
  ADD COLUMN IF NOT EXISTS "balance_grant_ledger_reconciled_at" TIMESTAMP(3),
  ADD COLUMN IF NOT EXISTS "balance_grant_ledger_dirty_reason" TEXT,
  ADD COLUMN IF NOT EXISTS "balance_grant_ledger_through_transaction_id" TEXT;
COMMIT;

-- created_at uses PostgreSQL transaction-start time and therefore cannot order
-- two wallet-serialized transactions that began A->B but acquired the wallet
-- lock B->A.  Persist the actual post-lock INSERT order with non-transactional
-- sequence values.  The trigger is installed only after the nullable column,
-- so legacy rows remain NULL; reconciliation backfills a proven historical
-- path with deterministic per-account negatives.
CREATE SEQUENCE IF NOT EXISTS "balance_transaction_ledger_seq"
  AS BIGINT START WITH 1 INCREMENT BY 1 MINVALUE 1 NO CYCLE;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "balance_transactions"
  ADD COLUMN IF NOT EXISTS "ledger_sequence" BIGINT;
COMMIT;

ALTER SEQUENCE "balance_transaction_ledger_seq"
  OWNED BY "balance_transactions"."ledger_sequence";

CREATE OR REPLACE FUNCTION "guard_balance_transaction_ledger_sequence_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  wallet_balance NUMERIC;
  previous_balance NUMERIC;
  account_status TEXT;
  legacy_transaction_count BIGINT;
BEGIN
  IF NEW."billing_account_id" IS NULL THEN
    RAISE EXCEPTION
      'new balance transaction requires a billing account: %',
      NEW."id"
      USING ERRCODE = '23514';
  END IF;
  SELECT wallet."balance_usd", account."balance_grant_ledger_status"
    INTO wallet_balance, account_status
  FROM "account_wallets" wallet
  JOIN "billing_accounts" account
    ON account."id" = wallet."billing_account_id"
  WHERE wallet."billing_account_id" = NEW."billing_account_id"
  FOR UPDATE OF wallet;
  IF NOT FOUND OR wallet_balance IS DISTINCT FROM NEW."balance_after_usd" THEN
    RAISE EXCEPTION
      'balance transaction does not match locked account wallet transaction=% account=% wallet=% after=%',
      NEW."id",
      NEW."billing_account_id",
      COALESCE(wallet_balance::TEXT, 'MISSING'),
      NEW."balance_after_usd"
      USING ERRCODE = '23514';
  END IF;

  SELECT transaction_row."balance_after_usd"
    INTO previous_balance
  FROM "balance_transactions" transaction_row
  WHERE transaction_row."billing_account_id" = NEW."billing_account_id"
    AND transaction_row."ledger_sequence" IS NOT NULL
  ORDER BY transaction_row."ledger_sequence" DESC
  LIMIT 1;
  IF FOUND THEN
    IF previous_balance + NEW."amount_usd" IS DISTINCT FROM NEW."balance_after_usd" THEN
      RAISE EXCEPTION
        'balance transaction breaks sequenced wallet chain transaction=% account=% before=% amount=% after=%',
        NEW."id",
        NEW."billing_account_id",
        previous_balance,
        NEW."amount_usd",
        NEW."balance_after_usd"
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT COUNT(*) INTO legacy_transaction_count
    FROM "balance_transactions"
    WHERE "billing_account_id" = NEW."billing_account_id"
      AND "ledger_sequence" IS NULL;
    IF legacy_transaction_count = 0
      AND NEW."balance_after_usd" - NEW."amount_usd" <> 0
    THEN
      RAISE EXCEPTION
        'first sequenced balance transaction must start at zero transaction=% account=% before=%',
        NEW."id",
        NEW."billing_account_id",
        NEW."balance_after_usd" - NEW."amount_usd"
        USING ERRCODE = '23514';
    END IF;
    IF legacy_transaction_count > 0 AND account_status <> 'LEGACY_DIRTY' THEN
      RAISE EXCEPTION
        'clean account has unsequenced balance history account=% count=%',
        NEW."billing_account_id",
        legacy_transaction_count
        USING ERRCODE = '23514';
    END IF;
  END IF;
  -- Never trust an application-supplied positive value.  BEFORE INSERT owns
  -- this field unconditionally, so old and new pods share the same post-lock
  -- database order and an explicit override is harmlessly discarded.
  NEW."ledger_sequence" := nextval('balance_transaction_ledger_seq'::regclass);
  RETURN NEW;
END
$$;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DROP TRIGGER IF EXISTS "balance_transactions_ledger_sequence_insert_guard"
  ON "balance_transactions";
CREATE TRIGGER "balance_transactions_ledger_sequence_insert_guard"
BEFORE INSERT ON "balance_transactions"
FOR EACH ROW
EXECUTE FUNCTION "guard_balance_transaction_ledger_sequence_insert"();

-- Install the writer and the post-migration row requirement in the same
-- metadata transaction. At commit there is no interval in which an old writer
-- that omits ledger_sequence can see the CHECK without the database-owned
-- BEFORE INSERT trigger.
ALTER TABLE "balance_transactions"
  DROP CONSTRAINT IF EXISTS "balance_transactions_ledger_sequence_required_check";
ALTER TABLE "balance_transactions"
  ADD CONSTRAINT "balance_transactions_ledger_sequence_required_check"
  CHECK ("ledger_sequence" IS NOT NULL AND "ledger_sequence" <> 0) NOT VALID;
COMMIT;

-- Pair the eager INSERT check with a commit-time tail check.  A caller cannot
-- update a clean wallet, insert a matching transaction, and then mutate the
-- wallet again without a second ledger fact: every deferred event observes the
-- same final wallet and highest sequenced transaction.
CREATE OR REPLACE FUNCTION "assert_clean_account_wallet_matches_transaction_tail"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_account_id TEXT;
  account_status TEXT;
  wallet_balance NUMERIC;
  tail_balance NUMERIC;
BEGIN
  target_account_id := COALESCE(NEW."billing_account_id", OLD."billing_account_id");
  SELECT account."balance_grant_ledger_status", wallet."balance_usd"
    INTO account_status, wallet_balance
  FROM "billing_accounts" account
  JOIN "account_wallets" wallet ON wallet."billing_account_id" = account."id"
  WHERE account."id" = target_account_id;
  IF NOT FOUND OR account_status <> 'RECONCILED_V2' THEN
    RETURN NULL;
  END IF;

  SELECT "balance_after_usd" INTO tail_balance
  FROM "balance_transactions"
  WHERE "billing_account_id" = target_account_id
  ORDER BY "ledger_sequence" DESC
  LIMIT 1;
  tail_balance := COALESCE(tail_balance, 0);
  IF wallet_balance IS DISTINCT FROM tail_balance THEN
    RAISE EXCEPTION
      'clean account wallet does not match sequenced transaction tail account=% wallet=% tail=%',
      target_account_id,
      wallet_balance,
      tail_balance
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DROP TRIGGER IF EXISTS "account_wallets_transaction_tail_deferred"
  ON "account_wallets";
CREATE CONSTRAINT TRIGGER "account_wallets_transaction_tail_deferred"
AFTER INSERT OR UPDATE ON "account_wallets"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "assert_clean_account_wallet_matches_transaction_tail"();
COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DROP TRIGGER IF EXISTS "balance_transactions_wallet_tail_deferred"
  ON "balance_transactions";
CREATE CONSTRAINT TRIGGER "balance_transactions_wallet_tail_deferred"
AFTER INSERT ON "balance_transactions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "assert_clean_account_wallet_matches_transaction_tail"();
COMMIT;

CREATE SEQUENCE IF NOT EXISTS "balance_consumption_allocation_ledger_seq"
  AS BIGINT START WITH 1 INCREMENT BY 1 MINVALUE 1 NO CYCLE;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "balance_consumption_allocations"
  ADD COLUMN IF NOT EXISTS "ledger_sequence" BIGINT;

ALTER TABLE "balance_consumption_allocations"
  ALTER COLUMN "ledger_sequence"
  SET DEFAULT nextval('balance_consumption_allocation_ledger_seq'::regclass);
COMMIT;

ALTER SEQUENCE "balance_consumption_allocation_ledger_seq"
  OWNED BY "balance_consumption_allocations"."ledger_sequence";

-- Consumption allocations are financial facts.  The legacy relation used
-- ON DELETE CASCADE, which made deleting a BalanceTransaction silently erase
-- its allocation evidence.  Convert that edge to RESTRICT before installing
-- the append-only row guards below.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "balance_consumption_allocations"
  DROP CONSTRAINT IF EXISTS "balance_consumption_allocations_balance_transaction_id_fkey";
ALTER TABLE "balance_consumption_allocations"
  ADD CONSTRAINT "balance_consumption_allocations_balance_transaction_id_fkey"
  FOREIGN KEY ("balance_transaction_id") REFERENCES "balance_transactions"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "balance_consumption_allocations"
  DROP CONSTRAINT IF EXISTS "balance_consumption_allocations_ledger_sequence_nonzero_check";
ALTER TABLE "balance_consumption_allocations"
  ADD CONSTRAINT "balance_consumption_allocations_ledger_sequence_nonzero_check"
  CHECK ("ledger_sequence" IS NULL OR "ledger_sequence" <> 0) NOT VALID;

-- NOT VALID skips the legacy scan but is enforced for every post-migration
-- INSERT/UPDATE. Old and new application versions both omit this new column and
-- therefore receive the database default; explicitly inserting NULL debt fails.
ALTER TABLE "balance_consumption_allocations"
  -- Keep the physical identifier below PostgreSQL's 63-byte limit. The older
  -- long spelling was silently truncated and could not be queried by its
  -- documented name.
  DROP CONSTRAINT IF EXISTS "balance_consumption_allocations_debt_ledger_sequence_required_c",
  DROP CONSTRAINT IF EXISTS "balance_allocations_debt_ledger_sequence_required_check";
ALTER TABLE "balance_consumption_allocations"
  ADD CONSTRAINT "balance_allocations_debt_ledger_sequence_required_check"
  CHECK (
    "source" NOT IN ('ENTERPRISE_CREDIT', 'NEGATIVE_BALANCE')
    OR (
      "billing_account_id" IS NOT NULL
      AND "ledger_sequence" IS NOT NULL
    )
  ) NOT VALID;
COMMIT;

-- Do not rewrite the existing balance_grants heap here, including rows whose
-- total remainder is zero. Historical component facts belong to the audited
-- reconciliation plan. Avoiding an unconditional hot-table UPDATE also keeps
-- normal debit traffic independent from migration duration.

-- Do not add NOT NULL / exact component constraints in this expand migration.
-- During a rolling deploy an old pod may still write only remaining_amount_usd.
-- The new reader can consume a NULL legacy row with an atomic one-time
-- materialization, but expiry remains blocked until the account is reconciled.
-- A later contract migration may enforce the invariant only after the audit
-- command reports zero legacy/stale component rows.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "billing_accounts"
  DROP CONSTRAINT IF EXISTS "billing_accounts_balance_grant_ledger_status_check";
ALTER TABLE "billing_accounts"
  ADD CONSTRAINT "billing_accounts_balance_grant_ledger_status_check"
  CHECK ("balance_grant_ledger_status" IN ('LEGACY_DIRTY', 'RECONCILED_V2')) NOT VALID;

-- The marker is a financial proof gate, not a display label. Prevent a manual
-- status/version flip from manufacturing a clean account that the expiry
-- trigger would trust. NOT VALID avoids a legacy table scan while enforcing
-- the complete tuple for every post-migration INSERT/UPDATE.
ALTER TABLE "billing_accounts"
  DROP CONSTRAINT IF EXISTS "billing_accounts_balance_grant_ledger_proof_check";
ALTER TABLE "billing_accounts"
  ADD CONSTRAINT "billing_accounts_balance_grant_ledger_proof_check"
  CHECK (
    (
      "balance_grant_ledger_status" = 'LEGACY_DIRTY'
      AND "balance_grant_ledger_version" = 0
      AND "balance_grant_ledger_hash" IS NULL
      AND "balance_grant_ledger_reconciled_at" IS NULL
    )
    OR (
      "balance_grant_ledger_status" = 'RECONCILED_V2'
      AND "balance_grant_ledger_version" = 2
      AND "balance_grant_ledger_hash" IS NOT NULL
      AND "balance_grant_ledger_reconciled_at" IS NOT NULL
      AND "balance_grant_ledger_dirty_reason" IS NULL
    )
  ) NOT VALID;
COMMIT;

-- Database-level fail-closed guard for the expand-first rollout. An old expiry
-- worker does not understand the marker and could otherwise flip a legacy grant
-- before the new pods are live. Raising from the grant UPDATE rolls its whole
-- expiry transaction back, including any wallet/transaction writes.
CREATE OR REPLACE FUNCTION "guard_balance_grant_expiry_reconciled_v2"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  account_status TEXT;
  account_version INTEGER;
  account_hash TEXT;
  account_reconciled_at TIMESTAMP(3);
  account_dirty_reason TEXT;
  writer_version TEXT;
  financial_now_text TEXT;
  financial_now TIMESTAMP(3);
BEGIN
  IF NEW."is_expired" = TRUE AND OLD."is_expired" = FALSE THEN
    -- FALSE -> TRUE is a pure state transition, never an opportunity to
    -- rewrite issuance identity, ownership, gross value or lifecycle time.
    -- Keep the complete pre-expiry financial snapshot authoritative; only the
    -- three remaining components may be zeroed (updated_at is derived).
    IF NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
      OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
      OR NEW."billing_account_id" IS DISTINCT FROM OLD."billing_account_id"
      OR NEW."order_id" IS DISTINCT FROM OLD."order_id"
      OR NEW."product_id" IS DISTINCT FROM OLD."product_id"
      OR NEW."source" IS DISTINCT FROM OLD."source"
      OR NEW."paid_amount_usd" IS DISTINCT FROM OLD."paid_amount_usd"
      OR NEW."bonus_amount_usd" IS DISTINCT FROM OLD."bonus_amount_usd"
      OR NEW."granted_amount_usd" IS DISTINCT FROM OLD."granted_amount_usd"
      OR NEW."discount_rate" IS DISTINCT FROM OLD."discount_rate"
      OR NEW."valid_from" IS DISTINCT FROM OLD."valid_from"
      OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
      OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    THEN
      RAISE EXCEPTION
        'balance grant % expiry cannot rewrite issuance snapshot',
        OLD."id"
        USING ERRCODE = '23514';
    END IF;

    -- Expiration is an authorization boundary. Use the immutable PostgreSQL
    -- instant captured after the wallet/grant locks, never a second wall-clock
    -- read that NTP/OS can move backwards between capture and this UPDATE.
    financial_now_text := current_setting('billing.balance_financial_now', TRUE);
    IF financial_now_text IS NULL OR btrim(financial_now_text) = '' THEN
      RAISE EXCEPTION
        'balance grant % cannot expire without locked financial now',
        OLD."id"
        USING ERRCODE = '23514';
    END IF;
    BEGIN
      financial_now := financial_now_text::TIMESTAMP(3);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION
        'balance grant % has invalid locked financial now',
        OLD."id"
        USING ERRCODE = '23514';
    END;
    IF OLD."expires_at" IS NULL OR OLD."expires_at" > financial_now THEN
      RAISE EXCEPTION
        'balance grant % cannot expire before expires_at (%)',
        OLD."id",
        COALESCE(OLD."expires_at"::TEXT, 'NULL')
        USING ERRCODE = '23514';
    END IF;

    IF NEW."remaining_amount_usd" <> 0
      OR NEW."remaining_paid_amount_usd" IS DISTINCT FROM 0
      OR NEW."remaining_bonus_amount_usd" IS DISTINCT FROM 0
    THEN
      RAISE EXCEPTION
        'balance grant % expiry must atomically zero all remaining components',
        OLD."id"
        USING ERRCODE = '23514';
    END IF;

    writer_version := current_setting('billing.balance_grant_expiry_writer', TRUE);
    IF writer_version IS DISTINCT FROM 'v2' THEN
      RAISE EXCEPTION
        'balance grant % cannot expire without the v2 expiry writer',
        OLD."id"
        USING ERRCODE = '23514';
    END IF;

    IF OLD."billing_account_id" IS NULL THEN
      RAISE EXCEPTION 'balance grant % cannot expire without billing_account_id', OLD."id"
        USING ERRCODE = '23514';
    END IF;

    SELECT
      a."balance_grant_ledger_status",
      a."balance_grant_ledger_version",
      a."balance_grant_ledger_hash",
      a."balance_grant_ledger_reconciled_at",
      a."balance_grant_ledger_dirty_reason"
    INTO account_status, account_version, account_hash, account_reconciled_at, account_dirty_reason
    FROM "billing_accounts" a
    WHERE a."id" = OLD."billing_account_id";

    IF account_status IS DISTINCT FROM 'RECONCILED_V2'
      OR account_version IS DISTINCT FROM 2
      OR account_hash IS NULL
      OR account_reconciled_at IS NULL
      OR account_dirty_reason IS NOT NULL
    THEN
      RAISE EXCEPTION
        'balance grant % cannot expire while account % ledger is % v%',
        OLD."id",
        OLD."billing_account_id",
        COALESCE(account_status, 'MISSING'),
        COALESCE(account_version::TEXT, 'MISSING')
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END;
$$;

-- Expand release only defines the strict expiry guard. It MUST NOT activate
-- the trigger while an origin/test pod can still run inline expiry as part of
-- a user debit. The physically separate 20260717000100 contract migration is
-- shipped only after the new pods are live and every old in-flight debit has
-- drained.

-- No pre-existing account is promoted here, including an apparently empty one:
-- an old pod can still write it during the rolling window without V2 component
-- facts. Existing accounts remain LEGACY_DIRTY until the post-rollout replay
-- proves them; only accounts created by fully deployed V2 code start clean.

-- Existing-table indexes are built by later one-statement CONCURRENTLY
-- migrations. Never build them here while holding a blocking table lock.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "balance_transactions"
  ADD COLUMN IF NOT EXISTS "operation_key" TEXT;
COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "enterprise_credit_settlements"
  ADD COLUMN IF NOT EXISTS "balance_grant_id" TEXT,
  ADD COLUMN IF NOT EXISTS "debt_source" TEXT NOT NULL DEFAULT 'ENTERPRISE_CREDIT',
  ADD COLUMN IF NOT EXISTS "repair_run_id" TEXT,
  ADD COLUMN IF NOT EXISTS "operation_key" TEXT,
  ADD COLUMN IF NOT EXISTS "occurred_at" TIMESTAMP(3);
ALTER TABLE "enterprise_credit_settlements"
  ALTER COLUMN "occurred_at" SET DEFAULT CURRENT_TIMESTAMP;
COMMIT;

-- Funding writers are drained for this phase, while normal debit and personal
-- overdraft remain open. This idempotent data statement takes row locks only;
-- it is intentionally not coupled to any ACCESS EXCLUSIVE metadata lock.
UPDATE "enterprise_credit_settlements"
SET
  "occurred_at" = COALESCE("occurred_at", "created_at"),
  "operation_key" = COALESCE("operation_key", 'legacy:' || "id")
WHERE "occurred_at" IS NULL OR "operation_key" IS NULL;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "enterprise_credit_settlements"
  DROP CONSTRAINT IF EXISTS "enterprise_credit_settlements_occurred_at_not_null_check";
ALTER TABLE "enterprise_credit_settlements"
  ADD CONSTRAINT "enterprise_credit_settlements_occurred_at_not_null_check"
  CHECK ("occurred_at" IS NOT NULL) NOT VALID;
COMMIT;

-- Validation may scan this table, but its SHARE UPDATE EXCLUSIVE lock remains
-- compatible with SELECT/INSERT/UPDATE/DELETE. It is not held together with
-- ACCESS EXCLUSIVE DDL. Clone timing determines the approved timeout.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30min';
ALTER TABLE "enterprise_credit_settlements"
  VALIDATE CONSTRAINT "enterprise_credit_settlements_occurred_at_not_null_check";
COMMIT;

-- PostgreSQL can use the validated CHECK proof and avoid a second heap scan.
-- The old writer default was installed before the backfill, so the short
-- ACCESS EXCLUSIVE lock only changes metadata.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "enterprise_credit_settlements"
  ALTER COLUMN "occurred_at" SET NOT NULL;
COMMIT;

-- Expand phase: keep operation_key nullable until every old writer has been
-- retired. New code always supplies it and the unique index protects non-NULL
-- keys. A later contract migration may backfill any rolling-deploy NULL rows
-- and enforce NOT NULL.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "enterprise_credit_settlements"
  DROP CONSTRAINT IF EXISTS "enterprise_credit_settlements_billing_account_id_fkey",
  DROP CONSTRAINT IF EXISTS "enterprise_credit_settlements_allocation_id_fkey",
  DROP CONSTRAINT IF EXISTS "enterprise_credit_settlements_repayment_transaction_id_fkey";

ALTER TABLE "enterprise_credit_settlements"
  ADD CONSTRAINT "enterprise_credit_settlements_billing_account_id_fkey"
  FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
  ADD CONSTRAINT "enterprise_credit_settlements_allocation_id_fkey"
  FOREIGN KEY ("allocation_id") REFERENCES "balance_consumption_allocations"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID,
  ADD CONSTRAINT "enterprise_credit_settlements_repayment_transaction_id_fkey"
  FOREIGN KEY ("repayment_transaction_id") REFERENCES "balance_transactions"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;

ALTER TABLE "enterprise_credit_settlements"
  DROP CONSTRAINT IF EXISTS "enterprise_credit_settlements_balance_grant_id_fkey";
ALTER TABLE "enterprise_credit_settlements"
  ADD CONSTRAINT "enterprise_credit_settlements_balance_grant_id_fkey"
  FOREIGN KEY ("balance_grant_id") REFERENCES "balance_grants"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;

ALTER TABLE "enterprise_credit_settlements"
  DROP CONSTRAINT IF EXISTS "enterprise_credit_settlements_debt_source_check";
ALTER TABLE "enterprise_credit_settlements"
  ADD CONSTRAINT "enterprise_credit_settlements_debt_source_check"
  CHECK ("debt_source" IN ('ENTERPRISE_CREDIT', 'NEGATIVE_BALANCE')) NOT VALID;

ALTER TABLE "enterprise_credit_settlements"
  DROP CONSTRAINT IF EXISTS "enterprise_credit_settlements_amount_parts_check";
ALTER TABLE "enterprise_credit_settlements"
  ADD CONSTRAINT "enterprise_credit_settlements_amount_parts_check"
  CHECK (
    "amount_usd" > 0
    AND "paid_usd" >= 0
    AND "bonus_usd" >= 0
    AND "amount_usd" = "paid_usd" + "bonus_usd"
  ) NOT VALID;
COMMIT;

CREATE TABLE IF NOT EXISTS "balance_grant_expiries" (
  "id" TEXT PRIMARY KEY,
  "balance_grant_id" TEXT NOT NULL UNIQUE,
  "billing_account_id" TEXT NOT NULL,
  "balance_transaction_id" TEXT UNIQUE,
  "nominal_amount_usd" DECIMAL(20, 12) NOT NULL,
  "nominal_paid_usd" DECIMAL(20, 12) NOT NULL,
  "nominal_bonus_usd" DECIMAL(20, 12) NOT NULL,
  "wallet_debit_usd" DECIMAL(20, 12) NOT NULL,
  "wallet_debit_paid_usd" DECIMAL(20, 12) NOT NULL,
  "wallet_debit_bonus_usd" DECIMAL(20, 12) NOT NULL,
  "unbacked_amount_usd" DECIMAL(20, 12) NOT NULL,
  "unbacked_paid_usd" DECIMAL(20, 12) NOT NULL,
  "unbacked_bonus_usd" DECIMAL(20, 12) NOT NULL,
  "wallet_balance_before_usd" DECIMAL(20, 12) NOT NULL,
  "wallet_balance_after_usd" DECIMAL(20, 12) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "balance_grant_expiries_balance_grant_id_fkey"
    FOREIGN KEY ("balance_grant_id") REFERENCES "balance_grants"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "balance_grant_expiries_billing_account_id_fkey"
    FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "balance_grant_expiries_balance_transaction_id_fkey"
    FOREIGN KEY ("balance_transaction_id") REFERENCES "balance_transactions"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "balance_grant_expiries_amounts_check" CHECK (
    "nominal_amount_usd" >= 0
    AND "nominal_paid_usd" >= 0
    AND "nominal_bonus_usd" >= 0
    AND "wallet_debit_usd" >= 0
    AND "wallet_debit_paid_usd" >= 0
    AND "wallet_debit_bonus_usd" >= 0
    AND "unbacked_amount_usd" >= 0
    AND "unbacked_paid_usd" >= 0
    AND "unbacked_bonus_usd" >= 0
    AND "nominal_amount_usd" = "nominal_paid_usd" + "nominal_bonus_usd"
    AND "wallet_debit_usd" = "wallet_debit_paid_usd" + "wallet_debit_bonus_usd"
    AND "unbacked_amount_usd" = "unbacked_paid_usd" + "unbacked_bonus_usd"
    AND "nominal_amount_usd" = "wallet_debit_usd" + "unbacked_amount_usd"
    AND "wallet_balance_after_usd" = "wallet_balance_before_usd" - "wallet_debit_usd"
    AND "nominal_amount_usd" > 0
    AND (
      ("wallet_debit_usd" = 0 AND "balance_transaction_id" IS NULL)
      OR ("wallet_debit_usd" > 0 AND "balance_transaction_id" IS NOT NULL)
    )
  )
);

CREATE INDEX IF NOT EXISTS "balance_grant_expiries_account_created_idx"
  ON "balance_grant_expiries"("billing_account_id", "created_at");

-- A BalanceGrant is an issued financial batch. Its identity, ownership,
-- original paid principal and lifecycle window never change after INSERT.
-- Legitimate live mutations are limited to bonus append (bonus/granted/
-- discount plus remaining components), consumption/refund remaining-component
-- changes, and the separately guarded expiry state transition.
CREATE OR REPLACE FUNCTION "reject_balance_grant_issuance_snapshot_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  paid_transaction_count BIGINT;
  canonical_bonus_total NUMERIC;
  invalid_order_funding_count BIGINT;
  account_ledger_status TEXT;
BEGIN
  -- Every newly issued batch must belong to an account.  The nullable column
  -- is retained only for pre-migration rows during the expand/contract window;
  -- allowing a new NULL row would bypass every account-scoped invariant.
  IF TG_OP = 'INSERT' AND NEW."billing_account_id" IS NULL THEN
    RAISE EXCEPTION 'new balance grant must reference a billing account: %', NEW."id"
      USING ERRCODE = '23514';
  END IF;

  SELECT account."balance_grant_ledger_status"
  INTO account_ledger_status
  FROM "billing_accounts" account
  WHERE account."id" = NEW."billing_account_id";
  IF account_ledger_status = 'RECONCILED_V2' AND (
    NEW."source" NOT IN ('RECHARGE', 'VOUCHER')
    OR NEW."user_id" IS NULL
    OR NEW."tenant_id" IS NULL
    OR NEW."paid_amount_usd" < 0
    OR NEW."bonus_amount_usd" < 0
    OR NEW."granted_amount_usd" <= 0
    OR NEW."paid_amount_usd" + NEW."bonus_amount_usd" <> NEW."granted_amount_usd"
    OR NEW."remaining_amount_usd" < 0
    OR NEW."remaining_paid_amount_usd" IS NULL
    OR NEW."remaining_bonus_amount_usd" IS NULL
    OR NEW."remaining_paid_amount_usd" < 0
    OR NEW."remaining_bonus_amount_usd" < 0
    OR NEW."remaining_paid_amount_usd" + NEW."remaining_bonus_amount_usd"
      <> NEW."remaining_amount_usd"
    OR NEW."remaining_paid_amount_usd" > NEW."paid_amount_usd"
    OR NEW."remaining_bonus_amount_usd" > NEW."bonus_amount_usd"
    OR NEW."discount_rate" IS DISTINCT FROM CASE
      WHEN NEW."granted_amount_usd" > 0 THEN ROUND(
        NEW."paid_amount_usd" / NEW."granted_amount_usd",
        12
      )
      ELSE 0
    END
    -- Both values are immutable facts from the same writer.  Comparing the
    -- earlier financial timestamp to a fresh clock_timestamp() is unsafe:
    -- wall clocks may step backwards and randomly reject a legitimate grant.
    OR NEW."valid_from" > NEW."created_at"
    OR (NEW."expires_at" IS NOT NULL AND NEW."expires_at" <= NEW."valid_from")
    OR (TG_OP = 'INSERT' AND NEW."is_expired")
  ) THEN
    RAISE EXCEPTION 'clean balance grant component invariant invalid: %', NEW."id"
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'INSERT' THEN
    RETURN NEW;
  END IF;

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
    OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."billing_account_id" IS DISTINCT FROM OLD."billing_account_id"
    OR NEW."order_id" IS DISTINCT FROM OLD."order_id"
    OR NEW."product_id" IS DISTINCT FROM OLD."product_id"
    OR NEW."source" IS DISTINCT FROM OLD."source"
    OR NEW."paid_amount_usd" IS DISTINCT FROM OLD."paid_amount_usd"
    OR NEW."valid_from" IS DISTINCT FROM OLD."valid_from"
    OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'balance grant issuance snapshot is immutable: %', OLD."id"
      USING ERRCODE = '23514';
  END IF;
  IF OLD."is_expired" AND NOT NEW."is_expired" THEN
    RAISE EXCEPTION 'expired balance grant cannot be revived: %', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  IF NEW."bonus_amount_usd" IS DISTINCT FROM OLD."bonus_amount_usd"
    OR NEW."granted_amount_usd" IS DISTINCT FROM OLD."granted_amount_usd"
    OR NEW."discount_rate" IS DISTINCT FROM OLD."discount_rate"
  THEN
    SELECT
      COUNT(*) FILTER (
        WHERE funding."amount_usd" > 0
          AND funding."type"::TEXT = 'RECHARGE'
      ),
      COALESCE(SUM(funding."amount_usd") FILTER (
        WHERE funding."amount_usd" > 0
          AND funding."type"::TEXT = 'ADJUST'
          AND funding."description" ~ '^recharge-bonus(?: tier:[^[:space:]]+)?$'
      ), 0),
      COUNT(*) FILTER (
        WHERE funding."amount_usd" > 0
          AND (
            funding."user_id" IS DISTINCT FROM OLD."user_id"
          OR funding."tenant_id" IS DISTINCT FROM OLD."tenant_id"
          OR funding."product_id" IS DISTINCT FROM OLD."product_id"
          OR NOT (
            funding."type"::TEXT = 'RECHARGE'
            OR (
              funding."type"::TEXT = 'ADJUST'
              AND funding."description" ~ '^recharge-bonus(?: tier:[^[:space:]]+)?$'
            )
          )
          )
      )
    INTO paid_transaction_count, canonical_bonus_total, invalid_order_funding_count
    FROM "balance_transactions" funding
    WHERE funding."billing_account_id" = OLD."billing_account_id"
      AND funding."order_id" = OLD."order_id";

    IF OLD."is_expired"
      OR NEW."is_expired"
      OR OLD."source" <> 'RECHARGE'
      OR OLD."order_id" IS NULL
      OR NEW."bonus_amount_usd" <= OLD."bonus_amount_usd"
      OR NEW."granted_amount_usd" - OLD."granted_amount_usd"
        <> NEW."bonus_amount_usd" - OLD."bonus_amount_usd"
      OR NEW."granted_amount_usd" <> NEW."paid_amount_usd" + NEW."bonus_amount_usd"
      OR NEW."granted_amount_usd" <= 0
      OR NEW."discount_rate" IS DISTINCT FROM ROUND(
        NEW."paid_amount_usd" / NEW."granted_amount_usd",
        12
      )
      OR NOT (
        (
          OLD."remaining_paid_amount_usd" IS NOT NULL
          AND OLD."remaining_bonus_amount_usd" IS NOT NULL
          AND NEW."remaining_paid_amount_usd" IS NOT NULL
          AND NEW."remaining_bonus_amount_usd" IS NOT NULL
          AND NEW."remaining_paid_amount_usd" IS NOT DISTINCT FROM OLD."remaining_paid_amount_usd"
          AND NEW."remaining_bonus_amount_usd" >= OLD."remaining_bonus_amount_usd"
          AND NEW."remaining_amount_usd" - OLD."remaining_amount_usd"
            = NEW."remaining_bonus_amount_usd" - OLD."remaining_bonus_amount_usd"
          AND NEW."remaining_amount_usd" - OLD."remaining_amount_usd" >= 0
          AND NEW."remaining_amount_usd" - OLD."remaining_amount_usd"
            <= NEW."bonus_amount_usd" - OLD."bonus_amount_usd"
        )
        OR (
          account_ledger_status = 'LEGACY_DIRTY'
          AND OLD."remaining_paid_amount_usd" IS NULL
          AND OLD."remaining_bonus_amount_usd" IS NULL
          AND NEW."remaining_paid_amount_usd" IS NULL
          AND NEW."remaining_bonus_amount_usd" IS NULL
          AND NEW."remaining_amount_usd" - OLD."remaining_amount_usd" >= 0
          AND NEW."remaining_amount_usd" - OLD."remaining_amount_usd"
            <= NEW."bonus_amount_usd" - OLD."bonus_amount_usd"
        )
      )
      OR paid_transaction_count <> 1
      OR canonical_bonus_total IS DISTINCT FROM NEW."bonus_amount_usd"
      OR invalid_order_funding_count <> 0
      OR NOT EXISTS (
        SELECT 1
        FROM "balance_transactions" paid
        WHERE paid."billing_account_id" = OLD."billing_account_id"
          AND paid."order_id" = OLD."order_id"
          AND paid."type"::TEXT = 'RECHARGE'
          AND paid."amount_usd" = OLD."paid_amount_usd"
          AND paid."created_at" = OLD."created_at"
          AND (
            paid."operation_key" IS NULL
            OR paid."operation_key" = 'balance:recharge:' || OLD."order_id" || ':paid'
          )
      )
    THEN
      RAISE EXCEPTION 'balance grant bonus append lacks canonical funding proof: %', OLD."id"
        USING ERRCODE = '23514';
    END IF;
  END IF;
  RETURN NEW;
END
$$;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DROP TRIGGER IF EXISTS "balance_grants_issuance_snapshot_immutable"
  ON "balance_grants";
CREATE TRIGGER "balance_grants_issuance_snapshot_immutable"
BEFORE INSERT OR UPDATE ON "balance_grants"
FOR EACH ROW
EXECUTE FUNCTION "reject_balance_grant_issuance_snapshot_mutation"();
COMMIT;

-- Once an expiry audit has committed, the expired grant is a financial
-- snapshot.  The deferred aggregate below proves the initial FALSE -> TRUE
-- transition, but without this row guard a later transaction could revive the
-- wallet by rewriting the grant after its audit committed. Gate
-- on OLD.is_expired so the first expiry remains valid even when the writer
-- inserts the audit row before updating the grant.
CREATE OR REPLACE FUNCTION "reject_audited_balance_grant_financial_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."is_expired"
    AND EXISTS (
      SELECT 1
      FROM "balance_grant_expiries" expiry
      WHERE expiry."balance_grant_id" = OLD."id"
    )
    AND (
      NEW."id" IS DISTINCT FROM OLD."id"
      OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
      OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
      OR NEW."billing_account_id" IS DISTINCT FROM OLD."billing_account_id"
      OR NEW."order_id" IS DISTINCT FROM OLD."order_id"
      OR NEW."product_id" IS DISTINCT FROM OLD."product_id"
      OR NEW."source" IS DISTINCT FROM OLD."source"
      OR NEW."paid_amount_usd" IS DISTINCT FROM OLD."paid_amount_usd"
      OR NEW."bonus_amount_usd" IS DISTINCT FROM OLD."bonus_amount_usd"
      OR NEW."granted_amount_usd" IS DISTINCT FROM OLD."granted_amount_usd"
      OR NEW."remaining_amount_usd" IS DISTINCT FROM OLD."remaining_amount_usd"
      OR NEW."remaining_paid_amount_usd"
        IS DISTINCT FROM OLD."remaining_paid_amount_usd"
      OR NEW."remaining_bonus_amount_usd"
        IS DISTINCT FROM OLD."remaining_bonus_amount_usd"
      OR NEW."discount_rate" IS DISTINCT FROM OLD."discount_rate"
      OR NEW."valid_from" IS DISTINCT FROM OLD."valid_from"
      OR NEW."expires_at" IS DISTINCT FROM OLD."expires_at"
      OR NEW."is_expired" IS DISTINCT FROM OLD."is_expired"
      OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    )
  THEN
    RAISE EXCEPTION
      'audited expired balance grant financial snapshot is immutable: %',
      OLD."id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DROP TRIGGER IF EXISTS "balance_grants_audited_expiry_financial_immutable"
  ON "balance_grants";
CREATE TRIGGER "balance_grants_audited_expiry_financial_immutable"
BEFORE UPDATE ON "balance_grants"
FOR EACH ROW
EXECUTE FUNCTION "reject_audited_balance_grant_financial_mutation"();
COMMIT;

-- The BEFORE guard above authorizes the V2 expiry path, but a writer token is
-- not accounting evidence. At commit, prove that every new FALSE -> TRUE
-- transition has the matching immutable audit, wallet debit and ADJUST
-- transaction, and that the complete account ledger still balances. The OLD
-- component values are passed by the deferred row event, so a caller cannot
-- manufacture a smaller nominal expiry after zeroing the grant.
CREATE OR REPLACE FUNCTION "assert_balance_grant_expiry_aggregate"(
  target_grant_id TEXT,
  expected_account_id TEXT,
  expected_nominal_amount NUMERIC,
  expected_nominal_paid NUMERIC,
  expected_nominal_bonus NUMERIC,
  expected_expires_at TIMESTAMP(3)
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  grant_row RECORD;
  expiry_row RECORD;
  transaction_row RECORD;
  account_row RECORD;
  wallet_balance NUMERIC;
  active_grant_amount NUMERIC;
  open_debt_amount NUMERIC;
  invalid_grant_count BIGINT;
  invalid_debt_count BIGINT;
  invalid_sequence_count BIGINT;
  unexpected_debt_count BIGINT;
  expiry_count BIGINT;
  expected_debt_source TEXT;
  transaction_total NUMERIC;
  predecessor_balance NUMERIC;
BEGIN
  SELECT * INTO grant_row
  FROM "balance_grants"
  WHERE "id" = target_grant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'balance grant expiry references missing grant: %', target_grant_id;
  END IF;

  SELECT COUNT(*) INTO expiry_count
  FROM "balance_grant_expiries"
  WHERE "balance_grant_id" = target_grant_id;
  IF expiry_count <> 1 THEN
    RAISE EXCEPTION
      'balance grant expiry audit count invalid grant=% count=%',
      target_grant_id,
      expiry_count;
  END IF;

  SELECT * INTO expiry_row
  FROM "balance_grant_expiries"
  WHERE "balance_grant_id" = target_grant_id;

  SELECT * INTO account_row
  FROM "billing_accounts"
  WHERE "id" = expiry_row."billing_account_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'balance grant expiry references missing account: %',
      expiry_row."billing_account_id";
  END IF;

  SELECT * INTO transaction_row
  FROM "balance_transactions"
  WHERE "id" = expiry_row."balance_transaction_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'balance grant expiry references missing transaction grant=% transaction=%',
      target_grant_id,
      expiry_row."balance_transaction_id";
  END IF;

  SELECT "balance_usd" INTO wallet_balance
  FROM "account_wallets"
  WHERE "billing_account_id" = expiry_row."billing_account_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'balance grant expiry references missing wallet: %',
      expiry_row."billing_account_id";
  END IF;

  IF expected_expires_at IS NULL
    OR expected_nominal_amount IS NULL
    OR expected_nominal_paid IS NULL
    OR expected_nominal_bonus IS NULL
    OR expected_nominal_amount <= 0
    OR expected_nominal_amount <> expected_nominal_paid + expected_nominal_bonus
    OR grant_row."billing_account_id" IS DISTINCT FROM expected_account_id
    OR grant_row."billing_account_id" IS DISTINCT FROM expiry_row."billing_account_id"
    OR grant_row."expires_at" IS DISTINCT FROM expected_expires_at
    OR NOT grant_row."is_expired"
    OR grant_row."remaining_amount_usd" <> 0
    OR grant_row."remaining_paid_amount_usd" IS DISTINCT FROM 0
    OR grant_row."remaining_bonus_amount_usd" IS DISTINCT FROM 0
    OR expiry_row."nominal_amount_usd" IS DISTINCT FROM expected_nominal_amount
    OR expiry_row."nominal_paid_usd" IS DISTINCT FROM expected_nominal_paid
    OR expiry_row."nominal_bonus_usd" IS DISTINCT FROM expected_nominal_bonus
    OR expiry_row."wallet_debit_usd" IS DISTINCT FROM expected_nominal_amount
    OR expiry_row."wallet_debit_paid_usd" IS DISTINCT FROM expected_nominal_paid
    OR expiry_row."wallet_debit_bonus_usd" IS DISTINCT FROM expected_nominal_bonus
    OR expiry_row."unbacked_amount_usd" <> 0
    OR expiry_row."unbacked_paid_usd" <> 0
    OR expiry_row."unbacked_bonus_usd" <> 0
    OR expiry_row."wallet_balance_after_usd"
      IS DISTINCT FROM expiry_row."wallet_balance_before_usd" - expected_nominal_amount
    OR expiry_row."created_at" < expected_expires_at
    OR transaction_row."billing_account_id" IS DISTINCT FROM expiry_row."billing_account_id"
    OR transaction_row."user_id" IS DISTINCT FROM grant_row."user_id"
    OR transaction_row."tenant_id" IS DISTINCT FROM grant_row."tenant_id"
    OR transaction_row."product_id" IS DISTINCT FROM grant_row."product_id"
    OR transaction_row."order_id" IS DISTINCT FROM grant_row."order_id"
    OR transaction_row."type"::TEXT IS DISTINCT FROM 'ADJUST'
    OR transaction_row."operation_key"
      IS DISTINCT FROM ('balance:grant-expiry:' || target_grant_id)
    OR transaction_row."description"
      IS DISTINCT FROM ('balance grant expired:' || target_grant_id)
    OR transaction_row."amount_usd" IS DISTINCT FROM -expected_nominal_amount
    OR transaction_row."balance_after_usd"
      IS DISTINCT FROM expiry_row."wallet_balance_after_usd"
    OR transaction_row."ledger_sequence" IS NULL
    OR transaction_row."ledger_sequence" <= 0
    OR transaction_row."created_at" IS DISTINCT FROM expiry_row."created_at"
    OR account_row."balance_grant_ledger_status" IS DISTINCT FROM 'RECONCILED_V2'
    OR account_row."balance_grant_ledger_version" IS DISTINCT FROM 2
    OR account_row."balance_grant_ledger_hash" IS NULL
    OR account_row."balance_grant_ledger_reconciled_at" IS NULL
    OR account_row."balance_grant_ledger_dirty_reason" IS NOT NULL
  THEN
    RAISE EXCEPTION
      'balance grant expiry aggregate invalid grant=% account=%',
      target_grant_id,
      expiry_row."billing_account_id";
  END IF;

  expected_debt_source := CASE
    WHEN account_row."type" = 'enterprise' THEN 'ENTERPRISE_CREDIT'
    ELSE 'NEGATIVE_BALANCE'
  END;

  -- Promotion proves the complete negative historical prefix once. Every
  -- online INSERT then receives a trigger-owned positive sequence while the
  -- wallet row is locked. Re-prove only this expiry's immutable predecessor
  -- edge here; append-only rows plus the deferred wallet-tail check preserve
  -- the full chain inductively without scanning an account's entire history.
  SELECT prior."balance_after_usd" INTO predecessor_balance
  FROM "balance_transactions" prior
  WHERE prior."billing_account_id" = expiry_row."billing_account_id"
    AND prior."ledger_sequence" < transaction_row."ledger_sequence"
  ORDER BY prior."ledger_sequence" DESC
  LIMIT 1;
  predecessor_balance := COALESCE(predecessor_balance, 0);
  IF transaction_row."balance_after_usd" - transaction_row."amount_usd"
    IS DISTINCT FROM predecessor_balance
  THEN
    RAISE EXCEPTION
      'balance grant expiry transaction sequence edge invalid grant=% transaction=% sequence=% expected_before=% actual_before=%',
      target_grant_id,
      transaction_row."id",
      transaction_row."ledger_sequence",
      predecessor_balance,
      transaction_row."balance_after_usd" - transaction_row."amount_usd"
      USING ERRCODE = '23514';
  END IF;

  -- wallet_balance_after_usd is the local balance immediately after this
  -- expiry. On-demand expiry legitimately continues in the same transaction
  -- with another expiry, recharge or consume, so it is not the COMMIT balance.
  -- The immutable ADJUST row proves the local before -> after edge. The
  -- highest sequenced transaction is the O(log n) authoritative final wallet
  -- tail, including any later expiry/refund row in the same transaction.
  SELECT COALESCE((
    SELECT tail."balance_after_usd"
    FROM "balance_transactions" tail
    WHERE tail."billing_account_id" = expiry_row."billing_account_id"
    ORDER BY tail."ledger_sequence" DESC
    LIMIT 1
  ), 0) INTO transaction_total;

  SELECT
    COALESCE(SUM("remaining_amount_usd") FILTER (
      WHERE NOT "is_expired"
        AND "valid_from" <= expiry_row."created_at"
    ), 0),
    COUNT(*) FILTER (
      WHERE "remaining_amount_usd" < 0
        OR "remaining_paid_amount_usd" IS NULL
        OR "remaining_bonus_amount_usd" IS NULL
        OR "remaining_paid_amount_usd" < 0
        OR "remaining_bonus_amount_usd" < 0
        OR "remaining_amount_usd"
          <> "remaining_paid_amount_usd" + "remaining_bonus_amount_usd"
        OR "paid_amount_usd" + "bonus_amount_usd" <> "granted_amount_usd"
        OR "remaining_paid_amount_usd" > "paid_amount_usd"
        OR "remaining_bonus_amount_usd" > "bonus_amount_usd"
        OR "valid_from" > expiry_row."created_at"
        OR ("is_expired" AND "remaining_amount_usd" <> 0)
    )
    INTO active_grant_amount, invalid_grant_count
  FROM "balance_grants"
  WHERE "billing_account_id" = expiry_row."billing_account_id";

  SELECT
    COALESCE(SUM("amount_usd" - "settled_usd") FILTER (
      WHERE "source" = expected_debt_source
    ), 0),
    COUNT(*) FILTER (
      WHERE "amount_usd" <= 0
        OR "settled_usd" < 0
        OR "settled_usd" > "amount_usd"
    ),
    COUNT(*) FILTER (
      WHERE "ledger_sequence" IS NULL OR "ledger_sequence" = 0
    ),
    COUNT(*) FILTER (
      WHERE "source" <> expected_debt_source
    )
    INTO
      open_debt_amount,
      invalid_debt_count,
      invalid_sequence_count,
      unexpected_debt_count
  FROM "balance_consumption_allocations"
  WHERE "billing_account_id" = expiry_row."billing_account_id"
    AND "source" IN ('NEGATIVE_BALANCE', 'ENTERPRISE_CREDIT');

  IF transaction_total IS DISTINCT FROM wallet_balance
    OR active_grant_amount IS DISTINCT FROM GREATEST(wallet_balance, 0)
    OR open_debt_amount IS DISTINCT FROM GREATEST(-wallet_balance, 0)
    OR invalid_grant_count <> 0
    OR invalid_debt_count <> 0
    OR invalid_sequence_count <> 0
    OR unexpected_debt_count <> 0
  THEN
    RAISE EXCEPTION
      'balance grant expiry ledger invariant invalid grant=% wallet=% transaction_total=% active=% debt=% invalid_grant=% invalid_debt=% invalid_sequence=% unexpected_debt=%',
      target_grant_id,
      wallet_balance,
      transaction_total,
      active_grant_amount,
      open_debt_amount,
      invalid_grant_count,
      invalid_debt_count,
      invalid_sequence_count,
      unexpected_debt_count;
  END IF;

END
$$;

CREATE OR REPLACE FUNCTION "validate_balance_grant_expiry_transition_trigger"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."is_expired" AND NOT OLD."is_expired" THEN
    PERFORM "assert_balance_grant_expiry_aggregate"(
      OLD."id",
      OLD."billing_account_id",
      OLD."remaining_amount_usd",
      OLD."remaining_paid_amount_usd",
      OLD."remaining_bonus_amount_usd",
      OLD."expires_at"
    );
  END IF;
  RETURN NEW;
END
$$;

-- The FALSE -> TRUE aggregate trigger is also contract-only. The audit-row
-- trigger below is safe in expand because only the V2 writer inserts that new
-- table; activating the grant transition trigger here would reject an old
-- inline-expiry debit halfway through a rolling cutover.

CREATE OR REPLACE FUNCTION "validate_balance_grant_expiry_audit_trigger"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  grant_expires_at TIMESTAMP(3);
BEGIN
  SELECT "expires_at" INTO grant_expires_at
  FROM "balance_grants"
  WHERE "id" = NEW."balance_grant_id";
  PERFORM "assert_balance_grant_expiry_aggregate"(
    NEW."balance_grant_id",
    NEW."billing_account_id",
    NEW."nominal_amount_usd",
    NEW."nominal_paid_usd",
    NEW."nominal_bonus_usd",
    grant_expires_at
  );
  RETURN NEW;
END
$$;

BEGIN;
DROP TRIGGER IF EXISTS "balance_grant_expiries_aggregate_deferred"
  ON "balance_grant_expiries";
CREATE CONSTRAINT TRIGGER "balance_grant_expiries_aggregate_deferred"
AFTER INSERT ON "balance_grant_expiries"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_balance_grant_expiry_audit_trigger"();
COMMIT;

CREATE OR REPLACE FUNCTION "reject_balance_grant_expiry_audit_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'balance grant expiry audit rows are append-only: %',
    OLD."id";
END
$$;

BEGIN;
DROP TRIGGER IF EXISTS "balance_grant_expiries_append_only"
  ON "balance_grant_expiries";
CREATE TRIGGER "balance_grant_expiries_append_only"
BEFORE UPDATE OR DELETE ON "balance_grant_expiries"
FOR EACH ROW
EXECUTE FUNCTION "reject_balance_grant_expiry_audit_mutation"();
COMMIT;

CREATE OR REPLACE FUNCTION "reject_balance_grant_expiry_transaction_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "balance_grant_expiries"
    WHERE "balance_transaction_id" = OLD."id"
  ) THEN
    RAISE EXCEPTION
      'balance grant expiry transaction is immutable: %',
      OLD."id";
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DROP TRIGGER IF EXISTS "balance_transactions_expiry_audit_immutable"
  ON "balance_transactions";
CREATE TRIGGER "balance_transactions_expiry_audit_immutable"
BEFORE UPDATE OR DELETE ON "balance_transactions"
FOR EACH ROW
EXECUTE FUNCTION "reject_balance_grant_expiry_transaction_mutation"();
COMMIT;

CREATE TABLE IF NOT EXISTS "balance_grant_refunds" (
  "id" TEXT PRIMARY KEY,
  "billing_account_id" TEXT NOT NULL,
  "balance_grant_id" TEXT NOT NULL,
  "refund_transaction_id" TEXT NOT NULL UNIQUE,
  "debt_allocation_id" TEXT UNIQUE,
  "operation_key" TEXT NOT NULL UNIQUE,
  "component" TEXT NOT NULL,
  "requested_amount_usd" DECIMAL(20, 12) NOT NULL,
  "target_grant_reduction_usd" DECIMAL(20, 12) NOT NULL,
  "debt_opened_usd" DECIMAL(20, 12) NOT NULL,
  "debt_netted_usd" DECIMAL(20, 12) NOT NULL,
  "open_debt_usd" DECIMAL(20, 12) NOT NULL,
  "recognized_revenue_reversal_usd" DECIMAL(20, 12) NOT NULL,
  "bonus_consumed_reversal_usd" DECIMAL(20, 12) NOT NULL,
  "occurred_at" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "balance_grant_refunds_account_fkey"
    FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "balance_grant_refunds_grant_fkey"
    FOREIGN KEY ("balance_grant_id") REFERENCES "balance_grants"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "balance_grant_refunds_transaction_fkey"
    FOREIGN KEY ("refund_transaction_id") REFERENCES "balance_transactions"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "balance_grant_refunds_debt_allocation_fkey"
    FOREIGN KEY ("debt_allocation_id") REFERENCES "balance_consumption_allocations"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "balance_grant_refunds_amounts_check" CHECK (
    "component" IN ('PAID', 'BONUS')
    AND "requested_amount_usd" > 0
    AND "target_grant_reduction_usd" >= 0
    AND "debt_opened_usd" >= 0
    AND "debt_netted_usd" >= 0
    AND "open_debt_usd" >= 0
    AND "recognized_revenue_reversal_usd" >= 0
    AND "bonus_consumed_reversal_usd" >= 0
    AND "requested_amount_usd" = "target_grant_reduction_usd" + "debt_opened_usd"
    AND "debt_opened_usd" = "debt_netted_usd" + "open_debt_usd"
    AND "debt_opened_usd" = "recognized_revenue_reversal_usd" + "bonus_consumed_reversal_usd"
    AND (("debt_opened_usd" = 0 AND "debt_allocation_id" IS NULL)
      OR ("debt_opened_usd" > 0 AND "debt_allocation_id" IS NOT NULL))
    AND (("component" = 'PAID' AND "bonus_consumed_reversal_usd" = 0)
      OR ("component" = 'BONUS' AND "recognized_revenue_reversal_usd" = 0))
  )
);

CREATE INDEX IF NOT EXISTS "balance_grant_refunds_account_occurred_idx"
  ON "balance_grant_refunds"("billing_account_id", "occurred_at");
CREATE INDEX IF NOT EXISTS "balance_grant_refunds_grant_idx"
  ON "balance_grant_refunds"("balance_grant_id");

CREATE TABLE IF NOT EXISTS "balance_grant_refund_allocations" (
  "id" TEXT PRIMARY KEY,
  "refund_id" TEXT NOT NULL,
  "balance_grant_id" TEXT NOT NULL,
  "sequence" INTEGER NOT NULL,
  "role" TEXT NOT NULL,
  "amount_usd" DECIMAL(20, 12) NOT NULL,
  "paid_reduction_usd" DECIMAL(20, 12) NOT NULL,
  "bonus_reduction_usd" DECIMAL(20, 12) NOT NULL,
  CONSTRAINT "balance_grant_refund_allocations_refund_fkey"
    FOREIGN KEY ("refund_id") REFERENCES "balance_grant_refunds"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "balance_grant_refund_allocations_grant_fkey"
    FOREIGN KEY ("balance_grant_id") REFERENCES "balance_grants"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE,
  CONSTRAINT "balance_grant_refund_allocations_amounts_check" CHECK (
    "role" IN ('TARGET_UNUSED', 'DEBT_NETTING')
    AND "sequence" > 0
    AND "amount_usd" > 0
    AND "paid_reduction_usd" >= 0
    AND "bonus_reduction_usd" >= 0
    AND "amount_usd" = "paid_reduction_usd" + "bonus_reduction_usd"
  )
);

CREATE UNIQUE INDEX IF NOT EXISTS "balance_grant_refund_allocations_refund_grant_role_key"
  ON "balance_grant_refund_allocations"("refund_id", "balance_grant_id", "role");
CREATE UNIQUE INDEX IF NOT EXISTS "balance_grant_refund_allocations_refund_sequence_key"
  ON "balance_grant_refund_allocations"("refund_id", "sequence");
CREATE INDEX IF NOT EXISTS "balance_grant_refund_allocations_grant_idx"
  ON "balance_grant_refund_allocations"("balance_grant_id");

CREATE TABLE IF NOT EXISTS "balance_ledger_repair_runs" (
  "id" TEXT PRIMARY KEY,
  "status" TEXT NOT NULL DEFAULT 'RUNNING',
  "plan_hash" TEXT NOT NULL,
  "initiated_by" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "completed_at" TIMESTAMP(3)
);

CREATE TABLE IF NOT EXISTS "balance_ledger_repair_accounts" (
  "id" TEXT PRIMARY KEY,
  "run_id" TEXT NOT NULL,
  "billing_account_id" TEXT NOT NULL,
  "status" TEXT NOT NULL,
  "precondition_hash" TEXT NOT NULL,
  "replay_hash" TEXT,
  "before_snapshot" JSONB NOT NULL,
  "after_snapshot" JSONB,
  "error" TEXT,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  "updated_at" TIMESTAMP(3) NOT NULL,
  CONSTRAINT "balance_ledger_repair_accounts_run_id_fkey"
    FOREIGN KEY ("run_id") REFERENCES "balance_ledger_repair_runs"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_repair_accounts_billing_account_id_fkey"
    FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id")
    ON DELETE RESTRICT ON UPDATE CASCADE
);

CREATE UNIQUE INDEX IF NOT EXISTS "balance_ledger_repair_accounts_run_account_key"
  ON "balance_ledger_repair_accounts"("run_id", "billing_account_id");
CREATE INDEX IF NOT EXISTS "balance_ledger_repair_accounts_account_created_idx"
  ON "balance_ledger_repair_accounts"("billing_account_id", "created_at");

-- A repair that changes historical recharge attribution must leave immutable
-- row-level evidence. before_snapshot/after_snapshot are exact to_jsonb(row)
-- images, not application-assembled summaries; the allocation guard below
-- compares them to OLD/NEW before authorizing the UPDATE.
CREATE TABLE IF NOT EXISTS "balance_ledger_allocation_repairs" (
  "id" TEXT PRIMARY KEY,
  "operation_key" TEXT NOT NULL UNIQUE,
  "run_id" TEXT NOT NULL,
  "repair_account_id" TEXT NOT NULL,
  "billing_account_id" TEXT NOT NULL,
  "allocation_id" TEXT NOT NULL,
  "before_snapshot" JSONB NOT NULL,
  "after_snapshot" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "balance_ledger_allocation_repairs_run_fkey"
    FOREIGN KEY ("run_id") REFERENCES "balance_ledger_repair_runs"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_allocation_repairs_account_run_fkey"
    FOREIGN KEY ("repair_account_id") REFERENCES "balance_ledger_repair_accounts"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_allocation_repairs_billing_account_fkey"
    FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_allocation_repairs_allocation_fkey"
    FOREIGN KEY ("allocation_id") REFERENCES "balance_consumption_allocations"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS "balance_ledger_allocation_repairs_run_allocation_key"
  ON "balance_ledger_allocation_repairs"("run_id", "allocation_id");
CREATE INDEX IF NOT EXISTS "balance_ledger_allocation_repairs_account_created_idx"
  ON "balance_ledger_allocation_repairs"("billing_account_id", "created_at");

CREATE OR REPLACE FUNCTION "validate_balance_ledger_allocation_repair_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  run_status TEXT;
  repair_status TEXT;
  repair_run_id TEXT;
  repair_billing_account_id TEXT;
  account_status TEXT;
  current_allocation JSONB;
BEGIN
  SELECT "status" INTO run_status
  FROM "balance_ledger_repair_runs"
  WHERE "id" = NEW."run_id";
  SELECT "status", "run_id", "billing_account_id"
    INTO repair_status, repair_run_id, repair_billing_account_id
  FROM "balance_ledger_repair_accounts"
  WHERE "id" = NEW."repair_account_id";
  SELECT "balance_grant_ledger_status" INTO account_status
  FROM "billing_accounts"
  WHERE "id" = NEW."billing_account_id";
  SELECT to_jsonb(allocation) INTO current_allocation
  FROM "balance_consumption_allocations" allocation
  WHERE allocation."id" = NEW."allocation_id"
    AND allocation."billing_account_id" = NEW."billing_account_id";

  IF run_status IS DISTINCT FROM 'RUNNING'
    OR repair_status IS DISTINCT FROM 'RUNNING'
    OR repair_run_id IS DISTINCT FROM NEW."run_id"
    OR repair_billing_account_id IS DISTINCT FROM NEW."billing_account_id"
    OR account_status IS DISTINCT FROM 'LEGACY_DIRTY'
    OR current_allocation IS NULL
    OR NEW."before_snapshot" IS DISTINCT FROM current_allocation
    OR NEW."operation_key" IS DISTINCT FROM (
      'repair:allocation:' || NEW."run_id" || ':' || NEW."allocation_id"
    )
    OR NEW."before_snapshot"->>'id' IS DISTINCT FROM NEW."allocation_id"
    OR NEW."after_snapshot"->>'id' IS DISTINCT FROM NEW."allocation_id"
    OR NEW."before_snapshot"->>'billing_account_id'
      IS DISTINCT FROM NEW."billing_account_id"
    OR NEW."after_snapshot"->>'billing_account_id'
      IS DISTINCT FROM NEW."billing_account_id"
  THEN
    RAISE EXCEPTION
      'balance allocation repair audit is not authorized run=% account=% allocation=%',
      NEW."run_id",
      NEW."billing_account_id",
      NEW."allocation_id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

BEGIN;
DROP TRIGGER IF EXISTS "balance_ledger_allocation_repairs_insert_guard"
  ON "balance_ledger_allocation_repairs";
CREATE TRIGGER "balance_ledger_allocation_repairs_insert_guard"
BEFORE INSERT ON "balance_ledger_allocation_repairs"
FOR EACH ROW
EXECUTE FUNCTION "validate_balance_ledger_allocation_repair_insert"();
COMMIT;

CREATE OR REPLACE FUNCTION "reject_balance_ledger_allocation_repair_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'balance allocation repair audit rows are append-only: %',
    OLD."id";
END
$$;

BEGIN;
DROP TRIGGER IF EXISTS "balance_ledger_allocation_repairs_append_only"
  ON "balance_ledger_allocation_repairs";
CREATE TRIGGER "balance_ledger_allocation_repairs_append_only"
BEFORE UPDATE OR DELETE ON "balance_ledger_allocation_repairs"
FOR EACH ROW
EXECUTE FUNCTION "reject_balance_ledger_allocation_repair_mutation"();
COMMIT;

-- Historical transaction ordering is a financial fact.  Repair may only fill
-- a legacy NULL sequence after the wallet path has been proved, and must leave
-- the database-native OLD/NEW row images as immutable evidence.
CREATE TABLE IF NOT EXISTS "balance_ledger_transaction_repairs" (
  "id" TEXT PRIMARY KEY,
  "operation_key" TEXT NOT NULL UNIQUE,
  "run_id" TEXT NOT NULL,
  "repair_account_id" TEXT NOT NULL,
  "billing_account_id" TEXT NOT NULL,
  "transaction_id" TEXT NOT NULL,
  "before_snapshot" JSONB NOT NULL,
  "after_snapshot" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "balance_ledger_transaction_repairs_run_fkey"
    FOREIGN KEY ("run_id") REFERENCES "balance_ledger_repair_runs"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_transaction_repairs_account_run_fkey"
    FOREIGN KEY ("repair_account_id") REFERENCES "balance_ledger_repair_accounts"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_transaction_repairs_billing_account_fkey"
    FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_transaction_repairs_transaction_fkey"
    FOREIGN KEY ("transaction_id") REFERENCES "balance_transactions"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX IF NOT EXISTS "balance_ledger_transaction_repairs_run_transaction_key"
  ON "balance_ledger_transaction_repairs"("run_id", "transaction_id");
CREATE INDEX IF NOT EXISTS "balance_ledger_transaction_repairs_account_created_idx"
  ON "balance_ledger_transaction_repairs"("billing_account_id", "created_at");

CREATE OR REPLACE FUNCTION "validate_balance_ledger_transaction_repair_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  run_status TEXT;
  repair_status TEXT;
  repair_run_id TEXT;
  repair_billing_account_id TEXT;
  account_status TEXT;
  current_transaction JSONB;
  target_sequence_text TEXT;
BEGIN
  SELECT "status" INTO run_status
  FROM "balance_ledger_repair_runs"
  WHERE "id" = NEW."run_id";
  SELECT "status", "run_id", "billing_account_id"
    INTO repair_status, repair_run_id, repair_billing_account_id
  FROM "balance_ledger_repair_accounts"
  WHERE "id" = NEW."repair_account_id";
  SELECT "balance_grant_ledger_status" INTO account_status
  FROM "billing_accounts"
  WHERE "id" = NEW."billing_account_id";
  SELECT to_jsonb(balance_transaction) INTO current_transaction
  FROM "balance_transactions" balance_transaction
  WHERE balance_transaction."id" = NEW."transaction_id"
    AND balance_transaction."billing_account_id" = NEW."billing_account_id";
  target_sequence_text := NEW."after_snapshot"->>'ledger_sequence';

  IF run_status IS DISTINCT FROM 'RUNNING'
    OR repair_status IS DISTINCT FROM 'RUNNING'
    OR repair_run_id IS DISTINCT FROM NEW."run_id"
    OR repair_billing_account_id IS DISTINCT FROM NEW."billing_account_id"
    OR account_status IS DISTINCT FROM 'LEGACY_DIRTY'
    OR current_transaction IS NULL
    OR NEW."before_snapshot" IS DISTINCT FROM current_transaction
    OR NEW."operation_key" IS DISTINCT FROM (
      'repair:transaction-sequence:' || NEW."run_id" || ':' || NEW."transaction_id"
    )
    OR NEW."before_snapshot"->>'id' IS DISTINCT FROM NEW."transaction_id"
    OR NEW."after_snapshot"->>'id' IS DISTINCT FROM NEW."transaction_id"
    OR NEW."before_snapshot"->>'billing_account_id'
      IS DISTINCT FROM NEW."billing_account_id"
    OR NEW."after_snapshot"->>'billing_account_id'
      IS DISTINCT FROM NEW."billing_account_id"
    OR NEW."before_snapshot"->'ledger_sequence' <> 'null'::JSONB
    OR target_sequence_text IS NULL
    OR target_sequence_text !~ '^-[0-9]+$'
    OR target_sequence_text = '-0'
    OR (NEW."before_snapshot" - 'ledger_sequence')
      IS DISTINCT FROM (NEW."after_snapshot" - 'ledger_sequence')
  THEN
    RAISE EXCEPTION
      'balance transaction sequence repair audit is not authorized run=% account=% transaction=%',
      NEW."run_id",
      NEW."billing_account_id",
      NEW."transaction_id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

BEGIN;
DROP TRIGGER IF EXISTS "balance_ledger_transaction_repairs_insert_guard"
  ON "balance_ledger_transaction_repairs";
CREATE TRIGGER "balance_ledger_transaction_repairs_insert_guard"
BEFORE INSERT ON "balance_ledger_transaction_repairs"
FOR EACH ROW
EXECUTE FUNCTION "validate_balance_ledger_transaction_repair_insert"();
COMMIT;

CREATE OR REPLACE FUNCTION "reject_balance_ledger_transaction_repair_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION
    'balance transaction repair audit rows are append-only: %',
    OLD."id"
    USING ERRCODE = '23514';
END
$$;

BEGIN;
DROP TRIGGER IF EXISTS "balance_ledger_transaction_repairs_append_only"
  ON "balance_ledger_transaction_repairs";
CREATE TRIGGER "balance_ledger_transaction_repairs_append_only"
BEFORE UPDATE OR DELETE ON "balance_ledger_transaction_repairs"
FOR EACH ROW
EXECUTE FUNCTION "reject_balance_ledger_transaction_repair_mutation"();
COMMIT;

-- Old application writers constructed valid_from in Node immediately after
-- PostgreSQL had created the funding transaction/grant rows.  Their durable
-- shape can therefore be valid_from > created_at by a few milliseconds.  Do
-- not turn that historical shape into an online exception: it is admissible
-- only when the funding transaction itself was changed from NULL to a
-- negative legacy ledger sequence under an immutable, terminal account-level
-- repair proof.  Both upper bounds below are database-owned repair times, so
-- a grant cannot use this path to become effective in the future.
CREATE OR REPLACE FUNCTION "balance_legacy_grant_valid_from_is_repair_proven"(
  target_funding_id TEXT,
  target_valid_from TIMESTAMP(3)
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "balance_transactions" funding
    JOIN "balance_ledger_transaction_repairs" transaction_repair
      ON transaction_repair."transaction_id" = funding."id"
      AND transaction_repair."billing_account_id" = funding."billing_account_id"
    JOIN "balance_ledger_repair_accounts" repair_account
      ON repair_account."id" = transaction_repair."repair_account_id"
      AND repair_account."run_id" = transaction_repair."run_id"
      AND repair_account."billing_account_id" = funding."billing_account_id"
    JOIN "balance_ledger_repair_runs" repair_run
      ON repair_run."id" = repair_account."run_id"
    WHERE funding."id" = target_funding_id
      AND funding."ledger_sequence" < 0
      AND repair_account."status" = 'APPLIED'
      AND repair_account."after_snapshot" IS NOT NULL
      AND repair_run."status" IN (
        'RUNNING',
        'COMPLETED',
        'COMPLETED_WITH_EXCEPTIONS'
      )
      AND transaction_repair."operation_key" = (
        'repair:transaction-sequence:'
        || transaction_repair."run_id"
        || ':'
        || funding."id"
      )
      AND transaction_repair."before_snapshot"->'ledger_sequence' = 'null'::JSONB
      AND (transaction_repair."after_snapshot"->>'ledger_sequence')::BIGINT
        = funding."ledger_sequence"
      AND (transaction_repair."before_snapshot" - 'ledger_sequence')
        = (transaction_repair."after_snapshot" - 'ledger_sequence')
      AND transaction_repair."after_snapshot" = to_jsonb(funding)
      AND target_valid_from <= repair_account."created_at"
      AND target_valid_from <= transaction_repair."created_at"
      AND EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(
          repair_account."after_snapshot"->'transactionSequenceMutations',
          '[]'::JSONB
        )) mutation
        WHERE mutation->>'transactionId' = funding."id"
          AND mutation->>'expectedLedgerSequence' IS NULL
          AND (mutation->>'ledgerSequence')::BIGINT = funding."ledger_sequence"
      )
  )
$$;

CREATE OR REPLACE FUNCTION "guard_balance_consumption_allocation_financial_rewrite"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  active_run_id TEXT;
  repair_row RECORD;
  audit_row RECORD;
  protected_rewrite BOOLEAN;
  exact_repair_authorized BOOLEAN := FALSE;
BEGIN
  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."user_id" IS DISTINCT FROM OLD."user_id"
    OR NEW."tenant_id" IS DISTINCT FROM OLD."tenant_id"
    OR NEW."billing_account_id" IS DISTINCT FROM OLD."billing_account_id"
    OR NEW."product_id" IS DISTINCT FROM OLD."product_id"
    OR NEW."balance_transaction_id" IS DISTINCT FROM OLD."balance_transaction_id"
    OR NEW."token_usage_id" IS DISTINCT FROM OLD."token_usage_id"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
  THEN
    RAISE EXCEPTION 'balance allocation immutable identity changed: %', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  protected_rewrite :=
    NEW."source" IS DISTINCT FROM OLD."source"
    OR NEW."balance_grant_id" IS DISTINCT FROM OLD."balance_grant_id"
    OR NEW."amount_usd" IS DISTINCT FROM OLD."amount_usd"
    OR NEW."ledger_sequence" IS DISTINCT FROM OLD."ledger_sequence"
    OR NEW."recognized_revenue_usd" IS DISTINCT FROM OLD."recognized_revenue_usd"
    OR NEW."bonus_consumed_usd" IS DISTINCT FROM OLD."bonus_consumed_usd"
    OR NEW."discount_rate" IS DISTINCT FROM OLD."discount_rate"
    OR NEW."settled_usd" IS DISTINCT FROM OLD."settled_usd"
    OR NEW."settled_at" IS DISTINCT FROM OLD."settled_at";
  IF NOT protected_rewrite THEN
    RETURN NEW;
  END IF;

  active_run_id := current_setting('billing.balance_ledger_repair_run_id', TRUE);
  SELECT ra.*, r."status" AS run_status
    INTO repair_row
  FROM "balance_ledger_repair_accounts" ra
  JOIN "balance_ledger_repair_runs" r ON r."id" = ra."run_id"
  JOIN "billing_accounts" ba ON ba."id" = ra."billing_account_id"
  WHERE ra."run_id" = active_run_id
    AND ra."billing_account_id" = OLD."billing_account_id"
    AND ra."status" = 'RUNNING'
    AND r."status" = 'RUNNING'
    AND ba."balance_grant_ledger_status" = 'LEGACY_DIRTY';

  SELECT * INTO audit_row
  FROM "balance_ledger_allocation_repairs"
  WHERE "run_id" = active_run_id
    AND "billing_account_id" = OLD."billing_account_id"
    AND "allocation_id" = OLD."id";

  exact_repair_authorized := active_run_id IS NOT NULL
    AND repair_row."id" IS NOT NULL
    AND audit_row."id" IS NOT NULL
    AND audit_row."repair_account_id" IS NOT DISTINCT FROM repair_row."id"
    AND audit_row."before_snapshot" IS NOT DISTINCT FROM to_jsonb(OLD)
    AND audit_row."after_snapshot" IS NOT DISTINCT FROM to_jsonb(NEW);
  IF exact_repair_authorized THEN
    RETURN NEW;
  END IF;

  -- Online debt settlement updates precede their settlement INSERT in the
  -- current writer.  Permit only a monotone component settlement here; the
  -- deferred cross-table triggers below require immutable settlement rows to
  -- explain the complete final values before COMMIT.
  IF OLD."source" IN ('NEGATIVE_BALANCE', 'ENTERPRISE_CREDIT')
    AND NEW."source" IS NOT DISTINCT FROM OLD."source"
    AND NEW."balance_grant_id" IS NOT DISTINCT FROM OLD."balance_grant_id"
    AND NEW."amount_usd" IS NOT DISTINCT FROM OLD."amount_usd"
    AND NEW."discount_rate" IS NOT DISTINCT FROM OLD."discount_rate"
    AND NEW."ledger_sequence" IS NOT DISTINCT FROM OLD."ledger_sequence"
    AND NEW."recognized_revenue_usd" >= OLD."recognized_revenue_usd"
    AND NEW."bonus_consumed_usd" >= OLD."bonus_consumed_usd"
    AND NEW."settled_usd" >= OLD."settled_usd"
    AND NEW."recognized_revenue_usd" + NEW."bonus_consumed_usd" = NEW."settled_usd"
    AND NEW."settled_usd" <= NEW."amount_usd"
    AND (
      (NEW."settled_usd" = NEW."amount_usd" AND NEW."settled_at" IS NOT NULL)
      OR (NEW."settled_usd" < NEW."amount_usd" AND NEW."settled_at" IS NULL)
    )
  THEN
    RETURN NEW;
  END IF;

  RAISE EXCEPTION
    'balance allocation financial rewrite lacks exact repair audit or settlement facts: %',
    OLD."id"
    USING ERRCODE = '23514';
  RETURN NEW;
END
$$;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DROP TRIGGER IF EXISTS "balance_consumption_allocations_financial_rewrite_guard"
  ON "balance_consumption_allocations";
CREATE TRIGGER "balance_consumption_allocations_financial_rewrite_guard"
BEFORE UPDATE ON "balance_consumption_allocations"
FOR EACH ROW
EXECUTE FUNCTION "guard_balance_consumption_allocation_financial_rewrite"();
COMMIT;

CREATE OR REPLACE FUNCTION "assert_balance_debt_allocation_settlement_conservation"(
  target_allocation_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  allocation_row RECORD;
  settlement_amount NUMERIC;
  settlement_paid NUMERIC;
  settlement_bonus NUMERIC;
  invalid_settlement_count BIGINT;
BEGIN
  SELECT * INTO allocation_row
  FROM "balance_consumption_allocations"
  WHERE "id" = target_allocation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'debt settlement references missing allocation: %', target_allocation_id
      USING ERRCODE = '23514';
  END IF;
  IF allocation_row."source" NOT IN ('NEGATIVE_BALANCE', 'ENTERPRISE_CREDIT') THEN
    IF EXISTS (
      SELECT 1 FROM "enterprise_credit_settlements"
      WHERE "allocation_id" = target_allocation_id
    ) THEN
      RAISE EXCEPTION 'settlement references non-debt allocation: %', target_allocation_id
        USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;

  SELECT
    COALESCE(SUM(s."amount_usd"), 0),
    COALESCE(SUM(s."paid_usd"), 0),
    COALESCE(SUM(s."bonus_usd"), 0),
    COUNT(*) FILTER (
      WHERE s."billing_account_id" IS DISTINCT FROM allocation_row."billing_account_id"
        OR s."debt_source" IS DISTINCT FROM allocation_row."source"
        OR s."amount_usd" <= 0
        OR s."paid_usd" < 0
        OR s."bonus_usd" < 0
        OR s."amount_usd" <> s."paid_usd" + s."bonus_usd"
        OR (
          s."repayment_transaction_id" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM "balance_transactions" bt
            WHERE bt."id" = s."repayment_transaction_id"
              AND bt."billing_account_id" = allocation_row."billing_account_id"
              AND bt."created_at" = s."occurred_at"
          )
        )
        OR (
          s."balance_grant_id" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM "balance_grants" bg
            WHERE bg."id" = s."balance_grant_id"
              AND bg."billing_account_id" = allocation_row."billing_account_id"
          )
        )
        OR CASE s."trigger"
          WHEN 'FUNDING' THEN
            s."repair_run_id" IS NOT NULL
            OR s."repayment_transaction_id" IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM "balance_transactions" bt
              WHERE bt."id" = s."repayment_transaction_id"
                AND bt."type"::TEXT IN ('RECHARGE', 'ADJUST')
                AND bt."amount_usd" > 0
            )
          WHEN 'REPAIR' THEN
            s."repair_run_id" IS NULL
            OR s."repayment_transaction_id" IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM "balance_ledger_repair_runs" repair_run
              WHERE repair_run."id" = s."repair_run_id"
            )
            OR NOT EXISTS (
              SELECT 1 FROM "balance_transactions" bt
              WHERE bt."id" = s."repayment_transaction_id"
                AND bt."type"::TEXT IN ('RECHARGE', 'ADJUST')
                AND bt."amount_usd" > 0
            )
          WHEN 'REFUND_NETTING' THEN
            s."repair_run_id" IS NOT NULL
            OR s."repayment_transaction_id" IS NULL
            OR s."balance_grant_id" IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM "balance_transactions" bt
              WHERE bt."id" = s."repayment_transaction_id"
                AND bt."type"::TEXT = 'REFUND'
                AND bt."amount_usd" < 0
            )
          WHEN 'SWEEP' THEN
            s."repair_run_id" IS NOT NULL
            OR s."repayment_transaction_id" IS NOT NULL
            OR s."balance_grant_id" IS NOT NULL
            OR s."debt_source" <> 'ENTERPRISE_CREDIT'
          ELSE TRUE
        END
    )
  INTO settlement_amount, settlement_paid, settlement_bonus, invalid_settlement_count
  FROM "enterprise_credit_settlements" s
  WHERE s."allocation_id" = target_allocation_id;

  IF allocation_row."amount_usd" <= 0
    OR allocation_row."balance_grant_id" IS NOT NULL
    OR allocation_row."discount_rate" <> 0
    OR allocation_row."settled_usd" < 0
    OR allocation_row."settled_usd" > allocation_row."amount_usd"
    OR allocation_row."recognized_revenue_usd" < 0
    OR allocation_row."bonus_consumed_usd" < 0
    OR allocation_row."recognized_revenue_usd"
      + allocation_row."bonus_consumed_usd" <> allocation_row."settled_usd"
    OR (allocation_row."settled_usd" = allocation_row."amount_usd")
      IS DISTINCT FROM (allocation_row."settled_at" IS NOT NULL)
    OR settlement_amount IS DISTINCT FROM allocation_row."settled_usd"
    OR settlement_paid IS DISTINCT FROM allocation_row."recognized_revenue_usd"
    OR settlement_bonus IS DISTINCT FROM allocation_row."bonus_consumed_usd"
    OR invalid_settlement_count <> 0
  THEN
    RAISE EXCEPTION
      'debt allocation settlement conservation invalid allocation=% settled=%/% paid=%/% bonus=%/% invalid=%',
      target_allocation_id,
      allocation_row."settled_usd", settlement_amount,
      allocation_row."recognized_revenue_usd", settlement_paid,
      allocation_row."bonus_consumed_usd", settlement_bonus,
      invalid_settlement_count
      USING ERRCODE = '23514';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION "validate_balance_debt_allocation_settlement_trigger"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM "assert_balance_debt_allocation_settlement_conservation"(
    CASE WHEN TG_OP = 'DELETE' THEN OLD."id" ELSE NEW."id" END
  );
  RETURN CASE WHEN TG_OP = 'DELETE' THEN OLD ELSE NEW END;
END
$$;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DROP TRIGGER IF EXISTS "balance_debt_allocations_settlement_conservation_deferred"
  ON "balance_consumption_allocations";
CREATE CONSTRAINT TRIGGER "balance_debt_allocations_settlement_conservation_deferred"
AFTER INSERT OR UPDATE ON "balance_consumption_allocations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_balance_debt_allocation_settlement_trigger"();
COMMIT;

CREATE OR REPLACE FUNCTION "validate_balance_settlement_allocation_trigger"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  PERFORM "assert_balance_debt_allocation_settlement_conservation"(NEW."allocation_id");
  RETURN NEW;
END
$$;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DROP TRIGGER IF EXISTS "enterprise_settlements_allocation_conservation_deferred"
  ON "enterprise_credit_settlements";
CREATE CONSTRAINT TRIGGER "enterprise_settlements_allocation_conservation_deferred"
AFTER INSERT ON "enterprise_credit_settlements"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_balance_settlement_allocation_trigger"();
COMMIT;

CREATE OR REPLACE FUNCTION "guard_balance_ledger_repair_run_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."plan_hash" IS DISTINCT FROM OLD."plan_hash"
    OR NEW."initiated_by" IS DISTINCT FROM OLD."initiated_by"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR OLD."status" IS DISTINCT FROM 'RUNNING'
    OR NEW."status" NOT IN ('COMPLETED', 'COMPLETED_WITH_EXCEPTIONS')
    OR NEW."completed_at" IS NULL
  THEN
    RAISE EXCEPTION 'balance ledger repair run is immutable/terminal: %', OLD."id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

BEGIN;
DROP TRIGGER IF EXISTS "balance_ledger_repair_runs_immutable"
  ON "balance_ledger_repair_runs";
CREATE TRIGGER "balance_ledger_repair_runs_immutable"
BEFORE UPDATE OR DELETE ON "balance_ledger_repair_runs"
FOR EACH ROW
EXECUTE FUNCTION "guard_balance_ledger_repair_run_mutation"();
COMMIT;

CREATE OR REPLACE FUNCTION "guard_balance_ledger_repair_account_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'DELETE'
    OR NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."run_id" IS DISTINCT FROM OLD."run_id"
    OR NEW."billing_account_id" IS DISTINCT FROM OLD."billing_account_id"
    OR NEW."precondition_hash" IS DISTINCT FROM OLD."precondition_hash"
    OR NEW."replay_hash" IS DISTINCT FROM OLD."replay_hash"
    OR NEW."before_snapshot" IS DISTINCT FROM OLD."before_snapshot"
    OR NEW."created_at" IS DISTINCT FROM OLD."created_at"
    OR OLD."status" IS DISTINCT FROM 'RUNNING'
    OR NEW."status" IS DISTINCT FROM 'APPLIED'
    OR NEW."after_snapshot" IS NULL
    OR NEW."error" IS NOT NULL
  THEN
    RAISE EXCEPTION 'balance ledger repair account is immutable/terminal: %', OLD."id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

BEGIN;
DROP TRIGGER IF EXISTS "balance_ledger_repair_accounts_immutable"
  ON "balance_ledger_repair_accounts";
CREATE TRIGGER "balance_ledger_repair_accounts_immutable"
BEFORE UPDATE OR DELETE ON "balance_ledger_repair_accounts"
FOR EACH ROW
EXECUTE FUNCTION "guard_balance_ledger_repair_account_mutation"();
COMMIT;

-- Physical two-release gate. These operational tables are intentionally owned
-- by SQL rather than application writes. The singleton is inserted only at the
-- very end of this expand migration, so a partially applied expand can never
-- advertise itself as ready for cutover.
CREATE TABLE IF NOT EXISTS "balance_ledger_rollout_control" (
  "id" SMALLINT PRIMARY KEY,
  "phase" TEXT NOT NULL,
  "database_name" TEXT NOT NULL,
  "database_identity" UUID NOT NULL,
  "database_system_identifier" NUMERIC(20, 0) NOT NULL,
  "database_oid" OID NOT NULL,
  "expanded_at" TIMESTAMP(3) NOT NULL,
  "opening_grant_count_at_expand" BIGINT NOT NULL,
  "cutover_ready_at" TIMESTAMP(3),
  "v2_contract_at" TIMESTAMP(3),
  "operator" TEXT,
  "change_ticket" TEXT,
  "evidence_sha256" TEXT,
  "expiry_safe_through" TIMESTAMP(3),
  CONSTRAINT "balance_ledger_rollout_control_singleton_check"
    CHECK ("id" = 1),
  CONSTRAINT "balance_ledger_rollout_control_phase_check"
    CHECK (
      (
        "phase" = 'EXPANDED'
        AND "cutover_ready_at" IS NULL
        AND "v2_contract_at" IS NULL
        AND "operator" IS NULL
        AND "change_ticket" IS NULL
        AND "evidence_sha256" IS NULL
        AND "expiry_safe_through" IS NULL
      )
      OR (
        "phase" = 'CUTOVER_READY'
        AND "cutover_ready_at" IS NOT NULL
        AND "v2_contract_at" IS NULL
        AND "operator" IS NOT NULL
        AND "change_ticket" IS NOT NULL
        AND "evidence_sha256" IS NOT NULL
        AND "expiry_safe_through" IS NOT NULL
      )
      OR (
        "phase" = 'V2_CONTRACT'
        AND "cutover_ready_at" IS NOT NULL
        AND "v2_contract_at" IS NOT NULL
        AND "operator" IS NOT NULL
        AND "change_ticket" IS NOT NULL
        AND "evidence_sha256" IS NOT NULL
        AND "expiry_safe_through" IS NOT NULL
      )
    )
);

CREATE TABLE IF NOT EXISTS "balance_ledger_rollout_transitions" (
  "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "from_phase" TEXT NOT NULL,
  "to_phase" TEXT NOT NULL,
  "database_name" TEXT NOT NULL,
  "database_identity" UUID NOT NULL,
  "database_system_identifier" NUMERIC(20, 0) NOT NULL,
  "database_oid" OID NOT NULL,
  "operator" TEXT NOT NULL,
  "change_ticket" TEXT NOT NULL,
  "evidence_sha256" TEXT NOT NULL,
  "expiry_safe_through" TIMESTAMP(3) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP
);

-- Preparation is an expiring proof. A failed/delayed Release B must be able
-- to run the complete gates again and append another CUTOVER_READY audit
-- instead of becoming permanently stuck behind an expired horizon. The
-- identity primary key plus compare-and-swap control update already prevents
-- duplicate state changes; transition history is deliberately append-only,
-- not unique by phase pair.
ALTER TABLE "balance_ledger_rollout_transitions"
  DROP CONSTRAINT IF EXISTS "balance_ledger_rollout_transition_once_key";

-- A database name is an operator label, not an identity. The random UUID is
-- the plan/apply binding token; system_identifier + database OID make logical
-- clones/restores fail closed automatically. Physical clones copy all three,
-- so their first operational step must rotate the UUID through the audited
-- function below before any repair plan is produced or applied.
CREATE TABLE IF NOT EXISTS "balance_ledger_database_identity_rotations" (
  "id" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
  "database_name" TEXT NOT NULL,
  "old_database_identity" UUID NOT NULL,
  "new_database_identity" UUID NOT NULL UNIQUE,
  "old_system_identifier" NUMERIC(20, 0) NOT NULL,
  "new_system_identifier" NUMERIC(20, 0) NOT NULL,
  "old_database_oid" OID NOT NULL,
  "new_database_oid" OID NOT NULL,
  "operator" TEXT NOT NULL,
  "change_ticket" TEXT NOT NULL,
  "evidence_sha256" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "balance_ledger_database_identity_rotation_shape_check" CHECK (
    "old_database_identity" <> "new_database_identity"
    AND "operator" <> ''
    AND "change_ticket" <> ''
    AND "evidence_sha256" ~ '^[0-9a-f]{64}$'
    AND "evidence_sha256" <> repeat('0', 64)
  )
);

-- Release A must not create or promote a clean account before the strict
-- contract triggers are atomically installed. The helper reads durable DB
-- state, so rerunning expand SQL cannot reopen a completed contract.
CREATE OR REPLACE FUNCTION "balance_ledger_v2_contract_enabled"()
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE((
    SELECT "phase" = 'V2_CONTRACT'
    FROM "balance_ledger_rollout_control"
    WHERE "id" = 1
  ), FALSE)
$$;

-- Every repair dry-run/apply transaction calls this helper before reading or
-- mutating an account. The shared row lock makes an audited identity rotation
-- wait until that transaction ends, closing the identity-check/apply TOCTOU.
CREATE OR REPLACE FUNCTION "assert_balance_ledger_database_identity"(
  expected_database_name TEXT,
  expected_database_identity UUID,
  require_v2_contract BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  control_row "balance_ledger_rollout_control"%ROWTYPE;
  current_system_identifier NUMERIC(20, 0);
  current_database_oid OID;
BEGIN
  SELECT "system_identifier"::NUMERIC(20, 0)
    INTO current_system_identifier
  FROM pg_control_system();
  SELECT oid INTO current_database_oid
  FROM pg_database
  WHERE datname = current_database();

  SELECT * INTO control_row
  FROM "balance_ledger_rollout_control"
  WHERE "id" = 1
  FOR SHARE;

  IF NOT FOUND
    OR expected_database_name IS NULL
    OR btrim(expected_database_name) = ''
    OR expected_database_identity IS NULL
    OR expected_database_name IS DISTINCT FROM current_database()
    OR control_row."database_name" IS DISTINCT FROM current_database()
    OR control_row."database_identity"
      IS DISTINCT FROM expected_database_identity
    OR control_row."database_system_identifier"
      IS DISTINCT FROM current_system_identifier
    OR control_row."database_oid" IS DISTINCT FROM current_database_oid
    OR (require_v2_contract AND control_row."phase" <> 'V2_CONTRACT')
  THEN
    RAISE EXCEPTION
      'balance ledger database identity mismatch expected_name=% actual_name=% expected_identity=% actual_identity=% stored_locator=%/% current_locator=%/% phase=% require_contract=%',
      COALESCE(expected_database_name, 'NULL'),
      current_database(),
      COALESCE(expected_database_identity::TEXT, 'NULL'),
      COALESCE(control_row."database_identity"::TEXT, 'NULL'),
      COALESCE(control_row."database_system_identifier"::TEXT, 'NULL'),
      COALESCE(control_row."database_oid"::TEXT, 'NULL'),
      COALESCE(current_system_identifier::TEXT, 'NULL'),
      COALESCE(current_database_oid::TEXT, 'NULL'),
      COALESCE(control_row."phase", 'MISSING'),
      require_v2_contract
      USING ERRCODE = '23514';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION "authorize_balance_ledger_clean_promotion"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  active_run_id TEXT;
  repair_row RECORD;
BEGIN
  IF NEW."balance_grant_ledger_status" = 'RECONCILED_V2'
    AND NOT "balance_ledger_v2_contract_enabled"()
  THEN
    RAISE EXCEPTION
      'balance ledger V2 contract is not active: %',
      NEW."id"
      USING ERRCODE = '23514';
  END IF;

  IF TG_OP = 'INSERT' THEN
    -- EMPTY_V2 starts a new financial clock epoch.  Its floor must be owned by
    -- PostgreSQL, not by an application host whose wall clock may be skewed.
    IF NEW."balance_grant_ledger_status" = 'RECONCILED_V2' THEN
      NEW."balance_grant_ledger_reconciled_at" :=
        clock_timestamp()::TIMESTAMP(3);
    END IF;
    IF NEW."balance_grant_ledger_status" = 'RECONCILED_V2' AND (
      NEW."balance_grant_ledger_version" IS DISTINCT FROM 2
      OR NEW."balance_grant_ledger_hash" IS DISTINCT FROM 'EMPTY_V2'
      OR NEW."balance_grant_ledger_reconciled_at" IS NULL
      OR NEW."balance_grant_ledger_dirty_reason" IS NOT NULL
      OR NEW."balance_grant_ledger_through_transaction_id" IS NOT NULL
    ) THEN
      RAISE EXCEPTION 'new CLEAN balance ledger must use the empty V2 proof: %', NEW."id"
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF OLD."balance_grant_ledger_status" = 'RECONCILED_V2' THEN
    IF NEW."balance_grant_ledger_status" = 'RECONCILED_V2' AND (
      NEW."balance_grant_ledger_version" IS DISTINCT FROM OLD."balance_grant_ledger_version"
      OR NEW."balance_grant_ledger_hash" IS DISTINCT FROM OLD."balance_grant_ledger_hash"
      OR NEW."balance_grant_ledger_reconciled_at"
        IS DISTINCT FROM OLD."balance_grant_ledger_reconciled_at"
      OR NEW."balance_grant_ledger_through_transaction_id"
        IS DISTINCT FROM OLD."balance_grant_ledger_through_transaction_id"
    ) THEN
      RAISE EXCEPTION 'reconciled balance ledger proof is immutable: %', OLD."id"
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  IF NEW."balance_grant_ledger_status" <> 'RECONCILED_V2' THEN
    RETURN NEW;
  END IF;

  active_run_id := current_setting('billing.balance_ledger_repair_run_id', TRUE);
  SELECT ra.*, r."status" AS run_status
    INTO repair_row
  FROM "balance_ledger_repair_accounts" ra
  JOIN "balance_ledger_repair_runs" r ON r."id" = ra."run_id"
  WHERE ra."run_id" = active_run_id
    AND ra."billing_account_id" = NEW."id";
  IF active_run_id IS NULL
    OR repair_row."id" IS NULL
    OR repair_row."status" IS DISTINCT FROM 'RUNNING'
    OR repair_row.run_status IS DISTINCT FROM 'RUNNING'
    OR repair_row."replay_hash" IS DISTINCT FROM NEW."balance_grant_ledger_hash"
  THEN
    RAISE EXCEPTION 'balance ledger CLEAN promotion lacks RUNNING repair proof: %', NEW."id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DROP TRIGGER IF EXISTS "billing_accounts_clean_promotion_guard"
  ON "billing_accounts";
CREATE TRIGGER "billing_accounts_clean_promotion_guard"
BEFORE INSERT OR UPDATE ON "billing_accounts"
FOR EACH ROW
EXECUTE FUNCTION "authorize_balance_ledger_clean_promotion"();
COMMIT;

-- Account creation and wallet creation are separate idempotent operations in
-- some provisioning paths. A temporarily wallet-less EMPTY_V2 account is
-- therefore valid, but its first wallet row cannot smuggle a non-zero balance
-- around the clean-account proof trigger.
CREATE OR REPLACE FUNCTION "guard_clean_account_initial_wallet"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  account_status TEXT;
  account_hash TEXT;
BEGIN
  SELECT "balance_grant_ledger_status", "balance_grant_ledger_hash"
    INTO account_status, account_hash
  FROM "billing_accounts"
  WHERE "id" = NEW."billing_account_id";
  IF account_status = 'RECONCILED_V2'
    AND account_hash = 'EMPTY_V2'
    AND NEW."balance_usd" <> 0
  THEN
    RAISE EXCEPTION 'initial wallet for EMPTY_V2 account must be zero: %', NEW."billing_account_id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DROP TRIGGER IF EXISTS "account_wallets_clean_initial_balance_guard"
  ON "account_wallets";
CREATE TRIGGER "account_wallets_clean_initial_balance_guard"
BEFORE INSERT ON "account_wallets"
FOR EACH ROW
EXECUTE FUNCTION "guard_clean_account_initial_wallet"();
COMMIT;

-- Produce the complete set of immutable funding classifiers for an account.
-- Callers deliberately count the rows instead of selecting the first one: a
-- positive transaction with zero or multiple candidates is contradictory
-- evidence and must never be used to mint or settle a batch.
-- Funding classification uses only persisted grant/transaction timestamps;
-- it must not change when the host wall clock moves forwards or backwards.
CREATE OR REPLACE FUNCTION "balance_funding_candidates"(
  target_account_id TEXT,
  target_account_type TEXT
)
RETURNS TABLE(funding_id TEXT, grant_id TEXT, nature TEXT)
LANGUAGE sql
STABLE
AS $$
  WITH positive_funding AS (
    SELECT funding.*
    FROM "balance_transactions" funding
    WHERE funding."billing_account_id" = target_account_id
      AND funding."amount_usd" > 0
  )
  SELECT funding."id", NULL::TEXT, 'PAID'::TEXT
  FROM positive_funding funding
  WHERE target_account_type = 'enterprise'
    AND funding."type"::TEXT = 'ADJUST'
    AND funding."operation_key"
      ~ '^balance:admin-adjust:enterprise-paid-debt:[^[:space:]]+$'

  UNION ALL

  SELECT funding."id", grant_row."id", 'PAID'::TEXT
  FROM positive_funding funding
  JOIN "balance_grants" grant_row
    ON grant_row."billing_account_id" = target_account_id
    AND grant_row."order_id" = funding."order_id"
  WHERE funding."type"::TEXT = 'RECHARGE'
    AND funding."order_id" IS NOT NULL
    AND grant_row."source" = 'RECHARGE'
    AND grant_row."user_id" = funding."user_id"
    AND grant_row."tenant_id" = funding."tenant_id"
    AND grant_row."product_id" IS NOT DISTINCT FROM funding."product_id"
    AND grant_row."created_at" = funding."created_at"
    AND grant_row."valid_from" >= grant_row."created_at"
    AND (
      grant_row."valid_from" <= grant_row."created_at"
      OR "balance_legacy_grant_valid_from_is_repair_proven"(
        funding."id",
        grant_row."valid_from"
      )
    )
    AND (grant_row."expires_at" IS NULL OR grant_row."expires_at" > grant_row."valid_from")
    AND grant_row."paid_amount_usd" = funding."amount_usd"
    AND grant_row."bonus_amount_usd" = COALESCE((
      SELECT SUM(bonus_tx."amount_usd")
      FROM "balance_transactions" bonus_tx
      WHERE bonus_tx."billing_account_id" = target_account_id
        AND bonus_tx."order_id" = funding."order_id"
        AND bonus_tx."type"::TEXT = 'ADJUST'
        AND bonus_tx."amount_usd" > 0
        AND bonus_tx."description" ~ '^recharge-bonus(?: tier:[^[:space:]]+)?$'
    ), 0)
    AND (SELECT COUNT(*) FROM "balance_transactions" paid_tx
      WHERE paid_tx."billing_account_id" = target_account_id
        AND paid_tx."order_id" = funding."order_id"
        AND paid_tx."type"::TEXT = 'RECHARGE'
        AND paid_tx."amount_usd" > 0) = 1
    AND NOT EXISTS (
      SELECT 1 FROM "balance_transactions" unsupported
      WHERE unsupported."billing_account_id" = target_account_id
        AND unsupported."order_id" = funding."order_id"
        AND unsupported."amount_usd" > 0
        AND NOT (
          unsupported."type"::TEXT = 'RECHARGE'
          OR (
            unsupported."type"::TEXT = 'ADJUST'
            AND unsupported."description" ~ '^recharge-bonus(?: tier:[^[:space:]]+)?$'
          )
        )
    )
    AND (
      funding."operation_key" IS NULL
      OR funding."operation_key" = 'balance:recharge:' || funding."order_id" || ':paid'
    )

  UNION ALL

  SELECT funding."id", grant_row."id", 'PAID'::TEXT
  FROM positive_funding funding
  JOIN "balance_grants" grant_row
    ON grant_row."billing_account_id" = target_account_id
    AND grant_row."order_id" IS NULL
  WHERE funding."type"::TEXT = 'RECHARGE'
    AND funding."order_id" IS NULL
    AND grant_row."source" = 'RECHARGE'
    AND grant_row."user_id" = funding."user_id"
    AND grant_row."tenant_id" = funding."tenant_id"
    AND grant_row."product_id" IS NOT DISTINCT FROM funding."product_id"
    AND grant_row."paid_amount_usd" = funding."amount_usd"
    AND grant_row."bonus_amount_usd" = 0
    AND grant_row."granted_amount_usd" = funding."amount_usd"
    AND grant_row."created_at" = funding."created_at"
    AND grant_row."valid_from" >= grant_row."created_at"
    AND (
      grant_row."valid_from" <= grant_row."created_at"
      OR "balance_legacy_grant_valid_from_is_repair_proven"(
        funding."id",
        grant_row."valid_from"
      )
    )
    AND (grant_row."expires_at" IS NULL OR grant_row."expires_at" > grant_row."valid_from")
    AND (
      funding."operation_key" IS NULL
      OR funding."operation_key" = 'balance:admin-recharge:grant:' || grant_row."id"
    )
    AND (
      funding."operation_key" IS NULL
      OR funding."operation_key" ~ '^balance:admin-recharge:grant:[^[:space:]]+$'
    )

  UNION ALL

  SELECT funding."id", grant_row."id", 'BONUS'::TEXT
  FROM positive_funding funding
  JOIN "balance_transactions" paid_tx
    ON paid_tx."billing_account_id" = target_account_id
    AND paid_tx."order_id" = funding."order_id"
    AND paid_tx."type"::TEXT = 'RECHARGE'
    AND paid_tx."amount_usd" > 0
  JOIN "balance_grants" grant_row
    ON grant_row."billing_account_id" = target_account_id
    AND grant_row."order_id" = funding."order_id"
  WHERE funding."type"::TEXT = 'ADJUST'
    AND funding."amount_usd" > 0
    AND funding."order_id" IS NOT NULL
    AND funding."description" ~ '^recharge-bonus(?: tier:[^[:space:]]+)?$'
    AND grant_row."source" = 'RECHARGE'
    AND grant_row."user_id" = funding."user_id"
    AND grant_row."tenant_id" = funding."tenant_id"
    AND grant_row."product_id" IS NOT DISTINCT FROM funding."product_id"
    AND paid_tx."user_id" = grant_row."user_id"
    AND paid_tx."tenant_id" = grant_row."tenant_id"
    AND paid_tx."product_id" IS NOT DISTINCT FROM grant_row."product_id"
    AND grant_row."created_at" = paid_tx."created_at"
    AND grant_row."valid_from" >= grant_row."created_at"
    AND (
      grant_row."valid_from" <= grant_row."created_at"
      OR "balance_legacy_grant_valid_from_is_repair_proven"(
        paid_tx."id",
        grant_row."valid_from"
      )
    )
    AND (grant_row."expires_at" IS NULL OR grant_row."expires_at" > grant_row."valid_from")
    AND funding."created_at" >= paid_tx."created_at"
    AND grant_row."paid_amount_usd" = paid_tx."amount_usd"
    AND grant_row."bonus_amount_usd" = COALESCE((
      SELECT SUM(bonus_tx."amount_usd")
      FROM "balance_transactions" bonus_tx
      WHERE bonus_tx."billing_account_id" = target_account_id
        AND bonus_tx."order_id" = funding."order_id"
        AND bonus_tx."type"::TEXT = 'ADJUST'
        AND bonus_tx."amount_usd" > 0
        AND bonus_tx."description" ~ '^recharge-bonus(?: tier:[^[:space:]]+)?$'
    ), 0)
    AND (SELECT COUNT(*) FROM "balance_transactions" paid_count
      WHERE paid_count."billing_account_id" = target_account_id
        AND paid_count."order_id" = funding."order_id"
        AND paid_count."type"::TEXT = 'RECHARGE'
        AND paid_count."amount_usd" > 0) = 1
    AND (
      paid_tx."operation_key" IS NULL
      OR paid_tx."operation_key" = 'balance:recharge:' || funding."order_id" || ':paid'
    )

  UNION ALL

  SELECT funding."id", grant_row."id", 'BONUS'::TEXT
  FROM positive_funding funding
  JOIN "balance_grants" grant_row
    ON grant_row."billing_account_id" = target_account_id
    AND grant_row."id" = substring(
      funding."description" FROM '^voucher:([^[:space:]]+)'
    )
  WHERE funding."type"::TEXT = 'ADJUST'
    AND funding."order_id" IS NULL
    AND funding."description"
      ~ '^voucher:[^[:space:]]+[[:space:]]+[^[:space:]](?:.*[^[:space:]])?$'
    AND grant_row."source" = 'VOUCHER'
    AND grant_row."user_id" = funding."user_id"
    AND grant_row."tenant_id" = funding."tenant_id"
    AND grant_row."product_id" IS NOT DISTINCT FROM funding."product_id"
    AND grant_row."order_id" IS NULL
    AND grant_row."paid_amount_usd" = 0
    AND grant_row."bonus_amount_usd" = funding."amount_usd"
    AND grant_row."granted_amount_usd" = funding."amount_usd"
    AND grant_row."created_at" = funding."created_at"
    AND grant_row."valid_from" >= grant_row."created_at"
    AND (
      grant_row."valid_from" <= grant_row."created_at"
      OR "balance_legacy_grant_valid_from_is_repair_proven"(
        funding."id",
        grant_row."valid_from"
      )
    )
    AND (grant_row."expires_at" IS NULL OR grant_row."expires_at" > grant_row."valid_from")
    AND (
      funding."operation_key" IS NULL
      OR funding."operation_key" = 'balance:voucher:grant:' || grant_row."id"
    )
    AND (SELECT COUNT(*) FROM "balance_transactions" voucher_tx
      WHERE voucher_tx."billing_account_id" = target_account_id
        AND voucher_tx."description"
          ~ '^voucher:[^[:space:]]+[[:space:]]+[^[:space:]](?:.*[^[:space:]])?$'
        AND substring(voucher_tx."description" FROM '^voucher:([^[:space:]]+)')
          = grant_row."id") = 1

$$;

-- A clean batch is not valid merely because its row-local components add up.
-- At COMMIT, prove that its immutable gross paid/bonus amounts are funded by
-- exactly classified wallet transactions.  The trigger is deferred because
-- the three supported writers intentionally create grant/transaction/audit
-- rows in different orders inside one database transaction.
CREATE OR REPLACE FUNCTION "assert_balance_grant_funding_aggregate"(
  target_grant_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  grant_row RECORD;
  account_type TEXT;
  account_status TEXT;
  funded_paid NUMERIC;
  funded_bonus NUMERIC;
  invalid_candidate_count BIGINT;
BEGIN
  SELECT grant_row_source.*, account."type", account."balance_grant_ledger_status"
  INTO grant_row
  FROM "balance_grants" grant_row_source
  JOIN "billing_accounts" account
    ON account."id" = grant_row_source."billing_account_id"
  WHERE grant_row_source."id" = target_grant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'balance grant funding proof references missing batch: %', target_grant_id
      USING ERRCODE = '23514';
  END IF;
  account_type := grant_row."type";
  account_status := grant_row."balance_grant_ledger_status";
  IF account_status <> 'RECONCILED_V2' THEN
    RETURN;
  END IF;

  WITH candidates AS (
    SELECT *
    FROM "balance_funding_candidates"(grant_row."billing_account_id", account_type)
  ), target_candidates AS (
    SELECT candidate.*
    FROM candidates candidate
    WHERE candidate.grant_id = target_grant_id
  ), candidate_cardinality AS (
    SELECT candidate.funding_id, COUNT(*) AS candidate_count
    FROM candidates candidate
    WHERE candidate.funding_id IN (
      SELECT target.funding_id FROM target_candidates target
    )
    GROUP BY candidate.funding_id
  )
  SELECT
    COALESCE(SUM(funding."amount_usd") FILTER (
      WHERE target.nature = 'PAID'
    ), 0),
    COALESCE(SUM(funding."amount_usd") FILTER (
      WHERE target.nature = 'BONUS'
    ), 0),
    (SELECT COUNT(*) FROM candidate_cardinality WHERE candidate_count <> 1)
  INTO funded_paid, funded_bonus, invalid_candidate_count
  FROM target_candidates target
  JOIN "balance_transactions" funding ON funding."id" = target.funding_id;

  IF grant_row."source" NOT IN ('RECHARGE', 'VOUCHER')
    OR funded_paid IS DISTINCT FROM grant_row."paid_amount_usd"
    OR funded_bonus IS DISTINCT FROM grant_row."bonus_amount_usd"
    OR invalid_candidate_count <> 0
  THEN
    RAISE EXCEPTION
      'balance grant canonical funding invalid grant=% paid=%/% bonus=%/% ambiguous=%',
      target_grant_id,
      grant_row."paid_amount_usd", funded_paid,
      grant_row."bonus_amount_usd", funded_bonus,
      invalid_candidate_count
      USING ERRCODE = '23514';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION "validate_balance_grant_funding_trigger"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  -- Consumption, refund and expiry only change remaining/lifecycle fields.
  -- The immutable gross funding proof cannot change on those hot paths, so do
  -- not rescan the account's complete funding classifier at COMMIT.
  IF TG_OP = 'UPDATE'
    AND NEW."paid_amount_usd" IS NOT DISTINCT FROM OLD."paid_amount_usd"
    AND NEW."bonus_amount_usd" IS NOT DISTINCT FROM OLD."bonus_amount_usd"
    AND NEW."granted_amount_usd" IS NOT DISTINCT FROM OLD."granted_amount_usd"
    AND NEW."discount_rate" IS NOT DISTINCT FROM OLD."discount_rate"
  THEN
    RETURN NEW;
  END IF;
  PERFORM "assert_balance_grant_funding_aggregate"(NEW."id");
  RETURN NEW;
END
$$;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DROP TRIGGER IF EXISTS "balance_grants_funding_aggregate_deferred"
  ON "balance_grants";
CREATE CONSTRAINT TRIGGER "balance_grants_funding_aggregate_deferred"
AFTER INSERT OR UPDATE ON "balance_grants"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_balance_grant_funding_trigger"();
COMMIT;

CREATE OR REPLACE FUNCTION "assert_balance_transaction_unique_wallet_path"(
  target_account_id TEXT,
  expected_wallet NUMERIC
)
RETURNS TEXT[]
LANGUAGE plpgsql
AS $$
DECLARE
  invalid_sequence_count BIGINT;
  legacy_count BIGINT;
  running_balance NUMERIC := 0;
  path_ids TEXT[] := ARRAY[]::TEXT[];
  transaction_row RECORD;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "balance_transactions"
    WHERE "billing_account_id" = target_account_id
  ) THEN
    IF expected_wallet <> 0 THEN
      RAISE EXCEPTION 'empty balance transaction path does not reach wallet account=% wallet=%',
        target_account_id, expected_wallet USING ERRCODE = '23514';
    END IF;
    RETURN ARRAY[]::TEXT[];
  END IF;

  SELECT COUNT(*) FILTER (WHERE "ledger_sequence" < 0)
    INTO legacy_count
  FROM "balance_transactions"
  WHERE "billing_account_id" = target_account_id;

  WITH sequenced AS (
    SELECT sequenced_transaction."id",
      sequenced_transaction."ledger_sequence",
      ROW_NUMBER() OVER (ORDER BY sequenced_transaction."ledger_sequence") AS sequence_position
    FROM "balance_transactions" sequenced_transaction
    WHERE sequenced_transaction."billing_account_id" = target_account_id
  )
  SELECT COUNT(*) INTO invalid_sequence_count
  FROM sequenced
  WHERE "ledger_sequence" IS NULL
    OR "ledger_sequence" = 0
    OR (
      "ledger_sequence" < 0
      AND "ledger_sequence" <> sequence_position - legacy_count - 1
    );
  IF invalid_sequence_count <> 0 THEN
    RAISE EXCEPTION
      'balance transaction ledger sequence invalid account=% invalid=% legacy=%',
      target_account_id,
      invalid_sequence_count,
      legacy_count
      USING ERRCODE = '23514';
  END IF;

  FOR transaction_row IN
    SELECT *
    FROM "balance_transactions"
    WHERE "billing_account_id" = target_account_id
    ORDER BY "ledger_sequence"
  LOOP
    IF transaction_row."balance_after_usd" - transaction_row."amount_usd"
      IS DISTINCT FROM running_balance
    THEN
      RAISE EXCEPTION
        'balance transaction sequenced wallet path is disconnected account=% transaction=% expected_before=% actual_before=% sequence=%',
        target_account_id,
        transaction_row."id",
        running_balance,
        transaction_row."balance_after_usd" - transaction_row."amount_usd",
        transaction_row."ledger_sequence"
        USING ERRCODE = '23514';
    END IF;
    running_balance := transaction_row."balance_after_usd";
    path_ids := array_append(path_ids, transaction_row."id");
  END LOOP;

  IF running_balance IS DISTINCT FROM expected_wallet THEN
    RAISE EXCEPTION
      'balance transaction sequenced wallet path does not reach wallet account=% replay=% wallet=%',
      target_account_id,
      running_balance,
      expected_wallet
      USING ERRCODE = '23514';
  END IF;
  RETURN path_ids;
END
$$;

-- Validate the allocation epoch independently from the repair JSON.  Legacy
-- rows occupy a deterministic negative epoch (-N..-1) before every online
-- sequence; online positive values may contain global-sequence gaps but must
-- increase along the proven wallet path.  A transaction cannot mix epochs.
CREATE OR REPLACE FUNCTION "assert_balance_allocation_sequence_order"(
  target_account_id TEXT,
  wallet_path_ids TEXT[]
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  mixed_epoch_count BIGINT;
  invalid_order_count BIGINT;
BEGIN
  WITH path AS (
    SELECT entry.transaction_id, entry.path_position
    FROM unnest(wallet_path_ids) WITH ORDINALITY
      AS entry(transaction_id, path_position)
  ), path_allocations AS (
    SELECT allocation.*,
      path.path_position
    FROM path
    JOIN "balance_consumption_allocations" allocation
      ON allocation."balance_transaction_id" = path.transaction_id
      AND allocation."billing_account_id" = target_account_id
  )
  SELECT COUNT(*)
  INTO mixed_epoch_count
  FROM (
    SELECT "balance_transaction_id"
    FROM path_allocations
    GROUP BY "balance_transaction_id"
    HAVING BOOL_OR("ledger_sequence" IS NULL OR "ledger_sequence" < 0)
      AND BOOL_OR("ledger_sequence" > 0)
  ) mixed;

  WITH path AS (
    SELECT entry.transaction_id, entry.path_position
    FROM unnest(wallet_path_ids) WITH ORDINALITY
      AS entry(transaction_id, path_position)
  ), canonical AS (
    SELECT allocation."id",
      allocation."ledger_sequence",
      ROW_NUMBER() OVER (
        ORDER BY path.path_position,
          allocation."ledger_sequence" ASC NULLS FIRST,
          allocation."id"
      ) AS canonical_position
    FROM path
    JOIN "balance_consumption_allocations" allocation
      ON allocation."balance_transaction_id" = path.transaction_id
      AND allocation."billing_account_id" = target_account_id
  ), annotated AS (
    SELECT canonical.*,
      COUNT(*) FILTER (
        WHERE "ledger_sequence" IS NULL OR "ledger_sequence" < 0
      ) OVER () AS legacy_count,
      COUNT(*) FILTER (
        WHERE "ledger_sequence" > 0
      ) OVER (
        ORDER BY canonical_position
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
      ) AS prior_positive_count,
      MAX("ledger_sequence") FILTER (
        WHERE "ledger_sequence" > 0
      ) OVER (
        ORDER BY canonical_position
        ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
      ) AS prior_positive_max
    FROM canonical
  )
  SELECT COUNT(*)
  INTO invalid_order_count
  FROM annotated
  WHERE "ledger_sequence" IS NULL
    OR "ledger_sequence" = 0
    OR (
      "ledger_sequence" < 0
      AND "ledger_sequence" <> canonical_position - legacy_count - 1
    )
    OR (
      "ledger_sequence" < 0
      AND COALESCE(prior_positive_count, 0) > 0
    )
    OR (
      "ledger_sequence" > 0
      AND prior_positive_max IS NOT NULL
      AND "ledger_sequence" <= prior_positive_max
    );

  IF mixed_epoch_count <> 0 OR invalid_order_count <> 0 THEN
    RAISE EXCEPTION
      'balance allocation canonical sequence invalid account=% mixed=% order=%',
      target_account_id, mixed_epoch_count, invalid_order_count
      USING ERRCODE = '23514';
  END IF;
END
$$;

-- Replay funding, grant consumption and debt settlement from the immutable
-- wallet path.  This is intentionally independent from the application plan
-- and its JSON audit: the database promotion marker is the final authority and
-- must reject a self-consistent but FIFO-wrong set of rows.
CREATE OR REPLACE FUNCTION "assert_balance_ledger_canonical_replay"(
  target_account_id TEXT,
  target_account_type TEXT,
  expected_debt_source TEXT,
  expected_settlement_mode TEXT,
  target_run_id TEXT,
  wallet_path_ids TEXT[]
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  path_entry RECORD;
  transaction_row RECORD;
  allocation_row RECORD;
  grant_state RECORD;
  debt_state RECORD;
  candidate_count BIGINT;
  candidate_grant_id TEXT;
  candidate_nature TEXT;
  before_usd NUMERIC;
  hole_fill_usd NUMERIC;
  consumable_usd NUMERIC;
  remaining_hole_usd NUMERIC;
  applied_usd NUMERIC;
  available_usd NUMERIC;
  expected_paid_usd NUMERIC;
  expected_bonus_usd NUMERIC;
  expected_discount_rate NUMERIC;
  current_discount_rate NUMERIC;
  minimum_paid_usd NUMERIC;
  maximum_paid_usd NUMERIC;
  expected_repayment_id TEXT;
  bundled_repayment_count BIGINT;
  bundled_repayment_id TEXT;
  debt_position BIGINT := 0;
  settlement_position BIGINT := 0;
  invalid_grant_state_count BIGINT;
  invalid_debt_state_count BIGINT;
  settlement_difference_count BIGINT;
  invalid_settlement_link_count BIGINT := 0;
BEGIN
  CREATE TEMP TABLE IF NOT EXISTS "balance_ledger_replay_grant_state" (
    grant_id TEXT PRIMARY KEY,
    paid_remaining_usd NUMERIC NOT NULL,
    bonus_remaining_usd NUMERIC NOT NULL
  ) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS "balance_ledger_replay_debt_state" (
    allocation_id TEXT PRIMARY KEY,
    debt_position BIGINT NOT NULL,
    remaining_usd NUMERIC NOT NULL,
    paid_usd NUMERIC NOT NULL,
    bonus_usd NUMERIC NOT NULL
  ) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS "balance_ledger_replay_funding_candidates" (
    funding_id TEXT NOT NULL,
    grant_id TEXT,
    nature TEXT NOT NULL
  ) ON COMMIT DROP;
  CREATE TEMP TABLE IF NOT EXISTS "balance_ledger_replay_expected_settlements" (
    settlement_position BIGINT NOT NULL,
    allocation_id TEXT NOT NULL,
    repayment_transaction_id TEXT NOT NULL,
    balance_grant_id TEXT,
    amount_usd NUMERIC NOT NULL,
    paid_usd NUMERIC NOT NULL,
    bonus_usd NUMERIC NOT NULL
  ) ON COMMIT DROP;

  TRUNCATE TABLE
    pg_temp."balance_ledger_replay_grant_state",
    pg_temp."balance_ledger_replay_debt_state",
    pg_temp."balance_ledger_replay_funding_candidates",
    pg_temp."balance_ledger_replay_expected_settlements";

  INSERT INTO pg_temp."balance_ledger_replay_grant_state"(
    grant_id, paid_remaining_usd, bonus_remaining_usd
  )
  SELECT "id", 0, 0
  FROM "balance_grants"
  WHERE "billing_account_id" = target_account_id;

  INSERT INTO pg_temp."balance_ledger_replay_funding_candidates"(
    funding_id, grant_id, nature
  )
  SELECT funding_id, grant_id, nature
  FROM "balance_funding_candidates"(target_account_id, target_account_type);

  FOR path_entry IN
    SELECT entry.transaction_id, entry.path_position
    FROM unnest(wallet_path_ids) WITH ORDINALITY
      AS entry(transaction_id, path_position)
    ORDER BY entry.path_position
  LOOP
    SELECT * INTO STRICT transaction_row
    FROM "balance_transactions"
    WHERE "id" = path_entry.transaction_id
      AND "billing_account_id" = target_account_id;
    before_usd := transaction_row."balance_after_usd" - transaction_row."amount_usd";

    IF transaction_row."amount_usd" > 0 THEN
      SELECT COUNT(*), MIN(candidate.grant_id), MIN(candidate.nature)
      INTO candidate_count, candidate_grant_id, candidate_nature
      FROM pg_temp."balance_ledger_replay_funding_candidates" candidate
      WHERE candidate.funding_id = transaction_row."id";
      IF candidate_count <> 1 THEN
        RAISE EXCEPTION
          'balance canonical replay funding classifier invalid account=% transaction=% candidates=%',
          target_account_id, transaction_row."id", candidate_count
          USING ERRCODE = '23514';
      END IF;

      hole_fill_usd := LEAST(
        transaction_row."amount_usd",
        GREATEST(-before_usd, 0)
      );
      consumable_usd := transaction_row."amount_usd" - hole_fill_usd;
      IF candidate_grant_id IS NOT NULL THEN
        IF candidate_nature = 'PAID' THEN
          UPDATE pg_temp."balance_ledger_replay_grant_state"
          SET paid_remaining_usd = paid_remaining_usd + consumable_usd
          WHERE grant_id = candidate_grant_id;
        ELSIF candidate_nature = 'BONUS' THEN
          UPDATE pg_temp."balance_ledger_replay_grant_state"
          SET bonus_remaining_usd = bonus_remaining_usd + consumable_usd
          WHERE grant_id = candidate_grant_id;
        ELSE
          RAISE EXCEPTION
            'balance canonical replay funding nature invalid transaction=% nature=%',
            transaction_row."id", candidate_nature
            USING ERRCODE = '23514';
        END IF;
        IF NOT FOUND THEN
          RAISE EXCEPTION
            'balance canonical replay funding grant missing transaction=% grant=%',
            transaction_row."id", candidate_grant_id
            USING ERRCODE = '23514';
        END IF;
      END IF;

      remaining_hole_usd := hole_fill_usd;
      WHILE remaining_hole_usd > 0 LOOP
        SELECT * INTO debt_state
        FROM pg_temp."balance_ledger_replay_debt_state"
        WHERE remaining_usd > 0
        ORDER BY debt_position
        LIMIT 1;
        IF NOT FOUND THEN
          RAISE EXCEPTION
            'balance canonical replay funding exceeds FIFO debt transaction=% residual=%',
            transaction_row."id", remaining_hole_usd
            USING ERRCODE = '23514';
        END IF;
        applied_usd := LEAST(remaining_hole_usd, debt_state.remaining_usd);
        expected_repayment_id := transaction_row."id";

        -- rechargeWithBonus historically attached a same-time bonus leg to
        -- the paid RECHARGE row.  Preserve that one proven enterprise shape;
        -- personal repair rows and V2 direct rows always use their own funding
        -- transaction id.
        IF expected_settlement_mode = 'VERIFY_EXISTING'
          AND candidate_nature = 'BONUS'
          AND transaction_row."type"::TEXT = 'ADJUST'
          AND transaction_row."order_id" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM "enterprise_credit_settlements" settlement
            WHERE settlement."billing_account_id" = target_account_id
              AND settlement."allocation_id" = debt_state.allocation_id
              AND settlement."repayment_transaction_id" = transaction_row."id"
          )
        THEN
          SELECT COUNT(*), MIN(paid."id")
          INTO bundled_repayment_count, bundled_repayment_id
          FROM "balance_transactions" paid
          WHERE paid."billing_account_id" = target_account_id
            AND paid."type"::TEXT = 'RECHARGE'
            AND paid."order_id" = transaction_row."order_id"
            AND paid."created_at" = transaction_row."created_at";
          IF bundled_repayment_count > 1 THEN
            RAISE EXCEPTION
              'balance canonical replay bundled repayment ambiguous transaction=% count=%',
              transaction_row."id", bundled_repayment_count
              USING ERRCODE = '23514';
          END IF;
          IF bundled_repayment_count = 1 THEN
            expected_repayment_id := bundled_repayment_id;
          END IF;
        END IF;

        settlement_position := settlement_position + 1;
        INSERT INTO pg_temp."balance_ledger_replay_expected_settlements"(
          settlement_position,
          allocation_id,
          repayment_transaction_id,
          balance_grant_id,
          amount_usd,
          paid_usd,
          bonus_usd
        ) VALUES (
          settlement_position,
          debt_state.allocation_id,
          expected_repayment_id,
          candidate_grant_id,
          applied_usd,
          CASE WHEN candidate_nature = 'PAID' THEN applied_usd ELSE 0 END,
          CASE WHEN candidate_nature = 'BONUS' THEN applied_usd ELSE 0 END
        );

        UPDATE pg_temp."balance_ledger_replay_debt_state"
        SET remaining_usd = remaining_usd - applied_usd,
          paid_usd = paid_usd
            + CASE WHEN candidate_nature = 'PAID' THEN applied_usd ELSE 0 END,
          bonus_usd = bonus_usd
            + CASE WHEN candidate_nature = 'BONUS' THEN applied_usd ELSE 0 END
        WHERE allocation_id = debt_state.allocation_id;
        remaining_hole_usd := remaining_hole_usd - applied_usd;
      END LOOP;
      CONTINUE;
    END IF;

    IF transaction_row."type"::TEXT <> 'CONSUME' THEN
      CONTINUE;
    END IF;

    -- Consume each immutable allocation row in its final ledger order.  The
    -- earliest currently available grant (expiry NULLS LAST, creation, id)
    -- must be the row's grant, and its paid/bonus split is recomputed from the
    -- replay state rather than trusted from stored aggregates.
    FOR allocation_row IN
      SELECT allocation.*
      FROM "balance_consumption_allocations" allocation
      WHERE allocation."billing_account_id" = target_account_id
        AND allocation."balance_transaction_id" = transaction_row."id"
        AND allocation."source" = 'BALANCE_GRANT'
      ORDER BY allocation."ledger_sequence" ASC NULLS FIRST, allocation."id"
    LOOP
      SELECT state.grant_id,
        state.paid_remaining_usd,
        state.bonus_remaining_usd
      INTO grant_state
      FROM pg_temp."balance_ledger_replay_grant_state" state
      JOIN "balance_grants" grant_row ON grant_row."id" = state.grant_id
      WHERE state.paid_remaining_usd + state.bonus_remaining_usd > 0
        AND NOT grant_row."is_expired"
        AND grant_row."created_at" <= transaction_row."created_at"
        AND grant_row."valid_from" <= transaction_row."created_at"
        AND (
          grant_row."expires_at" IS NULL
          OR grant_row."expires_at" > transaction_row."created_at"
        )
      ORDER BY grant_row."expires_at" ASC NULLS LAST,
        grant_row."created_at",
        grant_row."id"
      LIMIT 1;
      IF NOT FOUND THEN
        RAISE EXCEPTION
          'balance canonical replay grant allocation is unbacked transaction=% allocation=%',
          transaction_row."id", allocation_row."id"
          USING ERRCODE = '23514';
      END IF;
      available_usd := grant_state.paid_remaining_usd + grant_state.bonus_remaining_usd;
      IF allocation_row."balance_grant_id" IS DISTINCT FROM grant_state.grant_id
        OR allocation_row."amount_usd" <= 0
        OR allocation_row."amount_usd" > available_usd
      THEN
        RAISE EXCEPTION
          'balance canonical replay grant FIFO mismatch transaction=% allocation=% actual=% expected=% amount=% available=%',
          transaction_row."id", allocation_row."id",
          allocation_row."balance_grant_id", grant_state.grant_id,
          allocation_row."amount_usd", available_usd
          USING ERRCODE = '23514';
      END IF;

      IF allocation_row."amount_usd" = available_usd THEN
        expected_paid_usd := grant_state.paid_remaining_usd;
        expected_bonus_usd := grant_state.bonus_remaining_usd;
      ELSE
        expected_discount_rate := ROUND(
          grant_state.paid_remaining_usd / available_usd,
          12
        );
        expected_paid_usd := ROUND(
          allocation_row."amount_usd" * expected_discount_rate,
          12
        );
        minimum_paid_usd := GREATEST(
          0,
          allocation_row."amount_usd" - grant_state.bonus_remaining_usd
        );
        maximum_paid_usd := LEAST(
          allocation_row."amount_usd",
          grant_state.paid_remaining_usd
        );
        expected_paid_usd := ROUND(
          LEAST(maximum_paid_usd, GREATEST(minimum_paid_usd, expected_paid_usd)),
          12
        );
        expected_bonus_usd := ROUND(
          allocation_row."amount_usd" - expected_paid_usd,
          12
        );
      END IF;
      expected_discount_rate := ROUND(
        expected_paid_usd / allocation_row."amount_usd",
        12
      );
      current_discount_rate := ROUND(
        allocation_row."recognized_revenue_usd" / allocation_row."amount_usd",
        12
      );
      IF allocation_row."recognized_revenue_usd" IS DISTINCT FROM expected_paid_usd
        OR allocation_row."bonus_consumed_usd" IS DISTINCT FROM expected_bonus_usd
        OR allocation_row."discount_rate" IS DISTINCT FROM expected_discount_rate
        OR current_discount_rate IS DISTINCT FROM expected_discount_rate
      THEN
        RAISE EXCEPTION
          'balance canonical replay grant component split mismatch allocation=% paid=%/% bonus=%/% rate=%/%',
          allocation_row."id",
          allocation_row."recognized_revenue_usd", expected_paid_usd,
          allocation_row."bonus_consumed_usd", expected_bonus_usd,
          allocation_row."discount_rate", expected_discount_rate
          USING ERRCODE = '23514';
      END IF;
      UPDATE pg_temp."balance_ledger_replay_grant_state"
      SET paid_remaining_usd = paid_remaining_usd - expected_paid_usd,
        bonus_remaining_usd = bonus_remaining_usd - expected_bonus_usd
      WHERE grant_id = grant_state.grant_id;
    END LOOP;

    FOR allocation_row IN
      SELECT allocation.*
      FROM "balance_consumption_allocations" allocation
      WHERE allocation."billing_account_id" = target_account_id
        AND allocation."balance_transaction_id" = transaction_row."id"
        AND allocation."source" = expected_debt_source
      ORDER BY allocation."id"
    LOOP
      debt_position := debt_position + 1;
      INSERT INTO pg_temp."balance_ledger_replay_debt_state"(
        allocation_id, debt_position, remaining_usd, paid_usd, bonus_usd
      ) VALUES (
        allocation_row."id", debt_position, allocation_row."amount_usd", 0, 0
      );
    END LOOP;
  END LOOP;

  SELECT COUNT(*) INTO invalid_grant_state_count
  FROM pg_temp."balance_ledger_replay_grant_state" state
  JOIN "balance_grants" grant_row ON grant_row."id" = state.grant_id
  WHERE state.paid_remaining_usd IS DISTINCT FROM grant_row."remaining_paid_amount_usd"
    OR state.bonus_remaining_usd IS DISTINCT FROM grant_row."remaining_bonus_amount_usd";

  SELECT COUNT(*) INTO invalid_debt_state_count
  FROM pg_temp."balance_ledger_replay_debt_state" state
  JOIN "balance_consumption_allocations" allocation
    ON allocation."id" = state.allocation_id
  WHERE allocation."settled_usd" IS DISTINCT FROM
      allocation."amount_usd" - state.remaining_usd
    OR allocation."recognized_revenue_usd" IS DISTINCT FROM state.paid_usd
    OR allocation."bonus_consumed_usd" IS DISTINCT FROM state.bonus_usd;

  IF expected_settlement_mode = 'CREATE' THEN
    WITH expected_rows AS (
      SELECT allocation_id,
        repayment_transaction_id,
        balance_grant_id,
        SUM(amount_usd) AS amount_usd,
        SUM(paid_usd) AS paid_usd,
        SUM(bonus_usd) AS bonus_usd
      FROM pg_temp."balance_ledger_replay_expected_settlements"
      GROUP BY allocation_id, repayment_transaction_id, balance_grant_id
    ), actual_rows AS (
      SELECT settlement."allocation_id" AS allocation_id,
        settlement."repayment_transaction_id" AS repayment_transaction_id,
        settlement."balance_grant_id" AS balance_grant_id,
        SUM(settlement."amount_usd") AS amount_usd,
        SUM(settlement."paid_usd") AS paid_usd,
        SUM(settlement."bonus_usd") AS bonus_usd
      FROM "enterprise_credit_settlements" settlement
      WHERE settlement."billing_account_id" = target_account_id
      GROUP BY settlement."allocation_id",
        settlement."repayment_transaction_id",
        settlement."balance_grant_id"
    ), differences AS (
      (SELECT * FROM expected_rows EXCEPT SELECT * FROM actual_rows)
      UNION ALL
      (SELECT * FROM actual_rows EXCEPT SELECT * FROM expected_rows)
    )
    SELECT COUNT(*) INTO settlement_difference_count FROM differences;
  ELSE
    WITH expected_rows AS (
      SELECT allocation_id,
        repayment_transaction_id,
        SUM(amount_usd) AS amount_usd,
        SUM(paid_usd) AS paid_usd,
        SUM(bonus_usd) AS bonus_usd
      FROM pg_temp."balance_ledger_replay_expected_settlements"
      GROUP BY allocation_id, repayment_transaction_id
    ), actual_rows AS (
      SELECT settlement."allocation_id" AS allocation_id,
        settlement."repayment_transaction_id" AS repayment_transaction_id,
        SUM(settlement."amount_usd") AS amount_usd,
        SUM(settlement."paid_usd") AS paid_usd,
        SUM(settlement."bonus_usd") AS bonus_usd
      FROM "enterprise_credit_settlements" settlement
      WHERE settlement."billing_account_id" = target_account_id
      GROUP BY settlement."allocation_id", settlement."repayment_transaction_id"
    ), differences AS (
      (SELECT * FROM expected_rows EXCEPT SELECT * FROM actual_rows)
      UNION ALL
      (SELECT * FROM actual_rows EXCEPT SELECT * FROM expected_rows)
    )
    SELECT COUNT(*) INTO settlement_difference_count FROM differences;

    -- Enterprise history may contain the one legacy NULL-link shape that
    -- predates balance_grant_id, identified only by the immutable
    -- `legacy:<settlement-id>` key.  Every V2/non-legacy row must point to the
    -- exact grant proven for that funding leg; merely pointing somewhere in
    -- the same account would permit paid/bonus grant links to be crossed.
    SELECT COUNT(*) INTO invalid_settlement_link_count
    FROM "enterprise_credit_settlements" settlement
    WHERE settlement."billing_account_id" = target_account_id
      AND (
        (
          settlement."balance_grant_id" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM pg_temp."balance_ledger_replay_expected_settlements" expected
            WHERE expected.allocation_id = settlement."allocation_id"
              AND expected.repayment_transaction_id
                = settlement."repayment_transaction_id"
              AND expected.balance_grant_id = settlement."balance_grant_id"
          )
        )
        OR (
          settlement."balance_grant_id" IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM pg_temp."balance_ledger_replay_expected_settlements" expected
            WHERE expected.allocation_id = settlement."allocation_id"
              AND expected.repayment_transaction_id
                = settlement."repayment_transaction_id"
              AND expected.balance_grant_id IS NULL
          )
          AND (
            settlement."operation_key" IS DISTINCT FROM ('legacy:' || settlement."id")
            OR NOT EXISTS (
              SELECT 1
              FROM pg_temp."balance_ledger_replay_expected_settlements" expected
              WHERE expected.allocation_id = settlement."allocation_id"
                AND expected.repayment_transaction_id = settlement."repayment_transaction_id"
            )
          )
        )
      );
  END IF;

  IF invalid_grant_state_count <> 0
    OR invalid_debt_state_count <> 0
    OR settlement_difference_count <> 0
    OR invalid_settlement_link_count <> 0
  THEN
    RAISE EXCEPTION
      'balance canonical replay final state invalid account=% grant=% debt=% settlement=% link=%',
      target_account_id,
      invalid_grant_state_count,
      invalid_debt_state_count,
      settlement_difference_count,
      invalid_settlement_link_count
      USING ERRCODE = '23514';
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION "assert_balance_ledger_canonical_promotion"(
  target_account_id TEXT,
  target_run_id TEXT,
  require_empty BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  account_row RECORD;
  repair_row RECORD;
  wallet_balance NUMERIC;
  transaction_count BIGINT;
  transaction_total NUMERIC;
  invalid_transaction_count BIGINT;
  active_grant_amount NUMERIC;
  invalid_grant_count BIGINT;
  open_debt_amount NUMERIC;
  invalid_allocation_count BIGINT;
  invalid_consume_count BIGINT;
  settlement_count BIGINT;
  invalid_settlement_count BIGINT;
  invalid_grant_conservation_count BIGINT;
  transaction_repair_count BIGINT;
  invalid_transaction_repair_count BIGINT;
  allocation_repair_count BIGINT;
  invalid_allocation_repair_count BIGINT;
  expiry_count BIGINT;
  refund_count BIGINT;
  invoice_item_count BIGINT;
  fact_count BIGINT;
  expected_debt_source TEXT;
  expected_settlement_mode TEXT;
  through_count BIGINT;
  invalid_grant_mutation_count BIGINT;
  invalid_funding_count BIGINT;
  wallet_path_ids TEXT[];
BEGIN
  SELECT * INTO account_row
  FROM "billing_accounts"
  WHERE "id" = target_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'balance ledger promotion account missing: %', target_account_id
      USING ERRCODE = '23514';
  END IF;
  -- A clean INSERT may be deliberately dirtied by a later writer in the same
  -- transaction.  There is then no clean authority to protect at commit.
  IF account_row."balance_grant_ledger_status" <> 'RECONCILED_V2' THEN
    RETURN;
  END IF;

  SELECT "balance_usd" INTO wallet_balance
  FROM "account_wallets"
  WHERE "billing_account_id" = target_account_id;

  IF require_empty THEN
    SELECT
      (SELECT COUNT(*) FROM "balance_transactions" WHERE "billing_account_id" = target_account_id)
      + (SELECT COUNT(*) FROM "balance_grants" WHERE "billing_account_id" = target_account_id)
      + (SELECT COUNT(*) FROM "balance_consumption_allocations" WHERE "billing_account_id" = target_account_id)
      + (SELECT COUNT(*) FROM "enterprise_credit_settlements" WHERE "billing_account_id" = target_account_id)
      + (SELECT COUNT(*) FROM "balance_grant_expiries" WHERE "billing_account_id" = target_account_id)
      + (SELECT COUNT(*) FROM "balance_grant_refunds" WHERE "billing_account_id" = target_account_id)
    INTO fact_count;
    IF account_row."balance_grant_ledger_version" IS DISTINCT FROM 2
      OR account_row."balance_grant_ledger_hash" IS DISTINCT FROM 'EMPTY_V2'
      OR account_row."balance_grant_ledger_through_transaction_id" IS NOT NULL
    THEN
      RAISE EXCEPTION
        'new CLEAN balance ledger marker is not EMPTY_V2 account=% wallet=% facts=%',
        target_account_id, COALESCE(wallet_balance, 0), fact_count
        USING ERRCODE = '23514';
    END IF;
    IF fact_count = 0 THEN
      IF COALESCE(wallet_balance, 0) <> 0 THEN
        RAISE EXCEPTION 'new EMPTY_V2 ledger has non-zero wallet: %', target_account_id
          USING ERRCODE = '23514';
      END IF;
      RETURN;
    END IF;
  END IF;

  IF wallet_balance IS NULL THEN
    RAISE EXCEPTION 'balance ledger promotion wallet missing: %', target_account_id
      USING ERRCODE = '23514';
  END IF;
  IF account_row."type" = 'personal' THEN
    expected_debt_source := 'NEGATIVE_BALANCE';
    expected_settlement_mode := 'CREATE';
  ELSIF account_row."type" = 'enterprise' THEN
    expected_debt_source := 'ENTERPRISE_CREDIT';
    expected_settlement_mode := 'VERIFY_EXISTING';
  ELSE
    RAISE EXCEPTION 'balance ledger promotion account type unsupported: %', account_row."type"
      USING ERRCODE = '23514';
  END IF;

  IF NOT require_empty THEN
    SELECT ra.*, r."status" AS run_status INTO repair_row
    FROM "balance_ledger_repair_accounts" ra
    JOIN "balance_ledger_repair_runs" r ON r."id" = ra."run_id"
    WHERE ra."run_id" = target_run_id
      AND ra."billing_account_id" = target_account_id;
    IF target_run_id IS NULL
      OR repair_row."id" IS NULL
      OR repair_row."status" IS DISTINCT FROM 'APPLIED'
      OR repair_row.run_status IS DISTINCT FROM 'RUNNING'
      OR repair_row."replay_hash" IS DISTINCT FROM account_row."balance_grant_ledger_hash"
      OR repair_row."after_snapshot" IS NULL
    THEN
      RAISE EXCEPTION 'balance ledger CLEAN promotion final proof missing: %', target_account_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT COUNT(*), COALESCE(SUM(bt."amount_usd"), 0), COUNT(*) FILTER (
    WHERE (bt."type"::TEXT = 'CONSUME' AND bt."amount_usd" >= 0)
      OR (bt."type"::TEXT IN ('RECHARGE', 'ADJUST') AND bt."amount_usd" <= 0)
      OR bt."type"::TEXT NOT IN ('CONSUME', 'RECHARGE', 'ADJUST')
  )
  INTO transaction_count, transaction_total, invalid_transaction_count
  FROM "balance_transactions" bt
  WHERE bt."billing_account_id" = target_account_id;

  SELECT COUNT(*) INTO through_count
  FROM "balance_transactions" bt
  WHERE bt."id" = account_row."balance_grant_ledger_through_transaction_id"
    AND bt."billing_account_id" = target_account_id
    AND bt."balance_after_usd" = wallet_balance
    AND bt."ledger_sequence" = (
      SELECT MAX(tail."ledger_sequence")
      FROM "balance_transactions" tail
      WHERE tail."billing_account_id" = target_account_id
    );

  wallet_path_ids := "assert_balance_transaction_unique_wallet_path"(
    target_account_id,
    wallet_balance
  );
  PERFORM "assert_balance_allocation_sequence_order"(
    target_account_id,
    wallet_path_ids
  );

  -- Build an explicit positive-funding -> grant/nature relation.  A valid
  -- ledger has exactly one classifier for every positive transaction, and
  -- every grant's immutable gross paid/bonus components are covered exactly
  -- once by those classified transactions.  This closes both duplicate
  -- funding reuse and orphan-grant constructions that aggregate-only checks
  -- cannot detect.
  WITH positive_funding AS (
    SELECT funding.*
    FROM "balance_transactions" funding
    WHERE funding."billing_account_id" = target_account_id
      AND funding."amount_usd" > 0
  ), funding_candidates AS (
    SELECT funding."id" AS funding_id, NULL::TEXT AS grant_id, 'PAID'::TEXT AS nature
    FROM positive_funding funding
    WHERE account_row."type" = 'enterprise'
      AND funding."type"::TEXT = 'ADJUST'
      AND funding."operation_key"
        ~ '^balance:admin-adjust:enterprise-paid-debt:[^[:space:]]+$'

    UNION ALL

    SELECT funding."id", grant_row."id", 'PAID'::TEXT
    FROM positive_funding funding
    JOIN "balance_grants" grant_row
      ON grant_row."billing_account_id" = target_account_id
      AND grant_row."order_id" = funding."order_id"
    WHERE funding."type"::TEXT = 'RECHARGE'
      AND funding."order_id" IS NOT NULL
      AND grant_row."source" = 'RECHARGE'
      AND grant_row."user_id" = funding."user_id"
      AND grant_row."tenant_id" = funding."tenant_id"
      AND grant_row."product_id" IS NOT DISTINCT FROM funding."product_id"
      AND grant_row."created_at" = funding."created_at"
      AND grant_row."valid_from" >= grant_row."created_at"
      AND (
        grant_row."valid_from" <= grant_row."created_at"
        OR "balance_legacy_grant_valid_from_is_repair_proven"(
          funding."id",
          grant_row."valid_from"
        )
      )
      AND (grant_row."expires_at" IS NULL OR grant_row."expires_at" > grant_row."valid_from")
      AND grant_row."paid_amount_usd" = funding."amount_usd"
      AND grant_row."bonus_amount_usd" = COALESCE((
        SELECT SUM(bonus_tx."amount_usd")
        FROM "balance_transactions" bonus_tx
        WHERE bonus_tx."billing_account_id" = target_account_id
          AND bonus_tx."order_id" = funding."order_id"
          AND bonus_tx."type"::TEXT = 'ADJUST'
          AND bonus_tx."description" ~ '^recharge-bonus(?: tier:[^[:space:]]+)?$'
      ), 0)
      AND (SELECT COUNT(*) FROM "balance_transactions" paid_tx
        WHERE paid_tx."billing_account_id" = target_account_id
          AND paid_tx."order_id" = funding."order_id"
          AND paid_tx."type"::TEXT = 'RECHARGE') = 1
      AND NOT EXISTS (
        SELECT 1 FROM "balance_transactions" unsupported
        WHERE unsupported."billing_account_id" = target_account_id
          AND unsupported."order_id" = funding."order_id"
          AND unsupported."amount_usd" > 0
          AND NOT (
            unsupported."type"::TEXT = 'RECHARGE'
            OR (
              unsupported."type"::TEXT = 'ADJUST'
              AND unsupported."description" ~ '^recharge-bonus(?: tier:[^[:space:]]+)?$'
            )
          )
      )
      AND (
        funding."operation_key" IS NULL
        OR funding."operation_key" = 'balance:recharge:' || funding."order_id" || ':paid'
      )

    UNION ALL

    SELECT funding."id", grant_row."id", 'PAID'::TEXT
    FROM positive_funding funding
    JOIN "balance_grants" grant_row
      ON grant_row."billing_account_id" = target_account_id
      AND grant_row."order_id" IS NULL
    WHERE funding."type"::TEXT = 'RECHARGE'
      AND funding."order_id" IS NULL
      AND grant_row."source" = 'RECHARGE'
      AND grant_row."user_id" = funding."user_id"
      AND grant_row."tenant_id" = funding."tenant_id"
      AND grant_row."product_id" IS NOT DISTINCT FROM funding."product_id"
      AND grant_row."paid_amount_usd" = funding."amount_usd"
      AND grant_row."bonus_amount_usd" = 0
      AND grant_row."granted_amount_usd" = funding."amount_usd"
      AND grant_row."created_at" = funding."created_at"
      AND grant_row."valid_from" >= grant_row."created_at"
      AND (
        grant_row."valid_from" <= grant_row."created_at"
        OR "balance_legacy_grant_valid_from_is_repair_proven"(
          funding."id",
          grant_row."valid_from"
        )
      )
      AND (grant_row."expires_at" IS NULL OR grant_row."expires_at" > grant_row."valid_from")
      AND (
        funding."operation_key" IS NULL
        OR funding."operation_key" = 'balance:admin-recharge:grant:' || grant_row."id"
      )
      AND (
        funding."operation_key" IS NULL
        OR funding."operation_key" ~ '^balance:admin-recharge:grant:[^[:space:]]+$'
      )

    UNION ALL

    SELECT funding."id", grant_row."id", 'BONUS'::TEXT
    FROM positive_funding funding
    JOIN "balance_transactions" paid_tx
      ON paid_tx."billing_account_id" = target_account_id
      AND paid_tx."order_id" = funding."order_id"
      AND paid_tx."type"::TEXT = 'RECHARGE'
    JOIN "balance_grants" grant_row
      ON grant_row."billing_account_id" = target_account_id
      AND grant_row."order_id" = funding."order_id"
    WHERE funding."type"::TEXT = 'ADJUST'
      AND funding."order_id" IS NOT NULL
      AND funding."description" ~ '^recharge-bonus(?: tier:[^[:space:]]+)?$'
      AND grant_row."source" = 'RECHARGE'
      AND grant_row."user_id" = funding."user_id"
      AND grant_row."tenant_id" = funding."tenant_id"
      AND grant_row."product_id" IS NOT DISTINCT FROM funding."product_id"
      AND paid_tx."user_id" = grant_row."user_id"
      AND paid_tx."tenant_id" = grant_row."tenant_id"
      AND paid_tx."product_id" IS NOT DISTINCT FROM grant_row."product_id"
      AND grant_row."created_at" = paid_tx."created_at"
      AND grant_row."valid_from" >= grant_row."created_at"
      AND (
        grant_row."valid_from" <= grant_row."created_at"
        OR "balance_legacy_grant_valid_from_is_repair_proven"(
          paid_tx."id",
          grant_row."valid_from"
        )
      )
      AND (grant_row."expires_at" IS NULL OR grant_row."expires_at" > grant_row."valid_from")
      AND funding."created_at" >= paid_tx."created_at"
      AND grant_row."paid_amount_usd" = paid_tx."amount_usd"
      AND grant_row."bonus_amount_usd" = COALESCE((
        SELECT SUM(bonus_tx."amount_usd")
        FROM "balance_transactions" bonus_tx
        WHERE bonus_tx."billing_account_id" = target_account_id
          AND bonus_tx."order_id" = funding."order_id"
          AND bonus_tx."type"::TEXT = 'ADJUST'
          AND bonus_tx."description" ~ '^recharge-bonus(?: tier:[^[:space:]]+)?$'
      ), 0)
      AND (SELECT COUNT(*) FROM "balance_transactions" paid_count
        WHERE paid_count."billing_account_id" = target_account_id
          AND paid_count."order_id" = funding."order_id"
          AND paid_count."type"::TEXT = 'RECHARGE') = 1
      AND (
        paid_tx."operation_key" IS NULL
        OR paid_tx."operation_key" = 'balance:recharge:' || funding."order_id" || ':paid'
      )

    UNION ALL

    SELECT funding."id", grant_row."id", 'BONUS'::TEXT
    FROM positive_funding funding
    JOIN "balance_grants" grant_row
      ON grant_row."billing_account_id" = target_account_id
      AND grant_row."id" = substring(
        funding."description" FROM '^voucher:([^[:space:]]+)'
      )
    WHERE funding."type"::TEXT = 'ADJUST'
      AND funding."order_id" IS NULL
      AND funding."description"
        ~ '^voucher:[^[:space:]]+[[:space:]]+[^[:space:]](?:.*[^[:space:]])?$'
      AND grant_row."source" = 'VOUCHER'
      AND grant_row."user_id" = funding."user_id"
      AND grant_row."tenant_id" = funding."tenant_id"
      AND grant_row."product_id" IS NOT DISTINCT FROM funding."product_id"
      AND grant_row."order_id" IS NULL
      AND grant_row."paid_amount_usd" = 0
      AND grant_row."bonus_amount_usd" = funding."amount_usd"
      AND grant_row."granted_amount_usd" = funding."amount_usd"
      AND grant_row."created_at" = funding."created_at"
      AND grant_row."valid_from" >= grant_row."created_at"
      AND (
        grant_row."valid_from" <= grant_row."created_at"
        OR "balance_legacy_grant_valid_from_is_repair_proven"(
          funding."id",
          grant_row."valid_from"
        )
      )
      AND (grant_row."expires_at" IS NULL OR grant_row."expires_at" > grant_row."valid_from")
      AND (
        funding."operation_key" IS NULL
        OR funding."operation_key" = 'balance:voucher:grant:' || grant_row."id"
      )
      AND (SELECT COUNT(*) FROM "balance_transactions" voucher_tx
        WHERE voucher_tx."billing_account_id" = target_account_id
          AND voucher_tx."description"
            ~ '^voucher:[^[:space:]]+[[:space:]]+[^[:space:]](?:.*[^[:space:]])?$'
          AND substring(voucher_tx."description" FROM '^voucher:([^[:space:]]+)')
            = grant_row."id") = 1

  ), funding_cardinality AS (
    SELECT funding."id" AS funding_id, COUNT(candidate.funding_id) AS candidate_count
    FROM positive_funding funding
    LEFT JOIN funding_candidates candidate ON candidate.funding_id = funding."id"
    GROUP BY funding."id"
  ), grant_funding AS (
    SELECT candidate.grant_id,
      COALESCE(SUM(funding."amount_usd") FILTER (WHERE candidate.nature = 'PAID'), 0)
        AS paid_usd,
      COALESCE(SUM(funding."amount_usd") FILTER (WHERE candidate.nature = 'BONUS'), 0)
        AS bonus_usd
    FROM funding_candidates candidate
    JOIN positive_funding funding ON funding."id" = candidate.funding_id
    WHERE candidate.grant_id IS NOT NULL
    GROUP BY candidate.grant_id
  )
  SELECT
    (SELECT COUNT(*) FROM funding_cardinality WHERE candidate_count <> 1)
    + (SELECT COUNT(*)
      FROM "balance_grants" grant_row
      LEFT JOIN grant_funding aggregate ON aggregate.grant_id = grant_row."id"
      WHERE grant_row."billing_account_id" = target_account_id
        AND (
          grant_row."paid_amount_usd" IS DISTINCT FROM COALESCE(aggregate.paid_usd, 0)
          OR grant_row."bonus_amount_usd" IS DISTINCT FROM COALESCE(aggregate.bonus_usd, 0)
        ))
  INTO invalid_funding_count;

  SELECT
    COALESCE(SUM(bg."remaining_amount_usd") FILTER (
      WHERE NOT bg."is_expired"
        AND bg."valid_from"
          <= account_row."balance_grant_ledger_reconciled_at"
        AND (
          bg."expires_at" IS NULL
          OR bg."expires_at"
            > account_row."balance_grant_ledger_reconciled_at"
        )
    ), 0),
    COUNT(*) FILTER (
      WHERE bg."paid_amount_usd" < 0
        OR bg."bonus_amount_usd" < 0
        OR bg."granted_amount_usd" <= 0
        OR bg."paid_amount_usd" + bg."bonus_amount_usd" <> bg."granted_amount_usd"
        OR bg."discount_rate" IS DISTINCT FROM CASE
          WHEN bg."granted_amount_usd" > 0
            THEN ROUND(bg."paid_amount_usd" / bg."granted_amount_usd", 12)
          ELSE 0
        END
        OR bg."remaining_amount_usd" < 0
        OR bg."remaining_paid_amount_usd" IS NULL
        OR bg."remaining_bonus_amount_usd" IS NULL
        OR bg."remaining_paid_amount_usd" < 0
        OR bg."remaining_bonus_amount_usd" < 0
        OR bg."remaining_amount_usd"
          <> bg."remaining_paid_amount_usd" + bg."remaining_bonus_amount_usd"
        OR bg."remaining_paid_amount_usd" > bg."paid_amount_usd"
        OR bg."remaining_bonus_amount_usd" > bg."bonus_amount_usd"
        OR (
          bg."valid_from" > bg."created_at"
          AND NOT EXISTS (
            SELECT 1
            FROM "balance_funding_candidates"(
              target_account_id,
              account_row."type"
            ) proven_funding
            WHERE proven_funding.grant_id = bg."id"
          )
        )
        OR (
          bg."expires_at" IS NOT NULL
          AND bg."expires_at" <= bg."valid_from"
        )
        OR (
          NOT bg."is_expired"
          AND bg."remaining_amount_usd" > 0
          AND bg."expires_at" IS NOT NULL
          AND bg."expires_at"
            <= account_row."balance_grant_ledger_reconciled_at"
        )
        OR bg."is_expired"
    )
  INTO active_grant_amount, invalid_grant_count
  FROM "balance_grants" bg
  WHERE bg."billing_account_id" = target_account_id;

  SELECT
    COALESCE(SUM(bca."amount_usd" - bca."settled_usd") FILTER (
      WHERE bca."source" = expected_debt_source
    ), 0),
    COUNT(*) FILTER (
      WHERE bca."ledger_sequence" IS NULL
        OR bca."ledger_sequence" = 0
        OR bca."amount_usd" <= 0
        OR bt."id" IS NULL
        OR bt."billing_account_id" IS DISTINCT FROM target_account_id
        OR bt."type"::TEXT <> 'CONSUME'
        OR bca."user_id" IS DISTINCT FROM bt."user_id"
        OR bca."tenant_id" IS DISTINCT FROM bt."tenant_id"
        OR bca."product_id" IS DISTINCT FROM bt."product_id"
        OR bca."token_usage_id" IS DISTINCT FROM bt."token_usage_id"
        OR (
          bca."source" = 'BALANCE_GRANT'
          AND (
            bg."id" IS NULL
            OR bg."billing_account_id" IS DISTINCT FROM target_account_id
            OR bca."recognized_revenue_usd" < 0
            OR bca."bonus_consumed_usd" < 0
            OR bca."recognized_revenue_usd" + bca."bonus_consumed_usd" <> bca."amount_usd"
            OR bca."discount_rate" IS DISTINCT FROM CASE
              WHEN bca."amount_usd" > 0 THEN ROUND(
                bca."recognized_revenue_usd" / bca."amount_usd",
                12
              )
              ELSE 0
            END
            OR bca."settled_usd" <> 0
            OR bca."settled_at" IS NOT NULL
          )
        )
        OR (
          bca."source" = expected_debt_source
          AND (
            bca."balance_grant_id" IS NOT NULL
            OR bca."discount_rate" <> 0
            OR bca."settled_usd" < 0
            OR bca."settled_usd" > bca."amount_usd"
            OR bca."recognized_revenue_usd" < 0
            OR bca."bonus_consumed_usd" < 0
            OR bca."recognized_revenue_usd" + bca."bonus_consumed_usd" <> bca."settled_usd"
            OR (bca."settled_usd" = bca."amount_usd")
              IS DISTINCT FROM (bca."settled_at" IS NOT NULL)
            OR bca."settled_usd" IS DISTINCT FROM COALESCE((
              SELECT SUM(s."amount_usd") FROM "enterprise_credit_settlements" s
              WHERE s."allocation_id" = bca."id"
            ), 0)
            OR bca."recognized_revenue_usd" IS DISTINCT FROM COALESCE((
              SELECT SUM(s."paid_usd") FROM "enterprise_credit_settlements" s
              WHERE s."allocation_id" = bca."id"
            ), 0)
            OR bca."bonus_consumed_usd" IS DISTINCT FROM COALESCE((
              SELECT SUM(s."bonus_usd") FROM "enterprise_credit_settlements" s
              WHERE s."allocation_id" = bca."id"
            ), 0)
          )
        )
        OR bca."source" NOT IN ('BALANCE_GRANT', expected_debt_source)
    )
  INTO open_debt_amount, invalid_allocation_count
  FROM "balance_consumption_allocations" bca
  LEFT JOIN "balance_transactions" bt ON bt."id" = bca."balance_transaction_id"
  LEFT JOIN "balance_grants" bg ON bg."id" = bca."balance_grant_id"
  WHERE bca."billing_account_id" = target_account_id;

  invalid_allocation_count := invalid_allocation_count + (
    SELECT COUNT(*)
    FROM "balance_consumption_allocations" foreign_allocation
    JOIN "balance_transactions" target_transaction
      ON target_transaction."id" = foreign_allocation."balance_transaction_id"
    WHERE target_transaction."billing_account_id" = target_account_id
      AND foreign_allocation."billing_account_id" IS DISTINCT FROM target_account_id
  ) + (
    SELECT COUNT(*)
    FROM "balance_consumption_allocations" foreign_allocation
    JOIN "balance_grants" target_grant
      ON target_grant."id" = foreign_allocation."balance_grant_id"
    WHERE target_grant."billing_account_id" = target_account_id
      AND foreign_allocation."billing_account_id" IS DISTINCT FROM target_account_id
  ) + (
    SELECT COUNT(*)
    FROM "enterprise_credit_settlements" foreign_settlement
    JOIN "balance_grants" target_grant
      ON target_grant."id" = foreign_settlement."balance_grant_id"
    WHERE target_grant."billing_account_id" = target_account_id
      AND foreign_settlement."billing_account_id" IS DISTINCT FROM target_account_id
  );

  SELECT COUNT(*) INTO invalid_consume_count
  FROM (
    SELECT bt."id"
    FROM "balance_transactions" bt
    LEFT JOIN "balance_consumption_allocations" bca
      ON bca."balance_transaction_id" = bt."id"
      AND bca."billing_account_id" = target_account_id
    WHERE bt."billing_account_id" = target_account_id
      AND bt."type"::TEXT = 'CONSUME'
    GROUP BY bt."id", bt."amount_usd", bt."balance_after_usd"
    HAVING COALESCE(SUM(bca."amount_usd"), 0) <> -bt."amount_usd"
      OR COALESCE(SUM(bca."amount_usd") FILTER (
        WHERE bca."source" = 'BALANCE_GRANT'
      ), 0) <> LEAST(
        -bt."amount_usd",
        GREATEST(bt."balance_after_usd" - bt."amount_usd", 0)
      )
      OR COALESCE(SUM(bca."amount_usd") FILTER (
        WHERE bca."source" = expected_debt_source
      ), 0) <> -bt."amount_usd" - LEAST(
        -bt."amount_usd",
        GREATEST(bt."balance_after_usd" - bt."amount_usd", 0)
      )
      OR COUNT(*) FILTER (
        WHERE bca."source" = expected_debt_source
      ) <> CASE
        WHEN -bt."amount_usd" - LEAST(
          -bt."amount_usd",
          GREATEST(bt."balance_after_usd" - bt."amount_usd", 0)
        ) > 0 THEN 1
        ELSE 0
      END
  ) invalid_consume;

  SELECT COUNT(*), COUNT(*) FILTER (
    WHERE s."debt_source" <> expected_debt_source
      OR s."operation_key" IS NULL
      OR (
        s."operation_key" LIKE 'legacy:%'
        AND s."operation_key" <> 'legacy:' || s."id"
      )
      OR s."amount_usd" <= 0
      OR s."paid_usd" < 0
      OR s."bonus_usd" < 0
      OR s."amount_usd" <> s."paid_usd" + s."bonus_usd"
      OR bca."id" IS NULL
      OR bca."billing_account_id" IS DISTINCT FROM target_account_id
      OR bca."source" <> expected_debt_source
      OR bt."id" IS NULL
      OR bt."billing_account_id" IS DISTINCT FROM target_account_id
      OR bt."type"::TEXT NOT IN ('RECHARGE', 'ADJUST')
      OR bt."amount_usd" <= 0
      OR s."occurred_at" <> bt."created_at"
      OR (s."balance_grant_id" IS NOT NULL AND (
        bg."id" IS NULL OR bg."billing_account_id" IS DISTINCT FROM target_account_id
      ))
      OR (expected_settlement_mode = 'CREATE' AND (
        s."repair_run_id" IS DISTINCT FROM target_run_id
        OR s."trigger" <> 'REPAIR'
        OR s."balance_grant_id" IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM "balance_ledger_allocation_repairs" ar
          WHERE ar."run_id" = target_run_id
            AND ar."billing_account_id" = target_account_id
            AND ar."allocation_id" = s."allocation_id"
            AND ar."after_snapshot" = to_jsonb(bca)
        )
      ))
      OR (expected_settlement_mode = 'VERIFY_EXISTING' AND (
        s."repair_run_id" IS NOT NULL OR s."trigger" <> 'FUNDING'
      ))
  )
  INTO settlement_count, invalid_settlement_count
  FROM "enterprise_credit_settlements" s
  LEFT JOIN "balance_consumption_allocations" bca ON bca."id" = s."allocation_id"
  LEFT JOIN "balance_transactions" bt ON bt."id" = s."repayment_transaction_id"
  LEFT JOIN "balance_grants" bg ON bg."id" = s."balance_grant_id"
  WHERE s."billing_account_id" = target_account_id;

  SELECT COUNT(*) INTO invalid_grant_conservation_count
  FROM "balance_grants" bg
  WHERE bg."billing_account_id" = target_account_id
    AND (
      bg."paid_amount_usd" IS DISTINCT FROM (
        bg."remaining_paid_amount_usd"
        + COALESCE((SELECT SUM(bca."recognized_revenue_usd")
          FROM "balance_consumption_allocations" bca
          WHERE bca."balance_grant_id" = bg."id"
            AND bca."billing_account_id" = target_account_id
            AND bca."source" = 'BALANCE_GRANT'), 0)
        + COALESCE((SELECT SUM(s."paid_usd")
          FROM "enterprise_credit_settlements" s
          WHERE s."balance_grant_id" = bg."id"
            AND s."billing_account_id" = target_account_id), 0)
      )
      OR bg."bonus_amount_usd" IS DISTINCT FROM (
        bg."remaining_bonus_amount_usd"
        + COALESCE((SELECT SUM(bca."bonus_consumed_usd")
          FROM "balance_consumption_allocations" bca
          WHERE bca."balance_grant_id" = bg."id"
            AND bca."billing_account_id" = target_account_id
            AND bca."source" = 'BALANCE_GRANT'), 0)
        + COALESCE((SELECT SUM(s."bonus_usd")
          FROM "enterprise_credit_settlements" s
          WHERE s."balance_grant_id" = bg."id"
            AND s."billing_account_id" = target_account_id), 0)
      )
    );

  PERFORM "assert_balance_ledger_canonical_replay"(
    target_account_id,
    account_row."type",
    expected_debt_source,
    expected_settlement_mode,
    target_run_id,
    wallet_path_ids
  );

  IF require_empty THEN
    transaction_repair_count := 0;
    invalid_transaction_repair_count := 0;
    allocation_repair_count := 0;
    invalid_allocation_repair_count := 0;
    invalid_grant_mutation_count := 0;
  ELSE
    SELECT COUNT(*), COUNT(*) FILTER (
      WHERE tr."operation_key" IS DISTINCT FROM (
        'repair:transaction-sequence:' || target_run_id || ':' || tr."transaction_id"
      )
        OR tr."repair_account_id" IS DISTINCT FROM repair_row."id"
        OR tr."billing_account_id" IS DISTINCT FROM target_account_id
        OR tr."before_snapshot"->'ledger_sequence' <> 'null'::JSONB
        OR (tr."after_snapshot"->>'ledger_sequence')::BIGINT >= 0
        OR (tr."before_snapshot" - 'ledger_sequence')
          IS DISTINCT FROM (tr."after_snapshot" - 'ledger_sequence')
        OR bt."id" IS NULL
        OR tr."after_snapshot" IS DISTINCT FROM to_jsonb(bt)
    )
    INTO transaction_repair_count, invalid_transaction_repair_count
    FROM "balance_ledger_transaction_repairs" tr
    LEFT JOIN "balance_transactions" bt ON bt."id" = tr."transaction_id"
    WHERE tr."run_id" = target_run_id
      AND tr."billing_account_id" = target_account_id;

    SELECT COUNT(*), COUNT(*) FILTER (
      WHERE ar."operation_key" IS DISTINCT FROM (
        'repair:allocation:' || target_run_id || ':' || ar."allocation_id"
      )
        OR ar."repair_account_id" IS DISTINCT FROM repair_row."id"
        OR ar."billing_account_id" IS DISTINCT FROM target_account_id
        OR ar."before_snapshot" IS NOT DISTINCT FROM ar."after_snapshot"
        OR bca."id" IS NULL
        OR ar."after_snapshot" IS DISTINCT FROM to_jsonb(bca)
    )
    INTO allocation_repair_count, invalid_allocation_repair_count
    FROM "balance_ledger_allocation_repairs" ar
    LEFT JOIN "balance_consumption_allocations" bca ON bca."id" = ar."allocation_id"
    WHERE ar."run_id" = target_run_id
      AND ar."billing_account_id" = target_account_id;

    WITH before_grants AS (
      SELECT value AS snapshot, value->>'id' AS grant_id
      FROM jsonb_array_elements(COALESCE(
        repair_row."before_snapshot"->'grants',
        '[]'::JSONB
      ))
    ), mutations AS (
      SELECT value AS mutation, value->>'grantId' AS grant_id
      FROM jsonb_array_elements(COALESCE(
        repair_row."after_snapshot"->'grantMutations',
        '[]'::JSONB
      ))
    ), current_grants AS (
      SELECT bg.*
      FROM "balance_grants" bg
      WHERE bg."billing_account_id" = target_account_id
    )
    SELECT
      (SELECT COUNT(*) FROM current_grants current
        LEFT JOIN before_grants before ON before.grant_id = current."id"
        WHERE before.grant_id IS NULL)
      + (SELECT COUNT(*) FROM before_grants before
        LEFT JOIN current_grants current ON current."id" = before.grant_id
        WHERE current."id" IS NULL)
      + (SELECT COUNT(*) FROM (
          SELECT grant_id FROM before_grants GROUP BY grant_id HAVING COUNT(*) <> 1
        ) duplicate_before)
      + (SELECT COUNT(*) FROM (
          SELECT grant_id FROM mutations GROUP BY grant_id HAVING COUNT(*) <> 1
        ) duplicate_mutation)
      + (SELECT COUNT(*)
        FROM current_grants current
        JOIN before_grants before ON before.grant_id = current."id"
        LEFT JOIN mutations mutation ON mutation.grant_id = current."id"
        WHERE (
          current."remaining_amount_usd"
            IS DISTINCT FROM (before.snapshot->>'remainingAmountUsd')::NUMERIC
          OR current."remaining_paid_amount_usd"
            IS DISTINCT FROM (before.snapshot->>'remainingPaidAmountUsd')::NUMERIC
          OR current."remaining_bonus_amount_usd"
            IS DISTINCT FROM (before.snapshot->>'remainingBonusAmountUsd')::NUMERIC
        ) IS DISTINCT FROM (mutation.grant_id IS NOT NULL)
          OR (
            mutation.grant_id IS NOT NULL
            AND (
              (mutation.mutation->>'expectedRemainingAmountUsd')::NUMERIC
                IS DISTINCT FROM (before.snapshot->>'remainingAmountUsd')::NUMERIC
              OR (mutation.mutation->>'expectedRemainingPaidAmountUsd')::NUMERIC
                IS DISTINCT FROM (before.snapshot->>'remainingPaidAmountUsd')::NUMERIC
              OR (mutation.mutation->>'expectedRemainingBonusAmountUsd')::NUMERIC
                IS DISTINCT FROM (before.snapshot->>'remainingBonusAmountUsd')::NUMERIC
              OR (mutation.mutation->>'remainingAmountUsd')::NUMERIC
                IS DISTINCT FROM current."remaining_amount_usd"
              OR (mutation.mutation->>'remainingPaidAmountUsd')::NUMERIC
                IS DISTINCT FROM current."remaining_paid_amount_usd"
              OR (mutation.mutation->>'remainingBonusAmountUsd')::NUMERIC
                IS DISTINCT FROM current."remaining_bonus_amount_usd"
            )
          )
      )
      + (SELECT COUNT(*) FROM mutations mutation
        LEFT JOIN current_grants current ON current."id" = mutation.grant_id
        WHERE current."id" IS NULL)
    INTO invalid_grant_mutation_count;
  END IF;

  SELECT COUNT(*) INTO expiry_count
  FROM "balance_grant_expiries" WHERE "billing_account_id" = target_account_id;
  SELECT COUNT(*) INTO refund_count
  FROM "balance_grant_refunds" WHERE "billing_account_id" = target_account_id;
  SELECT COUNT(*) INTO invoice_item_count
  FROM "invoice_application_items" item
  JOIN "balance_grants" bg ON bg."order_id" = item."order_id"
  WHERE bg."billing_account_id" = target_account_id;

  IF transaction_total IS DISTINCT FROM wallet_balance
    OR invalid_transaction_count <> 0
    OR invalid_funding_count <> 0
    OR (NOT require_empty AND transaction_count = 0
      AND account_row."balance_grant_ledger_through_transaction_id" IS NOT NULL)
    OR (NOT require_empty AND transaction_count > 0 AND through_count <> 1)
    OR active_grant_amount IS DISTINCT FROM GREATEST(wallet_balance, 0)
    OR open_debt_amount IS DISTINCT FROM GREATEST(-wallet_balance, 0)
    OR invalid_grant_count <> 0
    OR invalid_allocation_count <> 0
    OR invalid_consume_count <> 0
    OR invalid_settlement_count <> 0
    OR invalid_grant_conservation_count <> 0
    OR invalid_transaction_repair_count <> 0
    OR invalid_allocation_repair_count <> 0
    OR invalid_grant_mutation_count <> 0
    OR expiry_count <> 0
    OR refund_count <> 0
    OR invoice_item_count <> 0
  THEN
    RAISE EXCEPTION
      'balance ledger canonical promotion invalid account=% wallet=% tx=%/% grant=% debt=% invalid(tx/funding/grant/allocation/consume/settlement/conservation/txAudit/allocationAudit/grantMutation)=%/%/%/%/%/%/%/%/%/% facts(expiry/refund/invoice)=%/%/%',
      target_account_id, wallet_balance, transaction_total, transaction_count,
      active_grant_amount, open_debt_amount,
      invalid_transaction_count, invalid_funding_count, invalid_grant_count, invalid_allocation_count,
      invalid_consume_count, invalid_settlement_count,
      invalid_grant_conservation_count, invalid_transaction_repair_count,
      invalid_allocation_repair_count,
      invalid_grant_mutation_count, expiry_count, refund_count, invoice_item_count
      USING ERRCODE = '23514';
  END IF;

  -- Keep the unassigned RECORD wholly outside the EMPTY_V2 branch. PostgreSQL
  -- is free to evaluate boolean operands in any order, so `NOT require_empty
  -- AND repair_row.field ...` is not a safe short-circuit for a RECORD that was
  -- never populated.
  IF NOT require_empty THEN
    IF repair_row."after_snapshot"->>'accountType' IS DISTINCT FROM account_row."type"
      OR repair_row."after_snapshot"->>'debtSource' IS DISTINCT FROM expected_debt_source
      OR repair_row."after_snapshot"->>'settlementWriteMode' IS DISTINCT FROM expected_settlement_mode
      OR repair_row."after_snapshot"->>'preconditionHash' IS DISTINCT FROM repair_row."precondition_hash"
      OR repair_row."after_snapshot"->>'replayHash' IS DISTINCT FROM repair_row."replay_hash"
      OR (repair_row."after_snapshot"->>'walletBalanceUsd')::NUMERIC IS DISTINCT FROM wallet_balance
      OR (repair_row."after_snapshot"->>'activeGrantUsd')::NUMERIC IS DISTINCT FROM active_grant_amount
      OR (repair_row."after_snapshot"->>'openDebtUsd')::NUMERIC IS DISTINCT FROM open_debt_amount
      OR repair_row."after_snapshot"->>'transactionTailId'
        IS DISTINCT FROM account_row."balance_grant_ledger_through_transaction_id"
      OR (repair_row."after_snapshot"->>'transactionTailUsd')::NUMERIC
        IS DISTINCT FROM wallet_balance
      OR (repair_row."after_snapshot"->>'settlementCount')::BIGINT IS DISTINCT FROM settlement_count
      OR (repair_row."after_snapshot"->>'transactionRepairCount')::BIGINT
        IS DISTINCT FROM transaction_repair_count
      OR jsonb_array_length(COALESCE(
        repair_row."after_snapshot"->'transactionSequenceMutations',
        '[]'::JSONB
      )) IS DISTINCT FROM transaction_repair_count
      OR EXISTS (
        SELECT 1
        FROM "balance_ledger_transaction_repairs" tr
        WHERE tr."run_id" = target_run_id
          AND tr."billing_account_id" = target_account_id
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(
              repair_row."after_snapshot"->'transactionSequenceMutations',
              '[]'::JSONB
            )) mutation
            WHERE mutation->>'transactionId' = tr."transaction_id"
              AND mutation->>'expectedLedgerSequence' IS NULL
              AND (mutation->>'ledgerSequence')::BIGINT
                = (tr."after_snapshot"->>'ledger_sequence')::BIGINT
          )
      )
      OR (repair_row."after_snapshot"->>'allocationRepairCount')::BIGINT
        IS DISTINCT FROM allocation_repair_count
      OR repair_row."after_snapshot"->>'invalidTransactionSequenceCount' IS DISTINCT FROM '0'
      OR repair_row."after_snapshot"->>'invalidComponentCount' IS DISTINCT FROM '0'
      OR repair_row."after_snapshot"->>'invalidAllocationSequenceCount' IS DISTINCT FROM '0'
      OR repair_row."after_snapshot"->>'invalidGrantAllocationCount' IS DISTINCT FROM '0'
      OR repair_row."after_snapshot"->>'unexpectedDebtCount' IS DISTINCT FROM '0'
      OR repair_row."after_snapshot"->>'invalidSettlementCount' IS DISTINCT FROM '0'
      OR repair_row."after_snapshot"->>'invalidConsumeAllocationCount' IS DISTINCT FROM '0'
      OR repair_row."after_snapshot"->>'invalidGrantConservationCount' IS DISTINCT FROM '0'
      OR repair_row."after_snapshot"->>'ledgerStatus' IS DISTINCT FROM 'RECONCILED_V2'
      OR (repair_row."after_snapshot"->>'ledgerVersion')::INTEGER IS DISTINCT FROM 2
      OR repair_row."after_snapshot"->>'throughTransactionId'
        IS DISTINCT FROM account_row."balance_grant_ledger_through_transaction_id"
      OR ((repair_row."after_snapshot"->>'reconciledAt')::TIMESTAMPTZ AT TIME ZONE 'UTC')
        IS DISTINCT FROM account_row."balance_grant_ledger_reconciled_at"
    THEN
      RAISE EXCEPTION 'balance ledger promotion repair snapshot mismatch: %', target_account_id
        USING ERRCODE = '23514';
    END IF;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION "validate_balance_ledger_clean_promotion"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF TG_OP = 'INSERT' THEN
    IF NEW."balance_grant_ledger_status" = 'RECONCILED_V2' THEN
      PERFORM "assert_balance_ledger_canonical_promotion"(NEW."id", NULL, TRUE);
    END IF;
  ELSIF OLD."balance_grant_ledger_status" <> 'RECONCILED_V2'
    AND NEW."balance_grant_ledger_status" = 'RECONCILED_V2'
  THEN
    PERFORM "assert_balance_ledger_canonical_promotion"(
      NEW."id",
      current_setting('billing.balance_ledger_repair_run_id', TRUE),
      FALSE
    );
  END IF;
  RETURN NEW;
END
$$;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DROP TRIGGER IF EXISTS "billing_accounts_clean_promotion_deferred"
  ON "billing_accounts";
CREATE CONSTRAINT TRIGGER "billing_accounts_clean_promotion_deferred"
AFTER INSERT OR UPDATE ON "billing_accounts"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_balance_ledger_clean_promotion"();
COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
ALTER TABLE "enterprise_credit_settlements"
  DROP CONSTRAINT IF EXISTS "enterprise_credit_settlements_repair_run_id_fkey";
ALTER TABLE "enterprise_credit_settlements"
  ADD CONSTRAINT "enterprise_credit_settlements_repair_run_id_fkey"
  FOREIGN KEY ("repair_run_id") REFERENCES "balance_ledger_repair_runs"("id")
  ON DELETE RESTRICT ON UPDATE RESTRICT NOT VALID;
COMMIT;

CREATE OR REPLACE FUNCTION "reject_append_only_balance_financial_audit_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION '% is append-only: %', TG_TABLE_NAME, OLD."id"
    USING ERRCODE = '23514';
END
$$;

BEGIN;
DROP TRIGGER IF EXISTS "balance_grant_refunds_append_only"
  ON "balance_grant_refunds";
CREATE TRIGGER "balance_grant_refunds_append_only"
BEFORE UPDATE OR DELETE ON "balance_grant_refunds"
FOR EACH ROW
EXECUTE FUNCTION "reject_append_only_balance_financial_audit_mutation"();
COMMIT;

BEGIN;
DROP TRIGGER IF EXISTS "balance_grant_refund_allocations_append_only"
  ON "balance_grant_refund_allocations";
CREATE TRIGGER "balance_grant_refund_allocations_append_only"
BEFORE UPDATE OR DELETE ON "balance_grant_refund_allocations"
FOR EACH ROW
EXECUTE FUNCTION "reject_append_only_balance_financial_audit_mutation"();
COMMIT;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DROP TRIGGER IF EXISTS "enterprise_credit_settlements_append_only"
  ON "enterprise_credit_settlements";
CREATE TRIGGER "enterprise_credit_settlements_append_only"
BEFORE UPDATE OR DELETE ON "enterprise_credit_settlements"
FOR EACH ROW
EXECUTE FUNCTION "reject_append_only_balance_financial_audit_mutation"();
COMMIT;

CREATE OR REPLACE FUNCTION "reject_refund_balance_transaction_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF EXISTS (
    SELECT 1
    FROM "balance_grant_refunds"
    WHERE "refund_transaction_id" = OLD."id"
  ) THEN
    RAISE EXCEPTION 'audited refund balance transaction is immutable: %', OLD."id"
      USING ERRCODE = '23514';
  END IF;
  IF TG_OP = 'DELETE' THEN
    RETURN OLD;
  END IF;
  RETURN NEW;
END
$$;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DROP TRIGGER IF EXISTS "balance_transactions_refund_audit_immutable"
  ON "balance_transactions";
CREATE TRIGGER "balance_transactions_refund_audit_immutable"
BEFORE UPDATE OR DELETE ON "balance_transactions"
FOR EACH ROW
EXECUTE FUNCTION "reject_refund_balance_transaction_mutation"();
COMMIT;

-- The transaction and allocation ledgers are facts, not mutable projections.
-- Protect every row (not only rows already referenced by an expiry/refund
-- audit), and never permit a parent DELETE to erase allocation evidence.
CREATE OR REPLACE FUNCTION "reject_balance_transaction_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  active_run_id TEXT;
  repair_row RECORD;
  audit_row RECORD;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    active_run_id := current_setting('billing.balance_ledger_repair_run_id', TRUE);
    SELECT repair_account.*, repair_run."status" AS run_status
      INTO repair_row
    FROM "balance_ledger_repair_accounts" repair_account
    JOIN "balance_ledger_repair_runs" repair_run
      ON repair_run."id" = repair_account."run_id"
    JOIN "billing_accounts" account
      ON account."id" = repair_account."billing_account_id"
    WHERE repair_account."run_id" = active_run_id
      AND repair_account."billing_account_id" = OLD."billing_account_id"
      AND repair_account."status" = 'RUNNING'
      AND repair_run."status" = 'RUNNING'
      AND account."balance_grant_ledger_status" = 'LEGACY_DIRTY';

    SELECT * INTO audit_row
    FROM "balance_ledger_transaction_repairs"
    WHERE "run_id" = active_run_id
      AND "billing_account_id" = OLD."billing_account_id"
      AND "transaction_id" = OLD."id";

    IF active_run_id IS NOT NULL
      AND repair_row."id" IS NOT NULL
      AND audit_row."id" IS NOT NULL
      AND audit_row."repair_account_id" IS NOT DISTINCT FROM repair_row."id"
      AND OLD."ledger_sequence" IS NULL
      AND NEW."ledger_sequence" < 0
      AND audit_row."before_snapshot" IS NOT DISTINCT FROM to_jsonb(OLD)
      AND audit_row."after_snapshot" IS NOT DISTINCT FROM to_jsonb(NEW)
    THEN
      RETURN NEW;
    END IF;
  END IF;
  RAISE EXCEPTION 'balance transactions are append-only: %', OLD."id"
    USING ERRCODE = '23514';
END
$$;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DROP TRIGGER IF EXISTS "balance_transactions_append_only"
  ON "balance_transactions";
CREATE TRIGGER "balance_transactions_append_only"
BEFORE UPDATE OR DELETE ON "balance_transactions"
FOR EACH ROW
EXECUTE FUNCTION "reject_balance_transaction_mutation"();
COMMIT;

CREATE OR REPLACE FUNCTION "reject_balance_consumption_allocation_delete"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'balance consumption allocations cannot be deleted: %', OLD."id"
    USING ERRCODE = '23514';
END
$$;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DROP TRIGGER IF EXISTS "balance_consumption_allocations_delete_guard"
  ON "balance_consumption_allocations";
CREATE TRIGGER "balance_consumption_allocations_delete_guard"
BEFORE DELETE ON "balance_consumption_allocations"
FOR EACH ROW
EXECUTE FUNCTION "reject_balance_consumption_allocation_delete"();
COMMIT;

CREATE OR REPLACE FUNCTION "reject_balance_grant_delete"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'balance grants cannot be deleted: %', OLD."id"
    USING ERRCODE = '23514';
END
$$;

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';
DROP TRIGGER IF EXISTS "balance_grants_delete_guard"
  ON "balance_grants";
CREATE TRIGGER "balance_grants_delete_guard"
BEFORE DELETE ON "balance_grants"
FOR EACH ROW
EXECUTE FUNCTION "reject_balance_grant_delete"();
COMMIT;

CREATE OR REPLACE FUNCTION "guard_balance_ledger_rollout_control_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  transition_kind TEXT;
  current_system_identifier NUMERIC(20, 0);
  current_database_oid OID;
BEGIN
  IF TG_OP = 'DELETE' THEN
    RAISE EXCEPTION 'balance ledger rollout control cannot be deleted'
      USING ERRCODE = '23514';
  END IF;

  transition_kind := current_setting(
    'billing.balance_ledger_rollout_transition',
    TRUE
  );
  SELECT "system_identifier"::NUMERIC(20, 0)
    INTO current_system_identifier
  FROM pg_control_system();
  SELECT oid INTO current_database_oid
  FROM pg_database
  WHERE datname = current_database();

  IF NEW."id" IS DISTINCT FROM OLD."id"
    OR NEW."database_name" IS DISTINCT FROM OLD."database_name"
    OR NEW."expanded_at" IS DISTINCT FROM OLD."expanded_at"
    OR NEW."opening_grant_count_at_expand"
      IS DISTINCT FROM OLD."opening_grant_count_at_expand"
  THEN
    RAISE EXCEPTION 'balance ledger rollout identity is immutable'
      USING ERRCODE = '23514';
  END IF;

  IF transition_kind = 'identity-rotate-v1' THEN
    IF OLD."phase" = 'CUTOVER_READY'
      OR NEW."phase" IS DISTINCT FROM OLD."phase"
      OR NEW."database_identity" IS NOT DISTINCT FROM OLD."database_identity"
      OR NEW."database_system_identifier"
        IS DISTINCT FROM current_system_identifier
      OR NEW."database_oid" IS DISTINCT FROM current_database_oid
      OR NEW."cutover_ready_at" IS DISTINCT FROM OLD."cutover_ready_at"
      OR NEW."v2_contract_at" IS DISTINCT FROM OLD."v2_contract_at"
      OR NEW."operator" IS DISTINCT FROM OLD."operator"
      OR NEW."change_ticket" IS DISTINCT FROM OLD."change_ticket"
      OR NEW."evidence_sha256" IS DISTINCT FROM OLD."evidence_sha256"
      OR NEW."expiry_safe_through" IS DISTINCT FROM OLD."expiry_safe_through"
    THEN
      RAISE EXCEPTION 'invalid balance ledger database identity rotation'
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  IF NEW."database_identity" IS DISTINCT FROM OLD."database_identity"
    OR NEW."database_system_identifier"
      IS DISTINCT FROM OLD."database_system_identifier"
    OR NEW."database_oid" IS DISTINCT FROM OLD."database_oid"
  THEN
    RAISE EXCEPTION 'balance ledger database identity is immutable in phase transition'
      USING ERRCODE = '23514';
  END IF;

  IF transition_kind = 'prepare-v1' THEN
    IF OLD."phase" <> 'EXPANDED'
      OR NEW."phase" <> 'CUTOVER_READY'
      OR NEW."cutover_ready_at" IS NULL
      OR NEW."cutover_ready_at" < OLD."expanded_at"
      OR NEW."v2_contract_at" IS NOT NULL
      OR NEW."operator" IS NULL
      OR btrim(NEW."operator") = ''
      OR NEW."change_ticket" IS NULL
      OR btrim(NEW."change_ticket") = ''
      OR NEW."evidence_sha256" !~ '^[0-9a-f]{64}$'
      OR NEW."expiry_safe_through" IS NULL
      OR NEW."expiry_safe_through"
        < NEW."cutover_ready_at" + INTERVAL '15 minutes'
    THEN
      RAISE EXCEPTION 'invalid EXPANDED -> CUTOVER_READY transition'
        USING ERRCODE = '23514';
    END IF;
  ELSIF transition_kind = 'prepare-refresh-v1' THEN
    IF OLD."phase" <> 'CUTOVER_READY'
      OR NEW."phase" <> 'CUTOVER_READY'
      OR OLD."v2_contract_at" IS NOT NULL
      OR NEW."v2_contract_at" IS NOT NULL
      OR NEW."cutover_ready_at" IS NULL
      OR NEW."cutover_ready_at" < OLD."cutover_ready_at"
      OR NEW."operator" IS NULL
      OR btrim(NEW."operator") = ''
      OR NEW."change_ticket" IS NULL
      OR btrim(NEW."change_ticket") = ''
      OR NEW."evidence_sha256" !~ '^[0-9a-f]{64}$'
      OR NEW."expiry_safe_through" IS NULL
      OR NEW."expiry_safe_through"
        < NEW."cutover_ready_at" + INTERVAL '15 minutes'
    THEN
      RAISE EXCEPTION 'invalid CUTOVER_READY proof refresh'
        USING ERRCODE = '23514';
    END IF;
  ELSIF transition_kind = 'contract-v1' THEN
    IF OLD."phase" <> 'CUTOVER_READY'
      OR NEW."phase" <> 'V2_CONTRACT'
      OR NEW."cutover_ready_at" IS DISTINCT FROM OLD."cutover_ready_at"
      OR NEW."operator" IS DISTINCT FROM OLD."operator"
      OR NEW."change_ticket" IS DISTINCT FROM OLD."change_ticket"
      OR NEW."evidence_sha256" IS DISTINCT FROM OLD."evidence_sha256"
      OR NEW."expiry_safe_through" IS DISTINCT FROM OLD."expiry_safe_through"
      OR NEW."v2_contract_at" IS NULL
      OR NEW."v2_contract_at" < OLD."cutover_ready_at"
    THEN
      RAISE EXCEPTION 'invalid CUTOVER_READY -> V2_CONTRACT transition'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'balance ledger rollout transition is not authorized'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "audit_balance_ledger_rollout_transition"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  transition_kind TEXT;
BEGIN
  transition_kind := current_setting(
    'billing.balance_ledger_rollout_transition',
    TRUE
  );
  IF NEW."phase" IS NOT DISTINCT FROM OLD."phase"
    AND transition_kind IS DISTINCT FROM 'prepare-refresh-v1'
  THEN
    RETURN NULL;
  END IF;
  INSERT INTO "balance_ledger_rollout_transitions" (
    "from_phase",
    "to_phase",
    "database_name",
    "database_identity",
    "database_system_identifier",
    "database_oid",
    "operator",
    "change_ticket",
    "evidence_sha256",
    "expiry_safe_through",
    "created_at"
  ) VALUES (
    OLD."phase",
    NEW."phase",
    NEW."database_name",
    NEW."database_identity",
    NEW."database_system_identifier",
    NEW."database_oid",
    NEW."operator",
    NEW."change_ticket",
    NEW."evidence_sha256",
    NEW."expiry_safe_through",
    CASE
      WHEN NEW."phase" = 'V2_CONTRACT' THEN NEW."v2_contract_at"
      ELSE NEW."cutover_ready_at"
    END
  );
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION "reject_balance_ledger_rollout_audit_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  transition_kind TEXT;
  control_row "balance_ledger_rollout_control"%ROWTYPE;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'balance ledger rollout audit is append-only: %', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  transition_kind := current_setting(
    'billing.balance_ledger_rollout_transition',
    TRUE
  );
  SELECT * INTO control_row
  FROM "balance_ledger_rollout_control"
  WHERE "id" = 1;

  IF transition_kind = 'expand-v1' THEN
    IF control_row."phase" IS DISTINCT FROM 'EXPANDED'
      OR NEW."from_phase" <> 'NOT_INSTALLED'
      OR NEW."to_phase" <> 'EXPANDED'
      OR NEW."database_name" IS DISTINCT FROM control_row."database_name"
      OR NEW."database_identity"
        IS DISTINCT FROM control_row."database_identity"
      OR NEW."database_system_identifier"
        IS DISTINCT FROM control_row."database_system_identifier"
      OR NEW."database_oid" IS DISTINCT FROM control_row."database_oid"
      OR NEW."operator" <> 'migration'
      OR NEW."change_ticket"
        <> '20260715000100_personal_negative_balance_settlement'
      OR NEW."evidence_sha256" <> repeat('0', 64)
      OR NEW."expiry_safe_through" IS DISTINCT FROM control_row."expanded_at"
      OR NEW."created_at" IS DISTINCT FROM control_row."expanded_at"
    THEN
      RAISE EXCEPTION 'invalid rollout expansion audit insert'
        USING ERRCODE = '23514';
    END IF;
  ELSIF transition_kind IN ('prepare-v1', 'prepare-refresh-v1') THEN
    IF pg_trigger_depth() < 2
      OR control_row."phase" IS DISTINCT FROM 'CUTOVER_READY'
      OR NEW."from_phase" <> (CASE
        WHEN transition_kind = 'prepare-v1' THEN 'EXPANDED'
        ELSE 'CUTOVER_READY'
      END)
      OR NEW."to_phase" <> 'CUTOVER_READY'
      OR NEW."database_name" IS DISTINCT FROM control_row."database_name"
      OR NEW."database_identity"
        IS DISTINCT FROM control_row."database_identity"
      OR NEW."database_system_identifier"
        IS DISTINCT FROM control_row."database_system_identifier"
      OR NEW."database_oid" IS DISTINCT FROM control_row."database_oid"
      OR NEW."operator" IS DISTINCT FROM control_row."operator"
      OR NEW."change_ticket" IS DISTINCT FROM control_row."change_ticket"
      OR NEW."evidence_sha256" IS DISTINCT FROM control_row."evidence_sha256"
      OR NEW."expiry_safe_through"
        IS DISTINCT FROM control_row."expiry_safe_through"
      OR NEW."created_at" IS DISTINCT FROM control_row."cutover_ready_at"
    THEN
      RAISE EXCEPTION 'invalid rollout prepare/refresh audit insert'
        USING ERRCODE = '23514';
    END IF;
  ELSIF transition_kind = 'contract-v1' THEN
    IF pg_trigger_depth() < 2
      OR control_row."phase" IS DISTINCT FROM 'V2_CONTRACT'
      OR NEW."from_phase" <> 'CUTOVER_READY'
      OR NEW."to_phase" <> 'V2_CONTRACT'
      OR NEW."database_name" IS DISTINCT FROM control_row."database_name"
      OR NEW."database_identity"
        IS DISTINCT FROM control_row."database_identity"
      OR NEW."database_system_identifier"
        IS DISTINCT FROM control_row."database_system_identifier"
      OR NEW."database_oid" IS DISTINCT FROM control_row."database_oid"
      OR NEW."operator" IS DISTINCT FROM control_row."operator"
      OR NEW."change_ticket" IS DISTINCT FROM control_row."change_ticket"
      OR NEW."evidence_sha256" IS DISTINCT FROM control_row."evidence_sha256"
      OR NEW."expiry_safe_through"
        IS DISTINCT FROM control_row."expiry_safe_through"
      OR NEW."created_at" IS DISTINCT FROM control_row."v2_contract_at"
    THEN
      RAISE EXCEPTION 'invalid rollout contract audit insert'
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'rollout audit insert is not authorized'
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "audit_balance_ledger_database_identity_rotation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NEW."database_identity" IS NOT DISTINCT FROM OLD."database_identity" THEN
    RETURN NULL;
  END IF;

  INSERT INTO "balance_ledger_database_identity_rotations" (
    "database_name",
    "old_database_identity",
    "new_database_identity",
    "old_system_identifier",
    "new_system_identifier",
    "old_database_oid",
    "new_database_oid",
    "operator",
    "change_ticket",
    "evidence_sha256",
    "created_at"
  ) VALUES (
    NEW."database_name",
    OLD."database_identity",
    NEW."database_identity",
    OLD."database_system_identifier",
    NEW."database_system_identifier",
    OLD."database_oid",
    NEW."database_oid",
    btrim(current_setting('billing.balance_ledger_identity_operator', TRUE)),
    btrim(current_setting('billing.balance_ledger_identity_ticket', TRUE)),
    current_setting('billing.balance_ledger_identity_evidence', TRUE),
    clock_timestamp()::TIMESTAMP(3)
  );
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION "reject_balance_ledger_database_identity_audit_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  control_row "balance_ledger_rollout_control"%ROWTYPE;
  current_system_identifier NUMERIC(20, 0);
  current_database_oid OID;
BEGIN
  IF TG_OP <> 'INSERT' THEN
    RAISE EXCEPTION 'balance ledger database identity audit is append-only: %', OLD."id"
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO control_row
  FROM "balance_ledger_rollout_control"
  WHERE "id" = 1;
  SELECT "system_identifier"::NUMERIC(20, 0)
    INTO current_system_identifier
  FROM pg_control_system();
  SELECT oid INTO current_database_oid
  FROM pg_database
  WHERE datname = current_database();

  IF pg_trigger_depth() < 2
    OR current_setting(
      'billing.balance_ledger_rollout_transition',
      TRUE
    ) IS DISTINCT FROM 'identity-rotate-v1'
    OR NEW."database_name" IS DISTINCT FROM current_database()
    OR NEW."database_name" IS DISTINCT FROM control_row."database_name"
    OR NEW."new_database_identity"
      IS DISTINCT FROM control_row."database_identity"
    OR NEW."new_system_identifier"
      IS DISTINCT FROM control_row."database_system_identifier"
    OR NEW."new_database_oid" IS DISTINCT FROM control_row."database_oid"
    OR NEW."new_system_identifier" IS DISTINCT FROM current_system_identifier
    OR NEW."new_database_oid" IS DISTINCT FROM current_database_oid
    OR NEW."old_database_identity" = NEW."new_database_identity"
    OR NEW."operator" IS DISTINCT FROM btrim(current_setting(
      'billing.balance_ledger_identity_operator',
      TRUE
    ))
    OR NEW."change_ticket" IS DISTINCT FROM btrim(current_setting(
      'billing.balance_ledger_identity_ticket',
      TRUE
    ))
    OR NEW."evidence_sha256" IS DISTINCT FROM current_setting(
      'billing.balance_ledger_identity_evidence',
      TRUE
    )
  THEN
    RAISE EXCEPTION 'balance ledger database identity audit insert is not authorized'
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE OR REPLACE FUNCTION "rotate_balance_ledger_database_identity"(
  expected_database_name TEXT,
  expected_database_identity UUID,
  transition_operator TEXT,
  transition_ticket TEXT,
  transition_evidence_sha256 TEXT
)
RETURNS TABLE(
  database_name TEXT,
  database_identity UUID,
  database_system_identifier NUMERIC(20, 0),
  database_oid OID
)
LANGUAGE plpgsql
AS $$
DECLARE
  control_row "balance_ledger_rollout_control"%ROWTYPE;
  next_database_identity UUID;
  current_system_identifier NUMERIC(20, 0);
  current_database_oid OID;
BEGIN
  IF expected_database_name IS NULL
    OR btrim(expected_database_name) = ''
    OR expected_database_name IS DISTINCT FROM current_database()
    OR expected_database_identity IS NULL
    OR transition_operator IS NULL
    OR btrim(transition_operator) = ''
    OR transition_ticket IS NULL
    OR btrim(transition_ticket) = ''
    OR transition_evidence_sha256 !~ '^[0-9a-f]{64}$'
    OR transition_evidence_sha256 = repeat('0', 64)
  THEN
    RAISE EXCEPTION 'database identity rotation confirmation is invalid'
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO control_row
  FROM "balance_ledger_rollout_control"
  WHERE "id" = 1
  FOR UPDATE;
  IF NOT FOUND
    OR control_row."database_name" IS DISTINCT FROM current_database()
    OR control_row."database_identity"
      IS DISTINCT FROM expected_database_identity
    OR control_row."phase" = 'CUTOVER_READY'
  THEN
    RAISE EXCEPTION
      'database identity rotation target mismatch database=% identity=% phase=%',
      current_database(),
      COALESCE(control_row."database_identity"::TEXT, 'MISSING'),
      COALESCE(control_row."phase", 'MISSING')
      USING ERRCODE = '23514';
  END IF;

  SELECT "system_identifier"::NUMERIC(20, 0)
    INTO current_system_identifier
  FROM pg_control_system();
  SELECT oid INTO current_database_oid
  FROM pg_database
  WHERE datname = current_database();
  next_database_identity := gen_random_uuid();

  PERFORM set_config(
    'billing.balance_ledger_rollout_transition',
    'identity-rotate-v1',
    TRUE
  );
  PERFORM set_config(
    'billing.balance_ledger_identity_operator',
    btrim(transition_operator),
    TRUE
  );
  PERFORM set_config(
    'billing.balance_ledger_identity_ticket',
    btrim(transition_ticket),
    TRUE
  );
  PERFORM set_config(
    'billing.balance_ledger_identity_evidence',
    transition_evidence_sha256,
    TRUE
  );

  UPDATE "balance_ledger_rollout_control" AS control
  SET
    "database_identity" = next_database_identity,
    "database_system_identifier" = current_system_identifier,
    "database_oid" = current_database_oid
  WHERE control."id" = 1
    AND control."database_identity" = expected_database_identity;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'database identity rotation compare-and-swap failed'
      USING ERRCODE = '40001';
  END IF;

  RETURN QUERY
  SELECT
    control."database_name",
    control."database_identity",
    control."database_system_identifier",
    control."database_oid"
  FROM "balance_ledger_rollout_control" control
  WHERE control."id" = 1;
END
$$;

BEGIN;
DROP TRIGGER IF EXISTS "balance_ledger_rollout_control_guard"
  ON "balance_ledger_rollout_control";
CREATE TRIGGER "balance_ledger_rollout_control_guard"
BEFORE UPDATE OR DELETE ON "balance_ledger_rollout_control"
FOR EACH ROW
EXECUTE FUNCTION "guard_balance_ledger_rollout_control_mutation"();

DROP TRIGGER IF EXISTS "balance_ledger_rollout_control_audit"
  ON "balance_ledger_rollout_control";
CREATE TRIGGER "balance_ledger_rollout_control_audit"
AFTER UPDATE ON "balance_ledger_rollout_control"
FOR EACH ROW
EXECUTE FUNCTION "audit_balance_ledger_rollout_transition"();

DROP TRIGGER IF EXISTS "balance_ledger_rollout_control_identity_audit"
  ON "balance_ledger_rollout_control";
CREATE TRIGGER "balance_ledger_rollout_control_identity_audit"
AFTER UPDATE ON "balance_ledger_rollout_control"
FOR EACH ROW
EXECUTE FUNCTION "audit_balance_ledger_database_identity_rotation"();

DROP TRIGGER IF EXISTS "balance_ledger_rollout_transitions_append_only"
  ON "balance_ledger_rollout_transitions";
CREATE TRIGGER "balance_ledger_rollout_transitions_append_only"
BEFORE INSERT OR UPDATE OR DELETE ON "balance_ledger_rollout_transitions"
FOR EACH ROW
EXECUTE FUNCTION "reject_balance_ledger_rollout_audit_mutation"();

DROP TRIGGER IF EXISTS "balance_ledger_database_identity_rotations_append_only"
  ON "balance_ledger_database_identity_rotations";
CREATE TRIGGER "balance_ledger_database_identity_rotations_append_only"
BEFORE INSERT OR UPDATE OR DELETE ON "balance_ledger_database_identity_rotations"
FOR EACH ROW
EXECUTE FUNCTION "reject_balance_ledger_database_identity_audit_mutation"();
COMMIT;

CREATE OR REPLACE FUNCTION "prepare_balance_ledger_v2_contract"(
  expected_database_name TEXT,
  expected_database_identity UUID,
  transition_operator TEXT,
  transition_ticket TEXT,
  transition_evidence_sha256 TEXT,
  safe_through TIMESTAMP(3)
)
RETURNS TABLE(
  phase TEXT,
  database_name TEXT,
  database_identity UUID,
  cutover_ready_at TIMESTAMP(3),
  expiry_safe_through TIMESTAMP(3)
)
LANGUAGE plpgsql
AS $$
DECLARE
  control_row "balance_ledger_rollout_control"%ROWTYPE;
  clean_account_count BIGINT;
  near_expiry_count BIGINT;
  bridge_legacy_expiry_count BIGINT;
  bridge_non_consume_count BIGINT;
  current_opening_grant_count BIGINT;
  strict_trigger_count BIGINT;
  financial_row_count BIGINT;
  prepared_at TIMESTAMP(3);
  current_system_identifier NUMERIC(20, 0);
  current_database_oid OID;
BEGIN
  IF expected_database_name IS NULL
    OR btrim(expected_database_name) = ''
    OR expected_database_name IS DISTINCT FROM current_database()
    OR expected_database_identity IS NULL
  THEN
    RAISE EXCEPTION
      'rollout database confirmation mismatch expected=% actual=%',
      COALESCE(expected_database_name, 'NULL'),
      current_database()
      USING ERRCODE = '23514';
  END IF;
  IF transition_operator IS NULL OR btrim(transition_operator) = ''
    OR transition_ticket IS NULL OR btrim(transition_ticket) = ''
    OR transition_evidence_sha256 !~ '^[0-9a-f]{64}$'
  THEN
    RAISE EXCEPTION 'rollout operator/ticket/evidence is invalid'
      USING ERRCODE = '23514';
  END IF;

  -- The all-zero digest is reserved for the self-preparing greenfield path in
  -- Release B. It can never stand in for an operator evidence package on a
  -- non-empty database.
  IF transition_evidence_sha256 = repeat('0', 64) THEN
    SELECT
      (SELECT COUNT(*) FROM "billing_accounts")
      + (SELECT COUNT(*) FROM "account_wallets")
      + (SELECT COUNT(*) FROM "balance_transactions")
      + (SELECT COUNT(*) FROM "balance_grants")
      + (SELECT COUNT(*) FROM "balance_consumption_allocations")
      + (SELECT COUNT(*) FROM "enterprise_credit_settlements")
      INTO financial_row_count;
    IF transition_operator IS DISTINCT FROM 'migration-empty-database'
      OR transition_ticket IS DISTINCT FROM
        '20260717000100_balance_expiry_v2_contract'
      OR financial_row_count <> 0
    THEN
      RAISE EXCEPTION
        'all-zero rollout evidence is reserved for an empty database rows=%',
        financial_row_count
        USING ERRCODE = '23514';
    END IF;
  END IF;

  prepared_at := clock_timestamp()::TIMESTAMP(3);
  IF safe_through IS NULL
    OR safe_through < prepared_at + INTERVAL '15 minutes'
  THEN
    RAISE EXCEPTION
      'expiry safety horizon must cover at least 15 minutes prepare=% horizon=%',
      prepared_at,
      COALESCE(safe_through::TEXT, 'NULL')
      USING ERRCODE = '23514';
  END IF;

  SELECT * INTO control_row
  FROM "balance_ledger_rollout_control"
  WHERE "id" = 1
  FOR UPDATE;
  IF NOT FOUND
    OR control_row."phase" NOT IN ('EXPANDED', 'CUTOVER_READY')
    OR control_row."v2_contract_at" IS NOT NULL
  THEN
    RAISE EXCEPTION
      'balance ledger rollout cannot prepare/refresh from phase: %',
      COALESCE(control_row."phase", 'MISSING')
      USING ERRCODE = '23514';
  END IF;
  IF control_row."database_name" IS DISTINCT FROM current_database() THEN
    RAISE EXCEPTION 'rollout control database identity mismatch'
      USING ERRCODE = '23514';
  END IF;
  SELECT "system_identifier"::NUMERIC(20, 0)
    INTO current_system_identifier
  FROM pg_control_system();
  SELECT oid INTO current_database_oid
  FROM pg_database
  WHERE datname = current_database();
  IF control_row."database_identity"
      IS DISTINCT FROM expected_database_identity
    OR control_row."database_system_identifier"
      IS DISTINCT FROM current_system_identifier
    OR control_row."database_oid" IS DISTINCT FROM current_database_oid
  THEN
    RAISE EXCEPTION
      'rollout control database locator mismatch identity=%/% locator=%/% current=%/%',
      control_row."database_identity",
      expected_database_identity,
      control_row."database_system_identifier",
      control_row."database_oid",
      current_system_identifier,
      current_database_oid
      USING ERRCODE = '23514';
  END IF;

  SELECT COUNT(*) INTO clean_account_count
  FROM "billing_accounts"
  WHERE "balance_grant_ledger_status" = 'RECONCILED_V2';

  SELECT COUNT(*) INTO near_expiry_count
  FROM "balance_grants"
  WHERE NOT "is_expired"
    AND "remaining_amount_usd" > 0
    AND "expires_at" IS NOT NULL
    AND "expires_at" <= safe_through;

  SELECT COUNT(*) INTO bridge_legacy_expiry_count
  FROM "balance_transactions" transaction_row
  WHERE transaction_row."ledger_sequence" > 0
    AND transaction_row."type"::TEXT = 'ADJUST'
    AND transaction_row."amount_usd" < 0
    AND transaction_row."description" LIKE 'balance grant expired:%'
    AND NOT EXISTS (
      SELECT 1
      FROM "balance_grant_expiries" expiry
      WHERE expiry."balance_transaction_id" = transaction_row."id"
    );

  -- While EXPANDED, user traffic is restricted to debit. Any sequenced
  -- RECHARGE/ADJUST/REFUND is a writer-drain violation, not merely positive
  -- funding. This also catches legacy refunds that have no V2 refund audit.
  SELECT COUNT(*) INTO bridge_non_consume_count
  FROM "balance_transactions"
  WHERE "ledger_sequence" > 0
    AND "type"::TEXT <> 'CONSUME';

  SELECT COUNT(*) INTO current_opening_grant_count
  FROM "balance_grants"
  WHERE "source" = 'MIGRATION_OPENING';

  SELECT COUNT(*) INTO strict_trigger_count
  FROM pg_trigger trigger_row
  WHERE NOT trigger_row.tgisinternal
    AND trigger_row.tgname IN (
      'balance_grants_expiry_reconciled_v2_guard',
      'balance_grants_expiry_aggregate_deferred',
      'account_wallets_clean_canonical_deferred'
    );

  IF clean_account_count <> 0
    OR near_expiry_count <> 0
    OR bridge_legacy_expiry_count <> 0
    OR bridge_non_consume_count <> 0
    OR current_opening_grant_count
      IS DISTINCT FROM control_row."opening_grant_count_at_expand"
    OR strict_trigger_count <> 0
  THEN
    RAISE EXCEPTION
      'rollout cutover proof failed clean=% near_expiry=% legacy_expiry=% non_consume=% opening_grant=%/% strict_trigger=%',
      clean_account_count,
      near_expiry_count,
      bridge_legacy_expiry_count,
      bridge_non_consume_count,
      current_opening_grant_count,
      control_row."opening_grant_count_at_expand",
      strict_trigger_count
      USING ERRCODE = '23514';
  END IF;

  PERFORM set_config(
    'billing.balance_ledger_rollout_transition',
    CASE
      WHEN control_row."phase" = 'EXPANDED' THEN 'prepare-v1'
      ELSE 'prepare-refresh-v1'
    END,
    TRUE
  );
  UPDATE "balance_ledger_rollout_control" AS control
  SET
    "phase" = 'CUTOVER_READY',
    "cutover_ready_at" = prepared_at,
    "operator" = btrim(transition_operator),
    "change_ticket" = btrim(transition_ticket),
    "evidence_sha256" = transition_evidence_sha256,
    "expiry_safe_through" = safe_through
  WHERE control."id" = 1
    AND control."phase" = control_row."phase"
    AND control."v2_contract_at" IS NULL;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'rollout CUTOVER_READY compare-and-swap failed'
      USING ERRCODE = '40001';
  END IF;

  RETURN QUERY
  SELECT
    control."phase",
    control."database_name",
    control."database_identity",
    control."cutover_ready_at",
    control."expiry_safe_through"
  FROM "balance_ledger_rollout_control" control
  WHERE control."id" = 1;
END
$$;

-- CREATE/ADD IF NOT EXISTS above exists solely so a multi-COMMIT expand can
-- be resumed after an interrupted phase. It is never permission to accept an
-- object merely because its name already exists. Before advertising EXPANDED,
-- fingerprint every resumable column/table/sequence/index plus the complete
-- constraint, function and trigger contract. A same-name object with the wrong
-- type, default, ownership, body or attachment leaves the migration failed and
-- the rollout marker absent.
BEGIN;
SET LOCAL statement_timeout = '30s';
DO $$
DECLARE
  actual_count BIGINT;
  actual_fingerprint TEXT;
  expected_function_names TEXT[] := ARRAY[
    'guard_balance_transaction_ledger_sequence_insert',
    'assert_clean_account_wallet_matches_transaction_tail',
    'guard_balance_grant_expiry_reconciled_v2',
    'reject_balance_grant_issuance_snapshot_mutation',
    'reject_audited_balance_grant_financial_mutation',
    'assert_balance_grant_expiry_aggregate',
    'validate_balance_grant_expiry_transition_trigger',
    'validate_balance_grant_expiry_audit_trigger',
    'reject_balance_grant_expiry_audit_mutation',
    'reject_balance_grant_expiry_transaction_mutation',
    'validate_balance_ledger_allocation_repair_insert',
    'reject_balance_ledger_allocation_repair_mutation',
    'validate_balance_ledger_transaction_repair_insert',
    'reject_balance_ledger_transaction_repair_mutation',
    'balance_legacy_grant_valid_from_is_repair_proven',
    'guard_balance_consumption_allocation_financial_rewrite',
    'assert_balance_debt_allocation_settlement_conservation',
    'validate_balance_debt_allocation_settlement_trigger',
    'validate_balance_settlement_allocation_trigger',
    'guard_balance_ledger_repair_run_mutation',
    'guard_balance_ledger_repair_account_mutation',
    'balance_ledger_v2_contract_enabled',
    'assert_balance_ledger_database_identity',
    'authorize_balance_ledger_clean_promotion',
    'guard_clean_account_initial_wallet',
    'balance_funding_candidates',
    'assert_balance_grant_funding_aggregate',
    'validate_balance_grant_funding_trigger',
    'assert_balance_transaction_unique_wallet_path',
    'assert_balance_allocation_sequence_order',
    'assert_balance_ledger_canonical_replay',
    'assert_balance_ledger_canonical_promotion',
    'validate_balance_ledger_clean_promotion',
    'reject_append_only_balance_financial_audit_mutation',
    'reject_refund_balance_transaction_mutation',
    'reject_balance_transaction_mutation',
    'reject_balance_consumption_allocation_delete',
    'reject_balance_grant_delete',
    'guard_balance_ledger_rollout_control_mutation',
    'audit_balance_ledger_rollout_transition',
    'reject_balance_ledger_rollout_audit_mutation',
    'audit_balance_ledger_database_identity_rotation',
    'reject_balance_ledger_database_identity_audit_mutation',
    'rotate_balance_ledger_database_identity',
    'prepare_balance_ledger_v2_contract'
  ];
  expected_trigger_names TEXT[] := ARRAY[
    'balance_transactions_ledger_sequence_insert_guard',
    'account_wallets_transaction_tail_deferred',
    'balance_transactions_wallet_tail_deferred',
    'balance_grants_issuance_snapshot_immutable',
    'balance_grants_audited_expiry_financial_immutable',
    'balance_grant_expiries_aggregate_deferred',
    'balance_grant_expiries_append_only',
    'balance_transactions_expiry_audit_immutable',
    'balance_ledger_allocation_repairs_insert_guard',
    'balance_ledger_allocation_repairs_append_only',
    'balance_ledger_transaction_repairs_insert_guard',
    'balance_ledger_transaction_repairs_append_only',
    'balance_consumption_allocations_financial_rewrite_guard',
    'balance_debt_allocations_settlement_conservation_deferred',
    'enterprise_settlements_allocation_conservation_deferred',
    'balance_ledger_repair_runs_immutable',
    'balance_ledger_repair_accounts_immutable',
    'billing_accounts_clean_promotion_guard',
    'account_wallets_clean_initial_balance_guard',
    'balance_grants_funding_aggregate_deferred',
    'billing_accounts_clean_promotion_deferred',
    'balance_grant_refunds_append_only',
    'balance_grant_refund_allocations_append_only',
    'enterprise_credit_settlements_append_only',
    'balance_transactions_refund_audit_immutable',
    'balance_transactions_append_only',
    'balance_consumption_allocations_delete_guard',
    'balance_grants_delete_guard',
    'balance_ledger_rollout_control_guard',
    'balance_ledger_rollout_control_audit',
    'balance_ledger_rollout_control_identity_audit',
    'balance_ledger_rollout_transitions_append_only',
    'balance_ledger_database_identity_rotations_append_only'
  ];
BEGIN
  WITH new_tables(name) AS (VALUES
    ('balance_grant_expiries'),
    ('balance_grant_refunds'),
    ('balance_grant_refund_allocations'),
    ('balance_ledger_repair_runs'),
    ('balance_ledger_repair_accounts'),
    ('balance_ledger_allocation_repairs'),
    ('balance_ledger_transaction_repairs'),
    ('balance_ledger_rollout_control'),
    ('balance_ledger_rollout_transitions'),
    ('balance_ledger_database_identity_rotations')
  ), existing_columns(table_name, column_name) AS (VALUES
    ('balance_grants', 'remaining_paid_amount_usd'),
    ('balance_grants', 'remaining_bonus_amount_usd'),
    ('billing_accounts', 'balance_grant_ledger_status'),
    ('billing_accounts', 'balance_grant_ledger_version'),
    ('billing_accounts', 'balance_grant_ledger_hash'),
    ('billing_accounts', 'balance_grant_ledger_reconciled_at'),
    ('billing_accounts', 'balance_grant_ledger_dirty_reason'),
    ('billing_accounts', 'balance_grant_ledger_through_transaction_id'),
    ('balance_transactions', 'ledger_sequence'),
    ('balance_transactions', 'operation_key'),
    ('balance_consumption_allocations', 'ledger_sequence'),
    ('enterprise_credit_settlements', 'balance_grant_id'),
    ('enterprise_credit_settlements', 'debt_source'),
    ('enterprise_credit_settlements', 'repair_run_id'),
    ('enterprise_credit_settlements', 'operation_key'),
    ('enterprise_credit_settlements', 'occurred_at')
  ), actual AS (
    SELECT
      table_class.relname,
      attribute.attnum,
      attribute.attname,
      format_type(attribute.atttypid, attribute.atttypmod) AS type_name,
      attribute.attnotnull,
      COALESCE(
        pg_get_expr(attribute_default.adbin, attribute_default.adrelid),
        '<NULL>'
      ) AS default_expression,
      attribute.attidentity,
      table_class.relkind,
      table_class.relpersistence
    FROM pg_class table_class
    JOIN pg_namespace namespace_row
      ON namespace_row.oid = table_class.relnamespace
    JOIN pg_attribute attribute
      ON attribute.attrelid = table_class.oid
      AND attribute.attnum > 0
      AND NOT attribute.attisdropped
    LEFT JOIN pg_attrdef attribute_default
      ON attribute_default.adrelid = table_class.oid
      AND attribute_default.adnum = attribute.attnum
    WHERE namespace_row.nspname = 'public'
      AND (
        table_class.relname IN (SELECT name FROM new_tables)
        OR (table_class.relname, attribute.attname) IN (
          SELECT table_name, column_name FROM existing_columns
        )
      )
  )
  SELECT
    COUNT(*),
    md5(string_agg(
      concat_ws(
        '|',
        relname,
        attnum,
        attname,
        type_name,
        attnotnull,
        default_expression,
        attidentity,
        relkind,
        relpersistence
      ),
      E'\n' ORDER BY relname, attnum
    ))
  INTO actual_count, actual_fingerprint
  FROM actual;
  IF actual_count <> 129
    OR actual_fingerprint <> '046130cfdf51df9b0d0788cea7dc8856'
  THEN
    RAISE EXCEPTION
      'balance ledger expand column/table fingerprint mismatch count=% fingerprint=%',
      actual_count,
      COALESCE(actual_fingerprint, 'NULL')
      USING ERRCODE = '55000';
  END IF;

  WITH expected_names(name) AS (VALUES
    ('balance_grant_expiries_account_created_idx'),
    ('balance_grant_refunds_account_occurred_idx'),
    ('balance_grant_refunds_grant_idx'),
    ('balance_grant_refund_allocations_refund_grant_role_key'),
    ('balance_grant_refund_allocations_refund_sequence_key'),
    ('balance_grant_refund_allocations_grant_idx'),
    ('balance_ledger_repair_accounts_run_account_key'),
    ('balance_ledger_repair_accounts_account_created_idx'),
    ('balance_ledger_allocation_repairs_run_allocation_key'),
    ('balance_ledger_allocation_repairs_account_created_idx'),
    ('balance_ledger_transaction_repairs_run_transaction_key'),
    ('balance_ledger_transaction_repairs_account_created_idx')
  ), actual AS (
    SELECT
      index_class.relname,
      index_row.indisunique,
      index_row.indisready,
      index_row.indisvalid,
      pg_get_indexdef(index_class.oid) AS definition
    FROM pg_class index_class
    JOIN pg_namespace namespace_row
      ON namespace_row.oid = index_class.relnamespace
    JOIN pg_index index_row ON index_row.indexrelid = index_class.oid
    WHERE namespace_row.nspname = 'public'
      AND index_class.relname IN (SELECT name FROM expected_names)
  )
  SELECT
    COUNT(*),
    md5(string_agg(
      concat_ws(
        '|',
        relname,
        indisunique,
        indisready,
        indisvalid,
        definition
      ),
      E'\n' ORDER BY relname
    ))
  INTO actual_count, actual_fingerprint
  FROM actual;
  IF actual_count <> 12
    OR actual_fingerprint <> 'eb7432785384bf74e1f88136b02960d2'
  THEN
    RAISE EXCEPTION
      'balance ledger expand index fingerprint mismatch count=% fingerprint=%',
      actual_count,
      COALESCE(actual_fingerprint, 'NULL')
      USING ERRCODE = '55000';
  END IF;

  WITH new_tables(name) AS (VALUES
    ('balance_grant_expiries'),
    ('balance_grant_refunds'),
    ('balance_grant_refund_allocations'),
    ('balance_ledger_repair_runs'),
    ('balance_ledger_repair_accounts'),
    ('balance_ledger_allocation_repairs'),
    ('balance_ledger_transaction_repairs'),
    ('balance_ledger_rollout_control'),
    ('balance_ledger_rollout_transitions'),
    ('balance_ledger_database_identity_rotations')
  ), modified_names(name) AS (VALUES
    ('balance_transactions_ledger_sequence_required_check'),
    ('balance_consumption_allocations_balance_transaction_id_fkey'),
    ('balance_consumption_allocations_ledger_sequence_nonzero_check'),
    ('balance_allocations_debt_ledger_sequence_required_check'),
    ('billing_accounts_balance_grant_ledger_status_check'),
    ('billing_accounts_balance_grant_ledger_proof_check'),
    ('enterprise_credit_settlements_occurred_at_not_null_check'),
    ('enterprise_credit_settlements_billing_account_id_fkey'),
    ('enterprise_credit_settlements_allocation_id_fkey'),
    ('enterprise_credit_settlements_repayment_transaction_id_fkey'),
    ('enterprise_credit_settlements_balance_grant_id_fkey'),
    ('enterprise_credit_settlements_debt_source_check'),
    ('enterprise_credit_settlements_amount_parts_check'),
    ('enterprise_credit_settlements_repair_run_id_fkey')
  ), actual AS (
    SELECT
      constraint_row.conrelid::regclass::TEXT AS relation_name,
      constraint_row.conname,
      constraint_row.contype,
      constraint_row.convalidated,
      constraint_row.condeferrable,
      constraint_row.condeferred,
      pg_get_constraintdef(constraint_row.oid, TRUE) AS definition
    FROM pg_constraint constraint_row
    WHERE constraint_row.connamespace = 'public'::regnamespace
      -- PostgreSQL 18 stores table-column NOT NULL specifications in
      -- pg_constraint (contype = 'n').  Their truth is already covered by the
      -- column fingerprint above through pg_attribute.attnotnull.  Excluding
      -- them keeps this constraint fingerprint semantically identical across
      -- PostgreSQL 16-18 instead of counting the same invariant twice.
      AND constraint_row.contype <> 'n'
      AND (
        constraint_row.conrelid::regclass::TEXT IN (
          SELECT name FROM new_tables
        )
        OR constraint_row.conname IN (SELECT name FROM modified_names)
      )
  )
  SELECT
    COUNT(*),
    md5(string_agg(
      concat_ws(
        '|',
        relation_name,
        conname,
        contype,
        convalidated,
        condeferrable,
        condeferred,
        definition
      ),
      E'\n' ORDER BY relation_name, conname
    ))
  INTO actual_count, actual_fingerprint
  FROM actual;
  IF actual_count <> 58
    OR actual_fingerprint <> 'f4db5b9cdda51b5472adf28bb6b87bf9'
  THEN
    RAISE EXCEPTION
      'balance ledger expand constraint fingerprint mismatch count=% fingerprint=%',
      actual_count,
      COALESCE(actual_fingerprint, 'NULL')
      USING ERRCODE = '55000';
  END IF;

  WITH actual AS (
    SELECT
      procedure_row.proname,
      pg_get_function_identity_arguments(procedure_row.oid) AS arguments,
      pg_get_function_result(procedure_row.oid) AS result,
      language_row.lanname,
      procedure_row.provolatile,
      procedure_row.prosecdef,
      procedure_row.prokind,
      procedure_row.prosrc
    FROM pg_proc procedure_row
    JOIN pg_namespace namespace_row
      ON namespace_row.oid = procedure_row.pronamespace
    JOIN pg_language language_row
      ON language_row.oid = procedure_row.prolang
    WHERE namespace_row.nspname = 'public'
      AND procedure_row.proname = ANY(expected_function_names)
  )
  SELECT
    COUNT(*),
    md5(string_agg(
      concat_ws(
        '|',
        proname,
        arguments,
        result,
        lanname,
        provolatile,
        prosecdef,
        prokind,
        prosrc
      ),
      E'\n' ORDER BY proname, arguments
    ))
  INTO actual_count, actual_fingerprint
  FROM actual;
  IF actual_count <> 45
    OR actual_fingerprint <> '6a3a0c41bcdfbcbd8e0b7089b0eba8ae'
  THEN
    RAISE EXCEPTION
      'balance ledger expand function fingerprint mismatch count=% fingerprint=%',
      actual_count,
      COALESCE(actual_fingerprint, 'NULL')
      USING ERRCODE = '55000';
  END IF;

  WITH actual AS (
    SELECT
      trigger_row.tgname,
      trigger_row.tgrelid::regclass::TEXT AS relation_name,
      trigger_row.tgenabled,
      trigger_row.tgdeferrable,
      trigger_row.tginitdeferred,
      pg_get_triggerdef(trigger_row.oid, TRUE) AS definition
    FROM pg_trigger trigger_row
    WHERE NOT trigger_row.tgisinternal
      AND trigger_row.tgname = ANY(expected_trigger_names)
  )
  SELECT
    COUNT(*),
    md5(string_agg(
      concat_ws(
        '|',
        tgname,
        relation_name,
        tgenabled,
        tgdeferrable,
        tginitdeferred,
        definition
      ),
      E'\n' ORDER BY tgname
    ))
  INTO actual_count, actual_fingerprint
  FROM actual;
  IF actual_count <> 33
    OR actual_fingerprint <> 'a3150379d31ba4c6da8d299bf8c52ba6'
  THEN
    RAISE EXCEPTION
      'balance ledger expand trigger fingerprint mismatch count=% fingerprint=%',
      actual_count,
      COALESCE(actual_fingerprint, 'NULL')
      USING ERRCODE = '55000';
  END IF;

  WITH actual AS (
    SELECT
      sequence_class.relname,
      sequence_row.seqtypid::regtype::TEXT AS type_name,
      sequence_row.seqstart,
      sequence_row.seqincrement,
      sequence_row.seqmax,
      sequence_row.seqmin,
      sequence_row.seqcache,
      sequence_row.seqcycle,
      COALESCE(owner_table.relname, '<NULL>') AS owner_table,
      COALESCE(owner_attribute.attname, '<NULL>') AS owner_column
    FROM pg_class sequence_class
    JOIN pg_namespace namespace_row
      ON namespace_row.oid = sequence_class.relnamespace
    JOIN pg_sequence sequence_row
      ON sequence_row.seqrelid = sequence_class.oid
    LEFT JOIN pg_depend dependency
      ON dependency.objid = sequence_class.oid
      AND dependency.deptype = 'a'
    LEFT JOIN pg_class owner_table
      ON owner_table.oid = dependency.refobjid
    LEFT JOIN pg_attribute owner_attribute
      ON owner_attribute.attrelid = dependency.refobjid
      AND owner_attribute.attnum = dependency.refobjsubid
    WHERE namespace_row.nspname = 'public'
      AND sequence_class.relname IN (
        'balance_transaction_ledger_seq',
        'balance_consumption_allocation_ledger_seq'
      )
  )
  SELECT
    COUNT(*),
    md5(string_agg(
      concat_ws(
        '|',
        relname,
        type_name,
        seqstart,
        seqincrement,
        seqmax,
        seqmin,
        seqcache,
        seqcycle,
        owner_table,
        owner_column
      ),
      E'\n' ORDER BY relname
    ))
  INTO actual_count, actual_fingerprint
  FROM actual;
  IF actual_count <> 2
    OR actual_fingerprint <> '626d64525a2d2dcb50ae9a675017121e'
  THEN
    RAISE EXCEPTION
      'balance ledger expand sequence fingerprint mismatch count=% fingerprint=%',
      actual_count,
      COALESCE(actual_fingerprint, 'NULL')
      USING ERRCODE = '55000';
  END IF;
END
$$;
COMMIT;

-- Mark EXPANDED only after every expand statement above has committed. The
-- initial transition audit is inserted once and then protected append-only.
BEGIN;
SELECT set_config(
  'billing.balance_ledger_rollout_transition',
  'expand-v1',
  TRUE
);
WITH expansion AS (
  INSERT INTO "balance_ledger_rollout_control" (
    "id",
    "phase",
    "database_name",
    "database_identity",
    "database_system_identifier",
    "database_oid",
    "expanded_at",
    "opening_grant_count_at_expand"
  ) VALUES (
    1,
    'EXPANDED',
    current_database(),
    gen_random_uuid(),
    (SELECT "system_identifier"::NUMERIC(20, 0) FROM pg_control_system()),
    (SELECT oid FROM pg_database WHERE datname = current_database()),
    clock_timestamp()::TIMESTAMP(3),
    (SELECT COUNT(*) FROM "balance_grants" WHERE "source" = 'MIGRATION_OPENING')
  )
  ON CONFLICT ("id") DO NOTHING
  RETURNING *
)
INSERT INTO "balance_ledger_rollout_transitions" (
  "from_phase",
  "to_phase",
  "database_name",
  "database_identity",
  "database_system_identifier",
  "database_oid",
  "operator",
  "change_ticket",
  "evidence_sha256",
  "expiry_safe_through",
  "created_at"
)
SELECT
  'NOT_INSTALLED',
  'EXPANDED',
  expansion."database_name",
  expansion."database_identity",
  expansion."database_system_identifier",
  expansion."database_oid",
  'migration',
  '20260715000100_personal_negative_balance_settlement',
  repeat('0', 64),
  expansion."expanded_at",
  expansion."expanded_at"
FROM expansion;
COMMIT;
