-- Keep Gateway terminal validation proportional to the current settlement.
-- Release-B remains the full canonical fallback for non-Gateway writers; a
-- proven Gateway settlement binds only its current rows to the wallet tail.
CREATE OR REPLACE FUNCTION assert_gateway_usage_funding_terminal(
  target_reservation_id TEXT
)
RETURNS VOID AS $$
DECLARE
  reservation RECORD;
  anchor RECORD;
  event RECORD;
  usage RECORD;
  receipt RECORD;
  balance_tx RECORD;
  hold_amount NUMERIC(20,12);
  allocation_amount NUMERIC(20,12);
  allocation_collected_amount NUMERIC(20,12);
  allocation_approved_amount NUMERIC(20,12);
  allocation_unapproved_amount NUMERIC(20,12);
  allocation_count BIGINT;
  invalid_allocation_count BIGINT;
  invalid_reserved_grant_allocation_count BIGINT;
  balance_tx_found BOOLEAN;
  balance_tx_id TEXT;
  receipt_count BIGINT;
  release_proof_count BIGINT;
  ledger_account_status TEXT;
  ledger_account_version INTEGER;
  ledger_wallet_balance NUMERIC;
  ledger_tail_transaction_id TEXT;
BEGIN
  SELECT * INTO reservation
  FROM "gateway_usage_funding_reservations"
  WHERE "id" = target_reservation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gateway funding terminal proof references missing reservation'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO anchor
  FROM "gateway_usage_settlement_anchors"
  WHERE "gateway_billing_event_id" = reservation."gateway_billing_event_id";
  IF NOT FOUND
     OR anchor."request_id" IS DISTINCT FROM reservation."request_id"
     OR anchor."api_key_id" IS DISTINCT FROM reservation."api_key_id"
     OR anchor."user_id" IS DISTINCT FROM reservation."user_id"
     OR anchor."tenant_id" IS DISTINCT FROM reservation."tenant_id"
     OR anchor."billing_account_id" IS DISTINCT FROM reservation."billing_account_id"
     OR anchor."billing_unit" IS DISTINCT FROM 'BALANCE'
     OR anchor."billing_currency" IS DISTINCT FROM reservation."billing_currency"
     OR anchor."occurred_at" IS DISTINCT FROM reservation."occurred_at"
     OR anchor."first_received_at" IS DISTINCT FROM reservation."first_received_at"
     OR anchor."first_receipt_sequence" IS DISTINCT FROM reservation."reservation_sequence"
     OR anchor."funding_reservation_protocol" IS DISTINCT FROM 'V1'
     OR anchor."anchor_hash" IS DISTINCT FROM reservation."anchor_hash" THEN
    RAISE EXCEPTION 'gateway funding reservation terminal anchor binding is invalid'
      USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(SUM(hold."amount_usd"), 0)
  INTO hold_amount
  FROM "gateway_usage_funding_reservation_grants" AS hold
  WHERE hold."funding_reservation_id" = reservation."id";
  IF hold_amount IS DISTINCT FROM reservation."collected_usd" THEN
    RAISE EXCEPTION 'gateway funding reservation grant backing is incomplete'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO event
  FROM "gateway_billing_events"
  WHERE "id" = reservation."gateway_billing_event_id";
  IF NOT FOUND OR event."request_id" IS DISTINCT FROM reservation."request_id" THEN
    RAISE EXCEPTION 'gateway funding reservation parent event is invalid'
      USING ERRCODE = '55000';
  END IF;

  IF reservation."status" = 'ACTIVE' THEN
    RETURN;
  END IF;

  IF reservation."status" = 'MANUAL_REVIEW' THEN
    IF event."status" IS DISTINCT FROM 'QUARANTINED'
       OR event."reconciliation_status" IS DISTINCT FROM 'MANUAL_REVIEW' THEN
      RAISE EXCEPTION 'gateway funding manual review lacks quarantined event proof'
        USING ERRCODE = '55000';
    END IF;
    RETURN;
  END IF;

  -- Rollout mode and build authority are mutable database state. Every money
  -- terminal must see a fresh statement snapshot even in SHADOW, including
  -- release paths that do not produce a TokenUsage row.
  PERFORM assert_gateway_financial_read_committed();

  IF reservation."status" = 'CONSUMED' THEN
    SELECT
      account."balance_grant_ledger_status",
      account."balance_grant_ledger_version",
      wallet."balance_usd"
    INTO
      ledger_account_status,
      ledger_account_version,
      ledger_wallet_balance
    FROM "billing_accounts" AS account
    JOIN "account_wallets" AS wallet
      ON wallet."billing_account_id" = account."id"
    WHERE account."id" = reservation."billing_account_id";
    IF NOT FOUND
       OR ledger_account_status IS DISTINCT FROM 'RECONCILED_V2'
       OR ledger_account_version IS DISTINCT FROM 2 THEN
      RAISE EXCEPTION 'gateway terminal settlement requires reconciled v2 ledger'
        USING ERRCODE = '55000';
    END IF;

    SELECT * INTO usage
    FROM "token_usage"
    WHERE "gateway_billing_event_id" = reservation."gateway_billing_event_id";
    IF NOT FOUND
       OR usage."request_id" IS DISTINCT FROM reservation."request_id"
       OR usage."api_key_id" IS DISTINCT FROM reservation."api_key_id"
       OR usage."tenant_id" IS DISTINCT FROM reservation."tenant_id"
       OR usage."product_id" IS DISTINCT FROM anchor."product_id"
       OR usage."customer_funding_classification_complete" IS DISTINCT FROM TRUE
       OR usage."customer_charge_usd" IS DISTINCT FROM reservation."authoritative_amount_usd"
       OR usage."customer_collected_usd"
          + usage."customer_approved_receivable_usd"
          + usage."customer_unapproved_debt_usd"
          IS DISTINCT FROM usage."customer_charge_usd" THEN
      RAISE EXCEPTION 'gateway consumed reservation lacks matching TokenUsage proof'
        USING ERRCODE = '55000';
    END IF;

    IF usage."customer_approved_receivable_usd" > reservation."approved_credit_usd"
       OR usage."customer_collected_usd" < LEAST(
         reservation."authoritative_amount_usd",
         reservation."collected_usd"
       ) THEN
      RAISE EXCEPTION 'gateway consumed reservation exceeds frozen funding authority'
        USING ERRCODE = '55000';
    END IF;

    SELECT COUNT(*) INTO receipt_count
    FROM "gateway_usage_settlement_receipts"
    WHERE "gateway_billing_event_id" = reservation."gateway_billing_event_id"
      AND "request_id" = reservation."request_id"
      AND "token_usage_id" = usage."id"
      AND "policy_version" = 'gateway-settlement-v2';
    IF receipt_count <> 1 THEN
      RAISE EXCEPTION 'gateway consumed reservation requires exactly one v2 receipt'
        USING ERRCODE = '55000';
    END IF;

    SELECT * INTO receipt
    FROM "gateway_usage_settlement_receipts"
    WHERE "gateway_billing_event_id" = reservation."gateway_billing_event_id"
      AND "request_id" = reservation."request_id"
      AND "token_usage_id" = usage."id"
      AND "policy_version" = 'gateway-settlement-v2';
    IF receipt."amount_usd" IS DISTINCT FROM reservation."authoritative_amount_usd"
       OR receipt."anchor_hash" IS DISTINCT FROM reservation."anchor_hash"
       OR receipt."pricing_hash" IS DISTINCT FROM anchor."pricing_hash"
       OR receipt."billing_unit" IS DISTINCT FROM 'BALANCE'
       OR receipt."billing_currency" IS DISTINCT FROM reservation."billing_currency"
       OR receipt."evidence_hash" IS NULL
       OR receipt."settlement_fingerprint" IS NULL
       OR NOT EXISTS (
         SELECT 1
         FROM "gateway_usage_evidences" AS selected_evidence
         WHERE selected_evidence."gateway_billing_event_id" =
             reservation."gateway_billing_event_id"
           AND selected_evidence."request_id" = reservation."request_id"
           AND selected_evidence."evidence_hash" = receipt."evidence_hash"
       )
       OR (
         usage."customer_unapproved_debt_usd" > 0
         AND receipt."funding_outcome" IS DISTINCT FROM 'DEBT_OPEN'
       )
       OR (
         usage."customer_unapproved_debt_usd" = 0
         AND usage."customer_approved_receivable_usd" > 0
         AND receipt."funding_outcome" IS DISTINCT FROM 'RECEIVABLE'
       )
       OR (
         usage."customer_unapproved_debt_usd" = 0
         AND usage."customer_approved_receivable_usd" = 0
         AND receipt."funding_outcome" IS DISTINCT FROM 'COLLECTED'
       ) THEN
      RAISE EXCEPTION 'gateway consumed reservation v2 receipt is inconsistent'
        USING ERRCODE = '55000';
    END IF;

    IF current_gateway_usage_evidence_contract_mode() IS DISTINCT FROM 'SHADOW'
       AND NOT gateway_usage_evidence_has_current_build_authority(
         reservation."gateway_billing_event_id",
         reservation."request_id",
         receipt."evidence_hash"
       ) THEN
      RAISE EXCEPTION 'gateway financial settlement build authority is not current'
        USING ERRCODE = '55000';
    END IF;

    SELECT * INTO balance_tx
    FROM "balance_transactions"
    WHERE "token_usage_id" = usage."id";
    balance_tx_found := FOUND;
    balance_tx_id := CASE WHEN balance_tx_found THEN balance_tx."id" ELSE NULL END;
    IF reservation."authoritative_amount_usd" > 0 AND NOT balance_tx_found THEN
      RAISE EXCEPTION 'gateway consumed reservation lacks balance transaction'
        USING ERRCODE = '55000';
    END IF;
    IF reservation."authoritative_amount_usd" = 0 AND balance_tx_found THEN
      RAISE EXCEPTION 'gateway zero-price settlement must not create balance transaction'
        USING ERRCODE = '55000';
    END IF;
    IF balance_tx_found AND (
      balance_tx."billing_account_id" IS DISTINCT FROM reservation."billing_account_id"
      OR balance_tx."tenant_id" IS DISTINCT FROM reservation."tenant_id"
      OR balance_tx."user_id" IS DISTINCT FROM reservation."user_id"
      OR balance_tx."type"::TEXT IS DISTINCT FROM 'CONSUME'
      OR balance_tx."amount_usd" IS DISTINCT FROM -reservation."authoritative_amount_usd"
    ) THEN
      RAISE EXCEPTION 'gateway consumed reservation balance transaction is inconsistent'
        USING ERRCODE = '55000';
    END IF;

    IF reservation."authoritative_amount_usd" > 0 THEN
      -- The ledger writer already proves append continuity while holding the
      -- wallet lock, and Release-B's deferred canonical trigger independently
      -- validates the account once per transaction. Replaying the entire
      -- immutable transaction/allocation history here duplicated that proof
      -- for each Gateway reservation, TokenUsage and receipt trigger. Bind the
      -- current settlement to the locked wallet tail in constant time instead.
      SELECT tail."id" INTO ledger_tail_transaction_id
      FROM "balance_transactions" AS tail
      WHERE tail."billing_account_id" = reservation."billing_account_id"
      ORDER BY tail."ledger_sequence" DESC
      LIMIT 1;
      IF ledger_tail_transaction_id IS DISTINCT FROM balance_tx."id"
         OR balance_tx."balance_after_usd" IS DISTINCT FROM ledger_wallet_balance THEN
        RAISE EXCEPTION 'gateway consumed reservation is not canonical wallet tail'
          USING ERRCODE = '55000';
      END IF;
    END IF;

    SELECT
      COALESCE(SUM(allocation."amount_usd"), 0),
      COALESCE(SUM(
        allocation."amount_usd"
        - allocation."approved_credit_usd"
        - allocation."unapproved_debt_usd"
      ), 0),
      COALESCE(SUM(allocation."approved_credit_usd"), 0),
      COALESCE(SUM(allocation."unapproved_debt_usd"), 0),
      COUNT(*),
      COUNT(*) FILTER (
        WHERE allocation."billing_account_id" IS DISTINCT FROM reservation."billing_account_id"
          OR allocation."tenant_id" IS DISTINCT FROM reservation."tenant_id"
          OR allocation."user_id" IS DISTINCT FROM reservation."user_id"
          OR allocation."token_usage_id" IS DISTINCT FROM usage."id"
          OR balance_tx_id IS NULL
          OR allocation."balance_transaction_id" IS DISTINCT FROM balance_tx_id
          OR allocation."funding_classification_complete" IS DISTINCT FROM TRUE
          OR (
            allocation."approved_credit_usd" > 0
            AND (
              allocation."source" IS DISTINCT FROM 'ENTERPRISE_CREDIT'
              OR allocation."credit_policy_snapshot_complete" IS DISTINCT FROM TRUE
              OR allocation."credit_policy_at" IS DISTINCT FROM
                reservation."credit_policy_at"
              OR allocation."credit_terms_days" IS DISTINCT FROM
                reservation."credit_terms_days"
              OR allocation."credit_due_at" IS DISTINCT FROM
                reservation."approved_credit_due_at"
            )
          )
      )
    INTO
      allocation_amount,
      allocation_collected_amount,
      allocation_approved_amount,
      allocation_unapproved_amount,
      allocation_count,
      invalid_allocation_count
    FROM "balance_consumption_allocations" AS allocation
    WHERE allocation."token_usage_id" = usage."id";
    IF allocation_amount IS DISTINCT FROM reservation."authoritative_amount_usd"
       OR allocation_collected_amount IS DISTINCT FROM usage."customer_collected_usd"
       OR allocation_approved_amount IS DISTINCT FROM
          usage."customer_approved_receivable_usd"
       OR allocation_approved_amount > reservation."approved_credit_usd"
       OR allocation_unapproved_amount IS DISTINCT FROM
          usage."customer_unapproved_debt_usd"
       OR invalid_allocation_count <> 0
       OR (reservation."authoritative_amount_usd" > 0 AND allocation_count = 0)
       OR (reservation."authoritative_amount_usd" = 0 AND allocation_count <> 0) THEN
      RAISE EXCEPTION 'gateway consumed reservation allocation proof is inconsistent'
        USING ERRCODE = '55000';
    END IF;

    -- The application consumes the immutable grant holds in allocation_order
    -- until min(authoritative, frozen-collected) is satisfied. The last hold
    -- may be partial, and later supplemental cash may legally consume more
    -- from the same grant, so prove a per-grant lower bound rather than exact
    -- equality with the frozen slice.
    SELECT COUNT(*) INTO invalid_reserved_grant_allocation_count
    FROM (
      SELECT
        hold."balance_grant_id",
        LEAST(
          hold."amount_usd",
          GREATEST(
            0::NUMERIC,
            LEAST(
              reservation."authoritative_amount_usd",
              reservation."collected_usd"
            ) - COALESCE(
              SUM(hold."amount_usd") OVER (
                ORDER BY hold."allocation_order"
                ROWS BETWEEN UNBOUNDED PRECEDING AND 1 PRECEDING
              ),
              0
            )
          )
        ) AS required_amount_usd
      FROM "gateway_usage_funding_reservation_grants" AS hold
      WHERE hold."funding_reservation_id" = reservation."id"
    ) AS expected_hold
    WHERE expected_hold.required_amount_usd > 0
      AND COALESCE((
        SELECT SUM(allocation."amount_usd")
        FROM "balance_consumption_allocations" AS allocation
        WHERE allocation."token_usage_id" = usage."id"
          AND allocation."balance_transaction_id" = balance_tx_id
          AND allocation."balance_grant_id" = expected_hold."balance_grant_id"
          AND allocation."source" IN ('BALANCE_GRANT', 'UNRECONCILED_GRANT')
      ), 0) < expected_hold.required_amount_usd;
    IF invalid_reserved_grant_allocation_count <> 0 THEN
      RAISE EXCEPTION 'gateway consumed reservation did not consume frozen grant prefix'
        USING ERRCODE = '55000';
    END IF;
    RETURN;
  END IF;

  IF reservation."status" = 'RELEASED' THEN
    IF reservation."release_reason" LIKE 'financial_absorption:%' THEN
      SELECT COUNT(*) INTO release_proof_count
      FROM "gateway_usage_reconciliation_actions" AS action
      JOIN "gateway_usage_settlement_receipts" AS absorbed_receipt
        ON absorbed_receipt."gateway_billing_event_id" = action."gateway_billing_event_id"
       AND absorbed_receipt."request_id" = action."request_id"
       AND absorbed_receipt."funding_outcome" = 'ABSORBED'
       AND absorbed_receipt."actor_id" = action."actor_id"
       AND absorbed_receipt."idempotency_key" = 'receipt:' || action."idempotency_key"
      WHERE action."gateway_billing_event_id" = reservation."gateway_billing_event_id"
        AND action."request_id" = reservation."request_id"
        AND action."action" = 'ABSORB'
        AND action."expected_revision" + 1 = action."resulting_revision"
        AND action."resulting_revision" = event."revision"
        AND action."resulting_revision" = absorbed_receipt."settlement_revision"
        AND btrim(action."reason") <> ''
        AND action."reason" = event."reason"
        AND action."reason" = absorbed_receipt."reason"
        AND action."actor_id" IS NOT NULL
        AND btrim(action."actor_id") <> ''
        AND action."actor_id" = absorbed_receipt."actor_id"
        AND reservation."release_reason" =
          'financial_absorption:' || action."idempotency_key"
        AND event."status" = 'ABSORBED'
        AND event."reconciliation_status" = 'CLOSED'
        AND event."funding_outcome" = 'ABSORBED'
        AND event."pending_hold_usd" = 0
        AND absorbed_receipt."policy_version" = 'manual-finance-v2'
        AND absorbed_receipt."amount_usd" = reservation."reserved_amount_usd"
        AND absorbed_receipt."anchor_hash" = reservation."anchor_hash"
        AND absorbed_receipt."pricing_hash" = anchor."pricing_hash"
        AND absorbed_receipt."billing_unit" = 'BALANCE'
        AND absorbed_receipt."billing_currency" = reservation."billing_currency"
        AND absorbed_receipt."evidence_hash" = event."evidence_hash"
        AND absorbed_receipt."settlement_fingerprint" IS NOT NULL
        AND absorbed_receipt."token_usage_id" IS NULL
        AND action."metadata"->>'protocol' = 'gateway-absorb-v2'
        AND action."metadata"->>'fundingReservationId' = reservation."id"
        AND action."metadata"->>'reservationHash' = reservation."reservation_hash"
        AND action."metadata"->>'anchorHash' = reservation."anchor_hash"
        AND action."metadata"->>'pricingHash' = anchor."pricing_hash"
        AND action."metadata"->>'evidenceHash' = absorbed_receipt."evidence_hash"
        AND action."metadata"->>'billingCurrency' = reservation."billing_currency"
        AND (action."metadata"->>'approvedAbsorptionUsd')::NUMERIC
          = reservation."reserved_amount_usd"
        AND action."metadata"->>'settlementFingerprint'
          = absorbed_receipt."settlement_fingerprint"
        AND absorbed_receipt."payload"->>'customerDeductionUsd' = '0'
        AND (absorbed_receipt."payload"->>'approvedAbsorptionUsd')::NUMERIC
          = reservation."reserved_amount_usd"
        AND absorbed_receipt."payload"->>'fundingReservationId' = reservation."id"
        AND absorbed_receipt."payload"->>'reservationHash' = reservation."reservation_hash"
        AND absorbed_receipt."payload"->>'anchorHash' = reservation."anchor_hash"
        AND absorbed_receipt."payload"->>'pricingHash' = anchor."pricing_hash"
        AND absorbed_receipt."payload"->>'evidenceHash' = absorbed_receipt."evidence_hash"
        AND absorbed_receipt."payload"->>'billingCurrency' = reservation."billing_currency"
        AND absorbed_receipt."payload"->>'settlementFingerprint'
          = absorbed_receipt."settlement_fingerprint"
        AND EXISTS (
          SELECT 1
          FROM "gateway_usage_evidences" AS selected_evidence
          WHERE selected_evidence."gateway_billing_event_id" =
              reservation."gateway_billing_event_id"
            AND selected_evidence."request_id" = reservation."request_id"
            AND selected_evidence."evidence_hash" = absorbed_receipt."evidence_hash"
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "token_usage" AS billed_usage
          WHERE billed_usage."gateway_billing_event_id" =
              reservation."gateway_billing_event_id"
        )
        AND NOT EXISTS (
          SELECT 1
          FROM "gateway_usage_settlement_receipts" AS financial_receipt
          WHERE financial_receipt."gateway_billing_event_id" =
              reservation."gateway_billing_event_id"
            AND financial_receipt."policy_version" = 'gateway-settlement-v2'
        );
    ELSIF reservation."release_reason" LIKE 'non_financial:%' THEN
      SELECT COUNT(*) INTO release_proof_count
      FROM "gateway_usage_settlement_receipts" AS no_charge_receipt
      WHERE no_charge_receipt."gateway_billing_event_id" = reservation."gateway_billing_event_id"
        AND no_charge_receipt."request_id" = reservation."request_id"
        AND no_charge_receipt."funding_outcome" = 'NO_CHARGE'
        AND no_charge_receipt."policy_version" = 'gateway-no-charge-v1'
        AND no_charge_receipt."settlement_revision" = event."revision"
        AND no_charge_receipt."amount_usd" = 0
        AND no_charge_receipt."token_usage_id" IS NULL
        AND no_charge_receipt."anchor_hash" = reservation."anchor_hash"
        AND no_charge_receipt."pricing_hash" = anchor."pricing_hash"
        AND no_charge_receipt."billing_unit" = 'BALANCE'
        AND no_charge_receipt."billing_currency" = reservation."billing_currency"
        AND no_charge_receipt."settlement_fingerprint" IS NOT NULL
        AND no_charge_receipt."reason" = event."reason"
        AND reservation."release_reason" = 'non_financial:' || event."reason"
        AND event."status" = 'SKIPPED'
        AND event."reconciliation_status" = 'CLOSED'
        AND event."funding_outcome" = 'NO_CHARGE'
        AND event."pending_exposure_usd" = 0
        AND event."pending_hold_usd" = 0
        AND event."input_tokens" = 0
        AND event."output_tokens" = 0
        AND event."cached_input_tokens" = 0
        AND event."cache_write_input_tokens" = 0
        AND event."total_tokens" = 0
        AND no_charge_receipt."payload"->>'customerDeductionUsd' = '0'
        AND no_charge_receipt."payload"->>'evidenceHash' = no_charge_receipt."evidence_hash"
        AND no_charge_receipt."payload"->>'anchorHash' = reservation."anchor_hash"
        AND no_charge_receipt."payload"->>'pricingHash' = anchor."pricing_hash"
        AND no_charge_receipt."payload"->>'settlementFingerprint'
          = no_charge_receipt."settlement_fingerprint"
        AND no_charge_receipt."payload"->>'reason' = no_charge_receipt."reason"
        AND EXISTS (
          SELECT 1 FROM "gateway_usage_evidences" AS selected_evidence
          WHERE selected_evidence."gateway_billing_event_id" =
              reservation."gateway_billing_event_id"
            AND selected_evidence."request_id" = reservation."request_id"
            AND selected_evidence."evidence_hash" = no_charge_receipt."evidence_hash"
            AND gateway_usage_evidence_has_current_build_authority(
              reservation."gateway_billing_event_id",
              reservation."request_id",
              no_charge_receipt."evidence_hash"
            )
            AND gateway_permanent_no_charge_reason(selected_evidence."raw_evidence")
              = no_charge_receipt."reason"
        )
        AND NOT EXISTS (
          SELECT 1 FROM "token_usage" AS billed_usage
          WHERE billed_usage."gateway_billing_event_id" = reservation."gateway_billing_event_id"
        )
        AND NOT EXISTS (
          SELECT 1 FROM "gateway_usage_settlement_receipts" AS financial_receipt
          WHERE financial_receipt."gateway_billing_event_id" = reservation."gateway_billing_event_id"
            AND financial_receipt."policy_version" = 'gateway-settlement-v2'
        );
    ELSE
      release_proof_count := 0;
    END IF;

    IF release_proof_count <> 1 THEN
      RAISE EXCEPTION 'gateway released reservation lacks one permanent release proof'
        USING ERRCODE = '55000';
    END IF;
    RETURN;
  END IF;

  RAISE EXCEPTION 'gateway funding reservation terminal status is invalid'
    USING ERRCODE = '55000';
