-- Read-only install verifier for the exact v1 apply name-resolution hotfix.
BEGIN TRANSACTION READ ONLY;

DO $verify$
DECLARE
  target_signature CONSTANT TEXT :=
    'public.apply_legacy_billing_account_currency_label_repair_v1(text,uuid,text,text,text,text,text,text,text,timestamp without time zone)';
  expected_repaired_definition_hash CONSTANT TEXT :=
    '5bd33cfa9c1440081e852ba9255af7d3ed4679a11f1d325ac078ded2997943ed';
  target_function_oid OID;
  target_function_owner OID;
  target_function_acl ACLITEM[];
  definition TEXT;
  definition_hash TEXT;
  acl_entry_count BIGINT;
  invalid_acl_entry_count BIGINT;
BEGIN
  IF NOT EXISTS (
    SELECT 1 FROM "_prisma_migrations" migration_row
    WHERE migration_row."migration_name"
      = '20260813000103_legacy_currency_label_v1_apply_name_resolution_hotfix'
      AND migration_row."finished_at" IS NOT NULL
      AND migration_row."rolled_back_at" IS NULL
  ) THEN
    RAISE EXCEPTION 'v1 currency label repair hotfix migration is not terminal';
  END IF;

  target_function_oid := to_regprocedure(target_signature)::OID;
  IF target_function_oid IS NULL THEN
    RAISE EXCEPTION 'v1 currency label repair apply function is missing';
  END IF;

  SELECT function_row.proowner, function_row.proacl,
    pg_get_functiondef(function_row.oid),
    encode(sha256(convert_to(
      pg_get_functiondef(function_row.oid), 'UTF8'
    )), 'hex')
  INTO target_function_owner, target_function_acl,
    definition, definition_hash
  FROM pg_proc function_row
  WHERE function_row.oid = target_function_oid
    AND function_row.prosecdef
    AND function_row.provolatile = 'v'
    AND function_row.proconfig @> ARRAY['search_path=pg_catalog, public'];
  IF definition IS NULL
    OR definition_hash IS DISTINCT FROM expected_repaired_definition_hash
    OR position('existing_run_row."manifest_version" = target_manifest_version'
      IN definition) = 0
    OR position('terminal_item."run_id" = operation_run_id'
      IN definition) = 0
    OR position('terminal_event."run_id" = operation_run_id'
      IN definition) = 0
    OR position('WHERE "manifest_version" = target_manifest_version'
      IN definition) <> 0
    OR position('WHERE "run_id" = operation_run_id'
      IN definition) <> 0
  THEN
    RAISE EXCEPTION 'v1 currency label repair hotfix definition is invalid hash=%',
      COALESCE(definition_hash, 'NULL');
  END IF;

  SELECT COUNT(*), COUNT(*) FILTER (
    WHERE acl_entry.privilege_type IS DISTINCT FROM 'EXECUTE'
      OR acl_entry.grantee IS DISTINCT FROM target_function_owner
      OR acl_entry.is_grantable
  )
  INTO acl_entry_count, invalid_acl_entry_count
  FROM aclexplode(COALESCE(
    target_function_acl,
    acldefault('f', target_function_owner)
  )) acl_entry;
  IF target_function_owner IS DISTINCT FROM current_user::regrole::OID
    OR acl_entry_count <> 1
    OR invalid_acl_entry_count <> 0
  THEN
    RAISE EXCEPTION
      'v1 currency label repair hotfix owner/ACL is invalid owner=% executor=% acl_entries=% invalid=%',
      target_function_owner::regrole,
      current_user,
      acl_entry_count,
      invalid_acl_entry_count;
  END IF;
END
$verify$;

ROLLBACK;
