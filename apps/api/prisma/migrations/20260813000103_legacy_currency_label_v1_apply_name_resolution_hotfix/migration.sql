-- Shared executable hotfix for the v1 Shanghai UAT label-repair authority.
--
-- 20260813000100 is immutable migration history.  Its owner-only v1 apply
-- function has three table-column references that PostgreSQL resolves as
-- ambiguous against RETURNS TABLE output variables when the function is
-- actually invoked.  This migration changes only those three references.
-- It accepts one exact legacy definition or the one exact repaired definition;
-- any other function shape fails closed rather than being rewritten.

DO $hotfix$
DECLARE
  target_signature CONSTANT TEXT :=
    'public.apply_legacy_billing_account_currency_label_repair_v1(text,uuid,text,text,text,text,text,text,text,timestamp without time zone)';
  expected_legacy_definition_hash CONSTANT TEXT :=
    '9393da93528cb65b011b8f2ee1b174c22b8d81539dd1e7c96e8fd4f823b11c2a';
  expected_repaired_definition_hash CONSTANT TEXT :=
    '5bd33cfa9c1440081e852ba9255af7d3ed4679a11f1d325ac078ded2997943ed';
  legacy_existing_run CONSTANT TEXT :=
$legacy_existing_run$  SELECT * INTO existing_run
  FROM "billing_account_currency_label_repair_runs"
  WHERE "manifest_version" = target_manifest_version;$legacy_existing_run$;
  repaired_existing_run CONSTANT TEXT :=
$repaired_existing_run$  SELECT existing_run_row.* INTO existing_run
  FROM "billing_account_currency_label_repair_runs" existing_run_row
  WHERE existing_run_row."manifest_version" = target_manifest_version;$repaired_existing_run$;
  legacy_terminal_items CONSTANT TEXT :=
$legacy_terminal_items$  IF (SELECT COUNT(*)
      FROM "billing_account_currency_label_repair_items"
      WHERE "run_id" = operation_run_id) <> expected_account_count$legacy_terminal_items$;
  repaired_terminal_items CONSTANT TEXT :=
$repaired_terminal_items$  IF (SELECT COUNT(*)
      FROM "billing_account_currency_label_repair_items" terminal_item
      WHERE terminal_item."run_id" = operation_run_id) <> expected_account_count$repaired_terminal_items$;
  legacy_terminal_events CONSTANT TEXT :=
$legacy_terminal_events$    OR (SELECT COUNT(*)
        FROM "billing_account_currency_label_repair_eligible_events"
        WHERE "run_id" = operation_run_id) <> 3$legacy_terminal_events$;
  repaired_terminal_events CONSTANT TEXT :=
$repaired_terminal_events$    OR (SELECT COUNT(*)
        FROM "billing_account_currency_label_repair_eligible_events" terminal_event
        WHERE terminal_event."run_id" = operation_run_id) <> 3$repaired_terminal_events$;
  target_function_oid OID;
  target_function_owner OID;
  target_function_acl ACLITEM[];
  target_acl_entry_count BIGINT;
  target_acl_invalid_count BIGINT;
  terminal_function_oid OID;
  terminal_function_owner OID;
  terminal_function_acl ACLITEM[];
  current_definition TEXT;
  current_definition_hash TEXT;
  repaired_definition TEXT;
  repaired_definition_hash TEXT;
