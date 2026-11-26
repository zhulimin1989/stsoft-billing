# Billing Service Split

## Current Cut

Billing can now boot as a standalone Nest process from `src/billing-main.ts`.

Run locally:

```bash
pnpm dev:billing
```

Default local configuration:

```text
DATABASE_URL=postgresql://.../ruidong_console?schema=public
BILLING_DATABASE_URL=postgresql://.../ruidong_billing?schema=public
BILLING_SERVICE_URL=http://localhost:3010/api/internal/billing/admin
ADMIN_TO_BILLING_TOKEN=<admin-api-to-billing token>
ADMIN_TO_BILLING_CONTEXT_SECRET=<admin context signing secret>
USER_TO_BILLING_TOKEN=<user-api-to-billing token>
BILLING_TO_USER_TOKEN=<billing-api-to-user token>
BILLING_PORT=3010
```

Primary routes:

- `GET /api/health/live`
- `GET /api/health/ready`
- `GET /api/billing/plans`
- `GET /api/billing/products`
- `POST /api/payment/create`
- `POST /api/payment/notify/stripe`
- `POST /api/payment/notify/wechat`
- `GET /api/internal/billing/admin/orders`
- `GET /api/internal/billing/admin/revenue`
- `GET /api/internal/billing/admin/transactions`
- `GET /api/internal/billing/admin/subscriptions`
- `GET /api/internal/billing/admin/plans`
- `PUT /api/internal/billing/admin/plans/:id/prices/:currency`
- `GET /api/internal/billing/admin/bundles`
- `GET /api/internal/billing/admin/products`
- `GET /api/internal/billing/admin/booster-packs`
- `GET /api/internal/billing/admin/users/:id/balance`
- `GET /api/internal/billing/admin/users/:id/credit-overview`
- `POST /api/internal/billing/admin/users/:id/adjust-balance`
- `POST /api/internal/billing/admin/users/:id/grant-credits`
- `POST /api/internal/billing/admin/users/:id/ensure-default-free-plan`
- `GET /api/internal/billing/admin/payment-instances`

## Boundary

`BillingCoreModule` is provider-only. It owns billing behavior without pulling
unrelated admin controllers into the standalone runtime.

`PaymentRuntimeModule` exposes payment APIs inside the billing process and
depends on the narrow `ProductSyncNotifier` port. Billing runtime wires the
port to product-config sync jobs, keeping legacy SaaS synchronization out of
the billing hot path.

## Database Ownership

The API process uses `DATABASE_URL`. The billing process sets
`RUIDONG_SERVICE=billing`, so `PrismaService` connects to
`BILLING_DATABASE_URL`.

For the current transition, both databases use the same Prisma schema and
migration history. Billing owns the financial tables in its database:

- products, plans, plan prices, bundles, booster packs
- orders, order items, payment provider instances
- user subscriptions, wallets, balance transactions, credit transactions

Because the existing schema still has foreign keys to `users`, billing keeps a
minimal user mirror row in its own database. The source of truth for user
profile, identity, auth, roles, and admin status remains the user/auth service.
Admin and auth pass a user snapshot when they call billing internal APIs; public
billing requests create a stub mirror row from the verified JWT user id.

Run migrations separately:

```bash
pnpm db:migrate:deploy
pnpm db:migrate:billing
```

Local dev can start a second Postgres on port `5433` with:

```bash
pnpm docker:dev
```

## Next Step

Admin now calls the standalone service through `BillingInternalClient`, pointed at:

```text
BILLING_SERVICE_URL=http://localhost:3010/api/internal/billing/admin
```

The internal API is protected by caller-specific `x-internal-caller`,
`x-internal-token`, and `x-billing-api-version` headers. Admin calls use
`ADMIN_TO_BILLING_TOKEN` plus the signed admin context headers; user-api
facade calls use `USER_TO_BILLING_TOKEN` on their explicit route whitelist.

Remaining coupling to remove later:

- The Prisma schema is still shared. A later hard split should generate a
  dedicated billing Prisma schema/client after user, gateway, and billing
  ownership boundaries are stable.
