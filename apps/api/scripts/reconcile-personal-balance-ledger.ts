import { createHash, randomUUID } from 'node:crypto';
import { readFileSync, writeFileSync } from 'node:fs';
import { Prisma, PrismaClient } from '@prisma/client';
import {
  BalanceLedgerRepairPlan,
  BalanceLedgerRepairPlanningProfile,
  BalanceLedgerRepairSnapshot,
  balanceLedgerRepairReplayHash,
  buildBalanceLedgerRepairPlan,
} from '../src/billing/balance-ledger-repair';
import { POSTGRES_UTC_FINANCIAL_CLOCK } from '../src/billing/balance-financial-clock';

type Client = PrismaClient | Prisma.TransactionClient;

const prisma = new PrismaClient();

export const REPAIR_BEFORE_MANIFEST_VERSION = 'BALANCE_LEDGER_REPAIR_BEFORE_V1' as const;
export const REPAIR_FAILURE_MANIFEST_VERSION = 'BALANCE_LEDGER_REPAIR_FAILURE_V1' as const;
export const REPAIR_SNAPSHOT_HASH_ALGORITHM = 'sha256-stable-json-v1' as const;
export const MAX_REPAIR_BEFORE_JSON_BYTES = 16 * 1024 * 1024;
export const MAX_REPAIR_AFTER_JSON_BYTES = 192 * 1024 * 1024;
// Rows per staging upload chunk. 5_000 produced a 4,193,083 byte parameter JSON
// in the 2026-08-09 clone rehearsal -- 99.97% of BOUNDED_STAGE_MAX_JSON_BYTES,
// i.e. 1,221 bytes from BOUNDED_STAGE_MUTATION_TOO_LARGE. 2_000 lands near
// 1.7 MiB (~40% of the cap) so ordinary row-width growth cannot break staging.
export const BOUNDED_STAGE_MAX_ROWS = 2_000;
export const BOUNDED_STAGE_MAX_JSON_BYTES = 4 * 1024 * 1024;
// Per-statement batch size for staging-driven audit and update passes.
//
// 10_000 made each batch run 6-8s on a prod-spec db.r7g.large writer during the
// 2026-08-09 clone rehearsal -- only ~4x under the 30s statement_timeout below,
// across ~49 batches. The 2026-08-08 production apply of the 243,079 transaction
// account then lost one batch to SQLSTATE 57014 (statement timeout) right after
// audit registration, and the whole repair rolled back.
//
// 2_000 puts each batch near 1.2-1.6s (~80x margin under the raised 120s
// ceiling) at the cost of ~5x more batches. Total wall clock grows modestly and
// stays well inside GENERIC_REPAIR_TRANSACTION_TIMEOUT_MS.
// Do not raise this back without re-measuring the per-batch duration on a clone.
export const BOUNDED_MUTATION_BATCH_ROWS = 2_000;

// Generic repair and enterprise-absorb repair are both bounded, offline
// maintenance transactions over a complete locked ledger.  Large generic
// histories are written set-wise below, so this is a safety ceiling rather than
// a per-row throughput workaround.
//
// The budget intentionally no longer matches reconcile-enterprise-absorb-ledger
// (still 180_000): the 2026-08-09 production-clone rehearsal of the 243,079
// transaction / 243,076 allocation account measured 725s of in-transaction work
// before COMMIT on a prod-spec db.r7g.large writer:
//
//   locks 5.3s -> locked replan 36.3s -> staging 14.7s -> audit registration
//   267.0s -> transaction updates 116.1s -> allocation updates 280.2s ->
//   postcondition 3.7s -> terminal evidence 2.1s
//
// 180_000 aborts that account at ~187s with P2028 and rolls the whole repair
// back, so the largest legacy account could never be repaired.  BOUNDED_MUTATION
// _BATCH_ROWS was since lowered from 10_000 to 2_000, which lengthens the
// pre-COMMIT phases beyond the measured 725s, so the budget is 1_800_000 to keep
// roughly a 2x margin over the expected 800-900s.
//
// This ceiling only covers work up to COMMIT.  Prisma does not enforce the
// interactive-transaction timeout while the server is executing COMMIT, and
// PostgreSQL does not apply statement_timeout to commit-time constraint checks,
// so the deferred strict-trigger validation over ~486k rows (measured ~1,284s)
// is outside this budget and cannot be bounded from the client.  Treat a client
// timeout on such an account as UNKNOWN commit outcome and resolve it from the
// database terminal audit -- never by retrying.
export const GENERIC_REPAIR_TRANSACTION_TIMEOUT_MS = 1_800_000;
const GENERIC_REPAIR_TRANSACTION_OPTIONS = {
  isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
  maxWait: 10_000,
  timeout: GENERIC_REPAIR_TRANSACTION_TIMEOUT_MS,
} as const;

const VALUE_OPTIONS = new Set([
  '--account-type',
  '--billing-account-id',
  '--limit',
  '--cursor-after',
  '--output-jsonl',
  '--plan-file',
  '--plan-sha256',
  '--resume-run-id',
  '--initiated-by',
  '--confirm-database-name',
  '--confirm-database-identity',
  '--finance-approval-ref',
  '--technical-approval-ref',
  '--maintenance-profile',
]);
const FLAG_OPTIONS = new Set(['--apply']);

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
    if (!VALUE_OPTIONS.has(argument)) {
      throw new Error(`unknown or positional argument: ${argument}`);
    }
    const value = args[index + 1];
    if (value === undefined || value.trim() === '' || value.startsWith('--')) {
      throw new Error(`${argument} requires one non-empty value`);
    }
    seen.add(argument);
    index += 1;
  }
}

function option(name: string): string | undefined {
  const index = process.argv.indexOf(name);
  return index >= 0 ? process.argv[index + 1] : undefined;
}

function has(name: string): boolean {
  return process.argv.includes(name);
}

function positiveInt(value: string | undefined, fallback: number, max: number): number {
  const parsed = Number(value);
  return Number.isInteger(parsed) && parsed > 0 ? Math.min(parsed, max) : fallback;
}

function wait(milliseconds: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, milliseconds));
}

function sha256(value: string): string {
  return createHash('sha256').update(value).digest('hex');
}

// V9 adds an explicitly selected, single-account invoice-stability evidence
// profile to the V8 proof contracts. The profile is deliberately not bound to
// one environment, but every plan remains bound to the target database's
// physical identity and endpoint. Older plan envelopes must continue to fail
// closed and be regenerated from the target database.
const PLAN_FORMAT = 'BALANCE_LEDGER_REPAIR_PLAN_V9' as const;
const LEGACY_ADMIN_FUNDING_REPAIR_KIND = 'LEGACY_ENTERPRISE_ADMIN_FUNDING_V1' as const;
const HK_UAT_TWO_ACCOUNT_PROFILE = 'hk-uat-two-account-20260722' as const;
const HK_UAT_REMAINING_ACCOUNT_PROFILE = 'hk-uat-remaining-account-20260722' as const;
export const INVOICE_STABILITY_EVIDENCE_PROFILE = 'invoice-stability-evidence-v1' as const;

type MaintenanceProfileName =
  | typeof HK_UAT_TWO_ACCOUNT_PROFILE
  | typeof HK_UAT_REMAINING_ACCOUNT_PROFILE
  | typeof INVOICE_STABILITY_EVIDENCE_PROFILE;

function unreachableMaintenanceProfile(name: never): never {
  throw new Error(`unsupported maintenance profile: ${String(name)}`);
}

export type BalanceLedgerRepairExecutionProfile = {
  name: MaintenanceProfileName | null;
  expectedDatabase: Pick<RepairDatabaseBinding, 'databaseName' | 'databaseIdentity'> | null;
  billingAccountIds: readonly string[] | null;
  planningProfile: BalanceLedgerRepairPlanningProfile;
};

const DEFAULT_EXECUTION_PROFILE: BalanceLedgerRepairExecutionProfile = {
  name: null,
  expectedDatabase: null,
  billingAccountIds: null,
  planningProfile: {
    allowLegacyExpiryProofs: false,
    allowLegacyExpiredVoucherProofs: false,
    allowInvoiceStabilityProof: false,
  },
};

const HK_UAT_EXPECTED_DATABASE = {
  databaseName: 'ruidong_billing',
  databaseIdentity: '940d3ca6-2513-47cd-9e95-f0e9b5f79225',
} as const;

const HK_UAT_PLANNING_PROFILE = {
  allowLegacyExpiryProofs: true,
  allowLegacyExpiredVoucherProofs: true,
  allowInvoiceStabilityProof: true,
} as const satisfies BalanceLedgerRepairPlanningProfile;

const HK_UAT_TWO_ACCOUNT_EXECUTION_PROFILE: BalanceLedgerRepairExecutionProfile = {
  name: HK_UAT_TWO_ACCOUNT_PROFILE,
  expectedDatabase: HK_UAT_EXPECTED_DATABASE,
  billingAccountIds: [
    'ba_personal_c912db97-626d-4d9c-9f8a-fec97cc3670f',
    'ba_personal_c9afd0f8-a0eb-42c9-a9ff-499fa1999b2d',
  ],
  planningProfile: HK_UAT_PLANNING_PROFILE,
};

const HK_UAT_REMAINING_ACCOUNT_EXECUTION_PROFILE: BalanceLedgerRepairExecutionProfile = {
  name: HK_UAT_REMAINING_ACCOUNT_PROFILE,
  expectedDatabase: HK_UAT_EXPECTED_DATABASE,
  billingAccountIds: [
    'ba_personal_c9afd0f8-a0eb-42c9-a9ff-499fa1999b2d',
  ],
  planningProfile: HK_UAT_PLANNING_PROFILE,
};

const INVOICE_STABILITY_EVIDENCE_EXECUTION_PROFILE: BalanceLedgerRepairExecutionProfile = {
  name: INVOICE_STABILITY_EVIDENCE_PROFILE,
  expectedDatabase: null,
  billingAccountIds: null,
  planningProfile: {
    allowLegacyExpiryProofs: false,
    allowLegacyExpiredVoucherProofs: false,
    allowInvoiceStabilityProof: true,
  },
};

export function resolveExecutionProfile(
  name: string | undefined,
): BalanceLedgerRepairExecutionProfile {
  if (name === undefined) return DEFAULT_EXECUTION_PROFILE;
  if (name === HK_UAT_TWO_ACCOUNT_PROFILE) return HK_UAT_TWO_ACCOUNT_EXECUTION_PROFILE;
  if (name === HK_UAT_REMAINING_ACCOUNT_PROFILE) {
    return HK_UAT_REMAINING_ACCOUNT_EXECUTION_PROFILE;
  }
  if (name === INVOICE_STABILITY_EVIDENCE_PROFILE) {
    return INVOICE_STABILITY_EVIDENCE_EXECUTION_PROFILE;
  }
  throw new Error(`unknown maintenance profile: ${name}`);
}

function executionProfile(): BalanceLedgerRepairExecutionProfile {
  return resolveExecutionProfile(option('--maintenance-profile'));
}

export type RepairAccountSelectors = {
  accountType?: string;
  billingAccountId?: string;
  limit?: string;
  cursorAfter?: string;
};

export function assertExecutionProfileSelectors(
  profile: BalanceLedgerRepairExecutionProfile,
  selectors: RepairAccountSelectors,
): void {
  const suppliedGenericSelectors = Object.values(selectors)
    .some((value) => value !== undefined);
  switch (profile.name) {
    case null:
      return;
    case INVOICE_STABILITY_EVIDENCE_PROFILE:
      if (selectors.billingAccountId === undefined) {
        throw new Error('invoice stability evidence profile requires --billing-account-id');
      }
      if (
        selectors.accountType !== undefined
        || selectors.limit !== undefined
        || selectors.cursorAfter !== undefined
      ) {
        throw new Error(
          'invoice stability evidence profile accepts only --billing-account-id as an account selector',
        );
      }
      return;
    case HK_UAT_TWO_ACCOUNT_PROFILE:
    case HK_UAT_REMAINING_ACCOUNT_PROFILE:
      if (suppliedGenericSelectors) {
        throw new Error('maintenance profile does not accept generic account selectors');
      }
      return;
    default:
      return unreachableMaintenanceProfile(profile.name);
  }
}

export function resolveRepairInitiator(
  profile: BalanceLedgerRepairExecutionProfile,
  initiatedBy: string | undefined,
): string | null {
  switch (profile.name) {
    case null:
    case HK_UAT_TWO_ACCOUNT_PROFILE:
    case HK_UAT_REMAINING_ACCOUNT_PROFILE:
      return initiatedBy ?? null;
    case INVOICE_STABILITY_EVIDENCE_PROFILE:
      break;
    default:
      return unreachableMaintenanceProfile(profile.name);
  }
  const normalized = initiatedBy?.trim() ?? '';
  if (normalized.length === 0 || normalized.length > 200) {
    throw new Error(
      'invoice stability evidence apply requires --initiated-by trimmed to 1..200 characters',
    );
  }
  return normalized;
}

export function assertResumeRunInitiator(
  profile: BalanceLedgerRepairExecutionProfile,
  requestedInitiatedBy: string | null,
  storedInitiatedBy: string | null,
): void {
  switch (profile.name) {
    case null:
    case HK_UAT_TWO_ACCOUNT_PROFILE:
    case HK_UAT_REMAINING_ACCOUNT_PROFILE:
      return;
    case INVOICE_STABILITY_EVIDENCE_PROFILE:
      if (storedInitiatedBy !== requestedInitiatedBy) {
        throw new Error(
          'resume run initiatedBy does not exactly match the original repair run',
        );
      }
      return;
    default:
      return unreachableMaintenanceProfile(profile.name);
  }
}

export type RepairDatabaseBinding = {
  databaseName: string;
  databaseIdentity: string;
  databaseSystemIdentifier: string;
  databaseOid: string;
  phase: 'V2_CONTRACT';
};

type RepairPlanManifest = RepairDatabaseBinding & {
  recordType: typeof PLAN_FORMAT;
  endpointSha256: string;
  maintenanceProfile: MaintenanceProfileName | null;
};

export function databaseEndpointSha256(): string {
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
  const canonical = JSON.stringify({
    protocol: 'postgresql:',
    hostname: endpoint.hostname.toLowerCase(),
    port: endpoint.port || '5432',
    pathname: endpoint.pathname,
    parameters: [...endpoint.searchParams.entries()].sort(([leftKey, leftValue], [rightKey, rightValue]) => (
      leftKey.localeCompare(rightKey) || leftValue.localeCompare(rightValue)
    )),
  });
  return sha256(canonical);
}

function decimal(value: Prisma.Decimal.Value): string {
  return new Prisma.Decimal(value).toFixed(12);
}

function voucherGrantIdFromDescription(description: string): string | null {
  return /^voucher:([^\s]+)\s+\S(?:.*\S)?$/.exec(description)?.[1] ?? null;
}

type AccountTypeFilter = 'personal' | 'enterprise' | 'all';

function accountTypeFilter(): AccountTypeFilter {
  const value = option('--account-type') ?? 'all';
  if (value === 'personal' || value === 'enterprise' || value === 'all') return value;
  throw new Error('--account-type must be personal, enterprise, or all');
}

type InvoiceEvidenceRow = {
  snapshot: Prisma.JsonValue;
  snapshotSha256: string;
  orderIds: string[];
  applicationIds: string[];
  itemIds: string[];
  eventIds: string[];
  invoiceItemCount: number;
  unsafeInvoiceItemCount: number;
  invalidApplicationCount: number;
};

async function loadInvoiceEvidence(
  client: Client,
  billingAccountId: string,
): Promise<InvoiceEvidenceRow> {
  const rows = await client.$queryRaw<InvoiceEvidenceRow[]>(Prisma.sql`
    SELECT
      evidence."evidence_snapshot" AS snapshot,
      evidence."evidence_sha256" AS "snapshotSha256",
      evidence."order_ids" AS "orderIds",
      evidence."application_ids" AS "applicationIds",
      evidence."item_ids" AS "itemIds",
      evidence."event_ids" AS "eventIds",
      evidence."invoice_item_count"::INTEGER AS "invoiceItemCount",
      evidence."unsafe_invoice_item_count"::INTEGER AS "unsafeInvoiceItemCount",
      evidence."invalid_application_count"::INTEGER AS "invalidApplicationCount"
    FROM "balance_ledger_invoice_stability_evidence"(${billingAccountId}) evidence`);
  if (rows.length !== 1 || !rows[0] || !/^[0-9a-f]{64}$/.test(rows[0].snapshotSha256)) {
    throw new Error('INVOICE_EVIDENCE_UNAVAILABLE');
  }
  return rows[0];
}

export async function loadSnapshot(
  client: Client,
  billingAccountId: string,
): Promise<BalanceLedgerRepairSnapshot> {
  const [account, wallet, transactions, grants, allocations, settlements, expiryAuditCount] = await Promise.all([
    client.billingAccount.findUniqueOrThrow({
      where: { id: billingAccountId },
      select: {
        id: true,
        type: true,
        balanceGrantLedgerStatus: true,
        balanceGrantLedgerVersion: true,
      },
    }),
    client.accountWallet.findUniqueOrThrow({
      where: { billingAccountId },
      select: { balanceUsd: true },
    }),
    client.balanceTransaction.findMany({
      where: { billingAccountId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        userId: true,
        tenantId: true,
        productId: true,
        type: true,
        amountUsd: true,
        balanceAfterUsd: true,
        description: true,
        orderId: true,
        tokenUsageId: true,
        operationKey: true,
        ledgerSequence: true,
        createdAt: true,
      },
    }),
    client.balanceGrant.findMany({
      where: { billingAccountId },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        userId: true,
        tenantId: true,
        productId: true,
        orderId: true,
        source: true,
        paidAmountUsd: true,
        bonusAmountUsd: true,
        grantedAmountUsd: true,
        remainingAmountUsd: true,
        remainingPaidAmountUsd: true,
        remainingBonusAmountUsd: true,
        discountRate: true,
        isExpired: true,
        validFrom: true,
        expiresAt: true,
        createdAt: true,
      },
    }),
    client.balanceConsumptionAllocation.findMany({
      where: {
        OR: [
          { billingAccountId },
          { balanceTransaction: { billingAccountId } },
          { balanceGrant: { billingAccountId } },
        ],
      },
      orderBy: [{ createdAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        billingAccountId: true,
        userId: true,
        tenantId: true,
        productId: true,
        balanceTransactionId: true,
        tokenUsageId: true,
        balanceGrantId: true,
        source: true,
        amountUsd: true,
        recognizedRevenueUsd: true,
        bonusConsumedUsd: true,
        discountRate: true,
        settledUsd: true,
        settledAt: true,
        ledgerSequence: true,
        createdAt: true,
      },
    }),
    client.enterpriseCreditSettlement.findMany({
      where: {
        OR: [
          { billingAccountId },
          { allocation: { billingAccountId } },
          { balanceGrant: { billingAccountId } },
          { repaymentTransaction: { billingAccountId } },
        ],
      },
      orderBy: [{ occurredAt: 'asc' }, { id: 'asc' }],
      select: {
        id: true,
        billingAccountId: true,
        allocationId: true,
        repaymentTransactionId: true,
        balanceGrantId: true,
        debtSource: true,
        repairRunId: true,
        operationKey: true,
        trigger: true,
        amountUsd: true,
        paidUsd: true,
        bonusUsd: true,
        occurredAt: true,
        createdAt: true,
      },
    }),
    client.balanceGrantExpiry.count({ where: { billingAccountId } }),
  ]);
  const orderIds = [...new Set([
    ...grants.map((grant) => grant.orderId),
    ...transactions.map((transaction) => transaction.orderId),
  ].filter((id): id is string => Boolean(id)))];
  const transactionIds = new Set(transactions.map((transaction) => transaction.id));
  const grantIds = new Set(grants.map((grant) => grant.id));
  const grantSnapshotHashRows = grants.length === 0
    ? []
    : await client.$queryRaw<Array<{ id: string; snapshotSha256: string }>>`
        SELECT grant_row."id",
          encode(
            sha256(convert_to(to_jsonb(grant_row)::TEXT, 'UTF8')),
            'hex'
          ) AS "snapshotSha256"
        FROM "balance_grants" grant_row
        WHERE grant_row."billing_account_id" = ${billingAccountId}
        ORDER BY grant_row."id"`;
  const grantSnapshotSha256ById = new Map(
    grantSnapshotHashRows.map((row) => [row.id, row.snapshotSha256]),
  );
  if (grantSnapshotSha256ById.size !== grants.length) {
    throw new Error('GRANT_SNAPSHOT_HASH_CARDINALITY_MISMATCH');
  }
  const hasVoucherFunding = grants.some((grant) => grant.source === 'VOUCHER');
  const [orders, invoiceItems, invoiceEvidence] = await Promise.all([
    orderIds.length > 0
      ? client.order.findMany({
          where: { id: { in: orderIds } },
          orderBy: { id: 'asc' },
          select: {
            id: true,
            userId: true,
            tenantId: true,
            billingAccountId: true,
            productId: true,
            orderType: true,
            status: true,
            amountCents: true,
            bonusCents: true,
            currency: true,
            paidAt: true,
            completedAt: true,
            refundedAt: true,
            refundAmountCents: true,
            createdAt: true,
          },
        })
      : Promise.resolve([]),
    orderIds.length > 0
      ? client.invoiceApplicationItem.findMany({
          where: { orderId: { in: orderIds } },
          orderBy: [{ applicationId: 'asc' }, { id: 'asc' }],
          select: {
            id: true,
            orderId: true,
            principalCents: true,
            description: true,
            applicationId: true,
            application: {
              select: {
                userId: true,
                tenantId: true,
                status: true,
                invoiceNumber: true,
                issuingEntity: true,
                issueDate: true,
                dueDate: true,
                issuedAt: true,
                pdfUrl: true,
                ofdUrl: true,
                events: {
                  where: { toStatus: { in: ['ISSUED', 'VOIDED', 'RED_OFFSET'] } },
                  select: { id: true },
                  take: 1,
                },
              },
            },
          },
        })
      : Promise.resolve([]),
    loadInvoiceEvidence(client, billingAccountId),
  ]);
  // Evidence ownership is part of the proof, not a query predicate. Avoid
  // expanding every transaction/allocation identifier into bind parameters:
  // large accounts can exceed both the PostgreSQL parameter limit and the
  // Node/Prisma serialization budget. Both direct legacy receipts and newer
  // response envelopes remain visible; the legacy parser still rejects a
  // non-legacy envelope instead of silently accepting another schema.
  const voucherIdempotencyRows = hasVoucherFunding
    ? await client.$queryRaw<Array<{
        key: string;
        scope: string;
        userId: string;
        status: string;
        result: Prisma.JsonValue;
        createdAt: Date;
        expiresAt: Date;
      }>>(Prisma.sql`
        SELECT idempotency_row."key", idempotency_row."scope",
          idempotency_row."user_id" AS "userId",
          idempotency_row."status", idempotency_row."result",
          idempotency_row."created_at" AS "createdAt",
          idempotency_row."expires_at" AS "expiresAt"
        FROM "idempotency_keys" idempotency_row
        WHERE idempotency_row."result" #>> '{transaction,id}' IN (
            SELECT transaction_row."id"
            FROM "balance_transactions" transaction_row
            WHERE transaction_row."billing_account_id" = ${billingAccountId}
          )
          OR idempotency_row."result" #>> '{response,transaction,id}' IN (
            SELECT transaction_row."id"
            FROM "balance_transactions" transaction_row
            WHERE transaction_row."billing_account_id" = ${billingAccountId}
          )
          OR idempotency_row."result" #>> '{grant,id}' IN (
            SELECT grant_row."id"
            FROM "balance_grants" grant_row
            WHERE grant_row."billing_account_id" = ${billingAccountId}
          )
          OR idempotency_row."result" #>> '{response,grant,id}' IN (
            SELECT grant_row."id"
            FROM "balance_grants" grant_row
            WHERE grant_row."billing_account_id" = ${billingAccountId}
          )
        ORDER BY idempotency_row."scope", idempotency_row."key"
      `)
    : [];
  const voucherIdempotencyEvidence = voucherIdempotencyRows.filter((row) => {
    if (!row.result || typeof row.result !== 'object' || Array.isArray(row.result)) return false;
    const result = row.result as Record<string, unknown>;
    const response = result.response && typeof result.response === 'object'
      && !Array.isArray(result.response)
      ? result.response as Record<string, unknown>
      : null;
    const resultTransaction = result.transaction && typeof result.transaction === 'object'
      && !Array.isArray(result.transaction)
      ? result.transaction as Record<string, unknown>
      : null;
    const resultGrant = result.grant && typeof result.grant === 'object'
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
    return (typeof resultTransaction?.id === 'string' && transactionIds.has(resultTransaction.id))
      || (typeof resultGrant?.id === 'string' && grantIds.has(resultGrant.id))
      || (typeof responseTransaction?.id === 'string'
        && transactionIds.has(responseTransaction.id))
      || (typeof responseGrant?.id === 'string' && grantIds.has(responseGrant.id));
  });
  // Deliberately load the complete COMMITTED account-prefix set. The legacy
  // contract accepts only the exact direct BalanceTransaction response; a V2
  // envelope or any orphan/tampered row remains visible and quarantines the
  // account instead of being silently ignored by this one-off repair.
  const legacyAdminFundingIdempotencyRows = await client.$queryRaw<Array<{
    key: string;
    scope: string;
    userId: string | null;
    status: string;
    result: unknown;
    createdAt: Date;
    expiresAt: Date;
    snapshotSha256: string;
  }>>`
        SELECT idempotency_row."key", idempotency_row."scope",
          idempotency_row."user_id" AS "userId", idempotency_row."status",
          idempotency_row."result", idempotency_row."created_at" AS "createdAt",
          idempotency_row."expires_at" AS "expiresAt",
          encode(
            sha256(convert_to(to_jsonb(idempotency_row)::TEXT, 'UTF8')),
            'hex'
          ) AS "snapshotSha256"
        FROM "idempotency_keys" idempotency_row
        WHERE idempotency_row."scope" IN ('admin:adjust-balance', 'admin:recharge')
          AND left(
            idempotency_row."key",
            length(${`enterprise-recharge:${billingAccountId}:`})
          ) = ${`enterprise-recharge:${billingAccountId}:`}
          AND idempotency_row."status" = 'COMMITTED'
        ORDER BY idempotency_row."scope", idempotency_row."key"`;

  return {
    billingAccountId: account.id,
    accountType: account.type,
    ledgerStatus: account.balanceGrantLedgerStatus,
    ledgerVersion: account.balanceGrantLedgerVersion,
    walletBalanceUsd: decimal(wallet.balanceUsd),
    transactions: transactions.map((transaction) => ({
      id: transaction.id,
      userId: transaction.userId,
      tenantId: transaction.tenantId,
      productId: transaction.productId,
      type: transaction.type,
      amountUsd: decimal(transaction.amountUsd),
      balanceAfterUsd: decimal(transaction.balanceAfterUsd),
      description: transaction.description,
      orderId: transaction.orderId,
      tokenUsageId: transaction.tokenUsageId,
      operationKey: transaction.operationKey,
      ledgerSequence: transaction.ledgerSequence?.toString() ?? null,
      createdAt: transaction.createdAt.toISOString(),
    })),
    grants: grants.map((grant) => ({
      id: grant.id,
      userId: grant.userId,
      tenantId: grant.tenantId,
      productId: grant.productId,
      orderId: grant.orderId,
      source: grant.source,
      paidAmountUsd: decimal(grant.paidAmountUsd),
      bonusAmountUsd: decimal(grant.bonusAmountUsd),
      grantedAmountUsd: decimal(grant.grantedAmountUsd),
      remainingAmountUsd: decimal(grant.remainingAmountUsd),
      remainingPaidAmountUsd: grant.remainingPaidAmountUsd === null
        ? null
        : decimal(grant.remainingPaidAmountUsd),
      remainingBonusAmountUsd: grant.remainingBonusAmountUsd === null
        ? null
        : decimal(grant.remainingBonusAmountUsd),
      discountRate: decimal(grant.discountRate),
      isExpired: grant.isExpired,
      validFrom: grant.validFrom.toISOString(),
      expiresAt: grant.expiresAt?.toISOString() ?? null,
      createdAt: grant.createdAt.toISOString(),
      ...(legacyAdminFundingIdempotencyRows.length > 0
        ? { snapshotSha256: grantSnapshotSha256ById.get(grant.id) }
        : {}),
    })),
    allocations: allocations.map((allocation) => ({
      id: allocation.id,
      billingAccountId: allocation.billingAccountId,
      userId: allocation.userId,
      tenantId: allocation.tenantId,
      productId: allocation.productId,
      balanceTransactionId: allocation.balanceTransactionId,
      tokenUsageId: allocation.tokenUsageId,
      balanceGrantId: allocation.balanceGrantId,
      source: allocation.source,
      amountUsd: decimal(allocation.amountUsd),
      recognizedRevenueUsd: decimal(allocation.recognizedRevenueUsd),
      bonusConsumedUsd: decimal(allocation.bonusConsumedUsd),
      discountRate: decimal(allocation.discountRate),
      settledUsd: decimal(allocation.settledUsd),
      settledAt: allocation.settledAt?.toISOString() ?? null,
      ledgerSequence: allocation.ledgerSequence?.toString() ?? null,
      createdAt: allocation.createdAt.toISOString(),
    })),
    settlements: settlements.map((settlement) => ({
      id: settlement.id,
      billingAccountId: settlement.billingAccountId,
      allocationId: settlement.allocationId,
      repaymentTransactionId: settlement.repaymentTransactionId,
      balanceGrantId: settlement.balanceGrantId,
      debtSource: settlement.debtSource,
      repairRunId: settlement.repairRunId,
      operationKey: settlement.operationKey,
      trigger: settlement.trigger,
      amountUsd: decimal(settlement.amountUsd),
      paidUsd: decimal(settlement.paidUsd),
      bonusUsd: decimal(settlement.bonusUsd),
      occurredAt: settlement.occurredAt.toISOString(),
      createdAt: settlement.createdAt.toISOString(),
    })),
    orders: orders.map((order) => ({
      id: order.id,
      userId: order.userId,
      tenantId: order.tenantId,
      billingAccountId: order.billingAccountId,
      productId: order.productId,
      orderType: order.orderType,
      status: order.status,
      amountCents: order.amountCents,
      bonusCents: order.bonusCents,
      currency: order.currency,
      paidAt: order.paidAt?.toISOString() ?? null,
      completedAt: order.completedAt?.toISOString() ?? null,
      refundedAt: order.refundedAt?.toISOString() ?? null,
      refundAmountCents: order.refundAmountCents,
      createdAt: order.createdAt.toISOString(),
    })),
    invoiceItems: invoiceItems.map((item) => ({
      id: item.id,
      orderId: item.orderId,
      principalCents: item.principalCents,
      description: item.description,
      applicationId: item.applicationId,
      applicationUserId: item.application.userId,
      applicationTenantId: item.application.tenantId,
      applicationStatus: item.application.status,
      invoiceNumber: item.application.invoiceNumber,
      issuingEntity: item.application.issuingEntity,
      issueDate: item.application.issueDate?.toISOString() ?? null,
      dueDate: item.application.dueDate?.toISOString() ?? null,
      issuedAt: item.application.issuedAt?.toISOString() ?? null,
      pdfUrl: item.application.pdfUrl,
      ofdUrl: item.application.ofdUrl,
      hasIssuedLifecycleEvent: item.application.events.length > 0,
    })),
    invoiceEvidence: invoiceEvidence.applicationIds.length === 0
      ? undefined
      : invoiceEvidence,
    voucherIdempotencyEvidence: voucherIdempotencyEvidence.map((evidence) => ({
      key: evidence.key,
      scope: evidence.scope,
      userId: evidence.userId,
      status: evidence.status,
      result: evidence.result,
      createdAt: evidence.createdAt.toISOString(),
      expiresAt: evidence.expiresAt.toISOString(),
    })),
    ...(legacyAdminFundingIdempotencyRows.length > 0
      ? {
          legacyAdminFundingIdempotencyEvidence: legacyAdminFundingIdempotencyRows.map(
            (evidence) => ({
              key: evidence.key,
              scope: evidence.scope,
              userId: evidence.userId,
              status: evidence.status,
              result: evidence.result,
              createdAt: evidence.createdAt.toISOString(),
              expiresAt: evidence.expiresAt.toISOString(),
              snapshotSha256: evidence.snapshotSha256,
            }),
          ),
        }
      : {}),
    expiryAuditCount,
  };
}

type HkUatAccountFingerprint = {
  walletBalanceUsd: string;
  transactionCount: number;
  transactionTypeCounts: Record<'CONSUME' | 'RECHARGE' | 'ADJUST', number>;
  transactionTypeSums: Record<'CONSUME' | 'RECHARGE' | 'ADJUST', string>;
  allocationCount: number;
  allocationSumUsd: string;
  invoiceEvidenceSha256: string;
  legacyExpiryPairs: readonly { grantId: string; transactionId: string }[];
  legacyExpiredVoucherFunding: readonly {
    grantId: string;
    transactionId: string;
    amountUsd: string;
    walletBeforeUsd: string;
  }[];
};

const HK_UAT_ACCOUNT_FINGERPRINTS: Readonly<Record<string, HkUatAccountFingerprint>> = {
  'ba_personal_c912db97-626d-4d9c-9f8a-fec97cc3670f': {
    walletBalanceUsd: '72.425279529000',
    transactionCount: 625,
    transactionTypeCounts: { CONSUME: 617, RECHARGE: 7, ADJUST: 1 },
    transactionTypeSums: {
      CONSUME: '-2.574720471000',
      RECHARGE: '65.000000000000',
      ADJUST: '10.000000000000',
    },
    allocationCount: 617,
    allocationSumUsd: '2.574720471000',
    invoiceEvidenceSha256: 'dbef762fa33be97acc03f367b8370f6db1415843dbc44aad052058243b465a33',
    legacyExpiryPairs: [],
    legacyExpiredVoucherFunding: [],
  },
  'ba_personal_c9afd0f8-a0eb-42c9-a9ff-499fa1999b2d': {
    walletBalanceUsd: '160.379021739000',
    transactionCount: 213,
    transactionTypeCounts: { CONSUME: 200, RECHARGE: 7, ADJUST: 6 },
    transactionTypeSums: {
      CONSUME: '-1.426739808000',
      RECHARGE: '161.000000000000',
      ADJUST: '0.805761547000',
    },
    allocationCount: 200,
    allocationSumUsd: '1.426739808000',
    // This account has 18 user-visible invoice applications, but only 12 are
    // reachable from balance-ledger subject orders. The other six belong to a
    // subscription order and must never enter this repair authorization scope.
    invoiceEvidenceSha256: '4f528278721ea2e19986a874b924b6fa46ec26b012e72b680307d65c33f792f5',
    legacyExpiryPairs: [
      {
        grantId: '4c9436f9-79df-4a71-baa7-670312385c87',
        transactionId: 'fdccf418-dbd9-4c91-b813-bf4034a18312',
      },
      {
        grantId: '9948f728-8645-4455-bb7a-f65c654beb09',
        transactionId: '5c48a127-a606-496e-89f9-4763d6748de7',
      },
      {
        grantId: '6188e90c-107a-474e-82c5-d4a0e0ce449c',
        transactionId: '00bf17fa-b363-4d6f-9393-3d003ea4c671',
      },
    ],
    legacyExpiredVoucherFunding: [
      {
        grantId: '4c9436f9-79df-4a71-baa7-670312385c87',
        transactionId: '5e53bfef-1f7c-4f6e-9e3f-ae60aa0e5f33',
        amountUsd: '1.000000000000',
        walletBeforeUsd: '9.511382292000',
      },
      {
        grantId: '6188e90c-107a-474e-82c5-d4a0e0ce449c',
        transactionId: '4620b8ee-c704-4cf3-a95a-d37df6b9c664',
        amountUsd: '1.000000000000',
        walletBeforeUsd: '167.467034068000',
      },
      {
        grantId: '9948f728-8645-4455-bb7a-f65c654beb09',
        transactionId: '8518e26a-359b-4f9d-b288-42fb1d74fd38',
        amountUsd: '12.000000000000',
        walletBeforeUsd: '155.467034068000',
      },
    ],
  },
};

function sumMoney(values: readonly Prisma.Decimal.Value[]): string {
  return decimal(values.reduce<Prisma.Decimal>(
    (sum, value) => sum.plus(value),
    new Prisma.Decimal(0),
  ));
}

type InvoiceClosureRow = Record<string, unknown> & { id: string };

function compareIdentityText(left: string, right: string): number {
  if (left === right) return 0;
  return left < right ? -1 : 1;
}

function invoiceClosureRows(
  snapshot: unknown,
  field: 'orders' | 'applications' | 'items' | 'events',
): InvoiceClosureRow[] | null {
  if (!snapshot || typeof snapshot !== 'object' || Array.isArray(snapshot)) return null;
  const value = (snapshot as Record<string, unknown>)[field];
  if (!Array.isArray(value)) return null;
  const rows: InvoiceClosureRow[] = [];
  for (const item of value) {
    if (!item || typeof item !== 'object' || Array.isArray(item)) return null;
    const row = item as Record<string, unknown>;
    if (typeof row.id !== 'string') return null;
    rows.push(row as InvoiceClosureRow);
  }
  return rows;
}

function invoiceItemHasUnsafeLifecycle(
  item: BalanceLedgerRepairSnapshot['invoiceItems'][number],
): boolean {
  return item.applicationStatus !== 'FAILED'
    || item.hasIssuedLifecycleEvent
    || item.invoiceNumber !== null
    || item.issueDate !== null
    || item.dueDate !== null
    || item.issuedAt !== null
    || item.pdfUrl !== null
    || item.ofdUrl !== null;
}

