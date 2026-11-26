import {
  BadRequestException,
  ConflictException,
  Injectable,
  NotFoundException,
} from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';

const LINE_TYPES = new Set(['MISSING_ANCHOR_REQUEST', 'PROVIDER_AGGREGATE']);
const MONEY_INPUT_KEYS = [
  'platformAmountBefore',
  'platformAmountCorrected',
  'customerAbsorbedDelta',
  'customerDeduction',
  'providerCostBefore',
  'providerCostCorrected',
  'providerCostDelta',
  'usageDelta',
];

type JsonObject = Record<string, unknown>;

export type HistoricalPlatformLossValuationBasisInput = {
  version?: unknown;
  rateUnit?: unknown;
  pricingCurrency?: unknown;
  customerRatePerMillion?: unknown;
  providerCostRatePerMillion?: unknown;
  pricingSourceRef?: unknown;
  pricingDocumentSha256?: unknown;
  pricingEvidenceHash?: unknown;
  pricingEffectiveFrom?: unknown;
  pricingEffectiveTo?: unknown;
  pricingApprovedBy?: unknown;
  pricingApprovedAt?: unknown;
  pricingEvidence?: unknown;
};

export type HistoricalPlatformLossLineInput = {
  lineType?: unknown;
  sourceRowRef?: unknown;
  sourceEvidence?: unknown;
  requestId?: unknown;
  upstreamRequestId?: unknown;
  providerAggregateRef?: unknown;
  serviceDate?: unknown;
  model?: unknown;
  meter?: unknown;
  platformUsage?: unknown;
  providerUsage?: unknown;
  valuationBasis?: HistoricalPlatformLossValuationBasisInput | unknown;
  [key: string]: unknown;
};

export type HistoricalPlatformLossBatchInput = {
  provider?: unknown;
  providerAccountRef?: unknown;
  region?: unknown;
  periodStart?: unknown;
  periodEnd?: unknown;
  currency?: unknown;
  sourceFileRef?: unknown;
  sourceFileSha256?: unknown;
  calculationMethod?: unknown;
  roundingPolicy?: unknown;
  exchangeRate?: unknown;
  exchangeRateSource?: unknown;
  exchangeRateSourceCurrency?: unknown;
  exchangeRateAsOf?: unknown;
  reason?: unknown;
  lines?: unknown;
  expectedFingerprint?: unknown;
  idempotencyKey?: unknown;
  [key: string]: unknown;
};

export type HistoricalPlatformLossPostCommand = {
  expectedRevision?: unknown;
  expectedFingerprint?: unknown;
  reason?: unknown;
  idempotencyKey?: unknown;
};

type CanonicalHeader = {
  provider: string;
  providerAccountRef: string;
  region: string;
  periodStart: Date;
  periodEnd: Date;
  currency: string;
  sourceFileRef: string;
  sourceFileSha256: string;
  calculationMethod: string;
  roundingPolicy: 'HALF_UP_12';
  exchangeRate: string | null;
  exchangeRateSource: string | null;
  exchangeRateSourceCurrency: string | null;
  exchangeRateAsOf: Date | null;
  reason: string;
};

type CanonicalLine = {
  lineNumber: number;
  lineType: 'MISSING_ANCHOR_REQUEST' | 'PROVIDER_AGGREGATE';
  gatewayBillingEventId: string | null;
  requestId: string | null;
  upstreamRequestId: string | null;
  providerAggregateRef: string | null;
  serviceDate: string;
  model: string;
  meter: string;
  platformUsage: string;
  providerUsage: string;
  usageDelta: string;
  valuationBasis: {
    version: string;
    rateUnit: 'TOKENS_PER_MILLION';
    pricingCurrency: string;
    customerRatePerMillion: string;
    providerCostRatePerMillion: string;
    pricingSourceRef: string;
    pricingDocumentSha256: string;
    pricingEvidenceHash: string;
    pricingEffectiveFrom: string;
    pricingEffectiveTo: string;
    pricingApprovedBy: string;
    pricingApprovedAt: string;
    pricingEvidence: JsonObject;
  };
  sourceRowRef: string;
  sourceEvidence: JsonObject;
  sourceRowHash: string;
  recognitionKeys: Array<{ type: string; key: string }>;
  platformAmountBefore: string;
  platformAmountCorrected: string;
  customerAbsorbedDelta: string;
  customerDeduction: '0.000000000000';
  providerCostBefore: string;
  providerCostCorrected: string;
  providerCostDelta: string;
  lineHash: string;
};

type PreviewIssue = {
  lineNumber?: number;
  code: string;
  message: string;
  action?: string;
  requestId?: string;
};

type PreviewTotals = {
  platformAmountBefore: string;
  platformAmountCorrected: string;
  customerAbsorbedDelta: string;
  customerDeduction: '0.000000000000';
  providerCostBefore: string;
  providerCostCorrected: string;
  providerCostDelta: string;
};

export type HistoricalPlatformLossPreview = CanonicalHeader & {
  exchangeRateDirection: 'BATCH_CURRENCY_PER_SOURCE_CURRENCY' | null;
  status: 'READY' | 'BLOCKED';
  fingerprint: string | null;
  itemCount: number;
  totals: PreviewTotals | null;
  lines: CanonicalLine[];
  issues: PreviewIssue[];
};

class LineBlockedError extends Error {
  constructor(readonly code: string, message: string, readonly action?: string) {
    super(message);
  }
}

@Injectable()
export class HistoricalPlatformLossBatchService {
  constructor(private readonly prisma: PrismaService) {}

  async preview(input: HistoricalPlatformLossBatchInput): Promise<HistoricalPlatformLossPreview> {
    const header = canonicalHeader(input);
    const rawLines = Array.isArray(input.lines) ? input.lines : [];
    if (rawLines.length === 0 || rawLines.length > 10_000) {
      throw new BadRequestException('lines 必须包含 1 到 10000 条来源行');
    }

    const issues: PreviewIssue[] = [];
    const lines: CanonicalLine[] = [];
    const seenRecognitionKeys = new Map<
      string,
      { lineNumber: number; requestId: string | null; type: string }
    >();
    const seenSourceRows = new Set<string>();

    for (let index = 0; index < rawLines.length; index += 1) {
      const lineNumber = index + 1;
      try {
        const raw = asObject(rawLines[index], `lines[${index}]`);
        for (const key of MONEY_INPUT_KEYS) {
          if (Object.prototype.hasOwnProperty.call(raw, key)) {
            throw new LineBlockedError(
              'SERVER_VALUATION_REQUIRED',
              `${key} 必须由 Billing 根据用量和冻结历史费率计算，不能由调用方提交`,
            );
          }
        }
        const line = await this.canonicalLine(header, raw, lineNumber);
        if (seenSourceRows.has(line.sourceRowHash)) {
          throw new LineBlockedError('DUPLICATE_SOURCE_ROW', '同一来源行在批次中重复出现');
        }
        seenSourceRows.add(line.sourceRowHash);
        for (const claim of line.recognitionKeys) {
          const previous = seenRecognitionKeys.get(claim.key);
          const isSameRequestDimension = Boolean(
            previous &&
            ['REQUEST_ID', 'UPSTREAM_REQUEST_ID'].includes(claim.type) &&
            previous.type === claim.type &&
            previous.requestId &&
            previous.requestId === line.requestId,
          );
          if (previous && !isSameRequestDimension) {
            throw new LineBlockedError(
              'DUPLICATE_RECOGNITION_IN_BATCH',
              `识别键已被第 ${previous.lineNumber} 行使用`,
            );
          }
          if (!previous) {
            seenRecognitionKeys.set(claim.key, {
              lineNumber,
              requestId: line.requestId,
              type: claim.type,
            });
          }
        }
        lines.push(line);
      } catch (error) {
        if (error instanceof LineBlockedError) {
          const raw = isObject(rawLines[index]) ? rawLines[index] : {};
          issues.push({
            lineNumber,
            code: error.code,
            message: error.message,
            ...(error.action ? { action: error.action } : {}),
            ...(typeof raw.requestId === 'string' ? { requestId: raw.requestId.trim() } : {}),
          });
          continue;
        }
        throw error;
      }
    }

    if (lines.length > 0) {
      const coverageByLine = lines.map((line) => ({
        line,
        coverage: usageLossCoverageIdentity(
          header.provider,
          header.providerAccountRef,
          header.region,
          line.serviceDate,
          line.model,
          line.meter,
        ),
        mode: line.lineType === 'PROVIDER_AGGREGATE' ? 'AGGREGATE' : 'REQUEST',
      } as const));
      const batchCoverageModes = new Map<string, { mode: string; lineNumber: number }>();
      for (const item of coverageByLine) {
        const previous = batchCoverageModes.get(item.coverage.coverageKey);
        if (previous && previous.mode !== item.mode) {
          issues.push({
            lineNumber: item.line.lineNumber,
            code: 'MIXED_COVERAGE_GRANULARITY_IN_BATCH',
            message: `同一 coverage 已由第 ${previous.lineNumber} 行按 ${previous.mode} 粒度使用，不得再按 ${item.mode} 粒度确认`,
          });
        } else if (!previous) {
          batchCoverageModes.set(item.coverage.coverageKey, {
            mode: item.mode,
            lineNumber: item.line.lineNumber,
          });
        }
      }
      const storedCoverageModes = await findUsageLossCoverageModes(
        this.prisma,
        [...new Set(coverageByLine.map((item) => item.coverage.coverageKey))],
      );
      for (const item of coverageByLine) {
        const storedMode = storedCoverageModes.get(item.coverage.coverageKey);
        if (storedMode && storedMode !== item.mode) {
          issues.push({
            lineNumber: item.line.lineNumber,
            code: 'CROSS_GRANULARITY_COVERAGE_ALREADY_CLAIMED',
            message: `该 coverage 已按 ${storedMode} 粒度确认，禁止再按 ${item.mode} 粒度重复吸收`,
            ...(item.line.requestId ? { requestId: item.line.requestId } : {}),
          });
        }
      }

      const allKeys = lines.flatMap((line) => line.recognitionKeys.map((claim) => claim.key));
      const existingClaims = allKeys.length > 0
        ? await this.prisma.usageLossRecognitionClaim.findMany({
          where: { recognitionKey: { in: allKeys } },
          select: { recognitionKey: true, claimSource: true },
        })
        : [];
      const claimed = new Map(existingClaims.map((claim) => [claim.recognitionKey, claim]));
      for (const line of lines) {
        const conflict = line.recognitionKeys.find((claim) => claimed.has(claim.key));
        if (conflict) {
          issues.push({
            lineNumber: line.lineNumber,
            code: 'RECOGNITION_ALREADY_CLAIMED',
            message: `该来源已由 ${claimed.get(conflict.key)?.claimSource ?? '其他流程'} 确认，禁止重复吸收`,
            ...(line.requestId ? { requestId: line.requestId } : {}),
          });
        }
      }
    }

    if (lines.length !== rawLines.length) {
      return {
        ...header,
        exchangeRateDirection: header.exchangeRate
          ? 'BATCH_CURRENCY_PER_SOURCE_CURRENCY'
          : null,
        status: 'BLOCKED',
        fingerprint: null,
        itemCount: rawLines.length,
        totals: null,
        lines,
        issues,
      };
    }

    const totals = totalLines(lines);
    if (new Prisma.Decimal(totals.customerAbsorbedDelta).lt(0)) {
      issues.push({
        code: 'NEGATIVE_BATCH_CUSTOMER_ABSORPTION',
        message: '批次最终客户吸收差额不得为负，请核对来源和冻结历史费率',
      });
    }
    if (
      new Prisma.Decimal(totals.customerAbsorbedDelta).eq(0) &&
      new Prisma.Decimal(totals.providerCostDelta).lte(0)
    ) {
      issues.push({
        code: 'NO_POSITIVE_PLATFORM_LOSS',
        message: '批次没有正向客户少计或供应商成本损失，不能作为平台损失入账',
      });
    }
    const fingerprint = batchFingerprint(header, lines, totals);
    return {
      ...header,
      exchangeRateDirection: header.exchangeRate
        ? 'BATCH_CURRENCY_PER_SOURCE_CURRENCY'
        : null,
      status: issues.length === 0 ? 'READY' : 'BLOCKED',
      fingerprint,
      itemCount: lines.length,
      totals,
      lines,
      issues,
    };
  }

