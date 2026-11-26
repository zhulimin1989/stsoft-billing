-- Extend the V2 canonical proof without mutating the deployed
-- 20260715000100 migration.  The normal equal-timestamp funding path remains
-- unchanged; only the explicitly proven legacy order lifecycle is added.

BEGIN;

-- Legacy recharge writers persisted the order, funding transaction and grant
-- in one fulfillment transaction but sourced their timestamps from separate
-- now() calls.  A timestamp mismatch is accepted only when the complete,
-- immutable order lifecycle proves that these rows are the one recharge fact.
CREATE OR REPLACE FUNCTION "balance_legacy_order_recharge_timing_is_proven"(
  target_account_id TEXT,
  target_funding_id TEXT,
  target_grant_id TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT EXISTS (
    SELECT 1
    FROM "balance_transactions" funding
    JOIN "balance_grants" grant_row
      ON grant_row."id" = target_grant_id
    JOIN "orders" order_row
      ON order_row."id" = funding."order_id"
      AND order_row."id" = grant_row."order_id"
    WHERE funding."id" = target_funding_id
      AND funding."billing_account_id" = target_account_id
      AND grant_row."billing_account_id" = target_account_id
      AND order_row."billing_account_id" = target_account_id
      AND funding."type"::TEXT = 'RECHARGE'
      AND funding."amount_usd" > 0
      AND funding."operation_key" IS NULL
      AND grant_row."source" = 'RECHARGE'
      AND grant_row."created_at" <> funding."created_at"
      AND order_row."order_type"::TEXT = 'RECHARGE'
      AND order_row."status"::TEXT = 'COMPLETED'
      AND lower(trim(order_row."currency")) ~ '^[a-z]{3}$'
      AND order_row."refunded_at" IS NULL
      AND order_row."refund_amount_cents" IS NULL
      AND order_row."paid_at" IS NOT NULL
      AND order_row."completed_at" IS NOT NULL
      AND order_row."created_at" <= order_row."paid_at"
      AND order_row."paid_at" <= order_row."completed_at"
      AND funding."created_at"
        BETWEEN order_row."paid_at" AND order_row."completed_at"
      AND grant_row."created_at"
        BETWEEN order_row."paid_at" AND order_row."completed_at"
      AND grant_row."valid_from"
        BETWEEN order_row."paid_at" AND order_row."completed_at"
      AND grant_row."valid_from" <= grant_row."created_at"
      AND order_row."user_id" = funding."user_id"
      AND order_row."user_id" = grant_row."user_id"
      AND order_row."tenant_id" = funding."tenant_id"
      AND order_row."tenant_id" = grant_row."tenant_id"
      AND order_row."product_id" IS NOT DISTINCT FROM funding."product_id"
      AND order_row."product_id" IS NOT DISTINCT FROM grant_row."product_id"
      AND funding."amount_usd" = order_row."amount_cents"::NUMERIC / 100
      AND grant_row."paid_amount_usd" = order_row."amount_cents"::NUMERIC / 100
      AND order_row."bonus_cents" >= 0
      AND grant_row."bonus_amount_usd" = order_row."bonus_cents"::NUMERIC / 100
      AND grant_row."granted_amount_usd"
        = (order_row."amount_cents" + order_row."bonus_cents")::NUMERIC / 100
      AND (
        SELECT COUNT(*) FROM "orders" same_order
        WHERE same_order."id" = order_row."id"
      ) = 1
      AND (
        SELECT COUNT(*) FROM "balance_transactions" paid_tx
        WHERE paid_tx."order_id" = order_row."id"
          AND paid_tx."type"::TEXT = 'RECHARGE'
      ) = 1
      AND (
        SELECT COUNT(*) FROM "balance_grants" same_grant
        WHERE same_grant."order_id" = order_row."id"
      ) = 1
      AND (
        SELECT COUNT(*) FROM "balance_transactions" bonus_tx
        WHERE bonus_tx."order_id" = order_row."id"
          AND bonus_tx."type"::TEXT = 'ADJUST'
          AND bonus_tx."amount_usd" > 0
          AND bonus_tx."description" ~ '^recharge-bonus(?: tier:[^[:space:]]+)?$'
      ) = CASE WHEN order_row."bonus_cents" > 0 THEN 1 ELSE 0 END
      AND COALESCE((
        SELECT SUM(bonus_tx."amount_usd")
        FROM "balance_transactions" bonus_tx
        WHERE bonus_tx."order_id" = order_row."id"
          AND bonus_tx."type"::TEXT = 'ADJUST'
          AND bonus_tx."amount_usd" > 0
          AND bonus_tx."description" ~ '^recharge-bonus(?: tier:[^[:space:]]+)?$'
      ), 0) = order_row."bonus_cents"::NUMERIC / 100
      AND NOT EXISTS (
        SELECT 1
        FROM "balance_transactions" bonus_tx
        WHERE bonus_tx."order_id" = order_row."id"
          AND bonus_tx."type"::TEXT = 'ADJUST'
          AND bonus_tx."amount_usd" > 0
          AND bonus_tx."description" ~ '^recharge-bonus(?: tier:[^[:space:]]+)?$'
          AND (
            bonus_tx."billing_account_id" IS DISTINCT FROM target_account_id
            OR bonus_tx."user_id" IS DISTINCT FROM order_row."user_id"
            OR bonus_tx."tenant_id" IS DISTINCT FROM order_row."tenant_id"
            OR bonus_tx."product_id" IS DISTINCT FROM order_row."product_id"
            OR bonus_tx."operation_key" IS NOT NULL
            OR bonus_tx."created_at" < order_row."paid_at"
            OR bonus_tx."created_at" > order_row."completed_at"
          )
      )
      AND NOT EXISTS (
        SELECT 1
        FROM "balance_transactions" unexpected_funding
        WHERE unexpected_funding."order_id" = order_row."id"
          AND unexpected_funding."amount_usd" > 0
          AND unexpected_funding."id" <> funding."id"
          AND NOT (
            unexpected_funding."type"::TEXT = 'ADJUST'
            AND unexpected_funding."description" ~ '^recharge-bonus(?: tier:[^[:space:]]+)?$'
          )
      )
  )
$$;

-- The historical admin voucher writer committed one exact idempotency receipt
-- around grant -> funding -> debt-settlement writes.  It is the only durable
-- link for rows that predate operation_key and whose database/application
-- timestamps differ.  Parse defensively and accept the exact response schema;
-- malformed JSON must quarantine rather than escape through a cast error.
CREATE OR REPLACE FUNCTION "balance_legacy_voucher_receipt_matches"(
  evidence JSONB,
  target_account_id TEXT,
  target_funding_id TEXT,
  target_grant_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  funding RECORD;
  grant_row RECORD;
  result_row JSONB;
  receipt_transaction JSONB;
  receipt_grant JSONB;
  evidence_keys TEXT[];
  result_keys TEXT[];
  transaction_keys TEXT[];
  grant_keys TEXT[];
  evidence_created_at TIMESTAMP(3);
  evidence_expires_at TIMESTAMP(3);
  receipt_transaction_at TIMESTAMP(3);
  receipt_grant_expires_at TIMESTAMP(3);
  amount_cents NUMERIC;
  balance_after_cents NUMERIC;
  issuance_remaining_cents NUMERIC;
BEGIN
  IF jsonb_typeof(evidence) <> 'object' THEN
    RETURN FALSE;
  END IF;
  SELECT COALESCE(array_agg(key ORDER BY key), ARRAY[]::TEXT[])
    INTO evidence_keys
  FROM jsonb_object_keys(evidence) key;
  IF evidence_keys <> ARRAY[
    'createdAt', 'expiresAt', 'key', 'result', 'scope', 'status', 'userId'
  ]::TEXT[] THEN
    RETURN FALSE;
  END IF;
  IF jsonb_typeof(evidence->'createdAt') <> 'string'
    OR jsonb_typeof(evidence->'expiresAt') <> 'string'
    OR jsonb_typeof(evidence->'key') <> 'string'
    OR jsonb_typeof(evidence->'scope') <> 'string'
    OR jsonb_typeof(evidence->'status') <> 'string'
    OR jsonb_typeof(evidence->'userId') <> 'string'
    OR jsonb_typeof(evidence->'result') <> 'object'
  THEN
    RETURN FALSE;
  END IF;

  result_row := evidence->'result';
  SELECT COALESCE(array_agg(key ORDER BY key), ARRAY[]::TEXT[])
    INTO result_keys
  FROM jsonb_object_keys(result_row) key;
  IF result_keys <> ARRAY['grant', 'transaction']::TEXT[]
    OR jsonb_typeof(result_row->'transaction') <> 'object'
    OR jsonb_typeof(result_row->'grant') <> 'object'
  THEN
    RETURN FALSE;
  END IF;
  receipt_transaction := result_row->'transaction';
  receipt_grant := result_row->'grant';
  SELECT COALESCE(array_agg(key ORDER BY key), ARRAY[]::TEXT[])
    INTO transaction_keys
  FROM jsonb_object_keys(receipt_transaction) key;
  SELECT COALESCE(array_agg(key ORDER BY key), ARRAY[]::TEXT[])
    INTO grant_keys
  FROM jsonb_object_keys(receipt_grant) key;
  IF transaction_keys <> ARRAY[
      'amountCents', 'amountUsd', 'balanceAfterCents', 'balanceAfterUsd',
      'createdAt', 'description', 'id', 'productId', 'tenantId', 'type', 'userId'
    ]::TEXT[]
    OR grant_keys <> ARRAY[
      'amountCents', 'bonusAmountCents', 'discountRate', 'expiresAt', 'id',
      'paidAmountCents', 'productId', 'remainingCents', 'source'
    ]::TEXT[]
  THEN
    RETURN FALSE;
  END IF;
  IF jsonb_typeof(receipt_transaction->'id') <> 'string'
    OR jsonb_typeof(receipt_transaction->'type') <> 'string'
    OR jsonb_typeof(receipt_transaction->'userId') <> 'string'
    OR jsonb_typeof(receipt_transaction->'tenantId') <> 'string'
    OR jsonb_typeof(receipt_transaction->'amountUsd') <> 'number'
    OR jsonb_typeof(receipt_transaction->'createdAt') <> 'string'
    OR jsonb_typeof(receipt_transaction->'productId') NOT IN ('string', 'null')
    OR jsonb_typeof(receipt_transaction->'amountCents') <> 'number'
    OR jsonb_typeof(receipt_transaction->'description') <> 'string'
    OR jsonb_typeof(receipt_transaction->'balanceAfterUsd') <> 'number'
    OR jsonb_typeof(receipt_transaction->'balanceAfterCents') <> 'number'
    OR jsonb_typeof(receipt_grant->'id') <> 'string'
    OR jsonb_typeof(receipt_grant->'source') <> 'string'
    OR jsonb_typeof(receipt_grant->'expiresAt') NOT IN ('string', 'null')
    OR jsonb_typeof(receipt_grant->'productId') NOT IN ('string', 'null')
    OR jsonb_typeof(receipt_grant->'amountCents') <> 'number'
    OR jsonb_typeof(receipt_grant->'discountRate') <> 'number'
    OR jsonb_typeof(receipt_grant->'remainingCents') <> 'number'
    OR jsonb_typeof(receipt_grant->'paidAmountCents') <> 'number'
    OR jsonb_typeof(receipt_grant->'bonusAmountCents') <> 'number'
  THEN
    RETURN FALSE;
  END IF;

  SELECT * INTO funding
  FROM "balance_transactions"
  WHERE "id" = target_funding_id
    AND "billing_account_id" = target_account_id;
  SELECT * INTO grant_row
  FROM "balance_grants"
  WHERE "id" = target_grant_id
    AND "billing_account_id" = target_account_id;
  IF funding."id" IS NULL OR grant_row."id" IS NULL THEN
    RETURN FALSE;
  END IF;

  evidence_created_at := (evidence->>'createdAt')::TIMESTAMPTZ AT TIME ZONE 'UTC';
  evidence_expires_at := (evidence->>'expiresAt')::TIMESTAMPTZ AT TIME ZONE 'UTC';
  receipt_transaction_at :=
    (receipt_transaction->>'createdAt')::TIMESTAMPTZ AT TIME ZONE 'UTC';
  receipt_grant_expires_at := CASE
    WHEN jsonb_typeof(receipt_grant->'expiresAt') = 'null' THEN NULL
    ELSE (receipt_grant->>'expiresAt')::TIMESTAMPTZ AT TIME ZONE 'UTC'
  END;
  amount_cents := ROUND(funding."amount_usd" * 100, 0);
  balance_after_cents := ROUND(funding."balance_after_usd" * 100, 0);
  issuance_remaining_cents := ROUND((
    funding."amount_usd" - LEAST(
      funding."amount_usd",
      GREATEST(-(funding."balance_after_usd" - funding."amount_usd"), 0)
    )
  ) * 100, 0);

  RETURN evidence->>'scope' = 'admin:issue-voucher'
    AND evidence->>'status' = 'COMMITTED'
    AND evidence->>'userId' = funding."user_id"
    AND length(evidence->>'key') BETWEEN 1 AND 160
    AND evidence->>'key' !~ '[[:space:]]'
    AND evidence_created_at <= grant_row."valid_from"
    AND grant_row."valid_from" <= grant_row."created_at"
    AND grant_row."created_at" <= funding."created_at"
    AND funding."created_at" < evidence_expires_at
    AND funding."type"::TEXT = 'ADJUST'
    AND funding."amount_usd" > 0
    AND funding."operation_key" IS NULL
    AND funding."order_id" IS NULL
    AND funding."description"
      ~ '^voucher:[^[:space:]]+[[:space:]]+[^[:space:]](?:.*[^[:space:]])?$'
    AND substring(funding."description" FROM '^voucher:([^[:space:]]+)')
      = grant_row."id"
    AND grant_row."source" = 'VOUCHER'
    AND grant_row."order_id" IS NULL
    AND grant_row."user_id" = funding."user_id"
    AND grant_row."tenant_id" = funding."tenant_id"
    AND grant_row."product_id" IS NOT DISTINCT FROM funding."product_id"
    AND grant_row."paid_amount_usd" = 0
    AND grant_row."bonus_amount_usd" = funding."amount_usd"
    AND grant_row."granted_amount_usd" = funding."amount_usd"
    AND grant_row."discount_rate" = 0
    AND funding."amount_usd" = amount_cents / 100
    AND (grant_row."expires_at" IS NULL OR grant_row."expires_at" > grant_row."valid_from")
    AND receipt_transaction->>'id' = funding."id"
    AND receipt_transaction->>'type' = funding."type"::TEXT
    AND receipt_transaction->>'userId' = funding."user_id"
    AND receipt_transaction->>'tenantId' = funding."tenant_id"
    AND receipt_transaction->>'productId' IS NOT DISTINCT FROM funding."product_id"
    AND receipt_transaction_at = funding."created_at"
    AND receipt_transaction->>'description' = funding."description"
    AND (receipt_transaction->>'amountUsd')::NUMERIC = funding."amount_usd"
    AND (receipt_transaction->>'balanceAfterUsd')::NUMERIC = funding."balance_after_usd"
    AND (receipt_transaction->>'amountCents')::NUMERIC = amount_cents
    AND (receipt_transaction->>'balanceAfterCents')::NUMERIC = balance_after_cents
    AND receipt_grant->>'id' = grant_row."id"
    AND receipt_grant->>'source' = grant_row."source"
    AND receipt_grant->>'productId' IS NOT DISTINCT FROM grant_row."product_id"
    AND receipt_grant_expires_at IS NOT DISTINCT FROM grant_row."expires_at"
    AND (receipt_grant->>'amountCents')::NUMERIC = amount_cents
    AND (receipt_grant->>'discountRate')::NUMERIC = 0
    AND (receipt_grant->>'remainingCents')::NUMERIC = issuance_remaining_cents
    AND (receipt_grant->>'paidAmountCents')::NUMERIC = 0
    AND (receipt_grant->>'bonusAmountCents')::NUMERIC = amount_cents;
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END
$$;

CREATE OR REPLACE FUNCTION "balance_legacy_voucher_funding_is_proven"(
  target_account_id TEXT,
  target_funding_id TEXT,
  target_grant_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  live_count BIGINT;
  live_match_count BIGINT;
  audit_count BIGINT;
  audit_match_count BIGINT;
BEGIN
  SELECT COUNT(*), COUNT(*) FILTER (
    WHERE "balance_legacy_voucher_receipt_matches"(
      jsonb_build_object(
        'key', idem."key",
        'scope', idem."scope",
        'userId', idem."user_id",
        'status', idem."status",
        'result', idem."result",
        'createdAt', idem."created_at",
        'expiresAt', idem."expires_at"
      ),
      target_account_id,
      target_funding_id,
      target_grant_id
    )
  )
  INTO live_count, live_match_count
  FROM "idempotency_keys" idem
  WHERE idem."scope" = 'admin:issue-voucher'
    AND (
      idem."result" #>> '{transaction,id}' = target_funding_id
      OR idem."result" #>> '{grant,id}' = target_grant_id
    );
  -- A present operational receipt is authoritative. Contradictory or
  -- duplicate live evidence must never fall through to an older audit copy.
  IF live_count <> 0 THEN
    RETURN live_count = 1 AND live_match_count = 1;
  END IF;

  SELECT COUNT(*), COUNT(*) FILTER (
    WHERE "balance_legacy_voucher_receipt_matches"(
      evidence,
      target_account_id,
      target_funding_id,
      target_grant_id
    )
  )
  INTO audit_count, audit_match_count
  FROM "billing_accounts" account_row
  JOIN "balance_ledger_repair_accounts" repair_account
    ON repair_account."billing_account_id" = account_row."id"
    AND repair_account."status" = 'APPLIED'
    AND repair_account."after_snapshot" IS NOT NULL
    AND repair_account."replay_hash" = account_row."balance_grant_ledger_hash"
  JOIN "balance_ledger_repair_runs" repair_run
    ON repair_run."id" = repair_account."run_id"
    AND repair_run."status" IN ('RUNNING', 'COMPLETED', 'COMPLETED_WITH_EXCEPTIONS')
  CROSS JOIN LATERAL jsonb_array_elements(COALESCE(
    repair_account."before_snapshot"->'voucherIdempotencyEvidence',
    '[]'::JSONB
  )) evidence
  WHERE account_row."id" = target_account_id
    AND account_row."balance_grant_ledger_status" = 'RECONCILED_V2'
    AND account_row."balance_grant_ledger_version" = 2
    AND repair_account."before_snapshot"->>'billingAccountId' = target_account_id
    AND (
      evidence #>> '{result,transaction,id}' = target_funding_id
      OR evidence #>> '{result,grant,id}' = target_grant_id
    );
  RETURN audit_count = 1 AND audit_match_count = 1;
END
$$;

-- The pre-V2 enterprise settlement writer inserted the repayment first,
-- reused one application timestamp for every allocation it fully closed, and
-- inserted one settlement per allocation afterwards.  V2 expansion then set
-- occurred_at=created_at and operation_key=legacy:<id>.  Prove the complete
-- bundle exactly; there is intentionally no time tolerance.
CREATE OR REPLACE FUNCTION "balance_legacy_enterprise_settlement_timing_is_proven"(
  target_settlement_id TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  WITH target AS (
    SELECT target_row."billing_account_id", target_row."repayment_transaction_id"
    FROM "enterprise_credit_settlements" target_row
    JOIN "billing_accounts" account_row
      ON account_row."id" = target_row."billing_account_id"
      AND account_row."type" = 'enterprise'
    WHERE target_row."id" = target_settlement_id
      AND target_row."repayment_transaction_id" IS NOT NULL
  ), funding AS (
    SELECT funding_row.*
    FROM target
    JOIN "balance_transactions" funding_row
      ON funding_row."id" = target."repayment_transaction_id"
      AND funding_row."billing_account_id" = target."billing_account_id"
    WHERE funding_row."type"::TEXT IN ('RECHARGE', 'ADJUST')
      AND funding_row."amount_usd" > 0
      AND funding_row."operation_key" IS NULL
  ), bundle AS (
    SELECT settlement_row.*, allocation_row."id" AS proven_allocation_id,
      allocation_row."billing_account_id" AS allocation_account_id,
      allocation_row."source" AS allocation_source,
      allocation_row."balance_grant_id" AS allocation_grant_id,
      allocation_row."amount_usd" AS allocation_amount_usd,
      allocation_row."settled_usd" AS allocation_settled_usd,
      allocation_row."settled_at" AS allocation_settled_at,
      (SELECT COUNT(*)
       FROM "enterprise_credit_settlements" same_allocation
       WHERE same_allocation."allocation_id" = settlement_row."allocation_id")
        AS allocation_settlement_count
    FROM funding
    JOIN "enterprise_credit_settlements" settlement_row
      ON settlement_row."repayment_transaction_id" = funding."id"
    LEFT JOIN "balance_consumption_allocations" allocation_row
      ON allocation_row."id" = settlement_row."allocation_id"
  ), proof AS (
    SELECT funding."id" AS funding_id,
      COUNT(bundle."id") AS settlement_count,
      COUNT(DISTINCT bundle."allocation_id") AS allocation_count,
      SUM(bundle."amount_usd") AS settlement_total,
      MIN(bundle."allocation_settled_at") AS first_settled_at,
      MAX(bundle."allocation_settled_at") AS last_settled_at,
      BOOL_AND(
        bundle."billing_account_id" = funding."billing_account_id"
        AND bundle.proven_allocation_id IS NOT NULL
        AND bundle.allocation_account_id = funding."billing_account_id"
        AND bundle.allocation_source = 'ENTERPRISE_CREDIT'
        AND bundle.allocation_grant_id IS NULL
        AND bundle.allocation_amount_usd = bundle."amount_usd"
        AND bundle.allocation_settled_usd = bundle.allocation_amount_usd
        AND bundle.allocation_settled_at IS NOT NULL
        AND bundle.allocation_settlement_count = 1
        AND funding."created_at" <= bundle.allocation_settled_at
        AND bundle.allocation_settled_at <= bundle."created_at"
        AND bundle."debt_source" = 'ENTERPRISE_CREDIT'
        AND bundle."balance_grant_id" IS NULL
        AND bundle."repair_run_id" IS NULL
        AND bundle."trigger" = 'FUNDING'
        AND bundle."operation_key" = 'legacy:' || bundle."id"
        AND bundle."occurred_at" = bundle."created_at"
        AND bundle."amount_usd" > 0
        AND bundle."paid_usd" >= 0
        AND bundle."bonus_usd" >= 0
        AND bundle."amount_usd" = bundle."paid_usd" + bundle."bonus_usd"
        AND CASE funding."type"::TEXT
          WHEN 'RECHARGE' THEN
            bundle."paid_usd" = bundle."amount_usd" AND bundle."bonus_usd" = 0
          WHEN 'ADJUST' THEN
            bundle."paid_usd" = 0 AND bundle."bonus_usd" = bundle."amount_usd"
          ELSE FALSE
        END
      ) AS rows_match
    FROM funding
    JOIN bundle ON TRUE
    GROUP BY funding."id", funding."billing_account_id", funding."type",
      funding."amount_usd", funding."balance_after_usd", funding."created_at"
    HAVING SUM(bundle."amount_usd") = LEAST(
      funding."amount_usd",
      GREATEST(-(funding."balance_after_usd" - funding."amount_usd"), 0)
    )
  )
  SELECT EXISTS (
    SELECT 1
    FROM proof
    JOIN funding ON funding."id" = proof.funding_id
    WHERE proof.settlement_count > 0
      AND proof.settlement_count = proof.allocation_count
      AND proof.first_settled_at = proof.last_settled_at
      AND proof.rows_match
      AND (
        (
          funding."type"::TEXT = 'RECHARGE'
          AND funding."order_id" IS NOT NULL
          AND (
            SELECT COUNT(*)
            FROM "balance_grants" order_grant
            WHERE order_grant."billing_account_id" = funding."billing_account_id"
              AND order_grant."order_id" = funding."order_id"
          ) = 1
          AND EXISTS (
            SELECT 1
            FROM "balance_grants" order_grant
            WHERE order_grant."billing_account_id" = funding."billing_account_id"
              AND order_grant."order_id" = funding."order_id"
              AND "balance_legacy_order_recharge_timing_is_proven"(
                funding."billing_account_id",
                funding."id",
                order_grant."id"
              )
              AND (
                SELECT MAX(settlement_row."created_at")
                FROM "enterprise_credit_settlements" settlement_row
                WHERE settlement_row."repayment_transaction_id" = funding."id"
              ) <= order_grant."valid_from"
              AND order_grant."valid_from" <= order_grant."created_at"
          )
        )
        OR (
          funding."type"::TEXT = 'ADJUST'
          AND funding."order_id" IS NULL
          AND funding."description"
            ~ '^voucher:[^[:space:]]+[[:space:]]+[^[:space:]](?:.*[^[:space:]])?$'
          AND (
            SELECT COUNT(*)
            FROM "balance_grants" voucher_grant
            WHERE voucher_grant."billing_account_id" = funding."billing_account_id"
              AND voucher_grant."id" = substring(
                funding."description" FROM '^voucher:([^[:space:]]+)'
              )
              AND "balance_legacy_voucher_funding_is_proven"(
                funding."billing_account_id",
                funding."id",
                voucher_grant."id"
              )
          ) = 1
        )
      )
  )
$$;

CREATE OR REPLACE FUNCTION "balance_funding_candidates"(
  target_account_id TEXT,
  target_account_type TEXT
)
RETURNS TABLE(funding_id TEXT, grant_id TEXT, nature TEXT)
LANGUAGE sql
STABLE
AS $$
  WITH positive_funding AS (
    SELECT funding.*
    FROM "balance_transactions" funding
    WHERE funding."billing_account_id" = target_account_id
      AND funding."amount_usd" > 0
  )
  SELECT funding."id", NULL::TEXT, 'PAID'::TEXT
  FROM positive_funding funding
  WHERE target_account_type = 'enterprise'
    AND funding."type"::TEXT = 'ADJUST'
    AND funding."operation_key"
      ~ '^balance:admin-adjust:enterprise-paid-debt:[^[:space:]]+$'

  UNION ALL

  SELECT funding."id", grant_row."id", 'PAID'::TEXT
  FROM positive_funding funding
  JOIN "balance_grants" grant_row
    ON grant_row."billing_account_id" = target_account_id
    AND grant_row."order_id" = funding."order_id"
  WHERE funding."type"::TEXT = 'RECHARGE'
    AND funding."order_id" IS NOT NULL
    AND grant_row."source" = 'RECHARGE'
    AND grant_row."user_id" = funding."user_id"
    AND grant_row."tenant_id" = funding."tenant_id"
    AND grant_row."product_id" IS NOT DISTINCT FROM funding."product_id"
    AND (
      (
        grant_row."created_at" = funding."created_at"
        AND grant_row."valid_from" >= grant_row."created_at"
        AND (
          grant_row."valid_from" <= grant_row."created_at"
          OR "balance_legacy_grant_valid_from_is_repair_proven"(
            funding."id",
            grant_row."valid_from"
          )
        )
      )
      OR "balance_legacy_order_recharge_timing_is_proven"(
        target_account_id,
        funding."id",
        grant_row."id"
      )
    )
    AND (grant_row."expires_at" IS NULL OR grant_row."expires_at" > grant_row."valid_from")
    AND grant_row."paid_amount_usd" = funding."amount_usd"
    AND grant_row."bonus_amount_usd" = COALESCE((
      SELECT SUM(bonus_tx."amount_usd")
      FROM "balance_transactions" bonus_tx
      WHERE bonus_tx."billing_account_id" = target_account_id
        AND bonus_tx."order_id" = funding."order_id"
        AND bonus_tx."type"::TEXT = 'ADJUST'
        AND bonus_tx."amount_usd" > 0
        AND bonus_tx."description" ~ '^recharge-bonus(?: tier:[^[:space:]]+)?$'
    ), 0)
    AND (SELECT COUNT(*) FROM "balance_transactions" paid_tx
      WHERE paid_tx."billing_account_id" = target_account_id
        AND paid_tx."order_id" = funding."order_id"
        AND paid_tx."type"::TEXT = 'RECHARGE'
        AND paid_tx."amount_usd" > 0) = 1
    AND NOT EXISTS (
      SELECT 1 FROM "balance_transactions" unsupported
      WHERE unsupported."billing_account_id" = target_account_id
        AND unsupported."order_id" = funding."order_id"
        AND unsupported."amount_usd" > 0
        AND NOT (
          unsupported."type"::TEXT = 'RECHARGE'
          OR (
            unsupported."type"::TEXT = 'ADJUST'
            AND unsupported."description" ~ '^recharge-bonus(?: tier:[^[:space:]]+)?$'
          )
        )
    )
    AND (
      funding."operation_key" IS NULL
      OR funding."operation_key" = 'balance:recharge:' || funding."order_id" || ':paid'
    )

  UNION ALL

  SELECT funding."id", grant_row."id", 'PAID'::TEXT
  FROM positive_funding funding
  JOIN "balance_grants" grant_row
    ON grant_row."billing_account_id" = target_account_id
    AND grant_row."order_id" IS NULL
  WHERE funding."type"::TEXT = 'RECHARGE'
    AND funding."order_id" IS NULL
    AND grant_row."source" = 'RECHARGE'
    AND grant_row."user_id" = funding."user_id"
    AND grant_row."tenant_id" = funding."tenant_id"
    AND grant_row."product_id" IS NOT DISTINCT FROM funding."product_id"
    AND grant_row."paid_amount_usd" = funding."amount_usd"
    AND grant_row."bonus_amount_usd" = 0
    AND grant_row."granted_amount_usd" = funding."amount_usd"
    AND grant_row."created_at" = funding."created_at"
    AND grant_row."valid_from" >= grant_row."created_at"
    AND (
      grant_row."valid_from" <= grant_row."created_at"
      OR "balance_legacy_grant_valid_from_is_repair_proven"(
        funding."id",
        grant_row."valid_from"
      )
    )
    AND (grant_row."expires_at" IS NULL OR grant_row."expires_at" > grant_row."valid_from")
    AND (
      funding."operation_key" IS NULL
      OR funding."operation_key" = 'balance:admin-recharge:grant:' || grant_row."id"
    )
    AND (
      funding."operation_key" IS NULL
      OR funding."operation_key" ~ '^balance:admin-recharge:grant:[^[:space:]]+$'
    )

  UNION ALL

  SELECT funding."id", grant_row."id", 'BONUS'::TEXT
  FROM positive_funding funding
  JOIN "balance_transactions" paid_tx
    ON paid_tx."billing_account_id" = target_account_id
    AND paid_tx."order_id" = funding."order_id"
    AND paid_tx."type"::TEXT = 'RECHARGE'
    AND paid_tx."amount_usd" > 0
  JOIN "balance_grants" grant_row
    ON grant_row."billing_account_id" = target_account_id
    AND grant_row."order_id" = funding."order_id"
  WHERE funding."type"::TEXT = 'ADJUST'
    AND funding."amount_usd" > 0
    AND funding."order_id" IS NOT NULL
    AND funding."description" ~ '^recharge-bonus(?: tier:[^[:space:]]+)?$'
    AND grant_row."source" = 'RECHARGE'
    AND grant_row."user_id" = funding."user_id"
    AND grant_row."tenant_id" = funding."tenant_id"
    AND grant_row."product_id" IS NOT DISTINCT FROM funding."product_id"
    AND paid_tx."user_id" = grant_row."user_id"
    AND paid_tx."tenant_id" = grant_row."tenant_id"
    AND paid_tx."product_id" IS NOT DISTINCT FROM grant_row."product_id"
    AND (
      (
        grant_row."created_at" = paid_tx."created_at"
        AND grant_row."valid_from" >= grant_row."created_at"
        AND (
          grant_row."valid_from" <= grant_row."created_at"
          OR "balance_legacy_grant_valid_from_is_repair_proven"(
            paid_tx."id",
            grant_row."valid_from"
          )
        )
      )
      OR "balance_legacy_order_recharge_timing_is_proven"(
        target_account_id,
        paid_tx."id",
        grant_row."id"
      )
    )
    AND (grant_row."expires_at" IS NULL OR grant_row."expires_at" > grant_row."valid_from")
    AND funding."created_at" >= paid_tx."created_at"
    AND grant_row."paid_amount_usd" = paid_tx."amount_usd"
    AND grant_row."bonus_amount_usd" = COALESCE((
      SELECT SUM(bonus_tx."amount_usd")
      FROM "balance_transactions" bonus_tx
      WHERE bonus_tx."billing_account_id" = target_account_id
        AND bonus_tx."order_id" = funding."order_id"
        AND bonus_tx."type"::TEXT = 'ADJUST'
        AND bonus_tx."amount_usd" > 0
        AND bonus_tx."description" ~ '^recharge-bonus(?: tier:[^[:space:]]+)?$'
    ), 0)
    AND (SELECT COUNT(*) FROM "balance_transactions" paid_count
      WHERE paid_count."billing_account_id" = target_account_id
        AND paid_count."order_id" = funding."order_id"
        AND paid_count."type"::TEXT = 'RECHARGE'
        AND paid_count."amount_usd" > 0) = 1
    AND (
      paid_tx."operation_key" IS NULL
      OR paid_tx."operation_key" = 'balance:recharge:' || funding."order_id" || ':paid'
    )

  UNION ALL

  SELECT funding."id", grant_row."id", 'BONUS'::TEXT
  FROM positive_funding funding
  JOIN "balance_grants" grant_row
    ON grant_row."billing_account_id" = target_account_id
    AND grant_row."id" = substring(
      funding."description" FROM '^voucher:([^[:space:]]+)'
    )
  WHERE funding."type"::TEXT = 'ADJUST'
    AND funding."order_id" IS NULL
    AND funding."description"
      ~ '^voucher:[^[:space:]]+[[:space:]]+[^[:space:]](?:.*[^[:space:]])?$'
    AND grant_row."source" = 'VOUCHER'
    AND grant_row."user_id" = funding."user_id"
    AND grant_row."tenant_id" = funding."tenant_id"
    AND grant_row."product_id" IS NOT DISTINCT FROM funding."product_id"
    AND grant_row."order_id" IS NULL
    AND grant_row."paid_amount_usd" = 0
    AND grant_row."bonus_amount_usd" = funding."amount_usd"
    AND grant_row."granted_amount_usd" = funding."amount_usd"
    AND (
      (
        grant_row."created_at" = funding."created_at"
        AND grant_row."valid_from" >= grant_row."created_at"
        AND (
          grant_row."valid_from" <= grant_row."created_at"
          OR "balance_legacy_grant_valid_from_is_repair_proven"(
            funding."id",
            grant_row."valid_from"
          )
        )
      )
      OR "balance_legacy_voucher_funding_is_proven"(
        target_account_id,
        funding."id",
        grant_row."id"
      )
    )
    AND (grant_row."expires_at" IS NULL OR grant_row."expires_at" > grant_row."valid_from")
    AND (
      funding."operation_key" IS NULL
      OR funding."operation_key" = 'balance:voucher:grant:' || grant_row."id"
    )
    AND (SELECT COUNT(*) FROM "balance_transactions" voucher_tx
      WHERE voucher_tx."billing_account_id" = target_account_id
        AND voucher_tx."description"
          ~ '^voucher:[^[:space:]]+[[:space:]]+[^[:space:]](?:.*[^[:space:]])?$'
        AND substring(voucher_tx."description" FROM '^voucher:([^[:space:]]+)')
          = grant_row."id") = 1

$$;

-- Legacy enterprise settlements predate balance_grant_id.  Do not repair that
-- immutable foreign key: derive an effective grant only from the complete
-- historical writer fingerprint.  The first branch covers the later-DB-time
-- recharge/voucher writers proven above.  The second covers the older
-- rechargeWithBonus writer, which collapsed same-time paid and bonus legs into
-- one NULL-linked settlement against the RECHARGE transaction.
CREATE OR REPLACE FUNCTION "balance_legacy_settlement_effective_grant_id"(
  target_settlement_id TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  target_row RECORD;
  candidate_count BIGINT;
  candidate_grant_count BIGINT;
  proven_grant_id TEXT;
  funding_count BIGINT;
  candidate_funding_count BIGINT;
  paid_funding_count BIGINT;
  bonus_funding_count BIGINT;
  paid_funding_usd NUMERIC;
  bonus_funding_usd NUMERIC;
  paid_hole_usd NUMERIC;
  bonus_hole_usd NUMERIC;
  funding_rows_match BOOLEAN;
  order_count BIGINT;
  settlement_count BIGINT;
  settlement_allocation_count BIGINT;
  settlement_paid_usd NUMERIC;
  settlement_bonus_usd NUMERIC;
  settlement_rows_match BOOLEAN;
BEGIN
  SELECT settlement_row."id" AS settlement_id,
    settlement_row."billing_account_id" AS billing_account_id,
    settlement_row."repayment_transaction_id" AS repayment_transaction_id,
    settlement_row."operation_key" AS operation_key,
    settlement_row."trigger" AS settlement_trigger,
    settlement_row."repair_run_id" AS repair_run_id,
    settlement_row."debt_source" AS debt_source,
    settlement_row."amount_usd" AS amount_usd,
    settlement_row."paid_usd" AS paid_usd,
    settlement_row."bonus_usd" AS bonus_usd,
    settlement_row."occurred_at" AS occurred_at,
    settlement_row."created_at" AS settlement_created_at,
    allocation_row."id" AS allocation_id,
    allocation_row."billing_account_id" AS allocation_account_id,
    allocation_row."source" AS allocation_source,
    allocation_row."balance_grant_id" AS allocation_grant_id,
    repayment."id" AS repayment_id,
    repayment."type"::TEXT AS repayment_type,
    repayment."order_id" AS repayment_order_id,
    repayment."operation_key" AS repayment_operation_key,
    repayment."created_at" AS repayment_created_at
  INTO target_row
  FROM "enterprise_credit_settlements" settlement_row
  JOIN "billing_accounts" account_row
    ON account_row."id" = settlement_row."billing_account_id"
    AND account_row."type" = 'enterprise'
  LEFT JOIN "balance_consumption_allocations" allocation_row
    ON allocation_row."id" = settlement_row."allocation_id"
  LEFT JOIN "balance_transactions" repayment
    ON repayment."id" = settlement_row."repayment_transaction_id"
  WHERE settlement_row."id" = target_settlement_id
    AND settlement_row."balance_grant_id" IS NULL;

  IF NOT FOUND THEN
    RETURN NULL;
  END IF;

  IF target_row.allocation_id IS NULL
    OR target_row.allocation_account_id IS DISTINCT FROM target_row.billing_account_id
    OR target_row.allocation_source IS DISTINCT FROM 'ENTERPRISE_CREDIT'
    OR target_row.allocation_grant_id IS NOT NULL
    OR target_row.repayment_id IS NULL
    OR target_row.operation_key IS DISTINCT FROM 'legacy:' || target_row.settlement_id
    OR target_row.settlement_trigger IS DISTINCT FROM 'FUNDING'
    OR target_row.repair_run_id IS NOT NULL
    OR target_row.debt_source IS DISTINCT FROM 'ENTERPRISE_CREDIT'
    OR target_row.amount_usd <= 0
    OR target_row.paid_usd < 0
    OR target_row.bonus_usd < 0
    OR target_row.amount_usd IS DISTINCT FROM target_row.paid_usd + target_row.bonus_usd
  THEN
    RETURN NULL;
  END IF;

  -- The strict later-timestamp proof already validates every settlement in the
  -- repayment bundle.  Require that the repayment has exactly one canonical
  -- funding classifier and that it names one grant.
  IF "balance_legacy_enterprise_settlement_timing_is_proven"(
    target_settlement_id
  ) THEN
    SELECT COUNT(*), COUNT(DISTINCT candidate.grant_id), MIN(candidate.grant_id)
      INTO candidate_count, candidate_grant_count, proven_grant_id
    FROM "balance_funding_candidates"(
      target_row.billing_account_id,
      'enterprise'
    ) candidate
    WHERE candidate.funding_id = target_row.repayment_transaction_id
      AND candidate.grant_id IS NOT NULL;
    IF candidate_count = 1 AND candidate_grant_count = 1 THEN
      RETURN proven_grant_id;
    END IF;
    RETURN NULL;
  END IF;

  -- The oldest recharge writer used one financial timestamp and left the
  -- settlement grant link NULL.  With a bonus it attached both components to
  -- the RECHARGE repayment row.  Prove the complete order, funding, wallet-hole
  -- and settlement bundle; matching by timestamp alone is never sufficient.
  IF target_row.repayment_type IS DISTINCT FROM 'RECHARGE'
    OR target_row.repayment_order_id IS NULL
    OR target_row.repayment_operation_key IS NOT NULL
    OR target_row.occurred_at IS DISTINCT FROM target_row.repayment_created_at
    OR target_row.settlement_created_at IS DISTINCT FROM target_row.repayment_created_at
  THEN
    RETURN NULL;
  END IF;

  WITH bundle_funding AS (
    SELECT funding.*
    FROM "balance_transactions" funding
    WHERE funding."billing_account_id" = target_row.billing_account_id
      AND funding."order_id" = target_row.repayment_order_id
      AND funding."amount_usd" > 0
  ), bundle_candidates AS (
    SELECT candidate.funding_id, candidate.grant_id, candidate.nature
    FROM "balance_funding_candidates"(
      target_row.billing_account_id,
      'enterprise'
    ) candidate
    JOIN bundle_funding funding ON funding."id" = candidate.funding_id
  )
  SELECT
    (SELECT COUNT(*) FROM bundle_funding),
    COUNT(*),
    COUNT(DISTINCT candidate.funding_id),
    COUNT(DISTINCT candidate.grant_id),
    MIN(candidate.grant_id),
    COUNT(*) FILTER (WHERE candidate.nature = 'PAID'),
    COUNT(*) FILTER (WHERE candidate.nature = 'BONUS'),
    COALESCE(SUM(funding."amount_usd") FILTER (
      WHERE candidate.nature = 'PAID'
    ), 0),
    COALESCE(SUM(funding."amount_usd") FILTER (
      WHERE candidate.nature = 'BONUS'
    ), 0),
    COALESCE(SUM(LEAST(
      funding."amount_usd",
      GREATEST(-(funding."balance_after_usd" - funding."amount_usd"), 0)
    )) FILTER (WHERE candidate.nature = 'PAID'), 0),
    COALESCE(SUM(LEAST(
      funding."amount_usd",
      GREATEST(-(funding."balance_after_usd" - funding."amount_usd"), 0)
    )) FILTER (WHERE candidate.nature = 'BONUS'), 0),
    COALESCE(BOOL_AND(
      candidate.grant_id IS NOT NULL
      AND funding."operation_key" IS NULL
      AND funding."created_at" = target_row.repayment_created_at
      AND (
        (
          candidate.nature = 'PAID'
          AND funding."id" = target_row.repayment_transaction_id
          AND funding."type"::TEXT = 'RECHARGE'
        )
        OR (
          candidate.nature = 'BONUS'
          AND funding."type"::TEXT = 'ADJUST'
          AND funding."description"
            ~ '^recharge-bonus(?: tier:[^[:space:]]+)?$'
        )
      )
    ), FALSE)
  INTO funding_count, candidate_count, candidate_funding_count,
    candidate_grant_count, proven_grant_id, paid_funding_count,
    bonus_funding_count, paid_funding_usd, bonus_funding_usd,
    paid_hole_usd, bonus_hole_usd, funding_rows_match
  FROM bundle_candidates candidate
  JOIN bundle_funding funding ON funding."id" = candidate.funding_id;

  IF funding_count NOT BETWEEN 1 AND 2
    OR candidate_count <> funding_count
    OR candidate_funding_count <> funding_count
    OR candidate_grant_count <> 1
    OR paid_funding_count <> 1
    OR bonus_funding_count <> funding_count - 1
    OR NOT funding_rows_match
  THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(*) INTO order_count
  FROM "orders" order_row
  JOIN "balance_grants" grant_row
    ON grant_row."id" = proven_grant_id
    AND grant_row."billing_account_id" = target_row.billing_account_id
    AND grant_row."order_id" = order_row."id"
  JOIN "balance_transactions" repayment
    ON repayment."id" = target_row.repayment_transaction_id
  WHERE order_row."id" = target_row.repayment_order_id
    AND order_row."billing_account_id" = target_row.billing_account_id
    AND order_row."order_type"::TEXT = 'RECHARGE'
    AND order_row."status"::TEXT = 'COMPLETED'
    AND order_row."refunded_at" IS NULL
    AND order_row."refund_amount_cents" IS NULL
    AND order_row."created_at" <= order_row."paid_at"
    AND order_row."paid_at" <= repayment."created_at"
    AND repayment."created_at" <= order_row."completed_at"
    AND order_row."user_id" = repayment."user_id"
    AND order_row."tenant_id" = repayment."tenant_id"
    AND order_row."product_id" IS NOT DISTINCT FROM repayment."product_id"
    AND grant_row."source" = 'RECHARGE'
    AND grant_row."user_id" = repayment."user_id"
    AND grant_row."tenant_id" = repayment."tenant_id"
    AND grant_row."product_id" IS NOT DISTINCT FROM repayment."product_id"
    AND grant_row."created_at" = repayment."created_at"
    AND grant_row."valid_from" >= grant_row."created_at"
    AND (
      grant_row."valid_from" <= grant_row."created_at"
      OR "balance_legacy_grant_valid_from_is_repair_proven"(
        repayment."id",
        grant_row."valid_from"
      )
    )
    AND (grant_row."expires_at" IS NULL OR grant_row."expires_at" > grant_row."valid_from")
    AND grant_row."paid_amount_usd" = paid_funding_usd
    AND grant_row."bonus_amount_usd" = bonus_funding_usd
    AND grant_row."granted_amount_usd" = paid_funding_usd + bonus_funding_usd
    AND order_row."amount_cents"::NUMERIC / 100 = paid_funding_usd
    AND order_row."bonus_cents"::NUMERIC / 100 = bonus_funding_usd;
  IF order_count <> 1 THEN
    RETURN NULL;
  END IF;

  SELECT COUNT(*), COUNT(DISTINCT settlement_row."allocation_id"),
    COALESCE(SUM(settlement_row."paid_usd"), 0),
    COALESCE(SUM(settlement_row."bonus_usd"), 0),
    COALESCE(BOOL_AND(
      settlement_row."billing_account_id" = target_row.billing_account_id
      AND settlement_row."balance_grant_id" IS NULL
      AND settlement_row."debt_source" = 'ENTERPRISE_CREDIT'
      AND settlement_row."repair_run_id" IS NULL
      AND settlement_row."trigger" = 'FUNDING'
      AND settlement_row."operation_key" = 'legacy:' || settlement_row."id"
      AND settlement_row."amount_usd" > 0
      AND settlement_row."paid_usd" >= 0
      AND settlement_row."bonus_usd" >= 0
      AND settlement_row."amount_usd"
        = settlement_row."paid_usd" + settlement_row."bonus_usd"
      AND settlement_row."occurred_at" = target_row.repayment_created_at
      AND settlement_row."created_at" = target_row.repayment_created_at
      AND allocation_row."id" IS NOT NULL
      AND allocation_row."billing_account_id" = target_row.billing_account_id
      AND allocation_row."source" = 'ENTERPRISE_CREDIT'
      AND allocation_row."balance_grant_id" IS NULL
      AND allocation_row."settled_usd" = settlement_row."amount_usd"
      AND allocation_row."recognized_revenue_usd" = settlement_row."paid_usd"
      AND allocation_row."bonus_consumed_usd" = settlement_row."bonus_usd"
      AND (
        allocation_row."settled_usd" = allocation_row."amount_usd"
      ) IS NOT DISTINCT FROM (allocation_row."settled_at" IS NOT NULL)
      AND (
        SELECT COUNT(*)
        FROM "enterprise_credit_settlements" same_allocation
        WHERE same_allocation."allocation_id" = settlement_row."allocation_id"
      ) = 1
    ), FALSE)
  INTO settlement_count, settlement_allocation_count,
    settlement_paid_usd, settlement_bonus_usd, settlement_rows_match
  FROM "enterprise_credit_settlements" settlement_row
  LEFT JOIN "balance_consumption_allocations" allocation_row
    ON allocation_row."id" = settlement_row."allocation_id"
  WHERE settlement_row."repayment_transaction_id"
    = target_row.repayment_transaction_id;

  IF settlement_count > 0
    AND settlement_count = settlement_allocation_count
    AND settlement_paid_usd = paid_hole_usd
    AND settlement_bonus_usd = bonus_hole_usd
    AND settlement_rows_match
  THEN
    RETURN proven_grant_id;
  END IF;
  RETURN NULL;
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END
$$;

CREATE OR REPLACE FUNCTION "assert_balance_ledger_canonical_promotion"(
  target_account_id TEXT,
  target_run_id TEXT,
  require_empty BOOLEAN
)
RETURNS VOID
LANGUAGE plpgsql
AS $$
DECLARE
  account_row RECORD;
  repair_row RECORD;
  wallet_balance NUMERIC;
  transaction_count BIGINT;
  transaction_total NUMERIC;
  invalid_transaction_count BIGINT;
  active_grant_amount NUMERIC;
  invalid_grant_count BIGINT;
  open_debt_amount NUMERIC;
  invalid_allocation_count BIGINT;
  invalid_consume_count BIGINT;
  settlement_count BIGINT;
  invalid_settlement_count BIGINT;
  invalid_grant_conservation_count BIGINT;
  transaction_repair_count BIGINT;
  invalid_transaction_repair_count BIGINT;
  allocation_repair_count BIGINT;
  invalid_allocation_repair_count BIGINT;
  expiry_count BIGINT;
  refund_count BIGINT;
  invoice_item_count BIGINT;
  unsafe_invoice_item_count BIGINT;
  fact_count BIGINT;
  expected_debt_source TEXT;
  expected_settlement_mode TEXT;
  through_count BIGINT;
  invalid_grant_mutation_count BIGINT;
  invalid_funding_count BIGINT;
  wallet_path_ids TEXT[];
BEGIN
  SELECT * INTO account_row
  FROM "billing_accounts"
  WHERE "id" = target_account_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'balance ledger promotion account missing: %', target_account_id
      USING ERRCODE = '23514';
  END IF;
  -- A clean INSERT may be deliberately dirtied by a later writer in the same
  -- transaction.  There is then no clean authority to protect at commit.
  IF account_row."balance_grant_ledger_status" <> 'RECONCILED_V2' THEN
    RETURN;
  END IF;

  SELECT "balance_usd" INTO wallet_balance
  FROM "account_wallets"
  WHERE "billing_account_id" = target_account_id;

  IF require_empty THEN
    SELECT
      (SELECT COUNT(*) FROM "balance_transactions" WHERE "billing_account_id" = target_account_id)
      + (SELECT COUNT(*) FROM "balance_grants" WHERE "billing_account_id" = target_account_id)
      + (SELECT COUNT(*) FROM "balance_consumption_allocations" WHERE "billing_account_id" = target_account_id)
      + (SELECT COUNT(*) FROM "enterprise_credit_settlements" WHERE "billing_account_id" = target_account_id)
      + (SELECT COUNT(*) FROM "balance_grant_expiries" WHERE "billing_account_id" = target_account_id)
      + (SELECT COUNT(*) FROM "balance_grant_refunds" WHERE "billing_account_id" = target_account_id)
    INTO fact_count;
    IF account_row."balance_grant_ledger_version" IS DISTINCT FROM 2
      OR account_row."balance_grant_ledger_hash" IS DISTINCT FROM 'EMPTY_V2'
      OR account_row."balance_grant_ledger_through_transaction_id" IS NOT NULL
    THEN
      RAISE EXCEPTION
        'new CLEAN balance ledger marker is not EMPTY_V2 account=% wallet=% facts=%',
        target_account_id, COALESCE(wallet_balance, 0), fact_count
        USING ERRCODE = '23514';
    END IF;
    IF fact_count = 0 THEN
      IF COALESCE(wallet_balance, 0) <> 0 THEN
        RAISE EXCEPTION 'new EMPTY_V2 ledger has non-zero wallet: %', target_account_id
          USING ERRCODE = '23514';
      END IF;
      RETURN;
    END IF;
  END IF;

  IF wallet_balance IS NULL THEN
    RAISE EXCEPTION 'balance ledger promotion wallet missing: %', target_account_id
      USING ERRCODE = '23514';
  END IF;
  IF account_row."type" = 'personal' THEN
    expected_debt_source := 'NEGATIVE_BALANCE';
    expected_settlement_mode := 'CREATE';
  ELSIF account_row."type" = 'enterprise' THEN
    expected_debt_source := 'ENTERPRISE_CREDIT';
    expected_settlement_mode := 'VERIFY_EXISTING';
  ELSE
    RAISE EXCEPTION 'balance ledger promotion account type unsupported: %', account_row."type"
      USING ERRCODE = '23514';
  END IF;

  IF NOT require_empty THEN
    SELECT ra.*, r."status" AS run_status INTO repair_row
    FROM "balance_ledger_repair_accounts" ra
    JOIN "balance_ledger_repair_runs" r ON r."id" = ra."run_id"
    WHERE ra."run_id" = target_run_id
      AND ra."billing_account_id" = target_account_id;
    IF target_run_id IS NULL
      OR repair_row."id" IS NULL
      OR repair_row."status" IS DISTINCT FROM 'APPLIED'
      OR repair_row.run_status IS DISTINCT FROM 'RUNNING'
      OR repair_row."replay_hash" IS DISTINCT FROM account_row."balance_grant_ledger_hash"
      OR repair_row."after_snapshot" IS NULL
    THEN
      RAISE EXCEPTION 'balance ledger CLEAN promotion final proof missing: %', target_account_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT COUNT(*), COALESCE(SUM(bt."amount_usd"), 0), COUNT(*) FILTER (
    WHERE (bt."type"::TEXT = 'CONSUME' AND bt."amount_usd" >= 0)
      OR (bt."type"::TEXT IN ('RECHARGE', 'ADJUST') AND bt."amount_usd" <= 0)
      OR bt."type"::TEXT NOT IN ('CONSUME', 'RECHARGE', 'ADJUST')
  )
  INTO transaction_count, transaction_total, invalid_transaction_count
  FROM "balance_transactions" bt
  WHERE bt."billing_account_id" = target_account_id;

  SELECT COUNT(*) INTO through_count
  FROM "balance_transactions" bt
  WHERE bt."id" = account_row."balance_grant_ledger_through_transaction_id"
    AND bt."billing_account_id" = target_account_id
    AND bt."balance_after_usd" = wallet_balance
    AND bt."ledger_sequence" = (
      SELECT MAX(tail."ledger_sequence")
      FROM "balance_transactions" tail
      WHERE tail."billing_account_id" = target_account_id
    );

  wallet_path_ids := "assert_balance_transaction_unique_wallet_path"(
    target_account_id,
    wallet_balance
  );
  PERFORM "assert_balance_allocation_sequence_order"(
    target_account_id,
    wallet_path_ids
  );

  -- Build an explicit positive-funding -> grant/nature relation.  A valid
  -- ledger has exactly one classifier for every positive transaction, and
  -- every grant's immutable gross paid/bonus components are covered exactly
  -- once by those classified transactions.  This closes both duplicate
  -- funding reuse and orphan-grant constructions that aggregate-only checks
  -- cannot detect.
  WITH positive_funding AS (
    SELECT funding.*
    FROM "balance_transactions" funding
    WHERE funding."billing_account_id" = target_account_id
      AND funding."amount_usd" > 0
  ), funding_candidates AS (
    SELECT funding."id" AS funding_id, NULL::TEXT AS grant_id, 'PAID'::TEXT AS nature
    FROM positive_funding funding
    WHERE account_row."type" = 'enterprise'
      AND funding."type"::TEXT = 'ADJUST'
      AND funding."operation_key"
        ~ '^balance:admin-adjust:enterprise-paid-debt:[^[:space:]]+$'

    UNION ALL

    SELECT funding."id", grant_row."id", 'PAID'::TEXT
    FROM positive_funding funding
    JOIN "balance_grants" grant_row
      ON grant_row."billing_account_id" = target_account_id
      AND grant_row."order_id" = funding."order_id"
    WHERE funding."type"::TEXT = 'RECHARGE'
      AND funding."order_id" IS NOT NULL
      AND grant_row."source" = 'RECHARGE'
      AND grant_row."user_id" = funding."user_id"
      AND grant_row."tenant_id" = funding."tenant_id"
      AND grant_row."product_id" IS NOT DISTINCT FROM funding."product_id"
      AND (
        (
          grant_row."created_at" = funding."created_at"
          AND grant_row."valid_from" >= grant_row."created_at"
          AND (
            grant_row."valid_from" <= grant_row."created_at"
            OR "balance_legacy_grant_valid_from_is_repair_proven"(
              funding."id",
              grant_row."valid_from"
            )
          )
        )
        OR "balance_legacy_order_recharge_timing_is_proven"(
          target_account_id,
          funding."id",
          grant_row."id"
        )
      )
      AND (grant_row."expires_at" IS NULL OR grant_row."expires_at" > grant_row."valid_from")
      AND grant_row."paid_amount_usd" = funding."amount_usd"
      AND grant_row."bonus_amount_usd" = COALESCE((
        SELECT SUM(bonus_tx."amount_usd")
        FROM "balance_transactions" bonus_tx
        WHERE bonus_tx."billing_account_id" = target_account_id
          AND bonus_tx."order_id" = funding."order_id"
          AND bonus_tx."type"::TEXT = 'ADJUST'
          AND bonus_tx."description" ~ '^recharge-bonus(?: tier:[^[:space:]]+)?$'
      ), 0)
      AND (SELECT COUNT(*) FROM "balance_transactions" paid_tx
        WHERE paid_tx."billing_account_id" = target_account_id
          AND paid_tx."order_id" = funding."order_id"
          AND paid_tx."type"::TEXT = 'RECHARGE') = 1
      AND NOT EXISTS (
        SELECT 1 FROM "balance_transactions" unsupported
        WHERE unsupported."billing_account_id" = target_account_id
          AND unsupported."order_id" = funding."order_id"
          AND unsupported."amount_usd" > 0
          AND NOT (
            unsupported."type"::TEXT = 'RECHARGE'
            OR (
              unsupported."type"::TEXT = 'ADJUST'
              AND unsupported."description" ~ '^recharge-bonus(?: tier:[^[:space:]]+)?$'
            )
          )
      )
      AND (
        funding."operation_key" IS NULL
        OR funding."operation_key" = 'balance:recharge:' || funding."order_id" || ':paid'
      )

    UNION ALL

    SELECT funding."id", grant_row."id", 'PAID'::TEXT
    FROM positive_funding funding
    JOIN "balance_grants" grant_row
      ON grant_row."billing_account_id" = target_account_id
      AND grant_row."order_id" IS NULL
    WHERE funding."type"::TEXT = 'RECHARGE'
      AND funding."order_id" IS NULL
      AND grant_row."source" = 'RECHARGE'
      AND grant_row."user_id" = funding."user_id"
      AND grant_row."tenant_id" = funding."tenant_id"
      AND grant_row."product_id" IS NOT DISTINCT FROM funding."product_id"
      AND grant_row."paid_amount_usd" = funding."amount_usd"
      AND grant_row."bonus_amount_usd" = 0
      AND grant_row."granted_amount_usd" = funding."amount_usd"
      AND grant_row."created_at" = funding."created_at"
      AND grant_row."valid_from" >= grant_row."created_at"
      AND (
        grant_row."valid_from" <= grant_row."created_at"
        OR "balance_legacy_grant_valid_from_is_repair_proven"(
          funding."id",
          grant_row."valid_from"
        )
      )
      AND (grant_row."expires_at" IS NULL OR grant_row."expires_at" > grant_row."valid_from")
      AND (
        funding."operation_key" IS NULL
        OR funding."operation_key" = 'balance:admin-recharge:grant:' || grant_row."id"
      )
      AND (
        funding."operation_key" IS NULL
        OR funding."operation_key" ~ '^balance:admin-recharge:grant:[^[:space:]]+$'
      )

    UNION ALL

    SELECT funding."id", grant_row."id", 'BONUS'::TEXT
    FROM positive_funding funding
    JOIN "balance_transactions" paid_tx
      ON paid_tx."billing_account_id" = target_account_id
      AND paid_tx."order_id" = funding."order_id"
      AND paid_tx."type"::TEXT = 'RECHARGE'
    JOIN "balance_grants" grant_row
      ON grant_row."billing_account_id" = target_account_id
      AND grant_row."order_id" = funding."order_id"
    WHERE funding."type"::TEXT = 'ADJUST'
      AND funding."order_id" IS NOT NULL
      AND funding."description" ~ '^recharge-bonus(?: tier:[^[:space:]]+)?$'
      AND grant_row."source" = 'RECHARGE'
      AND grant_row."user_id" = funding."user_id"
      AND grant_row."tenant_id" = funding."tenant_id"
      AND grant_row."product_id" IS NOT DISTINCT FROM funding."product_id"
      AND paid_tx."user_id" = grant_row."user_id"
      AND paid_tx."tenant_id" = grant_row."tenant_id"
      AND paid_tx."product_id" IS NOT DISTINCT FROM grant_row."product_id"
      AND (
        (
          grant_row."created_at" = paid_tx."created_at"
          AND grant_row."valid_from" >= grant_row."created_at"
          AND (
            grant_row."valid_from" <= grant_row."created_at"
            OR "balance_legacy_grant_valid_from_is_repair_proven"(
              paid_tx."id",
              grant_row."valid_from"
            )
          )
        )
        OR "balance_legacy_order_recharge_timing_is_proven"(
          target_account_id,
          paid_tx."id",
          grant_row."id"
        )
      )
      AND (grant_row."expires_at" IS NULL OR grant_row."expires_at" > grant_row."valid_from")
      AND funding."created_at" >= paid_tx."created_at"
      AND grant_row."paid_amount_usd" = paid_tx."amount_usd"
      AND grant_row."bonus_amount_usd" = COALESCE((
        SELECT SUM(bonus_tx."amount_usd")
        FROM "balance_transactions" bonus_tx
        WHERE bonus_tx."billing_account_id" = target_account_id
          AND bonus_tx."order_id" = funding."order_id"
          AND bonus_tx."type"::TEXT = 'ADJUST'
          AND bonus_tx."description" ~ '^recharge-bonus(?: tier:[^[:space:]]+)?$'
      ), 0)
      AND (SELECT COUNT(*) FROM "balance_transactions" paid_count
        WHERE paid_count."billing_account_id" = target_account_id
          AND paid_count."order_id" = funding."order_id"
          AND paid_count."type"::TEXT = 'RECHARGE') = 1
      AND (
        paid_tx."operation_key" IS NULL
        OR paid_tx."operation_key" = 'balance:recharge:' || funding."order_id" || ':paid'
      )

    UNION ALL

    SELECT funding."id", grant_row."id", 'BONUS'::TEXT
    FROM positive_funding funding
    JOIN "balance_grants" grant_row
      ON grant_row."billing_account_id" = target_account_id
      AND grant_row."id" = substring(
        funding."description" FROM '^voucher:([^[:space:]]+)'
      )
    WHERE funding."type"::TEXT = 'ADJUST'
      AND funding."order_id" IS NULL
      AND funding."description"
        ~ '^voucher:[^[:space:]]+[[:space:]]+[^[:space:]](?:.*[^[:space:]])?$'
      AND grant_row."source" = 'VOUCHER'
      AND grant_row."user_id" = funding."user_id"
      AND grant_row."tenant_id" = funding."tenant_id"
      AND grant_row."product_id" IS NOT DISTINCT FROM funding."product_id"
      AND grant_row."order_id" IS NULL
      AND grant_row."paid_amount_usd" = 0
      AND grant_row."bonus_amount_usd" = funding."amount_usd"
      AND grant_row."granted_amount_usd" = funding."amount_usd"
      AND (
        (
          grant_row."created_at" = funding."created_at"
          AND grant_row."valid_from" >= grant_row."created_at"
          AND (
            grant_row."valid_from" <= grant_row."created_at"
            OR "balance_legacy_grant_valid_from_is_repair_proven"(
              funding."id",
              grant_row."valid_from"
            )
          )
        )
        OR "balance_legacy_voucher_funding_is_proven"(
          target_account_id,
          funding."id",
          grant_row."id"
        )
      )
      AND (grant_row."expires_at" IS NULL OR grant_row."expires_at" > grant_row."valid_from")
      AND (
        funding."operation_key" IS NULL
        OR funding."operation_key" = 'balance:voucher:grant:' || grant_row."id"
      )
      AND (SELECT COUNT(*) FROM "balance_transactions" voucher_tx
        WHERE voucher_tx."billing_account_id" = target_account_id
          AND voucher_tx."description"
            ~ '^voucher:[^[:space:]]+[[:space:]]+[^[:space:]](?:.*[^[:space:]])?$'
          AND substring(voucher_tx."description" FROM '^voucher:([^[:space:]]+)')
            = grant_row."id") = 1

  ), funding_cardinality AS (
    SELECT funding."id" AS funding_id, COUNT(candidate.funding_id) AS candidate_count
    FROM positive_funding funding
    LEFT JOIN funding_candidates candidate ON candidate.funding_id = funding."id"
    GROUP BY funding."id"
  ), grant_funding AS (
    SELECT candidate.grant_id,
      COALESCE(SUM(funding."amount_usd") FILTER (WHERE candidate.nature = 'PAID'), 0)
        AS paid_usd,
      COALESCE(SUM(funding."amount_usd") FILTER (WHERE candidate.nature = 'BONUS'), 0)
        AS bonus_usd
    FROM funding_candidates candidate
    JOIN positive_funding funding ON funding."id" = candidate.funding_id
    WHERE candidate.grant_id IS NOT NULL
    GROUP BY candidate.grant_id
  )
  SELECT
    (SELECT COUNT(*) FROM funding_cardinality WHERE candidate_count <> 1)
    + (SELECT COUNT(*)
      FROM "balance_grants" grant_row
      LEFT JOIN grant_funding aggregate ON aggregate.grant_id = grant_row."id"
      WHERE grant_row."billing_account_id" = target_account_id
        AND (
          grant_row."paid_amount_usd" IS DISTINCT FROM COALESCE(aggregate.paid_usd, 0)
          OR grant_row."bonus_amount_usd" IS DISTINCT FROM COALESCE(aggregate.bonus_usd, 0)
        ))
  INTO invalid_funding_count;

  SELECT
    COALESCE(SUM(bg."remaining_amount_usd") FILTER (
      WHERE NOT bg."is_expired"
        AND bg."valid_from"
          <= account_row."balance_grant_ledger_reconciled_at"
        AND (
          bg."expires_at" IS NULL
          OR bg."expires_at"
            > account_row."balance_grant_ledger_reconciled_at"
        )
    ), 0),
    COUNT(*) FILTER (
      WHERE bg."paid_amount_usd" < 0
        OR bg."bonus_amount_usd" < 0
        OR bg."granted_amount_usd" <= 0
        OR bg."paid_amount_usd" + bg."bonus_amount_usd" <> bg."granted_amount_usd"
        OR bg."discount_rate" IS DISTINCT FROM CASE
          WHEN bg."granted_amount_usd" > 0
            THEN ROUND(bg."paid_amount_usd" / bg."granted_amount_usd", 12)
          ELSE 0
        END
        OR bg."remaining_amount_usd" < 0
        OR bg."remaining_paid_amount_usd" IS NULL
        OR bg."remaining_bonus_amount_usd" IS NULL
        OR bg."remaining_paid_amount_usd" < 0
        OR bg."remaining_bonus_amount_usd" < 0
        OR bg."remaining_amount_usd"
          <> bg."remaining_paid_amount_usd" + bg."remaining_bonus_amount_usd"
        OR bg."remaining_paid_amount_usd" > bg."paid_amount_usd"
        OR bg."remaining_bonus_amount_usd" > bg."bonus_amount_usd"
        OR (
          bg."valid_from" > bg."created_at"
          AND NOT EXISTS (
            SELECT 1
            FROM "balance_funding_candidates"(
              target_account_id,
              account_row."type"
            ) proven_funding
            WHERE proven_funding.grant_id = bg."id"
          )
        )
        OR (
          bg."expires_at" IS NOT NULL
          AND bg."expires_at" <= bg."valid_from"
        )
        OR (
          NOT bg."is_expired"
          AND bg."remaining_amount_usd" > 0
          AND bg."expires_at" IS NOT NULL
          AND bg."expires_at"
            <= account_row."balance_grant_ledger_reconciled_at"
        )
        OR bg."is_expired"
    )
  INTO active_grant_amount, invalid_grant_count
  FROM "balance_grants" bg
  WHERE bg."billing_account_id" = target_account_id;

  SELECT
    COALESCE(SUM(bca."amount_usd" - bca."settled_usd") FILTER (
      WHERE bca."source" = expected_debt_source
    ), 0),
    COUNT(*) FILTER (
      WHERE bca."ledger_sequence" IS NULL
        OR bca."ledger_sequence" = 0
        OR bca."amount_usd" <= 0
        OR bt."id" IS NULL
        OR bt."billing_account_id" IS DISTINCT FROM target_account_id
        OR bt."type"::TEXT <> 'CONSUME'
        OR bca."user_id" IS DISTINCT FROM bt."user_id"
        OR bca."tenant_id" IS DISTINCT FROM bt."tenant_id"
        OR bca."product_id" IS DISTINCT FROM bt."product_id"
        OR bca."token_usage_id" IS DISTINCT FROM bt."token_usage_id"
        OR (
          bca."source" = 'BALANCE_GRANT'
          AND (
            bg."id" IS NULL
            OR bg."billing_account_id" IS DISTINCT FROM target_account_id
            OR bca."recognized_revenue_usd" < 0
            OR bca."bonus_consumed_usd" < 0
            OR bca."recognized_revenue_usd" + bca."bonus_consumed_usd" <> bca."amount_usd"
            OR bca."discount_rate" IS DISTINCT FROM CASE
              WHEN bca."amount_usd" > 0 THEN ROUND(
                bca."recognized_revenue_usd" / bca."amount_usd",
                12
              )
              ELSE 0
            END
            OR bca."settled_usd" <> 0
            OR bca."settled_at" IS NOT NULL
          )
        )
        OR (
          bca."source" = expected_debt_source
          AND (
            bca."balance_grant_id" IS NOT NULL
            OR bca."discount_rate" <> 0
            OR bca."settled_usd" < 0
            OR bca."settled_usd" > bca."amount_usd"
            OR bca."recognized_revenue_usd" < 0
            OR bca."bonus_consumed_usd" < 0
            OR bca."recognized_revenue_usd" + bca."bonus_consumed_usd" <> bca."settled_usd"
            OR (bca."settled_usd" = bca."amount_usd")
              IS DISTINCT FROM (bca."settled_at" IS NOT NULL)
            OR bca."settled_usd" IS DISTINCT FROM COALESCE((
              SELECT SUM(s."amount_usd") FROM "enterprise_credit_settlements" s
              WHERE s."allocation_id" = bca."id"
            ), 0)
            OR bca."recognized_revenue_usd" IS DISTINCT FROM COALESCE((
              SELECT SUM(s."paid_usd") FROM "enterprise_credit_settlements" s
              WHERE s."allocation_id" = bca."id"
            ), 0)
            OR bca."bonus_consumed_usd" IS DISTINCT FROM COALESCE((
              SELECT SUM(s."bonus_usd") FROM "enterprise_credit_settlements" s
              WHERE s."allocation_id" = bca."id"
            ), 0)
          )
        )
        OR bca."source" NOT IN ('BALANCE_GRANT', expected_debt_source)
    )
  INTO open_debt_amount, invalid_allocation_count
  FROM "balance_consumption_allocations" bca
  LEFT JOIN "balance_transactions" bt ON bt."id" = bca."balance_transaction_id"
  LEFT JOIN "balance_grants" bg ON bg."id" = bca."balance_grant_id"
  WHERE bca."billing_account_id" = target_account_id;

  invalid_allocation_count := invalid_allocation_count + (
    SELECT COUNT(*)
    FROM "balance_consumption_allocations" foreign_allocation
    JOIN "balance_transactions" target_transaction
      ON target_transaction."id" = foreign_allocation."balance_transaction_id"
    WHERE target_transaction."billing_account_id" = target_account_id
      AND foreign_allocation."billing_account_id" IS DISTINCT FROM target_account_id
  ) + (
    SELECT COUNT(*)
    FROM "balance_consumption_allocations" foreign_allocation
    JOIN "balance_grants" target_grant
      ON target_grant."id" = foreign_allocation."balance_grant_id"
    WHERE target_grant."billing_account_id" = target_account_id
      AND foreign_allocation."billing_account_id" IS DISTINCT FROM target_account_id
  ) + (
    SELECT COUNT(*)
    FROM "enterprise_credit_settlements" foreign_settlement
    JOIN "balance_grants" target_grant
      ON target_grant."id" = foreign_settlement."balance_grant_id"
    WHERE target_grant."billing_account_id" = target_account_id
      AND foreign_settlement."billing_account_id" IS DISTINCT FROM target_account_id
  ) + (
    SELECT COUNT(*)
    FROM "enterprise_credit_settlements" foreign_settlement
    JOIN "balance_consumption_allocations" target_allocation
      ON target_allocation."id" = foreign_settlement."allocation_id"
    WHERE target_allocation."billing_account_id" = target_account_id
      AND foreign_settlement."billing_account_id" IS DISTINCT FROM target_account_id
  ) + (
    SELECT COUNT(*)
    FROM "enterprise_credit_settlements" foreign_settlement
    JOIN "balance_transactions" target_repayment
      ON target_repayment."id" = foreign_settlement."repayment_transaction_id"
    WHERE target_repayment."billing_account_id" = target_account_id
      AND foreign_settlement."billing_account_id" IS DISTINCT FROM target_account_id
  );

  SELECT COUNT(*) INTO invalid_consume_count
  FROM (
    SELECT bt."id"
    FROM "balance_transactions" bt
    LEFT JOIN "balance_consumption_allocations" bca
      ON bca."balance_transaction_id" = bt."id"
      AND bca."billing_account_id" = target_account_id
    WHERE bt."billing_account_id" = target_account_id
      AND bt."type"::TEXT = 'CONSUME'
    GROUP BY bt."id", bt."amount_usd", bt."balance_after_usd"
    HAVING COALESCE(SUM(bca."amount_usd"), 0) <> -bt."amount_usd"
      OR COALESCE(SUM(bca."amount_usd") FILTER (
        WHERE bca."source" = 'BALANCE_GRANT'
      ), 0) <> LEAST(
        -bt."amount_usd",
        GREATEST(bt."balance_after_usd" - bt."amount_usd", 0)
      )
      OR COALESCE(SUM(bca."amount_usd") FILTER (
        WHERE bca."source" = expected_debt_source
      ), 0) <> -bt."amount_usd" - LEAST(
        -bt."amount_usd",
        GREATEST(bt."balance_after_usd" - bt."amount_usd", 0)
      )
      OR COUNT(*) FILTER (
        WHERE bca."source" = expected_debt_source
      ) <> CASE
        WHEN -bt."amount_usd" - LEAST(
          -bt."amount_usd",
          GREATEST(bt."balance_after_usd" - bt."amount_usd", 0)
        ) > 0 THEN 1
        ELSE 0
      END
  ) invalid_consume;

  SELECT COUNT(*), COUNT(*) FILTER (
    WHERE s."debt_source" <> expected_debt_source
      OR s."operation_key" IS NULL
      OR (
        s."operation_key" LIKE 'legacy:%'
        AND s."operation_key" <> 'legacy:' || s."id"
      )
      OR s."amount_usd" <= 0
      OR s."paid_usd" < 0
      OR s."bonus_usd" < 0
      OR s."amount_usd" <> s."paid_usd" + s."bonus_usd"
      OR bca."id" IS NULL
      OR bca."billing_account_id" IS DISTINCT FROM target_account_id
      OR bca."source" <> expected_debt_source
      OR bt."id" IS NULL
      OR bt."billing_account_id" IS DISTINCT FROM target_account_id
      OR bt."type"::TEXT NOT IN ('RECHARGE', 'ADJUST')
      OR bt."amount_usd" <= 0
      OR (
        s."occurred_at" <> bt."created_at"
        AND NOT "balance_legacy_enterprise_settlement_timing_is_proven"(s."id")
      )
      OR (s."balance_grant_id" IS NOT NULL AND (
        bg."id" IS NULL OR bg."billing_account_id" IS DISTINCT FROM target_account_id
      ))
      OR (expected_settlement_mode = 'CREATE' AND (
        s."repair_run_id" IS DISTINCT FROM target_run_id
        OR s."trigger" <> 'REPAIR'
        OR s."balance_grant_id" IS NULL
        OR NOT EXISTS (
          SELECT 1
          FROM "balance_ledger_allocation_repairs" ar
          WHERE ar."run_id" = target_run_id
            AND ar."billing_account_id" = target_account_id
            AND ar."allocation_id" = s."allocation_id"
            AND ar."after_snapshot" = to_jsonb(bca)
        )
      ))
      OR (expected_settlement_mode = 'VERIFY_EXISTING' AND (
        s."repair_run_id" IS NOT NULL OR s."trigger" <> 'FUNDING'
      ))
  )
  INTO settlement_count, invalid_settlement_count
  FROM "enterprise_credit_settlements" s
  LEFT JOIN "balance_consumption_allocations" bca ON bca."id" = s."allocation_id"
  LEFT JOIN "balance_transactions" bt ON bt."id" = s."repayment_transaction_id"
  LEFT JOIN "balance_grants" bg ON bg."id" = s."balance_grant_id"
  WHERE s."billing_account_id" = target_account_id;

  SELECT COUNT(*) INTO invalid_grant_conservation_count
  FROM "balance_grants" bg
  WHERE bg."billing_account_id" = target_account_id
    AND (
      bg."paid_amount_usd" IS DISTINCT FROM (
        bg."remaining_paid_amount_usd"
        + COALESCE((SELECT SUM(bca."recognized_revenue_usd")
          FROM "balance_consumption_allocations" bca
          WHERE bca."balance_grant_id" = bg."id"
            AND bca."billing_account_id" = target_account_id
            AND bca."source" = 'BALANCE_GRANT'), 0)
        + COALESCE((SELECT SUM(s."paid_usd")
          FROM "enterprise_credit_settlements" s
          WHERE s."billing_account_id" = target_account_id
            AND COALESCE(
              s."balance_grant_id",
              "balance_legacy_settlement_effective_grant_id"(s."id")
            ) = bg."id"), 0)
      )
      OR bg."bonus_amount_usd" IS DISTINCT FROM (
        bg."remaining_bonus_amount_usd"
        + COALESCE((SELECT SUM(bca."bonus_consumed_usd")
          FROM "balance_consumption_allocations" bca
          WHERE bca."balance_grant_id" = bg."id"
            AND bca."billing_account_id" = target_account_id
            AND bca."source" = 'BALANCE_GRANT'), 0)
        + COALESCE((SELECT SUM(s."bonus_usd")
          FROM "enterprise_credit_settlements" s
          WHERE s."billing_account_id" = target_account_id
            AND COALESCE(
              s."balance_grant_id",
              "balance_legacy_settlement_effective_grant_id"(s."id")
            ) = bg."id"), 0)
      )
    );

  PERFORM "assert_balance_ledger_canonical_replay"(
    target_account_id,
    account_row."type",
    expected_debt_source,
    expected_settlement_mode,
    target_run_id,
    wallet_path_ids
  );

  IF require_empty THEN
    transaction_repair_count := 0;
    invalid_transaction_repair_count := 0;
    allocation_repair_count := 0;
    invalid_allocation_repair_count := 0;
    invalid_grant_mutation_count := 0;
  ELSE
    SELECT COUNT(*), COUNT(*) FILTER (
      WHERE tr."operation_key" IS DISTINCT FROM (
        'repair:transaction-sequence:' || target_run_id || ':' || tr."transaction_id"
      )
        OR tr."repair_account_id" IS DISTINCT FROM repair_row."id"
        OR tr."billing_account_id" IS DISTINCT FROM target_account_id
        OR tr."before_snapshot"->'ledger_sequence' <> 'null'::JSONB
        OR (tr."after_snapshot"->>'ledger_sequence')::BIGINT >= 0
        OR (tr."before_snapshot" - 'ledger_sequence')
          IS DISTINCT FROM (tr."after_snapshot" - 'ledger_sequence')
        OR bt."id" IS NULL
        OR tr."after_snapshot" IS DISTINCT FROM to_jsonb(bt)
    )
    INTO transaction_repair_count, invalid_transaction_repair_count
    FROM "balance_ledger_transaction_repairs" tr
    LEFT JOIN "balance_transactions" bt ON bt."id" = tr."transaction_id"
    WHERE tr."run_id" = target_run_id
      AND tr."billing_account_id" = target_account_id;

    SELECT COUNT(*), COUNT(*) FILTER (
      WHERE ar."operation_key" IS DISTINCT FROM (
        'repair:allocation:' || target_run_id || ':' || ar."allocation_id"
      )
        OR ar."repair_account_id" IS DISTINCT FROM repair_row."id"
        OR ar."billing_account_id" IS DISTINCT FROM target_account_id
        OR ar."before_snapshot" IS NOT DISTINCT FROM ar."after_snapshot"
        OR bca."id" IS NULL
        OR ar."after_snapshot" IS DISTINCT FROM to_jsonb(bca)
    )
    INTO allocation_repair_count, invalid_allocation_repair_count
    FROM "balance_ledger_allocation_repairs" ar
    LEFT JOIN "balance_consumption_allocations" bca ON bca."id" = ar."allocation_id"
    WHERE ar."run_id" = target_run_id
      AND ar."billing_account_id" = target_account_id;

    WITH before_grants AS (
      SELECT value AS snapshot, value->>'id' AS grant_id
      FROM jsonb_array_elements(COALESCE(
        repair_row."before_snapshot"->'grants',
        '[]'::JSONB
      ))
    ), mutations AS (
      SELECT value AS mutation, value->>'grantId' AS grant_id
      FROM jsonb_array_elements(COALESCE(
        repair_row."after_snapshot"->'grantMutations',
        '[]'::JSONB
      ))
    ), current_grants AS (
      SELECT bg.*
      FROM "balance_grants" bg
      WHERE bg."billing_account_id" = target_account_id
    )
    SELECT
      (SELECT COUNT(*) FROM current_grants current
        LEFT JOIN before_grants before ON before.grant_id = current."id"
        WHERE before.grant_id IS NULL)
      + (SELECT COUNT(*) FROM before_grants before
        LEFT JOIN current_grants current ON current."id" = before.grant_id
        WHERE current."id" IS NULL)
      + (SELECT COUNT(*) FROM (
          SELECT grant_id FROM before_grants GROUP BY grant_id HAVING COUNT(*) <> 1
        ) duplicate_before)
      + (SELECT COUNT(*) FROM (
          SELECT grant_id FROM mutations GROUP BY grant_id HAVING COUNT(*) <> 1
        ) duplicate_mutation)
      + (SELECT COUNT(*)
        FROM current_grants current
        JOIN before_grants before ON before.grant_id = current."id"
        LEFT JOIN mutations mutation ON mutation.grant_id = current."id"
        WHERE (
          current."remaining_amount_usd"
            IS DISTINCT FROM (before.snapshot->>'remainingAmountUsd')::NUMERIC
          OR current."remaining_paid_amount_usd"
            IS DISTINCT FROM (before.snapshot->>'remainingPaidAmountUsd')::NUMERIC
          OR current."remaining_bonus_amount_usd"
            IS DISTINCT FROM (before.snapshot->>'remainingBonusAmountUsd')::NUMERIC
        ) IS DISTINCT FROM (mutation.grant_id IS NOT NULL)
          OR (
            mutation.grant_id IS NOT NULL
            AND (
              (mutation.mutation->>'expectedRemainingAmountUsd')::NUMERIC
                IS DISTINCT FROM (before.snapshot->>'remainingAmountUsd')::NUMERIC
              OR (mutation.mutation->>'expectedRemainingPaidAmountUsd')::NUMERIC
                IS DISTINCT FROM (before.snapshot->>'remainingPaidAmountUsd')::NUMERIC
              OR (mutation.mutation->>'expectedRemainingBonusAmountUsd')::NUMERIC
                IS DISTINCT FROM (before.snapshot->>'remainingBonusAmountUsd')::NUMERIC
              OR (mutation.mutation->>'remainingAmountUsd')::NUMERIC
                IS DISTINCT FROM current."remaining_amount_usd"
              OR (mutation.mutation->>'remainingPaidAmountUsd')::NUMERIC
                IS DISTINCT FROM current."remaining_paid_amount_usd"
              OR (mutation.mutation->>'remainingBonusAmountUsd')::NUMERIC
                IS DISTINCT FROM current."remaining_bonus_amount_usd"
            )
          )
      )
      + (SELECT COUNT(*) FROM mutations mutation
        LEFT JOIN current_grants current ON current."id" = mutation.grant_id
        WHERE current."id" IS NULL)
    INTO invalid_grant_mutation_count;
  END IF;

  SELECT COUNT(*) INTO expiry_count
  FROM "balance_grant_expiries" WHERE "billing_account_id" = target_account_id;
  SELECT COUNT(*) INTO refund_count
  FROM "balance_grant_refunds" WHERE "billing_account_id" = target_account_id;
  -- Count each invoice item once even if corrupt legacy data has more than one
  -- grant linked to the same order. FAILED applications without any issued-
  -- document identity or historical issuance/void/red-offset event are inert
  -- failed attempts; every other linked invoice remains a hard blocker.
  SELECT
    COUNT(*),
    COUNT(*) FILTER (WHERE
      application."status"::TEXT IS DISTINCT FROM 'FAILED'
      OR application."invoice_number" IS NOT NULL
      OR application."issue_date" IS NOT NULL
      OR application."due_date" IS NOT NULL
      OR application."issued_at" IS NOT NULL
      OR application."pdf_url" IS NOT NULL
      OR application."ofd_url" IS NOT NULL
      OR EXISTS (
        SELECT 1
        FROM "invoice_event_log" invoice_event
        WHERE invoice_event."application_id" = application."id"
          AND invoice_event."to_status"::TEXT IN (
            'ISSUED',
            'VOIDED',
            'RED_OFFSET'
          )
      )
    )
  INTO invoice_item_count, unsafe_invoice_item_count
  FROM "invoice_application_items" item
  JOIN "invoice_applications" application
    ON application."id" = item."application_id"
  WHERE item."order_id" IN (
    SELECT bg."order_id"
    FROM "balance_grants" bg
    WHERE bg."billing_account_id" = target_account_id
      AND bg."order_id" IS NOT NULL
    UNION
    SELECT transaction_row."order_id"
    FROM "balance_transactions" transaction_row
    WHERE transaction_row."billing_account_id" = target_account_id
      AND transaction_row."order_id" IS NOT NULL
  );

  IF transaction_total IS DISTINCT FROM wallet_balance
    OR invalid_transaction_count <> 0
    OR invalid_funding_count <> 0
    OR (NOT require_empty AND transaction_count = 0
      AND account_row."balance_grant_ledger_through_transaction_id" IS NOT NULL)
    OR (NOT require_empty AND transaction_count > 0 AND through_count <> 1)
    OR active_grant_amount IS DISTINCT FROM GREATEST(wallet_balance, 0)
    OR open_debt_amount IS DISTINCT FROM GREATEST(-wallet_balance, 0)
    OR invalid_grant_count <> 0
    OR invalid_allocation_count <> 0
    OR invalid_consume_count <> 0
    OR invalid_settlement_count <> 0
    OR invalid_grant_conservation_count <> 0
    OR invalid_transaction_repair_count <> 0
    OR invalid_allocation_repair_count <> 0
    OR invalid_grant_mutation_count <> 0
    OR expiry_count <> 0
    OR refund_count <> 0
    OR unsafe_invoice_item_count <> 0
  THEN
    RAISE EXCEPTION
      'balance ledger canonical promotion invalid account=% wallet=% tx=%/% grant=% debt=% invalid(tx/funding/grant/allocation/consume/settlement/conservation/txAudit/allocationAudit/grantMutation)=%/%/%/%/%/%/%/%/%/% facts(expiry/refund/invoice/unsafeInvoice)=%/%/%/%',
      target_account_id, wallet_balance, transaction_total, transaction_count,
      active_grant_amount, open_debt_amount,
      invalid_transaction_count, invalid_funding_count, invalid_grant_count, invalid_allocation_count,
      invalid_consume_count, invalid_settlement_count,
      invalid_grant_conservation_count, invalid_transaction_repair_count,
      invalid_allocation_repair_count,
      invalid_grant_mutation_count, expiry_count, refund_count,
      invoice_item_count, unsafe_invoice_item_count
      USING ERRCODE = '23514';
  END IF;

  -- Keep the unassigned RECORD wholly outside the EMPTY_V2 branch. PostgreSQL
  -- is free to evaluate boolean operands in any order, so `NOT require_empty
  -- AND repair_row.field ...` is not a safe short-circuit for a RECORD that was
  -- never populated.
  IF NOT require_empty THEN
    IF repair_row."after_snapshot"->>'accountType' IS DISTINCT FROM account_row."type"
      OR repair_row."after_snapshot"->>'debtSource' IS DISTINCT FROM expected_debt_source
      OR repair_row."after_snapshot"->>'settlementWriteMode' IS DISTINCT FROM expected_settlement_mode
      OR repair_row."after_snapshot"->>'preconditionHash' IS DISTINCT FROM repair_row."precondition_hash"
      OR repair_row."after_snapshot"->>'replayHash' IS DISTINCT FROM repair_row."replay_hash"
      OR (repair_row."after_snapshot"->>'walletBalanceUsd')::NUMERIC IS DISTINCT FROM wallet_balance
      OR (repair_row."after_snapshot"->>'activeGrantUsd')::NUMERIC IS DISTINCT FROM active_grant_amount
      OR (repair_row."after_snapshot"->>'openDebtUsd')::NUMERIC IS DISTINCT FROM open_debt_amount
      OR repair_row."after_snapshot"->>'transactionTailId'
        IS DISTINCT FROM account_row."balance_grant_ledger_through_transaction_id"
      OR (repair_row."after_snapshot"->>'transactionTailUsd')::NUMERIC
        IS DISTINCT FROM wallet_balance
      OR (repair_row."after_snapshot"->>'settlementCount')::BIGINT IS DISTINCT FROM settlement_count
      OR (repair_row."after_snapshot"->>'transactionRepairCount')::BIGINT
        IS DISTINCT FROM transaction_repair_count
      OR jsonb_array_length(COALESCE(
        repair_row."after_snapshot"->'transactionSequenceMutations',
        '[]'::JSONB
      )) IS DISTINCT FROM transaction_repair_count
      OR EXISTS (
        SELECT 1
        FROM "balance_ledger_transaction_repairs" tr
        WHERE tr."run_id" = target_run_id
          AND tr."billing_account_id" = target_account_id
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(
              repair_row."after_snapshot"->'transactionSequenceMutations',
              '[]'::JSONB
            )) mutation
            WHERE mutation->>'transactionId' = tr."transaction_id"
              AND mutation->>'expectedLedgerSequence' IS NULL
              AND (mutation->>'ledgerSequence')::BIGINT
                = (tr."after_snapshot"->>'ledger_sequence')::BIGINT
          )
      )
      OR (repair_row."after_snapshot"->>'allocationRepairCount')::BIGINT
        IS DISTINCT FROM allocation_repair_count
      OR EXISTS (
        SELECT mutation->>'allocationId'
        FROM jsonb_array_elements(COALESCE(
          repair_row."after_snapshot"->'allocationMutations',
          '[]'::JSONB
        )) mutation
        GROUP BY mutation->>'allocationId'
        HAVING mutation->>'allocationId' IS NULL OR COUNT(*) <> 1
      )
      OR EXISTS (
        SELECT 1
        FROM jsonb_array_elements(COALESCE(
          repair_row."after_snapshot"->'allocationMutations',
          '[]'::JSONB
        )) mutation
        LEFT JOIN "balance_ledger_allocation_repairs" allocation_repair
          ON allocation_repair."run_id" = target_run_id
          AND allocation_repair."billing_account_id" = target_account_id
          AND allocation_repair."allocation_id" = mutation->>'allocationId'
        WHERE allocation_repair."id" IS NULL
          OR (mutation->>'expectedSettledUsd')::NUMERIC
            IS DISTINCT FROM
              (allocation_repair."before_snapshot"->>'settled_usd')::NUMERIC
          OR (mutation->>'expectedRecognizedRevenueUsd')::NUMERIC
            IS DISTINCT FROM
              (allocation_repair."before_snapshot"->>'recognized_revenue_usd')::NUMERIC
          OR (mutation->>'expectedBonusConsumedUsd')::NUMERIC
            IS DISTINCT FROM
              (allocation_repair."before_snapshot"->>'bonus_consumed_usd')::NUMERIC
          OR ((mutation->>'expectedSettledAt')::TIMESTAMPTZ AT TIME ZONE 'UTC')
            IS DISTINCT FROM
              (allocation_repair."before_snapshot"->>'settled_at')::TIMESTAMP
          OR (mutation->>'settledUsd')::NUMERIC
            IS DISTINCT FROM
              (allocation_repair."after_snapshot"->>'settled_usd')::NUMERIC
          OR (mutation->>'recognizedRevenueUsd')::NUMERIC
            IS DISTINCT FROM
              (allocation_repair."after_snapshot"->>'recognized_revenue_usd')::NUMERIC
          OR (mutation->>'bonusConsumedUsd')::NUMERIC
            IS DISTINCT FROM
              (allocation_repair."after_snapshot"->>'bonus_consumed_usd')::NUMERIC
          OR ((mutation->>'settledAt')::TIMESTAMPTZ AT TIME ZONE 'UTC')
            IS DISTINCT FROM
              (allocation_repair."after_snapshot"->>'settled_at')::TIMESTAMP
          OR NOT (
            (mutation->>'expectedSettledUsd')::NUMERIC
              IS DISTINCT FROM (mutation->>'settledUsd')::NUMERIC
            OR (mutation->>'expectedRecognizedRevenueUsd')::NUMERIC
              IS DISTINCT FROM (mutation->>'recognizedRevenueUsd')::NUMERIC
            OR (mutation->>'expectedBonusConsumedUsd')::NUMERIC
              IS DISTINCT FROM (mutation->>'bonusConsumedUsd')::NUMERIC
            OR (mutation->>'expectedSettledAt')::TIMESTAMPTZ
              IS DISTINCT FROM (mutation->>'settledAt')::TIMESTAMPTZ
          )
          OR (
            account_row."type" = 'enterprise'
            AND (
              (mutation->>'expectedSettledUsd')::NUMERIC
                IS DISTINCT FROM (mutation->>'settledUsd')::NUMERIC
              OR (
                (mutation->>'expectedSettledAt')::TIMESTAMPTZ
                  AT TIME ZONE 'UTC'
              ) IS DISTINCT FROM (
                (mutation->>'settledAt')::TIMESTAMPTZ
                  AT TIME ZONE 'UTC'
              )
              OR NOT (
                (mutation->>'expectedRecognizedRevenueUsd')::NUMERIC
                  IS DISTINCT FROM (mutation->>'recognizedRevenueUsd')::NUMERIC
                OR (mutation->>'expectedBonusConsumedUsd')::NUMERIC
                  IS DISTINCT FROM (mutation->>'bonusConsumedUsd')::NUMERIC
              )
              OR (mutation->>'recognizedRevenueUsd')::NUMERIC
                + (mutation->>'bonusConsumedUsd')::NUMERIC
                  IS DISTINCT FROM (mutation->>'settledUsd')::NUMERIC
            )
          )
      )
      OR EXISTS (
        -- Enterprise legacy settlement repair is component-only authority.
        -- Independently of the plan JSON, its row audit may change only the
        -- paid/bonus components and an optional legacy sequence.
        SELECT 1
        FROM "balance_ledger_allocation_repairs" allocation_repair
        WHERE account_row."type" = 'enterprise'
          AND allocation_repair."run_id" = target_run_id
          AND allocation_repair."billing_account_id" = target_account_id
          AND (
            allocation_repair."before_snapshot"
              - 'ledger_sequence'
              - 'recognized_revenue_usd'
              - 'bonus_consumed_usd'
          ) IS DISTINCT FROM (
            allocation_repair."after_snapshot"
              - 'ledger_sequence'
              - 'recognized_revenue_usd'
              - 'bonus_consumed_usd'
          )
      )
      OR EXISTS (
        -- Any repair audit that changed only allocation settlement/components
        -- (plus an optional sequence) must be represented by the terminal plan
        -- evidence above. Canonical grant/source rewrites are intentionally
        -- outside this component-only reverse check.
        SELECT 1
        FROM "balance_ledger_allocation_repairs" allocation_repair
        WHERE allocation_repair."run_id" = target_run_id
          AND allocation_repair."billing_account_id" = target_account_id
          AND allocation_repair."before_snapshot"->>'source'
            IS NOT DISTINCT FROM allocation_repair."after_snapshot"->>'source'
          AND allocation_repair."before_snapshot"->>'balance_grant_id'
            IS NOT DISTINCT FROM allocation_repair."after_snapshot"->>'balance_grant_id'
          AND (allocation_repair."before_snapshot"->>'amount_usd')::NUMERIC
            IS NOT DISTINCT FROM
              (allocation_repair."after_snapshot"->>'amount_usd')::NUMERIC
          AND (allocation_repair."before_snapshot"->>'discount_rate')::NUMERIC
            IS NOT DISTINCT FROM
              (allocation_repair."after_snapshot"->>'discount_rate')::NUMERIC
          AND (
            (allocation_repair."before_snapshot"->>'settled_usd')::NUMERIC
              IS DISTINCT FROM
                (allocation_repair."after_snapshot"->>'settled_usd')::NUMERIC
            OR (allocation_repair."before_snapshot"->>'recognized_revenue_usd')::NUMERIC
              IS DISTINCT FROM
                (allocation_repair."after_snapshot"->>'recognized_revenue_usd')::NUMERIC
            OR (allocation_repair."before_snapshot"->>'bonus_consumed_usd')::NUMERIC
              IS DISTINCT FROM
                (allocation_repair."after_snapshot"->>'bonus_consumed_usd')::NUMERIC
            OR (allocation_repair."before_snapshot"->>'settled_at')::TIMESTAMP
              IS DISTINCT FROM
                (allocation_repair."after_snapshot"->>'settled_at')::TIMESTAMP
          )
          AND NOT EXISTS (
            SELECT 1
            FROM jsonb_array_elements(COALESCE(
              repair_row."after_snapshot"->'allocationMutations',
              '[]'::JSONB
            )) mutation
            WHERE mutation->>'allocationId' = allocation_repair."allocation_id"
          )
      )
      OR (repair_row."after_snapshot"->>'invoiceItemCount')::BIGINT
        IS DISTINCT FROM invoice_item_count
      OR (repair_row."after_snapshot"->>'unsafeInvoiceItemCount')::BIGINT
        IS DISTINCT FROM unsafe_invoice_item_count
      OR repair_row."after_snapshot"->>'invalidTransactionSequenceCount' IS DISTINCT FROM '0'
      OR repair_row."after_snapshot"->>'invalidComponentCount' IS DISTINCT FROM '0'
      OR repair_row."after_snapshot"->>'invalidAllocationSequenceCount' IS DISTINCT FROM '0'
      OR repair_row."after_snapshot"->>'invalidGrantAllocationCount' IS DISTINCT FROM '0'
      OR repair_row."after_snapshot"->>'unexpectedDebtCount' IS DISTINCT FROM '0'
      OR repair_row."after_snapshot"->>'invalidSettlementCount' IS DISTINCT FROM '0'
      OR repair_row."after_snapshot"->>'invalidConsumeAllocationCount' IS DISTINCT FROM '0'
      OR repair_row."after_snapshot"->>'invalidGrantConservationCount' IS DISTINCT FROM '0'
      OR repair_row."after_snapshot"->>'ledgerStatus' IS DISTINCT FROM 'RECONCILED_V2'
      OR (repair_row."after_snapshot"->>'ledgerVersion')::INTEGER IS DISTINCT FROM 2
      OR repair_row."after_snapshot"->>'throughTransactionId'
        IS DISTINCT FROM account_row."balance_grant_ledger_through_transaction_id"
      OR ((repair_row."after_snapshot"->>'reconciledAt')::TIMESTAMPTZ AT TIME ZONE 'UTC')
        IS DISTINCT FROM account_row."balance_grant_ledger_reconciled_at"
    THEN
      RAISE EXCEPTION 'balance ledger promotion repair snapshot mismatch: %', target_account_id
        USING ERRCODE = '23514';
    END IF;
  END IF;
END
$$;

COMMIT;
