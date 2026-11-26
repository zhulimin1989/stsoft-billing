import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';

describe('Gateway usage settlement database contract', () => {
  const schema = readFileSync(resolve(__dirname, '../../prisma/schema.prisma'), 'utf8');
  const migration = readFileSync(resolve(
    __dirname,
    '../../prisma/migrations/20260806000106_gateway_usage_settlement_anchor/migration.sql',
  ), 'utf8').replace(/\r\n/g, '\n');
  const service = readFileSync(resolve(
    __dirname,
    './gateway-request-event-billing.service.ts',
  ), 'utf8').replace(/\r\n/g, '\n');
  const billingService = readFileSync(resolve(
    __dirname,
    './billing.service.ts',
  ), 'utf8').replace(/\r\n/g, '\n');
  const fundingMigration = readFileSync(resolve(
    __dirname,
    '../../prisma/migrations/20260806000124_gateway_usage_funding_reservations/migration.sql',
  ), 'utf8').replace(/\r\n/g, '\n');
  const currentPrepaidPolicyMigration = readFileSync(resolve(
    __dirname,
    '../../prisma/migrations/20260807000125_gateway_current_prepaid_policy/migration.sql',
  ), 'utf8').replace(/\r\n/g, '\n');
  const terminalProofPerformanceMigration = readFileSync(resolve(
    __dirname,
    '../../prisma/migrations/20260807000126_gateway_terminal_proof_incremental/migration.sql',
  ), 'utf8').replace(/\r\n/g, '\n');
  const balanceContractRollout = readFileSync(resolve(
    __dirname,
    '../../prisma/rollouts/20260717000100_balance_expiry_v2_contract/migration.sql',
  ), 'utf8').replace(/\r\n/g, '\n');
  const balanceContractRolloutVerify = readFileSync(resolve(
    __dirname,
    '../../prisma/rollouts/20260717000100_balance_expiry_v2_contract/verify.sql',
  ), 'utf8').replace(/\r\n/g, '\n');

  it('stores first receipt separately from Gateway occurrence using the DB clock', () => {
    const anchorModel = schema.match(/model GatewayUsageSettlementAnchor \{([\s\S]*?)\n\}/)?.[1];
    expect(anchorModel).toContain('occurredAt');
    expect(anchorModel).toContain('firstReceivedAt');
    expect(migration).toMatch(/"first_received_at" TIMESTAMP\(3\) NOT NULL/);
    expect(migration).not.toMatch(/"first_received_at"[^\n]*DEFAULT/);
    expect(service).toContain('SELECT clock_timestamp() AS "databaseNow"');
    expect(service).toContain('observedAt: databaseObservedAt');
  });

  it('enforces immutable evidence, reconciliation audit, anchors and receipts in PostgreSQL', () => {
    for (const trigger of [
      'gateway_usage_evidences_append_only',
      'gateway_usage_reconciliation_actions_append_only',
      'gateway_usage_settlement_anchors_append_only',
      'gateway_usage_settlement_receipts_append_only',
    ]) {
      expect(migration).toContain(`CREATE TRIGGER ${trigger}`);
    }
    expect(migration).toContain('CREATE TRIGGER gateway_billing_events_immutable_receipt');
    expect(migration).toContain('NEW."raw_event" IS DISTINCT FROM OLD."raw_event"');
    expect(migration).toContain('NEW."request_id" IS DISTINCT FROM OLD."request_id"');
    expect(migration).toContain('NEW."evidence_hash" IS DISTINCT FROM OLD."evidence_hash"');
  });

  it('binds first-receipt cash to immutable grant slices and preserves frozen identities', () => {
    expect(schema).toContain('model GatewayUsageFundingReservationGrant');
    expect(fundingMigration).toContain('CREATE TABLE "gateway_usage_funding_reservation_grants"');
    expect(fundingMigration).toContain('gateway_usage_funding_reservation_grants_immutable');
    expect(fundingMigration).toContain('gateway_usage_funding_reservation_grants_validate');
    expect(fundingMigration).toContain('grant_expires_at IS NOT NULL');
    expect(fundingMigration).toContain('active_grant_hold_usd + NEW."amount_usd" > grant_remaining_usd');
    expect(fundingMigration).toContain('funding grant holds must equal collected reservation');
    expect(fundingMigration).toContain('CREATE TRIGGER balance_grants_gateway_funding_holds_guard');
    expect(fundingMigration).toContain("settlement_protocol_marker IS DISTINCT FROM 'v1'");
    expect(fundingMigration).toContain('consuming_token_usage_exists IS DISTINCT FROM TRUE');
    expect(fundingMigration).toContain('NEW."remaining_amount_usd" < protected_hold_usd');
    expect(fundingMigration).toContain(
      'balance grant eligibility is immutable while Gateway funding is reserved',
    );
    for (const constraint of [
      'gateway_usage_settlement_anchors_api_key_fkey',
      'gateway_usage_settlement_anchors_user_fkey',
      'gateway_usage_settlement_anchors_tenant_fkey',
      'gateway_usage_settlement_anchors_account_fkey',
      'gateway_usage_settlement_anchors_product_fkey',
      'gateway_usage_settlement_anchors_coding_entitlement_fkey',
      'gateway_usage_settlement_anchors_plan_fkey',
    ]) {
      expect(fundingMigration).toContain(`ADD CONSTRAINT "${constraint}"`);
    }
    expect(fundingMigration).toContain('api_key.\"tenant_id\" = NEW.\"tenant_id\"');
    expect(fundingMigration).toContain(
      'tenant.\"billing_account_id\" = NEW.\"billing_account_id\"',
    );
    expect(fundingMigration).toContain(
      'gateway funding reservation exceeds workspace allowance authority',
    );
  });

  it('freezes exact append-only enterprise credit authority for the occurrence window', () => {
    expect(schema).toContain('creditPolicyWindowStart');
    expect(schema).toContain('creditPolicyEventId');
    expect(schema).toContain('creditConfiguredLimitUsd');
    expect(fundingMigration).toContain('\"credit_policy_window_start\" TIMESTAMP(3) NOT NULL');
    expect(fundingMigration).toContain('\"credit_policy_event_id\" TEXT');
    expect(fundingMigration).toContain(
      '\"credit_configured_limit_usd\" DECIMAL(20,12) NOT NULL',
    );
    expect(fundingMigration).toContain(
      'gateway_usage_funding_reservations_credit_policy_event_fkey',
    );
    expect(fundingMigration).toContain(
      "NEW.\"credit_policy_source\" IN ('EVENT_NEW_STATE', 'EVENT_OLD_STATE')",
    );
    expect(fundingMigration).toContain(
      'enterprise gateway reservation EVENT_NEW_STATE proof is invalid',
    );
    expect(fundingMigration).toContain(
      'enterprise gateway reservation EVENT_OLD_STATE proof is invalid',
    );
    expect(fundingMigration).toContain(
      'enterprise gateway historical NO_CONFIG proof is invalid',
    );
    expect(fundingMigration).toContain(
      'enterprise gateway reservation effective credit limit is invalid',
    );
    expect(fundingMigration).toContain(
      'enterprise gateway reservation approved credit policy is invalid',
    );
    expect(fundingMigration).toContain(
      'personal gateway reservation cannot contain enterprise credit',
    );
    expect(currentPrepaidPolicyMigration).toContain(
      'CREATE TRIGGER gateway_usage_funding_reservations_current_prepaid_bind',
    );
    expect(currentPrepaidPolicyMigration).toContain(
      "'CURRENT_PREPAID'",
    );
    expect(currentPrepaidPolicyMigration).toContain(
      'gateway current prepaid policy requires credit to be disabled',
    );
    expect(currentPrepaidPolicyMigration).not.toContain(
      'billing_account_credit_events',
    );
  });

  it('makes ledger currency immutable outside a drained dedicated migration', () => {
    expect(fundingMigration).toContain(
      'CREATE OR REPLACE FUNCTION enforce_billing_account_currency_immutability()',
    );
    expect(fundingMigration).toContain('CREATE TRIGGER billing_accounts_currency_immutable');
    expect(fundingMigration).toContain('BEFORE UPDATE OF "currency" ON "billing_accounts"');
    expect(fundingMigration).toContain('NEW."currency" IS DISTINCT FROM OLD."currency"');
    expect(fundingMigration).not.toContain('gateway_currency_migration_bypass');
  });

  it('allows legacy anchors to remain unknown but rejects every new legacy-shaped anchor', () => {
    expect(fundingMigration).toContain(
      'CREATE OR REPLACE FUNCTION enforce_gateway_usage_anchor_v1_insert()',
    );
    expect(fundingMigration).toContain(
      'CREATE TRIGGER gateway_usage_settlement_anchors_v1_insert',
    );
    expect(fundingMigration).toContain(
      'new gateway settlement anchor requires frozen billing currency',
    );
    expect(fundingMigration).toContain(
      'new BALANCE gateway anchor requires V1 first-receipt funding order',
    );
    expect(fundingMigration).not.toContain(
      'CREATE TRIGGER gateway_usage_settlement_anchors_legacy_balance_guard',
    );
  });

  it('proves T1 backing and T2 terminal pairing at transaction commit', () => {
    expect(fundingMigration).toContain(
      'CREATE TRIGGER gateway_usage_funding_reservations_anchor_bind',
    );
    expect(fundingMigration).toContain(
      'gateway funding reservation does not match immutable anchor',
    );
    expect(fundingMigration).toContain(
      'CREATE CONSTRAINT TRIGGER gateway_usage_funding_reservations_terminal_proof',
    );
    expect(fundingMigration).toContain(
      'CREATE CONSTRAINT TRIGGER token_usage_gateway_terminal_pair',
    );
    expect(fundingMigration.match(/DEFERRABLE INITIALLY DEFERRED/g)?.length ?? 0)
      .toBeGreaterThanOrEqual(2);
    expect(fundingMigration).toContain(
      'gateway funding reservation grant backing is incomplete',
    );
    expect(fundingMigration).toContain(
      'gateway TokenUsage must commit with exactly one v2 receipt',
    );
    expect(fundingMigration).toContain(
      'gateway consumed reservation allocation proof is inconsistent',
    );
    expect(fundingMigration).toContain(
      'gateway consumed reservation exceeds frozen funding authority',
    );
    expect(fundingMigration).toContain(
      'gateway consumed reservation did not consume frozen grant prefix',
    );
    expect(fundingMigration).toContain(
      "allocation.\"source\" IN ('BALANCE_GRANT', 'UNRECONCILED_GRANT')",
    );
    expect(fundingMigration).toContain(
      'allocation.\"credit_policy_at\" IS DISTINCT FROM',
    );
    expect(fundingMigration).toContain(
      'reservation.\"approved_credit_due_at\"',
    );
    expect(fundingMigration).toContain(
      'gateway zero-price settlement must not create balance transaction',
    );
    expect(fundingMigration).toContain(
      'gateway terminal settlement requires reconciled v2 ledger',
    );
    expect(fundingMigration).toContain(
      "ledger_account_status IS DISTINCT FROM 'RECONCILED_V2'",
    );
    expect(fundingMigration).toContain('ledger_account_version IS DISTINCT FROM 2');
    expect(fundingMigration).toContain('assert_balance_transaction_unique_wallet_path');
    expect(fundingMigration).toContain('assert_balance_allocation_sequence_order');
    expect(fundingMigration).toContain(
      'gateway consumed reservation is not canonical wallet tail',
    );
    expect(fundingMigration).toContain(
      'gateway funding reservation manual review transition is disabled',
    );
    expect(fundingMigration).toContain(
      'gateway_funding_transition_protocol',
    );
    expect(fundingMigration).toContain(
      'gateway_funding_transition_reservation_id',
    );
  });

  it('assigns one bounded proof owner per Gateway settlement path', () => {
    expect(terminalProofPerformanceMigration).toContain(
      'CREATE OR REPLACE FUNCTION assert_gateway_usage_funding_terminal(',
    );
    expect(terminalProofPerformanceMigration).not.toContain(
      'PERFORM assert_gateway_balance_ledger_v2_contract()',
    );
    expect(terminalProofPerformanceMigration).toContain(
      'gateway consumed reservation is not canonical wallet tail',
    );
    expect(terminalProofPerformanceMigration).toContain(
      'gateway consumed reservation allocation proof is inconsistent',
    );
    expect(terminalProofPerformanceMigration).not.toContain(
      'assert_balance_transaction_unique_wallet_path',
    );
    expect(terminalProofPerformanceMigration).not.toContain(
      'assert_balance_allocation_sequence_order',
    );
    expect(terminalProofPerformanceMigration).toContain(
      'CREATE OR REPLACE FUNCTION gateway_balance_canonical_mutation_is_current_settlement(',
    );
    expect(terminalProofPerformanceMigration).toContain(
      'gateway CREDITS receipt proof is inconsistent',
    );
    expect(terminalProofPerformanceMigration).not.toContain(
      'assert_gateway_terminal_event_once',
    );
    expect(terminalProofPerformanceMigration).not.toContain(
      'gateway_terminal_event_revisions',
    );
    const tokenProof = terminalProofPerformanceMigration.match(
      /CREATE OR REPLACE FUNCTION assert_gateway_token_usage_terminal_pair\([\s\S]*?\$\$ LANGUAGE plpgsql;/,
    )?.[0];
    const receiptProof = terminalProofPerformanceMigration.match(
      /CREATE OR REPLACE FUNCTION assert_gateway_financial_receipt_terminal_pair\([\s\S]*?\$\$ LANGUAGE plpgsql;/,
    )?.[0];
    expect(tokenProof).not.toContain('assert_gateway_usage_funding_terminal');
    expect(receiptProof).not.toContain('assert_gateway_usage_funding_terminal');
    const gatewayMutationMarker = billingService.indexOf(
      "'ruidong.gateway_consuming_reservation_id'",
    );
    const walletMutation = billingService.indexOf(
      'const updated = await db.accountWallet.updateMany',
      gatewayMutationMarker,
    );
    expect(gatewayMutationMarker).toBeGreaterThan(-1);
    expect(walletMutation).toBeGreaterThan(gatewayMutationMarker);
    expect(billingService.match(/'ruidong\.gateway_consuming_reservation_id'/g)).toHaveLength(1);
    expect(terminalProofPerformanceMigration).not.toMatch(/DROP TRIGGER/);
  });

  it('installs the Gateway canonical fast path in either Release A/B order', () => {
    expect(terminalProofPerformanceMigration).toContain(
      "canonical_oid := to_regprocedure(\n    'public.assert_clean_account_wallet_canonical_deferred()'",
    );
    expect(terminalProofPerformanceMigration).toContain(
      'IF canonical_oid IS NULL THEN\n    RETURN;',
    );
    expect(terminalProofPerformanceMigration).not.toContain(
      "'public.assert_clean_account_wallet_canonical_deferred()'::regprocedure",
    );
    expect(terminalProofPerformanceMigration).toContain(
      'CREATE OR REPLACE FUNCTION gateway_balance_canonical_mutation_is_current_settlement(',
    );

    const gatewayStub = balanceContractRollout.match(
      /DO \$gateway_terminal_proof_stub\$[\s\S]*?\$gateway_terminal_proof_stub\$;/,
    )?.[0];
    expect(gatewayStub).toContain(
      "'public.gateway_balance_canonical_mutation_is_current_settlement(text,text,jsonb,jsonb)'",
    );
    expect(gatewayStub).toContain(
      'CREATE FUNCTION "gateway_balance_canonical_mutation_is_current_settlement"(\n        TEXT, TEXT, JSONB, JSONB',
    );
    expect(gatewayStub).toContain("AS 'SELECT FALSE'");
    const canonicalDefinition = balanceContractRollout.match(
      /CREATE OR REPLACE FUNCTION "assert_clean_account_wallet_canonical_deferred"\(\)[\s\S]*?\n\$\$;/,
    )?.[0];
    expect(canonicalDefinition).toContain(
      'IF gateway_balance_canonical_mutation_is_current_settlement(',
    );
    expect(
      canonicalDefinition?.match(
        /gateway_balance_canonical_mutation_is_current_settlement/g,
      ) ?? [],
    ).toHaveLength(1);
    expect(balanceContractRolloutVerify).toContain(
      "'public.gateway_balance_canonical_mutation_is_current_settlement(text,text,jsonb,jsonb)'",
    );
    expect(balanceContractRolloutVerify).toContain(
      "'gateway_balance_canonical_mutation_is_current_settlement'",
    );
  });

  it('requires permanent proof before releasing a reservation', () => {
    expect(fundingMigration).toContain("'NO_CHARGE'");
    expect(fundingMigration).toContain("'RECEIVABLE'");
    expect(fundingMigration).toContain("'gateway-no-charge-v1'");
    expect(fundingMigration).toContain("'financial_absorption:'");
    expect(fundingMigration).toContain(
      'gateway released reservation lacks one permanent release proof',
    );
    expect(fundingMigration).toContain(
      'absorbed_receipt.\"amount_usd\" = reservation.\"reserved_amount_usd\"',
    );
    expect(fundingMigration).toContain(
      'absorbed_receipt.\"billing_currency\" = reservation.\"billing_currency\"',
    );
    expect(fundingMigration).toContain(
      'absorbed_receipt.\"token_usage_id\" IS NULL',
    );
    expect(fundingMigration).toContain(
      'selected_evidence.\"evidence_hash\" = receipt.\"evidence_hash\"',
    );
    expect(fundingMigration).toContain(
      "absorbed_receipt.\"policy_version\" = 'manual-finance-v2'",
    );
    expect(fundingMigration).toContain(
      "action.\"metadata\"->>'approvedAbsorptionUsd'",
    );
    expect(fundingMigration).toContain(
      "absorbed_receipt.\"payload\"->>'approvedAbsorptionUsd'",
    );
    expect(fundingMigration).toContain(
      'CREATE OR REPLACE FUNCTION gateway_permanent_no_charge_reason(',
    );
    expect(fundingMigration).toContain(
      'CREATE OR REPLACE FUNCTION gateway_usage_jsonb_nonnegative_safe_integer(',
    );
    expect(fundingMigration).toContain(
      'CREATE OR REPLACE FUNCTION gateway_usage_jsonb_normalized_unique_strings(',
    );
    expect(fundingMigration).toContain("raw_evidence->>'provider_usage_hash'");
    expect(fundingMigration).toContain("raw_evidence->'provider_account_ref'");
    expect(fundingMigration).toContain("raw_evidence->>'producer_build_sha'");
    expect(fundingMigration).toContain(
      "ARRAY['usage_evidence', 'terminal_frame_seen']",
    );
    expect(fundingMigration).toContain(
      "'anthropic', 'bigmodel', 'glm', 'zhipu', 'zhipuai'",
    );
    expect(fundingMigration).not.toContain(
      'no_charge_receipt.\"evidence_hash\" = event.\"evidence_hash\"',
    );
    expect(service).toContain('noChargeProof');
    expect(service).toContain('The permanent NO_CHARGE proof commits first');
  });

  it('binds all automatic financial evidence to append-only DB-owned producer build authority', () => {
    expect(schema).toContain('model GatewayProducerBuildAuthorizationEvent');
    expect(schema).toContain('producerBuildAuthorizationEventId');
    expect(schema).toContain('producerBuildAuthorizationRevision');
    expect(schema).toContain('producerBuildAuthorityHash');
    expect(fundingMigration).toContain(
      'CREATE TABLE "gateway_producer_build_authorization_events"',
    );
    expect(fundingMigration).toContain(
      'CREATE OR REPLACE FUNCTION append_gateway_producer_build_authorization(',
    );
    expect(fundingMigration).toContain(
      'CREATE TRIGGER gateway_producer_build_authorization_events_append_only',
    );
    expect(fundingMigration).toContain(
      'CREATE TRIGGER gateway_usage_evidences_freeze_build_authorization',
    );
    expect(fundingMigration).toContain(
      'NEW.producer_build_authorization_event_id := authority_event.id',
    );
    expect(fundingMigration).toContain(
      'CREATE OR REPLACE FUNCTION gateway_usage_evidence_has_current_build_authority(',
    );
    expect(fundingMigration).toContain(
      'CREATE OR REPLACE FUNCTION assert_gateway_financial_read_committed()',
    );
    expect(fundingMigration).toContain('LANGUAGE plpgsql\nVOLATILE');
    expect(fundingMigration).toContain(
      'pg_advisory_xact_lock(60806, hashtext(selected_build_sha))',
    );
    expect(fundingMigration).toContain(
      "current_setting('transaction_isolation') IS DISTINCT FROM 'read committed'",
    );
    expect(fundingMigration.match(
      /PERFORM (?:public\.)?assert_gateway_financial_read_committed\(\);/g,
    )?.length ?? 0).toBeGreaterThanOrEqual(4);
    expect(fundingMigration).toContain(
      "clock_timestamp() AT TIME ZONE 'UTC'",
    );
    expect(fundingMigration).toContain(
      "build_authority.decision = 'AUTHORIZED'",
    );
    expect(fundingMigration).toContain(
      'later_authority.revision > build_authority.revision',
    );
    expect(fundingMigration).toContain(
      'REVOKE ALL ON FUNCTION append_gateway_producer_build_authorization(',
    );
    expect(fundingMigration).not.toMatch(
      /GRANT EXECUTE ON FUNCTION append_gateway_producer_build_authorization/,
    );
    expect(service).toContain(
      'Billing runtime DB role must not mutate Gateway build authority or evidence rollout state',
    );
    expect(service).toContain('has_table_privilege(');
    expect(service).toContain(
      'this.verifiedProducerBuilds.has(producerBuildSha)',
    );
  });

  it('uses a DB-owned SHADOW/ENFORCE rollout and re-proves build authority for BALANCE and CREDITS at commit', () => {
    expect(schema).toContain('model GatewayUsageEvidenceContractRolloutControl');
    expect(fundingMigration).toContain(
      'CREATE TABLE "gateway_usage_evidence_contract_rollout_control"',
    );
    expect(fundingMigration).toContain(
      'CREATE OR REPLACE FUNCTION transition_gateway_usage_evidence_contract_mode(',
    );
    expect(fundingMigration).toContain(
      'CREATE OR REPLACE FUNCTION current_gateway_usage_evidence_contract_mode()',
    );
    expect(fundingMigration).toContain(
      'gateway_usage_evidence_contract_rollout_control_guard',
    );
    expect(fundingMigration).toContain(
      'REVOKE ALL ON FUNCTION transition_gateway_usage_evidence_contract_mode(',
    );
    expect(fundingMigration).not.toMatch(
      /GRANT EXECUTE ON FUNCTION transition_gateway_usage_evidence_contract_mode/,
    );
    expect(fundingMigration.match(
      /current_gateway_usage_evidence_contract_mode\(\) IS DISTINCT FROM 'SHADOW'/g,
    )?.length ?? 0).toBeGreaterThanOrEqual(2);
    expect(fundingMigration.match(
      /gateway_usage_evidence_has_current_build_authority\(/g,
    )?.length ?? 0).toBeGreaterThanOrEqual(5);
    expect(fundingMigration).toContain(
      'CREATE CONSTRAINT TRIGGER gateway_usage_settlement_receipts_terminal_pair',
    );
    expect(fundingMigration).toContain(
      "receipt.\"policy_version\" <> 'gateway-settlement-v2'",
    );
    expect(service).toContain(
      "'public.transition_gateway_usage_evidence_contract_mode(text,text,text,text)'",
    );
    expect(service).toContain(
      "'public.gateway_usage_evidence_contract_rollout_control'",
    );
    expect(service).toContain(
      'Gateway evidence rollout mode drift',
    );
    expect(service).toContain(
      'Gateway producer build authority drift',
    );
    expect(service).toContain(
      'continuing customer settlement while provider evidence remains internally observable',
    );
    expect(service).toContain("current_setting('transaction_isolation')");
    expect(service).toContain(
      'Billing runtime database session must use READ COMMITTED transaction isolation',
    );
  });

  it('keeps PostgreSQL NO_CHARGE family/correlation proof aligned with the TypeScript contract', () => {
    expect(fundingMigration).toContain(
      'CREATE OR REPLACE FUNCTION gateway_usage_jsonb_trimmed_string(',
    );
    expect(fundingMigration).toContain(
      "U&'\\0009\\000A\\000B\\000C\\000D\\0020\\00A0\\1680'",
    );
    expect(fundingMigration).toContain(
      "U&'\\2008\\2009\\200A\\2028\\2029\\202F\\205F\\3000\\FEFF'",
    );
    expect(fundingMigration).toContain("raw_evidence->'resolved_api_type'");
    expect(fundingMigration).toContain("resolved_api_type_value ~ '^anthropic(_|$)' ");
    expect(fundingMigration).toContain("resolved_api_type_value ~ '^openai(_|$)' ");
    expect(fundingMigration).toContain(
      'resolved_api_type_family = usage_protocol_family',
    );
    expect(fundingMigration).toContain(
      '(provider_family IS NULL OR provider_family = resolved_api_type_family)',
    );
    expect(fundingMigration).toContain(
      "provider_value IN ('anthropic', 'bigmodel', 'glm', 'zhipu', 'zhipuai')",
    );
    expect(fundingMigration).toContain(
      'requires_strict_upstream_request_id',
    );
    expect(fundingMigration).toContain(
      'upstream_request_id_value IS NOT NULL',
    );
  });

  it('checks the exact Release-B 15-trigger contract at deployment and startup', () => {
    expect(fundingMigration).toContain(
      'CREATE OR REPLACE FUNCTION assert_gateway_balance_ledger_v2_contract()',
    );
    expect(fundingMigration).toContain(
      "rollout_phase IS DISTINCT FROM 'V2_CONTRACT'",
    );
    expect(fundingMigration).toContain(
      'expected_trigger_count CONSTANT INTEGER := 15',
    );
    expect(fundingMigration).toContain(
      "('public', 'balance_grants', 'balance_grants_expiry_reconciled_v2_guard', 'public', 'guard_balance_grant_expiry_reconciled_v2', '', 'O', FALSE, FALSE, 19)",
    );
    expect(fundingMigration).toContain(
      "('public', 'balance_grant_refund_allocations', 'balance_grant_refund_allocations_canonical_deferred', 'public', 'validate_balance_grant_refund_trigger', '', 'O', TRUE, TRUE, 5)",
    );
    expect(terminalProofPerformanceMigration).not.toContain(
      'PERFORM assert_gateway_balance_ledger_v2_contract();',
    );
    expect(service).toContain(
      'SELECT assert_gateway_balance_ledger_v2_contract()',
    );
  });
});
