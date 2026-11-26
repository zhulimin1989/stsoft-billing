import { retiredPublisherRequest } from './publisher-request-policy';

describe('publisher request retirement policy', () => {
  it.each([
    ['PUT', '/admin/api/v1/key-pools/kimi', undefined],
    ['DELETE', '/admin/api/v1/key-pools/kimi', undefined],
    ['POST', '/admin/api/v1/key-pools/bulk', undefined],
    ['PUT', '/ops/api/v1/key-pools/kimi/keys/key-1', undefined],
    ['DELETE', '/ops/api/v1/key-pools/kimi/keys/key-1', undefined],
    ['POST', '/admin/api/v1/key-pools/keys/bulk', undefined],
    ['DELETE', 'https://publisher.test/OPS//API/v1/key-pools/keys/bulk?source=retry', undefined],
    ['POST', '/generic/publisher/write', ' KEY_POOL '],
  ])(
    'retires legacy KeyPool mutation %s %s',
    (method, path, resourceType) => {
      expect(retiredPublisherRequest({ method, path, resourceType })).toMatchObject({
        code: 'LEGACY_KEY_POOL_PUBLISH_RETIRED',
      });
    },
  );

  it.each([
    ['GET', '/admin/api/v1/key-pools/kimi', 'key_pool'],
    ['POST', '/admin/api/v1/key-pools-archive/bulk', undefined],
    ['POST', '/admin/api/v1/models/routes/bulk', undefined],
  ])(
    'does not classify a non-KeyPool mutation %s %s',
    (method, path, resourceType) => {
      expect(retiredPublisherRequest({ method, path, resourceType })).toBeNull();
    },
  );

  it.each([
    {
      name: 'single user write with an absent ref',
      method: 'PUT',
      path: '/user/api/v1/keys',
      body: { dedicated_upstream: { upstream_key_id: 'entitlement-1' } },
    },
    {
      name: 'single legacy portal write with a blank ref',
      method: 'PUT',
      path: '/portal/api/v1/keys',
      body: { dedicated_upstream: { provider_account_ref: '  ' } },
    },
    {
      name: 'user bulk write containing one legacy dedicated item',
      method: 'POST',
      path: '/user/api/v1/keys/bulk',
      body: {
        items: [
          { key_id: 'ordinary-key' },
          { dedicated_upstream: { provider_account_ref: 'pa_current' } },
          { dedicated_upstream: { upstream_key_id: 'legacy-entitlement' } },
        ],
      },
    },
    {
      name: 'normalized portal bulk write containing a legacy item',
      method: ' post ',
      path: 'https://publisher.test/PORTAL//api/v1/keys%2Fbulk?source=retry#fragment',
      body: { items: [{ dedicated_upstream: { provider_account_ref: null } }] },
    },
  ])('retires dedicated KeyMeta v1: $name', ({ method, path, body }) => {
    expect(retiredPublisherRequest({ method, path, body })).toMatchObject({
      code: 'DEDICATED_KEY_META_V1_RETIRED',
    });
  });

  it.each([
    {
      name: 'all dedicated bulk items carry refs',
      method: 'POST',
      path: '/user/api/v1/keys/bulk',
      body: {
        items: [
          { dedicated_upstream: { provider_account_ref: 'pa_first' } },
          { dedicated_upstream: { provider_account_ref: 'pa_second' } },
        ],
      },
    },
    {
      name: 'bulk contains only ordinary KeyMeta',
      method: 'POST',
      path: '/portal/api/v1/keys/bulk',
      body: { items: [{ key_id: 'ordinary-key' }] },
    },
    {
      name: 'delete bulk is not a KeyMeta write',
      method: 'DELETE',
      path: '/user/api/v1/keys/bulk',
      body: { items: [{ dedicated_upstream: {} }] },
    },
    {
      name: 'unrelated nested path is not a KeyMeta write',
      method: 'POST',
      path: '/user/api/v1/keys/bulk/archive',
      body: { items: [{ dedicated_upstream: {} }] },
    },
  ])('allows non-legacy dedicated request: $name', ({ method, path, body }) => {
    expect(retiredPublisherRequest({ method, path, body })).toBeNull();
  });
});
