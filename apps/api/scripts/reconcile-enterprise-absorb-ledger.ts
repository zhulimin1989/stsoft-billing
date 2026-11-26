import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Prisma, PrismaClient } from '@prisma/client';

type Client = PrismaClient | Prisma.TransactionClient;

const prisma = new PrismaClient();
const ZERO = new Prisma.Decimal(0);
const RECHARGE_VALIDITY_DAYS = 365;
const PLAN_FORMAT = 'BALANCE_ENTERPRISE_ABSORB_REPAIR_PLAN_V1' as const;
const REPAIR_KIND = 'ENTERPRISE_ABSORB_V1' as const;
const ADMIN_GRANT_REPAIR_KIND = 'LEGACY_ENTERPRISE_ADMIN_RECHARGE_V1' as const;

type RepairDatabaseBinding = {
  databaseName: string;
  databaseIdentity: string;
  databaseSystemIdentifier: string;
  databaseOid: string;
  phase: 'V2_CONTRACT';
};

type RepairPlanManifest = RepairDatabaseBinding & {
  recordType: typeof PLAN_FORMAT;
  endpointSha256: string;
};

export type EnterpriseAbsorbAccountEvidence = {
  id: string;
  type: string;
  ownerUserId: string | null;
  status: string;
  currency: string;
  ledgerStatus: string;
  ledgerVersion: number;
  walletBalanceUsd: string;
};

export type EnterpriseAbsorbTransactionEvidence = {
  id: string;
  billingAccountId: string;
  userId: string;
  tenantId: string;
  productId: string | null;
  tokenUsageId: string | null;
  type: string;
  amountUsd: string;
  balanceAfterUsd: string;
  description: string;
  orderId: string | null;
  operationKey: string | null;
  ledgerSequence: string | null;
  createdAt: string;
  xmin: string;
};

export type EnterpriseAbsorbGrantEvidence = {
  id: string;
  billingAccountId: string;
  userId: string;
  tenantId: string;
  productId: string | null;
  orderId: string | null;
  source: string;
  paidAmountUsd: string;
  bonusAmountUsd: string;
  grantedAmountUsd: string;
  remainingAmountUsd: string;
  remainingPaidAmountUsd: string | null;
  remainingBonusAmountUsd: string | null;
  discountRate: string;
  validFrom: string;
  expiresAt: string | null;
  isExpired: boolean;
  createdAt: string;
};

export type EnterpriseAbsorbAllocationEvidence = {
  id: string;
  billingAccountId: string;
  userId: string;
  tenantId: string;
  productId: string | null;
  balanceTransactionId: string;
  tokenUsageId: string | null;
  balanceGrantId: string | null;
  source: string;
  amountUsd: string;
  recognizedRevenueUsd: string;
  bonusConsumedUsd: string;
  discountRate: string;
  settledUsd: string;
  settledAt: string | null;
  ledgerSequence: string | null;
  createdAt: string;
};

export type EnterpriseAbsorbSettlementEvidence = {
  id: string;
  billingAccountId: string;
  allocationId: string;
  repaymentTransactionId: string | null;
  balanceGrantId: string | null;
  repairRunId: string | null;
  operationKey: string | null;
  debtSource: string;
  trigger: string;
  amountUsd: string;
  paidUsd: string;
  bonusUsd: string;
  occurredAt: string;
  createdAt: string;
};

export type EnterpriseAbsorbInvoiceEvidence = {
  itemId: string;
  orderId: string;
  applicationId: string;
  applicationStatus: string;
  applicationUserId: string;
  applicationTenantId: string;
  principalCents: number;
  invoiceNumber: string | null;
  issueDate: string | null;
  dueDate: string | null;
  issuedAt: string | null;
  pdfUrl: string | null;
  ofdUrl: string | null;
  hasIssuedLifecycleEvent: boolean;
};

export type EnterpriseAbsorbOrderEvidence = {
  id: string;
  billingAccountId: string | null;
  userId: string;
  tenantId: string;
  productId: string | null;
  orderType: string;
  status: string;
  currency: string;
  amountCents: number;
  bonusCents: number;
  paidAt: string | null;
  completedAt: string | null;
  refundedAt: string | null;
  refundAmountCents: number | null;
  createdAt: string;
};

export type EnterpriseAbsorbIdempotencyEvidence = {
  key: string;
  scope: string;
  userId: string | null;
  status: string;
  result: unknown;
  createdAt: string;
  expiresAt: string;
  snapshotSha256: string;
};

export type EnterpriseAbsorbPairEvidenceSnapshot = {
  financialNow: string;
  sourceAccount: EnterpriseAbsorbAccountEvidence;
  targetAccount: EnterpriseAbsorbAccountEvidence;
  transferTenant: {
    id: string;
    ownerUserId: string;
    billingAccountId: string | null;
    status: string;
  } | null;
  transactions: EnterpriseAbsorbTransactionEvidence[];
  grants: EnterpriseAbsorbGrantEvidence[];
  allocations: EnterpriseAbsorbAllocationEvidence[];
  settlements: EnterpriseAbsorbSettlementEvidence[];
  orders: EnterpriseAbsorbOrderEvidence[];
  invoiceEvidence: EnterpriseAbsorbInvoiceEvidence[];
  idempotencyEvidence: EnterpriseAbsorbIdempotencyEvidence[];
  expiryGrantIds: string[];
  refundGrantIds: string[];
  transactionRowsSha256: string;
  grantRowsSha256: string;
  allocationRowsSha256: string;
  settlementRowsSha256: string;
  orderRowsSha256: string;
  invoiceRowsSha256: string;
};

export type PairTransactionSequenceMutation = {
  transactionId: string;
  expectedLedgerSequence: null;
  ledgerSequence: string;
};

export type PairGrantComponentMutation = {
  grantId: string;
  expectedRemainingAmountUsd: string;
  expectedRemainingPaidAmountUsd: string | null;
  expectedRemainingBonusAmountUsd: string | null;
  remainingAmountUsd: string;
  remainingPaidAmountUsd: string;
  remainingBonusAmountUsd: string;
};

export type PairAllocationMutation = {
  allocationId: string;
  expectedLedgerSequence: string | null;
  ledgerSequence: string;
  expectedRecognizedRevenueUsd: string;
  recognizedRevenueUsd: string;
  expectedBonusConsumedUsd: string;
  bonusConsumedUsd: string;
  expectedSettledUsd: string;
  settledUsd: string;
  expectedSettledAt: string | null;
  settledAt: string | null;
};

export type EnterpriseAbsorbTransferGrantPlan = {
  grantId: string;
  sourceFundingTransactionId: string;
  transferredAmountUsd: string;
  transferredPaidUsd: string;
  transferredBonusUsd: string;
  sourceConsumedAmountUsd: string;
  sourceConsumedPaidUsd: string;
  sourceConsumedBonusUsd: string;
  targetConsumedAmountUsd: string;
  targetConsumedPaidUsd: string;
  targetConsumedBonusUsd: string;
  sourceAllocationCount: number;
  targetAllocationCount: number;
  sourceAllocationsSha256: string;
  targetAllocationsSha256: string;
  invoiceEvidenceSha256: string;
};

export type EnterpriseAbsorbAdminGrantPlan = {
  transactionId: string;
  grantId: string;
  idempotencyKey: string;
  idempotencyScope: 'admin:adjust-balance';
  idempotencySnapshotSha256: string;
  userId: string;
  tenantId: string;
  billingAccountId: string;
  productId: string | null;
  amountUsd: string;
  validFrom: string;
  expiresAt: string;
  createdAt: string;
};

export type EnterpriseAbsorbAccountPlan = {
  billingAccountId: string;
  accountType: 'personal' | 'enterprise';
  preconditionHash: string;
  replayHash: string;
  walletBalanceUsd: string;
  throughTransactionId: string;
  expectedSettlementCount: number;
  transactionSequenceMutations: PairTransactionSequenceMutation[];
  grantMutations: PairGrantComponentMutation[];
  allocationMutations: PairAllocationMutation[];
};

export type ReadyEnterpriseAbsorbPairPlan = {
  status: 'READY_PAIR';
  repairKind: typeof REPAIR_KIND;
  sourceBillingAccountId: string;
  targetBillingAccountId: string;
  preconditionHash: string;
  transferProofHash: string;
  pairReplayHash: string;
  transfer: {
    outTransactionId: string;
    inTransactionId: string;
    originalXmin: string;
    amountUsd: string;
  };
  transferGrants: EnterpriseAbsorbTransferGrantPlan[];
  adminGrantCreations: EnterpriseAbsorbAdminGrantPlan[];
  source: EnterpriseAbsorbAccountPlan;
  target: EnterpriseAbsorbAccountPlan;
};

export type QuarantinedEnterpriseAbsorbPairPlan = {
  status: 'QUARANTINED_PAIR';
  repairKind: typeof REPAIR_KIND;
  sourceBillingAccountId: string;
  targetBillingAccountId: string;
  preconditionHash: string;
  reasons: string[];
};

export type EnterpriseAbsorbPairPlan =
  | ReadyEnterpriseAbsorbPairPlan
  | QuarantinedEnterpriseAbsorbPairPlan;

type OrderedTransaction = EnterpriseAbsorbTransactionEvidence & {
  beforeUsd: Prisma.Decimal;
  amount: Prisma.Decimal;
  afterUsd: Prisma.Decimal;
};

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

export function enterpriseAbsorbSha256(value: unknown): string {
  return createHash('sha256')
    .update(typeof value === 'string' ? value : JSON.stringify(stableValue(value)))
    .digest('hex');
}

function addUtcDays(value: string, days: number): string {
  const date = new Date(value);
  if (!Number.isFinite(date.getTime())) throw new Error(`INVALID_INSTANT:${value}`);
  date.setUTCDate(date.getUTCDate() + days);
  return date.toISOString();
}

function validIsoInstant(value: string | null): number | null {
  if (value === null) return null;
  const timestamp = new Date(value).getTime();
  return Number.isFinite(timestamp) ? timestamp : null;
}

function orderLegacyTransactions(
  transactions: EnterpriseAbsorbTransactionEvidence[],
): { ordered: OrderedTransaction[]; reasons: string[] } {
  const reasons: string[] = [];
  const candidatesByBefore = new Map<string, EnterpriseAbsorbTransactionEvidence[]>();
  for (const transaction of transactions) {
    const amount = decimal(transaction.amountUsd);
    const after = decimal(transaction.balanceAfterUsd);
    const key = money(after.minus(amount));
    const candidates = candidatesByBefore.get(key) ?? [];
    candidates.push(transaction);
    candidatesByBefore.set(key, candidates);
  }
  for (const candidates of candidatesByBefore.values()) {
    candidates.sort((left, right) => left.id.localeCompare(right.id));
  }

  if ([...candidatesByBefore.values()].every((candidates) => candidates.length === 1)) {
    const used = new Set<string>();
    const ordered: OrderedTransaction[] = [];
    let running = ZERO;
    while (ordered.length < transactions.length) {
      const transaction = candidatesByBefore.get(money(running))?.[0];
      if (!transaction || used.has(transaction.id)) {
        return {
          ordered: [],
          reasons: [`TRANSACTION_CHAIN_BROKEN:${transactions.map((row) => row.id).sort().join(',')}`],
        };
      }
      const amount = decimal(transaction.amountUsd);
      const afterUsd = decimal(transaction.balanceAfterUsd);
      used.add(transaction.id);
      ordered.push({ ...transaction, beforeUsd: running, amount, afterUsd });
      running = afterUsd;
    }
    return { ordered, reasons };
  }

  if (transactions.length > 5_000) {
    return { ordered: [], reasons: [`TRANSACTION_CHAIN_SEARCH_LIMIT:${transactions.length}`] };
  }
  const used = new Set<string>();
  const path: OrderedTransaction[] = [];
  const completePaths: OrderedTransaction[][] = [];
  let exploredStates = 0;
  const search = (running: Prisma.Decimal): void => {
    if (completePaths.length > 1 || exploredStates > 100_000) return;
    exploredStates += 1;
    if (path.length === transactions.length) {
      completePaths.push([...path]);
      return;
    }
    const candidates = (candidatesByBefore.get(money(running)) ?? [])
      .filter((transaction) => !used.has(transaction.id));
    for (const transaction of candidates) {
      used.add(transaction.id);
      const amount = decimal(transaction.amountUsd);
      const afterUsd = decimal(transaction.balanceAfterUsd);
      path.push({ ...transaction, beforeUsd: running, amount, afterUsd });
      search(afterUsd);
      path.pop();
      used.delete(transaction.id);
      if (completePaths.length > 1 || exploredStates > 100_000) return;
    }
  };
  search(ZERO);
  if (exploredStates > 100_000) {
    return { ordered: [], reasons: [`TRANSACTION_CHAIN_SEARCH_LIMIT:states=${exploredStates}`] };
  }
  if (completePaths.length !== 1) {
    return {
      ordered: [],
      reasons: [completePaths.length === 0
        ? `TRANSACTION_CHAIN_BROKEN:${transactions.map((row) => row.id).sort().join(',')}`
        : 'TRANSACTION_CHAIN_AMBIGUOUS'],
    };
  }
  return { ordered: completePaths[0], reasons };
}

