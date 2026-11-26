import { Prisma } from '@prisma/client';
import {
  BalanceLedgerRepairSnapshot,
  balanceLedgerRepairReplayHash,
  buildBalanceLedgerRepairPlan as buildBalanceLedgerRepairPlanAt,
} from './balance-ledger-repair';

const REPAIR_OBSERVED_AT = new Date('2026-07-15T23:59:59.999Z');

function buildBalanceLedgerRepairPlan(
  snapshot: BalanceLedgerRepairSnapshot,
) {
  return buildBalanceLedgerRepairPlanAt(snapshot, REPAIR_OBSERVED_AT);
}

function baseSnapshot(
  overrides: Partial<BalanceLedgerRepairSnapshot> = {},
): BalanceLedgerRepairSnapshot {
  const snapshot: BalanceLedgerRepairSnapshot = {
    billingAccountId: 'ba_personal_u1',
    accountType: 'personal',
    ledgerStatus: 'LEGACY_DIRTY',
    ledgerVersion: 0,
    walletBalanceUsd: '-0.140000000000',
    transactions: [],
    grants: [],
    allocations: [],
    settlements: [],
    orders: [],
    invoiceItems: [],
    voucherIdempotencyEvidence: [],
    legacyAdminFundingIdempotencyEvidence: [],
    expiryAuditCount: 0,
    ...overrides,
  };
  // Production snapshots always carry the grant validity fields. Keep compact
  // fixtures canonical unless a test deliberately supplies an invalid value.
  return {
    ...snapshot,
    transactions: snapshot.transactions.map((transaction) => ({
      userId: 'repair-user',
      tenantId: 'repair-tenant',
      productId: null,
      tokenUsageId: null,
      ...transaction,
    })),
    grants: snapshot.grants.map((grant) => ({
      userId: 'repair-user',
      tenantId: 'repair-tenant',
      productId: null,
      ...grant,
      validFrom: grant.validFrom ?? grant.createdAt,
      expiresAt: grant.expiresAt ?? null,
    })),
    allocations: snapshot.allocations.map((allocation) => ({
      billingAccountId: snapshot.billingAccountId,
      userId: 'repair-user',
      tenantId: 'repair-tenant',
      productId: null,
      tokenUsageId: null,
      discountRate: allocation.discountRate ?? (
        allocation.source === 'NEGATIVE_BALANCE' || allocation.source === 'ENTERPRISE_CREDIT'
          ? '0'
          : Number(allocation.amountUsd) > 0
          ? (Number(allocation.recognizedRevenueUsd) / Number(allocation.amountUsd)).toFixed(12)
          : '0'
      ),
      ...allocation,
    })),
  };
}

type RepairTransaction = BalanceLedgerRepairSnapshot['transactions'][number];
type RepairGrant = BalanceLedgerRepairSnapshot['grants'][number];
type RepairOrderEvidence = BalanceLedgerRepairSnapshot['orders'][number];
type RepairInvoiceItemEvidence = BalanceLedgerRepairSnapshot['invoiceItems'][number];
type RepairVoucherIdempotencyEvidence = BalanceLedgerRepairSnapshot['voucherIdempotencyEvidence'][number];
type RepairLegacyAdminFundingEvidence = NonNullable<
  BalanceLedgerRepairSnapshot['legacyAdminFundingIdempotencyEvidence']
>[number];

function completedRechargeOrder(
  overrides: Partial<RepairOrderEvidence> = {},
): RepairOrderEvidence {
  return {
    id: 'order-r',
    userId: 'repair-user',
    tenantId: 'repair-tenant',
    billingAccountId: 'ba_personal_u1',
    productId: null,
    orderType: 'RECHARGE',
    status: 'COMPLETED',
    amountCents: 200,
    bonusCents: 0,
    currency: 'cny',
    paidAt: '2026-07-15T10:00:59.900Z',
    completedAt: '2026-07-15T10:01:00.100Z',
    refundedAt: null,
    refundAmountCents: null,
    createdAt: '2026-07-15T09:59:00.000Z',
    ...overrides,
  };
}

function failedInvoiceItem(
  overrides: Partial<RepairInvoiceItemEvidence> = {},
): RepairInvoiceItemEvidence {
  return {
    id: 'invoice-item-1',
    orderId: 'order-r',
    principalCents: 200,
    description: 'RAYTONE_API',
    applicationId: 'invoice-application-1',
    applicationUserId: 'repair-user',
    applicationTenantId: 'repair-tenant',
    applicationStatus: 'FAILED',
    invoiceNumber: null,
    issuingEntity: null,
    issueDate: null,
    dueDate: null,
    issuedAt: null,
    pdfUrl: null,
    ofdUrl: null,
    hasIssuedLifecycleEvent: false,
    ...overrides,
  };
}

function legacyExpiryMaintenanceSnapshot(): BalanceLedgerRepairSnapshot {
  const fundingAt = '2026-07-15T10:00:00.000Z';
  const consumedAt = '2026-07-15T10:01:00.000Z';
  const expiredAt = '2026-07-15T10:02:00.000Z';
  const invoiceItem = failedInvoiceItem({
    applicationStatus: 'ISSUED',
    invoiceNumber: '102ISSHK202607003',
    issuedAt: '2026-07-15T11:00:00.000Z',
    hasIssuedLifecycleEvent: true,
  });
  return baseSnapshot({
    walletBalanceUsd: '0',
    transactions: [
      {
        id: 'expiry-funding', type: 'RECHARGE', amountUsd: '1', balanceAfterUsd: '1',
        description: 'admin recharge', orderId: null,
        operationKey: 'balance:admin-recharge:grant:expiry-grant', createdAt: fundingAt,
      },
      {
        id: 'expiry-consume', type: 'CONSUME', amountUsd: '-0.8', balanceAfterUsd: '0.2',
        description: 'usage', orderId: null, operationKey: null,
        tokenUsageId: 'expiry-usage', createdAt: consumedAt,
      },
      {
        id: 'legacy-expiry', type: 'ADJUST', amountUsd: '-0.2', balanceAfterUsd: '0',
        description: 'balance grant expired:expiry-grant', orderId: null,
        operationKey: null, createdAt: expiredAt,
      },
    ],
    grants: [{
      id: 'expiry-grant', orderId: null, source: 'RECHARGE', paidAmountUsd: '1',
      bonusAmountUsd: '0', grantedAmountUsd: '1', remainingAmountUsd: '0',
      remainingPaidAmountUsd: null, remainingBonusAmountUsd: null, discountRate: '1',
      isExpired: true, validFrom: fundingAt, expiresAt: expiredAt, createdAt: fundingAt,
    }],
    allocations: [{
      id: 'expiry-allocation', balanceTransactionId: 'expiry-consume',
      tokenUsageId: 'expiry-usage', balanceGrantId: 'expiry-grant', source: 'BALANCE_GRANT',
      amountUsd: '0.8', recognizedRevenueUsd: '0.8', bonusConsumedUsd: '0',
      settledUsd: '0', settledAt: null, createdAt: consumedAt,
    }],
    invoiceItems: [invoiceItem],
    invoiceEvidence: {
      orderIds: [invoiceItem.orderId],
      applicationIds: [invoiceItem.applicationId],
      itemIds: [invoiceItem.id],
      eventIds: ['invoice-event-1'],
      invoiceItemCount: 1,
      unsafeInvoiceItemCount: 1,
      invalidApplicationCount: 0,
      snapshotSha256: 'a'.repeat(64),
      snapshot: {
        orders: [{ id: invoiceItem.orderId }],
        applications: [{ id: invoiceItem.applicationId }],
        items: [{ id: invoiceItem.id }],
        events: [{ id: 'invoice-event-1' }],
      },
    },
  });
}

function legacyExpiredVoucherSnapshot(): BalanceLedgerRepairSnapshot {
  const baseFundingAt = '2026-07-15T10:00:00.000Z';
  const voucherValidFrom = '2026-07-15T10:00:59.990Z';
  const voucherGrantCreatedAt = '2026-07-15T10:00:59.996Z';
  const voucherFundingAt = '2026-07-15T10:01:00.000Z';
  const consumedAt = '2026-07-15T10:02:00.000Z';
  const voucherExpiresAt = '2026-07-15T10:03:00.000Z';
  const expiredAt = '2026-07-15T10:08:00.000Z';
  return baseSnapshot({
    walletBalanceUsd: '10',
    transactions: [
      {
        id: 'expired-voucher-base-funding', type: 'RECHARGE', amountUsd: '10',
        balanceAfterUsd: '10', description: 'admin recharge', orderId: null,
        operationKey: 'balance:admin-recharge:grant:expired-voucher-base-grant',
        createdAt: baseFundingAt,
      },
      {
        id: 'expired-voucher-tx', type: 'ADJUST', amountUsd: '1',
        balanceAfterUsd: '11',
        description: 'voucher:expired-voucher-grant admin:operator historical voucher',
        orderId: null, operationKey: null, createdAt: voucherFundingAt,
      },
      {
        id: 'expired-voucher-consume', type: 'CONSUME', amountUsd: '-0.8',
        balanceAfterUsd: '10.2', description: 'usage', orderId: null,
        operationKey: null, tokenUsageId: 'expired-voucher-usage', createdAt: consumedAt,
      },
      {
        id: 'expired-voucher-expiry', type: 'ADJUST', amountUsd: '-0.2',
        balanceAfterUsd: '10', description: 'balance grant expired:expired-voucher-grant',
        orderId: null, operationKey: null, createdAt: expiredAt,
      },
    ],
    grants: [
      {
        id: 'expired-voucher-base-grant', orderId: null, source: 'RECHARGE',
        paidAmountUsd: '10', bonusAmountUsd: '0', grantedAmountUsd: '10',
        remainingAmountUsd: '10', remainingPaidAmountUsd: null,
        remainingBonusAmountUsd: null, discountRate: '1', isExpired: false,
        validFrom: baseFundingAt, expiresAt: null, createdAt: baseFundingAt,
      },
      {
        id: 'expired-voucher-grant', orderId: null, source: 'VOUCHER',
        paidAmountUsd: '0', bonusAmountUsd: '1', grantedAmountUsd: '1',
        remainingAmountUsd: '0', remainingPaidAmountUsd: null,
        remainingBonusAmountUsd: null, discountRate: '0', isExpired: true,
        validFrom: voucherValidFrom, expiresAt: voucherExpiresAt,
        createdAt: voucherGrantCreatedAt,
      },
    ],
    allocations: [{
      id: 'expired-voucher-allocation', balanceTransactionId: 'expired-voucher-consume',
      tokenUsageId: 'expired-voucher-usage', balanceGrantId: 'expired-voucher-grant',
      source: 'BALANCE_GRANT', amountUsd: '0.8', recognizedRevenueUsd: '0',
      bonusConsumedUsd: '0.8', settledUsd: '0', settledAt: null,
      createdAt: '2026-07-15T10:02:00.001Z',
    }],
    voucherIdempotencyEvidence: [],
  });
}

function legacyExpiredVoucherPlanningProfile() {
  return {
    allowLegacyExpiryProofs: true,
    allowLegacyExpiredVoucherProofs: true,
    allowInvoiceStabilityProof: false,
  };
}

function legacyVoucherIdempotencyEvidence(
  overrides: Partial<RepairVoucherIdempotencyEvidence> = {},
): RepairVoucherIdempotencyEvidence {
  return {
    key: 'admin:payg-voucher:repair-tenant:legacy-key',
    scope: 'admin:issue-voucher',
    userId: 'repair-user',
    status: 'COMMITTED',
    createdAt: '2026-07-15T10:00:59.995Z',
    expiresAt: '2026-08-14T10:01:00.057Z',
    result: {
      transaction: {
        id: 'legacy-voucher-tx',
        type: 'ADJUST',
        userId: 'repair-user',
        tenantId: 'repair-tenant',
        amountUsd: 1,
        createdAt: '2026-07-15T10:01:00.029Z',
        productId: null,
        amountCents: 100,
        description: 'voucher:legacy-voucher-grant admin:repair legacy voucher',
        balanceAfterUsd: 0.977388,
        balanceAfterCents: 98,
      },
      grant: {
        id: 'legacy-voucher-grant',
        source: 'VOUCHER',
        expiresAt: '2026-08-14T16:00:00.000Z',
        productId: null,
        amountCents: 100,
        discountRate: 0,
        remainingCents: 98,
        paidAmountCents: 0,
        bonusAmountCents: 100,
      },
    },
    ...overrides,
  };
}

function legacyAdminFundingEvidence(
  transaction: RepairTransaction,
  scope: 'admin:adjust-balance' | 'admin:recharge',
  billingAccountId = 'ba_legacy_admin_enterprise',
  overrides: Partial<RepairLegacyAdminFundingEvidence> = {},
): RepairLegacyAdminFundingEvidence {
  return {
    key: `enterprise-recharge:${billingAccountId}:proof-${transaction.id}`,
    scope,
    userId: transaction.userId ?? 'repair-user',
    status: 'COMMITTED',
    result: {
      id: transaction.id,
      userId: transaction.userId ?? 'repair-user',
      tenantId: transaction.tenantId ?? 'repair-tenant',
      productId: transaction.productId ?? null,
      type: transaction.type,
      amountCents: Math.round(Number(transaction.amountUsd) * 100),
      balanceAfterCents: Math.round(Number(transaction.balanceAfterUsd) * 100),
      amountUsd: Number(transaction.amountUsd),
      balanceAfterUsd: Number(transaction.balanceAfterUsd),
      description: transaction.description,
      createdAt: transaction.createdAt,
    },
    createdAt: new Date(new Date(transaction.createdAt).getTime() - 1).toISOString(),
    expiresAt: new Date(new Date(transaction.createdAt).getTime() + 30 * 86_400_000).toISOString(),
    snapshotSha256: 'a'.repeat(64),
    ...overrides,
  };
}

function legacyAdminFundingEnterpriseSnapshot(): BalanceLedgerRepairSnapshot {
  const adjust: RepairTransaction = {
    id: 'legacy-admin-adjust', userId: 'repair-user', tenantId: 'repair-tenant',
    productId: null, tokenUsageId: null, type: 'ADJUST', amountUsd: '2',
    balanceAfterUsd: '1', description: '线下转账入账', orderId: null,
    operationKey: null, createdAt: '2026-07-15T10:01:00.000Z',
  };
  const recharge: RepairTransaction = {
    id: 'legacy-admin-recharge', userId: 'repair-user', tenantId: 'repair-tenant',
    productId: 'product-payg', tokenUsageId: null, type: 'RECHARGE', amountUsd: '3',
    balanceAfterUsd: '3.5', description: '企业账户管理员充值', orderId: null,
    operationKey: null, createdAt: '2026-07-15T10:03:00.000Z',
  };
  return baseSnapshot({
    billingAccountId: 'ba_legacy_admin_enterprise',
    accountType: 'enterprise',
    walletBalanceUsd: '1.5',
    transactions: [
      {
        id: 'legacy-admin-debt-consume', type: 'CONSUME', amountUsd: '-1',
        balanceAfterUsd: '-1', description: 'usage debt', orderId: null,
        operationKey: null, createdAt: '2026-07-15T10:00:00.000Z',
      },
      adjust,
      {
        id: 'legacy-admin-consume-a', type: 'CONSUME', amountUsd: '-0.5',
        balanceAfterUsd: '0.5', description: 'usage a', orderId: null,
        operationKey: null, createdAt: '2026-07-15T10:02:00.000Z',
      },
      recharge,
      {
        id: 'legacy-admin-consume-b', type: 'CONSUME', amountUsd: '-2',
        balanceAfterUsd: '1.5', description: 'usage b', orderId: null,
        operationKey: null, createdAt: '2026-07-15T10:04:00.000Z',
      },
    ],
    grants: [{
      id: 'legacy-admin-recharge-grant', orderId: null, source: 'RECHARGE',
      paidAmountUsd: '3', bonusAmountUsd: '0', grantedAmountUsd: '3',
      remainingAmountUsd: '1.5', remainingPaidAmountUsd: null,
      remainingBonusAmountUsd: null, discountRate: '1', isExpired: false,
      userId: 'repair-user', tenantId: 'repair-tenant', productId: 'product-payg',
      validFrom: '2026-07-15T10:03:00.002Z',
      expiresAt: '2027-07-15T10:03:00.002Z',
      createdAt: '2026-07-15T10:03:00.004Z',
      snapshotSha256: 'c'.repeat(64),
    }],
    allocations: [
      {
        id: 'legacy-admin-debt', balanceTransactionId: 'legacy-admin-debt-consume',
        balanceGrantId: null, source: 'ENTERPRISE_CREDIT', amountUsd: '1',
        recognizedRevenueUsd: '1', bonusConsumedUsd: '0', settledUsd: '1',
        settledAt: '2026-07-15T10:01:00.002Z',
        createdAt: '2026-07-15T10:00:00.001Z',
      },
      {
        id: 'legacy-admin-allocation-a', balanceTransactionId: 'legacy-admin-consume-a',
        balanceGrantId: 'legacy-admin-recharge-grant', source: 'BALANCE_GRANT',
        amountUsd: '0.5', recognizedRevenueUsd: '0.5', bonusConsumedUsd: '0',
        settledUsd: '0', settledAt: null, createdAt: '2026-07-15T10:02:00.001Z',
      },
      {
        id: 'legacy-admin-allocation-b1', balanceTransactionId: 'legacy-admin-consume-b',
        balanceGrantId: 'legacy-admin-recharge-grant', source: 'BALANCE_GRANT',
        amountUsd: '0.5', recognizedRevenueUsd: '0.5', bonusConsumedUsd: '0',
        settledUsd: '0', settledAt: null, createdAt: '2026-07-15T10:04:00.001Z',
      },
      {
        id: 'legacy-admin-allocation-b2', balanceTransactionId: 'legacy-admin-consume-b',
        balanceGrantId: 'legacy-admin-recharge-grant', source: 'BALANCE_GRANT',
        amountUsd: '1.5', recognizedRevenueUsd: '1.5', bonusConsumedUsd: '0',
        settledUsd: '0', settledAt: null, createdAt: '2026-07-15T10:04:00.002Z',
      },
    ],
    settlements: [{
      id: 'legacy-admin-settlement', allocationId: 'legacy-admin-debt',
      repaymentTransactionId: adjust.id, balanceGrantId: null,
      debtSource: 'ENTERPRISE_CREDIT', repairRunId: null,
      operationKey: 'legacy:legacy-admin-settlement', trigger: 'FUNDING',
      amountUsd: '1', paidUsd: '1', bonusUsd: '0',
      occurredAt: '2026-07-15T10:01:00.003Z',
      createdAt: '2026-07-15T10:01:00.003Z',
    }],
    legacyAdminFundingIdempotencyEvidence: [
      legacyAdminFundingEvidence(adjust, 'admin:adjust-balance'),
      legacyAdminFundingEvidence(recharge, 'admin:recharge'),
    ],
  });
}

function legacyAdminFundingLinkedGrantReallocationSnapshot(): BalanceLedgerRepairSnapshot {
  const snapshot = legacyAdminFundingEnterpriseSnapshot();
  snapshot.walletBalanceUsd = '3.5';
  snapshot.transactions = snapshot.transactions
    .filter((transaction) => transaction.id !== 'legacy-admin-consume-a')
    .map((transaction) => {
      if (transaction.id === 'legacy-admin-recharge') {
        return { ...transaction, balanceAfterUsd: '4' };
      }
      if (transaction.id === 'legacy-admin-consume-b') {
        return { ...transaction, amountUsd: '-0.5', balanceAfterUsd: '3.5' };
      }
      return transaction;
    });
  snapshot.grants[0] = {
    ...snapshot.grants[0],
    remainingAmountUsd: '2.5',
  };
  snapshot.legacyAdminFundingIdempotencyEvidence =
    snapshot.legacyAdminFundingIdempotencyEvidence!.map((evidence) => {
      const result = evidence.result as Record<string, unknown>;
      return result.id === 'legacy-admin-recharge'
        ? {
            ...evidence,
            result: {
              ...result,
              balanceAfterCents: 400,
              balanceAfterUsd: 4,
            },
          }
        : evidence;
    });
  snapshot.allocations = snapshot.allocations
    .filter((allocation) => (
      allocation.id !== 'legacy-admin-allocation-a'
      && allocation.id !== 'legacy-admin-allocation-b2'
    ));
  return snapshot;
}

function uatLegacyAdminFundingLinkedGrantReallocationSnapshot(): BalanceLedgerRepairSnapshot {
  const billingAccountId = 'ba_uat_legacy_admin_enterprise';
  const userId = 'repair-user';
  const tenantId = 'repair-tenant';
  const transactions: RepairTransaction[] = [];
  const grants: RepairGrant[] = [];
  const allocations: BalanceLedgerRepairSnapshot['allocations'] = [];
  const evidence: RepairLegacyAdminFundingEvidence[] = [];
  let runningBalance = new Prisma.Decimal('-0.1586013');

  transactions.push({
    id: 'uat-admin-debt-consume', userId, tenantId, productId: null,
    tokenUsageId: null, type: 'CONSUME', amountUsd: '-0.1586013',
    balanceAfterUsd: '-0.1586013', description: 'usage debt', orderId: null,
    operationKey: null, createdAt: '2026-07-07T13:00:00.000Z',
  });
  allocations.push({
    id: 'uat-admin-debt-allocation', balanceTransactionId: 'uat-admin-debt-consume',
    balanceGrantId: null, source: 'ENTERPRISE_CREDIT', amountUsd: '0.1586013',
    recognizedRevenueUsd: '0.1586013', bonusConsumedUsd: '0',
    settledUsd: '0.1586013', settledAt: '2026-07-07T13:01:00.002Z',
    createdAt: '2026-07-07T13:00:00.001Z',
  });

  const adjustAmounts = ['1', '2', '2', '2', '2', '3', '2', '1'];
  adjustAmounts.forEach((amount, index) => {
    runningBalance = runningBalance.plus(amount);
    const createdAt = `2026-07-07T13:${String(index + 1).padStart(2, '0')}:00.000Z`;
    const transaction: RepairTransaction = {
      id: `uat-admin-adjust-${index + 1}`, userId, tenantId, productId: null,
      tokenUsageId: null, type: 'ADJUST', amountUsd: amount,
      balanceAfterUsd: runningBalance.toFixed(7), description: '线下转账入账',
      orderId: null, operationKey: null, createdAt,
    };
    transactions.push(transaction);
    evidence.push(legacyAdminFundingEvidence(
      transaction,
      'admin:adjust-balance',
      billingAccountId,
      { snapshotSha256: (index + 1).toString(16).padStart(64, '0') },
    ));
  });

  const addLinkedRecharge = (
    id: string,
    grantId: string,
    amount: string,
    remainingAmount: string,
    createdAt: string,
    proofIndex: number,
  ): void => {
    runningBalance = runningBalance.plus(amount);
    const transaction: RepairTransaction = {
      id, userId, tenantId, productId: null, tokenUsageId: null,
      type: 'RECHARGE', amountUsd: amount,
      balanceAfterUsd: runningBalance.toFixed(7),
      description: '企业账户管理员充值', orderId: null, operationKey: null,
      createdAt,
    };
    transactions.push(transaction);
    evidence.push(legacyAdminFundingEvidence(
      transaction,
      'admin:recharge',
      billingAccountId,
      { snapshotSha256: proofIndex.toString(16).padStart(64, '0') },
    ));
    const validFrom = new Date(new Date(createdAt).getTime() + 2).toISOString();
    const expiresAt = new Date(validFrom);
    expiresAt.setUTCDate(expiresAt.getUTCDate() + 365);
    grants.push({
      id: grantId, userId, tenantId, productId: null, orderId: null,
      source: 'RECHARGE', paidAmountUsd: amount, bonusAmountUsd: '0',
      grantedAmountUsd: amount, remainingAmountUsd: remainingAmount,
      remainingPaidAmountUsd: null, remainingBonusAmountUsd: null,
      discountRate: '1', isExpired: false, validFrom,
      expiresAt: expiresAt.toISOString(),
      createdAt: new Date(new Date(createdAt).getTime() + 4).toISOString(),
      snapshotSha256: (proofIndex + 20).toString(16).padStart(64, '0'),
    });
  };

  addLinkedRecharge(
    'uat-admin-recharge-2',
    'uat-admin-recharge-grant-2',
    '2',
    '1.957804',
    '2026-07-07T13:10:36.309Z',
    9,
  );

  const misallocatedAmounts = [
    '0.0180264',
    '0.0029428',
    '0.0029624',
    '0.0137312',
    '0.0045332',
  ];
  misallocatedAmounts.forEach((amount, index) => {
    runningBalance = runningBalance.minus(amount);
    const createdAt = `2026-07-07T13:${String(index + 11).padStart(2, '0')}:00.000Z`;
    const transactionId = `uat-admin-consume-${index + 1}`;
    transactions.push({
      id: transactionId, userId, tenantId, productId: null, tokenUsageId: null,
      type: 'CONSUME', amountUsd: `-${amount}`,
      balanceAfterUsd: runningBalance.toFixed(7), description: 'usage',
      orderId: null, operationKey: null, createdAt,
    });
    allocations.push({
      id: `uat-admin-misallocated-${index + 1}`,
      balanceTransactionId: transactionId,
      balanceGrantId: 'uat-admin-recharge-grant-2',
      source: 'BALANCE_GRANT', amountUsd: amount,
      recognizedRevenueUsd: amount, bonusConsumedUsd: '0',
      settledUsd: '0', settledAt: null,
      createdAt: new Date(new Date(createdAt).getTime() + 1).toISOString(),
    });
  });

  addLinkedRecharge(
    'uat-admin-recharge-3',
    'uat-admin-recharge-grant-3',
    '3',
    '3',
    '2026-07-07T13:16:00.000Z',
    10,
  );
  addLinkedRecharge(
    'uat-admin-recharge-7',
    'uat-admin-recharge-grant-7',
    '7',
    '7',
    '2026-07-07T13:17:00.000Z',
    11,
  );

  return baseSnapshot({
    billingAccountId,
    accountType: 'enterprise',
    walletBalanceUsd: runningBalance.toFixed(7),
    transactions,
    grants,
    allocations,
    settlements: [{
      id: 'uat-admin-debt-settlement', allocationId: 'uat-admin-debt-allocation',
      repaymentTransactionId: 'uat-admin-adjust-1', balanceGrantId: null,
      debtSource: 'ENTERPRISE_CREDIT', repairRunId: null,
      operationKey: 'legacy:uat-admin-debt-settlement', trigger: 'FUNDING',
      amountUsd: '0.1586013', paidUsd: '0.1586013', bonusUsd: '0',
      occurredAt: '2026-07-07T13:01:00.002Z',
      createdAt: '2026-07-07T13:01:00.002Z',
    }],
    legacyAdminFundingIdempotencyEvidence: evidence,
  });
}

