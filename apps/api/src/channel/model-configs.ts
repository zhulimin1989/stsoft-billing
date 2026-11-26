/**
 * Channel.modelConfigs 仅保留 per-channel 特有字段。
 *
 * 设计原则：thinking_budget / reasoning_effort / maxOutputTokens 这些
 * 产品侧展示/客户端默认值放在 ModelPricing（模型库层），不进入 publisher runtime。
 * channel 层只负责：
 *   - enabled：在某个 channel 上软下线某个模型
 *   - upstreamModelId：上游真实名别名映射
 *   - routingPriority：该 channel 针对此模型的路由优先级（数字越小越优先）
 *
 * 这样运营心智清晰：要改产品侧默认展示去模型库；要在某 channel 上不开某模型来 channel。
 */

import { BadRequestException } from '@nestjs/common';
import { TOKEN_COUNT_STRATEGIES } from '@raytone-lab/publisher-contracts';
import type { TokenCountStrategy } from '@raytone-lab/publisher-contracts';

const SUPPORTED_TOKEN_COUNT_STRATEGIES = new Set<string>(TOKEN_COUNT_STRATEGIES);

export interface PerModelConfig {
  /** 该 channel 上此模型是否启用（false = 软下线，不动 models 白名单数组） */
  enabled?: boolean;
  /** 上游真实模型名（admin 模型名 → upstream model id 别名映射） */
  upstreamModelId?: string;
  /** 模型级路由优先级。未设置时回退到 channel.priority；数字越小越优先。 */
  routingPriority?: number;
  /** Anthropic beta header value, e.g. extended-cache-ttl-2025-04-11. */
  anthropicBeta?: string;
  /** Per-route token count policy override. */
  tokenCountStrategy?: TokenCountStrategy;
  /** Route-level publisher request parameter policy. */
  requestParamPolicy?: Record<string, Record<string, unknown>>;
}

export type ModelConfigsMap = Record<string, PerModelConfig>;

