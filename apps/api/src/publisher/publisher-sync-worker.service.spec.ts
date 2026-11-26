import { ConfigService } from '@nestjs/config';
import { PublisherSyncJobService } from './publisher-sync-job.service';
import { PublisherSyncWorkerService } from './publisher-sync-worker.service';
import { publisherRetryWorkerTotal } from '../metrics/metrics.registry';

describe('PublisherSyncWorkerService production contract', () => {
  const originalRole = process.env.RUIDONG_SERVICE;

  afterEach(() => {
    if (originalRole === undefined) delete process.env.RUIDONG_SERVICE;
    else process.env.RUIDONG_SERVICE = originalRole;
    jest.useRealTimers();
  });

  function build(values: Record<string, string | undefined>) {
    const config = {
      get: jest.fn((key: string) => values[key]),
    } as unknown as ConfigService;
    const jobs = {
      processDue: jest.fn().mockResolvedValue({ processed: 0, succeeded: 0, failed: 0 }),
      refreshRetryBacklogMetrics: jest.fn().mockResolvedValue(undefined),
    } as unknown as PublisherSyncJobService;
    return new PublisherSyncWorkerService(config, jobs);
  }

  async function workerOutcomeCount(outcome: string): Promise<number> {
    const metric = await publisherRetryWorkerTotal.get();
    return metric.values.find((value) => value.labels.outcome === outcome)?.value ?? 0;
  }

  it('rejects a disabled Publisher in the production Billing runtime', () => {
    process.env.RUIDONG_SERVICE = 'billing';
    const service = build({
      APP_ENV: 'production',
      PUBLISHER_ENABLED: 'false',
      PUBLISHER_SYNC_WORKER_ENABLED: 'false',
    });

    expect(() => service.onModuleInit()).toThrow(
      'PUBLISHER_ENABLED=true is required by Billing in production',
    );
  });

  it.each(['uat', 'production'])(
    'allows a tightly scoped %s migration window with Publisher and worker disabled',
    (appEnv) => {
      process.env.RUIDONG_SERVICE = 'billing';
      const service = build({
        APP_ENV: appEnv,
        PUBLISHER_ACCOUNT_IDENTITY_MIGRATION_MODE: 'true',
        PUBLISHER_ENABLED: 'false',
        PUBLISHER_SYNC_WORKER_ENABLED: 'false',
      });

      expect(() => service.onModuleInit()).not.toThrow();
    },
  );

  it.each(['uat', 'production'])(
    'rejects unsafe combinations in provider-account identity migration mode in %s',
    (appEnv) => {
      process.env.RUIDONG_SERVICE = 'billing';

      expect(() => build({
        APP_ENV: appEnv,
        PUBLISHER_ACCOUNT_IDENTITY_MIGRATION_MODE: 'true',
        PUBLISHER_ENABLED: 'true',
        PUBLISHER_SYNC_WORKER_ENABLED: 'false',
      }).onModuleInit()).toThrow('PUBLISHER_ENABLED=false');

      expect(() => build({
        APP_ENV: appEnv,
        PUBLISHER_ACCOUNT_IDENTITY_MIGRATION_MODE: 'true',
        PUBLISHER_ENABLED: 'false',
        PUBLISHER_SYNC_WORKER_ENABLED: 'true',
      }).onModuleInit()).toThrow('PUBLISHER_SYNC_WORKER_ENABLED=false');

      expect(() => build({
        APP_ENV: appEnv,
        PUBLISHER_ACCOUNT_IDENTITY_MIGRATION_MODE: 'true',
        PUBLISHER_ENABLED: 'false',
      }).onModuleInit()).toThrow('PUBLISHER_SYNC_WORKER_ENABLED=false');
    },
  );

  it('validates the migration safety contract before service-role filtering', () => {
    process.env.RUIDONG_SERVICE = 'user';

    expect(() => build({
      APP_ENV: 'uat',
      PUBLISHER_ACCOUNT_IDENTITY_MIGRATION_MODE: 'true',
      PUBLISHER_ENABLED: 'true',
      PUBLISHER_SYNC_WORKER_ENABLED: 'false',
    }).onModuleInit()).toThrow('PUBLISHER_ENABLED=false');
  });

  it('requires a real Publisher endpoint, credential and retry worker in production', () => {
    process.env.RUIDONG_SERVICE = 'billing';
    expect(() => build({
      APP_ENV: 'production',
      PUBLISHER_ENABLED: 'true',
      PUBLISHER_SYNC_WORKER_ENABLED: 'true',
    }).onModuleInit()).toThrow('PUBLISHER_BASE_URL');

    expect(() => build({
      APP_ENV: 'production',
      PUBLISHER_ENABLED: 'true',
      PUBLISHER_BASE_URL: 'https://publisher.internal',
      PUBLISHER_SYNC_WORKER_ENABLED: 'true',
    }).onModuleInit()).toThrow('PUBLISHER_BILLING_TOKEN or PUBLISHER_TOKEN');

    expect(() => build({
      APP_ENV: 'production',
      PUBLISHER_ENABLED: 'true',
      PUBLISHER_BASE_URL: 'https://publisher.internal',
      PUBLISHER_TOKEN: 'publisher-token',
      PUBLISHER_SYNC_WORKER_ENABLED: 'false',
    }).onModuleInit()).toThrow('PUBLISHER_SYNC_WORKER_ENABLED=true');
  });

  it('starts only after the complete production contract is configured', () => {
    jest.useFakeTimers();
    process.env.RUIDONG_SERVICE = 'billing';
    const service = build({
      APP_ENV: 'production',
      PUBLISHER_ENABLED: 'true',
      PUBLISHER_BASE_URL: 'https://publisher.internal',
      PUBLISHER_BILLING_TOKEN: 'publisher-billing-token',
      PUBLISHER_SYNC_WORKER_ENABLED: 'true',
      PUBLISHER_SYNC_WORKER_INTERVAL_MS: '15000',
    });

    expect(() => service.onModuleInit()).not.toThrow();
    service.onModuleDestroy();
  });

  it('does not start the Billing-owned retry worker in another service role', () => {
    process.env.RUIDONG_SERVICE = 'user';
    const service = build({
      APP_ENV: 'production',
      PUBLISHER_ENABLED: 'false',
      PUBLISHER_SYNC_WORKER_ENABLED: 'false',
    });

    expect(() => service.onModuleInit()).not.toThrow();
  });

  it('counts scan failures and still attempts a database-backed backlog refresh', async () => {
    const service = build({});
    const jobs = Reflect.get(service, 'syncJobs') as {
      processDue: jest.Mock;
      refreshRetryBacklogMetrics: jest.Mock;
    };
    jobs.processDue.mockRejectedValueOnce(new Error('database unavailable'));
    const failuresBefore = await workerOutcomeCount('scan_failed');

    await expect(Reflect.get(service, 'tick').call(service)).resolves.toBeUndefined();

    await expect(workerOutcomeCount('scan_failed')).resolves.toBe(failuresBefore + 1);
    expect(jobs.refreshRetryBacklogMetrics).toHaveBeenCalledTimes(1);
  });
});
