-- Retire the exact pre-V2 MIGRATION_OPENING writer artifact only after its
-- sole allocation has been converted to canonical personal debt by the normal
-- audited repair path. The deleted grant's complete database row remains an
-- immutable financial proof; no generic balance-grant delete path is opened.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '60s';

CREATE TABLE "balance_ledger_grant_retirement_repairs" (
  "id" TEXT PRIMARY KEY,
  "operation_key" TEXT NOT NULL UNIQUE,
  "run_id" TEXT NOT NULL,
  "repair_account_id" TEXT NOT NULL,
  "billing_account_id" TEXT NOT NULL,
  "grant_id" TEXT NOT NULL,
  "allocation_id" TEXT NOT NULL,
  "before_snapshot" JSONB NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "balance_ledger_grant_retirements_run_fkey"
    FOREIGN KEY ("run_id") REFERENCES "balance_ledger_repair_runs"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_grant_retirements_repair_account_fkey"
    FOREIGN KEY ("repair_account_id") REFERENCES "balance_ledger_repair_accounts"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_grant_retirements_billing_account_fkey"
    FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_grant_retirements_allocation_fkey"
    FOREIGN KEY ("allocation_id") REFERENCES "balance_consumption_allocations"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
);

CREATE UNIQUE INDEX "balance_ledger_grant_retirements_run_grant_key"
  ON "balance_ledger_grant_retirement_repairs"("run_id", "grant_id");
CREATE UNIQUE INDEX "balance_ledger_grant_retirements_run_allocation_key"
  ON "balance_ledger_grant_retirement_repairs"("run_id", "allocation_id");
CREATE INDEX "balance_ledger_grant_retirements_account_created_idx"
  ON "balance_ledger_grant_retirement_repairs"("billing_account_id", "created_at");