export function invoiceEvidenceClosureIsValid(
  snapshot: BalanceLedgerRepairSnapshot,
): boolean {
  const evidence = snapshot.invoiceEvidence;
  if (!evidence) return false;
  const closureOrders = invoiceClosureRows(evidence.snapshot, 'orders');
  const closureApplications = invoiceClosureRows(evidence.snapshot, 'applications');
  const closureItems = invoiceClosureRows(evidence.snapshot, 'items');
  const closureEvents = invoiceClosureRows(evidence.snapshot, 'events');
  if (!closureOrders || !closureApplications || !closureItems || !closureEvents) return false;
  if (closureItems.some((item) => (
    typeof item.application_id !== 'string' || typeof item.order_id !== 'string'
  ))) return false;
  const orderById = new Map(closureOrders.map((order) => [order.id, order]));
  const applicationById = new Map(closureApplications.map((application) => [
    application.id,
    application,
  ]));
  const itemById = new Map(closureItems.map((item) => [item.id, item]));
  const closureRelationsValid = closureOrders.every((order) => (
    typeof order.user_id === 'string'
    && typeof order.tenant_id === 'string'
    && order.billing_account_id === snapshot.billingAccountId
  )) && closureItems.every((item) => {
    const application = applicationById.get(item.application_id as string);
    const order = orderById.get(item.order_id as string);
    return application !== undefined
      && order !== undefined
      && typeof application.user_id === 'string'
      && typeof application.tenant_id === 'string'
      && application.user_id === order.user_id
      && application.tenant_id === order.tenant_id;
  });
  const identitySets = [
    evidence.orderIds,
    evidence.applicationIds,
    evidence.itemIds,
    evidence.eventIds,
  ];
  const subjectApplicationIds = [...new Set(
    snapshot.invoiceItems.map((item) => item.applicationId),
  )].sort(compareIdentityText);
  const evidenceApplicationIds = [...evidence.applicationIds]
    .sort(compareIdentityText);
  const closureApplicationIds = [...new Set(
    closureItems.map((item) => item.application_id as string),
  )].sort(compareIdentityText);
  const snapshotApplicationIds = closureApplications
    .map((application) => application.id)
    .sort(compareIdentityText);
  const closureOrderIds = closureOrders.map((order) => order.id).sort(compareIdentityText);
  const evidenceOrderIds = [...evidence.orderIds].sort(compareIdentityText);
  const closureItemIds = closureItems.map((item) => item.id).sort(compareIdentityText);
  const evidenceItemIds = [...evidence.itemIds].sort(compareIdentityText);
  const closureEventIds = closureEvents.map((event) => event.id).sort(compareIdentityText);
  const evidenceEventIds = [...evidence.eventIds].sort(compareIdentityText);
  const subjectOrderIds = [...new Set([
    ...snapshot.transactions.map((transaction) => transaction.orderId),
    ...snapshot.grants.map((grant) => grant.orderId),
  ].filter((id): id is string => id !== null))].sort(compareIdentityText);
  const ormOrderIds = snapshot.orders.map((order) => order.id).sort(compareIdentityText);
  const closureItemEdges = new Set(closureItems.map((item) => JSON.stringify([
    item.id,
    item.application_id,
    item.order_id,
  ])));
  const unsafeInvoiceItemCount = snapshot.invoiceItems
    .filter(invoiceItemHasUnsafeLifecycle).length;
  return identitySets.every((ids) => new Set(ids).size === ids.length)
    && /^(?!0{64}$)[0-9a-f]{64}$/.test(evidence.snapshotSha256)
    && closureRelationsValid
    && evidence.invoiceItemCount === snapshot.invoiceItems.length
    && evidence.unsafeInvoiceItemCount > 0
    && evidence.unsafeInvoiceItemCount === unsafeInvoiceItemCount
    && evidence.invalidApplicationCount === 0
    && evidence.eventIds.length > 0
    && JSON.stringify(subjectApplicationIds) === JSON.stringify(evidenceApplicationIds)
    && JSON.stringify(closureApplicationIds) === JSON.stringify(evidenceApplicationIds)
    && JSON.stringify(snapshotApplicationIds) === JSON.stringify(evidenceApplicationIds)
    && JSON.stringify(closureOrderIds) === JSON.stringify(evidenceOrderIds)
    && JSON.stringify(closureItemIds) === JSON.stringify(evidenceItemIds)
    && JSON.stringify(closureEventIds) === JSON.stringify(evidenceEventIds)
    && JSON.stringify(subjectOrderIds) === JSON.stringify(ormOrderIds)
    && subjectOrderIds.every((orderId) => evidence.orderIds.includes(orderId))
    && snapshot.invoiceItems.every((item) => {
      const closureItem = itemById.get(item.id);
      const application = applicationById.get(item.applicationId);
      return closureItem !== undefined
        && application !== undefined
        && evidence.itemIds.includes(item.id)
        && evidence.applicationIds.includes(item.applicationId)
        && evidence.orderIds.includes(item.orderId)
        && ormOrderIds.includes(item.orderId)
        && closureItemEdges.has(JSON.stringify([item.id, item.applicationId, item.orderId]))
        && closureItem.principal_cents === item.principalCents
        && closureItem.description === item.description
        && application.user_id === item.applicationUserId
        && application.tenant_id === item.applicationTenantId
        && application.status === item.applicationStatus
        && application.invoice_number === item.invoiceNumber
        && application.issuing_entity === item.issuingEntity;
    });
}

export function maintenanceInvoiceEvidenceMatches(
  snapshot: BalanceLedgerRepairSnapshot,
  expectedEvidenceSha256: string,
): boolean {
  return snapshot.invoiceEvidence?.snapshotSha256 === expectedEvidenceSha256
    && invoiceEvidenceClosureIsValid(snapshot);
}

export function assertMaintenanceSnapshot(
  profile: BalanceLedgerRepairExecutionProfile,
  snapshot: BalanceLedgerRepairSnapshot,
): void {
  switch (profile.name) {
    case null:
      return;
    case INVOICE_STABILITY_EVIDENCE_PROFILE:
      if (!invoiceEvidenceClosureIsValid(snapshot)) {
        throw new Error(
          `INVOICE_STABILITY_PROFILE_EVIDENCE_MISMATCH:${snapshot.billingAccountId}`,
        );
      }
      return;
    case HK_UAT_TWO_ACCOUNT_PROFILE:
    case HK_UAT_REMAINING_ACCOUNT_PROFILE:
      break;
    default:
      return unreachableMaintenanceProfile(profile.name);
  }
  const expected = HK_UAT_ACCOUNT_FINGERPRINTS[snapshot.billingAccountId];
  if (!expected) throw new Error(`HK_UAT_PROFILE_ACCOUNT_UNEXPECTED:${snapshot.billingAccountId}`);
  const types = ['CONSUME', 'RECHARGE', 'ADJUST'] as const;
  const actualExpiryPairs = snapshot.grants
    .filter((grant) => grant.isExpired)
    .map((grant) => {
      const matches = snapshot.transactions.filter(
        (transaction) => transaction.description === `balance grant expired:${grant.id}`,
      );
      return { grantId: grant.id, transactionId: matches.length === 1 ? matches[0].id : '' };
    })
    .sort((left, right) => left.grantId.localeCompare(right.grantId));
  const expectedExpiryPairs = [...expected.legacyExpiryPairs]
    .sort((left, right) => left.grantId.localeCompare(right.grantId));
  const actualExpiredVoucherFunding = snapshot.grants
    .filter((grant) => grant.isExpired && grant.source === 'VOUCHER')
    .map((grant) => {
      const matches = snapshot.transactions.filter(
        (transaction) => voucherGrantIdFromDescription(transaction.description) === grant.id,
      );
      const transaction = matches.length === 1 ? matches[0] : null;
      return {
        grantId: grant.id,
        transactionId: transaction?.id ?? '',
        amountUsd: transaction ? decimal(transaction.amountUsd) : '',
        walletBeforeUsd: transaction
          ? decimal(new Prisma.Decimal(transaction.balanceAfterUsd).minus(transaction.amountUsd))
          : '',
      };
    })
    .sort((left, right) => left.grantId.localeCompare(right.grantId));
  const expectedExpiredVoucherFunding = [...expected.legacyExpiredVoucherFunding]
    .sort((left, right) => left.grantId.localeCompare(right.grantId));
  const fingerprintMatches = snapshot.accountType === 'personal'
    && snapshot.walletBalanceUsd === expected.walletBalanceUsd
    && snapshot.transactions.length === expected.transactionCount
    && snapshot.allocations.length === expected.allocationCount
    && sumMoney(snapshot.allocations.map((allocation) => allocation.amountUsd))
      === expected.allocationSumUsd
    && maintenanceInvoiceEvidenceMatches(snapshot, expected.invoiceEvidenceSha256)
    && types.every((type) => {
      const rows = snapshot.transactions.filter((transaction) => transaction.type === type);
      return rows.length === expected.transactionTypeCounts[type]
        && sumMoney(rows.map((transaction) => transaction.amountUsd))
          === expected.transactionTypeSums[type];
    })
    && JSON.stringify(actualExpiryPairs) === JSON.stringify(expectedExpiryPairs)
    && JSON.stringify(actualExpiredVoucherFunding)
      === JSON.stringify(expectedExpiredVoucherFunding);
  if (!fingerprintMatches) {
    throw new Error(`HK_UAT_PROFILE_FINGERPRINT_MISMATCH:${snapshot.billingAccountId}`);
  }
}

export async function loadPostgresFinancialNow(
  client: Client,
  billingAccountId: string,
): Promise<Date> {
  const rows = await client.$queryRaw<Array<{ financialNow: Date }>>(Prisma.sql`
    SELECT GREATEST(
      ${POSTGRES_UTC_FINANCIAL_CLOCK},
      COALESCE(account."balance_grant_ledger_reconciled_at", '-infinity'::TIMESTAMP),
      COALESCE((
        SELECT transaction_row."created_at"
        FROM "balance_transactions" transaction_row
        WHERE transaction_row."billing_account_id" = account."id"
          AND transaction_row."ledger_sequence" > 0
        ORDER BY transaction_row."created_at" DESC
        LIMIT 1
      ), '-infinity'::TIMESTAMP)
    )::TIMESTAMP(3) AS "financialNow"
    FROM "billing_accounts" account
    WHERE account."id" = ${billingAccountId}`);
  const financialNow = rows[0]?.financialNow;
  if (rows.length !== 1 || !(financialNow instanceof Date) || Number.isNaN(financialNow.getTime())) {
    throw new Error('POSTGRES_FINANCIAL_CLOCK_UNAVAILABLE');
  }
  return financialNow;
}

function sameDatabaseBinding(
  left: RepairDatabaseBinding,
  right: RepairDatabaseBinding,
): boolean {
  return left.databaseName === right.databaseName
    && left.databaseIdentity === right.databaseIdentity
    && left.databaseSystemIdentifier === right.databaseSystemIdentifier
    && left.databaseOid === right.databaseOid
    && left.phase === right.phase;
}

export async function loadRepairDatabaseBinding(
  client: Client,
  expected?: Pick<RepairDatabaseBinding, 'databaseName' | 'databaseIdentity'>,
): Promise<RepairDatabaseBinding> {
  if (expected) {
    try {
      const assertionRows = await client.$queryRaw<Array<{ invoked: boolean }>>`
        SELECT "assert_balance_ledger_database_identity"(
          ${expected.databaseName},
          ${expected.databaseIdentity}::UUID,
          TRUE
        ) IS NULL AS "invoked"`;
      if (assertionRows.length !== 1) {
        throw new Error('database identity assertion did not execute exactly once');
      }
    } catch (error) {
      const detail = error instanceof Error ? error.message : String(error);
      throw new Error(`DATABASE_BINDING_MISMATCH:${detail}`);
    }
  }

  const rows = await client.$queryRaw<Array<{
    databaseName: string;
    databaseIdentity: string;
    databaseSystemIdentifier: string;
    databaseOid: string;
    phase: string;
    currentDatabaseName: string;
    currentSystemIdentifier: string;
    currentDatabaseOid: string;
  }>>`
    SELECT
      control."database_name" AS "databaseName",
      control."database_identity"::TEXT AS "databaseIdentity",
      control."database_system_identifier"::TEXT AS "databaseSystemIdentifier",
      control."database_oid"::TEXT AS "databaseOid",
      control."phase" AS "phase",
      current_database() AS "currentDatabaseName",
      system_row."system_identifier"::NUMERIC(20, 0)::TEXT AS "currentSystemIdentifier",
      database_row.oid::TEXT AS "currentDatabaseOid"
    FROM "balance_ledger_rollout_control" control
    CROSS JOIN pg_control_system() system_row
    JOIN pg_database database_row ON database_row.datname = current_database()
    WHERE control."id" = 1
    FOR SHARE OF control`;
  const row = rows[0];
  if (
    rows.length !== 1
    || !row
    || row.phase !== 'V2_CONTRACT'
    || row.databaseName !== row.currentDatabaseName
    || row.databaseSystemIdentifier !== row.currentSystemIdentifier
    || row.databaseOid !== row.currentDatabaseOid
    || (expected && (
      row.databaseName !== expected.databaseName
      || row.databaseIdentity !== expected.databaseIdentity
    ))
  ) {
    throw new Error('DATABASE_BINDING_MISMATCH:rollout control is absent, stale, or not V2_CONTRACT');
  }
  return {
    databaseName: row.databaseName,
    databaseIdentity: row.databaseIdentity,
    databaseSystemIdentifier: row.databaseSystemIdentifier,
    databaseOid: row.databaseOid,
    phase: 'V2_CONTRACT',
  };
}

function isDatabaseBindingFailure(error: unknown): boolean {
  return error instanceof Error && error.message.includes('DATABASE_BINDING_MISMATCH:');
}

async function candidateAccountIds(client: Client): Promise<string[]> {
  const profile = executionProfile();
  if (profile.billingAccountIds) return [...profile.billingAccountIds];
  const typeFilter = accountTypeFilter();
  const explicit = option('--billing-account-id');
  if (explicit) {
    const account = await client.billingAccount.findUniqueOrThrow({
      where: { id: explicit },
      select: { type: true },
    });
    if (typeFilter !== 'all' && account.type !== typeFilter) {
      throw new Error(`billing account ${explicit} is ${account.type}, not ${typeFilter}`);
    }
    return [explicit];
  }
  const limit = positiveInt(option('--limit'), 100, 1000);
  const cursorAfter = option('--cursor-after');
  const accounts = await client.billingAccount.findMany({
    where: {
      type: typeFilter === 'all' ? { in: ['personal', 'enterprise'] } : typeFilter,
      balanceGrantLedgerStatus: 'LEGACY_DIRTY',
      wallet: { isNot: null },
      ...(cursorAfter ? { id: { gt: cursorAfter } } : {}),
    },
    orderBy: { id: 'asc' },
    take: limit,
    select: { id: true },
  });
  return accounts.map((account) => account.id);
}

async function dryRun(): Promise<void> {
  const profile = executionProfile();
  const endpointSha256 = databaseEndpointSha256();
  const initialBinding = await loadRepairDatabaseBinding(
    prisma,
    profile.expectedDatabase ?? undefined,
  );
  const ids = await prisma.$transaction(async (tx) => {
    await loadRepairDatabaseBinding(tx, initialBinding);
    return candidateAccountIds(tx);
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 10_000,
    timeout: 60_000,
  });
  const plans: BalanceLedgerRepairPlan[] = [];
  for (const billingAccountId of ids) {
    plans.push(await prisma.$transaction(async (tx) => {
      await loadRepairDatabaseBinding(tx, initialBinding);
      const snapshot = await loadSnapshot(tx, billingAccountId);
      assertMaintenanceSnapshot(profile, snapshot);
      const financialNow = await loadPostgresFinancialNow(tx, billingAccountId);
      const plan = buildBalanceLedgerRepairPlan(snapshot, financialNow, profile.planningProfile);
      if (plan.status === 'READY') assertRepairAuditPayloadBounds(snapshot, plan);
      return plan;
    }, GENERIC_REPAIR_TRANSACTION_OPTIONS));
  }
  const finalBinding = await loadRepairDatabaseBinding(prisma, initialBinding);
  if (!sameDatabaseBinding(initialBinding, finalBinding)) {
    throw new Error('DATABASE_BINDING_MISMATCH:database identity changed during dry-run');
  }
  const manifest: RepairPlanManifest = {
    recordType: PLAN_FORMAT,
    ...initialBinding,
    endpointSha256,
    maintenanceProfile: profile.name,
  };
  const jsonl = [JSON.stringify(manifest), ...plans.map((plan) => JSON.stringify(plan))].join('\n') + '\n';
  const outputPath = option('--output-jsonl');
  if (outputPath) writeFileSync(outputPath, jsonl, { encoding: 'utf8', flag: 'wx' });
  else process.stdout.write(jsonl);

  const ready = plans.filter((plan) => plan.status === 'READY').length;
  const quarantined = plans.length - ready;
  console.error(
    JSON.stringify({
      mode: 'dry-run',
      scanned: plans.length,
      ready,
      quarantined,
      outputPath: outputPath ?? null,
      planSha256: sha256(jsonl),
    }),
  );
}

function repairAuditJson(value: unknown): Prisma.InputJsonValue {
  return JSON.parse(JSON.stringify(value)) as Prisma.InputJsonValue;
}

function assertJsonByteLimit(json: string, label: string, maxBytes: number): void {
  const bytes = Buffer.byteLength(json, 'utf8');
  if (bytes > maxBytes) {
    throw new Error(`${label}_TOO_LARGE:bytes=${bytes}:max=${maxBytes}`);
  }
}

export function repairAuditJsonWithLimit(
  value: unknown,
  label: string,
  maxBytes: number,
): Prisma.InputJsonValue {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error(`${label}_NOT_JSON_SERIALIZABLE`);
  assertJsonByteLimit(json, label, maxBytes);
  return JSON.parse(json) as Prisma.InputJsonValue;
}

export function repairAuditJsonTextWithLimit(
  value: unknown,
  label: string,
  maxBytes: number,
): string {
  const json = JSON.stringify(value);
  if (json === undefined) throw new Error(`${label}_NOT_JSON_SERIALIZABLE`);
  assertJsonByteLimit(json, label, maxBytes);
  return json;
}

export function buildRepairAccountBeforeManifest(
  snapshot: BalanceLedgerRepairSnapshot,
  preconditionHash: string,
): Record<string, unknown> {
  if (!/^[0-9a-f]{64}$/.test(preconditionHash)) {
    throw new Error('REPAIR_BEFORE_MANIFEST_PRECONDITION_HASH_INVALID');
  }
  return {
    manifestVersion: REPAIR_BEFORE_MANIFEST_VERSION,
    snapshotHashAlgorithm: REPAIR_SNAPSHOT_HASH_ALGORITHM,
    billingAccountId: snapshot.billingAccountId,
    accountType: snapshot.accountType,
    ledgerStatus: snapshot.ledgerStatus,
    ledgerVersion: snapshot.ledgerVersion,
    walletBalanceUsd: snapshot.walletBalanceUsd,
    preconditionHash,
    rowCounts: {
      transactions: snapshot.transactions.length,
      grants: snapshot.grants.length,
      allocations: snapshot.allocations.length,
      settlements: snapshot.settlements.length,
      orders: snapshot.orders.length,
      invoiceItems: snapshot.invoiceItems.length,
      voucherIdempotencyEvidence: snapshot.voucherIdempotencyEvidence.length,
      legacyAdminFundingIdempotencyEvidence:
        snapshot.legacyAdminFundingIdempotencyEvidence?.length ?? 0,
      expiryAudits: snapshot.expiryAuditCount,
    },
    invoiceEvidenceSha256: snapshot.invoiceEvidence?.snapshotSha256 ?? null,
    // Existing database proof functions deliberately consume these two exact
    // locked evidence sets. Keep them verbatim while removing the unbounded
    // transaction/allocation/order collections from the account-level row.
    grants: snapshot.grants,
    voucherIdempotencyEvidence: snapshot.voucherIdempotencyEvidence,
  };
}

export function buildRepairFailureManifest(
  plan: BalanceLedgerRepairPlan,
): Record<string, unknown> {
  return {
    manifestVersion: REPAIR_FAILURE_MANIFEST_VERSION,
    billingAccountId: plan.billingAccountId,
    status: plan.status,
    preconditionHash: plan.preconditionHash,
    ...(plan.status === 'READY'
      ? {
          replayHash: plan.replayHash,
          mutationCounts: {
            transactionSequence: plan.transactionSequenceMutations.length,
            grants: plan.grantMutations.length,
            allocations: plan.allocationMutations.length,
            allocationSequence: plan.allocationSequenceMutations.length,
            unreconciledGrants: plan.unreconciledGrantMutations.length,
            canonicalAllocations: plan.canonicalAllocationMutations.length,
            migrationOpeningDebt: plan.migrationOpeningDebtMutations.length,
            personalDebtAllocations: plan.personalDebtAllocationMutations.length,
            legacyVoucherProofs: plan.legacyVoucherProofMutations.length,
            legacyExpiryProofs: plan.legacyExpiryProofMutations.length,
            settlements: plan.settlementMutations.length,
            legacyAdminFunding: plan.legacyAdminFundingRepairs.length,
          },
          invoiceStabilityProofPresent: plan.invoiceStabilityProof !== null,
        }
      : { reasonCount: plan.reasons.length }),
  };
}

function assertRepairAuditPayloadBounds(
  snapshot: BalanceLedgerRepairSnapshot,
  plan: Extract<BalanceLedgerRepairPlan, { status: 'READY' }>,
): void {
  repairAuditJsonTextWithLimit(
    buildRepairAccountBeforeManifest(snapshot, plan.preconditionHash),
    'REPAIR_BEFORE_MANIFEST',
    MAX_REPAIR_BEFORE_JSON_BYTES,
  );
  // The terminal snapshot still follows the frozen V9 database contract in
  // this release.  Reject it during dry-run when its mutation-bearing portion
  // cannot fit the explicitly approved application budget; apply repeats the
  // check against the exact final object before any terminal promotion.
  repairAuditJsonTextWithLimit({
    transactionSequenceMutations: plan.transactionSequenceMutations,
    grantMutations: plan.grantMutations,
    allocationMutations: plan.allocationMutations,
    migrationOpeningDebtMutations: plan.migrationOpeningDebtMutations,
    canonicalAllocationMutations: plan.canonicalAllocationMutations,
    legacyAdminFundingRepairs: plan.legacyAdminFundingRepairs,
  }, 'REPAIR_AFTER_SNAPSHOT_PREVIEW', MAX_REPAIR_AFTER_JSON_BYTES);
}

function exactObjectKeys(
  value: unknown,
  allowed: readonly string[],
  label: string,
): asserts value is Record<string, unknown> {
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new Error(`${label} must be an object`);
  }
  const allowedSet = new Set(allowed);
  const unknown = Object.keys(value).filter((key) => !allowedSet.has(key));
  if (unknown.length > 0) throw new Error(`${label} has unknown fields: ${unknown.join(',')}`);
}

const CANONICAL_MONEY = /^-?(?:0|[1-9]\d*)\.\d{12}$/;
const CANONICAL_INTEGER = /^-?(?:0|[1-9]\d*)$/;

function isCanonicalInstant(value: unknown): value is string {
  if (typeof value !== 'string') return false;
  const parsed = new Date(value);
  return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
}

function isNullableString(value: unknown): value is string | null {
  return value === null || typeof value === 'string';
}

function assertRepairTransactionSnapshot(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  exactObjectKeys(value, [
    'id', 'userId', 'tenantId', 'productId', 'type', 'amountUsd', 'balanceAfterUsd',
    'description', 'orderId', 'tokenUsageId', 'operationKey', 'ledgerSequence', 'createdAt',
  ], label);
  if (
    typeof value.id !== 'string' || value.id.length === 0
    || typeof value.userId !== 'string' || value.userId.length === 0
    || !isNullableString(value.tenantId)
    || !isNullableString(value.productId)
    || typeof value.type !== 'string' || value.type.length === 0
    || typeof value.amountUsd !== 'string' || !CANONICAL_MONEY.test(value.amountUsd)
    || typeof value.balanceAfterUsd !== 'string' || !CANONICAL_MONEY.test(value.balanceAfterUsd)
    || typeof value.description !== 'string'
    || !isNullableString(value.orderId)
    || !isNullableString(value.tokenUsageId)
    || !isNullableString(value.operationKey)
    || !(value.ledgerSequence === null || (
      typeof value.ledgerSequence === 'string' && CANONICAL_INTEGER.test(value.ledgerSequence)
    ))
    || !isCanonicalInstant(value.createdAt)
  ) {
    throw new Error(`${label} invalid`);
  }
}

function assertRepairGrantSnapshot(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  exactObjectKeys(value, [
    'id', 'userId', 'tenantId', 'productId', 'orderId', 'source', 'paidAmountUsd',
    'bonusAmountUsd', 'grantedAmountUsd', 'remainingAmountUsd',
    'remainingPaidAmountUsd', 'remainingBonusAmountUsd', 'discountRate', 'isExpired',
    'validFrom', 'expiresAt', 'createdAt',
  ], label);
  const moneyFields = ['paidAmountUsd', 'bonusAmountUsd', 'grantedAmountUsd', 'remainingAmountUsd',
    'discountRate'] as const;
  if (
    typeof value.id !== 'string' || value.id.length === 0
    || typeof value.userId !== 'string' || value.userId.length === 0
    || typeof value.tenantId !== 'string' || value.tenantId.length === 0
    || !isNullableString(value.productId)
    || !isNullableString(value.orderId)
    || typeof value.source !== 'string' || value.source.length === 0
    || moneyFields.some((field) => (
      typeof value[field] !== 'string' || !CANONICAL_MONEY.test(value[field] as string)
    ))
    || !(
      value.remainingPaidAmountUsd === null
      || (typeof value.remainingPaidAmountUsd === 'string'
        && CANONICAL_MONEY.test(value.remainingPaidAmountUsd))
    )
    || !(
      value.remainingBonusAmountUsd === null
      || (typeof value.remainingBonusAmountUsd === 'string'
        && CANONICAL_MONEY.test(value.remainingBonusAmountUsd))
    )
    || typeof value.isExpired !== 'boolean'
    || !isCanonicalInstant(value.validFrom)
    || !(value.expiresAt === null || isCanonicalInstant(value.expiresAt))
    || !isCanonicalInstant(value.createdAt)
  ) {
    throw new Error(`${label} invalid`);
  }
}

function assertRepairAllocationSnapshot(
  value: unknown,
  label: string,
): asserts value is Record<string, unknown> {
  exactObjectKeys(value, [
    'id', 'billingAccountId', 'userId', 'tenantId', 'productId', 'balanceTransactionId',
    'tokenUsageId', 'balanceGrantId', 'source', 'amountUsd', 'recognizedRevenueUsd',
    'bonusConsumedUsd', 'discountRate', 'settledUsd', 'settledAt', 'ledgerSequence',
    'createdAt',
  ], label);
  const moneyFields = [
    'amountUsd', 'recognizedRevenueUsd', 'bonusConsumedUsd', 'discountRate', 'settledUsd',
  ] as const;
  if (
    typeof value.id !== 'string' || value.id.length === 0
    || typeof value.billingAccountId !== 'string' || value.billingAccountId.length === 0
    || typeof value.userId !== 'string' || value.userId.length === 0
    || typeof value.tenantId !== 'string' || value.tenantId.length === 0
    || !isNullableString(value.productId)
    || typeof value.balanceTransactionId !== 'string' || value.balanceTransactionId.length === 0
    || !isNullableString(value.tokenUsageId)
    || !isNullableString(value.balanceGrantId)
    || typeof value.source !== 'string' || value.source.length === 0
    || moneyFields.some((field) => (
      typeof value[field] !== 'string' || !CANONICAL_MONEY.test(value[field] as string)
    ))
    || !(value.settledAt === null || isCanonicalInstant(value.settledAt))
    || !(value.ledgerSequence === null || (
      typeof value.ledgerSequence === 'string' && CANONICAL_INTEGER.test(value.ledgerSequence)
    ))
    || !isCanonicalInstant(value.createdAt)
  ) {
    throw new Error(`${label} invalid`);
  }
}

function sameAllocationIdentity(
  left: Record<string, unknown>,
  right: Record<string, unknown>,
): boolean {
  return [
    'id', 'billingAccountId', 'userId', 'tenantId', 'productId', 'balanceTransactionId',
    'tokenUsageId', 'createdAt',
  ].every((field) => left[field] === right[field]);
}

function assertVoucherIdempotencyEvidence(value: unknown, label: string): void {
  exactObjectKeys(value, [
    'key', 'scope', 'userId', 'status', 'result', 'createdAt', 'expiresAt',
  ], label);
  if (
    typeof value.key !== 'string' || value.key.length === 0
    || value.scope !== 'admin:issue-voucher'
    || !isNullableString(value.userId)
    || value.status !== 'COMMITTED'
    || value.result === null || typeof value.result !== 'object' || Array.isArray(value.result)
    || !isCanonicalInstant(value.createdAt)
    || !isCanonicalInstant(value.expiresAt)
  ) {
    throw new Error(`${label} invalid`);
  }
  const resultLabel = `${label}.result`;
  exactObjectKeys(value.result, ['transaction', 'grant'], resultLabel);
  const result = value.result as Record<string, unknown>;
  exactObjectKeys(result.transaction, [
    'id', 'type', 'userId', 'tenantId', 'amountUsd', 'createdAt', 'productId',
    'amountCents', 'description', 'balanceAfterUsd', 'balanceAfterCents',
  ], `${resultLabel}.transaction`);
  exactObjectKeys(result.grant, [
    'id', 'source', 'expiresAt', 'productId', 'amountCents', 'discountRate',
    'remainingCents', 'paidAmountCents', 'bonusAmountCents',
  ], `${resultLabel}.grant`);
  const transaction = result.transaction as Record<string, unknown>;
  const grant = result.grant as Record<string, unknown>;
  const finiteNumber = (candidate: unknown) => (
    typeof candidate === 'number' && Number.isFinite(candidate)
  );
  if (
    typeof transaction.id !== 'string' || transaction.id.length === 0
    || typeof transaction.type !== 'string' || transaction.type.length === 0
    || typeof transaction.userId !== 'string' || transaction.userId.length === 0
    || typeof transaction.tenantId !== 'string' || transaction.tenantId.length === 0
    || !finiteNumber(transaction.amountUsd)
    || !isCanonicalInstant(transaction.createdAt)
    || !isNullableString(transaction.productId)
    || !finiteNumber(transaction.amountCents)
    || typeof transaction.description !== 'string'
    || !finiteNumber(transaction.balanceAfterUsd)
    || !finiteNumber(transaction.balanceAfterCents)
    || typeof grant.id !== 'string' || grant.id.length === 0
    || typeof grant.source !== 'string' || grant.source.length === 0
    || !(grant.expiresAt === null || isCanonicalInstant(grant.expiresAt))
    || !isNullableString(grant.productId)
    || !finiteNumber(grant.amountCents)
    || !finiteNumber(grant.discountRate)
    || !finiteNumber(grant.remainingCents)
    || !finiteNumber(grant.paidAmountCents)
    || !finiteNumber(grant.bonusAmountCents)
  ) {
    throw new Error(`${resultLabel} invalid`);
  }
}

export function parseRepairPlanManifest(line: string): RepairPlanManifest {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error('plan manifest is not valid JSON');
  }
  exactObjectKeys(value, [
    'recordType',
    'databaseName',
    'databaseIdentity',
    'databaseSystemIdentifier',
    'databaseOid',
    'phase',
    'endpointSha256',
    'maintenanceProfile',
  ], 'plan manifest');
  if (
    value.recordType !== PLAN_FORMAT
    || typeof value.databaseName !== 'string'
    || value.databaseName.length === 0
    || value.databaseName.trim() !== value.databaseName
    || typeof value.databaseIdentity !== 'string'
    || !/^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/.test(
      value.databaseIdentity,
    )
    || typeof value.databaseSystemIdentifier !== 'string'
    || !/^[1-9]\d{0,19}$/.test(value.databaseSystemIdentifier)
    || typeof value.databaseOid !== 'string'
    || !/^[1-9]\d{0,9}$/.test(value.databaseOid)
    || BigInt(value.databaseOid) > BigInt(4_294_967_295)
    || value.phase !== 'V2_CONTRACT'
    || typeof value.endpointSha256 !== 'string'
    || !/^[0-9a-f]{64}$/.test(value.endpointSha256)
    || !(
      value.maintenanceProfile === null
      || value.maintenanceProfile === HK_UAT_TWO_ACCOUNT_PROFILE
      || value.maintenanceProfile === HK_UAT_REMAINING_ACCOUNT_PROFILE
      || value.maintenanceProfile === INVOICE_STABILITY_EVIDENCE_PROFILE
    )
  ) {
    throw new Error('plan manifest has invalid database binding fields');
  }
  return value as RepairPlanManifest;
}

export function parseRepairPlanFile(raw: string): {
  manifest: RepairPlanManifest;
  plans: BalanceLedgerRepairPlan[];
} {
  if (raw.length === 0 || !raw.endsWith('\n') || raw.includes('\r')) {
    throw new Error('plan file must be non-empty canonical LF-terminated JSONL');
  }
  const lines = raw.slice(0, -1).split('\n');
  if (lines.some((line) => line.length === 0)) {
    throw new Error('plan file contains an empty JSONL record');
  }
  const manifestLine = lines.shift();
  if (!manifestLine) throw new Error('plan file manifest is missing');
  const manifest = parseRepairPlanManifest(manifestLine);
  const plans = lines.map(parseApprovedPlan);
  if (plans.length === 0) throw new Error('plan file contains no account plans');
  return { manifest, plans };
}

