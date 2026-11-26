import {
  checkProductionSecrets,
  checkInvoiceStorageConfig,
  assertProductionSecrets,
  PRODUCTION_SECRETS,
} from './assert-production-secrets';

function validProdEnv(): NodeJS.ProcessEnv {
  return {
    NODE_ENV: 'production',
    RUIDONG_SERVICE: 'billing',
    JWT_SECRET: 'a'.repeat(64),
    ENCRYPTION_KEY: '0'.repeat(64), // 32 bytes hex
    API_KEY_HASH_SECRET: '1'.repeat(64), // HMAC-SHA256 key for gateway key_hash
    SYNC_TOKEN: 'b'.repeat(64),
    ADMIN_TO_BILLING_TOKEN: 'c'.repeat(64),
    ADMIN_TO_BILLING_CONTEXT_SECRET: 'd'.repeat(64),
    USER_TO_BILLING_TOKEN: 'e'.repeat(64),
    BILLING_TO_USER_TOKEN: 'f'.repeat(64),
    BILLING_DATABASE_URL: 'postgresql://u:p@billing-host:5432/billing?schema=public',
    REDIS_HOST: 'prod-redis.internal',
    // 发票 PDF/OFD 存储统一走 S3：生产必须配齐桶和 region。
    INVOICE_S3_BUCKET: 'ruidong-invoices-prod',
    AWS_REGION: 'ap-east-1',
    // SENTRY_DSN intentionally absent — currently optional. Adding it would
    // hide regressions if we later flip it back to required.
  };
}

function validBillingProdEnv(): NodeJS.ProcessEnv {
  const env = validProdEnv();
  env.RUIDONG_SERVICE = 'billing';
  env.BILLING_DATABASE_URL = 'postgresql://u:p@billing-host:5432/billing?schema=public';
  return env;
}

