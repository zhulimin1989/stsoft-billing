import { normalizeProviderCode } from '../common/utils/provider-code.util';

export const PROVIDER_ACCOUNT_REF_PATTERN = /^[A-Za-z0-9][A-Za-z0-9._:-]{0,127}$/;
export const PROVIDER_ACCOUNT_CODE_PATTERN = /^[a-z0-9][a-z0-9._-]{0,63}$/;
export const PROVIDER_ACCOUNT_IDENTITY_BLOCKING_REFERENCE_ERROR =
  'provider_account_identity_has_blocking_references';

export type ProviderAccountIdentityEvidence = {
  ref: unknown;
  providerCode: unknown;
  status: unknown;
};

export type ProviderResaleRouteIdentityLine = {
  id?: unknown;
  code?: unknown;
  providerAccountIdentityId?: unknown;
};

export type DedicatedProviderAccountSource = {
  providerLineId?: unknown;
  providerAccountIdentityId?: unknown;
  providerLine?: {
    providerCode?: unknown;
    providerAccountIdentityId?: unknown;
  } | null;
  providerCode?: unknown;
  provider?: unknown;
};

export const PROVIDER_ACCOUNT_IDENTITY_EVIDENCE_SELECT = {
  ref: true,
  providerCode: true,
  status: true,
} as const;

/**
 * Query fragment shared by the dedicated writer and its operational audits.
 * Keep the provider-line authority in the selected evidence; snapshots are
 * fallback data only.
 */
export const DEDICATED_PROVIDER_ACCOUNT_SOURCE_SELECT = {
  provider: true,
  providerCode: true,
  providerLineId: true,
  providerAccountIdentityId: true,
  providerLine: {
    select: { providerCode: true, providerAccountIdentityId: true },
  },
  providerAccountIdentity: {
    select: PROVIDER_ACCOUNT_IDENTITY_EVIDENCE_SELECT,
  },
} as const;

export const DEDICATED_PROVIDER_LINE_ACCOUNT_SOURCE_SELECT = {
  providerCode: true,
  apiBaseUrl: true,
  partnerCodeEncrypted: true,
  partnerSecretEncrypted: true,
  providerAccountIdentityId: true,
  providerAccountIdentity: {
    select: PROVIDER_ACCOUNT_IDENTITY_EVIDENCE_SELECT,
  },
} as const;

/**
 * Minimal account binding selected wherever a provider-resale route group is
 * reconstructed. Keeping this fragment next to the policy prevents the admin,
 * fulfillment, Publisher and readiness paths from drifting on the authority.
 */
export const PROVIDER_RESALE_ROUTE_LINE_IDENTITY_SELECT = {
  id: true,
  code: true,
  providerAccountIdentityId: true,
} as const;

/** Canonical provider-code normalization shared by writes, publishing and audits. */
export function normalizeProviderAccountCode(value: unknown): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new Error('providerCode 为必填字符串');
  }
  const normalized = normalizeProviderCode(value);
  if (!PROVIDER_ACCOUNT_CODE_PATTERN.test(normalized)) {
    throw new Error('providerCode 格式不合法');
  }
  return normalized;
}

/** Validate without trimming so persisted whitespace cannot be silently accepted. */
export function requireProviderAccountRef(value: unknown): string {
  if (typeof value !== 'string' || !PROVIDER_ACCOUNT_REF_PATTERN.test(value)) {
    throw new Error('provider_account_ref 格式不合法');
  }
  return value;
}

/**
 * Resolve the authoritative provider for a dedicated upstream. The live
 * provider line wins over the entitlement snapshots, and the result is always
 * canonicalized before it participates in identity validation or comparison.
 */
export function resolveDedicatedProviderCode(source: DedicatedProviderAccountSource): string {
  return normalizeProviderAccountCode(
    source.providerLine?.providerCode
      ?? source.providerCode
      ?? source.provider,
  );
}

export function validateDedicatedProviderAccountIdentityInheritance(
  source: DedicatedProviderAccountSource,
): string {
  const entitlementIdentityId = source.providerAccountIdentityId;
  const providerLineIdentityId = source.providerLine?.providerAccountIdentityId;
  if (typeof providerLineIdentityId !== 'string' || !providerLineIdentityId.trim()) {
    throw new Error('供应商线路未绑定供应商账户身份');
  }
  if (typeof entitlementIdentityId !== 'string' || !entitlementIdentityId.trim()) {
    throw new Error('Provider Entitlement 未继承供应商线路的账户身份');
  }
  if (entitlementIdentityId !== providerLineIdentityId) {
    throw new Error('Provider Entitlement 的账户身份与供应商线路不一致');
  }
  return entitlementIdentityId;
}

/**
 * A multi-line provider-resale route group represents protocol views of one
 * upstream account. Provider compatibility is therefore insufficient: every
 * live line must reference the exact same stable account identity as primary.
 * Draft groups may be entirely unbound only when requireIdentity is false.
 */
export function validateProviderResaleRouteGroupAccountIdentity(
  lines: readonly ProviderResaleRouteIdentityLine[],
  options: {
    requireIdentity?: boolean;
    expectedProviderAccountIdentityId?: unknown;
  } = {},
): string | null {
  if (lines.length === 0) {
    throw new Error('三方转售线路组不能为空');
  }

  const identityId = (value: unknown): string | null => (
    typeof value === 'string' && value.trim().length > 0 ? value : null
  );
  const primaryIdentityId = identityId(lines[0].providerAccountIdentityId);
  if (options.requireIdentity && !primaryIdentityId) {
    throw new Error('三方转售线路组的主线路未绑定供应商账户身份');
  }

  if (Object.prototype.hasOwnProperty.call(options, 'expectedProviderAccountIdentityId')) {
    const expectedIdentityId = identityId(options.expectedProviderAccountIdentityId);
    if (!expectedIdentityId) {
      throw new Error('三方转售线路组缺少权威供应商账户身份');
    }
    if (primaryIdentityId !== expectedIdentityId) {
      throw new Error('三方转售线路组的主线路与权威供应商账户身份不一致');
    }
  }

  for (const line of lines.slice(1)) {
    if (identityId(line.providerAccountIdentityId) !== primaryIdentityId) {
      const label = identityId(line.code) ?? identityId(line.id) ?? '<unknown>';
      throw new Error(`三方转售多线路必须共享同一供应商账户身份: ${label}`);
    }
  }
  return primaryIdentityId;
}

export function validateProviderAccountIdentityForProvider(
  identity: ProviderAccountIdentityEvidence | null | undefined,
  expectedProvider: unknown,
  options: { forbiddenValues?: readonly unknown[] } = {},
): { ref: string; providerCode: string; status: 'active' } {
  if (!identity) throw new Error('供应商账户身份不存在');
  if (identity.status !== 'active') throw new Error('供应商账户身份已停用');

  const ref = requireProviderAccountRef(identity.ref);
  const providerCode = normalizeProviderAccountCode(identity.providerCode);
  const expectedProviderCode = normalizeProviderAccountCode(expectedProvider);
  if (providerCode !== expectedProviderCode) {
    throw new Error(
      `供应商账户身份属于 ${providerCode}，与供应商 ${expectedProviderCode} 不匹配`,
    );
  }
  if (options.forbiddenValues?.some((value) => typeof value === 'string' && value === ref)) {
    throw new Error('provider_account_ref 不能复用凭据或路由标识');
  }
  return { ref, providerCode, status: 'active' };
}
