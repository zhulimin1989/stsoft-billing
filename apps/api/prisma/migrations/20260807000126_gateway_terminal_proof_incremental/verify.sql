DO $$
DECLARE
  terminal_definition TEXT;
  token_definition TEXT;
  receipt_definition TEXT;
  canonical_definition TEXT;
  routed_trigger_count BIGINT;
BEGIN
  SELECT pg_get_functiondef(
    'public.assert_gateway_usage_funding_terminal(text)'::regprocedure
  ) INTO terminal_definition;
  SELECT pg_get_functiondef(
    'public.assert_gateway_token_usage_terminal_pair(text)'::regprocedure
  ) INTO token_definition;
  SELECT pg_get_functiondef(
    'public.assert_gateway_financial_receipt_terminal_pair(text)'::regprocedure
  ) INTO receipt_definition;
  SELECT pg_get_functiondef(
    'public.assert_clean_account_wallet_canonical_deferred()'::regprocedure
  ) INTO canonical_definition;

  IF position('assert_balance_transaction_unique_wallet_path' IN terminal_definition) > 0
    OR position('assert_balance_allocation_sequence_order' IN terminal_definition) > 0
    OR position('assert_gateway_balance_ledger_v2_contract' IN terminal_definition) > 0
    OR position('gateway consumed reservation is not canonical wallet tail' IN terminal_definition) = 0
    OR position('gateway consumed reservation allocation proof is inconsistent' IN terminal_definition) = 0
  THEN
    RAISE EXCEPTION 'Gateway reservation proof is not bounded to the current request';
  END IF;

  IF position('PERFORM assert_gateway_usage_funding_terminal' IN token_definition) > 0
    OR position('gateway BALANCE TokenUsage requires consumed reservation' IN token_definition) = 0
    OR position('PERFORM assert_gateway_usage_funding_terminal' IN receipt_definition) > 0
    OR position('gateway CREDITS receipt proof is inconsistent' IN receipt_definition) = 0
  THEN
    RAISE EXCEPTION 'Gateway proof ownership is not reservation/BALANCE and receipt/CREDITS';
  END IF;

  IF position(
      'gateway_balance_canonical_mutation_is_current_settlement'
      IN canonical_definition
    ) = 0
  THEN
    RAISE EXCEPTION 'Release-B canonical validator lacks Gateway row-local fast path';
  END IF;

  SELECT COUNT(*) INTO routed_trigger_count
  FROM pg_trigger trigger_row
  JOIN pg_proc function_row ON function_row.oid = trigger_row.tgfoid
  JOIN pg_class relation_row ON relation_row.oid = trigger_row.tgrelid
  JOIN pg_namespace namespace_row ON namespace_row.oid = relation_row.relnamespace
  WHERE namespace_row.nspname = 'public'
    AND NOT trigger_row.tgisinternal
    AND trigger_row.tgname IN (
      'gateway_usage_funding_reservations_terminal_proof',
      'token_usage_gateway_terminal_pair',
      'gateway_usage_settlement_receipts_terminal_pair'
    )
    AND trigger_row.tgdeferrable
    AND trigger_row.tginitdeferred
    AND (
      (trigger_row.tgname = 'gateway_usage_funding_reservations_terminal_proof'
        AND position('assert_gateway_usage_funding_terminal' IN pg_get_functiondef(function_row.oid)) > 0)
      OR (trigger_row.tgname = 'token_usage_gateway_terminal_pair'
        AND position('assert_gateway_token_usage_terminal_pair' IN pg_get_functiondef(function_row.oid)) > 0)
      OR (trigger_row.tgname = 'gateway_usage_settlement_receipts_terminal_pair'
        AND position('assert_gateway_financial_receipt_terminal_pair' IN pg_get_functiondef(function_row.oid)) > 0)
    );

  IF routed_trigger_count <> 3 THEN
    RAISE EXCEPTION 'Gateway terminal proof owners are not wired to all three deferred entries: %',
      routed_trigger_count;
  END IF;

  PERFORM assert_gateway_balance_ledger_v2_contract();
END;
$$;
