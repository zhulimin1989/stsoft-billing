import {
  CLIENT_COMPATIBILITIES,
  DEDICATED_PROTOCOL_CHANNELS,
  PROVIDER_PROFILES,
  TOKEN_COUNT_STRATEGIES,
  contractVersion,
} from '@raytone-lab/publisher-contracts';
import type {
  ClientCompatibility,
  DedicatedProtocolChannel,
  InboundProtocol,
  ProtocolPath,
  ProviderProfile,
  TokenCountStrategy,
} from '@raytone-lab/publisher-contracts';
import type { PublisherApiType } from './publisher.types';
import { normalizeProviderCode } from '../common/utils/provider-code.util';

export type ServedInboundProtocol = Extract<InboundProtocol, 'anthropic' | 'ark' | 'gemini' | 'openai' | 'responses'>;
export type RuntimeProtocolPath = ProtocolPath;

export type ChannelProtocolTemplate = {
  value: string;
  label: string;
  provider: string;
  sdkType: string;
  providerProfile: ProviderProfile;
  baseUrlPlaceholder: string;
  clientCompatibility: ClientCompatibility[];
  servedInboundProtocols: ServedInboundProtocol[];
  tokenCountStrategy?: TokenCountStrategy;
};

type ChannelProtocolTemplateBase = Omit<
  ChannelProtocolTemplate,
  'clientCompatibility' | 'servedInboundProtocols' | 'tokenCountStrategy'
>;

export type RuntimeProfileCapabilities = {
  clientCompatibilities: ClientCompatibility[];
  servedInboundProtocols: ServedInboundProtocol[];
  tokenCountStrategies: TokenCountStrategy[];
  defaultClientCompatibility: ClientCompatibility[];
  defaultServedInboundProtocols: ServedInboundProtocol[];
  defaultTokenCountStrategy?: TokenCountStrategy;
};

export type ChannelProtocolTemplatesResponse = {
  contractVersion: string;
  defaultTemplate: string;
  customTemplate: string;
  contract: {
    providerProfiles: ProviderProfile[];
    clientCompatibilities: ClientCompatibility[];
    inboundProtocols: ServedInboundProtocol[];
    dedicatedProtocolChannels: DedicatedProtocolChannel[];
    tokenCountStrategies: TokenCountStrategy[];
    profileCapabilities: Partial<Record<ProviderProfile, RuntimeProfileCapabilities>>;
  };
  items: ChannelProtocolTemplate[];
};

export type ChannelRuntimeIntentFields = {
  providerProfile?: string | null;
  clientCompatibility?: string | null;
  servedInboundProtocols?: string | string[] | null;
  protocolPaths?: unknown;
  tokenCountStrategy?: string | null;
  ownedBy?: string | null;
  dedicatedClientProtocol?: string | null;
  dedicatedProtocolStrategy?: string | null;
};

export type ProviderRuntimeIntent = {
  providerProfile: ProviderProfile;
  clientCompatibility: ClientCompatibility[];
  servedInboundProtocols: ServedInboundProtocol[];
  tokenCountStrategy?: TokenCountStrategy;
};

export const DEFAULT_PROTOCOL_TEMPLATE = 'openai_compatible';
export const CUSTOM_PROTOCOL_TEMPLATE = '__custom__';
export const DEFAULT_CLIENT_COMPATIBILITY: ClientCompatibility = 'all';
export const SERVED_INBOUND_PROTOCOLS = ['openai', 'responses', 'anthropic', 'gemini', 'ark'] as const satisfies readonly ServedInboundProtocol[];

export const PUBLISHER_PROVIDER_PROFILE_SET = new Set<string>(PROVIDER_PROFILES);
export const PUBLISHER_CLIENT_COMPATIBILITY_SET = new Set<string>(CLIENT_COMPATIBILITIES);
export const PUBLISHER_SERVED_INBOUND_PROTOCOL_SET = new Set<string>(SERVED_INBOUND_PROTOCOLS);
export const PUBLISHER_TOKEN_COUNT_STRATEGY_SET = new Set<string>(TOKEN_COUNT_STRATEGIES);
export const PUBLISHER_DEDICATED_PROTOCOL_CHANNEL_SET = new Set<string>(DEDICATED_PROTOCOL_CHANNELS);

const OPENAI_COMPATIBLE_PROVIDER_PROFILE: ProviderProfile = 'openai_compatible';
const ANTHROPIC_NATIVE_PROVIDER_PROFILE: ProviderProfile = 'anthropic_native';

