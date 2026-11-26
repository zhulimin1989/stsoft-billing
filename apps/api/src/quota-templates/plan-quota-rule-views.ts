/**
 * 套餐配额模板规则的「单一口径」工具：解析、合并去重、enforced（billing 执行）判定。
 *
 * 这是全链路唯一一份实现，两个消费方必须共用，禁止再各写一份（口径漂移=展示与执行不一致）：
 * - billing.service 的 /billing/plans 与 /billing/current-subscription（决定用户端展示什么）。
 * - rolling quota gate / BalanceGate 前置执行口径（决定哪些规则真正参与扣量前拦截）。
 *
 * 设计依据：me/plan-quota-display-from-template.md（codesphere-admin 仓）§4.2。
 */

import type { PlanQuotaRuleView } from '@ruidong/shared';

/** 配额模板 rules JSON 里单条规则（与 quota-templates.service 的 QuotaRule 对齐，读侧容错为可选）。 */
export interface PlanQuotaRuleSpec {
  windowType?: string;
  durationLabel?: string;
  durationSec?: number;
  metric?: string;
  limitValue?: number;
}

/** 对外（API 响应/策略生成）暴露的规则视图，wire 类型定义在 @ruidong/shared。 */
export type { PlanQuotaRuleView };

/** Plan.quotaRules 关联行（含模板）的最小读取形状。 */
export interface PlanQuotaRuleBinding {
  template: {
    rules: string;
    isActive: boolean;
    deletedAt: Date | null;
  } | null;
}

const VALID_METRICS = new Set([
  'REQUESTS',
  'INPUT_TOKENS',
  'OUTPUT_TOKENS',
  'TOTAL_TOKENS',
  'CREDITS',
]);
const VALID_WINDOW_TYPES = new Set(['ROLLING', 'FIXED_PERIOD', 'CUMULATIVE']);

function positiveInteger(value: unknown): number | undefined {
  if (typeof value !== 'number' || !Number.isFinite(value)) return undefined;
  const normalized = Math.floor(value);
  return normalized > 0 ? normalized : undefined;
}

/** 解析配额模板的 rules JSON（容错：坏数据返回空并回调告警，不抛错阻断调用方）。 */
export function parseQuotaRuleSpecs(
  rulesJson: string | null | undefined,
  onWarn?: (message: string) => void,
): PlanQuotaRuleSpec[] {
  if (!rulesJson) return [];
  try {
    const parsed = JSON.parse(rulesJson);
    if (Array.isArray(parsed)) return parsed as PlanQuotaRuleSpec[];
  } catch (err) {
    onWarn?.(`invalid quota template rules JSON: ${(err as Error).message}`);
  }
  return [];
}

/**
 * 规则是否「结构上」属于 billing 平台执行口径（quota-v2 §4.1）：
 * ROLLING + metric∈{REQUESTS, CREDITS} + 正整数上限 + 任意正窗口（5h/6h/7d…，billing 执行不挑窗口）。
 *
 * 与 v1 的差异：① 不再限定 6h(21600s)——任意 ROLLING 窗口都由 billing 侧 BalanceGate 执行；
 * ② CREDITS 纳入执行（积分维度），token 维度(INPUT/OUTPUT/TOTAL_TOKENS)退役（不执行/不展示，防 token 上限被推测）。
 *
 * 注意：这是「结构判定」，不含总开关。实际是否生效（展示+执行）由 gateEnabled 在 resolvePlanQuotaRuleViews
 * 与 A 前置处叠加（BILLING_ROLLING_QUOTA_GATE_ENABLED，§7 开关控执行+展示同退）。
 */
export function isQuotaRuleEnforced(rule: PlanQuotaRuleSpec): boolean {
  if (rule.windowType !== 'ROLLING') return false;
  if (rule.metric !== 'REQUESTS' && rule.metric !== 'CREDITS') return false;
  if (!positiveInteger(rule.limitValue)) return false;
  return positiveInteger(rule.durationSec) !== undefined;
}

