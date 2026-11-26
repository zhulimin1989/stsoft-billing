import { Injectable, Optional, BadRequestException, ConflictException, InternalServerErrorException, NotFoundException, Logger } from '@nestjs/common';
import { ProductBillingMode } from '@prisma/client';
import { AdminRepository } from '../admin/admin.repository';
import { OFF_PEAK_TIER_KEY, validateBandSchedule } from '../billing/model-time-band';
import { PrismaService } from '../prisma/prisma.service';
import { ProductSyncNotifier } from '../integration/product-sync-notifier';
import { RedisService } from '../redis/redis.service';
import { PublisherSyncService } from '../publisher/publisher-sync.service';
import { acquirePlanWriteLock } from '../billing/plan-write-lock';
import {
  assertNoUnsettledGatewayEvents,
  findUnsettledGatewayEvents,
  type UnsettledGatewayEventFact,
} from '../billing/model-retirement-preflight';
import { isProviderResalePlan } from '../quota-templates/plan-quota-rule-views';
import { parseModelConfigs } from './model-configs';
import {
  creditMultiplierCacheKey,
  modelPricingCacheKey,
  publicModelPricingCacheKey,
} from '../common/utils/redis-key.util';

type ChannelModelRef = {
  id: string;
  provider?: string | null;
  sdkType?: string | null;
};

// ─── v2 catalog field validation (PR4) ───
export const MODEL_PROVIDERS = [
  'openai',
  'anthropic',
  'qwen',
  'deepseek',
  'google',
  'mistral',
  'zhipu',
  'moonshot',
  'minimax',
  'doubao',
  'seedance',
  'volcengine',
  'runway',
  'kling',
  'stability',
  'fal',
  'elevenlabs',
  'other',
] as const;
export type ModelProvider = (typeof MODEL_PROVIDERS)[number];

export const MODEL_MODALITIES = [
  'text', 'image', 'file', 'audio', 'video', 'embedding',
] as const;

export const MODEL_TYPES = [
  'chat', 'embedding', 'rerank', 'image', 'audio', 'video', 'multimodal', 'task',
] as const;

export const MODEL_PRICING_UNITS = [
  'token_1m',
  'image',
  'video_second',
  'video_task',
  'audio_second',
  'audio_minute',
  'character',
  'request',
  'search_unit',
  'custom',
] as const;

export const MODEL_FEATURES = [
  'function_call',
  'function_tools',
  'streaming',
  'streaming_tools',
  'caching',
  'vision',
  'reasoning',
  'embedding',
  'embeddings',
  'rerank',
  'longContext',
  'tools',
  'json_mode',
  'json_schema',
  'image_generation',
  'image_edit',
  'image_variation',
  'image_upscale',
  'image_control',
  'subject_reference',
  'video_generation',
  'audio_generation',
  'tts',
  'stt',
  'text_to_speech',
  'speech_to_text',
  'speech_translation',
  'speech_to_speech',
  'voice_clone',
  'voice_design',
  'sound_effects',
  'timestamps',
  'diarization',
  'music_generation',
  'async_task',
  't2v',
  'i2v',
  'first_last_frame',
  'reference_to_video',
  'video_edit',
  'video_extend',
  'text_to_image',
] as const;

const MAX_DESCRIPTION_LEN = 4096;
const MAX_MODEL_ID_LEN = 128;
const MAX_TAGS = 16;
const MAX_TAG_LEN = 32;
const MAX_TOKEN_FIELD = 10_000_000;

interface UpsertModelPricingV2Input {
  modelName: string;
  inputPricePerMToken: number;
  outputPricePerMToken: number;
  isActive?: boolean;
  // v2 catalog fields (all optional)
  provider?: string | null;
  modelId?: string | null;
  description?: string | null;
  inputModalities?: string[] | null;
  outputModalities?: string[] | null;
  contextLength?: number | null;
  maxOutputTokens?: number | null;
  providerLogo?: string | null;
  isPublished?: boolean;
  displayOrder?: number;
  releaseAt?: string | Date | null;
  tags?: string[] | null;
  supportedFeatures?: string[] | null;
  modelType?: string | null;
  pricingUnit?: string | null;
  unitPriceUsd?: number | null;
  pricingMetadata?: Record<string, unknown> | null;
  cachedInputPrice?: number | null;
  cacheWrite5minPrice?: number | null;
  cacheWrite1hPrice?: number | null;
  batchDiscount?: number | null;
  // v4 调用层默认值（不是定价）
  defaultThinkingMode?: string | null;
  defaultThinkingBudget?: number | null;
  priceTiers?: ModelPricingTierInput[] | null;
}

interface ModelPricingTierInput {
  tierKey: string;
  displayName?: string | null;
  minInputTokens?: number | null;
  maxInputTokensExclusive?: number | null;
  inputPricePerMToken: number;
  outputPricePerMToken: number;
  cachedInputPrice?: number | null;
  cacheWritePrice?: number | null;
  currency?: string | null;
  rawCondition?: string | null;
  source?: string | null;
  priority?: number | null;
  isActive?: boolean;
}

function validateProvider(v: unknown): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') {
    throw new BadRequestException('provider 必须是字符串');
  }
  if (!(MODEL_PROVIDERS as readonly string[]).includes(v)) {
    throw new BadRequestException(
      `provider 必须是: ${MODEL_PROVIDERS.join(', ')}`,
    );
  }
  return v;
}

function validateModalities(v: unknown, label: string): string | null {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) {
    throw new BadRequestException(`${label} 必须是字符串数组`);
  }
  // 静默过滤白名单外值，避免历史导入或外部配置里的未知值打断保存。
  const filtered = v.filter(
    (m): m is string => typeof m === 'string' && (MODEL_MODALITIES as readonly string[]).includes(m),
  );
  return JSON.stringify(filtered);
}

function validateFeatures(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) {
    throw new BadRequestException('supportedFeatures 必须是字符串数组');
  }
  // 同上：静默过滤白名单外值，避免外部导入的扩展能力名阻塞所有保存。
  const filtered = v.filter(
    (f): f is string => typeof f === 'string' && (MODEL_FEATURES as readonly string[]).includes(f),
  );
  return JSON.stringify(filtered);
}

function validateEnumString(
  v: unknown,
  label: string,
  allowed: readonly string[],
): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') {
    throw new BadRequestException(`${label} 必须是字符串`);
  }
  if (!allowed.includes(v)) {
    throw new BadRequestException(`${label} 必须是: ${allowed.join(', ')}`);
  }
  return v;
}

function validatePricingMetadata(v: unknown): Record<string, unknown> | null {
  if (v === null || v === undefined) return null;
  if (!v || typeof v !== 'object' || Array.isArray(v)) {
    throw new BadRequestException('pricingMetadata 必须是对象');
  }
  try {
    return JSON.parse(JSON.stringify(v)) as Record<string, unknown>;
  } catch {
    throw new BadRequestException('pricingMetadata 必须是可序列化 JSON 对象');
  }
}

function validateTags(v: unknown): string | null {
  if (v === null || v === undefined) return null;
  if (!Array.isArray(v)) {
    throw new BadRequestException('tags 必须是字符串数组');
  }
  if (v.length > MAX_TAGS) {
    throw new BadRequestException(`tags 数量不能超过 ${MAX_TAGS}`);
  }
  for (const t of v) {
    if (typeof t !== 'string' || t.length === 0) {
      throw new BadRequestException('tags 元素必须是非空字符串');
    }
    if (t.length > MAX_TAG_LEN) {
      throw new BadRequestException(`tag 长度不能超过 ${MAX_TAG_LEN} 字符`);
    }
  }
  return JSON.stringify(v);
}

function validateInteger(
  v: unknown,
  label: string,
  { min = 0, max = MAX_TOKEN_FIELD }: { min?: number; max?: number } = {},
): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isInteger(v)) {
    throw new BadRequestException(`${label} 必须是整数`);
  }
  if (v < min || v > max) {
    throw new BadRequestException(`${label} 必须在 [${min}, ${max}] 范围内`);
  }
  return v;
}