  async create(
    input: HistoricalPlatformLossBatchInput,
    actorIdInput: string,
  ): Promise<Record<string, unknown>> {
    const actorId = requiredString(actorIdInput, 'actorId');
    const idempotencyKey = requiredString(input.idempotencyKey, 'idempotencyKey', 200);
    const expectedFingerprint = sha256String(input.expectedFingerprint, 'expectedFingerprint');
    requiredString(input.reason, 'reason', 1000);

    const replay = await this.prisma.historicalPlatformLossBatch.findUnique({
      where: { createIdempotencyKey: idempotencyKey },
      include: batchInclude,
    });
    if (replay) {
      if (replay.fingerprint !== expectedFingerprint || replay.makerActorId !== actorId) {
        throw new ConflictException('create idempotencyKey 已用于另一历史差额批次');
      }
      return serializeBatch(replay);
    }

    const preview = await this.preview(input);
    if (preview.status !== 'READY' || !preview.fingerprint || !preview.totals) {
      throw new BadRequestException({
        message: '历史差额批次存在阻断项，不能创建',
        issues: preview.issues,
      });
    }
    if (preview.fingerprint !== expectedFingerprint) {
      throw new ConflictException('preview fingerprint 已变化，请重新预览');
    }
    const fingerprint = preview.fingerprint;
    const totals = preview.totals;

    try {
      const batch = await this.prisma.$transaction(async (tx) => {
        const created = await tx.historicalPlatformLossBatch.create({
          data: {
            provider: preview.provider,
            providerAccountRef: preview.providerAccountRef,
            region: preview.region,
            periodStart: preview.periodStart,
            periodEnd: preview.periodEnd,
            currency: preview.currency,
            sourceFileRef: preview.sourceFileRef,
            sourceFileSha256: preview.sourceFileSha256,
            calculationMethod: preview.calculationMethod,
            roundingPolicy: preview.roundingPolicy,
            ...(preview.exchangeRate ? { exchangeRate: preview.exchangeRate } : {}),
            exchangeRateSource: preview.exchangeRateSource,
            exchangeRateSourceCurrency: preview.exchangeRateSourceCurrency,
            exchangeRateAsOf: preview.exchangeRateAsOf,
            platformAmountBefore: totals.platformAmountBefore,
            platformAmountCorrected: totals.platformAmountCorrected,
            customerAbsorbedDelta: totals.customerAbsorbedDelta,
            customerDeduction: totals.customerDeduction,
            providerCostBefore: totals.providerCostBefore,
            providerCostCorrected: totals.providerCostCorrected,
            providerCostDelta: totals.providerCostDelta,
            itemCount: preview.itemCount,
            fingerprint,
            reason: preview.reason,
            makerActorId: actorId,
            createIdempotencyKey: idempotencyKey,
            lines: {
              create: preview.lines.map((line) => ({
                lineNumber: line.lineNumber,
                lineType: line.lineType,
                gatewayBillingEventId: line.gatewayBillingEventId,
                requestId: line.requestId,
                upstreamRequestId: line.upstreamRequestId,
                providerAggregateRef: line.providerAggregateRef,
                serviceDate: new Date(`${line.serviceDate}T00:00:00.000Z`),
                modelName: line.model,
                meter: line.meter,
                platformUsage: line.platformUsage,
                providerUsage: line.providerUsage,
                usageDelta: line.usageDelta,
                valuationBasis: line.valuationBasis as Prisma.InputJsonValue,
                sourceRowRef: line.sourceRowRef,
                sourceEvidence: line.sourceEvidence as Prisma.InputJsonValue,
                sourceRowHash: line.sourceRowHash,
                recognitionKeys: line.recognitionKeys as Prisma.InputJsonValue,
                platformAmountBefore: line.platformAmountBefore,
                platformAmountCorrected: line.platformAmountCorrected,
                customerAbsorbedDelta: line.customerAbsorbedDelta,
                customerDeduction: line.customerDeduction,
                providerCostBefore: line.providerCostBefore,
                providerCostCorrected: line.providerCostCorrected,
                providerCostDelta: line.providerCostDelta,
                lineHash: line.lineHash,
              })),
            },
            actions: {
              create: {
                action: 'PREPARE',
                expectedRevision: -1,
                resultingRevision: 0,
                actorId,
                reason: preview.reason,
                idempotencyKey: `prepare:${idempotencyKey}`,
                metadata: {
                  fingerprint,
                  sourceFileSha256: preview.sourceFileSha256,
                  itemCount: preview.itemCount,
                },
              },
            },
          },
          include: batchInclude,
        });
        return created;
      });
      return serializeBatch(batch);
    } catch (error) {
      const concurrentReplay = await this.prisma.historicalPlatformLossBatch.findUnique({
        where: { createIdempotencyKey: idempotencyKey },
        include: batchInclude,
      });
      if (
        concurrentReplay &&
        concurrentReplay.fingerprint === expectedFingerprint &&
        concurrentReplay.makerActorId === actorId
      ) {
        return serializeBatch(concurrentReplay);
      }
      if (isUniqueViolation(error)) {
        throw new ConflictException('相同来源或 fingerprint 的历史差额批次已存在');
      }
      throw error;
    }
  }

