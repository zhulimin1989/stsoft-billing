import { InvoiceLineDescription, Prisma } from '@prisma/client';
import { PsaGoodsLine, PsaInvoiceRequest } from './psa-invoice.client';
import {
  PSA_APPLY_REASONS,
  PSA_PROJECT_NO_ENV,
  PSA_VAT_SPECIAL_KIND_NAME,
  OverseasInvoiceTemplateKind,
  PsaProjectSlot,
  PsaRegion,
  PsaRegionProfile,
  psaProfileFor,
} from './psa-invoice.profile';

export {
  PSA_APPLY_REASONS,
  PSA_DEFAULT_APPLY_REASON,
  PSA_DEFAULT_APPLY_REASON_DETAIL,
  PSA_DEFAULT_GOODS_CONTENT,
  PSA_DEFAULT_TAX_CLASSIFICATION_CODE,
  PSA_DEFAULT_UNIT_NAME,
  PSA_FOREIGN_KIND_NAME,
  PSA_VAT_NORMAL_KIND_NAME,
  PSA_VAT_SPECIAL_KIND_NAME,
} from './psa-invoice.profile';

/** @deprecated 仅兼容旧测试名；实际票种按 invoiceType 从国内/海外策略解析 */
export const PSA_DEFAULT_INVOICE_KIND_NAME = PSA_VAT_SPECIAL_KIND_NAME;

export interface PsaMappableFulfillmentHolder {
  codingPlanFulfillmentMode?: string | null;
}

export interface PsaMappableOrder {
  id?: string;
  amountCents?: number | null;
  paidAt?: Date | null;
  createdAt?: Date | null;
  product?: PsaMappableFulfillmentHolder | null;
  plan?: { product?: PsaMappableFulfillmentHolder | null } | null;
  items?: Array<{
    product?: PsaMappableFulfillmentHolder | null;
    plan?: { product?: PsaMappableFulfillmentHolder | null } | null;
    boosterPack?: { product?: PsaMappableFulfillmentHolder | null } | null;
  }>;
}

export interface PsaMappableInvoiceApplication {
  applicationNo: string;
  subtotalCents: number;
  totalCents: number;
  currency: string;
  profileSnapshot: Prisma.JsonValue;
  items: Array<{
    principalCents: number;
    description: InvoiceLineDescription;
    productName: string | null;
    serviceStart?: Date | null;
    serviceEnd?: Date | null;
    poNumber?: string | null;
    orderId?: string | null;
    order?: PsaMappableOrder | null;
  }>;
}

export const PSA_SUBMIT_INCLUDE = {
  items: {
    include: {
      order: {
        select: {
          id: true,
          amountCents: true,
          paidAt: true,
          createdAt: true,
          product: { select: { codingPlanFulfillmentMode: true } },
          plan: { select: { product: { select: { codingPlanFulfillmentMode: true } } } },
          items: {
            select: {
              product: { select: { codingPlanFulfillmentMode: true } },
              plan: { select: { product: { select: { codingPlanFulfillmentMode: true } } } },
              boosterPack: { select: { product: { select: { codingPlanFulfillmentMode: true } } } },
            },
          },
        },
      },
    },
  },
  events: {
    orderBy: { occurredAt: 'asc' as const },
    select: { metadata: true },
  },
} satisfies Prisma.InvoiceApplicationInclude;

export interface BuildPsaInvoiceRequestOptions {
  /** Authing=DOMESTIC，Auth0=FOREIGN。必须由登录/部署配置传入，不能从票种或币种猜测。 */
  region: PsaRegion;
  now?: Date;
}

/**
 * 将开票申请映射为 IPSA ApplyRuidongSpecialInvoice 请求。
 * 国内/海外策略由登录方式决定；票种、币种只作为请求字段，不再切换环境。
 * PSA 一次只接受单个业务订单号，多订单申请必须拆成多笔分别提交。
 */