function validatePrice(
  v: unknown,
  label: string,
  { min = 0, max = MAX_TOKEN_FIELD }: { min?: number; max?: number } = {},
): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || !Number.isFinite(v)) {
    throw new BadRequestException(`${label} 必须是数字`);
  }
  if (v < min || v > max) {
    throw new BadRequestException(`${label} 必须在 [${min}, ${max}] 范围内`);
  }
  return v;
}

function validateBatchDiscount(v: unknown): number | null {
  if (v === null || v === undefined) return null;
  if (typeof v !== 'number' || Number.isNaN(v)) {
    throw new BadRequestException('batchDiscount 必须是数字');
  }
  if (v < 0 || v > 1) {
    throw new BadRequestException('batchDiscount 必须在 [0, 1] 范围内');
  }
  return v;
}

function validateString(v: unknown, label: string, maxLen: number): string | null {
  if (v === null || v === undefined || v === '') return null;
  if (typeof v !== 'string') {
    throw new BadRequestException(`${label} 必须是字符串`);
  }
  if (v.length > maxLen) {
    throw new BadRequestException(`${label} 长度不能超过 ${maxLen} 字符`);
  }
  return v;
}

function validateReleaseAt(v: unknown): Date | null {
  if (v === null || v === undefined || v === '') return null;
  if (v instanceof Date) {
    if (Number.isNaN(v.getTime())) {
      throw new BadRequestException('releaseAt 不是有效日期');
    }
    return v;
  }
  if (typeof v !== 'string') {
    throw new BadRequestException('releaseAt 必须是 ISO 日期字符串');
  }
  const parsed = new Date(v);
  if (Number.isNaN(parsed.getTime())) {
    throw new BadRequestException('releaseAt 不是有效的 ISO 日期');
  }
  return parsed;
}

function validatePricingTiers(v: unknown): Parameters<AdminRepository['upsertModelPricing']>[1]['priceTiers'] {
  if (v === null || v === undefined) return [];
  if (!Array.isArray(v)) {
    throw new BadRequestException('priceTiers 必须是数组');
  }
  // 二选一（XOR）：OFF_PEAK 时段档必须是唯一档，不与上下文分档共存。
  // 同批次即时 400；跨请求并发/部分更新的最终态由 repository 事务内 advisory 锁复核。
  const hasOffPeak = v.some((item) => (item as Record<string, unknown> | null)?.tierKey === OFF_PEAK_TIER_KEY);
  if (hasOffPeak && v.length > 1) {
    throw new BadRequestException('OFF_PEAK 时段档必须是该模型唯一的价格档（与上下文分档二选一）');
  }
  const seen = new Set<string>();
  return v.map((item, index) => {
    if (!item || typeof item !== 'object') {
      throw new BadRequestException(`priceTiers[${index}] 必须是对象`);
    }
    const tier = item as Record<string, unknown>;
    const tierKey = validateString(tier.tierKey, `priceTiers[${index}].tierKey`, 80);
    if (!tierKey) {
      throw new BadRequestException(`priceTiers[${index}].tierKey 必填`);
    }
    if (seen.has(tierKey)) {
      throw new BadRequestException(`priceTiers tierKey 重复: ${tierKey}`);
    }
    seen.add(tierKey);
    const minInputTokens = validateInteger(
      tier.minInputTokens ?? 0,
      `priceTiers[${index}].minInputTokens`,
      { min: 0, max: 10_000_000 },
    ) ?? 0;
    const maxInputTokensExclusive = validateInteger(
      tier.maxInputTokensExclusive,
      `priceTiers[${index}].maxInputTokensExclusive`,
      { min: 1, max: 10_000_000 },
    );
    if (maxInputTokensExclusive !== null && maxInputTokensExclusive <= minInputTokens) {
      throw new BadRequestException(`priceTiers[${index}] maxInputTokensExclusive 必须大于 minInputTokens`);
    }
    const inputPricePerMToken = validatePrice(
      tier.inputPricePerMToken,
      `priceTiers[${index}].inputPricePerMToken`,
    );
    const outputPricePerMToken = validatePrice(
      tier.outputPricePerMToken,
      `priceTiers[${index}].outputPricePerMToken`,
    );
    if (inputPricePerMToken === null || outputPricePerMToken === null) {
      throw new BadRequestException(`priceTiers[${index}] input/output 价格必填`);
    }
    if (tier.isActive !== undefined && typeof tier.isActive !== 'boolean') {
      throw new BadRequestException(`priceTiers[${index}].isActive 必须是布尔`);
    }
    const cachedInputPrice = validatePrice(tier.cachedInputPrice, `priceTiers[${index}].cachedInputPrice`);
    const cacheWritePrice = validatePrice(tier.cacheWritePrice, `priceTiers[${index}].cacheWritePrice`);
    let bandSchedule: unknown = null;
    if (tierKey === OFF_PEAK_TIER_KEY) {
      // 时段档（me/time-based-pricing.md v13.4）：四价必填（cached/cacheWrite 为空会走
      // deriveCachedInputPrice 派生，glm-5 系再乘 0.2，破坏"四维绝对价"口径）；
      // 高峰窗口必填且过结构校验；服务端规范化区间为 [0, ∞)。
      if (cachedInputPrice === null || cacheWritePrice === null) {
        throw new BadRequestException('OFF_PEAK 时段档的 cachedInputPrice / cacheWritePrice 必填（四维绝对价）');
      }
      bandSchedule = validateBandSchedule((tier as Record<string, unknown>).bandSchedule);
      return {
        tierKey,
        displayName: validateString(tier.displayName, `priceTiers[${index}].displayName`, 120) ?? '空闲时段价',
        minInputTokens: 0,
        maxInputTokensExclusive: null,
        inputPricePerMToken,
        outputPricePerMToken,
        cachedInputPrice,
        cacheWritePrice,
        bandSchedule,
        currency: validateString(tier.currency ?? 'USD', `priceTiers[${index}].currency`, 12) ?? 'USD',
        rawCondition: validateString(tier.rawCondition, `priceTiers[${index}].rawCondition`, 256),
        source: validateString(tier.source, `priceTiers[${index}].source`, 64),
        priority: 0,
        isActive: tier.isActive ?? true,
      };
    }
    return {
      tierKey,
      displayName: validateString(tier.displayName, `priceTiers[${index}].displayName`, 120),
      minInputTokens,
      maxInputTokensExclusive,
      inputPricePerMToken,
      outputPricePerMToken,
      cachedInputPrice,
      cacheWritePrice,
      currency: validateString(tier.currency ?? 'USD', `priceTiers[${index}].currency`, 12) ?? 'USD',
      rawCondition: validateString(tier.rawCondition, `priceTiers[${index}].rawCondition`, 256),
      source: validateString(tier.source, `priceTiers[${index}].source`, 64),
      priority: validateInteger(tier.priority ?? 0, `priceTiers[${index}].priority`, { min: 0, max: 1000 }) ?? 0,
      isActive: tier.isActive ?? true,
    };
  });
}

@Injectable()
export class ChannelAdminService {
  private readonly logger = new Logger(ChannelAdminService.name);

  constructor(
    private readonly repo: AdminRepository,
    private readonly prisma: PrismaService,
    private readonly productSync: ProductSyncNotifier,
    // 用于失效 CreditPricingService 的 plan/model 缓存(1h TTL)
    @Optional() private readonly redis?: RedisService,
    @Optional() private readonly publisherSync?: PublisherSyncService,
  ) {}

  /**
   * 失效 ModelAccess 变更对应的 credit_mult Redis 缓存。
   * CreditPricingService.getCreditMultiplier 缓存 1h TTL,无主动失效;
   * admin 改 creditMultiplier 后必须 DEL 缓存让用户端立即生效。
   * Redis 故障时静默(下次 1h 自然过期),不阻塞 admin 操作。
   */
  private async invalidateCreditMultCache(planId: string, modelName: string): Promise<void> {
    if (!this.redis || !planId || !modelName) return;
    const key = creditMultiplierCacheKey(planId, modelName);
    try {
      await this.redis.del(key);
    } catch {
      // 静默 — 1h TTL 兜底
    }
  }

