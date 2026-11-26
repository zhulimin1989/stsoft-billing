-- Provider build authority is an internal evidence-quality signal. It must not
-- decide whether an otherwise complete customer financial terminal can commit.
--
-- The BALANCE definition is accepted only when its exact removal blocks and
-- required immutable funding markers are present. CREDITS is replaced below
-- with an explicit proof of the four production terminal shapes. Together they
-- remove the three mutable "current build" authority gates from:
--   1. BALANCE / CONSUMED reservation proof;
--   2. BALANCE / NO_CHARGE release proof; and
--   3. CREDITS financial receipt proof.
--
-- Patch the installed BALANCE definition fail-closed instead of carrying
-- another large copy. Exact source blocks and required proof markers form the
-- marker contract checked before execution; a mismatch aborts the migration.
DO $decouple_gateway_funding_terminal_build_authority$
DECLARE
  terminal_definition TEXT;
  patched_definition TEXT;
  required_marker TEXT;
  balance_build_authority_gate CONSTANT TEXT := $balance_build_authority_gate$
    IF current_gateway_usage_evidence_contract_mode() IS DISTINCT FROM 'SHADOW'
       AND NOT gateway_usage_evidence_has_current_build_authority(
         reservation."gateway_billing_event_id",
         reservation."request_id",
         receipt."evidence_hash"
       ) THEN
      RAISE EXCEPTION 'gateway financial settlement build authority is not current'
        USING ERRCODE = '55000';
    END IF;

$balance_build_authority_gate$;
  no_charge_build_authority_gate CONSTANT TEXT := $no_charge_build_authority_gate$
            AND gateway_usage_evidence_has_current_build_authority(
              reservation."gateway_billing_event_id",
              reservation."request_id",
              no_charge_receipt."evidence_hash"
            )
