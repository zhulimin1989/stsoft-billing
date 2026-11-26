import { PrismaClient } from '@prisma/client';

const p = new PrismaClient();
const ACCOUNT = '6ad5ab22-add8-48d4-87f8-295781d4ca8d';
const start = new Date('2026-09-30T16:00:00.000Z');
const end = new Date('2026-10-31T16:00:00.000Z');

async function main() {
  const tenant = await p.tenant.findFirst({
    where: { billingAccountId: ACCOUNT },
    select: { id: true },
  });
  if (!tenant) throw new Error('no tenant');

  const col = await p.$queryRawUnsafe<Array<{ data_type: string; udt_name: string }>>(`
    SELECT data_type, udt_name
    FROM information_schema.columns
    WHERE table_name = 'token_usage' AND column_name = 'created_at'
  `);

  const bounds = await p.$queryRawUnsafe<Array<Record<string, unknown>>>(`
    SELECT
      MIN(created_at) AS min_at,
      MAX(created_at) AS max_at,
      COUNT(*) FILTER (WHERE created_at >= $2::timestamptz AND created_at < $3::timestamptz) AS n_tstz,
      COUNT(*) FILTER (WHERE created_at >= ($2::timestamptz AT TIME ZONE 'UTC') AND created_at < ($3::timestamptz AT TIME ZONE 'UTC')) AS n_utc_ts,
      COUNT(*) FILTER (WHERE created_at >= ($2::timestamptz AT TIME ZONE 'Asia/Shanghai') AND created_at < ($3::timestamptz AT TIME ZONE 'Asia/Shanghai')) AS n_sh_ts,
      current_setting('TIMEZONE') AS tz
    FROM token_usage
    WHERE tenant_id = $1
  `, tenant.id, start, end);

  // Rows Prisma includes but tagged SQL excludes (approx via id lists near boundaries)
  const prismaNearStart = await p.tokenUsage.findMany({
    where: {
      tenantId: tenant.id,
      createdAt: { gte: start, lt: new Date(start.getTime() + 24 * 3600 * 1000) },
    },
    select: { id: true, createdAt: true },
    orderBy: { createdAt: 'asc' },
    take: 5,
  });
  const prismaNearEnd = await p.tokenUsage.findMany({
    where: {
      tenantId: tenant.id,
      createdAt: { gte: new Date(end.getTime() - 24 * 3600 * 1000), lt: end },
    },
    select: { id: true, createdAt: true },
    orderBy: { createdAt: 'desc' },
    take: 5,
  });

  const sqlNear = await p.$queryRawUnsafe<Array<{ id: string; created_at: Date; in_range: boolean }>>(`
    SELECT id, created_at,
      (created_at >= $2::timestamptz AND created_at < $3::timestamptz) AS in_range
    FROM token_usage
    WHERE tenant_id = $1
      AND created_at >= $2::timestamptz - interval '1 day'
      AND created_at < $3::timestamptz + interval '1 day'
    ORDER BY created_at
    LIMIT 20
  `, tenant.id, start, end);

  console.log(JSON.stringify({
    col,
    bounds: bounds.map((b) => ({
      ...b,
      n_tstz: Number(b.n_tstz as bigint),
      n_utc_ts: Number(b.n_utc_ts as bigint),
      n_sh_ts: Number(b.n_sh_ts as bigint),
    })),
    prismaNearStart,
    prismaNearEnd,
    sqlNearSample: sqlNear.slice(0, 10),
  }, null, 2));
  await p.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await p.$disconnect();
  process.exit(1);
});