  /**
   * 定价快照缓存失效（me/time-based-pricing.md v13.4 §2 失效语义）：
   * DEL 失败重试 3 次后**抛错**（让运营明确感知"保存未完全生效"，不再静默）；
   * 成功后安排一次**延迟二次 DEL**，压缩"读旧 DB → DEL 后回填旧缓存"的竞态窗
   * （读侧回填已改 SET NX；极端竞态按缓存项 TTL 1h 自然收敛，不承诺硬上界）。
   */
  private async invalidateModelPricingCache(modelName: string): Promise<void> {
    if (!this.redis || !modelName) return;
    const keys = [modelPricingCacheKey(modelName), publicModelPricingCacheKey(modelName)];
    let lastError: unknown = null;
    for (let attempt = 1; attempt <= 3; attempt += 1) {
      try {
        await Promise.all(keys.map((key) => this.redis!.del(key)));
        lastError = null;
        break;
      } catch (err) {
        lastError = err;
      }
    }
    if (lastError) {
      this.logger.error(
        `model pricing cache invalidation failed after retries model=${modelName}: ${lastError instanceof Error ? lastError.message : String(lastError)}`,
      );
      throw new InternalServerErrorException(
        `模型 "${modelName}" 定价已保存，但缓存失效失败——价格最长 1 小时后生效，请稍后重试保存或联系运维`,
      );
    }
    // 延迟二次 DEL：失败只记日志（TTL 兜底），不影响本次保存结果
    setTimeout(() => {
      Promise.all(keys.map((key) => this.redis!.del(key))).catch((err: unknown) => {
        this.logger.warn(
          `model pricing cache delayed re-invalidation failed model=${modelName}: ${err instanceof Error ? err.message : String(err)}`,
        );
      });
    }, 2000);
  }

  async listModelPricing() {
    const rows = await this.repo.findModelPricing();
    return rows.map((row) => this.serializeDecimalFields({
      ...row,
      displayName: row.modelId?.trim() || row.modelName,
    }));
  }

  private serializeDecimalFields<T extends Record<string, unknown>>(row: T): T {
    return this.serializeValue(row) as T;
  }

  private serializeValue(value: unknown): unknown {
    if (value && typeof (value as { toNumber?: unknown }).toNumber === 'function') {
      return (value as { toNumber: () => number }).toNumber();
    }
    if (Array.isArray(value)) {
      return value.map((item) => this.serializeValue(item));
    }
    if (value instanceof Date) {
      return value;
    }
    if (value && typeof value === 'object') {
      return Object.fromEntries(
        Object.entries(value as Record<string, unknown>).map(([key, child]) => [
          key,
          this.serializeValue(child),
        ]),
      );
    }
    return value;
  }

  async upsertModelPricing(data: UpsertModelPricingV2Input) {
    if (!data?.modelName || typeof data.modelName !== 'string') {
      throw new BadRequestException('modelName 必填');
    }
    // Build the v2 payload — pick keys conditionally so that fields the caller
    // didn't pass remain untouched in the DB (vs being explicitly nulled).
    const payload: Parameters<AdminRepository['upsertModelPricing']>[1] = {
      inputPricePerMToken: data.inputPricePerMToken,
      outputPricePerMToken: data.outputPricePerMToken,
      isActive: data.isActive ?? true,
    };

    if (Object.prototype.hasOwnProperty.call(data, 'provider')) {
      payload.provider = validateProvider(data.provider);
    }
    if (Object.prototype.hasOwnProperty.call(data, 'modelId')) {
      payload.modelId = validateString(data.modelId, 'modelId', MAX_MODEL_ID_LEN);
    }
    if (Object.prototype.hasOwnProperty.call(data, 'description')) {
      payload.description = validateString(data.description, 'description', MAX_DESCRIPTION_LEN);
    }
    if (Object.prototype.hasOwnProperty.call(data, 'inputModalities')) {
      payload.inputModalities = validateModalities(data.inputModalities, 'inputModalities');
    }
    if (Object.prototype.hasOwnProperty.call(data, 'outputModalities')) {
      payload.outputModalities = validateModalities(data.outputModalities, 'outputModalities');
    }
    if (Object.prototype.hasOwnProperty.call(data, 'contextLength')) {
      payload.contextLength = validateInteger(data.contextLength, 'contextLength');
    }
    if (Object.prototype.hasOwnProperty.call(data, 'maxOutputTokens')) {
      payload.maxOutputTokens = validateInteger(data.maxOutputTokens, 'maxOutputTokens');
    }
    if (Object.prototype.hasOwnProperty.call(data, 'providerLogo')) {
      payload.providerLogo = validateString(data.providerLogo, 'providerLogo', 2048);
    }
    if (Object.prototype.hasOwnProperty.call(data, 'isPublished')) {
      if (typeof data.isPublished !== 'boolean') {
        throw new BadRequestException('isPublished 必须是布尔');
      }
      payload.isPublished = data.isPublished;
    }
    if (Object.prototype.hasOwnProperty.call(data, 'displayOrder')) {
      // Match the "null = explicit clear" semantics the other v2 fields use,
      // but for a non-nullable integer column the natural "cleared" value is
      // 0. When the caller doesn't include displayOrder at all the field is
      // skipped entirely (existing value preserved). The earlier `?? 0`
      // shortcut would silently overwrite a non-zero existing value with 0
      // any time the partial payload from frontend handlers happened to omit
      // displayOrder but kept the field key set to undefined.
      if (data.displayOrder === null) {
        payload.displayOrder = 0;
      } else if (data.displayOrder !== undefined) {
        const v = validateInteger(data.displayOrder, 'displayOrder', { min: 0, max: 1_000_000 });
        if (v !== null) payload.displayOrder = v;
      }
    }
    if (Object.prototype.hasOwnProperty.call(data, 'releaseAt')) {
      payload.releaseAt = validateReleaseAt(data.releaseAt);
    }
    if (Object.prototype.hasOwnProperty.call(data, 'tags')) {
      payload.tags = validateTags(data.tags);
    }
    if (Object.prototype.hasOwnProperty.call(data, 'supportedFeatures')) {
      payload.supportedFeatures = validateFeatures(data.supportedFeatures);
    }
    if (Object.prototype.hasOwnProperty.call(data, 'modelType')) {
      payload.modelType = validateEnumString(data.modelType, 'modelType', MODEL_TYPES);
    }
    if (Object.prototype.hasOwnProperty.call(data, 'pricingUnit')) {
      payload.pricingUnit = validateEnumString(data.pricingUnit, 'pricingUnit', MODEL_PRICING_UNITS);
    }
    if (Object.prototype.hasOwnProperty.call(data, 'unitPriceUsd')) {
      payload.unitPriceUsd = validatePrice(data.unitPriceUsd, 'unitPriceUsd');
    }
    if (Object.prototype.hasOwnProperty.call(data, 'pricingMetadata')) {
      payload.pricingMetadata = validatePricingMetadata(data.pricingMetadata);
    }
    if (Object.prototype.hasOwnProperty.call(data, 'cachedInputPrice')) {
      payload.cachedInputPrice = validatePrice(data.cachedInputPrice, 'cachedInputPrice');
    }
    if (Object.prototype.hasOwnProperty.call(data, 'cacheWrite5minPrice')) {
      payload.cacheWrite5minPrice = validatePrice(data.cacheWrite5minPrice, 'cacheWrite5minPrice');
    }
    if (Object.prototype.hasOwnProperty.call(data, 'cacheWrite1hPrice')) {
      payload.cacheWrite1hPrice = validatePrice(data.cacheWrite1hPrice, 'cacheWrite1hPrice');
    }
    if (Object.prototype.hasOwnProperty.call(data, 'batchDiscount')) {
      payload.batchDiscount = validateBatchDiscount(data.batchDiscount);
    }
    if (
      Object.prototype.hasOwnProperty.call(data, 'priceTiers')
      && data.priceTiers !== undefined
    ) {
      payload.priceTiers = validatePricingTiers(data.priceTiers);
    }

    // ─── v4: 调用层默认值 ───
    if (Object.prototype.hasOwnProperty.call(data, 'defaultThinkingMode')) {
      const v = data.defaultThinkingMode;
      if (v === null || v === undefined || v === '') {
        payload.defaultThinkingMode = null;
      } else if (
        typeof v !== 'string' ||
        !['disabled', 'enabled', 'auto'].includes(v)
      ) {
        throw new BadRequestException('defaultThinkingMode 必须是 disabled | enabled | auto');
      } else {
        payload.defaultThinkingMode = v;
      }
    }
    if (Object.prototype.hasOwnProperty.call(data, 'defaultThinkingBudget')) {
      // 0..32768 — Anthropic / Gemini thinking budget
      payload.defaultThinkingBudget = validateInteger(
        data.defaultThinkingBudget,
        'defaultThinkingBudget',
        { min: 0, max: 32768 },
      );
    }

    const result = await this.repo.upsertModelPricing(data.modelName, payload);
    await this.invalidateModelPricingCache(data.modelName);
    if (Object.prototype.hasOwnProperty.call(data, 'isActive')) {
      await this.notifyRuntimeModelStateChanged(
        data.modelName,
        data.isActive === false ? 'inactive' : 'active',
      );
    }
    this.notifyAllProductWebhook('model_pricing_changed').catch(() => {});
    return result;
  }