const CHANNEL_SDK_TYPE_ALIASES: Record<string, string> = {
  openai: 'openai_completions',
  openai_chat: 'openai_completions',
  openai_compat: 'openai_compatible',
  openai_compatible: 'openai_compatible',
  chat_completions: 'openai_completions',
  openai_completions: 'openai_completions',
  openai_completions_with_tools: 'openai_completions_with_tools',
  completions_with_tools: 'openai_completions_with_tools',
  tools: 'openai_completions_with_tools',
  openai_responses: 'openai_responses',
  responses: 'openai_responses',
  anthropic: 'anthropic',
  anthropic_native: 'anthropic',
  claude: 'anthropic',
  gemini: 'gemini',
  gemini_native: 'gemini',
  google: 'gemini',
  glm: 'glm',
  glm_coding: 'glm_coding',
  zhipu: 'glm',
  zhipu_coding: 'glm_coding',
  zhipuai: 'glm',
  doubao: 'doubao',
  volc: 'doubao',
  volcengine: 'doubao',
  azure: 'azure',
  azure_openai: 'azure',
  cohere: 'cohere_v2',
  cohere_v2: 'cohere_v2',
  minimax_video: 'minimax_video',
  minimax_hailuo: 'minimax_video',
  hailuo: 'minimax_video',
  hailuo_video: 'minimax_video',
  openai_image: 'openai_image',
  openai_images: 'openai_image',
  gpt_image: 'openai_image',
  minimax_image: 'minimax_image',
  stability: 'stability_image',
  stability_ai: 'stability_image',
  stability_image: 'stability_image',
  stable_image: 'stability_image',
  stability_ai_image: 'stability_image',
  fal_image: 'fal_image',
  fal: 'fal_image',
  openai_audio: 'openai_audio',
  openai_tts: 'openai_audio',
  openai_stt: 'openai_audio',
  elevenlabs_audio: 'elevenlabs_audio',
  elevenlabs: 'elevenlabs_audio',
  eleven_labs: 'elevenlabs_audio',
  elevenlabs_tts: 'elevenlabs_audio',
  elevenlabs_stt: 'elevenlabs_audio',
  minimax_audio: 'minimax_audio',
  minimax_tts: 'minimax_audio',
  minimax_speech: 'minimax_audio',
  minimax_music: 'minimax_music',
  seedance: 'seedance_video',
  seedance_video: 'seedance_video',
  doubao_seedance: 'seedance_video',
  volcengine_video: 'seedance_video',
  ark_video: 'seedance_video',
  runway_video: 'runway_video',
  runway: 'runway_video',
  kling_video: 'kling_video',
  kling: 'kling_video',
  video_generation: 'video_generation',
  image_generation: 'image_generation',
  audio_generation: 'audio_generation',
  tts: 'tts',
  stt: 'stt',
  music_generation: 'music_generation',
};

const CHANNEL_PROVIDER_PROFILE_ALIASES: Record<string, ProviderProfile> = {
  anthropic: 'anthropic_native',
  claude: 'anthropic_native',
  openai: 'openai_compatible',
  openai_compat: 'openai_compatible',
  openai_responses: 'openai_responses_native',
  responses: 'openai_responses_native',
  azure: 'azure_openai',
  gemini: 'gemini_native',
  google: 'gemini_native',
  doubao: 'doubao_ark',
  glm_coding: 'glm_coding',
  zhipu: 'glm',
  zhipu_coding: 'glm_coding',
  cohere: 'cohere_v2',
};

const CHANNEL_PROTOCOL_TEMPLATE_PRESETS: ChannelProtocolTemplateBase[] = [
  {
    value: 'openai_compatible',
    label: 'OpenAI Compatible',
    provider: 'openai',
    sdkType: 'openai_compatible',
    providerProfile: 'openai_compatible',
    baseUrlPlaceholder: 'https://api.openai.com/v1',
  },
  {
    value: 'deepseek_openai',
    label: 'DeepSeek / OpenAI Compatible',
    provider: 'deepseek',
    sdkType: 'openai_compatible',
    providerProfile: 'openai_compatible',
    baseUrlPlaceholder: 'https://api.deepseek.com/v1',
  },
  {
    value: 'qwen_openai',
    label: 'Qwen / OpenAI Compatible',
    provider: 'qwen',
    sdkType: 'openai_compatible',
    providerProfile: 'openai_compatible',
    baseUrlPlaceholder: 'https://dashscope.aliyuncs.com/compatible-mode/v1',
  },
  {
    value: 'kimi_openai',
    label: 'Kimi / OpenAI Compatible',
    provider: 'kimi',
    sdkType: 'openai_compatible',
    providerProfile: 'openai_compatible',
    baseUrlPlaceholder: 'https://api.moonshot.cn/v1',
  },
  {
    value: 'mistral_openai',
    label: 'Mistral / OpenAI Compatible',
    provider: 'mistral',
    sdkType: 'openai_compatible',
    providerProfile: 'openai_compatible',
    baseUrlPlaceholder: 'https://api.mistral.ai/v1',
  },
  {
    value: 'minimax_openai',
    label: 'MiniMax / OpenAI Compatible',
    provider: 'minimax',
    sdkType: 'openai_compatible',
    providerProfile: 'openai_compatible',
    baseUrlPlaceholder: 'https://api.minimax.chat/v1',
  },
  {
    value: 'other_openai',
    label: '其他 / OpenAI Compatible',
    provider: 'other',
    sdkType: 'openai_compatible',
    providerProfile: 'openai_compatible',
    baseUrlPlaceholder: 'https://example.com/v1',
  },
  {
    value: 'anthropic_native',
    label: 'Anthropic Native',
    provider: 'anthropic',
    sdkType: 'anthropic',
    providerProfile: 'anthropic_native',
    baseUrlPlaceholder: 'https://api.anthropic.com',
  },
  {
    value: 'openai_responses_native',
    label: 'OpenAI Responses',
    provider: 'openai',
    sdkType: 'openai_responses',
    providerProfile: 'openai_responses_native',
    baseUrlPlaceholder: 'https://api.openai.com/v1',
  },
  {
    value: 'azure_openai',
    label: 'Azure OpenAI',
    provider: 'azure',
    sdkType: 'azure',
    providerProfile: 'azure_openai',
    baseUrlPlaceholder: 'https://{resource}.openai.azure.com/openai/deployments/{deployment}',
  },
  {
    value: 'gemini_native',
    label: 'Gemini Native',
    provider: 'google',
    sdkType: 'gemini',
    providerProfile: 'gemini_native',
    baseUrlPlaceholder: 'https://generativelanguage.googleapis.com',
  },
  {
    value: 'doubao_ark',
    label: 'Doubao Ark',
    provider: 'doubao',
    sdkType: 'doubao',
    providerProfile: 'doubao_ark',
    baseUrlPlaceholder: 'https://ark.cn-beijing.volces.com/api/v3',
  },
  {
    value: 'glm',
    label: 'GLM Native',
    provider: 'zhipu',
    sdkType: 'glm',
    providerProfile: 'glm',
    baseUrlPlaceholder: 'https://open.bigmodel.cn/api/paas/v4',
  },
  {
    value: 'glm_coding',
    label: 'GLM Coding',
    provider: 'zhipu',
    sdkType: 'glm_coding',
    providerProfile: 'glm_coding',
    baseUrlPlaceholder: 'https://open.bigmodel.cn/api/coding/paas/v4',
  },
  {
    value: 'cohere_v2',
    label: 'Cohere v2',
    provider: 'cohere',
    sdkType: 'cohere_v2',
    providerProfile: 'cohere_v2',
    baseUrlPlaceholder: 'https://api.cohere.com/v2',
  },
];