  async approveAndPost(
    batchIdInput: string,
    command: HistoricalPlatformLossPostCommand,
    actorIdInput: string,
  ): Promise<Record<string, unknown>> {
    const batchId = requiredString(batchIdInput, 'batchId');
    const actorId = requiredString(actorIdInput, 'actorId');
    const expectedRevision = requiredInteger(command.expectedRevision, 'expectedRevision');
    const expectedFingerprint = sha256String(command.expectedFingerprint, 'expectedFingerprint');
    const reason = requiredString(command.reason, 'reason', 1000);
    const idempotencyKey = requiredString(command.idempotencyKey, 'idempotencyKey', 200);

    const replay = await this.findPostReplay(
      batchId,
      actorId,
      expectedRevision,
      expectedFingerprint,
      reason,
      idempotencyKey,
    );
    if (replay) return replay;

    try {
      await this.prisma.$transaction(async (tx) => {
        await tx.$queryRaw`SELECT "id" FROM "historical_platform_loss_batches" WHERE "id" = ${batchId} FOR UPDATE`;
        const batch = await tx.historicalPlatformLossBatch.findUnique({
          where: { id: batchId },
          include: batchInclude,
        });
        if (!batch) throw new NotFoundException('历史差额批次不存在');
        if (batch.status !== 'PREPARED' || batch.revision !== expectedRevision) {
          throw new ConflictException('批次状态或 revision 已变化，请刷新后重试');
        }
        if (batch.fingerprint !== expectedFingerprint) {
          throw new ConflictException('批次 fingerprint 与审批内容不一致');
        }
        if (batch.makerActorId === actorId) {
          throw new ConflictException('创建人与审批人必须不同（maker-checker）');
        }
        assertStoredBatchIntegrity(batch);

        const reservedCoverageModes = new Map<string, 'REQUEST' | 'AGGREGATE'>();
        for (const line of batch.lines) {
          const coverage = usageLossCoverageIdentity(
            batch.provider,
            batch.providerAccountRef,
            batch.region,
            new Date(line.serviceDate).toISOString().slice(0, 10),
            line.modelName,
            line.meter,
          );
          const mode = line.lineType === 'PROVIDER_AGGREGATE'
            ? 'AGGREGATE'
            : 'REQUEST';
          const priorMode = reservedCoverageModes.get(coverage.coverageKey);
          if (priorMode && priorMode !== mode) {
            throw new ConflictException('批次内同一 coverage 不得混用 REQUEST/AGGREGATE 粒度');
          }
          if (!priorMode) {
            await reserveUsageLossCoverage(tx, coverage, mode);
            reservedCoverageModes.set(coverage.coverageKey, mode);
          }
        }

        const claimedInThisBatch = new Set<string>();
        for (const line of batch.lines) {
          const claims = parseStoredRecognitionKeys(line.recognitionKeys);
          for (const claim of claims) {
            if (claimedInThisBatch.has(claim.key)) continue;
            await tx.usageLossRecognitionClaim.create({
              data: {
                recognitionKey: claim.key,
                recognitionType: claim.type,
                claimSource: 'HISTORICAL_BATCH',
                gatewayBillingEventId: line.gatewayBillingEventId,
                historicalBatchLineId: line.id,
              },
            });
            claimedInThisBatch.add(claim.key);
          }
        }

        const now = new Date();
        const changed = await tx.historicalPlatformLossBatch.updateMany({
          where: {
            id: batchId,
            status: 'PREPARED',
            revision: expectedRevision,
            fingerprint: expectedFingerprint,
          },
          data: {
            status: 'POSTED',
            revision: { increment: 1 },
            checkerActorId: actorId,
            postedByActorId: actorId,
            postIdempotencyKey: idempotencyKey,
            approvedAt: now,
            postedAt: now,
          },
        });
        if (changed.count !== 1) {
          throw new ConflictException('批次状态已变化，请刷新后重试');
        }
        await tx.historicalPlatformLossAction.create({
          data: {
            batchId,
            action: 'APPROVE_AND_POST',
            expectedRevision,
            resultingRevision: expectedRevision + 1,
            actorId,
            reason,
            idempotencyKey,
            metadata: {
              fingerprint: expectedFingerprint,
              customerDeduction: '0.000000000000',
              customerAbsorbedDelta: decimalString(batch.customerAbsorbedDelta),
              providerCostDelta: decimalString(batch.providerCostDelta),
            },
          },
        });

        // A historical line proves only the named meter discrepancy. It does
        // not prove that every unresolved dimension on the request is closed,
        // so POST deliberately leaves all access restrictions in place. A
        // separate evidence-complete reconciliation must release them.
      });
    } catch (error) {
      const concurrentReplay = await this.findPostReplay(
        batchId,
        actorId,
        expectedRevision,
        expectedFingerprint,
        reason,
        idempotencyKey,
      );
      if (concurrentReplay) return concurrentReplay;
      if (isUniqueViolation(error)) {
        throw new ConflictException('来源识别键已被其他批次或逐请求 absorb-delta 确认');
      }
      throw error;
    }

    return this.get(batchId);
  }

  async get(batchIdInput: string): Promise<Record<string, unknown>> {
    const batchId = requiredString(batchIdInput, 'batchId');
    const batch = await this.prisma.historicalPlatformLossBatch.findUnique({
      where: { id: batchId },
      include: batchInclude,
    });
    if (!batch) throw new NotFoundException('历史差额批次不存在');
    assertStoredBatchIntegrity(batch);
    return serializeBatch(batch);
  }

  async list(query: {
    page?: unknown;
    pageSize?: unknown;
    status?: unknown;
    provider?: unknown;
    providerAccountRef?: unknown;
    region?: unknown;
    periodStart?: unknown;
    periodEnd?: unknown;
  }): Promise<Record<string, unknown>> {
    const page = optionalPositiveInteger(query.page, 1);
    const pageSize = Math.min(optionalPositiveInteger(query.pageSize, 20), 100);
    const status = optionalString(query.status);
    if (status && !['PREPARED', 'POSTED'].includes(status)) {
      throw new BadRequestException('status 仅支持 PREPARED 或 POSTED');
    }
    const periodStart = optionalDate(query.periodStart, 'periodStart');
    const periodEnd = optionalDate(query.periodEnd, 'periodEnd');
    const provider = optionalString(query.provider);
    const providerAccountRef = optionalString(query.providerAccountRef);
    const region = optionalString(query.region);
    const where: Prisma.HistoricalPlatformLossBatchWhereInput = {
      ...(status ? { status } : {}),
      ...(provider ? { provider } : {}),
      ...(providerAccountRef ? { providerAccountRef } : {}),
      ...(region ? { region } : {}),
      ...((periodStart || periodEnd)
        ? {
          periodStart: {
            ...(periodStart ? { gte: periodStart } : {}),
            ...(periodEnd ? { lt: periodEnd } : {}),
          },
        }
        : {}),
    };
    const [items, total] = await this.prisma.$transaction([
      this.prisma.historicalPlatformLossBatch.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.historicalPlatformLossBatch.count({ where }),
    ]);
    return {
      items: items.map(serializeBatchSummary),
      total,
      page,
      pageSize,
      totalPages: Math.ceil(total / pageSize),
    };
  }

  async export(batchIdInput: string): Promise<Record<string, unknown>> {
    const batch = await this.get(batchIdInput);
    return {
      schemaVersion: 'historical-platform-loss-export.v1',
      generatedAt: new Date().toISOString(),
      batch,
      lines: batch.lines,
      actions: batch.actions,
      totals: batch.totals,
      fingerprint: batch.fingerprint,
    };
  }

