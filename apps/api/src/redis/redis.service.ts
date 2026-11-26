import { Injectable, OnModuleDestroy } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import Redis from 'ioredis';

@Injectable()
export class RedisService extends Redis implements OnModuleDestroy {
  constructor(config: ConfigService) {
    super({
      host: config.get('REDIS_HOST', 'localhost'),
      port: config.get('REDIS_PORT', 6379),
      password: config.get('REDIS_PASSWORD'),
      // AWS ElastiCache Valkey transit_encryption=true 强制 TLS;非生产/无 TLS 时跳过
      tls: config.get<string>('REDIS_TLS') === 'true' ? {} : undefined,
    });
  }

  async onModuleDestroy() {
    await this.quit();
  }
}