const FALLBACK_TEMPLATE_BY_PROFILE: Record<ProviderProfile, ChannelProtocolTemplateBase> = {
  anthropic_native: {
    value: 'anthropic_native',
    label: 'Anthropic Native',
    provider: 'anthropic',
    sdkType: 'anthropic',
    providerProfile: 'anthropic_native',
    baseUrlPlaceholder: 'https://api.anthropic.com',
  },
  ark_video_native: {
    value: 'ark_video_native',
    label: 'Ark Video Native (CN)',
    provider: 'seedance',
    sdkType: 'seedance_video',
    providerProfile: 'ark_video_native',
    baseUrlPlaceholder: 'https://ark.cn-beijing.volces.com',
  },
  azure_openai: {
    value: 'azure_openai',
    label: 'Azure OpenAI',
    provider: 'azure',
    sdkType: 'azure',
    providerProfile: 'azure_openai',
    baseUrlPlaceholder: 'https://{resource}.openai.azure.com/openai/deployments/{deployment}',
  },
  cohere_v2: {
    value: 'cohere_v2',
    label: 'Cohere v2',
    provider: 'cohere',
    sdkType: 'cohere_v2',
    providerProfile: 'cohere_v2',
    baseUrlPlaceholder: 'https://api.cohere.com/v2',
  },
  doubao_ark: {
    value: 'doubao_ark',
    label: 'Doubao Ark',
    provider: 'doubao',
    sdkType: 'doubao',
    providerProfile: 'doubao_ark',
    baseUrlPlaceholder: 'https://ark.cn-beijing.volces.com/api/v3',
  },
  gemini_native: {
    value: 'gemini_native',
    label: 'Gemini Native',
    provider: 'google',
    sdkType: 'gemini',
    providerProfile: 'gemini_native',
    baseUrlPlaceholder: 'https://generativelanguage.googleapis.com',
  },
  glm: {
    value: 'glm',
    label: 'GLM Native',
    provider: 'zhipu',
    sdkType: 'glm',
    providerProfile: 'glm',
    baseUrlPlaceholder: 'https://open.bigmodel.cn/api/paas/v4',
  },
  glm_coding: {
    value: 'glm_coding',
    label: 'GLM Coding',
    provider: 'zhipu',
    sdkType: 'glm_coding',
    providerProfile: 'glm_coding',
    baseUrlPlaceholder: 'https://open.bigmodel.cn/api/coding/paas/v4',
  },
  openai_compatible: {
    value: 'openai_compatible',
    label: 'OpenAI Compatible',
    provider: 'openai',
    sdkType: 'openai_compatible',
    providerProfile: 'openai_compatible',
    baseUrlPlaceholder: 'https://api.openai.com/v1',
  },
  openai_native: {
    value: 'openai_native',
    label: 'OpenAI Native',
    provider: 'openai',
    sdkType: 'openai_completions',
    providerProfile: 'openai_native',
    baseUrlPlaceholder: 'https://api.openai.com/v1',
  },
  openai_responses_native: {
    value: 'openai_responses_native',
    label: 'OpenAI Responses',
    provider: 'openai',
    sdkType: 'openai_responses',
    providerProfile: 'openai_responses_native',
    baseUrlPlaceholder: 'https://api.openai.com/v1',
  },
};