  async syncModelPricingFromProxy() {
    const models = await this.listConfiguredChannelModels();
    let added = 0;
    for (const model of models) {
      const existing = await this.repo.findModelPricingByName(model.id);
      if (!existing) {
        await this.repo.createModelPricing(model.id, {
          provider: this.inferModelProvider(model.id, model.provider, model.sdkType),
          modelType: this.inferModelType(model.id, model.provider, model.sdkType),
          pricingUnit: this.inferPricingUnit(model.id, model.provider, model.sdkType),
          pricingMetadata: this.inferPricingMetadata(model.id, model.provider, model.sdkType),
          inputModalities: JSON.stringify(this.inferInputModalities(model.id, model.provider, model.sdkType)),
          outputModalities: JSON.stringify(this.inferOutputModalities(model.id, model.provider, model.sdkType)),
          supportedFeatures: JSON.stringify(this.inferSupportedFeatures(model.id, model.provider, model.sdkType)),
        });
        added++;
      }
    }
    return { added, total: models.length };
  }

  /**
   * 标记"孤儿" ModelPricing 为不活跃 —— 即 active 但既不在当前 Channel
   * 聚合白名单里，也没有被 active plan 的 ModelAccess 引用的条目。
   * 用户切换/删除 Channel 后，历史遗留定价会变成孤儿。
   * 让它们 isActive=false 可以：
   *   - 前端选择器不再展示
   *   - 计费链路直接拒绝未开放模型
   *   - 不删数据，保留历史审计 + 便于以后一键恢复
   *
   * 注意：active plan 仍在开放的模型不是孤儿，即使当前 Channel 列表暂时
   * 没返回它，也不能被这个清理动作下线。否则会出现 active ModelAccess
   * 指向 inactive ModelPricing 的错误状态。
   *
   * 两步过程：preview（不写） + commit（真的禁用）。由 confirm 参数控制。
   */
  async deactivateOrphanModelPricing(confirm: boolean): Promise<{
    orphans: string[];
    deactivated: number;
    dryRun: boolean;
    /** 有未结算 Gateway 事件、会被闸门拦住的孤儿。preview 里先让运营看见，commit 时直接拒。 */
    blocked?: UnsettledGatewayEventFact[];
  }> {
    const [channelModels, activeAccessModelNames] = await Promise.all([
      this.listConfiguredChannelModels(),
      this.repo.findActiveModelAccessNames(),
    ]);
    const keepModelNames = Array.from(new Set([
      ...channelModels.map((m) => m.id),
      ...activeAccessModelNames,
    ]));

    const orphanRows = await this.repo.findActiveModelPricingNotIn(keepModelNames);
    const orphans = orphanRows.map((r) => r.modelName);

    if (!confirm) {
      const blocked = await findUnsettledGatewayEvents(this.prisma, orphans);
      return { orphans, deactivated: 0, dryRun: true, ...(blocked.length > 0 ? { blocked } : {}) };
    }

    // 这条路走的是无锁 updateMany（绕过 upsertModelPricing 的 advisory 锁），所以闸门要
    // 单独在这里再挡一次；否则运营用"清理孤儿"这个入口就能绕过下架前置检查。
    await assertNoUnsettledGatewayEvents(this.prisma, orphans);
    const result = await this.repo.deactivateModelPricingNotIn(keepModelNames);
    await Promise.all(orphans.map((modelName) => this.invalidateModelPricingCache(modelName)));
    if (orphans.length > 0) {
      await this.notifyRuntimeModelsRemoved(orphans);
    }
    return { orphans, deactivated: result.count, dryRun: false };
  }

  async listModelAccess() {
    return this.repo.findModelAccess();
  }

  async batchUpdateModelAccess(items: {
    tierId?: string;
    planId?: string;
    modelName?: string;
    model?: string;
    isActive?: boolean;
    isAllowed?: boolean;
    creditMultiplier?: number;
  }[]) {
    if (!items?.length) throw new BadRequestException('items 不能为空');
    const affectedPlanIds = [...new Set(
      items.map((i) => (i.tierId || i.planId || '').trim()).filter(Boolean),
    )] as string[];

    // finding #13：与 setPlanActive 取同一 per-plan advisory 锁串行化（按 planId 升序取避免死锁），
    // 锁内做 active 绑定删除守卫——已上架自营套餐变更后不得跌到 0 启用模型（含并发/直调兜底）。
    await this.prisma.$transaction(async (tx) => {
      for (const pid of [...affectedPlanIds].sort()) {
        await acquirePlanWriteLock(tx, pid);
      }
      for (const item of items) {
        const planId = (item.tierId || item.planId || '').trim();
        const modelName = (item.modelName || item.model || '').trim();
        const isActive = item.isActive ?? item.isAllowed ?? true;
        const data: { isActive: boolean; creditMultiplier?: number } = { isActive };
        if (item.creditMultiplier !== undefined) {
          data.creditMultiplier = item.creditMultiplier;
        }
        await tx.modelAccess.upsert({
          where: { planId_modelName: { planId, modelName } },
          update: data,
          create: { planId, modelName, ...data },
        });
      }
      for (const pid of affectedPlanIds) {
        const plan = await tx.plan.findUnique({
          where: { id: pid },
          select: {
            isActive: true,
            features: true,
            product: { select: { billingMode: true, codingPlanFulfillmentMode: true } },
          },
        });
        // 自营口径与 setPlanActive/replacePlanRules 一致（三重排除转售，防误伤，codex）。
        const isSelfOpActive =
          !!plan?.isActive &&
          plan.product?.billingMode === ProductBillingMode.CODING_PLAN &&
          plan.product?.codingPlanFulfillmentMode !== 'provider_resale' &&
          !isProviderResalePlan(plan.features);
        if (isSelfOpActive) {
          const activeModels = await tx.modelAccess.count({ where: { planId: pid, isActive: true } });
          if (activeModels < 1) {
            throw new ConflictException('已上架的自营套餐不能移除全部启用模型，请先下架');
          }
        }
      }
    });

    // 提交成功后：失效 credit_mult Redis 缓存(让 CreditPricingService 下次扣费走最新值) + 通知 webhook。
    for (const item of items) {
      const planId = (item.tierId || item.planId || '').trim();
      const modelName = (item.modelName || item.model || '').trim();
      await this.invalidateCreditMultCache(planId, modelName);
    }
    this.notifyPlansWebhook(affectedPlanIds, 'model_access_changed');
    // 自营 CodingPlan：ModelAccess 变更后重发受影响 plan 的 key —— KeyMeta.allowed_models 由 ModelAccess
    // 派生（buildKeyMeta），不重发则网关白名单长期滞后。fire-and-forget + 失败告警（codex 可观测要求）。
    // syncApiKeysByPlanId 仅扫该 plan 下 active 订阅/entitlement 的 key，buildKeyMeta 仅对自营派生，转售不受影响。
    if (this.publisherSync) {
      for (const planId of affectedPlanIds) {
        this.publisherSync
          .syncApiKeysByPlanId(planId)
          .then(() => this.logger.log(`re-synced api keys after ModelAccess change plan=${planId}`))
          .catch((err) =>
            this.logger.error(
              `ModelAccess 变更后重发 key 失败 plan=${planId}: ${err instanceof Error ? err.message : String(err)}`,
            ),
          );
      }
    }
  }