function parseApprovedPlan(line: string, index: number): BalanceLedgerRepairPlan {
  let value: unknown;
  try {
    value = JSON.parse(line);
  } catch {
    throw new Error(`plan[${index}] is not valid JSON`);
  }
  exactObjectKeys(value, [
    'status', 'billingAccountId', 'accountType', 'debtSource', 'settlementWriteMode',
    'expectedSettlementCount', 'preconditionHash', 'replayHash', 'walletBalanceUsd',
    'currentDebtUsd', 'legacySettledDebtUsd', 'activeGrantDriftUsd', 'throughTransactionId',
    'transactionSequenceMutations', 'grantMutations', 'allocationMutations',
    'allocationSequenceMutations',
    'unreconciledGrantMutations',
    'canonicalAllocationMutations',
    'migrationOpeningDebtMutations',
    'personalDebtAllocationMutations',
    'legacyVoucherProofMutations',
    'legacyExpiryProofMutations',
    'invoiceStabilityProof',
    'settlementMutations', 'legacyAdminFundingRepairs', 'reasons',
  ], `plan[${index}]`);
  if (value.status === 'QUARANTINED') {
    if (
      typeof value.billingAccountId !== 'string'
      || typeof value.preconditionHash !== 'string'
      || !Array.isArray(value.reasons)
      || value.reasons.some((reason) => typeof reason !== 'string')
    ) {
      throw new Error(`plan[${index}] invalid QUARANTINED payload`);
    }
    const required = new Set(['status', 'billingAccountId', 'preconditionHash', 'reasons']);
    const extra = Object.keys(value).filter((key) => !required.has(key));
    if (extra.length > 0) throw new Error(`plan[${index}] QUARANTINED has extra fields`);
    return value as BalanceLedgerRepairPlan;
  }
  if (value.status !== 'READY') throw new Error(`plan[${index}] has invalid status`);
  if (
    typeof value.billingAccountId !== 'string'
    || (value.accountType !== 'personal' && value.accountType !== 'enterprise')
    || (value.debtSource !== 'NEGATIVE_BALANCE' && value.debtSource !== 'ENTERPRISE_CREDIT')
    || (value.settlementWriteMode !== 'CREATE' && value.settlementWriteMode !== 'VERIFY_EXISTING')
    || typeof value.expectedSettlementCount !== 'number'
    || !Number.isInteger(value.expectedSettlementCount)
    || value.expectedSettlementCount < 0
    || typeof value.preconditionHash !== 'string'
    || typeof value.replayHash !== 'string'
    || !Array.isArray(value.transactionSequenceMutations)
    || !Array.isArray(value.grantMutations)
    || !Array.isArray(value.allocationMutations)
    || !Array.isArray(value.allocationSequenceMutations)
    || !Array.isArray(value.unreconciledGrantMutations)
    || !Array.isArray(value.canonicalAllocationMutations)
    || !Array.isArray(value.migrationOpeningDebtMutations)
    || !Array.isArray(value.personalDebtAllocationMutations)
    || !Array.isArray(value.legacyVoucherProofMutations)
    || !Array.isArray(value.legacyExpiryProofMutations)
    || !(value.invoiceStabilityProof === null || (
      typeof value.invoiceStabilityProof === 'object'
      && !Array.isArray(value.invoiceStabilityProof)
    ))
    || !Array.isArray(value.settlementMutations)
    || !Array.isArray(value.legacyAdminFundingRepairs)
  ) {
    throw new Error(`plan[${index}] invalid READY payload`);
  }
  value.transactionSequenceMutations.forEach((mutation, mutationIndex) => {
    exactObjectKeys(mutation, [
      'transactionId', 'expectedLedgerSequence', 'ledgerSequence',
    ], `plan[${index}].transactionSequenceMutations[${mutationIndex}]`);
    if (
      typeof mutation.transactionId !== 'string'
      || mutation.expectedLedgerSequence !== null
      || typeof mutation.ledgerSequence !== 'string'
      || !/^-[1-9]\d*$/.test(mutation.ledgerSequence)
    ) {
      throw new Error(`plan[${index}].transactionSequenceMutations[${mutationIndex}] invalid`);
    }
  });
  value.grantMutations.forEach((mutation, mutationIndex) => exactObjectKeys(mutation, [
    'grantId', 'expectedRemainingAmountUsd', 'expectedRemainingPaidAmountUsd',
    'expectedRemainingBonusAmountUsd', 'remainingAmountUsd', 'remainingPaidAmountUsd',
    'remainingBonusAmountUsd',
  ], `plan[${index}].grantMutations[${mutationIndex}]`));
  value.allocationMutations.forEach((mutation, mutationIndex) => {
    const label = `plan[${index}].allocationMutations[${mutationIndex}]`;
    exactObjectKeys(mutation, [
      'allocationId', 'expectedSettledUsd', 'expectedRecognizedRevenueUsd',
      'expectedBonusConsumedUsd', 'expectedSettledAt', 'settledUsd', 'recognizedRevenueUsd',
      'bonusConsumedUsd', 'settledAt',
    ], label);
    const row = mutation as Record<string, unknown>;
    const moneyFields = [
      'expectedSettledUsd',
      'expectedRecognizedRevenueUsd',
      'expectedBonusConsumedUsd',
      'settledUsd',
      'recognizedRevenueUsd',
      'bonusConsumedUsd',
    ];
    const canonicalInstant = (value: unknown): boolean => {
      if (value === null) return true;
      if (typeof value !== 'string') return false;
      const parsed = new Date(value);
      return Number.isFinite(parsed.getTime()) && parsed.toISOString() === value;
    };
    if (
      typeof row.allocationId !== 'string'
      || row.allocationId.length === 0
      || moneyFields.some((field) => (
        typeof row[field] !== 'string' || !/^-?\d+\.\d{12}$/.test(row[field] as string)
      ))
      || !canonicalInstant(row.expectedSettledAt)
      || !canonicalInstant(row.settledAt)
    ) {
      throw new Error(`${label} invalid`);
    }
  });
  value.allocationSequenceMutations.forEach((mutation, mutationIndex) => exactObjectKeys(mutation, [
    'allocationId', 'expectedLedgerSequence', 'ledgerSequence',
  ], `plan[${index}].allocationSequenceMutations[${mutationIndex}]`));
  value.unreconciledGrantMutations.forEach((mutation, mutationIndex) => exactObjectKeys(mutation, [
    'allocationId', 'expectedSource', 'expectedBalanceGrantId', 'expectedAmountUsd',
    'expectedRecognizedRevenueUsd', 'expectedBonusConsumedUsd', 'expectedDiscountRate',
    'expectedSettledUsd', 'expectedSettledAt', 'expectedLedgerSequence', 'source',
    'balanceGrantId', 'recognizedRevenueUsd', 'bonusConsumedUsd', 'discountRate',
  ], `plan[${index}].unreconciledGrantMutations[${mutationIndex}]`));
  value.canonicalAllocationMutations.forEach((mutation, mutationIndex) => exactObjectKeys(mutation, [
    'allocationId', 'expectedUserId', 'expectedTenantId', 'expectedProductId',
    'expectedBalanceTransactionId', 'expectedTokenUsageId', 'expectedBalanceGrantId',
    'expectedSource', 'expectedAmountUsd', 'expectedRecognizedRevenueUsd',
    'expectedBonusConsumedUsd', 'expectedDiscountRate', 'expectedSettledUsd',
    'expectedSettledAt', 'expectedLedgerSequence', 'expectedCreatedAt',
    'balanceGrantId', 'amountUsd', 'recognizedRevenueUsd', 'bonusConsumedUsd',
    'discountRate', 'ledgerSequence',
  ], `plan[${index}].canonicalAllocationMutations[${mutationIndex}]`));
  value.migrationOpeningDebtMutations.forEach((mutation, mutationIndex) => {
    const label = `plan[${index}].migrationOpeningDebtMutations[${mutationIndex}]`;
    exactObjectKeys(mutation, [
      'allocationId', 'grantId', 'expectedGrant', 'expectedUserId', 'expectedTenantId',
      'expectedProductId', 'expectedBalanceTransactionId', 'expectedTokenUsageId',
      'expectedBalanceGrantId', 'expectedSource', 'expectedAmountUsd',
      'expectedRecognizedRevenueUsd', 'expectedBonusConsumedUsd', 'expectedDiscountRate',
      'expectedSettledUsd', 'expectedSettledAt', 'expectedLedgerSequence',
      'expectedCreatedAt', 'source', 'balanceGrantId', 'amountUsd',
      'recognizedRevenueUsd', 'bonusConsumedUsd', 'discountRate', 'settledUsd',
      'settledAt', 'ledgerSequence',
    ], label);
    const expectedGrant = mutation.expectedGrant && typeof mutation.expectedGrant === 'object'
      && !Array.isArray(mutation.expectedGrant)
      ? mutation.expectedGrant as Record<string, unknown>
      : null;
    if (
      typeof mutation.allocationId !== 'string'
      || typeof mutation.grantId !== 'string'
      || expectedGrant === null
      || expectedGrant.id !== mutation.grantId
      || expectedGrant.source !== 'MIGRATION_OPENING'
      || typeof mutation.expectedUserId !== 'string'
      || typeof mutation.expectedTenantId !== 'string'
      || !(typeof mutation.expectedProductId === 'string' || mutation.expectedProductId === null)
      || typeof mutation.expectedBalanceTransactionId !== 'string'
      || !(typeof mutation.expectedTokenUsageId === 'string' || mutation.expectedTokenUsageId === null)
      || mutation.expectedBalanceGrantId !== mutation.grantId
      || mutation.expectedSource !== 'BALANCE_GRANT'
      || mutation.expectedSettledAt !== null
      || !(typeof mutation.expectedLedgerSequence === 'string' || mutation.expectedLedgerSequence === null)
      || typeof mutation.expectedCreatedAt !== 'string'
      || mutation.source !== 'NEGATIVE_BALANCE'
      || mutation.balanceGrantId !== null
      || mutation.discountRate !== '0.000000000000'
      || !(typeof mutation.settledAt === 'string' || mutation.settledAt === null)
      || !(typeof mutation.ledgerSequence === 'string' || mutation.ledgerSequence === null)
    ) {
      throw new Error(`${label} invalid`);
    }
  });
  value.personalDebtAllocationMutations.forEach((mutation, mutationIndex) => {
    const label = `plan[${index}].personalDebtAllocationMutations[${mutationIndex}]`;
    exactObjectKeys(mutation, [
      'proofVersion', 'repairKind', 'transactionId', 'sourceAllocationId',
      'createdDebtAllocationId', 'expectedTransactionBeforeUsd',
      'expectedTransactionAfterUsd', 'expectedSourceAllocation', 'targetSourceAllocation',
      'targetDebtAllocation',
    ], label);
    assertRepairAllocationSnapshot(
      mutation.expectedSourceAllocation,
      `${label}.expectedSourceAllocation`,
    );
    assertRepairAllocationSnapshot(
      mutation.targetSourceAllocation,
      `${label}.targetSourceAllocation`,
    );
    const expected = mutation.expectedSourceAllocation;
    const target = mutation.targetSourceAllocation;
    const split = mutation.repairKind === 'LEGACY_DEBT_SPLIT_V1';
    const reclass = mutation.repairKind === 'LEGACY_DEBT_RECLASS_V1';
    if (split) {
      assertRepairAllocationSnapshot(
        mutation.targetDebtAllocation,
        `${label}.targetDebtAllocation`,
      );
    }
    const debt = split
      ? mutation.targetDebtAllocation as Record<string, unknown>
      : null;
    if (
      mutation.proofVersion !== 1
      || (!split && !reclass)
      || typeof mutation.transactionId !== 'string' || mutation.transactionId.length === 0
      || typeof mutation.sourceAllocationId !== 'string' || mutation.sourceAllocationId.length === 0
      || typeof mutation.expectedTransactionBeforeUsd !== 'string'
      || !CANONICAL_MONEY.test(mutation.expectedTransactionBeforeUsd)
      || typeof mutation.expectedTransactionAfterUsd !== 'string'
      || !CANONICAL_MONEY.test(mutation.expectedTransactionAfterUsd)
      || expected.id !== mutation.sourceAllocationId
      || target.id !== mutation.sourceAllocationId
      || expected.billingAccountId !== value.billingAccountId
      || target.billingAccountId !== value.billingAccountId
      || expected.balanceTransactionId !== mutation.transactionId
      || target.balanceTransactionId !== mutation.transactionId
      || expected.source !== 'BALANCE_GRANT'
      || !sameAllocationIdentity(expected, target)
      || (split && (
        typeof mutation.createdDebtAllocationId !== 'string'
        || mutation.createdDebtAllocationId
          !== `repair-negative-balance-split:${mutation.sourceAllocationId}`
        || target.source !== 'BALANCE_GRANT'
        || debt?.id !== mutation.createdDebtAllocationId
        || debt?.billingAccountId !== value.billingAccountId
        || debt?.balanceTransactionId !== mutation.transactionId
        || debt?.source !== 'NEGATIVE_BALANCE'
        || debt?.balanceGrantId !== null
      ))
      || (reclass && (
        mutation.createdDebtAllocationId !== null
        || mutation.targetDebtAllocation !== null
        || target.source !== 'NEGATIVE_BALANCE'
        || target.balanceGrantId !== null
      ))
    ) {
      throw new Error(`${label} invalid`);
    }
  });
  value.legacyVoucherProofMutations.forEach((mutation, mutationIndex) => {
    const label = `plan[${index}].legacyVoucherProofMutations[${mutationIndex}]`;
    exactObjectKeys(mutation, [
      'proofVersion', 'repairKind', 'transactionId', 'grantId', 'walletBeforeUsd',
      'walletAfterUsd', 'holeFillUsd', 'mintedGrantAmountUsd', 'expectedTransaction',
      'expectedGrant', 'expectedIdempotencyEvidence', 'openingDebtAllocationIds',
    ], label);
    assertRepairTransactionSnapshot(mutation.expectedTransaction, `${label}.expectedTransaction`);
    assertRepairGrantSnapshot(mutation.expectedGrant, `${label}.expectedGrant`);
    if (!Array.isArray(mutation.expectedIdempotencyEvidence)) {
      throw new Error(`${label}.expectedIdempotencyEvidence invalid`);
    }
    mutation.expectedIdempotencyEvidence.forEach((evidence, evidenceIndex) => (
      assertVoucherIdempotencyEvidence(
        evidence,
        `${label}.expectedIdempotencyEvidence[${evidenceIndex}]`,
      )
    ));
    const preIdempotency = mutation.repairKind === 'LEGACY_PRE_IDEMPOTENCY_VOUCHER_V1';
    const expiredPreIdempotency = mutation.repairKind
      === 'LEGACY_PRE_IDEMPOTENCY_EXPIRED_VOUCHER_V1';
    const fullAbsorption = mutation.repairKind
      === 'LEGACY_VOUCHER_FULL_REMAINDER_DEBT_ABSORPTION_V1';
    const moneyFields = ['walletBeforeUsd', 'walletAfterUsd', 'holeFillUsd',
      'mintedGrantAmountUsd'] as const;
    const openingDebtAllocationIds = Array.isArray(mutation.openingDebtAllocationIds)
      ? mutation.openingDebtAllocationIds
      : null;
    if (
      mutation.proofVersion !== 1
      || (!preIdempotency && !expiredPreIdempotency && !fullAbsorption)
      || typeof mutation.transactionId !== 'string' || mutation.transactionId.length === 0
      || typeof mutation.grantId !== 'string' || mutation.grantId.length === 0
      || mutation.expectedTransaction.id !== mutation.transactionId
      || mutation.expectedGrant.id !== mutation.grantId
      || moneyFields.some((field) => (
        typeof mutation[field] !== 'string' || !CANONICAL_MONEY.test(mutation[field] as string)
      ))
      || openingDebtAllocationIds === null
      || openingDebtAllocationIds.some((id) => typeof id !== 'string' || id.length === 0)
      || new Set(openingDebtAllocationIds).size !== openingDebtAllocationIds.length
      || [...openingDebtAllocationIds].sort((left, right) => left.localeCompare(right))
        .some((id, idIndex) => id !== openingDebtAllocationIds[idIndex])
      || ((preIdempotency || expiredPreIdempotency)
        && mutation.expectedIdempotencyEvidence.length !== 0)
      || ((preIdempotency || fullAbsorption)
        && mutation.expectedGrant.isExpired !== false)
      || (expiredPreIdempotency && (
        mutation.expectedGrant.isExpired !== true
        || new Prisma.Decimal(mutation.walletBeforeUsd as string).lt(0)
        || !new Prisma.Decimal(mutation.holeFillUsd as string).eq(0)
      ))
      || (fullAbsorption && mutation.expectedIdempotencyEvidence.length !== 1)
    ) {
      throw new Error(`${label} invalid`);
    }
  });
  value.legacyExpiryProofMutations.forEach((mutation, mutationIndex) => {
    const label = `plan[${index}].legacyExpiryProofMutations[${mutationIndex}]`;
    exactObjectKeys(mutation, [
      'proofVersion', 'repairKind', 'grantId', 'transactionId', 'expiryAuditId',
      'nominalAmountUsd', 'nominalPaidUsd', 'nominalBonusUsd',
      'walletBalanceBeforeUsd', 'walletBalanceAfterUsd', 'expectedTransaction',
      'expectedGrant',
    ], label);
    assertRepairTransactionSnapshot(mutation.expectedTransaction, `${label}.expectedTransaction`);
    assertRepairGrantSnapshot(mutation.expectedGrant, `${label}.expectedGrant`);
    const moneyFields = [
      'nominalAmountUsd', 'nominalPaidUsd', 'nominalBonusUsd',
      'walletBalanceBeforeUsd', 'walletBalanceAfterUsd',
    ] as const;
    if (
      mutation.proofVersion !== 1
      || mutation.repairKind !== 'LEGACY_INLINE_EXPIRY_V1'
      || typeof mutation.grantId !== 'string' || mutation.grantId.length === 0
      || typeof mutation.transactionId !== 'string' || mutation.transactionId.length === 0
      || mutation.expiryAuditId !== `repair-legacy-expiry:${mutation.grantId}`
      || mutation.expectedGrant.id !== mutation.grantId
      || mutation.expectedGrant.isExpired !== true
      || mutation.expectedTransaction.id !== mutation.transactionId
      || mutation.expectedTransaction.type !== 'ADJUST'
      || mutation.expectedTransaction.description !== `balance grant expired:${mutation.grantId}`
      || mutation.expectedTransaction.tokenUsageId !== null
      || mutation.expectedTransaction.operationKey !== null
      || mutation.expectedTransaction.ledgerSequence !== null
      || moneyFields.some((field) => (
        typeof mutation[field] !== 'string' || !CANONICAL_MONEY.test(mutation[field] as string)
      ))
    ) {
      throw new Error(`${label} invalid`);
    }
  });
  if (value.invoiceStabilityProof !== null) {
    const label = `plan[${index}].invoiceStabilityProof`;
    exactObjectKeys(value.invoiceStabilityProof, [
      'proofVersion', 'repairKind', 'orderCount', 'applicationCount', 'itemCount',
      'eventCount', 'evidenceSha256',
    ], label);
    const proof = value.invoiceStabilityProof;
    if (
      proof.proofVersion !== 1
      || proof.repairKind !== 'ISSUED_INVOICE_STABILITY_V1'
      || !Number.isInteger(proof.orderCount) || (proof.orderCount as number) <= 0
      || !Number.isInteger(proof.applicationCount) || (proof.applicationCount as number) <= 0
      || !Number.isInteger(proof.itemCount) || (proof.itemCount as number) <= 0
      || !Number.isInteger(proof.eventCount) || (proof.eventCount as number) <= 0
      || typeof proof.evidenceSha256 !== 'string'
      || !/^(?!0{64}$)[0-9a-f]{64}$/.test(proof.evidenceSha256)
    ) {
      throw new Error(`${label} invalid`);
    }
  }
  if (
    (value.personalDebtAllocationMutations.length > 0
      || value.legacyVoucherProofMutations.length > 0
      || value.legacyExpiryProofMutations.length > 0)
    && (value.accountType !== 'personal' || value.debtSource !== 'NEGATIVE_BALANCE')
  ) {
    throw new Error(`plan[${index}] legacy personal proof account shape invalid`);
  }
  const personalTransactionIds = value.personalDebtAllocationMutations.map(
    (mutation) => mutation.transactionId,
  );
  const personalSourceIds = value.personalDebtAllocationMutations.map(
    (mutation) => mutation.sourceAllocationId,
  );
  const voucherTransactionIds = value.legacyVoucherProofMutations.map(
    (mutation) => mutation.transactionId,
  );
  const voucherGrantIds = value.legacyVoucherProofMutations.map((mutation) => mutation.grantId);
  const expiryTransactionIds = value.legacyExpiryProofMutations.map(
    (mutation) => mutation.transactionId,
  );
  const expiryGrantIds = value.legacyExpiryProofMutations.map((mutation) => mutation.grantId);
  const expiryAuditIds = value.legacyExpiryProofMutations.map((mutation) => mutation.expiryAuditId);
  if (
    new Set(personalTransactionIds).size !== personalTransactionIds.length
    || new Set(personalSourceIds).size !== personalSourceIds.length
    || new Set(voucherTransactionIds).size !== voucherTransactionIds.length
    || new Set(voucherGrantIds).size !== voucherGrantIds.length
    || new Set(expiryTransactionIds).size !== expiryTransactionIds.length
    || new Set(expiryGrantIds).size !== expiryGrantIds.length
    || new Set(expiryAuditIds).size !== expiryAuditIds.length
  ) {
    throw new Error(`plan[${index}] legacy personal proof identifiers are not unique`);
  }
  if (value.legacyVoucherProofMutations.some((mutation) => (
    mutation.repairKind === 'LEGACY_PRE_IDEMPOTENCY_EXPIRED_VOUCHER_V1'
      && !expiryGrantIds.includes(mutation.grantId)
  ))) {
    throw new Error(`plan[${index}] expired voucher proof is missing its expiry proof`);
  }
  value.settlementMutations.forEach((mutation, mutationIndex) => exactObjectKeys(mutation, [
    'sequence', 'allocationId', 'repaymentTransactionId', 'balanceGrantId', 'debtSource', 'fundingNature',
    'amountUsd', 'paidUsd', 'bonusUsd', 'occurredAt',
  ], `plan[${index}].settlementMutations[${mutationIndex}]`));
  const adminFundingReceiptKeys = new Set<string>();
  const adminFundingTransactionIds = new Set<string>();
  const adminFundingGrantIds = new Set<string>();
  let previousAdminFundingTransactionId: string | null = null;
  value.legacyAdminFundingRepairs.forEach((mutation, mutationIndex) => {
    const label = `plan[${index}].legacyAdminFundingRepairs[${mutationIndex}]`;
    exactObjectKeys(mutation, [
      'repairKind', 'action', 'idempotencyKey', 'idempotencyScope',
      'idempotencyEvidenceHash', 'proofHash', 'transactionId', 'grantId',
      'userId', 'tenantId', 'billingAccountId', 'productId', 'amountUsd',
      'initialRemainingAmountUsd', 'expectedGrantSnapshotHash',
      'expectedGrantRemainingAmountUsd', 'expectedGrantRemainingPaidAmountUsd',
      'expectedGrantRemainingBonusAmountUsd', 'finalRemainingAmountUsd',
      'finalRemainingPaidAmountUsd', 'finalRemainingBonusAmountUsd',
      'validFrom', 'expiresAt', 'createdAt',
    ], label);
    const row = mutation as Record<string, unknown>;
    const nonEmptyStringFields = [
      'idempotencyKey', 'transactionId', 'grantId', 'userId', 'tenantId', 'billingAccountId',
    ];
    const moneyFields = [
      'amountUsd', 'initialRemainingAmountUsd', 'finalRemainingAmountUsd',
      'finalRemainingPaidAmountUsd', 'finalRemainingBonusAmountUsd',
    ];
    const canonicalInstant = (instant: unknown): instant is string => {
      if (typeof instant !== 'string') return false;
      const parsed = new Date(instant);
      return Number.isFinite(parsed.getTime()) && parsed.toISOString() === instant;
    };
    if (
      row.repairKind !== LEGACY_ADMIN_FUNDING_REPAIR_KIND
      || (row.action !== 'CREATE_GRANT' && row.action !== 'LINK_GRANT')
      || (row.idempotencyScope !== 'admin:adjust-balance'
        && row.idempotencyScope !== 'admin:recharge')
      || nonEmptyStringFields.some((field) => (
        typeof row[field] !== 'string'
        || (row[field] as string).length === 0
        || (row[field] as string).trim() !== row[field]
      ))
      || typeof row.idempotencyKey !== 'string'
      || row.idempotencyKey.length > 160
      || /\s/.test(row.idempotencyKey)
      || typeof row.idempotencyEvidenceHash !== 'string'
      || !/^[0-9a-f]{64}$/.test(row.idempotencyEvidenceHash)
      || /^0{64}$/.test(row.idempotencyEvidenceHash)
      || typeof row.proofHash !== 'string'
      || !/^[0-9a-f]{64}$/.test(row.proofHash)
      || /^0{64}$/.test(row.proofHash)
      || !(row.expectedGrantSnapshotHash === null
        || (typeof row.expectedGrantSnapshotHash === 'string'
          && /^[0-9a-f]{64}$/.test(row.expectedGrantSnapshotHash)
          && !/^0{64}$/.test(row.expectedGrantSnapshotHash)))
      || !(row.expectedGrantRemainingAmountUsd === null
        || (typeof row.expectedGrantRemainingAmountUsd === 'string'
          && /^-?\d+\.\d{12}$/.test(row.expectedGrantRemainingAmountUsd)))
      || !(row.expectedGrantRemainingPaidAmountUsd === null
        || (typeof row.expectedGrantRemainingPaidAmountUsd === 'string'
          && /^-?\d+\.\d{12}$/.test(row.expectedGrantRemainingPaidAmountUsd)))
      || !(row.expectedGrantRemainingBonusAmountUsd === null
        || (typeof row.expectedGrantRemainingBonusAmountUsd === 'string'
          && /^-?\d+\.\d{12}$/.test(row.expectedGrantRemainingBonusAmountUsd)))
      || !(typeof row.productId === 'string' || row.productId === null)
      || (typeof row.productId === 'string'
        && (row.productId.length === 0 || row.productId.trim() !== row.productId))
      || moneyFields.some((field) => (
        typeof row[field] !== 'string' || !/^-?\d+\.\d{12}$/.test(row[field] as string)
      ))
      || !canonicalInstant(row.validFrom)
      || !canonicalInstant(row.expiresAt)
      || !canonicalInstant(row.createdAt)
      || row.billingAccountId !== value.billingAccountId
      || value.accountType !== 'enterprise'
      || !row.idempotencyKey.startsWith(`enterprise-recharge:${value.billingAccountId}:`)
      || row.idempotencyKey === `enterprise-recharge:${value.billingAccountId}:`
      || (row.action === 'CREATE_GRANT'
        ? row.idempotencyScope !== 'admin:adjust-balance'
          || row.grantId !== `repair-enterprise-admin-funding:${row.transactionId}`
          || row.expectedGrantSnapshotHash !== null
          || row.expectedGrantRemainingAmountUsd !== null
          || row.expectedGrantRemainingPaidAmountUsd !== null
          || row.expectedGrantRemainingBonusAmountUsd !== null
        : row.idempotencyScope !== 'admin:recharge'
          || row.expectedGrantSnapshotHash === null
          || row.expectedGrantRemainingAmountUsd === null)
    ) {
      throw new Error(`${label} invalid`);
    }
    const amountUsd = new Prisma.Decimal(row.amountUsd as string);
    const initialRemainingUsd = new Prisma.Decimal(row.initialRemainingAmountUsd as string);
    const finalRemainingUsd = new Prisma.Decimal(row.finalRemainingAmountUsd as string);
    const finalRemainingPaidUsd = new Prisma.Decimal(row.finalRemainingPaidAmountUsd as string);
    const finalRemainingBonusUsd = new Prisma.Decimal(row.finalRemainingBonusAmountUsd as string);
    const expectedGrantRemainingUsd = row.expectedGrantRemainingAmountUsd === null
      ? null
      : new Prisma.Decimal(row.expectedGrantRemainingAmountUsd as string);
    const expectedGrantRemainingPaidUsd = row.expectedGrantRemainingPaidAmountUsd === null
      ? null
      : new Prisma.Decimal(row.expectedGrantRemainingPaidAmountUsd as string);
    const expectedGrantRemainingBonusUsd = row.expectedGrantRemainingBonusAmountUsd === null
      ? null
      : new Prisma.Decimal(row.expectedGrantRemainingBonusAmountUsd as string);
    const expectedExpiresAt = new Date(row.validFrom as string);
    expectedExpiresAt.setUTCDate(expectedExpiresAt.getUTCDate() + 365);
    if (
      amountUsd.lte(0)
      || initialRemainingUsd.lt(0)
      || initialRemainingUsd.gt(amountUsd)
      || finalRemainingUsd.lt(0)
      || finalRemainingUsd.gt(initialRemainingUsd)
      || !finalRemainingPaidUsd.eq(finalRemainingUsd)
      || !finalRemainingBonusUsd.eq(0)
      || (row.action === 'LINK_GRANT' && (
        expectedGrantRemainingUsd === null
        || expectedGrantRemainingUsd.lt(0)
        || expectedGrantRemainingUsd.gt(amountUsd)
        || ((expectedGrantRemainingPaidUsd === null) !== (expectedGrantRemainingBonusUsd === null))
        || (expectedGrantRemainingPaidUsd !== null
          && expectedGrantRemainingBonusUsd !== null
          && (
            expectedGrantRemainingPaidUsd.lt(0)
            || expectedGrantRemainingBonusUsd.lt(0)
            || expectedGrantRemainingPaidUsd.gt(amountUsd)
            || expectedGrantRemainingBonusUsd.gt(amountUsd)
            || !expectedGrantRemainingPaidUsd.plus(expectedGrantRemainingBonusUsd)
              .eq(expectedGrantRemainingUsd)
          ))
      ))
      || expectedExpiresAt.toISOString() !== row.expiresAt
      || new Date(row.validFrom as string).getTime() > new Date(row.createdAt as string).getTime()
      || (row.action === 'CREATE_GRANT' && row.validFrom !== row.createdAt)
    ) {
      throw new Error(`${label} invalid canonical paid grant`);
    }
    const receiptKey = `${row.idempotencyScope}:${row.idempotencyKey}`;
    if (
      adminFundingReceiptKeys.has(receiptKey)
      || adminFundingTransactionIds.has(row.transactionId as string)
      || adminFundingGrantIds.has(row.grantId as string)
      || (previousAdminFundingTransactionId !== null
        && previousAdminFundingTransactionId.localeCompare(row.transactionId as string) >= 0)
    ) {
      throw new Error(`${label} duplicate or non-canonical order`);
    }
    adminFundingReceiptKeys.add(receiptKey);
    adminFundingTransactionIds.add(row.transactionId as string);
    adminFundingGrantIds.add(row.grantId as string);
    previousAdminFundingTransactionId = row.transactionId as string;
  });
  const plan = value as BalanceLedgerRepairPlan;
  if (plan.status !== 'READY' || balanceLedgerRepairReplayHash(plan) !== plan.replayHash) {
    throw new Error(`plan[${index}] canonical replay hash mismatch`);
  }
  return plan;
}

function settlementOperationKey(
  runId: string,
  settlement: Extract<BalanceLedgerRepairPlan, { status: 'READY' }>['settlementMutations'][number],
): string {
  return `repair:${runId}:${settlement.repaymentTransactionId}:${
    settlement.allocationId
  }:${settlement.sequence}`;
}

export type VoucherApprovalRefs = {
  financeApprovalRef: string;
  technicalApprovalRef: string;
};

export function resolveVoucherApprovalRefs(
  plans: BalanceLedgerRepairPlan[],
  financeApprovalRef: string | undefined,
  technicalApprovalRef: string | undefined,
): VoucherApprovalRefs | null {
  const required = plans.some((plan) => (
    plan.status === 'READY' && (
      plan.legacyVoucherProofMutations.length > 0
      || plan.legacyExpiryProofMutations.length > 0
      || plan.invoiceStabilityProof !== null
    )
  ));
  if (!required) return null;
  const finance = financeApprovalRef?.trim() ?? '';
  const technical = technicalApprovalRef?.trim() ?? '';
  if (finance.length === 0 || finance.length > 200) {
    throw new Error('--finance-approval-ref must trim to 1..200 characters');
  }
  if (technical.length === 0 || technical.length > 200) {
    throw new Error('--technical-approval-ref must trim to 1..200 characters');
  }
  if (finance === technical) {
    throw new Error('finance and technical approval references must be different');
  }
  return {
    financeApprovalRef: finance,
    technicalApprovalRef: technical,
  };
}

export function assertExecutionProfilePlanSet(
  profile: BalanceLedgerRepairExecutionProfile,
  selectedBillingAccountId: string | undefined,
  plans: BalanceLedgerRepairPlan[],
): void {
  switch (profile.name) {
    case null:
      return;
    case INVOICE_STABILITY_EVIDENCE_PROFILE: {
      if (
        selectedBillingAccountId === undefined
        || plans.length !== 1
      ) {
        throw new Error('INVOICE_STABILITY_PROFILE_PLAN_SET_MISMATCH');
      }
      const plan = plans[0];
      if (
        plan.billingAccountId !== selectedBillingAccountId
        || plan.status !== 'READY'
        || plan.invoiceStabilityProof === null
        || plan.legacyVoucherProofMutations.length > 0
        || plan.legacyExpiryProofMutations.length > 0
        || plan.legacyAdminFundingRepairs.length > 0
      ) {
        throw new Error('INVOICE_STABILITY_PROFILE_PLAN_SET_MISMATCH');
      }
      return;
    }
    case HK_UAT_TWO_ACCOUNT_PROFILE:
    case HK_UAT_REMAINING_ACCOUNT_PROFILE: {
      if (!profile.billingAccountIds) {
        throw new Error('HK_UAT_PROFILE_PLAN_SET_MISMATCH');
      }
      const expectedIds = [...profile.billingAccountIds].sort();
      const actualIds = plans.map((plan) => plan.billingAccountId).sort();
      if (
        plans.some((plan) => plan.status !== 'READY')
        || JSON.stringify(actualIds) !== JSON.stringify(expectedIds)
      ) {
        throw new Error('HK_UAT_PROFILE_PLAN_SET_MISMATCH');
      }
      return;
    }
    default:
      return unreachableMaintenanceProfile(profile.name);
  }
}

type AllocationFinancialPatch = {
  source?: string;
  balanceGrantId?: string | null;
  amountUsd?: string;
  recognizedRevenueUsd?: string;
  bonusConsumedUsd?: string;
  discountRate?: string;
  settledUsd?: string;
  settledAt?: string | null;
  ledgerSequence?: string | null;
};

type AllocationMutationComponent = {
  allocationId: string;
  expected: AllocationFinancialPatch;
  target: AllocationFinancialPatch;
  canonical?: {
    [key: string]: unknown;
    expectedUserId: string | null;
    expectedTenantId: string | null;
    expectedProductId: string | null;
    expectedBalanceTransactionId: string;
    expectedTokenUsageId: string | null;
    expectedCreatedAt: string;
  };
};

function* allocationMutationComponents(
  plan: Extract<BalanceLedgerRepairPlan, { status: 'READY' }>,
): Generator<AllocationMutationComponent> {
  for (const mutation of plan.canonicalAllocationMutations) {
    yield {
      allocationId: mutation.allocationId,
      canonical: mutation,
      expected: {
        source: mutation.expectedSource,
        balanceGrantId: mutation.expectedBalanceGrantId,
        amountUsd: mutation.expectedAmountUsd,
        recognizedRevenueUsd: mutation.expectedRecognizedRevenueUsd,
        bonusConsumedUsd: mutation.expectedBonusConsumedUsd,
        discountRate: mutation.expectedDiscountRate,
        settledUsd: mutation.expectedSettledUsd,
        settledAt: mutation.expectedSettledAt,
        ledgerSequence: mutation.expectedLedgerSequence,
      },
      target: {
        source: 'BALANCE_GRANT',
        balanceGrantId: mutation.balanceGrantId,
        amountUsd: mutation.amountUsd,
        recognizedRevenueUsd: mutation.recognizedRevenueUsd,
        bonusConsumedUsd: mutation.bonusConsumedUsd,
        discountRate: mutation.discountRate,
        settledUsd: mutation.expectedSettledUsd,
        settledAt: mutation.expectedSettledAt,
        ledgerSequence: mutation.ledgerSequence,
      },
    };
  }
  for (const mutation of plan.migrationOpeningDebtMutations) {
    yield {
      allocationId: mutation.allocationId,
      canonical: mutation,
      expected: {
        source: mutation.expectedSource,
        balanceGrantId: mutation.expectedBalanceGrantId,
        amountUsd: mutation.expectedAmountUsd,
        recognizedRevenueUsd: mutation.expectedRecognizedRevenueUsd,
        bonusConsumedUsd: mutation.expectedBonusConsumedUsd,
        discountRate: mutation.expectedDiscountRate,
        settledUsd: mutation.expectedSettledUsd,
        settledAt: mutation.expectedSettledAt,
        ledgerSequence: mutation.expectedLedgerSequence,
      },
      target: {
        source: mutation.source,
        balanceGrantId: mutation.balanceGrantId,
        amountUsd: mutation.amountUsd,
        recognizedRevenueUsd: mutation.recognizedRevenueUsd,
        bonusConsumedUsd: mutation.bonusConsumedUsd,
        discountRate: mutation.discountRate,
        settledUsd: mutation.settledUsd,
        settledAt: mutation.settledAt,
        ledgerSequence: mutation.ledgerSequence,
      },
    };
  }
  for (const mutation of plan.personalDebtAllocationMutations) {
    const expected = mutation.expectedSourceAllocation;
    const target = mutation.targetSourceAllocation;
    yield {
      allocationId: mutation.sourceAllocationId,
      canonical: {
        expectedUserId: expected.userId ?? null,
        expectedTenantId: expected.tenantId ?? null,
        expectedProductId: expected.productId ?? null,
        expectedBalanceTransactionId: expected.balanceTransactionId,
        expectedTokenUsageId: expected.tokenUsageId ?? null,
        expectedCreatedAt: expected.createdAt,
      },
      expected: {
        source: expected.source,
        balanceGrantId: expected.balanceGrantId,
        amountUsd: expected.amountUsd,
        recognizedRevenueUsd: expected.recognizedRevenueUsd,
        bonusConsumedUsd: expected.bonusConsumedUsd,
        discountRate: expected.discountRate,
        settledUsd: expected.settledUsd,
        settledAt: expected.settledAt,
        ledgerSequence: expected.ledgerSequence,
      },
      target: {
        source: target.source,
        balanceGrantId: target.balanceGrantId,
        amountUsd: target.amountUsd,
        recognizedRevenueUsd: target.recognizedRevenueUsd,
        bonusConsumedUsd: target.bonusConsumedUsd,
        discountRate: target.discountRate,
        settledUsd: target.settledUsd,
        settledAt: target.settledAt,
        ledgerSequence: target.ledgerSequence,
      },
    };
  }
  for (const mutation of plan.unreconciledGrantMutations) {
    yield {
      allocationId: mutation.allocationId,
      expected: {
        source: mutation.expectedSource,
        balanceGrantId: mutation.expectedBalanceGrantId,
        amountUsd: mutation.expectedAmountUsd,
        recognizedRevenueUsd: mutation.expectedRecognizedRevenueUsd,
        bonusConsumedUsd: mutation.expectedBonusConsumedUsd,
        discountRate: mutation.expectedDiscountRate,
        settledUsd: mutation.expectedSettledUsd,
        settledAt: mutation.expectedSettledAt,
        ledgerSequence: mutation.expectedLedgerSequence,
      },
      target: {
        source: mutation.source,
        balanceGrantId: mutation.balanceGrantId,
        amountUsd: mutation.expectedAmountUsd,
        recognizedRevenueUsd: mutation.recognizedRevenueUsd,
        bonusConsumedUsd: mutation.bonusConsumedUsd,
        discountRate: mutation.discountRate,
        settledUsd: mutation.expectedSettledUsd,
        settledAt: mutation.expectedSettledAt,
        ledgerSequence: mutation.expectedLedgerSequence,
      },
    };
  }
  for (const mutation of plan.allocationSequenceMutations) {
    yield {
      allocationId: mutation.allocationId,
      expected: { ledgerSequence: mutation.expectedLedgerSequence },
      target: { ledgerSequence: mutation.ledgerSequence },
    };
  }
  for (const mutation of plan.allocationMutations) {
    yield {
      allocationId: mutation.allocationId,
      expected: {
        source: plan.debtSource,
        balanceGrantId: null,
        recognizedRevenueUsd: mutation.expectedRecognizedRevenueUsd,
        bonusConsumedUsd: mutation.expectedBonusConsumedUsd,
        discountRate: '0.000000000000',
        settledUsd: mutation.expectedSettledUsd,
        settledAt: mutation.expectedSettledAt,
      },
      target: {
        source: plan.debtSource,
        balanceGrantId: null,
        recognizedRevenueUsd: mutation.recognizedRevenueUsd,
        bonusConsumedUsd: mutation.bonusConsumedUsd,
        discountRate: '0.000000000000',
        settledUsd: mutation.settledUsd,
        settledAt: mutation.settledAt,
      },
    };
  }
}

async function writeBoundedJsonChunks<T>(
  values: Iterable<T>,
  write: (json: string) => Promise<void>,
): Promise<{
  chunkCount: number;
  rowCount: number;
  maxRows: number;
  maxJsonBytes: number;
}> {
  let parts: string[] = [];
  let bytes = 2;
  let chunkCount = 0;
  let rowCount = 0;
  let maxRows = 0;
  let maxJsonBytes = 0;
  const flush = async () => {
    if (parts.length === 0) return;
    await write(`[${parts.join(',')}]`);
    chunkCount += 1;
    rowCount += parts.length;
    maxRows = Math.max(maxRows, parts.length);
    maxJsonBytes = Math.max(maxJsonBytes, bytes);
    parts = [];
    bytes = 2;
  };
  for (const value of values) {
    const json = JSON.stringify(value);
    const valueBytes = Buffer.byteLength(json, 'utf8');
    if (valueBytes + 2 > BOUNDED_STAGE_MAX_JSON_BYTES) {
      throw new Error(
        `BOUNDED_STAGE_MUTATION_TOO_LARGE:bytes=${valueBytes}:max=${BOUNDED_STAGE_MAX_JSON_BYTES}`,
      );
    }
    const nextBytes = bytes + valueBytes + (parts.length === 0 ? 0 : 1);
    if (
      parts.length >= BOUNDED_STAGE_MAX_ROWS
      || nextBytes > BOUNDED_STAGE_MAX_JSON_BYTES
    ) {
      await flush();
    }
    parts.push(json);
    bytes += valueBytes + (parts.length === 1 ? 0 : 1);
  }
  await flush();
  return { chunkCount, rowCount, maxRows, maxJsonBytes };
}

export function assertEnterpriseVerifiedAllocationMutations(
  plan: Extract<BalanceLedgerRepairPlan, { status: 'READY' }>,
): void {
  if (plan.settlementWriteMode !== 'VERIFY_EXISTING') return;
  if (
    plan.accountType !== 'enterprise'
    || plan.debtSource !== 'ENTERPRISE_CREDIT'
    || plan.unreconciledGrantMutations.length > 0
    || plan.migrationOpeningDebtMutations.length > 0
    || plan.personalDebtAllocationMutations.length > 0
    || plan.legacyVoucherProofMutations.length > 0
    || plan.legacyExpiryProofMutations.length > 0
    || plan.invoiceStabilityProof !== null
  ) {
    throw new Error('ENTERPRISE_PROMOTION_MUTATION_SHAPE_INVALID');
  }
  const canonicalAllocationIds = new Set<string>();
  if (plan.canonicalAllocationMutations.length > 0) {
    if (plan.legacyAdminFundingRepairs.length === 0) {
      throw new Error('ENTERPRISE_CANONICAL_ALLOCATION_REQUIRES_FUNDING_PROOF');
    }
    const proofGrantIds = new Set(
      plan.legacyAdminFundingRepairs.map((repair) => repair.grantId),
    );
    const grantNode = (grantId: string) => `grant:${grantId}`;
    const proofGrantNodes = new Set([...proofGrantIds].map(grantNode));
    const existingGrantIds = new Set(
      plan.canonicalAllocationMutations.map((mutation) => mutation.expectedBalanceGrantId),
    );
    const graph = new Map<string, Set<string>>();
    const connect = (left: string, right: string) => {
      const leftEdges = graph.get(left) ?? new Set<string>();
      leftEdges.add(right);
      graph.set(left, leftEdges);
      const rightEdges = graph.get(right) ?? new Set<string>();
      rightEdges.add(left);
      graph.set(right, rightEdges);
    };
    for (const mutation of plan.canonicalAllocationMutations) {
      if (canonicalAllocationIds.has(mutation.allocationId)) {
        throw new Error(`ENTERPRISE_CANONICAL_ALLOCATION_DUPLICATE:${mutation.allocationId}`);
      }
      canonicalAllocationIds.add(mutation.allocationId);
      const expectedAmountUsd = new Prisma.Decimal(mutation.expectedAmountUsd);
      const expectedRevenueUsd = new Prisma.Decimal(mutation.expectedRecognizedRevenueUsd);
      const expectedBonusUsd = new Prisma.Decimal(mutation.expectedBonusConsumedUsd);
      const expectedDiscountRate = new Prisma.Decimal(mutation.expectedDiscountRate);
      const targetAmountUsd = new Prisma.Decimal(mutation.amountUsd);
      const targetRevenueUsd = new Prisma.Decimal(mutation.recognizedRevenueUsd);
      const targetBonusUsd = new Prisma.Decimal(mutation.bonusConsumedUsd);
      const targetDiscountRate = new Prisma.Decimal(mutation.discountRate);
      const expectedCreatedAt = new Date(mutation.expectedCreatedAt);
      // Positive values are online writer sequences; deterministic legacy
      // backfill uses negative values. Zero is never a valid ledger sequence.
      const expectedLedgerSequenceValid = mutation.expectedLedgerSequence === null
        || /^-?[1-9]\d*$/.test(mutation.expectedLedgerSequence);
      const targetLedgerSequenceValid = mutation.ledgerSequence === null
        || /^-?[1-9]\d*$/.test(mutation.ledgerSequence);
      const ledgerSequenceTransitionValid = mutation.expectedLedgerSequence === null
        || mutation.ledgerSequence === mutation.expectedLedgerSequence;
      const changed = mutation.expectedBalanceGrantId !== mutation.balanceGrantId
        || mutation.expectedAmountUsd !== mutation.amountUsd
        || mutation.expectedRecognizedRevenueUsd !== mutation.recognizedRevenueUsd
        || mutation.expectedBonusConsumedUsd !== mutation.bonusConsumedUsd
        || mutation.expectedDiscountRate !== mutation.discountRate;
      const expectedCanonicalDiscount = expectedAmountUsd.lte(0)
        ? null
        : expectedRevenueUsd.div(expectedAmountUsd)
          .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
      const targetCanonicalDiscount = targetAmountUsd.lte(0)
        ? null
        : targetRevenueUsd.div(targetAmountUsd)
          .toDecimalPlaces(12, Prisma.Decimal.ROUND_HALF_UP);
      if (
        mutation.expectedSource !== 'BALANCE_GRANT'
        || mutation.allocationId.length === 0
        || mutation.expectedUserId.length === 0
        || mutation.expectedTenantId.length === 0
        || mutation.expectedBalanceTransactionId.length === 0
        || mutation.expectedBalanceGrantId.length === 0
        || mutation.balanceGrantId.length === 0
        || mutation.expectedSettledAt !== null
        || !Number.isFinite(expectedCreatedAt.getTime())
        || expectedCreatedAt.toISOString() !== mutation.expectedCreatedAt
        || !expectedLedgerSequenceValid
        || !targetLedgerSequenceValid
        || !ledgerSequenceTransitionValid
        || expectedAmountUsd.lte(0)
        || expectedRevenueUsd.lt(0)
        || expectedBonusUsd.lt(0)
        || !expectedRevenueUsd.plus(expectedBonusUsd).eq(expectedAmountUsd)
        || expectedDiscountRate.lt(0)
        || expectedDiscountRate.gt(1)
        || expectedCanonicalDiscount === null
        || !expectedDiscountRate.eq(expectedCanonicalDiscount)
        || targetAmountUsd.lte(0)
        || targetRevenueUsd.lt(0)
        || targetBonusUsd.lt(0)
        || !targetRevenueUsd.plus(targetBonusUsd).eq(targetAmountUsd)
        || targetDiscountRate.lt(0)
        || targetDiscountRate.gt(1)
        || targetCanonicalDiscount === null
        || !targetDiscountRate.eq(targetCanonicalDiscount)
        || !changed
        || (!proofGrantIds.has(mutation.balanceGrantId)
          && !existingGrantIds.has(mutation.balanceGrantId))
      ) {
        throw new Error(`ENTERPRISE_CANONICAL_ALLOCATION_SHAPE_INVALID:${mutation.allocationId}`);
      }
      // A proof can shift FIFO attribution through several existing grants and
      // rows of the same consumption transaction. Model both as one connected
      // component, then require every component to terminate at a proved grant.
      const transactionNode = `transaction:${mutation.expectedBalanceTransactionId}`;
      connect(grantNode(mutation.expectedBalanceGrantId), transactionNode);
      connect(transactionNode, grantNode(mutation.balanceGrantId));
    }
    const visited = new Set<string>();
    for (const node of graph.keys()) {
      if (visited.has(node)) continue;
      const pending = [node];
      let proofConnected = false;
      while (pending.length > 0) {
        const current = pending.pop()!;
        if (visited.has(current)) continue;
        visited.add(current);
        if (proofGrantNodes.has(current)) proofConnected = true;
        for (const neighbour of graph.get(current) ?? []) pending.push(neighbour);
      }
      if (!proofConnected) {
        throw new Error(`ENTERPRISE_CANONICAL_ALLOCATION_NOT_PROOF_CONNECTED:${node}`);
      }
    }
  }
  const allocationIds = new Set<string>();
  for (const mutation of plan.allocationMutations) {
    if (allocationIds.has(mutation.allocationId)) {
      throw new Error(`ENTERPRISE_ALLOCATION_MUTATION_DUPLICATE:${mutation.allocationId}`);
    }
    allocationIds.add(mutation.allocationId);
    const expectedSettledUsd = new Prisma.Decimal(mutation.expectedSettledUsd);
    const targetSettledUsd = new Prisma.Decimal(mutation.settledUsd);
    const targetRevenueUsd = new Prisma.Decimal(mutation.recognizedRevenueUsd);
    const targetBonusUsd = new Prisma.Decimal(mutation.bonusConsumedUsd);
    const componentChanged = mutation.expectedRecognizedRevenueUsd !== mutation.recognizedRevenueUsd
      || mutation.expectedBonusConsumedUsd !== mutation.bonusConsumedUsd;
    if (
      !expectedSettledUsd.eq(targetSettledUsd)
      || mutation.expectedSettledAt !== mutation.settledAt
      || targetRevenueUsd.lt(0)
      || targetBonusUsd.lt(0)
      || !targetRevenueUsd.plus(targetBonusUsd).eq(targetSettledUsd)
      || !componentChanged
    ) {
      throw new Error(`ENTERPRISE_ALLOCATION_MUTATION_NOT_COMPONENT_ONLY:${mutation.allocationId}`);
    }
  }
}

