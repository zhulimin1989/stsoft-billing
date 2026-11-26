import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { WEBHOOK_QUEUE } from './webhook/webhook.queue';
import { WebhookService } from './webhook/webhook.service';
import { WebhookProcessor } from './webhook/webhook.processor';
import { buildBullConnection } from './queue/queue.config';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: buildBullConnection(config),
      }),
    }),
    BullModule.registerQueue({ name: WEBHOOK_QUEUE }),
  ],
  providers: [WebhookService, WebhookProcessor],
  exports: [WebhookService],
})
export class IntegrationModule {}
