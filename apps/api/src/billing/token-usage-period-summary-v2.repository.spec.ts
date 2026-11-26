import { Prisma } from '@prisma/client';
import { TokenUsagePeriodSummaryV2Repository } from './token-usage-period-summary-v2.repository';

/**
 * 杩欎簺鏂█瀹堟姢鐨勬槸銆屾煡璇㈠湪鏁版嵁搴撲晶鐨勫彲鎺ф€с€嶏紝鑰屼笉鏄?SQL 鏂囨湰鏈韩锛?
 * - 蹇呴』鍏堟妸 statement_timeout / work_mem 钀藉埌褰撳墠浜嬪姟锛屽啀鍙戣仛鍚堟煡璇?
 *   锛堥『搴忛敊浜嗗氨鍙槸鎶婂弬鏁扮暀鍦ㄤ簡鍒殑杩炴帴涓婏紝绛変簬娌¤锛夛紱
 * - work_mem 蹇呴』甯︿笂涓嬮檺锛岄伩鍏嶇幆澧冨彉閲忓啓閿欐妸鍗曡姹傚唴瀛橀《鐖嗐€?
 */
function buildRepository(tenantRows: Array<{ id: string }> = [{ id: 'tenant-1' }]) {
  const executed: string[] = [];
  const queries: unknown[] = [];
  const transactionOptions: Array<{ timeout?: number; maxWait?: number }> = [];
  const tenantLookups: string[] = [];
  const prisma = {
    $queryRaw: jest.fn(async (sql: unknown) => {
      tenantLookups.push(sqlText(sql));
      return tenantRows;
    }),
    $transaction: jest.fn(async (
      fn: (tx: unknown) => Promise<unknown>,
      options: { timeout?: number; maxWait?: number },
    ) => {
      transactionOptions.push(options);
      const tx = {
        $executeRawUnsafe: jest.fn(async (sql: string) => {
          executed.push(sql);
          return 0;
        }),
        $queryRaw: jest.fn(async (sql: unknown) => {
          queries.push(sql);
          return [
            {
              period: '2026-11',
              calls: BigInt(12),
              totalTokens: BigInt(5879),
              consumeUsd: new Prisma.Decimal('0.01'),
              accountPayUsd: new Prisma.Decimal('0'),
              voucherUsd: new Prisma.Decimal('0'),
            },
          ];
        }),
      };
      return fn(tx);
    }),
  };
  const repository = new TokenUsagePeriodSummaryV2Repository(prisma as never);
  return { repository, executed, queries, transactionOptions, tenantLookups, prisma };
}

const scope = { tenantId: 'tenant-1', billingAccountId: 'account-1', byBillingAccount: true };
const filters = {
  startInclusive: new Date('2026-05-31T16:00:00.000Z'),
  endExclusive: new Date('2026-11-30T16:00:00.000Z'),
};

/** `Prisma.Sql` 鐨勬枃鏈湪 `strings` 閲岋紱鍗犱綅绗︿綅缃敤 `?` 浠ｆ浛锛屼粎渚涚粨鏋勬柇瑷€銆?*/
function sqlText(query: unknown): string {
  const strings = (query as { strings?: string[] }).strings;
  return Array.isArray(strings) ? strings.join(' ? ') : String(query);
}

