import { createHash } from 'node:crypto';
import { Prisma } from '@prisma/client';

const ZERO = new Prisma.Decimal(0);
const ENTERPRISE_PAID_DEBT_ADJUSTMENT_PREFIX = 'balance:admin-adjust:enterprise-paid-debt:';
const ADMIN_RECHARGE_GRANT_PREFIX = 'balance:admin-recharge:grant:';
const LEGACY_ADMIN_FUNDING_REPAIR_KIND = 'LEGACY_ENTERPRISE_ADMIN_FUNDING_V1' as const;
const LEGACY_ADMIN_FUNDING_GRANT_PREFIX = 'repair-enterprise-admin-funding:';
const LEGACY_ADMIN_FUNDING_KEY_PREFIX = 'enterprise-recharge:';
const RECHARGE_VALIDITY_DAYS = 365;

export type BalanceLedgerRepairTransaction = {
  id: string;
  userId?: string;
  tenantId?: string | null;
  productId?: string | null;
  tokenUsageId?: string | null;
  type: string;
  amountUsd: string;
  balanceAfterUsd: string;
  description: string;
  orderId: string | null;
  operationKey?: string | null;
  ledgerSequence?: string | null;
  createdAt: string;
};

export type BalanceLedgerRepairGrant = {
  id: string;
  userId?: string;
  tenantId?: string;
  productId?: string | null;
  orderId: string | null;
  source: string;
  paidAmountUsd: string;
  bonusAmountUsd: string;
  grantedAmountUsd: string;
  remainingAmountUsd: string;
  remainingPaidAmountUsd: string | null;
  remainingBonusAmountUsd: string | null;
  discountRate: string;
  isExpired: boolean;
  validFrom?: string;
  expiresAt?: string | null;
  createdAt: string;
  /** sha256(to_jsonb(balance_grants_row)::text), loaded only for proof-linked rows. */
  snapshotSha256?: string;
};

export type BalanceLedgerRepairAllocation = {
  id: string;
  billingAccountId?: string | null;
  userId?: string;
  tenantId?: string;
  productId?: string | null;
  balanceTransactionId: string;
  tokenUsageId?: string | null;
  balanceGrantId: string | null;
  source: string;
  amountUsd: string;
  recognizedRevenueUsd: string;
  bonusConsumedUsd: string;
  discountRate?: string;
  settledUsd: string;
  settledAt: string | null;
  ledgerSequence?: string | null;
  createdAt: string;
};

export type BalanceLedgerRepairSettlement = {
  id: string;
  billingAccountId?: string;
  allocationId: string;
  repaymentTransactionId: string | null;
  balanceGrantId: string | null;
  debtSource: string;
  repairRunId: string | null;
  operationKey: string | null;
  trigger: string;
  amountUsd: string;
  paidUsd: string;
  bonusUsd: string;
  occurredAt: string;
  createdAt: string;
};

export type BalanceLedgerRepairInvoiceItemEvidence = {
  id: string;
  orderId: string;
  principalCents: number;
  description: string;
  applicationId: string;
  applicationUserId: string;
  applicationTenantId: string;
  applicationStatus: string;
  invoiceNumber: string | null;
  issuingEntity: string | null;
  issueDate: string | null;
  dueDate: string | null;
  issuedAt: string | null;
  pdfUrl: string | null;
  ofdUrl: string | null;
  hasIssuedLifecycleEvent: boolean;
};

/**
 * Complete, account-related invoice closure captured by the offline runner.
 * The snapshot contains every column of each related order, application, item,
 * and event, with every collection sorted by primary key.  The small identity
 * arrays make the plan human-reviewable while `snapshotSha256` commits the
 * approved plan to the full immutable evidence set.
 */
export type BalanceLedgerRepairInvoiceEvidence = {
  orderIds: string[];
  applicationIds: string[];
  itemIds: string[];
  eventIds: string[];
  invoiceItemCount: number;
  unsafeInvoiceItemCount: number;
  invalidApplicationCount: number;
  snapshotSha256: string;
  snapshot: unknown;
};

export type BalanceLedgerRepairOrderEvidence = {
  id: string;
  userId: string;
  tenantId: string;
  billingAccountId: string | null;
  productId: string | null;
  orderType: string;
  status: string;
  amountCents: number;
  bonusCents: number;
  currency: string;
  paidAt: string | null;
  completedAt: string | null;
  refundedAt: string | null;
  refundAmountCents: number | null;
  createdAt: string;
};

/**
 * Legacy admin voucher issuance did not persist an operation_key on the
 * funding transaction. Its COMMITTED idempotency response is the durable
 * issuance receipt that binds the generated grant and transaction. Keep the
 * JSON result intact: the verifier below accepts only the exact historical
 * response schema and the locked repair snapshot permanently preserves it
 * after the operational idempotency TTL has elapsed.
 */
export type BalanceLedgerRepairVoucherIdempotencyEvidence = {
  key: string;
  scope: string;
  userId: string | null;
  status: string;
  result: unknown;
  createdAt: string;
  expiresAt: string;
};

/**
 * Durable COMMITTED receipt written by the pre-V2 admin adjustment/recharge
 * writer. The loader deliberately snapshots only the two reviewed scopes and
 * account-bound `enterprise-recharge:<billingAccountId>:` keys.
 */
export type BalanceLedgerRepairLegacyAdminFundingIdempotencyEvidence = {
  key: string;
  scope: string;
  userId: string | null;
  status: string;
  result: unknown;
  createdAt: string;
  expiresAt: string;
  /** sha256(to_jsonb(idempotency_keys_row)::text), computed by PostgreSQL. */
  snapshotSha256: string;
};

export type BalanceLedgerRepairSnapshot = {
  billingAccountId: string;
  accountType: string;
  ledgerStatus: string;
  ledgerVersion: number;
  walletBalanceUsd: string;
  transactions: BalanceLedgerRepairTransaction[];
  grants: BalanceLedgerRepairGrant[];
  allocations: BalanceLedgerRepairAllocation[];
  settlements: BalanceLedgerRepairSettlement[];
  orders: BalanceLedgerRepairOrderEvidence[];
  invoiceItems: BalanceLedgerRepairInvoiceItemEvidence[];
  invoiceEvidence?: BalanceLedgerRepairInvoiceEvidence;
  voucherIdempotencyEvidence: BalanceLedgerRepairVoucherIdempotencyEvidence[];
  legacyAdminFundingIdempotencyEvidence?:
    BalanceLedgerRepairLegacyAdminFundingIdempotencyEvidence[];
  expiryAuditCount: number;
};

export type BalanceLedgerRepairPlanningProfile = {
  allowLegacyExpiryProofs: boolean;
  allowLegacyExpiredVoucherProofs: boolean;
  allowInvoiceStabilityProof: boolean;
};

const DEFAULT_PLANNING_PROFILE: BalanceLedgerRepairPlanningProfile = {
  allowLegacyExpiryProofs: false,
  allowLegacyExpiredVoucherProofs: false,
  allowInvoiceStabilityProof: false,
};

export type BalanceLedgerLegacyAdminFundingRepair = {
  repairKind: typeof LEGACY_ADMIN_FUNDING_REPAIR_KIND;
  action: 'CREATE_GRANT' | 'LINK_GRANT';
  idempotencyKey: string;
  idempotencyScope: 'admin:adjust-balance' | 'admin:recharge';
  idempotencyEvidenceHash: string;
  proofHash: string;
  transactionId: string;
  grantId: string;
  userId: string;
  tenantId: string;
  billingAccountId: string;
  productId: string | null;
  amountUsd: string;
  initialRemainingAmountUsd: string;
  expectedGrantSnapshotHash: string | null;
  expectedGrantRemainingAmountUsd: string | null;
  expectedGrantRemainingPaidAmountUsd: string | null;
  expectedGrantRemainingBonusAmountUsd: string | null;
  finalRemainingAmountUsd: string;
  finalRemainingPaidAmountUsd: string;
  finalRemainingBonusAmountUsd: string;
  validFrom: string;
  expiresAt: string;
  createdAt: string;
};

export type BalanceLedgerGrantMutation = {
  grantId: string;
  expectedRemainingAmountUsd: string;
  expectedRemainingPaidAmountUsd: string | null;
  expectedRemainingBonusAmountUsd: string | null;
  remainingAmountUsd: string;
  remainingPaidAmountUsd: string;
  remainingBonusAmountUsd: string;
};

export type BalanceLedgerAllocationMutation = {
  allocationId: string;
  expectedSettledUsd: string;
  expectedRecognizedRevenueUsd: string;
  expectedBonusConsumedUsd: string;
  expectedSettledAt: string | null;
  settledUsd: string;
  recognizedRevenueUsd: string;
  bonusConsumedUsd: string;
  settledAt: string | null;
};

export type BalanceLedgerAllocationSequenceMutation = {
  allocationId: string;
  expectedLedgerSequence: null;
  ledgerSequence: string;
};

export type BalanceLedgerTransactionSequenceMutation = {
  transactionId: string;
  expectedLedgerSequence: null;
  ledgerSequence: string;
};

export type BalanceLedgerUnreconciledGrantMutation = {
  allocationId: string;
  expectedSource: 'UNRECONCILED_GRANT';
  expectedBalanceGrantId: string;
  expectedAmountUsd: string;
  expectedRecognizedRevenueUsd: string;
  expectedBonusConsumedUsd: string;
  expectedDiscountRate: string;
  expectedSettledUsd: string;
  expectedSettledAt: null;
  expectedLedgerSequence: string;
  source: 'BALANCE_GRANT';
  balanceGrantId: string;
  recognizedRevenueUsd: string;
  bonusConsumedUsd: string;
  discountRate: string;
};

/**
 * A legacy allocation can point at the right consumption transaction but the
 * wrong recharge batch when a negative wallet was later filled.  Repairing
 * only BalanceGrant.remaining would preserve that false revenue attribution.
 * This mutation therefore carries the complete locked source row as its CAS
 * precondition and only changes the canonical FIFO grant/amount/components.
 */
export type BalanceLedgerCanonicalAllocationMutation = {
  allocationId: string;
  expectedUserId: string;
  expectedTenantId: string;
  expectedProductId: string | null;
  expectedBalanceTransactionId: string;
  expectedTokenUsageId: string | null;
  expectedBalanceGrantId: string;
  expectedSource: 'BALANCE_GRANT';
  expectedAmountUsd: string;
  expectedRecognizedRevenueUsd: string;
  expectedBonusConsumedUsd: string;
  expectedDiscountRate: string;
  expectedSettledUsd: string;
  expectedSettledAt: null;
  expectedLedgerSequence: string | null;
  expectedCreatedAt: string;
  balanceGrantId: string;
  amountUsd: string;
  recognizedRevenueUsd: string;
  bonusConsumedUsd: string;
  discountRate: string;
  ledgerSequence: string | null;
};

/**
 * The pre-V2 allocator created a paid `MIGRATION_OPENING` grant when a
 * personal consumption exceeded the available grant balance.  That row was
 * not funding: it was a placeholder for the negative part of the wallet
 * debit.  A repair may retire the placeholder grant only when the complete
 * one-grant/one-allocation writer fingerprint is proven and the allocation is
 * atomically rewritten as canonical personal debt.
 */
export type BalanceLedgerMigrationOpeningDebtMutation = {
  allocationId: string;
  grantId: string;
  expectedGrant: BalanceLedgerRepairGrant;
  expectedUserId: string;
  expectedTenantId: string;
  expectedProductId: string | null;
  expectedBalanceTransactionId: string;
  expectedTokenUsageId: string | null;
  expectedBalanceGrantId: string;
  expectedSource: 'BALANCE_GRANT';
  expectedAmountUsd: string;
  expectedRecognizedRevenueUsd: string;
  expectedBonusConsumedUsd: string;
  expectedDiscountRate: string;
  expectedSettledUsd: string;
  expectedSettledAt: null;
  expectedLedgerSequence: string | null;
  expectedCreatedAt: string;
  source: 'NEGATIVE_BALANCE';
  balanceGrantId: null;
  amountUsd: string;
  recognizedRevenueUsd: string;
  bonusConsumedUsd: string;
  discountRate: string;
  settledUsd: string;
  settledAt: string | null;
  ledgerSequence: string | null;
};

/**
 * Versioned proof for the one historical personal writer defect that assigned
 * an entire cross-zero (or already-negative) consumption to a grant.  Every
 * mutable source column is locked in `expectedSourceAllocation`; the complete
 * post-repair row(s), including their final ledger sequence, are carried by
 * the target snapshots so apply never has to derive finance data again.
 */
export type BalanceLedgerPersonalDebtAllocationMutation = {
  proofVersion: 1;
  repairKind: 'LEGACY_DEBT_SPLIT_V1' | 'LEGACY_DEBT_RECLASS_V1';
  transactionId: string;
  sourceAllocationId: string;
  createdDebtAllocationId: string | null;
  expectedTransactionBeforeUsd: string;
  expectedTransactionAfterUsd: string;
  expectedSourceAllocation: BalanceLedgerRepairAllocation;
  targetSourceAllocation: BalanceLedgerRepairAllocation;
  targetDebtAllocation: BalanceLedgerRepairAllocation | null;
};

/**
 * A proof row, not a synthetic voucher receipt.  The transaction and grant
 * remain immutable; apply persists their locked snapshots together with the
 * wallet hole proven by the transaction chain.  Receipt evidence is retained
 * exactly as observed (empty for the pre-idempotency writer, one row for the
 * full-remainder writer defect).
 */
export type BalanceLedgerLegacyVoucherProofMutation = {
  proofVersion: 1;
  repairKind:
    | 'LEGACY_PRE_IDEMPOTENCY_VOUCHER_V1'
    | 'LEGACY_PRE_IDEMPOTENCY_EXPIRED_VOUCHER_V1'
    | 'LEGACY_VOUCHER_FULL_REMAINDER_DEBT_ABSORPTION_V1';
  transactionId: string;
  grantId: string;
  walletBeforeUsd: string;
  walletAfterUsd: string;
  holeFillUsd: string;
  mintedGrantAmountUsd: string;
  expectedTransaction: BalanceLedgerRepairTransaction;
  expectedGrant: BalanceLedgerRepairGrant;
  expectedIdempotencyEvidence: BalanceLedgerRepairVoucherIdempotencyEvidence[];
  openingDebtAllocationIds: string[];
};

export type BalanceLedgerLegacyExpiryProofMutation = {
  proofVersion: 1;
  repairKind: 'LEGACY_INLINE_EXPIRY_V1';
  grantId: string;
  transactionId: string;
  expiryAuditId: string;
  nominalAmountUsd: string;
  nominalPaidUsd: string;
  nominalBonusUsd: string;
  walletBalanceBeforeUsd: string;
  walletBalanceAfterUsd: string;
  expectedTransaction: BalanceLedgerRepairTransaction;
  expectedGrant: BalanceLedgerRepairGrant;
};

export type BalanceLedgerInvoiceStabilityProofMutation = {
  proofVersion: 1;
  repairKind: 'ISSUED_INVOICE_STABILITY_V1';
  orderCount: number;
  applicationCount: number;
  itemCount: number;
  eventCount: number;
  evidenceSha256: string;
};

export type BalanceLedgerSettlementMutation = {
  sequence: number;
  allocationId: string;
  repaymentTransactionId: string;
  balanceGrantId: string | null;
  debtSource: 'NEGATIVE_BALANCE' | 'ENTERPRISE_CREDIT';
  fundingNature: 'PAID' | 'BONUS';
  amountUsd: string;
  paidUsd: string;
  bonusUsd: string;
  occurredAt: string;
};

type ReadyPlan = {
  status: 'READY';
  billingAccountId: string;
  accountType: 'personal' | 'enterprise';
  debtSource: 'NEGATIVE_BALANCE' | 'ENTERPRISE_CREDIT';
  settlementWriteMode: 'CREATE' | 'VERIFY_EXISTING';
  expectedSettlementCount: number;
  preconditionHash: string;
  replayHash: string;
  walletBalanceUsd: string;
  currentDebtUsd: string;
  legacySettledDebtUsd: string;
  activeGrantDriftUsd: string;
  throughTransactionId: string | null;
  transactionSequenceMutations: BalanceLedgerTransactionSequenceMutation[];
  grantMutations: BalanceLedgerGrantMutation[];
  allocationMutations: BalanceLedgerAllocationMutation[];
  allocationSequenceMutations: BalanceLedgerAllocationSequenceMutation[];
  unreconciledGrantMutations: BalanceLedgerUnreconciledGrantMutation[];
  canonicalAllocationMutations: BalanceLedgerCanonicalAllocationMutation[];
  migrationOpeningDebtMutations: BalanceLedgerMigrationOpeningDebtMutation[];
  personalDebtAllocationMutations: BalanceLedgerPersonalDebtAllocationMutation[];
  legacyVoucherProofMutations: BalanceLedgerLegacyVoucherProofMutation[];
  legacyExpiryProofMutations: BalanceLedgerLegacyExpiryProofMutation[];
  invoiceStabilityProof: BalanceLedgerInvoiceStabilityProofMutation | null;
  settlementMutations: BalanceLedgerSettlementMutation[];
  legacyAdminFundingRepairs: BalanceLedgerLegacyAdminFundingRepair[];
};

type QuarantinedPlan = {
  status: 'QUARANTINED';
  billingAccountId: string;
  preconditionHash: string;
  reasons: string[];
};

export type BalanceLedgerRepairPlan = ReadyPlan | QuarantinedPlan;

type OrderedTransaction = BalanceLedgerRepairTransaction & {
  beforeUsd: Prisma.Decimal;
  amount: Prisma.Decimal;
  afterUsd: Prisma.Decimal;
};

type LegacyExpiryProofCandidate = {
  grant: BalanceLedgerRepairGrant;
  transaction: OrderedTransaction;
};

type OpenDebt = {
  allocation: BalanceLedgerRepairAllocation;
  remainingUsd: Prisma.Decimal;
  paidUsd: Prisma.Decimal;
  bonusUsd: Prisma.Decimal;
  settledAt: string | null;
};

type ReplayedGrant = {
  grant: BalanceLedgerRepairGrant;
  paidRemainingUsd: Prisma.Decimal;
  bonusRemainingUsd: Prisma.Decimal;
};

type SupportedAccountType = 'personal' | 'enterprise';
type SupportedDebtSource = 'NEGATIVE_BALANCE' | 'ENTERPRISE_CREDIT';

function decimal(value: Prisma.Decimal.Value): Prisma.Decimal {
  return new Prisma.Decimal(value).toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
}

function money(value: Prisma.Decimal.Value): string {
  return decimal(value).toFixed(12);
}

function stableValue(value: unknown): unknown {
  if (Array.isArray(value)) return value.map(stableValue);
  if (value && typeof value === 'object') {
    return Object.fromEntries(
      Object.entries(value as Record<string, unknown>)
        .sort(([left], [right]) => left.localeCompare(right))
        .map(([key, nested]) => [key, stableValue(nested)]),
    );
  }
  return value;
}

type ReplayHashInput = Pick<
  ReadyPlan,
  | 'billingAccountId'
  | 'accountType'
  | 'debtSource'
  | 'settlementWriteMode'
  | 'expectedSettlementCount'
  | 'walletBalanceUsd'
  | 'currentDebtUsd'
  | 'grantMutations'
  | 'transactionSequenceMutations'
  | 'allocationMutations'
  | 'allocationSequenceMutations'
  | 'unreconciledGrantMutations'
  | 'canonicalAllocationMutations'
  | 'migrationOpeningDebtMutations'
  | 'personalDebtAllocationMutations'
  | 'legacyVoucherProofMutations'
  | 'legacyExpiryProofMutations'
  | 'invoiceStabilityProof'
  | 'settlementMutations'
  | 'throughTransactionId'
> & Partial<Pick<ReadyPlan, 'legacyAdminFundingRepairs'>>;

export function balanceLedgerRepairReplayHash(plan: ReplayHashInput): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue({
      billingAccountId: plan.billingAccountId,
      accountType: plan.accountType,
      debtSource: plan.debtSource,
      settlementWriteMode: plan.settlementWriteMode,
      expectedSettlementCount: plan.expectedSettlementCount,
      walletBalanceUsd: money(plan.walletBalanceUsd),
      openDebtUsd: money(plan.currentDebtUsd),
      grantMutations: plan.grantMutations,
      transactionSequenceMutations: plan.transactionSequenceMutations,
      allocationMutations: plan.allocationMutations,
      allocationSequenceMutations: plan.allocationSequenceMutations,
      unreconciledGrantMutations: plan.unreconciledGrantMutations,
      canonicalAllocationMutations: plan.canonicalAllocationMutations,
      migrationOpeningDebtMutations: plan.migrationOpeningDebtMutations,
      personalDebtAllocationMutations: plan.personalDebtAllocationMutations,
      legacyVoucherProofMutations: plan.legacyVoucherProofMutations,
      legacyExpiryProofMutations: plan.legacyExpiryProofMutations,
      invoiceStabilityProof: plan.invoiceStabilityProof,
      settlementMutations: plan.settlementMutations,
      legacyAdminFundingRepairs: plan.legacyAdminFundingRepairs ?? [],
      throughTransactionId: plan.throughTransactionId,
    })))
    .digest('hex');
}

export function balanceLedgerSnapshotHash(snapshot: BalanceLedgerRepairSnapshot): string {
  return createHash('sha256')
    .update(JSON.stringify(stableValue(snapshot)))
    .digest('hex');
}

function quarantine(
  snapshot: BalanceLedgerRepairSnapshot,
  preconditionHash: string,
  reasons: string[],
): QuarantinedPlan {
  return {
    status: 'QUARANTINED',
    billingAccountId: snapshot.billingAccountId,
    preconditionHash,
    reasons: [...new Set(reasons)].sort(),
  };
}

function orderLegacyTransactions(
  transactions: BalanceLedgerRepairTransaction[],
): { ordered: OrderedTransaction[]; reasons: string[] } {
  const MAX_TRANSACTION_PATH_NODES = 5_000;
  const MAX_TRANSACTION_PATH_SEARCH_STATES = 100_000;
  const reasons: string[] = [];
  const candidatesByBefore = new Map<string, BalanceLedgerRepairTransaction[]>();
  for (const transaction of transactions) {
    const amount = decimal(transaction.amountUsd);
    const after = decimal(transaction.balanceAfterUsd);
    const beforeKey = money(after.minus(amount));
    const candidates = candidatesByBefore.get(beforeKey) ?? [];
    candidates.push(transaction);
    candidatesByBefore.set(beforeKey, candidates);
  }
  for (const candidates of candidatesByBefore.values()) {
    candidates.sort((left, right) => left.id.localeCompare(right.id));
  }

  // Most real ledgers form a strict function from before-balance to the next
  // transaction.  Prove that case in O(n), including historical accounts with
  // more rows than the bounded ambiguity search permits.  This is not a
  // timestamp-based tie-break: every wallet edge must be unique, reachable
  // from zero exactly once, and consume the complete input set.
  if ([...candidatesByBefore.values()].every((candidates) => candidates.length === 1)) {
    const used = new Set<string>();
    const ordered: OrderedTransaction[] = [];
    let running = ZERO;
    while (ordered.length < transactions.length) {
      const transaction = candidatesByBefore.get(money(running))?.[0];
      if (!transaction || used.has(transaction.id)) {
        reasons.push(
          `TRANSACTION_CHAIN_BROKEN:${transactions.map((row) => row.id).sort().join(',')}`,
        );
        return { ordered: [], reasons };
      }
      const amount = decimal(transaction.amountUsd);
      const afterUsd = decimal(transaction.balanceAfterUsd);
      used.add(transaction.id);
      ordered.push({ ...transaction, beforeUsd: running, amount, afterUsd });
      running = afterUsd;
    }
    return { ordered, reasons };
  }

  // Non-functional balance graphs require global path search to prove that a
  // complete path is unique.  Keep both the node cap and the independent state
  // cap so a historically large ambiguous graph cannot consume unbounded CPU.
  if (transactions.length > MAX_TRANSACTION_PATH_NODES) {
    return {
      ordered: [],
      reasons: [`TRANSACTION_CHAIN_SEARCH_LIMIT:transactions=${transactions.length}`],
    };
  }

  // A repeated wallet balance can expose several locally plausible next rows.
  // Greedy selection would quarantine a repairable ledger; timestamp sorting
  // would invent an ordering that PostgreSQL never proved. Search complete
  // wallet-continuous paths instead and accept only a globally unique one.
  const used = new Set<string>();
  const path: OrderedTransaction[] = [];
  const completePaths: OrderedTransaction[][] = [];
  type SearchFrame = {
    running: Prisma.Decimal;
    candidates: BalanceLedgerRepairTransaction[];
    nextCandidate: number;
  };
  const candidatesAt = (running: Prisma.Decimal): BalanceLedgerRepairTransaction[] => (
    (candidatesByBefore.get(money(running)) ?? [])
      .filter((transaction) => !used.has(transaction.id))
  );
  const stack: SearchFrame[] = [{
    running: ZERO,
    candidates: candidatesAt(ZERO),
    nextCandidate: 0,
  }];
  let exploredStates = 1;
  let searchLimitReached = false;
  while (stack.length > 0 && completePaths.length < 2 && !searchLimitReached) {
    if (path.length === transactions.length) {
      completePaths.push([...path]);
      stack.pop();
      const previous = path.pop();
      if (previous) used.delete(previous.id);
      continue;
    }
    const frame = stack.at(-1)!;
    if (frame.nextCandidate >= frame.candidates.length) {
      stack.pop();
      const previous = path.pop();
      if (previous) used.delete(previous.id);
      continue;
    }
    const transaction = frame.candidates[frame.nextCandidate];
    frame.nextCandidate += 1;
    if (used.has(transaction.id)) continue;
    const amount = decimal(transaction.amountUsd);
    const afterUsd = decimal(transaction.balanceAfterUsd);
    used.add(transaction.id);
    path.push({ ...transaction, beforeUsd: frame.running, amount, afterUsd });
    exploredStates += 1;
    if (exploredStates > MAX_TRANSACTION_PATH_SEARCH_STATES) {
      searchLimitReached = true;
      break;
    }
    stack.push({
      running: afterUsd,
      candidates: candidatesAt(afterUsd),
      nextCandidate: 0,
    });
  }

  if (searchLimitReached) {
    reasons.push(`TRANSACTION_CHAIN_SEARCH_LIMIT:states=${exploredStates}`);
    return { ordered: [], reasons };
  }
  if (completePaths.length === 0) {
    reasons.push(`TRANSACTION_CHAIN_BROKEN:${transactions.map((row) => row.id).sort().join(',')}`);
    return { ordered: [], reasons };
  }
  if (completePaths.length > 1) {
    reasons.push(
      `TRANSACTION_CHAIN_AMBIGUOUS:${completePaths.map((candidate) => (
        candidate.map((row) => row.id).join('>')
      )).sort().join('|')}`,
    );
    return { ordered: [], reasons };
  }
  return { ordered: completePaths[0], reasons };
}

