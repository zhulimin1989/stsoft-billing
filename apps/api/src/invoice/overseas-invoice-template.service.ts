import { Injectable } from '@nestjs/common';
import { existsSync } from 'node:fs';
import { join } from 'node:path';
import ExcelJS from 'exceljs';
import { psaXlsxFileName } from './psa-invoice.client';
import {
  PsaMappableInvoiceApplication,
  centsToYuan,
  resolveOverseasBillTo,
  shanghaiUtcDate,
  shanghaiUtcDatePlusDays,
} from './psa-invoice.mapper';
import {
  OverseasInvoiceTemplateKind,
  PSA_OVERSEAS_TEMPLATE_FILE,
} from './psa-invoice.profile';

const SHEET_NAME = 'Invoice Template';
const XLSX_CONTENT_TYPE =
  'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
const MONEY_FORMAT = '$#,##0.00';
const INTEGER_FORMAT = '0';
const DATE_FORMAT = 'mm-dd-yy';
const PRODUCT_START_ROW = 19;
const HEADER_ROW = PRODUCT_START_ROW - 1;
const TEMPLATE_LINE_ROWS = 2;
const DESCRIPTION_COL_WIDTH = 17;
const REMARK_COL_WIDTH = 36;
const PRODUCT_ROW_HEIGHT = 22;
const PRODUCT_ROW_LINE_HEIGHT = 15;
const BILL_TO_ROWS = [12, 13, 14] as const;
const BILL_TO_COLS = ['B', 'C', 'D', 'E', 'F', 'G', 'H'] as const;
const PRODUCT_COLS = ['B', 'C', 'D', 'E', 'F', 'G', 'H'] as const;
const CENTERED_ALIGNMENT = {
  horizontal: 'center' as const,
  vertical: 'middle' as const,
  wrapText: true,
};
const API_DESCRIPTION = 'Raytone API';
const TOKEN_PLAN_DESCRIPTION = 'Token Plan';
const MERGE_RE = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/;

export interface OverseasInvoiceFillOptions {
  issueDate?: Date;
}

export interface OverseasInvoiceFillResult {
  buffer: Buffer;
  fileName: string;
  contentType: string;
  kind: OverseasInvoiceTemplateKind;
}

export interface OverseasInvoiceLineFill {
  amount: number;
  remark: string;
}

export interface OverseasInvoiceLines {
  api: OverseasInvoiceLineFill | null;
  tokenPlan: OverseasInvoiceLineFill | null;
}

export interface OverseasInvoiceProductLine {
  sn: number;
  description: string;
  qty: number;
  amount: number;
  remark: string;
}

@Injectable()
export class OverseasInvoiceTemplateService {
  async fill(
    application: PsaMappableInvoiceApplication,
    options?: OverseasInvoiceFillOptions,
  ): Promise<OverseasInvoiceFillResult> {
    const billTo = resolveOverseasBillTo(application.profileSnapshot);
    const templatePath = resolveTemplatePath();
    const issueDate = options?.issueDate ?? new Date();
    const productRows = buildOverseasInvoiceProductRows(application);
    if (productRows.length === 0) {
      throw new Error('海外 Invoice 缺少可开票产品行');
    }

    const workbook = new ExcelJS.Workbook();
    await workbook.xlsx.readFile(templatePath);
    const sheet = workbook.getWorksheet(SHEET_NAME) ?? workbook.worksheets[0];
    if (!sheet) {
      throw new Error('海外 Invoice 模板缺少工作表');
    }

    // 发票号由 PSA 开票后回填，模板附件不写申请号。
    sheet.getCell('H5').value = null;
    writeExcelDate(sheet.getCell('H6'), shanghaiUtcDate(issueDate));
    writeExcelDate(sheet.getCell('H7'), shanghaiUtcDatePlusDays(issueDate, 30));
    sheet.getCell('H8').value = 'USD';

    sheet.getCell('C12').value = billTo.title;
    sheet.getCell('C13').value = billTo.email || null;
    sheet.getCell('C14').value = billTo.address || null;

    writeProductRows(sheet, productRows);
    applyInvoiceLayout(sheet, productRows.length);

    const buffer = Buffer.from(await workbook.xlsx.writeBuffer());
    if (!buffer.length) {
      throw new Error('海外 Invoice 模板生成结果为空');
    }
    return {
      buffer,
      fileName: psaXlsxFileName(application.applicationNo),
      contentType: XLSX_CONTENT_TYPE,
      kind: billTo.kind,
    };
  }
}

