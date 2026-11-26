-- New first receipts use customer settlement policy v2. Existing anchors are
-- neither scanned nor rewritten: the NOT VALID constraint rejects every new
-- NULL/v1 anchor immediately, while historical validation remains a separate,
-- explicitly planned maintenance operation. Permanent financial proofs accept
-- v2 exclusively.

BEGIN;

DO $upgrade_gateway_balance_customer_settlement_policy_v2$
DECLARE
  target_signature CONSTANT TEXT :=
    'public.assert_gateway_balance_customer_financial_authority(text)';
  legacy_policy_contract CONSTANT TEXT := $balance_legacy_policy_contract$
     OR authority->>'policyVersion'
          IS DISTINCT FROM 'gateway-customer-settlement-v1'
     OR COALESCE(basis IN (
       'NORMALIZED_EXACT',
       'ZERO_PRICED_OMITTED_DIMENSION',
       'CUSTOMER_PROTECTIVE_ZERO'
     ), FALSE) IS DISTINCT FROM TRUE
$balance_legacy_policy_contract$;
  current_policy_contract CONSTANT TEXT := $balance_current_policy_contract$
     OR authority->>'policyVersion'
          IS DISTINCT FROM 'gateway-customer-settlement-v2'
     OR anchor."canonical_payload"->>'customerSettlementPolicyVersion'
          IS DISTINCT FROM 'gateway-customer-settlement-v2'
     OR authority->>'policyVersion' IS DISTINCT FROM
       anchor."canonical_payload"->>'customerSettlementPolicyVersion'
     OR COALESCE(basis IN (
       'NORMALIZED_EXACT',
       'CUSTOMER_PROTECTIVE_ZERO'
     ), FALSE) IS DISTINCT FROM TRUE