  private async canonicalLine(
    header: CanonicalHeader,
    raw: JsonObject,
    lineNumber: number,
  ): Promise<CanonicalLine> {
    const lineType = lineRequiredString(raw.lineType, 'lineType') as CanonicalLine['lineType'];
    if (!LINE_TYPES.has(lineType)) {
      throw new LineBlockedError('UNSUPPORTED_LINE_TYPE', 'lineType 不受支持');
    }
    const sourceRowRef = lineRequiredString(raw.sourceRowRef, 'sourceRowRef', 500);
    const sourceEvidence = raw.sourceEvidence;
    if (!isObject(sourceEvidence) || Object.keys(sourceEvidence).length === 0) {
      throw new LineBlockedError(
        'SOURCE_EVIDENCE_REQUIRED',
        '每行必须提供可复核的非空 sourceEvidence 原始来源证明',
      );
    }
    const serviceDate = dateOnly(raw.serviceDate, 'serviceDate');
    const serviceDateAt = new Date(`${serviceDate}T00:00:00.000Z`);
    if (
      serviceDateAt.getTime() < header.periodStart.getTime()
      || serviceDateAt.getTime() >= header.periodEnd.getTime()
    ) {
      throw new LineBlockedError(
        'SERVICE_DATE_OUTSIDE_BATCH_PERIOD',
        'serviceDate 必须位于批次 [periodStart, periodEnd) 区间内',
      );
    }
    const model = lineRequiredString(raw.model, 'model', 200);
    const meter = lineRequiredString(raw.meter, 'meter', 100).toUpperCase();
    const platformUsage = nonNegativeIntegerDecimal(raw.platformUsage, 'platformUsage');
    const providerUsage = nonNegativeIntegerDecimal(raw.providerUsage, 'providerUsage');
    const usageDelta = providerUsage.minus(platformUsage);
    const valuationBasisRaw = lineObject(
      raw.valuationBasis,
      'valuationBasis',
      'PRICING_EVIDENCE_REQUIRED',
    );
    const pricingEvidence = lineObject(
      valuationBasisRaw.pricingEvidence,
      'valuationBasis.pricingEvidence',
      'PRICING_EVIDENCE_REQUIRED',
    );
    const valuationBasis = {
      version: lineRequiredString(valuationBasisRaw.version, 'valuationBasis.version', 100),
      rateUnit: lineRequiredString(
        valuationBasisRaw.rateUnit,
        'valuationBasis.rateUnit',
      ) as 'TOKENS_PER_MILLION',
      pricingCurrency: lineRequiredString(
        valuationBasisRaw.pricingCurrency,
        'valuationBasis.pricingCurrency',
      ).toUpperCase(),
      customerRatePerMillion: moneyDecimal(
        valuationBasisRaw.customerRatePerMillion,
        'valuationBasis.customerRatePerMillion',
      ).toFixed(12),
      providerCostRatePerMillion: moneyDecimal(
        valuationBasisRaw.providerCostRatePerMillion,
        'valuationBasis.providerCostRatePerMillion',
      ).toFixed(12),
      pricingSourceRef: lineRequiredString(
        valuationBasisRaw.pricingSourceRef,
        'valuationBasis.pricingSourceRef',
        1000,
      ),
      pricingDocumentSha256: sha256LineString(
        valuationBasisRaw.pricingDocumentSha256,
        'valuationBasis.pricingDocumentSha256',
      ),
      pricingEvidenceHash: sha256LineString(
        valuationBasisRaw.pricingEvidenceHash,
        'valuationBasis.pricingEvidenceHash',
      ),
      pricingEffectiveFrom: dateOnly(
        valuationBasisRaw.pricingEffectiveFrom,
        'valuationBasis.pricingEffectiveFrom',
      ),
      pricingEffectiveTo: dateOnly(
        valuationBasisRaw.pricingEffectiveTo,
        'valuationBasis.pricingEffectiveTo',
      ),
      pricingApprovedBy: lineRequiredString(
        valuationBasisRaw.pricingApprovedBy,
        'valuationBasis.pricingApprovedBy',
        300,
      ),
      pricingApprovedAt: lineRequiredDate(
        valuationBasisRaw.pricingApprovedAt,
        'valuationBasis.pricingApprovedAt',
      ).toISOString(),
      pricingEvidence,
    };
    if (valuationBasis.rateUnit !== 'TOKENS_PER_MILLION') {
      throw new LineBlockedError('UNSUPPORTED_RATE_UNIT', '仅支持 TOKENS_PER_MILLION');
    }
    if (valuationBasis.pricingCurrency !== header.currency) {
      throw new LineBlockedError(
        'VALUATION_CURRENCY_MISMATCH',
        'valuationBasis.pricingCurrency 必须与批次 currency 一致',
      );
    }
    if (
      serviceDate < valuationBasis.pricingEffectiveFrom ||
      serviceDate >= valuationBasis.pricingEffectiveTo
    ) {
      throw new LineBlockedError(
        'PRICING_NOT_EFFECTIVE_FOR_SERVICE_DATE',
        'serviceDate 不在冻结历史费率证据的 [effectiveFrom, effectiveTo) 区间',
      );
    }
    if (canonicalSha256(pricingEvidence) !== valuationBasis.pricingEvidenceHash) {
      throw new LineBlockedError(
        'PRICING_EVIDENCE_HASH_MISMATCH',
        'pricingEvidence 与 pricingEvidenceHash 不一致',
      );
    }
    const evidenceContract = {
      sourceRef: optionalString(pricingEvidence.sourceRef),
      documentSha256: optionalString(pricingEvidence.documentSha256)?.toLowerCase() ?? null,
      version: optionalString(pricingEvidence.version),
      model: optionalString(pricingEvidence.model),
      meter: optionalString(pricingEvidence.meter)?.toUpperCase() ?? null,
      pricingCurrency: optionalString(pricingEvidence.pricingCurrency)?.toUpperCase() ?? null,
      customerRatePerMillion: normalizedOptionalMoney(
        pricingEvidence.customerRatePerMillion,
      ),
      providerCostRatePerMillion: normalizedOptionalMoney(
        pricingEvidence.providerCostRatePerMillion,
      ),
      effectiveFrom: optionalString(pricingEvidence.effectiveFrom),
      effectiveTo: optionalString(pricingEvidence.effectiveTo),
      approvedBy: optionalString(pricingEvidence.approvedBy),
      approvedAt: normalizedOptionalDate(pricingEvidence.approvedAt),
    };
    if (
      evidenceContract.sourceRef !== valuationBasis.pricingSourceRef ||
      evidenceContract.documentSha256 !== valuationBasis.pricingDocumentSha256 ||
      evidenceContract.version !== valuationBasis.version ||
      evidenceContract.model !== model ||
      evidenceContract.meter !== meter ||
      evidenceContract.pricingCurrency !== valuationBasis.pricingCurrency ||
      evidenceContract.customerRatePerMillion !== valuationBasis.customerRatePerMillion ||
      evidenceContract.providerCostRatePerMillion !== valuationBasis.providerCostRatePerMillion ||
      evidenceContract.effectiveFrom !== valuationBasis.pricingEffectiveFrom ||
      evidenceContract.effectiveTo !== valuationBasis.pricingEffectiveTo ||
      evidenceContract.approvedBy !== valuationBasis.pricingApprovedBy ||
      evidenceContract.approvedAt !== valuationBasis.pricingApprovedAt
    ) {
      throw new LineBlockedError(
        'PRICING_EVIDENCE_CONTRACT_MISMATCH',
        '费率、模型、meter、生效区间或审批信息与 pricingEvidence 归档行不一致',
      );
    }
    const customerRate = new Prisma.Decimal(valuationBasis.customerRatePerMillion);
    const providerRate = new Prisma.Decimal(valuationBasis.providerCostRatePerMillion);
    const platformAmountBefore = roundMoney(platformUsage.mul(customerRate).div(1_000_000));
    const platformAmountCorrected = roundMoney(providerUsage.mul(customerRate).div(1_000_000));
    const providerCostBefore = roundMoney(platformUsage.mul(providerRate).div(1_000_000));
    const providerCostCorrected = roundMoney(providerUsage.mul(providerRate).div(1_000_000));
    const sourceRowHash = canonicalSha256({
      sourceFileSha256: header.sourceFileSha256,
      sourceRowRef,
      sourceEvidence,
      serviceDate,
      model,
      meter,
      platformUsage: platformUsage.toFixed(0),
      providerUsage: providerUsage.toFixed(0),
      usageDelta: usageDelta.toFixed(0),
    });

    let gatewayBillingEventId: string | null = null;
    let requestId: string | null = null;
    let upstreamRequestId: string | null = null;
    let providerAggregateRef: string | null = null;
    const recognitionKeys: CanonicalLine['recognitionKeys'] = [];
    if (lineType === 'MISSING_ANCHOR_REQUEST') {
      requestId = lineRequiredString(raw.requestId, 'requestId', 500);
      if (optionalString(raw.providerAggregateRef)) {
        throw new LineBlockedError(
          'INVALID_LINE_IDENTIFIERS',
          'MISSING_ANCHOR_REQUEST 不得提供 providerAggregateRef',
        );
      }
      const event = await this.prisma.gatewayBillingEvent.findUnique({
        where: { requestId },
        select: {
          id: true,
          requestId: true,
          upstreamRequestId: true,
          status: true,
          occurredAt: true,
          modelName: true,
          inputTokens: true,
          outputTokens: true,
          cachedInputTokens: true,
          cacheWriteInputTokens: true,
          totalTokens: true,
          rawEvent: true,
          settlementAnchor: { select: { id: true } },
        },
      });
      if (!event) {
        throw new LineBlockedError('GATEWAY_EVENT_NOT_FOUND', 'requestId 对应的历史 Gateway 事件不存在');
      }
      if (event.settlementAnchor) {
        throw new LineBlockedError(
          'SETTLEMENT_ANCHOR_PRESENT',
          '该请求存在完整 settlement anchor，必须走逐请求 absorb-delta',
          'USE_ABSORB_DELTA',
        );
      }
      if (!['DEDUCTED', 'DEBT_OPEN'].includes(event.status)) {
        throw new LineBlockedError(
          'GATEWAY_EVENT_NOT_HISTORICAL_TERMINAL',
          '该请求尚未形成历史终态，不能进入历史差额批次',
        );
      }
      const suppliedUpstream = lineRequiredString(
        raw.upstreamRequestId,
        'upstreamRequestId',
        500,
      );
      assertRequestLineMatchesImmutableEvent({
        header,
        serviceDate,
        model,
        meter,
        platformUsage,
        suppliedUpstream,
        event,
      });
      gatewayBillingEventId = event.id;
      upstreamRequestId = event.upstreamRequestId;
      recognitionKeys.push({ type: 'REQUEST_ID', key: requestRecognitionKey(requestId) });
      if (upstreamRequestId) {
        recognitionKeys.push({
          type: 'UPSTREAM_REQUEST_ID',
          key: upstreamRecognitionKey(
            header.provider,
            header.providerAccountRef,
            upstreamRequestId,
          ),
        });
      }
    } else {
      if (optionalString(raw.requestId) || optionalString(raw.upstreamRequestId)) {
        throw new LineBlockedError(
          'INVALID_LINE_IDENTIFIERS',
          'PROVIDER_AGGREGATE 不得伪造 requestId/upstreamRequestId',
        );
      }
      providerAggregateRef = lineRequiredString(
        raw.providerAggregateRef,
        'providerAggregateRef',
        500,
      );
      recognitionKeys.push(
        ...providerAggregateRecognitionKeys(
          header,
          sourceRowHash,
          serviceDate,
          model,
          meter,
        ),
      );
    }
    const valueFields = {
      platformAmountBefore: platformAmountBefore.toFixed(12),
      platformAmountCorrected: platformAmountCorrected.toFixed(12),
      customerAbsorbedDelta: roundMoney(
        platformAmountCorrected.minus(platformAmountBefore),
      ).toFixed(12),
      customerDeduction: '0.000000000000' as const,
      providerCostBefore: providerCostBefore.toFixed(12),
      providerCostCorrected: providerCostCorrected.toFixed(12),
      providerCostDelta: roundMoney(
        providerCostCorrected.minus(providerCostBefore),
      ).toFixed(12),
    };
    const lineHash = canonicalSha256({
      lineNumber,
      lineType,
      gatewayBillingEventId,
      requestId,
      upstreamRequestId,
      providerAggregateRef,
      serviceDate,
      model,
      meter,
      platformUsage: platformUsage.toFixed(0),
      providerUsage: providerUsage.toFixed(0),
      usageDelta: usageDelta.toFixed(0),
      valuationBasis,
      sourceRowRef,
      sourceRowHash,
      recognitionKeys,
      ...valueFields,
    });
    return {
      lineNumber,
      lineType,
      gatewayBillingEventId,
      requestId,
      upstreamRequestId,
      providerAggregateRef,
      serviceDate,
      model,
      meter,
      platformUsage: platformUsage.toFixed(0),
      providerUsage: providerUsage.toFixed(0),
      usageDelta: usageDelta.toFixed(0),
      valuationBasis,
      sourceRowRef,
      sourceEvidence,
      sourceRowHash,
      recognitionKeys,
      ...valueFields,
      lineHash,
    };
  }

