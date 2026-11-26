import { createHash, createHmac } from 'crypto';

export function apiKeyHashSecret(env: NodeJS.ProcessEnv = process.env): string {
  return (env.API_KEY_HASH_SECRET || env.USER_API_KEY_HASH_SECRET || '').trim();
}

export function sha256ApiKeyHash(rawKey: string): string {
  return createHash('sha256').update(rawKey).digest('hex');
}

export function hmacApiKeyHash(
  rawKey: string,
  env: NodeJS.ProcessEnv = process.env,
): string | null {
  const secret = apiKeyHashSecret(env);
  if (!secret) return null;
  return createHmac('sha256', secret).update(rawKey).digest('hex');
}

export function hashApiKey(rawKey: string, env: NodeJS.ProcessEnv = process.env): string {
  return hmacApiKeyHash(rawKey, env) ?? sha256ApiKeyHash(rawKey);
}

export function apiKeyHashCandidates(
  rawKey: string,
  env: NodeJS.ProcessEnv = process.env,
): string[] {
  const primary = hashApiKey(rawKey, env);
  const legacy = sha256ApiKeyHash(rawKey);
  return legacy && legacy !== primary ? [primary, legacy] : [primary];
}
