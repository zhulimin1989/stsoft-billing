import { readFileSync } from 'fs';
import { resolve } from 'path';
import {
  ENTERPRISE_ABSORB_CANONICAL_CONSTRAINTS,
  EnterpriseAbsorbPairEvidenceSnapshot,
  buildEnterpriseAbsorbPairPlan,
  enterpriseAbsorbDatabaseEndpointSha256,
  enterpriseAbsorbSha256,
  flushEnterpriseAbsorbCanonicalConstraintsWhileLegacyDirty,
  parseEnterpriseAbsorbPlanFile,
} from '../../scripts/reconcile-enterprise-absorb-ledger';

const SHA_A = 'a'.repeat(64);
const SHA_B = 'b'.repeat(64);
const SHA_C = 'c'.repeat(64);
const SHA_D = 'd'.repeat(64);
const SHA_E = 'e'.repeat(64);

function pairSnapshot(): EnterpriseAbsorbPairEvidenceSnapshot {
  const sourceId = 'ba_personal_owner-1';
  const targetId = 'ba_enterprise_owner-1';
  const tenantId = 'tenant-1';
  const userId = 'owner-1';
  return {
    financialNow: '2026-07-17T00:00:00.000Z',
    sourceAccount: {
      id: sourceId,
      type: 'personal',
      ownerUserId: userId,
      status: 'active',
      currency: 'USD',
      ledgerStatus: 'LEGACY_DIRTY',
      ledgerVersion: 0,
      walletBalanceUsd: '0.000000000000',
    },
    targetAccount: {
      id: targetId,
      type: 'enterprise',
      ownerUserId: userId,
      status: 'active',
      currency: 'CNY',
      ledgerStatus: 'LEGACY_DIRTY',
      ledgerVersion: 0,
      walletBalanceUsd: '6.000000000000',
    },
    transferTenant: {
      id: tenantId,
      ownerUserId: userId,
      billingAccountId: targetId,
      status: 'active',
    },
    transactions: [
      {
        id: 'source-funding',
        billingAccountId: sourceId,
        userId,
        tenantId,
        productId: null,
        tokenUsageId: null,
        type: 'RECHARGE',
        amountUsd: '5.000000000000',
        balanceAfterUsd: '5.000000000000',
        description: '充值',
        orderId: 'source-order',
        operationKey: null,
        ledgerSequence: null,
        createdAt: '2026-07-07T00:00:00.500Z',
        xmin: '100',
      },
      {
        id: 'source-consume',
        billingAccountId: sourceId,
        userId,
        tenantId,
        productId: null,
        tokenUsageId: 'usage-source',
        type: 'CONSUME',
        amountUsd: '-1.000000000000',
        balanceAfterUsd: '4.000000000000',
        description: 'usage',
        orderId: null,
        operationKey: null,
        ledgerSequence: null,
        createdAt: '2026-07-07T00:00:30.000Z',
        xmin: '101',
      },
      {
        id: 'transfer-out',
        billingAccountId: sourceId,
        userId,
        tenantId,
        productId: null,
        tokenUsageId: null,
        type: 'ADJUST',
        amountUsd: '-4.000000000000',
        balanceAfterUsd: '0.000000000000',
        description: `enterprise-absorb:out to=${targetId}`,
        orderId: null,
        operationKey: null,
        ledgerSequence: null,
        createdAt: '2026-07-07T00:01:00.000Z',
        xmin: '777',
      },
      {
        id: 'transfer-in',
        billingAccountId: targetId,
        userId,
        tenantId,
        productId: null,
        tokenUsageId: null,
        type: 'ADJUST',
        amountUsd: '4.000000000000',
        balanceAfterUsd: '4.000000000000',
        description: `enterprise-absorb:in from=${sourceId}`,
        orderId: null,
        operationKey: null,
        ledgerSequence: null,
        createdAt: '2026-07-07T00:01:00.001Z',
        xmin: '777',
      },
      {
        id: 'target-consume',
        billingAccountId: targetId,
        userId,
        tenantId,
        productId: null,
        tokenUsageId: 'usage-target',
        type: 'CONSUME',
        amountUsd: '-1.000000000000',
        balanceAfterUsd: '3.000000000000',
        description: 'usage',
        orderId: null,
        operationKey: null,
        ledgerSequence: null,
        createdAt: '2026-07-07T00:01:30.000Z',
        xmin: '102',
      },
      {
        id: 'admin-adjust',
        billingAccountId: targetId,
        userId,
        tenantId,
        productId: null,
        tokenUsageId: null,
        type: 'ADJUST',
        amountUsd: '2.000000000000',
        balanceAfterUsd: '5.000000000000',
        description: '线下转账入账',
        orderId: null,
        operationKey: null,
        ledgerSequence: null,
        createdAt: '2026-07-07T00:02:00.000Z',
        xmin: '103',
      },
      {
        id: 'target-native-funding',
        billingAccountId: targetId,
        userId,
        tenantId,
        productId: null,
        tokenUsageId: null,
        type: 'RECHARGE',
        amountUsd: '1.000000000000',
        balanceAfterUsd: '6.000000000000',
        description: '充值',
        orderId: 'target-native-order',
        operationKey: null,
        ledgerSequence: null,
        createdAt: '2026-07-07T00:03:00.500Z',
        xmin: '104',
      },
    ],
    grants: [
      {
        id: 'moved-grant',
        billingAccountId: targetId,
        userId,
        tenantId,
        productId: null,
        orderId: 'source-order',
        source: 'RECHARGE',
        paidAmountUsd: '5.000000000000',
        bonusAmountUsd: '0.000000000000',
        grantedAmountUsd: '5.000000000000',
        remainingAmountUsd: '3.000000000000',
        remainingPaidAmountUsd: null,
        remainingBonusAmountUsd: null,
        discountRate: '1.000000000000',
        // Old writer sampled validFrom before the INSERT default createdAt.
        validFrom: '2026-07-07T00:00:00.499Z',
        expiresAt: '2027-07-07T00:00:00.499Z',
        isExpired: false,
        createdAt: '2026-07-07T00:00:00.500Z',
      },
      {
        id: 'target-native-grant',
        billingAccountId: targetId,
        userId,
        tenantId,
        productId: null,
        orderId: 'target-native-order',
        source: 'RECHARGE',
        paidAmountUsd: '1.000000000000',
        bonusAmountUsd: '0.000000000000',
        grantedAmountUsd: '1.000000000000',
        remainingAmountUsd: '1.000000000000',
        remainingPaidAmountUsd: null,
        remainingBonusAmountUsd: null,
        discountRate: '1.000000000000',
        validFrom: '2026-07-07T00:03:00.500Z',
        expiresAt: '2027-07-07T00:03:00.500Z',
        isExpired: false,
        createdAt: '2026-07-07T00:03:00.500Z',
      },
    ],
    allocations: [
      {
        id: 'source-allocation',
        billingAccountId: sourceId,
        userId,
        tenantId,
        productId: null,
        balanceTransactionId: 'source-consume',
        tokenUsageId: 'usage-source',
        balanceGrantId: 'moved-grant',
        source: 'BALANCE_GRANT',
        amountUsd: '1.000000000000',
        recognizedRevenueUsd: '1.000000000000',
        bonusConsumedUsd: '0.000000000000',
        discountRate: '1.000000000000',
        settledUsd: '0.000000000000',
        settledAt: null,
        ledgerSequence: null,
        createdAt: '2026-07-07T00:00:30.000Z',
      },
      {
        id: 'target-allocation',
        billingAccountId: targetId,
        userId,
        tenantId,
        productId: null,
        balanceTransactionId: 'target-consume',
        tokenUsageId: 'usage-target',
        balanceGrantId: 'moved-grant',
        source: 'BALANCE_GRANT',
        amountUsd: '1.000000000000',
        recognizedRevenueUsd: '1.000000000000',
        bonusConsumedUsd: '0.000000000000',
        discountRate: '1.000000000000',
        settledUsd: '0.000000000000',
        settledAt: null,
        ledgerSequence: null,
        createdAt: '2026-07-07T00:01:30.000Z',
      },
    ],
    settlements: [],
    orders: [
      {
        id: 'source-order',
        billingAccountId: sourceId,
        userId,
        tenantId,
        productId: null,
        orderType: 'RECHARGE',
        status: 'COMPLETED',
        currency: 'cny',
        amountCents: 500,
        bonusCents: 0,
        paidAt: '2026-07-07T00:00:00.100Z',
        completedAt: '2026-07-07T00:00:00.900Z',
        refundedAt: null,
        refundAmountCents: null,
        createdAt: '2026-07-07T00:00:00.000Z',
      },
      {
        id: 'target-native-order',
        billingAccountId: targetId,
        userId,
        tenantId,
        productId: null,
        orderType: 'RECHARGE',
        status: 'COMPLETED',
        currency: 'cny',
        amountCents: 100,
        bonusCents: 0,
        paidAt: '2026-07-07T00:03:00.100Z',
        completedAt: '2026-07-07T00:03:00.900Z',
        refundedAt: null,
        refundAmountCents: null,
        createdAt: '2026-07-07T00:03:00.000Z',
      },
    ],
    invoiceEvidence: [],
    idempotencyEvidence: [{
      key: `${`enterprise-recharge:${targetId}:`}legacy-key`,
      scope: 'admin:adjust-balance',
      userId,
      status: 'COMMITTED',
      result: {
        id: 'admin-adjust',
        userId,
        tenantId,
        productId: null,
        type: 'ADJUST',
        amountCents: 200,
        amountUsd: 2,
        balanceAfterCents: 500,
        balanceAfterUsd: 5,
        description: '线下转账入账',
        createdAt: '2026-07-07T00:02:00.000Z',
      },
      createdAt: '2026-07-07T00:01:59.990Z',
      expiresAt: '2026-08-07T00:02:00.000Z',
      snapshotSha256: SHA_A,
    }],
    expiryGrantIds: [],
    refundGrantIds: [],
    transactionRowsSha256: SHA_A,
    grantRowsSha256: SHA_B,
    allocationRowsSha256: SHA_C,
    settlementRowsSha256: SHA_D,
    orderRowsSha256: SHA_E,
    invoiceRowsSha256: SHA_A,
  };
}

