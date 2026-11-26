-- Read-only postcondition shared by every PostgreSQL major exercised in CI.
-- Keep the trigger list here single-sourced so PG16 and PG18 cannot drift.
DO $verify$
DECLARE
  rollout_phase TEXT;
  strict_trigger_count BIGINT;
  canonical_definition TEXT;
  settlement_conservation_definition TEXT;
  settlement_conservation_compact TEXT;
  settlement_conservation_fingerprint TEXT;
BEGIN
  SELECT "phase"
    INTO rollout_phase
  FROM "balance_ledger_rollout_control"
  WHERE "id" = 1;

  SELECT COUNT(*)
    INTO strict_trigger_count
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

  IF rollout_phase IS DISTINCT FROM 'V2_CONTRACT'
    OR strict_trigger_count IS DISTINCT FROM 15
  THEN
    RAISE EXCEPTION
      'billing Release B postcondition failed phase=% strict_triggers=%',
      COALESCE(rollout_phase, 'MISSING'),
      strict_trigger_count
      USING ERRCODE = '23514';
  END IF;

  IF to_regprocedure(
      'public.balance_enterprise_absorb_active_pair_is_valid(text)'
    ) IS NULL
    OR to_regprocedure(
      'public.balance_enterprise_absorb_active_allocation_update_is_valid(jsonb,jsonb)'
    ) IS NULL
    OR to_regprocedure(
      'public.balance_allocation_has_enterprise_absorb_proof(text,text,text)'
    ) IS NULL
    OR to_regprocedure(
      'public.balance_legacy_settlement_effective_grant_id(text)'
    ) IS NULL
    OR to_regprocedure(
      'public.balance_legacy_enterprise_settlement_timing_is_proven(text)'
    ) IS NULL
    OR to_regprocedure(
      'public.assert_balance_debt_allocation_settlement_conservation(text)'
    ) IS NULL
  THEN
    RAISE EXCEPTION 'billing Release B enterprise absorb helpers missing'
      USING ERRCODE = '23514';
  END IF;

  IF to_regprocedure(
      'public.gateway_balance_canonical_mutation_is_current_settlement(text,text,jsonb,jsonb)'
    ) IS NULL
  THEN
    RAISE EXCEPTION 'billing Release B Gateway canonical helper missing'
      USING ERRCODE = '23514';
  END IF;

  SELECT
    pg_get_functiondef(procedure_row.oid),
    md5(procedure_row.prosrc)
  INTO
    settlement_conservation_definition,
    settlement_conservation_fingerprint
  FROM pg_proc procedure_row
  WHERE procedure_row.oid =
    'assert_balance_debt_allocation_settlement_conservation(text)'::regprocedure;

  -- This is deliberately a complete body fingerprint, not a loose feature
  -- check. A later migration that changes this financial invariant must also
  -- make the contract change explicit here for every CI PostgreSQL major.
  IF settlement_conservation_fingerprint <>
    '80b79e38215d07b9a50663c250ea7feb'
  THEN
    RAISE EXCEPTION
      'billing Release B debt settlement conservation fingerprint drifted expected=% actual=%',
      '80b79e38215d07b9a50663c250ea7feb',
      COALESCE(settlement_conservation_fingerprint, 'MISSING')
      USING ERRCODE = '23514';
  END IF;

  settlement_conservation_compact := regexp_replace(
    settlement_conservation_definition,
    '[[:space:]]+',
    '',
    'g'
  );
  IF position(
      'ANDNOT(EXISTS(SELECT1FROM"balance_transactions"btWHEREbt."id"=s."repayment_transaction_id"ANDbt."billing_account_id"=allocation_row."billing_account_id"ANDbt."created_at"=s."occurred_at")OR(s."trigger"=''FUNDING''ANDs."repair_run_id"ISNULLANDs."debt_source"=''ENTERPRISE_CREDIT''AND"balance_legacy_enterprise_settlement_timing_is_proven"(s."id")))'
      IN settlement_conservation_compact
    ) = 0
    OR (
      length(settlement_conservation_definition) - length(replace(
        settlement_conservation_definition,
        'bt."created_at" = s."occurred_at"',
        ''
      ))
    ) / length('bt."created_at" = s."occurred_at"') <> 1
    OR (
      length(settlement_conservation_definition) - length(replace(
        settlement_conservation_definition,
        'balance_legacy_enterprise_settlement_timing_is_proven',
        ''
      ))
    ) / length(
      'balance_legacy_enterprise_settlement_timing_is_proven'
    ) <> 1
    OR position('interval' IN lower(settlement_conservation_definition)) > 0
    OR position('make_interval' IN lower(settlement_conservation_definition)) > 0
    OR position('date_part' IN lower(settlement_conservation_definition)) > 0
    OR position('date_trunc' IN lower(settlement_conservation_definition)) > 0
    OR position('extract(' IN lower(settlement_conservation_compact)) > 0
    OR position('age(' IN lower(settlement_conservation_compact)) > 0
  THEN
    RAISE EXCEPTION
      'billing Release B debt settlement timing route is not exact-or-strict-legacy'
      USING ERRCODE = '23514';
  END IF;

  IF position(
      'balance_enterprise_absorb_active_allocation_update_is_valid'
      IN pg_get_functiondef(
        'guard_balance_consumption_allocation_identity()'::regprocedure
      )
    ) = 0
  THEN
    RAISE EXCEPTION 'billing Release B enterprise absorb allocation guard missing'
      USING ERRCODE = '23514';
  END IF;
  SELECT pg_get_functiondef(
    'assert_clean_account_wallet_canonical_deferred()'::regprocedure
  ) INTO canonical_definition;
  IF position(
      'gateway_balance_canonical_mutation_is_current_settlement'
      IN canonical_definition
    ) = 0
    OR (
      length(canonical_definition) - length(replace(
        canonical_definition,
        'gateway_balance_canonical_mutation_is_current_settlement',
        ''
      ))
    ) / length('gateway_balance_canonical_mutation_is_current_settlement') <> 1
    OR position(
      'balance_enterprise_absorb_active_pair_is_valid'
      IN canonical_definition
    ) = 0
    OR (
      length(canonical_definition) - length(replace(
        canonical_definition,
        'balance_allocation_has_enterprise_absorb_proof',
        ''
      ))
    ) / length('balance_allocation_has_enterprise_absorb_proof') <> 4
    OR (
      length(canonical_definition) - length(replace(
        canonical_definition,
        'balance_legacy_settlement_effective_grant_id',
        ''
      ))
    ) / length('balance_legacy_settlement_effective_grant_id') <> 2
    OR position(
      'FROM "balance_consumption_allocations" foreign_allocation'
      IN canonical_definition
    ) = 0
    OR position(
      'JOIN "balance_transactions" target_transaction'
      IN canonical_definition
    ) = 0
    OR position(
      'JOIN "balance_grants" target_grant'
      IN canonical_definition
    ) = 0
    OR position(
      'JOIN "balance_consumption_allocations" target_allocation'
      IN canonical_definition
    ) = 0
    OR position(
      'JOIN "balance_transactions" target_repayment'
      IN canonical_definition
    ) = 0
  THEN
    RAISE EXCEPTION 'billing Release B enterprise absorb canonical route missing'
      USING ERRCODE = '23514';
  END IF;
END
$verify$;
