/**
 * One-off: measure export-summary SQL (old vs new) against a live DB,
 * optionally stream an enterprise bill xlsx and check summary/detail alignment.
 *
 * Usage:
 *   BILLING_DATABASE_URL=... npx ts-node -T scripts/probe-uat-export-summary.ts \
 *     --account <id> --month YYYY-MM [--download] [--out path.xlsx]
 */
import { createWriteStream, readFileSync as fsReadFileSync } from 'node:fs';
import { PassThrough } from 'node:stream';
import { performance } from 'node:perf_hooks';
import { PrismaClient, Prisma } from '@prisma/client';
import JSZip from 'jszip';
import {
  UNATTRIBUTED_LEDGER_KEY,
  expandUsageDetailParts,
  splitUsageChannels,
  writeEnterpriseBillXlsx,
  type UsageRow,
} from '../src/billing/enterprise-bills-xlsx';
import { usd } from '../src/billing/money';

const ACCOUNT = arg('--account') ?? '6ad5ab22-add8-48d4-87f8-295781d4ca8d';
const MONTH = arg('--month') ?? '2026-10';
const DO_DOWNLOAD = process.argv.includes('--download');
const OUT = arg('--out') ?? `${process.env.TEMP ?? '/tmp'}/probe-${ACCOUNT.slice(0, 8)}-${MONTH}.xlsx`;
const PAGE = 500;

function arg(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i >= 0 ? process.argv[i + 1] : undefined;
}

function beijingMonthRange(yearMonth: string): { start: Date; end: Date } {
  const [y, m] = yearMonth.split('-').map(Number);
  const start = new Date(Date.UTC(y, m - 1, 1, -8, 0, 0, 0));
  const end = new Date(Date.UTC(y, m, 1, -8, 0, 0, 0));
  return { start, end };
}

async function timeQuery<T>(
  label: string,
  run: () => Promise<T>,
): Promise<{ label: string; ms: number; rows: number; sample: T }> {
  const t0 = performance.now();
  const sample = await run();
  const ms = performance.now() - t0;
  const rows = Array.isArray(sample) ? sample.length : 0;
  return { label, ms, rows, sample };
}

type SummaryRow = {
  tenantId: string;
  model: string;
  tokens: bigint | number;
  catalogUsd: Prisma.Decimal | string | number;
  discountedUsd: Prisma.Decimal | string | number;
  voucherUsd: Prisma.Decimal | string | number;
};

function oldSummarySql(prisma: PrismaClient, accountId: string, start: Date, end: Date, unattributed: string) {
  return prisma.$queryRaw<SummaryRow[]>`
    -- enterprise-bills export-summary OLD
    WITH scoped AS (
      SELECT
        tu.id, tu.tenant_id, tu.model, tu.total_tokens, tu.unit_price_usd,
        tu.customer_charge_usd, tu.cost_usd, tu.customer_charge_policy
      FROM token_usage tu
      JOIN tenants t ON t.id = tu.tenant_id
      WHERE t.billing_account_id = ${accountId}
        -- created_at 存 UTC 墙钟；与明细 findMany / 北京账期边界一致
        AND tu.created_at >= (${start} AT TIME ZONE 'UTC')
        AND tu.created_at < (${end} AT TIME ZONE 'UTC')
    ),
    allocs AS (
      SELECT bca.token_usage_id,
        COALESCE(SUM(bca.amount_usd), 0) AS allocated_charge,
        COALESCE(SUM(bca.bonus_consumed_usd), 0) AS bonus
      FROM balance_consumption_allocations bca
      JOIN scoped s ON s.id = bca.token_usage_id
      GROUP BY bca.token_usage_id
    )
    SELECT
      COALESCE(NULLIF(BTRIM(s.tenant_id), ''), ${unattributed}) AS "tenantId",
      COALESCE(NULLIF(BTRIM(s.model), ''), 'unknown') AS model,
      COALESCE(SUM(s.total_tokens), 0)::bigint AS tokens,
      COALESCE(SUM((COALESCE(s.total_tokens, 0)::numeric) * COALESCE(s.unit_price_usd, 0) / 1000000), 0) AS "catalogUsd",
      COALESCE(SUM(
        CASE
          WHEN COALESCE(a.allocated_charge, 0) > 0 THEN a.allocated_charge
          WHEN COALESCE(s.customer_charge_usd, 0) > 0 THEN s.customer_charge_usd
          WHEN s.customer_charge_policy IS NULL
            OR s.customer_charge_policy = 'usage_charge'
            OR s.customer_charge_policy = 'legacy_cost_usd'
            THEN ABS(COALESCE(s.cost_usd, 0))
          ELSE 0
        END
      ), 0) AS "discountedUsd",
      COALESCE(SUM(COALESCE(a.bonus, 0)), 0) AS "voucherUsd"
    FROM scoped s
    LEFT JOIN allocs a ON a.token_usage_id = s.id
    GROUP BY 1, 2
  `;
}

