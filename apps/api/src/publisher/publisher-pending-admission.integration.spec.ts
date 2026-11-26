import { randomUUID } from 'node:crypto';
import { ConfigService } from '@nestjs/config';
import {
  Prisma,
  PrismaClient,
  ProductBillingMode,
  TransactionType,
} from '@prisma/client';
import { lockFixtureLedgerAndCaptureFinancialNow } from '../billing/balance-financial-clock.integration-fixture';
import { BillingService } from '../billing/billing.service';
import { PublisherSyncService } from './publisher-sync.service';

/**
 * Mutating PostgreSQL integration test. Run only against an isolated database:
 *
 * TEST_INTEGRATION=1 TEST_DATABASE_NAME=billing_pending_admission_test \
 * DATABASE_URL=postgresql://.../billing_pending_admission_test \
 * pnpm --filter @ruidong/api test -- --runInBand \
 *   --runTestsByPath src/publisher/publisher-pending-admission.integration.spec.ts
 *
 * Apply the normal Prisma migrations and the isolated database's Release-B
 * balance-ledger rollout before running this suite. The production reservation
 * case deliberately uses a clean V2 ledger and must not bypass that gate.
 */
const maybeDescribe = process.env.TEST_INTEGRATION === '1' ? describe : describe.skip;

type PendingAdmissionSnapshot = {
  financialAuthorityValid: boolean;
  accountBalanceUsd: Prisma.Decimal;
  activeCreditLimitUsd: Prisma.Decimal;
  balanceAllowanceUsd: Prisma.Decimal | null;
  balanceAllowanceUsedUsd: Prisma.Decimal;
  keyBudgetUsd: Prisma.Decimal | null;
  budgetRelevantSpentUsd: Prisma.Decimal;
  blockingReasons: string[];
  fundingReservationHoldUsd: Prisma.Decimal;
  fundingReservationRequestCount: bigint;
  provisionalHoldUsd: Prisma.Decimal;
  provisionalRequestCount: bigint;
};

type PendingAdmissionReader = {
  pendingAdmissionSnapshot(
    keyId: string,
    billingAccountId: string | null,
    tenantId: string | null,
  ): Promise<PendingAdmissionSnapshot>;
};

type SubjectFixture = {
  userId: string;
  billingAccountId: string;
  tenantId: string;
  productId: string;
  productSlug: string;
  apiKeyId: string;
};

type FundedSubjectFixture = SubjectFixture & {
  balanceGrantId: string;
};

type GuardFixture = SubjectFixture & {
  gatewayBillingEventId: string;
  requestId: string;
  restrictionId: string;
  amountUsd: Prisma.Decimal;
  occurredAt: Date;
  firstReceivedAt: Date;
  firstReceiptSequence: bigint;
  anchorHash: string;
};

function deferred(): {
  promise: Promise<void>;
  resolve: () => void;
} {
  let resolve = (): void => undefined;
  const promise = new Promise<void>((ready) => {
    resolve = ready;
  });
  return { promise, resolve };
}

function createService(prisma: PrismaClient): PublisherSyncService {
  const config = integrationConfig();

  return new PublisherSyncService(
    {} as never,
    prisma as never,
    config,
    {} as never,
    {} as never,
    {} as never,
  );
}

function createBillingService(prisma: PrismaClient): BillingService {
  return new BillingService(
    {} as never,
    {} as never,
    prisma as never,
    undefined,
    undefined,
    undefined,
    undefined,
    integrationConfig(),
  );
}

function integrationConfig(): ConfigService {
  return {
    get: (key: string): string | undefined => {
      if (key === 'BILLING_PLATFORM_CURRENCY') return 'CNY';
      if (key === 'BILLING_GATEWAY_CLOCK_MAX_SKEW_MS') return '5000';
      return undefined;
    },
  } as ConfigService;
}

function snapshotReader(service: PublisherSyncService): PendingAdmissionReader {
  return service as unknown as PendingAdmissionReader;
}

function readPendingAdmission(
  admission: PendingAdmissionReader,
  subject: Pick<SubjectFixture, 'apiKeyId' | 'billingAccountId' | 'tenantId'>,
): Promise<PendingAdmissionSnapshot> {
  return admission.pendingAdmissionSnapshot(
    subject.apiKeyId,
    subject.billingAccountId,
    subject.tenantId,
  );
}