describe('enterprise absorb pair repair planner', () => {
  it('proves the paired transfer, moved grant, and missing paid-only admin grant', () => {
    const plan = buildEnterpriseAbsorbPairPlan(pairSnapshot());

    expect(plan.status).toBe('READY_PAIR');
    if (plan.status !== 'READY_PAIR') return;
    expect(plan.transfer).toEqual({
      outTransactionId: 'transfer-out',
      inTransactionId: 'transfer-in',
      originalXmin: '777',
      amountUsd: '4.000000000000',
    });
    expect(plan.transferGrants).toEqual([expect.objectContaining({
      grantId: 'moved-grant',
      sourceFundingTransactionId: 'source-funding',
      transferredAmountUsd: '4.000000000000',
      sourceAllocationCount: 1,
      targetAllocationCount: 1,
    })]);
    expect(plan.adminGrantCreations).toEqual([expect.objectContaining({
      transactionId: 'admin-adjust',
      grantId: 'repair-admin-recharge:admin-adjust',
      amountUsd: '2.000000000000',
      validFrom: '2026-07-07T00:02:00.000Z',
      expiresAt: '2027-07-07T00:02:00.000Z',
    })]);
    expect(plan.source.transactionSequenceMutations).toHaveLength(3);
    expect(plan.target.transactionSequenceMutations).toHaveLength(4);
    expect(plan.source.grantMutations).toEqual([]);
    expect(plan.target.grantMutations).toEqual([
      {
        grantId: 'moved-grant',
        expectedRemainingAmountUsd: '3.000000000000',
        expectedRemainingPaidAmountUsd: null,
        expectedRemainingBonusAmountUsd: null,
        remainingAmountUsd: '3.000000000000',
        remainingPaidAmountUsd: '3.000000000000',
        remainingBonusAmountUsd: '0.000000000000',
      },
      {
        grantId: 'target-native-grant',
        expectedRemainingAmountUsd: '1.000000000000',
        expectedRemainingPaidAmountUsd: null,
        expectedRemainingBonusAmountUsd: null,
        remainingAmountUsd: '1.000000000000',
        remainingPaidAmountUsd: '1.000000000000',
        remainingBonusAmountUsd: '0.000000000000',
      },
    ]);
    expect(plan.source.allocationMutations).toHaveLength(1);
    expect(plan.target.allocationMutations).toHaveLength(1);
  });

  it('does not bind the plan hash to a moving PostgreSQL clock sample', () => {
    const first = buildEnterpriseAbsorbPairPlan(pairSnapshot());
    const laterSnapshot = pairSnapshot();
    laterSnapshot.financialNow = '2026-07-17T00:00:00.999Z';
    const later = buildEnterpriseAbsorbPairPlan(laterSnapshot);

    expect(first.status).toBe('READY_PAIR');
    expect(later.status).toBe('READY_PAIR');
    if (first.status !== 'READY_PAIR' || later.status !== 'READY_PAIR') return;
    expect(later.preconditionHash).toBe(first.preconditionHash);
    expect(later.pairReplayHash).toBe(first.pairReplayHash);
  });

  it('accepts the proven legacy validFrom ordering and rejects future-created or off-lifecycle dates', () => {
    const legacyTiming = buildEnterpriseAbsorbPairPlan(pairSnapshot());
    expect(legacyTiming.status).toBe('READY_PAIR');

    const activeButCreatedLater = pairSnapshot();
    activeButCreatedLater.grants[0].validFrom = '2026-07-07T00:00:00.501Z';
    expect(buildEnterpriseAbsorbPairPlan(activeButCreatedLater)).toEqual(expect.objectContaining({
      status: 'QUARANTINED_PAIR',
      reasons: expect.arrayContaining(['TRANSFER_GRANT_PROOF_MISMATCH:moved-grant']),
    }));

    const outsideLifecycle = pairSnapshot();
    outsideLifecycle.grants[0].validFrom = '2026-07-06T23:59:59.999Z';
    expect(buildEnterpriseAbsorbPairPlan(outsideLifecycle)).toEqual(expect.objectContaining({
      status: 'QUARANTINED_PAIR',
      reasons: expect.arrayContaining(['TRANSFER_GRANT_PROOF_MISMATCH:moved-grant']),
    }));
  });

  it('rejects globally duplicated recharge or grant facts for the moved order', () => {
    const duplicateOrderFacts = pairSnapshot();
    const foreignFunding = structuredClone(duplicateOrderFacts.transactions[0]);
    foreignFunding.id = 'foreign-funding';
    foreignFunding.billingAccountId = 'foreign-account';
    const foreignGrant = structuredClone(duplicateOrderFacts.grants[0]);
    foreignGrant.id = 'foreign-grant';
    foreignGrant.billingAccountId = 'foreign-account';
    duplicateOrderFacts.transactions.push(foreignFunding);
    duplicateOrderFacts.grants.push(foreignGrant);

    expect(buildEnterpriseAbsorbPairPlan(duplicateOrderFacts)).toEqual(expect.objectContaining({
      status: 'QUARANTINED_PAIR',
      reasons: expect.arrayContaining([
        'TRANSFER_ORDER_GLOBAL_CARDINALITY:moved-grant:2:2:2',
      ]),
    }));
  });

  it('rejects third-account facts linked only through pair grant, allocation, transaction, or repayment', () => {
    const crossAccountSettlement = pairSnapshot();
    const foreignTransactionAllocation = structuredClone(
      crossAccountSettlement.allocations.find((allocation) => allocation.id === 'target-allocation')!,
    );
    foreignTransactionAllocation.id = 'foreign-transaction-allocation';
    foreignTransactionAllocation.billingAccountId = 'foreign-account';
    foreignTransactionAllocation.balanceGrantId = null;
    foreignTransactionAllocation.source = 'ENTERPRISE_CREDIT';
    foreignTransactionAllocation.recognizedRevenueUsd = '0.000000000000';
    foreignTransactionAllocation.discountRate = '0.000000000000';
    crossAccountSettlement.allocations.push(foreignTransactionAllocation);
    crossAccountSettlement.settlements.push(
      {
        id: 'foreign-grant-settlement',
        billingAccountId: 'foreign-account',
        allocationId: 'foreign-allocation',
        repaymentTransactionId: 'foreign-funding',
        balanceGrantId: 'moved-grant',
        repairRunId: null,
        operationKey: 'foreign:grant-settlement',
        debtSource: 'ENTERPRISE_CREDIT',
        trigger: 'FUNDING',
        amountUsd: '1.000000000000',
        paidUsd: '1.000000000000',
        bonusUsd: '0.000000000000',
        occurredAt: '2026-07-07T00:04:00.000Z',
        createdAt: '2026-07-07T00:04:00.000Z',
      },
      {
        id: 'foreign-allocation-settlement',
        billingAccountId: 'foreign-account',
        allocationId: 'target-allocation',
        repaymentTransactionId: 'foreign-funding',
        balanceGrantId: null,
        repairRunId: null,
        operationKey: 'foreign:allocation-settlement',
        debtSource: 'ENTERPRISE_CREDIT',
        trigger: 'FUNDING',
        amountUsd: '1.000000000000',
        paidUsd: '1.000000000000',
        bonusUsd: '0.000000000000',
        occurredAt: '2026-07-07T00:04:00.000Z',
        createdAt: '2026-07-07T00:04:00.000Z',
      },
      {
        id: 'foreign-repayment-settlement',
        billingAccountId: 'foreign-account',
        allocationId: 'foreign-transaction-allocation',
        repaymentTransactionId: 'target-native-funding',
        balanceGrantId: null,
        repairRunId: null,
        operationKey: 'foreign:repayment-settlement',
        debtSource: 'ENTERPRISE_CREDIT',
        trigger: 'FUNDING',
        amountUsd: '1.000000000000',
        paidUsd: '1.000000000000',
        bonusUsd: '0.000000000000',
        occurredAt: '2026-07-07T00:03:00.500Z',
        createdAt: '2026-07-07T00:04:00.000Z',
      },
    );

    expect(buildEnterpriseAbsorbPairPlan(crossAccountSettlement)).toEqual(expect.objectContaining({
      status: 'QUARANTINED_PAIR',
      reasons: expect.arrayContaining([
        'CROSS_ACCOUNT_SETTLEMENT_GRANT_MISMATCH:foreign-grant-settlement:moved-grant',
        'CROSS_ACCOUNT_SETTLEMENT_ALLOCATION_MISMATCH:'
          + 'foreign-allocation-settlement:target-allocation',
        'CROSS_ACCOUNT_ALLOCATION_TRANSACTION_MISMATCH:'
          + 'foreign-transaction-allocation:target-consume',
        'CROSS_ACCOUNT_SETTLEMENT_REPAYMENT_MISMATCH:'
          + 'foreign-repayment-settlement:target-native-funding',
      ]),
    }));
  });

  it('rejects every source or target settlement in pair V1', () => {
    const invalidSettlementShapes = pairSnapshot();
    invalidSettlementShapes.settlements.push(
      {
        id: 'target-refund-netting',
        billingAccountId: invalidSettlementShapes.targetAccount.id,
        allocationId: 'target-allocation',
        repaymentTransactionId: 'target-native-funding',
        balanceGrantId: 'moved-grant',
        repairRunId: null,
        operationKey: 'target:refund-netting',
        debtSource: 'ENTERPRISE_CREDIT',
        trigger: 'REFUND_NETTING',
        amountUsd: '0.100000000000',
        paidUsd: '0.100000000000',
        bonusUsd: '0.000000000000',
        occurredAt: '2026-07-07T00:03:00.500Z',
        createdAt: '2026-07-07T00:03:00.500Z',
      },
      {
        id: 'target-repair-settlement',
        billingAccountId: invalidSettlementShapes.targetAccount.id,
        allocationId: 'target-allocation',
        repaymentTransactionId: 'target-native-funding',
        balanceGrantId: 'moved-grant',
        repairRunId: 'unexpected-repair-run',
        operationKey: 'target:repair-settlement',
        debtSource: 'ENTERPRISE_CREDIT',
        trigger: 'FUNDING',
        amountUsd: '0.100000000000',
        paidUsd: '0.100000000000',
        bonusUsd: '0.000000000000',
        occurredAt: '2026-07-07T00:03:00.500Z',
        createdAt: '2026-07-07T00:03:00.500Z',
      },
      {
        id: 'source-settlement',
        billingAccountId: invalidSettlementShapes.sourceAccount.id,
        allocationId: 'source-allocation',
        repaymentTransactionId: 'source-funding',
        balanceGrantId: null,
        repairRunId: null,
        operationKey: 'source:settlement',
        debtSource: 'NEGATIVE_BALANCE',
        trigger: 'FUNDING',
        amountUsd: '0.100000000000',
        paidUsd: '0.100000000000',
        bonusUsd: '0.000000000000',
        occurredAt: '2026-07-07T00:00:00.500Z',
        createdAt: '2026-07-07T00:00:00.500Z',
      },
      {
        id: 'target-missing-grant-settlement',
        billingAccountId: invalidSettlementShapes.targetAccount.id,
        allocationId: 'target-allocation',
        repaymentTransactionId: 'target-native-funding',
        balanceGrantId: 'missing-grant',
        repairRunId: null,
        operationKey: 'legacy:wrong-id',
        debtSource: 'ENTERPRISE_CREDIT',
        trigger: 'FUNDING',
        amountUsd: '0.100000000000',
        paidUsd: '0.100000000000',
        bonusUsd: '0.000000000000',
        occurredAt: '2026-07-07T00:03:00.500Z',
        createdAt: '2026-07-07T00:03:00.500Z',
      },
    );

    expect(buildEnterpriseAbsorbPairPlan(invalidSettlementShapes)).toEqual(expect.objectContaining({
      status: 'QUARANTINED_PAIR',
      reasons: expect.arrayContaining([
        'TARGET_SETTLEMENT_UNSUPPORTED:target-refund-netting',
        'TARGET_SETTLEMENT_UNSUPPORTED:target-repair-settlement',
        'SOURCE_SETTLEMENT_UNSUPPORTED:source-settlement',
        'TARGET_SETTLEMENT_UNSUPPORTED:target-missing-grant-settlement',
        'SETTLEMENT_GRANT_REFERENCE_INVALID:'
          + 'target-missing-grant-settlement:missing-grant',
      ]),
    }));
  });

  it('rejects a consume whose grant/debt split preserves total but not the pre-consume balance', () => {
    const wrongSplit = pairSnapshot();
    const targetAllocation = wrongSplit.allocations.find(
      (allocation) => allocation.id === 'target-allocation',
    )!;
    targetAllocation.amountUsd = '0.500000000000';
    targetAllocation.recognizedRevenueUsd = '0.500000000000';
    wrongSplit.allocations.push({
      ...structuredClone(targetAllocation),
      id: 'target-debt-allocation',
      balanceGrantId: null,
      source: 'ENTERPRISE_CREDIT',
      amountUsd: '0.500000000000',
      recognizedRevenueUsd: '0.000000000000',
      discountRate: '0.000000000000',
    });

    expect(buildEnterpriseAbsorbPairPlan(wrongSplit)).toEqual(expect.objectContaining({
      status: 'QUARANTINED_PAIR',
      reasons: expect.arrayContaining([
        'TARGET:CONSUME_ALLOCATION_SPLIT_INVALID:target-consume',
      ]),
    }));
  });

  it('quarantines source grant component mutations because this repair contract only owns target grants', () => {
    const sourceGrantSnapshot = pairSnapshot();
    const sourceGrant = structuredClone(sourceGrantSnapshot.grants[1]);
    sourceGrant.id = 'source-native-grant';
    sourceGrant.billingAccountId = sourceGrantSnapshot.sourceAccount.id;
    sourceGrant.remainingAmountUsd = '1.000000000000';
    sourceGrant.remainingPaidAmountUsd = null;
    sourceGrant.remainingBonusAmountUsd = null;
    sourceGrantSnapshot.grants.push(sourceGrant);

    expect(buildEnterpriseAbsorbPairPlan(sourceGrantSnapshot)).toEqual(expect.objectContaining({
      status: 'QUARANTINED_PAIR',
      reasons: expect.arrayContaining(['SOURCE_GRANT_COMPONENT_MUTATION_UNSUPPORTED']),
    }));
  });

  it('fails closed when tuple identity, order cents, invoice terminal state, or idempotency time is false', () => {
    const badXmin = pairSnapshot();
    badXmin.transactions.find((row) => row.id === 'transfer-in')!.xmin = '778';
    expect(buildEnterpriseAbsorbPairPlan(badXmin)).toEqual(expect.objectContaining({
      status: 'QUARANTINED_PAIR',
      reasons: expect.arrayContaining(['TRANSFER_PAIR_IMMUTABLE_FACT_MISMATCH']),
    }));

    const badOrder = pairSnapshot();
    badOrder.orders[0].amountCents = 499;
    expect(buildEnterpriseAbsorbPairPlan(badOrder)).toEqual(expect.objectContaining({
      status: 'QUARANTINED_PAIR',
      reasons: expect.arrayContaining(['TRANSFER_GRANT_PROOF_MISMATCH:moved-grant']),
    }));

    const pendingInvoice = pairSnapshot();
    pendingInvoice.invoiceEvidence.push({
      itemId: 'item-1',
      orderId: 'source-order',
      applicationId: 'application-1',
      applicationStatus: 'APPROVED_ISSUING',
      applicationUserId: 'owner-1',
      applicationTenantId: 'tenant-1',
      principalCents: 500,
      invoiceNumber: null,
      issueDate: null,
      dueDate: null,
      issuedAt: null,
      pdfUrl: null,
      ofdUrl: null,
      hasIssuedLifecycleEvent: false,
    });
    expect(buildEnterpriseAbsorbPairPlan(pendingInvoice)).toEqual(expect.objectContaining({
      status: 'QUARANTINED_PAIR',
      reasons: expect.arrayContaining(['TRANSFER_GRANT_PROOF_MISMATCH:moved-grant']),
    }));

    const malformedIdempotency = pairSnapshot();
    (malformedIdempotency.idempotencyEvidence[0].result as Record<string, unknown>).createdAt = 'bad';
    expect(() => buildEnterpriseAbsorbPairPlan(malformedIdempotency)).not.toThrow();
    expect(buildEnterpriseAbsorbPairPlan(malformedIdempotency)).toEqual(expect.objectContaining({
      status: 'QUARANTINED_PAIR',
      reasons: expect.arrayContaining([
        expect.stringContaining('ADMIN_GRANT_IDEMPOTENCY_MATCH_0'),
      ]),
    }));

    const malformedEvidenceWindow = pairSnapshot();
    malformedEvidenceWindow.idempotencyEvidence[0].createdAt = 'bad';
    expect(() => buildEnterpriseAbsorbPairPlan(malformedEvidenceWindow)).not.toThrow();
    expect(buildEnterpriseAbsorbPairPlan(malformedEvidenceWindow)).toEqual(expect.objectContaining({
      status: 'QUARANTINED_PAIR',
      reasons: expect.arrayContaining([
        expect.stringContaining('ADMIN_GRANT_IDEMPOTENCY_MATCH_0'),
      ]),
    }));

    const transactionOutsideEvidenceWindow = pairSnapshot();
    transactionOutsideEvidenceWindow.idempotencyEvidence[0].expiresAt =
      '2026-07-07T00:02:00.000Z';
    expect(buildEnterpriseAbsorbPairPlan(transactionOutsideEvidenceWindow)).toEqual(
      expect.objectContaining({
        status: 'QUARANTINED_PAIR',
        reasons: expect.arrayContaining([
          expect.stringContaining('ADMIN_GRANT_IDEMPOTENCY_MATCH_0'),
        ]),
      }),
    );
  });
});

