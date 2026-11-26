export const GATEWAY_EVIDENCE_CONTRACT_MODES = ['shadow', 'enforce'] as const;

export type GatewayEvidenceContractMode =
  typeof GATEWAY_EVIDENCE_CONTRACT_MODES[number];

export type GatewayEvidenceContractIssueCode =
  | 'provider_missing'
  | 'resolved_api_type_missing'
  | 'resolved_api_type_invalid'
  | 'usage_protocol_family_invalid'
  | 'usage_protocol_family_conflict'
  | 'producer_build_sha_missing'
  | 'producer_build_sha_invalid'
  | 'producer_build_unverified'
  | 'provider_usage_hash_missing'
  | 'provider_usage_hash_invalid'
  | 'usage_dimensions_missing'
  | 'usage_dimensions_invalid'
  | 'usage_dimension_input_missing'
  | 'usage_dimension_output_missing'
  | 'usage_dimension_cache_read_missing'
  | 'usage_dimension_cache_creation_missing'
  | 'stream_end_reason_missing'
  | 'stream_end_reason_invalid'
  | 'stream_end_reason_inconsistent'
  | 'provider_account_ref_missing'
  | 'upstream_request_id_missing';

export type GatewayEvidenceContractEvaluation = {
  issues: GatewayEvidenceContractIssueCode[];
  producerBuildSha: string | null;
  providerUsageHash: string | null;
  providerAccountRef: string | null;
  dimensionsPresent: string[];
  streamEndReason: string | null;
};

type JsonObject = Record<string, unknown>;

const IMMUTABLE_BUILD_SHA = /^(?:[0-9a-f]{40}|sha256:[0-9a-f]{64})$/;
const PROVIDER_USAGE_SHA256 = /^sha256:[0-9a-f]{64}$/;
const KNOWN_STREAM_END_REASONS = new Set([
  'normal_end',
  'provider_error',
  'transform_error',
  'client_disconnect',
  'usage_fallback',
  'truncated',
  'first_token_timeout',
]);
// A complete provider terminal can still precede a client-side disconnect.
// The remaining reasons describe an incomplete provider stream or a response
// that the Gateway could not deliver as a valid customer response, so they do
// not authorize an automatic customer settlement.
const SETTLEABLE_PROVIDER_TERMINAL_END_REASONS = new Set([
  'normal_end',
  'client_disconnect',
]);
const STRICT_UPSTREAM_REQUEST_PROVIDERS = new Set([
  'anthropic',
  'bigmodel',
  'glm',
  'zhipu',
  'zhipuai',
]);

type ApiProtocolFamily = 'anthropic' | 'openai';

export function parseGatewayEvidenceContractMode(
  value: unknown,
): GatewayEvidenceContractMode | null {
  const normalized = stringValue(value)?.toLowerCase();
  return normalized && (GATEWAY_EVIDENCE_CONTRACT_MODES as readonly string[])
    .includes(normalized)
    ? normalized as GatewayEvidenceContractMode
    : null;
}

export function parseVerifiedGatewayProducerBuilds(value: unknown): Set<string> {
  if (typeof value !== 'string') return new Set();
  return new Set(
    value
      .split(',')
      .map((item) => item.trim().toLowerCase())
      .filter(Boolean),
  );
}

/**
 * Evaluate the additive UsageEvent evidence contract used during the
 * Gateway/Billing rollout. HMAC authenticates the Kafka body; this policy
 * separately proves that the producer build was validated and that the
 * provider dimensions needed by the frozen tariff were explicitly present.
 *
 * Callers decide whether issues are shadow-only or fail-closed. Keeping the
 * evaluator pure makes the same contract usable by ingestion, metrics and
 * deployment preflight without silently changing historical evidence.
 */