export function buildOverseasInvoiceLines(
  application: PsaMappableInvoiceApplication,
): OverseasInvoiceLines {
  return {
    api: summarizeLine(
      application.items.filter((item) => item.description === 'RAYTONE_API'),
      'API',
    ),
    tokenPlan: summarizeLine(
      application.items.filter((item) => item.description === 'TOKEN_PLAN'),
      'TOKEN_PLAN',
    ),
  };
}

export function buildOverseasInvoiceProductRows(
  application: PsaMappableInvoiceApplication,
): OverseasInvoiceProductLine[] {
  const grouped = buildOverseasInvoiceLines(application);
  const rows: OverseasInvoiceProductLine[] = [];
  if (grouped.api) {
    rows.push({
      sn: rows.length + 1,
      description: API_DESCRIPTION,
      qty: 1,
      amount: grouped.api.amount,
      remark: grouped.api.remark,
    });
  }
  if (grouped.tokenPlan) {
    rows.push({
      sn: rows.length + 1,
      description: TOKEN_PLAN_DESCRIPTION,
      qty: 1,
      amount: grouped.tokenPlan.amount,
      remark: grouped.tokenPlan.remark,
    });
  }
  return rows;
}

function summarizeLine(
  items: PsaMappableInvoiceApplication['items'],
  slot: 'API' | 'TOKEN_PLAN',
): OverseasInvoiceLineFill | null {
  if (items.length === 0) return null;
  const cents = items.reduce((sum, item) => sum + Number(item.principalCents || 0), 0);
  const amount = centsToYuan(cents);
  if (amount <= 0) return null;
  return {
    amount,
    remark: buildLineRemark(items, slot),
  };
}

function buildLineRemark(
  items: PsaMappableInvoiceApplication['items'],
  slot: 'API' | 'TOKEN_PLAN',
): string {
  const orderIds = uniqueOrderIds(items);
  if (orderIds.length === 0) {
    throw new Error(
      slot === 'API' ? '海外 Invoice 缺少 API 订单号' : '海外 Invoice 缺少 Token Plan 订单号',
    );
  }
  return orderIds.join('\n');
}

function uniqueOrderIds(items: PsaMappableInvoiceApplication['items']): string[] {
  return [...new Set(
    items
      .map((item) => item.orderId?.trim() || item.order?.id?.trim() || '')
      .filter(Boolean),
  )];
}

function writeProductRows(
  sheet: ExcelJS.Worksheet,
  rows: OverseasInvoiceProductLine[],
): void {
  for (let i = 0; i < rows.length; i += 1) {
    writeProductRow(sheet, PRODUCT_START_ROW + i, rows[i]);
  }
  if (rows.length > 0) {
    for (let extra = TEMPLATE_LINE_ROWS - rows.length; extra > 0; extra -= 1) {
      deleteSheetRow(sheet, PRODUCT_START_ROW + rows.length);
    }
  }
  writeTotalFormula(sheet, rows.length);
}

function writeProductRow(
  sheet: ExcelJS.Worksheet,
  row: number,
  line: OverseasInvoiceProductLine,
): void {
  writeInteger(sheet.getCell(`B${row}`), line.sn);
  sheet.getCell(`C${row}`).value = line.description;
  writeInteger(sheet.getCell(`D${row}`), line.qty);
  writeMoney(sheet.getCell(`E${row}`), line.amount);
  writeMoney(sheet.getCell(`F${row}`), line.amount);
  sheet.getCell(`G${row}`).value = line.remark;
  for (const col of PRODUCT_COLS) {
    restyleProductCell(sheet.getCell(`${col}${row}`));
  }
  sheet.getRow(row).height = productRowHeight(line.remark);
}

function writeInteger(cell: ExcelJS.Cell, value: number): void {
  // 模板 B19/E19 共用 xf；直接改 numFmt 会把 SN 渲染成 $1。
  writeFormatted(cell, value, INTEGER_FORMAT);
}

function writeMoney(cell: ExcelJS.Cell, amount: number): void {
  writeFormatted(cell, amount, cell.numFmt || MONEY_FORMAT);
}

function writeExcelDate(cell: ExcelJS.Cell, date: Date): void {
  writeFormatted(cell, date, DATE_FORMAT);
}

