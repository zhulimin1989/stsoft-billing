import { ConfigService } from '@nestjs/config';
import { CreditBalanceStateService } from '../billing/credit-balance-state.service';
import { CreditBalanceOutboxWorkerService } from './credit-balance-outbox-worker.service';

describe('CreditBalanceOutboxWorkerService', () => {
  function makeService(configValues: Record<string, unknown> = {}) {
    const balanceState = {
      flushOutbox: jest.fn().mockResolvedValue({ scanned: 1, delivered: 1, failed: 0 }),
    };
    const config = {
      get: jest.fn((key: string, fallback: unknown) =>
        Object.prototype.hasOwnProperty.call(configValues, key)
          ? configValues[key]
          : fallback),
    };
    return {
      service: new CreditBalanceOutboxWorkerService(
        balanceState as unknown as CreditBalanceStateService,
        config as unknown as ConfigService,
      ),
      balanceState,
    };
  }

  it('drains one configured batch', async () => {
    const { service, balanceState } = makeService({
      BILLING_CREDIT_BALANCE_OUTBOX_BATCH_SIZE: 25,
    });

    await service.runOnce();

    expect(balanceState.flushOutbox).toHaveBeenCalledWith(25);
  });

  it('does not overlap two worker runs', async () => {
    let release!: () => void;
    const pending = new Promise<void>((resolve) => { release = resolve; });
    const { service, balanceState } = makeService();
    balanceState.flushOutbox.mockImplementationOnce(async () => {
      await pending;
      return { scanned: 0, delivered: 0, failed: 0 };
    });

    const first = service.runOnce();
    await service.runOnce();
    release();
    await first;

    expect(balanceState.flushOutbox).toHaveBeenCalledTimes(1);
  });

  it('swallows a delivery failure so the interval remains alive', async () => {
    const { service, balanceState } = makeService();
    balanceState.flushOutbox.mockRejectedValueOnce(new Error('database unavailable'));

    await expect(service.runOnce()).resolves.toBeUndefined();
  });
});
