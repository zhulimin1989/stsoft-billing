import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { buildBullConnection } from '../integration/queue/queue.config';
import { PublisherModule } from '../publisher/publisher.module';
import {
  SEGMENT_REFRESH_QUEUE,
  SegmentRefreshProcessor,
} from './jobs/segment-refresh.job';
import { UserSegmentsController } from './user-segments.controller';
import { UserSegmentsService } from './user-segments.service';

@Module({
  imports: [
    // BullModule.forRootAsync is already registered by IntegrationModule, but
    // BullMQ allows multiple `forRootAsync` calls (idempotent in practice) and
    // we explicitly need the connection wired regardless of import order.
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: buildBullConnection(config),
      }),
    }),
    BullModule.registerQueue({ name: SEGMENT_REFRESH_QUEUE }),
    PublisherModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: '15m' },
      }),
    }),
  ],
  controllers: [UserSegmentsController],
  providers: [
    UserSegmentsService,
    SegmentRefreshProcessor,
    AdminJwtAuthGuard,
    AdminPermissionGuard,
  ],
  exports: [UserSegmentsService],
})
export class UserSegmentsModule {}