  private async findPostReplay(
    batchId: string,
    actorId: string,
    expectedRevision: number,
    expectedFingerprint: string,
    reason: string,
    idempotencyKey: string,
  ): Promise<Record<string, unknown> | null> {
    const action = await this.prisma.historicalPlatformLossAction.findUnique({
      where: { idempotencyKey },
    });
    if (!action) return null;
    const metadata = isObject(action.metadata) ? action.metadata : {};
    if (
      action.batchId !== batchId ||
      action.action !== 'APPROVE_AND_POST' ||
      action.actorId !== actorId ||
      action.expectedRevision !== expectedRevision ||
      action.reason !== reason ||
      metadata.fingerprint !== expectedFingerprint
    ) {
      throw new ConflictException('post idempotencyKey 已用于另一项审批');
    }
    return this.get(batchId);
  }
}

const batchInclude = {
  lines: { orderBy: { lineNumber: 'asc' as const } },
  actions: { orderBy: { createdAt: 'asc' as const } },
} as const;

function canonicalHeader(input: HistoricalPlatformLossBatchInput): CanonicalHeader {
  for (const key of [
    'platformAmountBefore',
    'platformAmountCorrected',
    'customerAbsorbedDelta',
    'customerDeduction',
    'providerCostBefore',
    'providerCostCorrected',
    'providerCostDelta',
    'itemCount',
    'fingerprint',
  ]) {
    if (Object.prototype.hasOwnProperty.call(input, key)) {
      throw new BadRequestException(`${key} 由 Billing 服务端重算，不得提交`);
    }
  }
  const provider = requiredString(input.provider, 'provider', 100).toLowerCase();
  const providerAccountRef = requiredString(
    input.providerAccountRef,
    'providerAccountRef',
    300,
  );
  const region = requiredString(input.region, 'region', 100).toLowerCase();
  const periodStart = requiredDate(input.periodStart, 'periodStart');
  const periodEnd = requiredDate(input.periodEnd, 'periodEnd');
  if (periodEnd.getTime() <= periodStart.getTime()) {
    throw new BadRequestException('periodEnd 必须晚于 periodStart');
  }
  const currency = requiredString(input.currency, 'currency').toUpperCase();
  if (!/^[A-Z]{3}$/.test(currency)) throw new BadRequestException('currency 必须为三位币种码');
  const sourceFileSha256 = sha256String(input.sourceFileSha256, 'sourceFileSha256');
  const calculationMethod = requiredString(
    input.calculationMethod,
    'calculationMethod',
    200,
  );
  if (calculationMethod !== 'TOKEN_RATE_PER_MILLION_V1') {
    throw new BadRequestException('calculationMethod 仅支持 TOKEN_RATE_PER_MILLION_V1');
  }
  const roundingPolicy = requiredString(input.roundingPolicy, 'roundingPolicy') as 'HALF_UP_12';
  if (roundingPolicy !== 'HALF_UP_12') {
    throw new BadRequestException('roundingPolicy 仅支持 HALF_UP_12');
  }
  const exchangeRateRaw = optionalString(input.exchangeRate);
  const exchangeRate = exchangeRateRaw
    ? positiveDecimal(exchangeRateRaw, 'exchangeRate').toFixed(12)
    : null;
  const exchangeRateSource = optionalString(input.exchangeRateSource);
  const exchangeRateSourceCurrencyRaw = optionalString(input.exchangeRateSourceCurrency);
  const exchangeRateSourceCurrency = exchangeRateSourceCurrencyRaw?.toUpperCase() ?? null;
  const exchangeRateAsOf = optionalDate(input.exchangeRateAsOf, 'exchangeRateAsOf');
  const fxParts = [exchangeRate, exchangeRateSource, exchangeRateSourceCurrency, exchangeRateAsOf];
  const fxPartCount = fxParts.filter(Boolean).length;
  if (fxPartCount !== 0 && fxPartCount !== fxParts.length) {
    throw new BadRequestException(
      'exchangeRate/source/sourceCurrency/asOf 必须同时提供或全部留空',
    );
  }
  if (
    exchangeRateSourceCurrency &&
    (!/^[A-Z]{3}$/.test(exchangeRateSourceCurrency) || exchangeRateSourceCurrency === currency)
  ) {
    throw new BadRequestException('exchangeRateSourceCurrency 必须为不同于批次币种的三位币种码');
  }
  return {
    provider,
    providerAccountRef,
    region,
    periodStart,
    periodEnd,
    currency,
    sourceFileRef: requiredString(input.sourceFileRef, 'sourceFileRef', 1000),
    sourceFileSha256,
    calculationMethod,
    roundingPolicy,
    exchangeRate,
    exchangeRateSource,
    exchangeRateSourceCurrency,
    exchangeRateAsOf,
    reason: optionalString(input.reason) ?? '',
  };
}

function totalLines(lines: CanonicalLine[]): PreviewTotals {
  const sum = (field: keyof CanonicalLine) => roundMoney(
    lines.reduce(
      (total, line) => total.plus(new Prisma.Decimal(String(line[field]))),
      new Prisma.Decimal(0),
    ),
  ).toFixed(12);
  return {
    platformAmountBefore: sum('platformAmountBefore'),
    platformAmountCorrected: sum('platformAmountCorrected'),
    customerAbsorbedDelta: sum('customerAbsorbedDelta'),
    customerDeduction: '0.000000000000',
    providerCostBefore: sum('providerCostBefore'),
    providerCostCorrected: sum('providerCostCorrected'),
    providerCostDelta: sum('providerCostDelta'),
  };
}

function batchFingerprint(
  header: CanonicalHeader,
  lines: CanonicalLine[],
  totals: PreviewTotals,
): string {
  return canonicalSha256({
    schemaVersion: 'historical-platform-loss-batch.v1',
    provider: header.provider,
    providerAccountRef: header.providerAccountRef,
    region: header.region,
    periodStart: header.periodStart.toISOString(),
    periodEnd: header.periodEnd.toISOString(),
    currency: header.currency,
    sourceFileRef: header.sourceFileRef,
    sourceFileSha256: header.sourceFileSha256,
    calculationMethod: header.calculationMethod,
    roundingPolicy: header.roundingPolicy,
    exchangeRate: header.exchangeRate,
    exchangeRateSource: header.exchangeRateSource,
    exchangeRateSourceCurrency: header.exchangeRateSourceCurrency,
    exchangeRateDirection: header.exchangeRate
      ? 'BATCH_CURRENCY_PER_SOURCE_CURRENCY'
      : null,
    exchangeRateAsOf: header.exchangeRateAsOf?.toISOString() ?? null,
    reason: header.reason,
    itemCount: lines.length,
    lines: lines.map((line) => ({ lineNumber: line.lineNumber, lineHash: line.lineHash })),
    totals,
  });
}