function orderTransactions(
  transactions: BalanceLedgerRepairTransaction[],
  walletBalanceUsd: Prisma.Decimal,
): { ordered: OrderedTransaction[]; reasons: string[] } {
  const reasons: string[] = [];

  const sequenceById = new Map<string, bigint | null>();
  const idBySequence = new Map<bigint, string>();
  for (const transaction of transactions) {
    const raw = transaction.ledgerSequence ?? null;
    if (raw === null) {
      sequenceById.set(transaction.id, null);
      continue;
    }
    if (!/^-?\d+$/.test(raw)) {
      reasons.push(`TRANSACTION_LEDGER_SEQUENCE_INVALID:${transaction.id}:${raw}`);
      continue;
    }
    const sequence = BigInt(raw);
    if (sequence === BigInt(0)) {
      reasons.push(`TRANSACTION_LEDGER_SEQUENCE_ZERO:${transaction.id}`);
    }
    const duplicate = idBySequence.get(sequence);
    if (duplicate) {
      reasons.push(
        `TRANSACTION_LEDGER_SEQUENCE_DUPLICATE:${sequence.toString()}:${duplicate}:${transaction.id}`,
      );
    } else {
      idBySequence.set(sequence, transaction.id);
    }
    sequenceById.set(transaction.id, sequence);
  }
  if (reasons.length > 0) return { ordered: [], reasons };

  const positive = transactions
    .filter((transaction) => {
      const sequence = sequenceById.get(transaction.id);
      return sequence !== null && sequence !== undefined && sequence > BigInt(0);
    })
    .sort((left, right) => {
      const leftSequence = sequenceById.get(left.id)!;
      const rightSequence = sequenceById.get(right.id)!;
      return leftSequence < rightSequence ? -1 : leftSequence > rightSequence ? 1 : 0;
    })
    .map((transaction): OrderedTransaction => {
      const amount = decimal(transaction.amountUsd);
      const afterUsd = decimal(transaction.balanceAfterUsd);
      return {
        ...transaction,
        beforeUsd: afterUsd.minus(amount),
        amount,
        afterUsd,
      };
    });
  for (let index = 1; index < positive.length; index += 1) {
    if (!positive[index].beforeUsd.eq(positive[index - 1].afterUsd)) {
      reasons.push(
        `TRANSACTION_POSITIVE_SEQUENCE_CHAIN_BROKEN:${positive[index - 1].id}:${positive[index].id}`,
      );
    }
  }
  if (positive.length > 0 && !positive.at(-1)!.afterUsd.eq(walletBalanceUsd)) {
    reasons.push(
      `TRANSACTION_POSITIVE_SEQUENCE_WALLET_MISMATCH:${money(positive.at(-1)!.afterUsd)}:${
        money(walletBalanceUsd)
      }`,
    );
  }
  if (reasons.length > 0) return { ordered: [], reasons };

  const legacy = transactions.filter((transaction) => {
    const sequence = sequenceById.get(transaction.id);
    return sequence === null || sequence === undefined || sequence < BigInt(0);
  });
  let orderedLegacy: OrderedTransaction[];
  if (legacy.length > 0 && legacy.every((transaction) => sequenceById.get(transaction.id) !== null)) {
    let running = ZERO;
    orderedLegacy = [...legacy]
      .sort((left, right) => {
        const leftSequence = sequenceById.get(left.id)!;
        const rightSequence = sequenceById.get(right.id)!;
        return leftSequence < rightSequence ? -1 : leftSequence > rightSequence ? 1 : 0;
      })
      .map((transaction): OrderedTransaction => {
        const amount = decimal(transaction.amountUsd);
        const afterUsd = decimal(transaction.balanceAfterUsd);
        const beforeUsd = afterUsd.minus(amount);
        if (!beforeUsd.eq(running)) {
          reasons.push(
            `TRANSACTION_NEGATIVE_SEQUENCE_CHAIN_BROKEN:${transaction.id}:${money(running)}:${
              money(beforeUsd)
            }`,
          );
        }
        const ordered = { ...transaction, beforeUsd: running, amount, afterUsd };
        running = afterUsd;
        return ordered;
      });
  } else {
    const legacyOrder = orderLegacyTransactions(legacy);
    orderedLegacy = legacyOrder.ordered;
    reasons.push(...legacyOrder.reasons);
  }

  const legacyTargetUsd = positive.length > 0 ? positive[0].beforeUsd : walletBalanceUsd;
  const legacyTailUsd = orderedLegacy.at(-1)?.afterUsd ?? ZERO;
  if (orderedLegacy.length === legacy.length && !legacyTailUsd.eq(legacyTargetUsd)) {
    reasons.push(
      `TRANSACTION_SEQUENCE_EPOCH_BOUNDARY_MISMATCH:${money(legacyTailUsd)}:${money(legacyTargetUsd)}`,
    );
  }
  if (reasons.length > 0) return { ordered: [], reasons };
  return { ordered: [...orderedLegacy, ...positive], reasons };
}

function planTransactionSequences(
  orderedTransactions: OrderedTransaction[],
): { mutations: BalanceLedgerTransactionSequenceMutation[]; reasons: string[] } {
  const reasons: string[] = [];
  const legacy = orderedTransactions.filter((transaction) => {
    const sequence = transaction.ledgerSequence ?? null;
    return sequence === null || BigInt(sequence) < BigInt(0);
  });
  const mutations: BalanceLedgerTransactionSequenceMutation[] = [];
  for (const [index, transaction] of legacy.entries()) {
    const target = BigInt(index - legacy.length);
    const current = transaction.ledgerSequence ?? null;
    if (current === null) {
      mutations.push({
        transactionId: transaction.id,
        expectedLedgerSequence: null,
        ledgerSequence: target.toString(),
      });
    } else if (BigInt(current) !== target) {
      reasons.push(
        `TRANSACTION_LEGACY_SEQUENCE_MISMATCH:${transaction.id}:${current}:${target.toString()}`,
      );
    }
  }
  return { mutations, reasons };
}

function canonicalAllocationOrder(
  allocations: BalanceLedgerRepairAllocation[],
  orderedTransactions: OrderedTransaction[],
): BalanceLedgerRepairAllocation[] {
  const transactionOrder = new Map(
    orderedTransactions.map((transaction, index) => [transaction.id, index]),
  );
  return [...allocations].sort((left, right) => {
    const transactionDifference = (transactionOrder.get(left.balanceTransactionId) ?? Number.MAX_SAFE_INTEGER)
      - (transactionOrder.get(right.balanceTransactionId) ?? Number.MAX_SAFE_INTEGER);
    if (transactionDifference !== 0) return transactionDifference;
    const leftSequence = left.ledgerSequence == null ? null : BigInt(left.ledgerSequence);
    const rightSequence = right.ledgerSequence == null ? null : BigInt(right.ledgerSequence);
    if (leftSequence !== null && rightSequence !== null && leftSequence !== rightSequence) {
      return leftSequence < rightSequence ? -1 : 1;
    }
    if (leftSequence === null && rightSequence !== null) return -1;
    if (leftSequence !== null && rightSequence === null) return 1;
    return left.id.localeCompare(right.id);
  });
}

/**
 * Canonical grant replay can prove which immutable allocation row represents
 * each FIFO grant debit even when the legacy writer left every row without a
 * ledger sequence.  Preserve all non-grant positions, but order the grant
 * rows in those positions by that proof instead of falling back to UUIDs.
 *
 * The coverage checks are deliberately strict. A partial or cross-transaction
 * proof must quarantine the account rather than silently moving unrelated
 * allocation rows.
 */
function applyProvenGrantAllocationOrder(
  canonical: BalanceLedgerRepairAllocation[],
  provenOrderByTransaction: ReadonlyMap<string, readonly string[]>,
): { ordered: BalanceLedgerRepairAllocation[]; reasons: string[] } {
  const ordered = [...canonical];
  const byId = new Map(canonical.map((allocation) => [allocation.id, allocation]));
  const grantPositionsByTransaction = new Map<string, number[]>();
  for (const [index, allocation] of canonical.entries()) {
    if (allocation.source !== 'BALANCE_GRANT' && allocation.source !== 'UNRECONCILED_GRANT') {
      continue;
    }
    const positions = grantPositionsByTransaction.get(allocation.balanceTransactionId) ?? [];
    positions.push(index);
    grantPositionsByTransaction.set(allocation.balanceTransactionId, positions);
  }
  const reasons: string[] = [];

  const transactionIds = new Set([
    ...grantPositionsByTransaction.keys(),
    ...provenOrderByTransaction.keys(),
  ]);
  for (const transactionId of transactionIds) {
    const positions = grantPositionsByTransaction.get(transactionId) ?? [];
    const allocationIds = provenOrderByTransaction.get(transactionId);
    if (allocationIds === undefined || !grantPositionsByTransaction.has(transactionId)) {
      reasons.push(
        `CANONICAL_FIFO_ORDER_COVERAGE_MISMATCH:${transactionId}:`
          + `${positions.length}:${allocationIds?.length ?? 0}:0:0`,
      );
      continue;
    }
    const uniqueIds = new Set(allocationIds);
    const rows = allocationIds.map((allocationId) => byId.get(allocationId));
    const invalidRows = rows.filter((allocation) => (
      allocation === undefined
      || allocation.balanceTransactionId !== transactionId
      || (allocation.source !== 'BALANCE_GRANT' && allocation.source !== 'UNRECONCILED_GRANT')
    ));
    const expectedIds = new Set(positions.map((position) => ordered[position].id));
    const exactCoverage = positions.length === allocationIds.length
      && uniqueIds.size === allocationIds.length
      && invalidRows.length === 0
      && [...uniqueIds].every((allocationId) => expectedIds.has(allocationId));
    if (!exactCoverage) {
      reasons.push(
        `CANONICAL_FIFO_ORDER_COVERAGE_MISMATCH:${transactionId}:`
          + `${positions.length}:${allocationIds.length}:${uniqueIds.size}:${invalidRows.length}`,
      );
      continue;
    }
    positions.forEach((position, index) => {
      ordered[position] = rows[index]!;
    });
  }

  return { ordered, reasons };
}

function planAllocationSequences(
  allocations: BalanceLedgerRepairAllocation[],
  orderedTransactions: OrderedTransaction[],
  provenGrantOrderByTransaction?: ReadonlyMap<string, readonly string[]>,
): { mutations: BalanceLedgerAllocationSequenceMutation[]; reasons: string[] } {
  const reasons: string[] = [];
  const parsed = new Map<string, bigint | null>();
  for (const allocation of allocations) {
    const value = allocation.ledgerSequence ?? null;
    if (value === null) {
      parsed.set(allocation.id, null);
      continue;
    }
    if (!/^-?\d+$/.test(value)) {
      reasons.push(`ALLOCATION_LEDGER_SEQUENCE_INVALID:${allocation.id}:${value}`);
      continue;
    }
    const sequence = BigInt(value);
    if (sequence === BigInt(0)) {
      reasons.push(`ALLOCATION_LEDGER_SEQUENCE_ZERO:${allocation.id}`);
    }
    parsed.set(allocation.id, sequence);
  }
  if (reasons.length > 0) return { mutations: [], reasons };

  const initialCanonical = canonicalAllocationOrder(allocations, orderedTransactions);
  const provenOrder = provenGrantOrderByTransaction === undefined
    ? { ordered: initialCanonical, reasons: [] }
    : applyProvenGrantAllocationOrder(initialCanonical, provenGrantOrderByTransaction);
  reasons.push(...provenOrder.reasons);
  if (reasons.length > 0) return { mutations: [], reasons };
  const canonical = provenOrder.ordered;
  const sequenceEpochsByTransaction = new Map<string, Set<'LEGACY' | 'V2'>>();
  for (const allocation of allocations) {
    const sequence = parsed.get(allocation.id) ?? null;
    const epochs = sequenceEpochsByTransaction.get(allocation.balanceTransactionId) ?? new Set();
    epochs.add(sequence !== null && sequence > BigInt(0) ? 'V2' : 'LEGACY');
    sequenceEpochsByTransaction.set(allocation.balanceTransactionId, epochs);
  }
  for (const [transactionId, epochs] of sequenceEpochsByTransaction) {
    if (epochs.size > 1) {
      reasons.push(`ALLOCATION_LEDGER_SEQUENCE_MIXED_TRANSACTION:${transactionId}`);
    }
  }
  const seen = new Map<bigint, string>();
  let sawPositive = false;
  let previousPositive: bigint | null = null;
  for (const allocation of canonical) {
    const sequence = parsed.get(allocation.id) ?? null;
    if (sequence === null || sequence < BigInt(0)) {
      if (sawPositive) {
        reasons.push(`ALLOCATION_LEDGER_SEQUENCE_EPOCH_MISMATCH:${allocation.id}`);
      }
    } else if (sequence > BigInt(0)) {
      sawPositive = true;
      if (previousPositive !== null && sequence <= previousPositive) {
        reasons.push(
          `ALLOCATION_LEDGER_SEQUENCE_ORDER_MISMATCH:${allocation.id}:${sequence.toString()}`,
        );
      }
      previousPositive = sequence;
    }
    if (sequence !== null) {
      const duplicate = seen.get(sequence);
      if (duplicate) {
        reasons.push(
          `ALLOCATION_LEDGER_SEQUENCE_DUPLICATE:${sequence.toString()}:${duplicate}:${allocation.id}`,
        );
      } else {
        seen.set(sequence, allocation.id);
      }
    }
  }

  const legacy = canonical.filter((allocation) => {
    const sequence = parsed.get(allocation.id) ?? null;
    return sequence === null || sequence < BigInt(0);
  });
  const mutations: BalanceLedgerAllocationSequenceMutation[] = [];
  for (const [index, allocation] of legacy.entries()) {
    // -N ... -1 sorts every proven legacy row before the database sequence,
    // while remaining deterministic and unique inside the billing account.
    const target = BigInt(index - legacy.length);
    const current = parsed.get(allocation.id) ?? null;
    if (current === null) {
      mutations.push({
        allocationId: allocation.id,
        expectedLedgerSequence: null,
        ledgerSequence: target.toString(),
      });
    } else if (current !== target) {
      reasons.push(
        `ALLOCATION_LEGACY_SEQUENCE_MISMATCH:${allocation.id}:${current.toString()}:${target.toString()}`,
      );
    }
  }
  return { mutations, reasons };
}

function isEnterprisePaidDebtAdjustment(
  transaction: BalanceLedgerRepairTransaction,
): boolean {
  const operationKey = transaction.operationKey ?? '';
  return transaction.type === 'ADJUST'
    && new RegExp(`^${ENTERPRISE_PAID_DEBT_ADJUSTMENT_PREFIX}[^\\s]+$`).test(operationKey);
}

function isCanonicalRechargeBonusDescription(description: string): boolean {
  return /^recharge-bonus(?: tier:[^\s]+)?$/.test(description);
}

function canonicalVoucherGrantId(description: string): string | null {
  return /^voucher:([^\s]+)\s+\S(?:.*\S)?$/.exec(description)?.[1] ?? null;
}

function canonicalGrantRuleDescriptionParts(description: string): {
  ruleId: string;
  grantId: string;
  redemptionId: string;
} | null {
  const match = /^grant-rule:([^\s]+) balance-grant:([^\s]+) redemption:([^\s]+)$/.exec(
    description,
  );
  return match
    ? { ruleId: match[1], grantId: match[2], redemptionId: match[3] }
    : null;
}

function explicitAdminRechargeGrantId(
  transaction: BalanceLedgerRepairTransaction,
): string | null {
  const operationKey = transaction.operationKey ?? '';
  const match = new RegExp(`^${ADMIN_RECHARGE_GRANT_PREFIX}([^\\s]+)$`).exec(operationKey);
  return match?.[1] ?? null;
}

function validIsoInstant(value: string | null | undefined): number | null {
  if (!value) return null;
  const millis = new Date(value).getTime();
  return Number.isFinite(millis) ? millis : null;
}

function normalizedIsoInstant(value: string | null | undefined): string | null {
  const millis = validIsoInstant(value);
  return millis === null ? null : new Date(millis).toISOString();
}

function planLegacyExpiryProofCandidates(
  snapshot: BalanceLedgerRepairSnapshot,
  ordered: OrderedTransaction[],
  profile: BalanceLedgerRepairPlanningProfile,
): {
  byGrantId: Map<string, LegacyExpiryProofCandidate>;
  byTransactionId: Map<string, LegacyExpiryProofCandidate>;
  reasons: string[];
} {
  const byGrantId = new Map<string, LegacyExpiryProofCandidate>();
  const byTransactionId = new Map<string, LegacyExpiryProofCandidate>();
  const reasons: string[] = [];
  if (!profile.allowLegacyExpiryProofs) return { byGrantId, byTransactionId, reasons };

  const orderedById = new Map(ordered.map((transaction) => [transaction.id, transaction]));
  for (const grant of snapshot.grants.filter((candidate) => candidate.isExpired)) {
    const matches = snapshot.transactions.filter(
      (transaction) => transaction.description === `balance grant expired:${grant.id}`,
    );
    if (matches.length !== 1) {
      reasons.push(`LEGACY_EXPIRY_TRANSACTION_MATCH_${matches.length}:${grant.id}`);
      continue;
    }
    const transaction = orderedById.get(matches[0].id);
    const expiresAt = validIsoInstant(grant.expiresAt);
    const transactionAt = validIsoInstant(matches[0].createdAt);
    if (
      !transaction
      || transaction.type !== 'ADJUST'
      || transaction.amount.gte(0)
      || transaction.operationKey != null
      || transaction.tokenUsageId != null
      || transaction.ledgerSequence != null
      || !transaction.userId
      || !transaction.tenantId
      || !grant.userId
      || !grant.tenantId
      || transaction.userId !== grant.userId
      || transaction.tenantId !== grant.tenantId
      || (transaction.productId ?? null) !== (grant.productId ?? null)
      || transaction.orderId !== grant.orderId
      || !decimal(grant.remainingAmountUsd).eq(0)
      || !(
        grant.remainingPaidAmountUsd === null
        || decimal(grant.remainingPaidAmountUsd).eq(0)
      )
      || !(
        grant.remainingBonusAmountUsd === null
        || decimal(grant.remainingBonusAmountUsd).eq(0)
      )
      || (grant.remainingPaidAmountUsd === null)
        !== (grant.remainingBonusAmountUsd === null)
      || expiresAt === null
      || transactionAt === null
      || transactionAt < expiresAt
    ) {
      reasons.push(`LEGACY_EXPIRY_FINGERPRINT_MISMATCH:${grant.id}:${matches[0].id}`);
      continue;
    }
    if (byTransactionId.has(transaction.id)) {
      reasons.push(`LEGACY_EXPIRY_TRANSACTION_REUSED:${transaction.id}`);
      continue;
    }
    const candidate = { grant, transaction };
    byGrantId.set(grant.id, candidate);
    byTransactionId.set(transaction.id, candidate);
  }
  return { byGrantId, byTransactionId, reasons };
}

function buildInvoiceStabilityProof(
  snapshot: BalanceLedgerRepairSnapshot,
  profile: BalanceLedgerRepairPlanningProfile,
): { proof: BalanceLedgerInvoiceStabilityProofMutation | null; reasons: string[] } {
  if (
    !profile.allowInvoiceStabilityProof
    || unsafeInvoiceEvidenceReasons(snapshot.invoiceItems).length === 0
  ) {
    return { proof: null, reasons: [] };
  }
  const evidence = snapshot.invoiceEvidence;
  if (!evidence) return { proof: null, reasons: ['INVOICE_STABILITY_EVIDENCE_MISSING'] };
  const identitySets = [
    evidence.orderIds,
    evidence.applicationIds,
    evidence.itemIds,
    evidence.eventIds,
  ];
  if (
    identitySets.some((ids) => new Set(ids).size !== ids.length)
    || !Number.isInteger(evidence.invoiceItemCount)
    || !Number.isInteger(evidence.unsafeInvoiceItemCount)
    || !Number.isInteger(evidence.invalidApplicationCount)
    || evidence.invoiceItemCount !== snapshot.invoiceItems.length
    || evidence.unsafeInvoiceItemCount <= 0
    || evidence.invalidApplicationCount !== 0
    || !/^(?!0{64}$)[0-9a-f]{64}$/.test(evidence.snapshotSha256)
    || evidence.itemIds.length < snapshot.invoiceItems.length
    || evidence.eventIds.length === 0
    || snapshot.invoiceItems.some((item) => (
      !evidence.itemIds.includes(item.id)
      || !evidence.applicationIds.includes(item.applicationId)
      || !evidence.orderIds.includes(item.orderId)
    ))
  ) {
    return { proof: null, reasons: ['INVOICE_STABILITY_EVIDENCE_INVALID'] };
  }
  return {
    proof: {
      proofVersion: 1,
      repairKind: 'ISSUED_INVOICE_STABILITY_V1',
      orderCount: evidence.orderIds.length,
      applicationCount: evidence.applicationIds.length,
      itemCount: evidence.itemIds.length,
      eventCount: evidence.eventIds.length,
      evidenceSha256: evidence.snapshotSha256,
    },
    reasons: [],
  };
}

function grantIssuanceTimingMismatch(
  transaction: BalanceLedgerRepairTransaction,
  grant: BalanceLedgerRepairGrant,
  validFromDirection: 'AT_OR_AFTER_CREATION' | 'AT_OR_BEFORE_CREATION',
): string | null {
  const transactionCreatedAt = validIsoInstant(transaction.createdAt);
  const grantCreatedAt = validIsoInstant(grant.createdAt);
  const validFrom = validIsoInstant(grant.validFrom);
  if (transactionCreatedAt === null || grantCreatedAt === null) return 'CREATED_AT_INVALID';
  if (transactionCreatedAt !== grantCreatedAt) return 'CREATED_AT_MISMATCH';
  if (validFrom === null) return 'VALID_FROM_MISSING_OR_INVALID';
  if (validFromDirection === 'AT_OR_AFTER_CREATION' && validFrom < grantCreatedAt) {
    return 'VALID_FROM_BEFORE_CREATION';
  }
  if (validFromDirection === 'AT_OR_BEFORE_CREATION' && validFrom > grantCreatedAt) {
    return 'VALID_FROM_AFTER_CREATION';
  }
  if (grant.expiresAt != null) {
    const expiresAt = validIsoInstant(grant.expiresAt);
    if (expiresAt === null || expiresAt <= validFrom) return 'EXPIRY_WINDOW_INVALID';
  }
  return null;
}

/**
 * Before the ledger-v2 writer captured one financial timestamp, an order
 * fulfillment wrote the paid transaction and recharge grant in separate SQL
 * statements. Their database-generated created_at values therefore need not
 * be equal. A generic clock tolerance would also bless unrelated rows, so the
 * legacy exception is available only when the immutable order and the complete
 * funding bundle form one exact financial fingerprint inside the order's
 * paid-to-completed lifecycle.
 */
function legacyRechargeOrderFingerprintMismatch(
  paidTransaction: BalanceLedgerRepairTransaction,
  bonusTransactions: BalanceLedgerRepairTransaction[],
  grant: BalanceLedgerRepairGrant,
  orders: BalanceLedgerRepairOrderEvidence[],
  billingAccountId: string,
): string | null {
  const matches = orders.filter((order) => order.id === paidTransaction.orderId);
  if (matches.length !== 1) return `ORDER_EVIDENCE_MATCH_${matches.length}`;
  const order = matches[0];
  const orderCreatedAt = validIsoInstant(order.createdAt);
  const paidAt = validIsoInstant(order.paidAt);
  const completedAt = validIsoInstant(order.completedAt);
  if (
    orderCreatedAt === null
    || paidAt === null
    || completedAt === null
    || orderCreatedAt > paidAt
    || paidAt > completedAt
  ) {
    return 'ORDER_LIFECYCLE_INVALID';
  }
  if (
    order.orderType !== 'RECHARGE'
    || order.status !== 'COMPLETED'
    || order.refundedAt !== null
    || order.refundAmountCents !== null
  ) {
    return 'ORDER_STATE_INVALID';
  }
  if (!/^[a-z]{3}$/.test(order.currency.trim().toLowerCase())) {
    return 'ORDER_CURRENCY_INVALID';
  }
  if (
    order.userId !== paidTransaction.userId
    || order.tenantId !== paidTransaction.tenantId
    || order.billingAccountId !== billingAccountId
    || (order.productId ?? null) !== (paidTransaction.productId ?? null)
  ) {
    return 'ORDER_SUBJECT_MISMATCH';
  }
  if (
    paidTransaction.operationKey !== null
    || bonusTransactions.some((transaction) => transaction.operationKey !== null)
  ) {
    return 'LEGACY_OPERATION_KEY_PRESENT';
  }
  if (
    !Number.isSafeInteger(order.amountCents)
    || order.amountCents <= 0
    || !Number.isSafeInteger(order.bonusCents)
    || order.bonusCents < 0
    || !decimal(order.amountCents).div(100).eq(paidTransaction.amountUsd)
    || !decimal(order.amountCents).div(100).eq(grant.paidAmountUsd)
    || !decimal(order.bonusCents).div(100).eq(grant.bonusAmountUsd)
    || bonusTransactions.length !== (order.bonusCents > 0 ? 1 : 0)
    || !bonusTransactions.reduce((sum, row) => sum.plus(row.amountUsd), ZERO)
      .eq(decimal(order.bonusCents).div(100))
  ) {
    return 'ORDER_AMOUNT_MISMATCH';
  }
  const bundleInstants = [
    validIsoInstant(paidTransaction.createdAt),
    validIsoInstant(grant.createdAt),
    validIsoInstant(grant.validFrom),
    ...bonusTransactions.map((transaction) => validIsoInstant(transaction.createdAt)),
  ];
  if (
    bundleInstants.some((instant) => instant === null)
    || bundleInstants.some((instant) => instant! < paidAt || instant! > completedAt)
  ) {
    return 'ORDER_FULFILLMENT_WINDOW_MISMATCH';
  }
  if (validIsoInstant(grant.validFrom)! > validIsoInstant(grant.createdAt)!) {
    return 'VALID_FROM_AFTER_CREATION';
  }
  if (grant.expiresAt != null) {
    const validFrom = validIsoInstant(grant.validFrom);
    const expiresAt = validIsoInstant(grant.expiresAt);
    if (validFrom === null || expiresAt === null || expiresAt <= validFrom) {
      return 'EXPIRY_WINDOW_INVALID';
    }
  }
  return null;
}

