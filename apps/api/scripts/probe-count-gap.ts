import { PrismaClient } from '@prisma/client';

const p = new PrismaClient();
const ACCOUNT = '6ad5ab22-add8-48d4-87f8-295781d4ca8d';
const start = new Date('2026-09-30T16:00:00.000Z');
const end = new Date('2026-10-31T16:00:00.000Z');

async function main() {
  const tenants = await p.tenant.findMany({
    where: { billingAccountId: ACCOUNT },
    select: { id: true },
  });
  const sql = await p.$queryRawUnsafe<Array<{ n_usage: bigint; n_tenants: bigint }>>(`
    SELECT COUNT(*)::bigint AS n_usage,
           COUNT(DISTINCT tu.tenant_id)::bigint AS n_tenants
    FROM token_usage tu
    JOIN tenants t ON t.id = tu.tenant_id
    WHERE t.billing_account_id = $1 AND tu.created_at >= $2 AND tu.created_at < $3
  `, ACCOUNT, start, end);
  let prismaUsage = 0;
  for (const t of tenants) {
    prismaUsage += await p.tokenUsage.count({
      where: { tenantId: t.id, createdAt: { gte: start, lt: end } },
    });
  }
  const sqlTenantCount = await p.$queryRawUnsafe<Array<{ n: bigint }>>(`
    SELECT COUNT(*)::bigint AS n FROM tenants WHERE billing_account_id = $1
  `, ACCOUNT);

  // Same count with Prisma tagged template (how summary SQL binds dates)
  const tagged = await p.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*)::bigint AS n
    FROM token_usage tu
    JOIN tenants t ON t.id = tu.tenant_id
    WHERE t.billing_account_id = ${ACCOUNT}
      AND tu.created_at >= ${start}
      AND tu.created_at < ${end}
  `;

  console.log(JSON.stringify({
    prismaTenants: tenants.length,
    sqlTenants: Number(sqlTenantCount[0]!.n),
    sqlUsage: Number(sql[0]!.n_usage),
    sqlDistinctTenantsWithUsage: Number(sql[0]!.n_tenants),
    prismaUsage,
    taggedUsage: Number(tagged[0]!.n),
    start: start.toISOString(),
    end: end.toISOString(),
  }, null, 2));
  await p.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await p.$disconnect();
  process.exit(1);
});
