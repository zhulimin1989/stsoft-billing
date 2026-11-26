import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { FunnelController } from './funnel.controller';
import { FunnelService } from './funnel.service';

/**
 * FunnelModule — admin v2 业务漏斗(/admin/v2/funnel*)。
 *
 * - PrismaModule / RedisModule 是全局注册的 (@Global),无需在此 import。
 * - 纯只读聚合 + 30s Redis 短缓存,不引入新表 / 新写入路径。
 * - 路由权限 admin.monitoring.view,与现有 monitoring 权限对齐。
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
  controllers: [FunnelController],
  providers: [FunnelService, AdminJwtAuthGuard, AdminPermissionGuard],
})
export class FunnelModule {}