function rechargeGrantGrossMismatch(grant: BalanceLedgerRepairGrant): string | null {
  const paid = decimal(grant.paidAmountUsd);
  const bonus = decimal(grant.bonusAmountUsd);
  const granted = decimal(grant.grantedAmountUsd);
  if (
    grant.source !== 'RECHARGE'
    || paid.lt(0)
    || bonus.lt(0)
    || !paid.plus(bonus).eq(granted)
  ) {
    return 'GRANT_GROSS_MISMATCH';
  }
  return null;
}

function fundingGrantSubjectMismatch(
  transaction: BalanceLedgerRepairTransaction,
  grant: BalanceLedgerRepairGrant,
): boolean {
  return !transaction.userId
    || !transaction.tenantId
    || !grant.userId
    || !grant.tenantId
    || transaction.userId !== grant.userId
    || transaction.tenantId !== grant.tenantId
    || (transaction.productId ?? null) !== (grant.productId ?? null);
}

function explicitAdminRechargeFundingMismatch(
  transaction: BalanceLedgerRepairTransaction,
  grant: BalanceLedgerRepairGrant,
): string | null {
  const grossMismatch = rechargeGrantGrossMismatch(grant);
  if (grossMismatch) return grossMismatch;
  const timingMismatch = grantIssuanceTimingMismatch(
    transaction,
    grant,
    'AT_OR_AFTER_CREATION',
  );
  if (timingMismatch) return timingMismatch;
  if (
    fundingGrantSubjectMismatch(transaction, grant)
    || transaction.type !== 'RECHARGE'
    || transaction.orderId !== null
    || grant.orderId !== null
    || decimal(grant.paidAmountUsd).eq(transaction.amountUsd) === false
    || !decimal(grant.bonusAmountUsd).eq(0)
    || !decimal(grant.grantedAmountUsd).eq(transaction.amountUsd)
  ) {
    return 'IMMUTABLE_LINK_MISMATCH';
  }
  return null;
}

type LegacyVoucherReceipt = {
  transaction: {
    id: string;
    type: string;
    userId: string;
    tenantId: string;
    amountUsd: number;
    createdAt: string;
    productId: string | null;
    amountCents: number;
    description: string;
    balanceAfterUsd: number;
    balanceAfterCents: number;
  };
  grant: {
    id: string;
    source: string;
    expiresAt: string | null;
    productId: string | null;
    amountCents: number;
    discountRate: number;
    remainingCents: number;
    paidAmountCents: number;
    bonusAmountCents: number;
  };
};

function exactRecord(
  value: unknown,
  keys: readonly string[],
): Record<string, unknown> | null {
  if (!value || typeof value !== 'object' || Array.isArray(value)) return null;
  const record = value as Record<string, unknown>;
  const actualKeys = Object.keys(record).sort();
  const expectedKeys = [...keys].sort();
  return actualKeys.length === expectedKeys.length
    && actualKeys.every((key, index) => key === expectedKeys[index])
    ? record
    : null;
}

function finiteJsonNumber(value: unknown): value is number {
  return typeof value === 'number' && Number.isFinite(value);
}

function parseLegacyVoucherReceipt(value: unknown): LegacyVoucherReceipt | null {
  const result = exactRecord(value, ['grant', 'transaction']);
  const transaction = exactRecord(result?.transaction, [
    'id', 'type', 'userId', 'tenantId', 'amountUsd', 'createdAt', 'productId',
    'amountCents', 'description', 'balanceAfterUsd', 'balanceAfterCents',
  ]);
  const grant = exactRecord(result?.grant, [
    'id', 'source', 'expiresAt', 'productId', 'amountCents', 'discountRate',
    'remainingCents', 'paidAmountCents', 'bonusAmountCents',
  ]);
  if (!transaction || !grant) return null;
  if (
    typeof transaction.id !== 'string'
    || typeof transaction.type !== 'string'
    || typeof transaction.userId !== 'string'
    || typeof transaction.tenantId !== 'string'
    || !finiteJsonNumber(transaction.amountUsd)
    || typeof transaction.createdAt !== 'string'
    || !(typeof transaction.productId === 'string' || transaction.productId === null)
    || !finiteJsonNumber(transaction.amountCents)
    || typeof transaction.description !== 'string'
    || !finiteJsonNumber(transaction.balanceAfterUsd)
    || !finiteJsonNumber(transaction.balanceAfterCents)
    || typeof grant.id !== 'string'
    || typeof grant.source !== 'string'
    || !(typeof grant.expiresAt === 'string' || grant.expiresAt === null)
    || !(typeof grant.productId === 'string' || grant.productId === null)
    || !finiteJsonNumber(grant.amountCents)
    || !finiteJsonNumber(grant.discountRate)
    || !finiteJsonNumber(grant.remainingCents)
    || !finiteJsonNumber(grant.paidAmountCents)
    || !finiteJsonNumber(grant.bonusAmountCents)
  ) return null;
  return {
    transaction: transaction as LegacyVoucherReceipt['transaction'],
    grant: grant as LegacyVoucherReceipt['grant'],
  };
}

function roundedCents(value: Prisma.Decimal.Value): number {
  return decimal(value).mul(100)
    .toDecimalPlaces(0, Prisma.Decimal.ROUND_HALF_UP)
    .toNumber();
}

type LegacyAdminFundingTransactionReceipt = {
  id: string;
  userId: string;
  tenantId: string | null;
  productId: string | null;
  type: string;
  amountCents: number;
  balanceAfterCents: number;
  amountUsd: number;
  balanceAfterUsd: number;
  description: string;
  createdAt: string;
};

type ParsedLegacyAdminFundingReceipt = {
  response: LegacyAdminFundingTransactionReceipt;
};

const LEGACY_ADMIN_FUNDING_RESPONSE_KEYS = [
  'id', 'userId', 'tenantId', 'productId', 'type', 'amountCents',
  'balanceAfterCents', 'amountUsd', 'balanceAfterUsd', 'description', 'createdAt',
] as const;

function parseLegacyAdminFundingTransactionReceipt(
  value: unknown,
): LegacyAdminFundingTransactionReceipt | null {
  const response = exactRecord(value, LEGACY_ADMIN_FUNDING_RESPONSE_KEYS);
  if (
    !response
    || typeof response.id !== 'string'
    || typeof response.userId !== 'string'
    || !(typeof response.tenantId === 'string' || response.tenantId === null)
    || !(typeof response.productId === 'string' || response.productId === null)
    || typeof response.type !== 'string'
    || !Number.isSafeInteger(response.amountCents)
    || !Number.isSafeInteger(response.balanceAfterCents)
    || !finiteJsonNumber(response.amountUsd)
    || !finiteJsonNumber(response.balanceAfterUsd)
    || typeof response.description !== 'string'
    || typeof response.createdAt !== 'string'
  ) return null;
  return response as LegacyAdminFundingTransactionReceipt;
}

function parseLegacyAdminFundingReceipt(value: unknown): ParsedLegacyAdminFundingReceipt | null {
  const direct = parseLegacyAdminFundingTransactionReceipt(value);
  return direct ? { response: direct } : null;
}

