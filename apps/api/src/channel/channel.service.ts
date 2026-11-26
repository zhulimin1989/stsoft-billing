import { BadRequestException, Injectable, NotFoundException, Logger, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { DecryptCommand, EncryptCommand, KMSClient } from '@aws-sdk/client-kms';
import { Prisma } from '@prisma/client';
import { DEDICATED_PROTOCOL_CHANNELS } from '@raytone-lab/publisher-contracts';
import { ChannelRecord, ChannelRepository } from './channel.repository';
import { AlertEventService } from '../alert-events/alert-events.service';
import { decrypt, mask } from '../common/utils/crypto';
import {
  decryptGatewayLocalSecret,
  encryptGatewayLocalSecret,
  isGatewayLocalSecret,
  resolveGatewayLocalSecret,
} from '../common/utils/gateway-secret';
import { assertSafeExternalUrl } from '../common/utils/url-guard.util';
import { resolveEncryptionKey } from '../common/utils/encryption-key';
import { parseStringArrayJson } from '../common/utils/json-array.util';
import { ProductSyncNotifier } from '../integration/product-sync-notifier';
import { parseModelConfigs, validateModelConfigs } from './model-configs';
import { PublisherSyncService } from '../publisher/publisher-sync.service';
import type { PublisherSyncDispatchResult } from '../publisher/publisher-sync-job.service';
import { hasStrictDedicatedProviderIsolation } from '../publisher/provider-isolation.policy';
import { ProviderAccountIdentityService } from '../provider-account-identity/provider-account-identity.service';
import {
  apiTypesForProviderSdk,
  buildProtocolPathsFromServedInboundProtocols,
  defaultClientCompatibilityForProfile,
  defaultProtocolPathsForProfile,
  defaultServedInboundProtocolsForProfile,
  defaultTokenCountStrategyForProfile,
  getChannelProtocolTemplates,
  inferProviderProfile,
  isCatalogOnlySdkType,
  normalizeChannelSdkTypeValue,
  normalizeClientCompatibilityListValue,
  normalizeProtocolPathListValue,
  normalizeProviderProfileValue,
  normalizeServedInboundProtocolListValue,
  normalizeTokenCountStrategyValue,
  providerIdFromCode,
  runtimeSdkType,
  type ChannelProtocolTemplatesResponse,
  type RuntimeProtocolPath,
  type ServedInboundProtocol,
  servedInboundProtocolsForProtocolPaths,
} from '../publisher/publisher-runtime-registry';
import { SEEDANCE_CATALOG_MODELS } from '../publisher/seedance-runtime';
const ANTHROPIC_TEST_MODEL = 'claude-haiku-4-5-20251001';
const DEDICATED_CLIENT_PROTOCOLS = new Set(['anthropic', 'openai', 'responses']);
const DEDICATED_PROTOCOL_STRATEGIES = new Set<string>(DEDICATED_PROTOCOL_CHANNELS);
const MINIMAX_HAILUO_VIDEO_MODELS = [
  'MiniMax-Hailuo-2.3',
  'MiniMax-Hailuo-2.3-Fast',
  'MiniMax-Hailuo-02',
  'S2V-01',
];
const SEEDANCE_VIDEO_MODELS = SEEDANCE_CATALOG_MODELS;

type ChannelPublisherSync =
  | {
      ok: true;
      status: 'ACCEPTED';
      idempotencyKey: string;
      warnings?: unknown[];
    }
  | {
      ok: false;
      status: 'PENDING' | 'FAILED' | 'DISABLED';
      idempotencyKey?: string;
      error: string;
    };
const RUNWAY_VIDEO_MODELS = [
  'gen4.5',
  'gen4_turbo',
  'gen3a_turbo',
  'veo3.1',
  'veo3.1_fast',
  'veo3',
];
const OPENAI_IMAGE_MODELS = [
  'gpt-image-2',
  'gpt-image-1.5',
  'gpt-image-1',
  'gpt-image-1-mini',
];
const MINIMAX_IMAGE_MODELS = ['image-01'];
const STABILITY_IMAGE_MODELS = [
  'stable-image-core',
  'stable-image-ultra',
  'stable-diffusion-3.5-large',
  'stable-diffusion-3.5-large-turbo',
  'stable-diffusion-3.5-medium',
  'stable-diffusion-3.5-flash',
  'sdxl-1.0',
];
const OPENAI_AUDIO_MODELS = [
  'gpt-4o-mini-tts',
  'gpt-4o-transcribe',
  'gpt-4o-mini-transcribe',
  'gpt-4o-transcribe-diarize',
  'whisper-1',
];
const ELEVENLABS_AUDIO_MODELS = [
  'eleven_v3',
  'eleven_multilingual_v2',
  'eleven_flash_v2_5',
  'eleven_turbo_v2_5',
  'scribe_v2',
  'scribe_v1',
  'eleven_multilingual_sts_v2',
];
const MINIMAX_SPEECH_MODELS = [
  'speech-2.8-hd',
  'speech-2.8-turbo',
  'speech-2.6-hd',
  'speech-2.6-turbo',
  'speech-02-hd',
  'speech-02-turbo',
];
const MINIMAX_MUSIC_MODELS = [
  'music-2.6',
  'music-cover',
  'music-2.6-free',
  'music-cover-free',
];

type UpstreamRequestCandidate = {
  url: string;
  method?: 'GET' | 'POST';
  headers: Record<string, string>;
  body?: string;
};

@Injectable()
export class ChannelService {
  private readonly logger = new Logger(ChannelService.name);
  private readonly encryptionKey: string;
  private readonly gatewayLocalSecret: string;
  private readonly secretEncryptionMode: 'local' | 'kms';
  private readonly kmsKeyId: string;
  private readonly kmsClient: KMSClient | null;

  constructor(
    private readonly channelRepository: ChannelRepository,
    private readonly configService: ConfigService,
    private readonly providerAccountIdentities: ProviderAccountIdentityService,
    // P2-A2: 可选 inject — 现有 ChannelService SSRF / admin 测试不 wire
    // AlertEventsModule,@Optional 让它们继续过。
    @Optional() private readonly alertEvents?: AlertEventService,
    @Optional() private readonly productSync?: ProductSyncNotifier,
    @Optional() private readonly publisherSync?: PublisherSyncService,
  ) {
    // Production: throws if key missing/malformed. Non-prod: empty string → plaintext.
    this.encryptionKey = resolveEncryptionKey(this.configService);
    this.gatewayLocalSecret = resolveGatewayLocalSecret(this.configService);
    this.secretEncryptionMode = this.resolveSecretEncryptionMode();
    this.kmsKeyId = this.resolveKmsKeyId();
    this.kmsClient = this.secretEncryptionMode === 'kms'
      ? new KMSClient({
          region: this.firstConfig('CHANNEL_KMS_REGION', 'AWS_REGION') || undefined,
          endpoint: this.firstConfig('CHANNEL_KMS_ENDPOINT') || undefined,
        })
      : null;
  }

  getProtocolTemplates(): ChannelProtocolTemplatesResponse {
    return getChannelProtocolTemplates();
  }

  private async encryptApiKey(apiKey: string): Promise<string> {
    if (this.isGatewaySecretPayload(apiKey)) return apiKey;
    if (this.secretEncryptionMode === 'kms') {
      return this.encryptApiKeyWithKms(apiKey);
    }
    if (!this.gatewayLocalSecret) return apiKey;
    return encryptGatewayLocalSecret(apiKey, this.gatewayLocalSecret);
  }

  private async encryptApiKeyWithKms(apiKey: string): Promise<string> {
    if (!this.kmsClient || !this.kmsKeyId) {
      throw new BadRequestException('KMS 未配置，无法加密 API Key');
    }
    try {
      const result = await this.kmsClient.send(new EncryptCommand({
        KeyId: this.kmsKeyId,
        Plaintext: Buffer.from(apiKey, 'utf8'),
      }));
      if (!result.CiphertextBlob) {
        throw new Error('KMS Encrypt returned empty CiphertextBlob');
      }
      return `enc:${Buffer.from(result.CiphertextBlob).toString('base64')}`;
    } catch (err) {
      this.logger.error(
        `channel apiKey KMS encrypt failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new BadRequestException('API Key KMS 加密失败');
    }
  }

  private async decryptApiKeyForUpstream(encrypted: string): Promise<string> {
    const decrypted = this.decryptApiKey(encrypted);
    if (decrypted !== encrypted || !this.isGatewaySecretPayload(encrypted)) {
      return decrypted;
    }
    return this.decryptApiKeyWithKms(encrypted);
  }

  private async decryptApiKeyWithKms(encrypted: string): Promise<string> {
    if (!this.kmsClient) {
      throw new BadRequestException('API Key 是 KMS 密文，但当前未启用 KMS 解密');
    }
    const payload = encrypted.slice('enc:'.length).trim();
    if (!payload) {
      throw new BadRequestException('API Key KMS 密文为空');
    }
    try {
      const result = await this.kmsClient.send(new DecryptCommand({
        CiphertextBlob: Buffer.from(payload, 'base64'),
        ...(this.kmsKeyId ? { KeyId: this.kmsKeyId } : {}),
      }));
      if (!result.Plaintext) {
        throw new Error('KMS Decrypt returned empty Plaintext');
      }
      return Buffer.from(result.Plaintext).toString('utf8');
    } catch (err) {
      this.logger.error(
        `channel apiKey KMS decrypt failed: ${err instanceof Error ? err.message : String(err)}`,
      );
      throw new BadRequestException('API Key KMS 解密失败');
    }
  }

  private decryptApiKey(encrypted: string): string {
    if (isGatewayLocalSecret(encrypted)) {
      const decrypted = this.tryDecryptGatewayLocalApiKey(encrypted);
      if (decrypted !== null) return decrypted;
      return encrypted;
    }
    if (this.isGatewaySecretPayload(encrypted)) return encrypted;
    if (!this.encryptionKey) return encrypted;
    try {
      return decrypt(encrypted, this.encryptionKey);
    } catch {
      // 兼容未加密的历史数据
      return encrypted;
    }
  }

  private isMaskedApiKey(apiKey: string): boolean {
    return /[*•]/.test(apiKey);
  }

  private tryDecryptGatewayLocalApiKey(encrypted: string): string | null {
    for (const secret of [this.gatewayLocalSecret, this.encryptionKey]) {
      if (!secret) continue;
      try {
        return decryptGatewayLocalSecret(encrypted, secret);
      } catch {
        // Try the next configured secret. Existing rows may have been encrypted
        // with ENCRYPTION_KEY before KMS_HMAC_SECRET was configured separately.
      }
    }
    return null;
  }

  private isGatewaySecretPayload(apiKey: string): boolean {
    return apiKey.startsWith('enc:');
  }

  private normalizeChannelSdkType(value: unknown, provider: string | null | undefined): string {
    try {
      return normalizeChannelSdkTypeValue(value, provider);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  private normalizeChannelProviderProfile(value: unknown): string | null | undefined {
    if (value === undefined) return undefined;
    try {
      return normalizeProviderProfileValue(value);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  private normalizeChannelClientCompatibility(
    value: unknown,
    profile: string | null | undefined,
  ): string | null | undefined {
    if (value === undefined) return undefined;
    try {
      const providerProfile = profile ? normalizeProviderProfileValue(profile) : null;
      const normalized = normalizeClientCompatibilityListValue(value, providerProfile);
      return normalized?.length ? JSON.stringify(normalized) : null;
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  private normalizeChannelServedInboundProtocols(
    value: unknown,
    profile: string | null | undefined,
  ): string | null | undefined {
    if (value === undefined) return undefined;
    try {
      const normalized = normalizeServedInboundProtocolListValue(value);
      if (!normalized?.length) return null;
      return JSON.stringify(normalized);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  private normalizeChannelProtocolPaths(
    value: unknown,
  ): RuntimeProtocolPath[] | null | undefined {
    try {
      return normalizeProtocolPathListValue(value);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  private servedInboundProtocolInput(data: Record<string, unknown>): { present: boolean; value: unknown } {
    if (Object.prototype.hasOwnProperty.call(data, 'servedInboundProtocols')) {
      return { present: true, value: data.servedInboundProtocols };
    }
    if (Object.prototype.hasOwnProperty.call(data, 'served_inbound_protocols')) {
      return { present: true, value: data.served_inbound_protocols };
    }
    return { present: false, value: undefined };
  }

  private protocolPathInput(data: Record<string, unknown>): { present: boolean; value: unknown } {
    if (Object.prototype.hasOwnProperty.call(data, 'protocolPaths')) {
      return { present: true, value: data.protocolPaths };
    }
    if (Object.prototype.hasOwnProperty.call(data, 'protocol_paths')) {
      return { present: true, value: data.protocol_paths };
    }
    if (Object.prototype.hasOwnProperty.call(data, 'paths')) {
      return { present: true, value: data.paths };
    }
    return { present: false, value: undefined };
  }

  private protocolPathsStorage(
    paths: RuntimeProtocolPath[] | null | undefined,
  ): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput | undefined {
    if (paths === undefined) return undefined;
    if (!paths || paths.length === 0) return Prisma.JsonNull;
    return paths as unknown as Prisma.InputJsonArray;
  }

  private servedInboundProtocolsStorageFromPaths(paths: RuntimeProtocolPath[]): string | null {
    const protocols = servedInboundProtocolsForProtocolPaths(paths);
    return protocols.length ? JSON.stringify(protocols) : null;
  }

  private protocolPathsForServedInboundProtocols(
    value: string | null | undefined,
    profile: string | null | undefined,
  ): RuntimeProtocolPath[] | null {
    const protocols = normalizeServedInboundProtocolListValue(value);
    if (!protocols?.length) return null;
    const providerProfile = profile ? normalizeProviderProfileValue(profile) : null;
    return buildProtocolPathsFromServedInboundProtocols(protocols, providerProfile);
  }

  private defaultProtocolPathsStorage(
    profile: string | null | undefined,
  ): Prisma.InputJsonValue | Prisma.NullableJsonNullValueInput {
    const providerProfile = profile ? normalizeProviderProfileValue(profile) : null;
    return defaultProtocolPathsForProfile(providerProfile) as unknown as Prisma.InputJsonArray;
  }

  private normalizeChannelTokenCountStrategy(
    value: unknown,
    profile: string | null | undefined,
  ): string | null | undefined {
    if (value === undefined) return undefined;
    try {
      const providerProfile = profile ? normalizeProviderProfileValue(profile) : null;
      return normalizeTokenCountStrategyValue(value, providerProfile);
    } catch (err) {
      throw new BadRequestException((err as Error).message);
    }
  }

  private normalizeOwnedBy(value: unknown): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    if (typeof value !== 'string') throw new BadRequestException('ownedBy 必须是字符串');
    const normalized = value.trim();
    return normalized || null;
  }

  private normalizeProviderAccountIdentityId(value: unknown): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null) return null;
    if (typeof value !== 'string' || !value.trim()) {
      throw new BadRequestException('providerAccountIdentityId 必须是非空字符串或 null');
    }
    return value.trim();
  }

  private async assertProviderAccountIdentityCanBeEmpty(channelId: string): Promise<void> {
    const bindings = await this.channelRepository.findProductChannelBindings(channelId);
    const runtimeBindings = bindings.filter(
      (binding) => !hasStrictDedicatedProviderIsolation(binding.metadata),
    );
    if (runtimeBindings.length === 0) return;
    throw new BadRequestException(
      `渠道已绑定运行时 ProductChannel（${runtimeBindings.map((item) => item.id).join(', ')}），必须先绑定供应商账户身份，不能以空身份保存`,
    );
  }

  private normalizeDedicatedClientProtocol(value: unknown): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    if (typeof value !== 'string') throw new BadRequestException('dedicatedClientProtocol 必须是字符串');
    const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!normalized) return null;
    if (!DEDICATED_CLIENT_PROTOCOLS.has(normalized)) {
      throw new BadRequestException('dedicatedClientProtocol 只支持 anthropic / openai / responses');
    }
    return normalized;
  }

  private normalizeDedicatedProtocolStrategy(value: unknown): string | null | undefined {
    if (value === undefined) return undefined;
    if (value === null || value === '') return null;
    if (typeof value !== 'string') throw new BadRequestException('dedicatedProtocolStrategy 必须是字符串');
    const normalized = value.trim().toLowerCase().replace(/[\s-]+/g, '_');
    if (!normalized) return null;
    if (!DEDICATED_PROTOCOL_STRATEGIES.has(normalized)) {
      throw new BadRequestException('dedicatedProtocolStrategy 只支持 passthrough / responses_to_chat / anthropic_to_chat');
    }
    return normalized;
  }

  private resolveChannelProviderProfile(
    provider: string,
    sdkType: string,
    explicitValue?: unknown,
  ): string | null {
    if (explicitValue !== undefined) {
      const explicit = this.normalizeChannelProviderProfile(explicitValue);
      return explicit ?? null;
    }
    const providerCode = providerIdFromCode(provider);
    return inferProviderProfile(providerCode, apiTypesForProviderSdk(providerCode, sdkType));
  }

  private defaultClientCompatibilityStorage(profile: string | null | undefined): string | null {
    if (!profile) return null;
    return JSON.stringify(defaultClientCompatibilityForProfile(normalizeProviderProfileValue(profile)));
  }

  private defaultServedInboundProtocolsStorage(profile: string | null | undefined): string | null {
    if (!profile) return null;
    return JSON.stringify(defaultServedInboundProtocolsForProfile(normalizeProviderProfileValue(profile)));
  }

  private defaultTokenCountStrategyStorage(profile: string | null | undefined): string | null {
    if (!profile) return null;
    return defaultTokenCountStrategyForProfile(normalizeProviderProfileValue(profile)) ?? null;
  }

  private isAnthropicSdk(sdkType: string): boolean {
    return sdkType === 'anthropic' || sdkType === 'anthropic_native';
  }

  private isGeminiSdk(sdkType: string): boolean {
    return sdkType === 'gemini' || sdkType === 'gemini_native' || sdkType === 'google';
  }

  private resolveSecretEncryptionMode(): 'local' | 'kms' {
    const raw = this.firstConfig('CHANNEL_SECRET_ENCRYPTION_MODE', 'UPSTREAM_KEY_SECRET_MODE').toLowerCase();
    if (raw === 'kms' || raw === 'aws-kms') return 'kms';
    if (this.firstConfig('CHANNEL_USE_KMS').toLowerCase() === 'true') return 'kms';
    return 'local';
  }

  private resolveKmsKeyId(): string {
    if (this.secretEncryptionMode !== 'kms') return '';
    const keyId = this.firstConfig('CHANNEL_KMS_KEY_ID', 'UPSTREAM_KEY_KMS_KEY_ID', 'AWS_KMS_KEY_ID');
    if (!keyId) {
      throw new Error('CHANNEL_KMS_KEY_ID is required when CHANNEL_SECRET_ENCRYPTION_MODE=kms');
    }
    return keyId;
  }

  private firstConfig(...keys: string[]): string {
    for (const key of keys) {
      const raw = this.configService.get<string>(key);
      if (typeof raw === 'string' && raw.trim()) return raw.trim();
    }
    return '';
  }

  private async notifyChannelsChanged(): Promise<ChannelPublisherSync | null> {
    const tasks: Promise<unknown>[] = [];
    if (this.productSync) {
      tasks.push(this.productSync.notifyAllProductSaas('channels_changed'));
    }
    let publisherTaskIndex = -1;
    if (this.publisherSync) {
      publisherTaskIndex = tasks.length;
      const publisherTask = this.publisherSync.syncOpsTopologyFreshDetailed();
      tasks.push(publisherTask);
    }

    const results = await Promise.allSettled(tasks);
    results.forEach((result) => {
      if (result.status !== 'rejected') return;
      const err = result.reason;
      const message = err instanceof Error ? err.message : String(err);
      this.logger.warn(`channel change notification failed: ${message}`);
    });
    if (publisherTaskIndex < 0) return null;
    const result = results[publisherTaskIndex] as PromiseSettledResult<PublisherSyncDispatchResult>;
    if (result.status === 'fulfilled') {
      return this.publisherSyncResult(result.value);
    }
    const message = result.reason instanceof Error ? result.reason.message : String(result.reason);
    return { ok: false, status: 'FAILED', error: message };
  }

  private publisherSyncResult(result: PublisherSyncDispatchResult): ChannelPublisherSync {
    if (result.accepted) {
      return {
        ok: true,
        status: 'ACCEPTED',
        idempotencyKey: result.idempotencyKey,
        ...(result.response?.warnings?.length ? { warnings: result.response.warnings } : {}),
      };
    }
    return {
      ok: false,
      status: result.status === 'ACCEPTED' ? 'FAILED' : result.status,
      idempotencyKey: result.idempotencyKey,
      error: result.error ?? 'Publisher 同步未被接收',
    };
  }

  private maskChannel(channel: ChannelRecord): ChannelRecord & { apiKeyMasked: string } {
    const decrypted = this.decryptApiKey(channel.apiKey);
    const masked = mask(decrypted);
    return {
      ...channel,
      apiKey: masked,
      apiKeyMasked: masked,
    };
  }

  async findAll(page: number, pageSize: number) {
    const [items, total] = await Promise.all([
      this.channelRepository.findAll((page - 1) * pageSize, pageSize),
      this.channelRepository.count(),
    ]);
    return {
      items: items.map((ch) => {
        const decrypted = this.decryptApiKey(ch.apiKey);
        return { ...ch, apiKey: mask(decrypted), apiKeyMasked: mask(decrypted) };
      }),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async findById(id: string) {
    const channel = await this.channelRepository.findById(id);
    if (!channel) throw new NotFoundException('渠道不存在');
    return this.maskChannel(channel);
  }

  /** 内部使用 — 返回解密后的原始 apiKey（用于 test/findByModel） */
  private async findByIdInternal(id: string) {
    const channel = await this.channelRepository.findById(id);
    if (!channel) throw new NotFoundException('渠道不存在');
    return { ...channel, apiKey: this.decryptApiKey(channel.apiKey) };
  }

  private async findByIdForUpstreamRequest(id: string) {
    const channel = await this.channelRepository.findById(id);
    if (!channel) throw new NotFoundException('渠道不存在');
    return { ...channel, apiKey: await this.decryptApiKeyForUpstream(channel.apiKey) };
  }

  async create(data: {
    name: string;
    provider: string;
    providerAccountIdentityId?: string | null;
    baseUrl: string;
    apiKey: string;
    models?: string;
    modelConfigs?: string;
    sdkType?: string;
    providerProfile?: string | null;
    clientCompatibility?: string | string[] | null;
    servedInboundProtocols?: string | string[] | null;
    served_inbound_protocols?: string | string[] | null;
    protocolPaths?: unknown;
    protocol_paths?: unknown;
    paths?: unknown;
    tokenCountStrategy?: string | null;
    ownedBy?: string | null;
    dedicatedClientProtocol?: string | null;
    dedicatedProtocolStrategy?: string | null;
    priority?: number;
    weight?: number;
    maxRpm?: number;
    maxTpm?: number;
    remark?: string;
  }) {
    const apiKey = data.apiKey.trim();
    if (!apiKey || this.isMaskedApiKey(apiKey)) {
      throw new BadRequestException('API Key 不能为空或脱敏值');
    }
    const duplicate = await this.channelRepository.findDuplicate({
      name: data.name,
      provider: data.provider,
      baseUrl: data.baseUrl,
    });
    if (duplicate) {
      throw new BadRequestException('同名同供应商同 Base URL 的渠道已存在');
    }
    const providerAccountIdentityId = this.normalizeProviderAccountIdentityId(
      data.providerAccountIdentityId,
    );
    if (providerAccountIdentityId) {
      await this.providerAccountIdentities.requireActiveForProvider(
        providerAccountIdentityId,
        data.provider,
      );
    }
    const normalizedConfigs =
      data.modelConfigs !== undefined ? validateModelConfigs(data.modelConfigs) : undefined;
    const sdkType = this.normalizeChannelSdkType(data.sdkType, data.provider);
    const providerProfile = this.resolveChannelProviderProfile(data.provider, sdkType, data.providerProfile);
    const clientCompatibility = data.clientCompatibility === undefined
      ? this.defaultClientCompatibilityStorage(providerProfile)
      : this.normalizeChannelClientCompatibility(data.clientCompatibility, providerProfile);
    const servedInboundProtocolInput = this.servedInboundProtocolInput(data as Record<string, unknown>);
    const protocolPathInput = this.protocolPathInput(data as Record<string, unknown>);
    const explicitProtocolPaths = protocolPathInput.present
      ? this.normalizeChannelProtocolPaths(protocolPathInput.value)
      : undefined;
    const servedInboundProtocols = explicitProtocolPaths?.length
      ? this.servedInboundProtocolsStorageFromPaths(explicitProtocolPaths)
      : servedInboundProtocolInput.present
      ? this.normalizeChannelServedInboundProtocols(servedInboundProtocolInput.value, providerProfile)
      : this.defaultServedInboundProtocolsStorage(providerProfile);
    const protocolPaths = explicitProtocolPaths?.length
      ? explicitProtocolPaths
      : this.protocolPathsForServedInboundProtocols(servedInboundProtocols, providerProfile)
        ?? defaultProtocolPathsForProfile(normalizeProviderProfileValue(providerProfile));
    const tokenCountStrategy = data.tokenCountStrategy === undefined
      ? this.defaultTokenCountStrategyStorage(providerProfile)
      : this.normalizeChannelTokenCountStrategy(data.tokenCountStrategy, providerProfile);
    const ownedBy = this.normalizeOwnedBy(data.ownedBy) ?? null;
    const dedicatedClientProtocol = this.normalizeDedicatedClientProtocol(data.dedicatedClientProtocol) ?? null;
    const dedicatedProtocolStrategy = dedicatedClientProtocol
      ? this.normalizeDedicatedProtocolStrategy(data.dedicatedProtocolStrategy) ?? null
      : null;
    const {
      served_inbound_protocols: _servedInboundProtocolsSnake,
      protocol_paths: _protocolPathsSnake,
      protocolPaths: _protocolPathsCamel,
      paths: _paths,
      ...channelData
    } = data;
    const created = await this.channelRepository.create({
      ...channelData,
      sdkType,
      providerProfile,
      clientCompatibility,
      servedInboundProtocols,
      protocolPaths: this.protocolPathsStorage(protocolPaths),
      tokenCountStrategy,
      ownedBy,
      dedicatedClientProtocol,
      dedicatedProtocolStrategy,
      providerAccountIdentityId: providerAccountIdentityId ?? null,
      apiKey: await this.encryptApiKey(apiKey),
      ...(normalizedConfigs !== undefined ? { modelConfigs: normalizedConfigs } : {}),
    });
    const publisherSync = await this.notifyChannelsChanged();
    return {
      ...this.maskChannel(created),
      ...(publisherSync ? { publisherSync } : {}),
    };
  }

  async update(id: string, data: Partial<{
    name: string;
    provider: string;
    providerAccountIdentityId: string | null;
    baseUrl: string;
    apiKey: string;
    models: string;
    modelConfigs: string | null;
    sdkType: string;
    providerProfile: string | null;
    clientCompatibility: string | null;
    servedInboundProtocols: string | string[] | null;
    served_inbound_protocols: string | string[] | null;
    protocolPaths: unknown;
    protocol_paths: unknown;
    paths: unknown;
    tokenCountStrategy: string | null;
    ownedBy: string | null;
    dedicatedClientProtocol: string | null;
    dedicatedProtocolStrategy: string | null;
    priority: number;
    weight: number;
    maxRpm: number | null;
    maxTpm: number | null;
    remark: string | null;
    isActive: boolean;
  }>) {
    const existing = await this.findByIdInternal(id);
    const updateData = { ...data } as Record<string, unknown>;
    if (typeof updateData.apiKey === 'string') {
      const apiKey = updateData.apiKey.trim();
      if (apiKey && !this.isMaskedApiKey(apiKey)) {
        updateData.apiKey = await this.encryptApiKey(apiKey);
      } else {
        delete updateData.apiKey;
      }
    } else {
      delete updateData.apiKey;
    }
    if ('modelConfigs' in updateData) {
      // null/'' 表示清空；其它值经严格校验后写入
      updateData.modelConfigs = validateModelConfigs(updateData.modelConfigs as string | null | undefined);
    }
    const providerChanged = Object.prototype.hasOwnProperty.call(updateData, 'provider');
    const sdkChanged = Object.prototype.hasOwnProperty.call(updateData, 'sdkType');
    const profileChanged = Object.prototype.hasOwnProperty.call(updateData, 'providerProfile');
    const servedInboundProtocolInput = this.servedInboundProtocolInput(updateData);
    const protocolPathInput = this.protocolPathInput(updateData);
    delete updateData.served_inbound_protocols;
    delete updateData.protocol_paths;
    delete updateData.protocolPaths;
    delete updateData.paths;
    const nextProvider = typeof updateData.provider === 'string' ? updateData.provider : existing.provider;
    const identityChanged = Object.prototype.hasOwnProperty.call(
      updateData,
      'providerAccountIdentityId',
    );
    const nextProviderAccountIdentityId = identityChanged
      ? this.normalizeProviderAccountIdentityId(updateData.providerAccountIdentityId)
      : existing.providerAccountIdentityId;
    if (identityChanged) {
      updateData.providerAccountIdentityId = nextProviderAccountIdentityId ?? null;
    }
    if ((providerChanged || identityChanged) && nextProviderAccountIdentityId) {
      await this.providerAccountIdentities.requireActiveForProvider(
        nextProviderAccountIdentityId,
        nextProvider,
      );
    }
    if (!nextProviderAccountIdentityId) {
      await this.assertProviderAccountIdentityCanBeEmpty(id);
    }
    const nextSdkType = sdkChanged
      ? this.normalizeChannelSdkType(updateData.sdkType, nextProvider)
      : runtimeSdkType(existing.sdkType, nextProvider);
    if (sdkChanged) {
      updateData.sdkType = nextSdkType;
    }
    let effectiveProviderProfile = existing.providerProfile ?? this.resolveChannelProviderProfile(nextProvider, nextSdkType);
    if (Object.prototype.hasOwnProperty.call(updateData, 'providerProfile')) {
      updateData.providerProfile = this.normalizeChannelProviderProfile(updateData.providerProfile);
      effectiveProviderProfile = updateData.providerProfile as string | null;
    } else if (providerChanged || sdkChanged) {
      updateData.providerProfile = this.resolveChannelProviderProfile(nextProvider, nextSdkType);
      effectiveProviderProfile = updateData.providerProfile as string | null;
    }
    if (Object.prototype.hasOwnProperty.call(updateData, 'clientCompatibility')) {
      updateData.clientCompatibility = this.normalizeChannelClientCompatibility(
        updateData.clientCompatibility,
        effectiveProviderProfile,
      );
    } else if (providerChanged || sdkChanged || profileChanged) {
      updateData.clientCompatibility = this.defaultClientCompatibilityStorage(effectiveProviderProfile);
    }
    if (protocolPathInput.present) {
      const protocolPaths = this.normalizeChannelProtocolPaths(protocolPathInput.value);
      if (protocolPaths?.length) {
        updateData.protocolPaths = this.protocolPathsStorage(protocolPaths);
        updateData.servedInboundProtocols = this.servedInboundProtocolsStorageFromPaths(protocolPaths);
      } else {
        updateData.protocolPaths = Prisma.JsonNull;
        updateData.servedInboundProtocols = null;
      }
    } else if (servedInboundProtocolInput.present) {
      updateData.servedInboundProtocols = this.normalizeChannelServedInboundProtocols(
        servedInboundProtocolInput.value,
        effectiveProviderProfile,
      );
      updateData.protocolPaths = this.protocolPathsStorage(
        this.protocolPathsForServedInboundProtocols(
          updateData.servedInboundProtocols as string | null | undefined,
          effectiveProviderProfile,
        ),
      );
    } else if (providerChanged || sdkChanged || profileChanged) {
      updateData.servedInboundProtocols = this.defaultServedInboundProtocolsStorage(effectiveProviderProfile);
      updateData.protocolPaths = this.defaultProtocolPathsStorage(effectiveProviderProfile);
    }
    if (Object.prototype.hasOwnProperty.call(updateData, 'tokenCountStrategy')) {
      updateData.tokenCountStrategy = this.normalizeChannelTokenCountStrategy(
        updateData.tokenCountStrategy,
        effectiveProviderProfile,
      );
    } else if (providerChanged || sdkChanged || profileChanged) {
      updateData.tokenCountStrategy = this.defaultTokenCountStrategyStorage(effectiveProviderProfile);
    }
    if (Object.prototype.hasOwnProperty.call(updateData, 'ownedBy')) {
      updateData.ownedBy = this.normalizeOwnedBy(updateData.ownedBy);
    }
    const dedicatedClientChanged = Object.prototype.hasOwnProperty.call(updateData, 'dedicatedClientProtocol');
    const dedicatedStrategyChanged = Object.prototype.hasOwnProperty.call(updateData, 'dedicatedProtocolStrategy');
    const effectiveDedicatedClientProtocol = dedicatedClientChanged
      ? this.normalizeDedicatedClientProtocol(updateData.dedicatedClientProtocol)
      : existing.dedicatedClientProtocol;
    if (dedicatedClientChanged) {
      updateData.dedicatedClientProtocol = effectiveDedicatedClientProtocol;
    }
    if (dedicatedStrategyChanged) {
      updateData.dedicatedProtocolStrategy = effectiveDedicatedClientProtocol
        ? this.normalizeDedicatedProtocolStrategy(updateData.dedicatedProtocolStrategy)
        : null;
    } else if (dedicatedClientChanged && !effectiveDedicatedClientProtocol) {
      updateData.dedicatedProtocolStrategy = null;
    }
    const updated = await this.channelRepository.update(id, updateData);
    const publisherSync = await this.notifyChannelsChanged();
    this.cleanupPublisherRuntimeIfUnused(existing);
    return {
      ...this.maskChannel(updated),
      ...(publisherSync ? { publisherSync } : {}),
    };
  }

  async remove(id: string) {
    const existing = await this.findByIdInternal(id);
    const deleted = await this.channelRepository.deleteById(id);
    const publisherSync = await this.notifyChannelsChanged();
    this.cleanupPublisherRuntimeIfUnused(existing);
    return {
      ...deleted,
      ...(publisherSync ? { publisherSync } : {}),
    };
  }

  async previewPublisherCompile(data: {
    name?: string;
    provider: string;
    baseUrl: string;
    sdkType?: string;
    providerProfile?: string | null;
    clientCompatibility?: string | string[] | null;
    servedInboundProtocols?: string | string[] | null;
    served_inbound_protocols?: string | string[] | null;
    tokenCountStrategy?: string | null;
    ownedBy?: string | null;
  }) {
    if (!this.publisherSync) {
      throw new BadRequestException('Publisher 同步模块未启用');
    }
    if (!data.provider || !data.baseUrl) {
      throw new BadRequestException('provider, baseUrl 为必填');
    }
    const sdkType = this.normalizeChannelSdkType(data.sdkType, data.provider);
    const providerProfile = this.resolveChannelProviderProfile(data.provider, sdkType, data.providerProfile);
    const clientCompatibility = data.clientCompatibility === undefined
      ? this.defaultClientCompatibilityStorage(providerProfile)
      : this.normalizeChannelClientCompatibility(data.clientCompatibility, providerProfile);
    const servedInboundProtocolInput = this.servedInboundProtocolInput(data as Record<string, unknown>);
    return this.publisherSync.previewProviderCompile({
      name: data.name || data.provider,
      provider: data.provider,
      baseUrl: data.baseUrl,
      sdkType,
      providerProfile,
      ownedBy: this.normalizeOwnedBy(data.ownedBy) ?? null,
      clientCompatibility,
      servedInboundProtocols: servedInboundProtocolInput.present
        ? this.normalizeChannelServedInboundProtocols(servedInboundProtocolInput.value, providerProfile)
        : this.defaultServedInboundProtocolsStorage(providerProfile),
      tokenCountStrategy: data.tokenCountStrategy === undefined
        ? this.defaultTokenCountStrategyStorage(providerProfile)
        : this.normalizeChannelTokenCountStrategy(data.tokenCountStrategy, providerProfile),
    });
  }

  private cleanupPublisherRuntimeIfUnused(channel: Pick<ChannelRecord, 'provider' | 'baseUrl' | 'sdkType' | 'providerProfile' | 'clientCompatibility' | 'servedInboundProtocols' | 'tokenCountStrategy'>): void {
    if (!this.publisherSync) return;
    this.publisherSync.cleanupRuntimeProviderIfUnused(channel)
      .catch((err) => {
        this.logger.warn(`publisher runtime provider cleanup failed provider=${channel.provider}: ${(err as Error).message}`);
      });
  }

  /**
   * 拼接 /models 候选 URL 列表,按优先级返回。
   *
   * 渠道 baseUrl 来自厂商不同约定:
   *   - OpenRouter / OpenAI: https://api.openai.com/v1 (已含 /v1)
   *   - shenhome / 自建: http://x.x.x.x:8080 (不含 /v1,直接 /models)
   *   - sub2api / cliproxy: https://sub2api-test.codesphere.run (不含 /v1,
   *     /models 返 404,但 /v1/models 返 200)
   *
   * 策略:
   *   - 已含 /v 段(/v1, /v2, /v3 等)→ 只试 ${baseUrl}/models
   *   - 不含 /v 段 → 优先试 ${baseUrl}/v1/models,失败再 fallback ${baseUrl}/models
   *
   * 不改用户配置(用户填什么 baseUrl 就用什么),只在请求时智能选 path。
   */
  private buildModelsUrlCandidates(baseUrl: string): string[] {
    const trimmed = baseUrl.replace(/\/+$/, '');
    // 检测末尾是否已含 /v\d+ 段
    if (/\/v\d+$/.test(trimmed)) {
      return [`${trimmed}/models`];
    }
    return [`${trimmed}/v1/models`, `${trimmed}/models`];
  }

  private buildAnthropicMessagesUrlCandidates(baseUrl: string): string[] {
    const trimmed = baseUrl.replace(/\/+$/, '');
    if (/\/messages$/.test(trimmed)) return [trimmed];
    if (/\/v\d+$/.test(trimmed)) return [`${trimmed}/messages`];
    return [`${trimmed}/v1/messages`];
  }

  private buildGeminiModelsUrlCandidates(baseUrl: string): string[] {
    const trimmed = baseUrl.replace(/\/+$/, '');
    if (/\/models$/.test(trimmed)) return [trimmed];
    if (/\/v\d+(?:beta)?$/.test(trimmed)) return [`${trimmed}/models`];
    return [`${trimmed}/v1beta/models`, `${trimmed}/v1/models`, `${trimmed}/models`];
  }

  private authHeadersForSdk(sdkType: string, apiKey: string): Record<string, string> {
    if (this.isAnthropicSdk(sdkType)) {
      return {
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      };
    }
    if (this.isGeminiSdk(sdkType)) {
      return { 'x-goog-api-key': apiKey };
    }
    return { Authorization: `Bearer ${apiKey}` };
  }

  private anthropicTestModel(
    channel: Pick<ChannelRecord, 'models' | 'modelConfigs'>,
  ): string {
    const modelConfigs = parseModelConfigs(channel.modelConfigs);
    for (const model of parseStringArrayJson(channel.models)) {
      if (model === '*') continue;
      const config = modelConfigs?.[model];
      if (config?.enabled === false) continue;
      return config?.upstreamModelId || model;
    }
    return ANTHROPIC_TEST_MODEL;
  }

  private buildHealthCheckRequests(
    channel: Pick<ChannelRecord, 'provider' | 'baseUrl' | 'sdkType' | 'apiKey' | 'models' | 'modelConfigs'>,
  ): UpstreamRequestCandidate[] {
    const sdkType = runtimeSdkType(channel.sdkType, channel.provider);
    if (this.isAnthropicSdk(sdkType)) {
      return this.buildAnthropicMessagesUrlCandidates(channel.baseUrl).map((url) => ({
        url,
        method: 'POST' as const,
        headers: {
          ...this.authHeadersForSdk(sdkType, channel.apiKey),
          'content-type': 'application/json',
        },
        body: JSON.stringify({
          model: this.anthropicTestModel(channel),
          max_tokens: 1,
          messages: [{ role: 'user', content: 'ping' }],
        }),
      }));
    }

    const modelUrls = this.isGeminiSdk(sdkType)
      ? this.buildGeminiModelsUrlCandidates(channel.baseUrl)
      : this.buildModelsUrlCandidates(channel.baseUrl);
    return modelUrls.map((url) => ({
      url,
      headers: this.authHeadersForSdk(sdkType, channel.apiKey),
    }));
  }

  private buildModelListRequests(
    channel: Pick<ChannelRecord, 'provider' | 'baseUrl' | 'sdkType' | 'apiKey'>,
  ): UpstreamRequestCandidate[] {
    const sdkType = runtimeSdkType(channel.sdkType, channel.provider);
    if (this.staticCatalogModelsForChannel(channel, sdkType).length > 0) {
      return [];
    }
    if (isCatalogOnlySdkType(sdkType)) {
      return [];
    }
    const urls = this.isGeminiSdk(sdkType)
      ? this.buildGeminiModelsUrlCandidates(channel.baseUrl)
      : this.buildModelsUrlCandidates(channel.baseUrl);
    return urls.map((url) => ({
      url,
      headers: this.authHeadersForSdk(sdkType, channel.apiKey),
    }));
  }

  private staticCatalogModelsForChannel(
    channel: Pick<ChannelRecord, 'provider' | 'sdkType'>,
    sdkType = runtimeSdkType(channel.sdkType, channel.provider),
  ): string[] {
    const provider = (channel.provider || '').toLowerCase();
    if (sdkType === 'minimax_video' || (provider.includes('minimax') && sdkType === 'video_generation')) {
      return MINIMAX_HAILUO_VIDEO_MODELS;
    }
    if (
      sdkType === 'seedance_video'
      || (
        sdkType === 'video_generation'
        && (
          provider.includes('seedance')
          || provider.includes('volc')
          || provider.includes('doubao')
          || provider.includes('ark')
        )
      )
    ) {
      return [...SEEDANCE_VIDEO_MODELS];
    }
    if (sdkType === 'runway_video' || (provider.includes('runway') && sdkType === 'video_generation')) {
      return RUNWAY_VIDEO_MODELS;
    }
    if (sdkType === 'openai_image' || (provider.includes('openai') && sdkType === 'image_generation')) {
      return OPENAI_IMAGE_MODELS;
    }
    if (sdkType === 'minimax_image' || (provider.includes('minimax') && sdkType === 'image_generation')) {
      return MINIMAX_IMAGE_MODELS;
    }
    if (
      sdkType === 'stability_image'
      || ((provider.includes('stability') || provider.includes('stable')) && sdkType === 'image_generation')
    ) {
      return STABILITY_IMAGE_MODELS;
    }
    if (sdkType === 'openai_audio' || (provider.includes('openai') && ['audio_generation', 'tts', 'stt'].includes(sdkType))) {
      return OPENAI_AUDIO_MODELS;
    }
    if (
      sdkType === 'elevenlabs_audio'
      || ((provider.includes('elevenlabs') || provider.includes('eleven_labs')) && ['audio_generation', 'tts', 'stt'].includes(sdkType))
    ) {
      return ELEVENLABS_AUDIO_MODELS;
    }
    if (sdkType === 'minimax_audio' || (provider.includes('minimax') && ['audio_generation', 'tts', 'stt'].includes(sdkType))) {
      return MINIMAX_SPEECH_MODELS;
    }
    if (sdkType === 'minimax_music' || (provider.includes('minimax') && sdkType === 'music_generation')) {
      return MINIMAX_MUSIC_MODELS;
    }
    return [];
  }

  private parseModelIds(json: unknown): string[] {
    if (!json || typeof json !== 'object') return [];
    const body = json as {
      data?: Array<{ id?: unknown }>;
      models?: Array<{ name?: unknown; id?: unknown }>;
    };
    const openAiIds = Array.isArray(body.data)
      ? body.data
          .map((model) => model?.id)
          .filter((id): id is string => typeof id === 'string' && id.length > 0)
      : [];
    const geminiIds = Array.isArray(body.models)
      ? body.models
          .map((model) => {
            const value = typeof model?.name === 'string' ? model.name : model?.id;
            return typeof value === 'string' ? value.replace(/^models\//, '') : '';
          })
          .filter((id): id is string => id.length > 0)
      : [];
    return Array.from(new Set([...openAiIds, ...geminiIds]));
  }

  async test(id: string): Promise<{ success: boolean; latencyMs: number; error?: string }> {
    const channel = await this.findByIdForUpstreamRequest(id);
    const start = Date.now();
    const candidates = this.buildHealthCheckRequests(channel);
    let lastError = '';
    let lastStatus = 0;
    try {
      for (const candidate of candidates) {
        // SSRF guard — reject loopback / RFC1918 / metadata IPs and
        // hostnames that resolve into them (DNS rebinding defense).
        await assertSafeExternalUrl(candidate.url);

        const res = await fetch(candidate.url, {
          method: candidate.method ?? 'GET',
          headers: candidate.headers,
          ...(candidate.body ? { body: candidate.body } : {}),
          signal: AbortSignal.timeout(10000),
        });
        if (res.ok) {
          return { success: true, latencyMs: Date.now() - start };
        }
        lastStatus = res.status;
        lastError = `HTTP ${res.status}`;
        // 仅当 404(路径不对)时尝试下一个 candidate;
        // 其它错误(401/403/5xx)直接返,避免反复打上游。
        if (res.status !== 404) break;
      }
      // 所有 candidates 都失败 → 报最后一次的状态
      this.emitChannelAlert(channel, lastError || `HTTP ${lastStatus}`);
      return { success: false, latencyMs: Date.now() - start, error: lastError };
    } catch (err) {
      const latencyMs = Date.now() - start;
      const msg = err instanceof Error ? err.message : String(err);
      // SSRF 拒绝 / fetch timeout / DNS 失败 / refresh failed 都走这里。
      // 全部归类为 CHANNEL/CRITICAL,运营靠 message + context 区分细分原因。
      this.emitChannelAlert(channel, msg);
      return { success: false, latencyMs, error: msg };
    }
  }

  /**
   * 从上游 OpenAI-compatible /v1/models 端点拉取可用模型列表。
   *
   * baseUrl 通常已包含 /v1(如 https://api.openai.com/v1),拼接 /models。
   * 解析 OpenAI 响应:{ data: [{ id, object, ... }, ...] } → 返 id 数组。
   *
   * 失败语义:
   *   - SSRF / 网络故障 / HTTP 非 OK → success=false + error
   *   - 响应非 OpenAI 格式(无 data 数组) → success=false + error
   *   - 不修改 channel 自身,不发 AlertEvent(由前端轻量重试承担)
   */
  async discoverModels(id: string): Promise<{
    success: boolean;
    models: string[];
    error?: string;
  }> {
    const channel = await this.findByIdForUpstreamRequest(id);
    const candidates = this.buildModelListRequests(channel);
    const staticModels = this.staticCatalogModelsForChannel(channel);
    if (candidates.length === 0 && staticModels.length > 0) {
      return { success: true, models: staticModels };
    }
    let lastError = '';
    try {
      for (const candidate of candidates) {
        await assertSafeExternalUrl(candidate.url);
        const res = await fetch(candidate.url, {
          method: candidate.method ?? 'GET',
          headers: candidate.headers,
          ...(candidate.body ? { body: candidate.body } : {}),
          signal: AbortSignal.timeout(10000),
        });
        if (!res.ok) {
          lastError = `HTTP ${res.status}`;
          // 路径不对(404)→ 试下一个 candidate;其它错(401/403/5xx)直接返
          if (res.status !== 404) {
            return { success: false, models: [], error: lastError };
          }
          continue;
        }
        const ids = this.parseModelIds(await res.json());
        if (ids.length === 0) {
          if (staticModels.length > 0) {
            return { success: true, models: staticModels };
          }
          return {
            success: false,
            models: [],
            error: '上游返回 0 个模型,请检查 baseUrl 是否正确',
          };
        }
        return { success: true, models: ids };
      }
      // 所有 candidates 都 404
      if (staticModels.length > 0) {
        return { success: true, models: staticModels };
      }
      return { success: false, models: [], error: lastError || 'HTTP 404' };
    } catch (err) {
      const msg = err instanceof Error ? err.message : String(err);
      return { success: false, models: [], error: msg };
    }
  }

  /**
   * P2-A2 共享的 channel 健康告警发送(spec §7.2.c)。
   * - fire-and-forget,test() 主链路绝不能被 alert 写入打断
   * - createAlert 内部已 catch + warn,这里再 .catch 双保险
   * - 5min 去重在 createAlert 内按 (CHANNEL, 'channel', channel.id),避免
   *   admin 在故障期手动反复点击"测试连通性"刷出多条 Alert
   */
  private emitChannelAlert(
    channel: Pick<ChannelRecord, 'id' | 'name' | 'provider'>,
    reason: string,
  ): void {
    if (!this.alertEvents) return;
    void this.alertEvents
      .createAlert({
        category: 'CHANNEL',
        severity: 'CRITICAL',
        title: `渠道异常:${channel.name}`,
        message: `渠道 ${channel.name}(${channel.provider})健康检查失败:${reason}`,
        sourceType: 'channel',
        sourceId: channel.id,
        userId: null,
        context: {
          channelId: channel.id,
          provider: channel.provider,
          reason,
        },
      })
      .catch(() => {});
  }

  async resetStats(id: string) {
    await this.findByIdInternal(id);
    const updated = await this.channelRepository.resetStats(id);
    return this.maskChannel(updated);
  }

  async recordRequest(id: string, success: boolean, latencyMs: number) {
    const channel = await this.channelRepository.findById(id);
    if (!channel) return;

    const newTotalReqs = channel.totalReqs + 1;
    const newTotalErrs = channel.totalErrs + (success ? 0 : 1);
    const newSuccessRate = (newTotalReqs - newTotalErrs) / newTotalReqs;
    const newAvgLatency = channel.avgLatencyMs
      ? (channel.avgLatencyMs * channel.totalReqs + latencyMs) / newTotalReqs
      : latencyMs;

    await this.channelRepository.updateStats(id, {
      totalReqs: newTotalReqs,
      totalErrs: newTotalErrs,
      successRate: newSuccessRate,
      avgLatencyMs: newAvgLatency,
    });
  }
}
