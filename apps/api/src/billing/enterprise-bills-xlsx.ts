import { PassThrough, type Writable } from 'node:stream';
import ExcelJS from 'exceljs';
import { Prisma } from '@prisma/client';
import { usd, type DecimalLike } from './money';
import { exportUsageCutoff, financeApiUsageChannelUsd } from './enterprise-bills.policy';
import type { EnterpriseUsageAggregateRow } from './enterprise-bills-export-aggregate';
import { getRegularInputTokens } from './token-breakdown';

const EXCEL_MAX_ROWS = 1_000_000;
const BEIJING_OFFSET_MS = 8 * 60 * 60 * 1000;
const HEADER_FILL_RGB = '27408B';

/** 账务拆分无法挂到 tenant/model 时的兜底桶；保证 ∑ 拆分 = 账单月总额。 */
export const UNATTRIBUTED_LEDGER_KEY = '未归属';

/** 账单明细「结算状态」：按该行总消耗与待付款判定。 */
export type EnterpriseBillSettlementStatus =
  | '不适用'
  | '未结算'
  | '部分未结算'
  | '已结算';

/**
 * 总消耗 = 0 → 不适用（空单，不参与汇总）；
 * 待付款 = 总消耗 → 未结算；
 * 0 < 待付款 < 总消耗 → 部分未结算；
 * 待付款 = 0 → 已结算。
 */
export function settlementStatusFromPending(
  totalConsume: Prisma.Decimal,
  pendingAmount: Prisma.Decimal,
): EnterpriseBillSettlementStatus {
  if (!totalConsume.gt(0)) return '不适用';
  if (!pendingAmount.gt(0)) return '已结算';
  if (pendingAmount.gte(totalConsume)) return '未结算';
  return '部分未结算';
}

export type BillSnapshot = {
  consumeCents: number;
  voucherCents: number;
  chargeCents: number;
  tokenTotal: number;
  requestCount: number;
  adjustedCents: number;
  issuedVoucherCents: number;
  receivableCents: number;
  paidCents: number;
  pendingCents: number;
  status: string;
  dueAt: string | null;
};

export type UsageRow = {
  createdAt: Date;
  tenantId?: string;
  model?: string;
  callType?: string | null;
  totalTokens: number;
  promptTokens?: number | null;
  cachedInputTokens?: number | null;
  cacheWriteInputTokens?: number | null;
  completionTokens?: number | null;
  unitPriceUsd?: DecimalLike | null;
  inputPriceUsdPerM?: DecimalLike | null;
  cachedInputPriceUsdPerM?: DecimalLike | null;
  cacheWritePriceUsdPerM?: DecimalLike | null;
  outputPriceUsdPerM?: DecimalLike | null;
  /** 目录价（LIST / 未乘企业折扣）；缺省时目录回退到下方 customer 单价。 */
  listInputPriceUsdPerM?: DecimalLike | null;
  listCachedInputPriceUsdPerM?: DecimalLike | null;
  listCacheWritePriceUsdPerM?: DecimalLike | null;
  listOutputPriceUsdPerM?: DecimalLike | null;
  customerChargeUsd?: DecimalLike | null;
  costUsd?: DecimalLike | null;
  customerChargePolicy?: string | null;
  /** 用量资金快照；与财务 apiUsage / 列表三渠道同源。 */
  customerCollectedUsd?: DecimalLike | null;
  customerApprovedReceivableUsd?: DecimalLike | null;
  customerUnapprovedDebtUsd?: DecimalLike | null;
  customerFundingClassificationComplete?: boolean | null;
  /**
   * 结算冻结的客户折扣倍率（财务 customerMultiplier）。
   * 有值时账单明细「折扣比」直接用它，不再用 总消耗/目录价 反推。
   */
  customerMultiplier?: number | null;
  gatewayBillingEvent?: {
    settlementAnchor?: {
      customerPricingSnapshot?: unknown;
    } | null;
  } | null;
  consumptionAllocations?: Array<{
    balanceGrantId?: string | null;
    source?: string | null;
    amountUsd?: DecimalLike | null;
    recognizedRevenueUsd?: DecimalLike | null;
    bonusConsumedUsd?: DecimalLike | null;
    approvedCreditUsd?: DecimalLike | null;
    unapprovedDebtUsd?: DecimalLike | null;
    fundingClassificationComplete?: boolean | null;
  }> | null;
};

export type UsageDetailPart = {
  callType: string;
  totalTokens: number;
  unitPriceUsd: DecimalLike | null | undefined;
  /** 价基：tokens × 单价 / 1e6；无单价时为 0，分摊回退到 token 权重。 */
  priceBasis: Prisma.Decimal;
  /** @deprecated 保留作 token 权重回退；优先用 priceBasis */
  weight: number;
};

const USAGE_TYPE_LABELS: Record<string, string> = {
  input: 'input',
  output: 'output',
  'cache read': 'cache read',
  'cache write': 'cache write',
  cache_read: 'cache read',
  cache_write: 'cache write',
  total: 'total',
  输入: 'input',
  输出: 'output',
  缓存读取: 'cache read',
  缓存写入: 'cache write',
  缓存命中: 'cache read',
  合计: 'total',
};

/**
 * 账单明细「类型」白名单：与 API 用量扣费口径一致，只保留 token 分量。
 * 排序与白名单共用这一份，避免漏过滤或漏排序。
 */
const DETAIL_TYPE_SORT_ORDER = ['input', 'cache read', 'cache write', 'output', 'total'] as const;
const ALLOWED_DETAIL_TYPES: ReadonlySet<string> = new Set(DETAIL_TYPE_SORT_ORDER);

/** 将 token_usage.call_type / finance tokenType 规范为 Excel「类型」英文文案（与财务报表 apiUsage 一致）。 */
export function formatEnterpriseBillUsageType(raw: string | null | undefined): string {
  const key = (raw ?? '').trim();
  if (!key) return '';
  if (USAGE_TYPE_LABELS[key]) return USAGE_TYPE_LABELS[key]!;
  const normalized = key.toLowerCase().replace(/_/g, ' ');
  if (USAGE_TYPE_LABELS[normalized]) return USAGE_TYPE_LABELS[normalized]!;
  // 「输入 input」等历史双语文案 → 只保留英文枚举
  const bilingual = key.match(/^(输入|输出|缓存读取|缓存写入|缓存命中|合计)\s+(.+)$/);
  if (bilingual) {
    const mapped = USAGE_TYPE_LABELS[bilingual[1]!];
    if (mapped) return mapped;
  }
  return key;
}

/**
 * 账单明细不写出的类型。
 *
 * 先规范成 Excel「类型」文案，再对照 token 分量白名单。
 * `chat`、`zhipu_chat`、以及后续新增的非 token 分量 call_type 都不写进明细。
 * 四分量全 0 的兜底行把原始 `call_type` 写进类型列，因此也走同一条过滤。
 * 汇总两页仍按整行累计，不受明细白名单影响。
 */
export function isExcludedDetailType(callType: string | null | undefined): boolean {
  return !ALLOWED_DETAIL_TYPES.has(formatEnterpriseBillUsageType(callType));
}

/**
 * 与财务报表 apiUsage 同口径：按 prompt/cache/completion 分量展开，
 * 不信任单列 call_type（整请求常只存一个枚举，类型与用量会对不上）。
 */
export function expandUsageDetailParts(row: UsageRow): UsageDetailPart[] {
  const breakdown = {
    inputTokens: row.promptTokens,
    cachedInputTokens: row.cachedInputTokens,
    cacheWriteInputTokens: row.cacheWriteInputTokens,
    outputTokens: row.completionTokens,
  };
  const multiplier = resolveCustomerMultiplier(row);
  const rawParts = [
    {
      type: 'input',
      tokens: getRegularInputTokens(breakdown),
      catalogUnitPrice: catalogUnitFromColumns(
        row.listInputPriceUsdPerM,
        row.inputPriceUsdPerM ?? row.unitPriceUsd,
        multiplier,
      ),
      customerUnitPrice: row.inputPriceUsdPerM ?? row.unitPriceUsd,
    },
    {
      type: 'cache read',
      tokens: Math.max(0, Math.floor(Number(row.cachedInputTokens ?? 0))),
      catalogUnitPrice: catalogUnitFromColumns(
        row.listCachedInputPriceUsdPerM ?? row.listInputPriceUsdPerM,
        row.cachedInputPriceUsdPerM ?? row.inputPriceUsdPerM ?? row.unitPriceUsd,
        multiplier,
      ),
      customerUnitPrice: row.cachedInputPriceUsdPerM ?? row.inputPriceUsdPerM ?? row.unitPriceUsd,
    },
    {
      type: 'cache write',
      tokens: Math.max(0, Math.floor(Number(row.cacheWriteInputTokens ?? 0))),
      catalogUnitPrice: catalogUnitFromColumns(
        row.listCacheWritePriceUsdPerM ?? row.listInputPriceUsdPerM,
        row.cacheWritePriceUsdPerM ?? row.inputPriceUsdPerM ?? row.unitPriceUsd,
        multiplier,
      ),
      customerUnitPrice: row.cacheWritePriceUsdPerM ?? row.inputPriceUsdPerM ?? row.unitPriceUsd,
    },
    {
      type: 'output',
      tokens: Math.max(0, Math.floor(Number(row.completionTokens ?? 0))),
      catalogUnitPrice: catalogUnitFromColumns(
        row.listOutputPriceUsdPerM,
        row.outputPriceUsdPerM ?? row.unitPriceUsd,
        multiplier,
      ),
      customerUnitPrice: row.outputPriceUsdPerM ?? row.unitPriceUsd,
    },
  ].filter((part) => Number.isFinite(part.tokens) && part.tokens > 0);

  if (rawParts.length === 0) {
    const catalogUnit = catalogUnitFromColumns(
      row.listInputPriceUsdPerM ?? row.listOutputPriceUsdPerM,
      row.unitPriceUsd,
      multiplier,
    );
    return [{
      callType: formatEnterpriseBillUsageType(row.callType) || USAGE_TYPE_LABELS.total!,
      totalTokens: Math.max(0, Math.floor(Number(row.totalTokens ?? 0))),
      unitPriceUsd: catalogUnit,
      priceBasis: usd(0),
      weight: 1,
    }];
  }

  return rawParts.map((part) => {
    const customerUnitPrice = positiveMoney(part.customerUnitPrice);
    const priceBasis = customerUnitPrice.gt(0)
      ? usd(part.tokens).mul(customerUnitPrice).div(1_000_000)
      : usd(0);
    return {
      callType: formatEnterpriseBillUsageType(part.type),
      totalTokens: part.tokens,
      unitPriceUsd: part.catalogUnitPrice,
      priceBasis,
      weight: part.tokens,
    };
  });
}

