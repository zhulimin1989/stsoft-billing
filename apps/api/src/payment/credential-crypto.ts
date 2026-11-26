import { createCipheriv, createDecipheriv, randomBytes } from 'crypto';

const ALGO = 'aes-256-gcm';
const IV_LENGTH = 12;
const AUTH_TAG_LENGTH = 16;
const VERSION_PREFIX = 'v2:';

export function encryptCredentials(plaintext: string, key: string): string {
  const keyBuf = deriveCredentialKey(key);
  const iv = randomBytes(IV_LENGTH);
  const cipher = createCipheriv(ALGO, keyBuf, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  // Format: v2:base64(iv + tag + encrypted)
  return `${VERSION_PREFIX}${Buffer.concat([iv, tag, encrypted]).toString('base64')}`;
}

export function decryptCredentials(ciphertext: string, key: string): string {
  const isV2 = ciphertext.startsWith(VERSION_PREFIX);
  const payload = isV2 ? ciphertext.slice(VERSION_PREFIX.length) : ciphertext;
  const keyBuf = isV2 ? deriveCredentialKey(key) : deriveLegacyCredentialKey(key);
  const buf = Buffer.from(payload, 'base64');
  if (buf.length < IV_LENGTH + AUTH_TAG_LENGTH) {
    throw new Error('Invalid encrypted credential format');
  }
  const iv = buf.subarray(0, IV_LENGTH);
  const tag = buf.subarray(IV_LENGTH, IV_LENGTH + AUTH_TAG_LENGTH);
  const encrypted = buf.subarray(IV_LENGTH + AUTH_TAG_LENGTH);
  const decipher = createDecipheriv(ALGO, keyBuf, iv);
  decipher.setAuthTag(tag);
  return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
}

export function maskCredential(value: string): string {
  if (value.length <= 8) return '****';
  return value.slice(0, 4) + '****' + value.slice(-4);
}

function deriveCredentialKey(key: string): Buffer {
  const normalized = normalizeCredentialKey(key);
  return Buffer.from(normalized, 'hex');
}

function deriveLegacyCredentialKey(key: string): Buffer {
  const normalized = normalizeCredentialKey(key);
  return Buffer.from(normalized.slice(0, 32), 'utf8');
}

function normalizeCredentialKey(key: string): string {
  const normalized = key.trim();
  if (!/^[0-9a-fA-F]{64}$/.test(normalized)) {
    throw new Error('ENCRYPTION_KEY must be 64 hex chars (32 bytes)');
  }
  return normalized;
}
