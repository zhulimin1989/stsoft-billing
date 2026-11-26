import { createCipheriv, createDecipheriv, hkdfSync, randomBytes } from 'crypto';

const ALGORITHM = 'aes-256-gcm';
const LOCAL_KMS_PREFIX = 'local:';
const LOCAL_KMS_SALT = 'gw-vendor-key-v1';
const LOCAL_KMS_INFO = 'aes-256-gcm';
const LOCAL_KMS_NONCE_LEN = 12;

type ConfigReader = {
  get<T = string>(key: string): T | undefined;
};

export function resolveGatewayLocalSecret(config: ConfigReader): string {
  return firstNonEmpty(
    config.get<string>('KMS_HMAC_SECRET'),
    config.get<string>('GATEWAY_KMS_HMAC_SECRET'),
    config.get<string>('ENCRYPTION_KEY'),
  );
}

export function resolveGatewayLocalSecretFromEnv(
  env: NodeJS.ProcessEnv = process.env,
): string {
  return firstNonEmpty(
    env.KMS_HMAC_SECRET,
    env.GATEWAY_KMS_HMAC_SECRET,
    env.ENCRYPTION_KEY,
  );
}

export function encryptGatewayLocalSecret(plaintext: string, secret: string): string {
  if (!secret.trim()) {
    throw new Error('KMS_HMAC_SECRET is required for gateway local encryption');
  }

  const derived = Buffer.from(hkdfSync(
    'sha256',
    Buffer.from(secret, 'utf8'),
    Buffer.from(LOCAL_KMS_SALT, 'utf8'),
    Buffer.from(LOCAL_KMS_INFO, 'utf8'),
    32,
  ));
  const nonce = randomBytes(LOCAL_KMS_NONCE_LEN);
  const cipher = createCipheriv(ALGORITHM, derived, nonce);
  const encrypted = Buffer.concat([
    cipher.update(plaintext, 'utf8'),
    cipher.final(),
  ]);
  const tag = cipher.getAuthTag();
  const blob = Buffer.concat([nonce, encrypted, tag]);

  return `enc:${LOCAL_KMS_PREFIX}${blob.toString('base64')}`;
}

export function decryptGatewayLocalSecret(ciphertext: string, secret: string): string {
  if (!secret.trim()) {
    throw new Error('KMS_HMAC_SECRET is required for gateway local decryption');
  }
  const payload = ciphertext.startsWith('enc:')
    ? ciphertext.slice('enc:'.length)
    : ciphertext;
  if (!payload.startsWith(LOCAL_KMS_PREFIX)) {
    throw new Error("gateway local secret is missing 'local:' prefix");
  }
  const blob = Buffer.from(payload.slice(LOCAL_KMS_PREFIX.length), 'base64');
  if (blob.length < LOCAL_KMS_NONCE_LEN + 16) {
    throw new Error('gateway local secret is too short');
  }

  const nonce = blob.subarray(0, LOCAL_KMS_NONCE_LEN);
  const encryptedWithTag = blob.subarray(LOCAL_KMS_NONCE_LEN);
  const encrypted = encryptedWithTag.subarray(0, encryptedWithTag.length - 16);
  const tag = encryptedWithTag.subarray(encryptedWithTag.length - 16);
  const decipher = createDecipheriv(ALGORITHM, deriveGatewayLocalKey(secret), nonce);
  decipher.setAuthTag(tag);

  return Buffer.concat([
    decipher.update(encrypted),
    decipher.final(),
  ]).toString('utf8');
}

export function isGatewayLocalSecret(value: string): boolean {
  return value.startsWith(`enc:${LOCAL_KMS_PREFIX}`) || value.startsWith(LOCAL_KMS_PREFIX);
}

export function isLegacyAesGcmSecret(value: string): boolean {
  return value.split(':').length === 3 && !value.startsWith('enc:');
}

function deriveGatewayLocalKey(secret: string): Buffer {
  return Buffer.from(hkdfSync(
    'sha256',
    Buffer.from(secret, 'utf8'),
    Buffer.from(LOCAL_KMS_SALT, 'utf8'),
    Buffer.from(LOCAL_KMS_INFO, 'utf8'),
    32,
  ));
}

function firstNonEmpty(...values: Array<string | undefined>): string {
  for (const value of values) {
    const trimmed = value?.trim();
    if (trimmed) return trimmed;
  }
  return '';
}