END;
$$ LANGUAGE plpgsql;


-- A clean-account canonical trigger may skip the account-wide aggregate only
-- when its own row image is exactly one of the rows proven by the current
-- Gateway reservation. Any unrelated write in the same transaction returns
-- FALSE and keeps the original full-account validator.
CREATE OR REPLACE FUNCTION gateway_balance_canonical_mutation_is_current_settlement(
  target_table TEXT,
  target_operation TEXT,
  old_row JSONB,
  new_row JSONB
)
RETURNS BOOLEAN AS $$
DECLARE
  target_reservation_id TEXT;
  reservation RECORD;
  usage RECORD;
  balance_tx RECORD;
  grant_allocation_amount NUMERIC(20,12);
  grant_recognized_amount NUMERIC(20,12);
  grant_bonus_amount NUMERIC(20,12);
  ledger_tail_transaction_id TEXT;
BEGIN
  target_reservation_id := NULLIF(current_setting(
    'ruidong.gateway_consuming_reservation_id',
    TRUE
  ), '');
  IF target_reservation_id IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT * INTO reservation
  FROM "gateway_usage_funding_reservations"
  WHERE "id" = target_reservation_id
    AND "status" = 'CONSUMED';
  IF NOT FOUND
     OR new_row->>'billing_account_id' IS DISTINCT FROM reservation."billing_account_id" THEN
    RETURN FALSE;
  END IF;

  SELECT * INTO usage
  FROM "token_usage"
  WHERE "gateway_billing_event_id" = reservation."gateway_billing_event_id"
    AND "request_id" = reservation."request_id";
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;

  SELECT * INTO balance_tx
  FROM "balance_transactions"
  WHERE "token_usage_id" = usage."id";
  IF NOT FOUND
     OR balance_tx."billing_account_id" IS DISTINCT FROM reservation."billing_account_id"
     OR balance_tx."amount_usd" IS DISTINCT FROM -reservation."authoritative_amount_usd" THEN
    RETURN FALSE;
  END IF;

  IF target_table = 'account_wallets' THEN
    IF target_operation IS DISTINCT FROM 'UPDATE'
       OR (old_row->>'balance_usd')::NUMERIC
          - (new_row->>'balance_usd')::NUMERIC
          IS DISTINCT FROM reservation."authoritative_amount_usd"
       OR balance_tx."balance_after_usd" IS DISTINCT FROM
          (new_row->>'balance_usd')::NUMERIC THEN
      RETURN FALSE;
    END IF;
    SELECT tail."id" INTO ledger_tail_transaction_id
    FROM "balance_transactions" AS tail
    WHERE tail."billing_account_id" = reservation."billing_account_id"
    ORDER BY tail."ledger_sequence" DESC
    LIMIT 1;
    RETURN ledger_tail_transaction_id IS NOT DISTINCT FROM balance_tx."id";
  END IF;

  IF target_table = 'balance_transactions' THEN
    RETURN target_operation = 'INSERT'
      AND new_row->>'id' = balance_tx."id"
      AND new_row->>'token_usage_id' = usage."id";
  END IF;

  IF target_table = 'balance_consumption_allocations' THEN
    RETURN target_operation = 'INSERT'
      AND new_row->>'token_usage_id' = usage."id"
      AND new_row->>'balance_transaction_id' = balance_tx."id";
  END IF;

  IF target_table = 'balance_grants' THEN
    IF target_operation IS DISTINCT FROM 'UPDATE'
       OR old_row->>'id' IS DISTINCT FROM new_row->>'id'
       OR old_row->>'billing_account_id' IS DISTINCT FROM new_row->>'billing_account_id'
       OR old_row->>'is_expired' IS DISTINCT FROM new_row->>'is_expired' THEN
      RETURN FALSE;
    END IF;
    SELECT
      COALESCE(SUM(allocation."amount_usd"), 0),
      COALESCE(SUM(allocation."recognized_revenue_usd"), 0),
      COALESCE(SUM(allocation."bonus_consumed_usd"), 0)
    INTO
      grant_allocation_amount,
      grant_recognized_amount,
      grant_bonus_amount
    FROM "balance_consumption_allocations" AS allocation
    WHERE allocation."token_usage_id" = usage."id"
      AND allocation."balance_transaction_id" = balance_tx."id"
      AND allocation."balance_grant_id" = new_row->>'id'
      AND allocation."source" = 'BALANCE_GRANT';
    RETURN grant_allocation_amount > 0
      AND EXISTS (
        SELECT 1
        FROM "balance_grants" AS current_grant
        WHERE current_grant."id" = new_row->>'id'
          AND current_grant."remaining_amount_usd"
            = (new_row->>'remaining_amount_usd')::NUMERIC
          AND current_grant."remaining_paid_amount_usd"
            = (new_row->>'remaining_paid_amount_usd')::NUMERIC
          AND current_grant."remaining_bonus_amount_usd"
            = (new_row->>'remaining_bonus_amount_usd')::NUMERIC
      )
      AND (old_row->>'remaining_amount_usd')::NUMERIC
        - (new_row->>'remaining_amount_usd')::NUMERIC
        = grant_allocation_amount
      AND (old_row->>'remaining_paid_amount_usd')::NUMERIC
        - (new_row->>'remaining_paid_amount_usd')::NUMERIC
        = grant_recognized_amount
      AND (old_row->>'remaining_bonus_amount_usd')::NUMERIC
        - (new_row->>'remaining_bonus_amount_usd')::NUMERIC
        = grant_bonus_amount;
  END IF;

  RETURN FALSE;
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range THEN
    RETURN FALSE;
