import type { PrismaService } from '../prisma/prisma.service';
import {
  evaluateProviderAccountReadiness,
} from '../../scripts/check-provider-account-identity-readiness';

describe('provider account readiness evaluation', () => {
  it('checks fulfillment-enabled provider lines and uses provider-line authority for entitlements', async () => {
    const codingPlanProviderLine = {
      findMany: jest.fn().mockResolvedValue([providerLineFixture()]),
    };
    const codingPlanProviderEntitlement = {
      findMany: jest.fn().mockResolvedValue([{
        id: 'entitlement-1',
        provider: 'openai',
        providerCode: 'anthropic',
        providerLineId: 'line-1',
        providerAccountIdentityId: 'identity-line-1',
        providerLine: {
          providerCode: 'moonshot',
          providerAccountIdentityId: 'identity-line-1',
        },
        upstreamApiKeyEncrypted: 'encrypted-api-key',
        upstreamSecretKeyEncrypted: 'encrypted-secret-key',
        providerAccountIdentity: {
          ref: 'pa_kimi_entitlement',
          providerCode: 'kimi',
          status: 'active',
        },
      }]),
    };
    const prisma = {
      codingPlanResaleRoute: { findMany: jest.fn().mockResolvedValue([]) },
      codingPlanProviderLine,
      codingPlanProviderEntitlement,
    } as unknown as PrismaService;
    const publisherSync = {
      buildRuntimeIntent: jest.fn().mockResolvedValue({
        provider_credentials: [{ provider_account_ref: 'pa_kimi_entitlement' }],
      }),
    };

    const report = await evaluateProviderAccountReadiness(
      prisma,
      publisherSync as never,
      new Date('2026-08-11T00:00:00.000Z'),
    );

    expect(codingPlanProviderLine.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: { fulfillmentEnabled: true },
      select: expect.objectContaining({
        providerAccountIdentityId: true,
        providerAccountIdentity: {
          select: { ref: true, providerCode: true, status: true },
        },
      }),
    }));
    expect(codingPlanProviderEntitlement.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: {
        status: 'ACTIVE',
        OR: [
          { productEndTime: null },
          { productEndTime: { gt: new Date('2026-08-11T00:00:00.000Z') } },
        ],
      },
      select: expect.objectContaining({
        providerLine: {
          select: {
            providerCode: true,
            providerAccountIdentityId: true,
          },
        },
      }),
    }));
    expect(report).toMatchObject({
      ready: true,
      codingPlanProviderLines: { scanned: 1, ready: 1 },
      codingPlanResaleRouteGroups: { scanned: 0, ready: 0 },
      codingPlanProviderEntitlements: { scanned: 1, ready: 1 },
      issues: [],
    });
  });

  it('reports a fulfillment-enabled provider line without an active identity', async () => {
    const prisma = {
      codingPlanResaleRoute: { findMany: jest.fn().mockResolvedValue([]) },
      codingPlanProviderLine: {
        findMany: jest.fn().mockResolvedValue([providerLineFixture({
          providerAccountIdentity: null,
          providerAccountIdentityId: null,
        })]),
      },
      codingPlanProviderEntitlement: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;

    const report = await evaluateProviderAccountReadiness(
      prisma,
      { buildRuntimeIntent: jest.fn().mockResolvedValue({ provider_credentials: [] }) } as never,
    );

    expect(report.ready).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scope: 'coding_plan_provider_line',
        id: 'line-1',
        message: '供应商账户身份不存在',
      }),
    ]));
  });

  it('reports every active entitlement whose upstream credential pair is incomplete', async () => {
    const prisma = {
      codingPlanResaleRoute: { findMany: jest.fn().mockResolvedValue([]) },
      codingPlanProviderLine: { findMany: jest.fn().mockResolvedValue([]) },
      codingPlanProviderEntitlement: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'entitlement-incomplete',
          provider: 'kimi',
          providerCode: 'kimi',
          providerLineId: 'line-1',
          providerAccountIdentityId: 'identity-line-1',
          providerLine: {
            providerCode: 'kimi',
            providerAccountIdentityId: 'identity-line-1',
          },
          upstreamApiKeyEncrypted: 'encrypted-api-key',
          upstreamSecretKeyEncrypted: null,
          providerAccountIdentity: {
            ref: 'pa_kimi_entitlement',
            providerCode: 'kimi',
            status: 'active',
          },
        }]),
      },
    } as unknown as PrismaService;

    const report = await evaluateProviderAccountReadiness(
      prisma,
      { buildRuntimeIntent: jest.fn().mockResolvedValue({ provider_credentials: [] }) } as never,
    );

    expect(report.ready).toBe(false);
    expect(report.codingPlanProviderEntitlements).toEqual({ scanned: 1, ready: 0 });
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scope: 'coding_plan_provider_entitlement',
        id: 'entitlement-incomplete',
        message: 'ACTIVE Provider Entitlement 的上游凭据不完整',
      }),
    ]));
  });

  it('reports an active entitlement bound to a different account than its provider line', async () => {
    const prisma = {
      codingPlanResaleRoute: { findMany: jest.fn().mockResolvedValue([]) },
      codingPlanProviderLine: { findMany: jest.fn().mockResolvedValue([]) },
      codingPlanProviderEntitlement: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'entitlement-mismatch',
          provider: 'kimi',
          providerCode: 'kimi',
          providerLineId: 'line-1',
          providerAccountIdentityId: 'identity-entitlement',
          providerLine: {
            providerCode: 'kimi',
            providerAccountIdentityId: 'identity-line',
          },
          upstreamApiKeyEncrypted: 'encrypted-api-key',
          upstreamSecretKeyEncrypted: 'encrypted-secret-key',
          providerAccountIdentity: {
            ref: 'pa_kimi_entitlement',
            providerCode: 'kimi',
            status: 'active',
          },
        }]),
      },
    } as unknown as PrismaService;

    const report = await evaluateProviderAccountReadiness(
      prisma,
      { buildRuntimeIntent: jest.fn().mockResolvedValue({ provider_credentials: [] }) } as never,
    );

    expect(report.ready).toBe(false);
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        id: 'entitlement-mismatch',
        message: 'Provider Entitlement 的账户身份与供应商线路不一致',
      }),
    ]));
  });

  it('reports a current fulfillable resale route group that spans provider accounts', async () => {
    const codingPlanResaleRoute = {
      findMany: jest.fn().mockResolvedValue([
        resaleRouteFixture('route-primary', 'line-primary', 'identity-primary'),
        resaleRouteFixture('route-runtime', 'line-runtime', 'identity-secondary'),
      ]),
    };
    const prisma = {
      codingPlanResaleRoute,
      codingPlanProviderLine: { findMany: jest.fn().mockResolvedValue([]) },
      codingPlanProviderEntitlement: { findMany: jest.fn().mockResolvedValue([]) },
    } as unknown as PrismaService;

    const report = await evaluateProviderAccountReadiness(
      prisma,
      { buildRuntimeIntent: jest.fn().mockResolvedValue({ provider_credentials: [] }) } as never,
      new Date('2026-08-11T00:00:00.000Z'),
    );

    expect(codingPlanResaleRoute.findMany).toHaveBeenCalledWith(expect.objectContaining({
      where: expect.objectContaining({
        enabled: true,
        providerLine: { salesEnabled: true, fulfillmentEnabled: true },
      }),
      select: expect.objectContaining({
        providerLine: {
          select: { id: true, code: true, providerAccountIdentityId: true },
        },
      }),
    }));
    expect(report.ready).toBe(false);
    expect(report.codingPlanResaleRouteGroups).toEqual({ scanned: 1, ready: 0 });
    expect(report.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        scope: 'coding_plan_resale_route_group',
        message: expect.stringContaining('必须共享同一供应商账户身份'),
      }),
    ]));
  });
});

function providerLineFixture(overrides: Record<string, unknown> = {}) {
  return {
    id: 'line-1',
    providerCode: 'kimi',
    apiBaseUrl: 'https://api.moonshot.cn',
    partnerCodeEncrypted: 'encrypted-partner-code',
    partnerSecretEncrypted: 'encrypted-partner-secret',
    providerAccountIdentityId: 'identity-line-1',
    providerAccountIdentity: {
      ref: 'pa_kimi_line',
      providerCode: 'kimi',
      status: 'active',
    },
    ...overrides,
  };
}

function resaleRouteFixture(id: string, lineId: string, identityId: string) {
  return {
    id,
    planId: 'plan-resale',
    priority: 100,
    market: null,
    currency: null,
    salesChannel: null,
    userSegmentId: null,
    providerLine: {
      id: lineId,
      code: lineId,
      providerAccountIdentityId: identityId,
    },
  };
}
