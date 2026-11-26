-- grant 守恒公式把 balance_debt_settlement_pending 计入已分配 —— 与 20260921000300 对称
--
-- 20260921 23:40 运营第二次重试:debt 守恒已平(debt=12968.525=-wallet,000300 生效),
-- 唯一剩余违例是 grant_conservation=1:
--   充值新建 grant(paid=13280.22),核销同步部分写 settlement 4697.14 并扣减 remaining,
--   转 pending 的 8583.08 同样扣减了 remaining —— 但 grant 公式(paid = remaining +
--   allocation + settlement + refund + expiry)不认 pending ⇒ 右边缺 8583.08,
--   恰等于 pendingEnqueuedUsd,与 debt 侧完全同构。
-- 修法:paid/bonus 两个公式的 settlement 项之后各追加 pending 队列的同名分项
-- (pending 行带 balance_grant_id,b5a77a7 enqueue 时写入)。
-- 纯 CREATE OR REPLACE FUNCTION,不取表锁;其余部分从 prod(已含 000300)
-- pg_get_functiondef 导出后精确插入。
CREATE OR REPLACE FUNCTION public.assert_clean_account_wallet_canonical_deferred()
 RETURNS trigger
 LANGUAGE plpgsql
AS $function$
DECLARE
  target_account_id TEXT;
  account_type TEXT;
  account_status TEXT;
  account_reconciled_at TIMESTAMP(3);
  wallet_balance NUMERIC;
  active_grant_amount NUMERIC;
  open_debt_amount NUMERIC;
  pending_settlement_total NUMERIC;
  invalid_grant_count BIGINT;
  invalid_grant_conservation_count BIGINT;
  invalid_debt_count BIGINT;
  invalid_sequence_count BIGINT;
  unexpected_debt_count BIGINT;
  expected_debt_source TEXT;
  transaction_total NUMERIC;
  invalid_transaction_count BIGINT;
  invalid_allocation_count BIGINT;
  invalid_consume_count BIGINT;
  invalid_refund_transaction_count BIGINT;
  financial_now_text TEXT;
  parsed_financial_now TIMESTAMP(3);
  revision_state JSONB;
  validated_state JSONB;
  current_revision BIGINT;
  validated_revision BIGINT;
