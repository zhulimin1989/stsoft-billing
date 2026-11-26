-- Enterprise accounts use credit only while the current configuration is
-- explicitly ACTIVE.  A missing, DISABLED or SUSPENDED current configuration
-- is a zero-credit prepaid policy; historical events do not authorize or block
-- that current policy.
ALTER TABLE "gateway_usage_funding_reservations"
  DROP CONSTRAINT "gateway_usage_funding_reservations_credit_source_check",
  ADD CONSTRAINT "gateway_usage_funding_reservations_credit_source_check" CHECK (
    "credit_policy_source" IN (
      'EVENT_OLD_STATE',
      'EVENT_NEW_STATE',
      'NO_CONFIG',
      'CURRENT_PREPAID',
      'NOT_APPLICABLE'
    )
  );

-- Preserve the full occurrence-window authority validator for every existing
-- source. CURRENT_PREPAID has a separate validator because its authority is the
-- locked current config, not historical policy reconstruction.
DROP TRIGGER gateway_usage_funding_reservations_anchor_bind
  ON "gateway_usage_funding_reservations";

CREATE TRIGGER gateway_usage_funding_reservations_anchor_bind
  BEFORE INSERT ON "gateway_usage_funding_reservations"
  FOR EACH ROW
  WHEN (NEW."credit_policy_source" <> 'CURRENT_PREPAID')
  EXECUTE FUNCTION validate_gateway_usage_funding_reservation_anchor();

CREATE OR REPLACE FUNCTION validate_gateway_current_prepaid_reservation()
RETURNS trigger AS $$
DECLARE
  anchor RECORD;
  account_row RECORD;
  tenant_row RECORD;
  current_credit_status TEXT;
  config_found BOOLEAN := false;
  prior_reserved_usd NUMERIC(20,12) := 0;
  allowance_funded_capacity_usd NUMERIC(20,12) := 0;