function writeTotalFormula(sheet: ExcelJS.Worksheet, lineCount: number): void {
  const lastLineRow = lineCount > 0
    ? PRODUCT_START_ROW + lineCount - 1
    : PRODUCT_START_ROW + TEMPLATE_LINE_ROWS - 1;
  const totalRow = lastLineRow + 1;
  const formula = `SUM(F${PRODUCT_START_ROW}:F${lastLineRow})`;
  const cell = sheet.getCell(`F${totalRow}`);
  writeFormatted(cell, { formula }, cell.numFmt || MONEY_FORMAT);
}

function writeFormatted(
  cell: ExcelJS.Cell,
  value: ExcelJS.CellValue,
  numFmt: string,
): void {
  cell.value = value;
  cell.style = { ...cell.style, numFmt };
}

function applyInvoiceLayout(sheet: ExcelJS.Worksheet, lineCount: number): void {
  sheet.getColumn('C').width = DESCRIPTION_COL_WIDTH;
  sheet.getColumn('G').width = REMARK_COL_WIDTH;
  for (const row of BILL_TO_ROWS) {
    for (const col of BILL_TO_COLS) {
      restyleBillToCell(sheet.getCell(`${col}${row}`));
    }
  }
  const totalRow = PRODUCT_START_ROW + lineCount;
  for (const row of [HEADER_ROW, totalRow]) {
    for (const col of PRODUCT_COLS) {
      restyleCenteredCell(sheet.getCell(`${col}${row}`), { keepBorder: true });
    }
  }
}

function restyleBillToCell(cell: ExcelJS.Cell): void {
  const { border: _ignored, ...rest } = cell.style;
  cell.style = {
    ...rest,
    fill: {
      type: 'pattern',
      pattern: 'solid',
      fgColor: { argb: 'FFFFFFFF' },
    },
  };
}

function restyleProductCell(cell: ExcelJS.Cell): void {
  restyleCenteredCell(cell, { keepBorder: false });
}

function restyleCenteredCell(
  cell: ExcelJS.Cell,
  options: { keepBorder: boolean },
): void {
  const { border, ...rest } = cell.style;
  cell.style = {
    ...rest,
    ...(options.keepBorder ? { border } : {}),
    alignment: { ...CENTERED_ALIGNMENT },
  };
  cell.alignment = { ...CENTERED_ALIGNMENT };
}

function productRowHeight(remark: string): number {
  return Math.max(PRODUCT_ROW_HEIGHT, 8 + remarkLineCount(remark) * PRODUCT_ROW_LINE_HEIGHT);
}

function remarkLineCount(remark: string): number {
  const usableChars = Math.max(8, Math.floor(REMARK_COL_WIDTH + 12));
  return remark.split(/\r?\n/).reduce((sum, line) => {
    const length = line.length || 1;
    return sum + Math.max(1, Math.ceil(length / usableChars));
  }, 0);
}

function deleteSheetRow(sheet: ExcelJS.Worksheet, row: number): void {
  const restored: string[] = [];
  for (const merge of listMerges(sheet)) {
    const parsed = parseMerge(merge);
    if (!parsed) continue;
    sheet.unMergeCells(merge);
    if (parsed.r1 >= row && parsed.r2 <= row) continue;
    const shift = (r: number) => (r > row ? r - 1 : r);
    const r1 = shift(parsed.r1);
    const r2 = shift(parsed.r2);
    if (parsed.c1 === parsed.c2 && r1 === r2) continue;
    restored.push(`${parsed.c1}${r1}:${parsed.c2}${r2}`);
  }
  sheet.spliceRows(row, 1);
  for (const merge of restored) {
    sheet.mergeCells(merge);
  }
}

function listMerges(sheet: ExcelJS.Worksheet): string[] {
  const merges = (sheet.model as { merges?: string[] }).merges;
  return Array.isArray(merges) ? [...merges] : [];
}

function parseMerge(merge: string): { c1: string; r1: number; c2: string; r2: number } | null {
  const matched = MERGE_RE.exec(merge);
  if (!matched) return null;
  return {
    c1: matched[1],
    r1: Number(matched[2]),
    c2: matched[3],
    r2: Number(matched[4]),
  };
}

function resolveTemplatePath(): string {
  const templatePath = join(__dirname, 'assets', 'overseas', PSA_OVERSEAS_TEMPLATE_FILE);
  if (!existsSync(templatePath)) {
    throw new Error(`海外 Invoice 模板不存在: ${PSA_OVERSEAS_TEMPLATE_FILE}`);
  }
  return templatePath;
}
