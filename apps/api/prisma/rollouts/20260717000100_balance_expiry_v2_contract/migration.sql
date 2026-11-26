-- CONTRACT RELEASE ONLY. This file is intentionally outside prisma/migrations.
--
-- This directory must not be present in the Release A migration artifact.
-- Install it only after all Billing traffic is on the V2 image, every old pod
-- and in-flight debit has drained, and the expiry safety-window queries in the
-- runbook are still zero. All contract functions, triggers and the durable
-- phase transition are one transaction: a failed gate leaves no partial
-- contract. A demonstrably empty database may self-prepare for greenfield
-- deployment; a non-empty upgrade must use the explicit audited prepare call.
BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $contract_gate$
DECLARE
  rollout_phase TEXT;
  rollout_database_name TEXT;
  rollout_database_identity UUID;
  rollout_system_identifier NUMERIC(20, 0);
  rollout_database_oid OID;
  current_system_identifier NUMERIC(20, 0);
  current_database_oid OID;
  safe_through TIMESTAMP(3);
  financial_row_count BIGINT;
  clean_account_count BIGINT;
  near_expiry_count BIGINT;
  legacy_expiry_count BIGINT;
  non_consume_count BIGINT;
  current_opening_grant_count BIGINT;
  opening_grant_count_at_expand BIGINT;
  strict_trigger_count BIGINT;
BEGIN
  SELECT
    "phase",
    "database_name",
    "database_identity",
    "database_system_identifier",
    "database_oid"
  INTO
    rollout_phase,
    rollout_database_name,
    rollout_database_identity,
    rollout_system_identifier,
    rollout_database_oid
  FROM "balance_ledger_rollout_control"
  WHERE "id" = 1
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'balance ledger rollout control is missing'
      USING ERRCODE = '23514';
  END IF;
  SELECT "system_identifier"::NUMERIC(20, 0)
    INTO current_system_identifier
  FROM pg_control_system();
  SELECT oid INTO current_database_oid
  FROM pg_database
  WHERE datname = current_database();
  IF rollout_database_name IS DISTINCT FROM current_database()
    OR rollout_system_identifier IS DISTINCT FROM current_system_identifier
    OR rollout_database_oid IS DISTINCT FROM current_database_oid
  THEN
    RAISE EXCEPTION
      'balance ledger contract database locator mismatch name=%/% locator=%/% current=%/%',
      rollout_database_name,
      current_database(),
      rollout_system_identifier,
      rollout_database_oid,
      current_system_identifier,
      current_database_oid
      USING ERRCODE = '23514';
  END IF;

  -- Close the gate/install TOCTOU for both greenfield and non-empty cutovers.
  -- Normal financial mutations hold RowExclusive table locks. Conflicting
  -- SHARE locks, acquired in the online writer order and held through the
  -- trigger install + phase CAS, force every pre-gate writer to finish before
  -- the recheck snapshot below is taken.
  LOCK TABLE
    "account_wallets",
    "balance_grants",
    "billing_accounts",
    "balance_transactions",
    "balance_consumption_allocations",
    "enterprise_credit_settlements",
    "balance_grant_expiries",
    "balance_grant_refunds",
    "balance_grant_refund_allocations"
    IN SHARE MODE;

  IF rollout_phase = 'EXPANDED' THEN
    -- Greenfield self-prepare is valid only while the database remains empty
    -- for this whole contract transaction. SHARE conflicts with every normal
    -- financial writer's RowExclusiveLock, closing the count/prepare TOCTOU.
    -- Non-empty upgrades never take this path: they arrive CUTOVER_READY after
    -- an explicit, audited prepare while writers are drained.
    SELECT
      (SELECT COUNT(*) FROM "billing_accounts")
      + (SELECT COUNT(*) FROM "account_wallets")
      + (SELECT COUNT(*) FROM "balance_transactions")
      + (SELECT COUNT(*) FROM "balance_grants")
      + (SELECT COUNT(*) FROM "balance_consumption_allocations")
      + (SELECT COUNT(*) FROM "enterprise_credit_settlements")
      INTO financial_row_count;
    IF financial_row_count <> 0 THEN
      RAISE EXCEPTION
        'non-empty database requires audited CUTOVER_READY preparation rows=%',
        financial_row_count
        USING ERRCODE = '23514';
    END IF;

    PERFORM "prepare_balance_ledger_v2_contract"(
      current_database(),
      rollout_database_identity,
      'migration-empty-database',
      '20260717000100_balance_expiry_v2_contract',
      repeat('0', 64),
      (clock_timestamp() + INTERVAL '20 minutes')::TIMESTAMP(3)
    );
  END IF;

  SELECT
    control."phase",
    control."expiry_safe_through",
    control."opening_grant_count_at_expand"
    INTO rollout_phase, safe_through, opening_grant_count_at_expand
  FROM "balance_ledger_rollout_control" control
  WHERE control."id" = 1
  FOR UPDATE;

  IF rollout_phase <> 'CUTOVER_READY'
    OR safe_through IS NULL
    OR safe_through <= clock_timestamp()::TIMESTAMP(3)
  THEN
    RAISE EXCEPTION
      'balance ledger contract requires unexpired CUTOVER_READY phase=% horizon=%',
      rollout_phase,
      COALESCE(safe_through::TEXT, 'NULL')
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
  SELECT COUNT(*) INTO legacy_expiry_count
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
  SELECT COUNT(*) INTO non_consume_count
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
      'account_wallets_clean_canonical_deferred',
      'balance_grants_clean_canonical_deferred',
      'balance_debt_allocations_clean_canonical_deferred',
      'balance_transactions_clean_canonical_deferred',
      'balance_canonical_revision_marker',
      'balance_consumption_allocations_identity_guard',
      'account_wallets_identity_guard',
      'billing_accounts_clean_type_guard',
      'balance_grant_refunds_canonical_deferred',
      'balance_grant_refund_allocations_canonical_deferred'
    );

  IF clean_account_count <> 0
    OR near_expiry_count <> 0
    OR legacy_expiry_count <> 0
    OR non_consume_count <> 0
    OR current_opening_grant_count
      IS DISTINCT FROM opening_grant_count_at_expand
    OR strict_trigger_count <> 0
  THEN
    RAISE EXCEPTION
      'contract recheck failed clean=% near_expiry=% legacy_expiry=% non_consume=% opening_grant=%/% strict_trigger=%',
      clean_account_count,
      near_expiry_count,
      legacy_expiry_count,
      non_consume_count,
      current_opening_grant_count,
      opening_grant_count_at_expand,
      strict_trigger_count
      USING ERRCODE = '23514';
  END IF;
END
$contract_gate$;

-- A financial transaction can touch wallet, grants, transactions and
-- allocations many times. Mark each account mutation with a transaction-local
-- revision so the deferred full-account proof runs once for the final revision
-- rather than once per affected row. If a caller forces constraints IMMEDIATE
-- and then writes again, the marker advances and the later deferred event must
-- validate the new revision, so deduplication cannot hide subsequent changes.
CREATE OR REPLACE FUNCTION "mark_balance_canonical_revision"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_account_id TEXT;
  revision_state JSONB;
  current_revision BIGINT;
