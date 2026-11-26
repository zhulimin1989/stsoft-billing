import { BadRequestException } from '@nestjs/common';
import { CodingPlanResaleRouteService } from './coding-plan-resale-route.service';

describe('CodingPlanResaleRouteService', () => {
  function route(overrides: Record<string, unknown> = {}) {
    return {
      id: 'route-default',
      planId: 'plan-1',
      providerLineId: 'line-1',
      upstreamProductId: 'upstream-default',
      fulfillmentMethod: 'create_order',
      enabled: true,
      priority: 100,
      market: null,
      currency: null,
      salesChannel: null,
      userSegmentId: null,
      startAt: null,
      endAt: null,
      metadata: null,
      createdAt: new Date('2026-01-01T00:00:00.000Z'),
      updatedAt: new Date('2026-01-01T00:00:00.000Z'),
      providerLine: {
        id: 'line-1',
        code: 'zhipu-cn',
        name: 'Zhipu CN',
        providerCode: 'zhipu',
        salesEnabled: true,
      },
      ...overrides,
    };
  }

  function buildService(routes: Array<Record<string, unknown>> = []) {
    const prisma = {
      codingPlanResaleRoute: {
        count: jest.fn().mockResolvedValue(routes.length),
        findMany: jest.fn().mockResolvedValue(routes),
      },
      userSegmentMember: {
        findMany: jest.fn().mockResolvedValue([]),
      },
    };
    const service = new CodingPlanResaleRouteService(prisma as never);
    return { service, prisma };
  }

  it('does not match scoped routes when the request lacks that route dimension', async () => {
    const scoped = route({
      id: 'route-cn',
      upstreamProductId: 'upstream-cn',
      market: 'CN',
      createdAt: new Date('2026-01-01T00:00:01.000Z'),
    });
    const fallback = route({ id: 'route-default' });
    const { service } = buildService([scoped, fallback]);

    const selected = await service.resolveRoute({
      planId: 'plan-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
    });

    expect(selected.id).toBe('route-default');
  });

  it('prefers a matching scoped route over a default route at the same priority', async () => {
    const fallback = route({ id: 'route-default', upstreamProductId: 'upstream-default' });
    const usdRoute = route({
      id: 'route-usd',
      upstreamProductId: 'upstream-usd',
      currency: 'usd',
      createdAt: new Date('2026-01-01T00:00:01.000Z'),
    });
    const { service } = buildService([fallback, usdRoute]);

    const selected = await service.resolveRoute({
      planId: 'plan-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      currency: 'USD',
    });

    expect(selected.id).toBe('route-usd');
  });

  it('rejects same-priority routes with the same matching specificity', async () => {
    const usdRoute = route({ id: 'route-usd', currency: 'usd' });
    const marketRoute = route({
      id: 'route-global',
      market: 'global',
      createdAt: new Date('2026-01-01T00:00:01.000Z'),
    });
    const { service } = buildService([usdRoute, marketRoute]);

    await expect(service.resolveRoute({
      planId: 'plan-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      currency: 'usd',
      market: 'global',
    })).rejects.toThrow(BadRequestException);
  });

  it('returns the same priority and specificity route group for multi-line fulfillment', async () => {
    const anthropicRoute = route({ id: 'route-anthropic', providerLineId: 'line-anthropic' });
    const openaiRoute = route({
      id: 'route-openai',
      providerLineId: 'line-openai',
      createdAt: new Date('2026-01-01T00:00:01.000Z'),
    });
    const fallbackRoute = route({
      id: 'route-fallback',
      providerLineId: 'line-fallback',
      priority: 200,
      createdAt: new Date('2026-01-01T00:00:02.000Z'),
    });
    const { service } = buildService([anthropicRoute, openaiRoute, fallbackRoute]);

    const selected = await service.resolveRoutes({
      planId: 'plan-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
    });

    expect(selected.map((item) => item.id)).toEqual(['route-anthropic', 'route-openai']);
  });

  it('rejects route groups with different matching dimensions', async () => {
    const usdRoute = route({ id: 'route-usd', currency: 'usd' });
    const marketRoute = route({
      id: 'route-global',
      market: 'global',
      createdAt: new Date('2026-01-01T00:00:01.000Z'),
    });
    const { service } = buildService([usdRoute, marketRoute]);

    await expect(service.resolveRoutes({
      planId: 'plan-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      currency: 'usd',
      market: 'global',
    })).rejects.toThrow(BadRequestException);
  });

  it('derives user segment membership for route matching', async () => {
    const fallback = route({ id: 'route-default', upstreamProductId: 'upstream-default' });
    const segmentRoute = route({
      id: 'route-vip',
      upstreamProductId: 'upstream-vip',
      userSegmentId: 'seg-vip',
      createdAt: new Date('2026-01-01T00:00:01.000Z'),
    });
    const { service, prisma } = buildService([fallback, segmentRoute]);
    prisma.userSegmentMember.findMany.mockResolvedValueOnce([{ segmentId: 'seg-vip' }]);

    const selected = await service.resolveRoute({
      planId: 'plan-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
    });

    expect(prisma.userSegmentMember.findMany).toHaveBeenCalledWith({
      where: {
        userId: 'user-1',
        segment: {
          isActive: true,
          deletedAt: null,
        },
      },
      select: { segmentId: true },
    });
    expect(selected.id).toBe('route-vip');
  });
});
