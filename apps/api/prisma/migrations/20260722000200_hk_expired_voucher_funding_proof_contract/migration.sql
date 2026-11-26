-- Admit one retired voucher shape without weakening either existing voucher
-- proof kind: a pre-idempotency VOUCHER grant was funded while the wallet was
-- non-negative, was partially consumed, and was later zeroed by the retired
-- inline-expiry writer.  The voucher proof is valid only when it is paired
-- with the exact legacy-expiry proof from the same repair transaction.
--
-- The pairing is deliberately two-phase:
--   * while a repair is RUNNING, the immutable raw expiry proof is sufficient
--     because the standard expiry audit is inserted later in the same SQL
--     transaction; and
--   * once the account is promoted, the complete expiry proof (including the
--     exact balance_grant_expiries row) must be valid.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

-- These functions are security boundaries.  Refuse to replace an unexpected
-- implementation instead of silently erasing a later environment-specific
-- contract change.
DO $voucher_expiry_contract_preflight$
DECLARE
  shape_definition TEXT;
  insert_source TEXT;
  context_source TEXT;
  terminal_source TEXT;
  expiry_insert_source TEXT;
  expiry_valid_source TEXT;
  object_count BIGINT;
BEGIN
  SELECT COUNT(*), MIN(pg_get_constraintdef(constraint_row.oid))
  INTO object_count, shape_definition
  FROM pg_constraint constraint_row
  JOIN pg_class table_row ON table_row.oid = constraint_row.conrelid
  JOIN pg_namespace namespace_row ON namespace_row.oid = table_row.relnamespace
  WHERE namespace_row.nspname = 'public'
    AND table_row.relname = 'balance_ledger_voucher_funding_repairs'
    AND constraint_row.conname = 'balance_ledger_voucher_funding_repairs_shape_check'
    AND constraint_row.contype = 'c';
  IF object_count <> 1
    OR position('LEGACY_PRE_IDEMPOTENCY_VOUCHER_V1' IN shape_definition) = 0
    OR position(
      'LEGACY_VOUCHER_FULL_REMAINDER_DEBT_ABSORPTION_V1'
      IN shape_definition
    ) = 0
    OR position(
      'LEGACY_PRE_IDEMPOTENCY_EXPIRED_VOUCHER_V1'
      IN shape_definition
    ) <> 0
    OR position('proof_version' IN shape_definition) = 0
    OR position('hole_fill_usd' IN shape_definition) = 0
    OR position('finance_approval_ref' IN shape_definition) = 0
    OR position('technical_approval_ref' IN shape_definition) = 0
  THEN
    RAISE EXCEPTION 'voucher funding proof shape fingerprint changed'
      USING ERRCODE = '55000';
  END IF;

  SELECT COUNT(*), MIN(procedure_row.prosrc)
  INTO object_count, insert_source
  FROM pg_proc procedure_row
  JOIN pg_namespace namespace_row ON namespace_row.oid = procedure_row.pronamespace
  JOIN pg_language language_row ON language_row.oid = procedure_row.prolang
  WHERE namespace_row.nspname = 'public'
    AND procedure_row.proname = 'validate_balance_voucher_funding_proof_insert'
    AND procedure_row.pronargs = 0
    AND procedure_row.prokind = 'f'
    AND procedure_row.prorettype = 'trigger'::REGTYPE
    AND procedure_row.provolatile = 'v'
    AND NOT procedure_row.prosecdef
    AND language_row.lanname = 'plpgsql';
  IF object_count <> 1
    OR position('AND NOT grant_row."is_expired"' IN insert_source) = 0
    OR position('voucher_transaction_count = 1' IN insert_source) = 0
    OR position('live_reference_count = 0' IN insert_source) = 0
    OR position('audit_reference_count = 0' IN insert_source) = 0
    OR position('LEGACY_PRE_IDEMPOTENCY_VOUCHER_V1' IN insert_source) = 0
    OR position(
      'LEGACY_VOUCHER_FULL_REMAINDER_DEBT_ABSORPTION_V1'
      IN insert_source
    ) = 0
    OR position(
      'LEGACY_PRE_IDEMPOTENCY_EXPIRED_VOUCHER_V1'
      IN insert_source
    ) <> 0
  THEN
    RAISE EXCEPTION 'voucher funding insert guard source fingerprint changed'
      USING ERRCODE = '55000';
  END IF;

  SELECT COUNT(*), MIN(procedure_row.prosrc)
  INTO object_count, context_source
  FROM pg_proc procedure_row
  JOIN pg_namespace namespace_row ON namespace_row.oid = procedure_row.pronamespace
  JOIN pg_language language_row ON language_row.oid = procedure_row.prolang
  WHERE namespace_row.nspname = 'public'
    AND procedure_row.proname = 'balance_voucher_funding_proof_context_is_valid'
    AND procedure_row.proargtypes = '25'::OIDVECTOR
    AND procedure_row.pronargs = 1
    AND procedure_row.prokind = 'f'
    AND procedure_row.prorettype = 'boolean'::REGTYPE
    AND procedure_row.provolatile = 's'
    AND NOT procedure_row.prosecdef
    AND language_row.lanname = 'plpgsql';
  IF object_count <> 1
    OR position('active_context :=' IN context_source) = 0
    OR position('terminal_context :=' IN context_source) = 0
    OR position('archived_reference_count = 0' IN context_source) = 0
    OR position('LEGACY_PRE_IDEMPOTENCY_VOUCHER_V1' IN context_source) = 0
    OR position(
      'LEGACY_VOUCHER_FULL_REMAINDER_DEBT_ABSORPTION_V1'
      IN context_source
    ) = 0
    OR position(
      'LEGACY_PRE_IDEMPOTENCY_EXPIRED_VOUCHER_V1'
      IN context_source
    ) <> 0
  THEN
    RAISE EXCEPTION 'voucher funding context source fingerprint changed'
      USING ERRCODE = '55000';
  END IF;

  SELECT COUNT(*), MIN(procedure_row.prosrc)
  INTO object_count, terminal_source
  FROM pg_proc procedure_row
  JOIN pg_namespace namespace_row ON namespace_row.oid = procedure_row.pronamespace
  JOIN pg_language language_row ON language_row.oid = procedure_row.prolang
  WHERE namespace_row.nspname = 'public'
    AND procedure_row.proname = 'validate_balance_voucher_funding_proof_terminal'
    AND procedure_row.pronargs = 0
    AND procedure_row.prokind = 'f'
    AND procedure_row.prorettype = 'trigger'::REGTYPE
    AND procedure_row.provolatile = 'v'
    AND NOT procedure_row.prosecdef
    AND language_row.lanname = 'plpgsql';
  IF object_count <> 1
    OR position(
      'balance_voucher_funding_proof_context_is_valid'
      IN terminal_source
    ) = 0
    OR position('voucherFundingProofCount' IN terminal_source) = 0
    OR position('settlement_count <> 0' IN terminal_source) = 0
    OR position('LEGACY_PRE_IDEMPOTENCY_VOUCHER_V1' IN terminal_source) = 0
    OR position(
      'LEGACY_VOUCHER_FULL_REMAINDER_DEBT_ABSORPTION_V1'
      IN terminal_source
    ) = 0
    OR position(
      'LEGACY_PRE_IDEMPOTENCY_EXPIRED_VOUCHER_V1'
      IN terminal_source
    ) <> 0
  THEN
    RAISE EXCEPTION 'voucher funding terminal source fingerprint changed'
      USING ERRCODE = '55000';
  END IF;

  SELECT COUNT(*), MIN(procedure_row.prosrc)
  INTO object_count, expiry_insert_source
  FROM pg_proc procedure_row
  JOIN pg_namespace namespace_row ON namespace_row.oid = procedure_row.pronamespace
  JOIN pg_language language_row ON language_row.oid = procedure_row.prolang
  WHERE namespace_row.nspname = 'public'
    AND procedure_row.proname = 'validate_balance_ledger_legacy_expiry_insert'
    AND procedure_row.pronargs = 0
    AND procedure_row.prokind = 'f'
    AND procedure_row.prorettype = 'trigger'::REGTYPE
    AND procedure_row.provolatile = 'v'
    AND NOT procedure_row.prosecdef
    AND language_row.lanname = 'plpgsql';
  IF object_count <> 1
    OR position('to_jsonb(grant_row) IS DISTINCT FROM NEW."grant_snapshot"'
      IN expiry_insert_source) = 0
    OR position('to_jsonb(transaction_row) IS DISTINCT FROM NEW."transaction_snapshot"'
      IN expiry_insert_source) = 0
    OR position('existing_audit_count <> 0' IN expiry_insert_source) = 0
    OR position('NOT grant_row."is_expired"' IN expiry_insert_source) = 0
  THEN
    RAISE EXCEPTION 'legacy expiry insert guard source fingerprint changed'
      USING ERRCODE = '55000';
  END IF;

  SELECT COUNT(*), MIN(procedure_row.prosrc)
  INTO object_count, expiry_valid_source
  FROM pg_proc procedure_row
  JOIN pg_namespace namespace_row ON namespace_row.oid = procedure_row.pronamespace
  JOIN pg_language language_row ON language_row.oid = procedure_row.prolang
  WHERE namespace_row.nspname = 'public'
    AND procedure_row.proname = 'balance_ledger_legacy_expiry_proof_is_valid'
    AND procedure_row.proargtypes = '25 25 25 25'::OIDVECTOR
    AND procedure_row.pronargs = 4
    AND procedure_row.prokind = 'f'
    AND procedure_row.prorettype = 'boolean'::REGTYPE
    AND procedure_row.provolatile = 's'
    AND NOT procedure_row.prosecdef
    AND language_row.lanname = 'sql';
  IF object_count <> 1
    OR position('JOIN "balance_grant_expiries" expiry' IN expiry_valid_source) = 0
    OR position('to_jsonb(expiry) = proof."expiry_audit_snapshot"'
      IN expiry_valid_source) = 0
    OR position('repair."status" = ''APPLIED''' IN expiry_valid_source) = 0
    OR position('account_row."balance_grant_ledger_status" = ''RECONCILED_V2'''
      IN expiry_valid_source) = 0
    OR position('LEGACY_INLINE_EXPIRY_V1' IN expiry_valid_source) = 0
  THEN
    RAISE EXCEPTION 'legacy expiry terminal proof source fingerprint changed'
      USING ERRCODE = '55000';
  END IF;
