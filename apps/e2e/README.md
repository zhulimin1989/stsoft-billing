# @ruidong/e2e — Playwright end-to-end tests

## What it covers

Billing API journeys chosen for regression payback, not coverage:

1. **health.api.spec.ts** — `/api/health/live` and `/api/health/ready`. Guards
   the ALB/Docker healthcheck path — a broken response shape takes instances
   out of rotation in prod.
2. **payment-security.api.spec.ts** — verifies Stripe / WeChat / Alipay
   webhook endpoints reject unsigned or bogus payloads with 4xx. Money-path
   canary. Also confirms these endpoints are exempt from the global
   rate-limit introduced in T-5.1.
3. **disaster-replay.api.spec.ts** — repeats bogus provider callbacks to
   exercise webhook replay/degraded-path behavior. These canaries verify the
   endpoints keep rejecting fake payment notifications and do not get blocked
   by the global limiter during provider retry bursts.

Auth journey tests now live in `codesphere-user`, because user API owns
registration, login, session cookies, and user profile after the service split.

## Running locally

```bash
# 1. In one shell: start pg + redis + billing API (see root README)
pnpm dev
# ensure DATABASE_URL points at a throwaway DB — these tests write data

# 2. In another shell
pnpm --filter @ruidong/e2e install-browsers   # first time only
pnpm --filter @ruidong/e2e test               # runs billing API journeys
pnpm --filter @ruidong/e2e test:headed
pnpm --filter @ruidong/e2e report             # open the HTML report
```

Override base URLs via env:
- `E2E_API_URL` (default http://localhost:3010)
Set `E2E_API_URL` to the billing API base URL when it is not running on
`http://localhost:3010`.

## CI

Run this suite after pg + redis are up, billing migrations are applied, and
billing API is started in the background.

Failures upload `playwright-report/` + `test-results/` as artifacts with 14
day retention.

## Design notes

- **Serialized (`workers: 1`, `fullyParallel: false`)**: the tests write real
  rows into pg. Parallel runs would race. For larger E2E suites later,
  isolate by database schema per worker.
- **`x-e2e-test: 1` header**: allows future middleware to skip rate-limit,
  webhook signing, or outbound side effects for E2E traffic without polluting
  real-user logic. Not yet consumed by the API.
- **No Playwright `webServer` option**: the API boot is owned by CI (or
  `pnpm dev` locally), not Playwright. Mixing them makes flakiness harder
  to diagnose — separate concerns.