async function assertIsolatedTestDatabase(prisma: PrismaClient): Promise<void> {
  const expectedDatabase = process.env.TEST_DATABASE_NAME?.trim();
  if (!expectedDatabase || !/(test|ci)/i.test(expectedDatabase)) {
    throw new Error('TEST_DATABASE_NAME must name an isolated test/ci database');
  }
  const [row] = await prisma.$queryRaw<Array<{ databaseName: string }>>`
    SELECT current_database() AS "databaseName"
  `;
  if (row?.databaseName !== expectedDatabase) {
    throw new Error(
      `integration database mismatch expected=${expectedDatabase} actual=${row?.databaseName ?? 'missing'}`,
    );
  }
}

async function createSubject(prisma: PrismaClient): Promise<SubjectFixture> {
  const suffix = randomUUID();
  const userId = randomUUID();
  const billingAccountId = randomUUID();
  const tenantId = randomUUID();
  const productId = randomUUID();
  const productSlug = `pending-admission-${suffix}`;
  const apiKeyId = randomUUID();

  await prisma.$transaction(async (db) => {
    await db.user.create({
      data: {
        id: userId,
        email: `pending-admission-${suffix}@integration.invalid`,
        nickname: 'pending-admission-integration',
      },
    });
    await db.billingAccount.create({
      data: {
        id: billingAccountId,
        type: 'personal',
        name: `pending-admission-${suffix}`,
        ownerUserId: userId,
        status: 'active',
        currency: 'CNY',
      },
    });
    await db.accountWallet.create({
      data: {
        billingAccountId,
        balanceUsd: new Prisma.Decimal('100'),
      },
    });
    await db.tenant.create({
      data: {
        id: tenantId,
        name: `pending-admission-${suffix}`,
        slug: `pending-admission-${suffix}`,
        ownerUserId: userId,
        billingAccountId,
      },
    });
    await db.product.create({
      data: {
        id: productId,
        name: `pending-admission-${suffix}`,
        slug: productSlug,
        billingMode: ProductBillingMode.PAY_AS_YOU_GO,
      },
    });
    await db.apiKey.create({
      data: {
        id: apiKeyId,
        userId,
        tenantId,
        productId,
        name: 'pending-admission-integration',
        prefix: 'rk-test',
        keyHash: `pending-admission-${suffix}`,
        mirrorStatus: 'ACTIVE',
      },
    });
  });

  return {
    userId,
    billingAccountId,
    tenantId,
    productId,
    productSlug,
    apiKeyId,
  };
}

