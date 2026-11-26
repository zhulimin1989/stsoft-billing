import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Beijing nprod BillingAccount currency-label repair v2 migration', () => {
  const migration = readFileSync(resolve(
    __dirname,
    '../../prisma/migrations/20260813000102_beijing_nprod_currency_label_repair_v2/migration.sql',
  ), 'utf8').replace(/\r\n/g, '\n');
  const verification = readFileSync(resolve(
    __dirname,
    '../../prisma/migrations/20260813000102_beijing_nprod_currency_label_repair_v2/verify.sql',
  ), 'utf8').replace(/\r\n/g, '\n');
  const legacyMigration = readFileSync(resolve(
    __dirname,
    '../../prisma/migrations/20260813000100_legacy_billing_account_currency_label_repair/migration.sql',
  ), 'utf8').replace(/\r\n/g, '\n');

  it('is install-only and exposes one fixed owner-only apply authority', () => {
    expect(migration).toContain('This migration never changes account data');
    expect(migration).toContain(
      '"apply_legacy_billing_account_currency_label_repair_v2"',
    );
    expect(migration).not.toMatch(
      /SELECT\s+\*\s+FROM\s+"?apply_legacy_billing_account_currency_label_repair_v2"?\s*\(/,
    );
    expect(migration).toContain('SECURITY DEFINER');
    expect(migration).toContain('SET search_path = pg_catalog, public');
    expect(migration).toContain(
      'REVOKE ALL ON FUNCTION\n  "apply_legacy_billing_account_currency_label_repair_v2"',
    );
  });

  it('pins the target database and the complete 71/6/2 evidence set', () => {
    for (const fixed of [
      'beijing-nprod-legacy-usd-label-v2',
      'ruidong_billing_v2',
      '3f8df065-d032-4728-939a-db8fd4735533',
      '7610171897653500696',
      '40312',
      '273fe03908a9d463556a6e9e5c60faba681c480d62064447f4f1b765051340e5',
      '0c5a77ad9b63b31b444041c33570997655c7187ac5bdfac37cc0cabe9758510b',
      '856224622e1dd48ecff2b64fb6f502d9bd707eca237316b1cca503f7e8cfe59e',
      '18312e4653fb9a6755f2bf99280cd4037ab3a1a25828a22d8ee2e08e43a9ef4f',
      '36ac0df9c711fb81145f586014671f57880967c96f0b13c197f56d21d2a64f54',
      '278afb0d2e2bc285d3634f092eb449387e70aed3137245ccb60040839d5d891c',
      'a52989fd9f96c0a36afedc82dacbd4a6fd5bddc7cc89899325ad6c8223cc1869',
      '75e2e9851e54385620d4091d0cfb531d1bd18a00f324edb16a77877a5b6b6000',
      '39a875f0368f92e39d4e308620885b8423f4f074ad7c79a109c271e0fc028ef3',
    ]) expect(migration).toContain(fixed);
    expect(migration).toContain('expected_account_count CONSTANT INTEGER := 71');
    expect(migration).toContain('expected_active_count CONSTANT INTEGER := 68');
    expect(migration).toContain('expected_deleted_count CONSTANT INTEGER := 3');
    expect(migration).toContain('expected_pending_count CONSTANT INTEGER := 6');
    expect(migration).toContain('expected_event_count CONSTANT INTEGER := 2');
    expect(migration).toContain('COUNT(*) INTO valid_count\n  FROM "billing_accounts" WHERE "currency" = source_currency');
  });

  it('models active, deleted, negative-wallet and credit-config branches', () => {
    expect(migration.match(/'DELETED_INERT_MEMBER_METADATA'/g)?.length)
      .toBeGreaterThanOrEqual(5);
    expect(migration).toContain('"billing_account_members",');
    expect(migration).toContain('expected_deleted_member_count CONSTANT INTEGER := 3');
    expect(migration).toContain('same_account."billing_account_id"');
    expect(migration).not.toContain("'DELETED_EMPTY'");
    for (const id of [
      'f3290f30-7823-4b48-bb8b-0acc0a4aa6a5',
      'c9b72ee7-1874-4dc4-9512-b35f62f10f76',
      '7a97a62e-ebb2-4568-992c-ac1f921ec92a',
    ]) expect(migration).toContain(id);
    expect(migration).toContain('ACTIVE_NEGATIVE_WALLET_RECONCILED');
    expect(migration).toContain('-0.024176940000');
    expect(migration).toContain('5.024176940000');
    expect(migration).not.toContain('wallet_row."balance_usd" >= 0');
    expect(migration).toContain('wallet_row."balance_usd" <> 0');
    expect(migration).toContain('JOIN "tenants" tenant_row ON tenant_row."id" = usage_row."tenant_id"');
    expect(migration).toContain('JOIN "tenants" tenant_row ON tenant_row."id" = api_key_row."tenant_id"');
    expect(migration).toContain('credit."limit_usd" = 100.000000000000');
    expect(migration).toContain('credit."policy_boundary_complete" = TRUE');
    expect(migration).toContain('expected_ledger_exception_count CONSTANT INTEGER := 8');
    expect(migration).toContain('actual_ledger_exception_proof_hash');
    expect(migration).toContain('expected.authoritative_repair_account_id');
    expect(migration).toContain("cover.run_status = 'COMPLETED'");
    expect(migration).toContain("source_account.\"after_snapshot\" IS NULL");
    expect(migration).toContain("running_account.\"status\" = 'RUNNING'");
    expect(migration).toContain('expected_invoice_application_count CONSTANT INTEGER := 20');
    expect(migration).toContain('expected_invoice_item_count CONSTANT INTEGER := 25');
    expect(migration).toContain('expected_invoice_event_count CONSTANT INTEGER := 54');
    expect(migration).toContain('"invoice_applications",');
    expect(migration).toContain('"invoice_event_log",');
    expect(migration).toContain('invoice_snapshot_after IS DISTINCT FROM invoice_snapshot_before');
  });

  it('binds six inert CNY pending orders and two exact terminal-proof events', () => {
    expect(migration).toContain("order_row.\"checkout_init_state\"::TEXT\n      IS DISTINCT FROM expected.checkout_init_state");
    expect(migration).toContain('order_row."checkout_pay_url_encrypted" IS NOT NULL');
    expect(migration).toContain('order_row."checkout_context_encrypted" IS NOT NULL');
    expect(migration).toContain("'COMPLETED', jsonb_build_object('count', 55");
    expect(migration).toContain("'REFUNDED', jsonb_build_object('count', 1");
    for (const id of [
      'c2dcf794-34e1-44d1-a9e3-d33e2aa5d11c',
      '4dac4cae-3437-48a2-968c-30f1144be230',
      '70440d31-5730-4906-8dbd-dd5b430e1cc5',
      '62761674-c2e4-4807-be7d-8cd606ae0ed7',
    ]) expect(migration).toContain(id);
    expect(migration).toContain("'failureReason', 'settlement_anchor_missing'");
    expect(migration).toContain("event_row.\"status\" = 'QUARANTINED'");
    expect(migration).toContain("evidence_row.\"source\" = 'GATEWAY_USAGE_EVENT'");
    expect(migration).toContain("restriction_row.\"reason\" = 'settlement_policy_review'");
    expect(migration).toContain("intent_row.\"status\" = 'SUCCEEDED'");
    expect(migration).toContain("intent_row.\"restriction_status\" = 'ACTIVE'");
    expect(migration).toContain('same_event.\"gateway_billing_event_id\" = event_row.\"id\"');
  });

  it('keeps the label update CAS-only, financially byte-stable and retry-safe', () => {
    expect(migration).toContain('LOCK TABLE');
    expect(migration).toContain('IN SHARE MODE');
    expect(migration).toContain("PERFORM set_config('lock_timeout', '5s', TRUE)");
    expect(migration).toContain("requested_confirmation IS DISTINCT FROM 'LABEL_ONLY_NO_FX'");
    expect(migration).toContain('AND "currency" = source_currency');
    expect(migration).toContain('financial_after IS DISTINCT FROM financial_before');
    expect(migration).toContain('Same-parameter retries return the already verified terminal proof');
    expect(migration).toContain(
      "current_setting('transaction_isolation') IS DISTINCT FROM 'read committed'",
    );
    expect(migration).toContain(
      'pg_advisory_xact_lock(60813, hashtext(target_manifest_version))',
    );
    expect(migration).toContain('billing_accounts_currency_immutable');
    expect(migration).toContain("trigger_row.tgenabled = 'O'");
    expect(migration).toContain('valid_count IS DISTINCT FROM 4::BIGINT');
    expect(migration).toContain('existing_run_row."manifest_version"');
    expect(migration).toContain('item_count."run_id" = operation_run_id');
    expect(migration).toContain('event_count."run_id" = operation_run_id');
    expect(migration).not.toContain('WHERE "manifest_version" = target_manifest_version');
    expect(migration).not.toContain('WHERE "run_id" = operation_run_id');
    expect(migration).not.toContain('current financial equals the original snapshot');
  });

  it('only extends the immutable trigger allowlist by the exact v2 authority', () => {
    const immutable = migration.slice(
      migration.indexOf('CREATE OR REPLACE FUNCTION enforce_billing_account_currency_immutability'),
      migration.indexOf('CREATE OR REPLACE FUNCTION "billing_account_currency_label_evidence_v2"'),
    );
    expect(immutable).toContain('shanghai-uat-legacy-usd-label-v1');
    expect(immutable).toContain('beijing-nprod-legacy-usd-label-v2');
    expect(immutable).toContain('billing.currency_label_repair_run_id');
    expect(immutable).toContain('item."before_account_snapshot" = to_jsonb(OLD)');
    expect(immutable).toContain('item."after_account_snapshot" = to_jsonb(NEW)');
    expect(immutable).not.toContain('requested_manifest_version');
    expect(legacyMigration).not.toContain('beijing-nprod-legacy-usd-label-v2');
  });

  it('ships a read-only no-op/partial-cohort install verifier', () => {
    expect(verification).toContain('BEGIN TRANSACTION READ ONLY');
    expect(verification).toContain('target_locator AND (');
    expect(verification).toContain('target_count <> 71');
    expect(verification).toContain('target_count <> target_usd_count');
    expect(verification).toContain("current_database() = 'ruidong_billing_v2'");
    expect(verification).toContain('current_system_identifier = 7610171897653500696');
    expect(verification).toContain(
      'rollout_row.\"database_identity\"',
    );
    expect(verification).toContain('= \'3f8df065-d032-4728-939a-db8fd4735533\'::UUID');
    expect(verification).toContain('PUBLIC execute ACL exists');
    expect(verification).toContain('billing_accounts_currency_immutable');
    expect(verification).toContain("trigger_row.tgenabled = 'O'");
    expect(verification).toContain('matched_trigger_count <> 4');
    expect(verification).not.toMatch(
      /SELECT\s+\*\s+FROM\s+"?apply_legacy_billing_account_currency_label_repair_v2"?\s*\(/,
    );
    expect(verification).toContain('ROLLBACK;');
  });

  it('does not rely on PostgreSQL-truncated identifiers', () => {
    const quoted = [...migration.matchAll(/"[A-Za-z_][A-Za-z0-9_]*"/g)]
      .map((match) => match[0].slice(1, -1));
    const overlong = [...new Set(quoted)]
      .filter((identifier) => Buffer.byteLength(identifier, 'utf8') > 63);
    expect(overlong).toEqual([]);
  });
});
