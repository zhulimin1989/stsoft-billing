/**
 * 配额一致性审计（只读，me/quota-window-monthly-consistency.md §存量迁移 阶段①）。
 *
 * 扫描所有自营 CodingPlan 套餐，列出 CREDITS 滚动窗口预算 > 月度积分、或窗口非单调
 * （短窗 > 长窗）的违规组合，供人工修正后再开写入硬拒。
 *
 * 只报告、不修改任何数据。
 *
 * 过滤（codex 评审）：排除转售(provider_resale)/ 非 CODING_PLAN / monthlyCredits<=0，
 * 避免对转售/PAYG/无积分套餐误报。
 *
 * 运行：ts-node scripts/audit-quota-window-monthly-consistency.ts
 */
import { PrismaClient, ProductBillingMode } from '@prisma/client';
import {
  resolvePlanQuotaRuleViews,
  findCreditWindowConsistencyViolations,
  isProviderResalePlan,
  type PlanQuotaRuleBinding,
} from '../src/quota-templates/plan-quota-rule-views';

const prisma = new PrismaClient();

async function main() {
  const plans = await prisma.plan.findMany({
    where: {
      deletedAt: null,
      product: { billingMode: ProductBillingMode.CODING_PLAN },
    },
    select: {
      id: true,
      name: true,
      monthlyCredits: true,
      features: true,
      quotaRules: {
        where: { isActive: true },
        select: { template: { select: { rules: true, isActive: true, deletedAt: true } } },
      },
    },
  });

  let scanned = 0;
  let violating = 0;
  for (const plan of plans) {
    // 排除转售（上游决定模型/额度，不受本地积分约束）与无正向积分池套餐。
    if (isProviderResalePlan(plan.features)) continue;
    if (!(plan.monthlyCredits > 0)) continue;
    if (plan.quotaRules.length === 0) continue;
    scanned += 1;

    const bindings: PlanQuotaRuleBinding[] = plan.quotaRules.map((r) => ({
      template: r.template,
    }));
    const views = resolvePlanQuotaRuleViews(bindings, (m) =>
      console.warn(`[warn] plan=${plan.id} ${m}`),
    );
    const violations = findCreditWindowConsistencyViolations(plan.monthlyCredits, views);
    if (violations.length === 0) continue;

    violating += 1;
    console.log(
      `\n[VIOLATION] plan=${plan.id} name="${plan.name}" monthlyCredits=${plan.monthlyCredits}`,
    );
    for (const v of violations) {
      if (v.reason === 'exceeds_monthly') {
        console.log(
          `  - ${v.durationLabel} 窗口积分上限 ${v.limitValue} > 月度积分 ${plan.monthlyCredits}`,
        );
      } else {
        console.log(
          `  - ${v.durationLabel} 窗口积分上限 ${v.limitValue} > 更长窗口 ${v.comparedDurationLabel}(${v.comparedLimitValue})（非单调）`,
        );
      }
    }
  }

  console.log(
    `\n审计完成：扫描自营套餐 ${scanned} 个（已排除转售/非CODING_PLAN/monthly<=0/无规则），违规 ${violating} 个。`,
  );
  if (violating > 0) {
    console.log(
      '请人工修正（调小窗口或调大月度）后再开写入硬拒；开硬拒前刷新 cpq:rules 缓存并触发 key balance resync。',
    );
  }
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => prisma.$disconnect());
