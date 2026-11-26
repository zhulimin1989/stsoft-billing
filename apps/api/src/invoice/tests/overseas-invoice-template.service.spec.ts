import ExcelJS from 'exceljs';
import {
  OverseasInvoiceTemplateService,
  buildOverseasInvoiceLines,
  buildOverseasInvoiceProductRows,
} from '../overseas-invoice-template.service';
import { shanghaiYmd, type PsaMappableInvoiceApplication } from '../psa-invoice.mapper';

const service = new OverseasInvoiceTemplateService();
const ISSUE_DATE = new Date('2026-09-19T16:00:00.000Z'); // 上海 2026-09-20

function baseApp(overrides: Partial<PsaMappableInvoiceApplication> = {}): PsaMappableInvoiceApplication {
  return {
    applicationNo: 'IA-20260920-abc123',
    subtotalCents: 12345,
    totalCents: 12345,
    currency: 'USD',
    profileSnapshot: {
      kind: 'PERSONAL',
      invoiceType: 'COMMERCIAL_HK',
      title: 'Alice Chan',
      recipientEmail: 'alice@example.com',
      recipientAddress: '88 Queensway, Hong Kong',
      registeredAddress: 'Beijing office',
    },
    items: [{
      principalCents: 12345,
      description: 'RAYTONE_API',
      productName: 'Raytone API',
      orderId: 'order-api-1',
      serviceStart: new Date('2026-07-31T16:00:00.000Z'),
      serviceEnd: new Date('2026-08-31T15:59:59.999Z'),
      poNumber: 'PO-88',
    }],
    ...overrides,
  };
}

async function readFilled(app: PsaMappableInvoiceApplication) {
  const filled = await service.fill(app, { issueDate: ISSUE_DATE });
  const workbook = new ExcelJS.Workbook();
  await workbook.xlsx.load(filled.buffer as never);
  const sheet = workbook.getWorksheet('Invoice Template');
  if (!sheet) throw new Error('missing sheet');
  return { filled, workbook, sheet };
}

function formulaOf(cell: ExcelJS.Cell): string {
  const value = cell.value;
  if (value && typeof value === 'object' && 'formula' in value) {
    return String((value as ExcelJS.CellFormulaValue).formula || '').replace(/^=/, '');
  }
  return '';
}

function cellShanghaiYmd(value: unknown): string {
  if (value instanceof Date && !Number.isNaN(value.getTime())) {
    return shanghaiYmd(value);
  }
  if (value && typeof value === 'object' && 'result' in value) {
    return cellShanghaiYmd((value as { result: unknown }).result);
  }
  throw new Error(`expected Date, got ${JSON.stringify(value)}`);
}

function cellValue(cell: ExcelJS.Cell): unknown {
  return cell.value ?? null;
}

function hasVisibleBorder(cell: ExcelJS.Cell): boolean {
  const border = cell.border;
  if (!border) return false;
  return (['top', 'bottom', 'left', 'right'] as const).some((side) => Boolean(border[side]?.style));
}

function tokenPlanItem(): PsaMappableInvoiceApplication['items'][number] {
  return {
    principalCents: 20000,
    description: 'TOKEN_PLAN',
    productName: 'Token Plan',
    orderId: 'order-tp-1',
    poNumber: 'PO-TP',
    order: { id: 'order-tp-1', paidAt: new Date('2026-07-15T08:00:00.000Z') },
  };
}

