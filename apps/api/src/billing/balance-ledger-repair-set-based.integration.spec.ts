import { randomUUID } from 'node:crypto';
import { Prisma, PrismaClient, TransactionType } from '@prisma/client';
import {
  BOUNDED_STAGE_MAX_JSON_BYTES,
  BOUNDED_STAGE_MAX_ROWS,
  GENERIC_REPAIR_TRANSACTION_TIMEOUT_MS,
  BalanceLedgerRepairExecutionProfile,
  applyAllocationMutationsFromStage,
  applyReadyPlan,
  applyTransactionSequenceMutationsFromStage,
  assertCompleteMutationAuditSets,
  hasCommittedAppliedProof,
  loadPostgresFinancialNow,
  loadSnapshot,
  loadRepairDatabaseBinding,
  registerAllocationMutationAuditsFromStage,
  registerLegacyVoucherFundingProofsSetBased,
  registerMigrationOpeningGrantRetirementsSetBased,
  registerPersonalDebtAllocationProofsSetBased,
  registerTransactionSequenceMutationAuditsFromStage,
  resolveExecutionProfile,
  retireMigrationOpeningGrantsSetBased,
  stageRepairMutations,
} from '../../scripts/reconcile-personal-balance-ledger';
import {
  ENTERPRISE_ABSORB_CANONICAL_CONSTRAINTS,
  applyPairAllocationMutationsSetBased,
  applyPairTransactionSequenceMutationsSetBased,
  flushEnterpriseAbsorbCanonicalConstraintsWhileLegacyDirty,
} from '../../scripts/reconcile-enterprise-absorb-ledger';
import {
  BalanceLedgerRepairInvoiceEvidence,
  BalanceLedgerRepairPlan,
  BalanceLedgerRepairSnapshot,
  buildBalanceLedgerRepairPlan,
} from './balance-ledger-repair';

const maybeDescribe = process.env.TEST_INTEGRATION === '1' ? describe : describe.skip;

function singleConnectionDatabaseUrl(): string {
  const raw = (process.env.BILLING_DATABASE_URL || process.env.DATABASE_URL)?.trim();
  if (!raw) throw new Error('DATABASE_URL is required');
  const url = new URL(raw);
  url.searchParams.set('connection_limit', '1');
  url.searchParams.set('pool_timeout', '10');
  return url.toString();
}

async function assertIsolatedTestDatabase(prisma: PrismaClient): Promise<void> {
  const expectedDatabase = process.env.TEST_DATABASE_NAME?.trim();
  if (!expectedDatabase || !/(test|ci)/i.test(expectedDatabase)) {
    throw new Error('TEST_DATABASE_NAME must name an isolated test/ci database');
  }
  const [row] = await prisma.$queryRaw<Array<{ databaseName: string }>>`
    SELECT current_database() AS "databaseName"`;
  expect(row?.databaseName).toBe(expectedDatabase);
}

async function createTempRepairContract(
  tx: Prisma.TransactionClient,
  onCommitDrop: boolean,
): Promise<void> {
  const onCommit = onCommitDrop ? ' ON COMMIT DROP' : '';
  await tx.$executeRawUnsafe('SET LOCAL search_path = pg_temp, public');
  await tx.$executeRawUnsafe(`CREATE TEMP TABLE "billing_accounts" (
    "id" TEXT PRIMARY KEY, "balance_grant_ledger_status" TEXT NOT NULL
  )${onCommit}`);
  await tx.$executeRawUnsafe(`CREATE TEMP TABLE "balance_ledger_repair_runs" (
    "id" TEXT PRIMARY KEY, "status" TEXT NOT NULL
  )${onCommit}`);
  await tx.$executeRawUnsafe(`CREATE TEMP TABLE "balance_ledger_repair_accounts" (
    "id" TEXT PRIMARY KEY, "run_id" TEXT NOT NULL,
    "billing_account_id" TEXT NOT NULL, "status" TEXT NOT NULL
  )${onCommit}`);
  await tx.$executeRawUnsafe(`CREATE TEMP TABLE "balance_transactions" (
    "id" TEXT PRIMARY KEY, "billing_account_id" TEXT NOT NULL,
    "ledger_sequence" BIGINT, "note" TEXT NOT NULL
  )${onCommit}`);
  await tx.$executeRawUnsafe(`CREATE TEMP TABLE "balance_ledger_transaction_repairs" (
    "id" TEXT PRIMARY KEY, "operation_key" TEXT NOT NULL UNIQUE,
    "run_id" TEXT NOT NULL, "repair_account_id" TEXT NOT NULL,
    "billing_account_id" TEXT NOT NULL, "transaction_id" TEXT NOT NULL,
    "before_snapshot" JSONB NOT NULL, "after_snapshot" JSONB NOT NULL,
    UNIQUE ("run_id", "transaction_id")
  )${onCommit}`);
  await tx.$executeRawUnsafe(`CREATE TEMP TABLE "balance_consumption_allocations" (
    "id" TEXT PRIMARY KEY, "user_id" TEXT NOT NULL, "tenant_id" TEXT NOT NULL,
    "billing_account_id" TEXT NOT NULL, "product_id" TEXT,
    "balance_transaction_id" TEXT NOT NULL, "token_usage_id" TEXT,
    "balance_grant_id" TEXT, "source" TEXT NOT NULL, "amount_usd" NUMERIC NOT NULL,
    "recognized_revenue_usd" NUMERIC NOT NULL, "bonus_consumed_usd" NUMERIC NOT NULL,
    "discount_rate" NUMERIC NOT NULL, "settled_usd" NUMERIC NOT NULL,
    "settled_at" TIMESTAMP(3), "ledger_sequence" BIGINT,
    "created_at" TIMESTAMP(3) NOT NULL
  )${onCommit}`);
  await tx.$executeRawUnsafe(`CREATE TEMP TABLE "balance_ledger_allocation_repairs" (
    "id" TEXT PRIMARY KEY, "operation_key" TEXT NOT NULL UNIQUE,
    "run_id" TEXT NOT NULL, "repair_account_id" TEXT NOT NULL,
    "billing_account_id" TEXT NOT NULL, "allocation_id" TEXT NOT NULL,
    "before_snapshot" JSONB NOT NULL, "after_snapshot" JSONB NOT NULL,
    UNIQUE ("run_id", "allocation_id")
  )${onCommit}`);

  // Attach the production trigger functions to the temporary, indexed fixture
  // tables. This executes the real exact OLD/NEW authorization contract while
  // keeping the public financial tables untouched.
  await tx.$executeRawUnsafe(`CREATE TRIGGER "temp_transaction_repair_insert_guard"
    BEFORE INSERT ON "balance_ledger_transaction_repairs" FOR EACH ROW
    EXECUTE FUNCTION public."validate_balance_ledger_transaction_repair_insert"()`);
  await tx.$executeRawUnsafe(`CREATE TRIGGER "temp_transaction_append_only"
    BEFORE UPDATE OR DELETE ON "balance_transactions" FOR EACH ROW
    EXECUTE FUNCTION public."reject_balance_transaction_mutation"()`);
  await tx.$executeRawUnsafe(`CREATE TRIGGER "temp_allocation_repair_insert_guard"
    BEFORE INSERT ON "balance_ledger_allocation_repairs" FOR EACH ROW
    EXECUTE FUNCTION public."validate_balance_ledger_allocation_repair_insert"()`);
  await tx.$executeRawUnsafe(`CREATE TRIGGER "temp_allocation_financial_rewrite_guard"
    BEFORE UPDATE ON "balance_consumption_allocations" FOR EACH ROW
    EXECUTE FUNCTION public."guard_balance_consumption_allocation_financial_rewrite"()`);
}

async function seedRepairIdentity(
  tx: Prisma.TransactionClient,
  runId: string,
  repairAccountId: string,
  billingAccountId: string,
): Promise<void> {
  await tx.$executeRaw`
    INSERT INTO "billing_accounts" VALUES (${billingAccountId}, 'LEGACY_DIRTY')`;
  await tx.$executeRaw`
    INSERT INTO "balance_ledger_repair_runs" VALUES (${runId}, 'RUNNING')`;
  await tx.$executeRaw`
    INSERT INTO "balance_ledger_repair_accounts"
    VALUES (${repairAccountId}, ${runId}, ${billingAccountId}, 'RUNNING')`;
  await tx.$executeRaw`SELECT set_config('billing.balance_ledger_repair_run_id', ${runId}, TRUE)`;
}

async function expectExactSetBasedEvidence(
  tx: Prisma.TransactionClient,
  transactionCount: number,
  allocationCount: number,
): Promise<void> {
  const [evidence] = await tx.$queryRaw<Array<{
    transactionCount: bigint;
    transactionAuditCount: bigint;
    invalidTransactionAuditCount: bigint;
    allocationCount: bigint;
    allocationAuditCount: bigint;
    invalidAllocationAuditCount: bigint;
  }>>`
    SELECT
      (SELECT COUNT(*) FROM "balance_transactions"
        WHERE "ledger_sequence" IS NOT NULL) AS "transactionCount",
      (SELECT COUNT(*) FROM "balance_ledger_transaction_repairs")
        AS "transactionAuditCount",
      (SELECT COUNT(*) FROM "balance_ledger_transaction_repairs" repair
        JOIN "balance_transactions" transaction_row
          ON transaction_row."id" = repair."transaction_id"
        WHERE repair."before_snapshot"->'ledger_sequence' <> 'null'::JSONB
          OR repair."after_snapshot" IS DISTINCT FROM to_jsonb(transaction_row))
        AS "invalidTransactionAuditCount",
      (SELECT COUNT(*) FROM "balance_consumption_allocations"
        WHERE "ledger_sequence" IS NOT NULL) AS "allocationCount",
      (SELECT COUNT(*) FROM "balance_ledger_allocation_repairs")
        AS "allocationAuditCount",
      (SELECT COUNT(*) FROM "balance_ledger_allocation_repairs" repair
        JOIN "balance_consumption_allocations" allocation
          ON allocation."id" = repair."allocation_id"
        WHERE repair."before_snapshot"->'ledger_sequence' <> 'null'::JSONB
          OR repair."after_snapshot" IS DISTINCT FROM to_jsonb(allocation))
        AS "invalidAllocationAuditCount"`;
  expect(evidence).toEqual({
    transactionCount: BigInt(transactionCount),
    transactionAuditCount: BigInt(transactionCount),
    invalidTransactionAuditCount: BigInt(0),
    allocationCount: BigInt(allocationCount),
    allocationAuditCount: BigInt(allocationCount),
    invalidAllocationAuditCount: BigInt(0),
  });
}

async function installCompleteAuditSetGuard(
  tx: Prisma.TransactionClient,
  transactionCount: number,
  allocationCount: number,
): Promise<void> {
  await tx.$executeRawUnsafe(`CREATE OR REPLACE FUNCTION pg_temp.assert_complete_repair_audit_set()
    RETURNS TRIGGER LANGUAGE plpgsql AS $$
    DECLARE
      transaction_audit_count BIGINT;
      allocation_audit_count BIGINT;
    BEGIN
      SELECT COUNT(*) INTO transaction_audit_count
      FROM "balance_ledger_transaction_repairs" repair
      WHERE repair."run_id" = current_setting(
        'billing.balance_ledger_repair_run_id', TRUE
      )
        AND repair."billing_account_id" = NEW."billing_account_id";
      SELECT COUNT(*) INTO allocation_audit_count
      FROM "balance_ledger_allocation_repairs" repair
      WHERE repair."run_id" = current_setting(
        'billing.balance_ledger_repair_run_id', TRUE
      )
        AND repair."billing_account_id" = NEW."billing_account_id";
      IF transaction_audit_count <> ${transactionCount}
        OR allocation_audit_count <> ${allocationCount}
      THEN
        RAISE EXCEPTION 'AUDIT_SETS_INCOMPLETE:%:tx=%/%:allocation=%/%',
          TG_TABLE_NAME, transaction_audit_count, ${transactionCount},
          allocation_audit_count, ${allocationCount};
      END IF;
      RETURN NEW;
    END;
    $$`);
  if (transactionCount > 0) {
    await tx.$executeRawUnsafe(`CREATE TRIGGER "zz_temp_transaction_complete_audit_set"
      BEFORE UPDATE ON "balance_transactions" FOR EACH ROW
      EXECUTE FUNCTION pg_temp.assert_complete_repair_audit_set()`);
  }
  if (allocationCount > 0) {
    await tx.$executeRawUnsafe(`CREATE TRIGGER "zz_temp_allocation_complete_audit_set"
      BEFORE UPDATE ON "balance_consumption_allocations" FOR EACH ROW
      EXECUTE FUNCTION pg_temp.assert_complete_repair_audit_set()`);
  }
}

function reversedUuidFifoSnapshot(): BalanceLedgerRepairSnapshot {
  const accountId = 'fifo-projection-account';
  return {
    billingAccountId: accountId,
    accountType: 'personal',
    ledgerStatus: 'LEGACY_DIRTY',
    ledgerVersion: 0,
    walletBalanceUsd: '0.7',
    transactions: [
      {
        id: 'fifo-fund-first', userId: 'fifo-user', tenantId: 'fifo-tenant',
        productId: null, tokenUsageId: null, type: 'RECHARGE', amountUsd: '1',
        balanceAfterUsd: '1', description: 'admin recharge', orderId: null,
        operationKey: null, ledgerSequence: '-4', createdAt: '2026-07-17T00:00:00.000Z',
      },
      {
        id: 'fifo-consume-first', userId: 'fifo-user', tenantId: 'fifo-tenant',
        productId: null, tokenUsageId: null, type: 'CONSUME', amountUsd: '-0.8',
        balanceAfterUsd: '0.2', description: 'usage', orderId: null,
        operationKey: null, ledgerSequence: '-3', createdAt: '2026-07-17T00:01:00.000Z',
      },
      {
        id: 'fifo-fund-later', userId: 'fifo-user', tenantId: 'fifo-tenant',
        productId: null, tokenUsageId: null, type: 'RECHARGE', amountUsd: '1',
        balanceAfterUsd: '1.2', description: 'admin recharge', orderId: null,
        operationKey: null, ledgerSequence: '-2', createdAt: '2026-07-17T00:02:00.000Z',
      },
      {
        id: 'fifo-consume-cross', userId: 'fifo-user', tenantId: 'fifo-tenant',
        productId: null, tokenUsageId: null, type: 'CONSUME', amountUsd: '-0.5',
        balanceAfterUsd: '0.7', description: 'usage', orderId: null,
        operationKey: null, ledgerSequence: '-1', createdAt: '2026-07-17T00:03:00.000Z',
      },
    ],
    grants: [
      {
        id: 'fifo-grant-first', userId: 'fifo-user', tenantId: 'fifo-tenant',
        productId: null, orderId: null, source: 'RECHARGE', paidAmountUsd: '1',
        bonusAmountUsd: '0', grantedAmountUsd: '1', remainingAmountUsd: '0',
        remainingPaidAmountUsd: '0', remainingBonusAmountUsd: '0', discountRate: '1',
        validFrom: '2026-07-17T00:00:00.000Z', expiresAt: null, isExpired: false,
        createdAt: '2026-07-17T00:00:00.000Z',
      },
      {
        id: 'fifo-grant-later', userId: 'fifo-user', tenantId: 'fifo-tenant',
        productId: null, orderId: null, source: 'RECHARGE', paidAmountUsd: '1',
        bonusAmountUsd: '0', grantedAmountUsd: '1', remainingAmountUsd: '0.7',
        remainingPaidAmountUsd: '0.7', remainingBonusAmountUsd: '0', discountRate: '1',
        validFrom: '2026-07-17T00:02:00.000Z', expiresAt: null, isExpired: false,
        createdAt: '2026-07-17T00:02:00.000Z',
      },
    ],
    allocations: [
      {
        id: 'fifo-consume-first-row', userId: 'fifo-user', tenantId: 'fifo-tenant',
        billingAccountId: accountId, productId: null, tokenUsageId: null,
        balanceTransactionId: 'fifo-consume-first', balanceGrantId: 'fifo-grant-first',
        source: 'BALANCE_GRANT', amountUsd: '0.8', recognizedRevenueUsd: '0.8',
        bonusConsumedUsd: '0', discountRate: '1', settledUsd: '0', settledAt: null,
        ledgerSequence: null, createdAt: '2026-07-17T00:01:00.000Z',
      },
      {
        id: 'a-fifo-later-grant-row', userId: 'fifo-user', tenantId: 'fifo-tenant',
        billingAccountId: accountId, productId: null, tokenUsageId: null,
        balanceTransactionId: 'fifo-consume-cross', balanceGrantId: 'fifo-grant-later',
        source: 'BALANCE_GRANT', amountUsd: '0.3', recognizedRevenueUsd: '0.3',
        bonusConsumedUsd: '0', discountRate: '1', settledUsd: '0', settledAt: null,
        ledgerSequence: null, createdAt: '2026-07-17T00:03:00.000Z',
      },
      {
        id: 'z-fifo-first-grant-row', userId: 'fifo-user', tenantId: 'fifo-tenant',
        billingAccountId: accountId, productId: null, tokenUsageId: null,
        balanceTransactionId: 'fifo-consume-cross', balanceGrantId: 'fifo-grant-first',
        source: 'BALANCE_GRANT', amountUsd: '0.2', recognizedRevenueUsd: '0.2',
        bonusConsumedUsd: '0', discountRate: '1', settledUsd: '0', settledAt: null,
        ledgerSequence: null, createdAt: '2026-07-17T00:03:00.000Z',
      },
    ],
    settlements: [],
    orders: [],
    invoiceItems: [],
    voucherIdempotencyEvidence: [],
    expiryAuditCount: 0,
  };
}

function boundedStagePlan(
  billingAccountId: string,
  transactionCount: number,
  allocationCount: number,
): Extract<BalanceLedgerRepairPlan, { status: 'READY' }> {
  return {
    status: 'READY',
    billingAccountId,
    accountType: 'personal',
    debtSource: 'NEGATIVE_BALANCE',
    settlementWriteMode: 'CREATE',
    expectedSettlementCount: 0,
    preconditionHash: 'bounded-stage-precondition',
    replayHash: 'bounded-stage-replay',
    walletBalanceUsd: '0.000000000000',
    currentDebtUsd: '0.000000000000',
    legacySettledDebtUsd: '0.000000000000',
    activeGrantDriftUsd: '0.000000000000',
    throughTransactionId: transactionCount > 0
      ? `bounded-tx-${transactionCount}`
      : null,
    transactionSequenceMutations: Array.from(
      { length: transactionCount },
      (_, index) => ({
        transactionId: `bounded-tx-${index + 1}`,
        expectedLedgerSequence: null,
        ledgerSequence: `-${index + 1}`,
      }),
    ),
    grantMutations: [],
    allocationMutations: [],
    allocationSequenceMutations: Array.from(
      { length: allocationCount },
      (_, index) => ({
        allocationId: `bounded-allocation-${index + 1}`,
        expectedLedgerSequence: null,
        ledgerSequence: `-${index + 1}`,
      }),
    ),
    unreconciledGrantMutations: [],
    canonicalAllocationMutations: [],
    migrationOpeningDebtMutations: [],
    personalDebtAllocationMutations: [],
    legacyVoucherProofMutations: [],
    legacyExpiryProofMutations: [],
    invoiceStabilityProof: null,
    settlementMutations: [],
    legacyAdminFundingRepairs: [],
  };
}

async function seedFifoProjection(
  tx: Prisma.TransactionClient,
  snapshot: BalanceLedgerRepairSnapshot,
  sequenceByAllocationId: ReadonlyMap<string, string>,
): Promise<void> {
  await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
  await tx.billingAccount.create({
    data: {
      id: snapshot.billingAccountId,
      type: 'personal',
      name: 'FIFO projection fixture',
      status: 'active',
      currency: 'USD',
      balanceGrantLedgerStatus: 'LEGACY_DIRTY',
      balanceGrantLedgerVersion: 0,
    },
  });
  await tx.accountWallet.create({
    data: {
      billingAccountId: snapshot.billingAccountId,
      balanceUsd: new Prisma.Decimal(snapshot.walletBalanceUsd),
    },
  });
  await tx.balanceTransaction.createMany({
    data: snapshot.transactions.map((row) => ({
      id: row.id,
      operationKey: row.operationKey ?? null,
      userId: row.userId!,
      tenantId: row.tenantId!,
      billingAccountId: snapshot.billingAccountId,
      type: row.type as TransactionType,
      amountUsd: new Prisma.Decimal(row.amountUsd),
      balanceAfterUsd: new Prisma.Decimal(row.balanceAfterUsd),
      description: row.description,
      orderId: row.orderId,
      productId: row.productId ?? null,
      tokenUsageId: row.tokenUsageId ?? null,
      ledgerSequence: BigInt(row.ledgerSequence!),
      createdAt: new Date(row.createdAt),
    })),
  });
  await tx.balanceGrant.createMany({
    data: snapshot.grants.map((row) => ({
      id: row.id,
      userId: row.userId!,
      tenantId: row.tenantId!,
      billingAccountId: snapshot.billingAccountId,
      orderId: row.orderId,
      productId: row.productId ?? null,
      source: row.source,
      paidAmountUsd: new Prisma.Decimal(row.paidAmountUsd),
      bonusAmountUsd: new Prisma.Decimal(row.bonusAmountUsd),
      grantedAmountUsd: new Prisma.Decimal(row.grantedAmountUsd),
      remainingAmountUsd: new Prisma.Decimal(row.remainingAmountUsd),
      remainingPaidAmountUsd: new Prisma.Decimal(row.remainingPaidAmountUsd!),
      remainingBonusAmountUsd: new Prisma.Decimal(row.remainingBonusAmountUsd!),
      discountRate: new Prisma.Decimal(row.discountRate),
      validFrom: new Date(row.validFrom!),
      expiresAt: row.expiresAt === null ? null : new Date(row.expiresAt!),
      isExpired: row.isExpired,
      createdAt: new Date(row.createdAt),
    })),
  });
  await tx.balanceConsumptionAllocation.createMany({
    data: snapshot.allocations.map((row) => ({
      id: row.id,
      userId: row.userId!,
      tenantId: row.tenantId!,
      billingAccountId: snapshot.billingAccountId,
      productId: row.productId ?? null,
      balanceTransactionId: row.balanceTransactionId,
      tokenUsageId: row.tokenUsageId ?? null,
      balanceGrantId: row.balanceGrantId,
      source: row.source,
      amountUsd: new Prisma.Decimal(row.amountUsd),
      recognizedRevenueUsd: new Prisma.Decimal(row.recognizedRevenueUsd),
      bonusConsumedUsd: new Prisma.Decimal(row.bonusConsumedUsd),
      discountRate: new Prisma.Decimal(row.discountRate!),
      settledUsd: new Prisma.Decimal(row.settledUsd),
      settledAt: row.settledAt === null ? null : new Date(row.settledAt),
      ledgerSequence: BigInt(sequenceByAllocationId.get(row.id)!),
      createdAt: new Date(row.createdAt),
    })),
  });
  await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'origin'");
}

type MigrationOpeningRetirementFixture = {
  snapshot: BalanceLedgerRepairSnapshot;
  userId: string;
  tenantId: string;
  initialGrantId: string;
  migrationGrantId: string;
  laterGrantId: string;
  migrationAllocationId: string;
};

function migrationOpeningRetirementFixture(): MigrationOpeningRetirementFixture {
  const suffix = randomUUID();
  const userId = `migration-opening-user-${suffix}`;
  const tenantId = `migration-opening-tenant-${suffix}`;
  const billingAccountId = `migration-opening-account-${suffix}`;
  const initialGrantId = `migration-opening-initial-grant-${suffix}`;
  const migrationGrantId = `migration-opening-placeholder-${suffix}`;
  const laterGrantId = `migration-opening-later-grant-${suffix}`;
  const initialFundingId = `migration-opening-initial-funding-${suffix}`;
  const overConsumeId = `migration-opening-over-consume-${suffix}`;
  const laterFundingId = `migration-opening-later-funding-${suffix}`;
  const laterConsumeId = `migration-opening-later-consume-${suffix}`;
  const migrationAllocationId = `migration-opening-debt-allocation-${suffix}`;
  return {
    userId,
    tenantId,
    initialGrantId,
    migrationGrantId,
    laterGrantId,
    migrationAllocationId,
    snapshot: {
      billingAccountId,
      accountType: 'personal',
      ledgerStatus: 'LEGACY_DIRTY',
      ledgerVersion: 0,
      walletBalanceUsd: '0.585148000000',
      transactions: [
        {
          id: initialFundingId,
          userId,
          tenantId,
          productId: null,
          tokenUsageId: null,
          type: 'RECHARGE',
          amountUsd: '0.463644000000',
          balanceAfterUsd: '0.463644000000',
          description: 'migration opening integration initial funding',
          orderId: null,
          operationKey: `balance:admin-recharge:grant:${initialGrantId}`,
          ledgerSequence: '-4',
          createdAt: '2026-07-09T05:00:00.000Z',
        },
        {
          id: overConsumeId,
          userId,
          tenantId,
          productId: null,
          tokenUsageId: null,
          type: 'CONSUME',
          amountUsd: '-0.678496000000',
          balanceAfterUsd: '-0.214852000000',
          description: 'migration opening integration over-consume',
          orderId: null,
          operationKey: null,
          ledgerSequence: '-3',
          createdAt: '2026-07-09T05:40:51.576Z',
        },
        {
          id: laterFundingId,
          userId,
          tenantId,
          productId: null,
          tokenUsageId: null,
          type: 'RECHARGE',
          amountUsd: '1.000000000000',
          balanceAfterUsd: '0.785148000000',
          description: 'migration opening integration later funding',
          orderId: null,
          operationKey: `balance:admin-recharge:grant:${laterGrantId}`,
          ledgerSequence: '-2',
          createdAt: '2026-07-09T06:22:48.807Z',
        },
        {
          id: laterConsumeId,
          userId,
          tenantId,
          productId: null,
          tokenUsageId: null,
          type: 'CONSUME',
          amountUsd: '-0.200000000000',
          balanceAfterUsd: '0.585148000000',
          description: 'migration opening integration later consume',
          orderId: null,
          operationKey: null,
          ledgerSequence: '-1',
          createdAt: '2026-07-09T07:00:00.000Z',
        },
      ],
      grants: [
        {
          id: initialGrantId,
          userId,
          tenantId,
          productId: null,
          orderId: null,
          source: 'RECHARGE',
          paidAmountUsd: '0.463644000000',
          bonusAmountUsd: '0.000000000000',
          grantedAmountUsd: '0.463644000000',
          remainingAmountUsd: '0.000000000000',
          remainingPaidAmountUsd: null,
          remainingBonusAmountUsd: null,
          discountRate: '1.000000000000',
          isExpired: false,
          validFrom: '2026-07-09T05:00:00.000Z',
          expiresAt: null,
          createdAt: '2026-07-09T05:00:00.000Z',
        },
        {
          id: migrationGrantId,
          userId,
          tenantId,
          productId: null,
          orderId: null,
          source: 'MIGRATION_OPENING',
          paidAmountUsd: '0.214852000000',
          bonusAmountUsd: '0.000000000000',
          grantedAmountUsd: '0.214852000000',
          remainingAmountUsd: '0.000000000000',
          remainingPaidAmountUsd: null,
          remainingBonusAmountUsd: null,
          discountRate: '1.000000000000',
          isExpired: false,
          validFrom: '2026-07-09T05:40:51.584Z',
          expiresAt: null,
          createdAt: '2026-07-09T05:40:51.585Z',
        },
        {
          id: laterGrantId,
          userId,
          tenantId,
          productId: null,
          orderId: null,
          source: 'RECHARGE',
          paidAmountUsd: '1.000000000000',
          bonusAmountUsd: '0.000000000000',
          grantedAmountUsd: '1.000000000000',
          remainingAmountUsd: '0.800000000000',
          remainingPaidAmountUsd: null,
          remainingBonusAmountUsd: null,
          discountRate: '1.000000000000',
          isExpired: false,
          validFrom: '2026-07-09T06:22:48.807Z',
          expiresAt: null,
          createdAt: '2026-07-09T06:22:48.807Z',
        },
      ],
      allocations: [
        {
          id: `migration-opening-initial-allocation-${suffix}`,
          billingAccountId,
          userId,
          tenantId,
          productId: null,
          balanceTransactionId: overConsumeId,
          tokenUsageId: null,
          balanceGrantId: initialGrantId,
          source: 'BALANCE_GRANT',
          amountUsd: '0.463644000000',
          recognizedRevenueUsd: '0.463644000000',
          bonusConsumedUsd: '0.000000000000',
          discountRate: '1.000000000000',
          settledUsd: '0.000000000000',
          settledAt: null,
          ledgerSequence: '-3',
          createdAt: '2026-07-09T05:40:51.583Z',
        },
        {
          id: migrationAllocationId,
          billingAccountId,
          userId,
          tenantId,
          productId: null,
          balanceTransactionId: overConsumeId,
          tokenUsageId: null,
          balanceGrantId: migrationGrantId,
          source: 'BALANCE_GRANT',
          amountUsd: '0.214852000000',
          recognizedRevenueUsd: '0.214852000000',
          bonusConsumedUsd: '0.000000000000',
          discountRate: '1.000000000000',
          settledUsd: '0.000000000000',
          settledAt: null,
          ledgerSequence: '-2',
          createdAt: '2026-07-09T05:40:51.587Z',
        },
        {
          id: `migration-opening-later-allocation-${suffix}`,
          billingAccountId,
          userId,
          tenantId,
          productId: null,
          balanceTransactionId: laterConsumeId,
          tokenUsageId: null,
          balanceGrantId: laterGrantId,
          source: 'BALANCE_GRANT',
          amountUsd: '0.200000000000',
          recognizedRevenueUsd: '0.200000000000',
          bonusConsumedUsd: '0.000000000000',
          discountRate: '1.000000000000',
          settledUsd: '0.000000000000',
          settledAt: null,
          ledgerSequence: '-1',
          createdAt: '2026-07-09T07:00:00.001Z',
        },
      ],
      settlements: [],
      orders: [],
      invoiceItems: [],
      voucherIdempotencyEvidence: [],
      expiryAuditCount: 0,
    },
  };
}

