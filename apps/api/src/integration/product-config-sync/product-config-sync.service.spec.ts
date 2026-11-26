import { ProductConfigSyncService } from './product-config-sync.service';

jest.mock('../../common/utils/url-guard.util', () => ({
  assertSafeExternalUrl: jest.fn().mockResolvedValue(undefined),
}));

describe('ProductConfigSyncService', () => {
  const fetchSpy = jest.fn();
  const config = {
    get: jest.fn((key: string) => {
      if (key === 'SYNC_TOKEN') return 'sync-token';
      if (key === 'SYNC_WEBHOOK_SECRET') return 'webhook-secret';
      return '';
    }),
  };

  beforeEach(() => {
    jest.clearAllMocks();
    (global as any).fetch = fetchSpy;
  });

  it('enqueues one coalesced config sync job per product', async () => {
    const prisma = {
      product: {
        findMany: jest.fn().mockResolvedValue([
          {
            id: 'product-1',
            slug: 'raytone',
            webhookUrl: 'https://saas.example/api/mgmt/sync/webhook',
            webhookSecretEncrypted: null,
          },
        ]),
      },
      productConfigSyncJob: {
        findUnique: jest.fn().mockResolvedValue(null),
        create: jest.fn().mockImplementation(({ data }) => Promise.resolve({ id: 'job-1', ...data })),
      },
    };
    const service = new ProductConfigSyncService(prisma as any, config as any);

    const result = await service.enqueueAll('model_pricing_changed');

    expect(result).toEqual({ queued: 1, skipped: 0 });
    expect(prisma.productConfigSyncJob.create).toHaveBeenCalledWith({
      data: expect.objectContaining({
        productSlug: 'raytone',
        changeType: 'model_pricing_changed',
        idempotencyKey: 'product-config:raytone:model_pricing_changed:global:all',
        resourceType: 'product_config_event',
        resourceId: 'raytone:model_pricing_changed',
        status: 'PENDING',
        payload: expect.objectContaining({
          type: 'model_pricing_changed',
          productSlug: 'raytone',
          resources: ['model_pricing', 'channels'],
        }),
      }),
    });
  });

  it('delivers a signed webhook and marks the job succeeded', async () => {
    const job = {
      id: 'job-1',
      productSlug: 'raytone',
      changeType: 'model_pricing_changed',
      payload: {
        type: 'model_pricing_changed',
        productSlug: 'raytone',
        resources: ['model_pricing', 'channels'],
      },
      status: 'PENDING',
      attempts: 0,
      maxAttempts: 8,
      idempotencyKey: 'product-config:raytone:model_pricing_changed:global:all',
      productId: 'product-1',
      source: 'billing',
      resourceType: 'product_config_event',
      resourceId: 'raytone:model_pricing_changed',
      lastError: null,
      response: null,
      nextRunAt: new Date(),
      lockedAt: null,
      processedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
    };
    const prisma = {
      product: {
        findFirst: jest.fn().mockResolvedValue({
          id: 'product-1',
          slug: 'raytone',
          webhookUrl: 'https://saas.example/api/mgmt/sync/webhook',
          webhookSecretEncrypted: null,
        }),
      },
      productConfigSyncJob: {
        findUnique: jest.fn().mockResolvedValue(job),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        update: jest.fn().mockImplementation(({ data }) => Promise.resolve({ ...job, ...data })),
      },
    };
    fetchSpy.mockResolvedValue({
      ok: true,
      status: 200,
      text: jest.fn().mockResolvedValue('{"ok":true}'),
    });
    const service = new ProductConfigSyncService(prisma as any, config as any);

    const result = await service.processOne('job-1');

    expect(fetchSpy).toHaveBeenCalledWith(
      'https://saas.example/api/mgmt/sync/webhook',
      expect.objectContaining({
        method: 'POST',
        headers: expect.objectContaining({
          'X-Sync-Token': 'sync-token',
          'X-Webhook-Signature': expect.any(String),
        }),
      }),
    );
    expect(result?.status).toBe('SUCCEEDED');
    expect(prisma.productConfigSyncJob.update).toHaveBeenCalledWith({
      where: { id: 'job-1' },
      data: expect.objectContaining({
        status: 'SUCCEEDED',
        lastError: null,
      }),
    });
  });
});