export function buildPsaInvoiceRequests(
  application: PsaMappableInvoiceApplication,
  options: BuildPsaInvoiceRequestOptions,
): PsaInvoiceRequest[] {
  const now = options.now ?? new Date();
  const region = options.region;
  if (region !== 'DOMESTIC' && region !== 'FOREIGN') {
    throw new Error('无法判定国内/海外环境：缺少登录方式（authing=国内，auth0=海外）');
  }
  if (centsToYuan(application.subtotalCents) <= 0) {
    throw new Error('开票金额必须大于 0');
  }

  const projectSlot = resolveProjectSlot(region, application.items);
  const groups = groupItemsByOrder(application.items);
  const invoiceCentsList = allocateLastRemainder(
    groups.map((group) => sumPrincipalCents(group.items)),
    application.subtotalCents,
  );
  const totalCentsList = allocateLastRemainder(
    groups.map((group) => sumPrincipalCents(group.items)),
    application.totalCents || application.subtotalCents,
  );

  return groups.map((group, index) => {
    const invoiceCents = invoiceCentsList[index];
    const totalCents = totalCentsList[index];
    if (invoiceCents <= 0) {
      throw new Error('开票金额必须大于 0');
    }
    if (invoiceCents > group.amountCents) {
      throw new Error(`订单 ${group.orderId} 本次开票金额超过订单金额`);
    }
    return buildSinglePsaInvoiceRequest({
      application: {
        ...application,
        items: group.items,
        subtotalCents: invoiceCents,
        totalCents,
      },
      orderId: group.orderId,
      orderAmountCents: group.amountCents,
      region,
      projectSlot,
      now,
    });
  });
}

export function buildPsaInvoiceRequest(
  application: PsaMappableInvoiceApplication,
  options: BuildPsaInvoiceRequestOptions,
): PsaInvoiceRequest {
  const requests = buildPsaInvoiceRequests(application, options);
  if (requests.length !== 1) {
    throw new Error('开票申请包含多个订单，PSA 需按订单分别提交');
  }
  return requests[0];
}

function buildSinglePsaInvoiceRequest(input: {
  application: PsaMappableInvoiceApplication;
  orderId: string;
  orderAmountCents: number;
  region: PsaRegion;
  projectSlot: PsaProjectSlot;
  now: Date;
}): PsaInvoiceRequest {
  const { application, orderId, orderAmountCents, region, projectSlot, now } = input;
  const profile = asRecord(application.profileSnapshot);
  const regionProfile = psaProfileFor(region);
  const invoiceType = stringValue(profile.invoiceType);
  const invoiceAmount = centsToYuan(application.subtotalCents);
  const prjNo = resolveProjectNo(regionProfile, projectSlot);
  const title = stringValue(profile.title) || '客户';
  const registeredAddress = stringValue(profile.registeredAddress);
  const registeredPhone = stringValue(profile.registeredPhone);
  const address = [registeredAddress, registeredPhone].filter(Boolean).join(' ');
  const invoiceAmountLocal = region === 'FOREIGN'
    ? centsToYuan(application.totalCents || application.subtotalCents)
    : invoiceAmount;

  const request: PsaInvoiceRequest = {
    // PSA 订单号/订单金额取业务订单，不用开票申请号；同一订单多次开票按额度累计。
    orderNo: orderId,
    orderMoney: centsToYuan(orderAmountCents),
    prjNo,
    invoiceKindName: resolveInvoiceKindName(regionProfile, invoiceType),
    standbyAccountName: title,
    accountTaxNo: stringValue(profile.taxNo),
    address,
    bankText: [stringValue(profile.bankName), stringValue(profile.bankAccount)].filter(Boolean).join(' '),
    currencyName: regionProfile.currencyName,
    sdAreaId: regionProfile.sdAreaId,
    applyEmpNo: requiredEnv('PSA_APPLY_EMP_NO'),
    applyPhoneNo: env('PSA_APPLY_PHONE_NO', ''),
    isoftstoneEmail: requiredEnv('PSA_ISOFTSTONE_EMAIL'),
    // 客户发票由运营人工发送，不走 PSA 客户邮箱/邮寄。
    customerEmail: '',
    isEmailClient: env('PSA_IS_EMAIL_CLIENT', '否'),
    clientLinkman: stringValue(profile.recipientName) || title,
    clientPhone: stringValue(profile.recipientPhone),
    clientAddress: stringValue(profile.recipientAddress) || registeredAddress,
    clientPostalCode: env('PSA_CLIENT_POSTAL_CODE', ''),
    applyReason: resolveApplyReason(regionProfile),
    applyReasonDetail: env('PSA_APPLY_REASON_DETAIL', regionProfile.applyReasonDetail),
    invoiceAmount,
    invoiceAmountLocal,
    serviceMonth: resolveServiceMonth(application.items, projectSlot),
    planPaymentDate: env('PSA_PLAN_PAYMENT_DATE', shanghaiYmd(now)),
    invoiceRemark: env('PSA_INVOICE_REMARK', '').slice(0, 200),
    goodsLines: buildGoodsLines(application.items, regionProfile, invoiceAmount),
  };

  if (request.isEmailClient !== '是' && request.isEmailClient !== '否') {
    throw new Error('PSA_IS_EMAIL_CLIENT 只能是「是」或「否」');
  }
  return request;
}

