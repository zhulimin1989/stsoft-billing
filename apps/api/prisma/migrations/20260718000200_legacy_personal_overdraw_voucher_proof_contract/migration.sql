-- Immutable, account-scoped proof for the two legacy personal-ledger defects
-- that cannot be represented by the generic row-update audit alone:
--   1. one legacy grant allocation crossed zero and must be split, or was
--      wholly debt and must be reclassified; and
--   2. one legacy voucher receipt was absent or recorded the pre-fix full
--      grant remainder even though part of the voucher filled existing debt.
--
-- This migration installs the contract in both EXPANDED and V2_CONTRACT
-- environments. Proof writes remain impossible unless an explicitly selected
-- LEGACY_DIRTY account is inside a RUNNING repair transaction.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "balance_ledger_personal_debt_allocation_repairs" (
  "id" TEXT PRIMARY KEY,
  "operation_key" TEXT NOT NULL,
  "proof_version" INTEGER NOT NULL DEFAULT 1,
  "repair_kind" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "repair_account_id" TEXT NOT NULL,
  "billing_account_id" TEXT NOT NULL,
  "transaction_id" TEXT NOT NULL,
  "source_allocation_id" TEXT NOT NULL,
  -- Deliberately no FK to balance_consumption_allocations: SPLIT proof must
  -- exist before the guarded deterministic debt INSERT. A deferred trigger
  -- requires the exact row before COMMIT.
  "created_debt_allocation_id" TEXT,
  "source_before_snapshot" JSONB NOT NULL,
  "source_after_snapshot" JSONB NOT NULL,
  "created_debt_snapshot" JSONB,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "balance_ledger_personal_debt_repairs_run_fkey"
    FOREIGN KEY ("run_id") REFERENCES "balance_ledger_repair_runs"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_personal_debt_repairs_repair_account_fkey"
    FOREIGN KEY ("repair_account_id") REFERENCES "balance_ledger_repair_accounts"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_personal_debt_repairs_billing_account_fkey"
    FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_personal_debt_repairs_transaction_fkey"
    FOREIGN KEY ("transaction_id") REFERENCES "balance_transactions"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_personal_debt_repairs_source_allocation_fkey"
    FOREIGN KEY ("source_allocation_id") REFERENCES "balance_consumption_allocations"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_personal_debt_repairs_shape_check" CHECK (
    "proof_version" = 1
    AND "repair_kind" IN (
      'LEGACY_DEBT_SPLIT_V1',
      'LEGACY_DEBT_RECLASS_V1'
    )
    AND jsonb_typeof("source_before_snapshot") = 'object'
    AND jsonb_typeof("source_after_snapshot") = 'object'
    AND (
      (
        "repair_kind" = 'LEGACY_DEBT_SPLIT_V1'
        AND "created_debt_allocation_id" IS NOT NULL
        AND jsonb_typeof("created_debt_snapshot") = 'object'
      )
      OR (
        "repair_kind" = 'LEGACY_DEBT_RECLASS_V1'
        AND "created_debt_allocation_id" IS NULL
        AND "created_debt_snapshot" IS NULL
      )
    )
  )
);

CREATE UNIQUE INDEX "balance_ledger_personal_debt_repairs_run_source_key"
  ON "balance_ledger_personal_debt_allocation_repairs"(
    "run_id", "billing_account_id", "source_allocation_id"
  );
CREATE UNIQUE INDEX "bl_personal_debt_operation_key"
  ON "balance_ledger_personal_debt_allocation_repairs"("operation_key");
CREATE UNIQUE INDEX "bl_personal_debt_source_allocation_key"
  ON "balance_ledger_personal_debt_allocation_repairs"("source_allocation_id");
CREATE UNIQUE INDEX "bl_personal_debt_created_allocation_key"
  ON "balance_ledger_personal_debt_allocation_repairs"("created_debt_allocation_id");
CREATE UNIQUE INDEX "balance_ledger_personal_debt_repairs_transaction_id_key"
  ON "balance_ledger_personal_debt_allocation_repairs"("transaction_id");
CREATE INDEX "balance_ledger_personal_debt_repairs_account_created_idx"
  ON "balance_ledger_personal_debt_allocation_repairs"(
    "billing_account_id", "created_at"
  );

CREATE TABLE "balance_ledger_voucher_funding_repairs" (
  "id" TEXT PRIMARY KEY,
  "operation_key" TEXT NOT NULL UNIQUE,
  "proof_version" INTEGER NOT NULL DEFAULT 1,
  "repair_kind" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "repair_account_id" TEXT NOT NULL,
  "billing_account_id" TEXT NOT NULL,
  "transaction_id" TEXT NOT NULL UNIQUE,
  "grant_id" TEXT NOT NULL UNIQUE,
  "transaction_snapshot" JSONB NOT NULL,
  "grant_snapshot" JSONB NOT NULL,
  "wallet_before_usd" NUMERIC(20, 12) NOT NULL,
  "hole_fill_usd" NUMERIC(20, 12) NOT NULL,
  "finance_approval_ref" TEXT NOT NULL,
  "technical_approval_ref" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "balance_ledger_voucher_funding_repairs_run_fkey"
    FOREIGN KEY ("run_id") REFERENCES "balance_ledger_repair_runs"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_voucher_funding_repairs_repair_account_fkey"
    FOREIGN KEY ("repair_account_id") REFERENCES "balance_ledger_repair_accounts"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_voucher_funding_repairs_billing_account_fkey"
    FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_voucher_funding_repairs_transaction_fkey"
    FOREIGN KEY ("transaction_id") REFERENCES "balance_transactions"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_voucher_funding_repairs_grant_fkey"
    FOREIGN KEY ("grant_id") REFERENCES "balance_grants"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_voucher_funding_repairs_shape_check" CHECK (
    "proof_version" = 1
    AND "repair_kind" IN (
      'LEGACY_PRE_IDEMPOTENCY_VOUCHER_V1',
      'LEGACY_VOUCHER_FULL_REMAINDER_DEBT_ABSORPTION_V1'
    )
    AND jsonb_typeof("transaction_snapshot") = 'object'
    AND jsonb_typeof("grant_snapshot") = 'object'
    AND "hole_fill_usd" >= 0
    AND "hole_fill_usd" <= GREATEST(-"wallet_before_usd", 0)
    AND "finance_approval_ref" = btrim("finance_approval_ref")
    AND "technical_approval_ref" = btrim("technical_approval_ref")
    AND length(btrim("finance_approval_ref")) BETWEEN 1 AND 200
    AND length(btrim("technical_approval_ref")) BETWEEN 1 AND 200
    AND btrim("finance_approval_ref") <> btrim("technical_approval_ref")
  )
);

CREATE UNIQUE INDEX "balance_ledger_voucher_funding_repairs_run_tx_key"
  ON "balance_ledger_voucher_funding_repairs"(
    "run_id", "billing_account_id", "transaction_id"
  );
CREATE INDEX "balance_ledger_voucher_funding_repairs_account_created_idx"
  ON "balance_ledger_voucher_funding_repairs"(
    "billing_account_id", "created_at"
  );

CREATE OR REPLACE FUNCTION "reject_balance_legacy_personal_proof_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'legacy personal financial proof is append-only table=% id=%',
    TG_TABLE_NAME, OLD."id"
    USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER "balance_ledger_personal_debt_repairs_append_only"
BEFORE UPDATE OR DELETE
ON "balance_ledger_personal_debt_allocation_repairs"
FOR EACH ROW
EXECUTE FUNCTION "reject_balance_legacy_personal_proof_mutation"();

CREATE TRIGGER "balance_ledger_voucher_funding_repairs_append_only"
BEFORE UPDATE OR DELETE
ON "balance_ledger_voucher_funding_repairs"
FOR EACH ROW
EXECUTE FUNCTION "reject_balance_legacy_personal_proof_mutation"();