END;
$$ LANGUAGE plpgsql;

-- Preserve the established Release-B validator for every non-Gateway writer.
-- Patch its single entry point deterministically so only the row-local proof
-- above can return before the historical aggregate.
DO $gateway_canonical_fast_path$
DECLARE
  canonical_oid OID;
  canonical_definition TEXT;
  patched_definition TEXT;
  gateway_entry CONSTANT TEXT := E'BEGIN\n  IF gateway_balance_canonical_mutation_is_current_settlement(\n    TG_TABLE_NAME,\n    TG_OP,\n    CASE WHEN TG_OP = ''INSERT'' THEN NULL ELSE to_jsonb(OLD) END,\n    to_jsonb(NEW)\n  ) THEN\n    RETURN NULL;\n  END IF;\n\n  target_account_id := NEW."billing_account_id";';
BEGIN
  canonical_oid := to_regprocedure(
    'public.assert_clean_account_wallet_canonical_deferred()'
  );
  -- Release A precedes the gated Release-B contract on a greenfield install,
  -- so there is no canonical function to patch yet. The rollout carries the
  -- same final fast path and installs it after the remaining migrations. On
  -- an upgraded V2 database the function already exists and is patched here.
  IF canonical_oid IS NULL THEN
    RETURN;
  END IF;
  SELECT pg_get_functiondef(canonical_oid) INTO canonical_definition;
  IF position('gateway_balance_canonical_mutation_is_current_settlement' IN canonical_definition) > 0 THEN
    RETURN;
  END IF;
  patched_definition := regexp_replace(
    canonical_definition,
    'BEGIN[[:space:]]+target_account_id := NEW\."billing_account_id";',
    gateway_entry
  );
  IF patched_definition IS NOT DISTINCT FROM canonical_definition THEN
    RAISE EXCEPTION 'Release-B canonical validator entry is not the expected revision';
  END IF;
  EXECUTE patched_definition;
