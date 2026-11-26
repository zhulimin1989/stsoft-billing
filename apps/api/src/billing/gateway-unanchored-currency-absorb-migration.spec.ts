import { readFileSync } from 'fs';
import { resolve } from 'path';

describe('gateway unanchored currency absorb database contract', () => {
  const sql = readFileSync(resolve(
    __dirname,
    '../../prisma/migrations/'
      + '20260813000101_gateway_unanchored_currency_absorb_terminal_proof/'
      + 'migration.sql',
  ), 'utf8');

  it('installs a deferred terminal pair bound to the explicit v1 protocol', () => {
    expect(sql).toContain('assert_gateway_unanchored_currency_absorb_terminal');
    expect(sql).toContain("'gateway-unanchored-absorb-v1'");
    expect(sql).toContain('DEFERRABLE INITIALLY DEFERRED');
    expect(sql).toContain('requires exactly one ABSORB action');
    expect(sql).toContain('requires exactly one receipt');
    expect(sql).toContain('currencyRepairRunId');
    expect(sql).toContain('currencyRepairItemId');
    expect(sql).toContain('currencyRepairManifestHash');
    expect(sql).toContain('currencyRepairEligibleEventId');
    expect(sql).toContain('currencyRepairEligibleEventRowHash');
    expect(sql).toContain('currencyRepairFailureReason');
    expect(sql).toContain('currencyRepairErrorFingerprint');
    expect(sql).toContain('billing_account_currency_label_repair_eligible_events');
    expect(sql).toContain("eligible_event.\"failure_reason\" IS DISTINCT FROM");
    expect(sql).toContain("eligible_event.\"error_fingerprint\" IS DISTINCT FROM");
    expect(sql).toContain('gateway_unanchored_absorb_canonical_json');
    expect(sql).toContain('gateway_legacy_currency_failure_immutable');
    expect(sql).toContain('new gateway legacy currency failure markers are forbidden');
    expect(sql).toContain("deployment_config.\"key\" = 'deploymentConfig'");
    expect(sql).toContain('repair_run."status" IS DISTINCT FROM \'APPLIED\'');
    expect(sql).toContain('repair_item."billing_account_id" IS DISTINCT FROM current_account."id"');
  });

  it('keeps the proof zero-value and rejects every financial owner', () => {
    expect(sql).toContain('receipt_row."amount_usd" IS DISTINCT FROM 0');
    expect(sql).toContain('receipt_row."anchor_hash" IS NOT NULL');
    expect(sql).toContain('receipt_row."pricing_hash" IS NOT NULL');
    expect(sql).toContain('receipt_row."billing_unit" IS NOT NULL');
    expect(sql).toContain('receipt_row."billing_currency" IS NOT NULL');
    expect(sql).toContain('receipt_row."token_usage_id" IS NOT NULL');
    expect(sql).toContain('FROM "gateway_usage_settlement_anchors"');
    expect(sql).toContain('FROM "gateway_usage_funding_reservations"');
    expect(sql).toContain('FROM "token_usage"');
    expect(sql).toContain('FROM "gateway_usage_platform_losses"');
    expect(sql).toContain('FROM "usage_loss_recognition_claims"');
    expect(sql).toContain('FROM "historical_platform_loss_lines"');
    expect(sql).toContain('FROM "credit_transactions"');
    expect(sql).toContain('credit_transactions_gateway_request_id_idx');
  });

  it('rechecks post-terminal inserts instead of validating only the event update', () => {
    expect(sql).toContain('gateway_unanchored_absorb_anchor_absence');
    expect(sql).toContain('gateway_unanchored_absorb_reservation_absence');
    expect(sql).toContain('gateway_unanchored_absorb_token_usage_absence');
    expect(sql).toContain('gateway_unanchored_absorb_platform_loss_absence');
    expect(sql).toContain('gateway_unanchored_absorb_recognition_absence');
    expect(sql).toContain('gateway_unanchored_absorb_historical_loss_absence');
    expect(sql).toContain('gateway_unanchored_absorb_credit_transaction_absence');
  });

  it('does not redefine or relax the established anchored v2 proof', () => {
    expect(sql).not.toContain('CREATE OR REPLACE FUNCTION assert_gateway_usage_funding_terminal');
    expect(sql).not.toContain('manual-finance-v2');
    expect(sql).not.toContain('gateway-absorb-v2');
  });
});
