import { ConfigService } from '@nestjs/config';
import { PaymentService } from '../payment/payment.service';
import { StripeSubscriptionCancellationWorkerService } from './stripe-subscription-cancellation-worker.service';

function makeWorker(overrides: Record<string, string> = {}) {
  const paymentService = {
    runDueStripeSubscriptionCancellationTasks: jest.fn(),
  };
  const config = {
    get: jest.fn((key: string) => overrides[key]),
  };
  return {
    paymentService,
    worker: new StripeSubscriptionCancellationWorkerService(
      paymentService as unknown as PaymentService,
      config as unknown as ConfigService,
    ),
  };
}

describe('StripeSubscriptionCancellationWorkerService', () => {
  it('passes the configured batch size to the durable task runner', async () => {
    const { paymentService, worker } = makeWorker({
      STRIPE_SUBSCRIPTION_CANCELLATION_WORKER_BATCH_SIZE: '75',
    });
    paymentService.runDueStripeSubscriptionCancellationTasks
      .mockResolvedValue({
        tasks: 2,
        completed: 1,
        failed: 1,
        manualReview: 0,
      });

    await expect(worker.runOnce('test')).resolves.toEqual({
      skipped: false,
      tasks: 2,
      completed: 1,
      failed: 1,
      manualReview: 0,
    });
    expect(
      paymentService.runDueStripeSubscriptionCancellationTasks,
    ).toHaveBeenCalledWith(75);
  });

  it('does not overlap two in-process polling runs', async () => {
    const { paymentService, worker } = makeWorker();
    let release!: (value: {
      tasks: number;
      completed: number;
      failed: number;
      manualReview: number;
    }) => void;
    paymentService.runDueStripeSubscriptionCancellationTasks
      .mockImplementationOnce(
        () => new Promise((resolve) => {
          release = resolve;
        }),
      );

    const first = worker.runOnce('first');
    await expect(worker.runOnce('second')).resolves.toEqual({
      skipped: true,
      tasks: 0,
      completed: 0,
      failed: 0,
      manualReview: 0,
    });
    release({
      tasks: 1,
      completed: 1,
      failed: 0,
      manualReview: 0,
    });
    await expect(first).resolves.toMatchObject({
      skipped: false,
      completed: 1,
    });
  });

  it('releases the in-process guard after a runner failure', async () => {
    const { paymentService, worker } = makeWorker();
    paymentService.runDueStripeSubscriptionCancellationTasks
      .mockRejectedValueOnce(new Error('database unavailable'))
      .mockResolvedValueOnce({
        tasks: 0,
        completed: 0,
        failed: 0,
        manualReview: 0,
      });

    await expect(worker.runOnce('first'))
      .rejects.toThrow('database unavailable');
    await expect(worker.runOnce('retry')).resolves.toMatchObject({
      skipped: false,
      tasks: 0,
    });
  });
});