async function createFundedSubject(
  prisma: PrismaClient,
  amountUsd: Prisma.Decimal.Value = '10',
): Promise<FundedSubjectFixture> {
  const suffix = randomUUID();
  const userId = randomUUID();
  const billingAccountId = randomUUID();
  const tenantId = randomUUID();
  const productId = randomUUID();
  const productSlug = `pending-funded-${suffix}`;
  const apiKeyId = randomUUID();
  const balanceGrantId = randomUUID();
  const amount = new Prisma.Decimal(amountUsd);

  await prisma.$transaction(async (db) => {
    await db.user.create({
      data: {
        id: userId,
        email: `pending-funded-${suffix}@integration.invalid`,
        nickname: 'pending-admission-funded-integration',
      },
    });
    await db.billingAccount.create({
      data: {
        id: billingAccountId,
        type: 'personal',
        name: `pending-funded-${suffix}`,
        ownerUserId: userId,
        status: 'active',
        currency: 'CNY',
        balanceGrantLedgerStatus: 'RECONCILED_V2',
        balanceGrantLedgerVersion: 2,
        balanceGrantLedgerHash: 'EMPTY_V2',
        balanceGrantLedgerReconciledAt: new Date(),
      },
    });
    await db.accountWallet.create({
      data: {
        billingAccountId,
        balanceUsd: new Prisma.Decimal(0),
      },
    });
    await db.tenant.create({
      data: {
        id: tenantId,
        name: `pending-funded-${suffix}`,
        slug: `pending-funded-${suffix}`,
        ownerUserId: userId,
        billingAccountId,
      },
    });
    await db.tenantMember.create({
      data: {
        id: randomUUID(),
        tenantId,
        userId,
        role: 'owner',
        status: 'active',
      },
    });
    await db.billingAccountMember.create({
      data: {
        id: randomUUID(),
        billingAccountId,
        userId,
        role: 'owner',
        status: 'active',
      },
    });
    await db.product.create({
      data: {
        id: productId,
        name: `pending-funded-${suffix}`,
        slug: productSlug,
        billingMode: ProductBillingMode.PAY_AS_YOU_GO,
      },
    });
    await db.apiKey.create({
      data: {
        id: apiKeyId,
        userId,
        tenantId,
        productId,
        name: 'pending-admission-funded-integration',
        prefix: 'rk-test',
        keyHash: `pending-funded-${suffix}`,
        mirrorStatus: 'ACTIVE',
      },
    });
  });

  await prisma.$transaction(async (db) => {
    const financialNow = await lockFixtureLedgerAndCaptureFinancialNow(
      db,
      billingAccountId,
    );
    const wallet = await db.accountWallet.update({
      where: { billingAccountId },
      data: { balanceUsd: { increment: amount } },
      select: { balanceUsd: true },
    });
    await db.balanceGrant.create({
      data: {
        id: balanceGrantId,
        userId,
        tenantId,
        billingAccountId,
        productId,
        source: 'RECHARGE',
        paidAmountUsd: amount,
        bonusAmountUsd: new Prisma.Decimal(0),
        grantedAmountUsd: amount,
        remainingAmountUsd: amount,
        remainingPaidAmountUsd: amount,
        remainingBonusAmountUsd: new Prisma.Decimal(0),
        discountRate: new Prisma.Decimal(1),
        validFrom: financialNow,
        expiresAt: null,
        isExpired: false,
        createdAt: financialNow,
      },
    });
    await db.balanceTransaction.create({
      data: {
        operationKey: `balance:admin-recharge:grant:${balanceGrantId}`,
        userId,
        tenantId,
        billingAccountId,
        productId,
        type: TransactionType.RECHARGE,
        amountUsd: amount,
        balanceAfterUsd: wallet.balanceUsd,
        description: 'pending admission production reservation fixture',
        createdAt: financialNow,
      },
    });
  });

  return {
    userId,
    billingAccountId,
    tenantId,
    productId,
    productSlug,
    apiKeyId,
    balanceGrantId,
  };
}

