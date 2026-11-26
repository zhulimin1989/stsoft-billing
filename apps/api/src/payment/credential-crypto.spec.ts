import { createCipheriv, randomBytes } from 'crypto';
import { decryptCredentials, encryptCredentials, maskCredential } from './credential-crypto';

const KEY = 'a'.repeat(64);

function encryptLegacyCredential(plaintext: string, key: string): string {
  const keyBuf = Buffer.from(key.trim().slice(0, 32), 'utf8');
  const iv = randomBytes(12);
  const cipher = createCipheriv('aes-256-gcm', keyBuf, iv);
  const encrypted = Buffer.concat([cipher.update(plaintext, 'utf8'), cipher.final()]);
  const tag = cipher.getAuthTag();
  return Buffer.concat([iv, tag, encrypted]).toString('base64');
}

describe('credential crypto', () => {
  it('encrypts new credentials with a versioned hex-derived AES key', () => {
    const encrypted = encryptCredentials('secret-json', KEY);

    expect(encrypted).toMatch(/^v2:/);
    expect(decryptCredentials(encrypted, KEY)).toBe('secret-json');
  });

  it('rejects keys that would previously have been padded or truncated', () => {
    expect(() => encryptCredentials('secret-json', 'short-key')).toThrow(
      /ENCRYPTION_KEY must be 64 hex chars/,
    );
    expect(() => decryptCredentials('v2:not-real', 'z'.repeat(64))).toThrow(
      /ENCRYPTION_KEY must be 64 hex chars/,
    );
  });

  it('can still read legacy unversioned credentials with a valid key', () => {
    const legacy = encryptLegacyCredential('legacy-json', KEY);

    expect(decryptCredentials(legacy, KEY)).toBe('legacy-json');
  });

  it('rejects malformed ciphertext before attempting to decrypt', () => {
    expect(() => decryptCredentials('v2:abcd', KEY)).toThrow(
      /Invalid encrypted credential format/,
    );
  });

  it('masks short and long credentials', () => {
    expect(maskCredential('short')).toBe('****');
    expect(maskCredential('sk_live_123456')).toBe('sk_l****3456');
  });
});
