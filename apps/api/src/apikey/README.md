# Legacy API Key Module

This directory is retained only for historical compatibility with the old
`/api/apikeys` billing-plane API.

The current billing service starts from `billing-main.ts` and mounts
`BillingRuntimeModule`. That runtime module does not import `ApiKeyModule`, so
these controllers and providers are not registered in the deployed billing API.

Current production API key flows live in `codesphere-user`:

- API Platform keys: `/api-platform/api-keys`
- TokenPlan/CodingPlan keys: `/token-plan/.../api-keys`

Do not add new behavior or tests here. If this module is ever re-mounted, its
tenant/user-level key limits must be re-audited against the product and
entitlement-scoped limits used by `codesphere-user`.
