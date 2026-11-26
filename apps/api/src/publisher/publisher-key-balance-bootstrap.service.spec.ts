import { ConfigService } from '@nestjs/config';
import { PublisherKeyBalanceBootstrapService } from './publisher-key-balance-bootstrap.service';

describe('PublisherKeyBalanceBootstrapService', () => {
  function makeService(env: Record<string, string | undefined> = {}) {
    const config = {
      get: jest.fn((key: string) => env[key]),
    } as unknown as ConfigService;
    const publisherSync = {
      syncAllKeyBalances: jest.fn().mockResolvedValue(2),
    };
    const service = new PublisherKeyBalanceBootstrapService(
      config,
      publisherSync as never,
    );
    return { service, publisherSync };
  }

  it('run enqueues active key-balance replay', async () => {
    const enabled = makeService();

    await enabled.service.run();
    expect(enabled.publisherSync.syncAllKeyBalances).toHaveBeenCalledWith(
      5000,
      { replayRunId: expect.stringMatching(/^key-balance-bootstrap-/) },
    );
  });

  it('uses configured bootstrap limit', async () => {
    const { service, publisherSync } = makeService({
      PUBLISHER_KEY_BALANCE_BOOTSTRAP_LIMIT: '25',
    });

    await service.run();

    expect(publisherSync.syncAllKeyBalances).toHaveBeenCalledWith(
      25,
      { replayRunId: expect.stringMatching(/^key-balance-bootstrap-/) },
    );
  });

  it('does not schedule bootstrap when disabled', () => {
    jest.useFakeTimers();
    const { service, publisherSync } = makeService({
      PUBLISHER_KEY_BALANCE_BOOTSTRAP_ON_START: 'false',
    });

    service.onApplicationBootstrap();
    jest.runOnlyPendingTimers();

    expect(publisherSync.syncAllKeyBalances).not.toHaveBeenCalled();
    jest.useRealTimers();
  });
});
