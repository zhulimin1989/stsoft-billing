import fs from 'node:fs';
import { PrismaClient } from '@prisma/client';
import JSZip from 'jszip';
import {
  expandUsageDetailParts,
  splitUsageChannels,
  type UsageRow,
} from '../src/billing/enterprise-bills-xlsx';

const prisma = new PrismaClient();
const ACCOUNT = '6ad5ab22-add8-48d4-87f8-295781d4ca8d';
const start = new Date('2026-09-30T16:00:00.000Z');
const end = new Date('2026-10-31T16:00:00.000Z');
const PAGE = 500;
const XLSX = `${process.env.TEMP}\\uat-linke-2026-10-fixed.xlsx`;

async function sumFromDb() {
  const tenants = await prisma.tenant.findMany({
    where: { billingAccountId: ACCOUNT },
    select: { id: true },
    orderBy: { id: 'asc' },
  });
  let usage = 0;
  let partN = 0;
  let partTok = 0;
  let partTokPos = 0;
  let zeroN = 0;
  for (const t of tenants) {
    let cursor: string | undefined;
    for (;;) {
      const page = await prisma.tokenUsage.findMany({
        where: { tenantId: t.id, createdAt: { gte: start, lt: end } },
        take: PAGE,
        ...(cursor ? { cursor: { id: cursor }, skip: 1 } : {}),
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
            select: { settlementAnchor: { select: { customerPricingSnapshot: true } } },
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
      for (const row of page as unknown as UsageRow[]) {
        usage += 1;
        const ch = splitUsageChannels(row);
        const parts = expandUsageDetailParts(row);
        partN += parts.length;
        let rt = 0;
        for (const p of parts) rt += p.totalTokens ?? 0;
        partTok += rt;
        if (ch.totalAmount.gt(0)) partTokPos += rt;
        else zeroN += parts.length;
      }
      cursor = (page[page.length - 1] as { id: string }).id;
      if (page.length < PAGE) break;
    }
  }
  return { usage, partN, partTok, partTokPos, zeroN };
}

async function sumFromXlsx(path: string) {
  const buf = fs.readFileSync(path);
  const zip = await JSZip.loadAsync(buf);
  const wb = await zip.file('xl/workbook.xml')!.async('string');
  const names = [...wb.matchAll(/name="([^"]+)"/g)].map((m) => m[1]!);
  const sharedXml = await zip.file('xl/sharedStrings.xml')?.async('string') ?? '';
  const shared = [...sharedXml.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((m) => m[1] ?? '');
  const sheetIdx = names.indexOf('账单明细') + 1;
  const xml = await zip.file(`xl/worksheets/sheet${sheetIdx}.xml`)!.async('string');
  let n = 0;
  let posN = 0;
  let allT = 0;
  let posT = 0;
  let allC = 0;
  let posC = 0;
  let allK = 0;
  let posK = 0;
  for (const row of xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)) {
    const cells: string[] = [];
    for (const cell of row[1]!.matchAll(/<c\b([^>/]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
      const ref = cell[1]!.match(/\br="([A-Z]+)\d+"/)?.[1];
      const type = cell[1]!.match(/\bt="([^"]+)"/)?.[1];
      const inner = cell[2] ?? '';
      const inline = inner.match(/<is><t[^>]*>([^<]*)<\/t><\/is>/)?.[1];
      const numeric = inner.match(/<v>([^<]*)<\/v>/)?.[1] ?? '';
      const text = inline ?? (type === 's' ? shared[Number(numeric)] ?? numeric : numeric);
      const col = ref
        ? [...ref].reduce((a, c) => a * 26 + (c.charCodeAt(0) - 64), 0) - 1
        : cells.length;
      while (cells.length < col) cells.push('');
      cells[col] = text ?? '';
    }
    if (!/^\d{4}-\d{2}-\d{2}$/.test(String(cells[0] ?? ''))) continue;
    n += 1;
    const tok = Number(cells[4] ?? 0);
    const cat = Number(cells[9] ?? 0);
    const cons = Number(cells[10] ?? 0);
    allT += tok;
    allC += cat;
    allK += cons;
    if (cons > 0) {
      posN += 1;
      posT += tok;
      posC += cat;
      posK += cons;
    }
  }
  return { n, posN, allT, posT, allC, posC, allK, posK };
}

async function main() {
  const db = await sumFromDb();
  const xlsx = fs.existsSync(XLSX) ? await sumFromXlsx(XLSX) : null;
  console.log(JSON.stringify({ db, xlsx }, null, 2));
  await prisma.$disconnect();
}

main().catch(async (e) => {
  console.error(e);
  await prisma.$disconnect();
  process.exit(1);
});