function legacyVoucherEnterpriseSnapshot(
  overrides: Partial<BalanceLedgerRepairSnapshot> = {},
): BalanceLedgerRepairSnapshot {
  return baseSnapshot({
    billingAccountId: 'ba_legacy_voucher_enterprise',
    accountType: 'enterprise',
    walletBalanceUsd: '0.977388',
    transactions: [
      {
        id: 'legacy-voucher-consume', type: 'CONSUME', amountUsd: '-0.022612',
        balanceAfterUsd: '-0.022612', description: 'usage', orderId: null,
        operationKey: null, createdAt: '2026-07-15T10:00:00.000Z',
      },
      {
        id: 'legacy-voucher-tx', type: 'ADJUST', amountUsd: '1',
        balanceAfterUsd: '0.977388',
        description: 'voucher:legacy-voucher-grant admin:repair legacy voucher',
        orderId: null, operationKey: null, createdAt: '2026-07-15T10:01:00.029Z',
      },
    ],
    grants: [{
      id: 'legacy-voucher-grant', orderId: null, source: 'VOUCHER',
      paidAmountUsd: '0', bonusAmountUsd: '1', grantedAmountUsd: '1',
      remainingAmountUsd: '0.977388', remainingPaidAmountUsd: null,
      remainingBonusAmountUsd: null, discountRate: '0', isExpired: false,
      validFrom: '2026-07-15T10:01:00.001Z',
      createdAt: '2026-07-15T10:01:00.019Z',
      expiresAt: '2026-08-14T16:00:00.000Z',
    }],
    allocations: [{
      id: 'legacy-voucher-debt', balanceTransactionId: 'legacy-voucher-consume',
      balanceGrantId: null, source: 'ENTERPRISE_CREDIT', amountUsd: '0.022612',
      recognizedRevenueUsd: '0', bonusConsumedUsd: '0', settledUsd: '0.022612',
      settledAt: '2026-07-15T10:01:00.039Z',
      createdAt: '2026-07-15T10:00:00.010Z',
    }],
    settlements: [{
      id: 'legacy-voucher-settlement', allocationId: 'legacy-voucher-debt',
      repaymentTransactionId: 'legacy-voucher-tx', balanceGrantId: null,
      debtSource: 'ENTERPRISE_CREDIT', repairRunId: null,
      operationKey: 'legacy:legacy-voucher-settlement', trigger: 'FUNDING',
      amountUsd: '0.022612', paidUsd: '0', bonusUsd: '0.022612',
      occurredAt: '2026-07-15T10:01:00.052Z',
      createdAt: '2026-07-15T10:01:00.052Z',
    }],
    voucherIdempotencyEvidence: [legacyVoucherIdempotencyEvidence()],
    ...overrides,
  });
}

/**
 * Anonymous production-equation regression. The five opening components are
 * deterministic fixture partitions whose exact sum is the observed
 * 0.081552076; they are not represented as the production row identities.
 */
function productionVoucherAbsorptionEquationSnapshot(): BalanceLedgerRepairSnapshot {
  const opening = [
    { amount: '0.010000000000', after: '-0.010000000000' },
    { amount: '0.015000000000', after: '-0.025000000000' },
    { amount: '0.020000000000', after: '-0.045000000000' },
    { amount: '0.016552076000', after: '-0.061552076000' },
    { amount: '0.020000000000', after: '-0.081552076000' },
  ];
  const transactions: BalanceLedgerRepairSnapshot['transactions'] = opening.map(
    ({ amount, after }, index) => ({
      id: `b-opening-consume-${index + 1}`,
      type: 'CONSUME',
      amountUsd: `-${amount}`,
      balanceAfterUsd: after,
      description: 'usage',
      orderId: null,
      operationKey: null,
      tokenUsageId: `b-opening-usage-${index + 1}`,
      createdAt: `2026-07-15T09:00:0${index}.000Z`,
    }),
  );
  transactions.push(
    {
      id: 'b-voucher-100', type: 'ADJUST', amountUsd: '100',
      balanceAfterUsd: '99.918447924',
      description: 'voucher:b-voucher-grant admin:repair historical voucher',
      orderId: null, operationKey: null, createdAt: '2026-07-15T09:01:00.029Z',
    },
    {
      id: 'b-legitimate-consume', type: 'CONSUME', amountUsd: '-99.906900840',
      balanceAfterUsd: '0.011547084', description: 'usage', orderId: null,
      operationKey: null, tokenUsageId: 'b-usage-legitimate',
      createdAt: '2026-07-15T09:02:00.000Z',
    },
    {
      id: 'b-partial-consume', type: 'CONSUME', amountUsd: '-0.028941300',
      balanceAfterUsd: '-0.017394216', description: 'usage', orderId: null,
      operationKey: null, tokenUsageId: 'b-usage-partial',
      createdAt: '2026-07-15T09:03:00.000Z',
    },
    {
      id: 'b-full-consume-1', type: 'CONSUME', amountUsd: '-0.008336700',
      balanceAfterUsd: '-0.025730916', description: 'usage', orderId: null,
      operationKey: null, tokenUsageId: 'b-usage-full-1',
      createdAt: '2026-07-15T09:04:00.000Z',
    },
    {
      id: 'b-full-consume-2', type: 'CONSUME', amountUsd: '-0.017340300',
      balanceAfterUsd: '-0.043071216', description: 'usage', orderId: null,
      operationKey: null, tokenUsageId: 'b-usage-full-2',
      createdAt: '2026-07-15T09:05:00.000Z',
    },
  );

  const grants: BalanceLedgerRepairSnapshot['grants'] = opening.map(
    ({ amount }, index) => ({
      id: `b-opening-grant-${index + 1}`, orderId: null, source: 'MIGRATION_OPENING',
      paidAmountUsd: amount, bonusAmountUsd: '0', grantedAmountUsd: amount,
      remainingAmountUsd: '0', remainingPaidAmountUsd: null,
      remainingBonusAmountUsd: null, discountRate: '1', isExpired: false,
      validFrom: `2026-07-15T09:00:0${index}.001Z`,
      createdAt: `2026-07-15T09:00:0${index}.002Z`, expiresAt: null,
    }),
  );
  grants.push({
    id: 'b-voucher-grant', orderId: null, source: 'VOUCHER', paidAmountUsd: '0',
    bonusAmountUsd: '100', grantedAmountUsd: '100',
    // Observed pre-repair remainder. It is intentionally neither issuance
    // mint nor the canonical replay target.
    remainingAmountUsd: '0.038480860', remainingPaidAmountUsd: null,
    remainingBonusAmountUsd: null, discountRate: '0', isExpired: false,
    validFrom: '2026-07-15T09:01:00.001Z',
    createdAt: '2026-07-15T09:01:00.019Z',
    expiresAt: '2026-08-14T16:00:00.000Z',
  });

  const allocations: BalanceLedgerRepairSnapshot['allocations'] = opening.map(
    ({ amount }, index) => ({
      id: `b-opening-allocation-${index + 1}`,
      balanceTransactionId: `b-opening-consume-${index + 1}`,
      tokenUsageId: `b-opening-usage-${index + 1}`,
      balanceGrantId: `b-opening-grant-${index + 1}`,
      source: 'BALANCE_GRANT', amountUsd: amount,
      recognizedRevenueUsd: amount, bonusConsumedUsd: '0', settledUsd: '0',
      settledAt: null, createdAt: `2026-07-15T09:00:0${index}.003Z`,
    }),
  );
  allocations.push(
    {
      id: 'b-legitimate-allocation', balanceTransactionId: 'b-legitimate-consume',
      tokenUsageId: 'b-usage-legitimate', balanceGrantId: 'b-voucher-grant',
      source: 'BALANCE_GRANT', amountUsd: '99.906900840', recognizedRevenueUsd: '0',
      bonusConsumedUsd: '99.906900840', settledUsd: '0', settledAt: null,
      createdAt: '2026-07-15T09:02:00.001Z',
    },
    {
      id: 'b-partial-allocation', balanceTransactionId: 'b-partial-consume',
      tokenUsageId: 'b-usage-partial', balanceGrantId: 'b-voucher-grant',
      source: 'BALANCE_GRANT', amountUsd: '0.028941300', recognizedRevenueUsd: '0',
      bonusConsumedUsd: '0.028941300', settledUsd: '0', settledAt: null,
      createdAt: '2026-07-15T09:03:00.001Z',
    },
    {
      id: 'b-full-allocation-1', balanceTransactionId: 'b-full-consume-1',
      tokenUsageId: 'b-usage-full-1', balanceGrantId: 'b-voucher-grant',
      source: 'BALANCE_GRANT', amountUsd: '0.008336700', recognizedRevenueUsd: '0',
      bonusConsumedUsd: '0.008336700', settledUsd: '0', settledAt: null,
      createdAt: '2026-07-15T09:04:00.001Z',
    },
    {
      id: 'b-full-allocation-2', balanceTransactionId: 'b-full-consume-2',
      tokenUsageId: 'b-usage-full-2', balanceGrantId: 'b-voucher-grant',
      source: 'BALANCE_GRANT', amountUsd: '0.017340300', recognizedRevenueUsd: '0',
      bonusConsumedUsd: '0.017340300', settledUsd: '0', settledAt: null,
      createdAt: '2026-07-15T09:05:00.001Z',
    },
  );

  const evidence: RepairVoucherIdempotencyEvidence = {
    key: 'admin:payg-voucher:repair-tenant:b-historical-key',
    scope: 'admin:issue-voucher', userId: 'repair-user', status: 'COMMITTED',
    createdAt: '2026-07-15T09:00:59.995Z', expiresAt: '2026-08-14T09:01:00.029Z',
    result: {
      transaction: {
        id: 'b-voucher-100', type: 'ADJUST', userId: 'repair-user',
        tenantId: 'repair-tenant', amountUsd: 100,
        createdAt: '2026-07-15T09:01:00.029Z', productId: null,
        amountCents: 10000,
        description: 'voucher:b-voucher-grant admin:repair historical voucher',
        balanceAfterUsd: 99.918447924, balanceAfterCents: 9992,
      },
      grant: {
        id: 'b-voucher-grant', source: 'VOUCHER',
        expiresAt: '2026-08-14T16:00:00.000Z', productId: null,
        amountCents: 10000, discountRate: 0,
        // Historical defect: receipt persisted the full amount rather than
        // amount minus the 0.081552076 wallet hole.
        remainingCents: 10000, paidAmountCents: 0, bonusAmountCents: 10000,
      },
    },
  };

  return baseSnapshot({
    billingAccountId: 'ba_personal_absorption_equation',
    walletBalanceUsd: '-0.043071216',
    transactions,
    grants,
    allocations,
    voucherIdempotencyEvidence: [evidence],
  });
}

function legacyMultiAllocationRechargeSnapshot(
  overrides: Partial<BalanceLedgerRepairSnapshot> = {},
): BalanceLedgerRepairSnapshot {
  const repaymentCreatedAt = '2026-07-15T15:52:44.929Z';
  const applicationSettledAt = '2026-07-15T15:52:44.934Z';
  return baseSnapshot({
    billingAccountId: 'ba_legacy_multi_allocation_enterprise',
    accountType: 'enterprise',
    walletBalanceUsd: '4.799404',
    transactions: [
      {
        id: 'legacy-consume-1', type: 'CONSUME', amountUsd: '-0.147311',
        balanceAfterUsd: '-0.147311', description: 'usage 1', orderId: null,
        operationKey: null, createdAt: '2026-07-15T15:50:00.000Z',
      },
      {
        id: 'legacy-consume-2', type: 'CONSUME', amountUsd: '-0.053285',
        balanceAfterUsd: '-0.200596', description: 'usage 2', orderId: null,
        operationKey: null, createdAt: '2026-07-15T15:51:00.000Z',
      },
      {
        id: 'legacy-recharge', type: 'RECHARGE', amountUsd: '5',
        balanceAfterUsd: '4.799404', description: 'order recharge',
        orderId: 'legacy-recharge-order',
        operationKey: null, createdAt: repaymentCreatedAt,
      },
    ],
    grants: [{
      id: 'legacy-recharge-grant', orderId: 'legacy-recharge-order', source: 'RECHARGE',
      paidAmountUsd: '5', bonusAmountUsd: '0', grantedAmountUsd: '5',
      remainingAmountUsd: '4.799404', remainingPaidAmountUsd: null,
      remainingBonusAmountUsd: null, discountRate: '1', isExpired: false,
      validFrom: '2026-07-15T15:52:44.946Z',
      createdAt: '2026-07-15T15:52:44.947Z',
      expiresAt: '2027-07-15T15:52:44.946Z',
    }],
    orders: [completedRechargeOrder({
      id: 'legacy-recharge-order',
      billingAccountId: 'ba_legacy_multi_allocation_enterprise',
      amountCents: 500,
      paidAt: '2026-07-15T15:52:44.900Z',
      completedAt: '2026-07-15T15:52:44.950Z',
      createdAt: '2026-07-15T15:52:00.000Z',
    })],
    allocations: [
      {
        id: 'legacy-debt-1', balanceTransactionId: 'legacy-consume-1',
        balanceGrantId: null, source: 'ENTERPRISE_CREDIT', amountUsd: '0.147311',
        recognizedRevenueUsd: '0.147311', bonusConsumedUsd: '0',
        settledUsd: '0.147311', settledAt: applicationSettledAt,
        createdAt: '2026-07-15T15:50:00.010Z',
      },
      {
        id: 'legacy-debt-2', balanceTransactionId: 'legacy-consume-2',
        balanceGrantId: null, source: 'ENTERPRISE_CREDIT', amountUsd: '0.053285',
        recognizedRevenueUsd: '0.053285', bonusConsumedUsd: '0',
        settledUsd: '0.053285', settledAt: applicationSettledAt,
        createdAt: '2026-07-15T15:51:00.010Z',
      },
    ],
    settlements: [
      {
        id: 'legacy-settlement-1', allocationId: 'legacy-debt-1',
        repaymentTransactionId: 'legacy-recharge', balanceGrantId: null,
        debtSource: 'ENTERPRISE_CREDIT', repairRunId: null,
        operationKey: 'legacy:legacy-settlement-1', trigger: 'FUNDING',
        amountUsd: '0.147311', paidUsd: '0.147311', bonusUsd: '0',
        occurredAt: '2026-07-15T15:52:44.939Z',
        createdAt: '2026-07-15T15:52:44.939Z',
      },
      {
        id: 'legacy-settlement-2', allocationId: 'legacy-debt-2',
        repaymentTransactionId: 'legacy-recharge', balanceGrantId: null,
        debtSource: 'ENTERPRISE_CREDIT', repairRunId: null,
        operationKey: 'legacy:legacy-settlement-2', trigger: 'FUNDING',
        amountUsd: '0.053285', paidUsd: '0.053285', bonusUsd: '0',
        occurredAt: '2026-07-15T15:52:44.945Z',
        createdAt: '2026-07-15T15:52:44.945Z',
      },
    ],
    ...overrides,
  });
}

function singleDebtFundingSnapshot(input: {
  funding: RepairTransaction;
  grants?: RepairGrant[];
  orders?: RepairOrderEvidence[];
}): BalanceLedgerRepairSnapshot {
  return baseSnapshot({
    walletBalanceUsd: input.funding.balanceAfterUsd,
    transactions: [
      {
        id: 'consume', type: 'CONSUME', amountUsd: '-1', balanceAfterUsd: '-1',
        description: 'usage', orderId: null, createdAt: '2026-07-15T10:00:00.000Z',
      },
      input.funding,
    ],
    grants: input.grants ?? [],
    orders: input.orders ?? [],
    allocations: [{
      id: 'debt-1', balanceTransactionId: 'consume', balanceGrantId: null,
      source: 'NEGATIVE_BALANCE', amountUsd: '1', recognizedRevenueUsd: '0',
      bonusConsumedUsd: '0', settledUsd: '0', settledAt: null,
      createdAt: '2026-07-15T10:00:00.000Z',
    }],
  });
}

function repeatedZeroBalanceCyclesSnapshot(sequenced: boolean): BalanceLedgerRepairSnapshot {
  const firstFundingAt = '2026-07-15T10:00:00.000Z';
  const firstConsumeAt = '2026-07-15T10:01:00.000Z';
  const secondFundingAt = '2026-07-15T10:02:00.000Z';
  const secondConsumeAt = '2026-07-15T10:03:00.000Z';
  return baseSnapshot({
    walletBalanceUsd: '0',
    transactions: [
      {
        id: 'cycle-r1', type: 'RECHARGE', amountUsd: '1', balanceAfterUsd: '1',
        description: 'recharge', orderId: 'cycle-o1', operationKey: 'balance:recharge:cycle-o1:paid',
        ledgerSequence: sequenced ? '101' : null, createdAt: firstFundingAt,
      },
      {
        id: 'cycle-c1', type: 'CONSUME', amountUsd: '-1', balanceAfterUsd: '0',
        description: 'usage', orderId: null, ledgerSequence: sequenced ? '102' : null,
        createdAt: firstConsumeAt,
      },
      {
        id: 'cycle-r2', type: 'RECHARGE', amountUsd: '1', balanceAfterUsd: '1',
        description: 'recharge', orderId: 'cycle-o2', operationKey: 'balance:recharge:cycle-o2:paid',
        ledgerSequence: sequenced ? '103' : null, createdAt: secondFundingAt,
      },
      {
        id: 'cycle-c2', type: 'CONSUME', amountUsd: '-1', balanceAfterUsd: '0',
        description: 'usage', orderId: null, ledgerSequence: sequenced ? '104' : null,
        createdAt: secondConsumeAt,
      },
    ],
    grants: [
      {
        id: 'cycle-g1', orderId: 'cycle-o1', source: 'RECHARGE', paidAmountUsd: '1',
        bonusAmountUsd: '0', grantedAmountUsd: '1', remainingAmountUsd: '0',
        remainingPaidAmountUsd: '0', remainingBonusAmountUsd: '0', discountRate: '1',
        isExpired: false, createdAt: firstFundingAt,
      },
      {
        id: 'cycle-g2', orderId: 'cycle-o2', source: 'RECHARGE', paidAmountUsd: '1',
        bonusAmountUsd: '0', grantedAmountUsd: '1', remainingAmountUsd: '0',
        remainingPaidAmountUsd: '0', remainingBonusAmountUsd: '0', discountRate: '1',
        isExpired: false, createdAt: secondFundingAt,
      },
    ],
    allocations: [
      {
        id: 'cycle-a1', balanceTransactionId: 'cycle-c1', balanceGrantId: 'cycle-g1',
        source: 'BALANCE_GRANT', amountUsd: '1', recognizedRevenueUsd: '1',
        bonusConsumedUsd: '0', settledUsd: '0', settledAt: null, ledgerSequence: '201',
        createdAt: firstConsumeAt,
      },
      {
        id: 'cycle-a2', balanceTransactionId: 'cycle-c2', balanceGrantId: 'cycle-g2',
        source: 'BALANCE_GRANT', amountUsd: '1', recognizedRevenueUsd: '1',
        bonusConsumedUsd: '0', settledUsd: '0', settledAt: null, ledgerSequence: '202',
        createdAt: secondConsumeAt,
      },
    ],
  });
}

