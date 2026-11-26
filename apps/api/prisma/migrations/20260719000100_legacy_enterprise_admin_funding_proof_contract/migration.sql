-- Permanent, receipt-backed proof for the retired enterprise admin-funding
-- writer.  This migration neither invents funding nor mutates historical
-- timestamps: CREATE_GRANT is authorized only by a direct COMMITTED ADJUST
-- receipt, while LINK_GRANT binds the one exact later no-order RECHARGE grant.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "balance_ledger_admin_funding_repairs" (
  "id" TEXT PRIMARY KEY,
  "operation_key" TEXT NOT NULL UNIQUE,
  "proof_version" INTEGER NOT NULL DEFAULT 1,
  "proof_hash" TEXT NOT NULL,
  "repair_kind" TEXT NOT NULL,
  "action" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "repair_account_id" TEXT NOT NULL,
  "billing_account_id" TEXT NOT NULL,
  "balance_transaction_id" TEXT NOT NULL,
  -- Deliberately no grant FK.  CREATE_GRANT proof must precede the guarded
  -- grant INSERT; a deferred validator below requires the terminal row.
  "balance_grant_id" TEXT NOT NULL,
  "idempotency_key" TEXT NOT NULL,
  "idempotency_scope" TEXT NOT NULL,
  "idempotency_snapshot" JSONB NOT NULL,
  "transaction_snapshot" JSONB NOT NULL,
  "grant_snapshot" JSONB NOT NULL,
  "canonical_remaining_amount_usd" NUMERIC(20, 12) NOT NULL,
  "canonical_remaining_paid_amount_usd" NUMERIC(20, 12) NOT NULL,
  "canonical_remaining_bonus_amount_usd" NUMERIC(20, 12) NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "balance_ledger_admin_funding_repairs_run_fkey"
    FOREIGN KEY ("run_id") REFERENCES "balance_ledger_repair_runs"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_admin_funding_repairs_repair_fkey"
    FOREIGN KEY ("repair_account_id") REFERENCES "balance_ledger_repair_accounts"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_admin_funding_repairs_account_fkey"
    FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_admin_funding_repairs_transaction_fkey"
    FOREIGN KEY ("balance_transaction_id") REFERENCES "balance_transactions"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "balance_ledger_admin_funding_repairs_shape_check" CHECK (
    "proof_version" = 1
    AND "proof_hash" ~ '^[0-9a-f]{64}$'
    AND "proof_hash" <> repeat('0', 64)
    AND "repair_kind" = 'LEGACY_ENTERPRISE_ADMIN_FUNDING_V1'
    AND "action" IN ('CREATE_GRANT', 'LINK_GRANT')
    AND "idempotency_scope" = CASE "action"
      WHEN 'CREATE_GRANT' THEN 'admin:adjust-balance'
      WHEN 'LINK_GRANT' THEN 'admin:recharge'
    END
    AND "canonical_remaining_amount_usd" >= 0
    AND "canonical_remaining_paid_amount_usd" >= 0
    AND "canonical_remaining_bonus_amount_usd" = 0
    AND "canonical_remaining_amount_usd"
      = "canonical_remaining_paid_amount_usd"
        + "canonical_remaining_bonus_amount_usd"
  )
);

CREATE UNIQUE INDEX "balance_ledger_admin_funding_repairs_transaction_key"
  ON "balance_ledger_admin_funding_repairs"("balance_transaction_id");
CREATE UNIQUE INDEX "balance_ledger_admin_funding_repairs_grant_key"
  ON "balance_ledger_admin_funding_repairs"("balance_grant_id");
CREATE UNIQUE INDEX "balance_ledger_admin_funding_repairs_run_tx_key"
  ON "balance_ledger_admin_funding_repairs"(
    "run_id", "billing_account_id", "balance_transaction_id"
  );
CREATE UNIQUE INDEX "balance_ledger_admin_funding_repairs_receipt_key"
  ON "balance_ledger_admin_funding_repairs"(
    "idempotency_key", "idempotency_scope"
  );
CREATE INDEX "balance_ledger_admin_funding_repairs_account_created_idx"
  ON "balance_ledger_admin_funding_repairs"("billing_account_id", "created_at");

CREATE OR REPLACE FUNCTION "reject_balance_ledger_admin_funding_repair_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'admin funding repair proof is append-only id=%', OLD."id"
    USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER "balance_ledger_admin_funding_repairs_append_only"
BEFORE UPDATE OR DELETE ON "balance_ledger_admin_funding_repairs"
FOR EACH ROW
EXECUTE FUNCTION "reject_balance_ledger_admin_funding_repair_mutation"();

CREATE OR REPLACE FUNCTION "validate_balance_ledger_admin_funding_repair_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  active_run_id TEXT;
  run_status TEXT;
  repair_row RECORD;
  account_row RECORD;
  funding_row RECORD;
  receipt_row RECORD;
  linked_grant RECORD;
  receipt JSONB;
  target_grant JSONB;
  expected_transaction_type TEXT;
  expected_scope TEXT;
  key_prefix TEXT;
  candidate_count BIGINT;
