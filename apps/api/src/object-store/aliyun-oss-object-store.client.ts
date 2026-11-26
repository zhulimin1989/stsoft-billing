import type OSS from 'ali-oss';
import type { ObjectStoreClient, ObjectStoreConfig, PutObjectInput } from './object-store.types';

export class AliyunOssObjectStoreClient implements ObjectStoreClient {
  readonly provider = 'aliyun_oss' as const;
  private client: OSS | null = null;
  private signClient: OSS | null = null;

  constructor(private readonly config: ObjectStoreConfig) {}

  async putObject(input: PutObjectInput): Promise<void> {
    const oss = await this.getClient();
    await oss.put(input.key, input.body, {
      headers: {
        'Content-Type': input.contentType,
        ...(input.filename
          ? { 'Content-Disposition': `attachment; filename="${input.filename}"` }
          : {}),
      },
    });
  }

  async deleteObject(key: string): Promise<void> {
    const oss = await this.getClient();
    await oss.delete(key);
  }

  async readObject(key: string): Promise<Buffer> {
    const oss = await this.getClient();
    const res = await oss.get(key);
    const content = res.content as Buffer | Uint8Array | string;
    if (Buffer.isBuffer(content)) return content;
    return Buffer.from(content);
  }

  async getDownloadUrl(key: string, expiresInSeconds: number): Promise<string> {
    const oss = await this.getSignClient();
    return oss.signatureUrl(key, {
      expires: expiresInSeconds,
      method: 'GET',
    });
  }

  private async getClient(): Promise<OSS> {
    if (this.client) return this.client;
    this.client = await this.buildClient(this.config.endpoint);
    return this.client;
  }

  /**
   * 签发浏览器下载用 presigned URL 的专用 client：绑定公网 endpoint。
   * OSS 内网 endpoint(*-internal)只在 VPC 内可达，浏览器打不开，
   * 下载链接必须用公网 host 签发。OSS V1 签名不含 Host，换 endpoint 不影响签名有效性。
   * 未配置独立 publicEndpoint 时复用内网 client，不额外建实例。
   */
  private async getSignClient(): Promise<OSS> {
    if (this.signClient) return this.signClient;
    const publicEndpoint = this.config.publicEndpoint;
    if (!publicEndpoint || publicEndpoint === this.config.endpoint) {
      this.signClient = await this.getClient();
      return this.signClient;
    }
    this.signClient = await this.buildClient(publicEndpoint);
    return this.signClient;
  }

  private async buildClient(endpoint: string | undefined): Promise<OSS> {
    const mod = await import('ali-oss');
    const OSSClient = mod.default ?? mod;
    if (!this.config.credentials) {
      throw new Error('aliyun oss credentials are required');
    }
    return new OSSClient({
      bucket: this.config.bucket,
      region: this.config.region,
      endpoint,
      accessKeyId: this.config.credentials.accessKeyId,
      accessKeySecret: this.config.credentials.secretAccessKey,
      secure: endpoint ? endpoint.startsWith('https://') : true,
    });
  }
}
