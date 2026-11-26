import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { QuotaTemplatesController } from './quota-templates.controller';
import { QuotaTemplatesService } from './quota-templates.service';

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
  controllers: [QuotaTemplatesController],
  providers: [QuotaTemplatesService, AdminJwtAuthGuard, AdminPermissionGuard],
  exports: [QuotaTemplatesService],
})
export class QuotaTemplatesModule {}
