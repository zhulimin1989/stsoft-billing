# codesphere-billing

Standalone billing repository.

This repo owns:
- `apps/api`: billing runtime, started with `node dist/billing-main.js`.
- `packages/shared`: local shared contracts used by the API.

Runtime boundary:
- Billing owns balance, credits, subscriptions, orders, payment provider instances, usage strategy and gateway usage settlement.
- Billing stores user/tenant identity as billing snapshots only; billing-runtime mirror paths must not write user passwords or auth roles.
- Billing owns only `BILLING_DATABASE_URL` / `ruidong_billing`.
- Production runtime must not fall back to `DATABASE_URL`.
- User/admin services call billing through internal HTTP APIs.
- Gateway production billable usage events must go to Kafka `gateway.usage_events` as `UsageEvent` v2; HTTP usage fallback is not supported.
- Production usage settlement must keep `BILLING_ALLOW_DEFAULT_PAYG_FALLBACK=false` and `BILLING_GATEWAY_USAGE_ALLOW_NEGATIVE_BALANCE=false`. Gateway ingestion must never use a deployment switch as extra customer credit: an enterprise account may spend only within its active credit line and payment terms, while an enterprise account without active credit follows prepaid personal-account behavior (recharged balance only, without inheriting a member's personal overdraft policy).
- `user_subscriptions` is a historical period table; only `ACTIVE` rows are unique per tenant/product via a partial index.
- Production env contract: `.env.production.example`.
- Production DB migration entry: `pnpm db:migrate:prod`.
- The additive usage-evidence release requires a drained, single-immutable-SHA
  Billing deployment and a 100% shadow phase before enforcement; follow
  `docs/billing-gateway-usage-api.md` section 5.2. Do not rolling-canary mixed
  Billing binaries across its schema migration. Gateway may canary separately.
- Cross-service ownership contract: `../codesphere-ops/docs/architecture/service-db-ownership.md`.

Capability axis freeze:
- Batch 0 of `../ARCH-PASSTHROUGH-REDESIGN.md` forbids adding or reintroducing
  `supported_features`, `supported_params`, `capability_profiles`,
  `capability_features`, `capability_params`, `capabilityOverrides`, or
  `request_param_policy` field/value axes.
- New protocol conversion support must be a whole protocol-to-protocol
  bridge/profile, not another capability/feature/param admission axis in
  billing schema or channel config.
- The executable baseline is `scripts/capability-axis-freeze.baseline.json`;
  intentional updates require architecture review plus an updated
  `ARCH-REVIEW-APPROVED ... sha256:<snapshot>` marker.

Common commands:

```bash
pnpm install
pnpm build
pnpm start
pnpm db:migrate:prod
```

Docker:

```bash
docker build -t codesphere-billing .
```
