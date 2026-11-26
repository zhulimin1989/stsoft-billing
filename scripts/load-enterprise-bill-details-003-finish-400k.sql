-- Resume ba_v2_demo_003 from row 100001. No grant FK (avoids balance_grants deadlock).
-- Then align 002/003 wallets and re-enable triggers.

SET client_min_messages = NOTICE;
SET synchronous_commit = off;
SET work_mem = '256MB';
SET statement_timeout = 0;
SET lock_timeout = 0;

ALTER TABLE token_usage DISABLE TRIGGER USER;
ALTER TABLE balance_transactions DISABLE TRIGGER USER;
ALTER TABLE balance_consumption_allocations DISABLE TRIGGER USER;
ALTER TABLE account_wallets DISABLE TRIGGER USER;

CREATE OR REPLACE PROCEDURE loadtest_l3_month_from(
  p_tag TEXT,
  p_account_id TEXT,
  p_tenant_id TEXT,
  p_user_id TEXT,
  p_api_key_id TEXT,
  p_wallet_start NUMERIC,
  p_from INTEGER,
  p_rows INTEGER,
  p_batch INTEGER
)
LANGUAGE plpgsql
AS $$
DECLARE
  start_n INTEGER := p_from;
  end_n INTEGER;
  txn_seq BIGINT;
  alloc_seq BIGINT;
  product_id TEXT := '2232ff07-1144-4038-b5cf-376915160e66';
  step INTERVAL := INTERVAL '2592000 seconds' / p_rows;
BEGIN
  SELECT COALESCE(MAX(ledger_sequence), 0) INTO txn_seq
  FROM balance_transactions WHERE billing_account_id = p_account_id;
  SELECT COALESCE(MAX(ledger_sequence), 0) INTO alloc_seq
  FROM balance_consumption_allocations WHERE billing_account_id = p_account_id;

  WHILE start_n <= p_rows LOOP
    end_n := LEAST(start_n + p_batch - 1, p_rows);

    INSERT INTO token_usage (
      id, api_key_id, tenant_id, product_id, request_id, model, meter,
      prompt_tokens, completion_tokens, total_tokens,
      input_price_usd_per_m, output_price_usd_per_m, cost_usd,
      customer_charge_policy, customer_charge_usd,
      customer_collected_usd, customer_approved_receivable_usd, customer_unapproved_debt_usd,
      customer_funding_classification_complete, call_type, created_at
    )
    SELECT
      'tu_l3_' || p_tag || '_202609_' || lpad(g::text, 8, '0'),
      p_api_key_id,
      p_tenant_id,
      product_id,
      'req_l3_' || p_tag || '_202609_' || lpad(g::text, 8, '0'),
      (ARRAY['gpt-4o-mini','claude-sonnet-4','deepseek-v3','gemini-2.5-pro'])[1 + (g % 4)],
      'token',
      200 + (g % 4000),
      80 + (g % 1200),
      280 + (g % 4000) + (g % 1200),
      0.15,
      0.60,
      0.001,
      'usage_charge',
      0.001,
      0, 0, 0,
      false,
      'chat',
      TIMESTAMP '2026-09-01 00:00:00' + ((g - 1) * step)
    FROM generate_series(start_n, end_n) AS g;

    INSERT INTO balance_transactions (
      id, user_id, tenant_id, billing_account_id, type, amount_usd, balance_after_usd,
      description, product_id, token_usage_id, ledger_sequence, created_at
    )
    SELECT
      'bt_l3_' || p_tag || '_202609_' || lpad(g::text, 8, '0'),
      p_user_id,
      p_tenant_id,
      p_account_id,
      'CONSUME',
      -0.001,
      p_wallet_start - (0.001 * g),
      'loadtest 2026-09 consume',
      product_id,
      'tu_l3_' || p_tag || '_202609_' || lpad(g::text, 8, '0'),
      txn_seq + (g - p_from + 1),
      TIMESTAMP '2026-09-01 00:00:00' + ((g - 1) * step)
    FROM generate_series(start_n, end_n) AS g;

    INSERT INTO balance_consumption_allocations (
      id, user_id, tenant_id, billing_account_id, product_id,
      balance_transaction_id, token_usage_id, balance_grant_id, source,
      amount_usd, recognized_revenue_usd, bonus_consumed_usd, discount_rate,
      settled_usd, ledger_sequence, created_at,
      approved_credit_usd, unapproved_debt_usd, funding_classification_complete,
      credit_policy_snapshot_complete
    )
    SELECT
      'al_l3_' || p_tag || '_202609_' || lpad(g::text, 8, '0'),
      p_user_id,
      p_tenant_id,
      p_account_id,
      product_id,
      'bt_l3_' || p_tag || '_202609_' || lpad(g::text, 8, '0'),
      'tu_l3_' || p_tag || '_202609_' || lpad(g::text, 8, '0'),
      NULL,
      'ENTERPRISE_CREDIT',
      0.001,
      CASE WHEN g % 10 = 9 THEN 0.0008 ELSE 0.001 END,
      CASE WHEN g % 10 = 9 THEN 0.0002 ELSE 0 END,
      1,
      0,
      alloc_seq + (g - p_from + 1),
      TIMESTAMP '2026-09-01 00:00:00' + ((g - 1) * step),
      0, 0, false, false
    FROM generate_series(start_n, end_n) AS g;

    RAISE NOTICE 'l3 % inserted %-% / %', p_tag, start_n, end_n, p_rows;
    start_n := end_n + 1;
    COMMIT;
  END LOOP;
