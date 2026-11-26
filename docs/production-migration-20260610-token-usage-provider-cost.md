# Production Migration: TokenUsage Customer Charge and Provider Cost

Date: 2026-06-10

## Scope

Adds explicit accounting columns to `token_usage` so provider-resale CodingPlan usage can record customer charge separately from upstream provider cost.

## Schema Changes

- `token_usage.customer_charge_policy`
- `token_usage.customer_charge_usd`
- `token_usage.provider_cost_estimate_usd`
- `token_usage.coding_plan_entitlement_id`
- `token_usage.provider_entitlement_id`

Existing rows are initialized with `customer_charge_usd = cost_usd` and `customer_charge_policy = usage_charge`.

## Production Notes

Subscriptions and CodingPlan resale have not launched, so no historical resale backfill is required. After deployment, provider-resale rows should have:

- `cost_usd = 0`
- `customer_charge_policy = included_upstream`
- `customer_charge_usd = 0`
- `provider_cost_estimate_usd > 0` when pricing exists
- `coding_plan_entitlement_id` set to the customer entitlement
- `provider_entitlement_id` set when upstream fulfillment created a provider entitlement
