import { MODULE_METADATA } from '@nestjs/common/constants';
import { Test } from '@nestjs/testing';
import { ProductBillingMode } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherClient } from '../publisher/publisher.client';
import { PublisherKeyBalanceBootstrapService } from '../publisher/publisher-key-balance-bootstrap.service';
import { PublisherModule } from '../publisher/publisher.module';
import { PublisherSyncService } from '../publisher/publisher-sync.service';
import { PublisherSyncWorkerService } from '../publisher/publisher-sync-worker.service';
import { RollingQuotaGateSchedulerService } from '../publisher/rolling-quota-gate-scheduler.service';
import { RedisModule } from '../redis/redis.module';
import { ProviderAccountReadinessModule } from './provider-account-readiness.module';

function providerToken(entry: unknown): unknown {
  if (typeof entry === 'object' && entry !== null && 'provide' in entry) {
    return (entry as { provide: unknown }).provide;
  }
  return entry;
}

describe('ProviderAccountReadinessModule', () => {
  it('does not compose Publisher workers, schedulers, bootstrap or Redis modules', () => {
    const imports = Reflect.getMetadata(
      MODULE_METADATA.IMPORTS,
      ProviderAccountReadinessModule,
    ) as unknown[];
    const providerTokens = (Reflect.getMetadata(
      MODULE_METADATA.PROVIDERS,
      ProviderAccountReadinessModule,
    ) as unknown[]).map(providerToken);

    expect(imports).not.toEqual(expect.arrayContaining([PublisherModule, RedisModule]));
    expect(providerTokens).toContain(PublisherSyncService);
    expect(providerTokens).not.toEqual(expect.arrayContaining([
      PublisherSyncWorkerService,
      PublisherKeyBalanceBootstrapService,
      RollingQuotaGateSchedulerService,
    ]));
  });

  it('initializes in production without enabling a Publisher worker', async () => {
    const originalNodeEnv = process.env.NODE_ENV;
    const originalService = process.env.RUIDONG_SERVICE;
    const originalWorkerEnabled = process.env.PUBLISHER_SYNC_WORKER_ENABLED;
    process.env.NODE_ENV = 'production';
    process.env.RUIDONG_SERVICE = 'billing';
    delete process.env.PUBLISHER_SYNC_WORKER_ENABLED;

    try {
      const moduleRef = await Test.createTestingModule({
        imports: [ProviderAccountReadinessModule],
      })
        .overrideProvider(PrismaService)
        .useValue({})
        .compile();
      await moduleRef.init();

      expect(moduleRef.get(PublisherSyncService)).toBeInstanceOf(PublisherSyncService);
      await moduleRef.close();
    } finally {
      restoreEnv('NODE_ENV', originalNodeEnv);
      restoreEnv('RUIDONG_SERVICE', originalService);
      restoreEnv('PUBLISHER_SYNC_WORKER_ENABLED', originalWorkerEnabled);
    }
  });

  it('builds RuntimeIntent with local monotonic revisions and no network-capable client', async () => {
    const prisma = {
      product: {
        findMany: jest.fn().mockResolvedValue([{
          id: 'product-with-runtime-policy',
          billingMode: ProductBillingMode.SUBSCRIPTION,
          runtimePolicy: { id: 'runtime-policy-1' },
        }]),
      },
      productChannel: { findMany: jest.fn().mockResolvedValue([]) },
      productChannelGroup: { findMany: jest.fn().mockResolvedValue([]) },
      routeAssignment: { findMany: jest.fn().mockResolvedValue([]) },
      modelPricing: { findMany: jest.fn().mockResolvedValue([]) },
    };
    const moduleRef = await Test.createTestingModule({
      imports: [ProviderAccountReadinessModule],
    })
      .overrideProvider(PrismaService)
      .useValue(prisma)
      .compile();

    try {
      const publisherSync = moduleRef.get(PublisherSyncService);
      const revisionSource = moduleRef.get(PublisherClient) as unknown as {
        revision(): number;
        request?: unknown;
      };
      const first = await publisherSync.buildRuntimeIntent();
      const second = await publisherSync.buildRuntimeIntent();
      const firstRevision = first.product_policy_deletes?.[0]?.revision;
      const secondRevision = second.product_policy_deletes?.[0]?.revision;

      expect(firstRevision).toEqual(expect.any(Number));
      expect(secondRevision).toBeGreaterThan(firstRevision as number);
      expect(revisionSource.request).toBeUndefined();
    } finally {
      await moduleRef.close();
    }
  });
});

function restoreEnv(key: string, value: string | undefined): void {
  if (value === undefined) delete process.env[key];
  else process.env[key] = value;
}
