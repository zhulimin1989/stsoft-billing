import { BadRequestException, Injectable, Logger, NotFoundException } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, ProductConfigSyncJob } from '@prisma/client';
import { PrismaService } from '../../prisma/prisma.service';
import { decrypt } from '../../common/utils/crypto';
import { resolveEncryptionKey } from '../../common/utils/encryption-key';
import { signHmac, webhookTimestamp } from '../../common/utils/hmac.util';
import { assertSafeExternalUrl } from '../../common/utils/url-guard.util';

export const PRODUCT_CONFIG_SYNC_JOB_STATUSES = [
  'PENDING',
  'PROCESSING',
  'SUCCEEDED',
  'FAILED',
] as const;

export type ProductConfigSyncJobStatus = typeof PRODUCT_CONFIG_SYNC_JOB_STATUSES[number];

export interface ProductConfigSyncDispatchOptions {
  source?: string;
  resourceType?: string;
  resourceId?: string;
  resources?: string[];
  payload?: Record<string, unknown>;
  maxAttempts?: number;
}

type ProductWebhookTarget = {
  id: string;
  slug: string;
  webhookUrl: string | null;
  webhookSecretEncrypted: string | null;
};

@Injectable()
export class ProductConfigSyncService {
  private readonly logger = new Logger(ProductConfigSyncService.name);
  private readonly defaultMaxAttempts = 8;
  private readonly encryptionKey: string;

  constructor(
    private readonly prisma: PrismaService,
    private readonly config: ConfigService,
  ) {
    this.encryptionKey = resolveEncryptionKey(this.config);
  }

  async enqueueProduct(
    productSlug: string,
    changeType: string,
    options: ProductConfigSyncDispatchOptions = {},
  ): Promise<ProductConfigSyncJob | null> {
    const product = await this.prisma.product.findFirst({
      where: { slug: productSlug, deletedAt: null },
      select: {
        id: true,
        slug: true,
        webhookUrl: true,
        webhookSecretEncrypted: true,
      },
    });
    if (!product) return null;
    if (!product.webhookUrl) {
      this.logger.debug(`产品 ${productSlug} 未配置 webhookUrl，跳过配置同步任务`);
      return null;
    }
    return this.upsertJob(product, changeType, options);
  }

  async enqueueAll(
    changeType: string,
    options: ProductConfigSyncDispatchOptions = {},
  ): Promise<{ queued: number; skipped: number }> {
    const products = await this.prisma.product.findMany({
      where: { webhookUrl: { not: null }, deletedAt: null },
      select: {
        id: true,
        slug: true,
        webhookUrl: true,
        webhookSecretEncrypted: true,
      },
    });

    let queued = 0;
    let skipped = 0;
    for (const product of products) {
      if (!product.webhookUrl) {
        skipped += 1;
        continue;
      }
      await this.upsertJob(product, changeType, options);
      queued += 1;
    }
    return { queued, skipped };
  }

  async processDue(limit = 20): Promise<{ processed: number; succeeded: number; failed: number }> {
    const jobs = await this.prisma.productConfigSyncJob.findMany({
      where: {
        status: { in: ['PENDING', 'FAILED'] },
        nextRunAt: { lte: new Date() },
      },
      orderBy: [{ nextRunAt: 'asc' }, { createdAt: 'asc' }],
      take: limit,
    });

    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    for (const job of jobs) {
      if (job.attempts >= job.maxAttempts) continue;
      const next = await this.processOne(job.id);
      if (!next) continue;
      processed += 1;
      if (next.status === 'SUCCEEDED') succeeded += 1;
      if (next.status === 'FAILED') failed += 1;
    }
    return { processed, succeeded, failed };
  }

  async processOne(id: string): Promise<ProductConfigSyncJob | null> {
    const job = await this.prisma.productConfigSyncJob.findUnique({ where: { id } });
    if (!job) return null;
    if (job.status === 'SUCCEEDED') return job;
    if (job.attempts >= job.maxAttempts) return job;

    const claimed = await this.prisma.productConfigSyncJob.updateMany({
      where: {
        id,
        status: { in: ['PENDING', 'FAILED'] },
      },
      data: {
        status: 'PROCESSING',
        lockedAt: new Date(),
      },
    });
    if (claimed.count === 0) {
      return this.prisma.productConfigSyncJob.findUnique({ where: { id } });
    }

    try {
      const product = await this.prisma.product.findFirst({
        where: { slug: job.productSlug, deletedAt: null },
        select: {
          id: true,
          slug: true,
          webhookUrl: true,
          webhookSecretEncrypted: true,
        },
      });
      if (!product?.webhookUrl) {
        return this.markSucceeded(id, {
          skipped: true,
          reason: product ? 'missing_webhook_url' : 'product_not_found',
        });
      }

      const response = await this.deliver(job, product);
      return this.markSucceeded(id, response);
    } catch (err) {
      return this.markFailed(job, err);
    }
  }