CREATE OR REPLACE FUNCTION "validate_balance_ledger_grant_retirement_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  active_run_id TEXT;
  run_status TEXT;
  repair_row RECORD;
  account_row RECORD;
  grant_row RECORD;
  allocation_repair_row RECORD;
  current_allocation RECORD;
  transaction_row RECORD;
  matching_allocation_repair_count BIGINT;
  external_reference_count BIGINT;
  transaction_allocation_count BIGINT;
  transaction_grant_amount NUMERIC;
  transaction_debt_count BIGINT;
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
  SELECT grant_record.*, to_jsonb(grant_record) AS database_snapshot INTO grant_row
  FROM "balance_grants" grant_record
  WHERE grant_record."id" = NEW."grant_id"
  FOR UPDATE;
  SELECT allocation_repair.* INTO allocation_repair_row
  FROM "balance_ledger_allocation_repairs" allocation_repair
  WHERE allocation_repair."run_id" = NEW."run_id"
    AND allocation_repair."repair_account_id" = NEW."repair_account_id"
    AND allocation_repair."billing_account_id" = NEW."billing_account_id"
    AND allocation_repair."allocation_id" = NEW."allocation_id";
  SELECT allocation.*, to_jsonb(allocation) AS database_snapshot
    INTO current_allocation
  FROM "balance_consumption_allocations" allocation
  WHERE allocation."id" = NEW."allocation_id"
  FOR UPDATE;
  SELECT transaction_record.* INTO transaction_row
  FROM "balance_transactions" transaction_record
  WHERE transaction_record."id"
    = allocation_repair_row."before_snapshot"->>'balance_transaction_id';

  SELECT COUNT(*) INTO matching_allocation_repair_count
  FROM "balance_ledger_allocation_repairs" allocation_repair
  WHERE allocation_repair."run_id" = NEW."run_id"
    AND allocation_repair."repair_account_id" = NEW."repair_account_id"
    AND allocation_repair."billing_account_id" = NEW."billing_account_id"
    AND allocation_repair."before_snapshot"->>'balance_grant_id' = NEW."grant_id";

  SELECT
    (SELECT COUNT(*) FROM "balance_consumption_allocations"
      WHERE "balance_grant_id" = NEW."grant_id")
    + (SELECT COUNT(*) FROM "enterprise_credit_settlements"
      WHERE "balance_grant_id" = NEW."grant_id")
    + (SELECT COUNT(*) FROM "balance_grant_expiries"
      WHERE "balance_grant_id" = NEW."grant_id")
    + (SELECT COUNT(*) FROM "balance_grant_refunds"
      WHERE "balance_grant_id" = NEW."grant_id")
    + (SELECT COUNT(*) FROM "balance_grant_refund_allocations"
      WHERE "balance_grant_id" = NEW."grant_id")
    + (SELECT COUNT(*) FROM "balance_ledger_account_transfer_grants"
      WHERE "grant_id" = NEW."grant_id")
    + (SELECT COUNT(*) FROM "balance_ledger_grant_creation_repairs"
      WHERE "balance_grant_id" = NEW."grant_id")
    + (SELECT COUNT(*) FROM "balance_ledger_grant_component_repairs"
      WHERE "grant_id" = NEW."grant_id")
  INTO external_reference_count;

  SELECT
    COUNT(*),
    COALESCE(SUM(allocation."amount_usd") FILTER (
      WHERE allocation."source" = 'BALANCE_GRANT'
    ), 0),
    COUNT(*) FILTER (WHERE allocation."source" = 'NEGATIVE_BALANCE')
  INTO transaction_allocation_count, transaction_grant_amount, transaction_debt_count
  FROM "balance_consumption_allocations" allocation
  WHERE allocation."billing_account_id" = NEW."billing_account_id"
    AND allocation."balance_transaction_id" = transaction_row."id";

  IF active_run_id IS NULL
    OR NEW."run_id" IS DISTINCT FROM active_run_id
    OR run_status IS DISTINCT FROM 'RUNNING'
    OR repair_row."id" IS NULL
    OR repair_row."run_id" IS DISTINCT FROM NEW."run_id"
    OR repair_row."billing_account_id" IS DISTINCT FROM NEW."billing_account_id"
    OR repair_row."status" IS DISTINCT FROM 'RUNNING'
    OR account_row."id" IS NULL
    OR account_row."type" IS DISTINCT FROM 'personal'
    OR account_row."balance_grant_ledger_status" IS DISTINCT FROM 'LEGACY_DIRTY'
    OR grant_row."id" IS NULL
    OR grant_row."billing_account_id" IS DISTINCT FROM NEW."billing_account_id"
    OR NEW."before_snapshot" IS DISTINCT FROM grant_row.database_snapshot
    OR NEW."operation_key" IS DISTINCT FROM (
      'repair:migration-opening-retirement:' || NEW."run_id" || ':' || NEW."grant_id"
    )
    OR EXISTS (
      SELECT 1 FROM "balance_ledger_grant_retirement_repairs" prior
      WHERE prior."grant_id" = NEW."grant_id"
        OR prior."allocation_id" = NEW."allocation_id"
    )
    OR grant_row."source" IS DISTINCT FROM 'MIGRATION_OPENING'
    OR grant_row."order_id" IS NOT NULL
    OR grant_row."paid_amount_usd" <= 0
    OR grant_row."bonus_amount_usd" <> 0
    OR grant_row."granted_amount_usd" IS DISTINCT FROM grant_row."paid_amount_usd"
    OR grant_row."remaining_amount_usd" <> 0
    OR NOT (
      (grant_row."remaining_paid_amount_usd" IS NULL
        AND grant_row."remaining_bonus_amount_usd" IS NULL)
      OR (grant_row."remaining_paid_amount_usd" = 0
        AND grant_row."remaining_bonus_amount_usd" = 0)
    )
    OR grant_row."discount_rate" <> 1
    OR grant_row."expires_at" IS NOT NULL
    OR grant_row."is_expired"
    OR allocation_repair_row."id" IS NULL
    OR matching_allocation_repair_count <> 1
    OR allocation_repair_row."before_snapshot"->>'id'
      IS DISTINCT FROM NEW."allocation_id"
    OR allocation_repair_row."before_snapshot"->>'billing_account_id'
      IS DISTINCT FROM NEW."billing_account_id"
    OR allocation_repair_row."before_snapshot"->>'balance_grant_id'
      IS DISTINCT FROM NEW."grant_id"
    OR allocation_repair_row."before_snapshot"->>'source'
      IS DISTINCT FROM 'BALANCE_GRANT'
    OR allocation_repair_row."after_snapshot"->>'id'
      IS DISTINCT FROM NEW."allocation_id"
    OR allocation_repair_row."after_snapshot"->>'billing_account_id'
      IS DISTINCT FROM NEW."billing_account_id"
    OR allocation_repair_row."after_snapshot"->>'source'
      IS DISTINCT FROM 'NEGATIVE_BALANCE'
    OR allocation_repair_row."after_snapshot"->'balance_grant_id'
      IS DISTINCT FROM 'null'::JSONB
    OR current_allocation."id" IS NULL
    OR allocation_repair_row."after_snapshot"
      IS DISTINCT FROM current_allocation.database_snapshot
    OR (
      allocation_repair_row."before_snapshot"
        - 'source' - 'balance_grant_id' - 'recognized_revenue_usd'
        - 'bonus_consumed_usd' - 'discount_rate' - 'settled_usd'
        - 'settled_at' - 'ledger_sequence'
    ) IS DISTINCT FROM (
      allocation_repair_row."after_snapshot"
        - 'source' - 'balance_grant_id' - 'recognized_revenue_usd'
        - 'bonus_consumed_usd' - 'discount_rate' - 'settled_usd'
        - 'settled_at' - 'ledger_sequence'
    )
    OR (allocation_repair_row."before_snapshot"->>'amount_usd')::NUMERIC
      IS DISTINCT FROM grant_row."paid_amount_usd"
    OR (allocation_repair_row."before_snapshot"->>'recognized_revenue_usd')::NUMERIC
      IS DISTINCT FROM grant_row."paid_amount_usd"
    OR (allocation_repair_row."before_snapshot"->>'bonus_consumed_usd')::NUMERIC <> 0
    OR (allocation_repair_row."before_snapshot"->>'discount_rate')::NUMERIC <> 1
    OR (allocation_repair_row."before_snapshot"->>'settled_usd')::NUMERIC <> 0
    OR allocation_repair_row."before_snapshot"->'settled_at'
      IS DISTINCT FROM 'null'::JSONB
    OR (allocation_repair_row."after_snapshot"->>'amount_usd')::NUMERIC <= 0
    OR (allocation_repair_row."after_snapshot"->>'discount_rate')::NUMERIC <> 0
    OR (allocation_repair_row."after_snapshot"->>'settled_usd')::NUMERIC < 0
    OR (allocation_repair_row."after_snapshot"->>'settled_usd')::NUMERIC
      > (allocation_repair_row."after_snapshot"->>'amount_usd')::NUMERIC
    OR (allocation_repair_row."after_snapshot"->>'recognized_revenue_usd')::NUMERIC < 0
    OR (allocation_repair_row."after_snapshot"->>'bonus_consumed_usd')::NUMERIC < 0
    OR (allocation_repair_row."after_snapshot"->>'recognized_revenue_usd')::NUMERIC
      + (allocation_repair_row."after_snapshot"->>'bonus_consumed_usd')::NUMERIC
        IS DISTINCT FROM
          (allocation_repair_row."after_snapshot"->>'settled_usd')::NUMERIC
    OR (
      (allocation_repair_row."after_snapshot"->>'settled_usd')::NUMERIC
        = (allocation_repair_row."after_snapshot"->>'amount_usd')::NUMERIC
    ) IS DISTINCT FROM (
      allocation_repair_row."after_snapshot"->'settled_at' <> 'null'::JSONB
    )
    OR transaction_row."id" IS NULL
    OR transaction_row."billing_account_id" IS DISTINCT FROM NEW."billing_account_id"
    OR transaction_row."type"::TEXT IS DISTINCT FROM 'CONSUME'
    OR transaction_row."amount_usd" >= 0
    OR transaction_row."balance_after_usd" >= 0
    OR transaction_row."user_id"
      IS DISTINCT FROM allocation_repair_row."before_snapshot"->>'user_id'
    OR transaction_row."tenant_id"
      IS DISTINCT FROM allocation_repair_row."before_snapshot"->>'tenant_id'
    OR transaction_row."product_id"
      IS DISTINCT FROM allocation_repair_row."before_snapshot"->>'product_id'
    OR transaction_row."token_usage_id"
      IS DISTINCT FROM allocation_repair_row."before_snapshot"->>'token_usage_id'
    OR grant_row."user_id" IS DISTINCT FROM transaction_row."user_id"
    OR grant_row."tenant_id" IS DISTINCT FROM transaction_row."tenant_id"
    OR grant_row."product_id" IS DISTINCT FROM transaction_row."product_id"
    OR transaction_row."created_at" > grant_row."valid_from"
    OR grant_row."valid_from" > grant_row."created_at"
    OR grant_row."created_at"
      > (allocation_repair_row."before_snapshot"->>'created_at')::TIMESTAMP
    OR (allocation_repair_row."before_snapshot"->>'amount_usd')::NUMERIC
      IS DISTINCT FROM -transaction_row."amount_usd" - LEAST(
        -transaction_row."amount_usd",
        GREATEST(transaction_row."balance_after_usd" - transaction_row."amount_usd", 0)
      )
    OR transaction_grant_amount IS DISTINCT FROM LEAST(
      -transaction_row."amount_usd",
      GREATEST(transaction_row."balance_after_usd" - transaction_row."amount_usd", 0)
    )
    OR transaction_debt_count <> 1
    OR transaction_allocation_count < 1
    OR EXISTS (
      SELECT 1
      FROM "balance_consumption_allocations" allocation
      WHERE allocation."billing_account_id" = NEW."billing_account_id"
        AND allocation."balance_transaction_id" = transaction_row."id"
        AND allocation."source" NOT IN ('BALANCE_GRANT', 'NEGATIVE_BALANCE')
    )
    OR external_reference_count <> 0
  THEN
    RAISE EXCEPTION
      'migration opening retirement audit is not authorized run=% account=% grant=% allocation=%',
      NEW."run_id", NEW."billing_account_id", NEW."grant_id", NEW."allocation_id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "balance_ledger_grant_retirement_repairs_insert_guard"
