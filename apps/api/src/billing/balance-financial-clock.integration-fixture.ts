import { Prisma } from '@prisma/client';
import { POSTGRES_UTC_FINANCIAL_CLOCK } from './balance-financial-clock';

/**
 * Acquire the production wallet -> grants -> account lock order and establish
 * the transaction-local financial clock required by the strict ledger guards.
 *
 * This helper is intentionally limited to integration fixtures that must write
 * a complete historical ledger bundle directly. Normal tests should exercise
 * BillingService's public mutation APIs instead.
 */
export async function lockFixtureLedgerAndCaptureFinancialNow(
  db: Prisma.TransactionClient,
  billingAccountId: string,
): Promise<Date> {
  await db.$queryRaw`
    SELECT "balance_usd"
    FROM "account_wallets"
    WHERE "billing_account_id" = ${billingAccountId}
    FOR UPDATE`;
  await db.$queryRaw`
    SELECT "id"
    FROM "balance_grants"
    WHERE "billing_account_id" = ${billingAccountId}
    ORDER BY "id" ASC
    FOR UPDATE`;
  await db.$queryRaw`
    SELECT "id"
    FROM "billing_accounts"
    WHERE "id" = ${billingAccountId}
    FOR UPDATE`;

  const [clock] = await db.$queryRaw<Array<{ financialNow: Date }>>(Prisma.sql`
    WITH account_clock_floor AS (
      SELECT GREATEST(
        COALESCE(
          account."balance_grant_ledger_reconciled_at",
          '-infinity'::TIMESTAMP
        ),
        COALESCE((
          SELECT transaction_row."created_at"
          FROM "balance_transactions" transaction_row
          WHERE transaction_row."billing_account_id" = account."id"
            AND transaction_row."ledger_sequence" > 0
          ORDER BY transaction_row."created_at" DESC
          LIMIT 1
        ), '-infinity'::TIMESTAMP)
      )::TIMESTAMP(3) AS "financialFloor"
      FROM "billing_accounts" account
      WHERE account."id" = ${billingAccountId}
    ), observed AS (
      SELECT GREATEST(
        ${POSTGRES_UTC_FINANCIAL_CLOCK},
        "financialFloor"
      )::TIMESTAMP(3) AS "financialNow"
      FROM account_clock_floor
    )
    SELECT
      "financialNow",
      set_config(
        'billing.balance_financial_now',
        "financialNow"::TEXT,
        TRUE
      ) AS "financialNowSetting"
    FROM observed`);

  if (!clock?.financialNow || Number.isNaN(clock.financialNow.getTime())) {
    throw new Error(`fixture financial clock unavailable: ${billingAccountId}`);
  }
  return clock.financialNow;
}

/**
 * A strict clean ledger cannot be born already expired: the deferred guard
 * evaluates against the immutable financial clock captured above. Create the
 * canonical bundle while active, then let PostgreSQL's real clock pass expiry
 * before committing so expiry/refund tests begin from a genuinely due grant.
 */
export async function ageFixturePastExpiry(
  db: Prisma.TransactionClient,
  expiresAt: Date,
): Promise<void> {
  const [verified] = await db.$queryRaw<Array<{ observedAt: Date }>>(Prisma.sql`
    WITH waited AS MATERIALIZED (
      SELECT pg_sleep(
        GREATEST(
          EXTRACT(EPOCH FROM (
            ${expiresAt}::TIMESTAMP(3) - ${POSTGRES_UTC_FINANCIAL_CLOCK}
          ))::DOUBLE PRECISION,
          0.0
        ) + 0.010
      )
    )
    SELECT ${POSTGRES_UTC_FINANCIAL_CLOCK} AS "observedAt"
    FROM waited`);
  if (!verified?.observedAt || verified.observedAt.getTime() < expiresAt.getTime()) {
    throw new Error(`fixture failed to reach expiry: ${expiresAt.toISOString()}`);
  }
}