/** 与财务导出一致：金额按 12 位 HALF_UP 舍入。 */
function roundExportAmount(value: Prisma.Decimal): Prisma.Decimal {
  return value.isFinite()
    ? value.toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP)
    : usd(0);
}

function positiveMoney(value: DecimalLike | null | undefined): Prisma.Decimal {
  try {
    const decimal = usd(value == null ? 0 : String(value));
    return decimal.isFinite() && decimal.gt(0) ? decimal : usd(0);
  } catch {
    return usd(0);
  }
}

export type EventRow = {
  type: string;
  amountCents: number;
  dueAt: Date | null;
  note: string | null;
  createdAt: Date;
};

export type LedgerMoneyBucket = {
  key: string;
  consumeCents: number;
  voucherCents: number;
};

export type LedgerBreakdown = {
  byTenant: LedgerMoneyBucket[];
  byModel: LedgerMoneyBucket[];
};

/**
 * 把拆分桶的消耗/券合计对齐到账单月总额：差额全部记入「未归属」。
 */
export function alignLedgerBreakdownToBill(
  breakdown: LedgerBreakdown,
  bill: Pick<BillSnapshot, 'consumeCents' | 'voucherCents'>,
): LedgerBreakdown {
  return {
    byTenant: plugBucketsToTotals(breakdown.byTenant, bill),
    byModel: plugBucketsToTotals(breakdown.byModel, bill),
  };
}

function plugBucketsToTotals(
  buckets: LedgerMoneyBucket[],
  bill: Pick<BillSnapshot, 'consumeCents' | 'voucherCents'>,
): LedgerMoneyBucket[] {
  const next = buckets.map((row) => ({ ...row }));
  const sumConsume = next.reduce((sum, row) => sum + row.consumeCents, 0);
  const sumVoucher = next.reduce((sum, row) => sum + row.voucherCents, 0);
  const consumeGap = bill.consumeCents - sumConsume;
  const voucherGap = bill.voucherCents - sumVoucher;
  if (consumeGap === 0 && voucherGap === 0) {
    return next.filter((row) => row.consumeCents !== 0 || row.voucherCents !== 0 || row.key !== UNATTRIBUTED_LEDGER_KEY);
  }
  const existing = next.find((row) => row.key === UNATTRIBUTED_LEDGER_KEY);
  if (existing) {
    existing.consumeCents += consumeGap;
    existing.voucherCents += voucherGap;
  } else {
    next.push({
      key: UNATTRIBUTED_LEDGER_KEY,
      consumeCents: consumeGap,
      voucherCents: voucherGap,
    });
  }
  return next.filter((row) =>
    row.key === UNATTRIBUTED_LEDGER_KEY
      || row.consumeCents !== 0
      || row.voucherCents !== 0);
}

/** 明细行目录金额 = 用量 / 1e6 × 目录单价（与明细「目录单价」同口径，不四舍五入）。 */
function catalogLineAmount(tokens: number, unitPriceUsd: DecimalLike | null | undefined): Prisma.Decimal {
  return usd(unitPriceUsd).mul(Math.max(0, tokens)).div(1_000_000);
}

/** 折扣 = 折后 / 目录；无目录价时有折后则视为 100%。展示保留两位小数。 */
function formatDiscountRatio(discounted: Prisma.Decimal, catalog: Prisma.Decimal): string {
  if (catalog.gt(0)) {
    return formatPercentLabel(discounted.div(catalog));
  }
  if (discounted.gt(0)) return formatPercentLabel(usd(1));
  return formatPercentLabel(usd(0));
}

/** 汇总 sheet「折扣 / 占比」展示：百分比保留两位小数。 */
function formatPercentLabel(ratio: Prisma.Decimal): string {
  const pct = Prisma.Decimal.max(0, ratio).mul(100);
  return `${pct.toFixed(2)}%`;
}

/** 金额/比例写入 Excel：保留 Decimal 精确字符串，不做 toFixed 四舍五入。 */
function formatExact(value: DecimalLike): string {
  const d = usd(value);
  if (d.isZero()) return '0';
  return d.toString();
}

/** 汇总底栏金额：元，四舍五入到 4 位小数。 */
function formatYuan4dp(value: DecimalLike): string {
  const d = usd(value);
  if (!d.isFinite()) return '0.0000';
  return d.toDecimalPlaces(4, Prisma.Decimal.ROUND_HALF_UP).toFixed(4);
}

export type DetailLine = {
  day: string;
  tenantId: string;
  model: string;
  callType: string;
  tokens: number;
  unitPriceUsd: DecimalLike | null | undefined;
  catalogAmount: Prisma.Decimal;
  totalAmount: Prisma.Decimal;
  creditAmount: Prisma.Decimal;
  debtAmount: Prisma.Decimal;
  voucherAmount: Prisma.Decimal;
  paidAmount: Prisma.Decimal;
  pendingAmount: Prisma.Decimal;
  settlementStatus: EnterpriseBillSettlementStatus;
  /** 财务同口径客户折扣倍率；有则写明细折扣比。 */
  customerMultiplier: number | null;
};

type SummaryBucket = {
  key: string;
  tokens: number;
  catalogAmount: Prisma.Decimal;
  discountedAmount: Prisma.Decimal;
};

function emptyBucket(key: string): SummaryBucket {
  return { key, tokens: 0, catalogAmount: usd(0), discountedAmount: usd(0) };
}

function detailTypeSortKey(type: string): number {
  const idx = DETAIL_TYPE_SORT_ORDER.indexOf(type as (typeof DETAIL_TYPE_SORT_ORDER)[number]);
  return idx >= 0 ? idx : DETAIL_TYPE_SORT_ORDER.length;
}

/** 折扣比的分组键：无冻结倍率记空串，和 0 区分开。 */
function detailMultiplierKey(value: number | null): string {
  return value == null ? '' : String(value);
}

/**
 * 明细聚合键：自然日 × 工作区 × 模型 × 类型 × 折扣比。
 *
 * 类型与折扣比都是分组条件：同一个「日×工作区×模型」下不同分量、不同冻结倍率
 * 各自成行，不再拼接成 `input,cache read,output` 或反推折扣比。
 * 用模板串直接拼，避免每行分配数组再 join。
 */
function detailBucketKey(input: {
  day: string;
  tenantId: string;
  model: string;
  callType: string;
  multiplierKey: string;
}): string {
  return `${input.day}\u0000${input.tenantId}\u0000${input.model}\u0000${input.callType}\u0000${input.multiplierKey}`;
}

type DayTenantModelAgg = {
  day: string;
  tenantId: string;
  model: string;
  /** 组内唯一：类型是分组键。 */
  callType: string;
  /** 组内唯一：折扣比是分组键；空串表示没有冻结倍率。 */
  multiplierKey: string;
  tokens: number;
  catalogAmount: Prisma.Decimal;
  totalAmount: Prisma.Decimal;
  creditAmount: Prisma.Decimal;
  debtAmount: Prisma.Decimal;
  voucherAmount: Prisma.Decimal;
  paidAmount: Prisma.Decimal;
  pendingAmount: Prisma.Decimal;
  unitPrices: Set<string>;
};

/**
 * 写出前按「自然日 × 工作区(tenant) × 模型 × 类型 × 折扣比」合并明细行。
 *
 * 行内金额在更上游已按价基切到各分量，这里只做同类行的 SUM；
 * 单价组内一致则保留，否则派生加权单价。
 */
