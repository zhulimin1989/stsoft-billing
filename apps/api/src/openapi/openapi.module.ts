import { Module } from '@nestjs/common';
import { ConfigModule } from '@nestjs/config';
import { APP_FILTER } from '@nestjs/core';
import { LoggerModule } from 'nestjs-pino';
import { AlertEventService } from '../alert-events/alert-events.service';
import { HttpExceptionFilter } from '../common/filters/http-exception.filter';
import { createLoggerConfig } from '../common/logger/logger.config';
import { HealthController } from '../health.controller';
import { PrismaModule } from '../prisma/prisma.module';
import { RedisModule } from '../redis/redis.module';
import { PartnerApiAuthGuard } from './partner-api-auth.guard';
import { PartnerApiController } from './partner-api.controller';
import { PartnerApiResponseContractInterceptor } from './partner-api-response-contract.interceptor';
import { OpenApiProviderModule } from './openapi-provider.module';

@Module({
  imports: [
    ConfigModule.forRoot({
      isGlobal: true,
      envFilePath: ['.env', '../../../.env', '/app/.env'],
    }),
    LoggerModule.forRoot(createLoggerConfig()),
    PrismaModule,
    RedisModule,
    OpenApiProviderModule,
  ],
  controllers: [PartnerApiController, HealthController],
  providers: [
    PartnerApiAuthGuard,
    PartnerApiResponseContractInterceptor,
    AlertEventService,
    {
      provide: APP_FILTER,
      useClass: HttpExceptionFilter,
    },
  ],
})
export class OpenApiModule {}