async function createGuard(
  prisma: PrismaClient,
  subject: SubjectFixture,
  amountUsd: Prisma.Decimal.Value,
  quoteAmount: string,
): Promise<GuardFixture> {
  const suffix = randomUUID();
  const gatewayBillingEventId = randomUUID();
  const requestId = `pending-admission-${suffix}`;
  const restrictionId = randomUUID();
  const amount = new Prisma.Decimal(amountUsd);
  const anchorHash = `sha256:${suffix.replace(/-/g, '').padEnd(64, '0').slice(0, 64)}`;
  const [sequence] = await prisma.$queryRaw<Array<{
    value: bigint;
    databaseNow: Date;
  }>>`
    SELECT
      nextval('gateway_usage_first_receipt_sequence_seq')::BIGINT AS "value",
      date_trunc(
        'milliseconds',
        clock_timestamp() AT TIME ZONE 'UTC'
      ) AS "databaseNow"
  `;
  if (!sequence?.value || !sequence.databaseNow) {
    throw new Error('failed to allocate Gateway first-receipt sequence and database clock');
  }
  const firstReceivedAt = sequence.databaseNow;
  const occurredAt = firstReceivedAt;

  await prisma.$transaction(async (db) => {
    await db.gatewayBillingEvent.create({
      data: {
        id: gatewayBillingEventId,
        requestId,
        status: 'RECEIVED',
        reconciliationStatus: 'OPEN',
        apiKeyId: subject.apiKeyId,
        tenantId: subject.tenantId,
        billingAccountId: subject.billingAccountId,
        userId: subject.userId,
        productId: subject.productId,
        productSlug: subject.productSlug,
        billingUnit: 'BALANCE',
        pendingExposureUsd: amount,
        pendingHoldUsd: amount,
        rawEvent: {},
        occurredAt,
        receivedAt: firstReceivedAt,
      },
    });
    await db.gatewayUsageSettlementAnchor.create({
      data: {
        id: randomUUID(),
        gatewayBillingEventId,
        requestId,
        apiKeyId: subject.apiKeyId,
        userId: subject.userId,
        tenantId: subject.tenantId,
        billingAccountId: subject.billingAccountId,
        productId: subject.productId,
        productSlug: subject.productSlug,
        billingUnit: 'BALANCE',
        billingCurrency: 'CNY',
        occurredAt,
        firstReceivedAt,
        firstReceiptSequence: sequence.value,
        fundingReservationProtocol: 'V1',
        pricingHash: `pricing-${suffix}`,
        customerQuoteSnapshot: {
          unit: 'BALANCE',
          effectiveCostUsd: quoteAmount,
        },
        customerPricingSnapshot: {},
        providerCostSnapshot: {},
        anchorHash,
        canonicalPayload: {
          customerSettlementPolicyVersion: 'gateway-customer-settlement-v2',
        },
      },
    });
    await db.billingAccessRestriction.create({
      data: {
        id: restrictionId,
        gatewayBillingEventId,
        billingAccountId: subject.billingAccountId,
        status: 'ACTIVE',
        reason: 'pending_usage_unreserved',
        idempotencyKey: `gateway:pending-unreserved:${requestId}`,
        createdBy: 'SYSTEM',
      },
    });
  });

  return {
    ...subject,
    gatewayBillingEventId,
    requestId,
    restrictionId,
    amountUsd: amount,
    occurredAt,
    firstReceivedAt,
    firstReceiptSequence: sequence.value,
    anchorHash,
  };
}

async function createReservationAndReleaseGuard(
  db: Prisma.TransactionClient,
  fixture: GuardFixture,
): Promise<void> {
  await db.gatewayUsageFundingReservation.create({
    data: {
      id: randomUUID(),
      gatewayBillingEventId: fixture.gatewayBillingEventId,
      requestId: fixture.requestId,
      billingAccountId: fixture.billingAccountId,
      tenantId: fixture.tenantId,
      userId: fixture.userId,
      apiKeyId: fixture.apiKeyId,
      billingUnit: 'BALANCE',
      billingCurrency: 'CNY',
      collectedFundingProtocol: 'NON_EXPIRING_GRANTS_V1',
      occurredAt: fixture.occurredAt,
      firstReceivedAt: fixture.firstReceivedAt,
      reservationSequence: fixture.firstReceiptSequence,
      reservedAmountUsd: fixture.amountUsd,
      collectedUsd: new Prisma.Decimal(0),
      approvedCreditUsd: new Prisma.Decimal(0),
      unapprovedDebtUsd: fixture.amountUsd,
      creditPolicyAt: fixture.firstReceivedAt,
      creditPolicyWindowStart: fixture.occurredAt,
      creditPolicySource: 'NOT_APPLICABLE',
      creditPolicyReconstructible: true,
      creditConfiguredLimitUsd: new Prisma.Decimal(0),
      creditLimitUsd: new Prisma.Decimal(0),
      anchorHash: fixture.anchorHash,
      reservationHash: `reservation-${randomUUID()}`,
      canonicalPayload: {},
      status: 'ACTIVE',
    },
  });
  const releasedAt = new Date();
  const released = await db.billingAccessRestriction.updateMany({
    where: {
      id: fixture.restrictionId,
      gatewayBillingEventId: fixture.gatewayBillingEventId,
      billingAccountId: fixture.billingAccountId,
      status: 'ACTIVE',
      reason: 'pending_usage_unreserved',
    },
    data: {
      status: 'RELEASED',
      releasedBy: 'SYSTEM',
      releaseReason: 'gateway_funding_reserved',
      releasedAt,
    },
  });
  if (released.count !== 1) {
    throw new Error(`expected to release one pending guard, released=${released.count}`);
  }
}

