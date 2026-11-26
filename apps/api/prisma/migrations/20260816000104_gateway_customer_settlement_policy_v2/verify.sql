DO $verify_gateway_customer_settlement_policy_v2$
DECLARE
  balance_definition TEXT;
  credits_definition TEXT;
  anchor_policy_constraint_definition TEXT;
  terminal_trigger_count BIGINT;
BEGIN
  SELECT pg_get_functiondef(
    'public.assert_gateway_balance_customer_financial_authority(text)'::regprocedure
  ) INTO balance_definition;
  SELECT pg_get_functiondef(
    'public.assert_gateway_financial_receipt_terminal_pair(text)'::regprocedure
  ) INTO credits_definition;

  SELECT pg_get_expr(constraint_row.conbin, constraint_row.conrelid, FALSE)
  INTO anchor_policy_constraint_definition
  FROM pg_constraint AS constraint_row
  WHERE constraint_row.conrelid =
      'public.gateway_usage_settlement_anchors'::regclass
    AND constraint_row.conname =
      'gateway_usage_settlement_anchors_customer_policy_v2_check'
    AND constraint_row.contype = 'c';

  IF anchor_policy_constraint_definition IS NULL THEN
    RAISE EXCEPTION 'Gateway anchor v2 policy constraint is missing';
  END IF;

  IF btrim(anchor_policy_constraint_definition) IS DISTINCT FROM
    '(NOT ((canonical_payload ->> ''customerSettlementPolicyVersion''::text) '
      || 'IS DISTINCT FROM ''gateway-customer-settlement-v2''::text))' THEN
    RAISE EXCEPTION 'Gateway anchor v2 policy constraint is incomplete';
  END IF;

  IF position('customerSettlementPolicyVersion' IN balance_definition) = 0
     OR position('gateway-customer-settlement-v2' IN balance_definition) = 0
     OR position('gateway-customer-settlement-v1' IN balance_definition) > 0
     OR position('ZERO_PRICED_OMITTED_DIMENSION' IN balance_definition) > 0
     OR position('NORMALIZED_EXACT' IN balance_definition) = 0
     OR position('CUSTOMER_PROTECTIVE_ZERO' IN balance_definition) = 0
     OR position(
       'settled_amount IS DISTINCT FROM reservation."authoritative_amount_usd"'
       IN balance_definition
     ) = 0
     OR position(
       'gateway BALANCE canonical financial authority is inconsistent'
       IN balance_definition
     ) = 0 THEN
    RAISE EXCEPTION 'Gateway BALANCE settlement-policy proof is incomplete';
  END IF;

  IF position('customerSettlementPolicyVersion' IN credits_definition) = 0
     OR position('gateway-customer-settlement-v2' IN credits_definition) = 0
     OR position('gateway-customer-settlement-v1' IN credits_definition) > 0
     OR position('ZERO_PRICED_OMITTED_DIMENSION' IN credits_definition) > 0
     OR position('NORMALIZED_EXACT' IN credits_definition) = 0
     OR position('CUSTOMER_PROTECTIVE_ZERO' IN credits_definition) = 0
     OR position(
       'PERFORM assert_gateway_balance_customer_financial_authority(receipt."id");'
       IN credits_definition
     ) = 0
     OR position(
       'gateway CREDITS canonical financial authority is inconsistent'
       IN credits_definition
     ) = 0 THEN
    RAISE EXCEPTION 'Gateway CREDITS settlement-policy proof is incomplete';
  END IF;

  SELECT COUNT(*) INTO terminal_trigger_count
  FROM pg_trigger AS trigger_row
  JOIN pg_class AS relation_row ON relation_row.oid = trigger_row.tgrelid
  JOIN pg_namespace AS namespace_row ON namespace_row.oid = relation_row.relnamespace
  WHERE namespace_row.nspname = 'public'
    AND NOT trigger_row.tgisinternal
    AND trigger_row.tgenabled IN ('O', 'A')
    AND trigger_row.tgconstraint <> 0
    AND trigger_row.tgdeferrable
    AND trigger_row.tginitdeferred
    AND (
      (
        relation_row.relname = 'gateway_usage_settlement_receipts'
        AND trigger_row.tgname = 'gateway_usage_settlement_receipts_terminal_pair'
        AND trigger_row.tgfoid =
          'public.validate_gateway_financial_receipt_terminal_pair_trigger()'::regprocedure
      )
      OR (
        relation_row.relname = 'credit_transactions'
        AND trigger_row.tgname = 'credit_transactions_gateway_terminal_pairs'
        AND trigger_row.tgfoid =
          'public.validate_gateway_credit_transaction_terminal_pairs_trigger()'::regprocedure
      )
    );
  IF terminal_trigger_count <> 2 THEN
    RAISE EXCEPTION 'Gateway financial terminal constraint triggers are not intact';
  END IF;
END;
$verify_gateway_customer_settlement_policy_v2$;
