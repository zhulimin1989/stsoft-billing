export type ProviderLineDedicatedClientProtocol = 'anthropic' | 'openai' | 'responses';

export type ProviderLineDedicatedProtocolStrategy =
  | 'passthrough'
  | 'responses_to_chat'
  | 'anthropic_to_chat';

export type ProviderLineDedicatedEndpoint = {
  client_protocol: ProviderLineDedicatedClientProtocol;
  provider_id: string;
  protocol_strategy?: ProviderLineDedicatedProtocolStrategy;
  base_url?: string;
  provider_profile?: string;
  name?: string;
  code?: string;
  owned_by?: string;
  status?: string;
  client_compatibility?: string[];
  served_inbound_protocols?: Array<'anthropic' | 'gemini' | 'openai' | 'responses'>;
  capabilities?: string[];
  token_count_strategy?: string;
  priority?: number;
  weight?: number;
};

export type ProviderLineRuntimeConfig = {
  id: string;
  code: string;
  name: string;
  providerCode: string;
  providerAccountIdentityId: string | null;
  providerName: string | null;
  adapterType: string;
  environment: string;
  apiBaseUrl: string;
  authType: string;
  partnerCode: string | null;
  partnerSecretKey: string | null;
  qpsConfig: Record<string, unknown> | null;
  capabilities: Record<string, unknown> | null;
  dedicatedEndpoints: ProviderLineDedicatedEndpoint[];
  metadata: Record<string, unknown> | null;
};

export type ProviderProduct = {
  upstreamProductId: string;
  productName: string;
  salePrice?: string | number | null;
  currency?: string | null;
  productCycle?: string | null;
  productType?: string | null;
  productBigTitle?: string | null;
  productSmallTitle?: string | null;
  description?: string | null;
  productIntroduction?: string | null;
  salesVolume?: number | null;
  dailySalesLimit?: number | null;
  monthlySalesLimit?: number | null;
  yearlySalesLimit?: number | null;
  maxSalesLimit?: number | null;
  status?: string | null;
  raw: Record<string, unknown>;
};

export type ProviderCreateOrderInput = {
  partnerUserId: string;
  partnerOrderNo: string;
  upstreamProductId: string;
  partnerUserName?: string | null;
};

export type ProviderCreateOrderResult = {
  upstreamOrderId: string | null;
  apiKey: string;
  secretKey: string;
  credentialFormat: 'apiKey.secretKey';
  productStartTime: string | null;
  productEndTime: string | null;
  raw: Record<string, unknown>;
};

export type QueryCustomerUsageInput = {
  upstreamApiKey?: string | null;
  upstreamSecretKey?: string | null;
  upstreamProductId: string | null;
  upstreamOrderId: string | null;
  partnerUserId: string | null;
  partnerOrderNo: string | null;
};

export type ProviderUsageWindow = {
  progressPercent: number | null;
  resetAt: string | null;
};

export type ProviderUsageQuotaProgress = {
  models: {
    fiveHour: ProviderUsageWindow | null;
    weekly: ProviderUsageWindow | null;
  } | null;
  tools: {
    monthly: ProviderUsageWindow | null;
  } | null;
};

export type ProviderUsageModelItem = {
  modelCode: string | null;
  usage: number | null;
};

export type ProviderUsageToolItem = {
  toolCode: string | null;
  toolName: string | null;
  usage: number | null;
};

export type ProviderUsageSummaryBucket = {
  models: {
    total: number | null;
    items: ProviderUsageModelItem[];
  } | null;
  tools: {
    total: number | null;
    items: ProviderUsageToolItem[];
  } | null;
};

export type ProviderUsageSummary = {
  day: ProviderUsageSummaryBucket | null;
  last7Days: ProviderUsageSummaryBucket | null;
  last30Days: ProviderUsageSummaryBucket | null;
};

export type ProviderUsageResult = {
  level: string | null;
  quotaProgress: ProviderUsageQuotaProgress | null;
  usageSummary: ProviderUsageSummary | null;
  updatedAt: string | null;
  raw: Record<string, unknown>;
};

export interface CodingPlanProviderAdapter {
  readonly adapterType: string;

  listProducts(line: ProviderLineRuntimeConfig): Promise<ProviderProduct[]>;

  createOrder(
    line: ProviderLineRuntimeConfig,
    input: ProviderCreateOrderInput,
  ): Promise<ProviderCreateOrderResult>;

  queryCustomerUsage?(
    line: ProviderLineRuntimeConfig,
    input: QueryCustomerUsageInput,
  ): Promise<ProviderUsageResult>;
}