  async getJob(id: string): Promise<ProductConfigSyncJob> {
    const job = await this.prisma.productConfigSyncJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException('产品配置同步任务不存在');
    return job;
  }

  async retryNow(id: string): Promise<ProductConfigSyncJob> {
    const job = await this.prisma.productConfigSyncJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException('产品配置同步任务不存在');

    await this.prisma.productConfigSyncJob.update({
      where: { id },
      data: {
        status: 'PENDING',
        attempts: 0,
        maxAttempts: Math.max(job.maxAttempts, this.defaultMaxAttempts),
        nextRunAt: new Date(),
        lockedAt: null,
        processedAt: null,
        lastError: null,
      },
    });
    return (await this.processOne(id)) ?? this.getJob(id);
  }

  private async upsertJob(
    product: ProductWebhookTarget,
    changeType: string,
    options: ProductConfigSyncDispatchOptions,
  ): Promise<ProductConfigSyncJob> {
    const now = new Date();
    const resources = options.resources ?? this.resourcesForChange(changeType);
    const idempotencyKey = [
      'product-config',
      product.slug,
      changeType,
      options.resourceType ?? 'global',
      options.resourceId ?? 'all',
    ].join(':');
    const payload = {
      type: changeType,
      productSlug: product.slug,
      changeType,
      resources,
      version: now.toISOString(),
      source: options.source ?? 'billing',
      ...(options.payload ?? {}),
    };
    const data = {
      productId: product.id,
      productSlug: product.slug,
      changeType,
      payload: this.jsonValue(payload),
      status: 'PENDING',
      attempts: 0,
      maxAttempts: options.maxAttempts ?? this.defaultMaxAttempts,
      source: options.source ?? 'billing',
      resourceType: options.resourceType ?? 'product_config_event',
      resourceId: options.resourceId ?? `${product.slug}:${changeType}`,
      lastError: null,
      response: Prisma.DbNull,
      nextRunAt: now,
      lockedAt: null,
      processedAt: null,
    } satisfies Prisma.ProductConfigSyncJobUpdateInput;

    const existing = await this.prisma.productConfigSyncJob.findUnique({
      where: { idempotencyKey },
    });
    if (existing) {
      return this.prisma.productConfigSyncJob.update({
        where: { id: existing.id },
        data,
      });
    }

    try {
      return await this.prisma.productConfigSyncJob.create({
        data: {
          idempotencyKey,
          ...data,
        } satisfies Prisma.ProductConfigSyncJobCreateInput,
      });
    } catch (err) {
      if (this.isUniqueViolation(err)) {
        return this.prisma.productConfigSyncJob.update({
          where: { idempotencyKey },
          data,
        });
      }
      throw err;
    }
  }

  private async deliver(
    job: ProductConfigSyncJob,
    product: ProductWebhookTarget,
  ): Promise<Record<string, unknown>> {
    const url = product.webhookUrl;
    if (!url) throw new BadRequestException('product webhookUrl is missing');
    await assertSafeExternalUrl(url);

    const body = JSON.stringify(this.payloadForDelivery(job, product.slug));
    const syncToken = this.config.get<string>('SYNC_TOKEN') || '';
    const secret = this.decryptProductWebhookSecret(product.webhookSecretEncrypted)
      || this.config.get<string>('SYNC_WEBHOOK_SECRET')
      || syncToken;
    const timestamp = webhookTimestamp();
    const signature = signHmac(secret, timestamp, body);

    const response = await fetch(url, {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
        'X-Sync-Token': syncToken,
        'X-Webhook-Timestamp': timestamp,
        'X-Webhook-Signature': signature,
      },
      body,
      signal: AbortSignal.timeout(10_000),
    });

    const responseText = await response.text().catch(() => '');
    if (!response.ok) {
      const error = new ProductConfigWebhookError(
        `product webhook failed status=${response.status}`,
        response.status,
        responseText,
      );
      throw error;
    }

