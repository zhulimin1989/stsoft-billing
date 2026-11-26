import { Module } from '@nestjs/common';
import { JwtModule } from '@nestjs/jwt';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { CampaignServiceModule } from './campaign-service.module';
import { CampaignController } from './campaign.controller';
import { DiscountCodeService } from './discount-code.service';
import { DiscountCodeRepository } from './discount-code.repository';
import { DiscountCodeController } from './discount-code.controller';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';

@Module({
  imports: [
    CampaignServiceModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: '15m' },
      }),
    }),
  ],
  controllers: [CampaignController, DiscountCodeController],
  providers: [
    DiscountCodeService,
    DiscountCodeRepository,
    AdminJwtAuthGuard,
    AdminPermissionGuard,
  ],
  // CampaignService/StripeCouponSyncService 现由 CampaignServiceModule 提供，
  // re-export 整个 provider-only 模块（而非裸 token），外部 import CampaignModule
  // 仍可注入 CampaignService（如 payment.module 结账侧），且避免 UnknownExportException。
  exports: [CampaignServiceModule, DiscountCodeService],
})
export class CampaignModule {}
