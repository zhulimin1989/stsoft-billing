import { BadRequestException, Injectable } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';

export type CodingPlanResaleRouteSelection = Prisma.CodingPlanResaleRouteGetPayload<{
  include: { providerLine: true };
}>;

export type ResolveCodingPlanResaleRouteInput = {
  planId: string;
  userId: string;
  tenantId: string;
  market?: string | null;
  currency?: string | null;
  salesChannel?: string | null;
  userSegmentId?: string | null;
  userSegmentIds?: string[] | null;
};

type ResaleRouteMatchContext = {
  market: string | null;
  currency: string | null;
  salesChannel: string | null;
  userSegmentIds: Set<string>;
};

type MatchedResaleRoute = {
  route: CodingPlanResaleRouteSelection;
  specificity: number;
};

@Injectable()
export class CodingPlanResaleRouteService {
  constructor(private readonly prisma: PrismaService) {}

  async hasEnabledRouteForPlan(planId: string): Promise<boolean> {
    const normalizedPlanId = planId.trim();
    if (!normalizedPlanId) return false;
    const now = new Date();
    const count = await this.prisma.codingPlanResaleRoute.count({
      where: {
        planId: normalizedPlanId,
        enabled: true,
        OR: [{ startAt: null }, { startAt: { lte: now } }],
        AND: [{ OR: [{ endAt: null }, { endAt: { gt: now } }] }],
      },
    });
    return count > 0;
  }

  async findRoute(
    input: ResolveCodingPlanResaleRouteInput,
  ): Promise<CodingPlanResaleRouteSelection | null> {
    const routes = await this.findMatchingRoutes(input);
    return routes[0] ?? null;
  }

  async resolveRoute(
    input: ResolveCodingPlanResaleRouteInput,
  ): Promise<CodingPlanResaleRouteSelection> {
    const matched = await this.findMatchingRouteCandidates(input);
    if (matched.length === 0) {
      throw new BadRequestException('当前套餐没有可用供应商转售线路');
    }
    if (
      matched.length > 1
      && matched[0].route.priority === matched[1].route.priority
      && matched[0].specificity === matched[1].specificity
    ) {
      throw new BadRequestException('供应商转售线路配置冲突，请运营检查 priority 和维度');
    }
    return matched[0].route;
  }

  async resolveRoutes(
    input: ResolveCodingPlanResaleRouteInput,
  ): Promise<CodingPlanResaleRouteSelection[]> {
    const matched = await this.findMatchingRouteCandidates(input);
    if (matched.length === 0) {
      throw new BadRequestException('当前套餐没有可用供应商转售线路');
    }
    const first = matched[0];
    const group = matched.filter((item) =>
      item.route.priority === first.route.priority
      && item.specificity === first.specificity);
    if (group.some((item) => !this.sameRouteDimensions(item.route, first.route))) {
      throw new BadRequestException('供应商转售线路配置冲突，请运营检查 priority 和维度');
    }
    return group.map(({ route }) => route);
  }

  private async findMatchingRoutes(
    input: ResolveCodingPlanResaleRouteInput,
  ): Promise<CodingPlanResaleRouteSelection[]> {
    return (await this.findMatchingRouteCandidates(input)).map(({ route }) => route);
  }

  private async findMatchingRouteCandidates(
    input: ResolveCodingPlanResaleRouteInput,
  ): Promise<MatchedResaleRoute[]> {
    const now = new Date();
    const routes = await this.prisma.codingPlanResaleRoute.findMany({
      where: {
        planId: input.planId,
        enabled: true,
        OR: [{ startAt: null }, { startAt: { lte: now } }],
        AND: [{ OR: [{ endAt: null }, { endAt: { gt: now } }] }],
      },
      include: { providerLine: true },
      orderBy: [
        { priority: 'asc' },
        { createdAt: 'asc' },
      ],
    });

    const context = await this.resolveMatchContext(input, routes);
    const matched = routes
      .filter((route) => route.providerLine.salesEnabled && this.routeMatches(route, context))
      .map((route) => ({ route, specificity: this.routeSpecificity(route) }))
      .sort((a, b) =>
        a.route.priority - b.route.priority
        || b.specificity - a.specificity
        || this.routeCreatedAtMs(a.route) - this.routeCreatedAtMs(b.route)
        || a.route.id.localeCompare(b.route.id),
      );
    return matched;
  }

