import { BadRequestException, UnauthorizedException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { ExecutionContext } from '@nestjs/common';
import { FastifyRequest } from 'fastify';
import { createHmac } from 'crypto';
import { BillingInternalGuard } from './billing-internal.guard';

function config(values: Record<string, string | undefined>): ConfigService {
  return {
    get: jest.fn((key: string) => values[key]),
  } as unknown as ConfigService;
}

function context(
  headers: Record<string, string>,
  url = '/internal/billing/admin/orders',
  method = 'GET',
  requestOverrides: Partial<FastifyRequest> = {},
): ExecutionContext {
  const request = { headers, url, method, ...requestOverrides } as unknown as FastifyRequest;
  return {
    switchToHttp: () => ({
      getRequest: () => request,
    }),
  } as unknown as ExecutionContext;
}

function adminContextHeaders(overrides: Record<string, unknown> = {}): Record<string, string> {
  const payload = Buffer.from(JSON.stringify({
    version: 1,
    adminId: 'admin-1',
    presetRole: 'operator',
    permissions: ['admin.plans.manage', 'admin.plans.view'],
    requestId: 'req-admin-1',
    issuedAt: new Date().toISOString(),
    ...overrides,
  }), 'utf8').toString('base64url');
  return {
    'x-admin-context': payload,
    'x-admin-context-signature': createHmac('sha256', 'admin-context-secret')
      .update(payload)
      .digest('hex'),
  };
}

describe('BillingInternalGuard', () => {
  function build(values: Record<string, string | undefined> = {}) {
    return {
      guard: new BillingInternalGuard(
        config({
          ADMIN_TO_BILLING_TOKEN: 'admin-billing-secret',
          ADMIN_TO_BILLING_CONTEXT_SECRET: 'admin-context-secret',
          USER_TO_BILLING_TOKEN: 'user-billing-secret',
          ...values,
        }),
      ),
    };
  }

  it('accepts a valid token only when API version matches', async () => {
    const { guard } = build();

    await expect(guard.canActivate(context({
      'x-internal-caller': 'admin-api',
      'x-internal-token': 'admin-billing-secret',
      'x-billing-api-version': '2026-05-16',
      ...adminContextHeaders(),
    }))).resolves.toBe(true);
  });

  it('attaches admin identity from signed internal admin context', async () => {
    const { guard } = build();
    const ctx = context({
      'x-internal-caller': 'admin-api',
      'x-internal-token': 'admin-billing-secret',
      'x-billing-api-version': '2026-05-16',
      ...adminContextHeaders(),
    });

    await expect(guard.canActivate(ctx)).resolves.toBe(true);
    const req = ctx.switchToHttp().getRequest() as any;
    expect(req.user).toEqual({
      id: 'admin-1',
      presetRole: 'operator',
      adminPermissions: ['admin.plans.manage', 'admin.plans.view'],
    });
  });

  it('rejects a valid token with a missing API version', async () => {
    const { guard } = build();

    await expect(guard.canActivate(context({
      'x-internal-caller': 'admin-api',
      'x-internal-token': 'admin-billing-secret',
      ...adminContextHeaders(),
    }))).rejects.toThrow(BadRequestException);
  });

  it('accepts configured compatibility API versions', async () => {
    const { guard } = build({
      BILLING_INTERNAL_API_VERSION: '2026-06-01',
      BILLING_INTERNAL_ACCEPTED_API_VERSIONS: '2026-05-16, 2026-05-17',
    });

    await expect(guard.canActivate(context({
      'x-internal-caller': 'admin-api',
      'x-internal-token': 'admin-billing-secret',
      'x-billing-api-version': '2026-05-17',
      ...adminContextHeaders(),
    }))).resolves.toBe(true);
  });

  it('rejects old shared token fallback values', async () => {
    const { guard } = build({ BILLING_INTERNAL_TOKEN: 'legacy-secret', SYNC_TOKEN: 'sync-secret' });

    await expect(guard.canActivate(context({
      'x-internal-caller': 'admin-api',
      'x-internal-token': 'legacy-secret',
      'x-billing-api-version': '2026-05-16',
      ...adminContextHeaders(),
    }))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects invalid configured API version formats', async () => {
    const { guard } = build({ BILLING_INTERNAL_API_VERSION: 'next' });

    await expect(guard.canActivate(context({
      'x-internal-caller': 'admin-api',
      'x-internal-token': 'admin-billing-secret',
      'x-billing-api-version': 'next',
      ...adminContextHeaders(),
    }))).rejects.toThrow('BILLING_INTERNAL_API_VERSION must use YYYY-MM-DD format');
  });

  it('rejects invalid compatibility API version formats', async () => {
    const { guard } = build({ BILLING_INTERNAL_ACCEPTED_API_VERSIONS: '2026-05-16,next' });

    await expect(guard.canActivate(context({
      'x-internal-caller': 'admin-api',
      'x-internal-token': 'admin-billing-secret',
      'x-billing-api-version': '2026-05-16',
      ...adminContextHeaders(),
    }))).rejects.toThrow('BILLING_INTERNAL_API_VERSION must use YYYY-MM-DD format');
  });

  it('allows user-api only on explicit user-to-billing routes', async () => {
    const { guard } = build();

    await expect(guard.canActivate(context({
      'x-internal-caller': 'user-api',
      'x-internal-token': 'user-billing-secret',
      'x-billing-api-version': '2026-05-16',
    }, '/api/internal/billing/admin/api-keys/key-1/mirror', 'PUT'))).resolves.toBe(true);

    await expect(guard.canActivate(context({
      'x-internal-caller': 'user-api',
      'x-internal-token': 'user-billing-secret',
      'x-billing-api-version': '2026-05-16',
    }, '/api/internal/billing/admin/orders', 'GET'))).rejects.toThrow(UnauthorizedException);
  });

  it('allows user-api to transfer an enterprise owner only through POST', async () => {
    const { guard } = build();
    const headers = {
      'x-internal-caller': 'user-api',
      'x-internal-token': 'user-billing-secret',
      'x-billing-api-version': '2026-05-16',
    };
    const path = '/api/internal/billing/admin/enterprise-accounts/ba-ent-1/transfer-owner';

    await expect(guard.canActivate(context(headers, path, 'POST'))).resolves.toBe(true);
    await expect(guard.canActivate(context(headers, path, 'GET')))
      .rejects.toThrow(UnauthorizedException);
    await expect(guard.canActivate(context(
      headers,
      `${path}/unexpected`,
      'POST',
    ))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects admin-api requests without signed admin context', async () => {
    const { guard } = build();

    await expect(guard.canActivate(context({
      'x-internal-caller': 'admin-api',
      'x-internal-token': 'admin-billing-secret',
      'x-billing-api-version': '2026-05-16',
    }))).rejects.toThrow(UnauthorizedException);
  });

  it('rejects product tokens on billing internal routes', async () => {
    const { guard } = build();

    await expect(guard.canActivate(context(
      { 'x-product-token': 'product-token' },
      '/api/sync/product/current',
    ))).rejects.toThrow(UnauthorizedException);

    await expect(guard.canActivate(context(
      { 'x-product-token': 'product-token' },
      '/api/internal/billing/product-portal/plans?productSlug=payg',
      'GET',
    ))).rejects.toThrow(UnauthorizedException);
  });

  it('does not relax product token scope because a query string contains an allowed path', async () => {
    const { guard } = build();

    await expect(guard.canActivate(context(
      { 'x-product-token': 'product-token' },
      '/internal/billing/admin/orders?next=/sync/product/current',
    ))).rejects.toThrow(UnauthorizedException);
  });
});