export function resolveOverseasInvoiceKind(
  profileSnapshot: Prisma.JsonValue,
): OverseasInvoiceTemplateKind {
  return stringValue(asRecord(profileSnapshot).kind).toUpperCase() === 'ENTERPRISE'
    ? 'ENTERPRISE'
    : 'PERSONAL';
}

export function resolveOverseasBillTo(profileSnapshot: Prisma.JsonValue): {
  kind: OverseasInvoiceTemplateKind;
  title: string;
  email: string;
  address: string;
} {
  const profile = asRecord(profileSnapshot);
  return {
    kind: resolveOverseasInvoiceKind(profileSnapshot),
    title: stringValue(profile.title) || '客户',
    email: stringValue(profile.recipientEmail),
    address: stringValue(profile.recipientAddress),
  };
}

export function shanghaiUtcDate(date: Date): Date {
  const { year, month, day } = shanghaiParts(date);
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day)));
}

export function shanghaiUtcDatePlusDays(date: Date, days: number): Date {
  const { year, month, day } = shanghaiParts(date);
  return new Date(Date.UTC(Number(year), Number(month) - 1, Number(day) + days));
}

export function shanghaiSlashYmd(date: Date): string {
  return shanghaiYmd(date).replace(/-/g, '/');
}

export function shanghaiSlashMonthStart(date: Date): string {
  return shanghaiMonthStart(date).replace(/-/g, '/');
}

export function shanghaiSlashServiceCoverage(starts: Date[], ends: Date[]): string {
  return formatServiceCoverage(starts, ends).replace(/(\d{4})-(\d{2})-(\d{2})/g, '$1/$2/$3');
}

export function shanghaiYmd(date: Date): string {
  const { year, month, day } = shanghaiParts(date);
  return `${year}-${month}-${day}`;
}

export function shanghaiMonthStart(date: Date): string {
  const { year, month } = shanghaiParts(date);
  return `${year}-${month}-01`;
}

export function shanghaiMonthEnd(date: Date): string {
  const { year, month } = shanghaiParts(date);
  const lastDay = new Date(Date.UTC(Number(year), Number(month), 0)).getUTCDate();
  return `${year}-${month}-${String(lastDay).padStart(2, '0')}`;
}

export function centsToYuan(cents: number): number {
  return Number((Math.round(cents) / 100).toFixed(2));
}

interface PsaOrderItemGroup {
  orderId: string;
  amountCents: number;
  items: PsaMappableInvoiceApplication['items'];
}

function groupItemsByOrder(
  items: PsaMappableInvoiceApplication['items'],
): PsaOrderItemGroup[] {
  const groups: PsaOrderItemGroup[] = [];
  const indexById = new Map<string, number>();
  for (const item of items) {
    const orderId = item.orderId?.trim() || item.order?.id?.trim() || '';
    if (!orderId) {
      throw new Error('开票申请缺少订单号，无法映射 PSA orderNo');
    }
    let index = indexById.get(orderId);
    if (index === undefined) {
      const amount = item.order?.amountCents;
      if (typeof amount !== 'number' || !Number.isFinite(amount) || amount <= 0) {
        throw new Error(`订单 ${orderId} 缺少有效订单金额，无法映射 PSA orderMoney`);
      }
      index = groups.length;
      indexById.set(orderId, index);
      groups.push({ orderId, amountCents: amount, items: [] });
    }
    groups[index].items.push(item);
  }
  if (groups.length === 0) {
    throw new Error('开票申请缺少订单号，无法映射 PSA orderNo');
  }
  return groups;
}

function sumPrincipalCents(items: PsaMappableInvoiceApplication['items']): number {
  return items.reduce((sum, item) => sum + Math.round(Number(item.principalCents || 0)), 0);
}