function utcDaysAfter(value: string, days: number): string | null {
  const millis = validIsoInstant(value);
  if (millis === null) return null;
  const date = new Date(millis);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

type LegacyAdminFundingProofMapEntry = {
  nature: 'PAID';
  balanceGrantId: string;
  // The old writer settled debt before the no-order recharge grant existed;
  // an old ADJUST never had a grant at all. Preserve that immutable settlement
  // shape while separately replaying the proven gross through the grant pool.
  settlementBalanceGrantId: null;
  action: 'CREATE_GRANT' | 'LINK_GRANT';
};

type LegacyAdminFundingProofPlan = {
  proofByTransactionId: Map<string, LegacyAdminFundingProofMapEntry>;
  repairs: BalanceLedgerLegacyAdminFundingRepair[];
  virtualGrants: BalanceLedgerRepairGrant[];
  reasons: string[];
};

function legacyAdminFundingReceiptMismatch(
  evidence: BalanceLedgerRepairLegacyAdminFundingIdempotencyEvidence,
  receipt: ParsedLegacyAdminFundingReceipt,
  transaction: BalanceLedgerRepairTransaction,
  snapshot: BalanceLedgerRepairSnapshot,
): string | null {
  const response = receipt.response;
  const evidenceCreatedAt = validIsoInstant(evidence.createdAt);
  const evidenceExpiresAt = validIsoInstant(evidence.expiresAt);
  const transactionCreatedAt = validIsoInstant(transaction.createdAt);
  const expectedType = evidence.scope === 'admin:adjust-balance' ? 'ADJUST' : 'RECHARGE';
  const amountUsd = decimal(transaction.amountUsd);
  const balanceAfterUsd = decimal(transaction.balanceAfterUsd);
  const exactCentAmount = decimal(roundedCents(amountUsd)).div(100).eq(amountUsd);
  const expectedKeyPrefix = `${LEGACY_ADMIN_FUNDING_KEY_PREFIX}${snapshot.billingAccountId}:`;
  if (
    evidence.status !== 'COMMITTED'
    || (evidence.scope !== 'admin:adjust-balance' && evidence.scope !== 'admin:recharge')
    || evidence.userId !== transaction.userId
    || !evidence.key.startsWith(expectedKeyPrefix)
    || evidence.key.length <= expectedKeyPrefix.length
    || evidence.key.length > 160
    || /\s/.test(evidence.key)
    || !/^[a-f0-9]{64}$/.test(evidence.snapshotSha256)
    || /^0{64}$/.test(evidence.snapshotSha256)
    || evidenceCreatedAt === null
    || evidenceExpiresAt === null
    || transactionCreatedAt === null
    || evidenceCreatedAt > transactionCreatedAt
    || transactionCreatedAt >= evidenceExpiresAt
    || !transaction.userId
    || !transaction.tenantId
    || transaction.type !== expectedType
    || decimal(transaction.amountUsd).lte(0)
    || transaction.orderId !== null
    || transaction.operationKey !== null
    || (transaction.tokenUsageId ?? null) !== null
    || response.id !== transaction.id
    || response.userId !== transaction.userId
    || response.tenantId !== transaction.tenantId
    || response.productId !== (transaction.productId ?? null)
    || response.type !== transaction.type
    || response.amountCents !== roundedCents(amountUsd)
    || response.balanceAfterCents !== roundedCents(balanceAfterUsd)
    || !decimal(response.amountUsd).eq(amountUsd)
    || !decimal(response.balanceAfterUsd).eq(balanceAfterUsd)
    || response.description !== transaction.description
    || response.createdAt !== normalizedIsoInstant(transaction.createdAt)
    || !exactCentAmount
  ) return 'RECEIPT_TRANSACTION_MISMATCH';

  return null;
}

function legacyAdminFundingGrantCandidateMismatch(
  transaction: BalanceLedgerRepairTransaction,
  grant: BalanceLedgerRepairGrant,
): string | null {
  const transactionAt = validIsoInstant(transaction.createdAt);
  const validFrom = validIsoInstant(grant.validFrom);
  const grantCreatedAt = validIsoInstant(grant.createdAt);
  const expectedExpiresAt = grant.validFrom
    ? utcDaysAfter(grant.validFrom, RECHARGE_VALIDITY_DAYS)
    : null;
  if (
    transactionAt === null
    || validFrom === null
    || grantCreatedAt === null
    || expectedExpiresAt === null
    || transactionAt > validFrom
    || validFrom > grantCreatedAt
    || normalizedIsoInstant(grant.expiresAt) !== expectedExpiresAt
  ) return 'LEGACY_WRITER_TIMING_INVALID';
  if (
    fundingGrantSubjectMismatch(transaction, grant)
    || grant.orderId !== null
    || grant.source !== 'RECHARGE'
    || !decimal(grant.paidAmountUsd).eq(transaction.amountUsd)
    || !decimal(grant.bonusAmountUsd).eq(0)
    || !decimal(grant.grantedAmountUsd).eq(transaction.amountUsd)
  ) return 'LEGACY_WRITER_GRANT_SHAPE_INVALID';
  return null;
}

function legacyAdminRechargeGrantMismatch(
  transaction: BalanceLedgerRepairTransaction,
  grant: BalanceLedgerRepairGrant,
): string | null {
  const candidateMismatch = legacyAdminFundingGrantCandidateMismatch(transaction, grant);
  if (candidateMismatch) return candidateMismatch;
  const transactionAt = validIsoInstant(transaction.createdAt);
  const grantCreatedAt = validIsoInstant(grant.createdAt);
  if (
    transactionAt === null
    || grantCreatedAt === null
    || grantCreatedAt <= transactionAt
  ) return 'LEGACY_WRITER_TIMING_INVALID';
  if (
    !decimal(grant.discountRate).eq(1)
    || grant.isExpired
    || !/^[a-f0-9]{64}$/.test(grant.snapshotSha256 ?? '')
    || /^0{64}$/.test(grant.snapshotSha256 ?? '')
  ) return 'LEGACY_WRITER_GRANT_SHAPE_INVALID';
  return null;
}

function buildLegacyAdminFundingProofPlan(
  snapshot: BalanceLedgerRepairSnapshot,
): LegacyAdminFundingProofPlan {
  const proofByTransactionId = new Map<string, LegacyAdminFundingProofMapEntry>();
  const repairs: BalanceLedgerLegacyAdminFundingRepair[] = [];
  const virtualGrants: BalanceLedgerRepairGrant[] = [];
  const reasons: string[] = [];
  const usedGrantIds = new Set<string>();
  const usedTransactionIds = new Set<string>();
  const evidenceRows = snapshot.legacyAdminFundingIdempotencyEvidence ?? [];

  if (evidenceRows.length > 0 && snapshot.accountType !== 'enterprise') {
    reasons.push('LEGACY_ADMIN_FUNDING_PROOF_ACCOUNT_NOT_ENTERPRISE');
  }
  if (
    evidenceRows.length > 0
    && (snapshot.ledgerStatus !== 'LEGACY_DIRTY' || snapshot.ledgerVersion !== 0)
  ) {
    reasons.push(
      `LEGACY_ADMIN_FUNDING_PROOF_ACCOUNT_STATE_INVALID:`
        + `${snapshot.ledgerStatus}:${snapshot.ledgerVersion}`,
    );
  }
  for (const evidence of [...evidenceRows].sort((left, right) => (
    left.scope.localeCompare(right.scope) || left.key.localeCompare(right.key)
  ))) {
    const parsed = parseLegacyAdminFundingReceipt(evidence.result);
    if (!parsed) {
      reasons.push(`LEGACY_ADMIN_FUNDING_RECEIPT_SCHEMA_INVALID:${evidence.scope}:${evidence.key}`);
      continue;
    }
    const transactionMatches = snapshot.transactions.filter(
      (transaction) => transaction.id === parsed.response.id,
    );
    if (transactionMatches.length !== 1) {
      reasons.push(
        `LEGACY_ADMIN_FUNDING_TRANSACTION_MATCH_${transactionMatches.length}:`
          + `${evidence.scope}:${evidence.key}:${parsed.response.id}`,
      );
      continue;
    }
    const transaction = transactionMatches[0];
    const receiptMismatch = legacyAdminFundingReceiptMismatch(
      evidence,
      parsed,
      transaction,
      snapshot,
    );
    if (receiptMismatch) {
      reasons.push(
        `LEGACY_ADMIN_FUNDING_${receiptMismatch}:${evidence.scope}:${evidence.key}:`
          + `${transaction.id}`,
      );
      continue;
    }
    if (usedTransactionIds.has(transaction.id)) {
      reasons.push(`LEGACY_ADMIN_FUNDING_TRANSACTION_EVIDENCE_DUPLICATE:${transaction.id}`);
      continue;
    }

    const amountUsd = decimal(transaction.amountUsd);
    const balanceBeforeUsd = decimal(transaction.balanceAfterUsd).minus(amountUsd);
    const holeFillUsd = Prisma.Decimal.min(
      amountUsd,
      Prisma.Decimal.max(balanceBeforeUsd.neg(), ZERO),
    );
    const initialRemainingUsd = amountUsd.minus(holeFillUsd);
    const idempotencyScope = evidence.scope as 'admin:adjust-balance' | 'admin:recharge';
    const action = idempotencyScope === 'admin:adjust-balance' ? 'CREATE_GRANT' : 'LINK_GRANT';
    let grant: BalanceLedgerRepairGrant;
    if (action === 'CREATE_GRANT') {
      const grantId = `${LEGACY_ADMIN_FUNDING_GRANT_PREFIX}${transaction.id}`;
      const expiresAt = utcDaysAfter(transaction.createdAt, RECHARGE_VALIDITY_DAYS);
      // Do not match arbitrary future grants by amount. A later independent
      // admin recharge can legitimately have the same subject and amount; its
      // own receipt/LINK proof funds it. A truly orphan existing grant remains
      // fail-closed in the complete canonical funding-gross replay below.
      if (snapshot.grants.some((candidate) => candidate.id === grantId)) {
        reasons.push(`LEGACY_ADMIN_FUNDING_CREATE_GRANT_ID_EXISTS:${transaction.id}:${grantId}`);
        continue;
      }
      if (!expiresAt) {
        reasons.push(`LEGACY_ADMIN_FUNDING_CREATE_GRANT_TIME_INVALID:${transaction.id}`);
        continue;
      }
      grant = {
        id: grantId,
        userId: transaction.userId!,
        tenantId: transaction.tenantId!,
        productId: transaction.productId ?? null,
        orderId: null,
        source: 'RECHARGE',
        paidAmountUsd: money(amountUsd),
        bonusAmountUsd: money(0),
        grantedAmountUsd: money(amountUsd),
        remainingAmountUsd: money(initialRemainingUsd),
        remainingPaidAmountUsd: money(initialRemainingUsd),
        remainingBonusAmountUsd: money(0),
        discountRate: money(1),
        isExpired: false,
        validFrom: new Date(transaction.createdAt).toISOString(),
        expiresAt,
        createdAt: new Date(transaction.createdAt).toISOString(),
      };
      virtualGrants.push(grant);
    } else {
      const candidates = snapshot.grants.filter(
        (candidate) => legacyAdminRechargeGrantMismatch(transaction, candidate) === null,
      );
      if (candidates.length !== 1) {
        reasons.push(
          `LEGACY_ADMIN_FUNDING_LINK_GRANT_MATCH_${candidates.length}:${transaction.id}`,
        );
        continue;
      }
      grant = candidates[0];
      if (usedGrantIds.has(grant.id)) {
        reasons.push(`LEGACY_ADMIN_FUNDING_LINK_GRANT_DUPLICATE:${transaction.id}:${grant.id}`);
        continue;
      }
      usedGrantIds.add(grant.id);
    }

    usedTransactionIds.add(transaction.id);
    const idempotencyEvidenceHash = evidence.snapshotSha256;
    const proofHash = createHash('sha256').update(JSON.stringify(stableValue({
      repairKind: LEGACY_ADMIN_FUNDING_REPAIR_KIND,
      action,
      billingAccountId: snapshot.billingAccountId,
      evidence,
      transaction,
      grant: action === 'LINK_GRANT' ? grant : null,
    }))).digest('hex');
    repairs.push({
      repairKind: LEGACY_ADMIN_FUNDING_REPAIR_KIND,
      action,
      idempotencyKey: evidence.key,
      idempotencyScope,
      idempotencyEvidenceHash,
      proofHash,
      transactionId: transaction.id,
      grantId: grant.id,
      userId: transaction.userId!,
      tenantId: transaction.tenantId!,
      billingAccountId: snapshot.billingAccountId,
      productId: transaction.productId ?? null,
      amountUsd: money(amountUsd),
      initialRemainingAmountUsd: money(initialRemainingUsd),
      expectedGrantSnapshotHash: action === 'LINK_GRANT'
        ? grant.snapshotSha256!
        : null,
      expectedGrantRemainingAmountUsd: action === 'LINK_GRANT'
        ? money(grant.remainingAmountUsd)
        : null,
      expectedGrantRemainingPaidAmountUsd: action === 'LINK_GRANT'
        ? (grant.remainingPaidAmountUsd === null ? null : money(grant.remainingPaidAmountUsd))
        : null,
      expectedGrantRemainingBonusAmountUsd: action === 'LINK_GRANT'
        ? (grant.remainingBonusAmountUsd === null ? null : money(grant.remainingBonusAmountUsd))
        : null,
      finalRemainingAmountUsd: money(initialRemainingUsd),
      finalRemainingPaidAmountUsd: money(initialRemainingUsd),
      finalRemainingBonusAmountUsd: money(0),
      validFrom: new Date(grant.validFrom!).toISOString(),
      expiresAt: new Date(grant.expiresAt!).toISOString(),
      createdAt: new Date(grant.createdAt).toISOString(),
    });
    proofByTransactionId.set(transaction.id, {
      nature: 'PAID',
      balanceGrantId: grant.id,
      settlementBalanceGrantId: null,
      action,
    });
  }
  repairs.sort((left, right) => left.transactionId.localeCompare(right.transactionId));
  virtualGrants.sort((left, right) => left.id.localeCompare(right.id));
  return { proofByTransactionId, repairs, virtualGrants, reasons };
}

function voucherEvidenceCandidates(
  transaction: BalanceLedgerRepairTransaction,
  grant: BalanceLedgerRepairGrant,
  evidenceRows: BalanceLedgerRepairVoucherIdempotencyEvidence[],
): BalanceLedgerRepairVoucherIdempotencyEvidence[] {
  return evidenceRows.filter((evidence) => {
    const result = evidence.result && typeof evidence.result === 'object' && !Array.isArray(evidence.result)
      ? evidence.result as Record<string, unknown>
      : null;
    const response = result?.response && typeof result.response === 'object'
      && !Array.isArray(result.response)
      ? result.response as Record<string, unknown>
      : null;
    const resultTransaction = result?.transaction && typeof result.transaction === 'object'
      && !Array.isArray(result.transaction)
      ? result.transaction as Record<string, unknown>
      : null;
    const resultGrant = result?.grant && typeof result.grant === 'object'
      && !Array.isArray(result.grant)
      ? result.grant as Record<string, unknown>
      : null;
    const responseTransaction = response?.transaction && typeof response.transaction === 'object'
      && !Array.isArray(response.transaction)
      ? response.transaction as Record<string, unknown>
      : null;
    const responseGrant = response?.grant && typeof response.grant === 'object'
      && !Array.isArray(response.grant)
      ? response.grant as Record<string, unknown>
      : null;
    return resultTransaction?.id === transaction.id
      || resultGrant?.id === grant.id
      || responseTransaction?.id === transaction.id
      || responseGrant?.id === grant.id;
  });
}

function legacyVoucherWriterFingerprintMismatch(
  transaction: BalanceLedgerRepairTransaction,
  grant: BalanceLedgerRepairGrant,
  evidenceRows: BalanceLedgerRepairVoucherIdempotencyEvidence[],
  receiptRemainingMode: 'NET_OF_HOLE' | 'FULL_AMOUNT' = 'NET_OF_HOLE',
): string | null {
  const candidates = voucherEvidenceCandidates(transaction, grant, evidenceRows);
  if (candidates.length !== 1) return `IDEMPOTENCY_EVIDENCE_MATCH_${candidates.length}`;
  const evidence = candidates[0];
  const receipt = parseLegacyVoucherReceipt(evidence.result);
  if (!receipt) return 'IDEMPOTENCY_RECEIPT_SCHEMA_INVALID';

  const evidenceCreatedAt = validIsoInstant(evidence.createdAt);
  const evidenceExpiresAt = validIsoInstant(evidence.expiresAt);
  const validFrom = validIsoInstant(grant.validFrom);
  const grantCreatedAt = validIsoInstant(grant.createdAt);
  const transactionCreatedAt = validIsoInstant(transaction.createdAt);
  const grantExpiresAt = grant.expiresAt == null ? null : validIsoInstant(grant.expiresAt);
  if (
    evidenceCreatedAt === null
    || evidenceExpiresAt === null
    || validFrom === null
    || grantCreatedAt === null
    || transactionCreatedAt === null
    || evidenceCreatedAt > validFrom
    || validFrom > grantCreatedAt
    || grantCreatedAt > transactionCreatedAt
    || transactionCreatedAt >= evidenceExpiresAt
    || (grant.expiresAt != null && (grantExpiresAt === null || grantExpiresAt <= validFrom))
  ) return 'LEGACY_WRITER_TIMING_INVALID';

  const amountUsd = decimal(transaction.amountUsd);
  const balanceAfterUsd = decimal(transaction.balanceAfterUsd);
  const balanceBeforeUsd = balanceAfterUsd.minus(amountUsd);
  const holeFillUsd = Prisma.Decimal.min(
    amountUsd,
    Prisma.Decimal.max(balanceBeforeUsd.neg(), ZERO),
  );
  const issuanceRemainingUsd = amountUsd.minus(holeFillUsd);
  const amountCents = roundedCents(amountUsd);
  const exactCentAmount = decimal(amountCents).div(100).eq(amountUsd);
  if (
    evidence.scope !== 'admin:issue-voucher'
    || evidence.status !== 'COMMITTED'
    || evidence.userId !== transaction.userId
    || evidence.key.length === 0
    || evidence.key.length > 160
    || /\s/.test(evidence.key)
    || transaction.operationKey !== null
    || receipt.transaction.id !== transaction.id
    || receipt.transaction.type !== transaction.type
    || receipt.transaction.userId !== transaction.userId
    || receipt.transaction.tenantId !== transaction.tenantId
    || receipt.transaction.productId !== (transaction.productId ?? null)
    || receipt.transaction.createdAt !== new Date(transaction.createdAt).toISOString()
    || receipt.transaction.description !== transaction.description
    || !decimal(receipt.transaction.amountUsd).eq(amountUsd)
    || !decimal(receipt.transaction.balanceAfterUsd).eq(balanceAfterUsd)
    || receipt.transaction.amountCents !== amountCents
    || receipt.transaction.balanceAfterCents !== roundedCents(balanceAfterUsd)
    || receipt.grant.id !== grant.id
    || receipt.grant.source !== grant.source
    || receipt.grant.productId !== (grant.productId ?? null)
    || receipt.grant.expiresAt !== (grant.expiresAt == null
      ? null
      : new Date(grant.expiresAt).toISOString())
    || receipt.grant.amountCents !== amountCents
    || receipt.grant.discountRate !== 0
    || receipt.grant.remainingCents !== (
      receiptRemainingMode === 'FULL_AMOUNT'
        ? amountCents
        : roundedCents(issuanceRemainingUsd)
    )
    || receipt.grant.paidAmountCents !== 0
    || receipt.grant.bonusAmountCents !== amountCents
    || !exactCentAmount
  ) return 'IDEMPOTENCY_RECEIPT_MISMATCH';
  return null;
}

function strictLegacyVoucherDescriptionMatches(
  transaction: BalanceLedgerRepairTransaction,
  grant: BalanceLedgerRepairGrant,
): boolean {
  const escapedGrantId = grant.id.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
  return new RegExp(`^voucher:${escapedGrantId} admin:[^\\s]+(?: \\S(?:.*\\S)?)?$`)
    .test(transaction.description);
}

function legacyVoucherProofCandidate(
  transaction: BalanceLedgerRepairTransaction,
  grant: BalanceLedgerRepairGrant,
  evidenceRows: BalanceLedgerRepairVoucherIdempotencyEvidence[],
  allowExpiredVoucherProof: boolean,
): { mutation: BalanceLedgerLegacyVoucherProofMutation | null; reason: string | null } {
  const transactionCreatedAt = validIsoInstant(transaction.createdAt);
  const grantCreatedAt = validIsoInstant(grant.createdAt);
  const validFrom = validIsoInstant(grant.validFrom);
  const expiresAt = grant.expiresAt == null ? null : validIsoInstant(grant.expiresAt);
  const amountUsd = decimal(transaction.amountUsd);
  const walletAfterUsd = decimal(transaction.balanceAfterUsd);
  const walletBeforeUsd = walletAfterUsd.minus(amountUsd);
  const holeFillUsd = Prisma.Decimal.min(
    amountUsd,
    Prisma.Decimal.max(walletBeforeUsd.neg(), ZERO),
  );
  const candidates = voucherEvidenceCandidates(transaction, grant, evidenceRows);
  const exactCentAmount = decimal(roundedCents(amountUsd)).div(100).eq(amountUsd);
  const remainingComponentsValid = (
    grant.remainingPaidAmountUsd === null
    && grant.remainingBonusAmountUsd === null
  ) || (
    grant.remainingPaidAmountUsd !== null
    && grant.remainingBonusAmountUsd !== null
    && decimal(grant.remainingPaidAmountUsd)
      .plus(grant.remainingBonusAmountUsd)
      .eq(grant.remainingAmountUsd)
  );
  if (
    transactionCreatedAt === null
    || grantCreatedAt === null
    || validFrom === null
    || validFrom > grantCreatedAt
    || grantCreatedAt >= transactionCreatedAt
    || (grant.expiresAt != null && (expiresAt === null || expiresAt <= validFrom))
  ) {
    return { mutation: null, reason: 'PROOF_TIMING_INVALID' };
  }
  if (
    transaction.operationKey !== null
    || !strictLegacyVoucherDescriptionMatches(transaction, grant)
    || !exactCentAmount
    || !remainingComponentsValid
  ) {
    return { mutation: null, reason: 'PROOF_WRITER_SHAPE_INVALID' };
  }

  const common = {
    proofVersion: 1 as const,
    transactionId: transaction.id,
    grantId: grant.id,
    walletBeforeUsd: money(walletBeforeUsd),
    walletAfterUsd: money(walletAfterUsd),
    holeFillUsd: money(holeFillUsd),
    mintedGrantAmountUsd: money(amountUsd.minus(holeFillUsd)),
    expectedTransaction: transaction,
    expectedGrant: grant,
    openingDebtAllocationIds: [] as string[],
  };
  if (walletBeforeUsd.eq(0) && !grant.isExpired && candidates.length === 0) {
    return {
      mutation: {
        ...common,
        repairKind: 'LEGACY_PRE_IDEMPOTENCY_VOUCHER_V1',
        expectedIdempotencyEvidence: [],
      },
      reason: null,
    };
  }
  if (
    walletBeforeUsd.gte(0)
    && grant.isExpired
    && allowExpiredVoucherProof
    && candidates.length === 0
  ) {
    return {
      mutation: {
        ...common,
        repairKind: 'LEGACY_PRE_IDEMPOTENCY_EXPIRED_VOUCHER_V1',
        expectedIdempotencyEvidence: [],
      },
      reason: null,
    };
  }
  if (
    walletBeforeUsd.lt(0)
    && !grant.isExpired
    && holeFillUsd.gt(0)
    && candidates.length === 1
  ) {
    const mismatch = legacyVoucherWriterFingerprintMismatch(
      transaction,
      grant,
      candidates,
      'FULL_AMOUNT',
    );
    if (mismatch === null) {
      return {
        mutation: {
          ...common,
          repairKind: 'LEGACY_VOUCHER_FULL_REMAINDER_DEBT_ABSORPTION_V1',
          expectedIdempotencyEvidence: candidates,
        },
        reason: null,
      };
    }
    return { mutation: null, reason: `FULL_REMAINDER_RECEIPT_${mismatch}` };
  }
  return {
    mutation: null,
    reason: `PROOF_MODE_MISMATCH:before=${money(walletBeforeUsd)}:evidence=${candidates.length}`,
  };
}

function voucherFundingMismatch(
  transaction: BalanceLedgerRepairTransaction,
  grant: BalanceLedgerRepairGrant,
  transactions: BalanceLedgerRepairTransaction[],
  idempotencyEvidence: BalanceLedgerRepairVoucherIdempotencyEvidence[],
  allowPersonalRepairProof: boolean,
  allowExpiredVoucherProof: boolean,
): string | null {
  const voucherId = canonicalVoucherGrantId(transaction.description);
  const voucherTransactions = transactions.filter(
    (candidate) => canonicalVoucherGrantId(candidate.description) === grant.id,
  );
  const validOperationKey = transaction.operationKey == null
    || transaction.operationKey === `balance:voucher:grant:${grant.id}`;
  if (
    voucherId !== grant.id
    || fundingGrantSubjectMismatch(transaction, grant)
    || transaction.type !== 'ADJUST'
    || transaction.orderId !== null
    || !validOperationKey
    || grant.source !== 'VOUCHER'
    || grant.orderId !== null
    || !decimal(grant.paidAmountUsd).eq(0)
    || !decimal(grant.bonusAmountUsd).eq(transaction.amountUsd)
    || !decimal(grant.grantedAmountUsd).eq(transaction.amountUsd)
    || !decimal(grant.discountRate).eq(0)
    || voucherTransactions.length !== 1
    || voucherTransactions[0].id !== transaction.id
  ) {
    return 'IMMUTABLE_LINK_MISMATCH';
  }
  const timingMismatch = grantIssuanceTimingMismatch(
    transaction,
    grant,
    'AT_OR_AFTER_CREATION',
  );
  if (timingMismatch) {
    if (timingMismatch !== 'CREATED_AT_MISMATCH') return timingMismatch;
    const legacyMismatch = legacyVoucherWriterFingerprintMismatch(
      transaction,
      grant,
      idempotencyEvidence,
    );
    if (legacyMismatch) {
      if (!allowPersonalRepairProof) {
        return `CREATED_AT_MISMATCH:${legacyMismatch}:PERSONAL_PROOF_ACCOUNT_TYPE_REQUIRED`;
      }
      const proof = legacyVoucherProofCandidate(
        transaction,
        grant,
        idempotencyEvidence,
        allowExpiredVoucherProof,
      );
      if (!proof.mutation) {
        return `CREATED_AT_MISMATCH:${legacyMismatch}:${proof.reason ?? 'PROOF_MISSING'}`;
      }
    }
  }
  return null;
}

function planLegacyVoucherProofMutations(
  snapshot: BalanceLedgerRepairSnapshot,
  ordered: OrderedTransaction[],
  accountType: SupportedAccountType,
  legacyExpiredVoucherGrantIds: ReadonlySet<string>,
): { mutations: BalanceLedgerLegacyVoucherProofMutation[]; reasons: string[] } {
  if (accountType !== 'personal') return { mutations: [], reasons: [] };
  const reasons: string[] = [];
  const mutations: BalanceLedgerLegacyVoucherProofMutation[] = [];
  const orderedById = new Map(ordered.map((transaction) => [transaction.id, transaction]));
  const seenGrantIds = new Set<string>();
  for (const transaction of snapshot.transactions) {
    const grantId = canonicalVoucherGrantId(transaction.description);
    if (!grantId) continue;
    const grants = snapshot.grants.filter((grant) => grant.id === grantId);
    if (grants.length !== 1) continue;
    const grant = grants[0];
    if (
      grantIssuanceTimingMismatch(transaction, grant, 'AT_OR_AFTER_CREATION')
        !== 'CREATED_AT_MISMATCH'
    ) continue;
    const proof = legacyVoucherProofCandidate(
      transaction,
      grant,
      snapshot.voucherIdempotencyEvidence,
      legacyExpiredVoucherGrantIds.has(grant.id),
    );
    if (!proof.mutation) continue;
    const orderedTransaction = orderedById.get(transaction.id);
    if (
      !orderedTransaction
      || !orderedTransaction.beforeUsd.eq(proof.mutation.walletBeforeUsd)
      || !orderedTransaction.afterUsd.eq(proof.mutation.walletAfterUsd)
    ) {
      reasons.push(`LEGACY_VOUCHER_PROOF_WALLET_PATH_MISMATCH:${transaction.id}`);
      continue;
    }
    if (seenGrantIds.has(grant.id)) {
      reasons.push(`LEGACY_VOUCHER_PROOF_GRANT_REUSED:${grant.id}`);
      continue;
    }
    seenGrantIds.add(grant.id);
    mutations.push(proof.mutation);
  }
  return {
    mutations: mutations.sort((left, right) => left.transactionId.localeCompare(right.transactionId)),
    reasons,
  };
}

function rechargeOrderFundingMismatch(
  transaction: BalanceLedgerRepairTransaction,
  nature: 'PAID' | 'BONUS',
  grant: BalanceLedgerRepairGrant,
  transactions: BalanceLedgerRepairTransaction[],
  orders: BalanceLedgerRepairOrderEvidence[],
  billingAccountId: string,
): string | null {
  if (!transaction.orderId || transaction.orderId !== grant.orderId) return 'ORDER_LINK_MISMATCH';
  if (fundingGrantSubjectMismatch(transaction, grant)) return 'SUBJECT_LINK_MISMATCH';
  const grossMismatch = rechargeGrantGrossMismatch(grant);
  if (grossMismatch) return grossMismatch;
  const orderTransactions = transactions.filter((candidate) => candidate.orderId === transaction.orderId);
  const paidTransactions = orderTransactions.filter((candidate) => candidate.type === 'RECHARGE');
  const bonusTransactions = orderTransactions.filter((candidate) => (
    candidate.type === 'ADJUST'
    && isCanonicalRechargeBonusDescription(candidate.description)
  ));
  const unsupportedPositive = orderTransactions.filter((candidate) => (
    decimal(candidate.amountUsd).gt(0)
    && !paidTransactions.some((paid) => paid.id === candidate.id)
    && !bonusTransactions.some((bonus) => bonus.id === candidate.id)
  ));
  if (paidTransactions.length !== 1) return `PAID_TRANSACTION_MATCH_${paidTransactions.length}`;
  const paidTransaction = paidTransactions[0];
  if (
    decimal(paidTransaction.amountUsd).lte(0)
    || (
      paidTransaction.operationKey != null
      && paidTransaction.operationKey !== `balance:recharge:${transaction.orderId}:paid`
    )
  ) {
    return 'PAID_TRANSACTION_FINGERPRINT_INVALID';
  }
  const paidCreatedAt = validIsoInstant(paidTransaction.createdAt);
  if (
    paidCreatedAt === null
    || bonusTransactions.some((bonusTransaction) => {
      const bonusCreatedAt = validIsoInstant(bonusTransaction.createdAt);
      return decimal(bonusTransaction.amountUsd).lte(0)
        || bonusCreatedAt === null
        || bonusCreatedAt < paidCreatedAt;
    })
  ) {
    return 'BONUS_TRANSACTION_FINGERPRINT_INVALID';
  }
  const timingMismatch = grantIssuanceTimingMismatch(
    paidTransaction,
    grant,
    'AT_OR_AFTER_CREATION',
  );
  if (timingMismatch) {
    if (timingMismatch !== 'CREATED_AT_MISMATCH') return timingMismatch;
    const legacyFingerprintMismatch = legacyRechargeOrderFingerprintMismatch(
      paidTransaction,
      bonusTransactions,
      grant,
      orders,
      billingAccountId,
    );
    if (legacyFingerprintMismatch) {
      return `CREATED_AT_MISMATCH:${legacyFingerprintMismatch}`;
    }
  }
  if (
    !decimal(grant.paidAmountUsd).eq(paidTransaction.amountUsd)
    || !bonusTransactions.reduce((sum, row) => sum.plus(row.amountUsd), ZERO)
      .eq(grant.bonusAmountUsd)
    || unsupportedPositive.length !== 0
    || (nature === 'PAID' && transaction.id !== paidTransaction.id)
    || (nature === 'BONUS' && !bonusTransactions.some((row) => row.id === transaction.id))
  ) {
    return 'IMMUTABLE_BUNDLE_MISMATCH';
  }
  return null;
}

type ProvenFundingEvidence = {
  status: 'PROVEN';
  nature: 'PAID' | 'BONUS';
  balanceGrantId: string | null;
  settlementBalanceGrantId: string | null;
};

type AmbiguousFundingEvidence = {
  status: 'AMBIGUOUS';
  reason: string;
};

function resolveFundingEvidence(
  transaction: BalanceLedgerRepairTransaction,
  grants: BalanceLedgerRepairGrant[],
  transactions: BalanceLedgerRepairTransaction[],
  orders: BalanceLedgerRepairOrderEvidence[],
  voucherIdempotencyEvidence: BalanceLedgerRepairVoucherIdempotencyEvidence[],
  billingAccountId: string,
  accountType: SupportedAccountType,
  legacyAdminFundingProofByTransactionId: Map<string, LegacyAdminFundingProofMapEntry>,
  legacyExpiredVoucherGrantIds: ReadonlySet<string>,
): ProvenFundingEvidence | AmbiguousFundingEvidence {
  const ambiguous = (reason?: string): AmbiguousFundingEvidence => ({
    status: 'AMBIGUOUS',
    reason: reason ?? `AMBIGUOUS_POSITIVE_FUNDING:${transaction.id}:${transaction.description}`,
  });
  if (accountType === 'enterprise' && isEnterprisePaidDebtAdjustment(transaction)) {
    return {
      status: 'PROVEN', nature: 'PAID', balanceGrantId: null, settlementBalanceGrantId: null,
    };
  }
  const legacyAdminProof = legacyAdminFundingProofByTransactionId.get(transaction.id);
  if (legacyAdminProof) {
    return {
      status: 'PROVEN',
      nature: legacyAdminProof.nature,
      balanceGrantId: legacyAdminProof.balanceGrantId,
      settlementBalanceGrantId: legacyAdminProof.settlementBalanceGrantId,
    };
  }

  if (transaction.type === 'RECHARGE') {
    const adminRechargeGrantId = explicitAdminRechargeGrantId(transaction);
    if (adminRechargeGrantId) {
      const matches = grants.filter((grant) => grant.id === adminRechargeGrantId);
      if (matches.length !== 1) {
        return ambiguous(
          `FUNDING_ADMIN_RECHARGE_GRANT_MATCH_${matches.length}:${transaction.id}:${adminRechargeGrantId}`,
        );
      }
      const mismatch = explicitAdminRechargeFundingMismatch(transaction, matches[0]);
      return mismatch
        ? ambiguous(
            `FUNDING_ADMIN_RECHARGE_GRANT_MISMATCH:${transaction.id}:${adminRechargeGrantId}:${mismatch}`,
          )
        : {
            status: 'PROVEN', nature: 'PAID', balanceGrantId: matches[0].id,
            settlementBalanceGrantId: matches[0].id,
          };
    }
    if (transaction.orderId) {
      const matches = grants.filter((grant) => grant.orderId === transaction.orderId);
      if (matches.length !== 1) {
        return ambiguous(
          `FUNDING_GRANT_ORDER_MATCH_${matches.length}:${transaction.id}:${transaction.orderId}`,
        );
      }
      const mismatch = rechargeOrderFundingMismatch(
        transaction,
        'PAID',
        matches[0],
        transactions,
        orders,
        billingAccountId,
      );
      return mismatch
        ? ambiguous(
            `FUNDING_RECHARGE_ORDER_MISMATCH:${transaction.id}:${transaction.orderId}:${mismatch}`,
          )
        : {
            status: 'PROVEN', nature: 'PAID', balanceGrantId: matches[0].id,
            settlementBalanceGrantId: matches[0].id,
          };
    }

    // A no-order RECHARGE is only eligible for the historical linkage path
    // when it genuinely predates operation_key.  A present-but-malformed key
    // is contradictory evidence, not permission to fall back to amount/time
    // matching and silently bind the transaction to a different grant.
    if (transaction.operationKey != null) {
      return ambiguous(
        `FUNDING_RECHARGE_OPERATION_KEY_INVALID:${transaction.id}:${transaction.operationKey}`,
      );
    }

    if (accountType === 'enterprise') {
      return ambiguous(`FUNDING_LEGACY_ADMIN_RECEIPT_MISSING:${transaction.id}`);
    }

    // Historical admin recharges predate operation_key.  Their only durable
    // link is a unique same-transaction RECHARGE grant with an exact paid-only
    // aggregate; anything less is not enough evidence to mutate finance facts.
    const matches = grants.filter((grant) => (
      grant.orderId === null
      && explicitAdminRechargeFundingMismatch(transaction, grant) === null
    ));
    return matches.length === 1
      ? {
          status: 'PROVEN', nature: 'PAID', balanceGrantId: matches[0].id,
          settlementBalanceGrantId: matches[0].id,
        }
      : ambiguous(`FUNDING_GRANT_UNLINKED:${transaction.id}:matches=${matches.length}`);
  }

  if (transaction.type !== 'ADJUST') return ambiguous();

  const grantRuleParts = canonicalGrantRuleDescriptionParts(transaction.description);
  if (grantRuleParts) {
    return ambiguous(
      `FUNDING_GRANT_RULE_DEFERRED:${transaction.id}:${grantRuleParts.grantId}`,
    );
  }

  const voucherId = canonicalVoucherGrantId(transaction.description);
  if (voucherId) {
    const matches = grants.filter((grant) => grant.id === voucherId);
    if (matches.length !== 1) {
      return ambiguous(`FUNDING_VOUCHER_GRANT_MATCH_${matches.length}:${transaction.id}:${voucherId}`);
    }
    const mismatch = voucherFundingMismatch(
      transaction,
      matches[0],
      transactions,
      voucherIdempotencyEvidence,
      accountType === 'personal',
      legacyExpiredVoucherGrantIds.has(matches[0].id),
    );
    return mismatch
      ? ambiguous(`FUNDING_VOUCHER_GRANT_MISMATCH:${transaction.id}:${voucherId}:${mismatch}`)
      : {
          status: 'PROVEN', nature: 'BONUS', balanceGrantId: matches[0].id,
          settlementBalanceGrantId: matches[0].id,
        };
  }

  if (transaction.orderId && isCanonicalRechargeBonusDescription(transaction.description)) {
    const matches = grants.filter((grant) => grant.orderId === transaction.orderId);
    if (matches.length !== 1) {
      return ambiguous(
        `FUNDING_GRANT_ORDER_MATCH_${matches.length}:${transaction.id}:${transaction.orderId}`,
      );
    }
    const mismatch = rechargeOrderFundingMismatch(
      transaction,
      'BONUS',
      matches[0],
      transactions,
      orders,
      billingAccountId,
    );
    return mismatch
      ? ambiguous(
          `FUNDING_RECHARGE_BONUS_MISMATCH:${transaction.id}:${transaction.orderId}:${mismatch}`,
        )
      : {
          status: 'PROVEN', nature: 'BONUS', balanceGrantId: matches[0].id,
          settlementBalanceGrantId: matches[0].id,
        };
  }

  // In particular, the old `grant-rule:<id> product:<id>` row and an arbitrary
  // sentence containing `voucher:` are not proof. The legacy fake-CREDIT link
  // was never persisted to BalanceGrant/BalanceTransaction, so repair must stop.
  return ambiguous();
}

function debtSourceForAccountType(accountType: string): SupportedDebtSource | null {
  if (accountType === 'personal') return 'NEGATIVE_BALANCE';
  if (accountType === 'enterprise') return 'ENTERPRISE_CREDIT';
  return null;
}

function canonicalLegacyRepaymentTransactionId(
  transaction: BalanceLedgerRepairTransaction,
  transactions: BalanceLedgerRepairTransaction[],
): { id: string; reason?: string } {
  if (
    transaction.type !== 'ADJUST'
    || !isCanonicalRechargeBonusDescription(transaction.description)
    || !transaction.orderId
  ) {
    return { id: transaction.id };
  }
  // rechargeWithBonus historically settled both the paid and bonus legs against
  // the RECHARGE row. A separately credited bonus has a later timestamp and kept
  // its own ADJUST row as repaymentTransactionId.
  const matches = transactions.filter((candidate) => (
    candidate.type === 'RECHARGE'
    && candidate.orderId === transaction.orderId
    && candidate.createdAt === transaction.createdAt
  ));
  if (matches.length === 1) return { id: matches[0].id };
  if (matches.length > 1) {
    return {
      id: transaction.id,
      reason: `ENTERPRISE_REPAYMENT_BUNDLE_AMBIGUOUS:${transaction.id}:${transaction.orderId}`,
    };
  }
  return { id: transaction.id };
}

type SettlementAggregate = {
  amountUsd: Prisma.Decimal;
  paidUsd: Prisma.Decimal;
  bonusUsd: Prisma.Decimal;
  balanceGrantIds: Set<string>;
};

function addSettlementAggregate(
  map: Map<string, SettlementAggregate>,
  key: string,
  values: {
    amountUsd: Prisma.Decimal.Value;
    paidUsd: Prisma.Decimal.Value;
    bonusUsd: Prisma.Decimal.Value;
    balanceGrantId?: string | null;
  },
): void {
  const aggregate = map.get(key) ?? {
    amountUsd: ZERO,
    paidUsd: ZERO,
    bonusUsd: ZERO,
    balanceGrantIds: new Set<string>(),
  };
  aggregate.amountUsd = aggregate.amountUsd.plus(values.amountUsd);
  aggregate.paidUsd = aggregate.paidUsd.plus(values.paidUsd);
  aggregate.bonusUsd = aggregate.bonusUsd.plus(values.bonusUsd);
  if (values.balanceGrantId) aggregate.balanceGrantIds.add(values.balanceGrantId);
  map.set(key, aggregate);
}

type LegacyEnterpriseSettlementTimingProof = {
  allocationIds: Set<string>;
  repaymentTransactionIds: Set<string>;
  settlementIds: Set<string>;
};

/**
 * The pre-V2 enterprise funding writer captured one application `now` after
 * the repayment transaction had been inserted, used it for every allocation
 * it fully settled, and then inserted the settlement rows with database
 * created_at defaults. The V2 expand migration later copied created_at into
 * occurred_at and assigned `legacy:<id>`.
 *
 * This recognizes only the narrow, complete writer bundle seen on the legacy
 * accounts: every touched allocation is fully settled by exactly one row, the
 * bundle exactly equals the immutable wallet hole, and all timestamps follow
 * the writer's directed order. There is deliberately no millisecond window.
 */
function proveLegacyEnterpriseSettlementTiming(
  snapshot: BalanceLedgerRepairSnapshot,
  transactionsById: Map<string, BalanceLedgerRepairTransaction>,
  allocationsById: Map<string, BalanceLedgerRepairAllocation>,
  legacyAdminFundingProofByTransactionId: Map<string, LegacyAdminFundingProofMapEntry>,
): LegacyEnterpriseSettlementTimingProof {
  const proof: LegacyEnterpriseSettlementTimingProof = {
    allocationIds: new Set(),
    repaymentTransactionIds: new Set(),
    settlementIds: new Set(),
  };
  const byRepayment = new Map<string, BalanceLedgerRepairSettlement[]>();
  const settlementCountByAllocation = new Map<string, number>();
  for (const settlement of snapshot.settlements) {
    settlementCountByAllocation.set(
      settlement.allocationId,
      (settlementCountByAllocation.get(settlement.allocationId) ?? 0) + 1,
    );
    if (!settlement.repaymentTransactionId) continue;
    const rows = byRepayment.get(settlement.repaymentTransactionId) ?? [];
    rows.push(settlement);
    byRepayment.set(settlement.repaymentTransactionId, rows);
  }

  for (const [repaymentTransactionId, settlements] of byRepayment) {
    const repayment = transactionsById.get(repaymentTransactionId);
    if (
      !repayment
      || repayment.operationKey !== null
      || (repayment.type !== 'RECHARGE' && repayment.type !== 'ADJUST')
      || decimal(repayment.amountUsd).lte(0)
    ) continue;
    const repaymentAt = validIsoInstant(repayment.createdAt);
    if (repaymentAt === null) continue;
    let postSettlementGrantValidFromMillis: number | null = null;
    let postSettlementGrantCreatedAtMillis: number | null = null;
    const legacyAdminFundingProof = legacyAdminFundingProofByTransactionId.get(repayment.id);
    const fundingNature: 'PAID' | 'BONUS' = legacyAdminFundingProof ? 'PAID' : (
      repayment.type === 'RECHARGE' ? 'PAID' : 'BONUS'
    );
    if (legacyAdminFundingProof) {
      const proofGrants = snapshot.grants.filter(
        (grant) => grant.id === legacyAdminFundingProof.balanceGrantId,
      );
      if (proofGrants.length !== 1) continue;
      if (legacyAdminFundingProof.action === 'LINK_GRANT') {
        postSettlementGrantValidFromMillis = validIsoInstant(proofGrants[0].validFrom);
        postSettlementGrantCreatedAtMillis = validIsoInstant(proofGrants[0].createdAt);
        if (
          postSettlementGrantValidFromMillis === null
          || postSettlementGrantCreatedAtMillis === null
          || postSettlementGrantValidFromMillis > postSettlementGrantCreatedAtMillis
        ) continue;
      }
    } else if (repayment.type === 'RECHARGE') {
      if (repayment.orderId === null) continue;
      const orderGrants = snapshot.grants.filter((grant) => grant.orderId === repayment.orderId);
      if (
        orderGrants.length !== 1
        || rechargeOrderFundingMismatch(
          repayment,
          'PAID',
          orderGrants[0],
          snapshot.transactions,
          snapshot.orders,
          snapshot.billingAccountId,
        ) !== null
      ) continue;
      postSettlementGrantValidFromMillis = validIsoInstant(orderGrants[0].validFrom);
      postSettlementGrantCreatedAtMillis = validIsoInstant(orderGrants[0].createdAt);
      if (
        postSettlementGrantValidFromMillis === null
        || postSettlementGrantCreatedAtMillis === null
        || postSettlementGrantValidFromMillis > postSettlementGrantCreatedAtMillis
      ) continue;
    } else {
      const voucherGrantId = canonicalVoucherGrantId(repayment.description);
      const voucherGrants = voucherGrantId === null
        ? []
        : snapshot.grants.filter((grant) => grant.id === voucherGrantId);
      if (
        voucherGrants.length !== 1
        || voucherFundingMismatch(
          repayment,
          voucherGrants[0],
          snapshot.transactions,
          snapshot.voucherIdempotencyEvidence,
          false,
          false,
        ) !== null
        || legacyVoucherWriterFingerprintMismatch(
          repayment,
          voucherGrants[0],
          snapshot.voucherIdempotencyEvidence,
        ) !== null
      ) continue;
    }
    const amountUsd = decimal(repayment.amountUsd);
    const balanceBeforeUsd = decimal(repayment.balanceAfterUsd).minus(amountUsd);
    const holeFillUsd = Prisma.Decimal.min(
      amountUsd,
      Prisma.Decimal.max(balanceBeforeUsd.neg(), ZERO),
    );
    const allocationIds = new Set<string>();
    let settledAt: string | null = null;
    let settledAtMillis: number | null = null;
    let latestSettlementCreatedAtMillis: number | null = null;
    let totalUsd = ZERO;
    let bundleValid = settlements.length > 0;
    for (const settlement of settlements) {
      const allocation = allocationsById.get(settlement.allocationId);
      const settlementAmountUsd = decimal(settlement.amountUsd);
      const paidUsd = decimal(settlement.paidUsd);
      const bonusUsd = decimal(settlement.bonusUsd);
      const occurredAt = normalizedIsoInstant(settlement.occurredAt);
      const createdAt = normalizedIsoInstant(settlement.createdAt);
      const allocationSettledAt = normalizedIsoInstant(allocation?.settledAt);
      const allocationSettledAtMillis = validIsoInstant(allocation?.settledAt);
      const settlementCreatedAtMillis = validIsoInstant(settlement.createdAt);
      if (
        !allocation
        || allocationIds.has(allocation.id)
        || settlementCountByAllocation.get(settlement.allocationId) !== 1
        || allocation.source !== 'ENTERPRISE_CREDIT'
        || allocation.balanceGrantId !== null
        || !decimal(allocation.amountUsd).eq(settlementAmountUsd)
        || !decimal(allocation.settledUsd).eq(allocation.amountUsd)
        || allocationSettledAt === null
        || allocationSettledAtMillis === null
        || settlementCreatedAtMillis === null
        || allocationSettledAtMillis < repaymentAt
        || allocationSettledAtMillis > settlementCreatedAtMillis
        || (settledAt !== null && allocationSettledAt !== settledAt)
        || settlement.operationKey !== `legacy:${settlement.id}`
        || settlement.balanceGrantId !== null
        || settlement.debtSource !== 'ENTERPRISE_CREDIT'
        || settlement.repairRunId !== null
        || settlement.trigger !== 'FUNDING'
        || occurredAt === null
        || createdAt === null
        || occurredAt !== createdAt
        || settlementAmountUsd.lte(0)
        || paidUsd.lt(0)
        || bonusUsd.lt(0)
        || !paidUsd.plus(bonusUsd).eq(settlementAmountUsd)
        || (fundingNature === 'PAID'
          ? (!paidUsd.eq(settlementAmountUsd) || !bonusUsd.eq(0))
          : (!paidUsd.eq(0) || !bonusUsd.eq(settlementAmountUsd)))
      ) {
        bundleValid = false;
        break;
      }
      settledAt = allocationSettledAt;
      settledAtMillis = allocationSettledAtMillis;
      allocationIds.add(allocation.id);
      totalUsd = totalUsd.plus(settlementAmountUsd);
      latestSettlementCreatedAtMillis = latestSettlementCreatedAtMillis === null
        ? settlementCreatedAtMillis
        : Math.max(latestSettlementCreatedAtMillis, settlementCreatedAtMillis);
    }
    if (
      !bundleValid
      || settledAt === null
      || settledAtMillis === null
      || latestSettlementCreatedAtMillis === null
      || !totalUsd.eq(holeFillUsd)
      || allocationIds.size !== settlements.length
      || (
        postSettlementGrantValidFromMillis !== null
        && (
          postSettlementGrantCreatedAtMillis === null
          || latestSettlementCreatedAtMillis > postSettlementGrantValidFromMillis
        )
      )
    ) continue;
    proof.repaymentTransactionIds.add(repaymentTransactionId);
    for (const allocationId of allocationIds) proof.allocationIds.add(allocationId);
    for (const settlement of settlements) proof.settlementIds.add(settlement.id);
  }
  return proof;
}

function validateEnterpriseSettlements(
  snapshot: BalanceLedgerRepairSnapshot,
  expectedMutations: BalanceLedgerSettlementMutation[],
  transactionsById: Map<string, BalanceLedgerRepairTransaction>,
  allocationsById: Map<string, BalanceLedgerRepairAllocation>,
  grantsById: Map<string, BalanceLedgerRepairGrant>,
  legacyTimingProof: LegacyEnterpriseSettlementTimingProof,
): string[] {
  const reasons: string[] = [];
  const expected = new Map<string, SettlementAggregate>();
  for (const mutation of expectedMutations) {
    const funding = transactionsById.get(mutation.repaymentTransactionId);
    if (!funding) {
      reasons.push(`ENTERPRISE_EXPECTED_REPAYMENT_MISSING:${mutation.repaymentTransactionId}`);
      continue;
    }
    // V2 writes the bonus leg against its own ADJUST transaction. Legacy
    // rechargeWithBonus bundled that same-time leg under the RECHARGE row.
    // Existing immutable rows select which representation must be proven.
    const hasDirectV2Settlement = snapshot.settlements.some((settlement) => (
      settlement.allocationId === mutation.allocationId
      && settlement.repaymentTransactionId === funding.id
    ));
    const canonical = hasDirectV2Settlement
      ? { id: funding.id }
      : canonicalLegacyRepaymentTransactionId(funding, snapshot.transactions);
    if (canonical.reason) reasons.push(canonical.reason);
    addSettlementAggregate(expected, `${mutation.allocationId}\u0000${canonical.id}`, {
      amountUsd: mutation.amountUsd,
      paidUsd: mutation.paidUsd,
      bonusUsd: mutation.bonusUsd,
      balanceGrantId: mutation.balanceGrantId,
    });
  }

  const actual = new Map<string, SettlementAggregate>();
  const operationKeys = new Set<string>();
  for (const settlement of snapshot.settlements) {
    const amountUsd = decimal(settlement.amountUsd);
    const paidUsd = decimal(settlement.paidUsd);
    const bonusUsd = decimal(settlement.bonusUsd);
    if (
      amountUsd.lte(0)
      || paidUsd.lt(0)
      || bonusUsd.lt(0)
      || !paidUsd.plus(bonusUsd).eq(amountUsd)
    ) {
      reasons.push(`ENTERPRISE_SETTLEMENT_PARTS_INVALID:${settlement.id}`);
    }
    if (settlement.debtSource !== 'ENTERPRISE_CREDIT') {
      reasons.push(`ENTERPRISE_SETTLEMENT_SOURCE_INVALID:${settlement.id}:${settlement.debtSource}`);
    }
    if (settlement.trigger !== 'FUNDING') {
      reasons.push(`ENTERPRISE_SETTLEMENT_TRIGGER_UNSUPPORTED:${settlement.id}:${settlement.trigger}`);
    }
    if (settlement.repairRunId) {
      reasons.push(`ENTERPRISE_SETTLEMENT_REPAIR_RUN_UNEXPECTED:${settlement.id}`);
    }
    if (!settlement.operationKey) {
      reasons.push(`ENTERPRISE_SETTLEMENT_OPERATION_KEY_MISSING:${settlement.id}`);
    } else if (operationKeys.has(settlement.operationKey)) {
      reasons.push(`ENTERPRISE_SETTLEMENT_OPERATION_KEY_DUPLICATE:${settlement.operationKey}`);
    } else {
      operationKeys.add(settlement.operationKey);
      if (
        settlement.operationKey.startsWith('legacy:')
        && settlement.operationKey !== `legacy:${settlement.id}`
      ) {
        reasons.push(`ENTERPRISE_SETTLEMENT_LEGACY_KEY_INVALID:${settlement.id}`);
      }
    }
    const allocation = allocationsById.get(settlement.allocationId);
    if (!allocation || allocation.source !== 'ENTERPRISE_CREDIT') {
      reasons.push(`ENTERPRISE_SETTLEMENT_ALLOCATION_INVALID:${settlement.id}:${settlement.allocationId}`);
    }
    const repayment = settlement.repaymentTransactionId
      ? transactionsById.get(settlement.repaymentTransactionId)
      : null;
    if (!repayment) {
      reasons.push(`ENTERPRISE_SETTLEMENT_REPAYMENT_INVALID:${settlement.id}`);
      continue;
    }
    if (
      new Date(settlement.occurredAt).toISOString() !== new Date(repayment.createdAt).toISOString()
      && !legacyTimingProof.settlementIds.has(settlement.id)
    ) {
      reasons.push(`ENTERPRISE_SETTLEMENT_OCCURRED_AT_MISMATCH:${settlement.id}`);
    }
    if (settlement.balanceGrantId && !grantsById.has(settlement.balanceGrantId)) {
      reasons.push(`ENTERPRISE_SETTLEMENT_GRANT_INVALID:${settlement.id}:${settlement.balanceGrantId}`);
    }
    const key = `${settlement.allocationId}\u0000${repayment.id}`;
    const expectedAggregate = expected.get(key);
    if (
      settlement.balanceGrantId
      && (!expectedAggregate || !expectedAggregate.balanceGrantIds.has(settlement.balanceGrantId))
    ) {
      reasons.push(`ENTERPRISE_SETTLEMENT_GRANT_MISMATCH:${settlement.id}:${settlement.balanceGrantId}`);
    }
    if (
      !settlement.balanceGrantId
      && expectedAggregate
      && expectedAggregate.balanceGrantIds.size > 0
      && !settlement.operationKey?.startsWith('legacy:')
    ) {
      reasons.push(`ENTERPRISE_SETTLEMENT_GRANT_MISSING:${settlement.id}`);
    }
    addSettlementAggregate(actual, key, {
      amountUsd,
      paidUsd,
      bonusUsd,
      balanceGrantId: settlement.balanceGrantId,
    });
  }

  const allKeys = new Set([...expected.keys(), ...actual.keys()]);
  for (const key of allKeys) {
    const expectedAggregate = expected.get(key);
    const actualAggregate = actual.get(key);
    if (
      !expectedAggregate
      || !actualAggregate
      || !expectedAggregate.amountUsd.eq(actualAggregate.amountUsd)
      || !expectedAggregate.paidUsd.eq(actualAggregate.paidUsd)
      || !expectedAggregate.bonusUsd.eq(actualAggregate.bonusUsd)
    ) {
      reasons.push(`ENTERPRISE_SETTLEMENT_REPLAY_MISMATCH:${key.replace('\u0000', ':')}`);
    }
  }
  return reasons;
}

type UnreconciledGrantReplayState = {
  grant: BalanceLedgerRepairGrant;
  fundedPaidUsd: Prisma.Decimal;
  fundedBonusUsd: Prisma.Decimal;
  paidRemainingUsd: Prisma.Decimal;
  bonusRemainingUsd: Prisma.Decimal;
};

/**
 * A suspense allocation is repairable only when the immutable wallet chain,
 * funding rows and grant link reproduce the grant from zero. This deliberately
 * excludes unlinked suspense and enterprise VERIFY_EXISTING accounts: neither
 * case permits the repair job to invent a financial classification.
 */
function replayUnreconciledGrantAllocations(
  snapshot: BalanceLedgerRepairSnapshot,
  ordered: OrderedTransaction[],
  accountType: SupportedAccountType,
  legacyExpiryByTransactionId: ReadonlyMap<string, LegacyExpiryProofCandidate>,
  legacyAdminFundingProofByTransactionId: Map<string, LegacyAdminFundingProofMapEntry>,
  legacyExpiredVoucherGrantIds: ReadonlySet<string>,
): { mutations: BalanceLedgerUnreconciledGrantMutation[]; reasons: string[] } {
  const reasons: string[] = [];
  const suspenseAllocations = snapshot.allocations
    .filter((allocation) => allocation.source === 'UNRECONCILED_GRANT');
  if (suspenseAllocations.length === 0) return { mutations: [], reasons };
  if (accountType === 'enterprise') {
    return {
      mutations: [],
      reasons: suspenseAllocations.map(
        (allocation) => `ENTERPRISE_UNRECONCILED_GRANT_VERIFY_ONLY:${allocation.id}`,
      ),
    };
  }

  const grantsById = new Map(snapshot.grants.map((grant) => [grant.id, grant]));
  const targetGrantIds = new Set<string>();
  for (const allocation of suspenseAllocations) {
    const discountRate = decimal(allocation.discountRate ?? 0);
    if (
      !decimal(allocation.recognizedRevenueUsd).eq(0)
      || !decimal(allocation.bonusConsumedUsd).eq(0)
      || !discountRate.eq(0)
      || !decimal(allocation.settledUsd).eq(0)
      || allocation.settledAt !== null
    ) {
      reasons.push(`UNRECONCILED_GRANT_STATE_INVALID:${allocation.id}`);
    }
    if (!allocation.balanceGrantId) {
      reasons.push(`UNRECONCILED_GRANT_MISSING_GRANT:${allocation.id}`);
      continue;
    }
    if (!grantsById.has(allocation.balanceGrantId)) {
      reasons.push(`UNRECONCILED_GRANT_UNKNOWN_GRANT:${allocation.id}:${allocation.balanceGrantId}`);
      continue;
    }
    const sequence = allocation.ledgerSequence ?? null;
    if (sequence === null || !/^\d+$/.test(sequence) || BigInt(sequence) <= BigInt(0)) {
      reasons.push(`UNRECONCILED_GRANT_SEQUENCE_UNPROVEN:${allocation.id}:${sequence ?? 'NULL'}`);
      continue;
    }
    targetGrantIds.add(allocation.balanceGrantId);
  }
  if (reasons.length > 0) return { mutations: [], reasons };

  const replay = new Map<string, UnreconciledGrantReplayState>();
  for (const grantId of targetGrantIds) {
    replay.set(grantId, {
      grant: grantsById.get(grantId)!,
      fundedPaidUsd: ZERO,
      fundedBonusUsd: ZERO,
      paidRemainingUsd: ZERO,
      bonusRemainingUsd: ZERO,
    });
  }

  const canonicalByTransaction = new Map<string, BalanceLedgerRepairAllocation[]>();
  for (const allocation of canonicalAllocationOrder(snapshot.allocations, ordered)) {
    const list = canonicalByTransaction.get(allocation.balanceTransactionId) ?? [];
    list.push(allocation);
    canonicalByTransaction.set(allocation.balanceTransactionId, list);
  }
  const mutations: BalanceLedgerUnreconciledGrantMutation[] = [];

  for (const transaction of ordered) {
    if (transaction.amount.gt(0)) {
      const evidence = resolveFundingEvidence(
        transaction,
        snapshot.grants,
        snapshot.transactions,
        snapshot.orders,
        snapshot.voucherIdempotencyEvidence,
        snapshot.billingAccountId,
        accountType,
        legacyAdminFundingProofByTransactionId,
        legacyExpiredVoucherGrantIds,
      );
      if (evidence.status === 'PROVEN' && evidence.balanceGrantId) {
        const state = replay.get(evidence.balanceGrantId);
        if (!state) continue;
        const holeFillUsd = Prisma.Decimal.min(
          transaction.amount,
          Prisma.Decimal.max(transaction.beforeUsd.neg(), ZERO),
        );
        const consumableUsd = transaction.amount.minus(holeFillUsd);
        if (evidence.nature === 'PAID') {
          state.fundedPaidUsd = state.fundedPaidUsd.plus(transaction.amount);
          state.paidRemainingUsd = state.paidRemainingUsd.plus(consumableUsd);
        } else {
          state.fundedBonusUsd = state.fundedBonusUsd.plus(transaction.amount);
          state.bonusRemainingUsd = state.bonusRemainingUsd.plus(consumableUsd);
        }
      }
    }
    const legacyExpiry = legacyExpiryByTransactionId.get(transaction.id);
    if (legacyExpiry) {
      const state = replay.get(legacyExpiry.grant.id);
      if (state) {
        const remainingUsd = state.paidRemainingUsd.plus(state.bonusRemainingUsd);
        if (!remainingUsd.eq(transaction.amount.abs())) {
          reasons.push(
            `UNRECONCILED_GRANT_LEGACY_EXPIRY_AMOUNT_MISMATCH:${transaction.id}:`
              + `${money(remainingUsd)}:${money(transaction.amount.abs())}`,
          );
        } else {
          state.paidRemainingUsd = ZERO;
          state.bonusRemainingUsd = ZERO;
        }
      }
      continue;
    }
    if (transaction.type !== 'CONSUME') continue;

    for (const allocation of canonicalByTransaction.get(transaction.id) ?? []) {
      if (!allocation.balanceGrantId) continue;
      const state = replay.get(allocation.balanceGrantId);
      if (!state) continue;
      if (allocation.source !== 'BALANCE_GRANT' && allocation.source !== 'UNRECONCILED_GRANT') {
        continue;
      }
      const amountUsd = decimal(allocation.amountUsd);
      let paidUsd: Prisma.Decimal;
      let bonusUsd: Prisma.Decimal;
      if (allocation.source === 'BALANCE_GRANT') {
        paidUsd = decimal(allocation.recognizedRevenueUsd);
        bonusUsd = decimal(allocation.bonusConsumedUsd);
        if (
          paidUsd.lt(0)
          || bonusUsd.lt(0)
          || !paidUsd.plus(bonusUsd).eq(amountUsd)
        ) {
          reasons.push(`UNRECONCILED_GRANT_PRIOR_COMPONENTS_INVALID:${allocation.id}`);
          continue;
        }
      } else {
        const availableUsd = state.paidRemainingUsd.plus(state.bonusRemainingUsd);
        if (amountUsd.lte(0) || amountUsd.gt(availableUsd)) {
          reasons.push(
            `UNRECONCILED_GRANT_REPLAY_OVERDRAW:${allocation.id}:${money(amountUsd)}:${
              money(availableUsd)
            }`,
          );
          continue;
        }
        const consumesEntireGrant = amountUsd.eq(availableUsd);
        const currentDiscountRate = state.paidRemainingUsd.div(availableUsd)
          .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
        const proportionalPaidUsd = consumesEntireGrant
          ? state.paidRemainingUsd
          : amountUsd.mul(currentDiscountRate)
            .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
        const minimumPaidUsd = Prisma.Decimal.max(
          ZERO,
          amountUsd.minus(state.bonusRemainingUsd),
        );
        const maximumPaidUsd = Prisma.Decimal.min(amountUsd, state.paidRemainingUsd);
        if (minimumPaidUsd.gt(maximumPaidUsd)) {
          reasons.push(`UNRECONCILED_GRANT_REPLAY_COMPONENT_INTERVAL_EMPTY:${allocation.id}`);
          continue;
        }
        paidUsd = Prisma.Decimal.min(
          maximumPaidUsd,
          Prisma.Decimal.max(minimumPaidUsd, proportionalPaidUsd),
        ).toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
        bonusUsd = amountUsd.minus(paidUsd).toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
        if (paidUsd.gt(state.paidRemainingUsd) || bonusUsd.gt(state.bonusRemainingUsd)) {
          reasons.push(`UNRECONCILED_GRANT_REPLAY_COMPONENT_OVERDRAW:${allocation.id}`);
          continue;
        }
        mutations.push({
          allocationId: allocation.id,
          expectedSource: 'UNRECONCILED_GRANT',
          expectedBalanceGrantId: allocation.balanceGrantId,
          expectedAmountUsd: money(amountUsd),
          expectedRecognizedRevenueUsd: money(allocation.recognizedRevenueUsd),
          expectedBonusConsumedUsd: money(allocation.bonusConsumedUsd),
          expectedDiscountRate: money(allocation.discountRate ?? 0),
          expectedSettledUsd: money(allocation.settledUsd),
          expectedSettledAt: null,
          expectedLedgerSequence: allocation.ledgerSequence!,
          source: 'BALANCE_GRANT',
          balanceGrantId: allocation.balanceGrantId,
          recognizedRevenueUsd: money(paidUsd),
          bonusConsumedUsd: money(bonusUsd),
          discountRate: money(paidUsd.div(amountUsd)),
        });
      }
      state.paidRemainingUsd = state.paidRemainingUsd.minus(paidUsd);
      state.bonusRemainingUsd = state.bonusRemainingUsd.minus(bonusUsd);
      if (state.paidRemainingUsd.lt(0) || state.bonusRemainingUsd.lt(0)) {
        reasons.push(`UNRECONCILED_GRANT_REPLAY_COMPONENT_NEGATIVE:${allocation.id}`);
      }
    }
  }

  for (const state of replay.values()) {
    if (
      !state.fundedPaidUsd.eq(state.grant.paidAmountUsd)
      || !state.fundedBonusUsd.eq(state.grant.bonusAmountUsd)
    ) {
      reasons.push(
        `UNRECONCILED_GRANT_FUNDING_GROSS_MISMATCH:${state.grant.id}:paid=${
          money(state.fundedPaidUsd)
        }/${money(state.grant.paidAmountUsd)}:bonus=${money(state.fundedBonusUsd)}/${
          money(state.grant.bonusAmountUsd)
        }`,
      );
    }
    const replayedRemainingUsd = state.paidRemainingUsd.plus(state.bonusRemainingUsd);
    if (!replayedRemainingUsd.eq(state.grant.remainingAmountUsd)) {
      reasons.push(
        `UNRECONCILED_GRANT_REMAINING_MISMATCH:${state.grant.id}:${
          money(replayedRemainingUsd)
        }:${money(state.grant.remainingAmountUsd)}`,
      );
    }
  }
  if (mutations.length !== suspenseAllocations.length) {
    reasons.push(
      `UNRECONCILED_GRANT_MUTATION_COUNT_MISMATCH:${mutations.length}:${suspenseAllocations.length}`,
    );
  }
  return { mutations, reasons };
}

type CanonicalReplayGrantState = ReplayedGrant & {
  fundedPaidUsd: Prisma.Decimal;
  fundedBonusUsd: Prisma.Decimal;
};

type CanonicalGrantDebit = {
  grantId: string;
  amountUsd: Prisma.Decimal;
  paidUsd: Prisma.Decimal;
  bonusUsd: Prisma.Decimal;
  discountRate: Prisma.Decimal;
};

function splitCanonicalGrantDebit(
  amountUsd: Prisma.Decimal,
  paidRemainingUsd: Prisma.Decimal,
  bonusRemainingUsd: Prisma.Decimal,
): { paidUsd: Prisma.Decimal; bonusUsd: Prisma.Decimal } | null {
  const totalRemainingUsd = paidRemainingUsd.plus(bonusRemainingUsd);
  if (
    amountUsd.lte(0)
    || amountUsd.gt(totalRemainingUsd)
    || paidRemainingUsd.lt(0)
    || bonusRemainingUsd.lt(0)
  ) return null;
  if (amountUsd.eq(totalRemainingUsd)) {
    return { paidUsd: paidRemainingUsd, bonusUsd: bonusRemainingUsd };
  }
  const currentDiscountRate = paidRemainingUsd.div(totalRemainingUsd)
    .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
  const proportionalPaidUsd = amountUsd.mul(currentDiscountRate)
    .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
  const minimumPaidUsd = Prisma.Decimal.max(ZERO, amountUsd.minus(bonusRemainingUsd));
  const maximumPaidUsd = Prisma.Decimal.min(amountUsd, paidRemainingUsd);
  if (minimumPaidUsd.gt(maximumPaidUsd)) return null;
  const paidUsd = Prisma.Decimal.min(
    maximumPaidUsd,
    Prisma.Decimal.max(minimumPaidUsd, proportionalPaidUsd),
  ).toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
  const bonusUsd = amountUsd.minus(paidUsd).toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
  return paidUsd.plus(bonusUsd).eq(amountUsd)
    ? { paidUsd, bonusUsd }
    : null;
}

function grantIsAvailableAt(
  state: CanonicalReplayGrantState,
  transaction: OrderedTransaction,
  legacyExpiryGrantIds: ReadonlySet<string>,
): boolean {
  if (state.paidRemainingUsd.plus(state.bonusRemainingUsd).lte(0)) return false;
  const transactionAt = validIsoInstant(transaction.createdAt);
  const validFrom = validIsoInstant(state.grant.validFrom ?? state.grant.createdAt);
  const createdAt = validIsoInstant(state.grant.createdAt);
  const expiresAt = state.grant.expiresAt == null
    ? null
    : validIsoInstant(state.grant.expiresAt);
  return transactionAt !== null
    && validFrom !== null
    && createdAt !== null
    && validFrom <= transactionAt
    && createdAt <= transactionAt
    && (expiresAt === null || expiresAt > transactionAt)
    && (!state.grant.isExpired || legacyExpiryGrantIds.has(state.grant.id));
}

function canonicalGrantOrder(
  states: CanonicalReplayGrantState[],
): CanonicalReplayGrantState[] {
  return [...states].sort((left, right) => {
    const leftExpiry = left.grant.expiresAt == null
      ? Number.POSITIVE_INFINITY
      : (validIsoInstant(left.grant.expiresAt) ?? Number.NEGATIVE_INFINITY);
    const rightExpiry = right.grant.expiresAt == null
      ? Number.POSITIVE_INFINITY
      : (validIsoInstant(right.grant.expiresAt) ?? Number.NEGATIVE_INFINITY);
    if (leftExpiry !== rightExpiry) return leftExpiry - rightExpiry;
    const leftCreated = validIsoInstant(left.grant.createdAt) ?? Number.NEGATIVE_INFINITY;
    const rightCreated = validIsoInstant(right.grant.createdAt) ?? Number.NEGATIVE_INFINITY;
    if (leftCreated !== rightCreated) return leftCreated - rightCreated;
    return left.grant.id.localeCompare(right.grant.id);
  });
}

function allocationDiscountRate(allocation: BalanceLedgerRepairAllocation): Prisma.Decimal {
  if (allocation.discountRate != null) return decimal(allocation.discountRate);
  const amountUsd = decimal(allocation.amountUsd);
  return amountUsd.lte(0)
    ? ZERO
    : decimal(allocation.recognizedRevenueUsd).div(amountUsd)
      .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
}

/**
 * Replay the provable funding/consumption chain from zero and derive the exact
 * FIFO grant attribution.  This is intentionally separate from debt
 * settlement replay: a legacy funding row first fills the wallet hole and only
 * its residual can be minted into the linked grant pool.
 */
function replayCanonicalGrantAllocations(
  snapshot: BalanceLedgerRepairSnapshot,
  ordered: OrderedTransaction[],
  accountType: SupportedAccountType,
  unreconciledMutations: BalanceLedgerUnreconciledGrantMutation[],
  legacyExpiryByGrantId: ReadonlyMap<string, LegacyExpiryProofCandidate>,
  legacyExpiryByTransactionId: ReadonlyMap<string, LegacyExpiryProofCandidate>,
  legacyAdminFundingProofByTransactionId: Map<string, LegacyAdminFundingProofMapEntry>,
  legacyExpiredVoucherGrantIds: ReadonlySet<string>,
): {
  grantState: Map<string, ReplayedGrant>;
  mutations: BalanceLedgerCanonicalAllocationMutation[];
  legacyExpiryProofMutations: BalanceLedgerLegacyExpiryProofMutation[];
  allocationOrderByTransaction: Map<string, string[]>;
  reasons: string[];
} {
  const reasons: string[] = [];
  const mutations: BalanceLedgerCanonicalAllocationMutation[] = [];
  const legacyExpiryProofMutations: BalanceLedgerLegacyExpiryProofMutation[] = [];
  const legacyExpiryGrantIds = new Set(legacyExpiryByGrantId.keys());
  const allocationOrderByTransaction = new Map<string, string[]>();
  const states = new Map<string, CanonicalReplayGrantState>(snapshot.grants.map((grant) => [
    grant.id,
    {
      grant,
      fundedPaidUsd: ZERO,
      fundedBonusUsd: ZERO,
      paidRemainingUsd: ZERO,
      bonusRemainingUsd: ZERO,
    },
  ]));
  const allocationsByTransaction = new Map<string, BalanceLedgerRepairAllocation[]>();
  for (const allocation of canonicalAllocationOrder(snapshot.allocations, ordered)) {
    const rows = allocationsByTransaction.get(allocation.balanceTransactionId) ?? [];
    rows.push(allocation);
    allocationsByTransaction.set(allocation.balanceTransactionId, rows);
  }
  const unreconciledById = new Map(
    unreconciledMutations.map((mutation) => [mutation.allocationId, mutation]),
  );

  for (const transaction of ordered) {
    if (transaction.amount.gt(0)) {
      const evidence = resolveFundingEvidence(
        transaction,
        snapshot.grants,
        snapshot.transactions,
        snapshot.orders,
        snapshot.voucherIdempotencyEvidence,
        snapshot.billingAccountId,
        accountType,
        legacyAdminFundingProofByTransactionId,
        legacyExpiredVoucherGrantIds,
      );
      if (evidence.status === 'AMBIGUOUS') {
        reasons.push(evidence.reason);
        continue;
      }
      if (!evidence.balanceGrantId) continue;
      const state = states.get(evidence.balanceGrantId);
      if (!state) {
        reasons.push(`CANONICAL_FUNDING_GRANT_MISSING:${transaction.id}:${evidence.balanceGrantId}`);
        continue;
      }
      const holeFillUsd = Prisma.Decimal.min(
        transaction.amount,
        Prisma.Decimal.max(transaction.beforeUsd.neg(), ZERO),
      );
      const consumableUsd = transaction.amount.minus(holeFillUsd);
      if (evidence.nature === 'PAID') {
        state.fundedPaidUsd = state.fundedPaidUsd.plus(transaction.amount);
        state.paidRemainingUsd = state.paidRemainingUsd.plus(consumableUsd);
      } else {
        state.fundedBonusUsd = state.fundedBonusUsd.plus(transaction.amount);
        state.bonusRemainingUsd = state.bonusRemainingUsd.plus(consumableUsd);
      }
      continue;
    }
    const legacyExpiry = legacyExpiryByTransactionId.get(transaction.id);
    if (legacyExpiry) {
      const state = states.get(legacyExpiry.grant.id);
      if (!state) {
        reasons.push(`LEGACY_EXPIRY_GRANT_REPLAY_MISSING:${transaction.id}:${legacyExpiry.grant.id}`);
        continue;
      }
      const nominalPaidUsd = state.paidRemainingUsd;
      const nominalBonusUsd = state.bonusRemainingUsd;
      const nominalAmountUsd = nominalPaidUsd.plus(nominalBonusUsd);
      if (
        nominalPaidUsd.lt(0)
        || nominalBonusUsd.lt(0)
        || nominalAmountUsd.lte(0)
        || !nominalAmountUsd.eq(transaction.amount.abs())
      ) {
        reasons.push(
          `LEGACY_EXPIRY_REPLAY_AMOUNT_MISMATCH:${transaction.id}:${legacyExpiry.grant.id}:`
            + `${money(nominalAmountUsd)}:${money(transaction.amount.abs())}`,
        );
        continue;
      }
      const expectedTransaction: BalanceLedgerRepairTransaction = {
        id: legacyExpiry.transaction.id,
        userId: legacyExpiry.transaction.userId,
        tenantId: legacyExpiry.transaction.tenantId,
        productId: legacyExpiry.transaction.productId,
        type: legacyExpiry.transaction.type,
        amountUsd: legacyExpiry.transaction.amountUsd,
        balanceAfterUsd: legacyExpiry.transaction.balanceAfterUsd,
        description: legacyExpiry.transaction.description,
        orderId: legacyExpiry.transaction.orderId,
        tokenUsageId: legacyExpiry.transaction.tokenUsageId,
        operationKey: legacyExpiry.transaction.operationKey,
        ledgerSequence: legacyExpiry.transaction.ledgerSequence,
        createdAt: legacyExpiry.transaction.createdAt,
      };
      legacyExpiryProofMutations.push({
        proofVersion: 1,
        repairKind: 'LEGACY_INLINE_EXPIRY_V1',
        grantId: legacyExpiry.grant.id,
        transactionId: transaction.id,
        expiryAuditId: `repair-legacy-expiry:${legacyExpiry.grant.id}`,
        nominalAmountUsd: money(nominalAmountUsd),
        nominalPaidUsd: money(nominalPaidUsd),
        nominalBonusUsd: money(nominalBonusUsd),
        walletBalanceBeforeUsd: money(transaction.beforeUsd),
        walletBalanceAfterUsd: money(transaction.afterUsd),
        expectedTransaction,
        expectedGrant: legacyExpiry.grant,
      });
      state.paidRemainingUsd = ZERO;
      state.bonusRemainingUsd = ZERO;
      continue;
    }
    if (transaction.type !== 'CONSUME') continue;

    const grantAllocations = (allocationsByTransaction.get(transaction.id) ?? [])
      .filter((allocation) => (
        allocation.source === 'BALANCE_GRANT'
        || allocation.source === 'UNRECONCILED_GRANT'
      ));
    if (grantAllocations.length === 0) continue;

    const allocationMetadata = new Set(grantAllocations.map((allocation) => JSON.stringify([
      allocation.userId ?? null,
      allocation.tenantId ?? null,
      allocation.productId ?? null,
      allocation.tokenUsageId ?? null,
    ])));
    if (allocationMetadata.size !== 1) {
      reasons.push(`CANONICAL_ALLOCATION_METADATA_MIXED:${transaction.id}`);
      continue;
    }

    let remainingUsd = grantAllocations.reduce(
      (sum, allocation) => sum.plus(allocation.amountUsd),
      ZERO,
    );
    const desired: CanonicalGrantDebit[] = [];
    for (const state of canonicalGrantOrder([...states.values()])) {
      if (remainingUsd.lte(0)) break;
      if (!grantIsAvailableAt(state, transaction, legacyExpiryGrantIds)) continue;
      const availableUsd = state.paidRemainingUsd.plus(state.bonusRemainingUsd);
      const amountUsd = Prisma.Decimal.min(availableUsd, remainingUsd)
        .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
      if (amountUsd.lte(0)) continue;
      const components = splitCanonicalGrantDebit(
        amountUsd,
        state.paidRemainingUsd,
        state.bonusRemainingUsd,
      );
      if (!components) {
        reasons.push(`CANONICAL_FIFO_COMPONENT_SPLIT_INVALID:${transaction.id}:${state.grant.id}`);
        break;
      }
      desired.push({
        grantId: state.grant.id,
        amountUsd,
        paidUsd: components.paidUsd,
        bonusUsd: components.bonusUsd,
        discountRate: components.paidUsd.div(amountUsd)
          .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP),
      });
      state.paidRemainingUsd = state.paidRemainingUsd.minus(components.paidUsd);
      state.bonusRemainingUsd = state.bonusRemainingUsd.minus(components.bonusUsd);
      remainingUsd = remainingUsd.minus(amountUsd)
        .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
    }
    if (remainingUsd.gt(0)) {
      reasons.push(`CANONICAL_FIFO_UNBACKED:${transaction.id}:${money(remainingUsd)}`);
      continue;
    }
    if (grantAllocations.some((allocation) => allocation.source === 'UNRECONCILED_GRANT')) {
      // Suspense classification proves components, but its historical
      // balanceGrantId was written by the very fallback being repaired. It is
      // not FIFO evidence. Only accept the classifier when every row exactly
      // matches the independently replayed canonical batch; otherwise stop
      // instead of blessing a later grant.
      if (desired.length !== grantAllocations.length) {
        reasons.push(
          `UNRECONCILED_GRANT_FIFO_ROW_COUNT_MISMATCH:${transaction.id}:${
            grantAllocations.length
          }:${desired.length}`,
        );
        continue;
      }
      const unmatchedSuspense = [...grantAllocations];
      const provenOrder: string[] = [];
      const reasonCountBeforeMatching = reasons.length;
      for (const debit of desired) {
        const matchIndex = unmatchedSuspense.findIndex((allocation) => (
          allocation.balanceGrantId === debit.grantId
          && decimal(allocation.amountUsd).eq(debit.amountUsd)
        ));
        if (matchIndex < 0) {
          reasons.push(`UNRECONCILED_GRANT_FIFO_MISMATCH:${transaction.id}:${debit.grantId}`);
          continue;
        }
        const allocation = unmatchedSuspense.splice(matchIndex, 1)[0];
        provenOrder.push(allocation.id);
        if (allocation.source === 'UNRECONCILED_GRANT') {
          const mutation = unreconciledById.get(allocation.id);
          if (
            !mutation
            || mutation.balanceGrantId !== debit.grantId
            || !decimal(mutation.recognizedRevenueUsd).eq(debit.paidUsd)
            || !decimal(mutation.bonusConsumedUsd).eq(debit.bonusUsd)
            || !decimal(mutation.discountRate).eq(debit.discountRate)
          ) {
            reasons.push(`UNRECONCILED_GRANT_FIFO_COMPONENT_MISMATCH:${allocation.id}`);
          }
        } else if (
          !decimal(allocation.recognizedRevenueUsd).eq(debit.paidUsd)
          || !decimal(allocation.bonusConsumedUsd).eq(debit.bonusUsd)
          || !allocationDiscountRate(allocation).eq(debit.discountRate)
        ) {
          reasons.push(`UNRECONCILED_GRANT_MIXED_FIFO_COMPONENT_MISMATCH:${allocation.id}`);
        }
      }
      if (
        reasons.length === reasonCountBeforeMatching
        && unmatchedSuspense.length === 0
        && provenOrder.length === grantAllocations.length
      ) {
        allocationOrderByTransaction.set(transaction.id, provenOrder);
      }
      continue;
    }
    if (grantAllocations.length < desired.length) {
      reasons.push(
        `CANONICAL_FIFO_ROW_COUNT_MISMATCH:${transaction.id}:${grantAllocations.length}:${desired.length}`,
      );
      continue;
    }

    const existingAmountUsd = grantAllocations.reduce(
      (sum, allocation) => sum.plus(allocation.amountUsd),
      ZERO,
    );
    const desiredAmountUsd = desired.reduce((sum, debit) => sum.plus(debit.amountUsd), ZERO);
    if (!existingAmountUsd.eq(desiredAmountUsd)) {
      reasons.push(
        `CANONICAL_FIFO_TRANSACTION_TOTAL_MISMATCH:${transaction.id}:amount=${
          money(existingAmountUsd)
        }/${money(desiredAmountUsd)}`,
      );
      continue;
    }

    // Keep every immutable legacy row represented. A historical transaction
    // can contain more rows than the canonical number of batches (for example
    // .34 from a phantom prior batch plus 4.66 from the real batch). Assign one
    // row to every canonical batch, then fold extra rows into the same batch;
    // no zero-amount tombstones or unaudited inserts are required.
    const unmatched = [...grantAllocations];
    const assignments = desired.map((debit) => ({
      debit,
      allocations: [] as BalanceLedgerRepairAllocation[],
    }));
    for (const assignment of assignments) {
      const sameGrantIndex = unmatched.findIndex(
        (allocation) => allocation.balanceGrantId === assignment.debit.grantId,
      );
      assignment.allocations.push(
        unmatched.splice(sameGrantIndex >= 0 ? sameGrantIndex : 0, 1)[0],
      );
    }
    for (const allocation of unmatched) {
      const sameGrant = assignments.find(
        (assignment) => assignment.debit.grantId === allocation.balanceGrantId,
      );
      (sameGrant ?? assignments.at(-1)!).allocations.push(allocation);
    }

    const minimumUnitUsd = new Prisma.Decimal('0.000000000001');
    const targets: Array<{
      allocation: BalanceLedgerRepairAllocation;
      debit: CanonicalGrantDebit;
    }> = [];
    for (const assignment of assignments) {
      let amountRemainingUsd = assignment.debit.amountUsd;
      let paidRemainingUsd = assignment.debit.paidUsd;
      let bonusRemainingUsd = assignment.debit.bonusUsd;
      for (const [index, allocation] of assignment.allocations.entries()) {
        const rowsAfter = assignment.allocations.length - index - 1;
        const amountUsd = rowsAfter === 0
          ? amountRemainingUsd
          : Prisma.Decimal.min(
              decimal(allocation.amountUsd),
              amountRemainingUsd.minus(minimumUnitUsd.mul(rowsAfter)),
            ).toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
        if (amountUsd.lt(minimumUnitUsd)) {
          reasons.push(
            `CANONICAL_FIFO_ROW_SPLIT_TOO_SMALL:${transaction.id}:${assignment.debit.grantId}`,
          );
          break;
        }
        const components = rowsAfter === 0
          ? { paidUsd: paidRemainingUsd, bonusUsd: bonusRemainingUsd }
          : splitCanonicalGrantDebit(amountUsd, paidRemainingUsd, bonusRemainingUsd);
        if (!components) {
          reasons.push(
            `CANONICAL_FIFO_ROW_COMPONENT_SPLIT_INVALID:${transaction.id}:${allocation.id}`,
          );
          break;
        }
        targets.push({
          allocation,
          debit: {
            grantId: assignment.debit.grantId,
            amountUsd,
            paidUsd: components.paidUsd,
            bonusUsd: components.bonusUsd,
            discountRate: components.paidUsd.div(amountUsd)
              .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP),
          },
        });
        amountRemainingUsd = amountRemainingUsd.minus(amountUsd);
        paidRemainingUsd = paidRemainingUsd.minus(components.paidUsd);
        bonusRemainingUsd = bonusRemainingUsd.minus(components.bonusUsd);
      }
      if (
        !amountRemainingUsd.eq(0)
        || !paidRemainingUsd.eq(0)
        || !bonusRemainingUsd.eq(0)
      ) {
        reasons.push(`CANONICAL_FIFO_ROW_SPLIT_RESIDUAL:${transaction.id}:${assignment.debit.grantId}`);
      }
    }
    if (reasons.length > 0) continue;

    allocationOrderByTransaction.set(
      transaction.id,
      assignments.flatMap((assignment) => (
        assignment.allocations.map((allocation) => allocation.id)
      )),
    );

    for (const { allocation, debit } of targets) {
      const currentDiscountRate = allocationDiscountRate(allocation);
      const needsMutation = allocation.balanceGrantId !== debit.grantId
        || !decimal(allocation.amountUsd).eq(debit.amountUsd)
        || !decimal(allocation.recognizedRevenueUsd).eq(debit.paidUsd)
        || !decimal(allocation.bonusConsumedUsd).eq(debit.bonusUsd)
        || !currentDiscountRate.eq(debit.discountRate);
      if (!needsMutation) continue;
      if (
        accountType !== 'personal'
        && legacyAdminFundingProofByTransactionId.size === 0
      ) {
        reasons.push(`ENTERPRISE_CANONICAL_ALLOCATION_REWRITE_REQUIRED:${allocation.id}`);
        continue;
      }
      if (
        allocation.userId == null
        || allocation.tenantId == null
        || allocation.productId === undefined
        || allocation.tokenUsageId === undefined
        || !allocation.balanceGrantId
      ) {
        reasons.push(`CANONICAL_ALLOCATION_IDENTITY_MISSING:${allocation.id}`);
        continue;
      }
      mutations.push({
        allocationId: allocation.id,
        expectedUserId: allocation.userId,
        expectedTenantId: allocation.tenantId,
        expectedProductId: allocation.productId,
        expectedBalanceTransactionId: allocation.balanceTransactionId,
        expectedTokenUsageId: allocation.tokenUsageId,
        expectedBalanceGrantId: allocation.balanceGrantId,
        expectedSource: 'BALANCE_GRANT',
        expectedAmountUsd: money(allocation.amountUsd),
        expectedRecognizedRevenueUsd: money(allocation.recognizedRevenueUsd),
        expectedBonusConsumedUsd: money(allocation.bonusConsumedUsd),
        expectedDiscountRate: money(currentDiscountRate),
        expectedSettledUsd: money(allocation.settledUsd),
        expectedSettledAt: null,
        expectedLedgerSequence: allocation.ledgerSequence ?? null,
        expectedCreatedAt: new Date(allocation.createdAt).toISOString(),
        balanceGrantId: debit.grantId,
        amountUsd: money(debit.amountUsd),
        recognizedRevenueUsd: money(debit.paidUsd),
        bonusConsumedUsd: money(debit.bonusUsd),
        discountRate: money(debit.discountRate),
        ledgerSequence: allocation.ledgerSequence ?? null,
      });
    }
  }

  for (const state of states.values()) {
    if (
      !state.fundedPaidUsd.eq(state.grant.paidAmountUsd)
      || !state.fundedBonusUsd.eq(state.grant.bonusAmountUsd)
    ) {
      reasons.push(
        `CANONICAL_FUNDING_GROSS_MISMATCH:${state.grant.id}:paid=${
          money(state.fundedPaidUsd)
        }/${money(state.grant.paidAmountUsd)}:bonus=${money(state.fundedBonusUsd)}/${
          money(state.grant.bonusAmountUsd)}`,
      );
    }
  }

  return {
    grantState: new Map([...states].map(([id, state]) => [id, {
      grant: state.grant,
      paidRemainingUsd: state.paidRemainingUsd,
      bonusRemainingUsd: state.bonusRemainingUsd,
    }])),
    mutations,
    legacyExpiryProofMutations: legacyExpiryProofMutations.sort((left, right) => (
      left.transactionId.localeCompare(right.transactionId)
    )),
    allocationOrderByTransaction,
    reasons,
  };
}