function assertSetMutationCardinality(
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

/**
 * Persist the exact pre-rewrite allocation and the complete intended terminal
 * row(s) before either the protected source rewrite or SPLIT insert runs.
 * The insert is itself CAS-bound to the locked transaction path and every
 * database column of the source allocation.
 */
export async function registerPersonalDebtAllocationProofsSetBased(
  tx: Prisma.TransactionClient,
  runId: string,
  repairAccountId: string,
  billingAccountId: string,
  mutations: Extract<BalanceLedgerRepairPlan, { status: 'READY' }>['personalDebtAllocationMutations'],
): Promise<void> {
  if (mutations.length === 0) return;
  const inputJson = JSON.stringify(mutations.map((mutation) => ({
    proofId: randomUUID(),
    ...mutation,
  })));
  const inserted = await tx.$queryRaw<Array<{ sourceAllocationId: string }>>`
    WITH mutation_input AS (
      SELECT mutation.value
      FROM jsonb_array_elements(${inputJson}::JSONB) AS mutation(value)
    ), proof_rows AS (
      SELECT
        mutation_input.value,
        source_allocation,
        to_jsonb(source_allocation)
          || jsonb_build_object(
            'source', mutation_input.value->'targetSourceAllocation'->>'source',
            'balance_grant_id', mutation_input.value->'targetSourceAllocation'->>'balanceGrantId',
            'amount_usd',
              (mutation_input.value->'targetSourceAllocation'->>'amountUsd')::NUMERIC,
            'recognized_revenue_usd',
              (mutation_input.value->'targetSourceAllocation'->>'recognizedRevenueUsd')::NUMERIC,
            'bonus_consumed_usd',
              (mutation_input.value->'targetSourceAllocation'->>'bonusConsumedUsd')::NUMERIC,
            'discount_rate',
              (mutation_input.value->'targetSourceAllocation'->>'discountRate')::NUMERIC,
            'settled_usd',
              (mutation_input.value->'targetSourceAllocation'->>'settledUsd')::NUMERIC,
            'settled_at',
              (mutation_input.value->'targetSourceAllocation'->>'settledAt')::TIMESTAMP(3),
            'ledger_sequence',
              (mutation_input.value->'targetSourceAllocation'->>'ledgerSequence')::BIGINT
          ) AS source_after_snapshot,
        CASE
          WHEN mutation_input.value->'targetDebtAllocation' = 'null'::JSONB THEN NULL
          ELSE to_jsonb(source_allocation) || jsonb_build_object(
            'id', mutation_input.value->'targetDebtAllocation'->>'id',
            'user_id', mutation_input.value->'targetDebtAllocation'->>'userId',
            'tenant_id', mutation_input.value->'targetDebtAllocation'->>'tenantId',
            'billing_account_id',
              mutation_input.value->'targetDebtAllocation'->>'billingAccountId',
            'product_id', mutation_input.value->'targetDebtAllocation'->>'productId',
            'balance_transaction_id',
              mutation_input.value->'targetDebtAllocation'->>'balanceTransactionId',
            'token_usage_id', mutation_input.value->'targetDebtAllocation'->>'tokenUsageId',
            'balance_grant_id', mutation_input.value->'targetDebtAllocation'->>'balanceGrantId',
            'source', mutation_input.value->'targetDebtAllocation'->>'source',
            'amount_usd',
              (mutation_input.value->'targetDebtAllocation'->>'amountUsd')::NUMERIC,
            'recognized_revenue_usd',
              (mutation_input.value->'targetDebtAllocation'->>'recognizedRevenueUsd')::NUMERIC,
            'bonus_consumed_usd',
              (mutation_input.value->'targetDebtAllocation'->>'bonusConsumedUsd')::NUMERIC,
            'discount_rate',
              (mutation_input.value->'targetDebtAllocation'->>'discountRate')::NUMERIC,
            'settled_usd',
              (mutation_input.value->'targetDebtAllocation'->>'settledUsd')::NUMERIC,
            'settled_at',
              (mutation_input.value->'targetDebtAllocation'->>'settledAt')::TIMESTAMP(3),
            'ledger_sequence',
              (mutation_input.value->'targetDebtAllocation'->>'ledgerSequence')::BIGINT,
            'created_at', (
              (mutation_input.value->'targetDebtAllocation'->>'createdAt')::TIMESTAMPTZ
                AT TIME ZONE 'UTC'
            )::TIMESTAMP(3)
          )
        END AS created_debt_snapshot
      FROM mutation_input
      JOIN "balance_consumption_allocations" source_allocation
        ON source_allocation."id" = mutation_input.value->>'sourceAllocationId'
      JOIN "balance_transactions" source_transaction
        ON source_transaction."id" = mutation_input.value->>'transactionId'
      WHERE source_allocation."billing_account_id" = ${billingAccountId}
        AND source_transaction."billing_account_id" = ${billingAccountId}
        AND source_transaction."balance_after_usd" IS NOT DISTINCT FROM
          (mutation_input.value->>'expectedTransactionAfterUsd')::NUMERIC
        AND source_transaction."balance_after_usd" - source_transaction."amount_usd"
          IS NOT DISTINCT FROM (mutation_input.value->>'expectedTransactionBeforeUsd')::NUMERIC
        AND source_allocation."id" =
          mutation_input.value->'expectedSourceAllocation'->>'id'
        AND source_allocation."user_id" IS NOT DISTINCT FROM
          mutation_input.value->'expectedSourceAllocation'->>'userId'
        AND source_allocation."tenant_id" IS NOT DISTINCT FROM
          mutation_input.value->'expectedSourceAllocation'->>'tenantId'
        AND source_allocation."billing_account_id" IS NOT DISTINCT FROM
          mutation_input.value->'expectedSourceAllocation'->>'billingAccountId'
        AND source_allocation."product_id" IS NOT DISTINCT FROM
          mutation_input.value->'expectedSourceAllocation'->>'productId'
        AND source_allocation."balance_transaction_id" IS NOT DISTINCT FROM
          mutation_input.value->'expectedSourceAllocation'->>'balanceTransactionId'
        AND source_allocation."token_usage_id" IS NOT DISTINCT FROM
          mutation_input.value->'expectedSourceAllocation'->>'tokenUsageId'
        AND source_allocation."balance_grant_id" IS NOT DISTINCT FROM
          mutation_input.value->'expectedSourceAllocation'->>'balanceGrantId'
        AND source_allocation."source" IS NOT DISTINCT FROM
          mutation_input.value->'expectedSourceAllocation'->>'source'
        AND source_allocation."amount_usd" IS NOT DISTINCT FROM
          (mutation_input.value->'expectedSourceAllocation'->>'amountUsd')::NUMERIC
        AND source_allocation."recognized_revenue_usd" IS NOT DISTINCT FROM
          (mutation_input.value->'expectedSourceAllocation'->>'recognizedRevenueUsd')::NUMERIC
        AND source_allocation."bonus_consumed_usd" IS NOT DISTINCT FROM
          (mutation_input.value->'expectedSourceAllocation'->>'bonusConsumedUsd')::NUMERIC
        AND source_allocation."discount_rate" IS NOT DISTINCT FROM
          (mutation_input.value->'expectedSourceAllocation'->>'discountRate')::NUMERIC
        AND source_allocation."settled_usd" IS NOT DISTINCT FROM
          (mutation_input.value->'expectedSourceAllocation'->>'settledUsd')::NUMERIC
        AND source_allocation."settled_at" IS NOT DISTINCT FROM
          (mutation_input.value->'expectedSourceAllocation'->>'settledAt')::TIMESTAMP(3)
        AND source_allocation."ledger_sequence" IS NOT DISTINCT FROM
          (mutation_input.value->'expectedSourceAllocation'->>'ledgerSequence')::BIGINT
        AND source_allocation."created_at" IS NOT DISTINCT FROM (
          (mutation_input.value->'expectedSourceAllocation'->>'createdAt')::TIMESTAMPTZ
            AT TIME ZONE 'UTC'
        )::TIMESTAMP(3)
    )
    INSERT INTO "balance_ledger_personal_debt_allocation_repairs" (
      "id", "operation_key", "proof_version", "repair_kind", "run_id",
      "repair_account_id", "billing_account_id", "transaction_id",
      "source_allocation_id", "created_debt_allocation_id", "source_before_snapshot",
      "source_after_snapshot", "created_debt_snapshot"
    )
    SELECT
      proof_rows.value->>'proofId',
      'repair:personal-debt-allocation:' || ${runId} || ':'
        || (proof_rows.value->>'transactionId') || ':'
        || (proof_rows.value->>'sourceAllocationId'),
      (proof_rows.value->>'proofVersion')::INTEGER,
      proof_rows.value->>'repairKind',
      ${runId},
      ${repairAccountId},
      ${billingAccountId},
      proof_rows.value->>'transactionId',
      proof_rows.value->>'sourceAllocationId',
      proof_rows.value->>'createdDebtAllocationId',
      to_jsonb(proof_rows.source_allocation),
      proof_rows.source_after_snapshot,
      proof_rows.created_debt_snapshot
    FROM proof_rows
    RETURNING "source_allocation_id" AS "sourceAllocationId"`;
  assertSetMutationCardinality(
    'STALE_PERSONAL_DEBT_ALLOCATION_PROOF',
    mutations.map((mutation) => mutation.sourceAllocationId),
    inserted.map((row) => row.sourceAllocationId),
  );
}

/** Insert the deterministic debt half of each SPLIT after its proof exists. */
export async function insertPersonalDebtAllocationsSetBased(
  tx: Prisma.TransactionClient,
  runId: string,
  repairAccountId: string,
  billingAccountId: string,
  mutations: Extract<BalanceLedgerRepairPlan, { status: 'READY' }>['personalDebtAllocationMutations'],
): Promise<void> {
  const splitMutations = mutations.filter((mutation) => mutation.targetDebtAllocation !== null);
  if (splitMutations.length === 0) return;
  const inputJson = JSON.stringify(splitMutations.map((mutation) => ({
    sourceAllocationId: mutation.sourceAllocationId,
    targetDebtAllocation: mutation.targetDebtAllocation,
  })));
  const inserted = await tx.$queryRaw<Array<{ allocationId: string }>>`
    WITH mutation_input AS (
      SELECT mutation.value
      FROM jsonb_array_elements(${inputJson}::JSONB) AS mutation(value)
    )
    INSERT INTO "balance_consumption_allocations" (
      "id", "user_id", "tenant_id", "billing_account_id", "product_id",
      "balance_transaction_id", "token_usage_id", "balance_grant_id", "source",
      "amount_usd", "recognized_revenue_usd", "bonus_consumed_usd", "discount_rate",
      "approved_credit_usd", "unapproved_debt_usd",
      "funding_classification_complete", "settled_usd", "settled_at",
      "credit_policy_at", "credit_terms_days", "credit_due_at",
      "credit_policy_snapshot_complete", "ledger_sequence", "created_at"
    )
    SELECT
      mutation_input.value->'targetDebtAllocation'->>'id',
      mutation_input.value->'targetDebtAllocation'->>'userId',
      mutation_input.value->'targetDebtAllocation'->>'tenantId',
      mutation_input.value->'targetDebtAllocation'->>'billingAccountId',
      mutation_input.value->'targetDebtAllocation'->>'productId',
      mutation_input.value->'targetDebtAllocation'->>'balanceTransactionId',
      mutation_input.value->'targetDebtAllocation'->>'tokenUsageId',
      mutation_input.value->'targetDebtAllocation'->>'balanceGrantId',
      mutation_input.value->'targetDebtAllocation'->>'source',
      (mutation_input.value->'targetDebtAllocation'->>'amountUsd')::NUMERIC,
      (mutation_input.value->'targetDebtAllocation'->>'recognizedRevenueUsd')::NUMERIC,
      (mutation_input.value->'targetDebtAllocation'->>'bonusConsumedUsd')::NUMERIC,
      (mutation_input.value->'targetDebtAllocation'->>'discountRate')::NUMERIC,
      (proof."created_debt_snapshot"->>'approved_credit_usd')::NUMERIC,
      (proof."created_debt_snapshot"->>'unapproved_debt_usd')::NUMERIC,
      (proof."created_debt_snapshot"->>'funding_classification_complete')::BOOLEAN,
      (mutation_input.value->'targetDebtAllocation'->>'settledUsd')::NUMERIC,
      (mutation_input.value->'targetDebtAllocation'->>'settledAt')::TIMESTAMP(3),
      (proof."created_debt_snapshot"->>'credit_policy_at')::TIMESTAMP(3),
      (proof."created_debt_snapshot"->>'credit_terms_days')::INTEGER,
      (proof."created_debt_snapshot"->>'credit_due_at')::TIMESTAMP(3),
      (proof."created_debt_snapshot"->>'credit_policy_snapshot_complete')::BOOLEAN,
      (mutation_input.value->'targetDebtAllocation'->>'ledgerSequence')::BIGINT,
      ((mutation_input.value->'targetDebtAllocation'->>'createdAt')::TIMESTAMPTZ
        AT TIME ZONE 'UTC')::TIMESTAMP(3)
    FROM mutation_input
    JOIN "balance_ledger_personal_debt_allocation_repairs" proof
      ON proof."run_id" = ${runId}
      AND proof."repair_account_id" = ${repairAccountId}
      AND proof."billing_account_id" = ${billingAccountId}
      AND proof."source_allocation_id" = mutation_input.value->>'sourceAllocationId'
      AND proof."created_debt_allocation_id" =
        mutation_input.value->'targetDebtAllocation'->>'id'
      AND proof."created_debt_snapshot" IS NOT NULL
    RETURNING "id" AS "allocationId"`;
  assertSetMutationCardinality(
    'STALE_PERSONAL_DEBT_ALLOCATION_INSERT',
    splitMutations.map((mutation) => mutation.createdDebtAllocationId!),
    inserted.map((row) => row.allocationId),
  );
}

/**
 * Voucher proof snapshots must precede sequence/grant repair because they
 * permanently preserve the exact immutable writer output that was locked and
 * re-planned in this transaction.
 */
export async function registerLegacyVoucherFundingProofsSetBased(
  tx: Prisma.TransactionClient,
  runId: string,
  repairAccountId: string,
  billingAccountId: string,
  mutations: Extract<BalanceLedgerRepairPlan, { status: 'READY' }>['legacyVoucherProofMutations'],
  approvalRefs: VoucherApprovalRefs | null,
): Promise<void> {
  if (mutations.length === 0) return;
  if (!approvalRefs) throw new Error('VOUCHER_APPROVAL_REFS_REQUIRED');
  const inputJson = JSON.stringify(mutations.map((mutation) => ({
    proofId: randomUUID(),
    ...mutation,
  })));
  const inserted = await tx.$queryRaw<Array<{ transactionId: string }>>`
    WITH mutation_input AS (
      SELECT mutation.value
      FROM jsonb_array_elements(${inputJson}::JSONB) AS mutation(value)
    )
    INSERT INTO "balance_ledger_voucher_funding_repairs" (
      "id", "operation_key", "proof_version", "repair_kind", "run_id",
      "repair_account_id", "billing_account_id", "transaction_id", "grant_id",
      "transaction_snapshot", "grant_snapshot", "wallet_before_usd", "hole_fill_usd",
      "finance_approval_ref", "technical_approval_ref"
    )
    SELECT
      mutation_input.value->>'proofId',
      'repair:voucher-funding:' || ${runId} || ':'
        || (mutation_input.value->>'transactionId') || ':' || (mutation_input.value->>'grantId'),
      (mutation_input.value->>'proofVersion')::INTEGER,
      mutation_input.value->>'repairKind',
      ${runId},
      ${repairAccountId},
      ${billingAccountId},
      transaction_row."id",
      grant_row."id",
      to_jsonb(transaction_row),
      to_jsonb(grant_row),
      (mutation_input.value->>'walletBeforeUsd')::NUMERIC,
      (mutation_input.value->>'holeFillUsd')::NUMERIC,
      ${approvalRefs.financeApprovalRef},
      ${approvalRefs.technicalApprovalRef}
    FROM mutation_input
    JOIN "balance_transactions" transaction_row
      ON transaction_row."id" = mutation_input.value->>'transactionId'
    JOIN "balance_grants" grant_row
      ON grant_row."id" = mutation_input.value->>'grantId'
    WHERE transaction_row."billing_account_id" = ${billingAccountId}
      AND grant_row."billing_account_id" = ${billingAccountId}
      AND transaction_row."id" = mutation_input.value->'expectedTransaction'->>'id'
      AND transaction_row."user_id" IS NOT DISTINCT FROM
        mutation_input.value->'expectedTransaction'->>'userId'
      AND transaction_row."tenant_id" IS NOT DISTINCT FROM
        mutation_input.value->'expectedTransaction'->>'tenantId'
      AND transaction_row."product_id" IS NOT DISTINCT FROM
        mutation_input.value->'expectedTransaction'->>'productId'
      AND transaction_row."type"::TEXT IS NOT DISTINCT FROM
        mutation_input.value->'expectedTransaction'->>'type'
      AND transaction_row."amount_usd" IS NOT DISTINCT FROM
        (mutation_input.value->'expectedTransaction'->>'amountUsd')::NUMERIC
      AND transaction_row."balance_after_usd" IS NOT DISTINCT FROM
        (mutation_input.value->'expectedTransaction'->>'balanceAfterUsd')::NUMERIC
      AND transaction_row."description" IS NOT DISTINCT FROM
        mutation_input.value->'expectedTransaction'->>'description'
      AND transaction_row."order_id" IS NOT DISTINCT FROM
        mutation_input.value->'expectedTransaction'->>'orderId'
      AND transaction_row."token_usage_id" IS NOT DISTINCT FROM
        mutation_input.value->'expectedTransaction'->>'tokenUsageId'
      AND transaction_row."operation_key" IS NOT DISTINCT FROM
        mutation_input.value->'expectedTransaction'->>'operationKey'
      AND transaction_row."ledger_sequence" IS NOT DISTINCT FROM
        (mutation_input.value->'expectedTransaction'->>'ledgerSequence')::BIGINT
      AND transaction_row."created_at" IS NOT DISTINCT FROM (
        (mutation_input.value->'expectedTransaction'->>'createdAt')::TIMESTAMPTZ
          AT TIME ZONE 'UTC'
      )::TIMESTAMP(3)
      AND grant_row."id" = mutation_input.value->'expectedGrant'->>'id'
      AND grant_row."user_id" IS NOT DISTINCT FROM
        mutation_input.value->'expectedGrant'->>'userId'
      AND grant_row."tenant_id" IS NOT DISTINCT FROM
        mutation_input.value->'expectedGrant'->>'tenantId'
      AND grant_row."product_id" IS NOT DISTINCT FROM
        mutation_input.value->'expectedGrant'->>'productId'
      AND grant_row."order_id" IS NOT DISTINCT FROM
        mutation_input.value->'expectedGrant'->>'orderId'
      AND grant_row."source" IS NOT DISTINCT FROM
        mutation_input.value->'expectedGrant'->>'source'
      AND grant_row."paid_amount_usd" IS NOT DISTINCT FROM
        (mutation_input.value->'expectedGrant'->>'paidAmountUsd')::NUMERIC
      AND grant_row."bonus_amount_usd" IS NOT DISTINCT FROM
        (mutation_input.value->'expectedGrant'->>'bonusAmountUsd')::NUMERIC
      AND grant_row."granted_amount_usd" IS NOT DISTINCT FROM
        (mutation_input.value->'expectedGrant'->>'grantedAmountUsd')::NUMERIC
      AND grant_row."remaining_amount_usd" IS NOT DISTINCT FROM
        (mutation_input.value->'expectedGrant'->>'remainingAmountUsd')::NUMERIC
      AND grant_row."remaining_paid_amount_usd" IS NOT DISTINCT FROM
        (mutation_input.value->'expectedGrant'->>'remainingPaidAmountUsd')::NUMERIC
      AND grant_row."remaining_bonus_amount_usd" IS NOT DISTINCT FROM
        (mutation_input.value->'expectedGrant'->>'remainingBonusAmountUsd')::NUMERIC
      AND grant_row."discount_rate" IS NOT DISTINCT FROM
        (mutation_input.value->'expectedGrant'->>'discountRate')::NUMERIC
      AND grant_row."is_expired" IS NOT DISTINCT FROM
        (mutation_input.value->'expectedGrant'->>'isExpired')::BOOLEAN
      AND grant_row."valid_from" IS NOT DISTINCT FROM (
        (mutation_input.value->'expectedGrant'->>'validFrom')::TIMESTAMPTZ
          AT TIME ZONE 'UTC'
      )::TIMESTAMP(3)
      AND grant_row."expires_at" IS NOT DISTINCT FROM (
        (mutation_input.value->'expectedGrant'->>'expiresAt')::TIMESTAMPTZ
          AT TIME ZONE 'UTC'
      )::TIMESTAMP(3)
      AND grant_row."created_at" IS NOT DISTINCT FROM (
        (mutation_input.value->'expectedGrant'->>'createdAt')::TIMESTAMPTZ
          AT TIME ZONE 'UTC'
      )::TIMESTAMP(3)
    RETURNING "transaction_id" AS "transactionId"`;
  assertSetMutationCardinality(
    'STALE_LEGACY_VOUCHER_FUNDING_PROOF',
    mutations.map((mutation) => mutation.transactionId),
    inserted.map((row) => row.transactionId),
  );
}

export async function registerLegacyExpiryProofsSetBased(
  tx: Prisma.TransactionClient,
  runId: string,
  repairAccountId: string,
  billingAccountId: string,
  mutations: Extract<BalanceLedgerRepairPlan, { status: 'READY' }>['legacyExpiryProofMutations'],
  approvalRefs: VoucherApprovalRefs | null,
): Promise<void> {
  if (mutations.length === 0) return;
  if (!approvalRefs) throw new Error('LEGACY_EXPIRY_APPROVAL_REFS_REQUIRED');
  const inputJson = JSON.stringify(mutations.map((mutation) => ({
    proofId: randomUUID(),
    ...mutation,
  })));
  const inserted = await tx.$queryRaw<Array<{ transactionId: string }>>`
    WITH mutation_input AS (
      SELECT mutation.value
      FROM jsonb_array_elements(${inputJson}::JSONB) AS mutation(value)
    )
    INSERT INTO "balance_ledger_legacy_expiry_repairs" (
      "id", "operation_key", "proof_version", "repair_kind", "run_id",
      "repair_account_id", "billing_account_id", "balance_grant_id",
      "balance_transaction_id", "expiry_audit_id", "nominal_amount_usd",
      "nominal_paid_usd", "nominal_bonus_usd", "wallet_balance_before_usd",
      "wallet_balance_after_usd", "transaction_snapshot", "grant_snapshot",
      "expiry_audit_snapshot", "finance_approval_ref", "technical_approval_ref"
    )
    SELECT
      mutation_input.value->>'proofId',
      'repair:legacy-expiry:' || ${runId} || ':' || transaction_row."id" || ':' || grant_row."id",
      (mutation_input.value->>'proofVersion')::INTEGER,
      mutation_input.value->>'repairKind',
      ${runId},
      ${repairAccountId},
      ${billingAccountId},
      grant_row."id",
      transaction_row."id",
      mutation_input.value->>'expiryAuditId',
      (mutation_input.value->>'nominalAmountUsd')::NUMERIC,
      (mutation_input.value->>'nominalPaidUsd')::NUMERIC,
      (mutation_input.value->>'nominalBonusUsd')::NUMERIC,
      (mutation_input.value->>'walletBalanceBeforeUsd')::NUMERIC,
      (mutation_input.value->>'walletBalanceAfterUsd')::NUMERIC,
      to_jsonb(transaction_row),
      to_jsonb(grant_row),
      jsonb_build_object(
        'id', mutation_input.value->>'expiryAuditId',
        'balance_grant_id', grant_row."id",
        'billing_account_id', ${billingAccountId},
        'balance_transaction_id', transaction_row."id",
        'nominal_amount_usd', (mutation_input.value->>'nominalAmountUsd')::NUMERIC,
        'nominal_paid_usd', (mutation_input.value->>'nominalPaidUsd')::NUMERIC,
        'nominal_bonus_usd', (mutation_input.value->>'nominalBonusUsd')::NUMERIC,
        'wallet_debit_usd', (mutation_input.value->>'nominalAmountUsd')::NUMERIC,
        'wallet_debit_paid_usd', (mutation_input.value->>'nominalPaidUsd')::NUMERIC,
        'wallet_debit_bonus_usd', (mutation_input.value->>'nominalBonusUsd')::NUMERIC,
        'unbacked_amount_usd', 0::NUMERIC,
        'unbacked_paid_usd', 0::NUMERIC,
        'unbacked_bonus_usd', 0::NUMERIC,
        'wallet_balance_before_usd', (mutation_input.value->>'walletBalanceBeforeUsd')::NUMERIC,
        'wallet_balance_after_usd', (mutation_input.value->>'walletBalanceAfterUsd')::NUMERIC,
        'created_at', transaction_row."created_at"
      ),
      ${approvalRefs.financeApprovalRef},
      ${approvalRefs.technicalApprovalRef}
    FROM mutation_input
    JOIN "balance_transactions" transaction_row
      ON transaction_row."id" = mutation_input.value->>'transactionId'
    JOIN "balance_grants" grant_row
      ON grant_row."id" = mutation_input.value->>'grantId'
    WHERE transaction_row."billing_account_id" = ${billingAccountId}
      AND grant_row."billing_account_id" = ${billingAccountId}
      AND transaction_row."id" = mutation_input.value->'expectedTransaction'->>'id'
      AND transaction_row."user_id" IS NOT DISTINCT FROM
        mutation_input.value->'expectedTransaction'->>'userId'
      AND transaction_row."tenant_id" IS NOT DISTINCT FROM
        mutation_input.value->'expectedTransaction'->>'tenantId'
      AND transaction_row."product_id" IS NOT DISTINCT FROM
        mutation_input.value->'expectedTransaction'->>'productId'
      AND transaction_row."type"::TEXT = mutation_input.value->'expectedTransaction'->>'type'
      AND transaction_row."amount_usd" =
        (mutation_input.value->'expectedTransaction'->>'amountUsd')::NUMERIC
      AND transaction_row."balance_after_usd" =
        (mutation_input.value->'expectedTransaction'->>'balanceAfterUsd')::NUMERIC
      AND transaction_row."description" =
        mutation_input.value->'expectedTransaction'->>'description'
      AND transaction_row."order_id" IS NOT DISTINCT FROM
        mutation_input.value->'expectedTransaction'->>'orderId'
      AND transaction_row."token_usage_id" IS NOT DISTINCT FROM
        mutation_input.value->'expectedTransaction'->>'tokenUsageId'
      AND transaction_row."operation_key" IS NOT DISTINCT FROM
        mutation_input.value->'expectedTransaction'->>'operationKey'
      AND transaction_row."ledger_sequence" IS NOT DISTINCT FROM
        (mutation_input.value->'expectedTransaction'->>'ledgerSequence')::BIGINT
      AND transaction_row."created_at" IS NOT DISTINCT FROM (
        (mutation_input.value->'expectedTransaction'->>'createdAt')::TIMESTAMPTZ
          AT TIME ZONE 'UTC'
      )::TIMESTAMP(3)
      AND grant_row."id" = mutation_input.value->'expectedGrant'->>'id'
      AND grant_row."user_id" IS NOT DISTINCT FROM mutation_input.value->'expectedGrant'->>'userId'
      AND grant_row."tenant_id" IS NOT DISTINCT FROM mutation_input.value->'expectedGrant'->>'tenantId'
      AND grant_row."product_id" IS NOT DISTINCT FROM mutation_input.value->'expectedGrant'->>'productId'
      AND grant_row."order_id" IS NOT DISTINCT FROM mutation_input.value->'expectedGrant'->>'orderId'
      AND grant_row."source" = mutation_input.value->'expectedGrant'->>'source'
      AND grant_row."paid_amount_usd" =
        (mutation_input.value->'expectedGrant'->>'paidAmountUsd')::NUMERIC
      AND grant_row."bonus_amount_usd" =
        (mutation_input.value->'expectedGrant'->>'bonusAmountUsd')::NUMERIC
      AND grant_row."granted_amount_usd" =
        (mutation_input.value->'expectedGrant'->>'grantedAmountUsd')::NUMERIC
      AND grant_row."remaining_amount_usd" =
        (mutation_input.value->'expectedGrant'->>'remainingAmountUsd')::NUMERIC
      AND grant_row."remaining_paid_amount_usd" IS NOT DISTINCT FROM
        (mutation_input.value->'expectedGrant'->>'remainingPaidAmountUsd')::NUMERIC
      AND grant_row."remaining_bonus_amount_usd" IS NOT DISTINCT FROM
        (mutation_input.value->'expectedGrant'->>'remainingBonusAmountUsd')::NUMERIC
      AND grant_row."discount_rate" =
        (mutation_input.value->'expectedGrant'->>'discountRate')::NUMERIC
      AND grant_row."is_expired" = TRUE
      AND grant_row."valid_from" IS NOT DISTINCT FROM (
        (mutation_input.value->'expectedGrant'->>'validFrom')::TIMESTAMPTZ
          AT TIME ZONE 'UTC'
      )::TIMESTAMP(3)
      AND grant_row."expires_at" IS NOT DISTINCT FROM (
        (mutation_input.value->'expectedGrant'->>'expiresAt')::TIMESTAMPTZ
          AT TIME ZONE 'UTC'
      )::TIMESTAMP(3)
      AND grant_row."created_at" IS NOT DISTINCT FROM (
        (mutation_input.value->'expectedGrant'->>'createdAt')::TIMESTAMPTZ
          AT TIME ZONE 'UTC'
      )::TIMESTAMP(3)
    RETURNING "balance_transaction_id" AS "transactionId"`;
  assertSetMutationCardinality(
    'STALE_LEGACY_EXPIRY_PROOF',
    mutations.map((mutation) => mutation.transactionId),
    inserted.map((row) => row.transactionId),
  );
}

async function registerInvoiceStabilityProof(
  tx: Prisma.TransactionClient,
  runId: string,
  repairAccountId: string,
  billingAccountId: string,
  proof: Extract<BalanceLedgerRepairPlan, { status: 'READY' }>['invoiceStabilityProof'],
  approvalRefs: VoucherApprovalRefs | null,
): Promise<void> {
  if (proof === null) return;
  if (!approvalRefs) throw new Error('INVOICE_STABILITY_APPROVAL_REFS_REQUIRED');
  const inserted = await tx.$queryRaw<Array<{ billingAccountId: string }>>`
    INSERT INTO "balance_ledger_invoice_stability_repairs" (
      "id", "operation_key", "proof_version", "repair_kind", "run_id",
      "repair_account_id", "billing_account_id", "order_count",
      "application_count", "item_count", "event_count", "evidence_sha256",
      "evidence_snapshot", "finance_approval_ref", "technical_approval_ref"
    )
    SELECT
      ${randomUUID()},
      'repair:invoice-stability:' || ${runId} || ':' || ${billingAccountId},
      ${proof.proofVersion},
      ${proof.repairKind},
      ${runId},
      ${repairAccountId},
      ${billingAccountId},
      evidence."order_count",
      evidence."application_count",
      evidence."item_count",
      evidence."event_count",
      evidence."evidence_sha256",
      evidence."evidence_snapshot",
      ${approvalRefs.financeApprovalRef},
      ${approvalRefs.technicalApprovalRef}
    FROM "balance_ledger_invoice_stability_evidence"(${billingAccountId}) evidence
    WHERE evidence."order_count" = ${proof.orderCount}::BIGINT
      AND evidence."application_count" = ${proof.applicationCount}::BIGINT
      AND evidence."item_count" = ${proof.itemCount}::BIGINT
      AND evidence."event_count" = ${proof.eventCount}::BIGINT
      AND evidence."evidence_sha256" = ${proof.evidenceSha256}
      AND evidence."invalid_application_count" = 0
    RETURNING "billing_account_id" AS "billingAccountId"`;
  assertSetMutationCardinality(
    'STALE_INVOICE_STABILITY_PROOF',
    [billingAccountId],
    inserted.map((row) => row.billingAccountId),
  );
}

async function insertLegacyExpiryAuditsSetBased(
  tx: Prisma.TransactionClient,
  runId: string,
  repairAccountId: string,
  billingAccountId: string,
  mutations: Extract<BalanceLedgerRepairPlan, { status: 'READY' }>['legacyExpiryProofMutations'],
): Promise<void> {
  if (mutations.length === 0) return;
  const inputJson = JSON.stringify(mutations);
  const inserted = await tx.$queryRaw<Array<{ grantId: string }>>`
    WITH mutation_input AS (
      SELECT mutation.value
      FROM jsonb_array_elements(${inputJson}::JSONB) AS mutation(value)
    )
    INSERT INTO "balance_grant_expiries" (
      "id", "balance_grant_id", "billing_account_id", "balance_transaction_id",
      "nominal_amount_usd", "nominal_paid_usd", "nominal_bonus_usd",
      "wallet_debit_usd", "wallet_debit_paid_usd", "wallet_debit_bonus_usd",
      "unbacked_amount_usd", "unbacked_paid_usd", "unbacked_bonus_usd",
      "wallet_balance_before_usd", "wallet_balance_after_usd", "created_at"
    )
    SELECT
      mutation_input.value->>'expiryAuditId',
      proof."balance_grant_id",
      ${billingAccountId},
      proof."balance_transaction_id",
      (mutation_input.value->>'nominalAmountUsd')::NUMERIC,
      (mutation_input.value->>'nominalPaidUsd')::NUMERIC,
      (mutation_input.value->>'nominalBonusUsd')::NUMERIC,
      (mutation_input.value->>'nominalAmountUsd')::NUMERIC,
      (mutation_input.value->>'nominalPaidUsd')::NUMERIC,
      (mutation_input.value->>'nominalBonusUsd')::NUMERIC,
      0,
      0,
      0,
      (mutation_input.value->>'walletBalanceBeforeUsd')::NUMERIC,
      (mutation_input.value->>'walletBalanceAfterUsd')::NUMERIC,
      transaction_row."created_at"
    FROM mutation_input
    JOIN "balance_ledger_legacy_expiry_repairs" proof
      ON proof."run_id" = ${runId}
      AND proof."repair_account_id" = ${repairAccountId}
      AND proof."billing_account_id" = ${billingAccountId}
      AND proof."balance_grant_id" = mutation_input.value->>'grantId'
      AND proof."balance_transaction_id" = mutation_input.value->>'transactionId'
      AND proof."expiry_audit_id" = mutation_input.value->>'expiryAuditId'
    JOIN "balance_transactions" transaction_row
      ON transaction_row."id" = proof."balance_transaction_id"
    RETURNING "balance_grant_id" AS "grantId"`;
  assertSetMutationCardinality(
    'STALE_LEGACY_EXPIRY_AUDIT',
    mutations.map((mutation) => mutation.grantId),
    inserted.map((row) => row.grantId),
  );
}

export type StagedRepairMutationCounts = {
  transactionCount: number;
  allocationCount: number;
  uploadChunkCount: number;
  maxUploadRows: number;
  maxUploadJsonBytes: number;
};

/**
 * Materialize a signed plan into transaction-local, indexed staging tables.
 * The Node process retains only one bounded JSON input chunk at a time; all
 * cross-mutation allocation merging and conflict detection happens in
 * PostgreSQL before any durable audit or financial row is touched.
 */
export async function stageRepairMutations(
  tx: Prisma.TransactionClient,
  plan: Extract<BalanceLedgerRepairPlan, { status: 'READY' }>,
): Promise<StagedRepairMutationCounts> {
  await tx.$executeRawUnsafe(`CREATE TEMP TABLE "balance_ledger_repair_transaction_stage" (
    "stage_ordinal" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "audit_id" TEXT NOT NULL,
    "transaction_id" TEXT NOT NULL UNIQUE,
    "ledger_sequence" BIGINT NOT NULL
  ) ON COMMIT DROP`);
  await tx.$executeRawUnsafe(`CREATE TEMP TABLE "balance_ledger_repair_allocation_component_stage" (
    "stage_ordinal" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "allocation_id" TEXT NOT NULL,
    "expected" JSONB NOT NULL,
    "target" JSONB NOT NULL,
    "canonical" JSONB
  ) ON COMMIT DROP`);
  await tx.$executeRawUnsafe(`CREATE INDEX
    "balance_ledger_repair_allocation_component_stage_allocation_idx"
    ON "balance_ledger_repair_allocation_component_stage" ("allocation_id")`);
  await tx.$executeRawUnsafe(`CREATE TEMP TABLE "balance_ledger_repair_allocation_stage" (
    "stage_ordinal" BIGINT GENERATED ALWAYS AS IDENTITY PRIMARY KEY,
    "audit_id" TEXT NOT NULL,
    "allocation_id" TEXT NOT NULL UNIQUE,
    "expected" JSONB NOT NULL,
    "target" JSONB NOT NULL,
    "canonical" JSONB
  ) ON COMMIT DROP`);

  function* transactionRows() {
    for (const mutation of plan.transactionSequenceMutations) {
      yield {
        auditId: randomUUID(),
        transactionId: mutation.transactionId,
        ledgerSequence: mutation.ledgerSequence,
      };
    }
  }
  const transactionUpload = await writeBoundedJsonChunks(transactionRows(), async (inputJson) => {
    await tx.$executeRaw`
      INSERT INTO "balance_ledger_repair_transaction_stage" (
        "audit_id", "transaction_id", "ledger_sequence"
      )
      SELECT
        mutation.value->>'auditId',
        mutation.value->>'transactionId',
        (mutation.value->>'ledgerSequence')::BIGINT
      FROM jsonb_array_elements(${inputJson}::JSONB) AS mutation(value)`;
  });

  const allocationUpload = await writeBoundedJsonChunks(
    allocationMutationComponents(plan),
    async (inputJson) => {
    await tx.$executeRaw`
      INSERT INTO "balance_ledger_repair_allocation_component_stage" (
        "allocation_id", "expected", "target", "canonical"
      )
      SELECT
        mutation.value->>'allocationId',
        mutation.value->'expected',
        mutation.value->'target',
        mutation.value->'canonical'
      FROM jsonb_array_elements(${inputJson}::JSONB) AS mutation(value)`;
    },
  );

  const expectedAllocationComponentCount = plan.canonicalAllocationMutations.length
    + plan.migrationOpeningDebtMutations.length
    + plan.personalDebtAllocationMutations.length
    + plan.unreconciledGrantMutations.length
    + plan.allocationSequenceMutations.length
    + plan.allocationMutations.length;
  const [componentCount] = await tx.$queryRaw<Array<{ count: number }>>`
    SELECT COUNT(*)::INTEGER AS "count"
    FROM "balance_ledger_repair_allocation_component_stage"`;
  if ((componentCount?.count ?? 0) !== expectedAllocationComponentCount) {
    throw new Error(
      `BOUNDED_ALLOCATION_COMPONENT_STAGE_COUNT_MISMATCH:${componentCount?.count ?? 0}`
      + `/${expectedAllocationComponentCount}`,
    );
  }

  const [patchConflict] = await tx.$queryRaw<Array<{
    allocationId: string;
    patchKind: 'expected' | 'target';
    field: string;
  }>>`
    WITH patch_fields AS (
      SELECT component."allocation_id", 'expected'::TEXT AS patch_kind,
        field.key, field.value
      FROM "balance_ledger_repair_allocation_component_stage" component
      CROSS JOIN LATERAL jsonb_each(component."expected") field
      UNION ALL
      SELECT component."allocation_id", 'target'::TEXT AS patch_kind,
        field.key, field.value
      FROM "balance_ledger_repair_allocation_component_stage" component
      CROSS JOIN LATERAL jsonb_each(component."target") field
    )
    SELECT "allocation_id" AS "allocationId", patch_kind AS "patchKind", key AS "field"
    FROM patch_fields
    GROUP BY "allocation_id", patch_kind, key
    HAVING COUNT(DISTINCT value) > 1
    ORDER BY "allocation_id", patch_kind, key
    LIMIT 1`;
  if (patchConflict) {
    throw new Error(
      `ALLOCATION_${patchConflict.patchKind.toUpperCase()}_PATCH_CONFLICT:`
      + `${patchConflict.allocationId}:${patchConflict.field}`,
    );
  }
  const [canonicalConflict] = await tx.$queryRaw<Array<{ allocationId: string }>>`
    SELECT "allocation_id" AS "allocationId"
    FROM "balance_ledger_repair_allocation_component_stage"
    GROUP BY "allocation_id"
    HAVING COUNT("canonical") > 1
    ORDER BY "allocation_id"
    LIMIT 1`;
  if (canonicalConflict) {
    throw new Error(`DUPLICATE_CANONICAL_ALLOCATION:${canonicalConflict.allocationId}`);
  }

  await tx.$executeRaw`
    WITH expected_patch AS (
      SELECT component."allocation_id",
        jsonb_object_agg(field.key, field.value ORDER BY component."stage_ordinal") AS value
      FROM "balance_ledger_repair_allocation_component_stage" component
      CROSS JOIN LATERAL jsonb_each(component."expected") field
      GROUP BY component."allocation_id"
    ), target_patch AS (
      SELECT component."allocation_id",
        jsonb_object_agg(field.key, field.value ORDER BY component."stage_ordinal") AS value
      FROM "balance_ledger_repair_allocation_component_stage" component
      CROSS JOIN LATERAL jsonb_each(component."target") field
      GROUP BY component."allocation_id"
    ), canonical_patch AS (
      SELECT component."allocation_id",
        (jsonb_agg(component."canonical" ORDER BY component."stage_ordinal")
          FILTER (WHERE component."canonical" IS NOT NULL))->0 AS value
      FROM "balance_ledger_repair_allocation_component_stage" component
      GROUP BY component."allocation_id"
    ), allocation_ids AS (
      SELECT DISTINCT "allocation_id"
      FROM "balance_ledger_repair_allocation_component_stage"
    )
    INSERT INTO "balance_ledger_repair_allocation_stage" (
      "audit_id", "allocation_id", "expected", "target", "canonical"
    )
    SELECT
      gen_random_uuid()::TEXT,
      allocation_ids."allocation_id",
      COALESCE(expected_patch.value, '{}'::JSONB),
      COALESCE(target_patch.value, '{}'::JSONB),
      canonical_patch.value
    FROM allocation_ids
    LEFT JOIN expected_patch USING ("allocation_id")
    LEFT JOIN target_patch USING ("allocation_id")
    LEFT JOIN canonical_patch USING ("allocation_id")
    ORDER BY allocation_ids."allocation_id"`;
  await tx.$executeRawUnsafe('ANALYZE "balance_ledger_repair_transaction_stage"');
  await tx.$executeRawUnsafe('ANALYZE "balance_ledger_repair_allocation_stage"');

  const [counts] = await tx.$queryRaw<Array<{
    transactionCount: number;
    allocationCount: number;
  }>>`
    SELECT
      (SELECT COUNT(*)::INTEGER FROM "balance_ledger_repair_transaction_stage")
        AS "transactionCount",
      (SELECT COUNT(*)::INTEGER FROM "balance_ledger_repair_allocation_stage")
        AS "allocationCount"`;
  if (!counts || counts.transactionCount !== plan.transactionSequenceMutations.length) {
    throw new Error(
      `BOUNDED_TRANSACTION_STAGE_COUNT_MISMATCH:${counts?.transactionCount ?? 0}`
      + `/${plan.transactionSequenceMutations.length}`,
    );
  }
  if (
    transactionUpload.rowCount !== counts.transactionCount
    || allocationUpload.rowCount !== expectedAllocationComponentCount
  ) {
    throw new Error('BOUNDED_STAGE_UPLOAD_COUNT_MISMATCH');
  }
  return {
    ...counts,
    uploadChunkCount: transactionUpload.chunkCount + allocationUpload.chunkCount,
    maxUploadRows: Math.max(transactionUpload.maxRows, allocationUpload.maxRows),
    maxUploadJsonBytes: Math.max(
      transactionUpload.maxJsonBytes,
      allocationUpload.maxJsonBytes,
    ),
  };
}

async function assertStagedMutationCount(
  tx: Prisma.TransactionClient,
  table: 'balance_ledger_repair_transaction_stage' | 'balance_ledger_repair_allocation_stage',
  expectedCount: number,
): Promise<void> {
  const rows = table === 'balance_ledger_repair_transaction_stage'
    ? await tx.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::INTEGER AS "count"
        FROM "balance_ledger_repair_transaction_stage"`
    : await tx.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::INTEGER AS "count"
        FROM "balance_ledger_repair_allocation_stage"`;
  const actualCount = rows[0]?.count ?? 0;
  if (actualCount !== expectedCount) {
    throw new Error(`BOUNDED_STAGE_COUNT_MISMATCH:${table}:${actualCount}/${expectedCount}`);
  }
}

export async function registerTransactionSequenceMutationAuditsFromStage(
  tx: Prisma.TransactionClient,
  runId: string,
  repairAccountId: string,
  billingAccountId: string,
  expectedCount: number,
): Promise<void> {
  await assertStagedMutationCount(
    tx,
    'balance_ledger_repair_transaction_stage',
    expectedCount,
  );
  for (let start = 0; start < expectedCount; start += BOUNDED_MUTATION_BATCH_ROWS) {
    const end = Math.min(start + BOUNDED_MUTATION_BATCH_ROWS, expectedCount);
    const [result] = await tx.$queryRaw<Array<{ count: number }>>`
      WITH batch AS (
        SELECT *
        FROM "balance_ledger_repair_transaction_stage"
        WHERE "stage_ordinal" > ${start} AND "stage_ordinal" <= ${end}
      ), inserted AS (
        INSERT INTO "balance_ledger_transaction_repairs" (
          "id", "operation_key", "run_id", "repair_account_id",
          "billing_account_id", "transaction_id", "before_snapshot", "after_snapshot"
        )
        SELECT
          batch."audit_id",
          'repair:transaction-sequence:' || ${runId} || ':' || batch."transaction_id",
          ${runId},
          ${repairAccountId},
          ${billingAccountId},
          balance_transaction."id",
          to_jsonb(balance_transaction),
          to_jsonb(balance_transaction) || jsonb_build_object(
            'ledger_sequence', batch."ledger_sequence"
          )
        FROM batch
        JOIN "balance_transactions" balance_transaction
          ON balance_transaction."id" = batch."transaction_id"
        WHERE balance_transaction."billing_account_id" = ${billingAccountId}
          AND balance_transaction."ledger_sequence" IS NULL
        RETURNING 1
      )
      SELECT COUNT(*)::INTEGER AS "count" FROM inserted`;
    const batchCount = end - start;
    if (result?.count !== batchCount) {
      throw new Error(
        `STALE_TRANSACTION_SEQUENCE_AUDIT:CARDINALITY:${result?.count ?? 0}/${batchCount}`,
      );
    }
  }
}

export async function registerAllocationMutationAuditsFromStage(
  tx: Prisma.TransactionClient,
  runId: string,
  repairAccountId: string,
  billingAccountId: string,
  expectedCount: number,
): Promise<void> {
  await assertStagedMutationCount(
    tx,
    'balance_ledger_repair_allocation_stage',
    expectedCount,
  );
  for (let start = 0; start < expectedCount; start += BOUNDED_MUTATION_BATCH_ROWS) {
    const end = Math.min(start + BOUNDED_MUTATION_BATCH_ROWS, expectedCount);
    const [result] = await tx.$queryRaw<Array<{ count: number }>>`
      WITH batch AS (
        SELECT *
        FROM "balance_ledger_repair_allocation_stage"
        WHERE "stage_ordinal" > ${start} AND "stage_ordinal" <= ${end}
      ), inserted AS (
        INSERT INTO "balance_ledger_allocation_repairs" (
          "id", "operation_key", "run_id", "repair_account_id",
          "billing_account_id", "allocation_id", "before_snapshot", "after_snapshot"
        )
        SELECT
          batch."audit_id",
          'repair:allocation:' || ${runId} || ':' || batch."allocation_id",
          ${runId},
          ${repairAccountId},
          ${billingAccountId},
          allocation."id",
          to_jsonb(allocation),
          to_jsonb(allocation)
            || CASE WHEN batch."target" ? 'source' THEN jsonb_build_object(
              'source', batch."target"->>'source'
            ) ELSE '{}'::JSONB END
            || CASE WHEN batch."target" ? 'balanceGrantId' THEN jsonb_build_object(
              'balance_grant_id', batch."target"->>'balanceGrantId'
            ) ELSE '{}'::JSONB END
            || CASE WHEN batch."target" ? 'amountUsd' THEN jsonb_build_object(
              'amount_usd', (batch."target"->>'amountUsd')::NUMERIC
            ) ELSE '{}'::JSONB END
            || CASE WHEN batch."target" ? 'recognizedRevenueUsd' THEN jsonb_build_object(
              'recognized_revenue_usd', (batch."target"->>'recognizedRevenueUsd')::NUMERIC
            ) ELSE '{}'::JSONB END
            || CASE WHEN batch."target" ? 'bonusConsumedUsd' THEN jsonb_build_object(
              'bonus_consumed_usd', (batch."target"->>'bonusConsumedUsd')::NUMERIC
            ) ELSE '{}'::JSONB END
            || CASE WHEN batch."target" ? 'discountRate' THEN jsonb_build_object(
              'discount_rate', (batch."target"->>'discountRate')::NUMERIC
            ) ELSE '{}'::JSONB END
            || CASE WHEN batch."target" ? 'settledUsd' THEN jsonb_build_object(
              'settled_usd', (batch."target"->>'settledUsd')::NUMERIC
            ) ELSE '{}'::JSONB END
            || CASE WHEN batch."target" ? 'settledAt' THEN jsonb_build_object(
              'settled_at', (batch."target"->>'settledAt')::TIMESTAMP(3)
            ) ELSE '{}'::JSONB END
            || CASE WHEN batch."target" ? 'ledgerSequence' THEN jsonb_build_object(
              'ledger_sequence', (batch."target"->>'ledgerSequence')::BIGINT
            ) ELSE '{}'::JSONB END
        FROM batch
        JOIN "balance_consumption_allocations" allocation
          ON allocation."id" = batch."allocation_id"
        WHERE allocation."billing_account_id" = ${billingAccountId}
          AND (batch."canonical" IS NULL OR (
            allocation."user_id" IS NOT DISTINCT FROM batch."canonical"->>'expectedUserId'
            AND allocation."tenant_id" IS NOT DISTINCT FROM batch."canonical"->>'expectedTenantId'
            AND allocation."product_id" IS NOT DISTINCT FROM batch."canonical"->>'expectedProductId'
            AND allocation."balance_transaction_id" IS NOT DISTINCT FROM
              batch."canonical"->>'expectedBalanceTransactionId'
            AND allocation."token_usage_id" IS NOT DISTINCT FROM
              batch."canonical"->>'expectedTokenUsageId'
            AND allocation."created_at" IS NOT DISTINCT FROM
              (batch."canonical"->>'expectedCreatedAt')::TIMESTAMP(3)
          ))
          AND (NOT (batch."expected" ? 'source') OR allocation."source"
            IS NOT DISTINCT FROM batch."expected"->>'source')
          AND (NOT (batch."expected" ? 'balanceGrantId') OR allocation."balance_grant_id"
            IS NOT DISTINCT FROM batch."expected"->>'balanceGrantId')
          AND (NOT (batch."expected" ? 'amountUsd') OR allocation."amount_usd"
            IS NOT DISTINCT FROM (batch."expected"->>'amountUsd')::NUMERIC)
          AND (NOT (batch."expected" ? 'recognizedRevenueUsd')
            OR allocation."recognized_revenue_usd" IS NOT DISTINCT FROM
              (batch."expected"->>'recognizedRevenueUsd')::NUMERIC)
          AND (NOT (batch."expected" ? 'bonusConsumedUsd')
            OR allocation."bonus_consumed_usd" IS NOT DISTINCT FROM
              (batch."expected"->>'bonusConsumedUsd')::NUMERIC)
          AND (NOT (batch."expected" ? 'discountRate') OR allocation."discount_rate"
            IS NOT DISTINCT FROM (batch."expected"->>'discountRate')::NUMERIC)
          AND (NOT (batch."expected" ? 'settledUsd') OR allocation."settled_usd"
            IS NOT DISTINCT FROM (batch."expected"->>'settledUsd')::NUMERIC)
          AND (NOT (batch."expected" ? 'settledAt') OR allocation."settled_at"
            IS NOT DISTINCT FROM (batch."expected"->>'settledAt')::TIMESTAMP(3))
          AND (NOT (batch."expected" ? 'ledgerSequence') OR allocation."ledger_sequence"
            IS NOT DISTINCT FROM (batch."expected"->>'ledgerSequence')::BIGINT)
        RETURNING 1
      )
      SELECT COUNT(*)::INTEGER AS "count" FROM inserted`;
    const batchCount = end - start;
    if (result?.count !== batchCount) {
      throw new Error(`STALE_ALLOCATION_AUDIT:CARDINALITY:${result?.count ?? 0}/${batchCount}`);
    }
  }
}

export async function assertCompleteMutationAuditSets(
  tx: Prisma.TransactionClient,
  runId: string,
  repairAccountId: string,
  billingAccountId: string,
  counts: Pick<StagedRepairMutationCounts, 'transactionCount' | 'allocationCount'>,
): Promise<void> {
  const [transactionAuditSet] = await tx.$queryRaw<Array<{
    durableCount: number;
    exactCount: number;
  }>>`
    SELECT
      (SELECT COUNT(*)::INTEGER
        FROM "balance_ledger_transaction_repairs" audit
        WHERE audit."run_id" = ${runId}
          AND audit."repair_account_id" = ${repairAccountId}
          AND audit."billing_account_id" = ${billingAccountId}) AS "durableCount",
      (SELECT COUNT(*)::INTEGER
        FROM "balance_ledger_repair_transaction_stage" stage
        JOIN "balance_ledger_transaction_repairs" audit
          ON audit."run_id" = ${runId}
          AND audit."repair_account_id" = ${repairAccountId}
          AND audit."billing_account_id" = ${billingAccountId}
          AND audit."transaction_id" = stage."transaction_id"
        JOIN "balance_transactions" balance_transaction
          ON balance_transaction."id" = stage."transaction_id"
          AND balance_transaction."billing_account_id" = ${billingAccountId}
        WHERE audit."before_snapshot" = to_jsonb(balance_transaction)
          AND audit."after_snapshot" = to_jsonb(balance_transaction) || jsonb_build_object(
            'ledger_sequence', stage."ledger_sequence"
          )) AS "exactCount"`;
  if (
    (transactionAuditSet?.durableCount ?? 0) !== counts.transactionCount
    || (transactionAuditSet?.exactCount ?? 0) !== counts.transactionCount
  ) {
    throw new Error(
      `TRANSACTION_AUDIT_SET_INCOMPLETE:${transactionAuditSet?.exactCount ?? 0}`
      + `/${counts.transactionCount}:durable=${transactionAuditSet?.durableCount ?? 0}`,
    );
  }

  const [allocationAuditSet] = await tx.$queryRaw<Array<{
    durableCount: number;
    exactCount: number;
  }>>`
    SELECT
      (SELECT COUNT(*)::INTEGER
        FROM "balance_ledger_allocation_repairs" audit
        WHERE audit."run_id" = ${runId}
          AND audit."repair_account_id" = ${repairAccountId}
          AND audit."billing_account_id" = ${billingAccountId}) AS "durableCount",
      (SELECT COUNT(*)::INTEGER
        FROM "balance_ledger_repair_allocation_stage" stage
        JOIN "balance_ledger_allocation_repairs" audit
          ON audit."run_id" = ${runId}
          AND audit."repair_account_id" = ${repairAccountId}
          AND audit."billing_account_id" = ${billingAccountId}
          AND audit."allocation_id" = stage."allocation_id"
        JOIN "balance_consumption_allocations" allocation
          ON allocation."id" = stage."allocation_id"
          AND allocation."billing_account_id" = ${billingAccountId}
        WHERE audit."before_snapshot" = to_jsonb(allocation)
          AND audit."after_snapshot" = to_jsonb(allocation)
            || CASE WHEN stage."target" ? 'source' THEN jsonb_build_object(
              'source', stage."target"->>'source'
            ) ELSE '{}'::JSONB END
            || CASE WHEN stage."target" ? 'balanceGrantId' THEN jsonb_build_object(
              'balance_grant_id', stage."target"->>'balanceGrantId'
            ) ELSE '{}'::JSONB END
            || CASE WHEN stage."target" ? 'amountUsd' THEN jsonb_build_object(
              'amount_usd', (stage."target"->>'amountUsd')::NUMERIC
            ) ELSE '{}'::JSONB END
            || CASE WHEN stage."target" ? 'recognizedRevenueUsd' THEN jsonb_build_object(
              'recognized_revenue_usd', (stage."target"->>'recognizedRevenueUsd')::NUMERIC
            ) ELSE '{}'::JSONB END
            || CASE WHEN stage."target" ? 'bonusConsumedUsd' THEN jsonb_build_object(
              'bonus_consumed_usd', (stage."target"->>'bonusConsumedUsd')::NUMERIC
            ) ELSE '{}'::JSONB END
            || CASE WHEN stage."target" ? 'discountRate' THEN jsonb_build_object(
              'discount_rate', (stage."target"->>'discountRate')::NUMERIC
            ) ELSE '{}'::JSONB END
            || CASE WHEN stage."target" ? 'settledUsd' THEN jsonb_build_object(
              'settled_usd', (stage."target"->>'settledUsd')::NUMERIC
            ) ELSE '{}'::JSONB END
            || CASE WHEN stage."target" ? 'settledAt' THEN jsonb_build_object(
              'settled_at', (stage."target"->>'settledAt')::TIMESTAMP(3)
            ) ELSE '{}'::JSONB END
            || CASE WHEN stage."target" ? 'ledgerSequence' THEN jsonb_build_object(
              'ledger_sequence', (stage."target"->>'ledgerSequence')::BIGINT
            ) ELSE '{}'::JSONB END) AS "exactCount"`;
  if (
    (allocationAuditSet?.durableCount ?? 0) !== counts.allocationCount
    || (allocationAuditSet?.exactCount ?? 0) !== counts.allocationCount
  ) {
    throw new Error(
      `ALLOCATION_AUDIT_SET_INCOMPLETE:${allocationAuditSet?.exactCount ?? 0}`
      + `/${counts.allocationCount}:durable=${allocationAuditSet?.durableCount ?? 0}`,
    );
  }
}

export async function applyTransactionSequenceMutationsFromStage(
  tx: Prisma.TransactionClient,
  runId: string,
  repairAccountId: string,
  billingAccountId: string,
  expectedCount: number,
): Promise<void> {
  await assertStagedMutationCount(
    tx,
    'balance_ledger_repair_transaction_stage',
    expectedCount,
  );
  for (let start = 0; start < expectedCount; start += BOUNDED_MUTATION_BATCH_ROWS) {
    const end = Math.min(start + BOUNDED_MUTATION_BATCH_ROWS, expectedCount);
    const [result] = await tx.$queryRaw<Array<{ count: number }>>`
      WITH batch AS (
        SELECT *
        FROM "balance_ledger_repair_transaction_stage"
        WHERE "stage_ordinal" > ${start} AND "stage_ordinal" <= ${end}
      ), updated AS (
        UPDATE "balance_transactions" balance_transaction
        SET "ledger_sequence" = batch."ledger_sequence"
        FROM batch
        WHERE balance_transaction."id" = batch."transaction_id"
          AND balance_transaction."billing_account_id" = ${billingAccountId}
          AND balance_transaction."ledger_sequence" IS NULL
          AND EXISTS (
            SELECT 1
            FROM "balance_ledger_transaction_repairs" audit
            WHERE audit."run_id" = ${runId}
              AND audit."repair_account_id" = ${repairAccountId}
              AND audit."billing_account_id" = ${billingAccountId}
              AND audit."transaction_id" = balance_transaction."id"
          )
        RETURNING 1
      )
      SELECT COUNT(*)::INTEGER AS "count" FROM updated`;
    const batchCount = end - start;
    if (result?.count !== batchCount) {
      throw new Error(`STALE_TRANSACTION_SEQUENCE:CARDINALITY:${result?.count ?? 0}/${batchCount}`);
    }
  }
}

export async function applyAllocationMutationsFromStage(
  tx: Prisma.TransactionClient,
  runId: string,
  repairAccountId: string,
  billingAccountId: string,
  expectedCount: number,
): Promise<void> {
  await assertStagedMutationCount(
    tx,
    'balance_ledger_repair_allocation_stage',
    expectedCount,
  );
  for (let start = 0; start < expectedCount; start += BOUNDED_MUTATION_BATCH_ROWS) {
    const end = Math.min(start + BOUNDED_MUTATION_BATCH_ROWS, expectedCount);
    const [result] = await tx.$queryRaw<Array<{ count: number }>>`
      WITH batch AS (
        SELECT *
        FROM "balance_ledger_repair_allocation_stage"
        WHERE "stage_ordinal" > ${start} AND "stage_ordinal" <= ${end}
      ), updated AS (
        UPDATE "balance_consumption_allocations" allocation
        SET
          "source" = CASE WHEN batch."target" ? 'source'
            THEN batch."target"->>'source' ELSE allocation."source" END,
          "balance_grant_id" = CASE WHEN batch."target" ? 'balanceGrantId'
            THEN batch."target"->>'balanceGrantId' ELSE allocation."balance_grant_id" END,
          "amount_usd" = CASE WHEN batch."target" ? 'amountUsd'
            THEN (batch."target"->>'amountUsd')::NUMERIC ELSE allocation."amount_usd" END,
          "recognized_revenue_usd" = CASE WHEN batch."target" ? 'recognizedRevenueUsd'
            THEN (batch."target"->>'recognizedRevenueUsd')::NUMERIC
            ELSE allocation."recognized_revenue_usd" END,
          "bonus_consumed_usd" = CASE WHEN batch."target" ? 'bonusConsumedUsd'
            THEN (batch."target"->>'bonusConsumedUsd')::NUMERIC
            ELSE allocation."bonus_consumed_usd" END,
          "discount_rate" = CASE WHEN batch."target" ? 'discountRate'
            THEN (batch."target"->>'discountRate')::NUMERIC ELSE allocation."discount_rate" END,
          "settled_usd" = CASE WHEN batch."target" ? 'settledUsd'
            THEN (batch."target"->>'settledUsd')::NUMERIC ELSE allocation."settled_usd" END,
          "settled_at" = CASE WHEN batch."target" ? 'settledAt'
            THEN (batch."target"->>'settledAt')::TIMESTAMP(3) ELSE allocation."settled_at" END,
          "ledger_sequence" = CASE WHEN batch."target" ? 'ledgerSequence'
            THEN (batch."target"->>'ledgerSequence')::BIGINT ELSE allocation."ledger_sequence" END
        FROM batch
        WHERE allocation."id" = batch."allocation_id"
          AND allocation."billing_account_id" = ${billingAccountId}
          AND EXISTS (
            SELECT 1
            FROM "balance_ledger_allocation_repairs" audit
            WHERE audit."run_id" = ${runId}
              AND audit."repair_account_id" = ${repairAccountId}
              AND audit."billing_account_id" = ${billingAccountId}
              AND audit."allocation_id" = allocation."id"
          )
          AND (batch."canonical" IS NULL OR (
            allocation."user_id" IS NOT DISTINCT FROM batch."canonical"->>'expectedUserId'
            AND allocation."tenant_id" IS NOT DISTINCT FROM batch."canonical"->>'expectedTenantId'
            AND allocation."product_id" IS NOT DISTINCT FROM batch."canonical"->>'expectedProductId'
            AND allocation."balance_transaction_id" IS NOT DISTINCT FROM
              batch."canonical"->>'expectedBalanceTransactionId'
            AND allocation."token_usage_id" IS NOT DISTINCT FROM
              batch."canonical"->>'expectedTokenUsageId'
            AND allocation."created_at" IS NOT DISTINCT FROM
              (batch."canonical"->>'expectedCreatedAt')::TIMESTAMP(3)
          ))
          AND (NOT (batch."expected" ? 'source') OR allocation."source"
            IS NOT DISTINCT FROM batch."expected"->>'source')
          AND (NOT (batch."expected" ? 'balanceGrantId') OR allocation."balance_grant_id"
            IS NOT DISTINCT FROM batch."expected"->>'balanceGrantId')
          AND (NOT (batch."expected" ? 'amountUsd') OR allocation."amount_usd"
            IS NOT DISTINCT FROM (batch."expected"->>'amountUsd')::NUMERIC)
          AND (NOT (batch."expected" ? 'recognizedRevenueUsd')
            OR allocation."recognized_revenue_usd" IS NOT DISTINCT FROM
              (batch."expected"->>'recognizedRevenueUsd')::NUMERIC)
          AND (NOT (batch."expected" ? 'bonusConsumedUsd')
            OR allocation."bonus_consumed_usd" IS NOT DISTINCT FROM
              (batch."expected"->>'bonusConsumedUsd')::NUMERIC)
          AND (NOT (batch."expected" ? 'discountRate') OR allocation."discount_rate"
            IS NOT DISTINCT FROM (batch."expected"->>'discountRate')::NUMERIC)
          AND (NOT (batch."expected" ? 'settledUsd') OR allocation."settled_usd"
            IS NOT DISTINCT FROM (batch."expected"->>'settledUsd')::NUMERIC)
          AND (NOT (batch."expected" ? 'settledAt') OR allocation."settled_at"
            IS NOT DISTINCT FROM (batch."expected"->>'settledAt')::TIMESTAMP(3))
          AND (NOT (batch."expected" ? 'ledgerSequence') OR allocation."ledger_sequence"
            IS NOT DISTINCT FROM (batch."expected"->>'ledgerSequence')::BIGINT)
        RETURNING 1
      )
      SELECT COUNT(*)::INTEGER AS "count" FROM updated`;
    const batchCount = end - start;
    if (result?.count !== batchCount) {
      throw new Error(`STALE_ALLOCATION:CARDINALITY:${result?.count ?? 0}/${batchCount}`);
    }
  }
}

export async function registerMigrationOpeningGrantRetirementsSetBased(
  tx: Prisma.TransactionClient,
  runId: string,
  repairAccountId: string,
  billingAccountId: string,
  mutations: Extract<BalanceLedgerRepairPlan, { status: 'READY' }>['migrationOpeningDebtMutations'],
): Promise<void> {
  if (mutations.length === 0) return;
  const inputJson = JSON.stringify(mutations.map((mutation) => ({
    auditId: randomUUID(),
    allocationId: mutation.allocationId,
    grantId: mutation.grantId,
    expectedGrant: mutation.expectedGrant,
  })));
  const inserted = await tx.$queryRaw<Array<{ grantId: string }>>`
    WITH mutation_input AS (
      SELECT
        mutation.value->>'auditId' AS audit_id,
        mutation.value->>'allocationId' AS allocation_id,
        mutation.value->>'grantId' AS grant_id,
        mutation.value->'expectedGrant' AS expected_grant
      FROM jsonb_array_elements(${inputJson}::JSONB) AS mutation(value)
    )
    INSERT INTO "balance_ledger_grant_retirement_repairs" (
      "id", "operation_key", "run_id", "repair_account_id",
      "billing_account_id", "grant_id", "allocation_id", "before_snapshot"
    )
    SELECT
      mutation_input.audit_id,
      'repair:migration-opening-retirement:' || ${runId} || ':' || grant_row."id",
      ${runId},
      ${repairAccountId},
      ${billingAccountId},
      grant_row."id",
      mutation_input.allocation_id,
      to_jsonb(grant_row)
    FROM mutation_input
    JOIN "balance_grants" grant_row ON grant_row."id" = mutation_input.grant_id
    WHERE grant_row."billing_account_id" = ${billingAccountId}
      AND grant_row."user_id" IS NOT DISTINCT FROM mutation_input.expected_grant->>'userId'
      AND grant_row."tenant_id" IS NOT DISTINCT FROM mutation_input.expected_grant->>'tenantId'
      AND grant_row."product_id" IS NOT DISTINCT FROM mutation_input.expected_grant->>'productId'
      AND grant_row."order_id" IS NOT DISTINCT FROM mutation_input.expected_grant->>'orderId'
      AND grant_row."source" IS NOT DISTINCT FROM mutation_input.expected_grant->>'source'
      AND grant_row."paid_amount_usd" IS NOT DISTINCT FROM
        (mutation_input.expected_grant->>'paidAmountUsd')::NUMERIC
      AND grant_row."bonus_amount_usd" IS NOT DISTINCT FROM
        (mutation_input.expected_grant->>'bonusAmountUsd')::NUMERIC
      AND grant_row."granted_amount_usd" IS NOT DISTINCT FROM
        (mutation_input.expected_grant->>'grantedAmountUsd')::NUMERIC
      AND grant_row."remaining_amount_usd" IS NOT DISTINCT FROM
        (mutation_input.expected_grant->>'remainingAmountUsd')::NUMERIC
      AND grant_row."remaining_paid_amount_usd" IS NOT DISTINCT FROM
        (mutation_input.expected_grant->>'remainingPaidAmountUsd')::NUMERIC
      AND grant_row."remaining_bonus_amount_usd" IS NOT DISTINCT FROM
        (mutation_input.expected_grant->>'remainingBonusAmountUsd')::NUMERIC
      AND grant_row."discount_rate" IS NOT DISTINCT FROM
        (mutation_input.expected_grant->>'discountRate')::NUMERIC
      AND grant_row."valid_from" IS NOT DISTINCT FROM
        ((mutation_input.expected_grant->>'validFrom')::TIMESTAMPTZ AT TIME ZONE 'UTC')
      AND grant_row."expires_at" IS NOT DISTINCT FROM
        ((mutation_input.expected_grant->>'expiresAt')::TIMESTAMPTZ AT TIME ZONE 'UTC')
      AND grant_row."is_expired" IS NOT DISTINCT FROM
        (mutation_input.expected_grant->>'isExpired')::BOOLEAN
      AND grant_row."created_at" IS NOT DISTINCT FROM
        ((mutation_input.expected_grant->>'createdAt')::TIMESTAMPTZ AT TIME ZONE 'UTC')
    RETURNING "grant_id" AS "grantId"`;
  assertSetMutationCardinality(
    'STALE_MIGRATION_OPENING_RETIREMENT_AUDIT',
    mutations.map((mutation) => mutation.grantId),
    inserted.map((row) => row.grantId),
  );
}

export async function retireMigrationOpeningGrantsSetBased(
  tx: Prisma.TransactionClient,
  runId: string,
  repairAccountId: string,
  billingAccountId: string,
  mutations: Extract<BalanceLedgerRepairPlan, { status: 'READY' }>['migrationOpeningDebtMutations'],
): Promise<void> {
  if (mutations.length === 0) return;
  const inputJson = JSON.stringify(mutations.map((mutation) => ({
    allocationId: mutation.allocationId,
    grantId: mutation.grantId,
    expectedGrant: mutation.expectedGrant,
  })));
  const retired = await tx.$queryRaw<Array<{ grantId: string }>>`
    WITH mutation_input AS (
      SELECT
        mutation.value->>'allocationId' AS allocation_id,
        mutation.value->>'grantId' AS grant_id,
        mutation.value->'expectedGrant' AS expected_grant
      FROM jsonb_array_elements(${inputJson}::JSONB) AS mutation(value)
    )
    DELETE FROM "balance_grants" grant_row
    USING mutation_input
    WHERE grant_row."id" = mutation_input.grant_id
      AND grant_row."billing_account_id" = ${billingAccountId}
      AND grant_row."user_id" IS NOT DISTINCT FROM mutation_input.expected_grant->>'userId'
      AND grant_row."tenant_id" IS NOT DISTINCT FROM mutation_input.expected_grant->>'tenantId'
      AND grant_row."product_id" IS NOT DISTINCT FROM mutation_input.expected_grant->>'productId'
      AND grant_row."order_id" IS NOT DISTINCT FROM mutation_input.expected_grant->>'orderId'
      AND grant_row."source" IS NOT DISTINCT FROM mutation_input.expected_grant->>'source'
      AND grant_row."paid_amount_usd" IS NOT DISTINCT FROM
        (mutation_input.expected_grant->>'paidAmountUsd')::NUMERIC
      AND grant_row."bonus_amount_usd" IS NOT DISTINCT FROM
        (mutation_input.expected_grant->>'bonusAmountUsd')::NUMERIC
      AND grant_row."granted_amount_usd" IS NOT DISTINCT FROM
        (mutation_input.expected_grant->>'grantedAmountUsd')::NUMERIC
      AND grant_row."remaining_amount_usd" IS NOT DISTINCT FROM
        (mutation_input.expected_grant->>'remainingAmountUsd')::NUMERIC
      AND grant_row."remaining_paid_amount_usd" IS NOT DISTINCT FROM
        (mutation_input.expected_grant->>'remainingPaidAmountUsd')::NUMERIC
      AND grant_row."remaining_bonus_amount_usd" IS NOT DISTINCT FROM
        (mutation_input.expected_grant->>'remainingBonusAmountUsd')::NUMERIC
      AND grant_row."discount_rate" IS NOT DISTINCT FROM
        (mutation_input.expected_grant->>'discountRate')::NUMERIC
      AND grant_row."valid_from" IS NOT DISTINCT FROM
        ((mutation_input.expected_grant->>'validFrom')::TIMESTAMPTZ AT TIME ZONE 'UTC')
      AND grant_row."expires_at" IS NOT DISTINCT FROM
        ((mutation_input.expected_grant->>'expiresAt')::TIMESTAMPTZ AT TIME ZONE 'UTC')
      AND grant_row."is_expired" IS NOT DISTINCT FROM
        (mutation_input.expected_grant->>'isExpired')::BOOLEAN
      AND grant_row."created_at" IS NOT DISTINCT FROM
        ((mutation_input.expected_grant->>'createdAt')::TIMESTAMPTZ AT TIME ZONE 'UTC')
      AND EXISTS (
        SELECT 1
        FROM "balance_ledger_grant_retirement_repairs" retirement
        JOIN "balance_ledger_allocation_repairs" allocation_repair
          ON allocation_repair."run_id" = retirement."run_id"
          AND allocation_repair."repair_account_id" = retirement."repair_account_id"
          AND allocation_repair."billing_account_id" = retirement."billing_account_id"
          AND allocation_repair."allocation_id" = retirement."allocation_id"
        JOIN "balance_consumption_allocations" allocation
          ON allocation."id" = allocation_repair."allocation_id"
        WHERE retirement."run_id" = ${runId}
          AND retirement."repair_account_id" = ${repairAccountId}
          AND retirement."billing_account_id" = ${billingAccountId}
          AND retirement."grant_id" = grant_row."id"
          AND retirement."allocation_id" = mutation_input.allocation_id
          AND retirement."before_snapshot" IS NOT DISTINCT FROM to_jsonb(grant_row)
          AND allocation_repair."billing_account_id" = ${billingAccountId}
          AND allocation_repair."before_snapshot"->>'balance_grant_id' = grant_row."id"
          AND allocation_repair."after_snapshot" IS NOT DISTINCT FROM to_jsonb(allocation)
          AND allocation."source" = 'NEGATIVE_BALANCE'
          AND allocation."balance_grant_id" IS NULL
      )
    RETURNING grant_row."id" AS "grantId"`;
  assertSetMutationCardinality(
    'STALE_MIGRATION_OPENING_GRANT',
    mutations.map((mutation) => mutation.grantId),
    retired.map((row) => row.grantId),
  );
}

async function assertSettlementPostcondition(
  tx: Prisma.TransactionClient,
  runId: string,
  plan: Extract<BalanceLedgerRepairPlan, { status: 'READY' }>,
): Promise<void> {
  const rows = await tx.enterpriseCreditSettlement.findMany({
    where: { billingAccountId: plan.billingAccountId },
    orderBy: { operationKey: 'asc' },
    select: {
      billingAccountId: true,
      allocationId: true,
      repaymentTransactionId: true,
      balanceGrantId: true,
      debtSource: true,
      repairRunId: true,
      operationKey: true,
      trigger: true,
      amountUsd: true,
      paidUsd: true,
      bonusUsd: true,
      occurredAt: true,
    },
  });
  if (rows.length !== plan.expectedSettlementCount) {
    throw new Error(
      `POSTCONDITION_SETTLEMENT_COUNT:${rows.length}:${plan.expectedSettlementCount}`,
    );
  }
  if (plan.settlementWriteMode !== 'CREATE') return;

  const actual = rows.map((row) => ({
    billingAccountId: row.billingAccountId,
    allocationId: row.allocationId,
    repaymentTransactionId: row.repaymentTransactionId,
    balanceGrantId: row.balanceGrantId,
    debtSource: row.debtSource,
    repairRunId: row.repairRunId,
    operationKey: row.operationKey,
    trigger: row.trigger,
    amountUsd: decimal(row.amountUsd),
    paidUsd: decimal(row.paidUsd),
    bonusUsd: decimal(row.bonusUsd),
    occurredAt: row.occurredAt.toISOString(),
  })).sort((left, right) => (left.operationKey ?? '').localeCompare(right.operationKey ?? ''));
  const expected = plan.settlementMutations.map((settlement) => ({
    billingAccountId: plan.billingAccountId,
    allocationId: settlement.allocationId,
    repaymentTransactionId: settlement.repaymentTransactionId,
    balanceGrantId: settlement.balanceGrantId,
    debtSource: settlement.debtSource,
    repairRunId: runId,
    operationKey: settlementOperationKey(runId, settlement),
    trigger: 'REPAIR',
    amountUsd: decimal(settlement.amountUsd),
    paidUsd: decimal(settlement.paidUsd),
    bonusUsd: decimal(settlement.bonusUsd),
    occurredAt: new Date(settlement.occurredAt).toISOString(),
  })).sort((left, right) => left.operationKey.localeCompare(right.operationKey));
  if (JSON.stringify(actual) !== JSON.stringify(expected)) {
    throw new Error('POSTCONDITION_SETTLEMENT_CANONICAL_MISMATCH');
  }
}

type ReadyBalanceLedgerRepairPlan = Extract<BalanceLedgerRepairPlan, { status: 'READY' }>;
type LegacyAdminFundingRepair = ReadyBalanceLedgerRepairPlan['legacyAdminFundingRepairs'][number];

async function lockLegacyAdminFundingReceipts(
  tx: Prisma.TransactionClient,
  plan: ReadyBalanceLedgerRepairPlan,
): Promise<void> {
  // Lock the complete account-bound COMMITTED receipt set, not just receipt
  // IDs present in the approved plan. A newly inserted orphan/duplicate must
  // enter the lock-held snapshot and make the rebuilt plan stale/quarantined.
  await tx.$queryRaw<Array<{ lockedCount: bigint }>>(Prisma.sql`
    WITH locked_rows AS MATERIALIZED (
      SELECT idempotency_row."key", idempotency_row."scope"
      FROM "idempotency_keys" idempotency_row
      WHERE idempotency_row."scope" IN ('admin:adjust-balance', 'admin:recharge')
        AND left(
          idempotency_row."key",
          length(${`enterprise-recharge:${plan.billingAccountId}:`})
        ) = ${`enterprise-recharge:${plan.billingAccountId}:`}
        AND idempotency_row."status" = 'COMMITTED'
      ORDER BY idempotency_row."scope", idempotency_row."key"
      FOR UPDATE
    )
    SELECT COUNT(*)::BIGINT AS "lockedCount" FROM locked_rows`);
}

async function insertLegacyAdminFundingProofAndMaybeGrant(
  tx: Prisma.TransactionClient,
  runId: string,
  repairAccountId: string,
  plan: ReadyBalanceLedgerRepairPlan,
  repair: LegacyAdminFundingRepair,
): Promise<void> {
  const proofId = randomUUID();
  const isCreate = repair.action === 'CREATE_GRANT';
  const expectedTransactionType = isCreate ? 'ADJUST' : 'RECHARGE';
  const grantSnapshot = isCreate
    ? Prisma.sql`jsonb_build_object(
        'id', ${repair.grantId},
        'user_id', transaction_row."user_id",
        'tenant_id', transaction_row."tenant_id",
        'billing_account_id', transaction_row."billing_account_id",
        'order_id', NULL,
        'product_id', transaction_row."product_id",
        'source', 'RECHARGE',
        'paid_amount_usd', transaction_row."amount_usd",
        'bonus_amount_usd', 0::NUMERIC,
        'granted_amount_usd', transaction_row."amount_usd",
        'remaining_amount_usd', ${repair.finalRemainingAmountUsd}::NUMERIC,
        'remaining_paid_amount_usd', ${repair.finalRemainingPaidAmountUsd}::NUMERIC,
        'remaining_bonus_amount_usd', ${repair.finalRemainingBonusAmountUsd}::NUMERIC,
        'discount_rate', 1::NUMERIC,
        'valid_from', transaction_row."created_at",
        'expires_at', transaction_row."created_at" + INTERVAL '365 days',
        'is_expired', FALSE,
        'created_at', transaction_row."created_at",
        'updated_at', transaction_row."created_at"
      )`
    : Prisma.sql`to_jsonb(grant_row)`;
  const grantPredicate = isCreate
    ? Prisma.sql`
        AND grant_row."id" IS NULL
        AND ${repair.grantId} = ${`repair-enterprise-admin-funding:${repair.transactionId}`}
        AND ${repair.validFrom}::TIMESTAMP(3) = transaction_row."created_at"
        AND ${repair.createdAt}::TIMESTAMP(3) = transaction_row."created_at"
        AND ${repair.expiresAt}::TIMESTAMP(3)
          = transaction_row."created_at" + INTERVAL '365 days'`
    : Prisma.sql`
        AND grant_row."id" IS NOT NULL
        AND grant_row."billing_account_id" = ${repair.billingAccountId}
        AND grant_row."user_id" = ${repair.userId}
        AND grant_row."tenant_id" = ${repair.tenantId}
        AND grant_row."product_id" IS NOT DISTINCT FROM ${repair.productId}::TEXT
        AND grant_row."order_id" IS NULL
        AND grant_row."source" = 'RECHARGE'
        AND grant_row."paid_amount_usd" = ${repair.amountUsd}::NUMERIC
        AND grant_row."bonus_amount_usd" = 0
        AND grant_row."granted_amount_usd" = ${repair.amountUsd}::NUMERIC
        AND grant_row."remaining_amount_usd"
          IS NOT DISTINCT FROM ${repair.expectedGrantRemainingAmountUsd}::NUMERIC
        AND grant_row."remaining_paid_amount_usd"
          IS NOT DISTINCT FROM ${repair.expectedGrantRemainingPaidAmountUsd}::NUMERIC
        AND grant_row."remaining_bonus_amount_usd"
          IS NOT DISTINCT FROM ${repair.expectedGrantRemainingBonusAmountUsd}::NUMERIC
        AND encode(
          sha256(convert_to(to_jsonb(grant_row)::TEXT, 'UTF8')),
          'hex'
        ) = ${repair.expectedGrantSnapshotHash}
        AND grant_row."discount_rate" = 1
        AND grant_row."is_expired" = FALSE
        AND grant_row."valid_from" = ${repair.validFrom}::TIMESTAMP(3)
        AND grant_row."expires_at" = ${repair.expiresAt}::TIMESTAMP(3)
        AND grant_row."created_at" = ${repair.createdAt}::TIMESTAMP(3)`;
  const proof = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    INSERT INTO "balance_ledger_admin_funding_repairs" (
      "id", "operation_key", "proof_version", "proof_hash", "repair_kind", "action",
      "run_id", "repair_account_id", "billing_account_id", "balance_transaction_id",
      "balance_grant_id", "idempotency_key", "idempotency_scope",
      "idempotency_snapshot", "transaction_snapshot", "grant_snapshot",
      "canonical_remaining_amount_usd", "canonical_remaining_paid_amount_usd",
      "canonical_remaining_bonus_amount_usd"
    )
    SELECT ${proofId},
      ${`repair:enterprise-admin-funding:${runId}:${repair.transactionId}`},
      1, ${repair.proofHash}, ${repair.repairKind}, ${repair.action},
      repair_account."run_id", repair_account."id", transaction_row."billing_account_id",
      transaction_row."id", ${repair.grantId}, idempotency_row."key", idempotency_row."scope",
      to_jsonb(idempotency_row), to_jsonb(transaction_row), ${grantSnapshot},
      ${repair.finalRemainingAmountUsd}::NUMERIC,
      ${repair.finalRemainingPaidAmountUsd}::NUMERIC,
      ${repair.finalRemainingBonusAmountUsd}::NUMERIC
    FROM "balance_ledger_repair_accounts" repair_account
    JOIN "balance_transactions" transaction_row
      ON transaction_row."id" = ${repair.transactionId}
    JOIN "idempotency_keys" idempotency_row
      ON idempotency_row."key" = ${repair.idempotencyKey}
      AND idempotency_row."scope" = ${repair.idempotencyScope}
    LEFT JOIN "balance_grants" grant_row ON grant_row."id" = ${repair.grantId}
    WHERE repair_account."id" = ${repairAccountId}
      AND repair_account."run_id" = ${runId}
      AND repair_account."billing_account_id" = ${repair.billingAccountId}
      AND repair_account."status" = 'RUNNING'
      AND repair_account."precondition_hash" = ${plan.preconditionHash}
      AND repair_account."replay_hash" = ${plan.replayHash}
      AND transaction_row."billing_account_id" = ${repair.billingAccountId}
      AND transaction_row."user_id" = ${repair.userId}
      AND transaction_row."tenant_id" = ${repair.tenantId}
      AND transaction_row."product_id" IS NOT DISTINCT FROM ${repair.productId}::TEXT
      AND transaction_row."type"::TEXT = ${expectedTransactionType}
      AND transaction_row."amount_usd" = ${repair.amountUsd}::NUMERIC
      AND transaction_row."amount_usd" > 0
      AND transaction_row."order_id" IS NULL
      AND transaction_row."token_usage_id" IS NULL
      AND transaction_row."operation_key" IS NULL
      AND idempotency_row."status" = 'COMMITTED'
      AND idempotency_row."user_id" = ${repair.userId}
      AND idempotency_row."result" #>> '{id}' = transaction_row."id"
      AND encode(
        sha256(convert_to(to_jsonb(idempotency_row)::TEXT, 'UTF8')),
        'hex'
      ) = ${repair.idempotencyEvidenceHash}
      ${grantPredicate}
    RETURNING "id"`);
  if (proof.length !== 1) {
    throw new Error(`STALE_ADMIN_FUNDING_PROOF:${repair.transactionId}:${proof.length}`);
  }
  if (!isCreate) return;

  const inserted = await tx.$queryRaw<Array<{ id: string }>>(Prisma.sql`
    INSERT INTO "balance_grants" (
      "id", "user_id", "tenant_id", "billing_account_id", "order_id", "product_id",
      "source", "paid_amount_usd", "bonus_amount_usd", "granted_amount_usd",
      "remaining_amount_usd", "remaining_paid_amount_usd", "remaining_bonus_amount_usd",
      "discount_rate", "valid_from", "expires_at", "is_expired", "created_at", "updated_at"
    )
    SELECT proof."balance_grant_id", transaction_row."user_id", transaction_row."tenant_id",
      transaction_row."billing_account_id", NULL, transaction_row."product_id", 'RECHARGE',
      transaction_row."amount_usd", 0, transaction_row."amount_usd",
      proof."canonical_remaining_amount_usd", proof."canonical_remaining_paid_amount_usd",
      proof."canonical_remaining_bonus_amount_usd", 1, transaction_row."created_at",
      transaction_row."created_at" + INTERVAL '365 days', FALSE,
      transaction_row."created_at", transaction_row."created_at"
    FROM "balance_ledger_admin_funding_repairs" proof
    JOIN "balance_transactions" transaction_row
      ON transaction_row."id" = proof."balance_transaction_id"
    JOIN "balance_ledger_repair_accounts" repair_account
      ON repair_account."id" = proof."repair_account_id"
    WHERE proof."id" = ${proofId}
      AND proof."run_id" = ${runId}
      AND proof."repair_account_id" = ${repairAccountId}
      AND proof."billing_account_id" = ${repair.billingAccountId}
      AND proof."balance_transaction_id" = ${repair.transactionId}
      AND proof."balance_grant_id" = ${repair.grantId}
      AND proof."proof_hash" = ${repair.proofHash}
      AND proof."action" = 'CREATE_GRANT'
      AND repair_account."status" = 'RUNNING'
      AND repair_account."precondition_hash" = ${plan.preconditionHash}
      AND repair_account."replay_hash" = ${plan.replayHash}
      AND NOT EXISTS (
        SELECT 1 FROM "balance_grants" existing
        WHERE existing."id" = proof."balance_grant_id"
      )
      AND proof."grant_snapshot" = jsonb_build_object(
        'id', proof."balance_grant_id",
        'user_id', transaction_row."user_id",
        'tenant_id', transaction_row."tenant_id",
        'billing_account_id', transaction_row."billing_account_id",
        'order_id', NULL,
        'product_id', transaction_row."product_id",
        'source', 'RECHARGE',
        'paid_amount_usd', transaction_row."amount_usd",
        'bonus_amount_usd', 0::NUMERIC,
        'granted_amount_usd', transaction_row."amount_usd",
        'remaining_amount_usd', proof."canonical_remaining_amount_usd",
        'remaining_paid_amount_usd', proof."canonical_remaining_paid_amount_usd",
        'remaining_bonus_amount_usd', proof."canonical_remaining_bonus_amount_usd",
        'discount_rate', 1::NUMERIC,
        'valid_from', transaction_row."created_at",
        'expires_at', transaction_row."created_at" + INTERVAL '365 days',
        'is_expired', FALSE,
        'created_at', transaction_row."created_at",
        'updated_at', transaction_row."created_at"
      )
    RETURNING "id"`);
  if (inserted.length !== 1) {
    throw new Error(`ADMIN_FUNDING_GRANT_INSERT_FAILED:${repair.grantId}:${inserted.length}`);
  }
}

export async function configureBoundedRepairTransaction(
  tx: Prisma.TransactionClient,
): Promise<void> {
  await tx.$queryRaw`
    SELECT
      set_config('work_mem', '64MB', TRUE),
      set_config('statement_timeout', '120s', TRUE),
      set_config('lock_timeout', '5s', TRUE)`;
}

export async function lockVoucherIdempotencyReceipts(
  tx: Prisma.TransactionClient,
  plan: Pick<Extract<BalanceLedgerRepairPlan, { status: 'READY' }>, 'billingAccountId'>,
): Promise<void> {
  await tx.$queryRaw<Array<{ lockedCount: bigint }>>(Prisma.sql`
    WITH locked_rows AS MATERIALIZED (
      SELECT idempotency_row."key", idempotency_row."scope"
      FROM "idempotency_keys" idempotency_row
      WHERE EXISTS (
          SELECT 1
          FROM "balance_grants" voucher_grant
          WHERE voucher_grant."billing_account_id" = ${plan.billingAccountId}
            AND voucher_grant."source" = 'VOUCHER'
        )
        AND (
          idempotency_row."result" #>> '{transaction,id}' IN (
            SELECT transaction_row."id"
            FROM "balance_transactions" transaction_row
            WHERE transaction_row."billing_account_id" = ${plan.billingAccountId}
          )
          OR idempotency_row."result" #>> '{grant,id}' IN (
            SELECT grant_row."id"
            FROM "balance_grants" grant_row
            WHERE grant_row."billing_account_id" = ${plan.billingAccountId}
          )
          OR idempotency_row."result" #>> '{response,transaction,id}' IN (
            SELECT transaction_row."id"
            FROM "balance_transactions" transaction_row
            WHERE transaction_row."billing_account_id" = ${plan.billingAccountId}
          )
          OR idempotency_row."result" #>> '{response,grant,id}' IN (
            SELECT grant_row."id"
            FROM "balance_grants" grant_row
            WHERE grant_row."billing_account_id" = ${plan.billingAccountId}
          )
        )
      ORDER BY idempotency_row."scope", idempotency_row."key"
      FOR UPDATE
    )
    SELECT COUNT(*)::BIGINT AS "lockedCount" FROM locked_rows`);
}

async function lockRowsWithoutClientMaterialization(
  tx: Prisma.TransactionClient,
  lockingQuery: Prisma.Sql,
): Promise<void> {
  await tx.$queryRaw<Array<{ lockedCount: bigint }>>(Prisma.sql`
    WITH locked_rows AS MATERIALIZED (${lockingQuery})
    SELECT COUNT(*)::BIGINT AS "lockedCount" FROM locked_rows`);
}

function cgroupMemoryBytes(path: string): number | null {
  try {
    const value = Number(readFileSync(path, 'utf8').trim());
    return Number.isFinite(value) ? value : null;
  } catch {
    return null;
  }
}

function logRepairPhase(
  phase: string,
  startedAt: number,
  details: Record<string, unknown> = {},
): void {
  const memory = process.memoryUsage();
  console.error(JSON.stringify({
    mode: 'apply-phase',
    phase,
    elapsedMs: Date.now() - startedAt,
    rssBytes: memory.rss,
    heapUsedBytes: memory.heapUsed,
    heapTotalBytes: memory.heapTotal,
    externalBytes: memory.external,
    arrayBuffersBytes: memory.arrayBuffers,
    cgroupCurrentBytes: cgroupMemoryBytes('/sys/fs/cgroup/memory.current'),
    cgroupPeakBytes: cgroupMemoryBytes('/sys/fs/cgroup/memory.peak'),
    ...details,
  }));
}

export async function applyReadyPlan(
  runId: string,
  plan: Extract<BalanceLedgerRepairPlan, { status: 'READY' }>,
  databaseBinding: RepairDatabaseBinding,
  client: PrismaClient = prisma,
  voucherApprovalRefs: VoucherApprovalRefs | null = null,
  profile: BalanceLedgerRepairExecutionProfile = DEFAULT_EXECUTION_PROFILE,
): Promise<'APPLIED' | 'SKIPPED_STALE'> {
  if (profile.name === INVOICE_STABILITY_EVIDENCE_PROFILE) {
    assertExecutionProfilePlanSet(profile, plan.billingAccountId, [plan]);
  }
  // Validate direct callers before the transaction starts. The canonical
  // replay hash builds a temporary stable copy of the approved plan; keeping
  // that allocation outside the lock-held snapshot/replan phase prevents the
  // two O(history) object graphs from overlapping in the apply memory peak.
  const approvedReplayHash = balanceLedgerRepairReplayHash(plan);
  if (approvedReplayHash !== plan.replayHash) {
    throw new Error('approved plan canonical replay hash mismatch');
  }
  const applyStartedAt = Date.now();
  const result = await client.$transaction(async (tx) => {
    const verifiedApprovalRefs = resolveVoucherApprovalRefs(
      [plan],
      voucherApprovalRefs?.financeApprovalRef,
      voucherApprovalRefs?.technicalApprovalRef,
    );
    await configureBoundedRepairTransaction(tx);
    await loadRepairDatabaseBinding(tx, databaseBinding);
    await lockLegacyAdminFundingReceipts(tx, plan);
    // Legacy voucher proof lives in the same idempotency row that the old
    // writer acquired before the wallet. Preserve that lock order so repair
    // cannot deadlock a concurrent retry, and predicate-read every receipt
    // that references a transaction/grant in this account before rebuilding
    // the signed snapshot.
    await lockVoucherIdempotencyReceipts(tx, plan);
    await lockRowsWithoutClientMaterialization(tx, Prisma.sql`
      SELECT "balance_usd"
      FROM "account_wallets"
      WHERE "billing_account_id" = ${plan.billingAccountId}
      FOR UPDATE`);
    await lockRowsWithoutClientMaterialization(tx, Prisma.sql`
      SELECT "id"
      FROM "balance_grants"
      WHERE "billing_account_id" = ${plan.billingAccountId}
      ORDER BY "id" ASC
      FOR UPDATE`);
    await lockRowsWithoutClientMaterialization(tx, Prisma.sql`
      SELECT "id"
      FROM "balance_transactions"
      WHERE "billing_account_id" = ${plan.billingAccountId}
      ORDER BY "id" ASC
      FOR UPDATE`);
    await lockRowsWithoutClientMaterialization(tx, Prisma.sql`
      SELECT "id"
      FROM "balance_consumption_allocations"
      WHERE "billing_account_id" = ${plan.billingAccountId}
        OR "balance_transaction_id" IN (
          SELECT "id" FROM "balance_transactions"
          WHERE "billing_account_id" = ${plan.billingAccountId}
        )
        OR "balance_grant_id" IN (
          SELECT "id" FROM "balance_grants"
          WHERE "billing_account_id" = ${plan.billingAccountId}
      )
      ORDER BY "id" ASC
      FOR UPDATE`);
    await lockRowsWithoutClientMaterialization(tx, Prisma.sql`
      SELECT settlement."id"
      FROM "enterprise_credit_settlements" settlement
      WHERE settlement."billing_account_id" = ${plan.billingAccountId}
        OR settlement."repayment_transaction_id" IN (
          SELECT "id" FROM "balance_transactions"
          WHERE "billing_account_id" = ${plan.billingAccountId}
        )
        OR settlement."balance_grant_id" IN (
          SELECT "id" FROM "balance_grants"
          WHERE "billing_account_id" = ${plan.billingAccountId}
        )
        OR settlement."allocation_id" IN (
          SELECT allocation."id"
          FROM "balance_consumption_allocations" allocation
          WHERE allocation."billing_account_id" = ${plan.billingAccountId}
            OR allocation."balance_transaction_id" IN (
              SELECT "id" FROM "balance_transactions"
              WHERE "billing_account_id" = ${plan.billingAccountId}
            )
            OR allocation."balance_grant_id" IN (
              SELECT "id" FROM "balance_grants"
              WHERE "billing_account_id" = ${plan.billingAccountId}
            )
      )
      ORDER BY settlement."id" ASC
      FOR UPDATE`);
    await lockRowsWithoutClientMaterialization(tx, Prisma.sql`
      SELECT "id"
      FROM "billing_accounts"
      WHERE "id" = ${plan.billingAccountId}
      FOR UPDATE`);
    await lockRowsWithoutClientMaterialization(tx, Prisma.sql`
      SELECT order_row."id"
      FROM "orders" order_row
      WHERE order_row."id" IN (
        SELECT grant_row."order_id"
        FROM "balance_grants" grant_row
        WHERE grant_row."billing_account_id" = ${plan.billingAccountId}
          AND grant_row."order_id" IS NOT NULL
        UNION
        SELECT transaction_row."order_id"
        FROM "balance_transactions" transaction_row
        WHERE transaction_row."billing_account_id" = ${plan.billingAccountId}
          AND transaction_row."order_id" IS NOT NULL
      )
      ORDER BY order_row."id"
      FOR UPDATE`);
    await lockRowsWithoutClientMaterialization(tx, Prisma.sql`
      SELECT application."id"
      FROM "invoice_applications" application
      WHERE EXISTS (
        SELECT 1
        FROM "invoice_application_items" item
        WHERE item."application_id" = application."id"
          AND item."order_id" IN (
            SELECT grant_row."order_id"
            FROM "balance_grants" grant_row
            WHERE grant_row."billing_account_id" = ${plan.billingAccountId}
              AND grant_row."order_id" IS NOT NULL
            UNION
            SELECT transaction_row."order_id"
            FROM "balance_transactions" transaction_row
            WHERE transaction_row."billing_account_id" = ${plan.billingAccountId}
              AND transaction_row."order_id" IS NOT NULL
          )
      )
      ORDER BY application."id"
      FOR UPDATE`);
    await lockRowsWithoutClientMaterialization(tx, Prisma.sql`
      SELECT collateral_order."id"
      FROM "orders" collateral_order
      WHERE collateral_order."id" IN (
        SELECT item."order_id"
        FROM "invoice_application_items" item
        WHERE item."application_id" IN (
          SELECT application."id"
          FROM "invoice_applications" application
          WHERE EXISTS (
            SELECT 1
            FROM "invoice_application_items" subject_item
            WHERE subject_item."application_id" = application."id"
              AND subject_item."order_id" IN (
                SELECT grant_row."order_id"
                FROM "balance_grants" grant_row
                WHERE grant_row."billing_account_id" = ${plan.billingAccountId}
                  AND grant_row."order_id" IS NOT NULL
                UNION
                SELECT transaction_row."order_id"
                FROM "balance_transactions" transaction_row
                WHERE transaction_row."billing_account_id" = ${plan.billingAccountId}
                  AND transaction_row."order_id" IS NOT NULL
              )
          )
        )
      )
      ORDER BY collateral_order."id"
      FOR UPDATE`);
    await lockRowsWithoutClientMaterialization(tx, Prisma.sql`
      SELECT item."id"
      FROM "invoice_application_items" item
      WHERE item."application_id" IN (
        SELECT application."id"
        FROM "invoice_applications" application
        WHERE EXISTS (
          SELECT 1
          FROM "invoice_application_items" subject_item
          WHERE subject_item."application_id" = application."id"
            AND subject_item."order_id" IN (
              SELECT grant_row."order_id"
              FROM "balance_grants" grant_row
              WHERE grant_row."billing_account_id" = ${plan.billingAccountId}
                AND grant_row."order_id" IS NOT NULL
              UNION
              SELECT transaction_row."order_id"
              FROM "balance_transactions" transaction_row
              WHERE transaction_row."billing_account_id" = ${plan.billingAccountId}
                AND transaction_row."order_id" IS NOT NULL
            )
        )
      )
      ORDER BY item."id"
      FOR UPDATE`);
    await lockRowsWithoutClientMaterialization(tx, Prisma.sql`
      SELECT event_row."id"
      FROM "invoice_event_log" event_row
      WHERE event_row."application_id" IN (
        SELECT application."id"
        FROM "invoice_applications" application
        WHERE EXISTS (
          SELECT 1
          FROM "invoice_application_items" subject_item
          WHERE subject_item."application_id" = application."id"
            AND subject_item."order_id" IN (
              SELECT grant_row."order_id"
              FROM "balance_grants" grant_row
              WHERE grant_row."billing_account_id" = ${plan.billingAccountId}
                AND grant_row."order_id" IS NOT NULL
              UNION
              SELECT transaction_row."order_id"
              FROM "balance_transactions" transaction_row
              WHERE transaction_row."billing_account_id" = ${plan.billingAccountId}
                AND transaction_row."order_id" IS NOT NULL
            )
        )
      )
      ORDER BY event_row."id"
      FOR UPDATE`);

    logRepairPhase('locks-acquired', applyStartedAt);
    let currentPlan: BalanceLedgerRepairPlan;
    let financialNow: Date;
    let beforeManifest: Prisma.InputJsonValue;
    let lockedInvoiceItemCount: number;
    let lockedUnsafeInvoiceItemCount: number;
    let lockedExpiryAuditCount: number;
    {
      // Keep the unbounded ledger snapshot inside this lexical scope. The
      // canonical plan plus the compact account manifest are the only values
      // allowed to survive into the mutation phase.
      const snapshot = await loadSnapshot(tx, plan.billingAccountId);
      assertMaintenanceSnapshot(profile, snapshot);
      financialNow = await loadPostgresFinancialNow(tx, plan.billingAccountId);
      currentPlan = buildBalanceLedgerRepairPlan(
        snapshot,
        financialNow,
        profile.planningProfile,
      );
      beforeManifest = repairAuditJsonWithLimit(
        buildRepairAccountBeforeManifest(snapshot, currentPlan.preconditionHash),
        'REPAIR_BEFORE_MANIFEST',
        MAX_REPAIR_BEFORE_JSON_BYTES,
      );
      lockedInvoiceItemCount = snapshot.invoiceItems.length;
      lockedUnsafeInvoiceItemCount = snapshot.invoiceItems.filter((item) => (
        item.applicationStatus !== 'FAILED'
        || item.hasIssuedLifecycleEvent
        || item.invoiceNumber !== null
        || item.issueDate !== null
        || item.dueDate !== null
        || item.issuedAt !== null
        || item.pdfUrl !== null
        || item.ofdUrl !== null
      )).length;
      lockedExpiryAuditCount = snapshot.expiryAuditCount;
    }
    logRepairPhase('locked-replan-complete', applyStartedAt, {
      status: currentPlan.status,
      invoiceItemCount: lockedInvoiceItemCount,
    });
    if (
      currentPlan.status !== 'READY'
      || currentPlan.preconditionHash !== plan.preconditionHash
      || currentPlan.replayHash !== plan.replayHash
    ) {
      await tx.balanceLedgerRepairAccount.create({
        data: {
          runId,
          billingAccountId: plan.billingAccountId,
          status: 'SKIPPED_STALE',
          preconditionHash: plan.preconditionHash,
          beforeSnapshot: beforeManifest,
          error: currentPlan.status === 'QUARANTINED'
            ? currentPlan.reasons.join(';')
            : 'precondition or replay hash changed',
        },
      });
      logRepairPhase('stale-plan-recorded', applyStartedAt, {
        status: 'SKIPPED_STALE',
      });
      return 'SKIPPED_STALE';
    }
    // 从锁内最新快照重新生成的 canonical plan 才能执行。JSONL 只是经过审批的
    // 意图与 hash，绝不直接作为数据库 mutation 输入，防止计划文件被误改/篡改。
    const verifiedPlan = currentPlan;
    assertEnterpriseVerifiedAllocationMutations(verifiedPlan);
    const repairAccount = await tx.balanceLedgerRepairAccount.create({
      data: {
        runId,
        billingAccountId: verifiedPlan.billingAccountId,
        status: 'RUNNING',
        preconditionHash: verifiedPlan.preconditionHash,
        replayHash: verifiedPlan.replayHash,
        beforeSnapshot: beforeManifest,
      },
    });
    logRepairPhase('repair-account-created', applyStartedAt, {
      repairAccountId: repairAccount.id,
      beforeSnapshotBytes: Buffer.byteLength(JSON.stringify(beforeManifest), 'utf8'),
    });
    await tx.$executeRaw`
      SELECT set_config('billing.balance_ledger_repair_run_id', ${runId}, TRUE)`;

    const stagedMutationCounts = await stageRepairMutations(tx, verifiedPlan);
    logRepairPhase('mutations-staged', applyStartedAt, stagedMutationCounts);
    // Proof rows preserve the locked legacy writer output before sequence or
    // grant repair. The personal semantic proof authorizes the otherwise
    // generic OLD/NEW allocation audit; both must exist before the UPDATE and
    // the deterministic SPLIT child INSERT.
    await registerLegacyExpiryProofsSetBased(
      tx,
      runId,
      repairAccount.id,
      verifiedPlan.billingAccountId,
      verifiedPlan.legacyExpiryProofMutations,
      verifiedApprovalRefs,
    );
    // An expired pre-idempotency voucher is admissible only when the exact
    // raw legacy expiry proof already exists in this locked run. The standard
    // expiry audit remains after sequence/component repair, and the deferred
    // terminal guards require the proof and audit to commit as one pair.
    await registerLegacyVoucherFundingProofsSetBased(
      tx,
      runId,
      repairAccount.id,
      verifiedPlan.billingAccountId,
      verifiedPlan.legacyVoucherProofMutations,
      verifiedApprovalRefs,
    );
    await registerInvoiceStabilityProof(
      tx,
      runId,
      repairAccount.id,
      verifiedPlan.billingAccountId,
      verifiedPlan.invoiceStabilityProof,
      verifiedApprovalRefs,
    );
    await registerPersonalDebtAllocationProofsSetBased(
      tx,
      runId,
      repairAccount.id,
      verifiedPlan.billingAccountId,
      verifiedPlan.personalDebtAllocationMutations,
    );
    await registerTransactionSequenceMutationAuditsFromStage(
      tx,
      runId,
      repairAccount.id,
      verifiedPlan.billingAccountId,
      stagedMutationCounts.transactionCount,
    );
    await registerAllocationMutationAuditsFromStage(
      tx,
      runId,
      repairAccount.id,
      verifiedPlan.billingAccountId,
      stagedMutationCounts.allocationCount,
    );
    await assertCompleteMutationAuditSets(
      tx,
      runId,
      repairAccount.id,
      verifiedPlan.billingAccountId,
      stagedMutationCounts,
    );
    logRepairPhase('all-mutation-audits-registered', applyStartedAt, stagedMutationCounts);

    // No historical financial row may change before both complete audit sets
    // have been registered and cardinality-checked above.
    await applyTransactionSequenceMutationsFromStage(
      tx,
      runId,
      repairAccount.id,
      verifiedPlan.billingAccountId,
      stagedMutationCounts.transactionCount,
    );
    logRepairPhase('transaction-mutations-applied', applyStartedAt, {
      transactionCount: stagedMutationCounts.transactionCount,
    });
    // LINK proofs reserve every legitimate pre-existing grant first. CREATE
    // proofs can then be evaluated without confusing a separately receipted
    // legacy recharge grant for an orphan batch belonging to an ADJUST row.
    const orderedAdminFundingRepairs = [...verifiedPlan.legacyAdminFundingRepairs].sort(
      (left, right) => (
        Number(left.action === 'CREATE_GRANT') - Number(right.action === 'CREATE_GRANT')
        || left.transactionId.localeCompare(right.transactionId)
      ),
    );
    for (const fundingRepair of orderedAdminFundingRepairs) {
      await insertLegacyAdminFundingProofAndMaybeGrant(
        tx,
        runId,
        repairAccount.id,
        verifiedPlan,
        fundingRepair,
      );
    }
    for (const mutation of verifiedPlan.grantMutations) {
      const updated = await tx.balanceGrant.updateMany({
        where: {
          id: mutation.grantId,
          billingAccountId: verifiedPlan.billingAccountId,
          remainingAmountUsd: new Prisma.Decimal(mutation.expectedRemainingAmountUsd),
          remainingPaidAmountUsd: mutation.expectedRemainingPaidAmountUsd === null
            ? null
            : new Prisma.Decimal(mutation.expectedRemainingPaidAmountUsd),
          remainingBonusAmountUsd: mutation.expectedRemainingBonusAmountUsd === null
            ? null
            : new Prisma.Decimal(mutation.expectedRemainingBonusAmountUsd),
        },
        data: {
          remainingAmountUsd: new Prisma.Decimal(mutation.remainingAmountUsd),
          remainingPaidAmountUsd: new Prisma.Decimal(mutation.remainingPaidAmountUsd),
          remainingBonusAmountUsd: new Prisma.Decimal(mutation.remainingBonusAmountUsd),
        },
      });
      if (updated.count !== 1) throw new Error(`STALE_GRANT:${mutation.grantId}`);
    }
    await insertLegacyExpiryAuditsSetBased(
      tx,
      runId,
      repairAccount.id,
      verifiedPlan.billingAccountId,
      verifiedPlan.legacyExpiryProofMutations,
    );
    await applyAllocationMutationsFromStage(
      tx,
      runId,
      repairAccount.id,
      verifiedPlan.billingAccountId,
      stagedMutationCounts.allocationCount,
    );
    logRepairPhase('allocation-mutations-applied', applyStartedAt, {
      allocationCount: stagedMutationCounts.allocationCount,
    });
    await insertPersonalDebtAllocationsSetBased(
      tx,
      runId,
      repairAccount.id,
      verifiedPlan.billingAccountId,
      verifiedPlan.personalDebtAllocationMutations,
    );
    // Retirement proof is admissible only after this exact run has rewritten
    // the writer-created BALANCE_GRANT allocation into canonical debt. The
    // database INSERT guard binds the raw grant snapshot to that repair row.
    await registerMigrationOpeningGrantRetirementsSetBased(
      tx,
      runId,
      repairAccount.id,
      verifiedPlan.billingAccountId,
      verifiedPlan.migrationOpeningDebtMutations,
    );
    await retireMigrationOpeningGrantsSetBased(
      tx,
      runId,
      repairAccount.id,
      verifiedPlan.billingAccountId,
      verifiedPlan.migrationOpeningDebtMutations,
    );

    if (verifiedPlan.settlementWriteMode === 'CREATE') {
      for (const settlement of verifiedPlan.settlementMutations) {
        await tx.enterpriseCreditSettlement.create({
          data: {
            billingAccountId: verifiedPlan.billingAccountId,
            allocationId: settlement.allocationId,
            repaymentTransactionId: settlement.repaymentTransactionId,
            balanceGrantId: settlement.balanceGrantId,
            debtSource: settlement.debtSource,
            repairRunId: runId,
            operationKey: settlementOperationKey(runId, settlement),
            trigger: 'REPAIR',
            amountUsd: new Prisma.Decimal(settlement.amountUsd),
            paidUsd: new Prisma.Decimal(settlement.paidUsd),
            bonusUsd: new Prisma.Decimal(settlement.bonusUsd),
            occurredAt: new Date(settlement.occurredAt),
          },
        });
      }
    }

    await assertSettlementPostcondition(tx, runId, verifiedPlan);

    const [postcondition] = await tx.$queryRaw<Array<{
      wallet_usd: Prisma.Decimal;
      active_grant_usd: Prisma.Decimal;
      open_debt_usd: Prisma.Decimal;
      transaction_tail_id: string | null;
      transaction_tail_usd: Prisma.Decimal;
      invalid_transaction_sequence_count: bigint;
      invalid_component_count: bigint;
      invalid_allocation_sequence_count: bigint;
      invalid_grant_allocation_count: bigint;
      unexpected_debt_count: bigint;
      settlement_count: bigint;
      invalid_settlement_count: bigint;
      invalid_consume_allocation_count: bigint;
      invalid_grant_conservation_count: bigint;
      transaction_repair_count: bigint;
      allocation_repair_count: bigint;
      personal_debt_repair_count: bigint;
      invalid_personal_debt_repair_count: bigint;
      voucher_funding_proof_count: bigint;
      invalid_voucher_funding_proof_count: bigint;
      legacy_expiry_proof_count: bigint;
      expiry_audit_count: bigint;
      invoice_stability_proof_count: bigint;
      admin_funding_proof_count: bigint;
      admin_funding_create_count: bigint;
      admin_funding_link_count: bigint;
      admin_funding_final_grant_count: bigint;
      invoice_item_count: bigint;
      unsafe_invoice_item_count: bigint;
      invalid_invoice_application_count: bigint;
      invoice_evidence_sha256: string;
    }>>`
      SELECT
        aw."balance_usd" AS "wallet_usd",
        COALESCE((
          SELECT SUM(bg."remaining_amount_usd")
          FROM "balance_grants" bg
          WHERE bg."billing_account_id" = ${verifiedPlan.billingAccountId}
            AND bg."is_expired" = FALSE
        ), 0) AS "active_grant_usd",
        COALESCE((
          SELECT SUM(bca."amount_usd" - bca."settled_usd")
          FROM "balance_consumption_allocations" bca
          WHERE bca."billing_account_id" = ${verifiedPlan.billingAccountId}
            AND bca."source" = ${verifiedPlan.debtSource}
        ), 0) AS "open_debt_usd",
        (
          SELECT bt."id"
          FROM "balance_transactions" bt
          WHERE bt."billing_account_id" = ${verifiedPlan.billingAccountId}
          ORDER BY bt."ledger_sequence" DESC
          LIMIT 1
        ) AS "transaction_tail_id",
        COALESCE((
          SELECT bt."balance_after_usd"
          FROM "balance_transactions" bt
          WHERE bt."billing_account_id" = ${verifiedPlan.billingAccountId}
          ORDER BY bt."ledger_sequence" DESC
          LIMIT 1
        ), 0) AS "transaction_tail_usd",
        (
          SELECT COUNT(*)
          FROM (
            SELECT bt."ledger_sequence",
              bt."balance_after_usd" - bt."amount_usd" AS before_usd,
              LAG(bt."balance_after_usd", 1, 0) OVER (
                ORDER BY bt."ledger_sequence"
              ) AS expected_before_usd,
              ROW_NUMBER() OVER (ORDER BY bt."ledger_sequence") AS sequence_position,
              COUNT(*) FILTER (WHERE bt."ledger_sequence" < 0) OVER () AS legacy_count
            FROM "balance_transactions" bt
            WHERE bt."billing_account_id" = ${verifiedPlan.billingAccountId}
          ) sequenced
          WHERE sequenced."ledger_sequence" IS NULL
            OR sequenced."ledger_sequence" = 0
            OR sequenced.before_usd IS DISTINCT FROM sequenced.expected_before_usd
            OR (
              sequenced."ledger_sequence" < 0
              AND sequenced."ledger_sequence"
                <> sequenced.sequence_position - sequenced.legacy_count - 1
            )
        ) AS "invalid_transaction_sequence_count",
        (
          SELECT COUNT(*)
          FROM "balance_ledger_transaction_repairs" tr
          WHERE tr."run_id" = ${runId}
            AND tr."repair_account_id" = ${repairAccount.id}
            AND tr."billing_account_id" = ${verifiedPlan.billingAccountId}
        ) AS "transaction_repair_count",
        (
          SELECT COUNT(*)
          FROM "balance_grants" bg
          WHERE bg."billing_account_id" = ${verifiedPlan.billingAccountId}
            AND (
              bg."remaining_paid_amount_usd" IS NULL
              OR bg."remaining_bonus_amount_usd" IS NULL
              OR bg."remaining_paid_amount_usd" < 0
              OR bg."remaining_bonus_amount_usd" < 0
              OR bg."remaining_amount_usd"
                <> bg."remaining_paid_amount_usd" + bg."remaining_bonus_amount_usd"
              OR bg."paid_amount_usd" + bg."bonus_amount_usd" <> bg."granted_amount_usd"
              OR bg."granted_amount_usd" <= 0
              OR bg."discount_rate" IS DISTINCT FROM CASE
                WHEN bg."granted_amount_usd" > 0 THEN ROUND(
                  bg."paid_amount_usd" / bg."granted_amount_usd",
                  12
                )
                ELSE 0
              END
              OR bg."remaining_paid_amount_usd" > bg."paid_amount_usd"
              OR bg."remaining_bonus_amount_usd" > bg."bonus_amount_usd"
            )
        ) AS "invalid_component_count",
        (
          SELECT COUNT(*)
          FROM "balance_consumption_allocations" bca
          WHERE bca."billing_account_id" = ${verifiedPlan.billingAccountId}
            AND (
              bca."ledger_sequence" IS NULL
              OR bca."ledger_sequence" = 0
            )
        ) AS "invalid_allocation_sequence_count",
        (
          SELECT COUNT(*)
          FROM "balance_consumption_allocations" bca
          WHERE bca."billing_account_id" = ${verifiedPlan.billingAccountId}
            AND (
              bca."source" = 'UNRECONCILED_GRANT'
              OR (
                bca."source" IN ('NEGATIVE_BALANCE', 'ENTERPRISE_CREDIT')
                AND (
                  bca."balance_grant_id" IS NOT NULL
                  OR bca."discount_rate" <> 0
                  OR bca."recognized_revenue_usd" < 0
                  OR bca."bonus_consumed_usd" < 0
                  OR bca."recognized_revenue_usd" + bca."bonus_consumed_usd"
                    <> bca."settled_usd"
                  OR bca."settled_usd" < 0
                  OR bca."settled_usd" > bca."amount_usd"
                  OR (bca."settled_usd" = bca."amount_usd")
                    IS DISTINCT FROM (bca."settled_at" IS NOT NULL)
                )
              )
              OR (
                bca."source" = 'BALANCE_GRANT'
                AND (
                  bca."balance_grant_id" IS NULL
                  OR bca."recognized_revenue_usd" < 0
                  OR bca."bonus_consumed_usd" < 0
                  OR bca."recognized_revenue_usd" + bca."bonus_consumed_usd" <> bca."amount_usd"
                  OR bca."discount_rate" IS DISTINCT FROM CASE
                    WHEN bca."amount_usd" > 0 THEN ROUND(
                      bca."recognized_revenue_usd" / bca."amount_usd",
                      12
                    )
                    ELSE 0
                  END
                  OR bca."settled_usd" <> 0
                  OR bca."settled_at" IS NOT NULL
                )
              )
            )
        ) AS "invalid_grant_allocation_count",
        (
          SELECT COUNT(*)
          FROM "balance_consumption_allocations" bca
          WHERE bca."billing_account_id" = ${verifiedPlan.billingAccountId}
            AND bca."source" IN ('NEGATIVE_BALANCE', 'ENTERPRISE_CREDIT')
            AND bca."source" <> ${verifiedPlan.debtSource}
        ) AS "unexpected_debt_count",
        (
          SELECT COUNT(*)
          FROM "enterprise_credit_settlements" s
          WHERE s."billing_account_id" = ${verifiedPlan.billingAccountId}
        ) AS "settlement_count",
        (
          SELECT COUNT(*)
          FROM "enterprise_credit_settlements" s
          LEFT JOIN "balance_consumption_allocations" bca ON bca."id" = s."allocation_id"
          LEFT JOIN "balance_transactions" bt ON bt."id" = s."repayment_transaction_id"
          LEFT JOIN "balance_grants" bg ON bg."id" = s."balance_grant_id"
          WHERE s."billing_account_id" = ${verifiedPlan.billingAccountId}
            AND (
              s."debt_source" <> ${verifiedPlan.debtSource}
              OR s."operation_key" IS NULL
              OR s."amount_usd" <= 0
              OR s."paid_usd" < 0
              OR s."bonus_usd" < 0
              OR s."amount_usd" <> s."paid_usd" + s."bonus_usd"
              OR bca."id" IS NULL
              OR bca."billing_account_id" IS DISTINCT FROM ${verifiedPlan.billingAccountId}
              OR bca."source" <> ${verifiedPlan.debtSource}
              OR bt."id" IS NULL
              OR bt."billing_account_id" IS DISTINCT FROM ${verifiedPlan.billingAccountId}
              OR bt."type"::text NOT IN ('RECHARGE', 'ADJUST')
              OR bt."amount_usd" <= 0
              OR (
                s."occurred_at" <> bt."created_at"
                AND NOT "balance_legacy_enterprise_settlement_timing_is_proven"(s."id")
              )
              OR (
                s."balance_grant_id" IS NOT NULL
                AND (
                  bg."id" IS NULL
                  OR bg."billing_account_id" IS DISTINCT FROM ${verifiedPlan.billingAccountId}
                )
              )
              OR (
                ${verifiedPlan.settlementWriteMode === 'CREATE'}
                AND (
                  s."repair_run_id" IS DISTINCT FROM ${runId}
                  OR s."trigger" <> 'REPAIR'
                )
              )
              OR (
                ${verifiedPlan.settlementWriteMode === 'VERIFY_EXISTING'}
                AND (
                  s."repair_run_id" IS NOT NULL
                  OR s."trigger" <> 'FUNDING'
                )
              )
            )
        ) AS "invalid_settlement_count",
        (
          SELECT COUNT(*)
          FROM (
            SELECT bt."id"
            FROM "balance_transactions" bt
            LEFT JOIN "balance_consumption_allocations" bca
              ON bca."balance_transaction_id" = bt."id"
            WHERE bt."billing_account_id" = ${verifiedPlan.billingAccountId}
              AND bt."type"::TEXT = 'CONSUME'
            GROUP BY bt."id", bt."amount_usd", bt."balance_after_usd"
            HAVING
              COALESCE(SUM(bca."amount_usd"), 0) <> -bt."amount_usd"
              OR COALESCE(SUM(bca."amount_usd") FILTER (
                WHERE bca."source" = 'BALANCE_GRANT'
              ), 0) <> LEAST(
                -bt."amount_usd",
                GREATEST(bt."balance_after_usd" - bt."amount_usd", 0)
              )
              OR COALESCE(SUM(bca."amount_usd") FILTER (
                WHERE bca."source" = ${verifiedPlan.debtSource}
              ), 0) <> -bt."amount_usd" - LEAST(
                -bt."amount_usd",
                GREATEST(bt."balance_after_usd" - bt."amount_usd", 0)
              )
          ) invalid_consume
        ) AS "invalid_consume_allocation_count",
        (
          SELECT COUNT(*)
          FROM "balance_grants" bg
          WHERE bg."billing_account_id" = ${verifiedPlan.billingAccountId}
            AND (
              bg."paid_amount_usd" IS DISTINCT FROM (
                bg."remaining_paid_amount_usd"
                + COALESCE((
                  SELECT SUM(bca."recognized_revenue_usd")
                  FROM "balance_consumption_allocations" bca
                  WHERE bca."balance_grant_id" = bg."id"
                    AND bca."source" = 'BALANCE_GRANT'
                ), 0)
                + COALESCE((
                  SELECT SUM(s."paid_usd")
                  FROM "enterprise_credit_settlements" s
                  WHERE COALESCE(
                      s."balance_grant_id",
                      "balance_legacy_settlement_effective_grant_id"(s."id")
                    ) = bg."id"
                    AND s."billing_account_id" = ${verifiedPlan.billingAccountId}
                ), 0)
                + COALESCE((
                  SELECT SUM(expiry."nominal_paid_usd")
                  FROM "balance_grant_expiries" expiry
                  WHERE expiry."balance_grant_id" = bg."id"
                    AND expiry."billing_account_id" = ${verifiedPlan.billingAccountId}
                ), 0)
              )
              OR bg."bonus_amount_usd" IS DISTINCT FROM (
                bg."remaining_bonus_amount_usd"
                + COALESCE((
                  SELECT SUM(bca."bonus_consumed_usd")
                  FROM "balance_consumption_allocations" bca
                  WHERE bca."balance_grant_id" = bg."id"
                    AND bca."source" = 'BALANCE_GRANT'
                ), 0)
                + COALESCE((
                  SELECT SUM(s."bonus_usd")
                  FROM "enterprise_credit_settlements" s
                  WHERE COALESCE(
                      s."balance_grant_id",
                      "balance_legacy_settlement_effective_grant_id"(s."id")
                    ) = bg."id"
                    AND s."billing_account_id" = ${verifiedPlan.billingAccountId}
                ), 0)
                + COALESCE((
                  SELECT SUM(expiry."nominal_bonus_usd")
                  FROM "balance_grant_expiries" expiry
                  WHERE expiry."balance_grant_id" = bg."id"
                    AND expiry."billing_account_id" = ${verifiedPlan.billingAccountId}
                ), 0)
              )
            )
        ) AS "invalid_grant_conservation_count",
        (
          SELECT COUNT(*)
          FROM "balance_ledger_allocation_repairs" ar
          WHERE ar."run_id" = ${runId}
            AND ar."repair_account_id" = ${repairAccount.id}
            AND ar."billing_account_id" = ${verifiedPlan.billingAccountId}
        ) AS "allocation_repair_count",
        (
          SELECT COUNT(*)
          FROM "balance_ledger_personal_debt_allocation_repairs" proof
          WHERE proof."run_id" = ${runId}
            AND proof."repair_account_id" = ${repairAccount.id}
            AND proof."billing_account_id" = ${verifiedPlan.billingAccountId}
        ) AS "personal_debt_repair_count",
        (
          SELECT COUNT(*)
          FROM "balance_ledger_personal_debt_allocation_repairs" proof
          LEFT JOIN "balance_consumption_allocations" source_allocation
            ON source_allocation."id" = proof."source_allocation_id"
          LEFT JOIN "balance_consumption_allocations" created_debt
            ON created_debt."id" = proof."created_debt_allocation_id"
          WHERE proof."run_id" = ${runId}
            AND proof."repair_account_id" = ${repairAccount.id}
            AND proof."billing_account_id" = ${verifiedPlan.billingAccountId}
            AND (
              proof."proof_version" <> 1
              OR proof."repair_kind" NOT IN (
                'LEGACY_DEBT_SPLIT_V1', 'LEGACY_DEBT_RECLASS_V1'
              )
              OR proof."operation_key" <> 'repair:personal-debt-allocation:'
                || ${runId} || ':' || proof."transaction_id" || ':'
                || proof."source_allocation_id"
              OR proof."source_after_snapshot" IS DISTINCT FROM to_jsonb(source_allocation)
              OR (
                proof."repair_kind" = 'LEGACY_DEBT_SPLIT_V1'
                AND (
                  proof."created_debt_allocation_id" IS NULL
                  OR proof."created_debt_snapshot" IS DISTINCT FROM to_jsonb(created_debt)
                )
              )
              OR (
                proof."repair_kind" = 'LEGACY_DEBT_RECLASS_V1'
                AND (
                  proof."created_debt_allocation_id" IS NOT NULL
                  OR proof."created_debt_snapshot" IS NOT NULL
                )
              )
            )
        ) AS "invalid_personal_debt_repair_count",
        (
          SELECT COUNT(*)
          FROM "balance_ledger_voucher_funding_repairs" proof
          WHERE proof."run_id" = ${runId}
            AND proof."repair_account_id" = ${repairAccount.id}
            AND proof."billing_account_id" = ${verifiedPlan.billingAccountId}
        ) AS "voucher_funding_proof_count",
        (
          SELECT COUNT(*)
          FROM "balance_ledger_voucher_funding_repairs" proof
          WHERE proof."run_id" = ${runId}
            AND proof."repair_account_id" = ${repairAccount.id}
            AND proof."billing_account_id" = ${verifiedPlan.billingAccountId}
            AND (
              proof."proof_version" <> 1
              OR proof."repair_kind" NOT IN (
                'LEGACY_PRE_IDEMPOTENCY_VOUCHER_V1',
                'LEGACY_PRE_IDEMPOTENCY_EXPIRED_VOUCHER_V1',
                'LEGACY_VOUCHER_FULL_REMAINDER_DEBT_ABSORPTION_V1'
              )
              OR proof."operation_key" <> 'repair:voucher-funding:' || ${runId}
                || ':' || proof."transaction_id" || ':' || proof."grant_id"
              OR jsonb_typeof(proof."transaction_snapshot") <> 'object'
              OR jsonb_typeof(proof."grant_snapshot") <> 'object'
              OR proof."transaction_snapshot"->>'id' IS DISTINCT FROM proof."transaction_id"
              OR proof."transaction_snapshot"->>'billing_account_id'
                IS DISTINCT FROM proof."billing_account_id"
              OR proof."grant_snapshot"->>'id' IS DISTINCT FROM proof."grant_id"
              OR proof."grant_snapshot"->>'billing_account_id'
                IS DISTINCT FROM proof."billing_account_id"
              OR proof."finance_approval_ref" = ''
              OR proof."technical_approval_ref" = ''
              OR char_length(proof."finance_approval_ref") > 200
              OR char_length(proof."technical_approval_ref") > 200
              OR proof."finance_approval_ref" = proof."technical_approval_ref"
            )
        ) AS "invalid_voucher_funding_proof_count",
        (
          SELECT COUNT(*)
          FROM "balance_ledger_legacy_expiry_repairs" proof
          WHERE proof."run_id" = ${runId}
            AND proof."repair_account_id" = ${repairAccount.id}
            AND proof."billing_account_id" = ${verifiedPlan.billingAccountId}
        ) AS "legacy_expiry_proof_count",
        (
          SELECT COUNT(*)
          FROM "balance_ledger_admin_funding_repairs" funding_proof
          WHERE funding_proof."run_id" = ${runId}
            AND funding_proof."repair_account_id" = ${repairAccount.id}
            AND funding_proof."billing_account_id" = ${verifiedPlan.billingAccountId}
        ) AS "admin_funding_proof_count",
        (
          SELECT COUNT(*)
          FROM "balance_ledger_admin_funding_repairs" funding_proof
          WHERE funding_proof."run_id" = ${runId}
            AND funding_proof."repair_account_id" = ${repairAccount.id}
            AND funding_proof."billing_account_id" = ${verifiedPlan.billingAccountId}
            AND funding_proof."action" = 'CREATE_GRANT'
        ) AS "admin_funding_create_count",
        (
          SELECT COUNT(*)
          FROM "balance_ledger_admin_funding_repairs" funding_proof
          WHERE funding_proof."run_id" = ${runId}
            AND funding_proof."repair_account_id" = ${repairAccount.id}
            AND funding_proof."billing_account_id" = ${verifiedPlan.billingAccountId}
            AND funding_proof."action" = 'LINK_GRANT'
        ) AS "admin_funding_link_count",
        (
          SELECT COUNT(*)
          FROM "balance_ledger_admin_funding_repairs" funding_proof
          JOIN "balance_grants" funded_grant
            ON funded_grant."id" = funding_proof."balance_grant_id"
          WHERE funding_proof."run_id" = ${runId}
            AND funding_proof."repair_account_id" = ${repairAccount.id}
            AND funding_proof."billing_account_id" = ${verifiedPlan.billingAccountId}
            AND funded_grant."billing_account_id" = funding_proof."billing_account_id"
            AND funded_grant."remaining_amount_usd"
              = funding_proof."canonical_remaining_amount_usd"
            AND funded_grant."remaining_paid_amount_usd"
              = funding_proof."canonical_remaining_paid_amount_usd"
            AND funded_grant."remaining_bonus_amount_usd"
              = funding_proof."canonical_remaining_bonus_amount_usd"
            AND (
              (
                funding_proof."action" = 'CREATE_GRANT'
                AND to_jsonb(funded_grant) = funding_proof."grant_snapshot"
              )
              OR (
                funding_proof."action" = 'LINK_GRANT'
                AND to_jsonb(funded_grant) - ARRAY[
                  'remaining_amount_usd', 'remaining_paid_amount_usd',
                  'remaining_bonus_amount_usd', 'updated_at'
                ]::TEXT[] = funding_proof."grant_snapshot" - ARRAY[
                  'remaining_amount_usd', 'remaining_paid_amount_usd',
                  'remaining_bonus_amount_usd', 'updated_at'
                ]::TEXT[]
                AND funded_grant."updated_at" >=
                  (funding_proof."grant_snapshot"->>'updated_at')::TIMESTAMP(3)
              )
            )
        ) AS "admin_funding_final_grant_count",
        (
          SELECT COUNT(*)
          FROM "balance_grant_expiries" expiry
          WHERE expiry."billing_account_id" = ${verifiedPlan.billingAccountId}
        ) AS "expiry_audit_count",
        (
          SELECT COUNT(*)
          FROM "balance_ledger_invoice_stability_repairs" proof
          WHERE proof."run_id" = ${runId}
            AND proof."repair_account_id" = ${repairAccount.id}
            AND proof."billing_account_id" = ${verifiedPlan.billingAccountId}
        ) AS "invoice_stability_proof_count",
        invoice_evidence."invoice_item_count" AS "invoice_item_count",
        invoice_evidence."unsafe_invoice_item_count" AS "unsafe_invoice_item_count",
        invoice_evidence."invalid_application_count" AS "invalid_invoice_application_count",
        invoice_evidence."evidence_sha256" AS "invoice_evidence_sha256"
      FROM "account_wallets" aw
      CROSS JOIN LATERAL "balance_ledger_invoice_stability_evidence"(
        ${verifiedPlan.billingAccountId}
      ) invoice_evidence
      WHERE aw."billing_account_id" = ${verifiedPlan.billingAccountId}`;
    if (!postcondition) throw new Error('POSTCONDITION_WALLET_MISSING');
    const walletUsd = new Prisma.Decimal(postcondition.wallet_usd);
    const expectedGrantUsd = Prisma.Decimal.max(walletUsd, new Prisma.Decimal(0));
    const expectedDebtUsd = Prisma.Decimal.max(walletUsd.neg(), new Prisma.Decimal(0));
    const expectedTransactionRepairCount = verifiedPlan.transactionSequenceMutations.length;
    const expectedAllocationRepairCount = stagedMutationCounts.allocationCount;
    const expectedPersonalDebtRepairCount = verifiedPlan.personalDebtAllocationMutations.length;
    const expectedVoucherFundingProofCount = verifiedPlan.legacyVoucherProofMutations.length;
    const expectedLegacyExpiryProofCount = verifiedPlan.legacyExpiryProofMutations.length;
    const expectedInvoiceStabilityProofCount = verifiedPlan.invoiceStabilityProof === null ? 0 : 1;
    const expectedUnsafeInvoiceItemCount = lockedUnsafeInvoiceItemCount;
    const expectedAdminFundingProofCount = verifiedPlan.legacyAdminFundingRepairs.length;
    const expectedAdminFundingCreateCount = verifiedPlan.legacyAdminFundingRepairs
      .filter((repair) => repair.action === 'CREATE_GRANT').length;
    const expectedAdminFundingLinkCount = expectedAdminFundingProofCount
      - expectedAdminFundingCreateCount;
    if (
      !new Prisma.Decimal(postcondition.active_grant_usd).eq(expectedGrantUsd)
      || !new Prisma.Decimal(postcondition.open_debt_usd).eq(expectedDebtUsd)
      || !new Prisma.Decimal(postcondition.transaction_tail_usd).eq(walletUsd)
      || postcondition.transaction_tail_id !== verifiedPlan.throughTransactionId
      || postcondition.invalid_transaction_sequence_count !== BigInt(0)
      || postcondition.invalid_component_count !== BigInt(0)
      || postcondition.invalid_allocation_sequence_count !== BigInt(0)
      || postcondition.invalid_grant_allocation_count !== BigInt(0)
      || postcondition.unexpected_debt_count !== BigInt(0)
      || postcondition.settlement_count !== BigInt(verifiedPlan.expectedSettlementCount)
      || postcondition.invalid_settlement_count !== BigInt(0)
      || postcondition.invalid_consume_allocation_count !== BigInt(0)
      || postcondition.invalid_grant_conservation_count !== BigInt(0)
      || postcondition.transaction_repair_count !== BigInt(expectedTransactionRepairCount)
      || postcondition.allocation_repair_count !== BigInt(expectedAllocationRepairCount)
      || postcondition.personal_debt_repair_count !== BigInt(expectedPersonalDebtRepairCount)
      || postcondition.invalid_personal_debt_repair_count !== BigInt(0)
      || postcondition.voucher_funding_proof_count !== BigInt(expectedVoucherFundingProofCount)
      || postcondition.invalid_voucher_funding_proof_count !== BigInt(0)
      || postcondition.legacy_expiry_proof_count !== BigInt(expectedLegacyExpiryProofCount)
      || postcondition.expiry_audit_count !== BigInt(
        lockedExpiryAuditCount + expectedLegacyExpiryProofCount,
      )
      || postcondition.invoice_stability_proof_count
        !== BigInt(expectedInvoiceStabilityProofCount)
      || postcondition.admin_funding_proof_count !== BigInt(expectedAdminFundingProofCount)
      || postcondition.admin_funding_create_count !== BigInt(expectedAdminFundingCreateCount)
      || postcondition.admin_funding_link_count !== BigInt(expectedAdminFundingLinkCount)
      || postcondition.admin_funding_final_grant_count !== BigInt(expectedAdminFundingProofCount)
      || postcondition.invoice_item_count !== BigInt(lockedInvoiceItemCount)
      || postcondition.unsafe_invoice_item_count !== BigInt(expectedUnsafeInvoiceItemCount)
      || postcondition.invalid_invoice_application_count !== BigInt(0)
      || (
        verifiedPlan.invoiceStabilityProof === null
          ? postcondition.unsafe_invoice_item_count !== BigInt(0)
          : postcondition.invoice_evidence_sha256
            !== verifiedPlan.invoiceStabilityProof.evidenceSha256
      )
    ) {
      throw new Error(
        `POSTCONDITION_FAILED wallet=${walletUsd.toFixed(12)} grants=${
          new Prisma.Decimal(postcondition.active_grant_usd).toFixed(12)
        } debt=${new Prisma.Decimal(postcondition.open_debt_usd).toFixed(12)} invalidComponents=${
          postcondition.invalid_component_count.toString()
        } txTail=${postcondition.transaction_tail_id ?? 'NULL'}:${
          new Prisma.Decimal(postcondition.transaction_tail_usd).toFixed(12)
        }/${verifiedPlan.throughTransactionId ?? 'NULL'}:${walletUsd.toFixed(12)} invalidTxSequences=${
          postcondition.invalid_transaction_sequence_count.toString()
        } invalidAllocationSequences=${postcondition.invalid_allocation_sequence_count.toString()
        } invalidGrantAllocations=${postcondition.invalid_grant_allocation_count.toString()
        } unexpectedDebt=${postcondition.unexpected_debt_count.toString()} settlements=${
          postcondition.settlement_count.toString()
        } invalidSettlements=${postcondition.invalid_settlement_count.toString()
        } invalidConsumeAllocations=${postcondition.invalid_consume_allocation_count.toString()
        } invalidGrantConservation=${postcondition.invalid_grant_conservation_count.toString()
        } transactionRepairs=${postcondition.transaction_repair_count.toString()
        }/${expectedTransactionRepairCount
        } allocationRepairs=${postcondition.allocation_repair_count.toString()
        }/${expectedAllocationRepairCount} personalDebtRepairs=${
          postcondition.personal_debt_repair_count.toString()
        }/${expectedPersonalDebtRepairCount} invalidPersonalDebtRepairs=${
          postcondition.invalid_personal_debt_repair_count.toString()
        } voucherFundingProofs=${postcondition.voucher_funding_proof_count.toString()
        }/${expectedVoucherFundingProofCount} invalidVoucherFundingProofs=${
          postcondition.invalid_voucher_funding_proof_count.toString()
        } legacyExpiryProofs=${postcondition.legacy_expiry_proof_count.toString()
        }/${expectedLegacyExpiryProofCount} expiryAudits=${postcondition.expiry_audit_count.toString()
        } invoiceStabilityProofs=${postcondition.invoice_stability_proof_count.toString()
        }/${expectedInvoiceStabilityProofCount} invoiceEvidenceSha256=${
          postcondition.invoice_evidence_sha256
        } adminFundingProofs=${
          postcondition.admin_funding_proof_count.toString()
        }/${expectedAdminFundingProofCount} adminFundingCreate=${
          postcondition.admin_funding_create_count.toString()
        }/${expectedAdminFundingCreateCount} adminFundingLink=${
          postcondition.admin_funding_link_count.toString()
        }/${expectedAdminFundingLinkCount} adminFundingFinalGrants=${
          postcondition.admin_funding_final_grant_count.toString()
        }/${expectedAdminFundingProofCount} invoiceItems=${
          postcondition.invoice_item_count.toString()
        }/${lockedInvoiceItemCount} unsafeInvoiceItems=${
          postcondition.unsafe_invoice_item_count.toString()
        }`,
      );
    }
    logRepairPhase('financial-postcondition-verified', applyStartedAt, {
      transactionRepairCount: expectedTransactionRepairCount,
      allocationRepairCount: expectedAllocationRepairCount,
    });

    const [
      personalDebtAllocationRepairs,
      voucherFundingProofs,
      legacyExpiryProofs,
      invoiceStabilityProofs,
    ] = await Promise.all([
      tx.$queryRaw<Array<{
        proofVersion: number;
        repairKind: string;
        transactionId: string;
        sourceAllocationId: string;
        createdDebtAllocationId: string | null;
        sourceBeforeSnapshot: Prisma.JsonValue;
        sourceAfterSnapshot: Prisma.JsonValue;
        createdDebtSnapshot: Prisma.JsonValue | null;
      }>>`
        SELECT
          proof."proof_version" AS "proofVersion",
          proof."repair_kind" AS "repairKind",
          proof."transaction_id" AS "transactionId",
          proof."source_allocation_id" AS "sourceAllocationId",
          proof."created_debt_allocation_id" AS "createdDebtAllocationId",
          proof."source_before_snapshot" AS "sourceBeforeSnapshot",
          proof."source_after_snapshot" AS "sourceAfterSnapshot",
          proof."created_debt_snapshot" AS "createdDebtSnapshot"
        FROM "balance_ledger_personal_debt_allocation_repairs" proof
        WHERE proof."run_id" = ${runId}
          AND proof."repair_account_id" = ${repairAccount.id}
          AND proof."billing_account_id" = ${verifiedPlan.billingAccountId}
        ORDER BY proof."transaction_id", proof."source_allocation_id"`,
      tx.$queryRaw<Array<{
        proofVersion: number;
        repairKind: string;
        transactionId: string;
        grantId: string;
        walletBeforeUsd: Prisma.Decimal;
        holeFillUsd: Prisma.Decimal;
        financeApprovalRef: string;
        technicalApprovalRef: string;
      }>>`
        SELECT
          proof."proof_version" AS "proofVersion",
          proof."repair_kind" AS "repairKind",
          proof."transaction_id" AS "transactionId",
          proof."grant_id" AS "grantId",
          proof."wallet_before_usd" AS "walletBeforeUsd",
          proof."hole_fill_usd" AS "holeFillUsd",
          proof."finance_approval_ref" AS "financeApprovalRef",
          proof."technical_approval_ref" AS "technicalApprovalRef"
        FROM "balance_ledger_voucher_funding_repairs" proof
        WHERE proof."run_id" = ${runId}
          AND proof."repair_account_id" = ${repairAccount.id}
          AND proof."billing_account_id" = ${verifiedPlan.billingAccountId}
        ORDER BY proof."transaction_id", proof."grant_id"`,
      tx.$queryRaw<Array<{
        proofVersion: number;
        repairKind: string;
        transactionId: string;
        grantId: string;
        expiryAuditId: string;
        nominalAmountUsd: Prisma.Decimal;
        nominalPaidUsd: Prisma.Decimal;
        nominalBonusUsd: Prisma.Decimal;
        walletBalanceBeforeUsd: Prisma.Decimal;
        walletBalanceAfterUsd: Prisma.Decimal;
        financeApprovalRef: string;
        technicalApprovalRef: string;
      }>>`
        SELECT
          proof."proof_version" AS "proofVersion",
          proof."repair_kind" AS "repairKind",
          proof."balance_transaction_id" AS "transactionId",
          proof."balance_grant_id" AS "grantId",
          proof."expiry_audit_id" AS "expiryAuditId",
          proof."nominal_amount_usd" AS "nominalAmountUsd",
          proof."nominal_paid_usd" AS "nominalPaidUsd",
          proof."nominal_bonus_usd" AS "nominalBonusUsd",
          proof."wallet_balance_before_usd" AS "walletBalanceBeforeUsd",
          proof."wallet_balance_after_usd" AS "walletBalanceAfterUsd",
          proof."finance_approval_ref" AS "financeApprovalRef",
          proof."technical_approval_ref" AS "technicalApprovalRef"
        FROM "balance_ledger_legacy_expiry_repairs" proof
        WHERE proof."run_id" = ${runId}
          AND proof."repair_account_id" = ${repairAccount.id}
          AND proof."billing_account_id" = ${verifiedPlan.billingAccountId}
        ORDER BY proof."balance_transaction_id", proof."balance_grant_id"`,
      tx.$queryRaw<Array<{
        proofVersion: number;
        repairKind: string;
        orderCount: bigint;
        applicationCount: bigint;
        itemCount: bigint;
        eventCount: bigint;
        evidenceSha256: string;
        financeApprovalRef: string;
        technicalApprovalRef: string;
      }>>`
        SELECT
          proof."proof_version" AS "proofVersion",
          proof."repair_kind" AS "repairKind",
          proof."order_count" AS "orderCount",
          proof."application_count" AS "applicationCount",
          proof."item_count" AS "itemCount",
          proof."event_count" AS "eventCount",
          proof."evidence_sha256" AS "evidenceSha256",
          proof."finance_approval_ref" AS "financeApprovalRef",
          proof."technical_approval_ref" AS "technicalApprovalRef"
        FROM "balance_ledger_invoice_stability_repairs" proof
        WHERE proof."run_id" = ${runId}
          AND proof."repair_account_id" = ${repairAccount.id}
          AND proof."billing_account_id" = ${verifiedPlan.billingAccountId}`,
    ]);
    const actualPersonalProofShape = personalDebtAllocationRepairs.map((proof) => ({
      proofVersion: proof.proofVersion,
      repairKind: proof.repairKind,
      transactionId: proof.transactionId,
      sourceAllocationId: proof.sourceAllocationId,
      createdDebtAllocationId: proof.createdDebtAllocationId,
    }));
    const expectedPersonalProofShape = verifiedPlan.personalDebtAllocationMutations
      .map((mutation) => ({
        proofVersion: mutation.proofVersion,
        repairKind: mutation.repairKind,
        transactionId: mutation.transactionId,
        sourceAllocationId: mutation.sourceAllocationId,
        createdDebtAllocationId: mutation.createdDebtAllocationId,
      }))
      .sort((left, right) => left.transactionId.localeCompare(right.transactionId)
        || left.sourceAllocationId.localeCompare(right.sourceAllocationId));
    const actualVoucherProofShape = voucherFundingProofs.map((proof) => ({
      proofVersion: proof.proofVersion,
      repairKind: proof.repairKind,
      transactionId: proof.transactionId,
      grantId: proof.grantId,
      walletBeforeUsd: decimal(proof.walletBeforeUsd),
      holeFillUsd: decimal(proof.holeFillUsd),
      financeApprovalRef: proof.financeApprovalRef,
      technicalApprovalRef: proof.technicalApprovalRef,
    }));
    const expectedVoucherProofShape = verifiedPlan.legacyVoucherProofMutations
      .map((mutation) => ({
        proofVersion: mutation.proofVersion,
        repairKind: mutation.repairKind,
        transactionId: mutation.transactionId,
        grantId: mutation.grantId,
        walletBeforeUsd: mutation.walletBeforeUsd,
        holeFillUsd: mutation.holeFillUsd,
        financeApprovalRef: verifiedApprovalRefs?.financeApprovalRef ?? null,
        technicalApprovalRef: verifiedApprovalRefs?.technicalApprovalRef ?? null,
      }))
      .sort((left, right) => left.transactionId.localeCompare(right.transactionId)
        || left.grantId.localeCompare(right.grantId));
    const actualLegacyExpiryProofShape = legacyExpiryProofs.map((proof) => ({
      proofVersion: proof.proofVersion,
      repairKind: proof.repairKind,
      transactionId: proof.transactionId,
      grantId: proof.grantId,
      expiryAuditId: proof.expiryAuditId,
      nominalAmountUsd: decimal(proof.nominalAmountUsd),
      nominalPaidUsd: decimal(proof.nominalPaidUsd),
      nominalBonusUsd: decimal(proof.nominalBonusUsd),
      walletBalanceBeforeUsd: decimal(proof.walletBalanceBeforeUsd),
      walletBalanceAfterUsd: decimal(proof.walletBalanceAfterUsd),
      financeApprovalRef: proof.financeApprovalRef,
      technicalApprovalRef: proof.technicalApprovalRef,
    }));
    const expectedLegacyExpiryProofShape = verifiedPlan.legacyExpiryProofMutations
      .map((mutation) => ({
        proofVersion: mutation.proofVersion,
        repairKind: mutation.repairKind,
        transactionId: mutation.transactionId,
        grantId: mutation.grantId,
        expiryAuditId: mutation.expiryAuditId,
        nominalAmountUsd: mutation.nominalAmountUsd,
        nominalPaidUsd: mutation.nominalPaidUsd,
        nominalBonusUsd: mutation.nominalBonusUsd,
        walletBalanceBeforeUsd: mutation.walletBalanceBeforeUsd,
        walletBalanceAfterUsd: mutation.walletBalanceAfterUsd,
        financeApprovalRef: verifiedApprovalRefs?.financeApprovalRef ?? null,
        technicalApprovalRef: verifiedApprovalRefs?.technicalApprovalRef ?? null,
      }))
      .sort((left, right) => left.transactionId.localeCompare(right.transactionId)
        || left.grantId.localeCompare(right.grantId));
    const actualInvoiceStabilityProofShape = invoiceStabilityProofs.map((proof) => ({
      proofVersion: proof.proofVersion,
      repairKind: proof.repairKind,
      orderCount: proof.orderCount.toString(),
      applicationCount: proof.applicationCount.toString(),
      itemCount: proof.itemCount.toString(),
      eventCount: proof.eventCount.toString(),
      evidenceSha256: proof.evidenceSha256,
      financeApprovalRef: proof.financeApprovalRef,
      technicalApprovalRef: proof.technicalApprovalRef,
    }));
    const expectedInvoiceStabilityProofShape = verifiedPlan.invoiceStabilityProof === null
      ? []
      : [{
          proofVersion: verifiedPlan.invoiceStabilityProof.proofVersion,
          repairKind: verifiedPlan.invoiceStabilityProof.repairKind,
          orderCount: verifiedPlan.invoiceStabilityProof.orderCount.toString(),
          applicationCount: verifiedPlan.invoiceStabilityProof.applicationCount.toString(),
          itemCount: verifiedPlan.invoiceStabilityProof.itemCount.toString(),
          eventCount: verifiedPlan.invoiceStabilityProof.eventCount.toString(),
          evidenceSha256: verifiedPlan.invoiceStabilityProof.evidenceSha256,
          financeApprovalRef: verifiedApprovalRefs?.financeApprovalRef ?? null,
          technicalApprovalRef: verifiedApprovalRefs?.technicalApprovalRef ?? null,
        }];
    if (
      JSON.stringify(actualPersonalProofShape) !== JSON.stringify(expectedPersonalProofShape)
      || JSON.stringify(actualVoucherProofShape) !== JSON.stringify(expectedVoucherProofShape)
      || JSON.stringify(actualLegacyExpiryProofShape)
        !== JSON.stringify(expectedLegacyExpiryProofShape)
      || JSON.stringify(actualInvoiceStabilityProofShape)
        !== JSON.stringify(expectedInvoiceStabilityProofShape)
    ) {
      throw new Error('POSTCONDITION_FINANCIAL_PROOF_SET_MISMATCH');
    }

    // The account's first online financial-clock floor must come from the same
    // PostgreSQL instant that was captured after every wallet/ledger lock and
    // used to validate this repair. Application wall time is not authoritative.
    const reconciledAt = financialNow;
    const afterSnapshot = {
      accountType: verifiedPlan.accountType,
      debtSource: verifiedPlan.debtSource,
      settlementWriteMode: verifiedPlan.settlementWriteMode,
      preconditionHash: verifiedPlan.preconditionHash,
      replayHash: verifiedPlan.replayHash,
      walletBalanceUsd: walletUsd.toFixed(12),
      openDebtUsd: new Prisma.Decimal(postcondition.open_debt_usd).toFixed(12),
      activeGrantUsd: new Prisma.Decimal(postcondition.active_grant_usd).toFixed(12),
      transactionTailId: postcondition.transaction_tail_id,
      transactionTailUsd: new Prisma.Decimal(postcondition.transaction_tail_usd).toFixed(12),
      invalidTransactionSequenceCount: postcondition.invalid_transaction_sequence_count.toString(),
      invalidComponentCount: postcondition.invalid_component_count.toString(),
      invalidAllocationSequenceCount: postcondition.invalid_allocation_sequence_count.toString(),
      invalidGrantAllocationCount: postcondition.invalid_grant_allocation_count.toString(),
      unexpectedDebtCount: postcondition.unexpected_debt_count.toString(),
      settlementCount: postcondition.settlement_count.toString(),
      invalidSettlementCount: postcondition.invalid_settlement_count.toString(),
      invalidConsumeAllocationCount: postcondition.invalid_consume_allocation_count.toString(),
      invalidGrantConservationCount: postcondition.invalid_grant_conservation_count.toString(),
      transactionRepairCount: postcondition.transaction_repair_count.toString(),
      allocationRepairCount: postcondition.allocation_repair_count.toString(),
      personalDebtAllocationRepairCount: postcondition.personal_debt_repair_count.toString(),
      voucherFundingProofCount: postcondition.voucher_funding_proof_count.toString(),
      legacyExpiryProofCount: postcondition.legacy_expiry_proof_count.toString(),
      expiryAuditCount: postcondition.expiry_audit_count.toString(),
      invoiceStabilityProofCount: postcondition.invoice_stability_proof_count.toString(),
      invoiceEvidenceSha256: verifiedPlan.invoiceStabilityProof?.evidenceSha256 ?? null,
      ...(verifiedPlan.legacyAdminFundingRepairs.length > 0
        ? {
            adminFundingProofCount: postcondition.admin_funding_proof_count.toString(),
            adminFundingCreateCount: postcondition.admin_funding_create_count.toString(),
            adminFundingLinkCount: postcondition.admin_funding_link_count.toString(),
            adminFundingFinalGrantCount: postcondition.admin_funding_final_grant_count.toString(),
            legacyAdminFundingRepairs: verifiedPlan.legacyAdminFundingRepairs,
          }
        : {}),
      invoiceItemCount: postcondition.invoice_item_count.toString(),
      unsafeInvoiceItemCount: postcondition.unsafe_invoice_item_count.toString(),
      transactionSequenceMutations: verifiedPlan.transactionSequenceMutations,
      // beforeSnapshot contains the full locked grant rows. Persist the exact
      // expected/target component mutation list as terminal evidence so a
      // later legitimate consume/expiry cannot erase what this repair changed.
      grantMutations: verifiedPlan.grantMutations,
      allocationMutations: verifiedPlan.allocationMutations,
      migrationOpeningDebtMutations: verifiedPlan.migrationOpeningDebtMutations,
      // The proof contract closes every enterprise FIFO rewrite against the
      // exact canonical source/target row carried by the lock-rebuilt plan.
      canonicalAllocationMutations: verifiedPlan.canonicalAllocationMutations,
      invoiceEvidence: {
        itemCount: lockedInvoiceItemCount,
        sha256: postcondition.invoice_evidence_sha256,
      },
      ledgerStatus: 'RECONCILED_V2',
      ledgerVersion: 2,
      reconciledAt: reconciledAt.toISOString(),
      throughTransactionId: verifiedPlan.throughTransactionId,
    };
    const afterSnapshotJson = repairAuditJsonTextWithLimit(
      afterSnapshot,
      'REPAIR_AFTER_SNAPSHOT',
      MAX_REPAIR_AFTER_JSON_BYTES,
    );
    const accountUpdated = await tx.billingAccount.updateMany({
      where: {
        id: verifiedPlan.billingAccountId,
        balanceGrantLedgerStatus: 'LEGACY_DIRTY',
      },
      data: {
        balanceGrantLedgerStatus: 'RECONCILED_V2',
        balanceGrantLedgerVersion: 2,
        balanceGrantLedgerHash: verifiedPlan.replayHash,
        balanceGrantLedgerReconciledAt: reconciledAt,
        balanceGrantLedgerDirtyReason: null,
        balanceGrantLedgerThroughTransactionId: verifiedPlan.throughTransactionId,
      },
    });
    if (accountUpdated.count !== 1) throw new Error('STALE_ACCOUNT_MARKER');

    // Do not round-trip proof JSONB through JavaScript. node-postgres parses
    // JSON numbers as IEEE-754, which can silently change NUMERIC(20,12)
    // evidence before the deferred trigger performs exact JSONB equality.
    // Build both proof arrays from their immutable database rows and merge
    // them into the otherwise string-normalized terminal snapshot in SQL.
    const repairAuditUpdated = await tx.$queryRaw<Array<{ id: string }>>`
      WITH personal_proofs AS (
        SELECT COALESCE(jsonb_agg(
          jsonb_build_object(
            'proofVersion', proof."proof_version",
            'repairKind', proof."repair_kind",
            'transactionId', proof."transaction_id",
            'sourceAllocationId', proof."source_allocation_id",
            'createdDebtAllocationId', proof."created_debt_allocation_id",
            'sourceBeforeSnapshot', proof."source_before_snapshot",
            'sourceAfterSnapshot', proof."source_after_snapshot",
            'createdDebtSnapshot', proof."created_debt_snapshot"
          ) ORDER BY proof."transaction_id", proof."source_allocation_id"
        ), '[]'::JSONB) AS value
        FROM "balance_ledger_personal_debt_allocation_repairs" proof
        WHERE proof."run_id" = ${runId}
          AND proof."repair_account_id" = ${repairAccount.id}
          AND proof."billing_account_id" = ${verifiedPlan.billingAccountId}
      ), voucher_proofs AS (
        SELECT COALESCE(jsonb_agg(
          jsonb_build_object(
            'proofVersion', proof."proof_version",
            'repairKind', proof."repair_kind",
            'transactionId', proof."transaction_id",
            'grantId', proof."grant_id",
            'walletBeforeUsd', proof."wallet_before_usd"::TEXT,
            'holeFillUsd', proof."hole_fill_usd"::TEXT,
            'financeApprovalRef', proof."finance_approval_ref",
            'technicalApprovalRef', proof."technical_approval_ref"
          ) ORDER BY proof."transaction_id", proof."grant_id"
        ), '[]'::JSONB) AS value
        FROM "balance_ledger_voucher_funding_repairs" proof
        WHERE proof."run_id" = ${runId}
          AND proof."repair_account_id" = ${repairAccount.id}
          AND proof."billing_account_id" = ${verifiedPlan.billingAccountId}
      ), legacy_expiry_proofs AS (
        SELECT COALESCE(jsonb_agg(
          jsonb_build_object(
            'proofVersion', proof."proof_version",
            'repairKind', proof."repair_kind",
            'transactionId', proof."balance_transaction_id",
            'grantId', proof."balance_grant_id",
            'expiryAuditId', proof."expiry_audit_id",
            'nominalAmountUsd', proof."nominal_amount_usd"::TEXT,
            'nominalPaidUsd', proof."nominal_paid_usd"::TEXT,
            'nominalBonusUsd', proof."nominal_bonus_usd"::TEXT,
            'walletBalanceBeforeUsd', proof."wallet_balance_before_usd"::TEXT,
            'walletBalanceAfterUsd', proof."wallet_balance_after_usd"::TEXT,
            'transactionSnapshot', proof."transaction_snapshot",
            'grantSnapshot', proof."grant_snapshot",
            'expiryAuditSnapshot', proof."expiry_audit_snapshot",
            'financeApprovalRef', proof."finance_approval_ref",
            'technicalApprovalRef', proof."technical_approval_ref"
          ) ORDER BY proof."balance_transaction_id", proof."balance_grant_id"
        ), '[]'::JSONB) AS value
        FROM "balance_ledger_legacy_expiry_repairs" proof
        WHERE proof."run_id" = ${runId}
          AND proof."repair_account_id" = ${repairAccount.id}
          AND proof."billing_account_id" = ${verifiedPlan.billingAccountId}
      ), invoice_stability_proof AS (
        SELECT COALESCE((
          SELECT jsonb_build_object(
            'proofVersion', proof."proof_version",
            'repairKind', proof."repair_kind",
            'orderCount', proof."order_count"::TEXT,
            'applicationCount', proof."application_count"::TEXT,
            'itemCount', proof."item_count"::TEXT,
            'eventCount', proof."event_count"::TEXT,
            'evidenceSha256', proof."evidence_sha256",
            'evidenceSnapshot', proof."evidence_snapshot",
            'financeApprovalRef', proof."finance_approval_ref",
            'technicalApprovalRef', proof."technical_approval_ref"
          )
          FROM "balance_ledger_invoice_stability_repairs" proof
          WHERE proof."run_id" = ${runId}
            AND proof."repair_account_id" = ${repairAccount.id}
            AND proof."billing_account_id" = ${verifiedPlan.billingAccountId}
        ), 'null'::JSONB) AS value
      )
      UPDATE "balance_ledger_repair_accounts" repair_audit
      SET
        "status" = 'APPLIED',
        "after_snapshot" = ${afterSnapshotJson}::JSONB || jsonb_build_object(
          'personalDebtAllocationRepairs', personal_proofs.value,
          'voucherFundingProofs', voucher_proofs.value,
          'legacyExpiryProofs', legacy_expiry_proofs.value,
          'invoiceStabilityProof', invoice_stability_proof.value
        ),
        "error" = NULL
      FROM personal_proofs, voucher_proofs, legacy_expiry_proofs, invoice_stability_proof
      WHERE repair_audit."id" = ${repairAccount.id}
        AND repair_audit."run_id" = ${runId}
        AND repair_audit."billing_account_id" = ${verifiedPlan.billingAccountId}
        AND repair_audit."status" = 'RUNNING'
        AND repair_audit."precondition_hash" = ${verifiedPlan.preconditionHash}
        AND repair_audit."replay_hash" = ${verifiedPlan.replayHash}
      RETURNING repair_audit."id"`;
    if (repairAuditUpdated.length !== 1) throw new Error('STALE_REPAIR_ACCOUNT_AUDIT');
    logRepairPhase('terminal-evidence-staged', applyStartedAt, {
      status: 'APPLIED',
      repairAccountId: repairAccount.id,
      afterSnapshotBytes: Buffer.byteLength(afterSnapshotJson, 'utf8'),
    });
    return 'APPLIED';
  }, GENERIC_REPAIR_TRANSACTION_OPTIONS);
  logRepairPhase('transaction-committed', applyStartedAt, { status: result });
  return result;
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

async function applyReadyPlanWithRetry(
  runId: string,
  plan: Extract<BalanceLedgerRepairPlan, { status: 'READY' }>,
  databaseBinding: RepairDatabaseBinding,
  voucherApprovalRefs: VoucherApprovalRefs | null,
  profile: BalanceLedgerRepairExecutionProfile,
): Promise<'APPLIED' | 'SKIPPED_STALE'> {
  const MAX_SERIALIZATION_ATTEMPTS = 3;
  for (let attempt = 1; attempt <= MAX_SERIALIZATION_ATTEMPTS; attempt += 1) {
    try {
      return await applyReadyPlan(
        runId,
        plan,
        databaseBinding,
        prisma,
        voucherApprovalRefs,
        profile,
      );
    } catch (error) {
      if (isDatabaseBindingFailure(error)) throw error;
      if (!isSerializationFailure(error) || attempt === MAX_SERIALIZATION_ATTEMPTS) throw error;
    }
  }
  throw new Error('unreachable serialization retry state');
}

export async function hasCommittedAppliedProof(
  runId: string,
  plan: Extract<BalanceLedgerRepairPlan, { status: 'READY' }>,
  databaseBinding: RepairDatabaseBinding,
  voucherApprovalRefs: VoucherApprovalRefs | null,
): Promise<boolean> {
  const expectedPersonalProofsJson = JSON.stringify(
    plan.personalDebtAllocationMutations.map((mutation) => ({
      proofVersion: mutation.proofVersion,
      repairKind: mutation.repairKind,
      transactionId: mutation.transactionId,
      sourceAllocationId: mutation.sourceAllocationId,
      createdDebtAllocationId: mutation.createdDebtAllocationId,
    })),
  );
  const expectedVoucherProofsJson = JSON.stringify(
    plan.legacyVoucherProofMutations.map((mutation) => ({
      proofVersion: mutation.proofVersion,
      repairKind: mutation.repairKind,
      transactionId: mutation.transactionId,
      grantId: mutation.grantId,
      walletBeforeUsd: mutation.walletBeforeUsd,
      holeFillUsd: mutation.holeFillUsd,
      financeApprovalRef: voucherApprovalRefs?.financeApprovalRef ?? null,
      technicalApprovalRef: voucherApprovalRefs?.technicalApprovalRef ?? null,
    })),
  );
  const expectedLegacyExpiryProofsJson = JSON.stringify(
    plan.legacyExpiryProofMutations.map((mutation) => ({
      proofVersion: mutation.proofVersion,
      repairKind: mutation.repairKind,
      transactionId: mutation.transactionId,
      grantId: mutation.grantId,
      expiryAuditId: mutation.expiryAuditId,
      nominalAmountUsd: mutation.nominalAmountUsd,
      nominalPaidUsd: mutation.nominalPaidUsd,
      nominalBonusUsd: mutation.nominalBonusUsd,
      walletBalanceBeforeUsd: mutation.walletBalanceBeforeUsd,
      walletBalanceAfterUsd: mutation.walletBalanceAfterUsd,
      financeApprovalRef: voucherApprovalRefs?.financeApprovalRef ?? null,
      technicalApprovalRef: voucherApprovalRefs?.technicalApprovalRef ?? null,
    })),
  );
  const expectedInvoiceStabilityProofJson = JSON.stringify(
    plan.invoiceStabilityProof === null
      ? []
      : [{
          ...plan.invoiceStabilityProof,
          financeApprovalRef: voucherApprovalRefs?.financeApprovalRef ?? null,
          technicalApprovalRef: voucherApprovalRefs?.technicalApprovalRef ?? null,
        }],
  );
  return prisma.$transaction(async (tx) => {
    await loadRepairDatabaseBinding(tx, databaseBinding);
    const [
      audit,
      account,
      proofEvidenceRows,
      maintenanceProofRows,
      fundingProofCounts,
    ] = await Promise.all([
      tx.balanceLedgerRepairAccount.findUnique({
        where: {
          runId_billingAccountId: {
            runId,
            billingAccountId: plan.billingAccountId,
          },
        },
        select: { status: true, preconditionHash: true, replayHash: true },
      }),
      tx.billingAccount.findUnique({
        where: { id: plan.billingAccountId },
        select: {
          balanceGrantLedgerStatus: true,
          balanceGrantLedgerVersion: true,
          balanceGrantLedgerHash: true,
          balanceGrantLedgerThroughTransactionId: true,
        },
      }),
      tx.$queryRaw<Array<{ exact: boolean }>>`
        WITH repair_audit AS (
          SELECT repair."id", repair."after_snapshot"
          FROM "balance_ledger_repair_accounts" repair
          WHERE repair."run_id" = ${runId}
            AND repair."billing_account_id" = ${plan.billingAccountId}
        ), expected_personal AS (
          SELECT ${expectedPersonalProofsJson}::JSONB AS value
        ), expected_voucher AS (
          SELECT ${expectedVoucherProofsJson}::JSONB AS value
        ), personal_proofs AS (
          SELECT
            COUNT(proof."id") AS proof_count,
            COUNT(proof."id") FILTER (WHERE EXISTS (
              SELECT 1
              FROM jsonb_array_elements(${expectedPersonalProofsJson}::JSONB) expected(value)
              WHERE (expected.value->>'proofVersion')::INTEGER = proof."proof_version"
                AND expected.value->>'repairKind' = proof."repair_kind"
                AND expected.value->>'transactionId' = proof."transaction_id"
                AND expected.value->>'sourceAllocationId' = proof."source_allocation_id"
                AND expected.value->>'createdDebtAllocationId'
                  IS NOT DISTINCT FROM proof."created_debt_allocation_id"
            )) AS match_count,
            COALESCE(jsonb_agg(
              jsonb_build_object(
                'proofVersion', proof."proof_version",
                'repairKind', proof."repair_kind",
                'transactionId', proof."transaction_id",
                'sourceAllocationId', proof."source_allocation_id",
                'createdDebtAllocationId', proof."created_debt_allocation_id",
                'sourceBeforeSnapshot', proof."source_before_snapshot",
                'sourceAfterSnapshot', proof."source_after_snapshot",
                'createdDebtSnapshot', proof."created_debt_snapshot"
              ) ORDER BY proof."transaction_id", proof."source_allocation_id"
            ) FILTER (WHERE proof."id" IS NOT NULL), '[]'::JSONB) AS value
          FROM repair_audit
          LEFT JOIN "balance_ledger_personal_debt_allocation_repairs" proof
            ON proof."run_id" = ${runId}
            AND proof."repair_account_id" = repair_audit."id"
            AND proof."billing_account_id" = ${plan.billingAccountId}
        ), voucher_proofs AS (
          SELECT
            COUNT(proof."id") AS proof_count,
            COUNT(proof."id") FILTER (WHERE EXISTS (
              SELECT 1
              FROM jsonb_array_elements(${expectedVoucherProofsJson}::JSONB) expected(value)
              WHERE (expected.value->>'proofVersion')::INTEGER = proof."proof_version"
                AND expected.value->>'repairKind' = proof."repair_kind"
                AND expected.value->>'transactionId' = proof."transaction_id"
                AND expected.value->>'grantId' = proof."grant_id"
                AND (expected.value->>'walletBeforeUsd')::NUMERIC
                  IS NOT DISTINCT FROM proof."wallet_before_usd"
                AND (expected.value->>'holeFillUsd')::NUMERIC
                  IS NOT DISTINCT FROM proof."hole_fill_usd"
                AND expected.value->>'financeApprovalRef'
                  IS NOT DISTINCT FROM proof."finance_approval_ref"
                AND expected.value->>'technicalApprovalRef'
                  IS NOT DISTINCT FROM proof."technical_approval_ref"
            )) AS match_count,
            COALESCE(jsonb_agg(
              jsonb_build_object(
                'proofVersion', proof."proof_version",
                'repairKind', proof."repair_kind",
                'transactionId', proof."transaction_id",
                'grantId', proof."grant_id",
                'walletBeforeUsd', proof."wallet_before_usd"::TEXT,
                'holeFillUsd', proof."hole_fill_usd"::TEXT,
                'financeApprovalRef', proof."finance_approval_ref",
                'technicalApprovalRef', proof."technical_approval_ref"
              ) ORDER BY proof."transaction_id", proof."grant_id"
            ) FILTER (WHERE proof."id" IS NOT NULL), '[]'::JSONB) AS value
          FROM repair_audit
          LEFT JOIN "balance_ledger_voucher_funding_repairs" proof
            ON proof."run_id" = ${runId}
            AND proof."repair_account_id" = repair_audit."id"
            AND proof."billing_account_id" = ${plan.billingAccountId}
        )
        SELECT
          repair_audit."after_snapshot" IS NOT NULL
          AND repair_audit."after_snapshot"->'personalDebtAllocationRepairs'
            IS NOT DISTINCT FROM personal_proofs.value
          AND repair_audit."after_snapshot"->'voucherFundingProofs'
            IS NOT DISTINCT FROM voucher_proofs.value
          AND personal_proofs.proof_count
            = jsonb_array_length(expected_personal.value)
          AND personal_proofs.match_count = personal_proofs.proof_count
          AND voucher_proofs.proof_count
            = jsonb_array_length(expected_voucher.value)
          AND voucher_proofs.match_count = voucher_proofs.proof_count
          AS exact
        FROM repair_audit, expected_personal, expected_voucher,
          personal_proofs, voucher_proofs`,
      tx.$queryRaw<Array<{ exact: boolean }>>`
        WITH repair_audit AS (
          SELECT repair."id", repair."after_snapshot"
          FROM "balance_ledger_repair_accounts" repair
          WHERE repair."run_id" = ${runId}
            AND repair."billing_account_id" = ${plan.billingAccountId}
        ), expected_expiry AS (
          SELECT ${expectedLegacyExpiryProofsJson}::JSONB AS value
        ), expected_invoice AS (
          SELECT ${expectedInvoiceStabilityProofJson}::JSONB AS value
        ), expiry_proofs AS (
          SELECT
            COUNT(proof."id") AS proof_count,
            COUNT(proof."id") FILTER (WHERE EXISTS (
              SELECT 1
              FROM jsonb_array_elements(${expectedLegacyExpiryProofsJson}::JSONB) expected(value)
              WHERE (expected.value->>'proofVersion')::INTEGER = proof."proof_version"
                AND expected.value->>'repairKind' = proof."repair_kind"
                AND expected.value->>'transactionId' = proof."balance_transaction_id"
                AND expected.value->>'grantId' = proof."balance_grant_id"
                AND expected.value->>'expiryAuditId' = proof."expiry_audit_id"
                AND (expected.value->>'nominalAmountUsd')::NUMERIC = proof."nominal_amount_usd"
                AND (expected.value->>'nominalPaidUsd')::NUMERIC = proof."nominal_paid_usd"
                AND (expected.value->>'nominalBonusUsd')::NUMERIC = proof."nominal_bonus_usd"
                AND (expected.value->>'walletBalanceBeforeUsd')::NUMERIC
                  = proof."wallet_balance_before_usd"
                AND (expected.value->>'walletBalanceAfterUsd')::NUMERIC
                  = proof."wallet_balance_after_usd"
                AND expected.value->>'financeApprovalRef' = proof."finance_approval_ref"
                AND expected.value->>'technicalApprovalRef' = proof."technical_approval_ref"
            )) AS match_count,
            COALESCE(jsonb_agg(jsonb_build_object(
              'proofVersion', proof."proof_version",
              'repairKind', proof."repair_kind",
              'transactionId', proof."balance_transaction_id",
              'grantId', proof."balance_grant_id",
              'expiryAuditId', proof."expiry_audit_id",
              'nominalAmountUsd', proof."nominal_amount_usd"::TEXT,
              'nominalPaidUsd', proof."nominal_paid_usd"::TEXT,
              'nominalBonusUsd', proof."nominal_bonus_usd"::TEXT,
              'walletBalanceBeforeUsd', proof."wallet_balance_before_usd"::TEXT,
              'walletBalanceAfterUsd', proof."wallet_balance_after_usd"::TEXT,
              'transactionSnapshot', proof."transaction_snapshot",
              'grantSnapshot', proof."grant_snapshot",
              'expiryAuditSnapshot', proof."expiry_audit_snapshot",
              'financeApprovalRef', proof."finance_approval_ref",
              'technicalApprovalRef', proof."technical_approval_ref"
            ) ORDER BY proof."balance_transaction_id", proof."balance_grant_id")
              FILTER (WHERE proof."id" IS NOT NULL), '[]'::JSONB) AS value
          FROM repair_audit
          LEFT JOIN "balance_ledger_legacy_expiry_repairs" proof
            ON proof."run_id" = ${runId}
            AND proof."repair_account_id" = repair_audit."id"
            AND proof."billing_account_id" = ${plan.billingAccountId}
        ), invoice_proofs AS (
          SELECT
            COUNT(proof."id") AS proof_count,
            COUNT(proof."id") FILTER (WHERE EXISTS (
              SELECT 1
              FROM jsonb_array_elements(${expectedInvoiceStabilityProofJson}::JSONB) expected(value)
              WHERE (expected.value->>'proofVersion')::INTEGER = proof."proof_version"
                AND expected.value->>'repairKind' = proof."repair_kind"
                AND (expected.value->>'orderCount')::BIGINT = proof."order_count"
                AND (expected.value->>'applicationCount')::BIGINT = proof."application_count"
                AND (expected.value->>'itemCount')::BIGINT = proof."item_count"
                AND (expected.value->>'eventCount')::BIGINT = proof."event_count"
                AND expected.value->>'evidenceSha256' = proof."evidence_sha256"
                AND expected.value->>'financeApprovalRef' = proof."finance_approval_ref"
                AND expected.value->>'technicalApprovalRef' = proof."technical_approval_ref"
            )) AS match_count,
            COALESCE((jsonb_agg(jsonb_build_object(
              'proofVersion', proof."proof_version",
              'repairKind', proof."repair_kind",
              'orderCount', proof."order_count"::TEXT,
              'applicationCount', proof."application_count"::TEXT,
              'itemCount', proof."item_count"::TEXT,
              'eventCount', proof."event_count"::TEXT,
              'evidenceSha256', proof."evidence_sha256",
              'evidenceSnapshot', proof."evidence_snapshot",
              'financeApprovalRef', proof."finance_approval_ref",
              'technicalApprovalRef', proof."technical_approval_ref"
            )) FILTER (WHERE proof."id" IS NOT NULL))->0, 'null'::JSONB) AS value
          FROM repair_audit
          LEFT JOIN "balance_ledger_invoice_stability_repairs" proof
            ON proof."run_id" = ${runId}
            AND proof."repair_account_id" = repair_audit."id"
            AND proof."billing_account_id" = ${plan.billingAccountId}
        ), current_invoice AS (
          SELECT evidence.*
          FROM "balance_ledger_invoice_stability_evidence"(${plan.billingAccountId}) evidence
        )
        SELECT
          repair_audit."after_snapshot" IS NOT NULL
          AND repair_audit."after_snapshot"->'legacyExpiryProofs'
            IS NOT DISTINCT FROM expiry_proofs.value
          AND repair_audit."after_snapshot"->'invoiceStabilityProof'
            IS NOT DISTINCT FROM invoice_proofs.value
          AND repair_audit."after_snapshot"->>'legacyExpiryProofCount'
            = expiry_proofs.proof_count::TEXT
          AND repair_audit."after_snapshot"->>'invoiceStabilityProofCount'
            = invoice_proofs.proof_count::TEXT
          AND repair_audit."after_snapshot"->>'invoiceEvidenceSha256'
            IS NOT DISTINCT FROM CASE
              WHEN invoice_proofs.proof_count = 0 THEN NULL
              ELSE current_invoice."evidence_sha256"
            END
          AND expiry_proofs.proof_count = jsonb_array_length(expected_expiry.value)
          AND expiry_proofs.match_count = expiry_proofs.proof_count
          AND invoice_proofs.proof_count = jsonb_array_length(expected_invoice.value)
          AND invoice_proofs.match_count = invoice_proofs.proof_count
          AND (
            invoice_proofs.proof_count = 0
            OR invoice_proofs.value->>'evidenceSha256' = current_invoice."evidence_sha256"
          ) AS exact
        FROM repair_audit, expected_expiry, expected_invoice,
          expiry_proofs, invoice_proofs, current_invoice`,
      tx.$queryRaw<Array<{
        proofCount: bigint;
        createCount: bigint;
        linkCount: bigint;
      }>>`
        SELECT COUNT(*) AS "proofCount",
          COUNT(*) FILTER (WHERE proof."action" = 'CREATE_GRANT') AS "createCount",
          COUNT(*) FILTER (WHERE proof."action" = 'LINK_GRANT') AS "linkCount"
        FROM "balance_ledger_admin_funding_repairs" proof
        WHERE proof."run_id" = ${runId}
          AND proof."billing_account_id" = ${plan.billingAccountId}`,
    ]);
    const expectedCreateCount = plan.legacyAdminFundingRepairs
      .filter((repair) => repair.action === 'CREATE_GRANT').length;
    const expectedLinkCount = plan.legacyAdminFundingRepairs.length - expectedCreateCount;
    const fundingCounts = fundingProofCounts[0];
    return audit?.status === 'APPLIED'
      && audit.preconditionHash === plan.preconditionHash
      && audit.replayHash === plan.replayHash
      && proofEvidenceRows.length === 1
      && proofEvidenceRows[0].exact
      && maintenanceProofRows.length === 1
      && maintenanceProofRows[0].exact
      && account?.balanceGrantLedgerStatus === 'RECONCILED_V2'
      && account.balanceGrantLedgerVersion === 2
      && account.balanceGrantLedgerHash === plan.replayHash
      && account.balanceGrantLedgerThroughTransactionId === plan.throughTransactionId
      && fundingCounts?.proofCount === BigInt(plan.legacyAdminFundingRepairs.length)
      && fundingCounts.createCount === BigInt(expectedCreateCount)
      && fundingCounts.linkCount === BigInt(expectedLinkCount);
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 10_000,
    timeout: 30_000,
  });
}

async function hasCommittedAppliedProofWithRetry(
  runId: string,
  plan: Extract<BalanceLedgerRepairPlan, { status: 'READY' }>,
  databaseBinding: RepairDatabaseBinding,
  voucherApprovalRefs: VoucherApprovalRefs | null,
): Promise<boolean> {
  const PROOF_READ_DELAYS_MS = [0, 100, 300, 750] as const;
  let lastReadError: unknown;
  let completedRead = false;

  for (const delayMs of PROOF_READ_DELAYS_MS) {
    if (delayMs > 0) await wait(delayMs);
    try {
      completedRead = true;
      lastReadError = undefined;
      if (await hasCommittedAppliedProof(
        runId,
        plan,
        databaseBinding,
        voucherApprovalRefs,
      )) return true;
    } catch (error) {
      if (isDatabaseBindingFailure(error)) throw error;
      lastReadError = error;
    }
  }

  if (lastReadError !== undefined || !completedRead) {
    const detail = lastReadError instanceof Error ? lastReadError.message : String(lastReadError);
    throw new Error(
      `UNKNOWN_COMMIT_PROOF_UNAVAILABLE:${plan.billingAccountId}:${detail}`,
    );
  }
  return false;
}

async function resolveExistingRepairAccount(
  runId: string,
  plan: Extract<BalanceLedgerRepairPlan, { status: 'READY' }>,
  databaseBinding: RepairDatabaseBinding,
  voucherApprovalRefs: VoucherApprovalRefs | null,
): Promise<'APPLIED' | 'SKIPPED_STALE' | 'FAILED' | 'ABSENT'> {
  const existing = await prisma.$transaction(async (tx) => {
    await loadRepairDatabaseBinding(tx, databaseBinding);
    return tx.balanceLedgerRepairAccount.findUnique({
      where: { runId_billingAccountId: { runId, billingAccountId: plan.billingAccountId } },
      select: { status: true },
    });
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 10_000,
    timeout: 30_000,
  });
  if (!existing) return 'ABSENT';
  if (existing.status === 'APPLIED') {
    if (await hasCommittedAppliedProofWithRetry(
      runId,
      plan,
      databaseBinding,
      voucherApprovalRefs,
    )) return 'APPLIED';
    throw new Error(`APPLIED_PROOF_MISMATCH:${plan.billingAccountId}`);
  }
  if (existing.status === 'SKIPPED_STALE' || existing.status === 'FAILED') {
    return existing.status;
  }
  throw new Error(`NON_TERMINAL_REPAIR_ACCOUNT:${plan.billingAccountId}:${existing.status}`);
}

async function applyPlan(): Promise<void> {
  const profile = executionProfile();
  const initiatedBy = resolveRepairInitiator(profile, option('--initiated-by'));
  const confirmedDatabaseName = option('--confirm-database-name');
  const confirmedDatabaseIdentity = option('--confirm-database-identity');
  if (!confirmedDatabaseName || !confirmedDatabaseIdentity) {
    throw new Error(
      '--apply requires --confirm-database-name and --confirm-database-identity',
    );
  }
  const planFile = option('--plan-file');
  const expectedSha = option('--plan-sha256');
  if (!planFile || !expectedSha) {
    throw new Error('--apply requires --plan-file and --plan-sha256');
  }
  if (!/^[0-9a-f]{64}$/.test(expectedSha)) {
    throw new Error('--plan-sha256 must be exactly 64 lowercase hexadecimal characters');
  }
  const raw = readFileSync(planFile, 'utf8');
  const actualSha = sha256(raw);
  if (actualSha !== expectedSha) {
    throw new Error(`plan SHA-256 mismatch expected=${expectedSha} actual=${actualSha}`);
  }
  const { manifest, plans } = parseRepairPlanFile(raw);
  if (manifest.maintenanceProfile !== profile.name) {
    throw new Error('maintenance profile does not exactly match the signed plan manifest');
  }
  if (profile.expectedDatabase && (
    manifest.databaseName !== profile.expectedDatabase.databaseName
    || manifest.databaseIdentity !== profile.expectedDatabase.databaseIdentity
  )) {
    throw new Error('HK_UAT_PROFILE_DATABASE_BINDING_MISMATCH');
  }
  if (
    confirmedDatabaseName !== manifest.databaseName
    || confirmedDatabaseIdentity !== manifest.databaseIdentity
  ) {
    throw new Error('database confirmation does not exactly match the signed plan manifest');
  }
  const currentEndpointSha256 = databaseEndpointSha256();
  if (currentEndpointSha256 !== manifest.endpointSha256) {
    throw new Error('DATABASE_BINDING_MISMATCH:database endpoint differs from plan manifest');
  }
  const databaseBinding = await prisma.$transaction(async (tx) => (
    loadRepairDatabaseBinding(tx, manifest)
  ), {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 10_000,
    timeout: 30_000,
  });
  if (!sameDatabaseBinding(databaseBinding, manifest)) {
    throw new Error('DATABASE_BINDING_MISMATCH:database locator differs from plan manifest');
  }
  const typeFilter = accountTypeFilter();
  const wrongType = plans.find((plan): plan is Extract<
    BalanceLedgerRepairPlan,
    { status: 'READY' }
  > => (
    typeFilter !== 'all'
    && plan.status === 'READY'
    && plan.accountType !== typeFilter
  ));
  if (wrongType) {
    throw new Error(
      `plan account ${wrongType.billingAccountId} is ${wrongType.accountType}, not ${typeFilter}`,
    );
  }
  const accountIds = plans.map((plan) => plan.billingAccountId);
  if (new Set(accountIds).size !== accountIds.length) {
    throw new Error('plan contains duplicate billingAccountId entries');
  }
  const readyPlans = plans.filter(
    (plan): plan is Extract<BalanceLedgerRepairPlan, { status: 'READY' }> => plan.status === 'READY',
  );
  assertExecutionProfilePlanSet(profile, option('--billing-account-id'), plans);
  if (readyPlans.length === 0) throw new Error('plan contains no READY accounts');
  const voucherApprovalRefs = resolveVoucherApprovalRefs(
    readyPlans,
    option('--finance-approval-ref'),
    option('--technical-approval-ref'),
  );

  const resumeRunId = option('--resume-run-id');
  const run = await prisma.$transaction(async (tx) => {
    await loadRepairDatabaseBinding(tx, databaseBinding);
    return resumeRunId
      ? tx.balanceLedgerRepairRun.findUniqueOrThrow({ where: { id: resumeRunId } })
      : tx.balanceLedgerRepairRun.create({
        data: {
          status: 'RUNNING',
          planHash: actualSha,
          initiatedBy,
        },
      });
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 10_000,
    timeout: 30_000,
  });
  if (run.planHash !== actualSha) {
    throw new Error(`resume run plan SHA-256 mismatch expected=${run.planHash} actual=${actualSha}`);
  }
  if (resumeRunId) {
    assertResumeRunInitiator(profile, initiatedBy, run.initiatedBy);
  }
  if (run.status !== 'RUNNING' && run.status !== 'COMPLETED' && run.status !== 'COMPLETED_WITH_EXCEPTIONS') {
    throw new Error(`resume run has unsupported status ${run.status}`);
  }
  let applied = 0;
  let stale = 0;
  let failed = 0;
  for (const plan of readyPlans) {
    const existing = await resolveExistingRepairAccount(
      run.id,
      plan,
      databaseBinding,
      voucherApprovalRefs,
    );
    if (existing === 'APPLIED') {
      applied += 1;
      continue;
    }
    if (existing === 'SKIPPED_STALE') {
      stale += 1;
      continue;
    }
    if (existing === 'FAILED') {
      failed += 1;
      continue;
    }
    if (run.status !== 'RUNNING') {
      throw new Error(`TERMINAL_RUN_MISSING_ACCOUNT:${run.id}:${plan.billingAccountId}`);
    }
    try {
      const result = await applyReadyPlanWithRetry(
        run.id,
        plan,
        databaseBinding,
        voucherApprovalRefs,
        profile,
      );
      if (result === 'APPLIED') applied += 1;
      else stale += 1;
    } catch (error) {
      if (isDatabaseBindingFailure(error)) throw error;
      const unknownCommitOutcome = isUnknownCommitOutcome(error);
      const unknownCommitDetail = error instanceof Error ? error.message : String(error);
      // A connection can report an unknown outcome after PostgreSQL committed.
      // Terminal APPLIED evidence is authoritative and must never be rewritten
      // to FAILED by a catch/upsert path.
      if (await hasCommittedAppliedProofWithRetry(
        run.id,
        plan,
        databaseBinding,
        voucherApprovalRefs,
      )) {
        applied += 1;
        continue;
      }
      const resolution = await resolveExistingRepairAccount(
        run.id,
        plan,
        databaseBinding,
        voucherApprovalRefs,
      );
      if (resolution === 'APPLIED') {
        applied += 1;
        continue;
      }
      if (resolution === 'SKIPPED_STALE') {
        stale += 1;
        continue;
      }
      if (resolution === 'FAILED') {
        // A pre-existing FAILED row is safe to count during --resume, but a
        // connection-uncertain apply must never use it to collapse an unknown
        // outcome into COMPLETED_WITH_EXCEPTIONS.  Leave the run RUNNING so an
        // operator can resume after the primary's final state is observable.
        if (unknownCommitOutcome) {
          throw new Error(
            `UNKNOWN_COMMIT_UNRESOLVED:${plan.billingAccountId}:${unknownCommitDetail}`,
          );
        }
        failed += 1;
        continue;
      }
      if (unknownCommitOutcome) {
        throw new Error(
          `UNKNOWN_COMMIT_UNRESOLVED:${plan.billingAccountId}:${unknownCommitDetail}`,
        );
      }
      await prisma.$transaction(async (tx) => {
        await loadRepairDatabaseBinding(tx, databaseBinding);
        await tx.balanceLedgerRepairAccount.create({
          data: {
            runId: run.id,
            billingAccountId: plan.billingAccountId,
            status: 'FAILED',
            preconditionHash: plan.preconditionHash,
            beforeSnapshot: repairAuditJsonWithLimit(
              buildRepairFailureManifest(plan),
              'REPAIR_FAILURE_MANIFEST',
              MAX_REPAIR_BEFORE_JSON_BYTES,
            ),
            error: error instanceof Error ? error.message : String(error),
          },
        });
      }, {
        isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
        maxWait: 10_000,
        timeout: 30_000,
      });
      failed += 1;
    }
  }
  const terminalStatus = failed > 0 || stale > 0 ? 'COMPLETED_WITH_EXCEPTIONS' : 'COMPLETED';
  if (run.status === 'RUNNING') {
    await prisma.$transaction(async (tx) => {
      await loadRepairDatabaseBinding(tx, databaseBinding);
      await tx.balanceLedgerRepairRun.update({
        where: { id: run.id },
        data: {
          status: terminalStatus,
          completedAt: new Date(),
        },
      });
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 30_000,
    });
  } else if (run.status !== terminalStatus) {
    throw new Error(`TERMINAL_RUN_RESULT_MISMATCH:${run.id}:${run.status}:${terminalStatus}`);
  }
  console.log(JSON.stringify({ mode: 'apply', runId: run.id, applied, stale, failed }));
  if (failed > 0 || stale > 0) process.exitCode = 2;
}

async function main(): Promise<void> {
  validateArguments();
  const profile = executionProfile();
  assertExecutionProfileSelectors(profile, {
    accountType: option('--account-type'),
    billingAccountId: option('--billing-account-id'),
    limit: option('--limit'),
    cursorAfter: option('--cursor-after'),
  });
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