BEGIN
  PERFORM pg_advisory_xact_lock(60814, hashtext(target_signature));

  SELECT function_row.oid, function_row.proowner, function_row.proacl
  INTO target_function_oid, target_function_owner, target_function_acl
  FROM pg_proc function_row
  WHERE function_row.oid = to_regprocedure(target_signature)::OID;
  IF target_function_oid IS NULL THEN
    RAISE EXCEPTION 'v1 currency label repair apply function is missing'
      USING ERRCODE = '42883';
  END IF;

  -- pg_get_functiondef does not cover ownership or ACLs.  Refuse to rewrite a
  -- SECURITY DEFINER authority unless the migration is running as its owner
  -- and EXECUTE is held only by that owner without grant option.
  SELECT COUNT(*), COUNT(*) FILTER (
    WHERE acl_entry.privilege_type IS DISTINCT FROM 'EXECUTE'
      OR acl_entry.grantee IS DISTINCT FROM target_function_owner
      OR acl_entry.is_grantable
  )
  INTO target_acl_entry_count, target_acl_invalid_count
  FROM aclexplode(COALESCE(
    target_function_acl,
    acldefault('f', target_function_owner)
  )) acl_entry;
  IF target_function_owner IS DISTINCT FROM current_user::regrole::OID
    OR target_acl_entry_count <> 1
    OR target_acl_invalid_count <> 0
  THEN
    RAISE EXCEPTION
      'v1 currency label repair apply owner/ACL is not owner-only owner=% executor=% acl_entries=% invalid=%',
      target_function_owner::regrole,
      current_user,
      target_acl_entry_count,
      target_acl_invalid_count
      USING ERRCODE = '42501';
  END IF;

  current_definition := pg_get_functiondef(target_function_oid);
  current_definition_hash := encode(sha256(convert_to(
    current_definition, 'UTF8'
  )), 'hex');

  IF current_definition_hash = expected_repaired_definition_hash THEN
    IF position(legacy_existing_run IN current_definition) <> 0
      OR position(legacy_terminal_items IN current_definition) <> 0
      OR position(legacy_terminal_events IN current_definition) <> 0
      OR position(repaired_existing_run IN current_definition) = 0
      OR position(repaired_terminal_items IN current_definition) = 0
      OR position(repaired_terminal_events IN current_definition) = 0
    THEN
      RAISE EXCEPTION 'v1 currency label repair repaired definition shape mismatch'
        USING ERRCODE = '23514';
    END IF;
    RETURN;
  END IF;

  IF current_definition_hash IS DISTINCT FROM expected_legacy_definition_hash
    OR position(legacy_existing_run IN current_definition) = 0
    OR position(legacy_terminal_items IN current_definition) = 0
    OR position(legacy_terminal_events IN current_definition) = 0
    OR position(repaired_existing_run IN current_definition) <> 0
    OR position(repaired_terminal_items IN current_definition) <> 0
    OR position(repaired_terminal_events IN current_definition) <> 0
  THEN
    RAISE EXCEPTION 'v1 currency label repair unknown definition shape hash=%',
      COALESCE(current_definition_hash, 'NULL') USING ERRCODE = '23514';
  END IF;

  repaired_definition := replace(replace(replace(
    current_definition,
    legacy_existing_run, repaired_existing_run
  ), legacy_terminal_items, repaired_terminal_items
  ), legacy_terminal_events, repaired_terminal_events);
  repaired_definition_hash := encode(sha256(convert_to(
    repaired_definition, 'UTF8'
  )), 'hex');
  IF repaired_definition_hash IS DISTINCT FROM expected_repaired_definition_hash
  THEN
    RAISE EXCEPTION 'v1 currency label repair repaired definition hash mismatch=%',
      COALESCE(repaired_definition_hash, 'NULL') USING ERRCODE = '23514';
  END IF;

  EXECUTE repaired_definition;

  SELECT function_row.oid, function_row.proowner, function_row.proacl,
    pg_get_functiondef(function_row.oid),
    encode(sha256(convert_to(
      pg_get_functiondef(function_row.oid), 'UTF8'
    )), 'hex')
  INTO terminal_function_oid, terminal_function_owner, terminal_function_acl,
    current_definition, current_definition_hash
  FROM pg_proc function_row
  WHERE function_row.oid = to_regprocedure(target_signature)::OID;
  IF terminal_function_oid IS DISTINCT FROM target_function_oid
    OR terminal_function_owner IS DISTINCT FROM target_function_owner
    OR terminal_function_acl IS DISTINCT FROM target_function_acl
    OR current_definition_hash IS DISTINCT FROM expected_repaired_definition_hash
    OR position(legacy_existing_run IN current_definition) <> 0
    OR position(legacy_terminal_items IN current_definition) <> 0
    OR position(legacy_terminal_events IN current_definition) <> 0
    OR position(repaired_existing_run IN current_definition) = 0
    OR position(repaired_terminal_items IN current_definition) = 0
    OR position(repaired_terminal_events IN current_definition) = 0
  THEN
    RAISE EXCEPTION
      'v1 currency label repair hotfix terminal proof failed oid=%/% owner=%/% acl_equal=% hash=%',
      terminal_function_oid,
      target_function_oid,
      terminal_function_owner,
      target_function_owner,
      terminal_function_acl IS NOT DISTINCT FROM target_function_acl,
      COALESCE(current_definition_hash, 'NULL')
      USING ERRCODE = '23514';
  END IF;
END
$hotfix$;
