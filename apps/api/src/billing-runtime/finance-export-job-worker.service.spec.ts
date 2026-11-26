import { ConfigService } from '@nestjs/config';
import { BillingAdminService } from '../billing/billing.admin.service';
import { RedisService } from '../redis/redis.service';
import { FinanceExportJobWorkerService } from './finance-export-job-worker.service';

function makeService(configValues: Record<string, unknown> = {}) {
  const billingAdmin = {
    cleanupExpiredFinanceReportExportJobs: jest.fn().mockResolvedValue({
      cleaned: 0,
      failed: 0,
    }),
    processDueFinanceReportExportJobs: jest.fn().mockResolvedValue({
      processed: 0,
      succeeded: 0,
      failed: 0,
    }),
  } as unknown as jest.Mocked<Pick<
    BillingAdminService,
    'cleanupExpiredFinanceReportExportJobs' | 'processDueFinanceReportExportJobs'
  >>;

  const config = {
    get: jest.fn((key: string) => configValues[key]),
  } as unknown as jest.Mocked<Pick<ConfigService, 'get'>>;

  const redis = {
    set: jest.fn().mockResolvedValue('OK'),
    eval: jest.fn().mockResolvedValue(1),
  } as unknown as jest.Mocked<Pick<RedisService, 'set' | 'eval'>>;

  const service = new FinanceExportJobWorkerService(
    billingAdmin as unknown as BillingAdminService,
    config as unknown as ConfigService,
    redis as unknown as RedisService,
  );

  return { service, billingAdmin, config, redis };
}

describe('FinanceExportJobWorkerService', () => {
  it('processes due finance export jobs with configured batch and age', async () => {
    const { service, billingAdmin } = makeService({
      FINANCE_EXPORT_JOB_WORKER_BATCH_SIZE: '3',
      FINANCE_EXPORT_JOB_MIN_AGE_MS: '7000',
    });
    billingAdmin.processDueFinanceReportExportJobs.mockResolvedValue({
      processed: 2,
      succeeded: 1,
      failed: 1,
    });

    const result = await service.runOnce('test');

    expect(billingAdmin.processDueFinanceReportExportJobs).toHaveBeenCalledWith({
      batchSize: 3,
      minAgeMs: 7000,
    });
    expect(billingAdmin.cleanupExpiredFinanceReportExportJobs).toHaveBeenCalledWith({
      batchSize: 100,
    });
    expect(result).toEqual({
      skipped: false,
      processed: 2,
      succeeded: 1,
      failed: 1,
    });
  });

  it('skips overlapping runs', async () => {
    const { service, billingAdmin } = makeService();
    let release!: () => void;
    billingAdmin.processDueFinanceReportExportJobs.mockReturnValue(
      new Promise((resolve) => {
        release = () => resolve({ processed: 1, succeeded: 1, failed: 0 });
      }),
    );

    const first = service.runOnce('first');
    const second = await service.runOnce('second');
    release();

    await expect(first).resolves.toEqual({
      skipped: false,
      processed: 1,
      succeeded: 1,
      failed: 0,
    });
    expect(second).toEqual({
      skipped: true,
      processed: 0,
      succeeded: 0,
      failed: 0,
    });
    expect(billingAdmin.processDueFinanceReportExportJobs).toHaveBeenCalledTimes(1);
  });

  it('allows only one replica to process exports', async () => {
    const { service, billingAdmin, redis } = makeService();
    redis.set.mockResolvedValue(null);

    await expect(service.runOnce('replica')).resolves.toEqual({
      skipped: true,
      processed: 0,
      succeeded: 0,
      failed: 0,
    });

    expect(billingAdmin.processDueFinanceReportExportJobs).not.toHaveBeenCalled();
    expect(redis.eval).not.toHaveBeenCalled();
  });

  it('fails closed when the fleet lock cannot be checked', async () => {
    const { service, billingAdmin, redis } = makeService();
    redis.set.mockRejectedValue(new Error('redis unavailable'));

    await expect(service.runOnce('redis-down')).resolves.toEqual({
      skipped: true,
      processed: 0,
      succeeded: 0,
      failed: 0,
    });
    expect(billingAdmin.processDueFinanceReportExportJobs).not.toHaveBeenCalled();
  });

  it('releases only the lock token held by this run', async () => {
    const { service, redis } = makeService();

    await service.runOnce('test');

    expect(redis.eval).toHaveBeenCalledWith(
      expect.stringContaining("redis.call('get'"),
      1,
      'billing:finance-export-job-worker:lock',
      expect.any(String),
    );
  });
});