async function installExactGuardReleaseFailure(
  prisma: PrismaClient,
  restrictionId: string,
): Promise<() => Promise<void>> {
  if (!/^[0-9a-f-]{36}$/.test(restrictionId)) {
    throw new Error('guard release failure fixture requires a UUID restriction');
  }
  const suffix = randomUUID().replace(/-/g, '');
  const functionName = `test_fail_pending_guard_${suffix}`;
  const triggerName = `test_fail_pending_guard_${suffix}`;
  await prisma.$executeRawUnsafe(`
    CREATE FUNCTION "${functionName}"()
    RETURNS trigger
    LANGUAGE plpgsql
    AS $$
    BEGIN
      IF OLD."id" = '${restrictionId}' AND NEW."status" = 'RELEASED' THEN
        RAISE EXCEPTION 'integration forced pending guard release failure';
      END IF;
      RETURN NEW;
    END
    $$
  `);
  try {
    await prisma.$executeRawUnsafe(`
      CREATE TRIGGER "${triggerName}"
      BEFORE UPDATE OF "status" ON "billing_access_restrictions"
      FOR EACH ROW EXECUTE FUNCTION "${functionName}"()
    `);
  } catch (error) {
    await prisma.$executeRawUnsafe(`DROP FUNCTION "${functionName}"()`);
    throw error;
  }
  return async () => {
    await prisma.$executeRawUnsafe(`
      DROP TRIGGER "${triggerName}" ON "billing_access_restrictions"
    `);
    await prisma.$executeRawUnsafe(`DROP FUNCTION "${functionName}"()`);
  };
}

function reservationInput(fixture: GuardFixture) {
  return {
    gatewayBillingEventId: fixture.gatewayBillingEventId,
    requestId: fixture.requestId,
    billingAccountId: fixture.billingAccountId,
    tenantId: fixture.tenantId,
    userId: fixture.userId,
    apiKeyId: fixture.apiKeyId,
    billingCurrency: 'CNY',
    occurredAt: fixture.occurredAt,
    firstReceivedAt: fixture.firstReceivedAt,
    firstReceiptSequence: fixture.firstReceiptSequence,
    anchorHash: fixture.anchorHash,
    reservedAmountUsd: fixture.amountUsd,
  };
}

async function createKeySpend(
  tx: Prisma.TransactionClient,
  subject: SubjectFixture,
  costUsd: string,
): Promise<void> {
  await tx.tokenUsage.create({
    data: {
      id: randomUUID(),
      apiKeyId: subject.apiKeyId,
      tenantId: subject.tenantId,
      productId: subject.productId,
      model: 'integration-financial-snapshot',
      promptTokens: 1,
      completionTokens: 1,
      totalTokens: 2,
      inputPriceUsdPerM: new Prisma.Decimal(0),
      outputPriceUsdPerM: new Prisma.Decimal(0),
      costUsd: new Prisma.Decimal(costUsd),
    },
  });
}

function expectFinancialSnapshot(
  snapshot: PendingAdmissionSnapshot,
  expected: {
    accountBalanceUsd: string;
    balanceAllowanceUsd: string | null;
    balanceAllowanceUsedUsd: string;
    // 仅服务预算判定:无预算(keyBudgetUsd=null)时 SQL 短路返回 0,不是真实累计消费。
    budgetRelevantSpentUsd: string;
    keyBudgetUsd?: string | null;
  },
): void {
  expect(snapshot.financialAuthorityValid).toBe(true);
  expect(snapshot.accountBalanceUsd.toFixed(12)).toBe(expected.accountBalanceUsd);
  expect(snapshot.activeCreditLimitUsd.toFixed(12)).toBe('0.000000000000');
  expect(snapshot.balanceAllowanceUsd?.toFixed(12) ?? null)
    .toBe(expected.balanceAllowanceUsd);
  expect(snapshot.balanceAllowanceUsedUsd.toFixed(12))
    .toBe(expected.balanceAllowanceUsedUsd);
  expect(snapshot.keyBudgetUsd?.toFixed(12) ?? null)
    .toBe(expected.keyBudgetUsd ?? null);
  expect(snapshot.budgetRelevantSpentUsd.toFixed(12))
    .toBe(expected.budgetRelevantSpentUsd);
}