-- The semantic proof is recorded before the generic OLD/NEW allocation audit
-- and before any allocation UPDATE. This preserves a database-observed fact
-- that a SPLIT account had no already-fixed negative allocation epoch; the
-- repair can then plan the source, child, and every other NULL legacy row once
-- as the ordinary canonical -N..-1 epoch. Reclassifying one row creates no new
-- slot and therefore does not need that stricter precondition.
CREATE OR REPLACE FUNCTION "validate_balance_personal_debt_repair_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  active_run_id TEXT;
  run_status TEXT;
  repair_row RECORD;
  account_row RECORD;
  rollout_row RECORD;
  transaction_row "balance_transactions"%ROWTYPE;
  source_row "balance_consumption_allocations"%ROWTYPE;
  source_snapshot JSONB;
  source_grant_row "balance_grants"%ROWTYPE;
  transaction_allocation_count BIGINT;
  existing_negative_sequence_count BIGINT;
  source_reference_count BIGINT;
  wallet_before_usd NUMERIC;
  grant_part_usd NUMERIC;
  debt_part_usd NUMERIC;
  valid_shape BOOLEAN;
BEGIN
  active_run_id := current_setting('billing.balance_ledger_repair_run_id', TRUE);
  SELECT "status" INTO run_status
  FROM "balance_ledger_repair_runs"
  WHERE "id" = NEW."run_id";
  SELECT * INTO repair_row
  FROM "balance_ledger_repair_accounts"
  WHERE "id" = NEW."repair_account_id";
  SELECT * INTO account_row
  FROM "billing_accounts"
  WHERE "id" = NEW."billing_account_id";
  SELECT * INTO rollout_row
  FROM "balance_ledger_rollout_control"
  WHERE "id" = 1;
  SELECT * INTO transaction_row
  FROM "balance_transactions"
  WHERE "id" = NEW."transaction_id";
  SELECT * INTO source_row
  FROM "balance_consumption_allocations" source_allocation
  WHERE source_allocation."id" = NEW."source_allocation_id";
  source_snapshot := to_jsonb(source_row);
  SELECT * INTO source_grant_row
  FROM "balance_grants" grant_row
  WHERE grant_row."id" = source_row."balance_grant_id";
  SELECT COUNT(*) INTO transaction_allocation_count
  FROM "balance_consumption_allocations" allocation
  WHERE allocation."billing_account_id" = NEW."billing_account_id"
    AND allocation."balance_transaction_id" = NEW."transaction_id";
  SELECT COUNT(*) INTO existing_negative_sequence_count
  FROM "balance_consumption_allocations" allocation
  WHERE allocation."billing_account_id" = NEW."billing_account_id"
    AND allocation."ledger_sequence" < 0;
  SELECT COUNT(*) INTO source_reference_count
  FROM "enterprise_credit_settlements" settlement
  WHERE settlement."allocation_id" = NEW."source_allocation_id";

  wallet_before_usd := transaction_row."balance_after_usd"
    - transaction_row."amount_usd";
  grant_part_usd := LEAST(
    source_row."amount_usd",
    GREATEST(wallet_before_usd, 0)
  );
  debt_part_usd := source_row."amount_usd" - grant_part_usd;

  valid_shape :=
    active_run_id IS NOT DISTINCT FROM NEW."run_id"
    AND run_status IS NOT DISTINCT FROM 'RUNNING'
    AND repair_row."id" IS NOT NULL
    AND repair_row."run_id" IS NOT DISTINCT FROM NEW."run_id"
    AND repair_row."billing_account_id" IS NOT DISTINCT FROM NEW."billing_account_id"
    AND repair_row."status" IS NOT DISTINCT FROM 'RUNNING'
    AND account_row."id" IS NOT NULL
    AND account_row."type" IS NOT DISTINCT FROM 'personal'
    AND account_row."balance_grant_ledger_status" IS NOT DISTINCT FROM 'LEGACY_DIRTY'
    AND rollout_row."id" IS NOT NULL
    AND rollout_row."phase" IN ('EXPANDED', 'CUTOVER_READY', 'V2_CONTRACT')
    AND transaction_row."id" IS NOT NULL
    AND transaction_row."billing_account_id" IS NOT DISTINCT FROM NEW."billing_account_id"
    AND transaction_row."created_at" < rollout_row."expanded_at"
    AND transaction_row."type"::TEXT IS NOT DISTINCT FROM 'CONSUME'
    AND transaction_row."amount_usd" < 0
    AND transaction_row."balance_after_usd" < 0
    AND transaction_row."operation_key" IS NULL
    AND transaction_row."user_id" IS NOT NULL
    AND transaction_row."tenant_id" IS NOT NULL
    AND transaction_row."token_usage_id" IS NOT NULL
    AND source_row."id" IS NOT NULL
    AND source_row."billing_account_id" IS NOT DISTINCT FROM NEW."billing_account_id"
    AND source_row."balance_transaction_id" IS NOT DISTINCT FROM NEW."transaction_id"
    AND source_row."user_id" IS NOT DISTINCT FROM transaction_row."user_id"
    AND source_row."tenant_id" IS NOT DISTINCT FROM transaction_row."tenant_id"
    AND source_row."product_id" IS NOT DISTINCT FROM transaction_row."product_id"
    AND source_row."token_usage_id" IS NOT DISTINCT FROM transaction_row."token_usage_id"
    AND source_row."created_at" < rollout_row."expanded_at"
    AND source_row."source" IS NOT DISTINCT FROM 'BALANCE_GRANT'
    AND source_row."balance_grant_id" IS NOT NULL
    AND source_grant_row."id" IS NOT NULL
    AND source_grant_row."billing_account_id" IS NOT DISTINCT FROM NEW."billing_account_id"
    AND source_grant_row."created_at" < rollout_row."expanded_at"
    AND source_grant_row."source" IS DISTINCT FROM 'MIGRATION_OPENING'
    AND source_grant_row."user_id" IS NOT DISTINCT FROM transaction_row."user_id"
    AND source_grant_row."tenant_id" IS NOT DISTINCT FROM transaction_row."tenant_id"
    AND source_grant_row."product_id" IS NOT DISTINCT FROM transaction_row."product_id"
    AND source_row."amount_usd" IS NOT DISTINCT FROM -transaction_row."amount_usd"
    AND source_row."amount_usd" > 0
    AND source_row."recognized_revenue_usd" >= 0
    AND source_row."bonus_consumed_usd" >= 0
    AND source_row."recognized_revenue_usd" + source_row."bonus_consumed_usd"
      IS NOT DISTINCT FROM source_row."amount_usd"
    AND source_row."discount_rate" IS NOT DISTINCT FROM ROUND(
      source_row."recognized_revenue_usd" / source_row."amount_usd",
      12
    )
    AND source_row."settled_usd" IS NOT DISTINCT FROM 0
    AND source_row."settled_at" IS NULL
    AND source_row."created_at" >= transaction_row."created_at"
    AND (source_row."ledger_sequence" IS NULL OR source_row."ledger_sequence" < 0)
    AND transaction_allocation_count = 1
    AND source_reference_count = 0
    AND debt_part_usd > 0
    AND NEW."operation_key" IS NOT DISTINCT FROM (
      'repair:personal-debt-allocation:' || NEW."run_id" || ':'
      || NEW."transaction_id" || ':' || NEW."source_allocation_id"
    )
    AND NEW."source_before_snapshot" IS NOT DISTINCT FROM source_snapshot
    AND NEW."source_before_snapshot"->>'id' IS NOT DISTINCT FROM
      NEW."source_allocation_id"
    AND NEW."source_after_snapshot"->>'id' IS NOT DISTINCT FROM
      NEW."source_allocation_id"
    AND (
      NEW."source_before_snapshot"
        - 'source' - 'balance_grant_id' - 'amount_usd'
        - 'recognized_revenue_usd' - 'bonus_consumed_usd'
        - 'discount_rate' - 'settled_usd' - 'settled_at'
        - 'ledger_sequence'
    ) IS NOT DISTINCT FROM (
      NEW."source_after_snapshot"
        - 'source' - 'balance_grant_id' - 'amount_usd'
        - 'recognized_revenue_usd' - 'bonus_consumed_usd'
        - 'discount_rate' - 'settled_usd' - 'settled_at'
        - 'ledger_sequence'
    );

  IF valid_shape IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION
      'legacy personal debt proof is not authorized run=% account=% tx=% allocation=%',
      NEW."run_id", NEW."billing_account_id", NEW."transaction_id",
      NEW."source_allocation_id"
      USING ERRCODE = '23514';
  END IF;

  IF NEW."repair_kind" = 'LEGACY_DEBT_RECLASS_V1' THEN
    valid_shape := grant_part_usd = 0
      AND NEW."created_debt_allocation_id" IS NULL
      AND NEW."created_debt_snapshot" IS NULL
      AND NEW."source_after_snapshot"->>'source' = 'NEGATIVE_BALANCE'
      AND NEW."source_after_snapshot"->>'balance_grant_id' IS NULL
      AND (NEW."source_after_snapshot"->>'amount_usd')::NUMERIC = debt_part_usd
      AND (NEW."source_after_snapshot"->>'recognized_revenue_usd')::NUMERIC >= 0
      AND (NEW."source_after_snapshot"->>'bonus_consumed_usd')::NUMERIC >= 0
      AND (NEW."source_after_snapshot"->>'settled_usd')::NUMERIC
        = (NEW."source_after_snapshot"->>'recognized_revenue_usd')::NUMERIC
          + (NEW."source_after_snapshot"->>'bonus_consumed_usd')::NUMERIC
      AND (NEW."source_after_snapshot"->>'settled_usd')::NUMERIC
        BETWEEN 0 AND debt_part_usd
      AND (NEW."source_after_snapshot"->>'discount_rate')::NUMERIC = 0
      AND (
        (NEW."source_after_snapshot"->>'settled_usd')::NUMERIC = debt_part_usd
      ) IS NOT DISTINCT FROM (NEW."source_after_snapshot"->>'settled_at' IS NOT NULL)
      AND (NEW."source_after_snapshot"->>'ledger_sequence')::BIGINT < 0;
  ELSE
    valid_shape := NEW."repair_kind" = 'LEGACY_DEBT_SPLIT_V1'
      AND grant_part_usd > 0
      AND debt_part_usd > 0
      AND source_row."ledger_sequence" IS NULL
      AND existing_negative_sequence_count = 0
      AND NEW."created_debt_allocation_id" IS NOT DISTINCT FROM (
        'repair-negative-balance-split:' || NEW."source_allocation_id"
      )
      AND NEW."created_debt_snapshot"->>'id'
        IS NOT DISTINCT FROM NEW."created_debt_allocation_id"
      AND NOT EXISTS (
        SELECT 1 FROM "balance_consumption_allocations" allocation
        WHERE allocation."id" = NEW."created_debt_allocation_id"
      )
      AND NEW."source_after_snapshot"->>'source' = 'BALANCE_GRANT'
      AND NEW."source_after_snapshot"->>'balance_grant_id'
        IS NOT DISTINCT FROM source_row."balance_grant_id"
      AND (NEW."source_after_snapshot"->>'amount_usd')::NUMERIC = grant_part_usd
      AND (NEW."source_after_snapshot"->>'recognized_revenue_usd')::NUMERIC >= 0
      AND (NEW."source_after_snapshot"->>'bonus_consumed_usd')::NUMERIC >= 0
      AND (NEW."source_after_snapshot"->>'recognized_revenue_usd')::NUMERIC
        + (NEW."source_after_snapshot"->>'bonus_consumed_usd')::NUMERIC
        = grant_part_usd
      AND (NEW."source_after_snapshot"->>'discount_rate')::NUMERIC = ROUND(
        (NEW."source_after_snapshot"->>'recognized_revenue_usd')::NUMERIC
          / grant_part_usd,
        12
      )
      AND (NEW."source_after_snapshot"->>'settled_usd')::NUMERIC = 0
      AND NEW."source_after_snapshot"->>'settled_at' IS NULL
      AND (NEW."source_after_snapshot"->>'ledger_sequence')::BIGINT < 0
      AND (
        NEW."source_before_snapshot"
          - 'id' - 'source' - 'balance_grant_id' - 'amount_usd'
          - 'recognized_revenue_usd' - 'bonus_consumed_usd'
          - 'discount_rate' - 'settled_usd' - 'settled_at'
          - 'ledger_sequence'
      ) IS NOT DISTINCT FROM (
        NEW."created_debt_snapshot"
          - 'id' - 'source' - 'balance_grant_id' - 'amount_usd'
          - 'recognized_revenue_usd' - 'bonus_consumed_usd'
          - 'discount_rate' - 'settled_usd' - 'settled_at'
          - 'ledger_sequence'
      )
      AND NEW."created_debt_snapshot"->>'source' = 'NEGATIVE_BALANCE'
      AND NEW."created_debt_snapshot"->>'balance_grant_id' IS NULL
      AND (NEW."created_debt_snapshot"->>'amount_usd')::NUMERIC = debt_part_usd
      AND (NEW."created_debt_snapshot"->>'recognized_revenue_usd')::NUMERIC >= 0
      AND (NEW."created_debt_snapshot"->>'bonus_consumed_usd')::NUMERIC >= 0
      AND (NEW."created_debt_snapshot"->>'settled_usd')::NUMERIC
        = (NEW."created_debt_snapshot"->>'recognized_revenue_usd')::NUMERIC
          + (NEW."created_debt_snapshot"->>'bonus_consumed_usd')::NUMERIC
      AND (NEW."created_debt_snapshot"->>'settled_usd')::NUMERIC
        BETWEEN 0 AND debt_part_usd
      AND (NEW."created_debt_snapshot"->>'discount_rate')::NUMERIC = 0
      AND (
        (NEW."created_debt_snapshot"->>'settled_usd')::NUMERIC = debt_part_usd
      ) IS NOT DISTINCT FROM (NEW."created_debt_snapshot"->>'settled_at' IS NOT NULL)
      AND (NEW."created_debt_snapshot"->>'ledger_sequence')::BIGINT < 0
      AND (NEW."source_after_snapshot"->>'ledger_sequence')::BIGINT
        <> (NEW."created_debt_snapshot"->>'ledger_sequence')::BIGINT;
  END IF;

  IF valid_shape IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION
      'legacy personal debt proof financial split is invalid kind=% tx=% allocation=%',
      NEW."repair_kind", NEW."transaction_id", NEW."source_allocation_id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range
    OR datetime_field_overflow
  THEN
    RAISE EXCEPTION
      'legacy personal debt proof contains invalid typed evidence tx=% allocation=%',
      NEW."transaction_id", NEW."source_allocation_id"
      USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER "balance_personal_debt_repairs_insert_guard"
