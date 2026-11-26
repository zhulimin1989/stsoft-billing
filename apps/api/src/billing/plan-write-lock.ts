import { Prisma, ProductBillingMode } from '@prisma/client';
import { isProviderResalePlan } from '../quota-templates/plan-quota-rule-views';

/**
 * 「自营 CodingPlan」统一判定口径（finding #13 / codex：防转售误伤）。
 * 三重排除转售：billingMode=CODING_PLAN 且 产品级 codingPlanFulfillmentMode≠provider_resale
 * 且 plan 级 features 非转售（转售 plan 建时 features='[]'，仅靠 features 会漏判）。
 * 所有激活/绑定守卫必须用同一口径，否则不变量有缝隙或误伤转售。
 */
export function isSelfOpCodingPlan(
  billingMode: ProductBillingMode | null | undefined,
  codingPlanFulfillmentMode: string | null | undefined,
  features: string | null | undefined,
): boolean {
  return (
    billingMode === ProductBillingMode.CODING_PLAN &&
    codingPlanFulfillmentMode !== 'provider_resale' &&
    !isProviderResalePlan(features)
  );
}

/**
 * 自营 CodingPlan 套餐「激活 ⇒ 有绑定」不变量的并发守卫（finding #13 / codex 评审）。
 *
 * `setPlanActive` 与决定不变量的绑定写（模型授权 batchUpdateModelAccess / 配额规则 replacePlanRules）
 * 对**同一 planId** 取此
 * per-plan 事务级 advisory 锁，从而串行化，杜绝跨事务竞态：
 *   replace(planId, []) 在 plan 仍 inactive 时开始 → setPlanActive 读到旧绑定校验通过并翻 active
 *   → replace 随后提交删掉最后一个绑定 → active 却无绑定。
 *
 * `pg_advisory_xact_lock` 为事务级：随事务提交/回滚自动释放，无需手动解锁。
 * 用固定命名空间 + `hashtext(planId)` 组成 (int4, int4) 锁键，稳定且与其它 advisory 锁不碰撞。
 */
const PLAN_WRITE_LOCK_NAMESPACE = 0x52544350; // 'RTCP'，固定命名空间（< int4 max）

export async function acquirePlanWriteLock(
  tx: Prisma.TransactionClient,
  planId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${PLAN_WRITE_LOCK_NAMESPACE}::int, hashtext(${planId})::int)`;
}

// 配额模板写锁命名空间（独立于 plan，避免 hashtext 键与 plan 锁碰撞）。
const TEMPLATE_WRITE_LOCK_NAMESPACE = 0x51544d50; // 'QTMP'

/**
 * 配额模板写锁（finding #13 / codex R2 P1-4）：模板 disable/softDelete 与 replacePlanRules 绑定
 * 对**同一 templateId** 取此锁串行化，杜绝「disable 查引用时无引用→并发 replace 绑定 active 自营 plan
 * →disable 再置 inactive→active plan 剩指向 inactive 模板的规则(有效配额=0)」的竞态。
 * 全局锁序固定为**先模板(templateId 升序)后 plan**，两条路径一致，无死锁环。
 */
export async function acquireTemplateWriteLock(
  tx: Prisma.TransactionClient,
  templateId: string,
): Promise<void> {
  await tx.$executeRaw`SELECT pg_advisory_xact_lock(${TEMPLATE_WRITE_LOCK_NAMESPACE}::int, hashtext(${templateId})::int)`;
}
