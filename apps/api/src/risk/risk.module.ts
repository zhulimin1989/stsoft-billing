import { Module } from '@nestjs/common';
import { BullModule } from '@nestjs/bullmq';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { AlertEventsModule } from '../alert-events/alert-events.module';
import { buildBullConnection } from '../integration/queue/queue.config';
import { RiskEngineService } from './risk-engine.service';
import { RiskFlagsController } from './risk-flags.controller';
import { RiskFlagsService } from './risk-flags.service';
import { RiskRulesController } from './risk-rules.controller';
import { RiskRulesService } from './risk-rules.service';
import { RISK_ENGINE_QUEUE, RiskEngineProcessor } from './jobs/risk-engine.job';

@Module({
  imports: [
    AlertEventsModule,
    BullModule.forRootAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        connection: buildBullConnection(config),
      }),
    }),
    BullModule.registerQueue({ name: RISK_ENGINE_QUEUE }),
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: '15m' },
      }),
    }),
  ],
  controllers: [RiskRulesController, RiskFlagsController],
  providers: [
    RiskRulesService,
    RiskFlagsService,
    RiskEngineService,
    RiskEngineProcessor,
    AdminJwtAuthGuard,
    AdminPermissionGuard,
  ],
  exports: [RiskRulesService, RiskFlagsService, RiskEngineService],
})
export class RiskModule {}
