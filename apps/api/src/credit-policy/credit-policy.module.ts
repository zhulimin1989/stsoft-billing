import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { CreditPolicyController } from './credit-policy.controller';
import { CreditPolicyService } from './credit-policy.service';

/**
 * CreditPolicyModule — admin v2 信用额度策略(/admin/v2/credit-policy)。
 *
 * - PrismaModule / RedisModule 是全局注册的 (@Global),无需在此 import。
 * - CreditPolicyService 通过 exports 暴露给 BillingModule(deduct hook)。
 * - JwtModule 与既有 admin v2 module 一致(支持 AdminJwtAuthGuard 解析 token)。
 *
 * 详见 docs/superpowers/specs/2026-04-30-admin-v2-backend-p2-credit-policy-design.md
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
  controllers: [CreditPolicyController],
  providers: [CreditPolicyService, AdminJwtAuthGuard, AdminPermissionGuard],
  exports: [CreditPolicyService],
})
export class CreditPolicyModule {}
