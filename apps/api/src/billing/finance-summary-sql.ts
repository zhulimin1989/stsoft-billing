import { randomUUID } from 'node:crypto';
import { Prisma } from '@prisma/client';

type FinanceSummarySqlClient = Pick<
  Prisma.TransactionClient,
  '$executeRaw' | '$queryRaw'
>;

export type FinanceSummarySqlFact = {
  groupKey: string;
  resultSortKey: string;
  dimensionOrder: string;
  dimensions: Record<string, unknown>;
  sums: Record<string, string | null>;
  rawUsdKeys: readonly string[];
  distinctKey?: string | null;
};

export type FinanceSummarySqlRow = {
  seq: bigint;
  groupKey: string;
  dimensions: Record<string, unknown>;
  sums: Record<string, string | null>;
  rawUsdKeys: Record<string, boolean>;
  rowCount: bigint;
  distinctCount: bigint;
};

export class FinanceSqlPagedResult<Row extends { seq: bigint }> {
  private readonly table: string;
  private initialized = false;

  constructor(private readonly db: FinanceSummarySqlClient) {
    this.table = `finance_paged_result_${randomUUID().replaceAll('-', '')}`;
  }

  async materialize(query: Prisma.Sql, orderColumns: readonly string[]): Promise<void> {
    for (const column of orderColumns) {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(column)) {
        throw new Error(`Invalid finance SQL order column: ${column}`);
      }
    }
    const orderBy = Prisma.join(
      orderColumns.map((column) => Prisma.sql`source.${Prisma.raw(`"${column}"`)}`),
    );
    await this.db.$executeRaw(Prisma.sql`
      CREATE TEMP TABLE ${Prisma.raw(this.table)} ON COMMIT DROP AS
      SELECT
        row_number() OVER (ORDER BY ${orderBy})::bigint AS seq,
        source.*
      FROM (${query}) source
    `);
    await this.db.$executeRaw(Prisma.sql`
      CREATE UNIQUE INDEX ${Prisma.raw(`${this.table}_seq_idx`)}
      ON ${Prisma.raw(this.table)} (seq)
    `);
    this.initialized = true;
  }

  async count(): Promise<number> {
    const [row] = await this.db.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS count FROM ${Prisma.raw(this.table)}
    `);
    return Number(row?.count ?? 0n);
  }

  async *batches(pageSize: number): AsyncGenerator<Row[]> {
    let after = 0n;
    for (;;) {
      const rows = await this.db.$queryRaw<Row[]>(Prisma.sql`
        SELECT *
        FROM ${Prisma.raw(this.table)}
        WHERE seq > ${after}
        ORDER BY seq
        LIMIT ${pageSize}
      `);
      if (rows.length === 0) break;
      yield rows;
      after = rows.at(-1)!.seq;
    }
  }

  async dispose(): Promise<void> {
    if (!this.initialized) return;
    await this.db.$executeRaw(Prisma.sql`
      DROP TABLE IF EXISTS ${Prisma.raw(this.table)}
    `).catch(() => undefined);
  }
}

export class FinanceSummarySqlAggregator {
  private static readonly INSERT_BATCH_SIZE = 4_000;
  private readonly factsTable: string;
  private readonly resultsTable: string;
  private initialized = false;
  private finalized = false;

  constructor(
    private readonly db: FinanceSummarySqlClient,
    private readonly sumKeys: readonly string[],
  ) {
    for (const key of sumKeys) {
      if (!/^[A-Za-z][A-Za-z0-9_]*$/u.test(key)) {
        throw new Error(`Invalid finance summary SQL key: ${key}`);
      }
    }
    const suffix = randomUUID().replaceAll('-', '');
    this.factsTable = `finance_summary_facts_${suffix}`;
    this.resultsTable = `finance_summary_results_${suffix}`;
  }

  async initialize(): Promise<void> {
    if (this.initialized) return;
    await this.db.$executeRaw(Prisma.sql`
      CREATE TEMP TABLE ${Prisma.raw(this.factsTable)} (
        group_key TEXT NOT NULL,
        result_sort_key TEXT NOT NULL,
        dimension_order TEXT NOT NULL,
        dimensions JSONB NOT NULL,
        sums JSONB NOT NULL,
        raw_usd_keys JSONB NOT NULL,
        distinct_key TEXT NULL
      ) ON COMMIT DROP
    `);
    this.initialized = true;
  }

  async add(facts: readonly FinanceSummarySqlFact[]): Promise<void> {
    if (facts.length === 0) return;
    await this.initialize();
    for (let offset = 0; offset < facts.length; offset += FinanceSummarySqlAggregator.INSERT_BATCH_SIZE) {
      const values = facts
        .slice(offset, offset + FinanceSummarySqlAggregator.INSERT_BATCH_SIZE)
        .map((fact) => Prisma.sql`(
          ${fact.groupKey},
          ${fact.resultSortKey},
          ${fact.dimensionOrder},
          ${JSON.stringify(fact.dimensions)}::jsonb,
          ${JSON.stringify(fact.sums)}::jsonb,
          ${JSON.stringify(Object.fromEntries(fact.rawUsdKeys.map((key) => [key, true])))}::jsonb,
          ${fact.distinctKey ?? null}
        )`);
      await this.db.$executeRaw(Prisma.sql`
        INSERT INTO ${Prisma.raw(this.factsTable)} (
          group_key,
          result_sort_key,
          dimension_order,
          dimensions,
          sums,
          raw_usd_keys,
          distinct_key
        ) VALUES ${Prisma.join(values)}
      `);
    }
  }

  async finalize(): Promise<void> {
    if (this.finalized) return;
    await this.initialize();
    const sumPairs = this.sumKeys.flatMap((key) => [
      Prisma.sql`${key}`,
      Prisma.sql`
        CASE
          WHEN COUNT(NULLIF(sums ->> ${key}, '')) = 0 THEN NULL
          ELSE SUM((NULLIF(sums ->> ${key}, ''))::numeric)::text
        END
      `,
    ]);
    const rawKeyPairs = this.sumKeys.flatMap((key) => [
      Prisma.sql`${key}`,
      Prisma.sql`BOOL_OR(raw_usd_keys ? ${key})`,
    ]);
    const sums = sumPairs.length > 0
      ? Prisma.sql`jsonb_build_object(${Prisma.join(sumPairs)})`
      : Prisma.sql`'{}'::jsonb`;
    const rawUsdKeys = rawKeyPairs.length > 0
      ? Prisma.sql`jsonb_build_object(${Prisma.join(rawKeyPairs)})`
      : Prisma.sql`'{}'::jsonb`;
    await this.db.$executeRaw(Prisma.sql`
      CREATE TEMP TABLE ${Prisma.raw(this.resultsTable)} ON COMMIT DROP AS
      SELECT
        row_number() OVER (ORDER BY grouped.result_sort_key, grouped.group_key)::bigint AS seq,
        grouped.group_key,
        grouped.dimensions,
        grouped.sums,
        grouped.raw_usd_keys,
        grouped.row_count,
        grouped.distinct_count
      FROM (
        SELECT
          group_key,
          (array_agg(result_sort_key ORDER BY dimension_order))[1] AS result_sort_key,
          (array_agg(dimensions ORDER BY dimension_order))[1] AS dimensions,
          ${sums} AS sums,
          ${rawUsdKeys} AS raw_usd_keys,
          COUNT(*)::bigint AS row_count,
          COUNT(DISTINCT distinct_key)::bigint AS distinct_count
        FROM ${Prisma.raw(this.factsTable)}
        GROUP BY group_key
      ) grouped
    `);
    await this.db.$executeRaw(Prisma.sql`
      CREATE UNIQUE INDEX ${Prisma.raw(`${this.resultsTable}_seq_idx`)}
      ON ${Prisma.raw(this.resultsTable)} (seq)
    `);
    this.finalized = true;
  }

  async count(): Promise<number> {
    await this.finalize();
    const [row] = await this.db.$queryRaw<Array<{ count: bigint }>>(Prisma.sql`
      SELECT COUNT(*)::bigint AS count
      FROM ${Prisma.raw(this.resultsTable)}
    `);
    return Number(row?.count ?? 0n);
  }

  async *batches(pageSize: number): AsyncGenerator<FinanceSummarySqlRow[]> {
    await this.finalize();
    let after = 0n;
    for (;;) {
      const rows = await this.db.$queryRaw<FinanceSummarySqlRow[]>(Prisma.sql`
        SELECT
          seq,
          group_key AS "groupKey",
          dimensions,
          sums,
          raw_usd_keys AS "rawUsdKeys",
          row_count AS "rowCount",
          distinct_count AS "distinctCount"
        FROM ${Prisma.raw(this.resultsTable)}
        WHERE seq > ${after}
        ORDER BY seq
        LIMIT ${pageSize}
      `);
      if (rows.length === 0) break;
      yield rows;
      after = rows.at(-1)!.seq;
    }
  }

  async dispose(): Promise<void> {
    if (!this.initialized) return;
    await this.db.$executeRaw(Prisma.sql`
      DROP TABLE IF EXISTS ${Prisma.raw(this.resultsTable)}
    `).catch(() => undefined);
    await this.db.$executeRaw(Prisma.sql`
      DROP TABLE IF EXISTS ${Prisma.raw(this.factsTable)}
    `).catch(() => undefined);
  }
}