export const CATALOG_ONLY_SDK_TYPES = new Set([
  'minimax_video',
  'openai_image',
  'minimax_image',
  'stability_image',
  'fal_image',
  'openai_audio',
  'elevenlabs_audio',
  'minimax_audio',
  'minimax_music',
  'runway_video',
  'kling_video',
  'video_generation',
  'image_generation',
  'audio_generation',
  'tts',
  'stt',
  'music_generation',
]);

const SUPPORTED_CHANNEL_SDK_TYPES = new Set<string>([
  ...Object.values(CHANNEL_SDK_TYPE_ALIASES),
  ...CHANNEL_PROTOCOL_TEMPLATE_PRESETS.map((template) => template.sdkType),
  ...Object.values(FALLBACK_TEMPLATE_BY_PROFILE).map((template) => template.sdkType),
]);

const PROFILE_CLIENT_COMPATIBILITIES: Record<ProviderProfile, ClientCompatibility[]> = {
  anthropic_native: ['all', 'claude_code'],
  ark_video_native: [],
  azure_openai: ['all', 'openai_sdk', 'cursor', 'cline', 'cherrystudio', 'dify'],
  cohere_v2: ['all', 'dify'],
  doubao_ark: ['all', 'openai_sdk', 'cursor', 'cline', 'cherrystudio', 'dify'],
  gemini_native: ['all', 'gemini_cli'],
  glm: ['all', 'openai_sdk', 'cursor', 'cline', 'cherrystudio', 'dify'],
  glm_coding: ['all', 'openai_sdk', 'cursor', 'cline', 'cherrystudio', 'dify'],
  openai_compatible: [
    'all',
    'claude_code',
    'codex',
    'openai_sdk',
    'openclaw',
    'cursor',
    'cline',
    'cherrystudio',
    'dify',
  ],
  openai_native: [
    'all',
    'claude_code',
    'codex',
    'openai_sdk',
    'openclaw',
    'cursor',
    'cline',
    'cherrystudio',
    'dify',
  ],
  openai_responses_native: ['all', 'codex', 'openai_sdk'],
};

const PROFILE_SERVED_INBOUND_PROTOCOLS: Record<ProviderProfile, ServedInboundProtocol[]> = {
  anthropic_native: ['anthropic'],
  ark_video_native: ['ark'],
  azure_openai: ['openai'],
  cohere_v2: ['openai'],
  doubao_ark: ['openai'],
  gemini_native: ['gemini'],
  glm: ['openai'],
  glm_coding: ['openai'],
  openai_compatible: ['openai', 'responses', 'anthropic'],
  openai_native: ['openai', 'responses', 'anthropic'],
  openai_responses_native: ['openai', 'responses'],
};

const PROFILE_TOKEN_COUNT_STRATEGIES: Record<ProviderProfile, TokenCountStrategy[]> = {
  anthropic_native: ['native', 'unsupported'],
  ark_video_native: [],
  azure_openai: ['unsupported'],
  cohere_v2: ['unsupported'],
  doubao_ark: ['unsupported'],
  gemini_native: ['unsupported'],
  glm: ['unsupported'],
  glm_coding: ['unsupported'],
  openai_compatible: ['unsupported'],
  openai_native: ['unsupported'],
  openai_responses_native: ['unsupported'],
};

const DEFAULT_TOKEN_COUNT_STRATEGY_BY_PROFILE: Partial<Record<ProviderProfile, TokenCountStrategy>> = {
  anthropic_native: 'native',
  openai_compatible: 'unsupported',
};

