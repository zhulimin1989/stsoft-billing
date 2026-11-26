import {
  BadRequestException,
  ConflictException,
  Injectable,
  Logger,
  NotFoundException,
  Optional,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { Prisma } from '@prisma/client';
import {
  GatewayProvisionalExposureInvariantError,
  ProvisionalExposureInvariantCode,
  isQuarantineDefaultInvariantCode,
  parseProvisionalExposureInvariantReason,
} from './gateway-provisional-exposure.errors';
import { GatewayProvisionalExposureConfig } from './gateway-provisional-exposure.config';
import {
  billingProvisionalExposureOutcomeTotal,
} from '../metrics/metrics.registry';
import { createHash, randomUUID } from 'crypto';
import { PrismaService } from '../prisma/prisma.service';
import {
  GatewayBillingCurrencyMigrationRequiredError,
  GatewayBillingRevisionConflictError,
  GatewaySettlementAnchorConflictError,
  LATEST_GATEWAY_CUSTOMER_SETTLEMENT_POLICY_VERSION,
  type GatewaySettlementAnchor,
  UsageBillingStrategyService,
  UsageDeductInput,
} from './usage-billing-strategy.service';
import {
  EnterpriseCreditPolicyPendingError,
  GatewayFundingReservationQueuePendingError,
} from './billing.service';
import { ModelAccessDeniedError } from './credit-pricing.service';
import {
  gatewayTenantMismatchTotal,
  gatewayUsageEvidenceContractTotal,
  gatewayUsageReconciliationActionTotal,
  PROVISIONAL_EXPOSURE_OUTCOMES,
} from '../metrics/metrics.registry';
import { GrowthEventsService } from '../growth-events/growth-events.service';
import { PublisherSyncService } from '../publisher/publisher-sync.service';
import {
  requestRecognitionKey,
  reserveUsageLossCoverage,
  upstreamRecognitionKey,
  usageLossCoverageIdentity,
} from './historical-platform-loss-batch.service';
import { prismaErrorCode } from '../common/utils/prisma-error.util';
import { timed } from '../common/runtime/usage-stage-timings';
import {
  evaluateGatewayProviderEvidenceContract,
  parseGatewayEvidenceContractMode,
  parseVerifiedGatewayProducerBuilds,
  type GatewayEvidenceContractIssueCode,
  type GatewayEvidenceContractMode,
} from './gateway-usage-evidence-contract-policy';
import { resolvePlatformCurrency } from './platform-currency';
import { SystemConfigService } from './system-config.service';
import { GATEWAY_EVENT_TERMINAL_STATUSES } from './gateway-event-status';

type JsonObject = Record<string, unknown>;
const SETTLEABLE_USAGE_SOURCES = new Set([
  'provider',
  'estimated_tokenizer',
  // Non-token meters use an explicit count/task result as their authoritative
  // measurement and therefore do not inherit ordinary TokenSource semantics.
  'image_count',
  'video_task',
]);
const CUSTOMER_SETTLEMENT_PURE_AUDIT_ISSUES = new Set<GatewayEvidenceContractIssueCode>([
  'producer_build_sha_missing',
  'producer_build_sha_invalid',
  'producer_build_unverified',
  'provider_usage_hash_missing',
  'provider_usage_hash_invalid',
  'provider_account_ref_missing',
  'upstream_request_id_missing',
]);
const CUSTOMER_SETTLEMENT_CACHE_OMISSION_ISSUES = new Set<GatewayEvidenceContractIssueCode>([
  'usage_dimension_cache_read_missing',
  'usage_dimension_cache_creation_missing',
]);
const PROVIDER_EVIDENCE_ONLY_REASON_PREFIXES = [
  'usage_evidence_',
  'provider_reconciliation_',
  'evidence_contract_',
] as const;
const PROVIDER_EVIDENCE_ONLY_REASONS = new Set([
  'provider_terminal_frame_missing',
  'provider_account_ref_missing',
  'upstream_correlation_id_missing',
]);
// Provider evidence is an internal reconciliation signal, not a customer
// settlement authority. The signed, normalized usage values below still have
// their own strict financial validation; build identity, upstream correlation,
// wire-field presence and terminal-frame attestations are retained for audit
// and alerting without creating a customer hold or access restriction.
const GATEWAY_USAGE_TERMINAL_BILLING_FAILURE_REASONS = [
  'insufficient_balance',
  'insufficient_credits',
] as const;
const GATEWAY_USAGE_RETRYABLE_FAILURE_REASONS = [
  'idempotency_in_progress',
  'billing_rejected',
  'user_required',
  'funding_reservation_queue_pending',
  'funding_reservation_retry_pending',
] as const;
/**
 * provisional exposure 的**唯一**目标 reason，精确等值匹配。
 *
 * ⚠️ 绝不能用前缀匹配：`resolveNoChargeCandidateReason` 的非空返回共 15 种，
 * 本期只要这 1 种，前缀匹配会把其余 14 种全部纳入 —— 那 14 种是证据契约缺陷，
 * 把它们记成平台敞口会掩盖缺陷。
 */
const PROVISIONAL_EXPOSURE_TARGET_REASON =
  'customer_protective_zero:unproven_no_charge:quota_settlement_skipped';

/**
 * 调用点对「这一笔要不要写敞口」的判断，由调用点构造、writer 消费。
 *
 * 用 discriminated union 而不是可选字段，是为了让**漏传必炸**：目标 reason 却没带 decision
 * 说明代码 wiring 有缺陷，静默跳过会导致连续永久漏记。
 */
type ProvisionalExposureDecision =
  | {
      kind: 'write';
      gatewayBillingEventId: string;
      evidenceHash: string;
      originalEvidenceObservedAt: Date;
    }
  | {
      kind: 'legacy_original_evidence_missing';
      gatewayBillingEventId: string;
      evidenceHash: string;
    }
  | { kind: 'forced_skip' };

/**
 * writer 的归因取值。
 *
 * ⚠️ 从 metrics 的零值预热清单**派生**，不再手写一份（评审 P1）：先前两份清单没有任何
 * 编译期关联，把 `disabled` 改成 `schema_not_ready` 时 metrics 那侧漏改，全套测试照旧全绿。
 * 现在改一处、另一处编译期就红。
 */
type ProvisionalExposureOutcome = typeof PROVISIONAL_EXPOSURE_OUTCOMES[number];

const PERMANENT_NO_CHARGE_REASONS = new Set([
  'quota_exceeded',
  'zero_usage',
]);
// Dedicated two-int PostgreSQL advisory-lock namespace for allocating the
// immutable per-account BALANCE receipt queue. It does not overlap plan locks.
const GATEWAY_BALANCE_RECEIPT_SEQUENCE_LOCK_NAMESPACE = 1_824_771_306;

type GatewayUsageTerminalBillingFailureReason =
  typeof GATEWAY_USAGE_TERMINAL_BILLING_FAILURE_REASONS[number];
type GatewayUsageRetryableFailureReason =
  typeof GATEWAY_USAGE_RETRYABLE_FAILURE_REASONS[number];
type GatewayEventClassification =
  | {
      billable: true;
    }
  | {
      billable: false;
      reason: string;
      record: boolean;
    };

type BillingFailureClassification =
  | {
      terminal: true;
      reason: GatewayUsageTerminalBillingFailureReason;
    }
  | {
      terminal: false;
      reason: GatewayUsageRetryableFailureReason;
    };

export type GatewayRequestEventBillingResult = {
  action: 'deducted' | 'skipped' | 'failed' | 'quarantined' | 'absorbed' | 'debt_open';
  requestId: string;
  reason?: string;
  errorMessage?: string;
  revision?: number;
  evidenceVerdict?: string;
  reconciliationStatus?: string;
  fundingOutcome?: string;
  billing?: Record<string, unknown>;
  mapped?: {
    apiKeyId?: string;
    tenantId?: string;
    productId?: string;
    productSlug?: string;
    userId?: string;
    modelName: string;
    inputTokens: number;
    outputTokens: number;
    cachedInputTokens: number;
    cacheWriteInputTokens: number;
    totalTokens: number;
  };
};

export type GatewayReconciliationCommand = {
  expectedRevision: number;
  reason: string;
  idempotencyKey: string;
  actorId: string;
};

export const GATEWAY_UNANCHORED_ABSORB_PROTOCOL = 'gateway-unanchored-absorb-v1';
const GATEWAY_UNANCHORED_CURRENCY_FAILURE_CODE =
  'BILLING_CURRENCY_MIGRATION_REQUIRED';
const GATEWAY_UNANCHORED_CURRENCY_FAILURE_REASON = 'settlement_anchor_missing';
const GATEWAY_UNANCHORED_CURRENCY_ERROR_FINGERPRINT =
  'f7c470fb73da49f0ed8b517ec5993e0c3a1796e08b4b8835c03d96fb9364d137';

export type GatewayAbsorbCommand = GatewayReconciliationCommand & {
  /**
   * Omitted means the original, reservation-backed finance absorption flow.
   * The only accepted explicit protocol is the narrow first-receipt currency
   * migration closure; unknown values fail closed instead of changing the
   * meaning of the established endpoint.
   */
  protocol?: string;
  currencyRepairRunId?: string;
  currencyRepairItemId?: string;
  manifestHash?: string;
};

type GatewayUnanchoredAbsorbRepairProof = {
  currencyRepairRunId: string;
  currencyRepairItemId: string;
  manifestHash: string;
};

type AtomicGatewayReconciliationAction = {
  action: 'TECHNICAL_RETRY';
  command: GatewayReconciliationCommand;
};

/// 首收证据的观察时间三态。
///
/// provisional exposure 的 cutover 必须用「首收 evidence 的 observedAt」做判据 ——
/// **不能**用父事件的 receivedAt：重复收件时它会被改写成当轮时间（见本函数内 receivedAt 更新），
/// 实测 test 库有 22 笔 received_at 与 rev1 observed_at 不一致、最大漂移 6 天 19 小时。
///
/// 而历史父事件里有大量根本没有 original evidence 的行（迁移时 21,593 / 24,009），
/// 它们被重新收件时若用**本轮**时间冒充首收时间，就会被误判为「T 之后首收」而错误计入敞口。
/// 因此这类行由 legacy_original_evidence_missing_at 墓碑永久冻结、永久排除。
type OriginalEvidenceObservation =
  | { kind: 'available'; observedAt: Date }
  | { kind: 'legacy_original_evidence_missing' };

type ReceivedEvidence = {
  eventId: string;
  /// 父事件主键。provisional exposure 的 decision 与绑定断言都要用它。
  gatewayBillingEventId: string;
  firstReceiptCreated: boolean;
  existingStatus: string | null;
  existingReconciliationStatus: string | null;
  revision: number;
  evidenceHash: string;
  originalEvidenceHash: string;
  originalRawEvent: JsonObject;
  /// 在父行锁内、**追加本轮 evidence 之前**冻结，见 recordReceivedInner。
  originalEvidenceObservation: OriginalEvidenceObservation;
  /// 供 provisional exposure 的 QUARANTINED 窄例外判定用（同 evidence 修复重放）。
  existingReason: string | null;
  settlementAnchor: GatewaySettlementAnchor | null;
  fundingReservationStatus: string | null;
  settlementAnchorError?: string;
  settlementAnchorFailureKind?: 'MALFORMED' | 'CONFLICT' | 'CONFIGURATION';
};

type CustomerSettlementDimensions = {
  inputTokens: number;
  outputTokens: number;
  cachedInputTokens: number;
  cacheWriteInputTokens: number;
  totalTokens: number;
  imageCount: number;
};

type CustomerSettlementAssessment = {
  input: UsageDeductInput;
  evidenceReason: string | null;
  customerProtectionReason: string | null;
  basis: NonNullable<UsageDeductInput['gatewayCustomerSettlement']>['basis'] | null;
};

type PendingBalanceFundingState = {
  apiKeyId: string;
  userId: string;
  tenantId: string;
  billingAccountId: string;
  productId: string;
  productSlug: string;
  amountUsd: Prisma.Decimal;
};

class RetryableGatewayBillingError extends Error {
  constructor(
    readonly reason: GatewayUsageRetryableFailureReason,
    readonly originalError?: unknown,
  ) {
    super(`Gateway billing retryable failure: ${reason}`);
  }
}

const RETRYABLE_FUNDING_PRISMA_CODES = new Set([
  'P1001', // database server unreachable
  'P1002', // database server timeout
  'P1008', // operation timeout
  'P1017', // server closed connection
  'P2024', // connection-pool timeout
  'P2034', // serialization failure / deadlock
]);
const RETRYABLE_FUNDING_NETWORK_CODES = new Set([
  'ECONNREFUSED',
  'ECONNRESET',
  'EPIPE',
  'ETIMEDOUT',
]);

function isRetryableFundingReservationFailure(error: unknown): boolean {
  if (
    error instanceof GatewayFundingReservationQueuePendingError
    || error instanceof EnterpriseCreditPolicyPendingError
  ) {
    return true;
  }
  const prismaCode = prismaErrorCode(error);
  if (prismaCode && RETRYABLE_FUNDING_PRISMA_CODES.has(prismaCode)) return true;
  const networkCode = error && typeof error === 'object'
    ? (error as { code?: unknown }).code
    : undefined;
  return typeof networkCode === 'string'
    && RETRYABLE_FUNDING_NETWORK_CODES.has(networkCode);
}

/**
 * A signed Gateway event whose immutable payload cannot be mapped into a
 * settlement instruction. Unlike mutable billing configuration (pricing,
 * entitlement, subject provisioning), retrying this exact payload can never
 * make it valid.
 */
class MalformedGatewayUsageEventError extends BadRequestException {}

// Extracted from recordFinalState's inline parameter so the stage-timing
// delegate can restate the signature without duplicating the shape.
type RecordFinalStateOptions = {
  input?: UsageDeductInput;
  reason?: string;
  billing?: Record<string, unknown>;
  errorMessage?: string;
  evidenceVerdict?: string;
  reconciliationStatus?: string;
  fundingOutcome?: string;
  pendingExposureUsd?: Prisma.Decimal;
  actorId?: string;
  createDebtRestriction?: boolean;
  restrictionReason?: 'settlement_retry_pending' | 'settlement_policy_review';
  pendingFundingState?: PendingBalanceFundingState;
  releaseRetryRestriction?: boolean;
  releaseReconciliationRestrictions?: boolean;
  /**
   * 保留父事件的 pending 字段与仍然 active 的首次资金 guard。
   *
   * 默认路径会把 `pendingHoldUsd` 写成 0，等于释放首次资金 guard；provisional exposure
   * 的不变量破坏走 block 时**必须**保住它，否则「不 commit、等人修」的同时资金 guard
   * 已经松掉，与 fail-closed 相矛盾。
   *
   * ⚠️ 它是显式 option，**不得**用 `pendingFundingState` 或 funding queue 语义顶替 ——
   * 那两者会**重建**状态并可能创建 retry restriction，语义完全不同。
   */
  preserveInitialFundingGuard?: boolean;
  /**
   * provisional exposure 的写入决策。
   *
   * 只有 DEDUCTED 这一个调用点会构造它。非目标 reason ⇒ `undefined`；
   * 目标 reason 却 `undefined` ⇒ writer 抛 `decision_missing`（BLOCK_PARTITION）。
   */
  provisionalExposureDecision?: ProvisionalExposureDecision;
  /**
   * provisional exposure 的历史边界，**必须在事务外解析好**再传进来。
   *
   * ⚠️ 不要在 writer 里现读（评审 P0）：writer 跑在结算事务内部，那里再 `$queryRaw`
   * 会从连接池另借一条连接；边界未就绪的稳定态下每条目标事件都会这么干一次，
   * 并发时池等待可能超过事务预算（Prisma 默认 5s）⇒ P2028/P2024 ⇒ **正常结算事务失败**、
   * 重试、乃至卡 partition。旁路观测绝不能有这种能力。
   *
   * `undefined` = 非目标 reason，压根没解析；`null` = 解析了但 schema 未就绪。
   */
  provisionalExposureBoundary?: Date | null;
  reconciliationAction?: AtomicGatewayReconciliationAction;
  noChargeProof?: {
    gatewayBillingEventId: string;
    evidenceHash: string;
    anchor: GatewaySettlementAnchor;
  };
};

@Injectable()
export class GatewayRequestEventBillingService {
  private readonly logger = new Logger(GatewayRequestEventBillingService.name);
  private readonly evidenceContractMode: GatewayEvidenceContractMode;
  private readonly verifiedProducerBuilds: ReadonlySet<string>;
  private readonly loggedShadowEvidenceIssues = new Set<string>();

  constructor(
    private readonly usageBilling: UsageBillingStrategyService,
    private readonly prisma: PrismaService,
    @Optional() private readonly config?: ConfigService,
    @Optional() private readonly growthEvents?: GrowthEventsService,
    @Optional() private readonly publisherSync?: PublisherSyncService,
    @Optional() private readonly systemConfig?: SystemConfigService,
    @Optional()
    private readonly provisionalExposureConfig?: GatewayProvisionalExposureConfig,
  ) {
    // Missing/invalid evidence governance is an internal drift signal, not a
    // customer-settlement startup gate. Shadow is the safe runtime default.
    this.evidenceContractMode = parseGatewayEvidenceContractMode(
      this.config?.get<string>('BILLING_USAGE_EVIDENCE_CONTRACT_MODE'),
    ) ?? 'shadow';
    this.verifiedProducerBuilds = parseVerifiedGatewayProducerBuilds(
      this.config?.get<string>('BILLING_USAGE_VERIFIED_PRODUCER_BUILDS'),
    );
  }

  /**
   * Production ingestion must prove the database financial contracts before
   * opening Kafka connections. Provider-evidence rollout/build drift is an
   * internal health signal only: refusing to consume on that drift would leave
   * otherwise valid funding reservations ACTIVE and turn an audit issue into a
   * customer hold. The runtime role still may only read evidence governance.
   */
  async assertReachableGatewayBillingAccountCurrencies(): Promise<void> {
    await this.usageBilling.assertReachableGatewayBillingAccountCurrencies();
  }

  async assertProductionSettlementPreflight(
    options: { reachableCurrencyAlreadyAsserted?: boolean } = {},
  ): Promise<void> {
    await this.prisma.$queryRaw<Array<{ asserted: string | null }>>`
      SELECT assert_gateway_balance_ledger_v2_contract()::TEXT AS "asserted"
    `;
    if (!options.reachableCurrencyAlreadyAsserted) {
      await this.assertReachableGatewayBillingAccountCurrencies();
    }

    const appendPrivileges = await this.prisma.$queryRaw<
      Array<{
        runtimeCanAppend: boolean;
        runtimeCanMutateAuthority: boolean;
        runtimeCanTransitionEvidenceMode: boolean;
        runtimeCanMutateEvidenceMode: boolean;
      }>
    >`
      SELECT
        has_function_privilege(
          current_user,
          'public.append_gateway_producer_build_authorization(text,text,text,text,text)',
          'EXECUTE'
        ) AS "runtimeCanAppend",
        has_table_privilege(
          current_user,
          'public.gateway_producer_build_authorization_events',
          'INSERT,UPDATE,DELETE'
        ) AS "runtimeCanMutateAuthority",
        has_function_privilege(
          current_user,
          'public.transition_gateway_usage_evidence_contract_mode(text,text,text,text)',
          'EXECUTE'
        ) AS "runtimeCanTransitionEvidenceMode",
        has_table_privilege(
          current_user,
          'public.gateway_usage_evidence_contract_rollout_control',
          'INSERT,UPDATE,DELETE'
        ) AS "runtimeCanMutateEvidenceMode"
    `;
    if (
      appendPrivileges.length !== 1
      || appendPrivileges[0]?.runtimeCanAppend !== false
      || appendPrivileges[0]?.runtimeCanMutateAuthority !== false
      || appendPrivileges[0]?.runtimeCanTransitionEvidenceMode !== false
      || appendPrivileges[0]?.runtimeCanMutateEvidenceMode !== false
    ) {
      throw new Error(
        'Billing runtime DB role must not mutate Gateway build authority or evidence rollout state; use a separate migration/DBA role',
      );
    }

    const databaseContractModes = await this.prisma.$queryRaw<
      Array<{ mode: string; transactionIsolation: string }>
    >`
      SELECT
        current_gateway_usage_evidence_contract_mode() AS "mode",
        current_setting('transaction_isolation') AS "transactionIsolation"
    `;
    const transactionIsolation = databaseContractModes.length === 1
      ? databaseContractModes[0]?.transactionIsolation?.trim().toLowerCase()
      : null;
    if (transactionIsolation !== 'read committed') {
      throw new Error(
        `Billing runtime database session must use READ COMMITTED transaction isolation (database=${transactionIsolation ?? 'missing'})`,
      );
    }
    const databaseContractMode = databaseContractModes.length === 1
      ? databaseContractModes[0]?.mode?.trim().toLowerCase()
      : null;
    if (databaseContractMode !== this.evidenceContractMode) {
      gatewayUsageEvidenceContractTotal.inc({
        mode: this.evidenceContractMode,
        outcome: 'preflight_drift',
        issue: 'rollout_mode_mismatch',
      });
      this.logger.warn(
        `Gateway evidence rollout mode drift (configured=${this.evidenceContractMode}, database=${databaseContractMode ?? 'missing'}); `
        + 'continuing customer settlement while provider evidence remains internally observable',
      );
    }

    const currentAuthority = await this.prisma.$queryRaw<
      Array<{ producerBuildSha: string }>
    >`
      SELECT producer_build_sha AS "producerBuildSha"
      FROM current_gateway_producer_build_authorizations()
      ORDER BY producer_build_sha
    `;
    const databaseBuilds = currentAuthority
      .map((row) => row.producerBuildSha)
      .sort();
    const configuredBuilds = [...this.verifiedProducerBuilds].sort();
    if (
      databaseBuilds.length !== configuredBuilds.length
      || databaseBuilds.some((sha, index) => sha !== configuredBuilds[index])
    ) {
      gatewayUsageEvidenceContractTotal.inc({
        mode: this.evidenceContractMode,
        outcome: 'preflight_drift',
        issue: 'build_authority_mismatch',
      });
      this.logger.warn(
        `Gateway producer build authority drift (configured=${configuredBuilds.length}, database=${databaseBuilds.length}); `
        + 'continuing customer settlement while provider evidence remains internally observable',
      );
    }
  }

  async process(
    event: unknown,
    opts: {
      force?: boolean;
      expectedRevision?: number;
      actorId?: string;
      reconciliationAction?: AtomicGatewayReconciliationAction;
      settlementReconcilesEvidence?: boolean;
    } = {},
  ): Promise<GatewayRequestEventBillingResult> {
    let root = asObject(event, 'GatewayEvent');
    const requestId = requiredString(root.request_id, 'request_id');
    let classification = this.classifyEvent(root);
    if (!classification.billable && !classification.record) {
      return { action: 'skipped', requestId, reason: classification.reason };
    }

    const received = await this.recordReceived(
      root,
      requestId,
      classification.billable,
    );
    if (opts.expectedRevision !== undefined && received.revision !== opts.expectedRevision) {
      throw new GatewayBillingRevisionConflictError();
    }

    if (!opts.force && received.existingStatus && GATEWAY_EVENT_TERMINAL_STATUSES.has(received.existingStatus)) {
      if (received.evidenceHash !== received.originalEvidenceHash) {
        // The evidence row may already have been appended by a previous
        // attempt that crashed before the parent event was transitioned. The
        // canonical payload comparison, not createMany().count, therefore
        // decides whether this replay conflicts. Once conflict is recorded we
        // keep the permanent terminal result and avoid revision churn.
        await this.recordInternalEvidenceConflict(
          requestId,
          received.revision,
          'terminal_event_received_different_evidence',
          received.evidenceHash,
        );
        await this.syncEventRestriction(requestId, true);
      }
      const replay = await this.findCommittedResult(requestId);
      if (replay) {
        if (
          replay.action === 'skipped'
          && received.settlementAnchor?.billingUnit === 'BALANCE'
        ) {
          // A replay may carry new/conflicting raw evidence. Funding release
          // is authorized only by the already-committed terminal proof, never
          // by reclassifying the replay payload.
          const committedSkipReason = replay.reason;
          if (
            !committedSkipReason
            || !PERMANENT_NO_CHARGE_REASONS.has(committedSkipReason)
          ) {
            throw new GatewaySettlementAnchorConflictError(
              '已提交 NO_CHARGE 事件缺少可验证的永久不收费原因',
            );
          }
          await this.usageBilling.releaseGatewayBalanceFunding(
            requestId,
            `non_financial:${committedSkipReason}`,
          );
        }
        if (replay.action === 'debt_open') {
          await this.ensureDebtRestriction(requestId, true);
        }
        await this.releaseSettlementRetryRestriction(
          received.eventId,
          opts.actorId,
        );
        // A committed terminal replay is also the repair path for a prior
        // publisher-sync failure. Re-sync even when the restriction row was
        // already released by the transaction that committed settlement.
        await this.syncEventRestriction(requestId, true);
        await this.recordFirstSuccessfulApiCall(root, replay);
        return replay;
      }
    }

    // provisional exposure 不变量破坏被修好之后，事件必须能重放 —— 否则敞口永久缺失。
    // 但 QUARANTINED 有快速返回，重放会被它拦掉，所以需要一个**四条件精确**的窄例外。
    //
    // 为什么它不会打开重复扣费口子：它只让流程越过 quarantine 快速返回，
    // **不绕过资金幂等层** —— requestId、首次 anchor、原 evidence hash 都不变，
    // 结算仍走原 settlement fingerprint 与永久 receipt 幂等键；exposure 仍是
    // createMany(skipDuplicates) + 完整读回比对。可能重复执行控制流，但不会新增
    // 第二笔 TokenUsage / 余额流水 / funding receipt / exposure。
    //
    // ⚠️ 其余 quarantine 场景（anchor 缺失、funding review、契约非法、**未知 invariant
    // 后缀**、**不同 evidence**）行为一律不变。
    const repairableInvariantCode = parseProvisionalExposureInvariantReason(
      received.existingReason,
    );
    const isRepairableInvariantReplay =
      !opts.force
      && received.existingStatus === 'QUARANTINED'
      && repairableInvariantCode !== null
      && isQuarantineDefaultInvariantCode(repairableInvariantCode)
      && received.evidenceHash === received.originalEvidenceHash;

    if (
      !opts.force &&
      received.existingStatus === 'QUARANTINED' &&
      !isRepairableInvariantReplay
    ) {
      if (received.evidenceHash !== received.originalEvidenceHash) {
        await this.recordInternalEvidenceConflict(
          requestId,
          received.revision,
          'quarantined_event_received_different_evidence',
          received.evidenceHash,
        );
        // The incoming correction remains append-only internal evidence. Keep
        // the existing financial quarantine unchanged: it may represent a
        // genuine anchor/funding defect and must not be overwritten by a
        // provider-evidence verdict.
        await this.syncEventRestriction(requestId, true);
        return this.quarantinedResult(requestId);
      }
      // Replays are the recovery path for a process crash after the durable
      // quarantine commit but before the account-level pending threshold and
      // Publisher projection were refreshed. Recompute the aggregate before
      // acknowledging Kafka and require the projection to be accepted.
      const quarantinedEvent = await this.prisma.gatewayBillingEvent.findUnique({
        where: { requestId },
        select: { billingAccountId: true },
      });
      await this.refreshPendingAccessRestriction(
        requestId,
        quarantinedEvent?.billingAccountId ?? undefined,
      );
      await this.syncEventRestriction(requestId, true);
      return this.quarantinedResult(requestId);
    }

    let settlementEvidenceHash = received.evidenceHash;
    if (
      !opts.force &&
      received.existingStatus &&
      received.evidenceHash !== received.originalEvidenceHash
    ) {
      await this.recordInternalEvidenceConflict(
        requestId,
        received.revision,
        'non_terminal_event_received_different_evidence',
        received.evidenceHash,
      );
      // The transaction above may have released an evidence_conflict access
      // restriction created by an older Billing version. Project that release
      // immediately even while the financial parent is still RECEIVED; later
      // settlement projections remain responsible for genuine funding/debt
      // restrictions.
      await this.syncEventRestriction(requestId, true);
      // Provider corrections never choose the customer-financial input. The
      // immutable first receipt and anchor are the settlement authority. This
      // also closes the crash window where a permanent financial receipt was
      // committed before the parent status: replaying the original input and
      // idempotency key recovers that receipt instead of charging twice or
      // creating an evidence restriction.
      root = received.originalRawEvent;
      if (canonicalSha256(root) !== received.originalEvidenceHash) {
        throw new GatewaySettlementAnchorConflictError(
          'Gateway 首次收件 rawEvent 与不可变 evidence hash 不一致',
        );
      }
      if (requiredString(root.request_id, 'request_id') !== requestId) {
        throw new GatewaySettlementAnchorConflictError(
          'Gateway 首次收件 request_id 与父事件不一致',
        );
      }
      classification = this.classifyEvent(root);
      settlementEvidenceHash = received.originalEvidenceHash;
    }

    const fundingReservationOverrideActionId = opts.force
      ? await this.approvedFundingReservationOverrideAction(
          received.eventId,
          requestId,
          received.evidenceHash,
        )
      : null;
    let deductInput: UsageDeductInput | undefined;
    let financialTerminalCommitted = false;
    // provisional exposure 的不变量破坏在 catch 里需要把**已提交的**结算结果一起写进
    // QUARANTINED 父状态，否则 billingResult / fundingOutcome 会被抹成空，
    // 让一笔钱已落地的事件在库里看起来像没结算过。
    let committedBilling: Record<string, unknown> | undefined;
    let committedFundingOutcome: string | undefined;
    let providerEvidenceAuditReason: string | null = null;
    try {
      if (!classification.billable) {
        const revision = await this.recordFinalState(root, requestId, received.revision, 'SKIPPED', {
          reason: classification.reason,
          reconciliationAction: opts.reconciliationAction,
          releaseReconciliationRestrictions: opts.settlementReconcilesEvidence === true,
        });
        return {
          action: 'skipped',
          requestId,
          reason: classification.reason,
          revision,
          reconciliationStatus: 'CLOSED',
        };
      }

      if (!received.settlementAnchor) {
        const errorMessage = received.settlementAnchorError
          ?? '历史或并发首次收件未形成不可变 settlement anchor';
        if (received.settlementAnchorFailureKind === 'MALFORMED') {
          const apiKeyId = this.resolveApiKeyId(root, this.eventLabels(root));
          const status = apiKeyId ? 'QUARANTINED' : 'FAILED';
          const revision = await this.recordFinalState(
            root,
            requestId,
            received.revision,
            status,
            {
              reason: 'invalid_event_contract',
              errorMessage,
              evidenceVerdict: 'INCOMPLETE',
              reconciliationStatus: 'MANUAL_REVIEW',
              reconciliationAction: opts.reconciliationAction,
              ...(apiKeyId ? { restrictionReason: 'settlement_policy_review' as const } : {}),
            },
          );
          if (apiKeyId) await this.syncEventRestriction(requestId, true);
          return {
            action: apiKeyId ? 'quarantined' : 'failed',
            requestId,
            reason: 'invalid_event_contract',
            errorMessage,
            revision,
            evidenceVerdict: 'INCOMPLETE',
            reconciliationStatus: 'MANUAL_REVIEW',
          };
        }
        const revision = await this.recordFinalState(
          root,
          requestId,
          received.revision,
          'QUARANTINED',
          {
            reason: 'settlement_anchor_missing',
            errorMessage,
            evidenceVerdict: 'INCOMPLETE',
            reconciliationStatus: 'MANUAL_REVIEW',
            restrictionReason: 'settlement_policy_review',
            reconciliationAction: opts.reconciliationAction,
          },
        );
        await this.syncEventRestriction(requestId, true);
        return {
          action: 'quarantined',
          requestId,
          reason: 'settlement_anchor_missing',
          errorMessage,
          revision,
          evidenceVerdict: 'INCOMPLETE',
          reconciliationStatus: 'MANUAL_REVIEW',
        };
      }

      let fundingReservation: Awaited<
        ReturnType<UsageBillingStrategyService['reserveGatewayBalanceFunding']>
      > = null;
      if (received.settlementAnchor.billingUnit === 'BALANCE') {
        const reservationEligible =
          received.settlementAnchor.fundingReservationProtocol === 'V1'
          && Boolean(received.settlementAnchor.firstReceiptSequence);
        if (
          !received.fundingReservationStatus
          && !received.firstReceiptCreated
          && !reservationEligible
        ) {
          const errorMessage = '首次收件未形成资金预占，禁止按当前余额补造历史 reservation';
          const revision = await this.recordFinalState(
            root,
            requestId,
            received.revision,
            'QUARANTINED',
            {
              reason: 'funding_reservation_missing',
              errorMessage,
              evidenceVerdict: 'INCOMPLETE',
              reconciliationStatus: 'MANUAL_REVIEW',
              restrictionReason: 'settlement_policy_review',
              reconciliationAction: opts.reconciliationAction,
            },
          );
          await this.syncEventRestriction(requestId, true);
          return {
            action: 'quarantined',
            requestId,
            reason: 'funding_reservation_missing',
            errorMessage,
            revision,
            evidenceVerdict: 'INCOMPLETE',
            reconciliationStatus: 'MANUAL_REVIEW',
          };
        }
        try {
          // Takes the per-account funding queue head; a lock-contention
          // candidate, so worth separating from the settlement itself.
          // The anchor is bound to a local first: a closure would otherwise
          // discard the non-null narrowing established by the guard above.
          const reservationAnchor = received.settlementAnchor;
          fundingReservation = await timed('reserveFunding', () =>
            this.usageBilling.reserveGatewayBalanceFunding(
              received.eventId,
              reservationAnchor,
            ),
          );
        } catch (err) {
          if (err instanceof GatewayBillingCurrencyMigrationRequiredError) {
            throw err;
          }
          if (err instanceof GatewayFundingReservationQueuePendingError) {
            // The lower sequence still owns the head of the account funding
            // queue. Keep pending_usage_unreserved active and let the Kafka
            // delivery retry; this is not evidence conflict/manual review.
            throw err;
          }
          if (isRetryableFundingReservationFailure(err)) {
            // Preserve Kafka redelivery and the first-receipt guard. A credit
            // boundary confirmation, serialization retry, or recovered DB
            // connection can make this exact immutable receipt succeed later.
            throw new RetryableGatewayBillingError(
              'funding_reservation_retry_pending',
              err,
            );
          }
          const errorMessage = err instanceof Error ? err.message : String(err);
          const revision = await this.recordFinalState(
            root,
            requestId,
            received.revision,
            'QUARANTINED',
            {
              reason: 'funding_reservation_unavailable',
              errorMessage,
              evidenceVerdict: 'INCOMPLETE',
              reconciliationStatus: 'MANUAL_REVIEW',
              restrictionReason: 'settlement_policy_review',
              reconciliationAction: opts.reconciliationAction,
            },
          );
          await this.syncEventRestriction(requestId, true);
          return {
            action: 'quarantined',
            requestId,
            reason: 'funding_reservation_unavailable',
            errorMessage,
            revision,
            evidenceVerdict: 'INCOMPLETE',
            reconciliationStatus: 'MANUAL_REVIEW',
          };
        }
        if (
          fundingReservation?.status === 'MANUAL_REVIEW'
          && !fundingReservationOverrideActionId
        ) {
          const revision = await this.recordFinalState(
            root,
            requestId,
            received.revision,
            'QUARANTINED',
            {
              reason: 'funding_reservation_manual_review',
              errorMessage: fundingReservation.reviewReason ?? undefined,
              evidenceVerdict: 'INCOMPLETE',
              reconciliationStatus: 'MANUAL_REVIEW',
              restrictionReason: 'settlement_policy_review',
              reconciliationAction: opts.reconciliationAction,
            },
          );
          await this.syncEventRestriction(requestId, true);
          return {
            action: 'quarantined',
            requestId,
            reason: 'funding_reservation_manual_review',
            revision,
            evidenceVerdict: 'INCOMPLETE',
            reconciliationStatus: 'MANUAL_REVIEW',
          };
        }
      }

      // A permanent NO_CHARGE outcome is a financial fact because it releases
      // an admission hold. Exact proof keeps its dedicated receipt. Heuristic
      // no-charge candidates continue below as an ordinary zero-meter customer
      // protective settlement, which is financially conservative without
      // pretending that provider evidence proved permanent NO_CHARGE.
      const skipReason = this.resolvePermanentNoChargeReason(root);
      if (skipReason) {
        const revision = await this.recordFinalState(root, requestId, received.revision, 'SKIPPED', {
          reason: skipReason,
          fundingOutcome: fundingReservation ? 'NO_CHARGE' : undefined,
          reconciliationAction: opts.reconciliationAction,
          releaseReconciliationRestrictions: opts.settlementReconcilesEvidence === true,
          ...(fundingReservation && received.settlementAnchor.billingUnit === 'BALANCE'
            ? {
                noChargeProof: {
                  gatewayBillingEventId: received.eventId,
                  evidenceHash: settlementEvidenceHash,
                  anchor: received.settlementAnchor,
                },
              }
            : {}),
        });
        if (fundingReservation) {
          // The permanent NO_CHARGE proof commits first. A crash between these
          // transactions leaves an extra hold (safe); Kafka replay repairs it.
          financialTerminalCommitted = true;
          await this.usageBilling.releaseGatewayBalanceFunding(
            requestId,
            `non_financial:${skipReason}`,
          );
          // The terminal-state outbox can project while the durable reservation
          // is still ACTIVE, before this separate release transaction commits.
          // A fresh required projection after the release closes that window;
          // its monotonic revision also prevents an older worker snapshot from
          // overwriting the released balance state. Failure keeps Kafka
          // replayable, and the terminal replay path repeats release + sync.
          await this.syncEventRestriction(requestId, true);
        }
        return {
          action: 'skipped',
          requestId,
          reason: skipReason,
          revision,
          reconciliationStatus: 'CLOSED',
        };
      }

      const unprovenNoChargeReason = this.resolveNoChargeCandidateReason(root);
      const usageUncertaintyReason = this.resolveSettlementUsageUncertaintyReason(root);
      const forcedCustomerProtectionReason = unprovenNoChargeReason
        ? `unproven_no_charge:${unprovenNoChargeReason}`
        : usageUncertaintyReason;

      providerEvidenceAuditReason = this.resolveProviderEvidenceAuditReason(root);
      const rawInput = this.toAnchoredDeductInput(
        root,
        requestId,
        received.settlementAnchor,
      );
      const customerSettlement = this.assessCustomerSettlement(
        root,
        received.settlementAnchor,
        rawInput,
        providerEvidenceAuditReason,
        forcedCustomerProtectionReason,
      );
      const input = customerSettlement.input;
      providerEvidenceAuditReason ??= customerSettlement.evidenceReason;
      const providerEvidenceVerdict = providerEvidenceAuditReason
        ? 'INCOMPLETE'
        : 'SETTLEABLE_BY_POLICY';
      const providerReconciliationStatus = providerEvidenceAuditReason
        ? 'OPEN'
        : 'CLOSED';

      deductInput = input;
      // The actual money movement (wallet + ledger + the deferred constraint
      // triggers that fire at COMMIT); the largest uninstrumented step in the
      // first measurement round.
      // Anchor bound to a local first: a closure would otherwise discard the
      // non-null narrowing established earlier in this branch.
      const settlementAnchor = received.settlementAnchor;
      const billing = await timed('settleUsage', () =>
        this.usageBilling.settleDeliveredGatewayUsage(input, {
          gatewayBillingEventId: received.eventId,
          expectedRevision: received.revision,
          evidenceHash: settlementEvidenceHash,
          anchor: settlementAnchor,
          fundingReservationOverrideActionId:
            fundingReservationOverrideActionId ?? undefined,
        }),
      );
      // A returned TokenUsage id is the application-level proof that the
      // Gateway financial transaction and permanent receipt committed. From
      // this point a parent projection failure must leave the original parent
      // revision untouched so the same fingerprint can replay that receipt.
      // Mutable authorization rejections do not carry TokenUsage and may still
      // transition to the ordinary retry/manual-review workflow below.
      financialTerminalCommitted = Boolean(stringValue(billing.tokenUsageId));
      committedBilling = billing;
      const tenantMismatchReason = this.gatewayTenantMismatchReason(input, billing);
      const customerSettlementReason = tenantMismatchReason ?? (
        customerSettlement.basis === 'CUSTOMER_PROTECTIVE_ZERO'
          ? `customer_protective_zero:${customerSettlement.customerProtectionReason
            ?? 'provider_evidence_incomplete'}`
          : customerSettlement.evidenceReason
            ? `provider_evidence_open:${customerSettlement.evidenceReason}`
            : undefined
      );
      const failure = this.billingFailureReason(billing);
      if (failure) {
        if (!failure.terminal) {
          if (failure.reason === 'idempotency_in_progress') {
            throw new RetryableGatewayBillingError(failure.reason);
          }
          const revision = await this.recordFinalState(
            root,
            requestId,
            received.revision,
            'QUARANTINED',
            {
              input,
              reason: failure.reason,
              billing,
              evidenceVerdict: providerEvidenceVerdict,
              reconciliationStatus: 'MANUAL_REVIEW',
              pendingExposureUsd: this.settlementAmountUsd(billing),
              restrictionReason: 'settlement_policy_review',
              releaseRetryRestriction: received.existingStatus === 'RETRYABLE_FAILED',
              actorId: opts.actorId,
              reconciliationAction: opts.reconciliationAction,
            },
          );
          await this.syncEventRestriction(requestId, true);
          return {
            action: 'quarantined',
            requestId,
            reason: failure.reason,
            billing,
            mapped: toMapped(input),
            revision,
            evidenceVerdict: providerEvidenceVerdict,
            reconciliationStatus: 'MANUAL_REVIEW',
          };
        }
        if (
          failure.reason === 'insufficient_balance' ||
          failure.reason === 'insufficient_credits'
        ) {
          const revision = await this.recordDebtOpen(
            root,
            requestId,
            received.revision,
            input,
            billing,
            failure.reason,
            opts.actorId,
            received.existingStatus === 'RETRYABLE_FAILED',
            opts.reconciliationAction,
            opts.settlementReconcilesEvidence === true,
            providerEvidenceVerdict,
            providerReconciliationStatus,
          );
          financialTerminalCommitted = true;
          await this.ensureDebtRestriction(requestId, true);
          return {
            action: 'debt_open',
            requestId,
            reason: failure.reason,
            billing,
            mapped: toMapped(input),
            revision,
            evidenceVerdict: providerEvidenceVerdict,
            reconciliationStatus: providerReconciliationStatus,
            fundingOutcome: 'DEBT_OPEN',
          };
        }
        const revision = await this.recordFinalState(root, requestId, received.revision, 'FAILED', {
          input,
          reason: failure.reason,
          billing,
          reconciliationAction: opts.reconciliationAction,
        });
        return {
          action: 'failed',
          requestId,
          reason: failure.reason,
          billing,
          mapped: toMapped(input),
          revision,
          evidenceVerdict: 'SETTLEABLE_BY_POLICY',
          reconciliationStatus: 'CLOSED',
        };
      }

      const fundingOutcome = this.resolveFundingOutcome(billing);
      committedFundingOutcome = fundingOutcome;
      if (fundingOutcome === 'DEBT_OPEN') {
        const revision = await this.recordDebtOpen(
          root,
          requestId,
          received.revision,
          input,
          billing,
          stringValue(billing.reason) === 'insufficient_credits'
            ? 'insufficient_credits'
            : 'insufficient_balance',
          opts.actorId,
          received.existingStatus === 'RETRYABLE_FAILED',
          opts.reconciliationAction,
          opts.settlementReconcilesEvidence === true,
          providerEvidenceVerdict,
          providerReconciliationStatus,
        );
        financialTerminalCommitted = true;
        await this.ensureDebtRestriction(requestId, true);
        return {
          action: 'debt_open',
          requestId,
          billing,
          mapped: toMapped(input),
          revision,
          evidenceVerdict: providerEvidenceVerdict,
          reconciliationStatus: providerReconciliationStatus,
          fundingOutcome,
        };
      }
      // provisional exposure 的写入决策由这里构造（writer 读不到 opts.force）。
      //
      // force 走强制对账/技术重试，所选证据可能是 rev2+，而本期记账建立在「首收证据」之上；
      // 宁可少记，也不能破坏既有对账 ⇒ force 一律 forced_skip。
      const provisionalExposureDecision: ProvisionalExposureDecision | undefined =
        customerSettlementReason === PROVISIONAL_EXPOSURE_TARGET_REASON
          ? (opts.force
              ? { kind: 'forced_skip' }
              : (received.originalEvidenceObservation.kind
                  === 'legacy_original_evidence_missing'
                  ? {
                      kind: 'legacy_original_evidence_missing',
                      gatewayBillingEventId: received.gatewayBillingEventId,
                      evidenceHash: received.originalEvidenceHash,
                    }
                  : {
                      kind: 'write',
                      gatewayBillingEventId: received.gatewayBillingEventId,
                      evidenceHash: received.originalEvidenceHash,
                      originalEvidenceObservedAt:
                        received.originalEvidenceObservation.observedAt,
                    }))
          : undefined;
      // 边界在**事务外**解析（见 RecordFinalStateOptions.provisionalExposureBoundary 的注释）。
      // 只在目标 reason 上解析 ⇒ 非目标事件一次库都不读。
      const provisionalExposureBoundary = provisionalExposureDecision
        ? ((await this.provisionalExposureConfig?.getBoundary()) ?? null)
        : undefined;

      const revision = await this.recordFinalState(root, requestId, received.revision, 'DEDUCTED', {
        input,
        reason: customerSettlementReason ?? undefined,
        provisionalExposureDecision,
        provisionalExposureBoundary,
        billing,
        evidenceVerdict: providerEvidenceVerdict,
        reconciliationStatus: providerReconciliationStatus,
        fundingOutcome,
        actorId: opts.actorId,
        releaseRetryRestriction: received.existingStatus === 'RETRYABLE_FAILED',
        reconciliationAction: opts.reconciliationAction,
        releaseReconciliationRestrictions: opts.settlementReconcilesEvidence === true,
      });
      financialTerminalCommitted = true;
      if (
        fundingReservation
        || received.existingStatus === 'RETRYABLE_FAILED'
      ) {
        // Every BALANCE first receipt creates pending_usage_unreserved before
        // the wallet transaction begins. The reservation transaction replaces
        // that provisional guard atomically with the durable reservation and
        // immutable grant slices; this terminal transaction then consumes or
        // releases that funding fact and repairs any legacy guard left by an
        // older writer. Require a fresh projection before acknowledging the
        // event so Gateway observes the final account capacity.
        // Publisher allocates the revision before reading current state; this
        // newer terminal snapshot therefore cannot be overwritten by an older
        // provisional-hold snapshot. Do not key this on firstReceiptCreated:
        // a crash replay reuses its durable reservation while settling an
        // existing RECEIVED row whose guard may still be active.
        //
        // CREDITS first receipts do not create this guard. Their ordinary
        // success avoids account-wide fanout, while RETRYABLE_FAILED keeps the
        // existing required sync that releases settlement_retry_pending.
        await this.syncEventRestriction(requestId, true);
      }
      const result: GatewayRequestEventBillingResult = {
        action: 'deducted',
        requestId,
        reason: customerSettlementReason ?? undefined,
        billing,
        mapped: toMapped(input),
        revision,
        evidenceVerdict: providerEvidenceVerdict,
        reconciliationStatus: providerReconciliationStatus,
        fundingOutcome,
      };
      await this.recordFirstSuccessfulApiCall(root, result);
      return result;
    } catch (err) {
      if (err instanceof GatewayBillingRevisionConflictError) throw err;
      // ⚠️ 必须在 financialTerminalCommitted 快速抛出**之前**：provisional exposure 的
      // 不变量破坏恰恰多发于「资金已落地、写敞口时才发现矛盾」，落到快速抛出就会变成
      // 普通 transient 而被无限重试。
      if (err instanceof GatewayProvisionalExposureInvariantError) {
        throw await this.settleProvisionalExposureInvariant(err, {
          root,
          requestId,
          received,
          deductInput,
          hasFinancialReceipt: financialTerminalCommitted,
          committedBilling,
          committedFundingOutcome,
          actorId: opts.actorId,
          reconciliationAction: opts.reconciliationAction,
        });
      }
      // A financial transaction and terminal parent transition may have
      // committed immediately before a required Publisher projection failed.
      // Never rewrite that durable result as RETRYABLE_FAILED; command replay
      // and the projection outbox are the repair paths.
      if (financialTerminalCommitted) throw err;
      const surfacedError = err instanceof RetryableGatewayBillingError
        && err.originalError !== undefined
        ? err.originalError
        : err;
      const errorMessage = surfacedError instanceof Error
        ? surfacedError.message
        : String(surfacedError);
      if (
        err instanceof GatewaySettlementAnchorConflictError ||
        err instanceof ConflictException
      ) {
        const revision = await this.recordFinalState(
          root,
          requestId,
          received.revision,
          'QUARANTINED',
          {
            input: deductInput,
            reason: 'settlement_anchor_conflict',
            errorMessage,
            evidenceVerdict: 'CONFLICTED',
            reconciliationStatus: 'MANUAL_REVIEW',
            restrictionReason: 'settlement_policy_review',
            releaseRetryRestriction: received.existingStatus === 'RETRYABLE_FAILED',
            actorId: opts.actorId,
            reconciliationAction: opts.reconciliationAction,
          },
        );
        await this.syncEventRestriction(requestId, true);
        return {
          action: 'quarantined',
          requestId,
          reason: 'settlement_anchor_conflict',
          errorMessage,
          revision,
          evidenceVerdict: 'CONFLICTED',
          reconciliationStatus: 'MANUAL_REVIEW',
        };
      }
      if (this.isTerminalProcessingError(err)) {
        const labels = this.eventLabels(root);
        const apiKeyId = this.resolveApiKeyId(root, labels);
        if (apiKeyId) {
          const revision = await this.recordFinalState(
            root,
            requestId,
            received.revision,
            'QUARANTINED',
            {
              reason: 'invalid_event_contract',
              errorMessage,
              evidenceVerdict: 'INCOMPLETE',
              reconciliationStatus: 'MANUAL_REVIEW',
              restrictionReason: 'settlement_policy_review',
              reconciliationAction: opts.reconciliationAction,
            },
          );
          await this.syncEventRestriction(requestId, true);
          return {
            action: 'quarantined',
            requestId,
            reason: 'invalid_event_contract',
            errorMessage,
            revision,
            evidenceVerdict: 'INCOMPLETE',
            reconciliationStatus: 'MANUAL_REVIEW',
          };
        }
        await this.recordFinalState(root, requestId, received.revision, 'FAILED', {
          reason: 'invalid_event_contract',
          errorMessage,
          reconciliationStatus: 'MANUAL_REVIEW',
          reconciliationAction: opts.reconciliationAction,
        });
        return {
          action: 'failed',
          requestId,
          reason: 'invalid_event_contract',
          errorMessage,
          reconciliationStatus: 'MANUAL_REVIEW',
        };
      }

      const retryableReason = err instanceof RetryableGatewayBillingError
        ? err.reason
        : err instanceof GatewayFundingReservationQueuePendingError
          ? 'funding_reservation_queue_pending'
        : err instanceof ModelAccessDeniedError || err instanceof BadRequestException || err instanceof NotFoundException
          ? 'billing_configuration_pending'
          : 'processing_error';
      const fundingQueuePending = retryableReason === 'funding_reservation_queue_pending';
      const pendingFundingState = this.pendingBalanceFundingState(
        received.settlementAnchor,
      );
      const requiresRetryRestriction = !fundingQueuePending
        && Boolean(deductInput || pendingFundingState);
      try {
        await this.recordFinalState(root, requestId, received.revision, 'RETRYABLE_FAILED', {
          input: deductInput,
          reason: retryableReason,
          errorMessage,
          evidenceVerdict: 'SETTLEABLE_BY_POLICY',
          reconciliationStatus: 'RETRY_WAIT',
          // Preserve/rebuild the immutable first-receipt funding state across
          // every BALANCE retry. Non-queue failures are made hard by the
          // explicit retry restriction below; a healthy FIFO wait keeps the
          // same exact provisional hold without turning it into billing_review.
          pendingFundingState,
          restrictionReason: requiresRetryRestriction
            ? 'settlement_retry_pending'
            : undefined,
          // A recovered retry may next wait behind an earlier immutable
          // receipt. Remove this event's old hard retry restriction in the
          // same transaction that records the healthy queue state.
          releaseRetryRestriction: fundingQueuePending,
          reconciliationAction: opts.reconciliationAction,
        });
      } catch (recordErr) {
        const recordMessage = recordErr instanceof Error ? recordErr.message : String(recordErr);
        this.logger.warn(
          `failed to persist gateway billing retryable failure state requestId=${requestId}: ${recordMessage}`,
        );
        throw recordErr;
      }
      if (requiresRetryRestriction || fundingQueuePending) {
        await this.syncEventRestriction(requestId, true);
      }
      throw err;
    }
  }

  private recordFirstSuccessfulApiCall(
    event: JsonObject,
    result: GatewayRequestEventBillingResult,
  ): Promise<void> {
    return timed('growthFirstApiCall', () =>
      this.recordFirstSuccessfulApiCallInner(event, result),
    );
  }

  private async recordFirstSuccessfulApiCallInner(
    event: JsonObject,
    result: GatewayRequestEventBillingResult,
  ): Promise<void> {
    if (!this.growthEvents || result.action !== 'deducted') return;
    try {
      await this.growthEvents.recordFirstApiCall({
        requestId: result.requestId,
        userId: result.mapped?.userId,
        apiKeyId: result.mapped?.apiKeyId,
        modelName: result.mapped?.modelName,
        inputTokens: result.mapped?.inputTokens,
        outputTokens: result.mapped?.outputTokens,
        totalTokens: result.mapped?.totalTokens,
        occurredAt: this.resolveEventOccurredAt(event) ?? null,
        successful: stringValue(event.status) === 'success',
      });
    } catch (err) {
      this.logger.warn(
        `first_api_call growth event failed requestId=${result.requestId}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  async listEvents(query: {
    page?: string | number;
    pageSize?: string | number;
    status?: string;
    requestId?: string;
    apiKeyId?: string;
    tenantId?: string;
    userId?: string;
    productId?: string;
    modelName?: string;
    evidenceVerdict?: string;
    reconciliationStatus?: string;
    fundingOutcome?: string;
  }) {
    const page = Math.max(1, parseInt(String(query.page ?? '1'), 10) || 1);
    const pageSize = Math.min(
      100,
      Math.max(1, parseInt(String(query.pageSize ?? '20'), 10) || 20),
    );
    const where: Prisma.GatewayBillingEventWhereInput = {
      ...(query.status ? { status: query.status } : {}),
      ...(query.requestId ? { requestId: { contains: query.requestId } } : {}),
      ...(query.apiKeyId ? { apiKeyId: query.apiKeyId } : {}),
      ...(query.tenantId ? { tenantId: query.tenantId } : {}),
      ...(query.userId ? { userId: query.userId } : {}),
      ...(query.productId ? { productId: query.productId } : {}),
      ...(query.modelName ? { modelName: { contains: query.modelName } } : {}),
      ...(query.evidenceVerdict ? { evidenceVerdict: query.evidenceVerdict } : {}),
      ...(query.reconciliationStatus ? { reconciliationStatus: query.reconciliationStatus } : {}),
      ...(query.fundingOutcome ? { fundingOutcome: query.fundingOutcome } : {}),
    };
    const [items, total] = await Promise.all([
      this.prisma.gatewayBillingEvent.findMany({
        where,
        orderBy: { createdAt: 'desc' },
        skip: (page - 1) * pageSize,
        take: pageSize,
      }),
      this.prisma.gatewayBillingEvent.count({ where }),
    ]);
    return {
      items: items.map((item) => this.toAdminEvent(item)),
      total,
      page,
      pageSize,
    };
  }

  async getEvent(requestId: string) {
    const event = await this.prisma.gatewayBillingEvent.findUnique({
      where: { requestId },
      include: {
        settlementAnchor: true,
        fundingReservation: true,
        tokenUsage: {
          include: {
            consumptionAllocations: {
              orderBy: [{ ledgerSequence: 'asc' }, { id: 'asc' }],
              include: {
                settlements: { orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }] },
              },
            },
          },
        },
        usageEvidences: { orderBy: { createdAt: 'asc' } },
        reconciliationActions: { orderBy: { createdAt: 'asc' } },
        settlementReceipts: { orderBy: { createdAt: 'asc' } },
        platformLossEntries: { orderBy: { createdAt: 'asc' } },
        accessRestrictions: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!event) throw new NotFoundException('Gateway billing event 不存在');
    return {
      ...this.toAdminEvent(event),
      settlementAnchor: event.settlementAnchor
        ? {
            ...event.settlementAnchor,
            firstReceiptSequence:
              event.settlementAnchor.firstReceiptSequence?.toString() ?? null,
          }
        : null,
      fundingReservation: event.fundingReservation
        ? {
            ...event.fundingReservation,
            reservationSequence: event.fundingReservation.reservationSequence.toString(),
            reservedAmountUsd: event.fundingReservation.reservedAmountUsd.toString(),
            collectedUsd: event.fundingReservation.collectedUsd.toString(),
            approvedCreditUsd: event.fundingReservation.approvedCreditUsd.toString(),
            unapprovedDebtUsd: event.fundingReservation.unapprovedDebtUsd.toString(),
            creditLimitUsd: event.fundingReservation.creditLimitUsd.toString(),
            authoritativeAmountUsd:
              event.fundingReservation.authoritativeAmountUsd?.toString() ?? null,
          }
        : null,
      tokenUsage: event.tokenUsage
        ? {
            ...event.tokenUsage,
            customerChargeAmount: event.tokenUsage.customerChargeUsd.toString(),
            customerCollectedAmount:
              event.tokenUsage.customerCollectedUsd?.toString() ?? '0',
            customerApprovedReceivableAmount:
              event.tokenUsage.customerApprovedReceivableUsd?.toString() ?? '0',
            customerUnapprovedDebtAmount:
              event.tokenUsage.customerUnapprovedDebtUsd?.toString() ?? '0',
            consumptionAllocations: (event.tokenUsage.consumptionAllocations ?? []).map(
              (allocation) => ({
                ...allocation,
                ledgerSequence: allocation.ledgerSequence?.toString() ?? null,
                amount: allocation.amountUsd.toString(),
                approvedCreditAmount: allocation.approvedCreditUsd.toString(),
                unapprovedDebtAmount: allocation.unapprovedDebtUsd.toString(),
                settledAmount: allocation.settledUsd.toString(),
                settlements: allocation.settlements.map((settlement) => ({
                  ...settlement,
                  amount: settlement.amountUsd.toString(),
                  paidAmount: settlement.paidUsd.toString(),
                  bonusAmount: settlement.bonusUsd.toString(),
                })),
              }),
            ),
          }
        : null,
      evidence: event.usageEvidences,
      usageEvidences: event.usageEvidences,
      reconciliationActions: event.reconciliationActions,
      settlementReceipts: event.settlementReceipts.map((receipt) => ({
        ...receipt,
        amountUsd: receipt.amountUsd.toString(),
      })),
      platformLossEntries: event.platformLossEntries.map((entry) => ({
        ...entry,
        customerChargeBeforeUsd: entry.customerChargeBeforeUsd.toString(),
        customerChargeCorrectedUsd: entry.customerChargeCorrectedUsd.toString(),
        absorbedCustomerChargeUsd: entry.absorbedCustomerChargeUsd.toString(),
        customerDeductionUsd: entry.customerDeductionUsd.toString(),
        providerCostBeforeUsd: entry.providerCostBeforeUsd.toString(),
        providerCostCorrectedUsd: entry.providerCostCorrectedUsd.toString(),
        providerCostDeltaUsd: entry.providerCostDeltaUsd.toString(),
        platformLossUsd: entry.platformLossUsd.toString(),
      })),
      accessRestrictions: event.accessRestrictions,
    };
  }

  private toAdminEvent<T extends {
    pendingExposureUsd: Prisma.Decimal;
    pendingHoldUsd: Prisma.Decimal;
  }>(event: T) {
    return {
      ...event,
      pendingExposureAmount: event.pendingExposureUsd.toString(),
      pendingHoldAmount: event.pendingHoldUsd.toString(),
    };
  }

  async retryEvent(
    requestId: string,
    command: GatewayReconciliationCommand,
  ): Promise<GatewayRequestEventBillingResult> {
    this.validateReconciliationCommand(command);
    command = this.canonicalReconciliationCommand(command);
    const replay = await this.findActionReplay(requestId, 'TECHNICAL_RETRY', command);
    if (replay) {
      // The state/action transaction may have committed immediately before a
      // process crash or Publisher outage. An idempotent command replay is a
      // required repair path for the externally projected restriction state.
      await this.syncEventRestriction(requestId, true);
      return this.resultFromStoredEvent(replay);
    }
    const event = await this.getEvent(requestId);
    if (
      event.status !== 'RETRYABLE_FAILED' ||
      event.reconciliationStatus !== 'RETRY_WAIT'
    ) {
      throw new ConflictException('仅 RETRY_WAIT 技术故障允许重试，待核验事件不得强制结算');
    }
    if (event.revision !== command.expectedRevision) {
      throw new ConflictException('Gateway billing event revision 已变化，请刷新后重试');
    }
    const result = await this.process(this.technicalRetryEvidence(event), {
      force: true,
      expectedRevision: command.expectedRevision,
      actorId: command.actorId.trim(),
      reconciliationAction: {
        action: 'TECHNICAL_RETRY',
        command,
      },
    });
    gatewayUsageReconciliationActionTotal.inc({ action: 'technical_retry', outcome: 'applied' });
    return result;
  }

  /**
   * A reconciliation attempt can fail after authoritative evidence has been
   * selected but before settlement completes. Technical retry must continue
   * from that immutable evidence row; falling back to the first (often
   * estimated) receipt would silently undo the reconciliation decision.
   */
  private technicalRetryEvidence(event: {
    rawEvent: Prisma.JsonValue;
    usageEvidences: Array<{
      id: string;
      source: string;
      evidenceHash: string;
      rawEvidence: Prisma.JsonValue;
    }>;
    reconciliationActions: Array<{
      action: string;
      metadata: Prisma.JsonValue | null;
    }>;
  }): JsonObject {
    const reconciliation = [...event.reconciliationActions]
      .reverse()
      .find((action) => action.action === 'RECONCILE_SETTLE');
    if (!reconciliation) {
      return asObject(event.rawEvent, 'stored Gateway UsageEvent');
    }
    const metadata = isJsonObject(reconciliation.metadata)
      ? reconciliation.metadata
      : {};
    const selectedEvidenceId = stringValue(metadata.selectedEvidenceId);
    const expectedEvidenceHash = stringValue(metadata.evidenceHash);
    if (!selectedEvidenceId || !expectedEvidenceHash) {
      throw new ConflictException('对账操作缺少所选权威证据绑定，已停止技术重试');
    }
    const selected = event.usageEvidences.find(
      (evidence) => evidence.id === selectedEvidenceId,
    );
    if (
      !selected ||
      selected.source !== 'GATEWAY_USAGE_EVENT' ||
      selected.evidenceHash !== expectedEvidenceHash ||
      canonicalSha256(selected.rawEvidence) !== expectedEvidenceHash
    ) {
      throw new ConflictException('对账操作绑定的权威证据不存在或哈希不一致');
    }
    return asObject(selected.rawEvidence, 'stored authoritative UsageEvent');
  }

  private async approvedFundingReservationOverrideAction(
    gatewayBillingEventId: string,
    requestId: string,
    evidenceHash: string,
  ): Promise<string | null> {
    const actions = await this.prisma.gatewayUsageReconciliationAction.findMany({
      where: {
        gatewayBillingEventId,
        requestId,
        action: 'RECONCILE_SETTLE',
        actorId: { not: null },
      },
      orderBy: [{ createdAt: 'desc' }, { id: 'desc' }],
      take: 10,
    });
    for (const action of actions) {
      const metadata = isJsonObject(action.metadata) ? action.metadata : {};
      const selectedEvidenceId = stringValue(metadata.selectedEvidenceId);
      const selectedEvidenceHash = stringValue(metadata.evidenceHash);
      if (
        !action.actorId?.trim()
        || !action.reason.trim()
        || !selectedEvidenceId
        || selectedEvidenceHash !== evidenceHash
      ) {
        continue;
      }
      const selected = await this.prisma.gatewayUsageEvidence.findUnique({
        where: { id: selectedEvidenceId },
        select: {
          id: true,
          gatewayBillingEventId: true,
          requestId: true,
          source: true,
          evidenceHash: true,
          rawEvidence: true,
        },
      });
      if (
        selected
        && selected.gatewayBillingEventId === gatewayBillingEventId
        && selected.requestId === requestId
        && selected.source === 'GATEWAY_USAGE_EVENT'
        && selected.evidenceHash === evidenceHash
        && canonicalSha256(selected.rawEvidence) === evidenceHash
      ) {
        return action.id;
      }
    }
    return null;
  }

  async reconcileAndSettle(
    requestId: string,
    evidenceId: string,
    command: GatewayReconciliationCommand,
  ): Promise<GatewayRequestEventBillingResult> {
    this.validateReconciliationCommand(command);
    command = this.canonicalReconciliationCommand(command);
    const selectedEvidenceId = requiredString(evidenceId, 'evidenceId');
    const selectedEvidence = await this.prisma.gatewayUsageEvidence.findUnique({
      where: { id: selectedEvidenceId },
    });
    if (!selectedEvidence || selectedEvidence.requestId !== requestId) {
      throw new NotFoundException('所选权威证据不存在或不属于该请求');
    }
    if (selectedEvidence.source !== 'GATEWAY_USAGE_EVENT') {
      throw new BadRequestException('当前仅允许选择已通过签名 Kafka 消费链落库的 Gateway 证据');
    }
    if (canonicalSha256(selectedEvidence.rawEvidence) !== selectedEvidence.evidenceHash) {
      throw new ConflictException('所选权威证据内容与不可变哈希不一致');
    }
    const root = asObject(selectedEvidence.rawEvidence, 'stored authoritative UsageEvent');
    const existingAction = await this.prisma.gatewayUsageReconciliationAction.findUnique({
      where: { idempotencyKey: command.idempotencyKey },
    });
    if (existingAction) {
      const metadata = isJsonObject(existingAction.metadata) ? existingAction.metadata : {};
      if (
        existingAction.requestId !== requestId ||
        existingAction.action !== 'RECONCILE_SETTLE' ||
        existingAction.reason !== command.reason ||
        existingAction.expectedRevision !== command.expectedRevision ||
        (existingAction.actorId ?? '') !== command.actorId ||
        stringValue(metadata.selectedEvidenceId) !== selectedEvidence.id ||
        stringValue(metadata.evidenceHash) !== selectedEvidence.evidenceHash
      ) {
        throw new ConflictException('idempotencyKey 已用于另一项对账操作或其他证据');
      }
      const replay = await this.getEvent(requestId);
      if (replay.status !== 'PROCESSING' || replay.reconciliationStatus !== 'PROCESSING') {
        await this.refreshPendingAccessRestriction(
          requestId,
          replay.billingAccountId ?? undefined,
        );
        await this.syncEventRestriction(requestId, true);
        return this.resultFromStoredEvent(replay);
      }
      return this.resumeReconciliationSettlement(
        requestId,
        root,
        replay.revision,
        command.actorId,
        replay.billingAccountId ?? undefined,
      );
    }

    const classification = this.classifyEvent(root);
    if (!classification.billable) {
      throw new BadRequestException(`权威证据不可结算: ${classification.reason}`);
    }
    // Historical evidence uses the same customer-protective assessment as
    // live traffic. Invalid or untrusted usage becomes a whole-request zero
    // settlement; immutable anchor/funding/ledger proofs remain the hard gate.

    const event = await this.getEvent(requestId);
    if (
      event.status !== 'QUARANTINED' ||
      !['OPEN', 'MANUAL_REVIEW'].includes(event.reconciliationStatus)
    ) {
      throw new ConflictException('仅待核验用量可以选择权威证据并结算');
    }
    if (event.revision !== command.expectedRevision) {
      throw new ConflictException('Gateway billing event revision 已变化，请刷新后重试');
    }
    if (selectedEvidence.gatewayBillingEventId !== event.id) {
      throw new BadRequestException('所选权威证据与待对账事件不一致');
    }
    this.assertReconciliationEvidenceSelectionMatchesOriginal(
      event.rawEvent,
      event.evidenceHash,
      selectedEvidence.evidenceHash,
      root,
    );

    const processingRevision = await this.prisma.$transaction(async (tx) => {
      const changed = await tx.gatewayBillingEvent.updateMany({
        where: {
          id: event.id,
          revision: command.expectedRevision,
          status: 'QUARANTINED',
          reconciliationStatus: { in: ['OPEN', 'MANUAL_REVIEW'] },
        },
        data: {
          status: 'PROCESSING',
          reconciliationStatus: 'PROCESSING',
          reason: 'authoritative_evidence_selected',
          revision: { increment: 1 },
        },
      });
      if (changed.count !== 1) {
        throw new GatewayBillingRevisionConflictError('Gateway billing event 状态已变化');
      }
      const nextRevision = command.expectedRevision + 1;
      await tx.gatewayUsageReconciliationAction.create({
        data: {
          gatewayBillingEventId: event.id,
          requestId,
          action: 'RECONCILE_SETTLE',
          expectedRevision: command.expectedRevision,
          resultingRevision: nextRevision,
          reason: command.reason,
          actorId: command.actorId,
          idempotencyKey: command.idempotencyKey,
          metadata: {
            selectedEvidenceId: selectedEvidence.id,
            evidenceHash: selectedEvidence.evidenceHash,
            state: 'CLAIMED',
          },
        },
      });
      return nextRevision;
    });
    return this.resumeReconciliationSettlement(
      requestId,
      root,
      processingRevision,
      command.actorId,
      event.billingAccountId ?? undefined,
    );
  }

  private async resumeReconciliationSettlement(
    requestId: string,
    authoritativeEvidence: JsonObject,
    expectedRevision: number,
    actorId: string,
    billingAccountId?: string,
  ): Promise<GatewayRequestEventBillingResult> {
    const result = await this.process(authoritativeEvidence, {
      force: true,
      expectedRevision,
      actorId,
      settlementReconcilesEvidence: true,
    });
    const event = await this.prisma.gatewayBillingEvent.findUnique({
      where: { requestId },
      select: { billingAccountId: true, apiKeyId: true },
    });
    const accountId = event?.billingAccountId ?? billingAccountId;
    await this.refreshPendingAccessRestriction(requestId, accountId ?? undefined);
    await this.syncRestrictionTarget(
      accountId ?? undefined,
      event?.apiKeyId ?? undefined,
      true,
    );
    gatewayUsageReconciliationActionTotal.inc({
      action: 'reconcile_settle',
      outcome: result.action,
    });
    return result;
  }

  /**
   * The append-only evidence row matching the parent's original evidence hash
   * is the first immutable receipt itself. Missing provider account/upstream
   * audit fields cannot be required to prove that a payload is identical to
   * itself: the canonical hashes already provide that binding. A genuinely
   * different correction remains subject to the full same-call identity and
   * upstream-correlation checks below.
   */
  private assertReconciliationEvidenceSelectionMatchesOriginal(
    originalValue: Prisma.JsonValue,
    originalEvidenceHash: string | null,
    selectedEvidenceHash: string,
    authoritative: JsonObject,
  ): void {
    if (originalEvidenceHash && selectedEvidenceHash === originalEvidenceHash) {
      if (
        canonicalSha256(originalValue) !== originalEvidenceHash
        || canonicalSha256(authoritative) !== selectedEvidenceHash
      ) {
        throw new ConflictException(
          '首次收件证据内容与不可变 evidence hash 不一致',
        );
      }
      return;
    }
    this.assertReconciliationEvidenceMatchesOriginal(originalValue, authoritative);
  }

  /**
   * A stored signed event is authoritative for dimensions only after it is
   * proven to describe the same upstream call and frozen billing subject as
   * the first receipt. Any ambiguity is routed to manual review.
   */
  private assertReconciliationEvidenceMatchesOriginal(
    originalValue: Prisma.JsonValue,
    authoritative: JsonObject,
  ): void {
    const original = asObject(originalValue, 'original Gateway UsageEvent');
    const originalLabels = this.eventLabels(original);
    const authoritativeLabels = this.eventLabels(authoritative);
    const exactPairs: Array<[string, string | undefined, string | undefined]> = [
      ['request_id', stringValue(original.request_id), stringValue(authoritative.request_id)],
      [
        'api_key_id',
        this.resolveApiKeyId(original, originalLabels),
        this.resolveApiKeyId(authoritative, authoritativeLabels),
      ],
      ['model', this.resolveModelName(original), this.resolveModelName(authoritative)],
      ['provider', this.resolveProvider(original), this.resolveProvider(authoritative)],
      [
        'provider_credential_ref',
        stringValue(original.provider_credential_ref),
        stringValue(authoritative.provider_credential_ref),
      ],
      [
        'provider_account_ref',
        this.resolveProviderAccountRef(original),
        this.resolveProviderAccountRef(authoritative),
      ],
      [
        'region',
        this.resolveStableRegion(original, originalLabels),
        this.resolveStableRegion(authoritative, authoritativeLabels),
      ],
    ];
    for (const [field, first, selected] of exactPairs) {
      if (!first || !selected || first !== selected) {
        throw new BadRequestException(`权威证据 ${field} 与首次收件不一致`);
      }
    }

    const optionalIdentityPairs: Array<[string, string | undefined, string | undefined]> = [
      [
        'tenant_id',
        this.resolveTenantId(original, originalLabels),
        this.resolveTenantId(authoritative, authoritativeLabels),
      ],
      [
        'user_id',
        this.resolveUserId(original, originalLabels),
        this.resolveUserId(authoritative, authoritativeLabels),
      ],
      [
        'product_id',
        this.resolveProductId(originalLabels),
        this.resolveProductId(authoritativeLabels),
      ],
      [
        'product_slug',
        this.resolveProductSlug(originalLabels),
        this.resolveProductSlug(authoritativeLabels),
      ],
      ['call_type', this.resolveCallType(original), this.resolveCallType(authoritative)],
    ];
    for (const [field, first, selected] of optionalIdentityPairs) {
      if ((first || selected) && first !== selected) {
        throw new BadRequestException(`权威证据 ${field} 与首次收件不一致`);
      }
    }

    const originalOccurredAt = this.resolveEventOccurredAt(original, { required: true });
    const selectedOccurredAt = this.resolveEventOccurredAt(authoritative, { required: true });
    if (
      !originalOccurredAt ||
      !selectedOccurredAt ||
      originalOccurredAt.getTime() !== selectedOccurredAt.getTime()
    ) {
      throw new BadRequestException('权威证据 start_time 与首次收件不一致');
    }

    const originalRequestId = this.resolveUpstreamRequestId(original);
    const selectedRequestId = this.resolveUpstreamRequestId(authoritative);
    const originalResponseId = stringValue(original.upstream_response_id);
    const selectedResponseId = stringValue(authoritative.upstream_response_id);
    const sameRequest = Boolean(
      originalRequestId && selectedRequestId && originalRequestId === selectedRequestId,
    );
    const sameResponse = Boolean(
      originalResponseId && selectedResponseId && originalResponseId === selectedResponseId,
    );
    if (!sameRequest && !sameResponse) {
      throw new BadRequestException('权威证据无法与首次收件的 upstream correlation id 对应');
    }
  }

  async markManualReview(
    requestId: string,
    command: GatewayReconciliationCommand,
  ) {
    this.validateReconciliationCommand(command);
    command = this.canonicalReconciliationCommand(command);
    const replay = await this.findActionReplay(requestId, 'MANUAL_REVIEW', command);
    if (replay) return this.getEvent(requestId);

    const updated = await this.prisma.$transaction(async (tx) => {
      const event = await tx.gatewayBillingEvent.findUnique({ where: { requestId } });
      if (!event) throw new NotFoundException('Gateway billing event 不存在');
      if (event.revision !== command.expectedRevision) {
        throw new ConflictException('Gateway billing event revision 已变化，请刷新后重试');
      }
      // 2026-09-22:RETRYABLE_FAILED 一并放行 —— 冻结的 RETRY_WAIT 没有任何人工出口
      // (absorb 只收 QUARANTINED/MANUAL_REVIEW,重试又无驱动者,实测上海 UAT 冻 39 天),
      // 人工升级为待核验是重试冻死后的唯一受控出路;admin 权限 + revision CAS +
      // reconciliation action 审计兜底。QUARANTINED 保持原语义不变。
      if (event.status !== 'QUARANTINED' && event.status !== 'RETRYABLE_FAILED') {
        throw new ConflictException('仅待核验或冻结重试事件可以进入人工复核');
      }
      const nextRevision = event.revision + 1;
      const changed = await tx.gatewayBillingEvent.updateMany({
        where: {
          id: event.id,
          revision: event.revision,
          status: event.status,
        },
        data: {
          // RETRYABLE_FAILED 升级时一并置 QUARANTINED:absorb/reconcile-settle 的
          // 闸门都要求 status=QUARANTINED + MANUAL_REVIEW,只改 reconciliation_status
          // 会得到一个谁都收不了的中间态(2026-09-22 上海 UAT 实测)。
          // QUARANTINED 原路径 status 不变,行为零变化。
          status: event.status === 'RETRYABLE_FAILED' ? 'QUARANTINED' : event.status,
          reconciliationStatus: 'MANUAL_REVIEW',
          reason: command.reason,
          revision: { increment: 1 },
        },
      });
      if (changed.count !== 1) throw new GatewayBillingRevisionConflictError(
        'Gateway billing event 状态已变化',
      );
      await tx.gatewayUsageReconciliationAction.create({
        data: {
          gatewayBillingEventId: event.id,
          requestId,
          action: 'MANUAL_REVIEW',
          expectedRevision: event.revision,
          resultingRevision: nextRevision,
          reason: command.reason,
          actorId: command.actorId.trim(),
          idempotencyKey: command.idempotencyKey,
        },
      });
      return { ...event, revision: nextRevision };
    });
    gatewayUsageReconciliationActionTotal.inc({ action: 'manual_review', outcome: 'applied' });
    return this.getEvent(updated.requestId);
  }

  async absorb(
    requestId: string,
    command: GatewayAbsorbCommand,
  ) {
    this.validateReconciliationCommand(command);
    const protocol = command.protocol?.trim();
    if (command.protocol !== undefined) {
      if (protocol !== GATEWAY_UNANCHORED_ABSORB_PROTOCOL) {
        throw new BadRequestException('不支持的 Gateway absorb protocol');
      }
      const canonicalCommand = this.canonicalReconciliationCommand(command);
      return this.absorbRemediatedUnanchoredCurrencyMismatch(
        requestId,
        canonicalCommand,
        this.canonicalUnanchoredAbsorbRepairProof(command),
      );
    }
    command = this.canonicalReconciliationCommand(command);
    const replay = await this.findActionReplay(requestId, 'ABSORB', command);
    if (replay) {
      const replayAction = await this.prisma.gatewayUsageReconciliationAction.findUnique({
        where: { idempotencyKey: command.idempotencyKey },
        select: { metadata: true },
      });
      const replayMetadata = replayAction && isJsonObject(replayAction.metadata)
        ? replayAction.metadata
        : null;
      if (replayMetadata?.protocol !== 'gateway-absorb-v2') {
        throw new ConflictException('idempotencyKey 对应的 anchored absorb 协议不一致');
      }
      await this.usageBilling.releaseGatewayBalanceFunding(
        requestId,
        `financial_absorption:${command.idempotencyKey}`,
      );
      await this.releaseAbsorptionRestrictions(requestId, command.actorId);
      await this.syncEventRestriction(requestId, true);
      return this.getEvent(requestId);
    }

    const updated = await this.prisma.$transaction(async (tx) => {
      const event = await tx.gatewayBillingEvent.findUnique({ where: { requestId } });
      if (!event) throw new NotFoundException('Gateway billing event 不存在');
      const settlementAnchor = await tx.gatewayUsageSettlementAnchor.findUnique({
        where: { gatewayBillingEventId: event.id },
        select: {
          anchorHash: true,
          pricingHash: true,
          billingUnit: true,
          billingCurrency: true,
        },
      });
      const fundingReservation = await tx.gatewayUsageFundingReservation.findUnique({
        where: { gatewayBillingEventId: event.id },
        select: {
          id: true,
          gatewayBillingEventId: true,
          requestId: true,
          status: true,
          billingUnit: true,
          billingCurrency: true,
          reservedAmountUsd: true,
          anchorHash: true,
          reservationHash: true,
        },
      });
      if (event.revision !== command.expectedRevision) {
        throw new ConflictException('Gateway billing event revision 已变化，请刷新后重试');
      }
      if (event.status !== 'QUARANTINED' || event.reconciliationStatus !== 'MANUAL_REVIEW') {
        throw new ConflictException('仅 MANUAL_REVIEW 待核验事件可以由财务吸收');
      }
      if (
        !settlementAnchor
        || !fundingReservation
        || settlementAnchor.billingUnit !== 'BALANCE'
        || fundingReservation.billingUnit !== 'BALANCE'
        || !settlementAnchor.billingCurrency
        || fundingReservation.billingCurrency !== settlementAnchor.billingCurrency
        || fundingReservation.gatewayBillingEventId !== event.id
        || fundingReservation.requestId !== requestId
        || fundingReservation.anchorHash !== settlementAnchor.anchorHash
        || !fundingReservation.reservationHash
        || !['ACTIVE', 'MANUAL_REVIEW'].includes(fundingReservation.status)
      ) {
        throw new GatewaySettlementAnchorConflictError(
          'Gateway 财务吸收缺少完整不可变的 funding reservation/settlement anchor',
        );
      }
      if (!event.evidenceHash?.trim()) {
        throw new GatewaySettlementAnchorConflictError(
          'Gateway 财务吸收缺少不可变 evidence hash',
        );
      }
      const absorbedAmountUsd = new Prisma.Decimal(fundingReservation.reservedAmountUsd);
      if (absorbedAmountUsd.isNegative()) {
        throw new GatewaySettlementAnchorConflictError(
          'Gateway funding reservation 金额无效',
        );
      }
      const nextRevision = event.revision + 1;
      const actorId = command.actorId.trim();
      const approvedAbsorptionUsd = absorbedAmountUsd.toFixed(12);
      const absorptionProof = {
        protocol: 'gateway-absorb-v2',
        requestId,
        gatewayBillingEventId: event.id,
        fundingReservationId: fundingReservation.id,
        reservationHash: fundingReservation.reservationHash,
        expectedRevision: event.revision,
        resultingRevision: nextRevision,
        reason: command.reason,
        actorId,
        evidenceHash: event.evidenceHash,
        anchorHash: settlementAnchor.anchorHash,
        pricingHash: settlementAnchor.pricingHash,
        billingUnit: 'BALANCE',
        billingCurrency: settlementAnchor.billingCurrency,
        approvedAbsorptionUsd,
      };
      const settlementFingerprint = canonicalSha256({
        ...absorptionProof,
        fundingOutcome: 'ABSORBED',
        customerDeductionUsd: '0',
      });
      const changed = await tx.gatewayBillingEvent.updateMany({
        where: {
          id: event.id,
          revision: event.revision,
          status: 'QUARANTINED',
          reconciliationStatus: 'MANUAL_REVIEW',
        },
        data: {
          status: 'ABSORBED',
          reason: command.reason,
          reconciliationStatus: 'CLOSED',
          fundingOutcome: 'ABSORBED',
          pendingHoldUsd: new Prisma.Decimal(0),
          processedAt: new Date(),
          revision: { increment: 1 },
        },
      });
      if (changed.count !== 1) throw new GatewayBillingRevisionConflictError(
        'Gateway billing event 状态已变化',
      );
      await tx.gatewayUsageReconciliationAction.create({
        data: {
          gatewayBillingEventId: event.id,
          requestId,
          action: 'ABSORB',
          expectedRevision: event.revision,
          resultingRevision: nextRevision,
          reason: command.reason,
          actorId,
          idempotencyKey: command.idempotencyKey,
          metadata: {
            ...absorptionProof,
            settlementFingerprint,
          },
        },
      });
      await tx.gatewayUsageSettlementReceipt.create({
        data: {
          gatewayBillingEventId: event.id,
          requestId,
          settlementRevision: nextRevision,
          fundingOutcome: 'ABSORBED',
          evidenceHash: event.evidenceHash,
          anchorHash: settlementAnchor.anchorHash,
          pricingHash: settlementAnchor.pricingHash,
          settlementFingerprint,
          billingUnit: 'BALANCE',
          billingCurrency: settlementAnchor.billingCurrency,
          amountUsd: absorbedAmountUsd,
          reason: command.reason,
          policyVersion: 'manual-finance-v2',
          actorId,
          idempotencyKey: `receipt:${command.idempotencyKey}`,
          payload: {
            ...absorptionProof,
            fundingOutcome: 'ABSORBED',
            customerDeductionUsd: '0',
            settlementFingerprint,
          },
        },
      });
      return {
        ...event,
        apiKeyId: event.apiKeyId,
        billingAccountId: event.billingAccountId,
      };
    });
    await this.usageBilling.releaseGatewayBalanceFunding(
      requestId,
      `financial_absorption:${command.idempotencyKey}`,
    );
    await this.releaseAbsorptionRestrictions(requestId, command.actorId);
    await this.refreshPendingAccessRestriction(requestId, updated.billingAccountId ?? undefined);
    await this.syncRestrictionTarget(
      updated.billingAccountId ?? undefined,
      updated.apiKeyId ?? undefined,
    );
    gatewayUsageReconciliationActionTotal.inc({ action: 'absorb', outcome: 'applied' });
    return this.getEvent(requestId);
  }

  /**
   * Closes the narrow class of first-receipt failures created while the
   * account currency migration lagged the deployment currency. This is not a
   * financial settlement or a reconstruction of a historical anchor: it is a
   * zero-value, append-only closure that is available only after the current
   * key/account chain proves the migration has completed.
   */
  private async absorbRemediatedUnanchoredCurrencyMismatch(
    requestId: string,
    command: GatewayReconciliationCommand,
    repairProof: GatewayUnanchoredAbsorbRepairProof,
  ) {
    const replay = await this.findUnanchoredAbsorbReplay(requestId, command, repairProof);
    if (replay) {
      await this.repairUnanchoredAbsorbProjection(
        requestId,
        replay.apiKeyId,
        replay.billingAccountId,
        command.actorId,
      );
      return this.getEvent(requestId);
    }

    let updated: {
      requestId: string;
      apiKeyId: string;
      billingAccountId: string;
    };
    try {
      updated = await this.prisma.$transaction(async (tx) => {
        const locked = await tx.$queryRaw<Array<{ id: string }>>`
          SELECT "id"
          FROM "gateway_billing_events"
          WHERE "request_id" = ${requestId}
          FOR UPDATE
        `;
        if (locked.length !== 1 || !locked[0]?.id) {
          throw new NotFoundException('Gateway billing event 不存在');
        }
        const event = await tx.gatewayBillingEvent.findUniqueOrThrow({
        where: { requestId },
        include: {
          settlementAnchor: { select: { id: true } },
          fundingReservation: { select: { id: true } },
          tokenUsage: { select: { id: true } },
          settlementReceipts: { select: { id: true } },
          platformLossEntries: { select: { id: true } },
          usageLossRecognitionClaims: { select: { id: true } },
          historicalPlatformLossLines: { select: { id: true } },
        },
        });
        if (event.id !== locked[0].id) throw new GatewayBillingRevisionConflictError();

        const creditTransactionCount = await tx.creditTransaction.count({
          where: { requestId },
        });

      if (event.revision !== command.expectedRevision) {
        throw new ConflictException('Gateway billing event revision 已变化，请刷新后重试');
      }
      if (event.status !== 'QUARANTINED' || event.reconciliationStatus !== 'MANUAL_REVIEW') {
        throw new ConflictException('仅 MANUAL_REVIEW 待核验事件可以执行无锚币种吸收');
      }
      if (
        event.reason !== 'settlement_anchor_missing'
        || event.fundingOutcome !== null
        || event.billingAccountId !== null
        || event.billingUnit !== null
        || event.billingResult !== null
        || event.pricingSnapshot !== null
        || !new Prisma.Decimal(event.pendingExposureUsd).isZero()
        || !new Prisma.Decimal(event.pendingHoldUsd).isZero()
        || event.settlementAnchor !== null
        || event.fundingReservation !== null
        || event.tokenUsage !== null
        || event.settlementReceipts.length !== 0
        || event.platformLossEntries.length !== 0
        || event.usageLossRecognitionClaims.length !== 0
        || event.historicalPlatformLossLines.length !== 0
        || creditTransactionCount !== 0
      ) {
        throw new GatewaySettlementAnchorConflictError(
          'Gateway 无锚币种吸收要求首次收件后从未形成任何财务事实',
        );
      }

      const currencyFailure = /^Gateway billing currency mismatch: account=([A-Z]{3}) deployment=([A-Z]{3})$/
        .exec(event.errorMessage ?? '');
      if (!currencyFailure || currencyFailure[1] === currencyFailure[2]) {
        throw new GatewaySettlementAnchorConflictError(
          'Gateway 无锚吸收仅支持精确的首次收件币种不匹配事件',
        );
      }
      const originalAccountCurrency = currencyFailure[1];
      const originalDeploymentCurrency = currencyFailure[2];

      const rawEvent = isJsonObject(event.rawEvent) ? event.rawEvent : null;
      const evidenceHash = event.evidenceHash?.trim();
      if (
        !rawEvent
        || !evidenceHash
        || canonicalSha256(rawEvent) !== evidenceHash
        || stringValue(rawEvent.request_id) !== requestId
      ) {
        throw new GatewaySettlementAnchorConflictError(
          'Gateway 无锚币种吸收的首次收件 evidence hash 无法验证',
        );
      }
      const labels = this.eventLabels(rawEvent);
      const rawApiKeyId = this.resolveApiKeyId(rawEvent, labels);
      const rawTenantId = this.resolveTenantId(rawEvent, labels);
      if (
        !event.apiKeyId
        || !event.tenantId
        || rawApiKeyId !== event.apiKeyId
        || rawTenantId !== event.tenantId
      ) {
        throw new GatewaySettlementAnchorConflictError(
          'Gateway 无锚币种吸收的首次收件主体绑定不完整',
        );
      }
      const evidences = await tx.gatewayUsageEvidence.findMany({
        where: {
          gatewayBillingEventId: event.id,
          evidenceHash,
        },
        select: {
          id: true,
          gatewayBillingEventId: true,
          requestId: true,
          eventId: true,
          source: true,
          evidenceHash: true,
          evidenceRevision: true,
          rawEvidence: true,
        },
      });
      const evidence = evidences[0];
      if (
        evidences.length !== 1
        || !evidence
        || evidence.gatewayBillingEventId !== event.id
        || evidence.requestId !== requestId
        || evidence.eventId !== event.eventId
        || evidence.source !== 'GATEWAY_USAGE_EVENT'
        || evidence.evidenceHash !== evidenceHash
        || evidence.evidenceRevision !== 1
        || !isJsonObject(evidence.rawEvidence)
        || canonicalSha256(evidence.rawEvidence) !== evidenceHash
        || canonicalSha256(evidence.rawEvidence) !== canonicalSha256(rawEvent)
        || stringValue(evidence.rawEvidence.request_id) !== requestId
      ) {
        throw new GatewaySettlementAnchorConflictError(
          'Gateway 无锚币种吸收缺少唯一且完整的首次收件证据',
        );
      }

      const apiKey = await tx.apiKey.findUnique({
        where: { id: event.apiKeyId },
        select: {
          id: true,
          tenantId: true,
          deletedAt: true,
          tenant: {
            select: {
              id: true,
              billingAccountId: true,
              deletedAt: true,
              billingAccount: {
                select: { id: true, currency: true, deletedAt: true },
              },
            },
          },
        },
      });
      const account = apiKey?.tenant.billingAccount;
      const currentAccountCurrency = account?.currency.trim().toUpperCase();
      const deploymentConfig = await this.systemConfig?.getDeploymentConfig(tx);
      if (!this.systemConfig || !deploymentConfig) {
        throw new GatewaySettlementAnchorConflictError(
          'Gateway 无锚币种吸收无法读取当前 deploymentConfig',
        );
      }
      const currentDeploymentCurrency = resolvePlatformCurrency(
        this.config,
        deploymentConfig,
      ).currencyCode;
      if (
        !apiKey
        || apiKey.deletedAt
        || apiKey.tenantId !== event.tenantId
        || apiKey.tenant.id !== event.tenantId
        || apiKey.tenant.deletedAt
        || !apiKey.tenant.billingAccountId
        || !account
        || account.id !== apiKey.tenant.billingAccountId
        || account.deletedAt
        || !currentAccountCurrency
        || !/^[A-Z]{3}$/.test(currentAccountCurrency)
        || originalAccountCurrency === originalDeploymentCurrency
        || currentDeploymentCurrency !== originalDeploymentCurrency
        || currentAccountCurrency !== currentDeploymentCurrency
      ) {
        throw new GatewaySettlementAnchorConflictError(
          'Gateway 无锚币种吸收无法证明当前账户币种迁移已经完成',
        );
      }

      const repairRows = await tx.$queryRaw<Array<{
        runId: string;
        itemId: string;
        manifestHash: string;
        sourceCurrency: string;
        targetCurrency: string;
        runStatus: string;
        billingAccountId: string;
        beforeCurrency: string;
        afterCurrency: string;
        eligibleEventId: string;
        eligibleEventRowHash: string;
        eligibilityCode: string;
        failureReason: string;
        errorFingerprint: string;
        eligibleEvidenceId: string;
      }>>`
        SELECT
          repair_run."id" AS "runId",
          repair_item."id" AS "itemId",
          repair_run."manifest_hash" AS "manifestHash",
          repair_run."source_currency" AS "sourceCurrency",
          repair_run."target_currency" AS "targetCurrency",
          repair_run."status" AS "runStatus",
          repair_item."billing_account_id" AS "billingAccountId",
          repair_item."before_currency" AS "beforeCurrency",
          repair_item."after_currency" AS "afterCurrency",
          eligible_event."id" AS "eligibleEventId",
          eligible_event."row_hash" AS "eligibleEventRowHash",
          eligible_event."failure_code" AS "eligibilityCode",
          eligible_event."failure_reason" AS "failureReason",
          eligible_event."error_fingerprint" AS "errorFingerprint",
          eligible_event."evidence_id" AS "eligibleEvidenceId"
        FROM "billing_account_currency_label_repair_runs" AS repair_run
        JOIN "billing_account_currency_label_repair_items" AS repair_item
          ON repair_item."run_id" = repair_run."id"
        JOIN "billing_account_currency_label_repair_eligible_events" AS eligible_event
          ON eligible_event."run_id" = repair_run."id"
         AND eligible_event."item_id" = repair_item."id"
        JOIN "gateway_billing_events" AS eligible_gateway_event
          ON eligible_gateway_event."id" = eligible_event."gateway_billing_event_id"
        JOIN "gateway_usage_evidences" AS eligible_evidence
          ON eligible_evidence."id" = eligible_event."evidence_id"
         AND eligible_evidence."gateway_billing_event_id" = eligible_gateway_event."id"
        JOIN "api_keys" AS eligible_api_key
          ON eligible_api_key."id" = eligible_gateway_event."api_key_id"
        JOIN "tenants" AS eligible_tenant
          ON eligible_tenant."id" = eligible_api_key."tenant_id"
        WHERE repair_run."id" = ${repairProof.currencyRepairRunId}
          AND repair_item."id" = ${repairProof.currencyRepairItemId}
          AND eligible_event."gateway_billing_event_id" = ${event.id}
          AND eligible_event."request_id" = ${requestId}
          AND eligible_event."evidence_id" = ${evidence.id}
          AND eligible_event."evidence_hash" = ${evidenceHash}
          AND eligible_event."failure_code" =
            ${GATEWAY_UNANCHORED_CURRENCY_FAILURE_CODE}
          AND eligible_event."failure_reason" =
            ${GATEWAY_UNANCHORED_CURRENCY_FAILURE_REASON}
          AND eligible_event."error_message" = ${event.errorMessage}
          AND eligible_event."error_fingerprint" =
            ${GATEWAY_UNANCHORED_CURRENCY_ERROR_FINGERPRINT}
          AND eligible_event."event_snapshot" = jsonb_build_object(
            'event', to_jsonb(eligible_gateway_event)
              - 'raw_event'
              - 'billing_result'
              - 'subject_snapshot'
              - 'pricing_snapshot',
            'evidence', to_jsonb(eligible_evidence) - 'raw_evidence',
            'resolvedBillingAccountId', eligible_tenant."billing_account_id"
          )
          AND encode(sha256(convert_to(jsonb_build_object(
            'runId', repair_run."id",
            'billingAccountId', repair_item."billing_account_id",
            'gatewayBillingEventId', eligible_event."gateway_billing_event_id",
            'requestId', eligible_event."request_id",
            'evidenceId', eligible_event."evidence_id",
            'evidenceHash', eligible_event."evidence_hash",
            'failureCode', eligible_event."failure_code",
            'failureReason', eligible_event."failure_reason",
            'errorMessage', eligible_event."error_message",
            'errorFingerprint', eligible_event."error_fingerprint",
            'eventSnapshot', eligible_event."event_snapshot"
          )::TEXT, 'UTF8')), 'hex') = eligible_event."row_hash"
        FOR SHARE OF repair_run, repair_item, eligible_event
      `;
      const repair = repairRows[0];
      if (
        repairRows.length !== 1
        || !repair
        || repair.runId !== repairProof.currencyRepairRunId
        || repair.itemId !== repairProof.currencyRepairItemId
        || repair.manifestHash !== repairProof.manifestHash
        || repair.runStatus !== 'APPLIED'
        || repair.billingAccountId !== account.id
        || repair.sourceCurrency !== originalAccountCurrency
        || repair.targetCurrency !== originalDeploymentCurrency
        || repair.beforeCurrency !== originalAccountCurrency
        || repair.afterCurrency !== originalDeploymentCurrency
        || repair.eligibilityCode !== GATEWAY_UNANCHORED_CURRENCY_FAILURE_CODE
        || repair.failureReason !== GATEWAY_UNANCHORED_CURRENCY_FAILURE_REASON
        || repair.errorFingerprint !== GATEWAY_UNANCHORED_CURRENCY_ERROR_FINGERPRINT
        || repair.eligibleEvidenceId !== evidence.id
        || !/^[0-9a-f]{64}$/.test(repair.eligibleEventRowHash)
      ) {
        throw new GatewaySettlementAnchorConflictError(
          'Gateway 无锚币种吸收未绑定匹配的 APPLIED currency repair 证明',
        );
      }

      const nextRevision = event.revision + 1;
      const zeroAmountUsd = '0.000000000000';
      const proof = {
        protocol: GATEWAY_UNANCHORED_ABSORB_PROTOCOL,
        requestId,
        gatewayBillingEventId: event.id,
        expectedRevision: event.revision,
        resultingRevision: nextRevision,
        reason: command.reason,
        actorId: command.actorId,
        idempotencyKey: command.idempotencyKey,
        evidenceHash,
        evidenceRevision: evidence.evidenceRevision,
        failureReason: 'settlement_anchor_missing',
        failureMessage: event.errorMessage,
        originalAccountCurrency,
        originalDeploymentCurrency,
        currentApiKeyId: apiKey.id,
        currentTenantId: apiKey.tenant.id,
        currentBillingAccountId: account.id,
        currentAccountCurrency,
        currentDeploymentCurrency,
        currencyRepairRunId: repair.runId,
        currencyRepairItemId: repair.itemId,
        currencyRepairManifestHash: repair.manifestHash,
        currencyRepairEligibleEventId: repair.eligibleEventId,
        currencyRepairEligibleEventRowHash: repair.eligibleEventRowHash,
        currencyRepairEligibilityCode: repair.eligibilityCode,
        currencyRepairFailureReason: repair.failureReason,
        currencyRepairErrorFingerprint: repair.errorFingerprint,
        currencyRepairEvidenceId: repair.eligibleEvidenceId,
        anchorAbsent: true,
        fundingReservationAbsent: true,
        tokenUsageAbsent: true,
        priorSettlementReceiptAbsent: true,
        financialMutationAbsent: true,
        amountUsd: zeroAmountUsd,
        customerDeductionUsd: zeroAmountUsd,
      };
      const settlementFingerprint = unanchoredAbsorbCanonicalSha256({
        ...proof,
        fundingOutcome: 'ABSORBED',
      });
      const changed = await tx.gatewayBillingEvent.updateMany({
        where: {
          id: event.id,
          revision: event.revision,
          status: 'QUARANTINED',
          reconciliationStatus: 'MANUAL_REVIEW',
          fundingOutcome: null,
        },
        data: {
          status: 'ABSORBED',
          reason: command.reason,
          reconciliationStatus: 'CLOSED',
          fundingOutcome: 'ABSORBED',
          billingResult: Prisma.DbNull,
          pricingSnapshot: Prisma.DbNull,
          pendingExposureUsd: new Prisma.Decimal(0),
          pendingHoldUsd: new Prisma.Decimal(0),
          processedAt: new Date(),
          revision: { increment: 1 },
        },
      });
      if (changed.count !== 1) {
        throw new GatewayBillingRevisionConflictError('Gateway billing event 状态已变化');
      }
      await tx.gatewayUsageReconciliationAction.create({
        data: {
          gatewayBillingEventId: event.id,
          requestId,
          action: 'ABSORB',
          expectedRevision: event.revision,
          resultingRevision: nextRevision,
          reason: command.reason,
          actorId: command.actorId,
          idempotencyKey: command.idempotencyKey,
          metadata: {
            ...proof,
            settlementFingerprint,
          },
        },
      });
      await tx.gatewayUsageSettlementReceipt.create({
        data: {
          gatewayBillingEventId: event.id,
          requestId,
          settlementRevision: nextRevision,
          fundingOutcome: 'ABSORBED',
          evidenceHash,
          anchorHash: null,
          pricingHash: null,
          settlementFingerprint,
          billingUnit: null,
          billingCurrency: null,
          creditAmount: null,
          amountUsd: new Prisma.Decimal(0),
          tokenUsageId: null,
          reason: command.reason,
          policyVersion: GATEWAY_UNANCHORED_ABSORB_PROTOCOL,
          actorId: command.actorId,
          idempotencyKey: `receipt:${command.idempotencyKey}`,
          payload: {
            ...proof,
            fundingOutcome: 'ABSORBED',
            settlementFingerprint,
          },
        },
      });
      await tx.billingAccessRestriction.updateMany({
        where: {
          gatewayBillingEventId: event.id,
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
          releasedBy: command.actorId,
          releaseReason: 'financial_absorption_closed_reconciliation',
        },
      });
        return {
          requestId,
          apiKeyId: apiKey.id,
          billingAccountId: account.id,
        };
      });
    } catch (error) {
      // A same-command race can lose either the event CAS or the unique action
      // insert after the winning transaction commits. Only the complete,
      // protocol-specific permanent pair is accepted as replay; every partial
      // or cross-protocol collision remains a conflict.
      if (
        !(error instanceof GatewayBillingRevisionConflictError)
        && !hasPrismaCode(error, 'P2002')
      ) {
        throw error;
      }
      const concurrentReplay = await this.findUnanchoredAbsorbReplay(
        requestId,
        command,
        repairProof,
      );
      if (!concurrentReplay) throw error;
      await this.repairUnanchoredAbsorbProjection(
        requestId,
        concurrentReplay.apiKeyId,
        concurrentReplay.billingAccountId,
        command.actorId,
      );
      return this.getEvent(requestId);
    }

    await this.refreshPendingAccessRestriction(requestId, updated.billingAccountId);
    await this.syncUnanchoredAbsorbTargetRequired(updated.apiKeyId);
    gatewayUsageReconciliationActionTotal.inc({ action: 'absorb', outcome: 'applied' });
    return this.getEvent(requestId);
  }

  /**
   * Close an evidence conflict on a request that was already financially
   * settled. This action never calls a deduction path and never edits the
   * original TokenUsage or receipt. It appends a correction valuation, a zero
   * customer-deduction absorption receipt and a management loss fact.
   */
  async absorbTerminalDelta(
    requestId: string,
    evidenceId: string,
    command: GatewayReconciliationCommand,
  ) {
    this.validateReconciliationCommand(command);
    command = this.canonicalReconciliationCommand(command);
    const selectedEvidenceId = requiredString(evidenceId, 'evidenceId');
    const selectedEvidence = await this.prisma.gatewayUsageEvidence.findUnique({
      where: { id: selectedEvidenceId },
    });
    if (!selectedEvidence || selectedEvidence.requestId !== requestId) {
      throw new NotFoundException('所选权威证据不存在或不属于该请求');
    }
    if (
      selectedEvidence.source !== 'GATEWAY_USAGE_EVENT' ||
      canonicalSha256(selectedEvidence.rawEvidence) !== selectedEvidence.evidenceHash
    ) {
      throw new BadRequestException('仅允许使用已通过签名 Kafka 链落库的不可变权威证据');
    }

    const replayAction = await this.prisma.gatewayUsageReconciliationAction.findUnique({
      where: { idempotencyKey: command.idempotencyKey },
    });
    if (replayAction) {
      const metadata = isJsonObject(replayAction.metadata) ? replayAction.metadata : {};
      if (
        replayAction.requestId !== requestId ||
        replayAction.action !== 'PLATFORM_ABSORB_DELTA' ||
        replayAction.reason !== command.reason ||
        replayAction.expectedRevision !== command.expectedRevision ||
        (replayAction.actorId ?? '') !== command.actorId ||
        stringValue(metadata.selectedEvidenceId) !== selectedEvidence.id ||
        stringValue(metadata.evidenceHash) !== selectedEvidence.evidenceHash
      ) {
        throw new ConflictException('idempotencyKey 已用于另一项差额吸收操作');
      }
      const loss = await this.prisma.gatewayUsagePlatformLoss.findUnique({
        where: { reconciliationActionId: replayAction.id },
      });
      if (
        !loss ||
        loss.correctionEvidenceId !== selectedEvidence.id ||
        loss.correctionEvidenceHash !== selectedEvidence.evidenceHash ||
        !new Prisma.Decimal(loss.customerDeductionUsd).equals(0)
      ) {
        throw new ConflictException('差额吸收操作缺少完整的永久财务回执');
      }
      await this.syncEventRestriction(requestId, true);
      return this.getEvent(requestId);
    }

    const authoritative = asObject(
      selectedEvidence.rawEvidence,
      'stored authoritative UsageEvent',
    );
    const classification = this.classifyEvent(authoritative);
    if (!classification.billable) {
      throw new BadRequestException(`权威证据不可用于差额估值: ${classification.reason}`);
    }
    const quarantineReason = this.resolveEvidenceQuarantineReason(authoritative);
    if (quarantineReason) {
      throw new BadRequestException(`权威证据未通过完整性硬闸: ${quarantineReason}`);
    }

    const event = await this.prisma.gatewayBillingEvent.findUnique({
      where: { requestId },
      include: {
        settlementAnchor: true,
        tokenUsage: true,
        settlementReceipts: { orderBy: { createdAt: 'asc' } },
      },
    });
    if (!event) throw new NotFoundException('Gateway billing event 不存在');
    if (
      !['DEDUCTED', 'DEBT_OPEN'].includes(event.status) ||
      event.reconciliationStatus !== 'MANUAL_REVIEW' ||
      event.evidenceVerdict !== 'CONFLICTED'
    ) {
      throw new ConflictException('仅已结算且证据冲突的 MANUAL_REVIEW 请求可以吸收差额');
    }
    if (event.revision !== command.expectedRevision) {
      throw new ConflictException('Gateway billing event revision 已变化，请刷新后重试');
    }
    if (
      selectedEvidence.gatewayBillingEventId !== event.id ||
      selectedEvidence.evidenceHash === event.evidenceHash
    ) {
      throw new BadRequestException('所选证据不是该请求的独立修正证据');
    }
    if (!event.settlementAnchor || !event.tokenUsage) {
      throw new ConflictException('历史结算缺少冻结价格锚点或原始 TokenUsage，不能自动估值');
    }
    const originalTokenUsage = event.tokenUsage;
    this.assertReconciliationEvidenceMatchesOriginal(event.rawEvent, authoritative);
    const anchor = settlementAnchorFromRow(event.settlementAnchor);
    const originalReceipt = event.settlementReceipts.find((receipt) =>
      receipt.tokenUsageId === originalTokenUsage.id &&
      receipt.evidenceHash === event.evidenceHash &&
      receipt.anchorHash === anchor.anchorHash &&
      ['COLLECTED', 'RECEIVABLE', 'INCLUDED', 'DEBT_OPEN'].includes(receipt.fundingOutcome),
    );
    if (!originalReceipt) {
      throw new ConflictException('原始结算缺少与 TokenUsage/anchor 绑定的永久资金回执');
    }
    if (originalTokenUsage.providerCostEstimateUsd === null) {
      throw new ConflictException('原始结算缺少供应商成本，不能形成完整差额闭环');
    }

    const correctedInput = this.toAnchoredDeductInput(authoritative, requestId, anchor);
    const valuation = await this.usageBilling.valueGatewayUsageAtFrozenPricing(
      correctedInput,
      anchor,
    );
    if (valuation.providerCostUsd === null) {
      throw new ConflictException('冻结供应商价格不可用，不能形成完整差额闭环');
    }
    const customerChargeBeforeUsd = new Prisma.Decimal(originalTokenUsage.customerChargeUsd);
    const customerChargeCorrectedUsd = new Prisma.Decimal(valuation.customerChargeUsd);
    const absorbedCustomerChargeUsd = customerChargeCorrectedUsd
      .minus(customerChargeBeforeUsd)
      .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
    if (absorbedCustomerChargeUsd.lte(0)) {
      throw new BadRequestException('权威证据未形成正向客户少计差额，无需执行平台吸收');
    }
    const providerCostBeforeUsd = new Prisma.Decimal(
      originalTokenUsage.providerCostEstimateUsd,
    );
    const providerCostCorrectedUsd = new Prisma.Decimal(valuation.providerCostUsd);
    const providerCostDeltaUsd = providerCostCorrectedUsd
      .minus(providerCostBeforeUsd)
      .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
    const correctedCreditAmount = valuation.quote.unit === 'CREDITS'
      ? valuation.quote.creditCost
      : null;
    const originalCreditAmount = originalReceipt.creditAmount;
    const creditDelta = correctedCreditAmount === null
      ? null
      : correctedCreditAmount - (originalCreditAmount ?? 0);
    const originalEvidence = asObject(event.rawEvent, 'stored original UsageEvent');
    const originalLabels = this.eventLabels(originalEvidence);
    const provider = requiredString(
      this.resolveProvider(originalEvidence),
      'original provider',
    ).toLowerCase();
    if (provider === 'unknown-provider') {
      throw new BadRequestException('首次收件缺少稳定 provider，不能建立跨粒度损失 claim');
    }
    const providerAccountRef = requiredString(
      this.resolveProviderAccountRef(originalEvidence),
      'original providerAccountRef/providerCredentialRef',
    );
    const region = requiredString(
      this.resolveStableRegion(originalEvidence, originalLabels),
      'original region',
    ).toLowerCase();
    const coverageModel = requiredString(
      event.modelName ?? this.resolveModelName(originalEvidence),
      'original model',
    );
    const serviceDate = anchor.occurredAt.toISOString().slice(0, 10);
    const coverageClaims = changedUsageLossMeters(originalTokenUsage, correctedInput).map(
      (meter) => usageLossCoverageIdentity(
          provider,
          providerAccountRef,
          region,
          serviceDate,
          coverageModel,
          meter,
        ),
    );
    const valuationPolicyVersion = 'gateway-platform-loss-v1';
    const valuationFingerprint = canonicalSha256({
      requestId,
      originalReceiptId: originalReceipt.id,
      selectedEvidenceId: selectedEvidence.id,
      selectedEvidenceHash: selectedEvidence.evidenceHash,
      anchorHash: anchor.anchorHash,
      pricingHash: anchor.pricingHash,
      billingUnit: anchor.billingUnit,
      customerChargeBeforeUsd: customerChargeBeforeUsd.toString(),
      customerChargeCorrectedUsd: customerChargeCorrectedUsd.toString(),
      providerCostBeforeUsd: providerCostBeforeUsd.toString(),
      providerCostCorrectedUsd: providerCostCorrectedUsd.toString(),
      originalCreditAmount,
      correctedCreditAmount,
      coverageClaims,
      valuationPolicyVersion,
    });
    const actionId = randomUUID();
    const absorptionReceiptId = randomUUID();
    const platformLossId = randomUUID();
    const nextRevision = event.revision + 1;
    const recognizedUpstreamRequestId =
      event.upstreamRequestId ?? this.resolveUpstreamRequestId(originalEvidence);

    try {
      await this.prisma.$transaction(async (tx) => {
      await tx.$queryRaw`SELECT "id" FROM "gateway_billing_events" WHERE "id" = ${event.id} FOR UPDATE`;
      for (const coverage of coverageClaims) {
        await reserveUsageLossCoverage(tx, coverage, 'REQUEST');
      }
      const changed = await tx.gatewayBillingEvent.updateMany({
        where: {
          id: event.id,
          revision: event.revision,
          status: event.status,
          reconciliationStatus: 'MANUAL_REVIEW',
          evidenceVerdict: 'CONFLICTED',
        },
        data: {
          reason: command.reason,
          reconciliationStatus: 'CLOSED',
          evidenceVerdict: 'VERIFIED_PROVIDER_CORRECTION',
          revision: { increment: 1 },
        },
      });
      if (changed.count !== 1) {
        throw new GatewayBillingRevisionConflictError('Gateway billing event 状态已变化');
      }
      await tx.gatewayUsageReconciliationAction.create({
        data: {
          id: actionId,
          gatewayBillingEventId: event.id,
          requestId,
          action: 'PLATFORM_ABSORB_DELTA',
          expectedRevision: event.revision,
          resultingRevision: nextRevision,
          reason: command.reason,
          actorId: command.actorId,
          idempotencyKey: command.idempotencyKey,
          metadata: {
            selectedEvidenceId: selectedEvidence.id,
            evidenceHash: selectedEvidence.evidenceHash,
            originalSettlementReceiptId: originalReceipt.id,
            valuationFingerprint,
            coverageClaims,
            state: 'CLOSED',
          },
        },
      });
      await tx.gatewayUsageSettlementReceipt.create({
        data: {
          id: absorptionReceiptId,
          gatewayBillingEventId: event.id,
          requestId,
          settlementRevision: nextRevision,
          fundingOutcome: 'ABSORBED',
          evidenceHash: selectedEvidence.evidenceHash,
          anchorHash: anchor.anchorHash,
          pricingHash: anchor.pricingHash,
          settlementFingerprint: valuationFingerprint,
          billingUnit: anchor.billingUnit,
          billingCurrency: anchor.billingCurrency ?? undefined,
          ...(correctedCreditAmount !== null ? { creditAmount: correctedCreditAmount } : {}),
          amountUsd: absorbedCustomerChargeUsd,
          tokenUsageId: originalTokenUsage.id,
          reason: command.reason,
          policyVersion: valuationPolicyVersion,
          actorId: command.actorId,
          idempotencyKey: `receipt:${command.idempotencyKey}`,
          payload: {
            originalSettlementReceiptId: originalReceipt.id,
            correctionEvidenceId: selectedEvidence.id,
            customerDeductionUsd: '0',
            customerChargeBeforeUsd: customerChargeBeforeUsd.toString(),
            customerChargeCorrectedUsd: customerChargeCorrectedUsd.toString(),
            absorbedCustomerChargeUsd: absorbedCustomerChargeUsd.toString(),
            providerCostBeforeUsd: providerCostBeforeUsd.toString(),
            providerCostCorrectedUsd: providerCostCorrectedUsd.toString(),
            providerCostDeltaUsd: providerCostDeltaUsd.toString(),
            originalCreditAmount,
            correctedCreditAmount,
            creditDelta,
            coverageClaims,
            valuationFingerprint,
          },
        },
      });
      await tx.gatewayUsagePlatformLoss.create({
        data: {
          id: platformLossId,
          gatewayBillingEventId: event.id,
          requestId,
          reconciliationActionId: actionId,
          correctionEvidenceId: selectedEvidence.id,
          correctionEvidenceHash: selectedEvidence.evidenceHash,
          originalSettlementReceiptId: originalReceipt.id,
          absorptionSettlementReceiptId: absorptionReceiptId,
          billingUnit: anchor.billingUnit,
          customerChargeBeforeUsd,
          customerChargeCorrectedUsd,
          absorbedCustomerChargeUsd,
          customerDeductionUsd: new Prisma.Decimal(0),
          providerCostBeforeUsd,
          providerCostCorrectedUsd,
          providerCostDeltaUsd,
          platformLossUsd: absorbedCustomerChargeUsd,
          valuationPolicyVersion,
          reason: command.reason,
          actorId: command.actorId,
          idempotencyKey: `platform-loss:${command.idempotencyKey}`,
        },
      });
      await tx.usageLossRecognitionClaim.create({
        data: {
          recognitionKey: requestRecognitionKey(requestId),
          recognitionType: 'REQUEST_ID',
          claimSource: 'ABSORB_DELTA',
          gatewayBillingEventId: event.id,
          gatewayUsagePlatformLossId: platformLossId,
        },
      });
      if (recognizedUpstreamRequestId) {
        await tx.usageLossRecognitionClaim.create({
          data: {
            recognitionKey: upstreamRecognitionKey(
              provider,
              providerAccountRef,
              recognizedUpstreamRequestId,
            ),
            recognitionType: 'UPSTREAM_REQUEST_ID',
            claimSource: 'ABSORB_DELTA',
            gatewayBillingEventId: event.id,
            gatewayUsagePlatformLossId: platformLossId,
          },
        });
      }
      await tx.billingAccessRestriction.updateMany({
        where: {
          gatewayBillingEventId: event.id,
          status: 'ACTIVE',
          reason: { in: ['evidence_conflict', 'settlement_policy_review'] },
        },
        data: {
          status: 'RELEASED',
          releasedAt: new Date(),
          releasedBy: command.actorId,
          releaseReason: 'platform_absorbed_verified_usage_delta',
        },
      });
      });
    } catch (error) {
      if (error instanceof Prisma.PrismaClientKnownRequestError && error.code === 'P2002') {
        throw new ConflictException(
          '该 request/upstream request 已由历史批次或另一差额吸收操作确认',
        );
      }
      throw error;
    }
    await this.syncEventRestriction(requestId, true);
    gatewayUsageReconciliationActionTotal.inc({
      action: 'platform_absorb_delta',
      outcome: 'applied',
    });
    return this.getEvent(requestId);
  }

  private findCommittedResult(
    requestId: string,
  ): Promise<GatewayRequestEventBillingResult | null> {
    return timed('findCommittedResult', () =>
      this.findCommittedResultInner(requestId),
    );
  }

  private async findCommittedResultInner(
    requestId: string,
  ): Promise<GatewayRequestEventBillingResult | null> {
    const existing = await this.prisma.gatewayBillingEvent.findUnique({
      where: { requestId },
      select: {
        requestId: true,
        status: true,
        reason: true,
        errorMessage: true,
        billingResult: true,
        apiKeyId: true,
        tenantId: true,
        productId: true,
        productSlug: true,
        userId: true,
        modelName: true,
        inputTokens: true,
        outputTokens: true,
        cachedInputTokens: true,
        cacheWriteInputTokens: true,
        totalTokens: true,
        revision: true,
        evidenceVerdict: true,
        reconciliationStatus: true,
        fundingOutcome: true,
      },
    });
    if (!existing || !GATEWAY_EVENT_TERMINAL_STATUSES.has(existing.status)) {
      return null;
    }

    const mapped = {
      apiKeyId: existing.apiKeyId ?? undefined,
      tenantId: existing.tenantId ?? undefined,
      productId: existing.productId ?? undefined,
      productSlug: existing.productSlug ?? undefined,
      userId: existing.userId ?? undefined,
      modelName: existing.modelName ?? '',
      inputTokens: existing.inputTokens,
      outputTokens: existing.outputTokens,
      cachedInputTokens: existing.cachedInputTokens,
      cacheWriteInputTokens: existing.cacheWriteInputTokens,
      totalTokens: existing.totalTokens,
    };
    const billing = isJsonObject(existing.billingResult)
      ? existing.billingResult
      : undefined;

    if (existing.status === 'DEDUCTED') {
      return {
        action: 'deducted',
        requestId,
        billing,
        mapped,
        revision: existing.revision,
        evidenceVerdict: existing.evidenceVerdict,
        reconciliationStatus: existing.reconciliationStatus,
        fundingOutcome: existing.fundingOutcome ?? undefined,
      };
    }
    if (existing.status === 'SKIPPED') {
      return {
        action: 'skipped',
        requestId,
        reason: existing.reason ?? 'idempotent_replay',
        billing,
        mapped,
        revision: existing.revision,
        evidenceVerdict: existing.evidenceVerdict,
        reconciliationStatus: existing.reconciliationStatus,
        fundingOutcome: existing.fundingOutcome ?? undefined,
      };
    }
    if (existing.status === 'ABSORBED') {
      return {
        action: 'absorbed',
        requestId,
        reason: existing.reason ?? 'platform_absorbed',
        billing,
        mapped,
        revision: existing.revision,
        evidenceVerdict: existing.evidenceVerdict,
        reconciliationStatus: existing.reconciliationStatus,
        fundingOutcome: 'ABSORBED',
      };
    }
    if (existing.status === 'DEBT_OPEN') {
      return {
        action: 'debt_open',
        requestId,
        reason: existing.reason ?? 'insufficient_balance',
        billing,
        mapped,
        revision: existing.revision,
        evidenceVerdict: existing.evidenceVerdict,
        reconciliationStatus: existing.reconciliationStatus,
        fundingOutcome: 'DEBT_OPEN',
      };
    }
    return {
      action: 'failed',
      requestId,
      reason: existing.reason ?? 'idempotent_replay',
      errorMessage: existing.errorMessage ?? undefined,
      billing,
      mapped,
      revision: existing.revision,
      evidenceVerdict: existing.evidenceVerdict,
      reconciliationStatus: existing.reconciliationStatus,
      fundingOutcome: existing.fundingOutcome ?? undefined,
    };
  }

  private classifyEvent(event: JsonObject): GatewayEventClassification {
    const eventType = stringValue(event.event_type);
    if (!eventType) {
      return { billable: false, reason: 'event_type_missing', record: true };
    }

    if (eventType === 'usage') {
      const version = stringValue(event.version);
      if (version !== 'v2') {
        return {
          billable: false,
          reason: version ? 'unsupported_version' : 'version_missing',
          record: true,
        };
      }
      return { billable: true };
    }

    if (eventType === 'request_event') {
      return {
        billable: false,
        reason: 'unsupported_event_type:request_event',
        record: false,
      };
    }

    return {
      billable: false,
      reason: 'unsupported_event_type',
      record: true,
    };
  }

  /**
   * Identify normalized-usage uncertainty. These reasons do not authorize a
   * customer hold: the caller converts them to a zero customer-protective
   * floor while retaining the raw evidence for internal reconciliation.
   */
  private resolveSettlementUsageUncertaintyReason(event: JsonObject): string | null {
    const tokenSource = stringValue(event.token_source);
    if (tokenSource === 'estimated') return 'unsafe_estimated_usage';
    if (!tokenSource) return 'token_source_missing';
    if (!SETTLEABLE_USAGE_SOURCES.has(tokenSource)) return 'token_source_not_settleable';

    if (tokenSource === 'provider') {
      const promptTokens = strictNonNegativeInt(event.prompt_tokens);
      const completionTokens = strictNonNegativeInt(event.completion_tokens);
      const totalTokens = strictNonNegativeInt(event.total_tokens);
      const tokenExtras = optionalObject(event.token_extras);
      if (
        promptTokens === null || completionTokens === null || totalTokens === null ||
        Object.values(tokenExtras).some((value) => strictNonNegativeInt(value) === null)
      ) {
        return 'provider_usage_dimensions_invalid';
      }
      if (totalTokens !== promptTokens + completionTokens) {
        return 'provider_total_tokens_mismatch';
      }
      const normalizedTokens = this.extractTokens(event);
      const cacheReadTokens = normalizedTokens.cachedInputTokens;
      const cacheWriteTokens = normalizedTokens.cacheWriteInputTokens;
      if (cacheReadTokens + cacheWriteTokens > promptTokens) {
        return 'provider_cache_tokens_exceed_prompt';
      }
    }
    return null;
  }

  /**
   * Classify provider-side audit gaps after the normalized customer usage has
   * passed its independent financial invariants. The result is persisted as
   * INCOMPLETE/OPEN and emitted to metrics, but deliberately does not authorize
   * QUARANTINED, a funding hold, or an account/key restriction.
   */
  private resolveProviderEvidenceAuditReason(event: JsonObject): string | null {
    if (stringValue(event.token_source) !== 'provider') return null;

    const usageEvidence = optionalObject(event.usage_evidence);
    const evidenceStatus = stringValue(usageEvidence.status)?.toLowerCase();
    const evidenceSource = stringValue(usageEvidence.source)?.toLowerCase();
    const evidenceProtocol = stringValue(usageEvidence.protocol);
    let primaryIssue: string | null = null;
    if (!evidenceStatus) primaryIssue = 'usage_evidence_missing';
    else if (evidenceStatus !== 'complete') primaryIssue = `usage_evidence_${evidenceStatus}`;
    else if (!['provider_terminal', 'provider_response'].includes(evidenceSource ?? '')) {
      primaryIssue = 'usage_evidence_source_invalid';
    } else if (!evidenceProtocol) primaryIssue = 'usage_evidence_protocol_missing';
    else if (
      evidenceSource === 'provider_terminal'
      && usageEvidence.terminal_frame_seen !== true
    ) {
      primaryIssue = 'provider_terminal_frame_missing';
    } else if (event.provider_reconciliation_required !== false) {
      primaryIssue = event.provider_reconciliation_required === true
        ? 'provider_reconciliation_required'
        : 'provider_reconciliation_verdict_missing';
    } else if (
      !stringValue(event.provider_account_ref)
      && !stringValue(event.provider_credential_ref)
    ) {
      primaryIssue = 'provider_account_ref_missing';
    } else if (
      !this.resolveUpstreamRequestId(event)
      && !stringValue(event.upstream_response_id)
    ) {
      primaryIssue = 'upstream_correlation_id_missing';
    }

    const contract = evaluateGatewayProviderEvidenceContract(
      event,
      this.verifiedProducerBuilds,
    );
    if (contract.issues.length === 0) {
      gatewayUsageEvidenceContractTotal.inc({
        mode: this.evidenceContractMode,
        outcome: 'pass',
        issue: 'none',
      });
    } else {
      for (const issue of contract.issues) {
        gatewayUsageEvidenceContractTotal.inc({
          mode: this.evidenceContractMode,
          outcome: 'issue',
          issue,
        });
        if (!this.loggedShadowEvidenceIssues.has(issue)) {
          this.loggedShadowEvidenceIssues.add(issue);
          this.logger.warn(
            `Gateway provider evidence audit issue=${issue}; `
            + 'customer settlement uses independently validated normalized usage',
          );
        }
      }
      primaryIssue ??= `evidence_contract_${contract.issues[0]}`;
    }
    return primaryIssue;
  }

  /**
   * Omitted cache meters are zero while explicit normalized values are retained.
   * Provider audit gaps stay OPEN without erasing otherwise proven customer
   * usage; only invalid customer dimensions use the protective zero floor.
   */
  private assessCustomerSettlement(
    event: JsonObject,
    anchor: GatewaySettlementAnchor,
    input: UsageDeductInput,
    auditReason: string | null,
    forcedProtectiveReason: string | null = null,
  ): CustomerSettlementAssessment {
    const original = this.customerSettlementDimensionsFromAnchor(anchor);
    const canonicalInput: UsageDeductInput = {
      ...input,
      ...original,
      imageCount: original.imageCount,
    };
    const protectiveZero = (reason: string): CustomerSettlementAssessment => {
      const floor: CustomerSettlementDimensions = {
        inputTokens: 0,
        outputTokens: 0,
        cachedInputTokens: 0,
        cacheWriteInputTokens: 0,
        totalTokens: 0,
        imageCount: 0,
      };
      const evidenceReason = auditReason ?? reason;
      return {
        input: this.annotateCustomerSettlement(
          anchor,
          {
            ...canonicalInput,
            ...floor,
            source: `${input.source}:customer-protective-zero`,
          },
          'CUSTOMER_PROTECTIVE_ZERO',
          evidenceReason,
          original,
          floor,
          reason,
        ),
        evidenceReason,
        customerProtectionReason: reason,
        basis: 'CUSTOMER_PROTECTIVE_ZERO',
      };
    };

    if (forcedProtectiveReason) return protectiveZero(forcedProtectiveReason);
    if (stringValue(event.token_source) !== 'provider') {
      const evidenceReason = auditReason ?? 'none';
      return {
        input: this.annotateCustomerSettlement(
          anchor,
          canonicalInput,
          'NORMALIZED_EXACT',
          evidenceReason,
          original,
          original,
        ),
        evidenceReason: auditReason,
        customerProtectionReason: null,
        basis: 'NORMALIZED_EXACT',
      };
    }

    const usageEvidence = optionalObject(event.usage_evidence);
    const evidenceStatus = stringValue(usageEvidence.status)?.toLowerCase() ?? '';
    const evidenceSource = stringValue(usageEvidence.source)?.toLowerCase() ?? '';
    const evidenceProtocol = stringValue(usageEvidence.protocol)?.toLowerCase() ?? '';
    const rawDimensions = usageEvidence.dimensions_present
      ?? event.usage_dimensions_present;
    const dimensions = Array.isArray(rawDimensions)
      ? rawDimensions.map((value) => stringValue(value)?.toLowerCase() ?? '')
      : [];
    const dimensionsValid = dimensions.length > 0
      && dimensions.every(Boolean)
      && new Set(dimensions).size === dimensions.length;
    const present = new Set(dimensionsValid ? dimensions : []);
    const hasInput = present.has('input_tokens');
    const hasOutput = present.has('output_tokens');
    const hasCacheRead = present.has('cache_read_input_tokens');
    const hasCacheWrite = present.has('cache_creation_input_tokens');
    const hasCacheOmission = !hasCacheRead || !hasCacheWrite;
    const contract = evaluateGatewayProviderEvidenceContract(
      event,
      this.verifiedProducerBuilds,
    );
    const customerBlockingContractIssues = contract.issues.filter(
      (issue) => !CUSTOMER_SETTLEMENT_PURE_AUDIT_ISSUES.has(issue)
        && !CUSTOMER_SETTLEMENT_CACHE_OMISSION_ISSUES.has(issue),
    );

    let customerProtectionReason: string | null = customerBlockingContractIssues.length > 0
      ? `evidence_contract_${customerBlockingContractIssues[0]}`
      : null;
    if (!customerProtectionReason && ![
      'provider_terminal',
      'provider_response',
    ].includes(evidenceSource)) {
      customerProtectionReason = 'usage_evidence_source_invalid';
    }
    if (
      !customerProtectionReason
      && evidenceSource === 'provider_terminal'
      && usageEvidence.terminal_frame_seen !== true
    ) {
      customerProtectionReason = 'provider_terminal_frame_missing';
    }
    if (!customerProtectionReason && !evidenceProtocol) {
      customerProtectionReason = 'usage_evidence_protocol_missing';
    }
    const evidenceStatusIsUsable = evidenceStatus === 'complete'
      || (evidenceStatus === 'partial' && hasCacheOmission);
    if (!customerProtectionReason && !evidenceStatusIsUsable) {
      customerProtectionReason = evidenceStatus
        ? `usage_evidence_${evidenceStatus}`
        : 'usage_evidence_missing';
    }
    if (!customerProtectionReason && (!dimensionsValid || !hasInput || !hasOutput)) {
      customerProtectionReason = dimensionsValid
        ? 'customer_settlement_core_dimensions_incomplete'
        : 'usage_dimensions_missing';
    }
    if (customerProtectionReason) return protectiveZero(customerProtectionReason);

    const evidenceReason = auditReason ?? 'none';
    return {
      input: this.annotateCustomerSettlement(
        anchor,
        canonicalInput,
        'NORMALIZED_EXACT',
        evidenceReason,
        original,
        original,
      ),
      evidenceReason: auditReason,
      customerProtectionReason: null,
      basis: 'NORMALIZED_EXACT',
    };
  }

  private customerSettlementDimensions(input: UsageDeductInput): CustomerSettlementDimensions {
    return {
      inputTokens: input.inputTokens ?? 0,
      outputTokens: input.outputTokens ?? 0,
      cachedInputTokens: input.cachedInputTokens ?? 0,
      cacheWriteInputTokens: input.cacheWriteInputTokens ?? 0,
      totalTokens: input.totalTokens ?? (input.inputTokens ?? 0) + (input.outputTokens ?? 0),
      imageCount: input.imageCount ?? 0,
    };
  }

  private customerSettlementDimensionsFromAnchor(
    anchor: GatewaySettlementAnchor,
  ): CustomerSettlementDimensions {
    const quote = anchor.customerQuoteSnapshot;
    const inputTokens = strictNonNegativeInt(quote.inputTokens);
    const outputTokens = strictNonNegativeInt(quote.outputTokens);
    const cachedInputTokens = strictNonNegativeInt(quote.cachedInputTokens);
    const cacheWriteInputTokens = strictNonNegativeInt(quote.cacheWriteInputTokens);
    const imageCount = strictNonNegativeInt(quote.imageCount);
    if (
      inputTokens === null
      || outputTokens === null
      || cachedInputTokens === null
      || cacheWriteInputTokens === null
      || imageCount === null
      || cachedInputTokens + cacheWriteInputTokens > inputTokens
    ) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway settlement anchor 缺少有效 canonical customer dimensions',
      );
    }
    return {
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheWriteInputTokens,
      totalTokens: inputTokens + outputTokens,
      imageCount,
    };
  }

  private annotateCustomerSettlement(
    anchor: GatewaySettlementAnchor,
    input: UsageDeductInput,
    basis: NonNullable<UsageDeductInput['gatewayCustomerSettlement']>['basis'],
    evidenceReason: string,
    originalDimensions: CustomerSettlementDimensions,
    settledDimensions: CustomerSettlementDimensions,
    customerProtectionReason: string | null = null,
  ): UsageDeductInput {
    if (
      anchor.customerSettlementPolicyVersion
      !== LATEST_GATEWAY_CUSTOMER_SETTLEMENT_POLICY_VERSION
    ) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway settlement anchor customer policy version 无效',
      );
    }
    return {
      ...input,
      gatewayCustomerSettlement: {
        policyVersion: LATEST_GATEWAY_CUSTOMER_SETTLEMENT_POLICY_VERSION,
        basis,
        evidenceReason,
        ...(customerProtectionReason ? { customerProtectionReason } : {}),
        originalDimensions,
        settledDimensions,
      },
    };
  }

  /** Complete evidence remains mandatory only for explicit finance correction
   * commands. Ordinary customer settlement calls the two evaluators above
   * independently and never uses this combined gate. */
  private resolveEvidenceQuarantineReason(event: JsonObject): string | null {
    return this.resolveSettlementUsageUncertaintyReason(event)
      ?? this.resolveProviderEvidenceAuditReason(event);
  }

  /**
   * Return a reason only when the signed raw event is itself sufficient to
   * prove that this request can never carry a customer charge. In particular,
   * lifecycle hints such as pending quota settlement, auth/ingress labels, or
   * an output-less response are not settlement evidence.
   */
  private resolvePermanentNoChargeReason(event: JsonObject): string | null {
    const error = optionalObject(event.error);
    const tokensAreExactlyZero = this.hasExactZeroUsageDimensions(event);
    const producerBuildSha = stringValue(event.producer_build_sha)?.toLowerCase();

    // NO_CHARGE releases reserved money, so both pre-upstream quota rollback
    // and provider-terminal zero evidence require a fleet build explicitly
    // authorized by Billing. Database terminal proof independently binds the
    // evidence row to the append-only authority chain.
    if (!producerBuildSha || !this.verifiedProducerBuilds.has(producerBuildSha)) {
      return null;
    }

    if (
      event.status === 'failure'
      && strictNonNegativeInt(event.status_code) === 429
      && event.quota_settlement === 'rollback'
      && error.stage === 'auth'
      && error.type === 'quota_exceeded'
      && event.upstream_started === false
      && event.response_started === false
      && tokensAreExactlyZero
    ) {
      return 'quota_exceeded';
    }

    // A successful provider terminal/response with a complete signed usage
    // envelope and every metered dimension explicitly zero is authoritative.
    // Merely observing no output, a disconnect, or an estimated zero is not.
    if (
      event.status === 'success'
      && event.token_source === 'provider'
      && tokensAreExactlyZero
      && this.hasCompleteProviderZeroUsageEvidence(event)
    ) {
      return 'zero_usage';
    }

    return null;
  }

  private hasExactZeroUsageDimensions(event: JsonObject): boolean {
    const tokenExtras = optionalObject(event.token_extras);
    if (
      strictNonNegativeInt(event.prompt_tokens) !== 0
      || strictNonNegativeInt(event.completion_tokens) !== 0
      || strictNonNegativeInt(event.total_tokens) !== 0
      || strictNonNegativeInt(tokenExtras.cached_tokens) !== 0
      || strictNonNegativeInt(tokenExtras.cache_creation_input_tokens) !== 0
      || strictNonNegativeInt(event.image_count) !== 0
    ) {
      return false;
    }
    const tokens = this.extractTokens(event);
    if (
      tokens.inputTokens !== 0
      || tokens.outputTokens !== 0
      || tokens.cachedInputTokens !== 0
      || tokens.cacheWriteInputTokens !== 0
      || tokens.totalTokens !== 0
      || tokens.imageCount !== 0
    ) {
      return false;
    }
    return true;
  }

  private hasCompleteProviderZeroUsageEvidence(event: JsonObject): boolean {
    const usageEvidence = optionalObject(event.usage_evidence);
    const tokenExtras = optionalObject(event.token_extras);
    const dimensions = Array.isArray(usageEvidence.dimensions_present)
      ? new Set(usageEvidence.dimensions_present)
      : null;
    const producerBuildSha = typeof event.producer_build_sha === 'string'
      && /^(?:[0-9a-f]{40}|sha256:[0-9a-f]{64})$/.test(event.producer_build_sha)
      ? event.producer_build_sha
      : null;
    const providerUsageHashValid = typeof event.provider_usage_hash === 'string'
      && /^sha256:[0-9a-f]{64}$/.test(event.provider_usage_hash);
    const structuralContractComplete = Boolean(
      producerBuildSha
      && providerUsageHashValid
      && evaluateGatewayProviderEvidenceContract(
        event,
        this.verifiedProducerBuilds,
      ).issues.length === 0,
    );
    return (
      event.stream_end_reason === 'normal_end'
      && event.provider_reconciliation_required === false
      && usageEvidence.source === 'provider_terminal'
      && usageEvidence.status === 'complete'
      && Boolean(stringValue(usageEvidence.protocol))
      && usageEvidence.terminal_frame_seen === true
      && structuralContractComplete
      && Object.values(tokenExtras).every(
        (value) => strictNonNegativeInt(value) !== null,
      )
      && Boolean(stringValue(event.provider_account_ref))
      && Boolean(
        stringValue(event.upstream_request_id)
        || stringValue(event.upstream_response_id),
      )
      && dimensions !== null
      && [
        'input_tokens',
        'output_tokens',
        'cache_read_input_tokens',
        'cache_creation_input_tokens',
      ].every((dimension) => dimensions.has(dimension))
    );
  }

  private resolveNoChargeCandidateReason(event: JsonObject): string | null {
    const request = optionalObject(event.request);
    const error = optionalObject(event.error);
    const labels = this.eventLabels(event);

    if (request.is_idempotent_replay === true || event.is_idempotent_replay === true) {
      return 'idempotent_replay';
    }

    const quotaSettlement = stringValue(event.quota_settlement);
    if (quotaSettlement === 'pending') {
      return 'pending_settlement';
    }

    const errorStage = stringValue(error.stage);
    const errorType = stringValue(error.type);
    const statusCode = nonNegativeInt(event.status_code);
    if (errorStage === 'ingress') return 'ingress_error';
    if (errorType === 'quota_exceeded') return 'quota_exceeded';
    if (errorType === 'rate_limited') return 'rate_limited';
    if (errorType === 'internal') return 'internal_error';
    if (errorStage === 'auth' && (statusCode === 401 || statusCode === 403)) {
      return 'auth_error';
    }
    if (quotaSettlement === 'rollback') return 'quota_settlement_rollback';
    if (quotaSettlement === 'skipped') return 'quota_settlement_skipped';
    if (quotaSettlement === 'skipped_due_to_failure') {
      return 'quota_settlement_skipped_due_to_failure';
    }

    const tokens = this.extractTokens(event);
    const hasBillableImage = tokens.imageCount > 0;
    if (tokens.totalTokens <= 0 && !hasBillableImage) {
      return 'zero_usage';
    }
    if (
      tokens.outputTokens <= 0 &&
      !hasBillableImage &&
      this.requiresDeliveredOutput(event, labels)
    ) {
      return 'no_output_tokens_for_output_required_usage';
    }

    const status = stringValue(event.status);
    if (status === 'success') return null;

    const tokenSource = stringValue(event.token_source);
    if (status === 'failure' && tokenSource === 'provider') return null;
    if (
      status === 'failure' &&
      (tokenSource === 'estimated' || tokenSource === 'estimated_tokenizer')
    ) {
      return 'estimated_disconnect_usage';
    }

    return status ? 'usage_status_not_billable' : 'usage_status_missing';
  }

  private toDeductInput(event: JsonObject, requestId: string): UsageDeductInput {
    const labels = this.eventLabels(event);
    const modelName = this.resolveModelName(event);
    if (!modelName) {
      throw new MalformedGatewayUsageEventError('Gateway usage event 缺少可计费模型名');
    }

    const tokens = this.extractTokens(event);
    const apiKeyId = this.resolveApiKeyId(event, labels);
    const tenantId = this.resolveTenantId(event, labels);
    const userId = this.resolveUserId(event, labels);
    const productId = this.resolveProductId(labels);
    const productSlug = this.resolveProductSlug(labels);

    if (!apiKeyId && !tenantId && !userId && !labels.email) {
      throw new MalformedGatewayUsageEventError(
        'Gateway usage event 缺少 apiKeyId/tenantId/userId/email 计费主体',
      );
    }

    const provider = this.resolveProvider(event);
    const region = this.resolveRegion(event, labels);
    const eventOccurredAt = this.resolveEventOccurredAt(event, { required: true });
    const callType = this.resolveCallType(event);
    const upstreamModel = this.resolveUpstreamModel(event);

    return {
      apiKeyId,
      tenantId,
      userId,
      email: labels.email,
      productId,
      productSlug,
      modelName,
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      cachedInputTokens: tokens.cachedInputTokens,
      cacheWriteInputTokens: tokens.cacheWriteInputTokens,
      totalTokens: tokens.totalTokens,
      ...(tokens.imageCount > 0 ? { imageCount: tokens.imageCount } : {}),
      ...(callType ? { callType } : {}),
      ...(upstreamModel ? { upstreamModel } : {}),
      billingUnit: 'AUTO',
      providerCode: provider === 'unknown-provider' ? undefined : provider,
      source: `gateway:${region}:${provider}:${modelName}`,
      requestId,
      idempotencyKey: `gateway:request:${requestId}`,
      eventOccurredAt,
      recordTokenUsage: true,
      // Enterprise accounts may consume only their active account credit;
      // accounts without credit follow the ordinary personal balance policy.
      // A deployment flag must never create an unapproved credit line.
      allowNegativeBalance: false,
    };
  }

  private toAnchoredDeductInput(
    event: JsonObject,
    requestId: string,
    anchor: GatewaySettlementAnchor,
  ): UsageDeductInput {
    const input = this.toDeductInput(event, requestId);
    return {
      ...input,
      apiKeyId: anchor.apiKeyId,
      userId: anchor.userId,
      tenantId: anchor.tenantId,
      productId: anchor.productId,
      productSlug: anchor.productSlug,
      billingUnit: anchor.billingUnit,
      eventOccurredAt: anchor.occurredAt,
    };
  }

  private resolveEventOccurredAt(
    event: JsonObject,
    opts: { required?: boolean } = {},
  ): Date | undefined {
    const rawEvent = optionalObject(event.raw_event);
    const rawEventCamel = optionalObject(event.rawEvent);
    const candidates = [
      // UsageEvent.ts currently represents end_time. Settlement occurrence
      // must therefore prefer the request start_time whenever the contract
      // provides it, while retaining older event fallbacks for compatibility.
      event.start_time,
      event.startTime,
      rawEvent.start_time,
      rawEvent.startTime,
      rawEventCamel.start_time,
      rawEventCamel.startTime,
      event.timestamp,
      event.occurred_at,
      event.occurredAt,
      event.ts,
      rawEvent.timestamp,
      rawEvent.occurred_at,
      rawEvent.occurredAt,
      rawEvent.ts,
      rawEventCamel.timestamp,
      rawEventCamel.occurred_at,
      rawEventCamel.occurredAt,
      rawEventCamel.ts,
    ];
    for (const candidate of candidates) {
      const occurredAt = gatewayEventTimeValue(candidate);
      if (occurredAt) return occurredAt;
    }
    if (opts.required) {
      throw new MalformedGatewayUsageEventError('Gateway usage event 缺少有效发生时间');
    }
    return undefined;
  }

  private requiresDeliveredOutput(event: JsonObject, labels: Record<string, string>): boolean {
    const request = optionalObject(event.request);
    const base = optionalObject(event.base);
    const candidates = [
      labels.source,
      labels['usr.source'],
      labels.usage_source,
      labels.billing_source,
      labels.raytone_source,
      labels.ruidong_source,
      labels['x-ruidong-source'],
      labels.operation,
      labels.operation_type,
      labels.endpoint,
      labels.path,
      labels.route,
      labels.request_path,
      labels.api_endpoint,
      labels.billing_semantics,
      stringValue(event.source),
      stringValue(event.operation),
      stringValue(event.operation_type),
      stringValue(event.endpoint),
      stringValue(event.path),
      stringValue(event.route),
      stringValue(event.request_path),
      stringValue(event.api_endpoint),
      stringValue(event.billing_semantics),
      stringValue(request.source),
      stringValue(request.operation),
      stringValue(request.operation_type),
      stringValue(request.endpoint),
      stringValue(request.path),
      stringValue(request.route),
      stringValue(request.request_path),
      stringValue(request.api_endpoint),
      stringValue(request.billing_semantics),
      stringValue(base.source),
      stringValue(base.operation),
      stringValue(base.operation_type),
      stringValue(base.endpoint),
      stringValue(base.path),
      stringValue(base.route),
      stringValue(base.request_path),
      stringValue(base.api_endpoint),
      stringValue(base.billing_semantics),
    ].filter((value): value is string => typeof value === 'string' && value.trim().length > 0);

    return candidates.some((value) => {
      const normalized = value.trim().toLowerCase().replace(/_/g, '.');
      if (normalized === 'playground' || normalized === 'requires.output.delivery') {
        return true;
      }
      if (
        [
          'chat',
          'chat.completion',
          'chat.completions',
          'llm.chat',
          'openai.chat',
          'openai.chat.completions',
          'responses',
          'response',
          'openai.responses',
        ].includes(normalized)
      ) {
        return true;
      }
      return (
        normalized.includes('/chat/completions') ||
        normalized.endsWith('/responses') ||
        normalized.includes('/responses/')
      );
    });
  }

  private extractTokens(event: JsonObject) {
    // UsageEvent v2 owns the normalized core meters at the top level and all
    // provider-specific subdivisions in token_extras. Raw response shapes are
    // evidence only; interpreting them again here would create a second parser
    // with different validation and precedence rules from Gateway.
    const tokenExtras = optionalObject(event.token_extras);
    const inputTokens = nonNegativeInt(event.prompt_tokens);
    let outputTokens = nonNegativeInt(event.completion_tokens);
    const cachedInputTokens = firstPositiveInt([
      tokenExtras.cache_hit_tokens,
      tokenExtras.cached_tokens,
      tokenExtras.cached_input_tokens,
      tokenExtras.cache_read_tokens,
      tokenExtras.cache_read_input_tokens,
      tokenExtras.prompt_cache_hit_tokens,
      tokenExtras.cachedContentTokenCount,
      tokenExtras.cached_content_token_count,
    ]);
    const explicitCacheWriteTokens = firstPositiveInt([
      tokenExtras.cache_write_tokens,
      tokenExtras.cache_creation_input_tokens,
      tokenExtras.cache_creation_tokens,
    ]);
    const anthropicBucketCacheWriteTokens = sumPositiveInts([
      tokenExtras.anthropic_ephemeral_5m_input_tokens,
      tokenExtras.anthropic_ephemeral_1h_input_tokens,
      tokenExtras.ephemeral_5m_input_tokens,
      tokenExtras.ephemeral_1h_input_tokens,
    ]);
    const cacheWriteInputTokens = explicitCacheWriteTokens || anthropicBucketCacheWriteTokens;
    const tokenSource = stringValue(event.token_source);
    const reportedTotalTokens = nonNegativeInt(event.total_tokens);
    const estimatedTotalTokens =
      tokenSource === 'estimated' || tokenSource === 'estimated_tokenizer'
        ? nonNegativeInt(event.estimated_total_tokens)
        : 0;
    const reportedTotal = reportedTotalTokens > 0
      ? reportedTotalTokens
      : estimatedTotalTokens;
    if (inputTokens + outputTokens <= 0 && reportedTotal > 0) {
      outputTokens = reportedTotal;
    }
    const totalTokens = reportedTotal > 0 ? reportedTotal : inputTokens + outputTokens;
    const imageCount = nonNegativeInt(tokenExtras.image_count);
    return {
      inputTokens,
      outputTokens,
      cachedInputTokens,
      cacheWriteInputTokens,
      totalTokens,
      imageCount,
    };
  }

  private finalAttempt(decision: JsonObject): JsonObject {
    const attempts = Array.isArray(decision.attempts)
      ? decision.attempts.filter(isJsonObject)
      : [];
    if (attempts.length === 0) return {};
    return attempts.find((attempt) => {
      const status = nonNegativeInt(attempt.status_code);
      return status >= 200 && status < 300;
    }) ?? attempts[attempts.length - 1];
  }

  private billingFailureReason(billing: Record<string, unknown>): BillingFailureClassification | null {
    if (billing.success === false || billing.allowed === false) {
      return this.normalizeBillingFailureReason(stringValue(billing.reason) ?? null);
    }
    return null;
  }

  private normalizeBillingFailureReason(reason: string | null): BillingFailureClassification {
    if (this.isRetryableBillingFailureReason(reason)) {
      return { terminal: false, reason };
    }
    if (this.isTerminalBillingFailureReason(reason)) {
      return { terminal: true, reason };
    }
    return { terminal: false, reason: 'billing_rejected' };
  }

  private isTerminalBillingFailureReason(
    reason: string | null,
  ): reason is GatewayUsageTerminalBillingFailureReason {
    return Boolean(
      reason &&
        (GATEWAY_USAGE_TERMINAL_BILLING_FAILURE_REASONS as readonly string[]).includes(reason),
    );
  }

  private isRetryableBillingFailureReason(
    reason: string | null,
  ): reason is GatewayUsageRetryableFailureReason {
    return Boolean(
      reason &&
        (GATEWAY_USAGE_RETRYABLE_FAILURE_REASONS as readonly string[]).includes(reason),
    );
  }

  private gatewayTenantMismatchReason(
    input: UsageDeductInput,
    billing: Record<string, unknown>,
  ): string | null {
    const apiKeyId = input.apiKeyId?.trim();
    const eventTenantId = input.tenantId?.trim();
    if (!apiKeyId || !eventTenantId) return null;

    const quote = isJsonObject(billing.quote) ? billing.quote : null;
    if (!quote) return null;

    const trustedTenantId = this.billingTenantId(quote);
    if (!trustedTenantId) {
      gatewayTenantMismatchTotal.inc({
        reason: 'gateway_tenant_api_key_unbound_tenant_ignored',
      });
      return 'gateway_tenant_api_key_unbound_tenant_ignored';
    }
    if (trustedTenantId !== eventTenantId) {
      gatewayTenantMismatchTotal.inc({
        reason: 'gateway_tenant_api_key_mismatch',
      });
      return 'gateway_tenant_api_key_mismatch';
    }
    return null;
  }

  private billingTenantId(quote: Record<string, unknown>): string | null {
    return stringValue(quote.tenantId) ?? null;
  }

  private isTerminalProcessingError(err: unknown): boolean {
    // Only immutable event-contract defects are terminal here. Pricing,
    // subject, entitlement and model-access failures are mutable billing
    // configuration and must remain technically retryable after remediation.
    return err instanceof MalformedGatewayUsageEventError;
  }

  // Stage-timing wrappers (diagnostic only). Implemented as thin delegates so
  // the measured bodies stay byte-identical; `timed` is a pass-through outside
  // the consumer, so HTTP callers are unaffected.
  private recordReceived(
    event: JsonObject,
    requestId: string,
    requiresSettlementAnchor: boolean,
  ): Promise<ReceivedEvidence> {
    return timed('recordReceived', () =>
      this.recordReceivedInner(event, requestId, requiresSettlementAnchor),
    );
  }

  private async recordReceivedInner(
    event: JsonObject,
    requestId: string,
    requiresSettlementAnchor: boolean,
  ): Promise<ReceivedEvidence> {
    const snapshot = this.auditSnapshot(event);
    const evidenceHash = canonicalSha256(event);
    const tokenSource = stringValue(event.token_source);
    const upstreamRequestId = this.resolveUpstreamRequestId(event);
    const producerBuildSha = stringValue(event.producer_build_sha);
    const providerUsageHash = stringValue(event.provider_usage_hash);
    const providerAccountRef = stringValue(event.provider_account_ref);
    const streamEndReason = stringValue(event.stream_end_reason);
    const usageEvidence = optionalObject(event.usage_evidence);
    const providerCredentialRef = stringValue(event.provider_credential_ref);
    const upstreamResponseId = stringValue(event.upstream_response_id);
    const usageEvidenceSource = stringValue(usageEvidence.source);
    const usageEvidenceStatus = stringValue(usageEvidence.status);
    const usageEvidenceProtocol = stringValue(usageEvidence.protocol);
    const terminalFrameSeen = typeof usageEvidence.terminal_frame_seen === 'boolean'
      ? usageEvidence.terminal_frame_seen
      : undefined;
    const providerReconciliationRequired =
      typeof event.provider_reconciliation_required === 'boolean'
        ? event.provider_reconciliation_required
        : undefined;
    let settlementAnchorError: string | undefined;
    let settlementAnchorFailureKind: ReceivedEvidence['settlementAnchorFailureKind'];
    return this.prisma.$transaction(async (tx) => {
      // Use the Billing database clock for receipt/observation facts. Gateway
      // occurrence time is a separate clock domain and must never masquerade
      // as the time Billing observed evidence.
      const databaseObservedAt = await this.readDatabaseClock(tx);
      // The actual INSERT result is the only trustworthy first-receipt flag.
      // A pre-read is unsafe: two transactions may both observe absence while
      // one later waits on the other's unique-key insert. ON CONFLICT reports
      // that loser as count=0 after the winner commits.
      const inserted = await tx.gatewayBillingEvent.createMany({
        data: [{
          requestId,
          status: 'RECEIVED',
          rawEvent: event as Prisma.InputJsonValue,
          evidenceHash,
          evidenceVerdict: 'UNKNOWN',
          reconciliationStatus: 'OPEN',
          receivedAt: databaseObservedAt,
          ...snapshot,
        }],
        skipDuplicates: true,
      });
      const firstReceiptCreated = inserted.count === 1;
      const row = await tx.gatewayBillingEvent.findUniqueOrThrow({
        where: { requestId },
        // ⚠️ 这里**只**取不可变的 id。三态判定所需的可变字段必须来自下面的锁语句 ——
        // 锁前快照在并发重收时会过期，详见该处注释。
        select: { id: true },
      });
      // Serialize evidence revision allocation for this request. The upsert
      // protects occurrence creation; this explicit row lock protects later,
      // distinct evidence arriving concurrently.
      // ⚠️ 锁语句**本身**返回三态判定所需字段（评审 P0）。
      //
      // 曾经的写法在加锁**之前**读父行快照，并发重收时不安全：两个事务都可能先读到
      // 墓碑为 NULL；先获锁者写墓碑并追加本轮 evidence 后提交，后获锁者手里的 JS 快照
      // 并不会刷新 —— 它可能把**刚被追加**的 evidence 当成历史首证据而返回 available，
      // 从而把部署前的积压误记成敞口，直接违反「历史不回补」。
      const lockedReceipt = await tx.$queryRaw<Array<{
        id: string;
        evidenceHash: string | null;
        legacyOriginalEvidenceMissingAt: Date | null;
      }>>`
        SELECT
          "id",
          "evidence_hash" AS "evidenceHash",
          "legacy_original_evidence_missing_at" AS "legacyOriginalEvidenceMissingAt"
        FROM "gateway_billing_events"
        WHERE "request_id" = ${requestId}
        FOR UPDATE
      `;
      const lockedReceiptRow = lockedReceipt[0];
      if (lockedReceipt.length !== 1 || !lockedReceiptRow?.id) {
        throw new NotFoundException('Gateway billing event 不存在');
      }

      // ⚠️ 冻结首收观察时间，**必须在追加本轮 evidence 之前**完成。
      //
      // 现有顺序是「先追加本轮 evidence、再读父记录」，所以历史父记录若原本没有
      // original evidence，本轮重见的 observedAt 就会冒充首次观察时间 ——
      // 那会让部署前的积压被误判为「T 之后首收」而错误计入敞口。
      //
      // 三态判定（父行锁已串行化同一 requestId 的 revision 分配与本次冻结，
      // 并发 loser 获锁时会看到 winner 已提交的 evidence 或墓碑，故不需要额外 advisory lock）：
      let originalEvidenceObservation: OriginalEvidenceObservation;
      if (firstReceiptCreated) {
        // 本轮就是首收 ⇒ 用本轮实际插入时间。
        originalEvidenceObservation = { kind: 'available', observedAt: databaseObservedAt };
      } else if (lockedReceiptRow.legacyOriginalEvidenceMissingAt) {
        // 已被墓碑冻结 ⇒ 永久排除，绝不改用本轮时间。
        originalEvidenceObservation = { kind: 'legacy_original_evidence_missing' };
      } else {
        // 按 (event, revision=1) 唯一键取首收证据，**再**核对 hash（评审 P1）。
        //
        // 只按父 evidence_hash 查是不够的：库里允许「匹配 hash 的 evidence 是 rev2、
        // rev1 缺失」这种异常状态，那时不会写墓碑，但 exposure 又被三列复合 FK 要求
        // 只能引用 rev1 ⇒ writer 必然撞 FK。所以判定必须同时证明「存在且是 rev1」。
        //
        // 该查询命中 gateway_usage_evidences_event_revision_key（点查，非扫描）——
        // 它在父行锁内执行，扫描会延长锁持有时间。
        const originalRev1 = await tx.gatewayUsageEvidence.findUnique({
          where: {
            gatewayBillingEventId_evidenceRevision: {
              gatewayBillingEventId: lockedReceiptRow.id,
              evidenceRevision: 1,
            },
          },
          select: { observedAt: true, evidenceHash: true },
        });
        const original = originalRev1
          && lockedReceiptRow.evidenceHash
          && originalRev1.evidenceHash === lockedReceiptRow.evidenceHash
          ? originalRev1
          : null;
        if (original) {
          originalEvidenceObservation = { kind: 'available', observedAt: original.observedAt };
        } else {
          // 首收证据异常缺失 ⇒ 写墓碑并永久排除（墓碑单调，由独立触发器保证 write-once）。
          //
          // ⚠️ 用 NULL 作为 CAS 条件：父行锁已串行化同一 requestId，但多写一层 CAS 让
          // 「墓碑已被别人写过」退化为 0 行更新，而不是撞 write-once 触发器导致整笔回滚。
          await tx.gatewayBillingEvent.updateMany({
            where: { id: lockedReceiptRow.id, legacyOriginalEvidenceMissingAt: null },
            data: { legacyOriginalEvidenceMissingAt: databaseObservedAt },
          });
          originalEvidenceObservation = { kind: 'legacy_original_evidence_missing' };
        }
      }

      if (!firstReceiptCreated) {
        await tx.gatewayBillingEvent.update({
          where: { id: row.id },
          data: { receivedAt: databaseObservedAt },
        });
      }
      if (firstReceiptCreated && requiresSettlementAnchor) {
        try {
          const settlementAnchorCandidate = await this.usageBilling.resolveGatewaySettlementAnchor(
            tx,
            this.toDeductInput(event, requestId),
            databaseObservedAt,
          );
          let firstReceiptSequence: bigint | null = null;
          if (settlementAnchorCandidate.billingUnit === 'BALANCE') {
            // This lock is deliberately taken before nextval() is called.
            // Same-account anchor commits are therefore ordered:
            // B cannot allocate a visible later sequence until A's anchor has
            // committed, even when requests arrive on different partitions.
            await tx.$executeRaw`
              SELECT pg_advisory_xact_lock(
                ${GATEWAY_BALANCE_RECEIPT_SEQUENCE_LOCK_NAMESPACE}::int,
                hashtext(${settlementAnchorCandidate.billingAccountId})::int
              )
            `;
            const sequenceRows = await tx.$queryRaw<Array<{
              firstReceiptSequence: bigint;
            }>>`
              SELECT nextval('"gateway_usage_first_receipt_sequence_seq"')::BIGINT
                AS "firstReceiptSequence"
            `;
            firstReceiptSequence = sequenceRows[0]?.firstReceiptSequence ?? null;
            if (!firstReceiptSequence || firstReceiptSequence <= 0n) {
              throw new Error('Gateway BALANCE first-receipt sequence allocation failed');
            }
          }
          await this.usageBilling.assertGatewaySettlementAnchorForReceipt(
            tx,
            settlementAnchorCandidate,
          );
          await tx.gatewayUsageSettlementAnchor.createMany({
            data: [{
            id: randomUUID(),
            gatewayBillingEventId: row.id,
            requestId,
            apiKeyId: settlementAnchorCandidate.apiKeyId,
            userId: settlementAnchorCandidate.userId,
            tenantId: settlementAnchorCandidate.tenantId,
            billingAccountId: settlementAnchorCandidate.billingAccountId,
            productId: settlementAnchorCandidate.productId,
            productSlug: settlementAnchorCandidate.productSlug,
            billingUnit: settlementAnchorCandidate.billingUnit,
            billingCurrency: settlementAnchorCandidate.billingCurrency,
            codingPlanEntitlementId: settlementAnchorCandidate.codingPlanEntitlementId,
            subscriptionId: settlementAnchorCandidate.subscriptionId,
            planId: settlementAnchorCandidate.planId,
            occurredAt: settlementAnchorCandidate.occurredAt,
            firstReceivedAt: settlementAnchorCandidate.firstReceivedAt,
            firstReceiptSequence,
            fundingReservationProtocol: settlementAnchorCandidate.billingUnit === 'BALANCE'
              ? 'V1'
              : null,
            pricingHash: settlementAnchorCandidate.pricingHash,
            customerQuoteSnapshot: toInputJson(
              settlementAnchorCandidate.customerQuoteSnapshot,
            ),
            customerPricingSnapshot: toInputJson(
              settlementAnchorCandidate.customerPricingSnapshot,
            ),
            providerCostSnapshot: toInputJson(
              settlementAnchorCandidate.providerCostSnapshot,
            ),
            anchorHash: settlementAnchorCandidate.anchorHash,
            canonicalPayload: toInputJson({
              requestId,
              apiKeyId: settlementAnchorCandidate.apiKeyId,
              userId: settlementAnchorCandidate.userId,
              tenantId: settlementAnchorCandidate.tenantId,
              billingAccountId: settlementAnchorCandidate.billingAccountId,
              productId: settlementAnchorCandidate.productId,
              productSlug: settlementAnchorCandidate.productSlug,
              billingUnit: settlementAnchorCandidate.billingUnit,
              billingCurrency: settlementAnchorCandidate.billingCurrency,
              codingPlanEntitlementId: settlementAnchorCandidate.codingPlanEntitlementId,
              subscriptionId: settlementAnchorCandidate.subscriptionId,
              planId: settlementAnchorCandidate.planId,
              occurredAt: settlementAnchorCandidate.occurredAt.toISOString(),
              firstReceivedAt: settlementAnchorCandidate.firstReceivedAt.toISOString(),
              customerSettlementPolicyVersion:
                settlementAnchorCandidate.customerSettlementPolicyVersion,
              pricingHash: settlementAnchorCandidate.pricingHash,
              customerQuoteSnapshot: settlementAnchorCandidate.customerQuoteSnapshot,
              customerPricingSnapshot: settlementAnchorCandidate.customerPricingSnapshot,
              providerCostSnapshot: settlementAnchorCandidate.providerCostSnapshot,
              entitlementSnapshot: settlementAnchorCandidate.entitlementSnapshot ?? null,
              planSnapshot: settlementAnchorCandidate.planSnapshot ?? null,
            }),
            }],
            skipDuplicates: true,
          });
          if (settlementAnchorCandidate.billingUnit === 'BALANCE') {
            const pendingFundingState = this.pendingBalanceFundingState(
              settlementAnchorCandidate,
            );
            if (!pendingFundingState) {
              throw new GatewaySettlementAnchorConflictError(
                'Gateway BALANCE first receipt missing frozen funding state',
              );
            }
            await tx.gatewayBillingEvent.update({
              where: { id: row.id },
              data: {
                apiKeyId: pendingFundingState.apiKeyId,
                userId: pendingFundingState.userId,
                tenantId: pendingFundingState.tenantId,
                billingAccountId: pendingFundingState.billingAccountId,
                productId: pendingFundingState.productId,
                productSlug: pendingFundingState.productSlug,
                // Freeze the parent unit with the first-receipt anchor. The
                // provisional admission projection must be able to prove this
                // is BALANCE exposure before a later terminal state exists.
                billingUnit: 'BALANCE',
                pendingExposureUsd: pendingFundingState.amountUsd,
                pendingHoldUsd: pendingFundingState.amountUsd,
              },
            });
            // This guard commits with the first receipt, before any wallet
            // transaction begins. Publisher treats a structurally valid guard
            // as an exact provisional monetary hold, while malformed guards or
            // configured request/exposure limit breaches remain fail-closed.
            // Reservation creation replaces the guard atomically only after
            // the immutable funding fact and grant slices are durable.
            await tx.billingAccessRestriction.upsert({
              where: { idempotencyKey: `gateway:pending-unreserved:${requestId}` },
              create: {
                gatewayBillingEventId: row.id,
                billingAccountId: settlementAnchorCandidate.billingAccountId,
                reason: 'pending_usage_unreserved',
                idempotencyKey: `gateway:pending-unreserved:${requestId}`,
                createdBy: 'SYSTEM',
              },
              update: {},
            });
          }
        } catch (err) {
          // Currency migration is mutable deployment configuration. Let the
          // exception escape the first-receipt transaction so the inbox row,
          // evidence revision and any partial guard all roll back together;
          // Kafka then retains the source offset for post-migration replay.
          if (err instanceof GatewayBillingCurrencyMigrationRequiredError) {
            throw err;
          }
          settlementAnchorError = err instanceof Error ? err.message : String(err);
          settlementAnchorFailureKind = err instanceof MalformedGatewayUsageEventError
            ? 'MALFORMED'
            : err instanceof GatewaySettlementAnchorConflictError || err instanceof ConflictException
              ? 'CONFLICT'
              : 'CONFIGURATION';
          this.logger.warn(
            `gateway settlement anchor first-receipt validation failed requestId=${requestId}: ${
              err instanceof Error ? err.message : String(err)
            }`,
          );
        }
      }
      const evidenceCount = await tx.gatewayUsageEvidence.count({
        where: { gatewayBillingEventId: row.id },
      });
      await tx.gatewayUsageEvidence.createMany({
        data: [{
          gatewayBillingEventId: row.id,
          requestId,
          eventId: stringValue(event.event_id),
          source: 'GATEWAY_USAGE_EVENT',
          tokenSource,
          upstreamRequestId,
          producerBuildSha,
          providerUsageHash,
          providerAccountRef,
          streamEndReason,
          providerCredentialRef,
          upstreamResponseId,
          usageEvidenceSource,
          usageEvidenceStatus,
          usageEvidenceProtocol,
          terminalFrameSeen,
          providerReconciliationRequired,
          evidenceHash,
          evidenceRevision: evidenceCount + 1,
          rawEvidence: event as Prisma.InputJsonValue,
          observedAt: databaseObservedAt,
        }],
        skipDuplicates: true,
      });
      // All workflow state is re-read after the row lock so concurrent terminal
      // transitions cannot be hidden.
      const locked = await tx.gatewayBillingEvent.findUniqueOrThrow({
        where: { id: row.id },
        select: {
          id: true,
          status: true,
          reconciliationStatus: true,
          revision: true,
          evidenceHash: true,
          // 供 provisional exposure 的 QUARANTINED 窄例外判定用。
          reason: true,
          rawEvent: true,
          settlementAnchor: true,
          fundingReservation: { select: { status: true } },
        },
      });
      const originalEvidenceHash = locked.evidenceHash
        ?? canonicalSha256(locked.rawEvent);
      const originalRawEvent = asObject(
        locked.rawEvent,
        'GatewayBillingEvent.rawEvent',
      );
      return {
        eventId: locked.id,
        firstReceiptCreated,
        // Only the caller that inserted this first receipt sees no prior
        // status. A replay while the row is still RECEIVED must remain visible
        // so different evidence cannot bypass the conflict path.
        existingStatus: firstReceiptCreated ? null : locked.status,
        existingReconciliationStatus: !firstReceiptCreated
          ? locked.reconciliationStatus
          : null,
        revision: locked.revision,
        evidenceHash,
        originalEvidenceHash,
        originalRawEvent,
        originalEvidenceObservation,
        // 供 provisional exposure 的 QUARANTINED 窄例外用：首收那一轮没有既有 reason。
        gatewayBillingEventId: locked.id,
        existingReason: firstReceiptCreated ? null : locked.reason,
        settlementAnchor: locked.settlementAnchor
          ? settlementAnchorFromRow(locked.settlementAnchor)
          : null,
        fundingReservationStatus: locked.fundingReservation?.status ?? null,
        settlementAnchorError,
        settlementAnchorFailureKind,
      };
    });
  }

  private async readDatabaseClock(tx: Prisma.TransactionClient): Promise<Date> {
    const rows = await tx.$queryRaw<Array<{ databaseNow: Date | string }>>`
      SELECT clock_timestamp() AS "databaseNow"
    `;
    const value = rows[0]?.databaseNow;
    const databaseNow = value instanceof Date ? value : value ? new Date(value) : null;
    if (!databaseNow || Number.isNaN(databaseNow.getTime())) {
      throw new Error('Billing database clock_timestamp() returned no valid timestamp');
    }
    return databaseNow;
  }

  private async recordInternalEvidenceConflict(
    requestId: string,
    expectedRevision: number,
    reason: string,
    conflictingEvidenceHash: string,
  ): Promise<number> {
    await this.prisma.$transaction(async (tx) => {
      const current = await tx.gatewayBillingEvent.findUniqueOrThrow({
        where: { requestId },
        select: { id: true, revision: true },
      });
      if (current.revision !== expectedRevision) {
        throw new GatewayBillingRevisionConflictError(
          'Gateway billing event 状态已变化',
        );
      }
      // The append-only evidence row already carries the conflicting raw
      // payload. A provider-evidence conflict never edits the financial
      // parent: parent revision/status/reason/verdict may be bound by a durable
      // settlement receipt, and the original first receipt remains the sole
      // customer-financial authority even before that terminal is projected.
      await tx.gatewayUsageReconciliationAction.createMany({
        data: [{
          gatewayBillingEventId: current.id,
          requestId,
          action: 'EVIDENCE_CONFLICT',
          expectedRevision,
          resultingRevision: expectedRevision,
          reason,
          actorId: 'SYSTEM',
          idempotencyKey:
            `gateway:internal-evidence-conflict:${requestId}:${conflictingEvidenceHash}`,
          metadata: {
            customerFinancialParentUnchanged: true,
            firstReceiptFinancialAuthority: true,
            conflictingEvidenceHash,
          },
        }],
        skipDuplicates: true,
      });
      // Release restrictions created by older Billing versions. Provider
      // evidence conflicts are internal reconciliation facts, never an
      // account/key access-control condition.
      await tx.billingAccessRestriction.updateMany({
        where: {
          gatewayBillingEventId: current.id,
          status: 'ACTIVE',
          reason: 'evidence_conflict',
        },
        data: {
          status: 'RELEASED',
          releasedAt: new Date(),
          releasedBy: 'SYSTEM',
          releaseReason: 'provider_evidence_conflict_is_internal_only',
        },
      });
    });
    gatewayUsageReconciliationActionTotal.inc({
      action: 'evidence_conflict',
      outcome: 'detected',
    });
    return expectedRevision;
  }

  private async quarantinedResult(requestId: string): Promise<GatewayRequestEventBillingResult> {
    const event = await this.prisma.gatewayBillingEvent.findUnique({ where: { requestId } });
    if (!event) throw new NotFoundException('Gateway billing event 不存在');
    return {
      action: 'quarantined',
      requestId,
      reason: event.reason ?? 'evidence_pending',
      revision: event.revision,
      evidenceVerdict: event.evidenceVerdict,
      reconciliationStatus: event.reconciliationStatus,
      fundingOutcome: event.fundingOutcome ?? undefined,
    };
  }

  /**
   * provisional exposure 不变量破坏之后的命运（P0-3）。
   *
   * 返回**应当抛出的**错误而不是自己抛，使调用点写成 `throw await ...` ——
   * 这样「这里一定终止」在类型层面是显式的。
   *
   * ⚠️ 已在别处独立提交的 TokenUsage、余额流水与 settlement receipt **绝不**在这里回滚、
   * 冲正或重扣；重放依赖原幂等 receipt。
   * ⚠️ 这里**不**创建 settlement_policy_review、**不**加 retry access restriction ——
   * 这是平台侧历史观测失败，不能拿它冻结客户。
   */
  /**
   * provisional exposure writer。
   *
   * 在 `recordFinalStateInner` 的**同一个事务**内、父终态 `updateMany` 之后执行。
   * 返回本次归因（`null` = 非目标 reason，连日志都不打）。
   *
   * ⚠️ 归因**唯一化**：按下面的顺序取**第一个命中**，不得重复计数 —— 否则同一事件同时满足
   * `pre_cutover`、stream 非法、零输出时，不同实现会记到不同标签，指标就不可比。
   *
   * 六步顺序（冻结）：
   *   1. 非目标 reason ⇒ 立即返回 null：不读边界、不计 outcome、不写日志
   *   2. schema 未就绪（读不到建表迁移的完成时刻 / 表不存在）⇒ `schema_not_ready`
   *   3. decision 缺失 ⇒ 抛 `decision_missing`（BLOCK_PARTITION，代码 wiring 缺陷）
   *   4. `forced_skip`
   *   5. `legacy_original_evidence_missing`（永久排除）
   *   6. `write` ⇒ 进入 cutover / evidence / stream / token / status / insert 判定
   *
   * ⇒ `schema 未就绪 + force + 目标 reason` 的唯一归因是 `schema_not_ready`；
   * `forced_skip` 只统计 **schema 已就绪**时真正因 force 被排除的事件。
   */
  private async writeProvisionalExposure(
    tx: Prisma.TransactionClient,
    requestId: string,
    reason: string | undefined,
    decision: ProvisionalExposureDecision | undefined,
    /** 事务外解析好的边界。undefined/null 一律视为未就绪。 */
    cutoverAt: Date | null | undefined,
  ): Promise<ProvisionalExposureOutcome | null> {
    // 1) 非目标 reason：精确等值，绝不前缀匹配。
    if (reason !== PROVISIONAL_EXPOSURE_TARGET_REASON) return null;

    // 2) schema 是否就绪。
    //
    // 边界来自「建 exposure 表那次迁移的完成时刻」，由调用方在**事务外**解析后传进来。
    // 读不到（表还没建 / 无权限 / provider 未注入）⇒ **fail-closed**：什么都不写。
    // 这里不再有 ENABLED 开关 —— 一次性翻转的环境变量是纯运维负担，杀手开关用回滚镜像。
    //
    // ⚠️ 这一步必须排在**所有**证据读取与不变量断言之前：未就绪时一行都不写，也就不该为
    // 任何数据异常抛错 —— 否则就是「不记账却全担风险」（f543aaa 修过一次的 P0）。
    if (!cutoverAt) return 'schema_not_ready';

    // 3) decision 缺失 = 代码 wiring 缺陷。静默跳过会导致连续永久漏记。
    if (!decision) {
      throw new GatewayProvisionalExposureInvariantError('decision_missing', {
        requestId,
        gatewayBillingEventId: await this.resolveGatewayBillingEventId(tx, requestId),
      });
    }
    // 4) / 5)
    if (decision.kind === 'forced_skip') return 'forced_skip';
    if (decision.kind === 'legacy_original_evidence_missing') {
      return 'legacy_original_evidence_missing';
    }

    // 6) write
    const ctx = {
      requestId,
      gatewayBillingEventId: decision.gatewayBillingEventId,
    };
    const bad = (code: ProvisionalExposureInvariantCode, detail?: string) =>
      new GatewayProvisionalExposureInvariantError(code, { ...ctx, detail });

    // ⚠️ cutover 的第一道短路用**收件期已冻结**的 observedAt（评审 P1）：
    // 否则 T 之前的事件仍要先过 source_evidence_missing / revision_not_one 两条断言，
    // 任一不满足就抛 ⇒ BLOCK_PARTITION 或把一笔正常结算投进 DLQ，
    // 也就是「按定义不在范围内、不记任何东西，却承担全部风险」。
    // 下面读回证据后还有一次同样的判定，作为纵深防御（紧随其后的断言要求两者相等）。
    if (decision.originalEvidenceObservedAt.getTime() < cutoverAt.getTime()) {
      return 'pre_cutover';
    }

    const ev = await tx.gatewayUsageEvidence.findUnique({
      where: {
        gatewayBillingEventId_evidenceHash: {
          gatewayBillingEventId: decision.gatewayBillingEventId,
          evidenceHash: decision.evidenceHash,
        },
      },
      select: {
        id: true,
        gatewayBillingEventId: true,
        eventId: true,
        requestId: true,
        source: true,
        evidenceHash: true,
        evidenceRevision: true,
        observedAt: true,
        rawEvidence: true,
      },
    });
    if (!ev) throw bad('source_evidence_missing');
    if (ev.evidenceRevision !== 1) {
      throw bad('source_evidence_revision_not_one', `revision=${ev.evidenceRevision}`);
    }
    // ⚠️ 这里**不再重复判一次 cutover**（评审 P2）：
    // 走到这一步意味着 decision.originalEvidenceObservedAt >= T，而紧随其后的断言又要求
    // ev.observedAt === decision.originalEvidenceObservedAt ⇒ 第二次判定要么不可达，
    // 要么恰好在「首收证据被改写」时命中，把这个漂移信号记成普通 pre_cutover 静默跳过。
    // 证据表有 append-only 触发器（20260806000106 迁移），改写本就要先禁用触发器 ——
    // 真发生了更该抛 mismatch，而不是被当成范围外事件。
    //
    // 原注释保留于此供追溯：cutover 必须尽早短路，只依赖「能判 T 的最小前提」。
    //
    // 判据唯一：rev1 且 observedAt >= T（含等号）。observedAt 是 billing **首次观察时间**，
    // 不是请求发生时间；因此本期的保证只能表述为「只处理 T 之后首次被 billing 观察到的证据」。

    if (ev.observedAt.getTime() !== decision.originalEvidenceObservedAt.getTime()) {
      // 收件时冻结的时间与 writer 读回不一致 ⇒ 两者之间有人改写了首收证据。
      throw bad('source_evidence_observed_at_mismatch');
    }
    if (!isJsonObject(ev.rawEvidence)) throw bad('source_evidence_raw_not_object');
    const raw = ev.rawEvidence;
    // 选了字段就必须断言 —— 七项绑定比较。
    if (
      ev.gatewayBillingEventId !== decision.gatewayBillingEventId
      || ev.requestId !== requestId
      || ev.evidenceHash !== decision.evidenceHash
      || canonicalSha256(raw) !== ev.evidenceHash
      || stringValue(raw.request_id) !== requestId
      || ev.source !== 'GATEWAY_USAGE_EVENT'
      || ev.eventId !== stringValue(raw.event_id)
    ) {
      throw bad('source_evidence_binding_mismatch');
    }


    // is_stream 三态：absent ≠ false。缺失/非布尔都说明仍有旧 gateway 在产事件
    // （即上线协议里那个窗口没封住）⇒ 单独归因，便于告警。
    const isStream = raw.is_stream;
    if (typeof isStream !== 'boolean') return 'stream_field_absent_or_invalid';
    if (isStream) return 'stream_true';

    const httpStatus = strictNonNegativeInt(raw.status_code);
    if (httpStatus !== 504 && httpStatus !== 499) return 'unsupported_status';
    const exposureKind = httpStatus === 504 ? 'platform_timeout' : 'client_cancellation';

    // 量纲：必须取收窄后的 raw，**禁止**取 opts.input —— 保护性归零已把它清零。
    const tokens = this.extractTokens(raw);
    const outputTokens = tokens.outputTokens;
    if (!outputTokens) return 'zero_output';
    // extractTokens 内部用 nonNegativeInt()，它接受字符串、截断小数、**不检查安全整数**。
    // 不安全的正值不写 —— 静默截断会写出错误的敞口。
    //
    // ⚠️ 这里**不抛**（评审 P2，本轮从 invariant 降级）：原实现抛
    // output_tokens_not_safe_integer ⇒ QUARANTINE_AND_DLQ ⇒ 一个畸形的 completion_tokens
    // 就能把一笔**已成功、已 0 计费落地**的结算改成 QUARANTINED 并把消息投进 DLQ。
    // 原则是：旁路观测不该有能力改主路径终态。降级为归因后行为与 zero_output 同构 ——
    // 不写这一行、记一格计数、主路径完全不受影响。
    if (!Number.isSafeInteger(outputTokens)) {
      this.logger.warn({
        event: 'gateway_provisional_exposure_output_tokens_unrepresentable',
        request_id: requestId,
        gateway_billing_event_id: decision.gatewayBillingEventId,
        output_tokens: String(outputTokens),
      });
      return 'output_tokens_unrepresentable';
    }

    const payload = {
      gatewayBillingEventId: decision.gatewayBillingEventId,
      sourceEvidenceId: ev.id,
      sourceEvidenceRevision: 1,
      exposureKind,
      sourceReason: PROVISIONAL_EXPOSURE_TARGET_REASON,
      httpStatus,
      outputTokens: BigInt(outputTokens),
      // 本期恒 NULL：实测该族 input 全为 0，是 UNKNOWN 被编码成 0，
      // 绝不写 0 冒充「确实为 0」。
      inputTokens: null,
      tokenSource: stringValue(raw.token_source) ?? null,
      amountUsd: null,
      amountStatus: 'unpriced',
    };

    // ⚠️ 不能用 create + 捕获唯一冲突：unique violation 会让当前事务进入 aborted 状态，
    // 同一 interactive transaction 里后续查询直接得到 25P02，比对无从进行。
    const created = await tx.gatewayUsageProvisionalExposure.createMany({
      data: [payload],
      skipDuplicates: true,
    });
    // **无条件**读回：skipDuplicates 本身会吞掉内容冲突，读回断言把它补回来。
    const existing = await tx.gatewayUsageProvisionalExposure.findUnique({
      where: { gatewayBillingEventId: payload.gatewayBillingEventId },
    });
    if (!existing) throw bad('exposure_missing_after_insert');
    if (!provisionalExposureRowMatches(existing, payload)) {
      throw bad('existing_exposure_content_conflict');
    }
    return created.count === 1 ? 'inserted' : 'idempotent_consistent';
  }

  /** decision 缺失场景也必须给出 event id：父表有 UNIQUE(request_id)，按它查即可。 */
  private async resolveGatewayBillingEventId(
    tx: Prisma.TransactionClient,
    requestId: string,
  ): Promise<string> {
    const row = await tx.gatewayBillingEvent.findUnique({
      where: { requestId },
      select: { id: true },
    });
    return row?.id ?? '';
  }

  private async settleProvisionalExposureInvariant(
    err: GatewayProvisionalExposureInvariantError,
    ctx: {
      root: JsonObject;
      requestId: string;
      received: ReceivedEvidence;
      deductInput: UsageDeductInput | undefined;
      hasFinancialReceipt: boolean;
      committedBilling: Record<string, unknown> | undefined;
      committedFundingOutcome: string | undefined;
      actorId?: string;
      reconciliationAction?: AtomicGatewayReconciliationAction;
    },
  ): Promise<GatewayProvisionalExposureInvariantError> {
    const { requestId, received } = ctx;
    if (!ctx.hasFinancialReceipt) {
      // 路径二：无 TokenUsage / 永久 receipt ⇒ **任何 code 一律降级为 block**，
      // 无论其默认 disposition。quarantine 的前提是钱已确定落地；这里钱还没落地，
      // DLQ + commit 会同时丢掉敞口与结算。
      //
      // ⚠️ 若这一步状态持久化本身失败，抛出的是普通 DB error（而不是 invariant）
      // ⇒ consumer 按 transient 处理、**不得** DLQ。这正是不 catch 的原因。
      await this.recordFinalState(
        ctx.root,
        requestId,
        received.revision,
        'RETRYABLE_FAILED',
        {
          input: ctx.deductInput,
          reason: err.parentReason,
          errorMessage: err.message,
          // evidenceVerdict 故意不给：此刻并未确立任何证据结论，让它取默认 UNKNOWN。
          reconciliationStatus: 'RETRY_WAIT',
          // 保住父 pending 字段与仍然 active 的首次资金 guard。
          // ⚠️ 不用 pendingFundingState（会**重建**状态并可能创建 retry restriction）。
          preserveInitialFundingGuard: true,
          actorId: ctx.actorId,
          reconciliationAction: ctx.reconciliationAction,
        },
      );
      return err.withDisposition('BLOCK_PARTITION');
    }

    // 路径一：钱已确定落地 ⇒ 收窄为单条记录的人工复核，让 partition 得以继续。
    await this.recordFinalState(
      ctx.root,
      requestId,
      received.revision,
      'QUARANTINED',
      {
        input: ctx.deductInput,
        reason: err.parentReason,
        errorMessage: err.message,
        // 必须带上已提交的结算结果，否则一笔钱已落地的事件在库里会像没结算过。
        billing: ctx.committedBilling,
        fundingOutcome: ctx.committedFundingOutcome,
        evidenceVerdict: 'INCOMPLETE',
        reconciliationStatus: 'MANUAL_REVIEW',
        releaseRetryRestriction: received.existingStatus === 'RETRYABLE_FAILED',
        actorId: ctx.actorId,
        reconciliationAction: ctx.reconciliationAction,
      },
    );
    // 状态提交后**强制**同步投影：否则已释放的 retry restriction 可能只在库里释放、
    // Publisher 侧仍冻结着客户，而 consumer 已经 DLQ + commit、不会再回来。
    // ⚠️ 这里失败按**普通 transient** 处理（错误照原样抛出，不是 invariant）⇒ 不 DLQ。
    await this.syncEventRestriction(requestId, true);
    return err.withDisposition('QUARANTINE_AND_DLQ');
  }

  private recordFinalState(
    event: JsonObject,
    requestId: string,
    expectedRevision: number,
    status: 'DEDUCTED' | 'SKIPPED' | 'FAILED' | 'RETRYABLE_FAILED' | 'QUARANTINED' | 'DEBT_OPEN',
    opts: RecordFinalStateOptions = {},
  ): Promise<number> {
    return timed('recordFinalState', () =>
      this.recordFinalStateInner(event, requestId, expectedRevision, status, opts),
    );
  }

  private async recordFinalStateInner(
    event: JsonObject,
    requestId: string,
    expectedRevision: number,
    status: 'DEDUCTED' | 'SKIPPED' | 'FAILED' | 'RETRYABLE_FAILED' | 'QUARANTINED' | 'DEBT_OPEN',
    opts: RecordFinalStateOptions = {},
  ): Promise<number> {
    const nextRevision = expectedRevision + 1;
    const settlement = this.settlementSnapshot(event, opts.input, opts.billing);
    // ⚠️ 计数与日志必须在事务**成功返回之后**：若在事务内计数，事务因后续副作用回滚时
    // counter 会记下一个**并不存在**的结果。invariant_error 例外 —— 它本就代表这次没提交。
    let provisionalExposureOutcome: ProvisionalExposureOutcome | null = null;
    await this.prisma.$transaction(async (tx) => {
      if (opts.noChargeProof) {
        const selectedEvidence = await tx.gatewayUsageEvidence.findUnique({
          where: {
            gatewayBillingEventId_evidenceHash: {
              gatewayBillingEventId: opts.noChargeProof.gatewayBillingEventId,
              evidenceHash: opts.noChargeProof.evidenceHash,
            },
          },
          select: {
            gatewayBillingEventId: true,
            requestId: true,
            source: true,
            evidenceHash: true,
            rawEvidence: true,
          },
        });
        const selectedRawEvidence = selectedEvidence && isJsonObject(selectedEvidence.rawEvidence)
          ? selectedEvidence.rawEvidence
          : null;
        if (
          !selectedEvidence
          || selectedEvidence.gatewayBillingEventId
            !== opts.noChargeProof.gatewayBillingEventId
          || selectedEvidence.requestId !== requestId
          || selectedEvidence.source !== 'GATEWAY_USAGE_EVENT'
          || selectedEvidence.evidenceHash !== opts.noChargeProof.evidenceHash
          || !selectedRawEvidence
          || stringValue(selectedRawEvidence.request_id) !== requestId
          || canonicalSha256(selectedRawEvidence) !== opts.noChargeProof.evidenceHash
          || this.resolvePermanentNoChargeReason(selectedRawEvidence) !== opts.reason
        ) {
          throw new GatewaySettlementAnchorConflictError(
            'Gateway NO_CHARGE 证据未精确绑定所选不可变 raw evidence',
          );
        }
      }
      const changed = await tx.gatewayBillingEvent.updateMany({
        where: { requestId, revision: expectedRevision },
        data: {
          status,
          reason: opts.reason ?? null,
          errorMessage: opts.errorMessage ?? null,
          billingResult: opts.billing
            ? toInputJson(opts.billing)
            : Prisma.DbNull,
          evidenceVerdict: opts.evidenceVerdict ?? (
            status === 'DEDUCTED' || status === 'DEBT_OPEN'
              ? 'SETTLEABLE_BY_POLICY'
              : 'UNKNOWN'
          ),
          reconciliationStatus: opts.reconciliationStatus ?? (
            status === 'RETRYABLE_FAILED' ? 'RETRY_WAIT' : 'CLOSED'
          ),
          fundingOutcome: opts.noChargeProof
            ? 'NO_CHARGE'
            : opts.fundingOutcome ?? null,
          ...(opts.pendingFundingState
            ? {
                apiKeyId: opts.pendingFundingState.apiKeyId,
                userId: opts.pendingFundingState.userId,
                tenantId: opts.pendingFundingState.tenantId,
                billingAccountId: opts.pendingFundingState.billingAccountId,
                productId: opts.pendingFundingState.productId,
                productSlug: opts.pendingFundingState.productSlug,
                billingUnit: 'BALANCE',
                pendingExposureUsd: opts.pendingFundingState.amountUsd,
                pendingHoldUsd: opts.pendingFundingState.amountUsd,
              }
            : {
                billingAccountId: settlement.billingAccountId,
                subjectSnapshot: settlement.subjectSnapshot,
                pricingSnapshot: settlement.pricingSnapshot,
                // preserveInitialFundingGuard 时**完全不写**这两列，让既有 guard 原样留存；
                // 写 0 等于释放首次资金 guard。
                ...(opts.preserveInitialFundingGuard
                  ? {}
                  : {
                      pendingExposureUsd: opts.pendingExposureUsd ?? new Prisma.Decimal(0),
                      pendingHoldUsd: new Prisma.Decimal(0),
                    }),
                billingUnit: settlement.billingUnit,
              }),
          processedAt: new Date(),
          revision: { increment: 1 },
          // Parent receipt columns were frozen by recordReceived(). Selected
          // correction evidence belongs in the append-only evidence/action/
          // receipt rows and must never rewrite the original raw receipt.
        },
      });
      if (changed.count !== 1) throw new GatewayBillingRevisionConflictError(
        'Gateway billing event 状态已变化',
      );
      try {
        provisionalExposureOutcome = await this.writeProvisionalExposure(
          tx,
          requestId,
          opts.reason,
          opts.provisionalExposureDecision,
          opts.provisionalExposureBoundary,
        );
      } catch (rawExposureErr) {
        // ⚠️ 归类必须发生在**这个边界**上：外层只认 GatewayProvisionalExposureInvariantError，
        // 普通 Prisma 异常会一路抛到 consumer 的 transient 分支（offset 不提交）⇒ 持久性
        // 失败会让该分区所有租户的计费永久停摆。一张「绝不参与余额」的旁路观测表
        // 不允许有这种能力。
        //
        // 不在事务内重试的原因：PG 里一条语句报错即事务 aborted，后续只会得到 25P02。
        const exposureErr = rawExposureErr instanceof
          GatewayProvisionalExposureInvariantError
          ? rawExposureErr
          : new GatewayProvisionalExposureInvariantError(
              'writer_persistence_failed',
              {
                requestId,
                // forced_skip 分支没有这个字段，但它在 writer 第一步就已 return，
                // 走不到写入失败；这里只是让类型收窄闭合，不代表可达。
                gatewayBillingEventId:
                  opts.provisionalExposureDecision
                  && opts.provisionalExposureDecision.kind !== 'forced_skip'
                    ? opts.provisionalExposureDecision.gatewayBillingEventId
                    : '',
                detail: rawExposureErr instanceof Error
                  ? rawExposureErr.message
                  : String(rawExposureErr),
              },
            );
        if (exposureErr !== rawExposureErr) {
          // 保留原始堆栈：包装的目的是改变**处置**，不是掩盖来源。
          exposureErr.cause = rawExposureErr;
          billingProvisionalExposureOutcomeTotal.labels('persistence_failed').inc();
          this.logger.error({
            event: 'gateway_provisional_exposure_outcome',
            outcome: 'persistence_failed',
            request_id: requestId,
            gateway_billing_event_id: exposureErr.context.gatewayBillingEventId,
            invariant_code: exposureErr.code,
            disposition: exposureErr.disposition,
            detail: exposureErr.context.detail,
          });
        }
        if (exposureErr === rawExposureErr) {
          // 抛错即回滚本事务；这一次确实没提交，所以可以就地计数。
          billingProvisionalExposureOutcomeTotal.labels('invariant_error').inc();
          // 传对象而非 JSON 字符串：只有对象才会让字段落到 pino 记录的根上（评审 P1）。
          this.logger.error({
            event: 'gateway_provisional_exposure_outcome',
            outcome: 'invariant_error',
            request_id: requestId,
            gateway_billing_event_id: exposureErr.context.gatewayBillingEventId,
            invariant_code: exposureErr.code,
            disposition: exposureErr.disposition,
          });
        }
        throw exposureErr;
      }
      if (opts.noChargeProof) {
        if (
          status !== 'SKIPPED'
          || !opts.reason?.trim()
          || !PERMANENT_NO_CHARGE_REASONS.has(opts.reason)
          || opts.noChargeProof.anchor.billingUnit !== 'BALANCE'
          || !opts.noChargeProof.anchor.billingCurrency
        ) {
          throw new GatewaySettlementAnchorConflictError(
            'Gateway NO_CHARGE 永久证明参数无效',
          );
        }
        const noChargeProof = {
          protocol: 'gateway-no-charge-v1',
          requestId,
          gatewayBillingEventId: opts.noChargeProof.gatewayBillingEventId,
          settlementRevision: nextRevision,
          evidenceHash: opts.noChargeProof.evidenceHash,
          anchorHash: opts.noChargeProof.anchor.anchorHash,
          pricingHash: opts.noChargeProof.anchor.pricingHash,
          billingUnit: 'BALANCE',
          billingCurrency: opts.noChargeProof.anchor.billingCurrency,
          reason: opts.reason,
          fundingOutcome: 'NO_CHARGE',
          customerDeductionUsd: '0',
          amountUsd: '0.000000000000',
        };
        const noChargeFingerprint = canonicalSha256(noChargeProof);
        await tx.gatewayUsageSettlementReceipt.create({
          data: {
            gatewayBillingEventId: opts.noChargeProof.gatewayBillingEventId,
            requestId,
            settlementRevision: nextRevision,
            fundingOutcome: 'NO_CHARGE',
            evidenceHash: opts.noChargeProof.evidenceHash,
            anchorHash: opts.noChargeProof.anchor.anchorHash,
            pricingHash: opts.noChargeProof.anchor.pricingHash,
            settlementFingerprint: noChargeFingerprint,
            billingUnit: 'BALANCE',
            billingCurrency: opts.noChargeProof.anchor.billingCurrency,
            amountUsd: new Prisma.Decimal(0),
            reason: opts.reason,
            policyVersion: 'gateway-no-charge-v1',
            idempotencyKey:
              `gateway:no-charge:${requestId}:${opts.noChargeProof.anchor.anchorHash}`,
            payload: {
              ...noChargeProof,
              settlementFingerprint: noChargeFingerprint,
            },
          },
        });
      }
      if (opts.createDebtRestriction) {
        const current = await tx.gatewayBillingEvent.findUniqueOrThrow({
          where: { requestId },
          select: { id: true, billingAccountId: true, apiKeyId: true },
        });
        const target = current.billingAccountId
          ? { billingAccountId: current.billingAccountId, apiKeyId: undefined }
          : current.apiKeyId
            ? { billingAccountId: undefined, apiKeyId: current.apiKeyId }
            : null;
        if (!target) throw new Error('Debt settlement missing fail-closed subject');
        await tx.billingAccessRestriction.upsert({
          where: { idempotencyKey: `gateway:debt:${requestId}` },
          create: {
            gatewayBillingEventId: current.id,
            ...target,
            reason: 'debt_open',
            idempotencyKey: `gateway:debt:${requestId}`,
            createdBy: 'SYSTEM',
          },
          update: {},
        });
      }
      if (opts.restrictionReason) {
        const current = await tx.gatewayBillingEvent.findUniqueOrThrow({
          where: { requestId },
          select: { id: true, billingAccountId: true, apiKeyId: true },
        });
        const target = this.restrictionSubjectOf(current);
        if (!target) {
          throw new Error('Settlement review/retry missing fail-closed subject');
        }
        // 幂等键按**主体**而不是按事件（2026-09-07 国内 prod：单个 Key 52 分钟堆了 9,622 行
        // ACTIVE，每行 INSERT 都触发一条投影 intent，把 Key 投影重发也带崩）。
        // 主体级之后单 Key 恒定 1 行，语义也更准 —— 拦的是"这个主体待复核"，不是"这条请求待复核"。
        const idempotencyKey = this.restrictionSubjectKey(opts.restrictionReason, target);
        // 这里**不再**有「RELEASED → ACTIVE」的再武装分支：那条在库层跑不通，
        // 而且从未成功执行过（2026-09-20 国内 prod 实查：status=ACTIVE 且带 released_at 的 0 行）。
        //   - 守卫 enforce_billing_access_restriction_lifecycle 是 BEFORE UPDATE OF status，
        //     只允许 ACTIVE→RELEASED，反向直接 RAISE 23514；而本函数的调用点在
        //     recordFinalState 里，异常会被 :1389 原样 rethrow ⇒ 结算硬失败、消息重试进 DLQ。
        //   - billing_restriction_projection_intents 的 (restriction_id, restriction_status)
        //     唯一键也让同一行无法二次入队 ACTIVE intent ⇒ 就算放开守卫，再武装也投影不出去。
        // 生命周期因此是**一行一次**：释放即终态并由
        // releaseRestrictionsFreeingSubjectKey 把主体键改名腾出来，下次出问题新建一行。
        // 已 ACTIVE 的行仍走 update:{}，status 不进 SET 列表 —— 表上的触发器是
        // AFTER INSERT OR UPDATE OF status，而 PG 的 `UPDATE OF` 只看列**是否被提及**、
        // 不看值有没有变，把 status 无条件写一遍就等于每个事件重发一次投影。
        await tx.billingAccessRestriction.upsert({
          where: { idempotencyKey },
          create: {
            gatewayBillingEventId: current.id,
            ...target,
            reason: opts.restrictionReason,
            idempotencyKey,
            createdBy: 'SYSTEM',
          },
          update: {},
        });
      }
      if (opts.releaseRetryRestriction) {
        const current = await tx.gatewayBillingEvent.findUniqueOrThrow({
          where: { requestId },
          select: { id: true, billingAccountId: true, apiKeyId: true },
        });
        await this.releaseSubjectRestrictionWhenDrained(
          tx,
          requestId,
          current,
          'settlement_retry_pending',
          opts.actorId,
          'settlement_retry_resolved',
        );
      }
      if (opts.releaseReconciliationRestrictions) {
        const current = await tx.gatewayBillingEvent.findUniqueOrThrow({
          where: { requestId },
          select: { id: true, billingAccountId: true, apiKeyId: true },
        });
        // 按事件绑定的那几类保持原样：pending_usage_unreserved 是 publisher 认的
        // **单请求精确资金预占**，pending_usage_exposure_limit / evidence_conflict 也都
        // 一事一行，改成主体级会破坏它们的语义。
        await tx.billingAccessRestriction.updateMany({
          where: {
            gatewayBillingEventId: current.id,
            status: 'ACTIVE',
            reason: {
              in: [
                'pending_usage_unreserved',
                'pending_usage_exposure_limit',
                'evidence_conflict',
              ],
            },
          },
          data: {
            status: 'RELEASED',
            releasedAt: new Date(),
            releasedBy: opts.actorId?.trim() || 'SYSTEM',
            releaseReason: 'authoritative_evidence_settled',
          },
        });
        // settlement_policy_review 现在是主体级的一行，只有该主体**再没有待复核事件**
        // 才能放行 —— 否则收口第一条就把整个主体解封，其余几千条还挂着没人管。
        await this.releaseSubjectRestrictionWhenDrained(
          tx,
          requestId,
          current,
          'settlement_policy_review',
          opts.actorId,
          'authoritative_evidence_settled',
        );
      }
      if (opts.reconciliationAction) {
        const current = await tx.gatewayBillingEvent.findUniqueOrThrow({
          where: { requestId },
          select: { id: true },
        });
        await tx.gatewayUsageReconciliationAction.create({
          data: {
            gatewayBillingEventId: current.id,
            requestId,
            action: opts.reconciliationAction.action,
            expectedRevision: opts.reconciliationAction.command.expectedRevision,
            resultingRevision: nextRevision,
            reason: opts.reconciliationAction.command.reason.trim(),
            actorId: opts.reconciliationAction.command.actorId.trim(),
            idempotencyKey: opts.reconciliationAction.command.idempotencyKey.trim(),
            metadata: {
              terminalStatus: status,
              reason: opts.reason ?? null,
              reconciliationStatus: opts.reconciliationStatus ?? (
                status === 'RETRYABLE_FAILED' ? 'RETRY_WAIT' : 'CLOSED'
              ),
              fundingOutcome: opts.fundingOutcome ?? null,
              evidenceHash: canonicalSha256(event),
            },
          },
        });
      }
      if (opts.reason !== 'funding_reservation_queue_pending') {
        await this.releaseInitialFundingGuardInTransaction(
          tx,
          requestId,
          opts.actorId?.trim() || 'SYSTEM',
          `gateway_state_committed:${status.toLowerCase()}`,
        );
      }
    });
    if (provisionalExposureOutcome) {
      billingProvisionalExposureOutcomeTotal.labels(provisionalExposureOutcome).inc();
      // ⚠️ 必须是**结构化对象**，不能是 JSON.stringify 的字符串：nestjs-pino 只在
      // `typeof message === 'object'` 时把字段并到记录的**根**上；传字符串则整段落进 `msg`，
      // 排查查询 `grep '"outcome":...'` 虽然仍能全文命中，但按字段过滤失效（评审 P1）。
      const line = {
        event: 'gateway_provisional_exposure_outcome',
        outcome: provisionalExposureOutcome,
        request_id: requestId,
        gateway_billing_event_id:
          opts.provisionalExposureDecision
          && 'gatewayBillingEventId' in opts.provisionalExposureDecision
            ? opts.provisionalExposureDecision.gatewayBillingEventId
            : undefined,
      };
      // 级别：旧 gateway 仍在产事件、或持久配置丢了，都需要人看到。
      if (
        provisionalExposureOutcome === 'stream_field_absent_or_invalid'
        || provisionalExposureOutcome === 'schema_not_ready'
      ) {
        this.logger.warn(line);
      } else {
        this.logger.log(line);
      }
    }
    return nextRevision;
  }

  private pendingBalanceFundingState(
    anchor: GatewaySettlementAnchor | null,
  ): PendingBalanceFundingState | undefined {
    if (!anchor || anchor.billingUnit !== 'BALANCE') return undefined;
    if (anchor.customerQuoteSnapshot.unit !== 'BALANCE') {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway BALANCE anchor quote unit is invalid',
      );
    }
    const amountUsd = new Prisma.Decimal(
      anchor.customerQuoteSnapshot.effectiveCostUsd,
    ).toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
    if (!amountUsd.isFinite() || amountUsd.isNegative()) {
      throw new GatewaySettlementAnchorConflictError(
        'Gateway BALANCE anchor amount is invalid',
      );
    }
    return {
      apiKeyId: anchor.apiKeyId,
      userId: anchor.userId,
      tenantId: anchor.tenantId,
      billingAccountId: anchor.billingAccountId,
      productId: anchor.productId,
      productSlug: anchor.productSlug,
      amountUsd,
    };
  }

  private async recordDebtOpen(
    event: JsonObject,
    requestId: string,
    expectedRevision: number,
    input: UsageDeductInput,
    billing: Record<string, unknown>,
    reason: 'insufficient_balance' | 'insufficient_credits',
    actorId?: string,
    releaseRetryRestriction = false,
    reconciliationAction?: AtomicGatewayReconciliationAction,
    releaseReconciliationRestrictions = false,
    evidenceVerdict = 'SETTLEABLE_BY_POLICY',
    reconciliationStatus = 'CLOSED',
  ): Promise<number> {
    const amountUsd = this.settlementAmountUsd(billing);
    return this.recordFinalState(event, requestId, expectedRevision, 'DEBT_OPEN', {
      input,
      reason,
      billing,
      evidenceVerdict,
      reconciliationStatus,
      fundingOutcome: 'DEBT_OPEN',
      pendingExposureUsd: amountUsd,
      actorId,
      createDebtRestriction: true,
      releaseRetryRestriction,
      reconciliationAction,
      releaseReconciliationRestrictions,
    });
  }

  private settlementSnapshot(
    event: JsonObject,
    input?: UsageDeductInput,
    billing?: Record<string, unknown>,
  ) {
    const quote = billing && isJsonObject(billing.quote) ? billing.quote : null;
    const billingAccountId = quote ? stringValue(quote.billingAccountId) : undefined;
    const billingUnit = quote
      ? stringValue(quote.unit) ?? input?.billingUnit ?? null
      : input?.billingUnit ?? null;
    const subjectSnapshot = {
      apiKeyId: input?.apiKeyId ?? null,
      tenantId: input?.tenantId ?? null,
      billingAccountId: billingAccountId ?? null,
      userId: input?.userId ?? null,
      productId: input?.productId ?? null,
      productSlug: input?.productSlug ?? null,
      modelName: input?.modelName ?? this.resolveModelName(event) ?? null,
      gatewayCustomerSettlement: input?.gatewayCustomerSettlement ?? null,
      billingUnit: quote ? stringValue(quote.unit) ?? input?.billingUnit ?? null : input?.billingUnit ?? null,
      occurredAt: input?.eventOccurredAt
        ? gatewayEventTimeValue(input.eventOccurredAt)?.toISOString() ?? null
        : this.resolveEventOccurredAt(event)?.toISOString() ?? null,
    };
    return {
      billingAccountId,
      billingUnit,
      subjectSnapshot: toInputJson(subjectSnapshot),
      pricingSnapshot: quote ? toInputJson(quote) : Prisma.DbNull,
      amountUsd: this.settlementAmountUsd(billing),
      tokenUsageId: firstNonEmpty([
        billing ? stringValue(billing.tokenUsageId) : undefined,
        billing ? stringValue(billing.usageId) : undefined,
      ]),
    };
  }

  private settlementAmountUsd(billing?: Record<string, unknown>): Prisma.Decimal {
    if (!billing) return new Prisma.Decimal(0);
    const quote = isJsonObject(billing.quote) ? billing.quote : {};
    const direct = firstDecimal([
      quote.effectiveCostUsd,
      quote.costUsd,
      billing.amountUsd,
      billing.costUsd,
      billing.chargedUsd,
      // CREDITS debt computes this from the current request. BALANCE debt uses
      // it only as a final fallback because BillingService reports cumulative
      // account exposure after the transaction.
      billing.debtExposureUsd,
    ]);
    if (direct) return direct;
    const cents = nonNegativeInt(quote.amountCents) || nonNegativeInt(billing.amountCents);
    return new Prisma.Decimal(cents).div(100);
  }

  private resolveFundingOutcome(billing: Record<string, unknown>): string {
    const quote = isJsonObject(billing.quote) ? billing.quote : {};
    if (billing.debtOpen === true || stringValue(billing.fundingOutcome) === 'DEBT_OPEN') {
      return 'DEBT_OPEN';
    }
    if (stringValue(billing.fundingOutcome) === 'RECEIVABLE') return 'RECEIVABLE';
    if (stringValue(billing.fundingOutcome) === 'INCLUDED' || quote.unit === 'CREDITS') {
      return 'INCLUDED';
    }
    return quote.includedUpstream === true ? 'INCLUDED' : 'COLLECTED';
  }

  private async ensureDebtRestriction(
    requestId: string,
    requirePublisherSync = false,
  ): Promise<void> {
    const event = await this.prisma.gatewayBillingEvent.findUnique({
      where: { requestId },
      select: { id: true, apiKeyId: true, billingAccountId: true },
    });
    if (!event) {
      if (requirePublisherSync) throw new Error('Debt settlement event is missing');
      return;
    }
    const target = event.billingAccountId
      ? { billingAccountId: event.billingAccountId, apiKeyId: undefined }
      : event.apiKeyId
        ? { billingAccountId: undefined, apiKeyId: event.apiKeyId }
        : null;
    if (!target) {
      if (requirePublisherSync) throw new Error('Debt settlement missing fail-closed subject');
      return;
    }
    await this.prisma.billingAccessRestriction.upsert({
      where: { idempotencyKey: `gateway:debt:${requestId}` },
      create: {
        gatewayBillingEventId: event.id,
        ...target,
        reason: 'debt_open',
        idempotencyKey: `gateway:debt:${requestId}`,
        createdBy: 'SYSTEM',
      },
      update: {},
    });
    await this.syncRestrictionTarget(
      target.billingAccountId,
      target.apiKeyId,
      requirePublisherSync,
    );
  }

  private syncEventRestriction(
    requestId: string,
    required: boolean,
  ): Promise<void> {
    // 21 call sites in process(); the wrapper reports call count as well as
    // total time, which is the point — a cheap call made many times per message
    // looks identical to a slow one from the outside.
    return timed('syncEventRestriction', () =>
      this.syncEventRestrictionInner(requestId, required),
    );
  }

  private async syncEventRestrictionInner(
    requestId: string,
    required: boolean,
  ): Promise<void> {
    const event = await this.prisma.gatewayBillingEvent.findUnique({
      where: { requestId },
      select: { billingAccountId: true, apiKeyId: true },
    });
    if (!event) return;
    await this.syncRestrictionTarget(
      event.billingAccountId ?? undefined,
      event.apiKeyId ?? undefined,
      required,
    );
  }

  /**
   * 事件的 fail-closed 主体：优先账户、其次 Key —— 与 debt_open / exposure_limit 行的既有
   * 口径一致。settlement anchor 没形成时事件上还没有 billingAccountId，只能落到 Key 上
   * （这正是 2026-09-07 那批行 billing_account_id 全为 NULL 的原因）。
   */
  private restrictionSubjectOf(event: {
    billingAccountId: string | null;
    apiKeyId: string | null;
  }): { billingAccountId?: string; apiKeyId?: string } | null {
    if (event.billingAccountId) return { billingAccountId: event.billingAccountId };
    if (event.apiKeyId) return { apiKeyId: event.apiKeyId };
    return null;
  }

  private restrictionSubjectKey(
    reason: 'settlement_policy_review' | 'settlement_retry_pending',
    subject: { billingAccountId?: string; apiKeyId?: string },
  ): string {
    return subject.billingAccountId
      ? `gateway:${reason}:account:${subject.billingAccountId}`
      : `gateway:${reason}:key:${subject.apiKeyId}`;
  }

  /**
   * 主体级限制行的释放：先收口存量的按事件行，再看该主体是否**已无同类待收口事件**。
   *
   * 判据只算该 reason 自己的触发态：
   *   - settlement_policy_review ← QUARANTINED 且 reconciliationStatus 仍 OPEN/MANUAL_REVIEW
   *   - settlement_retry_pending ← RETRYABLE_FAILED 且 RETRY_WAIT
   * 刻意**不**用"该主体还有任何非终态事件"—— 繁忙 Key 永远有 RECEIVED/PROCESSING 在飞，
   * 那样会永不解封。
   *
   * 当前事件的新状态在本事务里已经写过（recordFinalState 的 updateMany 在调用点之前），
   * 所以它不会把自己算进 remaining。
   */
  /**
   * 冻结 RETRY_WAIT 事件的自愈收口(2026-09-22 上海 UAT 402 事故)。
   *
   * 根因链:结算失败路径泄漏的 ACTIVE funding reservation 卡在队头 ⇒ 该账户后续
   * funding 全部 QUEUE_PENDING ⇒ 事件冻在 RETRYABLE_FAILED/RETRY_WAIT(retry 没有
   * 驱动者:重投依赖消息重放,状态一旦落库就再没人碰它)⇒ 排空判据 remaining>0
   * 永不归零 ⇒ 账户级 settlement_retry_pending 限制永不释放 ⇒ 全端点 402 连坐。
   * (上海 UAT 实测:2 条事件冻结 39 天,连坐同租户新建 key。)
   *
   * 收口动作(单事务,幂等可重入):
   *   1. 条件 UPDATE 把事件置 FAILED/CLOSED —— 条件带 status=RETRYABLE_FAILED,
   *      并发/重入时 count=0 直接放弃,不会覆盖别人的状态;
   *   2. 复用 releaseSubjectRestrictionWhenDrained 释放限制 —— 它的第一步就是按
   *      requestId 的 legacy 精确键(存量行的形态),主体候选键也一并覆盖;
   *      释放后投影由表触发器入队、projection worker 投影到网关。
   *
   * funding reservation 的释放不在这里(billing.service 的正规入口自开事务);
   * 调用方(worker)按顺序先 release 再收口,两步各自幂等。
   */
  async recoverFrozenRetryWaitEvent(eventId: string): Promise<{
    recovered: boolean;
    requestId: string | null;
  }> {
    return this.prisma.$transaction(async (tx) => {
      const event = await tx.gatewayBillingEvent.findUnique({
        where: { id: eventId },
        select: {
          id: true,
          requestId: true,
          status: true,
          reconciliationStatus: true,
          billingAccountId: true,
          apiKeyId: true,
          errorMessage: true,
        },
      });
      if (!event || event.status !== 'RETRYABLE_FAILED') {
        return { recovered: false, requestId: event?.requestId ?? null };
      }
      const marker = ' | retry_wait_recovery_20260922: frozen RETRY_WAIT (funding queue head block), zero financial impact';
      const updated = await tx.gatewayBillingEvent.updateMany({
        where: { id: eventId, status: 'RETRYABLE_FAILED' },
        data: {
          status: 'FAILED',
          reconciliationStatus: 'CLOSED',
          errorMessage: (event.errorMessage ?? '').slice(0, 2000 - marker.length) + marker,
          updatedAt: new Date(),
        },
      });
      if (updated.count !== 1) {
        return { recovered: false, requestId: event.requestId };
      }
      await this.releaseSubjectRestrictionWhenDrained(
        tx,
        event.requestId,
        event,
        'settlement_retry_pending',
        undefined,
        'retry_wait_recovery_timeout',
      );
      return { recovered: true, requestId: event.requestId };
    }, { maxWait: 10_000, timeout: 60_000 });
  }

  private async releaseSubjectRestrictionWhenDrained(
    tx: Prisma.TransactionClient,
    requestId: string,
    event: { billingAccountId: string | null; apiKeyId: string | null },
    reason: 'settlement_policy_review' | 'settlement_retry_pending',
    actorId: string | undefined,
    releaseReason: string,
  ): Promise<void> {
    const released = {
      status: 'RELEASED',
      releasedAt: new Date(),
      releasedBy: actorId?.trim() || 'SYSTEM',
      releaseReason,
    };
    // 存量兼容：改主体级之前落的是按 requestId 的行（国内 prod 现存 9,622 行）。
    // 用**精确的旧幂等键**释放，不能用 gatewayBillingEventId —— 主体级行的
    // gatewayBillingEventId 指向首次触发事件，按它释放会在收口第一条时就误放整个主体。
    await tx.billingAccessRestriction.updateMany({
      where: { idempotencyKey: `gateway:${reason}:${requestId}`, status: 'ACTIVE' },
      data: released,
    });
    // 主体级：**不能**只按当前事件重算一次主体后释放。
    // restrictionSubjectOf 优先 billingAccountId，而建行发生在 RETRYABLE_FAILED —— 那一刻
    // 事件的 billingAccountId 往往还是 NULL（requiresRetryRestriction 只要 deductInput 就成立，
    // 不必带 pendingFundingState，所以没人把账户写上去）⇒ 落的是 `:key:<apiKeyId>` 行。
    // 等重试成功转 DEDUCTED，结算把 billingAccountId 写上了，这里再重算就变成
    // `:account:<ba>` 键，updateMany 静默匹配 0 行（无断言、无日志）⇒ 限制永久 ACTIVE。
    // 2026-09-10~09-20 国内 prod 70 条误封、37 个用户、最长 253 小时就是这么来的。
    // ⇒ 两个候选主体各自判排空、各自释放。
    const subjects: Array<{ billingAccountId?: string; apiKeyId?: string }> = [];
    if (event.billingAccountId) subjects.push({ billingAccountId: event.billingAccountId });
    if (event.apiKeyId) subjects.push({ apiKeyId: event.apiKeyId });
    if (!subjects.length) return;
    const pendingTrigger = reason === 'settlement_retry_pending'
      ? { status: 'RETRYABLE_FAILED', reconciliationStatus: 'RETRY_WAIT' }
      : { status: 'QUARANTINED', reconciliationStatus: { in: ['OPEN', 'MANUAL_REVIEW'] } };
    let allDrained = true;
    for (const subject of subjects) {
      const remaining = await tx.gatewayBillingEvent.count({
        where: { ...subject, ...pendingTrigger },
      });
      if (remaining > 0) {
        allDrained = false;
        continue;
      }
      await this.releaseRestrictionsFreeingSubjectKey(
        tx,
        { idempotencyKey: this.restrictionSubjectKey(reason, subject) },
        released,
      );
    }
    if (!allDrained) return;
    // 漂移哨兵：排空判据已满足，却还留着同主体的 ACTIVE 行 ⇒ 键的算法又漂了。
    // **只告警不抛** —— 这里在结算事务里，抛出去会让消息重试到
    // gateway.usage_events.dlq（用量漏记、token 数取不回来），比多留一条限制行更糟。
    const orphaned = await tx.billingAccessRestriction.count({
      where: { reason, status: 'ACTIVE', OR: subjects },
    });
    if (orphaned > 0) {
      this.logger.error(
        `restriction subject drift: ${orphaned} ACTIVE ${reason} row(s) survived a drained release`
        + ` requestId=${requestId}`
        + ` apiKeyId=${event.apiKeyId ?? '-'} billingAccountId=${event.billingAccountId ?? '-'}`,
      );
    }
  }

  /**
   * 释放限制行，并把它占着的主体幂等键改名腾出来。
   *
   * 为什么必须腾：建行侧走 `upsert({ where: { idempotencyKey } })`，如果 RELEASED 的行还占着
   * 主体键，同一主体第二次出问题会命中 `update: {}` 空更新 ⇒ 不建行 ⇒ **fail-open**。
   * 而「RELEASED → ACTIVE」这条路在库层被守卫拒（见建行处的注释），projection intents 的
   * (restriction_id, restriction_status) 唯一键也让同一行无法二次入队 ⇒ 只能一行一次。
   *
   * Prisma 的 updateMany 没法把列设成自身的函数，所以先读 id 再逐行 update。
   * 主体级限制单主体恒定 1 行（2026-09-07 的按事件堆行问题已修），量级可忽略。
   */
  private async releaseRestrictionsFreeingSubjectKey(
    tx: Prisma.TransactionClient,
    where: Prisma.BillingAccessRestrictionWhereInput,
    released: Prisma.BillingAccessRestrictionUpdateInput,
  ): Promise<number> {
    const rows = await tx.billingAccessRestriction.findMany({
      where: { ...where, status: 'ACTIVE' },
      select: { id: true, idempotencyKey: true },
    });
    for (const row of rows) {
      await tx.billingAccessRestriction.update({
        where: { id: row.id },
        data: { ...released, idempotencyKey: `${row.idempotencyKey}:released:${row.id}` },
      });
    }
    return rows.length;
  }

  private async releaseInitialFundingGuardInTransaction(
    tx: Prisma.TransactionClient,
    requestId: string,
    releasedBy: string,
    releaseReason: string,
  ): Promise<void> {
    const event = await tx.gatewayBillingEvent.findUnique({
      where: { requestId },
      select: {
        id: true,
        fundingReservation: { select: { id: true } },
      },
    });
    // A queue-pending or failed reservation has no durable funding fact yet;
    // its first-receipt provisional guard must survive the retryable state.
    // Publisher may admit around a structurally valid guard by subtracting its
    // frozen amount, but malformed/inconsistent rows still close the account.
    // For committed reservations this is a terminal/legacy repair path; the
    // reservation transaction normally released the guard atomically already.
    if (!event?.fundingReservation) return;
    await tx.billingAccessRestriction.updateMany({
      where: {
        gatewayBillingEventId: event.id,
        status: 'ACTIVE',
        reason: 'pending_usage_unreserved',
      },
      data: {
        status: 'RELEASED',
        releasedAt: new Date(),
        releasedBy,
        releaseReason,
      },
    });
  }

  private async releaseAbsorptionRestrictions(
    requestId: string,
    actorId: string,
  ): Promise<void> {
    const event = await this.prisma.gatewayBillingEvent.findUnique({
      where: { requestId },
      select: {
        id: true,
        status: true,
        billingAccountId: true,
        apiKeyId: true,
        fundingReservation: { select: { status: true } },
      },
    });
    if (!event || event.status !== 'ABSORBED') return;
    if (event.fundingReservation && event.fundingReservation.status !== 'RELEASED') {
      throw new Error('Absorbed Gateway usage funding reservation is not released');
    }
    // 按事件绑定的那几类照旧按 event id 释放。
    await this.prisma.billingAccessRestriction.updateMany({
      where: {
        gatewayBillingEventId: event.id,
        status: 'ACTIVE',
        reason: {
          in: [
            'pending_usage_unreserved',
            'pending_usage_exposure_limit',
            'evidence_conflict',
          ],
        },
      },
      data: {
        status: 'RELEASED',
        releasedAt: new Date(),
        releasedBy: actorId.trim(),
        releaseReason: 'financial_absorption_closed_reconciliation',
      },
    });
    // settlement_policy_review 是主体级的一行，**不能**按 event id 放：那一行的
    // gatewayBillingEventId 只是首次触发事件，按它释放会在吸收掉其中一条时就解封整个主体，
    // 而该主体名下可能还有几千条待复核。走同一个 drained 判定。
    await this.releaseSubjectRestrictionWhenDrained(
      this.prisma,
      requestId,
      event,
      'settlement_policy_review',
      actorId,
      'financial_absorption_closed_reconciliation',
    );
    // settlement_retry_pending 同理走 drained(2026-09-22 上海 UAT:冻结 RETRY_WAIT
    // 事件的账户级限制行只有人工 absorb 才能收口 —— worker 对带泄漏 reservation 的
    // 冻结只告警不自动收口,absorb 必须顺手把 retry 限制也放掉,否则事件终态后
    // 限制行再无任何释放路径)。第一步的 legacy requestId 键正好覆盖存量行形态。
    await this.releaseSubjectRestrictionWhenDrained(
      this.prisma,
      requestId,
      event,
      'settlement_retry_pending',
      actorId,
      'financial_absorption_closed_reconciliation',
    );
  }

  private async findUnanchoredAbsorbReplay(
    requestId: string,
    command: GatewayReconciliationCommand,
    repairProof: GatewayUnanchoredAbsorbRepairProof,
  ): Promise<{ apiKeyId: string; billingAccountId: string } | null> {
    const existing = await this.prisma.gatewayUsageReconciliationAction.findUnique({
      where: { idempotencyKey: command.idempotencyKey },
      include: {
        gatewayBillingEvent: {
          include: {
            settlementAnchor: { select: { id: true } },
            fundingReservation: { select: { id: true } },
            tokenUsage: { select: { id: true } },
            settlementReceipts: true,
            platformLossEntries: { select: { id: true } },
            usageLossRecognitionClaims: { select: { id: true } },
            historicalPlatformLossLines: { select: { id: true } },
          },
        },
      },
    });
    if (!existing) return null;
    const event = existing.gatewayBillingEvent;
    const metadata = isJsonObject(existing.metadata) ? existing.metadata : null;
    const receipt = event.settlementReceipts.length === 1
      ? event.settlementReceipts[0]
      : null;
    const payload = receipt && isJsonObject(receipt.payload) ? receipt.payload : null;
    const expectedFingerprint = payload
      ? unanchoredAbsorbCanonicalSha256({
          ...payload,
          settlementFingerprint: undefined,
        })
      : null;
    const currentApiKeyId = metadata ? stringValue(metadata.currentApiKeyId) : undefined;
    const currentTenantId = metadata ? stringValue(metadata.currentTenantId) : undefined;
    const currentBillingAccountId = metadata
      ? stringValue(metadata.currentBillingAccountId)
      : undefined;
    const apiKey = currentApiKeyId
      ? await this.prisma.apiKey.findUnique({
          where: { id: currentApiKeyId },
          select: {
            id: true,
            tenantId: true,
            deletedAt: true,
            tenant: {
              select: {
                id: true,
                billingAccountId: true,
                deletedAt: true,
                billingAccount: { select: { id: true, deletedAt: true } },
              },
            },
          },
        })
      : null;
    const creditTransactionCount = await this.prisma.creditTransaction.count({
      where: { requestId },
    });
    const repairRows = metadata
      ? await this.prisma.$queryRaw<Array<{ proven: boolean }>>`
          SELECT TRUE AS "proven"
          FROM "billing_account_currency_label_repair_runs" AS repair_run
          JOIN "billing_account_currency_label_repair_items" AS repair_item
            ON repair_item."run_id" = repair_run."id"
          JOIN "billing_account_currency_label_repair_eligible_events" AS eligible_event
            ON eligible_event."run_id" = repair_run."id"
           AND eligible_event."item_id" = repair_item."id"
          JOIN "billing_accounts" AS account
            ON account."id" = repair_item."billing_account_id"
          WHERE repair_run."id" = ${repairProof.currencyRepairRunId}
            AND repair_item."id" = ${repairProof.currencyRepairItemId}
            AND repair_run."manifest_hash" = ${repairProof.manifestHash}
            AND repair_run."status" = 'APPLIED'
            AND repair_run."source_currency" = ${stringValue(
              metadata.originalAccountCurrency,
            ) ?? ''}
            AND repair_run."target_currency" = ${stringValue(
              metadata.originalDeploymentCurrency,
            ) ?? ''}
            AND repair_item."before_currency" = repair_run."source_currency"
            AND repair_item."after_currency" = repair_run."target_currency"
            AND repair_item."billing_account_id" = ${currentBillingAccountId ?? ''}
            AND eligible_event."id" = ${stringValue(
              metadata.currencyRepairEligibleEventId,
            ) ?? ''}
            AND eligible_event."gateway_billing_event_id" = ${event.id}
            AND eligible_event."request_id" = ${requestId}
            AND eligible_event."evidence_id" = ${stringValue(
              metadata.currencyRepairEvidenceId,
            ) ?? ''}
            AND eligible_event."evidence_hash" = ${event.evidenceHash ?? ''}
            AND eligible_event."failure_code" =
              ${GATEWAY_UNANCHORED_CURRENCY_FAILURE_CODE}
            AND eligible_event."failure_reason" =
              ${GATEWAY_UNANCHORED_CURRENCY_FAILURE_REASON}
            AND eligible_event."error_fingerprint" =
              ${GATEWAY_UNANCHORED_CURRENCY_ERROR_FINGERPRINT}
            AND eligible_event."row_hash" = ${stringValue(
              metadata.currencyRepairEligibleEventRowHash,
            ) ?? ''}
            AND encode(sha256(convert_to(jsonb_build_object(
              'runId', repair_run."id",
              'billingAccountId', repair_item."billing_account_id",
              'gatewayBillingEventId', eligible_event."gateway_billing_event_id",
              'requestId', eligible_event."request_id",
              'evidenceId', eligible_event."evidence_id",
              'evidenceHash', eligible_event."evidence_hash",
              'failureCode', eligible_event."failure_code",
              'failureReason', eligible_event."failure_reason",
              'errorMessage', eligible_event."error_message",
              'errorFingerprint', eligible_event."error_fingerprint",
              'eventSnapshot', eligible_event."event_snapshot"
            )::TEXT, 'UTF8')), 'hex') = eligible_event."row_hash"
            AND account."currency" = repair_item."after_currency"
            AND account."deleted_at" IS NULL
          LIMIT 1
        `
      : [];
    if (
      existing.requestId !== requestId
      || existing.action !== 'ABSORB'
      || existing.reason !== command.reason
      || existing.expectedRevision !== command.expectedRevision
      || (existing.actorId ?? '') !== command.actorId
      || metadata?.protocol !== GATEWAY_UNANCHORED_ABSORB_PROTOCOL
      || metadata.requestId !== requestId
      || metadata.gatewayBillingEventId !== event.id
      || metadata.expectedRevision !== existing.expectedRevision
      || metadata.resultingRevision !== existing.resultingRevision
      || metadata.reason !== command.reason
      || metadata.actorId !== command.actorId
      || metadata.idempotencyKey !== command.idempotencyKey
      || metadata.currencyRepairRunId !== repairProof.currencyRepairRunId
      || metadata.currencyRepairItemId !== repairProof.currencyRepairItemId
      || metadata.currencyRepairManifestHash !== repairProof.manifestHash
      || metadata.currencyRepairEligibilityCode
        !== GATEWAY_UNANCHORED_CURRENCY_FAILURE_CODE
      || metadata.currencyRepairFailureReason
        !== GATEWAY_UNANCHORED_CURRENCY_FAILURE_REASON
      || metadata.currencyRepairErrorFingerprint
        !== GATEWAY_UNANCHORED_CURRENCY_ERROR_FINGERPRINT
      || typeof metadata.currencyRepairEligibleEventId !== 'string'
      || typeof metadata.currencyRepairEligibleEventRowHash !== 'string'
      || typeof metadata.currencyRepairEvidenceId !== 'string'
      || event.requestId !== requestId
      || event.status !== 'ABSORBED'
      || event.reconciliationStatus !== 'CLOSED'
      || event.fundingOutcome !== 'ABSORBED'
      || event.revision !== existing.resultingRevision
      || event.reason !== command.reason
      || event.settlementAnchor !== null
      || event.fundingReservation !== null
      || event.tokenUsage !== null
      || event.platformLossEntries.length !== 0
      || event.usageLossRecognitionClaims.length !== 0
      || event.historicalPlatformLossLines.length !== 0
      || creditTransactionCount !== 0
      || !receipt
      || receipt.gatewayBillingEventId !== event.id
      || receipt.requestId !== requestId
      || receipt.settlementRevision !== existing.resultingRevision
      || receipt.fundingOutcome !== 'ABSORBED'
      || receipt.policyVersion !== GATEWAY_UNANCHORED_ABSORB_PROTOCOL
      || receipt.idempotencyKey !== `receipt:${command.idempotencyKey}`
      || receipt.actorId !== command.actorId
      || receipt.reason !== command.reason
      || !new Prisma.Decimal(receipt.amountUsd).isZero()
      || receipt.anchorHash !== null
      || receipt.pricingHash !== null
      || receipt.billingUnit !== null
      || receipt.billingCurrency !== null
      || receipt.creditAmount !== null
      || receipt.tokenUsageId !== null
      || !receipt.settlementFingerprint
      || metadata.settlementFingerprint !== receipt.settlementFingerprint
      || payload?.protocol !== GATEWAY_UNANCHORED_ABSORB_PROTOCOL
      || payload.requestId !== requestId
      || payload.gatewayBillingEventId !== event.id
      || payload.expectedRevision !== existing.expectedRevision
      || payload.resultingRevision !== existing.resultingRevision
      || payload.reason !== command.reason
      || payload.actorId !== command.actorId
      || payload.idempotencyKey !== command.idempotencyKey
      || payload.currencyRepairRunId !== repairProof.currencyRepairRunId
      || payload.currencyRepairItemId !== repairProof.currencyRepairItemId
      || payload.currencyRepairManifestHash !== repairProof.manifestHash
      || payload.currencyRepairEligibleEventId
        !== metadata.currencyRepairEligibleEventId
      || payload.currencyRepairEligibleEventRowHash
        !== metadata.currencyRepairEligibleEventRowHash
      || payload.currencyRepairEligibilityCode
        !== metadata.currencyRepairEligibilityCode
      || payload.currencyRepairFailureReason
        !== metadata.currencyRepairFailureReason
      || payload.currencyRepairErrorFingerprint
        !== metadata.currencyRepairErrorFingerprint
      || payload.currencyRepairEvidenceId !== metadata.currencyRepairEvidenceId
      || payload.evidenceHash !== event.evidenceHash
      || receipt.evidenceHash !== event.evidenceHash
      || payload.amountUsd !== '0.000000000000'
      || payload.customerDeductionUsd !== '0.000000000000'
      || payload.fundingOutcome !== 'ABSORBED'
      || payload.settlementFingerprint !== receipt.settlementFingerprint
      || expectedFingerprint !== receipt.settlementFingerprint
      || !currentApiKeyId
      || !currentTenantId
      || !currentBillingAccountId
      || repairRows.length !== 1
      || repairRows[0]?.proven !== true
      || !apiKey
      || apiKey.deletedAt
      || apiKey.id !== event.apiKeyId
      || apiKey.tenantId !== currentTenantId
      || apiKey.tenant.id !== currentTenantId
      || apiKey.tenant.deletedAt
      || apiKey.tenant.billingAccountId !== currentBillingAccountId
      || apiKey.tenant.billingAccount?.id !== currentBillingAccountId
      || apiKey.tenant.billingAccount.deletedAt
    ) {
      throw new ConflictException('idempotencyKey 对应的无锚币种吸收证明不完整或不一致');
    }
    return { apiKeyId: currentApiKeyId, billingAccountId: currentBillingAccountId };
  }

  private async repairUnanchoredAbsorbProjection(
    requestId: string,
    apiKeyId: string,
    billingAccountId: string,
    actorId: string,
  ): Promise<void> {
    await this.releaseAbsorptionRestrictions(requestId, actorId);
    await this.refreshPendingAccessRestriction(requestId, billingAccountId);
    await this.syncUnanchoredAbsorbTargetRequired(apiKeyId);
  }

  private async syncUnanchoredAbsorbTargetRequired(apiKeyId: string): Promise<void> {
    if (!this.publisherSync) {
      throw new Error('PublisherSyncService is required for unanchored absorption projection');
    }
    await this.publisherSync.syncBillingAccountKeyBalancesByKeyIdRequired(apiKeyId);
  }

  /**
   * 已终态事件被重复投递时的修复路径（调用点见 findCommittedResult 那段 replay 分支）。
   *
   * 它按 gatewayBillingEventId 匹配、不重算主体，所以在主体漂移的 bug 期里它是**唯一**
   * 还能放行主体级限制行的通路 —— 代价是必须撞上「同一 requestId 在事件已终态后再被投递一次」。
   * 2026-09-20 国内 prod 70 条卡死里只有 1 条这样侥幸逃掉（建行 18 秒后被放），
   * 看起来像自解、其实是偶发重复投递。漂移修好后它退回成纯粹的重放修复路径。
   */
  private async releaseSettlementRetryRestriction(
    gatewayBillingEventId: string,
    actorId?: string,
  ): Promise<boolean> {
    const released = await this.releaseRestrictionsFreeingSubjectKey(
      this.prisma,
      { gatewayBillingEventId, reason: 'settlement_retry_pending' },
      {
        status: 'RELEASED',
        releasedAt: new Date(),
        releasedBy: actorId?.trim() || 'SYSTEM',
        releaseReason: 'settlement_retry_resolved',
      },
    );
    return released > 0;
  }

  private async refreshPendingAccessRestriction(
    requestId: string,
    billingAccountId?: string,
  ): Promise<void> {
    if (!billingAccountId) return;
    const maxRequests = this.nonNegativeConfigInt('BILLING_USAGE_PENDING_MAX_REQUESTS');
    const maxExposureUsd = this.nonNegativeConfigDecimal(
      'BILLING_USAGE_PENDING_MAX_EXPOSURE_USD',
    );
    if (maxRequests <= 0 && maxExposureUsd.lte(0)) return;

    const [event, aggregate, activeRestriction] = await Promise.all([
      this.prisma.gatewayBillingEvent.findUnique({
        where: { requestId },
        select: { id: true },
      }),
      this.prisma.gatewayBillingEvent.aggregate({
        where: {
          billingAccountId,
          status: 'QUARANTINED',
          reconciliationStatus: { in: ['OPEN', 'READY', 'PROCESSING', 'RETRY_WAIT', 'MANUAL_REVIEW'] },
          // Provider evidence review is an internal reconciliation queue, not
          // customer credit exposure. Legacy rows remain visible to operators
          // but cannot create/retain the account-level pending limit.
          NOT: [
            ...PROVIDER_EVIDENCE_ONLY_REASON_PREFIXES.map((prefix) => ({
              reason: { startsWith: prefix },
            })),
            { reason: { in: [...PROVIDER_EVIDENCE_ONLY_REASONS] } },
          ],
        },
        _count: { _all: true },
        _sum: { pendingExposureUsd: true, pendingHoldUsd: true },
      }),
      this.prisma.billingAccessRestriction.findFirst({
        where: {
          billingAccountId,
          status: 'ACTIVE',
          reason: 'pending_usage_exposure_limit',
        },
      }),
    ]);
    const pendingCount = aggregate._count._all;
    const exposure = new Prisma.Decimal(aggregate._sum.pendingExposureUsd ?? 0);
    const limitExceeded = (maxRequests > 0 && pendingCount >= maxRequests) ||
      (maxExposureUsd.gt(0) && exposure.gte(maxExposureUsd));
    if (limitExceeded && !activeRestriction && event) {
      await this.prisma.billingAccessRestriction.create({
        data: {
          gatewayBillingEventId: event.id,
          billingAccountId,
          reason: 'pending_usage_exposure_limit',
          idempotencyKey: `gateway:pending-limit:${billingAccountId}:${requestId}`,
          createdBy: 'SYSTEM',
        },
      }).catch((err) => {
        if (!hasPrismaCode(err, 'P2002')) throw err;
      });
    } else if (!limitExceeded && activeRestriction) {
      await this.prisma.billingAccessRestriction.updateMany({
        where: {
          billingAccountId,
          status: 'ACTIVE',
          reason: 'pending_usage_exposure_limit',
        },
        data: {
          status: 'RELEASED',
          releasedAt: new Date(),
          releasedBy: 'SYSTEM',
          releaseReason: 'pending_exposure_below_limit',
        },
      });
    }
  }

  private syncRestrictionTarget(
    billingAccountId?: string,
    apiKeyId?: string,
    required = false,
  ): Promise<void> {
    // The publisher key-balance projection: a synchronous, fail-closed
    // cross-service call sitting on the per-message path. Prime suspect for the
    // sequential-round-trip cost, hence timed separately from its caller.
    return timed('publisherKeyProjection', () =>
      this.syncRestrictionTargetInner(billingAccountId, apiKeyId, required),
    );
  }

  private async syncRestrictionTargetInner(
    billingAccountId?: string,
    apiKeyId?: string,
    required = false,
  ): Promise<void> {
    if (!this.publisherSync) {
      if (required) throw new Error('PublisherSyncService is required for fail-closed restriction');
      return;
    }
    try {
      if (billingAccountId) {
        if (required) {
          await this.publisherSync.syncBillingAccountKeyBalancesRequired(billingAccountId);
        } else {
          await this.publisherSync.syncBillingAccountKeyBalances(billingAccountId);
        }
      } else if (apiKeyId) {
        if (required) {
          await this.publisherSync.syncKeyBalanceByIdRequired(apiKeyId);
        } else {
          await this.publisherSync.syncKeyBalanceById(apiKeyId);
        }
      }
    } catch (err) {
      if (required) throw err;
      this.logger.warn(
        `billing restriction publisher sync failed account=${billingAccountId ?? ''} key=${apiKeyId ?? ''}: ${
          err instanceof Error ? err.message : String(err)
        }`,
      );
    }
  }

  private nonNegativeConfigInt(key: string): number {
    const value = Number.parseInt(this.config?.get<string>(key) ?? '', 10);
    return Number.isFinite(value) && value > 0 ? value : 0;
  }

  private nonNegativeConfigDecimal(key: string): Prisma.Decimal {
    const raw = this.config?.get<string>(key)?.trim();
    if (!raw) return new Prisma.Decimal(0);
    try {
      const value = new Prisma.Decimal(raw);
      return value.gt(0) ? value : new Prisma.Decimal(0);
    } catch {
      return new Prisma.Decimal(0);
    }
  }

  private validateReconciliationCommand(command: GatewayReconciliationCommand): void {
    if (!Number.isInteger(command.expectedRevision) || command.expectedRevision < 0) {
      throw new BadRequestException('expectedRevision 必须是非负整数');
    }
    if (!command.reason?.trim()) throw new BadRequestException('reason 不能为空');
    if (!command.idempotencyKey?.trim()) throw new BadRequestException('idempotencyKey 不能为空');
    if (!command.actorId?.trim()) throw new BadRequestException('actorId 不能为空');
    if (command.idempotencyKey.trim().length > 160) {
      throw new BadRequestException('idempotencyKey 过长');
    }
  }

  private canonicalReconciliationCommand(
    command: GatewayReconciliationCommand,
  ): GatewayReconciliationCommand {
    return {
      expectedRevision: command.expectedRevision,
      reason: command.reason.trim(),
      idempotencyKey: command.idempotencyKey.trim(),
      actorId: command.actorId.trim(),
    };
  }

  private canonicalUnanchoredAbsorbRepairProof(
    command: GatewayAbsorbCommand,
  ): GatewayUnanchoredAbsorbRepairProof {
    const currencyRepairRunId = command.currencyRepairRunId?.trim();
    const currencyRepairItemId = command.currencyRepairItemId?.trim();
    const manifestHash = command.manifestHash?.trim().toLowerCase();
    if (!currencyRepairRunId || !currencyRepairItemId) {
      throw new BadRequestException('无锚币种吸收必须绑定 currency repair run/item');
    }
    if (!manifestHash || !/^[0-9a-f]{64}$/.test(manifestHash)) {
      throw new BadRequestException('无锚币种吸收 manifestHash 必须是 64 位 SHA-256');
    }
    return { currencyRepairRunId, currencyRepairItemId, manifestHash };
  }

  private async findActionReplay(
    requestId: string,
    action: string,
    command: GatewayReconciliationCommand,
  ) {
    const existing = await this.prisma.gatewayUsageReconciliationAction.findUnique({
      where: { idempotencyKey: command.idempotencyKey.trim() },
    });
    if (!existing) return null;
    if (
      existing.requestId !== requestId ||
      existing.action !== action ||
      existing.reason !== command.reason.trim() ||
      existing.expectedRevision !== command.expectedRevision ||
      (existing.actorId ?? '') !== command.actorId.trim()
    ) {
      throw new ConflictException('idempotencyKey 已用于另一项对账操作');
    }
    return this.getEvent(requestId);
  }

  private resultFromStoredEvent(event: {
    requestId: string;
    status: string;
    reason: string | null;
    errorMessage: string | null;
    billingResult: Prisma.JsonValue | null;
    revision: number;
    evidenceVerdict: string;
    reconciliationStatus: string;
    fundingOutcome: string | null;
  }): GatewayRequestEventBillingResult {
    const action: GatewayRequestEventBillingResult['action'] =
      event.status === 'DEDUCTED' ? 'deducted' :
        event.status === 'ABSORBED' ? 'absorbed' :
          event.status === 'DEBT_OPEN' ? 'debt_open' :
            event.status === 'QUARANTINED' ? 'quarantined' :
              event.status === 'SKIPPED' ? 'skipped' : 'failed';
    return {
      action,
      requestId: event.requestId,
      reason: event.reason ?? undefined,
      errorMessage: event.errorMessage ?? undefined,
      billing: isJsonObject(event.billingResult) ? event.billingResult : undefined,
      revision: event.revision,
      evidenceVerdict: event.evidenceVerdict,
      reconciliationStatus: event.reconciliationStatus,
      fundingOutcome: event.fundingOutcome ?? undefined,
    };
  }

  private auditSnapshot(event: JsonObject, input?: UsageDeductInput) {
    const labels = this.eventLabels(event);
    const tokens = input
      ? {
          inputTokens: input.inputTokens ?? 0,
          outputTokens: input.outputTokens ?? 0,
          cachedInputTokens: input.cachedInputTokens ?? 0,
          cacheWriteInputTokens: input.cacheWriteInputTokens ?? 0,
          totalTokens: input.totalTokens ?? 0,
        }
      : this.extractTokens(event);
    const occurredAt = input?.eventOccurredAt
      ? gatewayEventTimeValue(input.eventOccurredAt)
      : this.resolveEventOccurredAt(event);

    return {
      eventId: stringValue(event.event_id),
      ...(occurredAt ? { occurredAt } : {}),
      apiKeyId: input?.apiKeyId ?? this.resolveApiKeyId(event, labels),
      tenantId: input?.tenantId ?? this.resolveTenantId(event, labels),
      userId: input?.userId ?? this.resolveUserId(event, labels),
      productId: input?.productId ?? this.resolveProductId(labels),
      productSlug: input?.productSlug ?? this.resolveProductSlug(labels),
      modelName: input?.modelName ?? this.resolveModelName(event),
      inputTokens: tokens.inputTokens,
      outputTokens: tokens.outputTokens,
      cachedInputTokens: tokens.cachedInputTokens,
      cacheWriteInputTokens: tokens.cacheWriteInputTokens,
      totalTokens: tokens.totalTokens,
      tokenSource: stringValue(event.token_source),
      upstreamRequestId: this.resolveUpstreamRequestId(event),
      source: input?.source,
      idempotencyKey: input?.idempotencyKey,
      billingUnit: input?.billingUnit,
    };
  }

  private eventLabels(event: JsonObject): Record<string, string> {
    const base = optionalObject(event.base);
    return {
      ...optionalStringMap(base.labels),
      ...optionalStringMap(event.labels),
    };
  }

  private resolveApiKeyId(event: JsonObject, labels: Record<string, string>): string | undefined {
    const base = optionalObject(event.base);
    return firstNonEmpty([
      stringValue(event.key_id),
      stringValue(base.key_id),
      labels.key_id,
      labels.api_key_id,
      labels.apiKeyId,
    ]);
  }

  private resolveTenantId(event: JsonObject, labels: Record<string, string>): string | undefined {
    const base = optionalObject(event.base);
    return firstNonEmpty([
      labels.tenant_id,
      labels.tenantId,
      stringValue(event.tenant_id),
      stringValue(base.tenant_id),
    ]);
  }

  private resolveUserId(
    event: JsonObject,
    labels: Record<string, string>,
  ): string | undefined {
    const base = optionalObject(event.base);
    return firstNonEmpty([
      stringValue(event.user_id),
      stringValue(base.user_id),
      labels.user_id,
      labels.userId,
    ]);
  }

  private resolveProductId(labels: Record<string, string>): string | undefined {
    return firstNonEmpty([
      labels.product_id,
      labels.productId,
      labels['usr.product_id'],
    ]);
  }

  private resolveProductSlug(labels: Record<string, string>): string | undefined {
    return firstNonEmpty([
      labels.product_slug,
      labels.productSlug,
      labels['usr.product_slug'],
    ]);
  }

  private resolveModelName(event: JsonObject): string | undefined {
    const request = optionalObject(event.request);
    const decision = optionalObject(event.decision);
    const finalAttempt = this.finalAttempt(decision);
    return firstNonEmpty([
      stringValue(event.logical_model),
      stringValue(event.actual_model),
      stringValue(event.resolved_model),
      stringValue(event.model),
      stringValue(request.logical_model),
      stringValue(request.actual_model),
      stringValue(request.served_model),
      stringValue(request.requested_model),
      stringValue(decision.logical_model),
      stringValue(decision.actual_model),
      stringValue(finalAttempt.logical_model),
      stringValue(request.upstream_model),
      stringValue(finalAttempt.upstream_model),
      stringValue(event.upstream_model),
    ]);
  }

  private resolveCallType(event: JsonObject): string | undefined {
    const base = optionalObject(event.base);
    const request = optionalObject(event.request);
    return firstNonEmpty([
      stringValue(event.call_type),
      stringValue(request.call_type),
      stringValue(base.call_type),
    ]);
  }

  private resolveUpstreamModel(event: JsonObject): string | undefined {
    const base = optionalObject(event.base);
    const request = optionalObject(event.request);
    const decision = optionalObject(event.decision);
    const finalAttempt = this.finalAttempt(decision);
    return firstNonEmpty([
      stringValue(event.upstream_model),
      stringValue(request.upstream_model),
      stringValue(finalAttempt.upstream_model),
      stringValue(base.upstream_model),
    ]);
  }

  private resolveUpstreamRequestId(event: JsonObject): string | undefined {
    const base = optionalObject(event.base);
    const response = optionalObject(event.response);
    return firstNonEmpty([
      stringValue(event.upstream_request_id),
      stringValue(event.upstreamRequestId),
      stringValue(base.upstream_request_id),
      stringValue(response.request_id),
    ]);
  }

  private resolveProvider(event: JsonObject): string {
    const request = optionalObject(event.request);
    const decision = optionalObject(event.decision);
    const finalAttempt = this.finalAttempt(decision);
    return firstNonEmpty([
      stringValue(event.provider),
      stringValue(event.resolved_api_type),
      stringValue(request.provider_id),
      stringValue(finalAttempt.provider_id),
      'unknown-provider',
    ])!;
  }

  private resolveProviderAccountRef(event: JsonObject): string | undefined {
    const base = optionalObject(event.base);
    return firstNonEmpty([
      stringValue(event.provider_account_ref),
      stringValue(event.provider_credential_ref),
      stringValue(base.provider_account_ref),
      stringValue(base.provider_credential_ref),
    ]);
  }

  private resolveStableRegion(
    event: JsonObject,
    labels: Record<string, string>,
  ): string | undefined {
    const decision = optionalObject(event.decision);
    return firstNonEmpty([
      stringValue(event.region),
      stringValue(decision.region),
      labels.region,
    ]);
  }

  private resolveRegion(event: JsonObject, labels: Record<string, string>): string {
    return this.resolveStableRegion(event, labels) ?? 'unknown-region';
  }
}

function changedUsageLossMeters(
  original: {
    promptTokens: number;
    completionTokens: number;
    cachedInputTokens: number | null;
    cacheWriteInputTokens: number | null;
  },
  corrected: UsageDeductInput,
): string[] {
  const dimensions: Array<[string, number, number]> = [
    ['INPUT', original.promptTokens, corrected.inputTokens ?? 0],
    ['OUTPUT', original.completionTokens, corrected.outputTokens ?? 0],
    ['CACHE', original.cachedInputTokens ?? 0, corrected.cachedInputTokens ?? 0],
    [
      'CACHE_WRITE',
      original.cacheWriteInputTokens ?? 0,
      corrected.cacheWriteInputTokens ?? 0,
    ],
  ];
  return dimensions
    .filter(([, before, after]) => before !== after)
    .map(([meter]) => meter);
}

function settlementAnchorFromRow(row: {
  requestId: string;
  apiKeyId: string;
  userId: string;
  tenantId: string;
  billingAccountId: string;
  productId: string;
  productSlug: string;
  billingUnit: string;
  billingCurrency: string | null;
  codingPlanEntitlementId: string | null;
  subscriptionId: string | null;
  planId: string | null;
  occurredAt: Date;
  firstReceivedAt: Date;
  firstReceiptSequence: bigint | null;
  fundingReservationProtocol: string | null;
  pricingHash: string;
  customerQuoteSnapshot: Prisma.JsonValue;
  customerPricingSnapshot: Prisma.JsonValue;
  providerCostSnapshot: Prisma.JsonValue;
  anchorHash: string;
  canonicalPayload: Prisma.JsonValue;
}): GatewaySettlementAnchor {
  if (!isJsonObject(row.canonicalPayload)) {
    throw new GatewaySettlementAnchorConflictError(
      'Gateway settlement anchor canonical payload 无效',
    );
  }
  if (canonicalSha256(row.canonicalPayload) !== row.anchorHash) {
    throw new GatewaySettlementAnchorConflictError(
      'Gateway settlement anchor canonical hash 校验失败',
    );
  }
  const billingUnit = row.billingUnit === 'BALANCE' || row.billingUnit === 'CREDITS'
    ? row.billingUnit
    : null;
  if (!billingUnit) {
    throw new GatewaySettlementAnchorConflictError('Gateway settlement anchor billing unit 无效');
  }
  const payloadOccurredAt = gatewayEventTimeValue(row.canonicalPayload.occurredAt);
  const payloadFirstReceivedAt = gatewayEventTimeValue(
    row.canonicalPayload.firstReceivedAt,
  );
  const payloadCustomerQuote = row.canonicalPayload.customerQuoteSnapshot;
  const payloadCustomerPricing = row.canonicalPayload.customerPricingSnapshot;
  const payloadProviderCost = row.canonicalPayload.providerCostSnapshot;
  const customerSettlementPolicyVersion = stringValue(
    row.canonicalPayload.customerSettlementPolicyVersion,
  );
  if (
    customerSettlementPolicyVersion
    !== LATEST_GATEWAY_CUSTOMER_SETTLEMENT_POLICY_VERSION
  ) {
    throw new GatewaySettlementAnchorConflictError(
      'Gateway settlement anchor customer policy version 无效',
    );
  }
  if (
    !isJsonObject(payloadCustomerQuote) ||
    !isJsonObject(payloadCustomerPricing) ||
    !isJsonObject(payloadProviderCost) ||
    !isJsonObject(row.customerQuoteSnapshot) ||
    !isJsonObject(row.customerPricingSnapshot) ||
    !isJsonObject(row.providerCostSnapshot)
  ) {
    throw new GatewaySettlementAnchorConflictError(
      'Gateway settlement anchor pricing snapshot 无效',
    );
  }
  const pricingHash = canonicalSha256({
    customerQuoteSnapshot: row.customerQuoteSnapshot,
    customerPricingSnapshot: row.customerPricingSnapshot,
    providerCostSnapshot: row.providerCostSnapshot,
  });
  const nullablePayloadString = (value: unknown): string | null => stringValue(value) ?? null;
  if (
    stringValue(row.canonicalPayload.requestId) !== row.requestId ||
    stringValue(row.canonicalPayload.apiKeyId) !== row.apiKeyId ||
    stringValue(row.canonicalPayload.userId) !== row.userId ||
    stringValue(row.canonicalPayload.tenantId) !== row.tenantId ||
    stringValue(row.canonicalPayload.billingAccountId) !== row.billingAccountId ||
    stringValue(row.canonicalPayload.productId) !== row.productId ||
    stringValue(row.canonicalPayload.productSlug) !== row.productSlug ||
    stringValue(row.canonicalPayload.billingUnit) !== billingUnit ||
    nullablePayloadString(row.canonicalPayload.billingCurrency) !== row.billingCurrency ||
    nullablePayloadString(row.canonicalPayload.codingPlanEntitlementId) !== row.codingPlanEntitlementId ||
    nullablePayloadString(row.canonicalPayload.subscriptionId) !== row.subscriptionId ||
    nullablePayloadString(row.canonicalPayload.planId) !== row.planId ||
    stringValue(row.canonicalPayload.pricingHash) !== row.pricingHash ||
    pricingHash !== row.pricingHash ||
    canonicalSha256(payloadCustomerQuote) !== canonicalSha256(row.customerQuoteSnapshot) ||
    canonicalSha256(payloadCustomerPricing) !== canonicalSha256(row.customerPricingSnapshot) ||
    canonicalSha256(payloadProviderCost) !== canonicalSha256(row.providerCostSnapshot) ||
    !payloadOccurredAt || payloadOccurredAt.getTime() !== row.occurredAt.getTime() ||
    !payloadFirstReceivedAt ||
    payloadFirstReceivedAt.getTime() !== row.firstReceivedAt.getTime()
  ) {
    throw new GatewaySettlementAnchorConflictError(
      'Gateway settlement anchor columns 与 canonical payload 不一致',
    );
  }
  const entitlement = row.canonicalPayload.entitlementSnapshot;
  const plan = row.canonicalPayload.planSnapshot;
  return {
    requestId: row.requestId,
    apiKeyId: row.apiKeyId,
    userId: row.userId,
    tenantId: row.tenantId,
    billingAccountId: row.billingAccountId,
    productId: row.productId,
    productSlug: row.productSlug,
    billingUnit,
    billingCurrency: row.billingCurrency,
    codingPlanEntitlementId: row.codingPlanEntitlementId,
    subscriptionId: row.subscriptionId,
    planId: row.planId,
    occurredAt: row.occurredAt,
    firstReceivedAt: row.firstReceivedAt,
    customerSettlementPolicyVersion: LATEST_GATEWAY_CUSTOMER_SETTLEMENT_POLICY_VERSION,
    firstReceiptSequence: row.firstReceiptSequence,
    fundingReservationProtocol: row.fundingReservationProtocol,
    pricingHash: row.pricingHash,
    customerQuoteSnapshot: row.customerQuoteSnapshot as GatewaySettlementAnchor['customerQuoteSnapshot'],
    customerPricingSnapshot: row.customerPricingSnapshot as GatewaySettlementAnchor['customerPricingSnapshot'],
    providerCostSnapshot: row.providerCostSnapshot as GatewaySettlementAnchor['providerCostSnapshot'],
    anchorHash: row.anchorHash,
    entitlementSnapshot: isJsonObject(entitlement)
      ? entitlement as GatewaySettlementAnchor['entitlementSnapshot']
      : null,
    planSnapshot: isJsonObject(plan)
      ? plan as GatewaySettlementAnchor['planSnapshot']
      : null,
  };
}

function toMapped(input: UsageDeductInput): GatewayRequestEventBillingResult['mapped'] {
  return {
    apiKeyId: input.apiKeyId,
    tenantId: input.tenantId,
    productId: input.productId,
    productSlug: input.productSlug,
    userId: input.userId,
    modelName: input.modelName,
    inputTokens: input.inputTokens ?? 0,
    outputTokens: input.outputTokens ?? 0,
    cachedInputTokens: input.cachedInputTokens ?? 0,
    cacheWriteInputTokens: input.cacheWriteInputTokens ?? 0,
    totalTokens: input.totalTokens ?? 0,
  };
}

function asObject(value: unknown, name: string): JsonObject {
  if (!isJsonObject(value)) {
    throw new BadRequestException(`${name} 必须是 JSON object`);
  }
  return value;
}

function optionalObject(value: unknown): JsonObject {
  return isJsonObject(value) ? value : {};
}

function isJsonObject(value: unknown): value is JsonObject {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function toInputJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function canonicalSha256(value: unknown): string {
  return createHash('sha256').update(canonicalJson(value)).digest('hex');
}

/**
 * Versioned canonical form owned exclusively by
 * gateway-unanchored-absorb-v1. PostgreSQL verifies this fingerprint with C
 * collation, so use UTF-8 byte ordering here instead of the process locale.
 * Existing evidence/anchor hashes deliberately remain on canonicalSha256.
 */
function unanchoredAbsorbCanonicalSha256(value: unknown): string {
  return createHash('sha256')
    .update(unanchoredAbsorbCanonicalJson(value))
    .digest('hex');
}

function unanchoredAbsorbCanonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) {
    return `[${value.map(unanchoredAbsorbCanonicalJson).join(',')}]`;
  }
  return `{${Object.entries(value as JsonObject)
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => Buffer.compare(
      Buffer.from(left, 'utf8'),
      Buffer.from(right, 'utf8'),
    ))
    .map(([key, item]) => (
      `${JSON.stringify(key)}:${unanchoredAbsorbCanonicalJson(item)}`
    ))
    .join(',')}}`;
}

function canonicalJson(value: unknown): string {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  const object = value as JsonObject;
  return `{${Object.entries(object)
    // JSON/Prisma remove undefined values before persistence. Canonicalize the
    // same logical JSON on both sides of that boundary or a valid receipt can
    // fail its hash check after the first database round trip.
    .filter(([, item]) => item !== undefined)
    .sort(([left], [right]) => left.localeCompare(right))
    .map(([key, item]) => `${JSON.stringify(key)}:${canonicalJson(item)}`)
    .join(',')}}`;
}

function firstDecimal(values: unknown[]): Prisma.Decimal | null {
  for (const value of values) {
    if (value === undefined || value === null || value === '') continue;
    try {
      const parsed = new Prisma.Decimal(value as Prisma.Decimal.Value);
      if (parsed.gte(0)) return parsed;
    } catch {
      // Ignore malformed external amounts and continue to the next source.
    }
  }
  return null;
}

function hasPrismaCode(value: unknown, code: string): boolean {
  return Boolean(
    value &&
    typeof value === 'object' &&
    'code' in value &&
    (value as { code?: unknown }).code === code,
  );
}

/**
 * exposure 幂等读回的逐字段比较。
 *
 * 参与比较的是**除 id 与 createdAt 之外的全部字段**。
 * ⚠️ 类型比较规则（冻结）：`BigInt` 用**值**比较（不能 `===` 比较装箱对象）；
 * `Decimal` 用 `.eq()`；nullable 字段必须区分 `null` 与 `undefined`；
 * **禁止** `JSON.stringify` 整体比较（键序与 BigInt/Decimal 序列化都不可靠）。
 */
function provisionalExposureRowMatches(
  row: {
    gatewayBillingEventId: string;
    sourceEvidenceId: string;
    sourceEvidenceRevision: number;
    exposureKind: string;
    sourceReason: string;
    httpStatus: number;
    outputTokens: bigint;
    inputTokens: bigint | null;
    tokenSource: string | null;
    amountUsd: Prisma.Decimal | null;
    amountStatus: string;
  },
  expected: {
    gatewayBillingEventId: string;
    sourceEvidenceId: string;
    sourceEvidenceRevision: number;
    exposureKind: string;
    sourceReason: string;
    httpStatus: number;
    outputTokens: bigint;
    inputTokens: bigint | null;
    tokenSource: string | null;
    amountUsd: Prisma.Decimal | null;
    amountStatus: string;
  },
): boolean {
  if (row.gatewayBillingEventId !== expected.gatewayBillingEventId) return false;
  if (row.sourceEvidenceId !== expected.sourceEvidenceId) return false;
  if (row.sourceEvidenceRevision !== expected.sourceEvidenceRevision) return false;
  if (row.exposureKind !== expected.exposureKind) return false;
  if (row.sourceReason !== expected.sourceReason) return false;
  if (row.httpStatus !== expected.httpStatus) return false;
  // BigInt 值比较。
  if (BigInt(row.outputTokens) !== BigInt(expected.outputTokens)) return false;
  if ((row.inputTokens === null) !== (expected.inputTokens === null)) return false;
  if (
    row.inputTokens !== null
    && expected.inputTokens !== null
    && BigInt(row.inputTokens) !== BigInt(expected.inputTokens)
  ) return false;
  // null 与 undefined 必须区分：undefined 表示「没给」，不是「明确为空」。
  if ((row.tokenSource ?? null) !== (expected.tokenSource ?? null)) return false;
  if (row.tokenSource === undefined || expected.tokenSource === undefined) return false;
  if ((row.amountUsd === null) !== (expected.amountUsd === null)) return false;
  if (
    row.amountUsd !== null
    && expected.amountUsd !== null
    && !row.amountUsd.eq(expected.amountUsd)
  ) return false;
  return row.amountStatus === expected.amountStatus;
}

function stringValue(value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  const trimmed = value.trim();
  return trimmed || undefined;
}

function gatewayEventTimeValue(value: unknown): Date | null {
  if (value === undefined || value === null || value === '') return null;
  if (value instanceof Date) return validDate(value);
  if (typeof value === 'number') return epochDateFromNumber(value);
  const str = stringValue(value);
  if (!str) return null;
  if (/^\d+$/.test(str)) return epochDateFromIntegerString(str);
  return validDate(new Date(str));
}

function epochDateFromNumber(value: number): Date | null {
  if (!Number.isFinite(value) || value <= 0) return null;
  if (value >= 1e17) return validDate(new Date(Math.floor(value / 1_000_000)));
  if (value >= 1e14) return validDate(new Date(Math.floor(value / 1_000)));
  if (value >= 1e11) return validDate(new Date(Math.floor(value)));
  return validDate(new Date(Math.floor(value * 1000)));
}

function epochDateFromIntegerString(value: string): Date | null {
  try {
    const epoch = BigInt(value);
    const digits = value.replace(/^0+/, '').length;
    const millis =
      digits >= 18
        ? epoch / 1_000_000n
        : digits >= 15
          ? epoch / 1_000n
          : digits >= 12
            ? epoch
            : epoch * 1_000n;
    if (millis > BigInt(Number.MAX_SAFE_INTEGER)) return null;
    return validDate(new Date(Number(millis)));
  } catch {
    return null;
  }
}

function validDate(value: Date): Date | null {
  return Number.isNaN(value.getTime()) ? null : value;
}

function requiredString(value: unknown, name: string): string {
  const result = stringValue(value);
  if (!result) throw new BadRequestException(`${name} 必填`);
  return result;
}

function firstNonEmpty(values: Array<string | undefined>): string | undefined {
  return values.find((value) => value !== undefined);
}

function firstPositiveInt(values: unknown[]): number {
  for (const value of values) {
    const parsed = nonNegativeInt(value);
    if (parsed > 0) return parsed;
  }
  return 0;
}

function sumPositiveInts(values: unknown[]): number {
  return values.reduce<number>(
    (sum, value) => sum + firstPositiveInt([value]),
    0,
  );
}

function nonNegativeInt(value: unknown): number {
  if (value === undefined || value === null || value === '') return 0;
  const n = Number(value);
  if (!Number.isFinite(n) || n < 0) return 0;
  return Math.floor(n);
}

function strictNonNegativeInt(value: unknown): number | null {
  return typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : null;
}

function optionalStringMap(value: unknown): Record<string, string> {
  if (!isJsonObject(value)) return {};
  const result: Record<string, string> = {};
  for (const [key, item] of Object.entries(value)) {
    const str = stringValue(item);
    if (str !== undefined) result[key] = str;
  }
  return result;
}