type LegacyPersonalProofCombinationFixture = {
  snapshot: BalanceLedgerRepairSnapshot;
  userId: string;
  tenantId: string;
  voucherGrantId: string;
  voucherTransactionId: string;
  openingGrantIds: string[];
};

/**
 * Anonymous production-equation fixture. Five opening debts total
 * 0.081552076, a 100 voucher carries the historical full-remainder receipt,
 * and the three later writer errors require one SPLIT plus two RECLASS rows.
 * The voucher is intentionally non-expiring because expiry repair is a
 * separate contract; this fixture only proves the combined allocation repair.
 */
function legacyPersonalProofCombinationFixture(): LegacyPersonalProofCombinationFixture {
  const suffix = randomUUID();
  const id = (name: string) => `${name}-${suffix}`;
  const userId = id('proof-user');
  const tenantId = id('proof-tenant');
  const billingAccountId = id('proof-account');
  const voucherGrantId = id('b-voucher-grant');
  const voucherTransactionId = id('b-voucher-100');
  const voucherExpiresAt: string | null = null;
  const opening = [
    { amount: '0.010000000000', after: '-0.010000000000' },
    { amount: '0.015000000000', after: '-0.025000000000' },
    { amount: '0.020000000000', after: '-0.045000000000' },
    { amount: '0.016552076000', after: '-0.061552076000' },
    { amount: '0.020000000000', after: '-0.081552076000' },
  ];
  const openingGrantIds = opening.map((_, index) => id(`b-opening-grant-${index + 1}`));
  const openingTransactionIds = opening.map(
    (_, index) => id(`b-opening-consume-${index + 1}`),
  );
  const openingAllocationIds = opening.map(
    (_, index) => id(`b-opening-allocation-${index + 1}`),
  );
  const partialTransactionId = id('b-partial-consume');
  const partialAllocationId = id('b-partial-allocation');
  const fullTransactionId1 = id('b-full-consume-1');
  const fullTransactionId2 = id('b-full-consume-2');
  const fullAllocationId1 = id('b-full-allocation-1');
  const fullAllocationId2 = id('b-full-allocation-2');
  const transactionDefaults = {
    userId,
    tenantId,
    productId: null,
    orderId: null,
    operationKey: null,
    ledgerSequence: null,
  };
  const transactions: BalanceLedgerRepairSnapshot['transactions'] = opening.map(
    ({ amount, after }, index) => ({
      ...transactionDefaults,
      id: openingTransactionIds[index],
      ledgerSequence: String(index - 10),
      tokenUsageId: id(`b-opening-usage-${index + 1}`),
      type: 'CONSUME',
      amountUsd: `-${amount}`,
      balanceAfterUsd: after,
      description: 'usage',
      createdAt: `2026-07-15T09:00:0${index}.000Z`,
    }),
  );
  transactions.push(
    {
      ...transactionDefaults,
      id: voucherTransactionId,
      ledgerSequence: '-5',
      tokenUsageId: null,
      type: 'ADJUST',
      amountUsd: '100.000000000000',
      balanceAfterUsd: '99.918447924000',
      description: `voucher:${voucherGrantId} admin:repair historical voucher`,
      createdAt: '2026-07-15T09:01:00.029Z',
    },
    {
      ...transactionDefaults,
      id: id('b-legitimate-consume'),
      ledgerSequence: '-4',
      tokenUsageId: id('b-usage-legitimate'),
      type: 'CONSUME',
      amountUsd: '-99.906900840000',
      balanceAfterUsd: '0.011547084000',
      description: 'usage',
      createdAt: '2026-07-15T09:02:00.000Z',
    },
    {
      ...transactionDefaults,
      id: partialTransactionId,
      ledgerSequence: '-3',
      tokenUsageId: id('b-usage-partial'),
      type: 'CONSUME',
      amountUsd: '-0.028941300000',
      balanceAfterUsd: '-0.017394216000',
      description: 'usage',
      createdAt: '2026-07-15T09:03:00.000Z',
    },
    {
      ...transactionDefaults,
      id: fullTransactionId1,
      ledgerSequence: '-2',
      tokenUsageId: id('b-usage-full-1'),
      type: 'CONSUME',
      amountUsd: '-0.008336700000',
      balanceAfterUsd: '-0.025730916000',
      description: 'usage',
      createdAt: '2026-07-15T09:04:00.000Z',
    },
    {
      ...transactionDefaults,
      id: fullTransactionId2,
      ledgerSequence: '-1',
      tokenUsageId: id('b-usage-full-2'),
      type: 'CONSUME',
      amountUsd: '-0.017340300000',
      balanceAfterUsd: '-0.043071216000',
      description: 'usage',
      createdAt: '2026-07-15T09:05:00.000Z',
    },
  );
  const grants: BalanceLedgerRepairSnapshot['grants'] = opening.map(
    ({ amount }, index) => ({
      id: openingGrantIds[index],
      userId,
      tenantId,
      productId: null,
      orderId: null,
      source: 'MIGRATION_OPENING',
      paidAmountUsd: amount,
      bonusAmountUsd: '0.000000000000',
      grantedAmountUsd: amount,
      remainingAmountUsd: '0.000000000000',
      remainingPaidAmountUsd: null,
      remainingBonusAmountUsd: null,
      discountRate: '1.000000000000',
      isExpired: false,
      validFrom: `2026-07-15T09:00:0${index}.001Z`,
      createdAt: `2026-07-15T09:00:0${index}.002Z`,
      expiresAt: null,
    }),
  );
  grants.push({
    id: voucherGrantId,
    userId,
    tenantId,
    productId: null,
    orderId: null,
    source: 'VOUCHER',
    paidAmountUsd: '0.000000000000',
    bonusAmountUsd: '100.000000000000',
    grantedAmountUsd: '100.000000000000',
    remainingAmountUsd: '0.038480860000',
    remainingPaidAmountUsd: null,
    remainingBonusAmountUsd: null,
    discountRate: '0.000000000000',
    isExpired: false,
    validFrom: '2026-07-15T09:01:00.001Z',
    createdAt: '2026-07-15T09:01:00.019Z',
    expiresAt: voucherExpiresAt,
  });
  const allocationDefaults = {
    billingAccountId,
    userId,
    tenantId,
    productId: null,
    settledUsd: '0.000000000000',
    settledAt: null,
    ledgerSequence: null,
  };
  const allocations: BalanceLedgerRepairSnapshot['allocations'] = opening.map(
    ({ amount }, index) => ({
      ...allocationDefaults,
      id: openingAllocationIds[index],
      balanceTransactionId: openingTransactionIds[index],
      tokenUsageId: id(`b-opening-usage-${index + 1}`),
      balanceGrantId: openingGrantIds[index],
      source: 'BALANCE_GRANT',
      amountUsd: amount,
      recognizedRevenueUsd: amount,
      bonusConsumedUsd: '0.000000000000',
      discountRate: '1.000000000000',
      createdAt: `2026-07-15T09:00:0${index}.003Z`,
    }),
  );
  allocations.push(
    {
      ...allocationDefaults,
      id: id('b-legitimate-allocation'),
      balanceTransactionId: id('b-legitimate-consume'),
      tokenUsageId: id('b-usage-legitimate'),
      balanceGrantId: voucherGrantId,
      source: 'BALANCE_GRANT',
      amountUsd: '99.906900840000',
      recognizedRevenueUsd: '0.000000000000',
      bonusConsumedUsd: '99.906900840000',
      discountRate: '0.000000000000',
      createdAt: '2026-07-15T09:02:00.001Z',
    },
    {
      ...allocationDefaults,
      id: partialAllocationId,
      balanceTransactionId: partialTransactionId,
      tokenUsageId: id('b-usage-partial'),
      balanceGrantId: voucherGrantId,
      source: 'BALANCE_GRANT',
      amountUsd: '0.028941300000',
      recognizedRevenueUsd: '0.000000000000',
      bonusConsumedUsd: '0.028941300000',
      discountRate: '0.000000000000',
      createdAt: '2026-07-15T09:03:00.001Z',
    },
    {
      ...allocationDefaults,
      id: fullAllocationId1,
      balanceTransactionId: fullTransactionId1,
      tokenUsageId: id('b-usage-full-1'),
      balanceGrantId: voucherGrantId,
      source: 'BALANCE_GRANT',
      amountUsd: '0.008336700000',
      recognizedRevenueUsd: '0.000000000000',
      bonusConsumedUsd: '0.008336700000',
      discountRate: '0.000000000000',
      createdAt: '2026-07-15T09:04:00.001Z',
    },
    {
      ...allocationDefaults,
      id: fullAllocationId2,
      balanceTransactionId: fullTransactionId2,
      tokenUsageId: id('b-usage-full-2'),
      balanceGrantId: voucherGrantId,
      source: 'BALANCE_GRANT',
      amountUsd: '0.017340300000',
      recognizedRevenueUsd: '0.000000000000',
      bonusConsumedUsd: '0.017340300000',
      discountRate: '0.000000000000',
      createdAt: '2026-07-15T09:05:00.001Z',
    },
  );
  return {
    userId,
    tenantId,
    voucherGrantId,
    voucherTransactionId,
    openingGrantIds,
    snapshot: {
      billingAccountId,
      accountType: 'personal',
      ledgerStatus: 'LEGACY_DIRTY',
      ledgerVersion: 0,
      walletBalanceUsd: '-0.043071216000',
      transactions,
      grants,
      allocations,
      settlements: [],
      orders: [],
      invoiceItems: [],
      voucherIdempotencyEvidence: [{
        key: id('admin-payg-voucher-historical-key'),
        scope: 'admin:issue-voucher',
        userId,
        status: 'COMMITTED',
        createdAt: '2026-07-15T09:00:59.995Z',
        expiresAt: '2026-08-14T09:01:00.029Z',
        result: {
          transaction: {
            id: voucherTransactionId,
            type: 'ADJUST',
            userId,
            tenantId,
            amountUsd: 100,
            createdAt: '2026-07-15T09:01:00.029Z',
            productId: null,
            amountCents: 10000,
            description: `voucher:${voucherGrantId} admin:repair historical voucher`,
            balanceAfterUsd: 99.918447924,
            balanceAfterCents: 9992,
          },
          grant: {
            id: voucherGrantId,
            source: 'VOUCHER',
            expiresAt: voucherExpiresAt,
            productId: null,
            amountCents: 10000,
            discountRate: 0,
            remainingCents: 10000,
            paidAmountCents: 0,
            bonusAmountCents: 10000,
          },
        },
      }],
      expiryAuditCount: 0,
    },
  };
}

function preIdempotencyVoucherFixture(): LegacyPersonalProofCombinationFixture {
  const suffix = randomUUID();
  const id = (name: string) => `${name}-${suffix}`;
  const userId = id('pre-voucher-user');
  const tenantId = id('pre-voucher-tenant');
  const billingAccountId = id('pre-voucher-account');
  const voucherGrantId = id('pre-voucher-grant');
  const voucherTransactionId = id('pre-voucher-funding');
  const fundedTransactionId = id('pre-voucher-funded-consume');
  const debtTransactionId = id('pre-voucher-debt-consume');
  const commonTransaction = {
    userId,
    tenantId,
    productId: null,
    orderId: null,
    operationKey: null,
    ledgerSequence: null,
  };
  const commonAllocation = {
    billingAccountId,
    userId,
    tenantId,
    productId: null,
    balanceGrantId: voucherGrantId,
    source: 'BALANCE_GRANT',
    recognizedRevenueUsd: '0.000000000000',
    discountRate: '0.000000000000',
    settledUsd: '0.000000000000',
    settledAt: null,
    ledgerSequence: null,
  };
  return {
    userId,
    tenantId,
    voucherGrantId,
    voucherTransactionId,
    openingGrantIds: [],
    snapshot: {
      billingAccountId,
      accountType: 'personal',
      ledgerStatus: 'LEGACY_DIRTY',
      ledgerVersion: 0,
      walletBalanceUsd: '-0.591578080000',
      transactions: [
        {
          ...commonTransaction,
          id: voucherTransactionId,
          ledgerSequence: '-3',
          tokenUsageId: null,
          type: 'ADJUST',
          amountUsd: '100.000000000000',
          balanceAfterUsd: '100.000000000000',
          description: `voucher:${voucherGrantId} admin:operator-a historical voucher`,
          createdAt: '2026-07-15T10:00:00.004Z',
        },
        {
          ...commonTransaction,
          id: fundedTransactionId,
          ledgerSequence: '-2',
          tokenUsageId: id('pre-voucher-funded-usage'),
          type: 'CONSUME',
          amountUsd: '-100.000000000000',
          balanceAfterUsd: '0.000000000000',
          description: 'usage',
          createdAt: '2026-07-15T10:01:00.000Z',
        },
        {
          ...commonTransaction,
          id: debtTransactionId,
          ledgerSequence: '-1',
          tokenUsageId: id('pre-voucher-debt-usage'),
          type: 'CONSUME',
          amountUsd: '-0.591578080000',
          balanceAfterUsd: '-0.591578080000',
          description: 'usage',
          createdAt: '2026-07-15T10:02:00.000Z',
        },
      ],
      grants: [{
        id: voucherGrantId,
        userId,
        tenantId,
        productId: null,
        orderId: null,
        source: 'VOUCHER',
        paidAmountUsd: '0.000000000000',
        bonusAmountUsd: '100.000000000000',
        grantedAmountUsd: '100.000000000000',
        remainingAmountUsd: '0.000000000000',
        remainingPaidAmountUsd: null,
        remainingBonusAmountUsd: null,
        discountRate: '0.000000000000',
        isExpired: false,
        validFrom: '2026-07-15T10:00:00.000Z',
        createdAt: '2026-07-15T10:00:00.001Z',
        expiresAt: '2026-08-14T16:00:00.000Z',
      }],
      allocations: [
        {
          ...commonAllocation,
          id: id('pre-voucher-funded-allocation'),
          balanceTransactionId: fundedTransactionId,
          tokenUsageId: id('pre-voucher-funded-usage'),
          amountUsd: '100.000000000000',
          bonusConsumedUsd: '100.000000000000',
          createdAt: '2026-07-15T10:01:00.001Z',
        },
        {
          ...commonAllocation,
          id: id('pre-voucher-debt-allocation'),
          balanceTransactionId: debtTransactionId,
          tokenUsageId: id('pre-voucher-debt-usage'),
          amountUsd: '0.591578080000',
          bonusConsumedUsd: '0.591578080000',
          createdAt: '2026-07-15T10:02:00.001Z',
        },
      ],
      settlements: [],
      orders: [],
      invoiceItems: [],
      voucherIdempotencyEvidence: [],
      expiryAuditCount: 0,
    },
  };
}

function highPrecisionPersonalDebtFixture(): LegacyPersonalProofCombinationFixture {
  const suffix = randomUUID();
  const id = (name: string) => `${name}-${suffix}`;
  const amount = '99999999.999999999999';
  const userId = id('precision-user');
  const tenantId = id('precision-tenant');
  const billingAccountId = id('precision-account');
  const grantId = id('precision-grant');
  const fundingId = id('precision-funding');
  const fundedConsumeId = id('precision-funded-consume');
  const debtConsumeId = id('precision-debt-consume');
  const commonTransaction = {
    userId,
    tenantId,
    productId: null,
    orderId: null,
  };
  const commonAllocation = {
    billingAccountId,
    userId,
    tenantId,
    productId: null,
    balanceGrantId: grantId,
    source: 'BALANCE_GRANT',
    recognizedRevenueUsd: amount,
    bonusConsumedUsd: '0.000000000000',
    discountRate: '1.000000000000',
    settledUsd: '0.000000000000',
    settledAt: null,
    ledgerSequence: null,
  };
  return {
    userId,
    tenantId,
    voucherGrantId: grantId,
    voucherTransactionId: fundingId,
    openingGrantIds: [],
    snapshot: {
      billingAccountId,
      accountType: 'personal',
      ledgerStatus: 'LEGACY_DIRTY',
      ledgerVersion: 0,
      walletBalanceUsd: `-${amount}`,
      transactions: [
        {
          ...commonTransaction,
          id: fundingId,
          tokenUsageId: null,
          type: 'RECHARGE',
          amountUsd: amount,
          balanceAfterUsd: amount,
          description: 'high precision admin recharge',
          operationKey: `balance:admin-recharge:grant:${grantId}`,
          ledgerSequence: '-3',
          createdAt: '2026-07-15T12:00:00.000Z',
        },
        {
          ...commonTransaction,
          id: fundedConsumeId,
          tokenUsageId: id('precision-funded-usage'),
          type: 'CONSUME',
          amountUsd: `-${amount}`,
          balanceAfterUsd: '0.000000000000',
          description: 'usage',
          operationKey: null,
          ledgerSequence: '-2',
          createdAt: '2026-07-15T12:01:00.000Z',
        },
        {
          ...commonTransaction,
          id: debtConsumeId,
          tokenUsageId: id('precision-debt-usage'),
          type: 'CONSUME',
          amountUsd: `-${amount}`,
          balanceAfterUsd: `-${amount}`,
          description: 'usage',
          operationKey: null,
          ledgerSequence: '-1',
          createdAt: '2026-07-15T12:02:00.000Z',
        },
      ],
      grants: [{
        id: grantId,
        userId,
        tenantId,
        productId: null,
        orderId: null,
        source: 'RECHARGE',
        paidAmountUsd: amount,
        bonusAmountUsd: '0.000000000000',
        grantedAmountUsd: amount,
        remainingAmountUsd: '0.000000000000',
        remainingPaidAmountUsd: null,
        remainingBonusAmountUsd: null,
        discountRate: '1.000000000000',
        isExpired: false,
        validFrom: '2026-07-15T12:00:00.000Z',
        createdAt: '2026-07-15T12:00:00.000Z',
        expiresAt: null,
      }],
      allocations: [
        {
          ...commonAllocation,
          id: id('precision-funded-allocation'),
          balanceTransactionId: fundedConsumeId,
          tokenUsageId: id('precision-funded-usage'),
          amountUsd: amount,
          createdAt: '2026-07-15T12:01:00.001Z',
        },
        {
          ...commonAllocation,
          id: id('precision-debt-allocation'),
          balanceTransactionId: debtConsumeId,
          tokenUsageId: id('precision-debt-usage'),
          amountUsd: amount,
          createdAt: '2026-07-15T12:02:00.001Z',
        },
      ],
      settlements: [],
      orders: [],
      invoiceItems: [],
      voucherIdempotencyEvidence: [],
      expiryAuditCount: 0,
    },
  };
}

type LegacyAdminFundingLinkReplayFixture = {
  snapshot: BalanceLedgerRepairSnapshot;
  userId: string;
  tenantId: string;
  linkedGrantId: string;
  linkedGrantIds: string[];
  firstVirtualGrantId: string;
  allocationIds: string[];
  allocationExpectations: Array<{
    allocationId: string;
    amountUsd: string;
    ledgerSequence: string;
  }>;
};

function legacyAdminFundingLinkReplayFixture(): LegacyAdminFundingLinkReplayFixture {
  const suffix = randomUUID();
  const id = (name: string) => `${name}-${suffix}`;
  const userId = id('uat-admin-user');
  const tenantId = id('uat-admin-tenant');
  const billingAccountId = id('uat-admin-account');
  const debtTransactionId = id('uat-admin-debt-consume');
  const debtAllocationId = id('uat-admin-debt-allocation');
  const transactions: BalanceLedgerRepairSnapshot['transactions'] = [];
  const grants: BalanceLedgerRepairSnapshot['grants'] = [];
  const allocations: BalanceLedgerRepairSnapshot['allocations'] = [];
  const settlements: BalanceLedgerRepairSnapshot['settlements'] = [];
  const evidence: NonNullable<
    BalanceLedgerRepairSnapshot['legacyAdminFundingIdempotencyEvidence']
  > = [];
  const anchor = new Date();
  anchor.setUTCDate(anchor.getUTCDate() - 1);
  anchor.setUTCHours(1, 0, 0, 0);
  const at = (minutes: number, milliseconds = 0): string => (
    new Date(anchor.getTime() + minutes * 60_000 + milliseconds).toISOString()
  );
  let runningBalance = new Prisma.Decimal('-0.1586013');

  transactions.push({
    id: debtTransactionId,
    userId,
    tenantId,
    productId: null,
    tokenUsageId: null,
    type: 'CONSUME',
    amountUsd: '-0.158601300000',
    balanceAfterUsd: '-0.158601300000',
    description: 'usage debt',
    orderId: null,
    operationKey: null,
    ledgerSequence: null,
    createdAt: at(0),
  });
  allocations.push({
    id: debtAllocationId,
    billingAccountId,
    userId,
    tenantId,
    productId: null,
    balanceTransactionId: debtTransactionId,
    tokenUsageId: null,
    balanceGrantId: null,
    source: 'ENTERPRISE_CREDIT',
    amountUsd: '0.158601300000',
    recognizedRevenueUsd: '0.158601300000',
    bonusConsumedUsd: '0.000000000000',
    discountRate: '0.000000000000',
    settledUsd: '0.158601300000',
    settledAt: at(1, 2),
    ledgerSequence: '-6',
    createdAt: at(0, 1),
  });

  const appendFunding = (
    transactionId: string,
    scope: 'admin:adjust-balance' | 'admin:recharge',
    amountUsd: string,
    minute: number,
    description: string,
  ): BalanceLedgerRepairSnapshot['transactions'][number] => {
    runningBalance = runningBalance.plus(amountUsd);
    const createdAt = at(minute);
    const transaction: BalanceLedgerRepairSnapshot['transactions'][number] = {
      id: transactionId,
      userId,
      tenantId,
      productId: null,
      tokenUsageId: null,
      type: scope === 'admin:recharge' ? 'RECHARGE' : 'ADJUST',
      amountUsd: new Prisma.Decimal(amountUsd).toFixed(12),
      balanceAfterUsd: runningBalance.toFixed(12),
      description,
      orderId: null,
      operationKey: null,
      ledgerSequence: null,
      createdAt,
    };
    transactions.push(transaction);
    evidence.push({
      key: `enterprise-recharge:${billingAccountId}:proof-${transactionId}`,
      scope,
      userId,
      status: 'COMMITTED',
      result: {
        id: transactionId,
        userId,
        tenantId,
        productId: null,
        type: transaction.type,
        amountCents: Math.round(Number(transaction.amountUsd) * 100),
        balanceAfterCents: Math.round(Number(transaction.balanceAfterUsd) * 100),
        amountUsd: Number(transaction.amountUsd),
        balanceAfterUsd: Number(transaction.balanceAfterUsd),
        description,
        createdAt,
      },
      createdAt: new Date(new Date(createdAt).getTime() - 1).toISOString(),
      expiresAt: new Date(new Date(createdAt).getTime() + 30 * 86_400_000).toISOString(),
      snapshotSha256: 'a'.repeat(64),
    });
    return transaction;
  };

  const appendLinkedGrant = (
    transaction: BalanceLedgerRepairSnapshot['transactions'][number],
    grantId: string,
    remainingAmountUsd: string,
  ): void => {
    const validFrom = new Date(new Date(transaction.createdAt).getTime() + 2);
    const expiresAt = new Date(validFrom);
    expiresAt.setUTCDate(expiresAt.getUTCDate() + 365);
    grants.push({
      id: grantId,
      userId,
      tenantId,
      productId: null,
      orderId: null,
      source: 'RECHARGE',
      paidAmountUsd: transaction.amountUsd,
      bonusAmountUsd: '0.000000000000',
      grantedAmountUsd: transaction.amountUsd,
      remainingAmountUsd,
      remainingPaidAmountUsd: null,
      remainingBonusAmountUsd: null,
      discountRate: '1.000000000000',
      isExpired: false,
      validFrom: validFrom.toISOString(),
      expiresAt: expiresAt.toISOString(),
      createdAt: new Date(new Date(transaction.createdAt).getTime() + 4).toISOString(),
    });
  };

  const adjustIds = ['1', '2', '2', '2', '2', '3', '2', '1'].map(
    (amount, index) => {
      const transactionId = id(`uat-admin-adjust-${index + 1}`);
      appendFunding(transactionId, 'admin:adjust-balance', amount, index + 1, '线下转账入账');
      return transactionId;
    },
  );
  const debtSettlementId = id('uat-admin-debt-settlement');
  settlements.push({
    id: debtSettlementId,
    billingAccountId,
    allocationId: debtAllocationId,
    repaymentTransactionId: adjustIds[0],
    balanceGrantId: null,
    debtSource: 'ENTERPRISE_CREDIT',
    repairRunId: null,
    operationKey: `legacy:${debtSettlementId}`,
    trigger: 'FUNDING',
    amountUsd: '0.158601300000',
    paidUsd: '0.158601300000',
    bonusUsd: '0.000000000000',
    occurredAt: at(1, 2),
    createdAt: at(1, 2),
  });

  const linkedGrantId = id('uat-admin-recharge-grant-2');
  const linkedTransaction = appendFunding(
    id('uat-admin-recharge-2'),
    'admin:recharge',
    '2',
    10,
    '企业账户管理员充值',
  );
  appendLinkedGrant(linkedTransaction, linkedGrantId, '1.957804000000');

  const misallocatedAmounts = [
    '0.0180264',
    '0.0029428',
    '0.0029624',
    '0.0137312',
    '0.0045332',
  ];
  const allocationIds = misallocatedAmounts.map((amount, index) => {
    runningBalance = runningBalance.minus(amount);
    const transactionId = id(`uat-admin-consume-${index + 1}`);
    const allocationId = id(`uat-admin-misallocated-${index + 1}`);
    transactions.push({
      id: transactionId,
      userId,
      tenantId,
      productId: null,
      tokenUsageId: null,
      type: 'CONSUME',
      amountUsd: new Prisma.Decimal(amount).neg().toFixed(12),
      balanceAfterUsd: runningBalance.toFixed(12),
      description: 'usage',
      orderId: null,
      operationKey: null,
      ledgerSequence: null,
      createdAt: at(index + 11),
    });
    allocations.push({
      id: allocationId,
      billingAccountId,
      userId,
      tenantId,
      productId: null,
      balanceTransactionId: transactionId,
      tokenUsageId: null,
      balanceGrantId: linkedGrantId,
      source: 'BALANCE_GRANT',
      amountUsd: new Prisma.Decimal(amount).toFixed(12),
      recognizedRevenueUsd: new Prisma.Decimal(amount).toFixed(12),
      bonusConsumedUsd: '0.000000000000',
      discountRate: '1.000000000000',
      settledUsd: '0.000000000000',
      settledAt: null,
      ledgerSequence: null,
      createdAt: at(index + 11, 1),
    });
    return allocationId;
  });

  const recharge3 = appendFunding(
    id('uat-admin-recharge-3'),
    'admin:recharge',
    '3',
    16,
    '企业账户管理员充值',
  );
  const linkedGrant3Id = id('uat-admin-recharge-grant-3');
  appendLinkedGrant(recharge3, linkedGrant3Id, '3.000000000000');
  const recharge7 = appendFunding(
    id('uat-admin-recharge-7'),
    'admin:recharge',
    '7',
    17,
    '企业账户管理员充值',
  );
  const linkedGrant7Id = id('uat-admin-recharge-grant-7');
  appendLinkedGrant(recharge7, linkedGrant7Id, '7.000000000000');

  // The latest schema rejects newly inserted NULL transaction sequences even
  // though the real legacy rows are grandfathered by a NOT VALID constraint.
  // Seed their already-proven canonical negative order here; this test is for
  // the independent allocation/grant proof contract, while NULL sequence
  // backfill is exercised by the dedicated sequence integration cases.
  transactions.forEach((transaction, index) => {
    transaction.ledgerSequence = String(index - transactions.length);
  });

  return {
    userId,
    tenantId,
    linkedGrantId,
    linkedGrantIds: [linkedGrantId, linkedGrant3Id, linkedGrant7Id],
    firstVirtualGrantId: `repair-enterprise-admin-funding:${adjustIds[0]}`,
    allocationIds,
    allocationExpectations: allocationIds.map((allocationId, index) => ({
      allocationId,
      amountUsd: new Prisma.Decimal(misallocatedAmounts[index]).toFixed(12),
      ledgerSequence: String(index - allocationIds.length),
    })),
    snapshot: {
      billingAccountId,
      accountType: 'enterprise',
      ledgerStatus: 'LEGACY_DIRTY',
      ledgerVersion: 0,
      walletBalanceUsd: runningBalance.toFixed(12),
      transactions,
      grants,
      allocations,
      settlements,
      orders: [],
      invoiceItems: [],
      voucherIdempotencyEvidence: [],
      legacyAdminFundingIdempotencyEvidence: evidence,
      expiryAuditCount: 0,
    },
  };
}

