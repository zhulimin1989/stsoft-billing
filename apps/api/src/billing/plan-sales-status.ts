import {
  CodingPlanFulfillmentMode,
  OrderStatus,
  OrderType,
  Prisma,
  ProductBillingMode,
} from '@prisma/client';

export const PLAN_SALES_RESERVED_ORDER_STATUSES = [
  OrderStatus.PENDING,
  OrderStatus.PAID,
  OrderStatus.FULFILLING,
  OrderStatus.PARTIALLY_FULFILLED_REQUIRES_COMPENSATION,
  OrderStatus.COMPLETED,
] as const;

type PlanSalesStatusClient = Pick<Prisma.TransactionClient, 'order' | 'product'>;

export type PlanSalesStatusPlan = {
  id: string;
  productId?: string | null;
  salesLimit?: number | null;
};

export type PlanSalesStatus = {
  salesLimit: number;
  reservedSalesCount: number;
  remainingSales: number | null;
  soldOut: boolean;
};

export function defaultPlanSalesStatus(plan: PlanSalesStatusPlan): PlanSalesStatus {
  return {
    salesLimit: Math.max(0, plan.salesLimit ?? 0),
    reservedSalesCount: 0,
    remainingSales: null,
    soldOut: false,
  };
}

export async function loadProviderResalePlanSalesStatuses(
  db: PlanSalesStatusClient,
  plans: PlanSalesStatusPlan[],
): Promise<Map<string, PlanSalesStatus>> {
  const statuses = new Map<string, PlanSalesStatus>();
  for (const plan of plans) {
    statuses.set(plan.id, defaultPlanSalesStatus(plan));
  }
  if (plans.length === 0) return statuses;

  const productIds = [
    ...new Set(plans.map((plan) => plan.productId).filter((id): id is string => Boolean(id))),
  ];
  if (productIds.length === 0) return statuses;

  const products = await db.product.findMany({
    where: { id: { in: productIds } },
    select: { id: true, billingMode: true, codingPlanFulfillmentMode: true },
  });
  const providerResaleProductIds = new Set(
    products
      .filter((product) =>
        product.billingMode === ProductBillingMode.CODING_PLAN &&
        product.codingPlanFulfillmentMode === CodingPlanFulfillmentMode.provider_resale,
      )
      .map((product) => product.id),
  );
  const trackedPlans = plans.filter((plan) =>
    plan.productId &&
    providerResaleProductIds.has(plan.productId) &&
    (plan.salesLimit ?? 0) > 0,
  );
  if (trackedPlans.length === 0) return statuses;

  const rows = await db.order.groupBy({
    by: ['planId'],
    where: {
      planId: { in: trackedPlans.map((plan) => plan.id) },
      orderType: OrderType.SUBSCRIPTION,
      status: { in: [...PLAN_SALES_RESERVED_ORDER_STATUSES] },
    },
    _count: { _all: true },
  });
  const reservedByPlanId = new Map(
    rows
      .filter((row) => row.planId)
      .map((row) => [row.planId!, row._count._all]),
  );

  for (const plan of trackedPlans) {
    const salesLimit = Math.max(0, plan.salesLimit ?? 0);
    const reservedSalesCount = reservedByPlanId.get(plan.id) ?? 0;
    statuses.set(plan.id, {
      salesLimit,
      reservedSalesCount,
      remainingSales: Math.max(0, salesLimit - reservedSalesCount),
      soldOut: reservedSalesCount >= salesLimit,
    });
  }
  return statuses;
}
