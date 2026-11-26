-- Local load-test: 3 V2 demo enterprises, one Beijing month of bill details.
-- Prefixes: tu_l3_ / bt_l3_ / al_l3_ / grant_l3_ / req_l3_
-- Usage:
--   psql ... -v rows=2000 -f scripts/load-enterprise-bill-details-3x10m.sql
--   psql ... -f scripts/load-enterprise-bill-details-3x10m.sql
-- Default rows=1000000 (1 million per enterprise for 2026-09).

\if :{?rows}
\else
\set rows 1000000
\endif
\if :{?batch}
\else
\set batch 200000
\endif

SELECT set_config('loadtest.rows', :'rows', false);
SELECT set_config('loadtest.batch', :'batch', false);

SET client_min_messages = NOTICE;
SET synchronous_commit = off;
SET work_mem = '256MB';
SET maintenance_work_mem = '1GB';
SET statement_timeout = 0;
SET lock_timeout = 0;

ALTER TABLE token_usage DISABLE TRIGGER USER;
ALTER TABLE balance_transactions DISABLE TRIGGER USER;
ALTER TABLE balance_consumption_allocations DISABLE TRIGGER USER;
ALTER TABLE account_wallets DISABLE TRIGGER USER;

DROP INDEX IF EXISTS token_usage_api_key_id_idx;
DROP INDEX IF EXISTS token_usage_coding_plan_entitlement_id_idx;
DROP INDEX IF EXISTS token_usage_created_at_id_idx;
DROP INDEX IF EXISTS token_usage_funding_classification_created_idx;
DROP INDEX IF EXISTS token_usage_gateway_billing_event_id_key;
DROP INDEX IF EXISTS token_usage_model_idx;
DROP INDEX IF EXISTS token_usage_product_id_idx;
DROP INDEX IF EXISTS token_usage_provider_code_idx;
DROP INDEX IF EXISTS token_usage_provider_cost_policy_idx;
DROP INDEX IF EXISTS token_usage_provider_entitlement_id_idx;
DROP INDEX IF EXISTS token_usage_provider_line_code_idx;
DROP INDEX IF EXISTS token_usage_provider_line_id_idx;
DROP INDEX IF EXISTS token_usage_request_id_key;
DROP INDEX IF EXISTS token_usage_tenant_id_idx;

DROP INDEX IF EXISTS balance_transactions_account_ledger_sequence_key;
DROP INDEX IF EXISTS balance_transactions_account_online_created_idx;
DROP INDEX IF EXISTS balance_transactions_billing_account_id_created_at_idx;
DROP INDEX IF EXISTS balance_transactions_billing_account_id_idx;
DROP INDEX IF EXISTS balance_transactions_billing_account_id_type_created_at_idx;
DROP INDEX IF EXISTS balance_transactions_created_at_id_idx;
DROP INDEX IF EXISTS balance_transactions_operation_key_key;
DROP INDEX IF EXISTS balance_transactions_product_id_idx;
DROP INDEX IF EXISTS balance_transactions_tenant_id_created_at_idx;
DROP INDEX IF EXISTS balance_transactions_tenant_id_idx;
DROP INDEX IF EXISTS balance_transactions_tenant_id_type_created_at_idx;
DROP INDEX IF EXISTS balance_transactions_token_usage_id_key;
DROP INDEX IF EXISTS balance_transactions_type_idx;
DROP INDEX IF EXISTS balance_transactions_user_id_idx;

DROP INDEX IF EXISTS balance_allocations_account_funding_open_idx;
DROP INDEX IF EXISTS balance_consumption_allocations_account_ledger_sequence_key;
DROP INDEX IF EXISTS balance_consumption_allocations_account_source_created_idx;
DROP INDEX IF EXISTS balance_consumption_allocations_balance_grant_id_idx;
DROP INDEX IF EXISTS balance_consumption_allocations_balance_transaction_id_idx;
DROP INDEX IF EXISTS balance_consumption_allocations_billing_account_id_created_at_i;
DROP INDEX IF EXISTS balance_consumption_allocations_billing_account_id_idx;
DROP INDEX IF EXISTS balance_consumption_allocations_created_at_id_idx;
DROP INDEX IF EXISTS balance_consumption_allocations_credit_due_idx;
DROP INDEX IF EXISTS balance_consumption_allocations_product_id_idx;
DROP INDEX IF EXISTS balance_consumption_allocations_source_idx;
DROP INDEX IF EXISTS balance_consumption_allocations_tenant_id_created_at_idx;
DROP INDEX IF EXISTS balance_consumption_allocations_tenant_id_idx;
DROP INDEX IF EXISTS balance_consumption_allocations_token_usage_id_idx;
DROP INDEX IF EXISTS balance_consumption_allocations_user_id_idx;