BEGIN
  target_account_id := NEW."billing_account_id";
  IF target_account_id IS NULL THEN
    RETURN NEW;
  END IF;
  BEGIN
    revision_state := COALESCE(
      NULLIF(current_setting('billing.balance_canonical_revisions', TRUE), ''),
      '{}'
    )::JSONB;
    current_revision := COALESCE(
      (revision_state ->> target_account_id)::BIGINT,
      0
    ) + 1;
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      'clean account canonical revision state invalid account=%',
      target_account_id
      USING ERRCODE = '23514';
  END;
  PERFORM set_config(
    'billing.balance_canonical_revisions',
    jsonb_set(
      revision_state,
      ARRAY[target_account_id],
      to_jsonb(current_revision),
      TRUE
    )::TEXT,
    TRUE
  );
  RETURN NEW;
END
$$;

-- This rollout may be installed before or after the enterprise-absorb pair
-- migration.  Before that migration exists, install same-signature
-- fail-closed stubs so ordinary clean-account validation keeps working and no
-- cross-account history is authorized.  CREATE OR REPLACE in the pair
-- migration promotes the stubs to database-backed proof functions; when the
-- real functions already exist, this block deliberately leaves them intact.
DO $enterprise_absorb_stubs$
BEGIN
  IF to_regprocedure(
      'public.balance_enterprise_absorb_active_pair_is_valid(text)'
    ) IS NULL
  THEN
    EXECUTE $stub$
      CREATE FUNCTION "balance_enterprise_absorb_active_pair_is_valid"(TEXT)
      RETURNS BOOLEAN
      LANGUAGE sql
      STABLE
      AS 'SELECT FALSE'
    $stub$;
  END IF;
  IF to_regprocedure(
      'public.balance_allocation_has_enterprise_absorb_proof(text,text,text)'
    ) IS NULL
  THEN
    EXECUTE $stub$
      CREATE FUNCTION "balance_allocation_has_enterprise_absorb_proof"(
        TEXT, TEXT, TEXT
      )
      RETURNS BOOLEAN
      LANGUAGE sql
      STABLE
      AS 'SELECT FALSE'
    $stub$;
  END IF;
  IF to_regprocedure(
      'public.balance_enterprise_absorb_active_allocation_update_is_valid(jsonb,jsonb)'
    ) IS NULL
  THEN
    EXECUTE $stub$
      CREATE FUNCTION "balance_enterprise_absorb_active_allocation_update_is_valid"(
        JSONB, JSONB
      )
      RETURNS BOOLEAN
      LANGUAGE sql
      STABLE
      AS 'SELECT FALSE'
    $stub$;
  END IF;
  IF to_regprocedure(
      'public.balance_legacy_settlement_effective_grant_id(text)'
    ) IS NULL
  THEN
    EXECUTE $stub$
      CREATE FUNCTION "balance_legacy_settlement_effective_grant_id"(TEXT)
      RETURNS TEXT
      LANGUAGE sql
      STABLE
      AS 'SELECT NULL::TEXT'
    $stub$;
  END IF;
END
$enterprise_absorb_stubs$;

-- Release B can also be installed before the later Gateway terminal-proof
-- migration on an existing environment. Keep that ordering fail-closed: the
-- stub never authorizes a row-local bypass, so canonical validation continues
-- through the full-account aggregate until the Release-A migration replaces
-- it with the database-backed proof. On greenfield the real helper exists.
DO $gateway_terminal_proof_stub$
BEGIN
  IF to_regprocedure(
      'public.gateway_balance_canonical_mutation_is_current_settlement(text,text,jsonb,jsonb)'
    ) IS NULL
  THEN
    EXECUTE $stub$
      CREATE FUNCTION "gateway_balance_canonical_mutation_is_current_settlement"(
        TEXT, TEXT, JSONB, JSONB
      )
      RETURNS BOOLEAN
      LANGUAGE sql
      STABLE
      AS 'SELECT FALSE'
    $stub$;
  END IF;
END
$gateway_terminal_proof_stub$;

CREATE OR REPLACE FUNCTION "assert_clean_account_wallet_canonical_deferred"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_account_id TEXT;
  account_type TEXT;
  account_status TEXT;
  account_reconciled_at TIMESTAMP(3);
  wallet_balance NUMERIC;
  active_grant_amount NUMERIC;
  open_debt_amount NUMERIC;
  invalid_grant_count BIGINT;
  invalid_grant_conservation_count BIGINT;
  invalid_debt_count BIGINT;
  invalid_sequence_count BIGINT;
  unexpected_debt_count BIGINT;
  expected_debt_source TEXT;
  transaction_total NUMERIC;
  invalid_transaction_count BIGINT;
  invalid_allocation_count BIGINT;
  invalid_consume_count BIGINT;
  invalid_refund_transaction_count BIGINT;
  financial_now_text TEXT;
  parsed_financial_now TIMESTAMP(3);
  revision_state JSONB;
  validated_state JSONB;
  current_revision BIGINT;
  validated_revision BIGINT;
