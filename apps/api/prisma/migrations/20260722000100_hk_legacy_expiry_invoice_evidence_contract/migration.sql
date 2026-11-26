-- Permanent, database-native evidence for two retired legacy shapes:
--   1. inline grant expiry wrote the negative ADJUST and zeroed the grant but
--      predated balance_grant_expiries;
--   2. already-issued invoices must remain byte-for-byte stable while their
--      owning account is reconciled.
--
-- This is proof-only compatibility.  It does not make either legacy writer a
-- supported runtime path and it does not weaken the default CLEAN contract.

BEGIN;
SET LOCAL lock_timeout = '5s';
SET LOCAL statement_timeout = '30s';

CREATE TABLE "balance_ledger_legacy_expiry_repairs" (
  "id" TEXT PRIMARY KEY,
  "operation_key" TEXT NOT NULL UNIQUE,
  "proof_version" INTEGER NOT NULL DEFAULT 1,
  "repair_kind" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "repair_account_id" TEXT NOT NULL,
  "billing_account_id" TEXT NOT NULL,
  "balance_grant_id" TEXT NOT NULL UNIQUE,
  "balance_transaction_id" TEXT NOT NULL UNIQUE,
  "expiry_audit_id" TEXT NOT NULL UNIQUE,
  "nominal_amount_usd" NUMERIC(20, 12) NOT NULL,
  "nominal_paid_usd" NUMERIC(20, 12) NOT NULL,
  "nominal_bonus_usd" NUMERIC(20, 12) NOT NULL,
  "wallet_balance_before_usd" NUMERIC(20, 12) NOT NULL,
  "wallet_balance_after_usd" NUMERIC(20, 12) NOT NULL,
  "transaction_snapshot" JSONB NOT NULL,
  "grant_snapshot" JSONB NOT NULL,
  "expiry_audit_snapshot" JSONB NOT NULL,
  "finance_approval_ref" TEXT NOT NULL,
  "technical_approval_ref" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bl_legacy_expiry_repairs_run_fkey"
    FOREIGN KEY ("run_id") REFERENCES "balance_ledger_repair_runs"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "bl_legacy_expiry_repairs_repair_fkey"
    FOREIGN KEY ("repair_account_id") REFERENCES "balance_ledger_repair_accounts"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "bl_legacy_expiry_repairs_account_fkey"
    FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "bl_legacy_expiry_repairs_grant_fkey"
    FOREIGN KEY ("balance_grant_id") REFERENCES "balance_grants"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "bl_legacy_expiry_repairs_tx_fkey"
    FOREIGN KEY ("balance_transaction_id") REFERENCES "balance_transactions"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  -- The proof is inserted before the standard audit.  The deferred FK and
  -- the terminal proof trigger require both rows to exist at COMMIT.
  CONSTRAINT "bl_legacy_expiry_repairs_audit_fkey"
    FOREIGN KEY ("expiry_audit_id") REFERENCES "balance_grant_expiries"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT
    DEFERRABLE INITIALLY DEFERRED,
  CONSTRAINT "bl_legacy_expiry_repairs_shape_check" CHECK (
    "proof_version" = 1
    AND "repair_kind" = 'LEGACY_INLINE_EXPIRY_V1'
    AND "expiry_audit_id" = 'repair-legacy-expiry:' || "balance_grant_id"
    AND "nominal_amount_usd" > 0
    AND "nominal_paid_usd" >= 0
    AND "nominal_bonus_usd" >= 0
    AND "nominal_amount_usd" = "nominal_paid_usd" + "nominal_bonus_usd"
    AND "wallet_balance_before_usd" >= "nominal_amount_usd"
    AND "wallet_balance_after_usd"
      = "wallet_balance_before_usd" - "nominal_amount_usd"
    AND jsonb_typeof("transaction_snapshot") = 'object'
    AND jsonb_typeof("grant_snapshot") = 'object'
    AND jsonb_typeof("expiry_audit_snapshot") = 'object'
    AND length(btrim("finance_approval_ref")) BETWEEN 1 AND 200
    AND length(btrim("technical_approval_ref")) BETWEEN 1 AND 200
    AND btrim("finance_approval_ref") = "finance_approval_ref"
    AND btrim("technical_approval_ref") = "technical_approval_ref"
    AND "finance_approval_ref" <> "technical_approval_ref"
  )
);

CREATE UNIQUE INDEX "bl_legacy_expiry_repairs_run_tx_key"
  ON "balance_ledger_legacy_expiry_repairs"(
    "run_id", "billing_account_id", "balance_transaction_id"
  );
CREATE INDEX "bl_legacy_expiry_repairs_account_created_idx"
  ON "balance_ledger_legacy_expiry_repairs"(
    "billing_account_id", "created_at"
  );

CREATE TABLE "balance_ledger_invoice_stability_repairs" (
  "id" TEXT PRIMARY KEY,
  "operation_key" TEXT NOT NULL UNIQUE,
  "proof_version" INTEGER NOT NULL DEFAULT 1,
  "repair_kind" TEXT NOT NULL,
  "run_id" TEXT NOT NULL,
  "repair_account_id" TEXT NOT NULL UNIQUE,
  "billing_account_id" TEXT NOT NULL,
  "order_count" BIGINT NOT NULL,
  "application_count" BIGINT NOT NULL,
  "item_count" BIGINT NOT NULL,
  "event_count" BIGINT NOT NULL,
  "evidence_sha256" TEXT NOT NULL,
  "evidence_snapshot" JSONB NOT NULL,
  "finance_approval_ref" TEXT NOT NULL,
  "technical_approval_ref" TEXT NOT NULL,
  "created_at" TIMESTAMP(3) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT "bl_invoice_stability_repairs_run_fkey"
    FOREIGN KEY ("run_id") REFERENCES "balance_ledger_repair_runs"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "bl_invoice_stability_repairs_repair_fkey"
    FOREIGN KEY ("repair_account_id") REFERENCES "balance_ledger_repair_accounts"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "bl_invoice_stability_repairs_account_fkey"
    FOREIGN KEY ("billing_account_id") REFERENCES "billing_accounts"("id")
    ON DELETE RESTRICT ON UPDATE RESTRICT,
  CONSTRAINT "bl_invoice_stability_repairs_shape_check" CHECK (
    "proof_version" = 1
    AND "repair_kind" = 'ISSUED_INVOICE_STABILITY_V1'
    AND "order_count" > 0
    AND "application_count" > 0
    AND "item_count" > 0
    AND "event_count" > 0
    AND "evidence_sha256" ~ '^[0-9a-f]{64}$'
    AND "evidence_sha256" <> repeat('0', 64)
    AND jsonb_typeof("evidence_snapshot") = 'object'
    AND length(btrim("finance_approval_ref")) BETWEEN 1 AND 200
    AND length(btrim("technical_approval_ref")) BETWEEN 1 AND 200
    AND btrim("finance_approval_ref") = "finance_approval_ref"
    AND btrim("technical_approval_ref") = "technical_approval_ref"
    AND "finance_approval_ref" <> "technical_approval_ref"
  )
);

CREATE UNIQUE INDEX "bl_invoice_stability_repairs_run_account_key"
  ON "balance_ledger_invoice_stability_repairs"(
    "run_id", "billing_account_id"
  );
CREATE INDEX "bl_invoice_stability_repairs_account_created_idx"
  ON "balance_ledger_invoice_stability_repairs"(
    "billing_account_id", "created_at"
  );

CREATE OR REPLACE FUNCTION "reject_balance_ledger_evidence_repair_mutation"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  RAISE EXCEPTION 'balance ledger evidence repair is append-only table=% id=%',
    TG_TABLE_NAME, OLD."id" USING ERRCODE = '23514';
END
$$;

CREATE TRIGGER "balance_ledger_legacy_expiry_repairs_append_only"
BEFORE UPDATE OR DELETE ON "balance_ledger_legacy_expiry_repairs"
FOR EACH ROW
EXECUTE FUNCTION "reject_balance_ledger_evidence_repair_mutation"();

CREATE TRIGGER "balance_ledger_invoice_stability_repairs_append_only"
BEFORE UPDATE OR DELETE ON "balance_ledger_invoice_stability_repairs"
FOR EACH ROW
EXECUTE FUNCTION "reject_balance_ledger_evidence_repair_mutation"();

