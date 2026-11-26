# Production Migration: Gateway Usage Trace and AccountWallet Authority

Date: 2026-06-10

## Scope

This migration closes two accounting gaps from the audit:

- `token_usage` now links to `gateway_billing_events` through `gateway_billing_event_id`.
- `account_wallets` is the only authoritative balance table. Legacy `user_wallets` and `tenant_wallets` are migrated one final time and then dropped.

## Schema Changes

- Add nullable unique `token_usage.gateway_billing_event_id`.
- Backfill `token_usage.gateway_billing_event_id` by matching `token_usage.request_id = gateway_billing_events.request_id`.
- Add a foreign key from `token_usage.gateway_billing_event_id` to `gateway_billing_events.id`.
- Backfill missing `billing_accounts`, `billing_account_members`, tenant `billing_account_id`, and `account_wallets`.
- Drop legacy `tenant_wallets` and `user_wallets`.

## Production Notes

Data volume is small, so the included SQL migration is sufficient. Before deployment, confirm no manual process still writes `user_wallets` or `tenant_wallets`.

Recommended checks after migration:

```sql
SELECT COUNT(*) AS token_usage_without_gateway_event
FROM token_usage
WHERE request_id IS NOT NULL
  AND gateway_billing_event_id IS NULL;

SELECT COUNT(*) AS tenants_without_billing_account
FROM tenants
WHERE deleted_at IS NULL
  AND billing_account_id IS NULL;

SELECT COUNT(*) AS billing_accounts_without_wallet
FROM billing_accounts ba
LEFT JOIN account_wallets aw ON aw.billing_account_id = ba.id
WHERE ba.deleted_at IS NULL
  AND aw.billing_account_id IS NULL;
```

If the first query returns rows, they are historical usage rows without a matching gateway event. They can stay unlinked, but new gateway-settled usage should always link.

If either wallet query returns rows, create the missing billing account or account wallet before enabling API key balance publishing for those tenants.

The billing admin runtime also exposes a read-only reconciliation report:

```http
GET /internal/billing/admin/reconciliation/accounting?sampleLimit=20&toleranceUsd=0.000001
```

It reports:

- deducted gateway events without `token_usage`
- PAYG `token_usage` without balance ledger rows
- subscription-credit `token_usage` without credit ledger rows
- `account_wallets` whose balance differs from `balance_transactions`