export function aggregateDetailLinesByDayTenantModel(lines: DetailLine[]): DetailLine[] {
  const buckets = new Map<string, DayTenantModelAgg>();
  for (const line of lines) {
    addDetailLineToBuckets(buckets, line);
  }
  return finalizeDayTenantModelBuckets([...buckets.values()]);
}

function emptyDayTenantModelAgg(seed: {
  day: string;
  tenantId: string;
  model: string;
  callType: string;
  multiplierKey: string;
}): DayTenantModelAgg {
  return {
    day: seed.day,
    tenantId: seed.tenantId,
    model: seed.model,
    callType: seed.callType,
    multiplierKey: seed.multiplierKey,
    tokens: 0,
    catalogAmount: usd(0),
    totalAmount: usd(0),
    creditAmount: usd(0),
    debtAmount: usd(0),
    voucherAmount: usd(0),
    paidAmount: usd(0),
    pendingAmount: usd(0),
    unitPrices: new Set<string>(),
  };
}

function addDetailLineToBuckets(
  buckets: Map<string, DayTenantModelAgg>,
  line: DetailLine,
): void {
  const callType = line.callType.trim();
  if (isExcludedDetailType(callType)) return;
  const multiplierKey = detailMultiplierKey(line.customerMultiplier);
  const seed = {
    day: line.day,
    tenantId: line.tenantId,
    model: line.model,
    callType,
    multiplierKey,
  };
  const key = detailBucketKey(seed);
  const bucket = buckets.get(key) ?? emptyDayTenantModelAgg(seed);
  buckets.set(key, bucket);
  bucket.tokens += line.tokens;
  bucket.catalogAmount = bucket.catalogAmount.add(line.catalogAmount);
  bucket.totalAmount = bucket.totalAmount.add(line.totalAmount);
  bucket.creditAmount = bucket.creditAmount.add(line.creditAmount);
  bucket.debtAmount = bucket.debtAmount.add(line.debtAmount);
  bucket.voucherAmount = bucket.voucherAmount.add(line.voucherAmount);
  bucket.paidAmount = bucket.paidAmount.add(line.paidAmount);
  bucket.pendingAmount = bucket.pendingAmount.add(line.pendingAmount);
  bucket.unitPrices.add(usd(line.unitPriceUsd ?? 0).toString());
}

/** 汇总两页口径（与 `summarizeUsageRowsLikeExportSql` 一致）：仅折后 > 0 的行计入。 */
function addToSummaryBucket(
  map: Map<string, SummaryBucket>,
  key: string,
  tokens: number,
  catalogAmount: Prisma.Decimal,
  discountedAmount: Prisma.Decimal,
): void {
  if (!discountedAmount.gt(0)) return;
  const bucket = map.get(key) ?? emptyBucket(key);
  bucket.tokens += tokens;
  bucket.catalogAmount = bucket.catalogAmount.add(catalogAmount);
  bucket.discountedAmount = bucket.discountedAmount.add(discountedAmount);
  map.set(key, bucket);
}

/**
 * 明细分量的价基：tokens × 折后单价 / 1e6。
 * 行级金额按价基切到各分量，末位吃残差，保证各分量之和恒等于行级金额。
 */
type DetailPartShape = {
  callType: string;
  tokens: number;
  unitPriceUsd: DecimalLike | null | undefined;
  /** 供汇总两页使用的「折后 > 0 的行的 tokens」。 */
  positiveTokens: number;
  basis: Prisma.Decimal;
  /**
   * 用量为 0 也要写出该类型行。逐行路径的兜底分量靠它保留「类型 + 单价」，
   * 与改动前「即使 tokens 为 0 也写入类型」一致。
   */
  alwaysWrite?: boolean;
};

type ChannelAmounts = {
  totalAmount: Prisma.Decimal;
  creditAmount: Prisma.Decimal;
  debtAmount: Prisma.Decimal;
  voucherAmount: Prisma.Decimal;
  paidAmount: Prisma.Decimal;
  pendingAmount: Prisma.Decimal;
};

function emptyChannelAmounts(): ChannelAmounts {
  return {
    totalAmount: usd(0),
    creditAmount: usd(0),
    debtAmount: usd(0),
    voucherAmount: usd(0),
    paidAmount: usd(0),
    pendingAmount: usd(0),
  };
}

/**
 * 按价基把行级金额切到各分量。
 *
 * 价基全为 0（分量单价缺失）时退回 token 权重；权重也为 0 时整额落在末位，
 * 避免把金额摊给不存在的分量。末位取 `合计 − 已分`，因此**逐位**等于行级金额。
 */
function prorateChannels(parts: DetailPartShape[], channels: ChannelAmounts): ChannelAmounts[] {
  const shares: ChannelAmounts[] = parts.map(() => emptyChannelAmounts());
  if (parts.length === 0) return shares;

  const fields = [
    'totalAmount',
    'creditAmount',
    'debtAmount',
    'voucherAmount',
    'paidAmount',
    'pendingAmount',
  ] as const;

  // 单分量：整额落在唯一的行上，不需要权重和除法。
  if (parts.length === 1) {
    for (const field of fields) shares[0]![field] = roundExportAmount(channels[field]);
    return shares;
  }

  // 价基由 catalogLineAmount / positiveMoney 产出，已非负，无需再 clamp。
  const prices = parts.map((part) => part.basis);
  const priceTotal = prices.reduce((sum, value) => sum.add(value), usd(0));
  const weights = priceTotal.gt(0)
    ? prices
    : parts.map((part) => usd(Math.max(0, part.tokens)));
  const weightTotal = weights.reduce((sum, value) => sum.add(value), usd(0));

  for (const field of fields) {
    const total = roundExportAmount(channels[field]);
    // 渠道金额为 0 极常见（信用/欠款/券/待付款多为 0），直接留 0，省掉整轮除法。
    if (total.isZero()) continue;
    // 权重全 0（分量单价与用量都缺失）：整额落在末位。
    if (weightTotal.lte(0)) {
      shares[parts.length - 1]![field] = total;
      continue;
    }
    let allocated = usd(0);
    shares.forEach((share, index) => {
      const isLast = index === parts.length - 1;
      const value = isLast
        ? roundExportAmount(total.minus(allocated))
        : roundExportAmount(total.mul(weights[index]!).div(weightTotal));
      allocated = roundExportAmount(allocated.add(value));
      share[field] = value;
    });
  }
  return shares;
}

function multiplierKeyToNumber(key: string): number | null {
  if (key === '') return null;
  const parsed = Number(key);
  return Number.isFinite(parsed) ? parsed : null;
}


function beijingDayOf(createdAt: Date): string {
  return new Date(createdAt.getTime() + BEIJING_OFFSET_MS).toISOString().slice(0, 10);
}

/**
 * 单行折叠：把行级金额按价基切到各分量，再按「日×工作区×模型×类型×折扣比」入桶。
 *
 * 类型是分组键，所以行级渠道金额必须切到分量上；末位吃残差，各分量之和逐位等于行级金额，
 * 因此明细合计与汇总两页（按行口径单独累计）保持一致。
 * 非 token 分量（`chat`、`zhipu_chat` 等）不写进明细。
 */
function foldUsageRowIntoBuckets(
  buckets: Map<string, DayTenantModelAgg>,
  row: UsageRow,
  summary: SummaryAccumulator,
  day = beijingDayOf(row.createdAt),
): void {
  const parts = expandUsageDetailParts(row);
  if (parts.length === 0) return;
  const tenantId = row.tenantId?.trim() || UNATTRIBUTED_LEDGER_KEY;
  const model = row.model?.trim() || 'unknown';
  const multiplier = resolveCustomerMultiplier(row);
  const multiplierKey = detailMultiplierKey(multiplier);
  const channels = splitUsageChannels(row);

  // 汇总两页保持原口径：按整行（含被明细白名单丢掉的兜底分量）累计，不受明细拆分影响。
  let rowTokens = 0;
  let rowCatalog = usd(0);
  for (const part of parts) {
    const partTokens = part.totalTokens ?? 0;
    rowTokens += partTokens;
    rowCatalog = rowCatalog.add(catalogLineAmount(partTokens, part.unitPriceUsd));
  }
  accumulateSummary(summary, {
    tenantId,
    model,
    tokens: rowTokens,
    catalogAmount: rowCatalog,
    channels,
  });

  const shapes: DetailPartShape[] = parts.map((part) => ({
    callType: part.callType.trim(),
    tokens: part.totalTokens ?? 0,
    unitPriceUsd: part.unitPriceUsd,
    positiveTokens: 0,
    basis: part.priceBasis,
  }));
  const kept = shapes.filter((part) => !isExcludedDetailType(part.callType));
  if (kept.length === 0) return;
  const shares = prorateChannels(kept, channels);
  kept.forEach((part, index) => {
    const seed = {
      day,
      tenantId,
      model,
      callType: part.callType,
      multiplierKey,
    };
    const key = detailBucketKey(seed);
    const bucket = buckets.get(key) ?? emptyDayTenantModelAgg(seed);
    buckets.set(key, bucket);
    bucket.tokens += part.tokens;
    bucket.catalogAmount = bucket.catalogAmount.add(
      catalogLineAmount(part.tokens, part.unitPriceUsd),
    );
    bucket.unitPrices.add(usd(part.unitPriceUsd ?? 0).toString());
    const share = shares[index]!;
    bucket.totalAmount = bucket.totalAmount.add(share.totalAmount);
    bucket.creditAmount = bucket.creditAmount.add(share.creditAmount);
    bucket.debtAmount = bucket.debtAmount.add(share.debtAmount);
    bucket.voucherAmount = bucket.voucherAmount.add(share.voucherAmount);
    bucket.paidAmount = bucket.paidAmount.add(share.paidAmount);
    bucket.pendingAmount = bucket.pendingAmount.add(share.pendingAmount);
  });
}