describe('enterprise absorb signed JSONL envelope', () => {
  const manifest = {
    recordType: 'BALANCE_ENTERPRISE_ABSORB_REPAIR_PLAN_V1',
    databaseName: 'billing_test',
    databaseIdentity: '4a609d5a-62a2-4d38-85f7-306153258b0f',
    databaseSystemIdentifier: '7432769159580659830',
    databaseOid: '16384',
    phase: 'V2_CONTRACT',
    endpointSha256: SHA_A,
  } as const;

  it('accepts one canonical manifest plus one self-consistent pair plan', () => {
    const plan = buildEnterpriseAbsorbPairPlan(pairSnapshot());
    expect(plan.status).toBe('READY_PAIR');
    const raw = `${JSON.stringify(manifest)}\n${JSON.stringify(plan)}\n`;

    expect(parseEnterpriseAbsorbPlanFile(raw)).toEqual({ manifest, plan });
    expect(() => parseEnterpriseAbsorbPlanFile(raw.slice(0, -1))).toThrow(
      'canonical LF-terminated JSONL',
    );
  });

  it('rejects a mutated financial payload even when the JSON remains valid', () => {
    const plan = buildEnterpriseAbsorbPairPlan(pairSnapshot());
    expect(plan.status).toBe('READY_PAIR');
    if (plan.status !== 'READY_PAIR') return;
    const tampered = structuredClone(plan);
    tampered.transfer.amountUsd = '400.000000000000';
    const raw = `${JSON.stringify(manifest)}\n${JSON.stringify(tampered)}\n`;

    expect(() => parseEnterpriseAbsorbPlanFile(raw)).toThrow('transfer proof hash mismatch');
  });

  it('fingerprints the physical endpoint without credentials', () => {
    const previous = process.env.DATABASE_URL;
    try {
      process.env.DATABASE_URL = 'postgresql://alice:first@DB.EXAMPLE:5432/billing?sslmode=require';
      const first = enterpriseAbsorbDatabaseEndpointSha256();
      process.env.DATABASE_URL = 'postgres://bob:second@db.example/billing?sslmode=require';
      expect(enterpriseAbsorbDatabaseEndpointSha256()).toBe(first);
      expect(first).toBe(enterpriseAbsorbSha256(JSON.stringify({
        protocol: 'postgresql:',
        hostname: 'db.example',
        port: '5432',
        pathname: '/billing',
        parameters: [['sslmode', 'require']],
      })));
    } finally {
      if (previous === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previous;
    }
  });
});

describe('enterprise absorb selective canonical constraint drain', () => {
  it('flushes exactly the three canonical row constraints by their migration names', async () => {
    expect(ENTERPRISE_ABSORB_CANONICAL_CONSTRAINTS).toEqual([
      'balance_transactions_clean_canonical_deferred',
      'balance_debt_allocations_clean_canonical_deferred',
      'balance_grants_clean_canonical_deferred',
    ]);
    const executeRawUnsafe = jest.fn().mockResolvedValue(0);

    await flushEnterpriseAbsorbCanonicalConstraintsWhileLegacyDirty({
      $executeRawUnsafe: executeRawUnsafe,
    });

    expect(executeRawUnsafe).toHaveBeenCalledTimes(2);
    expect(executeRawUnsafe).toHaveBeenNthCalledWith(
      1,
      'SET CONSTRAINTS "balance_transactions_clean_canonical_deferred", '
      + '"balance_debt_allocations_clean_canonical_deferred", '
      + '"balance_grants_clean_canonical_deferred" IMMEDIATE',
    );
    expect(executeRawUnsafe).toHaveBeenNthCalledWith(
      2,
      'SET CONSTRAINTS "balance_transactions_clean_canonical_deferred", '
      + '"balance_debt_allocations_clean_canonical_deferred", '
      + '"balance_grants_clean_canonical_deferred" DEFERRED',
    );
  });

  it('drains after pair row mutations, before pair assertion, with no later canonical-row DML', () => {
    const scriptSource = readFileSync(resolve(
      __dirname,
      '../../scripts/reconcile-enterprise-absorb-ledger.ts',
    ), 'utf8');
    const applyStart = scriptSource.indexOf('async function applyReadyEnterpriseAbsorbPair(');
    const applyEnd = scriptSource.indexOf('\nasync function dryRun(', applyStart);
    expect(applyStart).toBeGreaterThanOrEqual(0);
    expect(applyEnd).toBeGreaterThan(applyStart);
    const applySource = scriptSource.slice(applyStart, applyEnd);

    const allocationMutation = applySource.lastIndexOf(
      'await applyPairAllocationMutationsSetBased(',
    );
    const selectiveDrain = applySource.indexOf(
      'await flushEnterpriseAbsorbCanonicalConstraintsWhileLegacyDirty(tx);',
    );
    const explicitPairAssertion = applySource.indexOf(
      'SELECT "assert_balance_enterprise_absorb_pair_repair"(',
    );
    const markerPromotion = applySource.indexOf(
      'UPDATE "billing_accounts"',
      explicitPairAssertion,
    );
    const appliedAudit = applySource.indexOf(
      "status: 'APPLIED',",
      markerPromotion,
    );
    const finalAllDrain = applySource.indexOf(
      "await tx.$executeRawUnsafe('SET CONSTRAINTS ALL IMMEDIATE');",
    );

    expect(allocationMutation).toBeGreaterThanOrEqual(0);
    expect(selectiveDrain).toBeGreaterThan(allocationMutation);
    expect(explicitPairAssertion).toBeGreaterThan(selectiveDrain);
    expect(markerPromotion).toBeGreaterThan(explicitPairAssertion);
    expect(appliedAudit).toBeGreaterThan(markerPromotion);
    expect(finalAllDrain).toBeGreaterThan(appliedAudit);

    const afterSelectiveDrain = applySource.slice(selectiveDrain, finalAllDrain);
    expect(afterSelectiveDrain).not.toMatch(
      /\b(?:INSERT\s+INTO|UPDATE|DELETE\s+FROM)\s+"(?:balance_transactions|balance_consumption_allocations|balance_grants)"/i,
    );
  });
});
