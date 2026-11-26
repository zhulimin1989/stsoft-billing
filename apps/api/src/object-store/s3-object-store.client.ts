import type { ObjectStoreClient, ObjectStoreConfig, PutObjectInput } from './object-store.types';

export class S3ObjectStoreClient implements ObjectStoreClient {
  readonly provider = 's3' as const;
  private client: import('@aws-sdk/client-s3').S3Client | null = null;

  constructor(private readonly config: ObjectStoreConfig) {}

  async putObject(input: PutObjectInput): Promise<void> {
    const { PutObjectCommand } = await import('@aws-sdk/client-s3');
    const s3 = await this.getClient();
    await s3.send(
      new PutObjectCommand({
        Bucket: this.config.bucket,
        Key: input.key,
        Body: input.body,
        ContentType: input.contentType,
        ...(input.filename
          ? { ContentDisposition: `attachment; filename="${input.filename}"` }
          : {}),
      }),
    );
  }

  async deleteObject(key: string): Promise<void> {
    const { DeleteObjectCommand } = await import('@aws-sdk/client-s3');
    const s3 = await this.getClient();
    await s3.send(new DeleteObjectCommand({ Bucket: this.config.bucket, Key: key }));
  }

  async readObject(key: string): Promise<Buffer> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const s3 = await this.getClient();
    const res = await s3.send(new GetObjectCommand({ Bucket: this.config.bucket, Key: key }));
    const body = res.Body as unknown as AsyncIterable<Uint8Array> | undefined;
    if (!body) throw new Error(`s3 object empty: ${key}`);
    const chunks: Buffer[] = [];
    for await (const chunk of body) chunks.push(Buffer.from(chunk));
    return Buffer.concat(chunks);
  }

  async getDownloadUrl(key: string, expiresInSeconds: number): Promise<string> {
    const { GetObjectCommand } = await import('@aws-sdk/client-s3');
    const { getSignedUrl } = await import('@aws-sdk/s3-request-presigner');
    const s3 = await this.getClient();
    return getSignedUrl(
      s3,
      new GetObjectCommand({ Bucket: this.config.bucket, Key: key }),
      { expiresIn: expiresInSeconds },
    );
  }

  private async getClient(): Promise<import('@aws-sdk/client-s3').S3Client> {
    if (this.client) return this.client;
    const { S3Client } = await import('@aws-sdk/client-s3');
    this.client = new S3Client({
      region: this.config.region,
      endpoint: this.config.endpoint,
      forcePathStyle: this.config.forcePathStyle,
      credentials: this.config.credentials,
    });
    return this.client;
  }
}