  async listModelRoutePolicies() {
    return this.repo.findModelRoutePolicies();
  }

  async batchUpdateModelRoutePolicies(items: {
    planId?: string;
    routeKey?: string;
    primaryModel?: string | null;
    fallbackModels?: string[];
    isActive?: boolean;
  }[]) {
    if (!items?.length) throw new BadRequestException('items 不能为空');

    for (const item of items) {
      const planId = String(item.planId || '').trim();
      const routeKey = String(item.routeKey || '').trim();
      if (!planId || !routeKey) {
        throw new BadRequestException('planId 和 routeKey 不能为空');
      }
      const fallbackModels = Array.isArray(item.fallbackModels)
        ? item.fallbackModels.map((model) => String(model).trim()).filter(Boolean)
        : [];
      await this.repo.upsertModelRoutePolicy(planId, routeKey, {
        primaryModel: item.primaryModel ? String(item.primaryModel).trim() : null,
        fallbackModels: JSON.stringify([...new Set(fallbackModels)]),
        isActive: item.isActive ?? true,
      });
    }

    const affectedPlanIds = [...new Set(items.map((i) => i.planId).filter(Boolean))];
    this.notifyPlansWebhook(affectedPlanIds as string[], 'model_route_policy_changed');
  }

  private async notifyPlansWebhook(planIds: string[], changeType: string) {
    try {
      const plans = await this.repo.findPlansByIds(planIds);
      const productIds = [...new Set(plans.map((p: any) => p.productId).filter(Boolean))];
      for (const pid of productIds) {
        this.notifyProductWebhook(pid as string, changeType);
      }
    } catch { /* non-critical */ }
  }

  private async notifyProductWebhook(productId: string | null | undefined, changeType: string) {
    if (!productId) return;
    try {
      const product = await this.repo.findProductById(productId);
      if (product?.slug) {
        this.productSync.notifyProductSaas(product.slug, changeType).catch(() => {});
      }
    } catch { /* non-critical */ }
  }

  private async listConfiguredChannelModels(): Promise<ChannelModelRef[]> {
    const channels = await this.repo.findChannelsForHealth();
    const seen = new Set<string>();
    const result: ChannelModelRef[] = [];

    for (const channel of channels as Array<{
      provider?: string | null;
      sdkType?: string | null;
      models?: string | null;
      modelConfigs?: string | null;
      isActive?: boolean | null;
      status?: string | null;
      deletedAt?: Date | string | null;
    }>) {
      if (channel.isActive === false || channel.status === 'inactive' || channel.deletedAt) continue;

      let parsed: unknown;
      try {
        parsed = JSON.parse(channel.models || '[]');
      } catch {
        continue;
      }
      if (!Array.isArray(parsed)) continue;

      const configs = parseModelConfigs(channel.modelConfigs);
      for (const modelId of parsed) {
        if (typeof modelId !== 'string' || modelId === '*' || seen.has(modelId)) continue;
        if (configs?.[modelId]?.enabled === false) continue;
        seen.add(modelId);
        result.push({
          id: modelId,
          provider: channel.provider ?? null,
          sdkType: channel.sdkType ?? null,
        });
      }
    }

    return result;
  }

  /**
   * 一键将所有 isActive=true 的模型设为 isPublished=true。
   * 用于历史数据初始化(早期录入时未勾用户端展示)。
   */
  async publishAllActive(): Promise<{ updated: number }> {
    const result = await this.repo.publishAllActiveModelPricing();
    this.notifyAllProductWebhook('models_published').catch(() => {});
    return { updated: result.count };
  }

  /**
   * 物理删除模型库条目。删除前检查 ModelAccess（套餐配置）是否引用，引用了拒绝
   * 让运营先去套餐里去掉，避免套餐指向不存在的模型。
   *
   * UsageEvent / Channel.models 不阻塞删除：前者是审计日志，String 字段保留即可；
   * 后者是 channel JSON 数组，残留无害（下游过滤会忽略）。
   */
  async deleteModelPricing(
    modelName: string,
  ): Promise<{ deleted: boolean; modelName: string }> {
    if (!modelName || typeof modelName !== 'string') {
      throw new BadRequestException('modelName 必填');
    }
    const trimmed = modelName.trim();
    if (!trimmed) {
      throw new BadRequestException('modelName 不能为空');
    }

    const existing = await this.repo.findModelPricingByName(trimmed);
    if (!existing) {
      throw new NotFoundException(`模型 ${trimmed} 不存在`);
    }

    const refs = await this.repo.findModelAccessReferences(trimmed);
    if (refs.length > 0) {
      const planSummary = refs
        .map((r) => `${r.planName ?? '?'} (${r.planId.slice(0, 8)}…)`)
        .join('、');
      throw new BadRequestException(
        `该模型被 ${refs.length} 个套餐引用，请先在套餐里移除：${planSummary}`,
      );
    }

    // 物理删除比下架更狠：行没了就没有 ends_at 窗口可言，尚未结算的历史事件永远取不到价。
    // 所以这里的闸门不能省。
    await assertNoUnsettledGatewayEvents(this.prisma, [trimmed]);

    await this.repo.deleteModelPricingByName(trimmed);
    await this.invalidateModelPricingCache(trimmed);
    await this.notifyRuntimeModelsRemoved([trimmed]);
    this.notifyAllProductWebhook('model_pricing_deleted').catch(() => {});
    return { deleted: true, modelName: trimmed };
  }

  private async notifyRuntimeModelStateChanged(modelName: string, state: 'active' | 'inactive'): Promise<void> {
    if (!this.publisherSync) return;
    if (state === 'inactive') {
      await this.publisherSync.deleteModelRuntime(modelName);
    }
    await this.publisherSync.syncOpsTopologyFresh();
  }

  private async notifyRuntimeModelsRemoved(modelNames: string[]): Promise<void> {
    if (!this.publisherSync || modelNames.length === 0) return;
    await Promise.all(modelNames.map((modelName) => this.publisherSync!.deleteModelRuntime(modelName)));
    await this.publisherSync.syncOpsTopologyFresh();
    this.logger.log(`publisher runtime refreshed after model removal: ${modelNames.join(',')}`);
  }

  private providerHintToken(provider?: string | null, sdkType?: string | null): string {
    return `${provider ?? ''} ${sdkType ?? ''}`.trim().toLowerCase().replace(/[\s-]+/g, '_');
  }

  private isAnthropicChatModel(modelName: string, provider?: string | null, sdkType?: string | null): boolean {
    const normalized = modelName.toLowerCase();
    const hint = this.providerHintToken(provider, sdkType);
    return hint.includes('anthropic') || hint.includes('claude') || normalized.startsWith('claude-');
  }

  private isCodexResponsesModel(modelName: string, provider?: string | null, sdkType?: string | null): boolean {
    const normalized = modelName.toLowerCase();
    const hint = this.providerHintToken(provider, sdkType);
    return normalized.includes('codex') || (hint.includes('openai_responses') && normalized.startsWith('gpt-'));
  }

  private isMinimaxVideoModel(modelName: string, provider?: string | null, sdkType?: string | null): boolean {
    const normalized = modelName.toLowerCase();
    const hint = this.providerHintToken(provider, sdkType);
    return (
      hint.includes('minimax_video')
      || hint.includes('hailuo')
      || normalized.includes('hailuo')
      || normalized.startsWith('s2v-')
    );
  }

  private isSeedanceVideoModel(modelName: string, provider?: string | null, sdkType?: string | null): boolean {
    const normalized = modelName.toLowerCase();
    const hint = this.providerHintToken(provider, sdkType);
    return (
      hint.includes('seedance')
      || hint.includes('volcengine')
      || hint.includes('ark_video')
      || normalized.includes('seedance')
      || normalized.startsWith('doubao-seedance')
    );
  }

