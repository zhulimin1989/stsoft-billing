-- Restore dropped allocations/indexes/triggers after the aborted 1M trim.
SET synchronous_commit = off;
SET work_mem = '256MB';
SET maintenance_work_mem = '1GB';
SET statement_timeout = 0;

ALTER TABLE token_usage DISABLE TRIGGER USER;
ALTER TABLE balance_transactions DISABLE TRIGGER USER;
ALTER TABLE balance_consumption_allocations DISABLE TRIGGER USER;
ALTER TABLE account_wallets DISABLE TRIGGER USER;

INSERT INTO balance_consumption_allocations (
  id, user_id, tenant_id, billing_account_id, product_id,
  balance_transaction_id, token_usage_id, balance_grant_id, source,
  amount_usd, recognized_revenue_usd, bonus_consumed_usd, discount_rate,
  settled_usd, ledger_sequence, created_at,
  approved_credit_usd, unapproved_debt_usd, funding_classification_complete,
  credit_policy_snapshot_complete
)
SELECT
  'al_l3_001_202609_' || lpad(g::text, 8, '0'),
  'user_v2_demo_001',
  'tenant_v2_demo_001',
  'ba_v2_demo_001',
  '2232ff07-1144-4038-b5cf-376915160e66',
  'bt_l3_001_202609_' || lpad(g::text, 8, '0'),
  'tu_l3_001_202609_' || lpad(g::text, 8, '0'),
  CASE WHEN g % 10 IN (7, 8) THEN 'e86ca25e-2283-43de-872d-42b159f98be1' ELSE NULL END,
  CASE WHEN g % 10 IN (7, 8) THEN 'BALANCE_GRANT' ELSE 'ENTERPRISE_CREDIT' END,
  0.001,
  CASE WHEN g % 10 = 9 THEN 0.0008 ELSE 0.001 END,
  CASE WHEN g % 10 = 9 THEN 0.0002 ELSE 0 END,
  1,
  0,
  29 + g,
  TIMESTAMP '2026-09-01 00:00:00' + ((g - 1) * INTERVAL '0.19872 second'),
  0, 0, false, false
FROM generate_series(1000001, 1600000) AS g;

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
CREATE INDEX IF NOT EXISTS token_usage_tenant_id_created_at_idx ON token_usage (tenant_id, created_at);

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

-- 001 钱包对齐最后一笔造数流水，否则恢复触发器后后续记账会尾差失败。
-- 002/003 没有造数，恢复到这次造数之前的余额。
UPDATE account_wallets SET balance_usd = -1550, updated_at = now() WHERE billing_account_id = 'ba_v2_demo_001';
UPDATE account_wallets SET balance_usd = -50, updated_at = now() WHERE billing_account_id = 'ba_v2_demo_002';
UPDATE account_wallets SET balance_usd = 48, updated_at = now() WHERE billing_account_id = 'ba_v2_demo_003';

ALTER TABLE token_usage ENABLE TRIGGER USER;
ALTER TABLE balance_transactions ENABLE TRIGGER USER;
ALTER TABLE balance_consumption_allocations ENABLE TRIGGER USER;
ALTER TABLE account_wallets ENABLE TRIGGER USER;

ANALYZE token_usage;
ANALYZE balance_transactions;
ANALYZE balance_consumption_allocations;

SELECT
  (SELECT COUNT(*) FROM token_usage WHERE id LIKE 'tu_l3_%') AS tu,
  (SELECT COUNT(*) FROM balance_transactions WHERE id LIKE 'bt_l3_%') AS bt,
  (SELECT COUNT(*) FROM balance_consumption_allocations WHERE id LIKE 'al_l3_%') AS al,
  (SELECT COUNT(*) FROM pg_indexes WHERE tablename IN ('token_usage','balance_transactions','balance_consumption_allocations')) AS index_count,
  pg_size_pretty(pg_database_size(current_database())) AS db_size;
SELECT billing_account_id, balance_usd FROM account_wallets
WHERE billing_account_id IN ('ba_v2_demo_001','ba_v2_demo_002','ba_v2_demo_003')
ORDER BY 1;
SELECT t.tgrelid::regclass, t.tgname, t.tgenabled
FROM pg_trigger t
WHERE t.tgrelid IN ('token_usage'::regclass,'balance_transactions'::regclass,'balance_consumption_allocations'::regclass,'account_wallets'::regclass)
  AND NOT t.tgisinternal
ORDER BY 1,2;
