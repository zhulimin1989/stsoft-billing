import { ConfigService } from '@nestjs/config';
import { isBillingRuntime } from '../common/runtime/service-role';
import { PaymentService } from '../payment/payment.service';
import { ProviderRefundWorkerService } from './provider-refund-worker.service';

jest.mock('../common/runtime/service-role', () => ({
  isBillingRuntime: jest.fn(),
}));

function makeWorker(overrides: Record<string, string> = {}) {
  const paymentService = {
    runDueProviderRefundIntents: jest.fn(),
  };
  const config = {
    get: jest.fn((key: string) => overrides[key]),
  };
  return {
    paymentService,
    worker: new ProviderRefundWorkerService(
      paymentService as unknown as PaymentService,
      config as unknown as ConfigService,
    ),
  };
}

describe('ProviderRefundWorkerService', () => {
  afterEach(() => {
    jest.useRealTimers();
    jest.clearAllMocks();
  });

  it('does not schedule provider refund recovery outside billing runtime', () => {
    jest.useFakeTimers();
    (isBillingRuntime as jest.Mock).mockReturnValue(false);
    const { paymentService, worker } = makeWorker();

    worker.onModuleInit();
    jest.runOnlyPendingTimers();

    expect(paymentService.runDueProviderRefundIntents).not.toHaveBeenCalled();
    worker.onModuleDestroy();
  });

  it('passes the configured batch size to the durable runner', async () => {
    const { paymentService, worker } = makeWorker({
      PROVIDER_REFUND_WORKER_BATCH_SIZE: '75',
    });
    paymentService.runDueProviderRefundIntents.mockResolvedValue({
      tasks: 2,
      completed: 1,
      pending: 1,
      failed: 0,
      manualReview: 0,
    });

    await expect(worker.runOnce('test')).resolves.toEqual({
      skipped: false,
      tasks: 2,
      completed: 1,
      pending: 1,
      failed: 0,
      manualReview: 0,
    });
    expect(paymentService.runDueProviderRefundIntents)
      .toHaveBeenCalledWith(75);
  });

  it('does not overlap two in-process polling runs', async () => {
    const { paymentService, worker } = makeWorker();
    let release!: (value: {
      tasks: number;
      completed: number;
      pending: number;
      failed: number;
      manualReview: number;
    }) => void;
    paymentService.runDueProviderRefundIntents.mockImplementationOnce(
      () => new Promise((resolve) => {
        release = resolve;
      }),
    );

    const first = worker.runOnce('first');
    await expect(worker.runOnce('second')).resolves.toEqual({
      skipped: true,
      tasks: 0,
      completed: 0,
      pending: 0,
      failed: 0,
      manualReview: 0,
    });
    release({
      tasks: 1,
      completed: 1,
      pending: 0,
      failed: 0,
      manualReview: 0,
    });
    await expect(first).resolves.toMatchObject({
      skipped: false,
      completed: 1,
    });
  });
});