END;
$gateway_canonical_fast_path$;

-- TokenUsage remains an independent anti-bypass entry. For BALANCE it proves
-- only that the single-owner reservation reached CONSUMED; for CREDITS the
-- receipt trigger below owns the complete current-request proof.
CREATE OR REPLACE FUNCTION assert_gateway_token_usage_terminal_pair(
  target_token_usage_id TEXT
)
RETURNS VOID AS $$
DECLARE
  usage RECORD;
  anchor RECORD;
  reservation RECORD;
  receipt RECORD;
  receipt_id TEXT;
  receipt_count BIGINT;
BEGIN
  SELECT * INTO usage FROM "token_usage" WHERE "id" = target_token_usage_id;
  IF NOT FOUND OR usage."gateway_billing_event_id" IS NULL THEN
    RETURN;
  END IF;

  SELECT * INTO anchor
  FROM "gateway_usage_settlement_anchors"
  WHERE "gateway_billing_event_id" = usage."gateway_billing_event_id";
  IF NOT FOUND
     OR usage."request_id" IS DISTINCT FROM anchor."request_id"
     OR usage."api_key_id" IS DISTINCT FROM anchor."api_key_id"
     OR usage."tenant_id" IS DISTINCT FROM anchor."tenant_id"
     OR usage."product_id" IS DISTINCT FROM anchor."product_id" THEN
    RAISE EXCEPTION 'gateway TokenUsage terminal anchor binding is invalid'
      USING ERRCODE = '55000';
  END IF;

  SELECT COUNT(*), MIN(receipt_row."id")
  INTO receipt_count, receipt_id
  FROM "gateway_usage_settlement_receipts" AS receipt_row
  WHERE receipt_row."gateway_billing_event_id" = usage."gateway_billing_event_id"
    AND receipt_row."request_id" = usage."request_id"
    AND receipt_row."token_usage_id" = usage."id"
    AND receipt_row."policy_version" = 'gateway-settlement-v2';
  IF receipt_count <> 1 THEN
    RAISE EXCEPTION 'gateway TokenUsage must commit with exactly one v2 receipt'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO receipt
  FROM "gateway_usage_settlement_receipts"
  WHERE "id" = receipt_id;
  IF receipt."anchor_hash" IS DISTINCT FROM anchor."anchor_hash"
     OR receipt."pricing_hash" IS DISTINCT FROM anchor."pricing_hash"
     OR receipt."billing_unit" IS DISTINCT FROM anchor."billing_unit"
     OR receipt."billing_currency" IS DISTINCT FROM anchor."billing_currency"
     OR receipt."evidence_hash" IS NULL
     OR receipt."settlement_fingerprint" IS NULL
     OR NOT EXISTS (
       SELECT 1 FROM "gateway_usage_evidences" AS evidence
       WHERE evidence."gateway_billing_event_id" = usage."gateway_billing_event_id"
         AND evidence."request_id" = usage."request_id"
         AND evidence."evidence_hash" = receipt."evidence_hash"
     ) THEN
    RAISE EXCEPTION 'gateway TokenUsage v2 receipt binding is invalid'
      USING ERRCODE = '55000';
  END IF;

  IF anchor."billing_unit" = 'BALANCE' THEN
    SELECT * INTO reservation
    FROM "gateway_usage_funding_reservations"
    WHERE "gateway_billing_event_id" = usage."gateway_billing_event_id";
    IF NOT FOUND
       OR reservation."status" IS DISTINCT FROM 'CONSUMED'
       OR reservation."request_id" IS DISTINCT FROM usage."request_id"
       OR reservation."billing_account_id" IS DISTINCT FROM anchor."billing_account_id" THEN
      RAISE EXCEPTION 'gateway BALANCE TokenUsage requires consumed reservation'
        USING ERRCODE = '55000';
    END IF;
  ELSIF anchor."billing_unit" <> 'CREDITS' THEN
    RAISE EXCEPTION 'gateway TokenUsage anchor billing unit is invalid'
      USING ERRCODE = '55000';
  END IF;