END
$voucher_expiry_contract_preflight$;

ALTER TABLE "balance_ledger_voucher_funding_repairs"
  DROP CONSTRAINT "balance_ledger_voucher_funding_repairs_shape_check";

ALTER TABLE "balance_ledger_voucher_funding_repairs"
  ADD CONSTRAINT "balance_ledger_voucher_funding_repairs_shape_check" CHECK (
    "proof_version" = 1
    AND "repair_kind" IN (
      'LEGACY_PRE_IDEMPOTENCY_VOUCHER_V1',
      'LEGACY_VOUCHER_FULL_REMAINDER_DEBT_ABSORPTION_V1',
      'LEGACY_PRE_IDEMPOTENCY_EXPIRED_VOUCHER_V1'
    )
    AND jsonb_typeof("transaction_snapshot") = 'object'
    AND jsonb_typeof("grant_snapshot") = 'object'
    AND "hole_fill_usd" >= 0
    AND "hole_fill_usd" <= GREATEST(-"wallet_before_usd", 0)
    AND "finance_approval_ref" = btrim("finance_approval_ref")
    AND "technical_approval_ref" = btrim("technical_approval_ref")
    AND length(btrim("finance_approval_ref")) BETWEEN 1 AND 200
    AND length(btrim("technical_approval_ref")) BETWEEN 1 AND 200
    AND btrim("finance_approval_ref") <> btrim("technical_approval_ref")
  );

