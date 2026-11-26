# Production Migration: Subscription Active History

Date: 2026-06-10

## Scope

This migration changes `user_subscriptions` from a single mutable current-row
model into a historical period table:

- Adds `ended_at` and `termination_reason`.
- Drops the old ordinary unique constraint on `(tenant_id, product_id)`.
- Adds a Postgres partial unique index that allows only one `ACTIVE`
  subscription per `(tenant_id, product_id)`.
- Allows `EXPIRED` and `CANCELLED` rows to remain as historical periods.

## Deployment Order

1. Deploy the billing code that creates a new active subscription period instead
   of mutating the previous row in place.
2. Run billing migrations:

   ```bash
   pnpm db:migrate:prod
   ```

3. Confirm active uniqueness:

   ```sql
   select tenant_id, product_id, count(*) as active_count
   from user_subscriptions
   where status = 'ACTIVE'
   group by tenant_id, product_id
   having count(*) > 1;
   ```

   Expected result: no rows.

4. Confirm historical rows can now coexist:

   ```sql
   select tenant_id, product_id, status, count(*)
   from user_subscriptions
   group by tenant_id, product_id, status
   order by tenant_id, product_id, status;
   ```

## Manual Data Notes

The migration pre-deduplicates any accidental duplicate active rows by keeping
the most recent `started_at` / `created_at` row active and marking older active
rows as `EXPIRED` with `termination_reason =
'deduplicated_before_active_unique_index'`.

Current readers select the latest active row with `started_at desc, created_at
desc`; historical rows remain available for reporting and future subscription
contract/period extraction.
