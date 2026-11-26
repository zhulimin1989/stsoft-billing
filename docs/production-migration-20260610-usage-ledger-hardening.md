# 2026-06-10 Usage Ledger Hardening Migration

Scope: `codesphere-billing` production database (`ruidong_billing`).

This release adds `token_usage.request_id` and a unique index so one gateway
`request_id` can only create one usage detail row. It also disables production
PAYG fallback and negative gateway settlement by default. It also makes the
billing API Key mirror lifecycle explicit through `api_keys.mirror_status`.

## Before deploy

1. Confirm production env keeps the new strict defaults:

```env
BILLING_ALLOW_DEFAULT_PAYG_FALLBACK=false
BILLING_GATEWAY_USAGE_ALLOW_NEGATIVE_BALANCE=false
PUBLISHER_KEY_BALANCE_BOOTSTRAP_ON_START=false
```

2. Check whether existing `gateway_billing_events.billing_result` can backfill
`token_usage.request_id` without duplicate conflicts:

```sql
WITH backfill AS (
  SELECT
    gbe.request_id,
    gbe.billing_result->>'tokenUsageId' AS token_usage_id
  FROM gateway_billing_events gbe
  WHERE gbe.billing_result ? 'tokenUsageId'
)
SELECT request_id, COUNT(*)
FROM backfill
WHERE request_id IS NOT NULL
GROUP BY request_id
HAVING COUNT(*) > 1;
```

If rows are returned, inspect them manually before applying the migration. With
the current low production volume, the safest fix is to keep only the canonical
successful settlement for each request and leave the others unlinked.

3. Optional visibility check for API keys that would fail strict product binding:

```sql
SELECT id, user_id, tenant_id, product_id, created_at
FROM api_keys
WHERE deleted_at IS NULL
  AND is_active = true
  AND product_id IS NULL;
```

Bind these keys to the intended product before turning Kafka usage ingestion on.

4. If Publisher credentials are configured and you want billing to refill
`gw:key_balance` for all active keys after this deploy, set:

```env
PUBLISHER_KEY_BALANCE_BOOTSTRAP_ON_START=true
PUBLISHER_SYNC_WORKER_ENABLED=true
```

Leave the bootstrap disabled until `PUBLISHER_BASE_URL` and the billing token
are confirmed.

5. Check current API Key mirror states before the lifecycle backfill:

```sql
SELECT
  CASE
    WHEN deleted_at IS NOT NULL THEN 'REVOKED'
    WHEN is_active = true THEN 'ACTIVE'
    ELSE 'SUSPENDED'
  END AS expected_mirror_status,
  COUNT(*)
FROM api_keys
GROUP BY expected_mirror_status
ORDER BY expected_mirror_status;
```

## Deploy

Run the billing migration:

```bash
pnpm --filter @ruidong/api prisma:migrate:prod
```

The migration performs:

```sql
ALTER TABLE token_usage ADD COLUMN IF NOT EXISTS request_id TEXT;
UPDATE token_usage ... FROM gateway_billing_events ...;
CREATE UNIQUE INDEX IF NOT EXISTS token_usage_request_id_key ON token_usage(request_id);
ALTER TABLE api_keys ADD COLUMN IF NOT EXISTS mirror_status TEXT DEFAULT 'PROVISIONING';
UPDATE api_keys SET mirror_status = ... FROM is_active/deleted_at;
```

Existing historical `token_usage` rows that cannot be matched to a gateway
event remain `NULL`. PostgreSQL allows multiple `NULL` values in the unique
index, so old rows do not block deploy.

## After deploy

Verify new writes include request IDs:

```sql
SELECT request_id, api_key_id, tenant_id, product_id, created_at
FROM token_usage
WHERE created_at >= now() - interval '1 hour'
ORDER BY created_at DESC
LIMIT 20;
```

Verify no request creates duplicate usage rows:

```sql
SELECT request_id, COUNT(*)
FROM token_usage
WHERE request_id IS NOT NULL
GROUP BY request_id
HAVING COUNT(*) > 1;
```

Verify API Key mirrors were backfilled:

```sql
SELECT mirror_status, COUNT(*)
FROM api_keys
GROUP BY mirror_status
ORDER BY mirror_status;
```

New user-api keys should appear in billing as `ACTIVE` only after the user
provisioning outbox calls `PUT /api-keys/:id/mirror`. Billing rejects usage for
keys whose `mirror_status` is not `ACTIVE`, and publisher key_balance replay only
includes active mirrors.

## Manual backfill for unmatched historical rows

If you can identify historical rows from logs, update them one by one:

```sql
UPDATE token_usage
SET request_id = '<gateway-request-id>'
WHERE id = '<token-usage-id>'
  AND request_id IS NULL;
```

Do not invent request IDs. Rows without reliable gateway evidence should stay
`NULL`.