function allocateLastRemainder(parts: number[], total: number): number[] {
  if (parts.length === 0) return [];
  const allocated = parts.map((part) => Math.round(part));
  const head = allocated.slice(0, -1).reduce((sum, part) => sum + part, 0);
  allocated[allocated.length - 1] = Math.round(total) - head;
  return allocated;
}

function resolveProjectSlot(
  region: PsaRegion,
  items: PsaMappableInvoiceApplication['items'],
): PsaProjectSlot {
  if (items.length === 0) {
    throw new Error('开票申请缺少明细，无法映射 PSA 项目号');
  }
  const descriptions = new Set(items.map((item) => item.description));
  if (descriptions.size !== 1) {
    throw new Error(
      `同一开票申请不能混合 ${[...descriptions].join(' / ')}，PSA 项目号无法唯一确定`,
    );
  }
  const description = items[0].description;
  if (description === 'RAYTONE_API') return 'API';
  if (description !== 'TOKEN_PLAN') {
    throw new Error(`无法识别的开票明细类型: ${description}`);
  }
  if (region === 'FOREIGN') return 'TOKEN_PLAN';

  const modes = collectFulfillmentModes(items);
  if (modes.size === 0) {
    throw new Error('国内 Token Plan 缺少履约模式，无法区分智谱 Token 卡与自营套餐项目号');
  }
  if (modes.size > 1) {
    throw new Error('同一开票申请不能混合自营套餐与供应商转售 Token Plan，PSA 项目号无法唯一确定');
  }
  const mode = [...modes][0];
  if (mode === 'platform_model_package') return 'SELF_PLAN';
  if (mode === 'provider_resale') return 'TOKEN_PLAN';
  throw new Error(`无法识别的 Token Plan 履约模式: ${mode}`);
}

function resolveProjectNo(proto: PsaRegionProfile, slot: PsaProjectSlot): string {
  const envName = PSA_PROJECT_NO_ENV[proto.region][slot];
  const fromEnv = envName ? process.env[envName]?.trim() : '';
  const prjNo = fromEnv || proto.projectNos[slot]?.trim();
  if (!prjNo) {
    throw new Error(`PSA 项目号未配置: ${proto.region}/${slot}`);
  }
  return prjNo;
}

function resolveInvoiceKindName(proto: PsaRegionProfile, invoiceType: string): string {
  if (proto.region === 'FOREIGN') {
    const kind = proto.invoiceKindByType.COMMERCIAL_HK?.trim();
    if (!kind) throw new Error('海外 PSA 开票类型未配置');
    return kind;
  }
  if (invoiceType === 'VAT_NORMAL') {
    const kind = proto.invoiceKindByType.VAT_NORMAL?.trim();
    if (!kind) throw new Error('国内普票 PSA 开票类型未配置');
    return kind;
  }
  if (invoiceType === 'VAT_SPECIAL') {
    const kind = proto.invoiceKindByType.VAT_SPECIAL?.trim();
    if (!kind) throw new Error('国内专票 PSA 开票类型未配置');
    return kind;
  }
  throw new Error(`国内开票类型无法映射 PSA 开票类型: ${invoiceType || '(空)'}`);
}

function resolveServiceMonth(
  items: PsaMappableInvoiceApplication['items'],
  projectSlot: PsaProjectSlot,
): string {
  const override = process.env.PSA_SERVICE_MONTH?.trim();
  if (override) return override;

  if (projectSlot === 'TOKEN_PLAN' || projectSlot === 'SELF_PLAN') {
    // Token Plan / 自营套餐：服务月取订单月 1 日，例如 2026/07/15 → 2026/07/01。
    const dates = collectOrderServiceDates(items);
    if (dates.length === 0) {
      throw new Error('Token Plan / 自营套餐缺少订单支付时间，无法确定服务月份');
    }
    return formatServiceCoverage(dates, dates);
  }

  const starts = collectValidDates(items.map((item) => item.serviceStart ?? null));
  const ends = collectValidDates(
    items.map((item) => item.serviceEnd ?? item.serviceStart ?? null),
  );
  if (starts.length > 0) {
    return formatServiceCoverage(starts, ends.length > 0 ? ends : starts);
  }

  // 海外 PAYG / 充值开票没有消耗账期，退回订单月 1 日，与 Token Plan 一致。
  const orderDates = collectOrderServiceDates(items);
  if (orderDates.length === 0) {
    throw new Error('API 开票缺少服务账期，无法确定服务月份');
  }
  return formatServiceCoverage(orderDates, orderDates);
}

