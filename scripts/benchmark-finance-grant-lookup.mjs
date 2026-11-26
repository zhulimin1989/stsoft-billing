/*
 * Local-only benchmark for the finance grant transaction lookup.
 *
 * Usage (PowerShell, from the Billing repository root):
 *   $env:FINANCE_BENCH_ROWS='500000'
 *   node --env-file=.env scripts/benchmark-finance-grant-lookup.mjs
 *
 * The script creates a PostgreSQL temporary table inside one transaction. It
 * does not read or write application tables, and PostgreSQL drops the table
 * automatically when the connection closes.
 */

process.env.DATABASE_URL ||= process.env.BILLING_DATABASE_URL;
if (!process.env.DATABASE_URL) {
  throw new Error('DATABASE_URL or BILLING_DATABASE_URL is required');
}

const { PrismaClient } = await import('../apps/api/node_modules/@prisma/client/default.js');

const rowCount = Number.parseInt(process.env.FINANCE_BENCH_ROWS ?? '500000', 10);
if (!Number.isInteger(rowCount) || rowCount < 1000 || rowCount > 2_000_000) {
  throw new Error('FINANCE_BENCH_ROWS must be an integer between 1000 and 2000000');
}

const grantIds = Array.from({ length: 38 }, (_, index) => (
  `grant-${String(index + 1).padStart(2, '0')}`
));
const sqlLiteral = (value) => `'${value.replaceAll("'", "''")}'`;
const oldDescriptionPredicates = grantIds.flatMap((grantId) => [
  `description LIKE ${sqlLiteral(`%voucher:${grantId}%`)}`,
  `description LIKE ${sqlLiteral(`%balance grant expired:${grantId}%`)}`,
  `description LIKE ${sqlLiteral(`%${grantId}%`)}`,
]);
const matchingIds = grantIds.map((_, index) => index + 1);

function explainSummary(rows) {
  const value = rows[0]?.['QUERY PLAN'];
  const root = Array.isArray(value) ? value[0] : value;
  return {
    planningTimeMs: root?.['Planning Time'] ?? null,
    executionTimeMs: root?.['Execution Time'] ?? null,
    topNode: root?.Plan?.['Node Type'] ?? null,
    rows: root?.Plan?.['Actual Rows'] ?? null,
    sharedHitBlocks: root?.Plan?.['Shared Hit Blocks'] ?? null,
    sharedReadBlocks: root?.Plan?.['Shared Read Blocks'] ?? null,
  };
}

const prisma = new PrismaClient();
try {
  const result = await prisma.$transaction(async (db) => {
    await db.$executeRawUnsafe("SET LOCAL statement_timeout = '60000ms'");
    await db.$executeRawUnsafe(`
      CREATE TEMP TABLE finance_grant_lookup_bench (
        id BIGINT PRIMARY KEY,
        created_at TIMESTAMP(3) NOT NULL,
        description TEXT NOT NULL
      ) ON COMMIT DROP
    `);
    const insertStartedAt = performance.now();
    await db.$executeRawUnsafe(`
      INSERT INTO finance_grant_lookup_bench (id, created_at, description)
      SELECT
        value,
        TIMESTAMP '2026-09-01 00:00:00' + ((value % 2592000) * INTERVAL '1 second'),
        CASE
          WHEN value BETWEEN 1 AND 38
            THEN 'balance grant expired:grant-' || lpad(value::text, 2, '0')
          ELSE 'api usage transaction'
        END
      FROM generate_series(1, ${rowCount}) AS value
    `);
    await db.$executeRawUnsafe(`
      CREATE INDEX finance_grant_lookup_bench_created_id_idx
        ON finance_grant_lookup_bench (created_at, id)
    `);
    await db.$executeRawUnsafe('ANALYZE finance_grant_lookup_bench');
    const loadTimeMs = performance.now() - insertStartedAt;

    const exactRows = await db.$queryRawUnsafe(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT id, created_at, description
      FROM finance_grant_lookup_bench
      WHERE id IN (${matchingIds.join(',')})
        AND created_at >= TIMESTAMP '2026-09-01 00:00:00'
        AND created_at < TIMESTAMP '2026-10-01 00:00:00'
    `);
    const containsRows = await db.$queryRawUnsafe(`
      EXPLAIN (ANALYZE, BUFFERS, FORMAT JSON)
      SELECT id, created_at, description
      FROM finance_grant_lookup_bench
      WHERE created_at >= TIMESTAMP '2026-09-01 00:00:00'
        AND created_at < TIMESTAMP '2026-10-01 00:00:00'
        AND (${oldDescriptionPredicates.join(' OR ')})
    `);
    return {
      rowCount,
      grantCount: grantIds.length,
      oldContainsPredicateCount: oldDescriptionPredicates.length,
      loadTimeMs: Number(loadTimeMs.toFixed(3)),
      exactIdLookup: explainSummary(exactRows),
      oldDescriptionContainsLookup: explainSummary(containsRows),
    };
  }, { maxWait: 10_000, timeout: 120_000 });

  const exactMs = result.exactIdLookup.executionTimeMs;
  const containsMs = result.oldDescriptionContainsLookup.executionTimeMs;
  console.log(JSON.stringify({
    ...result,
    executionTimeRatio: exactMs && containsMs
      ? Number((containsMs / exactMs).toFixed(2))
      : null,
  }, null, 2));
} finally {
  await prisma.$disconnect();
}
