export interface CorsOriginOptions {
  env?: NodeJS.ProcessEnv;
  names: string[];
  devDefaults: string[];
  label: string;
}

export function resolveCorsOrigins(options: CorsOriginOptions): string[] {
  const env = options.env ?? process.env;
  const configured = firstConfigured(env, options.names);
  const isProduction = env.NODE_ENV === 'production' || env.APP_ENV === 'production';

  if (!configured && isProduction) {
    throw new Error(
      `${options.label} CORS origins must be explicitly configured in production via ${options.names.join(' or ')}`,
    );
  }

  const origins = parseCorsOrigins(configured ?? options.devDefaults.join(','));
  if (origins.length === 0) {
    throw new Error(`${options.label} CORS origins resolved to an empty list`);
  }

  for (const origin of origins) {
    validateOrigin(origin, options.label, isProduction);
  }
  return origins;
}

function firstConfigured(env: NodeJS.ProcessEnv, names: string[]): string | null {
  for (const name of names) {
    const value = env[name]?.trim();
    if (value) return value;
  }
  return null;
}

function parseCorsOrigins(raw: string): string[] {
  return raw
    .split(',')
    .map((origin) => origin.trim())
    .filter(Boolean);
}

function validateOrigin(origin: string, label: string, isProduction: boolean): void {
  if (origin === '*') {
    throw new Error(`${label} CORS origin "*" is not allowed with credentials`);
  }

  let parsed: URL;
  try {
    parsed = new URL(origin);
  } catch {
    throw new Error(`${label} CORS origin is not a valid URL: ${origin}`);
  }

  if (parsed.protocol !== 'http:' && parsed.protocol !== 'https:') {
    throw new Error(`${label} CORS origin must use http or https: ${origin}`);
  }

  if (parsed.origin !== origin) {
    throw new Error(`${label} CORS origin must not include path, query, or hash: ${origin}`);
  }

  if (isProduction && isLocalhost(parsed.hostname)) {
    throw new Error(`${label} CORS origin must not use localhost in production: ${origin}`);
  }
}

function isLocalhost(hostname: string): boolean {
  return hostname === 'localhost' || hostname === '127.0.0.1' || hostname === '[::1]';
}