export function runtimeToken(value: string | null | undefined): string {
  return (value ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_');
}

export function defaultSdkTypeForProvider(provider: string | null | undefined): string {
  const token = runtimeToken(provider);
  if (token.includes('anthropic') || token.includes('claude')) return 'anthropic';
  if (token.includes('gemini') || token.includes('google')) return 'gemini';
  if (token.includes('zhipu') || token.includes('glm')) return 'glm';
  if (token.includes('minimax') || token.includes('hailuo')) return 'minimax_video';
  if (token.includes('seedance')) return 'seedance_video';
  if (token.includes('runway')) return 'runway_video';
  if (token.includes('kling')) return 'kling_video';
  if (token.includes('elevenlabs')) return 'elevenlabs_audio';
  if (token.includes('stability') || token.includes('stable_image')) return 'stability_image';
  if (token.includes('fal')) return 'fal_image';
  if (token.includes('doubao') || token.includes('volc')) return 'doubao';
  if (token.includes('azure')) return 'azure';
  if (token.includes('cohere')) return 'cohere_v2';
  return 'openai_completions';
}

export function normalizeChannelSdkTypeValue(
  value: unknown,
  provider: string | null | undefined,
): string {
  if (value === undefined || value === null || String(value).trim() === '') {
    return defaultSdkTypeForProvider(provider);
  }
  const token = runtimeToken(String(value));
  const normalized = CHANNEL_SDK_TYPE_ALIASES[token] ?? token;
  if (!SUPPORTED_CHANNEL_SDK_TYPES.has(normalized)) {
    throw new Error(`不支持的端点协议: ${String(value)}`);
  }
  return normalized;
}

export function runtimeSdkType(
  value: string | null | undefined,
  provider: string | null | undefined,
): string {
  if (!value || !value.trim()) return defaultSdkTypeForProvider(provider);
  const token = runtimeToken(value);
  return CHANNEL_SDK_TYPE_ALIASES[token] ?? token;
}

export function isCatalogOnlySdkType(sdkType: string | null | undefined): boolean {
  const sdk = runtimeToken(sdkType);
  return CATALOG_ONLY_SDK_TYPES.has(sdk) || sdk.includes('hailuo');
}

export function normalizeProviderProfileValue(value: unknown): ProviderProfile | null {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const token = runtimeToken(String(value));
  const normalized = CHANNEL_PROVIDER_PROFILE_ALIASES[token] ?? token;
  if (!PUBLISHER_PROVIDER_PROFILE_SET.has(normalized)) {
    throw new Error(`不支持的供应商运行时类型: ${String(value)}`);
  }
  return normalized as ProviderProfile;
}

export function normalizeClientCompatibilityValue(value: unknown): ClientCompatibility {
  const token = runtimeToken(String(value));
  if (!PUBLISHER_CLIENT_COMPATIBILITY_SET.has(token)) {
    throw new Error(`不支持的客户端兼容类型: ${String(value)}`);
  }
  return token as ClientCompatibility;
}

export function normalizeClientCompatibilityListValue(
  value: unknown,
  profile?: ProviderProfile | null,
): ClientCompatibility[] | null {
  if (value === undefined || value === null || value === '') return null;
  const rawItems = Array.isArray(value)
    ? value
    : parseClientCompatibilityString(String(value));
  const seen = new Set<string>();
  const normalized = rawItems.map(normalizeClientCompatibilityValue)
    .filter((item) => {
      if (seen.has(item)) return false;
      seen.add(item);
      return true;
    });
  if (profile) {
    const unsupported = normalized.filter((item) => !clientCompatibilityAllowedForProfile(item, profile));
    if (unsupported.length > 0) {
      throw new Error(`客户端兼容类型不适用于 ${profile}: ${unsupported.join(',')}`);
    }
  }
  return normalized.length ? normalized : null;
}

export function normalizeServedInboundProtocolValue(value: unknown): ServedInboundProtocol {
  const token = runtimeToken(String(value));
  if (!PUBLISHER_SERVED_INBOUND_PROTOCOL_SET.has(token)) {
    throw new Error(`不支持的入站协议: ${String(value)}`);
  }
  return token as ServedInboundProtocol;
}

export function normalizeServedInboundProtocolListValue(value: unknown): ServedInboundProtocol[] | null {
  if (value === undefined || value === null || value === '') return null;
  const rawItems = Array.isArray(value)
    ? value
    : parseDelimitedStringList(String(value));
  const seen = new Set<ServedInboundProtocol>();
  for (const item of rawItems) {
    seen.add(normalizeServedInboundProtocolValue(item));
  }
  return sortServedInboundProtocols([...seen]);
}

export function normalizeTokenCountStrategyValue(
  value: unknown,
  profile?: ProviderProfile | null,
): TokenCountStrategy | null {
  if (value === undefined || value === null || String(value).trim() === '') return null;
  const normalized = runtimeToken(String(value));
  if (!PUBLISHER_TOKEN_COUNT_STRATEGY_SET.has(normalized)) {
    throw new Error(`不支持的 token count 策略: ${String(value)}`);
  }
  if (profile && !tokenCountStrategyAllowedForProfile(normalized, profile)) {
    throw new Error(`token count 策略不适用于 ${profile}: ${String(value)}`);
  }
  return normalized as TokenCountStrategy;
}

export function clientCompatibilityAllowedForProfile(
  client: string,
  profile: ProviderProfile | string | null | undefined,
): boolean {
  if (!profile) return PUBLISHER_CLIENT_COMPATIBILITY_SET.has(client);
  const allowed = PROFILE_CLIENT_COMPATIBILITIES[profile as ProviderProfile];
  return Boolean(allowed?.includes(client as ClientCompatibility));
}

export function tokenCountStrategyAllowedForProfile(
  strategy: string | null | undefined,
  profile: ProviderProfile | string | null | undefined,
): boolean {
  if (!strategy) return true;
  if (!profile) return PUBLISHER_TOKEN_COUNT_STRATEGY_SET.has(strategy);
  const allowed = PROFILE_TOKEN_COUNT_STRATEGIES[profile as ProviderProfile];
  return Boolean(allowed?.includes(strategy as TokenCountStrategy));
}

export function upstreamProtocolForProviderProfile(
  profile: ProviderProfile | string | null | undefined,
): ServedInboundProtocol | null {
  if (!profile) return null;
  const normalized = normalizeProviderProfileValue(profile);
  if (normalized === 'anthropic_native') return 'anthropic';
  if (normalized === 'ark_video_native') return 'ark';
  if (normalized === 'gemini_native') return 'gemini';
  if (normalized === 'openai_responses_native') return 'responses';
  return 'openai';
}

export function servedInboundProtocolAllowedForProfile(
  protocol: ServedInboundProtocol | string,
  profile: ProviderProfile | string | null | undefined,
): boolean {
  const upstream = upstreamProtocolForProviderProfile(profile);
  if (!upstream) return PUBLISHER_SERVED_INBOUND_PROTOCOL_SET.has(String(protocol));
  if (protocol === upstream) return true;
  return upstream === 'openai' && (protocol === 'responses' || protocol === 'anthropic');
}

export function defaultClientCompatibilityForProfile(
  profile: ProviderProfile | null | undefined,
): ClientCompatibility[] {
  if (!profile) return [DEFAULT_CLIENT_COMPATIBILITY];
  return PROFILE_CLIENT_COMPATIBILITIES[profile]?.includes(DEFAULT_CLIENT_COMPATIBILITY)
    ? [DEFAULT_CLIENT_COMPATIBILITY]
    : [...PROFILE_CLIENT_COMPATIBILITIES[profile]];
}

export function defaultServedInboundProtocolsForProfile(
  profile: ProviderProfile | null | undefined,
): ServedInboundProtocol[] {
  if (!profile) return [...SERVED_INBOUND_PROTOCOLS];
  return [...PROFILE_SERVED_INBOUND_PROTOCOLS[profile]];
}

export function defaultProtocolPathsForProfile(
  profile: ProviderProfile | null | undefined,
): RuntimeProtocolPath[] {
  return buildProtocolPathsFromServedInboundProtocols(
    defaultServedInboundProtocolsForProfile(profile),
    profile,
  );
}

export function buildProtocolPathsFromServedInboundProtocols(
  protocols: readonly ServedInboundProtocol[],
  profile: ProviderProfile | null | undefined,
): RuntimeProtocolPath[] {
  return protocols.map((inboundProtocol) => ({
    inbound_protocol: inboundProtocol,
    channel: defaultProtocolPathChannel(profile, inboundProtocol),
  }));
}

export function servedInboundProtocolsForProtocolPaths(paths: readonly RuntimeProtocolPath[]): ServedInboundProtocol[] {
  const seen = new Set<ServedInboundProtocol>();
  const out: ServedInboundProtocol[] = [];
  for (const path of paths) {
    if (seen.has(path.inbound_protocol)) continue;
    seen.add(path.inbound_protocol);
    out.push(path.inbound_protocol);
  }
  return out;
}

export function defaultTokenCountStrategyForProfile(
  profile: ProviderProfile | null | undefined,
): TokenCountStrategy | undefined {
  return profile ? DEFAULT_TOKEN_COUNT_STRATEGY_BY_PROFILE[profile] : undefined;
}

export function buildChannelProtocolTemplates(): ChannelProtocolTemplate[] {
  const items = CHANNEL_PROTOCOL_TEMPLATE_PRESETS
    .filter((template) => PUBLISHER_PROVIDER_PROFILE_SET.has(template.providerProfile))
    .map(withProtocolTemplateDefaults);
  const coveredProfiles = new Set(items.map((template) => template.providerProfile));
  for (const profile of PROVIDER_PROFILES as readonly ProviderProfile[]) {
    if (coveredProfiles.has(profile)) continue;
    items.push(withProtocolTemplateDefaults(FALLBACK_TEMPLATE_BY_PROFILE[profile]));
    coveredProfiles.add(profile);
  }
  return items;
}

export function getChannelProtocolTemplates(): ChannelProtocolTemplatesResponse {
  return {
    contractVersion,
    defaultTemplate: DEFAULT_PROTOCOL_TEMPLATE,
    customTemplate: CUSTOM_PROTOCOL_TEMPLATE,
    contract: {
      providerProfiles: Array.from(PROVIDER_PROFILES) as ProviderProfile[],
      clientCompatibilities: Array.from(CLIENT_COMPATIBILITIES) as ClientCompatibility[],
      inboundProtocols: [...SERVED_INBOUND_PROTOCOLS],
      dedicatedProtocolChannels: Array.from(DEDICATED_PROTOCOL_CHANNELS) as DedicatedProtocolChannel[],
      tokenCountStrategies: Array.from(TOKEN_COUNT_STRATEGIES) as TokenCountStrategy[],
      profileCapabilities: profileCapabilities(),
    },
    items: buildChannelProtocolTemplates(),
  };
}

export function apiTypesForProviderSdk(
  providerId: string,
  sdkType: string | null | undefined,
): PublisherApiType[] {
  const provider = providerId.toLowerCase();
  const sdk = runtimeToken(sdkType);
  if (isCatalogOnlySdkType(sdk)) return [];
  if (sdk === 'seedance_video') return ['ark'];
  if (sdk.includes('responses')) return ['openai_responses'];
  if (sdk.includes('azure')) return ['azure'];
  if (sdk.includes('anthropic') || sdk.includes('claude')) return ['anthropic'];
  if (sdk.includes('gemini') || sdk.includes('google')) return ['gemini'];
  if (sdk.includes('doubao') || sdk.includes('volc') || sdk.includes('ark')) return ['doubao'];
  if (
    sdk.includes('glm_coding')
    || sdk.includes('glm-coding')
    || sdk.includes('zhipu_coding')
    || sdk.includes('zhipu-coding')
  ) {
    return ['glm_coding'];
  }
  if (sdk === 'glm' || sdk === 'zhipu' || sdk.includes('bigmodel')) return ['glm'];
  if (sdk.includes('cohere')) return ['cohere_v2'];
  if (sdk.includes('openai') || sdk.includes('chat_completions') || sdk.includes('completions')) return ['openai'];
  if (
    provider.includes('glm-coding')
    || provider.includes('glm_coding')
    || provider.includes('zhipu-coding')
    || provider.includes('zhipu_coding')
  ) {
    return ['glm_coding'];
  }
  if (provider.includes('zhipu') || provider.includes('glm')) return ['glm'];
  if (provider.includes('anthropic') || provider.includes('claude')) return ['anthropic'];
  if (provider.includes('gemini') || provider.includes('google')) return ['gemini'];
  if (provider.includes('doubao') || provider.includes('volc')) return ['doubao'];
  if (provider.includes('azure')) return ['azure'];
  if (provider.includes('cohere')) return ['cohere_v2'];
  if (provider.includes('responses')) return ['openai_responses'];
  return ['openai'];
}

export function providerApiTypesForChannels(
  providerId: string,
  channels: Array<{ sdkType?: string | null }>,
): PublisherApiType[] {
  const values = channels.flatMap((channel) => apiTypesForProviderSdk(providerId, channel.sdkType));
  return Array.from(new Set(values));
}

export function inferProviderProfile(
  _providerId: string,
  apiTypes: PublisherApiType[],
): ProviderProfile | null {
  if (apiTypes.length !== 1) return null;
  switch (apiTypes[0]) {
    case 'openai':
      return OPENAI_COMPATIBLE_PROVIDER_PROFILE;
    case 'anthropic':
      return ANTHROPIC_NATIVE_PROVIDER_PROFILE;
    case 'ark':
      return 'ark_video_native';
    case 'openai_responses':
      return 'openai_responses_native';
    case 'glm':
    case 'glm_coding':
    case 'cohere_v2':
      return apiTypes[0];
    case 'azure':
      return 'azure_openai';
    case 'doubao':
      return 'doubao_ark';
    case 'zhipu':
      return 'glm';
    case 'gemini':
      return 'gemini_native';
    default:
      return null;
  }
}

export function isGatewayRoutableChannel(
  channel: { provider: string; sdkType?: string | null },
  providerCode = providerIdFromCode(channel.provider),
): boolean {
  return apiTypesForProviderSdk(providerCode, channel.sdkType).length > 0;
}

export function providerUrlParts(
  rawBaseUrl: string | null | undefined,
  apiType: PublisherApiType | undefined,
): { baseUrl: string; pathPrefix?: string } {
  const trimmed = providerBaseUrl(rawBaseUrl);
  if (!trimmed) {
    return {
      baseUrl: '',
      ...(apiType && defaultPathPrefixForApiType(apiType)
        ? { pathPrefix: defaultPathPrefixForApiType(apiType) }
        : {}),
    };
  }

  try {
    const url = new URL(trimmed);
    const pathPrefix = url.pathname && url.pathname !== '/'
      ? url.pathname.replace(/\/+$/, '')
      : apiType
        ? defaultPathPrefixForApiType(apiType)
        : undefined;
    url.pathname = '';
    url.search = '';
    url.hash = '';
    return {
      baseUrl: url.toString().replace(/\/+$/, ''),
      ...(pathPrefix ? { pathPrefix } : {}),
    };
  } catch {
    return { baseUrl: trimmed };
  }
}

export function defaultPathPrefixForApiType(apiType: PublisherApiType): string | undefined {
  if (apiType === 'openai' || apiType === 'openai_responses' || apiType === 'anthropic') return '/v1';
  if (apiType === 'ark') return '/api/v3';
  if (apiType === 'doubao') return '/api/v3';
  if (apiType === 'azure') return '/openai/deployments/{upstream_model}';
  if (apiType === 'glm' || apiType === 'zhipu') return '/api/paas/v4';
  if (apiType === 'glm_coding') return '/api/coding/paas/v4';
  if (apiType === 'cohere_v2') return '/v2';
  return undefined;
}

export function resolveProviderRuntimeIntent(
  providerId: string,
  channels: Array<{
    isActive?: boolean | null;
    status?: string | null;
    providerProfile?: string | null;
    clientCompatibility?: string | null;
    servedInboundProtocols?: string | string[] | null;
    tokenCountStrategy?: string | null;
  }>,
  apiTypes: PublisherApiType[],
): ProviderRuntimeIntent | null {
  const first = channels.find((ch) => ch.isActive && ch.status === 'active') ?? channels[0];
  if (!first) return null;
  const inferred = inferProviderProfile(providerId, apiTypes);
  const providerProfile = normalizeProviderProfileValue(first.providerProfile) ?? inferred;
  if (!providerProfile || !PUBLISHER_PROVIDER_PROFILE_SET.has(providerProfile)) return null;
  if (apiTypes.includes('ark') && providerProfile !== 'ark_video_native') {
    throw new Error(`Ark video channel requires provider profile ark_video_native, got ${providerProfile}`);
  }

  const clientCompatibility =
    normalizeClientCompatibilityListValue(first.clientCompatibility, providerProfile)
    ?? defaultClientCompatibilityForProfile(providerProfile);
  const servedInboundProtocols =
    normalizeServedInboundProtocolListValue(first.servedInboundProtocols)
    ?? defaultServedInboundProtocolsForProfile(providerProfile);
  if (
    providerProfile === 'ark_video_native'
    && (servedInboundProtocols.length !== 1 || servedInboundProtocols[0] !== 'ark')
  ) {
    throw new Error('Ark video channel requires served inbound protocol ark');
  }
  const tokenCountStrategy =
    normalizeTokenCountStrategyValue(first.tokenCountStrategy, providerProfile)
    ?? defaultTokenCountStrategyForProfile(providerProfile);
  return {
    providerProfile,
    clientCompatibility,
    servedInboundProtocols,
    ...(tokenCountStrategy ? { tokenCountStrategy } : {}),
  };
}

export function providerIdFromCode(provider: string): string {
  return normalizeProviderCode(provider);
}

function withProtocolTemplateDefaults(template: ChannelProtocolTemplateBase): ChannelProtocolTemplate {
  const tokenCountStrategy = defaultTokenCountStrategyForProfile(template.providerProfile);
  return {
    ...template,
    clientCompatibility: defaultClientCompatibilityForProfile(template.providerProfile),
    servedInboundProtocols: defaultServedInboundProtocolsForProfile(template.providerProfile),
    ...(tokenCountStrategy ? { tokenCountStrategy } : {}),
  };
}

function profileCapabilities(): Partial<Record<ProviderProfile, RuntimeProfileCapabilities>> {
  const out: Partial<Record<ProviderProfile, RuntimeProfileCapabilities>> = {};
  for (const profile of PROVIDER_PROFILES as readonly ProviderProfile[]) {
    out[profile] = {
      clientCompatibilities: [...PROFILE_CLIENT_COMPATIBILITIES[profile]],
      servedInboundProtocols: [...PROFILE_SERVED_INBOUND_PROTOCOLS[profile]],
      tokenCountStrategies: [...PROFILE_TOKEN_COUNT_STRATEGIES[profile]],
      defaultClientCompatibility: defaultClientCompatibilityForProfile(profile),
      defaultServedInboundProtocols: defaultServedInboundProtocolsForProfile(profile),
      ...(defaultTokenCountStrategyForProfile(profile)
        ? { defaultTokenCountStrategy: defaultTokenCountStrategyForProfile(profile) }
        : {}),
    };
  }
  return out;
}

function parseClientCompatibilityString(value: string): unknown[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Fall back to comma-separated admin input below.
  }
  return trimmed.split(',').map((item) => item.trim()).filter(Boolean);
}

