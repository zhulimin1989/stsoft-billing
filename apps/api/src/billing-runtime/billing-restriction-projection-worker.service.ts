import { randomUUID } from 'node:crypto';
import { Injectable, Logger, OnModuleDestroy, OnModuleInit, Optional } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import type { BillingRestrictionProjectionIntent, Prisma } from '@prisma/client';
import { isProductionConfig } from '../common/runtime/is-production';
import { isBillingRuntime } from '../common/runtime/service-role';
import { PrismaService } from '../prisma/prisma.service';
import { PublisherSyncService } from '../publisher/publisher-sync.service';
import { BillingService } from '../billing/billing.service';
import {
  billingRestrictionProjectionBacklog,
  billingRestrictionProjectionOldestAgeSeconds,
  billingRestrictionProjectionTotal,
} from '../metrics/metrics.registry';

class BillingRestrictionProjectionLeaseLostError extends Error {}

type ProjectionLeaseHeartbeat = {
  assertOwned: () => void;
  currentLockedAt: () => Date;
  stop: () => Promise<void>;
};

function isJsonRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

export type BillingRestrictionProjectionSweepResult = {
  trigger: string;
  skipped: boolean;
  scanned: number;
  succeeded: number;
  failed: number;
  /** Completed without a fanout because the transition never moved the projection. */
  noop: number;
  /** Postponed until the paired activation intent reaches a terminal state. */
  deferred: number;
};

type ProjectionOutcome = 'succeeded' | 'failed' | 'skipped' | 'noop' | 'deferred';

/** Whether an intent still has to reach Gateway, and why. */
type ProjectionDecision =
  | { action: 'project' }
  | { action: 'noop'; reason: string }
  | { action: 'defer'; reason: string };

/**
 * Projects durable Billing restriction transitions to Gateway. The outbox row
 * is inserted by a database trigger in the same transaction as the source
 * restriction, so a process crash after commit cannot lose activation or
 * release fanout. Row leases make PROCESSING recoverable across worker deaths.
 */