describe('checkProductionSecrets', () => {
  it('accepts a well-formed production env', () => {
    const { errors } = checkProductionSecrets(validProdEnv());
    expect(errors).toEqual([]);
  });

  it.each([
    ['JWT_SECRET', 'replace_with_64_hex_chars'],
    ['SYNC_TOKEN', 'changeme_shared_sync_secret'],
    ['ADMIN_TO_BILLING_TOKEN', 'replace_with_64_hex_chars'],
    ['ADMIN_TO_BILLING_CONTEXT_SECRET', 'replace_with_64_hex_chars'],
    ['USER_TO_BILLING_TOKEN', 'replace_with_64_hex_chars'],
    ['BILLING_TO_USER_TOKEN', 'replace_with_64_hex_chars'],
    ['ENCRYPTION_KEY', 'your-32-byte-hex-key-here'],
    ['API_KEY_HASH_SECRET', 'replace_with_64_hex_chars'],
    ['JWT_SECRET', 'test_jwt_secret_for_ci_only'],
  ])('flags %s when it still contains placeholder "%s"', (key, value) => {
    const env = { ...validProdEnv(), [key]: value } as NodeJS.ProcessEnv;
    const { errors } = checkProductionSecrets(env);
    expect(errors.some((e) => e.includes(key) && e.includes('placeholder'))).toBe(true);
  });

  it('flags missing required fields', () => {
    const env = { ...validProdEnv() };
    delete env.JWT_SECRET;
    const { errors } = checkProductionSecrets(env);
    expect(errors).toContain('JWT_SECRET is required but not set');
  });

  it('does not flag optional fields when absent', () => {
    const env = validProdEnv();
    // Optional (WECHAT_*, ALIPAY_*, STRIPE_*) are unset in baseline — should pass
    const { errors } = checkProductionSecrets(env);
    expect(errors).toEqual([]);
  });

  it('requires BILLING_DATABASE_URL instead of DATABASE_URL for billing runtime', () => {
    expect(checkProductionSecrets(validBillingProdEnv()).errors).toEqual([]);

    const missing = validBillingProdEnv();
    delete missing.BILLING_DATABASE_URL;
    const { errors } = checkProductionSecrets(missing);
    expect(errors).toContain('BILLING_DATABASE_URL is required but not set');
    expect(errors).not.toContain('DATABASE_URL is required but not set');
  });

  it('flags optional fields when set with bad value', () => {
    const env = { ...validProdEnv(), STRIPE_SECRET_KEY: 'changeme' };
    const { errors } = checkProductionSecrets(env);
    expect(errors.some((e) => e.includes('STRIPE_SECRET_KEY'))).toBe(true);
  });

  it('requires ENCRYPTION_KEY to be exactly 64 hex chars', () => {
    const tooShort = { ...validProdEnv(), ENCRYPTION_KEY: '0'.repeat(32) };
    expect(checkProductionSecrets(tooShort).errors).toContain(
      'ENCRYPTION_KEY must be exactly 64 hex chars (32 bytes); got 32',
    );

    const notHex = { ...validProdEnv(), ENCRYPTION_KEY: 'z'.repeat(64) };
    expect(checkProductionSecrets(notHex).errors).toContain(
      'ENCRYPTION_KEY must be hex-encoded',
    );
  });

  it('requires API_KEY_HASH_SECRET to be exactly 64 hex chars', () => {
    const tooShort = { ...validProdEnv(), API_KEY_HASH_SECRET: '1'.repeat(32) };
    expect(checkProductionSecrets(tooShort).errors).toContain(
      'API_KEY_HASH_SECRET must be exactly 64 hex chars (32 bytes); got 32',
    );

    const notHex = { ...validProdEnv(), API_KEY_HASH_SECRET: 'z'.repeat(64) };
    expect(checkProductionSecrets(notHex).errors).toContain(
      'API_KEY_HASH_SECRET must be hex-encoded',
    );
  });

  it('enforces JWT_SECRET min length', () => {
    const env = { ...validProdEnv(), JWT_SECRET: 'short' };
    const { errors } = checkProductionSecrets(env);
    expect(errors.some((e) => e.includes('JWT_SECRET') && e.includes('below minimum'))).toBe(true);
  });

  it('ignores surrounding whitespace', () => {
    const env = { ...validProdEnv(), JWT_SECRET: `   ${'a'.repeat(64)}   ` };
    const { errors } = checkProductionSecrets(env);
    expect(errors).toEqual([]);
  });

  it('exposes the checks list so tests can iterate', () => {
    expect(PRODUCTION_SECRETS.some((c) => c.name === 'JWT_SECRET' && c.required)).toBe(true);
    expect(PRODUCTION_SECRETS.some((c) => c.name === 'API_KEY_HASH_SECRET' && c.required)).toBe(true);
    expect(PRODUCTION_SECRETS.some((c) => c.name === 'ADMIN_TO_BILLING_TOKEN' && c.required)).toBe(true);
    expect(PRODUCTION_SECRETS.some((c) => c.name === 'USER_TO_BILLING_TOKEN' && c.required)).toBe(true);
    expect(PRODUCTION_SECRETS.some((c) => c.name === 'BILLING_INTERNAL_TOKEN')).toBe(false);
    expect(PRODUCTION_SECRETS.some((c) => c.name === 'BILLING_DATABASE_URL' && c.required)).toBe(true);
    expect(PRODUCTION_SECRETS.some((c) => c.name === 'DATABASE_URL')).toBe(false);
    expect(PRODUCTION_SECRETS.some((c) => c.name === 'STRIPE_SECRET_KEY' && !c.required)).toBe(true);
  });
});

