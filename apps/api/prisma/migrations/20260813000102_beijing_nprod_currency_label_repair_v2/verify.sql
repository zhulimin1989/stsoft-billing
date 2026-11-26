-- Install-time verifier.  Non-target databases are valid no-ops; the target
-- database must expose either none of the fixed IDs or the complete untouched
-- 71-account USD cohort.  This script never invokes the apply authority.
BEGIN TRANSACTION READ ONLY;

DO $verify$
DECLARE
  apply_source TEXT;
  immutable_source TEXT;
  target_count BIGINT;
  target_usd_count BIGINT;
  invalid_count BIGINT;
  deleted_member_proof_hash TEXT;
  public_execute_count BIGINT;
  matched_trigger_count BIGINT;
  current_system_identifier NUMERIC(20, 0);
  current_database_oid OID;
  rollout_row RECORD;
  target_locator BOOLEAN;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "_prisma_migrations"
    WHERE "migration_name"
      = '20260813000102_beijing_nprod_currency_label_repair_v2'
      AND "finished_at" IS NOT NULL
      AND "rolled_back_at" IS NULL
  ) THEN
    RAISE EXCEPTION 'nprod currency label repair migration is not terminal';
  END IF;

  IF to_regprocedure(
      'public.apply_legacy_billing_account_currency_label_repair_v2(text,uuid,text,text,text,text,text,text,text,timestamp without time zone)'
    ) IS NULL
    OR to_regprocedure(
      'public.billing_account_currency_label_manifest_nprod_v2()'
    ) IS NULL
    OR to_regprocedure(
      'public.billing_account_currency_label_deleted_member_nprod_v2()'
    ) IS NULL
    OR to_regprocedure(
      'public.billing_account_currency_label_ledger_exception_nprod_v2()'
    ) IS NULL
    OR to_regprocedure(
      'public.billing_account_currency_label_pending_order_nprod_v2()'
    ) IS NULL
    OR to_regprocedure(
      'public.billing_account_currency_label_event_nprod_v2()'
    ) IS NULL
    OR to_regprocedure(
      'public.billing_account_currency_label_evidence_v2()'
    ) IS NULL
  THEN
    RAISE EXCEPTION 'nprod currency label repair function set is incomplete';
  END IF;

  SELECT function_row.prosrc INTO apply_source
  FROM pg_proc function_row
  WHERE function_row.oid =
    'public.apply_legacy_billing_account_currency_label_repair_v2(text,uuid,text,text,text,text,text,text,text,timestamp without time zone)'::REGPROCEDURE
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.proconfig @> ARRAY['search_path=pg_catalog, public'];
  IF apply_source IS NULL
    OR position('beijing-nprod-legacy-usd-label-v2' IN apply_source) = 0
    OR position(
      '273fe03908a9d463556a6e9e5c60faba681c480d62064447f4f1b765051340e5'
      IN apply_source
    ) = 0
    OR position('ruidong_billing_v2' IN apply_source) = 0
    OR position('3f8df065-d032-4728-939a-db8fd4735533' IN apply_source) = 0
    OR position('7610171897653500696' IN apply_source) = 0
    OR position('40312' IN apply_source) = 0
    OR position('expected_account_count CONSTANT INTEGER := 71' IN apply_source) = 0
    OR position('expected_active_count CONSTANT INTEGER := 68' IN apply_source) = 0
    OR position('expected_deleted_count CONSTANT INTEGER := 3' IN apply_source) = 0
    OR position(
      'expected_deleted_member_count CONSTANT INTEGER := 3' IN apply_source
    ) = 0
    OR position('expected_pending_count CONSTANT INTEGER := 6' IN apply_source) = 0
    OR position('expected_event_count CONSTANT INTEGER := 2' IN apply_source) = 0
    OR position(
      '39a875f0368f92e39d4e308620885b8423f4f074ad7c79a109c271e0fc028ef3'
      IN apply_source
    ) = 0
    OR position(
      '856224622e1dd48ecff2b64fb6f502d9bd707eca237316b1cca503f7e8cfe59e'
      IN apply_source
    ) = 0
    OR position(
      '18312e4653fb9a6755f2bf99280cd4037ab3a1a25828a22d8ee2e08e43a9ef4f'
      IN apply_source
    ) = 0
    OR position(
      '36ac0df9c711fb81145f586014671f57880967c96f0b13c197f56d21d2a64f54'
      IN apply_source
    ) = 0
    OR position('invoice_snapshot_after IS DISTINCT FROM invoice_snapshot_before'
      IN apply_source) = 0
    OR position('restriction_row."reason" = ''settlement_policy_review'''
      IN apply_source) = 0
    OR position('intent_row."status" = ''SUCCEEDED'''
      IN apply_source) = 0
    OR position(
      'pg_advisory_xact_lock(60813, hashtext(target_manifest_version))'
      IN apply_source
    ) = 0
    OR position(
      'current_setting(''transaction_isolation'') IS DISTINCT FROM ''read committed'''
      IN apply_source
    ) = 0
    OR position('LOCK TABLE' IN apply_source) = 0
    OR position('LABEL_ONLY_NO_FX' IN apply_source) = 0
    OR position('pg_control_system()' IN apply_source) = 0
    OR position('wallet_row."balance_usd" <> 0' IN apply_source) = 0
    OR position('-0.024176940000' IN apply_source) = 0
    OR position('5.024176940000' IN apply_source) = 0
    OR position('target_currency' IN apply_source) = 0
  THEN
    RAISE EXCEPTION 'nprod currency label repair apply authority is incomplete';
  END IF;

  SELECT function_row.prosrc INTO immutable_source
  FROM pg_proc function_row
  WHERE function_row.oid =
    'public.enforce_billing_account_currency_immutability()'::REGPROCEDURE;
  IF immutable_source IS NULL
    OR position('shanghai-uat-legacy-usd-label-v1' IN immutable_source) = 0
    OR position('beijing-nprod-legacy-usd-label-v2' IN immutable_source) = 0
    OR position('billing.currency_label_repair_run_id' IN immutable_source) = 0
    OR position('repair_run."status" = ''APPLIED''' IN immutable_source) = 0
    OR position(
      'item."before_account_snapshot" = to_jsonb(OLD)' IN immutable_source
    ) = 0
    OR position(
      'item."after_account_snapshot" = to_jsonb(NEW)' IN immutable_source
    ) = 0
    OR position('OLD."currency" = ''USD''' IN immutable_source) = 0
    OR position('NEW."currency" = ''CNY''' IN immutable_source) = 0
  THEN
    RAISE EXCEPTION 'nprod currency immutability allowlist is incomplete';
  END IF;

  WITH expected_trigger(relation_id, trigger_name, function_id) AS (
    VALUES
      (
        'public.billing_account_currency_label_repair_runs'::REGCLASS,
        'billing_account_currency_label_repair_runs_append_only',
        'public.reject_billing_account_currency_label_repair_audit_mutation()'::REGPROCEDURE
      ),
      (
        'public.billing_account_currency_label_repair_items'::REGCLASS,
        'billing_account_currency_label_repair_items_append_only',
        'public.reject_billing_account_currency_label_repair_audit_mutation()'::REGPROCEDURE
      ),
      (
        'public.billing_account_currency_label_repair_eligible_events'::REGCLASS,
        'billing_account_currency_label_repair_events_append_only',
        'public.reject_billing_account_currency_label_repair_audit_mutation()'::REGPROCEDURE
      ),
      (
        'public.billing_accounts'::REGCLASS,
        'billing_accounts_currency_immutable',
        'public.enforce_billing_account_currency_immutability()'::REGPROCEDURE
      )
  )
  SELECT COUNT(*) INTO matched_trigger_count
  FROM expected_trigger expected
  JOIN pg_trigger trigger_row
    ON trigger_row.tgrelid = expected.relation_id
    AND trigger_row.tgname = expected.trigger_name
    AND trigger_row.tgfoid = expected.function_id
    AND trigger_row.tgenabled = 'O'
    AND NOT trigger_row.tgisinternal;
  IF matched_trigger_count <> 4 THEN
    RAISE EXCEPTION 'nprod currency label repair trigger contract incomplete: %',
      matched_trigger_count;
  END IF;

  IF (SELECT COUNT(*) FROM
      "billing_account_currency_label_manifest_nprod_v2"()) <> 71
    OR (SELECT COUNT(*) FROM
      "billing_account_currency_label_manifest_nprod_v2"()
      WHERE account_status = 'active') <> 68
    OR (SELECT COUNT(*) FROM
      "billing_account_currency_label_manifest_nprod_v2"()
      WHERE account_status = 'deleted') <> 3
    OR (SELECT COUNT(*) FROM
      "billing_account_currency_label_deleted_member_nprod_v2"()) <> 3
    OR (SELECT COUNT(*) FROM
      "billing_account_currency_label_ledger_exception_nprod_v2"()) <> 8
    OR (SELECT COUNT(*) FROM
      "billing_account_currency_label_pending_order_nprod_v2"()) <> 6
    OR (SELECT COUNT(*) FROM
      "billing_account_currency_label_event_nprod_v2"()) <> 2
  THEN
    RAISE EXCEPTION 'nprod currency label repair immutable manifest is invalid';
  END IF;

  SELECT COUNT(*) INTO public_execute_count
  FROM pg_proc function_row
  JOIN pg_namespace namespace_row
    ON namespace_row.oid = function_row.pronamespace
  WHERE namespace_row.nspname = 'public'
    AND function_row.proname IN (
      'apply_legacy_billing_account_currency_label_repair_v2',
      'billing_account_currency_label_manifest_nprod_v2',
      'billing_account_currency_label_deleted_member_nprod_v2',
      'billing_account_currency_label_ledger_exception_nprod_v2',
      'billing_account_currency_label_pending_order_nprod_v2',
      'billing_account_currency_label_event_nprod_v2',
      'billing_account_currency_label_evidence_v2'
    )
    AND has_function_privilege(
      'public', function_row.oid, 'EXECUTE'
    );
  IF public_execute_count <> 0 THEN
    RAISE EXCEPTION 'nprod currency label repair PUBLIC execute ACL exists';
  END IF;

  SELECT "system_identifier"::NUMERIC(20, 0)
  INTO current_system_identifier FROM pg_control_system();
  SELECT oid INTO current_database_oid
  FROM pg_database WHERE datname = current_database();
  SELECT * INTO rollout_row
  FROM "balance_ledger_rollout_control" WHERE "id" = 1;
  target_locator := current_database() = 'ruidong_billing_v2'
    AND rollout_row."database_name" = 'ruidong_billing_v2'
    AND rollout_row."database_identity"
      = '3f8df065-d032-4728-939a-db8fd4735533'::UUID
    AND rollout_row."database_system_identifier" = 7610171897653500696
    AND rollout_row."database_oid" = 40312
    AND current_system_identifier = 7610171897653500696
    AND current_database_oid = 40312::OID;

  -- A deploy in test/UAT/other production databases is install-only/no-op,
  -- even if an unrelated database happens to reuse one of the fixed IDs.
  -- Only the complete physical target locator enforces cohort state here.
  SELECT COUNT(*) INTO target_count
  FROM "billing_accounts" account_row
  JOIN "billing_account_currency_label_manifest_nprod_v2"() manifest
    ON manifest.billing_account_id = account_row."id";
  SELECT COUNT(*) INTO target_usd_count
  FROM "billing_accounts" account_row
  JOIN "billing_account_currency_label_manifest_nprod_v2"() manifest
    ON manifest.billing_account_id = account_row."id"
  WHERE account_row."currency" = 'USD';
  IF target_locator AND (
      target_count <> 71
      OR target_usd_count <> 71
      OR target_count <> target_usd_count
    )
  THEN
    RAISE EXCEPTION 'nprod currency label repair target partial cohort total=% usd=%',
      target_count, target_usd_count;
  END IF;

  IF target_locator THEN
    SELECT COUNT(*) INTO invalid_count
    FROM "billing_account_currency_label_manifest_nprod_v2"() manifest
    JOIN "billing_accounts" account_row
      ON account_row."id" = manifest.billing_account_id
    WHERE account_row."type" IS DISTINCT FROM manifest.account_type
      OR account_row."status" IS DISTINCT FROM manifest.account_status
      OR account_row."created_at" IS DISTINCT FROM manifest.account_created_at
      OR account_row."deleted_at" IS DISTINCT FROM manifest.account_deleted_at
      OR account_row."balance_grant_ledger_status"
        IS DISTINCT FROM manifest.ledger_status
      OR account_row."balance_grant_ledger_version"
        IS DISTINCT FROM manifest.ledger_version
      OR account_row."balance_grant_ledger_hash"
        IS DISTINCT FROM manifest.ledger_hash;
    IF invalid_count <> 0
      OR (SELECT COUNT(*) FROM "billing_accounts"
          WHERE "currency" = 'USD') <> 71
    THEN
      RAISE EXCEPTION 'nprod currency label repair target cohort drifted';
    END IF;

    SELECT encode(sha256(convert_to(COALESCE(jsonb_agg(
      to_jsonb(member_row)
      ORDER BY member_row."billing_account_id", member_row."id"
    ), '[]'::JSONB)::TEXT, 'UTF8')), 'hex')
    INTO deleted_member_proof_hash
    FROM "billing_account_members" member_row
    JOIN "billing_account_currency_label_manifest_nprod_v2"() manifest
      ON manifest.billing_account_id = member_row."billing_account_id"
    WHERE manifest.classification = 'DELETED_INERT_MEMBER_METADATA';

    SELECT COUNT(*) INTO invalid_count
    FROM "billing_account_currency_label_deleted_member_nprod_v2"() expected
    LEFT JOIN "billing_account_members" member_row
      ON member_row."id" = expected.id
    WHERE member_row."id" IS NULL
      OR member_row."billing_account_id" IS DISTINCT FROM expected.billing_account_id
      OR member_row."user_id" IS DISTINCT FROM expected.user_id
      OR member_row."role" IS DISTINCT FROM expected.role
      OR member_row."status" IS DISTINCT FROM expected.status
      OR member_row."joined_at" IS DISTINCT FROM expected.joined_at
      OR member_row."created_at" IS DISTINCT FROM expected.created_at
      OR member_row."updated_at" IS DISTINCT FROM expected.updated_at
      OR (SELECT COUNT(*) FROM "billing_account_members" same_account
        WHERE same_account."billing_account_id"
          = expected.billing_account_id) <> 1;
    IF invalid_count <> 0
      OR deleted_member_proof_hash IS DISTINCT FROM
        '856224622e1dd48ecff2b64fb6f502d9bd707eca237316b1cca503f7e8cfe59e'
    THEN
      RAISE EXCEPTION 'nprod currency label repair deleted member proof drifted';
    END IF;
  END IF;

  IF EXISTS (SELECT 1 FROM "billing_account_currency_label_repair_runs"
      WHERE "manifest_version" = 'beijing-nprod-legacy-usd-label-v2')
  THEN
    RAISE EXCEPTION 'nprod install verifier found pre-existing/applied run';
  END IF;
END
$verify$;

ROLLBACK;
