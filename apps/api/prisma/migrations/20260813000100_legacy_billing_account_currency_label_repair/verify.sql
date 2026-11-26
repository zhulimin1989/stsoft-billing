-- Install-time, read-only verifier for the fixed Shanghai-UAT legacy
-- BillingAccount USD -> CNY label-repair contract.
--
-- This verifier intentionally succeeds in exactly two pre-execution states:
--   * the target database has all ten fixed accounts, still labelled USD; or
--   * the environment has none of the fixed account IDs (auditable no-op).
-- Any repair audit row or partial/mutated cohort fails closed. Run this after
-- `prisma migrate deploy` and before invoking the separately controlled apply
-- function. It is not the post-apply verifier from the runbook.

BEGIN TRANSACTION READ ONLY;

DO $verify$
DECLARE
  invalid_count BIGINT;
  matched_count BIGINT;
  apply_source TEXT;
  immutable_source TEXT;
  actual_manifest_hash TEXT;
  target_account_count BIGINT;
  target_usd_count BIGINT;
  public_select_count BIGINT;
BEGIN
  IF NOT EXISTS (
    SELECT 1
    FROM "_prisma_migrations"
    WHERE "migration_name"
      = '20260813000100_legacy_billing_account_currency_label_repair'
      AND "finished_at" IS NOT NULL
      AND "rolled_back_at" IS NULL
  ) THEN
    RAISE EXCEPTION 'currency label repair migration is not terminal';
  END IF;

  IF to_regclass('public.billing_account_currency_label_repair_runs') IS NULL
    OR to_regclass('public.billing_account_currency_label_repair_items') IS NULL
    OR to_regclass(
      'public.billing_account_currency_label_repair_eligible_events'
    ) IS NULL
  THEN
    RAISE EXCEPTION 'currency label repair audit table set is incomplete';
  END IF;

  IF (
    SELECT column_row.column_default
    FROM information_schema.columns column_row
    WHERE column_row.table_schema = 'public'
      AND column_row.table_name = 'billing_accounts'
      AND column_row.column_name = 'currency'
  ) IS NOT NULL THEN
    RAISE EXCEPTION 'billing_accounts.currency must not have a silent default';
  END IF;

  WITH expected_constraint(name) AS (
    VALUES
      ('billing_account_currency_label_repair_runs_pkey'),
      ('billing_account_currency_label_repair_runs_contract_check'),
      ('billing_account_currency_label_repair_items_pkey'),
      ('billing_account_currency_label_repair_items_run_fkey'),
      ('billing_account_currency_label_repair_items_account_fkey'),
      ('billing_account_currency_label_repair_items_contract_check'),
      ('billing_currency_repair_events_pkey'),
      ('billing_currency_repair_events_run_fkey'),
      ('billing_currency_repair_events_item_fkey'),
      ('billing_currency_repair_events_event_fkey'),
      ('billing_currency_repair_events_evidence_fkey'),
      ('billing_currency_repair_events_contract_check')
  )
  SELECT COUNT(*) INTO matched_count
  FROM expected_constraint expected
  JOIN pg_constraint constraint_row
    ON constraint_row.conname = expected.name
    AND constraint_row.convalidated
    AND constraint_row.connamespace = 'public'::REGNAMESPACE;
  IF matched_count <> 12 THEN
    RAISE EXCEPTION 'currency label repair constraint set incomplete: %',
      matched_count;
  END IF;

  WITH expected_fk(name, source_table, target_table) AS (
    VALUES
      (
        'billing_account_currency_label_repair_items_run_fkey',
        'billing_account_currency_label_repair_items',
        'billing_account_currency_label_repair_runs'
      ),
      (
        'billing_account_currency_label_repair_items_account_fkey',
        'billing_account_currency_label_repair_items',
        'billing_accounts'
      ),
      (
        'billing_currency_repair_events_run_fkey',
        'billing_account_currency_label_repair_eligible_events',
        'billing_account_currency_label_repair_runs'
      ),
      (
        'billing_currency_repair_events_item_fkey',
        'billing_account_currency_label_repair_eligible_events',
        'billing_account_currency_label_repair_items'
      ),
      (
        'billing_currency_repair_events_event_fkey',
        'billing_account_currency_label_repair_eligible_events',
        'gateway_billing_events'
      ),
      (
        'billing_currency_repair_events_evidence_fkey',
        'billing_account_currency_label_repair_eligible_events',
        'gateway_usage_evidences'
      )
  )
  SELECT COUNT(*) INTO matched_count
  FROM expected_fk expected
  JOIN pg_constraint constraint_row
    ON constraint_row.conname = expected.name
    AND constraint_row.contype = 'f'
    AND constraint_row.conrelid
      = ('public.' || expected.source_table)::REGCLASS
    AND constraint_row.confrelid
      = ('public.' || expected.target_table)::REGCLASS
    AND constraint_row.confdeltype = 'r'
    AND constraint_row.confupdtype = 'r'
    AND constraint_row.convalidated;
  IF matched_count <> 6 THEN
    RAISE EXCEPTION 'currency label repair FK contract incomplete: %',
      matched_count;
  END IF;

  WITH expected_index(name) AS (
    VALUES
      ('billing_account_currency_label_repair_runs_pkey'),
      ('billing_account_currency_label_repair_runs_manifest_key'),
      ('billing_account_currency_label_repair_items_pkey'),
      ('billing_account_currency_label_repair_items_account_key'),
      ('billing_account_currency_label_repair_items_run_ordinal_key'),
      ('billing_account_currency_label_repair_items_run_account_key'),
      ('billing_currency_repair_events_pkey'),
      ('billing_currency_repair_events_event_key'),
      ('billing_currency_repair_events_request_key'),
      ('billing_currency_repair_events_evidence_key'),
      ('billing_currency_repair_events_run_event_key'),
      ('billing_currency_repair_events_item_event_key')
  )
  SELECT COUNT(*) INTO matched_count
  FROM expected_index expected
  JOIN pg_class index_row ON index_row.relname = expected.name
  JOIN pg_index index_meta ON index_meta.indexrelid = index_row.oid
  WHERE index_row.relnamespace = 'public'::REGNAMESPACE
    AND index_meta.indisunique
    AND index_meta.indisready
    AND index_meta.indisvalid;
  IF matched_count <> 12 THEN
    RAISE EXCEPTION 'currency label repair unique index set incomplete: %',
      matched_count;
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
  SELECT COUNT(*) INTO matched_count
  FROM expected_trigger expected
  JOIN pg_trigger trigger_row
    ON trigger_row.tgrelid = expected.relation_id
    AND trigger_row.tgname = expected.trigger_name
    AND trigger_row.tgfoid = expected.function_id
    AND trigger_row.tgenabled = 'O'
    AND NOT trigger_row.tgisinternal;
  IF matched_count <> 4 THEN
    RAISE EXCEPTION 'currency label repair trigger contract incomplete: %',
      matched_count;
  END IF;

  IF to_regprocedure(
      'public.apply_legacy_billing_account_currency_label_repair_v1(text,uuid,text,text,text,text,text,text,text,timestamp without time zone)'
    ) IS NULL
    OR to_regprocedure(
      'public.billing_account_currency_label_financial_snapshot(text)'
    ) IS NULL
    OR to_regprocedure(
      'public.billing_account_currency_label_manifest_v1()'
    ) IS NULL
    OR to_regprocedure(
      'public.billing_account_currency_label_pending_order_v1()'
    ) IS NULL
    OR to_regprocedure(
      'public.billing_account_currency_label_failed_usd_order_v1()'
    ) IS NULL
    OR to_regprocedure(
      'public.billing_account_currency_label_event_v1()'
    ) IS NULL
    OR to_regprocedure(
      'public.billing_account_currency_label_evidence_v1()'
    ) IS NULL
  THEN
    RAISE EXCEPTION 'currency label repair function set is incomplete';
  END IF;

  SELECT function_row.prosrc INTO apply_source
  FROM pg_proc function_row
  WHERE function_row.oid =
    'public.apply_legacy_billing_account_currency_label_repair_v1(text,uuid,text,text,text,text,text,text,text,timestamp without time zone)'::REGPROCEDURE
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.proconfig @> ARRAY['search_path=pg_catalog, public'];
  IF apply_source IS NULL
    OR position(
      '1743a625f25a8bbacd42a8cbaec3a73ad2653a0f43b4137b7e4d30e0c05137d6'
      IN apply_source
    ) = 0
    OR position('LOCK TABLE' IN apply_source) = 0
    OR position('"credit_transactions"' IN apply_source) = 0
    OR position(
      'credit_row."request_id" = expected.request_id' IN apply_source
    ) = 0
    OR position('LABEL_ONLY_NO_FX' IN apply_source) = 0
    OR position('pg_control_system()' IN apply_source) = 0
  THEN
    RAISE EXCEPTION 'currency label repair apply authority is incomplete';
  END IF;

  SELECT function_row.prosrc INTO immutable_source
  FROM pg_proc function_row
  WHERE function_row.oid =
    'public.enforce_billing_account_currency_immutability()'::REGPROCEDURE;
  IF immutable_source IS NULL
    OR position('billing.currency_label_repair_run_id' IN immutable_source) = 0
    OR position(
      'billing.allow_currency_label_repair_fixture' IN immutable_source
    ) = 0
    OR position('lower(current_database()) ~ ''(test|ci)''' IN immutable_source) = 0
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
    RAISE EXCEPTION 'currency immutability exception is not exact';
  END IF;

  -- Runtime roles need the terminal proof, never audit mutation. PUBLIC is the
  -- repository-wide read contract for DB roles created outside migrations.
  SELECT COUNT(*) INTO public_select_count
  FROM pg_class relation_row
  CROSS JOIN LATERAL aclexplode(COALESCE(
    relation_row.relacl,
    acldefault('r', relation_row.relowner)
  )) acl
  WHERE relation_row.oid IN (
    'public.billing_account_currency_label_repair_runs'::REGCLASS,
    'public.billing_account_currency_label_repair_items'::REGCLASS,
    'public.billing_account_currency_label_repair_eligible_events'::REGCLASS
  )
    AND acl.grantee = 0
    AND acl.privilege_type = 'SELECT';
  IF public_select_count <> 3 THEN
    RAISE EXCEPTION 'currency label repair runtime SELECT ACL incomplete: %',
      public_select_count;
  END IF;
  SELECT COUNT(*) INTO invalid_count
  FROM pg_class relation_row
  CROSS JOIN LATERAL aclexplode(COALESCE(
    relation_row.relacl,
    acldefault('r', relation_row.relowner)
  )) acl
  WHERE relation_row.oid IN (
    'public.billing_account_currency_label_repair_runs'::REGCLASS,
    'public.billing_account_currency_label_repair_items'::REGCLASS,
    'public.billing_account_currency_label_repair_eligible_events'::REGCLASS
  )
    AND acl.grantee = 0
    AND acl.privilege_type <> 'SELECT';
  IF invalid_count <> 0 THEN
    RAISE EXCEPTION 'currency label repair PUBLIC write ACL exists: %',
      invalid_count;
  END IF;

  WITH protected_function(function_id) AS (
    VALUES
      ('public.apply_legacy_billing_account_currency_label_repair_v1(text,uuid,text,text,text,text,text,text,text,timestamp without time zone)'::REGPROCEDURE),
      ('public.billing_account_currency_label_financial_snapshot(text)'::REGPROCEDURE),
      ('public.billing_account_currency_label_manifest_v1()'::REGPROCEDURE),
      ('public.billing_account_currency_label_pending_order_v1()'::REGPROCEDURE),
      ('public.billing_account_currency_label_failed_usd_order_v1()'::REGPROCEDURE),
      ('public.billing_account_currency_label_event_v1()'::REGPROCEDURE),
      ('public.billing_account_currency_label_evidence_v1()'::REGPROCEDURE),
      ('public.reject_billing_account_currency_label_repair_audit_mutation()'::REGPROCEDURE),
      ('public.enforce_billing_account_currency_immutability()'::REGPROCEDURE)
  )
  SELECT COUNT(*) INTO invalid_count
  FROM protected_function protected
  JOIN pg_proc function_row ON function_row.oid = protected.function_id
  CROSS JOIN LATERAL aclexplode(COALESCE(
    function_row.proacl,
    acldefault('f', function_row.proowner)
  )) acl
  WHERE acl.grantee = 0
    AND acl.privilege_type = 'EXECUTE';
  IF invalid_count <> 0 THEN
    RAISE EXCEPTION 'currency label repair PUBLIC function execute ACL exists: %',
      invalid_count;
  END IF;

  SELECT encode(sha256(convert_to(COALESCE(jsonb_agg(jsonb_build_object(
      'ordinal', manifest.ordinal,
      'billingAccountId', manifest.billing_account_id,
      'type', CASE manifest.ordinal WHEN 4 THEN 'enterprise' ELSE 'personal' END,
      'createdAt', CASE manifest.ordinal
        WHEN 1 THEN '2026-07-06 09:56:10.403'
        WHEN 2 THEN '2026-07-06 11:05:09.429'
        WHEN 3 THEN '2026-07-07 01:27:09.078'
        WHEN 4 THEN '2026-07-07 01:40:10.064'
        WHEN 5 THEN '2026-07-07 07:44:58.315'
        WHEN 6 THEN '2026-07-07 12:25:50.694'
        WHEN 7 THEN '2026-07-07 12:56:38.585'
        WHEN 8 THEN '2026-07-08 06:59:26.252'
        WHEN 9 THEN '2026-07-09 11:51:36.585'
        WHEN 10 THEN '2026-07-10 10:16:47.480'
      END,
      'ledgerStatus', 'RECONCILED_V2',
      'ledgerVersion', 2
    ) ORDER BY manifest.ordinal), '[]'::JSONB)::TEXT, 'UTF8')), 'hex')
  INTO actual_manifest_hash
  FROM "billing_account_currency_label_manifest_v1"() manifest;
  IF (SELECT COUNT(*) FROM "billing_account_currency_label_manifest_v1"()) <> 10
    OR actual_manifest_hash IS DISTINCT FROM
      '1743a625f25a8bbacd42a8cbaec3a73ad2653a0f43b4137b7e4d30e0c05137d6'
  THEN
    RAISE EXCEPTION 'currency label repair fixed account manifest mismatch: %',
      actual_manifest_hash;
  END IF;

  IF (SELECT COUNT(*) FROM "billing_account_currency_label_pending_order_v1"())
      <> 3
    OR (SELECT COUNT(*) FROM "billing_account_currency_label_failed_usd_order_v1"())
      <> 6
    OR (SELECT COUNT(*) FROM "billing_account_currency_label_event_v1"()) <> 3
    OR EXISTS (
      SELECT 1 FROM "billing_account_currency_label_pending_order_v1"()
      WHERE "order_id" NOT IN (
        '9d2903d9-7475-4f02-af74-3f61c8cc3c55',
        '88805844-5b2e-4659-a2da-a5fd9623cd57',
        'e26322b8-b865-43f9-a654-8b215c23c695'
      )
    )
    OR EXISTS (
      SELECT 1 FROM "billing_account_currency_label_event_v1"()
      WHERE ("gateway_billing_event_id", "request_id", "evidence_id")
        NOT IN (
          (
            '9ee64264-8af5-4069-ba27-21c9abfe85d3',
            '5d293fa0-5535-461e-84ca-f6cdbc5b6f79',
            '2ae0ea4d-43eb-4f82-a998-51694f442b1b'
          ),
          (
            'b14d60c2-209d-4335-b28c-ecd55727584e',
            'fa5f8903-eba4-4f49-902c-778b7990170e',
            '8d5f551d-59d0-46f9-8a61-bf81469df9c3'
          ),
          (
            'd49e5d2e-3241-45e1-9d64-1ec1095bdd71',
            'fe1c94d3-61b2-46c5-97a9-a690a2771bca',
            'f35c4c9c-b388-40b2-af26-abacb7edc980'
          )
        )
    )
  THEN
    RAISE EXCEPTION 'currency label repair order/event manifest mismatch';
  END IF;

  SELECT COUNT(*) INTO invalid_count
  FROM "billing_account_currency_label_repair_runs";
  invalid_count := invalid_count
    + (SELECT COUNT(*) FROM "billing_account_currency_label_repair_items")
    + (SELECT COUNT(*)
       FROM "billing_account_currency_label_repair_eligible_events");
  IF invalid_count <> 0 THEN
    RAISE EXCEPTION
      'install verifier found pre-existing/applied repair audit rows: %',
      invalid_count;
  END IF;

  SELECT COUNT(*) INTO target_account_count
  FROM "billing_accounts" account_row
  JOIN "billing_account_currency_label_manifest_v1"() manifest
    ON manifest.billing_account_id = account_row."id";
  SELECT COUNT(*) INTO target_usd_count
  FROM "billing_accounts" account_row
  JOIN "billing_account_currency_label_manifest_v1"() manifest
    ON manifest.billing_account_id = account_row."id"
  WHERE account_row."currency" = 'USD';
  IF target_account_count NOT IN (0, 10)
    OR target_usd_count IS DISTINCT FROM target_account_count
  THEN
    RAISE EXCEPTION
      'install verifier found partial or relabelled target cohort: total=% USD=%',
      target_account_count, target_usd_count;
  END IF;

  IF target_account_count = 0 THEN
    RAISE NOTICE 'currency label repair install verified: non-target environment no-op';
  ELSE
    RAISE NOTICE 'currency label repair install verified: UAT cohort intact, apply not run';
  END IF;
END
$verify$;

ROLLBACK;