export function evaluateGatewayProviderEvidenceContract(
  event: JsonObject,
  verifiedProducerBuilds: ReadonlySet<string>,
): GatewayEvidenceContractEvaluation {
  const issues: GatewayEvidenceContractIssueCode[] = [];
  const usageEvidence = objectValue(event.usage_evidence);
  const source = stringValue(usageEvidence.source)?.toLowerCase() ?? '';
  const protocol = stringValue(usageEvidence.protocol)?.toLowerCase() ?? '';
  const provider = stringValue(event.provider)?.toLowerCase() ?? '';
  const resolvedApiType = stringValue(event.resolved_api_type)?.toLowerCase() ?? '';
  const providerProtocolFamily = protocolFamily(provider);
  const resolvedApiProtocolFamily = protocolFamily(resolvedApiType);
  const evidenceProtocolFamily = protocolFamily(protocol);

  if (!provider) {
    issues.push('provider_missing');
  }
  if (!resolvedApiType) {
    issues.push('resolved_api_type_missing');
  } else if (!resolvedApiProtocolFamily) {
    issues.push('resolved_api_type_invalid');
  }
  if (protocol && !evidenceProtocolFamily) {
    issues.push('usage_protocol_family_invalid');
  }

  const declaredProtocolFamilies = [
    providerProtocolFamily,
    resolvedApiProtocolFamily,
    evidenceProtocolFamily,
  ].filter((family): family is ApiProtocolFamily => family !== null);
  if (new Set(declaredProtocolFamilies).size > 1) {
    issues.push('usage_protocol_family_conflict');
  }

  // resolved_api_type is the Gateway's actual upstream route. A mislabeled
  // evidence protocol must never downgrade a GLM Anthropic request to the
  // two-dimension OpenAI contract that caused the original cache undercount.
  // Provider is also considered when it names a protocol-native provider;
  // Zhipu/GLM vendor names stay protocol-neutral and are resolved by the
  // route/protocol fields below.
  const requiresAnthropicDimensions = declaredProtocolFamilies.includes('anthropic');

  const producerBuildSha = stringValue(event.producer_build_sha)?.toLowerCase() ?? null;
  if (!producerBuildSha) {
    issues.push('producer_build_sha_missing');
  } else if (!IMMUTABLE_BUILD_SHA.test(producerBuildSha)) {
    issues.push('producer_build_sha_invalid');
  } else if (!verifiedProducerBuilds.has(producerBuildSha)) {
    issues.push('producer_build_unverified');
  }

  const providerUsageHash = stringValue(event.provider_usage_hash)?.toLowerCase() ?? null;
  if (!providerUsageHash) {
    issues.push('provider_usage_hash_missing');
  } else if (!PROVIDER_USAGE_SHA256.test(providerUsageHash)) {
    issues.push('provider_usage_hash_invalid');
  }

  const rawDimensions = usageEvidence.dimensions_present
    ?? event.usage_dimensions_present;
  const dimensionsPresent = normalizedDimensions(rawDimensions);
  if (rawDimensions === undefined || rawDimensions === null) {
    issues.push('usage_dimensions_missing');
  } else if (dimensionsPresent === null) {
    issues.push('usage_dimensions_invalid');
  }
  const dimensions = new Set(dimensionsPresent ?? []);
  if (dimensionsPresent !== null) {
    if (!dimensions.has('input_tokens')) {
      issues.push('usage_dimension_input_missing');
    }
    if (!dimensions.has('output_tokens')) {
      issues.push('usage_dimension_output_missing');
    }
    if (requiresAnthropicDimensions) {
      if (!dimensions.has('cache_read_input_tokens')) {
        issues.push('usage_dimension_cache_read_missing');
      }
      if (!dimensions.has('cache_creation_input_tokens')) {
        issues.push('usage_dimension_cache_creation_missing');
      }
    }
  }

  const streamEndReason = stringValue(event.stream_end_reason)?.toLowerCase() ?? null;
  if (source === 'provider_terminal') {
    if (!streamEndReason) {
      issues.push('stream_end_reason_missing');
    } else if (!KNOWN_STREAM_END_REASONS.has(streamEndReason)) {
      issues.push('stream_end_reason_invalid');
    } else if (!SETTLEABLE_PROVIDER_TERMINAL_END_REASONS.has(streamEndReason)) {
      issues.push('stream_end_reason_inconsistent');
    }
  }

  // This is an additive contract field, not an alias for the legacy
  // provider_credential_ref. A credential can rotate or be shared; Billing
  // needs the stable provider-account identity emitted by the verified build.
  const providerAccountRef = stringValue(event.provider_account_ref);
  if (!providerAccountRef) {
    issues.push('provider_account_ref_missing');
  }

  if (
    requiresStrictUpstreamRequestId(
      provider,
      requiresAnthropicDimensions,
    )
    && !stringValue(event.upstream_request_id)
  ) {
    issues.push('upstream_request_id_missing');
  }

  return {
    issues,
    producerBuildSha,
    providerUsageHash,
    providerAccountRef,
    dimensionsPresent: dimensionsPresent ?? [],
    streamEndReason,
  };
}

function protocolFamily(value: string): ApiProtocolFamily | null {
  if (value === 'anthropic' || value.startsWith('anthropic_')) {
    return 'anthropic';
  }
  if (value === 'openai' || value.startsWith('openai_')) {
    return 'openai';
  }
  return null;
}

function requiresStrictUpstreamRequestId(
  provider: string,
  requiresAnthropicDimensions: boolean,
): boolean {
  return STRICT_UPSTREAM_REQUEST_PROVIDERS.has(provider)
    || requiresAnthropicDimensions;
}

function normalizedDimensions(value: unknown): string[] | null {
  if (!Array.isArray(value)) return null;
  const normalized = value.map((item) => stringValue(item)?.toLowerCase() ?? '');
  if (
    normalized.some((item) => !item)
    || new Set(normalized).size !== normalized.length
  ) {
    return null;
  }
  return [...normalized].sort();
}

function objectValue(value: unknown): JsonObject {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as JsonObject
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}
