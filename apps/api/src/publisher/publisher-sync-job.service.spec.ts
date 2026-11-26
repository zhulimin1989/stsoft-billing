import { PublisherClient, PublisherClientError } from './publisher.client';
import {
  PublisherAdmissionSupersededError,
  PublisherSyncJobService,
} from './publisher-sync-job.service';
import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import {
  publisherRetryBacklog,
  publisherRetryBacklogOldestAgeSeconds,
  publisherRetryWorkerTotal,
} from '../metrics/metrics.registry';

describe('PublisherSyncJobService', () => {
  const decision = {
    decision_id: '3f746d48-31dc-4a20-b284-9df0b578ee2b',
    decision_version: 1_800_000_000_000_000,
  };
  const appliedReceipt = {
    batch_id: 'batch-1',
    status: 'applied' as const,
    total: 1,
    pending_count: 0,
    applied_count: 1,
    idempotent_count: 0,
    superseded_count: 0,
    conflict_count: 0,
    dead_letter_count: 0,
    unverified_count: 0,
  };

  function admissionReceipt(
    status: 'pending' | 'applied' | 'idempotent' | 'superseded' | 'conflict' | 'dead_letter' | 'unverified' | 'mixed',
  ) {
    return {
      ...appliedReceipt,
      status,
      total: status === 'mixed' ? 2 : 1,
      pending_count: status === 'pending' ? 1 : 0,
      applied_count: status === 'applied' || status === 'mixed' ? 1 : 0,
      idempotent_count: status === 'idempotent' ? 1 : 0,
      superseded_count: status === 'superseded' || status === 'mixed' ? 1 : 0,
      conflict_count: status === 'conflict' ? 1 : 0,
      dead_letter_count: status === 'dead_letter' ? 1 : 0,
      unverified_count: status === 'unverified' ? 1 : 0,
    };
  }

  function makeService(configValues: Record<string, string | number | undefined> = {}) {
    const publisher = {
      idempotencyKey: jest.fn().mockReturnValue('idem-1'),
      request: jest.fn().mockResolvedValue({ batch_id: 'batch-1', status: 'accepted' }),
      getKeyAdmissionDelivery: jest.fn().mockResolvedValue(appliedReceipt),
      isExplicitlyDisabled: jest.fn().mockReturnValue(false),
    } as unknown as jest.Mocked<PublisherClient>;
    const prisma = {
      publisherSyncJob: {
        findUnique: jest.fn(),
        findMany: jest.fn(),
        count: jest.fn(),
        create: jest.fn(),
        update: jest.fn(),
        updateMany: jest.fn(),
        aggregate: jest.fn().mockResolvedValue({
          _count: { _all: 0 },
          _min: { createdAt: null },
        }),
      },
    };
    const config = {
      get: jest.fn((key: string) => configValues[key]),
    };
    const service = new PublisherSyncJobService(
      publisher,
      prisma as never,
      config as never,
    );
    return { service, publisher, prisma };
  }

  async function metricValue(
    metric: { get: () => Promise<unknown> },
    outcome?: string,
  ): Promise<number> {
    const snapshot = await metric.get() as {
      values: Array<{
        value: number;
        labels: Partial<Record<string, string | number>>;
      }>;
    };
    return snapshot.values.find((value) =>
      outcome === undefined || value.labels.outcome === outcome)?.value ?? 0;
  }

  const baseJob = {
    id: 'job-1',
    namespace: 'billing',
    method: 'PUT',
    path: '/billing/api/v1/key-balance/key-1',
    body: { has_balance: true, ...decision },
    status: 'FAILED',
    attempts: 1,
    maxAttempts: 8,
    idempotencyKey: 'idem-1',
    requestId: null,
    source: 'admin',
    resourceType: 'key_balance',
    resourceId: 'key-1',
    lastError: 'timeout',
    response: null,
    nextRunAt: new Date(),
    lockedAt: null,
    processedAt: null,
    createdAt: new Date(),
    updatedAt: new Date(),
  };

  it('keeps ordinary async allow admission on the fast 202 path', async () => {
    const { service, publisher, prisma } = makeService();
    prisma.publisherSyncJob.findUnique.mockResolvedValueOnce(null);

    await expect(service.dispatchDetailed({
      namespace: 'billing',
      method: 'PUT',
      path: '/billing/api/v1/key-balance/key-1',
      body: { has_balance: true, ...decision },
    })).resolves.toEqual(expect.objectContaining({ accepted: true }));

    expect(publisher.getKeyAdmissionDelivery).not.toHaveBeenCalled();
    expect(prisma.publisherSyncJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'SUCCEEDED',
        body: { has_balance: true, ...decision },
        processedAt: expect.any(Date),
      }),
    });
  });

  it('persists async deny admission for background receipt confirmation without polling inline', async () => {
    const { service, publisher, prisma } = makeService();
    prisma.publisherSyncJob.findUnique.mockResolvedValueOnce(null);

    await expect(service.dispatchDetailed({
      namespace: 'billing',
      method: 'PUT',
      path: '/billing/api/v1/key-balance/key-1',
      body: { has_balance: false, reason: 'billing_review', ...decision },
    })).resolves.toEqual(expect.objectContaining({ accepted: true }));

    expect(publisher.getKeyAdmissionDelivery).not.toHaveBeenCalled();
    expect(prisma.publisherSyncJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'PENDING',
        body: { has_balance: false, reason: 'billing_review', ...decision },
        response: { batch_id: 'batch-1', status: 'accepted' },
        processedAt: null,
      }),
    });
  });

  it('keeps required allow admission on the fast 202 path without receipt polling', async () => {
    const { service, publisher, prisma } = makeService();
    prisma.publisherSyncJob.findUnique.mockResolvedValueOnce(null);

    await expect(service.dispatchRequired({
      namespace: 'billing',
      method: 'PUT',
      path: '/billing/api/v1/key-balance/key-1',
      body: { has_balance: true, ...decision },
    })).resolves.toEqual({ batch_id: 'batch-1', status: 'accepted' });

    expect(publisher.getKeyAdmissionDelivery).not.toHaveBeenCalled();
    expect(prisma.publisherSyncJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'SUCCEEDED',
        response: { batch_id: 'batch-1', status: 'accepted' },
        processedAt: expect.any(Date),
      }),
    });
  });

  it('retries a temporarily invisible admission receipt after Publisher returns 404', async () => {
    const { service, publisher, prisma } = makeService({
      PUBLISHER_KEY_ADMISSION_RECEIPT_POLL_INTERVAL_MS: 1,
      PUBLISHER_KEY_ADMISSION_RECEIPT_TIMEOUT_MS: 100,
    });
    publisher.getKeyAdmissionDelivery
      .mockRejectedValueOnce(new PublisherClientError('not found', 404, 'NOT_FOUND'))
      .mockResolvedValueOnce(appliedReceipt);
    const existingJob = {
      ...baseJob,
      body: { has_balance: false, reason: 'billing_review', ...decision },
      status: 'PENDING',
      attempts: 0,
      response: { batch_id: 'batch-1', status: 'accepted' },
    };
    prisma.publisherSyncJob.findUnique.mockResolvedValueOnce(existingJob);
    prisma.publisherSyncJob.updateMany.mockResolvedValueOnce({ count: 1 });

    await expect(service.dispatchRequired({
      namespace: 'billing',
      method: 'PUT',
      path: '/billing/api/v1/key-balance/key-1',
      body: { has_balance: false, reason: 'billing_review', ...decision },
    })).resolves.toEqual(expect.objectContaining({
      key_admission_delivery: appliedReceipt,
    }));

    expect(publisher.getKeyAdmissionDelivery).toHaveBeenCalledTimes(2);
    expect(prisma.publisherSyncJob.updateMany).toHaveBeenCalledWith({
      where: { id: 'job-1', status: { not: 'SUPERSEDED' } },
      data: expect.objectContaining({
        status: 'SUCCEEDED',
        response: expect.objectContaining({ key_admission_delivery: appliedReceipt }),
      }),
    });
  });

  it('persists an accepted admission batch for retry when required receipt polling times out', async () => {
    const { service, publisher, prisma } = makeService({
      PUBLISHER_KEY_ADMISSION_RECEIPT_POLL_INTERVAL_MS: 1,
      PUBLISHER_KEY_ADMISSION_RECEIPT_TIMEOUT_MS: 5,
    });
    const existingJob = {
      ...baseJob,
      status: 'PENDING',
      attempts: 0,
      response: { batch_id: 'batch-1', status: 'accepted' },
    };
    publisher.getKeyAdmissionDelivery.mockResolvedValue(admissionReceipt('pending'));
    prisma.publisherSyncJob.findUnique.mockResolvedValueOnce(existingJob);
    prisma.publisherSyncJob.updateMany.mockResolvedValueOnce({ count: 1 });

    await expect(service.dispatchRequired({
      namespace: 'billing',
      method: 'PUT',
      path: '/billing/api/v1/key-balance/key-1',
      body: { has_balance: false, reason: 'billing_review', ...decision },
    })).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(prisma.publisherSyncJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'job-1',
        status: { notIn: ['SUCCEEDED', 'SUPERSEDED'] },
      },
      data: expect.objectContaining({
        status: 'FAILED',
        attempts: 1,
        response: { batch_id: 'batch-1', status: 'accepted' },
        lastError: expect.stringContaining('KEY_ADMISSION_RECEIPT_TIMEOUT'),
        processedAt: null,
      }),
    });
  });

  it.each([
    {
      name: 'DELETE',
      method: 'DELETE' as const,
      path: '/billing/api/v1/key-balance/key-1',
      body: decision,
    },
  ])('tracks async $name admission acceptance for background receipt confirmation', async ({
    method,
    path,
    body,
  }) => {
    const { service, publisher, prisma } = makeService();
    prisma.publisherSyncJob.findUnique.mockResolvedValueOnce(null);

    await expect(service.dispatchDetailed({
      namespace: 'billing',
      method,
      path,
      body,
    })).resolves.toEqual(expect.objectContaining({ accepted: true }));

    expect(publisher.getKeyAdmissionDelivery).not.toHaveBeenCalled();
    expect(prisma.publisherSyncJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'PENDING',
        method,
        path,
        body,
        response: { batch_id: 'batch-1', status: 'accepted' },
        processedAt: null,
      }),
    });
  });

  it.each([
    {
      name: 'DELETE',
      method: 'DELETE' as const,
      path: '/billing/api/v1/key-balance/key-1',
      body: decision,
    },
  ])('waits for a delivery receipt on required $name admission', async ({
    method,
    path,
    body,
  }) => {
    const { service, publisher, prisma } = makeService();
    prisma.publisherSyncJob.findUnique.mockResolvedValueOnce(null);

    await expect(service.dispatchRequired({
      namespace: 'billing',
      method,
      path,
      body,
    })).resolves.toEqual(expect.objectContaining({
      key_admission_delivery: appliedReceipt,
    }));

    expect(publisher.getKeyAdmissionDelivery).toHaveBeenCalledWith(
      'batch-1',
      { requestId: undefined },
    );
    expect(prisma.publisherSyncJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'SUCCEEDED',
        processedAt: expect.any(Date),
      }),
    });
  });

  it.each([true, false])(
    'keeps required SaaS activation on its existing durable-acceptance boundary (has_balance=%s)',
    async (hasBalance) => {
      const { service, publisher, prisma } = makeService();
      prisma.publisherSyncJob.findUnique.mockResolvedValueOnce(null);

      await expect(service.dispatchRequired({
        namespace: 'billing',
        method: 'PUT',
        path: '/billing/api/v1/key-activation/key-1',
        body: {
          key_meta: { key_id: 'key-1', status: 'active' },
          has_balance: hasBalance,
          ...(hasBalance ? {} : { reason: 'billing_review' }),
          ...decision,
        },
      })).resolves.toEqual({ batch_id: 'batch-1', status: 'accepted' });

      expect(publisher.getKeyAdmissionDelivery).not.toHaveBeenCalled();
      expect(prisma.publisherSyncJob.create).toHaveBeenCalledWith({
        data: expect.objectContaining({
          status: 'SUCCEEDED',
          path: '/billing/api/v1/key-activation/key-1',
          processedAt: expect.any(Date),
        }),
      });
    },
  );

  it('accepts a mixed receipt when every item is applied or idempotent', async () => {
    const { service, publisher, prisma } = makeService();
    prisma.publisherSyncJob.findUnique.mockResolvedValueOnce(null);
    publisher.getKeyAdmissionDelivery.mockResolvedValueOnce({
      ...appliedReceipt,
      status: 'mixed',
      total: 2,
      applied_count: 1,
      idempotent_count: 1,
    });

    await expect(service.dispatchRequired({
      namespace: 'billing',
      method: 'PUT',
      path: '/billing/api/v1/key-balance/bulk',
      body: {
        items: [
          { key_id: 'key-1', has_balance: false, reason: 'billing_review', ...decision },
          { key_id: 'key-2', has_balance: false, reason: 'billing_review', ...decision },
        ],
      },
    })).resolves.toEqual(expect.objectContaining({
      key_admission_delivery: expect.objectContaining({
        status: 'mixed',
        applied_count: 1,
        idempotent_count: 1,
      }),
    }));
  });

  it.each(['superseded', 'conflict', 'dead_letter', 'unverified', 'mixed'] as const)(
    'fails a required admission on terminal receipt status %s while preserving its batch',
    async (status) => {
      const { service, publisher, prisma } = makeService();
      const pendingJob = {
        ...baseJob,
        status: 'PENDING',
        attempts: 0,
        response: { batch_id: 'batch-1', status: 'accepted' },
      };
      publisher.getKeyAdmissionDelivery.mockResolvedValueOnce(admissionReceipt(status));
      prisma.publisherSyncJob.findUnique.mockResolvedValueOnce(pendingJob);
      prisma.publisherSyncJob.updateMany.mockResolvedValueOnce({ count: 1 });

      const dispatch = service.dispatchRequired({
        namespace: 'billing',
        method: 'PUT',
        path: '/billing/api/v1/key-balance/key-1',
        body: { has_balance: false, reason: 'billing_review', ...decision },
      });
      await expect(dispatch).rejects.toBeInstanceOf(
        status === 'superseded'
          ? PublisherAdmissionSupersededError
          : ServiceUnavailableException,
      );

      expect(prisma.publisherSyncJob.updateMany).toHaveBeenCalledWith({
        where: {
          id: 'job-1',
          status: { notIn: ['SUCCEEDED', 'SUPERSEDED'] },
        },
        data: expect.objectContaining({
          status: status === 'superseded' ? 'SUPERSEDED' : 'FAILED',
          attempts: status === 'superseded' ? 0 : pendingJob.maxAttempts,
          response: expect.objectContaining({
            batch_id: 'batch-1',
            status: 'accepted',
            key_admission_delivery: expect.objectContaining({ status }),
          }),
          processedAt: expect.any(Date),
        }),
      });
    },
  );

  it.each([
    ['non-object response', 'invalid'],
    ['negative count', { ...appliedReceipt, applied_count: -1 }],
    ['count sum mismatch', { ...appliedReceipt, total: 2 }],
    ['status/count mismatch', { ...appliedReceipt, status: 'pending' }],
  ])('terminalizes malformed admission receipt: %s', async (_name, malformedReceipt) => {
    const { service, publisher, prisma } = makeService();
    const pendingJob = {
      ...baseJob,
      status: 'PENDING',
      attempts: 2,
      response: { batch_id: 'batch-1', status: 'accepted' },
    };
    publisher.getKeyAdmissionDelivery.mockResolvedValueOnce(malformedReceipt as never);
    prisma.publisherSyncJob.findUnique.mockResolvedValueOnce(pendingJob);
    prisma.publisherSyncJob.updateMany.mockResolvedValueOnce({ count: 1 });

    let thrown: unknown;
    try {
      await service.dispatchRequired({
        namespace: 'billing',
        method: 'PUT',
        path: '/billing/api/v1/key-balance/key-1',
        body: { has_balance: false, reason: 'billing_review', ...decision },
      });
    } catch (err) {
      thrown = err;
    }

    expect(thrown).toBeInstanceOf(ServiceUnavailableException);
    expect((thrown as ServiceUnavailableException).getResponse()).toEqual(expect.objectContaining({
      data: expect.objectContaining({
        errorCode: 'KEY_ADMISSION_RECEIPT_INVALID',
        retryable: false,
      }),
    }));
    expect(publisher.getKeyAdmissionDelivery).toHaveBeenCalledTimes(1);
    expect(prisma.publisherSyncJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'job-1',
        status: { notIn: ['SUCCEEDED', 'SUPERSEDED'] },
      },
      data: expect.objectContaining({
        status: 'FAILED',
        attempts: pendingJob.maxAttempts,
        lastError: expect.stringContaining('KEY_ADMISSION_RECEIPT_INVALID'),
        processedAt: expect.any(Date),
      }),
    });
  });

  it('does not overwrite an existing superseded admission with a later success callback', async () => {
    const { service, prisma } = makeService();
    const supersededJob = {
      ...baseJob,
      status: 'SUPERSEDED',
      response: {
        batch_id: 'batch-previous',
        status: 'accepted',
        key_admission_delivery: admissionReceipt('superseded'),
      },
      processedAt: new Date(),
    };
    prisma.publisherSyncJob.findUnique.mockResolvedValueOnce(supersededJob);

    await expect(service.dispatchRequired({
      namespace: 'billing',
      method: 'PUT',
      path: '/billing/api/v1/key-balance/key-1',
      body: { has_balance: true, ...decision },
    })).resolves.toEqual({ batch_id: 'batch-1', status: 'accepted' });

    expect(prisma.publisherSyncJob.create).not.toHaveBeenCalled();
    expect(prisma.publisherSyncJob.updateMany).not.toHaveBeenCalled();
  });

  it('keeps explicitly disabled publisher dispatches as no-op', async () => {
    const { service, publisher, prisma } = makeService();
    publisher.request.mockResolvedValueOnce(null);
    publisher.isExplicitlyDisabled.mockReturnValueOnce(true);

    await service.dispatchDetailed({
      namespace: 'billing',
      method: 'PUT',
      path: '/billing/api/v1/key-balance/key-1',
      body: { has_balance: true, revision: 1 },
    });

    expect(prisma.publisherSyncJob.findUnique).not.toHaveBeenCalled();
    expect(prisma.publisherSyncJob.create).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'legacy provider item path without resource metadata',
      path: '/admin/api/v1/providers/anthropic',
      resourceType: undefined,
    },
    {
      name: 'provider resource metadata on a non-standard path',
      path: '/admin/api/v1/models/anthropic',
      resourceType: 'provider',
    },
  ])('rejects new provider PUT jobs before dispatch: $name', async ({ path, resourceType }) => {
    const { service, publisher, prisma } = makeService();

    await expect(service.dispatchDetailed({
      namespace: 'admin',
      method: 'PUT',
      path,
      body: { synthetic: true },
      source: 'admin',
      resourceType,
      resourceId: 'anthropic',
    })).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'LEGACY_PROVIDER_PUBLISH_RETIRED',
      }),
    });

    expect(publisher.idempotencyKey).not.toHaveBeenCalled();
    expect(publisher.request).not.toHaveBeenCalled();
    expect(prisma.publisherSyncJob.findUnique).not.toHaveBeenCalled();
    expect(prisma.publisherSyncJob.create).not.toHaveBeenCalled();
    expect(prisma.publisherSyncJob.update).not.toHaveBeenCalled();
    expect(prisma.publisherSyncJob.updateMany).not.toHaveBeenCalled();
  });

  it('rejects new RuntimeIntent v1 jobs before dispatch', async () => {
    const { service, publisher, prisma } = makeService();

    await expect(service.dispatchDetailed({
      namespace: 'admin',
      method: 'POST',
      path: '/admin/api/v1/providers:from-intent',
      body: { schema_version: 1, products: [] },
      source: 'admin',
      resourceType: 'runtime_intent',
    })).rejects.toMatchObject({
      response: expect.objectContaining({
        code: 'RUNTIME_INTENT_V1_RETIRED',
      }),
    });

    expect(publisher.idempotencyKey).not.toHaveBeenCalled();
    expect(publisher.request).not.toHaveBeenCalled();
    expect(prisma.publisherSyncJob.findUnique).not.toHaveBeenCalled();
    expect(prisma.publisherSyncJob.create).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'legacy KeyPool bulk mutation',
      namespace: 'admin' as const,
      method: 'POST' as const,
      path: '/admin/api/v1/key-pools/keys/bulk',
      body: { items: [{ provider_id: 'kimi', key_id: 'key-1' }] },
      resourceType: 'key_pool',
      code: 'LEGACY_KEY_POOL_PUBLISH_RETIRED',
    },
    {
      name: 'dedicated KeyMeta bulk containing an item without provider_account_ref',
      namespace: 'user' as const,
      method: 'POST' as const,
      path: '/user/api/v1/keys/bulk',
      body: {
        items: [
          { key_id: 'ordinary-key' },
          {
            key_id: 'dedicated-key',
            dedicated_upstream: { upstream_key_id: 'entitlement-1', ciphertext: 'kms:test' },
          },
        ],
      },
      resourceType: 'key_meta',
      code: 'DEDICATED_KEY_META_V1_RETIRED',
    },
  ])('rejects new retired publisher payloads before dispatch: $name', async ({
    namespace,
    method,
    path,
    body,
    resourceType,
    code,
  }) => {
    const { service, publisher, prisma } = makeService();

    await expect(service.dispatchDetailed({
      namespace,
      method,
      path,
      body,
      resourceType,
    })).rejects.toMatchObject({
      response: expect.objectContaining({ code }),
    });

    expect(publisher.request).not.toHaveBeenCalled();
    expect(prisma.publisherSyncJob.create).not.toHaveBeenCalled();
  });

  it('continues to dispatch provider DELETE jobs', async () => {
    const { service, publisher, prisma } = makeService();
    prisma.publisherSyncJob.findUnique.mockResolvedValueOnce(null);

    await expect(service.dispatchDetailed({
      namespace: 'admin',
      method: 'DELETE',
      path: '/admin/api/v1/providers/anthropic',
      source: 'admin',
      resourceType: 'provider',
      resourceId: 'anthropic',
    })).resolves.toEqual(expect.objectContaining({ accepted: true }));

    expect(publisher.request).toHaveBeenCalledWith(
      'admin',
      'DELETE',
      '/admin/api/v1/providers/anthropic',
      undefined,
      expect.objectContaining({ idempotencyKey: 'idem-1' }),
    );
  });

  it('keeps publisher-unavailable dispatches pending for retry', async () => {
    const { service, publisher, prisma } = makeService();
    publisher.request.mockResolvedValueOnce(null);
    prisma.publisherSyncJob.findUnique.mockResolvedValueOnce(null);
    prisma.publisherSyncJob.create.mockResolvedValueOnce({ ...baseJob, status: 'PENDING', attempts: 0 });

    await service.dispatchDetailed({
      namespace: 'billing',
      method: 'PUT',
      path: '/billing/api/v1/key-balance/key-1',
      body: { has_balance: true, revision: 1 },
    });

    expect(prisma.publisherSyncJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        idempotencyKey: 'idem-1',
        status: 'PENDING',
        attempts: 0,
        lastError: expect.stringContaining('Publisher 未配置'),
        nextRunAt: expect.any(Date),
      }),
    });
  });

  it('enqueues failed publisher requests with a stable idempotency key', async () => {
    const { service, publisher, prisma } = makeService();
    publisher.request.mockRejectedValueOnce(new PublisherClientError('bad gateway', 502, 'UPSTREAM'));
    prisma.publisherSyncJob.findUnique.mockResolvedValueOnce(null);
    prisma.publisherSyncJob.create.mockResolvedValueOnce(baseJob);

    await service.dispatchDetailed({
      namespace: 'billing',
      method: 'PUT',
      path: '/billing/api/v1/key-balance/key-1',
      body: { has_balance: true, ...decision },
      source: 'admin',
      resourceType: 'key_balance',
      resourceId: 'key-1',
    });

    expect(publisher.idempotencyKey).toHaveBeenCalledWith(
      'billing',
      'PUT',
      '/billing/api/v1/key-balance/key-1',
      { has_balance: true, ...decision },
    );
    expect(prisma.publisherSyncJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        idempotencyKey: 'idem-1',
        namespace: 'billing',
        method: 'PUT',
        path: '/billing/api/v1/key-balance/key-1',
        status: 'FAILED',
        attempts: 1,
        resourceType: 'key_balance',
        resourceId: 'key-1',
      }),
    });
  });

  it('exposes failed publisher dispatches as structured status', async () => {
    const { service, publisher, prisma } = makeService();
    publisher.request.mockRejectedValueOnce(new PublisherClientError('bad gateway', 502, 'UPSTREAM'));
    prisma.publisherSyncJob.findUnique.mockResolvedValueOnce(null);
    prisma.publisherSyncJob.create.mockResolvedValueOnce(baseJob);

    const result = await service.dispatchDetailed({
      namespace: 'billing',
      method: 'PUT',
      path: '/billing/api/v1/key-balance/key-1',
      body: { has_balance: true, revision: 1 },
    });

    expect(result).toEqual({
      accepted: false,
      status: 'FAILED',
      idempotencyKey: 'idem-1',
      error: 'status=502 code=UPSTREAM bad gateway',
      errorCode: 'UPSTREAM',
      retryable: true,
      publisherStatus: 502,
    });
  });

  it('records publisher contract rejections as terminal failed jobs', async () => {
    const { service, publisher, prisma } = makeService();
    publisher.request.mockRejectedValueOnce(new PublisherClientError('invalid intent', 422, 'INVALID_ARGUMENT'));
    prisma.publisherSyncJob.findUnique.mockResolvedValueOnce(null);
    prisma.publisherSyncJob.create.mockResolvedValueOnce(baseJob);

    const result = await service.dispatchDetailed({
      namespace: 'admin',
      method: 'POST',
      path: '/admin/api/v1/providers:from-intent',
      body: { schema_version: 2 },
    });

    expect(result).toEqual({
      accepted: false,
      status: 'FAILED',
      idempotencyKey: 'idem-1',
      error: 'status=422 code=INVALID_ARGUMENT invalid intent',
      errorCode: 'INVALID_ARGUMENT',
      retryable: false,
      publisherStatus: 422,
    });
    expect(prisma.publisherSyncJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'FAILED',
        attempts: 8,
        maxAttempts: 8,
        lastError: 'status=422 code=INVALID_ARGUMENT invalid intent',
        processedAt: expect.any(Date),
      }),
    });
  });

  it('throws on required dispatch failure after recording a retry job', async () => {
    const { service, publisher, prisma } = makeService();
    publisher.request.mockRejectedValueOnce(new PublisherClientError('bad gateway', 502, 'UPSTREAM'));
    prisma.publisherSyncJob.findUnique.mockResolvedValueOnce(null);
    prisma.publisherSyncJob.create.mockResolvedValueOnce(baseJob);

    await expect(service.dispatchRequired({
      namespace: 'billing',
      method: 'PUT',
      path: '/billing/api/v1/key-balance/key-1',
      body: { has_balance: true, revision: 1 },
    })).rejects.toBeInstanceOf(ServiceUnavailableException);

    expect(prisma.publisherSyncJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        idempotencyKey: 'idem-1',
        status: 'FAILED',
        lastError: 'status=502 code=UPSTREAM bad gateway',
      }),
    });
  });

  it('throws bad request for required publisher contract rejections', async () => {
    const { service, publisher, prisma } = makeService();
    publisher.request.mockRejectedValueOnce(new PublisherClientError('invalid intent', 422, 'INVALID_ARGUMENT'));
    prisma.publisherSyncJob.findUnique.mockResolvedValueOnce(null);
    prisma.publisherSyncJob.create.mockResolvedValueOnce(baseJob);

    await expect(service.dispatchRequired({
      namespace: 'admin',
      method: 'POST',
      path: '/admin/api/v1/providers:from-intent',
      body: { schema_version: 2 },
    })).rejects.toBeInstanceOf(BadRequestException);

    expect(prisma.publisherSyncJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        status: 'FAILED',
        attempts: 8,
        lastError: 'status=422 code=INVALID_ARGUMENT invalid intent',
      }),
    });
  });

  it('resets attempts before manual retry', async () => {
    const { service, prisma } = makeService();
    prisma.publisherSyncJob.findUnique
      .mockResolvedValueOnce({ ...baseJob, attempts: 8, maxAttempts: 8 })
      .mockResolvedValueOnce({ ...baseJob, attempts: 0, status: 'PENDING' })
      .mockResolvedValueOnce({ ...baseJob, attempts: 0, status: 'PENDING' });
    prisma.publisherSyncJob.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });

    await service.retryNow('job-1');

    expect(prisma.publisherSyncJob.updateMany).toHaveBeenNthCalledWith(1, {
      where: expect.objectContaining({
        id: 'job-1',
        status: 'FAILED',
        attempts: 8,
      }),
      data: expect.objectContaining({
        status: 'PENDING',
        attempts: 0,
        processedAt: null,
      }),
    });
  });

  it('does not overwrite a job that a worker completed during manual retry', async () => {
    const { service, publisher, prisma } = makeService();
    const succeeded = { ...baseJob, status: 'SUCCEEDED', processedAt: new Date() };
    prisma.publisherSyncJob.findUnique
      .mockResolvedValueOnce(baseJob)
      .mockResolvedValueOnce(succeeded);
    prisma.publisherSyncJob.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.retryNow('job-1')).resolves.toEqual(succeeded);

    expect(prisma.publisherSyncJob.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.publisherSyncJob.update).not.toHaveBeenCalled();
    expect(publisher.request).not.toHaveBeenCalled();
  });

  it('does not clear a live PROCESSING lease during manual retry', async () => {
    const { service, publisher, prisma } = makeService();
    const processing = {
      ...baseJob,
      status: 'PROCESSING',
      lockedAt: new Date('2026-08-11T12:00:00.000Z'),
    };
    prisma.publisherSyncJob.findUnique.mockResolvedValueOnce(processing);

    await expect(service.retryNow('job-1')).resolves.toEqual(processing);

    expect(prisma.publisherSyncJob.updateMany).not.toHaveBeenCalled();
    expect(publisher.request).not.toHaveBeenCalled();
  });

  it('preserves a historical SUCCEEDED legacy provider PUT without replay or mutation', async () => {
    const { service, publisher, prisma } = makeService();
    const completedAt = new Date('2026-06-04T00:00:00.000Z');
    const legacyJob = {
      ...baseJob,
      namespace: 'admin',
      path: '/admin/api/v1/providers/anthropic',
      resourceType: 'provider',
      resourceId: 'anthropic',
      status: 'SUCCEEDED',
      attempts: 0,
      lastError: null,
      processedAt: completedAt,
      updatedAt: completedAt,
    };
    prisma.publisherSyncJob.findUnique.mockResolvedValueOnce(legacyJob);

    await expect(service.retryNow('job-1')).resolves.toEqual(legacyJob);

    expect(prisma.publisherSyncJob.findUnique).toHaveBeenCalledTimes(1);
    expect(prisma.publisherSyncJob.update).not.toHaveBeenCalled();
    expect(prisma.publisherSyncJob.updateMany).not.toHaveBeenCalled();
    expect(publisher.request).not.toHaveBeenCalled();
  });

  it('terminalizes a manual RuntimeIntent v1 retry without replay', async () => {
    const { service, publisher, prisma } = makeService();
    const legacyJob = {
      ...baseJob,
      namespace: 'admin',
      method: 'POST',
      path: '/admin/api/v1/providers:from-intent',
      body: { schema_version: 1, products: [] },
      resourceType: 'runtime_intent',
    };
    const retiredJob = {
      ...legacyJob,
      status: 'RUNTIME_INTENT_V1_RETIRED',
      attempts: legacyJob.maxAttempts,
      lastError: expect.stringContaining('RUNTIME_INTENT_V1_RETIRED'),
    };
    prisma.publisherSyncJob.findUnique
      .mockResolvedValueOnce(legacyJob)
      .mockResolvedValueOnce(retiredJob);
    prisma.publisherSyncJob.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });

    await expect(service.retryNow('job-1')).resolves.toEqual(retiredJob);

    expect(prisma.publisherSyncJob.findUnique).toHaveBeenCalledTimes(2);
    expect(prisma.publisherSyncJob.update).not.toHaveBeenCalled();
    expect(prisma.publisherSyncJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'RUNTIME_INTENT_V1_RETIRED',
        attempts: legacyJob.maxAttempts,
        processedAt: expect.any(Date),
      }),
    }));
    expect(publisher.request).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'normalized legacy KeyPool entry delete',
      namespace: 'ops',
      method: 'DELETE',
      path: 'https://publisher.test/OPS//api/v1/key-pools/kimi/keys/key-1?source=retry',
      body: null,
      resourceType: null,
      code: 'LEGACY_KEY_POOL_PUBLISH_RETIRED',
    },
    {
      name: 'legacy dedicated KeyMeta bulk write',
      namespace: 'portal',
      method: 'POST',
      path: '/portal/api/v1/keys/bulk',
      body: {
        items: [
          { dedicated_upstream: { provider_account_ref: 'pa_current' } },
          { dedicated_upstream: { upstream_key_id: 'legacy-entitlement' } },
        ],
      },
      resourceType: 'key_meta',
      code: 'DEDICATED_KEY_META_V1_RETIRED',
    },
  ])('terminalizes manual retry of $name without network replay', async ({
    namespace,
    method,
    path,
    body,
    resourceType,
    code,
  }) => {
    const { service, publisher, prisma } = makeService();
    const legacyJob = {
      ...baseJob,
      namespace,
      method,
      path,
      body,
      resourceType,
    };
    const retiredJob = {
      ...legacyJob,
      status: code,
      attempts: legacyJob.maxAttempts,
    };
    prisma.publisherSyncJob.findUnique
      .mockResolvedValueOnce(legacyJob)
      .mockResolvedValueOnce(retiredJob);
    prisma.publisherSyncJob.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });

    await expect(service.retryNow('job-1')).resolves.toEqual(retiredJob);

    expect(prisma.publisherSyncJob.findUnique).toHaveBeenCalledTimes(2);
    expect(prisma.publisherSyncJob.update).not.toHaveBeenCalled();
    expect(prisma.publisherSyncJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: code }),
    }));
    expect(publisher.request).not.toHaveBeenCalled();
  });

  it('retries due jobs using the original idempotency key', async () => {
    const { service, publisher, prisma } = makeService();
    const succeeded = { ...baseJob, status: 'SUCCEEDED' };
    prisma.publisherSyncJob.findUnique
      .mockResolvedValueOnce(baseJob)
      .mockResolvedValueOnce(succeeded);
    prisma.publisherSyncJob.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });

    await service.processOne('job-1');

    expect(publisher.request).toHaveBeenCalledWith(
      'billing',
      'PUT',
      '/billing/api/v1/key-balance/key-1',
      { has_balance: true, ...decision },
      { idempotencyKey: 'idem-1', requestId: undefined },
    );
    const lease = prisma.publisherSyncJob.updateMany.mock.calls[0][0].data.lockedAt;
    expect(prisma.publisherSyncJob.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: { id: 'job-1', status: 'PROCESSING', lockedAt: lease },
      data: expect.objectContaining({
        status: 'SUCCEEDED',
        lastError: null,
      }),
    }));
  });

  it('checks an accepted batch without replay and backs off after each pending receipt', async () => {
    jest.useFakeTimers();
    try {
      const now = new Date('2026-08-17T12:00:00.000Z');
      jest.setSystemTime(now);
      const { service, publisher, prisma } = makeService();
      const pendingJob = {
        ...baseJob,
        body: { has_balance: false, reason: 'billing_review', ...decision },
        status: 'PENDING',
        attempts: 2,
        response: { batch_id: 'batch-1', status: 'accepted' },
      };
      const pendingReceipt = admissionReceipt('pending');
      const failedJob = {
        ...pendingJob,
        status: 'FAILED',
        attempts: 3,
        lastError: 'status=503 code=KEY_ADMISSION_RECEIPT_PENDING pending',
        response: {
          batch_id: 'batch-1',
          status: 'accepted',
          key_admission_delivery: pendingReceipt,
        },
        nextRunAt: new Date(now.getTime() + 4 * 60_000),
      };
      prisma.publisherSyncJob.findUnique
        .mockResolvedValueOnce(pendingJob)
        .mockResolvedValueOnce(failedJob);
      prisma.publisherSyncJob.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 });
      publisher.getKeyAdmissionDelivery.mockResolvedValueOnce(pendingReceipt);

      await expect(service.processOne('job-1', 'worker')).resolves.toEqual(failedJob);

      expect(publisher.request).not.toHaveBeenCalled();
      expect(publisher.getKeyAdmissionDelivery).toHaveBeenCalledWith(
        'batch-1',
        { requestId: undefined },
      );
      expect(prisma.publisherSyncJob.updateMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'FAILED',
            attempts: 3,
            lastError: expect.stringContaining('KEY_ADMISSION_RECEIPT_PENDING'),
            response: expect.objectContaining({
              key_admission_delivery: expect.objectContaining({ status: 'pending' }),
            }),
            nextRunAt: new Date(now.getTime() + 4 * 60_000),
            processedAt: null,
          }),
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('terminalizes an accepted batch after receipt retries are exhausted', async () => {
    jest.useFakeTimers();
    try {
      const now = new Date('2026-08-17T12:05:00.000Z');
      jest.setSystemTime(now);
      const { service, publisher, prisma } = makeService();
      const failedJob = {
        ...baseJob,
        body: { has_balance: false, reason: 'billing_review', ...decision },
        status: 'FAILED',
        attempts: 7,
        response: { batch_id: 'batch-1', status: 'accepted' },
      };
      const exhaustedJob = {
        ...failedJob,
        attempts: 8,
        response: {
          batch_id: 'batch-1',
          status: 'accepted',
          key_admission_delivery: admissionReceipt('pending'),
        },
        processedAt: now,
        nextRunAt: now,
      };
      prisma.publisherSyncJob.findUnique
        .mockResolvedValueOnce(failedJob)
        .mockResolvedValueOnce(exhaustedJob);
      prisma.publisherSyncJob.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 });
      publisher.getKeyAdmissionDelivery.mockResolvedValueOnce(admissionReceipt('pending'));

      await expect(service.processOne('job-1', 'worker')).resolves.toEqual(exhaustedJob);

      expect(publisher.request).not.toHaveBeenCalled();
      expect(publisher.getKeyAdmissionDelivery).toHaveBeenCalledTimes(1);
      expect(prisma.publisherSyncJob.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
        data: expect.objectContaining({
          status: 'FAILED',
          attempts: 8,
          nextRunAt: now,
          processedAt: now,
        }),
      }));
    } finally {
      jest.useRealTimers();
    }
  });

  it('reclaims a stale accepted batch by reading its receipt and persists terminal evidence', async () => {
    jest.useFakeTimers();
    try {
      const now = new Date('2026-08-17T12:10:00.000Z');
      jest.setSystemTime(now);
      const { service, publisher, prisma } = makeService({
        PUBLISHER_SYNC_JOB_LEASE_SECONDS: 60,
      });
      const staleJob = {
        ...baseJob,
        body: { has_balance: false, reason: 'billing_review', ...decision },
        status: 'PROCESSING',
        attempts: 2,
        response: { batch_id: 'batch-1', status: 'accepted' },
        lockedAt: new Date('2026-08-17T12:08:00.000Z'),
      };
      const succeeded = {
        ...staleJob,
        status: 'SUCCEEDED',
        response: {
          batch_id: 'batch-1',
          status: 'accepted',
          key_admission_delivery: appliedReceipt,
        },
        lockedAt: null,
        processedAt: now,
      };
      prisma.publisherSyncJob.findUnique
        .mockResolvedValueOnce(staleJob)
        .mockResolvedValueOnce(succeeded);
      prisma.publisherSyncJob.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 });
      publisher.getKeyAdmissionDelivery.mockResolvedValueOnce(appliedReceipt);

      await expect(service.processOne('job-1', 'worker')).resolves.toEqual(succeeded);

      expect(publisher.request).not.toHaveBeenCalled();
      expect(publisher.getKeyAdmissionDelivery).toHaveBeenCalledTimes(1);
      expect(prisma.publisherSyncJob.updateMany).toHaveBeenNthCalledWith(
        2,
        expect.objectContaining({
          data: expect.objectContaining({
            status: 'SUCCEEDED',
            response: expect.objectContaining({
              key_admission_delivery: appliedReceipt,
            }),
            processedAt: now,
          }),
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('terminalizes a superseded background admission without replay or false success', async () => {
    const { service, publisher, prisma } = makeService();
    const pendingJob = {
      ...baseJob,
      body: { has_balance: false, reason: 'billing_review', ...decision },
      status: 'PENDING',
      attempts: 1,
      response: { batch_id: 'batch-1', status: 'accepted' },
    };
    const supersededJob = {
      ...pendingJob,
      status: 'SUPERSEDED',
      response: {
        batch_id: 'batch-1',
        status: 'accepted',
        key_admission_delivery: admissionReceipt('superseded'),
      },
      processedAt: new Date(),
    };
    prisma.publisherSyncJob.findUnique
      .mockResolvedValueOnce(pendingJob)
      .mockResolvedValueOnce(supersededJob);
    prisma.publisherSyncJob.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    publisher.getKeyAdmissionDelivery.mockResolvedValueOnce(admissionReceipt('superseded'));

    await expect(service.processOne('job-1', 'worker')).resolves.toEqual(supersededJob);

    expect(publisher.request).not.toHaveBeenCalled();
    expect(prisma.publisherSyncJob.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      data: expect.objectContaining({
        status: 'SUPERSEDED',
        attempts: 1,
        lastError: expect.stringContaining('KEY_ADMISSION_SUPERSEDED'),
        processedAt: expect.any(Date),
      }),
    }));
  });

  it.each([
    {
      name: 'retry exhaustion',
      job: { ...baseJob, attempts: 7, maxAttempts: 8 },
      error: new PublisherClientError('bad gateway', 502, 'UPSTREAM'),
      outcome: 'exhausted',
    },
    {
      name: 'permanent rejection',
      job: { ...baseJob, attempts: 1, maxAttempts: 8 },
      error: new PublisherClientError('invalid intent', 422, 'INVALID_ARGUMENT'),
      outcome: 'permanent_failed',
    },
  ])('counts $name independently for worker retries', async ({ job, error, outcome }) => {
    const { service, publisher, prisma } = makeService();
    const terminal = {
      ...job,
      status: 'FAILED',
      attempts: job.maxAttempts,
      processedAt: new Date(),
    };
    prisma.publisherSyncJob.findUnique
      .mockResolvedValueOnce(job)
      .mockResolvedValueOnce(terminal);
    prisma.publisherSyncJob.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });
    publisher.request.mockRejectedValueOnce(error);
    const before = await metricValue(publisherRetryWorkerTotal, outcome);

    await service.processOne('job-1', 'worker');

    await expect(metricValue(publisherRetryWorkerTotal, outcome)).resolves.toBe(before + 1);
  });

  it('records a lost result-write lease as skipped instead of a false worker success', async () => {
    const { service, prisma } = makeService();
    const succeeded = { ...baseJob, status: 'SUCCEEDED' };
    prisma.publisherSyncJob.findUnique
      .mockResolvedValueOnce(baseJob)
      .mockResolvedValueOnce(succeeded);
    prisma.publisherSyncJob.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 0 });
    const succeededBefore = await metricValue(publisherRetryWorkerTotal, 'succeeded');
    const skippedBefore = await metricValue(publisherRetryWorkerTotal, 'skipped');

    await expect(service.processOne('job-1', 'worker')).resolves.toEqual(succeeded);

    await expect(metricValue(publisherRetryWorkerTotal, 'succeeded'))
      .resolves.toBe(succeededBefore);
    await expect(metricValue(publisherRetryWorkerTotal, 'skipped'))
      .resolves.toBe(skippedBefore + 1);
  });

  it('retries legacy portal jobs against the current user namespace', async () => {
    const { service, publisher, prisma } = makeService();
    const legacyJob = {
      ...baseJob,
      namespace: 'portal',
      path: '/portal/api/v1/keys/hash-1',
      resourceType: 'api_key',
      resourceId: 'key-1',
    };
    prisma.publisherSyncJob.findUnique
      .mockResolvedValueOnce(legacyJob)
      .mockResolvedValueOnce({ ...legacyJob, status: 'SUCCEEDED' });
    prisma.publisherSyncJob.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });

    await service.processOne('job-1');

    expect(publisher.request).toHaveBeenCalledWith(
      'user',
      'PUT',
      '/user/api/v1/keys/hash-1',
      { has_balance: true, ...decision },
      { idempotencyKey: 'idem-1', requestId: undefined },
    );
  });

  it('terminalizes legacy provider PUT before applying the ops-to-admin mapping', async () => {
    const { service, publisher, prisma } = makeService();
    const legacyJob = {
      ...baseJob,
      namespace: 'ops',
      path: '/ops/api/v1/providers/openai',
      resourceType: 'provider',
      resourceId: 'openai',
    };
    const retiredJob = {
      ...legacyJob,
      status: 'LEGACY_PROVIDER_PUBLISH_RETIRED',
      attempts: legacyJob.maxAttempts,
    };
    prisma.publisherSyncJob.findUnique
      .mockResolvedValueOnce(legacyJob)
      .mockResolvedValueOnce(retiredJob);
    prisma.publisherSyncJob.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });

    await expect(service.processOne('job-1')).resolves.toEqual(retiredJob);

    expect(prisma.publisherSyncJob.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({
        status: 'PROCESSING',
        lockedAt: expect.any(Date),
      }),
      data: expect.objectContaining({ status: 'LEGACY_PROVIDER_PUBLISH_RETIRED' }),
    }));
    expect(prisma.publisherSyncJob.update).not.toHaveBeenCalled();
    expect(publisher.request).not.toHaveBeenCalled();
  });

  it('does not retire a legacy payload while a live worker still owns its lease', async () => {
    const { service, publisher, prisma } = makeService();
    const processing = {
      ...baseJob,
      namespace: 'ops',
      path: '/ops/api/v1/providers/openai',
      resourceType: 'provider',
      resourceId: 'openai',
      status: 'PROCESSING',
      lockedAt: new Date(),
    };
    prisma.publisherSyncJob.findUnique
      .mockResolvedValueOnce(processing)
      .mockResolvedValueOnce(processing);
    prisma.publisherSyncJob.updateMany.mockResolvedValueOnce({ count: 0 });

    await expect(service.processOne('job-1')).resolves.toEqual(processing);

    expect(prisma.publisherSyncJob.updateMany).toHaveBeenCalledTimes(1);
    expect(prisma.publisherSyncJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'PROCESSING' }),
    }));
    expect(prisma.publisherSyncJob.updateMany).not.toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({ status: 'LEGACY_PROVIDER_PUBLISH_RETIRED' }),
    }));
    expect(publisher.request).not.toHaveBeenCalled();
  });

  it('preserves direct processing history for a SUCCEEDED legacy provider PUT', async () => {
    const { service, publisher, prisma } = makeService();
    const succeeded = {
      ...baseJob,
      namespace: 'admin',
      path: '/admin/api/v1/providers/anthropic',
      resourceType: 'provider',
      resourceId: 'anthropic',
      status: 'SUCCEEDED',
    };
    prisma.publisherSyncJob.findUnique.mockResolvedValueOnce(succeeded);

    await expect(service.processOne('job-1')).resolves.toEqual(succeeded);

    expect(prisma.publisherSyncJob.updateMany).not.toHaveBeenCalled();
    expect(prisma.publisherSyncJob.update).not.toHaveBeenCalled();
    expect(publisher.request).not.toHaveBeenCalled();
  });

  it('keeps current non-provider ops-to-admin retry mapping', async () => {
    const { service, publisher, prisma } = makeService();
    const legacyJob = {
      ...baseJob,
      namespace: 'ops',
      path: '/ops/api/v1/platform-config',
      resourceType: 'platform_config',
      resourceId: 'global',
    };
    prisma.publisherSyncJob.findUnique
      .mockResolvedValueOnce(legacyJob)
      .mockResolvedValueOnce({ ...legacyJob, status: 'SUCCEEDED' });
    prisma.publisherSyncJob.updateMany
      .mockResolvedValueOnce({ count: 1 })
      .mockResolvedValueOnce({ count: 1 });

    await service.processOne('job-1');

    expect(publisher.request).toHaveBeenCalledWith(
      'admin',
      'PUT',
      '/admin/api/v1/platform-config',
      { has_balance: true, ...decision },
      { idempotencyKey: 'idem-1', requestId: undefined },
    );
  });

  it('discovers abandoned PROCESSING jobs after the default five-minute lease', async () => {
    jest.useFakeTimers();
    try {
      const now = new Date('2026-08-06T12:10:00.000Z');
      jest.setSystemTime(now);
      const { service, prisma } = makeService();
      prisma.publisherSyncJob.findMany.mockResolvedValueOnce([]);

      await service.processDue(20);

      expect(prisma.publisherSyncJob.findMany).toHaveBeenCalledWith(expect.objectContaining({
        where: {
          OR: [
            {
              status: { in: ['PENDING', 'FAILED'] },
              processedAt: null,
              nextRunAt: { lte: now },
            },
            {
              status: 'PROCESSING',
              OR: [
                { lockedAt: null },
                { lockedAt: { lte: new Date('2026-08-06T12:05:00.000Z') } },
              ],
            },
          ],
        },
      }));
    } finally {
      jest.useRealTimers();
    }
  });

  it('processes accepted admission receipts through the unified bounded retry queue', async () => {
    jest.useFakeTimers();
    try {
      const now = new Date('2026-08-17T13:00:00.000Z');
      jest.setSystemTime(now);
      const { service, prisma } = makeService();
      const regularJob = {
        ...baseJob,
        id: 'regular-pending-job',
        status: 'PENDING',
        nextRunAt: new Date(now.getTime() - 1_000),
        createdAt: new Date(now.getTime() - 1_000),
      };
      const admissionJobs = Array.from({ length: 3 }, (_, index) => ({
        ...baseJob,
        id: `admission-receipt-${index}`,
        body: { has_balance: false, reason: 'billing_review', ...decision },
        status: index === 0 ? 'FAILED' : 'PENDING',
        response: { batch_id: `batch-${index}`, status: 'accepted' },
        nextRunAt: new Date(now.getTime() - 10_000 + index),
        createdAt: new Date(now.getTime() - 10_000 + index),
      }));
      prisma.publisherSyncJob.findMany
        .mockResolvedValueOnce([...admissionJobs, regularJob])
        .mockResolvedValueOnce([]);
      const processOne = jest.spyOn(service, 'processOne').mockImplementation(async (id) => ({
        ...(id === regularJob.id
          ? regularJob
          : admissionJobs.find((job) => job.id === id)!),
        status: 'SUCCEEDED',
      }));

      await expect(service.processDue(4)).resolves.toEqual({
        processed: 4,
        succeeded: 4,
        failed: 0,
      });

      expect(processOne).toHaveBeenCalledTimes(4);
      expect(processOne).toHaveBeenCalledWith('regular-pending-job', 'worker');
      expect(processOne.mock.calls.filter(([id]) => id.startsWith('admission-receipt-')))
        .toHaveLength(3);
      expect(prisma.publisherSyncJob.findMany).toHaveBeenNthCalledWith(
        1,
        expect.objectContaining({
          where: expect.objectContaining({
            OR: expect.arrayContaining([
              expect.objectContaining({ status: { in: ['PENDING', 'FAILED'] } }),
            ]),
          }),
          take: 4,
        }),
      );
    } finally {
      jest.useRealTimers();
    }
  });

  it('samples the current retryable backlog and oldest age from Publisher jobs', async () => {
    jest.useFakeTimers();
    try {
      jest.setSystemTime(new Date('2026-08-07T12:00:00.000Z'));
      const { service, prisma } = makeService();
      prisma.publisherSyncJob.aggregate.mockResolvedValueOnce({
        _count: { _all: 9 },
        _min: { createdAt: new Date('2026-08-07T11:50:00.000Z') },
      });

      await service.refreshRetryBacklogMetrics();

      expect(prisma.publisherSyncJob.aggregate).toHaveBeenCalledWith({
        where: {
          OR: [
            { status: 'PENDING' },
            { status: 'FAILED', processedAt: null },
            { status: 'PROCESSING' },
          ],
        },
        _count: { _all: true },
        _min: { createdAt: true },
      });
      await expect(metricValue(publisherRetryBacklog)).resolves.toBe(9);
      await expect(metricValue(publisherRetryBacklogOldestAgeSeconds))
        .resolves.toBe(600);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not throw when the Publisher backlog metrics query fails', async () => {
    const { service, prisma } = makeService();
    const failuresBefore = await metricValue(
      publisherRetryWorkerTotal,
      'metrics_query_failed',
    );
    prisma.publisherSyncJob.aggregate
      .mockRejectedValueOnce(new Error('metrics database unavailable'));

    await expect(service.refreshRetryBacklogMetrics()).resolves.toBeUndefined();
    await expect(metricValue(publisherRetryWorkerTotal, 'metrics_query_failed'))
      .resolves.toBe(failuresBefore + 1);
  });

  it('reclaims a PROCESSING job after the configured lease when the prior worker crashed', async () => {
    jest.useFakeTimers();
    try {
      const now = new Date('2026-08-06T12:10:00.000Z');
      const staleLock = new Date('2026-08-06T12:08:59.000Z');
      jest.setSystemTime(now);
      const { service, publisher, prisma } = makeService({
        PUBLISHER_SYNC_JOB_LEASE_SECONDS: 60,
      });
      const abandoned = { ...baseJob, status: 'PROCESSING', lockedAt: staleLock };
      const succeeded = {
        ...abandoned,
        status: 'SUCCEEDED',
        lockedAt: null,
        processedAt: now,
      };
      prisma.publisherSyncJob.findUnique
        .mockResolvedValueOnce(abandoned)
        .mockResolvedValueOnce(succeeded);
      prisma.publisherSyncJob.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 });

      await expect(service.processOne('job-1')).resolves.toEqual(succeeded);

      expect(prisma.publisherSyncJob.updateMany).toHaveBeenNthCalledWith(1, {
        where: {
          id: 'job-1',
          attempts: abandoned.attempts,
          OR: [
            { status: { in: ['PENDING', 'FAILED'] } },
            {
              status: 'PROCESSING',
              OR: [
                { lockedAt: null },
                { lockedAt: { lte: new Date('2026-08-06T12:09:00.000Z') } },
              ],
            },
          ],
        },
        data: { status: 'PROCESSING', lockedAt: now },
      });
      expect(prisma.publisherSyncJob.updateMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
        where: { id: 'job-1', status: 'PROCESSING', lockedAt: now },
        data: expect.objectContaining({ status: 'SUCCEEDED' }),
      }));
      expect(publisher.request).toHaveBeenCalledTimes(1);
      expect(prisma.publisherSyncJob.update).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('fences a stale worker result after a second owner reclaims its expired lease', async () => {
    jest.useFakeTimers();
    try {
      const oldLease = new Date('2026-08-06T12:00:00.000Z');
      const newLease = new Date('2026-08-06T12:01:01.000Z');
      jest.setSystemTime(oldLease);
      const { service, publisher, prisma } = makeService({
        PUBLISHER_SYNC_JOB_LEASE_SECONDS: 60,
      });
      const initial = { ...baseJob, status: 'PENDING', lockedAt: null };
      const reclaimed = { ...baseJob, status: 'PROCESSING', lockedAt: oldLease };
      const newOwnerResult = {
        ...baseJob,
        status: 'SUCCEEDED',
        response: { batch_id: 'batch-new-owner', status: 'accepted' },
        lockedAt: null,
        processedAt: newLease,
      };
      prisma.publisherSyncJob.findUnique
        .mockResolvedValueOnce(initial)
        .mockResolvedValueOnce(reclaimed)
        .mockResolvedValueOnce(newOwnerResult)
        .mockResolvedValueOnce(newOwnerResult);
      prisma.publisherSyncJob.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });

      let markOldRequestStarted!: () => void;
      const oldRequestStarted = new Promise<void>((resolve) => {
        markOldRequestStarted = resolve;
      });
      let resolveOldRequest!: (value: { batch_id: string; status: 'accepted' }) => void;
      const oldRequest = new Promise<{ batch_id: string; status: 'accepted' }>((resolve) => {
        resolveOldRequest = resolve;
      });
      publisher.request.mockImplementationOnce(async () => {
        markOldRequestStarted();
        return oldRequest;
      });

      const oldWorker = service.processOne('job-1');
      await oldRequestStarted;
      jest.setSystemTime(newLease);
      const newWorkerResult = await service.processOne('job-1');
      resolveOldRequest({ batch_id: 'batch-old-owner', status: 'accepted' });
      const staleWorkerResult = await oldWorker;

      expect(newWorkerResult).toEqual(newOwnerResult);
      expect(staleWorkerResult).toEqual(newOwnerResult);
      expect(publisher.request).toHaveBeenCalledTimes(2);
      expect(prisma.publisherSyncJob.updateMany).toHaveBeenNthCalledWith(3, expect.objectContaining({
        where: { id: 'job-1', status: 'PROCESSING', lockedAt: newLease },
        data: expect.objectContaining({ status: 'SUCCEEDED' }),
      }));
      expect(prisma.publisherSyncJob.updateMany).toHaveBeenNthCalledWith(4, expect.objectContaining({
        where: { id: 'job-1', status: 'PROCESSING', lockedAt: oldLease },
        data: expect.objectContaining({ status: 'SUCCEEDED' }),
      }));
      expect(prisma.publisherSyncJob.update).not.toHaveBeenCalled();
    } finally {
      jest.useRealTimers();
    }
  });

  it('terminalizes due legacy provider PUT jobs without starving normal retries in the same batch', async () => {
    const { service, publisher, prisma } = makeService();
    const legacyJob = {
      ...baseJob,
      id: 'legacy-provider-job',
      namespace: 'ops',
      path: '/ops/api/v1/providers/anthropic',
      resourceType: 'provider',
      resourceId: 'anthropic',
    };
    const normalJob = { ...baseJob, id: 'normal-key-balance-job' };
    prisma.publisherSyncJob.findMany.mockResolvedValueOnce([legacyJob, normalJob]);
    prisma.publisherSyncJob.updateMany.mockResolvedValueOnce({ count: 1 });
    const processOne = jest
      .spyOn(service, 'processOne')
      .mockResolvedValueOnce({ ...normalJob, status: 'SUCCEEDED' });
    const loggerWarn = jest.spyOn(
      Reflect.get(service, 'logger') as { warn: (message: string) => void },
      'warn',
    );

    await expect(service.processDue(20)).resolves.toEqual({
      processed: 2,
      succeeded: 1,
      failed: 1,
    });

    expect(prisma.publisherSyncJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'legacy-provider-job',
        status: legacyJob.status,
        attempts: legacyJob.attempts,
        lockedAt: legacyJob.lockedAt,
        processedAt: legacyJob.processedAt,
      },
      data: expect.objectContaining({
        status: 'LEGACY_PROVIDER_PUBLISH_RETIRED',
        attempts: legacyJob.maxAttempts,
        lastError: expect.stringContaining('LEGACY_PROVIDER_PUBLISH_RETIRED'),
        processedAt: expect.any(Date),
      }),
    });
    expect(loggerWarn).toHaveBeenCalledWith(expect.stringContaining('LEGACY_PROVIDER_PUBLISH_RETIRED'));
    expect(processOne).toHaveBeenCalledTimes(1);
    expect(processOne).toHaveBeenCalledWith('normal-key-balance-job', 'worker');
    expect(publisher.request).not.toHaveBeenCalled();
  });

  it('terminalizes due RuntimeIntent v1 jobs without replaying their old idempotency key', async () => {
    const { service, publisher, prisma } = makeService();
    const v1Job = {
      ...baseJob,
      id: 'runtime-intent-v1-job',
      namespace: 'admin',
      method: 'POST',
      path: '/admin/api/v1/providers:from-intent',
      body: { schema_version: 1, products: [] },
      resourceType: 'runtime_intent',
    };
    prisma.publisherSyncJob.findMany.mockResolvedValueOnce([v1Job]);
    prisma.publisherSyncJob.updateMany.mockResolvedValueOnce({ count: 1 });

    await expect(service.processDue(20)).resolves.toEqual({
      processed: 1,
      succeeded: 0,
      failed: 1,
    });

    expect(prisma.publisherSyncJob.updateMany).toHaveBeenCalledWith({
      where: {
        id: 'runtime-intent-v1-job',
        status: v1Job.status,
        attempts: v1Job.attempts,
        lockedAt: v1Job.lockedAt,
        processedAt: v1Job.processedAt,
      },
      data: expect.objectContaining({
        status: 'RUNTIME_INTENT_V1_RETIRED',
        attempts: v1Job.maxAttempts,
        lastError: expect.stringContaining('RUNTIME_INTENT_V1_RETIRED'),
        processedAt: expect.any(Date),
      }),
    });
    expect(publisher.request).not.toHaveBeenCalled();
  });

  it('sweeps historical permanent RuntimeIntent v1 failures into the retired terminal state', async () => {
    const { service, publisher, prisma } = makeService();
    const historicalFailure = {
      ...baseJob,
      id: 'historical-runtime-v1',
      namespace: 'admin',
      method: 'POST',
      path: '/admin/api/v1/providers:from-intent',
      body: { schema_version: 1, products: [] },
      resourceType: 'runtime_intent',
      attempts: baseJob.maxAttempts,
      processedAt: new Date('2026-08-10T00:00:00.000Z'),
    };
    prisma.publisherSyncJob.findMany
      .mockResolvedValueOnce([])
      .mockResolvedValueOnce([historicalFailure]);
    prisma.publisherSyncJob.updateMany.mockResolvedValueOnce({ count: 1 });
    prisma.publisherSyncJob.findUnique.mockResolvedValueOnce({
      ...historicalFailure,
      status: 'RUNTIME_INTENT_V1_RETIRED',
    });

    await expect(service.processDue(20)).resolves.toEqual({
      processed: 1,
      succeeded: 0,
      failed: 1,
    });

    expect(prisma.publisherSyncJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: 'RUNTIME_INTENT_V1_RETIRED',
        lastError: expect.stringContaining('previous_error: timeout'),
      }),
    }));
    expect(prisma.publisherSyncJob.findMany).toHaveBeenNthCalledWith(2, expect.objectContaining({
      where: expect.objectContaining({
        status: { in: ['PENDING', 'FAILED'] },
      }),
    }));
    expect(publisher.request).not.toHaveBeenCalled();
  });

  it('marks anomalous exhausted jobs processed so they cannot starve later due work', async () => {
    const { service, publisher, prisma } = makeService();
    const exhausted = {
      ...baseJob,
      id: 'exhausted-unprocessed',
      attempts: baseJob.maxAttempts,
      processedAt: null,
    };
    prisma.publisherSyncJob.findMany
      .mockResolvedValueOnce([exhausted])
      .mockResolvedValueOnce([]);
    prisma.publisherSyncJob.updateMany.mockResolvedValueOnce({ count: 1 });

    await expect(service.processDue(20)).resolves.toEqual({
      processed: 1,
      succeeded: 0,
      failed: 1,
    });

    expect(prisma.publisherSyncJob.updateMany).toHaveBeenCalledWith({
      where: expect.objectContaining({
        id: 'exhausted-unprocessed',
        attempts: exhausted.maxAttempts,
        processedAt: null,
      }),
      data: expect.objectContaining({
        status: 'FAILED',
        processedAt: expect.any(Date),
      }),
    });
    expect(publisher.request).not.toHaveBeenCalled();
  });

  it.each([
    {
      name: 'old generic KeyPool mutation job',
      namespace: 'ops',
      method: 'POST',
      path: '/legacy/generic-publisher-sync',
      body: { items: [{ provider_id: 'kimi', key_id: 'key-1' }] },
      resourceType: 'key_pool',
      code: 'LEGACY_KEY_POOL_PUBLISH_RETIRED',
    },
    {
      name: 'dedicated KeyMeta bulk containing an item without provider_account_ref',
      namespace: 'portal',
      method: 'POST',
      path: '/portal/api/v1/keys/bulk',
      body: {
        items: [
          { dedicated_upstream: { provider_account_ref: 'pa_current' } },
          {
            dedicated_upstream: { upstream_key_id: 'entitlement-1', ciphertext: 'kms:test' },
          },
        ],
      },
      resourceType: 'key_meta',
      code: 'DEDICATED_KEY_META_V1_RETIRED',
    },
  ])('terminalizes due retired payloads without network replay: $name', async ({
    namespace,
    method,
    path,
    body,
    resourceType,
    code,
  }) => {
    const { service, publisher, prisma } = makeService();
    const legacyJob = {
      ...baseJob,
      id: `retired-${resourceType}`,
      namespace,
      method,
      path,
      body,
      resourceType,
    };
    prisma.publisherSyncJob.findMany.mockResolvedValueOnce([legacyJob]);
    prisma.publisherSyncJob.updateMany.mockResolvedValueOnce({ count: 1 });

    await expect(service.processDue(20)).resolves.toEqual({
      processed: 1,
      succeeded: 0,
      failed: 1,
    });

    expect(prisma.publisherSyncJob.updateMany).toHaveBeenCalledWith(expect.objectContaining({
      data: expect.objectContaining({
        status: code,
        lastError: expect.stringContaining(code),
        processedAt: expect.any(Date),
      }),
    }));
    expect(publisher.request).not.toHaveBeenCalled();
  });
});
