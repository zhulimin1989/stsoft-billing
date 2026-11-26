import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { GATEWAY_EVENT_TERMINAL_STATUSES } from './gateway-event-status';

/**
 * 模型下架前置预检：该模型还有没有**尚未结算**的 Gateway 计费事件。
 *
 * 为什么需要（2026-09-07 国内 prod 事故）：当天结算滞后已恶化到 146 分钟，运营在
 * 13:31:52 把 deepseek-v4-flash 的 is_active 置为 false 时，该客户有 9,622 笔请求还堵在
 * Kafka 里没结算（occurred_at 11:02–13:31:24，最后一笔比下架早 28 秒）。这批事件随后被
 * 消费时报不出价 ⇒ QUARANTINED(settlement_anchor_missing) ⇒ 每笔挂一行
 * settlement_policy_review 限制行 ⇒ 客户 Key 被 402 封了约 4 小时。
 *
 * 20260907000100 的取价窗口已经让「下架不再打穿存量」，这个闸门是第二道：
 * 存量没清干净就不该下架 —— 取价窗口靠 ends_at 兜底，而运营手上可能有别的下架姿势
 * （物理删除就没有窗口可言），且「下架时还有几千笔在飞」本身就是该看见的事实。
 *
 * 判定用**终态集合的补集**（`status NOT IN terminal`）而不是列举非终态：
 * 将来新增任何状态都默认算"未结算"，宁可拦错也不要漏拦。
 */

export interface UnsettledGatewayEventFact {
  modelName: string;
  count: number;
  earliestOccurredAt: Date | null;
}

/** 只读：返回每个模型的未结算事件事实，空数组表示都清干净了。 */
export async function findUnsettledGatewayEvents(
  db: Prisma.TransactionClient,
  modelNames: string[],
): Promise<UnsettledGatewayEventFact[]> {
  const names = Array.from(new Set(modelNames.map((name) => name.trim()).filter(Boolean)));
  if (names.length === 0) return [];
  const rows = await db.gatewayBillingEvent.groupBy({
    by: ['modelName'],
    where: {
      modelName: { in: names },
      status: { notIn: Array.from(GATEWAY_EVENT_TERMINAL_STATUSES) },
    },
    _count: { _all: true },
    _min: { occurredAt: true },
  });
  return rows
    .map((row) => ({
      modelName: row.modelName ?? '',
      count: row._count._all,
      earliestOccurredAt: row._min.occurredAt ?? null,
    }))
    .filter((fact) => fact.count > 0)
    .sort((left, right) => right.count - left.count || left.modelName.localeCompare(right.modelName));
}

/**
 * 有未结算事件就拒绝下架/删除。抛 ConflictException（状态冲突型闸门，与
 * quota-templates / setPlanActive 的既有惯例一致），文案带模型名、笔数和最早时刻，
 * 让运营知道该去哪儿对账。
 *
 * 刻意不提供 force 绕过 —— admin 侧没有 force 惯例，且"绕过"正是这次事故的形状。
 */
export async function assertNoUnsettledGatewayEvents(
  db: Prisma.TransactionClient,
  modelNames: string[],
): Promise<void> {
  const facts = await findUnsettledGatewayEvents(db, modelNames);
  if (facts.length === 0) return;
  const detail = facts
    .map((fact) => {
      const earliest = fact.earliestOccurredAt
        ? `，最早 ${fact.earliestOccurredAt.toISOString()}`
        : '';
      return `模型「${fact.modelName}」仍有 ${fact.count} 笔未结算 Gateway 计费事件${earliest}`;
    })
    .join('；');
  throw new ConflictException(`${detail}。下架前请先完成对账，否则这些事件将取不到定价并转人工隔离`);
}
