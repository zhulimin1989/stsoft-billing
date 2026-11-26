# 2026-06-10 Subscription Contract/Period/Entitlement Migration

Scope: `codesphere-billing` production database.

This migration introduces the long-term subscription model:

- `subscription_contracts`: customer/product relationship.
- `subscription_periods`: billable subscription periods.
- `subscription_entitlements`: runtime access granted by a period.

`user_subscriptions` remains in the schema only as a legacy compile-time table.
New activation, resolution, cancellation, and expiry paths use the new tables.

## Production Assumption

Subscription has not launched in production, so this migration intentionally does
not backfill `user_subscriptions`.

If a non-production or pilot database contains test subscriptions, either delete
them or recreate them through the new activation flow after deployment.

## Deploy Steps

1. Deploy billing code with `SubscriptionLifecycleService`.
2. Run Prisma migrations:

   ```bash
   pnpm --filter @ruidong/api prisma:migrate:billing
   ```

3. Verify new tables exist:

   ```sql
   select to_regclass('subscription_contracts');
   select to_regclass('subscription_periods');
   select to_regclass('subscription_entitlements');
   ```

4. Verify no legacy production data needs migration:

   ```sql
   select count(*) from user_subscriptions;
   ```

5. Smoke test a new subscription activation and confirm one active row exists in
   each new table for the tenant/product pair.

## Rollback Note

No production subscription history is expected. If rollback is needed before any
real subscription traffic, drop the three new tables and redeploy the previous
billing build.
