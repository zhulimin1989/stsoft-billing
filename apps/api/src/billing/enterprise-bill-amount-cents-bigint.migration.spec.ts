import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

const MIGRATION = '20260929000100_enterprise_bill_amount_cents_bigint';

describe('enterprise bill amount cents BIGINT migration', () => {
  const migration = readFileSync(resolve(
    __dirname,
    `../../prisma/migrations/${MIGRATION}/migration.sql`,
  ), 'utf8');
  const schema = readFileSync(resolve(
    __dirname,
    '../../prisma/schema.prisma',
  ), 'utf8');

  it('widens event, deadline freeze, and month-summary cents to BIGINT with lock_timeout', () => {
    expect(migration).toMatch(/SET\s+LOCAL\s+lock_timeout\s*=/i);
    expect(migration).toContain('ALTER COLUMN "amount_cents" SET DATA TYPE BIGINT');
    expect(migration).toContain('ALTER COLUMN "frozen_consume_cents" SET DATA TYPE BIGINT');
    expect(migration).toContain('ALTER COLUMN "frozen_voucher_cents" SET DATA TYPE BIGINT');
    expect(migration).toContain('ALTER COLUMN "frozen_charge_cents" SET DATA TYPE BIGINT');
    expect(migration).toContain('ALTER COLUMN "paid_cents" SET DATA TYPE BIGINT');
    expect(migration).toContain('ALTER COLUMN "pending_cents" SET DATA TYPE BIGINT');
    expect(migration).toContain('ALTER COLUMN "adjusted_cents" SET DATA TYPE BIGINT');
    expect(migration).toContain('ALTER COLUMN "issued_voucher_cents" SET DATA TYPE BIGINT');
    expect(migration).toContain('ALTER COLUMN "consume_cents" SET DATA TYPE BIGINT');
    expect(migration).toContain('ALTER COLUMN "voucher_cents" SET DATA TYPE BIGINT');
    expect(migration).toContain('ALTER COLUMN "charge_cents" SET DATA TYPE BIGINT');
  });

  it('maps those Prisma cents fields to BigInt, not Int', () => {
    const deadline = schema.match(/model EnterpriseBillDeadline \{([\s\S]*?)\n\}/)?.[1] ?? '';
    const event = schema.match(/model EnterpriseBillEvent \{([\s\S]*?)\n\}/)?.[1] ?? '';
    const summary = schema.match(/model EnterpriseBillMonthSummary \{([\s\S]*?)\n\}/)?.[1] ?? '';
    expect(deadline).toMatch(/frozenConsumeCents\s+BigInt\?/);
    expect(deadline).toMatch(/frozenVoucherCents\s+BigInt\?/);
    expect(deadline).toMatch(/frozenChargeCents\s+BigInt\?/);
    expect(event).toMatch(/amountCents\s+BigInt/);
    expect(summary).toMatch(/paidCents\s+BigInt/);
    expect(summary).toMatch(/pendingCents\s+BigInt/);
    expect(summary).toMatch(/adjustedCents\s+BigInt/);
    expect(summary).toMatch(/issuedVoucherCents\s+BigInt/);
    expect(summary).toMatch(/consumeCents\s+BigInt/);
    expect(summary).toMatch(/voucherCents\s+BigInt/);
    expect(summary).toMatch(/chargeCents\s+BigInt/);
    expect(event).not.toMatch(/amountCents\s+Int\b/);
    expect(summary).not.toMatch(/paidCents\s+Int\b/);
  });
});