/**
 * Reassigning a canonical consumption row changes the remaining total of its
 * source and target grants by the exact row amount.  This is the only
 * admissible explanation for changing the total remaining amount of an
 * existing legacy admin-recharge grant: the LINK receipt proves the grant's
 * gross funding, while the complete OLD/NEW allocation plan proves where the
 * historical consumption belongs under FIFO.
 */
function canonicalAllocationRemainingDeltaByGrant(
  mutations: BalanceLedgerCanonicalAllocationMutation[],
): Map<string, Prisma.Decimal> {
  const deltas = new Map<string, Prisma.Decimal>();
  const add = (grantId: string, amountUsd: Prisma.Decimal): void => {
    deltas.set(grantId, (deltas.get(grantId) ?? ZERO).plus(amountUsd));
  };
  for (const mutation of mutations) {
    add(mutation.expectedBalanceGrantId, decimal(mutation.expectedAmountUsd));
    add(mutation.balanceGrantId, decimal(mutation.amountUsd).neg());
  }
  return deltas;
}

type MigrationOpeningDebtDraft = {
  grant: BalanceLedgerRepairGrant;
  allocation: BalanceLedgerRepairAllocation;
};

function normalizeMigrationOpeningDebt(
  snapshot: BalanceLedgerRepairSnapshot,
  ordered: OrderedTransaction[],
  accountType: SupportedAccountType,
): {
  snapshot: BalanceLedgerRepairSnapshot;
  drafts: MigrationOpeningDebtDraft[];
  reasons: string[];
} {
  const openingGrants = snapshot.grants.filter((grant) => grant.source === 'MIGRATION_OPENING');
  if (openingGrants.length === 0) return { snapshot, drafts: [], reasons: [] };

  const reasons: string[] = [];
  const drafts: MigrationOpeningDebtDraft[] = [];
  const orderedById = new Map(ordered.map((transaction) => [transaction.id, transaction]));
  const transactionsById = new Map(snapshot.transactions.map((transaction) => [transaction.id, transaction]));
  const allocationsByTransaction = new Map<string, BalanceLedgerRepairAllocation[]>();
  for (const allocation of snapshot.allocations) {
    const rows = allocationsByTransaction.get(allocation.balanceTransactionId) ?? [];
    rows.push(allocation);
    allocationsByTransaction.set(allocation.balanceTransactionId, rows);
  }

  if (accountType !== 'personal') {
    return {
      snapshot,
      drafts: [],
      reasons: openingGrants.map(
        (grant) => `MIGRATION_OPENING_ACCOUNT_TYPE_UNSUPPORTED:${grant.id}:${accountType}`,
      ),
    };
  }

  for (const grant of openingGrants) {
    const linkedAllocations = snapshot.allocations.filter(
      (allocation) => allocation.balanceGrantId === grant.id,
    );
    if (linkedAllocations.length !== 1) {
      reasons.push(`MIGRATION_OPENING_ALLOCATION_CARDINALITY:${grant.id}:${linkedAllocations.length}`);
      continue;
    }
    const allocation = linkedAllocations[0];
    const transaction = transactionsById.get(allocation.balanceTransactionId);
    const orderedTransaction = orderedById.get(allocation.balanceTransactionId);
    if (!transaction || !orderedTransaction) {
      reasons.push(`MIGRATION_OPENING_TRANSACTION_UNPROVEN:${grant.id}:${allocation.balanceTransactionId}`);
      continue;
    }

    const transactionAllocations = allocationsByTransaction.get(transaction.id) ?? [];
    const openingRows = transactionAllocations.filter((row) => (
      snapshot.grants.find((candidate) => candidate.id === row.balanceGrantId)?.source
        === 'MIGRATION_OPENING'
    ));
    const transactionAmountUsd = decimal(transaction.amountUsd).abs();
    const expectedGrantUsd = Prisma.Decimal.min(
      transactionAmountUsd,
      Prisma.Decimal.max(orderedTransaction.beforeUsd, ZERO),
    );
    const expectedDebtUsd = transactionAmountUsd.minus(expectedGrantUsd);
    const nonOpeningGrantUsd = transactionAllocations
      .filter((row) => row.id !== allocation.id && row.source === 'BALANCE_GRANT')
      .reduce((sum, row) => sum.plus(row.amountUsd), ZERO);
    const transactionAllocationUsd = transactionAllocations
      .reduce((sum, row) => sum.plus(row.amountUsd), ZERO);
    const remainingPaidUsd = grant.remainingPaidAmountUsd === null
      ? null
      : decimal(grant.remainingPaidAmountUsd);
    const remainingBonusUsd = grant.remainingBonusAmountUsd === null
      ? null
      : decimal(grant.remainingBonusAmountUsd);
    const componentShapeValid = (
      remainingPaidUsd === null && remainingBonusUsd === null
    ) || (
      remainingPaidUsd?.eq(0) === true && remainingBonusUsd?.eq(0) === true
    );
    const transactionAt = validIsoInstant(transaction.createdAt);
    const validFrom = validIsoInstant(grant.validFrom);
    const grantCreatedAt = validIsoInstant(grant.createdAt);
    const allocationCreatedAt = validIsoInstant(allocation.createdAt);
    const identityValid = Boolean(
      transaction.userId
      && transaction.tenantId
      && grant.userId
      && grant.tenantId
      && allocation.userId
      && allocation.tenantId
      && transaction.userId === grant.userId
      && transaction.userId === allocation.userId
      && transaction.tenantId === grant.tenantId
      && transaction.tenantId === allocation.tenantId
      && (transaction.productId ?? null) === (grant.productId ?? null)
      && (transaction.productId ?? null) === (allocation.productId ?? null)
      && (transaction.tokenUsageId ?? null) === (allocation.tokenUsageId ?? null)
      && allocation.billingAccountId === snapshot.billingAccountId
    );
    const immutableShapeValid = (
      grant.orderId === null
      && grant.expiresAt === null
      && !grant.isExpired
      && decimal(grant.paidAmountUsd).gt(0)
      && decimal(grant.bonusAmountUsd).eq(0)
      && decimal(grant.grantedAmountUsd).eq(grant.paidAmountUsd)
      && decimal(grant.remainingAmountUsd).eq(0)
      && componentShapeValid
      && decimal(grant.discountRate).eq(1)
      && allocation.source === 'BALANCE_GRANT'
      && decimal(allocation.amountUsd).eq(grant.paidAmountUsd)
      && decimal(allocation.recognizedRevenueUsd).eq(allocation.amountUsd)
      && decimal(allocation.bonusConsumedUsd).eq(0)
      && allocationDiscountRate(allocation).eq(1)
      && decimal(allocation.settledUsd).eq(0)
      && allocation.settledAt === null
      && transaction.type === 'CONSUME'
      && decimal(transaction.amountUsd).lt(0)
      && decimal(transaction.balanceAfterUsd).lt(0)
    );
    const chronologyValid = transactionAt !== null
      && validFrom !== null
      && grantCreatedAt !== null
      && allocationCreatedAt !== null
      && transactionAt <= validFrom
      && validFrom <= grantCreatedAt
      && grantCreatedAt <= allocationCreatedAt;
    const splitValid = openingRows.length === 1
      && openingRows[0].id === allocation.id
      && transactionAllocations.every((row) => (
        row.id === allocation.id || row.source === 'BALANCE_GRANT'
      ))
      && transactionAllocationUsd.eq(transactionAmountUsd)
      && nonOpeningGrantUsd.eq(expectedGrantUsd)
      && decimal(allocation.amountUsd).eq(expectedDebtUsd)
      && expectedDebtUsd.gt(0);
    const foreignReference = snapshot.settlements.some(
      (settlement) => settlement.balanceGrantId === grant.id,
    );

    if (!identityValid) reasons.push(`MIGRATION_OPENING_IDENTITY_MISMATCH:${grant.id}`);
    if (!immutableShapeValid) reasons.push(`MIGRATION_OPENING_WRITER_SHAPE_MISMATCH:${grant.id}`);
    if (!chronologyValid) reasons.push(`MIGRATION_OPENING_CHRONOLOGY_MISMATCH:${grant.id}`);
    if (!splitValid) reasons.push(`MIGRATION_OPENING_DEBT_SPLIT_MISMATCH:${grant.id}`);
    if (foreignReference) reasons.push(`MIGRATION_OPENING_FOREIGN_REFERENCE:${grant.id}`);
    if (identityValid && immutableShapeValid && chronologyValid && splitValid && !foreignReference) {
      drafts.push({ grant, allocation });
    }
  }

  if (reasons.length > 0 || drafts.length !== openingGrants.length) {
    return { snapshot, drafts: [], reasons };
  }
  const retiredGrantIds = new Set(drafts.map((draft) => draft.grant.id));
  const debtAllocationIds = new Set(drafts.map((draft) => draft.allocation.id));
  return {
    snapshot: {
      ...snapshot,
      grants: snapshot.grants.filter((grant) => !retiredGrantIds.has(grant.id)),
      allocations: snapshot.allocations.map((allocation) => (
        debtAllocationIds.has(allocation.id)
          ? {
              ...allocation,
              balanceGrantId: null,
              source: 'NEGATIVE_BALANCE',
              recognizedRevenueUsd: money(0),
              bonusConsumedUsd: money(0),
              discountRate: money(0),
              settledUsd: money(0),
              settledAt: null,
            }
          : allocation
      )),
    },
    drafts,
    reasons,
  };
}