BEGIN
  IF gateway_balance_canonical_mutation_is_current_settlement(
    TG_TABLE_NAME,
    TG_OP,
    CASE WHEN TG_OP = 'INSERT' THEN NULL ELSE to_jsonb(OLD) END,
    to_jsonb(NEW)
  ) THEN
    RETURN NULL;
  END IF;

  target_account_id := NEW."billing_account_id";
  SELECT
    account."type",
    account."balance_grant_ledger_status",
    account."balance_grant_ledger_reconciled_at",
    wallet."balance_usd"
    INTO account_type, account_status, account_reconciled_at, wallet_balance
  FROM "billing_accounts" account
  JOIN "account_wallets" wallet
    ON wallet."billing_account_id" = account."id"
  WHERE account."id" = target_account_id;

  IF NOT FOUND OR account_status <> 'RECONCILED_V2' THEN
    RETURN NULL;
  END IF;

  -- A legacy personal->enterprise absorb pair is repaired atomically across
  -- two accounts.  During that one repair transaction, validate the exact
  -- database-backed pair proof instead of evaluating either side in
  -- isolation.  The helper returns FALSE for every non-pair writer, so the
  -- canonical validator below remains the default path.
  IF "balance_enterprise_absorb_active_pair_is_valid"(target_account_id) THEN
    RETURN NULL;
  END IF;

  BEGIN
    revision_state := COALESCE(
      NULLIF(current_setting('billing.balance_canonical_revisions', TRUE), ''),
      '{}'
    )::JSONB;
    validated_state := COALESCE(
      NULLIF(current_setting('billing.balance_canonical_validated', TRUE), ''),
      '{}'
    )::JSONB;
    current_revision := COALESCE(
      (revision_state ->> target_account_id)::BIGINT,
      0
    );
    validated_revision := COALESCE(
      (validated_state ->> target_account_id)::BIGINT,
      0
    );
  EXCEPTION WHEN OTHERS THEN
    RAISE EXCEPTION
      'clean account canonical validation state invalid account=%',
      target_account_id
      USING ERRCODE = '23514';
  END;
  IF current_revision <= 0 THEN
    RAISE EXCEPTION
      'clean account canonical mutation lacks revision marker account=%',
      target_account_id
      USING ERRCODE = '23514';
  END IF;
  IF validated_revision = current_revision THEN
    RETURN NULL;
  END IF;

  -- Use one immutable writer clock for every table participating in the
  -- canonical aggregate. No live wall clock is sampled by deferred triggers.
  financial_now_text := current_setting('billing.balance_financial_now', TRUE);
  IF financial_now_text IS NOT NULL AND btrim(financial_now_text) <> '' THEN
    BEGIN
      parsed_financial_now := financial_now_text::TIMESTAMP(3);
    EXCEPTION WHEN OTHERS THEN
      RAISE EXCEPTION
        'clean account mutation has invalid locked financial now: %',
        target_account_id
        USING ERRCODE = '23514';
    END;
  END IF;
  -- EMPTY_V2 wallet creation at zero is non-financial. Every non-zero INSERT
  -- or actual wallet balance change must come from a post-lock V2 writer.
  IF TG_TABLE_NAME = 'account_wallets' THEN
    IF (
      (TG_OP = 'INSERT' AND NEW."balance_usd" <> 0)
      OR (TG_OP = 'UPDATE' AND NEW."balance_usd" IS DISTINCT FROM OLD."balance_usd")
    )
      AND parsed_financial_now IS NULL
    THEN
      RAISE EXCEPTION
        'clean account wallet mutation lacks locked financial now: %',
        target_account_id
        USING ERRCODE = '23514';
    END IF;
  END IF;

  SELECT
    COALESCE(SUM(grant_row."remaining_amount_usd") FILTER (
      WHERE NOT grant_row."is_expired"
        AND grant_row."valid_from" <= COALESCE(
          parsed_financial_now,
          account_reconciled_at
        )
        AND (
          grant_row."expires_at" IS NULL
          OR grant_row."expires_at" > COALESCE(
            parsed_financial_now,
            account_reconciled_at
          )
        )
    ), 0),
    COUNT(*) FILTER (
      WHERE grant_row."remaining_amount_usd" < 0
        OR grant_row."remaining_paid_amount_usd" IS NULL
        OR grant_row."remaining_bonus_amount_usd" IS NULL
        OR grant_row."remaining_paid_amount_usd" < 0
        OR grant_row."remaining_bonus_amount_usd" < 0
        OR grant_row."remaining_paid_amount_usd"
          + grant_row."remaining_bonus_amount_usd"
          <> grant_row."remaining_amount_usd"
        OR grant_row."paid_amount_usd" < 0
        OR grant_row."bonus_amount_usd" < 0
        OR grant_row."granted_amount_usd" <= 0
        OR grant_row."paid_amount_usd" + grant_row."bonus_amount_usd"
          <> grant_row."granted_amount_usd"
        OR grant_row."discount_rate" IS DISTINCT FROM CASE
          WHEN grant_row."granted_amount_usd" > 0 THEN ROUND(
            grant_row."paid_amount_usd" / grant_row."granted_amount_usd",
            12
          )
          ELSE 0
        END
        OR grant_row."remaining_paid_amount_usd" > grant_row."paid_amount_usd"
        OR grant_row."remaining_bonus_amount_usd" > grant_row."bonus_amount_usd"
        OR (
          grant_row."valid_from" > grant_row."created_at"
          AND NOT EXISTS (
            SELECT 1
            FROM "balance_funding_candidates"(
              target_account_id,
              account_type
            ) proven_funding
            WHERE proven_funding.grant_id = grant_row."id"
          )
        )
        OR (
          grant_row."expires_at" IS NOT NULL
          AND grant_row."expires_at" <= grant_row."valid_from"
        )
        OR (
          grant_row."is_expired"
          AND (
            grant_row."remaining_amount_usd" <> 0
            OR grant_row."remaining_paid_amount_usd" <> 0
            OR grant_row."remaining_bonus_amount_usd" <> 0
          )
        )
    )
    INTO active_grant_amount, invalid_grant_count
  FROM "balance_grants" grant_row
  WHERE grant_row."billing_account_id" = target_account_id;

  -- Aggregate equality is insufficient: moving the same amount between two
  -- grants leaves the wallet unchanged while corrupting the recharge-detail
  -- rows. Prove each paid/bonus component independently from immutable facts.
  -- REFUND_NETTING settlements and refund allocations describe the same grant
  -- reduction, so only the latter participates in this equation.
  SELECT COUNT(*) INTO invalid_grant_conservation_count
  FROM "balance_grants" grant_row
  WHERE grant_row."billing_account_id" = target_account_id
    AND (
      grant_row."paid_amount_usd" IS DISTINCT FROM (
        grant_row."remaining_paid_amount_usd"
        + COALESCE((
          SELECT SUM(allocation."recognized_revenue_usd")
          FROM "balance_consumption_allocations" allocation
          WHERE allocation."balance_grant_id" = grant_row."id"
            AND (
              allocation."billing_account_id" = target_account_id
              OR "balance_allocation_has_enterprise_absorb_proof"(
                allocation."id",
                grant_row."id",
                allocation."billing_account_id"
              )
            )
            AND allocation."source" = 'BALANCE_GRANT'
        ), 0)
        + COALESCE((
          SELECT SUM(settlement."paid_usd")
          FROM "enterprise_credit_settlements" settlement
          WHERE COALESCE(
              settlement."balance_grant_id",
              "balance_legacy_settlement_effective_grant_id"(settlement."id")
            ) = grant_row."id"
            AND settlement."billing_account_id" = target_account_id
            AND settlement."trigger" <> 'REFUND_NETTING'
        ), 0)
        + COALESCE((
          SELECT SUM(pending_row."remaining_paid_usd")
          FROM "balance_debt_settlement_pending" pending_row
          WHERE pending_row."balance_grant_id" = grant_row."id"
        ), 0)
        + COALESCE((
          SELECT SUM(refund_allocation."paid_reduction_usd")
          FROM "balance_grant_refund_allocations" refund_allocation
          JOIN "balance_grant_refunds" refund
            ON refund."id" = refund_allocation."refund_id"
          WHERE refund_allocation."balance_grant_id" = grant_row."id"
            AND refund."billing_account_id" = target_account_id
        ), 0)
        + COALESCE((
          SELECT expiry."nominal_paid_usd"
          FROM "balance_grant_expiries" expiry
          WHERE expiry."balance_grant_id" = grant_row."id"
            AND expiry."billing_account_id" = target_account_id
        ), 0)
      )
      OR grant_row."bonus_amount_usd" IS DISTINCT FROM (
        grant_row."remaining_bonus_amount_usd"
        + COALESCE((
          SELECT SUM(allocation."bonus_consumed_usd")
          FROM "balance_consumption_allocations" allocation
          WHERE allocation."balance_grant_id" = grant_row."id"
            AND (
              allocation."billing_account_id" = target_account_id
              OR "balance_allocation_has_enterprise_absorb_proof"(
                allocation."id",
                grant_row."id",
                allocation."billing_account_id"
              )
            )
            AND allocation."source" = 'BALANCE_GRANT'
        ), 0)
        + COALESCE((
          SELECT SUM(settlement."bonus_usd")
          FROM "enterprise_credit_settlements" settlement
          WHERE COALESCE(
              settlement."balance_grant_id",
              "balance_legacy_settlement_effective_grant_id"(settlement."id")
            ) = grant_row."id"
            AND settlement."billing_account_id" = target_account_id
            AND settlement."trigger" <> 'REFUND_NETTING'
        ), 0)
        + COALESCE((
          SELECT SUM(pending_row."remaining_bonus_usd")
          FROM "balance_debt_settlement_pending" pending_row
          WHERE pending_row."balance_grant_id" = grant_row."id"
        ), 0)
        + COALESCE((
          SELECT SUM(refund_allocation."bonus_reduction_usd")
          FROM "balance_grant_refund_allocations" refund_allocation
          JOIN "balance_grant_refunds" refund
            ON refund."id" = refund_allocation."refund_id"
          WHERE refund_allocation."balance_grant_id" = grant_row."id"
            AND refund."billing_account_id" = target_account_id
        ), 0)
        + COALESCE((
          SELECT expiry."nominal_bonus_usd"
          FROM "balance_grant_expiries" expiry
          WHERE expiry."balance_grant_id" = grant_row."id"
            AND expiry."billing_account_id" = target_account_id
        ), 0)
      )
    );

  expected_debt_source := CASE
    WHEN account_type = 'enterprise' THEN 'ENTERPRISE_CREDIT'
    ELSE 'NEGATIVE_BALANCE'
  END;

  SELECT
    COALESCE(SUM(allocation."amount_usd" - allocation."settled_usd") FILTER (
      WHERE allocation."source" = expected_debt_source
    ), 0),
    COUNT(*) FILTER (
      WHERE allocation."amount_usd" <= 0
        OR allocation."settled_usd" < 0
        OR allocation."settled_usd" > allocation."amount_usd"
        OR allocation."recognized_revenue_usd" < 0
        OR allocation."bonus_consumed_usd" < 0
        OR allocation."recognized_revenue_usd"
          + allocation."bonus_consumed_usd" <> allocation."settled_usd"
        OR allocation."balance_grant_id" IS NOT NULL
        OR allocation."discount_rate" <> 0
        OR (allocation."settled_usd" = allocation."amount_usd")
          IS DISTINCT FROM (allocation."settled_at" IS NOT NULL)
    ),
    COUNT(*) FILTER (
      WHERE allocation."ledger_sequence" IS NULL
        OR allocation."ledger_sequence" = 0
    ),
    COUNT(*) FILTER (
      WHERE allocation."source" <> expected_debt_source
    )
    INTO
      open_debt_amount,
      invalid_debt_count,
      invalid_sequence_count,
      unexpected_debt_count
  FROM "balance_consumption_allocations" allocation
  WHERE allocation."billing_account_id" = target_account_id
    AND allocation."source" IN ('NEGATIVE_BALANCE', 'ENTERPRISE_CREDIT');

  -- 2026-09-21:转异步核销(b5a57a7)的金额已随充值进入钱包,但尚未落成 allocation 的
  -- settled 明细 —— 守恒视角必须把 pending 队列计入"已清偿",否则任何触发转 pending
  -- 的大额充值都会在 debt = -wallet 断言处必然违例(差值恰为 pending 合计,
  -- 国内 prod 实测:debt 21751.65 - pending 8783.66 = -wallet 12967.99)。
  -- 应用层前置推导(billing.service 的 pendingSettlementUsd 修正)与本式同源。
  -- 信任假设:pending 行仅由结算事务写入、由 drain worker 消费(FIFO + SKIP LOCKED),
  -- 每行的 remaining_paid/remaining_bonus 与其声明核销的欠款等量。
  SELECT COALESCE(SUM(
      pending_row."remaining_paid_usd" + pending_row."remaining_bonus_usd"
    ), 0)
    INTO pending_settlement_total
  FROM "balance_debt_settlement_pending" pending_row
  WHERE pending_row."billing_account_id" = target_account_id;
  open_debt_amount := open_debt_amount - pending_settlement_total;

  SELECT
    COALESCE(SUM(transaction_row."amount_usd"), 0),
    COUNT(*) FILTER (
      WHERE transaction_row."ledger_sequence" IS NULL
        OR transaction_row."ledger_sequence" = 0
        OR (transaction_row."type"::TEXT = 'CONSUME' AND transaction_row."amount_usd" >= 0)
        OR (transaction_row."type"::TEXT = 'RECHARGE' AND transaction_row."amount_usd" <= 0)
        OR (transaction_row."type"::TEXT = 'REFUND' AND transaction_row."amount_usd" >= 0)
        OR (transaction_row."type"::TEXT = 'ADJUST' AND transaction_row."amount_usd" = 0)
        OR transaction_row."type"::TEXT NOT IN ('CONSUME', 'RECHARGE', 'REFUND', 'ADJUST')
    )
    INTO transaction_total, invalid_transaction_count
  FROM "balance_transactions" transaction_row
  WHERE transaction_row."billing_account_id" = target_account_id;

  SELECT COUNT(*) FILTER (
    WHERE allocation."ledger_sequence" IS NULL
      OR allocation."ledger_sequence" = 0
      OR allocation."amount_usd" <= 0
      OR transaction_row."id" IS NULL
      OR transaction_row."billing_account_id" IS DISTINCT FROM target_account_id
      OR transaction_row."type"::TEXT NOT IN ('CONSUME', 'REFUND')
      OR allocation."user_id" IS DISTINCT FROM transaction_row."user_id"
      OR allocation."tenant_id" IS DISTINCT FROM transaction_row."tenant_id"
      OR allocation."product_id" IS DISTINCT FROM transaction_row."product_id"
      OR allocation."token_usage_id" IS DISTINCT FROM transaction_row."token_usage_id"
      OR (
        allocation."source" = 'BALANCE_GRANT'
        AND (
          transaction_row."type"::TEXT <> 'CONSUME'
          OR
          grant_row."id" IS NULL
          OR (
            grant_row."billing_account_id" IS DISTINCT FROM target_account_id
            AND NOT "balance_allocation_has_enterprise_absorb_proof"(
              allocation."id",
              grant_row."id",
              target_account_id
            )
          )
          OR allocation."recognized_revenue_usd" < 0
          OR allocation."bonus_consumed_usd" < 0
          OR allocation."recognized_revenue_usd" + allocation."bonus_consumed_usd"
            <> allocation."amount_usd"
          OR allocation."discount_rate" IS DISTINCT FROM CASE
            WHEN allocation."amount_usd" > 0 THEN ROUND(
              allocation."recognized_revenue_usd" / allocation."amount_usd",
              12
            )
            ELSE 0
          END
          OR allocation."settled_usd" <> 0
          OR allocation."settled_at" IS NOT NULL
        )
      )
      OR (
        allocation."source" = expected_debt_source
        AND (
          allocation."balance_grant_id" IS NOT NULL
          OR allocation."discount_rate" <> 0
          OR allocation."settled_usd" < 0
          OR allocation."settled_usd" > allocation."amount_usd"
          OR allocation."recognized_revenue_usd" < 0
          OR allocation."bonus_consumed_usd" < 0
          OR allocation."recognized_revenue_usd" + allocation."bonus_consumed_usd"
            <> allocation."settled_usd"
          OR (allocation."settled_usd" = allocation."amount_usd")
            IS DISTINCT FROM (allocation."settled_at" IS NOT NULL)
          OR (
            transaction_row."type"::TEXT = 'REFUND'
            AND NOT EXISTS (
              SELECT 1
              FROM "balance_grant_refunds" refund
              WHERE refund."debt_allocation_id" = allocation."id"
                AND refund."refund_transaction_id" = transaction_row."id"
                AND refund."billing_account_id" = target_account_id
                AND refund."operation_key" IS NOT DISTINCT FROM
                  transaction_row."operation_key"
                AND refund."requested_amount_usd" = -transaction_row."amount_usd"
                AND refund."debt_opened_usd" = allocation."amount_usd"
                AND refund."debt_netted_usd" <= allocation."settled_usd"
                AND refund."open_debt_usd"
                  = refund."debt_opened_usd" - refund."debt_netted_usd"
                AND refund."occurred_at" = transaction_row."created_at"
                AND refund."debt_netted_usd" = COALESCE((
                  SELECT SUM(settlement."amount_usd")
                  FROM "enterprise_credit_settlements" settlement
                  WHERE settlement."allocation_id" = allocation."id"
                    AND settlement."repayment_transaction_id" = transaction_row."id"
                    AND settlement."trigger" = 'REFUND_NETTING'
                ), 0)
            )
          )
          OR (
            transaction_row."type"::TEXT = 'CONSUME'
            AND EXISTS (
              SELECT 1
              FROM "balance_grant_refunds" refund
              WHERE refund."debt_allocation_id" = allocation."id"
            )
          )
        )
      )
      OR allocation."source" NOT IN ('BALANCE_GRANT', expected_debt_source)
  )
    INTO invalid_allocation_count
  FROM "balance_consumption_allocations" allocation
  LEFT JOIN "balance_transactions" transaction_row
    ON transaction_row."id" = allocation."balance_transaction_id"
  LEFT JOIN "balance_grants" grant_row
    ON grant_row."id" = allocation."balance_grant_id"
  WHERE allocation."billing_account_id" = target_account_id;

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
      AND NOT "balance_allocation_has_enterprise_absorb_proof"(
        foreign_allocation."id",
        target_grant."id",
        foreign_allocation."billing_account_id"
      )
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
    SELECT transaction_row."id"
    FROM "balance_transactions" transaction_row
    LEFT JOIN "balance_consumption_allocations" allocation
      ON allocation."balance_transaction_id" = transaction_row."id"
      AND allocation."billing_account_id" = target_account_id
    WHERE transaction_row."billing_account_id" = target_account_id
      AND transaction_row."type"::TEXT = 'CONSUME'
    GROUP BY
      transaction_row."id",
      transaction_row."amount_usd",
      transaction_row."balance_after_usd"
    HAVING COALESCE(SUM(allocation."amount_usd"), 0) <> -transaction_row."amount_usd"
      OR COALESCE(SUM(allocation."amount_usd") FILTER (
        WHERE allocation."source" = 'BALANCE_GRANT'
      ), 0) <> LEAST(
        -transaction_row."amount_usd",
        GREATEST(transaction_row."balance_after_usd" - transaction_row."amount_usd", 0)
      )
      OR COALESCE(SUM(allocation."amount_usd") FILTER (
        WHERE allocation."source" = expected_debt_source
      ), 0) <> -transaction_row."amount_usd" - LEAST(
        -transaction_row."amount_usd",
        GREATEST(transaction_row."balance_after_usd" - transaction_row."amount_usd", 0)
      )
  ) invalid_consume;

  -- Negative ledger sequences are repair-proven legacy history. Every
  -- post-expand REFUND receives a positive database sequence and must have a
  -- terminal immutable refund audit before the transaction can commit.
  SELECT COUNT(*) INTO invalid_refund_transaction_count
  FROM "balance_transactions" transaction_row
  WHERE transaction_row."billing_account_id" = target_account_id
    AND transaction_row."type"::TEXT = 'REFUND'
    AND transaction_row."ledger_sequence" > 0
    AND NOT EXISTS (
      SELECT 1
      FROM "balance_grant_refunds" refund
      WHERE refund."refund_transaction_id" = transaction_row."id"
        AND refund."billing_account_id" = target_account_id
        AND refund."operation_key" IS NOT DISTINCT FROM
          transaction_row."operation_key"
        AND refund."requested_amount_usd" = -transaction_row."amount_usd"
        AND refund."occurred_at" = transaction_row."created_at"
    );

  IF active_grant_amount IS DISTINCT FROM GREATEST(wallet_balance, 0)
    OR open_debt_amount IS DISTINCT FROM GREATEST(-wallet_balance, 0)
    OR wallet_balance IS DISTINCT FROM active_grant_amount - open_debt_amount
    OR transaction_total IS DISTINCT FROM wallet_balance
    OR invalid_transaction_count <> 0
    OR invalid_grant_count <> 0
    OR invalid_grant_conservation_count <> 0
    OR invalid_debt_count <> 0
    OR invalid_sequence_count <> 0
    OR unexpected_debt_count <> 0
    OR invalid_allocation_count <> 0
    OR invalid_consume_count <> 0
    OR invalid_refund_transaction_count <> 0
  THEN
    RAISE EXCEPTION
      'clean account canonical invariant invalid account=% wallet=% tx=% active=% debt=% invalid(tx/grant/grant_conservation/debt/sequence/unexpected/allocation/consume/refund)=%/%/%/%/%/%/%/%/%',
      target_account_id,
      wallet_balance,
      transaction_total,
      active_grant_amount,
      open_debt_amount,
      invalid_transaction_count,
      invalid_grant_count,
      invalid_grant_conservation_count,
      invalid_debt_count,
      invalid_sequence_count,
      unexpected_debt_count,
      invalid_allocation_count,
      invalid_consume_count,
      invalid_refund_transaction_count
      USING ERRCODE = '23514';
  END IF;

  PERFORM set_config(
    'billing.balance_canonical_validated',
    jsonb_set(
      validated_state,
      ARRAY[target_account_id],
      to_jsonb(current_revision),
      TRUE
    )::TEXT,
    TRUE
  );

  RETURN NULL;
END
$function$