BEGIN
  SELECT
    settlement_anchor."request_id",
    settlement_anchor."api_key_id",
    settlement_anchor."user_id",
    settlement_anchor."tenant_id",
    settlement_anchor."billing_account_id",
    settlement_anchor."billing_unit",
    settlement_anchor."billing_currency",
    settlement_anchor."occurred_at",
    settlement_anchor."first_received_at",
    settlement_anchor."first_receipt_sequence",
    settlement_anchor."funding_reservation_protocol",
    settlement_anchor."anchor_hash",
    event."request_id" AS event_request_id
  INTO anchor
  FROM "gateway_usage_settlement_anchors" AS settlement_anchor
  JOIN "gateway_billing_events" AS event
    ON event."id" = settlement_anchor."gateway_billing_event_id"
  WHERE settlement_anchor."gateway_billing_event_id" = NEW."gateway_billing_event_id"
  FOR KEY SHARE OF settlement_anchor, event;

  IF NOT FOUND
     OR anchor."request_id" IS DISTINCT FROM NEW."request_id"
     OR anchor.event_request_id IS DISTINCT FROM NEW."request_id"
     OR anchor."api_key_id" IS DISTINCT FROM NEW."api_key_id"
     OR anchor."user_id" IS DISTINCT FROM NEW."user_id"
     OR anchor."tenant_id" IS DISTINCT FROM NEW."tenant_id"
     OR anchor."billing_account_id" IS DISTINCT FROM NEW."billing_account_id"
     OR anchor."billing_unit" IS DISTINCT FROM 'BALANCE'
     OR NEW."billing_unit" IS DISTINCT FROM 'BALANCE'
     OR anchor."billing_currency" IS DISTINCT FROM NEW."billing_currency"
     OR anchor."occurred_at" IS DISTINCT FROM NEW."occurred_at"
     OR anchor."first_received_at" IS DISTINCT FROM NEW."first_received_at"
     OR anchor."first_receipt_sequence" IS DISTINCT FROM NEW."reservation_sequence"
     OR anchor."funding_reservation_protocol" IS DISTINCT FROM 'V1'
     OR anchor."anchor_hash" IS DISTINCT FROM NEW."anchor_hash"
     OR NEW."status" IS DISTINCT FROM 'ACTIVE' THEN
    RAISE EXCEPTION 'gateway current prepaid reservation does not match immutable anchor'
      USING ERRCODE = '55000';
  END IF;

  -- Keep the same aggregate lock order as Billing and credit-policy writers.
  PERFORM 1
  FROM "account_wallets"
  WHERE "billing_account_id" = NEW."billing_account_id"
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gateway current prepaid account wallet is missing'
      USING ERRCODE = '55000';
  END IF;

  PERFORM "id"
  FROM "balance_grants"
  WHERE "billing_account_id" = NEW."billing_account_id"
  ORDER BY "id" ASC
  FOR UPDATE;

  PERFORM 1
  FROM "billing_accounts"
  WHERE "id" = NEW."billing_account_id"
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gateway current prepaid billing account is missing'
      USING ERRCODE = '55000';
  END IF;

  SELECT account.*, wallet."balance_usd" AS wallet_balance_usd
  INTO account_row
  FROM "billing_accounts" AS account
  JOIN "account_wallets" AS wallet
    ON wallet."billing_account_id" = account."id"
  WHERE account."id" = NEW."billing_account_id";
  IF NOT FOUND
     OR account_row."type" IS DISTINCT FROM 'enterprise'
     OR account_row."status" IS DISTINCT FROM 'active'
     OR account_row."currency" IS DISTINCT FROM NEW."billing_currency" THEN
    RAISE EXCEPTION 'gateway current prepaid account authority is invalid'
      USING ERRCODE = '55000';
  END IF;

  IF NEW."approved_credit_usd" <> 0
     OR NEW."credit_policy_event_id" IS NOT NULL
     OR NEW."credit_policy_revision" IS NOT NULL
     OR NEW."credit_policy_source" IS DISTINCT FROM 'CURRENT_PREPAID'
     OR NEW."credit_policy_reconstructible" IS DISTINCT FROM TRUE
     OR NEW."credit_configured_limit_usd" <> 0
     OR NEW."credit_limit_usd" <> 0
     OR NEW."credit_terms_days" IS NOT NULL
     OR NEW."approved_credit_due_at" IS NOT NULL
     OR NEW."credit_status" IS NOT NULL
     OR NEW."credit_effective_at" IS NOT NULL
     OR NEW."credit_expires_at" IS NOT NULL THEN
    RAISE EXCEPTION 'gateway current prepaid reservation contains credit'
      USING ERRCODE = '55000';
  END IF;

  SELECT "status" INTO current_credit_status
  FROM "billing_account_credit_configs"
  WHERE "billing_account_id" = NEW."billing_account_id"
  FOR UPDATE;
  config_found := FOUND;
  IF config_found
     AND current_credit_status NOT IN ('DISABLED', 'SUSPENDED') THEN
    RAISE EXCEPTION 'gateway current prepaid policy requires credit to be disabled'
      USING ERRCODE = '55000';
  END IF;

  SELECT tenant."balance_allowance_usd", tenant."balance_allowance_used_usd"
  INTO tenant_row
  FROM "tenants" AS tenant
  WHERE tenant."id" = NEW."tenant_id"
  FOR UPDATE;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'gateway current prepaid tenant authority is invalid'
      USING ERRCODE = '55000';
  END IF;

  SELECT COALESCE(SUM(reservation."reserved_amount_usd"), 0)
  INTO prior_reserved_usd
  FROM "gateway_usage_funding_reservations" AS reservation
  WHERE reservation."billing_account_id" = NEW."billing_account_id"
    AND reservation."status" IN ('ACTIVE', 'MANUAL_REVIEW');
  allowance_funded_capacity_usd := NEW."collected_usd";
  IF tenant_row."balance_allowance_usd" IS NOT NULL
     AND allowance_funded_capacity_usd > GREATEST(
       0,
       tenant_row."balance_allowance_usd"
         - tenant_row."balance_allowance_used_usd"
         - prior_reserved_usd
     ) THEN
    RAISE EXCEPTION 'gateway current prepaid reservation exceeds workspace allowance authority'
      USING ERRCODE = '55000';
  END IF;

  RETURN NEW;
END;
$$ LANGUAGE plpgsql;

CREATE TRIGGER gateway_usage_funding_reservations_current_prepaid_bind
  BEFORE INSERT ON "gateway_usage_funding_reservations"
  FOR EACH ROW
  WHEN (NEW."credit_policy_source" = 'CURRENT_PREPAID')
  EXECUTE FUNCTION validate_gateway_current_prepaid_reservation();