/** 汇总两页的累计器：与明细拆分解耦，始终按整行口径。 */
type SummaryAccumulator = {
  byTenant: Map<string, SummaryBucket>;
  byModel: Map<string, SummaryBucket>;
  footerConsume: Prisma.Decimal;
  footerVoucher: Prisma.Decimal;
};

function emptySummaryAccumulator(): SummaryAccumulator {
  return {
    byTenant: new Map<string, SummaryBucket>(),
    byModel: new Map<string, SummaryBucket>(),
    footerConsume: usd(0),
    footerVoucher: usd(0),
  };
}

function accumulateSummary(
  summary: SummaryAccumulator,
  input: {
    tenantId: string;
    model: string;
    tokens: number;
    catalogAmount: Prisma.Decimal;
    channels: ChannelAmounts;
  },
): void {
  // 底栏覆盖全部行；分账号/模型只算折后 > 0 的行（与 SQL 口径一致）。
  summary.footerConsume = summary.footerConsume.add(input.channels.totalAmount);
  summary.footerVoucher = summary.footerVoucher.add(input.channels.voucherAmount);
  addToSummaryBucket(
    summary.byTenant,
    input.tenantId,
    input.tokens,
    input.catalogAmount,
    input.channels.totalAmount,
  );
  addToSummaryBucket(
    summary.byModel,
    input.model,
    input.tokens,
    input.catalogAmount,
    input.channels.totalAmount,
  );
}

function compareDayTenantModel(a: DayTenantModelAgg, b: DayTenantModelAgg): number {
  // 无冻结倍率的行排在有倍率的行之后，便于对账时先看明确折扣的行。
  const multiplierOrder = (key: string, other: string): number => {
    if (key === other) return 0;
    if (key === '') return 1;
    if (other === '') return -1;
    return key.localeCompare(other);
  };
  return a.day.localeCompare(b.day)
    || a.tenantId.localeCompare(b.tenantId)
    || a.model.localeCompare(b.model)
    || detailTypeSortKey(a.callType) - detailTypeSortKey(b.callType)
    || a.callType.localeCompare(b.callType)
    || multiplierOrder(a.multiplierKey, b.multiplierKey);
}

/**
 * 导出用的流式聚合器：依赖 iterateUsagePages 的「自然日递增」遍历顺序。
 * 换日即 flush，内存上限 = 单日 tenant×model×类型×折扣比 桶数，与整月明细行数无关。
 */
class DayTenantModelStreamer {
  private readonly buckets = new Map<string, DayTenantModelAgg>();
  private day: string | null = null;

  constructor(
    private readonly emit: (aggs: DayTenantModelAgg[]) => void,
    private readonly summary: SummaryAccumulator,
  ) {}

  addRow(row: UsageRow): void {
    const day = beijingDayOf(row.createdAt);
    if (this.day !== null && day !== this.day) this.flush();
    this.day = day;
    foldUsageRowIntoBuckets(this.buckets, row, this.summary, day);
  }

  flush(): void {
    this.day = null;
    if (this.buckets.size === 0) return;
    const aggs = [...this.buckets.values()];
    this.buckets.clear();
    this.emit(aggs);
  }
}

function finalizeDayTenantModelBuckets(
  aggs: DayTenantModelAgg[],
): DetailLine[] {
  return [...aggs]
    .sort(compareDayTenantModel)
    .map((bucket) => {
      let unitPriceUsd: DecimalLike = 0;
      if (bucket.unitPrices.size === 1) {
        unitPriceUsd = [...bucket.unitPrices][0]!;
      } else if (bucket.tokens > 0 && bucket.catalogAmount.gt(0)) {
        unitPriceUsd = bucket.catalogAmount.mul(1_000_000).div(bucket.tokens);
      }
      const customerMultiplier = multiplierKeyToNumber(bucket.multiplierKey);
      const totalAmount = roundExportAmount(bucket.totalAmount);
      const pendingAmount = roundExportAmount(bucket.pendingAmount);
      return {
        day: bucket.day,
        tenantId: bucket.tenantId,
        model: bucket.model,
        callType: bucket.callType,
        tokens: bucket.tokens,
        unitPriceUsd,
        catalogAmount: bucket.catalogAmount,
        totalAmount,
        creditAmount: roundExportAmount(bucket.creditAmount),
        debtAmount: roundExportAmount(bucket.debtAmount),
        voucherAmount: roundExportAmount(bucket.voucherAmount),
        paidAmount: roundExportAmount(bucket.paidAmount),
        pendingAmount,
        settlementStatus: settlementStatusFromPending(totalAmount, pendingAmount),
        customerMultiplier,
      };
    });
}

/**
 * SQL 聚合组 → 明细分量。
 *
 * 与 `foldUsageRowIntoBuckets` 同源：SQL 已把可交换的求和（分量 token、渠道金额、
 * 折后 > 0 的分量 token）算完，这里只补上**不可交换**的部分 ——
 * `目录单价 = 折后单价 / 倍率` 与 `目录价格 = 单价 × 用量 / 1e6`，仍走 decimal.js。
 *
 * 返回全部分量（含 0 用量的分量与兜底分量），供汇总两页保持原口径；
 * 明细侧再按「有用量 / 必须保留类型 / token 分量白名单」筛出要写出的行。
 */
function aggregateGroupParts(
  group: EnterpriseUsageAggregateRow,
  multiplier: number | null,
): DetailPartShape[] {
  const prices: Array<{ callType: string; tokens: number; positiveTokens: number; customer: string | null; }> = [
    {
      callType: USAGE_TYPE_LABELS.input!,
      tokens: aggregateInt(group.input_tokens),
      positiveTokens: aggregateInt(group.input_positive_tokens),
      customer: group.input_price ?? group.unit_price,
    },
    {
      callType: USAGE_TYPE_LABELS['cache read']!,
      tokens: aggregateInt(group.cache_read_tokens),
      positiveTokens: aggregateInt(group.cache_read_positive_tokens),
      customer: group.cached_price ?? group.input_price ?? group.unit_price,
    },
    {
      callType: USAGE_TYPE_LABELS['cache write']!,
      tokens: aggregateInt(group.cache_write_tokens),
      positiveTokens: aggregateInt(group.cache_write_positive_tokens),
      customer: group.cache_write_price ?? group.input_price ?? group.unit_price,
    },
    {
      callType: USAGE_TYPE_LABELS.output!,
      tokens: aggregateInt(group.output_tokens),
      positiveTokens: aggregateInt(group.output_positive_tokens),
      customer: group.output_price ?? group.unit_price,
    },
  ];

  const parts: DetailPartShape[] = prices.map((part) => ({
    callType: part.callType,
    tokens: part.tokens,
    positiveTokens: part.positiveTokens,
    unitPriceUsd: catalogUnitFromColumns(undefined, part.customer, multiplier),
    // 价基用折后单价：与逐行路径的 priceBasis 同口径。
    basis: positiveMoney(part.customer).mul(part.tokens).div(1_000_000),
  }));

  if (aggregateInt(group.fallback_rows) > 0) {
    // 四分量全 0 的行回退成一个分量：逐行路径同样会写入类型与单价，即使 tokens 为 0。
    const fallbackUnitPrice = catalogUnitFromColumns(undefined, group.unit_price, multiplier);
    const fallbackTokens = aggregateInt(group.fallback_tokens);
    parts.push({
      callType: formatEnterpriseBillUsageType(group.call_type) || USAGE_TYPE_LABELS.total!,
      tokens: fallbackTokens,
      positiveTokens: aggregateInt(group.fallback_positive_tokens),
      unitPriceUsd: fallbackUnitPrice,
      basis: positiveMoney(group.unit_price).mul(fallbackTokens).div(1_000_000),
      alwaysWrite: true,
    });
  }
  return parts;
}

/**
 * 聚合组 → 明细桶。
 *
 * 分组键含类型与折扣比，所以组级金额要按价基切到各分量；
 * 末位吃残差保证各分量之和逐位等于组级金额。
 */