/** durationSec → 人话标签兜底（模板里 durationLabel 缺失时用）。 */
function fallbackDurationLabel(sec: number): string {
  if (sec % 86400 === 0) return `${sec / 86400}d`;
  if (sec % 3600 === 0) return `${sec / 3600}h`;
  if (sec % 60 === 0) return `${sec / 60}m`;
  return `${sec}s`;
}

/**
 * 把套餐绑定的全部配额模板规则解析+合并为视图列表：
 * - 跳过 inactive/软删模板与坏 JSON（与 billing 展示/执行同口径）；
 * - 跳过 metric/windowType/limitValue/durationSec 非法的规则；
 * - 同 (metric, windowType, durationSec) 多条时取更严格（更小）的上限。
 */
export function resolvePlanQuotaRuleViews(
  bindings: PlanQuotaRuleBinding[],
  onWarn?: (message: string) => void,
  options?: { gateEnabled?: boolean },
): PlanQuotaRuleView[] {
  // 总开关（BILLING_ROLLING_QUOTA_GATE_ENABLED）：默认关——开关未开时一律 enforced=false，
  // 展示与执行同退（§7）。调用方（billing 展示 / A 前置）从 ConfigService 读取后传入。
  const gateEnabled = options?.gateEnabled ?? false;
  const byKey = new Map<string, PlanQuotaRuleView>();
  for (const binding of bindings) {
    const template = binding.template;
    if (!template || !template.isActive || template.deletedAt) continue;
    for (const rule of parseQuotaRuleSpecs(template.rules, onWarn)) {
      const metric = typeof rule.metric === 'string' ? rule.metric : '';
      const windowType = typeof rule.windowType === 'string' ? rule.windowType : '';
      if (!VALID_METRICS.has(metric) || !VALID_WINDOW_TYPES.has(windowType)) continue;
      // quota-v2 §3：token 维度(INPUT/OUTPUT/TOTAL_TOKENS)退役——不仅不执行，且**不出现在视图**，
      // 避免 token 上限值经 billing 读接口(/plans、current-subscription)的 JSON 泄露被推测。
      // 模板仍可存 token 规则（向后兼容/内部分析），但对外视图一律剔除。
      if (metric !== 'REQUESTS' && metric !== 'CREDITS') continue;
      const limitValue = positiveInteger(rule.limitValue);
      const durationSec = positiveInteger(rule.durationSec);
      if (!limitValue || !durationSec) continue;

      const view: PlanQuotaRuleView = {
        metric: metric as PlanQuotaRuleView['metric'],
        windowType: windowType as PlanQuotaRuleView['windowType'],
        durationSec,
        durationLabel:
          typeof rule.durationLabel === 'string' && rule.durationLabel.trim()
            ? rule.durationLabel.trim()
            : fallbackDurationLabel(durationSec),
        limitValue,
        enforced: gateEnabled && isQuotaRuleEnforced(rule),
      };
      const key = `${view.metric}:${view.windowType}:${view.durationSec}`;
      const existing = byKey.get(key);
      if (!existing || view.limitValue < existing.limitValue) {
        byKey.set(key, view);
      }
    }
  }
  return [...byKey.values()];
}

/**
 * 滚动配额总开关（quota-v2 §7）：BILLING_ROLLING_QUOTA_GATE_ENABLED，默认关。
 * 同控展示（resolvePlanQuotaRuleViews 的 enforced）与执行（A 前置），开关一处关则两侧同退。
 * 读 process.env（与 NestJS ConfigService 同源），便于 billing/usage 两侧统一口径与测试覆盖。
 */
// 运行时 admin 开关来源（SystemConfig，DB 支撑）。由 RollingQuotaGateConfigService 定时/即时刷新到此模块级变量，
// 使 rollingQuotaGateEnabled() 保持同步可调（被 A/B/scheduler/展示多处同步引用）。null=未配置(继承 env)。
let runtimeGateOverride: boolean | null = null;