type PersonalDebtAllocationDraft = {
  transaction: OrderedTransaction;
  expectedSourceAllocation: BalanceLedgerRepairAllocation;
  targetSourceAllocation: BalanceLedgerRepairAllocation;
  targetDebtAllocation: BalanceLedgerRepairAllocation | null;
};

/**
 * Normalize only the exact pre-V2 personal overdraw fingerprint.  This runs
 * after MIGRATION_OPENING retirement so a placeholder is never confused with
 * the separate writer defect.  The returned snapshot is the sole input to all
 * later grant/debt/settlement replay; if any candidate is not completely
 * proven, no candidate normalization is exposed.
 */
function normalizeLegacyPersonalDebtAllocations(
  snapshot: BalanceLedgerRepairSnapshot,
  ordered: OrderedTransaction[],
  accountType: SupportedAccountType,
): {
  snapshot: BalanceLedgerRepairSnapshot;
  drafts: PersonalDebtAllocationDraft[];
  reasons: string[];
} {
  if (accountType !== 'personal') return { snapshot, drafts: [], reasons: [] };

  const reasons: string[] = [];
  const drafts: PersonalDebtAllocationDraft[] = [];
  const grantsById = new Map(snapshot.grants.map((grant) => [grant.id, grant]));
  const allocationsByTransaction = new Map<string, BalanceLedgerRepairAllocation[]>();
  const existingAllocationIds = new Set(snapshot.allocations.map((allocation) => allocation.id));
  for (const allocation of snapshot.allocations) {
    const rows = allocationsByTransaction.get(allocation.balanceTransactionId) ?? [];
    rows.push(allocation);
    allocationsByTransaction.set(allocation.balanceTransactionId, rows);
  }

  for (const transaction of ordered.filter((row) => row.type === 'CONSUME')) {
    const allocations = allocationsByTransaction.get(transaction.id) ?? [];
    const transactionAmountUsd = transaction.amount.abs();
    const expectedGrantUsd = Prisma.Decimal.min(
      transactionAmountUsd,
      Prisma.Decimal.max(transaction.beforeUsd, ZERO),
    );
    const expectedDebtUsd = transactionAmountUsd.minus(expectedGrantUsd);
    const actualGrantUsd = allocations
      .filter((allocation) => (
        allocation.source === 'BALANCE_GRANT'
        || allocation.source === 'UNRECONCILED_GRANT'
      ))
      .reduce((sum, allocation) => sum.plus(allocation.amountUsd), ZERO);
    const debtRows = allocations.filter((allocation) => allocation.source === 'NEGATIVE_BALANCE');
    const actualDebtUsd = debtRows.reduce((sum, allocation) => sum.plus(allocation.amountUsd), ZERO);
    if (actualGrantUsd.eq(expectedGrantUsd) && actualDebtUsd.eq(expectedDebtUsd)) continue;

    if (expectedDebtUsd.lte(0) || actualDebtUsd.gt(0) || debtRows.length !== 0) {
      reasons.push(`PERSONAL_DEBT_REPAIR_EXISTING_SPLIT_UNSUPPORTED:${transaction.id}`);
      continue;
    }
    if (allocations.length !== 1) {
      reasons.push(`PERSONAL_DEBT_REPAIR_ALLOCATION_CARDINALITY:${transaction.id}:${allocations.length}`);
      continue;
    }
    const source = allocations[0];
    const expectedSourceAllocation: BalanceLedgerRepairAllocation = {
      ...source,
      ledgerSequence: source.ledgerSequence ?? null,
    };
    const grant = source.balanceGrantId == null ? null : grantsById.get(source.balanceGrantId);
    const transactionCreatedAt = validIsoInstant(transaction.createdAt);
    const allocationCreatedAt = validIsoInstant(source.createdAt);
    const sourceSequence = source.ledgerSequence ?? null;
    const legacySequence = sourceSequence === null
      || (/^-\d+$/.test(sourceSequence) && BigInt(sourceSequence) < BigInt(0));
    const identityValid = Boolean(
      transaction.userId
      && transaction.tenantId
      && transaction.tokenUsageId
      && source.billingAccountId === snapshot.billingAccountId
      && source.userId === transaction.userId
      && source.tenantId === transaction.tenantId
      && (source.productId ?? null) === (transaction.productId ?? null)
      && source.tokenUsageId === transaction.tokenUsageId
      && grant?.userId === transaction.userId
      && grant.tenantId === transaction.tenantId
      && (grant.productId ?? null) === (transaction.productId ?? null)
    );
    const sourceAmountUsd = decimal(source.amountUsd);
    const sourcePaidUsd = decimal(source.recognizedRevenueUsd);
    const sourceBonusUsd = decimal(source.bonusConsumedUsd);
    const immutableShapeValid = Boolean(
      grant
      && grant.source !== 'MIGRATION_OPENING'
      && source.source === 'BALANCE_GRANT'
      && sourceAmountUsd.eq(transactionAmountUsd)
      && actualGrantUsd.eq(transactionAmountUsd)
      && sourcePaidUsd.gte(0)
      && sourceBonusUsd.gte(0)
      && sourcePaidUsd.plus(sourceBonusUsd).eq(sourceAmountUsd)
      && allocationDiscountRate(source).eq(sourcePaidUsd.div(sourceAmountUsd))
      && decimal(source.settledUsd).eq(0)
      && source.settledAt === null
      && transaction.amount.lt(0)
      && transaction.operationKey == null
      && transaction.afterUsd.eq(transaction.beforeUsd.plus(transaction.amount))
      && transactionCreatedAt !== null
      && allocationCreatedAt !== null
      && transactionCreatedAt <= allocationCreatedAt
      && legacySequence
    );
    if (!identityValid) {
      reasons.push(`PERSONAL_DEBT_REPAIR_IDENTITY_MISMATCH:${transaction.id}:${source.id}`);
    }
    if (!immutableShapeValid) {
      reasons.push(`PERSONAL_DEBT_REPAIR_WRITER_SHAPE_MISMATCH:${transaction.id}:${source.id}`);
    }
    if (!identityValid || !immutableShapeValid) continue;

    if (expectedGrantUsd.eq(0)) {
      drafts.push({
        transaction,
        expectedSourceAllocation,
        targetSourceAllocation: {
          ...expectedSourceAllocation,
          balanceGrantId: null,
          source: 'NEGATIVE_BALANCE',
          amountUsd: money(source.amountUsd),
          recognizedRevenueUsd: money(0),
          bonusConsumedUsd: money(0),
          discountRate: money(0),
          settledUsd: money(0),
          settledAt: null,
        },
        targetDebtAllocation: null,
      });
      continue;
    }

    // A split adds one historical allocation. Existing negative sequences are
    // already a closed -N..-1 epoch, so there is no integer slot that can be
    // inserted without renumbering immutable rows. NULL legacy rows can all be
    // assigned together; positive V2 rows remain in their separate epoch.
    const fixedLegacySequence = snapshot.allocations.find((allocation) => {
      const sequence = allocation.ledgerSequence ?? null;
      return sequence !== null && /^-\d+$/.test(sequence) && BigInt(sequence) < BigInt(0);
    });
    if (fixedLegacySequence) {
      reasons.push(
        `PERSONAL_DEBT_REPAIR_SEQUENCE_SLOT_UNAVAILABLE:${transaction.id}:`
          + `${fixedLegacySequence.id}:${fixedLegacySequence.ledgerSequence}`,
      );
      continue;
    }

    const targetComponents = splitCanonicalGrantDebit(
      expectedGrantUsd,
      sourcePaidUsd,
      sourceBonusUsd,
    );
    if (!targetComponents) {
      reasons.push(`PERSONAL_DEBT_REPAIR_COMPONENT_SPLIT_INVALID:${transaction.id}:${source.id}`);
      continue;
    }
    const debtAllocationId = `repair-negative-balance-split:${source.id}`;
    if (existingAllocationIds.has(debtAllocationId)) {
      reasons.push(`PERSONAL_DEBT_REPAIR_DETERMINISTIC_ID_COLLISION:${transaction.id}:${debtAllocationId}`);
      continue;
    }
    existingAllocationIds.add(debtAllocationId);
    drafts.push({
      transaction,
      expectedSourceAllocation,
      targetSourceAllocation: {
        ...expectedSourceAllocation,
        amountUsd: money(expectedGrantUsd),
        recognizedRevenueUsd: money(targetComponents.paidUsd),
        bonusConsumedUsd: money(targetComponents.bonusUsd),
        discountRate: money(targetComponents.paidUsd.div(expectedGrantUsd)),
      },
      targetDebtAllocation: {
        ...expectedSourceAllocation,
        id: debtAllocationId,
        balanceGrantId: null,
        source: 'NEGATIVE_BALANCE',
        amountUsd: money(expectedDebtUsd),
        recognizedRevenueUsd: money(0),
        bonusConsumedUsd: money(0),
        discountRate: money(0),
        settledUsd: money(0),
        settledAt: null,
        ledgerSequence: null,
      },
    });
  }

  if (reasons.length > 0) return { snapshot, drafts: [], reasons };
  const targetSourceById = new Map(
    drafts.map((draft) => [draft.expectedSourceAllocation.id, draft.targetSourceAllocation]),
  );
  return {
    snapshot: {
      ...snapshot,
      allocations: [
        ...snapshot.allocations.map(
          (allocation) => targetSourceById.get(allocation.id) ?? allocation,
        ),
        ...drafts.flatMap((draft) => (
          draft.targetDebtAllocation === null ? [] : [draft.targetDebtAllocation]
        )),
      ],
    },
    drafts,
    reasons,
  };
}