async function seedMigrationOpeningRetirementFixture(
  prisma: PrismaClient,
  fixture: Pick<MigrationOpeningRetirementFixture, 'snapshot' | 'userId' | 'tenantId'>,
  allowLegacyNullTransactionSequences = false,
): Promise<void> {
  const snapshot = fixture.snapshot;
  await prisma.$transaction(async (tx) => {
    if (allowLegacyNullTransactionSequences) {
      // The production CHECK is NOT VALID specifically so historical NULL
      // sequences can remain until repair.  A fresh integration fixture is a
      // new row, so temporarily remove and transactionally restore the same
      // NOT VALID contract to reproduce that pre-existing legacy state.
      await tx.$executeRawUnsafe(`ALTER TABLE "balance_transactions"
        DROP CONSTRAINT "balance_transactions_ledger_sequence_required_check"`);
    }
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
    await tx.user.create({
      data: {
        id: fixture.userId,
        email: `${fixture.userId}@example.test`,
        nickname: 'Migration opening retirement integration user',
      },
    });
    await tx.billingAccount.create({
      data: {
        id: snapshot.billingAccountId,
        type: snapshot.accountType,
        name: 'Balance ledger repair integration account',
        ownerUserId: fixture.userId,
        status: 'active',
        currency: 'USD',
        balanceGrantLedgerStatus: 'LEGACY_DIRTY',
        balanceGrantLedgerVersion: 0,
      },
    });
    await tx.tenant.create({
      data: {
        id: fixture.tenantId,
        name: 'Balance ledger repair integration tenant',
        type: snapshot.accountType,
        status: 'active',
        ownerUserId: fixture.userId,
        billingAccountId: snapshot.billingAccountId,
        balanceAllowanceUsedUsd: new Prisma.Decimal(0),
      },
    });
    await tx.user.update({
      where: { id: fixture.userId },
      data: { currentTenantId: fixture.tenantId },
    });
    await tx.accountWallet.create({
      data: {
        billingAccountId: snapshot.billingAccountId,
        balanceUsd: new Prisma.Decimal(snapshot.walletBalanceUsd),
      },
    });
    const tokenUsageIds = [...new Set([
      ...snapshot.transactions.map((row) => row.tokenUsageId),
      ...snapshot.allocations.map((row) => row.tokenUsageId),
    ].filter((tokenUsageId): tokenUsageId is string => typeof tokenUsageId === 'string'))];
    if (tokenUsageIds.length > 0) {
      await tx.tokenUsage.createMany({
        data: tokenUsageIds.map((tokenUsageId) => ({
          id: tokenUsageId,
          apiKeyId: `repair-fixture-api-key:${snapshot.billingAccountId}`,
          tenantId: fixture.tenantId,
          productId: null,
          model: 'balance-ledger-repair-integration-fixture',
          promptTokens: 0,
          completionTokens: 0,
          totalTokens: 0,
          inputPriceUsdPerM: new Prisma.Decimal(0),
          outputPriceUsdPerM: new Prisma.Decimal(0),
          costUsd: new Prisma.Decimal(0),
          customerChargeUsd: new Prisma.Decimal(0),
          createdAt: new Date('2026-07-15T10:00:00.000Z'),
        })),
      });
    }
    await tx.balanceTransaction.createMany({
      data: snapshot.transactions.map((row) => ({
        id: row.id,
        operationKey: row.operationKey ?? null,
        userId: row.userId!,
        tenantId: row.tenantId!,
        billingAccountId: snapshot.billingAccountId,
        productId: row.productId ?? null,
        tokenUsageId: row.tokenUsageId ?? null,
        type: row.type as TransactionType,
        amountUsd: new Prisma.Decimal(row.amountUsd),
        balanceAfterUsd: new Prisma.Decimal(row.balanceAfterUsd),
        description: row.description,
        orderId: row.orderId,
        ledgerSequence: row.ledgerSequence == null ? null : BigInt(row.ledgerSequence),
        createdAt: new Date(row.createdAt),
      })),
    });
    await tx.balanceGrant.createMany({
      data: snapshot.grants.map((row) => ({
        id: row.id,
        userId: row.userId!,
        tenantId: row.tenantId!,
        billingAccountId: snapshot.billingAccountId,
        productId: row.productId ?? null,
        orderId: row.orderId,
        source: row.source,
        paidAmountUsd: new Prisma.Decimal(row.paidAmountUsd),
        bonusAmountUsd: new Prisma.Decimal(row.bonusAmountUsd),
        grantedAmountUsd: new Prisma.Decimal(row.grantedAmountUsd),
        remainingAmountUsd: new Prisma.Decimal(row.remainingAmountUsd),
        remainingPaidAmountUsd: row.remainingPaidAmountUsd === null
          ? null
          : new Prisma.Decimal(row.remainingPaidAmountUsd),
        remainingBonusAmountUsd: row.remainingBonusAmountUsd === null
          ? null
          : new Prisma.Decimal(row.remainingBonusAmountUsd),
        discountRate: new Prisma.Decimal(row.discountRate),
        validFrom: new Date(row.validFrom!),
        expiresAt: row.expiresAt === null ? null : new Date(row.expiresAt!),
        isExpired: row.isExpired,
        createdAt: new Date(row.createdAt),
      })),
    });
    await tx.balanceConsumptionAllocation.createMany({
      data: snapshot.allocations.map((row) => ({
        id: row.id,
        userId: row.userId!,
        tenantId: row.tenantId!,
        billingAccountId: snapshot.billingAccountId,
        productId: row.productId ?? null,
        balanceTransactionId: row.balanceTransactionId,
        tokenUsageId: row.tokenUsageId ?? null,
        balanceGrantId: row.balanceGrantId,
        source: row.source,
        amountUsd: new Prisma.Decimal(row.amountUsd),
        recognizedRevenueUsd: new Prisma.Decimal(row.recognizedRevenueUsd),
        bonusConsumedUsd: new Prisma.Decimal(row.bonusConsumedUsd),
        discountRate: new Prisma.Decimal(row.discountRate!),
        settledUsd: new Prisma.Decimal(row.settledUsd),
        settledAt: row.settledAt === null ? null : new Date(row.settledAt),
        ledgerSequence: row.ledgerSequence == null ? null : BigInt(row.ledgerSequence),
        createdAt: new Date(row.createdAt),
      })),
    });
    if (snapshot.settlements.length > 0) {
      await tx.enterpriseCreditSettlement.createMany({
        data: snapshot.settlements.map((row) => ({
          id: row.id,
          billingAccountId: snapshot.billingAccountId,
          allocationId: row.allocationId,
          repaymentTransactionId: row.repaymentTransactionId,
          balanceGrantId: row.balanceGrantId,
          debtSource: row.debtSource,
          repairRunId: row.repairRunId,
          operationKey: row.operationKey,
          trigger: row.trigger,
          amountUsd: new Prisma.Decimal(row.amountUsd),
          paidUsd: new Prisma.Decimal(row.paidUsd),
          bonusUsd: new Prisma.Decimal(row.bonusUsd),
          occurredAt: new Date(row.occurredAt),
          createdAt: new Date(row.createdAt),
        })),
      });
    }
    const idempotencyEvidence = [
      ...snapshot.voucherIdempotencyEvidence,
      ...(snapshot.legacyAdminFundingIdempotencyEvidence ?? []),
    ];
    if (idempotencyEvidence.length > 0) {
      await tx.idempotencyKey.createMany({
        data: idempotencyEvidence.map((row) => ({
          key: row.key,
          scope: row.scope,
          userId: row.userId,
          status: row.status,
          result: row.result as Prisma.InputJsonValue,
          createdAt: new Date(row.createdAt),
          expiresAt: new Date(row.expiresAt),
        })),
      });
    }
    await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'origin'");
    if (allowLegacyNullTransactionSequences) {
      await tx.$executeRawUnsafe(`ALTER TABLE "balance_transactions"
        ADD CONSTRAINT "balance_transactions_ledger_sequence_required_check"
        CHECK ("ledger_sequence" IS NOT NULL AND "ledger_sequence" <> 0) NOT VALID`);
    }
  }, {
    isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
    maxWait: 10_000,
    timeout: 30_000,
  });
}

const EVIDENCE_REPAIR_EXECUTION_PROFILE: BalanceLedgerRepairExecutionProfile = {
  name: null,
  expectedDatabase: null,
  billingAccountIds: null,
  planningProfile: {
    allowLegacyExpiryProofs: true,
    allowLegacyExpiredVoucherProofs: true,
    allowInvoiceStabilityProof: true,
  },
};

const INVOICE_STABILITY_EVIDENCE_EXECUTION_PROFILE = resolveExecutionProfile(
  'invoice-stability-evidence-v1',
);

type LegacyExpiryIntegrationFixture = {
  snapshot: BalanceLedgerRepairSnapshot;
  userId: string;
  tenantId: string;
  grantIds: string[];
  expiryTransactionIds: string[];
};

function legacyExpiryIntegrationFixture(): LegacyExpiryIntegrationFixture {
  const suffix = randomUUID();
  const id = (name: string) => `${name}-${suffix}`;
  const userId = id('legacy-expiry-user');
  const tenantId = id('legacy-expiry-tenant');
  const billingAccountId = id('legacy-expiry-account');
  const grantIds = [id('legacy-expiry-grant-1'), id('legacy-expiry-grant-2'), id('legacy-expiry-grant-3')];
  const fundingIds = [id('legacy-expiry-funding-1'), id('legacy-expiry-funding-2'), id('legacy-expiry-funding-3')];
  const expiryTransactionIds = [id('legacy-expiry-tx-1'), id('legacy-expiry-tx-2'), id('legacy-expiry-tx-3')];
  const consumeId = id('legacy-expiry-consume');
  const usageId = id('legacy-expiry-usage');
  const commonTransaction = {
    userId,
    tenantId,
    productId: null,
    tokenUsageId: null,
    orderId: null,
    ledgerSequence: null,
  };
  const commonGrant = {
    userId,
    tenantId,
    productId: null,
    orderId: null,
    source: 'RECHARGE',
    bonusAmountUsd: '0.000000000000',
    remainingAmountUsd: '0.000000000000',
    remainingPaidAmountUsd: null,
    remainingBonusAmountUsd: null,
    discountRate: '1.000000000000',
    isExpired: true,
  };
  return {
    userId,
    tenantId,
    grantIds,
    expiryTransactionIds,
    snapshot: {
      billingAccountId,
      accountType: 'personal',
      ledgerStatus: 'LEGACY_DIRTY',
      ledgerVersion: 0,
      walletBalanceUsd: '0.000000000000',
      transactions: ([
        {
          ...commonTransaction,
          id: fundingIds[0],
          type: 'RECHARGE',
          amountUsd: '1.000000000000',
          balanceAfterUsd: '1.000000000000',
          description: 'legacy expiry fixture funding 1',
          operationKey: `balance:admin-recharge:grant:${grantIds[0]}`,
          createdAt: '2026-07-19T00:00:00.000Z',
        },
        {
          ...commonTransaction,
          id: consumeId,
          tokenUsageId: usageId,
          type: 'CONSUME',
          amountUsd: '-0.805761547000',
          balanceAfterUsd: '13.194238453000',
          description: 'legacy expiry fixture usage',
          operationKey: null,
          createdAt: '2026-07-19T00:30:00.000Z',
        },
        {
          ...commonTransaction,
          id: expiryTransactionIds[0],
          type: 'ADJUST',
          amountUsd: '-0.194238453000',
          balanceAfterUsd: '13.000000000000',
          description: `balance grant expired:${grantIds[0]}`,
          operationKey: null,
          createdAt: '2026-07-19T00:40:00.000Z',
        },
        {
          ...commonTransaction,
          id: fundingIds[1],
          type: 'RECHARGE',
          amountUsd: '12.000000000000',
          balanceAfterUsd: '13.000000000000',
          description: 'legacy expiry fixture funding 2',
          operationKey: `balance:admin-recharge:grant:${grantIds[1]}`,
          createdAt: '2026-07-19T00:10:00.000Z',
        },
        {
          ...commonTransaction,
          id: expiryTransactionIds[1],
          type: 'ADJUST',
          amountUsd: '-12.000000000000',
          balanceAfterUsd: '1.000000000000',
          description: `balance grant expired:${grantIds[1]}`,
          operationKey: null,
          createdAt: '2026-07-19T00:50:00.000Z',
        },
        {
          ...commonTransaction,
          id: fundingIds[2],
          type: 'RECHARGE',
          amountUsd: '1.000000000000',
          balanceAfterUsd: '14.000000000000',
          description: 'legacy expiry fixture funding 3',
          operationKey: `balance:admin-recharge:grant:${grantIds[2]}`,
          createdAt: '2026-07-19T00:20:00.000Z',
        },
        {
          ...commonTransaction,
          id: expiryTransactionIds[2],
          type: 'ADJUST',
          amountUsd: '-1.000000000000',
          balanceAfterUsd: '0.000000000000',
          description: `balance grant expired:${grantIds[2]}`,
          operationKey: null,
          createdAt: '2026-07-19T01:00:00.000Z',
        },
      ] as BalanceLedgerRepairSnapshot['transactions']).sort(
        (left, right) => left.createdAt.localeCompare(right.createdAt),
      ),
      grants: [
        {
          ...commonGrant,
          id: grantIds[0],
          paidAmountUsd: '1.000000000000',
          grantedAmountUsd: '1.000000000000',
          validFrom: '2026-07-19T00:00:00.000Z',
          expiresAt: '2026-07-19T00:40:00.000Z',
          createdAt: '2026-07-19T00:00:00.000Z',
        },
        {
          ...commonGrant,
          id: grantIds[1],
          paidAmountUsd: '12.000000000000',
          grantedAmountUsd: '12.000000000000',
          validFrom: '2026-07-19T00:10:00.000Z',
          expiresAt: '2026-07-19T00:50:00.000Z',
          createdAt: '2026-07-19T00:10:00.000Z',
        },
        {
          ...commonGrant,
          id: grantIds[2],
          paidAmountUsd: '1.000000000000',
          grantedAmountUsd: '1.000000000000',
          validFrom: '2026-07-19T00:20:00.000Z',
          expiresAt: '2026-07-19T01:00:00.000Z',
          createdAt: '2026-07-19T00:20:00.000Z',
        },
      ],
      allocations: [{
        id: id('legacy-expiry-allocation'),
        billingAccountId,
        userId,
        tenantId,
        productId: null,
        balanceTransactionId: consumeId,
        tokenUsageId: usageId,
        balanceGrantId: grantIds[0],
        source: 'BALANCE_GRANT',
        amountUsd: '0.805761547000',
        recognizedRevenueUsd: '0.805761547000',
        bonusConsumedUsd: '0.000000000000',
        discountRate: '1.000000000000',
        settledUsd: '0.000000000000',
        settledAt: null,
        ledgerSequence: null,
        createdAt: '2026-07-19T00:30:00.001Z',
      }],
      settlements: [],
      orders: [],
      invoiceItems: [],
      voucherIdempotencyEvidence: [],
      expiryAuditCount: 0,
    },
  };
}

type ExpiredVoucherTripleIntegrationFixture = LegacyExpiryIntegrationFixture & {
  postExpiryGrantId: string;
  postExpiryFundingTransactionId: string;
};

function expiredVoucherTripleIntegrationFixture(): ExpiredVoucherTripleIntegrationFixture {
  const fixture = legacyExpiryIntegrationFixture();
  const grants = [...fixture.snapshot.grants]
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  const fundingTransactions = fixture.snapshot.transactions
    .filter((transaction) => transaction.type === 'RECHARGE')
    .sort((left, right) => left.createdAt.localeCompare(right.createdAt));
  expect(fundingTransactions).toHaveLength(grants.length);
  grants.forEach((grant, index) => {
    const funding = fundingTransactions[index];
    const grantCreatedAt = new Date(grant.createdAt).getTime();
    grant.source = 'VOUCHER';
    grant.paidAmountUsd = '0.000000000000';
    grant.bonusAmountUsd = grant.grantedAmountUsd;
    grant.discountRate = '0.000000000000';
    grant.validFrom = new Date(grantCreatedAt - 10).toISOString();
    funding.type = 'ADJUST';
    funding.description = `voucher:${grant.id} admin:operator-${index + 1} triple fixture`;
    funding.operationKey = null;
    funding.createdAt = new Date(grantCreatedAt + 4).toISOString();
  });
  const allocation = fixture.snapshot.allocations[0];
  allocation.recognizedRevenueUsd = '0.000000000000';
  allocation.bonusConsumedUsd = allocation.amountUsd;
  allocation.discountRate = '0.000000000000';

  // Reproduce the HK UAT chronology: an ordinary active recharge was written
  // after all three historical inline expiries.  A legacy expiry audit is
  // backfilled today, so its deferred aggregate must compare the final wallet
  // against the repair observation cut-off, not against the old expiry time.
  const lateRechargeAt = '2026-07-19T02:00:00.000Z';
  const lateGrantId = `post-expiry-active-grant-${randomUUID()}`;
  const lateFundingTransactionId = `post-expiry-active-funding-${randomUUID()}`;
  fixture.snapshot.transactions.push({
    id: lateFundingTransactionId,
    userId: fixture.userId,
    tenantId: fixture.tenantId,
    productId: null,
    tokenUsageId: null,
    type: 'RECHARGE',
    amountUsd: '5.000000000000',
    balanceAfterUsd: '5.000000000000',
    description: 'post-expiry active recharge',
    orderId: null,
    operationKey: `balance:admin-recharge:grant:${lateGrantId}`,
    ledgerSequence: null,
    createdAt: lateRechargeAt,
  });
  fixture.snapshot.transactions.sort(
    (left, right) => left.createdAt.localeCompare(right.createdAt),
  );
  fixture.snapshot.grants.push({
    id: lateGrantId,
    userId: fixture.userId,
    tenantId: fixture.tenantId,
    productId: null,
    orderId: null,
    source: 'RECHARGE',
    paidAmountUsd: '5.000000000000',
    bonusAmountUsd: '0.000000000000',
    grantedAmountUsd: '5.000000000000',
    remainingAmountUsd: '5.000000000000',
    remainingPaidAmountUsd: '5.000000000000',
    remainingBonusAmountUsd: '0.000000000000',
    discountRate: '1.000000000000',
    validFrom: lateRechargeAt,
    expiresAt: null,
    isExpired: false,
    createdAt: lateRechargeAt,
  });
  fixture.snapshot.walletBalanceUsd = '5.000000000000';
  return {
    ...fixture,
    postExpiryGrantId: lateGrantId,
    postExpiryFundingTransactionId: lateFundingTransactionId,
  };
}

type ExpiredVoucherLegacyExpiryIntegrationFixture = {
  snapshot: BalanceLedgerRepairSnapshot;
  userId: string;
  tenantId: string;
  baseGrantId: string;
  baseFundingTransactionId: string;
  voucherGrantId: string;
  voucherFundingTransactionId: string;
  consumeTransactionId: string;
  allocationId: string;
  expiryTransactionId: string;
};

/**
 * Exact pre-idempotency voucher writer shape on a positive wallet, followed by
 * partial bonus consumption and the legacy inline expiry writer.  The voucher
 * cannot be admitted independently: its funding proof and expiry proof form a
 * single, same-run evidence contract.
 */
function expiredVoucherLegacyExpiryIntegrationFixture(
): ExpiredVoucherLegacyExpiryIntegrationFixture {
  const suffix = randomUUID();
  const id = (name: string) => `${name}-${suffix}`;
  const userId = id('expired-voucher-user');
  const tenantId = id('expired-voucher-tenant');
  const billingAccountId = id('expired-voucher-account');
  const baseGrantId = id('expired-voucher-base-grant');
  const baseFundingTransactionId = id('expired-voucher-base-funding');
  const voucherGrantId = id('expired-voucher-grant');
  const voucherFundingTransactionId = id('expired-voucher-funding');
  const consumeTransactionId = id('expired-voucher-consume');
  const allocationId = id('expired-voucher-allocation');
  const expiryTransactionId = id('expired-voucher-expiry');
  const usageId = id('expired-voucher-usage');
  const transactionDefaults = {
    userId,
    tenantId,
    productId: null,
    orderId: null,
    tokenUsageId: null,
  };
  return {
    userId,
    tenantId,
    baseGrantId,
    baseFundingTransactionId,
    voucherGrantId,
    voucherFundingTransactionId,
    consumeTransactionId,
    allocationId,
    expiryTransactionId,
    snapshot: {
      billingAccountId,
      accountType: 'personal',
      ledgerStatus: 'LEGACY_DIRTY',
      ledgerVersion: 0,
      walletBalanceUsd: '10.000000000000',
      transactions: [
        {
          ...transactionDefaults,
          id: baseFundingTransactionId,
          type: 'RECHARGE',
          amountUsd: '10.000000000000',
          balanceAfterUsd: '10.000000000000',
          description: 'expired voucher fixture base recharge',
          operationKey: `balance:admin-recharge:grant:${baseGrantId}`,
          ledgerSequence: null,
          createdAt: '2026-07-19T00:00:00.000Z',
        },
        {
          ...transactionDefaults,
          id: voucherFundingTransactionId,
          type: 'ADJUST',
          amountUsd: '1.000000000000',
          balanceAfterUsd: '11.000000000000',
          description: `voucher:${voucherGrantId} admin:operator-a historical voucher`,
          operationKey: null,
          ledgerSequence: null,
          createdAt: '2026-07-19T00:01:00.004Z',
        },
        {
          ...transactionDefaults,
          id: consumeTransactionId,
          tokenUsageId: usageId,
          type: 'CONSUME',
          amountUsd: '-0.800000000000',
          balanceAfterUsd: '10.200000000000',
          description: 'usage',
          operationKey: null,
          ledgerSequence: null,
          createdAt: '2026-07-19T00:02:00.000Z',
        },
        {
          ...transactionDefaults,
          id: expiryTransactionId,
          type: 'ADJUST',
          amountUsd: '-0.200000000000',
          balanceAfterUsd: '10.000000000000',
          description: `balance grant expired:${voucherGrantId}`,
          operationKey: null,
          ledgerSequence: null,
          createdAt: '2026-07-19T00:08:00.000Z',
        },
      ],
      grants: [
        {
          id: baseGrantId,
          userId,
          tenantId,
          productId: null,
          orderId: null,
          source: 'RECHARGE',
          paidAmountUsd: '10.000000000000',
          bonusAmountUsd: '0.000000000000',
          grantedAmountUsd: '10.000000000000',
          remainingAmountUsd: '10.000000000000',
          remainingPaidAmountUsd: '10.000000000000',
          remainingBonusAmountUsd: '0.000000000000',
          discountRate: '1.000000000000',
          validFrom: '2026-07-19T00:00:00.000Z',
          expiresAt: null,
          isExpired: false,
          createdAt: '2026-07-19T00:00:00.000Z',
        },
        {
          id: voucherGrantId,
          userId,
          tenantId,
          productId: null,
          orderId: null,
          source: 'VOUCHER',
          paidAmountUsd: '0.000000000000',
          bonusAmountUsd: '1.000000000000',
          grantedAmountUsd: '1.000000000000',
          remainingAmountUsd: '0.000000000000',
          remainingPaidAmountUsd: null,
          remainingBonusAmountUsd: null,
          discountRate: '0.000000000000',
          validFrom: '2026-07-19T00:01:00.000Z',
          expiresAt: '2026-07-19T00:03:00.000Z',
          isExpired: true,
          createdAt: '2026-07-19T00:01:00.000Z',
        },
      ],
      allocations: [{
        id: allocationId,
        userId,
        tenantId,
        billingAccountId,
        productId: null,
        balanceTransactionId: consumeTransactionId,
        tokenUsageId: usageId,
        balanceGrantId: voucherGrantId,
        source: 'BALANCE_GRANT',
        amountUsd: '0.800000000000',
        recognizedRevenueUsd: '0.000000000000',
        bonusConsumedUsd: '0.800000000000',
        discountRate: '0.000000000000',
        settledUsd: '0.000000000000',
        settledAt: null,
        ledgerSequence: null,
        createdAt: '2026-07-19T00:02:00.001Z',
      }],
      settlements: [],
      orders: [],
      invoiceItems: [],
      voucherIdempotencyEvidence: [],
      expiryAuditCount: 0,
    },
  };
}

type IssuedInvoiceIntegrationFixture = {
  snapshot: BalanceLedgerRepairSnapshot;
  userId: string;
  tenantId: string;
  orderId: string;
  applicationId: string;
  itemId: string;
  eventId: string;
};

function issuedInvoiceIntegrationFixture(): IssuedInvoiceIntegrationFixture {
  const suffix = randomUUID();
  const id = (name: string) => `${name}-${suffix}`;
  const userId = id('issued-invoice-user');
  const tenantId = id('issued-invoice-tenant');
  const billingAccountId = id('issued-invoice-account');
  const orderId = id('issued-invoice-order');
  const grantId = id('issued-invoice-grant');
  const transactionId = id('issued-invoice-funding');
  return {
    userId,
    tenantId,
    orderId,
    applicationId: id('issued-invoice-application'),
    itemId: id('issued-invoice-item'),
    eventId: id('issued-invoice-event'),
    snapshot: {
      billingAccountId,
      accountType: 'personal',
      ledgerStatus: 'LEGACY_DIRTY',
      ledgerVersion: 0,
      walletBalanceUsd: '5.000000000000',
      transactions: [{
        id: transactionId,
        userId,
        tenantId,
        productId: null,
        tokenUsageId: null,
        type: 'RECHARGE',
        amountUsd: '5.000000000000',
        balanceAfterUsd: '5.000000000000',
        description: 'issued invoice fixture recharge',
        orderId,
        operationKey: `balance:recharge:${orderId}:paid`,
        ledgerSequence: '-1',
        createdAt: '2026-07-19T02:01:01.000Z',
      }],
      grants: [{
        id: grantId,
        userId,
        tenantId,
        productId: null,
        orderId,
        source: 'RECHARGE',
        paidAmountUsd: '5.000000000000',
        bonusAmountUsd: '0.000000000000',
        grantedAmountUsd: '5.000000000000',
        remainingAmountUsd: '5.000000000000',
        remainingPaidAmountUsd: '5.000000000000',
        remainingBonusAmountUsd: '0.000000000000',
        discountRate: '1.000000000000',
        validFrom: '2026-07-19T02:01:01.000Z',
        expiresAt: null,
        isExpired: false,
        createdAt: '2026-07-19T02:01:01.000Z',
      }],
      allocations: [],
      settlements: [],
      orders: [],
      invoiceItems: [],
      voucherIdempotencyEvidence: [],
      expiryAuditCount: 0,
    },
  };
}

async function seedIssuedInvoiceClosure(
  prisma: PrismaClient,
  fixture: IssuedInvoiceIntegrationFixture,
): Promise<void> {
  await seedMigrationOpeningRetirementFixture(prisma, fixture);
  await prisma.$transaction(async (tx) => {
    await tx.order.create({
      data: {
        id: fixture.orderId,
        userId: fixture.userId,
        tenantId: fixture.tenantId,
        billingAccountId: fixture.snapshot.billingAccountId,
        orderType: 'RECHARGE',
        amountCents: 500,
        bonusCents: 0,
        currency: 'usd',
        status: 'COMPLETED',
        paidAt: new Date('2026-07-19T02:01:00.000Z'),
        completedAt: new Date('2026-07-19T02:02:00.000Z'),
        createdAt: new Date('2026-07-19T02:00:00.000Z'),
      },
    });
    await tx.invoiceApplication.create({
      data: {
        id: fixture.applicationId,
        applicationNo: `APP-${fixture.applicationId}`,
        userId: fixture.userId,
        tenantId: fixture.tenantId,
        profileSnapshot: { title: 'Issued invoice stability fixture' },
        currency: 'usd',
        subtotalCents: 500,
        totalCents: 500,
        status: 'ISSUED',
        issuingEntity: 'RAYTONE_HK',
        invoiceNumber: `INV-${fixture.applicationId}`,
        issueDate: new Date('2026-07-19T03:00:00.000Z'),
        dueDate: new Date('2026-08-19T03:00:00.000Z'),
        issuedAt: new Date('2026-07-19T03:01:00.000Z'),
        pdfUrl: `https://example.test/invoices/${fixture.applicationId}.pdf`,
        createdAt: new Date('2026-07-19T02:30:00.000Z'),
        updatedAt: new Date('2026-07-19T03:01:00.000Z'),
      },
    });
    await tx.invoiceApplicationItem.create({
      data: {
        id: fixture.itemId,
        applicationId: fixture.applicationId,
        orderId: fixture.orderId,
        principalCents: 500,
        description: 'RAYTONE_API',
        productName: 'API usage',
        createdAt: new Date('2026-07-19T02:31:00.000Z'),
      },
    });
    await tx.invoiceEventLog.create({
      data: {
        id: fixture.eventId,
        applicationId: fixture.applicationId,
        fromStatus: 'APPROVED_ISSUING',
        toStatus: 'ISSUED',
        actorType: 'SYSTEM',
        actorId: 'invoice-stability-integration',
        reason: 'fixture issued',
        metadata: { immutable: true },
        occurredAt: new Date('2026-07-19T03:01:00.000Z'),
      },
    });
  });
}

