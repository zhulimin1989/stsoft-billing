import { Prisma, type BillingRestrictionProjectionIntent } from '@prisma/client';
import { BillingRestrictionProjectionWorkerService } from './billing-restriction-projection-worker.service';
import {
  billingRestrictionProjectionBacklog,
  billingRestrictionProjectionOldestAgeSeconds,
  billingRestrictionProjectionTotal,
} from '../metrics/metrics.registry';

function intent(overrides: Partial<BillingRestrictionProjectionIntent> = {}) {
  return {
    id: 'intent-1',
    billingAccessRestrictionId: 'restriction-1',
    gatewayBillingEventId: 'event-1',
    apiKeyId: null,
    billingAccountId: 'account-1',
    restrictionStatus: 'ACTIVE',
    status: 'PENDING',
    attempts: 0,
    nextRunAt: new Date('2026-08-06T12:00:00.000Z'),
    leaseId: null,
    lockedAt: null,
    lastError: null,
    projected: null,
    completedAt: null,
    createdAt: new Date('2026-08-06T12:00:00.000Z'),
    updatedAt: new Date('2026-08-06T12:00:00.000Z'),
    ...overrides,
  } satisfies BillingRestrictionProjectionIntent;
}

describe('BillingRestrictionProjectionWorkerService', () => {
  function buildService(values: Record<string, string> = {}) {
    const prisma = {
      $queryRaw: jest.fn().mockResolvedValue([]),
      billingRestrictionProjectionIntent: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        aggregate: jest.fn().mockResolvedValue({
          _count: { _all: 0 },
          _min: { createdAt: null },
        }),
      },
      gatewayBillingEvent: {
        findMany: jest.fn().mockResolvedValue([]),
        findUnique: jest.fn().mockResolvedValue(null),
      },
      billingAccessRestriction: {
        updateMany: jest.fn().mockResolvedValue({ count: 1 }),
        // Default to a still-restricted row so the existing activation cases
        // keep projecting; the no-op cases override it explicitly.
        findUnique: jest.fn().mockResolvedValue({ status: 'ACTIVE' }),
      },
    };
    const publisherSync = {
      syncBillingAccountKeyBalancesRequired: jest.fn().mockResolvedValue(undefined),
      syncKeyBalanceByIdRequired: jest.fn().mockResolvedValue(undefined),
    };
    const config = {
      get: jest.fn((key: string) => values[key]),
    };
    const billing = {
      releaseGatewayBalanceFundingReservation: jest.fn().mockResolvedValue(undefined),
    };
    return {
      service: new BillingRestrictionProjectionWorkerService(
        prisma as never,
        publisherSync as never,
        config as never,
        billing as never,
      ),
      prisma,
      publisherSync,
      billing,
    };
  }

  it('backs off after a scheduled P2024 and resumes scanning on a later tick', async () => {
    jest.useFakeTimers();
    const { service, prisma } = buildService();
    const scan = prisma.gatewayBillingEvent.findMany;
    scan.mockRejectedValueOnce(Object.assign(new Error('pool timeout'), { code: 'P2024' }));
    try {
      service.onModuleInit();
      await jest.advanceTimersByTimeAsync(2_000);
      expect(scan).toHaveBeenCalledTimes(1);
      await jest.advanceTimersByTimeAsync(13_000);
      expect(scan).toHaveBeenCalledTimes(1);
      expect(prisma.billingRestrictionProjectionIntent.updateMany).not.toHaveBeenCalled();
      await jest.advanceTimersByTimeAsync(30_000);
      expect(scan.mock.calls.length).toBeGreaterThan(1);
      expect(prisma.billingRestrictionProjectionIntent.findMany).toHaveBeenCalled();
    } finally {
      service.onModuleDestroy();
      jest.useRealTimers();
    }
  });

  it('recovers an explicit unanchored currency ABSORB without touching funding', async () => {
    const { service, prisma, billing } = buildService();
    const manifestHash = 'a'.repeat(64);
    const settlementFingerprint = 'b'.repeat(64);
    prisma.$queryRaw.mockResolvedValueOnce([{ proven: true }]);
    prisma.gatewayBillingEvent.findMany.mockResolvedValueOnce([{
      id: 'event-absorbed-without-reservation',
      requestId: 'request-absorbed-without-reservation',
      settlementAnchor: null,
      fundingReservation: null,
      reconciliationActions: [{
        actorId: 'finance-user',
        idempotencyKey: 'absorb-command-1',
        metadata: {
          protocol: 'gateway-unanchored-absorb-v1',
          currencyRepairRunId: 'repair-run-1',
          currencyRepairItemId: 'repair-item-1',
          currencyRepairManifestHash: manifestHash,
          currencyRepairEligibleEventId: 'eligible-event-1',
          currencyRepairEligibleEventRowHash: 'c'.repeat(64),
          currencyRepairEligibilityCode: 'BILLING_CURRENCY_MIGRATION_REQUIRED',
          currencyRepairFailureReason: 'settlement_anchor_missing',
          currencyRepairErrorFingerprint:
            'f7c470fb73da49f0ed8b517ec5993e0c3a1796e08b4b8835c03d96fb9364d137',
          currencyRepairEvidenceId: 'evidence-1',
          settlementFingerprint,
        },
      }],
      settlementReceipts: [{
        actorId: 'finance-user',
        idempotencyKey: 'receipt:absorb-command-1',
        policyVersion: 'gateway-unanchored-absorb-v1',
        amountUsd: new Prisma.Decimal(0),
        anchorHash: null,
        pricingHash: null,
        settlementFingerprint,
        billingUnit: null,
        billingCurrency: null,
        creditAmount: null,
        tokenUsageId: null,
        payload: {
          protocol: 'gateway-unanchored-absorb-v1',
          amountUsd: '0.000000000000',
          customerDeductionUsd: '0.000000000000',
          fundingOutcome: 'ABSORBED',
          currencyRepairRunId: 'repair-run-1',
          currencyRepairItemId: 'repair-item-1',
          currencyRepairManifestHash: manifestHash,
          currencyRepairEligibleEventId: 'eligible-event-1',
          currencyRepairEligibleEventRowHash: 'c'.repeat(64),
          currencyRepairEligibilityCode: 'BILLING_CURRENCY_MIGRATION_REQUIRED',
          currencyRepairFailureReason: 'settlement_anchor_missing',
          currencyRepairErrorFingerprint:
            'f7c470fb73da49f0ed8b517ec5993e0c3a1796e08b4b8835c03d96fb9364d137',
          currencyRepairEvidenceId: 'evidence-1',
          settlementFingerprint,
        },
      }],
    }]);

    await service.runOnce('absorb-no-reservation-recovery');

    expect(billing.releaseGatewayBalanceFundingReservation).not.toHaveBeenCalled();
    expect(prisma.$queryRaw).toHaveBeenCalledTimes(1);
    expect(prisma.billingAccessRestriction.updateMany).toHaveBeenCalledWith({
      where: {
        gatewayBillingEventId: 'event-absorbed-without-reservation',
        status: 'ACTIVE',
        reason: {
          in: [
            'pending_usage_unreserved',
            'pending_usage_exposure_limit',
            'evidence_conflict',
            'settlement_policy_review',
          ],
        },
      },
      data: {
        status: 'RELEASED',
        releasedAt: expect.any(Date),
        releasedBy: 'finance-user',
        releaseReason: 'financial_absorption_closed_reconciliation',
      },
    });
  });

  it('does not release restrictions for a generic ABSORB without a reservation', async () => {
    const { service, prisma, billing } = buildService();
    prisma.gatewayBillingEvent.findMany.mockResolvedValueOnce([{
      id: 'event-unproven-absorb',
      requestId: 'request-unproven-absorb',
      settlementAnchor: null,
      fundingReservation: null,
      reconciliationActions: [{
        actorId: 'finance-user',
        idempotencyKey: 'generic-absorb-command',
        metadata: { protocol: 'gateway-absorb-v2' },
      }],
      settlementReceipts: [{
        actorId: 'finance-user',
        idempotencyKey: 'receipt:generic-absorb-command',
        policyVersion: 'manual-finance-v2',
        amountUsd: new Prisma.Decimal(0),
        anchorHash: null,
        pricingHash: null,
        billingUnit: null,
        billingCurrency: null,
        creditAmount: null,
        tokenUsageId: null,
        payload: {},
      }],
    }]);

    await service.runOnce('reject-unproven-absorb');

    expect(billing.releaseGatewayBalanceFundingReservation).not.toHaveBeenCalled();
    expect(prisma.billingAccessRestriction.updateMany).not.toHaveBeenCalled();
  });

  it('recovers the established anchored ABSORB only with its reservation proof', async () => {
    const { service, prisma, billing } = buildService();
    prisma.gatewayBillingEvent.findMany.mockResolvedValueOnce([{
      id: 'event-anchored-absorb',
      requestId: 'request-anchored-absorb',
      settlementAnchor: { id: 'anchor-1' },
      fundingReservation: { status: 'ACTIVE' },
      reconciliationActions: [{
        actorId: 'finance-user',
        idempotencyKey: 'anchored-absorb-command',
        metadata: { protocol: 'gateway-absorb-v2' },
      }],
      settlementReceipts: [{
        actorId: 'finance-user',
        idempotencyKey: 'receipt:anchored-absorb-command',
        policyVersion: 'manual-finance-v2',
        amountUsd: new Prisma.Decimal('0.125'),
        anchorHash: 'anchor-hash-1',
        pricingHash: 'pricing-hash-1',
        billingUnit: 'BALANCE',
        billingCurrency: 'USD',
        creditAmount: null,
        tokenUsageId: null,
        payload: {},
      }],
    }]);

    await service.runOnce('anchored-absorb-recovery');

    expect(billing.releaseGatewayBalanceFundingReservation).toHaveBeenCalledWith(
      'request-anchored-absorb',
      'financial_absorption:anchored-absorb-command',
    );
    expect(prisma.billingAccessRestriction.updateMany).toHaveBeenCalledTimes(1);
  });

  async function metricValue(
    metric: { get: () => Promise<unknown> },
    outcome?: string,
  ): Promise<number> {
    const snapshot = await metric.get() as {
      values: Array<{
        value: number;
        labels: Partial<Record<string, string | number>>;
      }>;
    };
    return snapshot.values.find((value) =>
      outcome === undefined || value.labels.outcome === outcome)?.value ?? 0;
  }

  it('claims and projects an account restriction outbox row', async () => {
    const succeededBefore = await metricValue(
      billingRestrictionProjectionTotal,
      'succeeded',
    );
    const { service, prisma, publisherSync } = buildService();
    prisma.billingRestrictionProjectionIntent.findMany.mockResolvedValue([intent()]);

    const result = await service.runOnce('test');

    expect(result).toEqual({
      trigger: 'test',
      skipped: false,
      scanned: 1,
      succeeded: 1,
      failed: 0,
      noop: 0,
      deferred: 0,
    });
    expect(publisherSync.syncBillingAccountKeyBalancesRequired)
      .toHaveBeenCalledWith(
        'account-1',
        {},
        { assertActive: expect.any(Function) },
      );
    expect(prisma.billingRestrictionProjectionIntent.updateMany)
      .toHaveBeenLastCalledWith({
        where: {
          id: 'intent-1',
          status: 'PROCESSING',
          leaseId: expect.any(String),
          lockedAt: expect.any(Date),
        },
        data: {
          status: 'SUCCEEDED',
          leaseId: null,
          lockedAt: null,
          lastError: null,
          projected: true,
          completedAt: expect.any(Date),
        },
      });
    await expect(metricValue(billingRestrictionProjectionTotal, 'succeeded'))
      .resolves.toBe(succeededBefore + 1);
  });

  it('retires an activation whose guard was already released without a fanout', async () => {
    const { service, prisma, publisherSync } = buildService();
    prisma.billingRestrictionProjectionIntent.findMany.mockResolvedValue([intent()]);
    // The pending_usage_unreserved guard lives ~20-30ms, so by the sweep it is
    // released and republishing the account would rewrite identical state.
    prisma.billingAccessRestriction.findUnique.mockResolvedValue({ status: 'RELEASED' });

    const result = await service.runOnce('transient-activation');

    expect(result).toMatchObject({ scanned: 1, succeeded: 0, noop: 1, failed: 0 });
    expect(publisherSync.syncBillingAccountKeyBalancesRequired).not.toHaveBeenCalled();
    expect(publisherSync.syncKeyBalanceByIdRequired).not.toHaveBeenCalled();
    expect(prisma.billingRestrictionProjectionIntent.updateMany)
      .toHaveBeenLastCalledWith(expect.objectContaining({
        data: expect.objectContaining({ status: 'SUCCEEDED', projected: false }),
      }));
  });

  it('still projects an activation whose guard is genuinely stuck', async () => {
    const { service, prisma, publisherSync } = buildService();
    prisma.billingRestrictionProjectionIntent.findMany.mockResolvedValue([intent()]);
    prisma.billingAccessRestriction.findUnique.mockResolvedValue({ status: 'ACTIVE' });

    const result = await service.runOnce('stuck-activation');

    expect(result).toMatchObject({ scanned: 1, succeeded: 1, noop: 0 });
    expect(publisherSync.syncBillingAccountKeyBalancesRequired)
      .toHaveBeenCalledWith('account-1', {}, { assertActive: expect.any(Function) });
  });

  it('retires a release whose paired activation never published', async () => {
    const { service, prisma, publisherSync } = buildService();
    prisma.billingRestrictionProjectionIntent.findMany.mockResolvedValue([
      intent({ id: 'intent-release', restrictionStatus: 'RELEASED' }),
    ]);
    prisma.billingAccessRestriction.findUnique.mockResolvedValue({ status: 'RELEASED' });
    prisma.billingRestrictionProjectionIntent.findUnique.mockResolvedValue({
      status: 'SUCCEEDED',
      projected: false,
    });

    const result = await service.runOnce('transient-release');

    expect(result).toMatchObject({ scanned: 1, succeeded: 0, noop: 1 });
    expect(publisherSync.syncBillingAccountKeyBalancesRequired).not.toHaveBeenCalled();
  });

  it('projects a release whose paired activation did publish the restriction', async () => {
    const { service, prisma, publisherSync } = buildService();
    prisma.billingRestrictionProjectionIntent.findMany.mockResolvedValue([
      intent({ id: 'intent-release', restrictionStatus: 'RELEASED' }),
    ]);
    prisma.billingAccessRestriction.findUnique.mockResolvedValue({ status: 'RELEASED' });
    prisma.billingRestrictionProjectionIntent.findUnique.mockResolvedValue({
      status: 'SUCCEEDED',
      projected: true,
    });

    const result = await service.runOnce('restore-release');

    expect(result).toMatchObject({ scanned: 1, succeeded: 1, noop: 0 });
    expect(publisherSync.syncBillingAccountKeyBalancesRequired)
      .toHaveBeenCalledWith('account-1', {}, { assertActive: expect.any(Function) });
  });

  it('projects a release whose activation predates the projected column', async () => {
    const { service, prisma, publisherSync } = buildService();
    prisma.billingRestrictionProjectionIntent.findMany.mockResolvedValue([
      intent({ id: 'intent-release', restrictionStatus: 'RELEASED' }),
    ]);
    prisma.billingAccessRestriction.findUnique.mockResolvedValue({ status: 'RELEASED' });
    // NULL predates the column and must keep the fail-safe restore.
    prisma.billingRestrictionProjectionIntent.findUnique.mockResolvedValue({
      status: 'SUCCEEDED',
      projected: null,
    });

    const result = await service.runOnce('legacy-release');

    expect(result).toMatchObject({ scanned: 1, succeeded: 1, noop: 0 });
    expect(publisherSync.syncBillingAccountKeyBalancesRequired).toHaveBeenCalled();
  });

  it('defers a release until its paired activation reaches a terminal state', async () => {
    const { service, prisma, publisherSync } = buildService({
      BILLING_RESTRICTION_PROJECTION_DEFER_DELAY_MS: '1000',
    });
    prisma.billingRestrictionProjectionIntent.findMany.mockResolvedValue([
      intent({ id: 'intent-release', restrictionStatus: 'RELEASED' }),
    ]);
    prisma.billingAccessRestriction.findUnique.mockResolvedValue({ status: 'RELEASED' });
    prisma.billingRestrictionProjectionIntent.findUnique.mockResolvedValue({
      status: 'PENDING',
      projected: null,
    });

    const result = await service.runOnce('defer-release');

    expect(result).toMatchObject({ scanned: 1, succeeded: 0, noop: 0, deferred: 1 });
    expect(publisherSync.syncBillingAccountKeyBalancesRequired).not.toHaveBeenCalled();
    expect(prisma.billingRestrictionProjectionIntent.updateMany)
      .toHaveBeenLastCalledWith(expect.objectContaining({
        data: expect.objectContaining({
          status: 'PENDING',
          leaseId: null,
          lockedAt: null,
          nextRunAt: expect.any(Date),
        }),
      }));
  });

  it('projects unconditionally when the no-op decision is switched off', async () => {
    const { service, prisma, publisherSync } = buildService({
      BILLING_RESTRICTION_PROJECTION_TRANSIENT_NOOP_ENABLED: 'false',
    });
    prisma.billingRestrictionProjectionIntent.findMany.mockResolvedValue([intent()]);
    prisma.billingAccessRestriction.findUnique.mockResolvedValue({ status: 'RELEASED' });

    const result = await service.runOnce('kill-switch');

    expect(result).toMatchObject({ scanned: 1, succeeded: 1, noop: 0 });
    expect(publisherSync.syncBillingAccountKeyBalancesRequired).toHaveBeenCalled();
    expect(prisma.billingAccessRestriction.findUnique).not.toHaveBeenCalled();
  });

  it('surfaces a target-less intent instead of retiring it as a no-op', async () => {
    const { service, prisma, publisherSync } = buildService();
    prisma.billingRestrictionProjectionIntent.findMany.mockResolvedValue([
      intent({ billingAccountId: null, apiKeyId: null, gatewayBillingEventId: null }),
    ]);
    prisma.billingAccessRestriction.findUnique.mockResolvedValue({ status: 'RELEASED' });

    const result = await service.runOnce('no-target');

    expect(result).toMatchObject({ scanned: 1, succeeded: 0, noop: 0, failed: 1 });
    expect(publisherSync.syncBillingAccountKeyBalancesRequired).not.toHaveBeenCalled();
  });

  it('reclaims a stale PROCESSING row and binds completion to the new lease', async () => {
    const { service, prisma } = buildService({
      BILLING_RESTRICTION_PROJECTION_WORKER_LEASE_MS: '30000',
    });
    prisma.billingRestrictionProjectionIntent.findMany.mockResolvedValue([
      intent({
        status: 'PROCESSING',
        lockedAt: new Date(Date.now() - 60_000),
      }),
    ]);

    await service.runOnce('lease-recovery');

    const claim = prisma.billingRestrictionProjectionIntent.updateMany.mock.calls[0][0];
    const complete = prisma.billingRestrictionProjectionIntent.updateMany.mock.calls[1][0];
    expect(claim.where.OR).toEqual(expect.arrayContaining([
      expect.objectContaining({
        status: 'PROCESSING',
        lockedAt: { lte: expect.any(Date) },
      }),
    ]));
    expect(complete.where.lockedAt).toEqual(claim.data.lockedAt);
    expect(complete.where.leaseId).toEqual(claim.data.leaseId);
  });

  it('heartbeats a slow projection and completes with the renewed lease fence', async () => {
    jest.useFakeTimers();
    try {
      const { service, prisma, publisherSync } = buildService({
        BILLING_RESTRICTION_PROJECTION_WORKER_LEASE_MS: '30000',
      });
      prisma.billingRestrictionProjectionIntent.findMany.mockResolvedValue([intent()]);
      let releaseProjection = (): void => undefined;
      publisherSync.syncBillingAccountKeyBalancesRequired.mockReturnValueOnce(
        new Promise<void>((resolve) => {
          releaseProjection = resolve;
        }),
      );

      const run = service.runOnce('slow-projection');
      for (let i = 0; i < 10 && publisherSync.syncBillingAccountKeyBalancesRequired.mock.calls.length === 0; i += 1) {
        await Promise.resolve();
      }
      expect(publisherSync.syncBillingAccountKeyBalancesRequired).toHaveBeenCalledTimes(1);

      await jest.advanceTimersByTimeAsync(10_000);
      expect(prisma.billingRestrictionProjectionIntent.updateMany).toHaveBeenCalledTimes(2);
      const claim = prisma.billingRestrictionProjectionIntent.updateMany.mock.calls[0][0];
      const heartbeat = prisma.billingRestrictionProjectionIntent.updateMany.mock.calls[1][0];
      expect(heartbeat.where).toEqual({
        id: 'intent-1',
        status: 'PROCESSING',
        leaseId: claim.data.leaseId,
        lockedAt: claim.data.lockedAt,
      });

      releaseProjection();
      await expect(run).resolves.toEqual(expect.objectContaining({ succeeded: 1 }));
      const completion = prisma.billingRestrictionProjectionIntent.updateMany.mock.calls[2][0];
      expect(completion.where).toEqual({
        id: 'intent-1',
        status: 'PROCESSING',
        leaseId: claim.data.leaseId,
        lockedAt: heartbeat.data.lockedAt,
      });
    } finally {
      jest.useRealTimers();
    }
  });

  it('stops a slow projection without terminal writes after another worker takes its lease', async () => {
    jest.useFakeTimers();
    try {
      const { service, prisma, publisherSync } = buildService({
        BILLING_RESTRICTION_PROJECTION_WORKER_LEASE_MS: '30000',
      });
      prisma.billingRestrictionProjectionIntent.findMany.mockResolvedValue([intent()]);
      prisma.billingRestrictionProjectionIntent.updateMany
        .mockResolvedValueOnce({ count: 1 })
        .mockResolvedValueOnce({ count: 0 });
      let releaseProjection = (): void => undefined;
      publisherSync.syncBillingAccountKeyBalancesRequired.mockImplementationOnce(
        async (_accountId, _context, control) => {
          await new Promise<void>((resolve) => {
            releaseProjection = resolve;
          });
          control.assertActive();
        },
      );

      const run = service.runOnce('lease-lost');
      for (let i = 0; i < 10 && publisherSync.syncBillingAccountKeyBalancesRequired.mock.calls.length === 0; i += 1) {
        await Promise.resolve();
      }
      await jest.advanceTimersByTimeAsync(10_000);
      releaseProjection();

      await expect(run).resolves.toEqual(expect.objectContaining({
        scanned: 1,
        succeeded: 0,
        failed: 0,
      }));
      expect(prisma.billingRestrictionProjectionIntent.updateMany).toHaveBeenCalledTimes(2);
    } finally {
      jest.useRealTimers();
    }
  });

  it('keeps a failed projection retryable and increments attempts', async () => {
    const { service, prisma, publisherSync } = buildService();
    prisma.billingRestrictionProjectionIntent.findMany.mockResolvedValue([
      intent({ attempts: 2 }),
    ]);
    publisherSync.syncBillingAccountKeyBalancesRequired
      .mockRejectedValueOnce(new Error('publisher unavailable'));

    const result = await service.runOnce('failure');

    expect(result.failed).toBe(1);
    expect(prisma.billingRestrictionProjectionIntent.updateMany)
      .toHaveBeenLastCalledWith({
        where: {
          id: 'intent-1',
          status: 'PROCESSING',
          leaseId: expect.any(String),
          lockedAt: expect.any(Date),
        },
        data: {
          status: 'FAILED',
          attempts: 3,
          leaseId: null,
          lockedAt: null,
          lastError: 'publisher unavailable',
          nextRunAt: expect.any(Date),
        },
      });
  });

  it('resolves a key target from the immutable gateway event when needed', async () => {
    const { service, prisma, publisherSync } = buildService();
    prisma.billingRestrictionProjectionIntent.findMany.mockResolvedValue([
      intent({ billingAccountId: null, apiKeyId: null }),
    ]);
    prisma.gatewayBillingEvent.findUnique.mockResolvedValue({
      billingAccountId: null,
      apiKeyId: 'key-from-event',
    });

    const result = await service.runOnce('event-fallback');

    expect(result.succeeded).toBe(1);
    expect(publisherSync.syncKeyBalanceByIdRequired).toHaveBeenCalledWith(
      'key-from-event',
      { deleteWhenMissing: true },
    );
  });

  it('samples current backlog and oldest age from the durable projection table', async () => {
    jest.useFakeTimers();
    try {
      const now = new Date('2026-08-07T12:00:00.000Z');
      jest.setSystemTime(now);
      const { service, prisma } = buildService();
      prisma.billingRestrictionProjectionIntent.aggregate.mockResolvedValueOnce({
        _count: { _all: 4 },
        _min: { createdAt: new Date('2026-08-07T11:58:00.000Z') },
      });

      await service.runOnce('metrics');

      expect(prisma.billingRestrictionProjectionIntent.aggregate).toHaveBeenCalledWith({
        where: { status: { not: 'SUCCEEDED' } },
        _count: { _all: true },
        _min: { createdAt: true },
      });
      await expect(metricValue(billingRestrictionProjectionBacklog)).resolves.toBe(4);
      await expect(metricValue(billingRestrictionProjectionOldestAgeSeconds))
        .resolves.toBe(120);
    } finally {
      jest.useRealTimers();
    }
  });

  it('does not fail a completed sweep when the metrics-only database query fails', async () => {
    const { service, prisma } = buildService();
    const failuresBefore = await metricValue(
      billingRestrictionProjectionTotal,
      'metrics_query_failed',
    );
    prisma.billingRestrictionProjectionIntent.aggregate
      .mockRejectedValueOnce(new Error('metrics database unavailable'));

    await expect(service.runOnce('metrics-failure')).resolves.toEqual({
      trigger: 'metrics-failure',
      skipped: false,
      scanned: 0,
      succeeded: 0,
      failed: 0,
      noop: 0,
      deferred: 0,
    });
    await expect(metricValue(billingRestrictionProjectionTotal, 'metrics_query_failed'))
      .resolves.toBe(failuresBefore + 1);
  });

  it('counts a failed candidate scan while keeping the backlog refresh isolated', async () => {
    const { service, prisma } = buildService();
    const failuresBefore = await metricValue(
      billingRestrictionProjectionTotal,
      'scan_failed',
    );
    prisma.billingRestrictionProjectionIntent.findMany
      .mockRejectedValueOnce(new Error('scan unavailable'));

    await expect(service.runOnce('scan-failure')).rejects.toThrow('scan unavailable');
    await expect(metricValue(billingRestrictionProjectionTotal, 'scan_failed'))
      .resolves.toBe(failuresBefore + 1);
  });
});
