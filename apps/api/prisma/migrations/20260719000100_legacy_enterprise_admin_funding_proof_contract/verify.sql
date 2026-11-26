-- Read-only verification for the legacy enterprise admin-funding proof
-- contract. Run after prisma migrate deploy in both test and UAT.

BEGIN TRANSACTION READ ONLY;

DO $verify$
DECLARE
  invalid_count BIGINT;
  trigger_count BIGINT;
  candidate_source TEXT;
  timing_source TEXT;
  promotion_source TEXT;
BEGIN
  IF to_regclass('public.balance_ledger_admin_funding_repairs') IS NULL THEN
    RAISE EXCEPTION 'admin funding proof table missing';
  END IF;

  SELECT COUNT(*) INTO invalid_count
  FROM pg_constraint constraint_row
  WHERE constraint_row.conrelid
      = 'public.balance_ledger_admin_funding_repairs'::REGCLASS
    AND NOT constraint_row.convalidated;
  IF invalid_count <> 0 THEN
    RAISE EXCEPTION 'admin funding proof table has unvalidated constraints: %',
      invalid_count;
  END IF;

  SELECT COUNT(*) INTO trigger_count
  FROM pg_trigger trigger_row
  WHERE trigger_row.tgrelid
      = 'public.balance_ledger_admin_funding_repairs'::REGCLASS
    AND NOT trigger_row.tgisinternal
    AND trigger_row.tgname IN (
      'balance_ledger_admin_funding_repairs_append_only',
      'balance_ledger_admin_funding_repairs_insert_guard',
      'balance_ledger_admin_funding_repairs_terminal_deferred'
    );
  IF trigger_count <> 3 THEN
    RAISE EXCEPTION 'admin funding proof trigger set incomplete: %', trigger_count;
  END IF;

  WITH expected_trigger(
    relation_id,
    trigger_name,
    function_id,
    is_deferrable,
    is_initially_deferred
  ) AS (
    VALUES
      (
        'public.balance_ledger_admin_funding_repairs'::REGCLASS,
        'balance_ledger_admin_funding_repairs_append_only',
        'public.reject_balance_ledger_admin_funding_repair_mutation()'::REGPROCEDURE,
        FALSE,
        FALSE
      ),
      (
        'public.balance_ledger_admin_funding_repairs'::REGCLASS,
        'balance_ledger_admin_funding_repairs_insert_guard',
        'public.validate_balance_ledger_admin_funding_repair_insert()'::REGPROCEDURE,
        FALSE,
        FALSE
      ),
      (
        'public.balance_ledger_admin_funding_repairs'::REGCLASS,
        'balance_ledger_admin_funding_repairs_terminal_deferred',
        'public.validate_balance_ledger_admin_funding_terminal()'::REGPROCEDURE,
        TRUE,
        TRUE
      ),
      (
        'public.balance_grants'::REGCLASS,
        'balance_grants_repair_enterprise_admin_funding_insert_guard',
        'public.guard_repair_enterprise_admin_funding_grant_insert()'::REGPROCEDURE,
        FALSE,
        FALSE
      )
  )
  SELECT COUNT(*) INTO trigger_count
  FROM expected_trigger expected
  JOIN pg_trigger trigger_row
    ON trigger_row.tgrelid = expected.relation_id
    AND trigger_row.tgname = expected.trigger_name
    AND trigger_row.tgfoid = expected.function_id
    AND NOT trigger_row.tgisinternal
    AND trigger_row.tgenabled = 'O'
    AND trigger_row.tgdeferrable = expected.is_deferrable
    AND trigger_row.tginitdeferred = expected.is_initially_deferred;
  IF trigger_count <> 4 THEN
    RAISE EXCEPTION
      'admin funding proof trigger/function/enabled contract incomplete: %',
      trigger_count;
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger trigger_row
    WHERE trigger_row.tgrelid
        = 'public.balance_ledger_admin_funding_repairs'::REGCLASS
      AND trigger_row.tgname
        = 'balance_ledger_admin_funding_repairs_terminal_deferred'
      AND trigger_row.tgdeferrable
      AND trigger_row.tginitdeferred
  ) THEN
    RAISE EXCEPTION 'admin funding terminal guard is not initially deferred';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger trigger_row
    WHERE trigger_row.tgrelid = 'public.balance_grants'::REGCLASS
      AND trigger_row.tgname
        = 'balance_grants_repair_enterprise_admin_funding_insert_guard'
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'reserved admin funding grant INSERT guard missing';
  END IF;
  -- The pair-repair prefix remains independently guarded.
  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger trigger_row
    WHERE trigger_row.tgrelid = 'public.balance_grants'::REGCLASS
      AND trigger_row.tgname
        = 'balance_grants_repair_admin_recharge_insert_guard'
      AND NOT trigger_row.tgisinternal
  ) THEN
    RAISE EXCEPTION 'existing pair-repair grant INSERT guard was lost';
  END IF;

  IF to_regprocedure(
      'public.balance_admin_funding_terminal_grant_id(text,text)'
    ) IS NULL
    OR to_regprocedure(
      'public.validate_balance_ledger_admin_funding_repair_insert()'
    ) IS NULL
    OR to_regprocedure(
      'public.validate_balance_ledger_admin_funding_terminal()'
    ) IS NULL
    OR to_regprocedure(
      'public.balance_admin_funding_settlement_timing_is_proven(text)'
    ) IS NULL
    OR to_regprocedure(
      'public.balance_admin_funding_allocation_repair_is_proven(text,text,text,jsonb)'
    ) IS NULL
    OR to_regprocedure(
      'public.balance_admin_funding_terminal_evidence_is_valid(text,text,jsonb)'
    ) IS NULL
  THEN
    RAISE EXCEPTION 'admin funding proof helper function set incomplete';
  END IF;

  SELECT p.prosrc INTO candidate_source
  FROM pg_proc p
  WHERE p.oid = 'public.balance_funding_candidates(text,text)'::REGPROCEDURE;
  IF (length(candidate_source) - length(replace(
      candidate_source, 'balance_admin_funding_terminal_grant_id', ''
    ))) / length('balance_admin_funding_terminal_grant_id') <> 2
    OR (length(candidate_source) - length(replace(
      candidate_source, 'balance_ledger_admin_funding_repairs', ''
    ))) / length('balance_ledger_admin_funding_repairs') <> 1
  THEN
    RAISE EXCEPTION 'shared funding classifier was not upgraded exactly once';
  END IF;

  SELECT p.prosrc INTO timing_source
  FROM pg_proc p
  WHERE p.oid =
    'public.balance_legacy_enterprise_settlement_timing_is_proven(text)'::REGPROCEDURE;
  IF (length(timing_source) - length(replace(
      timing_source,
      'balance_admin_funding_settlement_timing_is_proven',
      ''
    ))) / length('balance_admin_funding_settlement_timing_is_proven') <> 1
  THEN
    RAISE EXCEPTION 'legacy settlement timing routing is not exact';
  END IF;

  SELECT p.prosrc INTO promotion_source
  FROM pg_proc p
  WHERE p.oid =
    'public.assert_balance_ledger_canonical_promotion(text,text,boolean)'::REGPROCEDURE;
  IF (length(promotion_source) - length(replace(
      promotion_source, '  ), funding_candidates AS (', ''
    ))) / length('  ), funding_candidates AS (') <> 1
    OR (length(promotion_source) - length(replace(
      promotion_source, '  ), funding_cardinality AS (', ''
    ))) / length('  ), funding_cardinality AS (') <> 1
    OR (length(promotion_source) - length(replace(
      promotion_source, 'FROM "balance_funding_candidates"(', ''
    ))) / length('FROM "balance_funding_candidates"(') <> 2
    OR position(
      'balance:admin-adjust:enterprise-paid-debt' IN promotion_source
    ) <> 0
    OR (length(promotion_source) - length(replace(
      promotion_source,
      'balance_admin_funding_terminal_grant_id',
      ''
    ))) / length('balance_admin_funding_terminal_grant_id') <> 1
    OR (length(promotion_source) - length(replace(
      promotion_source,
      'balance_admin_funding_allocation_repair_is_proven',
      ''
    ))) / length('balance_admin_funding_allocation_repair_is_proven') <> 1
    OR (length(promotion_source) - length(replace(
      promotion_source,
      'balance_admin_funding_terminal_evidence_is_valid',
      ''
    ))) / length('balance_admin_funding_terminal_evidence_is_valid') <> 1
  THEN
    RAISE EXCEPTION 'canonical promotion classifier routing is not exact';
  END IF;

  IF EXISTS (
    SELECT 1 FROM "_prisma_migrations"
    WHERE "migration_name"
      = '20260718000100_balance_migration_opening_retirement_contract'
      AND "finished_at" IS NOT NULL
      AND "rolled_back_at" IS NULL
  ) AND position(
    'balance_migration_opening_retirement_proof_is_valid' IN promotion_source
  ) = 0 THEN
    RAISE EXCEPTION 'UAT opening-retirement canonical checks were overwritten';
  END IF;

  SELECT COUNT(*) INTO invalid_count
  FROM "balance_ledger_admin_funding_repairs" proof
  WHERE proof."proof_version" <> 1
    OR proof."proof_hash" !~ '^[0-9a-f]{64}$'
    OR proof."proof_hash" = repeat('0', 64)
    OR proof."repair_kind" <> 'LEGACY_ENTERPRISE_ADMIN_FUNDING_V1'
    OR proof."action" NOT IN ('CREATE_GRANT', 'LINK_GRANT')
    OR proof."canonical_remaining_amount_usd" < 0
    OR proof."canonical_remaining_paid_amount_usd" < 0
    OR proof."canonical_remaining_bonus_amount_usd" <> 0
    OR proof."canonical_remaining_amount_usd" <>
      proof."canonical_remaining_paid_amount_usd"
        + proof."canonical_remaining_bonus_amount_usd";
  IF invalid_count <> 0 THEN
    RAISE EXCEPTION 'invalid persisted admin funding proofs: %', invalid_count;
  END IF;
END
$verify$;

ROLLBACK;
