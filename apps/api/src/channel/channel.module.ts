import { Module } from '@nestjs/common';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AlertEventsModule } from '../alert-events/alert-events.module';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { ChannelController } from './channel.controller';
import { ChannelService } from './channel.service';
import { ChannelRepository } from './channel.repository';
import { PublisherModule } from '../publisher/publisher.module';
import { ProductConfigSyncModule } from '../integration/product-config-sync/product-config-sync.module';
import { noopProductSyncNotifierProvider } from '../integration/product-sync-noop.provider';
import { ProviderAccountIdentityModule } from '../provider-account-identity/provider-account-identity.module';

@Module({
  imports: [
    ConfigModule,
    AlertEventsModule,
    PublisherModule,
    ProductConfigSyncModule,
    ProviderAccountIdentityModule,
    JwtModule.registerAsync({
      imports: [ConfigModule],
      inject: [ConfigService],
      useFactory: (config: ConfigService) => ({
        secret: config.getOrThrow<string>('JWT_SECRET'),
        signOptions: { expiresIn: '15m' },
      }),
    }),
  ],
  controllers: [ChannelController],
  providers: [
    ChannelService,
    ChannelRepository,
    AdminJwtAuthGuard,
    AdminPermissionGuard,
    noopProductSyncNotifierProvider,
  ],
  exports: [ChannelService],
})
export class ChannelModule {}
