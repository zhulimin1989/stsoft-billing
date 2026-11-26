-- Finish the 3-enterprise load at 1 million details each (2026-09).
-- Assumes secondary indexes are already dropped and USER triggers disabled.
SET synchronous_commit = off;
SET work_mem = '256MB';
SET maintenance_work_mem = '1GB';
SET statement_timeout = 0;

ALTER TABLE token_usage DISABLE TRIGGER USER;
ALTER TABLE balance_transactions DISABLE TRIGGER USER;
ALTER TABLE balance_consumption_allocations DISABLE TRIGGER USER;
ALTER TABLE account_wallets DISABLE TRIGGER USER;

DELETE FROM balance_consumption_allocations
WHERE id LIKE 'al_l3_001_202609_%' AND id > 'al_l3_001_202609_01000000';
DELETE FROM balance_transactions
WHERE id LIKE 'bt_l3_001_202609_%' AND id > 'bt_l3_001_202609_01000000';
DELETE FROM token_usage
WHERE id LIKE 'tu_l3_001_202609_%' AND id > 'tu_l3_001_202609_01000000';

SELECT balance_usd AS wallet FROM account_wallets WHERE billing_account_id = 'ba_v2_demo_002' \gset a002_
SELECT balance_usd AS wallet FROM account_wallets WHERE billing_account_id = 'ba_v2_demo_003' \gset a003_

\echo load 002/003 at 1 million
CALL loadtest_l3_month('002', 'ba_v2_demo_002', 'tenant_v2_demo_002', 'user_v2_demo_002', 'ak_v2_demo_002', NULL, :'a002_wallet'::numeric, 1000000, 200000);
CALL loadtest_l3_month('003', 'ba_v2_demo_003', 'tenant_v2_demo_003', 'user_v2_demo_003', 'ak_v2_demo_003', '35a9693f-fb7c-4e86-be0c-d3d35ced7b8d', :'a003_wallet'::numeric, 1000000, 200000);

CREATE UNIQUE INDEX IF NOT EXISTS token_usage_request_id_key ON token_usage (request_id);
CREATE UNIQUE INDEX IF NOT EXISTS token_usage_gateway_billing_event_id_key ON token_usage (gateway_billing_event_id);
CREATE INDEX IF NOT EXISTS token_usage_api_key_id_idx ON token_usage (api_key_id);
CREATE INDEX IF NOT EXISTS token_usage_coding_plan_entitlement_id_idx ON token_usage (coding_plan_entitlement_id);
CREATE INDEX IF NOT EXISTS token_usage_created_at_id_idx ON token_usage (created_at, id);
CREATE INDEX IF NOT EXISTS token_usage_funding_classification_created_idx ON token_usage (customer_funding_classification_complete, created_at);
CREATE INDEX IF NOT EXISTS token_usage_model_idx ON token_usage (model);
CREATE INDEX IF NOT EXISTS token_usage_product_id_idx ON token_usage (product_id);
CREATE INDEX IF NOT EXISTS token_usage_provider_code_idx ON token_usage (provider_code);
CREATE INDEX IF NOT EXISTS token_usage_provider_cost_policy_idx ON token_usage (provider_cost_policy_id);
CREATE INDEX IF NOT EXISTS token_usage_provider_entitlement_id_idx ON token_usage (provider_entitlement_id);
CREATE INDEX IF NOT EXISTS token_usage_provider_line_code_idx ON token_usage (provider_line_code);
CREATE INDEX IF NOT EXISTS token_usage_provider_line_id_idx ON token_usage (provider_line_id);
CREATE INDEX IF NOT EXISTS token_usage_tenant_id_idx ON token_usage (tenant_id);

