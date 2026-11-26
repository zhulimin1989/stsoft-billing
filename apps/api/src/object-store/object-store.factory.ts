import { Injectable } from '@nestjs/common';
import { createHash } from 'crypto';
import { AliyunOssObjectStoreClient } from './aliyun-oss-object-store.client';
import type { ObjectStoreClient, ObjectStoreConfig } from './object-store.types';
import { S3ObjectStoreClient } from './s3-object-store.client';

@Injectable()
export class ObjectStoreFactory {
  private readonly clients = new Map<string, ObjectStoreClient>();

  create(config: ObjectStoreConfig): ObjectStoreClient {
    const cacheKey = this.cacheKey(config);
    const cached = this.clients.get(cacheKey);
    if (cached) return cached;

    const client =
      config.provider === 'aliyun_oss'
        ? new AliyunOssObjectStoreClient(config)
        : new S3ObjectStoreClient(config);
    this.clients.set(cacheKey, client);
    return client;
  }

  private cacheKey(config: ObjectStoreConfig): string {
    return [
      config.provider,
      config.bucket,
      config.region,
      config.endpoint ?? '',
      config.publicEndpoint ?? '',
      config.keyPrefix ?? '',
      config.credentials?.accessKeyId ?? '',
      config.credentials?.secretAccessKey
        ? createHash('sha256').update(config.credentials.secretAccessKey).digest('hex')
        : '',
      config.forcePathStyle === undefined ? '' : String(config.forcePathStyle),
    ].join('|');
  }
}
