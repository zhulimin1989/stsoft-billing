import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import {
  assertExecutionProfilePlanSet,
  assertExecutionProfileSelectors,
  assertEnterpriseVerifiedAllocationMutations,
  assertMaintenanceSnapshot,
  assertResumeRunInitiator,
  buildRepairAccountBeforeManifest,
  buildRepairFailureManifest,
  databaseEndpointSha256,
  invoiceEvidenceClosureIsValid,
  maintenanceInvoiceEvidenceMatches,
  parseRepairPlanFile,
  parseRepairPlanManifest,
  repairAuditJsonWithLimit,
  resolveExecutionProfile,
  resolveRepairInitiator,
  resolveVoucherApprovalRefs,
} from '../../scripts/reconcile-personal-balance-ledger';
import {
  BalanceLedgerRepairPlan,
  BalanceLedgerRepairSnapshot,
  balanceLedgerRepairReplayHash,
} from './balance-ledger-repair';

const manifest = {
  recordType: 'BALANCE_LEDGER_REPAIR_PLAN_V9',
  databaseName: 'billing_test',
  databaseIdentity: '4a609d5a-62a2-4d38-85f7-306153258b0f',
  databaseSystemIdentifier: '7432769159580659830',
  databaseOid: '16384',
  phase: 'V2_CONTRACT',
  endpointSha256: 'a'.repeat(64),
  maintenanceProfile: null,
} as const;

const quarantinedPlan = {
  status: 'QUARANTINED',
  billingAccountId: 'account-1',
  preconditionHash: 'b'.repeat(64),
  reasons: ['MANUAL_REVIEW'],
} as const;

function maintenanceInvoiceSnapshot(): BalanceLedgerRepairSnapshot {
  const invoiceItems: BalanceLedgerRepairSnapshot['invoiceItems'] = [{
    id: 'subject-item-1',
    orderId: 'subject-order-1',
    principalCents: 100,
    description: 'RAYTONE_API',
    applicationId: 'application-1',
    applicationUserId: 'user-1',
    applicationTenantId: 'tenant-1',
    applicationStatus: 'ISSUED',
    invoiceNumber: 'INV-1',
    issuingEntity: 'RAYTONE',
    issueDate: '2026-07-01T00:00:00.000Z',
    dueDate: '2026-07-31T00:00:00.000Z',
    issuedAt: '2026-07-01T00:00:01.000Z',
    pdfUrl: 'https://example.invalid/invoice-1.pdf',
    ofdUrl: null,
    hasIssuedLifecycleEvent: true,
  }];
  return {
    billingAccountId: 'account-1',
    accountType: 'personal',
    ledgerStatus: 'LEGACY_DIRTY',
    ledgerVersion: 0,
    walletBalanceUsd: '0.000000000000',
    transactions: [{
      id: 'funding-transaction-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      productId: null,
      type: 'RECHARGE',
      amountUsd: '1.000000000000',
      balanceAfterUsd: '1.000000000000',
      description: 'recharge',
      orderId: 'subject-order-1',
      tokenUsageId: null,
      operationKey: 'balance:recharge:subject-order-1',
      ledgerSequence: null,
      createdAt: '2026-07-01T00:00:00.000Z',
    }],
    grants: [],
    allocations: [],
    settlements: [],
    orders: [{
      id: 'subject-order-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      billingAccountId: 'account-1',
      productId: null,
      orderType: 'RECHARGE',
      status: 'COMPLETED',
      amountCents: 100,
      bonusCents: 0,
      currency: 'cny',
      paidAt: '2026-07-01T00:00:00.000Z',
      completedAt: '2026-07-01T00:00:00.000Z',
      refundedAt: null,
      refundAmountCents: null,
      createdAt: '2026-07-01T00:00:00.000Z',
    }],
    invoiceItems,
    invoiceEvidence: {
      orderIds: ['subject-order-1'],
      applicationIds: ['application-1'],
      itemIds: ['subject-item-1'],
      eventIds: ['issued-event-1'],
      invoiceItemCount: 1,
      unsafeInvoiceItemCount: 1,
      invalidApplicationCount: 0,
      snapshotSha256: 'a'.repeat(64),
      snapshot: {
        orders: [{
          id: 'subject-order-1',
          user_id: 'user-1',
          tenant_id: 'tenant-1',
          billing_account_id: 'account-1',
          order_type: 'RECHARGE',
          amount_cents: 100,
          bonus_cents: 0,
          currency: 'cny',
          status: 'COMPLETED',
          created_at: '2026-07-01T00:00:00.000Z',
        }],
        applications: [{
          id: 'application-1',
          application_no: 'APP-1',
          user_id: 'user-1',
          tenant_id: 'tenant-1',
          profile_id: null,
          profile_snapshot: { title: 'Reviewed profile' },
          currency: 'cny',
          subtotal_cents: 100,
          tax_amount_cents: 0,
          total_cents: 100,
          status: 'ISSUED',
          issuing_entity: 'RAYTONE',
          invoice_number: 'INV-1',
          issue_date: '2026-07-01T00:00:00.000Z',
          due_date: '2026-07-31T00:00:00.000Z',
          issued_at: '2026-07-01T00:00:01.000Z',
          pdf_url: 'https://example.invalid/invoice-1.pdf',
          ofd_url: null,
          reject_reason: null,
          void_reason: null,
          failed_reason: null,
          reviewed_by: 'admin-1',
          reviewed_at: '2026-07-01T00:00:00.500Z',
          idempotency_key: 'invoice:application-1',
          created_at: '2026-07-01T00:00:00.000Z',
          updated_at: '2026-07-01T00:00:01.000Z',
        }],
        items: [{
          id: 'subject-item-1',
          application_id: 'application-1',
          order_id: 'subject-order-1',
          principal_cents: 100,
          description: 'RAYTONE_API',
          product_name: 'API',
          service_start: null,
          service_end: null,
          po_number: null,
          created_at: '2026-07-01T00:00:00.000Z',
        }],
        events: [{
          id: 'issued-event-1',
          application_id: 'application-1',
          from_status: 'APPROVED_ISSUING',
          to_status: 'ISSUED',
          actor_type: 'ADMIN',
          actor_id: 'admin-1',
          reason: null,
          metadata: null,
          occurred_at: '2026-07-01T00:00:01.000Z',
        }],
      },
    },
    voucherIdempotencyEvidence: [],
    expiryAuditCount: 0,
  };
}

function personalDebtReadyPlan() {
  const expectedSourceAllocation = {
    id: 'legacy-source-allocation',
    billingAccountId: 'personal-account',
    userId: 'personal-user',
    tenantId: 'personal-tenant',
    productId: null,
    balanceTransactionId: 'legacy-consume',
    tokenUsageId: 'legacy-usage',
    balanceGrantId: 'legacy-grant',
    source: 'BALANCE_GRANT',
    amountUsd: '1.000000000000',
    recognizedRevenueUsd: '1.000000000000',
    bonusConsumedUsd: '0.000000000000',
    discountRate: '1.000000000000',
    settledUsd: '0.000000000000',
    settledAt: null,
    ledgerSequence: null,
    createdAt: '2026-07-15T10:00:00.001Z',
  } as const;
  const hashInput = {
    status: 'READY' as const,
    billingAccountId: 'personal-account',
    accountType: 'personal' as const,
    debtSource: 'NEGATIVE_BALANCE' as const,
    settlementWriteMode: 'CREATE' as const,
    expectedSettlementCount: 0,
    preconditionHash: 'd'.repeat(64),
    walletBalanceUsd: '-0.600000000000',
    currentDebtUsd: '0.600000000000',
    legacySettledDebtUsd: '0.000000000000',
    activeGrantDriftUsd: '0.000000000000',
    throughTransactionId: 'legacy-consume',
    transactionSequenceMutations: [],
    grantMutations: [],
    allocationMutations: [],
    allocationSequenceMutations: [],
    unreconciledGrantMutations: [],
    canonicalAllocationMutations: [],
    migrationOpeningDebtMutations: [],
    personalDebtAllocationMutations: [{
      proofVersion: 1 as const,
      repairKind: 'LEGACY_DEBT_SPLIT_V1' as const,
      transactionId: 'legacy-consume',
      sourceAllocationId: 'legacy-source-allocation',
      createdDebtAllocationId: 'repair-negative-balance-split:legacy-source-allocation',
      expectedTransactionBeforeUsd: '0.400000000000',
      expectedTransactionAfterUsd: '-0.600000000000',
      expectedSourceAllocation,
      targetSourceAllocation: {
        ...expectedSourceAllocation,
        amountUsd: '0.400000000000',
        recognizedRevenueUsd: '0.400000000000',
        ledgerSequence: '-2',
      },
      targetDebtAllocation: {
        ...expectedSourceAllocation,
        id: 'repair-negative-balance-split:legacy-source-allocation',
        balanceGrantId: null,
        source: 'NEGATIVE_BALANCE',
        amountUsd: '0.600000000000',
        recognizedRevenueUsd: '0.000000000000',
        discountRate: '0.000000000000',
        ledgerSequence: '-1',
      },
    }],
    legacyVoucherProofMutations: [],
    legacyExpiryProofMutations: [],
    invoiceStabilityProof: null,
    legacyAdminFundingRepairs: [],
    settlementMutations: [],
  };
  return {
    ...hashInput,
    replayHash: balanceLedgerRepairReplayHash(hashInput),
  };
}

