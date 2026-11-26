import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('legacy currency-label v1 apply name-resolution hotfix', () => {
  const migration = readFileSync(resolve(
    __dirname,
    '../../prisma/migrations/20260813000103_legacy_currency_label_v1_apply_name_resolution_hotfix/migration.sql',
  ), 'utf8');
  const verification = readFileSync(resolve(
    __dirname,
    '../../prisma/migrations/20260813000103_legacy_currency_label_v1_apply_name_resolution_hotfix/verify.sql',
  ), 'utf8');
  const legacyMigration = readFileSync(resolve(
    __dirname,
    '../../prisma/migrations/20260813000100_legacy_billing_account_currency_label_repair/migration.sql',
  ), 'utf8');

  it('guards the exact old and repaired canonical definitions', () => {
    expect(migration).toContain(
      '9393da93528cb65b011b8f2ee1b174c22b8d81539dd1e7c96e8fd4f823b11c2a',
    );
    expect(migration).toContain(
      '5bd33cfa9c1440081e852ba9255af7d3ed4679a11f1d325ac078ded2997943ed',
    );
    expect(migration).toContain('pg_get_functiondef(target_function_oid)');
    expect(migration).toContain('unknown definition shape');
    expect(migration).toContain('EXECUTE repaired_definition');
    expect(migration).toContain(
      'target_function_owner IS DISTINCT FROM current_user::regrole::OID',
    );
    expect(migration).toContain('aclexplode(COALESCE(');
    expect(migration).toContain(
      'terminal_function_acl IS DISTINCT FROM target_function_acl',
    );
  });

  it('only qualifies the three ambiguous table-column references', () => {
    expect(migration).toContain('existing_run_row."manifest_version"');
    expect(migration).toContain('terminal_item."run_id"');
    expect(migration).toContain('terminal_event."run_id"');
    expect(migration.match(/replace\(/g)).toHaveLength(3);
    expect(legacyMigration).toContain('WHERE "manifest_version" = target_manifest_version');
    expect(legacyMigration.match(/WHERE "run_id" = operation_run_id/g))
      .toHaveLength(2);
  });

  it('is idempotent only for the exact repaired definition', () => {
    expect(migration).toContain(
      'IF current_definition_hash = expected_repaired_definition_hash THEN',
    );
    expect(migration).toContain('RETURN;');
    expect(migration).toContain(
      'pg_advisory_xact_lock(60814, hashtext(target_signature))',
    );
  });

  it('ships a read-only verifier for shape, ACL and terminal migration', () => {
    expect(verification).toContain('BEGIN TRANSACTION READ ONLY');
    expect(verification).toContain(
      '20260813000103_legacy_currency_label_v1_apply_name_resolution_hotfix',
    );
    expect(verification).toContain('existing_run_row."manifest_version"');
    expect(verification).toContain('terminal_item."run_id"');
    expect(verification).toContain('terminal_event."run_id"');
    expect(verification).toContain(
      'target_function_owner IS DISTINCT FROM current_user::regrole::OID',
    );
    expect(verification).toContain('acl_entry_count <> 1');
    expect(verification).toContain('acl_entry.is_grantable');
    expect(verification).toContain('ROLLBACK;');
  });
});