async function loadInvoiceEvidenceForTest(
  prisma: PrismaClient,
  billingAccountId: string,
): Promise<BalanceLedgerRepairInvoiceEvidence> {
  const [row] = await prisma.$queryRaw<Array<{
    snapshot: Prisma.JsonValue;
    snapshotSha256: string;
    orderIds: string[];
    applicationIds: string[];
    itemIds: string[];
    eventIds: string[];
    invoiceItemCount: bigint;
    unsafeInvoiceItemCount: bigint;
    invalidApplicationCount: bigint;
  }>>`
    SELECT evidence."evidence_snapshot" AS snapshot,
      evidence."evidence_sha256" AS "snapshotSha256",
      evidence."order_ids" AS "orderIds",
      evidence."application_ids" AS "applicationIds",
      evidence."item_ids" AS "itemIds",
      evidence."event_ids" AS "eventIds",
      evidence."invoice_item_count" AS "invoiceItemCount",
      evidence."unsafe_invoice_item_count" AS "unsafeInvoiceItemCount",
      evidence."invalid_application_count" AS "invalidApplicationCount"
    FROM "balance_ledger_invoice_stability_evidence"(${billingAccountId}) evidence`;
  if (!row) throw new Error('invoice evidence fixture unavailable');
  return {
    orderIds: row.orderIds,
    applicationIds: row.applicationIds,
    itemIds: row.itemIds,
    eventIds: row.eventIds,
    invoiceItemCount: Number(row.invoiceItemCount),
    unsafeInvoiceItemCount: Number(row.unsafeInvoiceItemCount),
    invalidApplicationCount: Number(row.invalidApplicationCount),
    snapshotSha256: row.snapshotSha256,
    snapshot: row.snapshot,
  };
}

async function hydrateInvoiceSnapshotForTest(
  prisma: PrismaClient,
  snapshot: BalanceLedgerRepairSnapshot,
): Promise<BalanceLedgerRepairSnapshot> {
  const orderIds = [...new Set([
    ...snapshot.transactions.map((row) => row.orderId),
    ...snapshot.grants.map((row) => row.orderId),
  ].filter((value): value is string => value !== null))];
  const [orders, invoiceItems, invoiceEvidence] = await Promise.all([
    prisma.order.findMany({
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
    }),
    prisma.invoiceApplicationItem.findMany({
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
    }),
    loadInvoiceEvidenceForTest(prisma, snapshot.billingAccountId),
  ]);
  return {
    ...snapshot,
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
    invoiceEvidence,
  };
}