END
$$;

SELECT balance_usd AS wallet FROM account_wallets WHERE billing_account_id = 'ba_v2_demo_003' \gset a003_

\echo finish 003 100001-400000
CALL loadtest_l3_month_from('003', 'ba_v2_demo_003', 'tenant_v2_demo_003', 'user_v2_demo_003', 'ak_v2_demo_003', :'a003_wallet'::numeric, 100001, 400000, 100000);

UPDATE account_wallets w
SET balance_usd = t.balance_after_usd,
    updated_at = TIMESTAMP '2026-09-24 00:00:00'
FROM (
  SELECT DISTINCT ON (billing_account_id) billing_account_id, balance_after_usd
  FROM balance_transactions
  WHERE billing_account_id = 'ba_v2_demo_002' OR billing_account_id = 'ba_v2_demo_003'
  ORDER BY billing_account_id, ledger_sequence DESC
) t
WHERE w.billing_account_id = t.billing_account_id;

ALTER TABLE token_usage ENABLE TRIGGER USER;
ALTER TABLE balance_transactions ENABLE TRIGGER USER;
ALTER TABLE balance_consumption_allocations ENABLE TRIGGER USER;
ALTER TABLE account_wallets ENABLE TRIGGER USER;

ANALYZE token_usage;
ANALYZE balance_transactions;
ANALYZE balance_consumption_allocations;

SELECT tenant_id, COUNT(*) AS token_usage
FROM token_usage
WHERE tenant_id = 'tenant_v2_demo_002' OR tenant_id = 'tenant_v2_demo_003'
GROUP BY 1
ORDER BY 1;

SELECT billing_account_id, COUNT(*) AS consume
FROM balance_transactions
WHERE billing_account_id = 'ba_v2_demo_002' OR billing_account_id = 'ba_v2_demo_003'
GROUP BY 1
ORDER BY 1;

SELECT billing_account_id, COUNT(*) AS alloc
FROM balance_consumption_allocations
WHERE billing_account_id = 'ba_v2_demo_002' OR billing_account_id = 'ba_v2_demo_003'
GROUP BY 1
ORDER BY 1;

SELECT billing_account_id, balance_usd
FROM account_wallets
WHERE billing_account_id = 'ba_v2_demo_002' OR billing_account_id = 'ba_v2_demo_003'
ORDER BY 1;

SELECT t.tgrelid::regclass, t.tgenabled
FROM pg_trigger t
WHERE t.tgrelid IN ('token_usage'::regclass,'balance_transactions'::regclass,'balance_consumption_allocations'::regclass,'account_wallets'::regclass)
  AND NOT t.tgisinternal
GROUP BY 1, 2
ORDER BY 1;