BEGIN
  IF gateway_balance_canonical_mutation_is_current_settlement(
    TG_TABLE_NAME::text COLLATE pg_catalog."default",
    TG_OP,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    to_jsonb(NEW)
  ) THEN
    RETURN NULL;
  END IF;

  target_account_id := NEW."billing_account_id";
  SELECT
    account."type",
    account."balance_grant_ledger_status",
    account."balance_grant_ledger_reconciled_at",
    wallet."balance_usd"
    INTO account_type, account_status, account_reconciled_at, wallet_balance
  FROM "billing_accounts" account
  JOIN "account_wallets" wallet
    ON wallet."billing_account_id" = account."id"
  WHERE account."id" = target_account_id;

  IF NOT FOUND OR account_status <> 'RECONCILED_V2' THEN
    RETURN NULL;
  END IF;

  -- A legacy personal->enterprise absorb pair is repaired atomically across
  -- two accounts.  During that one repair transaction, validate the exact
  -- database-backed pair proof instead of evaluating either side in
  -- isolation.  The helper returns FALSE for every non-pair writer, so the
  -- canonical validator below remains the default path.
  IF "balance_enterprise_absorb_active_pair_is_valid"(target_account_id) THEN
    RETURN NULL;
  END IF;

  BEGIN
    revision_state := COALESCE(
      NULLIF(current_setting('billing.balance_canonical_revisions', TRUE), ''),
      '{}'
    )::JSONB;
    validated_state := COALESCE(
      NULLIF(current_setting('billing.balance_canonical_validated', TRUE), ''),
      '{}'
    )::JSONB;
    current_revision := COALESCE(
      (revision_state ->> target_account_id)::BIGINT,
      0
    );
    validated_revision := COALESCE(
      (validated_state ->> target_account_id)::BIGINT,
      0
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      'clean account canonical validation state invalid account=%',
      target_account_id
      USING ERRCODE = '23514';
  END;
  IF current_revision <= 0 THEN
    RAISE EXCEPTION
      'clean account canonical mutation lacks revision marker account=%',
      target_account_id
      USING ERRCODE = '23514';
  END IF;
  IF validated_revision = current_revision THEN
    RETURN NULL;
  END IF;

  -- Use one immutable writer clock for every table participating in the
  -- canonical aggregate. No live wall clock is sampled by deferred triggers.
  financial_now_text := current_setting('billing.balance_financial_now', TRUE);
  IF financial_now_text IS NOT NULL AND btrim(financial_now_text) <> '' THEN
    BEGIN
      parsed_financial_now := financial_now_text::TIMESTAMP(3);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION
        'clean account mutation has invalid locked financial now: %',
        target_account_id
        USING ERRCODE = '23514';
    END;
  END IF;
  -- EMPTY_V2 wallet creation at zero is non-financial. Every non-zero INSERT
  -- or actual wallet balance change must come from a post-lock V2 writer.
  IF TG_TABLE_NAME = 'account_wallets' THEN
    IF (
      (TG_OP = 'INSERT' AND NEW."balance_usd" <> 0)
      OR (TG_OP = 'UPDATE' AND NEW."balance_usd" IS DISTINCT FROM OLD."balance_usd")
    )
      AND parsed_financial_now IS NULL
    THEN
      RAISE EXCEPTION
        'clean account wallet mutation lacks locked financial now: %',
        target_account_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT
    COALESCE(SUM(grant_row."remaining_amount_usd") FILTER (
      WHERE NOT grant_row."is_expired"
        AND grant_row."valid_from" <= COALESCE(
          parsed_financial_now,
          account_reconciled_at
        )
        AND (
          grant_row."expires_at" IS NULL
          OR grant_row."expires_at" > COALESCE(
            parsed_financial_now,
            account_reconciled_at
          )
        )
    ), 0),
    COUNT(*) FILTER (
      WHERE grant_row."remaining_amount_usd" < 0
        OR grant_row."remaining_paid_amount_usd" IS NULL
        OR grant_row."remaining_bonus_amount_usd" IS NULL
        OR grant_row."remaining_paid_amount_usd" < 0
        OR grant_row."remaining_bonus_amount_usd" < 0
        OR grant_row."remaining_paid_amount_usd"
          + grant_row."remaining_bonus_amount_usd"
          <> grant_row."remaining_amount_usd"
        OR grant_row."paid_amount_usd" < 0
        OR grant_row."bonus_amount_usd" < 0
        OR grant_row."granted_amount_usd" <= 0
        OR grant_row."paid_amount_usd" + grant_row."bonus_amount_usd"
          <> grant_row."granted_amount_usd"
        OR grant_row."discount_rate" IS DISTINCT FROM CASE
          WHEN grant_row."granted_amount_usd" > 0 THEN ROUND(
            grant_row."paid_amount_usd" / grant_row."granted_amount_usd",
            12
          )
          ELSE 0
        END
        OR grant_row."remaining_paid_amount_usd" > grant_row."paid_amount_usd"
        OR grant_row."remaining_bonus_amount_usd" > grant_row."bonus_amount_usd"
        OR (
          grant_row."valid_from" > grant_row."created_at"
          AND NOT EXISTS (
            SELECT 1
            FROM "balance_funding_candidates"(
              target_account_id,
              account_type
            ) proven_funding
            WHERE proven_funding.grant_id = grant_row."id"
          )
        )
        OR (
          grant_row."expires_at" IS NOT NULL
          AND grant_row."expires_at" <= grant_row."valid_from"
        )
        OR (
          grant_row."is_expired"
          AND (
            grant_row."remaining_amount_usd" <> 0
            OR grant_row."remaining_paid_amount_usd" <> 0
            OR grant_row."remaining_bonus_amount_usd" <> 0
          )
        )
    )
    INTO active_grant_amount, invalid_grant_count
  FROM "balance_grants" grant_row
  WHERE grant_row."billing_account_id" = target_account_id;

  -- Aggregate equality is insufficient: moving the same amount between two
  -- grants leaves the wallet unchanged while corrupting the recharge-detail
  -- rows. Prove each paid/bonus component independently from immutable facts.
  -- REFUND_NETTING settlements and refund allocations describe the same grant
  -- reduction, so only the latter participates in this equation.
  SELECT COUNT(*) INTO invalid_grant_conservation_count
  FROM "balance_grants" grant_row
  WHERE grant_row."billing_account_id" = target_account_id
    AND (
      grant_row."paid_amount_usd" IS DISTINCT FROM (
        grant_row."remaining_paid_amount_usd"
        + COALESCE((
          SELECT SUM(allocation."recognized_revenue_usd")
          FROM "balance_consumption_allocations" allocation
          WHERE allocation."balance_grant_id" = grant_row."id"
            AND (
              allocation."billing_account_id" = target_account_id
              OR "balance_allocation_has_enterprise_absorb_proof"(
                allocation."id",
                grant_row."id",
                allocation."billing_account_id"
              )
            )
            AND allocation."source" = 'BALANCE_GRANT'
        ), 0)
        + COALESCE((
          SELECT SUM(settlement."paid_usd")
          FROM "enterprise_credit_settlements" settlement
          WHERE COALESCE(
              settlement."balance_grant_id",
              "balance_legacy_settlement_effective_grant_id"(settlement."id")
            ) = grant_row."id"
            AND settlement."billing_account_id" = target_account_id
            AND settlement."trigger" <> 'REFUND_NETTING'
        ), 0)
        + COALESCE((
          SELECT SUM(refund_allocation."paid_reduction_usd")
          FROM "balance_grant_refund_allocations" refund_allocation
          JOIN "balance_grant_refunds" refund
            ON refund."id" = refund_allocation."refund_id"
          WHERE refund_allocation."balance_grant_id" = grant_row."id"
            AND refund."billing_account_id" = target_account_id
        ), 0)
        + COALESCE((
          SELECT expiry."nominal_paid_usd"
          FROM "balance_grant_expiries" expiry
          WHERE expiry."balance_grant_id" = grant_row."id"
            AND expiry."billing_account_id" = target_account_id
        ), 0)
      )
      OR grant_row."bonus_amount_usd" IS DISTINCT FROM (
        grant_row."remaining_bonus_amount_usd"
        + COALESCE((
          SELECT SUM(allocation."bonus_consumed_usd")
          FROM "balance_consumption_allocations" allocation
          WHERE allocation."balance_grant_id" = grant_row."id"
            AND (
              allocation."billing_account_id" = target_account_id
              OR "balance_allocation_has_enterprise_absorb_proof"(
                allocation."id",
                grant_row."id",
                allocation."billing_account_id"
              )
            )
            AND allocation."source" = 'BALANCE_GRANT'
        ), 0)
        + COALESCE((
          SELECT SUM(settlement."bonus_usd")
          FROM "enterprise_credit_settlements" settlement
          WHERE COALESCE(
              settlement."balance_grant_id",
              "balance_legacy_settlement_effective_grant_id"(settlement."id")
            ) = grant_row."id"
            AND settlement."billing_account_id" = target_account_id
            AND settlement."trigger" <> 'REFUND_NETTING'
        ), 0)
        + COALESCE((
          SELECT SUM(refund_allocation."bonus_reduction_usd")
          FROM "balance_grant_refund_allocations" refund_allocation
          JOIN "balance_grant_refunds" refund
            ON refund."id" = refund_allocation."refund_id"
          WHERE refund_allocation."balance_grant_id" = grant_row."id"
            AND refund."billing_account_id" = target_account_id
        ), 0)
        + COALESCE((
          SELECT expiry."nominal_bonus_usd"
          FROM "balance_grant_expiries" expiry
          WHERE expiry."balance_grant_id" = grant_row."id"
            AND expiry."billing_account_id" = target_account_id
        ), 0)
      )
    );

  expected_debt_source := CASE
    WHEN account_type = 'enterprise' THEN 'ENTERPRISE_CREDIT'
    ELSE 'NEGATIVE_BALANCE'
  END;

  SELECT
    COALESCE(SUM(allocation."amount_usd" - allocation."settled_usd") FILTER (
      WHERE allocation."source" = expected_debt_source
    ), 0),
    COUNT(*) FILTER (
      WHERE allocation."amount_usd" <= 0
        OR allocation."settled_usd" < 0
        OR allocation."settled_usd" > allocation."amount_usd"
        OR allocation."recognized_revenue_usd" < 0
        OR allocation."bonus_consumed_usd" < 0
        OR allocation."recognized_revenue_usd"
          + allocation."bonus_consumed_usd" <> allocation."settled_usd"
        OR allocation."balance_grant_id" IS NOT NULL
        OR allocation."discount_rate" <> 0
        OR (allocation."settled_usd" = allocation."amount_usd")
          IS DISTINCT FROM (allocation."settled_at" IS NOT NULL)
    ),
    COUNT(*) FILTER (
      WHERE allocation."ledger_sequence" IS NULL
        OR allocation."ledger_sequence" = 0
    ),
    COUNT(*) FILTER (
      WHERE allocation."source" <> expected_debt_source
    )
    INTO
      open_debt_amount,
      invalid_debt_count,
      invalid_sequence_count,
      unexpected_debt_count
  FROM "balance_consumption_allocations" allocation
  WHERE allocation."billing_account_id" = target_account_id
    AND allocation."source" IN ('NEGATIVE_BALANCE', 'ENTERPRISE_CREDIT');

  SELECT
    COALESCE(SUM(transaction_row."amount_usd"), 0),
    COUNT(*) FILTER (
      WHERE transaction_row."ledger_sequence" IS NULL
        OR transaction_row."ledger_sequence" = 0
        OR (transaction_row."type"::TEXT = 'CONSUME' AND transaction_row."amount_usd" >= 0)
        OR (transaction_row."type"::TEXT = 'RECHARGE' AND transaction_row."amount_usd" <= 0)
        OR (transaction_row."type"::TEXT = 'REFUND' AND transaction_row."amount_usd" >= 0)
        OR (transaction_row."type"::TEXT = 'ADJUST' AND transaction_row."amount_usd" = 0)
        OR transaction_row."type"::TEXT NOT IN ('CONSUME', 'RECHARGE', 'REFUND', 'ADJUST')
    )
    INTO transaction_total, invalid_transaction_count
  FROM "balance_transactions" transaction_row
  WHERE transaction_row."billing_account_id" = target_account_id;

  SELECT COUNT(*) FILTER (
    WHERE allocation."ledger_sequence" IS NULL
      OR allocation."ledger_sequence" = 0
      OR allocation."amount_usd" <= 0
      OR transaction_row."id" IS NULL
      OR transaction_row."billing_account_id" IS DISTINCT FROM target_account_id
      OR transaction_row."type"::TEXT NOT IN ('CONSUME', 'REFUND')
      OR allocation."user_id" IS DISTINCT FROM transaction_row."user_id"
      OR allocation."tenant_id" IS DISTINCT FROM transaction_row."tenant_id"
      OR allocation."product_id" IS DISTINCT FROM transaction_row."product_id"
      OR allocation."token_usage_id" IS DISTINCT FROM transaction_row."token_usage_id"
      OR (
        allocation."source" = 'BALANCE_GRANT'
        AND (
          transaction_row."type"::TEXT <> 'CONSUME'
          OR
          grant_row."id" IS NULL
          OR (
            grant_row."billing_account_id" IS DISTINCT FROM target_account_id
            AND NOT "balance_allocation_has_enterprise_absorb_proof"(
              allocation."id",
              grant_row."id",
              target_account_id
            )
          )
          OR allocation."recognized_revenue_usd" < 0
          OR allocation."bonus_consumed_usd" < 0
          OR allocation."recognized_revenue_usd" + allocation."bonus_consumed_usd"
            <> allocation."amount_usd"
          OR allocation."discount_rate" IS DISTINCT FROM CASE
            WHEN allocation."amount_usd" > 0 THEN ROUND(
              allocation."recognized_revenue_usd" / allocation."amount_usd",
              12
            )
            ELSE 0
          END
          OR allocation."settled_usd" <> 0
          OR allocation."settled_at" IS NOT NULL
        )
      )
      OR (
        allocation."source" = expected_debt_source
        AND (
          allocation."balance_grant_id" IS NOT NULL
          OR allocation."discount_rate" <> 0
          OR allocation."settled_usd" < 0
          OR allocation."settled_usd" > allocation."amount_usd"
          OR allocation."recognized_revenue_usd" < 0
          OR allocation."bonus_consumed_usd" < 0
          OR allocation."recognized_revenue_usd" + allocation."bonus_consumed_usd"
            <> allocation."settled_usd"
          OR (allocation."settled_usd" = allocation."amount_usd")
            IS DISTINCT FROM (allocation."settled_at" IS NOT NULL)
          OR (
            transaction_row."type"::TEXT = 'REFUND'
            AND NOT EXISTS (
              SELECT 1
              FROM "balance_grant_refunds" refund
              WHERE refund."debt_allocation_id" = allocation."id"
                AND refund."refund_transaction_id" = transaction_row."id"
                AND refund."billing_account_id" = target_account_id
                AND refund."operation_key" IS NOT DISTINCT FROM
                  transaction_row."operation_key"
                AND refund."requested_amount_usd" = -transaction_row."amount_usd"
                AND refund."debt_opened_usd" = allocation."amount_usd"
                AND refund."debt_netted_usd" <= allocation."settled_usd"
                AND refund."open_debt_usd"
                  = refund."debt_opened_usd" - refund."debt_netted_usd"
                AND refund."occurred_at" = transaction_row."created_at"
                AND refund."debt_netted_usd" = COALESCE((
                  SELECT SUM(settlement."amount_usd")
                  FROM "enterprise_credit_settlements" settlement
                  WHERE settlement."allocation_id" = allocation."id"
                    AND settlement."repayment_transaction_id" = transaction_row."id"
                    AND settlement."trigger" = 'REFUND_NETTING'
                ), 0)
            )
          )
          OR (
            transaction_row."type"::TEXT = 'CONSUME'
            AND EXISTS (
              SELECT 1
              FROM "balance_grant_refunds" refund
              WHERE refund."debt_allocation_id" = allocation."id"
            )
          )
        )
      )
      OR allocation."source" NOT IN ('BALANCE_GRANT', expected_debt_source)
  )
    INTO invalid_allocation_count
  FROM "balance_consumption_allocations" allocation
  LEFT JOIN "balance_transactions" transaction_row
    ON transaction_row."id" = allocation."balance_transaction_id"
  LEFT JOIN "balance_grants" grant_row
    ON grant_row."id" = allocation."balance_grant_id"
  WHERE allocation."billing_account_id" = target_account_id;

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
      AND NOT "balance_allocation_has_enterprise_absorb_proof"(
        foreign_allocation."id",
        target_grant."id",
        foreign_allocation."billing_account_id"
      )
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
    SELECT transaction_row."id"
    FROM "balance_transactions" transaction_row
    LEFT JOIN "balance_consumption_allocations" allocation
      ON allocation."balance_transaction_id" = transaction_row."id"
      AND allocation."billing_account_id" = target_account_id
    WHERE transaction_row."billing_account_id" = target_account_id
      AND transaction_row."type"::TEXT = 'CONSUME'
    GROUP BY
      transaction_row."id",
      transaction_row."amount_usd",
      transaction_row."balance_after_usd"
    HAVING COALESCE(SUM(allocation."amount_usd"), 0) <> -transaction_row."amount_usd"
      OR COALESCE(SUM(allocation."amount_usd") FILTER (
        WHERE allocation."source" = 'BALANCE_GRANT'
      ), 0) <> LEAST(
        -transaction_row."amount_usd",
        GREATEST(transaction_row."balance_after_usd" - transaction_row."amount_usd", 0)
      )
      OR COALESCE(SUM(allocation."amount_usd") FILTER (
        WHERE allocation."source" = expected_debt_source
      ), 0) <> -transaction_row."amount_usd" - LEAST(
        -transaction_row."amount_usd",
        GREATEST(transaction_row."balance_after_usd" - transaction_row."amount_usd", 0)
      )
  ) invalid_consume;

  -- Negative ledger sequences are repair-proven legacy history. Every
  -- post-expand REFUND receives a positive database sequence and must have a
  -- terminal immutable refund audit before the transaction can commit.
  SELECT COUNT(*) INTO invalid_refund_transaction_count
  FROM "balance_transactions" transaction_row
  WHERE transaction_row."billing_account_id" = target_account_id
    AND transaction_row."type"::TEXT = 'REFUND'
    AND transaction_row."ledger_sequence" > 0
    AND NOT EXISTS (
      SELECT 1
      FROM "balance_grant_refunds" refund
      WHERE refund."refund_transaction_id" = transaction_row."id"
        AND refund."billing_account_id" = target_account_id
        AND refund."operation_key" IS NOT DISTINCT FROM
          transaction_row."operation_key"
        AND refund."requested_amount_usd" = -transaction_row."amount_usd"
        AND refund."occurred_at" = transaction_row."created_at"
    );

  IF active_grant_amount IS DISTINCT FROM GREATEST(wallet_balance, 0)
    OR open_debt_amount IS DISTINCT FROM GREATEST(-wallet_balance, 0)
    OR wallet_balance IS DISTINCT FROM active_grant_amount - open_debt_amount
    OR transaction_total IS DISTINCT FROM wallet_balance
    OR invalid_transaction_count <> 0
    OR invalid_grant_count <> 0
    OR invalid_grant_conservation_count <> 0
    OR invalid_debt_count <> 0
    OR invalid_sequence_count <> 0
    OR unexpected_debt_count <> 0
    OR invalid_allocation_count <> 0
    OR invalid_consume_count <> 0
    OR invalid_refund_transaction_count <> 0
  THEN
    RAISE EXCEPTION
      'clean account canonical invariant invalid account=% wallet=% tx=% active=% debt=% invalid(tx/grant/grant_conservation/debt/sequence/unexpected/allocation/consume/refund)=%/%/%/%/%/%/%/%/%',
      target_account_id,
      wallet_balance,
      transaction_total,
      active_grant_amount,
      open_debt_amount,
      invalid_transaction_count,
      invalid_grant_count,
      invalid_grant_conservation_count,
      invalid_debt_count,
      invalid_sequence_count,
      unexpected_debt_count,
      invalid_allocation_count,
      invalid_consume_count,
      invalid_refund_transaction_count
      USING ERRCODE = '23514';
  END IF;

  PERFORM set_config(
    'billing.balance_canonical_validated',
    jsonb_set(
      validated_state,
      ARRAY[target_account_id],
      to_jsonb(current_revision),
      TRUE
    )::TEXT,
    TRUE
  );

  RETURN NULL;
