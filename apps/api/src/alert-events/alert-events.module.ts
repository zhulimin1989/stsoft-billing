import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { AlertEventsController } from './alert-events.controller';
import { AlertEventService } from './alert-events.service';
import { UsageThresholdService } from './usage-threshold.service';

/**
 * AlertEventsModule — admin v2 事件流(/admin/v2/alerts)。
 *
 * - PrismaModule 是全局注册的 (@Global),无需在此 import。
 * - AlertEventService 通过 exports 暴露给后续 P2-A2 / A3 的事件源接入
 *   (RiskEngine、PaymentService、ChannelService、CreditService...)调用。
 * - UsageThresholdService(P2-A3 §8.1)放在本模块下,因为它是 alert 的一类事件源
 *   —— 检查 CreditTransaction 然后调 AlertEventService 写告警,与 alerts 强耦合。
 *   通过 exports 暴露给 BillingModule 的 CreditService 调用。
 */
@Module({
  imports: [
    ConfigModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: '15m' },
      }),
    }),
  ],
  controllers: [AlertEventsController],
  providers: [
    AlertEventService,
    UsageThresholdService,
    AdminJwtAuthGuard,
    AdminPermissionGuard,
  ],
  exports: [AlertEventService, UsageThresholdService],
})
export class AlertEventsModule {}