maybeDescribe('set-based balance ledger repair SQL (integration)', () => {
  let prisma: PrismaClient;

  beforeAll(async () => {
    prisma = new PrismaClient({
      datasources: { db: { url: singleConnectionDatabaseUrl() } },
    });
    await prisma.$connect();
    await assertIsolatedTestDatabase(prisma);
  });

  afterAll(async () => {
    await prisma.$disconnect();
  });

  it('atomically promotes three legacy inline expiries with proof and standard expiry audits', async () => {
    const fixture = legacyExpiryIntegrationFixture();
    await seedMigrationOpeningRetirementFixture(prisma, fixture, true);
    const plan = buildBalanceLedgerRepairPlan(
      fixture.snapshot,
      new Date('2026-07-22T00:00:00.000Z'),
      EVIDENCE_REPAIR_EXECUTION_PROFILE.planningProfile,
    );
    expect(plan).toEqual(expect.objectContaining({
      status: 'READY',
      currentDebtUsd: '0.000000000000',
      legacyExpiryProofMutations: [
        expect.objectContaining({
          grantId: fixture.grantIds[0],
          transactionId: fixture.expiryTransactionIds[0],
          nominalAmountUsd: '0.194238453000',
          nominalPaidUsd: '0.194238453000',
          nominalBonusUsd: '0.000000000000',
        }),
        expect.objectContaining({
          grantId: fixture.grantIds[1],
          transactionId: fixture.expiryTransactionIds[1],
          nominalAmountUsd: '12.000000000000',
        }),
        expect.objectContaining({
          grantId: fixture.grantIds[2],
          transactionId: fixture.expiryTransactionIds[2],
          nominalAmountUsd: '1.000000000000',
        }),
      ],
      invoiceStabilityProof: null,
    }));
    if (plan.status !== 'READY') return;

    const [transactionsBefore, allocationsBefore, walletBefore] = await Promise.all([
      prisma.$queryRaw<Array<{ id: string; immutableSnapshot: Prisma.JsonValue }>>`
        SELECT transaction_row."id",
          to_jsonb(transaction_row) - 'ledger_sequence' AS "immutableSnapshot"
        FROM "balance_transactions" transaction_row
        WHERE transaction_row."billing_account_id" = ${fixture.snapshot.billingAccountId}
        ORDER BY transaction_row."id"`,
      prisma.$queryRaw<Array<{ id: string; immutableSnapshot: Prisma.JsonValue }>>`
        SELECT allocation."id",
          to_jsonb(allocation) - 'ledger_sequence' AS "immutableSnapshot"
        FROM "balance_consumption_allocations" allocation
        WHERE allocation."billing_account_id" = ${fixture.snapshot.billingAccountId}
        ORDER BY allocation."id"`,
      prisma.accountWallet.findUniqueOrThrow({
        where: { billingAccountId: fixture.snapshot.billingAccountId },
        select: { balanceUsd: true },
      }),
    ]);
    const databaseBinding = await loadRepairDatabaseBinding(prisma);
    const runId = `legacy-expiry-integration-run-${randomUUID()}`;
    await prisma.balanceLedgerRepairRun.create({
      data: { id: runId, status: 'RUNNING', planHash: plan.replayHash },
    });

    await expect(applyReadyPlan(
      runId,
      plan,
      databaseBinding,
      prisma,
      {
        financeApprovalRef: 'FIN-LEGACY-EXPIRY-INTEGRATION-001',
        technicalApprovalRef: 'TECH-LEGACY-EXPIRY-INTEGRATION-001',
      },
      EVIDENCE_REPAIR_EXECUTION_PROFILE,
    )).resolves.toBe('APPLIED');

    const [
      account,
      repairAccount,
      proofs,
      expiryAudits,
      grants,
      transactionsAfter,
      allocationsAfter,
      walletAfter,
    ] = await Promise.all([
      prisma.billingAccount.findUniqueOrThrow({
        where: { id: fixture.snapshot.billingAccountId },
        select: { balanceGrantLedgerStatus: true, balanceGrantLedgerVersion: true },
      }),
      prisma.balanceLedgerRepairAccount.findUniqueOrThrow({
        where: {
          runId_billingAccountId: {
            runId,
            billingAccountId: fixture.snapshot.billingAccountId,
          },
        },
      }),
      prisma.$queryRaw<Array<{
        id: string;
        grantId: string;
        transactionId: string;
        expiryAuditId: string;
        nominalAmountUsd: Prisma.Decimal;
        financeApprovalRef: string;
        technicalApprovalRef: string;
      }>>`
        SELECT proof."id", proof."balance_grant_id" AS "grantId",
          proof."balance_transaction_id" AS "transactionId",
          proof."expiry_audit_id" AS "expiryAuditId",
          proof."nominal_amount_usd" AS "nominalAmountUsd",
          proof."finance_approval_ref" AS "financeApprovalRef",
          proof."technical_approval_ref" AS "technicalApprovalRef"
        FROM "balance_ledger_legacy_expiry_repairs" proof
        WHERE proof."run_id" = ${runId}
        ORDER BY proof."balance_grant_id"`,
      prisma.balanceGrantExpiry.findMany({
        where: { billingAccountId: fixture.snapshot.billingAccountId },
        orderBy: { balanceGrantId: 'asc' },
      }),
      prisma.balanceGrant.findMany({
        where: { id: { in: fixture.grantIds } },
        orderBy: { id: 'asc' },
      }),
      prisma.$queryRaw<Array<{
        id: string;
        ledgerSequence: bigint;
        immutableSnapshot: Prisma.JsonValue;
      }>>`
        SELECT transaction_row."id",
          transaction_row."ledger_sequence" AS "ledgerSequence",
          to_jsonb(transaction_row) - 'ledger_sequence' AS "immutableSnapshot"
        FROM "balance_transactions" transaction_row
        WHERE transaction_row."billing_account_id" = ${fixture.snapshot.billingAccountId}
        ORDER BY transaction_row."id"`,
      prisma.$queryRaw<Array<{
        id: string;
        ledgerSequence: bigint;
        immutableSnapshot: Prisma.JsonValue;
      }>>`
        SELECT allocation."id", allocation."ledger_sequence" AS "ledgerSequence",
          to_jsonb(allocation) - 'ledger_sequence' AS "immutableSnapshot"
        FROM "balance_consumption_allocations" allocation
        WHERE allocation."billing_account_id" = ${fixture.snapshot.billingAccountId}
        ORDER BY allocation."id"`,
      prisma.accountWallet.findUniqueOrThrow({
        where: { billingAccountId: fixture.snapshot.billingAccountId },
        select: { balanceUsd: true },
      }),
    ]);

    expect(account).toEqual({
      balanceGrantLedgerStatus: 'RECONCILED_V2',
      balanceGrantLedgerVersion: 2,
    });
    expect(repairAccount.status).toBe('APPLIED');
    expect(proofs).toHaveLength(3);
    expect(proofs.map((proof) => ({
      grantId: proof.grantId,
      transactionId: proof.transactionId,
      expiryAuditId: proof.expiryAuditId,
      nominalAmountUsd: proof.nominalAmountUsd.toFixed(12),
      financeApprovalRef: proof.financeApprovalRef,
      technicalApprovalRef: proof.technicalApprovalRef,
    }))).toEqual(plan.legacyExpiryProofMutations
      .map((mutation) => ({
        grantId: mutation.grantId,
        transactionId: mutation.transactionId,
        expiryAuditId: mutation.expiryAuditId,
        nominalAmountUsd: mutation.nominalAmountUsd,
        financeApprovalRef: 'FIN-LEGACY-EXPIRY-INTEGRATION-001',
        technicalApprovalRef: 'TECH-LEGACY-EXPIRY-INTEGRATION-001',
      }))
      .sort((left, right) => left.grantId.localeCompare(right.grantId)));
    expect(expiryAudits).toHaveLength(3);
    expect(expiryAudits.map((audit) => ({
      id: audit.id,
      grantId: audit.balanceGrantId,
      transactionId: audit.balanceTransactionId,
      nominalAmountUsd: audit.nominalAmountUsd.toFixed(12),
      walletDebitUsd: audit.walletDebitUsd.toFixed(12),
      unbackedAmountUsd: audit.unbackedAmountUsd.toFixed(12),
    }))).toEqual(plan.legacyExpiryProofMutations
      .map((mutation) => ({
        id: mutation.expiryAuditId,
        grantId: mutation.grantId,
        transactionId: mutation.transactionId,
        nominalAmountUsd: mutation.nominalAmountUsd,
        walletDebitUsd: mutation.nominalAmountUsd,
        unbackedAmountUsd: '0.000000000000',
      }))
      .sort((left, right) => left.grantId.localeCompare(right.grantId)));
    for (const grant of grants) {
      expect(grant.remainingAmountUsd.toFixed(12)).toBe('0.000000000000');
      expect(grant.remainingPaidAmountUsd?.toFixed(12)).toBe('0.000000000000');
      expect(grant.remainingBonusAmountUsd?.toFixed(12)).toBe('0.000000000000');
    }
    expect(transactionsAfter.map(({ id, immutableSnapshot }) => ({ id, immutableSnapshot })))
      .toEqual(transactionsBefore);
    expect(transactionsAfter.every((row) => row.ledgerSequence < BigInt(0))).toBe(true);
    expect(allocationsAfter.map(({ id, immutableSnapshot }) => ({ id, immutableSnapshot })))
      .toEqual(allocationsBefore);
    expect(allocationsAfter.every((row) => row.ledgerSequence < BigInt(0))).toBe(true);
    expect(walletAfter.balanceUsd.toFixed(12)).toBe(walletBefore.balanceUsd.toFixed(12));

    await prisma.balanceLedgerRepairRun.update({
      where: { id: runId },
      data: { status: 'COMPLETED', completedAt: new Date('2026-07-22T00:30:00.000Z') },
    });
    const proofValidity = await prisma.$queryRaw<Array<{
      grantId: string;
      valid: boolean;
    }>>`
      SELECT proof."balance_grant_id" AS "grantId",
        "balance_ledger_legacy_expiry_proof_is_valid"(
          proof."balance_grant_id", proof."balance_transaction_id",
          proof."billing_account_id", proof."run_id"
        ) AS valid
      FROM "balance_ledger_legacy_expiry_repairs" proof
      WHERE proof."run_id" = ${runId}
      ORDER BY proof."balance_grant_id"`;
    expect(proofValidity).toEqual(fixture.grantIds
      .sort((left, right) => left.localeCompare(right))
      .map((grantId) => ({ grantId, valid: true })));
    const walletPathIds = transactionsAfter
      .sort((left, right) => Number(left.ledgerSequence - right.ledgerSequence))
      .map((row) => row.id);
    const [canonicalReplay] = await prisma.$queryRaw<Array<{ invoked: boolean }>>`
      SELECT "assert_balance_ledger_canonical_replay"(
        ${fixture.snapshot.billingAccountId}, 'personal', 'NEGATIVE_BALANCE',
        'CREATE', ${runId}, ${walletPathIds}::TEXT[]
      )::TEXT = '' AS invoked`;
    expect(canonicalReplay).toEqual({ invoked: true });
    await expect(hasCommittedAppliedProof(runId, plan, databaseBinding, {
      financeApprovalRef: 'FIN-LEGACY-EXPIRY-INTEGRATION-001',
      technicalApprovalRef: 'TECH-LEGACY-EXPIRY-INTEGRATION-001',
    })).resolves.toBe(true);

    await expect(prisma.$executeRaw`
      UPDATE "balance_ledger_legacy_expiry_repairs"
      SET "finance_approval_ref" = 'FIN-TAMPERED'
      WHERE "id" = ${proofs[0].id}`)
      .rejects.toThrow('balance ledger evidence repair is append-only');
    await expect(prisma.$executeRaw`
      DELETE FROM "balance_ledger_legacy_expiry_repairs"
      WHERE "id" = ${proofs[0].id}`)
      .rejects.toThrow('balance ledger evidence repair is append-only');
  }, GENERIC_REPAIR_TRANSACTION_TIMEOUT_MS + 30_000);

  it('atomically commits three expired-voucher and expiry-proof pairs in one account', async () => {
    const fixture = expiredVoucherTripleIntegrationFixture();
    await seedMigrationOpeningRetirementFixture(prisma, fixture, true);
    const plan = buildBalanceLedgerRepairPlan(
      fixture.snapshot,
      new Date('2026-07-22T00:00:00.000Z'),
      EVIDENCE_REPAIR_EXECUTION_PROFILE.planningProfile,
    );
    expect(plan).toEqual(expect.objectContaining({
      status: 'READY',
      legacyVoucherProofMutations: expect.arrayContaining(fixture.grantIds.map((grantId) => (
        expect.objectContaining({
          repairKind: 'LEGACY_PRE_IDEMPOTENCY_EXPIRED_VOUCHER_V1',
          grantId,
        })
      ))),
      legacyExpiryProofMutations: expect.arrayContaining(fixture.grantIds.map((grantId) => (
        expect.objectContaining({ repairKind: 'LEGACY_INLINE_EXPIRY_V1', grantId })
      ))),
    }));
    if (plan.status !== 'READY') return;
    expect(plan.legacyVoucherProofMutations).toHaveLength(3);
    expect(plan.legacyExpiryProofMutations).toHaveLength(3);
    expect(plan.grantMutations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ grantId: fixture.postExpiryGrantId }),
    ]));

    const databaseBinding = await loadRepairDatabaseBinding(prisma);
    const runId = `expired-voucher-triple-integration-run-${randomUUID()}`;
    const approvalRefs = {
      financeApprovalRef: 'FIN-EXPIRED-VOUCHER-TRIPLE-INTEGRATION-001',
      technicalApprovalRef: 'TECH-EXPIRED-VOUCHER-TRIPLE-INTEGRATION-001',
    };
    await prisma.balanceLedgerRepairRun.create({
      data: { id: runId, status: 'RUNNING', planHash: plan.replayHash },
    });
    await expect(applyReadyPlan(
      runId,
      plan,
      databaseBinding,
      prisma,
      approvalRefs,
      EVIDENCE_REPAIR_EXECUTION_PROFILE,
    )).resolves.toBe('APPLIED');

    const [
      account,
      pairValidity,
      expiryAuditCount,
      receiptRows,
      postExpiryGrant,
      finalLedgerTotals,
      postExpiryFundingTransaction,
    ] = await Promise.all([
      prisma.billingAccount.findUniqueOrThrow({
        where: { id: fixture.snapshot.billingAccountId },
        select: { balanceGrantLedgerStatus: true, balanceGrantLedgerVersion: true },
      }),
      prisma.$queryRaw<Array<{ pairCount: number; allValid: boolean }>>`
        SELECT COUNT(*)::INTEGER AS "pairCount", BOOL_AND(
          "balance_legacy_voucher_funding_is_proven"(
            voucher."billing_account_id", voucher."transaction_id", voucher."grant_id"
          )
          AND "balance_ledger_legacy_expiry_proof_is_valid"(
            expiry."balance_grant_id", expiry."balance_transaction_id",
            expiry."billing_account_id", expiry."run_id"
          )
        ) AS "allValid"
        FROM "balance_ledger_voucher_funding_repairs" voucher
        JOIN "balance_ledger_legacy_expiry_repairs" expiry
          ON expiry."run_id" = voucher."run_id"
          AND expiry."repair_account_id" = voucher."repair_account_id"
          AND expiry."billing_account_id" = voucher."billing_account_id"
          AND expiry."balance_grant_id" = voucher."grant_id"
        WHERE voucher."run_id" = ${runId}`,
      prisma.balanceGrantExpiry.count({
        where: { billingAccountId: fixture.snapshot.billingAccountId },
      }),
      prisma.$queryRaw<Array<{ count: number }>>`
        SELECT COUNT(*)::INTEGER AS count
        FROM "idempotency_keys" evidence
        WHERE evidence."result" #>> '{transaction,id}' IN (
          SELECT transaction_row."id"
          FROM "balance_transactions" transaction_row
          WHERE transaction_row."billing_account_id" = ${fixture.snapshot.billingAccountId}
        )
        OR evidence."result" #>> '{grant,id}' IN (
          SELECT grant_row."id"
          FROM "balance_grants" grant_row
          WHERE grant_row."billing_account_id" = ${fixture.snapshot.billingAccountId}
        )`,
      prisma.balanceGrant.findUniqueOrThrow({
        where: { id: fixture.postExpiryGrantId },
        select: {
          paidAmountUsd: true,
          bonusAmountUsd: true,
          grantedAmountUsd: true,
          remainingAmountUsd: true,
          remainingPaidAmountUsd: true,
          remainingBonusAmountUsd: true,
          isExpired: true,
        },
      }),
      prisma.$queryRaw<Array<{
        walletBalanceUsd: Prisma.Decimal;
        transactionTailUsd: Prisma.Decimal;
        activeGrantUsd: Prisma.Decimal;
      }>>`
        SELECT
          wallet."balance_usd" AS "walletBalanceUsd",
          COALESCE((
            SELECT transaction_row."balance_after_usd"
            FROM "balance_transactions" transaction_row
            WHERE transaction_row."billing_account_id" = account."id"
            ORDER BY transaction_row."ledger_sequence" DESC
            LIMIT 1
          ), 0) AS "transactionTailUsd",
          COALESCE((
            SELECT SUM(grant_row."remaining_amount_usd")
            FROM "balance_grants" grant_row
            WHERE grant_row."billing_account_id" = account."id"
              AND NOT grant_row."is_expired"
              AND grant_row."valid_from" <= account."balance_grant_ledger_reconciled_at"
          ), 0) AS "activeGrantUsd"
        FROM "billing_accounts" account
        JOIN "account_wallets" wallet
          ON wallet."billing_account_id" = account."id"
        WHERE account."id" = ${fixture.snapshot.billingAccountId}`,
      prisma.balanceTransaction.findUniqueOrThrow({
        where: { id: fixture.postExpiryFundingTransactionId },
        select: {
          type: true,
          amountUsd: true,
          balanceAfterUsd: true,
          operationKey: true,
        },
      }),
    ]);
    expect(account).toEqual({
      balanceGrantLedgerStatus: 'RECONCILED_V2',
      balanceGrantLedgerVersion: 2,
    });
    expect(pairValidity).toEqual([{ pairCount: 3, allValid: true }]);
    expect(expiryAuditCount).toBe(3);
    expect(receiptRows).toEqual([{ count: 0 }]);
    expect({
      paidAmountUsd: postExpiryGrant.paidAmountUsd.toFixed(12),
      bonusAmountUsd: postExpiryGrant.bonusAmountUsd.toFixed(12),
      grantedAmountUsd: postExpiryGrant.grantedAmountUsd.toFixed(12),
      remainingAmountUsd: postExpiryGrant.remainingAmountUsd.toFixed(12),
      remainingPaidAmountUsd: postExpiryGrant.remainingPaidAmountUsd?.toFixed(12),
      remainingBonusAmountUsd: postExpiryGrant.remainingBonusAmountUsd?.toFixed(12),
      isExpired: postExpiryGrant.isExpired,
    }).toEqual({
      paidAmountUsd: '5.000000000000',
      bonusAmountUsd: '0.000000000000',
      grantedAmountUsd: '5.000000000000',
      remainingAmountUsd: '5.000000000000',
      remainingPaidAmountUsd: '5.000000000000',
      remainingBonusAmountUsd: '0.000000000000',
      isExpired: false,
    });
    expect(finalLedgerTotals.map((row) => ({
      walletBalanceUsd: row.walletBalanceUsd.toFixed(12),
      transactionTailUsd: row.transactionTailUsd.toFixed(12),
      activeGrantUsd: row.activeGrantUsd.toFixed(12),
    }))).toEqual([{
      walletBalanceUsd: '5.000000000000',
      transactionTailUsd: '5.000000000000',
      activeGrantUsd: '5.000000000000',
    }]);
    expect({
      type: postExpiryFundingTransaction.type,
      amountUsd: postExpiryFundingTransaction.amountUsd.toFixed(12),
      balanceAfterUsd: postExpiryFundingTransaction.balanceAfterUsd.toFixed(12),
      operationKey: postExpiryFundingTransaction.operationKey,
    }).toEqual({
      type: 'RECHARGE',
      amountUsd: '5.000000000000',
      balanceAfterUsd: '5.000000000000',
      operationKey: `balance:admin-recharge:grant:${fixture.postExpiryGrantId}`,
    });
    await expect(hasCommittedAppliedProof(
      runId,
      plan,
      databaseBinding,
      approvalRefs,
    )).resolves.toBe(true);
  }, GENERIC_REPAIR_TRANSACTION_TIMEOUT_MS + 30_000);

  it('rejects the post-expiry active grant repair when a terminal legacy-expiry proof is removed', async () => {
    const fixture = expiredVoucherTripleIntegrationFixture();
    await seedMigrationOpeningRetirementFixture(prisma, fixture, true);
    const plan = buildBalanceLedgerRepairPlan(
      fixture.snapshot,
      new Date('2026-07-22T00:00:00.000Z'),
      EVIDENCE_REPAIR_EXECUTION_PROFILE.planningProfile,
    );
    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;

    const databaseBinding = await loadRepairDatabaseBinding(prisma);
    const runId = `missing-legacy-expiry-proof-clock-run-${randomUUID()}`;
    const approvalRefs = {
      financeApprovalRef: 'FIN-MISSING-LEGACY-EXPIRY-PROOF-CLOCK-001',
      technicalApprovalRef: 'TECH-MISSING-LEGACY-EXPIRY-PROOF-CLOCK-001',
    };
    await prisma.balanceLedgerRepairRun.create({
      data: { id: runId, status: 'RUNNING', planHash: plan.replayHash },
    });

    // Complete the real production apply inside its normal Serializable
    // transaction, then remove exactly one terminal legacy-expiry proof while
    // preserving its standard expiry audit and every other terminal row. The
    // aggregate constraint must stop treating this as a proof-backed historic
    // replay: it falls back to the online expiry contract and rejects the
    // negative-sequence/null-operation legacy row. Keeping the late active
    // recharge in this fixture also proves that the repair-only clock cannot
    // be obtained merely from the account's RECONCILED_V2 terminal state.
    const missingTerminalProofClient = {
      $transaction: async (
        callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options?: {
          isolationLevel?: Prisma.TransactionIsolationLevel;
          maxWait?: number;
          timeout?: number;
        },
      ) => prisma.$transaction(async (tx) => {
        const result = await callback(tx);
        expect(result).toBe('APPLIED');
        const removedProof = await tx.balanceLedgerLegacyExpiryRepair.findFirstOrThrow({
          where: {
            runId,
            balanceGrantId: fixture.grantIds[0],
          },
          select: {
            id: true,
            balanceGrantId: true,
            balanceTransactionId: true,
            billingAccountId: true,
          },
        });
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
        try {
          await tx.balanceLedgerLegacyExpiryRepair.delete({
            where: { id: removedProof.id },
          });
        } finally {
          await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'origin'");
        }
        const [proofState] = await tx.$queryRaw<Array<{ valid: boolean }>>`
          SELECT "balance_ledger_legacy_expiry_proof_is_valid"(
            ${removedProof.balanceGrantId},
            ${removedProof.balanceTransactionId},
            ${removedProof.billingAccountId},
            ${runId}
          ) AS valid`;
        expect(proofState).toEqual({ valid: false });
        await tx.$executeRawUnsafe(
          'SET CONSTRAINTS "balance_grant_expiries_aggregate_deferred" IMMEDIATE',
        );
        return result;
      }, options),
    } as unknown as PrismaClient;

    await expect(applyReadyPlan(
      runId,
      plan,
      databaseBinding,
      missingTerminalProofClient,
      approvalRefs,
      EVIDENCE_REPAIR_EXECUTION_PROFILE,
    )).rejects.toThrow(
      `balance grant expiry aggregate invalid grant=${fixture.grantIds[0]}`,
    );

    const [
      account,
      wallet,
      activeGrantAggregate,
      nullComponentExpiredGrantCount,
      sequencedTransactionCount,
      sequencedAllocationCount,
      repairAccountCount,
      voucherProofCount,
      expiryProofCount,
      expiryAuditCount,
      transactionRepairCount,
      allocationRepairCount,
    ] = await Promise.all([
      prisma.billingAccount.findUniqueOrThrow({
        where: { id: fixture.snapshot.billingAccountId },
        select: {
          balanceGrantLedgerStatus: true,
          balanceGrantLedgerVersion: true,
          balanceGrantLedgerHash: true,
          balanceGrantLedgerReconciledAt: true,
        },
      }),
      prisma.accountWallet.findUniqueOrThrow({
        where: { billingAccountId: fixture.snapshot.billingAccountId },
        select: { balanceUsd: true },
      }),
      prisma.balanceGrant.aggregate({
        where: {
          billingAccountId: fixture.snapshot.billingAccountId,
          isExpired: false,
        },
        _sum: { remainingAmountUsd: true },
      }),
      prisma.balanceGrant.count({
        where: {
          billingAccountId: fixture.snapshot.billingAccountId,
          isExpired: true,
          remainingPaidAmountUsd: null,
          remainingBonusAmountUsd: null,
        },
      }),
      prisma.balanceTransaction.count({
        where: {
          billingAccountId: fixture.snapshot.billingAccountId,
          ledgerSequence: { not: null },
        },
      }),
      prisma.balanceConsumptionAllocation.count({
        where: {
          billingAccountId: fixture.snapshot.billingAccountId,
          ledgerSequence: { not: null },
        },
      }),
      prisma.balanceLedgerRepairAccount.count({ where: { runId } }),
      prisma.balanceLedgerVoucherFundingRepair.count({ where: { runId } }),
      prisma.balanceLedgerLegacyExpiryRepair.count({ where: { runId } }),
      prisma.balanceGrantExpiry.count({
        where: { billingAccountId: fixture.snapshot.billingAccountId },
      }),
      prisma.balanceLedgerTransactionRepair.count({ where: { runId } }),
      prisma.balanceLedgerAllocationRepair.count({ where: { runId } }),
    ]);
    expect(account).toEqual({
      balanceGrantLedgerStatus: 'LEGACY_DIRTY',
      balanceGrantLedgerVersion: 0,
      balanceGrantLedgerHash: null,
      balanceGrantLedgerReconciledAt: null,
    });
    expect(wallet.balanceUsd.toFixed(12)).toBe('5.000000000000');
    expect(activeGrantAggregate._sum.remainingAmountUsd?.toFixed(12)).toBe(
      '5.000000000000',
    );
    expect(nullComponentExpiredGrantCount).toBe(3);
    expect({
      sequencedTransactionCount,
      sequencedAllocationCount,
      repairAccountCount,
      voucherProofCount,
      expiryProofCount,
      expiryAuditCount,
      transactionRepairCount,
      allocationRepairCount,
    }).toEqual({
      sequencedTransactionCount: 0,
      sequencedAllocationCount: 0,
      repairAccountCount: 0,
      voucherProofCount: 0,
      expiryProofCount: 0,
      expiryAuditCount: 0,
      transactionRepairCount: 0,
      allocationRepairCount: 0,
    });
  }, GENERIC_REPAIR_TRANSACTION_TIMEOUT_MS + 30_000);

  it('atomically proves and applies a positive-wallet expired voucher with its paired legacy expiry', async () => {
    const fixture = expiredVoucherLegacyExpiryIntegrationFixture();
    await seedMigrationOpeningRetirementFixture(prisma, fixture, true);
    const plan = buildBalanceLedgerRepairPlan(
      fixture.snapshot,
      new Date('2026-07-22T00:00:00.000Z'),
      EVIDENCE_REPAIR_EXECUTION_PROFILE.planningProfile,
    );
    expect(plan).toEqual(expect.objectContaining({
      status: 'READY',
      currentDebtUsd: '0.000000000000',
      legacyVoucherProofMutations: [expect.objectContaining({
        repairKind: 'LEGACY_PRE_IDEMPOTENCY_EXPIRED_VOUCHER_V1',
        transactionId: fixture.voucherFundingTransactionId,
        grantId: fixture.voucherGrantId,
        walletBeforeUsd: '10.000000000000',
        holeFillUsd: '0.000000000000',
        expectedIdempotencyEvidence: [],
      })],
      legacyExpiryProofMutations: [expect.objectContaining({
        repairKind: 'LEGACY_INLINE_EXPIRY_V1',
        grantId: fixture.voucherGrantId,
        transactionId: fixture.expiryTransactionId,
        nominalAmountUsd: '0.200000000000',
        nominalPaidUsd: '0.000000000000',
        nominalBonusUsd: '0.200000000000',
      })],
      grantMutations: [expect.objectContaining({
        grantId: fixture.voucherGrantId,
        expectedRemainingAmountUsd: '0.000000000000',
        expectedRemainingPaidAmountUsd: null,
        expectedRemainingBonusAmountUsd: null,
        remainingAmountUsd: '0.000000000000',
        remainingPaidAmountUsd: '0.000000000000',
        remainingBonusAmountUsd: '0.000000000000',
      })],
    }));
    if (plan.status !== 'READY') return;

    const databaseBinding = await loadRepairDatabaseBinding(prisma);
    const runId = `expired-voucher-expiry-integration-run-${randomUUID()}`;
    await prisma.balanceLedgerRepairRun.create({
      data: { id: runId, status: 'RUNNING', planHash: plan.replayHash },
    });

    await expect(applyReadyPlan(
      runId,
      plan,
      databaseBinding,
      prisma,
      {
        financeApprovalRef: 'FIN-EXPIRED-VOUCHER-EXPIRY-INTEGRATION-001',
        technicalApprovalRef: 'TECH-EXPIRED-VOUCHER-EXPIRY-INTEGRATION-001',
      },
      EVIDENCE_REPAIR_EXECUTION_PROFILE,
    )).resolves.toBe('APPLIED');

    await prisma.balanceLedgerRepairRun.update({
      where: { id: runId },
      data: { status: 'COMPLETED', completedAt: new Date('2026-07-22T00:30:00.000Z') },
    });
    const [
      account,
      repairAccount,
      voucherProofs,
      expiryProofs,
      expiryAudits,
      receiptCount,
      settlementCount,
      transactions,
      grants,
      allocation,
      wallet,
      proofValidity,
    ] = await Promise.all([
      prisma.billingAccount.findUniqueOrThrow({
        where: { id: fixture.snapshot.billingAccountId },
        select: { balanceGrantLedgerStatus: true, balanceGrantLedgerVersion: true },
      }),
      prisma.balanceLedgerRepairAccount.findUniqueOrThrow({
        where: {
          runId_billingAccountId: {
            runId,
            billingAccountId: fixture.snapshot.billingAccountId,
          },
        },
      }),
      prisma.$queryRaw<Array<{
        repairKind: string;
        transactionId: string;
        grantId: string;
        walletBeforeUsd: Prisma.Decimal;
        holeFillUsd: Prisma.Decimal;
      }>>`
        SELECT proof."repair_kind" AS "repairKind",
          proof."transaction_id" AS "transactionId", proof."grant_id" AS "grantId",
          proof."wallet_before_usd" AS "walletBeforeUsd",
          proof."hole_fill_usd" AS "holeFillUsd"
        FROM "balance_ledger_voucher_funding_repairs" proof
        WHERE proof."run_id" = ${runId}`,
      prisma.balanceLedgerLegacyExpiryRepair.findMany({ where: { runId } }),
      prisma.balanceGrantExpiry.findMany({
        where: { billingAccountId: fixture.snapshot.billingAccountId },
      }),
      prisma.idempotencyKey.count({
        where: {
          scope: 'admin:issue-voucher',
          OR: [
            {
              result: {
                path: ['transaction', 'id'],
                equals: fixture.voucherFundingTransactionId,
              },
            },
            { result: { path: ['grant', 'id'], equals: fixture.voucherGrantId } },
          ],
        },
      }),
      prisma.enterpriseCreditSettlement.count({ where: { repairRunId: runId } }),
      prisma.balanceTransaction.findMany({
        where: { billingAccountId: fixture.snapshot.billingAccountId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          type: true,
          amountUsd: true,
          balanceAfterUsd: true,
          description: true,
        },
      }),
      prisma.balanceGrant.findMany({
        where: { billingAccountId: fixture.snapshot.billingAccountId },
        orderBy: { createdAt: 'asc' },
        select: {
          id: true,
          source: true,
          paidAmountUsd: true,
          bonusAmountUsd: true,
          grantedAmountUsd: true,
          remainingAmountUsd: true,
          remainingPaidAmountUsd: true,
          remainingBonusAmountUsd: true,
          discountRate: true,
          isExpired: true,
        },
      }),
      prisma.balanceConsumptionAllocation.findUniqueOrThrow({
        where: { id: fixture.allocationId },
        select: {
          balanceGrantId: true,
          source: true,
          amountUsd: true,
          recognizedRevenueUsd: true,
          bonusConsumedUsd: true,
          discountRate: true,
        },
      }),
      prisma.accountWallet.findUniqueOrThrow({
        where: { billingAccountId: fixture.snapshot.billingAccountId },
        select: { balanceUsd: true },
      }),
      prisma.$queryRaw<Array<{ voucherValid: boolean; expiryValid: boolean }>>`
        SELECT
          "balance_legacy_voucher_funding_is_proven"(
            ${fixture.snapshot.billingAccountId},
            ${fixture.voucherFundingTransactionId},
            ${fixture.voucherGrantId}
          ) AS "voucherValid",
          "balance_ledger_legacy_expiry_proof_is_valid"(
            ${fixture.voucherGrantId}, ${fixture.expiryTransactionId},
            ${fixture.snapshot.billingAccountId}, ${runId}
          ) AS "expiryValid"`,
    ]);

    expect(account).toEqual({
      balanceGrantLedgerStatus: 'RECONCILED_V2',
      balanceGrantLedgerVersion: 2,
    });
    expect(repairAccount.status).toBe('APPLIED');
    expect(voucherProofs).toEqual([{
      repairKind: 'LEGACY_PRE_IDEMPOTENCY_EXPIRED_VOUCHER_V1',
      transactionId: fixture.voucherFundingTransactionId,
      grantId: fixture.voucherGrantId,
      walletBeforeUsd: new Prisma.Decimal('10.000000000000'),
      holeFillUsd: new Prisma.Decimal('0.000000000000'),
    }]);
    expect(expiryProofs).toHaveLength(1);
    expect(expiryProofs[0]).toEqual(expect.objectContaining({
      balanceGrantId: fixture.voucherGrantId,
      balanceTransactionId: fixture.expiryTransactionId,
      repairKind: 'LEGACY_INLINE_EXPIRY_V1',
    }));
    expect(expiryProofs[0].nominalAmountUsd.toFixed(12)).toBe('0.200000000000');
    expect(expiryProofs[0].nominalPaidUsd.toFixed(12)).toBe('0.000000000000');
    expect(expiryProofs[0].nominalBonusUsd.toFixed(12)).toBe('0.200000000000');
    expect(expiryAudits).toHaveLength(1);
    expect(expiryAudits[0]).toEqual(expect.objectContaining({
      balanceGrantId: fixture.voucherGrantId,
      balanceTransactionId: fixture.expiryTransactionId,
    }));
    expect(expiryAudits[0].nominalAmountUsd.toFixed(12)).toBe('0.200000000000');
    expect(expiryAudits[0].walletDebitUsd.toFixed(12)).toBe('0.200000000000');
    expect(expiryAudits[0].unbackedAmountUsd.toFixed(12)).toBe('0.000000000000');
    expect(receiptCount).toBe(0);
    expect(settlementCount).toBe(0);
    expect(transactions.map((transaction) => ({
      id: transaction.id,
      type: transaction.type,
      amountUsd: transaction.amountUsd.toFixed(12),
      balanceAfterUsd: transaction.balanceAfterUsd.toFixed(12),
      description: transaction.description,
    }))).toEqual(fixture.snapshot.transactions.map((transaction) => ({
      id: transaction.id,
      type: transaction.type,
      amountUsd: transaction.amountUsd,
      balanceAfterUsd: transaction.balanceAfterUsd,
      description: transaction.description,
    })));
    expect(grants.map((grant) => ({
      id: grant.id,
      source: grant.source,
      paidAmountUsd: grant.paidAmountUsd.toFixed(12),
      bonusAmountUsd: grant.bonusAmountUsd.toFixed(12),
      grantedAmountUsd: grant.grantedAmountUsd.toFixed(12),
      remainingAmountUsd: grant.remainingAmountUsd.toFixed(12),
      remainingPaidAmountUsd: grant.remainingPaidAmountUsd?.toFixed(12) ?? null,
      remainingBonusAmountUsd: grant.remainingBonusAmountUsd?.toFixed(12) ?? null,
      discountRate: grant.discountRate.toFixed(12),
      isExpired: grant.isExpired,
    }))).toEqual(fixture.snapshot.grants.map((grant) => ({
      id: grant.id,
      source: grant.source,
      paidAmountUsd: grant.paidAmountUsd,
      bonusAmountUsd: grant.bonusAmountUsd,
      grantedAmountUsd: grant.grantedAmountUsd,
      remainingAmountUsd: grant.remainingAmountUsd,
      remainingPaidAmountUsd: grant.id === fixture.voucherGrantId
        ? '0.000000000000'
        : grant.remainingPaidAmountUsd,
      remainingBonusAmountUsd: grant.id === fixture.voucherGrantId
        ? '0.000000000000'
        : grant.remainingBonusAmountUsd,
      discountRate: grant.discountRate,
      isExpired: grant.isExpired,
    })));
    expect(allocation).toEqual(expect.objectContaining({
      balanceGrantId: fixture.voucherGrantId,
      source: 'BALANCE_GRANT',
    }));
    expect(allocation.amountUsd.toFixed(12)).toBe('0.800000000000');
    expect(allocation.recognizedRevenueUsd.toFixed(12)).toBe('0.000000000000');
    expect(allocation.bonusConsumedUsd.toFixed(12)).toBe('0.800000000000');
    expect(allocation.discountRate.toFixed(12)).toBe('0.000000000000');
    expect(wallet.balanceUsd.toFixed(12)).toBe('10.000000000000');
    expect(proofValidity).toEqual([{ voucherValid: true, expiryValid: true }]);
    await expect(hasCommittedAppliedProof(runId, plan, databaseBinding, {
      financeApprovalRef: 'FIN-EXPIRED-VOUCHER-EXPIRY-INTEGRATION-001',
      technicalApprovalRef: 'TECH-EXPIRED-VOUCHER-EXPIRY-INTEGRATION-001',
    })).resolves.toBe(true);
  }, GENERIC_REPAIR_TRANSACTION_TIMEOUT_MS + 30_000);

  it('rejects and rolls back an expired-voucher proof without its same-run expiry proof', async () => {
    const fixture = expiredVoucherLegacyExpiryIntegrationFixture();
    await seedMigrationOpeningRetirementFixture(prisma, fixture, true);
    const plan = buildBalanceLedgerRepairPlan(
      fixture.snapshot,
      new Date('2026-07-22T00:00:00.000Z'),
      EVIDENCE_REPAIR_EXECUTION_PROFILE.planningProfile,
    );
    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    const runId = `unpaired-expired-voucher-proof-run-${randomUUID()}`;

    await expect(prisma.$transaction(async (tx) => {
      await tx.balanceLedgerRepairRun.create({
        data: { id: runId, status: 'RUNNING', planHash: plan.replayHash },
      });
      const repairAccount = await tx.balanceLedgerRepairAccount.create({
        data: {
          runId,
          billingAccountId: fixture.snapshot.billingAccountId,
          status: 'RUNNING',
          preconditionHash: plan.preconditionHash,
          replayHash: plan.replayHash,
          beforeSnapshot: fixture.snapshot as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.$executeRaw`
        SELECT set_config('billing.balance_ledger_repair_run_id', ${runId}, TRUE)`;
      await registerLegacyVoucherFundingProofsSetBased(
        tx,
        runId,
        repairAccount.id,
        fixture.snapshot.billingAccountId,
        plan.legacyVoucherProofMutations,
        {
          financeApprovalRef: 'FIN-UNPAIRED-EXPIRED-VOUCHER-001',
          technicalApprovalRef: 'TECH-UNPAIRED-EXPIRED-VOUCHER-001',
        },
      );
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: GENERIC_REPAIR_TRANSACTION_TIMEOUT_MS,
    })).rejects.toThrow();

    const [runCount, repairAccountCount, proofCount, account] = await Promise.all([
      prisma.balanceLedgerRepairRun.count({ where: { id: runId } }),
      prisma.balanceLedgerRepairAccount.count({ where: { runId } }),
      prisma.balanceLedgerVoucherFundingRepair.count({ where: { runId } }),
      prisma.billingAccount.findUniqueOrThrow({
        where: { id: fixture.snapshot.billingAccountId },
        select: { balanceGrantLedgerStatus: true, balanceGrantLedgerVersion: true },
      }),
    ]);
    expect(runCount).toBe(0);
    expect(repairAccountCount).toBe(0);
    expect(proofCount).toBe(0);
    expect(account).toEqual({
      balanceGrantLedgerStatus: 'LEGACY_DIRTY',
      balanceGrantLedgerVersion: 0,
    });
  }, GENERIC_REPAIR_TRANSACTION_TIMEOUT_MS + 30_000);

  it('rolls back paired raw proofs when the terminal expiry audit is missing', async () => {
    const fixture = expiredVoucherLegacyExpiryIntegrationFixture();
    await seedMigrationOpeningRetirementFixture(prisma, fixture, true);
    const plan = buildBalanceLedgerRepairPlan(
      fixture.snapshot,
      new Date('2026-07-22T00:00:00.000Z'),
      EVIDENCE_REPAIR_EXECUTION_PROFILE.planningProfile,
    );
    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    const runId = `unterminated-expired-voucher-proof-run-${randomUUID()}`;
    const approvalRefs = {
      financeApprovalRef: 'FIN-UNTERMINATED-EXPIRED-VOUCHER-001',
      technicalApprovalRef: 'TECH-UNTERMINATED-EXPIRED-VOUCHER-001',
    };
    const databaseBinding = await loadRepairDatabaseBinding(prisma);
    await prisma.balanceLedgerRepairRun.create({
      data: { id: runId, status: 'RUNNING', planHash: plan.replayHash },
    });

    // Exercise the complete production apply path first. The transaction
    // facade then removes only the standard expiry audit while leaving every
    // mutation, terminal snapshot, APPLIED marker, and RECONCILED_V2 promotion
    // in place. Forcing the voucher constraint immediately proves that the
    // proof/audit pair itself is the rejecting invariant, not another missing
    // terminal condition. The outer transaction rolls the deliberate audit
    // deletion and the whole repair back together.
    const missingExpiryAuditClient = {
      $transaction: async (
        callback: (tx: Prisma.TransactionClient) => Promise<unknown>,
        options?: {
          isolationLevel?: Prisma.TransactionIsolationLevel;
          maxWait?: number;
          timeout?: number;
        },
      ) => prisma.$transaction(async (tx) => {
        const result = await callback(tx);
        expect(result).toBe('APPLIED');
        const voucherProof = await tx.balanceLedgerVoucherFundingRepair.findFirstOrThrow({
          where: { runId },
          select: {
            repairAccountId: true,
            billingAccountId: true,
            grantId: true,
            financeApprovalRef: true,
            technicalApprovalRef: true,
          },
        });
        await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'replica'");
        try {
          await tx.balanceGrantExpiry.delete({
            where: { id: plan.legacyExpiryProofMutations[0].expiryAuditId },
          });
        } finally {
          await tx.$executeRawUnsafe("SET LOCAL session_replication_role = 'origin'");
        }
        const [pair] = await tx.$queryRaw<Array<{ valid: boolean }>>`
          SELECT "balance_ledger_voucher_expiry_pair_is_valid"(
            ${runId},
            ${voucherProof.repairAccountId},
            ${voucherProof.billingAccountId},
            ${voucherProof.grantId},
            ${voucherProof.financeApprovalRef},
            ${voucherProof.technicalApprovalRef},
            TRUE
          ) AS valid`;
        expect(pair).toEqual({ valid: false });
        await tx.$executeRawUnsafe(
          'SET CONSTRAINTS "balance_voucher_proofs_terminal_deferred" IMMEDIATE',
        );
        return result;
      }, options),
    } as unknown as PrismaClient;

    await expect(applyReadyPlan(
      runId,
      plan,
      databaseBinding,
      missingExpiryAuditClient,
      approvalRefs,
      EVIDENCE_REPAIR_EXECUTION_PROFILE,
    )).rejects.toThrow(
      'legacy voucher proof cannot commit before exact canonical promotion',
    );

    const [runCount, repairAccountCount, voucherProofCount, expiryProofCount] = await Promise.all([
      prisma.balanceLedgerRepairRun.count({ where: { id: runId } }),
      prisma.balanceLedgerRepairAccount.count({ where: { runId } }),
      prisma.balanceLedgerVoucherFundingRepair.count({ where: { runId } }),
      prisma.balanceLedgerLegacyExpiryRepair.count({ where: { runId } }),
    ]);
    expect({ runCount, repairAccountCount, voucherProofCount, expiryProofCount }).toEqual({
      runCount: 1,
      repairAccountCount: 0,
      voucherProofCount: 0,
      expiryProofCount: 0,
    });
  }, GENERIC_REPAIR_TRANSACTION_TIMEOUT_MS + 30_000);

  it.each([
    ['wrong-user transaction-only', 'admin:issue-voucher', 'foreign-voucher-user', 'transaction'],
    ['wrong-user grant-only', 'admin:issue-voucher', 'foreign-voucher-user', 'grant'],
    ['wrong-scope transaction-only', 'foreign:issue-voucher', 'expired-voucher-user', 'transaction'],
    ['wrong-scope grant-only', 'foreign:issue-voucher', 'expired-voucher-user', 'grant'],
  ])('treats a %s receipt reference added after dry-run as stale evidence', async (
    _label,
    scope,
    receiptUserId,
    referenceKind,
  ) => {
    const fixture = expiredVoucherLegacyExpiryIntegrationFixture();
    await seedMigrationOpeningRetirementFixture(prisma, fixture, true);
    const plan = buildBalanceLedgerRepairPlan(
      fixture.snapshot,
      new Date('2026-07-22T00:00:00.000Z'),
      EVIDENCE_REPAIR_EXECUTION_PROFILE.planningProfile,
    );
    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;

    const databaseBinding = await loadRepairDatabaseBinding(prisma);
    const runId = `stale-expired-voucher-receipt-run-${randomUUID()}`;
    await prisma.balanceLedgerRepairRun.create({
      data: { id: runId, status: 'RUNNING', planHash: plan.replayHash },
    });
    await prisma.idempotencyKey.create({
      data: {
        key: `stale-expired-voucher-receipt-${randomUUID()}`,
        scope,
        userId: receiptUserId === 'expired-voucher-user'
          ? fixture.userId
          : receiptUserId,
        status: 'COMMITTED',
        result: referenceKind === 'transaction'
          ? { transaction: { id: fixture.voucherFundingTransactionId } }
          : { grant: { id: fixture.voucherGrantId } },
        createdAt: new Date('2026-07-19T00:01:00.001Z'),
        expiresAt: new Date('2026-08-19T00:01:00.001Z'),
      },
    });

    await expect(applyReadyPlan(
      runId,
      plan,
      databaseBinding,
      prisma,
      {
        financeApprovalRef: 'FIN-STALE-EXPIRED-VOUCHER-RECEIPT-001',
        technicalApprovalRef: 'TECH-STALE-EXPIRED-VOUCHER-RECEIPT-001',
      },
      EVIDENCE_REPAIR_EXECUTION_PROFILE,
    )).resolves.toBe('SKIPPED_STALE');

    const [repairAccount, voucherProofCount, expiryProofCount, account] = await Promise.all([
      prisma.balanceLedgerRepairAccount.findUniqueOrThrow({
        where: {
          runId_billingAccountId: {
            runId,
            billingAccountId: fixture.snapshot.billingAccountId,
          },
        },
      }),
      prisma.balanceLedgerVoucherFundingRepair.count({ where: { runId } }),
      prisma.balanceLedgerLegacyExpiryRepair.count({ where: { runId } }),
      prisma.billingAccount.findUniqueOrThrow({
        where: { id: fixture.snapshot.billingAccountId },
        select: { balanceGrantLedgerStatus: true, balanceGrantLedgerVersion: true },
      }),
    ]);
    expect(repairAccount.status).toBe('SKIPPED_STALE');
    expect(voucherProofCount).toBe(0);
    expect(expiryProofCount).toBe(0);
    expect(account).toEqual({
      balanceGrantLedgerStatus: 'LEGACY_DIRTY',
      balanceGrantLedgerVersion: 0,
    });
  }, GENERIC_REPAIR_TRANSACTION_TIMEOUT_MS + 30_000);

  it('preserves the complete issued-invoice closure and stores the database evidence hash', async () => {
    const fixture = issuedInvoiceIntegrationFixture();
    await seedIssuedInvoiceClosure(prisma, fixture);
    const snapshot = await hydrateInvoiceSnapshotForTest(prisma, fixture.snapshot);
    const evidenceBefore = await loadInvoiceEvidenceForTest(
      prisma,
      snapshot.billingAccountId,
    );
    const plan = buildBalanceLedgerRepairPlan(
      snapshot,
      new Date('2026-07-22T00:00:00.000Z'),
      INVOICE_STABILITY_EVIDENCE_EXECUTION_PROFILE.planningProfile,
    );
    expect(plan).toEqual(expect.objectContaining({
      status: 'READY',
      invoiceStabilityProof: {
        proofVersion: 1,
        repairKind: 'ISSUED_INVOICE_STABILITY_V1',
        orderCount: 1,
        applicationCount: 1,
        itemCount: 1,
        eventCount: 1,
        evidenceSha256: evidenceBefore.snapshotSha256,
      },
      legacyExpiryProofMutations: [],
    }));
    if (plan.status !== 'READY') return;
    const databaseBinding = await loadRepairDatabaseBinding(prisma);
    const noApprovalRunId = `issued-invoice-no-approval-run-${randomUUID()}`;
    await prisma.balanceLedgerRepairRun.create({
      data: { id: noApprovalRunId, status: 'RUNNING', planHash: plan.replayHash },
    });
    await expect(applyReadyPlan(
      noApprovalRunId,
      plan,
      databaseBinding,
      prisma,
      null,
      INVOICE_STABILITY_EVIDENCE_EXECUTION_PROFILE,
    )).rejects.toThrow('--finance-approval-ref must trim to 1..200 characters');
    const [accountBeforeApproval, proofCountBeforeApproval, repairCountBeforeApproval] = await Promise.all([
      prisma.billingAccount.findUniqueOrThrow({
        where: { id: snapshot.billingAccountId },
        select: { balanceGrantLedgerStatus: true },
      }),
      prisma.balanceLedgerInvoiceStabilityRepair.count({ where: { runId: noApprovalRunId } }),
      prisma.balanceLedgerRepairAccount.count({ where: { runId: noApprovalRunId } }),
    ]);
    expect(accountBeforeApproval.balanceGrantLedgerStatus).toBe('LEGACY_DIRTY');
    expect(proofCountBeforeApproval).toBe(0);
    expect(repairCountBeforeApproval).toBe(0);

    const runId = `issued-invoice-integration-run-${randomUUID()}`;
    await prisma.balanceLedgerRepairRun.create({
      data: { id: runId, status: 'RUNNING', planHash: plan.replayHash },
    });

    await expect(applyReadyPlan(
      runId,
      plan,
      databaseBinding,
      prisma,
      {
        financeApprovalRef: 'FIN-INVOICE-STABILITY-INTEGRATION-001',
        technicalApprovalRef: 'TECH-INVOICE-STABILITY-INTEGRATION-001',
      },
      INVOICE_STABILITY_EVIDENCE_EXECUTION_PROFILE,
    )).resolves.toBe('APPLIED');

    const [evidenceAfter, proof, account] = await Promise.all([
      loadInvoiceEvidenceForTest(prisma, snapshot.billingAccountId),
      prisma.balanceLedgerInvoiceStabilityRepair.findUniqueOrThrow({
        where: {
          runId_billingAccountId: {
            runId,
            billingAccountId: snapshot.billingAccountId,
          },
        },
      }),
      prisma.billingAccount.findUniqueOrThrow({
        where: { id: snapshot.billingAccountId },
        select: { balanceGrantLedgerStatus: true },
      }),
    ]);
    expect(evidenceAfter).toEqual(evidenceBefore);
    expect(proof.evidenceSha256).toBe(evidenceBefore.snapshotSha256);
    expect(proof.evidenceSnapshot).toEqual(evidenceBefore.snapshot);
    expect(proof.orderCount).toBe(BigInt(1));
    expect(proof.applicationCount).toBe(BigInt(1));
    expect(proof.itemCount).toBe(BigInt(1));
    expect(proof.eventCount).toBe(BigInt(1));
    expect(proof.financeApprovalRef).toBe('FIN-INVOICE-STABILITY-INTEGRATION-001');
    expect(proof.technicalApprovalRef).toBe('TECH-INVOICE-STABILITY-INTEGRATION-001');
    expect(account.balanceGrantLedgerStatus).toBe('RECONCILED_V2');

    await prisma.balanceLedgerRepairRun.update({
      where: { id: runId },
      data: {
        status: 'COMPLETED_WITH_EXCEPTIONS',
        completedAt: new Date('2026-07-22T00:30:00.000Z'),
      },
    });
    const [terminalValidity] = await prisma.$queryRaw<Array<{ valid: boolean }>>`
      SELECT "balance_ledger_invoice_stability_proof_is_valid"(
        ${snapshot.billingAccountId}, ${runId}
      ) AS valid`;
    expect(terminalValidity).toEqual({ valid: true });
    await expect(hasCommittedAppliedProof(runId, plan, databaseBinding, {
      financeApprovalRef: 'FIN-INVOICE-STABILITY-INTEGRATION-001',
      technicalApprovalRef: 'TECH-INVOICE-STABILITY-INTEGRATION-001',
    })).resolves.toBe(true);

    await expect(prisma.$executeRaw`
      UPDATE "balance_ledger_invoice_stability_repairs"
      SET "evidence_sha256" = ${'f'.repeat(64)}
      WHERE "id" = ${proof.id}`)
      .rejects.toThrow('balance ledger evidence repair is append-only');
    await expect(prisma.$executeRaw`
      DELETE FROM "balance_ledger_invoice_stability_repairs"
      WHERE "id" = ${proof.id}`)
      .rejects.toThrow('balance ledger evidence repair is append-only');
  }, GENERIC_REPAIR_TRANSACTION_TIMEOUT_MS + 30_000);

  it('rolls back legacy-expiry repair when dual approval is absent and rejects no-proof planning', async () => {
    const fixture = legacyExpiryIntegrationFixture();
    await seedMigrationOpeningRetirementFixture(prisma, fixture, true);
    const defaultPlan = buildBalanceLedgerRepairPlan(
      fixture.snapshot,
      new Date('2026-07-22T00:00:00.000Z'),
    );
    expect(defaultPlan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        `FUNDING_SIGN_INVALID:${fixture.expiryTransactionIds[0]}:-0.194238453000`,
        `LEGACY_EXPIRY_REQUIRES_MANUAL_REPLAY:${fixture.grantIds[0]}`,
      ]),
    }));

    const plan = buildBalanceLedgerRepairPlan(
      fixture.snapshot,
      new Date('2026-07-22T00:00:00.000Z'),
      EVIDENCE_REPAIR_EXECUTION_PROFILE.planningProfile,
    );
    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    const databaseBinding = await loadRepairDatabaseBinding(prisma);
    const runId = `legacy-expiry-no-approval-run-${randomUUID()}`;
    await prisma.balanceLedgerRepairRun.create({
      data: { id: runId, status: 'RUNNING', planHash: plan.replayHash },
    });

    await expect(applyReadyPlan(
      runId,
      plan,
      databaseBinding,
      prisma,
      null,
      EVIDENCE_REPAIR_EXECUTION_PROFILE,
    )).rejects.toThrow('--finance-approval-ref must trim to 1..200 characters');

    const [account, repairAccountCount, proofCount, expiryAuditCount, changedTxCount] = await Promise.all([
      prisma.billingAccount.findUniqueOrThrow({
        where: { id: fixture.snapshot.billingAccountId },
        select: { balanceGrantLedgerStatus: true },
      }),
      prisma.balanceLedgerRepairAccount.count({ where: { runId } }),
      prisma.balanceLedgerLegacyExpiryRepair.count({ where: { runId } }),
      prisma.balanceGrantExpiry.count({
        where: { billingAccountId: fixture.snapshot.billingAccountId },
      }),
      prisma.balanceTransaction.count({
        where: {
          billingAccountId: fixture.snapshot.billingAccountId,
          ledgerSequence: { not: null },
        },
      }),
    ]);
    expect(account.balanceGrantLedgerStatus).toBe('LEGACY_DIRTY');
    expect(repairAccountCount).toBe(0);
    expect(proofCount).toBe(0);
    expect(expiryAuditCount).toBe(0);
    expect(changedTxCount).toBe(0);
  }, GENERIC_REPAIR_TRANSACTION_TIMEOUT_MS + 30_000);

  it('fails closed before mutation when issued-invoice evidence drifts after planning', async () => {
    const fixture = issuedInvoiceIntegrationFixture();
    await seedIssuedInvoiceClosure(prisma, fixture);
    const snapshot = await hydrateInvoiceSnapshotForTest(prisma, fixture.snapshot);
    const plan = buildBalanceLedgerRepairPlan(
      snapshot,
      new Date('2026-07-22T00:00:00.000Z'),
      INVOICE_STABILITY_EVIDENCE_EXECUTION_PROFILE.planningProfile,
    );
    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    const databaseBinding = await loadRepairDatabaseBinding(prisma);
    const runId = `issued-invoice-stale-run-${randomUUID()}`;
    await prisma.balanceLedgerRepairRun.create({
      data: { id: runId, status: 'RUNNING', planHash: plan.replayHash },
    });
    await prisma.invoiceEventLog.update({
      where: { id: fixture.eventId },
      data: { metadata: { immutable: false, driftedAfterApproval: true } },
    });

    await expect(applyReadyPlan(
      runId,
      plan,
      databaseBinding,
      prisma,
      {
        financeApprovalRef: 'FIN-INVOICE-STABILITY-INTEGRATION-STALE',
        technicalApprovalRef: 'TECH-INVOICE-STABILITY-INTEGRATION-STALE',
      },
      INVOICE_STABILITY_EVIDENCE_EXECUTION_PROFILE,
    )).resolves.toBe('SKIPPED_STALE');

    const [account, repairAccount, proofCount, transaction] = await Promise.all([
      prisma.billingAccount.findUniqueOrThrow({
        where: { id: snapshot.billingAccountId },
        select: { balanceGrantLedgerStatus: true },
      }),
      prisma.balanceLedgerRepairAccount.findUniqueOrThrow({
        where: {
          runId_billingAccountId: {
            runId,
            billingAccountId: snapshot.billingAccountId,
          },
        },
      }),
      prisma.balanceLedgerInvoiceStabilityRepair.count({ where: { runId } }),
      prisma.balanceTransaction.findFirstOrThrow({
        where: { billingAccountId: snapshot.billingAccountId },
        select: { ledgerSequence: true },
      }),
    ]);
    expect(account.balanceGrantLedgerStatus).toBe('LEGACY_DIRTY');
    expect(repairAccount.status).toBe('SKIPPED_STALE');
    expect(proofCount).toBe(0);
    expect(transaction.ledgerSequence).toBe(BigInt(-1));
  }, GENERIC_REPAIR_TRANSACTION_TIMEOUT_MS + 30_000);

  it('applies the UAT-shaped linked-grant replay through the PostgreSQL proof contract', async () => {
    const fixture = legacyAdminFundingLinkReplayFixture();
    await seedMigrationOpeningRetirementFixture(prisma, fixture);
    const { snapshot, financialNow } = await prisma.$transaction(async (tx) => ({
      snapshot: await loadSnapshot(tx, fixture.snapshot.billingAccountId),
      financialNow: await loadPostgresFinancialNow(tx, fixture.snapshot.billingAccountId),
    }), {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 30_000,
    });
    const plan = buildBalanceLedgerRepairPlan(snapshot, financialNow);

    expect(plan).toEqual(expect.objectContaining({
      status: 'READY',
      accountType: 'enterprise',
      settlementWriteMode: 'VERIFY_EXISTING',
      walletBalanceUsd: '26.799202700000',
      currentDebtUsd: '0.000000000000',
      legacySettledDebtUsd: '0.158601300000',
      expectedSettlementCount: 1,
      settlementMutations: [expect.objectContaining({
        allocationId: expect.stringContaining('uat-admin-debt-allocation-'),
        repaymentTransactionId: expect.stringContaining('uat-admin-adjust-1-'),
        balanceGrantId: null,
        debtSource: 'ENTERPRISE_CREDIT',
        amountUsd: '0.158601300000',
        paidUsd: '0.158601300000',
        bonusUsd: '0.000000000000',
      })],
    }));
    if (plan.status !== 'READY') return;

    expect(plan.legacyAdminFundingRepairs).toHaveLength(11);
    expect(plan.legacyAdminFundingRepairs.filter((repair) => repair.action === 'CREATE_GRANT'))
      .toHaveLength(8);
    expect(plan.legacyAdminFundingRepairs.filter((repair) => repair.action === 'LINK_GRANT'))
      .toHaveLength(3);
    expect(plan.canonicalAllocationMutations).toHaveLength(5);
    expect(plan.canonicalAllocationMutations.map((mutation) => mutation.allocationId).sort())
      .toEqual([...fixture.allocationIds].sort());
    expect(new Set(plan.canonicalAllocationMutations.map(
      (mutation) => mutation.expectedBalanceGrantId,
    ))).toEqual(new Set([fixture.linkedGrantId]));
    expect(new Set(plan.canonicalAllocationMutations.map(
      (mutation) => mutation.balanceGrantId,
    ))).toEqual(new Set([fixture.firstVirtualGrantId]));
    expect(plan.canonicalAllocationMutations.map((mutation) => ({
      allocationId: mutation.allocationId,
      amountUsd: mutation.amountUsd,
      ledgerSequence: mutation.ledgerSequence,
    })).sort((left, right) => left.allocationId.localeCompare(right.allocationId)))
      .toEqual([...fixture.allocationExpectations]
        .sort((left, right) => left.allocationId.localeCompare(right.allocationId)));
    expect(plan.canonicalAllocationMutations.reduce(
      (sum, mutation) => sum.plus(mutation.expectedAmountUsd),
      new Prisma.Decimal(0),
    ).toFixed(12)).toBe('0.042196000000');
    expect(plan.canonicalAllocationMutations.reduce(
      (sum, mutation) => sum.plus(mutation.amountUsd),
      new Prisma.Decimal(0),
    ).toFixed(12)).toBe('0.042196000000');
    expect(new Set(plan.canonicalAllocationMutations.map(
      (mutation) => mutation.ledgerSequence,
    ))).toEqual(new Set(['-5', '-4', '-3', '-2', '-1']));
    expect(plan.grantMutations.map((mutation) => ({
      grantId: mutation.grantId,
      expectedRemainingAmountUsd: mutation.expectedRemainingAmountUsd,
      expectedRemainingPaidAmountUsd: mutation.expectedRemainingPaidAmountUsd,
      expectedRemainingBonusAmountUsd: mutation.expectedRemainingBonusAmountUsd,
      remainingAmountUsd: mutation.remainingAmountUsd,
      remainingPaidAmountUsd: mutation.remainingPaidAmountUsd,
      remainingBonusAmountUsd: mutation.remainingBonusAmountUsd,
    }))).toEqual([
      {
        grantId: fixture.linkedGrantIds[0],
        expectedRemainingAmountUsd: '1.957804000000',
        expectedRemainingPaidAmountUsd: null,
        expectedRemainingBonusAmountUsd: null,
        remainingAmountUsd: '2.000000000000',
        remainingPaidAmountUsd: '2.000000000000',
        remainingBonusAmountUsd: '0.000000000000',
      },
      {
        grantId: fixture.linkedGrantIds[1],
        expectedRemainingAmountUsd: '3.000000000000',
        expectedRemainingPaidAmountUsd: null,
        expectedRemainingBonusAmountUsd: null,
        remainingAmountUsd: '3.000000000000',
        remainingPaidAmountUsd: '3.000000000000',
        remainingBonusAmountUsd: '0.000000000000',
      },
      {
        grantId: fixture.linkedGrantIds[2],
        expectedRemainingAmountUsd: '7.000000000000',
        expectedRemainingPaidAmountUsd: null,
        expectedRemainingBonusAmountUsd: null,
        remainingAmountUsd: '7.000000000000',
        remainingPaidAmountUsd: '7.000000000000',
        remainingBonusAmountUsd: '0.000000000000',
      },
    ]);

    const databaseBinding = await loadRepairDatabaseBinding(prisma);
    const runId = `uat-admin-link-replay-${randomUUID()}`;
    await prisma.balanceLedgerRepairRun.create({
      data: {
        id: runId,
        status: 'RUNNING',
        planHash: plan.replayHash,
        initiatedBy: 'uat-admin-link-replay-integration',
      },
    });

    await expect(applyReadyPlan(runId, plan, databaseBinding, prisma))
      .resolves.toBe('APPLIED');

    const [
      account,
      wallet,
      linkedGrants,
      firstVirtualGrant,
      repairedAllocations,
      grants,
      settlements,
      proofs,
      allocationRepairCount,
      repairAccount,
    ] = await Promise.all([
      prisma.billingAccount.findUniqueOrThrow({
        where: { id: fixture.snapshot.billingAccountId },
        select: {
          balanceGrantLedgerStatus: true,
          balanceGrantLedgerVersion: true,
          balanceGrantLedgerHash: true,
          balanceGrantLedgerThroughTransactionId: true,
        },
      }),
      prisma.accountWallet.findUniqueOrThrow({
        where: { billingAccountId: fixture.snapshot.billingAccountId },
      }),
      prisma.balanceGrant.findMany({
        where: { id: { in: fixture.linkedGrantIds } },
        orderBy: { id: 'asc' },
      }),
      prisma.balanceGrant.findUniqueOrThrow({ where: { id: fixture.firstVirtualGrantId } }),
      prisma.balanceConsumptionAllocation.findMany({
        where: { id: { in: fixture.allocationIds } },
        orderBy: { id: 'asc' },
      }),
      prisma.balanceGrant.findMany({
        where: { billingAccountId: fixture.snapshot.billingAccountId, isExpired: false },
      }),
      prisma.enterpriseCreditSettlement.findMany({
        where: { billingAccountId: fixture.snapshot.billingAccountId },
      }),
      prisma.$queryRaw<Array<{ action: string }>>`
        SELECT "action"
        FROM "balance_ledger_admin_funding_repairs"
        WHERE "run_id" = ${runId}
          AND "billing_account_id" = ${fixture.snapshot.billingAccountId}`,
      prisma.balanceLedgerAllocationRepair.count({
        where: { runId, billingAccountId: fixture.snapshot.billingAccountId },
      }),
      prisma.balanceLedgerRepairAccount.findUniqueOrThrow({
        where: {
          runId_billingAccountId: {
            runId,
            billingAccountId: fixture.snapshot.billingAccountId,
          },
        },
      }),
    ]);

    expect(account).toEqual({
      balanceGrantLedgerStatus: 'RECONCILED_V2',
      balanceGrantLedgerVersion: 2,
      balanceGrantLedgerHash: plan.replayHash,
      balanceGrantLedgerThroughTransactionId: plan.throughTransactionId,
    });
    expect(wallet.balanceUsd.toFixed(12)).toBe('26.799202700000');
    expect(linkedGrants.map((grant) => ({
      id: grant.id,
      remaining: grant.remainingAmountUsd.toFixed(12),
      paid: grant.remainingPaidAmountUsd?.toFixed(12),
      bonus: grant.remainingBonusAmountUsd?.toFixed(12),
    }))).toEqual([
      { id: fixture.linkedGrantIds[0], remaining: '2.000000000000',
        paid: '2.000000000000', bonus: '0.000000000000' },
      { id: fixture.linkedGrantIds[1], remaining: '3.000000000000',
        paid: '3.000000000000', bonus: '0.000000000000' },
      { id: fixture.linkedGrantIds[2], remaining: '7.000000000000',
        paid: '7.000000000000', bonus: '0.000000000000' },
    ]);
    expect({
      remaining: firstVirtualGrant.remainingAmountUsd.toFixed(12),
      paid: firstVirtualGrant.remainingPaidAmountUsd?.toFixed(12),
      bonus: firstVirtualGrant.remainingBonusAmountUsd?.toFixed(12),
    }).toEqual({
      remaining: '0.799202700000',
      paid: '0.799202700000',
      bonus: '0.000000000000',
    });
    expect(repairedAllocations).toHaveLength(5);
    expect(new Set(repairedAllocations.map((allocation) => allocation.balanceGrantId)))
      .toEqual(new Set([fixture.firstVirtualGrantId]));
    expect(new Set(repairedAllocations.map((allocation) => allocation.ledgerSequence?.toString())))
      .toEqual(new Set(['-5', '-4', '-3', '-2', '-1']));
    expect(repairedAllocations.map((allocation) => ({
      allocationId: allocation.id,
      amountUsd: allocation.amountUsd.toFixed(12),
      ledgerSequence: allocation.ledgerSequence?.toString(),
    }))).toEqual([...fixture.allocationExpectations]
      .sort((left, right) => left.allocationId.localeCompare(right.allocationId)));
    expect(repairedAllocations.reduce(
      (sum, allocation) => sum.plus(allocation.amountUsd),
      new Prisma.Decimal(0),
    ).toFixed(12)).toBe('0.042196000000');
    expect(repairedAllocations.reduce(
      (sum, allocation) => sum.plus(allocation.recognizedRevenueUsd),
      new Prisma.Decimal(0),
    ).toFixed(12)).toBe('0.042196000000');
    expect(repairedAllocations.every((allocation) => (
      allocation.bonusConsumedUsd.eq(0)
      && allocation.settledUsd.eq(0)
      && allocation.settledAt === null
    ))).toBe(true);
    expect(grants).toHaveLength(11);
    expect(grants.reduce(
      (sum, grant) => sum.plus(grant.remainingAmountUsd),
      new Prisma.Decimal(0),
    ).toFixed(12)).toBe(wallet.balanceUsd.toFixed(12));
    expect(settlements).toHaveLength(1);
    expect(settlements[0]).toEqual(expect.objectContaining({
      repairRunId: null,
      debtSource: 'ENTERPRISE_CREDIT',
      trigger: 'FUNDING',
    }));
    expect(settlements[0].amountUsd.toFixed(12)).toBe('0.158601300000');
    expect(proofs).toHaveLength(11);
    expect(proofs.filter((proof) => proof.action === 'CREATE_GRANT')).toHaveLength(8);
    expect(proofs.filter((proof) => proof.action === 'LINK_GRANT')).toHaveLength(3);
    expect(allocationRepairCount).toBe(5);
    expect(repairAccount.status).toBe('APPLIED');
    expect(repairAccount.afterSnapshot).toEqual(expect.objectContaining({
      adminFundingProofCount: '11',
      adminFundingCreateCount: '8',
      adminFundingLinkCount: '3',
      adminFundingFinalGrantCount: '11',
      invalidComponentCount: '0',
      invalidGrantAllocationCount: '0',
      invalidConsumeAllocationCount: '0',
      invalidGrantConservationCount: '0',
    }));
    const [terminalEvidence] = await prisma.$queryRaw<Array<{ valid: boolean }>>`
      SELECT "balance_admin_funding_terminal_evidence_is_valid"(
        ${fixture.snapshot.billingAccountId},
        ${runId},
        ${JSON.stringify(repairAccount.afterSnapshot)}::JSONB
      ) AS "valid"`;
    expect(terminalEvidence?.valid).toBe(true);
    await expect(hasCommittedAppliedProof(runId, plan, databaseBinding, null))
      .resolves.toBe(true);
  }, GENERIC_REPAIR_TRANSACTION_TIMEOUT_MS + 30_000);

  it('commits the pre-idempotency voucher proof without inventing a receipt or settlement', async () => {
    const fixture = preIdempotencyVoucherFixture();
    await seedMigrationOpeningRetirementFixture(prisma, fixture);
    const plan = buildBalanceLedgerRepairPlan(
      fixture.snapshot,
      new Date('2026-07-18T12:01:52.353Z'),
    );
    expect(plan).toEqual(expect.objectContaining({
      status: 'READY',
      currentDebtUsd: '0.591578080000',
      expectedSettlementCount: 0,
      legacyVoucherProofMutations: [expect.objectContaining({
        repairKind: 'LEGACY_PRE_IDEMPOTENCY_VOUCHER_V1',
        transactionId: fixture.voucherTransactionId,
        grantId: fixture.voucherGrantId,
        walletBeforeUsd: '0.000000000000',
        holeFillUsd: '0.000000000000',
        expectedIdempotencyEvidence: [],
      })],
      personalDebtAllocationMutations: [expect.objectContaining({
        repairKind: 'LEGACY_DEBT_RECLASS_V1',
      })],
    }));
    if (plan.status !== 'READY') return;
    const databaseBinding = await loadRepairDatabaseBinding(prisma);
    const runId = `pre-idempotency-voucher-run-${randomUUID()}`;
    await prisma.balanceLedgerRepairRun.create({
      data: { id: runId, status: 'RUNNING', planHash: plan.replayHash },
    });

    await expect(applyReadyPlan(runId, plan, databaseBinding, prisma, {
      financeApprovalRef: 'FIN-PRE-IDEMPOTENCY-001',
      technicalApprovalRef: 'TECH-PRE-IDEMPOTENCY-001',
    })).resolves.toBe('APPLIED');

    const [proofs, settlements, receiptCount, allocation, repairAccount] = await Promise.all([
      prisma.$queryRaw<Array<{
        repairKind: string;
        walletBeforeUsd: Prisma.Decimal;
        holeFillUsd: Prisma.Decimal;
      }>>`
        SELECT "repair_kind" AS "repairKind", "wallet_before_usd" AS "walletBeforeUsd",
          "hole_fill_usd" AS "holeFillUsd"
        FROM "balance_ledger_voucher_funding_repairs"
        WHERE "run_id" = ${runId}`,
      prisma.enterpriseCreditSettlement.count({ where: { repairRunId: runId } }),
      prisma.idempotencyKey.count({
        where: {
          scope: 'admin:issue-voucher',
          OR: [
            { result: { path: ['transaction', 'id'], equals: fixture.voucherTransactionId } },
            { result: { path: ['grant', 'id'], equals: fixture.voucherGrantId } },
          ],
        },
      }),
      prisma.balanceConsumptionAllocation.findUniqueOrThrow({
        where: { id: plan.personalDebtAllocationMutations[0].sourceAllocationId },
      }),
      prisma.balanceLedgerRepairAccount.findUniqueOrThrow({
        where: {
          runId_billingAccountId: {
            runId,
            billingAccountId: fixture.snapshot.billingAccountId,
          },
        },
      }),
    ]);
    expect(proofs).toHaveLength(1);
    expect(proofs[0].repairKind).toBe('LEGACY_PRE_IDEMPOTENCY_VOUCHER_V1');
    expect(proofs[0].walletBeforeUsd.toFixed(12)).toBe('0.000000000000');
    expect(proofs[0].holeFillUsd.toFixed(12)).toBe('0.000000000000');
    expect(settlements).toBe(0);
    expect(receiptCount).toBe(0);
    expect(allocation.source).toBe('NEGATIVE_BALANCE');
    expect(allocation.balanceGrantId).toBeNull();
    expect(repairAccount.status).toBe('APPLIED');
    expect(repairAccount.afterSnapshot).toEqual(expect.objectContaining({
      voucherFundingProofs: [expect.objectContaining({
        repairKind: 'LEGACY_PRE_IDEMPOTENCY_VOUCHER_V1',
        financeApprovalRef: 'FIN-PRE-IDEMPOTENCY-001',
        technicalApprovalRef: 'TECH-PRE-IDEMPOTENCY-001',
      })],
    }));
  }, GENERIC_REPAIR_TRANSACTION_TIMEOUT_MS + 30_000);

  it('preserves exact NUMERIC proof values through commit recovery without a JS round trip', async () => {
    const fixture = highPrecisionPersonalDebtFixture();
    await seedMigrationOpeningRetirementFixture(prisma, fixture);
    const plan = buildBalanceLedgerRepairPlan(
      fixture.snapshot,
      new Date('2026-07-18T12:01:52.353Z'),
    );
    expect(plan).toEqual(expect.objectContaining({
      status: 'READY',
      currentDebtUsd: '99999999.999999999999',
      legacyVoucherProofMutations: [],
      personalDebtAllocationMutations: [expect.objectContaining({
        repairKind: 'LEGACY_DEBT_RECLASS_V1',
      })],
    }));
    if (plan.status !== 'READY') return;
    const databaseBinding = await loadRepairDatabaseBinding(prisma);
    const runId = `high-precision-personal-debt-run-${randomUUID()}`;
    await prisma.balanceLedgerRepairRun.create({
      data: { id: runId, status: 'RUNNING', planHash: plan.replayHash },
    });

    await expect(applyReadyPlan(runId, plan, databaseBinding, prisma))
      .resolves.toBe('APPLIED');

    const [proof] = await prisma.$queryRaw<Array<{
      proofAmountUsd: string;
      afterSnapshotAmountUsd: string;
    }>>`
      SELECT
        proof_row."source_before_snapshot"->>'amount_usd' AS "proofAmountUsd",
        repair_account."after_snapshot"
          #>> '{personalDebtAllocationRepairs,0,sourceBeforeSnapshot,amount_usd}'
          AS "afterSnapshotAmountUsd"
      FROM "balance_ledger_personal_debt_allocation_repairs" proof_row
      JOIN "balance_ledger_repair_accounts" repair_account
        ON repair_account."id" = proof_row."repair_account_id"
      WHERE proof_row."run_id" = ${runId}`;
    expect(proof).toEqual({
      proofAmountUsd: '99999999.999999999999',
      afterSnapshotAmountUsd: '99999999.999999999999',
    });
    await expect(hasCommittedAppliedProof(
      runId,
      plan,
      databaseBinding,
      null,
    )).resolves.toBe(true);
  }, GENERIC_REPAIR_TRANSACTION_TIMEOUT_MS + 30_000);

  it('atomically repairs the full legacy voucher, SPLIT, and RECLASS combination', async () => {
    const fixture = legacyPersonalProofCombinationFixture();
    expect(fixture.snapshot.grants.find(
      (grant) => grant.id === fixture.voucherGrantId,
    )?.expiresAt).toBeNull();
    await seedMigrationOpeningRetirementFixture(prisma, fixture);
    const plan = buildBalanceLedgerRepairPlan(
      fixture.snapshot,
      new Date('2026-07-18T12:01:52.353Z'),
    );
    expect(plan).toEqual(expect.objectContaining({
      status: 'READY',
      currentDebtUsd: '0.043071216000',
      legacySettledDebtUsd: '0.081552076000',
      expectedSettlementCount: 5,
    }));
    if (plan.status !== 'READY') return;
    expect(plan.legacyVoucherProofMutations).toEqual([expect.objectContaining({
      transactionId: fixture.voucherTransactionId,
      grantId: fixture.voucherGrantId,
      walletBeforeUsd: '-0.081552076000',
      holeFillUsd: '0.081552076000',
      mintedGrantAmountUsd: '99.918447924000',
      openingDebtAllocationIds: expect.arrayContaining(
        plan.migrationOpeningDebtMutations.map((mutation) => mutation.allocationId),
      ),
    })]);
    expect(plan.personalDebtAllocationMutations.filter(
      (mutation) => mutation.repairKind === 'LEGACY_DEBT_SPLIT_V1',
    )).toHaveLength(1);
    expect(plan.personalDebtAllocationMutations.filter(
      (mutation) => mutation.repairKind === 'LEGACY_DEBT_RECLASS_V1',
    )).toHaveLength(2);

    const databaseBinding = await loadRepairDatabaseBinding(prisma);
    const runId = `legacy-personal-proof-run-${randomUUID()}`;
    await prisma.balanceLedgerRepairRun.create({
      data: {
        id: runId,
        status: 'RUNNING',
        planHash: plan.replayHash,
        initiatedBy: 'legacy-personal-proof-integration',
      },
    });
    await expect(applyReadyPlan(runId, plan, databaseBinding, prisma, {
      financeApprovalRef: 'FIN-UAT-LEGACY-PROOF-001',
      technicalApprovalRef: 'TECH-UAT-LEGACY-PROOF-001',
    })).resolves.toBe('APPLIED');

    const [
      account,
      voucherGrant,
      openingGrantCount,
      personalProofs,
      voucherProofs,
      settlementSummary,
      debtSummary,
      repairAccount,
      receipt,
    ] = await Promise.all([
      prisma.billingAccount.findUniqueOrThrow({
        where: { id: fixture.snapshot.billingAccountId },
        select: {
          balanceGrantLedgerStatus: true,
          balanceGrantLedgerVersion: true,
          balanceGrantLedgerHash: true,
          balanceGrantLedgerThroughTransactionId: true,
        },
      }),
      prisma.balanceGrant.findUniqueOrThrow({ where: { id: fixture.voucherGrantId } }),
      prisma.balanceGrant.count({ where: { id: { in: fixture.openingGrantIds } } }),
      prisma.$queryRaw<Array<{
        proofVersion: number;
        repairKind: string;
        transactionId: string;
        sourceAllocationId: string;
        createdDebtAllocationId: string | null;
        sourceBeforeSnapshot: Record<string, unknown>;
        sourceAfterSnapshot: Record<string, unknown>;
        createdDebtSnapshot: Record<string, unknown> | null;
      }>>`
        SELECT "proof_version" AS "proofVersion", "repair_kind" AS "repairKind",
          "transaction_id" AS "transactionId",
          "source_allocation_id" AS "sourceAllocationId",
          "created_debt_allocation_id" AS "createdDebtAllocationId",
          "source_before_snapshot" AS "sourceBeforeSnapshot",
          "source_after_snapshot" AS "sourceAfterSnapshot",
          "created_debt_snapshot" AS "createdDebtSnapshot"
        FROM "balance_ledger_personal_debt_allocation_repairs"
        WHERE "run_id" = ${runId}
        ORDER BY "transaction_id", "source_allocation_id"`,
      prisma.$queryRaw<Array<{
        operationKey: string;
        proofVersion: number;
        repairKind: string;
        transactionId: string;
        grantId: string;
        walletBeforeUsd: Prisma.Decimal;
        holeFillUsd: Prisma.Decimal;
        financeApprovalRef: string;
        technicalApprovalRef: string;
      }>>`
        SELECT "operation_key" AS "operationKey", "proof_version" AS "proofVersion",
          "repair_kind" AS "repairKind", "transaction_id" AS "transactionId",
          "grant_id" AS "grantId", "wallet_before_usd" AS "walletBeforeUsd",
          "hole_fill_usd" AS "holeFillUsd",
          "finance_approval_ref" AS "financeApprovalRef",
          "technical_approval_ref" AS "technicalApprovalRef"
        FROM "balance_ledger_voucher_funding_repairs"
        WHERE "run_id" = ${runId}`,
      prisma.$queryRaw<Array<{ count: bigint; amountUsd: Prisma.Decimal }>>`
        SELECT COUNT(*) AS count, COALESCE(SUM("amount_usd"), 0) AS "amountUsd"
        FROM "enterprise_credit_settlements"
        WHERE "repair_run_id" = ${runId}`,
      prisma.$queryRaw<Array<{ amountUsd: Prisma.Decimal; invalidCount: bigint }>>`
        SELECT
          COALESCE(SUM("amount_usd" - "settled_usd"), 0) AS "amountUsd",
          COUNT(*) FILTER (
            WHERE "source" <> 'NEGATIVE_BALANCE'
              OR "balance_grant_id" IS NOT NULL
              OR "discount_rate" <> 0
          ) AS "invalidCount"
        FROM "balance_consumption_allocations"
        WHERE "billing_account_id" = ${fixture.snapshot.billingAccountId}
          AND "source" = 'NEGATIVE_BALANCE'`,
      prisma.balanceLedgerRepairAccount.findUniqueOrThrow({
        where: {
          runId_billingAccountId: {
            runId,
            billingAccountId: fixture.snapshot.billingAccountId,
          },
        },
      }),
      prisma.idempotencyKey.findUniqueOrThrow({
        where: {
          key_scope: {
            key: fixture.snapshot.voucherIdempotencyEvidence[0].key,
            scope: 'admin:issue-voucher',
          },
        },
      }),
    ]);

    expect(account).toEqual({
      balanceGrantLedgerStatus: 'RECONCILED_V2',
      balanceGrantLedgerVersion: 2,
      balanceGrantLedgerHash: plan.replayHash,
      balanceGrantLedgerThroughTransactionId: fixture.snapshot.transactions.at(-1)!.id,
    });
    expect(voucherGrant.remainingAmountUsd.toFixed(12)).toBe('0.000000000000');
    expect(voucherGrant.remainingPaidAmountUsd?.toFixed(12)).toBe('0.000000000000');
    expect(voucherGrant.remainingBonusAmountUsd?.toFixed(12)).toBe('0.000000000000');
    expect(openingGrantCount).toBe(0);
    expect(personalProofs).toHaveLength(3);
    expect(personalProofs.map((proof) => proof.repairKind).sort()).toEqual([
      'LEGACY_DEBT_RECLASS_V1',
      'LEGACY_DEBT_RECLASS_V1',
      'LEGACY_DEBT_SPLIT_V1',
    ]);
    for (const proof of personalProofs) {
      expect(proof.proofVersion).toBe(1);
      expect(proof.sourceAfterSnapshot.source).toMatch(/BALANCE_GRANT|NEGATIVE_BALANCE/);
      if (proof.repairKind === 'LEGACY_DEBT_SPLIT_V1') {
        expect(proof.createdDebtAllocationId).toBe(
          `repair-negative-balance-split:${proof.sourceAllocationId}`,
        );
        expect(proof.createdDebtSnapshot).toEqual(expect.objectContaining({
          id: proof.createdDebtAllocationId,
          source: 'NEGATIVE_BALANCE',
          balance_grant_id: null,
        }));
      } else {
        expect(proof.createdDebtAllocationId).toBeNull();
        expect(proof.createdDebtSnapshot).toBeNull();
      }
    }
    expect(voucherProofs).toEqual([expect.objectContaining({
      operationKey: `repair:voucher-funding:${runId}:${fixture.voucherTransactionId}:`
        + fixture.voucherGrantId,
      proofVersion: 1,
      repairKind: 'LEGACY_VOUCHER_FULL_REMAINDER_DEBT_ABSORPTION_V1',
      transactionId: fixture.voucherTransactionId,
      grantId: fixture.voucherGrantId,
      financeApprovalRef: 'FIN-UAT-LEGACY-PROOF-001',
      technicalApprovalRef: 'TECH-UAT-LEGACY-PROOF-001',
    })]);
    expect(voucherProofs[0].walletBeforeUsd.toFixed(12)).toBe('-0.081552076000');
    expect(voucherProofs[0].holeFillUsd.toFixed(12)).toBe('0.081552076000');
    expect(settlementSummary).toEqual([{
      count: BigInt(5),
      amountUsd: new Prisma.Decimal('0.081552076000'),
    }]);
    expect(debtSummary[0].amountUsd.toFixed(12)).toBe('0.043071216000');
    expect(debtSummary[0].invalidCount).toBe(BigInt(0));
    expect(repairAccount.status).toBe('APPLIED');
    expect(repairAccount.afterSnapshot).toEqual(expect.objectContaining({
      personalDebtAllocationRepairs: expect.arrayContaining(personalProofs),
      voucherFundingProofs: [expect.objectContaining({
        financeApprovalRef: 'FIN-UAT-LEGACY-PROOF-001',
        technicalApprovalRef: 'TECH-UAT-LEGACY-PROOF-001',
      })],
    }));
    expect(receipt.result).toEqual(fixture.snapshot.voucherIdempotencyEvidence[0].result);
    await expect(hasCommittedAppliedProof(runId, plan, databaseBinding, {
      financeApprovalRef: 'FIN-UAT-LEGACY-PROOF-001',
      technicalApprovalRef: 'TECH-UAT-LEGACY-PROOF-001',
    })).resolves.toBe(true);
    await expect(hasCommittedAppliedProof(runId, plan, databaseBinding, {
      financeApprovalRef: 'FIN-UAT-LEGACY-PROOF-WRONG',
      technicalApprovalRef: 'TECH-UAT-LEGACY-PROOF-001',
    })).resolves.toBe(false);
  }, GENERIC_REPAIR_TRANSACTION_TIMEOUT_MS + 30_000);

  it('rolls back the complete combination when dual approval is absent', async () => {
    const fixture = legacyPersonalProofCombinationFixture();
    await seedMigrationOpeningRetirementFixture(prisma, fixture);
    const plan = buildBalanceLedgerRepairPlan(
      fixture.snapshot,
      new Date('2026-07-18T12:01:52.353Z'),
    );
    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    const splitAllocationId = plan.personalDebtAllocationMutations.find(
      (mutation) => mutation.repairKind === 'LEGACY_DEBT_SPLIT_V1',
    )?.createdDebtAllocationId;
    expect(splitAllocationId).not.toBeNull();
    const databaseBinding = await loadRepairDatabaseBinding(prisma);
    const runId = `legacy-personal-no-approval-run-${randomUUID()}`;
    await prisma.balanceLedgerRepairRun.create({
      data: { id: runId, status: 'RUNNING', planHash: plan.replayHash },
    });

    await expect(applyReadyPlan(runId, plan, databaseBinding, prisma))
      .rejects.toThrow('--finance-approval-ref');

    const [account, repairCount, debtProofCount, voucherProofCount, voucherGrant] = await Promise.all([
      prisma.billingAccount.findUniqueOrThrow({
        where: { id: fixture.snapshot.billingAccountId },
        select: { balanceGrantLedgerStatus: true, balanceGrantLedgerVersion: true },
      }),
      prisma.balanceLedgerRepairAccount.count({ where: { runId } }),
      prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) AS count
        FROM "balance_ledger_personal_debt_allocation_repairs"
        WHERE "run_id" = ${runId}`,
      prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) AS count
        FROM "balance_ledger_voucher_funding_repairs"
        WHERE "run_id" = ${runId}`,
      prisma.balanceGrant.findUniqueOrThrow({ where: { id: fixture.voucherGrantId } }),
    ]);
    expect(account).toEqual({
      balanceGrantLedgerStatus: 'LEGACY_DIRTY',
      balanceGrantLedgerVersion: 0,
    });
    expect(repairCount).toBe(0);
    expect(debtProofCount).toEqual([{ count: BigInt(0) }]);
    expect(voucherProofCount).toEqual([{ count: BigInt(0) }]);
    expect(voucherGrant.remainingAmountUsd.toFixed(12)).toBe('0.038480860000');
    expect(await prisma.balanceConsumptionAllocation.count({
      where: { id: splitAllocationId! },
    })).toBe(0);
  }, GENERIC_REPAIR_TRANSACTION_TIMEOUT_MS + 30_000);

  it('rolls back semantic proofs and generic audits together after a mid-transaction failure', async () => {
    const fixture = legacyPersonalProofCombinationFixture();
    await seedMigrationOpeningRetirementFixture(prisma, fixture);
    const plan = buildBalanceLedgerRepairPlan(
      fixture.snapshot,
      new Date('2026-07-18T12:01:52.353Z'),
    );
    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    const databaseBinding = await loadRepairDatabaseBinding(prisma);
    const runId = `legacy-personal-proof-rollback-run-${randomUUID()}`;
    await prisma.balanceLedgerRepairRun.create({
      data: { id: runId, status: 'RUNNING', planHash: plan.replayHash },
    });
    const rollbackSentinel = 'ROLLBACK_AFTER_LEGACY_PERSONAL_PROOF_AND_AUDIT';

    await expect(prisma.$transaction(async (tx) => {
      await loadRepairDatabaseBinding(tx, databaseBinding);
      const repairAccount = await tx.balanceLedgerRepairAccount.create({
        data: {
          runId,
          billingAccountId: fixture.snapshot.billingAccountId,
          status: 'RUNNING',
          preconditionHash: plan.preconditionHash,
          replayHash: plan.replayHash,
          beforeSnapshot: fixture.snapshot as unknown as Prisma.InputJsonValue,
        },
      });
      await tx.$executeRaw`
        SELECT set_config('billing.balance_ledger_repair_run_id', ${runId}, TRUE)`;
      await registerLegacyVoucherFundingProofsSetBased(
        tx,
        runId,
        repairAccount.id,
        fixture.snapshot.billingAccountId,
        plan.legacyVoucherProofMutations,
        {
          financeApprovalRef: 'FIN-ROLLBACK-PROOF-001',
          technicalApprovalRef: 'TECH-ROLLBACK-PROOF-001',
        },
      );
      await registerPersonalDebtAllocationProofsSetBased(
        tx,
        runId,
        repairAccount.id,
        fixture.snapshot.billingAccountId,
        plan.personalDebtAllocationMutations,
      );
      const staged = await stageRepairMutations(tx, {
        ...plan,
        transactionSequenceMutations: [],
        allocationMutations: [],
        allocationSequenceMutations: [],
        unreconciledGrantMutations: [],
        canonicalAllocationMutations: [],
        migrationOpeningDebtMutations: [],
      });
      await registerAllocationMutationAuditsFromStage(
        tx,
        runId,
        repairAccount.id,
        fixture.snapshot.billingAccountId,
        staged.allocationCount,
      );
      const [written] = await tx.$queryRaw<Array<{
        personalProofCount: bigint;
        voucherProofCount: bigint;
        allocationAuditCount: bigint;
      }>>`
        SELECT
          (SELECT COUNT(*) FROM "balance_ledger_personal_debt_allocation_repairs"
            WHERE "run_id" = ${runId}) AS "personalProofCount",
          (SELECT COUNT(*) FROM "balance_ledger_voucher_funding_repairs"
            WHERE "run_id" = ${runId}) AS "voucherProofCount",
          (SELECT COUNT(*) FROM "balance_ledger_allocation_repairs"
            WHERE "run_id" = ${runId}) AS "allocationAuditCount"`;
      expect(written).toEqual({
        personalProofCount: BigInt(3),
        voucherProofCount: BigInt(1),
        allocationAuditCount: BigInt(3),
      });
      throw new Error(rollbackSentinel);
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: GENERIC_REPAIR_TRANSACTION_TIMEOUT_MS,
    })).rejects.toThrow(rollbackSentinel);

    const [repairCount, proofCount, voucherCount, auditCount, account] = await Promise.all([
      prisma.balanceLedgerRepairAccount.count({ where: { runId } }),
      prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) AS count FROM "balance_ledger_personal_debt_allocation_repairs"
        WHERE "run_id" = ${runId}`,
      prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) AS count FROM "balance_ledger_voucher_funding_repairs"
        WHERE "run_id" = ${runId}`,
      prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*) AS count FROM "balance_ledger_allocation_repairs"
        WHERE "run_id" = ${runId}`,
      prisma.billingAccount.findUniqueOrThrow({
        where: { id: fixture.snapshot.billingAccountId },
        select: { balanceGrantLedgerStatus: true },
      }),
    ]);
    expect(repairCount).toBe(0);
    expect(proofCount).toEqual([{ count: BigInt(0) }]);
    expect(voucherCount).toEqual([{ count: BigInt(0) }]);
    expect(auditCount).toEqual([{ count: BigInt(0) }]);
    expect(account.balanceGrantLedgerStatus).toBe('LEGACY_DIRTY');
    for (const mutation of plan.personalDebtAllocationMutations) {
      const source = await prisma.balanceConsumptionAllocation.findUniqueOrThrow({
        where: { id: mutation.sourceAllocationId },
      });
      expect(source.source).toBe('BALANCE_GRANT');
      expect(source.amountUsd.toFixed(12)).toBe(mutation.expectedSourceAllocation.amountUsd);
      if (mutation.createdDebtAllocationId) {
        expect(await prisma.balanceConsumptionAllocation.findUnique({
          where: { id: mutation.createdDebtAllocationId },
        })).toBeNull();
      }
    }
  }, GENERIC_REPAIR_TRANSACTION_TIMEOUT_MS + 30_000);

  it('commits the exact migration-opening retirement through terminal canonical promotion', async () => {
    const fixture = migrationOpeningRetirementFixture();
    await seedMigrationOpeningRetirementFixture(prisma, fixture);
    const plan = buildBalanceLedgerRepairPlan(
      fixture.snapshot,
      new Date('2026-07-18T12:01:52.353Z'),
    );
    expect(plan).toEqual(expect.objectContaining({
      status: 'READY',
      currentDebtUsd: '0.000000000000',
      legacySettledDebtUsd: '0.214852000000',
      expectedSettlementCount: 1,
      migrationOpeningDebtMutations: [expect.objectContaining({
        allocationId: fixture.migrationAllocationId,
        grantId: fixture.migrationGrantId,
        source: 'NEGATIVE_BALANCE',
        settledUsd: '0.214852000000',
      })],
    }));
    if (plan.status !== 'READY') return;

    const databaseBinding = await loadRepairDatabaseBinding(prisma);
    const runId = `migration-opening-run-${randomUUID()}`;
    await prisma.balanceLedgerRepairRun.create({
      data: {
        id: runId,
        status: 'RUNNING',
        planHash: plan.replayHash,
        initiatedBy: 'balance-ledger-retirement-integration',
      },
    });

    await expect(applyReadyPlan(runId, plan, databaseBinding, prisma))
      .resolves.toBe('APPLIED');

    const [
      account,
      retiredGrant,
      initialGrant,
      laterGrant,
      debtAllocation,
      settlements,
      repairAccount,
      retirementRows,
    ] = await Promise.all([
      prisma.billingAccount.findUniqueOrThrow({
        where: { id: fixture.snapshot.billingAccountId },
        select: {
          balanceGrantLedgerStatus: true,
          balanceGrantLedgerVersion: true,
          balanceGrantLedgerHash: true,
          balanceGrantLedgerThroughTransactionId: true,
        },
      }),
      prisma.balanceGrant.findUnique({ where: { id: fixture.migrationGrantId } }),
      prisma.balanceGrant.findUniqueOrThrow({ where: { id: fixture.initialGrantId } }),
      prisma.balanceGrant.findUniqueOrThrow({ where: { id: fixture.laterGrantId } }),
      prisma.balanceConsumptionAllocation.findUniqueOrThrow({
        where: { id: fixture.migrationAllocationId },
      }),
      prisma.enterpriseCreditSettlement.findMany({
        where: {
          billingAccountId: fixture.snapshot.billingAccountId,
          repairRunId: runId,
        },
      }),
      prisma.balanceLedgerRepairAccount.findUniqueOrThrow({
        where: {
          runId_billingAccountId: {
            runId,
            billingAccountId: fixture.snapshot.billingAccountId,
          },
        },
      }),
      prisma.$queryRaw<Array<{
        operationKey: string;
        grantId: string;
        allocationId: string;
        beforeSnapshot: Record<string, unknown>;
      }>>`
        SELECT
          "operation_key" AS "operationKey",
          "grant_id" AS "grantId",
          "allocation_id" AS "allocationId",
          "before_snapshot" AS "beforeSnapshot"
        FROM "balance_ledger_grant_retirement_repairs"
        WHERE "run_id" = ${runId}
          AND "billing_account_id" = ${fixture.snapshot.billingAccountId}`,
    ]);

    expect(account).toEqual({
      balanceGrantLedgerStatus: 'RECONCILED_V2',
      balanceGrantLedgerVersion: 2,
      balanceGrantLedgerHash: plan.replayHash,
      balanceGrantLedgerThroughTransactionId: fixture.snapshot.transactions.at(-1)!.id,
    });
    expect(retiredGrant).toBeNull();
    expect(initialGrant.remainingAmountUsd.toFixed(12)).toBe('0.000000000000');
    expect(initialGrant.remainingPaidAmountUsd?.toFixed(12)).toBe('0.000000000000');
    expect(initialGrant.remainingBonusAmountUsd?.toFixed(12)).toBe('0.000000000000');
    expect(laterGrant.remainingAmountUsd.toFixed(12)).toBe('0.585148000000');
    expect(laterGrant.remainingPaidAmountUsd?.toFixed(12)).toBe('0.585148000000');
    expect(laterGrant.remainingBonusAmountUsd?.toFixed(12)).toBe('0.000000000000');
    expect({
      source: debtAllocation.source,
      balanceGrantId: debtAllocation.balanceGrantId,
      amountUsd: debtAllocation.amountUsd.toFixed(12),
      recognizedRevenueUsd: debtAllocation.recognizedRevenueUsd.toFixed(12),
      bonusConsumedUsd: debtAllocation.bonusConsumedUsd.toFixed(12),
      discountRate: debtAllocation.discountRate.toFixed(12),
      settledUsd: debtAllocation.settledUsd.toFixed(12),
      settledAt: debtAllocation.settledAt?.toISOString(),
    }).toEqual({
      source: 'NEGATIVE_BALANCE',
      balanceGrantId: null,
      amountUsd: '0.214852000000',
      recognizedRevenueUsd: '0.214852000000',
      bonusConsumedUsd: '0.000000000000',
      discountRate: '0.000000000000',
      settledUsd: '0.214852000000',
      settledAt: '2026-07-09T06:22:48.807Z',
    });
    expect(settlements).toHaveLength(1);
    expect({
      allocationId: settlements[0].allocationId,
      repaymentTransactionId: settlements[0].repaymentTransactionId,
      balanceGrantId: settlements[0].balanceGrantId,
      debtSource: settlements[0].debtSource,
      trigger: settlements[0].trigger,
      amountUsd: settlements[0].amountUsd.toFixed(12),
      paidUsd: settlements[0].paidUsd.toFixed(12),
      bonusUsd: settlements[0].bonusUsd.toFixed(12),
    }).toEqual({
      allocationId: fixture.migrationAllocationId,
      repaymentTransactionId: fixture.snapshot.transactions[2].id,
      balanceGrantId: fixture.laterGrantId,
      debtSource: 'NEGATIVE_BALANCE',
      trigger: 'REPAIR',
      amountUsd: '0.214852000000',
      paidUsd: '0.214852000000',
      bonusUsd: '0.000000000000',
    });
    expect(repairAccount.status).toBe('APPLIED');
    expect(repairAccount.afterSnapshot).toEqual(expect.objectContaining({
      ledgerStatus: 'RECONCILED_V2',
      migrationOpeningDebtMutations: plan.migrationOpeningDebtMutations,
    }));
    expect(retirementRows).toEqual([expect.objectContaining({
      operationKey: `repair:migration-opening-retirement:${runId}:${fixture.migrationGrantId}`,
      grantId: fixture.migrationGrantId,
      allocationId: fixture.migrationAllocationId,
      beforeSnapshot: expect.objectContaining({
        id: fixture.migrationGrantId,
        billing_account_id: fixture.snapshot.billingAccountId,
        source: 'MIGRATION_OPENING',
        paid_amount_usd: 0.214852,
      }),
    })]);
  }, GENERIC_REPAIR_TRANSACTION_TIMEOUT_MS + 30_000);

  it('rolls back allocation rewrite, retirement proof, and grant delete without terminal promotion', async () => {
    const fixture = migrationOpeningRetirementFixture();
    await seedMigrationOpeningRetirementFixture(prisma, fixture);
    const plan = buildBalanceLedgerRepairPlan(
      fixture.snapshot,
      new Date('2026-07-18T12:01:52.353Z'),
    );
    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    const mutation = plan.migrationOpeningDebtMutations[0];
    expect(mutation).toBeDefined();
    const incompleteMutation: typeof mutation = {
      ...mutation,
      recognizedRevenueUsd: '0.000000000000',
      bonusConsumedUsd: '0.000000000000',
      settledUsd: '0.000000000000',
      settledAt: null,
    };
    const runId = `migration-opening-incomplete-run-${randomUUID()}`;
    await prisma.balanceLedgerRepairRun.create({
      data: {
        id: runId,
        status: 'RUNNING',
        planHash: plan.replayHash,
        initiatedBy: 'balance-ledger-retirement-incomplete-integration',
      },
    });

    await expect(prisma.$transaction(async (tx) => {
      const repairAccount = await tx.balanceLedgerRepairAccount.create({
        data: {
          runId,
          billingAccountId: fixture.snapshot.billingAccountId,
          status: 'RUNNING',
          preconditionHash: plan.preconditionHash,
          replayHash: plan.replayHash,
          beforeSnapshot: JSON.parse(JSON.stringify(fixture.snapshot)) as Prisma.InputJsonValue,
        },
      });
      await tx.$executeRaw`
        SELECT set_config('billing.balance_ledger_repair_run_id', ${runId}, TRUE)`;
      const staged = await stageRepairMutations(tx, {
        ...plan,
        transactionSequenceMutations: [],
        allocationMutations: [],
        allocationSequenceMutations: [],
        unreconciledGrantMutations: [],
        canonicalAllocationMutations: [],
        migrationOpeningDebtMutations: [incompleteMutation],
        personalDebtAllocationMutations: [],
      });
      await registerAllocationMutationAuditsFromStage(
        tx,
        runId,
        repairAccount.id,
        fixture.snapshot.billingAccountId,
        staged.allocationCount,
      );
      await assertCompleteMutationAuditSets(
        tx,
        runId,
        repairAccount.id,
        fixture.snapshot.billingAccountId,
        staged,
      );
      await applyAllocationMutationsFromStage(
        tx,
        runId,
        repairAccount.id,
        fixture.snapshot.billingAccountId,
        staged.allocationCount,
      );
      await registerMigrationOpeningGrantRetirementsSetBased(
        tx,
        runId,
        repairAccount.id,
        fixture.snapshot.billingAccountId,
        [incompleteMutation],
      );
      await retireMigrationOpeningGrantsSetBased(
        tx,
        runId,
        repairAccount.id,
        fixture.snapshot.billingAccountId,
        [incompleteMutation],
      );
      // Deliberately omit settlement, grant compression, APPLIED audit, and
      // RECONCILED_V2 promotion. The deferred terminal guard must reject the
      // commit and roll back every preceding financial mutation.
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 30_000,
    })).rejects.toThrow('migration opening retirement cannot commit before canonical promotion');

    const [grant, allocation, repairAccountCount, allocationRepairCount, retirementCount] = await Promise.all([
      prisma.balanceGrant.findUnique({ where: { id: fixture.migrationGrantId } }),
      prisma.balanceConsumptionAllocation.findUniqueOrThrow({
        where: { id: fixture.migrationAllocationId },
      }),
      prisma.balanceLedgerRepairAccount.count({ where: { runId } }),
      prisma.balanceLedgerAllocationRepair.count({ where: { runId } }),
      prisma.$queryRaw<Array<{ count: bigint }>>`
        SELECT COUNT(*)::BIGINT AS "count"
        FROM "balance_ledger_grant_retirement_repairs"
        WHERE "run_id" = ${runId}`,
    ]);
    expect(grant).not.toBeNull();
    expect({
      source: allocation.source,
      balanceGrantId: allocation.balanceGrantId,
      amountUsd: allocation.amountUsd.toFixed(12),
      recognizedRevenueUsd: allocation.recognizedRevenueUsd.toFixed(12),
      settledUsd: allocation.settledUsd.toFixed(12),
      ledgerSequence: allocation.ledgerSequence,
    }).toEqual({
      source: 'BALANCE_GRANT',
      balanceGrantId: fixture.migrationGrantId,
      amountUsd: '0.214852000000',
      recognizedRevenueUsd: '0.214852000000',
      settledUsd: '0.000000000000',
      ledgerSequence: BigInt(-2),
    });
    expect(repairAccountCount).toBe(0);
    expect(allocationRepairCount).toBe(0);
    expect(retirementCount).toEqual([{ count: BigInt(0) }]);
  }, 60_000);

  it('drains queued pair canonical events while dirty and re-arms the final drain', async () => {
    await prisma.$transaction(async (tx) => {
      const triggers = await tx.$queryRaw<Array<{
        triggerName: string;
        tableName: string;
        functionName: string;
        enabled: string;
        constraintType: string;
        deferrable: boolean;
        initiallyDeferred: boolean;
      }>>`
        SELECT
          trigger_row."tgname" AS "triggerName",
          table_row."relname" AS "tableName",
          function_row."proname" AS "functionName",
          trigger_row."tgenabled" AS "enabled",
          constraint_row."contype" AS "constraintType",
          constraint_row."condeferrable" AS "deferrable",
          constraint_row."condeferred" AS "initiallyDeferred"
        FROM "pg_trigger" trigger_row
        JOIN "pg_class" table_row ON table_row."oid" = trigger_row."tgrelid"
        JOIN "pg_namespace" schema_row ON schema_row."oid" = table_row."relnamespace"
        JOIN "pg_proc" function_row ON function_row."oid" = trigger_row."tgfoid"
        JOIN "pg_constraint" constraint_row
          ON constraint_row."oid" = trigger_row."tgconstraint"
        WHERE schema_row."nspname" = 'public'
          AND trigger_row."tgname" IN (
            'balance_transactions_clean_canonical_deferred',
            'balance_debt_allocations_clean_canonical_deferred',
            'balance_grants_clean_canonical_deferred'
          )
        ORDER BY trigger_row."tgname"`;
      expect(triggers).toEqual([
        {
          triggerName: 'balance_debt_allocations_clean_canonical_deferred',
          tableName: 'balance_consumption_allocations',
          functionName: 'assert_clean_account_wallet_canonical_deferred',
          enabled: 'O',
          constraintType: 't',
          deferrable: true,
          initiallyDeferred: true,
        },
        {
          triggerName: 'balance_grants_clean_canonical_deferred',
          tableName: 'balance_grants',
          functionName: 'assert_clean_account_wallet_canonical_deferred',
          enabled: 'O',
          constraintType: 't',
          deferrable: true,
          initiallyDeferred: true,
        },
        {
          triggerName: 'balance_transactions_clean_canonical_deferred',
          tableName: 'balance_transactions',
          functionName: 'assert_clean_account_wallet_canonical_deferred',
          enabled: 'O',
          constraintType: 't',
          deferrable: true,
          initiallyDeferred: true,
        },
      ]);
      expect(triggers.map((row) => row.triggerName).sort()).toEqual(
        [...ENTERPRISE_ABSORB_CANONICAL_CONSTRAINTS].sort(),
      );

      await tx.$executeRawUnsafe(`CREATE TEMP TABLE "pair_drain_event_counts" (
        "kind" TEXT PRIMARY KEY,
        "event_count" INTEGER NOT NULL DEFAULT 0
      ) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`INSERT INTO "pair_drain_event_counts" ("kind")
        VALUES ('transaction'), ('allocation'), ('grant')`);
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE "pair_drain_transaction_events" (
        "id" INTEGER
      ) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE "pair_drain_allocation_events" (
        "id" INTEGER
      ) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`CREATE TEMP TABLE "pair_drain_grant_events" (
        "id" INTEGER
      ) ON COMMIT DROP`);
      await tx.$executeRawUnsafe(`CREATE FUNCTION pg_temp."record_pair_drain_event"()
        RETURNS TRIGGER LANGUAGE plpgsql AS $function$
        BEGIN
          UPDATE "pair_drain_event_counts"
          SET "event_count" = "event_count" + 1
          WHERE "kind" = TG_ARGV[0];
          RETURN NULL;
        END
        $function$`);
      await tx.$executeRawUnsafe(`CREATE CONSTRAINT TRIGGER
        "balance_transactions_clean_canonical_deferred"
        AFTER INSERT ON "pair_drain_transaction_events"
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        EXECUTE FUNCTION pg_temp."record_pair_drain_event"('transaction')`);
      await tx.$executeRawUnsafe(`CREATE CONSTRAINT TRIGGER
        "balance_debt_allocations_clean_canonical_deferred"
        AFTER INSERT ON "pair_drain_allocation_events"
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        EXECUTE FUNCTION pg_temp."record_pair_drain_event"('allocation')`);
      await tx.$executeRawUnsafe(`CREATE CONSTRAINT TRIGGER
        "balance_grants_clean_canonical_deferred"
        AFTER INSERT ON "pair_drain_grant_events"
        DEFERRABLE INITIALLY DEFERRED FOR EACH ROW
        EXECUTE FUNCTION pg_temp."record_pair_drain_event"('grant')`);
      await tx.$executeRawUnsafe(`INSERT INTO "pair_drain_transaction_events"
        SELECT value FROM generate_series(1, 3) value`);
      await tx.$executeRawUnsafe(`INSERT INTO "pair_drain_allocation_events"
        SELECT value FROM generate_series(1, 3) value`);
      await tx.$executeRawUnsafe(`INSERT INTO "pair_drain_grant_events"
        SELECT value FROM generate_series(1, 3) value`);
      const counts = async (): Promise<Array<{ kind: string; eventCount: number }>> => (
        tx.$queryRaw<Array<{ kind: string; eventCount: number }>>`
          SELECT "kind", "event_count" AS "eventCount"
          FROM "pair_drain_event_counts" ORDER BY "kind"`
      );
      expect(await counts()).toEqual([
        { kind: 'allocation', eventCount: 0 },
        { kind: 'grant', eventCount: 0 },
        { kind: 'transaction', eventCount: 0 },
      ]);
      await flushEnterpriseAbsorbCanonicalConstraintsWhileLegacyDirty(tx);
      expect(await counts()).toEqual([
        { kind: 'allocation', eventCount: 3 },
        { kind: 'grant', eventCount: 3 },
        { kind: 'transaction', eventCount: 3 },
      ]);

      await tx.$executeRawUnsafe('INSERT INTO "pair_drain_transaction_events" VALUES (4)');
      await tx.$executeRawUnsafe('INSERT INTO "pair_drain_allocation_events" VALUES (4)');
      await tx.$executeRawUnsafe('INSERT INTO "pair_drain_grant_events" VALUES (4)');
      expect(await counts()).toEqual([
        { kind: 'allocation', eventCount: 3 },
        { kind: 'grant', eventCount: 3 },
        { kind: 'transaction', eventCount: 3 },
      ]);

      await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');
      expect(await counts()).toEqual([
        { kind: 'allocation', eventCount: 4 },
        { kind: 'grant', eventCount: 4 },
        { kind: 'transaction', eventCount: 4 },
      ]);
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 30_000,
    });
  });

  it('projects reversed UUID rows into the database canonical FIFO order', async () => {
    const snapshot = reversedUuidFifoSnapshot();
    const plan = buildBalanceLedgerRepairPlan(snapshot, new Date('2026-07-17T01:00:00.000Z'));
    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    expect(plan.canonicalAllocationMutations).toEqual([]);
    const sequenceByAllocationId = new Map(plan.allocationSequenceMutations.map((mutation) => (
      [mutation.allocationId, mutation.ledgerSequence]
    )));
    expect(sequenceByAllocationId).toEqual(new Map([
      ['fifo-consume-first-row', '-3'],
      ['z-fifo-first-grant-row', '-2'],
      ['a-fifo-later-grant-row', '-1'],
    ]));

    const rollbackSentinel = 'ROLLBACK_FIFO_PROJECTION_FIXTURE';
    await expect(prisma.$transaction(async (tx) => {
      await seedFifoProjection(tx, snapshot, sequenceByAllocationId);
      const path = [
        'fifo-fund-first',
        'fifo-consume-first',
        'fifo-fund-later',
        'fifo-consume-cross',
      ];
      await tx.$executeRaw`
        SELECT "assert_balance_allocation_sequence_order"(
          ${snapshot.billingAccountId}, ${path}::TEXT[]
        )`;
      await tx.$executeRaw`
        SELECT "assert_balance_ledger_canonical_replay"(
          ${snapshot.billingAccountId}, 'personal', 'NEGATIVE_BALANCE',
          'CREATE', 'fifo-projection-run', ${path}::TEXT[]
        )`;
      const rows = await tx.balanceConsumptionAllocation.findMany({
        where: { billingAccountId: snapshot.billingAccountId },
        orderBy: { ledgerSequence: 'asc' },
        select: { id: true, balanceGrantId: true, ledgerSequence: true },
      });
      expect(rows).toEqual([
        {
          id: 'fifo-consume-first-row',
          balanceGrantId: 'fifo-grant-first',
          ledgerSequence: BigInt(-3),
        },
        {
          id: 'z-fifo-first-grant-row',
          balanceGrantId: 'fifo-grant-first',
          ledgerSequence: BigInt(-2),
        },
        {
          id: 'a-fifo-later-grant-row',
          balanceGrantId: 'fifo-grant-later',
          ledgerSequence: BigInt(-1),
        },
      ]);
      throw new Error(rollbackSentinel);
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 30_000,
    })).rejects.toThrow(rollbackSentinel);
  });

  it('keeps the database FIFO guard authoritative over UUID-contiguous sequences', async () => {
    const snapshot = reversedUuidFifoSnapshot();
    const uuidOrderedSequences = new Map([
      ['fifo-consume-first-row', '-3'],
      ['a-fifo-later-grant-row', '-2'],
      ['z-fifo-first-grant-row', '-1'],
    ]);
    await expect(prisma.$transaction(async (tx) => {
      await seedFifoProjection(tx, snapshot, uuidOrderedSequences);
      const path = [
        'fifo-fund-first',
        'fifo-consume-first',
        'fifo-fund-later',
        'fifo-consume-cross',
      ];
      // Contiguous sequence validation alone passes this historically wrong
      // ordering; the independent grant replay must still reject it.
      await tx.$executeRaw`
        SELECT "assert_balance_allocation_sequence_order"(
          ${snapshot.billingAccountId}, ${path}::TEXT[]
        )`;
      await tx.$executeRaw`
        SELECT "assert_balance_ledger_canonical_replay"(
          ${snapshot.billingAccountId}, 'personal', 'NEGATIVE_BALANCE',
          'CREATE', 'fifo-projection-run', ${path}::TEXT[]
        )`;
      throw new Error('UUID_ORDER_UNEXPECTEDLY_PASSED_CANONICAL_REPLAY');
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 30_000,
    })).rejects.toThrow('balance canonical replay grant FIFO mismatch');
  });

  it('stages across the bounded row edge and registers every audit before any update', async () => {
    const billingAccountId = 'bounded-stage-account';
    const runId = 'bounded-stage-run';
    const repairAccountId = 'bounded-stage-repair-account';
    const rowCount = BOUNDED_STAGE_MAX_ROWS + 1;
    const plan = boundedStagePlan(billingAccountId, rowCount, rowCount);
    await prisma.$transaction(async (tx) => {
      await createTempRepairContract(tx, true);
      await seedRepairIdentity(tx, runId, repairAccountId, billingAccountId);
      await tx.$executeRaw`
        INSERT INTO "balance_transactions"
        SELECT 'bounded-tx-' || value, ${billingAccountId}, NULL, 'immutable-' || value
        FROM generate_series(1, ${rowCount}) value`;
      await tx.$executeRaw`
        INSERT INTO "balance_consumption_allocations"
        SELECT 'bounded-allocation-' || value, 'user', 'tenant', ${billingAccountId}, NULL,
          'bounded-tx-' || value, NULL, NULL, 'NEGATIVE_BALANCE', 1, 0, 0, 0, 0,
          NULL, NULL, TIMESTAMP '2026-07-17 00:00:00'
        FROM generate_series(1, ${rowCount}) value`;
      await installCompleteAuditSetGuard(tx, rowCount, rowCount);

      const staged = await stageRepairMutations(tx, plan);
      expect(staged).toEqual(expect.objectContaining({
        transactionCount: rowCount,
        allocationCount: rowCount,
        uploadChunkCount: 4,
        maxUploadRows: BOUNDED_STAGE_MAX_ROWS,
      }));
      expect(staged.maxUploadJsonBytes).toBeGreaterThan(0);
      expect(staged.maxUploadJsonBytes).toBeLessThanOrEqual(BOUNDED_STAGE_MAX_JSON_BYTES);
      await registerTransactionSequenceMutationAuditsFromStage(
        tx, runId, repairAccountId, billingAccountId, staged.transactionCount,
      );
      await registerAllocationMutationAuditsFromStage(
        tx, runId, repairAccountId, billingAccountId, staged.allocationCount,
      );
      const [auditFirst] = await tx.$queryRaw<Array<{
        transactionAuditCount: number;
        allocationAuditCount: number;
        transactionMutationCount: number;
        allocationMutationCount: number;
      }>>`
        SELECT
          (SELECT COUNT(*)::INTEGER FROM "balance_ledger_transaction_repairs")
            AS "transactionAuditCount",
          (SELECT COUNT(*)::INTEGER FROM "balance_ledger_allocation_repairs")
            AS "allocationAuditCount",
          (SELECT COUNT(*)::INTEGER FROM "balance_transactions"
            WHERE "ledger_sequence" IS NOT NULL) AS "transactionMutationCount",
          (SELECT COUNT(*)::INTEGER FROM "balance_consumption_allocations"
            WHERE "ledger_sequence" IS NOT NULL) AS "allocationMutationCount"`;
      expect(auditFirst).toEqual({
        transactionAuditCount: rowCount,
        allocationAuditCount: rowCount,
        transactionMutationCount: 0,
        allocationMutationCount: 0,
      });
      await assertCompleteMutationAuditSets(
        tx, runId, repairAccountId, billingAccountId, staged,
      );

      await applyTransactionSequenceMutationsFromStage(
        tx, runId, repairAccountId, billingAccountId, staged.transactionCount,
      );
      await applyAllocationMutationsFromStage(
        tx, runId, repairAccountId, billingAccountId, staged.allocationCount,
      );
      await expectExactSetBasedEvidence(tx, rowCount, rowCount);
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: GENERIC_REPAIR_TRANSACTION_TIMEOUT_MS,
    });
  }, 210_000);

  it('rejects one staged mutation that exceeds the four MiB parameter contract', async () => {
    const plan = boundedStagePlan('bounded-oversize-account', 1, 0);
    plan.transactionSequenceMutations[0] = {
      transactionId: 'x'.repeat(BOUNDED_STAGE_MAX_JSON_BYTES),
      expectedLedgerSequence: null,
      ledgerSequence: '-1',
    };
    await expect(prisma.$transaction(async (tx) => {
      await stageRepairMutations(tx, plan);
    })).rejects.toThrow('BOUNDED_STAGE_MUTATION_TOO_LARGE');
  });

  it('rolls back prior staged writes when the final row after the chunk edge fails CAS', async () => {
    const billingAccountId = 'bounded-stale-account';
    const runId = 'bounded-stale-run';
    const repairAccountId = 'bounded-stale-repair-account';
    const allocationCount = BOUNDED_STAGE_MAX_ROWS + 1;
    const plan = boundedStagePlan(billingAccountId, 1, allocationCount);
    await prisma.$transaction(async (tx) => {
      await createTempRepairContract(tx, false);
      await seedRepairIdentity(tx, runId, repairAccountId, billingAccountId);
      await tx.$executeRaw`
        INSERT INTO "balance_transactions"
        VALUES ('bounded-tx-1', ${billingAccountId}, NULL, 'immutable')`;
      await tx.$executeRaw`
        INSERT INTO "balance_consumption_allocations"
        SELECT 'bounded-allocation-' || value, 'user', 'tenant', ${billingAccountId}, NULL,
          'bounded-tx-1', NULL, NULL, 'NEGATIVE_BALANCE', 1, 0, 0, 0, 0, NULL,
          CASE WHEN value = ${allocationCount} THEN 999 ELSE NULL END,
          TIMESTAMP '2026-07-17 00:00:00'
        FROM generate_series(1, ${allocationCount}) value`;
      await installCompleteAuditSetGuard(tx, 1, allocationCount);
    });

    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL search_path = pg_temp, public');
      await tx.$executeRaw`SELECT set_config(
        'billing.balance_ledger_repair_run_id', ${runId}, TRUE
      )`;
      const staged = await stageRepairMutations(tx, plan);
      await registerTransactionSequenceMutationAuditsFromStage(
        tx, runId, repairAccountId, billingAccountId, staged.transactionCount,
      );
      await registerAllocationMutationAuditsFromStage(
        tx, runId, repairAccountId, billingAccountId, staged.allocationCount,
      );
      await applyTransactionSequenceMutationsFromStage(
        tx, runId, repairAccountId, billingAccountId, staged.transactionCount,
      );
      await applyAllocationMutationsFromStage(
        tx, runId, repairAccountId, billingAccountId, staged.allocationCount,
      );
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: GENERIC_REPAIR_TRANSACTION_TIMEOUT_MS,
    })).rejects.toThrow('STALE_ALLOCATION_AUDIT:CARDINALITY');

    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL search_path = pg_temp, public');
      const [state] = await tx.$queryRaw<Array<{
        transactionMutationCount: number;
        allocationMutationCount: number;
        staleSequence: string | null;
        transactionAuditCount: number;
        allocationAuditCount: number;
      }>>`
        SELECT
          (SELECT COUNT(*)::INTEGER FROM "balance_transactions"
            WHERE "ledger_sequence" IS NOT NULL) AS "transactionMutationCount",
          (SELECT COUNT(*)::INTEGER FROM "balance_consumption_allocations"
            WHERE "id" <> ${`bounded-allocation-${allocationCount}`}
              AND "ledger_sequence" IS NOT NULL) AS "allocationMutationCount",
          (SELECT "ledger_sequence"::TEXT FROM "balance_consumption_allocations"
            WHERE "id" = ${`bounded-allocation-${allocationCount}`}) AS "staleSequence",
          (SELECT COUNT(*)::INTEGER FROM "balance_ledger_transaction_repairs")
            AS "transactionAuditCount",
          (SELECT COUNT(*)::INTEGER FROM "balance_ledger_allocation_repairs")
            AS "allocationAuditCount"`;
      expect(state).toEqual({
        transactionMutationCount: 0,
        allocationMutationCount: 0,
        staleSequence: '999',
        transactionAuditCount: 0,
        allocationAuditCount: 0,
      });
      await tx.$executeRawUnsafe('DROP TABLE "balance_ledger_allocation_repairs"');
      await tx.$executeRawUnsafe('DROP TABLE "balance_ledger_transaction_repairs"');
      await tx.$executeRawUnsafe('DROP TABLE "balance_consumption_allocations"');
      await tx.$executeRawUnsafe('DROP TABLE "balance_transactions"');
      await tx.$executeRawUnsafe('DROP TABLE "balance_ledger_repair_accounts"');
      await tx.$executeRawUnsafe('DROP TABLE "balance_ledger_repair_runs"');
      await tx.$executeRawUnsafe('DROP TABLE "billing_accounts"');
    });
  }, 210_000);

  it('repairs the observed generic 6600/6597 history under production guards', async () => {
    const billingAccountId = 'generic-large-account';
    const runId = 'generic-large-run';
    const repairAccountId = 'generic-large-repair-account';
    const transactionCount = 6_600;
    const allocationCount = 6_597;
    await prisma.$transaction(async (tx) => {
      await createTempRepairContract(tx, true);
      await seedRepairIdentity(tx, runId, repairAccountId, billingAccountId);
      await tx.$executeRaw`
        INSERT INTO "balance_transactions"
        SELECT 'generic-tx-' || value, ${billingAccountId}, NULL, 'immutable-' || value
        FROM generate_series(1, ${transactionCount}) value`;
      await tx.$executeRaw`
        INSERT INTO "balance_consumption_allocations"
        SELECT 'generic-allocation-' || value, 'user', 'tenant', ${billingAccountId}, NULL,
          'generic-tx-' || value, NULL, NULL, 'NEGATIVE_BALANCE', 1, 0, 0, 0, 0,
          NULL, NULL, TIMESTAMP '2026-07-17 00:00:00'
        FROM generate_series(1, ${allocationCount}) value`;
      const stagingPlan = boundedStagePlan(
        billingAccountId,
        transactionCount,
        allocationCount,
      );
      stagingPlan.transactionSequenceMutations.forEach((mutation, index) => {
        mutation.transactionId = `generic-tx-${index + 1}`;
      });
      stagingPlan.allocationSequenceMutations.forEach((mutation, index) => {
        mutation.allocationId = `generic-allocation-${index + 1}`;
      });
      const staged = await stageRepairMutations(tx, stagingPlan);
      await registerTransactionSequenceMutationAuditsFromStage(
        tx, runId, repairAccountId, billingAccountId, staged.transactionCount,
      );
      await registerAllocationMutationAuditsFromStage(
        tx, runId, repairAccountId, billingAccountId, staged.allocationCount,
      );
      await assertCompleteMutationAuditSets(
        tx, runId, repairAccountId, billingAccountId, staged,
      );
      await applyTransactionSequenceMutationsFromStage(
        tx, runId, repairAccountId, billingAccountId, staged.transactionCount,
      );
      await applyAllocationMutationsFromStage(
        tx, runId, repairAccountId, billingAccountId, staged.allocationCount,
      );
      await expectExactSetBasedEvidence(tx, transactionCount, allocationCount);
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: GENERIC_REPAIR_TRANSACTION_TIMEOUT_MS,
    });
  }, 210_000);

  it('repairs the observed pair 2649/2643 history under the same exact guards', async () => {
    const billingAccountId = 'pair-large-account';
    const runId = 'pair-large-run';
    const repairAccountId = 'pair-large-repair-account';
    const transactionCount = 2_649;
    const allocationCount = 2_643;
    await prisma.$transaction(async (tx) => {
      await createTempRepairContract(tx, true);
      await seedRepairIdentity(tx, runId, repairAccountId, billingAccountId);
      await tx.$executeRaw`
        INSERT INTO "balance_transactions"
        SELECT 'pair-tx-' || value, ${billingAccountId}, NULL, 'immutable-' || value
        FROM generate_series(1, ${transactionCount}) value`;
      await tx.$executeRaw`
        INSERT INTO "balance_consumption_allocations"
        SELECT 'pair-allocation-' || value, 'user', 'tenant', ${billingAccountId}, NULL,
          'pair-tx-' || value, NULL, NULL, 'NEGATIVE_BALANCE', 3,
          CASE WHEN value = 1 THEN 1.25 ELSE 0 END,
          CASE WHEN value = 1 THEN 0.75 ELSE 0 END,
          0,
          CASE WHEN value = 1 THEN 2 ELSE 0 END,
          CASE WHEN value = 1 THEN TIMESTAMP '2026-07-17 01:02:03.456' ELSE NULL END,
          NULL, TIMESTAMP '2026-07-17 00:00:00'
        FROM generate_series(1, ${allocationCount}) value`;
      await applyPairTransactionSequenceMutationsSetBased(
        tx,
        runId,
        repairAccountId,
        billingAccountId,
        Array.from({ length: transactionCount }, (_, index) => ({
          transactionId: `pair-tx-${index + 1}`,
          expectedLedgerSequence: null as null,
          ledgerSequence: `-${index + 1}`,
        })),
      );
      await applyPairAllocationMutationsSetBased(
        tx,
        runId,
        repairAccountId,
        billingAccountId,
        Array.from({ length: allocationCount }, (_, index) => ({
          allocationId: `pair-allocation-${index + 1}`,
          expectedLedgerSequence: null,
          ledgerSequence: `-${index + 1}`,
          expectedRecognizedRevenueUsd: index === 0 ? '1.25' : '0',
          recognizedRevenueUsd: index === 0 ? '1.50' : '0',
          expectedBonusConsumedUsd: index === 0 ? '0.75' : '0',
          bonusConsumedUsd: index === 0 ? '0.50' : '0',
          expectedSettledUsd: index === 0 ? '2.00' : '0',
          settledUsd: index === 0 ? '2.00' : '0',
          expectedSettledAt: index === 0 ? '2026-07-17T01:02:03.456' : null,
          settledAt: index === 0 ? '2026-07-18T04:05:06.789' : null,
        })),
      );
      await expectExactSetBasedEvidence(tx, transactionCount, allocationCount);
    }, {
      isolationLevel: Prisma.TransactionIsolationLevel.Serializable,
      maxWait: 10_000,
      timeout: 180_000,
    });
  }, 210_000);

  it('preserves JSON key/null semantics across every generic allocation patch field', async () => {
    const billingAccountId = 'generic-shape-account';
    const runId = 'generic-shape-run';
    const repairAccountId = 'generic-shape-repair-account';
    await prisma.$transaction(async (tx) => {
      await createTempRepairContract(tx, true);
      await seedRepairIdentity(tx, runId, repairAccountId, billingAccountId);
      await tx.$executeRaw`
        INSERT INTO "balance_consumption_allocations" VALUES
          (
            'generic-canonical', 'canonical-user', 'canonical-tenant',
            ${billingAccountId}, NULL, 'canonical-transaction', NULL,
            'legacy-grant', 'BALANCE_GRANT', 10, 9, 1, 0.1, 0, NULL, NULL,
            TIMESTAMP '2026-07-17 01:02:03.123'
          ),
          (
            'generic-explicit-null', 'null-user', 'null-tenant',
            ${billingAccountId}, 'preserved-product', 'null-transaction',
            'preserved-token', 'grant-to-clear', 'UNRECONCILED_GRANT',
            4, 0, 0, 0, 1, TIMESTAMP '2026-07-17 02:03:04.234', NULL,
            TIMESTAMP '2026-07-17 02:00:00.000'
          )`;

      const plan = boundedStagePlan(billingAccountId, 0, 0);
      plan.canonicalAllocationMutations = [{
        allocationId: 'generic-canonical',
        expectedUserId: 'canonical-user',
        expectedTenantId: 'canonical-tenant',
        expectedProductId: null,
        expectedBalanceTransactionId: 'canonical-transaction',
        expectedTokenUsageId: null,
        expectedBalanceGrantId: 'legacy-grant',
        expectedSource: 'BALANCE_GRANT',
        expectedAmountUsd: '10',
        expectedRecognizedRevenueUsd: '9',
        expectedBonusConsumedUsd: '1',
        expectedDiscountRate: '0.1',
        expectedSettledUsd: '0',
        expectedSettledAt: null,
        expectedLedgerSequence: null,
        expectedCreatedAt: '2026-07-17T01:02:03.123Z',
        balanceGrantId: 'canonical-grant',
        amountUsd: '7.5',
        recognizedRevenueUsd: '6',
        bonusConsumedUsd: '1.5',
        discountRate: '0.2',
        ledgerSequence: '-11',
      }];
      plan.personalDebtAllocationMutations = [{
        proofVersion: 1,
        repairKind: 'LEGACY_DEBT_RECLASS_V1',
        transactionId: 'null-transaction',
        sourceAllocationId: 'generic-explicit-null',
        createdDebtAllocationId: null,
        expectedTransactionBeforeUsd: '1',
        expectedTransactionAfterUsd: '0',
        expectedSourceAllocation: {
          id: 'generic-explicit-null',
          billingAccountId,
          userId: 'null-user',
          tenantId: 'null-tenant',
          productId: 'preserved-product',
          balanceTransactionId: 'null-transaction',
          tokenUsageId: 'preserved-token',
          balanceGrantId: 'grant-to-clear',
          source: 'UNRECONCILED_GRANT',
          amountUsd: '4',
          recognizedRevenueUsd: '0',
          bonusConsumedUsd: '0',
          discountRate: '0',
          settledUsd: '1',
          settledAt: '2026-07-17T02:03:04.234',
          ledgerSequence: null,
          createdAt: '2026-07-17T02:00:00.000Z',
        },
        targetSourceAllocation: {
          id: 'generic-explicit-null',
          billingAccountId,
          userId: 'null-user',
          tenantId: 'null-tenant',
          productId: 'preserved-product',
          balanceTransactionId: 'null-transaction',
          tokenUsageId: 'preserved-token',
          balanceGrantId: null,
          source: 'NEGATIVE_BALANCE',
          amountUsd: '4',
          recognizedRevenueUsd: '0.75',
          bonusConsumedUsd: '0.25',
          discountRate: '0',
          settledUsd: '1',
          settledAt: null,
          ledgerSequence: null,
          createdAt: '2026-07-17T02:00:00.000Z',
        },
        targetDebtAllocation: null,
      }];
      const staged = await stageRepairMutations(tx, plan);
      await registerAllocationMutationAuditsFromStage(
        tx, runId, repairAccountId, billingAccountId, staged.allocationCount,
      );
      await assertCompleteMutationAuditSets(
        tx, runId, repairAccountId, billingAccountId, staged,
      );
      await applyAllocationMutationsFromStage(
        tx, runId, repairAccountId, billingAccountId, staged.allocationCount,
      );

      const rows = await tx.$queryRaw<Array<{
        id: string;
        source: string;
        balanceGrantId: string | null;
        productId: string | null;
        tokenUsageId: string | null;
        amountUsd: string;
        recognizedRevenueUsd: string;
        bonusConsumedUsd: string;
        discountRate: string;
        settledUsd: string;
        settledAt: string | null;
        ledgerSequence: string | null;
      }>>`
        SELECT allocation."id", allocation."source",
          allocation."balance_grant_id" AS "balanceGrantId",
          allocation."product_id" AS "productId",
          allocation."token_usage_id" AS "tokenUsageId",
          allocation."amount_usd"::TEXT AS "amountUsd",
          allocation."recognized_revenue_usd"::TEXT AS "recognizedRevenueUsd",
          allocation."bonus_consumed_usd"::TEXT AS "bonusConsumedUsd",
          allocation."discount_rate"::TEXT AS "discountRate",
          allocation."settled_usd"::TEXT AS "settledUsd",
          allocation."settled_at"::TEXT AS "settledAt",
          allocation."ledger_sequence"::TEXT AS "ledgerSequence"
        FROM "balance_consumption_allocations" allocation
        ORDER BY allocation."id"`;
      expect(rows).toEqual([
        {
          id: 'generic-canonical',
          source: 'BALANCE_GRANT',
          balanceGrantId: 'canonical-grant',
          productId: null,
          tokenUsageId: null,
          amountUsd: '7.5',
          recognizedRevenueUsd: '6',
          bonusConsumedUsd: '1.5',
          discountRate: '0.2',
          settledUsd: '0',
          settledAt: null,
          ledgerSequence: '-11',
        },
        {
          id: 'generic-explicit-null',
          source: 'NEGATIVE_BALANCE',
          balanceGrantId: null,
          productId: 'preserved-product',
          tokenUsageId: 'preserved-token',
          amountUsd: '4',
          recognizedRevenueUsd: '0.75',
          bonusConsumedUsd: '0.25',
          discountRate: '0',
          settledUsd: '1',
          settledAt: null,
          ledgerSequence: null,
        },
      ]);
      const [audit] = await tx.$queryRaw<Array<{
        auditCount: bigint;
        invalidAuditCount: bigint;
      }>>`
        SELECT COUNT(*) AS "auditCount",
          COUNT(*) FILTER (
            WHERE repair."after_snapshot" IS DISTINCT FROM to_jsonb(allocation)
          ) AS "invalidAuditCount"
        FROM "balance_ledger_allocation_repairs" repair
        JOIN "balance_consumption_allocations" allocation
          ON allocation."id" = repair."allocation_id"`;
      expect(audit).toEqual({ auditCount: BigInt(2), invalidAuditCount: BigInt(0) });
    });
  });

  it('fails closed on a stale allocation CAS and rolls the entire transaction back', async () => {
    const billingAccountId = 'stale-account';
    const runId = 'stale-run';
    const repairAccountId = 'stale-repair-account';
    await prisma.$transaction(async (tx) => {
      await createTempRepairContract(tx, false);
      await seedRepairIdentity(tx, runId, repairAccountId, billingAccountId);
      await tx.$executeRaw`
        INSERT INTO "balance_consumption_allocations" VALUES
          (
            'valid-allocation', 'user', 'tenant', ${billingAccountId}, NULL,
            'valid-tx', NULL, 'grant', 'BALANCE_GRANT', 1, 0, 0, 0, 0,
            NULL, NULL, TIMESTAMP '2026-07-17 00:00:00'
          ),
          (
            'stale-allocation', 'user', 'tenant', ${billingAccountId}, NULL,
            'stale-tx', NULL, 'grant', 'BALANCE_GRANT', 1, 0, 0, 0, 0,
            NULL, NULL, TIMESTAMP '2026-07-17 00:00:00'
          )`;
    });

    await expect(prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL search_path = pg_temp, public');
      await tx.$executeRaw`SELECT set_config(
        'billing.balance_ledger_repair_run_id', ${runId}, TRUE
      )`;
      const plan = boundedStagePlan(billingAccountId, 0, 0);
      plan.allocationSequenceMutations = [
        {
          allocationId: 'valid-allocation',
          expectedLedgerSequence: null,
          ledgerSequence: '-1',
        },
        {
          allocationId: 'stale-allocation',
          expectedLedgerSequence: null,
          ledgerSequence: '-2',
        },
      ];
      plan.canonicalAllocationMutations = [{
        allocationId: 'stale-allocation',
        expectedUserId: 'user',
        expectedTenantId: 'tenant',
        expectedProductId: 'stale-product',
        expectedBalanceTransactionId: 'stale-tx',
        expectedTokenUsageId: null,
        expectedBalanceGrantId: 'grant',
        expectedSource: 'BALANCE_GRANT',
        expectedAmountUsd: '1',
        expectedRecognizedRevenueUsd: '0',
        expectedBonusConsumedUsd: '0',
        expectedDiscountRate: '0',
        expectedSettledUsd: '0',
        expectedSettledAt: null,
        expectedLedgerSequence: null,
        expectedCreatedAt: '2026-07-17T00:00:00.000Z',
        balanceGrantId: 'grant',
        amountUsd: '1',
        recognizedRevenueUsd: '0',
        bonusConsumedUsd: '0',
        discountRate: '0',
        ledgerSequence: '-2',
      }];
      const staged = await stageRepairMutations(tx, plan);
      await registerAllocationMutationAuditsFromStage(
        tx, runId, repairAccountId, billingAccountId, staged.allocationCount,
      );
    })).rejects.toThrow('STALE_ALLOCATION_AUDIT:CARDINALITY:1/2');

    await prisma.$transaction(async (tx) => {
      await tx.$executeRawUnsafe('SET LOCAL search_path = pg_temp, public');
      const [state] = await tx.$queryRaw<Array<{
        allocationCount: bigint;
        mutatedCount: bigint;
        auditCount: bigint;
      }>>`
        SELECT COUNT(*) AS "allocationCount",
          COUNT(*) FILTER (WHERE allocation."ledger_sequence" IS NOT NULL) AS "mutatedCount",
          (SELECT COUNT(*) FROM "balance_ledger_allocation_repairs") AS "auditCount"
        FROM "balance_consumption_allocations" allocation
        WHERE allocation."id" IN ('valid-allocation', 'stale-allocation')`;
      expect(state).toEqual({
        allocationCount: BigInt(2),
        mutatedCount: BigInt(0),
        auditCount: BigInt(0),
      });
      await tx.$executeRawUnsafe('DROP TABLE "balance_ledger_allocation_repairs"');
      await tx.$executeRawUnsafe('DROP TABLE "balance_ledger_transaction_repairs"');
      await tx.$executeRawUnsafe('DROP TABLE "balance_consumption_allocations"');
      await tx.$executeRawUnsafe('DROP TABLE "balance_transactions"');
      await tx.$executeRawUnsafe('DROP TABLE "balance_ledger_repair_accounts"');
      await tx.$executeRawUnsafe('DROP TABLE "balance_ledger_repair_runs"');
      await tx.$executeRawUnsafe('DROP TABLE "billing_accounts"');
    });
  });
});
