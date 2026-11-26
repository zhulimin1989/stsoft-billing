import { PrismaClient, ProductBillingMode } from '@prisma/client';

const prisma = new PrismaClient();

type LegacyResaleConfig = {
  lineCode: 'zhipu_overseas' | 'zhipu_cn';
  upstreamProductId: string;
};

async function main() {
  const plans = await prisma.plan.findMany({
    where: {
      product: { billingMode: ProductBillingMode.CODING_PLAN },
      deletedAt: null,
    },
    select: { id: true, name: true, features: true },
  });

  let created = 0;
  let skipped = 0;
  for (const plan of plans) {
    const legacy = parseLegacyResaleConfig(plan.features);
    if (!legacy) continue;
    const line = await prisma.codingPlanProviderLine.findUnique({
      where: { code: legacy.lineCode },
      select: { id: true, code: true },
    });
    if (!line) {
      console.warn(`skip plan=${plan.id} missing provider line code=${legacy.lineCode}`);
      skipped += 1;
      continue;
    }

    const existing = await prisma.codingPlanResaleRoute.findFirst({
      where: {
        planId: plan.id,
        providerLineId: line.id,
        upstreamProductId: legacy.upstreamProductId,
      },
      select: { id: true },
    });
    if (existing) {
      skipped += 1;
      continue;
    }

    await prisma.codingPlanResaleRoute.create({
      data: {
        planId: plan.id,
        providerLineId: line.id,
        upstreamProductId: legacy.upstreamProductId,
        fulfillmentMethod: 'create_order',
        enabled: true,
        priority: 100,
        metadata: {
          migratedFrom: 'plan.features',
          migratedAt: new Date().toISOString(),
        },
      },
    });
    created += 1;
    console.log(`created route plan=${plan.id} line=${line.code} upstreamProduct=${legacy.upstreamProductId}`);
  }

  console.log(`done created=${created} skipped=${skipped}`);
}

function parseLegacyResaleConfig(features: string): LegacyResaleConfig | null {
  let markers: string[] = [];
  try {
    const parsed = JSON.parse(features);
    markers = Array.isArray(parsed)
      ? parsed.filter((item): item is string => typeof item === 'string').map((item) => item.trim())
      : [];
  } catch {
    return null;
  }

  const profile = markers
    .map((marker) => marker.match(/^provider_resale:(zhipu_overseas|zhipu_cn)$/i)?.[1]?.toLowerCase())
    .find((value): value is LegacyResaleConfig['lineCode'] => (
      value === 'zhipu_overseas' || value === 'zhipu_cn'
    ));
  if (!profile) return null;

  for (const marker of markers) {
    const match = marker.match(/^provider_product:(zhipu_overseas|zhipu_cn):(.+)$/i)
      ?? marker.match(/^upstream_product:(zhipu_overseas|zhipu_cn):(.+)$/i);
    if (!match || match[1].toLowerCase() !== profile) continue;
    return {
      lineCode: profile,
      upstreamProductId: decodeMarkerValue(match[2]),
    };
  }
  console.warn(`skip provider resale marker without upstream product profile=${profile}`);
  return null;
}

function decodeMarkerValue(value: string): string {
  try {
    return decodeURIComponent(value).trim();
  } catch {
    return value.trim();
  }
}

main()
  .catch((error) => {
    console.error(error);
    process.exitCode = 1;
  })
  .finally(async () => {
    await prisma.$disconnect();
  });