function collectOrderServiceDates(
  items: PsaMappableInvoiceApplication['items'],
): Date[] {
  return collectValidDates(items.map((item) => item.order?.paidAt ?? item.order?.createdAt ?? null));
}

function collectValidDates(values: Array<Date | null | undefined>): Date[] {
  return values.filter((date): date is Date => date instanceof Date && !Number.isNaN(date.getTime()));
}

function formatServiceCoverage(starts: Date[], ends: Date[]): string {
  const minStart = starts.reduce((earliest, date) => (date < earliest ? date : earliest));
  const maxEnd = ends.reduce((latest, date) => (date > latest ? date : latest));
  const startMonth = shanghaiMonthStart(minStart);
  const endMonth = shanghaiMonthStart(maxEnd);
  if (startMonth === endMonth) return startMonth;
  return `${startMonth}-${shanghaiMonthEnd(maxEnd)}`;
}

function collectFulfillmentModes(
  items: PsaMappableInvoiceApplication['items'],
): Set<string> {
  const modes = new Set<string>();
  const add = (product?: PsaMappableFulfillmentHolder | null) => {
    const mode = product?.codingPlanFulfillmentMode?.trim();
    if (mode) modes.add(mode);
  };
  for (const item of items) {
    const order = item.order;
    if (!order) continue;
    add(order.product);
    add(order.plan?.product);
    for (const orderItem of order.items ?? []) {
      add(orderItem.product);
      add(orderItem.plan?.product);
      add(orderItem.boosterPack?.product);
    }
  }
  return modes;
}

function buildGoodsLines(
  items: PsaMappableInvoiceApplication['items'],
  proto: PsaRegionProfile,
  invoiceAmount: number,
): PsaGoodsLine[] {
  const specModel = env('PSA_GOODS_SPEC_MODEL', '');
  if (items.length === 0) {
    throw new Error('开票申请缺少明细，无法映射 PSA 货物行');
  }
  const source = items;

  const lines: PsaGoodsLine[] = source.map((item) => {
    const money = centsToYuan(item.principalCents);
    return {
      content: env('PSA_DEFAULT_GOODS_CONTENT', proto.goodsContent),
      taxClassificationCode: proto.taxClassificationCode,
      specModel,
      unitName: proto.goodsUnitName,
      quantity: 1,
      unitPrice: money,
      money,
    };
  });

  const headSum = Number(lines.slice(0, -1).reduce((sum, line) => sum + line.money, 0).toFixed(2));
  const last = lines[lines.length - 1];
  last.money = Number((invoiceAmount - headSum).toFixed(2));
  last.unitPrice = last.quantity ? Number((last.money / last.quantity).toFixed(2)) : last.money;
  if (last.money <= 0) {
    throw new Error('货物与应税劳务金额之和必须等于本次开票金额');
  }
  return lines;
}

function resolveApplyReason(proto: PsaRegionProfile): string {
  const value = env('PSA_APPLY_REASON', proto.applyReason);
  if (!(PSA_APPLY_REASONS as readonly string[]).includes(value)) {
    throw new Error(`PSA_APPLY_REASON 不合法，仅支持：${PSA_APPLY_REASONS.join(' / ')}`);
  }
  return value;
}

function shanghaiParts(date: Date): { year: string; month: string; day: string } {
  const parts = new Intl.DateTimeFormat('en-CA', {
    timeZone: 'Asia/Shanghai',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
  }).formatToParts(date);
  const pick = (type: Intl.DateTimeFormatPartTypes) =>
    parts.find((part) => part.type === type)?.value ?? '';
  return { year: pick('year'), month: pick('month'), day: pick('day') };
}

function requiredEnv(name: string): string {
  const value = process.env[name]?.trim();
  if (!value) throw new Error(`${name} 未配置`);
  return value;
}

function env(name: string, fallback: string): string {
  const value = process.env[name]?.trim();
  return value || fallback;
}

function asRecord(value: Prisma.JsonValue): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string {
  return typeof value === 'string' ? value.trim() : '';
}
