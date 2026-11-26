import { Logger } from '@nestjs/common';
import { NoopProductSyncNotifier } from './product-sync-noop.provider';

describe('NoopProductSyncNotifier', () => {
  afterEach(() => {
    jest.restoreAllMocks();
  });

  it('warns once when credit sync notification is skipped', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const service = new NoopProductSyncNotifier();

    await service.notifyCreditChanged('user@example.com', 'code');
    await service.notifyCreditChanged('user@example.com', 'code');

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('notifyCreditChanged'));
  });

  it('warns once when product saas notification is skipped', async () => {
    const warn = jest.spyOn(Logger.prototype, 'warn').mockImplementation();
    const service = new NoopProductSyncNotifier();

    await service.notifyProductSaas();
    await service.notifyProductSaas();

    expect(warn).toHaveBeenCalledTimes(1);
    expect(warn).toHaveBeenCalledWith(expect.stringContaining('notifyProductSaas'));
  });
});
