DO $$
DECLARE
  missing_relations TEXT[];
  missing_functions TEXT[];
  missing_triggers TEXT[];
  canonical_oid OID;
  guard_oid OID;
  canonical_definition TEXT;
  pair_definition TEXT;
  grant_guard_definition TEXT;
BEGIN
  SELECT array_agg(name ORDER BY name) INTO missing_relations
  FROM unnest(ARRAY[
    'balance_ledger_account_transfer_repairs',
    'balance_ledger_account_transfer_grants',
    'balance_ledger_grant_creation_repairs',
    'balance_ledger_grant_component_repairs'
  ]) name
  WHERE to_regclass('public.' || name) IS NULL;
  IF missing_relations IS NOT NULL THEN
    RAISE EXCEPTION 'enterprise absorb repair relations missing: %', missing_relations;
  END IF;

  SELECT array_agg(name ORDER BY name) INTO missing_functions
  FROM unnest(ARRAY[
    'balance_allocation_has_enterprise_absorb_proof(text,text,text)',
    'balance_enterprise_absorb_active_allocation_update_is_valid(jsonb,jsonb)',
    'balance_enterprise_absorb_active_pair_is_valid(text)',
    'balance_enterprise_absorb_order_is_single_paid_grant(text,text,text)',
    'balance_grant_has_enterprise_absorb_creation_proof(text)',
    'balance_legacy_settlement_effective_grant_id(text)',
    'assert_balance_enterprise_absorb_pair_repair(text,text,text)',
    'validate_balance_enterprise_absorb_pair_terminal()',
    'validate_balance_enterprise_absorb_grant_component_repair_insert()',
    'validate_balance_enterprise_absorb_grant_component_terminal()'
  ]) name
  WHERE to_regprocedure('public.' || name) IS NULL;
  IF missing_functions IS NOT NULL THEN
    RAISE EXCEPTION 'enterprise absorb repair functions missing: %', missing_functions;
  END IF;

  IF position(
      'LEGACY_ENTERPRISE_ABSORB_V1'
      IN pg_get_functiondef(
        'assert_balance_enterprise_absorb_pair_repair(text,text,text)'::regprocedure
      )
    ) > 0
    OR position(
      'ENTERPRISE_ABSORB_V1'
      IN pg_get_functiondef(
        'assert_balance_enterprise_absorb_pair_repair(text,text,text)'::regprocedure
      )
    ) = 0
    OR position(
      'ENTERPRISE_ABSORB_V1'
      IN pg_get_functiondef(
        'balance_allocation_has_enterprise_absorb_proof(text,text,text)'::regprocedure
      )
    ) = 0
  THEN
    RAISE EXCEPTION 'enterprise absorb repair-kind contract drifted';
  END IF;

  SELECT pg_get_functiondef(
    'assert_balance_enterprise_absorb_pair_repair(text,text,text)'::regprocedure
  ) INTO pair_definition;
  SELECT pg_get_functiondef(
    'validate_balance_enterprise_absorb_grant_insert()'::regprocedure
  ) INTO grant_guard_definition;
  IF position(
      'enterprise absorb cross-account settlement invalid'
      IN pair_definition
    ) = 0
    OR position(
      'balance_enterprise_absorb_order_is_single_paid_grant'
      IN pair_definition
    ) = 0
    OR position(
      'balance_enterprise_absorb_order_is_single_paid_grant'
      IN grant_guard_definition
    ) = 0
    OR position(
      'grant_row."valid_from" > grant_row."created_at"'
      IN grant_guard_definition
    ) = 0
    OR position(
      'enterprise absorb pair V1 does not support direct settlement'
      IN pair_definition
    ) = 0
    OR (
      length(pair_definition) - length(replace(
        pair_definition,
        'settlement."billing_account_id" = grant_row."billing_account_id"',
        ''
      ))
    ) / length(
      'settlement."billing_account_id" = grant_row."billing_account_id"'
    ) < 2
    OR (
      length(pair_definition) - length(replace(
        pair_definition,
        'settlement."trigger" = ''FUNDING''',
        ''
      ))
    ) / length('settlement."trigger" = ''FUNDING''') < 2
    OR (
      length(pair_definition) - length(replace(
        pair_definition,
        'settlement."repair_run_id" IS NULL',
        ''
      ))
    ) / length('settlement."repair_run_id" IS NULL') < 2
  THEN
    RAISE EXCEPTION 'enterprise absorb global order/settlement contract drifted';
  END IF;

  -- When the gated expiry rollout already exists, 00110 must replace both of
  -- its known functions with deterministic final definitions.  Before that
  -- rollout neither function exists, and its source installs the same bodies
  -- later.  A partial installation is never valid.
  canonical_oid := to_regprocedure(
    'public.assert_clean_account_wallet_canonical_deferred()'
  );
  guard_oid := to_regprocedure(
    'public.guard_balance_consumption_allocation_identity()'
  );
  IF (canonical_oid IS NULL) IS DISTINCT FROM (guard_oid IS NULL) THEN
    RAISE EXCEPTION 'expiry-v2 canonical functions are partially installed';
  END IF;
  IF canonical_oid IS NOT NULL THEN
    SELECT pg_get_functiondef(canonical_oid) INTO canonical_definition;
    IF position(
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
      RAISE EXCEPTION 'expiry-v2 canonical enterprise absorb routing missing';
    END IF;
    SELECT pg_get_functiondef(guard_oid) INTO canonical_definition;
    IF position(
      'balance_enterprise_absorb_active_allocation_update_is_valid'
      IN canonical_definition
    ) = 0
    THEN
      RAISE EXCEPTION 'expiry-v2 allocation guard enterprise absorb route missing';
    END IF;
  END IF;
  SELECT pg_get_functiondef(
    'balance_enterprise_absorb_active_allocation_update_is_valid(jsonb,jsonb)'::regprocedure
  ) INTO canonical_definition;
  IF position('source_snapshot = target_before_snapshot' IN canonical_definition) = 0
    OR position(
      'allocation_repair."before_snapshot" = target_before_snapshot'
      IN canonical_definition
    ) = 0
    OR position(
      'allocation_repair."after_snapshot" = target_after_snapshot'
      IN canonical_definition
    ) = 0
  THEN
    RAISE EXCEPTION 'enterprise absorb active allocation proof is not exact';
  END IF;

  SELECT array_agg(expected.name ORDER BY expected.name) INTO missing_triggers
  FROM (VALUES
    ('balance_ledger_transfer_repairs_terminal_deferred',
      'balance_ledger_account_transfer_repairs'),
    ('balance_ledger_grant_component_repairs_insert_guard',
      'balance_ledger_grant_component_repairs'),
    ('balance_ledger_grant_component_repairs_terminal_deferred',
      'balance_ledger_grant_component_repairs'),
    ('balance_grants_enterprise_absorb_component_update_guard',
      'balance_grants')
  ) expected(name, relation_name)
  WHERE NOT EXISTS (
    SELECT 1
    FROM pg_trigger trigger_row
    JOIN pg_class relation ON relation.oid = trigger_row.tgrelid
    JOIN pg_namespace namespace ON namespace.oid = relation.relnamespace
    WHERE namespace.nspname = 'public'
      AND relation.relname = expected.relation_name
      AND trigger_row.tgname = expected.name
      AND NOT trigger_row.tgisinternal
  );
  IF missing_triggers IS NOT NULL THEN
    RAISE EXCEPTION 'enterprise absorb repair triggers missing: %', missing_triggers;
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_constraint constraint_row
    WHERE constraint_row.conrelid =
      'public.balance_ledger_grant_creation_repairs'::regclass
      AND constraint_row.contype = 'f'
      AND pg_get_constraintdef(constraint_row.oid)
        LIKE '%(balance_grant_id)%balance_grants%'
  ) THEN
    RAISE EXCEPTION 'grant creation proof must remain insert-before-grant (no grant FK)';
  END IF;

  IF NOT EXISTS (
    SELECT 1
    FROM pg_trigger trigger_row
    WHERE trigger_row.tgrelid =
      'public.balance_ledger_account_transfer_repairs'::regclass
      AND trigger_row.tgname =
        'balance_ledger_transfer_repairs_terminal_deferred'
      AND trigger_row.tgdeferrable
      AND trigger_row.tginitdeferred
  ) OR NOT EXISTS (
    SELECT 1
    FROM pg_trigger trigger_row
    WHERE trigger_row.tgrelid =
      'public.balance_ledger_grant_component_repairs'::regclass
      AND trigger_row.tgname =
        'balance_ledger_grant_component_repairs_terminal_deferred'
      AND trigger_row.tgdeferrable
      AND trigger_row.tginitdeferred
  ) THEN
    RAISE EXCEPTION 'enterprise absorb terminal triggers must be initially deferred';
  END IF;
END
$$;