function newSummarySql(prisma: PrismaClient, accountId: string, start: Date, end: Date, unattributed: string) {
  return prisma.$queryRaw<SummaryRow[]>`
    -- enterprise-bills export-summary
    -- keep in sync with summarizeUsageRowsLikeExportSql
    WITH scoped AS (
      SELECT
        tu.id, tu.tenant_id, tu.model, tu.gateway_billing_event_id,
        tu.total_tokens, tu.prompt_tokens, tu.cached_input_tokens,
        tu.cache_write_input_tokens, tu.completion_tokens, tu.unit_price_usd,
        tu.input_price_usd_per_m, tu.cached_input_price_usd_per_m,
        tu.cache_write_price_usd_per_m, tu.output_price_usd_per_m,
        tu.customer_charge_usd, tu.cost_usd, tu.customer_charge_policy
      FROM token_usage tu
      JOIN tenants t ON t.id = tu.tenant_id
      WHERE t.billing_account_id = ${accountId}
        AND tu.created_at >= (${start} AT TIME ZONE 'UTC')
        AND tu.created_at < (${end} AT TIME ZONE 'UTC')
    ),
    allocs AS (
      SELECT bca.token_usage_id,
        COALESCE(SUM(bca.amount_usd), 0) AS allocated_charge,
        COALESCE(SUM(bca.bonus_consumed_usd), 0) AS bonus
      FROM balance_consumption_allocations bca
      JOIN scoped s ON s.id = bca.token_usage_id
      GROUP BY bca.token_usage_id
    ),
    priced AS (
      SELECT
        s.tenant_id, s.model,
        GREATEST(COALESCE(s.prompt_tokens, 0), 0) AS prompt,
        GREATEST(COALESCE(s.cached_input_tokens, 0), 0) AS cache_read,
        GREATEST(COALESCE(s.cache_write_input_tokens, 0), 0) AS cache_write,
        GREATEST(COALESCE(s.completion_tokens, 0), 0) AS output,
        GREATEST(COALESCE(s.total_tokens, 0), 0) AS total_tokens,
        COALESCE(s.input_price_usd_per_m, s.unit_price_usd, 0) AS input_price,
        COALESCE(s.cached_input_price_usd_per_m, s.input_price_usd_per_m, s.unit_price_usd, 0) AS cache_read_price,
        COALESCE(s.cache_write_price_usd_per_m, s.input_price_usd_per_m, s.unit_price_usd, 0) AS cache_write_price,
        COALESCE(s.output_price_usd_per_m, s.unit_price_usd, 0) AS output_price,
        COALESCE(s.unit_price_usd, 0) AS unit_price,
        CASE
          WHEN (gusa.customer_pricing_snapshot->>'customerMultiplier')
            ~ '^[+-]?[0-9]+(\\.[0-9]+)?([eE][+-]?[0-9]+)?$'
          THEN (gusa.customer_pricing_snapshot->>'customerMultiplier')::numeric
          ELSE NULL
        END AS multiplier,
        CASE
          WHEN COALESCE(a.allocated_charge, 0) > 0 THEN a.allocated_charge
          WHEN COALESCE(s.customer_charge_usd, 0) > 0 THEN s.customer_charge_usd
          WHEN s.customer_charge_policy IS NULL
            OR s.customer_charge_policy = 'usage_charge'
            OR s.customer_charge_policy = 'legacy_cost_usd'
            THEN ABS(COALESCE(s.cost_usd, 0))
          ELSE 0
        END AS discounted,
        COALESCE(a.bonus, 0) AS voucher
      FROM scoped s
      LEFT JOIN allocs a ON a.token_usage_id = s.id
      LEFT JOIN gateway_usage_settlement_anchors gusa
        ON gusa.gateway_billing_event_id = s.gateway_billing_event_id
    ),
    parts AS (
      SELECT
        tenant_id, model, discounted, voucher, cache_read, cache_write, output,
        total_tokens, input_price, cache_read_price, cache_write_price, output_price,
        unit_price, multiplier,
        GREATEST(
          prompt
          - LEAST(cache_read, prompt)
          - LEAST(cache_write, GREATEST(prompt - LEAST(cache_read, prompt), 0)),
          0
        ) AS input_tokens
      FROM priced
    ),
    lined AS (
      SELECT
        tenant_id, model,
        ROUND(discounted, 12) AS discounted,
        ROUND(voucher, 12) AS voucher,
        CASE
          WHEN input_tokens + cache_read + cache_write + output > 0
            THEN input_tokens + cache_read + cache_write + output
          ELSE total_tokens
        END AS part_tokens,
        CASE
          WHEN input_tokens + cache_read + cache_write + output > 0 THEN
            (
              input_tokens * CASE WHEN input_price > 0 AND multiplier > 0 THEN input_price / multiplier ELSE input_price END
              + cache_read * CASE WHEN cache_read_price > 0 AND multiplier > 0 THEN cache_read_price / multiplier ELSE cache_read_price END
              + cache_write * CASE WHEN cache_write_price > 0 AND multiplier > 0 THEN cache_write_price / multiplier ELSE cache_write_price END
              + output * CASE WHEN output_price > 0 AND multiplier > 0 THEN output_price / multiplier ELSE output_price END
            ) / 1000000
          ELSE
            total_tokens * CASE WHEN unit_price > 0 AND multiplier > 0 THEN unit_price / multiplier ELSE unit_price END / 1000000
        END AS catalog
      FROM parts
    )
    SELECT
      COALESCE(NULLIF(BTRIM(l.tenant_id), ''), ${unattributed}) AS "tenantId",
      COALESCE(NULLIF(BTRIM(l.model), ''), 'unknown') AS model,
      COALESCE(SUM(CASE WHEN l.discounted > 0 THEN l.part_tokens ELSE 0 END), 0)::bigint AS tokens,
      COALESCE(SUM(CASE WHEN l.discounted > 0 THEN l.catalog ELSE 0 END), 0) AS "catalogUsd",
      COALESCE(SUM(l.discounted), 0) AS "discountedUsd",
      COALESCE(SUM(l.voucher), 0) AS "voucherUsd"
    FROM lined l
    GROUP BY 1, 2
  `;
}