  private isRunwayVideoModel(modelName: string, provider?: string | null, sdkType?: string | null): boolean {
    const normalized = modelName.toLowerCase();
    const hint = this.providerHintToken(provider, sdkType);
    return (
      hint.includes('runway')
      || ['gen4.5', 'gen4_turbo', 'gen3a_turbo', 'veo3.1', 'veo3.1_fast', 'veo3'].includes(normalized)
    );
  }

  private isKlingVideoModel(modelName: string, provider?: string | null, sdkType?: string | null): boolean {
    const normalized = modelName.toLowerCase();
    const hint = this.providerHintToken(provider, sdkType);
    return hint.includes('kling') || normalized.includes('kling');
  }

  private isOpenAiImageModel(modelName: string, provider?: string | null, sdkType?: string | null): boolean {
    const normalized = modelName.toLowerCase();
    const hint = this.providerHintToken(provider, sdkType);
    return (
      hint.includes('openai_image')
      || normalized.startsWith('gpt-image-')
      || normalized.startsWith('dall-e-')
    );
  }

  private isMiniMaxImageModel(modelName: string, provider?: string | null, sdkType?: string | null): boolean {
    const normalized = modelName.toLowerCase();
    const hint = this.providerHintToken(provider, sdkType);
    return hint.includes('minimax_image') || normalized === 'image-01';
  }

  private isStabilityImageModel(modelName: string, provider?: string | null, sdkType?: string | null): boolean {
    const normalized = modelName.toLowerCase();
    const hint = this.providerHintToken(provider, sdkType);
    return (
      hint.includes('stability')
      || normalized.startsWith('stable-image-')
      || normalized.startsWith('stable-diffusion-')
      || normalized.startsWith('sdxl')
    );
  }

  private isFalImageModel(modelName: string, provider?: string | null, sdkType?: string | null): boolean {
    const normalized = modelName.toLowerCase();
    const hint = this.providerHintToken(provider, sdkType);
    return hint.includes('fal_image') || normalized.startsWith('fal-ai/');
  }

  private isImageModel(modelName: string, provider?: string | null, sdkType?: string | null): boolean {
    const normalized = modelName.toLowerCase();
    const hint = this.providerHintToken(provider, sdkType);
    return (
      this.isOpenAiImageModel(modelName, provider, sdkType)
      || this.isMiniMaxImageModel(modelName, provider, sdkType)
      || this.isStabilityImageModel(modelName, provider, sdkType)
      || this.isFalImageModel(modelName, provider, sdkType)
      || hint.includes('image_generation')
      || normalized.includes('image')
    );
  }

  private isOpenAiAudioModel(modelName: string, provider?: string | null, sdkType?: string | null): boolean {
    const normalized = modelName.toLowerCase();
    const hint = this.providerHintToken(provider, sdkType);
    return (
      hint.includes('openai_audio')
      || normalized === 'whisper-1'
      || normalized.includes('transcribe')
      || normalized.includes('tts')
    );
  }

  private isElevenLabsAudioModel(modelName: string, provider?: string | null, sdkType?: string | null): boolean {
    const normalized = modelName.toLowerCase();
    const hint = this.providerHintToken(provider, sdkType);
    return (
      hint.includes('elevenlabs')
      || normalized.startsWith('eleven_')
      || normalized.startsWith('scribe_')
    );
  }

  private isMiniMaxSpeechModel(modelName: string, provider?: string | null, sdkType?: string | null): boolean {
    const normalized = modelName.toLowerCase();
    const hint = this.providerHintToken(provider, sdkType);
    return hint.includes('minimax_audio') || normalized.startsWith('speech-');
  }

  private isMiniMaxMusicModel(modelName: string, provider?: string | null, sdkType?: string | null): boolean {
    const normalized = modelName.toLowerCase();
    const hint = this.providerHintToken(provider, sdkType);
    return hint.includes('minimax_music') || normalized.startsWith('music-');
  }

  private isTtsModel(modelName: string, provider?: string | null, sdkType?: string | null): boolean {
    const normalized = modelName.toLowerCase();
    const hint = this.providerHintToken(provider, sdkType);
    return (
      hint.includes('tts')
      || normalized.includes('tts')
      || normalized.startsWith('speech-')
      || normalized.startsWith('eleven_')
    );
  }

  private isSttModel(modelName: string, provider?: string | null, sdkType?: string | null): boolean {
    const normalized = modelName.toLowerCase();
    const hint = this.providerHintToken(provider, sdkType);
    return (
      hint.includes('stt')
      || normalized === 'whisper-1'
      || normalized.includes('transcribe')
      || normalized.startsWith('scribe_')
    );
  }

  private isAudioModel(modelName: string, provider?: string | null, sdkType?: string | null): boolean {
    const normalized = modelName.toLowerCase();
    const hint = this.providerHintToken(provider, sdkType);
    return (
      this.isOpenAiAudioModel(modelName, provider, sdkType)
      || this.isElevenLabsAudioModel(modelName, provider, sdkType)
      || this.isMiniMaxSpeechModel(modelName, provider, sdkType)
      || this.isMiniMaxMusicModel(modelName, provider, sdkType)
      || hint.includes('audio_generation')
      || hint.includes('music_generation')
      || normalized.includes('audio')
      || normalized.includes('speech')
      || normalized.includes('tts')
    );
  }

  private isVideoModel(modelName: string, provider?: string | null, sdkType?: string | null): boolean {
    const normalized = modelName.toLowerCase();
    const hint = this.providerHintToken(provider, sdkType);
    return (
      this.isMinimaxVideoModel(modelName, provider, sdkType)
      || this.isSeedanceVideoModel(modelName, provider, sdkType)
      || this.isRunwayVideoModel(modelName, provider, sdkType)
      || this.isKlingVideoModel(modelName, provider, sdkType)
      || hint.includes('video_generation')
      || normalized.includes('video')
    );
  }

  private inferModelProvider(modelName: string, provider?: string | null, sdkType?: string | null): ModelProvider {
    const providerToken = (provider ?? '').toLowerCase();
    const hint = this.providerHintToken(provider, sdkType);
    if (hint.includes('seedance')) return 'seedance';
    if (providerToken.includes('volc') || providerToken.includes('ark')) return 'volcengine';
    if (providerToken.includes('doubao')) return 'doubao';
    if (hint.includes('runway')) return 'runway';
    if (hint.includes('kling')) return 'kling';
    if (hint.includes('minimax') || hint.includes('hailuo')) return 'minimax';
    if (hint.includes('elevenlabs')) return 'elevenlabs';
    if (hint.includes('stability')) return 'stability';
    if (hint.includes('fal_image') || hint.includes(' fal')) return 'fal';
    const normalized = modelName.toLowerCase();
    if (normalized.startsWith('gpt-') || normalized.startsWith('o1') || normalized.startsWith('o3')) return 'openai';
    if (normalized.startsWith('claude-')) return 'anthropic';
    if (normalized.startsWith('deepseek-')) return 'deepseek';
    if (normalized.startsWith('glm-')) return 'zhipu';
    if (normalized.startsWith('minimax') || normalized.startsWith('mini-max') || normalized.startsWith('abab')) return 'minimax';
    if (normalized.includes('seedance') || normalized.startsWith('doubao-seedance')) return 'seedance';
    if (normalized.includes('runway') || normalized.startsWith('gen4') || normalized.startsWith('gen3a')) return 'runway';
    if (normalized.includes('kling')) return 'kling';
    if (normalized.startsWith('stable-image-') || normalized.startsWith('stable-diffusion-') || normalized.startsWith('sdxl')) return 'stability';
    if (normalized.startsWith('fal-ai/')) return 'fal';
    if (normalized.startsWith('eleven_') || normalized.startsWith('scribe_')) return 'elevenlabs';
    if (normalized.startsWith('kimi-')) return 'moonshot';
    if (normalized.includes('qwen')) return 'qwen';
    if (normalized.includes('gemini')) return 'google';
    return 'other';
  }

