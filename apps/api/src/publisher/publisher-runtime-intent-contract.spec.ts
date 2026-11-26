import {
  DEDICATED_PROTOCOL_CHANNELS,
  loadGoldenFixture,
  schemas,
  validateProductRuntimePolicy,
  validateProviderInfo,
  validateRuntimeIntent,
} from '@raytone-lab/publisher-contracts';
import type { RuntimeIntent } from '@raytone-lab/publisher-contracts';

function fixture(): RuntimeIntent {
  return structuredClone(
    loadGoldenFixture('runtime_intent.channelized_shared_key.json'),
  ) as RuntimeIntent;
}

function validationErrors(): string {
  return (validateRuntimeIntent.errors ?? [])
    .map((error) => `${error.instancePath || '/'} ${error.message ?? error.keyword}`)
    .join('; ');
}

describe('Publisher RuntimeIntent v2 contract', () => {
  it('accepts golden enforce, shadow, omitted route_graph_enforcement, and omitted route_graph variants', () => {
    const golden = fixture();
    expect(validateRuntimeIntent(golden)).toBe(true);
    expect(golden.schema_version).toBe(2);
    expect(golden.product_policies?.[0]?.route_graph?.schema_version).toBe(1);
    expect(golden.product_policies?.[0]?.route_graph_enforcement).toBe('enforce');

    const productRuntimePolicy = loadGoldenFixture('product_runtime_policy.prod_coding.json');
    expect(validateProductRuntimePolicy(productRuntimePolicy)).toBe(true);
    expect((productRuntimePolicy as { route_graph_enforcement?: string }).route_graph_enforcement).toBe('enforce');

    const shadowEnforcement = fixture();
    for (const policy of shadowEnforcement.product_policies ?? []) {
      policy.route_graph_enforcement = 'shadow';
    }
    expect(validateRuntimeIntent(shadowEnforcement)).toBe(true);

    const noEnforcement = fixture();
    for (const policy of noEnforcement.product_policies ?? []) {
      delete policy.route_graph_enforcement;
    }
    expect(validateRuntimeIntent(noEnforcement)).toBe(true);

    const noRouteGraph = fixture();
    for (const policy of noRouteGraph.product_policies ?? []) {
      delete policy.route_graph;
      delete policy.route_graph_required;
      delete policy.route_graph_enforcement;
    }
    expect(validateRuntimeIntent(noRouteGraph)).toBe(true);
  });

  it('requires RuntimeIntent and route_graph schema_version', () => {
    const missingTopSchema = fixture() as Partial<RuntimeIntent>;
    delete missingTopSchema.schema_version;
    expect(validateRuntimeIntent(missingTopSchema)).toBe(false);
    expect(validationErrors()).toContain("must have required property 'schema_version'");

    const missingRouteGraphSchema = fixture();
    delete (missingRouteGraphSchema as any).product_policies[0].route_graph.schema_version;
    expect(validateRuntimeIntent(missingRouteGraphSchema)).toBe(false);
    expect(validationErrors()).toContain("must have required property 'schema_version'");
  });

  it('requires a stable provider_account_ref on every credential', () => {
    const missingAccountRef = fixture();
    const credential = missingAccountRef.provider_credentials?.[0] as Partial<
      NonNullable<RuntimeIntent['provider_credentials']>[number]
    >;
    delete credential.provider_account_ref;

    expect(validateRuntimeIntent(missingAccountRef)).toBe(false);
    expect(validationErrors()).toContain("must have required property 'provider_account_ref'");
  });

  it('rejects tightened enum fields before publishing', () => {
    const invalidProviderProfile = fixture();
    (invalidProviderProfile as any).provider_endpoints[0].provider_profile = 'invalid_profile';
    expect(validateRuntimeIntent(invalidProviderProfile)).toBe(false);
    expect(validationErrors()).toContain('/provider_endpoints/0/provider_profile');

    const invalidServedInboundProtocol = fixture();
    (invalidServedInboundProtocol as any).client_exposures[0].served_inbound_protocols = ['invalid_protocol'];
    delete (invalidServedInboundProtocol as any).client_exposures[0].client_compatibility;
    expect(validateRuntimeIntent(invalidServedInboundProtocol)).toBe(false);
    expect(validationErrors()).toContain('/client_exposures/0/served_inbound_protocols/0');

    const invalidTokenCountStrategy = fixture();
    (invalidTokenCountStrategy as any).client_exposures[0].token_count_strategy = 'invalid_strategy';
    expect(validateRuntimeIntent(invalidTokenCountStrategy)).toBe(false);
    expect(validationErrors()).toContain('/client_exposures/0/token_count_strategy');

    const invalidCapability = fixture();
    (invalidCapability as any).model_routes[0].routes[0].capabilities = ['vision'];
    expect(validateRuntimeIntent(invalidCapability)).toBe(false);
    expect(validationErrors()).toContain('/model_routes/0/routes/0/capabilities/0');
  });

  it('accepts explicit client exposure paths and rejects unknown path channels', () => {
    const explicitPaths = fixture();
    (explicitPaths as any).client_exposures[0].paths = [
      { inbound_protocol: 'openai', channel: 'passthrough' },
      { inbound_protocol: 'responses', channel: 'responses_to_chat' },
    ];
    (explicitPaths as any).client_exposures[0].served_inbound_protocols = ['openai', 'responses'];
    expect(validateRuntimeIntent(explicitPaths)).toBe(true);

    const invalidPathChannel = structuredClone(explicitPaths);
    (invalidPathChannel as any).client_exposures[0].paths[0].channel = 'auto';
    expect(validateRuntimeIntent(invalidPathChannel)).toBe(false);
    expect(validationErrors()).toContain('/client_exposures/0/paths/0/channel');
  });

  it('pins dedicated protocol channel exports', () => {
    expect(DEDICATED_PROTOCOL_CHANNELS).toEqual([
      'passthrough',
      'responses_to_chat',
      'anthropic_to_chat',
    ]);
  });

  it('pins the canonical Ark video binding and video task profile byte-for-byte', () => {
    const provider = loadGoldenFixture('provider_info.ark_video_task_profile.json') as any;
    expect(validateProviderInfo(provider)).toBe(true);
    const binding = provider.protocol_bindings[0];
    const acceptance = binding.accepts[0];

    expect({
      name: binding.name,
      inbound_protocol: acceptance.protocol,
      capability: acceptance.capabilities[0],
      request_contract: acceptance.request_contract,
      outbound_protocol: binding.outbound_protocol,
      auth_scheme: binding.auth_scheme,
      translator: binding.translator,
      compat_api_type: binding.compat_api_type,
      default_protocol_binding: provider.default_protocol_binding,
    }).toEqual({
      name: 'ark-video-task-create',
      inbound_protocol: 'ark',
      capability: 'video_generation',
      request_contract: 'ark_video_task_create',
      outbound_protocol: 'ark',
      auth_scheme: 'bearer',
      translator: 'passthrough',
      compat_api_type: 'ark',
      default_protocol_binding: 'ark-video-task-create',
    });
    expect(JSON.stringify(acceptance.video_task_profile)).toBe(
      '{"schema_version":1,"operations":["create","retrieve","delete_terminal"],'
      + '"result_delivery":"signed_url","provider_meter":"video_tokens",'
      + '"task_record_ttl_sec":604800,"content_url_ttl_hint_sec":86400}',
    );

    const contract = schemas.protocolBindingsContract as any;
    expect(contract.runtime_endpoints).toContainEqual({
      outbound_protocol: 'ark',
      capability: 'video_generation',
      request_contract: 'ark_video_task_create',
      path_template: '/contents/generations/tasks',
    });
  });
});
