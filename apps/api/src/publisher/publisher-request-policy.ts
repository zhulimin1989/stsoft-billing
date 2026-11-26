export const LEGACY_PROVIDER_PUBLISH_RETIRED_CODE = 'LEGACY_PROVIDER_PUBLISH_RETIRED';

export const LEGACY_PROVIDER_PUBLISH_RETIRED_MESSAGE =
  'Legacy provider PUT 已退役；请从 billing 当前 source of truth 重建 RuntimeIntent，并使用 providers:from-intent';

export const LEGACY_PROVIDER_PUBLISH_RETIRED_ERROR =
  `${LEGACY_PROVIDER_PUBLISH_RETIRED_CODE}: ${LEGACY_PROVIDER_PUBLISH_RETIRED_MESSAGE}`;

export const RUNTIME_INTENT_V1_RETIRED_CODE = 'RUNTIME_INTENT_V1_RETIRED';

export const RUNTIME_INTENT_V1_RETIRED_MESSAGE =
  'RuntimeIntent v1 已退役；请从 billing 当前 source of truth 重建 schema_version=2 的 RuntimeIntent，并使用新的幂等键';

export const RUNTIME_INTENT_V1_RETIRED_ERROR =
  `${RUNTIME_INTENT_V1_RETIRED_CODE}: ${RUNTIME_INTENT_V1_RETIRED_MESSAGE}`;

export const LEGACY_KEY_POOL_PUBLISH_RETIRED_CODE = 'LEGACY_KEY_POOL_PUBLISH_RETIRED';

export const LEGACY_KEY_POOL_PUBLISH_RETIRED_MESSAGE =
  'KeyPool 直接变更已退役；请从 billing 当前 source of truth 重建 RuntimeIntent';

export const LEGACY_KEY_POOL_PUBLISH_RETIRED_ERROR =
  `${LEGACY_KEY_POOL_PUBLISH_RETIRED_CODE}: ${LEGACY_KEY_POOL_PUBLISH_RETIRED_MESSAGE}`;

export const DEDICATED_KEY_META_V1_RETIRED_CODE = 'DEDICATED_KEY_META_V1_RETIRED';

export const DEDICATED_KEY_META_V1_RETIRED_MESSAGE =
  '缺少 provider_account_ref 的 dedicated KeyMeta 已退役；请从 billing 当前 source of truth 重新生成并使用新的幂等键';

export const DEDICATED_KEY_META_V1_RETIRED_ERROR =
  `${DEDICATED_KEY_META_V1_RETIRED_CODE}: ${DEDICATED_KEY_META_V1_RETIRED_MESSAGE}`;

export interface PublisherRequestPolicyInput {
  method: string;
  path: string;
  body?: unknown;
  resourceType?: string | null;
}

export interface RetiredPublisherRequest {
  code: string;
  message: string;
  error: string;
}

export function retiredPublisherRequest(
  input: PublisherRequestPolicyInput,
): RetiredPublisherRequest | null {
  if (isLegacyProviderPublishPut(input)) {
    return {
      code: LEGACY_PROVIDER_PUBLISH_RETIRED_CODE,
      message: LEGACY_PROVIDER_PUBLISH_RETIRED_MESSAGE,
      error: LEGACY_PROVIDER_PUBLISH_RETIRED_ERROR,
    };
  }
  if (isLegacyKeyPoolMutation(input)) {
    return {
      code: LEGACY_KEY_POOL_PUBLISH_RETIRED_CODE,
      message: LEGACY_KEY_POOL_PUBLISH_RETIRED_MESSAGE,
      error: LEGACY_KEY_POOL_PUBLISH_RETIRED_ERROR,
    };
  }
  if (isRuntimeIntentV1Write(input)) {
    return {
      code: RUNTIME_INTENT_V1_RETIRED_CODE,
      message: RUNTIME_INTENT_V1_RETIRED_MESSAGE,
      error: RUNTIME_INTENT_V1_RETIRED_ERROR,
    };
  }
  if (isDedicatedKeyMetaWithoutProviderAccountRef(input)) {
    return {
      code: DEDICATED_KEY_META_V1_RETIRED_CODE,
      message: DEDICATED_KEY_META_V1_RETIRED_MESSAGE,
      error: DEDICATED_KEY_META_V1_RETIRED_ERROR,
    };
  }
  return null;
}

