BEGIN;

SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- Financial facts are stored in TIMESTAMP WITHOUT TIME ZONE columns and
-- Prisma reads those values as UTC.  Strip the session offset explicitly so a
-- non-UTC connection cannot move a new account's immutable ledger floor.
CREATE OR REPLACE FUNCTION "public"."authorize_balance_ledger_clean_promotion"()
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
    -- PostgreSQL and normalized independently of the connection TimeZone.
    IF NEW."balance_grant_ledger_status" = 'RECONCILED_V2' THEN
      NEW."balance_grant_ledger_reconciled_at" :=
        (clock_timestamp() AT TIME ZONE 'UTC')::TIMESTAMP(3);
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

DO $verify$
DECLARE
  function_definition TEXT;
  trigger_count INTEGER;
BEGIN
  SELECT pg_get_functiondef(to_regprocedure(
    'public.authorize_balance_ledger_clean_promotion()'
  ))
  INTO function_definition;

  SELECT COUNT(*)::INTEGER
  INTO trigger_count
  FROM pg_trigger
  WHERE tgrelid = 'public.billing_accounts'::regclass
    AND tgname = 'billing_accounts_clean_promotion_guard'
    AND tgfoid = to_regprocedure(
      'public.authorize_balance_ledger_clean_promotion()'
    );

  IF function_definition IS NULL
    OR POSITION('AT TIME ZONE ''UTC''' IN function_definition) = 0
    OR trigger_count <> 1
  THEN
    RAISE EXCEPTION
      'financial clock UTC contract verification failed function=% trigger_count=%',
      function_definition IS NOT NULL,
      trigger_count;
  END IF;
END
$verify$;

COMMIT;