-- One database helper owns the complete invoice closure used by both the
-- repair runner and every guard below.  The closure is:
-- account orders -> applications containing those orders -> all items on
-- those applications -> every order referenced by those items, plus all
-- application events.  Four full-row arrays are sorted by id before hashing.
CREATE OR REPLACE FUNCTION "balance_ledger_invoice_stability_evidence"(
  target_account_id TEXT
)
RETURNS TABLE (
  evidence_snapshot JSONB,
  evidence_sha256 TEXT,
  order_ids TEXT[],
  application_ids TEXT[],
  item_ids TEXT[],
  event_ids TEXT[],
  order_count BIGINT,
  application_count BIGINT,
  item_count BIGINT,
  event_count BIGINT,
  invoice_item_count BIGINT,
  unsafe_invoice_item_count BIGINT,
  invalid_application_count BIGINT
)
LANGUAGE sql
STABLE
AS $$
  WITH subject_order_ids AS (
    SELECT grant_row."order_id" AS order_id
    FROM "balance_grants" grant_row
    WHERE grant_row."billing_account_id" = target_account_id
      AND grant_row."order_id" IS NOT NULL
    UNION
    SELECT transaction_row."order_id"
    FROM "balance_transactions" transaction_row
    WHERE transaction_row."billing_account_id" = target_account_id
      AND transaction_row."order_id" IS NOT NULL
  ), related_application_ids AS (
    SELECT DISTINCT item."application_id"
    FROM "invoice_application_items" item
    JOIN subject_order_ids subject ON subject.order_id = item."order_id"
  ), closure_items AS (
    SELECT item.*
    FROM "invoice_application_items" item
    JOIN related_application_ids related
      ON related."application_id" = item."application_id"
  ), closure_order_ids AS (
    SELECT order_id FROM subject_order_ids
    UNION
    SELECT item."order_id" FROM closure_items item
  ), closure_orders AS (
    SELECT order_row.*
    FROM "orders" order_row
    JOIN closure_order_ids closure ON closure.order_id = order_row."id"
  ), closure_applications AS (
    SELECT application.*
    FROM "invoice_applications" application
    JOIN related_application_ids related
      ON related."application_id" = application."id"
  ), closure_events AS (
    SELECT event_row.*
    FROM "invoice_event_log" event_row
    JOIN related_application_ids related
      ON related."application_id" = event_row."application_id"
  ), evidence AS (
    SELECT jsonb_build_object(
      'orders', COALESCE((
        SELECT jsonb_agg(to_jsonb(order_row) ORDER BY order_row."id")
        FROM closure_orders order_row
      ), '[]'::JSONB),
      'applications', COALESCE((
        SELECT jsonb_agg(to_jsonb(application) ORDER BY application."id")
        FROM closure_applications application
      ), '[]'::JSONB),
      'items', COALESCE((
        SELECT jsonb_agg(to_jsonb(item) ORDER BY item."id")
        FROM closure_items item
      ), '[]'::JSONB),
      'events', COALESCE((
        SELECT jsonb_agg(to_jsonb(event_row) ORDER BY event_row."id")
        FROM closure_events event_row
      ), '[]'::JSONB)
    ) AS snapshot
  )
  SELECT
    evidence.snapshot,
    encode(sha256(convert_to(evidence.snapshot::TEXT, 'UTF8')), 'hex'),
    COALESCE((SELECT array_agg(order_row."id" ORDER BY order_row."id")
      FROM closure_orders order_row), ARRAY[]::TEXT[]),
    COALESCE((SELECT array_agg(application."id" ORDER BY application."id")
      FROM closure_applications application), ARRAY[]::TEXT[]),
    COALESCE((SELECT array_agg(item."id" ORDER BY item."id")
      FROM closure_items item), ARRAY[]::TEXT[]),
    COALESCE((SELECT array_agg(event_row."id" ORDER BY event_row."id")
      FROM closure_events event_row), ARRAY[]::TEXT[]),
    (SELECT COUNT(*) FROM closure_orders),
    (SELECT COUNT(*) FROM closure_applications),
    (SELECT COUNT(*) FROM closure_items),
    (SELECT COUNT(*) FROM closure_events),
    (SELECT COUNT(*)
      FROM "invoice_application_items" item
      JOIN subject_order_ids subject ON subject.order_id = item."order_id"),
    (SELECT COUNT(*)
      FROM "invoice_application_items" item
      JOIN subject_order_ids subject ON subject.order_id = item."order_id"
      JOIN "invoice_applications" application
        ON application."id" = item."application_id"
      WHERE application."status"::TEXT IS DISTINCT FROM 'FAILED'
        OR application."invoice_number" IS NOT NULL
        OR application."issue_date" IS NOT NULL
        OR application."due_date" IS NOT NULL
        OR application."issued_at" IS NOT NULL
        OR application."pdf_url" IS NOT NULL
        OR application."ofd_url" IS NOT NULL
        OR EXISTS (
          SELECT 1
          FROM "invoice_event_log" event_row
          WHERE event_row."application_id" = application."id"
            AND event_row."to_status"::TEXT IN (
              'ISSUED', 'VOIDED', 'RED_OFFSET'
            )
        )),
    (SELECT COUNT(*)
      FROM closure_applications application
      WHERE (
          application."status"::TEXT IS DISTINCT FROM 'FAILED'
          OR application."invoice_number" IS NOT NULL
          OR application."issue_date" IS NOT NULL
          OR application."due_date" IS NOT NULL
          OR application."issued_at" IS NOT NULL
          OR application."pdf_url" IS NOT NULL
          OR application."ofd_url" IS NOT NULL
          OR EXISTS (
            SELECT 1
            FROM closure_events event_row
            WHERE event_row."application_id" = application."id"
              AND event_row."to_status"::TEXT IN (
                'ISSUED', 'VOIDED', 'RED_OFFSET'
              )
          )
        )
        AND (
          application."status"::TEXT NOT IN (
            'ISSUED', 'VOIDED', 'RED_OFFSET'
          )
          OR application."invoice_number" IS NULL
          OR application."issue_date" IS NULL
          OR application."issued_at" IS NULL
          OR (application."pdf_url" IS NULL AND application."ofd_url" IS NULL)
          OR NOT EXISTS (
            SELECT 1
            FROM closure_events event_row
            WHERE event_row."application_id" = application."id"
              AND event_row."to_status"::TEXT IN (
                'ISSUED', 'VOIDED', 'RED_OFFSET'
              )
          )
        ))
  FROM evidence
$$;

CREATE OR REPLACE FUNCTION "balance_ledger_invoice_stability_snapshot"(
  target_account_id TEXT
)
RETURNS JSONB
LANGUAGE sql
STABLE
AS $$
  SELECT evidence.evidence_snapshot
  FROM "balance_ledger_invoice_stability_evidence"(target_account_id) evidence
$$;

CREATE OR REPLACE FUNCTION "validate_balance_ledger_invoice_stability_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  active_run_id TEXT;
  run_status TEXT;
  repair_row RECORD;
  account_row RECORD;
  evidence RECORD;
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
  SELECT * INTO evidence
  FROM "balance_ledger_invoice_stability_evidence"(
    NEW."billing_account_id"
  );

  IF active_run_id IS DISTINCT FROM NEW."run_id"
    OR run_status IS DISTINCT FROM 'RUNNING'
    OR repair_row."id" IS NULL
    OR repair_row."run_id" IS DISTINCT FROM NEW."run_id"
    OR repair_row."billing_account_id" IS DISTINCT FROM NEW."billing_account_id"
    OR repair_row."status" IS DISTINCT FROM 'RUNNING'
    OR account_row."id" IS NULL
    OR account_row."balance_grant_ledger_status" IS DISTINCT FROM 'LEGACY_DIRTY'
    OR account_row."balance_grant_ledger_version" IS DISTINCT FROM 0
    OR NEW."operation_key" IS DISTINCT FROM (
      'repair:invoice-stability:' || NEW."run_id" || ':'
      || NEW."billing_account_id"
    )
    OR NEW."order_count" IS DISTINCT FROM evidence.order_count
    OR NEW."application_count" IS DISTINCT FROM evidence.application_count
    OR NEW."item_count" IS DISTINCT FROM evidence.item_count
    OR NEW."event_count" IS DISTINCT FROM evidence.event_count
    OR NEW."evidence_snapshot" IS DISTINCT FROM evidence.evidence_snapshot
    OR NEW."evidence_sha256" IS DISTINCT FROM evidence.evidence_sha256
    OR evidence.unsafe_invoice_item_count <= 0
    OR evidence.invalid_application_count <> 0
  THEN
    RAISE EXCEPTION
      'invoice stability repair proof invalid account=% run=% unsafe=% invalidApplications=%',
      NEW."billing_account_id", NEW."run_id",
      evidence.unsafe_invoice_item_count,
      evidence.invalid_application_count
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "balance_ledger_invoice_stability_repairs_insert_guard"
BEFORE INSERT ON "balance_ledger_invoice_stability_repairs"
FOR EACH ROW
EXECUTE FUNCTION "validate_balance_ledger_invoice_stability_insert"();