BEGIN
  active_run_id := NULLIF(btrim(current_setting(
    'billing.balance_ledger_repair_run_id', TRUE
  )), '');
  SELECT "status" INTO run_status
  FROM "balance_ledger_repair_runs"
  WHERE "id" = NEW."run_id";
  SELECT * INTO repair_row
  FROM "balance_ledger_repair_accounts"
  WHERE "id" = NEW."repair_account_id";
  SELECT * INTO account_row
  FROM "billing_accounts"
  WHERE "id" = NEW."billing_account_id";
  SELECT * INTO funding_row
  FROM "balance_transactions"
  WHERE "id" = NEW."balance_transaction_id";
  SELECT * INTO receipt_row
  FROM "idempotency_keys"
  WHERE "key" = NEW."idempotency_key"
    AND "scope" = NEW."idempotency_scope";

  receipt := receipt_row."result";
  target_grant := NEW."grant_snapshot";
  expected_transaction_type := CASE NEW."action"
    WHEN 'CREATE_GRANT' THEN 'ADJUST'
    WHEN 'LINK_GRANT' THEN 'RECHARGE'
  END;
  expected_scope := CASE NEW."action"
    WHEN 'CREATE_GRANT' THEN 'admin:adjust-balance'
    WHEN 'LINK_GRANT' THEN 'admin:recharge'
  END;
  key_prefix := 'enterprise-recharge:' || NEW."billing_account_id" || ':';

  IF active_run_id IS DISTINCT FROM NEW."run_id"
    OR run_status IS DISTINCT FROM 'RUNNING'
    OR repair_row."id" IS NULL
    OR repair_row."run_id" IS DISTINCT FROM NEW."run_id"
    OR repair_row."billing_account_id" IS DISTINCT FROM NEW."billing_account_id"
    OR repair_row."status" IS DISTINCT FROM 'RUNNING'
    OR account_row."id" IS NULL
    OR account_row."type" IS DISTINCT FROM 'enterprise'
    OR account_row."balance_grant_ledger_status" IS DISTINCT FROM 'LEGACY_DIRTY'
    OR account_row."balance_grant_ledger_version" IS DISTINCT FROM 0
    OR funding_row."id" IS NULL
    OR funding_row."billing_account_id" IS DISTINCT FROM NEW."billing_account_id"
    OR funding_row."type"::TEXT IS DISTINCT FROM expected_transaction_type
    OR funding_row."amount_usd" <= 0
    OR funding_row."order_id" IS NOT NULL
    OR funding_row."operation_key" IS NOT NULL
    OR funding_row."token_usage_id" IS NOT NULL
    OR to_jsonb(funding_row) IS DISTINCT FROM NEW."transaction_snapshot"
    OR receipt_row."key" IS NULL
    OR receipt_row."status" IS DISTINCT FROM 'COMMITTED'
    OR receipt_row."user_id" IS DISTINCT FROM funding_row."user_id"
    OR receipt_row."created_at" > funding_row."created_at"
    OR receipt_row."expires_at" <= funding_row."created_at"
    OR to_jsonb(receipt_row) IS DISTINCT FROM NEW."idempotency_snapshot"
    OR NEW."idempotency_scope" IS DISTINCT FROM expected_scope
    OR left(NEW."idempotency_key", length(key_prefix)) IS DISTINCT FROM key_prefix
    OR length(NEW."idempotency_key") <= length(key_prefix)
    OR length(NEW."idempotency_key") > 160
    OR substring(NEW."idempotency_key" FROM length(key_prefix) + 1)
      ~ '[[:space:]]'
    OR NEW."operation_key" IS DISTINCT FROM (
      'repair:enterprise-admin-funding:' || NEW."run_id" || ':'
      || NEW."balance_transaction_id"
    )
    OR jsonb_typeof(receipt) IS DISTINCT FROM 'object'
    OR NOT (receipt ?& ARRAY[
      'id',
      'userId',
      'tenantId',
      'productId',
      'type',
      'amountCents',
      'balanceAfterCents',
      'amountUsd',
      'balanceAfterUsd',
      'description',
      'createdAt'
    ])
    OR (SELECT COUNT(*) FROM jsonb_object_keys(receipt)) <> 11
    OR jsonb_typeof(receipt->'id') IS DISTINCT FROM 'string'
    OR jsonb_typeof(receipt->'userId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(receipt->'tenantId') IS DISTINCT FROM 'string'
    OR jsonb_typeof(receipt->'productId') NOT IN ('string', 'null')
    OR jsonb_typeof(receipt->'type') IS DISTINCT FROM 'string'
    OR jsonb_typeof(receipt->'amountCents') IS DISTINCT FROM 'number'
    OR jsonb_typeof(receipt->'balanceAfterCents') IS DISTINCT FROM 'number'
    OR jsonb_typeof(receipt->'amountUsd') IS DISTINCT FROM 'number'
    OR jsonb_typeof(receipt->'balanceAfterUsd') IS DISTINCT FROM 'number'
    OR jsonb_typeof(receipt->'description') IS DISTINCT FROM 'string'
    OR jsonb_typeof(receipt->'createdAt') IS DISTINCT FROM 'string'
    OR receipt->>'id' IS DISTINCT FROM funding_row."id"
    OR receipt->>'userId' IS DISTINCT FROM funding_row."user_id"
    OR receipt->>'tenantId' IS DISTINCT FROM funding_row."tenant_id"
    OR COALESCE(receipt->>'productId', '') IS DISTINCT FROM
      COALESCE(funding_row."product_id", '')
    OR receipt->>'type' IS DISTINCT FROM expected_transaction_type
    OR funding_row."amount_usd" * 100 IS DISTINCT FROM
      round(funding_row."amount_usd" * 100, 0)
    OR trunc((receipt->>'amountCents')::NUMERIC)
      IS DISTINCT FROM (receipt->>'amountCents')::NUMERIC
    OR abs((receipt->>'amountCents')::NUMERIC) > 9007199254740991
    OR trunc((receipt->>'balanceAfterCents')::NUMERIC)
      IS DISTINCT FROM (receipt->>'balanceAfterCents')::NUMERIC
    OR abs((receipt->>'balanceAfterCents')::NUMERIC) > 9007199254740991
    OR (receipt->>'amountCents')::NUMERIC IS DISTINCT FROM
      round(funding_row."amount_usd" * 100, 0)
    OR (receipt->>'balanceAfterCents')::NUMERIC IS DISTINCT FROM
      round(funding_row."balance_after_usd" * 100, 0)
    OR (receipt->>'amountUsd')::NUMERIC IS DISTINCT FROM funding_row."amount_usd"
    OR (receipt->>'balanceAfterUsd')::NUMERIC IS DISTINCT FROM
      funding_row."balance_after_usd"
    OR receipt->>'description' IS DISTINCT FROM funding_row."description"
    OR (receipt->>'createdAt')::TIMESTAMPTZ IS DISTINCT FROM
      funding_row."created_at" AT TIME ZONE 'UTC'
    OR target_grant->>'id' IS DISTINCT FROM NEW."balance_grant_id"
    OR target_grant->>'user_id' IS DISTINCT FROM funding_row."user_id"
    OR target_grant->>'tenant_id' IS DISTINCT FROM funding_row."tenant_id"
    OR target_grant->>'billing_account_id' IS DISTINCT FROM
      NEW."billing_account_id"
    OR COALESCE(target_grant->>'product_id', '') IS DISTINCT FROM
      COALESCE(funding_row."product_id", '')
    OR target_grant->>'order_id' IS NOT NULL
    OR target_grant->>'source' IS DISTINCT FROM 'RECHARGE'
    OR (target_grant->>'paid_amount_usd')::NUMERIC IS DISTINCT FROM
      funding_row."amount_usd"
    OR (target_grant->>'bonus_amount_usd')::NUMERIC IS DISTINCT FROM 0
    OR (target_grant->>'granted_amount_usd')::NUMERIC IS DISTINCT FROM
      funding_row."amount_usd"
    OR (target_grant->>'discount_rate')::NUMERIC IS DISTINCT FROM 1
    OR NEW."canonical_remaining_amount_usd" > funding_row."amount_usd"
    OR NEW."canonical_remaining_paid_amount_usd" > funding_row."amount_usd"
    OR NEW."canonical_remaining_amount_usd" > LEAST(
      funding_row."amount_usd",
      GREATEST(funding_row."balance_after_usd", 0)
    )
    OR NEW."canonical_remaining_paid_amount_usd" > LEAST(
      funding_row."amount_usd",
      GREATEST(funding_row."balance_after_usd", 0)
    )
  THEN
    RAISE EXCEPTION
      'legacy enterprise admin funding proof invalid run=% action=% tx=% grant=%',
      NEW."run_id", NEW."action", NEW."balance_transaction_id",
      NEW."balance_grant_id"
      USING ERRCODE = '23514';
  END IF;

  IF NEW."action" = 'CREATE_GRANT' THEN
    IF NEW."balance_grant_id" IS DISTINCT FROM
        'repair-enterprise-admin-funding:' || NEW."balance_transaction_id"
      OR EXISTS (
        SELECT 1 FROM "balance_grants"
        WHERE "id" = NEW."balance_grant_id"
      )
      OR (target_grant->>'remaining_amount_usd')::NUMERIC IS DISTINCT FROM
        NEW."canonical_remaining_amount_usd"
      OR (target_grant->>'remaining_paid_amount_usd')::NUMERIC IS DISTINCT FROM
        NEW."canonical_remaining_paid_amount_usd"
      OR (target_grant->>'remaining_bonus_amount_usd')::NUMERIC IS DISTINCT FROM
        NEW."canonical_remaining_bonus_amount_usd"
      OR (target_grant->>'valid_from')::TIMESTAMP(3) IS DISTINCT FROM
        funding_row."created_at"
      OR (target_grant->>'created_at')::TIMESTAMP(3) IS DISTINCT FROM
        funding_row."created_at"
      OR (target_grant->>'updated_at')::TIMESTAMP(3) IS DISTINCT FROM
        funding_row."created_at"
      OR (target_grant->>'expires_at')::TIMESTAMP(3) IS DISTINCT FROM
        funding_row."created_at" + INTERVAL '365 days'
      OR (target_grant->>'is_expired')::BOOLEAN IS DISTINCT FROM FALSE
    THEN
      RAISE EXCEPTION
        'legacy enterprise admin CREATE grant proof invalid tx=% grant=%',
        NEW."balance_transaction_id", NEW."balance_grant_id"
        USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."action" = 'LINK_GRANT' THEN
    SELECT * INTO linked_grant
    FROM "balance_grants"
    WHERE "id" = NEW."balance_grant_id";

    SELECT COUNT(*) INTO candidate_count
    FROM "balance_grants" grant_row
    WHERE grant_row."billing_account_id" = NEW."billing_account_id"
      AND grant_row."user_id" = funding_row."user_id"
      AND grant_row."tenant_id" = funding_row."tenant_id"
      AND grant_row."product_id" IS NOT DISTINCT FROM funding_row."product_id"
      AND grant_row."order_id" IS NULL
      AND grant_row."source" = 'RECHARGE'
      AND grant_row."paid_amount_usd" = funding_row."amount_usd"
      AND grant_row."bonus_amount_usd" = 0
      AND grant_row."granted_amount_usd" = funding_row."amount_usd"
      -- The retired writer created the transaction first, settled debt, then
      -- created the grant.  Strictly-later time is shape, never proximity proof.
      AND grant_row."created_at" > funding_row."created_at"
      AND grant_row."valid_from" >= funding_row."created_at"
      AND grant_row."valid_from" <= grant_row."created_at"
      AND grant_row."expires_at" = grant_row."valid_from" + INTERVAL '365 days'
      AND grant_row."discount_rate" = 1
      AND NOT grant_row."is_expired"
      AND NOT EXISTS (
        SELECT 1 FROM "balance_grant_expiries" expiry
        WHERE expiry."balance_grant_id" = grant_row."id"
      )
      AND NOT EXISTS (
        SELECT 1 FROM "balance_grant_refunds" refund
        WHERE refund."balance_grant_id" = grant_row."id"
      );

    IF linked_grant."id" IS NULL
      OR candidate_count <> 1
      OR to_jsonb(linked_grant) IS DISTINCT FROM NEW."grant_snapshot"
      OR linked_grant."billing_account_id" IS DISTINCT FROM NEW."billing_account_id"
      OR linked_grant."user_id" IS DISTINCT FROM funding_row."user_id"
      OR linked_grant."tenant_id" IS DISTINCT FROM funding_row."tenant_id"
      OR linked_grant."product_id" IS DISTINCT FROM funding_row."product_id"
      OR linked_grant."order_id" IS NOT NULL
      OR linked_grant."source" IS DISTINCT FROM 'RECHARGE'
      OR linked_grant."paid_amount_usd" IS DISTINCT FROM funding_row."amount_usd"
      OR linked_grant."bonus_amount_usd" IS DISTINCT FROM 0
      OR linked_grant."granted_amount_usd" IS DISTINCT FROM funding_row."amount_usd"
      OR linked_grant."created_at" <= funding_row."created_at"
      OR linked_grant."valid_from" < funding_row."created_at"
      OR linked_grant."valid_from" > linked_grant."created_at"
      OR linked_grant."expires_at" IS DISTINCT FROM
        linked_grant."valid_from" + INTERVAL '365 days'
      OR linked_grant."discount_rate" IS DISTINCT FROM 1
      OR linked_grant."is_expired"
    THEN
      RAISE EXCEPTION
        'legacy enterprise admin LINK grant proof invalid tx=% grant=% candidates=%',
        NEW."balance_transaction_id", NEW."balance_grant_id", candidate_count
        USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'legacy enterprise admin funding proof action invalid: %',
      NEW."action" USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
EXCEPTION
  WHEN invalid_text_representation OR datetime_field_overflow
    OR numeric_value_out_of_range THEN
    RAISE EXCEPTION
      'legacy enterprise admin funding proof has invalid typed evidence tx=%',
      NEW."balance_transaction_id"
      USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER "balance_ledger_admin_funding_repairs_insert_guard"
BEFORE INSERT ON "balance_ledger_admin_funding_repairs"
FOR EACH ROW
EXECUTE FUNCTION "validate_balance_ledger_admin_funding_repair_insert"();

-- Return the permanently proven grant for one historical funding row.  During
-- the active repair transaction the proof is usable only under the exact run
-- GUC and only after the grant has reached its planned final remaining state.
-- After promotion, the append-only proof and immutable issuance columns remain
-- authoritative even when normal consumption/refund/expiry changes the grant's
-- remaining values.  The TTL idempotency row is intentionally not re-read.
CREATE OR REPLACE FUNCTION "balance_admin_funding_terminal_grant_id"(
  target_account_id TEXT,
  target_funding_id TEXT
)
RETURNS TEXT
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  active_run_id TEXT;
  proof RECORD;
  funding_row RECORD;
  grant_row RECORD;
  active_proof BOOLEAN;
  terminal_proof BOOLEAN;
  immutable_before JSONB;
  immutable_current JSONB;
BEGIN
  SELECT repair_proof.*,
    repair_account."status" AS repair_status,
    repair_account."after_snapshot" AS repair_after_snapshot,
    repair_run."status" AS run_status,
    account_row."type" AS account_type,
    account_row."balance_grant_ledger_status" AS account_ledger_status,
    account_row."balance_grant_ledger_version" AS account_ledger_version
  INTO proof
  FROM "balance_ledger_admin_funding_repairs" repair_proof
  JOIN "balance_ledger_repair_accounts" repair_account
    ON repair_account."id" = repair_proof."repair_account_id"
    AND repair_account."run_id" = repair_proof."run_id"
    AND repair_account."billing_account_id" = repair_proof."billing_account_id"
  JOIN "balance_ledger_repair_runs" repair_run
    ON repair_run."id" = repair_proof."run_id"
  JOIN "billing_accounts" account_row
    ON account_row."id" = repair_proof."billing_account_id"
  WHERE repair_proof."billing_account_id" = target_account_id
    AND repair_proof."balance_transaction_id" = target_funding_id;

  IF proof."id" IS NULL OR proof.account_type IS DISTINCT FROM 'enterprise' THEN
    RETURN NULL;
  END IF;

  SELECT * INTO funding_row
  FROM "balance_transactions"
  WHERE "id" = proof."balance_transaction_id"
    AND "billing_account_id" = proof."billing_account_id";
  SELECT * INTO grant_row
  FROM "balance_grants"
  WHERE "id" = proof."balance_grant_id"
    AND "billing_account_id" = proof."billing_account_id";

  IF funding_row."id" IS NULL
    OR grant_row."id" IS NULL
    OR to_jsonb(funding_row) IS DISTINCT FROM proof."transaction_snapshot"
  THEN
    RETURN NULL;
  END IF;

  active_run_id := NULLIF(btrim(current_setting(
    'billing.balance_ledger_repair_run_id', TRUE
  )), '');
  active_proof := active_run_id IS NOT DISTINCT FROM proof."run_id"
    AND proof.run_status IS NOT DISTINCT FROM 'RUNNING'
    AND proof.repair_status IS NOT DISTINCT FROM 'RUNNING'
    AND proof.account_ledger_status IS NOT DISTINCT FROM 'LEGACY_DIRTY'
    AND proof.account_ledger_version IS NOT DISTINCT FROM 0;
  terminal_proof := proof.repair_status IS NOT DISTINCT FROM 'APPLIED'
    AND proof.repair_after_snapshot IS NOT NULL
    AND proof.run_status IN ('RUNNING', 'COMPLETED', 'COMPLETED_WITH_EXCEPTIONS')
    AND proof.account_ledger_status IS NOT DISTINCT FROM 'RECONCILED_V2'
    AND proof.account_ledger_version IS NOT DISTINCT FROM 2;

  IF NOT active_proof AND NOT terminal_proof THEN
    RETURN NULL;
  END IF;

  IF active_proof THEN
    IF grant_row."remaining_amount_usd" IS DISTINCT FROM
        proof."canonical_remaining_amount_usd"
      OR grant_row."remaining_paid_amount_usd" IS DISTINCT FROM
        proof."canonical_remaining_paid_amount_usd"
      OR grant_row."remaining_bonus_amount_usd" IS DISTINCT FROM
        proof."canonical_remaining_bonus_amount_usd"
    THEN
      RETURN NULL;
    END IF;
    IF proof."action" = 'CREATE_GRANT' THEN
      IF to_jsonb(grant_row) IS DISTINCT FROM proof."grant_snapshot" THEN
        RETURN NULL;
      END IF;
    ELSIF proof."action" = 'LINK_GRANT' THEN
      immutable_before := proof."grant_snapshot" - ARRAY[
        'remaining_amount_usd',
        'remaining_paid_amount_usd',
        'remaining_bonus_amount_usd',
        'updated_at'
      ];
      immutable_current := to_jsonb(grant_row) - ARRAY[
        'remaining_amount_usd',
        'remaining_paid_amount_usd',
        'remaining_bonus_amount_usd',
        'updated_at'
      ];
      IF immutable_current IS DISTINCT FROM immutable_before
        OR grant_row."updated_at" <
          (proof."grant_snapshot"->>'updated_at')::TIMESTAMP(3)
      THEN
        RETURN NULL;
      END IF;
    ELSE
      RETURN NULL;
    END IF;
  ELSE
    -- is_expired, remaining components and updated_at are legitimate mutable
    -- terminal columns; every issuance/funding identity column stays exact.
    immutable_before := proof."grant_snapshot" - ARRAY[
      'remaining_amount_usd',
      'remaining_paid_amount_usd',
      'remaining_bonus_amount_usd',
      'is_expired',
      'updated_at'
    ];
    immutable_current := to_jsonb(grant_row) - ARRAY[
      'remaining_amount_usd',
      'remaining_paid_amount_usd',
      'remaining_bonus_amount_usd',
      'is_expired',
      'updated_at'
    ];
    IF immutable_current IS DISTINCT FROM immutable_before THEN
      RETURN NULL;
    END IF;
  END IF;

  RETURN proof."balance_grant_id";
EXCEPTION WHEN OTHERS THEN
  RETURN NULL;
END
$$;

-- Exact retired-writer settlement bundle for proof-backed ADJUST/RECHARGE.
-- The old general helper treats ADJUST as voucher bonus funding; this separate
-- path preserves that rule and adds only paid funding backed by our immutable
-- admin receipt proof.
CREATE OR REPLACE FUNCTION "balance_admin_funding_settlement_timing_is_proven"(
  target_settlement_id TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  WITH target AS (
    SELECT target_row."billing_account_id",
      target_row."repayment_transaction_id"
    FROM "enterprise_credit_settlements" target_row
    JOIN "billing_accounts" account_row
      ON account_row."id" = target_row."billing_account_id"
      AND account_row."type" = 'enterprise'
    WHERE target_row."id" = target_settlement_id
      AND target_row."repayment_transaction_id" IS NOT NULL
  ), funding AS (
    SELECT funding_row.*, proof."action" AS proof_action,
      proof."balance_grant_id" AS proof_grant_id
    FROM target
    JOIN "balance_transactions" funding_row
      ON funding_row."id" = target."repayment_transaction_id"
      AND funding_row."billing_account_id" = target."billing_account_id"
    JOIN "balance_ledger_admin_funding_repairs" proof
      ON proof."billing_account_id" = funding_row."billing_account_id"
      AND proof."balance_transaction_id" = funding_row."id"
      AND proof."action" = CASE funding_row."type"::TEXT
        WHEN 'ADJUST' THEN 'CREATE_GRANT'
        WHEN 'RECHARGE' THEN 'LINK_GRANT'
      END
    WHERE funding_row."type"::TEXT IN ('ADJUST', 'RECHARGE')
      AND funding_row."amount_usd" > 0
      AND funding_row."order_id" IS NULL
      AND funding_row."operation_key" IS NULL
      AND "balance_admin_funding_terminal_grant_id"(
        funding_row."billing_account_id",
        funding_row."id"
      ) = proof."balance_grant_id"
  ), bundle AS (
    SELECT settlement_row.*,
      allocation_row."id" AS proven_allocation_id,
      allocation_row."billing_account_id" AS allocation_account_id,
      allocation_row."source" AS allocation_source,
      allocation_row."balance_grant_id" AS allocation_grant_id,
      allocation_row."amount_usd" AS allocation_amount_usd,
      allocation_row."settled_usd" AS allocation_settled_usd,
      allocation_row."settled_at" AS allocation_settled_at,
      (SELECT COUNT(*)
       FROM "enterprise_credit_settlements" same_allocation
       WHERE same_allocation."allocation_id" = settlement_row."allocation_id")
        AS allocation_settlement_count
    FROM funding
    JOIN "enterprise_credit_settlements" settlement_row
      ON settlement_row."repayment_transaction_id" = funding."id"
    LEFT JOIN "balance_consumption_allocations" allocation_row
      ON allocation_row."id" = settlement_row."allocation_id"
  ), proof AS (
    SELECT funding."id" AS funding_id,
      funding."billing_account_id" AS billing_account_id,
      funding."amount_usd" AS funding_amount_usd,
      funding."balance_after_usd" AS balance_after_usd,
      funding."created_at" AS funding_created_at,
      funding.proof_action,
      funding.proof_grant_id,
      COUNT(bundle."id") AS settlement_count,
      COUNT(DISTINCT bundle."allocation_id") AS allocation_count,
      SUM(bundle."amount_usd") AS settlement_total,
      MIN(bundle.allocation_settled_at) AS first_settled_at,
      MAX(bundle.allocation_settled_at) AS last_settled_at,
      MAX(bundle."created_at") AS last_settlement_created_at,
      BOOL_AND(
        bundle."billing_account_id" = funding."billing_account_id"
        AND bundle.proven_allocation_id IS NOT NULL
        AND bundle.allocation_account_id = funding."billing_account_id"
        AND bundle.allocation_source = 'ENTERPRISE_CREDIT'
        AND bundle.allocation_grant_id IS NULL
        AND bundle.allocation_amount_usd = bundle."amount_usd"
        AND bundle.allocation_settled_usd = bundle.allocation_amount_usd
        AND bundle.allocation_settled_at IS NOT NULL
        AND bundle.allocation_settlement_count = 1
        AND funding."created_at" <= bundle.allocation_settled_at
        AND bundle.allocation_settled_at <= bundle."created_at"
        AND bundle."debt_source" = 'ENTERPRISE_CREDIT'
        AND bundle."balance_grant_id" IS NULL
        AND bundle."repair_run_id" IS NULL
        AND bundle."trigger" = 'FUNDING'
        AND bundle."operation_key" = 'legacy:' || bundle."id"
        AND bundle."occurred_at" = bundle."created_at"
        AND bundle."amount_usd" > 0
        AND bundle."paid_usd" = bundle."amount_usd"
        AND bundle."bonus_usd" = 0
      ) AS rows_match
    FROM funding
    JOIN bundle ON TRUE
    GROUP BY funding."id", funding."billing_account_id",
      funding."amount_usd", funding."balance_after_usd", funding."created_at",
      funding.proof_action, funding.proof_grant_id
  )
  SELECT COALESCE(EXISTS (
    SELECT 1
    FROM proof
    JOIN "balance_grants" grant_row
      ON grant_row."id" = proof.proof_grant_id
      AND grant_row."billing_account_id" = proof.billing_account_id
    WHERE proof.settlement_count > 0
      AND proof.settlement_count = proof.allocation_count
      AND proof.first_settled_at = proof.last_settled_at
      AND proof.rows_match
      AND proof.settlement_total = LEAST(
        proof.funding_amount_usd,
        GREATEST(
          -(proof.balance_after_usd - proof.funding_amount_usd),
          0
        )
      )
      AND (
        proof.proof_action = 'CREATE_GRANT'
        OR (
          proof.proof_action = 'LINK_GRANT'
          AND proof.last_settlement_created_at <= grant_row."valid_from"
          AND grant_row."valid_from" <= grant_row."created_at"
        )
      )
  ), FALSE)
$$;

-- Per-row authority for enterprise FIFO rewrites introduced by an admin
-- funding proof.  The plan mutation, append-only audit and live allocation
-- must form one exact before/after triple; immutable allocation identity and
-- settlement state never become mutable through this path.
CREATE OR REPLACE FUNCTION "balance_admin_funding_allocation_repair_is_proven"(
  target_allocation_repair_id TEXT,
  target_account_id TEXT,
  target_run_id TEXT,
  target_after_snapshot JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  audit_row RECORD;
  allocation_row RECORD;
  grant_row RECORD;
  repair_row RECORD;
  mutation JSONB;
  mutation_count BIGINT;
  mutation_key_count BIGINT;
BEGIN
  SELECT * INTO audit_row
  FROM "balance_ledger_allocation_repairs"
  WHERE "id" = target_allocation_repair_id
    AND "run_id" = target_run_id
    AND "billing_account_id" = target_account_id;
  IF audit_row."id" IS NULL THEN
    RETURN FALSE;
  END IF;

  SELECT repair_account.*, repair_run."status" AS run_status,
    account_row."type" AS account_type,
    account_row."balance_grant_ledger_status" AS account_ledger_status,
    account_row."balance_grant_ledger_version" AS account_ledger_version
  INTO repair_row
  FROM "balance_ledger_repair_accounts" repair_account
  JOIN "balance_ledger_repair_runs" repair_run
    ON repair_run."id" = repair_account."run_id"
  JOIN "billing_accounts" account_row
    ON account_row."id" = repair_account."billing_account_id"
  WHERE repair_account."id" = audit_row."repair_account_id"
    AND repair_account."run_id" = target_run_id
    AND repair_account."billing_account_id" = target_account_id;

  SELECT * INTO allocation_row
  FROM "balance_consumption_allocations"
  WHERE "id" = audit_row."allocation_id"
    AND "billing_account_id" = target_account_id;

  SELECT COUNT(*) INTO mutation_count
  FROM jsonb_array_elements(COALESCE(
    target_after_snapshot->'canonicalAllocationMutations',
    '[]'::JSONB
  )) plan_mutation(value)
  WHERE value->>'allocationId' = audit_row."allocation_id";
  IF mutation_count <> 1 THEN
    RETURN FALSE;
  END IF;
  SELECT value INTO mutation
  FROM jsonb_array_elements(
    target_after_snapshot->'canonicalAllocationMutations'
  ) plan_mutation(value)
  WHERE value->>'allocationId' = audit_row."allocation_id"
  LIMIT 1;
  SELECT COUNT(*) INTO mutation_key_count FROM jsonb_object_keys(mutation);

  SELECT * INTO grant_row
  FROM "balance_grants"
  WHERE "id" = mutation->>'balanceGrantId'
    AND "billing_account_id" = target_account_id;

  IF repair_row."id" IS NULL
    OR repair_row."status" IS DISTINCT FROM 'APPLIED'
    OR repair_row.run_status NOT IN ('RUNNING', 'COMPLETED', 'COMPLETED_WITH_EXCEPTIONS')
    OR repair_row.account_type IS DISTINCT FROM 'enterprise'
    OR repair_row.account_ledger_status IS DISTINCT FROM 'RECONCILED_V2'
    OR repair_row.account_ledger_version IS DISTINCT FROM 2
    OR target_after_snapshot IS DISTINCT FROM repair_row."after_snapshot"
    OR NOT EXISTS (
      SELECT 1
      FROM "balance_ledger_admin_funding_repairs" proof
      WHERE proof."run_id" = target_run_id
        AND proof."billing_account_id" = target_account_id
        AND "balance_admin_funding_terminal_grant_id"(
          target_account_id,
          proof."balance_transaction_id"
        ) = proof."balance_grant_id"
    )
    OR mutation_key_count <> 22
    OR NOT (mutation ?& ARRAY[
      'allocationId',
      'expectedUserId',
      'expectedTenantId',
      'expectedProductId',
      'expectedBalanceTransactionId',
      'expectedTokenUsageId',
      'expectedBalanceGrantId',
      'expectedSource',
      'expectedAmountUsd',
      'expectedRecognizedRevenueUsd',
      'expectedBonusConsumedUsd',
      'expectedDiscountRate',
      'expectedSettledUsd',
      'expectedSettledAt',
      'expectedLedgerSequence',
      'expectedCreatedAt',
      'balanceGrantId',
      'amountUsd',
      'recognizedRevenueUsd',
      'bonusConsumedUsd',
      'discountRate',
      'ledgerSequence'
    ])
    OR audit_row."operation_key" IS DISTINCT FROM
      'repair:allocation:' || target_run_id || ':' || audit_row."allocation_id"
    OR audit_row."after_snapshot" IS DISTINCT FROM to_jsonb(allocation_row)
    OR audit_row."before_snapshot" IS NOT DISTINCT FROM audit_row."after_snapshot"
    OR mutation->>'expectedUserId' IS DISTINCT FROM
      audit_row."before_snapshot"->>'user_id'
    OR mutation->>'expectedTenantId' IS DISTINCT FROM
      audit_row."before_snapshot"->>'tenant_id'
    OR mutation->>'expectedProductId' IS DISTINCT FROM
      audit_row."before_snapshot"->>'product_id'
    OR mutation->>'expectedBalanceTransactionId' IS DISTINCT FROM
      audit_row."before_snapshot"->>'balance_transaction_id'
    OR mutation->>'expectedTokenUsageId' IS DISTINCT FROM
      audit_row."before_snapshot"->>'token_usage_id'
    OR mutation->>'expectedBalanceGrantId' IS DISTINCT FROM
      audit_row."before_snapshot"->>'balance_grant_id'
    OR mutation->>'expectedSource' IS DISTINCT FROM
      audit_row."before_snapshot"->>'source'
    OR (mutation->>'expectedAmountUsd')::NUMERIC IS DISTINCT FROM
      (audit_row."before_snapshot"->>'amount_usd')::NUMERIC
    OR (mutation->>'expectedRecognizedRevenueUsd')::NUMERIC IS DISTINCT FROM
      (audit_row."before_snapshot"->>'recognized_revenue_usd')::NUMERIC
    OR (mutation->>'expectedBonusConsumedUsd')::NUMERIC IS DISTINCT FROM
      (audit_row."before_snapshot"->>'bonus_consumed_usd')::NUMERIC
    OR (mutation->>'expectedDiscountRate')::NUMERIC IS DISTINCT FROM
      (audit_row."before_snapshot"->>'discount_rate')::NUMERIC
    OR (mutation->>'expectedSettledUsd')::NUMERIC IS DISTINCT FROM
      (audit_row."before_snapshot"->>'settled_usd')::NUMERIC
    OR mutation->>'expectedSettledAt' IS DISTINCT FROM
      audit_row."before_snapshot"->>'settled_at'
    OR mutation->>'expectedLedgerSequence' IS DISTINCT FROM
      audit_row."before_snapshot"->>'ledger_sequence'
    OR ((mutation->>'expectedCreatedAt')::TIMESTAMPTZ AT TIME ZONE 'UTC')
      IS DISTINCT FROM
        (audit_row."before_snapshot"->>'created_at')::TIMESTAMP(3)
    OR mutation->>'balanceGrantId' IS DISTINCT FROM
      audit_row."after_snapshot"->>'balance_grant_id'
    OR (mutation->>'amountUsd')::NUMERIC IS DISTINCT FROM
      (audit_row."after_snapshot"->>'amount_usd')::NUMERIC
    OR (mutation->>'recognizedRevenueUsd')::NUMERIC IS DISTINCT FROM
      (audit_row."after_snapshot"->>'recognized_revenue_usd')::NUMERIC
    OR (mutation->>'bonusConsumedUsd')::NUMERIC IS DISTINCT FROM
      (audit_row."after_snapshot"->>'bonus_consumed_usd')::NUMERIC
    OR (mutation->>'discountRate')::NUMERIC IS DISTINCT FROM
      (audit_row."after_snapshot"->>'discount_rate')::NUMERIC
    OR mutation->>'ledgerSequence' IS DISTINCT FROM
      audit_row."after_snapshot"->>'ledger_sequence'
    OR audit_row."before_snapshot"->>'source' IS DISTINCT FROM 'BALANCE_GRANT'
    OR audit_row."after_snapshot"->>'source' IS DISTINCT FROM 'BALANCE_GRANT'
    OR audit_row."before_snapshot"->>'id' IS DISTINCT FROM
      audit_row."after_snapshot"->>'id'
    OR audit_row."before_snapshot"->>'user_id' IS DISTINCT FROM
      audit_row."after_snapshot"->>'user_id'
    OR audit_row."before_snapshot"->>'tenant_id' IS DISTINCT FROM
      audit_row."after_snapshot"->>'tenant_id'
    OR audit_row."before_snapshot"->>'billing_account_id' IS DISTINCT FROM
      audit_row."after_snapshot"->>'billing_account_id'
    OR audit_row."before_snapshot"->>'product_id' IS DISTINCT FROM
      audit_row."after_snapshot"->>'product_id'
    OR audit_row."before_snapshot"->>'balance_transaction_id' IS DISTINCT FROM
      audit_row."after_snapshot"->>'balance_transaction_id'
    OR audit_row."before_snapshot"->>'token_usage_id' IS DISTINCT FROM
      audit_row."after_snapshot"->>'token_usage_id'
    OR audit_row."before_snapshot"->>'created_at' IS DISTINCT FROM
      audit_row."after_snapshot"->>'created_at'
    OR audit_row."before_snapshot"->>'settled_usd' IS DISTINCT FROM
      audit_row."after_snapshot"->>'settled_usd'
    OR audit_row."before_snapshot"->>'settled_at' IS DISTINCT FROM
      audit_row."after_snapshot"->>'settled_at'
    OR grant_row."id" IS NULL
    OR (audit_row."after_snapshot"->>'amount_usd')::NUMERIC <= 0
    OR (audit_row."after_snapshot"->>'recognized_revenue_usd')::NUMERIC < 0
    OR (audit_row."after_snapshot"->>'bonus_consumed_usd')::NUMERIC < 0
    OR (audit_row."after_snapshot"->>'recognized_revenue_usd')::NUMERIC
      + (audit_row."after_snapshot"->>'bonus_consumed_usd')::NUMERIC
        IS DISTINCT FROM (audit_row."after_snapshot"->>'amount_usd')::NUMERIC
    OR (audit_row."after_snapshot"->>'discount_rate')::NUMERIC
      IS DISTINCT FROM ROUND(
        (audit_row."after_snapshot"->>'recognized_revenue_usd')::NUMERIC
          / (audit_row."after_snapshot"->>'amount_usd')::NUMERIC,
        12
      )
    OR NOT EXISTS (
      SELECT 1
      FROM "balance_funding_candidates"(target_account_id, 'enterprise') candidate
      WHERE candidate.grant_id = grant_row."id"
    )
  THEN
    RETURN FALSE;
  END IF;
  RETURN TRUE;
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END
$$;

-- Account-level closure between the terminal repair snapshot, every proof row
-- and every proof-authorized canonical allocation mutation.  Zero-proof plans
-- remain compatible; canonical enterprise FIFO rewrites never do.
CREATE OR REPLACE FUNCTION "balance_admin_funding_terminal_evidence_is_valid"(
  target_account_id TEXT,
  target_run_id TEXT,
  target_after_snapshot JSONB
)
RETURNS BOOLEAN
LANGUAGE plpgsql
STABLE
AS $$
DECLARE
  repair_row RECORD;
  proof_plan JSONB;
  canonical_plan JSONB;
  proof_count BIGINT;
  create_count BIGINT;
  link_count BIGINT;
  final_count BIGINT;
  planned_proof_count BIGINT;
  planned_canonical_count BIGINT;
  proven_canonical_count BIGINT;
  invalid_count BIGINT;
  disconnected_count BIGINT;
BEGIN
  SELECT repair_account.*, repair_run."status" AS run_status,
    account_row."type" AS account_type,
    account_row."balance_grant_ledger_status" AS account_ledger_status,
    account_row."balance_grant_ledger_version" AS account_ledger_version
  INTO repair_row
  FROM "balance_ledger_repair_accounts" repair_account
  JOIN "balance_ledger_repair_runs" repair_run
    ON repair_run."id" = repair_account."run_id"
  JOIN "billing_accounts" account_row
    ON account_row."id" = repair_account."billing_account_id"
  WHERE repair_account."run_id" = target_run_id
    AND repair_account."billing_account_id" = target_account_id;
  IF repair_row."id" IS NULL
    OR repair_row."status" IS DISTINCT FROM 'APPLIED'
    OR repair_row.run_status NOT IN ('RUNNING', 'COMPLETED', 'COMPLETED_WITH_EXCEPTIONS')
    OR repair_row.account_type IS DISTINCT FROM 'enterprise'
    OR repair_row.account_ledger_status IS DISTINCT FROM 'RECONCILED_V2'
    OR repair_row.account_ledger_version IS DISTINCT FROM 2
    OR repair_row."after_snapshot" IS DISTINCT FROM target_after_snapshot
  THEN
    RETURN FALSE;
  END IF;

  proof_plan := COALESCE(
    target_after_snapshot->'legacyAdminFundingRepairs',
    '[]'::JSONB
  );
  canonical_plan := COALESCE(
    target_after_snapshot->'canonicalAllocationMutations',
    '[]'::JSONB
  );
  IF jsonb_typeof(proof_plan) IS DISTINCT FROM 'array'
    OR jsonb_typeof(canonical_plan) IS DISTINCT FROM 'array'
  THEN
    RETURN FALSE;
  END IF;

  SELECT COUNT(*),
    COUNT(*) FILTER (WHERE proof."action" = 'CREATE_GRANT'),
    COUNT(*) FILTER (WHERE proof."action" = 'LINK_GRANT'),
    COUNT(*) FILTER (WHERE "balance_admin_funding_terminal_grant_id"(
      target_account_id,
      proof."balance_transaction_id"
    ) = proof."balance_grant_id")
  INTO proof_count, create_count, link_count, final_count
  FROM "balance_ledger_admin_funding_repairs" proof
  WHERE proof."run_id" = target_run_id
    AND proof."billing_account_id" = target_account_id;
  planned_proof_count := jsonb_array_length(proof_plan);
  planned_canonical_count := jsonb_array_length(canonical_plan);

  IF COALESCE((target_after_snapshot->>'adminFundingProofCount')::BIGINT, 0)
      IS DISTINCT FROM proof_count
    OR COALESCE((target_after_snapshot->>'adminFundingCreateCount')::BIGINT, 0)
      IS DISTINCT FROM create_count
    OR COALESCE((target_after_snapshot->>'adminFundingLinkCount')::BIGINT, 0)
      IS DISTINCT FROM link_count
    OR COALESCE((target_after_snapshot->>'adminFundingFinalGrantCount')::BIGINT, 0)
      IS DISTINCT FROM final_count
    OR proof_count IS DISTINCT FROM planned_proof_count
    OR proof_count IS DISTINCT FROM final_count
    OR (planned_canonical_count > 0 AND proof_count = 0)
  THEN
    RETURN FALSE;
  END IF;

  WITH planned AS (
    SELECT value AS row
    FROM jsonb_array_elements(proof_plan) element(value)
  ), invalid_plan AS (
    SELECT row
    FROM planned
    WHERE (SELECT COUNT(*) FROM jsonb_object_keys(row)) <> 24
      OR NOT (row ?& ARRAY[
        'repairKind',
        'action',
        'idempotencyKey',
        'idempotencyScope',
        'idempotencyEvidenceHash',
        'proofHash',
        'transactionId',
        'grantId',
        'userId',
        'tenantId',
        'billingAccountId',
        'productId',
        'amountUsd',
        'initialRemainingAmountUsd',
        'expectedGrantSnapshotHash',
        'expectedGrantRemainingAmountUsd',
        'expectedGrantRemainingPaidAmountUsd',
        'expectedGrantRemainingBonusAmountUsd',
        'finalRemainingAmountUsd',
        'finalRemainingPaidAmountUsd',
        'finalRemainingBonusAmountUsd',
        'validFrom',
        'expiresAt',
        'createdAt'
      ])
      OR row->>'repairKind' IS DISTINCT FROM
        'LEGACY_ENTERPRISE_ADMIN_FUNDING_V1'
      OR row->>'billingAccountId' IS DISTINCT FROM target_account_id
      OR row->>'proofHash' !~ '^[0-9a-f]{64}$'
      OR row->>'idempotencyEvidenceHash' !~ '^[0-9a-f]{64}$'
  ), matched AS (
    SELECT plan.row, proof."id" AS proof_id
    FROM planned plan
    LEFT JOIN "balance_ledger_admin_funding_repairs" proof
      ON proof."run_id" = target_run_id
      AND proof."billing_account_id" = target_account_id
      AND proof."repair_kind" = plan.row->>'repairKind'
      AND proof."action" = plan.row->>'action'
      AND proof."idempotency_key" = plan.row->>'idempotencyKey'
      AND proof."idempotency_scope" = plan.row->>'idempotencyScope'
      AND encode(
        sha256(convert_to(proof."idempotency_snapshot"::TEXT, 'UTF8')),
        'hex'
      ) = plan.row->>'idempotencyEvidenceHash'
      AND proof."proof_hash" = plan.row->>'proofHash'
      AND proof."balance_transaction_id" = plan.row->>'transactionId'
      AND proof."balance_grant_id" = plan.row->>'grantId'
      AND proof."transaction_snapshot"->>'user_id' = plan.row->>'userId'
      AND proof."transaction_snapshot"->>'tenant_id' = plan.row->>'tenantId'
      AND proof."transaction_snapshot"->>'billing_account_id'
        = plan.row->>'billingAccountId'
      AND proof."transaction_snapshot"->>'product_id'
        IS NOT DISTINCT FROM plan.row->>'productId'
      AND (proof."transaction_snapshot"->>'amount_usd')::NUMERIC
        = (plan.row->>'amountUsd')::NUMERIC
      AND LEAST(
        (proof."transaction_snapshot"->>'amount_usd')::NUMERIC,
        GREATEST(
          (proof."transaction_snapshot"->>'balance_after_usd')::NUMERIC,
          0
        )
      ) = (plan.row->>'initialRemainingAmountUsd')::NUMERIC
      AND proof."canonical_remaining_amount_usd"
        = (plan.row->>'finalRemainingAmountUsd')::NUMERIC
      AND proof."canonical_remaining_paid_amount_usd"
        = (plan.row->>'finalRemainingPaidAmountUsd')::NUMERIC
      AND proof."canonical_remaining_bonus_amount_usd"
        = (plan.row->>'finalRemainingBonusAmountUsd')::NUMERIC
      AND (proof."grant_snapshot"->>'valid_from')::TIMESTAMP(3)
        = ((plan.row->>'validFrom')::TIMESTAMPTZ AT TIME ZONE 'UTC')
      AND (proof."grant_snapshot"->>'expires_at')::TIMESTAMP(3)
        = ((plan.row->>'expiresAt')::TIMESTAMPTZ AT TIME ZONE 'UTC')
      AND (proof."grant_snapshot"->>'created_at')::TIMESTAMP(3)
        = ((plan.row->>'createdAt')::TIMESTAMPTZ AT TIME ZONE 'UTC')
      AND (
        (proof."action" = 'CREATE_GRANT'
          AND plan.row->>'expectedGrantSnapshotHash' IS NULL
          AND plan.row->>'expectedGrantRemainingAmountUsd' IS NULL
          AND plan.row->>'expectedGrantRemainingPaidAmountUsd' IS NULL
          AND plan.row->>'expectedGrantRemainingBonusAmountUsd' IS NULL)
        OR
        (proof."action" = 'LINK_GRANT'
          AND plan.row->>'expectedGrantSnapshotHash' ~ '^[0-9a-f]{64}$'
          AND encode(
            sha256(convert_to(proof."grant_snapshot"::TEXT, 'UTF8')),
            'hex'
          ) = plan.row->>'expectedGrantSnapshotHash'
          AND (plan.row->>'expectedGrantRemainingAmountUsd')::NUMERIC
            = (proof."grant_snapshot"->>'remaining_amount_usd')::NUMERIC
          AND (plan.row->>'expectedGrantRemainingPaidAmountUsd')::NUMERIC
            IS NOT DISTINCT FROM
              (proof."grant_snapshot"->>'remaining_paid_amount_usd')::NUMERIC
          AND (plan.row->>'expectedGrantRemainingBonusAmountUsd')::NUMERIC
            IS NOT DISTINCT FROM
              (proof."grant_snapshot"->>'remaining_bonus_amount_usd')::NUMERIC)
      )
  ), reverse_missing AS (
    SELECT proof."id"
    FROM "balance_ledger_admin_funding_repairs" proof
    WHERE proof."run_id" = target_run_id
      AND proof."billing_account_id" = target_account_id
      AND NOT EXISTS (
        SELECT 1 FROM planned plan
        WHERE plan.row->>'proofHash' = proof."proof_hash"
          AND plan.row->>'transactionId' = proof."balance_transaction_id"
          AND plan.row->>'grantId' = proof."balance_grant_id"
      )
  )
  SELECT
    (SELECT COUNT(*) FROM invalid_plan)
    + (SELECT COUNT(*) FROM matched WHERE proof_id IS NULL)
    + (SELECT COUNT(*) FROM reverse_missing)
    + (SELECT COUNT(*) FROM (
        SELECT row->>'transactionId' FROM planned
        GROUP BY row->>'transactionId' HAVING COUNT(*) <> 1
      ) duplicate_tx)
    + (SELECT COUNT(*) FROM (
        SELECT row->>'grantId' FROM planned
        GROUP BY row->>'grantId' HAVING COUNT(*) <> 1
      ) duplicate_grant)
    + (SELECT COUNT(*) FROM (
        SELECT row->>'idempotencyKey', row->>'idempotencyScope' FROM planned
        GROUP BY row->>'idempotencyKey', row->>'idempotencyScope'
        HAVING COUNT(*) <> 1
      ) duplicate_receipt)
    + (SELECT COUNT(*) FROM (
        SELECT row->>'proofHash' FROM planned
        GROUP BY row->>'proofHash' HAVING COUNT(*) <> 1
      ) duplicate_hash)
  INTO invalid_count;
  IF invalid_count <> 0 THEN
    RETURN FALSE;
  END IF;

  SELECT COUNT(*) INTO proven_canonical_count
  FROM "balance_ledger_allocation_repairs" allocation_repair
  WHERE allocation_repair."run_id" = target_run_id
    AND allocation_repair."billing_account_id" = target_account_id
    AND "balance_admin_funding_allocation_repair_is_proven"(
      allocation_repair."id",
      target_account_id,
      target_run_id,
      target_after_snapshot
    );
  SELECT COUNT(*) INTO invalid_count
  FROM (
    SELECT value->>'allocationId' AS allocation_id
    FROM jsonb_array_elements(canonical_plan) element(value)
    GROUP BY value->>'allocationId'
    HAVING value->>'allocationId' IS NULL OR COUNT(*) <> 1
  ) duplicate_canonical;
  IF invalid_count <> 0
    OR proven_canonical_count IS DISTINCT FROM planned_canonical_count
  THEN
    RETURN FALSE;
  END IF;

  -- Mirror the planner's proof-connected FIFO graph: each changed allocation
  -- connects old grant -> consume transaction -> final grant. Every component
  -- must be reachable from a grant named by this run's funding proof.
  WITH RECURSIVE mutations AS (
    SELECT value
    FROM jsonb_array_elements(canonical_plan) element(value)
  ), directed_edges(left_node, right_node) AS (
    SELECT 'grant:' || (value->>'expectedBalanceGrantId'),
      'transaction:' || (value->>'expectedBalanceTransactionId')
    FROM mutations
    UNION ALL
    SELECT 'transaction:' || (value->>'expectedBalanceTransactionId'),
      'grant:' || (value->>'expectedBalanceGrantId')
    FROM mutations
    UNION ALL
    SELECT 'transaction:' || (value->>'expectedBalanceTransactionId'),
      'grant:' || (value->>'balanceGrantId')
    FROM mutations
    UNION ALL
    SELECT 'grant:' || (value->>'balanceGrantId'),
      'transaction:' || (value->>'expectedBalanceTransactionId')
    FROM mutations
  ), graph_nodes(node) AS (
    SELECT left_node FROM directed_edges
    UNION SELECT right_node FROM directed_edges
  ), proof_nodes(node) AS (
    SELECT 'grant:' || proof."balance_grant_id"
    FROM "balance_ledger_admin_funding_repairs" proof
    WHERE proof."run_id" = target_run_id
      AND proof."billing_account_id" = target_account_id
  ), reachable(node) AS (
    SELECT graph_nodes.node
    FROM graph_nodes
    JOIN proof_nodes ON proof_nodes.node = graph_nodes.node
    UNION
    SELECT directed_edges.right_node
    FROM reachable
    JOIN directed_edges ON directed_edges.left_node = reachable.node
  )
  SELECT COUNT(*) INTO disconnected_count
  FROM graph_nodes
  WHERE NOT EXISTS (
    SELECT 1 FROM reachable WHERE reachable.node = graph_nodes.node
  );
  IF disconnected_count <> 0 THEN
    RETURN FALSE;
  END IF;

  RETURN TRUE;
EXCEPTION WHEN OTHERS THEN
  RETURN FALSE;
END
$$;

CREATE OR REPLACE FUNCTION "guard_repair_enterprise_admin_funding_grant_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  proof RECORD;
BEGIN
  IF NEW."id" NOT LIKE 'repair-enterprise-admin-funding:%' THEN
    RETURN NEW;
  END IF;

  SELECT repair_proof.*,
    repair_account."status" AS repair_status,
    repair_run."status" AS run_status
  INTO proof
  FROM "balance_ledger_admin_funding_repairs" repair_proof
  JOIN "balance_ledger_repair_accounts" repair_account
    ON repair_account."id" = repair_proof."repair_account_id"
  JOIN "balance_ledger_repair_runs" repair_run
    ON repair_run."id" = repair_proof."run_id"
  WHERE repair_proof."balance_grant_id" = NEW."id";

  IF proof."id" IS NULL
    OR proof."action" IS DISTINCT FROM 'CREATE_GRANT'
    OR proof.repair_status IS DISTINCT FROM 'RUNNING'
    OR proof.run_status IS DISTINCT FROM 'RUNNING'
    OR NULLIF(btrim(current_setting(
      'billing.balance_ledger_repair_run_id', TRUE
    )), '') IS DISTINCT FROM proof."run_id"
    OR proof."balance_grant_id" IS DISTINCT FROM
      'repair-enterprise-admin-funding:' || proof."balance_transaction_id"
    OR proof."billing_account_id" IS DISTINCT FROM NEW."billing_account_id"
    OR proof."grant_snapshot" IS DISTINCT FROM to_jsonb(NEW)
  THEN
    RAISE EXCEPTION
      'reserved enterprise admin funding grant lacks exact CREATE proof: %',
      NEW."id" USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

-- This trigger deliberately uses a different reserved prefix from the older
-- pair-repair trigger.  Both guards can coexist: each ignores the other's
-- prefix and every reserved INSERT is authorized by exactly one proof table.
CREATE TRIGGER "balance_grants_repair_enterprise_admin_funding_insert_guard"
BEFORE INSERT ON "balance_grants"
FOR EACH ROW
EXECUTE FUNCTION "guard_repair_enterprise_admin_funding_grant_insert"();

CREATE OR REPLACE FUNCTION "validate_balance_ledger_admin_funding_terminal"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  repair_status TEXT;
  run_status TEXT;
  account_status TEXT;
  account_version INTEGER;
  grant_row RECORD;
  immutable_before JSONB;
  immutable_current JSONB;
BEGIN
  SELECT "status" INTO repair_status
  FROM "balance_ledger_repair_accounts"
  WHERE "id" = NEW."repair_account_id";
  SELECT "status" INTO run_status
  FROM "balance_ledger_repair_runs"
  WHERE "id" = NEW."run_id";
  SELECT "balance_grant_ledger_status", "balance_grant_ledger_version"
    INTO account_status, account_version
  FROM "billing_accounts"
  WHERE "id" = NEW."billing_account_id";
  SELECT * INTO grant_row
  FROM "balance_grants"
  WHERE "id" = NEW."balance_grant_id"
    AND "billing_account_id" = NEW."billing_account_id";

  IF repair_status IS DISTINCT FROM 'APPLIED'
    OR run_status NOT IN ('RUNNING', 'COMPLETED', 'COMPLETED_WITH_EXCEPTIONS')
    OR account_status IS DISTINCT FROM 'RECONCILED_V2'
    OR account_version IS DISTINCT FROM 2
    OR grant_row."id" IS NULL
    OR "balance_admin_funding_terminal_grant_id"(
      NEW."billing_account_id", NEW."balance_transaction_id"
    ) IS DISTINCT FROM NEW."balance_grant_id"
  THEN
    RAISE EXCEPTION
      'legacy enterprise admin funding proof is not terminal tx=% grant=%',
      NEW."balance_transaction_id", NEW."balance_grant_id"
      USING ERRCODE = '23514';
  END IF;

  IF NEW."action" = 'CREATE_GRANT' THEN
    IF to_jsonb(grant_row) IS DISTINCT FROM NEW."grant_snapshot" THEN
      RAISE EXCEPTION 'CREATE admin funding proof terminal grant changed: %',
        NEW."balance_grant_id" USING ERRCODE = '23514';
    END IF;
  ELSIF NEW."action" = 'LINK_GRANT' THEN
    immutable_before := NEW."grant_snapshot" - ARRAY[
      'remaining_amount_usd',
      'remaining_paid_amount_usd',
      'remaining_bonus_amount_usd',
      'updated_at'
    ];
    immutable_current := to_jsonb(grant_row) - ARRAY[
      'remaining_amount_usd',
      'remaining_paid_amount_usd',
      'remaining_bonus_amount_usd',
      'updated_at'
    ];
    IF immutable_current IS DISTINCT FROM immutable_before
      OR grant_row."remaining_amount_usd" IS DISTINCT FROM
        NEW."canonical_remaining_amount_usd"
      OR grant_row."remaining_paid_amount_usd" IS DISTINCT FROM
        NEW."canonical_remaining_paid_amount_usd"
      OR grant_row."remaining_bonus_amount_usd" IS DISTINCT FROM
        NEW."canonical_remaining_bonus_amount_usd"
      OR grant_row."updated_at" <
        (NEW."grant_snapshot"->>'updated_at')::TIMESTAMP(3)
    THEN
      RAISE EXCEPTION 'LINK admin funding proof terminal grant mismatch: %',
        NEW."balance_grant_id" USING ERRCODE = '23514';
    END IF;
  ELSE
    RAISE EXCEPTION 'admin funding proof terminal action invalid: %', NEW."action"
      USING ERRCODE = '23514';
  END IF;
  RETURN NULL;
END
$$;

CREATE CONSTRAINT TRIGGER "balance_ledger_admin_funding_repairs_terminal_deferred"
AFTER INSERT ON "balance_ledger_admin_funding_repairs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_balance_ledger_admin_funding_terminal"();

-- Upgrade the shared classifier without copying its existing branches.  Both
-- test and UAT have the same two narrow source anchors, while UAT has an extra
-- migration that must remain free to own other canonical assertion changes.
DO $upgrade_funding_candidates$
DECLARE
  candidate_oid OID;
  candidate_source TEXT;
  rewritten_source TEXT;
  create_anchor TEXT := $anchor$
    AND funding."operation_key"
      ~ '^balance:admin-adjust:enterprise-paid-debt:[^[:space:]]+$'

  UNION ALL
$anchor$;
  create_replacement TEXT := $replacement$
    AND funding."operation_key"
      ~ '^balance:admin-adjust:enterprise-paid-debt:[^[:space:]]+$'

  UNION ALL

  SELECT funding."id", proof."balance_grant_id", 'PAID'::TEXT
  FROM positive_funding funding
  JOIN "balance_ledger_admin_funding_repairs" proof
    ON proof."billing_account_id" = target_account_id
    AND proof."balance_transaction_id" = funding."id"
    AND proof."action" = 'CREATE_GRANT'
  WHERE target_account_type = 'enterprise'
    AND funding."type"::TEXT = 'ADJUST'
    AND funding."order_id" IS NULL
    AND funding."operation_key" IS NULL
    AND "balance_admin_funding_terminal_grant_id"(
      target_account_id,
      funding."id"
    ) = proof."balance_grant_id"

  UNION ALL
$replacement$;
  link_anchor TEXT := $anchor$
    AND grant_row."created_at" = funding."created_at"
    AND grant_row."valid_from" >= grant_row."created_at"
    AND (
      grant_row."valid_from" <= grant_row."created_at"
      OR "balance_legacy_grant_valid_from_is_repair_proven"(
        funding."id",
        grant_row."valid_from"
      )
    )
$anchor$;
  link_replacement TEXT := $replacement$
    AND (
      (
        grant_row."created_at" = funding."created_at"
        AND grant_row."valid_from" >= grant_row."created_at"
        AND (
          grant_row."valid_from" <= grant_row."created_at"
          OR "balance_legacy_grant_valid_from_is_repair_proven"(
            funding."id",
            grant_row."valid_from"
          )
        )
      )
      OR (
        "balance_admin_funding_terminal_grant_id"(
          target_account_id,
          funding."id"
        ) = grant_row."id"
        AND grant_row."created_at" > funding."created_at"
        AND grant_row."valid_from" >= funding."created_at"
        AND grant_row."valid_from" <= grant_row."created_at"
      )
    )
$replacement$;
  match_count BIGINT;
BEGIN
  SELECT p.oid, p.prosrc
    INTO candidate_oid, candidate_source
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language language_row ON language_row.oid = p.prolang
  WHERE n.nspname = 'public'
    AND p.proname = 'balance_funding_candidates'
    AND p.proargtypes = '25 25'::OIDVECTOR
    AND p.pronargs = 2
    AND p.prokind = 'f'
    AND p.proretset
    AND p.prorettype = 'record'::REGTYPE
    AND language_row.lanname = 'sql'
    AND p.provolatile = 's'
    AND NOT p.prosecdef;

  IF candidate_oid IS NULL THEN
    RAISE EXCEPTION 'balance_funding_candidates signature/property fingerprint missing'
      USING ERRCODE = '55000';
  END IF;
  SELECT COUNT(*) INTO match_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'balance_funding_candidates'
    AND p.proargtypes = '25 25'::OIDVECTOR;
  IF match_count <> 1 THEN
    RAISE EXCEPTION 'balance_funding_candidates signature is ambiguous: %', match_count
      USING ERRCODE = '55000';
  END IF;

  IF (length(candidate_source) - length(replace(
      candidate_source, create_anchor, ''
    ))) / length(create_anchor) <> 1
    OR (length(candidate_source) - length(replace(
      candidate_source, link_anchor, ''
    ))) / length(link_anchor) <> 1
    OR position('balance_admin_funding_terminal_grant_id' IN candidate_source) <> 0
  THEN
    RAISE EXCEPTION 'balance_funding_candidates source fingerprint changed'
      USING ERRCODE = '55000';
  END IF;

  rewritten_source := replace(candidate_source, create_anchor, create_replacement);
  rewritten_source := replace(rewritten_source, link_anchor, link_replacement);

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.balance_funding_candidates('
      || 'target_account_id TEXT, target_account_type TEXT) '
      || 'RETURNS TABLE(funding_id TEXT, grant_id TEXT, nature TEXT) '
      || 'LANGUAGE sql STABLE AS %L',
    rewritten_source
  );

  SELECT p.prosrc INTO candidate_source
  FROM pg_proc p
  WHERE p.oid = candidate_oid;
  IF (length(candidate_source) - length(replace(
      candidate_source, 'balance_admin_funding_terminal_grant_id', ''
    ))) / length('balance_admin_funding_terminal_grant_id') <> 2
    OR position(create_replacement IN candidate_source) = 0
    OR position(link_replacement IN candidate_source) = 0
  THEN
    RAISE EXCEPTION 'balance_funding_candidates source upgrade did not verify'
      USING ERRCODE = '55000';
  END IF;
END
$upgrade_funding_candidates$;

DO $upgrade_legacy_settlement_timing$
DECLARE
  timing_oid OID;
  timing_source TEXT;
  rewritten_source TEXT;
  select_anchor TEXT := '  SELECT EXISTS (';
  select_replacement TEXT :=
    '  SELECT "balance_admin_funding_settlement_timing_is_proven"('
    || 'target_settlement_id) OR EXISTS (';
BEGIN
  SELECT p.oid, p.prosrc INTO timing_oid, timing_source
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language language_row ON language_row.oid = p.prolang
  WHERE n.nspname = 'public'
    AND p.proname = 'balance_legacy_enterprise_settlement_timing_is_proven'
    AND p.proargtypes = '25'::OIDVECTOR
    AND p.pronargs = 1
    AND p.prokind = 'f'
    AND NOT p.proretset
    AND p.prorettype = 'boolean'::REGTYPE
    AND language_row.lanname = 'sql'
    AND p.provolatile = 's'
    AND NOT p.prosecdef;
  IF timing_oid IS NULL
    OR (length(timing_source) - length(replace(
      timing_source, select_anchor, ''
    ))) / length(select_anchor) <> 1
    OR position(
      'balance_admin_funding_settlement_timing_is_proven' IN timing_source
    ) <> 0
  THEN
    RAISE EXCEPTION 'legacy settlement timing source fingerprint changed'
      USING ERRCODE = '55000';
  END IF;

  rewritten_source := replace(
    timing_source,
    select_anchor,
    select_replacement
  );
  EXECUTE format(
    'CREATE OR REPLACE FUNCTION '
      || 'public.balance_legacy_enterprise_settlement_timing_is_proven('
      || 'target_settlement_id TEXT) RETURNS BOOLEAN LANGUAGE sql STABLE AS %L',
    rewritten_source
  );

  SELECT p.prosrc INTO timing_source FROM pg_proc p WHERE p.oid = timing_oid;
  IF (length(timing_source) - length(replace(
      timing_source,
      'balance_admin_funding_settlement_timing_is_proven',
      ''
    ))) / length('balance_admin_funding_settlement_timing_is_proven') <> 1
  THEN
    RAISE EXCEPTION 'legacy settlement timing upgrade did not verify'
      USING ERRCODE = '55000';
  END IF;
END
$upgrade_legacy_settlement_timing$;

-- The canonical promotion function intentionally owns a complete, strict set
-- of account invariants.  Test and UAT currently carry different versions of
-- that function, so replacing it with a copied body would silently retire UAT's
-- opening-balance checks.  Rewrite only its one local classifier CTE in-place.
DO $upgrade_canonical_promotion$
DECLARE
  promotion_oid OID;
  promotion_source TEXT;
  rewritten_source TEXT;
  start_marker TEXT := '  ), funding_candidates AS (';
  end_marker TEXT := '  ), funding_cardinality AS (';
  replacement_body TEXT := $replacement$  ), funding_candidates AS (
    SELECT candidate.funding_id, candidate.grant_id, candidate.nature
    FROM "balance_funding_candidates"(
      target_account_id,
      account_row."type"
    ) candidate
$replacement$;
  grant_creation_anchor TEXT := $grant_creation_anchor$      (SELECT COUNT(*) FROM current_grants current
        LEFT JOIN before_grants before ON before.grant_id = current."id"
        WHERE before.grant_id IS NULL)
$grant_creation_anchor$;
  grant_creation_replacement TEXT := $grant_creation_replacement$      (SELECT COUNT(*) FROM current_grants current
        LEFT JOIN before_grants before ON before.grant_id = current."id"
        WHERE before.grant_id IS NULL
          AND NOT EXISTS (
            SELECT 1
            FROM "balance_ledger_admin_funding_repairs" funding_proof
            WHERE funding_proof."run_id" = target_run_id
              AND funding_proof."repair_account_id" = repair_row."id"
              AND funding_proof."billing_account_id" = target_account_id
              AND funding_proof."action" = 'CREATE_GRANT'
              AND funding_proof."balance_grant_id" = current."id"
              AND "balance_admin_funding_terminal_grant_id"(
                target_account_id,
                funding_proof."balance_transaction_id"
              ) = current."id"
          ))
$grant_creation_replacement$;
  allocation_anchor TEXT := $allocation_anchor$      OR EXISTS (
        -- Enterprise legacy settlement repair is component-only authority.
        -- Independently of the plan JSON, its row audit may change only the
        -- paid/bonus components and an optional legacy sequence.
        SELECT 1
        FROM "balance_ledger_allocation_repairs" allocation_repair
        WHERE account_row."type" = 'enterprise'
          AND allocation_repair."run_id" = target_run_id
          AND allocation_repair."billing_account_id" = target_account_id
          AND (
            allocation_repair."before_snapshot"
              - 'ledger_sequence'
              - 'recognized_revenue_usd'
              - 'bonus_consumed_usd'
          ) IS DISTINCT FROM (
            allocation_repair."after_snapshot"
              - 'ledger_sequence'
              - 'recognized_revenue_usd'
              - 'bonus_consumed_usd'
          )
      )
$allocation_anchor$;
  allocation_replacement TEXT := $allocation_replacement$      OR EXISTS (
        -- Enterprise legacy settlement repair remains component-only unless
        -- this exact row is the audited FIFO rewrite authorized by an admin
        -- funding proof and the terminal plan snapshot.
        SELECT 1
        FROM "balance_ledger_allocation_repairs" allocation_repair
        WHERE account_row."type" = 'enterprise'
          AND allocation_repair."run_id" = target_run_id
          AND allocation_repair."billing_account_id" = target_account_id
          AND (
            allocation_repair."before_snapshot"
              - 'ledger_sequence'
              - 'recognized_revenue_usd'
              - 'bonus_consumed_usd'
          ) IS DISTINCT FROM (
            allocation_repair."after_snapshot"
              - 'ledger_sequence'
              - 'recognized_revenue_usd'
              - 'bonus_consumed_usd'
          )
          AND NOT "balance_admin_funding_allocation_repair_is_proven"(
            allocation_repair."id",
            target_account_id,
            target_run_id,
            repair_row."after_snapshot"
          )
      )
$allocation_replacement$;
  terminal_anchor TEXT := $terminal_anchor$      OR (repair_row."after_snapshot"->>'invoiceItemCount')::BIGINT
        IS DISTINCT FROM invoice_item_count
$terminal_anchor$;
  terminal_replacement TEXT := $terminal_replacement$      OR (
        account_row."type" = 'enterprise'
        AND NOT "balance_admin_funding_terminal_evidence_is_valid"(
          target_account_id,
          target_run_id,
          repair_row."after_snapshot"
        )
      )
      OR (repair_row."after_snapshot"->>'invoiceItemCount')::BIGINT
        IS DISTINCT FROM invoice_item_count
$terminal_replacement$;
  start_position INTEGER;
  end_position INTEGER;
  match_count BIGINT;
BEGIN
  SELECT p.oid, p.prosrc
    INTO promotion_oid, promotion_source
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language language_row ON language_row.oid = p.prolang
  WHERE n.nspname = 'public'
    AND p.proname = 'assert_balance_ledger_canonical_promotion'
    AND p.proargtypes = '25 25 16'::OIDVECTOR
    AND p.pronargs = 3
    AND p.prokind = 'f'
    AND NOT p.proretset
    AND p.prorettype = 'void'::REGTYPE
    AND language_row.lanname = 'plpgsql'
    AND p.provolatile = 'v'
    AND NOT p.prosecdef;

  IF promotion_oid IS NULL THEN
    RAISE EXCEPTION
      'assert_balance_ledger_canonical_promotion signature/property fingerprint missing'
      USING ERRCODE = '55000';
  END IF;
  SELECT COUNT(*) INTO match_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'assert_balance_ledger_canonical_promotion'
    AND p.proargtypes = '25 25 16'::OIDVECTOR;
  IF match_count <> 1 THEN
    RAISE EXCEPTION
      'assert_balance_ledger_canonical_promotion signature is ambiguous: %',
      match_count USING ERRCODE = '55000';
  END IF;

  IF (length(promotion_source) - length(replace(
      promotion_source, start_marker, ''
    ))) / length(start_marker) <> 1
    OR (length(promotion_source) - length(replace(
      promotion_source, end_marker, ''
    ))) / length(end_marker) <> 1
    OR (length(promotion_source) - length(replace(
      promotion_source, 'balance:admin-adjust:enterprise-paid-debt', ''
    ))) / length('balance:admin-adjust:enterprise-paid-debt') <> 1
    OR (length(promotion_source) - length(replace(
      promotion_source, 'FROM "balance_funding_candidates"(', ''
    ))) / length('FROM "balance_funding_candidates"(') <> 1
    OR (length(promotion_source) - length(replace(
      promotion_source, grant_creation_anchor, ''
    ))) / length(grant_creation_anchor) <> 1
    OR (length(promotion_source) - length(replace(
      promotion_source, allocation_anchor, ''
    ))) / length(allocation_anchor) <> 1
    OR (length(promotion_source) - length(replace(
      promotion_source, terminal_anchor, ''
    ))) / length(terminal_anchor) <> 1
    OR position(
      'balance_admin_funding_allocation_repair_is_proven' IN promotion_source
    ) <> 0
    OR position(
      'balance_admin_funding_terminal_evidence_is_valid' IN promotion_source
    ) <> 0
  THEN
    RAISE EXCEPTION
      'assert_balance_ledger_canonical_promotion source fingerprint changed'
      USING ERRCODE = '55000';
  END IF;

  start_position := position(start_marker IN promotion_source);
  end_position := position(end_marker IN promotion_source);
  IF start_position <= 0 OR end_position <= start_position THEN
    RAISE EXCEPTION 'canonical promotion funding CTE boundaries invalid'
      USING ERRCODE = '55000';
  END IF;

  rewritten_source := substring(promotion_source FROM 1 FOR start_position - 1)
    || replacement_body
    || substring(promotion_source FROM end_position);
  rewritten_source := replace(
    rewritten_source,
    grant_creation_anchor,
    grant_creation_replacement
  );
  rewritten_source := replace(
    rewritten_source,
    allocation_anchor,
    allocation_replacement
  );
  rewritten_source := replace(
    rewritten_source,
    terminal_anchor,
    terminal_replacement
  );

  IF position('balance:admin-adjust:enterprise-paid-debt' IN rewritten_source) <> 0
    OR (length(rewritten_source) - length(replace(
      rewritten_source, 'FROM "balance_funding_candidates"(', ''
    ))) / length('FROM "balance_funding_candidates"(') <> 2
    OR (length(rewritten_source) - length(replace(
      rewritten_source,
      'balance_admin_funding_terminal_grant_id',
      ''
    ))) / length('balance_admin_funding_terminal_grant_id') <> 1
    OR (length(rewritten_source) - length(replace(
      rewritten_source,
      'balance_admin_funding_allocation_repair_is_proven',
      ''
    ))) / length('balance_admin_funding_allocation_repair_is_proven') <> 1
    OR (length(rewritten_source) - length(replace(
      rewritten_source,
      'balance_admin_funding_terminal_evidence_is_valid',
      ''
    ))) / length('balance_admin_funding_terminal_evidence_is_valid') <> 1
  THEN
    RAISE EXCEPTION 'canonical promotion classifier replacement invalid'
      USING ERRCODE = '55000';
  END IF;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.assert_balance_ledger_canonical_promotion('
      || 'target_account_id TEXT, target_run_id TEXT, require_empty BOOLEAN) '
      || 'RETURNS VOID LANGUAGE plpgsql AS %L',
    rewritten_source
  );

  SELECT p.prosrc INTO promotion_source
  FROM pg_proc p
  WHERE p.oid = promotion_oid;
  IF (length(promotion_source) - length(replace(
      promotion_source, start_marker, ''
    ))) / length(start_marker) <> 1
    OR (length(promotion_source) - length(replace(
      promotion_source, end_marker, ''
    ))) / length(end_marker) <> 1
    OR (length(promotion_source) - length(replace(
      promotion_source, 'FROM "balance_funding_candidates"(', ''
    ))) / length('FROM "balance_funding_candidates"(') <> 2
    OR (length(promotion_source) - length(replace(
      promotion_source,
      'balance_admin_funding_terminal_grant_id',
      ''
    ))) / length('balance_admin_funding_terminal_grant_id') <> 1
    OR (length(promotion_source) - length(replace(
      promotion_source,
      'balance_admin_funding_allocation_repair_is_proven',
      ''
    ))) / length('balance_admin_funding_allocation_repair_is_proven') <> 1
    OR (length(promotion_source) - length(replace(
      promotion_source,
      'balance_admin_funding_terminal_evidence_is_valid',
      ''
    ))) / length('balance_admin_funding_terminal_evidence_is_valid') <> 1
    OR position('balance:admin-adjust:enterprise-paid-debt' IN promotion_source) <> 0
  THEN
    RAISE EXCEPTION 'canonical promotion classifier upgrade did not verify'
      USING ERRCODE = '55000';
  END IF;
END
$upgrade_canonical_promotion$;

COMMIT;
