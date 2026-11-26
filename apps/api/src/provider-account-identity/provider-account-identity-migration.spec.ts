import { readFileSync } from 'node:fs';
import { join } from 'node:path';
import { PROVIDER_ACCOUNT_IDENTITY_BLOCKING_REFERENCE_ERROR } from './provider-account-identity.policy';

const migrationSql = readFileSync(
  join(
    __dirname,
    '../../prisma/migrations/20260811000100_provider_account_identities/migration.sql',
  ),
  'utf8',
);

describe('provider account identity migration lifecycle guards', () => {
  it('serializes all child binding paths with identity row share locks', () => {
    expect(migrationSql).toContain(
      'CREATE FUNCTION "validate_provider_account_identity_binding"()',
    );
    expect(migrationSql).toMatch(
      /FROM "provider_account_identities" AS "identity"[\s\S]+?FOR SHARE;/,
    );
    expect(migrationSql).toMatch(
      /FROM "coding_plan_provider_lines" AS "line"[\s\S]+?FOR SHARE;/,
    );

    for (const table of [
      'channels',
      'coding_plan_provider_lines',
      'coding_plan_provider_entitlements',
    ]) {
      expect(migrationSql).toMatch(new RegExp(
        `CREATE TRIGGER "[^"]+"[\\s\\S]+?ON "${table}"[\\s\\S]+?`
        + 'EXECUTE FUNCTION "validate_provider_account_identity_binding"\\(\\);',
      ));
    }
    expect(migrationSql).toContain('provider_account_identity_inactive');
    expect(migrationSql).toContain('provider_account_identity_provider_mismatch');
  });

  it('performs a final blocking-reference check under the identity update lock', () => {
    expect(migrationSql).toContain(
      'CREATE FUNCTION "enforce_provider_account_identity_lifecycle"()',
    );
    expect(migrationSql).toContain(PROVIDER_ACCOUNT_IDENTITY_BLOCKING_REFERENCE_ERROR);
    expect(migrationSql).toMatch(
      /FROM "channels" AS "channel"[\s\S]+?"channel"\."deleted_at" IS NULL/,
    );
    expect(migrationSql).toMatch(
      /FROM "coding_plan_provider_lines" AS "line"[\s\S]+?"line"\."provider_account_identity_id" = OLD\."id"/,
    );
    expect(migrationSql).toMatch(
      /FROM "coding_plan_provider_entitlements" AS "entitlement"[\s\S]+?"entitlement"\."status" = 'ACTIVE'/,
    );
    expect(migrationSql).toMatch(
      /BEFORE UPDATE OF "id", "provider_account_ref", "provider_code", "status"[\s\S]+?ON "provider_account_identities"/,
    );
  });

  it('protects stable identity fields and provider-line authority at the database boundary', () => {
    expect(migrationSql).toContain('provider_account_identity_immutable_fields');
    expect(migrationSql).toMatch(
      /NEW\."provider_account_ref" IS DISTINCT FROM OLD\."provider_account_ref"/,
    );
    expect(migrationSql).toMatch(
      /NEW\."provider_code" IS DISTINCT FROM OLD\."provider_code"/,
    );
    expect(migrationSql).toContain('coding_plan_provider_line_provider_change_has_entitlements');
    expect(migrationSql).toContain('coding_plan_provider_line_identity_change_has_entitlements');
    expect(migrationSql).toContain('provider_account_identity_provider_line_identity_mismatch');
    expect(migrationSql).toContain('active_provider_entitlement_identity_required');
    expect(migrationSql).toMatch(
      /BEFORE UPDATE OF "status"[\s\S]+?WHEN \(NEW\."status" = 'ACTIVE'\)[\s\S]+?validate_provider_account_identity_binding/,
    );
    expect(migrationSql).toMatch(
      /SELECT[\s\S]+?"line"\."provider_account_identity_id"[\s\S]+?FOR SHARE;/,
    );
    expect(migrationSql).toContain("IF \"normalized_code\" = 'moonshot'");
  });
});
