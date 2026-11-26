import { BillingRepository } from './billing.repository';

function sqlText(query: unknown): string {
  const sql = query as { sql?: string; text?: string; strings?: string[] };
  return sql.sql ?? sql.text ?? sql.strings?.join('') ?? '';
}

describe('BillingRepository token usage date grouping', () => {
  it('groups UTC token usage timestamps by Asia/Shanghai calendar date', async () => {
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const repository = new BillingRepository(prisma);

    await repository.aggregateTokenUsageSummary(
      {
        userId: 'user-1',
        tenantId: 'tenant-1',
        createdAt: {
          gte: new Date('2026-06-16T00:00:00.000Z'),
          lt: new Date('2026-06-24T00:00:00.000Z'),
        },
      },
      1,
      20,
    );

    expect(sqlText(prisma.$queryRaw.mock.calls[0][0])).toContain(
      `tu."created_at" AT TIME ZONE 'UTC' AT TIME ZONE 'Asia/Shanghai'`,
    );
    const sql = sqlText(prisma.$queryRaw.mock.calls[0][0]);
    expect(sql).toContain('scoped_usage AS MATERIALIZED');
    expect(sql).toContain('tu.cached_input_tokens');
    expect(sql).toContain('tu.cache_write_input_tokens');
    expect(sql).toContain('JOIN scoped_usage scoped ON scoped.id = bca.token_usage_id');
    expect(sql.indexOf('WHERE ak.tenant_id')).toBeLessThan(sql.indexOf('allocation_totals AS'));
  });

  it('aggregates monthly bill periods inside the scoped database query', async () => {
    const prisma: any = {
      $queryRaw: jest.fn().mockResolvedValue([{
        period: '2026-06',
        calls: 3n,
        totalTokens: 420n,
        costUsd: '0.42',
        paymentDeductionUsd: '0.40',
        voucherDeductionUsd: '0.02',
      }]),
    };
    const repository = new BillingRepository(prisma);

    const result = await repository.aggregateTokenUsagePeriodSummary(
      { userId: 'user-1', tenantId: 'tenant-1' },
      'month',
    );

    const sql = sqlText(prisma.$queryRaw.mock.calls[0][0]);
    expect(sql).toContain("TO_CHAR(");
    expect(sql).toContain("'YYYY-MM'");
    expect(sql).toContain('GROUP BY');
    expect(sql).toContain('scoped_usage AS MATERIALIZED');
    expect(result[0]).toMatchObject({ period: '2026-06', calls: 3, totalTokens: 420 });
  });

  it('aggregates API-key daily billing from pre-aggregated allocation and credit ledgers', async () => {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([]),
    };
    const repository = new BillingRepository(prisma as never);

    await repository.dailyActualUsageFunding({
      userId: 'member-1',
      tenantId: 'tenant-1',
      apiKeyUserId: 'member-1',
      apiKeyId: 'key-1',
      productId: 'product-1',
      createdAt: {
        gte: new Date('2026-07-01T00:00:00.000Z'),
        lt: new Date('2026-07-02T00:00:00.000Z'),
      },
    });

    const sql = sqlText(prisma.$queryRaw.mock.calls[0][0]);
    expect(sql).toContain('allocation_totals AS');
    expect(sql).toContain('credit_totals AS');
    expect(sql).toContain('GROUP BY bca."token_usage_id"');
    expect(sql).toContain('GROUP BY scoped."id"');
    expect(sql).toContain('ct."request_id" = scoped."requestId"');
    expect(sql).toContain('bca."user_id" = scoped."actorUserId"');
    expect(sql).toContain('ct."user_id" = scoped."actorUserId"');
    expect(sql).toContain('tu.tenant_id =');
    expect(sql).not.toContain('cost_usd');
  });
});
