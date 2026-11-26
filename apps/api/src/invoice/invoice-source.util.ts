import {
  InvoiceApplicationStatus,
  InvoiceLineDescription,
  OrderStatus,
  Prisma,
  ProductBillingMode,
} from '@prisma/client';

export const INVOICE_OCCUPYING_STATUSES: InvoiceApplicationStatus[] = [
  'PENDING_REVIEW',
  'APPROVED_ISSUING',
  'ISSUED',
];

export const INVOICEABLE_ORDER_STATUSES: OrderStatus[] = [
  'PAID',
  'FULFILLING',
  'COMPLETED',
];

export const INVOICEABLE_MIN_AGE_MS = 24 * 60 * 60 * 1000;

export const invoiceSourceOrderSelect = {
  id: true,
  orderType: true,
  amountCents: true,
  bonusCents: true,
  currency: true,
  status: true,
  refundedAt: true,
  paidAt: true,
  createdAt: true,
  productId: true,
  product: { select: { name: true, billingMode: true } },
  plan: {
    select: {
      name: true,
      product: { select: { name: true, billingMode: true } },
    },
  },
  boosterPack: { select: { name: true } },
  bundleSku: { select: { name: true } },
  items: {
    select: {
      amountCents: true,
      currency: true,
      productId: true,
      planId: true,
      boosterPackId: true,
      name: true,
      product: { select: { name: true, billingMode: true } },
      plan: {
        select: {
          name: true,
          product: { select: { name: true, billingMode: true } },
        },
      },
      boosterPack: {
        select: {
          name: true,
          product: { select: { name: true, billingMode: true } },
        },
      },
    },
  },
} satisfies Prisma.OrderSelect;

export type InvoiceSourceOrder = Prisma.OrderGetPayload<{
  select: typeof invoiceSourceOrderSelect;
}>;

export type InvoiceSourceOrderLike = Pick<
  InvoiceSourceOrder,
  'id' | 'amountCents' | 'status' | 'refundedAt' | 'paidAt'
> & Partial<Omit<InvoiceSourceOrder, 'id' | 'amountCents' | 'status' | 'refundedAt' | 'paidAt'>>;

interface BillingModeHolder {
  billingMode?: ProductBillingMode | null;
}

interface ProductNameHolder extends BillingModeHolder {
  name?: string | null;
}

interface InvoiceSourceOrderItemLike {
  amountCents?: number | null;
  name?: string | null;
  product?: ProductNameHolder | null;
  plan?: {
    name?: string | null;
    product?: ProductNameHolder | null;
  } | null;
  boosterPack?: {
    name?: string | null;
    product?: ProductNameHolder | null;
  } | null;
}

export function isRechargeInvoiceSource(order: InvoiceSourceOrderLike): boolean {
  return !order.orderType || order.orderType === 'RECHARGE';
}

export function invoiceableOrderBaseCents(order: InvoiceSourceOrderLike): number {
  if (isRechargeInvoiceSource(order)) return 0;
  if (isWholeOrderCodingPlanInvoiceSource(order)) return Math.max(0, order.amountCents);

  const codingItems = codingPlanInvoiceSourceItems(order);
  if (codingItems.length > 0) {
    return codingItems
      .reduce((sum, item) => sum + Math.max(0, item.amountCents ?? 0), 0);
  }
  return Math.max(0, order.amountCents);
}

export function invoiceLineDescriptionForOrder(
  order: InvoiceSourceOrderLike,
): InvoiceLineDescription {
  return isCodingPlanInvoiceSource(order) ? 'TOKEN_PLAN' : 'RAYTONE_API';
}

export function invoiceLineDescriptionForWholeOrder(
  order: InvoiceSourceOrderLike,
): InvoiceLineDescription {
  if (isWholeOrderCodingPlanInvoiceSource(order)) return 'TOKEN_PLAN';

  const items = order.items ?? [];
  if (items.length > 0 && items.every(isCodingPlanInvoiceSourceItem)) {
    return 'TOKEN_PLAN';
  }
  return 'RAYTONE_API';
}

export function invoiceProductNameForOrder(order: InvoiceSourceOrderLike): string | null {
  if (!isWholeOrderCodingPlanInvoiceSource(order)) {
    const codingItemNames = codingPlanInvoiceSourceItems(order)
      .map((item) => invoiceProductNameForItem(item))
      .filter((name): name is string => Boolean(name));
    if (codingItemNames.length === 1) return codingItemNames[0];
    if (codingItemNames.length > 1) return 'TokenPlan 组合套餐';
  }

  return invoiceProductNameForWholeOrder(order);
}

export function invoiceProductNameForWholeOrder(order: InvoiceSourceOrderLike): string | null {
  if (order.bundleSku?.name) return order.bundleSku.name;
  if (order.product?.name) return order.product.name;
  if (order.plan?.name) return order.plan.name;
  if (order.boosterPack?.name) return order.boosterPack.name;

  const items = order.items ?? [];
  if (items.length === 1) {
    return items[0]?.name
      ?? items[0]?.product?.name
      ?? items[0]?.plan?.name
      ?? null;
  }
  if (items.length > 1) return '组合套餐';
  return null;
}

export function isCodingPlanInvoiceSource(order: InvoiceSourceOrderLike): boolean {
  return isWholeOrderCodingPlanInvoiceSource(order)
    || codingPlanInvoiceSourceItems(order).length > 0;
}

function isWholeOrderCodingPlanInvoiceSource(order: InvoiceSourceOrderLike): boolean {
  return isCodingPlanProduct(order.product) || isCodingPlanProduct(order.plan?.product);
}

function codingPlanInvoiceSourceItems(
  order: InvoiceSourceOrderLike,
): InvoiceSourceOrderItemLike[] {
  return (order.items ?? []).filter(isCodingPlanInvoiceSourceItem);
}

function isCodingPlanInvoiceSourceItem(item: InvoiceSourceOrderItemLike): boolean {
  return isCodingPlanProduct(item.product)
    || isCodingPlanProduct(item.plan?.product)
    || isCodingPlanProduct(item.boosterPack?.product);
}

function invoiceProductNameForItem(item: InvoiceSourceOrderItemLike): string | null {
  return item.name
    ?? item.product?.name
    ?? item.plan?.name
    ?? item.plan?.product?.name
    ?? item.boosterPack?.name
    ?? item.boosterPack?.product?.name
    ?? null;
}

function isCodingPlanProduct(product?: BillingModeHolder | null): boolean {
  return product?.billingMode === ProductBillingMode.CODING_PLAN;
}
