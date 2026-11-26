export const SEEDANCE_CN_BASE_URL = 'https://ark.cn-beijing.volces.com';

export type SeedanceRealm = 'cn';

/**
 * Logical model to upstream model mapping, partitioned by sovereignty realm.
 * The values are deliberately explicit even when they currently equal the
 * logical names; adding a realm or model requires an intentional code change.
 */
export const SEEDANCE_UPSTREAM_MODELS_BY_REALM: Readonly<
  Record<SeedanceRealm, Readonly<Record<string, string>>>
> = {
  cn: {
    'doubao-seedance-2-5-260628': 'doubao-seedance-2-5-260628',
    'doubao-seedance-2-0-260128': 'doubao-seedance-2-0-260128',
    'doubao-seedance-2-0-fast-260128': 'doubao-seedance-2-0-fast-260128',
  },
};

export const SEEDANCE_ROUTABLE_CN_MODELS = Object.freeze(
  Object.keys(SEEDANCE_UPSTREAM_MODELS_BY_REALM.cn),
);

export const SEEDANCE_CATALOG_MODELS = Object.freeze([
  ...SEEDANCE_ROUTABLE_CN_MODELS,
  'doubao-seedance-1-5-pro-251215',
  'doubao-seedance-1-0-pro-250528',
  'doubao-seedance-1-0-pro-fast-251015',
]);

export function isSeedanceVideoSdkType(sdkType: string | null | undefined): boolean {
  return (sdkType ?? '').trim().toLowerCase().replace(/[\s-]+/g, '_') === 'seedance_video';
}

export function seedanceRealmForBaseUrl(rawBaseUrl: string | null | undefined): SeedanceRealm {
  const value = (rawBaseUrl ?? '').trim();
  try {
    const url = new URL(value);
    const path = url.pathname.replace(/\/+$/, '');
    if (
      url.protocol === 'https:'
      && url.hostname === 'ark.cn-beijing.volces.com'
      && (path === '' || path === '/api/v3')
      && !url.username
      && !url.password
      && !url.search
      && !url.hash
    ) {
      return 'cn';
    }
  } catch {
    // The fail-loud error below intentionally avoids accepting malformed URLs.
  }
  throw new Error(
    `Seedance channel realm is unverified for baseUrl=${value || '<empty>'}; only CN ${SEEDANCE_CN_BASE_URL} is routable`,
  );
}

export function seedanceUpstreamModelFor(
  rawBaseUrl: string | null | undefined,
  logicalModel: string,
): string {
  const realm = seedanceRealmForBaseUrl(rawBaseUrl);
  const upstreamModel = SEEDANCE_UPSTREAM_MODELS_BY_REALM[realm][logicalModel];
  if (!upstreamModel) {
    throw new Error(
      `Seedance logical model ${logicalModel} has no explicit ${realm.toUpperCase()} upstream mapping`,
    );
  }
  return upstreamModel;
}
