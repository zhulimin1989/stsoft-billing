import { ConfigService } from '@nestjs/config';
import { BalanceGrantExpiryService } from './balance-grant-expiry.service';
import { BillingService } from './billing.service';

type BillingMock = jest.Mocked<Pick<BillingService, 'sweepExpiredBalanceGrants'>>;

function buildService(configValues: Record<string, string | undefined> = {}) {
  const billing: BillingMock = {
    sweepExpiredBalanceGrants: jest.fn().mockResolvedValue({
      scanned: 0,
      expired: 0,
      failed: 0,
      totalExpiredUsd: 0,
      totalWalletDebitedUsd: 0,
      totalUnbackedUsd: 0,
    }),
  };
  const config = {
    get: jest.fn((key: string) => configValues[key]),
  } as unknown as ConfigService;
  return {
    service: new BalanceGrantExpiryService(billing as unknown as BillingService, config),
    billing,
  };
}

describe('BalanceGrantExpiryService', () => {
  const originalRole = process.env.RUIDONG_SERVICE;

  beforeEach(() => {
    jest.useFakeTimers();
    process.env.RUIDONG_SERVICE = 'billing';
  });

  afterEach(() => {
    jest.clearAllTimers();
    jest.useRealTimers();
    if (originalRole === undefined) {
      delete process.env.RUIDONG_SERVICE;
    } else {
      process.env.RUIDONG_SERVICE = originalRole;
    }
  });

  it('defaults to the next 00:05 business-time run', () => {
    const { service } = buildService();
    const delay = service.delayUntilNextDailyRun(new Date('2026-06-15T15:59:00.000Z'));

    expect(delay).toBe(6 * 60_000);
  });

  it('runs startup catch-up and then the daily sweep by default', async () => {
    jest.setSystemTime(new Date('2026-06-15T15:59:00.000Z'));
    const { service, billing } = buildService();

    service.onModuleInit();

    jest.advanceTimersByTime(30_000);
    await Promise.resolve();
    expect(billing.sweepExpiredBalanceGrants).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(5 * 60_000 + 30_001);
    await Promise.resolve();
    await Promise.resolve();
    expect(billing.sweepExpiredBalanceGrants).toHaveBeenCalledTimes(2);
  });

  it('supports interval override for emergency polling', async () => {
    const { service, billing } = buildService({
      BALANCE_GRANT_EXPIRY_INTERVAL_MS: '300000',
    });

    service.onModuleInit();

    jest.advanceTimersByTime(30_000);
    await Promise.resolve();
    expect(billing.sweepExpiredBalanceGrants).toHaveBeenCalledTimes(1);

    jest.advanceTimersByTime(5 * 60_000);
    await Promise.resolve();
    expect(billing.sweepExpiredBalanceGrants).toHaveBeenCalledTimes(2);
  });
});
