import {
  BadRequestException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
  ServiceUnavailableException,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma, PublisherSyncJob } from '@prisma/client';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherClient, PublisherClientError } from './publisher.client';
import {
  PublisherAcceptedResponse,
  PublisherHttpMethod,
  PublisherKeyAdmissionDeliveryReceipt,
  PublisherNamespace,
} from './publisher.types';
import {
  retiredPublisherRequest,
} from './publisher-request-policy';
import {
  publisherRetryBacklog,
  publisherRetryBacklogOldestAgeSeconds,
  publisherRetryWorkerTotal,
} from '../metrics/metrics.registry';

export const PUBLISHER_SYNC_JOB_STATUSES = [
  'PENDING',
  'PROCESSING',
  'SUCCEEDED',
  'SUPERSEDED',
  'FAILED',
  'LEGACY_PROVIDER_PUBLISH_RETIRED',
  'RUNTIME_INTENT_V1_RETIRED',
  'LEGACY_KEY_POOL_PUBLISH_RETIRED',
  'DEDICATED_KEY_META_V1_RETIRED',
] as const;

export type PublisherSyncJobStatus = typeof PUBLISHER_SYNC_JOB_STATUSES[number];

type PublisherSyncProcessingOrigin = 'manual' | 'worker';
type PublisherRetryWorkerOutcome =
  | 'succeeded'
  | 'superseded'
  | 'retryable_failed'
  | 'publisher_unavailable'
  | 'exhausted'
  | 'permanent_failed'
  | 'retired'
  | 'skipped';

export interface PublisherSyncDispatchInput {
  namespace: PublisherNamespace;
  method: PublisherHttpMethod;
  path: string;
  body?: unknown;
  idempotencyKey?: string;
  requestId?: string;
  source?: string;
  resourceType?: string;
  resourceId?: string;
  maxAttempts?: number;
}

export class PublisherAdmissionSupersededError extends Error {
  constructor(
    readonly idempotencyKey: string,
    readonly publisherStatus?: number,
  ) {
    super(`Publisher key admission decision was superseded: ${idempotencyKey}`);
    this.name = 'PublisherAdmissionSupersededError';
  }
}

export type PublisherSyncDispatchResult = {
  accepted: boolean;
  status: 'ACCEPTED' | 'PENDING' | 'FAILED' | 'DISABLED';
  idempotencyKey: string;
  response?: PublisherAcceptedResponse;
  error?: string;
  errorCode?: string;
  retryable?: boolean;
  publisherStatus?: number;
};

export interface PublisherSyncJobListQuery {
  page?: number;
  pageSize?: number;
  status?: string;
  namespace?: string;
  method?: string;
  path?: string;
  resourceType?: string;
  resourceId?: string;
  idempotencyKey?: string;
}

@Injectable()
export class PublisherSyncJobService {
  private readonly logger = new Logger(PublisherSyncJobService.name);
  private readonly defaultMaxAttempts = 8;
  private readonly processingLeaseMs: number;
  private readonly admissionReceiptTimeoutMs: number;
  private readonly admissionReceiptPollIntervalMs: number;
  private readonly publisherUnavailableMessage = 'Publisher 未配置，等待配置 PUBLISHER_BASE_URL / token 后重试';
  private retirementSweepAfterId: string | undefined;

  constructor(
    private readonly publisher: PublisherClient,
    private readonly prisma: PrismaService,
    @Optional() private readonly config?: ConfigService,
  ) {
    this.processingLeaseMs = this.resolveProcessingLeaseMs();
    this.admissionReceiptTimeoutMs = this.resolvePositiveMilliseconds(
      'PUBLISHER_KEY_ADMISSION_RECEIPT_TIMEOUT_MS',
      5_000,
      60_000,
    );
    this.admissionReceiptPollIntervalMs = this.resolvePositiveMilliseconds(
      'PUBLISHER_KEY_ADMISSION_RECEIPT_POLL_INTERVAL_MS',
      500,
      5_000,
    );
  }

  async dispatchRequired(input: PublisherSyncDispatchInput): Promise<PublisherAcceptedResponse> {
    const result = await this.dispatchDetailedInternal(input, true);
    if (result.accepted) return result.response!;

    const data = {
      status: result.status,
      idempotencyKey: result.idempotencyKey,
      error: result.error ?? null,
      errorCode: result.errorCode ?? null,
      retryable: result.retryable ?? null,
      publisherStatus: result.publisherStatus ?? null,
    };
    if (result.errorCode === 'KEY_ADMISSION_SUPERSEDED') {
      throw new PublisherAdmissionSupersededError(
        result.idempotencyKey,
        result.publisherStatus,
      );
    }
    if (result.publisherStatus === 400 || result.publisherStatus === 422) {
      throw new BadRequestException({
        code: 'PUBLISHER_SYNC_REJECTED',
        message: 'Publisher 拒绝了同步请求，变更已记录到同步任务，请修正配置后手动重试',
        data,
      });
    }

    throw new ServiceUnavailableException({
      code: 'PUBLISHER_SYNC_NOT_ACCEPTED',
      message: result.retryable === false
        ? 'Publisher 同步失败且不会自动重试，变更已记录到同步任务，请修正配置后手动重试'
        : 'Publisher 同步未被接收，变更已记录到同步任务，请重试或在 Publisher Sync Jobs 中处理',
      data,
    });
  }

  async dispatchDetailed(input: PublisherSyncDispatchInput): Promise<PublisherSyncDispatchResult> {
    return this.dispatchDetailedInternal(input, false);
  }