function budgetOkOf(snapshot: PendingAdmissionSnapshot): boolean {
  return snapshot.keyBudgetUsd === null
    || snapshot.budgetRelevantSpentUsd.lt(snapshot.keyBudgetUsd);
}

function expectGuardOnly(
  snapshot: PendingAdmissionSnapshot,
  amountUsd: Prisma.Decimal,
): void {
  expect(snapshot.blockingReasons).toEqual([]);
  expect(snapshot.provisionalRequestCount).toBe(1n);
  expect(snapshot.fundingReservationRequestCount).toBe(0n);
  expect(snapshot.provisionalHoldUsd.toFixed(12)).toBe(amountUsd.toFixed(12));
  expect(snapshot.fundingReservationHoldUsd.toFixed(12)).toBe('0.000000000000');
  expect(
    snapshot.provisionalRequestCount + snapshot.fundingReservationRequestCount,
  ).toBe(1n);
}

function expectReservationOnly(
  snapshot: PendingAdmissionSnapshot,
  amountUsd: Prisma.Decimal,
): void {
  expect(snapshot.blockingReasons).toEqual([]);
  expect(snapshot.provisionalRequestCount).toBe(0n);
  expect(snapshot.fundingReservationRequestCount).toBe(1n);
  expect(snapshot.provisionalHoldUsd.toFixed(12)).toBe('0.000000000000');
  expect(snapshot.fundingReservationHoldUsd.toFixed(12)).toBe(amountUsd.toFixed(12));
  expect(
    snapshot.provisionalRequestCount + snapshot.fundingReservationRequestCount,
  ).toBe(1n);
}