function voucherReadyPlan() {
  const base = personalDebtReadyPlan();
  const hashInput = {
    ...base,
    throughTransactionId: 'voucher-transaction',
    personalDebtAllocationMutations: [],
    legacyVoucherProofMutations: [{
      proofVersion: 1 as const,
      repairKind: 'LEGACY_PRE_IDEMPOTENCY_VOUCHER_V1' as const,
      transactionId: 'voucher-transaction',
      grantId: 'voucher-grant',
      walletBeforeUsd: '0.000000000000',
      walletAfterUsd: '100.000000000000',
      holeFillUsd: '0.000000000000',
      mintedGrantAmountUsd: '100.000000000000',
      expectedTransaction: {
        id: 'voucher-transaction',
        userId: 'personal-user',
        tenantId: 'personal-tenant',
        productId: null,
        type: 'ADJUST',
        amountUsd: '100.000000000000',
        balanceAfterUsd: '100.000000000000',
        description: 'voucher:voucher-grant admin:operator',
        orderId: null,
        tokenUsageId: null,
        operationKey: null,
        ledgerSequence: '-1',
        createdAt: '2026-07-15T10:00:00.001Z',
      },
      expectedGrant: {
        id: 'voucher-grant',
        userId: 'personal-user',
        tenantId: 'personal-tenant',
        productId: null,
        orderId: null,
        source: 'VOUCHER',
        paidAmountUsd: '0.000000000000',
        bonusAmountUsd: '100.000000000000',
        grantedAmountUsd: '100.000000000000',
        remainingAmountUsd: '100.000000000000',
        remainingPaidAmountUsd: null,
        remainingBonusAmountUsd: null,
        discountRate: '0.000000000000',
        isExpired: false,
        validFrom: '2026-07-15T10:00:00.000Z',
        expiresAt: '2027-07-15T10:00:00.000Z',
        createdAt: '2026-07-15T10:00:00.001Z',
      },
      expectedIdempotencyEvidence: [],
      openingDebtAllocationIds: [],
    }],
  };
  return {
    ...hashInput,
    replayHash: balanceLedgerRepairReplayHash(hashInput),
  };
}

function invoiceStabilityReadyPlan() {
  const base = personalDebtReadyPlan();
  const hashInput = {
    ...base,
    invoiceStabilityProof: {
      proofVersion: 1 as const,
      repairKind: 'ISSUED_INVOICE_STABILITY_V1' as const,
      orderCount: 1,
      applicationCount: 1,
      itemCount: 1,
      eventCount: 1,
      evidenceSha256: 'e'.repeat(64),
    },
  };
  return {
    ...hashInput,
    replayHash: balanceLedgerRepairReplayHash(hashInput),
  };
}

function legacyExpiryReadyPlan() {
  const base = personalDebtReadyPlan();
  const expectedTransaction = {
    id: 'legacy-expiry-transaction',
    userId: 'personal-user',
    tenantId: 'personal-tenant',
    productId: null,
    type: 'ADJUST',
    amountUsd: '-0.200000000000',
    balanceAfterUsd: '0.000000000000',
    description: 'balance grant expired:legacy-expiry-grant',
    orderId: null,
    tokenUsageId: null,
    operationKey: null,
    ledgerSequence: null,
    createdAt: '2026-07-15T10:02:00.000Z',
  } as const;
  const expectedGrant = {
    id: 'legacy-expiry-grant',
    userId: 'personal-user',
    tenantId: 'personal-tenant',
    productId: null,
    orderId: null,
    source: 'RECHARGE',
    paidAmountUsd: '1.000000000000',
    bonusAmountUsd: '0.000000000000',
    grantedAmountUsd: '1.000000000000',
    remainingAmountUsd: '0.000000000000',
    remainingPaidAmountUsd: null,
    remainingBonusAmountUsd: null,
    discountRate: '1.000000000000',
    isExpired: true,
    validFrom: '2026-07-15T10:00:00.000Z',
    expiresAt: '2026-07-15T10:02:00.000Z',
    createdAt: '2026-07-15T10:00:00.000Z',
  } as const;
  const hashInput = {
    ...base,
    legacyExpiryProofMutations: [{
      proofVersion: 1 as const,
      repairKind: 'LEGACY_INLINE_EXPIRY_V1' as const,
      grantId: expectedGrant.id,
      transactionId: expectedTransaction.id,
      expiryAuditId: `repair-legacy-expiry:${expectedGrant.id}`,
      nominalAmountUsd: '0.200000000000',
      nominalPaidUsd: '0.200000000000',
      nominalBonusUsd: '0.000000000000',
      walletBalanceBeforeUsd: '0.200000000000',
      walletBalanceAfterUsd: '0.000000000000',
      expectedTransaction,
      expectedGrant,
    }],
  };
  return {
    ...hashInput,
    replayHash: balanceLedgerRepairReplayHash(hashInput),
  };
}

function expiredVoucherReadyPlan() {
  const base = legacyExpiryReadyPlan();
  const expiryMutation = base.legacyExpiryProofMutations[0];
  const expectedGrant = {
    ...expiryMutation.expectedGrant,
    source: 'VOUCHER' as const,
    paidAmountUsd: '0.000000000000',
    bonusAmountUsd: '1.000000000000',
    grantedAmountUsd: '1.000000000000',
    discountRate: '0.000000000000',
  };
  const hashInput = {
    ...base,
    legacyVoucherProofMutations: [{
      proofVersion: 1 as const,
      repairKind: 'LEGACY_PRE_IDEMPOTENCY_EXPIRED_VOUCHER_V1' as const,
      transactionId: 'legacy-expired-voucher-funding',
      grantId: expectedGrant.id,
      walletBeforeUsd: '10.000000000000',
      walletAfterUsd: '11.000000000000',
      holeFillUsd: '0.000000000000',
      mintedGrantAmountUsd: '1.000000000000',
      expectedTransaction: {
        id: 'legacy-expired-voucher-funding',
        userId: 'personal-user',
        tenantId: 'personal-tenant',
        productId: null,
        type: 'ADJUST',
        amountUsd: '1.000000000000',
        balanceAfterUsd: '11.000000000000',
        description: `voucher:${expectedGrant.id} admin:operator historical voucher`,
        orderId: null,
        tokenUsageId: null,
        operationKey: null,
        ledgerSequence: null,
        createdAt: '2026-07-15T10:00:00.004Z',
      },
      expectedGrant,
      expectedIdempotencyEvidence: [],
      openingDebtAllocationIds: [],
    }],
    legacyExpiryProofMutations: [{
      ...expiryMutation,
      nominalPaidUsd: '0.000000000000',
      nominalBonusUsd: '0.200000000000',
      expectedGrant,
    }],
  };
  return {
    ...hashInput,
    replayHash: balanceLedgerRepairReplayHash(hashInput),
  };
}

