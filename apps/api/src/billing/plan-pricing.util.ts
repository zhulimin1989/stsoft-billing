import type { BillingPeriod } from '@ruidong/shared';

/** 周期月数倍率：订阅整单总价 = 月均价 × multiplier。 */
export const PLAN_PERIOD_MULTIPLIER: Record<BillingPeriod, number> = {
  monthly: 1,
  quarterly: 3,
  yearly: 12,
};

type PlanPriceRow = {
  monthlyPrice?: number | null;
  quarterlyPrice?: number | null;
  yearlyPrice?: number | null;
};

/**
 * 套餐某周期的「月均价」（分）—— 下单与展示的**单一原价口径**（镜像 payment.service 价格选择策略，
 * 抽出供 /billing/plans/promotions 展示复用，避免展示与下单漂移）：
 *  1) 优先 plan_prices(currency) 对应周期价；
 *  2) 回落 Plan 顶层 monthly/quarterly/yearlyPrice，仅当 `currency === 'usd' || currency === platformCurrency`；
 *  3) 取不到返回 null（调用方按「无该币种价格」处理）。
 * 注：quarterly/yearly 字段语义是「月均价」，整单总价由调用方 × PLAN_PERIOD_MULTIPLIER。
 */
export function resolvePlanPeriodMonthlyEquivalentCents(
  period: BillingPeriod,
  planPrice: PlanPriceRow | null | undefined,
  plan: { monthlyPrice: number; quarterlyPrice: number; yearlyPrice: number },
  currency: string,
  platformCurrency: string,
): number | null {
  const fromPrices =
    period === 'yearly'
      ? planPrice?.yearlyPrice
      : period === 'quarterly'
        ? planPrice?.quarterlyPrice
        : planPrice?.monthlyPrice;
  let monthlyEquivalent: number | null = fromPrices ?? null;
  if (monthlyEquivalent == null && (currency === 'usd' || currency === platformCurrency)) {
    const legacy =
      period === 'yearly'
        ? plan.yearlyPrice
        : period === 'quarterly'
          ? plan.quarterlyPrice
          : plan.monthlyPrice;
    monthlyEquivalent = legacy ?? null;
  }
  return monthlyEquivalent;
}