$balance_current_policy_contract$;
  legacy_exact_basis_contract CONSTANT TEXT := $balance_legacy_exact_basis_contract$
     OR (basis IN ('NORMALIZED_EXACT', 'ZERO_PRICED_OMITTED_DIMENSION') AND (
$balance_legacy_exact_basis_contract$;
  current_exact_basis_contract CONSTANT TEXT := $balance_current_exact_basis_contract$
     OR (basis = 'NORMALIZED_EXACT' AND (
$balance_current_exact_basis_contract$;
  target_oid OID;
  target_owner OID;
  target_acl ACLITEM[];
  terminal_oid OID;
  terminal_owner OID;
  terminal_acl ACLITEM[];
  function_definition TEXT;
  patched_definition TEXT;
  required_marker TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(60816, hashtext(target_signature));
  SELECT function_row.oid, function_row.proowner, function_row.proacl,
    pg_get_functiondef(function_row.oid)
  INTO target_oid, target_owner, target_acl, function_definition
  FROM pg_proc AS function_row
  WHERE function_row.oid = to_regprocedure(target_signature)::OID;

  IF target_oid IS NULL
     OR char_length(function_definition)
        - char_length(replace(function_definition, legacy_policy_contract, ''))
        IS DISTINCT FROM char_length(legacy_policy_contract)
     OR char_length(function_definition)
        - char_length(replace(function_definition, legacy_exact_basis_contract, ''))
        IS DISTINCT FROM char_length(legacy_exact_basis_contract) THEN
    RAISE EXCEPTION
      'Gateway BALANCE authority proof does not match the required v1 policy contract';
  END IF;

  FOREACH required_marker IN ARRAY ARRAY[
    'reservation."status" IS DISTINCT FROM ''CONSUMED''',
    'authority->>''settlementFingerprint''',
    'settled_amount IS DISTINCT FROM reservation."authoritative_amount_usd"',
    'settled_charge IS DISTINCT FROM usage."customer_charge_usd"',
    'FROM "balance_transactions" AS tx',
    'FROM "balance_consumption_allocations" AS allocation',
    'gateway BALANCE canonical financial authority is inconsistent'
  ] LOOP
    IF position(required_marker IN function_definition) = 0 THEN
      RAISE EXCEPTION
        'Gateway BALANCE authority proof lost required marker: %', required_marker;
    END IF;
  END LOOP;

  patched_definition := replace(
    replace(
      function_definition,
      legacy_policy_contract,
      current_policy_contract
    ),
    legacy_exact_basis_contract,
    current_exact_basis_contract
  );
  IF position(legacy_policy_contract IN patched_definition) > 0
     OR position(current_policy_contract IN patched_definition) = 0
     OR position(legacy_exact_basis_contract IN patched_definition) > 0
     OR position(current_exact_basis_contract IN patched_definition) = 0
     OR position('customerSettlementPolicyVersion' IN patched_definition) = 0
     OR position('gateway-customer-settlement-v2' IN patched_definition) = 0
     OR position('gateway-customer-settlement-v1' IN patched_definition) > 0
     OR position('ZERO_PRICED_OMITTED_DIMENSION' IN patched_definition) > 0 THEN
    RAISE EXCEPTION 'Gateway BALANCE settlement-policy proof rewrite is incomplete';
  END IF;

  EXECUTE patched_definition;

  SELECT function_row.oid, function_row.proowner, function_row.proacl,
    pg_get_functiondef(function_row.oid)
  INTO terminal_oid, terminal_owner, terminal_acl, function_definition
  FROM pg_proc AS function_row
  WHERE function_row.oid = to_regprocedure(target_signature)::OID;
  IF terminal_oid IS DISTINCT FROM target_oid
     OR terminal_owner IS DISTINCT FROM target_owner
     OR terminal_acl IS DISTINCT FROM target_acl
     OR position(current_policy_contract IN function_definition) = 0
     OR position(current_exact_basis_contract IN function_definition) = 0
     OR position('gateway-customer-settlement-v1' IN function_definition) > 0
     OR position('ZERO_PRICED_OMITTED_DIMENSION' IN function_definition) > 0 THEN
    RAISE EXCEPTION
      'Gateway BALANCE settlement-policy proof terminal identity check failed';
  END IF;
END;
$upgrade_gateway_balance_customer_settlement_policy_v2$;

DO $upgrade_gateway_credits_customer_settlement_policy_v2$
DECLARE
  target_signature CONSTANT TEXT :=
    'public.assert_gateway_financial_receipt_terminal_pair(text)';
  legacy_policy_contract CONSTANT TEXT := $credits_legacy_policy_contract$
     OR customer_settlement->>'policyVersion'
          IS DISTINCT FROM 'gateway-customer-settlement-v1'
     OR COALESCE(customer_settlement->>'basis' IN (
       'NORMALIZED_EXACT',
       'ZERO_PRICED_OMITTED_DIMENSION',
       'CUSTOMER_PROTECTIVE_ZERO'
     ), FALSE) IS DISTINCT FROM TRUE
$credits_legacy_policy_contract$;
  current_policy_contract CONSTANT TEXT := $credits_current_policy_contract$
     OR customer_settlement->>'policyVersion'
          IS DISTINCT FROM 'gateway-customer-settlement-v2'
     OR anchor."canonical_payload"->>'customerSettlementPolicyVersion'
          IS DISTINCT FROM 'gateway-customer-settlement-v2'
     OR customer_settlement->>'policyVersion' IS DISTINCT FROM
       anchor."canonical_payload"->>'customerSettlementPolicyVersion'
     OR COALESCE(customer_settlement->>'basis' IN (
       'NORMALIZED_EXACT',
       'CUSTOMER_PROTECTIVE_ZERO'
     ), FALSE) IS DISTINCT FROM TRUE
$credits_current_policy_contract$;
  legacy_exact_basis_contract CONSTANT TEXT := $credits_legacy_exact_basis_contract$
       settlement_basis IN ('NORMALIZED_EXACT', 'ZERO_PRICED_OMITTED_DIMENSION')
$credits_legacy_exact_basis_contract$;
  current_exact_basis_contract CONSTANT TEXT := $credits_current_exact_basis_contract$
       settlement_basis = 'NORMALIZED_EXACT'
$credits_current_exact_basis_contract$;
  target_oid OID;
  target_owner OID;
  target_acl ACLITEM[];
  terminal_oid OID;
  terminal_owner OID;
  terminal_acl ACLITEM[];
  function_definition TEXT;
  patched_definition TEXT;
  required_marker TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(60816, hashtext(target_signature));
  SELECT function_row.oid, function_row.proowner, function_row.proacl,
    pg_get_functiondef(function_row.oid)
  INTO target_oid, target_owner, target_acl, function_definition
  FROM pg_proc AS function_row
  WHERE function_row.oid = to_regprocedure(target_signature)::OID;

  IF target_oid IS NULL
     OR char_length(function_definition)
        - char_length(replace(function_definition, legacy_policy_contract, ''))
        IS DISTINCT FROM char_length(legacy_policy_contract)
     OR char_length(function_definition)
        - char_length(replace(function_definition, legacy_exact_basis_contract, ''))
        IS DISTINCT FROM 2 * char_length(legacy_exact_basis_contract) THEN
    RAISE EXCEPTION
      'Gateway CREDITS receipt proof does not match the required v1 policy contract';
  END IF;

  FOREACH required_marker IN ARRAY ARRAY[
    'PERFORM assert_gateway_token_usage_terminal_pair(usage."id");',
    'PERFORM assert_gateway_balance_customer_financial_authority(receipt."id");',
    'customer_settlement->>''settlementFingerprint''',
    'settled_customer_charge_usd IS DISTINCT FROM usage."customer_charge_usd"',
    'gateway positive CREDITS mutation proof is inconsistent',
    'gateway zero-priced CREDITS proof is inconsistent',
    'gateway included-upstream CREDITS proof is inconsistent',
    'gateway CREDITS DEBT_OPEN receipt proof is inconsistent'
  ] LOOP
    IF position(required_marker IN function_definition) = 0 THEN
      RAISE EXCEPTION
        'Gateway CREDITS receipt proof lost required marker: %', required_marker;
    END IF;
  END LOOP;

  patched_definition := replace(
    replace(
      function_definition,
      legacy_policy_contract,
      current_policy_contract
    ),
    legacy_exact_basis_contract,
    current_exact_basis_contract
  );
  IF position(legacy_policy_contract IN patched_definition) > 0
     OR position(current_policy_contract IN patched_definition) = 0
     OR position(legacy_exact_basis_contract IN patched_definition) > 0
     OR position(current_exact_basis_contract IN patched_definition) = 0
     OR position('customerSettlementPolicyVersion' IN patched_definition) = 0
     OR position('gateway-customer-settlement-v2' IN patched_definition) = 0
     OR position('gateway-customer-settlement-v1' IN patched_definition) > 0
     OR position('ZERO_PRICED_OMITTED_DIMENSION' IN patched_definition) > 0 THEN
    RAISE EXCEPTION 'Gateway CREDITS settlement-policy proof rewrite is incomplete';
  END IF;

  EXECUTE patched_definition;

  SELECT function_row.oid, function_row.proowner, function_row.proacl,
    pg_get_functiondef(function_row.oid)
  INTO terminal_oid, terminal_owner, terminal_acl, function_definition
  FROM pg_proc AS function_row
  WHERE function_row.oid = to_regprocedure(target_signature)::OID;
  IF terminal_oid IS DISTINCT FROM target_oid
     OR terminal_owner IS DISTINCT FROM target_owner
     OR terminal_acl IS DISTINCT FROM target_acl
     OR position(current_policy_contract IN function_definition) = 0
     OR position(current_exact_basis_contract IN function_definition) = 0
     OR position('gateway-customer-settlement-v1' IN function_definition) > 0
     OR position('ZERO_PRICED_OMITTED_DIMENSION' IN function_definition) > 0 THEN
    RAISE EXCEPTION
      'Gateway CREDITS settlement-policy proof terminal identity check failed';
  END IF;
END;
$upgrade_gateway_credits_customer_settlement_policy_v2$;

-- Add the NOT VALID table-level gate last and commit immediately. PostgreSQL
-- enforces it for every new row without scanning historical anchors, keeping
-- the AccessExclusiveLock window independent of table size.
ALTER TABLE "gateway_usage_settlement_anchors"
  ADD CONSTRAINT "gateway_usage_settlement_anchors_customer_policy_v2_check"
  CHECK (
    ("canonical_payload"->>'customerSettlementPolicyVersion')
      IS NOT DISTINCT FROM 'gateway-customer-settlement-v2'
  ) NOT VALID;

COMMIT;
