# Billing runtime boundaries

Date: 2026-06-11

## Ownership

`codesphere-billing` owns billing facts:

- products, plans, subscription contracts and periods
- Coding Plan entitlements
- wallets, balance grants, transactions, allocations
- token usage, gateway billing events, pricing and customer charge policy
- payment orders and provider runtime state
- upstream channel runtime configuration

`codesphere-billing` does not own identity authentication, admin authority, or
admin operation audit logs. `User` rows in billing are identity snapshots
mirrored from `codesphere-user`. They are not login records and must not contain
password, auth provider state, or identity-verification authority.

Admin-facing billing APIs are reached through `codesphere-admin`, which forwards
the resolved admin id and permission atoms over the internal billing client.
Billing treats those admin ids as opaque identifiers and does not query or cache
admin roles locally.

Ticket SLA notifications are billing business events and are written to
`alert_events`. Admin operation audit remains owned by `codesphere-admin`.
The legacy billing-side `admin_roles`, `admin_members`, and
`admin_activity_logs` tables were removed by
`20260611000200_drop_billing_admin_legacy_tables`.

## API Key and usage ledger

Gateway PAYG settlement records `TokenUsage` inside the same transaction that
creates the wallet `BalanceTransaction` and `BalanceConsumptionAllocation`.
For a billable gateway request, the following chain must be queryable:

- `GatewayBillingEvent.requestId`
- `TokenUsage.requestId`
- `TokenUsage.gatewayBillingEventId`
- `BalanceTransaction.tokenUsageId`
- `BalanceConsumptionAllocation.tokenUsageId`

Coding Plan usage must write `TokenUsage.codingPlanEntitlementId` for both
provider resale and platform model package fulfillment modes.

## Money policy

Payment-facing order amounts are integer cents. Usage rating and wallet ledger
entries use Decimal USD because token pricing can be smaller than one cent.

Rules:

- use Decimal arithmetic for usage cost and wallet ledger writes
- normalize ledger USD values to 12 decimal places
- use `ROUND_HALF_UP` when converting Decimal USD to cents for display or
  payment-facing summaries
- never use JavaScript floating point as an intermediate for persisted money
  values
- treat cents values as presentation/payment fields, not as the source of truth
  for token usage settlement
