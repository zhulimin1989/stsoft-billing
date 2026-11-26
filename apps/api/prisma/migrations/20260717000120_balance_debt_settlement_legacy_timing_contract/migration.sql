-- Keep the V2 debt-settlement conservation trigger strict while admitting the
-- one retired enterprise writer whose repayment and settlement timestamps were
-- produced by different statements. The exception is based on the complete
-- immutable legacy bundle proof installed by 20260717000100; it is not a time
-- tolerance and does not weaken any current writer path.

BEGIN;

CREATE OR REPLACE FUNCTION "assert_balance_debt_allocation_settlement_conservation"(
  target_allocation_id TEXT
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  allocation_row RECORD;
  settlement_amount NUMERIC;
  settlement_paid NUMERIC;
  settlement_bonus NUMERIC;
  invalid_settlement_count BIGINT;
BEGIN
  SELECT * INTO allocation_row
  FROM "balance_consumption_allocations"
  WHERE "id" = target_allocation_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'debt settlement references missing allocation: %', target_allocation_id
      USING ERRCODE = '23514';
  END IF;
  IF allocation_row."source" NOT IN ('NEGATIVE_BALANCE', 'ENTERPRISE_CREDIT') THEN
    IF EXISTS (
      SELECT 1 FROM "enterprise_credit_settlements"
      WHERE "allocation_id" = target_allocation_id
    ) THEN
      RAISE EXCEPTION 'settlement references non-debt allocation: %', target_allocation_id
        USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;

  SELECT
    COALESCE(SUM(s."amount_usd"), 0),
    COALESCE(SUM(s."paid_usd"), 0),
    COALESCE(SUM(s."bonus_usd"), 0),
    COUNT(*) FILTER (
      WHERE s."billing_account_id" IS DISTINCT FROM allocation_row."billing_account_id"
        OR s."debt_source" IS DISTINCT FROM allocation_row."source"
        OR s."amount_usd" <= 0
        OR s."paid_usd" < 0
        OR s."bonus_usd" < 0
        OR s."amount_usd" <> s."paid_usd" + s."bonus_usd"
        OR (
          s."repayment_transaction_id" IS NOT NULL
          AND NOT (
            EXISTS (
              SELECT 1
              FROM "balance_transactions" bt
              WHERE bt."id" = s."repayment_transaction_id"
                AND bt."billing_account_id" = allocation_row."billing_account_id"
                AND bt."created_at" = s."occurred_at"
            )
            OR (
              s."trigger" = 'FUNDING'
              AND s."repair_run_id" IS NULL
              AND s."debt_source" = 'ENTERPRISE_CREDIT'
              AND "balance_legacy_enterprise_settlement_timing_is_proven"(s."id")
            )
          )
        )
        OR (
          s."balance_grant_id" IS NOT NULL
          AND NOT EXISTS (
            SELECT 1
            FROM "balance_grants" bg
            WHERE bg."id" = s."balance_grant_id"
              AND bg."billing_account_id" = allocation_row."billing_account_id"
          )
        )
        OR CASE s."trigger"
          WHEN 'FUNDING' THEN
            s."repair_run_id" IS NOT NULL
            OR s."repayment_transaction_id" IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM "balance_transactions" bt
              WHERE bt."id" = s."repayment_transaction_id"
                AND bt."type"::TEXT IN ('RECHARGE', 'ADJUST')
                AND bt."amount_usd" > 0
            )
          WHEN 'REPAIR' THEN
            s."repair_run_id" IS NULL
            OR s."repayment_transaction_id" IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM "balance_ledger_repair_runs" repair_run
              WHERE repair_run."id" = s."repair_run_id"
            )
            OR NOT EXISTS (
              SELECT 1 FROM "balance_transactions" bt
              WHERE bt."id" = s."repayment_transaction_id"
                AND bt."type"::TEXT IN ('RECHARGE', 'ADJUST')
                AND bt."amount_usd" > 0
            )
          WHEN 'REFUND_NETTING' THEN
            s."repair_run_id" IS NOT NULL
            OR s."repayment_transaction_id" IS NULL
            OR s."balance_grant_id" IS NULL
            OR NOT EXISTS (
              SELECT 1 FROM "balance_transactions" bt
              WHERE bt."id" = s."repayment_transaction_id"
                AND bt."type"::TEXT = 'REFUND'
                AND bt."amount_usd" < 0
            )
          WHEN 'SWEEP' THEN
            s."repair_run_id" IS NOT NULL
            OR s."repayment_transaction_id" IS NOT NULL
            OR s."balance_grant_id" IS NOT NULL
            OR s."debt_source" <> 'ENTERPRISE_CREDIT'
          ELSE TRUE
        END
    )
  INTO settlement_amount, settlement_paid, settlement_bonus, invalid_settlement_count
  FROM "enterprise_credit_settlements" s
  WHERE s."allocation_id" = target_allocation_id;

  IF allocation_row."amount_usd" <= 0
    OR allocation_row."balance_grant_id" IS NOT NULL
    OR allocation_row."discount_rate" <> 0
    OR allocation_row."settled_usd" < 0
    OR allocation_row."settled_usd" > allocation_row."amount_usd"
    OR allocation_row."recognized_revenue_usd" < 0
    OR allocation_row."bonus_consumed_usd" < 0
    OR allocation_row."recognized_revenue_usd"
      + allocation_row."bonus_consumed_usd" <> allocation_row."settled_usd"
    OR (allocation_row."settled_usd" = allocation_row."amount_usd")
      IS DISTINCT FROM (allocation_row."settled_at" IS NOT NULL)
    OR settlement_amount IS DISTINCT FROM allocation_row."settled_usd"
    OR settlement_paid IS DISTINCT FROM allocation_row."recognized_revenue_usd"
    OR settlement_bonus IS DISTINCT FROM allocation_row."bonus_consumed_usd"
    OR invalid_settlement_count <> 0
  THEN
    RAISE EXCEPTION
      'debt allocation settlement conservation invalid allocation=% settled=%/% paid=%/% bonus=%/% invalid=%',
      target_allocation_id,
      allocation_row."settled_usd", settlement_amount,
      allocation_row."recognized_revenue_usd", settlement_paid,
      allocation_row."bonus_consumed_usd", settlement_bonus,
      invalid_settlement_count
      USING ERRCODE = '23514';
  END IF;
END
$$;

COMMIT;