function unsafeInvoiceEvidenceReasons(
  invoiceItems: BalanceLedgerRepairInvoiceItemEvidence[],
): string[] {
  const reasons: string[] = [];
  const seenItemIds = new Set<string>();
  for (const item of invoiceItems) {
    if (seenItemIds.has(item.id)) {
      reasons.push(`INVOICE_ITEM_EVIDENCE_DUPLICATE:${item.id}`);
      continue;
    }
    seenItemIds.add(item.id);
    if (item.applicationStatus !== 'FAILED') {
      reasons.push(
        `INVOICE_APPLICATION_STATUS_UNSAFE:${item.applicationId}:${item.applicationStatus}`,
      );
    }
    if (item.hasIssuedLifecycleEvent) {
      reasons.push(`INVOICE_APPLICATION_ISSUED_HISTORY:${item.applicationId}`);
    }
    const artifacts = [
      ['invoiceNumber', item.invoiceNumber],
      ['issueDate', item.issueDate],
      ['dueDate', item.dueDate],
      ['issuedAt', item.issuedAt],
      ['pdfUrl', item.pdfUrl],
      ['ofdUrl', item.ofdUrl],
    ].filter(([, value]) => value !== null).map(([name]) => name);
    if (artifacts.length > 0) {
      reasons.push(
        `INVOICE_APPLICATION_ARTIFACTS_PRESENT:${item.applicationId}:${artifacts.join(',')}`,
      );
    }
  }
  return reasons;
}