DROP FUNCTION IF EXISTS loadtest_l3_month(TEXT, TEXT, TEXT, TEXT, TEXT, TEXT, NUMERIC, INTEGER, INTEGER);

CREATE OR REPLACE PROCEDURE loadtest_l3_month(
  p_tag TEXT,
  p_account_id TEXT,
  p_tenant_id TEXT,
  p_user_id TEXT,
  p_api_key_id TEXT,
  p_grant_id TEXT,
  p_wallet_start NUMERIC,
  p_rows INTEGER,
  p_batch INTEGER
)
LANGUAGE plpgsql
AS $$
DECLARE
  start_n INTEGER := 1;
  end_n INTEGER;
  txn_seq BIGINT;
  alloc_seq BIGINT;
  product_id TEXT := '2232ff07-1144-4038-b5cf-376915160e66';
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
      TIMESTAMP '2026-09-01 00:00:00' + ((g - 1) * INTERVAL '0.19872 second')
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
      txn_seq + g,
      TIMESTAMP '2026-09-01 00:00:00' + ((g - 1) * INTERVAL '0.19872 second')
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
      CASE WHEN p_grant_id IS NOT NULL AND g % 10 IN (7, 8) THEN p_grant_id ELSE NULL END,
      CASE WHEN p_grant_id IS NOT NULL AND g % 10 IN (7, 8) THEN 'BALANCE_GRANT' ELSE 'ENTERPRISE_CREDIT' END,
      0.001,
      CASE WHEN g % 10 = 9 THEN 0.0008 ELSE 0.001 END,
      CASE WHEN g % 10 = 9 THEN 0.0002 ELSE 0 END,
      1,
      0,
      alloc_seq + g,
      TIMESTAMP '2026-09-01 00:00:00' + ((g - 1) * INTERVAL '0.19872 second'),
      0, 0, false, false
    FROM generate_series(start_n, end_n) AS g;

    RAISE NOTICE 'l3 % inserted %-% / %', p_tag, start_n, end_n, p_rows;
    start_n := end_n + 1;
    COMMIT;
  END LOOP;
END
$$;

SELECT balance_usd AS wallet FROM account_wallets WHERE billing_account_id = 'ba_v2_demo_001' \gset a001_
SELECT balance_usd AS wallet FROM account_wallets WHERE billing_account_id = 'ba_v2_demo_002' \gset a002_
SELECT balance_usd AS wallet FROM account_wallets WHERE billing_account_id = 'ba_v2_demo_003' \gset a003_

\echo loadtest start
CALL loadtest_l3_month('001', 'ba_v2_demo_001', 'tenant_v2_demo_001', 'user_v2_demo_001', 'ak_v2_demo_001', 'e86ca25e-2283-43de-872d-42b159f98be1', :'a001_wallet'::numeric, :rows::int, :batch::int);
CALL loadtest_l3_month('002', 'ba_v2_demo_002', 'tenant_v2_demo_002', 'user_v2_demo_002', 'ak_v2_demo_002', NULL, :'a002_wallet'::numeric, :rows::int, :batch::int);
CALL loadtest_l3_month('003', 'ba_v2_demo_003', 'tenant_v2_demo_003', 'user_v2_demo_003', 'ak_v2_demo_003', '35a9693f-fb7c-4e86-be0c-d3d35ced7b8d', :'a003_wallet'::numeric, :rows::int, :batch::int);

CREATE UNIQUE INDEX token_usage_request_id_key ON token_usage (request_id);
CREATE UNIQUE INDEX token_usage_gateway_billing_event_id_key ON token_usage (gateway_billing_event_id);
CREATE INDEX token_usage_api_key_id_idx ON token_usage (api_key_id);
CREATE INDEX token_usage_coding_plan_entitlement_id_idx ON token_usage (coding_plan_entitlement_id);
CREATE INDEX token_usage_created_at_id_idx ON token_usage (created_at, id);
CREATE INDEX token_usage_funding_classification_created_idx ON token_usage (customer_funding_classification_complete, created_at);
CREATE INDEX token_usage_model_idx ON token_usage (model);
CREATE INDEX token_usage_product_id_idx ON token_usage (product_id);
CREATE INDEX token_usage_provider_code_idx ON token_usage (provider_code);
CREATE INDEX token_usage_provider_cost_policy_idx ON token_usage (provider_cost_policy_id);
CREATE INDEX token_usage_provider_entitlement_id_idx ON token_usage (provider_entitlement_id);
CREATE INDEX token_usage_provider_line_code_idx ON token_usage (provider_line_code);
CREATE INDEX token_usage_provider_line_id_idx ON token_usage (provider_line_id);
CREATE INDEX token_usage_tenant_id_idx ON token_usage (tenant_id);

