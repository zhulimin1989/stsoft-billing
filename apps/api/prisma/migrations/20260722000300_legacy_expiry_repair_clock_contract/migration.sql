-- A proof-backed legacy expiry is replayed long after its historical ADJUST.
-- The online expiry aggregate originally compared the current wallet/tail to
-- grants that were active at that historical timestamp.  A legitimate grant
-- written after the legacy expiry was therefore excluded from active funds and
-- simultaneously counted as invalid.  Keep the online path unchanged, but use
-- the locked repair reconciliation clock for a terminal legacy-expiry proof.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

DO $upgrade_legacy_expiry_repair_clock$
DECLARE
  function_oid OID;
  function_source TEXT;
  rewritten_source TEXT;
  match_count BIGINT;
  legacy_valid_count_before BIGINT;
  declaration_anchor TEXT := $anchor$  legacy_expiry_valid BOOLEAN;
BEGIN
$anchor$;
  declaration_replacement TEXT := $replacement$  legacy_expiry_valid BOOLEAN;
  grant_validation_at TIMESTAMP(3);
BEGIN
$replacement$;
  clock_anchor TEXT := $anchor$  legacy_expiry_valid := "balance_ledger_legacy_expiry_proof_is_valid"(
    target_grant_id,
    expiry_row."balance_transaction_id",
    expiry_row."billing_account_id",
    NULL
  );

  SELECT "balance_usd" INTO wallet_balance
$anchor$;
  clock_replacement TEXT := $replacement$  legacy_expiry_valid := "balance_ledger_legacy_expiry_proof_is_valid"(
    target_grant_id,
    expiry_row."balance_transaction_id",
    expiry_row."billing_account_id",
    NULL
  );
  grant_validation_at := CASE
    WHEN legacy_expiry_valid
      THEN account_row."balance_grant_ledger_reconciled_at"
    ELSE expiry_row."created_at"
  END;
  IF grant_validation_at IS NULL THEN
    RAISE EXCEPTION
      'balance grant expiry validation clock missing grant=% account=% legacy=%',
      target_grant_id, expiry_row."billing_account_id", legacy_expiry_valid
      USING ERRCODE = '23514';
  END IF;

  SELECT "balance_usd" INTO wallet_balance
$replacement$;
  active_clock_anchor TEXT := $anchor$      WHERE NOT "is_expired"
        AND "valid_from" <= expiry_row."created_at"
$anchor$;
  active_clock_replacement TEXT := $replacement$      WHERE NOT "is_expired"
        AND "valid_from" <= grant_validation_at
$replacement$;
  invalid_clock_anchor TEXT := $anchor$        OR "valid_from" > expiry_row."created_at"
$anchor$;
  invalid_clock_replacement TEXT := $replacement$        OR "valid_from" > grant_validation_at
$replacement$;
  operation_contract_anchor TEXT := $anchor$    OR (
      transaction_row."operation_key"
        IS DISTINCT FROM ('balance:grant-expiry:' || target_grant_id)
      AND NOT legacy_expiry_valid
    )
$anchor$;
  sequence_contract_anchor TEXT := $anchor$    OR transaction_row."ledger_sequence" IS NULL
    OR (
      transaction_row."ledger_sequence" <= 0
      AND NOT legacy_expiry_valid
    )