export function buildBalanceLedgerRepairPlan(
  snapshot: BalanceLedgerRepairSnapshot,
  repairObservedAt: Date,
  planningProfile: BalanceLedgerRepairPlanningProfile = DEFAULT_PLANNING_PROFILE,
): BalanceLedgerRepairPlan {
  const repairObservedAtMs = repairObservedAt.getTime();
  if (!Number.isFinite(repairObservedAtMs)) {
    throw new Error('repairObservedAt must be a valid database timestamp');
  }
  const preconditionHash = balanceLedgerSnapshotHash(snapshot);
  const reasons: string[] = [];
  const debtSource = debtSourceForAccountType(snapshot.accountType);
  if (!debtSource) reasons.push(`ACCOUNT_TYPE_UNSUPPORTED:${snapshot.accountType}`);
  const accountType = snapshot.accountType as SupportedAccountType;
  const settlementWriteMode = accountType === 'personal' ? 'CREATE' : 'VERIFY_EXISTING';
  if (snapshot.ledgerStatus !== 'LEGACY_DIRTY') {
    reasons.push(`ACCOUNT_NOT_DIRTY:${snapshot.ledgerStatus}`);
  }
  const walletUsd = decimal(snapshot.walletBalanceUsd);
  for (const allocation of snapshot.allocations) {
    if (
      allocation.billingAccountId !== undefined
      && allocation.billingAccountId !== snapshot.billingAccountId
    ) {
      reasons.push(
        `ALLOCATION_ACCOUNT_OWNERSHIP_MISMATCH:${allocation.id}:`
          + `${allocation.billingAccountId ?? 'NULL'}:${snapshot.billingAccountId}`,
      );
    }
  }
  for (const settlement of snapshot.settlements) {
    if (
      settlement.billingAccountId != null
      && settlement.billingAccountId !== snapshot.billingAccountId
    ) {
      reasons.push(
        `SETTLEMENT_ACCOUNT_OWNERSHIP_MISMATCH:${settlement.id}:`
          + `${settlement.billingAccountId}:${snapshot.billingAccountId}`,
      );
    }
  }
  if (accountType === 'personal' && snapshot.settlements.length > 0) {
    reasons.push(`EXISTING_PERSONAL_SETTLEMENTS:${snapshot.settlements.length}`);
  }
  if (snapshot.expiryAuditCount > 0) reasons.push(`EXISTING_EXPIRY_AUDIT:${snapshot.expiryAuditCount}`);
  const invoiceStability = buildInvoiceStabilityProof(snapshot, planningProfile);
  reasons.push(...invoiceStability.reasons);
  if (!invoiceStability.proof) {
    reasons.push(...unsafeInvoiceEvidenceReasons(snapshot.invoiceItems));
  }
  if (snapshot.transactions.some((transaction) => transaction.type === 'REFUND')) {
    reasons.push('REFUND_HISTORY_REQUIRES_MANUAL_REPLAY');
  }

  const transactionOrder = orderTransactions(snapshot.transactions, walletUsd);
  reasons.push(...transactionOrder.reasons);
  const ordered = transactionOrder.ordered;
  const legacyExpiryProof = planLegacyExpiryProofCandidates(
    snapshot,
    ordered,
    planningProfile,
  );
  reasons.push(...legacyExpiryProof.reasons);
  const legacyExpiredVoucherGrantIds = planningProfile.allowLegacyExpiredVoucherProofs
    ? new Set(legacyExpiryProof.byGrantId.keys())
    : new Set<string>();
  const transactionSequencePlan = planTransactionSequences(ordered);
  reasons.push(...transactionSequencePlan.reasons);
  const migrationOpeningDebt = normalizeMigrationOpeningDebt(snapshot, ordered, accountType);
  reasons.push(...migrationOpeningDebt.reasons);
  const personalDebtAllocation = normalizeLegacyPersonalDebtAllocations(
    migrationOpeningDebt.snapshot,
    ordered,
    accountType,
  );
  reasons.push(...personalDebtAllocation.reasons);
  const repairSnapshot = personalDebtAllocation.snapshot;
  const legacyVoucherProof = planLegacyVoucherProofMutations(
    repairSnapshot,
    ordered,
    accountType,
    legacyExpiredVoucherGrantIds,
  );
  reasons.push(...legacyVoucherProof.reasons);
  const initialAllocationSequencePlan = planAllocationSequences(repairSnapshot.allocations, ordered);
  reasons.push(...initialAllocationSequencePlan.reasons);
  if (ordered.length === snapshot.transactions.length) {
    const ledgerBalance = ordered.reduce((sum, row) => sum.plus(row.amount), ZERO);
    if (!ledgerBalance.eq(walletUsd)) {
      reasons.push(`WALLET_LEDGER_MISMATCH:${money(ledgerBalance)}:${money(walletUsd)}`);
    }
  }

  for (const transaction of ordered) {
    if (transaction.type === 'CONSUME') {
      if (transaction.amount.gte(0)) {
        reasons.push(`CONSUMPTION_SIGN_INVALID:${transaction.id}:${money(transaction.amount)}`);
      }
      continue;
    }
    if (transaction.type === 'RECHARGE' || transaction.type === 'ADJUST') {
      if (
        transaction.amount.lte(0)
        && !legacyExpiryProof.byTransactionId.has(transaction.id)
      ) {
        reasons.push(`FUNDING_SIGN_INVALID:${transaction.id}:${money(transaction.amount)}`);
      }
      continue;
    }
    reasons.push(`TRANSACTION_TYPE_UNSUPPORTED:${transaction.id}:${transaction.type}`);
  }

  const legacyAdminFundingProofPlan = buildLegacyAdminFundingProofPlan(repairSnapshot);
  reasons.push(...legacyAdminFundingProofPlan.reasons);
  const replaySnapshot: BalanceLedgerRepairSnapshot = {
    ...repairSnapshot,
    grants: [...repairSnapshot.grants, ...legacyAdminFundingProofPlan.virtualGrants],
  };
  const grantsById = new Map(replaySnapshot.grants.map((grant) => [grant.id, grant]));
  const transactionsById = new Map(
    replaySnapshot.transactions.map((transaction) => [transaction.id, transaction]),
  );
  const allocationsById = new Map(
    replaySnapshot.allocations.map((allocation) => [allocation.id, allocation]),
  );
  const legacyEnterpriseTimingProof = accountType === 'enterprise'
    ? proveLegacyEnterpriseSettlementTiming(
        replaySnapshot,
        transactionsById,
        allocationsById,
        legacyAdminFundingProofPlan.proofByTransactionId,
      )
    : { allocationIds: new Set<string>(), repaymentTransactionIds: new Set<string>(), settlementIds: new Set<string>() };
  const allocationsByTransaction = new Map<string, BalanceLedgerRepairAllocation[]>();
  for (const allocation of repairSnapshot.allocations) {
    const list = allocationsByTransaction.get(allocation.balanceTransactionId) ?? [];
    list.push(allocation);
    allocationsByTransaction.set(allocation.balanceTransactionId, list);
    const allocationAmountUsd = decimal(allocation.amountUsd);
    if (allocationAmountUsd.lte(0)) {
      reasons.push(`ALLOCATION_AMOUNT_INVALID:${allocation.id}:${money(allocationAmountUsd)}`);
    }
    if (
      allocation.source !== 'BALANCE_GRANT'
      && allocation.source !== 'UNRECONCILED_GRANT'
      && allocation.source !== debtSource
    ) {
      reasons.push(`ALLOCATION_SOURCE_UNSUPPORTED:${allocation.id}:${allocation.source}`);
    }
    const allocationTransaction = transactionsById.get(allocation.balanceTransactionId);
    if (!allocationTransaction) {
      reasons.push(`ALLOCATION_TRANSACTION_MISSING:${allocation.id}:${allocation.balanceTransactionId}`);
    } else if (allocationTransaction.type !== 'CONSUME') {
      reasons.push(
        `ALLOCATION_TRANSACTION_NOT_CONSUME:${allocation.id}:${allocation.balanceTransactionId}`,
      );
    } else if (
      allocation.userId == null
      || allocation.userId !== allocationTransaction.userId
      || (allocation.tenantId ?? null) !== (allocationTransaction.tenantId ?? null)
      || (allocation.productId ?? null) !== (allocationTransaction.productId ?? null)
      || (allocation.tokenUsageId ?? null) !== (allocationTransaction.tokenUsageId ?? null)
    ) {
      reasons.push(`ALLOCATION_TRANSACTION_SUBJECT_MISMATCH:${allocation.id}:${allocation.balanceTransactionId}`);
    }
    if (allocation.source === debtSource && allocation.balanceGrantId) {
      reasons.push(`DEBT_ALLOCATION_HAS_GRANT:${allocation.id}:${allocation.balanceGrantId}`);
    }
    const allocationDiscountRate = decimal(allocation.discountRate ?? 0);
    if (allocation.source === debtSource && !allocationDiscountRate.eq(0)) {
      reasons.push(
        `DEBT_ALLOCATION_DISCOUNT_INVALID:${allocation.id}:${money(allocationDiscountRate)}`,
      );
    }
    if (
      allocation.source === 'BALANCE_GRANT'
      && (!decimal(allocation.settledUsd).eq(0) || allocation.settledAt)
    ) {
      reasons.push(`GRANT_ALLOCATION_HAS_DEBT_STATE:${allocation.id}`);
    }
  }

  for (const transaction of ordered.filter((row) => row.type === 'CONSUME')) {
    const transactionAllocations = allocationsByTransaction.get(transaction.id) ?? [];
    const allocationTotal = transactionAllocations
      .reduce((sum, allocation) => sum.plus(allocation.amountUsd), ZERO);
    if (!allocationTotal.eq(transaction.amount.abs())) {
      reasons.push(
        `CONSUMPTION_ALLOCATION_MISMATCH:${transaction.id}:${money(allocationTotal)}:${
          money(transaction.amount.abs())
        }`,
      );
    }
    const expectedGrantUsd = Prisma.Decimal.min(
      transaction.amount.abs(),
      Prisma.Decimal.max(transaction.beforeUsd, ZERO),
    );
    const expectedDebtUsd = transaction.amount.abs().minus(expectedGrantUsd);
    const actualGrantUsd = transactionAllocations
      .filter((allocation) => (
        allocation.source === 'BALANCE_GRANT'
        || allocation.source === 'UNRECONCILED_GRANT'
      ))
      .reduce((sum, allocation) => sum.plus(allocation.amountUsd), ZERO);
    const actualDebtUsd = transactionAllocations
      .filter((allocation) => allocation.source === debtSource)
      .reduce((sum, allocation) => sum.plus(allocation.amountUsd), ZERO);
    if (!actualGrantUsd.eq(expectedGrantUsd) || !actualDebtUsd.eq(expectedDebtUsd)) {
      reasons.push(
        `CONSUMPTION_SPLIT_MISMATCH:${transaction.id}:grant=${money(actualGrantUsd)}/${
          money(expectedGrantUsd)
        }:debt=${money(actualDebtUsd)}/${money(expectedDebtUsd)}`,
      );
    }
    const debtRows = transactionAllocations.filter(
      (allocation) => allocation.source === debtSource,
    );
    // A V1/V2 debit creates at most one debt allocation for a consumption
    // transaction. Multiple legacy debt rows have no immutable intra-
    // transaction ordering, so choosing one by UUID would invent FIFO and can
    // recognize paid settlement against the wrong subject.
    if (expectedDebtUsd.gt(0) && debtRows.length !== 1) {
      reasons.push(
        `DEBT_ALLOCATION_CARDINALITY_AMBIGUOUS:${transaction.id}:${debtRows.length}`,
      );
    }
  }

  const debtAllocations = canonicalAllocationOrder(repairSnapshot.allocations, ordered)
    .filter((allocation) => allocation.source === debtSource);
  for (const allocation of debtAllocations) {
    const settledUsd = decimal(allocation.settledUsd);
    const recognizedRevenueUsd = decimal(allocation.recognizedRevenueUsd);
    const bonusConsumedUsd = decimal(allocation.bonusConsumedUsd);
    if (accountType === 'personal') {
      if (
        !settledUsd.eq(0)
        || !recognizedRevenueUsd.eq(0)
        || !bonusConsumedUsd.eq(0)
        || allocation.settledAt
      ) {
        reasons.push(`PERSONAL_DEBT_ALLOCATION_ALREADY_MUTATED:${allocation.id}`);
      }
      continue;
    }
    const amountUsd = decimal(allocation.amountUsd);
    if (
      settledUsd.lt(0)
      || settledUsd.gt(amountUsd)
      || recognizedRevenueUsd.lt(0)
      || recognizedRevenueUsd.gt(settledUsd)
      || bonusConsumedUsd.lt(0)
      || bonusConsumedUsd.gt(settledUsd)
      || (settledUsd.eq(amountUsd) ? !allocation.settledAt : Boolean(allocation.settledAt))
    ) {
      reasons.push(`ENTERPRISE_DEBT_ALLOCATION_STATE_INVALID:${allocation.id}`);
    }
  }

  for (const grant of replaySnapshot.grants) {
    const remaining = decimal(grant.remainingAmountUsd);
    const paid = decimal(grant.paidAmountUsd);
    const bonus = decimal(grant.bonusAmountUsd);
    const granted = decimal(grant.grantedAmountUsd);
    const expectedDiscount = granted.gt(0)
      ? paid.div(granted).toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP)
      : ZERO;
    const grantValidFrom = validIsoInstant(grant.validFrom);
    const grantExpiresAt = grant.expiresAt == null
      ? null
      : validIsoInstant(grant.expiresAt);
    if (
      paid.lt(0)
      || bonus.lt(0)
      || granted.lte(0)
      || remaining.lt(0)
      || !paid.plus(bonus).eq(granted)
      || granted.lt(remaining)
      || !decimal(grant.discountRate).eq(expectedDiscount)
    ) {
      reasons.push(`GRANT_GROSS_COMPONENTS_INVALID:${grant.id}`);
    }
    if (grantValidFrom === null || grantValidFrom > repairObservedAtMs) {
      reasons.push(`GRANT_VALID_FROM_FUTURE_OR_INVALID:${grant.id}`);
    }
    if (
      grant.expiresAt != null
      && (grantExpiresAt === null || grantValidFrom === null || grantExpiresAt <= grantValidFrom)
    ) {
      reasons.push(`GRANT_EXPIRY_WINDOW_INVALID:${grant.id}`);
    }
    if (
      !grant.isExpired
      && remaining.gt(0)
      && grantExpiresAt !== null
      && grantExpiresAt <= repairObservedAtMs
    ) {
      reasons.push(`DUE_GRANT_REQUIRES_EXPIRY_BEFORE_REPAIR:${grant.id}`);
    }
    if (grant.isExpired && !legacyExpiryProof.byGrantId.has(grant.id)) {
      reasons.push(`LEGACY_EXPIRY_REQUIRES_MANUAL_REPLAY:${grant.id}`);
    }
    if (grant.source === 'MIGRATION_OPENING' && remaining.gt(0)) {
      reasons.push(`OPEN_MIGRATION_GRANT_REQUIRES_MANUAL_REPLAY:${grant.id}`);
    }
  }

  if (reasons.length > 0) return quarantine(snapshot, preconditionHash, reasons);
  const unreconciledGrantReplay = replayUnreconciledGrantAllocations(
    replaySnapshot,
    ordered,
    accountType,
    legacyExpiryProof.byTransactionId,
    legacyAdminFundingProofPlan.proofByTransactionId,
    legacyExpiredVoucherGrantIds,
  );
  reasons.push(...unreconciledGrantReplay.reasons);
  if (reasons.length > 0) return quarantine(snapshot, preconditionHash, reasons);
  const canonicalGrantReplay = replayCanonicalGrantAllocations(
    replaySnapshot,
    ordered,
    accountType,
    unreconciledGrantReplay.mutations,
    legacyExpiryProof.byGrantId,
    legacyExpiryProof.byTransactionId,
    legacyAdminFundingProofPlan.proofByTransactionId,
    legacyExpiredVoucherGrantIds,
  );
  reasons.push(...canonicalGrantReplay.reasons);
  if (
    canonicalGrantReplay.legacyExpiryProofMutations.length
      !== legacyExpiryProof.byGrantId.size
  ) {
    reasons.push(
      `LEGACY_EXPIRY_PROOF_COUNT_MISMATCH:`
        + `${canonicalGrantReplay.legacyExpiryProofMutations.length}:`
        + `${legacyExpiryProof.byGrantId.size}`,
    );
  }
  if (reasons.length > 0) return quarantine(snapshot, preconditionHash, reasons);
  const allocationSequencePlan = planAllocationSequences(
    repairSnapshot.allocations,
    ordered,
    canonicalGrantReplay.allocationOrderByTransaction,
  );
  reasons.push(...allocationSequencePlan.reasons);
  if (reasons.length > 0) return quarantine(snapshot, preconditionHash, reasons);
  const sequenceTargetByAllocation = new Map(
    allocationSequencePlan.mutations.map((mutation) => [
      mutation.allocationId,
      mutation.ledgerSequence,
    ]),
  );
  const allCanonicalAllocationMutations = canonicalGrantReplay.mutations.map((mutation) => ({
    ...mutation,
    ledgerSequence: sequenceTargetByAllocation.get(mutation.allocationId)
      ?? mutation.expectedLedgerSequence,
  }));
  const canonicalAllocationIds = new Set(
    allCanonicalAllocationMutations.map((mutation) => mutation.allocationId),
  );
  const standaloneAllocationSequenceMutations = allocationSequencePlan.mutations.filter(
    (mutation) => !canonicalAllocationIds.has(mutation.allocationId),
  );

  const openDebt: OpenDebt[] = [];
  const allocationState = new Map<string, OpenDebt>();
  const grantState = canonicalGrantReplay.grantState;
  const settlementMutations: BalanceLedgerSettlementMutation[] = [];
  let settlementSequence = 0;

  for (const transaction of ordered) {
    if (transaction.type === 'CONSUME') {
      const debts = (allocationsByTransaction.get(transaction.id) ?? [])
        .filter((allocation) => allocation.source === debtSource)
        .sort((left, right) => left.id.localeCompare(right.id));
      for (const allocation of debts) {
        const debt: OpenDebt = {
          allocation,
          remainingUsd: decimal(allocation.amountUsd),
          paidUsd: ZERO,
          bonusUsd: ZERO,
          settledAt: null,
        };
        openDebt.push(debt);
        allocationState.set(allocation.id, debt);
      }
      continue;
    }
    if (transaction.amount.lte(0)) continue;
    const evidence = resolveFundingEvidence(
      transaction,
      replaySnapshot.grants,
      replaySnapshot.transactions,
      replaySnapshot.orders,
      replaySnapshot.voucherIdempotencyEvidence,
      replaySnapshot.billingAccountId,
      accountType,
      legacyAdminFundingProofPlan.proofByTransactionId,
      legacyExpiredVoucherGrantIds,
    );
    if (evidence.status === 'AMBIGUOUS') {
      reasons.push(evidence.reason);
      continue;
    }
    const nature = evidence.nature;
    let holeFillUsd = Prisma.Decimal.min(
      transaction.amount,
      Prisma.Decimal.max(transaction.beforeUsd.neg(), ZERO),
    );
    if (holeFillUsd.lte(0)) continue;
    while (holeFillUsd.gt(0)) {
      const debt = openDebt.find((entry) => entry.remainingUsd.gt(0));
      if (!debt) {
        reasons.push(`FUNDING_HOLE_EXCEEDS_TRACKED_DEBT:${transaction.id}:${money(holeFillUsd)}`);
        break;
      }
      const appliedUsd = Prisma.Decimal.min(holeFillUsd, debt.remainingUsd);
      debt.remainingUsd = debt.remainingUsd.minus(appliedUsd);
      if (nature === 'PAID') debt.paidUsd = debt.paidUsd.plus(appliedUsd);
      else debt.bonusUsd = debt.bonusUsd.plus(appliedUsd);
      if (debt.remainingUsd.eq(0)) debt.settledAt = transaction.createdAt;
      settlementSequence += 1;
      settlementMutations.push({
        sequence: settlementSequence,
        allocationId: debt.allocation.id,
        repaymentTransactionId: transaction.id,
        balanceGrantId: evidence.settlementBalanceGrantId,
        debtSource: debtSource!,
        fundingNature: nature,
        amountUsd: money(appliedUsd),
        paidUsd: nature === 'PAID' ? money(appliedUsd) : money(0),
        bonusUsd: nature === 'BONUS' ? money(appliedUsd) : money(0),
        occurredAt: transaction.createdAt,
      });
      holeFillUsd = holeFillUsd.minus(appliedUsd);
    }
  }

  const migrationOpeningAllocationIdsForVoucherProof = new Set(
    migrationOpeningDebt.drafts.map((draft) => draft.allocation.id),
  );
  const legacyVoucherProofMutations = legacyVoucherProof.mutations.map((proof) => {
    if (proof.repairKind !== 'LEGACY_VOUCHER_FULL_REMAINDER_DEBT_ABSORPTION_V1') {
      return proof;
    }
    const settlements = settlementMutations.filter(
      (settlement) => settlement.repaymentTransactionId === proof.transactionId,
    );
    const settlementUsd = settlements.reduce(
      (sum, settlement) => sum.plus(settlement.amountUsd),
      ZERO,
    );
    const allocationIds = [...new Set(settlements.map((settlement) => settlement.allocationId))]
      .sort();
    if (
      !settlementUsd.eq(proof.holeFillUsd)
      || settlements.length === 0
      || allocationIds.length !== settlements.length
      || settlements.some((settlement) => (
        settlement.balanceGrantId !== proof.grantId
        || settlement.fundingNature !== 'BONUS'
        || !migrationOpeningAllocationIdsForVoucherProof.has(settlement.allocationId)
      ))
    ) {
      reasons.push(
        `LEGACY_VOUCHER_OPENING_DEBT_ABSORPTION_MISMATCH:${proof.transactionId}:`
          + `${money(settlementUsd)}:${proof.holeFillUsd}`,
      );
    }
    return { ...proof, openingDebtAllocationIds: allocationIds };
  });

  if (reasons.length > 0) return quarantine(snapshot, preconditionHash, reasons);

  const openDebtUsd = openDebt.reduce((sum, entry) => sum.plus(entry.remainingUsd), ZERO);
  const currentDebtUsd = Prisma.Decimal.max(walletUsd.neg(), ZERO);
  if (!openDebtUsd.eq(currentDebtUsd)) {
    reasons.push(`OPEN_DEBT_WALLET_MISMATCH:${money(openDebtUsd)}:${money(currentDebtUsd)}`);
  }
  const legacySettledDebtUsd = settlementMutations
    .reduce((sum, settlement) => sum.plus(settlement.amountUsd), ZERO);
  const virtualGrantIds = new Set(
    legacyAdminFundingProofPlan.virtualGrants.map((grant) => grant.id),
  );
  const linkedAdminFundingGrantIds = new Set(
    legacyAdminFundingProofPlan.repairs
      .filter((repair) => repair.action === 'LINK_GRANT')
      .map((repair) => repair.grantId),
  );
  const canonicalRemainingDeltaByGrant = canonicalAllocationRemainingDeltaByGrant(
    allCanonicalAllocationMutations,
  );

  if (accountType === 'enterprise') {
    for (const debt of allocationState.values()) {
      const expectedSettledUsd = debt.paidUsd.plus(debt.bonusUsd);
      const fullySettled = debt.remainingUsd.eq(0);
      const settledAtMatches = normalizedIsoInstant(debt.allocation.settledAt)
        === normalizedIsoInstant(debt.settledAt)
        || (
          fullySettled
          && legacyEnterpriseTimingProof.allocationIds.has(debt.allocation.id)
        );
      if (
        !decimal(debt.allocation.settledUsd).eq(expectedSettledUsd)
        || (debt.settledAt !== null) !== fullySettled
        || !settledAtMatches
      ) {
        reasons.push(`ENTERPRISE_ALLOCATION_SETTLEMENT_STATE_MISMATCH:${debt.allocation.id}`);
      }
    }
    reasons.push(...validateEnterpriseSettlements(
      repairSnapshot,
      settlementMutations,
      transactionsById,
      allocationsById,
      grantsById,
      legacyEnterpriseTimingProof,
    ));
  }

  for (const replayedGrant of grantState.values()) {
    if (
      replayedGrant.paidRemainingUsd.lt(0)
      || replayedGrant.bonusRemainingUsd.lt(0)
    ) {
      reasons.push(
        `REPLAYED_GRANT_COMPONENT_NEGATIVE:${replayedGrant.grant.id}:paid=${
          money(replayedGrant.paidRemainingUsd)
        }:bonus=${money(replayedGrant.bonusRemainingUsd)}`,
      );
    }
    const currentRemainingUsd = decimal(replayedGrant.grant.remainingAmountUsd);
    const replayedRemainingUsd = replayedGrant.paidRemainingUsd
      .plus(replayedGrant.bonusRemainingUsd);
    const linkedGrantTotalChangeIsProven = linkedAdminFundingGrantIds.has(
      replayedGrant.grant.id,
    ) && currentRemainingUsd.plus(
      canonicalRemainingDeltaByGrant.get(replayedGrant.grant.id) ?? ZERO,
    ).eq(replayedRemainingUsd);
    if (
      accountType === 'enterprise'
      && !virtualGrantIds.has(replayedGrant.grant.id)
      && !currentRemainingUsd.eq(replayedRemainingUsd)
      && !linkedGrantTotalChangeIsProven
    ) {
      reasons.push(`ENTERPRISE_GRANT_TOTAL_REPLAY_MISMATCH:${replayedGrant.grant.id}`);
    }
  }
  const expectedActiveGrantUsd = [...grantState.values()]
    .filter(({ grant }) => {
      const validFrom = validIsoInstant(grant.validFrom);
      const expiresAt = grant.expiresAt == null ? null : validIsoInstant(grant.expiresAt);
      return !grant.isExpired
        && validFrom !== null
        && validFrom <= repairObservedAtMs
        && (expiresAt === null || expiresAt > repairObservedAtMs);
    })
    .reduce((sum, replayedGrant) => sum
      .plus(Prisma.Decimal.max(replayedGrant.paidRemainingUsd, ZERO))
      .plus(Prisma.Decimal.max(replayedGrant.bonusRemainingUsd, ZERO)), ZERO);
  const walletPositiveUsd = Prisma.Decimal.max(walletUsd, ZERO);
  if (!expectedActiveGrantUsd.eq(walletPositiveUsd)) {
    reasons.push(
      `REPLAYED_GRANT_WALLET_MISMATCH:${money(expectedActiveGrantUsd)}:${money(walletPositiveUsd)}`,
    );
  }
  if (reasons.length > 0) return quarantine(snapshot, preconditionHash, reasons);

  const legacyAdminFundingRepairs = legacyAdminFundingProofPlan.repairs.map((repair) => {
    const state = grantState.get(repair.grantId);
    if (!state) {
      reasons.push(`LEGACY_ADMIN_FUNDING_REPLAY_GRANT_MISSING:${repair.transactionId}:${repair.grantId}`);
      return repair;
    }
    const finalPaidUsd = Prisma.Decimal.max(state.paidRemainingUsd, ZERO);
    const finalBonusUsd = Prisma.Decimal.max(state.bonusRemainingUsd, ZERO);
    return {
      ...repair,
      finalRemainingAmountUsd: money(finalPaidUsd.plus(finalBonusUsd)),
      finalRemainingPaidAmountUsd: money(finalPaidUsd),
      finalRemainingBonusAmountUsd: money(finalBonusUsd),
    };
  });
  if (reasons.length > 0) return quarantine(snapshot, preconditionHash, reasons);

  const allocationMutations = [...allocationState.values()]
    .filter((entry) => {
      const settledUsd = entry.paidUsd.plus(entry.bonusUsd);
      if (settledUsd.lte(0)) return false;
      const targetSettledAt = legacyEnterpriseTimingProof.allocationIds.has(entry.allocation.id)
        ? normalizedIsoInstant(entry.allocation.settledAt)
        : normalizedIsoInstant(entry.settledAt);
      return !decimal(entry.allocation.settledUsd).eq(settledUsd)
        || !decimal(entry.allocation.recognizedRevenueUsd).eq(entry.paidUsd)
        || !decimal(entry.allocation.bonusConsumedUsd).eq(entry.bonusUsd)
        || normalizedIsoInstant(entry.allocation.settledAt) !== targetSettledAt;
    })
    .map((entry): BalanceLedgerAllocationMutation => {
      const settledUsd = entry.paidUsd.plus(entry.bonusUsd);
      const currentSettledAt = normalizedIsoInstant(entry.allocation.settledAt);
      const targetSettledAt = legacyEnterpriseTimingProof.allocationIds.has(entry.allocation.id)
        ? currentSettledAt
        : normalizedIsoInstant(entry.settledAt);
      return {
        allocationId: entry.allocation.id,
        expectedSettledUsd: money(entry.allocation.settledUsd),
        expectedRecognizedRevenueUsd: money(entry.allocation.recognizedRevenueUsd),
        expectedBonusConsumedUsd: money(entry.allocation.bonusConsumedUsd),
        expectedSettledAt: currentSettledAt,
        settledUsd: money(settledUsd),
        recognizedRevenueUsd: money(entry.paidUsd),
        bonusConsumedUsd: money(entry.bonusUsd),
        settledAt: targetSettledAt,
      };
    });

  const migrationOpeningAllocationIds = new Set(
    migrationOpeningDebt.drafts.map((draft) => draft.allocation.id),
  );
  const migrationOpeningDebtMutations = migrationOpeningDebt.drafts.map(
    ({ grant, allocation }): BalanceLedgerMigrationOpeningDebtMutation => {
      const debt = allocationState.get(allocation.id);
      if (!debt) {
        throw new Error(`MIGRATION_OPENING_DEBT_REPLAY_MISSING:${allocation.id}`);
      }
      const settledUsd = debt.paidUsd.plus(debt.bonusUsd);
      return {
        allocationId: allocation.id,
        grantId: grant.id,
        expectedGrant: grant,
        expectedUserId: allocation.userId!,
        expectedTenantId: allocation.tenantId!,
        expectedProductId: allocation.productId ?? null,
        expectedBalanceTransactionId: allocation.balanceTransactionId,
        expectedTokenUsageId: allocation.tokenUsageId ?? null,
        expectedBalanceGrantId: grant.id,
        expectedSource: 'BALANCE_GRANT',
        expectedAmountUsd: money(allocation.amountUsd),
        expectedRecognizedRevenueUsd: money(allocation.recognizedRevenueUsd),
        expectedBonusConsumedUsd: money(allocation.bonusConsumedUsd),
        expectedDiscountRate: money(allocationDiscountRate(allocation)),
        expectedSettledUsd: money(allocation.settledUsd),
        expectedSettledAt: null,
        expectedLedgerSequence: allocation.ledgerSequence ?? null,
        expectedCreatedAt: new Date(allocation.createdAt).toISOString(),
        source: 'NEGATIVE_BALANCE',
        balanceGrantId: null,
        amountUsd: money(allocation.amountUsd),
        recognizedRevenueUsd: money(debt.paidUsd),
        bonusConsumedUsd: money(debt.bonusUsd),
        discountRate: money(0),
        settledUsd: money(settledUsd),
        settledAt: normalizedIsoInstant(debt.settledAt),
        ledgerSequence: sequenceTargetByAllocation.get(allocation.id)
          ?? allocation.ledgerSequence
          ?? null,
      };
    },
  );
  const canonicalTargetByAllocationId = new Map(
    allCanonicalAllocationMutations.map((mutation) => [mutation.allocationId, mutation]),
  );
  const targetDebtSnapshot = (
    allocation: BalanceLedgerRepairAllocation,
  ): BalanceLedgerRepairAllocation => {
    const debt = allocationState.get(allocation.id);
    if (!debt) throw new Error(`PERSONAL_DEBT_REPLAY_MISSING:${allocation.id}`);
    const settledUsd = debt.paidUsd.plus(debt.bonusUsd);
    return {
      ...allocation,
      recognizedRevenueUsd: money(debt.paidUsd),
      bonusConsumedUsd: money(debt.bonusUsd),
      discountRate: money(0),
      settledUsd: money(settledUsd),
      settledAt: normalizedIsoInstant(debt.settledAt),
      ledgerSequence: sequenceTargetByAllocation.get(allocation.id)
        ?? allocation.ledgerSequence
        ?? null,
    };
  };
  const personalDebtAllocationMutations = personalDebtAllocation.drafts.map(
    (draft): BalanceLedgerPersonalDebtAllocationMutation => {
      const canonicalTarget = canonicalTargetByAllocationId.get(
        draft.targetSourceAllocation.id,
      );
      let targetSourceAllocation: BalanceLedgerRepairAllocation = {
        ...draft.targetSourceAllocation,
        ledgerSequence: sequenceTargetByAllocation.get(draft.targetSourceAllocation.id)
          ?? draft.targetSourceAllocation.ledgerSequence
          ?? null,
      };
      if (canonicalTarget) {
        targetSourceAllocation = {
          ...targetSourceAllocation,
          balanceGrantId: canonicalTarget.balanceGrantId,
          amountUsd: canonicalTarget.amountUsd,
          recognizedRevenueUsd: canonicalTarget.recognizedRevenueUsd,
          bonusConsumedUsd: canonicalTarget.bonusConsumedUsd,
          discountRate: canonicalTarget.discountRate,
          ledgerSequence: canonicalTarget.ledgerSequence,
        };
      }
      if (draft.targetDebtAllocation === null) {
        targetSourceAllocation = targetDebtSnapshot(targetSourceAllocation);
      }
      const targetDebtAllocation = draft.targetDebtAllocation === null
        ? null
        : targetDebtSnapshot(draft.targetDebtAllocation);
      return {
        proofVersion: 1,
        repairKind: draft.targetDebtAllocation === null
          ? 'LEGACY_DEBT_RECLASS_V1'
          : 'LEGACY_DEBT_SPLIT_V1',
        transactionId: draft.transaction.id,
        sourceAllocationId: draft.expectedSourceAllocation.id,
        createdDebtAllocationId: targetDebtAllocation?.id ?? null,
        expectedTransactionBeforeUsd: money(draft.transaction.beforeUsd),
        expectedTransactionAfterUsd: money(draft.transaction.afterUsd),
        expectedSourceAllocation: draft.expectedSourceAllocation,
        targetSourceAllocation,
        targetDebtAllocation,
      };
    },
  );
  const personalDebtAllocationIds = new Set(personalDebtAllocationMutations.flatMap(
    (mutation) => [
      mutation.sourceAllocationId,
      ...(mutation.createdDebtAllocationId === null ? [] : [mutation.createdDebtAllocationId]),
    ],
  ));
  const canonicalAllocationMutations = allCanonicalAllocationMutations.filter(
    (mutation) => !personalDebtAllocationIds.has(mutation.allocationId),
  );
  const regularAllocationMutations = allocationMutations.filter(
    (mutation) => !migrationOpeningAllocationIds.has(mutation.allocationId)
      && !personalDebtAllocationIds.has(mutation.allocationId),
  );
  const regularAllocationSequenceMutations = standaloneAllocationSequenceMutations.filter(
    (mutation) => !migrationOpeningAllocationIds.has(mutation.allocationId)
      && !personalDebtAllocationIds.has(mutation.allocationId),
  );

  const grantMutations = [...grantState.values()]
    .filter(({ grant }) => !virtualGrantIds.has(grant.id))
    .map(({ grant, paidRemainingUsd, bonusRemainingUsd }) => {
      const targetPaidUsd = Prisma.Decimal.max(paidRemainingUsd, ZERO);
      const targetBonusUsd = Prisma.Decimal.max(bonusRemainingUsd, ZERO);
      const targetTotalUsd = targetPaidUsd.plus(targetBonusUsd);
      const currentPaidUsd = grant.remainingPaidAmountUsd === null
        ? null
        : decimal(grant.remainingPaidAmountUsd);
      const currentBonusUsd = grant.remainingBonusAmountUsd === null
        ? null
        : decimal(grant.remainingBonusAmountUsd);
      if (
        decimal(grant.remainingAmountUsd).eq(targetTotalUsd)
        && currentPaidUsd?.eq(targetPaidUsd)
        && currentBonusUsd?.eq(targetBonusUsd)
      ) {
        return null;
      }
      return {
        grantId: grant.id,
        expectedRemainingAmountUsd: money(grant.remainingAmountUsd),
        expectedRemainingPaidAmountUsd: currentPaidUsd === null ? null : money(currentPaidUsd),
        expectedRemainingBonusAmountUsd: currentBonusUsd === null ? null : money(currentBonusUsd),
        remainingAmountUsd: money(targetTotalUsd),
        remainingPaidAmountUsd: money(targetPaidUsd),
        remainingBonusAmountUsd: money(targetBonusUsd),
      } satisfies BalanceLedgerGrantMutation;
    })
    .filter((mutation): mutation is BalanceLedgerGrantMutation => mutation !== null);
  const currentActiveGrantUsd = repairSnapshot.grants
    .filter((grant) => {
      const validFrom = validIsoInstant(grant.validFrom);
      const expiresAt = grant.expiresAt == null ? null : validIsoInstant(grant.expiresAt);
      return !grant.isExpired
        && validFrom !== null
        && validFrom <= repairObservedAtMs
        && (expiresAt === null || expiresAt > repairObservedAtMs);
    })
    .reduce((sum, grant) => sum.plus(grant.remainingAmountUsd), ZERO);
  const activeGrantDriftUsd = currentActiveGrantUsd.minus(expectedActiveGrantUsd).abs();
  const throughTransactionId = ordered.at(-1)?.id ?? null;
  const hashInput: ReplayHashInput = {
    billingAccountId: snapshot.billingAccountId,
    accountType,
    debtSource: debtSource!,
    settlementWriteMode,
    expectedSettlementCount: accountType === 'personal'
      ? settlementMutations.length
      : repairSnapshot.settlements.length,
    walletBalanceUsd: money(walletUsd),
    currentDebtUsd: money(openDebtUsd),
    transactionSequenceMutations: transactionSequencePlan.mutations,
    grantMutations,
    allocationMutations: regularAllocationMutations,
    allocationSequenceMutations: regularAllocationSequenceMutations,
    unreconciledGrantMutations: unreconciledGrantReplay.mutations,
    canonicalAllocationMutations,
    migrationOpeningDebtMutations,
    personalDebtAllocationMutations,
    legacyVoucherProofMutations,
    legacyExpiryProofMutations: canonicalGrantReplay.legacyExpiryProofMutations,
    invoiceStabilityProof: invoiceStability.proof,
    settlementMutations,
    legacyAdminFundingRepairs,
    throughTransactionId,
  };
  const replayHash = balanceLedgerRepairReplayHash(hashInput);

  return {
    status: 'READY',
    billingAccountId: snapshot.billingAccountId,
    accountType,
    debtSource: debtSource!,
    settlementWriteMode,
    expectedSettlementCount: hashInput.expectedSettlementCount,
    preconditionHash,
    replayHash,
    walletBalanceUsd: money(walletUsd),
    currentDebtUsd: money(currentDebtUsd),
    legacySettledDebtUsd: money(legacySettledDebtUsd),
    activeGrantDriftUsd: money(activeGrantDriftUsd),
    throughTransactionId,
    transactionSequenceMutations: transactionSequencePlan.mutations,
    grantMutations,
    allocationMutations: regularAllocationMutations,
    allocationSequenceMutations: regularAllocationSequenceMutations,
    unreconciledGrantMutations: unreconciledGrantReplay.mutations,
    canonicalAllocationMutations,
    migrationOpeningDebtMutations,
    personalDebtAllocationMutations,
    legacyVoucherProofMutations,
    legacyExpiryProofMutations: canonicalGrantReplay.legacyExpiryProofMutations,
    invoiceStabilityProof: invoiceStability.proof,
    settlementMutations,
    legacyAdminFundingRepairs,
  };
}
