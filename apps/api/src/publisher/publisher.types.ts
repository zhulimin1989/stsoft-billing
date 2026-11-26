import type {
  ClientCompatibility,
  CompatAPIType,
  KeyMeta,
  ProviderProfile,
  TokenCountStrategy,
} from '@raytone-lab/publisher-contracts';

export type PublisherNamespace = 'user' | 'billing' | 'admin' | 'sre';

export type PublisherReplayScope = 'all' | 'api_keys' | 'key_balances' | 'admin' | 'platform';

export type PublisherHttpMethod = 'GET' | 'POST' | 'PUT' | 'PATCH' | 'DELETE';

export interface PublisherAcceptedResponse {
  batch_id?: string;
  provider_batches?: string[];
  keypool_batches?: string[];
  model_catalog_batches?: string[];
  model_route_batches?: string[];
  product_policy_batches?: string[];
  product_policy_delete_batches?: string[];
  status: 'accepted';
  schema_version?: number;
  effective_policies?: unknown[];
  warnings?: unknown[];
  key_admission_delivery?: PublisherKeyAdmissionDeliveryReceipt;
}

export interface PublisherRequestOptions {
  idempotencyKey?: string;
  requestId?: string;
  timeoutMs?: number;
}

export interface PublisherRefundDrainSnapshot {
  protocol_version: 1;
  drain_id: string;
  key_count: number;
  in_flight: number;
  request_seen_key_count: number;
  ready: boolean;
}

export interface PublisherErrorEnvelope {
  error?: {
    code?: string;
    message?: string;
    details?: unknown;
  };
}

export type PublisherKeyMeta = KeyMeta;
export type PublisherDedicatedUpstream = NonNullable<PublisherKeyMeta['dedicated_upstream']>;
export type PublisherEffectivePolicy = NonNullable<PublisherKeyMeta['policies']>[number];
export type PublisherResourceBinding = NonNullable<PublisherKeyMeta['resource_bindings']>[number];
export type PublisherGuardrailPolicy = NonNullable<PublisherKeyMeta['guardrails']>;

export type PublisherBalanceReason =
  | 'balance_depleted'
  | 'key_spend_limit_exhausted'
  | 'workspace_budget_exhausted'
  | 'rolling_quota_exhausted'
  | 'manual_freeze'
  | 'account_debt'
  | 'settlement_risk_limit_exceeded'
  // 结算侧待人工复核（settlement_policy_review）。从 billing_review 里单独拆出来是因为
  // 客户拿到的 402 code 就是这个字符串：2026-09-07 国内 prod 那次，客户看到 billing_review
  // 以为自己欠费/账务有问题，实际是平台把模型下架、把他积压的历史事件打成了待复核。
  | 'settlement_review'
  | 'billing_review';

export interface PublisherKeyAdmissionDecision {
  decision_id: string;
  decision_version: number;
}

export interface PublisherKeyBalance extends PublisherKeyAdmissionDecision {
  has_balance: boolean;
  reason?: PublisherBalanceReason | '';
}

export interface PublisherKeyActivation extends PublisherKeyAdmissionDecision {
  key_meta: PublisherKeyMeta;
  has_balance: boolean;
  reason?: PublisherBalanceReason | '';
}

export type PublisherKeyAdmissionDeliveryStatus =
  | 'pending'
  | 'applied'
  | 'idempotent'
  | 'superseded'
  | 'conflict'
  | 'dead_letter'
  | 'unverified'
  | 'mixed';

export interface PublisherKeyAdmissionDeliveryReceipt {
  batch_id: string;
  status: PublisherKeyAdmissionDeliveryStatus;
  total: number;
  pending_count: number;
  applied_count: number;
  idempotent_count: number;
  superseded_count: number;
  conflict_count: number;
  dead_letter_count: number;
  unverified_count: number;
  last_error?: string;
}

export type PublisherProductCredentialSource = 'keypool' | 'dedicated_upstream';
export type PublisherProductModelScopeMode = 'plan_configured' | 'product_allowlist' | 'upstream_inherited';
export type PublisherProductFallbackPolicy = 'none' | 'within_product' | 'within_provider' | 'platform_default';
export type PublisherProductRuntimeBillingMode =
  | 'payg_balance'
  | 'subscription_credits'
  | 'token_plan_quota'
  | 'included_upstream';
export type PublisherProductRouteStrategy = 'priority' | 'weight' | 'latency' | 'least_busy';

export interface PublisherProvider {
  id: string;
  code: string;
  name: string;
  base_url: string;
  provider_profile?: PublisherProviderProfile;
  owned_by?: string;
  client_compatibility?: PublisherClientCompatibility[];
  token_count_strategy?: PublisherTokenCountStrategy;
  path_prefix?: string;
  status: 'active' | 'disabled';
  key_strategy?: 'priority' | 'weight' | '';
}

export interface PublisherProviderCompilePreview {
  provider: PublisherProvider;
  default_protocol_binding?: string;
  binding_names?: string[];
}

export type PublisherProviderProfile = ProviderProfile;
export type PublisherClientCompatibility = ClientCompatibility;
export type PublisherTokenCountStrategy = TokenCountStrategy;

export type PublisherApiType = CompatAPIType;

export interface PublisherPlatformConfig {
  platform_rpm?: number;
  platform_cc?: number;
  default_provider_strategy?: 'priority' | 'weight' | 'latency' | 'least_busy';
  default_route_policy?: PublisherRoutePolicyConfig;
  default_timeout_ms?: number;
  stream_timeout_ms?: number;
  first_token_timeout_ms?: number;
  attempt_timeout_ms?: number;
  max_body_size?: number;
  max_fallback_depth?: number;
  auth?: {
    pre_auth_ip_rpm?: number;
    abuse_fail_threshold?: number;
    idempotency_ttl_sec?: number;
  };
  retry_budget?: {
    max_keys_per_provider?: number;
    max_providers?: number;
    total_wall_time_ms?: number;
  };
  responses_affinity_enabled?: boolean;
  operational?: {
    idempotency_attr?: string;
    kafka_partition_attr?: string;
    full_detail_attr?: string;
  };
}

export interface PublisherRoutePolicyConfig {
  preferred_providers?: string[];
  allow_fallback?: boolean;
  compliance_tags?: string[];
}
