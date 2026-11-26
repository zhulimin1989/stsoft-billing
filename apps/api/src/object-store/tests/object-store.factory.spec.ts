import { ObjectStoreFactory } from '../object-store.factory';

const mockS3Send = jest.fn();
const mockGetSignedUrl = jest.fn(async (_client: unknown, command: unknown) => {
  const input = (command as { input?: { Bucket?: string; Key?: string } }).input;
  return `https://s3.signed.test/${input?.Bucket}/${input?.Key}`;
});
const mockOssPut = jest.fn(async () => undefined);
const mockOssDelete = jest.fn(async () => undefined);
const mockOssGet = jest.fn(async () => ({ content: Buffer.from('oss-data') }));
const mockOssSignatureUrl = jest.fn((key: string) => `https://oss.signed.test/${key}`);
const mockOssConstructor = jest.fn();

jest.mock('@aws-sdk/client-s3', () => {
  class MockS3Client {
    readonly config: unknown;
    constructor(config: unknown) {
      this.config = config;
    }
    send = mockS3Send;
  }
  class MockPutObjectCommand {
    constructor(readonly input: unknown) {}
  }
  class MockGetObjectCommand {
    constructor(readonly input: unknown) {}
  }
  class MockDeleteObjectCommand {
    constructor(readonly input: unknown) {}
  }
  return {
    S3Client: MockS3Client,
    PutObjectCommand: MockPutObjectCommand,
    GetObjectCommand: MockGetObjectCommand,
    DeleteObjectCommand: MockDeleteObjectCommand,
  };
});

jest.mock('@aws-sdk/s3-request-presigner', () => ({
  getSignedUrl: mockGetSignedUrl,
}));

jest.mock('ali-oss', () => {
  return jest.fn().mockImplementation((config: unknown) => {
    mockOssConstructor(config);
    return {
      put: mockOssPut,
      delete: mockOssDelete,
      get: mockOssGet,
      signatureUrl: mockOssSignatureUrl,
    };
  });
});

describe('ObjectStoreFactory', () => {
  beforeEach(() => {
    jest.clearAllMocks();
    mockS3Send.mockResolvedValue({});
  });

  it('provider=s3 时创建 S3 client 并上传对象', async () => {
    const factory = new ObjectStoreFactory();
    const client = factory.create({
      provider: 's3',
      bucket: 'bucket-s3',
      region: 'ap-east-1',
      endpoint: 'https://s3.test',
      forcePathStyle: true,
    });

    await client.putObject({
      key: 'invoices/u1/a.pdf',
      body: Buffer.from('pdf'),
      contentType: 'application/pdf',
      filename: 'a.pdf',
    });

    expect(client.provider).toBe('s3');
    expect(mockS3Send).toHaveBeenCalledWith(
      expect.objectContaining({
        input: expect.objectContaining({
          Bucket: 'bucket-s3',
          Key: 'invoices/u1/a.pdf',
          Body: Buffer.from('pdf'),
          ContentType: 'application/pdf',
          ContentDisposition: 'attachment; filename="a.pdf"',
        }),
      }),
    );
  });

  it('provider=aliyun_oss 时创建 Aliyun OSS client 并上传对象', async () => {
    const factory = new ObjectStoreFactory();
    const client = factory.create({
      provider: 'aliyun_oss',
      bucket: 'bucket-oss',
      region: 'cn-hangzhou',
      endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
      credentials: { accessKeyId: 'ak', secretAccessKey: 'sk' },
    });

    await client.putObject({
      key: 'invoices/u1/a.pdf',
      body: Buffer.from('pdf'),
      contentType: 'application/pdf',
      filename: 'a.pdf',
    });

    expect(client.provider).toBe('aliyun_oss');
    expect(mockOssConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: 'bucket-oss',
        region: 'cn-hangzhou',
        endpoint: 'https://oss-cn-hangzhou.aliyuncs.com',
        accessKeyId: 'ak',
        accessKeySecret: 'sk',
        secure: true,
      }),
    );
    expect(mockOssPut).toHaveBeenCalledWith(
      'invoices/u1/a.pdf',
      Buffer.from('pdf'),
      {
        headers: {
          'Content-Type': 'application/pdf',
          'Content-Disposition': 'attachment; filename="a.pdf"',
        },
      },
    );
  });

  it('provider=aliyun_oss 未显式 endpoint 时默认使用 HTTPS', async () => {
    const factory = new ObjectStoreFactory();
    const client = factory.create({
      provider: 'aliyun_oss',
      bucket: 'bucket-oss',
      region: 'cn-hangzhou',
      credentials: { accessKeyId: 'ak', secretAccessKey: 'sk' },
    });

    await client.getDownloadUrl('invoices/u1/a.pdf', 300);

    expect(mockOssConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        bucket: 'bucket-oss',
        region: 'cn-hangzhou',
        secure: true,
      }),
    );
  });

  it('provider=aliyun_oss 显式 http endpoint 时保留非 HTTPS 配置', async () => {
    const factory = new ObjectStoreFactory();
    const client = factory.create({
      provider: 'aliyun_oss',
      bucket: 'bucket-oss',
      region: 'cn-hangzhou',
      endpoint: 'http://oss-cn-hangzhou.aliyuncs.com',
      credentials: { accessKeyId: 'ak', secretAccessKey: 'sk' },
    });

    await client.getDownloadUrl('invoices/u1/a.pdf', 300);

    expect(mockOssConstructor).toHaveBeenCalledWith(
      expect.objectContaining({
        endpoint: 'http://oss-cn-hangzhou.aliyuncs.com',
        secure: false,
      }),
    );
  });

  it('相同配置复用 client', () => {
    const factory = new ObjectStoreFactory();
    const config = { provider: 's3' as const, bucket: 'b', region: 'r' };

    expect(factory.create(config)).toBe(factory.create(config));
  });
});
