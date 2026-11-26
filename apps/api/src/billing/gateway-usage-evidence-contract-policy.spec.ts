import {
  evaluateGatewayProviderEvidenceContract,
  parseGatewayEvidenceContractMode,
  parseVerifiedGatewayProducerBuilds,
} from './gateway-usage-evidence-contract-policy';

const buildSha = '0123456789abcdef0123456789abcdef01234567';
const usageHash = `sha256:${'a'.repeat(64)}`;

function completeAnthropicEvent(overrides: Record<string, unknown> = {}) {
  return {
    provider: 'zhipu',
    resolved_api_type: 'anthropic',
    producer_build_sha: buildSha,
    provider_usage_hash: usageHash,
    provider_account_ref: 'provider-account-1',
    provider_credential_ref: 'provider-account-1',
    upstream_request_id: 'upstream-request-1',
    stream_end_reason: 'normal_end',
    usage_evidence: {
      source: 'provider_terminal',
      status: 'complete',
      protocol: 'anthropic',
      terminal_frame_seen: true,
      dimensions_present: [
        'input_tokens',
        'output_tokens',
        'cache_read_input_tokens',
        'cache_creation_input_tokens',
      ],
    },
    ...overrides,
  };
}

describe('gateway provider evidence contract policy', () => {
  it('accepts a verified complete GLM Anthropic terminal contract', () => {
    const result = evaluateGatewayProviderEvidenceContract(
      completeAnthropicEvent(),
      new Set([buildSha]),
    );

    expect(result.issues).toEqual([]);
    expect(result.providerAccountRef).toBe('provider-account-1');
  });

  it('requires an allowlisted immutable producer build', () => {
    const missing = evaluateGatewayProviderEvidenceContract(
      completeAnthropicEvent({ producer_build_sha: undefined }),
      new Set([buildSha]),
    );
    const short = evaluateGatewayProviderEvidenceContract(
      completeAnthropicEvent({ producer_build_sha: '9c6118a' }),
      new Set([buildSha]),
    );
    const unknown = evaluateGatewayProviderEvidenceContract(
      completeAnthropicEvent(),
      new Set(),
    );

    expect(missing.issues).toContain('producer_build_sha_missing');
    expect(short.issues).toContain('producer_build_sha_invalid');
    expect(unknown.issues).toContain('producer_build_unverified');
  });

  it('requires a signed sha256 provider usage commitment', () => {
    const missing = evaluateGatewayProviderEvidenceContract(
      completeAnthropicEvent({ provider_usage_hash: undefined }),
      new Set([buildSha]),
    );
    const invalid = evaluateGatewayProviderEvidenceContract(
      completeAnthropicEvent({ provider_usage_hash: 'abc123' }),
      new Set([buildSha]),
    );

    expect(missing.issues).toContain('provider_usage_hash_missing');
    expect(invalid.issues).toContain('provider_usage_hash_invalid');
  });

  it('distinguishes an explicit zero-capable dimension set from omission', () => {
    const missing = completeAnthropicEvent({
      usage_evidence: {
        source: 'provider_terminal',
        status: 'complete',
        protocol: 'anthropic',
        terminal_frame_seen: true,
      },
    });
    const incomplete = completeAnthropicEvent({
      usage_evidence: {
        source: 'provider_terminal',
        status: 'complete',
        protocol: 'anthropic',
        terminal_frame_seen: true,
        dimensions_present: ['input_tokens', 'output_tokens'],
      },
    });

    expect(evaluateGatewayProviderEvidenceContract(missing, new Set([buildSha])).issues)
      .toContain('usage_dimensions_missing');
    expect(evaluateGatewayProviderEvidenceContract(incomplete, new Set([buildSha])).issues)
      .toEqual(expect.arrayContaining([
        'usage_dimension_cache_read_missing',
        'usage_dimension_cache_creation_missing',
      ]));
  });

  it('does not require cache dimensions for a generic non-Anthropic response', () => {
    const event = completeAnthropicEvent({
      provider: 'openai',
      resolved_api_type: 'openai',
      upstream_request_id: undefined,
      stream_end_reason: undefined,
      upstream_response_id: 'response-1',
      usage_evidence: {
        source: 'provider_response',
        status: 'complete',
        protocol: 'openai',
        terminal_frame_seen: false,
        dimensions_present: ['input_tokens', 'output_tokens'],
      },
    });

    expect(evaluateGatewayProviderEvidenceContract(event, new Set([buildSha])).issues)
      .toEqual([]);
  });

  it('requires a request-level correlation ID for GLM/Anthropic', () => {
    const result = evaluateGatewayProviderEvidenceContract(
      completeAnthropicEvent({
        upstream_request_id: undefined,
        upstream_response_id: 'msg-1',
      }),
      new Set([buildSha]),
    );

    expect(result.issues).toContain('upstream_request_id_missing');
  });

  it.each(['openai_sse', 'unrecognized_protocol'])(
    'does not let a mislabeled %s protocol downgrade a GLM Anthropic route',
    (protocol) => {
      const result = evaluateGatewayProviderEvidenceContract(
        completeAnthropicEvent({
          usage_evidence: {
            source: 'provider_terminal',
            status: 'complete',
            protocol,
            terminal_frame_seen: true,
            dimensions_present: ['input_tokens', 'output_tokens'],
          },
        }),
        new Set([buildSha]),
      );

      expect(result.issues).toEqual(expect.arrayContaining([
        'usage_dimension_cache_read_missing',
        'usage_dimension_cache_creation_missing',
      ]));
      expect(result.issues).toContain(
        protocol === 'openai_sse'
          ? 'usage_protocol_family_conflict'
          : 'usage_protocol_family_invalid',
      );
    },
  );

  it('requires provider identity even when the Anthropic route is otherwise complete', () => {
    const result = evaluateGatewayProviderEvidenceContract(
      completeAnthropicEvent({ provider: undefined }),
      new Set([buildSha]),
    );

    expect(result.issues).toContain('provider_missing');
    expect(result.issues).not.toContain('upstream_request_id_missing');
  });

  it('rejects contradictory provider and resolved protocol families', () => {
    const result = evaluateGatewayProviderEvidenceContract(
      completeAnthropicEvent({ provider: 'openai' }),
      new Set([buildSha]),
    );

    expect(result.issues).toContain('usage_protocol_family_conflict');
  });

  it('requires the resolved API type used for tariff dimension selection', () => {
    const result = evaluateGatewayProviderEvidenceContract(
      completeAnthropicEvent({ resolved_api_type: undefined }),
      new Set([buildSha]),
    );

    expect(result.issues).toContain('resolved_api_type_missing');
  });

  it('does not substitute a rotatable credential reference for provider account identity', () => {
    const result = evaluateGatewayProviderEvidenceContract(
      completeAnthropicEvent({ provider_account_ref: undefined }),
      new Set([buildSha]),
    );

    expect(result.issues).toContain('provider_account_ref_missing');
  });

  it('allows client disconnect only after complete provider terminal evidence', () => {
    const clientDisconnect = evaluateGatewayProviderEvidenceContract(
      completeAnthropicEvent({ stream_end_reason: 'client_disconnect' }),
      new Set([buildSha]),
    );
    const truncated = evaluateGatewayProviderEvidenceContract(
      completeAnthropicEvent({ stream_end_reason: 'truncated' }),
      new Set([buildSha]),
    );

    expect(clientDisconnect.issues).not.toContain('stream_end_reason_inconsistent');
    expect(truncated.issues).toContain('stream_end_reason_inconsistent');
  });

  it('normalizes deployment mode and producer allowlist configuration', () => {
    expect(parseGatewayEvidenceContractMode(' EnFoRcE ')).toBe('enforce');
    expect(parseGatewayEvidenceContractMode('disabled')).toBeNull();
    expect(parseVerifiedGatewayProducerBuilds(` ${buildSha},SHA256:${'B'.repeat(64)} `))
      .toEqual(new Set([buildSha, `sha256:${'b'.repeat(64)}`]));
  });
});
