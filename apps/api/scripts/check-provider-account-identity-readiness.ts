import { NestFactory } from '@nestjs/core';
import {
  CodingPlanFulfillmentMode,
  CodingPlanProviderEntitlementStatus,
  ProductBillingMode,
} from '@prisma/client';
import { PrismaService } from '../src/prisma/prisma.service';
import { ProviderAccountReadinessModule } from '../src/provider-account-identity/provider-account-readiness.module';
import { requireBillingDatabaseUrl } from '../src/prisma/prisma.service';
import {
  DEDICATED_PROVIDER_ACCOUNT_SOURCE_SELECT,
  DEDICATED_PROVIDER_LINE_ACCOUNT_SOURCE_SELECT,
  PROVIDER_RESALE_ROUTE_LINE_IDENTITY_SELECT,
  resolveDedicatedProviderCode,
  validateDedicatedProviderAccountIdentityInheritance,
  validateProviderAccountIdentityForProvider,
  validateProviderResaleRouteGroupAccountIdentity,
} from '../src/provider-account-identity/provider-account-identity.policy';
import { PublisherSyncService } from '../src/publisher/publisher-sync.service';

type ReadinessIssue = {
  scope:
    | 'runtime_intent'
    | 'coding_plan_provider_line'
    | 'coding_plan_provider_entitlement'
    | 'coding_plan_resale_route_group';
  id: string;
  provider?: string;
  message: string;
};

export async function main(): Promise<void> {
  // Resolve the authority before Nest/Prisma is initialized. Readiness must not
  // become a false positive by inspecting the admin/control-plane database.
  process.env.BILLING_DATABASE_URL = requireBillingDatabaseUrl();
  process.env.RUIDONG_SERVICE = 'billing';

  const app = await NestFactory.createApplicationContext(ProviderAccountReadinessModule, {
    logger: ['error', 'warn'],
  });
  try {
    const report = await evaluateProviderAccountReadiness(
      app.get(PrismaService),
      app.get(PublisherSyncService),
    );
    console.log(JSON.stringify(report, null, 2));
    if (!report.ready) process.exitCode = 1;
  } finally {
    await app.close();
  }
}

