import {
  BadRequestException,
  InternalServerErrorException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SystemConfigService } from '../../billing/system-config.service';
import { ObjectStoreFactory } from '../../object-store/object-store.factory';
import type { ObjectStoreClient, ObjectStoreConfig } from '../../object-store/object-store.types';
import { InvoiceStorageService } from '../invoice-storage.service';

function storageWithConfig(
  env: Record<string, string | undefined>,
  storageConfig?: Record<string, unknown>,
) {
  const config = {
    get: jest.fn((key: string) => env[key]),
  } as unknown as ConfigService;
  const systemConfig = {
    getFresh: jest.fn(async (key: string, defaultValue?: unknown) =>
      key === 'storageConfig' ? (storageConfig ?? defaultValue) : defaultValue,
    ),
  } as unknown as SystemConfigService;
  const store: ObjectStoreClient = {
    provider: 's3',
    putObject: jest.fn(async () => undefined),
    deleteObject: jest.fn(async () => undefined),
    readObject: jest.fn(async () => Buffer.from('%PDF-test')),
    getDownloadUrl: jest.fn(async (key: string) => `https://signed.test/${key}`),
  };
  const storeFactory = {
    create: jest.fn((_config: ObjectStoreConfig) => store),
  };
  return {
    storage: new InvoiceStorageService(config, systemConfig, storeFactory as unknown as ObjectStoreFactory),
    store,
    storeFactory,
  };
}

