export type ObjectStoreProvider = 's3' | 'aliyun_oss';

export interface ObjectStoreCredentials {
  accessKeyId: string;
  secretAccessKey: string;
}

export interface ObjectStoreConfig {
  provider: ObjectStoreProvider;
  bucket: string;
  region: string;
  /** 服务端读写用的 endpoint（OSS 内网 *-internal 更快更省流量） */
  endpoint?: string;
  /**
   * 浏览器可直达的公网 endpoint，仅用于签发下载用 presigned URL。
   * 内网 endpoint(*-internal)在 VPC 外不可达，下载链接必须走公网 host。
   * 未配置时下载沿用 endpoint。
   */
  publicEndpoint?: string;
  keyPrefix?: string;
  credentials?: ObjectStoreCredentials;
  forcePathStyle?: boolean;
}

export interface PutObjectInput {
  key: string;
  body: Buffer;
  contentType: string;
  filename?: string;
}

export interface ObjectStoreClient {
  readonly provider: ObjectStoreProvider;
  putObject(input: PutObjectInput): Promise<void>;
  deleteObject(key: string): Promise<void>;
  readObject(key: string): Promise<Buffer>;
  getDownloadUrl(key: string, expiresInSeconds: number): Promise<string>;
}