END
$$;

-- A refund changes three projections at once: the target grant, an optional
-- debt allocation, and optional grants used to net that debt. The audit and
-- its allocation rows are immutable, so prove their complete event-time
-- conservation once at commit. Later FUNDING may settle the remaining debt;
-- it must not rewrite this refund's debt_netted/open_debt snapshot.
CREATE OR REPLACE FUNCTION "assert_balance_grant_refund_canonical"(
  target_refund_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  refund_row RECORD;
  expected_debt_source TEXT;
  allocation_count BIGINT;
  invalid_allocation_count BIGINT;
  target_allocation_count BIGINT;
  target_reduction NUMERIC;
  debt_netting_count BIGINT;
  debt_netting NUMERIC;
  minimum_sequence INTEGER;
  maximum_sequence INTEGER;
  refund_netting_settlement_count BIGINT;
  refunded_component_total NUMERIC;
  debt_row RECORD;
BEGIN
  SELECT
    refund.*,
    account."type" AS account_type,
    transaction_row."billing_account_id" AS transaction_account_id,
    transaction_row."user_id" AS transaction_user_id,
    transaction_row."tenant_id" AS transaction_tenant_id,
    transaction_row."product_id" AS transaction_product_id,
    transaction_row."order_id" AS transaction_order_id,
    transaction_row."type"::TEXT AS transaction_type,
    transaction_row."amount_usd" AS transaction_amount,
    transaction_row."operation_key" AS transaction_operation_key,
    transaction_row."created_at" AS transaction_created_at,
    target_grant."billing_account_id" AS grant_account_id,
    target_grant."user_id" AS grant_user_id,
    target_grant."tenant_id" AS grant_tenant_id,
    target_grant."product_id" AS grant_product_id,
    target_grant."order_id" AS grant_order_id,
    target_grant."paid_amount_usd" AS grant_paid_amount,
    target_grant."bonus_amount_usd" AS grant_bonus_amount
    INTO refund_row
  FROM "balance_grant_refunds" refund
  LEFT JOIN "billing_accounts" account
    ON account."id" = refund."billing_account_id"
  LEFT JOIN "balance_transactions" transaction_row
    ON transaction_row."id" = refund."refund_transaction_id"
  LEFT JOIN "balance_grants" target_grant
    ON target_grant."id" = refund."balance_grant_id"
  WHERE refund."id" = target_refund_id;

  IF NOT FOUND THEN
    RAISE EXCEPTION 'balance grant refund audit is missing refund=%', target_refund_id
      USING ERRCODE = '23514';
  END IF;

  expected_debt_source := CASE
    WHEN refund_row.account_type = 'enterprise' THEN 'ENTERPRISE_CREDIT'
    WHEN refund_row.account_type = 'personal' THEN 'NEGATIVE_BALANCE'
    ELSE NULL
  END;
  IF expected_debt_source IS NULL
    OR refund_row.transaction_type IS DISTINCT FROM 'REFUND'
    OR refund_row.transaction_amount >= 0
    OR refund_row.transaction_account_id IS DISTINCT FROM refund_row.billing_account_id
    OR refund_row.transaction_user_id IS DISTINCT FROM refund_row.grant_user_id
    OR refund_row.transaction_tenant_id IS DISTINCT FROM refund_row.grant_tenant_id
    OR refund_row.transaction_product_id IS DISTINCT FROM refund_row.grant_product_id
    OR refund_row.transaction_order_id IS DISTINCT FROM refund_row.grant_order_id
    OR refund_row.grant_order_id IS NULL
    OR refund_row.grant_account_id IS DISTINCT FROM refund_row.billing_account_id
    OR refund_row.transaction_operation_key IS DISTINCT FROM refund_row.operation_key
    OR -refund_row.transaction_amount IS DISTINCT FROM refund_row.requested_amount_usd
    OR refund_row.transaction_created_at IS DISTINCT FROM refund_row.occurred_at
  THEN
    RAISE EXCEPTION
      'balance grant refund subject/transaction invariant invalid refund=%',
      target_refund_id
      USING ERRCODE = '23514';
  END IF;

  SELECT COALESCE(SUM(refund."requested_amount_usd"), 0)
    INTO refunded_component_total
  FROM "balance_grant_refunds" refund
  WHERE refund."balance_grant_id" = refund_row.balance_grant_id
    AND refund."component" = refund_row.component;
  IF refunded_component_total > (CASE
    WHEN refund_row.component = 'PAID' THEN refund_row.grant_paid_amount
    ELSE refund_row.grant_bonus_amount
  END) THEN
    RAISE EXCEPTION
      'balance grant refund exceeds original component refund=% total=%',
      target_refund_id,
      refunded_component_total
      USING ERRCODE = '23514';
  END IF;

  SELECT
    COUNT(*),
    COUNT(*) FILTER (
      WHERE allocation_grant."id" IS NULL
        OR allocation_grant."billing_account_id"
          IS DISTINCT FROM refund_row.billing_account_id
        OR (
          allocation."role" = 'TARGET_UNUSED'
          AND (
            allocation."balance_grant_id" IS DISTINCT FROM refund_row.balance_grant_id
            OR (
              refund_row.component = 'PAID'
              AND (
                allocation."paid_reduction_usd" <> allocation."amount_usd"
                OR allocation."bonus_reduction_usd" <> 0
              )
            )
            OR (
              refund_row.component = 'BONUS'
              AND (
                allocation."bonus_reduction_usd" <> allocation."amount_usd"
                OR allocation."paid_reduction_usd" <> 0
              )
            )
          )
        )
        OR (
          allocation."role" = 'DEBT_NETTING'
          AND (
            refund_row.debt_allocation_id IS NULL
            OR (
              SELECT COUNT(*)
              FROM "enterprise_credit_settlements" settlement
              WHERE settlement."allocation_id" = refund_row.debt_allocation_id
                AND settlement."repayment_transaction_id"
                  = refund_row.refund_transaction_id
                AND settlement."balance_grant_id" = allocation."balance_grant_id"
                AND settlement."billing_account_id" = refund_row.billing_account_id
                AND settlement."debt_source" = expected_debt_source
                AND settlement."trigger" = 'REFUND_NETTING'
                AND settlement."amount_usd" = allocation."amount_usd"
                AND settlement."paid_usd" = allocation."paid_reduction_usd"
                AND settlement."bonus_usd" = allocation."bonus_reduction_usd"
                AND settlement."occurred_at" = refund_row.transaction_created_at
                AND settlement."operation_key" =
                  'refund-netting:' || refund_row.refund_transaction_id || ':'
                  || allocation."balance_grant_id" || ':' || refund_row.component
            ) <> 1
          )
        )
    ),
    COUNT(*) FILTER (WHERE allocation."role" = 'TARGET_UNUSED'),
    COALESCE(SUM(allocation."amount_usd") FILTER (
      WHERE allocation."role" = 'TARGET_UNUSED'
    ), 0),
    COUNT(*) FILTER (WHERE allocation."role" = 'DEBT_NETTING'),
    COALESCE(SUM(allocation."amount_usd") FILTER (
      WHERE allocation."role" = 'DEBT_NETTING'
    ), 0),
    MIN(allocation."sequence"),
    MAX(allocation."sequence")
    INTO
      allocation_count,
      invalid_allocation_count,
      target_allocation_count,
      target_reduction,
      debt_netting_count,
      debt_netting,
      minimum_sequence,
      maximum_sequence
  FROM "balance_grant_refund_allocations" allocation
  LEFT JOIN "balance_grants" allocation_grant
    ON allocation_grant."id" = allocation."balance_grant_id"
  WHERE allocation."refund_id" = target_refund_id;

  SELECT COUNT(*) INTO refund_netting_settlement_count
  FROM "enterprise_credit_settlements" settlement
  WHERE settlement."allocation_id" = refund_row.debt_allocation_id
    AND settlement."trigger" = 'REFUND_NETTING';

  IF invalid_allocation_count <> 0
    OR target_allocation_count <> (CASE
      WHEN refund_row.target_grant_reduction_usd > 0 THEN 1 ELSE 0
    END)
    OR target_reduction IS DISTINCT FROM refund_row.target_grant_reduction_usd
    OR debt_netting IS DISTINCT FROM refund_row.debt_netted_usd
    OR refund_netting_settlement_count IS DISTINCT FROM debt_netting_count
    OR (
      allocation_count > 0
      AND (minimum_sequence <> 1 OR maximum_sequence <> allocation_count)
    )
  THEN
    RAISE EXCEPTION
      'balance grant refund allocation invariant invalid refund=% rows=% invalid=% target=%/% debt=%/% sequence=%/%',
      target_refund_id,
      allocation_count,
      invalid_allocation_count,
      target_reduction,
      refund_row.target_grant_reduction_usd,
      debt_netting,
      refund_row.debt_netted_usd,
      minimum_sequence,
      maximum_sequence
      USING ERRCODE = '23514';
  END IF;

  IF refund_row.debt_opened_usd = 0 THEN
    IF refund_row.debt_allocation_id IS NOT NULL
      OR debt_netting_count <> 0
      OR refund_row.debt_netted_usd <> 0
      OR refund_row.open_debt_usd <> 0
    THEN
      RAISE EXCEPTION
        'zero-debt balance refund has debt facts refund=%', target_refund_id
        USING ERRCODE = '23514';
    END IF;
  ELSE
    SELECT * INTO debt_row
    FROM "balance_consumption_allocations" allocation
    WHERE allocation."id" = refund_row.debt_allocation_id;
    IF NOT FOUND
      OR debt_row."billing_account_id" IS DISTINCT FROM refund_row.billing_account_id
      OR debt_row."balance_transaction_id"
        IS DISTINCT FROM refund_row.refund_transaction_id
      OR debt_row."source" IS DISTINCT FROM expected_debt_source
      OR debt_row."balance_grant_id" IS NOT NULL
      OR debt_row."amount_usd" IS DISTINCT FROM refund_row.debt_opened_usd
      OR debt_row."settled_usd" < refund_row.debt_netted_usd
      OR refund_row.open_debt_usd IS DISTINCT FROM
        refund_row.debt_opened_usd - refund_row.debt_netted_usd
    THEN
      RAISE EXCEPTION
        'balance grant refund debt invariant invalid refund=% allocation=%',
        target_refund_id,
        refund_row.debt_allocation_id
        USING ERRCODE = '23514';
    END IF;
  END IF;
END
$$;

CREATE OR REPLACE FUNCTION "validate_balance_grant_refund_trigger"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_refund_id TEXT;
BEGIN
  IF TG_TABLE_NAME = 'balance_grant_refunds' THEN
    target_refund_id := NEW."id";
  ELSE
    target_refund_id := NEW."refund_id";
  END IF;
  PERFORM "assert_balance_grant_refund_canonical"(target_refund_id);
  RETURN NEW;
END
$$;

-- An allocation is not an independent financial fact: its subject and account
-- are inherited from the CONSUME/REFUND transaction, and a grant allocation may only
-- reference a grant owned by that same account. Enforce this for every new or
-- repaired row, including LEGACY_DIRTY accounts. Otherwise a row attributed
-- to a dirty account could point at a clean account's transaction/grant, evade
-- the dirty-account validator, and poison the clean ledger for its next write.
CREATE OR REPLACE FUNCTION "guard_balance_consumption_allocation_identity"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  target_account_type TEXT;
  target_account_status TEXT;
  transaction_account_id TEXT;
  transaction_user_id TEXT;
  transaction_tenant_id TEXT;
  transaction_product_id TEXT;
  transaction_token_usage_id TEXT;
  transaction_type TEXT;
  grant_account_id TEXT;
BEGIN
  IF NEW."billing_account_id" IS NULL THEN
    RAISE EXCEPTION
      'balance allocation requires billing account allocation=%',
      NEW."id"
      USING ERRCODE = '23514';
  END IF;

  SELECT account."type", account."balance_grant_ledger_status"
    INTO target_account_type, target_account_status
  FROM "billing_accounts" account
  WHERE account."id" = NEW."billing_account_id";
  IF NOT FOUND THEN
    RAISE EXCEPTION
      'balance allocation references missing account allocation=% account=%',
      NEW."id",
      NEW."billing_account_id"
      USING ERRCODE = '23514';
  END IF;

  SELECT
    transaction_row."billing_account_id",
    transaction_row."user_id",
    transaction_row."tenant_id",
    transaction_row."product_id",
    transaction_row."token_usage_id",
    transaction_row."type"::TEXT
    INTO
      transaction_account_id,
      transaction_user_id,
      transaction_tenant_id,
      transaction_product_id,
      transaction_token_usage_id,
      transaction_type
  FROM "balance_transactions" transaction_row
  WHERE transaction_row."id" = NEW."balance_transaction_id";
  IF NOT FOUND
    OR transaction_type NOT IN ('CONSUME', 'REFUND')
    OR transaction_account_id IS DISTINCT FROM NEW."billing_account_id"
    OR transaction_user_id IS DISTINCT FROM NEW."user_id"
    OR transaction_tenant_id IS DISTINCT FROM NEW."tenant_id"
    OR transaction_product_id IS DISTINCT FROM NEW."product_id"
    OR transaction_token_usage_id IS DISTINCT FROM NEW."token_usage_id"
  THEN
    RAISE EXCEPTION
      'balance allocation subject does not match transaction allocation=% transaction=% account=%',
      NEW."id",
      NEW."balance_transaction_id",
      NEW."billing_account_id"
      USING ERRCODE = '23514';
  END IF;

  IF NEW."source" = 'BALANCE_GRANT' THEN
    IF transaction_type IS DISTINCT FROM 'CONSUME'
      OR NEW."balance_grant_id" IS NULL
    THEN
      RAISE EXCEPTION
        'balance grant allocation requires grant allocation=%',
        NEW."id"
        USING ERRCODE = '23514';
    END IF;
    SELECT grant_row."billing_account_id"
      INTO grant_account_id
    FROM "balance_grants" grant_row
    WHERE grant_row."id" = NEW."balance_grant_id";
    IF NOT FOUND
      OR (
        grant_account_id IS DISTINCT FROM NEW."billing_account_id"
        AND (
          TG_OP <> 'UPDATE'
          OR NOT "balance_enterprise_absorb_active_allocation_update_is_valid"(
            to_jsonb(OLD),
            to_jsonb(NEW)
          )
        )
      )
    THEN
      RAISE EXCEPTION
        'balance allocation grant account mismatch allocation=% grant=% account=%',
        NEW."id",
        NEW."balance_grant_id",
        NEW."billing_account_id"
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."source" = 'UNRECONCILED_GRANT' THEN
    IF transaction_type IS DISTINCT FROM 'CONSUME'
      OR target_account_status IS DISTINCT FROM 'LEGACY_DIRTY'
    THEN
      RAISE EXCEPTION
        'unreconciled grant allocation is dirty-consume only allocation=% account=% status=%',
        NEW."id",
        NEW."billing_account_id",
        target_account_status
        USING ERRCODE = '23514';
    END IF;
    IF NEW."balance_grant_id" IS NOT NULL THEN
      SELECT grant_row."billing_account_id"
        INTO grant_account_id
      FROM "balance_grants" grant_row
      WHERE grant_row."id" = NEW."balance_grant_id";
      IF NOT FOUND
        OR grant_account_id IS DISTINCT FROM NEW."billing_account_id"
      THEN
        RAISE EXCEPTION
          'unreconciled allocation grant account mismatch allocation=% grant=% account=%',
          NEW."id",
          NEW."balance_grant_id",
          NEW."billing_account_id"
          USING ERRCODE = '23514';
      END IF;
    END IF;
  ELSIF NEW."source" = 'NEGATIVE_BALANCE' THEN
    IF target_account_type IS DISTINCT FROM 'personal'
      OR NEW."balance_grant_id" IS NOT NULL
    THEN
      RAISE EXCEPTION
        'negative balance allocation identity invalid allocation=% account=% type=%',
        NEW."id",
        NEW."billing_account_id",
        target_account_type
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."source" = 'ENTERPRISE_CREDIT' THEN
    IF target_account_type IS DISTINCT FROM 'enterprise'
      OR NEW."balance_grant_id" IS NOT NULL
    THEN
      RAISE EXCEPTION
        'enterprise credit allocation identity invalid allocation=% account=% type=%',
        NEW."id",
        NEW."billing_account_id",
        target_account_type
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION
      'balance allocation source invalid allocation=% source=%',
      NEW."id",
      NEW."source"
      USING ERRCODE = '23514';
  END IF;

  RETURN NEW;
END
$$;

-- A wallet is the account aggregate anchor. Its primary/FK identity can never
-- move to another account. Deleting it independently would leave a clean
-- account and its immutable facts without an aggregate. A legitimate hard
-- delete of the parent is still allowed: the cascading child delete runs after
-- the parent is no longer visible to this lookup.
CREATE OR REPLACE FUNCTION "guard_account_wallet_identity"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  account_status TEXT;
BEGIN
  IF TG_OP = 'UPDATE' THEN
    IF NEW."billing_account_id" IS DISTINCT FROM OLD."billing_account_id" THEN
      RAISE EXCEPTION
        'account wallet identity is immutable account=% attempted=%',
        OLD."billing_account_id",
        NEW."billing_account_id"
        USING ERRCODE = '23514';
    END IF;
    RETURN NEW;
  END IF;
  SELECT account."balance_grant_ledger_status"
    INTO account_status
  FROM "billing_accounts" account
  WHERE account."id" = OLD."billing_account_id";
  IF FOUND AND account_status = 'RECONCILED_V2' THEN
    RAISE EXCEPTION
      'clean account wallet cannot be deleted account=%',
      OLD."billing_account_id"
      USING ERRCODE = '23514';
  END IF;
  RETURN OLD;
END
$$;

-- Account type determines the only legal debt source. Once an account is
-- clean, changing personal/enterprise type would reinterpret every immutable
-- allocation without a compensating ledger event, so reject it at the row
-- boundary even if the current wallet happens to be zero.
CREATE OR REPLACE FUNCTION "guard_clean_billing_account_type"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF OLD."balance_grant_ledger_status" = 'RECONCILED_V2'
    AND NEW."type" IS DISTINCT FROM OLD."type"
  THEN
    RAISE EXCEPTION
      'clean billing account type is immutable account=% old=% new=%',
      OLD."id",
      OLD."type",
      NEW."type"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

DROP TRIGGER IF EXISTS "balance_grants_expiry_reconciled_v2_guard"
  ON "balance_grants";
CREATE TRIGGER "balance_grants_expiry_reconciled_v2_guard"
BEFORE UPDATE OF "is_expired" ON "balance_grants"
FOR EACH ROW
EXECUTE FUNCTION "guard_balance_grant_expiry_reconciled_v2"();

DROP TRIGGER IF EXISTS "balance_grants_expiry_aggregate_deferred"
  ON "balance_grants";
CREATE CONSTRAINT TRIGGER "balance_grants_expiry_aggregate_deferred"
AFTER UPDATE ON "balance_grants"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_balance_grant_expiry_transition_trigger"();

DROP TRIGGER IF EXISTS "account_wallets_clean_canonical_deferred"
  ON "account_wallets";
DROP TRIGGER IF EXISTS "balance_canonical_revision_marker"
  ON "account_wallets";
DROP TRIGGER IF EXISTS "account_wallets_clean_delete_guard"
  ON "account_wallets";
DROP TRIGGER IF EXISTS "account_wallets_identity_guard"
  ON "account_wallets";
CREATE TRIGGER "account_wallets_identity_guard"
BEFORE UPDATE OF "billing_account_id" OR DELETE ON "account_wallets"
FOR EACH ROW
EXECUTE FUNCTION "guard_account_wallet_identity"();
CREATE TRIGGER "balance_canonical_revision_marker"
BEFORE INSERT OR UPDATE ON "account_wallets"
FOR EACH ROW
EXECUTE FUNCTION "mark_balance_canonical_revision"();
CREATE CONSTRAINT TRIGGER "account_wallets_clean_canonical_deferred"
AFTER INSERT OR UPDATE ON "account_wallets"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "assert_clean_account_wallet_canonical_deferred"();

DROP TRIGGER IF EXISTS "billing_accounts_clean_type_guard"
  ON "billing_accounts";
CREATE TRIGGER "billing_accounts_clean_type_guard"
BEFORE UPDATE OF "type" ON "billing_accounts"
FOR EACH ROW
EXECUTE FUNCTION "guard_clean_billing_account_type"();

DROP TRIGGER IF EXISTS "balance_grants_clean_canonical_deferred"
  ON "balance_grants";
DROP TRIGGER IF EXISTS "balance_canonical_revision_marker"
  ON "balance_grants";
CREATE TRIGGER "balance_canonical_revision_marker"
BEFORE INSERT OR UPDATE ON "balance_grants"
FOR EACH ROW
EXECUTE FUNCTION "mark_balance_canonical_revision"();
CREATE CONSTRAINT TRIGGER "balance_grants_clean_canonical_deferred"
AFTER INSERT OR UPDATE ON "balance_grants"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "assert_clean_account_wallet_canonical_deferred"();

DROP TRIGGER IF EXISTS "balance_debt_allocations_clean_canonical_deferred"
  ON "balance_consumption_allocations";
DROP TRIGGER IF EXISTS "balance_canonical_revision_marker"
  ON "balance_consumption_allocations";
DROP TRIGGER IF EXISTS "balance_consumption_allocations_identity_guard"
  ON "balance_consumption_allocations";
CREATE TRIGGER "balance_consumption_allocations_identity_guard"
BEFORE INSERT OR UPDATE ON "balance_consumption_allocations"
FOR EACH ROW
EXECUTE FUNCTION "guard_balance_consumption_allocation_identity"();
CREATE TRIGGER "balance_canonical_revision_marker"
BEFORE INSERT OR UPDATE ON "balance_consumption_allocations"
FOR EACH ROW
EXECUTE FUNCTION "mark_balance_canonical_revision"();
CREATE CONSTRAINT TRIGGER "balance_debt_allocations_clean_canonical_deferred"
AFTER INSERT OR UPDATE ON "balance_consumption_allocations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "assert_clean_account_wallet_canonical_deferred"();

DROP TRIGGER IF EXISTS "balance_transactions_clean_canonical_deferred"
  ON "balance_transactions";
DROP TRIGGER IF EXISTS "balance_canonical_revision_marker"
  ON "balance_transactions";
CREATE TRIGGER "balance_canonical_revision_marker"
BEFORE INSERT OR UPDATE ON "balance_transactions"
FOR EACH ROW
EXECUTE FUNCTION "mark_balance_canonical_revision"();
CREATE CONSTRAINT TRIGGER "balance_transactions_clean_canonical_deferred"
AFTER INSERT OR UPDATE ON "balance_transactions"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "assert_clean_account_wallet_canonical_deferred"();

DROP TRIGGER IF EXISTS "balance_grant_refunds_canonical_deferred"
  ON "balance_grant_refunds";
CREATE CONSTRAINT TRIGGER "balance_grant_refunds_canonical_deferred"
AFTER INSERT ON "balance_grant_refunds"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_balance_grant_refund_trigger"();

DROP TRIGGER IF EXISTS "balance_grant_refund_allocations_canonical_deferred"
  ON "balance_grant_refund_allocations";
CREATE CONSTRAINT TRIGGER "balance_grant_refund_allocations_canonical_deferred"
AFTER INSERT ON "balance_grant_refund_allocations"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_balance_grant_refund_trigger"();

DO $activate_contract$
DECLARE
  updated_count BIGINT;
BEGIN
  PERFORM set_config(
    'billing.balance_ledger_rollout_transition',
    'contract-v1',
    TRUE
  );
  UPDATE "balance_ledger_rollout_control"
  SET
    "phase" = 'V2_CONTRACT',
    "v2_contract_at" = clock_timestamp()::TIMESTAMP(3)
  WHERE "id" = 1
    AND "phase" = 'CUTOVER_READY'
    AND "expiry_safe_through" > clock_timestamp()::TIMESTAMP(3);
  GET DIAGNOSTICS updated_count = ROW_COUNT;
  IF updated_count <> 1 THEN
    RAISE EXCEPTION 'balance ledger V2_CONTRACT compare-and-swap failed'
      USING ERRCODE = '40001';
  END IF;
END
$activate_contract$;

COMMIT;