-- Validate the immutable raw proof during the RUNNING phase, while allowing
-- only the exact sequence/component changes recorded by the ordinary repair
-- audits.  The audit may be absent (before its INSERT) or must be the single
-- exact row captured by the proof.  The terminal path delegates to the full
-- legacy-expiry proof validator and therefore cannot succeed without audit.
CREATE OR REPLACE FUNCTION "balance_ledger_voucher_expiry_pair_is_valid"(
  target_run_id TEXT,
  target_repair_account_id TEXT,
  target_account_id TEXT,
  target_grant_id TEXT,
  target_finance_approval_ref TEXT,
  target_technical_approval_ref TEXT,
  require_terminal BOOLEAN
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  valid_pair_count BIGINT;
BEGIN
  IF target_run_id IS NULL
    OR target_repair_account_id IS NULL
    OR target_account_id IS NULL
    OR target_grant_id IS NULL
    OR target_finance_approval_ref IS NULL
    OR target_technical_approval_ref IS NULL
    OR require_terminal IS NULL
  THEN
    RETURN FALSE;
  END IF;

  SELECT COUNT(*) INTO valid_pair_count
  FROM "balance_ledger_legacy_expiry_repairs" proof
  JOIN "balance_ledger_repair_runs" run_row
    ON run_row."id" = proof."run_id"
  JOIN "balance_ledger_repair_accounts" repair_row
    ON repair_row."id" = proof."repair_account_id"
  JOIN "billing_accounts" account_row
    ON account_row."id" = proof."billing_account_id"
  JOIN "balance_grants" grant_row
    ON grant_row."id" = proof."balance_grant_id"
  JOIN "balance_transactions" transaction_row
    ON transaction_row."id" = proof."balance_transaction_id"
  WHERE proof."run_id" = target_run_id
    AND proof."repair_account_id" = target_repair_account_id
    AND proof."billing_account_id" = target_account_id
    AND proof."balance_grant_id" = target_grant_id
    AND proof."finance_approval_ref" = target_finance_approval_ref
    AND proof."technical_approval_ref" = target_technical_approval_ref
    AND proof."proof_version" = 1
    AND proof."repair_kind" = 'LEGACY_INLINE_EXPIRY_V1'
    AND proof."operation_key" = (
      'repair:legacy-expiry:' || proof."run_id" || ':'
      || proof."balance_transaction_id" || ':' || proof."balance_grant_id"
    )
    AND repair_row."run_id" = proof."run_id"
    AND repair_row."billing_account_id" = proof."billing_account_id"
    AND grant_row."billing_account_id" = proof."billing_account_id"
    AND grant_row."is_expired"
    AND grant_row."remaining_amount_usd" = 0
    AND COALESCE(grant_row."remaining_paid_amount_usd", 0) = 0
    AND COALESCE(grant_row."remaining_bonus_amount_usd", 0) = 0
    AND (to_jsonb(grant_row) - ARRAY[
      'remaining_paid_amount_usd', 'remaining_bonus_amount_usd', 'updated_at'
    ]) = (proof."grant_snapshot" - ARRAY[
      'remaining_paid_amount_usd', 'remaining_bonus_amount_usd', 'updated_at'
    ])
    AND grant_row."updated_at" >=
      (proof."grant_snapshot"->>'updated_at')::TIMESTAMP
    AND COALESCE(
      (proof."grant_snapshot"->>'remaining_paid_amount_usd')::NUMERIC,
      0
    ) = 0
    AND COALESCE(
      (proof."grant_snapshot"->>'remaining_bonus_amount_usd')::NUMERIC,
      0
    ) = 0
    AND transaction_row."billing_account_id" = proof."billing_account_id"
    AND transaction_row."type"::TEXT = 'ADJUST'
    AND transaction_row."amount_usd" = -proof."nominal_amount_usd"
    AND transaction_row."balance_after_usd"
      = proof."wallet_balance_after_usd"
    AND transaction_row."balance_after_usd" - transaction_row."amount_usd"
      = proof."wallet_balance_before_usd"
    AND transaction_row."description"
      = ('balance grant expired:' || proof."balance_grant_id")
    AND transaction_row."operation_key" IS NULL
    AND (
      (
        require_terminal
        AND "balance_ledger_legacy_expiry_proof_is_valid"(
          proof."balance_grant_id",
          proof."balance_transaction_id",
          proof."billing_account_id",
          proof."run_id"
        )
      )
      OR (
        NOT require_terminal
        AND NULLIF(btrim(current_setting(
          'billing.balance_ledger_repair_run_id', TRUE
        )), '') IS NOT DISTINCT FROM proof."run_id"
        AND run_row."status" = 'RUNNING'
        AND repair_row."status" = 'RUNNING'
        AND account_row."balance_grant_ledger_status" = 'LEGACY_DIRTY'
        AND account_row."balance_grant_ledger_version" = 0
        AND (
          to_jsonb(transaction_row) = proof."transaction_snapshot"
          OR EXISTS (
            SELECT 1
            FROM "balance_ledger_transaction_repairs" transaction_repair
            WHERE transaction_repair."run_id" = proof."run_id"
              AND transaction_repair."repair_account_id"
                = proof."repair_account_id"
              AND transaction_repair."billing_account_id"
                = proof."billing_account_id"
              AND transaction_repair."transaction_id"
                = proof."balance_transaction_id"
              AND transaction_repair."before_snapshot"
                = proof."transaction_snapshot"
              AND transaction_repair."after_snapshot"
                = to_jsonb(transaction_row)
              AND (transaction_repair."before_snapshot" - 'ledger_sequence')
                = (transaction_repair."after_snapshot" - 'ledger_sequence')
              AND transaction_repair."before_snapshot"->'ledger_sequence'
                = 'null'::JSONB
              AND (transaction_repair."after_snapshot"->>'ledger_sequence')::BIGINT
                < 0
          )
        )
        AND (
          (
            SELECT COUNT(*)
            FROM "balance_grant_expiries" expiry
            WHERE expiry."id" = proof."expiry_audit_id"
              OR expiry."balance_grant_id" = proof."balance_grant_id"
              OR expiry."balance_transaction_id"
                = proof."balance_transaction_id"
          ) = 0
          OR (
            (
              SELECT COUNT(*)
              FROM "balance_grant_expiries" expiry
              WHERE expiry."id" = proof."expiry_audit_id"
                OR expiry."balance_grant_id" = proof."balance_grant_id"
                OR expiry."balance_transaction_id"
                  = proof."balance_transaction_id"
            ) = 1
            AND EXISTS (
              SELECT 1
              FROM "balance_grant_expiries" expiry
              WHERE expiry."id" = proof."expiry_audit_id"
                AND expiry."balance_grant_id" = proof."balance_grant_id"
                AND expiry."billing_account_id" = proof."billing_account_id"
                AND expiry."balance_transaction_id"
                  = proof."balance_transaction_id"
                AND to_jsonb(expiry) = proof."expiry_audit_snapshot"
            )
          )
        )
      )
    );

  RETURN valid_pair_count = 1;
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range
    OR datetime_field_overflow
  THEN
    RETURN FALSE;
END
$$;

CREATE OR REPLACE FUNCTION "validate_balance_voucher_funding_proof_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  active_run_id TEXT;
  run_status TEXT;
  repair_row RECORD;
  account_row RECORD;
  rollout_row RECORD;
  transaction_row "balance_transactions"%ROWTYPE;
  grant_row "balance_grants"%ROWTYPE;
  transaction_snapshot JSONB;
  grant_snapshot JSONB;
  voucher_transaction_count BIGINT;
  live_reference_count BIGINT;
  live_full_match_count BIGINT;
  audit_reference_count BIGINT;
  audit_full_match_count BIGINT;
  wallet_before_usd NUMERIC;
  hole_fill_usd NUMERIC;
  minted_grant_amount_usd NUMERIC;
  amount_cents NUMERIC;
  valid_shape BOOLEAN;
BEGIN
  active_run_id := current_setting('billing.balance_ledger_repair_run_id', TRUE);
  SELECT "status" INTO run_status
  FROM "balance_ledger_repair_runs"
  WHERE "id" = NEW."run_id";
  SELECT * INTO repair_row
  FROM "balance_ledger_repair_accounts"
  WHERE "id" = NEW."repair_account_id";
  SELECT * INTO account_row
  FROM "billing_accounts"
  WHERE "id" = NEW."billing_account_id";
  SELECT * INTO rollout_row
  FROM "balance_ledger_rollout_control"
  WHERE "id" = 1;
  SELECT * INTO transaction_row
  FROM "balance_transactions" funding
  WHERE funding."id" = NEW."transaction_id";
  transaction_snapshot := to_jsonb(transaction_row);
  SELECT * INTO grant_row
  FROM "balance_grants" voucher_grant
  WHERE voucher_grant."id" = NEW."grant_id";
  grant_snapshot := to_jsonb(grant_row);

  wallet_before_usd := transaction_row."balance_after_usd"
    - transaction_row."amount_usd";
  hole_fill_usd := LEAST(
    transaction_row."amount_usd",
    GREATEST(-wallet_before_usd, 0)
  );
  minted_grant_amount_usd := transaction_row."amount_usd" - hole_fill_usd;
  amount_cents := ROUND(transaction_row."amount_usd" * 100, 0);

  SELECT COUNT(*) INTO voucher_transaction_count
  FROM "balance_transactions" funding
  WHERE funding."billing_account_id" = NEW."billing_account_id"
    AND substring(funding."description" FROM '^voucher:([^[:space:]]+)')
      = NEW."grant_id";

  SELECT COUNT(*), COUNT(*) FILTER (
    WHERE "balance_legacy_voucher_full_remainder_receipt_matches"(
      jsonb_build_object(
        'key', idem."key",
        'scope', idem."scope",
        'userId', idem."user_id",
        'status', idem."status",
        'result', idem."result",
        'createdAt', idem."created_at",
        'expiresAt', idem."expires_at"
      ),
      NEW."billing_account_id",
      NEW."transaction_id",
      NEW."grant_id"
    )
  )
  INTO live_reference_count, live_full_match_count
  FROM "idempotency_keys" idem
  WHERE idem."result" #>> '{transaction,id}' = NEW."transaction_id"
    OR idem."result" #>> '{grant,id}' = NEW."grant_id";

  SELECT COUNT(*), COUNT(*) FILTER (
    WHERE "balance_legacy_voucher_full_remainder_receipt_matches"(
      evidence,
      NEW."billing_account_id",
      NEW."transaction_id",
      NEW."grant_id"
    )
  )
  INTO audit_reference_count, audit_full_match_count
  FROM jsonb_array_elements(COALESCE(
    repair_row."before_snapshot"->'voucherIdempotencyEvidence',
    '[]'::JSONB
  )) evidence
  WHERE evidence #>> '{result,transaction,id}' = NEW."transaction_id"
    OR evidence #>> '{result,grant,id}' = NEW."grant_id";

  valid_shape :=
    active_run_id IS NOT DISTINCT FROM NEW."run_id"
    AND run_status IS NOT DISTINCT FROM 'RUNNING'
    AND repair_row."id" IS NOT NULL
    AND repair_row."run_id" IS NOT DISTINCT FROM NEW."run_id"
    AND repair_row."billing_account_id" IS NOT DISTINCT FROM NEW."billing_account_id"
    AND repair_row."status" IS NOT DISTINCT FROM 'RUNNING'
    AND account_row."id" IS NOT NULL
    AND account_row."type" IS NOT DISTINCT FROM 'personal'
    AND account_row."balance_grant_ledger_status" IS NOT DISTINCT FROM 'LEGACY_DIRTY'
    AND rollout_row."id" IS NOT NULL
    AND rollout_row."phase" IN ('EXPANDED', 'CUTOVER_READY', 'V2_CONTRACT')
    AND transaction_row."id" IS NOT NULL
    AND grant_row."id" IS NOT NULL
    AND transaction_snapshot IS NOT DISTINCT FROM NEW."transaction_snapshot"
    AND grant_snapshot IS NOT DISTINCT FROM NEW."grant_snapshot"
    AND transaction_row."billing_account_id" IS NOT DISTINCT FROM NEW."billing_account_id"
    AND grant_row."billing_account_id" IS NOT DISTINCT FROM NEW."billing_account_id"
    AND transaction_row."created_at" < rollout_row."expanded_at"
    AND grant_row."created_at" < rollout_row."expanded_at"
    AND transaction_row."type"::TEXT IS NOT DISTINCT FROM 'ADJUST'
    AND transaction_row."amount_usd" > 0
    AND transaction_row."amount_usd" IS NOT DISTINCT FROM amount_cents / 100
    AND transaction_row."operation_key" IS NULL
    AND transaction_row."order_id" IS NULL
    AND transaction_row."user_id" IS NOT NULL
    AND transaction_row."tenant_id" IS NOT NULL
    AND transaction_row."description"
      ~ '^voucher:[^[:space:]]+[[:space:]]+admin:[^[:space:]]+(?:[[:space:]]+[^[:space:]](?:.*[^[:space:]])?)?$'
    AND substring(transaction_row."description" FROM '^voucher:([^[:space:]]+)')
      IS NOT DISTINCT FROM NEW."grant_id"
    AND voucher_transaction_count = 1
    AND grant_row."source" IS NOT DISTINCT FROM 'VOUCHER'
    AND grant_row."order_id" IS NULL
    AND grant_row."user_id" IS NOT DISTINCT FROM transaction_row."user_id"
    AND grant_row."tenant_id" IS NOT DISTINCT FROM transaction_row."tenant_id"
    AND grant_row."product_id" IS NOT DISTINCT FROM transaction_row."product_id"
    AND grant_row."paid_amount_usd" IS NOT DISTINCT FROM 0
    AND grant_row."bonus_amount_usd" IS NOT DISTINCT FROM transaction_row."amount_usd"
    AND grant_row."granted_amount_usd" IS NOT DISTINCT FROM transaction_row."amount_usd"
    AND grant_row."discount_rate" IS NOT DISTINCT FROM 0
    AND grant_row."remaining_amount_usd" BETWEEN 0 AND grant_row."granted_amount_usd"
    AND (
      (
        grant_row."remaining_paid_amount_usd" IS NULL
        AND grant_row."remaining_bonus_amount_usd" IS NULL
      )
      OR (
        grant_row."remaining_paid_amount_usd" IS NOT NULL
        AND grant_row."remaining_bonus_amount_usd" IS NOT NULL
        AND grant_row."remaining_paid_amount_usd"
          + grant_row."remaining_bonus_amount_usd"
          = grant_row."remaining_amount_usd"
      )
    )
    AND grant_row."valid_from" <= grant_row."created_at"
    AND grant_row."created_at" < transaction_row."created_at"
    AND (grant_row."expires_at" IS NULL OR grant_row."expires_at" > grant_row."valid_from")
    AND wallet_before_usd IS NOT DISTINCT FROM NEW."wallet_before_usd"
    AND hole_fill_usd IS NOT DISTINCT FROM NEW."hole_fill_usd"
    AND minted_grant_amount_usd >= 0
    AND NEW."operation_key" IS NOT DISTINCT FROM (
      'repair:voucher-funding:' || NEW."run_id" || ':'
      || NEW."transaction_id" || ':' || NEW."grant_id"
    );
  IF valid_shape IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION
      'legacy voucher proof is not authorized run=% account=% tx=% grant=%',
      NEW."run_id", NEW."billing_account_id", NEW."transaction_id", NEW."grant_id"
      USING ERRCODE = '23514';
  END IF;

  IF NEW."repair_kind" = 'LEGACY_PRE_IDEMPOTENCY_VOUCHER_V1' THEN
    valid_shape := NOT grant_row."is_expired"
      AND wallet_before_usd = 0
      AND hole_fill_usd = 0
      AND live_reference_count = 0
      AND audit_reference_count = 0;
  ELSIF NEW."repair_kind"
    = 'LEGACY_PRE_IDEMPOTENCY_EXPIRED_VOUCHER_V1'
  THEN
    valid_shape := grant_row."is_expired"
      AND wallet_before_usd >= 0
      AND hole_fill_usd = 0
      AND live_reference_count = 0
      AND audit_reference_count = 0
      AND "balance_ledger_voucher_expiry_pair_is_valid"(
        NEW."run_id",
        NEW."repair_account_id",
        NEW."billing_account_id",
        NEW."grant_id",
        NEW."finance_approval_ref",
        NEW."technical_approval_ref",
        FALSE
      );
  ELSE
    valid_shape := NEW."repair_kind"
        = 'LEGACY_VOUCHER_FULL_REMAINDER_DEBT_ABSORPTION_V1'
      AND NOT grant_row."is_expired"
      AND wallet_before_usd < 0
      AND hole_fill_usd > 0
      AND live_reference_count = 1
      AND live_full_match_count = 1
      AND audit_reference_count = 1
      AND audit_full_match_count = 1;
  END IF;
  IF valid_shape IS DISTINCT FROM TRUE THEN
    RAISE EXCEPTION
      'legacy voucher proof evidence is invalid kind=% tx=% grant=% live=%/% audit=%/%',
      NEW."repair_kind", NEW."transaction_id", NEW."grant_id",
      live_full_match_count, live_reference_count,
      audit_full_match_count, audit_reference_count
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range
    OR datetime_field_overflow
  THEN
    RAISE EXCEPTION
      'legacy voucher proof contains invalid typed evidence tx=% grant=%',
      NEW."transaction_id", NEW."grant_id"
      USING ERRCODE = '23514';
END
$$;

CREATE OR REPLACE FUNCTION "balance_voucher_funding_proof_context_is_valid"(
  target_proof_id TEXT
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  proof_row RECORD;
  repair_row RECORD;
  run_status TEXT;
  account_row RECORD;
  rollout_row RECORD;
  transaction_row "balance_transactions"%ROWTYPE;
  grant_row "balance_grants"%ROWTYPE;
  live_reference_count BIGINT;
  archived_reference_count BIGINT;
  archived_full_match_count BIGINT;
  active_context BOOLEAN;
  terminal_context BOOLEAN;
BEGIN
  SELECT * INTO proof_row
  FROM "balance_ledger_voucher_funding_repairs"
  WHERE "id" = target_proof_id;
  IF NOT FOUND THEN
    RETURN FALSE;
  END IF;
  SELECT * INTO repair_row
  FROM "balance_ledger_repair_accounts"
  WHERE "id" = proof_row."repair_account_id";
  SELECT "status" INTO run_status
  FROM "balance_ledger_repair_runs"
  WHERE "id" = proof_row."run_id";
  SELECT * INTO account_row
  FROM "billing_accounts"
  WHERE "id" = proof_row."billing_account_id";
  SELECT * INTO rollout_row
  FROM "balance_ledger_rollout_control"
  WHERE "id" = 1;
  SELECT * INTO transaction_row
  FROM "balance_transactions"
  WHERE "id" = proof_row."transaction_id";
  SELECT * INTO grant_row
  FROM "balance_grants"
  WHERE "id" = proof_row."grant_id";

  IF proof_row."repair_kind"
    = 'LEGACY_PRE_IDEMPOTENCY_EXPIRED_VOUCHER_V1'
  THEN
    SELECT COUNT(*) INTO live_reference_count
    FROM "idempotency_keys" idem
    WHERE idem."result" #>> '{transaction,id}' = proof_row."transaction_id"
      OR idem."result" #>> '{grant,id}' = proof_row."grant_id";
  ELSE
    live_reference_count := 0;
  END IF;

  SELECT COUNT(*), COUNT(*) FILTER (
    WHERE "balance_legacy_voucher_full_remainder_receipt_matches"(
      evidence,
      proof_row."billing_account_id",
      proof_row."transaction_id",
      proof_row."grant_id"
    )
  )
  INTO archived_reference_count, archived_full_match_count
  FROM jsonb_array_elements(COALESCE(
    repair_row."before_snapshot"->'voucherIdempotencyEvidence',
    '[]'::JSONB
  )) evidence
  WHERE evidence #>> '{result,transaction,id}' = proof_row."transaction_id"
    OR evidence #>> '{result,grant,id}' = proof_row."grant_id";

  active_context :=
    current_setting('billing.balance_ledger_repair_run_id', TRUE)
      IS NOT DISTINCT FROM proof_row."run_id"
    AND run_status IS NOT DISTINCT FROM 'RUNNING'
    AND repair_row."status" IS NOT DISTINCT FROM 'RUNNING'
    AND account_row."balance_grant_ledger_status" IS NOT DISTINCT FROM 'LEGACY_DIRTY';
  terminal_context :=
    run_status IN ('RUNNING', 'COMPLETED', 'COMPLETED_WITH_EXCEPTIONS')
    AND repair_row."status" IS NOT DISTINCT FROM 'APPLIED'
    AND account_row."balance_grant_ledger_status" IS NOT DISTINCT FROM 'RECONCILED_V2'
    AND account_row."balance_grant_ledger_version" IS NOT DISTINCT FROM 2
    AND repair_row."replay_hash" IS NOT DISTINCT FROM
      account_row."balance_grant_ledger_hash";

  RETURN (active_context OR terminal_context)
    AND repair_row."run_id" IS NOT DISTINCT FROM proof_row."run_id"
    AND repair_row."billing_account_id" IS NOT DISTINCT FROM proof_row."billing_account_id"
    AND account_row."type" IS NOT DISTINCT FROM 'personal'
    AND rollout_row."id" IS NOT NULL
    AND rollout_row."phase" IN ('EXPANDED', 'CUTOVER_READY', 'V2_CONTRACT')
    AND transaction_row."id" IS NOT NULL
    AND grant_row."id" IS NOT NULL
    AND transaction_row."billing_account_id"
      IS NOT DISTINCT FROM proof_row."billing_account_id"
    AND grant_row."billing_account_id"
      IS NOT DISTINCT FROM proof_row."billing_account_id"
    AND transaction_row."created_at" < rollout_row."expanded_at"
    AND grant_row."created_at" < rollout_row."expanded_at"
    AND (to_jsonb(transaction_row) - 'ledger_sequence')
      IS NOT DISTINCT FROM (proof_row."transaction_snapshot" - 'ledger_sequence')
    AND (
      to_jsonb(grant_row)
        - 'remaining_amount_usd' - 'remaining_paid_amount_usd'
        - 'remaining_bonus_amount_usd' - 'updated_at' - 'is_expired'
    ) IS NOT DISTINCT FROM (
      proof_row."grant_snapshot"
        - 'remaining_amount_usd' - 'remaining_paid_amount_usd'
        - 'remaining_bonus_amount_usd' - 'updated_at' - 'is_expired'
    )
    AND proof_row."operation_key" IS NOT DISTINCT FROM (
      'repair:voucher-funding:' || proof_row."run_id" || ':'
      || proof_row."transaction_id" || ':' || proof_row."grant_id"
    )
    AND proof_row."finance_approval_ref" = btrim(proof_row."finance_approval_ref")
    AND proof_row."technical_approval_ref" = btrim(proof_row."technical_approval_ref")
    AND length(proof_row."finance_approval_ref") BETWEEN 1 AND 200
    AND length(proof_row."technical_approval_ref") BETWEEN 1 AND 200
    AND proof_row."finance_approval_ref" <> proof_row."technical_approval_ref"
    AND (
      (
        proof_row."repair_kind" = 'LEGACY_PRE_IDEMPOTENCY_VOUCHER_V1'
        AND proof_row."wallet_before_usd" = 0
        AND proof_row."hole_fill_usd" = 0
        AND archived_reference_count = 0
      )
      OR (
        proof_row."repair_kind"
          = 'LEGACY_VOUCHER_FULL_REMAINDER_DEBT_ABSORPTION_V1'
        AND proof_row."wallet_before_usd" < 0
        AND proof_row."hole_fill_usd" > 0
        AND archived_reference_count = 1
        AND archived_full_match_count = 1
      )
      OR (
        proof_row."repair_kind"
          = 'LEGACY_PRE_IDEMPOTENCY_EXPIRED_VOUCHER_V1'
        AND proof_row."wallet_before_usd" >= 0
        AND proof_row."hole_fill_usd" = 0
        AND live_reference_count = 0
        AND archived_reference_count = 0
        AND (
          (
            active_context
            AND "balance_ledger_voucher_expiry_pair_is_valid"(
              proof_row."run_id",
              proof_row."repair_account_id",
              proof_row."billing_account_id",
              proof_row."grant_id",
              proof_row."finance_approval_ref",
              proof_row."technical_approval_ref",
              FALSE
            )
          )
          OR (
            terminal_context
            AND "balance_ledger_voucher_expiry_pair_is_valid"(
              proof_row."run_id",
              proof_row."repair_account_id",
              proof_row."billing_account_id",
              proof_row."grant_id",
              proof_row."finance_approval_ref",
              proof_row."technical_approval_ref",
              TRUE
            )
          )
        )
      )
    );
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range
    OR datetime_field_overflow
  THEN
    RETURN FALSE;
END
$$;

CREATE OR REPLACE FUNCTION "validate_balance_voucher_funding_proof_terminal"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  run_status TEXT;
  repair_row RECORD;
  account_row RECORD;
  transaction_row "balance_transactions"%ROWTYPE;
  proof_count BIGINT;
  plan_count BIGINT;
  plan_match_count BIGINT;
  settlement_count BIGINT;
  settlement_allocation_count BIGINT;
  settlement_total NUMERIC;
  invalid_settlement_count BIGINT;
  invalid_opening_retirement_count BIGINT;
BEGIN
  SELECT "status" INTO run_status
  FROM "balance_ledger_repair_runs"
  WHERE "id" = NEW."run_id";
  SELECT * INTO repair_row
  FROM "balance_ledger_repair_accounts"
  WHERE "id" = NEW."repair_account_id";
  SELECT * INTO account_row
  FROM "billing_accounts"
  WHERE "id" = NEW."billing_account_id";
  SELECT * INTO transaction_row
  FROM "balance_transactions"
  WHERE "id" = NEW."transaction_id";

  SELECT COUNT(*) INTO proof_count
  FROM "balance_ledger_voucher_funding_repairs" proof
  WHERE proof."run_id" = NEW."run_id"
    AND proof."repair_account_id" = NEW."repair_account_id"
    AND proof."billing_account_id" = NEW."billing_account_id";
  SELECT COUNT(*) INTO plan_count
  FROM jsonb_array_elements(COALESCE(
    repair_row."after_snapshot"->'voucherFundingProofs',
    '[]'::JSONB
  )) proof_plan;
  SELECT COUNT(*) INTO plan_match_count
  FROM jsonb_array_elements(COALESCE(
    repair_row."after_snapshot"->'voucherFundingProofs',
    '[]'::JSONB
  )) proof_plan
  WHERE (proof_plan->>'proofVersion')::INTEGER = NEW."proof_version"
    AND proof_plan->>'repairKind' = NEW."repair_kind"
    AND proof_plan->>'transactionId' = NEW."transaction_id"
    AND proof_plan->>'grantId' = NEW."grant_id"
    AND (proof_plan->>'walletBeforeUsd')::NUMERIC = NEW."wallet_before_usd"
    AND (proof_plan->>'holeFillUsd')::NUMERIC = NEW."hole_fill_usd"
    AND proof_plan->>'financeApprovalRef' = NEW."finance_approval_ref"
    AND proof_plan->>'technicalApprovalRef' = NEW."technical_approval_ref";

  SELECT COUNT(*), COUNT(DISTINCT settlement."allocation_id"),
    COALESCE(SUM(settlement."amount_usd"), 0),
    COUNT(*) FILTER (
      WHERE settlement."repair_run_id" IS DISTINCT FROM NEW."run_id"
        OR settlement."trigger" IS DISTINCT FROM 'REPAIR'
        OR settlement."billing_account_id" IS DISTINCT FROM NEW."billing_account_id"
        OR settlement."balance_grant_id" IS DISTINCT FROM NEW."grant_id"
        OR settlement."debt_source" IS DISTINCT FROM 'NEGATIVE_BALANCE'
        OR settlement."paid_usd" <> 0
        OR settlement."bonus_usd" IS DISTINCT FROM settlement."amount_usd"
        OR settlement."occurred_at" IS DISTINCT FROM transaction_row."created_at"
    )
  INTO settlement_count, settlement_allocation_count,
    settlement_total, invalid_settlement_count
  FROM "enterprise_credit_settlements" settlement
  WHERE settlement."repayment_transaction_id" = NEW."transaction_id";

  SELECT COUNT(*) INTO invalid_opening_retirement_count
  FROM "enterprise_credit_settlements" settlement
  WHERE settlement."repayment_transaction_id" = NEW."transaction_id"
    AND NOT EXISTS (
      SELECT 1
      FROM "balance_ledger_grant_retirement_repairs" retirement
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(
        repair_row."before_snapshot"->'grants',
        '[]'::JSONB
      )) before_grant
      CROSS JOIN LATERAL jsonb_array_elements(COALESCE(
        repair_row."after_snapshot"->'migrationOpeningDebtMutations',
        '[]'::JSONB
      )) opening_mutation
      WHERE retirement."run_id" = NEW."run_id"
        AND retirement."repair_account_id" = NEW."repair_account_id"
        AND retirement."billing_account_id" = NEW."billing_account_id"
        AND retirement."allocation_id" = settlement."allocation_id"
        AND "balance_migration_opening_retirement_proof_is_valid"(
          retirement."id",
          NEW."billing_account_id",
          NEW."run_id",
          NEW."repair_account_id",
          before_grant,
          opening_mutation
        )
    );

  IF run_status IS DISTINCT FROM 'RUNNING'
    OR repair_row."id" IS NULL
    OR repair_row."run_id" IS DISTINCT FROM NEW."run_id"
    OR repair_row."billing_account_id" IS DISTINCT FROM NEW."billing_account_id"
    OR repair_row."status" IS DISTINCT FROM 'APPLIED'
    OR repair_row."replay_hash" IS DISTINCT FROM account_row."balance_grant_ledger_hash"
    OR account_row."type" IS DISTINCT FROM 'personal'
    OR account_row."balance_grant_ledger_status" IS DISTINCT FROM 'RECONCILED_V2'
    OR account_row."balance_grant_ledger_version" IS DISTINCT FROM 2
    OR NOT "balance_voucher_funding_proof_context_is_valid"(NEW."id")
    OR (repair_row."after_snapshot"->>'voucherFundingProofCount')::BIGINT
      IS DISTINCT FROM proof_count
    OR proof_count <> plan_count
    OR plan_match_count <> 1
    OR invalid_settlement_count <> 0
    OR (
      NEW."repair_kind" = 'LEGACY_PRE_IDEMPOTENCY_VOUCHER_V1'
      AND (
        NEW."wallet_before_usd" <> 0
        OR NEW."hole_fill_usd" <> 0
        OR settlement_count <> 0
        OR invalid_opening_retirement_count <> 0
      )
    )
    OR (
      NEW."repair_kind"
        = 'LEGACY_PRE_IDEMPOTENCY_EXPIRED_VOUCHER_V1'
      AND (
        NEW."wallet_before_usd" < 0
        OR NEW."hole_fill_usd" <> 0
        OR settlement_count <> 0
        OR invalid_opening_retirement_count <> 0
        OR NOT "balance_ledger_voucher_expiry_pair_is_valid"(
          NEW."run_id",
          NEW."repair_account_id",
          NEW."billing_account_id",
          NEW."grant_id",
          NEW."finance_approval_ref",
          NEW."technical_approval_ref",
          TRUE
        )
      )
    )
    OR (
      NEW."repair_kind"
        = 'LEGACY_VOUCHER_FULL_REMAINDER_DEBT_ABSORPTION_V1'
      AND (
        settlement_count = 0
        OR settlement_count <> settlement_allocation_count
        OR settlement_total IS DISTINCT FROM NEW."hole_fill_usd"
        OR invalid_opening_retirement_count <> 0
      )
    )
  THEN
    RAISE EXCEPTION
      'legacy voucher proof cannot commit before exact canonical promotion run=% account=% tx=% grant=%',
      NEW."run_id", NEW."billing_account_id", NEW."transaction_id", NEW."grant_id"
      USING ERRCODE = '23514';
  END IF;

  PERFORM "assert_balance_ledger_canonical_promotion"(
    NEW."billing_account_id",
    NEW."run_id",
    FALSE
  );
  RETURN NULL;
EXCEPTION
  WHEN invalid_text_representation OR numeric_value_out_of_range
    OR datetime_field_overflow
  THEN
    RAISE EXCEPTION
      'legacy voucher terminal proof contains invalid typed evidence tx=% grant=%',
      NEW."transaction_id", NEW."grant_id"
      USING ERRCODE = '23514';
END
$$;

COMMIT;