/** 由 RollingQuotaGateConfigService 设置：true/false=admin 显式开/关；null=未配置(继承 env)。 */
export function setRollingQuotaGateOverride(value: boolean | null): void {
  runtimeGateOverride = value;
}

/** 仅供展示/诊断：返回当前 admin 运行时覆盖值（null=未配置）。 */
export function rollingQuotaGateOverride(): boolean | null {
  return runtimeGateOverride;
}

/** env 维度是否强制开启（与运行时 override 解耦，供 GET 状态/诊断）。 */
export function rollingQuotaGateEnvForced(): boolean {
  const raw = process.env.BILLING_ROLLING_QUOTA_GATE_ENABLED;
  if (!raw) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/**
 * 滚动配额 gate 总开关 = env 强制开 || admin 运行时开（SystemConfig）。
 * env=true → 强制开（admin 关不掉，保护 prod 刻意 env 开）；env 未设 → 由 admin 全权控制（dev 可开可关）。
 */
export function rollingQuotaGateEnabled(): boolean {
  return rollingQuotaGateEnvForced() || runtimeGateOverride === true;
}

// ── R6 自营积分负额扣款开关（v5）──────────────────────────────────────────────
// 与 rolling gate 同构：env 强制开 || admin 运行时开；默认 false。由
// SelfopNegativeDeductConfigService 定时/即时把 SystemConfig 刷新到此模块级变量，
// 使 selfopNegativeDeductEnabled() 在扣减热路径保持同步可调（多副本 ~30s 收敛）。
// 注意：这是**积分侧独立灰度**开关；负额结算最终还需既有 allowTerminalSettlement
// （trusted 已交付 && env BILLING_GATEWAY_USAGE_ALLOW_NEGATIVE_BALANCE）同时成立。
let selfopNegativeDeductOverride: boolean | null = null;

/** 由 SelfopNegativeDeductConfigService 设置：true/false=admin 显式开/关；null=未配置(继承 env)。 */
export function setSelfopNegativeDeductOverride(value: boolean | null): void {
  selfopNegativeDeductOverride = value;
}

/** 仅供展示/诊断：返回当前 admin 运行时覆盖值（null=未配置）。 */
export function selfopNegativeDeductOverrideValue(): boolean | null {
  return selfopNegativeDeductOverride;
}

/** env 维度是否强制开启（与运行时 override 解耦，供状态/诊断）。 */
export function selfopNegativeDeductEnvForced(): boolean {
  const raw = process.env.BILLING_SELFOP_NEGATIVE_DEDUCT_ENABLED;
  if (!raw) return false;
  return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
}

/** 自营积分负额扣款总开关 = env 强制开 || admin 运行时开（SystemConfig）；默认 false。 */
export function selfopNegativeDeductEnabled(): boolean {
  return selfopNegativeDeductEnvForced() || selfopNegativeDeductOverride === true;
}

/** Plan.features JSON 数组里是否含 provider_resale 标记（转售套餐）。 */
export function isProviderResalePlan(features: string | null | undefined): boolean {
  if (!features) return false;
  let parsed: unknown;
  try {
    parsed = JSON.parse(features);
  } catch {
    return false;
  }
  if (!Array.isArray(parsed)) return false;
  return parsed.some(
    (marker) => typeof marker === 'string' && /^provider_resale:/i.test(marker),
  );
}

// ----------------------------------------------------------------------
// 配额一致性校验（me/quota-window-monthly-consistency.md，R1 配置悖论）
// ----------------------------------------------------------------------

/** 一条配额一致性违规。reason: 窗口预算超月度 / 短窗预算高于长窗（非单调）。 */
export interface QuotaConsistencyViolation {
  durationSec: number;
  durationLabel: string;
  limitValue: number;
  reason: 'exceeds_monthly' | 'non_monotonic';
  /** non_monotonic 时填：被比较的更长窗口标签与上限。 */
  comparedDurationLabel?: string;
  comparedLimitValue?: number;
}

/**
 * 自营套餐配额一致性校验（纯函数，不抛错）。仅作用于**合并后有效视图**里的
 * `ROLLING + CREDITS` 规则（由 resolvePlanQuotaRuleViews 产出，已按同窗取最严合并）：
 *  ① 月度封顶：每个 CREDITS 滚动窗口 limitValue ≤ monthlyCredits；
 *  ② 单调：按窗口时长升序，短窗 limitValue ≤ 长窗 limitValue（5h ≤ 7d ≤ 月度）。
 * **monthlyCredits ≤ 0 直接返回空**：无正向积分池（转售/PAYG/无积分/通用套餐 monthly=0）不在本约束内，
 * 单调性也一并跳过——避免误伤非自营套餐（与审计脚本「排除 monthly<=0」同口径）。
 * REQUESTS / token / FIXED_PERIOD / CUMULATIVE 不在此约束（设计稿 §B1 P2）。
 * 返回违规列表；调用方据此抛 BadRequestException（保持本工具纯净、无 Nest 依赖）。
 */
export function findCreditWindowConsistencyViolations(
  monthlyCredits: number,
  views: PlanQuotaRuleView[],
): QuotaConsistencyViolation[] {
  if (!Number.isFinite(monthlyCredits) || monthlyCredits <= 0) return [];
  const credits = creditRollingViewsSorted(views);
  const violations: QuotaConsistencyViolation[] = [];
  // ① 月度封顶
  for (const v of credits) {
    if (v.limitValue > monthlyCredits) {
      violations.push({
        durationSec: v.durationSec,
        durationLabel: v.durationLabel,
        limitValue: v.limitValue,
        reason: 'exceeds_monthly',
      });
    }
  }
  // ② 单调（与月度无关，复用下方独立函数）
  violations.push(...findCreditMonotonicViolations(views));
  return violations;
}

/** CREDITS 滚动视图按窗口时长升序（月度无关的内部排序工具）。 */
function creditRollingViewsSorted(views: PlanQuotaRuleView[]): PlanQuotaRuleView[] {
  return views
    .filter((v) => v.windowType === 'ROLLING' && v.metric === 'CREDITS')
    .sort((a, b) => a.durationSec - b.durationSec);
}

/**
 * 仅校验「短窗 limitValue ≤ 长窗 limitValue」单调性（CREDITS 滚动），**与月度无关**。
 * 用于模板内部一致性（同一模板内 5h ≤ 7d 恒成立，无需 plan/月度上下文即可早拦）。
 * 纯函数，相邻比较即可保证全序非降。
 */
export function findCreditMonotonicViolations(
  views: PlanQuotaRuleView[],
): QuotaConsistencyViolation[] {
  const credits = creditRollingViewsSorted(views);
  const violations: QuotaConsistencyViolation[] = [];
  for (let i = 1; i < credits.length; i++) {
    const shorter = credits[i - 1];
    const longer = credits[i];
    if (shorter.limitValue > longer.limitValue) {
      violations.push({
        durationSec: shorter.durationSec,
        durationLabel: shorter.durationLabel,
        limitValue: shorter.limitValue,
        reason: 'non_monotonic',
        comparedDurationLabel: longer.durationLabel,
        comparedLimitValue: longer.limitValue,
      });
    }
  }
  return violations;
}

/** 把违规列表格式化为面向运营的中文错误信息。 */
export function formatCreditWindowConsistencyError(
  violations: QuotaConsistencyViolation[],
  monthlyCredits: number,
  planLabel?: string,
): string {
  const prefix = planLabel ? `套餐「${planLabel}」` : '套餐';
  const parts = violations.map((v) =>
    v.reason === 'exceeds_monthly'
      ? `${v.durationLabel} 窗口积分上限 ${v.limitValue} 超过月度积分 ${monthlyCredits}`
      : `${v.durationLabel} 窗口积分上限 ${v.limitValue} 高于更长窗口 ${v.comparedDurationLabel}(${v.comparedLimitValue})`,
  );
  return `${prefix}配额配置不一致：${parts.join('；')}。CREDITS 滚动窗口预算必须 ≤ 月度积分，且短窗 ≤ 长窗。`;
}