BEFORE INSERT ON "balance_ledger_grant_retirement_repairs"
FOR EACH ROW
EXECUTE FUNCTION "validate_balance_ledger_grant_retirement_insert"();

CREATE OR REPLACE FUNCTION "reject_balance_ledger_grant_retirement_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'balance grant retirement audit rows are append-only: %', OLD."id"
    USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER "balance_ledger_grant_retirement_repairs_append_only"
BEFORE UPDATE OR DELETE ON "balance_ledger_grant_retirement_repairs"
FOR EACH ROW
EXECUTE FUNCTION "reject_balance_ledger_grant_retirement_mutation"();

-- This helper is used only by the terminal promotion assertion. It binds the
-- complete application beforeSnapshot, the immutable database-native deleted
-- row, the exact allocation OLD/NEW audit, and the approved terminal mutation.
CREATE OR REPLACE FUNCTION "balance_migration_opening_retirement_proof_is_valid"(
  target_retirement_id TEXT,
  target_account_id TEXT,
  target_run_id TEXT,
  target_repair_account_id TEXT,
  plan_before_grant JSONB,
  plan_mutation JSONB
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT COALESCE(EXISTS (
    SELECT 1
    FROM "balance_ledger_grant_retirement_repairs" retirement
    JOIN "balance_ledger_allocation_repairs" allocation_repair
      ON allocation_repair."run_id" = retirement."run_id"
      AND allocation_repair."repair_account_id" = retirement."repair_account_id"
      AND allocation_repair."billing_account_id" = retirement."billing_account_id"
      AND allocation_repair."allocation_id" = retirement."allocation_id"
    JOIN "balance_consumption_allocations" allocation
      ON allocation."id" = allocation_repair."allocation_id"
    WHERE retirement."id" = target_retirement_id
      AND retirement."run_id" = target_run_id
      AND retirement."repair_account_id" = target_repair_account_id
      AND retirement."billing_account_id" = target_account_id
      AND retirement."operation_key" = (
        'repair:migration-opening-retirement:' || target_run_id || ':' || retirement."grant_id"
      )
      AND plan_before_grant->>'id' = retirement."grant_id"
      AND plan_before_grant->>'source' = 'MIGRATION_OPENING'
      AND plan_mutation->>'grantId' = retirement."grant_id"
      AND plan_mutation->>'allocationId' = retirement."allocation_id"
      AND plan_mutation->'expectedGrant' IS NOT DISTINCT FROM plan_before_grant
      AND NOT EXISTS (
        SELECT 1 FROM "balance_grants" current_grant
        WHERE current_grant."id" = retirement."grant_id"
      )
      AND retirement."before_snapshot"->>'id' = retirement."grant_id"
      AND retirement."before_snapshot"->>'billing_account_id' = target_account_id
      AND retirement."before_snapshot"->>'user_id'
        IS NOT DISTINCT FROM plan_before_grant->>'userId'
      AND retirement."before_snapshot"->>'tenant_id'
        IS NOT DISTINCT FROM plan_before_grant->>'tenantId'
      AND retirement."before_snapshot"->>'product_id'
        IS NOT DISTINCT FROM plan_before_grant->>'productId'
      AND retirement."before_snapshot"->>'order_id'
        IS NOT DISTINCT FROM plan_before_grant->>'orderId'
      AND retirement."before_snapshot"->>'source'
        IS NOT DISTINCT FROM plan_before_grant->>'source'
      AND (retirement."before_snapshot"->>'paid_amount_usd')::NUMERIC
        IS NOT DISTINCT FROM (plan_before_grant->>'paidAmountUsd')::NUMERIC
      AND (retirement."before_snapshot"->>'bonus_amount_usd')::NUMERIC
        IS NOT DISTINCT FROM (plan_before_grant->>'bonusAmountUsd')::NUMERIC
      AND (retirement."before_snapshot"->>'granted_amount_usd')::NUMERIC
        IS NOT DISTINCT FROM (plan_before_grant->>'grantedAmountUsd')::NUMERIC
      AND (retirement."before_snapshot"->>'remaining_amount_usd')::NUMERIC
        IS NOT DISTINCT FROM (plan_before_grant->>'remainingAmountUsd')::NUMERIC
      AND (retirement."before_snapshot"->>'remaining_paid_amount_usd')::NUMERIC
        IS NOT DISTINCT FROM (plan_before_grant->>'remainingPaidAmountUsd')::NUMERIC
      AND (retirement."before_snapshot"->>'remaining_bonus_amount_usd')::NUMERIC
        IS NOT DISTINCT FROM (plan_before_grant->>'remainingBonusAmountUsd')::NUMERIC
      AND (retirement."before_snapshot"->>'discount_rate')::NUMERIC
        IS NOT DISTINCT FROM (plan_before_grant->>'discountRate')::NUMERIC
      AND (retirement."before_snapshot"->>'valid_from')::TIMESTAMP
        IS NOT DISTINCT FROM (
          (plan_before_grant->>'validFrom')::TIMESTAMPTZ AT TIME ZONE 'UTC'
        )
      AND (retirement."before_snapshot"->>'expires_at')::TIMESTAMP
        IS NOT DISTINCT FROM (
          (plan_before_grant->>'expiresAt')::TIMESTAMPTZ AT TIME ZONE 'UTC'
        )
      AND (retirement."before_snapshot"->>'is_expired')::BOOLEAN
        IS NOT DISTINCT FROM (plan_before_grant->>'isExpired')::BOOLEAN
      AND (retirement."before_snapshot"->>'created_at')::TIMESTAMP
        IS NOT DISTINCT FROM (
          (plan_before_grant->>'createdAt')::TIMESTAMPTZ AT TIME ZONE 'UTC'
        )
      AND allocation_repair."before_snapshot"->>'id' = retirement."allocation_id"
      AND allocation_repair."before_snapshot"->>'billing_account_id' = target_account_id
      AND allocation_repair."before_snapshot"->>'source' = 'BALANCE_GRANT'
      AND allocation_repair."before_snapshot"->>'balance_grant_id' = retirement."grant_id"
      AND allocation_repair."after_snapshot" IS NOT DISTINCT FROM to_jsonb(allocation)
      AND allocation_repair."after_snapshot"->>'source' = 'NEGATIVE_BALANCE'
      AND allocation_repair."after_snapshot"->'balance_grant_id' = 'null'::JSONB
      AND plan_mutation->>'expectedUserId'
        IS NOT DISTINCT FROM allocation_repair."before_snapshot"->>'user_id'
      AND plan_mutation->>'expectedTenantId'
        IS NOT DISTINCT FROM allocation_repair."before_snapshot"->>'tenant_id'
      AND plan_mutation->>'expectedProductId'
        IS NOT DISTINCT FROM allocation_repair."before_snapshot"->>'product_id'
      AND plan_mutation->>'expectedBalanceTransactionId'
        IS NOT DISTINCT FROM allocation_repair."before_snapshot"->>'balance_transaction_id'
      AND plan_mutation->>'expectedTokenUsageId'
        IS NOT DISTINCT FROM allocation_repair."before_snapshot"->>'token_usage_id'
      AND plan_mutation->>'expectedBalanceGrantId' = retirement."grant_id"
      AND plan_mutation->>'expectedSource' = 'BALANCE_GRANT'
      AND (plan_mutation->>'expectedAmountUsd')::NUMERIC
        IS NOT DISTINCT FROM
          (allocation_repair."before_snapshot"->>'amount_usd')::NUMERIC
      AND (plan_mutation->>'expectedRecognizedRevenueUsd')::NUMERIC
        IS NOT DISTINCT FROM
          (allocation_repair."before_snapshot"->>'recognized_revenue_usd')::NUMERIC
      AND (plan_mutation->>'expectedBonusConsumedUsd')::NUMERIC
        IS NOT DISTINCT FROM
          (allocation_repair."before_snapshot"->>'bonus_consumed_usd')::NUMERIC
      AND (plan_mutation->>'expectedDiscountRate')::NUMERIC
        IS NOT DISTINCT FROM
          (allocation_repair."before_snapshot"->>'discount_rate')::NUMERIC
      AND (plan_mutation->>'expectedSettledUsd')::NUMERIC
        IS NOT DISTINCT FROM
          (allocation_repair."before_snapshot"->>'settled_usd')::NUMERIC
      AND ((plan_mutation->>'expectedSettledAt')::TIMESTAMPTZ AT TIME ZONE 'UTC')
        IS NOT DISTINCT FROM
          (allocation_repair."before_snapshot"->>'settled_at')::TIMESTAMP
      AND (plan_mutation->>'expectedLedgerSequence')::BIGINT
        IS NOT DISTINCT FROM
          (allocation_repair."before_snapshot"->>'ledger_sequence')::BIGINT
      AND ((plan_mutation->>'expectedCreatedAt')::TIMESTAMPTZ AT TIME ZONE 'UTC')
        IS NOT DISTINCT FROM
          (allocation_repair."before_snapshot"->>'created_at')::TIMESTAMP
      AND plan_mutation->>'source' = 'NEGATIVE_BALANCE'
      AND plan_mutation->'balanceGrantId' = 'null'::JSONB
      AND (plan_mutation->>'amountUsd')::NUMERIC
        IS NOT DISTINCT FROM (allocation_repair."after_snapshot"->>'amount_usd')::NUMERIC
      AND (plan_mutation->>'recognizedRevenueUsd')::NUMERIC
        IS NOT DISTINCT FROM
          (allocation_repair."after_snapshot"->>'recognized_revenue_usd')::NUMERIC
      AND (plan_mutation->>'bonusConsumedUsd')::NUMERIC
        IS NOT DISTINCT FROM
          (allocation_repair."after_snapshot"->>'bonus_consumed_usd')::NUMERIC
      AND (plan_mutation->>'discountRate')::NUMERIC
        IS NOT DISTINCT FROM
          (allocation_repair."after_snapshot"->>'discount_rate')::NUMERIC
      AND (plan_mutation->>'settledUsd')::NUMERIC
        IS NOT DISTINCT FROM (allocation_repair."after_snapshot"->>'settled_usd')::NUMERIC
      AND ((plan_mutation->>'settledAt')::TIMESTAMPTZ AT TIME ZONE 'UTC')
        IS NOT DISTINCT FROM
          (allocation_repair."after_snapshot"->>'settled_at')::TIMESTAMP
      AND (plan_mutation->>'ledgerSequence')::BIGINT
        IS NOT DISTINCT FROM
          (allocation_repair."after_snapshot"->>'ledger_sequence')::BIGINT
  ), FALSE)
$$;

CREATE OR REPLACE FUNCTION "reject_balance_grant_delete"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  active_run_id TEXT;
  run_status TEXT;
  repair_row RECORD;
  account_status TEXT;
  retirement_row RECORD;
  allocation_repair_row RECORD;
  current_allocation JSONB;
  matching_allocation_repair_count BIGINT;
  external_reference_count BIGINT;
BEGIN
  active_run_id := current_setting('billing.balance_ledger_repair_run_id', TRUE);
  SELECT "status" INTO run_status
  FROM "balance_ledger_repair_runs"
  WHERE "id" = active_run_id;
  SELECT * INTO repair_row
  FROM "balance_ledger_repair_accounts"
  WHERE "run_id" = active_run_id
    AND "billing_account_id" = OLD."billing_account_id";
  SELECT "balance_grant_ledger_status" INTO account_status
  FROM "billing_accounts"
  WHERE "id" = OLD."billing_account_id";
  SELECT * INTO retirement_row
  FROM "balance_ledger_grant_retirement_repairs"
  WHERE "run_id" = active_run_id
    AND "repair_account_id" = repair_row."id"
    AND "billing_account_id" = OLD."billing_account_id"
    AND "grant_id" = OLD."id";
  SELECT allocation_repair.* INTO allocation_repair_row
  FROM "balance_ledger_allocation_repairs" allocation_repair
  WHERE allocation_repair."run_id" = active_run_id
    AND allocation_repair."repair_account_id" = repair_row."id"
    AND allocation_repair."billing_account_id" = OLD."billing_account_id"
    AND allocation_repair."allocation_id" = retirement_row."allocation_id";
  SELECT to_jsonb(allocation) INTO current_allocation
  FROM "balance_consumption_allocations" allocation
  WHERE allocation."id" = retirement_row."allocation_id";
  SELECT COUNT(*) INTO matching_allocation_repair_count
  FROM "balance_ledger_allocation_repairs" allocation_repair
  WHERE allocation_repair."run_id" = active_run_id
    AND allocation_repair."repair_account_id" = repair_row."id"
    AND allocation_repair."billing_account_id" = OLD."billing_account_id"
    AND allocation_repair."before_snapshot"->>'balance_grant_id' = OLD."id";
  SELECT
    (SELECT COUNT(*) FROM "balance_consumption_allocations"
      WHERE "balance_grant_id" = OLD."id")
    + (SELECT COUNT(*) FROM "enterprise_credit_settlements"
      WHERE "balance_grant_id" = OLD."id")
    + (SELECT COUNT(*) FROM "balance_grant_expiries"
      WHERE "balance_grant_id" = OLD."id")
    + (SELECT COUNT(*) FROM "balance_grant_refunds"
      WHERE "balance_grant_id" = OLD."id")
    + (SELECT COUNT(*) FROM "balance_grant_refund_allocations"
      WHERE "balance_grant_id" = OLD."id")
    + (SELECT COUNT(*) FROM "balance_ledger_account_transfer_grants"
      WHERE "grant_id" = OLD."id")
    + (SELECT COUNT(*) FROM "balance_ledger_grant_creation_repairs"
      WHERE "balance_grant_id" = OLD."id")
    + (SELECT COUNT(*) FROM "balance_ledger_grant_component_repairs"
      WHERE "grant_id" = OLD."id")
  INTO external_reference_count;

  IF active_run_id IS NOT NULL
    AND run_status = 'RUNNING'
    AND repair_row."id" IS NOT NULL
    AND repair_row."status" = 'RUNNING'
    AND account_status = 'LEGACY_DIRTY'
    AND OLD."source" = 'MIGRATION_OPENING'
    AND retirement_row."id" IS NOT NULL
    AND retirement_row."operation_key" = (
      'repair:migration-opening-retirement:' || active_run_id || ':' || OLD."id"
    )
    AND retirement_row."before_snapshot" IS NOT DISTINCT FROM to_jsonb(OLD)
    AND allocation_repair_row."id" IS NOT NULL
    AND matching_allocation_repair_count = 1
    AND allocation_repair_row."before_snapshot"->>'balance_grant_id' = OLD."id"
    AND allocation_repair_row."before_snapshot"->>'source' = 'BALANCE_GRANT'
    AND allocation_repair_row."after_snapshot" IS NOT DISTINCT FROM current_allocation
    AND allocation_repair_row."after_snapshot"->>'source' = 'NEGATIVE_BALANCE'
    AND allocation_repair_row."after_snapshot"->'balance_grant_id' = 'null'::JSONB
    AND external_reference_count = 0
  THEN
    RETURN OLD;
  END IF;
  RAISE EXCEPTION 'balance grants cannot be deleted: %', OLD."id"
    USING ERRCODE = '23514';
END
$$;

DROP TRIGGER IF EXISTS "balance_grants_delete_guard"
  ON "balance_grants";
CREATE TRIGGER "balance_grants_delete_guard"
BEFORE DELETE ON "balance_grants"
FOR EACH ROW
EXECUTE FUNCTION "reject_balance_grant_delete"();

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
  unsafe_invoice_item_count BIGINT;
  fact_count BIGINT;
  expected_debt_source TEXT;
  expected_settlement_mode TEXT;
  through_count BIGINT;
  invalid_grant_mutation_count BIGINT;
  grant_retirement_count BIGINT;
  invalid_grant_retirement_count BIGINT;
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
      AND (
        (
          grant_row."created_at" = funding."created_at"
          AND grant_row."valid_from" >= grant_row."created_at"
          AND (
            grant_row."valid_from" <= grant_row."created_at"
            OR "balance_legacy_grant_valid_from_is_repair_proven"(
              funding."id",
              grant_row."valid_from"
            )
          )
        )
        OR "balance_legacy_order_recharge_timing_is_proven"(
          target_account_id,
          funding."id",
          grant_row."id"
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
      AND (
        (
          grant_row."created_at" = paid_tx."created_at"
          AND grant_row."valid_from" >= grant_row."created_at"
          AND (
            grant_row."valid_from" <= grant_row."created_at"
            OR "balance_legacy_grant_valid_from_is_repair_proven"(
              paid_tx."id",
              grant_row."valid_from"
            )
          )
        )
        OR "balance_legacy_order_recharge_timing_is_proven"(
          target_account_id,
          paid_tx."id",
          grant_row."id"
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
      AND (
        (
          grant_row."created_at" = funding."created_at"
          AND grant_row."valid_from" >= grant_row."created_at"
          AND (
            grant_row."valid_from" <= grant_row."created_at"
            OR "balance_legacy_grant_valid_from_is_repair_proven"(
              funding."id",
              grant_row."valid_from"
            )
          )
        )
        OR "balance_legacy_voucher_funding_is_proven"(
          target_account_id,
          funding."id",
          grant_row."id"
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
  ) + (
    SELECT COUNT(*)
    FROM "enterprise_credit_settlements" foreign_settlement
    JOIN "balance_consumption_allocations" target_allocation
      ON target_allocation."id" = foreign_settlement."allocation_id"
    WHERE target_allocation."billing_account_id" = target_account_id
      AND foreign_settlement."billing_account_id" IS DISTINCT FROM target_account_id
  ) + (
    SELECT COUNT(*)
    FROM "enterprise_credit_settlements" foreign_settlement
    JOIN "balance_transactions" target_repayment
      ON target_repayment."id" = foreign_settlement."repayment_transaction_id"
    WHERE target_repayment."billing_account_id" = target_account_id
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
      OR (
        s."occurred_at" <> bt."created_at"
        AND NOT "balance_legacy_enterprise_settlement_timing_is_proven"(s."id")
      )
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
          WHERE s."billing_account_id" = target_account_id
            AND COALESCE(
              s."balance_grant_id",
              "balance_legacy_settlement_effective_grant_id"(s."id")
            ) = bg."id"), 0)
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
          WHERE s."billing_account_id" = target_account_id
            AND COALESCE(
              s."balance_grant_id",
              "balance_legacy_settlement_effective_grant_id"(s."id")
            ) = bg."id"), 0)
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
    grant_retirement_count := 0;
    invalid_grant_retirement_count := 0;
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
    ), retirement_mutations AS (
      SELECT value AS mutation, value->>'grantId' AS grant_id
      FROM jsonb_array_elements(COALESCE(
        repair_row."after_snapshot"->'migrationOpeningDebtMutations',
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
        WHERE current."id" IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM "balance_ledger_grant_retirement_repairs" retirement
            JOIN retirement_mutations retirement_mutation
              ON retirement_mutation.grant_id = retirement."grant_id"
            WHERE retirement."run_id" = target_run_id
              AND retirement."repair_account_id" = repair_row."id"
              AND retirement."billing_account_id" = target_account_id
              AND retirement."grant_id" = before.grant_id
              AND "balance_migration_opening_retirement_proof_is_valid"(
                retirement."id",
                target_account_id,
                target_run_id,
                repair_row."id",
                before.snapshot,
                retirement_mutation.mutation
              )
          ))
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

    WITH before_grants AS (
      SELECT value AS snapshot, value->>'id' AS grant_id
      FROM jsonb_array_elements(COALESCE(
        repair_row."before_snapshot"->'grants',
        '[]'::JSONB
      ))
    ), retirement_mutations AS (
      SELECT value AS mutation, value->>'grantId' AS grant_id,
        value->>'allocationId' AS allocation_id
      FROM jsonb_array_elements(COALESCE(
        repair_row."after_snapshot"->'migrationOpeningDebtMutations',
        '[]'::JSONB
      ))
    ), retirement_proofs AS (
      SELECT retirement.*, before.snapshot AS plan_before_grant,
        retirement_mutation.mutation AS plan_mutation
      FROM "balance_ledger_grant_retirement_repairs" retirement
      LEFT JOIN before_grants before
        ON before.grant_id = retirement."grant_id"
      LEFT JOIN retirement_mutations retirement_mutation
        ON retirement_mutation.grant_id = retirement."grant_id"
        AND retirement_mutation.allocation_id = retirement."allocation_id"
      WHERE retirement."run_id" = target_run_id
        AND retirement."billing_account_id" = target_account_id
    )
    SELECT
      (SELECT COUNT(*) FROM retirement_proofs),
      (SELECT COUNT(*)
        FROM retirement_proofs proof
        WHERE proof.plan_before_grant IS NULL
          OR proof.plan_mutation IS NULL
          OR NOT "balance_migration_opening_retirement_proof_is_valid"(
            proof."id",
            target_account_id,
            target_run_id,
            repair_row."id",
            proof.plan_before_grant,
            proof.plan_mutation
          ))
      + (SELECT COUNT(*) FROM (
          SELECT grant_id
          FROM retirement_mutations
          GROUP BY grant_id
          HAVING grant_id IS NULL OR COUNT(*) <> 1
        ) duplicate_retirement_grant)
      + (SELECT COUNT(*) FROM (
          SELECT allocation_id
          FROM retirement_mutations
          GROUP BY allocation_id
          HAVING allocation_id IS NULL OR COUNT(*) <> 1
        ) duplicate_retirement_allocation)
      + (SELECT COUNT(*)
        FROM retirement_mutations mutation
        LEFT JOIN "balance_ledger_grant_retirement_repairs" retirement
          ON retirement."run_id" = target_run_id
          AND retirement."repair_account_id" = repair_row."id"
          AND retirement."billing_account_id" = target_account_id
          AND retirement."grant_id" = mutation.grant_id
          AND retirement."allocation_id" = mutation.allocation_id
        WHERE retirement."id" IS NULL)
    INTO grant_retirement_count, invalid_grant_retirement_count;
  END IF;

  SELECT COUNT(*) INTO expiry_count
  FROM "balance_grant_expiries" WHERE "billing_account_id" = target_account_id;
  SELECT COUNT(*) INTO refund_count
  FROM "balance_grant_refunds" WHERE "billing_account_id" = target_account_id;
  -- Count each invoice item once even if corrupt legacy data has more than one
  -- grant linked to the same order. FAILED applications without any issued-
  -- document identity or historical issuance/void/red-offset event are inert
  -- failed attempts; every other linked invoice remains a hard blocker.
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE
      application."status"::TEXT IS DISTINCT FROM 'FAILED'
      OR application."invoice_number" IS NOT NULL
      OR application."issue_date" IS NOT NULL
      OR application."due_date" IS NOT NULL
      OR application."issued_at" IS NOT NULL
      OR application."pdf_url" IS NOT NULL
      OR application."ofd_url" IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM "invoice_event_log" invoice_event
        WHERE invoice_event."application_id" = application."id"
          AND invoice_event."to_status"::TEXT IN (
            'ISSUED',
            'VOIDED',
            'RED_OFFSET'
          )
      )
    )
  INTO invoice_item_count, unsafe_invoice_item_count
  FROM "invoice_application_items" item
  JOIN "invoice_applications" application
    ON application."id" = item."application_id"
  WHERE item."order_id" IN (
    SELECT bg."order_id"
    FROM "balance_grants" bg
    WHERE bg."billing_account_id" = target_account_id
      AND bg."order_id" IS NOT NULL
    UNION
    SELECT transaction_row."order_id"
    FROM "balance_transactions" transaction_row
    WHERE transaction_row."billing_account_id" = target_account_id
      AND transaction_row."order_id" IS NOT NULL
  );

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
    OR invalid_grant_retirement_count <> 0
    OR expiry_count <> 0
    OR refund_count <> 0
    OR unsafe_invoice_item_count <> 0
  THEN
    RAISE EXCEPTION
      'balance ledger canonical promotion invalid account=% wallet=% tx=%/% grant=% debt=% invalid(tx/funding/grant/allocation/consume/settlement/conservation/txAudit/allocationAudit/grantMutation/grantRetirement)=%/%/%/%/%/%/%/%/%/%/% facts(expiry/refund/invoice/unsafeInvoice)=%/%/%/%',
      target_account_id, wallet_balance, transaction_total, transaction_count,
      active_grant_amount, open_debt_amount,
      invalid_transaction_count, invalid_funding_count, invalid_grant_count, invalid_allocation_count,
      invalid_consume_count, invalid_settlement_count,
      invalid_grant_conservation_count, invalid_transaction_repair_count,
      invalid_allocation_repair_count,
      invalid_grant_mutation_count, invalid_grant_retirement_count,
      expiry_count, refund_count,
      invoice_item_count, unsafe_invoice_item_count
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
      OR jsonb_array_length(COALESCE(
        repair_row."after_snapshot"->'migrationOpeningDebtMutations',
        '[]'::JSONB
      )) IS DISTINCT FROM grant_retirement_count
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
      OR EXISTS (
        SELECT mutation->>'allocationId'
        FROM jsonb_array_elements(COALESCE(
          repair_row."after_snapshot"->'allocationMutations',
          '[]'::JSONB
        )) mutation
        GROUP BY mutation->>'allocationId'
        HAVING mutation->>'allocationId' IS NULL OR COUNT(*) <> 1
      )
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(
          repair_row."after_snapshot"->'allocationMutations',
          '[]'::JSONB
        )) mutation
        LEFT JOIN "balance_ledger_allocation_repairs" allocation_repair
          ON allocation_repair."run_id" = target_run_id
          AND allocation_repair."billing_account_id" = target_account_id
          AND allocation_repair."allocation_id" = mutation->>'allocationId'
        WHERE allocation_repair."id" IS NULL
          OR (mutation->>'expectedSettledUsd')::NUMERIC
            IS DISTINCT FROM
              (allocation_repair."before_snapshot"->>'settled_usd')::NUMERIC
          OR (mutation->>'expectedRecognizedRevenueUsd')::NUMERIC
            IS DISTINCT FROM
              (allocation_repair."before_snapshot"->>'recognized_revenue_usd')::NUMERIC
          OR (mutation->>'expectedBonusConsumedUsd')::NUMERIC
            IS DISTINCT FROM
              (allocation_repair."before_snapshot"->>'bonus_consumed_usd')::NUMERIC
          OR ((mutation->>'expectedSettledAt')::TIMESTAMPTZ AT TIME ZONE 'UTC')
            IS DISTINCT FROM
              (allocation_repair."before_snapshot"->>'settled_at')::TIMESTAMP
          OR (mutation->>'settledUsd')::NUMERIC
            IS DISTINCT FROM
              (allocation_repair."after_snapshot"->>'settled_usd')::NUMERIC
          OR (mutation->>'recognizedRevenueUsd')::NUMERIC
            IS DISTINCT FROM
              (allocation_repair."after_snapshot"->>'recognized_revenue_usd')::NUMERIC
          OR (mutation->>'bonusConsumedUsd')::NUMERIC
            IS DISTINCT FROM
              (allocation_repair."after_snapshot"->>'bonus_consumed_usd')::NUMERIC
          OR ((mutation->>'settledAt')::TIMESTAMPTZ AT TIME ZONE 'UTC')
            IS DISTINCT FROM
              (allocation_repair."after_snapshot"->>'settled_at')::TIMESTAMP
          OR NOT (
            (mutation->>'expectedSettledUsd')::NUMERIC
              IS DISTINCT FROM (mutation->>'settledUsd')::NUMERIC
            OR (mutation->>'expectedRecognizedRevenueUsd')::NUMERIC
              IS DISTINCT FROM (mutation->>'recognizedRevenueUsd')::NUMERIC
            OR (mutation->>'expectedBonusConsumedUsd')::NUMERIC
              IS DISTINCT FROM (mutation->>'bonusConsumedUsd')::NUMERIC
            OR (mutation->>'expectedSettledAt')::TIMESTAMPTZ
              IS DISTINCT FROM (mutation->>'settledAt')::TIMESTAMPTZ
          )
          OR (
            account_row."type" = 'enterprise'
            AND (
              (mutation->>'expectedSettledUsd')::NUMERIC
                IS DISTINCT FROM (mutation->>'settledUsd')::NUMERIC
              OR (
                (mutation->>'expectedSettledAt')::TIMESTAMPTZ
                  AT TIME ZONE 'UTC'
              ) IS DISTINCT FROM (
                (mutation->>'settledAt')::TIMESTAMPTZ
                  AT TIME ZONE 'UTC'
              )
              OR NOT (
                (mutation->>'expectedRecognizedRevenueUsd')::NUMERIC
                  IS DISTINCT FROM (mutation->>'recognizedRevenueUsd')::NUMERIC
                OR (mutation->>'expectedBonusConsumedUsd')::NUMERIC
                  IS DISTINCT FROM (mutation->>'bonusConsumedUsd')::NUMERIC
              )
              OR (mutation->>'recognizedRevenueUsd')::NUMERIC
                + (mutation->>'bonusConsumedUsd')::NUMERIC
                  IS DISTINCT FROM (mutation->>'settledUsd')::NUMERIC
            )
          )
      )
      OR EXISTS (
        -- Enterprise legacy settlement repair is component-only authority.
        -- Independently of the plan JSON, its row audit may change only the
        -- paid/bonus components and an optional legacy sequence.
        SELECT 1
        FROM "balance_ledger_allocation_repairs" allocation_repair
        WHERE account_row."type" = 'enterprise'
          AND allocation_repair."run_id" = target_run_id
          AND allocation_repair."billing_account_id" = target_account_id
          AND (
            allocation_repair."before_snapshot"
              - 'ledger_sequence'
              - 'recognized_revenue_usd'
              - 'bonus_consumed_usd'
          ) IS DISTINCT FROM (
            allocation_repair."after_snapshot"
              - 'ledger_sequence'
              - 'recognized_revenue_usd'
              - 'bonus_consumed_usd'
          )
      )
      OR EXISTS (
        -- Any repair audit that changed only allocation settlement/components
        -- (plus an optional sequence) must be represented by the terminal plan
        -- evidence above. Canonical grant/source rewrites are intentionally
        -- outside this component-only reverse check.
        SELECT 1
        FROM "balance_ledger_allocation_repairs" allocation_repair
        WHERE allocation_repair."run_id" = target_run_id
          AND allocation_repair."billing_account_id" = target_account_id
          AND allocation_repair."before_snapshot"->>'source'
            IS NOT DISTINCT FROM allocation_repair."after_snapshot"->>'source'
          AND allocation_repair."before_snapshot"->>'balance_grant_id'
            IS NOT DISTINCT FROM allocation_repair."after_snapshot"->>'balance_grant_id'
          AND (allocation_repair."before_snapshot"->>'amount_usd')::NUMERIC
            IS NOT DISTINCT FROM
              (allocation_repair."after_snapshot"->>'amount_usd')::NUMERIC
          AND (allocation_repair."before_snapshot"->>'discount_rate')::NUMERIC
            IS NOT DISTINCT FROM
              (allocation_repair."after_snapshot"->>'discount_rate')::NUMERIC
          AND (
            (allocation_repair."before_snapshot"->>'settled_usd')::NUMERIC
              IS DISTINCT FROM
                (allocation_repair."after_snapshot"->>'settled_usd')::NUMERIC
            OR (allocation_repair."before_snapshot"->>'recognized_revenue_usd')::NUMERIC
              IS DISTINCT FROM
                (allocation_repair."after_snapshot"->>'recognized_revenue_usd')::NUMERIC
            OR (allocation_repair."before_snapshot"->>'bonus_consumed_usd')::NUMERIC
              IS DISTINCT FROM
                (allocation_repair."after_snapshot"->>'bonus_consumed_usd')::NUMERIC
            OR (allocation_repair."before_snapshot"->>'settled_at')::TIMESTAMP
              IS DISTINCT FROM
                (allocation_repair."after_snapshot"->>'settled_at')::TIMESTAMP
          )
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(
              repair_row."after_snapshot"->'allocationMutations',
              '[]'::JSONB
            )) mutation
            WHERE mutation->>'allocationId' = allocation_repair."allocation_id"
          )
      )
      OR (repair_row."after_snapshot"->>'invoiceItemCount')::BIGINT
        IS DISTINCT FROM invoice_item_count
      OR (repair_row."after_snapshot"->>'unsafeInvoiceItemCount')::BIGINT
        IS DISTINCT FROM unsafe_invoice_item_count
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

