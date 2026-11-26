import {
  BadRequestException,
  Injectable,
  InternalServerErrorException,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { SystemConfigService } from '../billing/system-config.service';
import { ObjectStoreFactory } from '../object-store/object-store.factory';
import type {
  ObjectStoreConfig,
  ObjectStoreProvider,
} from '../object-store/object-store.types';

/**
 * 发票文件持久化统一走对象存储。DB pdfUrl / ofdUrl 存 object key：
 *   [prefix/]invoices/<userId>/<file>.pdf
 *
 * 对象存储 bucket / region 属于部署级参数，只从 env/ConfigMap 读取；
 * 管理端 storageConfig 仅覆盖 provider、endpoint、prefix、凭证等运行时参数。
 * 未配置对象存储时直接失败，避免测试/生产环境落到服务器本地后生成不可访问的 /storage 路径。
 * 前端通过 /billing/invoices/:id/pdf 获取限时 presigned URL。
 * 手工上传可传 keyHint，为同一申请多次上传生成不覆盖的对象名。
 */

export interface PersistInput {
  userId: string;
  invoiceNumber: string;
  applicationId: string;
  buffer: Buffer;
  extension?: 'pdf' | 'ofd' | 'xlsx';
  contentType?: string;
  keyHint?: string;
}

export interface ResolvedDownload {
  kind: ObjectStoreProvider;
  /** 浏览器可直接打开的对象存储 presigned URL（限时） */
  url: string;
}

const LOCAL_PREFIX = '/storage/invoices/';

@Injectable()
export class InvoiceStorageService {
  private readonly logger = new Logger(InvoiceStorageService.name);

  constructor(
    private readonly config: ConfigService,
    private readonly systemConfig: SystemConfigService,
    private readonly storeFactory: ObjectStoreFactory,
  ) {}

  /** 对象存储 key：[prefix/]invoices/<userId>/<name>.<ext> */
  private objectKey(
    storageConfig: ObjectStoreConfig,
    userId: string,
    name: string,
    extension = 'pdf',
  ): string {
    const safeUser = sanitizeSegment(userId);
    const safeName = sanitizeSegment(name);
    const safeExtension = sanitizeExtension(extension);
    const base = `invoices/${safeUser}/${safeName}.${safeExtension}`;
    return storageConfig.keyPrefix
      ? `${storageConfig.keyPrefix.replace(/\/+$/, '')}/${base}`
      : base;
  }

  private async resolveObjectStoreConfig(): Promise<ObjectStoreConfig> {
    const adminConfig = await this.loadStorageConfig();
    const provider = this.resolveProvider(adminConfig);
    const bucket =
      (provider === 'aliyun_oss'
        ? this.firstEnv('INVOICE_OSS_BUCKET', 'ALIYUN_OSS_BUCKET', 'INVOICE_S3_BUCKET')
        : this.firstEnv('INVOICE_S3_BUCKET', 'AWS_S3_BUCKET'));
    const region =
      (provider === 'aliyun_oss'
        ? this.firstEnv('INVOICE_OSS_REGION', 'ALIYUN_OSS_REGION', 'INVOICE_S3_REGION')
        : this.firstEnv('INVOICE_S3_REGION', 'AWS_REGION'));
    const endpoint = this.resolveEndpoint(adminConfig, provider);
    const publicEndpoint = this.resolvePublicEndpoint(adminConfig, provider, endpoint);
    const keyPrefix =
      firstString(adminConfig, ['invoiceS3Prefix', 's3Prefix', 'prefix']) ||
      (provider === 'aliyun_oss'
        ? this.firstEnv('INVOICE_OSS_PREFIX', 'ALIYUN_OSS_PREFIX', 'INVOICE_S3_PREFIX')
        : this.firstEnv('INVOICE_S3_PREFIX')) ||
      undefined;
    const adminAccessKeyId = firstString(adminConfig, [
      'invoiceS3AccessKeyId',
      's3AccessKeyId',
      'accessKeyId',
      'accessKey',
    ]);
    const adminSecretAccessKey = firstString(adminConfig, [
      'invoiceS3SecretAccessKey',
      's3SecretAccessKey',
      'secretAccessKey',
      'accessKeySecret',
      'secretKey',
    ]);
    const envAccessKeyId =
      provider === 'aliyun_oss'
        ? this.firstEnv('INVOICE_OSS_ACCESS_KEY_ID', 'ALIYUN_OSS_ACCESS_KEY_ID', 'INVOICE_S3_ACCESS_KEY_ID')
        : this.firstEnv('INVOICE_S3_ACCESS_KEY_ID', 'AWS_ACCESS_KEY_ID');
    const envSecretAccessKey = this.firstEnv(
      ...(provider === 'aliyun_oss'
        ? ['INVOICE_OSS_ACCESS_KEY_SECRET', 'ALIYUN_OSS_ACCESS_KEY_SECRET', 'INVOICE_S3_SECRET_ACCESS_KEY']
        : ['INVOICE_S3_SECRET_ACCESS_KEY', 'AWS_SECRET_ACCESS_KEY']),
    );
    const credentials =
      adminAccessKeyId && adminSecretAccessKey
        ? { accessKeyId: adminAccessKeyId, secretAccessKey: adminSecretAccessKey }
        : envAccessKeyId && envSecretAccessKey
          ? { accessKeyId: envAccessKeyId, secretAccessKey: envSecretAccessKey }
          : undefined;
    const forcePathStyle =
      firstBoolean(adminConfig, ['invoiceS3ForcePathStyle', 's3ForcePathStyle', 'forcePathStyle']) ??
      (provider === 's3' && endpoint ? true : undefined);

    if (provider === 'aliyun_oss' && !credentials) {
      throw new InternalServerErrorException({
        code: 'INVOICE_OBJECT_STORE_CREDENTIALS_REQUIRED',
        message: '阿里云 OSS 发票存储必须配置 Access Key ID 和 Access Key Secret',
      });
    }

    if (bucket && region) {
      return {
        provider,
        bucket,
        region,
        endpoint,
        publicEndpoint,
        keyPrefix,
        credentials,
        forcePathStyle,
      };
    }

    throw new InternalServerErrorException({
      code: 'INVOICE_OBJECT_STORE_NOT_CONFIGURED',
      message:
        '发票文件存储未配置对象存储 bucket/region，请检查服务部署 ConfigMap/env 后重试',
    });
  }

  private resolveEndpoint(
    adminConfig: Record<string, unknown>,
    provider: ObjectStoreProvider,
  ): string | undefined {
    if (provider === 'aliyun_oss') {
      return (
        firstString(adminConfig, ['ossEndpoint', 'invoiceOssEndpoint', 'endpoint']) ||
        this.firstEnv('INVOICE_OSS_ENDPOINT', 'ALIYUN_OSS_ENDPOINT', 'INVOICE_S3_ENDPOINT') ||
        undefined
      );
    }
    return (
      firstString(adminConfig, ['invoiceS3Endpoint', 's3Endpoint', 'endpoint']) ||
      this.firstEnv('INVOICE_S3_ENDPOINT', 'AWS_S3_ENDPOINT') ||
      undefined
    );
  }

  /**
   * 浏览器下载用公网 endpoint：优先显式配置，否则从内网 endpoint 去掉 -internal 推导。
   * 仅 aliyun_oss 需要（S3 无内外网之分）。
   */
  private resolvePublicEndpoint(
    adminConfig: Record<string, unknown>,
    provider: ObjectStoreProvider,
    endpoint: string | undefined,
  ): string | undefined {
    if (provider !== 'aliyun_oss') return undefined;
    const explicit =
      firstString(adminConfig, ['ossPublicEndpoint', 'invoiceOssPublicEndpoint']) ||
      this.firstEnv('INVOICE_OSS_PUBLIC_ENDPOINT', 'ALIYUN_OSS_PUBLIC_ENDPOINT') ||
      undefined;
    if (explicit) return explicit;
    return toPublicOssEndpoint(endpoint);
  }

  private resolveProvider(adminConfig: Record<string, unknown>): ObjectStoreProvider {
    const raw =
      firstString(adminConfig, ['provider', 'storageProvider', 'objectStoreProvider']) ||
      this.firstEnv('INVOICE_STORAGE_PROVIDER');
    const normalized = raw.trim().toLowerCase();
    if (normalized === 'aliyun_oss' || normalized === 'aliyun-oss' || normalized === 'oss') {
      return 'aliyun_oss';
    }
    if (normalized === 's3' || normalized === 'aws_s3' || normalized === 'aws-s3') {
      return 's3';
    }
    if (normalized) {
      throw new InternalServerErrorException({
        code: 'INVOICE_OBJECT_STORE_PROVIDER_UNSUPPORTED',
        message: '发票对象存储 provider 必须是 s3 或 aliyun_oss',
      });
    }
    return firstString(adminConfig, ['ossEndpoint']) ? 'aliyun_oss' : 's3';
  }

  private async loadStorageConfig(): Promise<Record<string, unknown>> {
    const raw = await this.systemConfig.getFresh('storageConfig', {});
    return isRecord(raw) ? raw : {};
  }

  private firstEnv(...keys: string[]): string {
    for (const key of keys) {
      const value = this.config.get<string>(key)?.trim();
      if (value) return value;
    }
    return '';
  }

  private assertObjectStorePointer(pointer: string): void {
    if (!pointer.startsWith(LOCAL_PREFIX)) return;
    throw new BadRequestException({
      code: 'INVOICE_LOCAL_STORAGE_UNSUPPORTED',
      message: '发票文件仍指向旧本地存储，请重新上传票据到对象存储后下载',
    });
  }

  /** 持久化发票文件，返回写入 DB 的对象存储 key。 */
  async persist(input: PersistInput): Promise<string> {
    const storageConfig = await this.resolveObjectStoreConfig();
    const extension = input.extension ?? 'pdf';
    const contentType = input.contentType ?? contentTypeForExtension(extension);
    const objectName = input.keyHint ?? input.invoiceNumber;
    const key = this.objectKey(storageConfig, input.userId, objectName, extension);
    const store = this.storeFactory.create(storageConfig);
    await store.putObject({
      key,
      body: input.buffer,
      contentType,
      filename: `${input.invoiceNumber}.${extension}`,
    });
    this.logger.log(
      `invoice ${extension} uploaded to ${storageConfig.provider}://${storageConfig.bucket}/${key}`,
    );
    return key;
  }

  async deleteObject(pointer: string | null | undefined): Promise<void> {
    if (!pointer) return;
    if (pointer.startsWith(LOCAL_PREFIX)) {
      this.logger.warn(`skip legacy local invoice pointer cleanup: ${pointer}`);
      return;
    }
    const storageConfig = await this.resolveObjectStoreConfig();
    const store = this.storeFactory.create(storageConfig);
    await store.deleteObject(pointer);
  }

  /**
   * 读取发票 PDF 原始字节，用于服务端打包 zip。
   */
  async readToBuffer(pdfUrl: string): Promise<Buffer> {
    this.assertObjectStorePointer(pdfUrl);
    const storageConfig = await this.resolveObjectStoreConfig();
    const store = this.storeFactory.create(storageConfig);
    return store.readObject(pdfUrl);
  }

  /**
   * 把 DB.pdfUrl 的对象存储 key 解析成浏览器可直接打开的 presigned URL（限时 5min）。
   */
  async resolveForDownload(pdfUrl: string): Promise<ResolvedDownload> {
    this.assertObjectStorePointer(pdfUrl);
    const storageConfig = await this.resolveObjectStoreConfig();
    const store = this.storeFactory.create(storageConfig);
    const url = await store.getDownloadUrl(pdfUrl, 300);
    return { kind: storageConfig.provider, url };
  }
}

/** 对象存储 key 段清洗：去掉路径分隔符等危险字符，保留可读性。 */
function sanitizeSegment(s: string): string {
  return String(s).replace(/[^a-zA-Z0-9._@-]/g, '_').slice(0, 200) || 'unknown';
}

function sanitizeExtension(extension: string): 'pdf' | 'ofd' | 'xlsx' {
  if (extension === 'ofd') return 'ofd';
  if (extension === 'xlsx') return 'xlsx';
  return 'pdf';
}

function contentTypeForExtension(extension: string): string {
  if (extension === 'ofd') return 'application/octet-stream';
  if (extension === 'xlsx') {
    return 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet';
  }
  return 'application/pdf';
}

/**
 * OSS 内网 endpoint → 公网 endpoint：oss-cn-beijing-internal.aliyuncs.com
 * → oss-cn-beijing.aliyuncs.com。已是公网 / 非阿里云 host 时返回 undefined（沿用原 endpoint）。
 */
function toPublicOssEndpoint(endpoint?: string): string | undefined {
  if (!endpoint) return undefined;
  const publicEndpoint = endpoint.replace(/-internal\.aliyuncs\.com/i, '.aliyuncs.com');
  return publicEndpoint === endpoint ? undefined : publicEndpoint;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return !!value && typeof value === 'object' && !Array.isArray(value);
}

function firstString(source: Record<string, unknown>, keys: string[]): string {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'string' && value.trim()) return value.trim();
  }
  return '';
}

function firstBoolean(
  source: Record<string, unknown>,
  keys: string[],
): boolean | undefined {
  for (const key of keys) {
    const value = source[key];
    if (typeof value === 'boolean') return value;
    if (typeof value !== 'string') continue;
    const normalized = value.trim().toLowerCase();
    if (normalized === 'true') return true;
    if (normalized === 'false') return false;
  }
  return undefined;
}
