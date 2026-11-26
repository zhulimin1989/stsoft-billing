import {
  isStrictDedicatedProviderIsolation,
  providerEndpointIsolationFromMetadata,
} from './provider-isolation.policy';

const STRICT_DEDICATED_ISOLATION = {
  visibility: 'dedicated_only',
  credential_source: 'dedicated_upstream',
  allowed_route_kinds: ['dedicated_route'],
};

describe('provider isolation policy', () => {
  it.each([
    [{ visibility: 'external' }, '.visibility is invalid'],
    [{ credential_source: 'embedded_key' }, '.credential_source is invalid'],
    [{ allowed_route_kinds: ['unknown_route'] }, '.allowed_route_kinds contains invalid route kind'],
  ])('rejects invalid isolation enum values', (providerIsolation, expectedError) => {
    expect(() => providerEndpointIsolationFromMetadata(
      { provider_isolation: providerIsolation },
      'ProductChannel pc-1 metadata',
    )).toThrow(expectedError);
  });

  it.each([
    [{ visibility: 'dedicated_only' }, '.credential_source must be dedicated_upstream'],
    [{ credential_source: 'dedicated_upstream' }, '.visibility must be dedicated_only'],
    [{ allowed_route_kinds: ['dedicated_route'] }, '.visibility must be dedicated_only'],
  ])('rejects partial dedicated isolation tuples', (providerIsolation, expectedError) => {
    expect(() => providerEndpointIsolationFromMetadata(
      { provider_isolation: providerIsolation },
      'ProductChannel pc-1 metadata',
    )).toThrow(expectedError);
  });

  it.each(['tenant_id', 'entitlement_id'])(
    'rejects %s in shared dedicated owner_scope',
    (ownerField) => {
      expect(() => providerEndpointIsolationFromMetadata({
        provider_isolation: {
          ...STRICT_DEDICATED_ISOLATION,
          owner_scope: { [ownerField]: 'owner-1' },
        },
      }, 'ProductChannel pc-1 metadata')).toThrow(
        '.owner_scope must not include tenant_id or entitlement_id',
      );
    },
  );

  it('accepts product ownership on a complete dedicated isolation tuple', () => {
    const isolation = providerEndpointIsolationFromMetadata({
      provider_isolation: {
        ...STRICT_DEDICATED_ISOLATION,
        owner_scope: { product_id: 'prod-1' },
      },
    }, 'ProductChannel pc-1 metadata');

    expect(isolation).toEqual({
      ...STRICT_DEDICATED_ISOLATION,
      owner_scope: { product_id: 'prod-1' },
    });
    expect(isStrictDedicatedProviderIsolation(isolation)).toBe(true);
  });
});