CREATE UNIQUE INDEX balance_transactions_account_ledger_sequence_key ON balance_transactions (billing_account_id, ledger_sequence);
CREATE UNIQUE INDEX balance_transactions_operation_key_key ON balance_transactions (operation_key);
CREATE UNIQUE INDEX balance_transactions_token_usage_id_key ON balance_transactions (token_usage_id);
CREATE INDEX balance_transactions_account_online_created_idx ON balance_transactions (billing_account_id, created_at DESC) WHERE (ledger_sequence > 0);
CREATE INDEX balance_transactions_billing_account_id_created_at_idx ON balance_transactions (billing_account_id, created_at);
CREATE INDEX balance_transactions_billing_account_id_idx ON balance_transactions (billing_account_id);
CREATE INDEX balance_transactions_billing_account_id_type_created_at_idx ON balance_transactions (billing_account_id, type, created_at);
CREATE INDEX balance_transactions_created_at_id_idx ON balance_transactions (created_at, id);
CREATE INDEX balance_transactions_product_id_idx ON balance_transactions (product_id);
CREATE INDEX balance_transactions_tenant_id_created_at_idx ON balance_transactions (tenant_id, created_at);
CREATE INDEX balance_transactions_tenant_id_idx ON balance_transactions (tenant_id);
CREATE INDEX balance_transactions_tenant_id_type_created_at_idx ON balance_transactions (tenant_id, type, created_at);
CREATE INDEX balance_transactions_type_idx ON balance_transactions (type);
CREATE INDEX balance_transactions_user_id_idx ON balance_transactions (user_id);

CREATE UNIQUE INDEX balance_consumption_allocations_account_ledger_sequence_key ON balance_consumption_allocations (billing_account_id, ledger_sequence);
CREATE INDEX balance_allocations_account_funding_open_idx ON balance_consumption_allocations (billing_account_id, funding_classification_complete, settled_at, created_at) WHERE ((approved_credit_usd > (0)::numeric) OR (unapproved_debt_usd > (0)::numeric));
CREATE INDEX balance_consumption_allocations_account_source_created_idx ON balance_consumption_allocations (billing_account_id, source, created_at);
CREATE INDEX balance_consumption_allocations_balance_grant_id_idx ON balance_consumption_allocations (balance_grant_id);
CREATE INDEX balance_consumption_allocations_balance_transaction_id_idx ON balance_consumption_allocations (balance_transaction_id);
CREATE INDEX balance_consumption_allocations_billing_account_id_created_at_i ON balance_consumption_allocations (billing_account_id, created_at);
CREATE INDEX balance_consumption_allocations_billing_account_id_idx ON balance_consumption_allocations (billing_account_id);
CREATE INDEX balance_consumption_allocations_created_at_id_idx ON balance_consumption_allocations (created_at, id);
CREATE INDEX balance_consumption_allocations_credit_due_idx ON balance_consumption_allocations (billing_account_id, source, settled_at, credit_policy_snapshot_complete, credit_due_at);
CREATE INDEX balance_consumption_allocations_product_id_idx ON balance_consumption_allocations (product_id);
CREATE INDEX balance_consumption_allocations_source_idx ON balance_consumption_allocations (source);
CREATE INDEX balance_consumption_allocations_tenant_id_created_at_idx ON balance_consumption_allocations (tenant_id, created_at);
CREATE INDEX balance_consumption_allocations_tenant_id_idx ON balance_consumption_allocations (tenant_id);
CREATE INDEX balance_consumption_allocations_token_usage_id_idx ON balance_consumption_allocations (token_usage_id);
CREATE INDEX balance_consumption_allocations_user_id_idx ON balance_consumption_allocations (user_id);

UPDATE account_wallets w
SET balance_usd = t.balance_after_usd,
    updated_at = TIMESTAMP '2026-09-24 00:00:00'
FROM (
  SELECT DISTINCT ON (billing_account_id) billing_account_id, balance_after_usd
  FROM balance_transactions
  WHERE billing_account_id IN ('ba_v2_demo_001', 'ba_v2_demo_002', 'ba_v2_demo_003')
    AND id LIKE 'bt_l3_%'
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

SELECT
  (SELECT COUNT(*) FROM token_usage WHERE id LIKE 'tu_l3_%') AS token_usage_l3,
  (SELECT COUNT(*) FROM balance_transactions WHERE id LIKE 'bt_l3_%') AS consume_l3,
  (SELECT COUNT(*) FROM balance_consumption_allocations WHERE id LIKE 'al_l3_%') AS alloc_l3,
  pg_size_pretty(pg_database_size(current_database())) AS db_size;
