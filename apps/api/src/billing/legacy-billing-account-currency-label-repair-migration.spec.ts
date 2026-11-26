import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('legacy BillingAccount currency-label repair migration', () => {
  const migration = readFileSync(resolve(
    __dirname,
    '../../prisma/migrations/20260813000100_legacy_billing_account_currency_label_repair/migration.sql',
  ), 'utf8').replace(/\r\n/g, '\n');
  const verification = readFileSync(resolve(
    __dirname,
    '../../prisma/migrations/20260813000100_legacy_billing_account_currency_label_repair/verify.sql',
  ), 'utf8').replace(/\r\n/g, '\n');
  const schema = readFileSync(resolve(
    __dirname,
    '../../prisma/schema.prisma',
  ), 'utf8').replace(/\r\n/g, '\n');
  const runbook = readFileSync(resolve(
    __dirname,
    '../../../../docs/runbooks/shanghai-uat-legacy-billing-currency-label-repair-20260813.zh-CN.md',
  ), 'utf8').replace(/\r\n/g, '\n');

  const ids = (source: string, pattern: RegExp): string[] =>
    [...source.matchAll(pattern)].map((match) => match[0]);

  it('installs an explicit apply boundary instead of running a data repair on deploy', () => {
    expect(migration).toContain(
      '-- Install-only release for one proven legacy USD -> CNY label correction.',
    );
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION\n  "apply_legacy_billing_account_currency_label_repair_v1"',
    );
    expect(migration).not.toMatch(
      /SELECT\s+\*\s+FROM\s+"?apply_legacy_billing_account_currency_label_repair_v1"?\s*\(/,
    );
    expect(migration).not.toContain('DROP TRIGGER billing_accounts_currency_immutable');
    expect(migration).toContain("'billing.currency_label_repair_run_id'");
    expect(migration).toContain("'billing.allow_currency_label_repair_fixture'");
    expect(migration).toContain("lower(current_database()) ~ '(test|ci)'");
    expect(migration).toContain('previous_transition_marker');
    expect(migration).toContain('ALTER COLUMN "currency" DROP DEFAULT');
    const billingAccountModel = schema.match(
      /model BillingAccount \{([\s\S]*?)\n\}/,
    )?.[1];
    expect(billingAccountModel).toMatch(/currency\s+String(?:\s|\n)/);
    expect(billingAccountModel).not.toContain('@default("USD")');
  });

  it('pins the UAT authority in the apply function, not in generic audit checks', () => {
    const runTable = migration.slice(
      migration.indexOf('CREATE TABLE "billing_account_currency_label_repair_runs"'),
      migration.indexOf('CREATE TABLE "billing_account_currency_label_repair_items"'),
    );
    expect(runTable).toContain('"manifest_version" ~');
    expect(runTable).toContain('"account_count" > 0');
    expect(runTable).not.toContain(
      '"manifest_version" = \'shanghai-uat-legacy-usd-label-v1\'',
    );
    expect(runTable).not.toContain('"account_count" = 10');
    expect(migration).toContain(
      "target_manifest_version CONSTANT TEXT :=\n    'shanghai-uat-legacy-usd-label-v1'",
    );
    expect(migration).toContain(
      '1743a625f25a8bbacd42a8cbaec3a73ad2653a0f43b4137b7e4d30e0c05137d6',
    );
    expect(migration).toContain('expected_account_count CONSTANT INTEGER := 10');
  });

  it('uses exact account, pending-order and terminal-failed-order manifests', () => {
    const manifestDefinition = migration.slice(
      migration.indexOf('"billing_account_currency_label_manifest_v1"'),
      migration.indexOf('"billing_account_currency_label_pending_order_v1"'),
    );
    expect(ids(manifestDefinition, /(?:ba_personal_[0-9a-f-]{36}|30063f69-bcf2-4986-a1dc-fe06a75af051)/g))
      .toHaveLength(10);
    for (const orderId of [
      '9d2903d9-7475-4f02-af74-3f61c8cc3c55',
      '88805844-5b2e-4659-a2da-a5fd9623cd57',
      'e26322b8-b865-43f9-a654-8b215c23c695',
    ]) {
      expect(migration).toContain(orderId);
    }
    expect(migration).toContain('pending_order_count <> 3');
    expect(migration).toContain('non_cny_order_count <> 6');
    expect(migration).toContain("order_row.\"status\"::TEXT <> 'FAILED'");
    expect(migration).not.toContain('FULL JOIN "orders"');
  });

  it('binds only three exact legacy events and preserves historical semantics', () => {
    for (const [eventId, requestId, evidenceId] of [
      [
        '9ee64264-8af5-4069-ba27-21c9abfe85d3',
        '5d293fa0-5535-461e-84ca-f6cdbc5b6f79',
        '2ae0ea4d-43eb-4f82-a998-51694f442b1b',
      ],
      [
        'b14d60c2-209d-4335-b28c-ecd55727584e',
        'fa5f8903-eba4-4f49-902c-778b7990170e',
        '8d5f551d-59d0-46f9-8a61-bf81469df9c3',
      ],
      [
        'd49e5d2e-3241-45e1-9d64-1ec1095bdd71',
        'fe1c94d3-61b2-46c5-97a9-a690a2771bca',
        'f35c4c9c-b388-40b2-af26-abacb7edc980',
      ],
    ]) {
      expect(migration).toContain(eventId);
      expect(migration).toContain(requestId);
      expect(migration).toContain(evidenceId);
    }
    expect(migration).toContain("'failureCode', 'BILLING_CURRENCY_MIGRATION_REQUIRED'");
    expect(migration).toContain("'failureReason', 'settlement_anchor_missing'");
    expect(migration).toContain("'errorFingerprint',");
    expect(migration).toContain(
      'f7c470fb73da49f0ed8b517ec5993e0c3a1796e08b4b8835c03d96fb9364d137',
    );
    expect(migration).toContain("credit_row.\"request_id\" = expected.request_id");
    expect(migration).toContain('"credit_transactions"');
    for (const absentFact of [
      'gateway_usage_settlement_anchors',
      'gateway_usage_funding_reservations',
      'gateway_usage_settlement_receipts',
      'token_usage',
      'gateway_usage_reconciliation_actions',
      'gateway_usage_platform_losses',
      'usage_loss_recognition_claims',
      'historical_platform_loss_lines',
    ]) {
      expect(migration).toContain(`FROM "${absentFact}"`);
    }
  });

  it('hashes before/after financial and event envelopes under a drained lock set', () => {
    expect(migration).toContain('LOCK TABLE');
    expect(migration).toContain('IN SHARE MODE');
    expect(migration).toContain("PERFORM set_config('lock_timeout', '5s', TRUE)");
    expect(migration).toContain('"balance_grant_refund_allocations"');
    expect(migration).toContain("'creditTransactions'");
    expect(migration).toContain("'gatewayUsageEvidences'");
    expect(migration).toContain("'usageLossRecognitionClaims'");
    expect(migration).toContain("'historicalPlatformLossLines'");
    expect(migration).toContain('financial_after IS DISTINCT FROM financial_before');
    expect(migration).toContain("'failureReason', eligible.\"failure_reason\"");
    expect(migration).toContain("'errorFingerprint', eligible.\"error_fingerprint\"");
    expect(migration).not.toContain('receipt_row."billing_account_id"');
  });

  it('keeps audit immutable, runtime-readable and Prisma-governed', () => {
    expect(migration.match(/EXECUTE FUNCTION\s+"reject_billing_account_currency_label_repair_audit_mutation"\(\)/g))
      .toHaveLength(3);
    expect(migration).toContain(
      'GRANT SELECT ON TABLE\n  "billing_account_currency_label_repair_eligible_events" TO PUBLIC',
    );
    expect(migration).toContain(
      'REVOKE INSERT, UPDATE, DELETE, TRUNCATE, REFERENCES, TRIGGER',
    );
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION\n  "apply_legacy_billing_account_currency_label_repair_v1"',
    );
    expect(schema).toContain('model BillingAccountCurrencyLabelRepairRun');
    expect(schema).toContain('model BillingAccountCurrencyLabelRepairItem');
    expect(schema).toContain('model BillingAccountCurrencyLabelRepairEligibleEvent');
    expect(schema).toContain('failureReason         String   @map("failure_reason")');
    expect(schema).toContain('errorFingerprint      String   @map("error_fingerprint")');
    expect(schema).toContain('map: "billing_currency_repair_events_event_fkey"');
    expect(schema).toContain('map: "billing_currency_repair_events_evidence_fkey"');
  });

  it('ships a strict install verifier and maintenance-first runbook', () => {
    expect(verification).toContain('BEGIN TRANSACTION READ ONLY');
    expect(verification).toContain(
      'billing_accounts.currency must not have a silent default',
    );
    expect(verification).toContain('target_account_count NOT IN (0, 10)');
    expect(verification).toContain('install verifier found pre-existing/applied repair audit rows');
    expect(verification).toContain('currency label repair runtime SELECT ACL incomplete');
    expect(verification).toContain('currency label repair PUBLIC function execute ACL exists');
    expect(runbook).toContain('先进入维护窗口');
    expect(runbook).toContain('consumer disabled/replicas=0');
    expect(runbook).toContain('install-only Prisma migration');
    expect(runbook).toContain('LABEL_ONLY_NO_FX');
    expect(runbook).toContain('只能保持停写并以前滚修复恢复服务');
    expect(runbook).toContain('Publisher');
  });

  it('does not rely on PostgreSQL-truncated identifiers', () => {
    const quotedIdentifiers = ids(migration, /"[A-Za-z_][A-Za-z0-9_]*"/g)
      .map((identifier) => identifier.slice(1, -1));
    const overlong = [...new Set(quotedIdentifiers)]
      .filter((identifier) => Buffer.byteLength(identifier, 'utf8') > 63);
    expect(overlong).toEqual([]);
  });
});
