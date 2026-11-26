jest.mock('../alert-events/alert-events.module', () => ({
  AlertEventsModule: class AlertEventsModule {},
}));
jest.mock('../publisher/publisher.module', () => ({
  PublisherModule: class PublisherModule {},
}));

import { Test } from '@nestjs/testing';
import { MODULE_METADATA } from '@nestjs/common/constants';
import { ConfigModule, ConfigService } from '@nestjs/config';
import { JwtModule } from '@nestjs/jwt';
import { AdminJwtAuthGuard } from '../common/guards/admin-jwt-auth.guard';
import { AdminPermissionGuard } from '../common/guards/admin-permission.guard';
import { PrismaModule } from '../prisma/prisma.module';
import { PrismaService } from '../prisma/prisma.service';
import { RedisModule } from '../redis/redis.module';
import { RedisService } from '../redis/redis.service';
import { ProductSyncNotifier } from '../integration/product-sync-notifier';
import { PublisherSyncService } from '../publisher/publisher-sync.service';
import { ChannelController } from './channel.controller';
import { ChannelModule } from './channel.module';
import { ChannelRepository } from './channel.repository';
import { ChannelService } from './channel.service';
import { ProviderAccountIdentityService } from '../provider-account-identity/provider-account-identity.service';

function dynamicModuleUses(entry: unknown, moduleRef: unknown): boolean {
  if (typeof entry !== 'object' || entry === null || !('module' in entry)) return false;
  return (entry as { module?: unknown }).module === moduleRef;
}

describe('ChannelModule admin guard wiring', () => {
  it('registers the JWT module and admin guards required by ChannelController', () => {
    const imports = Reflect.getMetadata(MODULE_METADATA.IMPORTS, ChannelModule) as unknown[];
    const providers = Reflect.getMetadata(MODULE_METADATA.PROVIDERS, ChannelModule) as unknown[];

    expect(
      imports.some((entry) => dynamicModuleUses(entry, JwtModule)),
    ).toBe(true);
    expect(providers).toEqual(expect.arrayContaining([AdminJwtAuthGuard, AdminPermissionGuard]));
  });

  it('compiles ChannelController with the admin guards and their dependencies', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [JwtModule.register({ secret: 'test-secret' })],
      controllers: [ChannelController],
      providers: [
        ChannelService,
        ChannelRepository,
        AdminJwtAuthGuard,
        AdminPermissionGuard,
        { provide: PrismaService, useValue: {} },
        { provide: RedisService, useValue: {} },
        { provide: ProductSyncNotifier, useValue: { notifyAllProductSaas: jest.fn() } },
        { provide: PublisherSyncService, useValue: { syncOpsTopology: jest.fn() } },
        { provide: ProviderAccountIdentityService, useValue: { requireActiveForProvider: jest.fn() } },
        { provide: ConfigService, useValue: { get: jest.fn().mockReturnValue('') } },
      ],
    }).compile();

    expect(moduleRef.get(ChannelController)).toBeInstanceOf(ChannelController);
  });

  it('compiles the real ChannelModule with guard DI dependencies wired', async () => {
    const moduleRef = await Test.createTestingModule({
      imports: [
        ConfigModule.forRoot({ ignoreEnvFile: true }),
        PrismaModule,
        RedisModule,
        ChannelModule,
      ],
    })
      .overrideProvider(ConfigService)
      .useValue({
        getOrThrow: jest.fn((key: string) => {
          if (key === 'JWT_SECRET') return 'test-secret';
          throw new Error(`missing config ${key}`);
        }),
        get: jest.fn().mockReturnValue(''),
      })
      .overrideProvider(PrismaService)
      .useValue({})
      .overrideProvider(RedisService)
      .useValue({
        get: jest.fn(),
        set: jest.fn(),
      })
      .compile();

    expect(moduleRef.get(ChannelController)).toBeInstanceOf(ChannelController);
    expect(moduleRef.get(AdminJwtAuthGuard)).toBeInstanceOf(AdminJwtAuthGuard);
    expect(moduleRef.get(AdminPermissionGuard)).toBeInstanceOf(AdminPermissionGuard);

    await moduleRef.close();
  });
});