BEFORE INSERT
ON "balance_ledger_personal_debt_allocation_repairs"
FOR EACH ROW
EXECUTE FUNCTION "validate_balance_personal_debt_repair_insert"();

-- Preserve the normal database-owned positive sequence for every online row.
-- The sole exception is the deterministic SPLIT child whose exact complete
-- row image was approved while the account had no pre-existing negative
-- allocation epoch. The final canonical assertion still requires the whole
-- account's ordinary -N..-1 sequence; this branch does not create a second
-- sequence regime.
CREATE OR REPLACE FUNCTION "guard_balance_allocation_ledger_sequence_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  active_run_id TEXT;
  proof RECORD;
  expected_sequence BIGINT;
BEGIN
  IF NEW."id" LIKE 'repair-negative-balance-split:%' THEN
    active_run_id := current_setting('billing.balance_ledger_repair_run_id', TRUE);
    SELECT debt_proof.*, repair_account."status" AS repair_status,
      repair_run."status" AS run_status,
      billing_account."balance_grant_ledger_status" AS account_status
    INTO proof
    FROM "balance_ledger_personal_debt_allocation_repairs" debt_proof
    JOIN "balance_ledger_repair_accounts" repair_account
      ON repair_account."id" = debt_proof."repair_account_id"
    JOIN "balance_ledger_repair_runs" repair_run
      ON repair_run."id" = debt_proof."run_id"
    JOIN "billing_accounts" billing_account
      ON billing_account."id" = debt_proof."billing_account_id"
    WHERE debt_proof."created_debt_allocation_id" = NEW."id";

    IF NOT FOUND THEN
      RAISE EXCEPTION
        'reserved personal debt allocation lacks proof allocation=%',
        NEW."id"
        USING ERRCODE = '23514';
    END IF;
    expected_sequence := (proof."created_debt_snapshot"->>'ledger_sequence')::BIGINT;
    NEW."ledger_sequence" := expected_sequence;
    IF proof."id" IS NULL
      OR active_run_id IS DISTINCT FROM proof."run_id"
      OR proof.run_status IS DISTINCT FROM 'RUNNING'
      OR proof.repair_status IS DISTINCT FROM 'RUNNING'
      OR proof.account_status IS DISTINCT FROM 'LEGACY_DIRTY'
      OR proof."repair_kind" IS DISTINCT FROM 'LEGACY_DEBT_SPLIT_V1'
      OR expected_sequence >= 0
      OR proof."created_debt_snapshot" IS DISTINCT FROM to_jsonb(NEW)
    THEN
      RAISE EXCEPTION
        'reserved personal debt allocation lacks exact active proof allocation=%',
        NEW."id"
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;

  NEW."ledger_sequence" := nextval(
    'balance_consumption_allocation_ledger_seq'::regclass
  );
  RETURN NEW;
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION
      'reserved personal debt allocation contains invalid ledger sequence allocation=%',
      NEW."id"
      USING ERRCODE = '23514';