  private async resolveMatchContext(
    input: ResolveCodingPlanResaleRouteInput,
    routes: CodingPlanResaleRouteSelection[],
  ): Promise<ResaleRouteMatchContext> {
    const userSegmentIds = new Set<string>([
      ...this.normalizedTextList(input.userSegmentIds),
      ...this.normalizedTextList([input.userSegmentId]),
    ]);
    if (routes.some((route) => this.normalizedText(route.userSegmentId))) {
      const memberships = await this.prisma.userSegmentMember.findMany({
        where: {
          userId: input.userId,
          segment: {
            isActive: true,
            deletedAt: null,
          },
        },
        select: { segmentId: true },
      });
      for (const membership of memberships) {
        const segmentId = this.normalizedText(membership.segmentId);
        if (segmentId) userSegmentIds.add(segmentId);
      }
    }

    return {
      market: this.normalizedText(input.market),
      currency: this.normalizedText(input.currency)?.toLowerCase() ?? null,
      salesChannel: this.normalizedText(input.salesChannel),
      userSegmentIds,
    };
  }

  private routeMatches(
    route: CodingPlanResaleRouteSelection,
    context: ResaleRouteMatchContext,
  ): boolean {
    if (!this.textDimensionMatches(route.market, context.market)) return false;
    if (!this.textDimensionMatches(route.currency, context.currency, { caseInsensitive: true })) return false;
    if (!this.textDimensionMatches(route.salesChannel, context.salesChannel)) return false;
    const userSegmentId = this.normalizedText(route.userSegmentId);
    if (userSegmentId && !context.userSegmentIds.has(userSegmentId)) return false;
    return true;
  }

  private textDimensionMatches(
    routeValue: string | null,
    contextValue: string | null,
    options: { caseInsensitive?: boolean } = {},
  ): boolean {
    const routeText = this.normalizedText(routeValue);
    if (!routeText) return true;
    const contextText = this.normalizedText(contextValue);
    if (!contextText) return false;
    return options.caseInsensitive
      ? routeText.toLowerCase() === contextText.toLowerCase()
      : routeText === contextText;
  }

  private routeSpecificity(route: CodingPlanResaleRouteSelection): number {
    return [
      route.market,
      route.currency,
      route.salesChannel,
      route.userSegmentId,
    ].filter((value) => this.normalizedText(value)).length;
  }

  private sameRouteDimensions(
    left: CodingPlanResaleRouteSelection,
    right: CodingPlanResaleRouteSelection,
  ): boolean {
    return this.normalizedText(left.market) === this.normalizedText(right.market)
      && this.normalizedText(left.currency)?.toLowerCase() === this.normalizedText(right.currency)?.toLowerCase()
      && this.normalizedText(left.salesChannel) === this.normalizedText(right.salesChannel)
      && this.normalizedText(left.userSegmentId) === this.normalizedText(right.userSegmentId);
  }

  private routeCreatedAtMs(route: CodingPlanResaleRouteSelection): number {
    const value = route.createdAt instanceof Date
      ? route.createdAt.getTime()
      : new Date(route.createdAt).getTime();
    return Number.isFinite(value) ? value : 0;
  }

  private normalizedText(value: unknown): string | null {
    if (value === undefined || value === null) return null;
    const text = String(value).trim();
    return text.length > 0 ? text : null;
  }

  private normalizedTextList(value: Array<string | null | undefined> | null | undefined): string[] {
    if (!Array.isArray(value)) return [];
    return value
      .map((item) => this.normalizedText(item))
      .filter((item): item is string => Boolean(item));
  }
}
