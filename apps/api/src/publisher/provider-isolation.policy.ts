function objectValue(value: unknown): Record<string, unknown> {
  return value && typeof value === 'object' && !Array.isArray(value)
    ? value as Record<string, unknown>
    : {};
}

function stringValue(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function stringArrayValue(value: unknown): string[] {
  if (!Array.isArray(value)) return [];
  return value
    .filter((item): item is string => typeof item === 'string')
    .map((item) => item.trim())
    .filter(Boolean);
}

const PROVIDER_VISIBILITY_DEDICATED_ONLY = 'dedicated_only';
const PROVIDER_CREDENTIAL_SOURCE_DEDICATED_UPSTREAM = 'dedicated_upstream';
const PROVIDER_ROUTE_KIND_DEDICATED = 'dedicated_route';

export type ProviderEndpointIsolation = {
  visibility?: 'product_route' | 'dedicated_only' | 'internal';
  credential_source?: 'keypool' | 'dedicated_upstream';
  allowed_route_kinds?: [
    'dedicated_route' | 'model_route' | 'product_route',
    ...Array<'dedicated_route' | 'model_route' | 'product_route'>,
  ];
  owner_scope?: {
    tenant_id?: string;
    product_id?: string;
    entitlement_id?: string;
  };
};

type ProviderOwnerScope = NonNullable<ProviderEndpointIsolation['owner_scope']>;

function providerOwnerScope(value: unknown): ProviderOwnerScope | undefined {
  const raw = objectValue(value);
  const tenantId = stringValue(raw.tenant_id ?? raw.tenantId);
  const productId = stringValue(raw.product_id ?? raw.productId);
  const entitlementId = stringValue(raw.entitlement_id ?? raw.entitlementId);
  if (!tenantId && !productId && !entitlementId) return undefined;
  return {
    ...(tenantId ? { tenant_id: tenantId } : {}),
    ...(productId ? { product_id: productId } : {}),
    ...(entitlementId ? { entitlement_id: entitlementId } : {}),
  };
}

/**
 * Parse and validate the ProductChannel isolation metadata used by the
 * RuntimeIntent builder. Mutating services must call the same policy before
 * persistence so invalid rows never become delayed Publisher failures.
 */
export function providerEndpointIsolationFromMetadata(
  metadata: unknown,
  source: string,
): ProviderEndpointIsolation | undefined {
  const raw = objectValue(metadata);
  const isolationRaw = objectValue(
    raw.provider_isolation
      ?? raw.providerIsolation
      ?? raw.runtime_provider_isolation
      ?? raw.runtimeProviderIsolation
      ?? (
        raw.visibility || raw.credential_source || raw.credentialSource || raw.allowed_route_kinds
          || raw.allowedRouteKinds || raw.owner_scope || raw.ownerScope
          ? raw
          : undefined
      ),
  );
  if (Object.keys(isolationRaw).length === 0) return undefined;

  const visibility = stringValue(isolationRaw.visibility);
  if (visibility && visibility !== 'product_route' && visibility !== 'dedicated_only' && visibility !== 'internal') {
    throw new Error(`${source}.visibility is invalid`);
  }
  const credentialSource = stringValue(
    isolationRaw.credential_source ?? isolationRaw.credentialSource,
  );
  if (
    credentialSource
    && credentialSource !== 'keypool'
    && credentialSource !== 'dedicated_upstream'
  ) {
    throw new Error(`${source}.credential_source is invalid`);
  }
  const routeKinds = stringArrayValue(
    isolationRaw.allowed_route_kinds ?? isolationRaw.allowedRouteKinds,
  );
  for (const kind of routeKinds) {
    if (kind !== 'dedicated_route' && kind !== 'model_route' && kind !== 'product_route') {
      throw new Error(`${source}.allowed_route_kinds contains invalid route kind: ${kind}`);
    }
  }
  const ownerScope = providerOwnerScope(
    isolationRaw.owner_scope ?? isolationRaw.ownerScope,
  );
  const requiresDedicatedIsolation = visibility === PROVIDER_VISIBILITY_DEDICATED_ONLY
    || credentialSource === PROVIDER_CREDENTIAL_SOURCE_DEDICATED_UPSTREAM
    || routeKinds.includes(PROVIDER_ROUTE_KIND_DEDICATED);
  if (requiresDedicatedIsolation) {
    if (visibility !== PROVIDER_VISIBILITY_DEDICATED_ONLY) {
      throw new Error(`${source}.visibility must be dedicated_only for dedicated provider isolation`);
    }
    if (credentialSource !== PROVIDER_CREDENTIAL_SOURCE_DEDICATED_UPSTREAM) {
      throw new Error(`${source}.credential_source must be dedicated_upstream`);
    }
    if (routeKinds.length !== 1 || routeKinds[0] !== PROVIDER_ROUTE_KIND_DEDICATED) {
      throw new Error(`${source}.allowed_route_kinds must be [dedicated_route]`);
    }
    if (ownerScope?.tenant_id || ownerScope?.entitlement_id) {
      throw new Error(
        `${source}.owner_scope must not include tenant_id or entitlement_id for shared dedicated providers`,
      );
    }
  }

  return {
    ...(visibility
      ? { visibility: visibility as ProviderEndpointIsolation['visibility'] }
      : {}),
    ...(credentialSource
      ? { credential_source: credentialSource as ProviderEndpointIsolation['credential_source'] }
      : {}),
    ...(routeKinds.length
      ? { allowed_route_kinds: routeKinds as ProviderEndpointIsolation['allowed_route_kinds'] }
      : {}),
    ...(ownerScope ? { owner_scope: ownerScope } : {}),
  };
}

export function isStrictDedicatedProviderIsolation(
  isolation: ProviderEndpointIsolation | undefined,
): boolean {
  return isolation?.visibility === PROVIDER_VISIBILITY_DEDICATED_ONLY
    && isolation.credential_source === PROVIDER_CREDENTIAL_SOURCE_DEDICATED_UPSTREAM
    && isolation.allowed_route_kinds?.length === 1
    && isolation.allowed_route_kinds[0] === PROVIDER_ROUTE_KIND_DEDICATED;
}

/**
 * Dedicated ProductChannels receive credentials from the user's entitlement,
 * not from Channel.apiKey. Only the complete isolation tuple may bypass the
 * Channel provider-account binding requirement.
 */
export function hasStrictDedicatedProviderIsolation(metadata: unknown): boolean {
  try {
    return isStrictDedicatedProviderIsolation(
      providerEndpointIsolationFromMetadata(metadata, 'provider_isolation'),
    );
  } catch {
    return false;
  }
}