describe('TokenUsagePeriodSummaryV2Repository session settings', () => {
  const originalWorkMem = process.env.BILLING_TOKEN_USAGE_SUMMARY_V2_WORK_MEM_KB;

  afterEach(() => {
    if (originalWorkMem === undefined) delete process.env.BILLING_TOKEN_USAGE_SUMMARY_V2_WORK_MEM_KB;
    else process.env.BILLING_TOKEN_USAGE_SUMMARY_V2_WORK_MEM_KB = originalWorkMem;
  });

  it('sets statement_timeout and work_mem before running the aggregate query', async () => {
    const { repository, executed, queries } = buildRepository();

    await repository.aggregate(scope, filters, 'month');

    expect(executed).toHaveLength(2);
    expect(executed[0]).toContain('statement_timeout');
    expect(executed[1]).toBe('SET LOCAL work_mem = 262144');
    expect(queries).toHaveLength(1);
  });

  it('keeps the aggregate query inside the same interactive transaction', async () => {
    const { repository, prisma, transactionOptions } = buildRepository();

    await repository.aggregate(scope, filters, 'day');

    expect(prisma.$transaction).toHaveBeenCalledTimes(1);
    // Prisma 榛樿 5s锛屽繀椤绘斁瀹藉埌姣?statement_timeout(90s) 鏇村
    expect(transactionOptions[0]!.timeout).toBeGreaterThan(90_000);
  });

  it('falls back to the default when the env override is not a number', async () => {
    process.env.BILLING_TOKEN_USAGE_SUMMARY_V2_WORK_MEM_KB = 'not-a-number';
    const { repository, executed } = buildRepository();

    await repository.aggregate(scope, filters, 'month');

    expect(executed[1]).toBe('SET LOCAL work_mem = 262144');
  });

  it('clamps the env override into a safe range', async () => {
    process.env.BILLING_TOKEN_USAGE_SUMMARY_V2_WORK_MEM_KB = '1';
    const low = buildRepository();
    await low.repository.aggregate(scope, filters, 'month');
    expect(low.executed[1]).toBe('SET LOCAL work_mem = 4096');

    process.env.BILLING_TOKEN_USAGE_SUMMARY_V2_WORK_MEM_KB = String(64 * 1024 * 1024);
    const high = buildRepository();
    await high.repository.aggregate(scope, filters, 'month');
    expect(high.executed[1]).toBe('SET LOCAL work_mem = 1048576');
  });

  it('maps raw rows into decimal amounts without losing precision', async () => {
    const { repository } = buildRepository();

    const [row] = await repository.aggregate(scope, filters, 'month');

    expect(row).toEqual({
      period: '2026-11',
      calls: 12,
      totalTokens: 5879,
      consumeUsd: new Prisma.Decimal('0.01'),
      accountPayUsd: new Prisma.Decimal('0'),
      voucherUsd: new Prisma.Decimal('0'),
    });
  });

  it('filters enterprise usage by resolved tenant ids instead of joining tenants', async () => {
    const { repository, tenantLookups } = buildRepository([{ id: 'tenant-1' }, { id: 'tenant-2' }]);

    await repository.aggregate(scope, filters, 'month');

    // 蹇呴』鍏堟妸璐︽埛瑙ｆ瀽鎴?tenant 鍒楄〃
    expect(tenantLookups).toHaveLength(1);
    expect(tenantLookups[0]).toContain('billing_account_id');

    const sql = sqlText(repository['buildMonthlyQuery'](['tenant-1', 'tenant-2'], filters));
    // 鍏抽敭锛氫笉鍐?JOIN tenants锛堝惁鍒欎紭鍖栧櫒鎷夸笉鍒?MCV 鍩烘暟锛岀敓浜у疄娴嬩綆浼?172 鍊嶏級
    expect(sql).not.toMatch(/JOIN\s+tenants/i);
    expect(sql).toContain('tenant_id IN');
  });

  it('does not resolve tenants for personal scope', async () => {
    const { repository, tenantLookups } = buildRepository();

    await repository.aggregate(
      { tenantId: 'tenant-9', billingAccountId: 'account-1', byBillingAccount: false },
      filters,
      'day',
    );

    expect(tenantLookups).toHaveLength(0);
    const sql = sqlText(repository['buildDailyQuery'](['tenant-9'], filters));
    expect(sql).not.toMatch(/JOIN\s+tenants/i);
  });

  it('returns no rows when the billing account has no workspaces', async () => {
    const { repository, prisma } = buildRepository([]);

    const rows = await repository.aggregate(scope, filters, 'month');

    expect(rows).toEqual([]);
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });
});
