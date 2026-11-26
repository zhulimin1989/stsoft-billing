import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { PublicRechargeTiersController } from './recharge-tiers.public.controller';
import { RechargeTiersController } from './recharge-tiers.controller';
import { RechargeTiersService } from './recharge-tiers.service';

@Module({
  imports: [
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: '15m' },
      }),
    }),
  ],
  controllers: [RechargeTiersController, PublicRechargeTiersController],
  providers: [RechargeTiersService, AdminJwtAuthGuard, AdminPermissionGuard],
  exports: [RechargeTiersService],
})
export class RechargeTiersModule {}