$anchor$;
BEGIN
  SELECT procedure_row.oid, procedure_row.prosrc
    INTO function_oid, function_source
  FROM pg_proc procedure_row
  JOIN pg_namespace namespace_row
    ON namespace_row.oid = procedure_row.pronamespace
  JOIN pg_language language_row
    ON language_row.oid = procedure_row.prolang
  WHERE namespace_row.nspname = 'public'
    AND procedure_row.proname = 'assert_balance_grant_expiry_aggregate'
    AND procedure_row.proargtypes = '25 25 1700 1700 1700 1114'::OIDVECTOR
    AND procedure_row.pronargs = 6
    AND procedure_row.prokind = 'f'
    AND NOT procedure_row.proretset
    AND procedure_row.prorettype = 'void'::REGTYPE
    AND language_row.lanname = 'plpgsql'
    AND procedure_row.provolatile = 'v'
    AND NOT procedure_row.prosecdef
    AND NOT procedure_row.proisstrict
    AND NOT procedure_row.proleakproof
    AND procedure_row.proparallel = 'u'
    AND procedure_row.procost = 100
    AND procedure_row.proconfig IS NULL
    AND procedure_row.prosupport = 0;
  IF function_oid IS NULL THEN
    RAISE EXCEPTION 'expiry aggregate signature/property fingerprint missing'
      USING ERRCODE = '55000';
  END IF;

  SELECT COUNT(*) INTO match_count
  FROM pg_proc procedure_row
  JOIN pg_namespace namespace_row
    ON namespace_row.oid = procedure_row.pronamespace
  WHERE namespace_row.nspname = 'public'
    AND procedure_row.proname = 'assert_balance_grant_expiry_aggregate'
    AND procedure_row.proargtypes = '25 25 1700 1700 1700 1114'::OIDVECTOR;
  legacy_valid_count_before := (
    length(function_source) - length(replace(
      function_source, 'legacy_expiry_valid', ''
    ))
  ) / length('legacy_expiry_valid');
  IF match_count <> 1
    OR legacy_valid_count_before <> 4
    OR (length(function_source) - length(replace(
      function_source, 'balance_ledger_legacy_expiry_proof_is_valid', ''
    ))) / length('balance_ledger_legacy_expiry_proof_is_valid') <> 1
    OR (length(function_source) - length(replace(
      function_source, declaration_anchor, ''
    ))) / length(declaration_anchor) <> 1
    OR (length(function_source) - length(replace(
      function_source, clock_anchor, ''
    ))) / length(clock_anchor) <> 1
    OR (length(function_source) - length(replace(
      function_source, active_clock_anchor, ''
    ))) / length(active_clock_anchor) <> 1
    OR (length(function_source) - length(replace(
      function_source, invalid_clock_anchor, ''
    ))) / length(invalid_clock_anchor) <> 1
    OR (length(function_source) - length(replace(
      function_source, operation_contract_anchor, ''
    ))) / length(operation_contract_anchor) <> 1
    OR (length(function_source) - length(replace(
      function_source, sequence_contract_anchor, ''
    ))) / length(sequence_contract_anchor) <> 1
    OR position('grant_validation_at' IN function_source) <> 0
  THEN
    RAISE EXCEPTION 'legacy expiry aggregate clock source fingerprint changed'
      USING ERRCODE = '55000';
  END IF;

  rewritten_source := replace(
    function_source, declaration_anchor, declaration_replacement
  );
  rewritten_source := replace(
    rewritten_source, clock_anchor, clock_replacement
  );
  rewritten_source := replace(
    rewritten_source, active_clock_anchor, active_clock_replacement
  );
  rewritten_source := replace(
    rewritten_source, invalid_clock_anchor, invalid_clock_replacement
  );

  IF (length(rewritten_source) - length(replace(
      rewritten_source, 'grant_validation_at', ''
    ))) / length('grant_validation_at') <> 5
    OR (length(rewritten_source) - length(replace(
      rewritten_source, 'legacy_expiry_valid', ''
    ))) / length('legacy_expiry_valid') <> 6
    OR (length(rewritten_source) - length(replace(
      rewritten_source, 'balance_ledger_legacy_expiry_proof_is_valid', ''
    ))) / length('balance_ledger_legacy_expiry_proof_is_valid') <> 1
    OR position(operation_contract_anchor IN rewritten_source) = 0
    OR position(sequence_contract_anchor IN rewritten_source) = 0
    OR position(active_clock_replacement IN rewritten_source) = 0
    OR position(invalid_clock_replacement IN rewritten_source) = 0
    OR position(active_clock_anchor IN rewritten_source) <> 0
    OR position(invalid_clock_anchor IN rewritten_source) <> 0
  THEN
    RAISE EXCEPTION 'legacy expiry aggregate clock source replacement invalid'
      USING ERRCODE = '55000';
  END IF;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.assert_balance_grant_expiry_aggregate('
      || 'target_grant_id TEXT, expected_account_id TEXT, '
      || 'expected_nominal_amount NUMERIC, expected_nominal_paid NUMERIC, '
      || 'expected_nominal_bonus NUMERIC, '
      || 'expected_expires_at TIMESTAMP(3)) '
      || 'RETURNS VOID LANGUAGE plpgsql VOLATILE CALLED ON NULL INPUT '
      || 'PARALLEL UNSAFE COST 100 AS %L',
    rewritten_source
  );

  SELECT procedure_row.prosrc INTO function_source
  FROM pg_proc procedure_row
  WHERE procedure_row.oid = function_oid;
  SELECT COUNT(*) INTO match_count
  FROM pg_proc procedure_row
  JOIN pg_language language_row
    ON language_row.oid = procedure_row.prolang
  WHERE procedure_row.oid = function_oid
    AND procedure_row.prokind = 'f'
    AND NOT procedure_row.proretset
    AND procedure_row.prorettype = 'void'::REGTYPE
    AND language_row.lanname = 'plpgsql'
    AND procedure_row.provolatile = 'v'
    AND NOT procedure_row.prosecdef
    AND NOT procedure_row.proisstrict
    AND NOT procedure_row.proleakproof
    AND procedure_row.proparallel = 'u'
    AND procedure_row.procost = 100
    AND procedure_row.proconfig IS NULL
    AND procedure_row.prosupport = 0;
  IF match_count <> 1
    OR (length(function_source) - length(replace(
      function_source, 'grant_validation_at', ''
    ))) / length('grant_validation_at') <> 5
    OR (length(function_source) - length(replace(
      function_source, 'legacy_expiry_valid', ''
    ))) / length('legacy_expiry_valid') <> 6
    OR (length(function_source) - length(replace(
      function_source, 'balance_ledger_legacy_expiry_proof_is_valid', ''
    ))) / length('balance_ledger_legacy_expiry_proof_is_valid') <> 1
    OR position(operation_contract_anchor IN function_source) = 0
    OR position(sequence_contract_anchor IN function_source) = 0
    OR position(active_clock_replacement IN function_source) = 0
    OR position(invalid_clock_replacement IN function_source) = 0
    OR position(active_clock_anchor IN function_source) <> 0
    OR position(invalid_clock_anchor IN function_source) <> 0
  THEN
    RAISE EXCEPTION 'legacy expiry aggregate clock upgrade did not verify'
      USING ERRCODE = '55000';
  END IF;
END
$upgrade_legacy_expiry_repair_clock$;

COMMIT;
