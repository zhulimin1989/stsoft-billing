import { ConflictException } from '@nestjs/common';
import { Prisma } from '@prisma/client';
import { createHash } from 'crypto';
import {
  HistoricalPlatformLossBatchService,
  requestRecognitionKey,
  reserveUsageLossCoverage,
  type HistoricalPlatformLossBatchInput,
  usageLossCoverageIdentity,
} from './historical-platform-loss-batch.service';

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.entries(value as Record<string, unknown>)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

function sha(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

function buildLine(overrides: Record<string, unknown> = {}): Record<string, any> {
  const serviceDate = String(overrides.serviceDate ?? '2026-07-01');
  const model = String(overrides.model ?? 'glm-5.2');
  const meter = String(overrides.meter ?? 'INPUT');
  const customerRatePerMillion = String(overrides.customerRatePerMillion ?? '2');
  const providerCostRatePerMillion = String(overrides.providerCostRatePerMillion ?? '1');
  const pricingEvidence = {
    sourceRef: 'finance://pricing/glm-5.2/2026-07-v1',
    documentSha256: 'a'.repeat(64),
    version: 'glm-july-v1',
    model,
    meter,
    pricingCurrency: 'USD',
    customerRatePerMillion,
    providerCostRatePerMillion,
    effectiveFrom: '2026-07-01',
    effectiveTo: '2026-08-01',
    approvedBy: 'pricing-finance-1',
    approvedAt: '2026-06-30T08:00:00.000Z',
  };
  return {
    lineType: 'PROVIDER_AGGREGATE',
    providerAggregateRef: `${serviceDate}|${model}|${meter}`,
    sourceRowRef: `sheet1!${meter}`,
    sourceEvidence: {
      serviceDate,
      model,
      meter,
      providerUsage: String(overrides.providerUsage ?? '2000000'),
      platformUsage: String(overrides.platformUsage ?? '1000000'),
      workbookColumn: '智谱token/平台token',
    },
    serviceDate,
    model,
    meter,
    platformUsage: String(overrides.platformUsage ?? '1000000'),
    providerUsage: String(overrides.providerUsage ?? '2000000'),
    valuationBasis: {
      version: 'glm-july-v1',
      rateUnit: 'TOKENS_PER_MILLION',
      pricingCurrency: 'USD',
      customerRatePerMillion,
      providerCostRatePerMillion,
      pricingSourceRef: pricingEvidence.sourceRef,
      pricingDocumentSha256: pricingEvidence.documentSha256,
      pricingEvidenceHash: sha(pricingEvidence),
      pricingEffectiveFrom: pricingEvidence.effectiveFrom,
      pricingEffectiveTo: pricingEvidence.effectiveTo,
      pricingApprovedBy: pricingEvidence.approvedBy,
      pricingApprovedAt: pricingEvidence.approvedAt,
      pricingEvidence,
    },
    ...overrides,
  };
}

function buildInput(
  lines: Array<Record<string, unknown>> = [buildLine()],
): HistoricalPlatformLossBatchInput {
  return {
    provider: 'zhipu',
    providerAccountRef: 'overseas-prod-1',
    region: 'overseas',
    periodStart: '2026-07-01T00:00:00.000Z',
    periodEnd: '2026-08-01T00:00:00.000Z',
    currency: 'USD',
    sourceFileRef: 'finance://provider-statements/2026-07/zhipu.xlsx',
    sourceFileSha256: 'c41e1b7595486547d639420e92d52a737c5b6909f91d4851b412b2c481feeab6',
    calculationMethod: 'TOKEN_RATE_PER_MILLION_V1',
    roundingPolicy: 'HALF_UP_12',
    reason: '2026 年 7 月历史 Token 少计由平台承担',
    lines,
  };
}

function createPrismaMock() {
  const coverageRegistry = new Map<string, Record<string, unknown>>();
  const prisma: any = {
    usageLossRecognitionClaim: {
      findMany: jest.fn().mockResolvedValue([]),
      create: jest.fn().mockResolvedValue({ id: 'claim' }),
    },
    gatewayBillingEvent: { findUnique: jest.fn() },
    historicalPlatformLossBatch: {
      findUnique: jest.fn(),
      findMany: jest.fn(),
      count: jest.fn(),
      create: jest.fn(),
      updateMany: jest.fn(),
    },
    historicalPlatformLossAction: {
      findUnique: jest.fn().mockResolvedValue(null),
      create: jest.fn(),
    },
    billingAccessRestriction: { updateMany: jest.fn().mockResolvedValue({ count: 0 }) },
    tokenUsage: { update: jest.fn(), create: jest.fn() },
    balanceTransaction: { update: jest.fn(), create: jest.fn() },
    gatewayUsageSettlementReceipt: { update: jest.fn(), create: jest.fn() },
    $executeRaw: jest.fn().mockImplementation(async (strings: TemplateStringsArray, ...values: any[]) => {
      const sql = Array.from(strings).join('?');
      if (sql.includes('INSERT INTO "usage_loss_coverage_registry"')) {
        const [id, coverageKey, provider, providerAccountRef, region, serviceDate, model, meter, granularityMode] = values;
        if (!coverageRegistry.has(coverageKey)) {
          coverageRegistry.set(coverageKey, {
            id,
            coverageKey,
            provider,
            providerAccountRef,
            region,
            serviceDate,
            model,
            meter,
            granularityMode,
          });
        }
      }
      return 1;
    }),
    $queryRaw: jest.fn().mockImplementation(async (strings: TemplateStringsArray, ...values: any[]) => {
      const sql = Array.from(strings).join('?');
      if (sql.includes('FROM "usage_loss_coverage_registry"') && sql.includes('FOR UPDATE')) {
        const stored = coverageRegistry.get(values[0]);
        return stored ? [stored] : [];
      }
      if (sql.includes('FROM "usage_loss_coverage_registry"')) {
        return [...coverageRegistry.values()].map((row) => ({
          coverageKey: row.coverageKey,
          granularityMode: row.granularityMode,
        }));
      }
      return [];
    }),
    __coverageRegistry: coverageRegistry,
  };
  prisma.$transaction = jest.fn(async (value: any) => {
    if (typeof value === 'function') return value(prisma);
    return Promise.all(value);
  });
  return prisma;
}

function immutableHistoricalGatewayEvent(overrides: Record<string, unknown> = {}) {
  return {
    id: 'event-1',
    requestId: 'request-1',
    upstreamRequestId: 'upstream-1',
    status: 'DEDUCTED',
    occurredAt: new Date('2026-07-01T12:00:00.000Z'),
    modelName: 'glm-5.2',
    inputTokens: 1_000_000,
    outputTokens: 1_000_000,
    cachedInputTokens: 1_000_000,
    cacheWriteInputTokens: 1_000_000,
    totalTokens: 4_000_000,
    rawEvent: {
      provider: 'zhipu',
      provider_account_ref: 'overseas-prod-1',
      provider_credential_ref: 'overseas-prod-1',
      upstream_request_id: 'upstream-1',
      labels: { region: 'overseas' },
    },
    settlementAnchor: null,
    ...overrides,
  };
}

function storedFromPreview(preview: any, overrides: Record<string, unknown> = {}) {
  const now = new Date('2026-08-06T00:00:00.000Z');
  const batch: any = {
    id: 'historical-batch-1',
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
    exchangeRate: preview.exchangeRate,
    exchangeRateSource: preview.exchangeRateSource,
    exchangeRateSourceCurrency: preview.exchangeRateSourceCurrency,
    exchangeRateAsOf: preview.exchangeRateAsOf,
    platformAmountBefore: new Prisma.Decimal(preview.totals.platformAmountBefore),
    platformAmountCorrected: new Prisma.Decimal(preview.totals.platformAmountCorrected),
    customerAbsorbedDelta: new Prisma.Decimal(preview.totals.customerAbsorbedDelta),
    customerDeduction: new Prisma.Decimal(0),
    providerCostBefore: new Prisma.Decimal(preview.totals.providerCostBefore),
    providerCostCorrected: new Prisma.Decimal(preview.totals.providerCostCorrected),
    providerCostDelta: new Prisma.Decimal(preview.totals.providerCostDelta),
    itemCount: preview.itemCount,
    fingerprint: preview.fingerprint,
    revision: 0,
    status: 'PREPARED',
    reason: preview.reason,
    makerActorId: 'maker-1',
    checkerActorId: null,
    postedByActorId: null,
    createIdempotencyKey: 'create-1',
    postIdempotencyKey: null,
    approvedAt: null,
    postedAt: null,
    createdAt: now,
    updatedAt: now,
    lines: preview.lines.map((line: any) => ({
      id: `line-${line.lineNumber}`,
      batchId: 'historical-batch-1',
      ...line,
      serviceDate: new Date(`${line.serviceDate}T00:00:00.000Z`),
      modelName: line.model,
      platformUsage: new Prisma.Decimal(line.platformUsage),
      providerUsage: new Prisma.Decimal(line.providerUsage),
      usageDelta: new Prisma.Decimal(line.usageDelta),
      platformAmountBefore: new Prisma.Decimal(line.platformAmountBefore),
      platformAmountCorrected: new Prisma.Decimal(line.platformAmountCorrected),
      customerAbsorbedDelta: new Prisma.Decimal(line.customerAbsorbedDelta),
      customerDeduction: new Prisma.Decimal(0),
      providerCostBefore: new Prisma.Decimal(line.providerCostBefore),
      providerCostCorrected: new Prisma.Decimal(line.providerCostCorrected),
      providerCostDelta: new Prisma.Decimal(line.providerCostDelta),
      createdAt: now,
    })),
    actions: [
      {
        id: 'prepare-action',
        batchId: 'historical-batch-1',
        action: 'PREPARE',
        expectedRevision: -1,
        resultingRevision: 0,
        actorId: 'maker-1',
        reason: preview.reason,
        idempotencyKey: 'prepare:create-1',
        metadata: { fingerprint: preview.fingerprint },
        createdAt: now,
      },
    ],
    ...overrides,
  };
  return batch;
}

describe('HistoricalPlatformLossBatchService', () => {
  it('server-values provider aggregate tokens from hash-bound historical pricing evidence', async () => {
    const prisma = createPrismaMock();
    const service = new HistoricalPlatformLossBatchService(prisma);

    const result = await service.preview(buildInput());

    expect(result.status).toBe('READY');
    expect(result.totals).toEqual({
      platformAmountBefore: '2.000000000000',
      platformAmountCorrected: '4.000000000000',
      customerAbsorbedDelta: '2.000000000000',
      customerDeduction: '0.000000000000',
      providerCostBefore: '1.000000000000',
      providerCostCorrected: '2.000000000000',
      providerCostDelta: '1.000000000000',
    });
    expect(result.lines[0].usageDelta).toBe('1000000');
    expect(result.lines[0].recognitionKeys.map((claim) => claim.type)).toEqual([
      'PROVIDER_AGGREGATE_SOURCE',
      'PROVIDER_AGGREGATE_COVERAGE',
    ]);
  });

  it.each([
    ['2026-06-30', 'before periodStart'],
    ['2026-08-01', 'at the exclusive periodEnd'],
  ])('blocks serviceDate %s when it is %s', async (serviceDate) => {
    const prisma = createPrismaMock();
    const service = new HistoricalPlatformLossBatchService(prisma);

    const result = await service.preview(buildInput([buildLine({ serviceDate })]));

    expect(result.status).toBe('BLOCKED');
    expect(result.fingerprint).toBeNull();
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({
        lineNumber: 1,
        code: 'SERVICE_DATE_OUTSIDE_BATCH_PERIOD',
      }),
    ]));
  });

  it('BLOCKS a gain-only batch from being posted as platform loss', async () => {
    const prisma = createPrismaMock();
    const service = new HistoricalPlatformLossBatchService(prisma);
    const result = await service.preview(buildInput([
      buildLine({
        platformUsage: '2000000',
        providerUsage: '1000000',
        customerRatePerMillion: '0',
        providerCostRatePerMillion: '1',
      }),
    ]));

    expect(result.status).toBe('BLOCKED');
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'NO_POSITIVE_PLATFORM_LOSS' }),
    ]));
  });

  it('BLOCKS a naked or hash-mismatched pricing rate instead of accepting a bare total', async () => {
    const prisma = createPrismaMock();
    const service = new HistoricalPlatformLossBatchService(prisma);
    const line = buildLine();
    (line.valuationBasis as any).pricingEvidenceHash = '0'.repeat(64);

    const result = await service.preview(buildInput([line]));

    expect(result.status).toBe('BLOCKED');
    expect(result.fingerprint).toBeNull();
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PRICING_EVIDENCE_HASH_MISMATCH' }),
    ]));
  });

  it('BLOCKS pricing evidence outside the service-date effective window', async () => {
    const prisma = createPrismaMock();
    const service = new HistoricalPlatformLossBatchService(prisma);
    const line = buildLine();
    const basis = line.valuationBasis as Record<string, any>;
    basis.pricingEffectiveFrom = '2026-07-02';
    basis.pricingEvidence = {
      ...basis.pricingEvidence,
      effectiveFrom: '2026-07-02',
    };
    basis.pricingEvidenceHash = sha(basis.pricingEvidence);

    const result = await service.preview(buildInput([line]));

    expect(result.status).toBe('BLOCKED');
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'PRICING_NOT_EFFECTIVE_FOR_SERVICE_DATE' }),
    ]));
  });

  it('accepts a DEDUCTED request without an anchor and allows INPUT/CACHE/OUTPUT to share claims', async () => {
    const prisma = createPrismaMock();
    prisma.gatewayBillingEvent.findUnique.mockResolvedValue(immutableHistoricalGatewayEvent());
    const service = new HistoricalPlatformLossBatchService(prisma);
    const lines = ['INPUT', 'CACHE', 'OUTPUT'].map((meter, index) => ({
      ...buildLine({ meter, providerUsage: String(2_000_000 + index) }),
      lineType: 'MISSING_ANCHOR_REQUEST',
      requestId: 'request-1',
      upstreamRequestId: 'upstream-1',
      providerAggregateRef: undefined,
      sourceRowRef: `sheet1!${meter}`,
    }));

    const result = await service.preview(buildInput(lines));

    expect(result.status).toBe('READY');
    expect(result.lines).toHaveLength(3);
    expect(result.lines.every((line) => line.gatewayBillingEventId === 'event-1')).toBe(true);
  });

  it.each([
    [
      'occurredAt/serviceDate',
      { occurredAt: new Date('2026-07-02T00:00:00.000Z') },
      {},
      'REQUEST_EVENT_SERVICE_DATE_MISMATCH',
    ],
    [
      'provider',
      { rawEvent: { provider: 'other', provider_account_ref: 'overseas-prod-1', labels: { region: 'overseas' } } },
      {},
      'REQUEST_EVENT_PROVIDER_IDENTITY_MISMATCH',
    ],
    [
      'provider account',
      { rawEvent: { provider: 'zhipu', provider_account_ref: 'other-account', labels: { region: 'overseas' } } },
      {},
      'REQUEST_EVENT_PROVIDER_IDENTITY_MISMATCH',
    ],
    [
      'region',
      { rawEvent: { provider: 'zhipu', provider_account_ref: 'overseas-prod-1', labels: { region: 'domestic' } } },
      {},
      'REQUEST_EVENT_PROVIDER_IDENTITY_MISMATCH',
    ],
    ['model', { modelName: 'glm-other' }, {}, 'REQUEST_EVENT_MODEL_MISMATCH'],
    ['token dimension', { inputTokens: 999_999 }, {}, 'REQUEST_EVENT_PLATFORM_USAGE_MISMATCH'],
    ['upstream request', { upstreamRequestId: null }, {}, 'UPSTREAM_REQUEST_ID_MISMATCH'],
  ])('fails request-level recognition closed on %s mismatch', async (
    _name,
    eventOverrides,
    lineOverrides,
    code,
  ) => {
    const prisma = createPrismaMock();
    prisma.gatewayBillingEvent.findUnique.mockResolvedValue(
      immutableHistoricalGatewayEvent(eventOverrides as Record<string, unknown>),
    );
    const service = new HistoricalPlatformLossBatchService(prisma);
    const result = await service.preview(buildInput([{
      ...buildLine(lineOverrides as Record<string, unknown>),
      lineType: 'MISSING_ANCHOR_REQUEST',
      requestId: 'request-1',
      upstreamRequestId: 'upstream-1',
      providerAggregateRef: undefined,
    }]));

    expect(result.status).toBe('BLOCKED');
    expect(result.fingerprint).toBeNull();
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code }),
    ]));
  });

  it('routes an old request with incomplete immutable provider identity to aggregate-only review', async () => {
    const prisma = createPrismaMock();
    prisma.gatewayBillingEvent.findUnique.mockResolvedValue(
      immutableHistoricalGatewayEvent({ rawEvent: { provider: 'zhipu' } }),
    );
    const service = new HistoricalPlatformLossBatchService(prisma);
    const result = await service.preview(buildInput([{
      ...buildLine(),
      lineType: 'MISSING_ANCHOR_REQUEST',
      requestId: 'request-1',
      upstreamRequestId: 'upstream-1',
      providerAggregateRef: undefined,
    }]));

    expect(result.status).toBe('BLOCKED');
    expect(result.issues[0]).toEqual(expect.objectContaining({
      code: 'REQUEST_EVENT_EVIDENCE_INCOMPLETE',
      action: 'USE_PROVIDER_AGGREGATE',
    }));
  });

  it('BLOCKS requests with anchors and points finance to absorb-delta', async () => {
    const prisma = createPrismaMock();
    prisma.gatewayBillingEvent.findUnique.mockResolvedValue(immutableHistoricalGatewayEvent({
      settlementAnchor: { id: 'anchor-1' },
    }));
    const service = new HistoricalPlatformLossBatchService(prisma);
    const line = {
      ...buildLine(),
      lineType: 'MISSING_ANCHOR_REQUEST',
      requestId: 'request-1',
      providerAggregateRef: undefined,
    };

    const result = await service.preview(buildInput([line]));

    expect(result.status).toBe('BLOCKED');
    expect(result.issues[0]).toEqual(expect.objectContaining({
      code: 'SETTLEMENT_ANCHOR_PRESENT',
      action: 'USE_ABSORB_DELTA',
    }));
  });

  it.each(['SKIPPED', 'FAILED'])('BLOCKS %s requests from financial recognition', async (status) => {
    const prisma = createPrismaMock();
    prisma.gatewayBillingEvent.findUnique.mockResolvedValue(immutableHistoricalGatewayEvent({
      status,
    }));
    const service = new HistoricalPlatformLossBatchService(prisma);
    const result = await service.preview(buildInput([{
      ...buildLine(),
      lineType: 'MISSING_ANCHOR_REQUEST',
      requestId: 'request-1',
      providerAggregateRef: undefined,
    }]));

    expect(result.status).toBe('BLOCKED');
    expect(result.issues[0].code).toBe('GATEWAY_EVENT_NOT_HISTORICAL_TERMINAL');
  });

  it('BLOCKS aggregate recognition after a per-request absorb-delta reserved the coverage mode', async () => {
    const prisma = createPrismaMock();
    const service = new HistoricalPlatformLossBatchService(prisma);
    const coverage = usageLossCoverageIdentity(
      'zhipu',
      'overseas-prod-1',
      'overseas',
      '2026-07-01',
      'glm-5.2',
      'INPUT',
    );
    await reserveUsageLossCoverage(prisma, coverage, 'REQUEST');

    const replay = await service.preview(buildInput());

    expect(replay.status).toBe('BLOCKED');
    expect(replay.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'CROSS_GRANULARITY_COVERAGE_ALREADY_CLAIMED' }),
    ]));
  });

  it('allows multiple distinct request claims to share one REQUEST coverage mode', async () => {
    const prisma = createPrismaMock();
    const coverage = usageLossCoverageIdentity(
      'zhipu',
      'overseas-prod-1',
      'overseas',
      '2026-07-01',
      'glm-5.2',
      'INPUT',
    );

    for (const requestId of ['request-a', 'request-b']) {
      await expect(reserveUsageLossCoverage(prisma, coverage, 'REQUEST')).resolves.toBeUndefined();
      await prisma.usageLossRecognitionClaim.create({
        data: {
          recognitionKey: requestRecognitionKey(requestId),
          recognitionType: 'REQUEST_ID',
          claimSource: 'ABSORB_DELTA',
          gatewayBillingEventId: `event-${requestId}`,
          gatewayUsagePlatformLossId: `loss-${requestId}`,
        },
      });
    }
    expect(prisma.__coverageRegistry.size).toBe(1);
    expect(prisma.usageLossRecognitionClaim.create).toHaveBeenCalledTimes(2);
  });

  it.each([
    ['REQUEST', 'AGGREGATE'],
    ['AGGREGATE', 'REQUEST'],
  ] as const)('rejects cross-granularity coverage in %s -> %s order', async (first, second) => {
    const prisma = createPrismaMock();
    const coverage = usageLossCoverageIdentity(
      'zhipu',
      'overseas-prod-1',
      'overseas',
      '2026-07-01',
      'glm-5.2',
      'INPUT',
    );

    await reserveUsageLossCoverage(prisma, coverage, first);
    await expect(reserveUsageLossCoverage(prisma, coverage, second))
      .rejects.toThrow('禁止再按');
  });

  it('atomically leaves only one granularity mode under a concurrent race', async () => {
    const prisma = createPrismaMock();
    const coverage = usageLossCoverageIdentity(
      'zhipu',
      'overseas-prod-1',
      'overseas',
      '2026-07-01',
      'glm-5.2',
      'INPUT',
    );

    const outcomes = await Promise.allSettled([
      reserveUsageLossCoverage(prisma, coverage, 'REQUEST'),
      reserveUsageLossCoverage(prisma, coverage, 'AGGREGATE'),
    ]);

    expect(outcomes.filter((outcome) => outcome.status === 'fulfilled')).toHaveLength(1);
    expect(outcomes.filter((outcome) => outcome.status === 'rejected')).toHaveLength(1);
    expect(prisma.__coverageRegistry.size).toBe(1);
  });

  it('cannot bypass aggregate coverage by renaming aggregateRef or source row', async () => {
    const prisma = createPrismaMock();
    const service = new HistoricalPlatformLossBatchService(prisma);
    const first = await service.preview(buildInput());
    const coverage = first.lines[0].recognitionKeys.find(
      (claim) => claim.type === 'PROVIDER_AGGREGATE_COVERAGE',
    )!;
    prisma.usageLossRecognitionClaim.findMany.mockResolvedValue([
      { recognitionKey: coverage.key, claimSource: 'HISTORICAL_BATCH' },
    ]);
    const renamed = buildLine({
      providerAggregateRef: 'operator-renamed-row',
      sourceRowRef: 'sheet1!renamed',
      sourceEvidence: { independentlyReexported: true },
    });

    const result = await service.preview(buildInput([renamed]));

    expect(result.status).toBe('BLOCKED');
    expect(result.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ code: 'RECOGNITION_ALREADY_CLAIMED' }),
    ]));
  });

  it('rejects a changed preview fingerprint before writing', async () => {
    const prisma = createPrismaMock();
    prisma.historicalPlatformLossBatch.findUnique.mockResolvedValue(null);
    const service = new HistoricalPlatformLossBatchService(prisma);

    await expect(service.create({
      ...buildInput(),
      expectedFingerprint: '0'.repeat(64),
      idempotencyKey: 'create-1',
    }, 'maker-1')).rejects.toThrow(ConflictException);
    expect(prisma.historicalPlatformLossBatch.create).not.toHaveBeenCalled();
  });

  it('creates only immutable management facts and never touches customer funding facts', async () => {
    const prisma = createPrismaMock();
    const service = new HistoricalPlatformLossBatchService(prisma);
    const preview = await service.preview(buildInput());
    const stored = storedFromPreview(preview);
    prisma.historicalPlatformLossBatch.findUnique.mockResolvedValue(null);
    prisma.historicalPlatformLossBatch.create.mockResolvedValue(stored);

    const result = await service.create({
      ...buildInput(),
      expectedFingerprint: preview.fingerprint,
      idempotencyKey: 'create-1',
    }, 'maker-1');

    expect(result.status).toBe('PREPARED');
    expect(prisma.tokenUsage.update).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
    expect(prisma.gatewayUsageSettlementReceipt.update).not.toHaveBeenCalled();
  });

  it('enforces maker-checker before any claim or restriction release', async () => {
    const prisma = createPrismaMock();
    const service = new HistoricalPlatformLossBatchService(prisma);
    const preview = await service.preview(buildInput());
    const stored = storedFromPreview(preview);
    prisma.historicalPlatformLossBatch.findUnique.mockResolvedValue(stored);

    await expect(service.approveAndPost(stored.id, {
      expectedRevision: 0,
      expectedFingerprint: stored.fingerprint,
      reason: 'finance approval',
      idempotencyKey: 'post-1',
    }, 'maker-1')).rejects.toThrow('maker-checker');
    expect(prisma.usageLossRecognitionClaim.create).not.toHaveBeenCalled();
    expect(prisma.billingAccessRestriction.updateMany).not.toHaveBeenCalled();
  });

  it('posts once with CAS, permanent recognition and only narrow restriction releases', async () => {
    const prisma = createPrismaMock();
    const service = new HistoricalPlatformLossBatchService(prisma);
    const preview = await service.preview(buildInput());
    const prepared = storedFromPreview(preview);
    let posted = false;
    prisma.historicalPlatformLossBatch.findUnique.mockImplementation(async () => posted
      ? storedFromPreview(preview, {
        status: 'POSTED',
        revision: 1,
        checkerActorId: 'checker-1',
        postedByActorId: 'checker-1',
        postIdempotencyKey: 'post-1',
        approvedAt: new Date('2026-08-07T00:00:00.000Z'),
        postedAt: new Date('2026-08-07T00:00:00.000Z'),
        actions: [...prepared.actions, {
          id: 'post-action',
          batchId: prepared.id,
          action: 'APPROVE_AND_POST',
          expectedRevision: 0,
          resultingRevision: 1,
          actorId: 'checker-1',
          reason: 'finance approval',
          idempotencyKey: 'post-1',
          metadata: { fingerprint: prepared.fingerprint },
          createdAt: new Date('2026-08-07T00:00:00.000Z'),
        }],
      })
      : prepared);
    prisma.historicalPlatformLossBatch.updateMany.mockImplementation(async () => {
      posted = true;
      return { count: 1 };
    });
    prisma.historicalPlatformLossAction.create.mockResolvedValue({ id: 'post-action' });

    const result = await service.approveAndPost(prepared.id, {
      expectedRevision: 0,
      expectedFingerprint: prepared.fingerprint,
      reason: 'finance approval',
      idempotencyKey: 'post-1',
    }, 'checker-1');

    expect(result.status).toBe('POSTED');
    expect(prisma.usageLossRecognitionClaim.create).toHaveBeenCalledTimes(2);
    // Aggregate-only rows have no event ids, so no restriction mutation occurs.
    expect(prisma.billingAccessRestriction.updateMany).not.toHaveBeenCalled();
    expect(prisma.tokenUsage.update).not.toHaveBeenCalled();
    expect(prisma.balanceTransaction.create).not.toHaveBeenCalled();
  });

  it('keeps request restrictions fail-closed when only one meter is recognized', async () => {
    const prisma = createPrismaMock();
    prisma.gatewayBillingEvent.findUnique.mockResolvedValue(immutableHistoricalGatewayEvent());
    const service = new HistoricalPlatformLossBatchService(prisma);
    const preview = await service.preview(buildInput([{
      ...buildLine(),
      lineType: 'MISSING_ANCHOR_REQUEST',
      requestId: 'request-1',
      upstreamRequestId: 'upstream-1',
      providerAggregateRef: undefined,
    }]));
    const prepared = storedFromPreview(preview);
    let posted = false;
    prisma.historicalPlatformLossBatch.findUnique.mockImplementation(async () => posted
      ? storedFromPreview(preview, {
        status: 'POSTED', revision: 1, checkerActorId: 'checker-1',
        postedByActorId: 'checker-1', postIdempotencyKey: 'post-request-1',
        approvedAt: new Date(), postedAt: new Date(),
      })
      : prepared);
    prisma.historicalPlatformLossBatch.updateMany.mockImplementation(async () => {
      posted = true;
      return { count: 1 };
    });

    await service.approveAndPost(prepared.id, {
      expectedRevision: 0,
      expectedFingerprint: prepared.fingerprint,
      reason: 'finance approval',
      idempotencyKey: 'post-request-1',
    }, 'checker-1');

    expect(prisma.billingAccessRestriction.updateMany).not.toHaveBeenCalled();
  });

  it('keeps request restrictions fail-closed even when several meters are in the batch', async () => {
    const prisma = createPrismaMock();
    prisma.gatewayBillingEvent.findUnique.mockResolvedValue(immutableHistoricalGatewayEvent());
    const service = new HistoricalPlatformLossBatchService(prisma);
    const preview = await service.preview(buildInput(['INPUT', 'CACHE'].map((meter, index) => ({
      ...buildLine({ meter, providerUsage: String(2_000_000 + index) }),
      lineType: 'MISSING_ANCHOR_REQUEST',
      requestId: 'request-1',
      upstreamRequestId: 'upstream-1',
      providerAggregateRef: undefined,
      sourceRowRef: `sheet1!partial-${meter}`,
    }))));
    const prepared = storedFromPreview(preview);
    let posted = false;
    prisma.historicalPlatformLossBatch.findUnique.mockImplementation(async () => posted
      ? storedFromPreview(preview, {
        status: 'POSTED', revision: 1, checkerActorId: 'checker-1',
        postedByActorId: 'checker-1', postIdempotencyKey: 'post-partial-meters-1',
        approvedAt: new Date(), postedAt: new Date(),
      })
      : prepared);
    prisma.historicalPlatformLossBatch.updateMany.mockImplementation(async () => {
      posted = true;
      return { count: 1 };
    });

    await service.approveAndPost(prepared.id, {
      expectedRevision: 0,
      expectedFingerprint: prepared.fingerprint,
      reason: 'finance approval does not prove every request dimension',
      idempotencyKey: 'post-partial-meters-1',
    }, 'checker-1');

    expect(prisma.billingAccessRestriction.updateMany).not.toHaveBeenCalled();
  });

  it('detects stored line/fingerprint tampering before posting', async () => {
    const prisma = createPrismaMock();
    const service = new HistoricalPlatformLossBatchService(prisma);
    const preview = await service.preview(buildInput());
    const stored = storedFromPreview(preview);
    stored.lines[0].lineHash = 'f'.repeat(64);
    prisma.historicalPlatformLossBatch.findUnique.mockResolvedValue(stored);

    await expect(service.approveAndPost(stored.id, {
      expectedRevision: 0,
      expectedFingerprint: stored.fingerprint,
      reason: 'finance approval',
      idempotencyKey: 'post-1',
    }, 'checker-1')).rejects.toThrow('hash 校验失败');
    expect(prisma.usageLossRecognitionClaim.create).not.toHaveBeenCalled();
  });

  it('rejects a CAS miss and does not report POSTED', async () => {
    const prisma = createPrismaMock();
    const service = new HistoricalPlatformLossBatchService(prisma);
    const preview = await service.preview(buildInput());
    const stored = storedFromPreview(preview);
    prisma.historicalPlatformLossBatch.findUnique.mockResolvedValue(stored);
    prisma.historicalPlatformLossBatch.updateMany.mockResolvedValue({ count: 0 });

    await expect(service.approveAndPost(stored.id, {
      expectedRevision: 0,
      expectedFingerprint: stored.fingerprint,
      reason: 'finance approval',
      idempotencyKey: 'post-1',
    }, 'checker-1')).rejects.toThrow(ConflictException);
  });

  it('maps a concurrent global recognition claim to a deterministic conflict', async () => {
    const prisma = createPrismaMock();
    const service = new HistoricalPlatformLossBatchService(prisma);
    const preview = await service.preview(buildInput());
    const stored = storedFromPreview(preview);
    prisma.historicalPlatformLossBatch.findUnique.mockResolvedValue(stored);
    prisma.usageLossRecognitionClaim.create.mockRejectedValue(
      new Prisma.PrismaClientKnownRequestError('recognition key unique', {
        code: 'P2002',
        clientVersion: '6.19.2',
        meta: { target: ['recognition_key'] },
      }),
    );

    await expect(service.approveAndPost(stored.id, {
      expectedRevision: 0,
      expectedFingerprint: stored.fingerprint,
      reason: 'finance approval',
      idempotencyKey: 'post-concurrent',
    }, 'checker-1')).rejects.toThrow(
      '来源识别键已被其他批次或逐请求 absorb-delta 确认',
    );
  });

  it('replays a completed post idempotently without a second transaction', async () => {
    const prisma = createPrismaMock();
    const service = new HistoricalPlatformLossBatchService(prisma);
    const preview = await service.preview(buildInput());
    const posted = storedFromPreview(preview, {
      status: 'POSTED',
      revision: 1,
      checkerActorId: 'checker-1',
      postedByActorId: 'checker-1',
      postIdempotencyKey: 'post-1',
      approvedAt: new Date(),
      postedAt: new Date(),
    });
    prisma.historicalPlatformLossAction.findUnique.mockResolvedValue({
      batchId: posted.id,
      action: 'APPROVE_AND_POST',
      actorId: 'checker-1',
      expectedRevision: 0,
      reason: 'finance approval',
      metadata: { fingerprint: posted.fingerprint },
    });
    prisma.historicalPlatformLossBatch.findUnique.mockResolvedValue(posted);

    const result = await service.approveAndPost(posted.id, {
      expectedRevision: 0,
      expectedFingerprint: posted.fingerprint,
      reason: 'finance approval',
      idempotencyKey: 'post-1',
    }, 'checker-1');

    expect(result.status).toBe('POSTED');
    expect(prisma.$transaction).not.toHaveBeenCalled();
  });

  it('exports the exact verified totals and immutable lines', async () => {
    const prisma = createPrismaMock();
    const service = new HistoricalPlatformLossBatchService(prisma);
    const preview = await service.preview(buildInput());
    const stored = storedFromPreview(preview);
    prisma.historicalPlatformLossBatch.findUnique.mockResolvedValue(stored);

    const exported = await service.export(stored.id);

    expect(exported.schemaVersion).toBe('historical-platform-loss-export.v1');
    expect(exported.fingerprint).toBe(preview.fingerprint);
    expect(exported.totals).toEqual(preview.totals);
    expect((exported.lines as unknown[])).toHaveLength(preview.itemCount);
  });
});
