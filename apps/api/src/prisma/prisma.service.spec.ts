import { resolvePrismaDatasourceUrl } from './prisma.service';

function makeConfig(values: Record<string, string | undefined>) {
  return {
    get: jest.fn((key: string) => values[key]),
  };
}

describe('resolvePrismaDatasourceUrl', () => {
  it('uses DATABASE_URL for the main api runtime', () => {
    const url = resolvePrismaDatasourceUrl({
      RUIDONG_SERVICE: 'api',
      DATABASE_URL: 'postgresql://admin-db',
      BILLING_DATABASE_URL: 'postgresql://billing-db',
    } as NodeJS.ProcessEnv);

    expect(url).toBe('postgresql://admin-db');
  });

  it('uses BILLING_DATABASE_URL for the billing runtime', () => {
    const url = resolvePrismaDatasourceUrl({
      RUIDONG_SERVICE: 'billing',
      DATABASE_URL: 'postgresql://admin-db',
      BILLING_DATABASE_URL: 'postgresql://billing-db',
    } as NodeJS.ProcessEnv);

    expect(url).toBe('postgresql://billing-db');
  });

  it('uses BILLING_DATABASE_URL for the OpenAPI facade runtime', () => {
    const url = resolvePrismaDatasourceUrl({
      RUIDONG_SERVICE: 'openapi',
      DATABASE_URL: 'postgresql://admin-db',
      BILLING_DATABASE_URL: 'postgresql://billing-db',
    } as NodeJS.ProcessEnv);

    expect(url).toBe('postgresql://billing-db');
  });

  it('falls back to DATABASE_URL for local billing runtime when no split DB is configured', () => {
    const url = resolvePrismaDatasourceUrl({
      RUIDONG_SERVICE: 'billing',
      DATABASE_URL: 'postgresql://shared-dev-db',
    } as NodeJS.ProcessEnv);

    expect(url).toBe('postgresql://shared-dev-db');
  });

  it('requires BILLING_DATABASE_URL for production billing runtime', () => {
    expect(() =>
      resolvePrismaDatasourceUrl({
        NODE_ENV: 'production',
        RUIDONG_SERVICE: 'billing',
        DATABASE_URL: 'postgresql://shared-prod-db',
      } as NodeJS.ProcessEnv),
    ).toThrow(/BILLING_DATABASE_URL is required/);
  });

  it('requires BILLING_DATABASE_URL for production OpenAPI runtime', () => {
    expect(() =>
      resolvePrismaDatasourceUrl({
        NODE_ENV: 'production',
        RUIDONG_SERVICE: 'openapi',
        DATABASE_URL: 'postgresql://shared-prod-db',
      } as NodeJS.ProcessEnv),
    ).toThrow(/BILLING_DATABASE_URL is required/);
  });

  it('treats APP_ENV=production as production for billing DB isolation', () => {
    expect(() =>
      resolvePrismaDatasourceUrl({
        APP_ENV: 'production',
        RUIDONG_SERVICE: 'billing',
        DATABASE_URL: 'postgresql://shared-prod-db',
      } as NodeJS.ProcessEnv),
    ).toThrow(/BILLING_DATABASE_URL is required/);
  });

  it('lets ConfigService values override process env', () => {
    const url = resolvePrismaDatasourceUrl(
      {
        RUIDONG_SERVICE: 'api',
        DATABASE_URL: 'postgresql://env-admin-db',
      } as NodeJS.ProcessEnv,
      makeConfig({
        RUIDONG_SERVICE: 'billing',
        DATABASE_URL: 'postgresql://config-admin-db',
        BILLING_DATABASE_URL: 'postgresql://config-billing-db',
      }),
    );

    expect(url).toBe('postgresql://config-billing-db');
  });
});
