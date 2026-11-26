import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisService } from '../redis/redis.service';
import { PublisherClient } from '../publisher/publisher.client';
import { PublisherSyncJobService } from '../publisher/publisher-sync-job.service';
import { PublisherSyncService } from '../publisher/publisher-sync.service';
import { RollingQuotaGateService } from '../publisher/rolling-quota-gate.service';

const FORBIDDEN_READINESS_DEPENDENCY = Object.freeze({});

/**
 * RuntimeIntent product-policy revisions are local values, so the read-only
 * composition can provide them without constructing a network-capable client.
 * No request/dispatch method is present on this object by design.
 */
export class ReadOnlyPublisherRevisionSource {
  private lastRevisionMicros = 0;

  revision(): number {
    const now = Date.now() * 1000;
    this.lastRevisionMicros = Math.max(now, this.lastRevisionMicros + 1);
    return this.lastRevisionMicros;
  }
}

/**
 * Deliberately minimal composition for the read-only readiness command.
 * PublisherSyncService is reused as the production RuntimeIntent builder, but
 * every network, queue and Redis collaborator is a fail-closed guard object.
 */
@Module({
  imports: [
    ConfigModule.forRoot({ isGlobal: true }),
    PrismaModule,
  ],
  providers: [
    PublisherSyncService,
    {
      provide: PublisherClient,
      useClass: ReadOnlyPublisherRevisionSource,
    },
    {
      provide: PublisherSyncJobService,
      useValue: FORBIDDEN_READINESS_DEPENDENCY,
    },
    {
      provide: RollingQuotaGateService,
      useValue: FORBIDDEN_READINESS_DEPENDENCY,
    },
    {
      provide: RedisService,
      useValue: FORBIDDEN_READINESS_DEPENDENCY,
    },
  ],
})
export class ProviderAccountReadinessModule {}
