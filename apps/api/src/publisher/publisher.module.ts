import { Global, Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PublisherClient } from './publisher.client';
import { PublisherSyncJobService } from './publisher-sync-job.service';
import { PublisherSyncService } from './publisher-sync.service';
import { PublisherSyncWorkerService } from './publisher-sync-worker.service';
import { PublisherQueueJanitorService } from './publisher-queue-janitor.service';
import { PublisherKeyBalanceBootstrapService } from './publisher-key-balance-bootstrap.service';
import { RollingQuotaGateService } from './rolling-quota-gate.service';
import { RollingQuotaGateSchedulerService } from './rolling-quota-gate-scheduler.service';

@Global()
@Module({
  imports: [ConfigModule],
  providers: [
    PublisherClient,
    PublisherSyncJobService,
    RollingQuotaGateService,
    PublisherSyncService,
    PublisherSyncWorkerService,
    PublisherQueueJanitorService,
    PublisherKeyBalanceBootstrapService,
    RollingQuotaGateSchedulerService,
  ],
  exports: [PublisherClient, PublisherSyncJobService, PublisherSyncService, RollingQuotaGateService],
})
export class PublisherModule {}