-- A retirement audit may not commit as a standalone delete authorization.
-- The same transaction must finish the account repair and pass the complete
-- canonical promotion assertion; otherwise the allocation rewrite, audit and
-- grant deletion are rolled back together.
CREATE OR REPLACE FUNCTION "validate_balance_ledger_grant_retirement_terminal"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  run_status TEXT;
  repair_row RECORD;
  account_status TEXT;
BEGIN
  SELECT "status" INTO run_status
  FROM "balance_ledger_repair_runs"
  WHERE "id" = NEW."run_id";
  SELECT * INTO repair_row
  FROM "balance_ledger_repair_accounts"
  WHERE "id" = NEW."repair_account_id";
  SELECT "balance_grant_ledger_status" INTO account_status
  FROM "billing_accounts"
  WHERE "id" = NEW."billing_account_id";

  IF run_status IS DISTINCT FROM 'RUNNING'
    OR repair_row."id" IS NULL
    OR repair_row."run_id" IS DISTINCT FROM NEW."run_id"
    OR repair_row."billing_account_id" IS DISTINCT FROM NEW."billing_account_id"
    OR repair_row."status" IS DISTINCT FROM 'APPLIED'
    OR account_status IS DISTINCT FROM 'RECONCILED_V2'
  THEN
    RAISE EXCEPTION
      'migration opening retirement cannot commit before canonical promotion run=% account=% grant=%',
      NEW."run_id", NEW."billing_account_id", NEW."grant_id"
      USING ERRCODE = '23514';
  END IF;

  PERFORM "assert_balance_ledger_canonical_promotion"(
    NEW."billing_account_id",
    NEW."run_id",
    FALSE
  );
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "balance_ledger_grant_retirements_terminal_deferred"
AFTER INSERT ON "balance_ledger_grant_retirement_repairs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_balance_ledger_grant_retirement_terminal"();

COMMIT;
