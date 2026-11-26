BEGIN;
SET LOCAL lock_timeout = '5s';

-- The scoped overload shares the existing six funding proof branches. Fail
-- closed if a different environment has changed either financial contract.
DO $guard$
BEGIN
  IF (SELECT md5(prosrc) FROM pg_proc WHERE oid =
      'public.balance_funding_candidates(text,text)'::regprocedure) <> 'e4a6e125ef15637059ad216e7cc699e3'
    OR (SELECT md5(prosrc) FROM pg_proc WHERE oid =
      'public.assert_balance_grant_funding_aggregate(text)'::regprocedure) <> '8fe45efbd137acb38f48e9cccec86af4'
  THEN
    RAISE EXCEPTION 'Unexpected funding proof baseline';
  END IF;
END;
$guard$;

CREATE FUNCTION public.balance_funding_candidates(target_account_id text, target_account_type text, target_funding_ids text[])
 RETURNS TABLE(funding_id text, grant_id text, nature text)
 LANGUAGE sql
 STABLE
AS $function$
  WITH positive_funding AS (
    SELECT funding.*
    FROM "balance_transactions" funding
    WHERE funding."billing_account_id" = target_account_id
      AND funding."amount_usd" > 0
      AND (target_funding_ids IS NULL OR funding.id = ANY(target_funding_ids))
  )
  SELECT funding."id", NULL::TEXT, 'PAID'::TEXT
  FROM positive_funding funding
  WHERE target_account_type = 'enterprise'
    AND funding."type"::TEXT = 'ADJUST'
    AND funding."operation_key"
      ~ '^balance:admin-adjust:enterprise-paid-debt:[^[:space:]]+$'

  UNION ALL

  SELECT funding."id", proof."balance_grant_id", 'PAID'::TEXT
  FROM positive_funding funding
  JOIN "balance_ledger_admin_funding_repairs" proof
    ON proof."billing_account_id" = target_account_id
    AND proof."balance_transaction_id" = funding."id"
    AND proof."action" = 'CREATE_GRANT'
  WHERE target_account_type = 'enterprise'
    AND funding."type"::TEXT = 'ADJUST'
    AND funding."order_id" IS NULL
    AND funding."operation_key" IS NULL
    AND "balance_admin_funding_terminal_grant_id"(
      target_account_id,
      funding."id"
    ) = proof."balance_grant_id"

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
      OR (
        "balance_admin_funding_terminal_grant_id"(
          target_account_id,
          funding."id"
        ) = grant_row."id"
        AND grant_row."created_at" > funding."created_at"
        AND grant_row."valid_from" >= funding."created_at"
        AND grant_row."valid_from" <= grant_row."created_at"
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

$function$;

-- Existing account-wide reconciliation callers retain all six proof branches.
CREATE OR REPLACE FUNCTION public.balance_funding_candidates(target_account_id text, target_account_type text)
RETURNS TABLE(funding_id text, grant_id text, nature text)
LANGUAGE sql STABLE AS $function$
  SELECT * FROM public.balance_funding_candidates(target_account_id, target_account_type, NULL::text[])
$function$;

CREATE OR REPLACE FUNCTION public.assert_balance_grant_funding_aggregate(target_grant_id text)
 RETURNS void
 LANGUAGE plpgsql
AS $function$
DECLARE
  grant_row RECORD;
  account_type TEXT;
  account_status TEXT;
  funded_paid NUMERIC;
  funded_bonus NUMERIC;
  invalid_candidate_count BIGINT;
BEGIN
  SELECT grant_row_source.*, account."type", account."balance_grant_ledger_status"
  INTO grant_row
  FROM "balance_grants" grant_row_source
  JOIN "billing_accounts" account
    ON account."id" = grant_row_source."billing_account_id"
  WHERE grant_row_source."id" = target_grant_id;
  IF NOT FOUND THEN
    RAISE EXCEPTION 'balance grant funding proof references missing batch: %', target_grant_id
      USING ERRCODE = '23514';
  END IF;
  account_type := grant_row."type";
  account_status := grant_row."balance_grant_ledger_status";
  IF account_status <> 'RECONCILED_V2' THEN
    RETURN;
  END IF;

  -- A matching recharge/bonus shares the order. Orderless legacy recharges
  -- and vouchers match the grant component amount. Admin repair proofs link
  -- the funding explicitly. These are only lookup keys, never proof of payment.
  WITH funding_ids AS (
    SELECT id FROM public.balance_transactions
    WHERE billing_account_id = grant_row.billing_account_id
      AND order_id = grant_row.order_id AND amount_usd > 0
    UNION
    SELECT id FROM public.balance_transactions
    WHERE grant_row.order_id IS NULL AND order_id IS NULL
      AND billing_account_id = grant_row.billing_account_id AND amount_usd > 0
      AND amount_usd IN (grant_row.paid_amount_usd, grant_row.bonus_amount_usd)
    UNION
    SELECT balance_transaction_id FROM public.balance_ledger_admin_funding_repairs
    WHERE balance_grant_id = target_grant_id
  ), matches AS (
    -- Count every possible grant (including NULL) before selecting this grant.
    SELECT candidate.*, count(*) OVER (PARTITION BY funding_id) AS match_count
    FROM public.balance_funding_candidates(
      grant_row.billing_account_id, account_type, ARRAY(SELECT id FROM funding_ids)
    ) candidate
  )
  SELECT COALESCE(sum(funding.amount_usd) FILTER (WHERE matches.nature = 'PAID'), 0),
         COALESCE(sum(funding.amount_usd) FILTER (WHERE matches.nature = 'BONUS'), 0),
         count(DISTINCT matches.funding_id) FILTER (WHERE matches.match_count <> 1)
  INTO funded_paid, funded_bonus, invalid_candidate_count
  FROM matches
  JOIN public.balance_transactions funding ON funding.id = matches.funding_id
  WHERE matches.grant_id = target_grant_id;

  IF grant_row."source" NOT IN ('RECHARGE', 'VOUCHER')
    OR funded_paid IS DISTINCT FROM grant_row."paid_amount_usd"
    OR funded_bonus IS DISTINCT FROM grant_row."bonus_amount_usd"
    OR invalid_candidate_count <> 0
  THEN
    RAISE EXCEPTION
      'balance grant canonical funding invalid grant=% paid=%/% bonus=%/% ambiguous=%',
      target_grant_id,
      grant_row."paid_amount_usd", funded_paid,
      grant_row."bonus_amount_usd", funded_bonus,
      invalid_candidate_count
      USING ERRCODE = '23514';
  END IF;
END
$function$;
COMMIT;
