import { ConfigService } from '@nestjs/config';
import { isProductionEnv } from '../runtime/is-production';

/**
 * Resolve the ENCRYPTION_KEY used for AES-256-GCM (Channel apiKey, payment
 * provider credentials, sync apiKey decryption).
 *
 * Production: key MUST exist and MUST be 64 hex chars (32 bytes). Missing or
 * malformed → throw, so the module fails to boot instead of silently falling
 * back to plaintext passthrough or a fixed `default-key-change-me` value.
 *
 * Non-production: missing key returns empty string — callers then skip
 * encryption (matches existing dev behavior where .env may not be configured).
 */
export function resolveEncryptionKey(
  config: Pick<ConfigService, 'get'>,
  env: NodeJS.ProcessEnv = process.env,
): string {
  const raw = config.get<string>('ENCRYPTION_KEY');
  const key = typeof raw === 'string' ? raw.trim() : '';
  const isProd = isProductionEnv(env);

  if (!key) {
    if (isProd) {
      throw new Error(
        'ENCRYPTION_KEY is required in production. Generate with `openssl rand -hex 32`.',
      );
    }
    return '';
  }

  // In every environment, reject obviously wrong shapes. A 32-byte hex key
  // is 64 chars — anything else is either a placeholder or misconfig.
  if (!/^[0-9a-fA-F]{64}$/.test(key)) {
    if (isProd) {
      throw new Error(
        `ENCRYPTION_KEY must be 64 hex chars (32 bytes); got length ${key.length}`,
      );
    }
    // Dev: log via caller-side warning; return empty to disable encryption.
    return '';
  }

  return key;
}
