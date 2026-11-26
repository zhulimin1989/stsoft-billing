import { resolveCorsOrigins } from './cors-origins';

describe('resolveCorsOrigins', () => {
  const base = {
    names: ['BILLING_CORS_ORIGINS', 'CORS_ORIGINS'],
    devDefaults: ['http://localhost:5173', 'http://localhost:5174'],
    label: 'billing API',
  };

  it('uses dev defaults outside production when no origin is configured', () => {
    expect(resolveCorsOrigins({ ...base, env: { NODE_ENV: 'test' } })).toEqual([
      'http://localhost:5173',
      'http://localhost:5174',
    ]);
  });

  it('requires explicit origins in production', () => {
    expect(() =>
      resolveCorsOrigins({ ...base, env: { NODE_ENV: 'production' } }),
    ).toThrow(/must be explicitly configured/);
  });

  it('prefers service-specific origins over shared CORS_ORIGINS', () => {
    expect(
      resolveCorsOrigins({
        ...base,
        env: {
          NODE_ENV: 'production',
          BILLING_CORS_ORIGINS: 'https://billing.example.com',
          CORS_ORIGINS: 'https://shared.example.com',
        },
      }),
    ).toEqual(['https://billing.example.com']);
  });

  it('rejects wildcard and localhost origins in production', () => {
    expect(() =>
      resolveCorsOrigins({
        ...base,
        env: { NODE_ENV: 'production', BILLING_CORS_ORIGINS: '*' },
      }),
    ).toThrow(/not allowed/);

    expect(() =>
      resolveCorsOrigins({
        ...base,
        env: { APP_ENV: 'production', BILLING_CORS_ORIGINS: 'http://localhost:5173' },
      }),
    ).toThrow(/must not use localhost/);
  });

  it('rejects values that are not exact origins', () => {
    expect(() =>
      resolveCorsOrigins({
        ...base,
        env: { BILLING_CORS_ORIGINS: 'https://app.example.com/path' },
      }),
    ).toThrow(/must not include path/);
  });
});
