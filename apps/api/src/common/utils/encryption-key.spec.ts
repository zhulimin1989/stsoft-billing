import { resolveEncryptionKey } from './encryption-key';

function mockConfig(value: string | undefined) {
  return { get: jest.fn().mockReturnValue(value) } as any;
}

const VALID_HEX_KEY = 'a'.repeat(64); // 32 bytes

describe('resolveEncryptionKey', () => {
  describe('production', () => {
    const prodEnv = { NODE_ENV: 'production' } as NodeJS.ProcessEnv;

    it('returns the key when valid 64 hex chars', () => {
      expect(resolveEncryptionKey(mockConfig(VALID_HEX_KEY), prodEnv)).toBe(VALID_HEX_KEY);
    });

    it('throws when key is missing', () => {
      expect(() => resolveEncryptionKey(mockConfig(undefined), prodEnv)).toThrow(
        /ENCRYPTION_KEY is required in production/,
      );
    });

    it('treats APP_ENV=production as production', () => {
      const appProdEnv = {
        NODE_ENV: 'development',
        APP_ENV: 'production',
      } as NodeJS.ProcessEnv;
      expect(() => resolveEncryptionKey(mockConfig(undefined), appProdEnv)).toThrow(
        /ENCRYPTION_KEY is required in production/,
      );
    });

    it('throws when key is empty string', () => {
      expect(() => resolveEncryptionKey(mockConfig(''), prodEnv)).toThrow(
        /ENCRYPTION_KEY is required in production/,
      );
    });

    it('throws when key is too short', () => {
      expect(() => resolveEncryptionKey(mockConfig('a'.repeat(32)), prodEnv)).toThrow(
        /must be 64 hex chars/,
      );
    });

    it('throws when key contains non-hex chars', () => {
      expect(() => resolveEncryptionKey(mockConfig('z'.repeat(64)), prodEnv)).toThrow(
        /must be 64 hex chars/,
      );
    });

    it('trims whitespace then validates', () => {
      const padded = `   ${VALID_HEX_KEY}   `;
      expect(resolveEncryptionKey(mockConfig(padded), prodEnv)).toBe(VALID_HEX_KEY);
    });

    it('rejects default placeholder value', () => {
      expect(() =>
        resolveEncryptionKey(mockConfig('default-key-change-me'), prodEnv),
      ).toThrow(/must be 64 hex chars/);
    });
  });

  describe('non-production', () => {
    const devEnv = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;

    it('returns empty string when key missing (dev fallback)', () => {
      expect(resolveEncryptionKey(mockConfig(undefined), devEnv)).toBe('');
    });

    it('returns empty string when key malformed (dev tolerates)', () => {
      expect(resolveEncryptionKey(mockConfig('short'), devEnv)).toBe('');
    });

    it('returns valid key when provided', () => {
      expect(resolveEncryptionKey(mockConfig(VALID_HEX_KEY), devEnv)).toBe(VALID_HEX_KEY);
    });

    it('test env behaves same as dev', () => {
      const testEnv = { NODE_ENV: 'test' } as NodeJS.ProcessEnv;
      expect(resolveEncryptionKey(mockConfig(undefined), testEnv)).toBe('');
    });
  });
});