function isPlainObject(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function policyParamName(policy: Record<string, unknown>): string | null {
  const raw = policy.param ?? policy.name ?? policy.field;
  return typeof raw === 'string' && raw.trim() ? raw.trim() : null;
}

function normalizeRequestParamPolicy(raw: unknown): Record<string, Record<string, unknown>> | null {
  if (raw === undefined || raw === null) return null;
  const out: Record<string, Record<string, unknown>> = {};
  const put = (param: string, policy: Record<string, unknown>) => {
    const normalizedParam = param.trim();
    if (!normalizedParam) return;
    const { param: _param, name: _name, field: _field, ...rest } = policy;
    out[normalizedParam] = rest;
  };

  if (Array.isArray(raw)) {
    for (const item of raw) {
      if (!isPlainObject(item)) return null;
      const param = policyParamName(item);
      if (!param) return null;
      put(param, item);
    }
    return Object.keys(out).length ? out : null;
  }

  if (!isPlainObject(raw)) return null;

  const singleParam = policyParamName(raw);
  if (singleParam && ('category' in raw || 'upstream_behavior' in raw || 'on_equal' in raw || 'on_mismatch' in raw)) {
    put(singleParam, raw);
    return Object.keys(out).length ? out : null;
  }

  for (const [param, policy] of Object.entries(raw)) {
    if (!isPlainObject(policy)) return null;
    put(param, policy);
  }
  return Object.keys(out).length ? out : null;
}

/**
 * 严格校验 modelConfigs JSON 串。失败抛 BadRequestException 让客户端看到具体哪个字段错。
 * 返回规范化后的 JSON 字符串（剔除多余 key、统一类型），用于落库。
 * 入参允许 null / undefined / '' → 返回 null（清空字段）。
 *
 * 兼容：旧版本写入的 thinking* / reasoningEffort / maxOutputTokens 字段会被静默丢弃，
 * 避免它们和模型库层的同名默认值同时存在产生歧义。
 */
export function validateModelConfigs(raw: unknown): string | null {
  if (raw === null || raw === undefined || raw === '') return null;

  let parsed: unknown;
  if (typeof raw === 'string') {
    try {
      parsed = JSON.parse(raw);
    } catch {
      throw new BadRequestException('modelConfigs 必须是合法 JSON');
    }
  } else {
    parsed = raw;
  }

  if (!isPlainObject(parsed)) {
    throw new BadRequestException('modelConfigs 必须是对象（Record<modelName, config>）');
  }

  const out: ModelConfigsMap = {};
  for (const [modelName, rawCfg] of Object.entries(parsed)) {
    if (!modelName || typeof modelName !== 'string') {
      throw new BadRequestException('modelConfigs 的 key（模型名）必须是非空字符串');
    }
    if (!isPlainObject(rawCfg)) {
      throw new BadRequestException(`modelConfigs["${modelName}"] 必须是对象`);
    }
    const cfg = validateOneConfig(modelName, rawCfg);
    if (Object.keys(cfg).length > 0) out[modelName] = cfg;
  }

  return JSON.stringify(out);
}

function validateOneConfig(modelName: string, cfg: Record<string, unknown>): PerModelConfig {
  const result: PerModelConfig = {};
  const fail = (field: string, msg: string): never => {
    throw new BadRequestException(`modelConfigs["${modelName}"].${field} ${msg}`);
  };

  if ('enabled' in cfg && cfg.enabled !== undefined && cfg.enabled !== null) {
    if (typeof cfg.enabled !== 'boolean') fail('enabled', '必须是布尔值');
    if (cfg.enabled === false) result.enabled = false;
    // enabled=true 是默认值，不写入避免噪音
  }
  if ('upstreamModelId' in cfg && cfg.upstreamModelId !== null && cfg.upstreamModelId !== undefined) {
    if (typeof cfg.upstreamModelId !== 'string' || cfg.upstreamModelId.length > 256) {
      fail('upstreamModelId', '必须是 ≤256 字符的字符串');
    }
    const trimmed = (cfg.upstreamModelId as string).trim();
    if (trimmed) result.upstreamModelId = trimmed;
  }
  const priorityValue = cfg.routingPriority ?? cfg.routing_priority ?? cfg.priority;
  if (priorityValue !== undefined && priorityValue !== null) {
    const numeric = Number(priorityValue);
    if (!Number.isInteger(numeric)) {
      fail('routingPriority', '必须是整数');
    }
    if (numeric < 1 || numeric > 100) {
      fail('routingPriority', '必须在 [1, 100] 范围内');
    }
    result.routingPriority = numeric;
  }
  const anthropicBeta = (cfg.anthropicBeta ?? cfg.anthropic_beta) as unknown;
  if (anthropicBeta !== undefined && anthropicBeta !== null) {
    if (typeof anthropicBeta === 'string') {
      if (anthropicBeta.length > 256) fail('anthropicBeta', '必须是 ≤256 字符的字符串');
      const trimmed = anthropicBeta.trim();
      if (trimmed) result.anthropicBeta = trimmed;
    } else {
      fail('anthropicBeta', '必须是 ≤256 字符的字符串');
    }
  }
  const tokenCountStrategy = (cfg.tokenCountStrategy ?? cfg.token_count_strategy) as unknown;
  if (tokenCountStrategy !== undefined && tokenCountStrategy !== null) {
    const normalized = String(tokenCountStrategy).trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!SUPPORTED_TOKEN_COUNT_STRATEGIES.has(normalized)) {
      fail('tokenCountStrategy', `必须是 ${TOKEN_COUNT_STRATEGIES.join(' / ')}`);
    }
    result.tokenCountStrategy = normalized as TokenCountStrategy;
  }
  const requestParamPolicy = (cfg.requestParamPolicy ?? cfg.request_param_policy) as unknown;
  if (requestParamPolicy !== undefined && requestParamPolicy !== null) {
    const normalized = normalizeRequestParamPolicy(requestParamPolicy);
    if (!normalized) fail('requestParamPolicy', '必须是 {param: policy} 对象，或带 param/name/field 的对象数组');
    result.requestParamPolicy = normalized as Record<string, Record<string, unknown>>;
  }
  if ('capabilityOverrides' in cfg || 'capability_overrides' in cfg) {
    fail('capabilityOverrides', '能力轴已冻结，不能在 channel.modelConfigs 中配置');
  }
  // thinking* / reasoningEffort / maxOutputTokens 已迁移到 ModelPricing；
  // protocolStrategyOverride 已退役。旧输入静默丢弃，避免继续进入 publisher runtime。
  return result;
}

