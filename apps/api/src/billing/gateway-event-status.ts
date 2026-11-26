/**
 * `gateway_billing_events.status` 的终态集合 —— 到了这些状态的事件不会再取价、再动钱。
 *
 * 单独成文件（而不是留在 gateway-request-event-billing.service.ts 里）是为了让
 * 「模型下架前置闸门」（model-retirement-preflight.ts）能复用同一份定义：
 * 那个闸门要被 admin.repository / channel.admin.service 调用，若从结算 service
 * 里 import 常量会把整条结算依赖链拖进 admin 模块并成环。
 *
 * 注意 `DEBT_OPEN` 算终态：欠款已记账、主体已确定、价已取过，只是钱没收回来。
 */
export const GATEWAY_EVENT_TERMINAL_STATUSES = new Set<string>([
  'DEDUCTED',
  'SKIPPED',
  'FAILED',
  'ABSORBED',
  'DEBT_OPEN',
]);