describe('OverseasInvoiceTemplateService', () => {
  it('统一模板：H5 不填发票号，C12/C13/C14=title/email/recipientAddress，保留 logo', async () => {
    const { filled, sheet } = await readFilled(baseApp());
    expect(filled.kind).toBe('PERSONAL');
    expect(filled.fileName).toBe('IA-20260920-abc123.xlsx');
    expect(cellValue(sheet.getCell('H5'))).toBeNull();
    expect(sheet.getCell('B12').value).toBe('Customer Name:');
    expect(sheet.getCell('B13').value).toBe('Customer Email:');
    expect(sheet.getCell('B14').value).toBe('Customer Address:');
    expect(sheet.getCell('B12').isMerged).toBe(false);
    expect(sheet.getCell('C12').isMerged).toBe(true);
    expect(sheet.getCell('C12').value).toBe('Alice Chan');
    expect(sheet.getCell('C13').value).toBe('alice@example.com');
    expect(sheet.getCell('C14').value).toBe('88 Queensway, Hong Kong');
    expect(sheet.getCell('B5').value).toContain('iSoftStone Information Technology Hong Kong Limited');
    expect(formulaOf(sheet.getCell('H6'))).toBe('');
    expect(sheet.getImages().length).toBeGreaterThan(0);
  });

  it('企业用户也走同一模板：seller 仍是 iSoftStone，Bill To 含 email', async () => {
    const { sheet } = await readFilled(baseApp({
      profileSnapshot: {
        kind: 'ENTERPRISE',
        title: 'Acme HK Ltd',
        recipientEmail: 'billing@acme.hk',
        recipientAddress: '1 Harbour Road, Wan Chai',
        registeredAddress: 'should-not-appear',
      },
      items: [
        {
          principalCents: 12345,
          description: 'RAYTONE_API',
          productName: 'Raytone API',
          orderId: 'order-api-1',
        },
        tokenPlanItem(),
      ],
    }));
    expect(sheet.getCell('B5').value).toContain('iSoftStone Information Technology Hong Kong Limited');
    expect(sheet.getCell('C12').value).toBe('Acme HK Ltd');
    expect(sheet.getCell('C13').value).toBe('billing@acme.hk');
    expect(sheet.getCell('C14').value).toBe('1 Harbour Road, Wan Chai');
    expect(String(sheet.getCell('B28').value || '')).toContain('iSoftStone Information Technology Hong Kong Limited');
  });

  it('只有一项产品时删除空行，SN 从 1 起；Description 按实际产品写', async () => {
    const apiOnly = await readFilled(baseApp());
    expect(apiOnly.sheet.getCell('B19').value).toBe(1);
    expect(apiOnly.sheet.getCell('C19').value).toBe('Raytone API');
    expect(apiOnly.sheet.getCell('D19').value).toBe(1);
    expect(apiOnly.sheet.getCell('F19').value).toBe(123.45);
    expect(apiOnly.sheet.getCell('G19').value).toBe('order-api-1');
    expect(apiOnly.sheet.getCell('B20').value).toBe('Total amount');
    expect(formulaOf(apiOnly.sheet.getCell('F20'))).toBe('SUM(F19:F19)');
    expect(String(apiOnly.sheet.getCell('C20').value || '')).not.toContain('Token Plan');
    expect(String(apiOnly.sheet.getCell('B35').value || '')).toContain('Thank you for your business');

    const tokenOnly = await readFilled(baseApp({ items: [tokenPlanItem()] }));
    expect(tokenOnly.sheet.getCell('B19').value).toBe(1);
    expect(tokenOnly.sheet.getCell('C19').value).toBe('Token Plan');
    expect(tokenOnly.sheet.getCell('D19').value).toBe(1);
    expect(tokenOnly.sheet.getCell('F19').value).toBe(200);
    expect(tokenOnly.sheet.getCell('G19').value).toBe('order-tp-1');
    expect(tokenOnly.sheet.getCell('B20').value).toBe('Total amount');
    expect(formulaOf(tokenOnly.sheet.getCell('F20'))).toBe('SUM(F19:F19)');
    expect(String(tokenOnly.sheet.getCell('C19').value)).not.toBe('Raytone API');
  });

  it('两项产品时 SN 连续递增，保留两行并 SUM(F19:F20)', async () => {
    const { sheet } = await readFilled(baseApp({
      items: [
        {
          principalCents: 12345,
          description: 'RAYTONE_API',
          productName: 'Raytone API',
          orderId: 'order-api-1',
        },
        tokenPlanItem(),
      ],
    }));
    expect(sheet.getCell('B19').value).toBe(1);
    expect(sheet.getCell('C19').value).toBe('Raytone API');
    expect(sheet.getCell('G19').value).toBe('order-api-1');
    expect(sheet.getCell('B20').value).toBe(2);
    expect(sheet.getCell('C20').value).toBe('Token Plan');
    expect(sheet.getCell('F20').value).toBe(200);
    expect(sheet.getCell('G20').value).toBe('order-tp-1');
    expect(sheet.getCell('B21').value).toBe('Total amount');
    expect(formulaOf(sheet.getCell('F21'))).toBe('SUM(F19:F20)');
    expect(String(sheet.getCell('B36').value || '')).toContain('Thank you for your business');
  });

  it('H6 写成审核日值（覆盖 TODAY()），H7=H6+30，H8=USD', async () => {
    const { sheet } = await readFilled(baseApp());
    expect(cellShanghaiYmd(sheet.getCell('H6').value)).toBe('2026-09-20');
    expect(cellShanghaiYmd(sheet.getCell('H7').value)).toBe('2026-10-20');
    expect(sheet.getCell('H6').numFmt).toBe('mm-dd-yy');
    expect(sheet.getCell('H8').value).toBe('USD');
  });

  it('缺 kind 时默认 PERSONAL，Excel 地址只用 recipientAddress', async () => {
    const app = baseApp({
      profileSnapshot: {
        title: 'No Kind',
        recipientEmail: 'nk@example.com',
        recipientAddress: 'Kowloon',
        registeredAddress: 'Beijing',
      },
    });
    expect(buildOverseasInvoiceLines(app).api?.remark).toBe('order-api-1');
    expect(buildOverseasInvoiceProductRows(app)).toEqual([
      { sn: 1, description: 'Raytone API', qty: 1, amount: 123.45, remark: 'order-api-1' },
    ]);
    const { filled, sheet } = await readFilled(app);
    expect(filled.kind).toBe('PERSONAL');
    expect(sheet.getCell('C12').value).toBe('No Kind');
    expect(sheet.getCell('C13').value).toBe('nk@example.com');
    expect(sheet.getCell('C14').value).toBe('Kowloon');
  });

  it('REMARK 只写 orderId，多订单去重拼接，不写账期/PO', () => {
    const app = baseApp({
      items: [
        {
          principalCents: 10000,
          description: 'RAYTONE_API',
          productName: 'Raytone API',
          orderId: 'order-a',
          poNumber: 'PO-1',
          serviceStart: new Date('2026-07-31T16:00:00.000Z'),
        },
        {
          principalCents: 2345,
          description: 'RAYTONE_API',
          productName: 'Raytone API',
          order: { id: 'order-b' },
          poNumber: 'PO-2',
          serviceStart: new Date('2026-08-31T16:00:00.000Z'),
        },
        {
          principalCents: 1,
          description: 'RAYTONE_API',
          productName: 'Raytone API',
          orderId: 'order-a',
          serviceStart: new Date('2026-07-31T16:00:00.000Z'),
        },
      ],
    });
    expect(buildOverseasInvoiceLines(app).api?.remark).toBe('order-a\norder-b');
    expect(buildOverseasInvoiceProductRows(app).map((row) => row.sn)).toEqual([1]);
  });

  it('多条 remark 换行居中，产品行之间无边框', async () => {
    const { sheet } = await readFilled(baseApp({
      items: [
        {
          principalCents: 10000,
          description: 'RAYTONE_API',
          productName: 'Raytone API',
          orderId: 'order-a',
        },
        {
          principalCents: 2345,
          description: 'RAYTONE_API',
          productName: 'Raytone API',
          orderId: 'order-b',
        },
        tokenPlanItem(),
      ],
    }));
    expect(sheet.getCell('G19').value).toBe('order-a\norder-b');
    expect(sheet.getCell('G19').alignment).toMatchObject({
      wrapText: true,
      horizontal: 'center',
      vertical: 'middle',
    });
    expect(sheet.getCell('C19').alignment).toMatchObject({ horizontal: 'center' });
    expect(sheet.getCell('B19').alignment).toMatchObject({ horizontal: 'center' });
    expect(sheet.getCell('C18').alignment).toMatchObject({ horizontal: 'center', vertical: 'middle' });
    expect(sheet.getCell('D18').alignment).toMatchObject({ horizontal: 'center', vertical: 'middle' });
    expect(sheet.getCell('F21').alignment).toMatchObject({ horizontal: 'center', vertical: 'middle' });
    expect(sheet.getCell('B21').alignment).toMatchObject({ horizontal: 'center', vertical: 'middle' });
    expect(sheet.getRow(19).height ?? 0).toBeGreaterThan(22);
    for (const addr of ['B19', 'C19', 'G19', 'H19', 'B20', 'C20', 'G20', 'H20']) {
      expect(hasVisibleBorder(sheet.getCell(addr))).toBe(false);
    }
  });

  it('缺少 orderId 时 fail-close', () => {
    expect(() => buildOverseasInvoiceLines(baseApp({
      items: [{
        principalCents: 12345,
        description: 'RAYTONE_API',
        productName: 'Raytone API',
        serviceStart: new Date('2026-07-31T16:00:00.000Z'),
      }],
    }))).toThrow('海外 Invoice 缺少 API 订单号');
  });

  it('没有可开票产品行时 fail-close', async () => {
    expect(buildOverseasInvoiceProductRows(baseApp({ items: [] }))).toEqual([]);
    await expect(service.fill(baseApp({ items: [] }), { issueDate: ISSUE_DATE }))
      .rejects.toThrow('海外 Invoice 缺少可开票产品行');
  });

  it('Token Plan 单独开票时产品行 SN=1，不预留 API 空行', () => {
    expect(buildOverseasInvoiceProductRows(baseApp({ items: [tokenPlanItem()] }))).toEqual([
      { sn: 1, description: 'Token Plan', qty: 1, amount: 200, remark: 'order-tp-1' },
    ]);
  });

  it('表头、产品行和合计金额都居中，Bill To 仍靠标签左侧', async () => {
    const { sheet } = await readFilled(baseApp({
      items: [
        {
          principalCents: 12345,
          description: 'RAYTONE_API',
          productName: 'Raytone API',
          orderId: 'order-api-1',
        },
        tokenPlanItem(),
      ],
    }));
    for (const addr of ['B18', 'C18', 'D18', 'E18', 'F18', 'G18', 'B19', 'C19', 'D19', 'E19', 'F19', 'G19', 'B20', 'C20', 'F20', 'B21', 'F21']) {
      expect(sheet.getCell(addr).alignment).toMatchObject({
        horizontal: 'center',
        vertical: 'middle',
      });
    }
    expect(sheet.getCell('C12').alignment?.horizontal).toBe('left');
    expect(sheet.getCell('C13').alignment?.horizontal).toBe('left');
    expect(sheet.getCell('C14').alignment?.horizontal).toBe('left');
  });

  it('C 列收窄、Remark 加宽，Bill To 名称/邮箱/地址不加边框', async () => {
    const { sheet } = await readFilled(baseApp());
    expect(sheet.getColumn('C').width ?? 0).toBeLessThan(sheet.getColumn('G').width ?? 0);
    expect(sheet.getColumn('C').width ?? 0).toBeLessThanOrEqual(18);
    expect(sheet.getColumn('G').width ?? 0).toBeGreaterThanOrEqual(34);
    for (const addr of ['B12', 'C12', 'C13', 'C14', 'H12', 'H13', 'H14']) {
      expect(hasVisibleBorder(sheet.getCell(addr))).toBe(false);
    }
    expect(sheet.getCell('C12').fill).toMatchObject({ type: 'pattern', pattern: 'solid' });
    expect(sheet.getCell('C13').fill).toMatchObject({ type: 'pattern', pattern: 'solid' });
    expect(sheet.getCell('C14').fill).toMatchObject({ type: 'pattern', pattern: 'solid' });
  });

  it('SN/Qty 写成纯数字，不继承金额单元格的 $ 格式', async () => {
    const { sheet } = await readFilled(baseApp({
      items: [
        {
          principalCents: 12345,
          description: 'RAYTONE_API',
          productName: 'Raytone API',
          orderId: 'order-api-1',
        },
        tokenPlanItem(),
      ],
    }));
    expect(sheet.getCell('B19').value).toBe(1);
    expect(sheet.getCell('B20').value).toBe(2);
    expect(sheet.getCell('D19').value).toBe(1);
    expect(sheet.getCell('B19').numFmt).toBe('0');
    expect(sheet.getCell('B20').numFmt).toBe('0');
    expect(sheet.getCell('D19').numFmt).toBe('0');
    expect(sheet.getCell('D20').numFmt).toBe('0');
    expect(String(sheet.getCell('B19').numFmt || '')).not.toContain('$');
    expect(sheet.getCell('E19').numFmt).toBe('$#,##0.00');
    expect(sheet.getCell('F19').numFmt).toBe('$#,##0.00');
    expect(sheet.getCell('E20').numFmt).toBe('$#,##0.00');
    expect(sheet.getCell('F20').numFmt).toBe('$#,##0.00');
  });
});