$no_charge_build_authority_gate$;
  v2_financial_receipt_filter CONSTANT TEXT :=
    '"policy_version" = ''gateway-settlement-v2''';
  v2_v3_financial_receipt_filter CONSTANT TEXT :=
    '"policy_version" IN (''gateway-settlement-v2'', '
    || '''gateway-settlement-v3-customer-authority'')';
BEGIN
  SELECT pg_get_functiondef(
    'public.assert_gateway_usage_funding_terminal(text)'::regprocedure
  ) INTO terminal_definition;

  IF terminal_definition IS NULL
     OR char_length(terminal_definition)
        - char_length(replace(
          terminal_definition,
          balance_build_authority_gate,
          ''
        ))
        IS DISTINCT FROM char_length(balance_build_authority_gate)
     OR char_length(terminal_definition)
        - char_length(replace(
          terminal_definition,
          no_charge_build_authority_gate,
          ''
        ))
        IS DISTINCT FROM char_length(no_charge_build_authority_gate)
     OR char_length(terminal_definition)
        - char_length(replace(
          terminal_definition,
          v2_financial_receipt_filter,
          ''
        ))
        IS DISTINCT FROM 4 * char_length(v2_financial_receipt_filter) THEN
    RAISE EXCEPTION
      'Gateway funding terminal proof does not match the required marker contract';
  END IF;

  patched_definition := replace(
    replace(
      replace(
        terminal_definition,
        balance_build_authority_gate,
        ''
      ),
      no_charge_build_authority_gate,
      ''
    ),
    v2_financial_receipt_filter,
    v2_v3_financial_receipt_filter
  );

  IF position(
      'gateway_usage_evidence_has_current_build_authority('
      IN patched_definition
    ) > 0
     OR position(v2_financial_receipt_filter IN patched_definition) > 0
     OR position(
       'gateway-settlement-v3-customer-authority'
       IN patched_definition
     ) = 0 THEN
    RAISE EXCEPTION
      'Gateway funding terminal proof did not apply the required decoupling markers';
  END IF;

  FOREACH required_marker IN ARRAY ARRAY[
    'gateway funding reservation terminal anchor binding is invalid',
    'gateway funding reservation grant backing is incomplete',
    'gateway consumed reservation lacks matching TokenUsage proof',
    'selected_evidence."evidence_hash" = receipt."evidence_hash"',
    'receipt."settlement_fingerprint" IS NULL',
    'gateway consumed reservation lacks balance transaction',
    'gateway consumed reservation is not canonical wallet tail',
    'gateway consumed reservation allocation proof is inconsistent',
    'gateway consumed reservation did not consume frozen grant prefix',
    'gateway released reservation lacks one permanent release proof',
    'gateway_permanent_no_charge_reason(selected_evidence."raw_evidence")',
    'no_charge_receipt."anchor_hash" = reservation."anchor_hash"',
    'no_charge_receipt."pricing_hash" = anchor."pricing_hash"',
    'no_charge_receipt."settlement_fingerprint" IS NOT NULL',
    'NOT EXISTS (
          SELECT 1 FROM "token_usage" AS billed_usage'
  ] LOOP
    IF position(required_marker IN patched_definition) = 0 THEN
      RAISE EXCEPTION
        'Gateway funding terminal proof lost required marker: %',
        required_marker;
    END IF;
  END LOOP;

  EXECUTE patched_definition;
END;
$decouple_gateway_funding_terminal_build_authority$;

-- The predecessor TokenUsage anti-bypass proof counted only v2 receipts. New
-- customer-authority terminals are v3, while historical v2 receipts remain
-- valid at their original proof boundary. Upgrade exactly that one lookup and
-- retain the rest of the independent anchor/evidence binding unchanged.
DO $extend_gateway_token_usage_receipt_versions$
DECLARE
  token_definition TEXT;
  patched_definition TEXT;
  v2_receipt_filter CONSTANT TEXT :=
    'receipt_row."policy_version" = ''gateway-settlement-v2''';
  v2_v3_receipt_filter CONSTANT TEXT :=
    'receipt_row."policy_version" IN (''gateway-settlement-v2'', '
    || '''gateway-settlement-v3-customer-authority'')';
BEGIN
  SELECT pg_get_functiondef(
    'public.assert_gateway_token_usage_terminal_pair(text)'::regprocedure
  ) INTO token_definition;

  IF token_definition IS NULL
     OR char_length(token_definition)
        - char_length(replace(token_definition, v2_receipt_filter, ''))
        IS DISTINCT FROM char_length(v2_receipt_filter)
     OR position(
       'gateway TokenUsage terminal anchor binding is invalid'
       IN token_definition
     ) = 0
     OR position(
       'evidence."evidence_hash" = receipt."evidence_hash"'
       IN token_definition
     ) = 0 THEN
    RAISE EXCEPTION
      'Gateway TokenUsage terminal proof does not match the required marker contract';
  END IF;

  patched_definition := replace(
    token_definition,
    v2_receipt_filter,
    v2_v3_receipt_filter
  );
  IF position(v2_receipt_filter IN patched_definition) > 0
     OR position(
       'gateway-settlement-v3-customer-authority'
       IN patched_definition
     ) = 0 THEN
    RAISE EXCEPTION
      'Gateway TokenUsage terminal proof did not accept the v3 receipt contract';
  END IF;

  EXECUTE patched_definition;
END;
$extend_gateway_token_usage_receipt_versions$;

CREATE OR REPLACE FUNCTION assert_gateway_balance_customer_financial_authority(
  target_receipt_id TEXT
)
RETURNS VOID AS $$
DECLARE
  receipt RECORD;
  usage RECORD;
  anchor RECORD;
  reservation RECORD;
  authority JSONB;
  quote JSONB;
  basis TEXT;
  original_input BIGINT;
  original_output BIGINT;
  original_cache_read BIGINT;
  original_cache_write BIGINT;
  original_total BIGINT;
  original_image BIGINT;
  settled_input BIGINT;
  settled_output BIGINT;
  settled_cache_read BIGINT;
  settled_cache_write BIGINT;
  settled_total BIGINT;
  settled_image BIGINT;
  anchor_input BIGINT;
  anchor_output BIGINT;
  anchor_cache_read BIGINT;
  anchor_cache_write BIGINT;
  anchor_image BIGINT;
  original_amount NUMERIC;
  settled_amount NUMERIC;
  original_charge NUMERIC;
  settled_charge NUMERIC;
  anchor_amount NUMERIC;
BEGIN
  SELECT * INTO receipt
  FROM "gateway_usage_settlement_receipts"
  WHERE "id" = target_receipt_id;
  IF NOT FOUND
     OR receipt."policy_version"
          <> 'gateway-settlement-v3-customer-authority'
     OR receipt."billing_unit" IS DISTINCT FROM 'BALANCE' THEN
    RETURN;
  END IF;
  PERFORM assert_gateway_financial_read_committed();

  SELECT * INTO usage FROM "token_usage" WHERE "id" = receipt."token_usage_id";
  SELECT * INTO anchor
  FROM "gateway_usage_settlement_anchors"
  WHERE "gateway_billing_event_id" = receipt."gateway_billing_event_id";
  SELECT * INTO reservation
  FROM "gateway_usage_funding_reservations"
  WHERE "gateway_billing_event_id" = receipt."gateway_billing_event_id";
  authority := receipt."payload"->'customerFinancialAuthority';
  quote := receipt."payload"#>'{billingResult,quote}';
  basis := authority->>'basis';

  IF NOT FOUND
     OR jsonb_typeof(authority) IS DISTINCT FROM 'object'
     OR jsonb_typeof(quote) IS DISTINCT FROM 'object'
     OR reservation."status" IS DISTINCT FROM 'CONSUMED'
     OR anchor."billing_unit" IS DISTINCT FROM 'BALANCE'
     OR authority->>'protocol'
          IS DISTINCT FROM 'gateway-customer-financial-authority-v1'
     OR authority->>'policyVersion'
          IS DISTINCT FROM 'gateway-customer-settlement-v1'
     OR COALESCE(basis IN (
       'NORMALIZED_EXACT',
       'ZERO_PRICED_OMITTED_DIMENSION',
       'CUSTOMER_PROTECTIVE_ZERO'
     ), FALSE) IS DISTINCT FROM TRUE
     OR authority->>'billingUnit' IS DISTINCT FROM 'BALANCE'
     OR authority->>'customerAmountUnit' IS DISTINCT FROM 'USD'
     OR authority->>'fundingOutcome' IS DISTINCT FROM receipt."funding_outcome"
     OR authority->>'anchorHash' IS DISTINCT FROM receipt."anchor_hash"
     OR authority->>'pricingHash' IS DISTINCT FROM receipt."pricing_hash"
     OR authority->>'settlementFingerprint'
          IS DISTINCT FROM receipt."settlement_fingerprint"
     OR authority->>'tokenUsageId' IS DISTINCT FROM usage."id"
     OR quote->>'unit' IS DISTINCT FROM 'BALANCE'
     OR quote->>'userId' IS DISTINCT FROM anchor."user_id"
     OR quote->>'tenantId' IS DISTINCT FROM anchor."tenant_id"
     OR quote->>'billingAccountId' IS DISTINCT FROM anchor."billing_account_id"
     OR quote->>'productId' IS DISTINCT FROM anchor."product_id"
     OR quote->>'productSlug' IS DISTINCT FROM anchor."product_slug"
     OR quote->>'modelName' IS DISTINCT FROM usage."model"
     OR receipt."request_id" IS DISTINCT FROM anchor."request_id"
     OR usage."request_id" IS DISTINCT FROM anchor."request_id"
     OR receipt."billing_currency" IS DISTINCT FROM anchor."billing_currency"
     OR receipt."anchor_hash" IS DISTINCT FROM anchor."anchor_hash"
     OR receipt."pricing_hash" IS DISTINCT FROM anchor."pricing_hash"
     OR receipt."idempotency_key" IS DISTINCT FROM
       'gateway:financial:' || receipt."request_id" || ':' || receipt."anchor_hash" THEN
    RAISE EXCEPTION 'gateway BALANCE canonical financial authority is incomplete'
      USING ERRCODE = '55000';
  END IF;

  IF COALESCE(
       authority->>'originalCustomerAmount' ~ '^[0-9]+[.][0-9]{12}$', FALSE
     ) IS DISTINCT FROM TRUE
     OR COALESCE(
       authority->>'settledCustomerAmount' ~ '^[0-9]+[.][0-9]{12}$', FALSE
     ) IS DISTINCT FROM TRUE
     OR COALESCE(
       authority->>'originalCustomerChargeUsd' ~ '^[0-9]+[.][0-9]{12}$', FALSE
     ) IS DISTINCT FROM TRUE
     OR COALESCE(
       authority->>'settledCustomerChargeUsd' ~ '^[0-9]+[.][0-9]{12}$', FALSE
     ) IS DISTINCT FROM TRUE
     OR COALESCE(
       anchor."customer_quote_snapshot"->>'effectiveCostUsd'
         ~ '^[0-9]+([.][0-9]+)?$', FALSE
     ) IS DISTINCT FROM TRUE
     OR COALESCE(quote->>'effectiveCostUsd' ~ '^[0-9]+([.][0-9]+)?$', FALSE)
          IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'gateway BALANCE canonical amount encoding is invalid'
      USING ERRCODE = '55000';
  END IF;

  IF COALESCE(authority#>>'{originalDimensions,inputTokens}' ~ '^[0-9]+$', FALSE)
       IS DISTINCT FROM TRUE
     OR COALESCE(authority#>>'{originalDimensions,outputTokens}' ~ '^[0-9]+$', FALSE)
       IS DISTINCT FROM TRUE
     OR COALESCE(authority#>>'{originalDimensions,cachedInputTokens}' ~ '^[0-9]+$', FALSE)
       IS DISTINCT FROM TRUE
     OR COALESCE(authority#>>'{originalDimensions,cacheWriteInputTokens}' ~ '^[0-9]+$', FALSE)
       IS DISTINCT FROM TRUE
     OR COALESCE(authority#>>'{originalDimensions,totalTokens}' ~ '^[0-9]+$', FALSE)
       IS DISTINCT FROM TRUE
     OR COALESCE(authority#>>'{originalDimensions,imageCount}' ~ '^[0-9]+$', FALSE)
       IS DISTINCT FROM TRUE
     OR COALESCE(authority#>>'{settledDimensions,inputTokens}' ~ '^[0-9]+$', FALSE)
       IS DISTINCT FROM TRUE
     OR COALESCE(authority#>>'{settledDimensions,outputTokens}' ~ '^[0-9]+$', FALSE)
       IS DISTINCT FROM TRUE
     OR COALESCE(authority#>>'{settledDimensions,cachedInputTokens}' ~ '^[0-9]+$', FALSE)
       IS DISTINCT FROM TRUE
     OR COALESCE(authority#>>'{settledDimensions,cacheWriteInputTokens}' ~ '^[0-9]+$', FALSE)
       IS DISTINCT FROM TRUE
     OR COALESCE(authority#>>'{settledDimensions,totalTokens}' ~ '^[0-9]+$', FALSE)
       IS DISTINCT FROM TRUE
     OR COALESCE(authority#>>'{settledDimensions,imageCount}' ~ '^[0-9]+$', FALSE)
       IS DISTINCT FROM TRUE
     OR COALESCE(anchor."customer_quote_snapshot"->>'inputTokens' ~ '^[0-9]+$', FALSE)
       IS DISTINCT FROM TRUE
     OR COALESCE(anchor."customer_quote_snapshot"->>'outputTokens' ~ '^[0-9]+$', FALSE)
       IS DISTINCT FROM TRUE
     OR COALESCE(anchor."customer_quote_snapshot"->>'cachedInputTokens' ~ '^[0-9]+$', FALSE)
       IS DISTINCT FROM TRUE
     OR COALESCE(anchor."customer_quote_snapshot"->>'cacheWriteInputTokens' ~ '^[0-9]+$', FALSE)
       IS DISTINCT FROM TRUE
     OR COALESCE(anchor."customer_quote_snapshot"->>'imageCount' ~ '^[0-9]+$', FALSE)
       IS DISTINCT FROM TRUE
     OR COALESCE(quote->>'inputTokens' ~ '^[0-9]+$', FALSE) IS DISTINCT FROM TRUE
     OR COALESCE(quote->>'outputTokens' ~ '^[0-9]+$', FALSE) IS DISTINCT FROM TRUE
     OR COALESCE(quote->>'cachedInputTokens' ~ '^[0-9]+$', FALSE) IS DISTINCT FROM TRUE
     OR COALESCE(quote->>'cacheWriteInputTokens' ~ '^[0-9]+$', FALSE) IS DISTINCT FROM TRUE
     OR COALESCE(quote->>'imageCount' ~ '^[0-9]+$', FALSE) IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'gateway BALANCE canonical dimensions are invalid'
      USING ERRCODE = '55000';
  END IF;

  original_input := (authority#>>'{originalDimensions,inputTokens}')::BIGINT;
  original_output := (authority#>>'{originalDimensions,outputTokens}')::BIGINT;
  original_cache_read := (authority#>>'{originalDimensions,cachedInputTokens}')::BIGINT;
  original_cache_write := (authority#>>'{originalDimensions,cacheWriteInputTokens}')::BIGINT;
  original_total := (authority#>>'{originalDimensions,totalTokens}')::BIGINT;
  original_image := (authority#>>'{originalDimensions,imageCount}')::BIGINT;
  settled_input := (authority#>>'{settledDimensions,inputTokens}')::BIGINT;
  settled_output := (authority#>>'{settledDimensions,outputTokens}')::BIGINT;
  settled_cache_read := (authority#>>'{settledDimensions,cachedInputTokens}')::BIGINT;
  settled_cache_write := (authority#>>'{settledDimensions,cacheWriteInputTokens}')::BIGINT;
  settled_total := (authority#>>'{settledDimensions,totalTokens}')::BIGINT;
  settled_image := (authority#>>'{settledDimensions,imageCount}')::BIGINT;
  anchor_input := (anchor."customer_quote_snapshot"->>'inputTokens')::BIGINT;
  anchor_output := (anchor."customer_quote_snapshot"->>'outputTokens')::BIGINT;
  anchor_cache_read := (anchor."customer_quote_snapshot"->>'cachedInputTokens')::BIGINT;
  anchor_cache_write := (anchor."customer_quote_snapshot"->>'cacheWriteInputTokens')::BIGINT;
  anchor_image := (anchor."customer_quote_snapshot"->>'imageCount')::BIGINT;
  original_amount := (authority->>'originalCustomerAmount')::NUMERIC;
  settled_amount := (authority->>'settledCustomerAmount')::NUMERIC;
  original_charge := (authority->>'originalCustomerChargeUsd')::NUMERIC;
  settled_charge := (authority->>'settledCustomerChargeUsd')::NUMERIC;
  anchor_amount := (anchor."customer_quote_snapshot"->>'effectiveCostUsd')::NUMERIC;

  IF original_input IS DISTINCT FROM anchor_input
     OR original_output IS DISTINCT FROM anchor_output
     OR original_cache_read IS DISTINCT FROM anchor_cache_read
     OR original_cache_write IS DISTINCT FROM anchor_cache_write
     OR original_total IS DISTINCT FROM anchor_input + anchor_output
     OR original_image IS DISTINCT FROM anchor_image
     OR settled_input IS DISTINCT FROM (quote->>'inputTokens')::BIGINT
     OR settled_output IS DISTINCT FROM (quote->>'outputTokens')::BIGINT
     OR settled_cache_read IS DISTINCT FROM (quote->>'cachedInputTokens')::BIGINT
     OR settled_cache_write IS DISTINCT FROM (quote->>'cacheWriteInputTokens')::BIGINT
     OR settled_image IS DISTINCT FROM (quote->>'imageCount')::BIGINT
     OR settled_total IS DISTINCT FROM settled_input + settled_output
     OR settled_cache_read + settled_cache_write > settled_input
     OR usage."prompt_tokens" IS DISTINCT FROM settled_input
     OR usage."completion_tokens" IS DISTINCT FROM settled_output
     OR COALESCE(usage."cached_input_tokens", 0) IS DISTINCT FROM settled_cache_read
     OR COALESCE(usage."cache_write_input_tokens", 0) IS DISTINCT FROM settled_cache_write
     OR usage."total_tokens" IS DISTINCT FROM settled_total
     OR (settled_image > 0 AND (
       usage."meter" IS DISTINCT FROM 'image'
       OR usage."quantity" IS DISTINCT FROM settled_image
     ))
     OR (settled_image = 0 AND (
       usage."meter" IS DISTINCT FROM 'token'
       OR COALESCE(usage."quantity", 0) <> 0
     )) THEN
    RAISE EXCEPTION 'gateway BALANCE canonical dimension binding is inconsistent'
      USING ERRCODE = '55000';
  END IF;

  IF original_amount IS DISTINCT FROM anchor_amount
     OR original_charge IS DISTINCT FROM anchor_amount
     OR settled_amount IS DISTINCT FROM (quote->>'effectiveCostUsd')::NUMERIC
     OR settled_charge IS DISTINCT FROM settled_amount
     OR settled_amount IS DISTINCT FROM receipt."amount_usd"
     OR settled_amount IS DISTINCT FROM reservation."authoritative_amount_usd"
     OR settled_charge IS DISTINCT FROM usage."cost_usd"
     OR settled_charge IS DISTINCT FROM usage."customer_charge_usd"
     OR usage."customer_charge_policy" IS DISTINCT FROM 'payg_balance'
     OR usage."customer_funding_classification_complete" IS DISTINCT FROM TRUE
     OR usage."customer_collected_usd"
          + usage."customer_approved_receivable_usd"
          + usage."customer_unapproved_debt_usd"
          IS DISTINCT FROM settled_charge
     OR (basis IN ('NORMALIZED_EXACT', 'ZERO_PRICED_OMITTED_DIMENSION') AND (
       settled_input IS DISTINCT FROM original_input
       OR settled_output IS DISTINCT FROM original_output
       OR settled_cache_read IS DISTINCT FROM original_cache_read
       OR settled_cache_write IS DISTINCT FROM original_cache_write
       OR settled_image IS DISTINCT FROM original_image
       OR settled_amount IS DISTINCT FROM original_amount
       OR settled_charge IS DISTINCT FROM original_charge
     ))
     OR (basis = 'CUSTOMER_PROTECTIVE_ZERO' AND (
       settled_input <> 0 OR settled_output <> 0 OR settled_cache_read <> 0
       OR settled_cache_write <> 0 OR settled_total <> 0 OR settled_image <> 0
       OR settled_amount <> 0 OR settled_charge <> 0
     ))
     OR (usage."customer_unapproved_debt_usd" > 0 AND (
       authority->>'terminalClass' IS DISTINCT FROM 'BALANCE_DEBT_OPEN'
       OR receipt."funding_outcome" IS DISTINCT FROM 'DEBT_OPEN'
     ))
     OR (usage."customer_unapproved_debt_usd" = 0 AND (
       authority->>'terminalClass' IS DISTINCT FROM 'BALANCE_SETTLED'
       OR receipt."funding_outcome" NOT IN ('COLLECTED', 'RECEIVABLE')
     ))
     OR (settled_amount = 0 AND (
       EXISTS (SELECT 1 FROM "balance_transactions" AS tx
         WHERE tx."token_usage_id" = usage."id")
       OR EXISTS (SELECT 1 FROM "balance_consumption_allocations" AS allocation
         WHERE allocation."token_usage_id" = usage."id")
     )) THEN
    RAISE EXCEPTION 'gateway BALANCE canonical financial authority is inconsistent'
      USING ERRCODE = '55000';
  END IF;
END;
$$ LANGUAGE plpgsql;

-- 20260807000126 encoded one synthetic CREDITS shape (policy `credits`, no
-- mutation and INCLUDED only). Production has four materially different,
-- mutually exclusive terminals. Replace the function explicitly so each one
-- proves its own durable funding facts instead of weakening a shared IF.
CREATE OR REPLACE FUNCTION assert_gateway_financial_receipt_terminal_pair(
  target_receipt_id TEXT
)
RETURNS VOID AS $$
DECLARE
  receipt RECORD;
  usage RECORD;
  anchor RECORD;
  credit_mutation RECORD;
  reservation_status TEXT;
  customer_settlement JSONB;
  settlement_basis TEXT;
  terminal_class TEXT;
  billing_quote JSONB;
  original_input BIGINT;
  original_output BIGINT;
  original_cache_read BIGINT;
  original_cache_write BIGINT;
  original_total BIGINT;
  settled_input BIGINT;
  settled_output BIGINT;
  settled_cache_read BIGINT;
  settled_cache_write BIGINT;
  settled_total BIGINT;
  settled_regular BIGINT;
  original_image BIGINT;
  settled_image BIGINT;
  anchor_input BIGINT;
  anchor_output BIGINT;
  anchor_cache_read BIGINT;
  anchor_cache_write BIGINT;
  anchor_image BIGINT;
  anchor_credit_amount NUMERIC;
  original_customer_amount NUMERIC;
  settled_customer_amount NUMERIC;
  original_customer_charge_usd NUMERIC;
  settled_customer_charge_usd NUMERIC;
  frozen_customer_charge_usd NUMERIC;
  credit_mutation_count BIGINT;
  credit_mutation_key TEXT;
BEGIN
  SELECT * INTO receipt
  FROM "gateway_usage_settlement_receipts"
  WHERE "id" = target_receipt_id;
  IF NOT FOUND THEN
    RETURN;
  END IF;
  IF receipt."policy_version" NOT IN (
       'gateway-settlement-v2',
       'gateway-settlement-v3-customer-authority'
     ) THEN
    IF receipt."idempotency_key" LIKE 'gateway:financial:%' THEN
      RAISE EXCEPTION 'gateway financial receipt policy version is unsupported'
        USING ERRCODE = '55000';
    END IF;
    RETURN;
  END IF;
  IF receipt."token_usage_id" IS NULL THEN
    RAISE EXCEPTION 'gateway financial receipt requires TokenUsage'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO usage
  FROM "token_usage"
  WHERE "id" = receipt."token_usage_id";
  IF NOT FOUND OR usage."gateway_billing_event_id" IS NULL THEN
    RAISE EXCEPTION 'gateway financial receipt requires Gateway-linked TokenUsage'
      USING ERRCODE = '55000';
  END IF;
  PERFORM assert_gateway_token_usage_terminal_pair(usage."id");

  SELECT * INTO anchor
  FROM "gateway_usage_settlement_anchors"
  WHERE "gateway_billing_event_id" = usage."gateway_billing_event_id";

  -- Historical v2 rows retain their predecessor proof boundary and never gain
  -- synthetic compatibility with the new typed authority payload. Provider
  -- build currency is audit state and is intentionally not part of this
  -- financial proof. Every newly decoupled terminal is written as v3 below.
  IF receipt."policy_version" = 'gateway-settlement-v2' THEN
    IF anchor."billing_unit" = 'BALANCE' THEN
      SELECT funding."status" INTO reservation_status
      FROM "gateway_usage_funding_reservations" AS funding
      WHERE funding."gateway_billing_event_id" = usage."gateway_billing_event_id";
      IF reservation_status IS DISTINCT FROM 'CONSUMED' THEN
        RAISE EXCEPTION 'gateway BALANCE receipt requires consumed reservation'
          USING ERRCODE = '55000';
      END IF;
      RETURN;
    END IF;

    PERFORM assert_gateway_financial_read_committed();
    IF anchor."billing_unit" IS DISTINCT FROM 'CREDITS'
       OR receipt."funding_outcome" IS DISTINCT FROM 'INCLUDED'
       OR receipt."amount_usd" IS DISTINCT FROM 0
       OR receipt."credit_amount" IS NULL
       OR receipt."credit_amount" <= 0
       OR usage."customer_charge_policy" IS DISTINCT FROM 'credits'
       OR usage."customer_funding_classification_complete" IS DISTINCT FROM TRUE
       OR usage."customer_charge_usd" IS DISTINCT FROM 0
       OR usage."customer_collected_usd" IS DISTINCT FROM 0
       OR usage."customer_approved_receivable_usd" IS DISTINCT FROM 0
       OR usage."customer_unapproved_debt_usd" IS DISTINCT FROM 0 THEN
      RAISE EXCEPTION 'gateway legacy v2 CREDITS receipt proof is inconsistent'
        USING ERRCODE = '55000';
    END IF;
    RETURN;
  END IF;

  IF anchor."billing_unit" = 'BALANCE' THEN
    SELECT funding."status" INTO reservation_status
    FROM "gateway_usage_funding_reservations" AS funding
    WHERE funding."gateway_billing_event_id" = usage."gateway_billing_event_id";
    IF reservation_status IS DISTINCT FROM 'CONSUMED' THEN
      RAISE EXCEPTION 'gateway BALANCE receipt requires consumed reservation'
        USING ERRCODE = '55000';
    END IF;
    PERFORM assert_gateway_balance_customer_financial_authority(receipt."id");
    RETURN;
  END IF;

  PERFORM assert_gateway_financial_read_committed();
  customer_settlement := receipt."payload"->'customerFinancialAuthority';
  billing_quote := receipt."payload"#>'{billingResult,quote}';
  settlement_basis := customer_settlement->>'basis';
  terminal_class := customer_settlement->>'terminalClass';
  IF anchor."billing_unit" IS DISTINCT FROM 'CREDITS'
     OR anchor."subscription_id" IS NULL
     OR anchor."plan_id" IS NULL
     OR receipt."billing_unit" IS DISTINCT FROM 'CREDITS'
     OR receipt."billing_currency" IS DISTINCT FROM anchor."billing_currency"
     OR receipt."amount_usd" < 0
     OR receipt."credit_amount" IS NULL
     OR receipt."credit_amount" < 0
     OR receipt."idempotency_key" IS DISTINCT FROM
       'gateway:financial:' || receipt."request_id" || ':' || receipt."anchor_hash"
     OR receipt."payload" IS NULL
     OR jsonb_typeof(customer_settlement) IS DISTINCT FROM 'object'
     OR jsonb_typeof(billing_quote) IS DISTINCT FROM 'object'
     OR customer_settlement->>'protocol'
          IS DISTINCT FROM 'gateway-customer-financial-authority-v1'
     OR customer_settlement->>'policyVersion'
          IS DISTINCT FROM 'gateway-customer-settlement-v1'
     OR COALESCE(customer_settlement->>'basis' IN (
       'NORMALIZED_EXACT',
       'ZERO_PRICED_OMITTED_DIMENSION',
       'CUSTOMER_PROTECTIVE_ZERO'
     ), FALSE) IS DISTINCT FROM TRUE
     OR customer_settlement->>'billingUnit' IS DISTINCT FROM 'CREDITS'
     OR customer_settlement->>'customerAmountUnit' IS DISTINCT FROM 'CREDITS'
     OR customer_settlement->>'fundingOutcome' IS DISTINCT FROM receipt."funding_outcome"
     OR customer_settlement->>'anchorHash' IS DISTINCT FROM receipt."anchor_hash"
     OR customer_settlement->>'pricingHash' IS DISTINCT FROM receipt."pricing_hash"
     OR customer_settlement->>'settlementFingerprint'
          IS DISTINCT FROM receipt."settlement_fingerprint"
     OR customer_settlement->>'tokenUsageId' IS DISTINCT FROM usage."id"
     OR billing_quote->>'unit' IS DISTINCT FROM 'CREDITS'
     OR usage."request_id" IS DISTINCT FROM receipt."request_id"
     OR usage."request_id" IS DISTINCT FROM anchor."request_id"
     OR usage."api_key_id" IS DISTINCT FROM anchor."api_key_id"
     OR usage."tenant_id" IS DISTINCT FROM anchor."tenant_id"
     OR usage."product_id" IS DISTINCT FROM anchor."product_id"
     OR billing_quote->>'userId' IS DISTINCT FROM anchor."user_id"
     OR billing_quote->>'tenantId' IS DISTINCT FROM anchor."tenant_id"
     OR billing_quote->>'billingAccountId' IS DISTINCT FROM anchor."billing_account_id"
     OR billing_quote->>'productId' IS DISTINCT FROM anchor."product_id"
     OR billing_quote->>'productSlug' IS DISTINCT FROM anchor."product_slug"
     OR billing_quote->>'subscriptionId' IS DISTINCT FROM anchor."subscription_id"
     OR billing_quote->>'planId' IS DISTINCT FROM anchor."plan_id"
     OR billing_quote->>'modelName' IS DISTINCT FROM usage."model"
     OR anchor."customer_quote_snapshot"->>'modelName'
          IS DISTINCT FROM usage."model"
     OR COALESCE(
       (billing_quote->>'creditCost') ~ '^(0|[1-9][0-9]*)$',
       FALSE
     ) IS DISTINCT FROM TRUE
     OR (billing_quote->>'creditCost')::NUMERIC
          IS DISTINCT FROM receipt."credit_amount" THEN
    RAISE EXCEPTION 'gateway CREDITS receipt common proof is inconsistent'
      USING ERRCODE = '55000';
  END IF;

  IF COALESCE(
       customer_settlement#>>'{originalDimensions,inputTokens}' ~ '^[0-9]+$',
       FALSE
     ) IS DISTINCT FROM TRUE
     OR COALESCE(
       customer_settlement#>>'{originalDimensions,outputTokens}' ~ '^[0-9]+$',
       FALSE
     ) IS DISTINCT FROM TRUE
     OR COALESCE(
       customer_settlement#>>'{originalDimensions,cachedInputTokens}' ~ '^[0-9]+$',
       FALSE
     ) IS DISTINCT FROM TRUE
     OR COALESCE(
       customer_settlement#>>'{originalDimensions,cacheWriteInputTokens}' ~ '^[0-9]+$',
       FALSE
     ) IS DISTINCT FROM TRUE
     OR COALESCE(
       customer_settlement#>>'{originalDimensions,totalTokens}' ~ '^[0-9]+$',
       FALSE
     ) IS DISTINCT FROM TRUE
     OR COALESCE(
       customer_settlement#>>'{originalDimensions,imageCount}' ~ '^[0-9]+$',
       FALSE
     ) IS DISTINCT FROM TRUE
     OR COALESCE(
       customer_settlement#>>'{settledDimensions,inputTokens}' ~ '^[0-9]+$',
       FALSE
     ) IS DISTINCT FROM TRUE
     OR COALESCE(
       customer_settlement#>>'{settledDimensions,outputTokens}' ~ '^[0-9]+$',
       FALSE
     ) IS DISTINCT FROM TRUE
     OR COALESCE(
       customer_settlement#>>'{settledDimensions,cachedInputTokens}' ~ '^[0-9]+$',
       FALSE
     ) IS DISTINCT FROM TRUE
     OR COALESCE(
       customer_settlement#>>'{settledDimensions,cacheWriteInputTokens}' ~ '^[0-9]+$',
       FALSE
     ) IS DISTINCT FROM TRUE
     OR COALESCE(
       customer_settlement#>>'{settledDimensions,totalTokens}' ~ '^[0-9]+$',
       FALSE
     ) IS DISTINCT FROM TRUE
     OR COALESCE(
       customer_settlement#>>'{settledDimensions,imageCount}' ~ '^[0-9]+$',
       FALSE
     ) IS DISTINCT FROM TRUE
     OR COALESCE(anchor."customer_quote_snapshot"->>'inputTokens' ~ '^[0-9]+$', FALSE)
          IS DISTINCT FROM TRUE
     OR COALESCE(anchor."customer_quote_snapshot"->>'outputTokens' ~ '^[0-9]+$', FALSE)
          IS DISTINCT FROM TRUE
     OR COALESCE(anchor."customer_quote_snapshot"->>'cachedInputTokens' ~ '^[0-9]+$', FALSE)
          IS DISTINCT FROM TRUE
     OR COALESCE(anchor."customer_quote_snapshot"->>'cacheWriteInputTokens' ~ '^[0-9]+$', FALSE)
          IS DISTINCT FROM TRUE
     OR COALESCE(anchor."customer_quote_snapshot"->>'imageCount' ~ '^[0-9]+$', FALSE)
          IS DISTINCT FROM TRUE
     OR COALESCE(
       anchor."customer_quote_snapshot"->>'creditCost' ~ '^(0|[1-9][0-9]*)$',
       FALSE
     ) IS DISTINCT FROM TRUE
     OR COALESCE(
       customer_settlement->>'originalCustomerAmount' ~ '^(0|[1-9][0-9]*)$',
       FALSE
     ) IS DISTINCT FROM TRUE
     OR COALESCE(
       customer_settlement->>'settledCustomerAmount' ~ '^(0|[1-9][0-9]*)$',
       FALSE
     ) IS DISTINCT FROM TRUE
     OR COALESCE(
       customer_settlement->>'originalCustomerChargeUsd'
         ~ '^[0-9]+[.][0-9]{12}$',
       FALSE
     ) IS DISTINCT FROM TRUE
     OR COALESCE(
       customer_settlement->>'settledCustomerChargeUsd'
         ~ '^[0-9]+[.][0-9]{12}$',
       FALSE
     ) IS DISTINCT FROM TRUE
     OR COALESCE(billing_quote->>'inputTokens' ~ '^[0-9]+$', FALSE)
          IS DISTINCT FROM TRUE
     OR COALESCE(billing_quote->>'outputTokens' ~ '^[0-9]+$', FALSE)
          IS DISTINCT FROM TRUE
     OR COALESCE(billing_quote->>'cachedInputTokens' ~ '^[0-9]+$', FALSE)
          IS DISTINCT FROM TRUE
     OR COALESCE(billing_quote->>'cacheWriteInputTokens' ~ '^[0-9]+$', FALSE)
          IS DISTINCT FROM TRUE
     OR COALESCE(billing_quote->>'imageCount' ~ '^[0-9]+$', FALSE)
          IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION 'gateway CREDITS receipt dimensions are invalid'
      USING ERRCODE = '55000';
  END IF;

  original_input := (customer_settlement#>>'{originalDimensions,inputTokens}')::BIGINT;
  original_output := (customer_settlement#>>'{originalDimensions,outputTokens}')::BIGINT;
  original_cache_read :=
    (customer_settlement#>>'{originalDimensions,cachedInputTokens}')::BIGINT;
  original_cache_write :=
    (customer_settlement#>>'{originalDimensions,cacheWriteInputTokens}')::BIGINT;
  original_total := (customer_settlement#>>'{originalDimensions,totalTokens}')::BIGINT;
  settled_input := (customer_settlement#>>'{settledDimensions,inputTokens}')::BIGINT;
  settled_output := (customer_settlement#>>'{settledDimensions,outputTokens}')::BIGINT;
  settled_cache_read :=
    (customer_settlement#>>'{settledDimensions,cachedInputTokens}')::BIGINT;
  settled_cache_write :=
    (customer_settlement#>>'{settledDimensions,cacheWriteInputTokens}')::BIGINT;
  settled_total := (customer_settlement#>>'{settledDimensions,totalTokens}')::BIGINT;
  original_image :=
    (customer_settlement#>>'{originalDimensions,imageCount}')::BIGINT;
  settled_image :=
    (customer_settlement#>>'{settledDimensions,imageCount}')::BIGINT;
  anchor_input := (anchor."customer_quote_snapshot"->>'inputTokens')::BIGINT;
  anchor_output := (anchor."customer_quote_snapshot"->>'outputTokens')::BIGINT;
  anchor_cache_read :=
    (anchor."customer_quote_snapshot"->>'cachedInputTokens')::BIGINT;
  anchor_cache_write :=
    (anchor."customer_quote_snapshot"->>'cacheWriteInputTokens')::BIGINT;
  anchor_image := (anchor."customer_quote_snapshot"->>'imageCount')::BIGINT;
  anchor_credit_amount :=
    (anchor."customer_quote_snapshot"->>'creditCost')::NUMERIC;
  original_customer_amount :=
    (customer_settlement->>'originalCustomerAmount')::NUMERIC;
  settled_customer_amount :=
    (customer_settlement->>'settledCustomerAmount')::NUMERIC;
  original_customer_charge_usd :=
    (customer_settlement->>'originalCustomerChargeUsd')::NUMERIC;
  settled_customer_charge_usd :=
    (customer_settlement->>'settledCustomerChargeUsd')::NUMERIC;
  settled_regular := settled_input - settled_cache_read - settled_cache_write;

  IF original_input IS DISTINCT FROM anchor_input
     OR original_output IS DISTINCT FROM anchor_output
     OR original_cache_read IS DISTINCT FROM anchor_cache_read
     OR original_cache_write IS DISTINCT FROM anchor_cache_write
     OR original_total IS DISTINCT FROM anchor_input + anchor_output
     OR original_image IS DISTINCT FROM anchor_image
     OR settled_input IS DISTINCT FROM (billing_quote->>'inputTokens')::BIGINT
     OR settled_output IS DISTINCT FROM (billing_quote->>'outputTokens')::BIGINT
     OR settled_cache_read IS DISTINCT FROM
       (billing_quote->>'cachedInputTokens')::BIGINT
     OR settled_cache_write IS DISTINCT FROM
       (billing_quote->>'cacheWriteInputTokens')::BIGINT
     OR settled_image IS DISTINCT FROM (billing_quote->>'imageCount')::BIGINT
     OR settled_total IS DISTINCT FROM settled_input + settled_output
     OR settled_regular < 0
     OR usage."prompt_tokens" IS DISTINCT FROM settled_input
     OR usage."completion_tokens" IS DISTINCT FROM settled_output
     OR COALESCE(usage."cached_input_tokens", 0) IS DISTINCT FROM settled_cache_read
     OR COALESCE(usage."cache_write_input_tokens", 0)
          IS DISTINCT FROM settled_cache_write
     OR usage."total_tokens" IS DISTINCT FROM settled_total
     OR (
       settlement_basis IN ('NORMALIZED_EXACT', 'ZERO_PRICED_OMITTED_DIMENSION')
       AND (
         settled_input IS DISTINCT FROM anchor_input
         OR settled_output IS DISTINCT FROM anchor_output
         OR settled_cache_read IS DISTINCT FROM anchor_cache_read
         OR settled_cache_write IS DISTINCT FROM anchor_cache_write
         OR settled_image IS DISTINCT FROM anchor_image
       )
     )
     OR (
       settlement_basis = 'CUSTOMER_PROTECTIVE_ZERO'
       AND (
         settled_input <> 0
         OR settled_output <> 0
         OR settled_cache_read <> 0
         OR settled_cache_write <> 0
         OR settled_total <> 0
         OR settled_image <> 0
       )
     )
     OR (
       settled_image > 0
       AND (
         usage."meter" IS DISTINCT FROM 'image'
         OR usage."quantity" IS DISTINCT FROM settled_image
       )
     )
     OR (
       settled_image = 0
       AND (
         usage."meter" IS DISTINCT FROM 'token'
         OR COALESCE(usage."quantity", 0) <> 0
       )
     ) THEN
    RAISE EXCEPTION 'gateway CREDITS original/settled dimension binding is invalid'
      USING ERRCODE = '55000';
  END IF;

  credit_mutation_key :=
    'gateway:credits:' || receipt."request_id" || ':' || receipt."anchor_hash";
  IF COALESCE(anchor."customer_pricing_snapshot"->>'includedUpstream', 'false') = 'true'
     OR anchor_credit_amount = 0 THEN
    frozen_customer_charge_usd := 0;
  ELSE
    IF anchor."customer_pricing_snapshot"#>>'{tokenUsagePricing,status}'
         IS DISTINCT FROM 'VERIFIED'
       OR COALESCE(
         anchor."customer_pricing_snapshot"#>>'{tokenUsagePricing,costUsd}'
           ~ '^[0-9]+([.][0-9]+)?$',
         FALSE
       ) IS DISTINCT FROM TRUE THEN
      RAISE EXCEPTION 'gateway CREDITS frozen customer amount is incomplete'
        USING ERRCODE = '55000';
    END IF;
    frozen_customer_charge_usd :=
      (anchor."customer_pricing_snapshot"#>>'{tokenUsagePricing,costUsd}')::NUMERIC;
  END IF;

  IF original_customer_amount IS DISTINCT FROM anchor_credit_amount
     OR original_customer_charge_usd IS DISTINCT FROM frozen_customer_charge_usd
     OR settled_customer_amount IS DISTINCT FROM receipt."credit_amount"
     OR settled_customer_amount IS DISTINCT FROM (billing_quote->>'creditCost')::NUMERIC
     OR settled_customer_charge_usd IS DISTINCT FROM usage."cost_usd"
     OR settled_customer_charge_usd IS DISTINCT FROM usage."customer_charge_usd"
     OR (
       settlement_basis IN ('NORMALIZED_EXACT', 'ZERO_PRICED_OMITTED_DIMENSION')
       AND (
         settled_customer_amount IS DISTINCT FROM original_customer_amount
         OR settled_customer_charge_usd IS DISTINCT FROM original_customer_charge_usd
       )
     )
     OR (
       settlement_basis = 'CUSTOMER_PROTECTIVE_ZERO'
       AND (
         settled_customer_amount <> 0
         OR settled_customer_charge_usd <> 0
       )
     ) THEN
    RAISE EXCEPTION 'gateway CREDITS canonical financial authority is inconsistent'
      USING ERRCODE = '55000';
  END IF;

  SELECT COUNT(*)
  INTO credit_mutation_count
  FROM "credit_transactions" AS tx
  WHERE tx."request_id" = receipt."request_id";

  IF COALESCE(anchor."customer_pricing_snapshot"->>'includedUpstream', 'false') = 'true' THEN
    IF COALESCE(anchor."customer_quote_snapshot"->>'includedUpstream', 'false') <> 'true'
       OR COALESCE(billing_quote->>'includedUpstream', 'false') <> 'true'
       OR terminal_class IS DISTINCT FROM 'CREDITS_INCLUDED'
       OR anchor."customer_pricing_snapshot"->>'priceBasis'
            IS DISTINCT FROM 'INCLUDED_UPSTREAM'
       OR receipt."funding_outcome" IS DISTINCT FROM 'INCLUDED'
       OR receipt."amount_usd" IS DISTINCT FROM 0
       OR receipt."credit_amount" IS DISTINCT FROM 0
       OR usage."customer_charge_policy" IS DISTINCT FROM 'included_upstream'
       OR usage."customer_funding_classification_complete" IS DISTINCT FROM TRUE
       OR usage."cost_usd" IS DISTINCT FROM 0
       OR usage."customer_charge_usd" IS DISTINCT FROM 0
       OR usage."customer_collected_usd" IS DISTINCT FROM 0
       OR usage."customer_approved_receivable_usd" IS DISTINCT FROM 0
       OR usage."customer_unapproved_debt_usd" IS DISTINCT FROM 0
       OR receipt."payload"#>>'{billingResult,upstreamIncluded}' IS DISTINCT FROM 'true'
       OR receipt."payload"#>'{billingResult,zeroCreditCharge}' IS NOT NULL
       OR credit_mutation_count <> 0
       OR EXISTS (
         SELECT 1 FROM "credit_transactions" AS tx
         WHERE tx."idempotency_key" = credit_mutation_key
       ) THEN
      RAISE EXCEPTION 'gateway included-upstream CREDITS proof is inconsistent'
        USING ERRCODE = '55000';
    END IF;
    RETURN;
  END IF;

  IF COALESCE(anchor."customer_quote_snapshot"->>'includedUpstream', 'false') <> 'false'
     OR COALESCE(billing_quote->>'includedUpstream', 'false') <> 'false' THEN
    RAISE EXCEPTION 'gateway non-included CREDITS proof has an upstream inclusion conflict'
      USING ERRCODE = '55000';
  END IF;

  IF receipt."credit_amount" = 0 THEN
    IF terminal_class IS DISTINCT FROM 'CREDITS_ZERO'
       OR receipt."funding_outcome" IS DISTINCT FROM 'INCLUDED'
       OR receipt."amount_usd" IS DISTINCT FROM 0
       OR receipt."reason" IS DISTINCT FROM 'zero_priced_credits'
       OR receipt."payload"#>>'{billingResult,reason}'
            IS DISTINCT FROM 'zero_priced_credits'
       OR receipt."payload"#>>'{billingResult,zeroCreditCharge,protocol}'
            IS DISTINCT FROM 'gateway-credits-zero-charge-v1'
       OR receipt."payload"#>>'{billingResult,zeroCreditCharge,creditMutationIdempotencyKey}'
            IS DISTINCT FROM credit_mutation_key
       OR usage."customer_charge_policy" IS DISTINCT FROM 'subscription_credits'
       OR usage."customer_funding_classification_complete" IS DISTINCT FROM TRUE
       OR usage."cost_usd" IS DISTINCT FROM 0
       OR usage."customer_charge_usd" IS DISTINCT FROM 0
       OR usage."customer_collected_usd" IS DISTINCT FROM 0
       OR usage."customer_approved_receivable_usd" IS DISTINCT FROM 0
       OR usage."customer_unapproved_debt_usd" IS DISTINCT FROM 0
       OR credit_mutation_count <> 0
       OR EXISTS (
         SELECT 1 FROM "credit_transactions" AS tx
         WHERE tx."idempotency_key" = credit_mutation_key
       ) THEN
      RAISE EXCEPTION 'gateway zero-priced CREDITS proof is inconsistent'
        USING ERRCODE = '55000';
    END IF;
    RETURN;
  END IF;

  IF receipt."funding_outcome" = 'INCLUDED' THEN
    SELECT * INTO credit_mutation
    FROM "credit_transactions"
    WHERE "idempotency_key" = credit_mutation_key;
    IF terminal_class IS DISTINCT FROM 'CREDITS_CHARGED'
       OR NOT FOUND
       OR credit_mutation_count <> 1
       OR credit_mutation."type"::TEXT IS DISTINCT FROM 'CONSUME'
       OR credit_mutation."credits_amount" IS DISTINCT FROM -receipt."credit_amount"
       OR credit_mutation."request_id" IS DISTINCT FROM receipt."request_id"
       OR credit_mutation."subscription_id" IS DISTINCT FROM anchor."subscription_id"
       OR credit_mutation."user_id" IS DISTINCT FROM anchor."user_id"
       OR credit_mutation."tenant_id" IS DISTINCT FROM anchor."tenant_id"
       OR credit_mutation."product_id" IS DISTINCT FROM anchor."product_id"
       OR credit_mutation."model_name" IS DISTINCT FROM usage."model"
       OR credit_mutation."input_tokens" IS DISTINCT FROM settled_input
       OR COALESCE(credit_mutation."cached_input_tokens", 0)
            IS DISTINCT FROM settled_cache_read
       OR credit_mutation."output_tokens" IS DISTINCT FROM settled_output
       OR credit_mutation."total_tokens" IS DISTINCT FROM settled_total
       OR usage."customer_charge_policy" IS DISTINCT FROM 'subscription_credits'
       OR usage."customer_funding_classification_complete" IS DISTINCT FROM TRUE
       OR usage."customer_charge_usd" < 0
       OR usage."cost_usd" IS DISTINCT FROM usage."customer_charge_usd"
       OR usage."customer_collected_usd" IS DISTINCT FROM usage."customer_charge_usd"
       OR usage."customer_approved_receivable_usd" IS DISTINCT FROM 0
       OR usage."customer_unapproved_debt_usd" IS DISTINCT FROM 0
       OR receipt."amount_usd" IS DISTINCT FROM 0
       OR receipt."reason" IS NOT NULL
       OR receipt."payload"#>'{billingResult,zeroCreditCharge}' IS NOT NULL
       OR receipt."payload"#>>'{billingResult,debtOpen}' = 'true' THEN
      RAISE EXCEPTION 'gateway positive CREDITS mutation proof is inconsistent'
        USING ERRCODE = '55000';
    END IF;
    RETURN;
  END IF;

  IF receipt."funding_outcome" = 'DEBT_OPEN' THEN
    IF terminal_class IS DISTINCT FROM 'CREDITS_DEBT_OPEN'
       OR receipt."reason" IS DISTINCT FROM 'insufficient_credits'
       OR receipt."payload"#>>'{billingResult,reason}'
            IS DISTINCT FROM 'insufficient_credits'
       OR receipt."payload"#>>'{billingResult,debtOpen}' IS DISTINCT FROM 'true'
       OR receipt."payload"#>>'{billingResult,fundingOutcome}'
            IS DISTINCT FROM 'DEBT_OPEN'
       OR receipt."payload"#>>'{billingResult,debtCredits}'
            IS DISTINCT FROM receipt."credit_amount"::TEXT
       OR COALESCE(
         receipt."payload"#>>'{billingResult,debtExposureUsd}'
           ~ '^[0-9]+([.][0-9]+)?$',
         FALSE
       ) IS DISTINCT FROM TRUE
       OR (receipt."payload"#>>'{billingResult,debtExposureUsd}')::NUMERIC
            IS DISTINCT FROM usage."customer_charge_usd"
       OR receipt."amount_usd" IS DISTINCT FROM usage."customer_charge_usd"
       OR usage."customer_charge_policy" IS DISTINCT FROM 'debt_open'
       OR usage."customer_funding_classification_complete" IS DISTINCT FROM TRUE
       OR usage."customer_charge_usd" <= 0
       OR usage."cost_usd" IS DISTINCT FROM usage."customer_charge_usd"
       OR usage."customer_collected_usd" IS DISTINCT FROM 0
       OR usage."customer_approved_receivable_usd" IS DISTINCT FROM 0
       OR usage."customer_unapproved_debt_usd"
            IS DISTINCT FROM usage."customer_charge_usd"
       OR credit_mutation_count <> 0
       OR EXISTS (
         SELECT 1 FROM "credit_transactions" AS tx
         WHERE tx."idempotency_key" = credit_mutation_key
       ) THEN
      RAISE EXCEPTION 'gateway CREDITS DEBT_OPEN receipt proof is inconsistent'
        USING ERRCODE = '55000';
    END IF;
    RETURN;
  END IF;

  RAISE EXCEPTION 'gateway CREDITS receipt funding outcome is unsupported'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;

-- The receipt trigger proves the canonical credit mutation at commit time.
-- This reverse edge makes that proof durable after commit as well: changing or
-- deleting a positive mutation, or adding a mutation to a no-mutation terminal,
-- re-runs the owning receipt proof in the same deferred transaction.
CREATE OR REPLACE FUNCTION assert_gateway_credit_transaction_terminal_pairs(
  candidate_idempotency_key TEXT,
  candidate_request_id TEXT
)
RETURNS VOID AS $$
DECLARE
  receipt_id TEXT;
BEGIN
  IF candidate_request_id IS NULL
     AND (
       candidate_idempotency_key IS NULL
       OR candidate_idempotency_key NOT LIKE 'gateway:credits:%'
     ) THEN
    RETURN;
  END IF;
  FOR receipt_id IN
    SELECT receipt."id"
    FROM "gateway_usage_settlement_receipts" AS receipt
    WHERE receipt."policy_version" IN (
        'gateway-settlement-v2',
        'gateway-settlement-v3-customer-authority'
      )
      AND receipt."billing_unit" = 'CREDITS'
      AND (
        candidate_request_id = receipt."request_id"
        OR candidate_idempotency_key =
          'gateway:credits:' || receipt."request_id" || ':' || receipt."anchor_hash"
      )
  LOOP
    PERFORM assert_gateway_financial_receipt_terminal_pair(receipt_id);
  END LOOP;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_gateway_credit_transaction_terminal_pairs_trigger()
RETURNS trigger AS $$
BEGIN
  IF TG_OP IN ('UPDATE', 'DELETE') THEN
    PERFORM assert_gateway_credit_transaction_terminal_pairs(
      OLD."idempotency_key",
      OLD."request_id"
    );
  END IF;
  IF TG_OP IN ('INSERT', 'UPDATE')
     AND (
       TG_OP = 'INSERT'
       OR NEW."idempotency_key" IS DISTINCT FROM OLD."idempotency_key"
       OR NEW IS DISTINCT FROM OLD
     ) THEN
    PERFORM assert_gateway_credit_transaction_terminal_pairs(
      NEW."idempotency_key",
      NEW."request_id"
    );
  END IF;
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE CONSTRAINT TRIGGER credit_transactions_gateway_terminal_pairs
  AFTER INSERT OR UPDATE OR DELETE ON "credit_transactions"
  DEFERRABLE INITIALLY DEFERRED
  FOR EACH ROW
  EXECUTE FUNCTION validate_gateway_credit_transaction_terminal_pairs_trigger();

COMMENT ON FUNCTION assert_gateway_usage_funding_terminal(TEXT) IS
  'Proves Gateway BALANCE reservation terminals from immutable evidence/hash, anchor, receipt, ledger and frozen funding math; provider build authority is audited separately.';

COMMENT ON FUNCTION assert_gateway_financial_receipt_terminal_pair(TEXT) IS
  'Proves BALANCE receipt pairing and four explicit CREDITS terminals (positive mutation, zero-priced, included-upstream and debt-open) without mutable provider build authority.';
