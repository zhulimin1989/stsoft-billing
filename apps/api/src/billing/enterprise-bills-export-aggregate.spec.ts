import JSZip from 'jszip';
import {
  buildEnterpriseUsageAggregateQuery,
  type EnterpriseUsageAggregateRow,
} from './enterprise-bills-export-aggregate';
import {
  buildExportBucketsFromAggregateGroups,
  buildEnterpriseBillXlsx,
  resolveCustomerMultiplier,
  splitUsageChannels,
  type BillSnapshot,
  type DetailLine,
  type EnterpriseBillXlsxInput,
  type EventRow,
  type LedgerBreakdown,
  type UsageRow,
} from './enterprise-bills-xlsx';
import { getRegularInputTokens } from './token-breakdown';

/**
 * 回归防线：SQL 聚合下推结果必须与逐行折叠**逐字节**一致。
 *
 * 这里的 `sqlMirrorGroups` 只做 SQL 里那些可交换的求和（分量 token、渠道金额、
 * 折后 > 0 的分量 token），业务判定全部复用导出模块自己的
 * `expandUsageDetailParts` / `splitUsageChannels` / `resolveCustomerMultiplier`，
 * 因此两边不会各写一套口径。
 */

const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;

function beijingDayOf(createdAt: Date): string {
  return new Date(createdAt.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

const SQL_NUMERIC_FIELDS = [
  'input_tokens',
  'cache_read_tokens',
  'cache_write_tokens',
  'output_tokens',
  'input_positive_tokens',
  'cache_read_positive_tokens',
  'cache_write_positive_tokens',
  'output_positive_tokens',
  'fallback_tokens',
  'fallback_positive_tokens',
  'fallback_rows',
  'positive_discounted_amount',
] as const;

const SQL_MONEY_FIELDS = [
  'total_amount',
  'credit_amount',
  'debt_amount',
  'voucher_amount',
  'paid_amount',
  'pending_amount',
] as const;

type MirrorAccumulator = {
  row: Record<string, string | null>;
  sums: Record<string, number>;
};

/**
 * `buildEnterpriseUsageAggregateQuery` 的 JS 对照：同一批 UsageRow 按
 * SQL 的分组键（日 × 工作区 × 模型 × call_type × 全部单价列 × 倍率）聚合。
 */
function sqlMirrorGroups(rows: UsageRow[]): EnterpriseUsageAggregateRow[] {
  const groups = new Map<string, MirrorAccumulator>();
  for (const row of rows) {
    const multiplier = resolveCustomerMultiplier(row);
    const groupKey = JSON.stringify([
      beijingDayOf(row.createdAt),
      row.tenantId ?? null,
      row.model ?? null,
      row.callType ?? null,
      row.inputPriceUsdPerM == null ? null : String(row.inputPriceUsdPerM),
      row.cachedInputPriceUsdPerM == null ? null : String(row.cachedInputPriceUsdPerM),
      row.cacheWritePriceUsdPerM == null ? null : String(row.cacheWritePriceUsdPerM),
      row.outputPriceUsdPerM == null ? null : String(row.outputPriceUsdPerM),
      row.unitPriceUsd == null ? null : String(row.unitPriceUsd),
      multiplier,
    ]);
    const accumulator = groups.get(groupKey) ?? {
      row: {
        day: beijingDayOf(row.createdAt),
        tenant_id: row.tenantId ?? '',
        model: row.model ?? '',
        call_type: row.callType ?? null,
        input_price: row.inputPriceUsdPerM == null ? null : String(row.inputPriceUsdPerM),
        cached_price: row.cachedInputPriceUsdPerM == null
          ? null
          : String(row.cachedInputPriceUsdPerM),
        cache_write_price: row.cacheWritePriceUsdPerM == null
          ? null
          : String(row.cacheWritePriceUsdPerM),
        output_price: row.outputPriceUsdPerM == null ? null : String(row.outputPriceUsdPerM),
        unit_price: row.unitPriceUsd == null ? null : String(row.unitPriceUsd),
        multiplier: multiplier == null ? null : String(multiplier),
      },
      sums: emptyMirrorSums(),
    };
    groups.set(groupKey, accumulator);

    const channels = splitUsageChannels(row);
    const positive = channels.totalAmount.gt(0);
    for (const field of SQL_MONEY_FIELDS) {
      accumulator.sums[field] = accumulator.sums[field]! + Number(
        field === 'total_amount' ? channels.totalAmount : channels[mirrorChannelField(field)],
      );
    }
    if (positive) {
      accumulator.sums.positive_discounted_amount = accumulator.sums.positive_discounted_amount!
        + Number(channels.totalAmount);
    }

    // 分量 token：与 SQL 的 parts CTE 同口径（cache read/write 用原值，不 clamp）。
    const inputTokens = getRegularInputTokens({
      inputTokens: row.promptTokens,
      cachedInputTokens: row.cachedInputTokens,
      cacheWriteInputTokens: row.cacheWriteInputTokens,
      outputTokens: row.completionTokens,
    });
    const cacheReadTokens = Math.max(0, Math.floor(Number(row.cachedInputTokens ?? 0)));
    const cacheWriteTokens = Math.max(0, Math.floor(Number(row.cacheWriteInputTokens ?? 0)));
    const outputTokens = Math.max(0, Math.floor(Number(row.completionTokens ?? 0)));
    const isFallback = inputTokens === 0 && cacheReadTokens === 0
      && cacheWriteTokens === 0 && outputTokens === 0;

    if (isFallback) {
      const totalTokens = Math.max(0, Math.floor(Number(row.totalTokens ?? 0)));
      accumulator.sums.fallback_rows += 1;
      accumulator.sums.fallback_tokens += totalTokens;
      if (positive) accumulator.sums.fallback_positive_tokens += totalTokens;
    } else {
      for (const [field, tokens] of [
        ['input_tokens', inputTokens],
        ['cache_read_tokens', cacheReadTokens],
        ['cache_write_tokens', cacheWriteTokens],
        ['output_tokens', outputTokens],
      ] as const) {
        accumulator.sums[field] += tokens;
        if (positive) accumulator.sums[`${field.replace('_tokens', '')}_positive_tokens`] += tokens;
      }
    }
  }

  return [...groups.values()].map(({ row, sums }) => {
    const out: Record<string, string | null> = { ...row };
    for (const field of [...SQL_NUMERIC_FIELDS, ...SQL_MONEY_FIELDS]) {
      out[field] = String(sums[field] ?? 0);
    }
    return out as unknown as EnterpriseUsageAggregateRow;
  });
}

function emptyMirrorSums(): Record<string, number> {
  const sums: Record<string, number> = {};
  for (const field of [...SQL_NUMERIC_FIELDS, ...SQL_MONEY_FIELDS]) sums[field] = 0;
  return sums;
}

function mirrorChannelField(field: string): 'totalAmount' | 'creditAmount' | 'debtAmount'
  | 'voucherAmount' | 'paidAmount' | 'pendingAmount' {
  const map = {
    total_amount: 'totalAmount',
    credit_amount: 'creditAmount',
    debt_amount: 'debtAmount',
    voucher_amount: 'voucherAmount',
    paid_amount: 'paidAmount',
    pending_amount: 'pendingAmount',
  } as const;
  return map[field as keyof typeof map]!;
}

async function unzipSheetNames(buffer: Buffer): Promise<Map<string, string[][]>> {
  const zip = await JSZip.loadAsync(buffer);
  const workbook = await zip.file('xl/workbook.xml')?.async('string') ?? '';
  const names = [...workbook.matchAll(/<sheet\b[^>]*\bname="([^"]+)"/g)].map((m) => m[1]!);
  const out = new Map<string, string[][]>();
  for (let index = 0; index < names.length; index += 1) {
    const xml = await zip.file(`xl/worksheets/sheet${index + 1}.xml`)?.async('string') ?? '';
    const rows = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((row) => (
      [...row[1]!.matchAll(/<c\b([^>/]*)(?:\/>|>([\s\S]*?)<\/c>)/g)].map((cell) => {
        const inline = cell[2]?.match(/<is><t[^>]*>([^<]*)<\/t><\/is>/);
        return inline?.[1] ?? cell[2]?.match(/<v>([^<]*)<\/v>/)?.[1] ?? '';
      })
    ));
    out.set(names[index]!, rows);
  }
  return out;
}

const bill: BillSnapshot = {
  consumeCents: 10_000,
  voucherCents: 1_000,
  chargeCents: 9_000,
  tokenTotal: 1_000_000,
  requestCount: 2,
  adjustedCents: 0,
  issuedVoucherCents: 0,
  receivableCents: 9_000,
  paidCents: 3_000,
  pendingCents: 4_000,
  status: '已核销',
  dueAt: '2026-10-30T15:59:59.000Z',
};

const events: EventRow[] = [];
const ledger: LedgerBreakdown = { byTenant: [], byModel: [] };

/**
 * 覆盖：多分量行、同桶不同价基、倍率缺失/命中、enterprise credit + 本金券分摊、
 * 快照资金口径、负数 legacy cost 回退、全零分量回退（含 0 token）、跨自然日。
 * 刻意不使用 list_* 列：服务端 findMany 也不查这些列，SQL 同样看不到。
 */
const usage: UsageRow[] = [
  {
    createdAt: new Date('2026-09-01T04:00:00.000Z'),
    tenantId: 'tenant-1',
    model: 'glm-5.1',
    callType: 'input',
    totalTokens: 1_000_000,
    promptTokens: 840_000,
    cachedInputTokens: 100_000,
    completionTokens: 160_000,
    inputPriceUsdPerM: 2.4,
    cachedInputPriceUsdPerM: 0.6,
    outputPriceUsdPerM: 7.2,
    customerChargeUsd: 1.2,
    gatewayBillingEvent: { settlementAnchor: { customerPricingSnapshot: { customerMultiplier: '0.85' } } },
    consumptionAllocations: [
      {
        balanceGrantId: 'grant-1',
        source: 'BALANCE_GRANT',
        amountUsd: 0.7,
        recognizedRevenueUsd: 0.5,
        bonusConsumedUsd: 0.2,
      },
      {
        balanceGrantId: null,
        source: 'ENTERPRISE_CREDIT',
        amountUsd: 0.5,
        recognizedRevenueUsd: 0.3,
        bonusConsumedUsd: 0,
        approvedCreditUsd: 0.5,
        unapprovedDebtUsd: 0,
        fundingClassificationComplete: true,
      },
    ],
  },
  // 同桶同价基：必须合并求和
  {
    createdAt: new Date('2026-09-01T06:00:00.000Z'),
    tenantId: 'tenant-1',
    model: 'glm-5.1',
    callType: 'input',
    totalTokens: 200_000,
    promptTokens: 160_000,
    cachedInputTokens: 0,
    completionTokens: 40_000,
    inputPriceUsdPerM: 2.4,
    cachedInputPriceUsdPerM: 0.6,
    outputPriceUsdPerM: 7.2,
    customerChargeUsd: 0.24,
    gatewayBillingEvent: { settlementAnchor: { customerPricingSnapshot: { customerMultiplier: '0.85' } } },
  },
  // 同桶不同价基（无 cache 单价 → 回退 input 单价）
  {
    createdAt: new Date('2026-09-01T07:00:00.000Z'),
    tenantId: 'tenant-1',
    model: 'glm-5.1',
    callType: 'output',
    totalTokens: 50_000,
    promptTokens: 10_000,
    completionTokens: 40_000,
    inputPriceUsdPerM: 3.1,
    outputPriceUsdPerM: 9.4,
    customerChargeUsd: 0.41,
  },
  // 全零分量回退：tokens 仍要进明细
  {
    createdAt: new Date('2026-09-01T07:30:00.000Z'),
    tenantId: 'tenant-1',
    model: 'glm-5.1',
    callType: 'output',
    totalTokens: 500,
    unitPriceUsd: 0.000002,
    customerChargeUsd: 0.5,
  },
  // 全零分量且 0 token：不进 token 合计，但类型/单价仍要进桶
  {
    createdAt: new Date('2026-09-01T07:45:00.000Z'),
    tenantId: 'tenant-1',
    model: 'glm-5.1',
    callType: 'input',
    totalTokens: 0,
    customerChargeUsd: 0.9,
  },
  // legacy cost 回退 + 负数 cost
  {
    createdAt: new Date('2026-09-02T04:00:00.000Z'),
    tenantId: 'tenant-1',
    model: 'glm-5.1',
    callType: 'input',
    totalTokens: 1_000,
    promptTokens: 1_000,
    inputPriceUsdPerM: 1.5,
    customerChargePolicy: 'legacy_cost_usd',
    customerChargeUsd: 0,
    costUsd: -0.25,
  },
  // 资金快照口径（分摊为空 / 分类完整 / 三项覆盖总消耗）
  {
    createdAt: new Date('2026-09-03T04:00:00.000Z'),
    tenantId: 'tenant-1',
    model: 'deepseek-v4-flash',
    callType: 'input',
    totalTokens: 3_000,
    promptTokens: 3_000,
    inputPriceUsdPerM: 0.8,
    customerChargeUsd: 0.9,
    customerCollectedUsd: 0.3,
    customerApprovedReceivableUsd: 0.2,
    customerUnapprovedDebtUsd: 0.4,
    customerFundingClassificationComplete: true,
  },
  // 超额入账：溢出先削信用，再削本金
  {
    createdAt: new Date('2026-09-03T06:00:00.000Z'),
    tenantId: 'tenant-2',
    model: 'deepseek-v4-flash',
    callType: 'output',
    totalTokens: 9_000,
    completionTokens: 9_000,
    outputPriceUsdPerM: 4.4,
    consumptionAllocations: [
      {
        balanceGrantId: null,
        source: 'ENTERPRISE_CREDIT',
        amountUsd: 1,
        recognizedRevenueUsd: 1.2,
        bonusConsumedUsd: 0,
        approvedCreditUsd: 0.5,
        fundingClassificationComplete: true,
      },
    ],
  },
  // 非回退策略 + 无分摊 + 无 charge：总消耗 0，不进汇总（单独一天，避免与正数行同桶）
  {
    createdAt: new Date('2026-09-04T05:00:00.000Z'),
    tenantId: 'tenant-1',
    model: 'glm-5.1',
    callType: 'input',
    totalTokens: 700,
    promptTokens: 700,
    inputPriceUsdPerM: 1.5,
    customerChargePolicy: 'fixed_fee',
    customerChargeUsd: 0,
    costUsd: -1,
  },
  // 跨北京自然日（UTC 09-15T20:00 → 北京 09-16 04:00）
  {
    createdAt: new Date('2026-09-15T20:00:00.000Z'),
    tenantId: 'tenant-2',
    model: 'glm-5.1',
    callType: 'input',
    totalTokens: 12_000,
    promptTokens: 12_000,
    inputPriceUsdPerM: 2.4,
    customerChargeUsd: 0.03,
    gatewayBillingEvent: { settlementAnchor: { customerPricingSnapshot: { customerMultiplier: '0.9' } } },
  },
];

function baseInput(): EnterpriseBillXlsxInput {
  return {
    yearMonth: '2026-09',
    currentMonth: false,
    exportedAt: new Date('2026-09-20T04:00:00.000Z'),
    enterpriseName: '瀚海云联科技有限公司',
    bill,
    events,
    ledger,
  };
}

describe('SQL 聚合下推与逐行折叠等价', () => {
  it('账单汇总 / 产品模型汇总 逐格一致，账单明细按 类型×折扣比 拆行后同源', async () => {
    const rowScan = await unzipSheetNames(await buildEnterpriseBillXlsx({
      ...baseInput(),
      usage,
    }));
    const aggregated = buildExportBucketsFromAggregateGroups(sqlMirrorGroups(usage));
    const pushedDown = await unzipSheetNames(await buildEnterpriseBillXlsx({
      ...baseInput(),
      aggregated,
    }));

    expect([...pushedDown.keys()]).toEqual([...rowScan.keys()]);
    for (const sheet of ['账单汇总', '产品模型汇总']) {
      expect(pushedDown.get(sheet)).toEqual(rowScan.get(sheet));
    }

    // 明细：类型 / 用量 / 目录价格 / 折扣比 逐格一致（金额按行级价基分摊）
    const pushRows = pushedDown.get('账单明细')!.slice(3);
    const scanRows = rowScan.get('账单明细')!.slice(3);
    expect(pushRows.map((row) => row.slice(0, 10))).toEqual(scanRows.map((row) => row.slice(0, 10)));

    // 金额列：下推按「组」切分、逐行按「行」切分，组内各行价基比例不完全一致时
    // 逐行归属会有微小差异；但每个 日×工作区×模型 的合计必须逐位相等（勾稽口径）。
    const moneyCols = [10, 11, 12, 13, 14, 15, 16];
    pushRows.forEach((row) => {
      // 行内自洽：总消耗 = 账户支付 + 信用 + 欠款 + 代金券 + 待付款
      const split = [11, 12, 13, 14, 16].reduce((sum, col) => sum + Number(row[col] ?? 0), 0);
      expect(Number(row[10] ?? 0)).toBeCloseTo(split, 9);
    });
    const sumByBucket = (rows: string[][]): Map<string, number[]> => {
      const out = new Map<string, number[]>();
      for (const row of rows) {
        const key = `${row[0]}/${row[1]}/${row[2]}`;
        const acc = out.get(key) ?? moneyCols.map(() => 0);
        moneyCols.forEach((col, i) => { acc[i]! += Number(row[col] ?? 0); });
        out.set(key, acc);
      }
      return out;
    };
    const pushSum = sumByBucket(pushRows);
    const scanSum = sumByBucket(scanRows);
    expect([...pushSum.keys()].sort()).toEqual([...scanSum.keys()].sort());
    for (const [key, values] of pushSum) {
      const expected = scanSum.get(key)!;
      values.forEach((value, i) => expect(Math.abs(value - expected[i]!)).toBeLessThanOrEqual(1e-9));
    }
  });

  it('把每个分组行折叠成 日×工作区×模型×类型×折扣比 桶，用量按分量求和', () => {
    const groups = sqlMirrorGroups(usage);
    expect(groups.length).toBeGreaterThan(1);
    const { lines } = buildExportBucketsFromAggregateGroups(groups);
    // 分组键含类型与折扣比 ⇒ 同一 日×工作区×模型 可以有多行，但键本身唯一
    const keys = lines.map((line) => `${line.day}/${line.tenantId}/${line.model}/${line.callType}/${line.customerMultiplier}`);
    expect(new Set(keys).size).toBe(keys.length);
    const bucketRows = lines.filter(
      (line) => line.day === '2026-09-01' && line.tenantId === 'tenant-1' && line.model === 'glm-5.1',
    );
    // 同一 日×工作区×模型 下按 类型 与 折扣比 再分：input 两种倍率、output 含全零分量回退行
    expect(bucketRows.map((line) => line.callType)).toEqual([
      'input',
      'input',
      'cache read',
      'output',
      'output',
    ]);
    // 740k(input) + 100k(cache read) + 160k(output) + 200k + 50k + 500(全零分量回退) + 0
    expect(bucketRows.reduce((sum, line) => sum + line.tokens, 0)).toBe(1_250_500);
  });

  it('聚合行顺序无关：分组顺序打乱后结果不变', () => {
    const groups = sqlMirrorGroups(usage);
    const forward = buildExportBucketsFromAggregateGroups(groups);
    const reversed = buildExportBucketsFromAggregateGroups([...groups].reverse());
    expect(reversed.lines.map((line) => usageLineCells(line))).toEqual(
      forward.lines.map((line) => usageLineCells(line)),
    );
  });
});

function usageLineCells(line: DetailLine): string[] {
  return [
    line.day,
    line.tenantId,
    line.model,
    line.callType,
    String(line.tokens),
    String(line.unitPriceUsd ?? ''),
    line.catalogAmount.toString(),
    line.totalAmount.toString(),
    line.creditAmount.toString(),
    line.debtAmount.toString(),
    line.voucherAmount.toString(),
    line.paidAmount.toString(),
    line.pendingAmount.toString(),
    line.settlementStatus,
    String(line.customerMultiplier),
  ];
}

describe('buildEnterpriseUsageAggregateQuery', () => {
  it('绑定账号与时间边界，不把值拼进 SQL 文本', () => {
    const start = new Date('2026-08-31T16:00:00.000Z');
    const endExclusive = new Date('2026-09-30T16:00:00.000Z');
    const query = buildEnterpriseUsageAggregateQuery({
      accountId: 'acct-1',
      start,
      endExclusive,
    });
    expect(query.sql).not.toContain('acct-1');
    expect(query.sql).not.toContain('2026-08-31');
    // 账号绑定三处（锚点联接收窄 / 主扫描 / 分摊过滤），时间绑定两处。
    expect(query.values.filter((value) => value === 'acct-1')).toHaveLength(3);
    expect(query.values.filter((value) => value instanceof Date)).toEqual([start, endExclusive]);
    // 占位符与绑定值数量必须一致，否则拼接 emit 会错位。
    expect((query.sql.match(/\?/g) ?? []).length).toBe(query.values.length);
  });

  it('按 UTC 墙钟取范围、按北京自然日分组', () => {
    const query = buildEnterpriseUsageAggregateQuery({
      accountId: 'acct-1',
      start: new Date('2026-08-31T16:00:00.000Z'),
      endExclusive: new Date('2026-09-30T16:00:00.000Z'),
    });
    expect(query.sql).toContain("AT TIME ZONE 'UTC'");
    expect(query.sql).toContain("interval '8 hours'");
    expect(query.sql).toContain('GROUP BY');
    expect(query.sql).toContain('balance_consumption_allocations');
  });
});