export async function evaluateProviderAccountReadiness(
  prisma: PrismaService,
  publisherSync: Pick<PublisherSyncService, 'buildRuntimeIntent'>,
  now: Date = new Date(),
) {
  const issues: ReadinessIssue[] = [];
  let runtimeIntentSummary: Record<string, number | boolean> = {
    valid: false,
    providerCredentials: 0,
    providerAccountRefs: 0,
  };
  try {
    // This is deliberately the production builder, not a second approximation
    // of route participation. It performs local contract validation and never
    // sends a request to Publisher.
    const intent = await publisherSync.buildRuntimeIntent();
    const refs = new Set(
      (intent.provider_credentials ?? [])
        .map((credential) => credential.provider_account_ref)
        .filter((ref): ref is string => typeof ref === 'string' && ref.length > 0),
    );
    runtimeIntentSummary = {
      valid: true,
      providerCredentials: intent.provider_credentials?.length ?? 0,
      providerAccountRefs: refs.size,
    };
  } catch (error) {
    issues.push({
      scope: 'runtime_intent',
      id: 'current-source-of-truth',
      message: error instanceof Error ? error.message : String(error),
    });
  }

  const currentResaleRoutes = await prisma.codingPlanResaleRoute.findMany({
    where: {
      enabled: true,
      OR: [{ startAt: null }, { startAt: { lte: now } }],
      AND: [{ OR: [{ endAt: null }, { endAt: { gt: now } }] }],
      plan: {
        isActive: true,
        product: {
          deletedAt: null,
          isActive: true,
          billingMode: ProductBillingMode.CODING_PLAN,
          codingPlanFulfillmentMode: CodingPlanFulfillmentMode.provider_resale,
        },
      },
      providerLine: {
        salesEnabled: true,
        fulfillmentEnabled: true,
      },
    },
    orderBy: [
      { planId: 'asc' },
      { priority: 'asc' },
      { createdAt: 'asc' },
      { id: 'asc' },
    ],
    select: {
      id: true,
      planId: true,
      priority: true,
      market: true,
      currency: true,
      salesChannel: true,
      userSegmentId: true,
      providerLine: {
        select: PROVIDER_RESALE_ROUTE_LINE_IDENTITY_SELECT,
      },
    },
  });
  const resaleRouteGroups = new Map<string, typeof currentResaleRoutes>();
  for (const route of currentResaleRoutes) {
    const normalized = (value: unknown, caseInsensitive = false) => {
      const text = typeof value === 'string' ? value.trim() : '';
      return caseInsensitive ? text.toLowerCase() : text;
    };
    const key = JSON.stringify([
      route.planId,
      route.priority,
      normalized(route.market),
      normalized(route.currency, true),
      normalized(route.salesChannel),
      normalized(route.userSegmentId),
    ]);
    const group = resaleRouteGroups.get(key) ?? [];
    group.push(route);
    resaleRouteGroups.set(key, group);
  }
  let readyResaleRouteGroups = 0;
  for (const routes of resaleRouteGroups.values()) {
    try {
      validateProviderResaleRouteGroupAccountIdentity(
        routes.map((route) => route.providerLine),
        { requireIdentity: true },
      );
      readyResaleRouteGroups += 1;
    } catch (error) {
      issues.push({
        scope: 'coding_plan_resale_route_group',
        id: `${routes[0].planId}:${routes.map((route) => route.id).join(',')}`,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const providerLines = await prisma.codingPlanProviderLine.findMany({
    where: { fulfillmentEnabled: true },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      ...DEDICATED_PROVIDER_LINE_ACCOUNT_SOURCE_SELECT,
    },
  });
  let readyProviderLines = 0;
  for (const providerLine of providerLines) {
    let provider: string | undefined;
    try {
      provider = resolveDedicatedProviderCode({ providerLine });
      validateProviderAccountIdentityForProvider(
        providerLine.providerAccountIdentity,
        provider,
        {
          forbiddenValues: [
            providerLine.id,
            providerLine.providerCode,
            providerLine.apiBaseUrl,
            providerLine.partnerCodeEncrypted,
            providerLine.partnerSecretEncrypted,
          ],
        },
      );
      readyProviderLines += 1;
    } catch (error) {
      issues.push({
        scope: 'coding_plan_provider_line',
        id: providerLine.id,
        provider,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  const providerEntitlements = await prisma.codingPlanProviderEntitlement.findMany({
    where: {
      status: CodingPlanProviderEntitlementStatus.ACTIVE,
      OR: [{ productEndTime: null }, { productEndTime: { gt: now } }],
    },
    orderBy: { id: 'asc' },
    select: {
      id: true,
      ...DEDICATED_PROVIDER_ACCOUNT_SOURCE_SELECT,
      upstreamApiKeyEncrypted: true,
      upstreamSecretKeyEncrypted: true,
    },
  });
  let readyProviderEntitlements = 0;
  for (const entitlement of providerEntitlements) {
    let provider: string | undefined;
    try {
      provider = resolveDedicatedProviderCode(entitlement);
      if (!entitlement.upstreamApiKeyEncrypted || !entitlement.upstreamSecretKeyEncrypted) {
        throw new Error('ACTIVE Provider Entitlement 的上游凭据不完整');
      }
      validateDedicatedProviderAccountIdentityInheritance(entitlement);
      validateProviderAccountIdentityForProvider(
        entitlement.providerAccountIdentity,
        provider,
        {
          forbiddenValues: [
            entitlement.id,
            entitlement.upstreamApiKeyEncrypted,
            entitlement.upstreamSecretKeyEncrypted,
          ],
        },
      );
      readyProviderEntitlements += 1;
    } catch (error) {
      issues.push({
        scope: 'coding_plan_provider_entitlement',
        id: entitlement.id,
        provider,
        message: error instanceof Error ? error.message : String(error),
      });
    }
  }

  return {
    ready: issues.length === 0,
    checkedAt: now.toISOString(),
    runtimeIntent: runtimeIntentSummary,
    codingPlanProviderLines: {
      scanned: providerLines.length,
      ready: readyProviderLines,
    },
    codingPlanResaleRouteGroups: {
      scanned: resaleRouteGroups.size,
      ready: readyResaleRouteGroups,
    },
    codingPlanProviderEntitlements: {
      scanned: providerEntitlements.length,
      ready: readyProviderEntitlements,
    },
    issues,
  };
}

if (require.main === module) {
  void main().catch((error) => {
    console.error(error instanceof Error ? error.message : String(error));
    process.exitCode = 1;
  });
}