  private async dispatchDetailedInternal(
    input: PublisherSyncDispatchInput,
    required: boolean,
  ): Promise<PublisherSyncDispatchResult> {
    this.assertPublisherRequestAllowed(input);
    const idempotencyKey = input.idempotencyKey
      ?? this.publisher.idempotencyKey(input.namespace, input.method, input.path, input.body);

    try {
      const response = await this.publisher.request(input.namespace, input.method, input.path, input.body, {
        idempotencyKey,
        requestId: input.requestId,
      });
      if (response === null) {
        if (this.publisher.isExplicitlyDisabled?.()) {
          return {
            accepted: false,
            status: 'DISABLED',
            idempotencyKey,
            error: 'Publisher is explicitly disabled',
          };
        }
        await this.recordPendingConfiguration(input, idempotencyKey);
        return {
          accepted: false,
          status: 'PENDING',
          idempotencyKey,
          error: this.publisherUnavailableMessage,
        };
      }
      const receiptRequired = this.admissionReceiptRequired(input);
      if (receiptRequired) {
        try {
          // A tracked 202 without a batch identifier is not an acceptance: it
          // cannot ever be reconciled against Publisher's durable outbox.
          this.requiredAdmissionBatchId(response);
          if (!required) {
            await this.recordAdmissionPending(input, idempotencyKey, response);
            return {
              accepted: true,
              status: 'ACCEPTED',
              idempotencyKey,
              response,
            };
          }
          const completedResponse = await this.withVerifiedAdmissionDelivery(
            response,
            input.requestId,
          );
          await this.recordSucceeded(input, idempotencyKey, completedResponse);
          return {
            accepted: true,
            status: 'ACCEPTED',
            idempotencyKey,
            response: completedResponse,
          };
        } catch (err) {
          const failure = this.failureMetadata(err);
          const failedResponse = this.responseWithAdmissionReceipt(response, err);
          if (failure.errorCode === 'KEY_ADMISSION_SUPERSEDED') {
            await this.recordSuperseded(input, idempotencyKey, failedResponse, failure.message);
          } else {
            await this.recordFailedAttempt(input, idempotencyKey, err, failedResponse);
          }
          return {
            accepted: false,
            status: failure.retryable ? 'PENDING' : 'FAILED',
            idempotencyKey,
            error: failure.message,
            errorCode: failure.errorCode,
            retryable: failure.retryable,
            publisherStatus: failure.publisherStatus,
          };
        }
      }
      const completedResponse = response;
      await this.recordSucceeded(input, idempotencyKey, completedResponse);
      return {
        accepted: true,
        status: 'ACCEPTED',
        idempotencyKey,
        response: completedResponse,
      };
    } catch (err) {
      const failure = this.failureMetadata(err);
      await this.recordFailedAttempt(
        input,
        idempotencyKey,
        err,
        undefined,
      );
      return {
        accepted: false,
        status: 'FAILED',
        idempotencyKey,
        error: failure.message,
        errorCode: failure.errorCode,
        retryable: failure.retryable,
        publisherStatus: failure.publisherStatus,
      };
    }
  }

