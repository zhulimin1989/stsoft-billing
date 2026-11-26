# codesphere-billing

## Capability Axis Freeze

Batch 0 of `../ARCH-PASSTHROUGH-REDESIGN.md` freezes the capability/feature/param
axes. Do not add or reintroduce fields or enum values for:

- `supported_features`
- `supported_params`
- `capability_profiles`
- `capability_features`
- `capability_params`
- `capabilityOverrides`
- `request_param_policy`

New protocol conversion support must be represented by an upstream
protocol-to-protocol bridge/profile contract, not by adding another
capability/feature/param admission axis in billing schemas or channel
configuration. Intentional changes require architecture review and an updated
`ARCH-REVIEW-APPROVED ... sha256:<snapshot>` marker in
`scripts/capability-axis-freeze.baseline.json`.
