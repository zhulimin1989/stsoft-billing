import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { buildBullConnection } from '../integration/queue/queue.config';
import { TicketsService } from './tickets.service';
import { TicketsController } from './tickets.controller';
import { TicketsUserController } from './tickets-user.controller';
import { TICKET_SLA_QUEUE, TicketSlaProcessor } from './jobs/ticket-sla.job';

@Module({
  imports: [
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: buildBullConnection(config),
      }),
    }),
    BullModule.registerQueue({ name: TICKET_SLA_QUEUE }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: '15m' },
      }),
    }),
  ],
  controllers: [TicketsController, TicketsUserController],
  providers: [
    TicketsService,
    TicketSlaProcessor,
    AdminJwtAuthGuard,
    AdminPermissionGuard,
  ],
  exports: [TicketsService],
})
export class TicketsModule {}
