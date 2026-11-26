DO $verify_gateway_financial_terminal_provider_evidence_decoupling$
DECLARE
  terminal_definition TEXT;
  token_definition TEXT;
  balance_authority_definition TEXT;
  receipt_definition TEXT;
  append_only_trigger_count BIGINT;
  credit_terminal_trigger_count BIGINT;
BEGIN
  SELECT pg_get_functiondef(
    'public.assert_gateway_usage_funding_terminal(text)'::regprocedure
  ) INTO terminal_definition;
  SELECT pg_get_functiondef(
    'public.assert_gateway_token_usage_terminal_pair(text)'::regprocedure
  ) INTO token_definition;
  SELECT pg_get_functiondef(
    'public.assert_gateway_balance_customer_financial_authority(text)'::regprocedure
  ) INTO balance_authority_definition;
  SELECT pg_get_functiondef(
    'public.assert_gateway_financial_receipt_terminal_pair(text)'::regprocedure
  ) INTO receipt_definition;

  IF position(
      'gateway_usage_evidence_has_current_build_authority('
      IN terminal_definition
    ) > 0
     OR position(
       'gateway_usage_evidence_has_current_build_authority('
       IN receipt_definition
     ) > 0
     OR position('financialAuthorityFingerprint' IN balance_authority_definition) > 0
     OR position('financialAuthorityFingerprint' IN receipt_definition) > 0 THEN
    RAISE EXCEPTION
      'Provider build authority still gates a customer financial terminal';
  END IF;

  IF position(
      'gateway funding reservation terminal anchor binding is invalid'
      IN terminal_definition
    ) = 0
     OR position(
       'selected_evidence."evidence_hash" = receipt."evidence_hash"'
       IN terminal_definition
     ) = 0
     OR position(
       'gateway consumed reservation is not canonical wallet tail'
       IN terminal_definition
     ) = 0
     OR position(
       'gateway consumed reservation allocation proof is inconsistent'
       IN terminal_definition
     ) = 0
     OR position(
       'gateway consumed reservation did not consume frozen grant prefix'
       IN terminal_definition
     ) = 0
     OR position(
       'gateway_permanent_no_charge_reason(selected_evidence."raw_evidence")'
       IN terminal_definition
     ) = 0
     OR position(
       'gateway-settlement-v3-customer-authority'
       IN terminal_definition
     ) = 0
     OR position(
       'gateway-settlement-v3-customer-authority'
       IN token_definition
     ) = 0
     OR position(
       'PERFORM assert_gateway_token_usage_terminal_pair(usage."id");'
       IN receipt_definition
     ) = 0
     OR position(
       'PERFORM assert_gateway_balance_customer_financial_authority(receipt."id");'
       IN receipt_definition
     ) = 0
     OR position(
       'gateway-customer-financial-authority-v1'
       IN balance_authority_definition
     ) = 0
     OR position(
       'gateway-settlement-v3-customer-authority'
       IN balance_authority_definition
     ) = 0
     OR position(
       'gateway BALANCE canonical financial authority is inconsistent'
       IN balance_authority_definition
     ) = 0
     OR position(
       'authority->>''settledCustomerAmount'''
       IN balance_authority_definition
     ) = 0
     OR position(
       'reservation."authoritative_amount_usd"'
       IN balance_authority_definition
     ) = 0
     OR position(
       'FROM "balance_transactions" AS tx'
       IN balance_authority_definition
     ) = 0
     OR position(
       'usage."customer_funding_classification_complete" IS DISTINCT FROM TRUE'
       IN receipt_definition
     ) = 0
     OR position(
       'customer_settlement#>>''{originalDimensions,inputTokens}'''
       IN receipt_definition
     ) = 0
     OR position(
       'customer_settlement#>>''{settledDimensions,inputTokens}'''
       IN receipt_definition
     ) = 0
     OR position(
       'customer_settlement#>>''{originalDimensions,imageCount}'''
       IN receipt_definition
     ) = 0
     OR position(
       'customer_settlement#>>''{settledDimensions,imageCount}'''
       IN receipt_definition
     ) = 0
     OR position(
       'receipt."payload"->''customerFinancialAuthority'''
       IN receipt_definition
     ) = 0
     OR position(
       'gateway-customer-financial-authority-v1'
       IN receipt_definition
     ) = 0
     OR position(
       'gateway-settlement-v3-customer-authority'
       IN receipt_definition
     ) = 0
     OR position(
       'gateway legacy v2 CREDITS receipt proof is inconsistent'
       IN receipt_definition
     ) = 0
     OR position(
       'original_customer_amount IS DISTINCT FROM anchor_credit_amount'
       IN receipt_definition
     ) = 0
     OR position(
       'settled_customer_charge_usd IS DISTINCT FROM usage."customer_charge_usd"'
       IN receipt_definition
     ) = 0
     OR position(
       'gateway CREDITS canonical financial authority is inconsistent'
       IN receipt_definition
     ) = 0
     OR position(
       'gateway positive CREDITS mutation proof is inconsistent'
       IN receipt_definition
     ) = 0
     OR position(
       'gateway zero-priced CREDITS proof is inconsistent'
       IN receipt_definition
     ) = 0
     OR position(
       'gateway included-upstream CREDITS proof is inconsistent'
       IN receipt_definition
     ) = 0
     OR position(
       'gateway CREDITS DEBT_OPEN receipt proof is inconsistent'
       IN receipt_definition
     ) = 0
     OR position(
       '''gateway:credits:'' || receipt."request_id" || '':'' || receipt."anchor_hash"'
       IN receipt_definition
     ) = 0
     THEN
    RAISE EXCEPTION
      'Gateway customer financial terminal proof was weakened unexpectedly';
  END IF;

  -- The evidence remains immutable. This migration changes only whether the
  -- selected producer build is current at financial commit time.
  SELECT COUNT(*) INTO append_only_trigger_count
  FROM pg_trigger AS trigger_row
  JOIN pg_class AS relation_row ON relation_row.oid = trigger_row.tgrelid
  JOIN pg_namespace AS namespace_row ON namespace_row.oid = relation_row.relnamespace
  WHERE namespace_row.nspname = 'public'
    AND relation_row.relname = 'gateway_usage_evidences'
    AND trigger_row.tgname IN (
      'gateway_usage_evidences_append_only',
      'gateway_usage_evidences_freeze_build_authorization'
    )
    AND NOT trigger_row.tgisinternal
    AND trigger_row.tgenabled IN ('O', 'A')
    AND (
      (
        trigger_row.tgname = 'gateway_usage_evidences_append_only'
        AND trigger_row.tgfoid =
          'public.reject_gateway_settlement_append_only_mutation()'::regprocedure
        AND (trigger_row.tgtype & 1) = 1   -- ROW
        AND (trigger_row.tgtype & 2) = 2   -- BEFORE
        AND (trigger_row.tgtype & 4) = 0   -- not INSERT
        AND (trigger_row.tgtype & 8) = 8   -- DELETE
        AND (trigger_row.tgtype & 16) = 16 -- UPDATE
        AND (trigger_row.tgtype & 32) = 0  -- not TRUNCATE
        AND (trigger_row.tgtype & 64) = 0  -- not INSTEAD OF
      )
      OR
      (
        trigger_row.tgname = 'gateway_usage_evidences_freeze_build_authorization'
        AND trigger_row.tgfoid =
          'public.freeze_gateway_usage_evidence_build_authorization()'::regprocedure
        AND (trigger_row.tgtype & 1) = 1   -- ROW
        AND (trigger_row.tgtype & 2) = 2   -- BEFORE
        AND (trigger_row.tgtype & 4) = 4   -- INSERT
        AND (trigger_row.tgtype & 8) = 0   -- not DELETE
        AND (trigger_row.tgtype & 16) = 0  -- not UPDATE
        AND (trigger_row.tgtype & 32) = 0  -- not TRUNCATE
        AND (trigger_row.tgtype & 64) = 0  -- not INSTEAD OF
      )
    );

  IF append_only_trigger_count <> 2 THEN
    RAISE EXCEPTION
      'Gateway append-only/build-authorization evidence triggers are not intact';
  END IF;

  SELECT COUNT(*) INTO credit_terminal_trigger_count
  FROM pg_trigger AS trigger_row
  JOIN pg_class AS relation_row ON relation_row.oid = trigger_row.tgrelid
  JOIN pg_namespace AS namespace_row ON namespace_row.oid = relation_row.relnamespace
  WHERE namespace_row.nspname = 'public'
    AND relation_row.relname = 'credit_transactions'
    AND trigger_row.tgname = 'credit_transactions_gateway_terminal_pairs'
    AND NOT trigger_row.tgisinternal
    AND trigger_row.tgenabled IN ('O', 'A')
    AND trigger_row.tgfoid =
      'public.validate_gateway_credit_transaction_terminal_pairs_trigger()'::regprocedure
    AND trigger_row.tgconstraint <> 0
    AND trigger_row.tgdeferrable
    AND trigger_row.tginitdeferred
    AND (trigger_row.tgtype & 1) = 1
    AND (trigger_row.tgtype & 2) = 0
    AND (trigger_row.tgtype & 4) = 4
    AND (trigger_row.tgtype & 8) = 8
    AND (trigger_row.tgtype & 16) = 16
    AND (trigger_row.tgtype & 32) = 0
    AND (trigger_row.tgtype & 64) = 0;
  IF credit_terminal_trigger_count <> 1 THEN
    RAISE EXCEPTION 'Gateway CREDITS transaction reverse-proof trigger is not intact';
  END IF;

  IF to_regprocedure(
      'public.gateway_usage_evidence_has_current_build_authority(text,text,text)'
    ) IS NULL THEN
    RAISE EXCEPTION
      'Provider build authority audit function was removed instead of decoupled';
  END IF;
END;
$verify_gateway_financial_terminal_provider_evidence_decoupling$;
