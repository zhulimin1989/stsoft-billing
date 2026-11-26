/**
 * ReferralsModule — admin v2 邀请裂变 (/admin/v2/referrals + /api/user/referral-code)。
 *
 * - PrismaModule / RedisModule 是全局注册的 (@Global),无需在此 import。
 * - CreditGrantsModule 提供 CreditGrantExecutor (用于发奖)。
 * - ReferralsService 通过 exports 暴露给 AuthService(register hook) +
 *   PaymentService(fulfillOrder hook),都用 @Optional() 注入,不破坏现有测试。
 * - JwtModule 与既有 admin v2 module 一致(支持 AdminJwtAuthGuard 解析 token)。
 *
 * 详见 docs/superpowers/specs/2026-04-30-admin-v2-backend-p2-referrals-design.md
 */
import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { CreditGrantsModule } from '../credit-grants/credit-grants.module';
import { ReferralsController } from './referrals.controller';
import { ReferralsService } from './referrals.service';
import { ReferralsUserController } from './referrals.user.controller';

@Module({
  imports: [
    ConfigModule,
    CreditGrantsModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: '15m' },
      }),
    }),
  ],
  controllers: [ReferralsController, ReferralsUserController],
  providers: [ReferralsService, AdminJwtAuthGuard, AdminPermissionGuard],
  exports: [ReferralsService],
})
export class ReferralsModule {}