CREATE OR REPLACE FUNCTION "balance_ledger_invoice_stability_proof_is_valid"(
  target_account_id TEXT,
  target_run_id TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT COUNT(*) = 1
  FROM "balance_ledger_invoice_stability_repairs" proof
  JOIN "balance_ledger_repair_runs" run_row
    ON run_row."id" = proof."run_id"
  JOIN "balance_ledger_repair_accounts" repair
    ON repair."id" = proof."repair_account_id"
  JOIN "billing_accounts" account_row
    ON account_row."id" = proof."billing_account_id"
  CROSS JOIN LATERAL "balance_ledger_invoice_stability_evidence"(
    proof."billing_account_id"
  ) evidence
  WHERE proof."billing_account_id" = target_account_id
    AND proof."run_id" = target_run_id
    AND proof."operation_key" = (
      'repair:invoice-stability:' || proof."run_id" || ':'
      || proof."billing_account_id"
    )
    AND proof."proof_version" = 1
    AND proof."repair_kind" = 'ISSUED_INVOICE_STABILITY_V1'
    AND run_row."status" IN (
      'RUNNING', 'COMPLETED', 'COMPLETED_WITH_EXCEPTIONS'
    )
    AND repair."run_id" = proof."run_id"
    AND repair."billing_account_id" = proof."billing_account_id"
    AND repair."status" = 'APPLIED'
    AND account_row."balance_grant_ledger_status" = 'RECONCILED_V2'
    AND account_row."balance_grant_ledger_version" = 2
    AND account_row."balance_grant_ledger_hash" IS NOT NULL
    AND account_row."balance_grant_ledger_reconciled_at" IS NOT NULL
    AND account_row."balance_grant_ledger_dirty_reason" IS NULL
    AND proof."order_count" = evidence.order_count
    AND proof."application_count" = evidence.application_count
    AND proof."item_count" = evidence.item_count
    AND proof."event_count" = evidence.event_count
    AND proof."evidence_snapshot" = evidence.evidence_snapshot
    AND proof."evidence_sha256" = evidence.evidence_sha256
    AND evidence.unsafe_invoice_item_count > 0
    AND evidence.invalid_application_count = 0
$$;

CREATE OR REPLACE FUNCTION "validate_balance_ledger_invoice_stability_terminal"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT "balance_ledger_invoice_stability_proof_is_valid"(
    NEW."billing_account_id", NEW."run_id"
  ) THEN
    RAISE EXCEPTION
      'invoice stability repair terminal proof invalid account=% run=%',
      NEW."billing_account_id", NEW."run_id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER "balance_ledger_invoice_stability_terminal_deferred"
AFTER INSERT ON "balance_ledger_invoice_stability_repairs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_balance_ledger_invoice_stability_terminal"();

CREATE OR REPLACE FUNCTION "validate_balance_ledger_legacy_expiry_insert"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
DECLARE
  active_run_id TEXT;
  run_status TEXT;
  repair_row RECORD;
  account_row RECORD;
  grant_row RECORD;
  transaction_row RECORD;
  expected_nominal_paid NUMERIC;
  expected_nominal_bonus NUMERIC;
  expected_audit JSONB;
  existing_audit_count BIGINT;
  refund_count BIGINT;
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
  SELECT * INTO grant_row
  FROM "balance_grants"
  WHERE "id" = NEW."balance_grant_id";
  SELECT * INTO transaction_row
  FROM "balance_transactions"
  WHERE "id" = NEW."balance_transaction_id";

  SELECT
    grant_row."paid_amount_usd"
      - COALESCE((
          SELECT SUM(allocation."recognized_revenue_usd")
          FROM "balance_consumption_allocations" allocation
          WHERE allocation."billing_account_id" = NEW."billing_account_id"
            AND allocation."balance_grant_id" = NEW."balance_grant_id"
            AND allocation."source" = 'BALANCE_GRANT'
        ), 0)
      - COALESCE((
          SELECT SUM(settlement."paid_usd")
          FROM "enterprise_credit_settlements" settlement
          WHERE settlement."billing_account_id" = NEW."billing_account_id"
            AND COALESCE(
              settlement."balance_grant_id",
              "balance_legacy_settlement_effective_grant_id"(settlement."id")
            ) = NEW."balance_grant_id"
        ), 0),
    grant_row."bonus_amount_usd"
      - COALESCE((
          SELECT SUM(allocation."bonus_consumed_usd")
          FROM "balance_consumption_allocations" allocation
          WHERE allocation."billing_account_id" = NEW."billing_account_id"
            AND allocation."balance_grant_id" = NEW."balance_grant_id"
            AND allocation."source" = 'BALANCE_GRANT'
        ), 0)
      - COALESCE((
          SELECT SUM(settlement."bonus_usd")
          FROM "enterprise_credit_settlements" settlement
          WHERE settlement."billing_account_id" = NEW."billing_account_id"
            AND COALESCE(
              settlement."balance_grant_id",
              "balance_legacy_settlement_effective_grant_id"(settlement."id")
            ) = NEW."balance_grant_id"
        ), 0)
  INTO expected_nominal_paid, expected_nominal_bonus;

  SELECT COUNT(*) INTO existing_audit_count
  FROM "balance_grant_expiries"
  WHERE "balance_grant_id" = NEW."balance_grant_id"
    OR "balance_transaction_id" = NEW."balance_transaction_id"
    OR "id" = NEW."expiry_audit_id";
  SELECT COUNT(*) INTO refund_count
  FROM "balance_grant_refunds"
  WHERE "balance_grant_id" = NEW."balance_grant_id";

  expected_audit := jsonb_build_object(
    'id', NEW."expiry_audit_id",
    'balance_grant_id', NEW."balance_grant_id",
    'billing_account_id', NEW."billing_account_id",
    'balance_transaction_id', NEW."balance_transaction_id",
    'nominal_amount_usd', NEW."nominal_amount_usd",
    'nominal_paid_usd', NEW."nominal_paid_usd",
    'nominal_bonus_usd', NEW."nominal_bonus_usd",
    'wallet_debit_usd', NEW."nominal_amount_usd",
    'wallet_debit_paid_usd', NEW."nominal_paid_usd",
    'wallet_debit_bonus_usd', NEW."nominal_bonus_usd",
    'unbacked_amount_usd', 0,
    'unbacked_paid_usd', 0,
    'unbacked_bonus_usd', 0,
    'wallet_balance_before_usd', NEW."wallet_balance_before_usd",
    'wallet_balance_after_usd', NEW."wallet_balance_after_usd",
    'created_at', transaction_row."created_at"
  );

  IF active_run_id IS DISTINCT FROM NEW."run_id"
    OR run_status IS DISTINCT FROM 'RUNNING'
    OR repair_row."id" IS NULL
    OR repair_row."run_id" IS DISTINCT FROM NEW."run_id"
    OR repair_row."billing_account_id" IS DISTINCT FROM NEW."billing_account_id"
    OR repair_row."status" IS DISTINCT FROM 'RUNNING'
    OR account_row."id" IS NULL
    OR account_row."balance_grant_ledger_status" IS DISTINCT FROM 'LEGACY_DIRTY'
    OR account_row."balance_grant_ledger_version" IS DISTINCT FROM 0
    OR grant_row."id" IS NULL
    OR transaction_row."id" IS NULL
    OR NEW."operation_key" IS DISTINCT FROM (
      'repair:legacy-expiry:' || NEW."run_id" || ':'
      || NEW."balance_transaction_id" || ':' || NEW."balance_grant_id"
    )
    OR NEW."expiry_audit_id" IS DISTINCT FROM (
      'repair-legacy-expiry:' || NEW."balance_grant_id"
    )
    OR to_jsonb(grant_row) IS DISTINCT FROM NEW."grant_snapshot"
    OR to_jsonb(transaction_row) IS DISTINCT FROM NEW."transaction_snapshot"
    OR grant_row."billing_account_id" IS DISTINCT FROM NEW."billing_account_id"
    OR transaction_row."billing_account_id" IS DISTINCT FROM NEW."billing_account_id"
    OR transaction_row."user_id" IS DISTINCT FROM grant_row."user_id"
    OR transaction_row."tenant_id" IS DISTINCT FROM grant_row."tenant_id"
    OR transaction_row."product_id" IS DISTINCT FROM grant_row."product_id"
    OR transaction_row."order_id" IS DISTINCT FROM grant_row."order_id"
    OR transaction_row."type"::TEXT IS DISTINCT FROM 'ADJUST'
    OR transaction_row."amount_usd" IS DISTINCT FROM -NEW."nominal_amount_usd"
    OR transaction_row."balance_after_usd"
      IS DISTINCT FROM NEW."wallet_balance_after_usd"
    OR transaction_row."balance_after_usd" - transaction_row."amount_usd"
      IS DISTINCT FROM NEW."wallet_balance_before_usd"
    OR transaction_row."description"
      IS DISTINCT FROM ('balance grant expired:' || NEW."balance_grant_id")
    OR transaction_row."operation_key" IS NOT NULL
    OR transaction_row."token_usage_id" IS NOT NULL
    OR transaction_row."ledger_sequence" IS NOT NULL
    OR grant_row."expires_at" IS NULL
    OR transaction_row."created_at" < grant_row."expires_at"
    OR NOT grant_row."is_expired"
    OR grant_row."remaining_amount_usd" <> 0
    OR (grant_row."remaining_paid_amount_usd" IS NULL)
      IS DISTINCT FROM (grant_row."remaining_bonus_amount_usd" IS NULL)
    OR COALESCE(grant_row."remaining_paid_amount_usd", 0) <> 0
    OR COALESCE(grant_row."remaining_bonus_amount_usd", 0) <> 0
    OR expected_nominal_paid IS DISTINCT FROM NEW."nominal_paid_usd"
    OR expected_nominal_bonus IS DISTINCT FROM NEW."nominal_bonus_usd"
    OR expected_nominal_paid + expected_nominal_bonus
      IS DISTINCT FROM NEW."nominal_amount_usd"
    OR NEW."expiry_audit_snapshot" IS DISTINCT FROM expected_audit
    OR existing_audit_count <> 0
    OR refund_count <> 0
  THEN
    RAISE EXCEPTION
      'legacy inline expiry proof invalid account=% grant=% transaction=% nominal=%/%/%',
      NEW."billing_account_id", NEW."balance_grant_id",
      NEW."balance_transaction_id", NEW."nominal_amount_usd",
      expected_nominal_paid, expected_nominal_bonus
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE TRIGGER "balance_ledger_legacy_expiry_repairs_insert_guard"
BEFORE INSERT ON "balance_ledger_legacy_expiry_repairs"
FOR EACH ROW
EXECUTE FUNCTION "validate_balance_ledger_legacy_expiry_insert"();

CREATE OR REPLACE FUNCTION "balance_ledger_legacy_expiry_proof_is_valid"(
  target_grant_id TEXT,
  target_transaction_id TEXT,
  target_account_id TEXT,
  target_run_id TEXT DEFAULT NULL
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT COUNT(*) = 1
  FROM "balance_ledger_legacy_expiry_repairs" proof
  JOIN "balance_ledger_repair_runs" run_row
    ON run_row."id" = proof."run_id"
  JOIN "balance_ledger_repair_accounts" repair
    ON repair."id" = proof."repair_account_id"
  JOIN "billing_accounts" account_row
    ON account_row."id" = proof."billing_account_id"
  JOIN "balance_grants" grant_row
    ON grant_row."id" = proof."balance_grant_id"
  JOIN "balance_transactions" transaction_row
    ON transaction_row."id" = proof."balance_transaction_id"
  JOIN "balance_grant_expiries" expiry
    ON expiry."id" = proof."expiry_audit_id"
  WHERE proof."balance_grant_id" = target_grant_id
    AND proof."balance_transaction_id" = target_transaction_id
    AND proof."billing_account_id" = target_account_id
    AND (target_run_id IS NULL OR proof."run_id" = target_run_id)
    AND proof."operation_key" = (
      'repair:legacy-expiry:' || proof."run_id" || ':'
      || proof."balance_transaction_id" || ':' || proof."balance_grant_id"
    )
    AND proof."proof_version" = 1
    AND proof."repair_kind" = 'LEGACY_INLINE_EXPIRY_V1'
    AND run_row."status" IN (
      'RUNNING', 'COMPLETED', 'COMPLETED_WITH_EXCEPTIONS'
    )
    AND repair."run_id" = proof."run_id"
    AND repair."billing_account_id" = proof."billing_account_id"
    AND repair."status" = 'APPLIED'
    AND account_row."balance_grant_ledger_status" = 'RECONCILED_V2'
    AND account_row."balance_grant_ledger_version" = 2
    AND account_row."balance_grant_ledger_hash" IS NOT NULL
    AND account_row."balance_grant_ledger_reconciled_at" IS NOT NULL
    AND account_row."balance_grant_ledger_dirty_reason" IS NULL
    AND expiry."balance_grant_id" = proof."balance_grant_id"
    AND expiry."billing_account_id" = proof."billing_account_id"
    AND expiry."balance_transaction_id" = proof."balance_transaction_id"
    AND to_jsonb(expiry) = proof."expiry_audit_snapshot"
    AND grant_row."billing_account_id" = proof."billing_account_id"
    AND grant_row."is_expired"
    AND grant_row."remaining_amount_usd" = 0
    AND grant_row."remaining_paid_amount_usd" = 0
    AND grant_row."remaining_bonus_amount_usd" = 0
    AND (to_jsonb(grant_row) - ARRAY[
      'remaining_paid_amount_usd', 'remaining_bonus_amount_usd', 'updated_at'
    ]) = (proof."grant_snapshot" - ARRAY[
      'remaining_paid_amount_usd', 'remaining_bonus_amount_usd', 'updated_at'
    ])
    -- Prisma's @updatedAt is the sole non-financial side effect of the exact
    -- NULL -> zero component repair.  It may stay equal for a SQL caller or
    -- advance for Prisma, but it must never move backwards.
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
    AND transaction_row."balance_after_usd" = proof."wallet_balance_after_usd"
    AND transaction_row."balance_after_usd" - transaction_row."amount_usd"
      = proof."wallet_balance_before_usd"
    AND transaction_row."description"
      = ('balance grant expired:' || proof."balance_grant_id")
    AND transaction_row."operation_key" IS NULL
    AND transaction_row."ledger_sequence" IS NOT NULL
    AND transaction_row."ledger_sequence" <> 0
    AND (
      to_jsonb(transaction_row) = proof."transaction_snapshot"
      OR EXISTS (
        SELECT 1
        FROM "balance_ledger_transaction_repairs" transaction_repair
        WHERE transaction_repair."run_id" = proof."run_id"
          AND transaction_repair."repair_account_id" = proof."repair_account_id"
          AND transaction_repair."billing_account_id" = proof."billing_account_id"
          AND transaction_repair."transaction_id"
            = proof."balance_transaction_id"
          AND transaction_repair."before_snapshot"
            = proof."transaction_snapshot"
          AND transaction_repair."after_snapshot" = to_jsonb(transaction_row)
          AND (transaction_repair."before_snapshot" - 'ledger_sequence')
            = (transaction_repair."after_snapshot" - 'ledger_sequence')
          AND transaction_repair."before_snapshot"->'ledger_sequence'
            = 'null'::JSONB
          AND (transaction_repair."after_snapshot"->>'ledger_sequence')::BIGINT
            < 0
      )
    )
$$;

CREATE OR REPLACE FUNCTION "validate_balance_ledger_legacy_expiry_terminal"()
RETURNS TRIGGER
LANGUAGE plpgsql
AS $$
BEGIN
  IF NOT "balance_ledger_legacy_expiry_proof_is_valid"(
    NEW."balance_grant_id",
    NEW."balance_transaction_id",
    NEW."billing_account_id",
    NEW."run_id"
  ) THEN
    RAISE EXCEPTION
      'legacy inline expiry terminal proof invalid account=% grant=% transaction=%',
      NEW."billing_account_id", NEW."balance_grant_id",
      NEW."balance_transaction_id"
      USING ERRCODE = '23514';
  END IF;
  RETURN NEW;
END
$$;

CREATE CONSTRAINT TRIGGER "balance_ledger_legacy_expiry_terminal_deferred"
AFTER INSERT ON "balance_ledger_legacy_expiry_repairs"
DEFERRABLE INITIALLY DEFERRED
FOR EACH ROW
EXECUTE FUNCTION "validate_balance_ledger_legacy_expiry_terminal"();

-- Preserve the standard online expiry contract verbatim and admit only a
-- terminal, proof-backed legacy row for the two fields that necessarily differ:
-- the retired writer had no operation_key and its repaired historical sequence
-- is negative.  Source rewriting avoids replacing unrelated UAT extensions.
DO $upgrade_expiry_aggregate$
DECLARE
  function_oid OID;
  function_source TEXT;
  rewritten_source TEXT;
  declaration_anchor TEXT := $anchor$  predecessor_balance NUMERIC;
BEGIN
$anchor$;
  declaration_replacement TEXT := $replacement$  predecessor_balance NUMERIC;
  legacy_expiry_valid BOOLEAN;
BEGIN
$replacement$;
  assignment_anchor TEXT := $anchor$  SELECT "balance_usd" INTO wallet_balance
$anchor$;
  assignment_replacement TEXT := $replacement$  legacy_expiry_valid := "balance_ledger_legacy_expiry_proof_is_valid"(
    target_grant_id,
    expiry_row."balance_transaction_id",
    expiry_row."billing_account_id",
    NULL
  );

  SELECT "balance_usd" INTO wallet_balance
$replacement$;
  operation_anchor TEXT := $anchor$    OR transaction_row."operation_key"
      IS DISTINCT FROM ('balance:grant-expiry:' || target_grant_id)
$anchor$;
  operation_replacement TEXT := $replacement$    OR (
      transaction_row."operation_key"
        IS DISTINCT FROM ('balance:grant-expiry:' || target_grant_id)
      AND NOT legacy_expiry_valid
    )
$replacement$;
  sequence_anchor TEXT := $anchor$    OR transaction_row."ledger_sequence" IS NULL
    OR transaction_row."ledger_sequence" <= 0
$anchor$;
  sequence_replacement TEXT := $replacement$    OR transaction_row."ledger_sequence" IS NULL
    OR (
      transaction_row."ledger_sequence" <= 0
      AND NOT legacy_expiry_valid
    )
$replacement$;
  match_count BIGINT;
BEGIN
  SELECT p.oid, p.prosrc INTO function_oid, function_source
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language language_row ON language_row.oid = p.prolang
  WHERE n.nspname = 'public'
    AND p.proname = 'assert_balance_grant_expiry_aggregate'
    AND p.proargtypes = '25 25 1700 1700 1700 1114'::OIDVECTOR
    AND p.pronargs = 6
    AND p.prokind = 'f'
    AND NOT p.proretset
    AND p.prorettype = 'void'::REGTYPE
    AND language_row.lanname = 'plpgsql'
    AND p.provolatile = 'v'
    AND NOT p.prosecdef;
  IF function_oid IS NULL THEN
    RAISE EXCEPTION 'expiry aggregate signature/property fingerprint missing'
      USING ERRCODE = '55000';
  END IF;
  SELECT COUNT(*) INTO match_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'assert_balance_grant_expiry_aggregate'
    AND p.proargtypes = '25 25 1700 1700 1700 1114'::OIDVECTOR;
  IF match_count <> 1
    OR (length(function_source) - length(replace(
      function_source, declaration_anchor, ''
    ))) / length(declaration_anchor) <> 1
    OR (length(function_source) - length(replace(
      function_source, assignment_anchor, ''
    ))) / length(assignment_anchor) <> 1
    OR (length(function_source) - length(replace(
      function_source, operation_anchor, ''
    ))) / length(operation_anchor) <> 1
    OR (length(function_source) - length(replace(
      function_source, sequence_anchor, ''
    ))) / length(sequence_anchor) <> 1
    OR position(
      'balance_ledger_legacy_expiry_proof_is_valid' IN function_source
    ) <> 0
  THEN
    RAISE EXCEPTION 'expiry aggregate source fingerprint changed'
      USING ERRCODE = '55000';
  END IF;

  rewritten_source := replace(
    function_source, declaration_anchor, declaration_replacement
  );
  rewritten_source := replace(
    rewritten_source, assignment_anchor, assignment_replacement
  );
  rewritten_source := replace(
    rewritten_source, operation_anchor, operation_replacement
  );
  rewritten_source := replace(
    rewritten_source, sequence_anchor, sequence_replacement
  );

  IF (length(rewritten_source) - length(replace(
      rewritten_source,
      'balance_ledger_legacy_expiry_proof_is_valid',
      ''
    ))) / length('balance_ledger_legacy_expiry_proof_is_valid') <> 1
    OR position(operation_replacement IN rewritten_source) = 0
    OR position(sequence_replacement IN rewritten_source) = 0
  THEN
    RAISE EXCEPTION 'expiry aggregate source replacement invalid'
      USING ERRCODE = '55000';
  END IF;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.assert_balance_grant_expiry_aggregate('
      || 'target_grant_id TEXT, expected_account_id TEXT, '
      || 'expected_nominal_amount NUMERIC, expected_nominal_paid NUMERIC, '
      || 'expected_nominal_bonus NUMERIC, '
      || 'expected_expires_at TIMESTAMP(3)) '
      || 'RETURNS VOID LANGUAGE plpgsql AS %L',
    rewritten_source
  );

  SELECT p.prosrc INTO function_source FROM pg_proc p WHERE p.oid = function_oid;
  IF (length(function_source) - length(replace(
      function_source,
      'balance_ledger_legacy_expiry_proof_is_valid',
      ''
    ))) / length('balance_ledger_legacy_expiry_proof_is_valid') <> 1
    OR position(operation_replacement IN function_source) = 0
    OR position(sequence_replacement IN function_source) = 0
  THEN
    RAISE EXCEPTION 'expiry aggregate source upgrade did not verify'
      USING ERRCODE = '55000';
  END IF;
END
$upgrade_expiry_aggregate$;

-- Replay expired grants through their historical consumption window, then
-- consume the exact proof-backed nominal remainder at the legacy ADJUST row.
-- The shared funding classifier call is intentionally untouched so UAT's
-- admin-funding extension remains active.
DO $upgrade_canonical_replay$
DECLARE
  function_oid OID;
  function_source TEXT;
  rewritten_source TEXT;
  declaration_anchor TEXT := $anchor$  invalid_settlement_link_count BIGINT := 0;
BEGIN
$anchor$;
  declaration_replacement TEXT := $replacement$  invalid_settlement_link_count BIGINT := 0;
  expiry_row RECORD;
BEGIN
$replacement$;
  expiry_filter_anchor TEXT := $anchor$        AND NOT grant_row."is_expired"
$anchor$;
  expiry_filter_replacement TEXT := $replacement$        AND (
          NOT grant_row."is_expired"
          OR EXISTS (
            SELECT 1
            FROM "balance_grant_expiries" replay_expiry
            WHERE replay_expiry."billing_account_id" = target_account_id
              AND replay_expiry."balance_grant_id" = grant_row."id"
              AND "balance_ledger_legacy_expiry_proof_is_valid"(
                grant_row."id",
                replay_expiry."balance_transaction_id",
                target_account_id,
                target_run_id
              )
          )
        )
$replacement$;
  transaction_branch_anchor TEXT := $anchor$    IF transaction_row."type"::TEXT <> 'CONSUME' THEN
      CONTINUE;
    END IF;
$anchor$;
  transaction_branch_replacement TEXT := $replacement$    IF transaction_row."type"::TEXT = 'ADJUST'
      AND transaction_row."amount_usd" < 0
    THEN
      SELECT expiry.* INTO expiry_row
      FROM "balance_grant_expiries" expiry
      WHERE expiry."billing_account_id" = target_account_id
        AND expiry."balance_transaction_id" = transaction_row."id"
        AND "balance_ledger_legacy_expiry_proof_is_valid"(
          expiry."balance_grant_id",
          transaction_row."id",
          target_account_id,
          target_run_id
        );
      IF FOUND THEN
        SELECT * INTO grant_state
        FROM pg_temp."balance_ledger_replay_grant_state" state
        WHERE state.grant_id = expiry_row."balance_grant_id";
        IF NOT FOUND
          OR grant_state.paid_remaining_usd
            IS DISTINCT FROM expiry_row."nominal_paid_usd"
          OR grant_state.bonus_remaining_usd
            IS DISTINCT FROM expiry_row."nominal_bonus_usd"
        THEN
          RAISE EXCEPTION
            'balance canonical replay legacy expiry state invalid transaction=% grant=% paid=%/% bonus=%/%',
            transaction_row."id", expiry_row."balance_grant_id",
            CASE WHEN grant_state IS NULL THEN NULL
              ELSE grant_state.paid_remaining_usd END,
            expiry_row."nominal_paid_usd",
            CASE WHEN grant_state IS NULL THEN NULL
              ELSE grant_state.bonus_remaining_usd END,
            expiry_row."nominal_bonus_usd"
            USING ERRCODE = '23514';
        END IF;
        UPDATE pg_temp."balance_ledger_replay_grant_state"
        SET paid_remaining_usd = paid_remaining_usd
              - expiry_row."nominal_paid_usd",
          bonus_remaining_usd = bonus_remaining_usd
              - expiry_row."nominal_bonus_usd"
        WHERE grant_id = expiry_row."balance_grant_id";
        CONTINUE;
      END IF;
    END IF;

    IF transaction_row."type"::TEXT <> 'CONSUME' THEN
      CONTINUE;
    END IF;
$replacement$;
  match_count BIGINT;
BEGIN
  SELECT p.oid, p.prosrc INTO function_oid, function_source
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  JOIN pg_language language_row ON language_row.oid = p.prolang
  WHERE n.nspname = 'public'
    AND p.proname = 'assert_balance_ledger_canonical_replay'
    AND p.proargtypes = '25 25 25 25 25 1009'::OIDVECTOR
    AND p.pronargs = 6
    AND p.prokind = 'f'
    AND NOT p.proretset
    AND p.prorettype = 'void'::REGTYPE
    AND language_row.lanname = 'plpgsql'
    AND p.provolatile = 'v'
    AND NOT p.prosecdef;
  IF function_oid IS NULL THEN
    RAISE EXCEPTION 'canonical replay signature/property fingerprint missing'
      USING ERRCODE = '55000';
  END IF;
  SELECT COUNT(*) INTO match_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'assert_balance_ledger_canonical_replay'
    AND p.proargtypes = '25 25 25 25 25 1009'::OIDVECTOR;
  IF match_count <> 1
    OR (length(function_source) - length(replace(
      function_source, declaration_anchor, ''
    ))) / length(declaration_anchor) <> 1
    OR (length(function_source) - length(replace(
      function_source, expiry_filter_anchor, ''
    ))) / length(expiry_filter_anchor) <> 1
    OR (length(function_source) - length(replace(
      function_source, transaction_branch_anchor, ''
    ))) / length(transaction_branch_anchor) <> 1
    OR (length(function_source) - length(replace(
      function_source, 'FROM "balance_funding_candidates"(', ''
    ))) / length('FROM "balance_funding_candidates"(') <> 1
    OR position(
      'balance_ledger_legacy_expiry_proof_is_valid' IN function_source
    ) <> 0
  THEN
    RAISE EXCEPTION 'canonical replay source fingerprint changed'
      USING ERRCODE = '55000';
  END IF;

  rewritten_source := replace(
    function_source, declaration_anchor, declaration_replacement
  );
  rewritten_source := replace(
    rewritten_source, expiry_filter_anchor, expiry_filter_replacement
  );
  rewritten_source := replace(
    rewritten_source,
    transaction_branch_anchor,
    transaction_branch_replacement
  );

  IF (length(rewritten_source) - length(replace(
      rewritten_source,
      'balance_ledger_legacy_expiry_proof_is_valid',
      ''
    ))) / length('balance_ledger_legacy_expiry_proof_is_valid') <> 2
    OR (length(rewritten_source) - length(replace(
      rewritten_source, 'FROM "balance_funding_candidates"(', ''
    ))) / length('FROM "balance_funding_candidates"(') <> 1
    OR position(expiry_filter_replacement IN rewritten_source) = 0
    OR position(transaction_branch_replacement IN rewritten_source) = 0
  THEN
    RAISE EXCEPTION 'canonical replay source replacement invalid'
      USING ERRCODE = '55000';
  END IF;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.assert_balance_ledger_canonical_replay('
      || 'target_account_id TEXT, target_account_type TEXT, '
      || 'expected_debt_source TEXT, expected_settlement_mode TEXT, '
      || 'target_run_id TEXT, wallet_path_ids TEXT[]) '
      || 'RETURNS VOID LANGUAGE plpgsql AS %L',
    rewritten_source
  );

  SELECT p.prosrc INTO function_source FROM pg_proc p WHERE p.oid = function_oid;
  IF (length(function_source) - length(replace(
      function_source,
      'balance_ledger_legacy_expiry_proof_is_valid',
      ''
    ))) / length('balance_ledger_legacy_expiry_proof_is_valid') <> 2
    OR (length(function_source) - length(replace(
      function_source, 'FROM "balance_funding_candidates"(', ''
    ))) / length('FROM "balance_funding_candidates"(') <> 1
    OR position(expiry_filter_replacement IN function_source) = 0
    OR position(transaction_branch_replacement IN function_source) = 0
  THEN
    RAISE EXCEPTION 'canonical replay source upgrade did not verify'
      USING ERRCODE = '55000';
  END IF;
END
$upgrade_canonical_replay$;

CREATE OR REPLACE FUNCTION "balance_ledger_legacy_expiry_account_is_valid"(
  target_account_id TEXT,
  target_run_id TEXT
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  SELECT NOT EXISTS (
    SELECT 1
    FROM "balance_grant_expiries" expiry
    WHERE expiry."billing_account_id" = target_account_id
      AND NOT "balance_ledger_legacy_expiry_proof_is_valid"(
        expiry."balance_grant_id",
        expiry."balance_transaction_id",
        target_account_id,
        target_run_id
      )
  )
$$;

-- The canonical promotion calls this once against the signed terminal
-- after_snapshot.  It binds proof counts, evidence hash, and both independent
-- approval references without taking authority away from any existing proof
-- family (including UAT-only admin funding).
CREATE OR REPLACE FUNCTION "balance_ledger_evidence_terminal_is_valid"(
  target_account_id TEXT,
  target_run_id TEXT,
  terminal_snapshot JSONB
)
RETURNS BOOLEAN
LANGUAGE sql
STABLE
AS $$
  WITH legacy AS (
    SELECT COUNT(*) AS proof_count,
      COALESCE(jsonb_agg(jsonb_build_object(
        'proofVersion', proof."proof_version",
        'repairKind', proof."repair_kind",
        'transactionId', proof."balance_transaction_id",
        'grantId', proof."balance_grant_id",
        'expiryAuditId', proof."expiry_audit_id",
        'nominalAmountUsd', proof."nominal_amount_usd"::TEXT,
        'nominalPaidUsd', proof."nominal_paid_usd"::TEXT,
        'nominalBonusUsd', proof."nominal_bonus_usd"::TEXT,
        'walletBalanceBeforeUsd', proof."wallet_balance_before_usd"::TEXT,
        'walletBalanceAfterUsd', proof."wallet_balance_after_usd"::TEXT,
        'transactionSnapshot', proof."transaction_snapshot",
        'grantSnapshot', proof."grant_snapshot",
        'expiryAuditSnapshot', proof."expiry_audit_snapshot",
        'financeApprovalRef', proof."finance_approval_ref",
        'technicalApprovalRef', proof."technical_approval_ref"
      ) ORDER BY proof."balance_transaction_id", proof."balance_grant_id")
        FILTER (WHERE proof."id" IS NOT NULL), '[]'::JSONB
      ) AS proof_snapshot,
      MIN(proof."finance_approval_ref") AS finance_ref_min,
      MAX(proof."finance_approval_ref") AS finance_ref_max,
      MIN(proof."technical_approval_ref") AS technical_ref_min,
      MAX(proof."technical_approval_ref") AS technical_ref_max
    FROM "balance_ledger_legacy_expiry_repairs" proof
    WHERE proof."billing_account_id" = target_account_id
      AND proof."run_id" = target_run_id
  ), invoice AS (
    SELECT COUNT(*) AS proof_count,
      MIN(proof."evidence_sha256") AS evidence_sha256,
      COALESCE((
        SELECT jsonb_build_object(
          'proofVersion', invoice_proof."proof_version",
          'repairKind', invoice_proof."repair_kind",
          'orderCount', invoice_proof."order_count"::TEXT,
          'applicationCount', invoice_proof."application_count"::TEXT,
          'itemCount', invoice_proof."item_count"::TEXT,
          'eventCount', invoice_proof."event_count"::TEXT,
          'evidenceSha256', invoice_proof."evidence_sha256",
          'evidenceSnapshot', invoice_proof."evidence_snapshot",
          'financeApprovalRef', invoice_proof."finance_approval_ref",
          'technicalApprovalRef', invoice_proof."technical_approval_ref"
        )
        FROM "balance_ledger_invoice_stability_repairs" invoice_proof
        WHERE invoice_proof."billing_account_id" = target_account_id
          AND invoice_proof."run_id" = target_run_id
      ), 'null'::JSONB) AS proof_snapshot,
      MIN(proof."finance_approval_ref") AS finance_ref_min,
      MAX(proof."finance_approval_ref") AS finance_ref_max,
      MIN(proof."technical_approval_ref") AS technical_ref_min,
      MAX(proof."technical_approval_ref") AS technical_ref_max
    FROM "balance_ledger_invoice_stability_repairs" proof
    WHERE proof."billing_account_id" = target_account_id
      AND proof."run_id" = target_run_id
  ), approval AS (
    SELECT legacy.proof_count AS legacy_count,
      invoice.proof_count AS invoice_count,
      invoice.evidence_sha256,
      legacy.proof_snapshot AS legacy_proof_snapshot,
      invoice.proof_snapshot AS invoice_proof_snapshot,
      legacy.finance_ref_min,
      legacy.finance_ref_max,
      legacy.technical_ref_min,
      legacy.technical_ref_max,
      invoice.finance_ref_min AS invoice_finance_ref_min,
      invoice.finance_ref_max AS invoice_finance_ref_max,
      invoice.technical_ref_min AS invoice_technical_ref_min,
      invoice.technical_ref_max AS invoice_technical_ref_max
    FROM legacy CROSS JOIN invoice
  )
  SELECT terminal_snapshot IS NOT NULL
    AND jsonb_typeof(terminal_snapshot) = 'object'
    AND (terminal_snapshot->>'legacyExpiryProofCount')::BIGINT
      IS NOT DISTINCT FROM approval.legacy_count
    AND (terminal_snapshot->>'invoiceStabilityProofCount')::BIGINT
      IS NOT DISTINCT FROM approval.invoice_count
    AND terminal_snapshot->>'invoiceEvidenceSha256'
      IS NOT DISTINCT FROM approval.evidence_sha256
    AND terminal_snapshot->'legacyExpiryProofs'
      IS NOT DISTINCT FROM approval.legacy_proof_snapshot
    AND terminal_snapshot->'invoiceStabilityProof'
      IS NOT DISTINCT FROM approval.invoice_proof_snapshot
    AND (
      approval.legacy_count + approval.invoice_count = 0
      OR (
        approval.finance_ref_min IS NOT DISTINCT FROM approval.finance_ref_max
        AND approval.technical_ref_min
          IS NOT DISTINCT FROM approval.technical_ref_max
        AND approval.invoice_finance_ref_min
          IS NOT DISTINCT FROM approval.invoice_finance_ref_max
        AND approval.invoice_technical_ref_min
          IS NOT DISTINCT FROM approval.invoice_technical_ref_max
        AND COALESCE(
          approval.finance_ref_min,
          approval.invoice_finance_ref_min
        ) IS NOT DISTINCT FROM COALESCE(
          approval.invoice_finance_ref_min,
          approval.finance_ref_min
        )
        AND COALESCE(
          approval.technical_ref_min,
          approval.invoice_technical_ref_min
        ) IS NOT DISTINCT FROM COALESCE(
          approval.invoice_technical_ref_min,
          approval.technical_ref_min
        )
      )
    )
  FROM approval
$$;

-- Patch only the strict local predicates needed for the two new proof types.
-- origin/test and UAT intentionally carry different canonical promotion
-- bodies; this preserves UAT's admin-funding markers and every unrelated
-- invariant while still failing the migration if any expected anchor drifts.
DO $upgrade_canonical_promotion$
DECLARE
  function_oid OID;
  function_source TEXT;
  rewritten_source TEXT;
  transaction_anchor TEXT := $anchor$      OR (bt."type"::TEXT IN ('RECHARGE', 'ADJUST') AND bt."amount_usd" <= 0)
$anchor$;
  transaction_replacement TEXT := $replacement$      OR (bt."type"::TEXT = 'RECHARGE' AND bt."amount_usd" <= 0)
      OR (bt."type"::TEXT = 'ADJUST' AND bt."amount_usd" = 0)
      OR (
        bt."type"::TEXT = 'ADJUST'
        AND bt."amount_usd" < 0
        AND NOT EXISTS (
          SELECT 1
          FROM "balance_grant_expiries" expiry
          WHERE expiry."billing_account_id" = target_account_id
            AND expiry."balance_transaction_id" = bt."id"
            AND "balance_ledger_legacy_expiry_proof_is_valid"(
              expiry."balance_grant_id",
              bt."id",
              target_account_id,
              target_run_id
            )
        )
      )
$replacement$;
  expired_grant_anchor TEXT := $anchor$        OR bg."is_expired"
$anchor$;
  expired_grant_replacement TEXT := $replacement$        OR (
          bg."is_expired"
          AND (
            require_empty
            OR target_run_id IS NULL
            OR NOT EXISTS (
              SELECT 1
              FROM "balance_grant_expiries" expiry
              WHERE expiry."billing_account_id" = target_account_id
                AND expiry."balance_grant_id" = bg."id"
                AND "balance_ledger_legacy_expiry_proof_is_valid"(
                  bg."id",
                  expiry."balance_transaction_id",
                  target_account_id,
                  target_run_id
                )
            )
          )
        )
$replacement$;
  paid_conservation_anchor TEXT := $anchor$        + COALESCE((SELECT SUM(s."paid_usd")
          FROM "enterprise_credit_settlements" s
          WHERE s."billing_account_id" = target_account_id
            AND COALESCE(
              s."balance_grant_id",
              "balance_legacy_settlement_effective_grant_id"(s."id")
            ) = bg."id"), 0)
$anchor$;
  paid_conservation_replacement TEXT := $replacement$        + COALESCE((SELECT SUM(s."paid_usd")
          FROM "enterprise_credit_settlements" s
          WHERE s."billing_account_id" = target_account_id
            AND COALESCE(
              s."balance_grant_id",
              "balance_legacy_settlement_effective_grant_id"(s."id")
            ) = bg."id"), 0)
        + COALESCE((SELECT SUM(expiry."nominal_paid_usd")
          FROM "balance_grant_expiries" expiry
          WHERE expiry."billing_account_id" = target_account_id
            AND expiry."balance_grant_id" = bg."id"), 0)
$replacement$;
  bonus_conservation_anchor TEXT := $anchor$        + COALESCE((SELECT SUM(s."bonus_usd")
          FROM "enterprise_credit_settlements" s
          WHERE s."billing_account_id" = target_account_id
            AND COALESCE(
              s."balance_grant_id",
              "balance_legacy_settlement_effective_grant_id"(s."id")
            ) = bg."id"), 0)
$anchor$;
  bonus_conservation_replacement TEXT := $replacement$        + COALESCE((SELECT SUM(s."bonus_usd")
          FROM "enterprise_credit_settlements" s
          WHERE s."billing_account_id" = target_account_id
            AND COALESCE(
              s."balance_grant_id",
              "balance_legacy_settlement_effective_grant_id"(s."id")
            ) = bg."id"), 0)
        + COALESCE((SELECT SUM(expiry."nominal_bonus_usd")
          FROM "balance_grant_expiries" expiry
          WHERE expiry."billing_account_id" = target_account_id
            AND expiry."balance_grant_id" = bg."id"), 0)
$replacement$;
  blocker_anchor TEXT := $anchor$    OR expiry_count <> 0
    OR refund_count <> 0
    OR unsafe_invoice_item_count <> 0
$anchor$;
  blocker_replacement TEXT := $replacement$    OR (
      expiry_count <> 0
      AND (
        require_empty
        OR target_run_id IS NULL
        OR NOT "balance_ledger_legacy_expiry_account_is_valid"(
          target_account_id, target_run_id
        )
      )
    )
    OR refund_count <> 0
    OR (
      unsafe_invoice_item_count <> 0
      AND (
        require_empty
        OR target_run_id IS NULL
        OR NOT "balance_ledger_invoice_stability_proof_is_valid"(
          target_account_id, target_run_id
        )
      )
    )
$replacement$;
  terminal_anchor TEXT := $anchor$      OR (repair_row."after_snapshot"->>'invoiceItemCount')::BIGINT
        IS DISTINCT FROM invoice_item_count
$anchor$;
  terminal_replacement TEXT := $replacement$      OR NOT "balance_ledger_evidence_terminal_is_valid"(
        target_account_id,
        target_run_id,
        repair_row."after_snapshot"
      )
      OR (repair_row."after_snapshot"->>'invoiceItemCount')::BIGINT
        IS DISTINCT FROM invoice_item_count
$replacement$;
  match_count BIGINT;
  funding_helper_count BIGINT;
  admin_contract_present BOOLEAN;
BEGIN
  SELECT p.oid, p.prosrc INTO function_oid, function_source
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
  IF function_oid IS NULL THEN
    RAISE EXCEPTION 'canonical promotion signature/property fingerprint missing'
      USING ERRCODE = '55000';
  END IF;
  SELECT COUNT(*) INTO match_count
  FROM pg_proc p
  JOIN pg_namespace n ON n.oid = p.pronamespace
  WHERE n.nspname = 'public'
    AND p.proname = 'assert_balance_ledger_canonical_promotion'
    AND p.proargtypes = '25 25 16'::OIDVECTOR;
  funding_helper_count := (
    length(function_source) - length(replace(
      function_source, 'FROM "balance_funding_candidates"(', ''
    ))
  ) / length('FROM "balance_funding_candidates"(');
  admin_contract_present := to_regclass(
    'public.balance_ledger_admin_funding_repairs'
  ) IS NOT NULL;

  IF match_count <> 1
    OR (length(function_source) - length(replace(
      function_source, transaction_anchor, ''
    ))) / length(transaction_anchor) <> 1
    OR (length(function_source) - length(replace(
      function_source, expired_grant_anchor, ''
    ))) / length(expired_grant_anchor) <> 1
    OR (length(function_source) - length(replace(
      function_source, paid_conservation_anchor, ''
    ))) / length(paid_conservation_anchor) <> 1
    OR (length(function_source) - length(replace(
      function_source, bonus_conservation_anchor, ''
    ))) / length(bonus_conservation_anchor) <> 1
    OR (length(function_source) - length(replace(
      function_source, blocker_anchor, ''
    ))) / length(blocker_anchor) <> 1
    OR (length(function_source) - length(replace(
      function_source, terminal_anchor, ''
    ))) / length(terminal_anchor) <> 1
    OR funding_helper_count NOT IN (1, 2)
    OR position(
      'balance_migration_opening_retirement_proof_is_valid' IN function_source
    ) = 0
    OR position(
      'balance_ledger_legacy_expiry_proof_is_valid' IN function_source
    ) <> 0
    OR position(
      'balance_ledger_invoice_stability_proof_is_valid' IN function_source
    ) <> 0
    OR (
      admin_contract_present
      AND (
        position(
          'balance_admin_funding_allocation_repair_is_proven' IN function_source
        ) = 0
        OR position(
          'balance_admin_funding_terminal_evidence_is_valid' IN function_source
        ) = 0
      )
    )
  THEN
    RAISE EXCEPTION 'canonical promotion source fingerprint changed'
      USING ERRCODE = '55000';
  END IF;

  rewritten_source := replace(
    function_source, transaction_anchor, transaction_replacement
  );
  rewritten_source := replace(
    rewritten_source, expired_grant_anchor, expired_grant_replacement
  );
  rewritten_source := replace(
    rewritten_source,
    paid_conservation_anchor,
    paid_conservation_replacement
  );
  rewritten_source := replace(
    rewritten_source,
    bonus_conservation_anchor,
    bonus_conservation_replacement
  );
  rewritten_source := replace(
    rewritten_source, blocker_anchor, blocker_replacement
  );
  rewritten_source := replace(
    rewritten_source, terminal_anchor, terminal_replacement
  );

  IF (length(rewritten_source) - length(replace(
      rewritten_source,
      'balance_ledger_legacy_expiry_proof_is_valid',
      ''
    ))) / length('balance_ledger_legacy_expiry_proof_is_valid') <> 2
    OR (length(rewritten_source) - length(replace(
      rewritten_source,
      'balance_ledger_invoice_stability_proof_is_valid',
      ''
    ))) / length('balance_ledger_invoice_stability_proof_is_valid') <> 1
    OR (length(rewritten_source) - length(replace(
      rewritten_source,
      'balance_ledger_legacy_expiry_account_is_valid',
      ''
    ))) / length('balance_ledger_legacy_expiry_account_is_valid') <> 1
    OR (length(rewritten_source) - length(replace(
      rewritten_source,
      'balance_ledger_evidence_terminal_is_valid',
      ''
    ))) / length('balance_ledger_evidence_terminal_is_valid') <> 1
    OR (
      length(rewritten_source) - length(replace(
        rewritten_source, 'FROM "balance_funding_candidates"(', ''
      ))
    ) / length('FROM "balance_funding_candidates"(') <> funding_helper_count
    OR (
      admin_contract_present
      AND (
        position(
          'balance_admin_funding_allocation_repair_is_proven' IN rewritten_source
        ) = 0
        OR position(
          'balance_admin_funding_terminal_evidence_is_valid' IN rewritten_source
        ) = 0
      )
    )
  THEN
    RAISE EXCEPTION 'canonical promotion source replacement invalid'
      USING ERRCODE = '55000';
  END IF;

  EXECUTE format(
    'CREATE OR REPLACE FUNCTION public.assert_balance_ledger_canonical_promotion('
      || 'target_account_id TEXT, target_run_id TEXT, require_empty BOOLEAN) '
      || 'RETURNS VOID LANGUAGE plpgsql AS %L',
    rewritten_source
  );

  SELECT p.prosrc INTO function_source FROM pg_proc p WHERE p.oid = function_oid;
  IF (length(function_source) - length(replace(
      function_source,
      'balance_ledger_legacy_expiry_proof_is_valid',
      ''
    ))) / length('balance_ledger_legacy_expiry_proof_is_valid') <> 2
    OR (length(function_source) - length(replace(
      function_source,
      'balance_ledger_invoice_stability_proof_is_valid',
      ''
    ))) / length('balance_ledger_invoice_stability_proof_is_valid') <> 1
    OR (length(function_source) - length(replace(
      function_source,
      'balance_ledger_legacy_expiry_account_is_valid',
      ''
    ))) / length('balance_ledger_legacy_expiry_account_is_valid') <> 1
    OR (length(function_source) - length(replace(
      function_source,
      'balance_ledger_evidence_terminal_is_valid',
      ''
    ))) / length('balance_ledger_evidence_terminal_is_valid') <> 1
    OR (
      length(function_source) - length(replace(
        function_source, 'FROM "balance_funding_candidates"(', ''
      ))
    ) / length('FROM "balance_funding_candidates"(') <> funding_helper_count
    OR (
      admin_contract_present
      AND (
        position(
          'balance_admin_funding_allocation_repair_is_proven' IN function_source
        ) = 0
        OR position(
          'balance_admin_funding_terminal_evidence_is_valid' IN function_source
        ) = 0
      )
    )
  THEN
    RAISE EXCEPTION 'canonical promotion source upgrade did not verify'
      USING ERRCODE = '55000';
  END IF;
END
$upgrade_canonical_promotion$;

COMMIT;
