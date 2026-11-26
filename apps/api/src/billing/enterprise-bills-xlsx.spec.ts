import JSZip from 'jszip';
import { PassThrough } from 'node:stream';
import { Prisma } from '@prisma/client';
import {
  aggregateDetailLinesByDayTenantModel,
  alignLedgerBreakdownToBill,
  buildEnterpriseBillXlsx,
  catalogUnitFromColumns,
  expandUsageDetailParts,
  formatEnterpriseBillUsageType,
  isExcludedDetailType,
  resolveCustomerMultiplier,
  splitUsageChannels,
  statsCaliberFilenameTag,
  summarizeUsageRowsLikeExportSql,
  UNATTRIBUTED_LEDGER_KEY,
  writeEnterpriseBillXlsx,
  type DetailLine,
  type LedgerBreakdown,
} from './enterprise-bills-xlsx';
import { sumUsdToCents, usd, usdToCents } from './money';

function colLettersToIndex(letters: string): number {
  let index = 0;
  for (const ch of letters) {
    index = index * 26 + (ch.charCodeAt(0) - 64);
  }
  return index - 1;
}

async function unzip(buffer: Buffer): Promise<Map<string, string[][]>> {
  const zip = await JSZip.loadAsync(buffer);
  const workbook = await zip.file('xl/workbook.xml')?.async('string');
  const names = [...(workbook ?? '').matchAll(/<sheet\b[^>]*\bname="([^"]+)"/g)].map((m) => m[1]);
  const sharedXml = await zip.file('xl/sharedStrings.xml')?.async('string') ?? '';
  const shared = [...sharedXml.matchAll(/<t[^>]*>([^<]*)<\/t>/g)].map((match) => match[1] ?? '');
  const out = new Map<string, string[][]>();
  for (let i = 0; i < names.length; i += 1) {
    const xml = await zip.file(`xl/worksheets/sheet${i + 1}.xml`)?.async('string') ?? '';
    const rows = [...xml.matchAll(/<row[^>]*>([\s\S]*?)<\/row>/g)].map((row) => {
      const cells: string[] = [];
      for (const cell of row[1].matchAll(/<c\b([^>/]*)(?:\/>|>([\s\S]*?)<\/c>)/g)) {
        const ref = cell[1].match(/\br="([A-Z]+)\d+"/)?.[1];
        const type = cell[1].match(/\bt="([^"]+)"/)?.[1];
        const inner = cell[2] ?? '';
        const inline = inner.match(/<is><t[^>]*>([^<]*)<\/t><\/is>/);
        const numeric = inner.match(/<v>([^<]*)<\/v>/)?.[1] ?? '';
        const text = inline?.[1] ?? (type === 's' ? shared[Number(numeric)] ?? numeric : numeric);
        const colIndex = ref ? colLettersToIndex(ref) : cells.length;
        while (cells.length < colIndex) cells.push('');
        cells[colIndex] = text;
      }
      return cells;
    });
    out.set(names[i], rows);
  }
  return out;
}

async function unzipMeta(buffer: Buffer): Promise<{
  styles: string;
  sheets: Map<string, string>;
}> {
  const zip = await JSZip.loadAsync(buffer);
  const styles = await zip.file('xl/styles.xml')?.async('string') ?? '';
  const workbook = await zip.file('xl/workbook.xml')?.async('string');
  const names = [...(workbook ?? '').matchAll(/<sheet\b[^>]*\bname="([^"]+)"/g)].map((m) => m[1]);
  const sheets = new Map<string, string>();
  for (let i = 0; i < names.length; i += 1) {
    sheets.set(names[i]!, await zip.file(`xl/worksheets/sheet${i + 1}.xml`)?.async('string') ?? '');
  }
  return { styles, sheets };
}



const enterpriseName = '瀚海云联科技有限公司';