END
$$;

-- Keep the canonical legacy receipt matcher strict. This helper recognizes
-- only the one retired writer defect where every other receipt field is exact
-- but remainingCents was persisted as the full voucher amount instead of the
-- wallet-minted amount (amount - debt hole fill).
CREATE OR REPLACE FUNCTION "balance_legacy_voucher_full_remainder_receipt_matches"(
  evidence JSONB,
  target_account_id TEXT,
  target_funding_id TEXT,
  target_grant_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  funding_row "balance_transactions"%ROWTYPE;
  amount_cents NUMERIC;
  wallet_before_usd NUMERIC;
  hole_fill_usd NUMERIC;
  minted_cents NUMERIC;
  canonicalized_evidence JSONB;
BEGIN
  SELECT * INTO funding_row
  FROM "balance_transactions"
  WHERE "id" = target_funding_id
    AND "billing_account_id" = target_account_id;
  IF NOT FOUND OR jsonb_typeof(evidence) <> 'object' THEN
    RETURN FALSE;
  END IF;

  amount_cents := ROUND(funding_row."amount_usd" * 100, 0);
  wallet_before_usd := funding_row."balance_after_usd" - funding_row."amount_usd";
  hole_fill_usd := LEAST(
    funding_row."amount_usd",
    GREATEST(-wallet_before_usd, 0)
  );
  minted_cents := ROUND((funding_row."amount_usd" - hole_fill_usd) * 100, 0);
  IF hole_fill_usd <= 0
    OR jsonb_typeof(evidence #> '{result,grant,remainingCents}') <> 'number'
    OR (evidence #>> '{result,grant,remainingCents}')::NUMERIC <> amount_cents
  THEN
    RETURN FALSE;
  END IF;

  canonicalized_evidence := jsonb_set(
    evidence,
    '{result,grant,remainingCents}',
    to_jsonb(minted_cents),
    FALSE
  );
  RETURN "balance_legacy_voucher_receipt_matches"(
    canonicalized_evidence,
    target_account_id,
    target_funding_id,
    target_grant_id
  );
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range
    OR datetime_field_overflow
  THEN
    RETURN FALSE;
END
$$;

CREATE OR REPLACE FUNCTION "validate_balance_voucher_funding_proof_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  active_run_id TEXT;
  run_status TEXT;
  repair_row RECORD;
  account_row RECORD;
  rollout_row RECORD;
  transaction_row "balance_transactions"%ROWTYPE;
  grant_row "balance_grants"%ROWTYPE;
  transaction_snapshot JSONB;
  grant_snapshot JSONB;
  voucher_transaction_count BIGINT;
  live_reference_count BIGINT;
  live_full_match_count BIGINT;
  audit_reference_count BIGINT;
  audit_full_match_count BIGINT;
  wallet_before_usd NUMERIC;
  hole_fill_usd NUMERIC;
  minted_grant_amount_usd NUMERIC;
  amount_cents NUMERIC;
  valid_shape BOOLEAN;
BEGIN
  active_run_id := current_setting('billing.balance_ledger_repair_run_id', TRUE);
  SELECT "status" INTO run_status
  FROM "balance_ledger_repair_runs"
  WHERE "id" = NEW."run_id";
  SELECT * INTO repair_row
  FROM "balance_ledger_repair_accounts"
  WHERE "id" = NEW."repair_account_id";
  SELECT * INTO account_row
  FROM "billing_accounts"
  WHERE "id" = NEW."billing_account_id";
  SELECT * INTO rollout_row
  FROM "balance_ledger_rollout_control"
  WHERE "id" = 1;
  SELECT * INTO transaction_row
  FROM "balance_transactions" funding
  WHERE funding."id" = NEW."transaction_id";
  transaction_snapshot := to_jsonb(transaction_row);
  SELECT * INTO grant_row
  FROM "balance_grants" voucher_grant
  WHERE voucher_grant."id" = NEW."grant_id";
  grant_snapshot := to_jsonb(grant_row);

  wallet_before_usd := transaction_row."balance_after_usd"
    - transaction_row."amount_usd";
  hole_fill_usd := LEAST(
    transaction_row."amount_usd",
    GREATEST(-wallet_before_usd, 0)
  );
  minted_grant_amount_usd := transaction_row."amount_usd" - hole_fill_usd;
  amount_cents := ROUND(transaction_row."amount_usd" * 100, 0);

  SELECT COUNT(*) INTO voucher_transaction_count
  FROM "balance_transactions" funding
  WHERE funding."billing_account_id" = NEW."billing_account_id"
    AND substring(funding."description" FROM '^voucher:([^[:space:]]+)')
      = NEW."grant_id";

  SELECT COUNT(*), COUNT(*) FILTER (
    WHERE "balance_legacy_voucher_full_remainder_receipt_matches"(
      jsonb_build_object(
        'key', idem."key",
        'scope', idem."scope",
        'userId', idem."user_id",
        'status', idem."status",
        'result', idem."result",
        'createdAt', idem."created_at",
        'expiresAt', idem."expires_at"
      ),
      NEW."billing_account_id",
      NEW."transaction_id",
      NEW."grant_id"
    )
  )
  INTO live_reference_count, live_full_match_count
  FROM "idempotency_keys" idem
  WHERE idem."result" #>> '{transaction,id}' = NEW."transaction_id"
    OR idem."result" #>> '{grant,id}' = NEW."grant_id";

  SELECT COUNT(*), COUNT(*) FILTER (
    WHERE "balance_legacy_voucher_full_remainder_receipt_matches"(
      evidence,
      NEW."billing_account_id",
      NEW."transaction_id",
      NEW."grant_id"
    )
  )
  INTO audit_reference_count, audit_full_match_count
  FROM jsonb_array_elements(COALESCE(
    repair_row."before_snapshot"->'voucherIdempotencyEvidence',
    '[]'::JSONB
  )) evidence
  WHERE evidence #>> '{result,transaction,id}' = NEW."transaction_id"
    OR evidence #>> '{result,grant,id}' = NEW."grant_id";

  valid_shape :=
    active_run_id IS NOT DISTINCT FROM NEW."run_id"
    AND run_status IS NOT DISTINCT FROM 'RUNNING'
    AND repair_row."id" IS NOT NULL
    AND repair_row."run_id" IS NOT DISTINCT FROM NEW."run_id"
    AND repair_row."billing_account_id" IS NOT DISTINCT FROM NEW."billing_account_id"
    AND repair_row."status" IS NOT DISTINCT FROM 'RUNNING'
    AND account_row."id" IS NOT NULL
    AND account_row."type" IS NOT DISTINCT FROM 'personal'
    AND account_row."balance_grant_ledger_status" IS NOT DISTINCT FROM 'LEGACY_DIRTY'
    AND rollout_row."id" IS NOT NULL
    AND rollout_row."phase" IN ('EXPANDED', 'CUTOVER_READY', 'V2_CONTRACT')
    AND transaction_row."id" IS NOT NULL
    AND grant_row."id" IS NOT NULL
    AND transaction_snapshot IS NOT DISTINCT FROM NEW."transaction_snapshot"
    AND grant_snapshot IS NOT DISTINCT FROM NEW."grant_snapshot"
    AND transaction_row."billing_account_id" IS NOT DISTINCT FROM NEW."billing_account_id"
    AND grant_row."billing_account_id" IS NOT DISTINCT FROM NEW."billing_account_id"
    AND transaction_row."created_at" < rollout_row."expanded_at"
    AND grant_row."created_at" < rollout_row."expanded_at"
    AND transaction_row."type"::TEXT IS NOT DISTINCT FROM 'ADJUST'
    AND transaction_row."amount_usd" > 0
    AND transaction_row."amount_usd" IS NOT DISTINCT FROM amount_cents / 100
    AND transaction_row."operation_key" IS NULL
    AND transaction_row."order_id" IS NULL
    AND transaction_row."user_id" IS NOT NULL
    AND transaction_row."tenant_id" IS NOT NULL
    AND transaction_row."description"
      ~ '^voucher:[^[:space:]]+[[:space:]]+admin:[^[:space:]]+(?:[[:space:]]+[^[:space:]](?:.*[^[:space:]])?)?$'
    AND substring(transaction_row."description" FROM '^voucher:([^[:space:]]+)')
      IS NOT DISTINCT FROM NEW."grant_id"
    AND voucher_transaction_count = 1
    AND grant_row."source" IS NOT DISTINCT FROM 'VOUCHER'
    AND grant_row."order_id" IS NULL
    AND grant_row."user_id" IS NOT DISTINCT FROM transaction_row."user_id"
    AND grant_row."tenant_id" IS NOT DISTINCT FROM transaction_row."tenant_id"
    AND grant_row."product_id" IS NOT DISTINCT FROM transaction_row."product_id"
    AND grant_row."paid_amount_usd" IS NOT DISTINCT FROM 0
    AND grant_row."bonus_amount_usd" IS NOT DISTINCT FROM transaction_row."amount_usd"
    AND grant_row."granted_amount_usd" IS NOT DISTINCT FROM transaction_row."amount_usd"
    AND grant_row."discount_rate" IS NOT DISTINCT FROM 0
    AND grant_row."remaining_amount_usd" BETWEEN 0 AND grant_row."granted_amount_usd"
    AND (
      (
        grant_row."remaining_paid_amount_usd" IS NULL
        AND grant_row."remaining_bonus_amount_usd" IS NULL
      )
      OR (
        grant_row."remaining_paid_amount_usd" IS NOT NULL
        AND grant_row."remaining_bonus_amount_usd" IS NOT NULL
        AND grant_row."remaining_paid_amount_usd"
          + grant_row."remaining_bonus_amount_usd"
          = grant_row."remaining_amount_usd"
      )
    )
    AND NOT grant_row."is_expired"
    AND grant_row."valid_from" <= grant_row."created_at"
    AND grant_row."created_at" < transaction_row."created_at"
    AND (grant_row."expires_at" IS NULL OR grant_row."expires_at" > grant_row."valid_from")
    AND wallet_before_usd IS NOT DISTINCT FROM NEW."wallet_before_usd"
    AND hole_fill_usd IS NOT DISTINCT FROM NEW."hole_fill_usd"
    AND minted_grant_amount_usd >= 0
    AND NEW."operation_key" IS NOT DISTINCT FROM (
      'repair:voucher-funding:' || NEW."run_id" || ':'
      || NEW."transaction_id" || ':' || NEW."grant_id"
    );
  IF valid_shape IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION
      'legacy voucher proof is not authorized run=% account=% tx=% grant=%',
      NEW."run_id", NEW."billing_account_id", NEW."transaction_id", NEW."grant_id"
      USING ERRCODE = '23514';
  END IF;

  IF NEW."repair_kind" = 'LEGACY_PRE_IDEMPOTENCY_VOUCHER_V1' THEN
    valid_shape := wallet_before_usd = 0
      AND hole_fill_usd = 0
      AND live_reference_count = 0
      AND audit_reference_count = 0;
  ELSE
    valid_shape := NEW."repair_kind"
        = 'LEGACY_VOUCHER_FULL_REMAINDER_DEBT_ABSORPTION_V1'
      AND wallet_before_usd < 0
      AND hole_fill_usd > 0
      AND live_reference_count = 1
      AND live_full_match_count = 1
      AND audit_reference_count = 1
      AND audit_full_match_count = 1;
  END IF;
  IF valid_shape IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION
      'legacy voucher proof evidence is invalid kind=% tx=% grant=% live=%/% audit=%/%',
      NEW."repair_kind", NEW."transaction_id", NEW."grant_id",
      live_full_match_count, live_reference_count,
      audit_full_match_count, audit_reference_count
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range
    OR datetime_field_overflow
  THEN
    RAISE EXCEPTION
      'legacy voucher proof contains invalid typed evidence tx=% grant=%',
      NEW."transaction_id", NEW."grant_id"
      USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER "balance_voucher_funding_repairs_insert_guard"
BEFORE INSERT
ON "balance_ledger_voucher_funding_repairs"
FOR EACH ROW
EXECUTE FUNCTION "validate_balance_voucher_funding_proof_insert"();

-- The generic allocation audit remains reusable for sequence, component and
-- settlement repairs. Only the exact pre-V2 personal overdraw rewrite needs
-- the additional semantic proof, because it changes the economic boundary of
-- one allocation (grant amount/source versus debt).
CREATE OR REPLACE FUNCTION "balance_personal_debt_rewrite_is_candidate"(
  before_snapshot JSONB,
  after_snapshot JSONB
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(EXISTS (
    SELECT 1
    FROM public."balance_transactions" transaction_row
    JOIN public."billing_accounts" account_row
      ON account_row."id" = transaction_row."billing_account_id"
    JOIN public."balance_grants" source_grant
      ON source_grant."id" = before_snapshot->>'balance_grant_id'
    WHERE transaction_row."id" = before_snapshot->>'balance_transaction_id'
      AND account_row."type" = 'personal'
      AND source_grant."source" <> 'MIGRATION_OPENING'
      AND transaction_row."type"::TEXT = 'CONSUME'
      AND transaction_row."amount_usd" < 0
      AND transaction_row."balance_after_usd" < 0
      AND before_snapshot->>'source' = 'BALANCE_GRANT'
      AND before_snapshot->>'balance_grant_id' IS NOT NULL
      AND (before_snapshot->>'amount_usd')::NUMERIC = -transaction_row."amount_usd"
      AND (
        after_snapshot->>'source' = 'NEGATIVE_BALANCE'
        OR (after_snapshot->>'amount_usd')::NUMERIC
          IS DISTINCT FROM (before_snapshot->>'amount_usd')::NUMERIC
      )
  ), FALSE)
$$;

CREATE OR REPLACE FUNCTION "balance_personal_debt_exact_proof_exists"(
  target_run_id TEXT,
  target_repair_account_id TEXT,
  target_account_id TEXT,
  target_allocation_id TEXT,
  before_snapshot JSONB,
  after_snapshot JSONB
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "balance_ledger_personal_debt_allocation_repairs" proof
    WHERE proof."run_id" = target_run_id
      AND proof."repair_account_id" = target_repair_account_id
      AND proof."billing_account_id" = target_account_id
      AND proof."source_allocation_id" = target_allocation_id
      AND proof."source_before_snapshot" = before_snapshot
      AND proof."source_after_snapshot" = after_snapshot
  )
$$;

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
  semantic_proof_required BOOLEAN;
  semantic_proof_valid BOOLEAN;
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

  semantic_proof_required := "balance_personal_debt_rewrite_is_candidate"(
    NEW."before_snapshot",
    NEW."after_snapshot"
  );
  semantic_proof_valid := "balance_personal_debt_exact_proof_exists"(
    NEW."run_id",
    NEW."repair_account_id",
    NEW."billing_account_id",
    NEW."allocation_id",
    NEW."before_snapshot",
    NEW."after_snapshot"
  );

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
    OR (semantic_proof_required AND NOT semantic_proof_valid)
  THEN
    RAISE EXCEPTION
      'balance allocation repair audit is not authorized run=% account=% allocation=%',
      NEW."run_id", NEW."billing_account_id", NEW."allocation_id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION
      'balance allocation repair audit contains invalid typed evidence allocation=%',
      NEW."allocation_id"
      USING ERRCODE = '23514';
END
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
  semantic_proof_required BOOLEAN;
  semantic_proof_valid BOOLEAN;
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

  semantic_proof_required := "balance_personal_debt_rewrite_is_candidate"(
    to_jsonb(OLD),
    to_jsonb(NEW)
  );
  semantic_proof_valid := "balance_personal_debt_exact_proof_exists"(
    active_run_id,
    repair_row."id",
    OLD."billing_account_id",
    OLD."id",
    to_jsonb(OLD),
    to_jsonb(NEW)
  );
  exact_repair_authorized := active_run_id IS NOT NULL
    AND repair_row."id" IS NOT NULL
    AND audit_row."id" IS NOT NULL
    AND audit_row."repair_account_id" IS NOT DISTINCT FROM repair_row."id"
    AND audit_row."before_snapshot" IS NOT DISTINCT FROM to_jsonb(OLD)
    AND audit_row."after_snapshot" IS NOT DISTINCT FROM to_jsonb(NEW)
    AND (NOT semantic_proof_required OR semantic_proof_valid);
  IF exact_repair_authorized THEN
    RETURN NEW;
  END IF;

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
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RAISE EXCEPTION
      'balance allocation financial rewrite contains invalid typed evidence allocation=%',
      OLD."id"
      USING ERRCODE = '23514';
END
$$;

CREATE OR REPLACE FUNCTION "balance_voucher_funding_proof_context_is_valid"(
  target_proof_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  proof_row RECORD;
  repair_row RECORD;
  run_status TEXT;
  account_row RECORD;
  rollout_row RECORD;
  transaction_row "balance_transactions"%ROWTYPE;
  grant_row "balance_grants"%ROWTYPE;
  archived_reference_count BIGINT;
  archived_full_match_count BIGINT;
  active_context BOOLEAN;
  terminal_context BOOLEAN;
BEGIN
  SELECT * INTO proof_row
  FROM "balance_ledger_voucher_funding_repairs"
  WHERE "id" = target_proof_id;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;
  SELECT * INTO repair_row
  FROM "balance_ledger_repair_accounts"
  WHERE "id" = proof_row."repair_account_id";
  SELECT "status" INTO run_status
  FROM "balance_ledger_repair_runs"
  WHERE "id" = proof_row."run_id";
  SELECT * INTO account_row
  FROM "billing_accounts"
  WHERE "id" = proof_row."billing_account_id";
  SELECT * INTO rollout_row
  FROM "balance_ledger_rollout_control"
  WHERE "id" = 1;
  SELECT * INTO transaction_row
  FROM "balance_transactions"
  WHERE "id" = proof_row."transaction_id";
  SELECT * INTO grant_row
  FROM "balance_grants"
  WHERE "id" = proof_row."grant_id";

  SELECT COUNT(*), COUNT(*) FILTER (
    WHERE "balance_legacy_voucher_full_remainder_receipt_matches"(
      evidence,
      proof_row."billing_account_id",
      proof_row."transaction_id",
      proof_row."grant_id"
    )
  )
  INTO archived_reference_count, archived_full_match_count
  FROM jsonb_array_elements(COALESCE(
    repair_row."before_snapshot"->'voucherIdempotencyEvidence',
    '[]'::JSONB
  )) evidence
  WHERE evidence #>> '{result,transaction,id}' = proof_row."transaction_id"
    OR evidence #>> '{result,grant,id}' = proof_row."grant_id";

  active_context :=
    current_setting('billing.balance_ledger_repair_run_id', TRUE)
      IS NOT DISTINCT FROM proof_row."run_id"
    AND run_status IS NOT DISTINCT FROM 'RUNNING'
    AND repair_row."status" IS NOT DISTINCT FROM 'RUNNING'
    AND account_row."balance_grant_ledger_status" IS NOT DISTINCT FROM 'LEGACY_DIRTY';
  terminal_context :=
    run_status IN ('RUNNING', 'COMPLETED', 'COMPLETED_WITH_EXCEPTIONS')
    AND repair_row."status" IS NOT DISTINCT FROM 'APPLIED'
    AND account_row."balance_grant_ledger_status" IS NOT DISTINCT FROM 'RECONCILED_V2'
    AND account_row."balance_grant_ledger_version" IS NOT DISTINCT FROM 2
    AND repair_row."replay_hash" IS NOT DISTINCT FROM
      account_row."balance_grant_ledger_hash";

  RETURN (active_context OR terminal_context)
    AND repair_row."run_id" IS NOT DISTINCT FROM proof_row."run_id"
    AND repair_row."billing_account_id" IS NOT DISTINCT FROM proof_row."billing_account_id"
    AND account_row."type" IS NOT DISTINCT FROM 'personal'
    AND rollout_row."id" IS NOT NULL
    AND rollout_row."phase" IN ('EXPANDED', 'CUTOVER_READY', 'V2_CONTRACT')
    AND transaction_row."id" IS NOT NULL
    AND grant_row."id" IS NOT NULL
    AND transaction_row."billing_account_id"
      IS NOT DISTINCT FROM proof_row."billing_account_id"
    AND grant_row."billing_account_id"
      IS NOT DISTINCT FROM proof_row."billing_account_id"
    AND transaction_row."created_at" < rollout_row."expanded_at"
    AND grant_row."created_at" < rollout_row."expanded_at"
    AND (to_jsonb(transaction_row) - 'ledger_sequence')
      IS NOT DISTINCT FROM (proof_row."transaction_snapshot" - 'ledger_sequence')
    AND (
      to_jsonb(grant_row)
        - 'remaining_amount_usd' - 'remaining_paid_amount_usd'
        - 'remaining_bonus_amount_usd' - 'updated_at' - 'is_expired'
    ) IS NOT DISTINCT FROM (
      proof_row."grant_snapshot"
        - 'remaining_amount_usd' - 'remaining_paid_amount_usd'
        - 'remaining_bonus_amount_usd' - 'updated_at' - 'is_expired'
    )
    AND proof_row."operation_key" IS NOT DISTINCT FROM (
      'repair:voucher-funding:' || proof_row."run_id" || ':'
      || proof_row."transaction_id" || ':' || proof_row."grant_id"
    )
    AND proof_row."finance_approval_ref" = btrim(proof_row."finance_approval_ref")
    AND proof_row."technical_approval_ref" = btrim(proof_row."technical_approval_ref")
    AND length(proof_row."finance_approval_ref") BETWEEN 1 AND 200
    AND length(proof_row."technical_approval_ref") BETWEEN 1 AND 200
    AND proof_row."finance_approval_ref" <> proof_row."technical_approval_ref"
    AND (
      (
        proof_row."repair_kind" = 'LEGACY_PRE_IDEMPOTENCY_VOUCHER_V1'
        AND proof_row."wallet_before_usd" = 0
        AND proof_row."hole_fill_usd" = 0
        AND archived_reference_count = 0
      )
      OR (
        proof_row."repair_kind"
          = 'LEGACY_VOUCHER_FULL_REMAINDER_DEBT_ABSORPTION_V1'
        AND proof_row."wallet_before_usd" < 0
        AND proof_row."hole_fill_usd" > 0
        AND archived_reference_count = 1
        AND archived_full_match_count = 1
      )
    );
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range
    OR datetime_field_overflow
  THEN
    RETURN FALSE;
END
$$;

-- Authority order is deliberate:
--   * one live receipt is authoritative, except the exact full-remainder bug
--     may be paired with one approved immutable proof;
--   * after TTL, the APPLIED repair snapshot is the durable receipt copy;
--   * pre-idempotency rows may use a proof only when both receipt sources are
--     absent. Duplicates or contradictory evidence always fail closed.
CREATE OR REPLACE FUNCTION "balance_legacy_voucher_funding_is_proven"(
  target_account_id TEXT,
  target_funding_id TEXT,
  target_grant_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  live_count BIGINT;
  live_match_count BIGINT;
  live_full_match_count BIGINT;
  audit_count BIGINT;
  audit_match_count BIGINT;
  audit_full_match_count BIGINT;
  full_proof_count BIGINT;
  valid_proof_count BIGINT;
BEGIN
  SELECT COUNT(*), COUNT(*) FILTER (
    WHERE "balance_legacy_voucher_receipt_matches"(
      jsonb_build_object(
        'key', idem."key", 'scope', idem."scope", 'userId', idem."user_id",
        'status', idem."status", 'result', idem."result",
        'createdAt', idem."created_at", 'expiresAt', idem."expires_at"
      ),
      target_account_id, target_funding_id, target_grant_id
    )
  ), COUNT(*) FILTER (
    WHERE "balance_legacy_voucher_full_remainder_receipt_matches"(
      jsonb_build_object(
        'key', idem."key", 'scope', idem."scope", 'userId', idem."user_id",
        'status', idem."status", 'result', idem."result",
        'createdAt', idem."created_at", 'expiresAt', idem."expires_at"
      ),
      target_account_id, target_funding_id, target_grant_id
    )
  )
  INTO live_count, live_match_count, live_full_match_count
  FROM "idempotency_keys" idem
  WHERE idem."result" #>> '{transaction,id}' = target_funding_id
    OR idem."result" #>> '{grant,id}' = target_grant_id;

  SELECT COUNT(*) FILTER (
    WHERE proof."repair_kind"
      = 'LEGACY_VOUCHER_FULL_REMAINDER_DEBT_ABSORPTION_V1'
      AND "balance_voucher_funding_proof_context_is_valid"(proof."id")
  ), COUNT(*) FILTER (
    WHERE "balance_voucher_funding_proof_context_is_valid"(proof."id")
  )
  INTO full_proof_count, valid_proof_count
  FROM "balance_ledger_voucher_funding_repairs" proof
  WHERE proof."billing_account_id" = target_account_id
    AND proof."transaction_id" = target_funding_id
    AND proof."grant_id" = target_grant_id;

  IF live_count <> 0 THEN
    IF live_count <> 1 THEN
      RETURN FALSE;
    END IF;
    IF live_match_count = 1 THEN
      RETURN TRUE;
    END IF;
    RETURN live_full_match_count = 1 AND full_proof_count = 1;
  END IF;

  SELECT COUNT(*), COUNT(*) FILTER (
    WHERE "balance_legacy_voucher_receipt_matches"(
      evidence, target_account_id, target_funding_id, target_grant_id
    )
  ), COUNT(*) FILTER (
    WHERE "balance_legacy_voucher_full_remainder_receipt_matches"(
      evidence, target_account_id, target_funding_id, target_grant_id
    )
  )
  INTO audit_count, audit_match_count, audit_full_match_count
  FROM "billing_accounts" account_row
  JOIN "balance_ledger_repair_accounts" repair_account
    ON repair_account."billing_account_id" = account_row."id"
    AND repair_account."status" = 'APPLIED'
    AND repair_account."after_snapshot" IS NOT NULL
    AND repair_account."replay_hash" = account_row."balance_grant_ledger_hash"
  JOIN "balance_ledger_repair_runs" repair_run
    ON repair_run."id" = repair_account."run_id"
    AND repair_run."status" IN ('RUNNING', 'COMPLETED', 'COMPLETED_WITH_EXCEPTIONS')
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(
    repair_account."before_snapshot"->'voucherIdempotencyEvidence',
    '[]'::JSONB
  )) evidence
  WHERE account_row."id" = target_account_id
    AND account_row."balance_grant_ledger_status" = 'RECONCILED_V2'
    AND account_row."balance_grant_ledger_version" = 2
    AND repair_account."before_snapshot"->>'billingAccountId' = target_account_id
    AND (
      evidence #>> '{result,transaction,id}' = target_funding_id
      OR evidence #>> '{result,grant,id}' = target_grant_id
    );
  IF audit_count <> 0 THEN
    IF audit_count <> 1 THEN
      RETURN FALSE;
    END IF;
    IF audit_match_count = 1 THEN
      RETURN TRUE;
    END IF;
    RETURN audit_full_match_count = 1 AND full_proof_count = 1;
  END IF;

  RETURN valid_proof_count = 1;
END
$$;

CREATE OR REPLACE FUNCTION "validate_balance_personal_debt_repair_terminal"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  run_status TEXT;
  repair_row RECORD;
  account_row RECORD;
  allocation_audit RECORD;
  source_snapshot JSONB;
  created_snapshot JSONB;
  proof_count BIGINT;
  plan_count BIGINT;
  plan_match_count BIGINT;
BEGIN
  SELECT "status" INTO run_status
  FROM "balance_ledger_repair_runs"
  WHERE "id" = NEW."run_id";
  SELECT * INTO repair_row
  FROM "balance_ledger_repair_accounts"
  WHERE "id" = NEW."repair_account_id";
  SELECT * INTO account_row
  FROM "billing_accounts"
  WHERE "id" = NEW."billing_account_id";
  SELECT * INTO allocation_audit
  FROM "balance_ledger_allocation_repairs"
  WHERE "run_id" = NEW."run_id"
    AND "repair_account_id" = NEW."repair_account_id"
    AND "billing_account_id" = NEW."billing_account_id"
    AND "allocation_id" = NEW."source_allocation_id";
  SELECT to_jsonb(allocation) INTO source_snapshot
  FROM "balance_consumption_allocations" allocation
  WHERE allocation."id" = NEW."source_allocation_id";
  SELECT to_jsonb(allocation) INTO created_snapshot
  FROM "balance_consumption_allocations" allocation
  WHERE allocation."id" = NEW."created_debt_allocation_id";

  SELECT COUNT(*) INTO proof_count
  FROM "balance_ledger_personal_debt_allocation_repairs" proof
  WHERE proof."run_id" = NEW."run_id"
    AND proof."repair_account_id" = NEW."repair_account_id"
    AND proof."billing_account_id" = NEW."billing_account_id";
  SELECT COUNT(*) INTO plan_count
  FROM jsonb_array_elements(COALESCE(
    repair_row."after_snapshot"->'personalDebtAllocationRepairs',
    '[]'::JSONB
  )) mutation;
  SELECT COUNT(*) INTO plan_match_count
  FROM jsonb_array_elements(COALESCE(
    repair_row."after_snapshot"->'personalDebtAllocationRepairs',
    '[]'::JSONB
  )) mutation
  WHERE (mutation->>'proofVersion')::INTEGER = NEW."proof_version"
    AND mutation->>'repairKind' = NEW."repair_kind"
    AND mutation->>'transactionId' = NEW."transaction_id"
    AND mutation->>'sourceAllocationId' = NEW."source_allocation_id"
    AND mutation->>'createdDebtAllocationId'
      IS NOT DISTINCT FROM NEW."created_debt_allocation_id"
    AND mutation->'sourceBeforeSnapshot'
      IS NOT DISTINCT FROM NEW."source_before_snapshot"
    AND mutation->'sourceAfterSnapshot'
      IS NOT DISTINCT FROM NEW."source_after_snapshot"
    AND mutation->'createdDebtSnapshot'
      IS NOT DISTINCT FROM COALESCE(NEW."created_debt_snapshot", 'null'::JSONB);

  IF run_status IS DISTINCT FROM 'RUNNING'
    OR repair_row."id" IS NULL
    OR repair_row."run_id" IS DISTINCT FROM NEW."run_id"
    OR repair_row."billing_account_id" IS DISTINCT FROM NEW."billing_account_id"
    OR repair_row."status" IS DISTINCT FROM 'APPLIED'
    OR repair_row."replay_hash" IS DISTINCT FROM account_row."balance_grant_ledger_hash"
    OR account_row."type" IS DISTINCT FROM 'personal'
    OR account_row."balance_grant_ledger_status" IS DISTINCT FROM 'RECONCILED_V2'
    OR account_row."balance_grant_ledger_version" IS DISTINCT FROM 2
    OR allocation_audit."id" IS NULL
    OR allocation_audit."before_snapshot"
      IS DISTINCT FROM NEW."source_before_snapshot"
    OR allocation_audit."after_snapshot"
      IS DISTINCT FROM NEW."source_after_snapshot"
    OR source_snapshot IS DISTINCT FROM NEW."source_after_snapshot"
    OR (repair_row."after_snapshot"->>'personalDebtAllocationRepairCount')::BIGINT
      IS DISTINCT FROM proof_count
    OR (
      NEW."repair_kind" = 'LEGACY_DEBT_SPLIT_V1'
      AND (
        NEW."created_debt_allocation_id" IS NULL
        OR created_snapshot IS DISTINCT FROM NEW."created_debt_snapshot"
      )
    )
    OR (
      NEW."repair_kind" = 'LEGACY_DEBT_RECLASS_V1'
      AND (
        NEW."created_debt_allocation_id" IS NOT NULL
        OR created_snapshot IS NOT NULL
      )
    )
    OR proof_count <> plan_count
    OR plan_match_count <> 1
  THEN
    RAISE EXCEPTION
      'legacy personal debt proof cannot commit before exact canonical promotion run=% account=% allocation=%',
      NEW."run_id", NEW."billing_account_id", NEW."source_allocation_id"
      USING ERRCODE = '23514';
  END IF;

  PERFORM "assert_balance_ledger_canonical_promotion"(
    NEW."billing_account_id",
    NEW."run_id",
    FALSE
  );
  RETURN NULL;
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range
    OR datetime_field_overflow
  THEN
    RAISE EXCEPTION
      'legacy personal debt terminal proof contains invalid typed evidence allocation=%',
      NEW."source_allocation_id"
      USING ERRCODE = '23514';
END
$$;

CREATE CONSTRAINT TRIGGER "balance_personal_debt_repairs_terminal_deferred"
AFTER INSERT
ON "balance_ledger_personal_debt_allocation_repairs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_balance_personal_debt_repair_terminal"();

CREATE OR REPLACE FUNCTION "validate_balance_voucher_funding_proof_terminal"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  run_status TEXT;
  repair_row RECORD;
  account_row RECORD;
  transaction_row "balance_transactions"%ROWTYPE;
  proof_count BIGINT;
  plan_count BIGINT;
  plan_match_count BIGINT;
  settlement_count BIGINT;
  settlement_allocation_count BIGINT;
  settlement_total NUMERIC;
  invalid_settlement_count BIGINT;
  invalid_opening_retirement_count BIGINT;
BEGIN
  SELECT "status" INTO run_status
  FROM "balance_ledger_repair_runs"
  WHERE "id" = NEW."run_id";
  SELECT * INTO repair_row
  FROM "balance_ledger_repair_accounts"
  WHERE "id" = NEW."repair_account_id";
  SELECT * INTO account_row
  FROM "billing_accounts"
  WHERE "id" = NEW."billing_account_id";
  SELECT * INTO transaction_row
  FROM "balance_transactions"
  WHERE "id" = NEW."transaction_id";

  SELECT COUNT(*) INTO proof_count
  FROM "balance_ledger_voucher_funding_repairs" proof
  WHERE proof."run_id" = NEW."run_id"
    AND proof."repair_account_id" = NEW."repair_account_id"
    AND proof."billing_account_id" = NEW."billing_account_id";
  SELECT COUNT(*) INTO plan_count
  FROM jsonb_array_elements(COALESCE(
    repair_row."after_snapshot"->'voucherFundingProofs',
    '[]'::JSONB
  )) proof_plan;
  SELECT COUNT(*) INTO plan_match_count
  FROM jsonb_array_elements(COALESCE(
    repair_row."after_snapshot"->'voucherFundingProofs',
    '[]'::JSONB
  )) proof_plan
  WHERE (proof_plan->>'proofVersion')::INTEGER = NEW."proof_version"
    AND proof_plan->>'repairKind' = NEW."repair_kind"
    AND proof_plan->>'transactionId' = NEW."transaction_id"
    AND proof_plan->>'grantId' = NEW."grant_id"
    AND (proof_plan->>'walletBeforeUsd')::NUMERIC = NEW."wallet_before_usd"
    AND (proof_plan->>'holeFillUsd')::NUMERIC = NEW."hole_fill_usd"
    AND proof_plan->>'financeApprovalRef' = NEW."finance_approval_ref"
    AND proof_plan->>'technicalApprovalRef' = NEW."technical_approval_ref";

  SELECT COUNT(*), COUNT(DISTINCT settlement."allocation_id"),
    COALESCE(SUM(settlement."amount_usd"), 0),
    COUNT(*) FILTER (
      WHERE settlement."repair_run_id" IS DISTINCT FROM NEW."run_id"
        OR settlement."trigger" IS DISTINCT FROM 'REPAIR'
        OR settlement."billing_account_id" IS DISTINCT FROM NEW."billing_account_id"
        OR settlement."balance_grant_id" IS DISTINCT FROM NEW."grant_id"
        OR settlement."debt_source" IS DISTINCT FROM 'NEGATIVE_BALANCE'
        OR settlement."paid_usd" <> 0
        OR settlement."bonus_usd" IS DISTINCT FROM settlement."amount_usd"
        OR settlement."occurred_at" IS DISTINCT FROM transaction_row."created_at"
    )
  INTO settlement_count, settlement_allocation_count,
    settlement_total, invalid_settlement_count
  FROM "enterprise_credit_settlements" settlement
  WHERE settlement."repayment_transaction_id" = NEW."transaction_id";

  SELECT COUNT(*) INTO invalid_opening_retirement_count
  FROM "enterprise_credit_settlements" settlement
  WHERE settlement."repayment_transaction_id" = NEW."transaction_id"
    AND NOT EXISTS (
      SELECT 1
      FROM "balance_ledger_grant_retirement_repairs" retirement
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(
        repair_row."before_snapshot"->'grants',
        '[]'::JSONB
      )) before_grant
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(
        repair_row."after_snapshot"->'migrationOpeningDebtMutations',
        '[]'::JSONB
      )) opening_mutation
      WHERE retirement."run_id" = NEW."run_id"
        AND retirement."repair_account_id" = NEW."repair_account_id"
        AND retirement."billing_account_id" = NEW."billing_account_id"
        AND retirement."allocation_id" = settlement."allocation_id"
        AND "balance_migration_opening_retirement_proof_is_valid"(
          retirement."id",
          NEW."billing_account_id",
          NEW."run_id",
          NEW."repair_account_id",
          before_grant,
          opening_mutation
        )
    );

  IF run_status IS DISTINCT FROM 'RUNNING'
    OR repair_row."id" IS NULL
    OR repair_row."run_id" IS DISTINCT FROM NEW."run_id"
    OR repair_row."billing_account_id" IS DISTINCT FROM NEW."billing_account_id"
    OR repair_row."status" IS DISTINCT FROM 'APPLIED'
    OR repair_row."replay_hash" IS DISTINCT FROM account_row."balance_grant_ledger_hash"
    OR account_row."type" IS DISTINCT FROM 'personal'
    OR account_row."balance_grant_ledger_status" IS DISTINCT FROM 'RECONCILED_V2'
    OR account_row."balance_grant_ledger_version" IS DISTINCT FROM 2
    OR NOT "balance_voucher_funding_proof_context_is_valid"(NEW."id")
    OR (repair_row."after_snapshot"->>'voucherFundingProofCount')::BIGINT
      IS DISTINCT FROM proof_count
    OR proof_count <> plan_count
    OR plan_match_count <> 1
    OR invalid_settlement_count <> 0
    OR (
      NEW."repair_kind" = 'LEGACY_PRE_IDEMPOTENCY_VOUCHER_V1'
      AND (
        NEW."wallet_before_usd" <> 0
        OR NEW."hole_fill_usd" <> 0
        OR settlement_count <> 0
        OR invalid_opening_retirement_count <> 0
      )
    )
    OR (
      NEW."repair_kind"
        = 'LEGACY_VOUCHER_FULL_REMAINDER_DEBT_ABSORPTION_V1'
      AND (
        settlement_count = 0
        OR settlement_count <> settlement_allocation_count
        OR settlement_total IS DISTINCT FROM NEW."hole_fill_usd"
        OR invalid_opening_retirement_count <> 0
      )
    )
  THEN
    RAISE EXCEPTION
      'legacy voucher proof cannot commit before exact canonical promotion run=% account=% tx=% grant=%',
      NEW."run_id", NEW."billing_account_id", NEW."transaction_id", NEW."grant_id"
      USING ERRCODE = '23514';
  END IF;

  PERFORM "assert_balance_ledger_canonical_promotion"(
    NEW."billing_account_id",
    NEW."run_id",
    FALSE
  );
  RETURN NULL;
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range
    OR datetime_field_overflow
  THEN
    RAISE EXCEPTION
      'legacy voucher terminal proof contains invalid typed evidence tx=% grant=%',
      NEW."transaction_id", NEW."grant_id"
      USING ERRCODE = '23514';
END
$$;

CREATE CONSTRAINT TRIGGER "balance_voucher_proofs_terminal_deferred"
AFTER INSERT
ON "balance_ledger_voucher_funding_repairs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_balance_voucher_funding_proof_terminal"();

COMMIT;