function foldSummary(rows: SummaryRow[]) {
  let tokens = 0;
  let catalog = usd(0);
  let discounted = usd(0);
  let voucher = usd(0);
  let positiveBuckets = 0;
  for (const row of rows) {
    const d = usd(row.discountedUsd);
    discounted = discounted.add(d);
    voucher = voucher.add(usd(row.voucherUsd));
    if (!d.gt(0)) continue;
    positiveBuckets += 1;
    tokens += Number(row.tokens);
    catalog = catalog.add(usd(row.catalogUsd));
  }
  return { tokens, catalog: Number(catalog), discounted: Number(discounted), voucher: Number(voucher), positiveBuckets, groups: rows.length };
}

async function* iterateUsage(
  prisma: PrismaClient,
  accountId: string,
  start: Date,
  end: Date,
): AsyncGenerator<UsageRow[]> {
  const tenants = await prisma.tenant.findMany({
    where: { billingAccountId: accountId },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  for (const tenant of tenants) {
    let cursorId: string | undefined;
    for (;;) {
      const page = await prisma.tokenUsage.findMany({
        where: {
          tenantId: tenant.id,
          createdAt: { gte: start, lt: end },
        },
        take: PAGE,
        ...(cursorId ? { cursor: { id: cursorId }, skip: 1 } : {}),
        orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
        select: {
          id: true,
          createdAt: true,
          tenantId: true,
          model: true,
          callType: true,
          totalTokens: true,
          promptTokens: true,
          cachedInputTokens: true,
          cacheWriteInputTokens: true,
          completionTokens: true,
          unitPriceUsd: true,
          inputPriceUsdPerM: true,
          cachedInputPriceUsdPerM: true,
          cacheWritePriceUsdPerM: true,
          outputPriceUsdPerM: true,
          customerChargeUsd: true,
          costUsd: true,
          customerChargePolicy: true,
          gatewayBillingEvent: {
            select: {
              settlementAnchor: {
                select: { customerPricingSnapshot: true },
              },
            },
          },
          consumptionAllocations: {
            select: {
              balanceGrantId: true,
              source: true,
              amountUsd: true,
              recognizedRevenueUsd: true,
              bonusConsumedUsd: true,
            },
          },
        },
      });
      if (page.length === 0) break;
      yield page as unknown as UsageRow[];
      cursorId = page[page.length - 1]!.id;
      if (page.length < PAGE) break;
    }
  }
}

function colLettersToIndex(letters: string): number {
  let index = 0;
  for (const ch of letters) index = index * 26 + (ch.charCodeAt(0) - 64);
  return index - 1;
}

async function parseXlsx(buffer: Buffer): Promise<Map<string, string[][]>> {
  const zip = await JSZip.loadAsync(buffer);
  const workbook = await zip.file('xl/workbook.xml')?.async('string');
  const names = [...(workbook ?? '').matchAll(/<sheet\b[^>]*\bname="([^"]+)"/g)].map((m) => m[1]!);
  const sharedXml = await zip.file('xl/sharedStrings.xml')?.async('string') ?? '';
  const shared = [...sharedXml.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => m[1] ?? '');
  const out = new Map<string, string[][]>();
  for (let i = 0; i < names.length; i += 1) {
    const xml = await zip.file(`xl/worksheets/sheet${i + 1}.xml`)?.async('string') ?? '';
    const rows = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((row) => {
      const cells: string[] = [];
      for (const cell of row[1]!.matchAll(/<c\b([^>/]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = cell[1]!.match(/\br="([A-Z]+)\d+"/)?.[1];
        const type = cell[1]!.match(/\bt="([^"]+)"/)?.[1];
        const inner = cell[2] ?? '';
        const inline = inner.match(/<is><t[^>]*>([^<]*)<\/t><\/is>/);
        const numeric = inner.match(/<v>([^<]*)<\/v>/)?.[1] ?? '';
        const text = inline?.[1] ?? (type === 's' ? shared[Number(numeric)] ?? numeric : numeric);
        const colIndex = ref ? colLettersToIndex(ref) : cells.length;
        while (cells.length < colIndex) cells.push('');
        cells[colIndex] = text ?? '';
      }
      return cells;
    });
    out.set(names[i]!, rows);
  }
  return out;
}

function checkSheets(sheets: Map<string, string[][]>) {
  const detail = (sheets.get('账单明细') ?? []).slice(3);
  let detailTokens = 0;
  let detailCatalog = 0;
  let detailConsume = 0;
  for (const row of detail) {
    const tokens = Number(row[4] ?? 0);
    const catalog = Number(row[9] ?? 0);
    const consume = Number(row[10] ?? 0);
    if (consume > 0) {
      detailTokens += tokens;
      detailCatalog += catalog;
      detailConsume += consume;
    }
  }

  const summary = sheets.get('账单汇总') ?? [];
  const summaryData = summary.filter((row) => row.length >= 5 && row[1] && row[0] !== '序号' && !String(row[0]).includes('合计') && !String(row[0]).includes('应收') && !String(row[0]).includes('代金券'));
  let summaryTokens = 0;
  let summaryCatalog = 0;
  let summaryDiscounted = 0;
  for (const row of summaryData) {
    summaryTokens += Number(row[2] ?? 0);
    summaryCatalog += Number(row[3] ?? 0);
    summaryDiscounted += Number(row[4] ?? 0);
  }

  const model = sheets.get('产品模型汇总') ?? [];
  const modelTotal = model.find((row) => row[0] === '总计');
  const modelTokens = Number(modelTotal?.[2] ?? 0);
  const modelCatalog = Number(modelTotal?.[3] ?? 0);
  const modelDiscounted = Number(modelTotal?.[4] ?? 0);

  // 金额允许 12 位舍入残差；用量要求整数一致
  const closeMoney = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-9);
  const closeInt = (a: number, b: number) => a === b;

  return {
    detailRows: detail.length,
    detail: { tokens: detailTokens, catalog: detailCatalog, consume: detailConsume },
    summary: { tokens: summaryTokens, catalog: summaryCatalog, discounted: summaryDiscounted },
    model: { tokens: modelTokens, catalog: modelCatalog, discounted: modelDiscounted },
    diffs: {
      tokens: summaryTokens - detailTokens,
      catalog: summaryCatalog - detailCatalog,
      discounted: summaryDiscounted - detailConsume,
    },
    align: {
      summaryTokensVsDetail: closeInt(summaryTokens, detailTokens),
      summaryCatalogVsDetail: closeMoney(summaryCatalog, detailCatalog),
      summaryDiscountedVsDetail: closeMoney(summaryDiscounted, detailConsume),
      modelTokensVsSummary: closeInt(modelTokens, summaryTokens),
      modelCatalogVsSummary: closeMoney(modelCatalog, summaryCatalog),
      modelDiscountedVsSummary: closeMoney(modelDiscounted, summaryDiscounted),
      catalogNonZero: summaryCatalog > 0,
    },
  };
}

async function main() {
  const url = process.env.BILLING_DATABASE_URL ?? process.env.DATABASE_URL;
  if (!url) throw new Error('BILLING_DATABASE_URL required');
  const prisma = new PrismaClient({ datasources: { db: { url } } });
  const { start, end } = beijingMonthRange(MONTH);
  const unattributed = UNATTRIBUTED_LEDGER_KEY;

  console.log(JSON.stringify({ account: ACCOUNT, month: MONTH, start: start.toISOString(), end: end.toISOString() }));

  const countRow = await prisma.$queryRaw<Array<{ n: bigint }>>`
    SELECT COUNT(*)::bigint AS n
    FROM token_usage tu
    JOIN tenants t ON t.id = tu.tenant_id
    WHERE t.billing_account_id = ${ACCOUNT}
      AND tu.created_at >= (${start} AT TIME ZONE 'UTC')
      AND tu.created_at < (${end} AT TIME ZONE 'UTC')
  `;
  console.log(JSON.stringify({ usageRows: Number(countRow[0]?.n ?? 0) }));

  const oldTimed = await timeQuery('old_summary_sql', () => oldSummarySql(prisma, ACCOUNT, start, end, unattributed));
  const newTimed = await timeQuery('new_summary_sql', () => newSummarySql(prisma, ACCOUNT, start, end, unattributed));
  const newFold = foldSummary(newTimed.sample);
  console.log(JSON.stringify({
    timing: [
      { label: oldTimed.label, ms: Math.round(oldTimed.ms), groups: oldTimed.rows, fold: foldSummary(oldTimed.sample) },
      { label: newTimed.label, ms: Math.round(newTimed.ms), groups: newTimed.rows, fold: newFold },
    ],
  }, null, 2));

  if (!DO_DOWNLOAD) {
    await prisma.$disconnect();
    return;
  }

  const account = await prisma.billingAccount.findUnique({
    where: { id: ACCOUNT },
    select: { id: true, enterpriseName: true },
  });
  const enterpriseName = account?.enterpriseName || ACCOUNT;

  const byTenant = new Map<string, { key: string; tokens: number; catalogAmount: Prisma.Decimal; discountedAmount: Prisma.Decimal }>();
  const byModel = new Map<string, { key: string; tokens: number; catalogAmount: Prisma.Decimal; discountedAmount: Prisma.Decimal }>();
  let footerConsume = usd(0);
  let footerVoucher = usd(0);
  for (const row of newTimed.sample) {
    const discounted = usd(row.discountedUsd);
    footerConsume = footerConsume.add(discounted);
    footerVoucher = footerVoucher.add(usd(row.voucherUsd));
    if (!discounted.gt(0)) continue;
    const bump = (
      map: typeof byTenant,
      key: string,
      tokens: number,
      catalogAmount: Prisma.Decimal,
      discountedAmount: Prisma.Decimal,
    ) => {
      const bucket = map.get(key) ?? { key, tokens: 0, catalogAmount: usd(0), discountedAmount: usd(0) };
      bucket.tokens += tokens;
      bucket.catalogAmount = bucket.catalogAmount.add(catalogAmount);
      bucket.discountedAmount = bucket.discountedAmount.add(discountedAmount);
      map.set(key, bucket);
    };
    bump(byTenant, row.tenantId, Number(row.tokens), usd(row.catalogUsd), discounted);
    bump(byModel, row.model, Number(row.tokens), usd(row.catalogUsd), discounted);
  }

  // 明细口径现场累加（与 expandUsageDetailParts / splitUsageChannels 一致），大文件不再整包 JSZip 解析
  let liveTokens = 0;
  let liveCatalog = usd(0);
  let liveConsume = usd(0);
  let liveParts = 0;
  let liveUsage = 0;
  async function* usageAndTally(): AsyncGenerator<UsageRow[]> {
    for await (const page of iterateUsage(prisma, ACCOUNT, start, end)) {
      for (const row of page) {
        liveUsage += 1;
        const channels = splitUsageChannels(row);
        const parts = expandUsageDetailParts(row);
        liveParts += parts.length;
        liveConsume = liveConsume.add(channels.totalAmount);
        if (!channels.totalAmount.gt(0)) continue;
        for (const part of parts) {
          const tokens = part.totalTokens ?? 0;
          liveTokens += tokens;
          liveCatalog = liveCatalog.add(usd(part.unitPriceUsd).mul(Math.max(0, tokens)).div(1_000_000));
        }
      }
      yield page;
    }
  }

  const dest = new PassThrough();
  let ttfbMs: number | null = null;
  let bytes = 0;
  const t0 = performance.now();
  dest.on('data', (chunk: Buffer | string) => {
    if (ttfbMs == null) ttfbMs = performance.now() - t0;
    bytes += Buffer.isBuffer(chunk) ? chunk.length : Buffer.byteLength(chunk);
  });
  const finished = new Promise<void>((resolve, reject) => {
    dest.on('finish', () => resolve());
    dest.on('error', reject);
  });
  const file = createWriteStream(OUT);
  dest.pipe(file);

  await writeEnterpriseBillXlsx({
    yearMonth: MONTH,
    currentMonth: false,
    exportedAt: end,
    enterpriseName,
    bill: {
      consumeCents: 0,
      voucherCents: 0,
      chargeCents: 0,
      tokenTotal: 0,
      requestCount: 0,
      adjustedCents: 0,
      issuedVoucherCents: 0,
      receivableCents: 0,
      paidCents: 0,
      pendingCents: 0,
      status: '',
      dueAt: null,
    },
    events: [],
    ledger: { byTenant: [], byModel: [] },
    summary: { byTenant, byModel, footerConsume, footerVoucher },
    usage: () => usageAndTally(),
    dest,
  });
  await finished;
  await new Promise<void>((resolve, reject) => {
    file.on('finish', () => resolve());
    file.on('error', reject);
  });
  const totalMs = performance.now() - t0;

  const closeMoney = (a: number, b: number) => Math.abs(a - b) <= Math.max(1e-9, Math.abs(b) * 1e-9);
  const live = {
    usage: liveUsage,
    parts: liveParts,
    tokens: liveTokens,
    catalog: Number(liveCatalog),
    consume: Number(liveConsume),
  };
  const alignLive = {
    summaryTokensVsLive: newFold.tokens === live.tokens,
    summaryCatalogVsLive: closeMoney(newFold.catalog, live.catalog),
    summaryDiscountedVsLive: closeMoney(newFold.discounted, live.consume),
    modelTokensVsSummary: [...byModel.values()].reduce((s, b) => s + b.tokens, 0) === newFold.tokens,
    catalogNonZero: newFold.catalog > 0,
  };

  let xlsxCheck: ReturnType<typeof checkSheets> | null = null;
  // 邻可量级可解压复核；头文 ~600MB 会撑爆字符串
  if (bytes > 0 && bytes < 80_000_000) {
    const buffer = fsReadFileSync(OUT);
    xlsxCheck = checkSheets(await parseXlsx(buffer));
  }

  console.log(JSON.stringify({
    download: {
      out: OUT,
      bytes,
      ttfbMs: ttfbMs == null ? null : Math.round(ttfbMs),
      totalMs: Math.round(totalMs),
      live,
      sqlFold: newFold,
      alignLive,
      xlsxCheck,
    },
  }, null, 2));

  await prisma.$disconnect();
  const okLive = Object.values(alignLive).every(Boolean);
  const okXlsx = xlsxCheck ? Object.values(xlsxCheck.align).every(Boolean) : true;
  process.exit(okLive && okXlsx ? 0 : 2);
}

main().catch(async (err) => {
  console.error(err);
  process.exit(1);
});