@Injectable()
export class BillingRestrictionProjectionWorkerService
implements OnModuleInit, OnModuleDestroy {
  private readonly logger = new Logger(BillingRestrictionProjectionWorkerService.name);
  private interval: NodeJS.Timeout | null = null;
  private startupTimer: NodeJS.Timeout | null = null;
  private running = false;
  private scanFailures = 0;
  private nextScanAt = 0;

  constructor(
    private readonly prisma: PrismaService,
    private readonly publisherSync: PublisherSyncService,
    private readonly config: ConfigService,
    @Optional() private readonly billing?: BillingService,
  ) {}

  onModuleInit(): void {
    if (!isBillingRuntime()) return;
    if (!this.enabled()) {
      if (isProductionConfig(this.config)) {
        throw new Error(
          'BILLING_RESTRICTION_PROJECTION_WORKER_ENABLED=false is unsafe in production',
        );
      }
      this.logger.log('Billing restriction projection worker disabled');
      return;
    }
    this.interval = setInterval(() => {
      void this.runScheduled('interval');
    }, this.intervalMs());
    this.interval.unref?.();
    this.startupTimer = setTimeout(() => {
      void this.runScheduled('startup');
    }, this.startupDelayMs());
    this.startupTimer.unref?.();
  }

  onModuleDestroy(): void {
    if (this.interval) clearInterval(this.interval);
    if (this.startupTimer) clearTimeout(this.startupTimer);
    this.interval = null;
    this.startupTimer = null;
  }

  private async runScheduled(trigger: 'startup' | 'interval'): Promise<void> {
    if (this.running || Date.now() < this.nextScanAt) return;
    try {
      await this.runOnce(trigger);
      this.scanFailures = 0;
      this.nextScanAt = 0;
    } catch (error) {
      this.scanFailures = Math.min(this.scanFailures + 1, 6);
      const ceiling = Math.min(300_000, this.intervalMs() * 2 ** this.scanFailures);
      const delay = Math.ceil(ceiling * (0.5 + Math.random() * 0.5));
      this.nextScanAt = Date.now() + delay;
      billingRestrictionProjectionTotal.labels('scheduled_sweep_failed').inc();
      this.logger.error(`Scheduled projection sweep failed (${trigger}); retry after ${delay}ms: ${error instanceof Error ? error.name : 'unknown error'}`);
    }
  }

  async runOnce(trigger = 'manual'): Promise<BillingRestrictionProjectionSweepResult> {
    const result: BillingRestrictionProjectionSweepResult = {
      trigger,
      skipped: false,
      scanned: 0,
      succeeded: 0,
      failed: 0,
      noop: 0,
      deferred: 0,
    };
    if (this.running) {
      result.skipped = true;
      return result;
    }
    this.running = true;
    try {
      await this.recoverAbsorbedFundingReservations();
      const now = new Date();
      const staleBefore = new Date(now.getTime() - this.leaseMs());
      let candidates: BillingRestrictionProjectionIntent[];
      try {
        candidates = await this.prisma.billingRestrictionProjectionIntent.findMany({
          where: this.claimableWhere(now, staleBefore),
          orderBy: [{ nextRunAt: 'asc' }, { createdAt: 'asc' }],
          take: this.batchSize(),
        });
      } catch (err) {
        billingRestrictionProjectionTotal.labels('scan_failed').inc();
        throw err;
      }
      result.scanned = candidates.length;
      for (const candidate of candidates) {
        const outcome = await this.processOne(candidate, now, staleBefore);
        billingRestrictionProjectionTotal.labels(outcome).inc();
        if (outcome === 'succeeded') result.succeeded += 1;
        if (outcome === 'failed') result.failed += 1;
        if (outcome === 'noop') result.noop += 1;
        if (outcome === 'deferred') result.deferred += 1;
      }
      return result;
    } finally {
      try {
        await this.refreshBacklogMetrics();
      } finally {
        this.running = false;
      }
    }
  }

  /**
   * ABSORB intentionally commits its permanent action/receipt before touching
   * the wallet-ordered reservation. This sweep closes the resulting crash
   * window without weakening lock order: release is idempotent, then and only
   * then are fail-closed restrictions released through the normal outbox.
   */
  private async recoverAbsorbedFundingReservations(): Promise<void> {
    const candidates = await this.prisma.gatewayBillingEvent.findMany({
      where: {
        status: 'ABSORBED',
        OR: [
          {
            fundingReservation: {
              is: { status: { in: ['ACTIVE', 'MANUAL_REVIEW'] } },
            },
          },
          {
            accessRestrictions: {
              some: {
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
            },
          },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      take: this.batchSize(),
      select: {
        id: true,
        requestId: true,
        settlementAnchor: { select: { id: true } },
        fundingReservation: { select: { status: true } },
        reconciliationActions: {
          where: { action: 'ABSORB' },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
          select: { actorId: true, idempotencyKey: true, metadata: true },
        },
        settlementReceipts: {
          where: { fundingOutcome: 'ABSORBED' },
          orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
          take: 1,
          select: {
            actorId: true,
            idempotencyKey: true,
            policyVersion: true,
            amountUsd: true,
            anchorHash: true,
            pricingHash: true,
            settlementFingerprint: true,
            billingUnit: true,
            billingCurrency: true,
            creditAmount: true,
            tokenUsageId: true,
            payload: true,
          },
        },
      },
    });
    for (const candidate of candidates) {
      const action = candidate.reconciliationActions[0];
      const receipt = candidate.settlementReceipts[0];
      const actionMetadata = isJsonRecord(action?.metadata) ? action.metadata : null;
      const receiptPayload = isJsonRecord(receipt?.payload) ? receipt.payload : null;
      const anchoredProof = Boolean(
        candidate.settlementAnchor
        && candidate.fundingReservation
        && actionMetadata?.protocol === 'gateway-absorb-v2'
        && receipt?.policyVersion === 'manual-finance-v2'
        && receipt.anchorHash
        && receipt.pricingHash
        && receipt.billingUnit === 'BALANCE'
        && receipt.billingCurrency,
      );
      const unanchoredShape = Boolean(
        !candidate.settlementAnchor
        && !candidate.fundingReservation
        && actionMetadata?.protocol === 'gateway-unanchored-absorb-v1'
        && receipt?.policyVersion === 'gateway-unanchored-absorb-v1'
        && receipt.amountUsd.isZero()
        && receipt.anchorHash === null
        && receipt.pricingHash === null
        && receipt.billingUnit === null
        && receipt.billingCurrency === null
        && receipt.creditAmount === null
        && receipt.tokenUsageId === null
        && receiptPayload?.protocol === 'gateway-unanchored-absorb-v1'
        && receiptPayload.amountUsd === '0.000000000000'
        && receiptPayload.customerDeductionUsd === '0.000000000000'
        && receiptPayload.fundingOutcome === 'ABSORBED'
        && typeof actionMetadata.settlementFingerprint === 'string'
        && /^[0-9a-f]{64}$/.test(actionMetadata.settlementFingerprint)
        && receipt.settlementFingerprint === actionMetadata.settlementFingerprint
        && receiptPayload.settlementFingerprint === actionMetadata.settlementFingerprint
        && typeof actionMetadata.currencyRepairRunId === 'string'
        && actionMetadata.currencyRepairRunId.trim() !== ''
        && typeof actionMetadata.currencyRepairItemId === 'string'
        && actionMetadata.currencyRepairItemId.trim() !== ''
        && typeof actionMetadata.currencyRepairManifestHash === 'string'
        && /^[0-9a-f]{64}$/.test(actionMetadata.currencyRepairManifestHash)
        && receiptPayload.currencyRepairRunId === actionMetadata.currencyRepairRunId
        && receiptPayload.currencyRepairItemId === actionMetadata.currencyRepairItemId
        && receiptPayload.currencyRepairManifestHash
          === actionMetadata.currencyRepairManifestHash
        && typeof actionMetadata.currencyRepairEligibleEventId === 'string'
        && actionMetadata.currencyRepairEligibleEventId.trim() !== ''
        && typeof actionMetadata.currencyRepairEligibleEventRowHash === 'string'
        && /^[0-9a-f]{64}$/.test(
          actionMetadata.currencyRepairEligibleEventRowHash,
        )
        && actionMetadata.currencyRepairEligibilityCode
          === 'BILLING_CURRENCY_MIGRATION_REQUIRED'
        && actionMetadata.currencyRepairFailureReason === 'settlement_anchor_missing'
        && actionMetadata.currencyRepairErrorFingerprint
          === 'f7c470fb73da49f0ed8b517ec5993e0c3a1796e08b4b8835c03d96fb9364d137'
        && typeof actionMetadata.currencyRepairEvidenceId === 'string'
        && actionMetadata.currencyRepairEvidenceId.trim() !== ''
        && receiptPayload.currencyRepairEligibleEventId
          === actionMetadata.currencyRepairEligibleEventId
        && receiptPayload.currencyRepairEligibleEventRowHash
          === actionMetadata.currencyRepairEligibleEventRowHash
        && receiptPayload.currencyRepairEligibilityCode
          === actionMetadata.currencyRepairEligibilityCode
        && receiptPayload.currencyRepairFailureReason
          === actionMetadata.currencyRepairFailureReason
        && receiptPayload.currencyRepairErrorFingerprint
          === actionMetadata.currencyRepairErrorFingerprint
        && receiptPayload.currencyRepairEvidenceId
          === actionMetadata.currencyRepairEvidenceId
      );
      const unanchoredProof = unanchoredShape
        && await this.hasCurrentUnanchoredCurrencyRepairProof(
          candidate.id,
          actionMetadata!,
          receiptPayload!,
        );
      if (
        !action?.actorId?.trim()
        || !receipt
        || receipt.actorId?.trim() !== action.actorId.trim()
        || receipt.idempotencyKey !== `receipt:${action.idempotencyKey}`
        || (!anchoredProof && !unanchoredProof)
      ) {
        this.logger.error(
          `absorbed funding recovery missing permanent matching ABSORB proof request=${candidate.requestId}`,
        );
        continue;
      }
      try {
        // Reservation release belongs exclusively to the established anchored
        // v2 protocol. The explicit unanchored currency-migration closure has
        // no funding fact and must never call a wallet path.
        if (anchoredProof) {
          if (!this.billing) {
            throw new Error('BillingService unavailable for reservation release');
          }
          await this.billing.releaseGatewayBalanceFundingReservation(
            candidate.requestId,
            `financial_absorption:${action.idempotencyKey}`,
          );
        }
        await this.prisma.billingAccessRestriction.updateMany({
          where: {
            gatewayBillingEventId: candidate.id,
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
            releasedAt: new Date(),
            releasedBy: action.actorId.trim(),
            releaseReason: 'financial_absorption_closed_reconciliation',
          },
        });
      } catch (err) {
        this.logger.error(
          `absorbed funding recovery failed request=${candidate.requestId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    }
  }

  /**
   * The v1 receipt is only a pointer to the append-only migration authority.
   * Re-resolve that authority before recovery so forged JSON metadata can
   * never release a restriction after a crash.
   */
  private async hasCurrentUnanchoredCurrencyRepairProof(
    gatewayBillingEventId: string,
    actionMetadata: Record<string, unknown>,
    receiptPayload: Record<string, unknown>,
  ): Promise<boolean> {
    const rows = await this.prisma.$queryRaw<Array<{ proven: boolean }>>`
      SELECT TRUE AS "proven"
      FROM "gateway_billing_events" AS event
      JOIN "api_keys" AS api_key
        ON api_key."id" = event."api_key_id"
       AND api_key."deleted_at" IS NULL
      JOIN "tenants" AS tenant
        ON tenant."id" = api_key."tenant_id"
       AND tenant."id" = event."tenant_id"
       AND tenant."deleted_at" IS NULL
      JOIN "billing_accounts" AS account
        ON account."id" = tenant."billing_account_id"
       AND account."deleted_at" IS NULL
      JOIN "billing_account_currency_label_repair_items" AS repair_item
        ON repair_item."id" = ${String(actionMetadata.currencyRepairItemId)}
       AND repair_item."billing_account_id" = account."id"
      JOIN "billing_account_currency_label_repair_runs" AS repair_run
        ON repair_run."id" = repair_item."run_id"
       AND repair_run."id" = ${String(actionMetadata.currencyRepairRunId)}
      JOIN "billing_account_currency_label_repair_eligible_events" AS eligible
        ON eligible."run_id" = repair_run."id"
       AND eligible."item_id" = repair_item."id"
       AND eligible."gateway_billing_event_id" = event."id"
      JOIN "gateway_usage_evidences" AS evidence
        ON evidence."id" = eligible."evidence_id"
       AND evidence."gateway_billing_event_id" = event."id"
      WHERE event."id" = ${gatewayBillingEventId}
        AND event."status" = 'ABSORBED'
        AND event."reconciliation_status" = 'CLOSED'
        AND event."funding_outcome" = 'ABSORBED'
        AND repair_run."status" = 'APPLIED'
        AND repair_run."manifest_hash" = ${String(actionMetadata.currencyRepairManifestHash)}
        AND repair_run."source_currency" = ${String(actionMetadata.originalAccountCurrency)}
        AND repair_run."target_currency" = ${String(actionMetadata.originalDeploymentCurrency)}
        AND repair_item."before_currency" = repair_run."source_currency"
        AND repair_item."after_currency" = repair_run."target_currency"
        AND eligible."id" = ${String(
          actionMetadata.currencyRepairEligibleEventId,
        )}
        AND eligible."request_id" = event."request_id"
        AND eligible."evidence_hash" = event."evidence_hash"
        AND eligible."failure_code" =
          'BILLING_CURRENCY_MIGRATION_REQUIRED'
        AND eligible."failure_reason" = 'settlement_anchor_missing'
        AND eligible."error_fingerprint" =
          'f7c470fb73da49f0ed8b517ec5993e0c3a1796e08b4b8835c03d96fb9364d137'
        AND eligible."row_hash" = ${String(
          actionMetadata.currencyRepairEligibleEventRowHash,
        )}
        AND eligible."evidence_id" = ${String(
          actionMetadata.currencyRepairEvidenceId,
        )}
        AND eligible."error_message" =
          'Gateway billing currency mismatch: account=USD deployment=CNY'
        AND encode(sha256(convert_to(jsonb_build_object(
          'runId', repair_run."id",
          'billingAccountId', repair_item."billing_account_id",
          'gatewayBillingEventId', eligible."gateway_billing_event_id",
          'requestId', eligible."request_id",
          'evidenceId', eligible."evidence_id",
          'evidenceHash', eligible."evidence_hash",
          'failureCode', eligible."failure_code",
          'failureReason', eligible."failure_reason",
          'errorMessage', eligible."error_message",
          'errorFingerprint', eligible."error_fingerprint",
          'eventSnapshot', eligible."event_snapshot"
        )::TEXT, 'UTF8')), 'hex') = eligible."row_hash"
        AND evidence."request_id" = event."request_id"
        AND evidence."evidence_hash" = event."evidence_hash"
        AND account."currency" = repair_item."after_currency"
        AND api_key."id" = ${String(actionMetadata.currentApiKeyId)}
        AND tenant."id" = ${String(actionMetadata.currentTenantId)}
        AND account."id" = ${String(actionMetadata.currentBillingAccountId)}
        AND repair_item."id" = ${String(receiptPayload.currencyRepairItemId)}
        AND repair_run."id" = ${String(receiptPayload.currencyRepairRunId)}
        AND repair_run."manifest_hash" = ${String(
          receiptPayload.currencyRepairManifestHash,
        )}
        AND eligible."id" = ${String(
          receiptPayload.currencyRepairEligibleEventId,
        )}
        AND eligible."row_hash" = ${String(
          receiptPayload.currencyRepairEligibleEventRowHash,
        )}
        AND eligible."failure_code" = ${String(
          receiptPayload.currencyRepairEligibilityCode,
        )}
        AND eligible."failure_reason" = ${String(
          receiptPayload.currencyRepairFailureReason,
        )}
        AND eligible."error_fingerprint" = ${String(
          receiptPayload.currencyRepairErrorFingerprint,
        )}
        AND eligible."evidence_id" = ${String(
          receiptPayload.currencyRepairEvidenceId,
        )}
      LIMIT 1
    `;
    return rows.length === 1 && rows[0]?.proven === true;
  }

  private async refreshBacklogMetrics(): Promise<void> {
    try {
      const snapshot = await this.prisma.billingRestrictionProjectionIntent.aggregate({
        where: { status: { not: 'SUCCEEDED' } },
        _count: { _all: true },
        _min: { createdAt: true },
      });
      const backlog = snapshot._count._all;
      const oldestCreatedAt = snapshot._min.createdAt;
      const oldestAgeSeconds = oldestCreatedAt
        ? Math.max(0, (Date.now() - oldestCreatedAt.getTime()) / 1000)
        : 0;
      billingRestrictionProjectionBacklog.set(backlog);
      billingRestrictionProjectionOldestAgeSeconds.set(oldestAgeSeconds);
    } catch (err) {
      // Metrics must never turn a completed projection into a failed business
      // operation. Keep the prior sample and surface the scrape-data failure.
      billingRestrictionProjectionTotal.labels('metrics_query_failed').inc();
      this.logger.warn(
        `billing restriction projection metrics query failed: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private async processOne(
    candidate: BillingRestrictionProjectionIntent,
    now: Date,
    staleBefore: Date,
  ): Promise<ProjectionOutcome> {
    const claimAt = new Date();
    const leaseId = randomUUID();
    const claimed = await this.prisma.billingRestrictionProjectionIntent.updateMany({
      where: {
        id: candidate.id,
        ...this.claimableWhere(now, staleBefore),
      },
      data: {
        status: 'PROCESSING',
        leaseId,
        lockedAt: claimAt,
        lastError: null,
      },
    });
    if (claimed.count !== 1) return 'skipped';

    const heartbeat = this.startLeaseHeartbeat(candidate.id, leaseId, claimAt);

    try {
      const target = await this.resolveTarget(candidate);
      const decision = await this.projectionDecision(candidate, target);

      if (decision.action === 'defer') {
        heartbeat.assertOwned();
        await heartbeat.stop();
        heartbeat.assertOwned();
        const deferred = await this.prisma.billingRestrictionProjectionIntent.updateMany({
          where: {
            id: candidate.id,
            status: 'PROCESSING',
            leaseId,
            lockedAt: heartbeat.currentLockedAt(),
          },
          data: {
            status: 'PENDING',
            leaseId: null,
            lockedAt: null,
            lastError: null,
            nextRunAt: new Date(Date.now() + this.deferDelayMs()),
          },
        });
        return deferred.count === 1 ? 'deferred' : 'skipped';
      }

      if (decision.action === 'project') {
        if (target.billingAccountId) {
          await this.publisherSync.syncBillingAccountKeyBalancesRequired(
            target.billingAccountId,
            {},
            { assertActive: heartbeat.assertOwned },
          );
        } else if (target.apiKeyId) {
          await this.publisherSync.syncKeyBalanceByIdRequired(
            target.apiKeyId,
            { deleteWhenMissing: true },
          );
        } else {
          throw new Error(`Restriction projection intent ${candidate.id} has no billing target`);
        }
      } else if (!target.billingAccountId && !target.apiKeyId) {
        // A target-less intent is a data defect either way: surface it instead
        // of letting the no-op path retire it silently.
        throw new Error(`Restriction projection intent ${candidate.id} has no billing target`);
      }

      heartbeat.assertOwned();
      await heartbeat.stop();
      heartbeat.assertOwned();
      const projected = decision.action === 'project';
      const completed = await this.prisma.billingRestrictionProjectionIntent.updateMany({
        where: {
          id: candidate.id,
          status: 'PROCESSING',
          leaseId,
          lockedAt: heartbeat.currentLockedAt(),
        },
        data: {
          status: 'SUCCEEDED',
          leaseId: null,
          lockedAt: null,
          lastError: null,
          projected,
          completedAt: new Date(),
        },
      });
      if (completed.count !== 1) return 'skipped';
      if (projected) return 'succeeded';
      this.logger.debug?.(
        `billing restriction projection no-op intent=${candidate.id} reason=${decision.reason}`,
      );
      return 'noop';
    } catch (err) {
      await heartbeat.stop();
      try {
        heartbeat.assertOwned();
      } catch (leaseErr) {
        this.logger.warn(
          `billing restriction projection lease lost intent=${candidate.id}: ${
            leaseErr instanceof Error ? leaseErr.message : String(leaseErr)
          }`,
        );
        return 'skipped';
      }
      const attempts = candidate.attempts + 1;
      const failed = await this.prisma.billingRestrictionProjectionIntent.updateMany({
        where: {
          id: candidate.id,
          status: 'PROCESSING',
          leaseId,
          lockedAt: heartbeat.currentLockedAt(),
        },
        data: {
          status: 'FAILED',
          attempts,
          leaseId: null,
          lockedAt: null,
          lastError: err instanceof Error ? err.message : String(err),
          nextRunAt: new Date(Date.now() + this.retryDelayMs(attempts)),
        },
      });
      if (failed.count === 1) {
        this.logger.error(
          `billing restriction projection failed intent=${candidate.id}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
        return 'failed';
      }
      return 'skipped';
    } finally {
      await heartbeat.stop();
    }
  }

  private startLeaseHeartbeat(
    intentId: string,
    leaseId: string,
    initialLockedAt: Date,
  ): ProjectionLeaseHeartbeat {
    let lockedAt = initialLockedAt;
    let lost: BillingRestrictionProjectionLeaseLostError | null = null;
    let stopped = false;
    let timer: NodeJS.Timeout | null = null;
    let inFlight: Promise<void> | null = null;
    const heartbeatMs = Math.max(1_000, Math.floor(this.leaseMs() / 3));

    const schedule = (): void => {
      if (stopped || lost) return;
      timer = setTimeout(() => {
        timer = null;
        inFlight = renew().finally(() => {
          inFlight = null;
          schedule();
        });
        void inFlight;
      }, heartbeatMs);
      timer.unref?.();
    };

    const renew = async (): Promise<void> => {
      if (stopped || lost) return;
      const previousLockedAt = lockedAt;
      const renewedAt = new Date();
      try {
        const renewed = await this.prisma.billingRestrictionProjectionIntent.updateMany({
          where: {
            id: intentId,
            status: 'PROCESSING',
            leaseId,
            lockedAt: previousLockedAt,
          },
          data: { lockedAt: renewedAt },
        });
        if (renewed.count !== 1) {
          lost = new BillingRestrictionProjectionLeaseLostError(
            `ownership changed lease_id=${leaseId}`,
          );
          return;
        }
        lockedAt = renewedAt;
      } catch (err) {
        lost = new BillingRestrictionProjectionLeaseLostError(
          `heartbeat failed lease_id=${leaseId}: ${
            err instanceof Error ? err.message : String(err)
          }`,
        );
      }
    };

    schedule();
    return {
      assertOwned: () => {
        if (lost) throw lost;
      },
      currentLockedAt: () => lockedAt,
      stop: async () => {
        stopped = true;
        if (timer) clearTimeout(timer);
        timer = null;
        const pending = inFlight;
        if (pending) await pending;
      },
    };
  }

  private async resolveTarget(candidate: BillingRestrictionProjectionIntent): Promise<{
    billingAccountId?: string;
    apiKeyId?: string;
  }> {
    if (candidate.billingAccountId?.trim()) {
      return { billingAccountId: candidate.billingAccountId.trim() };
    }
    if (candidate.apiKeyId?.trim()) {
      return { apiKeyId: candidate.apiKeyId.trim() };
    }
    if (!candidate.gatewayBillingEventId) return {};
    const event = await this.prisma.gatewayBillingEvent.findUnique({
      where: { id: candidate.gatewayBillingEventId },
      select: { billingAccountId: true, apiKeyId: true },
    });
    if (event?.billingAccountId?.trim()) {
      return { billingAccountId: event.billingAccountId.trim() };
    }
    if (event?.apiKeyId?.trim()) return { apiKeyId: event.apiKeyId.trim() };
    return {};
  }

  private claimableWhere(
    now: Date,
    staleBefore: Date,
  ): Prisma.BillingRestrictionProjectionIntentWhereInput {
    return {
      OR: [
        {
          status: { in: ['PENDING', 'FAILED'] },
          nextRunAt: { lte: now },
        },
        {
          status: 'PROCESSING',
          lockedAt: { lte: staleBefore },
        },
      ],
    };
  }

  /**
   * Decide whether this intent still has to reach Gateway.
   *
   * The `pending_usage_unreserved` funding guard is created and released inside
   * one request (production p50 19ms / p99 41ms), while this worker sweeps every
   * 15s. Both of the guard's intents therefore observe an already-released
   * restriction, and republishing the account rewrites the identical
   * has_balance for every Key on it -- measured at ~373 outbox rows per guard.
   *
   * The decision is made here rather than inside the fanout on purpose:
   * `syncKeyBalanceByIdOnce` pre-allocates `decision_version` before reading the
   * balance, and the published outbox row is the only thing that advances the
   * Redis CAS fence. Skipping individual writes underneath the fanout would
   * leave the fence behind and let an older in-flight snapshot win; skipping the
   * whole intent never allocates a version at all.
   *
   * Fail-safe direction is always "project": every branch that cannot prove the
   * projection is unchanged falls through to a real fanout.
   */
  private async projectionDecision(
    candidate: BillingRestrictionProjectionIntent,
    target: { billingAccountId?: string; apiKeyId?: string },
  ): Promise<ProjectionDecision> {
    if (!this.transientNoopEnabled()) return { action: 'project' };
    if (!target.billingAccountId && !target.apiKeyId) return { action: 'project' };

    const restriction = await this.prisma.billingAccessRestriction.findUnique({
      where: { id: candidate.billingAccessRestrictionId },
      select: { status: true },
    });
    // A vanished restriction is unexpected; republish authoritative state.
    if (!restriction) return { action: 'project' };

    if (candidate.restrictionStatus === 'ACTIVE') {
      // Still restricted => the shut-down genuinely has to reach every Key.
      if (restriction.status === 'ACTIVE') return { action: 'project' };
      return { action: 'noop', reason: 'activation_already_released' };
    }

    if (candidate.restrictionStatus === 'RELEASED') {
      // Only restore what was actually published as restricted. Any other
      // ACTIVE restriction on the same target keeps the projection restricted,
      // so the release must not be projected as a recovery on its own.
      const activation = await this.prisma.billingRestrictionProjectionIntent.findUnique({
        where: {
          billingAccessRestrictionId_restrictionStatus: {
            billingAccessRestrictionId: candidate.billingAccessRestrictionId,
            restrictionStatus: 'ACTIVE',
          },
        },
        select: { status: true, projected: true },
      });
      if (!activation) return { action: 'project' };
      // Wait for the paired activation instead of guessing what it published.
      if (activation.status !== 'SUCCEEDED') {
        return { action: 'defer', reason: `activation_${activation.status.toLowerCase()}` };
      }
      // NULL predates this column and is treated as "did publish".
      if (activation.projected === false) {
        return { action: 'noop', reason: 'activation_was_noop' };
      }
      return { action: 'project' };
    }

    // Unknown restriction_status: never silently retire it.
    return { action: 'project' };
  }

  private enabled(): boolean {
    return this.bool('BILLING_RESTRICTION_PROJECTION_WORKER_ENABLED', true);
  }

  /**
   * Kill switch for the no-op decision above. Defaults on; setting it to false
   * restores the unconditional fanout that shipped in 9a3cbd3.
   */
  private transientNoopEnabled(): boolean {
    return this.bool('BILLING_RESTRICTION_PROJECTION_TRANSIENT_NOOP_ENABLED', true);
  }

  private deferDelayMs(): number {
    return this.positiveInt('BILLING_RESTRICTION_PROJECTION_DEFER_DELAY_MS', 1_000, 100);
  }

  private intervalMs(): number {
    return this.positiveInt('BILLING_RESTRICTION_PROJECTION_WORKER_INTERVAL_MS', 15_000, 5_000);
  }

  private startupDelayMs(): number {
    return this.positiveInt('BILLING_RESTRICTION_PROJECTION_WORKER_STARTUP_DELAY_MS', 2_000, 0);
  }

  private leaseMs(): number {
    return this.positiveInt('BILLING_RESTRICTION_PROJECTION_WORKER_LEASE_MS', 300_000, 30_000);
  }

  private batchSize(): number {
    return this.positiveInt('BILLING_RESTRICTION_PROJECTION_WORKER_BATCH_SIZE', 50, 1);
  }

  private retryDelayMs(attempts: number): number {
    return Math.min(300_000, 1_000 * 2 ** Math.min(8, Math.max(0, attempts - 1)));
  }

  private positiveInt(key: string, fallback: number, minimum: number): number {
    const raw = this.config.get<string>(key);
    const parsed = Number.parseInt(raw ?? '', 10);
    return Number.isFinite(parsed) && parsed >= minimum ? parsed : fallback;
  }

  private bool(key: string, fallback: boolean): boolean {
    const raw = this.config.get<string>(key);
    if (raw == null || raw.trim() === '') return fallback;
    return ['1', 'true', 'yes', 'on'].includes(raw.trim().toLowerCase());
  }
}
