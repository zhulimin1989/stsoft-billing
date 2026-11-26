-- Read-only proof after resolving the known failed checksum and replaying the
-- corrected migration. A finished new-checksum attempt also proves that the
-- migration's own complete catalog fingerprint verifier passed.
DO $verify$
DECLARE
  actual_count BIGINT;
  control_row "balance_ledger_rollout_control"%ROWTYPE;
BEGIN
  SELECT COUNT(*)
    INTO actual_count
  FROM "_prisma_migrations"
  WHERE "migration_name" =
    '20260715000100_personal_negative_balance_settlement';
  IF actual_count <> 2 THEN
    RAISE EXCEPTION 'expected exactly two target migration attempts, got %',
      actual_count
      USING ERRCODE = '55000';
  END IF;

  SELECT COUNT(*)
    INTO actual_count
  FROM "_prisma_migrations"
  WHERE "migration_name" =
      '20260715000100_personal_negative_balance_settlement'
    AND "checksum" =
      '0fbbce8db89f7ffe03b68c5a7e0b60375a22b246c335d32cdbae25588c3f1a7a'
    AND "started_at" IS NOT NULL
    AND "finished_at" IS NULL
    AND "rolled_back_at" IS NOT NULL
    AND "applied_steps_count" = 0;
  IF actual_count <> 1 THEN
    RAISE EXCEPTION 'old-checksum attempt is not the single rolled-back row'
      USING ERRCODE = '55000';
  END IF;

  SELECT COUNT(*)
    INTO actual_count
  FROM "_prisma_migrations"
  WHERE "migration_name" =
      '20260715000100_personal_negative_balance_settlement'
    AND "checksum" =
      'ead494351c7e71fd1d7e5b2d180f419abd044ed41f3ad6306c6598e9b13f75b9'
    AND "started_at" IS NOT NULL
    AND "finished_at" IS NOT NULL
    AND "rolled_back_at" IS NULL
    AND "applied_steps_count" = 1;
  IF actual_count <> 1 THEN
    RAISE EXCEPTION 'new-checksum attempt is not the single finished row'
      USING ERRCODE = '55000';
  END IF;

  SELECT COUNT(*)
    INTO actual_count
  FROM "_prisma_migrations"
  WHERE "finished_at" IS NULL
    AND "rolled_back_at" IS NULL;
  IF actual_count <> 0 THEN
    RAISE EXCEPTION 'recovered database has % unresolved migration attempt(s)',
      actual_count
      USING ERRCODE = '55000';
  END IF;

  SELECT COUNT(*)
    INTO actual_count
  FROM "balance_ledger_rollout_control";
  IF actual_count <> 1 THEN
    RAISE EXCEPTION 'recovered rollout control has % rows, expected exactly one',
      actual_count
      USING ERRCODE = '55000';
  END IF;

  SELECT *
    INTO control_row
  FROM "balance_ledger_rollout_control";
  IF control_row."id" <> 1
    OR control_row."phase" <> 'EXPANDED'
    OR control_row."database_name" <> current_database()
    OR control_row."database_identity" IS NULL
    OR control_row."database_system_identifier" <>
      (SELECT "system_identifier"::NUMERIC(20, 0) FROM pg_control_system())
    OR control_row."database_oid" <>
      (SELECT oid FROM pg_database WHERE datname = current_database())
    OR control_row."expanded_at" IS NULL
    OR control_row."opening_grant_count_at_expand" <>
      (SELECT COUNT(*) FROM "balance_grants" WHERE "source" = 'MIGRATION_OPENING')
    OR control_row."cutover_ready_at" IS NOT NULL
    OR control_row."v2_contract_at" IS NOT NULL
  THEN
    RAISE EXCEPTION 'recovered rollout control is not the exact EXPANDED locator'
      USING ERRCODE = '55000';
  END IF;

  SELECT COUNT(*)
    INTO actual_count
  FROM "balance_ledger_rollout_transitions" transition_row
  WHERE transition_row."from_phase" = 'NOT_INSTALLED'
    AND transition_row."to_phase" = 'EXPANDED'
    AND transition_row."database_name" = control_row."database_name"
    AND transition_row."database_identity" = control_row."database_identity"
    AND transition_row."database_system_identifier" =
      control_row."database_system_identifier"
    AND transition_row."database_oid" = control_row."database_oid"
    AND transition_row."operator" = 'migration'
    AND transition_row."change_ticket" =
      '20260715000100_personal_negative_balance_settlement'
    AND transition_row."evidence_sha256" = repeat('0', 64)
    AND transition_row."expiry_safe_through" = control_row."expanded_at"
    AND transition_row."created_at" = control_row."expanded_at";
  IF actual_count <> 1
    OR (SELECT COUNT(*) FROM "balance_ledger_rollout_transitions") <> 1
  THEN
    RAISE EXCEPTION 'recovered rollout transition is not the single legal edge'
      USING ERRCODE = '55000';
  END IF;

  IF (SELECT COUNT(*) FROM "balance_ledger_database_identity_rotations") <> 0
  THEN
    RAISE EXCEPTION 'recovery rehearsal unexpectedly rotated database identity'
      USING ERRCODE = '55000';
  END IF;

  SELECT COUNT(*)
    INTO actual_count
  FROM pg_proc procedure_row
  JOIN pg_namespace namespace_row
    ON namespace_row.oid = procedure_row.pronamespace
  WHERE namespace_row.nspname = 'public'
    AND procedure_row.proname = 'prepare_balance_ledger_v2_contract';
  IF actual_count <> 1 THEN
    RAISE EXCEPTION 'recovered database has % prepare function(s)', actual_count
      USING ERRCODE = '55000';
  END IF;

  SELECT COUNT(*)
    INTO actual_count
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
  IF actual_count <> 0 THEN
    RAISE EXCEPTION 'Release B strict triggers appeared before cutover: %',
      actual_count
      USING ERRCODE = '55000';
  END IF;
END
$verify$;
