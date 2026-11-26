import {
  parseModelConfigs,
  toDownstreamModelDict,
  validateModelConfigs,
} from './model-configs';

describe('model-configs', () => {
  it('keeps per-model routing priority and drops default values', () => {
    const normalized = validateModelConfigs({
      'glm-5.1': {
        enabled: true,
        upstreamModelId: ' provider-glm-5.1 ',
        routingPriority: 2,
      },
      'kimi-k2': {
        enabled: false,
        routing_priority: 4,
      },
    });

    expect(normalized).toBe(
      JSON.stringify({
        'glm-5.1': {
          upstreamModelId: 'provider-glm-5.1',
          routingPriority: 2,
        },
        'kimi-k2': {
          enabled: false,
          routingPriority: 4,
        },
      }),
    );
  });

  it('rejects invalid routing priority', () => {
    expect(() =>
      validateModelConfigs({
        'glm-5.1': { routingPriority: 0 },
      }),
    ).toThrow(/routingPriority/);
  });

  it('preserves supported publisher route runtime fields and drops retired protocol override', () => {
    const normalized = validateModelConfigs({
      'claude-sonnet-4-6': {
        anthropic_beta: ' extended-cache-ttl-2025-04-11 ',
        token_count_strategy: 'native',
        protocolStrategyOverride: 'passthrough_only',
        protocolStrategyOverrideReason: 'Native endpoint rollout protection',
        protocolStrategyOverrideOwner: 'platform-runtime',
        protocolStrategyOverrideExpiresAt: '2099-01-01T00:00:00.000Z',
        request_param_policy: {
          temperature: {
          category: 'sampling',
          on_equal: 'preserve',
            on_mismatch: 'reject',
          },
        },
      },
    });

    expect(normalized).toBe(JSON.stringify({
      'claude-sonnet-4-6': {
        anthropicBeta: 'extended-cache-ttl-2025-04-11',
        tokenCountStrategy: 'native',
        requestParamPolicy: {
          temperature: {
            category: 'sampling',
            on_equal: 'preserve',
            on_mismatch: 'reject',
          },
        },
      },
    }));
  });

  it('rejects frozen channel capability overrides', () => {
    expect(() =>
      validateModelConfigs({
        'claude-sonnet-4-6': {
          capabilityOverrides: {
            add: ['count_tokens'],
          },
        },
      }),
    ).toThrow(/capabilityOverrides/);
  });

  it('silently drops retired protocol strategy override-only configs', () => {
    expect(validateModelConfigs({
      'glm-5.1': {
        protocolStrategyOverride: 'high',
        protocolStrategyOverrideReason: 'test',
        protocolStrategyOverrideOwner: 'platform-runtime',
        protocolStrategyOverrideExpiresAt: '2099-01-01T00:00:00.000Z',
      },
    })).toBe('{}');
  });

  it('emits downstream routing_priority', () => {
    const configs = parseModelConfigs(
      JSON.stringify({
        'glm-5.1': {
          upstreamModelId: 'provider-glm-5.1',
          routingPriority: 2,
        },
      }),
    );

    expect(toDownstreamModelDict(['glm-5.1'], configs)).toEqual({
      'glm-5.1': {
        provider_model_name: 'provider-glm-5.1',
        routing_priority: 2,
      },
    });
  });

  it('does not expose frozen capability overrides from stored configs', () => {
    const configs = parseModelConfigs(
      JSON.stringify({
        'glm-5.1': {
          routingPriority: 2,
          capabilityOverrides: {
            add: ['count_tokens'],
          },
        },
        'kimi-k2': {
          capability_overrides: {
            remove: ['embeddings'],
          },
        },
      }),
    );

    expect(configs).toEqual({
      'glm-5.1': {
        routingPriority: 2,
      },
    });
  });
});