describe('assertProductionSecrets', () => {
  it('returns silently when env is clean', () => {
    const logger = { log: jest.fn(), error: jest.fn() };
    const exit = jest.fn();
    assertProductionSecrets(validProdEnv(), logger, exit);
    expect(exit).not.toHaveBeenCalled();
    expect(logger.error).not.toHaveBeenCalled();
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('calls exit(1) in production when placeholders found', () => {
    const env = { ...validProdEnv(), JWT_SECRET: 'replace_with_secret' };
    const logger = { log: jest.fn(), error: jest.fn() };
    const exit = jest.fn();
    assertProductionSecrets(env, logger, exit);
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.error).toHaveBeenCalled();
    const msg = (logger.error.mock.calls[0] as [string])[0];
    expect(msg).toContain('JWT_SECRET');
  });

  it('treats APP_ENV=production as production', () => {
    const env = {
      ...validProdEnv(),
      NODE_ENV: 'development',
      APP_ENV: 'production',
      JWT_SECRET: 'replace_with_secret',
    };
    const logger = { log: jest.fn(), error: jest.fn() };
    const exit = jest.fn();
    assertProductionSecrets(env, logger, exit);
    expect(exit).toHaveBeenCalledWith(1);
    expect(logger.log).not.toHaveBeenCalled();
  });

  it('warns but does not exit in non-production', () => {
    const env = { ...validProdEnv(), NODE_ENV: 'development', JWT_SECRET: 'changeme' };
    const logger = { log: jest.fn(), error: jest.fn() };
    const exit = jest.fn();
    assertProductionSecrets(env, logger, exit);
    expect(exit).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalled();
    const msg = (logger.log.mock.calls[0] as [string])[0];
    expect(msg).toContain('WARNING');
    expect(msg).toContain('non-production');
  });

  it('warns in test env when fields missing', () => {
    const env = { NODE_ENV: 'test' } as NodeJS.ProcessEnv;
    const logger = { log: jest.fn(), error: jest.fn() };
    const exit = jest.fn();
    assertProductionSecrets(env, logger, exit);
    expect(exit).not.toHaveBeenCalled();
    expect(logger.log).toHaveBeenCalled();
  });

  it('aggregates all errors in the message, not just the first one', () => {
    const env = {
      NODE_ENV: 'production',
      JWT_SECRET: 'short',
      ENCRYPTION_KEY: 'nothex',
    } as NodeJS.ProcessEnv;
    const logger = { log: jest.fn(), error: jest.fn() };
    const exit = jest.fn();
    assertProductionSecrets(env, logger, exit);

    const msg = (logger.error.mock.calls[0] as [string])[0];
    expect(msg).toContain('JWT_SECRET');
    expect(msg).toContain('ENCRYPTION_KEY');
    expect(msg).toContain('API_KEY_HASH_SECRET');
    expect(msg).toContain('SYNC_TOKEN'); // also required, missing
    expect(msg).toContain('BILLING_DATABASE_URL');
    expect(msg).not.toMatch(/\n\s+- DATABASE_URL is required but not set/);
    // SENTRY_DSN is currently optional — unset should NOT be flagged.
    expect(msg).not.toContain('SENTRY_DSN');
  });

  it('does not flag missing SENTRY_DSN (optional until observability vendor chosen)', () => {
    const env = validProdEnv();
    delete env.SENTRY_DSN;
    const logger = { log: jest.fn(), error: jest.fn() };
    const exit = jest.fn();
    assertProductionSecrets(env, logger, exit);
    expect(exit).not.toHaveBeenCalled();
  });

  it('does not block production bootstrap when invoice S3 env is empty', () => {
    const env = validProdEnv();
    delete env.INVOICE_S3_BUCKET;
    delete env.AWS_S3_BUCKET;
    const logger = { log: jest.fn(), error: jest.fn() };
    const exit = jest.fn();
    assertProductionSecrets(env, logger, exit);
    expect(exit).not.toHaveBeenCalled();
  });

  it('keeps invoice S3 env check available for diagnostics', () => {
    const env = validProdEnv();
    delete env.INVOICE_S3_BUCKET;
    env.AWS_S3_BUCKET = 'shared-bucket';
    expect(checkInvoiceStorageConfig(env)).toEqual([]);
  });

  it('does not enforce invoice S3 outside production', () => {
    const env = { NODE_ENV: 'development' } as NodeJS.ProcessEnv;
    expect(checkInvoiceStorageConfig({} as NodeJS.ProcessEnv).length).toBeGreaterThan(0);
    const logger = { log: jest.fn(), error: jest.fn() };
    const exit = jest.fn();
    assertProductionSecrets(env, logger, exit);
    expect(exit).not.toHaveBeenCalled();
  });
});