describe('InvoiceStorageService', () => {
  it('对象存储未配置时上传直接失败，不回退服务器本地目录', async () => {
    const { storage, storeFactory } = storageWithConfig({});

    await expect(
      storage.persist({
        userId: 'u1',
        invoiceNumber: 'CN-202606-001',
        applicationId: 'app-1',
        buffer: Buffer.from('%PDF-test'),
      }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(storeFactory.create).not.toHaveBeenCalled();
  });

  it('旧本地存储指针不再支持下载，提示重新上传到对象存储', async () => {
    const { storage } = storageWithConfig({
      INVOICE_S3_BUCKET: 'invoices',
      INVOICE_S3_REGION: 'ap-east-1',
    });

    await expect(
      storage.resolveForDownload('/storage/invoices/app-1.pdf'),
    ).rejects.toBeInstanceOf(BadRequestException);
    await expect(
      storage.readToBuffer('/storage/invoices/app-1.pdf'),
    ).rejects.toBeInstanceOf(BadRequestException);
  });

  it('管理端 storageConfig 覆盖运行时参数，bucket/region 仍读取部署 env', async () => {
    const { storage, store, storeFactory } = storageWithConfig(
      {
        INVOICE_S3_BUCKET: 'env-bucket',
        INVOICE_S3_REGION: 'env-region',
      },
      {
        provider: 's3',
        bucket: 'admin-bucket',
        region: 'ap-east-1',
        s3Endpoint: 'https://s3.admin.test',
        s3Prefix: 'billing-test',
      },
    );

    const key = await storage.persist({
      userId: 'u/1',
      invoiceNumber: 'CN-202606-001',
      applicationId: 'app-1',
      buffer: Buffer.from('%PDF-test'),
    });

    expect(key).toBe('billing-test/invoices/u_1/CN-202606-001.pdf');
    expect(storeFactory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 's3',
        bucket: 'env-bucket',
        region: 'env-region',
        endpoint: 'https://s3.admin.test',
        keyPrefix: 'billing-test',
      }),
    );
    expect(store.putObject).toHaveBeenCalledWith(
      expect.objectContaining({
        key,
        body: Buffer.from('%PDF-test'),
        contentType: 'application/pdf',
        filename: 'CN-202606-001.pdf',
      }),
    );
  });

  it('管理端未下发 storageConfig 时回退 env 配置', async () => {
    const { storage, storeFactory } = storageWithConfig({
      INVOICE_S3_BUCKET: 'env-bucket',
      INVOICE_S3_REGION: 'ap-east-1',
      INVOICE_S3_PREFIX: 'env-prefix',
    });

    const key = await storage.persist({
      userId: 'u1',
      invoiceNumber: 'CN-202606-002',
      applicationId: 'app-2',
      buffer: Buffer.from('%PDF-test'),
    });

    expect(key).toBe('env-prefix/invoices/u1/CN-202606-002.pdf');
    expect(storeFactory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 's3',
        bucket: 'env-bucket',
        region: 'ap-east-1',
        keyPrefix: 'env-prefix',
      }),
    );
  });

  it('下载时按对象存储 provider 生成 presigned URL', async () => {
    const { storage, store } = storageWithConfig(
      {
        INVOICE_S3_BUCKET: 'env-bucket',
        INVOICE_S3_REGION: 'ap-east-1',
      },
      { provider: 's3', bucket: 'admin-bucket', region: 'ap-east-1' },
    );

    await expect(storage.resolveForDownload('invoices/u1/a.pdf')).resolves.toEqual({
      kind: 's3',
      url: 'https://signed.test/invoices/u1/a.pdf',
    });
    expect(store.getDownloadUrl).toHaveBeenCalledWith('invoices/u1/a.pdf', 300);
  });

  it('provider=aliyun_oss 时通过 storeFactory 构建 OSS client', async () => {
    const { storage, storeFactory } = storageWithConfig(
      {
        INVOICE_OSS_BUCKET: 'env-oss-bucket',
        INVOICE_OSS_REGION: 'cn-shanghai',
      },
      {
        provider: 'aliyun_oss',
        bucket: 'oss-bucket',
        region: 'cn-hangzhou',
        ossEndpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
        accessKeyId: 'ak',
        accessKeySecret: 'sk',
      },
    );

    const key = await storage.persist({
      userId: 'u1',
      invoiceNumber: 'CN-202606-003',
      applicationId: 'app-3',
      buffer: Buffer.from('%PDF-test'),
    });

    expect(key).toBe('invoices/u1/CN-202606-003.pdf');
    expect(storeFactory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'aliyun_oss',
        bucket: 'env-oss-bucket',
        region: 'cn-shanghai',
        endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
        credentials: { accessKeyId: 'ak', secretAccessKey: 'sk' },
      }),
    );
  });

  it('OSS 内网 endpoint 下载时自动推导公网 publicEndpoint（浏览器可达）', async () => {
    const { storage, storeFactory } = storageWithConfig(
      {
        INVOICE_OSS_BUCKET: 'raytone-prod-aliyun-bj-invoice',
        INVOICE_OSS_REGION: 'cn-beijing',
      },
      {
        provider: 'aliyun_oss',
        bucket: 'raytone-prod-aliyun-bj-invoice',
        region: 'cn-beijing',
        ossEndpoint: 'https://oss-cn-beijing-internal.aliyuncs.com',
        accessKeyId: 'ak',
        accessKeySecret: 'sk',
      },
    );

    await storage.resolveForDownload('invoices/u1/manual-a.pdf');

    expect(storeFactory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        provider: 'aliyun_oss',
        endpoint: 'https://oss-cn-beijing-internal.aliyuncs.com',
        publicEndpoint: 'https://oss-cn-beijing.aliyuncs.com',
      }),
    );
  });

  it('显式配置的 ossPublicEndpoint 优先于内网 endpoint 推导', async () => {
    const { storage, storeFactory } = storageWithConfig(
      {
        INVOICE_OSS_BUCKET: 'oss-bucket',
        INVOICE_OSS_REGION: 'cn-beijing',
      },
      {
        provider: 'aliyun_oss',
        bucket: 'oss-bucket',
        region: 'cn-beijing',
        ossEndpoint: 'https://oss-cn-beijing-internal.aliyuncs.com',
        ossPublicEndpoint: 'https://files.raytone.example.com',
        accessKeyId: 'ak',
        accessKeySecret: 'sk',
      },
    );

    await storage.resolveForDownload('invoices/u1/manual-a.pdf');

    expect(storeFactory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'https://oss-cn-beijing-internal.aliyuncs.com',
        publicEndpoint: 'https://files.raytone.example.com',
      }),
    );
  });

  it('endpoint 已是公网时不推导 publicEndpoint（沿用 endpoint）', async () => {
    const { storage, storeFactory } = storageWithConfig(
      {
        INVOICE_OSS_BUCKET: 'oss-bucket',
        INVOICE_OSS_REGION: 'cn-hangzhou',
      },
      {
        provider: 'aliyun_oss',
        bucket: 'oss-bucket',
        region: 'cn-hangzhou',
        ossEndpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
        accessKeyId: 'ak',
        accessKeySecret: 'sk',
      },
    );

    await storage.resolveForDownload('invoices/u1/manual-a.pdf');

    expect(storeFactory.create).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
        publicEndpoint: undefined,
      }),
    );
  });

  it('provider=aliyun_oss 缺少凭据时 fail-fast，不等 OSS client 初始化才失败', async () => {
    const { storage, storeFactory } = storageWithConfig(
      {
        INVOICE_OSS_BUCKET: 'oss-bucket',
        INVOICE_OSS_REGION: 'cn-hangzhou',
      },
      {
        provider: 'aliyun_oss',
        bucket: 'oss-bucket',
        region: 'cn-hangzhou',
      },
    );

    await expect(
      storage.persist({
        userId: 'u1',
        invoiceNumber: 'CN-202606-004',
        applicationId: 'app-4',
        buffer: Buffer.from('%PDF-test'),
      }),
    ).rejects.toBeInstanceOf(InternalServerErrorException);
    expect(storeFactory.create).not.toHaveBeenCalled();
  });

  it('非法对象存储 provider 直接报配置错误', async () => {
    const { storage, storeFactory } = storageWithConfig(
      {},
      {
        provider: 'minio',
        bucket: 'oss-bucket',
        region: 'cn-hangzhou',
      },
    );

    await expect(storage.resolveForDownload('invoices/u1/a.pdf'))
      .rejects.toBeInstanceOf(InternalServerErrorException);
    expect(storeFactory.create).not.toHaveBeenCalled();
  });

  it('兼容无 provider 的旧 OSS 配置：有 ossEndpoint 时推断为 aliyun_oss', async () => {
    const { storage, storeFactory } = storageWithConfig(
      {
        INVOICE_OSS_BUCKET: 'oss-bucket',
        INVOICE_OSS_REGION: 'cn-hangzhou',
      },
      {
        bucket: 'oss-bucket',
        region: 'cn-hangzhou',
        ossEndpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
        accessKeyId: 'ak',
        accessKeySecret: 'sk',
      },
    );

    await storage.resolveForDownload('invoices/u1/a.pdf');

    expect(storeFactory.create).toHaveBeenCalledWith(
      expect.objectContaining({ provider: 'aliyun_oss' }),
    );
  });

  it('persists overseas psa xlsx objects with spreadsheet content type', async () => {
    const { storage, store } = storageWithConfig({
      INVOICE_S3_BUCKET: 'env-bucket',
      INVOICE_S3_REGION: 'ap-east-1',
    });

    const key = await storage.persist({
      userId: 'u1',
      invoiceNumber: 'IA-20260920-001',
      applicationId: 'app-xlsx',
      buffer: Buffer.from('xlsx-bytes'),
      extension: 'xlsx',
      keyHint: 'IA-20260920-001-psa',
    });

    expect(key).toBe('invoices/u1/IA-20260920-001-psa.xlsx');
    expect(store.putObject).toHaveBeenCalledWith(expect.objectContaining({
      key,
      contentType: 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
      filename: 'IA-20260920-001.xlsx',
    }));
  });
});