  private inferModelType(modelName: string, provider?: string | null, sdkType?: string | null): string {
    const normalized = modelName.toLowerCase();
    if (this.isVideoModel(modelName, provider, sdkType)) return 'video';
    if (this.isImageModel(modelName, provider, sdkType)) return 'image';
    if (this.isAudioModel(modelName, provider, sdkType)) return 'audio';
    if (normalized.includes('embedding') || normalized.includes('embed')) return 'embedding';
    if (normalized.includes('rerank')) return 'rerank';
    return 'chat';
  }

  private inferPricingUnit(modelName: string, provider?: string | null, sdkType?: string | null): string {
    const type = this.inferModelType(modelName, provider, sdkType);
    if (type === 'video') return 'video_task';
    if (type === 'image') return 'image';
    if (type === 'audio') {
      if (this.isTtsModel(modelName, provider, sdkType)) return 'character';
      if (this.isSttModel(modelName, provider, sdkType)) return 'audio_minute';
      if (this.isMiniMaxMusicModel(modelName, provider, sdkType)) return 'request';
      return 'audio_second';
    }
    if (type === 'rerank') return 'request';
    return 'token_1m';
  }

  private inferInputModalities(modelName: string, provider?: string | null, sdkType?: string | null): string[] {
    const type = this.inferModelType(modelName, provider, sdkType);
    if (type === 'video') {
      if (this.isSeedanceVideoModel(modelName, provider, sdkType)) return ['text', 'image', 'video', 'audio'];
      return ['text', 'image'];
    }
    if (type === 'image') return ['text', 'image'];
    if (type === 'audio') {
      if (this.isSttModel(modelName, provider, sdkType)) return ['audio'];
      if (this.isMiniMaxMusicModel(modelName, provider, sdkType)) return ['text', 'audio'];
      return ['text', 'audio'];
    }
    if (type === 'embedding' || type === 'rerank') return ['text'];
    if (this.isAnthropicChatModel(modelName, provider, sdkType)) return ['text', 'image'];
    return ['text'];
  }

  private inferOutputModalities(modelName: string, provider?: string | null, sdkType?: string | null): string[] {
    const type = this.inferModelType(modelName, provider, sdkType);
    if (type === 'video') {
      if (this.isSeedanceVideoModel(modelName, provider, sdkType)) return ['video', 'audio'];
      return ['video'];
    }
    if (type === 'image') return ['image'];
    if (type === 'audio') {
      if (this.isSttModel(modelName, provider, sdkType)) return ['text'];
      return ['audio'];
    }
    if (type === 'embedding') return ['embedding'];
    return ['text'];
  }

  private inferSupportedFeatures(modelName: string, provider?: string | null, sdkType?: string | null): string[] {
    const type = this.inferModelType(modelName, provider, sdkType);
    if (type === 'video') {
      const features = new Set(['video_generation', 'async_task', 't2v', 'i2v', 'first_last_frame']);
      if (this.isMinimaxVideoModel(modelName, provider, sdkType)) {
        features.add('subject_reference');
      }
      if (this.isSeedanceVideoModel(modelName, provider, sdkType)) {
        features.add('audio_generation');
        features.add('reference_to_video');
        features.add('video_edit');
        features.add('video_extend');
      }
      return Array.from(features);
    }
    if (type === 'image') {
      const features = new Set(['image_generation', 'text_to_image']);
      if (this.isOpenAiImageModel(modelName, provider, sdkType)) {
        features.add('image_edit');
        features.add('image_variation');
      }
      if (this.isMiniMaxImageModel(modelName, provider, sdkType)) {
        features.add('subject_reference');
      }
      if (this.isStabilityImageModel(modelName, provider, sdkType)) {
        features.add('image_edit');
        features.add('image_upscale');
        features.add('image_control');
      }
      if (this.isFalImageModel(modelName, provider, sdkType)) {
        features.add('image_edit');
      }
      return Array.from(features);
    }
    if (type === 'audio') {
      const features = new Set(['audio_generation']);
      if (this.isTtsModel(modelName, provider, sdkType)) {
        features.add('tts');
        features.add('text_to_speech');
        features.add('streaming');
      }
      if (this.isSttModel(modelName, provider, sdkType)) {
        features.add('stt');
        features.add('speech_to_text');
        features.add('timestamps');
      }
      if (this.isOpenAiAudioModel(modelName, provider, sdkType) && modelName.toLowerCase().includes('diarize')) {
        features.add('diarization');
      }
      if (this.isElevenLabsAudioModel(modelName, provider, sdkType)) {
        features.add('speech_to_speech');
        features.add('voice_clone');
      }
      if (this.isMiniMaxSpeechModel(modelName, provider, sdkType)) {
        features.add('voice_clone');
        features.add('voice_design');
      }
      if (this.isMiniMaxMusicModel(modelName, provider, sdkType)) {
        features.add('music_generation');
      }
      return Array.from(features);
    }
    if (type === 'embedding') return ['embedding'];
    if (type === 'rerank') return ['rerank'];
    if (this.isAnthropicChatModel(modelName, provider, sdkType)) {
      return ['function_call', 'function_tools', 'streaming', 'streaming_tools', 'reasoning', 'vision'];
    }
    if (this.isCodexResponsesModel(modelName, provider, sdkType)) {
      return ['function_call', 'function_tools', 'streaming', 'streaming_tools', 'reasoning'];
    }
    return [];
  }

