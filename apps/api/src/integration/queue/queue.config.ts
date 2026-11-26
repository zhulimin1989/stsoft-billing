import { ConfigService } from '@nestjs/config';

export function buildBullConnection(config: ConfigService) {
  return {
    host: config.get<string>('REDIS_HOST', 'localhost'),
    port: config.get<number>('REDIS_PORT', 6379),
    password: config.get<string>('REDIS_PASSWORD') || undefined,
    db: config.get<number>('REDIS_DB', 0),
    // AWS ElastiCache Valkey transit_encryption=true 强制 TLS
    tls: config.get<string>('REDIS_TLS') === 'true' ? {} : undefined,
  };
}
