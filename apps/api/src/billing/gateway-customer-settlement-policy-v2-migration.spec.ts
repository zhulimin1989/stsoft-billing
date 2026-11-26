import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Gateway customer settlement policy v2 migration', () => {
  const predecessor = readFileSync(resolve(
    __dirname,
    '../../prisma/migrations/20260811000127_gateway_financial_terminal_provider_evidence_decoupling/migration.sql',
  ), 'utf8').replace(/\r\n/g, '\n');
  const migration = readFileSync(resolve(
    __dirname,
    '../../prisma/migrations/20260816000104_gateway_customer_settlement_policy_v2/migration.sql',
  ), 'utf8').replace(/\r\n/g, '\n');
  const verification = readFileSync(resolve(
    __dirname,
    '../../prisma/migrations/20260816000104_gateway_customer_settlement_policy_v2/verify.sql',
  ), 'utf8').replace(/\r\n/g, '\n');

  const extractFunction = (source: string, functionName: string): string => {
    const definition = source.match(new RegExp(
      `CREATE OR REPLACE FUNCTION ${functionName}\\([\\s\\S]*?\\$\\$ LANGUAGE plpgsql;`,
    ))?.[0];
    expect(definition).toBeDefined();
    return definition!;
  };

  const extractTaggedBlock = (tag: string): string => {
    const block = migration.match(new RegExp(
      `\\$${tag}\\$\\n([\\s\\S]*?)\\$${tag}\\$;`,
    ))?.[1];
    expect(block).toBeDefined();
    return block!;
  };

  const balanceProof = extractFunction(
    predecessor,
    'assert_gateway_balance_customer_financial_authority',
  );
  const creditsProof = extractFunction(
    predecessor,
    'assert_gateway_financial_receipt_terminal_pair',
  );
  const balanceLegacyPolicy = extractTaggedBlock('balance_legacy_policy_contract');
  const balanceCurrentPolicy = extractTaggedBlock('balance_current_policy_contract');
  const balanceLegacyExactBasis = extractTaggedBlock('balance_legacy_exact_basis_contract');
  const balanceCurrentExactBasis = extractTaggedBlock('balance_current_exact_basis_contract');
  const creditsLegacyPolicy = extractTaggedBlock('credits_legacy_policy_contract');
  const creditsCurrentPolicy = extractTaggedBlock('credits_current_policy_contract');
  const creditsLegacyExactBasis = extractTaggedBlock('credits_legacy_exact_basis_contract');
  const creditsCurrentExactBasis = extractTaggedBlock('credits_current_exact_basis_contract');
  const patchedBalance = balanceProof
    .replace(balanceLegacyPolicy, balanceCurrentPolicy)
    .replace(balanceLegacyExactBasis, balanceCurrentExactBasis);
  const patchedCredits = creditsProof
    .replace(creditsLegacyPolicy, creditsCurrentPolicy)
    .split(creditsLegacyExactBasis).join(creditsCurrentExactBasis);

  it('matches and replaces only the expected predecessor proof fragments', () => {
    expect(balanceProof.split(balanceLegacyPolicy)).toHaveLength(2);
    expect(balanceProof.split(balanceLegacyExactBasis)).toHaveLength(2);
    expect(creditsProof.split(creditsLegacyPolicy)).toHaveLength(2);
    expect(creditsProof.split(creditsLegacyExactBasis)).toHaveLength(3);

    expect(patchedBalance
      .replace(balanceCurrentExactBasis, balanceLegacyExactBasis)
      .replace(balanceCurrentPolicy, balanceLegacyPolicy))
      .toBe(balanceProof);
    expect(patchedCredits
      .split(creditsCurrentExactBasis).join(creditsLegacyExactBasis)
      .replace(creditsCurrentPolicy, creditsLegacyPolicy))
      .toBe(creditsProof);
  });

  it('binds only v2 authority to the immutable first-receipt anchor', () => {
    for (const proof of [patchedBalance, patchedCredits]) {
      expect(proof).toContain('customerSettlementPolicyVersion');
      expect(proof).toContain('gateway-customer-settlement-v2');
      expect(proof).not.toContain('gateway-customer-settlement-v1');
      expect(proof).not.toContain('ZERO_PRICED_OMITTED_DIMENSION');
      expect(proof).toContain('NORMALIZED_EXACT');
      expect(proof).toContain('CUSTOMER_PROTECTIVE_ZERO');
    }
    expect(balanceCurrentPolicy).toContain(
      "authority->>'policyVersion' IS DISTINCT FROM",
    );
    expect(creditsCurrentPolicy).toContain(
      "customer_settlement->>'policyVersion' IS DISTINCT FROM",
    );
  });

  it('retains the predecessor fragment only as the exact replacement source', () => {
    for (const predecessorPolicy of [balanceLegacyPolicy, creditsLegacyPolicy]) {
      expect(predecessorPolicy).toContain('gateway-customer-settlement-v1');
      expect(predecessorPolicy).toContain('ZERO_PRICED_OMITTED_DIMENSION');
    }
    for (const predecessorExactBasis of [
      balanceLegacyExactBasis,
      creditsLegacyExactBasis,
    ]) {
      expect(predecessorExactBasis).toContain('ZERO_PRICED_OMITTED_DIMENSION');
    }
    for (const currentPolicy of [
      balanceCurrentPolicy,
      balanceCurrentExactBasis,
      creditsCurrentPolicy,
      creditsCurrentExactBasis,
    ]) {
      expect(currentPolicy).not.toContain('gateway-customer-settlement-v1');
      expect(currentPolicy).not.toContain('ZERO_PRICED_OMITTED_DIMENSION');
    }
  });

  it('rejects new NULL/v1 anchors without scanning or rewriting predecessor rows', () => {
    expect(migration.trimStart().startsWith('-- New first receipts')).toBe(true);
    expect(migration).toContain('\nBEGIN;\n');
    expect(migration.trimEnd().endsWith('COMMIT;')).toBe(true);
    expect(migration).toContain(
      'ADD CONSTRAINT "gateway_usage_settlement_anchors_customer_policy_v2_check"',
    );
    expect(migration).toContain(
      "IS NOT DISTINCT FROM 'gateway-customer-settlement-v2'",
    );
    expect(migration).toContain(') NOT VALID;');
    expect(migration).not.toContain('VALIDATE CONSTRAINT');
    expect(migration).not.toContain(
      'FROM "gateway_usage_settlement_anchors" AS anchor',
    );
    expect(migration.indexOf(
      'ADD CONSTRAINT "gateway_usage_settlement_anchors_customer_policy_v2_check"',
    )).toBeGreaterThan(migration.lastIndexOf('EXECUTE patched_definition;'));
  });

  it('preserves unrelated financial terminal proofs and function identity', () => {
    for (const marker of [
      'settled_amount IS DISTINCT FROM reservation."authoritative_amount_usd"',
      'settled_charge IS DISTINCT FROM usage."customer_charge_usd"',
      'FROM "balance_transactions" AS tx',
      'FROM "balance_consumption_allocations" AS allocation',
    ]) {
      expect(patchedBalance).toContain(marker);
    }
    for (const marker of [
      'PERFORM assert_gateway_token_usage_terminal_pair(usage."id");',
      'PERFORM assert_gateway_balance_customer_financial_authority(receipt."id");',
      'gateway positive CREDITS mutation proof is inconsistent',
      'gateway zero-priced CREDITS proof is inconsistent',
      'gateway included-upstream CREDITS proof is inconsistent',
      'gateway CREDITS DEBT_OPEN receipt proof is inconsistent',
    ]) {
      expect(patchedCredits).toContain(marker);
    }
    expect(migration).toContain('target_owner OID');
    expect(migration).toContain('target_acl ACLITEM[]');
    expect(migration).toContain('terminal_oid IS DISTINCT FROM target_oid');
    expect(migration).toContain('terminal_owner IS DISTINCT FROM target_owner');
    expect(migration).toContain('terminal_acl IS DISTINCT FROM target_acl');
    expect(migration.match(/EXECUTE patched_definition;/g)).toHaveLength(2);
  });

  it('verifies both proof functions and their deferred reverse-proof triggers', () => {
    expect(verification).toContain(
      "'public.assert_gateway_balance_customer_financial_authority(text)'::regprocedure",
    );
    expect(verification).toContain(
      "'public.assert_gateway_financial_receipt_terminal_pair(text)'::regprocedure",
    );
    expect(verification).toContain('customerSettlementPolicyVersion');
    expect(verification).toContain('gateway-customer-settlement-v2');
    expect(verification).toContain(
      'gateway_usage_settlement_anchors_customer_policy_v2_check',
    );
    expect(verification).not.toContain('convalidated');
    expect(verification).not.toContain('anchor_policy_violation_count');
    expect(verification).not.toContain(
      'FROM "gateway_usage_settlement_anchors" AS anchor',
    );
    expect(verification).toContain('gateway_usage_settlement_receipts_terminal_pair');
    expect(verification).toContain('credit_transactions_gateway_terminal_pairs');
    expect(verification).toContain('terminal_trigger_count <> 2');
  });

  it('verifies the complete supported catalog rendering without token rewriting', () => {
    expect(verification).toContain(
      'pg_get_expr(constraint_row.conbin, constraint_row.conrelid, FALSE)',
    );
    expect(verification).toContain(
      "'(NOT ((canonical_payload ->> ''customerSettlementPolicyVersion''::text) '",
    );
    expect(verification).toContain(
      "|| 'IS DISTINCT FROM ''gateway-customer-settlement-v2''::text))'",
    );
    expect(verification).not.toContain('regexp_replace(');
    expect(verification).not.toContain('translate(');
  });

  it('does not update historical anchors, receipts, or usage rows', () => {
    expect(migration).not.toMatch(/\b(?:INSERT|UPDATE|DELETE)\s+(?:INTO\s+|FROM\s+)?"/i);
  });
});