function assertStoredBatchIntegrity(batch: any): void {
  const lines = batch.lines.map((line: any): CanonicalLine => ({
    lineNumber: line.lineNumber,
    lineType: line.lineType,
    gatewayBillingEventId: line.gatewayBillingEventId,
    requestId: line.requestId,
    upstreamRequestId: line.upstreamRequestId,
    providerAggregateRef: line.providerAggregateRef,
    serviceDate: new Date(line.serviceDate).toISOString().slice(0, 10),
    model: line.modelName,
    meter: line.meter,
    platformUsage: decimalIntegerString(line.platformUsage),
    providerUsage: decimalIntegerString(line.providerUsage),
    usageDelta: signedDecimalIntegerString(line.usageDelta),
    valuationBasis: line.valuationBasis,
    sourceRowRef: line.sourceRowRef,
    sourceEvidence: line.sourceEvidence,
    sourceRowHash: line.sourceRowHash,
    recognitionKeys: parseStoredRecognitionKeys(line.recognitionKeys),
    platformAmountBefore: decimalString(line.platformAmountBefore),
    platformAmountCorrected: decimalString(line.platformAmountCorrected),
    customerAbsorbedDelta: decimalString(line.customerAbsorbedDelta),
    customerDeduction: decimalString(line.customerDeduction) as '0.000000000000',
    providerCostBefore: decimalString(line.providerCostBefore),
    providerCostCorrected: decimalString(line.providerCostCorrected),
    providerCostDelta: decimalString(line.providerCostDelta),
    lineHash: line.lineHash,
  }));
  for (const line of lines) {
    const expectedSourceRowHash = canonicalSha256({
      sourceFileSha256: batch.sourceFileSha256,
      sourceRowRef: line.sourceRowRef,
      sourceEvidence: line.sourceEvidence,
      serviceDate: line.serviceDate,
      model: line.model,
      meter: line.meter,
      platformUsage: line.platformUsage,
      providerUsage: line.providerUsage,
      usageDelta: line.usageDelta,
    });
    if (expectedSourceRowHash !== line.sourceRowHash) {
      throw new ConflictException(`历史差额批次第 ${line.lineNumber} 行来源证据 hash 校验失败`);
    }
    if (
      !isObject(line.valuationBasis) ||
      !isObject(line.valuationBasis.pricingEvidence) ||
      canonicalSha256(line.valuationBasis.pricingEvidence) !==
        line.valuationBasis.pricingEvidenceHash
    ) {
      throw new ConflictException(`历史差额批次第 ${line.lineNumber} 行价目证据 hash 校验失败`);
    }
    const expectedLineHash = canonicalSha256({
      lineNumber: line.lineNumber,
      lineType: line.lineType,
      gatewayBillingEventId: line.gatewayBillingEventId,
      requestId: line.requestId,
      upstreamRequestId: line.upstreamRequestId,
      providerAggregateRef: line.providerAggregateRef,
      serviceDate: line.serviceDate,
      model: line.model,
      meter: line.meter,
      platformUsage: line.platformUsage,
      providerUsage: line.providerUsage,
      usageDelta: line.usageDelta,
      valuationBasis: line.valuationBasis,
      sourceRowRef: line.sourceRowRef,
      sourceRowHash: line.sourceRowHash,
      recognitionKeys: line.recognitionKeys,
      platformAmountBefore: line.platformAmountBefore,
      platformAmountCorrected: line.platformAmountCorrected,
      customerAbsorbedDelta: line.customerAbsorbedDelta,
      customerDeduction: line.customerDeduction,
      providerCostBefore: line.providerCostBefore,
      providerCostCorrected: line.providerCostCorrected,
      providerCostDelta: line.providerCostDelta,
    });
    if (expectedLineHash !== line.lineHash) {
      throw new ConflictException(`历史差额批次第 ${line.lineNumber} 行 hash 校验失败`);
    }
  }
  const totals = totalLines(lines);
  for (const [key, value] of Object.entries(totals)) {
    const storedKey = key === 'customerDeduction' ? 'customerDeduction' : key;
    if (decimalString(batch[storedKey]) !== value) {
      throw new ConflictException(`历史差额批次 totals.${key} 校验失败`);
    }
  }
  const header: CanonicalHeader = {
    provider: batch.provider,
    providerAccountRef: batch.providerAccountRef,
    region: batch.region,
    periodStart: new Date(batch.periodStart),
    periodEnd: new Date(batch.periodEnd),
    currency: batch.currency,
    sourceFileRef: batch.sourceFileRef,
    sourceFileSha256: batch.sourceFileSha256,
    calculationMethod: batch.calculationMethod,
    roundingPolicy: batch.roundingPolicy,
    exchangeRate: batch.exchangeRate === null ? null : decimalString(batch.exchangeRate),
    exchangeRateSource: batch.exchangeRateSource,
    exchangeRateSourceCurrency: batch.exchangeRateSourceCurrency,
    exchangeRateAsOf: batch.exchangeRateAsOf ? new Date(batch.exchangeRateAsOf) : null,
    reason: batch.reason,
  };
  if (batchFingerprint(header, lines, totals) !== batch.fingerprint) {
    throw new ConflictException('历史差额批次 fingerprint 校验失败');
  }
}

function serializeBatch(batch: any): Record<string, any> {
  const summary = serializeBatchSummary(batch);
  const lines = batch.lines.map((line: any) => ({
    id: line.id,
    lineNumber: line.lineNumber,
    lineType: line.lineType,
    gatewayBillingEventId: line.gatewayBillingEventId,
    requestId: line.requestId,
    upstreamRequestId: line.upstreamRequestId,
    providerAggregateRef: line.providerAggregateRef,
    serviceDate: new Date(line.serviceDate).toISOString().slice(0, 10),
    model: line.modelName,
    meter: line.meter,
    platformUsage: decimalIntegerString(line.platformUsage),
    providerUsage: decimalIntegerString(line.providerUsage),
    usageDelta: signedDecimalIntegerString(line.usageDelta),
    valuationBasis: line.valuationBasis,
    sourceRowRef: line.sourceRowRef,
    sourceEvidence: line.sourceEvidence,
    sourceRowHash: line.sourceRowHash,
    recognitionKeys: line.recognitionKeys,
    platformAmountBefore: decimalString(line.platformAmountBefore),
    platformAmountCorrected: decimalString(line.platformAmountCorrected),
    customerAbsorbedDelta: decimalString(line.customerAbsorbedDelta),
    customerDeduction: decimalString(line.customerDeduction),
    providerCostBefore: decimalString(line.providerCostBefore),
    providerCostCorrected: decimalString(line.providerCostCorrected),
    providerCostDelta: decimalString(line.providerCostDelta),
    lineHash: line.lineHash,
    createdAt: line.createdAt,
  }));
  const actions = batch.actions.map((action: any) => ({
    id: action.id,
    action: action.action,
    expectedRevision: action.expectedRevision,
    resultingRevision: action.resultingRevision,
    actorId: action.actorId,
    reason: action.reason,
    idempotencyKey: action.idempotencyKey,
    metadata: action.metadata,
    createdAt: action.createdAt,
  }));
  return { ...summary, lines, actions };
}

function serializeBatchSummary(batch: any): Record<string, any> {
  const totals = {
    platformAmountBefore: decimalString(batch.platformAmountBefore),
    platformAmountCorrected: decimalString(batch.platformAmountCorrected),
    customerAbsorbedDelta: decimalString(batch.customerAbsorbedDelta),
    customerDeduction: decimalString(batch.customerDeduction),
    providerCostBefore: decimalString(batch.providerCostBefore),
    providerCostCorrected: decimalString(batch.providerCostCorrected),
    providerCostDelta: decimalString(batch.providerCostDelta),
  };
  return {
    id: batch.id,
    provider: batch.provider,
    providerAccountRef: batch.providerAccountRef,
    region: batch.region,
    periodStart: batch.periodStart,
    periodEnd: batch.periodEnd,
    currency: batch.currency,
    sourceFileRef: batch.sourceFileRef,
    sourceFileSha256: batch.sourceFileSha256,
    calculationMethod: batch.calculationMethod,
    roundingPolicy: batch.roundingPolicy,
    exchangeRate: batch.exchangeRate === null ? null : decimalString(batch.exchangeRate),
    exchangeRateSource: batch.exchangeRateSource,
    exchangeRateSourceCurrency: batch.exchangeRateSourceCurrency,
    exchangeRateDirection: batch.exchangeRate
      ? 'BATCH_CURRENCY_PER_SOURCE_CURRENCY'
      : null,
    exchangeRateAsOf: batch.exchangeRateAsOf,
    totals,
    itemCount: batch.itemCount,
    fingerprint: batch.fingerprint,
    revision: batch.revision,
    status: batch.status,
    reason: batch.reason,
    makerActorId: batch.makerActorId,
    checkerActorId: batch.checkerActorId,
    postedByActorId: batch.postedByActorId,
    createIdempotencyKey: batch.createIdempotencyKey,
    postIdempotencyKey: batch.postIdempotencyKey,
    approvedAt: batch.approvedAt,
    postedAt: batch.postedAt,
    createdAt: batch.createdAt,
    updatedAt: batch.updatedAt,
  };
}

export function requestRecognitionKey(requestId: string): string {
  return `REQUEST_ID:${Buffer.from(requestId, 'utf8').toString('base64')}`;
}

export function upstreamRecognitionKey(provider: string, account: string, id: string): string {
  return `UPSTREAM_REQUEST_ID:${base64(provider)}:${base64(account)}:${base64(id)}`;
}

