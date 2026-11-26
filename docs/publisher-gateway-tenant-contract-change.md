# Publisher / Gateway Tenant Contract Change

Date: 2026-05-24

## Background

User management is now tenant-scoped for multi-product operations:

```text
userId   = login identity / actor / creator / audit subject
tenantId = account / workspace / billing owner / product account owner
productAccount = tenantId + productId
```

The product has not launched, so there is no historical user-wallet compatibility layer. Publisher and Gateway should treat `tenant_id` as the real account id, not as a user id alias.

## Publisher Changes

Required contract:

- `scope_attrs.tenant_id` must be `ApiKey.tenantId`.
- `scope_attrs.user_id` remains `ApiKey.userId` and is audit-only.
- `scope_attrs.usr.product_id` remains `ApiKey.productId`.
- `scope_attrs.usr.product_slug` remains `Product.slug`.
- API Key metadata sync rejects any key without `tenantId`, including CodingPlan keys.
- CodingPlan keys additionally carry `scope_attrs.usr.coding_plan_entitlement_id`; that id selects the package entitlement, but does not replace `tenant_id`.
- Key balance sync reads `tenant_wallet.tenant_id` for balance products and CodingPlan entitlement credit state for CodingPlan products.

Publisher implementation impact:

- If Publisher stores `tenant_id` as an opaque scope attribute, no schema change is required.
- If Publisher policies, rate limits, partitions, or dashboards assume `tenant_id == userId`, update them to treat `tenant_id` as account/workspace id.
- Rebuild any policy cache keyed by old user-based `tenant_id` after billing replays API keys.

After deployment, run Publisher replay from Admin for:

- API Key metadata
- Key balance

## Gateway Changes

API-key traffic:

- Gateway must use Publisher `key_id` as billing `apiKeyId`.
- Gateway must not send raw key or key hash as `apiKeyId`.
- Gateway should propagate the account id from Publisher key metadata as `tenant_id` in UsageEvent v2 (`tenant_id` or `labels.tenant_id`) when available.
- Billing treats local `ApiKey.tenantId` as authoritative. If the Gateway event has a different `tenant_id`, billing still charges the bound tenant but records a mismatch reason for audit/metrics.
- If the local API Key has no `tenantId`, billing rejects usage. Gateway should not rely on event `tenant_id` to repair an unbound key.

Non-API-key internal usage events:

- `tenantId` is required for UsageEvent v2 billing when no `apiKeyId` exists.
- Billing validates that `tenantId` belongs to the resolved user; invalid membership is rejected.

## UsageEvent v2 Field Mapping

| Event field | Required meaning |
| --- | --- |
| `key_id` | Billing `ApiKey.id`; maps to `apiKeyId` |
| `tenant_id` / `labels.tenant_id` | Real `Tenant.id`; account/workspace id |
| `labels.user_id` | Actor or creator user id, audit only |
| `labels.product_id` / `labels.usr.product_id` | Product id |
| `labels.product_slug` / `labels.usr.product_slug` | Product slug |

## Rollout Checklist

- Billing DB migrations are applied before traffic.
- Publisher API key metadata replay succeeds.
- Publisher key-balance replay succeeds.
- Gateway emits UsageEvent v2 with `key_id` and tenant-scoped `tenant_id`.
- Gateway stops treating `tenant_id` as a user id in logs, policy scopes, dashboards, and partition keys.
- Monitor `gateway_tenant_api_key_mismatch` and `gateway_tenant_api_key_unbound_tenant_ignored` after rollout; both should stay at zero.