END;
$$ LANGUAGE plpgsql;

-- The receipt owns the complete CREDITS proof. BALANCE receipts only retain a
-- lightweight link to the CONSUMED reservation whose trigger owns that proof.
CREATE OR REPLACE FUNCTION assert_gateway_financial_receipt_terminal_pair(
  target_receipt_id TEXT
)
RETURNS VOID AS $$
DECLARE
  receipt RECORD;
  usage RECORD;
  anchor RECORD;
  reservation_status TEXT;
BEGIN
  SELECT * INTO receipt
  FROM "gateway_usage_settlement_receipts"
  WHERE "id" = target_receipt_id;
  IF NOT FOUND OR receipt."policy_version" <> 'gateway-settlement-v2' THEN
    RETURN;
  END IF;
  IF receipt."token_usage_id" IS NULL THEN
    RAISE EXCEPTION 'gateway financial receipt requires TokenUsage'
      USING ERRCODE = '55000';
  END IF;

  SELECT * INTO usage FROM "token_usage" WHERE "id" = receipt."token_usage_id";
  IF NOT FOUND OR usage."gateway_billing_event_id" IS NULL THEN
    RAISE EXCEPTION 'gateway financial receipt requires Gateway-linked TokenUsage'
      USING ERRCODE = '55000';
  END IF;
  PERFORM assert_gateway_token_usage_terminal_pair(usage."id");

  SELECT * INTO anchor
  FROM "gateway_usage_settlement_anchors"
  WHERE "gateway_billing_event_id" = usage."gateway_billing_event_id";
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
     OR usage."customer_unapproved_debt_usd" IS DISTINCT FROM 0
     OR (
       current_gateway_usage_evidence_contract_mode() IS DISTINCT FROM 'SHADOW'
       AND NOT gateway_usage_evidence_has_current_build_authority(
          usage."gateway_billing_event_id",
          usage."request_id",
          receipt."evidence_hash"
        )
     ) THEN
    RAISE EXCEPTION 'gateway CREDITS receipt proof is inconsistent'
      USING ERRCODE = '55000';
  END IF;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_gateway_usage_funding_terminal_trigger()
RETURNS trigger AS $$
BEGIN
  PERFORM assert_gateway_usage_funding_terminal(NEW."id");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_gateway_token_usage_terminal_pair_trigger()
RETURNS trigger AS $$
BEGIN
  PERFORM assert_gateway_token_usage_terminal_pair(NEW."id");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;

CREATE OR REPLACE FUNCTION validate_gateway_financial_receipt_terminal_pair_trigger()
RETURNS trigger AS $$
BEGIN
  PERFORM assert_gateway_financial_receipt_terminal_pair(NEW."id");
  RETURN NULL;
END;
$$ LANGUAGE plpgsql;