function providerAggregateRecognitionKeys(
  header: CanonicalHeader,
  sourceRowHash: string,
  serviceDate: string,
  model: string,
  meter: string,
): Array<{ type: string; key: string }> {
  return [
    {
      type: 'PROVIDER_AGGREGATE_SOURCE',
      key: [
        'PROVIDER_AGGREGATE_SOURCE',
        header.sourceFileSha256,
        sourceRowHash,
      ].join(':'),
    },
    {
      type: 'PROVIDER_AGGREGATE_COVERAGE',
      key: usageLossCoverageRecognitionKey(
        header.provider,
        header.providerAccountRef,
        header.region,
        serviceDate,
        model,
        meter,
      ),
    },
  ];
}

function assertRequestLineMatchesImmutableEvent(input: {
  header: CanonicalHeader;
  serviceDate: string;
  model: string;
  meter: string;
  platformUsage: Prisma.Decimal;
  suppliedUpstream: string;
  event: {
    upstreamRequestId: string | null;
    occurredAt: Date | null;
    modelName: string | null;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    totalTokens: number;
    rawEvent: Prisma.JsonValue;
  };
}): void {
  const { event } = input;
  if (!event.upstreamRequestId || event.upstreamRequestId !== input.suppliedUpstream) {
    throw new LineBlockedError(
      'UPSTREAM_REQUEST_ID_MISMATCH',
      '必须提供与首次收件不可变 upstreamRequestId 完全一致的逐请求证据',
      'USE_PROVIDER_AGGREGATE',
    );
  }
  if (!event.occurredAt || Number.isNaN(event.occurredAt.getTime())) {
    throw new LineBlockedError(
      'REQUEST_EVENT_EVIDENCE_INCOMPLETE',
      '历史 Gateway 事件缺少不可变 occurredAt，不得生成逐请求 claim',
      'USE_PROVIDER_AGGREGATE',
    );
  }
  if (event.occurredAt.toISOString().slice(0, 10) !== input.serviceDate) {
    throw new LineBlockedError(
      'REQUEST_EVENT_SERVICE_DATE_MISMATCH',
      'serviceDate 与历史 Gateway 事件 occurredAt 的 UTC 日期不一致',
    );
  }
  if (!event.modelName || event.modelName !== input.model) {
    throw new LineBlockedError(
      'REQUEST_EVENT_MODEL_MISMATCH',
      'model 与历史 Gateway 事件的不可变模型名不一致',
    );
  }

  if (!isObject(event.rawEvent)) {
    throw new LineBlockedError(
      'REQUEST_EVENT_EVIDENCE_INCOMPLETE',
      '历史 Gateway 事件缺少可解析的不可变 rawEvent',
      'USE_PROVIDER_AGGREGATE',
    );
  }
  const base = optionalObjectValue(event.rawEvent.base);
  const decision = optionalObjectValue(event.rawEvent.decision);
  const labels = {
    ...optionalStringMapValue(base.labels),
    ...optionalStringMapValue(event.rawEvent.labels),
  };
  const provider = firstRequiredHistoricalIdentity([
    optionalString(event.rawEvent.provider),
    optionalString(base.provider),
  ]);
  const providerAccountRef = firstRequiredHistoricalIdentity([
    optionalString(event.rawEvent.provider_account_ref),
    optionalString(event.rawEvent.provider_credential_ref),
    optionalString(base.provider_account_ref),
    optionalString(base.provider_credential_ref),
  ]);
  const region = firstRequiredHistoricalIdentity([
    optionalString(event.rawEvent.region),
    optionalString(decision.region),
    labels.region,
  ]);
  if (!provider || !providerAccountRef || !region) {
    throw new LineBlockedError(
      'REQUEST_EVENT_EVIDENCE_INCOMPLETE',
      '历史 Gateway 事件缺少 provider/providerAccountRef/region 不可变身份，不得生成逐请求 claim',
      'USE_PROVIDER_AGGREGATE',
    );
  }
  if (
    provider.toLowerCase() !== input.header.provider
    || providerAccountRef !== input.header.providerAccountRef
    || region.toLowerCase() !== input.header.region
  ) {
    throw new LineBlockedError(
      'REQUEST_EVENT_PROVIDER_IDENTITY_MISMATCH',
      'provider/providerAccountRef/region 与历史 Gateway 事件的不可变身份不一致',
    );
  }

  const canonicalMeter = canonicalUsageLossMeter(input.meter);
  const eventUsageByMeter: Record<string, number> = {
    INPUT: event.inputTokens,
    OUTPUT: event.outputTokens,
    CACHE: event.cachedInputTokens,
    CACHE_WRITE: event.cacheWriteInputTokens,
    TOTAL: event.totalTokens,
  };
  const eventUsage = eventUsageByMeter[canonicalMeter];
  if (!Number.isSafeInteger(eventUsage) || eventUsage < 0) {
    throw new LineBlockedError(
      'REQUEST_EVENT_EVIDENCE_INCOMPLETE',
      `${input.meter} 缺少可验证的历史 Gateway 用量维度`,
      'USE_PROVIDER_AGGREGATE',
    );
  }
  if (!input.platformUsage.equals(eventUsage)) {
    throw new LineBlockedError(
      'REQUEST_EVENT_PLATFORM_USAGE_MISMATCH',
      `platformUsage 与历史 Gateway 事件 ${canonicalMeter} 用量不一致`,
    );
  }
}

function optionalObjectValue(value: unknown): JsonObject {
  return isObject(value) ? value : {};
}

