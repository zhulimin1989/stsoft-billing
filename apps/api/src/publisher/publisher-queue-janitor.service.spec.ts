import { PublisherQueueJanitorService } from './publisher-queue-janitor.service';

describe('PublisherQueueJanitorService', () => {
  function buildService(
    values: Record<string, string> = {},
    deletedPerBatch: number[] = [0, 0],
    lockAcquired = true,
  ) {
    const queue = [...deletedPerBatch];
    const executeRaw = jest.fn().mockImplementation(async () => queue.shift() ?? 0);
    const queryRaw = jest.fn().mockResolvedValue([{ acquired: lockAcquired }]);
    const prisma = {
      $transaction: jest.fn().mockImplementation(async (fn: (tx: unknown) => Promise<number>) =>
        fn({ $executeRaw: executeRaw, $queryRaw: queryRaw })),
      publisherSyncJob: { count: jest.fn().mockResolvedValue(0) },
      billingRestrictionProjectionIntent: { count: jest.fn().mockResolvedValue(0) },
    };
    const config = { get: jest.fn((key: string) => values[key]) };
    return {
      service: new PublisherQueueJanitorService(prisma as never, config as never),
      prisma,
      executeRaw,
      queryRaw,
    };
  }

  it('removes terminal rows from both queue tables', async () => {
    // One short batch per table: a batch smaller than the batch size ends that
    // table's sweep, so each table issues exactly one delete.
    const { service, executeRaw } = buildService({}, [7, 3]);

    const result = await service.runOnce('test');

    expect(result).toMatchObject({
      trigger: 'test',
      skipped: false,
      deleted: {
        publisher_sync_jobs: 7,
        billing_restriction_projection_intents: 3,
      },
    });
    // Each table stops as soon as a batch comes back short of the batch size.
    expect(executeRaw).toHaveBeenCalledTimes(2);
  });

  it('never deletes a status the retry worker can still claim', async () => {
    const { service, executeRaw } = buildService({}, [0, 0]);

    await service.runOnce('status-allowlist');

    const statuses = executeRaw.mock.calls.flatMap((call) => {
      const sql = call[0] as { values?: unknown[] };
      return (sql.values ?? []).filter(Array.isArray).flat();
    });
    expect(statuses).toContain('SUCCEEDED');
    expect(statuses).not.toContain('PENDING');
    expect(statuses).not.toContain('FAILED');
    expect(statuses).not.toContain('PROCESSING');
    expect(statuses).not.toContain('ACCEPTED');
    // DISABLED is the durable evidence of a publish dropped while Publisher
    // delivery was switched off and must survive retention.
    expect(statuses).not.toContain('DISABLED');
  });

  it('ends the sweep instead of queueing when another replica holds the lock', async () => {
    const { service, executeRaw } = buildService({}, [5, 5], false);

    const result = await service.runOnce('contended');

    expect(executeRaw).not.toHaveBeenCalled();
    expect(result.deleted.publisher_sync_jobs).toBe(0);
    expect(result.deleted.billing_restriction_projection_intents).toBe(0);
  });

  it('stops at the per-sweep cap rather than deleting without bound', async () => {
    const { service, executeRaw } = buildService(
      {
        PUBLISHER_QUEUE_JANITOR_BATCH_SIZE: '100',
        PUBLISHER_QUEUE_JANITOR_MAX_BATCHES: '3',
      },
      [100, 100, 100, 100, 100, 100],
    );

    const result = await service.runOnce('capped');

    // Three full batches per table and no more, even though rows remain.
    expect(executeRaw).toHaveBeenCalledTimes(6);
    expect(result.deleted.publisher_sync_jobs).toBe(300);
    expect(result.deleted.billing_restriction_projection_intents).toBe(300);
  });

  it('keeps a completed sweep when the backlog metric query fails', async () => {
    const { service, prisma } = buildService({}, [0, 0]);
    prisma.publisherSyncJob.count.mockRejectedValue(new Error('metrics unavailable'));

    await expect(service.runOnce('metrics-failure')).resolves.toMatchObject({
      skipped: false,
    });
  });

  it('does not start a second concurrent sweep', async () => {
    const { service } = buildService({}, [0, 0]);
    const [first, second] = await Promise.all([
      service.runOnce('first'),
      service.runOnce('second'),
    ]);
    expect([first.skipped, second.skipped]).toContain(true);
  });
});