function addAggregateGroupToDetailBuckets(
  buckets: Map<string, DayTenantModelAgg>,
  group: EnterpriseUsageAggregateRow,
  parts: DetailPartShape[],
  multiplier: number | null,
): void {
  const day = group.day;
  const tenantId = group.tenant_id?.trim() || UNATTRIBUTED_LEDGER_KEY;
  const model = group.model?.trim() || 'unknown';
  const multiplierKey = detailMultiplierKey(multiplier);
  const kept = parts.filter((part) => (part.tokens > 0 || part.alwaysWrite === true)
    && !isExcludedDetailType(part.callType));
  if (kept.length === 0) return;
  const shares = prorateChannels(kept, {
    totalAmount: usd(group.total_amount),
    creditAmount: usd(group.credit_amount),
    debtAmount: usd(group.debt_amount),
    voucherAmount: usd(group.voucher_amount),
    paidAmount: usd(group.paid_amount),
    pendingAmount: usd(group.pending_amount),
  });
  kept.forEach((part, index) => {
    const seed = { day, tenantId, model, callType: part.callType, multiplierKey };
    const key = detailBucketKey(seed);
    const bucket = buckets.get(key) ?? emptyDayTenantModelAgg(seed);
    buckets.set(key, bucket);
    bucket.tokens += part.tokens;
    bucket.catalogAmount = bucket.catalogAmount.add(
      catalogLineAmount(part.tokens, part.unitPriceUsd),
    );
    bucket.unitPrices.add(usd(part.unitPriceUsd ?? 0).toString());
    const share = shares[index]!;
    bucket.totalAmount = bucket.totalAmount.add(share.totalAmount);
    bucket.creditAmount = bucket.creditAmount.add(share.creditAmount);
    bucket.debtAmount = bucket.debtAmount.add(share.debtAmount);
    bucket.voucherAmount = bucket.voucherAmount.add(share.voucherAmount);
    bucket.paidAmount = bucket.paidAmount.add(share.paidAmount);
    bucket.pendingAmount = bucket.pendingAmount.add(share.pendingAmount);
  });
}

/** 与 `resolveCustomerMultiplier` 的文本分支同口径。 */
function aggregateMultiplier(raw: string | null): number | null {
  if (raw == null || raw === '') return null;
  try {
    const parsed = usd(raw);
    return parsed.isFinite() && parsed.gte(0) ? parsed.toNumber() : null;
  } catch {
    return null;
  }
}

function aggregateInt(raw: string | null | undefined): number {
  const value = Number(raw ?? 0);
  return Number.isFinite(value) ? Math.max(0, Math.trunc(value)) : 0;
}

/**
 * SQL 聚合结果 → 明细行 + 汇总两页。
 *
 * 汇总两页**逐组**按原口径累计（底栏消耗/券覆盖全部行，分账号/模型只算折后 > 0 的行），
 * 不受明细按「类型 × 折扣比」拆分影响；明细则拆成更细的行。
 */
export function buildExportBucketsFromAggregateGroups(
  groups: Iterable<EnterpriseUsageAggregateRow>,
): { lines: DetailLine[]; summary: EnterpriseBillXlsxSummary } {
  const buckets = new Map<string, DayTenantModelAgg>();
  const summary = emptySummaryAccumulator();
  for (const group of groups) {
    const multiplier = aggregateMultiplier(group.multiplier);
    const parts = aggregateGroupParts(group, multiplier);
    addAggregateGroupToDetailBuckets(buckets, group, parts, multiplier);

    const tenantId = group.tenant_id?.trim() || UNATTRIBUTED_LEDGER_KEY;
    const model = group.model?.trim() || 'unknown';
    let positiveTokens = 0;
    let positiveCatalogAmount = usd(0);
    for (const part of parts) {
      positiveTokens += part.positiveTokens;
      positiveCatalogAmount = positiveCatalogAmount.add(
        catalogLineAmount(part.positiveTokens, part.unitPriceUsd),
      );
    }
    accumulateSummary(summary, {
      tenantId,
      model,
      tokens: positiveTokens,
      catalogAmount: positiveCatalogAmount,
      channels: {
        totalAmount: usd(group.total_amount),
        creditAmount: usd(group.credit_amount),
        debtAmount: usd(group.debt_amount),
        voucherAmount: usd(group.voucher_amount),
        paidAmount: usd(group.paid_amount),
        pendingAmount: usd(group.pending_amount),
      },
    });
  }

  return {
    lines: finalizeDayTenantModelBuckets([...buckets.values()]),
    summary: {
      byTenant: summary.byTenant,
      byModel: summary.byModel,
      footerConsume: summary.footerConsume,
      footerVoucher: summary.footerVoucher,
    },
  };
}


/**
 * 财务同口径：结算冻结的 customerMultiplier；无效/缺失时返回 null。
 */
