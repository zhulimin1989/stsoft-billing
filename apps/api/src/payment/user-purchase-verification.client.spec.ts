import { ConfigService } from '@nestjs/config';
import {
  resolveUserServiceBaseUrl,
  UserPurchaseVerificationClient,
} from './user-purchase-verification.client';

function config(values: Record<string, string | undefined>): ConfigService {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

describe('resolveUserServiceBaseUrl', () => {
  it('defaults to the docker user-api service in production', () => {
    expect(resolveUserServiceBaseUrl(config({ NODE_ENV: 'production' }))).toBe(
      'http://user-api:3000/api/internal/user/admin',
    );
  });

  it('keeps the localhost default for local development', () => {
    expect(resolveUserServiceBaseUrl(config({ NODE_ENV: 'development' }))).toBe(
      'http://localhost:3000/api/internal/user/admin',
    );
  });

  it('respects an explicit user service URL', () => {
    expect(
      resolveUserServiceBaseUrl(config({
        NODE_ENV: 'production',
        USER_SERVICE_URL: 'http://custom-user:3000/api/internal/user/admin/',
      })),
    ).toBe('http://custom-user:3000/api/internal/user/admin');
  });
});

describe('UserPurchaseVerificationClient', () => {
  const originalFetch = global.fetch;

  afterEach(() => {
    global.fetch = originalFetch;
    jest.restoreAllMocks();
  });

  it('sends the selected tenant for purchase eligibility checks', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 0, message: 'ok' }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;

    const client = new UserPurchaseVerificationClient(config({
      BILLING_TO_USER_TOKEN: 'billing-user-token',
      USER_SERVICE_URL: 'http://user-api/api/internal/user/admin',
    }));

    await client.assertCanPurchase('user-1', 'tenant-enterprise-1');

    expect(fetchMock).toHaveBeenCalledWith(
      'http://user-api/api/internal/user/admin/users/user-1/purchase-eligibility/assert-v2',
      expect.objectContaining({
        method: 'POST',
        body: JSON.stringify({ tenantId: 'tenant-enterprise-1' }),
        headers: {
          'content-type': 'application/json',
          'x-internal-caller': 'billing-api',
          'x-internal-token': 'billing-user-token',
          'x-billing-api-version': '2026-05-16',
        },
      }),
    );
  });

  it('resolves authoritative finance user ids by contact', async () => {
    const fetchMock = jest.fn().mockResolvedValue({
      ok: true,
      status: 200,
      text: async () => JSON.stringify({ code: 0, data: { ids: ['user-1', 'user-1', ''] } }),
    });
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = new UserPurchaseVerificationClient(config({
      BILLING_TO_USER_TOKEN: 'billing-user-token',
      USER_SERVICE_URL: 'http://user-api/api/internal/user/admin',
    }));

    await expect(client.findFinanceUserIdsByContact('13800138000'))
      .resolves.toEqual(['user-1']);
    expect(fetchMock).toHaveBeenCalledWith(
      'http://user-api/api/internal/user/admin/users/finance-search-ids',
      expect.objectContaining({ body: JSON.stringify({ value: '13800138000' }) }),
    );
  });

  it('loads finance contacts in bounded batches', async () => {
    const fetchMock = jest.fn()
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({
          code: 0,
          data: { items: [{ id: 'u0', phone: '13800138000', email: null, nickname: 'name' }] },
        }),
      })
      .mockResolvedValueOnce({
        ok: true,
        status: 200,
        text: async () => JSON.stringify({ code: 0, data: { items: [] } }),
      });
    global.fetch = fetchMock as unknown as typeof fetch;
    const client = new UserPurchaseVerificationClient(config({
      BILLING_TO_USER_TOKEN: 'billing-user-token',
      USER_SERVICE_URL: 'http://user-api/api/internal/user/admin',
    }));

    await expect(client.getFinanceUserContactsByIds(
      Array.from({ length: 201 }, (_, index) => `u${index}`),
    )).resolves.toEqual([
      { id: 'u0', phone: '13800138000', email: null, nickname: 'name' },
    ]);
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });
});