maybeDescribe('Publisher pending admission PostgreSQL snapshot (integration)', () => {
  const writer = new PrismaClient();
  const reader = new PrismaClient();
  const admission = snapshotReader(createService(reader));
  const billing = createBillingService(writer);

  beforeAll(async () => {
    await Promise.all([writer.$connect(), reader.$connect()]);
    await assertIsolatedTestDatabase(reader);
  });

  afterAll(async () => {
    await Promise.all([writer.$disconnect(), reader.$disconnect()]);
  });

  it('maps a canonical scientific Decimal guard and rejects a huge exponent without casting it', async () => {
    const validSubject = await createSubject(writer);
    const valid = await createGuard(writer, validSubject, '0.0000001', '1e-7');
    const validSnapshot = await readPendingAdmission(admission, valid);
    expectGuardOnly(validSnapshot, valid.amountUsd);
    await writer.gatewayBillingEvent.update({
      where: { id: valid.gatewayBillingEventId },
      data: {
        status: 'RETRYABLE_FAILED',
        reason: 'funding_reservation_queue_pending',
        reconciliationStatus: 'RETRY_WAIT',
      },
    });
    expectGuardOnly(
      await readPendingAdmission(admission, valid),
      valid.amountUsd,
    );

    const invalidSubject = await createSubject(writer);
    const invalid = await createGuard(writer, invalidSubject, '0.0000001', '1e999999');
    const invalidSnapshot = await readPendingAdmission(admission, invalid);
    expect(invalidSnapshot.blockingReasons).toEqual(['pending_usage_unreserved']);
    expect(invalidSnapshot.provisionalRequestCount).toBe(0n);
    expect(invalidSnapshot.fundingReservationRequestCount).toBe(0n);
    expect(invalidSnapshot.provisionalHoldUsd.toFixed(12)).toBe('0.000000000000');
    expect(invalidSnapshot.fundingReservationHoldUsd.toFixed(12)).toBe('0.000000000000');
  });

  it('observes only complete financial tuples across an atomic funding transition', async () => {
    const subject = await createSubject(writer);
    const fixture = await createGuard(writer, subject, '0.25', '0.25');
    const initialSnapshot = await readPendingAdmission(admission, fixture);
    expectGuardOnly(initialSnapshot, fixture.amountUsd);
    expectFinancialSnapshot(initialSnapshot, {
      accountBalanceUsd: '100.000000000000',
      balanceAllowanceUsd: null,
      balanceAllowanceUsedUsd: '0.000000000000',
      budgetRelevantSpentUsd: '0.000000000000',
    });

    const writesComplete = deferred();
    const allowCommit = deferred();
    const transition = writer.$transaction(async (db) => {
      await createReservationAndReleaseGuard(db, fixture);
      await db.accountWallet.update({
        where: { billingAccountId: fixture.billingAccountId },
        data: { balanceUsd: new Prisma.Decimal('90') },
      });
      await db.tenant.update({
        where: { id: fixture.tenantId },
        data: {
          balanceAllowanceUsd: new Prisma.Decimal('15'),
          balanceAllowanceUsedUsd: new Prisma.Decimal('5'),
        },
      });
      await createKeySpend(db, fixture, '2');
      writesComplete.resolve();
      await allowCommit.promise;
    }, { timeout: 15_000 });

    await writesComplete.promise;
    try {
      // reader is a separate PrismaClient/connection. Before commit it must see
      // one complete old tuple, never new wallet/allowance/spend mixed with the
      // old guard or vice versa.
      const beforeCommit = await readPendingAdmission(admission, fixture);
      expectGuardOnly(beforeCommit, fixture.amountUsd);
      expectFinancialSnapshot(beforeCommit, {
        accountBalanceUsd: '100.000000000000',
        balanceAllowanceUsd: null,
        balanceAllowanceUsedUsd: '0.000000000000',
        budgetRelevantSpentUsd: '0.000000000000',
      });
    } finally {
      allowCommit.resolve();
    }
    await transition;

    const afterCommit = await readPendingAdmission(admission, fixture);
    expectReservationOnly(afterCommit, fixture.amountUsd);
    expectFinancialSnapshot(afterCommit, {
      accountBalanceUsd: '90.000000000000',
      balanceAllowanceUsd: '15.000000000000',
      balanceAllowanceUsedUsd: '5.000000000000',
      // 该 fixture 的 key 无 budget_usd ⇒ key_spend CTE 的 EXISTS 门短路返回 0。
      // 真实消费仍是 2(见下一个用例:配了预算就必须拿到真值),这里刻意不算。
      budgetRelevantSpentUsd: '0.000000000000',
    });
  });

  it('computes the real key spend only when the key carries a budget', async () => {
    const budgeted = await createSubject(writer);
    await writer.apiKey.update({
      where: { id: budgeted.apiKeyId },
      data: { budgetUsd: new Prisma.Decimal('5') },
    });
    await createKeySpend(writer, budgeted, '2');

    const snapshot = await readPendingAdmission(admission, budgeted);
    expectFinancialSnapshot(snapshot, {
      accountBalanceUsd: '100.000000000000',
      balanceAllowanceUsd: null,
      balanceAllowanceUsedUsd: '0.000000000000',
      keyBudgetUsd: '5.000000000000',
      budgetRelevantSpentUsd: '2.000000000000',
    });
    // 复现 publisher-sync.service.ts:882 的唯一消费点。快照本身不产出
    // key_spend_limit_exhausted(那是调用侧 :919 由 budgetOk 映射的),
    // 所以这里钉住的是喂给它的两个值,而非 blockingReasons。
    expect(budgetOkOf(snapshot)).toBe(true);

    // 另一侧:越过预算必须判不通过 —— 证明短路门没有把有预算 key 也打成 0。
    await createKeySpend(writer, budgeted, '4');
    const exhausted = await readPendingAdmission(admission, budgeted);
    expect(exhausted.budgetRelevantSpentUsd.toFixed(12)).toBe('6.000000000000');
    expect(budgetOkOf(exhausted)).toBe(false);
  });

  it('rolls reservation creation and guard release back together', async () => {
    const subject = await createSubject(writer);
    const fixture = await createGuard(writer, subject, '0.5', '0.5');

    await expect(writer.$transaction(async (db) => {
      await createReservationAndReleaseGuard(db, fixture);
      throw new Error('force pending admission transition rollback');
    })).rejects.toThrow('force pending admission transition rollback');

    const [restriction, reservation] = await Promise.all([
      writer.billingAccessRestriction.findUniqueOrThrow({
        where: { id: fixture.restrictionId },
        select: {
          status: true,
          releasedAt: true,
          releasedBy: true,
          releaseReason: true,
        },
      }),
      writer.gatewayUsageFundingReservation.findUnique({
        where: { gatewayBillingEventId: fixture.gatewayBillingEventId },
        select: { id: true },
      }),
    ]);
    expect(restriction).toEqual({
      status: 'ACTIVE',
      releasedAt: null,
      releasedBy: null,
      releaseReason: null,
    });
    expect(reservation).toBeNull();
    expectGuardOnly(
      await readPendingAdmission(admission, fixture),
      fixture.amountUsd,
    );
  });

  it('uses production BillingService to persist a non-zero reservation, grant slice, and exact guard release', async () => {
    const subject = await createFundedSubject(writer, '10');
    const fixture = await createGuard(writer, subject, '2.5', '2.5');

    await expect(billing.reserveGatewayBalanceFunding(reservationInput(fixture)))
      .resolves.toEqual(expect.objectContaining({
        requestId: fixture.requestId,
        status: 'ACTIVE',
        reservedAmountUsd: new Prisma.Decimal('2.5'),
        collectedUsd: new Prisma.Decimal('2.5'),
        approvedCreditUsd: new Prisma.Decimal(0),
        unapprovedDebtUsd: new Prisma.Decimal(0),
      }));

    const [reservation, slices, guard] = await Promise.all([
      writer.gatewayUsageFundingReservation.findUniqueOrThrow({
        where: { gatewayBillingEventId: fixture.gatewayBillingEventId },
      }),
      writer.gatewayUsageFundingReservationGrant.findMany({
        where: { gatewayBillingEventId: fixture.gatewayBillingEventId },
        orderBy: { allocationOrder: 'asc' },
      }),
      writer.billingAccessRestriction.findUniqueOrThrow({
        where: { id: fixture.restrictionId },
        select: {
          status: true,
          releasedAt: true,
          releasedBy: true,
          releaseReason: true,
        },
      }),
    ]);
    expect(reservation.reservedAmountUsd.toFixed(12)).toBe('2.500000000000');
    expect(reservation.collectedUsd.toFixed(12)).toBe('2.500000000000');
    expect(slices).toHaveLength(1);
    expect(slices[0]).toEqual(expect.objectContaining({
      fundingReservationId: reservation.id,
      gatewayBillingEventId: fixture.gatewayBillingEventId,
      balanceGrantId: subject.balanceGrantId,
      allocationOrder: 0,
    }));
    expect(slices[0]?.amountUsd.toFixed(12)).toBe('2.500000000000');
    expect(guard).toEqual({
      status: 'RELEASED',
      releasedAt: expect.any(Date),
      releasedBy: 'SYSTEM',
      releaseReason: 'gateway_funding_reserved',
    });
    expectReservationOnly(
      await readPendingAdmission(admission, fixture),
      fixture.amountUsd,
    );
  });

  it('rolls production reservation and grant slices back when the exact guard release write fails', async () => {
    const subject = await createFundedSubject(writer, '10');
    const fixture = await createGuard(writer, subject, '3', '3');
    const removeFailure = await installExactGuardReleaseFailure(
      writer,
      fixture.restrictionId,
    );
    try {
      await expect(billing.reserveGatewayBalanceFunding(reservationInput(fixture)))
        .rejects.toThrow('integration forced pending guard release failure');
    } finally {
      await removeFailure();
    }

    const [reservation, sliceCount, guard] = await Promise.all([
      writer.gatewayUsageFundingReservation.findUnique({
        where: { gatewayBillingEventId: fixture.gatewayBillingEventId },
        select: { id: true },
      }),
      writer.gatewayUsageFundingReservationGrant.count({
        where: { gatewayBillingEventId: fixture.gatewayBillingEventId },
      }),
      writer.billingAccessRestriction.findUniqueOrThrow({
        where: { id: fixture.restrictionId },
        select: {
          status: true,
          releasedAt: true,
          releasedBy: true,
          releaseReason: true,
        },
      }),
    ]);
    expect(reservation).toBeNull();
    expect(sliceCount).toBe(0);
    expect(guard).toEqual({
      status: 'ACTIVE',
      releasedAt: null,
      releasedBy: null,
      releaseReason: null,
    });
    expectGuardOnly(
      await readPendingAdmission(admission, fixture),
      fixture.amountUsd,
    );
  });
});