CREATE UNIQUE INDEX IF NOT EXISTS balance_transactions_account_ledger_sequence_key ON balance_transactions (billing_account_id, ledger_sequence);
CREATE UNIQUE INDEX IF NOT EXISTS balance_transactions_operation_key_key ON balance_transactions (operation_key);
CREATE UNIQUE INDEX IF NOT EXISTS balance_transactions_token_usage_id_key ON balance_transactions (token_usage_id);
CREATE INDEX IF NOT EXISTS balance_transactions_account_online_created_idx ON balance_transactions (billing_account_id, created_at DESC) WHERE (ledger_sequence > 0);
CREATE INDEX IF NOT EXISTS balance_transactions_billing_account_id_created_at_idx ON balance_transactions (billing_account_id, created_at);
CREATE INDEX IF NOT EXISTS balance_transactions_billing_account_id_idx ON balance_transactions (billing_account_id);
CREATE INDEX IF NOT EXISTS balance_transactions_billing_account_id_type_created_at_idx ON balance_transactions (billing_account_id, type, created_at);
CREATE INDEX IF NOT EXISTS balance_transactions_created_at_id_idx ON balance_transactions (created_at, id);
CREATE INDEX IF NOT EXISTS balance_transactions_product_id_idx ON balance_transactions (product_id);
CREATE INDEX IF NOT EXISTS balance_transactions_tenant_id_created_at_idx ON balance_transactions (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS balance_transactions_tenant_id_idx ON balance_transactions (tenant_id);
CREATE INDEX IF NOT EXISTS balance_transactions_tenant_id_type_created_at_idx ON balance_transactions (tenant_id, type, created_at);
CREATE INDEX IF NOT EXISTS balance_transactions_type_idx ON balance_transactions (type);
CREATE INDEX IF NOT EXISTS balance_transactions_user_id_idx ON balance_transactions (user_id);

CREATE UNIQUE INDEX IF NOT EXISTS balance_consumption_allocations_account_ledger_sequence_key ON balance_consumption_allocations (billing_account_id, ledger_sequence);
CREATE INDEX IF NOT EXISTS balance_allocations_account_funding_open_idx ON balance_consumption_allocations (billing_account_id, funding_classification_complete, settled_at, created_at) WHERE ((approved_credit_usd > (0)::numeric) OR (unapproved_debt_usd > (0)::numeric));
CREATE INDEX IF NOT EXISTS balance_consumption_allocations_account_source_created_idx ON balance_consumption_allocations (billing_account_id, source, created_at);
CREATE INDEX IF NOT EXISTS balance_consumption_allocations_balance_grant_id_idx ON balance_consumption_allocations (balance_grant_id);
CREATE INDEX IF NOT EXISTS balance_consumption_allocations_balance_transaction_id_idx ON balance_consumption_allocations (balance_transaction_id);
CREATE INDEX IF NOT EXISTS balance_consumption_allocations_billing_account_id_created_at_i ON balance_consumption_allocations (billing_account_id, created_at);
CREATE INDEX IF NOT EXISTS balance_consumption_allocations_billing_account_id_idx ON balance_consumption_allocations (billing_account_id);
CREATE INDEX IF NOT EXISTS balance_consumption_allocations_created_at_id_idx ON balance_consumption_allocations (created_at, id);
CREATE INDEX IF NOT EXISTS balance_consumption_allocations_credit_due_idx ON balance_consumption_allocations (billing_account_id, source, settled_at, credit_policy_snapshot_complete, credit_due_at);
CREATE INDEX IF NOT EXISTS balance_consumption_allocations_product_id_idx ON balance_consumption_allocations (product_id);
CREATE INDEX IF NOT EXISTS balance_consumption_allocations_source_idx ON balance_consumption_allocations (source);
CREATE INDEX IF NOT EXISTS balance_consumption_allocations_tenant_id_created_at_idx ON balance_consumption_allocations (tenant_id, created_at);
CREATE INDEX IF NOT EXISTS balance_consumption_allocations_tenant_id_idx ON balance_consumption_allocations (tenant_id);
CREATE INDEX IF NOT EXISTS balance_consumption_allocations_token_usage_id_idx ON balance_consumption_allocations (token_usage_id);
CREATE INDEX IF NOT EXISTS balance_consumption_allocations_user_id_idx ON balance_consumption_allocations (user_id);

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

SELECT substring(id, 1, 10) AS tag, COUNT(*) AS token_usage
FROM token_usage WHERE id LIKE 'tu_l3_%' GROUP BY 1 ORDER BY 1;
SELECT
  (SELECT COUNT(*) FROM token_usage WHERE id LIKE 'tu_l3_%') AS token_usage_l3,
  (SELECT COUNT(*) FROM balance_transactions WHERE id LIKE 'bt_l3_%') AS consume_l3,
  (SELECT COUNT(*) FROM balance_consumption_allocations WHERE id LIKE 'al_l3_%') AS alloc_l3,
  pg_size_pretty(pg_database_size(current_database())) AS db_size;