describe('buildBalanceLedgerRepairPlan', () => {
  it('replays the screenshot pattern and removes the propagated phantom grant', () => {
    const snapshot = baseSnapshot({
      transactions: [
        {
          id: 'recharge-1', type: 'RECHARGE', amountUsd: '1', balanceAfterUsd: '1',
          description: 'recharge', orderId: 'order-1', createdAt: '2026-07-15T13:54:31.000Z',
        },
        {
          id: 'consume-1', type: 'CONSUME', amountUsd: '-1.34', balanceAfterUsd: '-0.34',
          description: 'usage', orderId: null, createdAt: '2026-07-15T14:00:00.000Z',
        },
        {
          id: 'recharge-2', type: 'RECHARGE', amountUsd: '5', balanceAfterUsd: '4.66',
          description: 'recharge', orderId: 'order-2', createdAt: '2026-07-15T15:19:06.000Z',
        },
        {
          id: 'consume-2', type: 'CONSUME', amountUsd: '-4.8', balanceAfterUsd: '-0.14',
          description: 'usage', orderId: null, createdAt: '2026-07-15T15:30:00.000Z',
        },
      ],
      grants: [
        {
          id: 'grant-1', orderId: 'order-1', source: 'RECHARGE', paidAmountUsd: '1',
          bonusAmountUsd: '0', grantedAmountUsd: '1', remainingAmountUsd: '0', remainingPaidAmountUsd: null,
          remainingBonusAmountUsd: null, discountRate: '1', isExpired: false,
          createdAt: '2026-07-15T13:54:31.000Z',
        },
        {
          id: 'grant-2', orderId: 'order-2', source: 'RECHARGE', paidAmountUsd: '5',
          bonusAmountUsd: '0', grantedAmountUsd: '5', remainingAmountUsd: '0.34', remainingPaidAmountUsd: null,
          remainingBonusAmountUsd: null, discountRate: '1', isExpired: false,
          createdAt: '2026-07-15T15:19:06.000Z',
        },
      ],
      allocations: [
        {
          id: 'grant-use-1', balanceTransactionId: 'consume-1', balanceGrantId: 'grant-1',
          source: 'BALANCE_GRANT', amountUsd: '1', recognizedRevenueUsd: '1',
          bonusConsumedUsd: '0', settledUsd: '0', settledAt: null,
          createdAt: '2026-07-15T14:00:00.000Z',
        },
        {
          id: 'negative-1', balanceTransactionId: 'consume-1', balanceGrantId: null,
          source: 'NEGATIVE_BALANCE', amountUsd: '0.34', recognizedRevenueUsd: '0',
          bonusConsumedUsd: '0', settledUsd: '0', settledAt: null,
          createdAt: '2026-07-15T14:00:00.000Z',
        },
        {
          id: 'grant-use-2', balanceTransactionId: 'consume-2', balanceGrantId: 'grant-2',
          source: 'BALANCE_GRANT', amountUsd: '4.66', recognizedRevenueUsd: '4.66',
          bonusConsumedUsd: '0', settledUsd: '0', settledAt: null,
          createdAt: '2026-07-15T15:30:00.000Z',
        },
        {
          id: 'negative-2', balanceTransactionId: 'consume-2', balanceGrantId: null,
          source: 'NEGATIVE_BALANCE', amountUsd: '0.14', recognizedRevenueUsd: '0',
          bonusConsumedUsd: '0', settledUsd: '0', settledAt: null,
          createdAt: '2026-07-15T15:30:00.000Z',
        },
      ],
    });

    const plan = buildBalanceLedgerRepairPlan(snapshot);

    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    expect(plan.currentDebtUsd).toBe('0.140000000000');
    expect(plan.legacySettledDebtUsd).toBe('0.340000000000');
    expect(plan.activeGrantDriftUsd).toBe('0.340000000000');
    expect(plan.grantMutations).toEqual(expect.arrayContaining([
      expect.objectContaining({ grantId: 'grant-2', remainingAmountUsd: '0.000000000000' }),
    ]));
    expect(plan.allocationMutations).toEqual([
      expect.objectContaining({
        allocationId: 'negative-1',
        settledUsd: '0.340000000000',
        recognizedRevenueUsd: '0.340000000000',
        bonusConsumedUsd: '0.000000000000',
      }),
    ]);
    expect(plan.allocationSequenceMutations).toEqual([
      { allocationId: 'grant-use-1', expectedLedgerSequence: null, ledgerSequence: '-4' },
      { allocationId: 'negative-1', expectedLedgerSequence: null, ledgerSequence: '-3' },
      { allocationId: 'grant-use-2', expectedLedgerSequence: null, ledgerSequence: '-2' },
      { allocationId: 'negative-2', expectedLedgerSequence: null, ledgerSequence: '-1' },
    ]);
    expect(plan.settlementMutations).toEqual([
      expect.objectContaining({
        allocationId: 'negative-1',
        repaymentTransactionId: 'recharge-2',
        balanceGrantId: 'grant-2',
        fundingNature: 'PAID',
        amountUsd: '0.340000000000',
      }),
    ]);
  });

  it('uses the balanceAfter chain, not transaction-start createdAt, for legacy debt FIFO', () => {
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      walletBalanceUsd: '-2',
      transactions: [
        {
          // This transaction started first but acquired the wallet lock second.
          id: 'consume-a', type: 'CONSUME', amountUsd: '-3', balanceAfterUsd: '-5',
          description: 'usage-a', orderId: null, createdAt: '2026-07-15T10:00:00.000Z',
        },
        {
          id: 'consume-b', type: 'CONSUME', amountUsd: '-2', balanceAfterUsd: '-2',
          description: 'usage-b', orderId: null, createdAt: '2026-07-15T10:01:00.000Z',
        },
        {
          id: 'recharge', type: 'RECHARGE', amountUsd: '3', balanceAfterUsd: '-2',
          description: 'recharge', orderId: 'order', createdAt: '2026-07-15T10:02:00.000Z',
        },
      ],
      grants: [{
        id: 'grant', orderId: 'order', source: 'RECHARGE', paidAmountUsd: '3',
        bonusAmountUsd: '0', grantedAmountUsd: '3', remainingAmountUsd: '3',
        remainingPaidAmountUsd: null, remainingBonusAmountUsd: null,
        discountRate: '1', isExpired: false, createdAt: '2026-07-15T10:02:00.000Z',
      }],
      allocations: [
        {
          id: 'debt-a', balanceTransactionId: 'consume-a', balanceGrantId: null,
          source: 'NEGATIVE_BALANCE', amountUsd: '3', recognizedRevenueUsd: '0',
          bonusConsumedUsd: '0', settledUsd: '0', settledAt: null,
          createdAt: '2026-07-15T10:00:00.000Z',
        },
        {
          id: 'debt-b', balanceTransactionId: 'consume-b', balanceGrantId: null,
          source: 'NEGATIVE_BALANCE', amountUsd: '2', recognizedRevenueUsd: '0',
          bonusConsumedUsd: '0', settledUsd: '0', settledAt: null,
          createdAt: '2026-07-15T10:01:00.000Z',
        },
      ],
    }));

    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    expect(plan.allocationSequenceMutations).toEqual([
      { allocationId: 'debt-b', expectedLedgerSequence: null, ledgerSequence: '-2' },
      { allocationId: 'debt-a', expectedLedgerSequence: null, ledgerSequence: '-1' },
    ]);
    expect(plan.settlementMutations).toEqual([
      expect.objectContaining({ allocationId: 'debt-b', amountUsd: '2.000000000000' }),
      expect.objectContaining({ allocationId: 'debt-a', amountUsd: '1.000000000000' }),
    ]);
    const tampered = {
      ...plan,
      allocationSequenceMutations: plan.allocationSequenceMutations.map((mutation) => ({
        ...mutation,
        ledgerSequence: mutation.allocationId === 'debt-b' ? '-1' : mutation.ledgerSequence,
      })),
    };
    expect(balanceLedgerRepairReplayHash(tampered)).not.toBe(plan.replayHash);
  });

  it('repairs the complete merged screenshot ledger with all three recharge batches exhausted', () => {
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      transactions: [
        {
          id: 'r1', type: 'RECHARGE', amountUsd: '1', balanceAfterUsd: '1',
          description: 'recharge', orderId: 'o1', createdAt: '2026-07-15T13:54:31.000Z',
        },
        {
          id: 'c1', type: 'CONSUME', amountUsd: '-1.34', balanceAfterUsd: '-0.34',
          description: 'usage', orderId: null, createdAt: '2026-07-15T14:00:00.000Z',
        },
        {
          id: 'r2', type: 'RECHARGE', amountUsd: '5', balanceAfterUsd: '4.66',
          description: 'recharge', orderId: 'o2', createdAt: '2026-07-15T15:19:06.000Z',
        },
        {
          id: 'r3', type: 'RECHARGE', amountUsd: '5', balanceAfterUsd: '9.66',
          description: 'recharge', orderId: 'o3', createdAt: '2026-07-15T15:52:44.000Z',
        },
        {
          id: 'c2', type: 'CONSUME', amountUsd: '-9.8', balanceAfterUsd: '-0.14',
          description: 'usage', orderId: null, createdAt: '2026-07-15T16:00:00.000Z',
        },
      ],
      grants: [
        {
          id: 'g1', orderId: 'o1', source: 'RECHARGE', paidAmountUsd: '1', bonusAmountUsd: '0',
          grantedAmountUsd: '1', remainingAmountUsd: '0', remainingPaidAmountUsd: null,
          remainingBonusAmountUsd: null, discountRate: '1', isExpired: false,
          createdAt: '2026-07-15T13:54:31.000Z',
        },
        {
          id: 'g2', orderId: 'o2', source: 'RECHARGE', paidAmountUsd: '5', bonusAmountUsd: '0',
          grantedAmountUsd: '5', remainingAmountUsd: '0', remainingPaidAmountUsd: null,
          remainingBonusAmountUsd: null, discountRate: '1', isExpired: false,
          createdAt: '2026-07-15T15:19:06.000Z',
        },
        {
          id: 'g3', orderId: 'o3', source: 'RECHARGE', paidAmountUsd: '5', bonusAmountUsd: '0',
          grantedAmountUsd: '5', remainingAmountUsd: '0.34', remainingPaidAmountUsd: null,
          remainingBonusAmountUsd: null, discountRate: '1', isExpired: false,
          createdAt: '2026-07-15T15:52:44.000Z',
        },
      ],
      allocations: [
        {
          id: 'c1-g1', balanceTransactionId: 'c1', balanceGrantId: 'g1', source: 'BALANCE_GRANT',
          amountUsd: '1', recognizedRevenueUsd: '1', bonusConsumedUsd: '0', settledUsd: '0',
          settledAt: null, createdAt: '2026-07-15T14:00:00.000Z',
        },
        {
          id: 'c1-debt', balanceTransactionId: 'c1', balanceGrantId: null,
          source: 'NEGATIVE_BALANCE', amountUsd: '0.34', recognizedRevenueUsd: '0',
          bonusConsumedUsd: '0', settledUsd: '0', settledAt: null,
          createdAt: '2026-07-15T14:00:00.000Z',
        },
        {
          id: 'c2-g2', balanceTransactionId: 'c2', balanceGrantId: 'g2', source: 'BALANCE_GRANT',
          amountUsd: '5', recognizedRevenueUsd: '5', bonusConsumedUsd: '0', settledUsd: '0',
          settledAt: null, createdAt: '2026-07-15T16:00:00.000Z',
        },
        {
          id: 'c2-g3', balanceTransactionId: 'c2', balanceGrantId: 'g3', source: 'BALANCE_GRANT',
          amountUsd: '4.66', recognizedRevenueUsd: '4.66', bonusConsumedUsd: '0', settledUsd: '0',
          settledAt: null, createdAt: '2026-07-15T16:00:00.000Z',
        },
        {
          id: 'c2-debt', balanceTransactionId: 'c2', balanceGrantId: null,
          source: 'NEGATIVE_BALANCE', amountUsd: '0.14', recognizedRevenueUsd: '0',
          bonusConsumedUsd: '0', settledUsd: '0', settledAt: null,
          createdAt: '2026-07-15T16:00:00.000Z',
        },
      ],
    }));

    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    expect(plan.walletBalanceUsd).toBe('-0.140000000000');
    expect(plan.currentDebtUsd).toBe('0.140000000000');
    expect(plan.legacySettledDebtUsd).toBe('0.340000000000');
    expect(plan.canonicalAllocationMutations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        allocationId: 'c2-g2', balanceGrantId: 'g2', amountUsd: '4.660000000000',
        ledgerSequence: '-2',
      }),
      expect.objectContaining({
        allocationId: 'c2-g3', balanceGrantId: 'g3', amountUsd: '5.000000000000',
        ledgerSequence: '-1',
      }),
    ]));
    expect(plan.grantMutations).toEqual(expect.arrayContaining([
      expect.objectContaining({ grantId: 'g1', remainingAmountUsd: '0.000000000000' }),
      expect.objectContaining({ grantId: 'g2', remainingAmountUsd: '0.000000000000' }),
      expect.objectContaining({ grantId: 'g3', remainingAmountUsd: '0.000000000000' }),
    ]));
    expect(plan.settlementMutations).toEqual([
      expect.objectContaining({ allocationId: 'c1-debt', amountUsd: '0.340000000000' }),
    ]);
  });

  it('sequences unnumbered grant rows by proven FIFO attribution instead of allocation UUID', () => {
    const snapshot = baseSnapshot({
      walletBalanceUsd: '0.7',
      transactions: [
        {
          id: 'recharge-first', type: 'RECHARGE', amountUsd: '1', balanceAfterUsd: '1',
          description: 'recharge', orderId: 'order-first', createdAt: '2026-07-15T10:00:00.000Z',
        },
        {
          id: 'consume-first', type: 'CONSUME', amountUsd: '-0.8', balanceAfterUsd: '0.2',
          description: 'usage', orderId: null, createdAt: '2026-07-15T10:01:00.000Z',
        },
        {
          id: 'recharge-later', type: 'RECHARGE', amountUsd: '1', balanceAfterUsd: '1.2',
          description: 'recharge', orderId: 'order-later', createdAt: '2026-07-15T10:02:00.000Z',
        },
        {
          id: 'consume-cross-batch', type: 'CONSUME', amountUsd: '-0.5', balanceAfterUsd: '0.7',
          description: 'usage', orderId: null, createdAt: '2026-07-15T10:03:00.000Z',
        },
      ],
      grants: [
        {
          id: 'grant-first', orderId: 'order-first', source: 'RECHARGE',
          paidAmountUsd: '1', bonusAmountUsd: '0', grantedAmountUsd: '1',
          remainingAmountUsd: '0', remainingPaidAmountUsd: null,
          remainingBonusAmountUsd: null, discountRate: '1', isExpired: false,
          createdAt: '2026-07-15T10:00:00.000Z',
        },
        {
          id: 'grant-later', orderId: 'order-later', source: 'RECHARGE',
          paidAmountUsd: '1', bonusAmountUsd: '0', grantedAmountUsd: '1',
          remainingAmountUsd: '0.7', remainingPaidAmountUsd: null,
          remainingBonusAmountUsd: null, discountRate: '1', isExpired: false,
          createdAt: '2026-07-15T10:02:00.000Z',
        },
      ],
      allocations: [
        {
          id: 'consume-first-grant', balanceTransactionId: 'consume-first',
          balanceGrantId: 'grant-first', source: 'BALANCE_GRANT', amountUsd: '0.8',
          recognizedRevenueUsd: '0.8', bonusConsumedUsd: '0', settledUsd: '0',
          settledAt: null, createdAt: '2026-07-15T10:01:00.000Z',
        },
        {
          // This UUID sorts first, but the row belongs to the later grant.
          id: 'a-later-grant-row', balanceTransactionId: 'consume-cross-batch',
          balanceGrantId: 'grant-later', source: 'BALANCE_GRANT', amountUsd: '0.3',
          recognizedRevenueUsd: '0.3', bonusConsumedUsd: '0', settledUsd: '0',
          settledAt: null, createdAt: '2026-07-15T10:03:00.000Z',
        },
        {
          id: 'z-first-grant-row', balanceTransactionId: 'consume-cross-batch',
          balanceGrantId: 'grant-first', source: 'BALANCE_GRANT', amountUsd: '0.2',
          recognizedRevenueUsd: '0.2', bonusConsumedUsd: '0', settledUsd: '0',
          settledAt: null, createdAt: '2026-07-15T10:03:00.000Z',
        },
      ],
    });
    const plan = buildBalanceLedgerRepairPlan(snapshot);

    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    expect(plan.canonicalAllocationMutations).toEqual([]);
    expect(plan.allocationSequenceMutations).toEqual([
      expect.objectContaining({
        allocationId: 'consume-first-grant', ledgerSequence: '-3',
      }),
      expect.objectContaining({
        allocationId: 'z-first-grant-row', ledgerSequence: '-2',
      }),
      expect.objectContaining({
        allocationId: 'a-later-grant-row', ledgerSequence: '-1',
      }),
    ]);

    const fixedInWrongOrder = buildBalanceLedgerRepairPlan({
      ...snapshot,
      allocations: snapshot.allocations.map((allocation) => ({
        ...allocation,
        ledgerSequence: allocation.id === 'consume-first-grant'
          ? '-3'
          : allocation.id === 'a-later-grant-row' ? '-2' : '-1',
      })),
    });
    expect(fixedInWrongOrder).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        expect.stringContaining('ALLOCATION_LEGACY_SEQUENCE_MISMATCH:'),
      ]),
    }));
    const fixedPositiveInWrongOrder = buildBalanceLedgerRepairPlan({
      ...snapshot,
      allocations: snapshot.allocations.map((allocation) => ({
        ...allocation,
        ledgerSequence: allocation.id === 'consume-first-grant'
          ? '1'
          : allocation.id === 'a-later-grant-row' ? '2' : '3',
      })),
    });
    expect(fixedPositiveInWrongOrder).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        expect.stringContaining('ALLOCATION_LEDGER_SEQUENCE_ORDER_MISMATCH:'),
      ]),
    }));

    const withDebtSlot = buildBalanceLedgerRepairPlan({
      ...snapshot,
      walletBalanceUsd: '-0.3',
      transactions: snapshot.transactions.map((transaction) => (
        transaction.id === 'consume-cross-batch'
          ? { ...transaction, amountUsd: '-1.5', balanceAfterUsd: '-0.3' }
          : transaction
      )),
      grants: snapshot.grants.map((grant) => (
        grant.id === 'grant-later'
          ? {
            ...grant,
            remainingAmountUsd: '0',
            remainingPaidAmountUsd: '0',
            remainingBonusAmountUsd: '0',
          }
          : grant
      )),
      allocations: [
        ...snapshot.allocations.map((allocation) => (
          allocation.id === 'a-later-grant-row'
            ? { ...allocation, amountUsd: '1', recognizedRevenueUsd: '1' }
            : allocation
        )),
        {
          id: 'm-debt-row',
          userId: 'repair-user',
          tenantId: 'repair-tenant',
          billingAccountId: snapshot.billingAccountId,
          productId: null,
          tokenUsageId: null,
          balanceTransactionId: 'consume-cross-batch',
          balanceGrantId: null,
          source: 'NEGATIVE_BALANCE',
          amountUsd: '0.3',
          recognizedRevenueUsd: '0',
          bonusConsumedUsd: '0',
          discountRate: '0',
          settledUsd: '0',
          settledAt: null,
          ledgerSequence: null,
          createdAt: '2026-07-15T10:03:00.000Z',
        },
      ],
    });
    expect(withDebtSlot.status).toBe('READY');
    if (withDebtSlot.status !== 'READY') return;
    expect(withDebtSlot.allocationSequenceMutations).toEqual([
      expect.objectContaining({
        allocationId: 'consume-first-grant', ledgerSequence: '-4',
      }),
      expect.objectContaining({
        allocationId: 'z-first-grant-row', ledgerSequence: '-3',
      }),
      expect.objectContaining({
        allocationId: 'm-debt-row', ledgerSequence: '-2',
      }),
      expect.objectContaining({
        allocationId: 'a-later-grant-row', ledgerSequence: '-1',
      }),
    ]);
  });

  it('finds the unique complete wallet path and folds two legacy rows into the final batch', () => {
    const merged = baseSnapshot({
      transactions: [
        { id: 'r1', type: 'RECHARGE', amountUsd: '1', balanceAfterUsd: '1', description: 'recharge', orderId: 'o1', createdAt: '2026-07-15T10:00:00.000Z' },
        { id: 'c1', type: 'CONSUME', amountUsd: '-1.34', balanceAfterUsd: '-0.34', description: 'usage', orderId: null, createdAt: '2026-07-15T10:01:00.000Z' },
        { id: 'r2', type: 'RECHARGE', amountUsd: '5', balanceAfterUsd: '4.66', description: 'recharge', orderId: 'o2', createdAt: '2026-07-15T10:02:00.000Z' },
        { id: 'c2', type: 'CONSUME', amountUsd: '-4.66', balanceAfterUsd: '0', description: 'usage', orderId: null, createdAt: '2026-07-15T10:03:00.000Z' },
        { id: 'r3', type: 'RECHARGE', amountUsd: '5', balanceAfterUsd: '5', description: 'recharge', orderId: 'o3', createdAt: '2026-07-15T10:04:00.000Z' },
        { id: 'c3', type: 'CONSUME', amountUsd: '-5.14', balanceAfterUsd: '-0.14', description: 'usage', orderId: null, createdAt: '2026-07-15T10:05:00.000Z' },
      ],
      grants: [
        { id: 'g1', orderId: 'o1', source: 'RECHARGE', paidAmountUsd: '1', bonusAmountUsd: '0', grantedAmountUsd: '1', remainingAmountUsd: '0', remainingPaidAmountUsd: null, remainingBonusAmountUsd: null, discountRate: '1', isExpired: false, createdAt: '2026-07-15T10:00:00.000Z' },
        { id: 'g2', orderId: 'o2', source: 'RECHARGE', paidAmountUsd: '5', bonusAmountUsd: '0', grantedAmountUsd: '5', remainingAmountUsd: '0', remainingPaidAmountUsd: null, remainingBonusAmountUsd: null, discountRate: '1', isExpired: false, createdAt: '2026-07-15T10:02:00.000Z' },
        { id: 'g3', orderId: 'o3', source: 'RECHARGE', paidAmountUsd: '5', bonusAmountUsd: '0', grantedAmountUsd: '5', remainingAmountUsd: '0.34', remainingPaidAmountUsd: null, remainingBonusAmountUsd: null, discountRate: '1', isExpired: false, createdAt: '2026-07-15T10:04:00.000Z' },
      ],
      allocations: [
        { id: 'c1-g1', balanceTransactionId: 'c1', balanceGrantId: 'g1', source: 'BALANCE_GRANT', amountUsd: '1', recognizedRevenueUsd: '1', bonusConsumedUsd: '0', settledUsd: '0', settledAt: null, createdAt: '2026-07-15T10:01:00.000Z' },
        { id: 'c1-debt', balanceTransactionId: 'c1', balanceGrantId: null, source: 'NEGATIVE_BALANCE', amountUsd: '0.34', recognizedRevenueUsd: '0', bonusConsumedUsd: '0', settledUsd: '0', settledAt: null, createdAt: '2026-07-15T10:01:00.000Z' },
        { id: 'c2-g2', balanceTransactionId: 'c2', balanceGrantId: 'g2', source: 'BALANCE_GRANT', amountUsd: '4.66', recognizedRevenueUsd: '4.66', bonusConsumedUsd: '0', settledUsd: '0', settledAt: null, createdAt: '2026-07-15T10:03:00.000Z' },
        { id: 'c3-g2', balanceTransactionId: 'c3', balanceGrantId: 'g2', source: 'BALANCE_GRANT', amountUsd: '0.34', recognizedRevenueUsd: '0.34', bonusConsumedUsd: '0', settledUsd: '0', settledAt: null, createdAt: '2026-07-15T10:05:00.000Z' },
        { id: 'c3-g3', balanceTransactionId: 'c3', balanceGrantId: 'g3', source: 'BALANCE_GRANT', amountUsd: '4.66', recognizedRevenueUsd: '4.66', bonusConsumedUsd: '0', settledUsd: '0', settledAt: null, createdAt: '2026-07-15T10:05:00.000Z' },
        { id: 'c3-debt', balanceTransactionId: 'c3', balanceGrantId: null, source: 'NEGATIVE_BALANCE', amountUsd: '0.14', recognizedRevenueUsd: '0', bonusConsumedUsd: '0', settledUsd: '0', settledAt: null, createdAt: '2026-07-15T10:05:00.000Z' },
      ],
    });

    const plan = buildBalanceLedgerRepairPlan(merged);

    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    expect(plan.canonicalAllocationMutations).toEqual([
      expect.objectContaining({
        allocationId: 'c3-g2',
        expectedBalanceGrantId: 'g2',
        balanceGrantId: 'g3',
        amountUsd: '0.340000000000',
      }),
    ]);
    expect(plan.grantMutations).toEqual(expect.arrayContaining([
      expect.objectContaining({ grantId: 'g3', remainingAmountUsd: '0.000000000000' }),
    ]));
    expect(plan.settlementMutations).toEqual([
      expect.objectContaining({ allocationId: 'c1-debt', amountUsd: '0.340000000000' }),
    ]);
  });

  it('uses durable transaction sequences to replay repeated zero-balance cycles', () => {
    const plan = buildBalanceLedgerRepairPlan(repeatedZeroBalanceCyclesSnapshot(true));

    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    expect(plan.throughTransactionId).toBe('cycle-c2');
    expect(plan.transactionSequenceMutations).toEqual([]);
  });

  it('quarantines repeated legacy zero-balance cycles instead of guessing from timestamps', () => {
    const plan = buildBalanceLedgerRepairPlan(repeatedZeroBalanceCyclesSnapshot(false));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        expect.stringContaining('TRANSACTION_CHAIN_AMBIGUOUS:'),
      ]),
    }));
  });

  it('proves an oversized unsequenced legacy prefix through unique wallet edges in linear time', () => {
    const transactions = Array.from({ length: 5001 }, (_, index): RepairTransaction => ({
      id: `consume-${index}`,
      type: 'CONSUME',
      amountUsd: '-1',
      balanceAfterUsd: String(-(index + 1)),
      description: 'usage',
      orderId: null,
      ledgerSequence: null,
      createdAt: '2026-07-15T10:00:00.000Z',
    }));
    const allocations = transactions.map((transaction, index) => ({
      id: `debt-${index}`,
      balanceTransactionId: transaction.id,
      balanceGrantId: null,
      source: 'NEGATIVE_BALANCE',
      amountUsd: '1',
      recognizedRevenueUsd: '0',
      bonusConsumedUsd: '0',
      settledUsd: '0',
      settledAt: null,
      ledgerSequence: null,
      createdAt: transaction.createdAt,
    }));
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      walletBalanceUsd: '-5001',
      transactions,
      allocations,
    }));

    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    expect(plan.throughTransactionId).toBe('consume-5000');
    expect(plan.transactionSequenceMutations).toHaveLength(5001);
    expect(plan.allocationSequenceMutations).toHaveLength(5001);
  });

  it('keeps oversized non-functional balance graphs behind the bounded path search', () => {
    const transactions = Array.from({ length: 5001 }, (_, index): RepairTransaction => ({
      id: `legacy-${index}`,
      type: 'ADJUST',
      amountUsd: '1',
      balanceAfterUsd: String(index + 1),
      description: 'legacy adjustment',
      orderId: null,
      ledgerSequence: null,
      createdAt: '2026-07-15T10:00:00.000Z',
    }));
    transactions.push({
      id: 'legacy-branch',
      type: 'ADJUST',
      amountUsd: '2',
      balanceAfterUsd: '2',
      description: 'legacy branch',
      orderId: null,
      ledgerSequence: null,
      createdAt: '2026-07-15T10:00:00.000Z',
    });

    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      walletBalanceUsd: '5001',
      transactions,
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        'TRANSACTION_CHAIN_SEARCH_LIMIT:transactions=5002',
      ]),
    }));
  });

  it('quarantines a positive transaction sequence whose wallet edges are disconnected', () => {
    const snapshot = repeatedZeroBalanceCyclesSnapshot(true);
    snapshot.transactions[1].balanceAfterUsd = '0.5';
    const plan = buildBalanceLedgerRepairPlan(snapshot);

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        expect.stringContaining('TRANSACTION_POSITIVE_SEQUENCE_CHAIN_BROKEN:'),
      ]),
    }));
  });

  it('backfills legacy rows before positive post-deploy sequences on a dirty account', () => {
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      walletBalanceUsd: '-2',
      transactions: [
        {
          id: 'consume-legacy', type: 'CONSUME', amountUsd: '-1', balanceAfterUsd: '-1',
          description: 'legacy', orderId: null, ledgerSequence: null,
          createdAt: '2026-07-15T10:00:00.000Z',
        },
        {
          id: 'consume-v2', type: 'CONSUME', amountUsd: '-1', balanceAfterUsd: '-2',
          description: 'v2', orderId: null, ledgerSequence: '42',
          createdAt: '2026-07-15T10:01:00.000Z',
        },
      ],
      allocations: [
        {
          id: 'debt-legacy', balanceTransactionId: 'consume-legacy', balanceGrantId: null,
          source: 'NEGATIVE_BALANCE', amountUsd: '1', recognizedRevenueUsd: '0',
          bonusConsumedUsd: '0', settledUsd: '0', settledAt: null, ledgerSequence: null,
          createdAt: '2026-07-15T10:00:00.000Z',
        },
        {
          id: 'debt-v2', balanceTransactionId: 'consume-v2', balanceGrantId: null,
          source: 'NEGATIVE_BALANCE', amountUsd: '1', recognizedRevenueUsd: '0',
          bonusConsumedUsd: '0', settledUsd: '0', settledAt: null, ledgerSequence: '42',
          createdAt: '2026-07-15T10:01:00.000Z',
        },
      ],
    }));

    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    expect(plan.transactionSequenceMutations).toEqual([
      { transactionId: 'consume-legacy', expectedLedgerSequence: null, ledgerSequence: '-1' },
    ]);
    expect(plan.allocationSequenceMutations).toEqual([
      { allocationId: 'debt-legacy', expectedLedgerSequence: null, ledgerSequence: '-1' },
    ]);
  });

  it('quarantines a legacy NULL allocation that appears after the positive-sequence epoch', () => {
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      walletBalanceUsd: '-2',
      transactions: [
        {
          id: 'consume-v2', type: 'CONSUME', amountUsd: '-1', balanceAfterUsd: '-1',
          description: 'v2', orderId: null, createdAt: '2026-07-15T10:00:00.000Z',
        },
        {
          id: 'consume-null', type: 'CONSUME', amountUsd: '-1', balanceAfterUsd: '-2',
          description: 'unexpected-null', orderId: null, createdAt: '2026-07-15T10:01:00.000Z',
        },
      ],
      allocations: [
        {
          id: 'debt-v2', balanceTransactionId: 'consume-v2', balanceGrantId: null,
          source: 'NEGATIVE_BALANCE', amountUsd: '1', recognizedRevenueUsd: '0',
          bonusConsumedUsd: '0', settledUsd: '0', settledAt: null, ledgerSequence: '42',
          createdAt: '2026-07-15T10:00:00.000Z',
        },
        {
          id: 'debt-null', balanceTransactionId: 'consume-null', balanceGrantId: null,
          source: 'NEGATIVE_BALANCE', amountUsd: '1', recognizedRevenueUsd: '0',
          bonusConsumedUsd: '0', settledUsd: '0', settledAt: null, ledgerSequence: null,
          createdAt: '2026-07-15T10:01:00.000Z',
        },
      ],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        'ALLOCATION_LEDGER_SEQUENCE_EPOCH_MISMATCH:debt-null',
      ]),
    }));
  });

  it('quarantines mixed legacy and V2 sequence epochs inside one transaction', () => {
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      walletBalanceUsd: '-2',
      transactions: [{
        id: 'consume-mixed', type: 'CONSUME', amountUsd: '-2', balanceAfterUsd: '-2',
        description: 'mixed-epoch', orderId: null, createdAt: '2026-07-15T10:00:00.000Z',
      }],
      allocations: [
        {
          id: 'debt-null', balanceTransactionId: 'consume-mixed', balanceGrantId: null,
          source: 'NEGATIVE_BALANCE', amountUsd: '1', recognizedRevenueUsd: '0',
          bonusConsumedUsd: '0', settledUsd: '0', settledAt: null, ledgerSequence: null,
          createdAt: '2026-07-15T10:00:00.000Z',
        },
        {
          id: 'debt-v2', balanceTransactionId: 'consume-mixed', balanceGrantId: null,
          source: 'NEGATIVE_BALANCE', amountUsd: '1', recognizedRevenueUsd: '0',
          bonusConsumedUsd: '0', settledUsd: '0', settledAt: null, ledgerSequence: '42',
          createdAt: '2026-07-15T10:00:00.000Z',
        },
      ],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        'ALLOCATION_LEDGER_SEQUENCE_MIXED_TRANSACTION:consume-mixed',
      ]),
    }));
  });

  it('keeps paid and bonus debt settlements separate', () => {
    const snapshot = baseSnapshot({
      walletBalanceUsd: '-0.5',
      transactions: [
        {
          id: 'consume', type: 'CONSUME', amountUsd: '-2', balanceAfterUsd: '-2',
          description: 'usage', orderId: null, createdAt: '2026-07-15T10:00:00.000Z',
        },
        {
          id: 'voucher', type: 'ADJUST', amountUsd: '0.5', balanceAfterUsd: '-1.5',
          description: 'voucher:grant-v support', orderId: null, createdAt: '2026-07-15T10:01:00.000Z',
        },
        {
          id: 'recharge', type: 'RECHARGE', amountUsd: '1', balanceAfterUsd: '-0.5',
          description: 'recharge', orderId: 'order-r', createdAt: '2026-07-15T10:02:00.000Z',
        },
      ],
      grants: [
        {
          id: 'grant-v', orderId: null, source: 'VOUCHER', paidAmountUsd: '0',
          bonusAmountUsd: '0.5', grantedAmountUsd: '0.5', remainingAmountUsd: '0.5', remainingPaidAmountUsd: null,
          remainingBonusAmountUsd: null, discountRate: '0', isExpired: false,
          createdAt: '2026-07-15T10:01:00.000Z',
        },
        {
          id: 'grant-r', orderId: 'order-r', source: 'RECHARGE', paidAmountUsd: '1',
          bonusAmountUsd: '0', grantedAmountUsd: '1', remainingAmountUsd: '1', remainingPaidAmountUsd: null,
          remainingBonusAmountUsd: null, discountRate: '1', isExpired: false,
          createdAt: '2026-07-15T10:02:00.000Z',
        },
      ],
      allocations: [{
        id: 'negative', balanceTransactionId: 'consume', balanceGrantId: null,
        source: 'NEGATIVE_BALANCE', amountUsd: '2', recognizedRevenueUsd: '0',
        bonusConsumedUsd: '0', settledUsd: '0', settledAt: null,
        createdAt: '2026-07-15T10:00:00.000Z',
      }],
    });

    const plan = buildBalanceLedgerRepairPlan(snapshot);

    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    expect(plan.allocationMutations[0]).toEqual(expect.objectContaining({
      settledUsd: '1.500000000000',
      recognizedRevenueUsd: '1.000000000000',
      bonusConsumedUsd: '0.500000000000',
    }));
    expect(plan.settlementMutations.map((row) => row.fundingNature)).toEqual(['BONUS', 'PAID']);
  });

  it('accepts a real legacy voucher only through its complete grant fingerprint', () => {
    const fundingAt = '2026-07-15T10:01:00.000Z';
    const plan = buildBalanceLedgerRepairPlan(singleDebtFundingSnapshot({
      funding: {
        id: 'voucher', type: 'ADJUST', amountUsd: '2', balanceAfterUsd: '1',
        description: 'voucher:grant-v admin:operator-1 客服补偿', orderId: null,
        operationKey: null, createdAt: fundingAt,
      },
      grants: [{
        id: 'grant-v', orderId: null, source: 'VOUCHER', paidAmountUsd: '0',
        bonusAmountUsd: '2', grantedAmountUsd: '2', remainingAmountUsd: '1',
        remainingPaidAmountUsd: '0', remainingBonusAmountUsd: '1', discountRate: '0',
        isExpired: false, validFrom: fundingAt, expiresAt: null, createdAt: fundingAt,
      }],
    }));

    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    expect(plan.settlementMutations).toEqual([
      expect.objectContaining({
        repaymentTransactionId: 'voucher',
        balanceGrantId: 'grant-v',
        fundingNature: 'BONUS',
        paidUsd: '0.000000000000',
        bonusUsd: '1.000000000000',
      }),
    ]);
  });

  it('quarantines arbitrary text that merely contains a voucher marker', () => {
    const fundingAt = '2026-07-15T10:01:00.000Z';
    const plan = buildBalanceLedgerRepairPlan(singleDebtFundingSnapshot({
      funding: {
        id: 'forged-voucher', type: 'ADJUST', amountUsd: '2', balanceAfterUsd: '1',
        description: '客服备注 voucher:grant-v 客服补偿', orderId: null,
        operationKey: null, createdAt: fundingAt,
      },
      grants: [{
        id: 'grant-v', orderId: null, source: 'VOUCHER', paidAmountUsd: '0',
        bonusAmountUsd: '2', grantedAmountUsd: '2', remainingAmountUsd: '1',
        remainingPaidAmountUsd: '0', remainingBonusAmountUsd: '1', discountRate: '0',
        isExpired: false, validFrom: fundingAt, expiresAt: null, createdAt: fundingAt,
      }],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        'AMBIGUOUS_POSITIVE_FUNDING:forged-voucher:客服备注 voucher:grant-v 客服补偿',
      ]),
    }));
  });

  it.each([
    ['wrong grant source', { source: 'RECHARGE' }, {}],
    ['wrong grant amount', { bonusAmountUsd: '3', grantedAmountUsd: '3' }, {}],
    ['wrong grant creation time', { createdAt: '2026-07-15T10:01:01.000Z' }, {}],
    ['contradictory transaction operation key', {}, {
      operationKey: 'balance:voucher:grant:other-grant',
    }],
  ])(
    'quarantines exact voucher text with %s',
    (_label, grantOverride, transactionOverride) => {
      const fundingAt = '2026-07-15T10:01:00.000Z';
      const plan = buildBalanceLedgerRepairPlan(singleDebtFundingSnapshot({
        funding: {
          id: 'voucher', type: 'ADJUST', amountUsd: '2', balanceAfterUsd: '1',
          description: 'voucher:grant-v 客服补偿', orderId: null,
          operationKey: null, createdAt: fundingAt,
          ...transactionOverride,
        },
        grants: [{
          id: 'grant-v', orderId: null, source: 'VOUCHER', paidAmountUsd: '0',
          bonusAmountUsd: '2', grantedAmountUsd: '2', remainingAmountUsd: '1',
          remainingPaidAmountUsd: '0', remainingBonusAmountUsd: '1', discountRate: '0',
          isExpired: false, validFrom: fundingAt, expiresAt: null, createdAt: fundingAt,
          ...grantOverride,
        }],
      }));

      expect(plan).toEqual(expect.objectContaining({
        status: 'QUARANTINED',
        reasons: expect.arrayContaining([
          expect.stringContaining('FUNDING_VOUCHER_GRANT_MISMATCH:voucher:grant-v:'),
        ]),
      }));
    },
  );

  it('quarantines a voucher description that points at the wrong same-account grant', () => {
    const fundingAt = '2026-07-15T10:01:00.000Z';
    const plan = buildBalanceLedgerRepairPlan(singleDebtFundingSnapshot({
      funding: {
        id: 'voucher', type: 'ADJUST', amountUsd: '2', balanceAfterUsd: '1',
        description: 'voucher:grant-v 客服补偿', orderId: null,
        operationKey: null, createdAt: fundingAt,
      },
      grants: [{
        id: 'grant-other', orderId: null, source: 'VOUCHER', paidAmountUsd: '0',
        bonusAmountUsd: '2', grantedAmountUsd: '2', remainingAmountUsd: '1',
        remainingPaidAmountUsd: '0', remainingBonusAmountUsd: '1', discountRate: '0',
        isExpired: false, validFrom: fundingAt, expiresAt: null, createdAt: fundingAt,
      }],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        'FUNDING_VOUCHER_GRANT_MATCH_0:voucher:grant-v',
      ]),
    }));
  });

  it('reconciles a provable positive paid-only account without clearing its live grant', () => {
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      walletBalanceUsd: '2',
      transactions: [
        {
          id: 'recharge', type: 'RECHARGE', amountUsd: '5', balanceAfterUsd: '5',
          description: 'recharge', orderId: 'order', createdAt: '2026-07-15T10:00:00.000Z',
        },
        {
          id: 'consume', type: 'CONSUME', amountUsd: '-3', balanceAfterUsd: '2',
          description: 'usage', orderId: null, createdAt: '2026-07-15T10:01:00.000Z',
        },
      ],
      grants: [{
        id: 'grant', orderId: 'order', source: 'RECHARGE', paidAmountUsd: '5',
        bonusAmountUsd: '0', grantedAmountUsd: '5', remainingAmountUsd: '2', remainingPaidAmountUsd: null,
        remainingBonusAmountUsd: null, discountRate: '1', isExpired: false,
        createdAt: '2026-07-15T10:00:00.000Z',
      }],
      allocations: [{
        id: 'grant-use', balanceTransactionId: 'consume', balanceGrantId: 'grant',
        source: 'BALANCE_GRANT', amountUsd: '3', recognizedRevenueUsd: '3',
        bonusConsumedUsd: '0', settledUsd: '0', settledAt: null,
        createdAt: '2026-07-15T10:01:00.000Z',
      }],
    }));

    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    expect(plan.currentDebtUsd).toBe('0.000000000000');
    expect(plan.legacySettledDebtUsd).toBe('0.000000000000');
    expect(plan.activeGrantDriftUsd).toBe('0.000000000000');
    expect(plan.grantMutations).toEqual([expect.objectContaining({
      grantId: 'grant',
      remainingAmountUsd: '2.000000000000',
      remainingPaidAmountUsd: '2.000000000000',
      remainingBonusAmountUsd: '0.000000000000',
    })]);
  });

  it('accepts the proven legacy Node timestamp shape where validFrom follows database creation', () => {
    const createdAt = '2026-07-15T10:00:00.000Z';
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      walletBalanceUsd: '2',
      transactions: [
        {
          id: 'legacy-recharge', type: 'RECHARGE', amountUsd: '5', balanceAfterUsd: '5',
          description: 'recharge', orderId: 'legacy-order', createdAt,
        },
        {
          id: 'legacy-consume', type: 'CONSUME', amountUsd: '-3', balanceAfterUsd: '2',
          description: 'usage', orderId: null, createdAt: '2026-07-15T10:01:00.000Z',
        },
      ],
      grants: [{
        id: 'legacy-grant', orderId: 'legacy-order', source: 'RECHARGE',
        paidAmountUsd: '5', bonusAmountUsd: '0', grantedAmountUsd: '5',
        remainingAmountUsd: '2', remainingPaidAmountUsd: null,
        remainingBonusAmountUsd: null, discountRate: '1', isExpired: false,
        validFrom: '2026-07-15T10:00:00.001Z', expiresAt: null, createdAt,
      }],
      allocations: [{
        id: 'legacy-grant-use', balanceTransactionId: 'legacy-consume',
        balanceGrantId: 'legacy-grant', source: 'BALANCE_GRANT', amountUsd: '3',
        recognizedRevenueUsd: '3', bonusConsumedUsd: '0', settledUsd: '0',
        settledAt: null, createdAt: '2026-07-15T10:01:00.000Z',
      }],
    }));

    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    expect(plan.transactionSequenceMutations).toEqual([
      { transactionId: 'legacy-recharge', expectedLedgerSequence: null, ledgerSequence: '-2' },
      { transactionId: 'legacy-consume', expectedLedgerSequence: null, ledgerSequence: '-1' },
    ]);
  });

  it('replays a provable mixed paid and bonus grant from exact allocation components', () => {
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      walletBalanceUsd: '6',
      transactions: [
        {
          id: 'recharge', type: 'RECHARGE', amountUsd: '10', balanceAfterUsd: '10',
          description: 'recharge', orderId: 'order-mixed', createdAt: '2026-07-15T10:00:00.000Z',
        },
        {
          id: 'bonus', type: 'ADJUST', amountUsd: '2', balanceAfterUsd: '12',
          description: 'recharge-bonus tier:tier-1', orderId: 'order-mixed',
          createdAt: '2026-07-15T10:01:00.000Z',
        },
        {
          id: 'consume', type: 'CONSUME', amountUsd: '-6', balanceAfterUsd: '6',
          description: 'usage', orderId: null, createdAt: '2026-07-15T10:02:00.000Z',
        },
      ],
      grants: [{
        id: 'grant-mixed', orderId: 'order-mixed', source: 'RECHARGE', paidAmountUsd: '10',
        bonusAmountUsd: '2', grantedAmountUsd: '12', remainingAmountUsd: '6',
        remainingPaidAmountUsd: null, remainingBonusAmountUsd: null,
        discountRate: '0.833333333333', isExpired: false,
        createdAt: '2026-07-15T10:00:00.000Z',
      }],
      allocations: [{
        id: 'grant-use', balanceTransactionId: 'consume', balanceGrantId: 'grant-mixed',
        source: 'BALANCE_GRANT', amountUsd: '6', recognizedRevenueUsd: '5',
        bonusConsumedUsd: '1', settledUsd: '0', settledAt: null,
        createdAt: '2026-07-15T10:02:00.000Z',
      }],
    }));

    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    expect(plan.grantMutations).toEqual([expect.objectContaining({
      grantId: 'grant-mixed',
      remainingAmountUsd: '6.000000000000',
      remainingPaidAmountUsd: '5.000000000002',
      remainingBonusAmountUsd: '0.999999999998',
    })]);
    expect(plan.canonicalAllocationMutations).toEqual([
      expect.objectContaining({
        allocationId: 'grant-use',
        recognizedRevenueUsd: '4.999999999998',
        bonusConsumedUsd: '1.000000000002',
      }),
    ]);
  });

  it('converts an online suspense allocation when exact funding and grant replay proves its components', () => {
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      walletBalanceUsd: '6',
      transactions: [
        {
          id: 'recharge', type: 'RECHARGE', amountUsd: '10', balanceAfterUsd: '10',
          description: 'recharge', orderId: 'order-suspense', createdAt: '2026-07-15T10:00:00.000Z',
        },
        {
          id: 'bonus', type: 'ADJUST', amountUsd: '2', balanceAfterUsd: '12',
          description: 'recharge-bonus tier:tier-1', orderId: 'order-suspense',
          createdAt: '2026-07-15T10:01:00.000Z',
        },
        {
          id: 'consume', type: 'CONSUME', amountUsd: '-6', balanceAfterUsd: '6',
          description: 'usage', orderId: null, createdAt: '2026-07-15T10:02:00.000Z',
        },
      ],
      grants: [{
        id: 'grant-suspense', orderId: 'order-suspense', source: 'RECHARGE',
        paidAmountUsd: '10', bonusAmountUsd: '2', grantedAmountUsd: '12', remainingAmountUsd: '6',
        remainingPaidAmountUsd: null, remainingBonusAmountUsd: null,
        discountRate: '0.833333333333', isExpired: false,
        createdAt: '2026-07-15T10:00:00.000Z',
      }],
      allocations: [{
        id: 'suspense-use', balanceTransactionId: 'consume', balanceGrantId: 'grant-suspense',
        source: 'UNRECONCILED_GRANT', amountUsd: '6', recognizedRevenueUsd: '0',
        bonusConsumedUsd: '0', discountRate: '0', settledUsd: '0', settledAt: null,
        ledgerSequence: '101', createdAt: '2026-07-15T10:02:00.000Z',
      }],
    }));

    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    expect(plan.unreconciledGrantMutations).toEqual([{
      allocationId: 'suspense-use',
      expectedSource: 'UNRECONCILED_GRANT',
      expectedBalanceGrantId: 'grant-suspense',
      expectedAmountUsd: '6.000000000000',
      expectedRecognizedRevenueUsd: '0.000000000000',
      expectedBonusConsumedUsd: '0.000000000000',
      expectedDiscountRate: '0.000000000000',
      expectedSettledUsd: '0.000000000000',
      expectedSettledAt: null,
      expectedLedgerSequence: '101',
      source: 'BALANCE_GRANT',
      balanceGrantId: 'grant-suspense',
      recognizedRevenueUsd: '4.999999999998',
      bonusConsumedUsd: '1.000000000002',
      discountRate: '0.833333333333',
    }]);
    expect(plan.grantMutations).toEqual([expect.objectContaining({
      grantId: 'grant-suspense',
      remainingAmountUsd: '6.000000000000',
      remainingPaidAmountUsd: '5.000000000002',
      remainingBonusAmountUsd: '0.999999999998',
    })]);
    const tampered = {
      ...plan,
      unreconciledGrantMutations: plan.unreconciledGrantMutations.map((mutation) => ({
        ...mutation,
        recognizedRevenueUsd: '6.000000000000',
        bonusConsumedUsd: '0.000000000000',
      })),
    };
    expect(balanceLedgerRepairReplayHash(tampered)).not.toBe(plan.replayHash);
  });

  it('quarantines a suspense allocation linked to a later grant instead of blessing non-FIFO history', () => {
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      walletBalanceUsd: '1',
      transactions: [
        {
          id: 'recharge-first', type: 'RECHARGE', amountUsd: '1', balanceAfterUsd: '1',
          description: 'recharge', orderId: 'order-first', createdAt: '2026-07-15T10:00:00.000Z',
        },
        {
          id: 'recharge-later', type: 'RECHARGE', amountUsd: '1', balanceAfterUsd: '2',
          description: 'recharge', orderId: 'order-later', createdAt: '2026-07-15T10:01:00.000Z',
        },
        {
          id: 'consume', type: 'CONSUME', amountUsd: '-1', balanceAfterUsd: '1',
          description: 'usage', orderId: null, createdAt: '2026-07-15T10:02:00.000Z',
        },
      ],
      grants: [
        {
          id: 'grant-first', orderId: 'order-first', source: 'RECHARGE', paidAmountUsd: '1',
          bonusAmountUsd: '0', grantedAmountUsd: '1', remainingAmountUsd: '1',
          remainingPaidAmountUsd: '1', remainingBonusAmountUsd: '0', discountRate: '1',
          isExpired: false, createdAt: '2026-07-15T10:00:00.000Z',
        },
        {
          id: 'grant-later', orderId: 'order-later', source: 'RECHARGE', paidAmountUsd: '1',
          bonusAmountUsd: '0', grantedAmountUsd: '1', remainingAmountUsd: '0',
          remainingPaidAmountUsd: '0', remainingBonusAmountUsd: '0', discountRate: '1',
          isExpired: false, createdAt: '2026-07-15T10:01:00.000Z',
        },
      ],
      allocations: [{
        id: 'suspense-later', balanceTransactionId: 'consume', balanceGrantId: 'grant-later',
        source: 'UNRECONCILED_GRANT', amountUsd: '1', recognizedRevenueUsd: '0',
        bonusConsumedUsd: '0', discountRate: '0', settledUsd: '0', settledAt: null,
        ledgerSequence: '201', createdAt: '2026-07-15T10:02:00.000Z',
      }],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        'UNRECONCILED_GRANT_FIFO_MISMATCH:consume:grant-first',
      ]),
    }));
  });

  it('quarantines grant allocations whose request metadata differs from the consume transaction', () => {
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      walletBalanceUsd: '0',
      transactions: [
        {
          id: 'recharge', type: 'RECHARGE', amountUsd: '2', balanceAfterUsd: '2',
          description: 'recharge', orderId: 'order', createdAt: '2026-07-15T10:00:00.000Z',
        },
        {
          id: 'consume', type: 'CONSUME', amountUsd: '-2', balanceAfterUsd: '0',
          description: 'usage', orderId: null, createdAt: '2026-07-15T10:01:00.000Z',
        },
      ],
      grants: [{
        id: 'grant', orderId: 'order', source: 'RECHARGE', paidAmountUsd: '2',
        bonusAmountUsd: '0', grantedAmountUsd: '2', remainingAmountUsd: '0',
        remainingPaidAmountUsd: '0', remainingBonusAmountUsd: '0', discountRate: '1',
        isExpired: false, createdAt: '2026-07-15T10:00:00.000Z',
      }],
      allocations: [
        {
          id: 'grant-use-a', balanceTransactionId: 'consume', balanceGrantId: 'grant',
          source: 'BALANCE_GRANT', amountUsd: '1', recognizedRevenueUsd: '1',
          bonusConsumedUsd: '0', settledUsd: '0', settledAt: null,
          tokenUsageId: 'usage-a', createdAt: '2026-07-15T10:01:00.000Z',
        },
        {
          id: 'grant-use-b', balanceTransactionId: 'consume', balanceGrantId: 'grant',
          source: 'BALANCE_GRANT', amountUsd: '1', recognizedRevenueUsd: '1',
          bonusConsumedUsd: '0', settledUsd: '0', settledAt: null,
          tokenUsageId: 'usage-b', createdAt: '2026-07-15T10:01:00.000Z',
        },
      ],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        'ALLOCATION_TRANSACTION_SUBJECT_MISMATCH:grant-use-a:consume',
        'ALLOCATION_TRANSACTION_SUBJECT_MISMATCH:grant-use-b:consume',
      ]),
    }));
  });

  it('keeps unlinked suspense allocations quarantined instead of inventing a grant classification', () => {
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      walletBalanceUsd: '0',
      transactions: [
        {
          id: 'recharge', type: 'RECHARGE', amountUsd: '1', balanceAfterUsd: '1',
          description: 'recharge', orderId: 'order-unlinked', createdAt: '2026-07-15T10:00:00.000Z',
        },
        {
          id: 'consume', type: 'CONSUME', amountUsd: '-1', balanceAfterUsd: '0',
          description: 'usage', orderId: null, createdAt: '2026-07-15T10:01:00.000Z',
        },
      ],
      grants: [{
        id: 'grant-unlinked', orderId: 'order-unlinked', source: 'RECHARGE', paidAmountUsd: '1',
        bonusAmountUsd: '0', grantedAmountUsd: '1', remainingAmountUsd: '0',
        remainingPaidAmountUsd: null, remainingBonusAmountUsd: null,
        discountRate: '1', isExpired: false, createdAt: '2026-07-15T10:00:00.000Z',
      }],
      allocations: [{
        id: 'suspense-unlinked', balanceTransactionId: 'consume', balanceGrantId: null,
        source: 'UNRECONCILED_GRANT', amountUsd: '1', recognizedRevenueUsd: '0',
        bonusConsumedUsd: '0', discountRate: '0', settledUsd: '0', settledAt: null,
        ledgerSequence: '102', createdAt: '2026-07-15T10:01:00.000Z',
      }],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining(['UNRECONCILED_GRANT_MISSING_GRANT:suspense-unlinked']),
    }));
  });

  it('quarantines a grant whose gross components do not equal granted amount', () => {
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      walletBalanceUsd: '1',
      transactions: [{
        id: 'recharge', type: 'RECHARGE', amountUsd: '1', balanceAfterUsd: '1',
        description: 'recharge', orderId: 'order-invalid-gross',
        createdAt: '2026-07-15T10:00:00.000Z',
      }],
      grants: [{
        id: 'grant-invalid-gross', orderId: 'order-invalid-gross', source: 'RECHARGE',
        paidAmountUsd: '1', bonusAmountUsd: '0', grantedAmountUsd: '2',
        remainingAmountUsd: '1', remainingPaidAmountUsd: null, remainingBonusAmountUsd: null,
        discountRate: '1', isExpired: false, createdAt: '2026-07-15T10:00:00.000Z',
      }],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining(['GRANT_GROSS_COMPONENTS_INVALID:grant-invalid-gross']),
    }));
  });

  it('quarantines a positive grant that is not yet effective at repair time', () => {
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      walletBalanceUsd: '1',
      transactions: [{
        id: 'recharge', type: 'RECHARGE', amountUsd: '1', balanceAfterUsd: '1',
        description: 'recharge', orderId: 'order-future',
        createdAt: '2026-07-15T10:00:00.000Z',
      }],
      grants: [{
        id: 'grant-future', orderId: 'order-future', source: 'RECHARGE', paidAmountUsd: '1',
        bonusAmountUsd: '0', grantedAmountUsd: '1', remainingAmountUsd: '1',
        remainingPaidAmountUsd: '1', remainingBonusAmountUsd: '0', discountRate: '1',
        isExpired: false, validFrom: '2099-01-01T00:00:00.000Z', expiresAt: null,
        createdAt: '2026-07-15T10:00:00.000Z',
      }],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining(['GRANT_VALID_FROM_FUTURE_OR_INVALID:grant-future']),
    }));
  });

  it('quarantines a positive grant that is already due at the locked repair time', () => {
    const createdAt = '2026-07-15T10:00:00.000Z';
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      walletBalanceUsd: '1',
      transactions: [{
        id: 'recharge-due', type: 'RECHARGE', amountUsd: '1', balanceAfterUsd: '1',
        description: 'recharge', orderId: 'order-due', createdAt,
      }],
      grants: [{
        id: 'grant-due', orderId: 'order-due', source: 'RECHARGE', paidAmountUsd: '1',
        bonusAmountUsd: '0', grantedAmountUsd: '1', remainingAmountUsd: '1',
        remainingPaidAmountUsd: '1', remainingBonusAmountUsd: '0', discountRate: '1',
        isExpired: false, validFrom: createdAt, expiresAt: '2026-07-15T23:00:00.000Z',
        createdAt,
      }],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        'DUE_GRANT_REQUIRES_EXPIRY_BEFORE_REPAIR:grant-due',
      ]),
    }));
  });

  it.each([
    ['a-wrong', 'z-correct'],
    ['z-wrong', 'a-correct'],
  ])(
    'never uses allocation id order to settle multiple legacy debt rows (%s/%s)',
    (wrongId, correctId) => {
      const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
        walletBalanceUsd: '-1',
        transactions: [
          {
            id: 'consume-two-debts', type: 'CONSUME', amountUsd: '-2', balanceAfterUsd: '-2',
            description: 'usage', orderId: null, tokenUsageId: 'usage-1',
            createdAt: '2026-07-15T10:00:00.000Z',
          },
          {
            id: 'recharge-after-two-debts', type: 'RECHARGE', amountUsd: '1',
            balanceAfterUsd: '-1', description: 'recharge', orderId: 'order-after-debt',
            createdAt: '2026-07-15T10:01:00.000Z',
          },
        ],
        grants: [{
          id: 'grant-after-debt', orderId: 'order-after-debt', source: 'RECHARGE',
          paidAmountUsd: '1', bonusAmountUsd: '0', grantedAmountUsd: '1',
          remainingAmountUsd: '1', remainingPaidAmountUsd: null,
          remainingBonusAmountUsd: null, discountRate: '1', isExpired: false,
          createdAt: '2026-07-15T10:01:00.000Z',
        }],
        allocations: [
          {
            id: wrongId, userId: 'wrong-user', tenantId: 'wrong-tenant',
            productId: 'wrong-product', tokenUsageId: 'wrong-usage',
            balanceTransactionId: 'consume-two-debts', balanceGrantId: null,
            source: 'NEGATIVE_BALANCE', amountUsd: '1', recognizedRevenueUsd: '0',
            bonusConsumedUsd: '0', settledUsd: '0', settledAt: null,
            createdAt: '2026-07-15T10:00:00.000Z',
          },
          {
            id: correctId, tokenUsageId: 'usage-1',
            balanceTransactionId: 'consume-two-debts', balanceGrantId: null,
            source: 'NEGATIVE_BALANCE', amountUsd: '1', recognizedRevenueUsd: '0',
            bonusConsumedUsd: '0', settledUsd: '0', settledAt: null,
            createdAt: '2026-07-15T10:00:00.000Z',
          },
        ],
      }));

      expect(plan).toEqual(expect.objectContaining({
        status: 'QUARANTINED',
        reasons: expect.arrayContaining([
          `ALLOCATION_TRANSACTION_SUBJECT_MISMATCH:${wrongId}:consume-two-debts`,
          'DEBT_ALLOCATION_CARDINALITY_AMBIGUOUS:consume-two-debts:2',
        ]),
      }));
    },
  );

  it('quarantines unsupported personal debt sources and an impossible consume split', () => {
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      walletBalanceUsd: '-1',
      transactions: [
        {
          id: 'recharge', type: 'RECHARGE', amountUsd: '1', balanceAfterUsd: '1',
          description: 'recharge', orderId: 'order', createdAt: '2026-07-15T10:00:00.000Z',
        },
        {
          id: 'consume', type: 'CONSUME', amountUsd: '-2', balanceAfterUsd: '-1',
          description: 'usage', orderId: null, createdAt: '2026-07-15T10:01:00.000Z',
        },
      ],
      grants: [{
        id: 'grant', orderId: 'order', source: 'RECHARGE', paidAmountUsd: '1',
        bonusAmountUsd: '0', grantedAmountUsd: '1', remainingAmountUsd: '0',
        remainingPaidAmountUsd: null, remainingBonusAmountUsd: null,
        discountRate: '1', isExpired: false, createdAt: '2026-07-15T10:00:00.000Z',
      }],
      allocations: [{
        id: 'wrong-source', balanceTransactionId: 'consume', balanceGrantId: null,
        source: 'ENTERPRISE_CREDIT', amountUsd: '2', recognizedRevenueUsd: '0',
        bonusConsumedUsd: '0', settledUsd: '0', settledAt: null,
        createdAt: '2026-07-15T10:01:00.000Z',
      }],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        'ALLOCATION_SOURCE_UNSUPPORTED:wrong-source:ENTERPRISE_CREDIT',
        expect.stringContaining('CONSUMPTION_SPLIT_MISMATCH:consume'),
      ]),
    }));
  });

  it('quarantines an unclassified positive adjustment', () => {
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      walletBalanceUsd: '-1',
      transactions: [
        {
          id: 'consume', type: 'CONSUME', amountUsd: '-2', balanceAfterUsd: '-2',
          description: 'usage', orderId: null, createdAt: '2026-07-15T10:00:00.000Z',
        },
        {
          id: 'manual', type: 'ADJUST', amountUsd: '1', balanceAfterUsd: '-1',
          description: 'manual correction', orderId: null, createdAt: '2026-07-15T10:01:00.000Z',
        },
      ],
      allocations: [{
        id: 'negative', balanceTransactionId: 'consume', balanceGrantId: null,
        source: 'NEGATIVE_BALANCE', amountUsd: '2', recognizedRevenueUsd: '0',
        bonusConsumedUsd: '0', settledUsd: '0', settledAt: null,
        createdAt: '2026-07-15T10:00:00.000Z',
      }],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([expect.stringContaining('AMBIGUOUS_POSITIVE_FUNDING:manual')]),
    }));
  });

  it('reclassifies an exact pre-V2 migration opening placeholder as personal debt', () => {
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      walletBalanceUsd: '-1',
      transactions: [{
        id: 'consume', type: 'CONSUME', amountUsd: '-1', balanceAfterUsd: '-1',
        description: 'usage', orderId: null, createdAt: '2026-07-15T10:00:00.000Z',
      }],
      grants: [{
        id: 'migration', orderId: null, source: 'MIGRATION_OPENING', paidAmountUsd: '1',
        bonusAmountUsd: '0', grantedAmountUsd: '1', remainingAmountUsd: '0', remainingPaidAmountUsd: null,
        remainingBonusAmountUsd: null, discountRate: '1', isExpired: false,
        createdAt: '2026-07-15T10:00:00.000Z',
      }],
      allocations: [{
        id: 'legacy', balanceTransactionId: 'consume', balanceGrantId: 'migration',
        source: 'BALANCE_GRANT', amountUsd: '1', recognizedRevenueUsd: '1',
        bonusConsumedUsd: '0', settledUsd: '0', settledAt: null,
        createdAt: '2026-07-15T10:00:00.000Z',
      }],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'READY',
      currentDebtUsd: '1.000000000000',
      migrationOpeningDebtMutations: [expect.objectContaining({
        allocationId: 'legacy',
        grantId: 'migration',
        expectedSource: 'BALANCE_GRANT',
        expectedBalanceGrantId: 'migration',
        source: 'NEGATIVE_BALANCE',
        balanceGrantId: null,
        recognizedRevenueUsd: '0.000000000000',
        settledUsd: '0.000000000000',
        ledgerSequence: '-1',
      })],
    }));
  });

  it('keeps a non-canonical migration opening shape quarantined', () => {
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      walletBalanceUsd: '-1',
      transactions: [{
        id: 'consume', type: 'CONSUME', amountUsd: '-1', balanceAfterUsd: '-1',
        description: 'usage', orderId: null, createdAt: '2026-07-15T10:00:00.000Z',
      }],
      grants: [{
        id: 'migration', orderId: null, source: 'MIGRATION_OPENING', paidAmountUsd: '1',
        bonusAmountUsd: '0', grantedAmountUsd: '1', remainingAmountUsd: '0', remainingPaidAmountUsd: null,
        remainingBonusAmountUsd: null, discountRate: '1', isExpired: false,
        createdAt: '2026-07-15T10:00:00.000Z',
      }],
      allocations: [{
        id: 'legacy', balanceTransactionId: 'consume', balanceGrantId: 'migration',
        source: 'BALANCE_GRANT', amountUsd: '1', recognizedRevenueUsd: '0.5',
        bonusConsumedUsd: '0.5', settledUsd: '0', settledAt: null,
        createdAt: '2026-07-15T10:00:00.000Z',
      }],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining(['MIGRATION_OPENING_WRITER_SHAPE_MISMATCH:migration']),
    }));
  });

  it('settles retired migration-opening debt from the later real recharge', () => {
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      walletBalanceUsd: '0.585148',
      transactions: [
        {
          id: 'initial-funding', type: 'RECHARGE', amountUsd: '0.463644',
          balanceAfterUsd: '0.463644', description: 'admin recharge', orderId: null,
          operationKey: 'balance:admin-recharge:grant:initial-grant',
          createdAt: '2026-07-09T05:00:00.000Z',
        },
        {
          id: 'over-consume', type: 'CONSUME', amountUsd: '-0.678496',
          balanceAfterUsd: '-0.214852', description: 'usage', orderId: null,
          createdAt: '2026-07-09T05:40:51.576Z',
        },
        {
          id: 'later-funding', type: 'RECHARGE', amountUsd: '1',
          balanceAfterUsd: '0.785148', description: 'admin recharge', orderId: null,
          operationKey: 'balance:admin-recharge:grant:later-grant',
          createdAt: '2026-07-09T06:22:48.807Z',
        },
        {
          id: 'later-consume', type: 'CONSUME', amountUsd: '-0.2',
          balanceAfterUsd: '0.585148', description: 'usage', orderId: null,
          createdAt: '2026-07-09T07:00:00.000Z',
        },
      ],
      grants: [
        {
          id: 'initial-grant', orderId: null, source: 'RECHARGE', paidAmountUsd: '0.463644',
          bonusAmountUsd: '0', grantedAmountUsd: '0.463644', remainingAmountUsd: '0',
          remainingPaidAmountUsd: null, remainingBonusAmountUsd: null, discountRate: '1',
          isExpired: false, createdAt: '2026-07-09T05:00:00.000Z',
        },
        {
          id: 'migration', orderId: null, source: 'MIGRATION_OPENING', paidAmountUsd: '0.214852',
          bonusAmountUsd: '0', grantedAmountUsd: '0.214852', remainingAmountUsd: '0',
          remainingPaidAmountUsd: null, remainingBonusAmountUsd: null, discountRate: '1',
          isExpired: false, validFrom: '2026-07-09T05:40:51.584Z',
          createdAt: '2026-07-09T05:40:51.585Z',
        },
        {
          id: 'later-grant', orderId: null, source: 'RECHARGE', paidAmountUsd: '1',
          bonusAmountUsd: '0', grantedAmountUsd: '1', remainingAmountUsd: '0.8',
          remainingPaidAmountUsd: null, remainingBonusAmountUsd: null, discountRate: '1',
          isExpired: false, createdAt: '2026-07-09T06:22:48.807Z',
        },
      ],
      allocations: [
        {
          id: 'initial-allocation', balanceTransactionId: 'over-consume',
          balanceGrantId: 'initial-grant', source: 'BALANCE_GRANT', amountUsd: '0.463644',
          recognizedRevenueUsd: '0.463644', bonusConsumedUsd: '0', settledUsd: '0',
          settledAt: null, createdAt: '2026-07-09T05:40:51.583Z',
        },
        {
          id: 'migration-allocation', balanceTransactionId: 'over-consume',
          balanceGrantId: 'migration', source: 'BALANCE_GRANT', amountUsd: '0.214852',
          recognizedRevenueUsd: '0.214852', bonusConsumedUsd: '0', settledUsd: '0',
          settledAt: null, createdAt: '2026-07-09T05:40:51.587Z',
        },
        {
          id: 'later-allocation', balanceTransactionId: 'later-consume',
          balanceGrantId: 'later-grant', source: 'BALANCE_GRANT', amountUsd: '0.2',
          recognizedRevenueUsd: '0.2', bonusConsumedUsd: '0', settledUsd: '0',
          settledAt: null, createdAt: '2026-07-09T07:00:00.001Z',
        },
      ],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'READY',
      currentDebtUsd: '0.000000000000',
      legacySettledDebtUsd: '0.214852000000',
      expectedSettlementCount: 1,
      migrationOpeningDebtMutations: [expect.objectContaining({
        allocationId: 'migration-allocation',
        grantId: 'migration',
        recognizedRevenueUsd: '0.214852000000',
        settledUsd: '0.214852000000',
        settledAt: '2026-07-09T06:22:48.807Z',
      })],
      settlementMutations: [expect.objectContaining({
        allocationId: 'migration-allocation',
        repaymentTransactionId: 'later-funding',
        balanceGrantId: 'later-grant',
        amountUsd: '0.214852000000',
        paidUsd: '0.214852000000',
      })],
      grantMutations: expect.arrayContaining([expect.objectContaining({
        grantId: 'later-grant',
        remainingAmountUsd: '0.585148000000',
      })]),
    }));
  });

  it('proves the pre-idempotency voucher and fully reclassifies the anonymous -0.59157808 shape', () => {
    const snapshot = baseSnapshot({
      walletBalanceUsd: '-0.591578080',
      transactions: [
        {
          id: 'a-voucher', type: 'ADJUST', amountUsd: '100', balanceAfterUsd: '100',
          description: 'voucher:a-grant admin:operator-a historical voucher', orderId: null,
          operationKey: null, createdAt: '2026-07-15T10:00:00.004Z',
        },
        {
          id: 'a-consume-funded', type: 'CONSUME', amountUsd: '-100', balanceAfterUsd: '0',
          description: 'usage', orderId: null, operationKey: null,
          tokenUsageId: 'a-usage-funded', createdAt: '2026-07-15T10:01:00.000Z',
        },
        {
          id: 'a-consume-debt', type: 'CONSUME', amountUsd: '-0.591578080',
          balanceAfterUsd: '-0.591578080', description: 'usage', orderId: null,
          operationKey: null, tokenUsageId: 'a-usage-debt',
          createdAt: '2026-07-15T10:02:00.000Z',
        },
      ],
      grants: [{
        id: 'a-grant', orderId: null, source: 'VOUCHER', paidAmountUsd: '0',
        bonusAmountUsd: '100', grantedAmountUsd: '100', remainingAmountUsd: '0',
        remainingPaidAmountUsd: null, remainingBonusAmountUsd: null,
        discountRate: '0', isExpired: false,
        validFrom: '2026-07-15T10:00:00.000Z',
        createdAt: '2026-07-15T10:00:00.001Z',
        expiresAt: '2026-08-14T16:00:00.000Z',
      }],
      allocations: [
        {
          id: 'a-funded-allocation', balanceTransactionId: 'a-consume-funded',
          tokenUsageId: 'a-usage-funded', balanceGrantId: 'a-grant',
          source: 'BALANCE_GRANT', amountUsd: '100', recognizedRevenueUsd: '0',
          bonusConsumedUsd: '100', settledUsd: '0', settledAt: null,
          createdAt: '2026-07-15T10:01:00.001Z',
        },
        {
          id: 'a-debt-allocation', balanceTransactionId: 'a-consume-debt',
          tokenUsageId: 'a-usage-debt', balanceGrantId: 'a-grant',
          source: 'BALANCE_GRANT', amountUsd: '0.591578080', recognizedRevenueUsd: '0',
          bonusConsumedUsd: '0.591578080', settledUsd: '0', settledAt: null,
          createdAt: '2026-07-15T10:02:00.001Z',
        },
      ],
      voucherIdempotencyEvidence: [],
    });

    const plan = buildBalanceLedgerRepairPlan(snapshot);

    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    expect(plan.currentDebtUsd).toBe('0.591578080000');
    expect(plan.legacyVoucherProofMutations).toEqual([expect.objectContaining({
      proofVersion: 1,
      repairKind: 'LEGACY_PRE_IDEMPOTENCY_VOUCHER_V1',
      transactionId: 'a-voucher',
      grantId: 'a-grant',
      walletBeforeUsd: '0.000000000000',
      holeFillUsd: '0.000000000000',
      mintedGrantAmountUsd: '100.000000000000',
      expectedIdempotencyEvidence: [],
      openingDebtAllocationIds: [],
    })]);
    expect(plan.personalDebtAllocationMutations).toEqual([expect.objectContaining({
      proofVersion: 1,
      repairKind: 'LEGACY_DEBT_RECLASS_V1',
      transactionId: 'a-consume-debt',
      sourceAllocationId: 'a-debt-allocation',
      createdDebtAllocationId: null,
      expectedTransactionBeforeUsd: '0.000000000000',
      expectedTransactionAfterUsd: '-0.591578080000',
      targetSourceAllocation: expect.objectContaining({
        id: 'a-debt-allocation', source: 'NEGATIVE_BALANCE', balanceGrantId: null,
        amountUsd: '0.591578080000', recognizedRevenueUsd: '0.000000000000',
        bonusConsumedUsd: '0.000000000000', ledgerSequence: '-1',
      }),
      targetDebtAllocation: null,
    })]);
    expect(plan.canonicalAllocationMutations).toEqual([]);
  });

  it('authorizes an expired positive-wallet voucher only with its paired legacy expiry proof', () => {
    const snapshot = legacyExpiredVoucherSnapshot();

    const genericPlan = buildBalanceLedgerRepairPlan(snapshot);
    expect(genericPlan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        'LEGACY_EXPIRY_REQUIRES_MANUAL_REPLAY:expired-voucher-grant',
      ]),
    }));

    const expiryOnlyPlan = buildBalanceLedgerRepairPlanAt(snapshot, REPAIR_OBSERVED_AT, {
      allowLegacyExpiryProofs: true,
      allowLegacyExpiredVoucherProofs: false,
      allowInvoiceStabilityProof: false,
    });
    expect(expiryOnlyPlan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        expect.stringContaining(
          'FUNDING_VOUCHER_GRANT_MISMATCH:expired-voucher-tx:expired-voucher-grant:',
        ),
      ]),
    }));

    const maintenancePlan = buildBalanceLedgerRepairPlanAt(
      snapshot,
      REPAIR_OBSERVED_AT,
      legacyExpiredVoucherPlanningProfile(),
    );
    expect(maintenancePlan).toEqual(expect.objectContaining({
      status: 'READY',
      legacyVoucherProofMutations: [expect.objectContaining({
        proofVersion: 1,
        repairKind: 'LEGACY_PRE_IDEMPOTENCY_EXPIRED_VOUCHER_V1',
        transactionId: 'expired-voucher-tx',
        grantId: 'expired-voucher-grant',
        walletBeforeUsd: '10.000000000000',
        walletAfterUsd: '11.000000000000',
        holeFillUsd: '0.000000000000',
        mintedGrantAmountUsd: '1.000000000000',
        expectedIdempotencyEvidence: [],
        openingDebtAllocationIds: [],
        expectedGrant: expect.objectContaining({ isExpired: true }),
      })],
      legacyExpiryProofMutations: [expect.objectContaining({
        proofVersion: 1,
        repairKind: 'LEGACY_INLINE_EXPIRY_V1',
        transactionId: 'expired-voucher-expiry',
        grantId: 'expired-voucher-grant',
        nominalAmountUsd: '0.200000000000',
        nominalPaidUsd: '0.000000000000',
        nominalBonusUsd: '0.200000000000',
        walletBalanceBeforeUsd: '10.200000000000',
        walletBalanceAfterUsd: '10.000000000000',
      })],
      canonicalAllocationMutations: [],
    }));
    if (maintenancePlan.status === 'READY') {
      expect(balanceLedgerRepairReplayHash(maintenancePlan)).toBe(maintenancePlan.replayHash);
    }
  });

  it('closes one partial and two fully unconsumed expired vouchers in the same account', () => {
    const snapshot = legacyExpiredVoucherSnapshot();
    const fundingTemplate = snapshot.transactions.find(
      (transaction) => transaction.id === 'expired-voucher-tx',
    )!;
    const expiryTemplate = snapshot.transactions.find(
      (transaction) => transaction.id === 'expired-voucher-expiry',
    )!;
    const grantTemplate = snapshot.grants.find(
      (grant) => grant.id === 'expired-voucher-grant',
    )!;

    snapshot.walletBalanceUsd = '15';
    snapshot.transactions.push(
      {
        ...fundingTemplate,
        id: 'expired-voucher-second-base-funding',
        type: 'RECHARGE',
        amountUsd: '5',
        balanceAfterUsd: '15',
        description: 'admin recharge',
        operationKey: 'balance:admin-recharge:grant:expired-voucher-second-base-grant',
        createdAt: '2026-07-15T10:08:30.000Z',
      },
      {
        ...fundingTemplate,
        id: 'expired-voucher-full-12-tx',
        amountUsd: '12',
        balanceAfterUsd: '27',
        description: 'voucher:expired-voucher-full-12-grant admin:operator voucher-12',
        createdAt: '2026-07-15T10:09:00.004Z',
      },
      {
        ...fundingTemplate,
        id: 'expired-voucher-full-1-tx',
        amountUsd: '1',
        balanceAfterUsd: '28',
        description: 'voucher:expired-voucher-full-1-grant admin:operator voucher-1',
        createdAt: '2026-07-15T10:10:00.004Z',
      },
      {
        ...expiryTemplate,
        id: 'expired-voucher-full-12-expiry',
        amountUsd: '-12',
        balanceAfterUsd: '16',
        description: 'balance grant expired:expired-voucher-full-12-grant',
        createdAt: '2026-07-15T10:16:00.000Z',
      },
      {
        ...expiryTemplate,
        id: 'expired-voucher-full-1-expiry',
        amountUsd: '-1',
        balanceAfterUsd: '15',
        description: 'balance grant expired:expired-voucher-full-1-grant',
        createdAt: '2026-07-15T10:16:00.001Z',
      },
    );
    snapshot.grants.push(
      {
        ...grantTemplate,
        id: 'expired-voucher-second-base-grant',
        source: 'RECHARGE',
        paidAmountUsd: '5',
        bonusAmountUsd: '0',
        grantedAmountUsd: '5',
        remainingAmountUsd: '5',
        remainingPaidAmountUsd: '5',
        remainingBonusAmountUsd: '0',
        discountRate: '1',
        isExpired: false,
        validFrom: '2026-07-15T10:08:30.000Z',
        createdAt: '2026-07-15T10:08:30.000Z',
        expiresAt: null,
      },
      {
        ...grantTemplate,
        id: 'expired-voucher-full-12-grant',
        bonusAmountUsd: '12',
        grantedAmountUsd: '12',
        validFrom: '2026-07-15T10:08:59.990Z',
        createdAt: '2026-07-15T10:09:00.000Z',
        expiresAt: '2026-07-15T10:11:00.000Z',
      },
      {
        ...grantTemplate,
        id: 'expired-voucher-full-1-grant',
        validFrom: '2026-07-15T10:09:59.990Z',
        createdAt: '2026-07-15T10:10:00.000Z',
        expiresAt: '2026-07-15T10:12:00.000Z',
      },
    );

    const plan = buildBalanceLedgerRepairPlanAt(
      snapshot,
      REPAIR_OBSERVED_AT,
      legacyExpiredVoucherPlanningProfile(),
    );

    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    expect(plan.legacyVoucherProofMutations).toHaveLength(3);
    expect(plan.legacyVoucherProofMutations.every((proof) => (
      proof.repairKind === 'LEGACY_PRE_IDEMPOTENCY_EXPIRED_VOUCHER_V1'
      && proof.holeFillUsd === '0.000000000000'
    ))).toBe(true);
    expect(new Map(plan.legacyVoucherProofMutations.map((proof) => [
      proof.grantId,
      proof.walletBeforeUsd,
    ]))).toEqual(new Map([
      ['expired-voucher-grant', '10.000000000000'],
      ['expired-voucher-full-12-grant', '15.000000000000'],
      ['expired-voucher-full-1-grant', '27.000000000000'],
    ]));
    expect(new Map(plan.legacyExpiryProofMutations.map((proof) => [
      proof.grantId,
      proof.nominalAmountUsd,
    ]))).toEqual(new Map([
      ['expired-voucher-grant', '0.200000000000'],
      ['expired-voucher-full-12-grant', '12.000000000000'],
      ['expired-voucher-full-1-grant', '1.000000000000'],
    ]));
  });

  it.each([
    ['missing expiry transaction', (snapshot: BalanceLedgerRepairSnapshot) => {
      snapshot.transactions = snapshot.transactions.filter(
        (transaction) => transaction.id !== 'expired-voucher-expiry',
      );
      snapshot.walletBalanceUsd = '10.2';
      return 'LEGACY_EXPIRY_TRANSACTION_MATCH_0:expired-voucher-grant';
    }],
    ['wrong-subject expiry transaction', (snapshot: BalanceLedgerRepairSnapshot) => {
      const expiry = snapshot.transactions.find(
        (transaction) => transaction.id === 'expired-voucher-expiry',
      )!;
      expiry.userId = 'wrong-user';
      return 'LEGACY_EXPIRY_FINGERPRINT_MISMATCH:'
        + 'expired-voucher-grant:expired-voucher-expiry';
    }],
    ['mixed null/zero grant components', (snapshot: BalanceLedgerRepairSnapshot) => {
      const grant = snapshot.grants.find(
        (candidate) => candidate.id === 'expired-voucher-grant',
      )!;
      grant.remainingBonusAmountUsd = '0';
      return 'LEGACY_EXPIRY_FINGERPRINT_MISMATCH:'
        + 'expired-voucher-grant:expired-voucher-expiry';
    }],
  ])('does not authorize an expired voucher with %s', (_label, mutate) => {
    const snapshot = legacyExpiredVoucherSnapshot();
    const expiryReason = mutate(snapshot);

    const plan = buildBalanceLedgerRepairPlanAt(
      snapshot,
      REPAIR_OBSERVED_AT,
      legacyExpiredVoucherPlanningProfile(),
    );

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        expiryReason,
      ]),
    }));
  });

  it('does not treat a wrong-user idempotency row referencing the voucher as absent evidence', () => {
    const snapshot = legacyExpiredVoucherSnapshot();
    snapshot.voucherIdempotencyEvidence = [{
      key: 'admin:payg-voucher:wrong-user:foreign-key',
      scope: 'admin:issue-voucher',
      userId: 'wrong-user',
      status: 'COMMITTED',
      createdAt: '2026-07-15T10:00:59.995Z',
      expiresAt: '2026-08-14T10:01:00.000Z',
      result: {
        transaction: { id: 'expired-voucher-tx' },
        grant: { id: 'expired-voucher-grant' },
      },
    }];

    const plan = buildBalanceLedgerRepairPlanAt(
      snapshot,
      REPAIR_OBSERVED_AT,
      legacyExpiredVoucherPlanningProfile(),
    );

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        expect.stringContaining(
          'FUNDING_VOUCHER_GRANT_MISMATCH:expired-voucher-tx:expired-voucher-grant:'
            + 'CREATED_AT_MISMATCH:IDEMPOTENCY_RECEIPT_SCHEMA_INVALID:'
            + 'PROOF_MODE_MISMATCH:before=10.000000000000:evidence=1',
        ),
      ]),
    }));
  });

  it('keeps an expired negative-wallet voucher without a receipt fail-closed', () => {
    const snapshot = legacyExpiredVoucherSnapshot();
    const voucher = snapshot.transactions.find(
      (transaction) => transaction.id === 'expired-voucher-tx',
    )!;
    const voucherConsume = snapshot.transactions.find(
      (transaction) => transaction.id === 'expired-voucher-consume',
    )!;
    const expiry = snapshot.transactions.find(
      (transaction) => transaction.id === 'expired-voucher-expiry',
    )!;
    const voucherAllocation = snapshot.allocations[0];
    snapshot.walletBalanceUsd = '0';
    snapshot.transactions = [
      {
        ...voucherConsume,
        id: 'expired-voucher-opening-debt',
        amountUsd: '-0.5',
        balanceAfterUsd: '-0.5',
        tokenUsageId: 'expired-voucher-opening-usage',
        createdAt: '2026-07-15T10:00:00.000Z',
      },
      { ...voucher, balanceAfterUsd: '0.5' },
      { ...voucherConsume, amountUsd: '-0.3', balanceAfterUsd: '0.2' },
      { ...expiry, balanceAfterUsd: '0' },
    ];
    snapshot.grants = snapshot.grants.filter(
      (grant) => grant.id === 'expired-voucher-grant',
    );
    snapshot.allocations = [
      {
        ...voucherAllocation,
        id: 'expired-voucher-opening-debt-allocation',
        balanceTransactionId: 'expired-voucher-opening-debt',
        tokenUsageId: 'expired-voucher-opening-usage',
        balanceGrantId: null,
        source: 'NEGATIVE_BALANCE',
        amountUsd: '0.5',
        recognizedRevenueUsd: '0',
        bonusConsumedUsd: '0',
        discountRate: '0',
        createdAt: '2026-07-15T10:00:00.001Z',
      },
      {
        ...voucherAllocation,
        amountUsd: '0.3',
        bonusConsumedUsd: '0.3',
      },
    ];

    const plan = buildBalanceLedgerRepairPlanAt(
      snapshot,
      REPAIR_OBSERVED_AT,
      legacyExpiredVoucherPlanningProfile(),
    );

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        expect.stringContaining(
          'FUNDING_VOUCHER_GRANT_MISMATCH:expired-voucher-tx:expired-voucher-grant:'
            + 'CREATED_AT_MISMATCH:IDEMPOTENCY_EVIDENCE_MATCH_0:'
            + 'PROOF_MODE_MISMATCH:before=-0.500000000000:evidence=0',
        ),
      ]),
    }));
  });

  it('splits the anonymous 0.2834368 consumption into 0.0627072 grant plus 0.2207296 debt', () => {
    const snapshot = baseSnapshot({
      walletBalanceUsd: '-0.220729600',
      transactions: [
        {
          id: 'c-funding', type: 'RECHARGE', amountUsd: '0.062707200',
          balanceAfterUsd: '0.062707200', description: 'admin recharge', orderId: null,
          operationKey: 'balance:admin-recharge:grant:c-grant',
          createdAt: '2026-07-15T11:00:00.000Z',
        },
        {
          id: 'c-consume', type: 'CONSUME', amountUsd: '-0.283436800',
          balanceAfterUsd: '-0.220729600', description: 'usage', orderId: null,
          operationKey: null, tokenUsageId: 'c-usage',
          createdAt: '2026-07-15T11:01:00.000Z',
        },
      ],
      grants: [{
        id: 'c-grant', orderId: null, source: 'RECHARGE', paidAmountUsd: '0.062707200',
        bonusAmountUsd: '0', grantedAmountUsd: '0.062707200', remainingAmountUsd: '0',
        remainingPaidAmountUsd: null, remainingBonusAmountUsd: null,
        discountRate: '1', isExpired: false,
        createdAt: '2026-07-15T11:00:00.000Z',
      }],
      allocations: [{
        id: 'c-source-allocation', balanceTransactionId: 'c-consume',
        tokenUsageId: 'c-usage', balanceGrantId: 'c-grant', source: 'BALANCE_GRANT',
        amountUsd: '0.283436800', recognizedRevenueUsd: '0.283436800',
        bonusConsumedUsd: '0', settledUsd: '0', settledAt: null,
        createdAt: '2026-07-15T11:01:00.001Z',
      }],
    });

    const plan = buildBalanceLedgerRepairPlan(snapshot);

    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    expect(plan.currentDebtUsd).toBe('0.220729600000');
    expect(plan.personalDebtAllocationMutations).toEqual([expect.objectContaining({
      proofVersion: 1,
      repairKind: 'LEGACY_DEBT_SPLIT_V1',
      transactionId: 'c-consume',
      sourceAllocationId: 'c-source-allocation',
      createdDebtAllocationId: 'repair-negative-balance-split:c-source-allocation',
      expectedTransactionBeforeUsd: '0.062707200000',
      expectedTransactionAfterUsd: '-0.220729600000',
      targetSourceAllocation: expect.objectContaining({
        id: 'c-source-allocation', source: 'BALANCE_GRANT',
        amountUsd: '0.062707200000', recognizedRevenueUsd: '0.062707200000',
        ledgerSequence: '-2',
      }),
      targetDebtAllocation: expect.objectContaining({
        id: 'repair-negative-balance-split:c-source-allocation',
        source: 'NEGATIVE_BALANCE', balanceGrantId: null,
        amountUsd: '0.220729600000', recognizedRevenueUsd: '0.000000000000',
        bonusConsumedUsd: '0.000000000000', ledgerSequence: '-1',
      }),
    })]);
    expect(plan.allocationSequenceMutations).toEqual([]);
  });

  it('does not renumber a closed negative allocation epoch to make room for a synthetic split', () => {
    const snapshot = baseSnapshot({
      walletBalanceUsd: '-0.220729600',
      transactions: [
        {
          id: 'c-funding', type: 'RECHARGE', amountUsd: '0.062707200',
          balanceAfterUsd: '0.062707200', description: 'admin recharge', orderId: null,
          operationKey: 'balance:admin-recharge:grant:c-grant',
          createdAt: '2026-07-15T11:00:00.000Z',
        },
        {
          id: 'c-consume', type: 'CONSUME', amountUsd: '-0.283436800',
          balanceAfterUsd: '-0.220729600', description: 'usage', orderId: null,
          operationKey: null, tokenUsageId: 'c-usage',
          createdAt: '2026-07-15T11:01:00.000Z',
        },
      ],
      grants: [{
        id: 'c-grant', orderId: null, source: 'RECHARGE', paidAmountUsd: '0.062707200',
        bonusAmountUsd: '0', grantedAmountUsd: '0.062707200', remainingAmountUsd: '0',
        remainingPaidAmountUsd: '0', remainingBonusAmountUsd: '0', discountRate: '1',
        isExpired: false, createdAt: '2026-07-15T11:00:00.000Z',
      }],
      allocations: [{
        id: 'c-source-allocation', balanceTransactionId: 'c-consume',
        tokenUsageId: 'c-usage', balanceGrantId: 'c-grant', source: 'BALANCE_GRANT',
        amountUsd: '0.283436800', recognizedRevenueUsd: '0.283436800',
        bonusConsumedUsd: '0', settledUsd: '0', settledAt: null,
        ledgerSequence: '-1', createdAt: '2026-07-15T11:01:00.001Z',
      }],
    });

    const plan = buildBalanceLedgerRepairPlan(snapshot);

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        'PERSONAL_DEBT_REPAIR_SEQUENCE_SLOT_UNAVAILABLE:c-consume:c-source-allocation:-1',
      ]),
    }));
  });

  it('closes the anonymous voucher absorption equations across five openings and three bad splits', () => {
    const plan = buildBalanceLedgerRepairPlan(productionVoucherAbsorptionEquationSnapshot());

    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    expect(plan.currentDebtUsd).toBe('0.043071216000');
    expect(plan.legacySettledDebtUsd).toBe('0.081552076000');
    expect(plan.expectedSettlementCount).toBe(5);
    expect(plan.migrationOpeningDebtMutations).toHaveLength(5);
    expect(plan.settlementMutations.reduce(
      (sum, mutation) => sum.plus(mutation.amountUsd),
      new Prisma.Decimal(0),
    ).toFixed(12)).toBe('0.081552076000');

    expect(plan.legacyVoucherProofMutations).toEqual([expect.objectContaining({
      proofVersion: 1,
      repairKind: 'LEGACY_VOUCHER_FULL_REMAINDER_DEBT_ABSORPTION_V1',
      transactionId: 'b-voucher-100', grantId: 'b-voucher-grant',
      walletBeforeUsd: '-0.081552076000', holeFillUsd: '0.081552076000',
      mintedGrantAmountUsd: '99.918447924000',
      expectedGrant: expect.objectContaining({ remainingAmountUsd: '0.038480860' }),
      expectedIdempotencyEvidence: [expect.objectContaining({ status: 'COMMITTED' })],
      openingDebtAllocationIds: [
        'b-opening-allocation-1', 'b-opening-allocation-2', 'b-opening-allocation-3',
        'b-opening-allocation-4', 'b-opening-allocation-5',
      ],
    })]);
    expect(plan.grantMutations).toEqual(expect.arrayContaining([expect.objectContaining({
      grantId: 'b-voucher-grant',
      expectedRemainingAmountUsd: '0.038480860000',
      remainingAmountUsd: '0.000000000000',
      remainingBonusAmountUsd: '0.000000000000',
    })]));
    expect(plan.personalDebtAllocationMutations).toHaveLength(3);
    const targets = plan.personalDebtAllocationMutations.flatMap((mutation) => (
      mutation.targetDebtAllocation === null
        ? [mutation.targetSourceAllocation]
        : [mutation.targetDebtAllocation]
    ));
    expect(targets.map((allocation) => allocation.amountUsd).sort()).toEqual([
      '0.008336700000', '0.017340300000', '0.017394216000',
    ]);
    expect(targets.reduce(
      (sum, allocation) => sum.plus(allocation.amountUsd),
      new Prisma.Decimal(0),
    ).toFixed(12)).toBe('0.043071216000');
    expect(plan.personalDebtAllocationMutations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        repairKind: 'LEGACY_DEBT_SPLIT_V1',
        sourceAllocationId: 'b-partial-allocation',
        createdDebtAllocationId: 'repair-negative-balance-split:b-partial-allocation',
        targetSourceAllocation: expect.objectContaining({ amountUsd: '0.011547084000' }),
        targetDebtAllocation: expect.objectContaining({ amountUsd: '0.017394216000' }),
      }),
      expect.objectContaining({
        repairKind: 'LEGACY_DEBT_RECLASS_V1', sourceAllocationId: 'b-full-allocation-1',
        targetSourceAllocation: expect.objectContaining({ amountUsd: '0.008336700000' }),
      }),
      expect.objectContaining({
        repairKind: 'LEGACY_DEBT_RECLASS_V1', sourceAllocationId: 'b-full-allocation-2',
        targetSourceAllocation: expect.objectContaining({ amountUsd: '0.017340300000' }),
      }),
    ]));

    const tampered = {
      ...plan,
      legacyVoucherProofMutations: plan.legacyVoucherProofMutations.map((mutation) => ({
        ...mutation,
        holeFillUsd: '0.081552075000',
      })),
    };
    expect(balanceLedgerRepairReplayHash(tampered)).not.toBe(plan.replayHash);
  });

  it('does not bless a full-remainder voucher receipt when the wallet hole is not proven by opening debt', () => {
    const snapshot = productionVoucherAbsorptionEquationSnapshot();
    snapshot.grants = snapshot.grants.filter((grant) => grant.source !== 'MIGRATION_OPENING');
    snapshot.allocations = snapshot.allocations.map((allocation) => (
      allocation.id.startsWith('b-opening-allocation-')
        ? {
            ...allocation,
            balanceGrantId: null,
            source: 'NEGATIVE_BALANCE',
            recognizedRevenueUsd: '0',
            bonusConsumedUsd: '0',
            discountRate: '0',
          }
        : allocation
    ));

    const plan = buildBalanceLedgerRepairPlan(snapshot);

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        'LEGACY_VOUCHER_OPENING_DEBT_ABSORPTION_MISMATCH:b-voucher-100:'
          + '0.081552076000:0.081552076000',
      ]),
    }));
  });

  it('quarantines any pre-existing settlement on a personal account', () => {
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      walletBalanceUsd: '0',
      settlements: [{
        id: 'stale-enterprise-settlement',
        allocationId: 'missing-allocation',
        repaymentTransactionId: null,
        balanceGrantId: null,
        debtSource: 'ENTERPRISE_CREDIT',
        repairRunId: null,
        operationKey: 'legacy:stale-enterprise-settlement',
        trigger: 'FUNDING',
        amountUsd: '1',
        paidUsd: '1',
        bonusUsd: '0',
        occurredAt: '2026-07-15T10:00:00.000Z',
        createdAt: '2026-07-15T10:00:00.000Z',
      }],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining(['EXISTING_PERSONAL_SETTLEMENTS:1']),
    }));
  });

  it('quarantines a foreign-account settlement that points at this account allocation', () => {
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      walletBalanceUsd: '0',
      settlements: [{
        id: 'foreign-settlement',
        billingAccountId: 'ba_personal_other',
        allocationId: 'local-allocation',
        repaymentTransactionId: null,
        balanceGrantId: null,
        debtSource: 'NEGATIVE_BALANCE',
        repairRunId: null,
        operationKey: 'legacy:foreign-settlement',
        trigger: 'FUNDING',
        amountUsd: '1',
        paidUsd: '1',
        bonusUsd: '0',
        occurredAt: '2026-07-15T10:00:00.000Z',
        createdAt: '2026-07-15T10:00:00.000Z',
      }],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        'SETTLEMENT_ACCOUNT_OWNERSHIP_MISMATCH:foreign-settlement:'
          + 'ba_personal_other:ba_personal_u1',
      ]),
    }));
  });

  it('quarantines a foreign-account allocation that points at this account transaction', () => {
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      walletBalanceUsd: '-1',
      transactions: [{
        id: 'local-consume', type: 'CONSUME', amountUsd: '-1', balanceAfterUsd: '-1',
        description: 'usage', orderId: null, createdAt: '2026-07-15T10:00:00.000Z',
      }],
      allocations: [{
        id: 'foreign-allocation',
        billingAccountId: 'ba_personal_other',
        balanceTransactionId: 'local-consume',
        balanceGrantId: null,
        source: 'NEGATIVE_BALANCE',
        amountUsd: '1',
        recognizedRevenueUsd: '0',
        bonusConsumedUsd: '0',
        settledUsd: '0',
        settledAt: null,
        createdAt: '2026-07-15T10:00:00.001Z',
      }],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        'ALLOCATION_ACCOUNT_OWNERSHIP_MISMATCH:foreign-allocation:'
          + 'ba_personal_other:ba_personal_u1',
      ]),
    }));
  });

  it('quarantines debt-only state on a BALANCE_GRANT allocation', () => {
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      walletBalanceUsd: '0',
      transactions: [
        {
          id: 'recharge', type: 'RECHARGE', amountUsd: '1', balanceAfterUsd: '1',
          description: 'recharge', orderId: 'order', createdAt: '2026-07-15T10:00:00.000Z',
        },
        {
          id: 'consume', type: 'CONSUME', amountUsd: '-1', balanceAfterUsd: '0',
          description: 'usage', orderId: null, createdAt: '2026-07-15T10:01:00.000Z',
        },
      ],
      grants: [{
        id: 'grant', orderId: 'order', source: 'RECHARGE', paidAmountUsd: '1',
        bonusAmountUsd: '0', grantedAmountUsd: '1', remainingAmountUsd: '0',
        remainingPaidAmountUsd: null, remainingBonusAmountUsd: null,
        discountRate: '1', isExpired: false, createdAt: '2026-07-15T10:00:00.000Z',
      }],
      allocations: [{
        id: 'grant-use', balanceTransactionId: 'consume', balanceGrantId: 'grant',
        source: 'BALANCE_GRANT', amountUsd: '1', recognizedRevenueUsd: '1',
        bonusConsumedUsd: '0', settledUsd: '1', settledAt: '2026-07-15T10:02:00.000Z',
        createdAt: '2026-07-15T10:01:00.000Z',
      }],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining(['GRANT_ALLOCATION_HAS_DEBT_STATE:grant-use']),
    }));
  });

  it('promotes a deterministic enterprise ledger without rewriting its financial totals', () => {
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      billingAccountId: 'ba_enterprise_t1',
      accountType: 'enterprise',
      walletBalanceUsd: '-1',
      transactions: [
        {
          id: 'consume', type: 'CONSUME', amountUsd: '-2', balanceAfterUsd: '-2',
          description: 'usage', orderId: null, createdAt: '2026-07-15T10:00:00.000Z',
        },
        {
          id: 'recharge', type: 'RECHARGE', amountUsd: '1', balanceAfterUsd: '-1',
          description: 'recharge', orderId: 'order', createdAt: '2026-07-15T10:01:00.000Z',
        },
      ],
      grants: [{
        id: 'grant', orderId: 'order', source: 'RECHARGE', paidAmountUsd: '1',
        bonusAmountUsd: '0', grantedAmountUsd: '1', remainingAmountUsd: '0',
        remainingPaidAmountUsd: null, remainingBonusAmountUsd: null,
        discountRate: '1', isExpired: false, createdAt: '2026-07-15T10:01:00.000Z',
      }],
      allocations: [{
        id: 'enterprise-debt', balanceTransactionId: 'consume', balanceGrantId: null,
        source: 'ENTERPRISE_CREDIT', amountUsd: '2', recognizedRevenueUsd: '1',
        bonusConsumedUsd: '0', settledUsd: '1', settledAt: null,
        createdAt: '2026-07-15T10:00:00.000Z',
      }],
      settlements: [{
        id: 'enterprise-settlement',
        allocationId: 'enterprise-debt',
        repaymentTransactionId: 'recharge',
        balanceGrantId: null,
        debtSource: 'ENTERPRISE_CREDIT',
        repairRunId: null,
        operationKey: 'legacy:enterprise-settlement',
        trigger: 'FUNDING',
        amountUsd: '1',
        paidUsd: '1',
        bonusUsd: '0',
        occurredAt: '2026-07-15T10:01:00.000Z',
        createdAt: '2026-07-15T10:01:00.000Z',
      }],
    }));

    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    expect(plan.accountType).toBe('enterprise');
    expect(plan.debtSource).toBe('ENTERPRISE_CREDIT');
    expect(plan.settlementWriteMode).toBe('VERIFY_EXISTING');
    expect(plan.expectedSettlementCount).toBe(1);
    expect(plan.allocationMutations).toEqual([]);
    expect(plan.grantMutations).toEqual([expect.objectContaining({
      grantId: 'grant',
      expectedRemainingAmountUsd: '0.000000000000',
      remainingAmountUsd: '0.000000000000',
      remainingPaidAmountUsd: '0.000000000000',
    })]);
  });

  it('repairs only enterprise allocation components proven by immutable bonus settlement replay', () => {
    const settledAt = '2026-07-15T10:01:00.000Z';
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      billingAccountId: 'ba_enterprise_component_repair',
      accountType: 'enterprise',
      walletBalanceUsd: '0',
      transactions: [
        {
          id: 'consume-e955', type: 'CONSUME', amountUsd: '-0.022612',
          balanceAfterUsd: '-0.022612', description: 'usage', orderId: null,
          createdAt: '2026-07-15T10:00:00.000Z',
        },
        {
          id: 'voucher-e955', type: 'ADJUST', amountUsd: '0.022612',
          balanceAfterUsd: '0', description: 'voucher:grant-e955 admin:repair',
          orderId: null, operationKey: null, createdAt: settledAt,
        },
      ],
      grants: [{
        id: 'grant-e955', orderId: null, source: 'VOUCHER', paidAmountUsd: '0',
        bonusAmountUsd: '0.022612', grantedAmountUsd: '0.022612',
        remainingAmountUsd: '0', remainingPaidAmountUsd: '0',
        remainingBonusAmountUsd: '0', discountRate: '0', isExpired: false,
        createdAt: settledAt,
      }],
      allocations: [{
        id: 'e955', balanceTransactionId: 'consume-e955', balanceGrantId: null,
        source: 'ENTERPRISE_CREDIT', amountUsd: '0.022612',
        recognizedRevenueUsd: '0', bonusConsumedUsd: '0', settledUsd: '0.022612',
        settledAt, ledgerSequence: null, createdAt: '2026-07-15T10:00:00.000Z',
      }],
      settlements: [{
        id: 'settlement-e955', allocationId: 'e955',
        repaymentTransactionId: 'voucher-e955', balanceGrantId: 'grant-e955',
        debtSource: 'ENTERPRISE_CREDIT', repairRunId: null,
        operationKey: 'legacy:settlement-e955', trigger: 'FUNDING',
        amountUsd: '0.022612', paidUsd: '0', bonusUsd: '0.022612',
        occurredAt: settledAt, createdAt: settledAt,
      }],
    }));

    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    expect(plan.allocationMutations).toEqual([{
      allocationId: 'e955',
      expectedSettledUsd: '0.022612000000',
      expectedRecognizedRevenueUsd: '0.000000000000',
      expectedBonusConsumedUsd: '0.000000000000',
      expectedSettledAt: settledAt,
      settledUsd: '0.022612000000',
      recognizedRevenueUsd: '0.000000000000',
      bonusConsumedUsd: '0.022612000000',
      settledAt,
    }]);
  });

  it('proves the exact legacy voucher writer and preserves its application financial time', () => {
    const plan = buildBalanceLedgerRepairPlan(legacyVoucherEnterpriseSnapshot());

    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    expect(plan.allocationMutations).toEqual([{
      allocationId: 'legacy-voucher-debt',
      expectedSettledUsd: '0.022612000000',
      expectedRecognizedRevenueUsd: '0.000000000000',
      expectedBonusConsumedUsd: '0.000000000000',
      expectedSettledAt: '2026-07-15T10:01:00.039Z',
      settledUsd: '0.022612000000',
      recognizedRevenueUsd: '0.000000000000',
      bonusConsumedUsd: '0.022612000000',
      settledAt: '2026-07-15T10:01:00.039Z',
    }]);
    expect(plan.settlementMutations).toEqual([expect.objectContaining({
      allocationId: 'legacy-voucher-debt',
      repaymentTransactionId: 'legacy-voucher-tx',
      balanceGrantId: 'legacy-voucher-grant',
      fundingNature: 'BONUS',
      amountUsd: '0.022612000000',
      occurredAt: '2026-07-15T10:01:00.029Z',
    })]);
  });

  it('does not authorize the personal pre-idempotency voucher proof for an enterprise account', () => {
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      billingAccountId: 'ba_enterprise_pre_idempotency_voucher',
      accountType: 'enterprise',
      walletBalanceUsd: '0.5',
      transactions: [
        {
          id: 'enterprise-pre-voucher', type: 'ADJUST', amountUsd: '1',
          balanceAfterUsd: '1',
          description: 'voucher:enterprise-pre-grant admin:operator legacy voucher',
          orderId: null, operationKey: null,
          createdAt: '2026-07-15T10:00:00.004Z',
        },
        {
          id: 'enterprise-pre-consume', type: 'CONSUME', amountUsd: '-0.5',
          balanceAfterUsd: '0.5', description: 'usage', orderId: null,
          operationKey: null, tokenUsageId: 'enterprise-pre-usage',
          createdAt: '2026-07-15T10:01:00.000Z',
        },
      ],
      grants: [{
        id: 'enterprise-pre-grant', orderId: null, source: 'VOUCHER',
        paidAmountUsd: '0', bonusAmountUsd: '1', grantedAmountUsd: '1',
        remainingAmountUsd: '0.5', remainingPaidAmountUsd: '0',
        remainingBonusAmountUsd: '0.5', discountRate: '0', isExpired: false,
        validFrom: '2026-07-15T10:00:00.000Z',
        createdAt: '2026-07-15T10:00:00.001Z', expiresAt: null,
      }],
      allocations: [{
        id: 'enterprise-pre-allocation',
        balanceTransactionId: 'enterprise-pre-consume',
        tokenUsageId: 'enterprise-pre-usage',
        balanceGrantId: 'enterprise-pre-grant', source: 'BALANCE_GRANT',
        amountUsd: '0.5', recognizedRevenueUsd: '0', bonusConsumedUsd: '0.5',
        settledUsd: '0', settledAt: null,
        createdAt: '2026-07-15T10:01:00.001Z',
      }],
      voucherIdempotencyEvidence: [],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        expect.stringContaining(
          'FUNDING_VOUCHER_GRANT_MISMATCH:enterprise-pre-voucher:'
            + 'enterprise-pre-grant:CREATED_AT_MISMATCH:'
            + 'IDEMPOTENCY_EVIDENCE_MATCH_0:PERSONAL_PROOF_ACCOUNT_TYPE_REQUIRED',
        ),
      ]),
    }));
  });

  it('proves one legacy recharge hole split across two allocations without rewriting settledAt', () => {
    const plan = buildBalanceLedgerRepairPlan(legacyMultiAllocationRechargeSnapshot());

    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    expect(plan.allocationMutations).toEqual([]);
    expect(plan.settlementMutations).toEqual([
      expect.objectContaining({
        allocationId: 'legacy-debt-1',
        repaymentTransactionId: 'legacy-recharge',
        amountUsd: '0.147311000000',
        occurredAt: '2026-07-15T15:52:44.929Z',
      }),
      expect.objectContaining({
        allocationId: 'legacy-debt-2',
        repaymentTransactionId: 'legacy-recharge',
        amountUsd: '0.053285000000',
        occurredAt: '2026-07-15T15:52:44.929Z',
      }),
    ]);
  });

  it.each([
    'different allocation settledAt',
    'settlement bundle total differs from the wallet hole',
    'legacy settlement unexpectedly links a balance grant',
    'repayment transaction has an operation key',
    'order grant predates its settlements',
  ])('does not use the multi-allocation legacy timing proof when %s', (variant) => {
    const snapshot = legacyMultiAllocationRechargeSnapshot();
    if (variant === 'different allocation settledAt') {
      snapshot.allocations[1].settledAt = '2026-07-15T15:52:44.935Z';
    } else if (variant === 'settlement bundle total differs from the wallet hole') {
      snapshot.settlements[1].amountUsd = '0.053284';
      snapshot.settlements[1].paidUsd = '0.053284';
    } else if (variant === 'legacy settlement unexpectedly links a balance grant') {
      snapshot.settlements[1].balanceGrantId = 'legacy-recharge-grant';
    } else if (variant === 'order grant predates its settlements') {
      snapshot.grants[0].validFrom = '2026-07-15T15:52:44.938Z';
      snapshot.grants[0].createdAt = '2026-07-15T15:52:44.938Z';
    } else {
      snapshot.transactions[2].operationKey =
        'balance:recharge:legacy-recharge-order:paid';
    }

    const plan = buildBalanceLedgerRepairPlan(snapshot);

    expect(plan.status).toBe('QUARANTINED');
    if (plan.status !== 'QUARANTINED') return;
    expect(plan.reasons.some((reason) => (
      reason.startsWith('ENTERPRISE_ALLOCATION_SETTLEMENT_STATE_MISMATCH:')
      || reason.startsWith('ENTERPRISE_SETTLEMENT_OCCURRED_AT_MISMATCH:')
      || reason.startsWith('ENTERPRISE_SETTLEMENT_REPLAY_MISMATCH:')
      || reason.startsWith('FUNDING_RECHARGE_ORDER_MISMATCH:')
    ))).toBe(true);
  });

  it.each([
    ['missing receipt', { voucherIdempotencyEvidence: [] }],
    ['non-committed receipt', {
      voucherIdempotencyEvidence: [legacyVoucherIdempotencyEvidence({ status: 'PENDING' })],
    }],
    ['receipt with an extra unreviewed field', {
      voucherIdempotencyEvidence: [legacyVoucherIdempotencyEvidence({
        result: {
          ...(legacyVoucherIdempotencyEvidence().result as Record<string, unknown>),
          unreviewed: true,
        },
      })],
    }],
    ['receipt amount mismatch', {
      voucherIdempotencyEvidence: [legacyVoucherIdempotencyEvidence({
        result: {
          ...(legacyVoucherIdempotencyEvidence().result as Record<string, unknown>),
          transaction: {
            ...((legacyVoucherIdempotencyEvidence().result as {
              transaction: Record<string, unknown>;
            }).transaction),
            amountCents: 99,
          },
        },
      })],
    }],
  ])('quarantines a legacy voucher with %s', (_label, overrides) => {
    const plan = buildBalanceLedgerRepairPlan(legacyVoucherEnterpriseSnapshot(overrides));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        expect.stringContaining('FUNDING_VOUCHER_GRANT_MISMATCH:legacy-voucher-tx:'),
      ]),
    }));
  });

  it.each([
    ['response.transaction', 'transaction'],
    ['response.grant', 'grant'],
  ] as const)(
    'does not ignore a voucher receipt linked only through %s',
    (_label, responseKey) => {
      const directEvidence = legacyVoucherIdempotencyEvidence();
      const directResult = directEvidence.result as {
        transaction: Record<string, unknown>;
        grant: Record<string, unknown>;
      };
      const plan = buildBalanceLedgerRepairPlan(legacyVoucherEnterpriseSnapshot({
        voucherIdempotencyEvidence: [legacyVoucherIdempotencyEvidence({
          result: {
            response: {
              [responseKey]: directResult[responseKey],
            },
          },
        })],
      }));

      expect(plan).toEqual(expect.objectContaining({
        status: 'QUARANTINED',
        reasons: expect.arrayContaining([
          expect.stringContaining(
            'FUNDING_VOUCHER_GRANT_MISMATCH:legacy-voucher-tx:'
              + 'legacy-voucher-grant:CREATED_AT_MISMATCH:'
              + 'IDEMPOTENCY_RECEIPT_SCHEMA_INVALID',
          ),
        ]),
      }));
      if (plan.status !== 'QUARANTINED') return;
      expect(plan.reasons).not.toEqual(expect.arrayContaining([
        expect.stringContaining('IDEMPOTENCY_EVIDENCE_MATCH_0'),
      ]));
    },
  );

  it('rejects a direct voucher receipt with a conflicting nested response envelope', () => {
    const directEvidence = legacyVoucherIdempotencyEvidence();
    const directResult = directEvidence.result as {
      transaction: Record<string, unknown>;
      grant: Record<string, unknown>;
    };
    const plan = buildBalanceLedgerRepairPlan(legacyVoucherEnterpriseSnapshot({
      voucherIdempotencyEvidence: [legacyVoucherIdempotencyEvidence({
        result: {
          ...directResult,
          response: {
            transaction: {
              ...directResult.transaction,
              id: 'conflicting-voucher-transaction',
            },
            grant: {
              ...directResult.grant,
              id: 'conflicting-voucher-grant',
            },
          },
        },
      })],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        expect.stringContaining(
          'FUNDING_VOUCHER_GRANT_MISMATCH:legacy-voucher-tx:'
            + 'legacy-voucher-grant:CREATED_AT_MISMATCH:'
            + 'IDEMPOTENCY_RECEIPT_SCHEMA_INVALID',
        ),
      ]),
    }));
  });

  it('rejects an extra nested voucher evidence row instead of accepting the direct receipt', () => {
    const directEvidence = legacyVoucherIdempotencyEvidence();
    const directResult = directEvidence.result as {
      transaction: Record<string, unknown>;
      grant: Record<string, unknown>;
    };
    const plan = buildBalanceLedgerRepairPlan(legacyVoucherEnterpriseSnapshot({
      voucherIdempotencyEvidence: [
        directEvidence,
        legacyVoucherIdempotencyEvidence({
          key: 'admin:payg-voucher:repair-tenant:nested-extra-key',
          result: {
            response: {
              transaction: directResult.transaction,
              grant: directResult.grant,
            },
          },
        }),
      ],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        expect.stringContaining(
          'FUNDING_VOUCHER_GRANT_MISMATCH:legacy-voucher-tx:'
            + 'legacy-voucher-grant:CREATED_AT_MISMATCH:IDEMPOTENCY_EVIDENCE_MATCH_2',
        ),
      ]),
    }));
  });

  it.each([
    ['non-self legacy key', {
      operationKey: 'legacy:other-settlement',
    }],
    ['migration timestamp mismatch', {
      occurredAt: '2026-07-15T10:01:00.051Z',
    }],
    ['writer timestamp reversal', {
      createdAt: '2026-07-15T10:01:00.030Z',
      occurredAt: '2026-07-15T10:01:00.030Z',
    }],
    ['settlement amount mismatch', {
      amountUsd: '0.022611',
      bonusUsd: '0.022611',
    }],
  ])('does not use the legacy settlement timing proof for %s', (_label, settlementOverride) => {
    const snapshot = legacyVoucherEnterpriseSnapshot();
    snapshot.settlements = [{
      ...snapshot.settlements[0],
      ...settlementOverride,
    }];
    const plan = buildBalanceLedgerRepairPlan(snapshot);

    expect(plan.status).toBe('QUARANTINED');
    if (plan.status !== 'QUARANTINED') return;
    expect(plan.reasons.some((reason) => (
      reason.startsWith('ENTERPRISE_ALLOCATION_SETTLEMENT_STATE_MISMATCH:')
      || reason.startsWith('ENTERPRISE_SETTLEMENT_OCCURRED_AT_MISMATCH:')
      || reason.startsWith('ENTERPRISE_SETTLEMENT_REPLAY_MISMATCH:')
    ))).toBe(true);
  });

  it('does not repair enterprise components when immutable settled state disagrees with replay', () => {
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      billingAccountId: 'ba_enterprise_state_mismatch',
      accountType: 'enterprise',
      walletBalanceUsd: '-0.012612',
      transactions: [
        {
          id: 'consume', type: 'CONSUME', amountUsd: '-0.022612',
          balanceAfterUsd: '-0.022612', description: 'usage', orderId: null,
          createdAt: '2026-07-15T10:00:00.000Z',
        },
        {
          id: 'voucher', type: 'ADJUST', amountUsd: '0.01', balanceAfterUsd: '-0.012612',
          description: 'voucher:grant admin:repair', orderId: null, operationKey: null,
          createdAt: '2026-07-15T10:01:00.000Z',
        },
      ],
      grants: [{
        id: 'grant', orderId: null, source: 'VOUCHER', paidAmountUsd: '0',
        bonusAmountUsd: '0.01', grantedAmountUsd: '0.01', remainingAmountUsd: '0',
        remainingPaidAmountUsd: '0', remainingBonusAmountUsd: '0', discountRate: '0',
        isExpired: false, createdAt: '2026-07-15T10:01:00.000Z',
      }],
      allocations: [{
        id: 'debt', balanceTransactionId: 'consume', balanceGrantId: null,
        source: 'ENTERPRISE_CREDIT', amountUsd: '0.022612', recognizedRevenueUsd: '0',
        bonusConsumedUsd: '0', settledUsd: '0.009', settledAt: null,
        createdAt: '2026-07-15T10:00:00.000Z',
      }],
      settlements: [{
        id: 'settlement', allocationId: 'debt', repaymentTransactionId: 'voucher',
        balanceGrantId: 'grant', debtSource: 'ENTERPRISE_CREDIT', repairRunId: null,
        operationKey: 'legacy:settlement', trigger: 'FUNDING', amountUsd: '0.01',
        paidUsd: '0', bonusUsd: '0.01', occurredAt: '2026-07-15T10:01:00.000Z',
        createdAt: '2026-07-15T10:01:00.000Z',
      }],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        'ENTERPRISE_ALLOCATION_SETTLEMENT_STATE_MISMATCH:debt',
      ]),
    }));
  });

  it('normalizes a legacy enterprise recharge-with-bonus settlement bundle', () => {
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      billingAccountId: 'ba_enterprise_t1',
      accountType: 'enterprise',
      walletBalanceUsd: '-0.5',
      transactions: [
        {
          id: 'consume', type: 'CONSUME', amountUsd: '-2.5', balanceAfterUsd: '-2.5',
          description: 'usage', orderId: null, createdAt: '2026-07-15T10:00:00.000Z',
        },
        {
          id: 'recharge', type: 'RECHARGE', amountUsd: '1', balanceAfterUsd: '-1.5',
          description: 'recharge', orderId: 'order', createdAt: '2026-07-15T10:01:00.000Z',
        },
        {
          id: 'bonus', type: 'ADJUST', amountUsd: '1', balanceAfterUsd: '-0.5',
          description: 'recharge-bonus tier:tier', orderId: 'order',
          createdAt: '2026-07-15T10:01:00.000Z',
        },
      ],
      grants: [{
        id: 'grant', orderId: 'order', source: 'RECHARGE', paidAmountUsd: '1',
        bonusAmountUsd: '1', grantedAmountUsd: '2', remainingAmountUsd: '0',
        remainingPaidAmountUsd: null, remainingBonusAmountUsd: null,
        discountRate: '0.5', isExpired: false, createdAt: '2026-07-15T10:01:00.000Z',
      }],
      allocations: [{
        id: 'enterprise-debt', balanceTransactionId: 'consume', balanceGrantId: null,
        source: 'ENTERPRISE_CREDIT', amountUsd: '2.5', recognizedRevenueUsd: '1',
        bonusConsumedUsd: '1', settledUsd: '2', settledAt: null,
        createdAt: '2026-07-15T10:00:00.000Z',
      }],
      settlements: [{
        id: 'enterprise-settlement', allocationId: 'enterprise-debt',
        repaymentTransactionId: 'recharge', balanceGrantId: null,
        debtSource: 'ENTERPRISE_CREDIT', repairRunId: null,
        operationKey: 'legacy:enterprise-settlement', trigger: 'FUNDING', amountUsd: '2',
        paidUsd: '1', bonusUsd: '1', occurredAt: '2026-07-15T10:01:00.000Z',
        createdAt: '2026-07-15T10:01:00.000Z',
      }],
    }));

    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    expect(plan.settlementMutations).toHaveLength(2);
    expect(plan.expectedSettlementCount).toBe(1);
    expect(plan.allocationMutations).toEqual([]);
  });

  it('verifies an explicitly keyed enterprise paid debt adjustment without inventing a grant', () => {
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      billingAccountId: 'ba_enterprise_adjust',
      accountType: 'enterprise',
      walletBalanceUsd: '-1',
      transactions: [
        {
          id: 'consume', type: 'CONSUME', amountUsd: '-2', balanceAfterUsd: '-2',
          description: 'usage', orderId: null, operationKey: null,
          createdAt: '2026-07-15T10:00:00.000Z',
        },
        {
          id: 'paid-debt-adjust', type: 'ADJUST', amountUsd: '1', balanceAfterUsd: '-1',
          description: 'enterprise paid debt adjustment', orderId: null,
          operationKey: 'balance:admin-adjust:enterprise-paid-debt:idem-1',
          createdAt: '2026-07-15T10:01:00.000Z',
        },
      ],
      allocations: [{
        id: 'enterprise-debt', balanceTransactionId: 'consume', balanceGrantId: null,
        source: 'ENTERPRISE_CREDIT', amountUsd: '2', recognizedRevenueUsd: '1',
        bonusConsumedUsd: '0', settledUsd: '1', settledAt: null,
        createdAt: '2026-07-15T10:00:00.000Z',
      }],
      settlements: [{
        id: 'paid-debt-settlement', allocationId: 'enterprise-debt',
        repaymentTransactionId: 'paid-debt-adjust', balanceGrantId: null,
        debtSource: 'ENTERPRISE_CREDIT', repairRunId: null,
        operationKey: 'funding:paid-debt-adjust:enterprise-debt:ENTERPRISE_CREDIT',
        trigger: 'FUNDING', amountUsd: '1', paidUsd: '1', bonusUsd: '0',
        occurredAt: '2026-07-15T10:01:00.000Z', createdAt: '2026-07-15T10:01:00.000Z',
      }],
    }));

    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    expect(plan.settlementWriteMode).toBe('VERIFY_EXISTING');
    expect(plan.allocationMutations).toEqual([]);
    expect(plan.settlementMutations).toEqual([expect.objectContaining({
      allocationId: 'enterprise-debt',
      repaymentTransactionId: 'paid-debt-adjust',
      balanceGrantId: null,
      fundingNature: 'PAID',
      amountUsd: '1.000000000000',
    })]);
  });

  it('quarantines the same enterprise adjustment when its stable operation key is absent', () => {
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      billingAccountId: 'ba_enterprise_adjust_unkeyed',
      accountType: 'enterprise',
      walletBalanceUsd: '-1',
      transactions: [
        {
          id: 'consume', type: 'CONSUME', amountUsd: '-2', balanceAfterUsd: '-2',
          description: 'usage', orderId: null, createdAt: '2026-07-15T10:00:00.000Z',
        },
        {
          id: 'unkeyed-adjust', type: 'ADJUST', amountUsd: '1', balanceAfterUsd: '-1',
          description: 'enterprise paid debt adjustment', orderId: null,
          createdAt: '2026-07-15T10:01:00.000Z',
        },
      ],
      allocations: [{
        id: 'enterprise-debt', balanceTransactionId: 'consume', balanceGrantId: null,
        source: 'ENTERPRISE_CREDIT', amountUsd: '2', recognizedRevenueUsd: '0',
        bonusConsumedUsd: '0', settledUsd: '0', settledAt: null,
        createdAt: '2026-07-15T10:00:00.000Z',
      }],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        'AMBIGUOUS_POSITIVE_FUNDING:unkeyed-adjust:enterprise paid debt adjustment',
      ]),
    }));
  });

  it('accepts V2 enterprise recharge-with-bonus settlements on separate repayment rows', () => {
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      billingAccountId: 'ba_enterprise_t1',
      accountType: 'enterprise',
      walletBalanceUsd: '-0.5',
      transactions: [
        {
          id: 'consume', type: 'CONSUME', amountUsd: '-2.5', balanceAfterUsd: '-2.5',
          description: 'usage', orderId: null, createdAt: '2026-07-15T10:00:00.000Z',
        },
        {
          id: 'recharge', type: 'RECHARGE', amountUsd: '1', balanceAfterUsd: '-1.5',
          description: 'recharge', orderId: 'order', createdAt: '2026-07-15T10:01:00.000Z',
        },
        {
          id: 'bonus', type: 'ADJUST', amountUsd: '1', balanceAfterUsd: '-0.5',
          description: 'recharge-bonus tier:tier', orderId: 'order',
          createdAt: '2026-07-15T10:01:00.000Z',
        },
      ],
      grants: [{
        id: 'grant', orderId: 'order', source: 'RECHARGE', paidAmountUsd: '1',
        bonusAmountUsd: '1', grantedAmountUsd: '2', remainingAmountUsd: '0',
        remainingPaidAmountUsd: '0', remainingBonusAmountUsd: '0',
        discountRate: '0.5', isExpired: false, createdAt: '2026-07-15T10:01:00.000Z',
      }],
      allocations: [{
        id: 'enterprise-debt', balanceTransactionId: 'consume', balanceGrantId: null,
        source: 'ENTERPRISE_CREDIT', amountUsd: '2.5', recognizedRevenueUsd: '1',
        bonusConsumedUsd: '1', settledUsd: '2', settledAt: null,
        createdAt: '2026-07-15T10:00:00.000Z',
      }],
      settlements: [
        {
          id: 'paid-settlement', allocationId: 'enterprise-debt',
          repaymentTransactionId: 'recharge', balanceGrantId: 'grant',
          debtSource: 'ENTERPRISE_CREDIT', repairRunId: null,
          operationKey: 'funding:recharge:enterprise-debt:ENTERPRISE_CREDIT',
          trigger: 'FUNDING', amountUsd: '1', paidUsd: '1', bonusUsd: '0',
          occurredAt: '2026-07-15T10:01:00.000Z', createdAt: '2026-07-15T10:01:00.000Z',
        },
        {
          id: 'bonus-settlement', allocationId: 'enterprise-debt',
          repaymentTransactionId: 'bonus', balanceGrantId: 'grant',
          debtSource: 'ENTERPRISE_CREDIT', repairRunId: null,
          operationKey: 'funding:bonus:enterprise-debt:ENTERPRISE_CREDIT',
          trigger: 'FUNDING', amountUsd: '1', paidUsd: '0', bonusUsd: '1',
          occurredAt: '2026-07-15T10:01:00.000Z', createdAt: '2026-07-15T10:01:00.000Z',
        },
      ],
    }));

    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    expect(plan.expectedSettlementCount).toBe(2);
    expect(plan.grantMutations).toEqual([]);
  });

  it('quarantines an enterprise settlement that cannot be proven by funding replay', () => {
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      billingAccountId: 'ba_enterprise_t1',
      accountType: 'enterprise',
      walletBalanceUsd: '-1',
      transactions: [{
        id: 'consume', type: 'CONSUME', amountUsd: '-1', balanceAfterUsd: '-1',
        description: 'usage', orderId: null, createdAt: '2026-07-15T10:00:00.000Z',
      }],
      allocations: [{
        id: 'enterprise-debt', balanceTransactionId: 'consume', balanceGrantId: null,
        source: 'ENTERPRISE_CREDIT', amountUsd: '1', recognizedRevenueUsd: '0',
        bonusConsumedUsd: '0', settledUsd: '0', settledAt: null,
        createdAt: '2026-07-15T10:00:00.000Z',
      }],
      settlements: [{
        id: 'phantom-settlement', allocationId: 'enterprise-debt', repaymentTransactionId: null,
        balanceGrantId: null, debtSource: 'ENTERPRISE_CREDIT', repairRunId: null,
        operationKey: 'legacy:phantom-settlement', trigger: 'SWEEP', amountUsd: '1',
        paidUsd: '1', bonusUsd: '0', occurredAt: '2026-07-15T10:01:00.000Z',
        createdAt: '2026-07-15T10:01:00.000Z',
      }],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        'ENTERPRISE_SETTLEMENT_TRIGGER_UNSUPPORTED:phantom-settlement:SWEEP',
        'ENTERPRISE_SETTLEMENT_REPAYMENT_INVALID:phantom-settlement',
      ]),
    }));
  });


  it('quarantines the old GRANT_RULE text because no durable BALANCE funding link exists', () => {
    const plan = buildBalanceLedgerRepairPlan(singleDebtFundingSnapshot({
      funding: {
        id: 'legacy-grant-rule', type: 'ADJUST', amountUsd: '2', balanceAfterUsd: '1',
        description: 'grant-rule:rule-1 product:product-1', orderId: null,
        operationKey: null, createdAt: '2026-07-15T10:01:00.000Z',
      },
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        'AMBIGUOUS_POSITIVE_FUNDING:legacy-grant-rule:grant-rule:rule-1 product:product-1',
      ]),
    }));
  });

  it('quarantines canonical GRANT_RULE text until reward funding is designed separately', () => {
    const plan = buildBalanceLedgerRepairPlan(singleDebtFundingSnapshot({
      funding: {
        id: 'canonical-grant-rule', type: 'ADJUST', amountUsd: '2', balanceAfterUsd: '1',
        description: 'grant-rule:rule-1 balance-grant:grant-1 redemption:redemption-1',
        orderId: null, operationKey: null, createdAt: '2026-07-15T10:01:00.000Z',
      },
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        'FUNDING_GRANT_RULE_DEFERRED:canonical-grant-rule:grant-1',
      ]),
    }));
  });

  it('uses admin recharge machine links to disambiguate equal funding rows', () => {
    const fundingAt = '2026-07-15T10:01:00.000Z';
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      walletBalanceUsd: '6',
      transactions: [
        {
          id: 'consume', type: 'CONSUME', amountUsd: '-4', balanceAfterUsd: '-4',
          description: 'usage', orderId: null, createdAt: '2026-07-15T10:00:00.000Z',
        },
        {
          id: 'recharge-1', type: 'RECHARGE', amountUsd: '5', balanceAfterUsd: '1',
          description: 'admin recharge', orderId: null,
          operationKey: 'balance:admin-recharge:grant:grant-1', createdAt: fundingAt,
        },
        {
          id: 'recharge-2', type: 'RECHARGE', amountUsd: '5', balanceAfterUsd: '6',
          description: 'admin recharge', orderId: null,
          operationKey: 'balance:admin-recharge:grant:grant-2', createdAt: fundingAt,
        },
      ],
      grants: [
        {
          id: 'grant-1', orderId: null, source: 'RECHARGE', paidAmountUsd: '5',
          bonusAmountUsd: '0', grantedAmountUsd: '5', remainingAmountUsd: '1',
          remainingPaidAmountUsd: '1', remainingBonusAmountUsd: '0',
          discountRate: '1', isExpired: false, createdAt: fundingAt,
        },
        {
          id: 'grant-2', orderId: null, source: 'RECHARGE', paidAmountUsd: '5',
          bonusAmountUsd: '0', grantedAmountUsd: '5', remainingAmountUsd: '5',
          remainingPaidAmountUsd: '5', remainingBonusAmountUsd: '0',
          discountRate: '1', isExpired: false, createdAt: fundingAt,
        },
      ],
      allocations: [{
        id: 'debt-1', balanceTransactionId: 'consume', balanceGrantId: null,
        source: 'NEGATIVE_BALANCE', amountUsd: '4', recognizedRevenueUsd: '0',
        bonusConsumedUsd: '0', settledUsd: '0', settledAt: null,
        createdAt: '2026-07-15T10:00:00.000Z',
      }],
    }));

    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    expect(plan.settlementMutations).toEqual([
      expect.objectContaining({
        allocationId: 'debt-1',
        repaymentTransactionId: 'recharge-1',
        balanceGrantId: 'grant-1',
        amountUsd: '4.000000000000',
      }),
    ]);
  });

  it('proves a legacy order recharge with non-equal row timestamps from the exact order bundle', () => {
    const plan = buildBalanceLedgerRepairPlan(singleDebtFundingSnapshot({
      funding: {
        id: 'recharge', type: 'RECHARGE', amountUsd: '2', balanceAfterUsd: '1',
        description: '充值订单: order-r', orderId: 'order-r', operationKey: null,
        createdAt: '2026-07-15T10:01:00.010Z',
      },
      grants: [{
        id: 'grant-r', orderId: 'order-r', source: 'RECHARGE', paidAmountUsd: '2',
        bonusAmountUsd: '0', grantedAmountUsd: '2', remainingAmountUsd: '1',
        remainingPaidAmountUsd: '1', remainingBonusAmountUsd: '0', discountRate: '1',
        isExpired: false, validFrom: '2026-07-15T10:01:00.020Z', expiresAt: null,
        createdAt: '2026-07-15T10:01:00.025Z',
      }],
      orders: [completedRechargeOrder()],
    }));

    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    expect(plan.settlementMutations).toEqual([
      expect.objectContaining({
        allocationId: 'debt-1',
        repaymentTransactionId: 'recharge',
        balanceGrantId: 'grant-r',
        amountUsd: '1.000000000000',
      }),
    ]);
  });

  it('rejects legacy order timing evidence when validFrom is after grant creation', () => {
    const plan = buildBalanceLedgerRepairPlan(singleDebtFundingSnapshot({
      funding: {
        id: 'recharge', type: 'RECHARGE', amountUsd: '2', balanceAfterUsd: '1',
        description: '充值订单: order-r', orderId: 'order-r', operationKey: null,
        createdAt: '2026-07-15T10:01:00.010Z',
      },
      grants: [{
        id: 'grant-r', orderId: 'order-r', source: 'RECHARGE', paidAmountUsd: '2',
        bonusAmountUsd: '0', grantedAmountUsd: '2', remainingAmountUsd: '1',
        remainingPaidAmountUsd: '1', remainingBonusAmountUsd: '0', discountRate: '1',
        isExpired: false, validFrom: '2026-07-15T10:01:00.026Z', expiresAt: null,
        createdAt: '2026-07-15T10:01:00.025Z',
      }],
      orders: [completedRechargeOrder()],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        expect.stringContaining('CREATED_AT_MISMATCH:VALID_FROM_AFTER_CREATION'),
      ]),
    }));
  });

  it('accepts a failed invoice application only when no invoice was ever issued', () => {
    const snapshot = baseSnapshot({
      walletBalanceUsd: '0',
      invoiceItems: [failedInvoiceItem()],
    });
    const plan = buildBalanceLedgerRepairPlan(snapshot);

    expect(plan.status).toBe('READY');
    const maintenancePlan = buildBalanceLedgerRepairPlanAt(snapshot, REPAIR_OBSERVED_AT, {
      allowLegacyExpiryProofs: true,
      allowLegacyExpiredVoucherProofs: false,
      allowInvoiceStabilityProof: true,
    });
    expect(maintenancePlan).toEqual(expect.objectContaining({
      status: 'READY',
      invoiceStabilityProof: null,
    }));
  });

  it.each([
    [
      'non-terminal application',
      failedInvoiceItem({ applicationStatus: 'APPROVED_ISSUING' }),
      'INVOICE_APPLICATION_STATUS_UNSAFE:invoice-application-1:APPROVED_ISSUING',
    ],
    [
      'invoice number',
      failedInvoiceItem({ invoiceNumber: 'INV-1' }),
      'INVOICE_APPLICATION_ARTIFACTS_PRESENT:invoice-application-1:invoiceNumber',
    ],
    [
      'issued lifecycle event',
      failedInvoiceItem({ hasIssuedLifecycleEvent: true }),
      'INVOICE_APPLICATION_ISSUED_HISTORY:invoice-application-1',
    ],
  ])('quarantines invoice evidence with %s', (_label, evidence, reason) => {
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      walletBalanceUsd: '0',
      invoiceItems: [evidence],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([reason]),
    }));
  });

  it('keeps legacy expiry and issued invoice evidence isolated unless the maintenance profile proves both', () => {
    const snapshot = legacyExpiryMaintenanceSnapshot();
    const genericPlan = buildBalanceLedgerRepairPlan(snapshot);
    expect(genericPlan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        'LEGACY_EXPIRY_REQUIRES_MANUAL_REPLAY:expiry-grant',
        'INVOICE_APPLICATION_STATUS_UNSAFE:invoice-application-1:ISSUED',
      ]),
    }));

    const maintenancePlan = buildBalanceLedgerRepairPlanAt(snapshot, REPAIR_OBSERVED_AT, {
      allowLegacyExpiryProofs: true,
      allowLegacyExpiredVoucherProofs: false,
      allowInvoiceStabilityProof: true,
    });
    expect(maintenancePlan).toEqual(expect.objectContaining({
      status: 'READY',
      legacyExpiryProofMutations: [expect.objectContaining({
        proofVersion: 1,
        repairKind: 'LEGACY_INLINE_EXPIRY_V1',
        grantId: 'expiry-grant',
        transactionId: 'legacy-expiry',
        nominalAmountUsd: '0.200000000000',
        nominalPaidUsd: '0.200000000000',
        nominalBonusUsd: '0.000000000000',
        walletBalanceBeforeUsd: '0.200000000000',
        walletBalanceAfterUsd: '0.000000000000',
      })],
      invoiceStabilityProof: {
        proofVersion: 1,
        repairKind: 'ISSUED_INVOICE_STABILITY_V1',
        orderCount: 1,
        applicationCount: 1,
        itemCount: 1,
        eventCount: 1,
        evidenceSha256: 'a'.repeat(64),
      },
      grantMutations: [expect.objectContaining({
        grantId: 'expiry-grant',
        expectedRemainingPaidAmountUsd: null,
        expectedRemainingBonusAmountUsd: null,
        remainingPaidAmountUsd: '0.000000000000',
        remainingBonusAmountUsd: '0.000000000000',
      })],
    }));
    if (maintenancePlan.status === 'READY') {
      expect(Object.keys(
        maintenancePlan.legacyExpiryProofMutations[0].expectedTransaction,
      ).sort()).toEqual([
        'amountUsd',
        'balanceAfterUsd',
        'createdAt',
        'description',
        'id',
        'ledgerSequence',
        'operationKey',
        'orderId',
        'productId',
        'tenantId',
        'tokenUsageId',
        'type',
        'userId',
      ]);
      expect(balanceLedgerRepairReplayHash(maintenancePlan)).toBe(maintenancePlan.replayHash);
    }
  });

  it.each([
    ['order amount', completedRechargeOrder({ amountCents: 201 }), 'ORDER_AMOUNT_MISMATCH'],
    [
      'order subject',
      completedRechargeOrder({ billingAccountId: 'ba_personal_other' }),
      'ORDER_SUBJECT_MISMATCH',
    ],
    [
      'order lifecycle',
      completedRechargeOrder({ completedAt: '2026-07-15T10:01:00.005Z' }),
      'ORDER_FULFILLMENT_WINDOW_MISMATCH',
    ],
    ['order state', completedRechargeOrder({ status: 'REFUNDED' }), 'ORDER_STATE_INVALID'],
  ])(
    'does not use legacy timestamp evidence when the %s fingerprint disagrees',
    (_label, order, reason) => {
      const plan = buildBalanceLedgerRepairPlan(singleDebtFundingSnapshot({
        funding: {
          id: 'recharge', type: 'RECHARGE', amountUsd: '2', balanceAfterUsd: '1',
          description: '充值订单: order-r', orderId: 'order-r', operationKey: null,
          createdAt: '2026-07-15T10:01:00.010Z',
        },
        grants: [{
          id: 'grant-r', orderId: 'order-r', source: 'RECHARGE', paidAmountUsd: '2',
          bonusAmountUsd: '0', grantedAmountUsd: '2', remainingAmountUsd: '1',
          remainingPaidAmountUsd: '1', remainingBonusAmountUsd: '0', discountRate: '1',
          isExpired: false, validFrom: '2026-07-15T10:01:00.020Z', expiresAt: null,
          createdAt: '2026-07-15T10:01:00.025Z',
        }],
        orders: [order],
      }));

      expect(plan).toEqual(expect.objectContaining({
        status: 'QUARANTINED',
        reasons: expect.arrayContaining([
          expect.stringContaining(`CREATED_AT_MISMATCH:${reason}`),
        ]),
      }));
    },
  );

  it('does not treat a one-millisecond row mismatch as a generic legacy tolerance', () => {
    const fundingAt = '2026-07-15T10:01:00.000Z';
    const plan = buildBalanceLedgerRepairPlan(singleDebtFundingSnapshot({
      funding: {
        id: 'recharge', type: 'RECHARGE', amountUsd: '2', balanceAfterUsd: '1',
        description: 'recharge', orderId: 'order-r', operationKey: null, createdAt: fundingAt,
      },
      grants: [{
        id: 'grant-r', orderId: 'order-r', source: 'RECHARGE', paidAmountUsd: '2',
        bonusAmountUsd: '0', grantedAmountUsd: '2', remainingAmountUsd: '1',
        remainingPaidAmountUsd: '1', remainingBonusAmountUsd: '0', discountRate: '1',
        isExpired: false, validFrom: fundingAt, expiresAt: null,
        createdAt: '2026-07-15T10:01:00.001Z',
      }],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        expect.stringContaining('CREATED_AT_MISMATCH:ORDER_EVIDENCE_MATCH_0'),
      ]),
    }));
  });

  it('does not apply the old-writer timestamp proof to a keyed recharge row', () => {
    const plan = buildBalanceLedgerRepairPlan(singleDebtFundingSnapshot({
      funding: {
        id: 'recharge', type: 'RECHARGE', amountUsd: '2', balanceAfterUsd: '1',
        description: 'recharge', orderId: 'order-r',
        operationKey: 'balance:recharge:order-r:paid',
        createdAt: '2026-07-15T10:01:00.010Z',
      },
      grants: [{
        id: 'grant-r', orderId: 'order-r', source: 'RECHARGE', paidAmountUsd: '2',
        bonusAmountUsd: '0', grantedAmountUsd: '2', remainingAmountUsd: '1',
        remainingPaidAmountUsd: '1', remainingBonusAmountUsd: '0', discountRate: '1',
        isExpired: false, validFrom: '2026-07-15T10:01:00.020Z', expiresAt: null,
        createdAt: '2026-07-15T10:01:00.025Z',
      }],
      orders: [completedRechargeOrder()],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        expect.stringContaining('CREATED_AT_MISMATCH:LEGACY_OPERATION_KEY_PRESENT'),
      ]),
    }));
  });

  it.each([
    ['wrong grant source', { source: 'VOUCHER' }, {}],
    ['wrong paid amount', { paidAmountUsd: '1.5', grantedAmountUsd: '1.5' }, {}],
    ['wrong paid/bonus composition', {
      paidAmountUsd: '1', bonusAmountUsd: '1', grantedAmountUsd: '2', discountRate: '0.5',
    }, {}],
    ['wrong grant creation time', { createdAt: '2026-07-15T10:01:01.000Z' }, {}],
    ['wrong grant tenant', { tenantId: 'other-tenant' }, {}],
    ['contradictory paid operation key', {}, { operationKey: 'balance:recharge:other:paid' }],
  ])(
    'quarantines an order-linked recharge with %s',
    (_label, grantOverride, transactionOverride) => {
    const fundingAt = '2026-07-15T10:01:00.000Z';
    const plan = buildBalanceLedgerRepairPlan(singleDebtFundingSnapshot({
      funding: {
        id: 'recharge', type: 'RECHARGE', amountUsd: '2', balanceAfterUsd: '1',
        description: 'recharge', orderId: 'order-r',
        operationKey: 'balance:recharge:order-r:paid', createdAt: fundingAt,
        ...transactionOverride,
      },
      grants: [{
        id: 'grant-r', orderId: 'order-r', source: 'RECHARGE', paidAmountUsd: '2',
        bonusAmountUsd: '0', grantedAmountUsd: '2', remainingAmountUsd: '1',
        remainingPaidAmountUsd: '1', remainingBonusAmountUsd: '0', discountRate: '1',
        isExpired: false, validFrom: fundingAt, expiresAt: null, createdAt: fundingAt,
        ...grantOverride,
      }],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        expect.stringContaining('FUNDING_RECHARGE_ORDER_MISMATCH:recharge:order-r:'),
      ]),
    }));
    },
  );

  it('quarantines an order-linked bonus whose issuance time predates its recharge', () => {
    const rechargeAt = '2026-07-15T10:02:00.000Z';
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      walletBalanceUsd: '1',
      transactions: [
        {
          id: 'consume', type: 'CONSUME', amountUsd: '-2', balanceAfterUsd: '-2',
          description: 'usage', orderId: null, createdAt: '2026-07-15T10:00:00.000Z',
        },
        {
          id: 'recharge', type: 'RECHARGE', amountUsd: '1', balanceAfterUsd: '-1',
          description: 'recharge', orderId: 'order-r',
          operationKey: 'balance:recharge:order-r:paid', createdAt: rechargeAt,
        },
        {
          id: 'bonus', type: 'ADJUST', amountUsd: '2', balanceAfterUsd: '1',
          description: 'recharge-bonus', orderId: 'order-r',
          operationKey: 'balance:recharge:order-r:bonus',
          createdAt: '2026-07-15T10:01:00.000Z',
        },
      ],
      grants: [{
        id: 'grant-r', orderId: 'order-r', source: 'RECHARGE', paidAmountUsd: '1',
        bonusAmountUsd: '2', grantedAmountUsd: '3', remainingAmountUsd: '1',
        remainingPaidAmountUsd: '0', remainingBonusAmountUsd: '1',
        discountRate: '0.333333333333',
        isExpired: false, validFrom: rechargeAt, expiresAt: null, createdAt: rechargeAt,
      }],
      allocations: [{
        id: 'debt-1', balanceTransactionId: 'consume', balanceGrantId: null,
        source: 'NEGATIVE_BALANCE', amountUsd: '2', recognizedRevenueUsd: '0',
        bonusConsumedUsd: '0', settledUsd: '0', settledAt: null,
        createdAt: '2026-07-15T10:00:00.000Z',
      }],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        expect.stringContaining('BONUS_TRANSACTION_FINGERPRINT_INVALID'),
      ]),
    }));
  });

  it('does not let a malformed no-order recharge key fall back to legacy amount matching', () => {
    const fundingAt = '2026-07-15T10:01:00.000Z';
    const plan = buildBalanceLedgerRepairPlan(singleDebtFundingSnapshot({
      funding: {
        id: 'recharge', type: 'RECHARGE', amountUsd: '2', balanceAfterUsd: '1',
        description: 'admin recharge', orderId: null,
        operationKey: 'balance:admin-recharge:grant:', createdAt: fundingAt,
      },
      grants: [{
        id: 'grant-r', orderId: null, source: 'RECHARGE', paidAmountUsd: '2',
        bonusAmountUsd: '0', grantedAmountUsd: '2', remainingAmountUsd: '1',
        remainingPaidAmountUsd: '1', remainingBonusAmountUsd: '0', discountRate: '1',
        isExpired: false, validFrom: fundingAt, expiresAt: null, createdAt: fundingAt,
      }],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        'FUNDING_RECHARGE_OPERATION_KEY_INVALID:recharge:balance:admin-recharge:grant:',
      ]),
    }));
  });

  it('creates and links paid-only grants from exact legacy admin receipts, then replays FIFO', () => {
    const plan = buildBalanceLedgerRepairPlan(legacyAdminFundingEnterpriseSnapshot());

    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    expect(plan.legacyAdminFundingRepairs).toEqual([
      expect.objectContaining({
        repairKind: 'LEGACY_ENTERPRISE_ADMIN_FUNDING_V1',
        action: 'CREATE_GRANT',
        transactionId: 'legacy-admin-adjust',
        grantId: 'repair-enterprise-admin-funding:legacy-admin-adjust',
        amountUsd: '2.000000000000',
        initialRemainingAmountUsd: '1.000000000000',
        expectedGrantSnapshotHash: null,
        expectedGrantRemainingAmountUsd: null,
        finalRemainingAmountUsd: '0.000000000000',
        finalRemainingPaidAmountUsd: '0.000000000000',
        finalRemainingBonusAmountUsd: '0.000000000000',
      }),
      expect.objectContaining({
        repairKind: 'LEGACY_ENTERPRISE_ADMIN_FUNDING_V1',
        action: 'LINK_GRANT',
        transactionId: 'legacy-admin-recharge',
        grantId: 'legacy-admin-recharge-grant',
        amountUsd: '3.000000000000',
        initialRemainingAmountUsd: '3.000000000000',
        expectedGrantSnapshotHash: expect.stringMatching(/^[a-f0-9]{64}$/),
        expectedGrantRemainingAmountUsd: '1.500000000000',
        expectedGrantRemainingPaidAmountUsd: null,
        finalRemainingAmountUsd: '1.500000000000',
        finalRemainingPaidAmountUsd: '1.500000000000',
        finalRemainingBonusAmountUsd: '0.000000000000',
      }),
    ]);
    expect(plan.grantMutations).toEqual([expect.objectContaining({
      grantId: 'legacy-admin-recharge-grant',
      expectedRemainingAmountUsd: '1.500000000000',
      remainingPaidAmountUsd: '1.500000000000',
    })]);
    expect(plan.grantMutations).not.toEqual(expect.arrayContaining([
      expect.objectContaining({ grantId: 'repair-enterprise-admin-funding:legacy-admin-adjust' }),
    ]));
    expect(plan.canonicalAllocationMutations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        allocationId: 'legacy-admin-allocation-a',
        balanceGrantId: 'repair-enterprise-admin-funding:legacy-admin-adjust',
      }),
      expect.objectContaining({
        allocationId: 'legacy-admin-allocation-b1',
        balanceGrantId: 'repair-enterprise-admin-funding:legacy-admin-adjust',
      }),
    ]));
    expect(plan.settlementMutations).toEqual([expect.objectContaining({
      repaymentTransactionId: 'legacy-admin-adjust',
      balanceGrantId: null,
      fundingNature: 'PAID',
      amountUsd: '1.000000000000',
    })]);

    const tampered = {
      ...plan,
      legacyAdminFundingRepairs: plan.legacyAdminFundingRepairs.map((repair) => (
        repair.action === 'CREATE_GRANT'
          ? { ...repair, finalRemainingAmountUsd: '99.000000000000' }
          : repair
      )),
    };
    expect(balanceLedgerRepairReplayHash(tampered)).not.toBe(plan.replayHash);
  });

  it('restores a LINK grant total only when exact FIFO allocation rewrites explain the delta', () => {
    const plan = buildBalanceLedgerRepairPlan(
      legacyAdminFundingLinkedGrantReallocationSnapshot(),
    );

    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    expect(plan.canonicalAllocationMutations).toEqual([
      expect.objectContaining({
        allocationId: 'legacy-admin-allocation-b1',
        expectedBalanceGrantId: 'legacy-admin-recharge-grant',
        expectedAmountUsd: '0.500000000000',
        balanceGrantId: 'repair-enterprise-admin-funding:legacy-admin-adjust',
        amountUsd: '0.500000000000',
      }),
    ]);
    expect(plan.grantMutations).toEqual([
      expect.objectContaining({
        grantId: 'legacy-admin-recharge-grant',
        expectedRemainingAmountUsd: '2.500000000000',
        expectedRemainingPaidAmountUsd: null,
        expectedRemainingBonusAmountUsd: null,
        remainingAmountUsd: '3.000000000000',
        remainingPaidAmountUsd: '3.000000000000',
        remainingBonusAmountUsd: '0.000000000000',
      }),
    ]);
    expect(plan.legacyAdminFundingRepairs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        action: 'CREATE_GRANT',
        transactionId: 'legacy-admin-adjust',
        finalRemainingAmountUsd: '0.500000000000',
      }),
      expect.objectContaining({
        action: 'LINK_GRANT',
        transactionId: 'legacy-admin-recharge',
        grantId: 'legacy-admin-recharge-grant',
        expectedGrantRemainingAmountUsd: '2.500000000000',
        finalRemainingAmountUsd: '3.000000000000',
      }),
    ]));
  });

  it('keeps a LINK grant quarantined when allocation rewrites do not explain its total drift', () => {
    const snapshot = legacyAdminFundingLinkedGrantReallocationSnapshot();
    snapshot.grants[0].remainingAmountUsd = '2.4';

    const plan = buildBalanceLedgerRepairPlan(snapshot);

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        'ENTERPRISE_GRANT_TOTAL_REPLAY_MISMATCH:legacy-admin-recharge-grant',
      ]),
    }));
  });

  it('rejects a v2 envelope because this legacy proof contract accepts direct receipts only', () => {
    const snapshot = legacyAdminFundingEnterpriseSnapshot();
    const evidence = snapshot.legacyAdminFundingIdempotencyEvidence![0];
    const directResponse = evidence.result;
    evidence.result = {
      version: 2,
      status: 'COMMITTED',
      request: {
        scope: evidence.scope,
        userId: 'repair-user',
        tenantId: 'repair-tenant',
        billingAccountId: snapshot.billingAccountId,
        amountUsd: '2.000000000000',
        productId: null,
        description: '线下转账入账',
        reason: null,
        expiresAt: null,
        performedBy: null,
      },
      response: directResponse,
    };

    const plan = buildBalanceLedgerRepairPlan(snapshot);
    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        expect.stringContaining('LEGACY_ADMIN_FUNDING_RECEIPT_SCHEMA_INVALID'),
      ]),
    }));
  });

  it('covers an aggregate topology of eight ADJUST receipts and three linked recharges', () => {
    const billingAccountId = 'ba_legacy_admin_enterprise';
    const amounts = [1, 1, 1, 1, 2, 2, 3, 4, 2, 3, 7];
    const transactions: RepairTransaction[] = [];
    const grants: RepairGrant[] = [];
    const evidence: RepairLegacyAdminFundingEvidence[] = [];
    let running = 0;
    amounts.forEach((amount, index) => {
      running += amount;
      const isRecharge = index >= 8;
      const createdAt = new Date(Date.UTC(2026, 6, 15, 11, index, 0)).toISOString();
      const transaction: RepairTransaction = {
        id: `uat-admin-funding-${index + 1}`,
        userId: 'repair-user',
        tenantId: 'repair-tenant',
        productId: null,
        tokenUsageId: null,
        type: isRecharge ? 'RECHARGE' : 'ADJUST',
        amountUsd: String(amount),
        balanceAfterUsd: String(running),
        description: '线下转账入账',
        orderId: null,
        operationKey: null,
        createdAt,
      };
      transactions.push(transaction);
      evidence.push(legacyAdminFundingEvidence(
        transaction,
        isRecharge ? 'admin:recharge' : 'admin:adjust-balance',
        billingAccountId,
        { snapshotSha256: (index + 1).toString(16).padStart(64, '0') },
      ));
      if (isRecharge) {
        const validFrom = new Date(new Date(createdAt).getTime() + 2).toISOString();
        const expiresAt = new Date(validFrom);
        expiresAt.setUTCDate(expiresAt.getUTCDate() + 365);
        grants.push({
          id: `uat-admin-grant-${index + 1}`,
          userId: 'repair-user', tenantId: 'repair-tenant', productId: null,
          orderId: null, source: 'RECHARGE', paidAmountUsd: String(amount),
          bonusAmountUsd: '0', grantedAmountUsd: String(amount),
          remainingAmountUsd: String(amount), remainingPaidAmountUsd: null,
          remainingBonusAmountUsd: null, discountRate: '1', isExpired: false,
          validFrom, expiresAt: expiresAt.toISOString(),
          createdAt: new Date(new Date(createdAt).getTime() + 4).toISOString(),
          snapshotSha256: (index + 20).toString(16).padStart(64, '0'),
        });
      }
    });
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      billingAccountId,
      accountType: 'enterprise',
      walletBalanceUsd: String(running),
      transactions,
      grants,
      legacyAdminFundingIdempotencyEvidence: evidence,
    }));

    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;
    expect(plan.legacyAdminFundingRepairs).toHaveLength(11);
    expect(plan.legacyAdminFundingRepairs.filter((row) => row.action === 'CREATE_GRANT'))
      .toHaveLength(8);
    expect(plan.legacyAdminFundingRepairs.filter((row) => row.action === 'LINK_GRANT'))
      .toHaveLength(3);
    expect(plan.legacyAdminFundingRepairs.reduce(
      (sum, row) => sum + Number(row.amountUsd), 0,
    )).toBe(27);
  });

  it('closes the observed UAT funding arithmetic with five FIFO allocation rewrites', () => {
    const plan = buildBalanceLedgerRepairPlan(
      uatLegacyAdminFundingLinkedGrantReallocationSnapshot(),
    );

    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;

    const createRepairs = plan.legacyAdminFundingRepairs.filter(
      (repair) => repair.action === 'CREATE_GRANT',
    );
    const linkRepairs = plan.legacyAdminFundingRepairs.filter(
      (repair) => repair.action === 'LINK_GRANT',
    );
    expect(plan.legacyAdminFundingRepairs).toHaveLength(11);
    expect(createRepairs).toHaveLength(8);
    expect(linkRepairs).toHaveLength(3);
    expect(createRepairs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        transactionId: 'uat-admin-adjust-1',
        amountUsd: '1.000000000000',
        initialRemainingAmountUsd: '0.841398700000',
        finalRemainingAmountUsd: '0.799202700000',
      }),
    ]));
    expect(linkRepairs).toEqual(expect.arrayContaining([
      expect.objectContaining({
        transactionId: 'uat-admin-recharge-2',
        grantId: 'uat-admin-recharge-grant-2',
        amountUsd: '2.000000000000',
        expectedGrantRemainingAmountUsd: '1.957804000000',
        finalRemainingAmountUsd: '2.000000000000',
        finalRemainingPaidAmountUsd: '2.000000000000',
        finalRemainingBonusAmountUsd: '0.000000000000',
      }),
    ]));

    expect(plan.canonicalAllocationMutations).toHaveLength(5);
    expect(new Set(plan.canonicalAllocationMutations.map(
      (mutation) => mutation.expectedBalanceGrantId,
    ))).toEqual(new Set(['uat-admin-recharge-grant-2']));
    expect(new Set(plan.canonicalAllocationMutations.map(
      (mutation) => mutation.balanceGrantId,
    ))).toEqual(new Set(['repair-enterprise-admin-funding:uat-admin-adjust-1']));
    const releasedFromLinkedGrant = plan.canonicalAllocationMutations.reduce(
      (total, mutation) => total.plus(mutation.expectedAmountUsd),
      new Prisma.Decimal(0),
    );
    const consumedFromCreateGrant = plan.canonicalAllocationMutations.reduce(
      (total, mutation) => total.plus(mutation.amountUsd),
      new Prisma.Decimal(0),
    );
    expect(releasedFromLinkedGrant.toFixed(12)).toBe('0.042196000000');
    expect(consumedFromCreateGrant.toFixed(12)).toBe('0.042196000000');

    expect(plan.grantMutations).toEqual(expect.arrayContaining([
      expect.objectContaining({
        grantId: 'uat-admin-recharge-grant-2',
        expectedRemainingAmountUsd: '1.957804000000',
        expectedRemainingPaidAmountUsd: null,
        expectedRemainingBonusAmountUsd: null,
        remainingAmountUsd: '2.000000000000',
        remainingPaidAmountUsd: '2.000000000000',
        remainingBonusAmountUsd: '0.000000000000',
      }),
    ]));
    expect(plan.walletBalanceUsd).toBe('26.799202700000');
    expect(plan.currentDebtUsd).toBe('0.000000000000');
  });

  it('quarantines the observed UAT-shaped replay when the LINK total is off by 1e-12', () => {
    const snapshot = uatLegacyAdminFundingLinkedGrantReallocationSnapshot();
    snapshot.grants[0].remainingAmountUsd = '1.957803999999';

    const plan = buildBalanceLedgerRepairPlan(snapshot);

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        'ENTERPRISE_GRANT_TOTAL_REPLAY_MISMATCH:uat-admin-recharge-grant-2',
      ]),
    }));
  });

  it.each([
    ['receipt amount tamper', (snapshot: BalanceLedgerRepairSnapshot) => {
      const result = snapshot.legacyAdminFundingIdempotencyEvidence![0].result as Record<string, unknown>;
      result.amountCents = 199;
    }, 'LEGACY_ADMIN_FUNDING_RECEIPT_TRANSACTION_MISMATCH'],
    ['receipt extra field', (snapshot: BalanceLedgerRepairSnapshot) => {
      const result = snapshot.legacyAdminFundingIdempotencyEvidence![0].result as Record<string, unknown>;
      result.unreviewed = true;
    }, 'LEGACY_ADMIN_FUNDING_RECEIPT_SCHEMA_INVALID'],
    ['foreign account key', (snapshot: BalanceLedgerRepairSnapshot) => {
      snapshot.legacyAdminFundingIdempotencyEvidence![0].key =
        'enterprise-recharge:ba_foreign:proof-legacy-admin-adjust';
    }, 'LEGACY_ADMIN_FUNDING_RECEIPT_TRANSACTION_MISMATCH'],
    ['wrong subject', (snapshot: BalanceLedgerRepairSnapshot) => {
      snapshot.legacyAdminFundingIdempotencyEvidence![0].userId = 'foreign-user';
    }, 'LEGACY_ADMIN_FUNDING_RECEIPT_TRANSACTION_MISMATCH'],
    ['wrong scope', (snapshot: BalanceLedgerRepairSnapshot) => {
      snapshot.legacyAdminFundingIdempotencyEvidence![0].scope = 'admin:issue-voucher';
    }, 'LEGACY_ADMIN_FUNDING_RECEIPT_TRANSACTION_MISMATCH'],
    ['invalid native snapshot hash', (snapshot: BalanceLedgerRepairSnapshot) => {
      snapshot.legacyAdminFundingIdempotencyEvidence![0].snapshotSha256 = 'not-a-sha';
    }, 'LEGACY_ADMIN_FUNDING_RECEIPT_TRANSACTION_MISMATCH'],
    ['zero native receipt snapshot hash', (snapshot: BalanceLedgerRepairSnapshot) => {
      snapshot.legacyAdminFundingIdempotencyEvidence![0].snapshotSha256 = '0'.repeat(64);
    }, 'LEGACY_ADMIN_FUNDING_RECEIPT_TRANSACTION_MISMATCH'],
    ['non-v0 account state', (snapshot: BalanceLedgerRepairSnapshot) => {
      snapshot.ledgerVersion = 1;
    }, 'LEGACY_ADMIN_FUNDING_PROOF_ACCOUNT_STATE_INVALID'],
    ['missing recharge receipt', (snapshot: BalanceLedgerRepairSnapshot) => {
      snapshot.legacyAdminFundingIdempotencyEvidence =
        snapshot.legacyAdminFundingIdempotencyEvidence!.filter(
          (row) => row.scope !== 'admin:recharge',
        );
    }, 'FUNDING_LEGACY_ADMIN_RECEIPT_MISSING'],
    ['missing linked grant', (snapshot: BalanceLedgerRepairSnapshot) => {
      snapshot.grants = [];
    }, 'LEGACY_ADMIN_FUNDING_LINK_GRANT_MATCH_0'],
    ['linked grant product tamper', (snapshot: BalanceLedgerRepairSnapshot) => {
      snapshot.grants[0].productId = 'other-product';
    }, 'LEGACY_ADMIN_FUNDING_LINK_GRANT_MATCH_0'],
    ['linked grant timestamp reversal', (snapshot: BalanceLedgerRepairSnapshot) => {
      snapshot.grants[0].validFrom = '2026-07-15T10:02:59.999Z';
    }, 'LEGACY_ADMIN_FUNDING_LINK_GRANT_MATCH_0'],
    ['linked grant expiry contract mismatch', (snapshot: BalanceLedgerRepairSnapshot) => {
      snapshot.grants[0].expiresAt = '2027-07-15T10:03:00.003Z';
    }, 'LEGACY_ADMIN_FUNDING_LINK_GRANT_MATCH_0'],
    ['zero native grant snapshot hash', (snapshot: BalanceLedgerRepairSnapshot) => {
      snapshot.grants[0].snapshotSha256 = '0'.repeat(64);
    }, 'LEGACY_ADMIN_FUNDING_LINK_GRANT_MATCH_0'],
  ])('quarantines legacy admin proof on %s', (_label, mutate, reasonPrefix) => {
    const snapshot = legacyAdminFundingEnterpriseSnapshot();
    mutate(snapshot);

    const plan = buildBalanceLedgerRepairPlan(snapshot);
    expect(plan.status).toBe('QUARANTINED');
    if (plan.status !== 'QUARANTINED') return;
    expect(plan.reasons.some((reason) => reason.startsWith(reasonPrefix))).toBe(true);
  });

  it('quarantines duplicate receipts and ambiguous linked grant candidates', () => {
    const duplicateReceipt = legacyAdminFundingEnterpriseSnapshot();
    duplicateReceipt.legacyAdminFundingIdempotencyEvidence!.push({
      ...duplicateReceipt.legacyAdminFundingIdempotencyEvidence![0],
      key: `${duplicateReceipt.legacyAdminFundingIdempotencyEvidence![0].key}-duplicate`,
      snapshotSha256: 'b'.repeat(64),
    });
    const duplicatePlan = buildBalanceLedgerRepairPlan(duplicateReceipt);
    expect(duplicatePlan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        'LEGACY_ADMIN_FUNDING_TRANSACTION_EVIDENCE_DUPLICATE:legacy-admin-adjust',
      ]),
    }));

    const ambiguousGrant = legacyAdminFundingEnterpriseSnapshot();
    ambiguousGrant.grants.push({
      ...ambiguousGrant.grants[0],
      id: 'legacy-admin-recharge-grant-duplicate',
    });
    const ambiguousPlan = buildBalanceLedgerRepairPlan(ambiguousGrant);
    expect(ambiguousPlan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        'LEGACY_ADMIN_FUNDING_LINK_GRANT_MATCH_2:legacy-admin-recharge',
      ]),
    }));
  });

  it('still quarantines an orphan grant through complete funding-gross replay', () => {
    const snapshot = legacyAdminFundingEnterpriseSnapshot();
    snapshot.grants.push({
      id: 'orphan-same-account-grant', userId: 'repair-user', tenantId: 'repair-tenant',
      productId: null, orderId: null, source: 'RECHARGE', paidAmountUsd: '9',
      bonusAmountUsd: '0', grantedAmountUsd: '9', remainingAmountUsd: '0',
      remainingPaidAmountUsd: '0', remainingBonusAmountUsd: '0', discountRate: '1',
      isExpired: false, validFrom: '2026-07-15T09:00:00.000Z',
      expiresAt: '2027-07-15T09:00:00.000Z', createdAt: '2026-07-15T09:00:00.001Z',
      snapshotSha256: 'd'.repeat(64),
    });

    const plan = buildBalanceLedgerRepairPlan(snapshot);
    expect(plan.status).toBe('QUARANTINED');
    if (plan.status !== 'QUARANTINED') return;
    expect(plan.reasons).toEqual(expect.arrayContaining([
      expect.stringContaining('CANONICAL_FUNDING_GROSS_MISMATCH:orphan-same-account-grant:'),
    ]));
  });


  it('quarantines an otherwise open debt row with a non-zero discount', () => {
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      walletBalanceUsd: '-1',
      transactions: [{
        id: 'consume', type: 'CONSUME', amountUsd: '-1', balanceAfterUsd: '-1',
        description: 'usage', orderId: null, createdAt: '2026-07-15T10:00:00.000Z',
      }],
      allocations: [{
        id: 'debt', balanceTransactionId: 'consume', balanceGrantId: null,
        source: 'NEGATIVE_BALANCE', amountUsd: '1', recognizedRevenueUsd: '0',
        bonusConsumedUsd: '0', discountRate: '0.5', settledUsd: '0', settledAt: null,
        ledgerSequence: '1', createdAt: '2026-07-15T10:00:00.000Z',
      }],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining([
        'DEBT_ALLOCATION_DISCOUNT_INVALID:debt:0.500000000000',
      ]),
    }));
  });

  it('quarantines a grant whose gross discount disagrees with paid/granted', () => {
    const createdAt = '2026-07-15T10:00:00.000Z';
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      walletBalanceUsd: '1',
      transactions: [{
        id: 'recharge', type: 'RECHARGE', amountUsd: '1', balanceAfterUsd: '1',
        description: 'recharge', orderId: 'order-1',
        operationKey: 'balance:recharge:order-1:paid', createdAt,
      }],
      grants: [{
        id: 'grant', orderId: 'order-1', source: 'RECHARGE', paidAmountUsd: '1',
        bonusAmountUsd: '0', grantedAmountUsd: '1', remainingAmountUsd: '1',
        remainingPaidAmountUsd: '1', remainingBonusAmountUsd: '0', discountRate: '0.5',
        isExpired: false, validFrom: createdAt, expiresAt: null, createdAt,
      }],
    }));

    expect(plan).toEqual(expect.objectContaining({
      status: 'QUARANTINED',
      reasons: expect.arrayContaining(['GRANT_GROSS_COMPONENTS_INVALID:grant']),
    }));
  });

  it('binds every approved mutation into the canonical replay hash', () => {
    const plan = buildBalanceLedgerRepairPlan(baseSnapshot({
      walletBalanceUsd: '1',
      transactions: [{
        id: 'recharge', type: 'RECHARGE', amountUsd: '1', balanceAfterUsd: '1',
        description: 'recharge', orderId: 'order', createdAt: '2026-07-15T10:00:00.000Z',
      }],
      grants: [{
        id: 'grant', orderId: 'order', source: 'RECHARGE', paidAmountUsd: '1',
        bonusAmountUsd: '0', grantedAmountUsd: '1', remainingAmountUsd: '1', remainingPaidAmountUsd: null,
        remainingBonusAmountUsd: null, discountRate: '1', isExpired: false,
        createdAt: '2026-07-15T10:00:00.000Z',
      }],
    }));
    expect(plan.status).toBe('READY');
    if (plan.status !== 'READY') return;

    const tampered = {
      ...plan,
      grantMutations: plan.grantMutations.map((mutation) => ({
        ...mutation,
        remainingAmountUsd: '0.000000000000',
      })),
    };
    const tamperedSequence = {
      ...plan,
      transactionSequenceMutations: plan.transactionSequenceMutations.map((mutation) => ({
        ...mutation,
        ledgerSequence: '-999',
      })),
    };
    expect(balanceLedgerRepairReplayHash(plan)).toBe(plan.replayHash);
    expect(balanceLedgerRepairReplayHash(tampered)).not.toBe(plan.replayHash);
    expect(balanceLedgerRepairReplayHash(tamperedSequence)).not.toBe(plan.replayHash);
  });
});
