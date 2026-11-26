# Production Migration: CodingPlan Entitlement State Machine

Date: 2026-06-10

## Scope

This migration makes CodingPlan customer/provider entitlement states typed at the database level and enforces the customer entitlement to provider entitlement link.

## Schema Changes

- `coding_plan_entitlements.status` becomes enum `CodingPlanEntitlementStatus`.
- `coding_plan_entitlements.fulfillment_mode` becomes enum `CodingPlanFulfillmentMode`.
- `coding_plan_provider_entitlements.status` becomes enum `CodingPlanProviderEntitlementStatus`.
- `coding_plan_entitlements.provider_entitlement_id` now has a foreign key to `coding_plan_provider_entitlements.id`.

Before converting to enums, unknown status values are normalized to `FAILED`, and unknown fulfillment modes are normalized to `platform_model_package`. Before adding the FK, dangling provider entitlement ids are set to `NULL`.

## Production Notes

Subscriptions and CodingPlan are not live yet, so no user-facing migration is expected. After deployment, run:

```sql
SELECT status, COUNT(*)
FROM coding_plan_entitlements
GROUP BY status;

SELECT fulfillment_mode, COUNT(*)
FROM coding_plan_entitlements
GROUP BY fulfillment_mode;

SELECT COUNT(*) AS provider_resale_without_provider_link
FROM coding_plan_entitlements
WHERE fulfillment_mode = 'provider_resale'
  AND status = 'ACTIVE'
  AND provider_entitlement_id IS NULL;
```

The last query should be zero for activated provider-resale packages. Pending or failed provider-resale rows may legitimately have no provider link.
