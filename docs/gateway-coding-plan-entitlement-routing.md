# Gateway CodingPlan Entitlement Routing Contract

## Scope

Billing and user portal now model CodingPlan purchases as order-level entitlement instances. A user can buy multiple CodingPlan packages under the same product, and each Raytone API Key can be bound to one entitlement through `codingPlanEntitlementId`.

Gateway should not collapse CodingPlan runtime behavior to `tenantId + productId` alone. CodingPlan is account-scoped by `tenant_id`, and each purchased package is further identified by `usr.coding_plan_entitlement_id`. For CodingPlan, `tenant_id` is the owning account (personal tenant today, team tenant later) and `usr.coding_plan_entitlement_id` is the runtime quota and routing scope.

## API Key Metadata

Billing publisher sends these key `scope_attrs`:

- `tenant_id`: owning account / tenant scope. Required for PAYG, subscription, and CodingPlan keys.
- `user_id`: Raytone user id.
- `usr.product_id`: Raytone product id.
- `usr.product_slug`: Raytone product slug.
- `usr.coding_plan_entitlement_id`: CodingPlan entitlement instance id.
- `usr.entitlement_id`: alias of `usr.coding_plan_entitlement_id` for runtime consumers.

Gateway must preserve `usr.coding_plan_entitlement_id` in request context, logs, metering, and routing decisions.

## Product Runtime Policy

Product runtime policy continues to be published per product:

- `credential_source = platform_pool`: gateway should use normal Raytone channel/key-pool routing.
- `credential_source = provider_entitlement`: gateway should use the API Key entitlement id to resolve the upstream vendor credential.
- `model_scope_mode = upstream_inherited`: gateway should not require Raytone local model allowlist for this product.
- `billing_mode = included_upstream`: upstream package owns quota; Raytone billing authorizes by active entitlement and records usage without deducting local credits.
- `billing_mode = token_plan_quota` or `subscription_credits`: Raytone billing deducts local entitlement credits.

## Usage Billing

Gateway should call billing usage APIs with `apiKeyId` for both authorize and deduct. Billing resolves the tenant, product, and entitlement from the mirrored API Key. For CodingPlan keys, gateway must preserve both `tenant_id` and `usr.coding_plan_entitlement_id`; the entitlement id selects the package instance, while tenant id remains the account owner.

Expected behavior:

- Self-operated CodingPlan: billing resolves `coding_plan_entitlements.id` as the credit pool and deducts credits from that entitlement.
- Provider resale CodingPlan: billing returns allowed with `upstreamIncluded: true`; gateway should proceed and treat upstream quota as the funding source.
- PAYG: unchanged, workspace balance is still the funding source.

## Provider Entitlement Credential Requirement

For provider resale products, billing stores the upstream API key in `coding_plan_provider_entitlements.upstream_api_key_encrypted`, linked from `coding_plan_entitlements.provider_entitlement_id`.

Gateway still needs a runtime-safe way to resolve that credential by entitlement id before it can call the upstream vendor directly. Recommended contract:

- Input: `codingPlanEntitlementId`, `productId`, `tenantId`.
- Output: provider id/profile, upstream base URL or channel binding, decrypted upstream credential as gateway-local ciphertext, upstream product id, expiry/status.
- Access: internal service role only; never expose to user/browser.
- Cache: short TTL; invalidate on entitlement status, expiry, or provider credential rotation.

Until this credential lookup is implemented, provider-resale routing can be configured and purchased, but gateway cannot complete the final upstream call using the user's dedicated upstream package key.