function optionalStringMapValue(value: unknown): Record<string, string> {
  if (!isObject(value)) return {};
  return Object.fromEntries(
    Object.entries(value)
      .filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
}

function firstRequiredHistoricalIdentity(values: Array<string | null>): string | null {
  return values.find((value): value is string => Boolean(value)) ?? null;
}

/**
 * A provider aggregate has no request identifiers, so its coverage tuple is
 * the only safe cross-granularity exclusion key. Per-request absorb-delta uses
 * this exact helper too. The append-only coverage registry freezes REQUEST or
 * AGGREGATE mode; the aggregate recognition claim separately prevents a
 * second aggregate batch for the same coverage.
 */
export function usageLossCoverageRecognitionKey(
  provider: string,
  providerAccountRef: string,
  region: string,
  serviceDate: string,
  model: string,
  meter: string,
): string {
  return usageLossCoverageIdentity(
    provider,
    providerAccountRef,
    region,
    serviceDate,
    model,
    meter,
  ).coverageKey;
}

export type UsageLossCoverageIdentity = {
  coverageKey: string;
  provider: string;
  providerAccountRef: string;
  region: string;
  serviceDate: string;
  model: string;
  meter: string;
};

export function usageLossCoverageIdentity(
  provider: string,
  providerAccountRef: string,
  region: string,
  serviceDate: string,
  model: string,
  meter: string,
): UsageLossCoverageIdentity {
  const canonical = {
    provider: provider.trim().toLowerCase(),
    providerAccountRef: providerAccountRef.trim(),
    region: region.trim().toLowerCase(),
    serviceDate: serviceDate.trim(),
    model: model.trim(),
    meter: canonicalUsageLossMeter(meter),
  };
  const coverageKey = [
    'PROVIDER_AGGREGATE_COVERAGE',
    base64(canonical.provider),
    base64(canonical.providerAccountRef),
    base64(canonical.region),
    base64(canonical.serviceDate),
    base64(canonical.model),
    base64(canonical.meter),
  ].join(':');
  return { coverageKey, ...canonical };
}

export async function reserveUsageLossCoverage(
  tx: Pick<Prisma.TransactionClient, '$executeRaw' | '$queryRaw'>,
  coverage: UsageLossCoverageIdentity,
  granularityMode: 'REQUEST' | 'AGGREGATE',
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "usage_loss_coverage_registry" (
      "id", "coverage_key", "provider", "provider_account_ref", "region",
      "service_date", "model_name", "meter", "granularity_mode"
    ) VALUES (
      ${randomUUID()}, ${coverage.coverageKey}, ${coverage.provider},
      ${coverage.providerAccountRef}, ${coverage.region},
      ${new Date(`${coverage.serviceDate}T00:00:00.000Z`)},
      ${coverage.model}, ${coverage.meter}, ${granularityMode}
    )
    ON CONFLICT ("coverage_key") DO NOTHING
  `;
  const rows = await tx.$queryRaw<Array<{
    coverageKey: string;
    provider: string;
    providerAccountRef: string;
    region: string;
    serviceDate: Date;
    model: string;
    meter: string;
    granularityMode: string;
  }>>`
    SELECT
      "coverage_key" AS "coverageKey",
      "provider",
      "provider_account_ref" AS "providerAccountRef",
      "region",
      "service_date" AS "serviceDate",
      "model_name" AS "model",
      "meter",
      "granularity_mode" AS "granularityMode"
    FROM "usage_loss_coverage_registry"
    WHERE "coverage_key" = ${coverage.coverageKey}
    FOR UPDATE
  `;
  const stored = rows[0];
  if (!stored) {
    throw new ConflictException('用量损失 coverage 占位未能持久化');
  }
  if (
    stored.provider !== coverage.provider
    || stored.providerAccountRef !== coverage.providerAccountRef
    || stored.region !== coverage.region
    || new Date(stored.serviceDate).toISOString().slice(0, 10) !== coverage.serviceDate
    || stored.model !== coverage.model
    || stored.meter !== coverage.meter
  ) {
    throw new ConflictException('用量损失 coverage key 与已存身份不一致');
  }
  if (stored.granularityMode !== granularityMode) {
    throw new ConflictException(
      `该 provider/account/region/date/model/meter 已按 ${stored.granularityMode} 粒度确认，禁止再按 ${granularityMode} 粒度重复吸收`,
    );
  }
}

export async function findUsageLossCoverageModes(
  db: Pick<Prisma.TransactionClient, '$queryRaw'>,
  coverageKeys: string[],
): Promise<Map<string, string>> {
  if (coverageKeys.length === 0) return new Map();
  const rows = await db.$queryRaw<Array<{ coverageKey: string; granularityMode: string }>>`
    SELECT
      "coverage_key" AS "coverageKey",
      "granularity_mode" AS "granularityMode"
    FROM "usage_loss_coverage_registry"
    WHERE "coverage_key" IN (${Prisma.join(coverageKeys)})
  `;
  return new Map(rows.map((row) => [row.coverageKey, row.granularityMode]));
}

export function canonicalUsageLossMeter(meter: string): string {
  const normalized = meter.trim().toUpperCase().replace(/[ .-]+/g, '_');
  if (['INPUT', 'REGULAR_INPUT', 'PROMPT', 'PROMPT_TOKENS'].includes(normalized)) {
    return 'INPUT';
  }
  if (['OUTPUT', 'COMPLETION', 'COMPLETION_TOKENS'].includes(normalized)) {
    return 'OUTPUT';
  }
  if (['CACHE', 'CACHE_READ', 'CACHED_INPUT', 'CACHE_HIT'].includes(normalized)) {
    return 'CACHE';
  }
  if (['CACHE_WRITE', 'CACHE_CREATION'].includes(normalized)) {
    return 'CACHE_WRITE';
  }
  if (['TOTAL', 'TOTAL_TOKENS'].includes(normalized)) return 'TOTAL';
  return normalized;
}

function base64(value: string): string {
  return Buffer.from(value, 'utf8').toString('base64');
}

function parseStoredRecognitionKeys(value: unknown): Array<{ type: string; key: string }> {
  if (!Array.isArray(value) || value.length === 0) {
    throw new ConflictException('历史差额行缺少 recognition keys');
  }
  return value.map((item) => {
    if (!isObject(item)) throw new ConflictException('历史差额 recognition key 格式损坏');
    return {
      type: requiredString(item.type, 'recognitionKeys.type'),
      key: requiredString(item.key, 'recognitionKeys.key', 2000),
    };
  });
}

function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (value instanceof Date) return JSON.stringify(value.toISOString());
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as JsonObject)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

function roundMoney(value: Prisma.Decimal): Prisma.Decimal {
  return value.toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
}

function decimalString(value: Prisma.Decimal.Value): string {
  return new Prisma.Decimal(value).toFixed(12);
}

function decimalIntegerString(value: Prisma.Decimal.Value): string {
  const parsed = new Prisma.Decimal(value);
  if (!parsed.isInteger() || parsed.lt(0)) throw new ConflictException('历史用量必须为非负整数');
  return parsed.toFixed(0);
}

function signedDecimalIntegerString(value: Prisma.Decimal.Value): string {
  const parsed = new Prisma.Decimal(value);
  if (!parsed.isInteger()) throw new ConflictException('历史用量差必须为整数');
  return parsed.toFixed(0);
}

function nonNegativeIntegerDecimal(value: unknown, field: string): Prisma.Decimal {
  try {
    const parsed = new Prisma.Decimal(String(value));
    if (!parsed.isInteger() || parsed.lt(0)) throw new Error('invalid');
    return parsed;
  } catch {
    throw new LineBlockedError('INVALID_USAGE', `${field} 必须为非负整数字符串`);
  }
}

function moneyDecimal(value: unknown, field: string): Prisma.Decimal {
  try {
    const parsed = new Prisma.Decimal(String(value));
    if (!parsed.isFinite() || parsed.lt(0) || parsed.decimalPlaces() > 12) throw new Error('invalid');
    return parsed;
  } catch {
    throw new LineBlockedError('INVALID_VALUATION_RATE', `${field} 必须为最多 12 位小数的非负数`);
  }
}

function positiveDecimal(value: unknown, field: string): Prisma.Decimal {
  try {
    const parsed = new Prisma.Decimal(String(value));
    if (!parsed.isFinite() || parsed.lte(0) || parsed.decimalPlaces() > 12) throw new Error('invalid');
    return parsed;
  } catch {
    throw new BadRequestException(`${field} 必须为最多 12 位小数的正数`);
  }
}

function dateOnly(value: unknown, field: string): string {
  const raw = requiredString(value, field);
  if (!/^\d{4}-\d{2}-\d{2}$/.test(raw)) {
    throw new LineBlockedError('INVALID_SERVICE_DATE', `${field} 必须为 YYYY-MM-DD`);
  }
  const parsed = new Date(`${raw}T00:00:00.000Z`);
  if (Number.isNaN(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== raw) {
    throw new LineBlockedError('INVALID_SERVICE_DATE', `${field} 不是有效日期`);
  }
  return raw;
}

function requiredDate(value: unknown, field: string): Date {
  if (typeof value !== 'string' && !(value instanceof Date)) {
    throw new BadRequestException(`${field} 必须为 ISO 时间`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) throw new BadRequestException(`${field} 必须为有效 ISO 时间`);
  return date;
}

function optionalDate(value: unknown, field: string): Date | null {
  if (value === undefined || value === null || value === '') return null;
  return requiredDate(value, field);
}

function requiredString(value: unknown, field: string, max = 500): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new BadRequestException(`${field} 不能为空`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) throw new BadRequestException(`${field} 过长`);
  return trimmed;
}

function lineRequiredString(value: unknown, field: string, max = 500): string {
  if (typeof value !== 'string' || !value.trim()) {
    throw new LineBlockedError('INVALID_SOURCE_LINE', `${field} 不能为空`);
  }
  const trimmed = value.trim();
  if (trimmed.length > max) {
    throw new LineBlockedError('INVALID_SOURCE_LINE', `${field} 过长`);
  }
  return trimmed;
}

function lineRequiredDate(value: unknown, field: string): Date {
  if (typeof value !== 'string' && !(value instanceof Date)) {
    throw new LineBlockedError('INVALID_PRICING_EVIDENCE_DATE', `${field} 必须为 ISO 时间`);
  }
  const date = new Date(value);
  if (Number.isNaN(date.getTime())) {
    throw new LineBlockedError('INVALID_PRICING_EVIDENCE_DATE', `${field} 必须为有效 ISO 时间`);
  }
  return date;
}

function optionalString(value: unknown): string | null {
  return typeof value === 'string' && value.trim() ? value.trim() : null;
}

function requiredInteger(value: unknown, field: string): number {
  const parsed = typeof value === 'number' ? value : Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < 0) {
    throw new BadRequestException(`${field} 必须为非负整数`);
  }
  return parsed;
}

function optionalPositiveInteger(value: unknown, fallback: number): number {
  if (value === undefined || value === null || value === '') return fallback;
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed <= 0) throw new BadRequestException('分页参数无效');
  return parsed;
}

function sha256String(value: unknown, field: string): string {
  const parsed = requiredString(value, field, 64).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(parsed)) throw new BadRequestException(`${field} 必须为 SHA-256 hex`);
  return parsed;
}

function sha256LineString(value: unknown, field: string): string {
  if (typeof value !== 'string' || !/^[0-9a-fA-F]{64}$/.test(value.trim())) {
    throw new LineBlockedError('INVALID_PRICING_EVIDENCE_HASH', `${field} 必须为 SHA-256 hex`);
  }
  return value.trim().toLowerCase();
}

function lineObject(
  value: unknown,
  field: string,
  code: string,
): JsonObject {
  if (!isObject(value) || Object.keys(value).length === 0) {
    throw new LineBlockedError(code, `${field} 必须为非空对象`);
  }
  return value;
}

function normalizedOptionalMoney(value: unknown): string | null {
  if (value === undefined || value === null || value === '') return null;
  try {
    const parsed = new Prisma.Decimal(String(value));
    if (!parsed.isFinite() || parsed.lt(0) || parsed.decimalPlaces() > 12) return null;
    return parsed.toFixed(12);
  } catch {
    return null;
  }
}

function normalizedOptionalDate(value: unknown): string | null {
  if (typeof value !== 'string' && !(value instanceof Date)) return null;
  const parsed = new Date(value);
  return Number.isNaN(parsed.getTime()) ? null : parsed.toISOString();
}

function asObject(value: unknown, field: string): JsonObject {
  if (!isObject(value)) throw new BadRequestException(`${field} 必须为对象`);
  return value;
}

function isObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function isUniqueViolation(error: unknown): boolean {
  return error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002';
}
