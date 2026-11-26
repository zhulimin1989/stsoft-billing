import { ConfigService } from '@nestjs/config';
import { PublisherClient, PublisherClientError } from './publisher.client';
import { PublisherProvider } from './publisher.types';

describe('PublisherClient', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  function clientWith(env: Record<string, string>) {
    const config = {
      get: jest.fn((key: string) => env[key]),
    } as unknown as ConfigService;
    return new PublisherClient(config);
  }

  it('adds namespace auth, idempotency and request id headers', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 202,
      text: async () => JSON.stringify({ batch_id: 'batch-1', status: 'accepted' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = clientWith({
      PUBLISHER_BASE_URL: 'https://publisher.test/',
      PUBLISHER_USER_TOKEN: 'user-token',
    });

    const body = {
      key_id: '9f1c4b78-0b89-4e1d-8f2a-3e0d8a72b1f4',
      key_hash: 'a'.repeat(64),
      status: 'active' as const,
      expires_at: 0,
      ip_whitelist: [],
      allowed_models: [],
    };
    const result = await client.putUserKey(body);

    expect(result).toEqual({ batch_id: 'batch-1', status: 'accepted' });
    expect(fetchMock).toHaveBeenCalledWith(
      'https://publisher.test/user/api/v1/keys',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({
          Authorization: 'Bearer user-token',
          'Content-Type': 'application/json',
          'Idempotency-Key': expect.stringMatching(/^rd:user:put:/),
          'X-Request-ID': expect.any(String),
        }),
        body: JSON.stringify(body),
      }),
    );
  });

  it('is a no-op when publisher base URL is not configured', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = clientWith({ PUBLISHER_USER_TOKEN: 'user-token' });

    await expect(client.deleteUserKey('a'.repeat(64))).resolves.toBeNull();
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('queries key admission delivery receipts with billing authentication', async () => {
    const receipt = {
      batch_id: 'batch-1',
      status: 'applied',
      total: 1,
      pending_count: 0,
      applied_count: 1,
      idempotent_count: 0,
      superseded_count: 0,
      conflict_count: 0,
      dead_letter_count: 0,
      unverified_count: 0,
    };
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(receipt),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = clientWith({
      PUBLISHER_BASE_URL: 'https://publisher.test/',
      PUBLISHER_BILLING_TOKEN: 'billing-token',
    });

    await expect(client.getKeyAdmissionDelivery('batch-1')).resolves.toEqual(receipt);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://publisher.test/billing/api/v1/key-admission-deliveries/batch-1',
      expect.objectContaining({
        method: 'GET',
        headers: expect.objectContaining({ Authorization: 'Bearer billing-token' }),
      }),
    );
    const headers = fetchMock.mock.calls[0][1].headers as Record<string, string>;
    expect(headers).not.toHaveProperty('Idempotency-Key');
  });

  it('sends an explicit decision body for key admission deletes', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 202,
      text: async () => JSON.stringify({ batch_id: 'batch-1', status: 'accepted' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = clientWith({
      PUBLISHER_BASE_URL: 'https://publisher.test/',
      PUBLISHER_BILLING_TOKEN: 'billing-token',
    });
    const body = {
      decision_id: '3f746d48-31dc-4a20-b284-9df0b578ee2b',
      decision_version: 1_800_000_000_000_000,
    };

    await client.deleteKeyBalance('key-1', body);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://publisher.test/billing/api/v1/key-balance/key-1',
      expect.objectContaining({ method: 'DELETE', body: JSON.stringify(body) }),
    );
  });

  it.each([
    ['explicitly disabled', { PUBLISHER_ENABLED: 'false' }],
    ['provider-account identity migration mode', {
      PUBLISHER_ACCOUNT_IDENTITY_MIGRATION_MODE: 'true',
      PUBLISHER_ENABLED: 'true',
    }],
  ])('never fetches while Publisher network is %s', async (_name, modeEnv) => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = clientWith({
      PUBLISHER_BASE_URL: 'https://publisher.test/',
      PUBLISHER_TOKEN: 'retained-token',
      ...modeEnv,
    });
    const previewBody: PublisherProvider = {
      id: 'preview-kimi',
      code: 'kimi',
      name: 'Kimi',
      base_url: 'https://api.moonshot.cn',
      status: 'active',
    };

    await expect(client.request(
      'billing',
      'PUT',
      '/billing/api/v1/key-balance/key-1',
      { has_balance: true },
    )).resolves.toBeNull();
    await expect(client.safeRequest(
      'user',
      'DELETE',
      `/user/api/v1/keys/${'a'.repeat(64)}`,
    )).resolves.toBeNull();
    await expect(client.compileProviderPreview(previewBody)).resolves.toBeNull();

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('fails closed for a retired request before applying the disabled-network no-op', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = clientWith({
      PUBLISHER_ENABLED: 'false',
      PUBLISHER_BASE_URL: 'https://publisher.test/',
      PUBLISHER_ADMIN_TOKEN: 'retained-token',
    });

    await expect(client.safeRequest(
      'admin',
      'POST',
      '/admin/api/v1/providers:from-intent',
      { schema_version: 1 },
    )).rejects.toMatchObject<Partial<PublisherClientError>>({
      status: 400,
      code: 'RUNTIME_INTENT_V1_RETIRED',
    });
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    '/admin/api/v1/providers/anthropic',
    '/admin/api/v1/providers',
    '/admin/api/v1/foo/../providers/anthropic',
    '/admin/api/v1/%70roviders/anthropic',
    '/ops/api/v1/foo/%2e%2e/providers/anthropic',
    '/admin//api/v1/providers/anthropic',
    '/ops///api/v1/providers/anthropic',
    '//admin/api/v1/providers/anthropic',
    '\\admin\\api\\v1\\providers\\anthropic',
  ])('rejects legacy provider PUT at the final network boundary: %s', async (path) => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = clientWith({
      PUBLISHER_BASE_URL: 'https://publisher.test/',
      PUBLISHER_ADMIN_TOKEN: 'admin-token',
    });

    await expect(client.request(
      'admin',
      'PUT',
      path,
      { synthetic: true },
    )).rejects.toMatchObject<Partial<PublisherClientError>>({
      status: 400,
      code: 'LEGACY_PROVIDER_PUBLISH_RETIRED',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      namespace: 'admin' as const,
      method: 'PUT' as const,
      path: '/ops/api/v1/providers/anthropic',
      body: { synthetic: true },
      code: 'LEGACY_PROVIDER_PUBLISH_RETIRED',
    },
    {
      namespace: 'admin' as const,
      method: 'DELETE' as const,
      path: '/ops/api/v1/key-pools/kimi/keys/key-1',
      body: undefined,
      code: 'LEGACY_KEY_POOL_PUBLISH_RETIRED',
    },
    {
      namespace: 'user' as const,
      method: 'POST' as const,
      path: '/user/api/v1/keys/bulk',
      body: { items: [{ dedicated_upstream: { upstream_key_id: 'legacy' } }] },
      code: 'DEDICATED_KEY_META_V1_RETIRED',
    },
  ])('does not swallow retired error $code in safeRequest', async ({
    namespace,
    method,
    path,
    body,
    code,
  }) => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = clientWith({
      PUBLISHER_BASE_URL: 'https://publisher.test/',
      PUBLISHER_ADMIN_TOKEN: 'admin-token',
    });

    await expect(client.safeRequest(
      namespace,
      method,
      path,
      body,
    )).rejects.toMatchObject<Partial<PublisherClientError>>({
      status: 400,
      code,
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('rejects RuntimeIntent v1 at the final network boundary', async () => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = clientWith({
      PUBLISHER_BASE_URL: 'https://publisher.test/',
      PUBLISHER_ADMIN_TOKEN: 'admin-token',
    });

    await expect(client.request(
      'admin',
      'POST',
      '/admin/api/v1/providers:from-intent',
      { schema_version: 1 },
    )).rejects.toMatchObject<Partial<PublisherClientError>>({
      status: 400,
      code: 'RUNTIME_INTENT_V1_RETIRED',
    });

    await expect(client.safeRequest(
      'admin',
      'POST',
      '/ops/api/v1/providers:from-intent',
      { schema_version: 1 },
    )).rejects.toMatchObject<Partial<PublisherClientError>>({
      status: 400,
      code: 'RUNTIME_INTENT_V1_RETIRED',
    });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it.each([
    {
      namespace: 'admin' as const,
      method: 'POST' as const,
      path: '/admin/api/v1/key-pools/keys/bulk',
      body: { items: [{ provider_id: 'kimi', key_id: 'key-1' }] },
      code: 'LEGACY_KEY_POOL_PUBLISH_RETIRED',
    },
    {
      namespace: 'admin' as const,
      method: 'DELETE' as const,
      path: 'https://publisher.test/OPS//api/v1/key-pools/kimi?source=retry',
      body: undefined,
      code: 'LEGACY_KEY_POOL_PUBLISH_RETIRED',
    },
    {
      namespace: 'user' as const,
      method: 'POST' as const,
      path: '/user/api/v1/keys/bulk',
      body: {
        items: [
          { key_id: 'ordinary-key' },
          {
            key_id: 'dedicated-key',
            dedicated_upstream: { upstream_key_id: 'entitlement-1', ciphertext: 'kms:test' },
          },
        ],
      },
      code: 'DEDICATED_KEY_META_V1_RETIRED',
    },
  ])('rejects retired payload $code at the final network boundary', async ({
    namespace,
    method,
    path,
    body,
    code,
  }) => {
    const fetchMock = jest.fn();
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = clientWith({
      PUBLISHER_BASE_URL: 'https://publisher.test/',
      PUBLISHER_ADMIN_TOKEN: 'admin-token',
      PUBLISHER_USER_TOKEN: 'user-token',
    });

    await expect(client.request(
      namespace,
      method,
      path,
      body,
    )).rejects.toMatchObject<Partial<PublisherClientError>>({ status: 400, code });

    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('continues to send dedicated KeyMeta with provider_account_ref', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 202,
      text: async () => JSON.stringify({ batch_id: 'batch-key-meta', status: 'accepted' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = clientWith({
      PUBLISHER_BASE_URL: 'https://publisher.test/',
      PUBLISHER_USER_TOKEN: 'user-token',
    });
    const body = {
      key_id: 'key-1',
      dedicated_upstream: {
        upstream_key_id: 'entitlement-1',
        provider_account_ref: 'pa_zhipu_main',
        ciphertext: 'kms:test',
      },
    };

    await expect(client.request('user', 'PUT', '/user/api/v1/keys', body)).resolves.toEqual({
      batch_id: 'batch-key-meta',
      status: 'accepted',
    });
    expect(fetchMock).toHaveBeenCalledTimes(1);
  });

  it('continues to send provider DELETE requests', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 202,
      text: async () => JSON.stringify({ batch_id: 'batch-delete', status: 'accepted' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = clientWith({
      PUBLISHER_BASE_URL: 'https://publisher.test/',
      PUBLISHER_ADMIN_TOKEN: 'admin-token',
    });

    await expect(client.deleteProvider('anthropic')).resolves.toEqual({
      batch_id: 'batch-delete',
      status: 'accepted',
    });

    expect(fetchMock).toHaveBeenCalledWith(
      'https://publisher.test/admin/api/v1/providers/anthropic',
      expect.objectContaining({ method: 'DELETE' }),
    );
  });

  it('returns a synchronous refund drain proof', async () => {
    const proof = {
      protocol_version: 1,
      drain_id: 'ent-1',
      key_count: 1,
      in_flight: 0,
      request_seen_key_count: 0,
      ready: true,
    };
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(proof),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = clientWith({
      PUBLISHER_BASE_URL: 'https://publisher.test/',
      PUBLISHER_BILLING_TOKEN: 'billing-token',
      PUBLISHER_REFUND_DRAIN_TIMEOUT_MS: '12000',
    });

    await expect(
      client.establishRefundDrain('ent-1', ['a'.repeat(64)]),
    ).resolves.toEqual(proof);
    expect(fetchMock).toHaveBeenCalledWith(
      'https://publisher.test/billing/api/v1/refund-drains/ent-1',
      expect.objectContaining({
        method: 'PUT',
        headers: expect.objectContaining({
          Authorization: 'Bearer billing-token',
          'Idempotency-Key': expect.stringMatching(/^rd:billing:put:/),
        }),
        body: JSON.stringify({ key_hashes: ['a'.repeat(64)] }),
        signal: expect.any(AbortSignal),
      }),
    );
  });

  it('preserves the legacy compile-preview POST contract', async () => {
    const body: PublisherProvider = {
      id: 'preview-anthropic',
      code: 'anthropic',
      name: 'Anthropic',
      base_url: 'https://api.anthropic.com',
      provider_profile: 'anthropic_native',
      status: 'active',
      key_strategy: 'weight',
    };
    const compiled = {
      provider: body,
      default_protocol_binding: 'anthropic_messages',
      binding_names: ['anthropic_messages'],
    };
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify(compiled),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = clientWith({
      PUBLISHER_BASE_URL: 'https://publisher.test/',
      PUBLISHER_ADMIN_TOKEN: 'admin-token',
    });

    await expect(client.compileProviderPreview(body)).resolves.toEqual(compiled);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://publisher.test/admin/api/v1/providers/compile-preview',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify(body),
      }),
    );
  });

  it('keeps legacy portal token as a user namespace fallback', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 202,
      text: async () => JSON.stringify({ batch_id: 'batch-1', status: 'accepted' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = clientWith({
      PUBLISHER_BASE_URL: 'https://publisher.test/',
      PUBLISHER_PORTAL_TOKEN: 'legacy-token',
    });

    await client.deleteUserKey('a'.repeat(64));

    expect(fetchMock).toHaveBeenCalledWith(
      'https://publisher.test/user/api/v1/keys/aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa',
      expect.objectContaining({
        headers: expect.objectContaining({
          Authorization: 'Bearer legacy-token',
        }),
      }),
    );
  });

  it('generates monotonic unix-microsecond revisions', () => {
    const client = clientWith({});
    const a = client.revision();
    const b = client.revision();

    expect(b).toBeGreaterThan(a);
    expect(String(a).length).toBeGreaterThanOrEqual(16);
  });
});