    return {
      status: response.status,
      body: responseText.slice(0, 2000),
    };
  }

  private payloadForDelivery(job: ProductConfigSyncJob, productSlug: string): Record<string, unknown> {
    const payload = this.recordFromJson(job.payload);
    return {
      ...payload,
      eventId: job.id,
      productSlug,
      type: payload.type ?? job.changeType,
      changeType: payload.changeType ?? job.changeType,
    };
  }

  private async markSucceeded(
    id: string,
    response: Record<string, unknown>,
  ): Promise<ProductConfigSyncJob> {
    return this.prisma.productConfigSyncJob.update({
      where: { id },
      data: {
        status: 'SUCCEEDED',
        response: this.jsonValue(response),
        lastError: null,
        lockedAt: null,
        processedAt: new Date(),
      },
    });
  }

  private async markFailed(
    job: ProductConfigSyncJob,
    err: unknown,
  ): Promise<ProductConfigSyncJob> {
    const attempts = job.attempts + 1;
    const nonRetryable = this.isNonRetryable(err);
    const maxAttempts = nonRetryable ? attempts : job.maxAttempts;
    const hasMoreAttempts = !nonRetryable && attempts < job.maxAttempts;
    const updated = await this.prisma.productConfigSyncJob.update({
      where: { id: job.id },
      data: {
        status: 'FAILED',
        attempts,
        maxAttempts,
        lastError: this.errorMessage(err),
        response: this.errorResponse(err),
        lockedAt: null,
        nextRunAt: hasMoreAttempts ? this.nextRunAt(attempts) : new Date(),
      },
    });
    if (!hasMoreAttempts) {
      this.logger.warn(
        `product config sync job failed product=${job.productSlug} change=${job.changeType}: ${updated.lastError}`,
      );
    }
    return updated;
  }

  private resourcesForChange(changeType: string): string[] {
    if (changeType === 'plans_changed') return ['plans'];
    if (changeType === 'model_access_changed') return ['model_access'];
    if (changeType === 'channels_changed') return ['channels'];
    if (
      [
        'model_pricing_changed',
        'model_pricing_synced',
        'model_pricing_deleted',
        'models_published',
      ].includes(changeType)
    ) {
      return ['model_pricing', 'channels'];
    }
    return ['plans', 'model_access', 'model_pricing', 'channels'];
  }

  private decryptProductWebhookSecret(encrypted?: string | null): string | undefined {
    if (!encrypted) return undefined;
    if (!this.encryptionKey) {
      this.logger.warn('产品已配置 webhook secret，但 ENCRYPTION_KEY 不可用，回退到全局 webhook secret');
      return undefined;
    }
    try {
      return decrypt(encrypted, this.encryptionKey);
    } catch (err) {
      this.logger.warn(`产品 webhook secret 解密失败，回退到全局 webhook secret: ${(err as Error).message}`);
      return undefined;
    }
  }

  private nextRunAt(attempts: number): Date {
    const baseMs = 60_000;
    const delayMs = Math.min(baseMs * (2 ** Math.max(0, attempts - 1)), 30 * 60_000);
    return new Date(Date.now() + delayMs);
  }

  private jsonValue(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull | typeof Prisma.DbNull | undefined {
    if (value === undefined) return undefined;
    if (value === null) return Prisma.JsonNull;
    return value as Prisma.InputJsonValue;
  }

  private recordFromJson(value: Prisma.JsonValue | null): Record<string, unknown> {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return {};
    return value as Record<string, unknown>;
  }

  private errorMessage(err: unknown): string {
    if (err instanceof ProductConfigWebhookError) {
      const details = err.body ? ` body=${err.body.slice(0, 1000)}` : '';
      return `status=${err.status} ${err.message}${details}`.slice(0, 2000);
    }
    if (err instanceof BadRequestException) return err.message.slice(0, 2000);
    if (err instanceof Error) return err.message.slice(0, 2000);
    return String(err).slice(0, 2000);
  }

  private errorResponse(err: unknown): Prisma.InputJsonValue | typeof Prisma.DbNull {
    if (err instanceof ProductConfigWebhookError) {
      return {
        status: err.status,
        body: err.body.slice(0, 2000),
      };
    }
    return Prisma.DbNull;
  }

  private isNonRetryable(err: unknown): boolean {
    if (err instanceof ProductConfigWebhookError) {
      return err.status >= 400 && err.status < 500;
    }
    return err instanceof BadRequestException;
  }

  private isUniqueViolation(err: unknown): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
  }
}

class ProductConfigWebhookError extends Error {
  constructor(
    message: string,
    readonly status: number,
    readonly body: string,
  ) {
    super(message);
  }
}