/**
 * 把 channel 层 PerModelConfig 翻译成下游 codesphere-saas 期望的字段名。
 * 只下发 channel 层独有的字段（enabled / provider_model_name / routing_priority）。
 * thinking / reasoning / maxOutput 这些由 product portal 直接从 ModelPricing
 * 表合并给产品侧，不进入 publisher runtime，也不经过这里。
 */
export function toDownstreamModelDict(
  models: string[],
  modelConfigs: ModelConfigsMap | null,
): Record<string, Record<string, unknown>> {
  const out: Record<string, Record<string, unknown>> = {};
  for (const m of models) {
    out[m] = {};
  }
  if (!modelConfigs) return out;

  for (const [modelName, cfg] of Object.entries(modelConfigs)) {
    if (!(modelName in out)) continue;
    const target = out[modelName];

    if (cfg.enabled === false) {
      target.enabled = false;
    }
    if (cfg.upstreamModelId) {
      target.provider_model_name = cfg.upstreamModelId;
    }
    if (typeof cfg.routingPriority === 'number') {
      target.routing_priority = cfg.routingPriority;
    }
  }
  return out;
}

/** 解析存储中的 modelConfigs 字符串，给内部消费用。失败时返回 null（不抛）。 */
export function parseModelConfigs(raw: string | null | undefined): ModelConfigsMap | null {
  if (!raw) return null;
  try {
    const parsed = JSON.parse(raw);
    if (!isPlainObject(parsed)) return null;
    // 静默剔除 thinking* 等已迁移字段，保持运行时只看到当前 schema
    const out: ModelConfigsMap = {};
    for (const [k, v] of Object.entries(parsed)) {
      if (!isPlainObject(v)) continue;
      const cfg: PerModelConfig = {};
      if (v.enabled === false) cfg.enabled = false;
      if (typeof v.upstreamModelId === 'string' && v.upstreamModelId.trim()) {
        cfg.upstreamModelId = v.upstreamModelId.trim();
      }
      const priorityValue = v.routingPriority ?? v.routing_priority ?? v.priority;
      if (priorityValue !== undefined && priorityValue !== null) {
        const numeric = Number(priorityValue);
        if (Number.isInteger(numeric) && numeric >= 1 && numeric <= 100) {
          cfg.routingPriority = numeric;
        }
      }
      const anthropicBeta = v.anthropicBeta ?? v.anthropic_beta;
      if (typeof anthropicBeta === 'string' && anthropicBeta.trim()) {
        cfg.anthropicBeta = anthropicBeta.trim();
      }
      const tokenCountStrategy = v.tokenCountStrategy ?? v.token_count_strategy;
      if (typeof tokenCountStrategy === 'string') {
        const normalized = tokenCountStrategy.trim().toLowerCase().replace(/[\s-]+/g, '_');
        if (SUPPORTED_TOKEN_COUNT_STRATEGIES.has(normalized)) {
          cfg.tokenCountStrategy = normalized as TokenCountStrategy;
        }
      }
      const requestParamPolicy = v.requestParamPolicy ?? v.request_param_policy;
      if (requestParamPolicy !== undefined && requestParamPolicy !== null) {
        const normalized = normalizeRequestParamPolicy(requestParamPolicy);
        if (normalized) cfg.requestParamPolicy = normalized;
      }
      if (Object.keys(cfg).length > 0) out[k] = cfg;
    }
    return out;
  } catch {
    return null;
  }
}
