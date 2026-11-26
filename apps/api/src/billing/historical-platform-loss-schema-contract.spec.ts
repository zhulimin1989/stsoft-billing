import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('historical platform loss PostgreSQL contract', () => {
  const migration = readFileSync(resolve(
    __dirname,
    '../../prisma/migrations/20260806000122_historical_platform_loss_batches/migration.sql',
  ), 'utf8').replace(/\r\n/g, '\n');

  it('keeps customer funding immutable and server totals algebraically constrained', () => {
    expect(migration).toContain('"customer_deduction" = 0');
    expect(migration).toContain(
      '"customer_absorbed_delta" =\n      "platform_amount_corrected" - "platform_amount_before"',
    );
    expect(migration).toContain(
      '"provider_cost_delta" =\n      "provider_cost_corrected" - "provider_cost_before"',
    );
    expect(migration).toContain('"usage_delta" = "provider_usage" - "platform_usage"');
  });

  it('enforces maker-checker, CAS terminal shape and permanent idempotency', () => {
    expect(migration).toContain('"maker_actor_id" <> "checker_actor_id"');
    expect(migration).toContain('"status" IN (\'PREPARED\', \'POSTED\')');
    expect(migration).toContain('"revision" IN (0, 1)');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "historical_platform_loss_batches_create_idempotency_key"',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "historical_platform_loss_batches_post_idempotency_key"',
    );
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "historical_platform_loss_actions_idempotency_key"',
    );
  });

  it('makes posted batches, source rows, actions, coverage modes and claims append-only', () => {
    expect(migration).toContain('historical_platform_loss_batches_mutation_guard');
    expect(migration).toContain("IF OLD.\"status\" = 'POSTED'");
    expect(migration).toContain('historical_platform_loss_lines_append_only');
    expect(migration).toContain('historical_platform_loss_actions_append_only');
    expect(migration).toContain('usage_loss_coverage_registry_append_only');
    expect(migration).toContain('usage_loss_recognition_claims_append_only');
  });

  it('separates a reusable REQUEST coverage mode from unique aggregate row claims', () => {
    expect(migration).toContain('CREATE TABLE "usage_loss_coverage_registry"');
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "usage_loss_coverage_registry_coverage_key_key"',
    );
    expect(migration).toContain('"granularity_mode" IN (\'REQUEST\', \'AGGREGATE\')');
    expect(migration).toContain('CREATE INDEX "usage_loss_coverage_registry_scope_idx"');
  });

  it('has a single global key shared by per-request and historical recognition', () => {
    expect(migration).toContain(
      'CREATE UNIQUE INDEX "usage_loss_recognition_claims_recognition_key_key"',
    );
    expect(migration).toContain("'ABSORB_DELTA'");
    expect(migration).toContain("'HISTORICAL_BATCH'");
    expect(migration).toContain("'PROVIDER_AGGREGATE_SOURCE'");
    expect(migration).toContain("'PROVIDER_AGGREGATE_COVERAGE'");
  });
});