export function normalizeProtocolPathListValue(value: unknown): RuntimeProtocolPath[] | null | undefined {
  if (value === undefined) return undefined;
  const rawItems = parseProtocolPathItems(value);
  const out: RuntimeProtocolPath[] = [];
  for (const [index, raw] of rawItems.entries()) {
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) {
      throw new Error(`protocol_paths[${index}] must be an object`);
    }
    const record = raw as Record<string, unknown>;
    const inboundProtocol = runtimeToken(String(record.inbound_protocol ?? record.inboundProtocol ?? ''));
    const channel = runtimeToken(String(record.channel ?? record.protocol_strategy ?? record.protocolStrategy ?? ''));
    if (!PUBLISHER_SERVED_INBOUND_PROTOCOL_SET.has(inboundProtocol)) {
      throw new Error(`protocol_paths[${index}].inbound_protocol is invalid: ${inboundProtocol || '<empty>'}`);
    }
    if (!PUBLISHER_DEDICATED_PROTOCOL_CHANNEL_SET.has(channel)) {
      throw new Error(`protocol_paths[${index}].channel is invalid: ${channel || '<empty>'}`);
    }
    out.push({
      inbound_protocol: inboundProtocol as ServedInboundProtocol,
      channel: channel as DedicatedProtocolChannel,
    });
  }
  return out.length ? out : null;
}

