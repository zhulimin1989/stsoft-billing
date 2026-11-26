-- Read-only proof for the one recoverable PostgreSQL 18 failure state.
--
-- The original migration reached its final catalog verifier, passed the
-- column/table and index fingerprints, then failed because PostgreSQL 18 adds
-- table-column NOT NULL rows (contype = 'n') to pg_constraint. This verifier
-- proves every catalog section that comes after that failure point as well as
-- the exact Prisma attempt and absence of a durable rollout marker.
DO $verify$
DECLARE
  actual_count BIGINT;
  actual_fingerprint TEXT;
  all_constraint_count BIGINT;
  all_constraint_fingerprint TEXT;
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
    'rotate_balance_ledger_database_identity'
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
  IF current_setting('server_version_num')::INTEGER / 10000 <> 18 THEN
    RAISE EXCEPTION 'PG18 recovery rehearsal requires PostgreSQL 18, got %',
      current_setting('server_version')
      USING ERRCODE = '55000';
  END IF;

  SELECT COUNT(*)
    INTO actual_count
  FROM "_prisma_migrations"
  WHERE "migration_name" =
    '20260715000100_personal_negative_balance_settlement';
  IF actual_count <> 1 THEN
    RAISE EXCEPTION 'expected exactly one total target attempt, got %',
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
    AND "rolled_back_at" IS NULL
    AND "applied_steps_count" = 0;
  IF actual_count <> 1 THEN
    RAISE EXCEPTION 'unexpected failed old-checksum attempt count=%', actual_count
      USING ERRCODE = '55000';
  END IF;

  SELECT COUNT(*)
    INTO actual_count
  FROM "_prisma_migrations"
  WHERE "finished_at" IS NULL
    AND "rolled_back_at" IS NULL;
  IF actual_count <> 1 THEN
    RAISE EXCEPTION 'unexpected open migration attempt count=%', actual_count
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (SELECT 1 FROM "balance_ledger_rollout_control")
    OR EXISTS (SELECT 1 FROM "balance_ledger_rollout_transitions")
    OR EXISTS (SELECT 1 FROM "balance_ledger_database_identity_rotations")
  THEN
    RAISE EXCEPTION 'partial state already contains a durable rollout marker'
      USING ERRCODE = '55000';
  END IF;

  IF EXISTS (
    SELECT 1
    FROM pg_proc procedure_row
    JOIN pg_namespace namespace_row
      ON namespace_row.oid = procedure_row.pronamespace
    WHERE namespace_row.nspname = 'public'
      AND procedure_row.proname = 'prepare_balance_ledger_v2_contract'
  ) THEN
    RAISE EXCEPTION 'partial state unexpectedly contains prepare function'
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
      'unexpected partial column/table state count=% fingerprint=%',
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
      'unexpected partial index state count=% fingerprint=%',
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
    )),
    COUNT(*) FILTER (WHERE contype <> 'n'),
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
    ) FILTER (WHERE contype <> 'n'))
  INTO
    all_constraint_count,
    all_constraint_fingerprint,
    actual_count,
    actual_fingerprint
  FROM actual;
  IF all_constraint_count <> 158
    OR all_constraint_fingerprint <>
      '9b9c2b694396bc38366c981f150dd883'
    OR actual_count <> 58
    OR actual_fingerprint <> 'f4db5b9cdda51b5472adf28bb6b87bf9'
  THEN
    RAISE EXCEPTION
      'unexpected PG18 constraint state all=%/% portable=%/%',
      all_constraint_count,
      COALESCE(all_constraint_fingerprint, 'NULL'),
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
  IF actual_count <> 44
    OR actual_fingerprint <> '648193b14237e0048684c89c9bc8a3e8'
  THEN
    RAISE EXCEPTION
      'unexpected partial function state count=% fingerprint=%',
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
      'unexpected partial trigger state count=% fingerprint=%',
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
      'unexpected partial sequence state count=% fingerprint=%',
      actual_count,
      COALESCE(actual_fingerprint, 'NULL')
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
    RAISE EXCEPTION 'partial state contains % strict trigger(s)', actual_count
      USING ERRCODE = '55000';
  END IF;
END
$verify$;