describe('reconcile personal balance ledger plan envelope', () => {
  it('resolves only explicit maintenance profiles with their narrow proof permissions', () => {
    expect(resolveExecutionProfile(undefined)).toEqual({
      name: null,
      expectedDatabase: null,
      billingAccountIds: null,
      planningProfile: {
        allowLegacyExpiryProofs: false,
        allowLegacyExpiredVoucherProofs: false,
        allowInvoiceStabilityProof: false,
      },
    });

    expect(resolveExecutionProfile('hk-uat-two-account-20260722')).toEqual({
      name: 'hk-uat-two-account-20260722',
      expectedDatabase: {
        databaseName: 'ruidong_billing',
        databaseIdentity: '940d3ca6-2513-47cd-9e95-f0e9b5f79225',
      },
      billingAccountIds: [
        'ba_personal_c912db97-626d-4d9c-9f8a-fec97cc3670f',
        'ba_personal_c9afd0f8-a0eb-42c9-a9ff-499fa1999b2d',
      ],
      planningProfile: {
        allowLegacyExpiryProofs: true,
        allowLegacyExpiredVoucherProofs: true,
        allowInvoiceStabilityProof: true,
      },
    });

    expect(resolveExecutionProfile('hk-uat-remaining-account-20260722')).toEqual({
      name: 'hk-uat-remaining-account-20260722',
      expectedDatabase: {
        databaseName: 'ruidong_billing',
        databaseIdentity: '940d3ca6-2513-47cd-9e95-f0e9b5f79225',
      },
      billingAccountIds: [
        'ba_personal_c9afd0f8-a0eb-42c9-a9ff-499fa1999b2d',
      ],
      planningProfile: {
        allowLegacyExpiryProofs: true,
        allowLegacyExpiredVoucherProofs: true,
        allowInvoiceStabilityProof: true,
      },
    });

    expect(resolveExecutionProfile('invoice-stability-evidence-v1')).toEqual({
      name: 'invoice-stability-evidence-v1',
      expectedDatabase: null,
      billingAccountIds: null,
      planningProfile: {
        allowLegacyExpiryProofs: false,
        allowLegacyExpiredVoucherProofs: false,
        allowInvoiceStabilityProof: true,
      },
    });

    expect(() => resolveExecutionProfile('hk-uat-unreviewed-account')).toThrow(
      'unknown maintenance profile: hk-uat-unreviewed-account',
    );
  });

  it('bounds the generic invoice profile to one explicitly selected account', () => {
    const profile = resolveExecutionProfile('invoice-stability-evidence-v1');
    expect(() => assertExecutionProfileSelectors(profile, {
      billingAccountId: 'account-1',
    })).not.toThrow();
    expect(() => assertExecutionProfileSelectors(profile, {})).toThrow(
      'requires --billing-account-id',
    );
    for (const selectors of [
      { billingAccountId: 'account-1', accountType: 'personal' },
      { billingAccountId: 'account-1', limit: '1' },
      { billingAccountId: 'account-1', cursorAfter: 'account-0' },
    ]) {
      expect(() => assertExecutionProfileSelectors(profile, selectors)).toThrow(
        'accepts only --billing-account-id',
      );
    }

    expect(resolveRepairInitiator(profile, ' operator@example.com ')).toBe(
      'operator@example.com',
    );
    expect(() => resolveRepairInitiator(profile, undefined)).toThrow(
      'requires --initiated-by',
    );
    expect(() => resolveRepairInitiator(profile, ' '.repeat(2))).toThrow(
      'requires --initiated-by',
    );
    expect(() => resolveRepairInitiator(profile, 'x'.repeat(201))).toThrow(
      '1..200',
    );
    expect(() => assertResumeRunInitiator(
      profile,
      'operator@example.com',
      'operator@example.com',
    )).not.toThrow();
    expect(() => assertResumeRunInitiator(
      profile,
      'second-operator@example.com',
      'operator@example.com',
    )).toThrow('does not exactly match the original repair run');
    expect(() => assertResumeRunInitiator(
      profile,
      'operator@example.com',
      null,
    )).toThrow('does not exactly match the original repair run');
  });

  it('accepts only the selected READY invoice proof plan for the generic profile', () => {
    const profile = resolveExecutionProfile('invoice-stability-evidence-v1');
    const plan = invoiceStabilityReadyPlan();
    expect(() => assertExecutionProfilePlanSet(
      profile,
      plan.billingAccountId,
      [plan],
    )).not.toThrow();
    expect(() => assertExecutionProfilePlanSet(profile, 'other-account', [plan])).toThrow(
      'INVOICE_STABILITY_PROFILE_PLAN_SET_MISMATCH',
    );
    expect(() => assertExecutionProfilePlanSet(
      profile,
      plan.billingAccountId,
      [plan, plan],
    )).toThrow('INVOICE_STABILITY_PROFILE_PLAN_SET_MISMATCH');
    expect(() => assertExecutionProfilePlanSet(
      profile,
      plan.billingAccountId,
      [personalDebtReadyPlan()],
    )).toThrow('INVOICE_STABILITY_PROFILE_PLAN_SET_MISMATCH');
    expect(() => assertExecutionProfilePlanSet(
      profile,
      quarantinedPlan.billingAccountId,
      [{ ...quarantinedPlan, reasons: [...quarantinedPlan.reasons] }],
    )).toThrow('INVOICE_STABILITY_PROFILE_PLAN_SET_MISMATCH');

    const adminFundingPlan = {
      ...plan,
      legacyAdminFundingRepairs: [{}],
    } as unknown as BalanceLedgerRepairPlan;
    const prohibitedProofPlans: BalanceLedgerRepairPlan[] = [
      {
        ...plan,
        legacyVoucherProofMutations: voucherReadyPlan().legacyVoucherProofMutations,
      },
      {
        ...plan,
        legacyExpiryProofMutations: legacyExpiryReadyPlan().legacyExpiryProofMutations,
      },
      adminFundingPlan,
    ];
    for (const prohibitedProofPlan of prohibitedProofPlans) {
      expect(() => assertExecutionProfilePlanSet(
        profile,
        plan.billingAccountId,
        [prohibitedProofPlan],
      )).toThrow('INVOICE_STABILITY_PROFILE_PLAN_SET_MISMATCH');
    }
  });

  it('accepts only a canonical database-bound LF JSONL envelope', () => {
    const raw = `${JSON.stringify(manifest)}\n${JSON.stringify(quarantinedPlan)}\n`;

    expect(parseRepairPlanFile(raw)).toEqual({
      manifest,
      plans: [quarantinedPlan],
    });
    expect(() => parseRepairPlanFile(raw.slice(0, -1))).toThrow(
      'canonical LF-terminated JSONL',
    );
    expect(() => parseRepairPlanFile(raw.replace('\n', '\r\n'))).toThrow(
      'canonical LF-terminated JSONL',
    );
    expect(() => parseRepairPlanFile(raw.replace('\n', '\n\n'))).toThrow(
      'empty JSONL record',
    );
  });

  it('rejects pre-V9 approvals, unknown fields, and invalid physical locators', () => {
    for (const recordType of [
      'BALANCE_LEDGER_REPAIR_PLAN_V1',
      'BALANCE_LEDGER_REPAIR_PLAN_V2',
      'BALANCE_LEDGER_REPAIR_PLAN_V3',
      'BALANCE_LEDGER_REPAIR_PLAN_V4',
      'BALANCE_LEDGER_REPAIR_PLAN_V5',
      'BALANCE_LEDGER_REPAIR_PLAN_V6',
      'BALANCE_LEDGER_REPAIR_PLAN_V7',
      'BALANCE_LEDGER_REPAIR_PLAN_V8',
    ]) {
      expect(() => parseRepairPlanManifest(JSON.stringify({
        ...manifest,
        recordType,
      }))).toThrow('invalid database binding fields');
    }
    expect(() => parseRepairPlanManifest(JSON.stringify({
      ...manifest,
      ignored: true,
    }))).toThrow('unknown fields');
    expect(() => parseRepairPlanManifest(JSON.stringify({
      ...manifest,
      databaseOid: '4294967296',
    }))).toThrow('invalid database binding fields');
    expect(() => parseRepairPlanManifest(JSON.stringify({
      ...manifest,
      databaseIdentity: 'not-a-uuid',
    }))).toThrow('invalid database binding fields');
  });

  it('accepts only reviewed maintenance profile names in the V9 manifest', () => {
    const twoAccountManifest = {
      ...manifest,
      maintenanceProfile: 'hk-uat-two-account-20260722',
    } as const;
    const remainingAccountManifest = {
      ...manifest,
      maintenanceProfile: 'hk-uat-remaining-account-20260722',
    } as const;
    const invoiceStabilityManifest = {
      ...manifest,
      maintenanceProfile: 'invoice-stability-evidence-v1',
    } as const;

    expect(parseRepairPlanManifest(JSON.stringify(twoAccountManifest))).toEqual(
      twoAccountManifest,
    );
    expect(parseRepairPlanManifest(JSON.stringify(remainingAccountManifest))).toEqual(
      remainingAccountManifest,
    );
    expect(parseRepairPlanManifest(JSON.stringify(invoiceStabilityManifest))).toEqual(
      invoiceStabilityManifest,
    );
    expect(() => parseRepairPlanManifest(JSON.stringify({
      ...manifest,
      maintenanceProfile: 'hk-uat-unreviewed-account',
    }))).toThrow('invalid database binding fields');
  });

  it('fingerprints the endpoint without binding a repair plan to credentials', () => {
    const previousDatabaseUrl = process.env.DATABASE_URL;
    const previousBillingDatabaseUrl = process.env.BILLING_DATABASE_URL;
    try {
      delete process.env.BILLING_DATABASE_URL;
      process.env.DATABASE_URL = 'postgresql://alice:first@DB.EXAMPLE:5432/billing?sslmode=require&schema=public';
      const first = databaseEndpointSha256();
      process.env.DATABASE_URL = 'postgres://bob:second@db.example/billing?schema=public&sslmode=require';
      expect(databaseEndpointSha256()).toBe(first);
      process.env.DATABASE_URL = 'postgresql://bob:second@db.example/another?schema=public&sslmode=require';
      expect(databaseEndpointSha256()).not.toBe(first);
    } finally {
      if (previousDatabaseUrl === undefined) delete process.env.DATABASE_URL;
      else process.env.DATABASE_URL = previousDatabaseUrl;
      if (previousBillingDatabaseUrl === undefined) delete process.env.BILLING_DATABASE_URL;
      else process.env.BILLING_DATABASE_URL = previousBillingDatabaseUrl;
    }
  });

  it('accepts only the exact reviewed invoice evidence snapshot', () => {
    const snapshot = maintenanceInvoiceSnapshot();
    const evidence = snapshot.invoiceEvidence!;
    const expectedEvidenceSha256 = evidence.snapshotSha256;
    expect(maintenanceInvoiceEvidenceMatches(snapshot, expectedEvidenceSha256)).toBe(true);

    const databaseSnapshot = evidence.snapshot as Record<string, unknown> & {
      applications: Array<Record<string, unknown>>;
      events: Array<Record<string, unknown>>;
    };

    const lifecycleAdvanced: BalanceLedgerRepairSnapshot = {
      ...snapshot,
      invoiceItems: snapshot.invoiceItems.map((item) => ({
        ...item,
        applicationStatus: 'RED_OFFSET',
        pdfUrl: null,
        ofdUrl: 'https://example.invalid/invoice-1.ofd',
      })),
      invoiceEvidence: {
        ...evidence,
        eventIds: ['issued-event-1', 'red-offset-event-1'],
        snapshotSha256: 'b'.repeat(64),
        snapshot: {
          ...databaseSnapshot,
          applications: databaseSnapshot.applications.map((application) => ({
            ...application,
            status: 'RED_OFFSET',
            pdf_url: null,
            ofd_url: 'https://example.invalid/invoice-1.ofd',
            void_reason: 'red offset',
            updated_at: '2026-07-02T00:00:00.000Z',
          })),
          events: [
            ...databaseSnapshot.events,
            {
              id: 'red-offset-event-1',
              application_id: 'application-1',
              from_status: 'ISSUED',
              to_status: 'RED_OFFSET',
              actor_type: 'ADMIN',
              actor_id: 'admin-1',
              reason: 'red offset',
              metadata: null,
              occurred_at: '2026-07-02T00:00:00.000Z',
            },
          ],
        },
      },
    };
    expect(invoiceEvidenceClosureIsValid(lifecycleAdvanced)).toBe(true);
    expect(() => assertMaintenanceSnapshot(
      resolveExecutionProfile('invoice-stability-evidence-v1'),
      lifecycleAdvanced,
    )).not.toThrow();
    expect(maintenanceInvoiceEvidenceMatches(
      lifecycleAdvanced,
      expectedEvidenceSha256,
    )).toBe(false);

    const voided: BalanceLedgerRepairSnapshot = {
      ...snapshot,
      invoiceItems: snapshot.invoiceItems.map((item) => ({
        ...item,
        applicationStatus: 'VOIDED',
      })),
      invoiceEvidence: {
        ...evidence,
        eventIds: ['issued-event-1', 'voided-event-1'],
        snapshotSha256: 'c'.repeat(64),
        snapshot: {
          ...databaseSnapshot,
          applications: databaseSnapshot.applications.map((application) => ({
            ...application,
            status: 'VOIDED',
            void_reason: 'reviewed void',
            updated_at: '2026-07-03T00:00:00.000Z',
          })),
          events: [
            ...databaseSnapshot.events,
            {
              id: 'voided-event-1',
              application_id: 'application-1',
              from_status: 'ISSUED',
              to_status: 'VOIDED',
              actor_type: 'ADMIN',
              actor_id: 'admin-1',
              reason: 'reviewed void',
              metadata: null,
              occurred_at: '2026-07-03T00:00:00.000Z',
            },
          ],
        },
      },
    };
    expect(invoiceEvidenceClosureIsValid(voided)).toBe(true);
    expect(() => assertMaintenanceSnapshot(
      resolveExecutionProfile('invoice-stability-evidence-v1'),
      voided,
    )).not.toThrow();
  });

  it('validates a generic invoice closure without binding it to a reviewed account hash', () => {
    const profile = resolveExecutionProfile('invoice-stability-evidence-v1');
    const snapshot = maintenanceInvoiceSnapshot();
    expect(invoiceEvidenceClosureIsValid(snapshot)).toBe(true);
    expect(() => assertMaintenanceSnapshot(profile, snapshot)).not.toThrow();

    const noUnsafeInvoice: BalanceLedgerRepairSnapshot = {
      ...snapshot,
      invoiceItems: snapshot.invoiceItems.map((item) => ({
        ...item,
        applicationStatus: 'FAILED',
        invoiceNumber: null,
        issueDate: null,
        dueDate: null,
        issuedAt: null,
        pdfUrl: null,
        ofdUrl: null,
        hasIssuedLifecycleEvent: false,
      })),
      invoiceEvidence: {
        ...snapshot.invoiceEvidence!,
        unsafeInvoiceItemCount: 0,
      },
    };
    expect(invoiceEvidenceClosureIsValid(noUnsafeInvoice)).toBe(false);
    expect(() => assertMaintenanceSnapshot(profile, noUnsafeInvoice)).toThrow(
      'INVOICE_STABILITY_PROFILE_EVIDENCE_MISMATCH:account-1',
    );
    expect(() => assertMaintenanceSnapshot(
      profile,
      { ...snapshot, billingAccountId: 'other-account' },
    )).toThrow('INVOICE_STABILITY_PROFILE_EVIDENCE_MISMATCH:other-account');
  });

  it('rejects equal-count invoice closure replacement and cross-account reuse', () => {
    const snapshot = maintenanceInvoiceSnapshot();
    const evidence = snapshot.invoiceEvidence!;
    const expectedEvidenceSha256 = evidence.snapshotSha256;
    const databaseSnapshot = evidence.snapshot as Record<string, unknown> & {
      items: Array<Record<string, unknown>>;
    };
    const replaced: BalanceLedgerRepairSnapshot = {
      ...snapshot,
      invoiceItems: snapshot.invoiceItems.map((item) => ({
        ...item,
        id: 'attacker-replacement-item',
      })),
      invoiceEvidence: {
        ...evidence,
        itemIds: ['attacker-replacement-item'],
        snapshotSha256: 'b'.repeat(64),
        snapshot: {
          ...databaseSnapshot,
          items: databaseSnapshot.items.map((item) => ({
            ...item,
            id: 'attacker-replacement-item',
          })),
        },
      },
    };
    expect(maintenanceInvoiceEvidenceMatches(replaced, expectedEvidenceSha256)).toBe(false);
    expect(maintenanceInvoiceEvidenceMatches(
      { ...snapshot, billingAccountId: 'other-account' },
      expectedEvidenceSha256,
    )).toBe(false);
  });

  it('rejects cross-owner and financial-field disagreement inside the closure', () => {
    const snapshot = maintenanceInvoiceSnapshot();
    const evidence = snapshot.invoiceEvidence!;
    const expectedEvidenceSha256 = evidence.snapshotSha256;
    const databaseSnapshot = evidence.snapshot as Record<string, unknown> & {
      applications: Array<Record<string, unknown>>;
      items: Array<Record<string, unknown>>;
    };
    expect(maintenanceInvoiceEvidenceMatches({
      ...snapshot,
      invoiceEvidence: {
        ...evidence,
        snapshot: {
          ...databaseSnapshot,
          applications: databaseSnapshot.applications.map((application) => ({
            ...application,
            user_id: 'other-user',
          })),
        },
      },
    }, expectedEvidenceSha256)).toBe(false);
    expect(maintenanceInvoiceEvidenceMatches({
      ...snapshot,
      invoiceEvidence: {
        ...evidence,
        snapshot: {
          ...databaseSnapshot,
          items: databaseSnapshot.items.map((item) => ({
            ...item,
            principal_cents: 101,
          })),
        },
      },
    }, expectedEvidenceSha256)).toBe(false);
    expect(maintenanceInvoiceEvidenceMatches({
      ...snapshot,
      invoiceEvidence: {
        ...evidence,
        snapshot: {
          ...databaseSnapshot,
          applications: databaseSnapshot.applications.map((application) => ({
            ...application,
            invoice_number: 'REPLACED-INVOICE',
          })),
        },
      },
    }, expectedEvidenceSha256)).toBe(false);
  });

  it('requires the ORM subject set to agree with valid database invoice evidence', () => {
    const snapshot = maintenanceInvoiceSnapshot();
    const evidence = snapshot.invoiceEvidence!;
    const expectedEvidenceSha256 = evidence.snapshotSha256;
    expect(maintenanceInvoiceEvidenceMatches({
      ...snapshot,
      invoiceEvidence: { ...evidence, unsafeInvoiceItemCount: 0 },
    }, expectedEvidenceSha256)).toBe(false);
    expect(maintenanceInvoiceEvidenceMatches({
      ...snapshot,
      invoiceEvidence: { ...evidence, invalidApplicationCount: 1 },
    }, expectedEvidenceSha256)).toBe(false);
    expect(maintenanceInvoiceEvidenceMatches({
      ...snapshot,
      invoiceEvidence: { ...evidence, applicationIds: ['other-application'] },
    }, expectedEvidenceSha256)).toBe(false);
  });

  it('requires and preserves the locked settledAt precondition for component-only repairs', () => {
    const settledAt = '2026-07-15T10:01:00.000Z';
    const hashInput = {
      status: 'READY' as const,
      billingAccountId: 'enterprise-account',
      accountType: 'enterprise' as const,
      debtSource: 'ENTERPRISE_CREDIT' as const,
      settlementWriteMode: 'VERIFY_EXISTING' as const,
      expectedSettlementCount: 1,
      preconditionHash: 'c'.repeat(64),
      walletBalanceUsd: '0.000000000000',
      currentDebtUsd: '0.000000000000',
      legacySettledDebtUsd: '0.022612000000',
      activeGrantDriftUsd: '0.000000000000',
      throughTransactionId: null,
      transactionSequenceMutations: [],
      grantMutations: [],
      allocationMutations: [{
        allocationId: 'allocation-1',
        expectedSettledUsd: '0.022612000000',
        expectedRecognizedRevenueUsd: '0.000000000000',
        expectedBonusConsumedUsd: '0.000000000000',
        expectedSettledAt: settledAt,
        settledUsd: '0.022612000000',
        recognizedRevenueUsd: '0.000000000000',
        bonusConsumedUsd: '0.022612000000',
        settledAt,
      }],
      allocationSequenceMutations: [],
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
    const plan = {
      ...hashInput,
      replayHash: balanceLedgerRepairReplayHash(hashInput),
    };
    const raw = `${JSON.stringify(manifest)}\n${JSON.stringify(plan)}\n`;

    expect(parseRepairPlanFile(raw).plans).toEqual([plan]);
    const missingPrecondition = {
      ...plan,
      allocationMutations: plan.allocationMutations.map((mutation) => {
        const incomplete: Partial<typeof mutation> = { ...mutation };
        delete incomplete.expectedSettledAt;
        return incomplete;
      }),
    };
    expect(() => parseRepairPlanFile(
      `${JSON.stringify(manifest)}\n${JSON.stringify(missingPrecondition)}\n`,
    )).toThrow('allocationMutations[0] invalid');
  });

  it('strictly parses the complete versioned personal-debt proof shape', () => {
    const plan = personalDebtReadyPlan();
    const raw = `${JSON.stringify(manifest)}\n${JSON.stringify(plan)}\n`;
    expect(parseRepairPlanFile(raw).plans).toEqual([plan]);

    const wrongProofVersion = {
      ...plan,
      personalDebtAllocationMutations: plan.personalDebtAllocationMutations.map((mutation) => ({
        ...mutation,
        proofVersion: 2,
      })),
    };
    expect(() => parseRepairPlanFile(
      `${JSON.stringify(manifest)}\n${JSON.stringify(wrongProofVersion)}\n`,
    )).toThrow('personalDebtAllocationMutations[0] invalid');

    const wrongDeterministicId = {
      ...plan,
      personalDebtAllocationMutations: plan.personalDebtAllocationMutations.map((mutation) => ({
        ...mutation,
        createdDebtAllocationId: 'attacker-selected-id',
      })),
    };
    expect(() => parseRepairPlanFile(
      `${JSON.stringify(manifest)}\n${JSON.stringify(wrongDeterministicId)}\n`,
    )).toThrow('personalDebtAllocationMutations[0] invalid');

    const nestedUnknownField = {
      ...plan,
      personalDebtAllocationMutations: plan.personalDebtAllocationMutations.map((mutation) => ({
        ...mutation,
        targetDebtAllocation: {
          ...mutation.targetDebtAllocation,
          ignoredFinancialField: '1.000000000000',
        },
      })),
    };
    expect(() => parseRepairPlanFile(
      `${JSON.stringify(manifest)}\n${JSON.stringify(nestedUnknownField)}\n`,
    )).toThrow('targetDebtAllocation has unknown fields');
  });

  it('strictly parses the complete versioned legacy-voucher proof shape', () => {
    const plan = voucherReadyPlan();
    const raw = `${JSON.stringify(manifest)}\n${JSON.stringify(plan)}\n`;
    expect(parseRepairPlanFile(raw).plans).toEqual([plan]);

    const extraMutationField = {
      ...plan,
      legacyVoucherProofMutations: plan.legacyVoucherProofMutations.map((mutation) => ({
        ...mutation,
        attackerSelectedApproval: 'APPROVED',
      })),
    };
    expect(() => parseRepairPlanFile(
      `${JSON.stringify(manifest)}\n${JSON.stringify(extraMutationField)}\n`,
    )).toThrow('legacyVoucherProofMutations[0] has unknown fields');

    const wrongProofVersion = {
      ...plan,
      legacyVoucherProofMutations: plan.legacyVoucherProofMutations.map((mutation) => ({
        ...mutation,
        proofVersion: 2,
      })),
    };
    expect(() => parseRepairPlanFile(
      `${JSON.stringify(manifest)}\n${JSON.stringify(wrongProofVersion)}\n`,
    )).toThrow('legacyVoucherProofMutations[0] invalid');

    const wrongRepairKind = {
      ...plan,
      legacyVoucherProofMutations: plan.legacyVoucherProofMutations.map((mutation) => ({
        ...mutation,
        repairKind: 'LEGACY_VOUCHER_UNREVIEWED_V1',
      })),
    };
    expect(() => parseRepairPlanFile(
      `${JSON.stringify(manifest)}\n${JSON.stringify(wrongRepairKind)}\n`,
    )).toThrow('legacyVoucherProofMutations[0] invalid');

    const expiredUnderLegacyKind = {
      ...plan,
      legacyVoucherProofMutations: plan.legacyVoucherProofMutations.map((mutation) => ({
        ...mutation,
        expectedGrant: { ...mutation.expectedGrant, isExpired: true },
      })),
    };
    expect(() => parseRepairPlanFile(
      `${JSON.stringify(manifest)}\n${JSON.stringify(expiredUnderLegacyKind)}\n`,
    )).toThrow('legacyVoucherProofMutations[0] invalid');

    const mismatchedTransactionId = {
      ...plan,
      legacyVoucherProofMutations: plan.legacyVoucherProofMutations.map((mutation) => ({
        ...mutation,
        transactionId: 'attacker-selected-transaction',
      })),
    };
    expect(() => parseRepairPlanFile(
      `${JSON.stringify(manifest)}\n${JSON.stringify(mismatchedTransactionId)}\n`,
    )).toThrow('legacyVoucherProofMutations[0] invalid');

    const nestedUnknownField = {
      ...plan,
      legacyVoucherProofMutations: plan.legacyVoucherProofMutations.map((mutation) => ({
        ...mutation,
        expectedGrant: {
          ...mutation.expectedGrant,
          ignoredFinancialField: '100.000000000000',
        },
      })),
    };
    expect(() => parseRepairPlanFile(
      `${JSON.stringify(manifest)}\n${JSON.stringify(nestedUnknownField)}\n`,
    )).toThrow('expectedGrant has unknown fields');
  });

  it('requires every expired-voucher funding proof to carry its paired expiry proof in V9', () => {
    const plan = expiredVoucherReadyPlan();
    const raw = `${JSON.stringify(manifest)}\n${JSON.stringify(plan)}\n`;
    expect(parseRepairPlanFile(raw).plans).toEqual([plan]);

    const unpairedHashInput = {
      ...plan,
      legacyExpiryProofMutations: [],
    };
    const unpaired = {
      ...unpairedHashInput,
      replayHash: balanceLedgerRepairReplayHash(unpairedHashInput),
    };
    expect(() => parseRepairPlanFile(
      `${JSON.stringify(manifest)}\n${JSON.stringify(unpaired)}\n`,
    )).toThrow('expired voucher proof is missing its expiry proof');

    const nonExpired = {
      ...plan,
      legacyVoucherProofMutations: plan.legacyVoucherProofMutations.map((mutation) => ({
        ...mutation,
        expectedGrant: { ...mutation.expectedGrant, isExpired: false },
      })),
    };
    expect(() => parseRepairPlanFile(
      `${JSON.stringify(manifest)}\n${JSON.stringify(nonExpired)}\n`,
    )).toThrow('legacyVoucherProofMutations[0] invalid');
  });

  it('strictly parses invoice stability proof and binds it into the replay hash', () => {
    const plan = invoiceStabilityReadyPlan();
    const raw = `${JSON.stringify(manifest)}\n${JSON.stringify(plan)}\n`;
    expect(parseRepairPlanFile(raw).plans).toEqual([plan]);

    const tampered = {
      ...plan,
      invoiceStabilityProof: {
        ...plan.invoiceStabilityProof,
        evidenceSha256: 'f'.repeat(64),
      },
    };
    expect(() => parseRepairPlanFile(
      `${JSON.stringify(manifest)}\n${JSON.stringify(tampered)}\n`,
    )).toThrow('canonical replay hash mismatch');

  });

  it('strictly parses the complete versioned legacy-expiry proof shape', () => {
    const plan = legacyExpiryReadyPlan();
    const raw = `${JSON.stringify(manifest)}\n${JSON.stringify(plan)}\n`;
    expect(parseRepairPlanFile(raw).plans).toEqual([plan]);

    const tampered = {
      ...plan,
      legacyExpiryProofMutations: plan.legacyExpiryProofMutations.map((mutation) => ({
        ...mutation,
        nominalAmountUsd: '0.300000000000',
      })),
    };
    expect(() => parseRepairPlanFile(
      `${JSON.stringify(manifest)}\n${JSON.stringify(tampered)}\n`,
    )).toThrow('canonical replay hash mismatch');

    const tamperedWriterShape = {
      ...plan,
      legacyExpiryProofMutations: plan.legacyExpiryProofMutations.map((mutation) => ({
        ...mutation,
        expectedTransaction: { ...mutation.expectedTransaction, tokenUsageId: 'usage-1' },
      })),
    };
    expect(() => parseRepairPlanFile(
      `${JSON.stringify(manifest)}\n${JSON.stringify(tamperedWriterShape)}\n`,
    )).toThrow('legacyExpiryProofMutations[0] invalid');

    const tamperedAuditId = {
      ...plan,
      legacyExpiryProofMutations: plan.legacyExpiryProofMutations.map((mutation) => ({
        ...mutation,
        expiryAuditId: 'operator-selected-audit-id',
      })),
    };
    expect(() => parseRepairPlanFile(
      `${JSON.stringify(manifest)}\n${JSON.stringify(tamperedAuditId)}\n`,
    )).toThrow('legacyExpiryProofMutations[0] invalid');
  });

  it('requires distinct bounded dual approvals for every exceptional proof plan', () => {
    const ordinaryPlan = personalDebtReadyPlan();
    expect(resolveVoucherApprovalRefs([ordinaryPlan], undefined, undefined)).toBeNull();
    const voucherPlan = voucherReadyPlan();
    expect(() => resolveVoucherApprovalRefs([voucherPlan], undefined, undefined))
      .toThrow('--finance-approval-ref');
    expect(() => resolveVoucherApprovalRefs([voucherPlan], 'SAME', ' SAME '))
      .toThrow('must be different');
    expect(() => resolveVoucherApprovalRefs([voucherPlan], 'F'.repeat(201), 'TECH-1'))
      .toThrow('1..200');
    expect(resolveVoucherApprovalRefs([voucherPlan], ' FIN-1 ', ' TECH-1 ')).toEqual({
      financeApprovalRef: 'FIN-1',
      technicalApprovalRef: 'TECH-1',
    });
    expect(() => resolveVoucherApprovalRefs(
      [invoiceStabilityReadyPlan()],
      undefined,
      undefined,
    )).toThrow('--finance-approval-ref');
    expect(() => resolveVoucherApprovalRefs(
      [legacyExpiryReadyPlan()],
      undefined,
      undefined,
    )).toThrow('--finance-approval-ref');
  });

  it('strictly parses receipt-backed CREATE repairs and rejects malformed proof fields', () => {
    const fundingRepair = {
      repairKind: 'LEGACY_ENTERPRISE_ADMIN_FUNDING_V1',
      action: 'CREATE_GRANT',
      idempotencyKey: 'enterprise-recharge:enterprise-account:receipt-1',
      idempotencyScope: 'admin:adjust-balance',
      idempotencyEvidenceHash: 'd'.repeat(64),
      proofHash: 'e'.repeat(64),
      transactionId: 'funding-transaction-1',
      grantId: 'repair-enterprise-admin-funding:funding-transaction-1',
      userId: 'user-1',
      tenantId: 'tenant-1',
      billingAccountId: 'enterprise-account',
      productId: null,
      amountUsd: '5.000000000000',
      initialRemainingAmountUsd: '5.000000000000',
      expectedGrantSnapshotHash: null,
      expectedGrantRemainingAmountUsd: null,
      expectedGrantRemainingPaidAmountUsd: null,
      expectedGrantRemainingBonusAmountUsd: null,
      finalRemainingAmountUsd: '0.340000000000',
      finalRemainingPaidAmountUsd: '0.340000000000',
      finalRemainingBonusAmountUsd: '0.000000000000',
      validFrom: '2026-07-15T10:00:00.000Z',
      expiresAt: '2027-07-15T10:00:00.000Z',
      createdAt: '2026-07-15T10:00:00.000Z',
    } as const;
    const hashInput = {
      status: 'READY' as const,
      billingAccountId: 'enterprise-account',
      accountType: 'enterprise' as const,
      debtSource: 'ENTERPRISE_CREDIT' as const,
      settlementWriteMode: 'VERIFY_EXISTING' as const,
      expectedSettlementCount: 0,
      preconditionHash: 'c'.repeat(64),
      walletBalanceUsd: '0.340000000000',
      currentDebtUsd: '0.000000000000',
      legacySettledDebtUsd: '0.000000000000',
      activeGrantDriftUsd: '0.000000000000',
      throughTransactionId: 'funding-transaction-1',
      transactionSequenceMutations: [],
      grantMutations: [],
      allocationMutations: [],
      allocationSequenceMutations: [],
      unreconciledGrantMutations: [],
      canonicalAllocationMutations: [],
      migrationOpeningDebtMutations: [],
      personalDebtAllocationMutations: [],
      legacyVoucherProofMutations: [],
      legacyExpiryProofMutations: [],
      invoiceStabilityProof: null,
      settlementMutations: [],
      legacyAdminFundingRepairs: [fundingRepair],
    };
    const plan = {
      ...hashInput,
      replayHash: balanceLedgerRepairReplayHash(hashInput),
    };
    const approved = parseRepairPlanFile(
      `${JSON.stringify(manifest)}\n${JSON.stringify(plan)}\n`,
    );
    expect(approved.plans).toEqual([plan]);

    const linkRepair = {
      ...fundingRepair,
      action: 'LINK_GRANT' as const,
      idempotencyKey: 'enterprise-recharge:enterprise-account:receipt-2',
      idempotencyScope: 'admin:recharge' as const,
      proofHash: 'f'.repeat(64),
      transactionId: 'funding-transaction-2',
      grantId: 'existing-grant-2',
      expectedGrantSnapshotHash: '1'.repeat(64),
      expectedGrantRemainingAmountUsd: '5.000000000000',
      expectedGrantRemainingPaidAmountUsd: null,
      expectedGrantRemainingBonusAmountUsd: null,
      validFrom: '2026-07-15T10:00:00.002Z',
      expiresAt: '2027-07-15T10:00:00.002Z',
      createdAt: '2026-07-15T10:00:00.003Z',
    };
    const linkHashInput = { ...hashInput, legacyAdminFundingRepairs: [linkRepair] };
    const linkPlan = {
      ...linkHashInput,
      replayHash: balanceLedgerRepairReplayHash(linkHashInput),
    };
    expect(parseRepairPlanFile(
      `${JSON.stringify(manifest)}\n${JSON.stringify(linkPlan)}\n`,
    ).plans).toEqual([linkPlan]);

    const canonicalAllocation = {
      allocationId: 'allocation-proof-1',
      expectedUserId: 'user-1',
      expectedTenantId: 'tenant-1',
      expectedProductId: null,
      expectedBalanceTransactionId: 'consumption-1',
      expectedTokenUsageId: null,
      expectedBalanceGrantId: 'existing-grant-1',
      expectedSource: 'BALANCE_GRANT' as const,
      expectedAmountUsd: '0.500000000000',
      expectedRecognizedRevenueUsd: '0.500000000000',
      expectedBonusConsumedUsd: '0.000000000000',
      expectedDiscountRate: '1.000000000000',
      expectedSettledUsd: '0.000000000000',
      expectedSettledAt: null,
      expectedLedgerSequence: '2',
      expectedCreatedAt: '2026-07-15T10:01:00.000Z',
      balanceGrantId: fundingRepair.grantId,
      amountUsd: '0.500000000000',
      recognizedRevenueUsd: '0.500000000000',
      bonusConsumedUsd: '0.000000000000',
      discountRate: '1.000000000000',
      ledgerSequence: '2',
    };
    const canonicalHashInput = {
      ...hashInput,
      canonicalAllocationMutations: [canonicalAllocation],
    };
    const canonicalPlan = {
      ...canonicalHashInput,
      replayHash: balanceLedgerRepairReplayHash(canonicalHashInput),
    };
    expect(parseRepairPlanFile(
      `${JSON.stringify(manifest)}\n${JSON.stringify(canonicalPlan)}\n`,
    ).plans).toEqual([canonicalPlan]);
    expect(() => assertEnterpriseVerifiedAllocationMutations(canonicalPlan)).not.toThrow();
    expect(() => assertEnterpriseVerifiedAllocationMutations({
      ...canonicalPlan,
      canonicalAllocationMutations: [{
        ...canonicalAllocation,
        expectedLedgerSequence: null,
        ledgerSequence: '-1',
      }],
    })).not.toThrow();
    expect(() => assertEnterpriseVerifiedAllocationMutations({
      ...canonicalPlan,
      canonicalAllocationMutations: [{
        ...canonicalAllocation,
        ledgerSequence: '0',
      }],
    })).toThrow('ENTERPRISE_CANONICAL_ALLOCATION_SHAPE_INVALID');
    expect(() => assertEnterpriseVerifiedAllocationMutations({
      ...canonicalPlan,
      canonicalAllocationMutations: [{
        ...canonicalAllocation,
        expectedLedgerSequence: '-2',
        ledgerSequence: '-1',
      }],
    })).toThrow('ENTERPRISE_CANONICAL_ALLOCATION_SHAPE_INVALID');
    expect(() => assertEnterpriseVerifiedAllocationMutations({
      ...canonicalPlan,
      legacyAdminFundingRepairs: [],
    })).toThrow('ENTERPRISE_CANONICAL_ALLOCATION_REQUIRES_FUNDING_PROOF');
    expect(() => assertEnterpriseVerifiedAllocationMutations({
      ...canonicalPlan,
      canonicalAllocationMutations: [{
        ...canonicalAllocation,
        expectedBalanceGrantId: 'unrelated-existing-grant',
        balanceGrantId: 'another-unrelated-existing-grant',
      }],
    })).toThrow('ENTERPRISE_CANONICAL_ALLOCATION_SHAPE_INVALID');
    expect(() => assertEnterpriseVerifiedAllocationMutations({
      ...canonicalPlan,
      canonicalAllocationMutations: [canonicalAllocation, canonicalAllocation],
    })).toThrow('ENTERPRISE_CANONICAL_ALLOCATION_DUPLICATE');
    expect(() => parseRepairPlanFile(
      `${JSON.stringify(manifest)}\n${JSON.stringify({
        ...canonicalPlan,
        canonicalAllocationMutations: [{ ...canonicalAllocation, ignored: true }],
      })}\n`,
    )).toThrow('canonicalAllocationMutations[0] has unknown fields');

    const invalidVariants = [
      { ...fundingRepair, ignored: true },
      { ...fundingRepair, idempotencyEvidenceHash: 'D'.repeat(64) },
      { ...fundingRepair, idempotencyEvidenceHash: '0'.repeat(64) },
      { ...fundingRepair, proofHash: '0'.repeat(64) },
      { ...fundingRepair, billingAccountId: 'another-account' },
      { ...fundingRepair, idempotencyScope: 'admin:recharge' },
      { ...fundingRepair, expectedGrantSnapshotHash: 'f'.repeat(64) },
      { ...fundingRepair, finalRemainingPaidAmountUsd: '0.330000000000' },
    ];
    for (const invalidRepair of invalidVariants) {
      const invalidHashInput = { ...hashInput, legacyAdminFundingRepairs: [invalidRepair] };
      const invalidPlan = {
        ...invalidHashInput,
        replayHash: balanceLedgerRepairReplayHash(invalidHashInput as typeof hashInput),
      };
      expect(() => parseRepairPlanFile(
        `${JSON.stringify(manifest)}\n${JSON.stringify(invalidPlan)}\n`,
      )).toThrow(/legacyAdminFundingRepairs\[0\]/);
    }
  });

  it('locks all account receipts before wallet/ledger and persists proof before CREATE grant', () => {
    const scriptSource = readFileSync(resolve(
      __dirname,
      '../../scripts/reconcile-personal-balance-ledger.ts',
    ), 'utf8');
    const loaderStart = scriptSource.indexOf('async function loadSnapshot(');
    const loaderEnd = scriptSource.indexOf('\nasync function loadPostgresFinancialNow(', loaderStart);
    const loaderSource = scriptSource.slice(loaderStart, loaderEnd);
    expect(loaderSource).toContain("idempotency_row.\"scope\" IN ('admin:adjust-balance', 'admin:recharge')");
    expect(loaderSource).toContain('enterprise-recharge:${billingAccountId}:');
    expect(loaderSource).toContain('idempotency_row.\"status\" = \'COMMITTED\'');
    expect(loaderSource).not.toContain("idempotency_row.\"result\" #>> '{id}' IN");

    const applyStart = scriptSource.indexOf('async function applyReadyPlan(');
    const applyEnd = scriptSource.indexOf('\nfunction isSerializationFailure(', applyStart);
    const applySource = scriptSource.slice(applyStart, applyEnd);
    const receiptLock = applySource.indexOf('await lockLegacyAdminFundingReceipts(tx, plan);');
    const walletLock = applySource.indexOf('FROM "account_wallets"');
    const rebuild = applySource.indexOf('currentPlan = buildBalanceLedgerRepairPlan(');
    const transactionRepair = applySource.indexOf(
      'await applyTransactionSequenceMutationsFromStage(',
    );
    const fundingProof = applySource.indexOf('await insertLegacyAdminFundingProofAndMaybeGrant(');
    const existingGrantMutation = applySource.indexOf('for (const mutation of verifiedPlan.grantMutations)');
    expect(receiptLock).toBeGreaterThanOrEqual(0);
    expect(walletLock).toBeGreaterThan(receiptLock);
    expect(rebuild).toBeGreaterThan(walletLock);
    expect(transactionRepair).toBeGreaterThan(rebuild);
    expect(fundingProof).toBeGreaterThan(transactionRepair);
    expect(existingGrantMutation).toBeGreaterThan(fundingProof);
    expect(applySource).toContain(
      'canonicalAllocationMutations: verifiedPlan.canonicalAllocationMutations',
    );

    const helperStart = scriptSource.indexOf('async function insertLegacyAdminFundingProofAndMaybeGrant(');
    const helperEnd = scriptSource.indexOf('\nexport async function applyReadyPlan(', helperStart);
    const helperSource = scriptSource.slice(helperStart, helperEnd);
    const proofInsert = helperSource.indexOf('INSERT INTO "balance_ledger_admin_funding_repairs"');
    const grantInsert = helperSource.indexOf('INSERT INTO "balance_grants"');
    expect(proofInsert).toBeGreaterThanOrEqual(0);
    expect(grantInsert).toBeGreaterThan(proofInsert);
    expect(helperSource).toContain('to_jsonb(idempotency_row)');
    expect(helperSource).toContain('to_jsonb(transaction_row)');
    expect(helperSource).toContain("idempotency_row.\"result\" #>> '{id}'");
    expect(helperSource).not.toContain("#>> '{response,id}'");
    expect(helperSource).toContain('repair.expectedGrantSnapshotHash');
    expect(helperSource).not.toMatch(/(?:INSERT INTO|UPDATE) "balance_transactions"/);
    expect(helperSource).not.toMatch(/UPDATE "account_wallets"/);
  });

  it('persists a compact versioned before manifest without transaction or allocation rows', () => {
    const snapshot: BalanceLedgerRepairSnapshot = {
      ...maintenanceInvoiceSnapshot(),
      grants: [{
        id: 'grant-1',
        userId: 'user-1',
        tenantId: 'tenant-1',
        productId: null,
        orderId: 'subject-order-1',
        source: 'VOUCHER',
        paidAmountUsd: '0.000000000000',
        bonusAmountUsd: '1.000000000000',
        grantedAmountUsd: '1.000000000000',
        remainingAmountUsd: '0.750000000000',
        remainingPaidAmountUsd: '0.000000000000',
        remainingBonusAmountUsd: '0.750000000000',
        discountRate: '0.000000000000',
        isExpired: false,
        validFrom: '2026-07-01T00:00:00.000Z',
        expiresAt: '2027-07-01T00:00:00.000Z',
        createdAt: '2026-07-01T00:00:00.000Z',
      }],
      allocations: [{
        id: 'allocation-1',
        billingAccountId: 'account-1',
        userId: 'user-1',
        tenantId: 'tenant-1',
        productId: null,
        balanceTransactionId: 'funding-transaction-1',
        tokenUsageId: 'usage-1',
        balanceGrantId: 'grant-1',
        source: 'BALANCE_GRANT',
        amountUsd: '0.250000000000',
        recognizedRevenueUsd: '0.000000000000',
        bonusConsumedUsd: '0.250000000000',
        discountRate: '0.000000000000',
        settledUsd: '0.000000000000',
        settledAt: null,
        ledgerSequence: '1',
        createdAt: '2026-07-01T00:00:01.000Z',
      }],
      voucherIdempotencyEvidence: [{
        key: 'voucher:key-1',
        scope: 'admin:issue-voucher',
        userId: 'user-1',
        status: 'COMMITTED',
        result: { transaction: { id: 'funding-transaction-1' }, grant: { id: 'grant-1' } },
        createdAt: '2026-07-01T00:00:00.000Z',
        expiresAt: '2026-07-02T00:00:00.000Z',
      }],
      legacyAdminFundingIdempotencyEvidence: [{
        key: 'enterprise-recharge:account-1:receipt-1',
        scope: 'admin:recharge',
        userId: 'user-1',
        status: 'COMMITTED',
        result: { id: 'funding-transaction-1' },
        createdAt: '2026-07-01T00:00:00.000Z',
        expiresAt: '2026-07-02T00:00:00.000Z',
        snapshotSha256: 'c'.repeat(64),
      }],
      expiryAuditCount: 3,
    };
    const preconditionHash = 'd'.repeat(64);

    const beforeManifest = buildRepairAccountBeforeManifest(
      snapshot,
      preconditionHash,
    ) as Record<string, unknown>;

    expect(Object.keys(beforeManifest).sort()).toEqual([
      'accountType',
      'billingAccountId',
      'grants',
      'invoiceEvidenceSha256',
      'ledgerStatus',
      'ledgerVersion',
      'manifestVersion',
      'preconditionHash',
      'rowCounts',
      'snapshotHashAlgorithm',
      'voucherIdempotencyEvidence',
      'walletBalanceUsd',
    ].sort());
    expect(beforeManifest).toMatchObject({
      manifestVersion: 'BALANCE_LEDGER_REPAIR_BEFORE_V1',
      snapshotHashAlgorithm: 'sha256-stable-json-v1',
      billingAccountId: snapshot.billingAccountId,
      accountType: snapshot.accountType,
      ledgerStatus: snapshot.ledgerStatus,
      ledgerVersion: snapshot.ledgerVersion,
      walletBalanceUsd: snapshot.walletBalanceUsd,
      preconditionHash,
      invoiceEvidenceSha256: snapshot.invoiceEvidence?.snapshotSha256,
      rowCounts: {
        transactions: 1,
        grants: 1,
        allocations: 1,
        settlements: 0,
        orders: 1,
        invoiceItems: 1,
        voucherIdempotencyEvidence: 1,
        legacyAdminFundingIdempotencyEvidence: 1,
        expiryAudits: 3,
      },
      grants: snapshot.grants,
      voucherIdempotencyEvidence: snapshot.voucherIdempotencyEvidence,
    });
    expect(beforeManifest).not.toHaveProperty('transactions');
    expect(beforeManifest).not.toHaveProperty('allocations');
    expect(beforeManifest).not.toHaveProperty('settlements');
    expect(beforeManifest).not.toHaveProperty('orders');
    expect(beforeManifest).not.toHaveProperty('invoiceItems');
    expect(beforeManifest).not.toHaveProperty('invoiceEvidence');
  });

  it('reduces a large READY failure plan to hashes and mutation counts', () => {
    const basePlan = personalDebtReadyPlan();
    const transactionSequenceMutations = Array.from({ length: 10_000 }, (_, index) => ({
      transactionId: `large-transaction-${index}`,
      expectedLedgerSequence: null,
      ledgerSequence: String(index + 1),
    }));
    const largePlanInput = {
      ...basePlan,
      transactionSequenceMutations,
    };
    const largePlan = {
      ...largePlanInput,
      replayHash: balanceLedgerRepairReplayHash(largePlanInput),
    };

    const failureManifest = buildRepairFailureManifest(
      largePlan,
    ) as Record<string, unknown>;

    expect(Object.keys(failureManifest).sort()).toEqual([
      'billingAccountId',
      'invoiceStabilityProofPresent',
      'manifestVersion',
      'mutationCounts',
      'preconditionHash',
      'replayHash',
      'status',
    ].sort());
    expect(failureManifest).toMatchObject({
      manifestVersion: 'BALANCE_LEDGER_REPAIR_FAILURE_V1',
      billingAccountId: largePlan.billingAccountId,
      status: 'READY',
      preconditionHash: largePlan.preconditionHash,
      replayHash: largePlan.replayHash,
      mutationCounts: {
        transactionSequence: 10_000,
        grants: 0,
        allocations: 0,
        allocationSequence: 0,
        unreconciledGrants: 0,
        canonicalAllocations: 0,
        migrationOpeningDebt: 0,
        personalDebtAllocations: 1,
        legacyVoucherProofs: 0,
        legacyExpiryProofs: 0,
        settlements: 0,
        legacyAdminFunding: 0,
      },
      invoiceStabilityProofPresent: false,
    });
    for (const mutationArray of [
      'transactionSequenceMutations',
      'grantMutations',
      'allocationMutations',
      'allocationSequenceMutations',
      'unreconciledGrantMutations',
      'canonicalAllocationMutations',
      'migrationOpeningDebtMutations',
      'personalDebtAllocationMutations',
      'legacyVoucherProofMutations',
      'legacyExpiryProofMutations',
      'settlementMutations',
      'legacyAdminFundingRepairs',
      'plan',
    ]) {
      expect(failureManifest).not.toHaveProperty(mutationArray);
    }
    expect(JSON.stringify(failureManifest)).not.toContain('large-transaction-9999');
  });

  it('fails closed before returning audit JSON that exceeds its byte limit', () => {
    expect(() => repairAuditJsonWithLimit(
      { payload: 'x'.repeat(128) },
      'TEST_REPAIR_AUDIT',
      64,
    )).toThrow('TEST_REPAIR_AUDIT_TOO_LARGE:bytes=142:max=64');
  });

  it('uses transaction-local tuning and gates voucher receipt locks on voucher funding', () => {
    const scriptSource = readFileSync(resolve(
      __dirname,
      '../../scripts/reconcile-personal-balance-ledger.ts',
    ), 'utf8');
    expect(scriptSource).not.toContain('ALTER DATABASE');

    const configureStart = scriptSource.indexOf(
      'async function configureBoundedRepairTransaction(',
    );
    const configureEnd = scriptSource.indexOf('\n}', configureStart) + 2;
    const configureSource = scriptSource.slice(configureStart, configureEnd);
    expect(configureStart).toBeGreaterThanOrEqual(0);
    expect(configureSource).toContain("set_config('work_mem', '64MB', TRUE)");
    expect(configureSource).toContain("set_config('statement_timeout', '120s', TRUE)");
    expect(configureSource).toContain("set_config('lock_timeout', '5s', TRUE)");

    const voucherLockStart = scriptSource.indexOf(
      'async function lockVoucherIdempotencyReceipts(',
    );
    const voucherLockEnd = scriptSource.indexOf('\n}', voucherLockStart) + 2;
    const voucherLockSource = scriptSource.slice(voucherLockStart, voucherLockEnd);
    expect(voucherLockStart).toBeGreaterThanOrEqual(0);
    const voucherFundingGate = voucherLockSource.indexOf(
      'voucher_grant."source" = \'VOUCHER\'',
    );
    const voucherReceiptLookup = voucherLockSource.indexOf(
      "idempotency_row.\"result\" #>> '{transaction,id}'",
    );
    expect(voucherLockSource).toContain('WHERE EXISTS (');
    expect(voucherFundingGate).toBeGreaterThanOrEqual(0);
    expect(voucherReceiptLookup).toBeGreaterThan(voucherFundingGate);
    expect(voucherLockSource).toContain('WITH locked_rows AS MATERIALIZED (');
    expect(voucherLockSource).toContain(
      'SELECT COUNT(*)::BIGINT AS "lockedCount" FROM locked_rows',
    );

    const boundedLockStart = scriptSource.indexOf(
      'async function lockRowsWithoutClientMaterialization(',
    );
    const boundedLockEnd = scriptSource.indexOf('\n}', boundedLockStart) + 2;
    const boundedLockSource = scriptSource.slice(boundedLockStart, boundedLockEnd);
    expect(boundedLockStart).toBeGreaterThanOrEqual(0);
    expect(boundedLockSource).toContain('WITH locked_rows AS MATERIALIZED (');
    expect(boundedLockSource).toContain(
      'SELECT COUNT(*)::BIGINT AS "lockedCount" FROM locked_rows',
    );

    const applyStart = scriptSource.indexOf('async function applyReadyPlan(');
    const applyEnd = scriptSource.indexOf('\nfunction isSerializationFailure(', applyStart);
    const applySource = scriptSource.slice(applyStart, applyEnd);
    const approvedReplayHash = applySource.indexOf(
      'const approvedReplayHash = balanceLedgerRepairReplayHash(plan);',
    );
    const transactionStart = applySource.indexOf(
      'const result = await client.$transaction(async (tx) => {',
    );
    expect(applySource.match(/await lockRowsWithoutClientMaterialization\(/g)).toHaveLength(11);
    expect(applySource).not.toMatch(/await tx\.\$queryRaw`\s*SELECT "id"/);
    expect(approvedReplayHash).toBeGreaterThanOrEqual(0);
    expect(approvedReplayHash).toBeLessThan(transactionStart);
  });

  it('uses bounded manifests for SKIPPED_STALE, RUNNING, and FAILED records', () => {
    const scriptSource = readFileSync(resolve(
      __dirname,
      '../../scripts/reconcile-personal-balance-ledger.ts',
    ), 'utf8');
    expect(scriptSource).not.toContain('beforeSnapshot: repairAuditJson(snapshot)');
    expect(scriptSource).not.toContain('beforeSnapshot: repairAuditJson({ plan })');

    const applyStart = scriptSource.indexOf('async function applyReadyPlan(');
    const applyEnd = scriptSource.indexOf('\nfunction isSerializationFailure(', applyStart);
    const applySource = scriptSource.slice(applyStart, applyEnd);
    const stalePath = applySource.indexOf("status: 'SKIPPED_STALE'");
    const runningPath = applySource.indexOf("status: 'RUNNING'", stalePath);
    const stage = applySource.indexOf('await stageRepairMutations(');
    expect(applySource).toMatch(/beforeManifest\s*=\s*repairAuditJsonWithLimit\(/);
    expect(applySource).toContain('buildRepairAccountBeforeManifest(');
    expect(applySource).toContain('MAX_REPAIR_BEFORE_JSON_BYTES');
    expect(stalePath).toBeGreaterThanOrEqual(0);
    expect(runningPath).toBeGreaterThan(stalePath);
    expect(applySource.slice(stalePath, runningPath)).toContain('beforeSnapshot: beforeManifest');
    expect(applySource.slice(runningPath, stage)).toContain('beforeSnapshot: beforeManifest');

    const executeStart = scriptSource.indexOf('async function applyPlan(');
    const executeSource = scriptSource.slice(executeStart);
    const failedPath = executeSource.indexOf("status: 'FAILED'");
    expect(executeStart).toBeGreaterThanOrEqual(0);
    expect(failedPath).toBeGreaterThanOrEqual(0);
    const failedSource = executeSource.slice(failedPath, failedPath + 1_000);
    expect(failedSource).toContain('beforeSnapshot: repairAuditJsonWithLimit(');
    expect(failedSource).toContain('buildRepairFailureManifest(plan)');
    expect(failedSource).toContain('MAX_REPAIR_BEFORE_JSON_BYTES');
  });

  it('stages mutations and registers every row audit before applying any update', () => {
    const scriptSource = readFileSync(resolve(
      __dirname,
      '../../scripts/reconcile-personal-balance-ledger.ts',
    ), 'utf8');
    const applyStart = scriptSource.indexOf('async function applyReadyPlan(');
    const applyEnd = scriptSource.indexOf('\nfunction isSerializationFailure(', applyStart);
    const applySource = scriptSource.slice(applyStart, applyEnd);
    const configure = applySource.indexOf('await configureBoundedRepairTransaction(tx);');
    const voucherLock = applySource.indexOf('await lockVoucherIdempotencyReceipts(tx, plan);');
    const stage = applySource.indexOf('await stageRepairMutations(');
    const transactionAudit = applySource.indexOf(
      'await registerTransactionSequenceMutationAuditsFromStage(',
    );
    const allocationAudit = applySource.indexOf(
      'await registerAllocationMutationAuditsFromStage(',
    );
    const transactionUpdate = applySource.indexOf(
      'await applyTransactionSequenceMutationsFromStage(',
    );
    const allocationUpdate = applySource.indexOf(
      'await applyAllocationMutationsFromStage(',
    );
    const terminalEvidenceStaged = applySource.indexOf(
      "logRepairPhase('terminal-evidence-staged'",
    );
    const transactionCommitted = applySource.indexOf(
      "logRepairPhase('transaction-committed'",
    );
    expect(configure).toBeGreaterThanOrEqual(0);
    expect(voucherLock).toBeGreaterThan(configure);
    expect(stage).toBeGreaterThan(voucherLock);
    expect(transactionAudit).toBeGreaterThan(stage);
    expect(allocationAudit).toBeGreaterThan(transactionAudit);
    expect(transactionUpdate).toBeGreaterThan(allocationAudit);
    expect(allocationUpdate).toBeGreaterThan(transactionUpdate);
    expect(terminalEvidenceStaged).toBeGreaterThan(allocationUpdate);
    expect(transactionCommitted).toBeGreaterThan(terminalEvidenceStaged);
    expect(applySource).not.toContain("logRepairPhase('terminal-evidence-written'");
  });

  it('keeps terminal proof graph expressions unambiguous and verifies exact trigger wiring', () => {
    const migrationSource = readFileSync(resolve(
      __dirname,
      '../../prisma/migrations/20260719000100_legacy_enterprise_admin_funding_proof_contract/migration.sql',
    ), 'utf8');
    expect(migrationSource).not.toMatch(/\|\|\s*value->>/);
    expect(migrationSource.match(
      /\|\|\s*\(value->>'(?:expectedBalanceGrantId|expectedBalanceTransactionId|balanceGrantId)'\)/g,
    )).toHaveLength(8);

    const verifySource = readFileSync(resolve(
      __dirname,
      '../../prisma/migrations/20260719000100_legacy_enterprise_admin_funding_proof_contract/verify.sql',
    ), 'utf8');
    expect(verifySource).toContain("trigger_row.tgenabled = 'O'");
    expect(verifySource).toContain('trigger_row.tgfoid = expected.function_id');
    expect(verifySource).toContain('IF trigger_count <> 4 THEN');
  });
});