function parseProtocolPathItems(value: unknown): unknown[] {
  if (Array.isArray(value)) return value;
  if (value === null || value === '') return [];
  if (typeof value !== 'string') return [];
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    return [];
  }
  return [];
}

function defaultProtocolPathChannel(
  profile: ProviderProfile | null | undefined,
  inboundProtocol: ServedInboundProtocol,
): DedicatedProtocolChannel {
  const upstream = upstreamProtocolForProviderProfile(profile);
  if (upstream === inboundProtocol) return 'passthrough';
  if (upstream === 'openai' && inboundProtocol === 'responses') return 'responses_to_chat';
  if (upstream === 'openai' && inboundProtocol === 'anthropic') return 'anthropic_to_chat';
  return 'passthrough';
}

function parseDelimitedStringList(value: string): unknown[] {
  const trimmed = value.trim();
  if (!trimmed) return [];
  try {
    const parsed = JSON.parse(trimmed);
    if (Array.isArray(parsed)) return parsed;
  } catch {
    // Fall back to comma-separated admin input below.
  }
  return trimmed.split(',').map((item) => item.trim()).filter(Boolean);
}

function sortServedInboundProtocols(values: ServedInboundProtocol[]): ServedInboundProtocol[] {
  const seen = new Set(values);
  return SERVED_INBOUND_PROTOCOLS.filter((protocol) => seen.has(protocol));
}

function providerBaseUrl(rawBaseUrl: string | null | undefined): string {
  return (rawBaseUrl || '').trim().replace(/\/+$/, '');
}