describe('buildEnterpriseBillXlsx', () => {
  const bill = {
    consumeCents: 10_000,
    voucherCents: 1_000,
    chargeCents: 9_000,
    tokenTotal: 1_000_000,
    requestCount: 2,
    adjustedCents: -2_000,
    issuedVoucherCents: 0,
    receivableCents: 9_000,
    paidCents: 3_000,
    pendingCents: 4_000,
    status: '已核销',
    dueAt: '2026-10-30T15:59:59.000Z',
  };
  const events = [{
    type: 'WRITE_OFF',
    amountCents: 3_000,
    dueAt: null,
    note: '回款',
    createdAt: new Date('2026-09-05T04:00:00.000Z'),
  }];
  const usage = [
    {
      createdAt: new Date('2026-09-01T04:00:00.000Z'),
      tenantId: 'tenant-1',
      model: 'glm-5.1',
      callType: 'input',
      totalTokens: 600_000,
      unitPriceUsd: 0.000002,
      customerChargeUsd: 1.2,
      gatewayBillingEvent: {
        settlementAnchor: {
          customerPricingSnapshot: { customerMultiplier: '0.85' },
        },
      },
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
        },
      ],
    },
    {
      createdAt: new Date('2026-09-01T17:00:00.000Z'),
      tenantId: 'tenant-1',
      model: 'glm-5.1',
      callType: 'output',
      totalTokens: 400_000,
      unitPriceUsd: 0.000008,
      customerChargeUsd: 3.2,
    },
  ];
  const ledger: LedgerBreakdown = {
    byTenant: [
      { key: 'tenant-1', consumeCents: 10_000, voucherCents: 1_000 },
    ],
    byModel: [
      { key: 'glm-5.1', consumeCents: 10_000, voucherCents: 1_000 },
    ],
  };

  const baseInput = {
    yearMonth: '2026-09',
    currentMonth: false,
    exportedAt: new Date('2026-09-08T04:00:00.000Z'),
    enterpriseName,
    bill,
    events,
    usage,
    ledger,
  };

  it('builds closed-month caliber tag without putting it in sheets', async () => {
    const buffer = await buildEnterpriseBillXlsx(baseInput);
    const sheets = await unzip(buffer);
    const meta = await unzipMeta(buffer);
    const expectedCaliberTag = statsCaliberFilenameTag({
      yearMonth: '2026-09',
      currentMonth: false,
      exportedAt: baseInput.exportedAt,
    });

    expect([...sheets.keys()]).toEqual(['账单汇总', '产品模型汇总', '账单明细']);
    expect(expectedCaliberTag).toBe('数据截至2026年09月30日235959已定格');

    const summary = sheets.get('账单汇总')!;
    expect(summary[0][0]).toBe('瀚海云联科技有限公司—账单汇总');
    expect(summary[0][0]).not.toContain('2026-09');
    expect(summary[0][0]).not.toContain('数据截至');
    expect(summary[1][0]).toContain('账期：');
    expect(summary.flat().join('\n')).not.toContain('数据截至');
    const flat = summary.flat();
    expect(flat).toContain('合计（消耗金额）');
    expect(flat).toContain('代金券扣费');
    expect(flat).toContain('应收金额');
    expect(flat).not.toContain('调整金额');
    expect(flat).not.toContain('发券金额');
    expect(flat).not.toContain('已付款金额');
    expect(flat).not.toContain('待付款金额');
    const header = summary.find((row) => row.includes('账号ID'));
    expect(header).toEqual([
      '序号', '账号ID', '用量(token)', '目录总价(¥)', '折后金额(¥)', '折扣', '占比',
    ]);
    expect(summary.indexOf(header!)).toBe(2);
    const footerLabels = summary.slice(summary.indexOf(header!) + 1)
      .filter((row) => typeof row[0] === 'string' && !/^\d+$/.test(String(row[0])))
      .map((row) => row[0]);
    // 数据行后仅三行底栏（无多列「合计」行）
    expect(footerLabels).toEqual(['合计（消耗金额）', '代金券扣费', '应收金额']);
    const voucherRow = summary.find((row) => row[0] === '代金券扣费');
    expect(Number(voucherRow?.[4])).toBeLessThanOrEqual(0);
    expect(voucherRow?.slice(1, 4)).toEqual(['', '', '']);


    const byModel = sheets.get('产品模型汇总')!;
    expect(byModel[0][0]).toBe('瀚海云联科技有限公司—产品模型汇总');
    expect(byModel.flat().join('\n')).not.toContain('数据截至');
    const modelHeader = byModel.find((row) => row.includes('模型'));
    expect(modelHeader).toEqual([
      '序号', '模型', '用量（Token）', '目录总价(¥)', '折后金额(¥)', '折扣', '占比',
    ]);
    expect(byModel.indexOf(modelHeader!)).toBe(2);

    const detail = sheets.get('账单明细')!;
    expect(detail[0][0]).toBe('瀚海云联科技有限公司—账单明细');
    expect(detail.flat().join('\n')).not.toContain('数据截至');
    const detailHeader = detail.find((row) => row.includes('账期（自然日）'));
    expect(detailHeader).toEqual([
      '账期（自然日）',
      '账户ID',
      '模型',
      '类型',
      '用量',
      '目录单价',
      '单价单位',
      '折扣比',
      '币种',
      '目录价格',
      '总消耗金额',
      '账户支付金额',
      '信用支付金额',
      '欠款金额',
      '代金券抵扣金额',
      '已付款金额',
      '待付款金额',
      '结算状态',
    ]);
    expect(detail.indexOf(detailHeader!)).toBe(2);

    const dataRows = detail.slice(3);
    const beijingDays = dataRows.map((row) => row[0]).filter(Boolean);
    expect(beijingDays).toContain('2026-09-01');
    expect(beijingDays).toContain('2026-09-02');
    expect(beijingDays.some((day) => day.includes('T') || day.includes('Z'))).toBe(false);

    const accountIds = dataRows.map((row) => row[1]).filter(Boolean);
    expect(accountIds.length).toBeGreaterThan(0);
    expect(accountIds.every((id) => id === 'tenant-1')).toBe(true);

    expect(meta.styles).toContain('宋体');
    expect(meta.styles).toContain('微软雅黑');
    expect(meta.styles).toContain('27408B');
    expect(meta.styles).toContain('FFFFFFFF');
    expect(meta.styles).not.toContain('FEF3C7');
    expect(meta.styles).not.toContain('<font><b/><sz val="11"/><name val="宋体"/></font>');
    expect(meta.styles).toContain('val="20"');
    expect(meta.styles).toContain('horizontal="center"');
    expect(meta.styles).toContain('horizontal="right"');

    const summaryXml = meta.sheets.get('账单汇总')!;
    expect(summaryXml).toContain('<mergeCell ref="A1:G1"/>');
    expect(summaryXml).not.toContain('<mergeCell ref="A3:G3"/>');
    // 底栏三行标签合并 A–D，金额在 E
    expect(summaryXml).toMatch(/<mergeCell ref="A\d+:D\d+"\/>/);
    const footerConsume = summary.find((row) => row[0] === '合计（消耗金额）')!;
    const footerRowNum = summary.indexOf(footerConsume) + 1;
    expect(summaryXml).toContain(`<mergeCell ref="A${footerRowNum}:D${footerRowNum}"/>`);
    expect(summaryXml).toContain(`<mergeCell ref="A${footerRowNum + 1}:D${footerRowNum + 1}"/>`);
    expect(summaryXml).toContain(`<mergeCell ref="A${footerRowNum + 2}:D${footerRowNum + 2}"/>`);
    expect(summaryXml).toMatch(/<c r="A4"[^>]*><v>1<\/v><\/c>/);
    const modelXml = meta.sheets.get('产品模型汇总')!;
    expect(modelXml).toMatch(/<c r="A4"[^>]*><v>1<\/v><\/c>/);
    expect(summaryXml).toContain('customWidth="1"');
    expect(summaryXml).not.toMatch(/r="3"[^>]*ht="30"/);

    const detailXml = meta.sheets.get('账单明细')!;
    expect(detailXml).toContain('<mergeCell ref="A1:R1"/>');
    expect(detailXml).not.toContain('<mergeCell ref="A3:R3"/>');
  });

  it('builds current-month 未定格 caliber tag without putting it in sheets', async () => {
    const buffer = await buildEnterpriseBillXlsx({
      ...baseInput,
      currentMonth: true,
    });
    const sheets = await unzip(buffer);
    const expectedCaliberTag = statsCaliberFilenameTag({
      yearMonth: '2026-09',
      currentMonth: true,
      exportedAt: baseInput.exportedAt,
    });
    expect(expectedCaliberTag).toBe('数据截至2026年09月07日235959未定格');
    for (const rows of sheets.values()) {
      expect(rows[0][0]).not.toContain('未定格');
      expect(rows[0][0]).not.toContain('数据截至');
      expect(rows[0][0]).toContain(enterpriseName);
      expect(rows.flat().join('\n')).not.toContain('数据截至');
      expect(rows[1][0]).toContain('账期：');
    }
  });

  it('maps callType values to English Excel type labels', () => {
    expect(formatEnterpriseBillUsageType('input')).toBe('input');
    expect(formatEnterpriseBillUsageType('output')).toBe('output');
    expect(formatEnterpriseBillUsageType('cache read')).toBe('cache read');
    expect(formatEnterpriseBillUsageType('cache write')).toBe('cache write');
    expect(formatEnterpriseBillUsageType('输入 input')).toBe('input');
    expect(formatEnterpriseBillUsageType('输入')).toBe('input');
  });

  it('expands one token_usage into input/output/cache parts like finance apiUsage, ignoring misleading callType', () => {
    const parts = expandUsageDetailParts({
      createdAt: new Date('2026-09-01T04:00:00.000Z'),
      tenantId: 'tenant-1',
      model: 'glm-5.1',
      callType: 'input',
      totalTokens: 1600,
      promptTokens: 1000,
      cachedInputTokens: 200,
      cacheWriteInputTokens: 100,
      completionTokens: 300,
      inputPriceUsdPerM: 1,
      cachedInputPriceUsdPerM: 0.2,
      cacheWritePriceUsdPerM: 0.5,
      outputPriceUsdPerM: 2,
    });
    expect(parts.map((part) => [part.callType, part.totalTokens])).toEqual([
      ['input', 700],
      ['cache read', 200],
      ['cache write', 100],
      ['output', 300],
    ]);
  });

  it('writes day×tenant×model×类型 aggregated detail with one type per row', async () => {
    const buffer = await buildEnterpriseBillXlsx({
      ...baseInput,
      usage: [{
        createdAt: new Date('2026-09-01T04:00:00.000Z'),
        tenantId: 'tenant-1',
        model: 'glm-5.1',
        callType: 'input',
        totalTokens: 1500,
        promptTokens: 1000,
        cachedInputTokens: 0,
        completionTokens: 500,
        consumptionAllocations: [{
          amountUsd: 1.5,
          recognizedRevenueUsd: 1.5,
          bonusConsumedUsd: 0,
          approvedCreditUsd: 0,
          unapprovedDebtUsd: 0,
        }],
      }],
    });
    const detail = (await unzip(buffer)).get('账单明细')!;
    const dataRows = detail.slice(3);
    // 类型是分组条件：一行一个类型，不再拼成 input,output
    expect(dataRows).toHaveLength(2);
    expect(dataRows.map((row) => [row[3], row[4]])).toEqual([
      ['input', '1000'],
      ['output', '500'],
    ]);
    // 无单价时按 token 权重切分金额：1.5 × 1000/1500、1.5 × 500/1500
    expect(Number(dataRows[0]![10])).toBeCloseTo(1, 12);
    expect(Number(dataRows[1]![10])).toBeCloseTo(0.5, 12);
  });

  it('writes usage/money columns as real Excel numbers (not text) for status-bar sum', async () => {
    const buffer = await buildEnterpriseBillXlsx(baseInput);
    const meta = await unzipMeta(buffer);
    const detailXml = meta.sheets.get('账单明细')!;
    const summaryXml = meta.sheets.get('账单汇总')!;
    // 用量 / 金额：数值单元格 <v>，不是 inlineStr 文本（ExcelJS 的 xf id 不固定）
    expect(detailXml).toMatch(/<c r="E4"[^>]*><v>600000<\/v><\/c>/);
    expect(detailXml).toMatch(/<c r="K4"[^>]*><v>1\.2<\/v><\/c>/);
    expect(detailXml).not.toMatch(/<c r="E4"[^>]*t="inlineStr"/);
    expect(detailXml).not.toMatch(/<c r="E4"[^>]*t="s"/);
    expect(summaryXml).toMatch(/<c r="C4"[^>]*><v>\d+<\/v><\/c>/);
    expect(summaryXml).toMatch(/<c r="D4"[^>]*><v>/);
    expect(summaryXml).toMatch(/<c r="E4"[^>]*><v>/);
  });

  it('splits usage channels so 总消耗 = 信用 + 欠款 + 代金券 + 已付款 + 待付款', () => {
    const channels = splitUsageChannels(usage[0]!);
    expect(channels.totalAmount.toString()).toBe('1.2');
    expect(channels.voucherAmount.toString()).toBe('0.2');
    expect(channels.paidAmount.toString()).toBe('0.5');
    expect(channels.creditAmount.toString()).toBe('0');
    expect(channels.debtAmount.toString()).toBe('0.5');
    expect(channels.pendingAmount.toString()).toBe('0');
    expect(channels.totalAmount.toString()).toBe(
      channels.creditAmount
        .add(channels.debtAmount)
        .add(channels.voucherAmount)
        .add(channels.paidAmount)
        .add(channels.pendingAmount)
        .toString(),
    );
    expect(channels.settlementStatus).toBe('已结算');
  });

  it('keeps 欠款 at export precision so monthly 勾稽 can SUM USD then round once', () => {
    const rows = [0, 1, 2].map(() => splitUsageChannels({
      createdAt: new Date('2026-08-20T04:00:00.000Z'),
      totalTokens: 1,
      customerChargeUsd: '0.005',
      consumptionAllocations: [{
        balanceGrantId: null,
        source: 'ENTERPRISE_CREDIT',
        amountUsd: '0.005',
        recognizedRevenueUsd: 0,
        bonusConsumedUsd: 0,
        approvedCreditUsd: 0,
        unapprovedDebtUsd: '0.005',
        fundingClassificationComplete: true,
      }],
    }));
    expect(rows.map((row) => usdToCents(row.debtAmount)).reduce((total, cents) => total + cents, 0)).toBe(3);
    expect(sumUsdToCents(rows.map((row) => row.debtAmount))).toBe(2);
    expect(rows.reduce((total, row) => total.add(row.debtAmount), usd(0)).toString()).toBe('0.015');
  });

  it('classifies 结算状态 from 待付款 vs 总消耗', () => {
    expect(splitUsageChannels({
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      totalTokens: 0,
      customerChargeUsd: 0,
    }).settlementStatus).toBe('不适用');

    expect(splitUsageChannels({
      createdAt: new Date('2026-09-01T00:00:00.000Z'),
      totalTokens: 100,
      customerChargeUsd: 2,
      consumptionAllocations: [{
        amountUsd: 2,
        recognizedRevenueUsd: 0,
        bonusConsumedUsd: 0,
      }],
    }).settlementStatus).toBe('未结算');

    expect(splitUsageChannels(usage[0]!).settlementStatus).toBe('已结算');
    expect(splitUsageChannels(usage[1]!).settlementStatus).toBe('已结算');
  });

  it('writes 账单明细 结算状态 and skips 总消耗=0 from 汇总', async () => {
    const buffer = await buildEnterpriseBillXlsx({
      ...baseInput,
      usage: [
        usage[0]!,
        usage[1]!,
        {
          createdAt: new Date('2026-09-01T18:00:00.000Z'),
          tenantId: 'tenant-empty',
          model: 'glm-5.1',
          callType: 'input',
          totalTokens: 0,
          customerChargeUsd: 0,
        },
        {
          createdAt: new Date('2026-09-01T19:00:00.000Z'),
          tenantId: 'tenant-unpaid',
          model: 'glm-5.1',
          callType: 'input',
          totalTokens: 100,
          customerChargeUsd: 2,
          consumptionAllocations: [{
            amountUsd: 2,
            recognizedRevenueUsd: 0,
            bonusConsumedUsd: 0,
          }],
        },
      ],
    });
    const sheets = await unzip(buffer);
    const detail = sheets.get('账单明细')!.slice(3);
    expect(detail.map((row) => row[17])).toEqual([
      '已结算',
      '已结算',
      '不适用',
      '未结算',
    ]);

    const accountIds = sheets.get('账单汇总')!
      .slice(3)
      .filter((row) => /^\d+$/.test(String(row[0])))
      .map((row) => row[1]);
    expect(accountIds).toEqual(['tenant-1', 'tenant-unpaid']);
  });

  it('takes credit from API用量扣费 (approvedCreditUsd / amountUsd) and multiplier from settlement snapshot', () => {
    const financeStyle = {
      createdAt: new Date('2026-05-10T00:00:00Z'),
      totalTokens: 1000,
      customerChargeUsd: 7,
      customerChargePolicy: 'payg_balance',
      gatewayBillingEvent: {
        settlementAnchor: {
          customerPricingSnapshot: { customerMultiplier: '0.85' },
        },
      },
      consumptionAllocations: [
        {
          balanceGrantId: 'grant-1',
          source: 'BALANCE_GRANT',
          amountUsd: 4,
          recognizedRevenueUsd: 3,
          bonusConsumedUsd: 1,
        },
        {
          balanceGrantId: null,
          source: 'ENTERPRISE_CREDIT',
          amountUsd: 3,
          recognizedRevenueUsd: 0,
          bonusConsumedUsd: 0,
          approvedCreditUsd: 3,
          fundingClassificationComplete: true,
        },
      ],
    };
    const channels = splitUsageChannels(financeStyle);
    expect(channels.totalAmount.toString()).toBe('7');
    expect(channels.paidAmount.toString()).toBe('3');
    expect(channels.voucherAmount.toString()).toBe('1');
    expect(channels.creditAmount.toString()).toBe('3');
    expect(channels.pendingAmount.toString()).toBe('0');
    expect(resolveCustomerMultiplier(financeStyle)).toBe(0.85);
    expect(resolveCustomerMultiplier({
      createdAt: new Date(),
      totalTokens: 0,
    })).toBeNull();
    expect(resolveCustomerMultiplier({
      createdAt: new Date(),
      totalTokens: 0,
      gatewayBillingEvent: {
        settlementAnchor: {
          customerPricingSnapshot: { customerMultiplier: 'invalid' },
        },
      },
    })).toBeNull();
  });

  it('derives catalog unit from customer price / frozen multiplier when LIST is absent', () => {
    expect(Number(catalogUnitFromColumns(3, 2.4, 0.8))).toBe(3);
    expect(Number(catalogUnitFromColumns(null, 2.4, 0.8))).toBe(3);
    expect(Number(catalogUnitFromColumns(undefined, 2.4, null))).toBe(2.4);
    expect(Number(catalogUnitFromColumns(0, 2.4, 0.8))).toBe(3);
    expect(Number(catalogUnitFromColumns(null, 2.4, 0))).toBe(2.4);
  });

  it('writes frozen customerMultiplier into 账单明细 折扣比 when present', async () => {
    const buffer = await buildEnterpriseBillXlsx(baseInput);
    const detail = (await unzip(buffer)).get('账单明细')!;
    const firstData = detail[3]!;
    // usage[0] has customerMultiplier 0.85；单 callType 行不展开
    expect(Number(firstData[7])).toBeCloseTo(0.85, 12);
    // 账户支付 / 信用(额度内) / 欠款(未分类 ENTERPRISE_CREDIT)
    expect(Number(firstData[11])).toBeCloseTo(0.5, 12);
    expect(Number(firstData[12])).toBeCloseTo(0, 12);
    expect(Number(firstData[13])).toBeCloseTo(0.5, 12);
    expect(Number(firstData[15])).toBeCloseTo(0.5, 12);
  });

  it('fills 信用支付 from approvedCreditUsd when ENTERPRISE_CREDIT recognizedRevenue is 0', () => {
    const channels = splitUsageChannels({
      createdAt: new Date('2026-05-10T00:00:00Z'),
      totalTokens: 100,
      customerChargeUsd: 1.233456,
      customerChargePolicy: 'usage_charge',
      consumptionAllocations: [{
        balanceGrantId: null,
        source: 'ENTERPRISE_CREDIT',
        amountUsd: 1.233456,
        recognizedRevenueUsd: 0,
        bonusConsumedUsd: 0,
        approvedCreditUsd: 1.233456,
        fundingClassificationComplete: true,
      }],
    });
    expect(channels.totalAmount.toString()).toBe('1.233456');
    expect(channels.paidAmount.toString()).toBe('0');
    expect(channels.voucherAmount.toString()).toBe('0');
    expect(channels.creditAmount.toString()).toBe('1.233456');
    expect(channels.pendingAmount.toString()).toBe('0');
    expect(channels.settlementStatus).toBe('已结算');
  });

  it('falls back to customerChargeUsd when usage has no allocation (finance apiUsage口径)', () => {
    const fallback = splitUsageChannels(usage[1]!);
    expect(fallback.totalAmount.toString()).toBe('3.2');
    expect(fallback.paidAmount.toString()).toBe('3.2');
    expect(fallback.voucherAmount.toString()).toBe('0');
    expect(fallback.creditAmount.toString()).toBe('0');
    expect(fallback.pendingAmount.toString()).toBe('0');
    expect(fallback.settlementStatus).toBe('已结算');
  });

  it('falls back to abs(costUsd) when no allocation and customerChargeUsd is empty', () => {
    const fallback = splitUsageChannels({
      createdAt: new Date('2026-09-01T17:00:00.000Z'),
      totalTokens: 100,
      customerChargeUsd: 0,
      costUsd: -2.5,
      customerChargePolicy: 'legacy_cost_usd',
    });
    expect(fallback.totalAmount.toString()).toBe('2.5');
    expect(fallback.paidAmount.toString()).toBe('2.5');
    expect(fallback.voucherAmount.toString()).toBe('0');
  });

  it('prorates row money across 类型 rows by price basis with 12dp rounding', async () => {
    const buffer = await buildEnterpriseBillXlsx({
      ...baseInput,
      usage: [{
        createdAt: new Date('2026-09-01T04:00:00.000Z'),
        tenantId: 'tenant-1',
        model: 'glm-5.1',
        callType: 'input',
        totalTokens: 1500,
        promptTokens: 1000,
        cachedInputTokens: 0,
        completionTokens: 500,
        inputPriceUsdPerM: 1,
        outputPriceUsdPerM: 2,
        consumptionAllocations: [{
          amountUsd: 1.5,
          recognizedRevenueUsd: 1.0,
          bonusConsumedUsd: 0.5,
          approvedCreditUsd: 0,
          unapprovedDebtUsd: 0,
        }],
      }],
    });
    const detail = (await unzip(buffer)).get('账单明细')!;
    const dataRows = detail.slice(3);
    // 价基：1000×1/1e6 与 500×2/1e6 相等 ⇒ 金额对半切
    expect(dataRows.map((row) => [row[3], row[4]])).toEqual([
      ['input', '1000'],
      ['output', '500'],
    ]);
    for (const row of dataRows) {
      expect(Number(row[10])).toBeCloseTo(0.75, 12);
      expect(Number(row[11])).toBeCloseTo(0.5, 12);
      expect(Number(row[13])).toBeCloseTo(0, 12);
      expect(Number(row[14])).toBeCloseTo(0.25, 12);
      expect(Number(row[15])).toBeCloseTo(0.5, 12);
    }
    // 末位吃残差：两行合计逐位等于行级金额
    expect(Number(dataRows[0]![10]) + Number(dataRows[1]![10])).toBeCloseTo(1.5, 12);
  });

  it('merges same day×tenant×model usages into one detail row', () => {
    const merged = aggregateDetailLinesByDayTenantModel([
      {
        day: '2026-09-01',
        tenantId: 'tenant-1',
        model: 'glm-5.1',
        callType: 'input',
        tokens: 100,
        unitPriceUsd: 1,
        catalogAmount: usd(0.1),
        totalAmount: usd(0.08),
        creditAmount: usd(0),
        debtAmount: usd(0),
        voucherAmount: usd(0),
        paidAmount: usd(0.08),
        pendingAmount: usd(0),
        settlementStatus: '已结算',
        customerMultiplier: 0.8,
      },
      {
        day: '2026-09-01',
        tenantId: 'tenant-1',
        model: 'glm-5.1',
        callType: 'output',
        tokens: 50,
        unitPriceUsd: 2,
        catalogAmount: usd(0.1),
        totalAmount: usd(0.04),
        creditAmount: usd(0),
        debtAmount: usd(0),
        voucherAmount: usd(0),
        paidAmount: usd(0.04),
        pendingAmount: usd(0),
        settlementStatus: '已结算',
        customerMultiplier: 0.8,
      },
      {
        day: '2026-09-02',
        tenantId: 'tenant-1',
        model: 'glm-5.1',
        callType: 'input',
        tokens: 10,
        unitPriceUsd: 1,
        catalogAmount: usd(0.01),
        totalAmount: usd(0.01),
        creditAmount: usd(0),
        debtAmount: usd(0),
        voucherAmount: usd(0),
        paidAmount: usd(0.01),
        pendingAmount: usd(0),
        settlementStatus: '已结算',
        customerMultiplier: 0.8,
      },
    ]);
    // 类型是分组条件：同一「日×工作区×模型」下的 input / output 各自成行
    expect(merged).toHaveLength(3);
    expect(merged.map((line) => [line.day, line.callType, line.tokens])).toEqual([
      ['2026-09-01', 'input', 100],
      ['2026-09-01', 'output', 50],
      ['2026-09-02', 'input', 10],
    ]);
    expect(merged[0]).toMatchObject({
      day: '2026-09-01',
      tenantId: 'tenant-1',
      model: 'glm-5.1',
      callType: 'input',
      tokens: 100,
      settlementStatus: '已结算',
      customerMultiplier: 0.8,
    });
    expect(Number(merged[0]!.totalAmount)).toBeCloseTo(0.08, 12);
    expect(Number(merged[0]!.catalogAmount)).toBeCloseTo(0.1, 12);
    expect(Number(merged[0]!.unitPriceUsd)).toBeCloseTo(1, 12);
    expect(merged[2]!.day).toBe('2026-09-02');
    expect(merged[2]!.tokens).toBe(10);
  });

  it('groups detail by 折扣比 as well, so one day×tenant×model×类型 can split on multiplier', () => {
    const line = (overrides: Partial<DetailLine>): DetailLine => ({
      day: '2026-09-01',
      tenantId: 'tenant-1',
      model: 'glm-5.1',
      callType: 'input',
      tokens: 100,
      unitPriceUsd: 1,
      catalogAmount: usd(0.1),
      totalAmount: usd(0.085),
      creditAmount: usd(0),
      debtAmount: usd(0),
      voucherAmount: usd(0),
      paidAmount: usd(0.085),
      pendingAmount: usd(0),
      settlementStatus: '已结算',
      customerMultiplier: 0.85,
      ...overrides,
    });
    const merged = aggregateDetailLinesByDayTenantModel([
      line({}),
      line({ tokens: 200, catalogAmount: usd(0.2), totalAmount: usd(0.17), paidAmount: usd(0.17) }),
      line({ tokens: 300, catalogAmount: usd(0.3), totalAmount: usd(0.27), paidAmount: usd(0.27), customerMultiplier: 0.9 }),
      line({ tokens: 400, catalogAmount: usd(0.4), totalAmount: usd(0.34), paidAmount: usd(0.34), customerMultiplier: null }),
    ]);
    // 同倍率的行合并成一行，不同倍率（含无冻结倍率）各自成行
    expect(merged.map((row) => [row.customerMultiplier, row.tokens])).toEqual([
      [0.85, 300],
      [0.9, 300],
      [null, 400],
    ]);
    expect(Number(merged[0]!.totalAmount)).toBeCloseTo(0.255, 12);
    expect(Number(merged[0]!.catalogAmount)).toBeCloseTo(0.3, 12);
  });

  it('keeps only token-dimension types on 账单明细', () => {
    const base = {
      day: '2026-09-01',
      tenantId: 'tenant-1',
      model: 'glm-5.1',
      tokens: 0,
      unitPriceUsd: 0,
      catalogAmount: usd(0),
      totalAmount: usd(0),
      creditAmount: usd(0),
      debtAmount: usd(0),
      voucherAmount: usd(0),
      paidAmount: usd(0),
      pendingAmount: usd(0),
      settlementStatus: '已结算',
      customerMultiplier: null,
    } as const;
    expect(isExcludedDetailType('input')).toBe(false);
    expect(isExcludedDetailType('cache read')).toBe(false);
    expect(isExcludedDetailType('cache_write')).toBe(false);
    expect(isExcludedDetailType('输出')).toBe(false);
    expect(isExcludedDetailType('total')).toBe(false);
    expect(isExcludedDetailType('chat')).toBe(true);
    expect(isExcludedDetailType('chat ')).toBe(true);
    expect(isExcludedDetailType('zhipu_chat')).toBe(true);
    expect(isExcludedDetailType('image_generation')).toBe(true);
    expect(isExcludedDetailType('')).toBe(true);
    const merged = aggregateDetailLinesByDayTenantModel([
      { ...base, callType: 'chat' },
      { ...base, callType: 'zhipu_chat' },
      { ...base, callType: 'image_generation', tokens: 3 },
      { ...base, callType: 'input', tokens: 10 },
      { ...base, callType: 'output', tokens: 5 },
      { ...base, callType: 'cache read', tokens: 2 },
      { ...base, callType: 'total', tokens: 1 },
    ]);
    expect(merged.map((row) => row.callType)).toEqual([
      'input',
      'cache read',
      'output',
      'total',
    ]);
  });

  it('omits zero-token zhipu_chat fallback rows from 账单明细', async () => {
    const buffer = await buildEnterpriseBillXlsx({
      ...baseInput,
      usage: [
        {
          createdAt: new Date('2026-09-01T04:00:00.000Z'),
          tenantId: 'tenant-1',
          model: 'glm-5.3',
          callType: 'zhipu_chat',
          totalTokens: 0,
          promptTokens: 0,
          cachedInputTokens: 0,
          cacheWriteInputTokens: 0,
          completionTokens: 0,
          unitPriceUsd: 0.55,
          customerChargeUsd: 0,
        },
        {
          createdAt: new Date('2026-09-01T05:00:00.000Z'),
          tenantId: 'tenant-1',
          model: 'glm-5.3',
          callType: 'zhipu_chat',
          totalTokens: 1000,
          promptTokens: 1000,
          completionTokens: 0,
          unitPriceUsd: 0.55,
          customerChargeUsd: 0.55,
        },
      ],
    });
    const dataRows = (await unzip(buffer)).get('账单明细')!.slice(3);
    expect(dataRows.map((row) => row[3])).toEqual(['input']);
    expect(dataRows.map((row) => row[3])).not.toContain('zhipu_chat');
  });

  it('rolls summary catalog/discounted amounts from detail 目录价格 and 总消耗金额', async () => {
    const buffer = await buildEnterpriseBillXlsx(baseInput);
    const sheets = await unzip(buffer);
    const detail = sheets.get('账单明细')!.slice(3);
    const summary = sheets.get('账单汇总')!;
    const accountRow = summary.find((row) => row[1] === 'tenant-1')!;

    const detailConsume = detail.reduce((sum, row) => sum + Number(row[10] ?? 0), 0);
    const detailCatalog = detail.reduce((sum, row) => sum + Number(row[9] ?? 0), 0);
    const detailTokens = detail.reduce((sum, row) => sum + Number(row[4] ?? 0), 0);
    expect(Number(accountRow[2])).toBe(detailTokens);
    expect(Number(accountRow[4])).toBeCloseTo(detailConsume, 12);
    expect(Number(accountRow[3])).toBeCloseTo(detailCatalog, 12);
    expect(accountRow[6]).toBe('100.00%');
    if (detailCatalog > 0) {
      expect(String(accountRow[5])).toMatch(/^\d+\.\d{2}%$/);
    }


    const modelSheet = sheets.get('产品模型汇总')!;
    const modelRow = modelSheet.find((row) => row[1] === 'glm-5.1')!;
    expect(Number(modelRow[2])).toBe(detailTokens);
    expect(Number(modelRow[3])).toBeCloseTo(detailCatalog, 12);
    expect(Number(modelRow[4])).toBeCloseTo(detailConsume, 12);
  });

  it('puts 账单明细 after summary sheets and still aggregates from every split detail sheet', async () => {
    const splitUsage = [0, 1, 2, 3].map((i) => ({
      createdAt: new Date(Date.UTC(2026, 8, 1 + i, 4, 0, 0)),
      tenantId: 'tenant-1',
      model: 'glm-5.1',
      callType: 'input',
      totalTokens: 1_000_000 * (i + 1),
      unitPriceUsd: 2,
      consumptionAllocations: [{
        amountUsd: 0.5 * (i + 1),
        recognizedRevenueUsd: 0.5 * (i + 1),
        bonusConsumedUsd: 0,
        approvedCreditUsd: 0,
        unapprovedDebtUsd: 0,
      }],
    }));
    const buffer = await buildEnterpriseBillXlsx({
      ...baseInput,
      usage: splitUsage,
      // 标题+账期+表头占 3 行；数据容量=2，跨自然日拆成多个明细 sheet
      maxDetailRows: 5,
    });
    const sheets = await unzip(buffer);
    const names = [...sheets.keys()];
    expect(names.slice(0, 2)).toEqual(['账单汇总', '产品模型汇总']);
    expect(names.slice(2).every((name) => name.startsWith('账单明细'))).toBe(true);
    const detailSheets = [...sheets.entries()].filter(([name]) => name.startsWith('账单明细'));
    expect(detailSheets.length).toBeGreaterThan(1);

    let tokens = 0;
    let catalog = 0;
    let consume = 0;
    for (const [, rows] of detailSheets) {
      for (const row of rows.slice(3)) {
        tokens += Number(row[4] ?? 0);
        catalog += Number(row[9] ?? 0);
        consume += Number(row[10] ?? 0);
      }
    }

    const summary = sheets.get('账单汇总')!;
    const accountRow = summary.find((row) => row[1] === 'tenant-1')!;
    expect(Number(accountRow[2])).toBe(tokens);
    expect(Number(accountRow[3])).toBeCloseTo(catalog, 12);
    expect(Number(accountRow[4])).toBeCloseTo(consume, 12);

    const modelTotal = sheets.get('产品模型汇总')!.find((row) => row[0] === '总计')!;
    expect(Number(modelTotal[2])).toBe(tokens);
    expect(Number(modelTotal[3])).toBeCloseTo(catalog, 12);
    expect(Number(modelTotal[4])).toBeCloseTo(consume, 12);
  });

  it('splits 账单明细 when one calendar day exceeds the sheet row cap', async () => {
    // 同日不同模型 → 聚合后仍多行，才能触发按行数拆 sheet
    const sameDayUsage = [0, 1, 2, 3, 4].map((i) => ({
      createdAt: new Date(Date.UTC(2026, 8, 1, 4, i, 0)),
      tenantId: 'tenant-1',
      model: `glm-5.${i}`,
      callType: 'input',
      totalTokens: 1_000_000 * (i + 1),
      unitPriceUsd: 2,
      consumptionAllocations: [{
        amountUsd: 0.5 * (i + 1),
        recognizedRevenueUsd: 0.5 * (i + 1),
        bonusConsumedUsd: 0,
        approvedCreditUsd: 0,
        unapprovedDebtUsd: 0,
      }],
    }));
    const buffer = await buildEnterpriseBillXlsx({
      ...baseInput,
      usage: sameDayUsage,
      // 数据容量=2；5 个同日不同模型行必须拆成 账单明细 / 账单明细-2 / 账单明细-3
      maxDetailRows: 5,
    });
    const sheets = await unzip(buffer);
    const detailSheets = [...sheets.entries()].filter(([name]) => name.startsWith('账单明细'));
    expect(detailSheets.map(([name]) => name)).toEqual(['账单明细', '账单明细-2', '账单明细-3']);
    expect(detailSheets.map(([, rows]) => rows.slice(3).length)).toEqual([2, 2, 1]);
    expect(detailSheets.flatMap(([, rows]) => rows.slice(3).map((row) => row[0]))).toEqual(
      Array(5).fill('2026-09-01'),
    );

    let tokens = 0;
    let catalog = 0;
    let consume = 0;
    for (const [, rows] of detailSheets) {
      for (const row of rows.slice(3)) {
        tokens += Number(row[4] ?? 0);
        catalog += Number(row[9] ?? 0);
        consume += Number(row[10] ?? 0);
      }
    }
    const accountRow = sheets.get('账单汇总')!.find((row) => row[1] === 'tenant-1')!;
    expect(Number(accountRow[2])).toBe(tokens);
    expect(Number(accountRow[3])).toBeCloseTo(catalog, 12);
    expect(Number(accountRow[4])).toBeCloseTo(consume, 12);
  });

  it('aligns account/model money totals and derives footer from detail (consume − voucher)', async () => {
    const partialLedger: LedgerBreakdown = {
      byTenant: [
        { key: 'tenant-1', consumeCents: 7_000, voucherCents: 400 },
        { key: 'tenant-2', consumeCents: 2_000, voucherCents: 300 },
      ],
      byModel: [
        { key: 'glm-5.1', consumeCents: 8_000, voucherCents: 500 },
      ],
    };
    const aligned = alignLedgerBreakdownToBill(partialLedger, bill);
    expect(aligned.byTenant.reduce((sum, row) => sum + row.consumeCents, 0)).toBe(bill.consumeCents);
    expect(aligned.byTenant.reduce((sum, row) => sum + row.voucherCents, 0)).toBe(bill.voucherCents);
    expect(aligned.byModel.reduce((sum, row) => sum + row.consumeCents, 0)).toBe(bill.consumeCents);
    expect(aligned.byTenant.some((row) => row.key === UNATTRIBUTED_LEDGER_KEY)).toBe(true);

    const buffer = await buildEnterpriseBillXlsx({
      ...baseInput,
      prepaid: false,
      usage: [
        ...usage,
        {
          createdAt: new Date('2026-09-01T05:00:00.000Z'),
          tenantId: 'tenant-2',
          model: 'glm-5.1',
          callType: 'input',
          totalTokens: 100,
          customerChargeUsd: 0.5,
        },
      ],
      ledger: partialLedger,
    });
    const sheets = await unzip(buffer);
    const summary = sheets.get('账单汇总')!;
    const accountIds = summary.map((row) => row[1]);
    expect(accountIds).toContain('tenant-1');
    expect(accountIds).toContain('tenant-2');
    expect(summary.some((row) => row[0] === '合计')).toBe(false);

    const consumeFooter = summary.find((row) => row[0] === '合计（消耗金额）')!;
    const voucherFooter = summary.find((row) => row[0] === '代金券扣费')!;
    const receivableFooter = summary.find((row) => row[0] === '应收金额')!;
    const detail = sheets.get('账单明细')!.slice(3);
    const detailConsume = detail.reduce((sum, row) => sum + Number(row[10] ?? 0), 0);
    const detailVoucher = detail.reduce((sum, row) => sum + Number(row[14] ?? 0), 0);
    expect(Number(consumeFooter[4])).toBeCloseTo(Math.round(detailConsume * 10000) / 10000, 4);
    expect(Number(voucherFooter[4])).toBeCloseTo(-Math.round(detailVoucher * 10000) / 10000, 4);
    expect(Number(receivableFooter[4])).toBeCloseTo(
      Number(consumeFooter[4]) - Math.abs(Number(voucherFooter[4])),
      4,
    );
    expect(Number(consumeFooter[4]).toFixed(4)).toMatch(/^-?\d+\.\d{4}$/);
    expect(Number(voucherFooter[4]).toFixed(4)).toMatch(/^-?\d+\.\d{4}$/);
    expect(Number(receivableFooter[4]).toFixed(4)).toMatch(/^-?\d+\.\d{4}$/);

    const detailConsumeByTenant = new Map<string, number>();
    for (const row of detail) {
      const tenant = String(row[1] ?? '');
      detailConsumeByTenant.set(tenant, (detailConsumeByTenant.get(tenant) ?? 0) + Number(row[10] ?? 0));
    }
    const tenant1 = summary.find((row) => row[1] === 'tenant-1')!;
    const tenant2 = summary.find((row) => row[1] === 'tenant-2')!;
    expect(Number(tenant1[4])).toBeCloseTo(detailConsumeByTenant.get('tenant-1') ?? 0, 12);
    expect(Number(tenant2[4])).toBeCloseTo(detailConsumeByTenant.get('tenant-2') ?? 0, 12);

    const modelSheet = sheets.get('产品模型汇总')!;
    const modelTotal = modelSheet.find((row) => row[0] === '总计')!;
    const modelDataRows = modelSheet.filter((row) =>
      row.length >= 6 && row[1] && row[1] !== '' && row[0] !== '序号');
    const modelDiscounted = modelDataRows.reduce((sum, row) => sum + Number(row[4] ?? 0), 0);
    expect(Number(modelTotal[4])).toBeCloseTo(modelDiscounted, 12);
  });

  it('streams each natural day before pulling the next one when summary is precomputed', async () => {
    const progress: number[] = [];
    const makeRow = (createdAt: string, tenantId: string, amount: number) => ({
      createdAt: new Date(createdAt),
      tenantId,
      model: 'glm-5.1',
      callType: 'input',
      totalTokens: 100,
      customerChargeUsd: amount,
    });
    const buffer = await buildEnterpriseBillXlsx({
      ...baseInput,
      summary: {
        byTenant: new Map([
          ['tenant-1', { key: 'tenant-1', tokens: 400, catalogAmount: new Prisma.Decimal(0), discountedAmount: new Prisma.Decimal(2) }],
          ['tenant-2', { key: 'tenant-2', tokens: 100, catalogAmount: new Prisma.Decimal(0), discountedAmount: new Prisma.Decimal(0.5) }],
        ]),
        byModel: new Map([
          ['glm-5.1', { key: 'glm-5.1', tokens: 500, catalogAmount: new Prisma.Decimal(0), discountedAmount: new Prisma.Decimal(2.5) }],
        ]),
        footerConsume: new Prisma.Decimal(2.5),
        footerVoucher: new Prisma.Decimal(0),
      },
      usage: async function* dayByDayUsage() {
        yield [
          makeRow('2026-09-01T04:00:00.000Z', 'tenant-1', 0.5),
          makeRow('2026-09-01T05:00:00.000Z', 'tenant-2', 0.5),
        ];
        yield [makeRow('2026-09-01T06:00:00.000Z', 'tenant-1', 0.5)];
        yield [makeRow('2026-09-02T04:00:00.000Z', 'tenant-1', 0.5)];
        // 还没读到后续自然日，前面日期的明细行就必须已经写出：内存只随单日增长。
        expect(progress.at(-1) ?? 0).toBeGreaterThan(0);
        yield [makeRow('2026-09-03T04:00:00.000Z', 'tenant-1', 0.5)];
      },
      onDetailRowsWritten: (written) => progress.push(written),
    });

    expect(progress.length).toBeGreaterThanOrEqual(2);
    expect(progress.at(-1)).toBe(4);
    const detail = (await unzip(buffer)).get('账单明细')!.slice(3);
    expect(detail.map((row) => [row[0], row[1]])).toEqual([
      ['2026-09-01', 'tenant-1'],
      ['2026-09-01', 'tenant-2'],
      ['2026-09-02', 'tenant-1'],
      ['2026-09-03', 'tenant-1'],
    ]);
  });

  it('derives 汇总 from the same single pass and matches the SQL mirror', async () => {
    let scans = 0;
    const buffer = await buildEnterpriseBillXlsx({
      ...baseInput,
      usage: async function* once() {
        scans += 1;
        yield usage;
      },
    });
    expect(scans).toBe(1);

    const mirror = summarizeUsageRowsLikeExportSql(usage);
    const sheets = await unzip(buffer);
    const accountRow = sheets.get('账单汇总')!.find((row) => row[1] === 'tenant-1')!;
    const modelRow = sheets.get('产品模型汇总')!.find((row) => row[1] === 'glm-5.1')!;
    const tenantBucket = mirror.byTenant.get('tenant-1')!;
    const modelBucket = mirror.byModel.get('glm-5.1')!;
    expect(Number(accountRow[2])).toBe(tenantBucket.tokens);
    expect(Number(accountRow[4])).toBeCloseTo(Number(tenantBucket.discountedAmount), 12);
    expect(Number(modelRow[2])).toBe(modelBucket.tokens);
    expect(Number(modelRow[4])).toBeCloseTo(Number(modelBucket.discountedAmount), 12);
    const footer = sheets.get('账单汇总')!.find((row) => row[0] === '合计（消耗金额）')!;
    expect(Number(footer[4])).toBeCloseTo(
      Math.round(Number(mirror.footerConsume) * 10000) / 10000,
      4,
    );
  });

  it('writes the same sheets when usage arrives as pages instead of one array', async () => {
    const fromArray = await unzip(await buildEnterpriseBillXlsx(baseInput));
    const fromPages = await unzip(await buildEnterpriseBillXlsx({
      ...baseInput,
      usage: async function* pageUsage() {
        for (const row of usage) {
          yield [row];
        }
      },
    }));
    expect([...fromPages.keys()]).toEqual([...fromArray.keys()]);
    expect(fromPages.get('账单明细')?.slice(3)).toEqual(fromArray.get('账单明细')?.slice(3));
    expect(fromPages.get('账单汇总')?.find((row) => row[0] === '合计（消耗金额）')).toEqual(
      fromArray.get('账单汇总')?.find((row) => row[0] === '合计（消耗金额）'),
    );
  });

  it('uses LIST catalog prices so enterprise model discount appears below 100%', async () => {
    const buffer = await buildEnterpriseBillXlsx({
      ...baseInput,
      usage: [{
        createdAt: new Date('2026-09-01T04:00:00.000Z'),
        tenantId: 'tenant-1',
        model: 'deepseek-v4-flash',
        callType: 'input',
        totalTokens: 100,
        promptTokens: 84,
        completionTokens: 16,
        inputPriceUsdPerM: 2.4,
        outputPriceUsdPerM: 7.2,
        listInputPriceUsdPerM: 3,
        listOutputPriceUsdPerM: 9,
        consumptionAllocations: [{
          amountUsd: 0.0003168,
          recognizedRevenueUsd: 0.0003168,
          bonusConsumedUsd: 0,
          approvedCreditUsd: 0,
          unapprovedDebtUsd: 0,
        }],
      }],
    });
    const sheets = await unzip(buffer);
    const modelRow = sheets.get('产品模型汇总')!.find((row) => row[1] === 'deepseek-v4-flash')!;
    // 目录 = 84*3/1e6 + 16*9/1e6 = 0.000396；折后 = 0.0003168 → 80%
    expect(Number(modelRow[3])).toBeCloseTo(0.000396, 12);
    expect(Number(modelRow[4])).toBeCloseTo(0.0003168, 12);
    expect(modelRow[5]).toBe('80.00%');

    const detail = sheets.get('账单明细')!.slice(3);
    // 类型分组后每个分量各自成行，目录单价直接就是该分量的 LIST 价
    expect(detail.map((row) => [row[3], Number(row[4]), Number(row[5])])).toEqual([
      ['input', 84, 3],
      ['output', 16, 9],
    ]);
    expect(Number(detail[0]![7])).toBeCloseTo(0.8, 12);
    expect(Number(detail[1]![7])).toBeCloseTo(0.8, 12);
    // 只读一行也不再需要「目录价格/用量」反推
    expect(Number(detail[0]![9]) + Number(detail[1]![9])).toBeCloseTo(0.000396, 12);
  });

  it('derives LIST catalog from customer unit / snapshot multiplier without a price lookup', async () => {
    const buffer = await buildEnterpriseBillXlsx({
      ...baseInput,
      usage: [{
        createdAt: new Date('2026-09-01T04:00:00.000Z'),
        tenantId: 'tenant-1',
        model: 'deepseek-v4-flash',
        callType: 'input',
        totalTokens: 100,
        promptTokens: 84,
        completionTokens: 16,
        inputPriceUsdPerM: 2.4,
        outputPriceUsdPerM: 7.2,
        customerMultiplier: 0.8,
        consumptionAllocations: [{
          amountUsd: 0.0003168,
          recognizedRevenueUsd: 0.0003168,
          bonusConsumedUsd: 0,
          approvedCreditUsd: 0,
          unapprovedDebtUsd: 0,
        }],
      }],
    });
    const sheets = await unzip(buffer);
    const modelRow = sheets.get('产品模型汇总')!.find((row) => row[1] === 'deepseek-v4-flash')!;
    expect(Number(modelRow[3])).toBeCloseTo(0.000396, 12);
    expect(Number(modelRow[4])).toBeCloseTo(0.0003168, 12);
    expect(modelRow[5]).toBe('80.00%');

    const detail = sheets.get('账单明细')!.slice(3);
    expect(detail.map((row) => [row[3], Number(row[4]), Number(row[5])])).toEqual([
      ['input', 84, 3],
      ['output', 16, 9],
    ]);
    expect(Number(detail[0]![7])).toBeCloseTo(0.8, 12);
    expect(Number(detail[1]![7])).toBeCloseTo(0.8, 12);
  });

  it('summarizeUsageRowsLikeExportSql uses per-M catalog units when unit_price is empty', () => {
    const summary = summarizeUsageRowsLikeExportSql([{
      createdAt: new Date('2026-09-01T04:00:00.000Z'),
      tenantId: 'tenant-1',
      model: 'deepseek-v4-flash',
      callType: 'input',
      totalTokens: 100,
      promptTokens: 84,
      completionTokens: 16,
      unitPriceUsd: null,
      inputPriceUsdPerM: 2.4,
      outputPriceUsdPerM: 7.2,
      customerMultiplier: 0.8,
      consumptionAllocations: [{
        amountUsd: 0.0003168,
        recognizedRevenueUsd: 0.0003168,
        bonusConsumedUsd: 0,
        approvedCreditUsd: 0,
        unapprovedDebtUsd: 0,
      }],
    }]);
    const model = summary.byModel.get('deepseek-v4-flash')!;
    expect(model.tokens).toBe(100);
    expect(Number(model.catalogAmount)).toBeCloseTo(0.000396, 12);
    expect(Number(model.discountedAmount)).toBeCloseTo(0.0003168, 12);
    expect(Number(summary.footerConsume)).toBeCloseTo(0.0003168, 12);
  });

  it('writes summary sheets before iterating usage when summary is precomputed', async () => {
    let usagePages = 0;
    let firstChunkBeforeUsage = false;
    const dest = new PassThrough();
    dest.once('data', () => {
      firstChunkBeforeUsage = usagePages === 0;
    });
    const finished = new Promise<void>((resolve, reject) => {
      dest.on('finish', () => resolve());
      dest.on('error', reject);
    });
    await writeEnterpriseBillXlsx({
      yearMonth: '2026-09',
      currentMonth: false,
      exportedAt: new Date('2026-10-01T00:00:00.000Z'),
      enterpriseName,
      bill,
      events,
      ledger: { byTenant: [], byModel: [] },
      summary: {
        byTenant: new Map([['tenant-1', {
          key: 'tenant-1',
          tokens: 100,
          catalogAmount: new Prisma.Decimal(1),
          discountedAmount: new Prisma.Decimal(0.8),
        }]]),
        byModel: new Map([['glm-5.1', {
          key: 'glm-5.1',
          tokens: 100,
          catalogAmount: new Prisma.Decimal(1),
          discountedAmount: new Prisma.Decimal(0.8),
        }]]),
        footerConsume: new Prisma.Decimal(0.8),
        footerVoucher: new Prisma.Decimal(0),
      },
      usage: async function* usage() {
        usagePages += 1;
        yield [{
          createdAt: new Date('2026-09-01T04:00:00.000Z'),
          tenantId: 'tenant-1',
          model: 'glm-5.1',
          callType: 'input',
          totalTokens: 100,
          unitPriceUsd: 10_000,
          consumptionAllocations: [{
            amountUsd: 0.8,
            recognizedRevenueUsd: 0.8,
            bonusConsumedUsd: 0,
            approvedCreditUsd: 0,
            unapprovedDebtUsd: 0,
          }],
        }];
      },
      dest,
    });
    await finished;
    expect(firstChunkBeforeUsage).toBe(true);
    expect(usagePages).toBe(1);
  });

  it('fails the export when written 明细 totals do not match 汇总', async () => {
    await expect(buildEnterpriseBillXlsx({
      ...baseInput,
      usage: [],
      summary: {
        byTenant: new Map([['tenant-1', {
          key: 'tenant-1',
          tokens: 100,
          catalogAmount: new Prisma.Decimal(1),
          discountedAmount: new Prisma.Decimal(0.8),
        }]]),
        byModel: new Map([['glm-5.1', {
          key: 'glm-5.1',
          tokens: 100,
          catalogAmount: new Prisma.Decimal(1),
          discountedAmount: new Prisma.Decimal(0.8),
        }]]),
        footerConsume: new Prisma.Decimal(0.8),
        footerVoucher: new Prisma.Decimal(0),
      },
    })).rejects.toThrow(/enterprise bill export detail mismatch/);
  });
});
