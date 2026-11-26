import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Gateway financial terminal / provider evidence authority decoupling migration', () => {
  const predecessor = readFileSync(resolve(
    __dirname,
    '../../prisma/migrations/20260807000126_gateway_terminal_proof_incremental/migration.sql',
  ), 'utf8').replace(/\r\n/g, '\n');
  const migration = readFileSync(resolve(
    __dirname,
    '../../prisma/migrations/20260811000127_gateway_financial_terminal_provider_evidence_decoupling/migration.sql',
  ), 'utf8').replace(/\r\n/g, '\n');
  const verification = readFileSync(resolve(
    __dirname,
    '../../prisma/migrations/20260811000127_gateway_financial_terminal_provider_evidence_decoupling/verify.sql',
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

  const removeExactlyOnce = (source: string, block: string): string => {
    expect(source.split(block)).toHaveLength(2);
    return source.replace(block, '');
  };

  const fundingProof = extractFunction(
    predecessor,
    'assert_gateway_usage_funding_terminal',
  );
  const predecessorCreditsReceiptProof = extractFunction(
    predecessor,
    'assert_gateway_financial_receipt_terminal_pair',
  );
  const predecessorTokenUsageProof = extractFunction(
    predecessor,
    'assert_gateway_token_usage_terminal_pair',
  );
  const creditsReceiptProof = extractFunction(
    migration,
    'assert_gateway_financial_receipt_terminal_pair',
  );
  const balanceBuildAuthorityGate = extractTaggedBlock(
    'balance_build_authority_gate',
  );
  const noChargeBuildAuthorityGate = extractTaggedBlock(
    'no_charge_build_authority_gate',
  );
  const fundingProofWithoutBuildAuthority = removeExactlyOnce(
    removeExactlyOnce(fundingProof, balanceBuildAuthorityGate),
    noChargeBuildAuthorityGate,
  );
  const legacyReceiptFilter = '"policy_version" = \'gateway-settlement-v2\'';
  const currentReceiptFilter = '"policy_version" IN (\'gateway-settlement-v2\', '
    + '\'gateway-settlement-v3-customer-authority\')';
  expect(fundingProofWithoutBuildAuthority.split(legacyReceiptFilter)).toHaveLength(5);
  const patchedFundingProof = fundingProofWithoutBuildAuthority
    .split(legacyReceiptFilter)
    .join(currentReceiptFilter);
  const tokenReceiptFilter =
    'receipt_row."policy_version" = \'gateway-settlement-v2\'';
  expect(predecessorTokenUsageProof.split(tokenReceiptFilter)).toHaveLength(2);
  const patchedTokenUsageProof = predecessorTokenUsageProof.replace(
    tokenReceiptFilter,
    'receipt_row."policy_version" IN (\'gateway-settlement-v2\', '
      + '\'gateway-settlement-v3-customer-authority\')',
  );
  it('removes only the three current-build authority gates from customer terminals', () => {
    expect(fundingProof.match(
      /gateway_usage_evidence_has_current_build_authority\(/g,
    )).toHaveLength(2);
    expect(predecessorCreditsReceiptProof.match(
      /gateway_usage_evidence_has_current_build_authority\(/g,
    )).toHaveLength(1);

    expect(patchedFundingProof).not.toContain(
      'gateway_usage_evidence_has_current_build_authority(',
    );
    expect(creditsReceiptProof).not.toContain(
      'gateway_usage_evidence_has_current_build_authority(',
    );
    expect(patchedFundingProof).not.toContain(
      'gateway financial settlement build authority is not current',
    );

    expect(migration).toContain(
      "'public.assert_gateway_usage_funding_terminal(text)'::regprocedure",
    );
    expect(migration).toContain(
      'CREATE OR REPLACE FUNCTION assert_gateway_financial_receipt_terminal_pair',
    );
    expect(migration.match(/EXECUTE patched_definition;/g)).toHaveLength(2);
    expect(migration).toContain(
      'did not apply the required decoupling markers',
    );
  });

  it('extends only the predecessor receipt lookups to typed v3 authority receipts', () => {
    expect(patchedFundingProof).toContain(currentReceiptFilter);
    expect(patchedFundingProof).not.toContain(legacyReceiptFilter);
    expect(patchedTokenUsageProof).toContain(
      'receipt_row."policy_version" IN (\'gateway-settlement-v2\', '
        + '\'gateway-settlement-v3-customer-authority\')',
    );
    expect(migration).toContain('$extend_gateway_token_usage_receipt_versions$');
    expect(migration).toContain(
      "receipt.\"policy_version\" = 'gateway-settlement-v2'",
    );
    expect(migration).toContain(
      "receipt.\"policy_version\"\n          <> 'gateway-settlement-v3-customer-authority'",
    );
    expect(migration).toContain(
      'gateway legacy v2 CREDITS receipt proof is inconsistent',
    );
  });

  it('retains immutable evidence binding and BALANCE funding mathematics', () => {
    for (const marker of [
      'gateway funding reservation terminal anchor binding is invalid',
      'gateway funding reservation grant backing is incomplete',
      'gateway consumed reservation lacks matching TokenUsage proof',
      'selected_evidence."evidence_hash" = receipt."evidence_hash"',
      'receipt."settlement_fingerprint" IS NULL',
      'gateway consumed reservation exceeds frozen funding authority',
      'gateway consumed reservation lacks balance transaction',
      'gateway consumed reservation is not canonical wallet tail',
      'gateway consumed reservation allocation proof is inconsistent',
      'gateway consumed reservation did not consume frozen grant prefix',
    ]) {
      expect(patchedFundingProof).toContain(marker);
    }
  });

  it('binds BALANCE exact/protective-zero authority to reservation and ledger effects', () => {
    const balanceAuthorityProof = extractFunction(
      migration,
      'assert_gateway_balance_customer_financial_authority',
    );
    for (const marker of [
      "receipt.\"payload\"->'customerFinancialAuthority'",
      'gateway-customer-financial-authority-v1',
      "authority->>'customerAmountUnit' IS DISTINCT FROM 'USD'",
      "authority->>'originalCustomerAmount'",
      "authority->>'settledCustomerAmount'",
      "authority->>'originalCustomerChargeUsd'",
      "authority->>'settledCustomerChargeUsd'",
      "authority#>>'{originalDimensions,imageCount}'",
      "authority#>>'{settledDimensions,imageCount}'",
      "basis = 'CUSTOMER_PROTECTIVE_ZERO'",
      'settled_amount IS DISTINCT FROM reservation."authoritative_amount_usd"',
      'settled_charge IS DISTINCT FROM usage."customer_charge_usd"',
      "'gateway:financial:' || receipt.\"request_id\" || ':' || receipt.\"anchor_hash\"",
      'FROM "balance_transactions" AS tx',
      'FROM "balance_consumption_allocations" AS allocation',
      'gateway BALANCE canonical financial authority is inconsistent',
    ]) {
      expect(balanceAuthorityProof).toContain(marker);
    }
    expect(creditsReceiptProof).toContain(
      'PERFORM assert_gateway_balance_customer_financial_authority(receipt."id");',
    );
  });

  it('retains NO_CHARGE permanence and exclusion proofs without build authority', () => {
    for (const marker of [
      "no_charge_receipt.\"funding_outcome\" = 'NO_CHARGE'",
      "no_charge_receipt.\"policy_version\" = 'gateway-no-charge-v1'",
      'no_charge_receipt."amount_usd" = 0',
      'no_charge_receipt."anchor_hash" = reservation."anchor_hash"',
      'no_charge_receipt."pricing_hash" = anchor."pricing_hash"',
      'no_charge_receipt."settlement_fingerprint" IS NOT NULL',
      'selected_evidence."evidence_hash" = no_charge_receipt."evidence_hash"',
      'gateway_permanent_no_charge_reason(selected_evidence."raw_evidence")',
      'gateway released reservation lacks one permanent release proof',
      'NOT EXISTS (\n          SELECT 1 FROM "token_usage" AS billed_usage',
      'NOT EXISTS (\n          SELECT 1 FROM "gateway_usage_settlement_receipts" AS financial_receipt',
    ]) {
      expect(patchedFundingProof).toContain(marker);
    }
  });

  it('binds every CREDITS receipt to canonical financial authority and actual effects', () => {
    for (const marker of [
      'gateway financial receipt requires TokenUsage',
      'gateway financial receipt requires Gateway-linked TokenUsage',
      'PERFORM assert_gateway_token_usage_terminal_pair(usage."id");',
      'PERFORM assert_gateway_financial_read_committed();',
      'anchor."billing_unit" IS DISTINCT FROM \'CREDITS\'',
      'receipt."amount_usd" < 0',
      'receipt."credit_amount" < 0',
      'gateway financial receipt policy version is unsupported',
      "receipt.\"idempotency_key\" LIKE 'gateway:financial:%'",
      "'gateway:financial:' || receipt.\"request_id\" || ':' || receipt.\"anchor_hash\"",
      "receipt.\"payload\"->'customerFinancialAuthority'",
      "'gateway-customer-financial-authority-v1'",
      "customer_settlement->>'policyVersion'",
      "customer_settlement->>'terminalClass'",
      "customer_settlement->>'originalCustomerAmount'",
      "customer_settlement->>'settledCustomerAmount'",
      "customer_settlement->>'originalCustomerChargeUsd'",
      "customer_settlement->>'settledCustomerChargeUsd'",
      "customer_settlement#>>'{originalDimensions,inputTokens}'",
      "customer_settlement#>>'{settledDimensions,inputTokens}'",
      "customer_settlement#>>'{originalDimensions,imageCount}'",
      "customer_settlement#>>'{settledDimensions,imageCount}'",
      'settled_total IS DISTINCT FROM settled_input + settled_output',
      "settlement_basis = 'CUSTOMER_PROTECTIVE_ZERO'",
      'settled_input <> 0',
      'usage."quantity" IS DISTINCT FROM settled_image',
      'usage."prompt_tokens" IS DISTINCT FROM settled_input',
      'usage."total_tokens" IS DISTINCT FROM settled_total',
      "anchor.\"customer_pricing_snapshot\"#>>'{tokenUsagePricing,costUsd}'",
      'original_customer_amount IS DISTINCT FROM anchor_credit_amount',
      'settled_customer_amount IS DISTINCT FROM receipt."credit_amount"',
      'settled_customer_charge_usd IS DISTINCT FROM usage."customer_charge_usd"',
      'gateway CREDITS canonical financial authority is inconsistent',
    ]) {
      expect(creditsReceiptProof).toContain(marker);
    }
    expect(creditsReceiptProof).not.toContain('financialAuthorityFingerprint');
  });

  it('keeps canonical Gateway credit mutations paired with their terminal receipt', () => {
    const reverseProof = extractFunction(
      migration,
      'assert_gateway_credit_transaction_terminal_pairs',
    );
    const reverseTrigger = extractFunction(
      migration,
      'validate_gateway_credit_transaction_terminal_pairs_trigger',
    );
    expect(reverseProof).toContain("candidate_idempotency_key NOT LIKE 'gateway:credits:%'");
    expect(reverseProof).toContain('candidate_request_id = receipt."request_id"');
    expect(reverseProof).toContain(
      "'gateway:credits:' || receipt.\"request_id\" || ':' || receipt.\"anchor_hash\"",
    );
    expect(reverseProof).toContain(
      'PERFORM assert_gateway_financial_receipt_terminal_pair(receipt_id);',
    );
    expect(reverseTrigger).toContain("TG_OP IN ('UPDATE', 'DELETE')");
    expect(reverseTrigger).toContain("TG_OP IN ('INSERT', 'UPDATE')");
    expect(reverseTrigger).toContain('OLD."request_id"');
    expect(reverseTrigger).toContain('NEW."request_id"');
    expect(migration).toContain(
      'CREATE CONSTRAINT TRIGGER credit_transactions_gateway_terminal_pairs',
    );
    for (const marker of [
      "relation_row.relname = 'credit_transactions'",
      "trigger_row.tgname = 'credit_transactions_gateway_terminal_pairs'",
      "'public.validate_gateway_credit_transaction_terminal_pairs_trigger()'::regprocedure",
      '(trigger_row.tgtype & 4) = 4',
      '(trigger_row.tgtype & 8) = 8',
      '(trigger_row.tgtype & 16) = 16',
    ]) {
      expect(verification).toContain(marker);
    }
  });

  it('models positive, protective-zero, included-upstream and DEBT_OPEN as distinct CREDITS proofs', () => {
    for (const marker of [
      'gateway positive CREDITS mutation proof is inconsistent',
      "terminal_class IS DISTINCT FROM 'CREDITS_CHARGED'",
      "usage.\"customer_charge_policy\" IS DISTINCT FROM 'subscription_credits'",
      'credit_mutation."credits_amount" IS DISTINCT FROM -receipt."credit_amount"',
      'credit_mutation."subscription_id" IS DISTINCT FROM anchor."subscription_id"',
      'credit_mutation."input_tokens" IS DISTINCT FROM settled_input',
      'gateway zero-priced CREDITS proof is inconsistent',
      "terminal_class IS DISTINCT FROM 'CREDITS_ZERO'",
      "receipt.\"reason\" IS DISTINCT FROM 'zero_priced_credits'",
      "receipt.\"payload\"#>>'{billingResult,zeroCreditCharge,protocol}'",
      "'gateway-credits-zero-charge-v1'",
      "'gateway:credits:' || receipt.\"request_id\" || ':' || receipt.\"anchor_hash\"",
      'gateway included-upstream CREDITS proof is inconsistent',
      "terminal_class IS DISTINCT FROM 'CREDITS_INCLUDED'",
      "usage.\"customer_charge_policy\" IS DISTINCT FROM 'included_upstream'",
      "receipt.\"payload\"#>>'{billingResult,upstreamIncluded}'",
      'gateway CREDITS DEBT_OPEN receipt proof is inconsistent',
      "terminal_class IS DISTINCT FROM 'CREDITS_DEBT_OPEN'",
      "usage.\"customer_charge_policy\" IS DISTINCT FROM 'debt_open'",
      "receipt.\"payload\"#>>'{billingResult,debtExposureUsd}'",
      'usage."customer_unapproved_debt_usd"',
    ]) {
      expect(creditsReceiptProof).toContain(marker);
    }
  });

  it('does not mutate append-only evidence or remove its audit authority model', () => {
    expect(migration).not.toMatch(/(?:UPDATE|DELETE FROM)\s+"gateway_usage_evidences"/i);
    expect(migration).not.toMatch(/DROP\s+(?:TABLE|TRIGGER).*gateway_usage_evidences/i);
    expect(migration).not.toContain(
      'CREATE OR REPLACE FUNCTION gateway_usage_evidence_has_current_build_authority',
    );
    expect(migration).not.toContain(
      'CREATE OR REPLACE FUNCTION reject_gateway_settlement_append_only_mutation',
    );
    expect(verification).toContain('gateway_usage_evidences_append_only');
    expect(verification).toContain(
      'gateway_usage_evidences_freeze_build_authorization',
    );
    expect(verification).toContain(
      "'public.gateway_usage_evidence_has_current_build_authority(text,text,text)'",
    );
    expect(verification).toContain('append_only_trigger_count <> 2');
    expect(verification).toContain("trigger_row.tgenabled IN ('O', 'A')");
    expect(verification).toContain(
      "'public.reject_gateway_settlement_append_only_mutation()'::regprocedure",
    );
    expect(verification).toContain(
      "'public.freeze_gateway_usage_evidence_build_authorization()'::regprocedure",
    );
    for (const eventBit of [
      '(trigger_row.tgtype & 4)',
      '(trigger_row.tgtype & 8)',
      '(trigger_row.tgtype & 16)',
    ]) {
      expect(verification).toContain(eventBit);
    }
  });

  it('describes source validation as a marker contract, not a full revision proof', () => {
    expect(migration).toContain('required marker contract');
    expect(migration).not.toContain('expected 20260807000126 revision');
  });
});