function orderTransactions(
  transactions: EnterpriseAbsorbTransactionEvidence[],
  walletBalanceUsd: string,
): { ordered: OrderedTransaction[]; reasons: string[] } {
  const reasons: string[] = [];
  const sequenceById = new Map<string, bigint | null>();
  const sequenceOwners = new Map<bigint, string>();
  for (const transaction of transactions) {
    const raw = transaction.ledgerSequence;
    if (raw === null) {
      sequenceById.set(transaction.id, null);
      continue;
    }
    if (!/^-?[1-9]\d*$/.test(raw)) {
      reasons.push(`TRANSACTION_LEDGER_SEQUENCE_INVALID:${transaction.id}:${raw}`);
      continue;
    }
    const sequence = BigInt(raw);
    const duplicate = sequenceOwners.get(sequence);
    if (duplicate) reasons.push(`TRANSACTION_LEDGER_SEQUENCE_DUPLICATE:${duplicate}:${transaction.id}`);
    else sequenceOwners.set(sequence, transaction.id);
    sequenceById.set(transaction.id, sequence);
  }
  if (reasons.length > 0) return { ordered: [], reasons };

  const positive = transactions
    .filter((transaction) => (sequenceById.get(transaction.id) ?? BigInt(-1)) > BigInt(0))
    .sort((left, right) => {
      const leftSequence = sequenceById.get(left.id)!;
      const rightSequence = sequenceById.get(right.id)!;
      return leftSequence < rightSequence ? -1 : leftSequence > rightSequence ? 1 : 0;
    })
    .map((transaction): OrderedTransaction => {
      const amount = decimal(transaction.amountUsd);
      const afterUsd = decimal(transaction.balanceAfterUsd);
      return { ...transaction, beforeUsd: afterUsd.minus(amount), amount, afterUsd };
    });
  for (let index = 1; index < positive.length; index += 1) {
    if (!positive[index].beforeUsd.eq(positive[index - 1].afterUsd)) {
      reasons.push(`TRANSACTION_POSITIVE_SEQUENCE_CHAIN_BROKEN:${positive[index].id}`);
    }
  }
  if (positive.length > 0 && !positive.at(-1)!.afterUsd.eq(walletBalanceUsd)) {
    reasons.push('TRANSACTION_POSITIVE_SEQUENCE_WALLET_MISMATCH');
  }

  const legacy = transactions.filter((transaction) => {
    const sequence = sequenceById.get(transaction.id);
    return sequence === null || sequence === undefined || sequence < BigInt(0);
  });
  let orderedLegacy: OrderedTransaction[] = [];
  if (legacy.every((transaction) => sequenceById.get(transaction.id) !== null)) {
    let running = ZERO;
    orderedLegacy = [...legacy]
      .sort((left, right) => {
        const leftSequence = sequenceById.get(left.id)!;
        const rightSequence = sequenceById.get(right.id)!;
        return leftSequence < rightSequence ? -1 : leftSequence > rightSequence ? 1 : 0;
      })
      .map((transaction) => {
        const amount = decimal(transaction.amountUsd);
        const afterUsd = decimal(transaction.balanceAfterUsd);
        if (!afterUsd.minus(amount).eq(running)) {
          reasons.push(`TRANSACTION_NEGATIVE_SEQUENCE_CHAIN_BROKEN:${transaction.id}`);
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
  const boundary = positive.length > 0 ? positive[0].beforeUsd : decimal(walletBalanceUsd);
  const tail = orderedLegacy.at(-1)?.afterUsd ?? ZERO;
  if (orderedLegacy.length === legacy.length && !tail.eq(boundary)) {
    reasons.push(`TRANSACTION_SEQUENCE_EPOCH_BOUNDARY_MISMATCH:${money(tail)}:${money(boundary)}`);
  }
  return reasons.length > 0 ? { ordered: [], reasons } : { ordered: [...orderedLegacy, ...positive], reasons };
}

function planTransactionSequences(
  ordered: OrderedTransaction[],
): { mutations: PairTransactionSequenceMutation[]; reasons: string[] } {
  const mutations: PairTransactionSequenceMutation[] = [];
  const reasons: string[] = [];
  const legacy = ordered.filter((transaction) => (
    transaction.ledgerSequence === null || BigInt(transaction.ledgerSequence) < BigInt(0)
  ));
  for (const [index, transaction] of legacy.entries()) {
    const expected = BigInt(index - legacy.length).toString();
    if (transaction.ledgerSequence === null) {
      mutations.push({
        transactionId: transaction.id,
        expectedLedgerSequence: null,
        ledgerSequence: expected,
      });
    } else if (transaction.ledgerSequence !== expected) {
      reasons.push(`TRANSACTION_LEGACY_SEQUENCE_MISMATCH:${transaction.id}`);
    }
  }
  return { mutations, reasons };
}

function allocationSequenceTargets(
  allocations: EnterpriseAbsorbAllocationEvidence[],
  orderedTransactions: OrderedTransaction[],
): { targets: Map<string, string>; reasons: string[] } {
  const reasons: string[] = [];
  const transactionOrder = new Map(
    orderedTransactions.map((transaction, index) => [transaction.id, index]),
  );
  const canonical = [...allocations].sort((left, right) => {
    const transactionDifference = (transactionOrder.get(left.balanceTransactionId) ?? Number.MAX_SAFE_INTEGER)
      - (transactionOrder.get(right.balanceTransactionId) ?? Number.MAX_SAFE_INTEGER);
    if (transactionDifference !== 0) return transactionDifference;
    const leftSequence = left.ledgerSequence === null ? null : BigInt(left.ledgerSequence);
    const rightSequence = right.ledgerSequence === null ? null : BigInt(right.ledgerSequence);
    if (leftSequence !== null && rightSequence !== null && leftSequence !== rightSequence) {
      return leftSequence < rightSequence ? -1 : 1;
    }
    if (leftSequence === null && rightSequence !== null) return -1;
    if (leftSequence !== null && rightSequence === null) return 1;
    return left.id.localeCompare(right.id);
  });
  if (canonical.some((allocation) => !transactionOrder.has(allocation.balanceTransactionId))) {
    reasons.push('ALLOCATION_TRANSACTION_OUTSIDE_ACCOUNT');
  }
  const legacy = canonical.filter((allocation) => (
    allocation.ledgerSequence === null || BigInt(allocation.ledgerSequence) < BigInt(0)
  ));
  const targets = new Map<string, string>();
  const seen = new Map<string, string>();
  for (const allocation of canonical) {
    if (allocation.ledgerSequence === null) continue;
    if (!/^-?[1-9]\d*$/.test(allocation.ledgerSequence)) {
      reasons.push(`ALLOCATION_LEDGER_SEQUENCE_INVALID:${allocation.id}`);
      continue;
    }
    const duplicate = seen.get(allocation.ledgerSequence);
    if (duplicate) reasons.push(`ALLOCATION_LEDGER_SEQUENCE_DUPLICATE:${duplicate}:${allocation.id}`);
    else seen.set(allocation.ledgerSequence, allocation.id);
  }
  for (const [index, allocation] of legacy.entries()) {
    const target = BigInt(index - legacy.length).toString();
    targets.set(allocation.id, target);
    if (allocation.ledgerSequence !== null && allocation.ledgerSequence !== target) {
      reasons.push(`ALLOCATION_LEGACY_SEQUENCE_MISMATCH:${allocation.id}`);
    }
  }
  return { targets, reasons };
}

function invoiceEvidenceIsTerminalAndUnissued(evidence: EnterpriseAbsorbInvoiceEvidence): boolean {
  return evidence.applicationStatus === 'FAILED'
    && evidence.invoiceNumber === null
    && evidence.issueDate === null
    && evidence.dueDate === null
    && evidence.issuedAt === null
    && evidence.pdfUrl === null
    && evidence.ofdUrl === null
    && evidence.hasIssuedLifecycleEvent === false;
}

function canonicalEvidenceSubsetHash<T extends { id?: string; itemId?: string }>(rows: T[]): string {
  return enterpriseAbsorbSha256([...rows].sort((left, right) => (
    (left.id ?? left.itemId ?? '').localeCompare(right.id ?? right.itemId ?? '')
  )));
}

function committedIdempotencyResponse(result: unknown): Record<string, unknown> | null {
  if (!result || typeof result !== 'object' || Array.isArray(result)) return null;
  const record = result as Record<string, unknown>;
  if (record.response && typeof record.response === 'object' && !Array.isArray(record.response)) {
    if (record.status !== undefined && record.status !== 'COMMITTED') return null;
    return record.response as Record<string, unknown>;
  }
  return record;
}

function idempotencyMatchesTransaction(
  evidence: EnterpriseAbsorbIdempotencyEvidence,
  transaction: EnterpriseAbsorbTransactionEvidence,
  targetAccountId: string,
): boolean {
  if (
    evidence.scope !== 'admin:adjust-balance'
    || evidence.status !== 'COMMITTED'
    || evidence.userId !== transaction.userId
    || !evidence.key.startsWith(`enterprise-recharge:${targetAccountId}:`)
  ) return false;
  const response = committedIdempotencyResponse(evidence.result);
  if (!response) return false;
  const evidenceCreatedAt = validIsoInstant(evidence.createdAt);
  const evidenceExpiresAt = validIsoInstant(evidence.expiresAt);
  const transactionCreatedAt = validIsoInstant(transaction.createdAt);
  if (
    evidenceCreatedAt === null
    || evidenceExpiresAt === null
    || transactionCreatedAt === null
    || evidenceCreatedAt > transactionCreatedAt
    || transactionCreatedAt >= evidenceExpiresAt
  ) return false;
  const cents = decimal(transaction.amountUsd).times(100);
  const responseCreatedAtMillis = typeof response.createdAt === 'string'
    ? validIsoInstant(response.createdAt)
    : null;
  const responseCreatedAt = responseCreatedAtMillis === null
    ? null
    : new Date(responseCreatedAtMillis).toISOString();
  const responseAmount = response.amountUsd ?? (
    typeof response.amountCents === 'number' ? new Prisma.Decimal(response.amountCents).div(100) : null
  );
  const responseBalance = response.balanceAfterUsd ?? (
    typeof response.balanceAfterCents === 'number'
      ? new Prisma.Decimal(response.balanceAfterCents).div(100)
      : null
  );
  return response.id === transaction.id
    && response.userId === transaction.userId
    && response.tenantId === transaction.tenantId
    && (response.productId ?? null) === transaction.productId
    && response.type === 'ADJUST'
    && response.description === transaction.description
    && responseCreatedAt === transaction.createdAt
    && responseAmount !== null
    && decimal(responseAmount as Prisma.Decimal.Value).eq(transaction.amountUsd)
    && responseBalance !== null
    && decimal(responseBalance as Prisma.Decimal.Value).eq(transaction.balanceAfterUsd)
    && (response.amountCents === undefined || (
      typeof response.amountCents === 'number' && cents.eq(response.amountCents)
    ));
}

function accountOpenDebt(
  accountId: string,
  allocations: EnterpriseAbsorbAllocationEvidence[],
): Prisma.Decimal {
  return allocations
    .filter((allocation) => (
      allocation.billingAccountId === accountId
      && (allocation.source === 'NEGATIVE_BALANCE' || allocation.source === 'ENTERPRISE_CREDIT')
    ))
    .reduce((sum, allocation) => (
      sum.plus(decimal(allocation.amountUsd).minus(allocation.settledUsd))
    ), ZERO);
}

function activeGrantTotal(
  accountId: string,
  grants: EnterpriseAbsorbGrantEvidence[],
  financialNow: string,
): Prisma.Decimal {
  const now = new Date(financialNow).getTime();
  return grants
    .filter((grant) => (
      grant.billingAccountId === accountId
      && !grant.isExpired
      && new Date(grant.validFrom).getTime() <= now
      && (grant.expiresAt === null || new Date(grant.expiresAt).getTime() > now)
    ))
    .reduce((sum, grant) => sum.plus(grant.remainingAmountUsd), ZERO);
}

function buildGrantComponentMutations(
  accountId: string,
  grants: EnterpriseAbsorbGrantEvidence[],
  allocations: EnterpriseAbsorbAllocationEvidence[],
  settlements: EnterpriseAbsorbSettlementEvidence[],
  expiryGrantIds: ReadonlySet<string>,
  refundGrantIds: ReadonlySet<string>,
): {
  mutations: PairGrantComponentMutation[];
  remainingByGrantId: Map<string, { paid: Prisma.Decimal; bonus: Prisma.Decimal }>;
  reasons: string[];
} {
  const mutations: PairGrantComponentMutation[] = [];
  const remainingByGrantId = new Map<string, { paid: Prisma.Decimal; bonus: Prisma.Decimal }>();
  const reasons: string[] = [];
  for (const grant of grants.filter((row) => row.billingAccountId === accountId)) {
    const grantAllocations = allocations.filter((row) => row.balanceGrantId === grant.id);
    const grantSettlements = settlements.filter((row) => (
      row.billingAccountId === accountId && row.balanceGrantId === grant.id
    ));
    const consumedPaid = grantAllocations.reduce(
      (sum, row) => sum.plus(row.recognizedRevenueUsd),
      ZERO,
    ).plus(grantSettlements.reduce((sum, row) => sum.plus(row.paidUsd), ZERO));
    const consumedBonus = grantAllocations.reduce(
      (sum, row) => sum.plus(row.bonusConsumedUsd),
      ZERO,
    ).plus(grantSettlements.reduce((sum, row) => sum.plus(row.bonusUsd), ZERO));
    const paid = decimal(grant.paidAmountUsd).minus(consumedPaid);
    const bonus = decimal(grant.bonusAmountUsd).minus(consumedBonus);
    remainingByGrantId.set(grant.id, { paid, bonus });
    const componentsAreBothNull = grant.remainingPaidAmountUsd === null
      && grant.remainingBonusAmountUsd === null;
    const componentsAreBothPresent = grant.remainingPaidAmountUsd !== null
      && grant.remainingBonusAmountUsd !== null;
    if (
      expiryGrantIds.has(grant.id)
      || refundGrantIds.has(grant.id)
      || grantAllocations.some((row) => (
        row.source !== 'BALANCE_GRANT'
        || decimal(row.recognizedRevenueUsd).lt(0)
        || decimal(row.bonusConsumedUsd).lt(0)
        || !decimal(row.recognizedRevenueUsd).plus(row.bonusConsumedUsd).eq(row.amountUsd)
      ))
      || grantSettlements.some((row) => (
        decimal(row.paidUsd).lt(0)
        || decimal(row.bonusUsd).lt(0)
        || !decimal(row.paidUsd).plus(row.bonusUsd).eq(row.amountUsd)
      ))
      || paid.lt(0)
      || bonus.lt(0)
      || !paid.plus(bonus).eq(grant.remainingAmountUsd)
      || (!componentsAreBothNull && !componentsAreBothPresent)
      || (componentsAreBothPresent && (
        !paid.eq(grant.remainingPaidAmountUsd!)
        || !bonus.eq(grant.remainingBonusAmountUsd!)
      ))
    ) {
      reasons.push(`GRANT_COMPONENT_REPLAY_MISMATCH:${grant.id}`);
      continue;
    }
    if (componentsAreBothNull) {
      mutations.push({
        grantId: grant.id,
        expectedRemainingAmountUsd: money(grant.remainingAmountUsd),
        expectedRemainingPaidAmountUsd: null,
        expectedRemainingBonusAmountUsd: null,
        remainingAmountUsd: money(grant.remainingAmountUsd),
        remainingPaidAmountUsd: money(paid),
        remainingBonusAmountUsd: money(bonus),
      });
    }
  }
  mutations.sort((left, right) => left.grantId.localeCompare(right.grantId));
  return { mutations, remainingByGrantId, reasons };
}

function buildAllocationMutations(
  accountId: string,
  expectedDebtSource: 'NEGATIVE_BALANCE' | 'ENTERPRISE_CREDIT',
  allocations: EnterpriseAbsorbAllocationEvidence[],
  settlements: EnterpriseAbsorbSettlementEvidence[],
  orderedTransactions: OrderedTransaction[],
): { mutations: PairAllocationMutation[]; reasons: string[] } {
  const accountAllocations = allocations.filter((allocation) => allocation.billingAccountId === accountId);
  const sequencePlan = allocationSequenceTargets(accountAllocations, orderedTransactions);
  const reasons = [...sequencePlan.reasons];
  const mutations: PairAllocationMutation[] = [];
  for (const transaction of orderedTransactions.filter((row) => row.type === 'CONSUME')) {
    const consumption = transaction.amount.neg();
    const availableBefore = Prisma.Decimal.max(transaction.beforeUsd, ZERO);
    const expectedGrantAmount = Prisma.Decimal.min(consumption, availableBefore);
    const transactionAllocations = accountAllocations.filter(
      (allocation) => allocation.balanceTransactionId === transaction.id,
    );
    const allocatedTotal = transactionAllocations.reduce(
      (sum, allocation) => sum.plus(allocation.amountUsd), ZERO,
    );
    const allocatedGrant = transactionAllocations
      .filter((allocation) => allocation.source === 'BALANCE_GRANT')
      .reduce((sum, allocation) => sum.plus(allocation.amountUsd), ZERO);
    const allocatedDebt = transactionAllocations
      .filter((allocation) => allocation.source === expectedDebtSource)
      .reduce((sum, allocation) => sum.plus(allocation.amountUsd), ZERO);
    if (
      !allocatedTotal.eq(consumption)
      || !allocatedGrant.eq(expectedGrantAmount)
      || !allocatedDebt.eq(consumption.minus(expectedGrantAmount))
    ) reasons.push(`CONSUME_ALLOCATION_SPLIT_INVALID:${transaction.id}`);
  }
  for (const allocation of accountAllocations) {
    let recognizedRevenueUsd = money(allocation.recognizedRevenueUsd);
    let bonusConsumedUsd = money(allocation.bonusConsumedUsd);
    if (allocation.source === 'ENTERPRISE_CREDIT') {
      const allocationSettlements = settlements.filter((row) => row.allocationId === allocation.id);
      const settled = allocationSettlements.reduce((sum, row) => sum.plus(row.amountUsd), ZERO);
      const paid = allocationSettlements.reduce((sum, row) => sum.plus(row.paidUsd), ZERO);
      const bonus = allocationSettlements.reduce((sum, row) => sum.plus(row.bonusUsd), ZERO);
      if (!settled.eq(allocation.settledUsd) || !paid.plus(bonus).eq(settled)) {
        reasons.push(`ENTERPRISE_SETTLEMENT_CONSERVATION_INVALID:${allocation.id}`);
      } else {
        recognizedRevenueUsd = money(paid);
        bonusConsumedUsd = money(bonus);
      }
    }
    const targetSequence = sequencePlan.targets.get(allocation.id) ?? allocation.ledgerSequence;
    if (targetSequence === null) {
      reasons.push(`ALLOCATION_SEQUENCE_TARGET_MISSING:${allocation.id}`);
      continue;
    }
    if (
      allocation.ledgerSequence === null
      || money(allocation.recognizedRevenueUsd) !== recognizedRevenueUsd
      || money(allocation.bonusConsumedUsd) !== bonusConsumedUsd
    ) {
      mutations.push({
        allocationId: allocation.id,
        expectedLedgerSequence: allocation.ledgerSequence,
        ledgerSequence: targetSequence,
        expectedRecognizedRevenueUsd: money(allocation.recognizedRevenueUsd),
        recognizedRevenueUsd,
        expectedBonusConsumedUsd: money(allocation.bonusConsumedUsd),
        bonusConsumedUsd,
        expectedSettledUsd: money(allocation.settledUsd),
        settledUsd: money(allocation.settledUsd),
        expectedSettledAt: allocation.settledAt,
        settledAt: allocation.settledAt,
      });
    }
  }
  return { mutations, reasons };
}

function accountReplayHashInput(
  plan: Omit<EnterpriseAbsorbAccountPlan, 'replayHash'>,
  transferProofHash: string,
  adminGrantCreations: EnterpriseAbsorbAdminGrantPlan[],
): unknown {
  return { ...plan, transferProofHash, adminGrantCreations };
}

export function enterpriseAbsorbAccountReplayHash(
  plan: Omit<EnterpriseAbsorbAccountPlan, 'replayHash'>,
  transferProofHash: string,
  adminGrantCreations: EnterpriseAbsorbAdminGrantPlan[],
): string {
  return enterpriseAbsorbSha256(accountReplayHashInput(plan, transferProofHash, adminGrantCreations));
}

export function enterpriseAbsorbPairReplayHash(
  plan: Omit<ReadyEnterpriseAbsorbPairPlan, 'pairReplayHash'>,
): string {
  return enterpriseAbsorbSha256(plan);
}

function quarantine(
  snapshot: EnterpriseAbsorbPairEvidenceSnapshot,
  preconditionHash: string,
  reasons: string[],
): QuarantinedEnterpriseAbsorbPairPlan {
  return {
    status: 'QUARANTINED_PAIR',
    repairKind: REPAIR_KIND,
    sourceBillingAccountId: snapshot.sourceAccount.id,
    targetBillingAccountId: snapshot.targetAccount.id,
    preconditionHash,
    reasons: [...new Set(reasons)].sort(),
  };
}

export function buildEnterpriseAbsorbPairPlan(
  snapshot: EnterpriseAbsorbPairEvidenceSnapshot,
): EnterpriseAbsorbPairPlan {
  // `financialNow` is sampled only to evaluate time-window predicates. It is
  // deliberately excluded from the evidence hash: an unchanged database must
  // rebuild the same signed plan a millisecond later. Crossing an expiry
  // boundary still changes the derived plan (or quarantines it), so apply's
  // lock-time rebuild remains fail-closed.
  const { financialNow: _financialNow, ...hashableSnapshot } = snapshot;
  const preconditionHash = enterpriseAbsorbSha256(hashableSnapshot);
  const reasons: string[] = [];
  const sourceId = snapshot.sourceAccount.id;
  const targetId = snapshot.targetAccount.id;
  if (
    snapshot.sourceAccount.type !== 'personal'
    || snapshot.targetAccount.type !== 'enterprise'
    || !snapshot.sourceAccount.ownerUserId
    || snapshot.sourceAccount.ownerUserId !== snapshot.targetAccount.ownerUserId
  ) reasons.push('PAIR_ACCOUNT_SUBJECT_MISMATCH');
  for (const account of [snapshot.sourceAccount, snapshot.targetAccount]) {
    if (
      account.status !== 'active'
      || !/^[a-z]{3}$/.test(account.currency.trim().toLowerCase())
      || account.ledgerStatus !== 'LEGACY_DIRTY'
    ) reasons.push(`PAIR_ACCOUNT_NOT_REPAIRABLE:${account.id}`);
  }

  const outCandidates = snapshot.transactions.filter((transaction) => (
    transaction.billingAccountId === sourceId
    && transaction.description === `enterprise-absorb:out to=${targetId}`
  ));
  const inCandidates = snapshot.transactions.filter((transaction) => (
    transaction.billingAccountId === targetId
    && transaction.description === `enterprise-absorb:in from=${sourceId}`
  ));
  if (outCandidates.length !== 1 || inCandidates.length !== 1) {
    reasons.push(`TRANSFER_PAIR_CARDINALITY:${outCandidates.length}:${inCandidates.length}`);
  }
  const outTransaction = outCandidates[0];
  const inTransaction = inCandidates[0];
  if (!outTransaction || !inTransaction) return quarantine(snapshot, preconditionHash, reasons);
  const transferAmount = decimal(inTransaction.amountUsd);
  const outCreatedAt = validIsoInstant(outTransaction.createdAt);
  const inCreatedAt = validIsoInstant(inTransaction.createdAt);
  if (
    outTransaction.type !== 'ADJUST'
    || inTransaction.type !== 'ADJUST'
    || transferAmount.lte(0)
    || !decimal(outTransaction.amountUsd).neg().eq(transferAmount)
    || !decimal(outTransaction.balanceAfterUsd).eq(0)
    || !decimal(inTransaction.balanceAfterUsd).minus(inTransaction.amountUsd).eq(0)
    || outTransaction.xmin !== inTransaction.xmin
    || !/^[1-9]\d*$/.test(outTransaction.xmin)
    || outTransaction.userId !== inTransaction.userId
    || outTransaction.tenantId !== inTransaction.tenantId
    || outTransaction.productId !== null
    || inTransaction.productId !== null
    || outTransaction.tokenUsageId !== null
    || inTransaction.tokenUsageId !== null
    || outTransaction.orderId !== null
    || inTransaction.orderId !== null
    || outTransaction.operationKey !== null
    || inTransaction.operationKey !== null
    || outCreatedAt === null
    || inCreatedAt === null
    || outCreatedAt > inCreatedAt
  ) reasons.push('TRANSFER_PAIR_IMMUTABLE_FACT_MISMATCH');
  if (
    !snapshot.transferTenant
    || snapshot.transferTenant.id !== outTransaction.tenantId
    || snapshot.transferTenant.ownerUserId !== snapshot.sourceAccount.ownerUserId
    || snapshot.transferTenant.billingAccountId !== targetId
    || snapshot.transferTenant.status !== 'active'
  ) reasons.push('TRANSFER_TENANT_ANCHOR_MISMATCH');

  const transactionById = new Map(snapshot.transactions.map((transaction) => [transaction.id, transaction]));
  const allocationsByGrant = new Map<string, EnterpriseAbsorbAllocationEvidence[]>();
  for (const allocation of snapshot.allocations) {
    const allocationTransaction = transactionById.get(allocation.balanceTransactionId);
    if (
      allocationTransaction
      && (allocationTransaction.billingAccountId === sourceId
        || allocationTransaction.billingAccountId === targetId)
      && allocation.billingAccountId !== allocationTransaction.billingAccountId
    ) {
      reasons.push(
        `CROSS_ACCOUNT_ALLOCATION_TRANSACTION_MISMATCH:${allocation.id}:${allocationTransaction.id}`,
      );
    }
    if (!allocation.balanceGrantId) continue;
    const rows = allocationsByGrant.get(allocation.balanceGrantId) ?? [];
    rows.push(allocation);
    allocationsByGrant.set(allocation.balanceGrantId, rows);
  }
  const grantById = new Map(snapshot.grants.map((grant) => [grant.id, grant]));
  const allocationById = new Map(snapshot.allocations.map((allocation) => [allocation.id, allocation]));
  for (const settlement of snapshot.settlements) {
    if (settlement.billingAccountId === sourceId) {
      reasons.push(`SOURCE_SETTLEMENT_UNSUPPORTED:${settlement.id}`);
    } else if (settlement.billingAccountId === targetId) {
      reasons.push(`TARGET_SETTLEMENT_UNSUPPORTED:${settlement.id}`);
    }
    const repaymentTransaction = settlement.repaymentTransactionId === null
      ? undefined
      : transactionById.get(settlement.repaymentTransactionId);
    if (
      repaymentTransaction
      && (repaymentTransaction.billingAccountId === sourceId
        || repaymentTransaction.billingAccountId === targetId)
      && settlement.billingAccountId !== repaymentTransaction.billingAccountId
    ) {
      reasons.push(
        `CROSS_ACCOUNT_SETTLEMENT_REPAYMENT_MISMATCH:${settlement.id}:${repaymentTransaction.id}`,
      );
    }
    const settlementAllocation = allocationById.get(settlement.allocationId);
    if (
      settlementAllocation
      && (settlementAllocation.billingAccountId === sourceId
        || settlementAllocation.billingAccountId === targetId)
      && settlement.billingAccountId !== settlementAllocation.billingAccountId
    ) {
      reasons.push(
        `CROSS_ACCOUNT_SETTLEMENT_ALLOCATION_MISMATCH:${settlement.id}:${settlementAllocation.id}`,
      );
    }
    if (settlement.balanceGrantId === null) continue;
    const settlementGrant = grantById.get(settlement.balanceGrantId);
    if (
      (settlement.billingAccountId === sourceId || settlement.billingAccountId === targetId)
      && !settlementGrant
    ) {
      reasons.push(
        `SETTLEMENT_GRANT_REFERENCE_INVALID:${settlement.id}:${settlement.balanceGrantId}`,
      );
      continue;
    }
    if (
      settlementGrant
      && (settlementGrant.billingAccountId === sourceId
        || settlementGrant.billingAccountId === targetId)
      && settlement.billingAccountId !== settlementGrant.billingAccountId
    ) {
      reasons.push(
        `CROSS_ACCOUNT_SETTLEMENT_GRANT_MISMATCH:${settlement.id}:${settlementGrant.id}`,
      );
    }
  }
  const expiryGrantIds = new Set(snapshot.expiryGrantIds);
  const refundGrantIds = new Set(snapshot.refundGrantIds);
  const sourceGrantComponents = buildGrantComponentMutations(
    sourceId, snapshot.grants, snapshot.allocations, [],
    expiryGrantIds, refundGrantIds,
  );
  const targetGrantComponents = buildGrantComponentMutations(
    targetId, snapshot.grants, snapshot.allocations, [],
    expiryGrantIds, refundGrantIds,
  );
  reasons.push(...sourceGrantComponents.reasons.map((reason) => `SOURCE:${reason}`));
  reasons.push(...targetGrantComponents.reasons.map((reason) => `TARGET:${reason}`));
  if (sourceGrantComponents.mutations.length > 0) {
    reasons.push('SOURCE_GRANT_COMPONENT_MUTATION_UNSUPPORTED');
  }
  const movedGrantPlans: EnterpriseAbsorbTransferGrantPlan[] = [];
  for (const grant of snapshot.grants.filter((row) => row.billingAccountId === targetId)) {
    const orderTransactions = grant.orderId === null ? [] : snapshot.transactions.filter(
      (transaction) => transaction.orderId === grant.orderId,
    );
    const orderRecharges = orderTransactions.filter((transaction) => transaction.type === 'RECHARGE');
    const orderPositiveTransactions = orderTransactions.filter(
      (transaction) => decimal(transaction.amountUsd).gt(0),
    );
    const orderGrants = grant.orderId === null ? [] : snapshot.grants.filter(
      (candidate) => candidate.orderId === grant.orderId,
    );
    const sourceFunding = snapshot.transactions.filter((transaction) => (
      transaction.billingAccountId === sourceId
      && transaction.type === 'RECHARGE'
      && transaction.orderId !== null
      && transaction.orderId === grant.orderId
    ));
    const allocations = allocationsByGrant.get(grant.id) ?? [];
    const sourceAllocations = allocations.filter((row) => row.billingAccountId === sourceId);
    const isMovedCandidate = sourceFunding.length > 0 || sourceAllocations.length > 0;
    if (!isMovedCandidate) continue;
    if (
      orderRecharges.length !== 1
      || orderPositiveTransactions.length !== 1
      || orderGrants.length !== 1
      || orderRecharges[0]?.id !== sourceFunding[0]?.id
      || orderPositiveTransactions[0]?.id !== sourceFunding[0]?.id
      || orderGrants[0]?.id !== grant.id
    ) {
      reasons.push(
        `TRANSFER_ORDER_GLOBAL_CARDINALITY:${grant.id}:`
          + `${orderRecharges.length}:${orderPositiveTransactions.length}:${orderGrants.length}`,
      );
    }
    const targetAllocations = allocations.filter((row) => row.billingAccountId === targetId);
    const foreignAllocations = allocations.filter((row) => (
      row.billingAccountId !== sourceId && row.billingAccountId !== targetId
    ));
    if (sourceFunding.length !== 1) {
      reasons.push(`TRANSFER_GRANT_FUNDING_CARDINALITY:${grant.id}:${sourceFunding.length}`);
      continue;
    }
    const funding = sourceFunding[0];
    const sourceConsumed = sourceAllocations.reduce((sum, row) => sum.plus(row.amountUsd), ZERO);
    const sourcePaid = sourceAllocations.reduce((sum, row) => sum.plus(row.recognizedRevenueUsd), ZERO);
    const sourceBonus = sourceAllocations.reduce((sum, row) => sum.plus(row.bonusConsumedUsd), ZERO);
    const targetConsumed = targetAllocations.reduce((sum, row) => sum.plus(row.amountUsd), ZERO);
    const targetPaid = targetAllocations.reduce((sum, row) => sum.plus(row.recognizedRevenueUsd), ZERO);
    const targetBonus = targetAllocations.reduce((sum, row) => sum.plus(row.bonusConsumedUsd), ZERO);
    const transferred = decimal(grant.grantedAmountUsd).minus(sourceConsumed);
    const repairedRemaining = targetGrantComponents.remainingByGrantId.get(grant.id);
    const invoiceEvidence = snapshot.invoiceEvidence.filter((row) => row.orderId === grant.orderId);
    const orderEvidence = snapshot.orders.filter((row) => row.id === grant.orderId);
    const orderCreatedAt = validIsoInstant(orderEvidence[0]?.createdAt ?? null);
    const orderPaidAt = validIsoInstant(orderEvidence[0]?.paidAt ?? null);
    const orderCompletedAt = validIsoInstant(orderEvidence[0]?.completedAt ?? null);
    const fundingCreatedAt = validIsoInstant(funding.createdAt);
    const grantCreatedAt = validIsoInstant(grant.createdAt);
    const grantValidFrom = validIsoInstant(grant.validFrom);
    const grantExpiresAt = validIsoInstant(grant.expiresAt);
    if (
      grant.source !== 'RECHARGE'
      || grant.orderId === null
      || !decimal(grant.bonusAmountUsd).eq(0)
      || !decimal(grant.paidAmountUsd).eq(grant.grantedAmountUsd)
      || !decimal(funding.amountUsd).eq(grant.paidAmountUsd)
      || funding.userId !== grant.userId
      || funding.tenantId !== grant.tenantId
      || funding.productId !== grant.productId
      || funding.createdAt > outTransaction.createdAt
      || sourceAllocations.some((row) => (
        row.source !== 'BALANCE_GRANT'
        || row.createdAt >= outTransaction.createdAt
        || !decimal(row.recognizedRevenueUsd).plus(row.bonusConsumedUsd).eq(row.amountUsd)
      ))
      || targetAllocations.some((row) => (
        row.source !== 'BALANCE_GRANT'
        || row.createdAt <= inTransaction.createdAt
        || !decimal(row.recognizedRevenueUsd).plus(row.bonusConsumedUsd).eq(row.amountUsd)
      ))
      || foreignAllocations.length > 0
      || !sourcePaid.plus(sourceBonus).eq(sourceConsumed)
      || !targetPaid.plus(targetBonus).eq(targetConsumed)
      || !sourceConsumed.plus(transferred).eq(grant.grantedAmountUsd)
      || !decimal(grant.remainingAmountUsd).plus(targetConsumed).eq(transferred)
      || !repairedRemaining
      || !repairedRemaining.paid.plus(targetPaid).eq(transferred)
      || !repairedRemaining.bonus.plus(targetBonus).eq(0)
      || invoiceEvidence.some((row) => !invoiceEvidenceIsTerminalAndUnissued(row))
      || snapshot.expiryGrantIds.includes(grant.id)
      || snapshot.refundGrantIds.includes(grant.id)
      || orderEvidence.length !== 1
      || orderEvidence[0].billingAccountId !== sourceId
      || orderEvidence[0].userId !== funding.userId
      || orderEvidence[0].tenantId !== funding.tenantId
      || orderEvidence[0].productId !== funding.productId
      || orderEvidence[0].orderType !== 'RECHARGE'
      || orderEvidence[0].status !== 'COMPLETED'
      || orderEvidence[0].currency.trim().toLowerCase()
        !== snapshot.targetAccount.currency.trim().toLowerCase()
      || orderEvidence[0].refundedAt !== null
      || orderEvidence[0].refundAmountCents !== null
      || !Number.isSafeInteger(orderEvidence[0].amountCents)
      || !Number.isSafeInteger(orderEvidence[0].bonusCents)
      || !decimal(orderEvidence[0].amountCents).div(100).eq(grant.paidAmountUsd)
      || !decimal(orderEvidence[0].bonusCents).div(100).eq(grant.bonusAmountUsd)
      || orderCreatedAt === null
      || orderPaidAt === null
      || orderCompletedAt === null
      || fundingCreatedAt === null
      || grantCreatedAt === null
      || grantValidFrom === null
      || grantValidFrom > grantCreatedAt
      || orderCreatedAt > orderPaidAt
      || orderPaidAt > fundingCreatedAt
      || fundingCreatedAt > orderCompletedAt
      || orderPaidAt > grantCreatedAt
      || grantCreatedAt > orderCompletedAt
      || orderPaidAt > grantValidFrom
      || grantValidFrom > orderCompletedAt
      || (grant.expiresAt !== null && (
        grantExpiresAt === null || grantExpiresAt <= grantValidFrom
      ))
    ) reasons.push(`TRANSFER_GRANT_PROOF_MISMATCH:${grant.id}`);
    movedGrantPlans.push({
      grantId: grant.id,
      sourceFundingTransactionId: funding.id,
      transferredAmountUsd: money(transferred),
      transferredPaidUsd: money(transferred),
      transferredBonusUsd: money(0),
      sourceConsumedAmountUsd: money(sourceConsumed),
      sourceConsumedPaidUsd: money(sourcePaid),
      sourceConsumedBonusUsd: money(sourceBonus),
      targetConsumedAmountUsd: money(targetConsumed),
      targetConsumedPaidUsd: money(targetPaid),
      targetConsumedBonusUsd: money(targetBonus),
      sourceAllocationCount: sourceAllocations.length,
      targetAllocationCount: targetAllocations.length,
      sourceAllocationsSha256: canonicalEvidenceSubsetHash(sourceAllocations),
      targetAllocationsSha256: canonicalEvidenceSubsetHash(targetAllocations),
      invoiceEvidenceSha256: enterpriseAbsorbSha256({ orderEvidence, invoiceEvidence }),
    });
  }
  movedGrantPlans.sort((left, right) => left.grantId.localeCompare(right.grantId));
  if (
    movedGrantPlans.length === 0
    || !movedGrantPlans.reduce((sum, grant) => sum.plus(grant.transferredAmountUsd), ZERO)
      .eq(transferAmount)
  ) reasons.push('TRANSFER_GRANT_AGGREGATE_MISMATCH');
  const movedGrantIds = new Set(movedGrantPlans.map((grant) => grant.grantId));
  const uncoveredCrossAccountAllocations = snapshot.allocations.filter((allocation) => {
    if (!allocation.balanceGrantId) return false;
    const grant = snapshot.grants.find((candidate) => candidate.id === allocation.balanceGrantId);
    return grant?.billingAccountId === targetId
      && allocation.billingAccountId === sourceId
      && !movedGrantIds.has(grant.id);
  });
  if (uncoveredCrossAccountAllocations.length > 0) reasons.push('TRANSFER_ALLOCATION_COVERAGE_INCOMPLETE');

  const adminGrantCreations: EnterpriseAbsorbAdminGrantPlan[] = [];
  const usedAdminTransactions = new Set<string>();
  for (const evidence of snapshot.idempotencyEvidence) {
    const matches = snapshot.transactions.filter((transaction) => (
      transaction.billingAccountId === targetId
      && transaction.id !== inTransaction.id
      && transaction.type === 'ADJUST'
      && decimal(transaction.amountUsd).gt(0)
      && transaction.orderId === null
      && transaction.operationKey === null
      && idempotencyMatchesTransaction(evidence, transaction, targetId)
    ));
    if (matches.length !== 1 || usedAdminTransactions.has(matches[0]?.id ?? '')) {
      reasons.push(`ADMIN_GRANT_IDEMPOTENCY_MATCH_${matches.length}:${evidence.key}`);
      continue;
    }
    const transaction = matches[0];
    usedAdminTransactions.add(transaction.id);
    adminGrantCreations.push({
      transactionId: transaction.id,
      grantId: `repair-admin-recharge:${transaction.id}`,
      idempotencyKey: evidence.key,
      idempotencyScope: 'admin:adjust-balance',
      idempotencySnapshotSha256: evidence.snapshotSha256,
      userId: transaction.userId,
      tenantId: transaction.tenantId,
      billingAccountId: targetId,
      productId: transaction.productId,
      amountUsd: money(transaction.amountUsd),
      validFrom: transaction.createdAt,
      expiresAt: addUtcDays(transaction.createdAt, RECHARGE_VALIDITY_DAYS),
      createdAt: transaction.createdAt,
    });
  }
  adminGrantCreations.sort((left, right) => left.transactionId.localeCompare(right.transactionId));
  const targetExistingGrants = activeGrantTotal(targetId, snapshot.grants, snapshot.financialNow);
  const targetDebt = accountOpenDebt(targetId, snapshot.allocations);
  const targetDrift = decimal(snapshot.targetAccount.walletBalanceUsd)
    .minus(targetExistingGrants.minus(targetDebt));
  const createdGrantTotal = adminGrantCreations.reduce((sum, grant) => sum.plus(grant.amountUsd), ZERO);
  if (targetDrift.lte(0) || !targetDrift.eq(createdGrantTotal)) {
    reasons.push(`ADMIN_GRANT_WALLET_DRIFT_MISMATCH:${money(targetDrift)}:${money(createdGrantTotal)}`);
  }
  const sourceExpectedWallet = activeGrantTotal(sourceId, snapshot.grants, snapshot.financialNow)
    .minus(accountOpenDebt(sourceId, snapshot.allocations));
  if (!sourceExpectedWallet.eq(snapshot.sourceAccount.walletBalanceUsd)) {
    reasons.push('SOURCE_WALLET_CANONICAL_MISMATCH');
  }

  const sourceTransactions = snapshot.transactions.filter((row) => row.billingAccountId === sourceId);
  const targetTransactions = snapshot.transactions.filter((row) => row.billingAccountId === targetId);
  const sourceOrder = orderTransactions(sourceTransactions, snapshot.sourceAccount.walletBalanceUsd);
  const targetOrder = orderTransactions(targetTransactions, snapshot.targetAccount.walletBalanceUsd);
  reasons.push(...sourceOrder.reasons.map((reason) => `SOURCE:${reason}`));
  reasons.push(...targetOrder.reasons.map((reason) => `TARGET:${reason}`));
  const sourceSequencePlan = planTransactionSequences(sourceOrder.ordered);
  const targetSequencePlan = planTransactionSequences(targetOrder.ordered);
  reasons.push(...sourceSequencePlan.reasons.map((reason) => `SOURCE:${reason}`));
  reasons.push(...targetSequencePlan.reasons.map((reason) => `TARGET:${reason}`));
  const sourceAllocationPlan = buildAllocationMutations(
    sourceId, 'NEGATIVE_BALANCE', snapshot.allocations, [], sourceOrder.ordered,
  );
  const targetAllocationPlan = buildAllocationMutations(
    targetId, 'ENTERPRISE_CREDIT', snapshot.allocations,
    [], targetOrder.ordered,
  );
  reasons.push(...sourceAllocationPlan.reasons.map((reason) => `SOURCE:${reason}`));
  reasons.push(...targetAllocationPlan.reasons.map((reason) => `TARGET:${reason}`));
  if (reasons.length > 0) return quarantine(snapshot, preconditionHash, reasons);

  const transfer = {
    outTransactionId: outTransaction.id,
    inTransactionId: inTransaction.id,
    originalXmin: outTransaction.xmin,
    amountUsd: money(transferAmount),
  };
  const transferProofHash = enterpriseAbsorbSha256({ transfer, transferGrants: movedGrantPlans });
  const sourceBase: Omit<EnterpriseAbsorbAccountPlan, 'replayHash'> = {
    billingAccountId: sourceId,
    accountType: 'personal',
    preconditionHash: enterpriseAbsorbSha256({
      account: snapshot.sourceAccount,
      transactionRowsSha256: snapshot.transactionRowsSha256,
      allocationRowsSha256: snapshot.allocationRowsSha256,
    }),
    walletBalanceUsd: money(snapshot.sourceAccount.walletBalanceUsd),
    throughTransactionId: sourceOrder.ordered.at(-1)!.id,
    expectedSettlementCount: snapshot.settlements.filter((row) => row.billingAccountId === sourceId).length,
    transactionSequenceMutations: sourceSequencePlan.mutations,
    grantMutations: sourceGrantComponents.mutations,
    allocationMutations: sourceAllocationPlan.mutations,
  };
  const targetBase: Omit<EnterpriseAbsorbAccountPlan, 'replayHash'> = {
    billingAccountId: targetId,
    accountType: 'enterprise',
    preconditionHash: enterpriseAbsorbSha256({
      account: snapshot.targetAccount,
      transactionRowsSha256: snapshot.transactionRowsSha256,
      grantRowsSha256: snapshot.grantRowsSha256,
      allocationRowsSha256: snapshot.allocationRowsSha256,
      settlementRowsSha256: snapshot.settlementRowsSha256,
      orderRowsSha256: snapshot.orderRowsSha256,
      invoiceRowsSha256: snapshot.invoiceRowsSha256,
    }),
    walletBalanceUsd: money(snapshot.targetAccount.walletBalanceUsd),
    throughTransactionId: targetOrder.ordered.at(-1)!.id,
    expectedSettlementCount: snapshot.settlements.filter((row) => row.billingAccountId === targetId).length,
    transactionSequenceMutations: targetSequencePlan.mutations,
    grantMutations: targetGrantComponents.mutations,
    allocationMutations: targetAllocationPlan.mutations,
  };
  const source: EnterpriseAbsorbAccountPlan = {
    ...sourceBase,
    replayHash: enterpriseAbsorbAccountReplayHash(sourceBase, transferProofHash, []),
  };
  const target: EnterpriseAbsorbAccountPlan = {
    ...targetBase,
    replayHash: enterpriseAbsorbAccountReplayHash(
      targetBase, transferProofHash, adminGrantCreations,
    ),
  };
  const withoutPairHash: Omit<ReadyEnterpriseAbsorbPairPlan, 'pairReplayHash'> = {
    status: 'READY_PAIR',
    repairKind: REPAIR_KIND,
    sourceBillingAccountId: sourceId,
    targetBillingAccountId: targetId,
    preconditionHash,
    transferProofHash,
    transfer,
    transferGrants: movedGrantPlans,
    adminGrantCreations,
    source,
    target,
  };
  return {
    ...withoutPairHash,
    pairReplayHash: enterpriseAbsorbPairReplayHash(withoutPairHash),
  };
}

function exactObjectKeys(value: unknown, allowed: readonly string[], label: string): void {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown fields: ${unknown.join(',')}`);
}

function isLowerSha256(value: unknown): value is string {
  return typeof value === 'string' && /^[0-9a-f]{64}$/.test(value);
}

export function parseEnterpriseAbsorbPlanManifest(line: string): RepairPlanManifest {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error('plan manifest is not valid JSON');
  }
  exactObjectKeys(value, [
    'recordType', 'databaseName', 'databaseIdentity', 'databaseSystemIdentifier',
    'databaseOid', 'phase', 'endpointSha256',
  ], 'plan manifest');
  const manifest = value as Partial<RepairPlanManifest>;
  if (
    manifest.recordType !== PLAN_FORMAT
    || typeof manifest.databaseName !== 'string'
    || manifest.databaseName.trim() !== manifest.databaseName
    || manifest.databaseName.length === 0
    || typeof manifest.databaseIdentity !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      manifest.databaseIdentity,
    )
    || typeof manifest.databaseSystemIdentifier !== 'string'
    || !/^[1-9]\d{0,19}$/.test(manifest.databaseSystemIdentifier)
    || typeof manifest.databaseOid !== 'string'
    || !/^[1-9]\d{0,9}$/.test(manifest.databaseOid)
    || BigInt(manifest.databaseOid) > BigInt(4_294_967_295)
    || manifest.phase !== 'V2_CONTRACT'
    || !isLowerSha256(manifest.endpointSha256)
  ) throw new Error('plan manifest has invalid database binding fields');
  return manifest as RepairPlanManifest;
}

function validateAccountPlan(
  account: unknown,
  expectedType: 'personal' | 'enterprise',
  transferProofHash: string,
  adminGrantCreations: EnterpriseAbsorbAdminGrantPlan[],
  label: string,
): EnterpriseAbsorbAccountPlan {
  exactObjectKeys(account, [
    'billingAccountId', 'accountType', 'preconditionHash', 'replayHash',
    'walletBalanceUsd', 'throughTransactionId', 'expectedSettlementCount',
    'transactionSequenceMutations', 'grantMutations', 'allocationMutations',
  ], label);
  const value = account as Partial<EnterpriseAbsorbAccountPlan>;
  if (
    typeof value.billingAccountId !== 'string'
    || value.accountType !== expectedType
    || !isLowerSha256(value.preconditionHash)
    || !isLowerSha256(value.replayHash)
    || typeof value.walletBalanceUsd !== 'string'
    || typeof value.throughTransactionId !== 'string'
    || !Number.isInteger(value.expectedSettlementCount)
    || (value.expectedSettlementCount ?? -1) < 0
    || !Array.isArray(value.transactionSequenceMutations)
    || !Array.isArray(value.grantMutations)
    || !Array.isArray(value.allocationMutations)
  ) throw new Error(`${label} has invalid fields`);
  value.transactionSequenceMutations.forEach((mutation, index) => {
    exactObjectKeys(mutation, [
      'transactionId', 'expectedLedgerSequence', 'ledgerSequence',
    ], `${label}.transactionSequenceMutations[${index}]`);
    if (
      typeof mutation.transactionId !== 'string'
      || mutation.expectedLedgerSequence !== null
      || typeof mutation.ledgerSequence !== 'string'
      || !/^-[1-9]\d*$/.test(mutation.ledgerSequence)
    ) throw new Error(`${label}.transactionSequenceMutations[${index}] invalid`);
  });
  value.grantMutations.forEach((mutation, index) => {
    exactObjectKeys(mutation, [
      'grantId', 'expectedRemainingAmountUsd', 'expectedRemainingPaidAmountUsd',
      'expectedRemainingBonusAmountUsd', 'remainingAmountUsd',
      'remainingPaidAmountUsd', 'remainingBonusAmountUsd',
    ], `${label}.grantMutations[${index}]`);
    if (
      typeof mutation.grantId !== 'string'
      || typeof mutation.expectedRemainingAmountUsd !== 'string'
      || (mutation.expectedRemainingPaidAmountUsd !== null
        && typeof mutation.expectedRemainingPaidAmountUsd !== 'string')
      || (mutation.expectedRemainingBonusAmountUsd !== null
        && typeof mutation.expectedRemainingBonusAmountUsd !== 'string')
      || typeof mutation.remainingAmountUsd !== 'string'
      || typeof mutation.remainingPaidAmountUsd !== 'string'
      || typeof mutation.remainingBonusAmountUsd !== 'string'
    ) throw new Error(`${label}.grantMutations[${index}] invalid`);
  });
  value.allocationMutations.forEach((mutation, index) => {
    exactObjectKeys(mutation, [
      'allocationId', 'expectedLedgerSequence', 'ledgerSequence',
      'expectedRecognizedRevenueUsd', 'recognizedRevenueUsd',
      'expectedBonusConsumedUsd', 'bonusConsumedUsd', 'expectedSettledUsd',
      'settledUsd', 'expectedSettledAt', 'settledAt',
    ], `${label}.allocationMutations[${index}]`);
    if (
      typeof mutation.allocationId !== 'string'
      || (mutation.expectedLedgerSequence !== null
        && typeof mutation.expectedLedgerSequence !== 'string')
      || typeof mutation.ledgerSequence !== 'string'
      || !/^-[1-9]\d*$/.test(mutation.ledgerSequence)
      || typeof mutation.expectedRecognizedRevenueUsd !== 'string'
      || typeof mutation.recognizedRevenueUsd !== 'string'
      || typeof mutation.expectedBonusConsumedUsd !== 'string'
      || typeof mutation.bonusConsumedUsd !== 'string'
      || typeof mutation.expectedSettledUsd !== 'string'
      || typeof mutation.settledUsd !== 'string'
      || (mutation.expectedSettledAt !== null && typeof mutation.expectedSettledAt !== 'string')
      || (mutation.settledAt !== null && typeof mutation.settledAt !== 'string')
    ) throw new Error(`${label}.allocationMutations[${index}] invalid`);
  });
  const ready = value as EnterpriseAbsorbAccountPlan;
  const { replayHash, ...base } = ready;
  if (
    enterpriseAbsorbAccountReplayHash(base, transferProofHash, adminGrantCreations) !== replayHash
  ) throw new Error(`${label} replay hash mismatch`);
  return ready;
}

function parseEnterpriseAbsorbPlan(line: string): EnterpriseAbsorbPairPlan {
  let parsed: unknown;
  try {
    parsed = JSON.parse(line);
  } catch {
    throw new Error('pair plan is not valid JSON');
  }
  if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) {
    throw new Error('pair plan must be an object');
  }
  const status = (parsed as { status?: unknown }).status;
  if (status === 'QUARANTINED_PAIR') {
    exactObjectKeys(parsed, [
      'status', 'repairKind', 'sourceBillingAccountId', 'targetBillingAccountId',
      'preconditionHash', 'reasons',
    ], 'quarantined pair plan');
    const value = parsed as Partial<QuarantinedEnterpriseAbsorbPairPlan>;
    if (
      value.repairKind !== REPAIR_KIND
      || typeof value.sourceBillingAccountId !== 'string'
      || typeof value.targetBillingAccountId !== 'string'
      || !isLowerSha256(value.preconditionHash)
      || !Array.isArray(value.reasons)
      || value.reasons.some((reason) => typeof reason !== 'string')
    ) throw new Error('quarantined pair plan has invalid fields');
    return value as QuarantinedEnterpriseAbsorbPairPlan;
  }
  exactObjectKeys(parsed, [
    'status', 'repairKind', 'sourceBillingAccountId', 'targetBillingAccountId',
    'preconditionHash', 'transferProofHash', 'pairReplayHash', 'transfer',
    'transferGrants', 'adminGrantCreations', 'source', 'target',
  ], 'ready pair plan');
  const value = parsed as Partial<ReadyEnterpriseAbsorbPairPlan>;
  if (
    value.status !== 'READY_PAIR'
    || value.repairKind !== REPAIR_KIND
    || typeof value.sourceBillingAccountId !== 'string'
    || typeof value.targetBillingAccountId !== 'string'
    || value.sourceBillingAccountId === value.targetBillingAccountId
    || !isLowerSha256(value.preconditionHash)
    || !isLowerSha256(value.transferProofHash)
    || !isLowerSha256(value.pairReplayHash)
    || !Array.isArray(value.transferGrants)
    || !Array.isArray(value.adminGrantCreations)
  ) throw new Error('ready pair plan has invalid fields');
  exactObjectKeys(value.transfer, [
    'outTransactionId', 'inTransactionId', 'originalXmin', 'amountUsd',
  ], 'ready pair plan.transfer');
  if (
    typeof value.transfer?.outTransactionId !== 'string'
    || typeof value.transfer.inTransactionId !== 'string'
    || typeof value.transfer.originalXmin !== 'string'
    || !/^[1-9]\d*$/.test(value.transfer.originalXmin)
    || typeof value.transfer.amountUsd !== 'string'
  ) throw new Error('ready pair plan transfer invalid');
  value.transferGrants.forEach((grant, index) => {
    exactObjectKeys(grant, [
      'grantId', 'sourceFundingTransactionId', 'transferredAmountUsd',
      'transferredPaidUsd', 'transferredBonusUsd', 'sourceConsumedAmountUsd',
      'sourceConsumedPaidUsd', 'sourceConsumedBonusUsd', 'targetConsumedAmountUsd',
      'targetConsumedPaidUsd', 'targetConsumedBonusUsd', 'sourceAllocationCount',
      'targetAllocationCount', 'sourceAllocationsSha256', 'targetAllocationsSha256',
      'invoiceEvidenceSha256',
    ], `ready pair plan.transferGrants[${index}]`);
    if (
      typeof grant.grantId !== 'string'
      || typeof grant.sourceFundingTransactionId !== 'string'
      || !Number.isInteger(grant.sourceAllocationCount)
      || !Number.isInteger(grant.targetAllocationCount)
      || !isLowerSha256(grant.sourceAllocationsSha256)
      || !isLowerSha256(grant.targetAllocationsSha256)
      || !isLowerSha256(grant.invoiceEvidenceSha256)
    ) throw new Error(`ready pair plan.transferGrants[${index}] invalid`);
  });
  value.adminGrantCreations.forEach((grant, index) => {
    exactObjectKeys(grant, [
      'transactionId', 'grantId', 'idempotencyKey', 'idempotencyScope',
      'idempotencySnapshotSha256', 'userId', 'tenantId', 'billingAccountId',
      'productId', 'amountUsd', 'validFrom', 'expiresAt', 'createdAt',
    ], `ready pair plan.adminGrantCreations[${index}]`);
    if (
      typeof grant.transactionId !== 'string'
      || grant.grantId !== `repair-admin-recharge:${grant.transactionId}`
      || typeof grant.idempotencyKey !== 'string'
      || grant.idempotencyScope !== 'admin:adjust-balance'
      || !isLowerSha256(grant.idempotencySnapshotSha256)
      || grant.billingAccountId !== value.targetBillingAccountId
    ) throw new Error(`ready pair plan.adminGrantCreations[${index}] invalid`);
  });
  const transferProofHash = enterpriseAbsorbSha256({
    transfer: value.transfer,
    transferGrants: value.transferGrants,
  });
  if (transferProofHash !== value.transferProofHash) {
    throw new Error('ready pair plan transfer proof hash mismatch');
  }
  const source = validateAccountPlan(
    value.source,
    'personal',
    value.transferProofHash,
    [],
    'ready pair plan.source',
  );
  const target = validateAccountPlan(
    value.target,
    'enterprise',
    value.transferProofHash,
    value.adminGrantCreations,
    'ready pair plan.target',
  );
  if (
    source.billingAccountId !== value.sourceBillingAccountId
    || target.billingAccountId !== value.targetBillingAccountId
  ) throw new Error('ready pair plan account ids mismatch');
  const ready = { ...value, source, target } as ReadyEnterpriseAbsorbPairPlan;
  const { pairReplayHash, ...withoutHash } = ready;
  if (enterpriseAbsorbPairReplayHash(withoutHash) !== pairReplayHash) {
    throw new Error('ready pair plan pair replay hash mismatch');
  }
  return ready;
}

export function parseEnterpriseAbsorbPlanFile(raw: string): {
  manifest: RepairPlanManifest;
  plan: EnterpriseAbsorbPairPlan;
} {
  if (raw.length === 0 || !raw.endsWith('\n') || raw.includes('\r')) {
    throw new Error('plan file must be non-empty canonical LF-terminated JSONL');
  }
  const lines = raw.slice(0, -1).split('\n');
  if (lines.length !== 2 || lines.some((line) => line.length === 0)) {
    throw new Error('plan file must contain exactly one manifest and one pair record');
  }
  return {
    manifest: parseEnterpriseAbsorbPlanManifest(lines[0]),
    plan: parseEnterpriseAbsorbPlan(lines[1]),
  };
}

export function enterpriseAbsorbDatabaseEndpointSha256(): string {
  const raw = process.env.DATABASE_URL ?? process.env.BILLING_DATABASE_URL;
  if (!raw) throw new Error('DATABASE_URL_OR_BILLING_DATABASE_URL_REQUIRED');
  let endpoint: URL;
  try {
    endpoint = new URL(raw);
  } catch {
    throw new Error('DATABASE_URL_INVALID');
  }
  if (endpoint.protocol !== 'postgresql:' && endpoint.protocol !== 'postgres:') {
    throw new Error(`DATABASE_URL_PROTOCOL_UNSUPPORTED:${endpoint.protocol}`);
  }
  return enterpriseAbsorbSha256(JSON.stringify({
    protocol: 'postgresql:',
    hostname: endpoint.hostname.toLowerCase(),
    port: endpoint.port || '5432',
    pathname: endpoint.pathname,
    parameters: [...endpoint.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) => (
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
    )),
  }));
}

async function loadRepairDatabaseBinding(
  client: Client,
  expected?: Pick<RepairDatabaseBinding, 'databaseName' | 'databaseIdentity'>,
): Promise<RepairDatabaseBinding> {
  if (expected) {
    await client.$executeRaw`
      SELECT "assert_balance_ledger_database_identity"(
        ${expected.databaseName}, ${expected.databaseIdentity}::UUID, TRUE
      )`;
  }
  const [row] = await client.$queryRaw<Array<{
    databaseName: string;
    databaseIdentity: string;
    databaseSystemIdentifier: Prisma.Decimal;
    databaseOid: number;
    phase: string;
  }>>`
    SELECT
      current_database() AS "databaseName",
      control."database_identity"::TEXT AS "databaseIdentity",
      control."database_system_identifier" AS "databaseSystemIdentifier",
      control."database_oid"::INTEGER AS "databaseOid",
      control."phase" AS "phase"
    FROM "balance_ledger_rollout_control" control
    WHERE control."id" = 1`;
  if (!row || row.phase !== 'V2_CONTRACT') throw new Error('DATABASE_BINDING_MISMATCH');
  return {
    databaseName: row.databaseName,
    databaseIdentity: row.databaseIdentity,
    databaseSystemIdentifier: row.databaseSystemIdentifier.toFixed(0),
    databaseOid: String(row.databaseOid),
    phase: 'V2_CONTRACT',
  };
}

function iso(value: Date | string | null): string | null {
  return value === null ? null : new Date(value).toISOString();
}

async function loadEnterpriseAbsorbPairSnapshot(
  client: Client,
  sourceBillingAccountId: string,
  targetBillingAccountId: string,
): Promise<EnterpriseAbsorbPairEvidenceSnapshot> {
  if (!sourceBillingAccountId || !targetBillingAccountId || sourceBillingAccountId === targetBillingAccountId) {
    throw new Error('PAIR_ACCOUNT_IDS_INVALID');
  }
  const accountRows = await client.$queryRaw<Array<{
    id: string;
    type: string;
    ownerUserId: string | null;
    status: string;
    currency: string;
    ledgerStatus: string;
    ledgerVersion: number;
    walletBalanceUsd: Prisma.Decimal;
  }>>`
    SELECT account."id", account."type", account."owner_user_id" AS "ownerUserId",
      account."status", account."currency",
      account."balance_grant_ledger_status" AS "ledgerStatus",
      account."balance_grant_ledger_version" AS "ledgerVersion",
      wallet."balance_usd" AS "walletBalanceUsd"
    FROM "billing_accounts" account
    JOIN "account_wallets" wallet ON wallet."billing_account_id" = account."id"
    WHERE account."id" IN (${sourceBillingAccountId}, ${targetBillingAccountId})
    ORDER BY account."id"`;
  const account = (id: string): EnterpriseAbsorbAccountEvidence => {
    const row = accountRows.find((candidate) => candidate.id === id);
    if (!row) throw new Error(`PAIR_ACCOUNT_OR_WALLET_MISSING:${id}`);
    return {
      id: row.id,
      type: row.type,
      ownerUserId: row.ownerUserId,
      status: row.status,
      currency: row.currency,
      ledgerStatus: row.ledgerStatus,
      ledgerVersion: row.ledgerVersion,
      walletBalanceUsd: money(row.walletBalanceUsd),
    };
  };
  const transactionRows = await client.$queryRaw<Array<{
    id: string;
    billingAccountId: string;
    userId: string;
    tenantId: string;
    productId: string | null;
    tokenUsageId: string | null;
    type: string;
    amountUsd: Prisma.Decimal;
    balanceAfterUsd: Prisma.Decimal;
    description: string;
    orderId: string | null;
    operationKey: string | null;
    ledgerSequence: bigint | null;
    createdAt: Date;
    xmin: string;
  }>>`
    SELECT transaction."id", transaction."billing_account_id" AS "billingAccountId",
      transaction."user_id" AS "userId", transaction."tenant_id" AS "tenantId",
      transaction."product_id" AS "productId", transaction."token_usage_id" AS "tokenUsageId",
      transaction."type"::TEXT AS "type", transaction."amount_usd" AS "amountUsd",
      transaction."balance_after_usd" AS "balanceAfterUsd", transaction."description",
      transaction."order_id" AS "orderId", transaction."operation_key" AS "operationKey",
      transaction."ledger_sequence" AS "ledgerSequence", transaction."created_at" AS "createdAt",
      transaction.xmin::TEXT AS "xmin"
    FROM "balance_transactions" transaction
    WHERE transaction."billing_account_id" IN (${sourceBillingAccountId}, ${targetBillingAccountId})
      OR transaction."order_id" IN (
        SELECT DISTINCT grant_row."order_id"
        FROM "balance_grants" grant_row
        WHERE grant_row."billing_account_id" IN (
          ${sourceBillingAccountId}, ${targetBillingAccountId}
        )
          AND grant_row."order_id" IS NOT NULL
      )
    ORDER BY transaction."id"`;
  const transactions: EnterpriseAbsorbTransactionEvidence[] = transactionRows.map((row) => ({
    ...row,
    type: row.type,
    amountUsd: money(row.amountUsd),
    balanceAfterUsd: money(row.balanceAfterUsd),
    ledgerSequence: row.ledgerSequence?.toString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
  const pairTransactionIds = transactions
    .filter((transaction) => (
      transaction.billingAccountId === sourceBillingAccountId
      || transaction.billingAccountId === targetBillingAccountId
    ))
    .map((transaction) => transaction.id);
  const transferTenantId = transactions.find((transaction) => (
    transaction.billingAccountId === sourceBillingAccountId
    && transaction.description === `enterprise-absorb:out to=${targetBillingAccountId}`
  ))?.tenantId;
  const [transferTenant] = transferTenantId
    ? await client.$queryRaw<Array<{
        id: string;
        ownerUserId: string;
        billingAccountId: string | null;
        status: string;
      }>>`
        SELECT tenant."id", tenant."owner_user_id" AS "ownerUserId",
          tenant."billing_account_id" AS "billingAccountId", tenant."status"
        FROM "tenants" tenant WHERE tenant."id" = ${transferTenantId}`
    : [];

  const grantRows = await client.$queryRaw<Array<{
    id: string;
    billingAccountId: string;
    userId: string;
    tenantId: string;
    productId: string | null;
    orderId: string | null;
    source: string;
    paidAmountUsd: Prisma.Decimal;
    bonusAmountUsd: Prisma.Decimal;
    grantedAmountUsd: Prisma.Decimal;
    remainingAmountUsd: Prisma.Decimal;
    remainingPaidAmountUsd: Prisma.Decimal | null;
    remainingBonusAmountUsd: Prisma.Decimal | null;
    discountRate: Prisma.Decimal;
    validFrom: Date;
    expiresAt: Date | null;
    isExpired: boolean;
    createdAt: Date;
  }>>`
    SELECT grant_row."id", grant_row."billing_account_id" AS "billingAccountId",
      grant_row."user_id" AS "userId", grant_row."tenant_id" AS "tenantId",
      grant_row."product_id" AS "productId", grant_row."order_id" AS "orderId",
      grant_row."source", grant_row."paid_amount_usd" AS "paidAmountUsd",
      grant_row."bonus_amount_usd" AS "bonusAmountUsd",
      grant_row."granted_amount_usd" AS "grantedAmountUsd",
      grant_row."remaining_amount_usd" AS "remainingAmountUsd",
      grant_row."remaining_paid_amount_usd" AS "remainingPaidAmountUsd",
      grant_row."remaining_bonus_amount_usd" AS "remainingBonusAmountUsd",
      grant_row."discount_rate" AS "discountRate", grant_row."valid_from" AS "validFrom",
      grant_row."expires_at" AS "expiresAt", grant_row."is_expired" AS "isExpired",
      grant_row."created_at" AS "createdAt"
    FROM "balance_grants" grant_row
    WHERE grant_row."billing_account_id" IN (${sourceBillingAccountId}, ${targetBillingAccountId})
      OR grant_row."order_id" IN (
        SELECT DISTINCT pair_grant."order_id"
        FROM "balance_grants" pair_grant
        WHERE pair_grant."billing_account_id" IN (
          ${sourceBillingAccountId}, ${targetBillingAccountId}
        )
          AND pair_grant."order_id" IS NOT NULL
      )
    ORDER BY grant_row."id"`;
  const grants: EnterpriseAbsorbGrantEvidence[] = grantRows.map((row) => ({
    ...row,
    paidAmountUsd: money(row.paidAmountUsd),
    bonusAmountUsd: money(row.bonusAmountUsd),
    grantedAmountUsd: money(row.grantedAmountUsd),
    remainingAmountUsd: money(row.remainingAmountUsd),
    remainingPaidAmountUsd: row.remainingPaidAmountUsd === null
      ? null : money(row.remainingPaidAmountUsd),
    remainingBonusAmountUsd: row.remainingBonusAmountUsd === null
      ? null : money(row.remainingBonusAmountUsd),
    discountRate: money(row.discountRate),
    validFrom: row.validFrom.toISOString(),
    expiresAt: iso(row.expiresAt),
    createdAt: row.createdAt.toISOString(),
  }));
  const grantIds = grants.map((grant) => grant.id);
  const allocationRows = await client.$queryRaw<Array<{
    id: string;
    billingAccountId: string;
    userId: string;
    tenantId: string;
    productId: string | null;
    balanceTransactionId: string;
    tokenUsageId: string | null;
    balanceGrantId: string | null;
    source: string;
    amountUsd: Prisma.Decimal;
    recognizedRevenueUsd: Prisma.Decimal;
    bonusConsumedUsd: Prisma.Decimal;
    discountRate: Prisma.Decimal;
    settledUsd: Prisma.Decimal;
    settledAt: Date | null;
    ledgerSequence: bigint | null;
    createdAt: Date;
  }>>`
    SELECT allocation."id", allocation."billing_account_id" AS "billingAccountId",
      allocation."user_id" AS "userId", allocation."tenant_id" AS "tenantId",
      allocation."product_id" AS "productId",
      allocation."balance_transaction_id" AS "balanceTransactionId",
      allocation."token_usage_id" AS "tokenUsageId",
      allocation."balance_grant_id" AS "balanceGrantId", allocation."source",
      allocation."amount_usd" AS "amountUsd",
      allocation."recognized_revenue_usd" AS "recognizedRevenueUsd",
      allocation."bonus_consumed_usd" AS "bonusConsumedUsd",
      allocation."discount_rate" AS "discountRate", allocation."settled_usd" AS "settledUsd",
      allocation."settled_at" AS "settledAt", allocation."ledger_sequence" AS "ledgerSequence",
      allocation."created_at" AS "createdAt"
    FROM "balance_consumption_allocations" allocation
    WHERE allocation."billing_account_id" IN (${sourceBillingAccountId}, ${targetBillingAccountId})
      OR allocation."balance_grant_id" IN (${Prisma.join(grantIds.length > 0 ? grantIds : [''])})
      OR allocation."balance_transaction_id" IN (
        ${Prisma.join(pairTransactionIds.length > 0 ? pairTransactionIds : [''])}
      )
    ORDER BY allocation."id"`;
  const allocations: EnterpriseAbsorbAllocationEvidence[] = allocationRows.map((row) => ({
    ...row,
    amountUsd: money(row.amountUsd),
    recognizedRevenueUsd: money(row.recognizedRevenueUsd),
    bonusConsumedUsd: money(row.bonusConsumedUsd),
    discountRate: money(row.discountRate),
    settledUsd: money(row.settledUsd),
    settledAt: iso(row.settledAt),
    ledgerSequence: row.ledgerSequence?.toString() ?? null,
    createdAt: row.createdAt.toISOString(),
  }));
  const allocationIds = allocations.map((allocation) => allocation.id);
  const settlementRows = await client.$queryRaw<Array<{
    id: string;
    billingAccountId: string;
    allocationId: string;
    repaymentTransactionId: string | null;
    balanceGrantId: string | null;
    repairRunId: string | null;
    operationKey: string | null;
    debtSource: string;
    trigger: string;
    amountUsd: Prisma.Decimal;
    paidUsd: Prisma.Decimal;
    bonusUsd: Prisma.Decimal;
    occurredAt: Date;
    createdAt: Date;
  }>>`
    SELECT settlement."id", settlement."billing_account_id" AS "billingAccountId",
      settlement."allocation_id" AS "allocationId",
      settlement."repayment_transaction_id" AS "repaymentTransactionId",
      settlement."balance_grant_id" AS "balanceGrantId",
      settlement."repair_run_id" AS "repairRunId",
      settlement."operation_key" AS "operationKey",
      settlement."debt_source" AS "debtSource",
      settlement."trigger", settlement."amount_usd" AS "amountUsd",
      settlement."paid_usd" AS "paidUsd", settlement."bonus_usd" AS "bonusUsd",
      settlement."occurred_at" AS "occurredAt", settlement."created_at" AS "createdAt"
    FROM "enterprise_credit_settlements" settlement
    WHERE settlement."billing_account_id" IN (${sourceBillingAccountId}, ${targetBillingAccountId})
      OR settlement."allocation_id" IN (${Prisma.join(allocationIds.length > 0 ? allocationIds : [''])})
      OR settlement."balance_grant_id" IN (${Prisma.join(grantIds.length > 0 ? grantIds : [''])})
      OR settlement."repayment_transaction_id" IN (
        ${Prisma.join(pairTransactionIds.length > 0 ? pairTransactionIds : [''])}
      )
    ORDER BY settlement."id"`;
  const settlements: EnterpriseAbsorbSettlementEvidence[] = settlementRows.map((row) => ({
    ...row,
    amountUsd: money(row.amountUsd),
    paidUsd: money(row.paidUsd),
    bonusUsd: money(row.bonusUsd),
    occurredAt: row.occurredAt.toISOString(),
    createdAt: row.createdAt.toISOString(),
  }));
  const orderIds = [...new Set(grants.map((grant) => grant.orderId).filter((id): id is string => id !== null))];
  const orderRows = orderIds.length === 0 ? [] : await client.$queryRaw<Array<{
    id: string;
    billingAccountId: string | null;
    userId: string;
    tenantId: string;
    productId: string | null;
    orderType: string;
    status: string;
    currency: string;
    amountCents: number;
    bonusCents: number;
    paidAt: Date | null;
    completedAt: Date | null;
    refundedAt: Date | null;
    refundAmountCents: number | null;
    createdAt: Date;
  }>>`
    SELECT order_row."id", order_row."billing_account_id" AS "billingAccountId",
      order_row."user_id" AS "userId", order_row."tenant_id" AS "tenantId",
      order_row."product_id" AS "productId", order_row."order_type"::TEXT AS "orderType",
      order_row."status"::TEXT AS "status", order_row."currency",
      order_row."amount_cents" AS "amountCents",
      order_row."bonus_cents" AS "bonusCents", order_row."paid_at" AS "paidAt",
      order_row."completed_at" AS "completedAt", order_row."refunded_at" AS "refundedAt",
      order_row."refund_amount_cents" AS "refundAmountCents",
      order_row."created_at" AS "createdAt"
    FROM "orders" order_row
    WHERE order_row."id" IN (${Prisma.join(orderIds)})
    ORDER BY order_row."id"`;
  const orders: EnterpriseAbsorbOrderEvidence[] = orderRows.map((row) => ({
    ...row,
    paidAt: iso(row.paidAt),
    completedAt: iso(row.completedAt),
    refundedAt: iso(row.refundedAt),
    createdAt: row.createdAt.toISOString(),
  }));
  const invoiceRows = orderIds.length === 0 ? [] : await client.$queryRaw<Array<{
    itemId: string;
    orderId: string;
    applicationId: string;
    applicationStatus: string;
    applicationUserId: string;
    applicationTenantId: string;
    principalCents: number;
    invoiceNumber: string | null;
    issueDate: Date | null;
    dueDate: Date | null;
    issuedAt: Date | null;
    pdfUrl: string | null;
    ofdUrl: string | null;
    hasIssuedLifecycleEvent: boolean;
  }>>`
    SELECT item."id" AS "itemId", item."order_id" AS "orderId",
      application."id" AS "applicationId", application."status"::TEXT AS "applicationStatus",
      application."user_id" AS "applicationUserId",
      application."tenant_id" AS "applicationTenantId",
      item."principal_cents" AS "principalCents", application."invoice_number" AS "invoiceNumber",
      application."issue_date" AS "issueDate", application."due_date" AS "dueDate",
      application."issued_at" AS "issuedAt", application."pdf_url" AS "pdfUrl",
      application."ofd_url" AS "ofdUrl",
      EXISTS (
        SELECT 1 FROM "invoice_event_log" event
        WHERE event."application_id" = application."id"
          AND event."to_status"::TEXT IN ('ISSUED', 'VOIDED', 'RED_OFFSET')
      ) AS "hasIssuedLifecycleEvent"
    FROM "invoice_application_items" item
    JOIN "invoice_applications" application ON application."id" = item."application_id"
    WHERE item."order_id" IN (${Prisma.join(orderIds)})
    ORDER BY item."id"`;
  const invoiceEvidence: EnterpriseAbsorbInvoiceEvidence[] = invoiceRows.map((row) => ({
    ...row,
    issueDate: iso(row.issueDate),
    dueDate: iso(row.dueDate),
    issuedAt: iso(row.issuedAt),
  }));
  const idempotencyRows = await client.$queryRaw<Array<{
    key: string;
    scope: string;
    userId: string | null;
    status: string;
    result: unknown;
    createdAt: Date;
    expiresAt: Date;
    snapshotText: string;
  }>>`
    SELECT idempotency."key", idempotency."scope", idempotency."user_id" AS "userId",
      idempotency."status", idempotency."result",
      idempotency."created_at" AS "createdAt", idempotency."expires_at" AS "expiresAt",
      to_jsonb(idempotency)::TEXT AS "snapshotText"
    FROM "idempotency_keys" idempotency
    WHERE idempotency."scope" = 'admin:adjust-balance'
      AND idempotency."key" LIKE ${`enterprise-recharge:${targetBillingAccountId}:%`}
    ORDER BY idempotency."key"`;
  const idempotencyEvidence = idempotencyRows.map((row): EnterpriseAbsorbIdempotencyEvidence => ({
    key: row.key,
    scope: row.scope,
    userId: row.userId,
    status: row.status,
    result: row.result,
    createdAt: row.createdAt.toISOString(),
    expiresAt: row.expiresAt.toISOString(),
    snapshotSha256: enterpriseAbsorbSha256(row.snapshotText),
  }));
  const [auditFacts] = await client.$queryRaw<Array<{
    expiryGrantIds: string[];
    refundGrantIds: string[];
  }>>`
    SELECT
      COALESCE(array_agg(DISTINCT expiry."balance_grant_id" ORDER BY expiry."balance_grant_id")
        FILTER (WHERE expiry."balance_grant_id" IS NOT NULL), ARRAY[]::TEXT[]) AS "expiryGrantIds",
      COALESCE(array_agg(DISTINCT refund."balance_grant_id" ORDER BY refund."balance_grant_id")
        FILTER (WHERE refund."balance_grant_id" IS NOT NULL), ARRAY[]::TEXT[]) AS "refundGrantIds"
    FROM (SELECT unnest(${grantIds}::TEXT[]) AS grant_id) ids
    LEFT JOIN "balance_grant_expiries" expiry ON expiry."balance_grant_id" = ids.grant_id
    LEFT JOIN "balance_grant_refunds" refund ON refund."balance_grant_id" = ids.grant_id`;
  const [rowHashes] = await client.$queryRaw<Array<{
    financialNow: Date;
    transactionRows: string;
    grantRows: string;
    allocationRows: string;
    settlementRows: string;
    orderRows: string;
    invoiceRows: string;
  }>>`
    SELECT clock_timestamp()::TIMESTAMP(3) AS "financialNow",
      COALESCE((SELECT jsonb_agg(to_jsonb(row_data) ORDER BY row_data."id")::TEXT FROM (
        SELECT transaction.*, transaction.xmin::TEXT AS original_xmin
        FROM "balance_transactions" transaction
        WHERE transaction."billing_account_id" IN (${sourceBillingAccountId}, ${targetBillingAccountId})
          OR transaction."order_id" IN (
            SELECT DISTINCT grant_row."order_id"
            FROM "balance_grants" grant_row
            WHERE grant_row."billing_account_id" IN (
              ${sourceBillingAccountId}, ${targetBillingAccountId}
            )
              AND grant_row."order_id" IS NOT NULL
          )
      ) row_data), '[]') AS "transactionRows",
      COALESCE((SELECT jsonb_agg(to_jsonb(grant_row) ORDER BY grant_row."id")::TEXT
        FROM "balance_grants" grant_row
        WHERE grant_row."billing_account_id" IN (${sourceBillingAccountId}, ${targetBillingAccountId})
          OR grant_row."order_id" IN (
            SELECT DISTINCT pair_grant."order_id"
            FROM "balance_grants" pair_grant
            WHERE pair_grant."billing_account_id" IN (
              ${sourceBillingAccountId}, ${targetBillingAccountId}
            )
              AND pair_grant."order_id" IS NOT NULL
          )), '[]') AS "grantRows",
      COALESCE((SELECT jsonb_agg(to_jsonb(allocation) ORDER BY allocation."id")::TEXT
        FROM "balance_consumption_allocations" allocation
        WHERE allocation."billing_account_id" IN (${sourceBillingAccountId}, ${targetBillingAccountId})
          OR allocation."balance_grant_id" IN (${Prisma.join(grantIds.length > 0 ? grantIds : [''])})
          OR allocation."balance_transaction_id" IN (
            ${Prisma.join(pairTransactionIds.length > 0 ? pairTransactionIds : [''])}
          )), '[]') AS "allocationRows",
      COALESCE((SELECT jsonb_agg(to_jsonb(settlement) ORDER BY settlement."id")::TEXT
        FROM "enterprise_credit_settlements" settlement
        WHERE settlement."billing_account_id" IN (${sourceBillingAccountId}, ${targetBillingAccountId})
          OR settlement."allocation_id" IN (${Prisma.join(allocationIds.length > 0 ? allocationIds : [''])})
          OR settlement."balance_grant_id" IN (${Prisma.join(grantIds.length > 0 ? grantIds : [''])})
          OR settlement."repayment_transaction_id" IN (
            ${Prisma.join(pairTransactionIds.length > 0 ? pairTransactionIds : [''])}
          )), '[]') AS "settlementRows",
      ${JSON.stringify(orders)}::TEXT AS "orderRows",
      ${JSON.stringify(invoiceEvidence)}::TEXT AS "invoiceRows"`;
  return {
    financialNow: rowHashes.financialNow.toISOString(),
    sourceAccount: account(sourceBillingAccountId),
    targetAccount: account(targetBillingAccountId),
    transferTenant: transferTenant ?? null,
    transactions,
    grants,
    allocations,
    settlements,
    orders,
    invoiceEvidence,
    idempotencyEvidence,
    expiryGrantIds: auditFacts?.expiryGrantIds ?? [],
    refundGrantIds: auditFacts?.refundGrantIds ?? [],
    transactionRowsSha256: enterpriseAbsorbSha256(rowHashes.transactionRows),
    grantRowsSha256: enterpriseAbsorbSha256(rowHashes.grantRows),
    allocationRowsSha256: enterpriseAbsorbSha256(rowHashes.allocationRows),
    settlementRowsSha256: enterpriseAbsorbSha256(rowHashes.settlementRows),
    orderRowsSha256: enterpriseAbsorbSha256(rowHashes.orderRows),
    invoiceRowsSha256: enterpriseAbsorbSha256(rowHashes.invoiceRows),
  };
}

function repairAuditJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function assertPairSetMutationCardinality(
  label: string,
  expectedIds: string[],
  actualIds: string[],
): void {
  const actual = new Set(actualIds);
  const missingId = expectedIds.find((id) => !actual.has(id));
  if (actualIds.length !== expectedIds.length || actual.size !== expectedIds.length || missingId) {
    throw new Error(
      `${label}:${missingId ?? 'CARDINALITY'}:${actualIds.length}/${expectedIds.length}`,
    );
  }
}

export async function applyPairTransactionSequenceMutationsSetBased(
  tx: Prisma.TransactionClient,
  runId: string,
  repairAccountId: string,
  billingAccountId: string,
  mutations: PairTransactionSequenceMutation[],
): Promise<void> {
  if (mutations.length === 0) return;
  const inputJson = JSON.stringify(mutations.map((mutation) => ({
    auditId: randomUUID(),
    transactionId: mutation.transactionId,
    ledgerSequence: mutation.ledgerSequence,
  })));
  const inserted = await tx.$queryRaw<Array<{ transactionId: string }>>`
    WITH mutation_input AS (
      SELECT
        mutation.value->>'auditId' AS audit_id,
        mutation.value->>'transactionId' AS transaction_id,
        (mutation.value->>'ledgerSequence')::BIGINT AS ledger_sequence
      FROM jsonb_array_elements(${inputJson}::JSONB) AS mutation(value)
    )
    INSERT INTO "balance_ledger_transaction_repairs" (
      "id", "operation_key", "run_id", "repair_account_id",
      "billing_account_id", "transaction_id", "before_snapshot", "after_snapshot"
    )
    SELECT mutation_input.audit_id,
      'repair:transaction-sequence:' || ${runId} || ':' || mutation_input.transaction_id,
      ${runId}, ${repairAccountId}, ${billingAccountId}, transaction_row."id",
      to_jsonb(transaction_row),
      to_jsonb(transaction_row) || jsonb_build_object(
        'ledger_sequence', mutation_input.ledger_sequence
      )
    FROM mutation_input
    JOIN "balance_transactions" transaction_row
      ON transaction_row."id" = mutation_input.transaction_id
    WHERE transaction_row."billing_account_id" = ${billingAccountId}
      AND transaction_row."ledger_sequence" IS NULL
    RETURNING "transaction_id" AS "transactionId"`;
  assertPairSetMutationCardinality(
    'STALE_TRANSACTION_SEQUENCE_AUDIT',
    mutations.map((mutation) => mutation.transactionId),
    inserted.map((row) => row.transactionId),
  );
  const updated = await tx.$queryRaw<Array<{ transactionId: string }>>`
    WITH mutation_input AS (
      SELECT
        mutation.value->>'transactionId' AS transaction_id,
        (mutation.value->>'ledgerSequence')::BIGINT AS ledger_sequence
      FROM jsonb_array_elements(${inputJson}::JSONB) AS mutation(value)
    )
    UPDATE "balance_transactions" transaction_row
    SET "ledger_sequence" = mutation_input.ledger_sequence
    FROM mutation_input
    WHERE transaction_row."id" = mutation_input.transaction_id
      AND transaction_row."billing_account_id" = ${billingAccountId}
      AND transaction_row."ledger_sequence" IS NULL
    RETURNING transaction_row."id" AS "transactionId"`;
  assertPairSetMutationCardinality(
    'STALE_TRANSACTION_SEQUENCE',
    mutations.map((mutation) => mutation.transactionId),
    updated.map((row) => row.transactionId),
  );
}

export async function applyPairAllocationMutationsSetBased(
  tx: Prisma.TransactionClient,
  runId: string,
  repairAccountId: string,
  billingAccountId: string,
  mutations: PairAllocationMutation[],
): Promise<void> {
  if (mutations.length === 0) return;
  const inputJson = JSON.stringify(mutations.map((mutation) => ({
    auditId: randomUUID(),
    ...mutation,
  })));
  const inserted = await tx.$queryRaw<Array<{ allocationId: string }>>`
    WITH mutation_input AS (
      SELECT
        mutation.value->>'auditId' AS audit_id,
        mutation.value->>'allocationId' AS allocation_id,
        (mutation.value->>'ledgerSequence')::BIGINT AS ledger_sequence,
        (mutation.value->>'recognizedRevenueUsd')::NUMERIC AS recognized_revenue_usd,
        (mutation.value->>'bonusConsumedUsd')::NUMERIC AS bonus_consumed_usd,
        (mutation.value->>'settledUsd')::NUMERIC AS settled_usd,
        (mutation.value->>'settledAt')::TIMESTAMP(3) AS settled_at,
        (mutation.value->>'expectedLedgerSequence')::BIGINT AS expected_ledger_sequence,
        (mutation.value->>'expectedRecognizedRevenueUsd')::NUMERIC
          AS expected_recognized_revenue_usd,
        (mutation.value->>'expectedBonusConsumedUsd')::NUMERIC
          AS expected_bonus_consumed_usd,
        (mutation.value->>'expectedSettledUsd')::NUMERIC AS expected_settled_usd,
        (mutation.value->>'expectedSettledAt')::TIMESTAMP(3) AS expected_settled_at
      FROM jsonb_array_elements(${inputJson}::JSONB) AS mutation(value)
    )
    INSERT INTO "balance_ledger_allocation_repairs" (
      "id", "operation_key", "run_id", "repair_account_id",
      "billing_account_id", "allocation_id", "before_snapshot", "after_snapshot"
    )
    SELECT mutation_input.audit_id,
      'repair:allocation:' || ${runId} || ':' || mutation_input.allocation_id,
      ${runId}, ${repairAccountId}, ${billingAccountId}, allocation."id",
      to_jsonb(allocation),
      to_jsonb(allocation) || jsonb_build_object(
        'ledger_sequence', mutation_input.ledger_sequence,
        'recognized_revenue_usd', mutation_input.recognized_revenue_usd,
        'bonus_consumed_usd', mutation_input.bonus_consumed_usd,
        'settled_usd', mutation_input.settled_usd,
        'settled_at', mutation_input.settled_at
      )
    FROM mutation_input
    JOIN "balance_consumption_allocations" allocation
      ON allocation."id" = mutation_input.allocation_id
    WHERE allocation."billing_account_id" = ${billingAccountId}
      AND allocation."ledger_sequence" IS NOT DISTINCT FROM
        mutation_input.expected_ledger_sequence
      AND allocation."recognized_revenue_usd" IS NOT DISTINCT FROM
        mutation_input.expected_recognized_revenue_usd
      AND allocation."bonus_consumed_usd" IS NOT DISTINCT FROM
        mutation_input.expected_bonus_consumed_usd
      AND allocation."settled_usd" IS NOT DISTINCT FROM
        mutation_input.expected_settled_usd
      AND allocation."settled_at" IS NOT DISTINCT FROM
        mutation_input.expected_settled_at
    RETURNING "allocation_id" AS "allocationId"`;
  assertPairSetMutationCardinality(
    'STALE_ALLOCATION_AUDIT',
    mutations.map((mutation) => mutation.allocationId),
    inserted.map((row) => row.allocationId),
  );

  const updated = await tx.$queryRaw<Array<{ allocationId: string }>>`
    WITH mutation_input AS (
      SELECT
        mutation.value->>'allocationId' AS allocation_id,
        (mutation.value->>'ledgerSequence')::BIGINT AS ledger_sequence,
        (mutation.value->>'recognizedRevenueUsd')::NUMERIC AS recognized_revenue_usd,
        (mutation.value->>'bonusConsumedUsd')::NUMERIC AS bonus_consumed_usd,
        (mutation.value->>'settledUsd')::NUMERIC AS settled_usd,
        (mutation.value->>'settledAt')::TIMESTAMP(3) AS settled_at,
        (mutation.value->>'expectedLedgerSequence')::BIGINT AS expected_ledger_sequence,
        (mutation.value->>'expectedRecognizedRevenueUsd')::NUMERIC
          AS expected_recognized_revenue_usd,
        (mutation.value->>'expectedBonusConsumedUsd')::NUMERIC
          AS expected_bonus_consumed_usd,
        (mutation.value->>'expectedSettledUsd')::NUMERIC AS expected_settled_usd,
        (mutation.value->>'expectedSettledAt')::TIMESTAMP(3) AS expected_settled_at
      FROM jsonb_array_elements(${inputJson}::JSONB) AS mutation(value)
    )
    UPDATE "balance_consumption_allocations" allocation
    SET
      "ledger_sequence" = mutation_input.ledger_sequence,
      "recognized_revenue_usd" = mutation_input.recognized_revenue_usd,
      "bonus_consumed_usd" = mutation_input.bonus_consumed_usd,
      "settled_usd" = mutation_input.settled_usd,
      "settled_at" = mutation_input.settled_at
    FROM mutation_input
    WHERE allocation."id" = mutation_input.allocation_id
      AND allocation."billing_account_id" = ${billingAccountId}
      AND allocation."ledger_sequence" IS NOT DISTINCT FROM
        mutation_input.expected_ledger_sequence
      AND allocation."recognized_revenue_usd" IS NOT DISTINCT FROM
        mutation_input.expected_recognized_revenue_usd
      AND allocation."bonus_consumed_usd" IS NOT DISTINCT FROM
        mutation_input.expected_bonus_consumed_usd
      AND allocation."settled_usd" IS NOT DISTINCT FROM
        mutation_input.expected_settled_usd
      AND allocation."settled_at" IS NOT DISTINCT FROM
        mutation_input.expected_settled_at
    RETURNING allocation."id" AS "allocationId"`;
  assertPairSetMutationCardinality(
    'STALE_ALLOCATION',
    mutations.map((mutation) => mutation.allocationId),
    updated.map((row) => row.allocationId),
  );
}

export const ENTERPRISE_ABSORB_CANONICAL_CONSTRAINTS = [
  'balance_transactions_clean_canonical_deferred',
  'balance_debt_allocations_clean_canonical_deferred',
  'balance_grants_clean_canonical_deferred',
] as const;

export async function flushEnterpriseAbsorbCanonicalConstraintsWhileLegacyDirty(
  tx: Pick<Prisma.TransactionClient, '$executeRawUnsafe'>,
): Promise<void> {
  const constraintNames = ENTERPRISE_ABSORB_CANONICAL_CONSTRAINTS
    .map((name) => `"${name}"`)
    .join(', ');
  await tx.$executeRawUnsafe(`SET CONSTRAINTS ${constraintNames} IMMEDIATE`);
  await tx.$executeRawUnsafe(`SET CONSTRAINTS ${constraintNames} DEFERRED`);
}

async function registerPairGrantComponentAudit(
  tx: Prisma.TransactionClient,
  runId: string,
  repairAccountId: string,
  billingAccountId: string,
  mutation: PairGrantComponentMutation,
): Promise<void> {
  const inserted = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO "balance_ledger_grant_component_repairs" (
      "id", "operation_key", "run_id", "repair_account_id",
      "billing_account_id", "grant_id", "before_snapshot", "after_snapshot"
    )
    SELECT ${randomUUID()}, ${`repair:grant-components:${runId}:${mutation.grantId}`},
      ${runId}, ${repairAccountId}, ${billingAccountId}, grant_row."id",
      to_jsonb(grant_row),
      to_jsonb(grant_row) || jsonb_build_object(
        'remaining_paid_amount_usd', ${mutation.remainingPaidAmountUsd}::NUMERIC,
        'remaining_bonus_amount_usd', ${mutation.remainingBonusAmountUsd}::NUMERIC
      )
    FROM "balance_grants" grant_row
    WHERE grant_row."id" = ${mutation.grantId}
      AND grant_row."billing_account_id" = ${billingAccountId}
      AND grant_row."remaining_amount_usd" = ${mutation.expectedRemainingAmountUsd}::NUMERIC
      AND grant_row."remaining_paid_amount_usd" IS NOT DISTINCT FROM
        ${mutation.expectedRemainingPaidAmountUsd}::NUMERIC
      AND grant_row."remaining_bonus_amount_usd" IS NOT DISTINCT FROM
        ${mutation.expectedRemainingBonusAmountUsd}::NUMERIC
      AND grant_row."remaining_amount_usd" = ${mutation.remainingAmountUsd}::NUMERIC
    RETURNING "id"`;
  if (inserted.length !== 1) throw new Error(`STALE_GRANT_COMPONENT_AUDIT:${mutation.grantId}`);
}

async function insertTransferParentProof(
  tx: Prisma.TransactionClient,
  runId: string,
  sourceRepairAccountId: string,
  targetRepairAccountId: string,
  plan: ReadyEnterpriseAbsorbPairPlan,
): Promise<string> {
  const id = randomUUID();
  const inserted = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO "balance_ledger_account_transfer_repairs" (
      "id", "operation_key", "proof_version", "run_id",
      "source_repair_account_id", "target_repair_account_id",
      "source_billing_account_id", "target_billing_account_id",
      "out_transaction_id", "in_transaction_id", "amount_usd", "original_xmin",
      "out_transaction_snapshot", "in_transaction_snapshot"
    )
    SELECT ${id},
      ${`repair:enterprise-absorb:${runId}:${plan.transfer.outTransactionId}:${plan.transfer.inTransactionId}`},
      1, ${runId}, ${sourceRepairAccountId}, ${targetRepairAccountId},
      ${plan.sourceBillingAccountId}, ${plan.targetBillingAccountId},
      out_tx."id", in_tx."id", ${plan.transfer.amountUsd}::NUMERIC,
      ${plan.transfer.originalXmin}::BIGINT,
      to_jsonb(out_tx), to_jsonb(in_tx)
    FROM "balance_transactions" out_tx
    JOIN "balance_transactions" in_tx ON TRUE
    WHERE out_tx."id" = ${plan.transfer.outTransactionId}
      AND in_tx."id" = ${plan.transfer.inTransactionId}
      AND out_tx."billing_account_id" = ${plan.sourceBillingAccountId}
      AND in_tx."billing_account_id" = ${plan.targetBillingAccountId}
      AND out_tx.xmin::TEXT = ${plan.transfer.originalXmin}
      AND in_tx.xmin::TEXT = ${plan.transfer.originalXmin}
    RETURNING "id"`;
  if (inserted.length !== 1) throw new Error('STALE_TRANSFER_PARENT_PROOF');
  return id;
}

async function insertTransferGrantProofs(
  tx: Prisma.TransactionClient,
  runId: string,
  transferRepairId: string,
  plan: ReadyEnterpriseAbsorbPairPlan,
): Promise<void> {
  for (const grant of plan.transferGrants) {
    const inserted = await tx.$queryRaw<Array<{ id: string }>>`
      INSERT INTO "balance_ledger_account_transfer_grants" (
        "id", "operation_key", "transfer_repair_id", "grant_id",
        "source_funding_transaction_id", "transferred_amount_usd",
        "transferred_paid_usd", "transferred_bonus_usd",
        "source_consumed_amount_usd", "source_consumed_paid_usd",
        "source_consumed_bonus_usd", "target_consumed_amount_usd",
        "target_consumed_paid_usd", "target_consumed_bonus_usd",
        "source_allocation_count", "target_allocation_count",
        "source_allocations_sha256", "target_allocations_sha256",
        "grant_snapshot", "funding_transaction_snapshot",
        "source_allocations_snapshot", "target_allocations_snapshot",
        "invoice_evidence_sha256", "invoice_evidence_snapshot"
      )
      SELECT ${randomUUID()}, ${`repair:enterprise-absorb-grant:${runId}:${grant.grantId}`},
        ${transferRepairId}, grant_row."id", funding."id",
        ${grant.transferredAmountUsd}::NUMERIC, ${grant.transferredPaidUsd}::NUMERIC,
        ${grant.transferredBonusUsd}::NUMERIC, ${grant.sourceConsumedAmountUsd}::NUMERIC,
        ${grant.sourceConsumedPaidUsd}::NUMERIC, ${grant.sourceConsumedBonusUsd}::NUMERIC,
        ${grant.targetConsumedAmountUsd}::NUMERIC, ${grant.targetConsumedPaidUsd}::NUMERIC,
        ${grant.targetConsumedBonusUsd}::NUMERIC, ${grant.sourceAllocationCount}::BIGINT,
        ${grant.targetAllocationCount}::BIGINT, ${grant.sourceAllocationsSha256},
        ${grant.targetAllocationsSha256}, to_jsonb(grant_row), to_jsonb(funding),
        COALESCE((
          SELECT jsonb_agg(to_jsonb(allocation) ORDER BY allocation."id")
          FROM "balance_consumption_allocations" allocation
          WHERE allocation."balance_grant_id" = grant_row."id"
            AND allocation."billing_account_id" = ${plan.sourceBillingAccountId}
        ), '[]'::JSONB),
        COALESCE((
          SELECT jsonb_agg(to_jsonb(allocation) ORDER BY allocation."id")
          FROM "balance_consumption_allocations" allocation
          WHERE allocation."balance_grant_id" = grant_row."id"
            AND allocation."billing_account_id" = ${plan.targetBillingAccountId}
        ), '[]'::JSONB),
        ${grant.invoiceEvidenceSha256},
        jsonb_build_object(
          'order', CASE WHEN order_row."id" IS NULL THEN NULL ELSE to_jsonb(order_row) END,
          'items', COALESCE((
            SELECT jsonb_agg(
              to_jsonb(item) || jsonb_build_object(
                'application', to_jsonb(application),
                'events', COALESCE((
                  SELECT jsonb_agg(to_jsonb(event) ORDER BY event."occurred_at", event."id")
                  FROM "invoice_event_log" event
                  WHERE event."application_id" = application."id"
                ), '[]'::JSONB)
              ) ORDER BY item."id"
            )
            FROM "invoice_application_items" item
            JOIN "invoice_applications" application
              ON application."id" = item."application_id"
            WHERE item."order_id" = grant_row."order_id"
          ), '[]'::JSONB)
        )
      FROM "balance_grants" grant_row
      JOIN "balance_transactions" funding ON funding."id" = ${grant.sourceFundingTransactionId}
      LEFT JOIN "orders" order_row ON order_row."id" = grant_row."order_id"
      WHERE grant_row."id" = ${grant.grantId}
        AND grant_row."billing_account_id" = ${plan.targetBillingAccountId}
        AND funding."billing_account_id" = ${plan.sourceBillingAccountId}
      RETURNING "id"`;
    if (inserted.length !== 1) throw new Error(`STALE_TRANSFER_GRANT_PROOF:${grant.grantId}`);
  }
}

async function insertAdminGrantCreationProofAndGrant(
  tx: Prisma.TransactionClient,
  runId: string,
  targetRepairAccountId: string,
  plan: EnterpriseAbsorbAdminGrantPlan,
): Promise<void> {
  // Construct the persisted snapshot with SQL numeric/timestamp values so it
  // exactly matches PostgreSQL to_jsonb(balance_grants) without JS Number
  // coercion.
  const proof = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO "balance_ledger_grant_creation_repairs" (
      "id", "operation_key", "repair_kind", "run_id", "repair_account_id",
      "billing_account_id", "balance_transaction_id", "balance_grant_id",
      "idempotency_key", "idempotency_scope", "idempotency_snapshot",
      "transaction_snapshot", "grant_snapshot"
    )
    SELECT ${randomUUID()}, ${`repair:admin-recharge-grant:${runId}:${plan.transactionId}`},
      ${ADMIN_GRANT_REPAIR_KIND}, ${runId}, ${targetRepairAccountId},
      ${plan.billingAccountId}, transaction_row."id", ${plan.grantId},
      idempotency."key", idempotency."scope", to_jsonb(idempotency),
      to_jsonb(transaction_row), jsonb_build_object(
        'id', ${plan.grantId}, 'user_id', ${plan.userId}, 'tenant_id', ${plan.tenantId},
        'billing_account_id', ${plan.billingAccountId}, 'order_id', NULL,
        'product_id', ${plan.productId}::TEXT, 'source', 'RECHARGE',
        'paid_amount_usd', ${plan.amountUsd}::NUMERIC, 'bonus_amount_usd', 0::NUMERIC,
        'granted_amount_usd', ${plan.amountUsd}::NUMERIC,
        'remaining_amount_usd', ${plan.amountUsd}::NUMERIC,
        'remaining_paid_amount_usd', ${plan.amountUsd}::NUMERIC,
        'remaining_bonus_amount_usd', 0::NUMERIC, 'discount_rate', 1::NUMERIC,
        'valid_from', ${plan.validFrom}::TIMESTAMP(3),
        'expires_at', ${plan.expiresAt}::TIMESTAMP(3), 'is_expired', FALSE,
        'created_at', ${plan.createdAt}::TIMESTAMP(3),
        'updated_at', ${plan.createdAt}::TIMESTAMP(3)
      )
    FROM "balance_transactions" transaction_row
    JOIN "idempotency_keys" idempotency
      ON idempotency."key" = ${plan.idempotencyKey}
      AND idempotency."scope" = ${plan.idempotencyScope}
    WHERE transaction_row."id" = ${plan.transactionId}
      AND transaction_row."billing_account_id" = ${plan.billingAccountId}
      AND encode(sha256(convert_to(to_jsonb(idempotency)::TEXT, 'UTF8')), 'hex')
        = ${plan.idempotencySnapshotSha256}
    RETURNING "id"`;
  if (proof.length !== 1) throw new Error(`STALE_ADMIN_GRANT_PROOF:${plan.transactionId}`);
  const inserted = await tx.$queryRaw<Array<{ id: string }>>`
    INSERT INTO "balance_grants" (
      "id", "user_id", "tenant_id", "billing_account_id", "order_id", "product_id",
      "source", "paid_amount_usd", "bonus_amount_usd", "granted_amount_usd",
      "remaining_amount_usd", "remaining_paid_amount_usd", "remaining_bonus_amount_usd",
      "discount_rate", "valid_from", "expires_at", "is_expired", "created_at", "updated_at"
    ) VALUES (
      ${plan.grantId}, ${plan.userId}, ${plan.tenantId}, ${plan.billingAccountId}, NULL,
      ${plan.productId}::TEXT, 'RECHARGE', ${plan.amountUsd}::NUMERIC, 0,
      ${plan.amountUsd}::NUMERIC, ${plan.amountUsd}::NUMERIC,
      ${plan.amountUsd}::NUMERIC, 0, 1, ${plan.validFrom}::TIMESTAMP(3),
      ${plan.expiresAt}::TIMESTAMP(3), FALSE, ${plan.createdAt}::TIMESTAMP(3),
      ${plan.createdAt}::TIMESTAMP(3)
    ) RETURNING "id"`;
  if (inserted.length !== 1) throw new Error(`ADMIN_GRANT_INSERT_FAILED:${plan.grantId}`);
}

async function lockEnterpriseAbsorbPair(
  tx: Prisma.TransactionClient,
  plan: ReadyEnterpriseAbsorbPairPlan,
): Promise<void> {
  const accountIds = [plan.sourceBillingAccountId, plan.targetBillingAccountId].sort();
  await tx.$queryRaw`
    SELECT wallet."billing_account_id" FROM "account_wallets" wallet
    WHERE wallet."billing_account_id" IN (${Prisma.join(accountIds)})
    ORDER BY wallet."billing_account_id" FOR UPDATE`;
  await tx.$queryRaw`
    SELECT grant_row."id" FROM "balance_grants" grant_row
    WHERE grant_row."billing_account_id" IN (${Prisma.join(accountIds)})
       OR grant_row."id" IN (
         SELECT allocation."balance_grant_id" FROM "balance_consumption_allocations" allocation
         WHERE allocation."billing_account_id" IN (${Prisma.join(accountIds)})
           AND allocation."balance_grant_id" IS NOT NULL
       )
       OR grant_row."order_id" IN (
         SELECT moved_grant."order_id" FROM "balance_grants" moved_grant
         WHERE moved_grant."id" IN (${Prisma.join(plan.transferGrants.map((grant) => grant.grantId))})
           AND moved_grant."order_id" IS NOT NULL
       )
    ORDER BY grant_row."id" FOR UPDATE`;
  await tx.$queryRaw`
    SELECT transaction_row."id" FROM "balance_transactions" transaction_row
    WHERE transaction_row."billing_account_id" IN (${Prisma.join(accountIds)})
       OR transaction_row."order_id" IN (
         SELECT moved_grant."order_id" FROM "balance_grants" moved_grant
         WHERE moved_grant."id" IN (${Prisma.join(plan.transferGrants.map((grant) => grant.grantId))})
           AND moved_grant."order_id" IS NOT NULL
       )
    ORDER BY transaction_row."id" FOR UPDATE`;
  await tx.$queryRaw`
    SELECT allocation."id" FROM "balance_consumption_allocations" allocation
    WHERE allocation."billing_account_id" IN (${Prisma.join(accountIds)})
       OR allocation."balance_grant_id" IN (${Prisma.join(plan.transferGrants.map((grant) => grant.grantId))})
       OR allocation."balance_transaction_id" IN (
         SELECT transaction_row."id" FROM "balance_transactions" transaction_row
         WHERE transaction_row."billing_account_id" IN (${Prisma.join(accountIds)})
       )
    ORDER BY allocation."id" FOR UPDATE`;
  await tx.$queryRaw`
    SELECT settlement."id" FROM "enterprise_credit_settlements" settlement
    WHERE settlement."billing_account_id" IN (${Prisma.join(accountIds)})
       OR settlement."balance_grant_id" IN (
         ${Prisma.join(plan.transferGrants.map((grant) => grant.grantId))}
       )
       OR settlement."repayment_transaction_id" IN (
         SELECT transaction_row."id" FROM "balance_transactions" transaction_row
         WHERE transaction_row."billing_account_id" IN (${Prisma.join(accountIds)})
       )
       OR settlement."allocation_id" IN (
         SELECT allocation."id" FROM "balance_consumption_allocations" allocation
         WHERE allocation."billing_account_id" IN (${Prisma.join(accountIds)})
            OR allocation."balance_grant_id" IN (
              ${Prisma.join(plan.transferGrants.map((grant) => grant.grantId))}
            )
            OR allocation."balance_transaction_id" IN (
              SELECT transaction_row."id" FROM "balance_transactions" transaction_row
              WHERE transaction_row."billing_account_id" IN (${Prisma.join(accountIds)})
            )
       )
    ORDER BY settlement."id" FOR UPDATE`;
  await tx.$queryRaw`
    SELECT account."id" FROM "billing_accounts" account
    WHERE account."id" IN (${Prisma.join(accountIds)})
    ORDER BY account."id" FOR UPDATE`;
  await tx.$queryRaw`
    SELECT order_row."id" FROM "orders" order_row
    WHERE order_row."id" IN (
      SELECT grant_row."order_id" FROM "balance_grants" grant_row
      WHERE grant_row."id" IN (${Prisma.join(plan.transferGrants.map((grant) => grant.grantId))})
        AND grant_row."order_id" IS NOT NULL
    ) ORDER BY order_row."id" FOR SHARE`;
  await tx.$queryRaw`
    SELECT application."id" FROM "invoice_applications" application
    WHERE EXISTS (
      SELECT 1 FROM "invoice_application_items" item
      JOIN "balance_grants" grant_row ON grant_row."order_id" = item."order_id"
      WHERE item."application_id" = application."id"
        AND grant_row."id" IN (${Prisma.join(plan.transferGrants.map((grant) => grant.grantId))})
    ) ORDER BY application."id" FOR SHARE`;
  await tx.$queryRaw`
    SELECT item."id" FROM "invoice_application_items" item
    JOIN "balance_grants" grant_row ON grant_row."order_id" = item."order_id"
    WHERE grant_row."id" IN (${Prisma.join(plan.transferGrants.map((grant) => grant.grantId))})
    ORDER BY item."id" FOR SHARE OF item`;
  await tx.$queryRaw`
    SELECT event."id" FROM "invoice_event_log" event
    WHERE event."application_id" IN (
      SELECT item."application_id" FROM "invoice_application_items" item
      JOIN "balance_grants" grant_row ON grant_row."order_id" = item."order_id"
      WHERE grant_row."id" IN (${Prisma.join(plan.transferGrants.map((grant) => grant.grantId))})
    ) ORDER BY event."id" FOR SHARE`;
  await tx.$queryRaw`
    SELECT idempotency."key" FROM "idempotency_keys" idempotency
    WHERE (idempotency."key", idempotency."scope") IN (
      ${Prisma.join(plan.adminGrantCreations.map((grant) => (
        Prisma.sql`(${grant.idempotencyKey}, ${grant.idempotencyScope})`
      )))}
    ) ORDER BY idempotency."key", idempotency."scope" FOR SHARE`;
}

type PairPostconditionRow = {
  billingAccountId: string;
  walletUsd: Prisma.Decimal;
  activeGrantUsd: Prisma.Decimal;
  openDebtUsd: Prisma.Decimal;
  tailId: string;
  tailUsd: Prisma.Decimal;
  settlementCount: bigint;
  transactionRepairCount: bigint;
  grantComponentRepairCount: bigint;
  allocationRepairCount: bigint;
};

async function loadPairPostconditions(
  tx: Prisma.TransactionClient,
  runId: string,
  accountIds: string[],
  financialNow: Date,
): Promise<PairPostconditionRow[]> {
  return tx.$queryRaw<Array<PairPostconditionRow>>`
    SELECT account."id" AS "billingAccountId", wallet."balance_usd" AS "walletUsd",
      COALESCE((
        SELECT SUM(grant_row."remaining_amount_usd") FROM "balance_grants" grant_row
        WHERE grant_row."billing_account_id" = account."id"
          AND NOT grant_row."is_expired"
          AND grant_row."valid_from" <= ${financialNow}
          AND (grant_row."expires_at" IS NULL OR grant_row."expires_at" > ${financialNow})
      ), 0) AS "activeGrantUsd",
      COALESCE((
        SELECT SUM(allocation."amount_usd" - allocation."settled_usd")
        FROM "balance_consumption_allocations" allocation
        WHERE allocation."billing_account_id" = account."id"
          AND allocation."source" = CASE WHEN account."type" = 'enterprise'
            THEN 'ENTERPRISE_CREDIT' ELSE 'NEGATIVE_BALANCE' END
      ), 0) AS "openDebtUsd",
      tail."id" AS "tailId", tail."balance_after_usd" AS "tailUsd",
      (SELECT COUNT(*) FROM "enterprise_credit_settlements" settlement
        WHERE settlement."billing_account_id" = account."id") AS "settlementCount",
      (SELECT COUNT(*) FROM "balance_ledger_transaction_repairs" repair
        WHERE repair."run_id" = ${runId} AND repair."billing_account_id" = account."id")
        AS "transactionRepairCount",
      (SELECT COUNT(*) FROM "balance_ledger_grant_component_repairs" repair
        WHERE repair."run_id" = ${runId} AND repair."billing_account_id" = account."id")
        AS "grantComponentRepairCount",
      (SELECT COUNT(*) FROM "balance_ledger_allocation_repairs" repair
        WHERE repair."run_id" = ${runId} AND repair."billing_account_id" = account."id")
        AS "allocationRepairCount"
    FROM "billing_accounts" account
    JOIN "account_wallets" wallet ON wallet."billing_account_id" = account."id"
    JOIN LATERAL (
      SELECT transaction_row."id", transaction_row."balance_after_usd"
      FROM "balance_transactions" transaction_row
      WHERE transaction_row."billing_account_id" = account."id"
      ORDER BY transaction_row."ledger_sequence" DESC LIMIT 1
    ) tail ON TRUE
    WHERE account."id" IN (${Prisma.join(accountIds)})
    ORDER BY account."id"`;
}

function buildPairAfterSnapshot(
  account: EnterpriseAbsorbAccountPlan,
  pairPlan: ReadyEnterpriseAbsorbPairPlan,
  postcondition: PairPostconditionRow,
  reconciledAt: Date,
): Prisma.InputJsonValue {
  return repairAuditJson({
    repairKind: REPAIR_KIND,
    pairReplayHash: pairPlan.pairReplayHash,
    transferProofHash: pairPlan.transferProofHash,
    accountType: account.accountType,
    preconditionHash: account.preconditionHash,
    replayHash: account.replayHash,
    walletBalanceUsd: money(postcondition.walletUsd),
    activeGrantUsd: money(postcondition.activeGrantUsd),
    openDebtUsd: money(postcondition.openDebtUsd),
    transactionTailId: postcondition.tailId,
    transactionTailUsd: money(postcondition.tailUsd),
    settlementCount: postcondition.settlementCount.toString(),
    transactionRepairCount: postcondition.transactionRepairCount.toString(),
    grantComponentRepairCount: postcondition.grantComponentRepairCount.toString(),
    allocationRepairCount: postcondition.allocationRepairCount.toString(),
    transactionSequenceMutations: account.transactionSequenceMutations,
    grantMutations: account.grantMutations,
    allocationMutations: account.allocationMutations,
    transfer: pairPlan.transfer,
    transferGrants: pairPlan.transferGrants,
    adminGrantCreations: account.accountType === 'enterprise'
      ? pairPlan.adminGrantCreations
      : [],
    ledgerStatus: 'RECONCILED_V2',
    ledgerVersion: 2,
    reconciledAt: reconciledAt.toISOString(),
    throughTransactionId: account.throughTransactionId,
  });
}

async function applyReadyEnterpriseAbsorbPair(
  runId: string,
  approvedPlan: ReadyEnterpriseAbsorbPairPlan,
  databaseBinding: RepairDatabaseBinding,
): Promise<void> {
  await prisma.$transaction(async (tx) => {
    await loadRepairDatabaseBinding(tx, databaseBinding);
    await lockEnterpriseAbsorbPair(tx, approvedPlan);
    const lockedSnapshot = await loadEnterpriseAbsorbPairSnapshot(
      tx, approvedPlan.sourceBillingAccountId, approvedPlan.targetBillingAccountId,
    );
    const rebuilt = buildEnterpriseAbsorbPairPlan(lockedSnapshot);
    if (
      rebuilt.status !== 'READY_PAIR'
      || rebuilt.preconditionHash !== approvedPlan.preconditionHash
      || rebuilt.transferProofHash !== approvedPlan.transferProofHash
      || rebuilt.pairReplayHash !== approvedPlan.pairReplayHash
      || rebuilt.source.replayHash !== approvedPlan.source.replayHash
      || rebuilt.target.replayHash !== approvedPlan.target.replayHash
    ) throw new Error('PAIR_PLAN_STALE_AFTER_LOCK');

    const sourceRepair = await tx.balanceLedgerRepairAccount.create({
      data: {
        runId,
        billingAccountId: rebuilt.sourceBillingAccountId,
        status: 'RUNNING',
        preconditionHash: rebuilt.source.preconditionHash,
        replayHash: rebuilt.source.replayHash,
        beforeSnapshot: repairAuditJson(lockedSnapshot),
      },
    });
    const targetRepair = await tx.balanceLedgerRepairAccount.create({
      data: {
        runId,
        billingAccountId: rebuilt.targetBillingAccountId,
        status: 'RUNNING',
        preconditionHash: rebuilt.target.preconditionHash,
        replayHash: rebuilt.target.replayHash,
        beforeSnapshot: repairAuditJson(lockedSnapshot),
      },
    });
    await tx.$executeRaw`SELECT set_config('billing.balance_ledger_repair_run_id', ${runId}, TRUE)`;
    await tx.$executeRaw`SELECT set_config(
      'billing.balance_financial_now', ${lockedSnapshot.financialNow}, TRUE
    )`;

    // Capture tuple xmin and both immutable transaction images before any
    // ledger_sequence update changes either tuple version.
    const transferRepairId = await insertTransferParentProof(
      tx, runId, sourceRepair.id, targetRepair.id, rebuilt,
    );
    await insertTransferGrantProofs(tx, runId, transferRepairId, rebuilt);
    for (const grant of rebuilt.adminGrantCreations) {
      await insertAdminGrantCreationProofAndGrant(tx, runId, targetRepair.id, grant);
    }

    for (const accountPlan of [rebuilt.source, rebuilt.target]) {
      const repairAccountId = accountPlan.accountType === 'personal'
        ? sourceRepair.id : targetRepair.id;
      await applyPairTransactionSequenceMutationsSetBased(
        tx,
        runId,
        repairAccountId,
        accountPlan.billingAccountId,
        accountPlan.transactionSequenceMutations,
      );
      for (const mutation of accountPlan.grantMutations) {
        await registerPairGrantComponentAudit(
          tx, runId, repairAccountId, accountPlan.billingAccountId, mutation,
        );
        // Use raw SQL deliberately: Prisma's @updatedAt behavior would rewrite
        // updated_at and destroy the exact legacy before/after component proof.
        const updated = await tx.$queryRaw<Array<{ id: string }>>`
          UPDATE "balance_grants"
          SET "remaining_paid_amount_usd" = ${mutation.remainingPaidAmountUsd}::NUMERIC,
            "remaining_bonus_amount_usd" = ${mutation.remainingBonusAmountUsd}::NUMERIC
          WHERE "id" = ${mutation.grantId}
            AND "billing_account_id" = ${accountPlan.billingAccountId}
            AND "remaining_amount_usd" = ${mutation.expectedRemainingAmountUsd}::NUMERIC
            AND "remaining_paid_amount_usd" IS NOT DISTINCT FROM
              ${mutation.expectedRemainingPaidAmountUsd}::NUMERIC
            AND "remaining_bonus_amount_usd" IS NOT DISTINCT FROM
              ${mutation.expectedRemainingBonusAmountUsd}::NUMERIC
            AND "remaining_amount_usd" = ${mutation.remainingAmountUsd}::NUMERIC
          RETURNING "id"`;
        if (updated.length !== 1) throw new Error(`STALE_GRANT:${mutation.grantId}`);
      }
      await applyPairAllocationMutationsSetBased(
        tx,
        runId,
        repairAccountId,
        accountPlan.billingAccountId,
        accountPlan.allocationMutations,
      );
    }

    // Drain the high-cardinality canonical row callbacks while both accounts
    // are still LEGACY_DIRTY. The constraints are executed, not disabled: the
    // existing dirty-account branch returns before pair-wide validation. Then
    // re-arm them as DEFERRED so any unexpected later row mutation is queued
    // for the final drain. The explicit assertion, terminal proof triggers,
    // clean-promotion triggers, and final SET CONSTRAINTS ALL below still
    // validate the complete clean pair inside this same atomic transaction.
    await flushEnterpriseAbsorbCanonicalConstraintsWhileLegacyDirty(tx);

    await tx.$executeRaw`
      SELECT "assert_balance_enterprise_absorb_pair_repair"(
        ${runId}, ${rebuilt.sourceBillingAccountId}, ${rebuilt.targetBillingAccountId}
      )`;
    const accountIds = [rebuilt.sourceBillingAccountId, rebuilt.targetBillingAccountId].sort();
    const reconciledAt = new Date(lockedSnapshot.financialNow);
    const postconditions = await loadPairPostconditions(tx, runId, accountIds, reconciledAt);
    if (postconditions.length !== 2) throw new Error('PAIR_POSTCONDITION_ACCOUNT_MISSING');
    for (const accountPlan of [rebuilt.source, rebuilt.target]) {
      const postcondition = postconditions.find((row) => row.billingAccountId === accountPlan.billingAccountId);
      if (
        !postcondition
        || !decimal(postcondition.walletUsd).eq(accountPlan.walletBalanceUsd)
        || !decimal(postcondition.activeGrantUsd).minus(postcondition.openDebtUsd)
          .eq(postcondition.walletUsd)
        || postcondition.tailId !== accountPlan.throughTransactionId
        || !decimal(postcondition.tailUsd).eq(postcondition.walletUsd)
        || postcondition.settlementCount !== BigInt(accountPlan.expectedSettlementCount)
        || postcondition.transactionRepairCount
          !== BigInt(accountPlan.transactionSequenceMutations.length)
        || postcondition.grantComponentRepairCount !== BigInt(accountPlan.grantMutations.length)
        || postcondition.allocationRepairCount !== BigInt(accountPlan.allocationMutations.length)
      ) throw new Error(`PAIR_POSTCONDITION_FAILED:${accountPlan.billingAccountId}`);
    }

    const markerUpdateCount = await tx.$executeRaw`
      UPDATE "billing_accounts"
      SET "balance_grant_ledger_status" = 'RECONCILED_V2',
        "balance_grant_ledger_version" = 2,
        "balance_grant_ledger_hash" = CASE "id"
          WHEN ${rebuilt.sourceBillingAccountId} THEN ${rebuilt.source.replayHash}
          WHEN ${rebuilt.targetBillingAccountId} THEN ${rebuilt.target.replayHash}
        END,
        "balance_grant_ledger_reconciled_at" = ${reconciledAt},
        "balance_grant_ledger_dirty_reason" = NULL,
        "balance_grant_ledger_through_transaction_id" = CASE "id"
          WHEN ${rebuilt.sourceBillingAccountId} THEN ${rebuilt.source.throughTransactionId}
          WHEN ${rebuilt.targetBillingAccountId} THEN ${rebuilt.target.throughTransactionId}
        END
      WHERE "id" IN (${Prisma.join(accountIds)})
        AND "balance_grant_ledger_status" = 'LEGACY_DIRTY'`;
    if (markerUpdateCount !== 2) throw new Error('PAIR_MARKER_UPDATE_STALE');

    for (const [repair, accountPlan] of [
      [sourceRepair, rebuilt.source],
      [targetRepair, rebuilt.target],
    ] as const) {
      const postcondition = postconditions.find((row) => row.billingAccountId === accountPlan.billingAccountId)!;
      const updated = await tx.balanceLedgerRepairAccount.updateMany({
        where: {
          id: repair.id,
          runId,
          billingAccountId: accountPlan.billingAccountId,
          status: 'RUNNING',
          preconditionHash: accountPlan.preconditionHash,
          replayHash: accountPlan.replayHash,
        },
        data: {
          status: 'APPLIED',
          afterSnapshot: buildPairAfterSnapshot(accountPlan, rebuilt, postcondition, reconciledAt),
          error: null,
        },
      });
      if (updated.count !== 1) throw new Error(`PAIR_REPAIR_AUDIT_STALE:${accountPlan.billingAccountId}`);
    }
    // Both marker rows and both terminal account audits are now visible. Force
    // all deferred financial constraints inside this same atomic transaction.
    await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 10_000,
    timeout: 180_000,
  });
}

const VALUE_OPTIONS = new Set([
  '--source-billing-account-id',
  '--target-billing-account-id',
  '--output-jsonl',
  '--plan-file',
  '--plan-sha256',
  '--confirm-database-name',
  '--confirm-database-identity',
  '--resume-run-id',
  '--initiated-by',
]);
const FLAG_OPTIONS = new Set(['--apply']);

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function validateArguments(): void {
  const args = process.argv.slice(2);
  const seen = new Set<string>();
  for (let index = 0; index < args.length; index += 1) {
    const argument = args[index];
    if (seen.has(argument)) throw new Error(`duplicate option: ${argument}`);
    if (FLAG_OPTIONS.has(argument)) {
      seen.add(argument);
      continue;
    }
    if (!VALUE_OPTIONS.has(argument)) throw new Error(`unknown or positional argument: ${argument}`);
    const value = args[index + 1];
    if (value === undefined || value.trim() === '' || value.startsWith('--')) {
      throw new Error(`${argument} requires one non-empty value`);
    }
    seen.add(argument);
    index += 1;
  }
}

function sameDatabaseBinding(left: RepairDatabaseBinding, right: RepairDatabaseBinding): boolean {
  return left.databaseName === right.databaseName
    && left.databaseIdentity === right.databaseIdentity
    && left.databaseSystemIdentifier === right.databaseSystemIdentifier
    && left.databaseOid === right.databaseOid
    && left.phase === right.phase;
}

async function dryRun(): Promise<void> {
  const sourceBillingAccountId = option('--source-billing-account-id');
  const targetBillingAccountId = option('--target-billing-account-id');
  if (!sourceBillingAccountId || !targetBillingAccountId) {
    throw new Error('dry-run requires --source-billing-account-id and --target-billing-account-id');
  }
  const { binding, snapshot } = await prisma.$transaction(async (tx) => ({
    binding: await loadRepairDatabaseBinding(tx),
    snapshot: await loadEnterpriseAbsorbPairSnapshot(
      tx, sourceBillingAccountId, targetBillingAccountId,
    ),
  }), {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 10_000,
    timeout: 180_000,
  });
  const manifest: RepairPlanManifest = {
    recordType: PLAN_FORMAT,
    ...binding,
    endpointSha256: enterpriseAbsorbDatabaseEndpointSha256(),
  };
  const plan = buildEnterpriseAbsorbPairPlan(snapshot);
  const jsonl = `${JSON.stringify(manifest)}\n${JSON.stringify(plan)}\n`;
  const outputPath = option('--output-jsonl');
  if (outputPath) writeFileSync(outputPath, jsonl, { encoding: 'utf8', flag: 'wx' });
  else process.stdout.write(jsonl);
  console.error(JSON.stringify({
    mode: 'dry-run',
    status: plan.status,
    sourceBillingAccountId,
    targetBillingAccountId,
    outputPath: outputPath ?? null,
    planSha256: enterpriseAbsorbSha256(jsonl),
    reasons: plan.status === 'QUARANTINED_PAIR' ? plan.reasons : [],
  }));
}

function isSerializationFailure(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return code === 'P2034' || message.includes('40001') || /serialization/i.test(message);
}

function isUnknownCommitOutcome(error: unknown): boolean {
  const code = (error as { code?: unknown } | null)?.code;
  const message = error instanceof Error ? error.message : String(error);
  return code === 'P1001'
    || code === 'P1017'
    || code === 'P2028'
    || /connection|socket|ECONN|closed the connection|server closed|connection reset/i.test(message);
}

async function committedPairProofExists(
  runId: string,
  plan: ReadyEnterpriseAbsorbPairPlan,
  binding: RepairDatabaseBinding,
): Promise<boolean> {
  return prisma.$transaction(async (tx) => {
    await loadRepairDatabaseBinding(tx, binding);
    const [row] = await tx.$queryRaw<Array<{
      proofCount: bigint;
      grantProofCount: bigint;
      adminProofCount: bigint;
      grantComponentProofCount: bigint;
      sourceAuditApplied: boolean;
      targetAuditApplied: boolean;
      sourceClean: boolean;
      targetClean: boolean;
    }>>`
      SELECT
        (SELECT COUNT(*) FROM "balance_ledger_account_transfer_repairs" proof
          WHERE proof."run_id" = ${runId}
            AND proof."source_billing_account_id" = ${plan.sourceBillingAccountId}
            AND proof."target_billing_account_id" = ${plan.targetBillingAccountId}
            AND proof."out_transaction_id" = ${plan.transfer.outTransactionId}
            AND proof."in_transaction_id" = ${plan.transfer.inTransactionId}) AS "proofCount",
        (SELECT COUNT(*) FROM "balance_ledger_account_transfer_grants" grant_proof
          JOIN "balance_ledger_account_transfer_repairs" proof
            ON proof."id" = grant_proof."transfer_repair_id"
          WHERE proof."run_id" = ${runId}) AS "grantProofCount",
        (SELECT COUNT(*) FROM "balance_ledger_grant_creation_repairs" creation
          WHERE creation."run_id" = ${runId}) AS "adminProofCount",
        (SELECT COUNT(*) FROM "balance_ledger_grant_component_repairs" component
          WHERE component."run_id" = ${runId}) AS "grantComponentProofCount",
        EXISTS (SELECT 1 FROM "balance_ledger_repair_accounts" repair
          WHERE repair."run_id" = ${runId}
            AND repair."billing_account_id" = ${plan.sourceBillingAccountId}
            AND repair."status" = 'APPLIED'
            AND repair."replay_hash" = ${plan.source.replayHash}) AS "sourceAuditApplied",
        EXISTS (SELECT 1 FROM "balance_ledger_repair_accounts" repair
          WHERE repair."run_id" = ${runId}
            AND repair."billing_account_id" = ${plan.targetBillingAccountId}
            AND repair."status" = 'APPLIED'
            AND repair."replay_hash" = ${plan.target.replayHash}) AS "targetAuditApplied",
        EXISTS (SELECT 1 FROM "billing_accounts" account
          WHERE account."id" = ${plan.sourceBillingAccountId}
            AND account."balance_grant_ledger_status" = 'RECONCILED_V2'
            AND account."balance_grant_ledger_hash" = ${plan.source.replayHash}) AS "sourceClean",
        EXISTS (SELECT 1 FROM "billing_accounts" account
          WHERE account."id" = ${plan.targetBillingAccountId}
            AND account."balance_grant_ledger_status" = 'RECONCILED_V2'
            AND account."balance_grant_ledger_hash" = ${plan.target.replayHash}) AS "targetClean"`;
    return row?.proofCount === BigInt(1)
      && row.grantProofCount === BigInt(plan.transferGrants.length)
      && row.adminProofCount === BigInt(plan.adminGrantCreations.length)
      && row.grantComponentProofCount
        === BigInt(plan.source.grantMutations.length + plan.target.grantMutations.length)
      && row.sourceAuditApplied
      && row.targetAuditApplied
      && row.sourceClean
      && row.targetClean;
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 10_000,
    timeout: 30_000,
  });
}

async function applyWithRetry(
  runId: string,
  plan: ReadyEnterpriseAbsorbPairPlan,
  binding: RepairDatabaseBinding,
): Promise<void> {
  for (let attempt = 1; attempt <= 3; attempt += 1) {
    try {
      await applyReadyEnterpriseAbsorbPair(runId, plan, binding);
      return;
    } catch (error) {
      if (!isSerializationFailure(error) || attempt === 3) throw error;
    }
  }
}

async function applyPlan(): Promise<void> {
  const planFile = option('--plan-file');
  const expectedPlanSha256 = option('--plan-sha256');
  const confirmedDatabaseName = option('--confirm-database-name');
  const confirmedDatabaseIdentity = option('--confirm-database-identity');
  if (!planFile || !expectedPlanSha256 || !confirmedDatabaseName || !confirmedDatabaseIdentity) {
    throw new Error(
      '--apply requires --plan-file, --plan-sha256, --confirm-database-name and --confirm-database-identity',
    );
  }
  if (!isLowerSha256(expectedPlanSha256)) {
    throw new Error('--plan-sha256 must be exactly 64 lowercase hexadecimal characters');
  }
  const raw = readFileSync(planFile, 'utf8');
  const actualPlanSha256 = enterpriseAbsorbSha256(raw);
  if (actualPlanSha256 !== expectedPlanSha256) {
    throw new Error(`plan SHA-256 mismatch expected=${expectedPlanSha256} actual=${actualPlanSha256}`);
  }
  const { manifest, plan } = parseEnterpriseAbsorbPlanFile(raw);
  if (plan.status !== 'READY_PAIR') throw new Error('cannot apply a quarantined pair plan');
  if (
    manifest.databaseName !== confirmedDatabaseName
    || manifest.databaseIdentity !== confirmedDatabaseIdentity
  ) throw new Error('database confirmation does not exactly match the signed plan manifest');
  if (manifest.endpointSha256 !== enterpriseAbsorbDatabaseEndpointSha256()) {
    throw new Error('DATABASE_BINDING_MISMATCH:database endpoint differs from plan manifest');
  }
  const binding = await prisma.$transaction(
    (tx) => loadRepairDatabaseBinding(tx, manifest),
    {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 30_000,
    },
  );
  if (!sameDatabaseBinding(binding, manifest)) {
    throw new Error('DATABASE_BINDING_MISMATCH:physical database locator differs from manifest');
  }
  const resumeRunId = option('--resume-run-id');
  const run = await prisma.$transaction(async (tx) => {
    await loadRepairDatabaseBinding(tx, binding);
    return resumeRunId
      ? tx.balanceLedgerRepairRun.findUniqueOrThrow({ where: { id: resumeRunId } })
      : tx.balanceLedgerRepairRun.create({
          data: {
            status: 'RUNNING',
            planHash: actualPlanSha256,
            initiatedBy: option('--initiated-by') ?? null,
          },
        });
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 10_000,
    timeout: 30_000,
  });
  if (run.planHash !== actualPlanSha256) throw new Error('resume run plan hash mismatch');
  if (await committedPairProofExists(run.id, plan, binding)) {
    if (run.status === 'RUNNING') {
      await prisma.balanceLedgerRepairRun.update({
        where: { id: run.id },
        data: { status: 'COMPLETED', completedAt: new Date() },
      });
    } else if (run.status !== 'COMPLETED') {
      throw new Error(`PAIR_TERMINAL_RUN_STATUS_MISMATCH:${run.status}`);
    }
    console.log(JSON.stringify({ mode: 'apply', runId: run.id, status: 'APPLIED' }));
    return;
  }
  if (run.status !== 'RUNNING') throw new Error(`TERMINAL_RUN_PAIR_PROOF_MISSING:${run.id}`);
  try {
    await applyWithRetry(run.id, plan, binding);
  } catch (error) {
    if (
      isUnknownCommitOutcome(error)
      && await committedPairProofExists(run.id, plan, binding)
    ) {
      // The database proof is authoritative after a connection-uncertain commit.
    } else {
      throw error;
    }
  }
  if (!await committedPairProofExists(run.id, plan, binding)) {
    throw new Error('PAIR_APPLY_COMMITTED_PROOF_MISSING');
  }
  await prisma.balanceLedgerRepairRun.update({
    where: { id: run.id },
    data: { status: 'COMPLETED', completedAt: new Date() },
  });
  console.log(JSON.stringify({ mode: 'apply', runId: run.id, status: 'APPLIED' }));
}

async function main(): Promise<void> {
  validateArguments();
  if (has('--apply')) await applyPlan();
  else await dryRun();
}

if (require.main === module) {
  main()
    .catch((error) => {
      console.error(error);
      process.exitCode = 1;
    })
    .finally(() => prisma.$disconnect());
}