  private inferPricingMetadata(
    modelName: string,
    provider?: string | null,
    sdkType?: string | null,
  ): Record<string, unknown> | null {
    if (this.isImageModel(modelName, provider, sdkType)) {
      const providerFamily = this.isOpenAiImageModel(modelName, provider, sdkType)
        ? 'openai'
        : this.isMiniMaxImageModel(modelName, provider, sdkType)
          ? 'minimax'
          : this.isStabilityImageModel(modelName, provider, sdkType)
            ? 'stability'
            : this.isFalImageModel(modelName, provider, sdkType)
              ? 'fal'
              : this.inferModelProvider(modelName, provider, sdkType);
      const taskTypes = new Set(['text_to_image']);
      if (this.isOpenAiImageModel(modelName, provider, sdkType)) {
        taskTypes.add('image_edit');
        taskTypes.add('image_variation');
      }
      if (this.isMiniMaxImageModel(modelName, provider, sdkType)) {
        taskTypes.add('subject_reference_to_image');
      }
      if (this.isStabilityImageModel(modelName, provider, sdkType)) {
        taskTypes.add('image_edit');
        taskTypes.add('image_upscale');
        taskTypes.add('image_control');
      }
      if (this.isFalImageModel(modelName, provider, sdkType)) {
        taskTypes.add('image_edit');
      }
      const providerEndpoints = this.isOpenAiImageModel(modelName, provider, sdkType)
        ? {
            generate: '/v1/images/generations',
            edit: '/v1/images/edits',
            variation: '/v1/images/variations',
          }
        : this.isMiniMaxImageModel(modelName, provider, sdkType)
          ? { generate: '/v1/image_generation' }
          : this.isStabilityImageModel(modelName, provider, sdkType)
            ? {
                generate: '/v2beta/stable-image/generate',
                edit: '/v2beta/stable-image/edit',
                upscale: '/v2beta/stable-image/upscale',
                control: '/v2beta/stable-image/control',
              }
            : this.isFalImageModel(modelName, provider, sdkType)
              ? { generate: modelName }
              : { generate: '/v1/images/generations' };
      return {
        schemaVersion: 'image-generation.v1',
        providerFamily,
        gatewayProtocol: 'image_generation.v1',
        taskTypes: Array.from(taskTypes),
        inputs: {
          text: true,
          image: true,
          mask: taskTypes.has('image_edit'),
          roles: ['source', 'mask', 'style', 'subject_reference', 'structure_reference'],
        },
        outputs: {
          image: true,
          formats: ['png', 'jpeg', 'webp'],
        },
        constraints: {
          sizes: ['1024x1024', '1024x1536', '1536x1024'],
          aspectRatios: ['1:1', '16:9', '9:16'],
          qualities: ['low', 'medium', 'high', 'auto'],
          responseFormats: ['url', 'b64_json'],
        },
        providerEndpoints,
        billing: {
          unit: 'image',
          metering: ['image', 'size', 'quality', 'token'],
        },
      };
    }

    if (this.isAudioModel(modelName, provider, sdkType)) {
      const providerFamily = this.isElevenLabsAudioModel(modelName, provider, sdkType)
        ? 'elevenlabs'
        : this.isMiniMaxSpeechModel(modelName, provider, sdkType) || this.isMiniMaxMusicModel(modelName, provider, sdkType)
          ? 'minimax'
          : this.isOpenAiAudioModel(modelName, provider, sdkType)
            ? 'openai'
            : this.inferModelProvider(modelName, provider, sdkType);
      const taskTypes = new Set<string>();
      if (this.isTtsModel(modelName, provider, sdkType)) taskTypes.add('text_to_speech');
      if (this.isSttModel(modelName, provider, sdkType)) {
        taskTypes.add('speech_to_text');
        if (providerFamily === 'openai') taskTypes.add('speech_translation');
      }
      if (this.isElevenLabsAudioModel(modelName, provider, sdkType)) taskTypes.add('speech_to_speech');
      if (this.isMiniMaxMusicModel(modelName, provider, sdkType)) {
        taskTypes.add('music_generation');
        taskTypes.add('music_cover');
      }
      if (taskTypes.size === 0) taskTypes.add('audio_generation');
      const unit = this.inferPricingUnit(modelName, provider, sdkType);
      const providerEndpoints = providerFamily === 'openai'
        ? {
            speech: '/v1/audio/speech',
            transcription: '/v1/audio/transcriptions',
            translation: '/v1/audio/translations',
          }
        : providerFamily === 'elevenlabs'
          ? {
              speech: '/v1/text-to-speech/{voice_id}',
              speechStream: '/v1/text-to-speech/{voice_id}/stream',
              transcription: '/v1/speech-to-text',
              speechToSpeech: '/v1/speech-to-speech/{voice_id}',
              models: '/v1/models',
            }
          : this.isMiniMaxMusicModel(modelName, provider, sdkType)
            ? { musicGeneration: '/v1/music_generation' }
            : this.isMiniMaxSpeechModel(modelName, provider, sdkType)
              ? {
                  speech: '/v1/t2a_v2',
                  speechAsyncCreate: '/v1/t2a_async_v2',
                  voiceClone: '/v1/voice_clone',
                }
              : {};
      return {
        schemaVersion: 'audio.v1',
        providerFamily,
        gatewayProtocol: 'audio.v1',
        taskTypes: Array.from(taskTypes),
        inputs: {
          text: taskTypes.has('text_to_speech') || taskTypes.has('music_generation'),
          audio: taskTypes.has('speech_to_text') || taskTypes.has('speech_to_speech') || taskTypes.has('music_cover'),
          voice: taskTypes.has('text_to_speech') || taskTypes.has('speech_to_speech'),
          lyrics: taskTypes.has('music_generation'),
        },
        outputs: {
          audio: !taskTypes.has('speech_to_text') || taskTypes.has('text_to_speech'),
          text: taskTypes.has('speech_to_text'),
          timestamps: taskTypes.has('speech_to_text'),
          formats: ['mp3', 'wav', 'pcm', 'flac', 'opus', 'ulaw'],
        },
        constraints: {
          maxCharacters: providerFamily === 'minimax' ? 10000 : providerFamily === 'elevenlabs' ? 10000 : undefined,
          responseFormats: ['mp3', 'wav', 'json', 'text', 'verbose_json', 'srt', 'vtt'],
          streaming: true,
        },
        providerEndpoints,
        billing: {
          unit,
          metering: unit === 'character'
            ? ['character']
            : unit === 'audio_minute'
              ? ['audio_second', 'audio_minute']
              : ['request', 'audio_second'],
        },
      };
    }

    if (this.isMinimaxVideoModel(modelName, provider, sdkType)) {
      return {
        schemaVersion: 'video-generation.v1',
        providerFamily: 'minimax',
        gatewayProtocol: 'video_generation.v1',
        taskTypes: ['text_to_video', 'image_to_video', 'first_last_frame_to_video', 'subject_reference_to_video'],
        inputs: {
          text: true,
          image: true,
          roles: ['prompt', 'first_frame', 'last_frame', 'subject_reference'],
        },
        outputs: {
          video: true,
          formats: ['mp4'],
        },
        constraints: {
          durationSeconds: { values: [6] },
          resolutions: ['1080P'],
        },
        providerEndpoints: {
          createTask: '/v1/video_generation',
          queryTask: '/v1/query/video_generation',
          retrieveFile: '/v1/files/retrieve',
        },
        status: {
          pollIntervalSeconds: 10,
          timeoutSeconds: 1800,
        },
        billing: {
          unit: 'video_task',
          metering: ['task'],
        },
      };
    }

    if (this.isSeedanceVideoModel(modelName, provider, sdkType)) {
      return {
        schemaVersion: 'video-generation.v1',
        providerFamily: 'seedance',
        gatewayProtocol: 'video_generation.v1',
        taskTypes: [
          'text_to_video',
          'image_to_video',
          'first_last_frame_to_video',
          'reference_to_video',
          'video_edit',
          'video_extend',
        ],
        inputs: {
          text: true,
          image: true,
          video: true,
          audio: true,
          maxImages: 9,
          maxVideos: 3,
          maxAudios: 3,
          roles: ['prompt', 'first_frame', 'last_frame', 'reference', 'reference_audio', 'source_video'],
        },
        outputs: {
          video: true,
          audio: true,
          formats: ['mp4'],
        },
        constraints: {
          durationSeconds: { min: 4, max: 15 },
          resolutions: modelName.includes('fast') ? ['480p', '720p'] : ['480p', '720p', '1080p'],
          aspectRatios: ['16:9', '9:16', '1:1'],
          fps: [24],
        },
        providerEndpoints: {
          createTask: '/api/v3/contents/generations/tasks',
          queryTask: '/api/v3/contents/generations/tasks/{task_id}',
          listTasks: '/api/v3/contents/generations/tasks',
          cancelTask: '/api/v3/contents/generations/tasks/{task_id}',
        },
        status: {
          pollIntervalSeconds: 10,
          timeoutSeconds: 1800,
        },
        billing: {
          unit: 'video_task',
          metering: ['task', 'duration_seconds', 'token'],
        },
      };
    }

    if (this.isRunwayVideoModel(modelName, provider, sdkType)) {
      return {
        schemaVersion: 'video-generation.v1',
        providerFamily: 'runway',
        gatewayProtocol: 'video_generation.v1',
        taskTypes: ['text_to_video', 'image_to_video'],
        inputs: {
          text: true,
          image: true,
          video: true,
          roles: ['prompt', 'first_frame', 'reference', 'source_video'],
        },
        outputs: {
          video: true,
          formats: ['mp4'],
        },
        providerEndpoints: {
          imageToVideo: '/v1/image_to_video',
        },
        providerHeaders: {
          'X-Runway-Version': '2024-11-06',
        },
        status: {
          pollIntervalSeconds: 10,
          timeoutSeconds: 1800,
        },
        billing: {
          unit: 'video_task',
          metering: ['task', 'duration_seconds'],
        },
      };
    }

    if (this.isKlingVideoModel(modelName, provider, sdkType)) {
      return {
        schemaVersion: 'video-generation.v1',
        providerFamily: 'kling',
        gatewayProtocol: 'video_generation.v1',
        taskTypes: ['text_to_video', 'image_to_video', 'first_last_frame_to_video', 'reference_to_video'],
        inputs: {
          text: true,
          image: true,
          video: true,
          mask: true,
          roles: ['prompt', 'first_frame', 'last_frame', 'reference', 'source_video', 'mask'],
        },
        outputs: {
          video: true,
          audio: true,
          formats: ['mp4'],
        },
        constraints: {
          qualityModes: ['standard', 'pro'],
          aspectRatios: ['16:9', '9:16', '1:1'],
        },
        billing: {
          unit: 'video_task',
          metering: ['task', 'duration_seconds'],
        },
      };
    }

    return null;
  }

  private async notifyAllProductWebhook(changeType: string): Promise<void> {
    try {
      await this.productSync.notifyAllProductSaas(changeType);
    } catch { /* non-critical */ }
  }
}