export function isLegacyProviderPublishPut(input: PublisherRequestPolicyInput): boolean {
  if (String(input.method ?? '').trim().toUpperCase() !== 'PUT') return false;

  const resourceType = String(input.resourceType ?? '').trim().toLowerCase();
  const path = normalizedPublisherPath(input.path);
  return resourceType === 'provider'
    || isCollectionPath(path, '/admin/api/v1/providers')
    || isCollectionPath(path, '/ops/api/v1/providers');
}

export function isRuntimeIntentV1Write(input: PublisherRequestPolicyInput): boolean {
  if (String(input.method ?? '').trim().toUpperCase() !== 'POST') return false;

  const path = normalizedPublisherPath(input.path);
  if (
    path !== '/admin/api/v1/providers:from-intent'
    && path !== '/ops/api/v1/providers:from-intent'
  ) {
    return false;
  }

  return isRecord(input.body) && input.body.schema_version === 1;
}

export function isLegacyKeyPoolMutation(input: PublisherRequestPolicyInput): boolean {
  const method = normalizedMethod(input.method);
  if (!['PUT', 'POST', 'DELETE'].includes(method)) return false;

  const resourceType = String(input.resourceType ?? '').trim().toLowerCase();
  const path = normalizedPublisherPath(input.path);
  return resourceType === 'key_pool'
    || isCollectionPath(path, '/admin/api/v1/key-pools')
    || isCollectionPath(path, '/ops/api/v1/key-pools');
}

export function isDedicatedKeyMetaWithoutProviderAccountRef(
  input: PublisherRequestPolicyInput,
): boolean {
  const method = normalizedMethod(input.method);
  const path = normalizedPublisherPath(input.path);
  const items = dedicatedKeyMetaWriteItems(method, path, input.body);
  if (!items) return false;

  return items.some((item) => {
    if (!isRecord(item) || !isRecord(item.dedicated_upstream)) return false;
    const ref = item.dedicated_upstream.provider_account_ref;
    return typeof ref !== 'string' || ref.trim().length === 0;
  });
}

function dedicatedKeyMetaWriteItems(
  method: string,
  path: string,
  body: unknown,
): readonly unknown[] | null {
  const isUserOrPortalPath = (suffix: string) =>
    path === `/user/api/v1/${suffix}` || path === `/portal/api/v1/${suffix}`;

  if (method === 'PUT' && isUserOrPortalPath('keys')) {
    return [body];
  }
  if (
    method === 'POST'
    && isUserOrPortalPath('keys/bulk')
    && isRecord(body)
    && Array.isArray(body.items)
  ) {
    return body.items;
  }
  return null;
}

function normalizedMethod(value: string): string {
  return String(value ?? '').trim().toUpperCase();
}

function normalizedPublisherPath(value: string): string {
  let path = String(value ?? '').trim();
  try {
    path = parsePublisherPath(path);
  } catch {
    return cleanPathSeparators(path).toLowerCase();
  }

  // URL parsing resolves literal/encoded dot segments. Decode and reparse a
  // bounded number of times as a conservative guard against encoded route
  // segments being decoded by fetch, proxies, or the publisher router.
  for (let index = 0; index < 3; index += 1) {
    try {
      const decoded = decodeURIComponent(path);
      if (decoded === path) break;
      path = parsePublisherPath(decoded);
    } catch {
      break;
    }
  }
  return cleanPathSeparators(path).toLowerCase();
}

function isCollectionPath(path: string, collectionPath: string): boolean {
  return path === collectionPath || path.startsWith(`${collectionPath}/`);
}

function parsePublisherPath(value: string): string {
  const slashNormalized = value.replace(/\\/g, '/');
  if (/^[a-z][a-z\d+.-]*:\/\//i.test(slashNormalized)) {
    return cleanPathSeparators(new URL(slashNormalized).pathname);
  }
  const path = cleanPathSeparators(slashNormalized);
  const rootedPath = path.startsWith('/') ? path : `/${path}`;
  // Prefix the origin explicitly so leading // remains a path rather than
  // being interpreted as a protocol-relative authority.
  return cleanPathSeparators(new URL(`https://publisher.invalid${rootedPath}`).pathname);
}

function cleanPathSeparators(value: string): string {
  return value.replace(/\\/g, '/').replace(/\/{2,}/g, '/');
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}