export function resolveCustomerMultiplier(row: UsageRow): number | null {
  if (typeof row.customerMultiplier === 'number') {
    return Number.isFinite(row.customerMultiplier) && row.customerMultiplier >= 0
      ? row.customerMultiplier
      : null;
  }
  const snapshot = row.gatewayBillingEvent?.settlementAnchor?.customerPricingSnapshot;
  if (snapshot == null || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const value = (snapshot as Record<string, unknown>).customerMultiplier;
  if (typeof value !== 'string' && typeof value !== 'number') return null;
  try {
    const multiplier = usd(value);
    return multiplier.isFinite() && multiplier.gte(0) ? multiplier.toNumber() : null;
  } catch {
    return null;
  }
}

/**
 * 目录单价：有 LIST 列用 LIST；否则 折后单价 / 冻结折扣比。
 * 倍率缺失或 ≤0 时退回折后单价（视为 100%）。
 */
export function catalogUnitFromColumns(
  listPrice: DecimalLike | null | undefined,
  customerPrice: DecimalLike | null | undefined,
  multiplier: number | null,
): DecimalLike | null | undefined {
  if (positiveMoney(listPrice).gt(0)) return listPrice;
  const customer = positiveMoney(customerPrice);
  if (customer.gt(0) && multiplier != null && multiplier > 0) {
    return customer.div(multiplier);
  }
  return customerPrice ?? listPrice;
}

/**
 * 下载汇总 SQL 的 JS 对照：用量/目录价按明细分量，折后用行级 splitUsageChannels。
 * 有折后时整行分量进桶，避免再扫一遍明细。list_* 仅 JS 可见，SQL 用折后单价 / 快照倍率。
 */
export function summarizeUsageRowsLikeExportSql(rows: UsageRow[]): EnterpriseBillXlsxSummary {
  const byTenant = new Map<string, SummaryBucket>();
  const byModel = new Map<string, SummaryBucket>();
  let footerConsume = usd(0);
  let footerVoucher = usd(0);
  for (const row of rows) {
    const channels = splitUsageChannels(row);
    const discounted = channels.totalAmount;
    footerConsume = footerConsume.add(discounted);
    footerVoucher = footerVoucher.add(channels.voucherAmount);
    if (!discounted.gt(0)) continue;
    const parts = expandUsageDetailParts(row);
    let tokens = 0;
    let catalog = usd(0);
    for (const part of parts) {
      tokens += part.totalTokens ?? 0;
      catalog = catalog.add(catalogLineAmount(part.totalTokens ?? 0, part.unitPriceUsd));
    }
    const tenantId = row.tenantId?.trim() || UNATTRIBUTED_LEDGER_KEY;
    const model = row.model?.trim() || 'unknown';
    const bump = (map: Map<string, SummaryBucket>, key: string) => {
      const bucket = map.get(key) ?? emptyBucket(key);
      bucket.tokens += tokens;
      bucket.catalogAmount = bucket.catalogAmount.add(catalog);
      bucket.discountedAmount = bucket.discountedAmount.add(discounted);
      map.set(key, bucket);
    };
    bump(byTenant, tenantId);
    bump(byModel, model);
  }
  return { byTenant, byModel, footerConsume, footerVoucher };
}

/** 明细折扣比：优先冻结倍率，否则总消耗/目录价反推。 */
function formatDetailDiscountRatio(line: DetailLine): string {
  if (line.customerMultiplier != null) {
    return formatExact(line.customerMultiplier);
  }
  return formatExact(
    line.catalogAmount.gt(0)
      ? line.totalAmount.div(line.catalogAmount)
      : (line.totalAmount.gt(0) ? 1 : 0),
  );
}

/** `瀚海云联科技有限公司—账单汇总` */
export function sheetTitle(enterpriseName: string, sheetLabel: string): string {
  const name = enterpriseName.trim() || '企业账户';
  return `${name}—${sheetLabel}`;
}

/** 统计口径标签（已定格/未定格截止时刻）；导出文件名不再拼接，保留供测试与其它展示复用。 */
export function statsCaliberFilenameTag(input: {
  yearMonth: string;
  currentMonth: boolean;
  exportedAt: Date;
}): string {
  const endExclusive = exportUsageCutoff({
    yearMonth: input.yearMonth,
    currentMonth: input.currentMonth,
    now: input.exportedAt,
  });
  const inclusive = new Date(endExclusive.getTime() - 1);
  const stamp = formatBeijingDateTime(inclusive).replace(/[:\s，,]/g, '');
  const freezeLabel = input.currentMonth ? '未定格' : '已定格';
  return `数据截至${stamp}${freezeLabel}`;
}

export type UsagePageSource = UsageRow[] | (() => AsyncIterable<UsageRow[]>);

export type EnterpriseBillXlsxSummary = {
  byTenant: Map<string, { key: string; tokens: number; catalogAmount: Prisma.Decimal; discountedAmount: Prisma.Decimal }>;
  byModel: Map<string, { key: string; tokens: number; catalogAmount: Prisma.Decimal; discountedAmount: Prisma.Decimal }>;
  footerConsume: Prisma.Decimal;
  footerVoucher: Prisma.Decimal;
};

export type EnterpriseBillXlsxInput = {
  yearMonth: string;
  currentMonth: boolean;
  exportedAt: Date;
  enterpriseName: string;
  prepaid?: boolean;
  bill: BillSnapshot;
  events: EventRow[];
  /** 逐行扫描用；与 `aggregated` 二选一。 */
  usage?: UsagePageSource;
  ledger: LedgerBreakdown;
  /** 有预聚合汇总时不再先扫一遍用量；明细仍流式写。 */
  summary?: EnterpriseBillXlsxSummary;
  /**
   * SQL 聚合下推结果：汇总两页与明细都来自同一批「日×工作区×模型」桶，
   * 不再逐行拉 token_usage（头文 9 月 115 万行 → 几十行）。
   */
  aggregated?: { summary: EnterpriseBillXlsxSummary; lines: DetailLine[] };
  /** 单 sheet 总行上限（含标题/账期/表头 3 行）；默认 EXCEL_MAX_ROWS。满额即拆下一页，跨日和同一自然日都拆。测试可调小。 */
  maxDetailRows?: number;
  /** 每写完一个自然日的明细即回调（已完成行数）；流式模式下用于观测进度。 */
  onDetailRowsWritten?: (writtenRows: number) => void;
};

export async function buildEnterpriseBillXlsx(input: EnterpriseBillXlsxInput): Promise<Buffer> {
  const stream = new PassThrough();
  const chunks: Buffer[] = [];
  stream.on('data', (chunk: Buffer | string) => {
    chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
  });
  const finished = new Promise<void>((resolve, reject) => {
    stream.on('finish', () => resolve());
    stream.on('error', reject);
  });
  await writeEnterpriseBillXlsx({ ...input, dest: stream });
  await finished;
  return Buffer.concat(chunks);
}

/**
 * 先写汇总两页再写明细。有预聚合 summary 时不再先扫用量，第一字节可以马上出去。
 * ExcelJS 流式 WorkbookWriter 只能按添加顺序出 sheet，不能先写明细再插到前面。
 */
export async function writeEnterpriseBillXlsx(
  input: EnterpriseBillXlsxInput & { dest: Writable },
): Promise<void> {
  // ledger / bill 参数保留给调用方；汇总由同一遍折叠得出。
  void input.ledger;
  void input.bill;
  const periodLabel = `账期：${input.yearMonth.replace('-', '年')}月（北京时间）`;
  // 汇总与明细出自同一遍折叠：不再为汇总单独扫一遍库。
  // SQL 聚合下推时汇总与明细都已就绪；否则先折叠整月再落盘。
  const bufferedLines: DetailLine[] | null = input.aggregated
    ? input.aggregated.lines
    : input.summary
      ? null
      : [];
  const summary = input.aggregated?.summary
    ?? input.summary
    ?? await foldUsageForExport(requireUsageSource(input), (lines) => {
      for (const line of lines) bufferedLines!.push(line);
    });
  const { byTenant, byModel, footerConsume, footerVoucher } = summary;

  const usageHeader = [
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
  ];
  const workbook = new ExcelJS.stream.xlsx.WorkbookWriter({
    stream: input.dest,
    useStyles: true,
    useSharedStrings: false,
    // archiver 默认 data-descriptor 会把 workbook/styles 的 uncompressed size 写成 0，Excel 会提示修复。
    zip: { store: true },
  });

  const tenantDiscountedTotal = [...byTenant.values()].reduce(
    (sum, row) => sum.add(Prisma.Decimal.max(0, row.discountedAmount)),
    usd(0),
  );
  const modelDiscountedTotal = [...byModel.values()].reduce(
    (sum, row) => sum.add(Prisma.Decimal.max(0, row.discountedAmount)),
    usd(0),
  );
  const summaryHeader = ['序号', '账号ID', '用量(token)', '目录总价(¥)', '折后金额(¥)', '折扣', '占比'];
  const summaryRows: CellValue[][] = [
    [sheetTitle(input.enterpriseName, '账单汇总')],
    [periodLabel],
    summaryHeader,
  ];
  let accountIndex = 0;
  for (const bucket of [...byTenant.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    accountIndex += 1;
    const share = tenantDiscountedTotal.gt(0)
      ? Prisma.Decimal.max(0, bucket.discountedAmount).div(tenantDiscountedTotal)
      : usd(0);
    summaryRows.push([
      accountIndex,
      bucket.key,
      bucket.tokens,
      formatExact(bucket.catalogAmount),
      formatExact(bucket.discountedAmount),
      formatDiscountRatio(bucket.discountedAmount, bucket.catalogAmount),
      formatPercentLabel(share),
    ]);
  }
  const footerStartIndex = summaryRows.length;
  const footerReceivable = footerConsume.minus(footerVoucher);
  summaryRows.push(['合计（消耗金额）', '', '', '', formatYuan4dp(footerConsume)]);
  summaryRows.push(['代金券扣费', '', '', '', formatYuan4dp(footerVoucher.neg())]);
  summaryRows.push(['应收金额', '', '', '', formatYuan4dp(footerReceivable)]);
  const summaryFooterMerges = [0, 1, 2].map((offset) => {
    const excelRow = footerStartIndex + offset + 1;
    return `A${excelRow}:D${excelRow}`;
  });

  const modelHeader = ['序号', '模型', '用量（Token）', '目录总价(¥)', '折后金额(¥)', '折扣', '占比'];
  const modelRows: CellValue[][] = [
    [sheetTitle(input.enterpriseName, '产品模型汇总')],
    [periodLabel],
    modelHeader,
  ];
  let modelIndex = 0;
  let modelCatalogTotal = usd(0);
  let modelDiscountedSum = usd(0);
  let modelTokenTotal = 0;
  for (const bucket of [...byModel.values()].sort((a, b) => a.key.localeCompare(b.key))) {
    modelIndex += 1;
    modelCatalogTotal = modelCatalogTotal.add(bucket.catalogAmount);
    modelDiscountedSum = modelDiscountedSum.add(bucket.discountedAmount);
    modelTokenTotal += bucket.tokens;
    const share = modelDiscountedTotal.gt(0)
      ? Prisma.Decimal.max(0, bucket.discountedAmount).div(modelDiscountedTotal)
      : usd(0);
    modelRows.push([
      modelIndex,
      bucket.key,
      bucket.tokens,
      formatExact(bucket.catalogAmount),
      formatExact(bucket.discountedAmount),
      formatDiscountRatio(bucket.discountedAmount, bucket.catalogAmount),
      formatPercentLabel(share),
    ]);
  }
  modelRows.push([
    '总计',
    '',
    modelTokenTotal,
    formatExact(modelCatalogTotal),
    formatExact(modelDiscountedSum),
    formatDiscountRatio(modelDiscountedSum, modelCatalogTotal),
    formatPercentLabel(modelDiscountedSum.gt(0) ? usd(1) : usd(0)),
  ]);
  writeBufferedSheet(workbook, {
    name: '账单汇总',
    rows: summaryRows,
    columnCount: summaryHeader.length,
    headerRowIndex: 2,
    rightAlignCols: [2, 3, 4, 5, 6],
    centerCols: [0],
    extraMerges: summaryFooterMerges,
    centeredLabelCols: [{ col: 0, fromRow: footerStartIndex, toRow: footerStartIndex + 2 }],
  });
  writeBufferedSheet(workbook, {
    name: '产品模型汇总',
    rows: modelRows,
    columnCount: modelHeader.length,
    headerRowIndex: 2,
    rightAlignCols: [2, 3, 4, 5, 6],
    centerCols: [0],
  });
  // 让汇总页 zip 字节先出到 dest，下载栏不必等明细扫完。
  await new Promise<void>((resolve) => setImmediate(resolve));

  const detailTitle = sheetTitle(input.enterpriseName, '账单明细');
  const maxDataRows = Math.max(1, (input.maxDetailRows ?? EXCEL_MAX_ROWS) - 3);
  const detailStyle: Pick<SheetSpec, 'headerRowIndex' | 'rightAlignCols' | 'centerCols'> = {
    headerRowIndex: 2,
    rightAlignCols: [4, 5, 7, 9, 10, 11, 12, 13, 14, 15],
  };
  let detailSheet: ExcelJS.Worksheet | null = null;
  let detailSheetIndex = 0;
  let dataRowsInSheet = 0;
  let writtenConsume = usd(0);
  let writtenChargeTokens = 0;
  let writtenChargeCatalog = usd(0);

  const openDetailSheet = (): ExcelJS.Worksheet => {
    detailSheetIndex += 1;
    const name = detailSheetIndex === 1 ? '账单明细' : `账单明细-${detailSheetIndex}`;
    const worksheet = workbook.addWorksheet(name);
    worksheet.columns = usageHeader.map((label, colIndex) => ({
      width: autoColWidth([[], [], usageHeader], colIndex, 2),
    }));
    const preface = [[detailTitle], [periodLabel], usageHeader];
    preface.forEach((values, rowIndex) => {
      const row = addStyledRow(worksheet, detailStyle, values, rowIndex, usageHeader.length);
      if (rowIndex === 0) row.height = 30;
      if (rowIndex === 0) {
        worksheet.mergeCells(`A1:${cellRef(usageHeader.length - 1, 0)}`);
      }
      row.commit();
    });
    dataRowsInSheet = 0;
    return worksheet;
  };

  // 逐日聚合后立刻写出：内存只保留当前自然日的 tenant×model 桶，不随整月明细行数增长。
  let writtenDetailRows = 0;
  const writeDetailLine = (line: DetailLine): void => {
    const values = usageCells(line);
    // 满额即开下一页，跨日和同一自然日都拆；不再等换日。
    if (!detailSheet || dataRowsInSheet >= maxDataRows) {
      detailSheet?.commit();
      detailSheet = openDetailSheet();
    }
    const row = addStyledRow(detailSheet, detailStyle, values, 3 + dataRowsInSheet, usageHeader.length);
    row.commit();
    dataRowsInSheet += 1;
    writtenDetailRows += 1;
    writtenConsume = writtenConsume.add(line.totalAmount);
    if (line.totalAmount.gt(0)) {
      writtenChargeTokens += line.tokens;
      writtenChargeCatalog = writtenChargeCatalog.add(line.catalogAmount);
    }
  };
  if (bufferedLines) {
    // 汇总已由折叠算出：明细行（已聚合，千级）一次性落盘。
    for (const line of bufferedLines) writeDetailLine(line);
    input.onDetailRowsWritten?.(writtenDetailRows);
  } else {
    const streamer = new DayTenantModelStreamer(
      (aggs) => {
        for (const line of finalizeDayTenantModelBuckets(aggs)) writeDetailLine(line);
        input.onDetailRowsWritten?.(writtenDetailRows);
      },
      // 汇总两页由调用方传入，这里只为与折叠路径共用同一签名。
      emptySummaryAccumulator(),
    );
    for await (const page of iterateUsagePages(requireUsageSource(input))) {
      for (const row of page) streamer.addRow(row);
    }
    streamer.flush();
  }
  if (!detailSheet) {
    detailSheet = openDetailSheet();
  }
  detailSheet.commit();
  assertExportDetailMatchesSummary({
    writtenConsume,
    writtenChargeTokens,
    writtenChargeCatalog,
    footerConsume,
    byTenant,
  });
  await workbook.commit();
}

function assertExportDetailMatchesSummary(input: {
  writtenConsume: Prisma.Decimal;
  writtenChargeTokens: number;
  writtenChargeCatalog: Prisma.Decimal;
  footerConsume: Prisma.Decimal;
  byTenant: Map<string, SummaryBucket>;
}): void {
  const summaryTokens = [...input.byTenant.values()].reduce((sum, bucket) => sum + bucket.tokens, 0);
  const summaryCatalog = [...input.byTenant.values()].reduce(
    (sum, bucket) => sum.add(bucket.catalogAmount),
    usd(0),
  );
  const consumeMatch = roundExportAmount(input.writtenConsume)
    .eq(roundExportAmount(input.footerConsume));
  const catalogMatch = roundExportAmount(input.writtenChargeCatalog)
    .eq(roundExportAmount(summaryCatalog));
  if (input.writtenChargeTokens === summaryTokens && consumeMatch && catalogMatch) {
    return;
  }
  throw new Error(
    `enterprise bill export detail mismatch: tokens ${input.writtenChargeTokens} vs ${summaryTokens}, `
    + `consume ${input.writtenConsume.toString()} vs ${input.footerConsume.toString()}, `
    + `catalog ${input.writtenChargeCatalog.toString()} vs ${summaryCatalog.toString()}`,
  );
}

/**
 * 一遍折叠同时产出汇总两页与明细聚合行。
 * 口径与 `summarizeUsageRowsLikeExportSql` 一致：折后 > 0 的行才进汇总桶，
 * 底栏消耗/代金券覆盖全部行。
 */
function requireUsageSource(input: EnterpriseBillXlsxInput): UsagePageSource {
  if (!input.usage) {
    throw new Error('enterprise bill export: usage source or aggregated buckets required');
  }
  return input.usage;
}

async function foldUsageForExport(
  usage: UsagePageSource,
  onDayLines: (lines: DetailLine[]) => void,
): Promise<EnterpriseBillXlsxSummary> {
  // 汇总由累计器按整行口径产出，与明细按「类型 × 折扣比」拆分互不影响。
  const summary = emptySummaryAccumulator();
  const streamer = new DayTenantModelStreamer(
    (aggs) => onDayLines(finalizeDayTenantModelBuckets(aggs)),
    summary,
  );
  for await (const page of iterateUsagePages(usage)) {
    for (const row of page) streamer.addRow(row);
  }
  streamer.flush();
  return {
    byTenant: summary.byTenant,
    byModel: summary.byModel,
    footerConsume: summary.footerConsume,
    footerVoucher: summary.footerVoucher,
  };
}

async function* iterateUsagePages(source: UsagePageSource): AsyncGenerator<UsageRow[]> {
  if (Array.isArray(source)) {
    if (source.length > 0) yield source;
    return;
  }
  yield* source();
}

function usageCells(line: DetailLine): CellValue[] {
  return [
    line.day,
    line.tenantId === UNATTRIBUTED_LEDGER_KEY ? '' : line.tenantId,
    line.model === 'unknown' ? '' : line.model,
    line.callType,
    line.tokens,
    formatExact(line.unitPriceUsd ?? 0),
    '百万token',
    formatDetailDiscountRatio(line),
    'CNY',
    formatExact(line.catalogAmount),
    formatExact(line.totalAmount),
    formatExact(line.paidAmount),
    formatExact(line.creditAmount),
    formatExact(line.debtAmount),
    formatExact(line.voucherAmount),
    formatExact(line.paidAmount),
    formatExact(line.pendingAmount),
    line.settlementStatus,
  ];
}

/**
 * 账单明细支付渠道 = 财务「API用量扣费」同口径（`financeApiUsageChannelUsd`）。
 * - 总消耗：customerChargeUsd（分摊 amount 合计，否则回退 customerCharge / legacy cost）
 * - 账户支付金额 / 已付款金额：paymentDeductionUsd 本金扣费
 * - 代金券抵扣金额：voucherDeductionUsd 赠送扣费（仅已收款分摊）
 * - 信用支付金额：已分类 approvedCreditUsd / 快照已批准应收；未分类不计信用
 * - 欠款金额：已分类 unapprovedDebtUsd / 快照未批准欠款；未分类接 amountUsd
 * - 待付款：总消耗 − 本金 − 券 − 信用 − 欠款 的勾稽残差（溢出先削信用再削本金）
 */
export function splitUsageChannels(
  row: UsageRow,
): {
  totalAmount: Prisma.Decimal;
  creditAmount: Prisma.Decimal;
  debtAmount: Prisma.Decimal;
  voucherAmount: Prisma.Decimal;
  paidAmount: Prisma.Decimal;
  pendingAmount: Prisma.Decimal;
  settlementStatus: EnterpriseBillSettlementStatus;
} {
  const channels = financeApiUsageChannelUsd({
    customerChargeUsd: row.customerChargeUsd,
    costUsd: row.costUsd,
    customerChargePolicy: row.customerChargePolicy,
    customerCollectedUsd: row.customerCollectedUsd,
    customerApprovedReceivableUsd: row.customerApprovedReceivableUsd,
    customerUnapprovedDebtUsd: row.customerUnapprovedDebtUsd,
    customerFundingClassificationComplete: row.customerFundingClassificationComplete,
    allocations: row.consumptionAllocations ?? [],
  });
  const totalAmount = channels.customerChargeUsd;
  let paidAmount = channels.paymentDeductionUsd;
  const voucherAmount = channels.voucherDeductionUsd;
  let creditAmount = channels.creditDeductionUsd;
  const debtAmount = channels.debtDeductionUsd;
  let pendingAmount = usd(0);

  const accounted = voucherAmount.add(paidAmount).add(creditAmount).add(debtAmount);
  if (accounted.lt(totalAmount)) {
    pendingAmount = totalAmount.sub(accounted);
  } else if (accounted.gt(totalAmount)) {
    let overflow = accounted.sub(totalAmount);
    const cutCredit = Prisma.Decimal.min(creditAmount, overflow);
    creditAmount = creditAmount.sub(cutCredit);
    overflow = overflow.sub(cutCredit);
    if (overflow.gt(0)) {
      paidAmount = Prisma.Decimal.max(0, paidAmount.sub(overflow));
    }
  }

  const roundedTotal = roundExportAmount(totalAmount);
  const roundedPending = roundExportAmount(pendingAmount);
  return {
    totalAmount: roundedTotal,
    creditAmount: roundExportAmount(creditAmount),
    debtAmount: roundExportAmount(debtAmount),
    voucherAmount: roundExportAmount(voucherAmount),
    paidAmount: roundExportAmount(paidAmount),
    pendingAmount: roundedPending,
    settlementStatus: settlementStatusFromPending(roundedTotal, roundedPending),
  };
}

function formatBeijingDateTime(at: Date): string {
  const beijing = new Date(at.getTime() + BEIJING_OFFSET_MS);
  const year = beijing.getUTCFullYear();
  const month = String(beijing.getUTCMonth() + 1).padStart(2, '0');
  const day = String(beijing.getUTCDate()).padStart(2, '0');
  const hour = String(beijing.getUTCHours()).padStart(2, '0');
  const minute = String(beijing.getUTCMinutes()).padStart(2, '0');
  const second = String(beijing.getUTCSeconds()).padStart(2, '0');
  return `${year}年${month}月${day}日 ${hour}:${minute}:${second}`;
}

type CellValue = string | number;

type SheetSpec = {
  name: string;
  rows: CellValue[][];
  columnCount: number;
  /** 0-based row index of the column header row */
  headerRowIndex: number;
  /** 金额 / 用量 / 占比等列（0-based），表头与数据均右对齐 */
  rightAlignCols?: number[];
  /** 额外合并区，如底栏标签 A6:D6 */
  extraMerges?: string[];
  /** 整列居中（如序号） */
  centerCols?: number[];
  /** 指定行区间内某列居中（用于底栏合并标签） */
  centeredLabelCols?: Array<{ col: number; fromRow: number; toRow: number }>;
};

const FONT_BODY: Partial<ExcelJS.Font> = { name: '宋体', size: 11 };
const FONT_TITLE: Partial<ExcelJS.Font> = { name: '宋体', size: 20 };
const FONT_HEADER: Partial<ExcelJS.Font> = {
  name: '微软雅黑',
  size: 11,
  bold: true,
  color: { argb: 'FFFFFFFF' },
};
const FILL_HEADER: ExcelJS.Fill = {
  type: 'pattern',
  pattern: 'solid',
  fgColor: { argb: `FF${HEADER_FILL_RGB}` },
};

function writeBufferedSheet(
  workbook: ExcelJS.stream.xlsx.WorkbookWriter,
  spec: SheetSpec,
): void {
  const worksheet = workbook.addWorksheet(spec.name);
  worksheet.columns = Array.from({ length: spec.columnCount }, (_, colIndex) => ({
    width: autoColWidth(spec.rows, colIndex, spec.headerRowIndex),
  }));
  const rows: ExcelJS.Row[] = [];
  spec.rows.forEach((values, rowIndex) => {
    const row = addStyledRow(worksheet, spec, values, rowIndex, spec.columnCount);
    if (rowIndex === 0) {
      row.height = 30;
    }
    rows.push(row);
  });
  worksheet.mergeCells(`A1:${cellRef(spec.columnCount - 1, 0)}`);
  for (const ref of spec.extraMerges ?? []) {
    worksheet.mergeCells(ref);
  }
  for (const row of rows) {
    row.commit();
  }
  worksheet.commit();
}

function addStyledRow(
  worksheet: ExcelJS.Worksheet,
  spec: Pick<SheetSpec, 'headerRowIndex' | 'rightAlignCols' | 'centerCols' | 'centeredLabelCols' | 'extraMerges'>,
  values: CellValue[],
  rowIndex: number,
  columnCount: number,
): ExcelJS.Row {
  const row = worksheet.addRow(Array.from({ length: columnCount }, () => null));
  for (let colIndex = 0; colIndex < columnCount; colIndex += 1) {
    if (isCoveredByMerge(spec, rowIndex, colIndex)) continue;
    row.getCell(colIndex + 1).value = toExcelValue(values[colIndex] ?? '');
  }
  styleStreamRow(row, spec, values, rowIndex, columnCount);
  return row;
}

function styleStreamRow(
  row: ExcelJS.Row,
  spec: Pick<SheetSpec, 'headerRowIndex' | 'rightAlignCols' | 'centerCols' | 'centeredLabelCols' | 'extraMerges'>,
  values: CellValue[],
  rowIndex: number,
  columnCount: number,
): void {
  const rightAlignCols = new Set(spec.rightAlignCols ?? []);
  const centerCols = new Set(spec.centerCols ?? []);
  for (let colIndex = 0; colIndex < columnCount; colIndex += 1) {
    if (isCoveredByMerge(spec, rowIndex, colIndex)) continue;
    const cell = row.getCell(colIndex + 1);
    const value = values[colIndex] ?? '';
    const numeric = isNumericCellValue(value);
    const center = centerCols.has(colIndex) || isCenteredLabel(spec, rowIndex, colIndex);
    const right = !center && (rightAlignCols.has(colIndex) || (rowIndex > spec.headerRowIndex && numeric));
    if (rowIndex === 0) {
      cell.font = FONT_TITLE;
      cell.alignment = { horizontal: 'center', vertical: 'middle' };
      continue;
    }
    if (rowIndex === spec.headerRowIndex) {
      cell.font = FONT_HEADER;
      cell.fill = FILL_HEADER;
      cell.alignment = {
        horizontal: right ? 'right' : 'center',
        vertical: 'middle',
      };
      continue;
    }
    cell.font = FONT_BODY;
    cell.alignment = {
      horizontal: center ? 'center' : right ? 'right' : 'left',
      vertical: 'middle',
    };
    if (
      numeric
      && typeof cell.value === 'number'
      && typeof value === 'string'
      && /^-?\d+\.\d{4}$/.test(value.trim())
    ) {
      cell.numFmt = '0.0000';
    }
  }
}

function toExcelValue(value: CellValue): string | number {
  if (typeof value === 'number' && Number.isFinite(value)) {
    return Object.is(value, -0) ? 0 : value;
  }
  if (typeof value === 'string' && isNumericCellValue(value)) {
    const trimmed = value.trim();
    if (/^-?\d+$/.test(trimmed)) {
      return Number(trimmed);
    }
    const parsed = Number(trimmed);
    return Number.isFinite(parsed) ? parsed : sanitizeExcelText(trimmed);
  }
  return typeof value === 'string' ? sanitizeExcelText(value) : (value ?? '');
}

function sanitizeExcelText(value: string): string {
  return value.replace(/[\u0000-\u0008\u000B\u000C\u000E-\u001F]/g, '');
}

/** 合并区里非左上角不要写值/样式，否则 Excel 会提示修复。 */
function isCoveredByMerge(
  spec: Pick<SheetSpec, 'extraMerges'>,
  rowIndex: number,
  colIndex: number,
): boolean {
  if (rowIndex === 0 && colIndex > 0) return true;
  for (const ref of spec.extraMerges ?? []) {
    const merge = parseMergeRef(ref);
    if (
      merge
      && merge.rowIndex === rowIndex
      && colIndex >= merge.fromCol
      && colIndex <= merge.toCol
      && colIndex !== merge.fromCol
    ) {
      return true;
    }
  }
  return false;
}

function isCenteredLabel(
  sheet: Pick<SheetSpec, 'centeredLabelCols'>,
  rowIndex: number,
  colIndex: number,
): boolean {
  return (sheet.centeredLabelCols ?? []).some((range) =>
    range.col === colIndex
    && rowIndex >= range.fromRow
    && rowIndex <= range.toRow);
}

function isNumericCellValue(value: CellValue): boolean {
  if (typeof value === 'number') return Number.isFinite(value);
  if (typeof value !== 'string' || value.trim() === '') return false;
  return /^-?(?:\d+\.?\d*|\.\d+)(?:[eE][+-]?\d+)?$/.test(value.trim());
}

function autoColWidth(rows: CellValue[][], colIndex: number, headerRowIndex: number): number {
  let max = 8;
  for (let rowIndex = headerRowIndex; rowIndex < rows.length; rowIndex += 1) {
    const value = rows[rowIndex]?.[colIndex] ?? '';
    max = Math.max(max, displayWidth(String(value)));
  }
  return Math.min(48, Math.max(10, max + 2));
}

function displayWidth(value: string): number {
  let width = 0;
  for (const ch of value) {
    width += ch.charCodeAt(0) > 255 ? 2 : 1;
  }
  return width;
}

function parseMergeRef(ref: string): { rowIndex: number; fromCol: number; toCol: number } | null {
  const match = /^([A-Z]+)(\d+):([A-Z]+)(\d+)$/.exec(ref);
  if (!match) return null;
  const fromRow = Number(match[2]);
  const toRow = Number(match[4]);
  if (fromRow !== toRow) return null;
  return {
    rowIndex: fromRow - 1,
    fromCol: colLettersToIndex(match[1]),
    toCol: colLettersToIndex(match[3]),
  };
}

function colLettersToIndex(letters: string): number {
  let index = 0;
  for (const ch of letters) {
    index = index * 26 + (ch.charCodeAt(0) - 64);
  }
  return index - 1;
}

function cellRef(col: number, row: number): string {
  let n = col + 1;
  let label = '';
  while (n > 0) {
    const rem = (n - 1) % 26;
    label = String.fromCharCode(65 + rem) + label;
    n = Math.floor((n - 1) / 26);
  }
  return `${label}${row + 1}`;
}

function escapeXml(value: string): string {
  return value
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;');
}