  async listJobs(query: PublisherSyncJobListQuery = {}) {
    const page = Math.max(1, query.page ?? 1);
    const pageSize = Math.min(100, Math.max(1, query.pageSize ?? 20));
    const where: Prisma.PublisherSyncJobWhereInput = {};

    if (query.status) where.status = query.status;
    if (query.namespace) {
      const namespaces = this.namespaceFilter(query.namespace);
      where.namespace = namespaces.length === 1 ? namespaces[0] : { in: namespaces };
    }
    if (query.method) where.method = query.method;
    if (query.path) where.path = { contains: query.path, mode: 'insensitive' };
    if (query.resourceType) where.resourceType = query.resourceType;
    if (query.resourceId) where.resourceId = query.resourceId;
    if (query.idempotencyKey) {
      where.idempotencyKey = { contains: query.idempotencyKey, mode: 'insensitive' };
    }

    const [items, total] = await Promise.all([
      this.prisma.publisherSyncJob.findMany({
        where,
        orderBy: [{ createdAt: 'desc' }],
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.publisherSyncJob.count({ where }),
    ]);

    return {
      items,
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async getJob(id: string): Promise<PublisherSyncJob> {
    const job = await this.prisma.publisherSyncJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException('Publisher 同步任务不存在');
    return job;
  }

  async retryNow(id: string): Promise<PublisherSyncJob> {
    const job = await this.prisma.publisherSyncJob.findUnique({ where: { id } });
    if (!job) throw new NotFoundException('Publisher 同步任务不存在');

    // Manual retry must never steal an active worker lease or reopen immutable
    // audit outcomes. Stale PROCESSING work is reclaimed only by processOne's
    // lease CAS; operators can retry again after that attempt reaches FAILED.
    if (
      job.status === 'PROCESSING'
      || job.status === 'SUCCEEDED'
      || job.status === 'SUPERSEDED'
      || job.status.endsWith('_RETIRED')
    ) {
      return job;
    }
    const retired = await this.terminalizeRetiredStoredJob(job);
    if (retired) return retired.job;

    if (job.status !== 'PENDING' && job.status !== 'FAILED') return job;

    const reset = await this.prisma.publisherSyncJob.updateMany({
      where: {
        id,
        status: job.status,
        attempts: job.attempts,
        lockedAt: job.lockedAt,
        processedAt: job.processedAt,
      },
      data: {
        status: 'PENDING',
        attempts: 0,
        nextRunAt: new Date(),
        lockedAt: null,
        processedAt: null,
        lastError: null,
      },
    });
    if (reset.count !== 1) return this.getJob(id);

    const processed = await this.processOne(id);
    return processed ?? this.getJob(id);
  }

  async processDue(limit = 20): Promise<{ processed: number; succeeded: number; failed: number }> {
    const now = new Date();
    const leaseExpiredBefore = new Date(now.getTime() - this.processingLeaseMs);
    const batchLimit = Math.max(0, Math.floor(limit));
    const jobs = batchLimit === 0
      ? []
      : await this.prisma.publisherSyncJob.findMany({
          where: {
            OR: [
              {
                status: { in: ['PENDING', 'FAILED'] },
                processedAt: null,
                nextRunAt: { lte: now },
              },
              {
                status: 'PROCESSING',
                OR: [
                  { lockedAt: null },
                  { lockedAt: { lte: leaseExpiredBefore } },
                ],
              },
            ],
          },
          orderBy: [{ nextRunAt: 'asc' }, { createdAt: 'asc' }],
          take: batchLimit,
        });

    let processed = 0;
    let succeeded = 0;
    let failed = 0;
    for (const job of jobs) {
      // A PROCESSING row may still be owned by a live worker. Let processOne
      // acquire/reclaim its lease before making any terminal-state mutation.
      if (job.status !== 'PROCESSING') {
        const retired = await this.terminalizeRetiredStoredJob(job, now);
        if (retired) {
          if (!retired.applied) continue;
          publisherRetryWorkerTotal.labels('retired').inc();
          processed += 1;
          failed += 1;
          continue;
        }
      }
      if (job.attempts >= job.maxAttempts) {
        const finalized = await this.terminalizeExhaustedStoredJob(job, now);
        if (finalized) {
          publisherRetryWorkerTotal.labels('exhausted').inc();
          processed += 1;
          failed += 1;
        }
        continue;
      }
      const next = await this.processOne(job.id, 'worker');
      if (!next) continue;
      processed += 1;
      if (next.status === 'SUCCEEDED') succeeded += 1;
      if (next.status === 'FAILED') failed += 1;
    }
    const sweptRetired = await this.sweepRetiredStoredJobs(batchLimit, now);
    processed += sweptRetired;
    failed += sweptRetired;
    return { processed, succeeded, failed };
  }

  async processOne(
    id: string,
    origin: PublisherSyncProcessingOrigin = 'manual',
  ): Promise<PublisherSyncJob | null> {
    const job = await this.prisma.publisherSyncJob.findUnique({ where: { id } });
    if (!job) return null;
    if (
      job.status === 'SUCCEEDED'
      || job.status === 'SUPERSEDED'
      || job.status.endsWith('_RETIRED')
    ) return job;
    if (job.attempts >= job.maxAttempts) return job;

    const leaseAcquiredAt = new Date();
    const leaseExpiredBefore = new Date(leaseAcquiredAt.getTime() - this.processingLeaseMs);
    const claimed = await this.prisma.publisherSyncJob.updateMany({
      where: {
        id,
        attempts: job.attempts,
        OR: [
          { status: { in: ['PENDING', 'FAILED'] } },
          {
            status: 'PROCESSING',
            OR: [
              { lockedAt: null },
              { lockedAt: { lte: leaseExpiredBefore } },
            ],
          },
        ],
      },
      data: {
        status: 'PROCESSING',
        lockedAt: leaseAcquiredAt,
      },
    });
    if (claimed.count === 0) {
      this.recordRetryWorkerOutcome(origin, 'skipped');
      return this.prisma.publisherSyncJob.findUnique({ where: { id } });
    }

    const retired = await this.terminalizeRetiredStoredJob({
      ...job,
      status: 'PROCESSING',
      lockedAt: leaseAcquiredAt,
    });
    if (retired) {
      this.recordRetryWorkerOutcome(origin, retired.applied ? 'retired' : 'skipped');
      return retired.job;
    }

    let admissionAcceptedResponse: PublisherAcceptedResponse | null = null;
    try {
      const namespace = this.requestNamespace(job.namespace);
      const path = this.requestPath(job.path);
      const receiptRequired = this.admissionReceiptRequired({
        namespace,
        method: job.method,
        path,
        body: this.requestBody(job.body),
      });
      admissionAcceptedResponse = receiptRequired
        ? this.storedAcceptedResponse(job.response)
        : null;
      const response = admissionAcceptedResponse ?? await this.publisher.request(
          namespace,
          job.method as PublisherHttpMethod,
          path,
          this.requestBody(job.body),
          {
            idempotencyKey: job.idempotencyKey,
            requestId: job.requestId ?? undefined,
          },
        );

      if (response === null) {
        const pending = await this.finalizeClaim(id, leaseAcquiredAt, {
          status: 'PENDING',
          lockedAt: null,
          lastError: this.publisherUnavailableMessage,
          nextRunAt: this.delayFromNow(5 * 60 * 1000),
        });
        this.recordPersistedRetryWorkerOutcome(
          origin,
          pending.job,
          pending.applied,
          'PENDING',
          'publisher_unavailable',
        );
        return pending.job;
      }

      admissionAcceptedResponse = receiptRequired ? response : null;
      let completedResponse = response;
      if (receiptRequired) {
        const receipt = await this.readAdmissionDelivery(
          this.requiredAdmissionBatchId(response),
          job.requestId ?? undefined,
          true,
        );
        completedResponse = { ...response, key_admission_delivery: receipt };
        if (receipt.status === 'pending') {
          throw new PublisherClientError(
            `Publisher key admission delivery is pending batch_id=${receipt.batch_id}`,
            503,
            'KEY_ADMISSION_RECEIPT_PENDING',
            receipt,
            true,
          );
        }
        if (receipt.status === 'superseded') {
          const supersededError = this.admissionDeliveryFailure(
            receipt,
            'KEY_ADMISSION_SUPERSEDED',
            `Publisher key admission decision was superseded batch_id=${receipt.batch_id}`,
          );
          const superseded = await this.finalizeClaim(id, leaseAcquiredAt, {
            status: 'SUPERSEDED',
            response: this.jsonValue(completedResponse),
            attempts: job.attempts,
            lastError: this.errorMessage(supersededError),
            lockedAt: null,
            nextRunAt: new Date(),
            processedAt: new Date(),
          });
          this.recordPersistedRetryWorkerOutcome(
            origin,
            superseded.job,
            superseded.applied,
            'SUPERSEDED',
            'superseded',
          );
          return superseded.job;
        }
      }
      const succeeded = await this.finalizeClaim(id, leaseAcquiredAt, {
        status: 'SUCCEEDED',
        response: this.jsonValue(completedResponse),
        lastError: null,
        lockedAt: null,
        processedAt: new Date(),
      });
      this.recordPersistedRetryWorkerOutcome(
        origin,
        succeeded.job,
        succeeded.applied,
        'SUCCEEDED',
        'succeeded',
      );
      return succeeded.job;
    } catch (err) {
      const failure = this.failureMetadata(err);
      const attempts = failure.retryable ? job.attempts + 1 : job.maxAttempts;
      const hasMoreAttempts = failure.retryable && attempts < job.maxAttempts;
      const failedResponse = admissionAcceptedResponse
        ? this.responseWithAdmissionReceipt(admissionAcceptedResponse, err)
        : null;
      const updated = await this.finalizeClaim(id, leaseAcquiredAt, {
        status: 'FAILED',
        attempts,
        lastError: failure.message,
        ...(failedResponse
          ? { response: this.jsonValue(failedResponse) }
          : {}),
        lockedAt: null,
        nextRunAt: hasMoreAttempts ? this.nextRunAt(attempts) : new Date(),
        processedAt: hasMoreAttempts ? null : new Date(),
      });
      if (!hasMoreAttempts) {
        this.logger.warn(
          failure.retryable
            ? `publisher sync job exhausted id=${job.id} path=${job.path}`
            : `publisher sync job rejected permanently id=${job.id} path=${job.path}: ${failure.message}`,
        );
      }
      this.recordPersistedRetryWorkerOutcome(
        origin,
        updated.job,
        updated.applied,
        'FAILED',
        hasMoreAttempts
          ? 'retryable_failed'
          : failure.retryable
            ? 'exhausted'
            : 'permanent_failed',
      );
      return updated.job;
    }
  }

  async refreshRetryBacklogMetrics(): Promise<void> {
    try {
      const snapshot = await this.prisma.publisherSyncJob.aggregate({
        where: {
          OR: [
            { status: 'PENDING' },
            { status: 'FAILED', processedAt: null },
            { status: 'PROCESSING' },
          ],
        },
        _count: { _all: true },
        _min: { createdAt: true },
      });
      const backlog = snapshot._count._all;
      const oldestCreatedAt = snapshot._min.createdAt;
      const oldestAgeSeconds = oldestCreatedAt
        ? Math.max(0, (Date.now() - oldestCreatedAt.getTime()) / 1000)
        : 0;
      publisherRetryBacklog.set(backlog);
      publisherRetryBacklogOldestAgeSeconds.set(oldestAgeSeconds);
    } catch (err) {
      // This sample is observational only. Publisher delivery and retry state
      // have already been persisted independently of metrics collection.
      publisherRetryWorkerTotal.labels('metrics_query_failed').inc();
      this.logger.warn(
        `publisher retry backlog metrics query failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private recordPersistedRetryWorkerOutcome(
    origin: PublisherSyncProcessingOrigin,
    job: PublisherSyncJob | null,
    applied: boolean,
    expectedStatus: string,
    outcome: PublisherRetryWorkerOutcome,
  ): void {
    this.recordRetryWorkerOutcome(
      origin,
      applied && job?.status === expectedStatus ? outcome : 'skipped',
    );
  }

  private recordRetryWorkerOutcome(
    origin: PublisherSyncProcessingOrigin,
    outcome: PublisherRetryWorkerOutcome,
  ): void {
    if (origin === 'worker') publisherRetryWorkerTotal.labels(outcome).inc();
  }

  private async finalizeClaim(
    id: string,
    leaseAcquiredAt: Date,
    data: Prisma.PublisherSyncJobUpdateManyMutationInput,
  ): Promise<{ job: PublisherSyncJob | null; applied: boolean }> {
    const finalized = await this.prisma.publisherSyncJob.updateMany({
      where: {
        id,
        status: 'PROCESSING',
        lockedAt: leaseAcquiredAt,
      },
      data,
    });
    if (finalized.count !== 1) {
      this.logger.warn(
        `publisher sync job lease lost before result write id=${id} lease=${leaseAcquiredAt.toISOString()}`,
      );
    }
    return {
      job: await this.prisma.publisherSyncJob.findUnique({ where: { id } }),
      applied: finalized.count === 1,
    };
  }

  private async recordSucceeded(
    input: PublisherSyncDispatchInput,
    idempotencyKey: string,
    response: PublisherAcceptedResponse,
  ): Promise<void> {
    const existing = await this.prisma.publisherSyncJob.findUnique({ where: { idempotencyKey } });
    if (existing?.status === 'SUPERSEDED') return;
    const data = {
      namespace: input.namespace,
      method: input.method,
      path: input.path,
      body: this.jsonValue(input.body),
      status: 'SUCCEEDED',
      attempts: existing?.attempts ?? 0,
      maxAttempts: input.maxAttempts ?? existing?.maxAttempts ?? this.defaultMaxAttempts,
      requestId: input.requestId ?? existing?.requestId ?? null,
      source: input.source ?? existing?.source ?? null,
      resourceType: input.resourceType ?? existing?.resourceType ?? null,
      resourceId: input.resourceId ?? existing?.resourceId ?? null,
      lastError: null,
      response: this.jsonValue(response),
      nextRunAt: new Date(),
      lockedAt: null,
      processedAt: new Date(),
    } satisfies Prisma.PublisherSyncJobUpdateInput;

    if (existing) {
      await this.prisma.publisherSyncJob.updateMany({
        where: { id: existing.id, status: { not: 'SUPERSEDED' } },
        data,
      });
      return;
    }

    try {
      await this.prisma.publisherSyncJob.create({
        data: {
          idempotencyKey,
          ...data,
        } satisfies Prisma.PublisherSyncJobCreateInput,
      });
    } catch (createErr) {
      if (this.isUniqueViolation(createErr)) {
        await this.prisma.publisherSyncJob.updateMany({
          where: { idempotencyKey, status: { not: 'SUPERSEDED' } },
          data,
        });
        return;
      }
      throw createErr;
    }
  }

  private async recordFailedAttempt(
    input: PublisherSyncDispatchInput,
    idempotencyKey: string,
    err: unknown,
    acceptedResponse?: PublisherAcceptedResponse,
  ): Promise<void> {
    const existing = await this.prisma.publisherSyncJob.findUnique({ where: { idempotencyKey } });
    if (existing?.status === 'SUCCEEDED' || existing?.status === 'SUPERSEDED') return;
    const maxAttempts = input.maxAttempts ?? existing?.maxAttempts ?? this.defaultMaxAttempts;
    const failure = this.failureMetadata(err);
    const attempts = failure.retryable ? (existing?.attempts ?? 0) + 1 : maxAttempts;
    const hasMoreAttempts = failure.retryable && attempts < maxAttempts;
    const data = {
      namespace: input.namespace,
      method: input.method,
      path: input.path,
      body: this.jsonValue(input.body),
      status: 'FAILED',
      attempts,
      maxAttempts,
      requestId: input.requestId ?? existing?.requestId ?? null,
      source: input.source ?? existing?.source ?? null,
      resourceType: input.resourceType ?? existing?.resourceType ?? null,
      resourceId: input.resourceId ?? existing?.resourceId ?? null,
      lastError: failure.message,
      response: acceptedResponse
        ? this.jsonValue(acceptedResponse)
        : existing?.response ?? Prisma.DbNull,
      nextRunAt: hasMoreAttempts ? this.nextRunAt(attempts) : new Date(),
      lockedAt: null,
      processedAt: hasMoreAttempts ? null : new Date(),
    } satisfies Prisma.PublisherSyncJobUpdateInput;

    if (existing) {
      await this.prisma.publisherSyncJob.updateMany({
        where: { id: existing.id, status: { notIn: ['SUCCEEDED', 'SUPERSEDED'] } },
        data,
      });
      return;
    }

    try {
      await this.prisma.publisherSyncJob.create({
        data: {
          idempotencyKey,
          ...data,
        } satisfies Prisma.PublisherSyncJobCreateInput,
      });
    } catch (createErr) {
      if (this.isUniqueViolation(createErr)) {
        await this.prisma.publisherSyncJob.updateMany({
          where: { idempotencyKey, status: { notIn: ['SUCCEEDED', 'SUPERSEDED'] } },
          data,
        });
        return;
      }
      throw createErr;
    }
  }

  private async recordAdmissionPending(
    input: PublisherSyncDispatchInput,
    idempotencyKey: string,
    response: PublisherAcceptedResponse,
  ): Promise<void> {
    const existing = await this.prisma.publisherSyncJob.findUnique({ where: { idempotencyKey } });
    if (existing?.status === 'SUCCEEDED' || existing?.status === 'SUPERSEDED') return;
    const attempts = existing?.attempts ?? 0;
    const data = {
      namespace: input.namespace,
      method: input.method,
      path: input.path,
      body: this.jsonValue(input.body),
      status: 'PENDING',
      attempts,
      maxAttempts: input.maxAttempts ?? existing?.maxAttempts ?? this.defaultMaxAttempts,
      requestId: input.requestId ?? existing?.requestId ?? null,
      source: input.source ?? existing?.source ?? null,
      resourceType: input.resourceType ?? existing?.resourceType ?? null,
      resourceId: input.resourceId ?? existing?.resourceId ?? null,
      lastError: null,
      response: this.jsonValue(response),
      nextRunAt: this.nextRunAt(Math.max(1, attempts + 1)),
      lockedAt: null,
      processedAt: null,
    } satisfies Prisma.PublisherSyncJobUpdateInput;

    if (existing) {
      await this.prisma.publisherSyncJob.updateMany({
        where: { id: existing.id, status: { notIn: ['SUCCEEDED', 'SUPERSEDED'] } },
        data,
      });
      return;
    }
    try {
      await this.prisma.publisherSyncJob.create({
        data: { idempotencyKey, ...data } satisfies Prisma.PublisherSyncJobCreateInput,
      });
    } catch (createErr) {
      if (this.isUniqueViolation(createErr)) {
        await this.prisma.publisherSyncJob.updateMany({
          where: { idempotencyKey, status: { notIn: ['SUCCEEDED', 'SUPERSEDED'] } },
          data,
        });
        return;
      }
      throw createErr;
    }
  }

  private async recordSuperseded(
    input: PublisherSyncDispatchInput,
    idempotencyKey: string,
    response: PublisherAcceptedResponse,
    lastError: string,
  ): Promise<void> {
    const existing = await this.prisma.publisherSyncJob.findUnique({ where: { idempotencyKey } });
    if (existing?.status === 'SUCCEEDED' || existing?.status === 'SUPERSEDED') return;
    const data = {
      namespace: input.namespace,
      method: input.method,
      path: input.path,
      body: this.jsonValue(input.body),
      status: 'SUPERSEDED',
      attempts: existing?.attempts ?? 0,
      maxAttempts: input.maxAttempts ?? existing?.maxAttempts ?? this.defaultMaxAttempts,
      requestId: input.requestId ?? existing?.requestId ?? null,
      source: input.source ?? existing?.source ?? null,
      resourceType: input.resourceType ?? existing?.resourceType ?? null,
      resourceId: input.resourceId ?? existing?.resourceId ?? null,
      lastError,
      response: this.jsonValue(response),
      nextRunAt: new Date(),
      lockedAt: null,
      processedAt: new Date(),
    } satisfies Prisma.PublisherSyncJobUpdateInput;

    if (existing) {
      await this.prisma.publisherSyncJob.updateMany({
        where: { id: existing.id, status: { notIn: ['SUCCEEDED', 'SUPERSEDED'] } },
        data,
      });
      return;
    }
    try {
      await this.prisma.publisherSyncJob.create({
        data: { idempotencyKey, ...data } satisfies Prisma.PublisherSyncJobCreateInput,
      });
    } catch (createErr) {
      if (this.isUniqueViolation(createErr)) {
        await this.prisma.publisherSyncJob.updateMany({
          where: { idempotencyKey, status: { notIn: ['SUCCEEDED', 'SUPERSEDED'] } },
          data,
        });
        return;
      }
      throw createErr;
    }
  }

  private async recordPendingConfiguration(
    input: PublisherSyncDispatchInput,
    idempotencyKey: string,
  ): Promise<void> {
    const existing = await this.prisma.publisherSyncJob.findUnique({ where: { idempotencyKey } });
    if (existing?.status === 'SUCCEEDED' || existing?.status === 'SUPERSEDED') return;

    const maxAttempts = input.maxAttempts ?? existing?.maxAttempts ?? this.defaultMaxAttempts;
    const data = {
      namespace: input.namespace,
      method: input.method,
      path: input.path,
      body: this.jsonValue(input.body),
      status: 'PENDING',
      attempts: existing?.attempts ?? 0,
      maxAttempts,
      requestId: input.requestId ?? existing?.requestId ?? null,
      source: input.source ?? existing?.source ?? null,
      resourceType: input.resourceType ?? existing?.resourceType ?? null,
      resourceId: input.resourceId ?? existing?.resourceId ?? null,
      lastError: this.publisherUnavailableMessage,
      response: existing?.response ?? Prisma.DbNull,
      nextRunAt: this.delayFromNow(5 * 60 * 1000),
      lockedAt: null,
      processedAt: null,
    } satisfies Prisma.PublisherSyncJobUpdateInput;

    if (existing) {
      await this.prisma.publisherSyncJob.updateMany({
        where: { id: existing.id, status: { notIn: ['SUCCEEDED', 'SUPERSEDED'] } },
        data,
      });
      return;
    }

    try {
      await this.prisma.publisherSyncJob.create({
        data: {
          idempotencyKey,
          ...data,
        } satisfies Prisma.PublisherSyncJobCreateInput,
      });
    } catch (createErr) {
      if (this.isUniqueViolation(createErr)) {
        await this.prisma.publisherSyncJob.updateMany({
          where: { idempotencyKey, status: { notIn: ['SUCCEEDED', 'SUPERSEDED'] } },
          data,
        });
        return;
      }
      throw createErr;
    }
  }

  private jsonValue(value: unknown): Prisma.InputJsonValue | typeof Prisma.JsonNull | typeof Prisma.DbNull | undefined {
    if (value === undefined) return undefined;
    if (value === null) return Prisma.JsonNull;
    return value as Prisma.InputJsonValue;
  }

  private requestBody(value: Prisma.JsonValue | null): unknown | undefined {
    return value === null ? undefined : value;
  }

  private isKeyAdmissionMutation(input: {
    namespace: string;
    method: string;
    path: string;
  }): boolean {
    if (input.namespace !== 'billing') return false;
    const path = input.path.split(/[?#]/, 1)[0].replace(/\/+$/, '');
    return (input.method === 'PUT' || input.method === 'DELETE')
      && /^\/billing\/api\/v1\/key-balance\/[^/]+$/.test(path);
  }

  private admissionReceiptRequired(input: {
    namespace: string;
    method: string;
    path: string;
    body?: unknown;
  }): boolean {
    if (!this.isKeyAdmissionMutation(input)) return false;
    if (input.method === 'DELETE') return true;
    if (!input.body || typeof input.body !== 'object' || Array.isArray(input.body)) return true;
    const body = input.body as Record<string, unknown>;
    if (body.has_balance === false) return true;
    if (Array.isArray(body.items)) {
      return body.items.some((item) => (
        item !== null
        && typeof item === 'object'
        && !Array.isArray(item)
        && (item as Record<string, unknown>).has_balance === false
      ));
    }
    return false;
  }

  private async withVerifiedAdmissionDelivery(
    response: PublisherAcceptedResponse,
    requestId?: string,
  ): Promise<PublisherAcceptedResponse> {
    const batchId = this.requiredAdmissionBatchId(response);
    const receipt = await this.waitForAdmissionDelivery(batchId, requestId);
    return { ...response, key_admission_delivery: receipt };
  }

  private requiredAdmissionBatchId(response: unknown): string {
    const batchId = response
      && typeof response === 'object'
      && !Array.isArray(response)
      && typeof (response as Record<string, unknown>).batch_id === 'string'
      ? (response as Record<string, string>).batch_id.trim()
      : '';
    if (batchId) return batchId;
    throw new PublisherClientError(
      'Publisher key admission response is missing batch_id',
      502,
      'KEY_ADMISSION_BATCH_ID_MISSING',
      response,
      false,
    );
  }

  private storedAcceptedResponse(value: Prisma.JsonValue | null): PublisherAcceptedResponse | null {
    if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
    const response = value as Record<string, unknown>;
    return response.status === 'accepted'
      && typeof response.batch_id === 'string'
      && response.batch_id.trim() !== ''
      ? value as unknown as PublisherAcceptedResponse
      : null;
  }

  private responseWithAdmissionReceipt(
    response: PublisherAcceptedResponse,
    err: unknown,
  ): PublisherAcceptedResponse {
    if (!(err instanceof PublisherClientError) || !this.isAdmissionDeliveryReceipt(err.details)) {
      return response;
    }
    return { ...response, key_admission_delivery: err.details };
  }

  private isAdmissionDeliveryReceipt(value: unknown): value is PublisherKeyAdmissionDeliveryReceipt {
    try {
      this.requiredAdmissionDeliveryReceipt(value);
      return true;
    } catch {
      return false;
    }
  }

  private requiredAdmissionDeliveryReceipt(value: unknown): PublisherKeyAdmissionDeliveryReceipt {
    const invalid = (reason: string): never => {
      throw new PublisherClientError(
        `Publisher key admission receipt violates its contract: ${reason}`,
        502,
        'KEY_ADMISSION_RECEIPT_INVALID',
        undefined,
        false,
      );
    };
    if (!value || typeof value !== 'object' || Array.isArray(value)) {
      return invalid('response must be an object');
    }
    const receipt = value as Record<string, unknown>;
    const statuses = new Set([
      'pending',
      'applied',
      'idempotent',
      'superseded',
      'conflict',
      'dead_letter',
      'unverified',
      'mixed',
    ]);
    if (typeof receipt.batch_id !== 'string' || receipt.batch_id.trim() === '') {
      return invalid('batch_id must be a nonempty string');
    }
    if (typeof receipt.status !== 'string' || !statuses.has(receipt.status)) {
      return invalid('status is unknown');
    }
    if (receipt.last_error !== undefined && typeof receipt.last_error !== 'string') {
      return invalid('last_error must be a string when present');
    }
    const countFields = [
      'pending_count',
      'applied_count',
      'idempotent_count',
      'superseded_count',
      'conflict_count',
      'dead_letter_count',
      'unverified_count',
    ] as const;
    if (!Number.isSafeInteger(receipt.total) || Number(receipt.total) <= 0) {
      return invalid('total must be a positive safe integer');
    }
    for (const field of countFields) {
      if (!Number.isSafeInteger(receipt[field]) || Number(receipt[field]) < 0) {
        return invalid(`${field} must be a nonnegative safe integer`);
      }
    }
    const total = Number(receipt.total);
    const count = (field: typeof countFields[number]): number => Number(receipt[field]);
    if (countFields.reduce((sum, field) => sum + count(field), 0) !== total) {
      return invalid('outcome counts must sum to total');
    }

    const terminalKinds = [
      count('applied_count'),
      count('idempotent_count'),
      count('superseded_count'),
    ].filter((entry) => entry > 0).length;
    const expectedStatus = count('dead_letter_count') > 0
      ? 'dead_letter'
      : count('pending_count') > 0
        ? 'pending'
        : count('unverified_count') > 0
          ? 'unverified'
          : count('conflict_count') > 0
            ? 'conflict'
            : terminalKinds > 1
              ? 'mixed'
              : count('applied_count') > 0
                ? 'applied'
                : count('idempotent_count') > 0
                  ? 'idempotent'
                  : count('superseded_count') > 0
                    ? 'superseded'
                    : null;
    if (receipt.status !== expectedStatus) {
      return invalid(`status=${receipt.status} is inconsistent with outcome counts`);
    }
    return value as PublisherKeyAdmissionDeliveryReceipt;
  }

  private async waitForAdmissionDelivery(
    batchId: string,
    requestId?: string,
  ): Promise<PublisherKeyAdmissionDeliveryReceipt> {
    const deadline = Date.now() + this.admissionReceiptTimeoutMs;
    let lastTransientError: unknown;
    let pollDelayMs = this.admissionReceiptPollIntervalMs;
    while (true) {
      try {
        const receipt = await this.readAdmissionDelivery(batchId, requestId, false);
        if (receipt.status === 'pending') {
          lastTransientError = new Error(
            `Publisher key admission delivery is pending batch_id=${batchId}`,
          );
        } else {
          return receipt;
        }
      } catch (err) {
        if (err instanceof PublisherClientError && err.retryable === false) throw err;
        if (err instanceof PublisherClientError && err.status < 500 && err.status !== 404) throw err;
        lastTransientError = err;
      }

      const remainingMs = deadline - Date.now();
      if (remainingMs <= 0) {
        throw new PublisherClientError(
          `Timed out waiting for Publisher key admission delivery batch_id=${batchId}`,
          504,
          'KEY_ADMISSION_RECEIPT_TIMEOUT',
          lastTransientError ? { last_error: this.errorMessage(lastTransientError) } : undefined,
          true,
        );
      }
      await new Promise<void>((resolve) => {
        setTimeout(resolve, Math.min(pollDelayMs, remainingMs));
      });
      pollDelayMs = Math.min(pollDelayMs * 2, 1_000);
    }
  }

  private async readAdmissionDelivery(
    batchId: string,
    requestId: string | undefined,
    acceptSuperseded: boolean,
  ): Promise<PublisherKeyAdmissionDeliveryReceipt> {
    let receipt: PublisherKeyAdmissionDeliveryReceipt | null;
    try {
      receipt = await this.publisher.getKeyAdmissionDelivery(batchId, { requestId });
    } catch (err) {
      if (err instanceof PublisherClientError && err.status === 404) {
        throw new PublisherClientError(
          `Publisher key admission receipt is not visible yet batch_id=${batchId}`,
          503,
          'KEY_ADMISSION_RECEIPT_NOT_FOUND',
          err.details,
          true,
        );
      }
      throw err;
    }
    if (receipt === null) {
      throw new PublisherClientError(
        'Publisher is unavailable while reading key admission delivery',
        503,
        'KEY_ADMISSION_RECEIPT_UNAVAILABLE',
        undefined,
        true,
      );
    }
    receipt = this.requiredAdmissionDeliveryReceipt(receipt);
    if (receipt.batch_id !== batchId) {
      throw this.admissionDeliveryFailure(
        receipt,
        'KEY_ADMISSION_RECEIPT_BATCH_MISMATCH',
        `Publisher key admission receipt batch mismatch: expected=${batchId} actual=${receipt.batch_id}`,
      );
    }
    if (receipt.status === 'pending') return receipt;
    if (
      receipt.status === 'applied'
      || receipt.status === 'idempotent'
      || receipt.status === 'mixed'
    ) {
      this.assertSuccessfulAdmissionReceipt(receipt);
      return receipt;
    }
    if (receipt.status === 'superseded' && acceptSuperseded) {
      this.assertSupersededAdmissionReceipt(receipt);
      return receipt;
    }
    throw this.admissionDeliveryFailure(
      receipt,
      `KEY_ADMISSION_${receipt.status.toUpperCase()}`,
      receipt.status === 'superseded'
        ? `Publisher key admission decision was superseded; recompute a fresh decision batch_id=${batchId}`
        : `Publisher key admission delivery failed status=${receipt.status} batch_id=${batchId}`,
    );
  }

  private assertSuccessfulAdmissionReceipt(receipt: PublisherKeyAdmissionDeliveryReceipt): void {
    const failedCount = receipt.pending_count
      + receipt.superseded_count
      + receipt.conflict_count
      + receipt.dead_letter_count
      + receipt.unverified_count;
    const successfulCount = receipt.applied_count + receipt.idempotent_count;
    if (
      !Number.isSafeInteger(receipt.total)
      || receipt.total <= 0
      || failedCount !== 0
      || successfulCount !== receipt.total
    ) {
      throw this.admissionDeliveryFailure(
        receipt,
        'KEY_ADMISSION_RECEIPT_INCONSISTENT',
        `Publisher key admission receipt is inconsistent batch_id=${receipt.batch_id}`,
      );
    }
  }

  private assertSupersededAdmissionReceipt(receipt: PublisherKeyAdmissionDeliveryReceipt): void {
    const otherCount = receipt.pending_count
      + receipt.applied_count
      + receipt.idempotent_count
      + receipt.conflict_count
      + receipt.dead_letter_count
      + receipt.unverified_count;
    if (
      !Number.isSafeInteger(receipt.total)
      || receipt.total <= 0
      || otherCount !== 0
      || receipt.superseded_count !== receipt.total
    ) {
      throw this.admissionDeliveryFailure(
        receipt,
        'KEY_ADMISSION_RECEIPT_INCONSISTENT',
        `Publisher superseded admission receipt is inconsistent batch_id=${receipt.batch_id}`,
      );
    }
  }

  private admissionDeliveryFailure(
    receipt: PublisherKeyAdmissionDeliveryReceipt,
    code: string,
    message: string,
  ): PublisherClientError {
    return new PublisherClientError(message, 409, code, receipt, false);
  }

  private assertPublisherRequestAllowed(input: {
    method: string;
    path: string;
    body?: unknown;
    resourceType?: string | null;
  }): void {
    const retirement = retiredPublisherRequest(input);
    if (!retirement) return;
    throw new BadRequestException({
      code: retirement.code,
      message: retirement.message,
    });
  }

  private async terminalizeRetiredStoredJob(
    job: PublisherSyncJob,
    now = new Date(),
  ): Promise<{ job: PublisherSyncJob; applied: boolean } | null> {
    const retirement = retiredPublisherRequest(job);
    if (!retirement) return null;

    // A historical success is immutable audit evidence. It must never be
    // replayed, but retirement must not rewrite its successful outcome.
    if (job.status === 'SUCCEEDED' || job.status.endsWith('_RETIRED')) {
      return { job, applied: false };
    }

    const lastError = job.lastError && job.lastError !== retirement.error
      ? `${retirement.error}\nprevious_error: ${job.lastError}`
      : retirement.error;
    const terminalized = await this.prisma.publisherSyncJob.updateMany({
      where: {
        id: job.id,
        status: job.status,
        attempts: job.attempts,
        lockedAt: job.lockedAt,
        processedAt: job.processedAt,
      },
      data: {
        status: retirement.code,
        attempts: job.maxAttempts,
        lastError,
        lockedAt: null,
        nextRunAt: now,
        processedAt: now,
      },
    });
    const persisted = await this.prisma.publisherSyncJob.findUnique({
      where: { id: job.id },
    });
    if (terminalized.count === 1) {
      this.logger.warn(`${retirement.error} id=${job.id} path=${job.path}`);
    }
    return {
      job: persisted ?? {
        ...job,
        status: terminalized.count === 1 ? retirement.code : job.status,
        attempts: terminalized.count === 1 ? job.maxAttempts : job.attempts,
        lastError: terminalized.count === 1 ? lastError : job.lastError,
        lockedAt: terminalized.count === 1 ? null : job.lockedAt,
        nextRunAt: terminalized.count === 1 ? now : job.nextRunAt,
        processedAt: terminalized.count === 1 ? now : job.processedAt,
      },
      applied: terminalized.count === 1,
    };
  }

  private async sweepRetiredStoredJobs(limit: number, now: Date): Promise<number> {
    if (limit <= 0) return 0;
    const candidates = await this.prisma.publisherSyncJob.findMany({
      where: {
        status: { in: ['PENDING', 'FAILED'] },
        ...(this.retirementSweepAfterId
          ? { id: { gt: this.retirementSweepAfterId } }
          : {}),
      },
      orderBy: { id: 'asc' },
      take: limit,
    }) ?? [];
    if (candidates.length === 0) {
      this.retirementSweepAfterId = undefined;
      return 0;
    }
    this.retirementSweepAfterId = candidates.length < limit
      ? undefined
      : candidates[candidates.length - 1].id;

    let retiredCount = 0;
    for (const candidate of candidates) {
      const retired = await this.terminalizeRetiredStoredJob(candidate, now);
      if (!retired?.applied) continue;
      publisherRetryWorkerTotal.labels('retired').inc();
      retiredCount += 1;
    }
    return retiredCount;
  }

  private async terminalizeExhaustedStoredJob(
    job: PublisherSyncJob,
    now: Date,
  ): Promise<boolean> {
    const finalized = await this.prisma.publisherSyncJob.updateMany({
      where: {
        id: job.id,
        status: job.status,
        attempts: job.attempts,
        lockedAt: job.lockedAt,
        processedAt: job.processedAt,
      },
      data: {
        status: 'FAILED',
        lockedAt: null,
        nextRunAt: now,
        processedAt: now,
        lastError: job.lastError ?? 'Publisher 同步任务已耗尽重试次数',
      },
    });
    if (finalized.count === 1) {
      this.logger.warn(
        `publisher sync job was already exhausted; terminalized id=${job.id} path=${job.path}`,
      );
    }
    return finalized.count === 1;
  }

  private namespaceFilter(namespace: string): string[] {
    if (namespace === 'user') return ['user', 'portal'];
    if (namespace === 'admin') return ['admin', 'ops'];
    return [namespace];
  }

  private requestNamespace(namespace: string): PublisherNamespace {
    if (namespace === 'portal') return 'user';
    if (namespace === 'ops') return 'admin';
    if (['user', 'billing', 'admin', 'sre'].includes(namespace)) return namespace as PublisherNamespace;
    throw new BadRequestException(`不支持的 Publisher namespace: ${namespace}`);
  }

  private requestPath(path: string): string {
    if (path.startsWith('/portal/api/v1/')) {
      return `/user/api/v1/${path.slice('/portal/api/v1/'.length)}`;
    }
    if (path.startsWith('/ops/api/v1/')) {
      return `/admin/api/v1/${path.slice('/ops/api/v1/'.length)}`;
    }
    return path;
  }

  private nextRunAt(attempts: number): Date {
    const baseMs = 60_000;
    const delayMs = Math.min(baseMs * (2 ** Math.max(0, attempts - 1)), 30 * 60_000);
    return this.delayFromNow(delayMs);
  }

  private delayFromNow(delayMs: number): Date {
    return new Date(Date.now() + delayMs);
  }

  private resolveProcessingLeaseMs(): number {
    const defaultLeaseSeconds = 5 * 60;
    const raw = this.config?.get<string | number>('PUBLISHER_SYNC_JOB_LEASE_SECONDS');
    if (raw === undefined || raw === null || raw === '') {
      return defaultLeaseSeconds * 1000;
    }
    const seconds = Number(raw);
    if (
      !Number.isSafeInteger(seconds) ||
      seconds <= 0 ||
      seconds > Math.floor(Number.MAX_SAFE_INTEGER / 1000)
    ) {
      this.logger.warn(
        `invalid PUBLISHER_SYNC_JOB_LEASE_SECONDS=${String(raw)}; using ${defaultLeaseSeconds}`,
      );
      return defaultLeaseSeconds * 1000;
    }
    return seconds * 1000;
  }

  private resolvePositiveMilliseconds(key: string, fallback: number, maximum: number): number {
    const raw = this.config?.get<string | number>(key);
    if (raw === undefined || raw === null || raw === '') return fallback;
    const value = Number(raw);
    if (!Number.isSafeInteger(value) || value <= 0 || value > maximum) {
      this.logger.warn(`invalid ${key}=${String(raw)}; using ${fallback}`);
      return fallback;
    }
    return value;
  }

  private failureMetadata(err: unknown): {
    message: string;
    retryable: boolean;
    publisherStatus?: number;
    errorCode?: string;
  } {
    return {
      message: this.errorMessage(err),
      retryable: this.isRetryableFailure(err),
      publisherStatus: err instanceof PublisherClientError ? err.status : undefined,
      errorCode: err instanceof PublisherClientError ? err.code : undefined,
    };
  }

  private isRetryableFailure(err: unknown): boolean {
    if (!(err instanceof PublisherClientError)) return true;
    if (err.retryable !== undefined) return err.retryable;
    if (err.status === 408 || err.status === 429) return true;
    if (err.status >= 500) return true;
    return false;
  }

  private errorMessage(err: unknown): string {
    if (err instanceof PublisherClientError) {
      const parts = [
        `status=${err.status}`,
        err.code ? `code=${err.code}` : '',
        err.message,
      ].filter(Boolean);
      const details = err.details ? ` details=${JSON.stringify(err.details)}` : '';
      return `${parts.join(' ')}${details}`.slice(0, 2000);
    }
    if (err instanceof BadRequestException) return err.message.slice(0, 2000);
    if (err instanceof Error) return err.message.slice(0, 2000);
    return String(err).slice(0, 2000);
  }

  private isUniqueViolation(err: unknown): boolean {
    return err instanceof Prisma.PrismaClientKnownRequestError && err.code === 'P2002';
  }
}
